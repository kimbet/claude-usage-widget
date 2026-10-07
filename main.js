// Electron main process. One frameless always-on-top BrowserWindow.
// Window position and size are persisted to ~/.claude-usage-widget.json
// so the user's manual placement survives restarts. The Codex quota child
// belongs to this process; the UI and Claude data bridge live in src/.

const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const codexQuota = require('./src/codex-quota.js')

const STATE_PATH = path.join(os.homedir(), '.claude-usage-widget.json')
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico')

// Eigene Windows-Taskleisten-Identitaet: ohne das erbt die App die generische
// "Electron"-Identitaet (Taskleiste zeigt Electron, Anheften heftet electron.exe
// an -> startet leer neu). Mit einer eigenen AppUserModelID gruppiert Windows das
// Fenster unter einer eigenen, anheftbaren Schaltflaeche (passend zur gleichnamigen
// Verknuepfung im Startmenue). Muss VOR app.whenReady gesetzt werden.
const APP_ID = 'com.arnoldruess.claude-usage-widget'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
// Merge, don't clobber: the same file carries the user's optional
// multi-account override (`accounts` — see src/quota.js loadAccounts).
// Persisting the window position must not wipe hand-written keys.
function saveState(patch) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...loadState(), ...patch }, null, 2))
  } catch { /* ignore */ }
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
    icon: ICON_PATH,
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

  // Click-through by default: every click lands on whatever is below the
  // widget. `forward` keeps mousemove flowing to the renderer so it can
  // flip hit-testing on while the pointer is over the title bar.
  setClickThrough(true)

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

// Two independent reasons to accept mouse input: the pointer is over the
// title bar (drag handle + ⋯ button; renderer reports entry and the bar's
// height), or the user unlocked the widget via the menu to resize it.
// Everything else passes through.
let overHeader = false
let headerH = 0
let headerPoll = null
let unlocked = false
function setClickThrough(on) {
  if (!win || win.isDestroyed()) return
  if (on) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}
function applyMouseMode() {
  setClickThrough(!(overHeader || unlocked))
}
// Windows treats the drag region as non-client area: the page sees no
// mousemove/mouseleave there, so it can't tell us when the pointer leaves
// the bar upward or sideways. While the bar is "hot", main checks the
// cursor itself and drops back to click-through once it is outside.
function setOverHeader(over) {
  overHeader = over
  clearInterval(headerPoll)
  headerPoll = null
  if (over) {
    headerPoll = setInterval(() => {
      if (!win || win.isDestroyed()) return setOverHeader(false)
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + headerH
      if (!inside) {
        setOverHeader(false)
        win.webContents.send('menu-closed')
      }
    }, 100)
  }
  applyMouseMode()
}
ipcMain.on('header-hover', (e, over, height) => {
  if (height) headerH = height
  if (over !== overHeader) setOverHeader(!!over)
})
function setUnlocked(on) {
  unlocked = on
  applyMouseMode()
  win?.webContents.send('unlocked', on)
}

// ⋯ menu — move/resize toggle, always-on-top, reload, quit
function showContextMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: unlocked ? '✓ Größe ändern' : 'Größe ändern',
      click: () => setUnlocked(!unlocked),
    },
    {
      label: win?.isAlwaysOnTop() ? '✓ Always on top' : 'Always on top',
      click: () => win?.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver'),
    },
    { label: 'Reload',  click: () => win?.reload() },
    { label: 'DevTools', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  menu.popup({
    window: win,
    // The pointer usually leaves the button while the native menu is
    // open; the renderer can't see that, so drop back to click-through
    // and let the next mousemove over the button re-arm it.
    callback: () => {
      setOverHeader(false)
      win?.webContents.send('menu-closed')
    },
  })
}
ipcMain.on('context-menu', showContextMenu)
ipcMain.handle('codex-quota', () => codexQuota.fetchCodexQuota())

// Fit window height to rendered content. Width and position stay as the
// user placed them; only the height tracks the content so the panel has
// no dead space below the quota (the tall session list is gone).
ipcMain.on('resize-content', (e, h) => {
  if (!win || win.isDestroyed()) return
  const [w, curH] = win.getSize()
  const target = Math.max(120, Math.min(900, Math.round(h)))
  if (Math.abs(curH - target) > 1) win.setSize(w, target)
})

app.whenReady().then(createWindow)
app.on('before-quit', () => codexQuota.dispose())
app.on('window-all-closed', () => app.quit())
