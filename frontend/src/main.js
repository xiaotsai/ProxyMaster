// ========== 全局變量定義 ==========
let currentLang = 'zh-TW';
let proxyList = [];
let sourceUrls = [];
let isCheckingAll = false;
let isPaused = false;
let pausePromiseResolve = null;
let currentActiveIP = null;
let isFetching = false;

// 確保 translations 存在
if (!window.translations) {
    console.warn('translations not found, using default');
    window.translations = {
        'zh-TW': {},
        'en-US': {},
        'ru-RU': {}
    };
}

// ========== 初始化應用 ==========
async function initApplication() {
    console.log("App initializing...");
    
    try {
        // 等待 Wails 完全就緒
        if (!window.go?.main?.App) {
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (window.go?.main?.App) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
            });
        }
        
        // 顯示載入動畫
        showLoading('初始化應用', '載入設定中...');
        
        // 1. 從本地存儲加載數據
        loadProxies();
        
        // 2. 清理異常狀態
        proxyList.forEach(p => {
            if (p.status === 'checking') p.status = 'dead';
        });
        
        // 3. 加載 API 來源 (修復版)
        loadSourceUrls();
        
        // 4. 設置語言
        const savedLang = localStorage.getItem('app_lang') || 'zh-TW';
        await changeLanguage(savedLang);
        
        // 5. 更新狀態顯示
        updateDashboard(false);
        
        // 6. 監聽 Wails 事件
        setupEventListeners();
        
        // 7. 監控內存
        monitorMemory();
        
        // 8. 渲染代理表
        renderTable();
        updateStats();
        
        console.log("App initialized successfully");
        
        // 顯示歡迎訊息
        setTimeout(() => {
            showNotification('success', '歡迎', 'Proxy Master 已就緒！');
        }, 500);
    } catch (error) {
        console.error('初始化失敗:', error);
        showNotification('error', '初始化錯誤', '應用初始化失敗: ' + error.message);
    } finally {
        hideLoading();
    }
}

// ========== 視圖切換 ==========
window.switchView = function(viewName) {
    console.log("Switching to view:", viewName);
    
    // 隱藏所有視圖
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    
    // 移除所有導航項的 active 類
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // 顯示目標視圖
    const targetView = document.getElementById('view-' + viewName);
    if (targetView) {
        targetView.classList.add('active');
    }
    
    // 設置導航項為 active
    const targetNav = document.getElementById('nav-' + viewName);
    if (targetNav) {
        targetNav.classList.add('active');
    }
};

// ========== 數據加載與保存 ==========
function loadProxies() {
    const saved = localStorage.getItem('proxy_list');
    if (saved) {
        try {
            proxyList = JSON.parse(saved);
            
            // 自動重置卡住的狀態
            let fixedCount = 0;
            proxyList.forEach(p => {
                if (p.status === 'checking') {
                    p.status = 'dead'; 
                    fixedCount++;
                }
            });
            
            if (fixedCount > 0) {
                console.log(`系統自動修復了 ${fixedCount} 個卡在檢測中的節點`);
                saveProxies();
            }
        } catch (e) {
            proxyList = [];
            console.error('解析代理列表失敗:', e);
        }
    } else {
        proxyList = [];
    }
}

function saveProxies() {
    try {
        localStorage.setItem('proxy_list', JSON.stringify(proxyList));
        updateStats();
    } catch (e) {
        console.error('保存代理列表失敗:', e);
    }
}

// 加載 API 來源
function loadSourceUrls() {
    const saved = localStorage.getItem('proxy_sources');
    
    // 定義默認來源列表
    const defaults = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];

    try {
        if (saved) {
            const parsed = JSON.parse(saved);
            // 關鍵修改：如果是數組但長度為 0 (被清空過)，或者不是數組，都強制使用默認值
            if (Array.isArray(parsed) && parsed.length > 0) {
                sourceUrls = parsed;
            } else {
                console.log('來源列表為空，載入默認來源');
                sourceUrls = defaults;
                localStorage.setItem('proxy_sources', JSON.stringify(sourceUrls));
            }
        } else {
            console.log('無保存的來源，載入默認來源');
            sourceUrls = defaults;
            localStorage.setItem('proxy_sources', JSON.stringify(sourceUrls));
        }
    } catch (e) {
        console.warn('解析來源列表失敗，重置為默認值', e);
        sourceUrls = defaults;
        localStorage.setItem('proxy_sources', JSON.stringify(sourceUrls));
    }
    
    console.log('當前 API 來源:', sourceUrls);
    renderSourceList();
}

