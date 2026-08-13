// Preload — exposes a minimal, sandboxed API to the renderer. The
// renderer never touches fs/path directly; all data flows through here.
// Parser/quota logic lives in src/ (CommonJS) and is required here
// rather than in the renderer so the renderer process stays
// nodeIntegration:false.

const { contextBridge, ipcRenderer } = require('electron')
const parser = require('./src/parser.js')
const quota = require('./src/quota.js')

contextBridge.exposeInMainWorld('widget', {
  // Today's "new work" sums — { totals: { tokens, messages }, scannedAt }
  todayTotals: () => ({ totals: parser.todayTotals(), scannedAt: Date.now() }),
  // Returns: { series: { hoursBack, bucketMin, buckets[] }, scannedAt }
  scanSeries: (hours, bucketMin) => parser.scanSeries(hours, bucketMin),
  // Multi-account quota: { accounts: [{ name, quota }], fetchedAt }
  fetchAllQuota: () => quota.fetchAllQuota(),
  openContextMenu: () => ipcRenderer.send('context-menu'),
  // Fit the window height to the rendered content.
  resizeContent: (h) => ipcRenderer.send('resize-content', h),
})
