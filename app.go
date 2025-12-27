package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/net/proxy"
)

// Proxy 結構定義
type Proxy struct {
	ID      string `json:"id"`
	IP      string `json:"ip"`
	Port    string `json:"port"`
	Country string `json:"country"`
	Latency int64  `json:"latency"`
	Status  string `json:"status"`
	Source  string `json:"source"`
}

// 驗證結果結構
type CheckResult struct {
	Latency int64  `json:"latency"`
	Success bool   `json:"success"`
	Country string `json:"country"`
}

// App 結構
type App struct {
	ctx context.Context
	mu  sync.RWMutex

	// 代理狀態
	activeRemote *Proxy
	localServer  *http.Server
	localPort    string

	// 系統設定備份
	proxyBackup map[string]interface{}

	// Kill Switch 控制
	killSwitchOn bool
	ksCancel     context.CancelFunc
}

func NewApp() *App {
	return &App{
		localPort: "2080",
	}
}

// 啟動時備份系統代理設定
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	backup, err := BackupProxySettings()
	if err == nil && a.ctx != nil {
		wailsRuntime.LogInfo(a.ctx, "Proxy settings backed up")
	}
	a.proxyBackup = backup
}

// 關閉時還原設定並清理資源
func (a *App) cleanup() {
	_ = a.DisableSystemProxy()

	if a.proxyBackup != nil {
		_ = RestoreProxySettings(a.proxyBackup)
	}

	a.mu.Lock()
	if a.localServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.localServer.Shutdown(ctx)
		a.localServer = nil
	}
	a.mu.Unlock()
}

// ---------------- Wails 匯出給前端的函式 ----------------

// 1. 設定本地端口
func (a *App) SetLocalPort(port string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.localPort = port
	// 如果端口改變，重啟服務
	if a.localServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		defer cancel()
		a.localServer.Shutdown(ctx)
		a.localServer = nil
	}
}

// 2. 啟動系統代理 (連線)
func (a *App) SetSystemProxy(ip, port, protocol string) string {
	// 先預檢查代理是否可用
	check := a.CheckProxy(ip, port, protocol)
	if !check.Success {
		if a.ctx != nil {
			wailsRuntime.LogError(a.ctx, fmt.Sprintf("Proxy %s:%s failed pre-check", ip, port))
		}
		wailsRuntime.EventsEmit(a.ctx, "connection_failed", "代理預檢失敗，節點可能已失效")
		return "precheck_failed"
	}

	a.mu.Lock()
	a.activeRemote = &Proxy{IP: ip, Port: port, Source: protocol}
	lport := a.localPort
	a.mu.Unlock()

	// 啟動本地中轉伺服器
	err := a.StartLocalMiddleware()
	if err != nil {
		if a.ctx != nil {
			wailsRuntime.LogError(a.ctx, fmt.Sprintf("Failed to start local server: %v", err))
		}
		wailsRuntime.EventsEmit(a.ctx, "connection_failed", fmt.Sprintf("本地中轉服務啟動失敗: %v", err))
		return "local_server_failed"
	}

	// 等待伺服器啟動完成
	time.Sleep(500 * time.Millisecond)

	// 測試本地伺服器是否運行
	testURL := fmt.Sprintf("http://127.0.0.1:%s", lport)
	resp, err := http.Get(testURL)
	if err != nil {
		if a.ctx != nil {
			wailsRuntime.LogError(a.ctx, fmt.Sprintf("Local server test failed: %v", err))
		}
		wailsRuntime.EventsEmit(a.ctx, "connection_failed", "本地中轉服務未正確啟動")
		return "local_server_not_ready"
	}
	resp.Body.Close()

	// 設定系統代理
	if err := EnableSystemProxy("127.0.0.1", lport); err != nil {
		if a.ctx != nil {
			wailsRuntime.LogError(a.ctx, fmt.Sprintf("Failed to set system proxy: %v", err))
		}
		wailsRuntime.EventsEmit(a.ctx, "connection_failed", fmt.Sprintf("系統代理設定失敗: %v", err))
		return "system_proxy_failed"
	}

	if a.ctx != nil {
		wailsRuntime.LogInfo(a.ctx, fmt.Sprintf("Proxy set successfully: %s:%s via %s", ip, port, protocol))
	}

	// 發送成功事件給前端
	wailsRuntime.EventsEmit(a.ctx, "connection_success", map[string]interface{}{
		"ip":       ip,
		"port":     port,
		"protocol": protocol,
		"latency":  check.Latency,
		"country":  check.Country,
	})

	// 延遲發送代理已準備好的事件
	go func() {
		time.Sleep(1000 * time.Millisecond)
		wailsRuntime.EventsEmit(a.ctx, "proxy_ready", true)
	}()

	return "Success"
}