// ========== 事件監聽器設置 ==========
function setupEventListeners() {
    if (window.runtime) {
        window.runtime.EventsOn('connection_success', handleConnectionSuccess);
        window.runtime.EventsOn('connection_failed', handleConnectionFailed);
        window.runtime.EventsOn('connection_disconnected', handleConnectionDisconnected);
        window.runtime.EventsOn('proxies_fetched', handleProxiesFetched);
        window.runtime.EventsOn('proxy_ready', handleProxyReady);
        window.runtime.EventsOn('proxy_need_rotate', handleProxyRotate);
        window.runtime.EventsOn('killswitch_triggered', handleKillSwitch);
        window.runtime.EventsOn('killswitch_enabled', handleKillSwitchEnabled);
        window.runtime.EventsOn('killswitch_disabled', handleKillSwitchDisabled);
        console.log("Wails event listeners set up");
    } else {
        console.warn("Wails runtime not available, retrying in 1 second...");
        setTimeout(setupEventListeners, 1000);
    }
}

// ========== 儀表板更新 ==========
function updateDashboard(connected = false, ip = null, port = null, country = null) {
    const dash = document.getElementById('statusDashboard');
    const dashDetail = document.getElementById('dashDetail');
    const dashBtn = document.getElementById('dashActionBtn');
    const ksArea = document.getElementById('ksArea');
    const verifyBtn = document.getElementById('btnVerifyIP');
    const ksToggle = document.getElementById('ksToggle');
    const connectionPulse = document.querySelector('.connection-pulse');
    const recoverBtn = document.getElementById('btnRecoverNet');
    
    if (dash) {
        dash.classList.remove('connected', 'ks-active');
        if (connected) {
            dash.classList.add('connected');
            if (ksToggle && ksToggle.checked) {
                dash.classList.add('ks-active');
            }
        } else if (recoverBtn && recoverBtn.style.display !== 'none') {
            dash.classList.add('ks-active');
        }
    }
    
    if (connectionPulse) {
        connectionPulse.classList.remove('connected', 'disconnected');
        connectionPulse.classList.add(connected ? 'connected' : 'disconnected');
    }
    
    if (dashDetail) {
        const dict = window.translations[currentLang] || {};
        if (connected && ip && port) {
            dashDetail.innerHTML = `<span class="connection-pulse connected"></span> ${ip}:${port}`;
            if (country && country !== 'UN') {
                dashDetail.innerHTML += ` (${country})`;
            }
        } else {
            if (recoverBtn && recoverBtn.style.display !== 'none') {
                dashDetail.innerHTML = `<span class="connection-pulse disconnected"></span> ⚠️ INTERNET CUT`;
                dashDetail.style.color = 'var(--danger)';
            } else {
                dashDetail.innerHTML = `<span class="connection-pulse disconnected"></span> ${dict['dash_direct'] || '🛡️ 直連模式'}`;
                dashDetail.style.color = '';
            }
        }
    }
    
    if (dashBtn) {
        dashBtn.style.display = connected ? 'inline-block' : 'none';
    }
    
    if (ksArea) {
        const isKSTriggered = recoverBtn && recoverBtn.style.display !== 'none';
        ksArea.style.display = (connected || isKSTriggered) ? 'flex' : 'none';
    }
    
    if (verifyBtn) {
        verifyBtn.style.display = connected ? 'inline-block' : 'none';
    }
}

