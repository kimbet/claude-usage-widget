// Read subscription limits through the installed Codex CLI's official
// app-server protocol. Codex owns authentication and token renewal; the widget
// never reads credentials or starts a conversation/model request.
// https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')

const TIMEOUT_MS = 25_000
let inFlight = null
let cancelRequest = null

function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN
  const windows = process.platform === 'win32'
  const exe = windows ? 'codex.exe' : 'codex'
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const candidates = dirs.map(dir => path.join(dir.replace(/^"|"$/g, ''), exe))
  candidates.push(path.join(os.homedir(), '.local', 'bin', exe))
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', exe))

  // npm installs a .cmd/.ps1 shim on Windows. Resolve its native executable
  // directly, so shutdown only has to stop our own child (no shell/wrapper).
  if (windows) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const prefixes = [...dirs, path.join(process.env.APPDATA || os.homedir(), 'npm')]
    for (const prefix of prefixes) {
      const pkg = path.join(prefix.replace(/^"|"$/g, ''), 'node_modules', '@openai', 'codex')
      for (const root of [path.join(pkg, 'node_modules', '@openai', `codex-win32-${arch}`), pkg]) {
        for (const bin of ['bin', 'codex']) {
          candidates.push(path.join(root, 'vendor', target, bin, exe))
        }
      }
    }
  }
  return candidates.find(file => {
    try { return fs.statSync(file).isFile() } catch { return false }
  }) || null
}

function shapeWindow(period, index) {
  if (!period || !Number.isFinite(period.usedPercent) || period.usedPercent < 0) return null
  const mins = period.windowDurationMins
  const durationMs = Number.isFinite(mins) && mins > 0 ? mins * 60_000 : null
  const label = !durationMs ? `Limit ${index + 1}`
    : mins % 1440 === 0 ? `${mins / 1440}d`
    : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`
  const reset = Number.isFinite(period.resetsAt) ? period.resetsAt * 1000 : null
  const resetsAt = reset && Number.isFinite(new Date(reset).getTime()) ? reset : null
  return { label, utilization: period.usedPercent, durationMs, resetsAt }
}

function shapeLimits(result, account) {
  const byId = result?.rateLimitsByLimitId
  const entries = byId && typeof byId === 'object' ? Object.entries(byId) : []
  if (!entries.length && result?.rateLimits) {
    entries.push([result.rateLimits.limitId || 'codex', result.rateLimits])
  }
  const limits = entries.filter(([, limit]) => limit && typeof limit === 'object')
    .map(([id, limit]) => ({
      id,
      name: limit.limitName || (id === 'codex' ? 'Codex' : id),
      periods: [limit.primary, limit.secondary].map(shapeWindow).filter(Boolean),
      unlimited: limit.credits?.unlimited === true,
    }))
  if (!limits.some(limit => limit.periods.length || limit.unlimited)) {
    return { error: 'unavailable', message: 'Keine Codex-Kontingente für dieses Konto verfügbar.' }
  }
  return {
    limits,
    accountKey: account.email || account.type,
    plan: account.planType || result?.rateLimits?.planType || null,
    fetchedAt: Date.now(),
  }
}

function rpcError(error) {
  const msg = String(error?.message || '')
  if (/401|403|auth|log.?in|sign.?in|token/i.test(msg)) {
    return { error: 'auth', message: 'Codex-Anmeldung bitte in Codex erneuern.' }
  }
  if (/429|too many requests/i.test(msg)) {
    return { error: 'rate_limited', message: 'Zu viele Abrufe – nächster Versuch in einer Minute.' }
  }
  if (/method not found|unknown method/i.test(msg)) {
    return { error: 'version', message: 'Bitte die Codex CLI aktualisieren.' }
  }
  // Never relay raw server errors (which can include request/auth details).
  return { error: 'request', message: 'Codex-Nutzung konnte nicht abgerufen werden.' }
}

function readQuota() {
  const executable = findCodex()
  if (!executable) return Promise.resolve({ error: 'missing_cli', message: 'Codex CLI nicht gefunden (CODEX_BIN kann den Pfad vorgeben).' })
  return new Promise(resolve => {
    let child, lines, timer, finished = false, account = null
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      cancelRequest = null
      lines?.close()
      child?.stdin.destroy()
      if (child && child.exitCode === null) child.kill()
      resolve(result)
    }
    cancelRequest = () => finish({ error: 'closed', message: 'Widget beendet.' })
    timer = setTimeout(() => finish({ error: 'timeout', message: 'Codex antwortet gerade nicht – erneuter Abruf folgt.' }), TIMEOUT_MS)
    try {
      child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
        cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      finish({ error: 'start', message: 'Codex CLI konnte nicht gestartet werden.' })
      return
    }
    const send = message => {
      if (!finished) child.stdin.write(JSON.stringify(message) + '\n')
    }
    child.on('error', () => finish({ error: 'start', message: 'Codex CLI konnte nicht gestartet werden.' }))
    child.on('close', () => finish({ error: 'closed', message: 'Codex-Verbindung beendet – erneuter Abruf folgt.' }))
    child.stdin.on('error', () => finish({ error: 'pipe', message: 'Codex-Verbindung unterbrochen.' }))
    child.stderr.resume()
    lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (finished) return
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.method) return // Notifications; no conversations are opened.
      if (![1, 2, 3].includes(message.id)) return
      if (message.error) { finish(rpcError(message.error)); return }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 2, method: 'account/read', params: { refreshToken: false } })
      } else if (message.id === 2) {
        account = message.result?.account
        if (!account) { finish({ error: 'auth', message: 'Bitte zuerst in Codex mit ChatGPT anmelden.' }); return }
        if (account.type === 'apiKey' || account.type === 'amazonBedrock') {
          finish({ error: 'unavailable', message: 'Codex-Abolimits erfordern eine ChatGPT-Anmeldung.' })
          return
        }
        send({ id: 3, method: 'account/rateLimits/read' })
      } else {
        finish(shapeLimits(message.result, account))
      }
    })
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'claude_usage_widget', title: 'Claude + Codex Usage', version: '0.2.0' },
    } })
  })
}

function fetchCodexQuota() {
  if (!inFlight) inFlight = readQuota().finally(() => { inFlight = null })
  return inFlight
}

function dispose() { cancelRequest?.() }

module.exports = { fetchCodexQuota, dispose }