// 3. 關閉系統代理 (斷開)
func (a *App) DisableSystemProxy() string {
	a.mu.Lock()
	a.activeRemote = nil
	a.mu.Unlock()

	// 關閉 Kill Switch
	if a.ksCancel != nil {
		a.ksCancel()
		a.killSwitchOn = false
	}

	if err := DisableSystemProxy(); err != nil {
		if a.ctx != nil {
			wailsRuntime.LogError(a.ctx, fmt.Sprintf("Failed to disable system proxy: %v", err))
		}
	}

	// 發送斷開事件
	wailsRuntime.EventsEmit(a.ctx, "connection_disconnected", true)

	return "Disabled"
}

// 4. 驗證節點 (前端驗證按鈕使用) - 已修復國家檢測與 JSON 解析問題
// 4. 驗證節點 (已修復國家檢測與 User-Agent 問題)
func (a *App) CheckProxy(ip string, port string, protocol string) CheckResult {
	var transport *http.Transport

	// 設定連線超時
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}

	// 根據協議建構 Transport
	if strings.ToLower(protocol) == "socks5" {
		s5Dialer, err := proxy.SOCKS5("tcp", fmt.Sprintf("%s:%s", ip, port), nil, proxy.Direct)
		if err != nil {
			return CheckResult{0, false, ""}
		}
		transport = &http.Transport{
			Dial:              s5Dialer.Dial,
			DisableKeepAlives: true,
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
		}
	} else {
		pUrl, err := url.Parse(fmt.Sprintf("http://%s:%s", ip, port))
		if err != nil {
			return CheckResult{0, false, ""}
		}
		transport = &http.Transport{
			Proxy:             http.ProxyURL(pUrl),
			DialContext:       dialer.DialContext,
			DisableKeepAlives: true,
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
		}
	}

	// 建立一個走代理的 Client
	client := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	start := time.Now()

	// 定義通用的 User-Agent，避免被 API 視為機器人攔截
	userAgent := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	// --- 策略 A: 直接請求 ip-api.com (HTTP) ---
	// 優點: 一次請求同時獲得 IP 和國家，速度最快
	// 缺點: 不支援 HTTPS，部分嚴格的 Proxy 可能攔截 HTTP
	req, _ := http.NewRequest("GET", "http://ip-api.com/json/?fields=status,countryCode,query", nil)
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)

	// 如果策略 A 成功
	if err == nil {
		defer resp.Body.Close()
		// 檢查狀態碼，有些代理會返回 403 或 407
		if resp.StatusCode == 200 {
			var geoData struct {
				Status      string `json:"status"`
				CountryCode string `json:"countryCode"`
			}
			// 嘗試解析 JSON
			if json.NewDecoder(resp.Body).Decode(&geoData) == nil {
				// 只有當 status 為 success 時才視為成功
				if geoData.Status == "success" || geoData.CountryCode != "" {
					return CheckResult{
						Latency: time.Since(start).Milliseconds(),
						Success: true,
						Country: geoData.CountryCode,
					}
				}
			}
		}
	}

	// --- 策略 B: 備用方案 (HTTPS) ---
	// 如果 ip-api 失敗 (可能被牆或不支援 HTTP)，嘗試 api.ipify.org (HTTPS)
	// 這種情況下我們只能確認代理存活，但無法獲得國家 (顯示 UN)
	reqBackup, _ := http.NewRequest("GET", "https://api.ipify.org?format=json", nil)
	reqBackup.Header.Set("User-Agent", userAgent)

	respBackup, errBackup := client.Do(reqBackup)
	if errBackup == nil {
		defer respBackup.Body.Close()
		if respBackup.StatusCode == 200 {
			// 既然連線成功了，雖然沒抓到國家，但也算存活
			return CheckResult{
				Latency: time.Since(start).Milliseconds(),
				Success: true,
				Country: "UN", // 標記為未知但存活
			}
		}
	}

	// 如果兩種策略都失敗
	if a.ctx != nil {
		wailsRuntime.LogDebug(a.ctx, fmt.Sprintf("Proxy check failed for %s:%s", ip, port))
	}
	return CheckResult{0, false, ""}
}