// ========== 代理表格渲染 ==========
function renderTable() {
    const tbody = document.getElementById('proxyTable');
    if (!tbody) return;
    
    const dict = window.translations[currentLang] || {};
    
    tbody.innerHTML = '';
    
    if (proxyList.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 40px; color: var(--text-dim);">
                    📭 暫無代理節點<br>
                    <small>請點擊上方"抓取節點"或手動添加</small>
                </td>
            </tr>
        `;
        return;
    }
    
    proxyList.forEach(proxy => {
        if (!proxy || !proxy.ip) return;
        
        const row = document.createElement('tr');
        if (currentActiveIP === proxy.ip) {
            row.classList.add('row-active-proxy');
        }
        
        const statusClass = proxy.status === 'active' ? 'status-active' : 
                           proxy.status === 'dead' ? 'status-dead' : 'status-checking';
        const statusText = proxy.status === 'active' ? dict['status_active'] || '存活' :
                          proxy.status === 'dead' ? dict['status_dead'] || '失效' : dict['status_checking'] || '檢測中';
        
        // --- 國旗顯示邏輯 ---
        const countryCode = proxy.country || 'UN';
        let flagHtml = '';
        
        if (countryCode !== 'UN' && countryCode.length === 2) {
            // 使用線上 CDN 獲取國旗
            const flagUrl = `https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png`;
            flagHtml = `<img src="${flagUrl}" alt="${countryCode}" 
                             style="width: 24px; height: 18px; vertical-align: middle; margin-right: 8px; border-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);"
                             onerror="this.style.display='none'">`;
        } else {
            flagHtml = `<span style="display:inline-block; width:24px; text-align:center; margin-right:8px; font-size:16px;">🌐</span>`;
        }
        
        row.innerHTML = `
            <td><span style="font-family: monospace;">${proxy.ip}:${proxy.port}</span></td>
            <td><span class="${statusClass}">${statusText}</span></td>
            <td>${proxy.latency || 0} ms</td>
            <td style="display: flex; align-items: center;">
                ${flagHtml}
                <span style="font-weight: 500;">${countryCode}</span>
            </td>
            <td>
                <button onclick="setGlobal('${proxy.ip}', '${proxy.port}')" 
                        class="btn-blue" 
                        style="padding: 6px 12px; font-size: 12px;">
                    ${dict['btn_connect_action'] || '連線'}
                </button>
                <button onclick="deleteProxy('${proxy.id}')" 
                        class="btn-outline" 
                        style="padding: 6px 12px; font-size: 12px; margin-left: 5px;">
                    ✕
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function updateStats() {
    const total = proxyList.length;
    const active = proxyList.filter(p => p.status === 'active').length;
    const dead = proxyList.filter(p => p.status === 'dead').length;
    const avgLatency = active > 0 ? 
        proxyList.filter(p => p.latency > 0).reduce((sum, p) => sum + p.latency, 0) / active : 0;
    
    const statTotal = document.getElementById('stat-total');
    const statActive = document.getElementById('stat-active');
    const statDead = document.getElementById('stat-dead');
    const statLatency = document.getElementById('stat-latency');
    
    if (statTotal) statTotal.textContent = total;
    if (statActive) statActive.textContent = active;
    if (statDead) statDead.textContent = dead;
    if (statLatency) statLatency.textContent = Math.round(avgLatency) + ' ms';
    
    const stats = document.getElementById('main-stats');
    if (stats) {
        const dict = window.translations[currentLang] || {};
        stats.textContent = `${dict['msg_total_proxies'] || '總代理數'}: ${total} | ${dict['msg_active_proxies'] || '存活節點'}: ${active}`;
    }
}

// ========== 通知系統 ==========
window.showNotification = function(type, titleKey, messageKey, duration = 5000, extraData = null) {
    const dict = window.translations[currentLang] || {};
    let title = dict[titleKey] || titleKey;
    let message = dict[messageKey] || messageKey;
    
    if (extraData) {
        Object.keys(extraData).forEach(key => {
            message = message.replace(`{${key}}`, extraData[key]);
        });
    }
    
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    
    notification.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 12px;">
            <div style="font-size: 24px;">${icons[type] || 'ℹ️'}</div>
            <div style="flex: 1;">
                <div style="font-weight: bold; font-size: 16px; margin-bottom: 6px;">${title}</div>
                <div style="font-size: 14px; opacity: 0.9;">${message}</div>
            </div>
            <button onclick="this.parentElement.parentElement.remove()" 
                    style="background: transparent; border: none; color: white; font-size: 18px; cursor: pointer; padding: 0; margin-left: 10px;">
                ✕
            </button>
        </div>
        <div class="notification-progress">
            <div class="notification-progress-bar" style="width: 100%; transition: width ${duration}ms linear;"></div>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
        const progress = notification.querySelector('.notification-progress-bar');
        setTimeout(() => { progress.style.width = '0%'; }, 10);
    }, 10);
    
    setTimeout(() => {
        notification.style.transform = 'translateX(120%)';
        setTimeout(() => notification.remove(), 400);
    }, duration);
};

function showLoading(title, message) {
    const overlay = document.getElementById('loadingOverlay');
    const titleEl = document.getElementById('loadingTitle');
    const messageEl = document.getElementById('loadingMessage');
    
    if (overlay) {
        if (title && titleEl) titleEl.textContent = title;
        if (message && messageEl) messageEl.textContent = message;
        overlay.style.display = 'flex';
    }
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function showProgress(visible = true) {
    const container = document.getElementById('progressContainer');
    if (container) {
        container.style.display = visible ? 'block' : 'none';
    }
}

function updateProgress(current, total, text) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const progressPercent = document.getElementById('progressPercent');
    
    if (progressBar) {
        progressBar.style.width = `${percent}%`;
    }
    if (progressText && text) progressText.textContent = text;
    if (progressPercent) progressPercent.textContent = `${percent}%`;
}

