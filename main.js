// Electron main process. One frameless always-on-top BrowserWindow.
// Window position and size are persisted to ~/.claude-usage-widget.json
// so the user's manual placement survives restarts. Everything else
// (data parsing, rendering) lives in the renderer — see src/.

const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const STATE_PATH = path.join(os.homedir(), '.claude-usage-widget.json')

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)) } catch { /* ignore */ }
}

let win = null

function createWindow() {
  const state = loadState()
  const primary = screen.getPrimaryDisplay().workArea
  // Default: top-right corner, ~360x340, can grow with content
  const width = state.width ?? 360
  const height = state.height ?? 340
  const x = state.x ?? (primary.x + primary.width - width - 16)
  const y = state.y ?? (primary.y + 16)

  win = new BrowserWindow({
    width, height, x, y,
    minWidth: 280,
    minHeight: 120,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,            // show in taskbar so it's not "lost"
    backgroundColor: '#00000000',  // transparent — CSS draws the chrome
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs to require('./src/parser.js') — that's not
      // possible inside the default Chromium sandbox. The renderer
      // itself stays sandboxed and has zero Node access; only the
      // preload bridge runs unsandboxed, which is the standard pattern
      // for desktop tools that touch local files.
      sandbox: false,
    },
  })

  // Keep on top across full-screen apps too
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.loadFile(path.join(__dirname, 'src', 'index.html'))

  const persist = () => {
    if (!win || win.isDestroyed()) return
    const [w, h] = win.getSize()
    const [px, py] = win.getPosition()
    saveState({ width: w, height: h, x: px, y: py })
  }
  win.on('moved', persist)
  win.on('resized', persist)
  win.on('close', persist)
}

// Right-click context menu — quit + reload + toggle-always-on-top
function showContextMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: win?.isAlwaysOnTop() ? '✓ Always on top' : 'Always on top',
      click: () => win?.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver'),
    },
    { label: 'Reload',  click: () => win?.reload() },
    { label: 'DevTools', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  menu.popup({ window: win })
}
ipcMain.on('context-menu', showContextMenu)

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