// 5. 抓取線上代理 (抓取按鈕使用)
func (a *App) FetchRealProxies(urls []string) []Proxy {
	const MAX_PROXIES_PER_SOURCE = 1000 // 每個來源最多抓取1000個
	const MAX_TOTAL_PROXIES = 5000      // 總共最多抓取5000個

	allResult := make([]Proxy, 0)
	var wg sync.WaitGroup
	var mu sync.Mutex
	semaphore := make(chan struct{}, 3) // 限制並發數

	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        10,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     30 * time.Second,
		},
	}

	for _, u := range urls {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()

			// 限制並發
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			// 檢查是否已達到最大數量
			mu.Lock()
			if len(allResult) >= MAX_TOTAL_PROXIES {
				mu.Unlock()
				return
			}
			mu.Unlock()

			resp, err := client.Get(target)
			if err != nil {
				if a.ctx != nil {
					wailsRuntime.LogDebug(a.ctx, fmt.Sprintf("Failed to fetch from %s: %v", target, err))
				}
				return
			}
			defer resp.Body.Close()

			// 限制讀取大小，防止過大的響應
			bodyReader := io.LimitReader(resp.Body, 1024*1024) // 限制1MB
			b, _ := io.ReadAll(bodyReader)

			lines := strings.Split(string(b), "\n")
			var temp []Proxy

			for i, line := range lines {
				// 如果當前來源已經達到最大數量，停止處理
				if len(temp) >= MAX_PROXIES_PER_SOURCE {
					break
				}

				line = strings.TrimSpace(line)
				if line == "" || !strings.Contains(line, ":") {
					continue
				}

				parts := strings.Split(line, ":")
				if len(parts) >= 2 {
					ip := strings.TrimSpace(parts[0])
					port := strings.TrimSpace(parts[1])

					// 驗證IP和端口格式
					if net.ParseIP(ip) == nil {
						continue
					}
					if _, err := strconv.Atoi(port); err != nil {
						continue
					}

					temp = append(temp, Proxy{
						ID:      fmt.Sprintf("API-%d-%d", time.Now().UnixNano()%10000, i),
						IP:      ip,
						Port:    port,
						Country: "UN",
						Status:  "new",
						Source:  "API",
					})
				}
			}

			mu.Lock()
			// 再次檢查總數限制
			remaining := MAX_TOTAL_PROXIES - len(allResult)
			if remaining > 0 {
				if len(temp) > remaining {
					allResult = append(allResult, temp[:remaining]...)
				} else {
					allResult = append(allResult, temp...)
				}
			}
			mu.Unlock()

			if a.ctx != nil {
				wailsRuntime.LogInfo(a.ctx, fmt.Sprintf("Fetched %d proxies from %s", len(temp), target))
			}
		}(u)
	}

	wg.Wait()

	// 去重
	uniqueProxies := removeDuplicateProxies(allResult)

	if a.ctx != nil {
		wailsRuntime.LogInfo(a.ctx, fmt.Sprintf("Total fetched unique proxies: %d", len(uniqueProxies)))
	}

	// 發送抓取完成事件
	wailsRuntime.EventsEmit(a.ctx, "proxies_fetched", len(uniqueProxies))

	return uniqueProxies
}

// 去重函數
func removeDuplicateProxies(proxies []Proxy) []Proxy {
	seen := make(map[string]bool)
	unique := make([]Proxy, 0, len(proxies))

	for _, proxy := range proxies {
		key := proxy.IP + ":" + proxy.Port
		if !seen[key] {
			seen[key] = true
			unique = append(unique, proxy)
		}
	}

	return unique
}