// ========== 代理操作函數 ==========
window.setGlobal = async function(ip, port) {
    const protocol = document.getElementById('protocolSelect')?.value || 'http';
    const p = proxyList.find(x => x && x.ip === ip);
    const dict = window.translations[currentLang] || {};
    
    const btn = event?.target?.closest('button');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span>' + (dict['btn_connect_action'] || 'Connecting');
    }

    showNotification('info', 'notification_connecting', `{msg_connecting_to} {ip}:{port}...`, 10000, {
        msg_connecting_to: dict['msg_connecting_to'] || 'Connecting to',
        ip: ip,
        port: port
    });

    let result = null;
    try {
        console.log(`Setting proxy: ${ip}:${port} (${protocol})`);
        showLoading('檢查節點', `正在測試 ${ip}:${port}...`);
        const check = await window.go.main.App.CheckProxy(ip, port, protocol);
        hideLoading();
        
        if (!check.success) {
            showNotification('error', 'msg_connection_failed', dict['msg_connection_failed'] || '❌ Connection failed');
            if (p) {
                p.status = 'dead';
                saveProxies();
                renderTable();
                updateStats();
            }
            return;
        }

        currentActiveIP = ip;
        showLoading('建立連線', `設定系統代理中...`);
        result = await window.go.main.App.SetSystemProxy(ip, port, protocol);
        hideLoading();
        
        if (result === "Success") {
            if (p) p.status = 'active';
            updateDashboard(true, ip, port, p ? p.country : "UN");
            
            if (document.getElementById('checkAutoKS')?.checked) {
                const ksToggle = document.getElementById('ksToggle');
                if (ksToggle) {
                    ksToggle.checked = true;
                    window.go.main.App.ToggleKillSwitch(true, ip, port, protocol);
                }
            }
            
            setTimeout(window.verifySystemProxyStatus, 3000);
            saveProxies();
            renderTable();
            updateStats();
        } else {
            throw new Error(`連線失敗: ${result}`);
        }
    } catch (err) {
        console.error('Set proxy failed:', err);
        let errorMsg = err.message;
        if (result === "precheck_failed") errorMsg = "代理預檢失敗";
        else if (result === "local_server_failed") errorMsg = "本地端口可能被佔用";
        else if (result === "system_proxy_failed") errorMsg = "系統代理設定失敗";
        
        showNotification('error', 'msg_connection_failed', errorMsg);
        
        if (p) {
            p.status = 'dead';
            saveProxies();
            renderTable();
            updateStats();
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = dict['btn_connect_action'] || 'Connect';
        }
    }
};

window.deleteProxy = function(id) {
    const proxy = proxyList.find(p => p.id === id);
    if (!proxy) return;
    
    if (proxy.ip === currentActiveIP) {
        showNotification('warning', 'msg_cannot_delete_active', window.translations[currentLang]?.['msg_cannot_delete_active'] || 'Cannot delete active proxy');
        return;
    }
    
    proxyList = proxyList.filter(p => p.id !== id);
    saveProxies();
    renderTable();
    updateStats();
    showNotification('success', 'notification_deleted', '代理已刪除');
};

window.disableGlobalProxy = async function() {
    try {
        const result = await window.go.main.App.DisableSystemProxy();
        currentActiveIP = null;
        updateDashboard(false);
        const exitIPTag = document.getElementById('exitIPTag');
        if (exitIPTag) exitIPTag.style.display = 'none';
        showNotification('success', 'notification_disconnected', '已斷開代理連線');
    } catch (err) {
        console.error('Failed to disable proxy:', err);
        showNotification('error', 'notification_disconnected', '斷開連線失敗');
    }
};

