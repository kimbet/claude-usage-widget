// Anthropic OAuth quota endpoint client. Reads the Claude Code OAuth
// access token from ~/.claude/.credentials.json and queries the same
// endpoint that the CLI itself uses for `/usage`. Endpoint + auth
// pattern verified against jens-duttke/usage-monitor-for-claude
// (Python reference); see README.
//
// Refresh: when the access token is near expiry (or returns 401), we
// exchange the stored refresh_token for a new pair against the same
// console.anthropic.com endpoint Claude Code itself uses. This lets
// the widget keep showing 5h/7d quota even when no CC session is open
// (CC would otherwise be the only thing keeping the token fresh).
//
// Returns the raw response, plus convenience flatteners for the two
// periods we actually surface in the widget (5h + 7d).

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json')
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// Refresh proactively when less than this remains. Generous because we
// poll every 60s and a 401 round-trip costs a poll cycle.
const REFRESH_SKEW_MS = 5 * 60_000

// Best-effort User-Agent — Anthropic doesn't gate on the exact
// version string, but we mimic the CLI so they can attribute load.
function userAgent() {
  // Pull installed CC version from any live session-registry entry
  // (the file always carries the binary's version). Fall back to a
  // recent default if no live session is found.
  try {
    const sd = path.join(os.homedir(), '.claude', 'sessions')
    for (const f of fs.readdirSync(sd)) {
      const meta = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8'))
      if (meta.version) return `claude-code/${meta.version}`
    }
  } catch { /* ignore */ }
  return 'claude-code/2.1.152'
}

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')) } catch { return null }
}

// Atomic write so a crashed/torn write can't brick the user's CC login.
// Re-read inside the refresh path before writing so we preserve any
// concurrent updates Claude Code itself may have made.
function writeCreds(creds) {
  const tmp = CREDENTIALS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2))
  fs.renameSync(tmp, CREDENTIALS)
}

// Single in-flight refresh promise — avoids racing ourselves if poll
// and on-401-retry both decide to refresh in the same tick.
let refreshInFlight = null

async function doRefresh(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'anthropic',
    },
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
  // Re-read in case CC also rewrote the file while we were waiting on
  // the network. We only swap the OAuth fields, never the surrounding
  // keys (subscriptionType, scopes, …).
  const fresh = readCreds() || {}
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
  writeCreds(fresh)
  return fresh
}

async function refreshIfNeeded(force) {
  const creds = readCreds()
  const o = creds?.claudeAiOauth
  if (!o?.refreshToken) return creds
  const remaining = (o.expiresAt || 0) - Date.now()
  if (!force && remaining > REFRESH_SKEW_MS) return creds
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(o.refreshToken).finally(() => { refreshInFlight = null })
  }
  try { return await refreshInFlight } catch { return readCreds() }
}

async function fetchQuota() {
  let creds = await refreshIfNeeded(false)
  let token = creds?.claudeAiOauth?.accessToken
  if (!token) return { error: 'no_token', message: 'no oauth token in ~/.claude/.credentials.json' }

  async function call(tok) {
    return fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent(),
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
  }

  let res
  try {
    res = await call(token)
    // Force-refresh + retry once on 401 — covers the case where the
    // server considered the token expired before our local clock did
    // (skew, or CC silently invalidated it).
    if (res.status === 401) {
      const refreshed = await refreshIfNeeded(true)
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

  // Flatten the two periods we actually render. Server returns
  // utilization (0-100 integer) and resets_at (ISO string, UTC).
  function shape(period) {
    if (!period) return null
    const resetsAt = period.resets_at ? new Date(period.resets_at).getTime() : null
    return {
      utilization: period.utilization ?? 0,
      resetsAt,
      resetsInMs: resetsAt ? Math.max(0, resetsAt - Date.now()) : null,
    }
  }

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

module.exports = { fetchQuota }
