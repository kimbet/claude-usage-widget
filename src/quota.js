// Anthropic OAuth quota endpoint client. Reads the Claude Code OAuth
// access token from a Claude config dir's .credentials.json and queries
// the same endpoint the CLI uses for `/usage`. Endpoint + auth pattern
// verified against jens-duttke/usage-monitor-for-claude (Python ref).
//
// Multi-account (3.7.2026): every cred function takes a configDir, so the
// widget can show usage of ALL logged-in accounts, not just ~/.claude.
// Account list comes from IP-Tagebuch/config/accounts.json (single source
// of truth); any account whose <configDir>/.credentials.json exists is
// shown. Default configDir = ~/.claude keeps the single-account path.
//
// Refresh: when the access token is near expiry (or returns 401), we
// exchange the stored refresh_token for a new pair against the same
// console.anthropic.com endpoint Claude Code itself uses, and write it
// back atomically INTO THE SAME configDir.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_DIR = path.join(os.homedir(), '.claude')
const ACCOUNTS_JSON = 'C:\\repos\\IP-Tagebuch\\config\\accounts.json'
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REFRESH_SKEW_MS = 5 * 60_000

const credPath = (configDir) => path.join(configDir || DEFAULT_DIR, '.credentials.json')

// Account list: every logged-in account from IP-Tagebuch/config/accounts.json
// (config_dir with an existing .credentials.json). Falls back to just the
// default ~/.claude account so the widget always shows something.
function loadAccounts() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'))
    const accs = (cfg.accounts || [])
      .map(a => ({ name: a.name, configDir: a.config_dir }))
      .filter(a => a.configDir && fs.existsSync(credPath(a.configDir)))
    if (accs.length) return accs
  } catch { /* ignore — fall back below */ }
  return [{ name: 'haupt', configDir: DEFAULT_DIR }]
}

function userAgent() {
  try {
    const sd = path.join(os.homedir(), '.claude', 'sessions')
    for (const f of fs.readdirSync(sd)) {
      const meta = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8'))
      if (meta.version) return `claude-code/${meta.version}`
    }
  } catch { /* ignore */ }
  return 'claude-code/2.1.152'
}

function readCreds(configDir) {
  try { return JSON.parse(fs.readFileSync(credPath(configDir), 'utf8')) } catch { return null }
}

// Atomic write so a crashed/torn write can't brick the account's CC login.
function writeCreds(configDir, creds) {
  const p = credPath(configDir)
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2))
  fs.renameSync(tmp, p)
}

// One in-flight refresh promise PER configDir — avoids racing ourselves
// across accounts (and within an account across poll/on-401).
const refreshInFlight = new Map()

async function doRefresh(configDir, refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'anthropic' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`refresh HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  const body = await res.json()
  const fresh = readCreds(configDir) || {}
  const prev = fresh.claudeAiOauth || {}
  const expiresAt = body.expires_at
    ? Number(body.expires_at)
    : (body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null)
  fresh.claudeAiOauth = {
    ...prev,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || prev.refreshToken,
    ...(expiresAt ? { expiresAt } : {}),
  }
  writeCreds(configDir, fresh)
  return fresh
}

async function refreshIfNeeded(configDir, force) {
  const creds = readCreds(configDir)
  const o = creds?.claudeAiOauth
  if (!o?.refreshToken) return creds
  const remaining = (o.expiresAt || 0) - Date.now()
  if (!force && remaining > REFRESH_SKEW_MS) return creds
  if (!refreshInFlight.has(configDir)) {
    refreshInFlight.set(configDir,
      doRefresh(configDir, o.refreshToken).finally(() => refreshInFlight.delete(configDir)))
  }
  try { return await refreshInFlight.get(configDir) } catch { return readCreds(configDir) }
}

function shape(period) {
  if (!period) return null
  const resetsAt = period.resets_at ? new Date(period.resets_at).getTime() : null
  return {
    utilization: period.utilization ?? 0,
    resetsAt,
    resetsInMs: resetsAt ? Math.max(0, resetsAt - Date.now()) : null,
  }
}

async function fetchQuota(configDir = DEFAULT_DIR) {
  let creds = await refreshIfNeeded(configDir, false)
  let token = creds?.claudeAiOauth?.accessToken
  if (!token) return { error: 'no_token', message: `no oauth token in ${credPath(configDir)}` }

  const call = (tok) => fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
      'anthropic-beta': 'oauth-2025-04-20',
    },
  })

  let res
  try {
    res = await call(token)
    if (res.status === 401) {
      const refreshed = await refreshIfNeeded(configDir, true)
      const newTok = refreshed?.claudeAiOauth?.accessToken
      if (newTok && newTok !== token) res = await call(newTok)
    }
  } catch (e) {
    return { error: 'network', message: e.message }
  }

  if (res.status === 401) return { error: 'auth_expired', message: 'token refresh failed — open Claude Code to re-auth' }
  if (res.status === 429) return { error: 'rate_limited', message: 'too many requests', retryAfter: Number(res.headers.get('Retry-After')) || null }
  if (!res.ok) return { error: 'http', message: `HTTP ${res.status}`, status: res.status }

  let body
  try { body = await res.json() } catch (e) { return { error: 'parse', message: e.message } }

  return {
    fiveHour: shape(body.five_hour),
    sevenDay: shape(body.seven_day),
    sevenDayOpus: shape(body.seven_day_opus),
    sevenDaySonnet: shape(body.seven_day_sonnet),
    extraUsage: body.extra_usage || null,
    raw: body,
    fetchedAt: Date.now(),
  }
}

// Usage of ALL logged-in accounts, in config order. Each entry:
// { name, quota } where quota is a fetchQuota() result (or {error}).
async function fetchAllQuota() {
  const accounts = loadAccounts()
  const results = await Promise.all(
    accounts.map(async (a) => ({ name: a.name, quota: await fetchQuota(a.configDir) }))
  )
  return { accounts: results, fetchedAt: Date.now() }
}

module.exports = { fetchQuota, fetchAllQuota, loadAccounts }