// ============================================
// 【關鍵修正】修復了 indow -> window 的拼寫錯誤
// ============================================
window.checkAllProxies = async function() {
    if (isCheckingAll) {
        showNotification('warning', 'notification_checking', '驗證已在進行中,請稍候');
        return;
    }
    
    isCheckingAll = true;
    const protocol = document.getElementById('protocolSelect')?.value || 'http';
    const skip = document.getElementById('checkSkipActive')?.checked || false;
    const autoDel = document.getElementById('checkAutoDelete')?.checked || false;
    const btnCheck = document.getElementById('btnCheck');
    const btnPause = document.getElementById('btnPause');
    const dict = window.translations[currentLang] || {};

    let cleanedCount = 0;
    proxyList.forEach(p => {
        if (p.status === 'checking') {
            p.status = 'dead';
            cleanedCount++;
        }
    });
    
    if (cleanedCount > 0) {
        console.log(`🔧 清理了 ${cleanedCount} 個卡在檢測中的節點`);
        saveProxies();
    }
    
    renderTable();

    if (btnCheck) {
        btnCheck.disabled = true;
        btnCheck.innerHTML = '<span class="loading-spinner"></span>' + (dict['btn_check'] || 'Checking...');
    }
    if (btnPause) btnPause.style.display = "inline-block";

    showNotification('info', 'notification_checking', `開始驗證 {count} 個代理節點...`, 3000, {count: proxyList.length});
    showProgress(true);

    let currentIndex = 0;
    const CONCURRENCY = 5; 
    const CHECK_TIMEOUT = 6000; 
    let activeCount = 0;
    let processedCount = 0;
    const startTime = Date.now();

    async function worker() {
        while (currentIndex < proxyList.length) {
            if (isPaused) {
                await new Promise(r => pausePromiseResolve = r);
            }
            
            const i = currentIndex++;
            if (i >= proxyList.length) break;

            const p = proxyList[i];
            
            if (!p || (skip && p.status === 'active')) {
                processedCount++;
                updateProgress(processedCount, proxyList.length, `跳過 ${p?.ip}...`);
                continue;
            }

            p.status = "checking";
            const checkStartTime = Date.now();
            updateProgress(processedCount, proxyList.length, `檢查 ${p.ip}:${p.port}...`);

            try {
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('TIMEOUT')), CHECK_TIMEOUT)
                );
                
                const checkPromise = window.go.main.App.CheckProxy(p.ip, p.port, protocol);
                const res = await Promise.race([checkPromise, timeoutPromise]);
                
                const checkDuration = Date.now() - checkStartTime;
                
                if (res && res.success) {
                    p.status = "active";
                    p.latency = res.latency || checkDuration;
                    p.country = res.country || "UN";
                    activeCount++;
                } else {
                    p.status = "dead";
                }
            } catch (err) {
                p.status = "dead";
            } finally {
                if (p.status === 'checking') p.status = 'dead';
                processedCount++;
            }
            
            if (processedCount % 20 === 0 || processedCount === proxyList.length) {
                renderTable();
                updateStats();
                saveProxies();
            }
        }
    }

    try {
        const pool = [];
        for (let i = 0; i < Math.min(CONCURRENCY, proxyList.length); i++) {
            pool.push(worker());
        }
        await Promise.all(pool);
        
        if (autoDel) {
            const beforeCount = proxyList.length;
            proxyList = proxyList.filter(x => x.status === 'active');
            if (beforeCount > proxyList.length) {
                showNotification('info', 'notification_cleaned', `已清理 ${beforeCount - proxyList.length} 個失效節點`);
            }
        }
        
        saveProxies();
        renderTable();
        updateStats();
        
        const deadCount = proxyList.length - activeCount;
        showNotification('success', 'notification_checked', `驗證完成 (存活: ${activeCount} / 失效: ${deadCount})`);
            
    } catch (error) {
        console.error('檢查流程錯誤:', error);
        showNotification('error', 'notification_fetch_failed', '檢查流程發生錯誤: ' + error.message);
    } finally {
        isCheckingAll = false;
        showProgress(false);
        if (btnCheck) {
            btnCheck.disabled = false;
            btnCheck.innerHTML = dict['btn_check'] || '⚡ Check';
        }
        if (btnPause) btnPause.style.display = "none";
        
        // 最終清理
        proxyList.forEach(p => { if (p.status === 'checking') p.status = 'dead'; });
        renderTable();
    }
};

window.fetchProxies = async () => {
    if (isFetching) {
        showNotification('warning', 'notification_fetching', '抓取已在進行中');
        return;
    }
    
    isFetching = true;
    const btn = document.getElementById('btnFetch');
    const originalText = btn?.innerHTML;
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span>抓取中...';
    }
    
    showLoading('抓取代理節點', '正在從遠端 API 獲取代理列表...');
    
    try {
        console.log('Fetching proxies from', sourceUrls.length, 'sources');
        const fetchPromise = window.go.main.App.FetchRealProxies(sourceUrls);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('抓取超時 (30秒)')), 30000)
        );
        
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (res && Array.isArray(res)) {
            const existingIPs = new Set(proxyList.map(p => `${p.ip}:${p.port}`));
            const newProxies = res.filter(p => !existingIPs.has(`${p.ip}:${p.port}`));
            const MAX_ADD_PER_FETCH = 2000;
            const limitedNewProxies = newProxies.slice(0, MAX_ADD_PER_FETCH);
            
            proxyList = [...limitedNewProxies, ...proxyList];
            saveProxies();
            renderTable();
            updateStats();
            
            showNotification('success', 'notification_fetched', 
                `新增: ${limitedNewProxies.length} / 總數: ${proxyList.length}`);
        } else {
            showNotification('error', 'notification_fetch_failed', '請檢查 API 來源是否有效');
        }
    } catch (e) {
        console.error("Fetch failed:", e);
        showNotification('error', 'notification_fetch_failed', e.message || '抓取失敗');
    } finally {
        isFetching = false;
        hideLoading();
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
};

window.addManualProxy = () => {
    const input = document.getElementById('inputProxy');
    if (!input || !input.value.includes(':')) {
        showNotification('error', 'msg_format_error', '格式錯誤，請使用 IP:PORT');
        return;
    }
    
    const parts = input.value.split(':');
    if (parts.length < 2) return;
    
    const ip = parts[0].trim();
    const port = parts[1].trim();
    
    const exists = proxyList.find(p => p.ip === ip && p.port === port);
    if (exists) {
        showNotification('warning', 'msg_proxy_exists', '此代理已存在');
        return;
    }
    
    const newProxy = {
        id: "MAN-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4),
        ip: ip,
        port: port,
        status: "new",
        latency: 0,
        country: "UN",
        source: "Manual"
    };
    
    proxyList.unshift(newProxy);
    input.value = "";
    saveProxies();
    renderTable();
    updateStats();
    showNotification('success', 'notification_added', `代理 {ip}:{port} 已添加`, 3000, {ip: ip, port: port});
};

