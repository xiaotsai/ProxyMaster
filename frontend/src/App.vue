<script setup>
import { ref } from 'vue'
// 引用 Go 後端的兩個函式
import { FetchRealProxies, CheckProxy } from '../wailsjs/go/main/App'

const proxyList = ref([])
const statusMessage = ref("系統就緒，等待指令...")
const isScanning = ref(false)

// 功能 1: 收割代理
async function startHarvest() {
  if (isScanning.value) return
  statusMessage.value = "正在從互聯網收割代理..."
  
  try {
    proxyList.value = await FetchRealProxies()
    statusMessage.value = `收割完成，共獲取 ${proxyList.value.length} 個代理。請執行驗證。`
  } catch (e) {
    statusMessage.value = "發生錯誤: " + e
  }
}

// 功能 2: 批量驗證
async function verifyAll() {
  if (proxyList.value.length === 0) {
    statusMessage.value = "錯誤：代理池為空，請先執行收割。"
    return
  }

  isScanning.value = true
  statusMessage.value = "正在啟動併發驗證引擎..."

  // 為了視覺效果，我們這裡用迴圈一個個驗證
  // 實戰中通常會用 Promise.all 分批處理
  let activeCount = 0
  
  for (let i = 0; i < proxyList.value.length; i++) {
    const p = proxyList.value[i]
    p.status = "checking" // 更新 UI 狀態為檢查中
    
    // 呼叫 Go 後端進行真實連線測試
    const result = await CheckProxy(p.ip, p.port)
    // result[0] = latency, result[1] = success (bool)

    if (result[1] === true) {
      p.latency = result[0]
      p.status = "active"
      activeCount++
    } else {
      p.latency = -1
      p.status = "dead"
    }
  }

  isScanning.value = false
  statusMessage.value = `掃描結束。存活節點: ${activeCount} / ${proxyList.value.length}`
}
</script>

<template>
  <div class="container">
    <div class="header">
      <h1>🕷️ ProxyStation <span style="font-size:12px; color:#666">v1.0</span></h1>
    </div>
    
    <div class="control-panel">
      <button class="btn harvest" @click="startHarvest" :disabled="isScanning">
        🚀 一鍵收割
      </button>
      <button class="btn verify" @click="verifyAll" :disabled="isScanning">
        ⚡ 驗證存活
      </button>
      <span class="status-text">[{{ statusMessage }}]</span>
    </div>

    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th style="width: 50px">ID</th>
            <th>IP Address</th>
            <th>Port</th>
            <th>Source</th>
            <th>Status</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in proxyList" :key="p.id">
            <td>{{ p.id }}</td>
            <td style="font-family: monospace; color: #fff">{{ p.ip }}</td>
            <td>{{ p.port }}</td>
            <td>{{ p.source }}</td>
            <td>
              <span :class="['tag', p.status]">{{ p.status }}</span>
            </td>
            <td>
              <span v-if="p.status === 'active'" style="color: #00ff9d; font-weight:bold">
                {{ p.latency }} ms
              </span>
              <span v-else style="color: #444">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style>
/* 全局黑色主題 */
body {
  background-color: #121212;
  color: #e0e0e0;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  margin: 0;
  overflow: hidden; /* 防止雙滾動條 */
}

.container {
  padding: 20px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

h1 {
  margin: 0 0 20px 0;
  color: #00ff9d;
  text-transform: uppercase;
  letter-spacing: 2px;
  border-bottom: 2px solid #333;
  padding-bottom: 10px;
}

.control-panel {
  display: flex;
  gap: 15px;
  margin-bottom: 20px;
  align-items: center;
  background: #1e1e1e;
  padding: 15px;
  border-radius: 8px;
  border: 1px solid #333;
}

.status-text {
  margin-left: auto;
  color: #888;
  font-family: monospace;
}

/* 按鈕樣式 */
.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  font-size: 14px;
  transition: all 0.2s;
  color: #000;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.harvest {
  background-color: #007acc;
  color: white;
}
.btn.harvest:hover:not(:disabled) {
  background-color: #0098ff;
}

.btn.verify {
  background-color: #ff9d00;
  color: black;
}
.btn.verify:hover:not(:disabled) {
  background-color: #ffb700;
}

/* 表格樣式 */
.table-wrapper {
  flex: 1;
  overflow-y: auto;
  border: 1px solid #333;
  border-radius: 4px;
  background: #1e1e1e;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  position: sticky;
  top: 0;
  background: #252526;
  color: #888;
  text-align: left;
  padding: 12px;
  font-size: 12px;
  text-transform: uppercase;
  border-bottom: 2px solid #000;
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a2a;
  font-size: 14px;
  color: #aaa;
}

tr:hover {
  background-color: #2a2a2a;
}

/* 狀態標籤 */
.tag {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
}
.tag.new { background: #333; color: #fff; }
.tag.checking { background: #555; color: #fff; animation: pulse 1s infinite; }
.tag.active { background: rgba(0, 255, 157, 0.2); color: #00ff9d; border: 1px solid #00ff9d; }
.tag.dead { background: rgba(255, 0, 0, 0.1); color: #ff4444; }

@keyframes pulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}
</style>