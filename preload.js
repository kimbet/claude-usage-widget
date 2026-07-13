// Preload — exposes a minimal, sandboxed API to the renderer. The
// renderer never touches fs/path directly; all data flows through here.
// Parser logic lives in src/parser.js (CommonJS) and is required here
// rather than in the renderer so the renderer process stays
// nodeIntegration:false.

const { contextBridge, ipcRenderer } = require('electron')
const parser = require('./src/parser.js')
const quota = require('./src/quota.js')

contextBridge.exposeInMainWorld('widget', {
  // Returns: { sessions: SessionView[], totals: {...}, scannedAt }
  scan: () => parser.scan(),
  // Returns: { series: { hoursBack, bucketMin, buckets[] }, scannedAt }
  scanSeries: (hours, bucketMin) => parser.scanSeries(hours, bucketMin),
  // Returns: { fiveHour, sevenDay, ... } OR { error, message }
  fetchQuota: () => quota.fetchQuota(),
  // Multi-account: { accounts: [{ name, quota }], fetchedAt }
  fetchAllQuota: () => quota.fetchAllQuota(),
  openContextMenu: () => ipcRenderer.send('context-menu'),
})
