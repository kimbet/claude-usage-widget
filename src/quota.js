// Anthropic OAuth quota endpoint client. Reads the Claude Code OAuth
// access token from ~/.claude/.credentials.json and queries the same
// endpoint that the CLI itself uses for `/usage`. Endpoint + auth
// pattern verified against jens-duttke/usage-monitor-for-claude
// (Python reference); see README.
//
// Returns the raw response, plus convenience flatteners for the two
// periods we actually surface in the widget (5h + 7d).

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json')
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

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

function readToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'))
    return c?.claudeAiOauth?.accessToken || null
  } catch { return null }
}

async function fetchQuota() {
  const token = readToken()
  if (!token) return { error: 'no_token', message: 'no oauth token in ~/.claude/.credentials.json' }

  let res
  try {
    res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent(),
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
  } catch (e) {
    return { error: 'network', message: e.message }
  }

  if (res.status === 401) return { error: 'auth_expired', message: 'token expired — open Claude Code to refresh' }
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