window.importFromFile = async () => {
    try {
        const content = await window.go.main.App.OpenProxyFile();
        if (!content) return;
        
        const lines = content.split('\n');
        let count = 0;
        const existingIPs = new Set(proxyList.map(p => `${p.ip}:${p.port}`));
        
        lines.forEach((line, i) => {
            line = line.trim();
            if (!line || !line.includes(':')) return;
            const parts = line.split(':');
            if (parts.length >= 2) {
                const ip = parts[0].trim();
                const port = parts[1].trim();
                if (!existingIPs.has(`${ip}:${port}`)) {
                    proxyList.push({
                        id: `FILE-${Date.now()}-${i}`,
                        ip: ip,
                        port: port,
                        status: "new",
                        latency: 0,
                        country: "UN",
                        source: "File"
                    });
                    count++;
                }
            }
        });
        
        saveProxies();
        renderTable();
        updateStats();
        showNotification('success', 'notification_imported', `成功導入 {count} 個代理`, 3000, {count: count});
    } catch (err) {
        showNotification('error', 'notification_fetch_failed', err.message);
    }
};

window.clearDeadProxies = () => {
    const beforeCount = proxyList.length;
    proxyList = proxyList.filter(p => p.status !== 'dead');
    const removed = beforeCount - proxyList.length;
    saveProxies();
    renderTable();
    updateStats();
    showNotification('success', 'notification_cleaned', `已清理 ${removed} 個失效節點`);
};

window.togglePause = () => {
    isPaused = !isPaused;
    const btn = document.getElementById('btnPause');
    const dict = window.translations[currentLang] || {};
    if (btn) {
        btn.innerText = isPaused ? dict['btn_resume'] || '▶ 繼續' : dict['btn_pause'] || '⏸ 暫停';
        btn.className = isPaused ? "btn-green" : "btn-red";
    }
    if (!isPaused && pausePromiseResolve) {
        pausePromiseResolve();
        pausePromiseResolve = null;
    }
    showNotification('info', isPaused ? 'btn_pause' : 'btn_resume', isPaused ? '驗證已暫停' : '驗證已繼續');
};

window.cleanupOldProxies = function(maxAgeDays = 7) {
    const now = Date.now();
    const cutoffTime = now - (maxAgeDays * 24 * 60 * 60 * 1000);
    const beforeCount = proxyList.length;
    proxyList = proxyList.filter(proxy => {
        const idParts = proxy.id.split('-');
        if (idParts.length >= 2) {
            const timestamp = parseInt(idParts[1]);
            if (!isNaN(timestamp) && timestamp < cutoffTime) return false;
        }
        return true;
    });
    const removed = beforeCount - proxyList.length;
    saveProxies();
    renderTable();
    updateStats();
    showNotification('info', 'notification_cleaned', `已清理 ${removed} 個舊代理`);
};

function monitorMemory() {
    if (proxyList.length > 15000) {
        const deadCount = proxyList.filter(p => p.status === 'dead').length;
        if (deadCount > 5000) clearDeadProxies();
    }
}