// 6. 檢測出口 IP (檢測按鈕使用)
func (a *App) GetSystemProxyExitIP() string {
	a.mu.Lock()
	port := a.localPort
	a.mu.Unlock()

	// 檢查本地伺服器是否運行
	if a.localServer == nil {
		return "ERROR: Local server not running"
	}

	// 強制透過本地中轉端口發送請求
	proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%s", port))
	client := &http.Client{
		Transport: &http.Transport{
			Proxy:       http.ProxyURL(proxyURL),
			DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
		},
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get("http://api.ipify.org")
	if err != nil {
		if a.ctx != nil {
			wailsRuntime.LogDebug(a.ctx, fmt.Sprintf("Failed to get exit IP: %v", err))
		}
		return "ERROR"
	}
	defer resp.Body.Close()
	ip, _ := io.ReadAll(resp.Body)
	return string(ip)
}

// 7. Kill Switch 開關
func (a *App) ToggleKillSwitch(enabled bool, ip string, port string, protocol string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// 如果狀態沒變化，直接返回
	if a.killSwitchOn == enabled {
		return
	}

	a.killSwitchOn = enabled

	// 如果關閉，取消之前的 Context
	if !enabled {
		if a.ksCancel != nil {
			a.ksCancel()
			a.ksCancel = nil
		}
		wailsRuntime.EventsEmit(a.ctx, "killswitch_disabled", true)
		return
	}

	// 啟動監控
	ctx, cancel := context.WithCancel(context.Background())
	a.ksCancel = cancel

	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// 定期檢查連線
				res := a.CheckProxy(ip, port, protocol)
				if !res.Success {
					// 失敗則切斷網路 (將代理設為無效地址)
					EnableSystemProxy("127.0.0.1", "1")
					wailsRuntime.EventsEmit(a.ctx, "killswitch_triggered", true)
					if a.ctx != nil {
						wailsRuntime.LogWarning(a.ctx, "Kill Switch triggered - connection lost")
					}
					return
				}
			}
		}
	}()

	wailsRuntime.EventsEmit(a.ctx, "killswitch_enabled", true)
}

// 8. 匯入檔案
func (a *App) OpenProxyFile() string {
	f, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Open Proxy List (TXT)",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Text Files", Pattern: "*.txt"},
		},
	})
	if err != nil || f == "" {
		return ""
	}
	c, _ := os.ReadFile(f)
	return string(c)
}

// ---------------- 本地中轉伺服器 (Middleware) ----------------

