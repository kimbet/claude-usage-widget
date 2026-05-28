// Preload — exposes a minimal, sandboxed API to the renderer. The
// renderer never touches fs/path directly; all data flows through here.
// Parser logic lives in src/parser.js (CommonJS) and is required here
// rather than in the renderer so the renderer process stays
// nodeIntegration:false.

const { contextBridge, ipcRenderer } = require('electron')
const parser = require('./src/parser.js')

contextBridge.exposeInMainWorld('widget', {
  // Returns: { sessions: SessionView[], totals: { todayTokens, ... } }
  scan: () => parser.scan(),
  openContextMenu: () => ipcRenderer.send('context-menu'),
})