window.exportProxiesToFile = async function() {
    try {
        const content = proxyList.map(p => `${p.ip}:${p.port}`).join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `proxy-list-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        showNotification('error', 'notification_fetch_failed', '導出失敗');
    }
};

window.clearAllProxies = function() {
    if (confirm('確定要清空所有代理嗎？此操作無法撤銷！')) {
        proxyList = [];
        saveProxies();
        renderTable();
        updateStats();
        showNotification('success', 'notification_cleaned', '已清空所有代理');
    }
};

window.updateLocalPort = (value) => {
    const port = parseInt(value);
    if (port < 1024 || port > 65535) {
        showNotification('error', 'msg_port_range', 'Port range: 1024-65535');
        return;
    }
    safeSetItem('local_middleware_port', value);
    window.go.main.App.SetLocalPort(value);
    showNotification('success', 'notification_port_updated', '請重啟應用生效');
};

window.handleKSToggle = (enabled) => {
    if (!currentActiveIP) {
        document.getElementById('ksToggle').checked = false;
        showNotification('warning', 'msg_please_connect', '請先連接到代理');
        return;
    }
    const protocol = document.getElementById('protocolSelect')?.value || 'http';
    const p = proxyList.find(x => x && x.ip === currentActiveIP);
    if (p) {
        window.go.main.App.ToggleKillSwitch(enabled, p.ip, p.port, protocol);
        if (enabled) showNotification('warning', 'notification_ks_enabled', 'KS 已啟用 - 斷線將自動切斷網絡');
        else showNotification('info', 'notification_ks_disabled', 'KS 已停用');
    }
};

window.verifySystemProxyStatus = async function() {
    const tag = document.getElementById('exitIPTag');
    if (!tag) return;
    tag.style.display = "block";
    tag.innerText = window.translations[currentLang]?.['status_checking'] || '檢測中...';
    tag.style.color = "var(--text-dim)";
    
    let retries = 3;
    while (retries > 0) {
        try {
            const exitIP = await window.go.main.App.GetSystemProxyExitIP();
            if (exitIP === "ERROR" || exitIP.includes("ERROR")) {
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                tag.style.color = "var(--danger)";
                tag.innerText = '代理無響應';
            } else {
                tag.style.color = "#4ec9b0";
                tag.innerText = `出口 IP: ${exitIP}`;
                break;
            }
        } catch (err) {
            retries--;
            if (retries === 0) {
                tag.style.color = "var(--danger)";
                tag.innerText = '檢測失敗';
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
};

// ========== API 來源管理 ==========
function renderSourceList() {
    const container = document.getElementById('sourceContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-dim); font-size: 13px;">暫無 API 來源 (刷新以載入默認值)</div>';
        return;
    }
    
    sourceUrls.forEach((url, index) => {
        const div = document.createElement('div');
        div.className = 'source-item';
        div.innerHTML = `
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90%; font-family: monospace;" title="${url}">${url}</span>
            <span class="delete-btn" onclick="deleteSource(${index})" style="cursor: pointer; padding: 5px; font-weight: bold;">×</span>
        `;
        container.appendChild(div);
    });
}

// 修復後的 addSource 函數
window.addSource = function() {
    const input = document.getElementById('inputSourceUrl');
    if (!input) return;

    let url = input.value.trim();
    
    if (!url) {
        showNotification('error', 'msg_url_invalid', '請輸入 API 網址');
        return;
    }
    
    // 自動補全協議
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    
    if (!Array.isArray(sourceUrls)) sourceUrls = [];
    
    if (sourceUrls.includes(url)) {
        showNotification('warning', 'msg_url_exists', '此 API 已存在');
        input.value = ''; 
        return;
    }
    
    try {
        sourceUrls.push(url);
        localStorage.setItem('proxy_sources', JSON.stringify(sourceUrls));
        
        renderSourceList();
        input.value = '';
        
        showNotification('success', 'notification_added', 'API 來源已添加');
    } catch (e) {
        console.error('添加失敗:', e);
        showNotification('error', 'error', '添加失敗: ' + e.message);
    }
};

window.deleteSource = function(index) {
    sourceUrls.splice(index, 1);
    localStorage.setItem('proxy_sources', JSON.stringify(sourceUrls));
    renderSourceList();
    showNotification('success', 'notification_deleted', 'API來源已刪除');
};

// ========== 語言切換 ==========
window.changeLanguage = async (lang) => {
    if (lang === currentLang) return;
    
    currentLang = lang;
    safeSetItem('app_lang', lang);
    const langSelect = document.getElementById('langSelect');
    if (langSelect) langSelect.value = lang;
    
    applyLanguage();
    renderTable();
    updateStats();
    renderSourceList();
    
    const langNames = { 'zh-TW': '繁體中文', 'en-US': 'English', 'ru-RU': 'Русский' };
    showNotification('success', 'notification_lang_changed', `已切換到 {lang}`, 3000, {lang: langNames[lang] || lang});
};

function applyLanguage() {
    const dict = window.translations[currentLang] || {};
    
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) el.textContent = dict[key];
    });
    
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (dict[key]) el.placeholder = dict[key];
    });
    
    const dashBtn = document.getElementById('dashActionBtn');
    if (dashBtn && dict['dash_btn_disconnect']) dashBtn.textContent = dict['dash_btn_disconnect'];
    
    const verifyBtn = document.getElementById('btnVerifyIP');
    if (verifyBtn && dict['btn_verify_ip']) verifyBtn.textContent = dict['btn_verify_ip'];
    
    const fetchBtn = document.getElementById('btnFetch');
    if (fetchBtn && dict['btn_fetch']) fetchBtn.textContent = dict['btn_fetch'];
    
    const checkBtn = document.getElementById('btnCheck');
    if (checkBtn && dict['btn_check']) checkBtn.textContent = dict['btn_check'];
}

// ========== 事件處理函數 ==========
function handleConnectionSuccess(data) {
    console.log('Connection success:', data);
    currentActiveIP = data.ip;
    updateDashboard(true, data.ip, data.port, data.country);
    showNotification('success', 'notification_connected', `連線成功到 ${data.ip}:${data.port} (${data.latency}ms)`);
}

function handleConnectionFailed(message) {
    console.log('Connection failed:', message);
    showNotification('error', 'msg_connection_failed', message);
}

function handleConnectionDisconnected() {
    console.log('Connection disconnected');
    currentActiveIP = null;
    updateDashboard(false);
    showNotification('info', 'notification_disconnected', '代理連線已斷開');
}

function handleProxiesFetched(count) {
    console.log(`Fetched ${count} proxies from Go backend`);
    loadProxies();
    renderTable();
    updateStats();
}

function handleProxyReady() {
    setTimeout(window.verifySystemProxyStatus, 1000);
}

function handleProxyRotate(ip) {
    console.log('Proxy needs rotation:', ip);
    const autoRotate = document.getElementById('checkAutoRotate')?.checked;
    if (autoRotate) {
        const next = proxyList.find(p => p.status === 'active' && p.ip !== ip);
        if (next) {
            showNotification('warning', 'notification_auto_rotated', `自動切換到 ${next.ip}:${next.port}`);
            setGlobal(next.ip, next.port);
        }
    } else {
        showNotification('warning', 'notification_auto_rotated', `代理 ${ip} 失效，請手動切換`);
    }
}

function handleKillSwitch() {
    showNotification('error', 'msg_ks_activated', '⚠️ KS 已啟動 - 已斷網');
    updateDashboard(false); 
    const ksArea = document.getElementById('ksArea');
    if (ksArea) {
        ksArea.style.display = 'flex';
        ksArea.style.borderTop = '1px solid #333';
        ksArea.style.paddingTop = '10px';
    }
    const recoverBtn = document.getElementById('btnRecoverNet');
    if (recoverBtn) {
        recoverBtn.style.display = 'inline-block';
        recoverBtn.style.animation = 'pulse 2s infinite';
    }
    const ksToggle = document.getElementById('ksToggle');
    if (ksToggle) ksToggle.checked = true;
}

window.recoverNetwork = async function() {
    try {
        showLoading('恢復網路', '正在還原系統代理設定...');
        const ksToggle = document.getElementById('ksToggle');
        if (ksToggle) ksToggle.checked = false;
        await window.go.main.App.ToggleKillSwitch(false, "", "", ""); 
        await window.go.main.App.DisableSystemProxy(); 
        document.getElementById('btnRecoverNet').style.display = 'none';
        hideLoading();
        showNotification('success', '網路已恢復', '已成功恢復直連模式');
    } catch (err) {
        hideLoading();
        showNotification('error', '恢復失敗', err.message);
    }
};

function handleKillSwitchEnabled() {
    showNotification('warning', 'notification_ks_enabled', 'Kill Switch 已啟用');
}

function handleKillSwitchDisabled() {
    showNotification('info', 'notification_ks_disabled', 'Kill Switch 已停用');
}

// ========== 工具函數 ==========
function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { console.error('LocalStorage error:', e); }
}

window.handleFilter = function() {
    const filter = document.getElementById('filterInput').value.toLowerCase();
    const rows = document.querySelectorAll('#proxyTable tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(filter) ? '' : 'none';
    });
};

window.handleSort = function(field) {
    proxyList.sort((a, b) => {
        if (field === 'latency') return (a.latency || 0) - (b.latency || 0);
        else if (field === 'country') return (a.country || '').localeCompare(b.country || '');
        return 0;
    });
    saveProxies();
    renderTable();
};

// ========== DOM 加載初始化 ==========
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM loaded, starting initialization...");
    
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.addEventListener('change', function(e) {
            changeLanguage(e.target.value);
        });
    }
    
    window.addEventListener('error', function(e) {
        console.error('Global error:', e);
        showNotification('error', '錯誤', `發生未預期錯誤: ${e.message}`);
    });
    
    window.addEventListener('unhandledrejection', function(e) {
        console.error('Unhandled promise rejection:', e.reason);
        showNotification('error', 'Promise 錯誤', e.reason?.message || '未知錯誤');
    });
    
    if (window.go && window.go.main && window.go.main.App) {
        console.log("Wails runtime detected, initializing app...");
        initApplication();
    } else {
        console.warn("Wails runtime not detected, waiting...");
        const checkInterval = setInterval(() => {
            if (window.go && window.go.main && window.go.main.App) {
                clearInterval(checkInterval);
                initApplication();
            }
        }, 500);
    }
});

// 強制清理卡住狀態
(function forceCleanStuckProxies() {
    try {
        const saved = localStorage.getItem('proxy_list');
        if (saved) {
            let list = JSON.parse(saved);
            let modified = false;
            list.forEach(p => {
                if (p.status === 'checking') {
                    p.status = 'dead';
                    modified = true;
                }
            });
            if (modified) {
                console.log('強制修復了卡住的檢測狀態');
                localStorage.setItem('proxy_list', JSON.stringify(list));
            }
        }
    } catch (e) {
        console.error('清理狀態失敗', e);
    }
})();