func (a *App) StartLocalMiddleware() error {
	a.mu.Lock()
	if a.localServer != nil {
		a.mu.Unlock()
		return nil // 已經啟動
	}
	port := a.localPort
	a.mu.Unlock()

	// 檢查端口是否可用
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return fmt.Errorf("port %s is already in use: %v", port, err)
	}
	listener.Close()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wailsRuntime.LogInfo(a.ctx, fmt.Sprintf("收到請求: %s %s", r.Method, r.URL.String()))
		a.mu.RLock()
		remote := a.activeRemote
		a.mu.RUnlock()

		if remote == nil {
			http.Error(w, "No active proxy", http.StatusServiceUnavailable)
			return
		}

		// HTTPS Tunnel (CONNECT 方法)
		if r.Method == http.MethodConnect {
			a.handleConnect(w, r, remote)
			return
		}

		// 一般 HTTP 請求重組
		target := *r.URL
		if target.Scheme == "" {
			target.Scheme = "http"
		}
		if target.Host == "" {
			target.Host = r.Host
		}

		req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
		if err != nil {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}

		req.Header = cloneHeader(r.Header)
		removeHopByHopHeaders(req.Header)

		client := &http.Client{
			Transport: buildTransport(remote),
			Timeout:   30 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		resp, err := client.Do(req)
		if err != nil {
			// 通知前端節點可能失效，觸發自動換線
			wailsRuntime.EventsEmit(a.ctx, "proxy_need_rotate", remote.IP)
			http.Error(w, "Proxy failed", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		for k, v := range resp.Header {
			for _, vv := range v {
				w.Header().Add(k, vv)
			}
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	a.localServer = &http.Server{
		Addr:    "127.0.0.1:" + port,
		Handler: handler,
	}

	go func() {
		if a.ctx != nil {
			wailsRuntime.LogInfo(a.ctx, fmt.Sprintf("Starting local middleware on port %s", port))
		}
		if err := a.localServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			if a.ctx != nil {
				wailsRuntime.LogError(a.ctx, fmt.Sprintf("Local server error: %v", err))
			}
		}
	}()

	return nil
}

// 處理 HTTPS CONNECT
func (a *App) handleConnect(w http.ResponseWriter, r *http.Request, p *Proxy) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijack not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()

	var upstream net.Conn
	remoteAddr := fmt.Sprintf("%s:%s", p.IP, p.Port)

	// 根據協定建立連線
	if strings.ToLower(p.Source) == "socks5" {
		dialer, err := proxy.SOCKS5("tcp", remoteAddr, nil, proxy.Direct)
		if err != nil {
			wailsRuntime.EventsEmit(a.ctx, "proxy_need_rotate", p.IP)
			return
		}
		upstream, err = dialer.Dial("tcp", r.Host)
	} else {
		upstream, err = net.DialTimeout("tcp", remoteAddr, 20*time.Second)
		if err == nil {
			// HTTP 代理需要發送 CONNECT 請求
			fmt.Fprintf(upstream, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", r.Host, r.Host)
			br := bufio.NewReader(upstream)
			// 讀取回應
			resp, _ := br.ReadString('\n')
			if !strings.Contains(resp, "200") {
				upstream.Close()
				err = fmt.Errorf("proxy refused CONNECT")
			}
		}
	}

	if err != nil {
		wailsRuntime.EventsEmit(a.ctx, "proxy_need_rotate", p.IP)
		clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer upstream.Close()

	// 回應瀏覽器連線建立成功
	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// 雙向轉發數據
	done := make(chan bool, 2)

	go func() {
		io.Copy(upstream, clientConn)
		done <- true
	}()

	go func() {
		io.Copy(clientConn, upstream)
		done <- true
	}()

	// 等待任一方向完成
	<-done
}

// ---------------- 輔助函式 ----------------

func buildTransport(p *Proxy) *http.Transport {
	if strings.ToLower(p.Source) == "socks5" {
		dialer, _ := proxy.SOCKS5("tcp", fmt.Sprintf("%s:%s", p.IP, p.Port), nil, proxy.Direct)
		return &http.Transport{
			Dial:            dialer.Dial,
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}
	}
	u, _ := url.Parse(fmt.Sprintf("http://%s:%s", p.IP, p.Port))
	return &http.Transport{
		Proxy:           http.ProxyURL(u),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
}

func cloneHeader(h http.Header) http.Header {
	out := make(http.Header)
	for k, v := range h {
		cp := make([]string, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

func removeHopByHopHeaders(h http.Header) {
	for _, k := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive",
		"Transfer-Encoding", "Upgrade",
	} {
		h.Del(k)
	}
}

// ---------------- 系統代理設定函式 ----------------

// EnableSystemProxy 啟用系統代理 (Windows & Linux)
func EnableSystemProxy(host, port string) error {
	osType := runtime.GOOS
	switch osType {
	case "windows":
		return enableWindowsProxy(host, port)
	case "linux":
		return enableLinuxProxy(host, port)
	default:
		return fmt.Errorf("unsupported operating system: %s", osType)
	}
}

// DisableSystemProxy 關閉系統代理 (Windows & Linux)
func DisableSystemProxy() error {
	osType := runtime.GOOS
	switch osType {
	case "windows":
		return disableWindowsProxy()
	case "linux":
		return disableLinuxProxy()
	default:
		return fmt.Errorf("unsupported operating system: %s", osType)
	}
}

// BackupProxySettings 備份系統代理設定
func BackupProxySettings() (map[string]interface{}, error) {
	osType := runtime.GOOS
	switch osType {
	case "windows":
		return backupWindowsProxySettings()
	case "linux":
		return backupLinuxProxySettings()
	default:
		return make(map[string]interface{}), nil
	}
}

// RestoreProxySettings 還原系統代理設定
func RestoreProxySettings(backup map[string]interface{}) error {
	osType := runtime.GOOS
	switch osType {
	case "windows":
		return restoreWindowsProxySettings(backup)
	case "linux":
		return restoreLinuxProxySettings(backup)
	default:
		return nil
	}
}

// ----------------- Windows 實現 -----------------

func enableWindowsProxy(host, port string) error {
	// 設定代理啟用
	cmd := exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f")
	cmd.Run()

	// 設定代理服務器
	cmd = exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyServer", "/t", "REG_SZ", "/d", fmt.Sprintf("%s:%s", host, port), "/f")
	cmd.Run()

	// 設定本地地址繞過代理
	cmd = exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyOverride", "/t", "REG_SZ", "/d", "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*", "/f")
	cmd.Run()

	// 通知系統代理設定已變更
	cmd = exec.Command("powershell", "-Command",
		`$signature = @"
        [DllImport("wininet.dll")] 
        public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength); 
        "@
        $type = Add-Type -MemberDefinition $signature -Name Wininet -Namespace Pinvoke -PassThru
        $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
        $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null`)
	cmd.Run()

	return nil
}

func disableWindowsProxy() error {
	// 停用代理
	cmd := exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f")
	cmd.Run()

	// 通知系統代理設定已變更
	cmd = exec.Command("powershell", "-Command",
		`$signature = @"
        [DllImport("wininet.dll")] 
        public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength); 
        "@
        $type = Add-Type -MemberDefinition $signature -Name Wininet -Namespace Pinvoke -PassThru
        $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
        $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null`)
	cmd.Run()

	return nil
}

func backupWindowsProxySettings() (map[string]interface{}, error) {
	backup := make(map[string]interface{})

	// 備份 ProxyEnable
	cmd := exec.Command("reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyEnable")
	output, err := cmd.CombinedOutput()
	if err == nil {
		// 解析輸出
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		if len(lines) >= 2 {
			for _, line := range lines {
				if strings.Contains(line, "ProxyEnable") {
					parts := strings.Fields(line)
					if len(parts) >= 3 {
						backup["ProxyEnable"] = parts[2]
						break
					}
				}
			}
		}
	}

	// 備份 ProxyServer
	cmd = exec.Command("reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"/v", "ProxyServer")
	output, err = cmd.CombinedOutput()
	if err == nil {
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		if len(lines) >= 2 {
			for _, line := range lines {
				if strings.Contains(line, "ProxyServer") {
					parts := strings.Fields(line)
					if len(parts) >= 3 {
						backup["ProxyServer"] = parts[2]
						break
					}
				}
			}
		}
	}

	return backup, nil
}

func restoreWindowsProxySettings(backup map[string]interface{}) error {
	// 檢查是否有備份
	if len(backup) == 0 {
		return nil
	}

	// 還原 ProxyEnable
	if value, ok := backup["ProxyEnable"]; ok {
		if strVal, ok := value.(string); ok && strVal != "" {
			cmd := exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
				"/v", "ProxyEnable", "/t", "REG_DWORD", "/d", strVal, "/f")
			cmd.Run()
		}
	}

	// 還原 ProxyServer
	if value, ok := backup["ProxyServer"]; ok {
		if strVal, ok := value.(string); ok && strVal != "" {
			cmd := exec.Command("reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
				"/v", "ProxyServer", "/t", "REG_SZ", "/d", strVal, "/f")
			cmd.Run()
		}
	}

	// 通知系統代理設定已變更
	cmd := exec.Command("powershell", "-Command",
		`$signature = @"
        [DllImport("wininet.dll")] 
        public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength); 
        "@
        $type = Add-Type -MemberDefinition $signature -Name Wininet -Namespace Pinvoke -PassThru
        $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
        $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null`)
	cmd.Run()

	return nil
}

// ----------------- Linux 實現 -----------------

func enableLinuxProxy(host, port string) error {
	// 嘗試檢測桌面環境
	desktop := os.Getenv("XDG_CURRENT_DESKTOP")

	if strings.Contains(strings.ToLower(desktop), "gnome") ||
		strings.Contains(strings.ToLower(desktop), "ubuntu") ||
		strings.Contains(strings.ToLower(desktop), "unity") {
		// GNOME/Unity 桌面環境
		return enableGnomeProxy(host, port)
	} else if strings.Contains(strings.ToLower(desktop), "kde") {
		// KDE 桌面環境
		return enableKDEProxy(host, port)
	} else {
		// 嘗試 GNOME 作為預設
		return enableGnomeProxy(host, port)
	}
}

func disableLinuxProxy() error {
	desktop := os.Getenv("XDG_CURRENT_DESKTOP")

	if strings.Contains(strings.ToLower(desktop), "gnome") ||
		strings.Contains(strings.ToLower(desktop), "ubuntu") ||
		strings.Contains(strings.ToLower(desktop), "unity") {
		return disableGnomeProxy()
	} else if strings.Contains(strings.ToLower(desktop), "kde") {
		return disableKDEProxy()
	} else {
		return disableGnomeProxy()
	}
}

func backupLinuxProxySettings() (map[string]interface{}, error) {
	backup := make(map[string]interface{})

	desktop := os.Getenv("XDG_CURRENT_DESKTOP")
	if strings.Contains(strings.ToLower(desktop), "gnome") ||
		strings.Contains(strings.ToLower(desktop), "ubuntu") ||
		strings.Contains(strings.ToLower(desktop), "unity") {
		// 備份 GNOME 設定
		cmd := exec.Command("gsettings", "get", "org.gnome.system.proxy", "mode")
		output, err := cmd.Output()
		if err == nil {
			backup["gnome_proxy_mode"] = strings.TrimSpace(string(output))
		}

		cmd = exec.Command("gsettings", "get", "org.gnome.system.proxy.http", "host")
		output, err = cmd.Output()
		if err == nil {
			backup["gnome_http_host"] = strings.TrimSpace(string(output))
		}

		cmd = exec.Command("gsettings", "get", "org.gnome.system.proxy.http", "port")
		output, err = cmd.Output()
		if err == nil {
			backup["gnome_http_port"] = strings.TrimSpace(string(output))
		}
	}

	return backup, nil
}

func restoreLinuxProxySettings(backup map[string]interface{}) error {
	desktop := os.Getenv("XDG_CURRENT_DESKTOP")

	if strings.Contains(strings.ToLower(desktop), "gnome") ||
		strings.Contains(strings.ToLower(desktop), "ubuntu") ||
		strings.Contains(strings.ToLower(desktop), "unity") {
		// 還原 GNOME 設定
		if mode, ok := backup["gnome_proxy_mode"].(string); ok && mode != "" {
			cmd := exec.Command("gsettings", "set", "org.gnome.system.proxy", "mode", strings.Trim(mode, "'\""))
			cmd.Run()
		}

		if host, ok := backup["gnome_http_host"].(string); ok && host != "" {
			cmd := exec.Command("gsettings", "set", "org.gnome.system.proxy.http", "host", strings.Trim(host, "'\""))
			cmd.Run()
		}

		if port, ok := backup["gnome_http_port"].(string); ok && port != "" {
			cmd := exec.Command("gsettings", "set", "org.gnome.system.proxy.http", "port", strings.Trim(port, "'\""))
			cmd.Run()
		}
	}

	return nil
}

func enableGnomeProxy(host, port string) error {
	// 設定為手動代理模式
	cmd := exec.Command("gsettings", "set", "org.gnome.system.proxy", "mode", "manual")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to set GNOME proxy mode: %v, output: %s", err, string(output))
	}

	// 設定 HTTP 代理
	cmd = exec.Command("gsettings", "set", "org.gnome.system.proxy.http", "host", host)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to set HTTP proxy host: %v, output: %s", err, string(output))
	}

	cmd = exec.Command("gsettings", "set", "org.gnome.system.proxy.http", "port", port)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to set HTTP proxy port: %v, output: %s", err, string(output))
	}

	// 設定 HTTPS 代理 (使用相同的主機和端口)
	cmd = exec.Command("gsettings", "set", "org.gnome.system.proxy.https", "host", host)
	cmd.Run()

	cmd = exec.Command("gsettings", "set", "org.gnome.system.proxy.https", "port", port)
	cmd.Run()

	// 設定忽略的域名 (本地地址)
	cmd = exec.Command("gsettings", "set", "org.gnome.system.proxy", "ignore-hosts", "['localhost', '127.0.0.0/8', '::1']")
	cmd.Run()

	return nil
}

func disableGnomeProxy() error {
	// 設定為無代理模式
	cmd := exec.Command("gsettings", "set", "org.gnome.system.proxy", "mode", "none")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to disable GNOME proxy: %v, output: %s", err, string(output))
	}

	return nil
}

func enableKDEProxy(host, port string) error {
	// 設定 KDE 代理 (kioslaverc 檔案)
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	kioslavercPath := homeDir + "/.config/kioslaverc"

	// 讀取現有設定
	content := ""
	if _, err := os.Stat(kioslavercPath); err == nil {
		data, err := os.ReadFile(kioslavercPath)
		if err == nil {
			content = string(data)
		}
	}

	// 更新代理設定
	lines := strings.Split(content, "\n")
	var newLines []string
	inProxySection := false
	proxySectionAdded := false

	for _, line := range lines {
		if strings.Contains(line, "[Proxy Settings]") {
			inProxySection = true
			newLines = append(newLines, line)
			proxySectionAdded = true
			continue
		}

		if inProxySection && strings.HasPrefix(line, "[") {
			inProxySection = false
		}

		if inProxySection {
			// 跳過現有的代理設定
			if strings.HasPrefix(strings.TrimSpace(line), "ProxyType") ||
				strings.HasPrefix(strings.TrimSpace(line), "httpProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "httpsProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "ftpProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "socksProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "NoProxyFor") {
				continue
			}
		}

		newLines = append(newLines, line)
	}

	// 如果沒有代理設定部分，添加
	if !proxySectionAdded {
		newLines = append(newLines, "[Proxy Settings]")
	}

	newLines = append(newLines, "ProxyType=1")
	newLines = append(newLines, fmt.Sprintf("httpProxy=http://%s:%s", host, port))
	newLines = append(newLines, fmt.Sprintf("httpsProxy=http://%s:%s", host, port))
	newLines = append(newLines, fmt.Sprintf("ftpProxy=http://%s:%s", host, port))
	newLines = append(newLines, fmt.Sprintf("socksProxy=http://%s:%s", host, port))
	newLines = append(newLines, "NoProxyFor=localhost,127.0.0.1")

	// 寫回檔案
	newContent := strings.Join(newLines, "\n")
	err = os.WriteFile(kioslavercPath, []byte(newContent), 0644)
	if err != nil {
		return fmt.Errorf("failed to write KDE proxy settings: %v", err)
	}

	// 嘗試通過 dbus 重新載入設定
	cmd := exec.Command("dbus-send", "--type=signal", "/KIO/Scheduler", "org.kde.KIO.Scheduler.reparseSlaveConfiguration", "string:''")
	cmd.Run()

	return nil
}

func disableKDEProxy() error {
	// 讀取並修改 kioslaverc 檔案
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	kioslavercPath := homeDir + "/.config/kioslaverc"

	if _, err := os.Stat(kioslavercPath); os.IsNotExist(err) {
		return nil // 檔案不存在，無需處理
	}

	data, err := os.ReadFile(kioslavercPath)
	if err != nil {
		return err
	}

	content := string(data)
	lines := strings.Split(content, "\n")
	var newLines []string
	inProxySection := false

	for _, line := range lines {
		if strings.Contains(line, "[Proxy Settings]") {
			inProxySection = true
			newLines = append(newLines, line)
			continue
		}

		if inProxySection && strings.HasPrefix(line, "[") {
			inProxySection = false
		}

		if inProxySection {
			// 修改 ProxyType 為 0 (無代理)
			if strings.HasPrefix(strings.TrimSpace(line), "ProxyType") {
				newLines = append(newLines, "ProxyType=0")
				continue
			}
			// 跳過其他代理設定
			if strings.HasPrefix(strings.TrimSpace(line), "httpProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "httpsProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "ftpProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "socksProxy") ||
				strings.HasPrefix(strings.TrimSpace(line), "NoProxyFor") {
				continue
			}
		}

		newLines = append(newLines, line)
	}

	// 寫回檔案
	newContent := strings.Join(newLines, "\n")
	err = os.WriteFile(kioslavercPath, []byte(newContent), 0644)
	if err != nil {
		return fmt.Errorf("failed to disable KDE proxy: %v", err)
	}

	// 嘗試通過 dbus 重新載入設定
	cmd := exec.Command("dbus-send", "--type=signal", "/KIO/Scheduler", "org.kde.KIO.Scheduler.reparseSlaveConfiguration", "string:''")
	cmd.Run()

	return nil
}
