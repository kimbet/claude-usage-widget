// Data layer for the widget. Reads two things from Claude Code's
// local profile:
//
//   ~/.claude/sessions/<pid>.json   — live process registry, one file
//                                     per Claude Code process. Tells us
//                                     which sessions are running and
//                                     what their status (busy/idle) is.
//   ~/.claude/projects/<cwd-mangled>/<sessionId>.jsonl
//                                   — per-session transcript. Each
//                                     assistant message carries a
//                                     `usage` block with input /
//                                     output / cache_read /
//                                     cache_creation token counts and
//                                     a `model` field.
//
// Combining the two gives us, per running session:
//   - name, cwd, status, last-heartbeat
//   - context size = sum of the four token counts from the LAST
//     assistant message (= the conversation state when the model
//     last replied)
//   - 15-minute token throughput = sum of (input + output +
//     cache_creation) over assistant messages with timestamp >= now-15m
//
// Nothing here is async-aware to disk; reads are synchronous because
// the data volumes are small (each JSONL is read tail-first and we
// only scan as far back as we need).

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const HOME = os.homedir()
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions')
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

// "Active" = sessions/<pid>.json updated within this many milliseconds
// AND the recorded pid is still alive. The CLI rewrites the file on
// every event, so a 10-minute stale gap means the conversation is
// quiescent; combined with the alive-check, we drop crashed PIDs that
// left stale registry entries behind.
const ACTIVE_WINDOW_MS = 10 * 60_000

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) {
    // ESRCH = no such process. EPERM (rare on Windows) = process
    // exists but we lack permission; still alive.
    return e.code === 'EPERM'
  }
}

// Throughput window for the "X tok/min" metric.
const THROUGHPUT_WINDOW_MS = 15 * 60_000

// Per-model context-window cap, in tokens. Used for the "%" display.
// Default for unrecognised models is 200k (standard Anthropic limit).
// Arnold uses Opus 4.7 1M — see system prompt. If you switch models,
// extend this map.
const CONTEXT_LIMITS = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
}
function contextLimitFor(model) {
  if (!model) return 200_000
  // Strip vendor suffixes like "[1m]" or date-stamps before lookup
  const base = model.replace(/[[\-]\d.*$/, '').replace(/-\d{8}$/, '')
  return CONTEXT_LIMITS[base] ?? CONTEXT_LIMITS[model] ?? 200_000
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// Map a working-directory path to Claude Code's folder-name convention.
// CC replaces every `\`, `/`, and `:` with a single `-` — NOT collapsing
// runs. So `C:\repos\wine` becomes `C--repos-wine` (the `:` and the `\`
// each map to one dash). Empirically confirmed against the live profile.
function mangleCwd(cwd) {
  return cwd.replace(/[\\\/:]/g, '-')
}

function listActiveSessions() {
  let entries = []
  try { entries = fs.readdirSync(SESSIONS_DIR) } catch { return [] }
  const now = Date.now()
  const out = []
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const meta = readJsonSafe(path.join(SESSIONS_DIR, f))
    if (!meta) continue
    if (meta.kind !== 'interactive') continue
    // Stale crashed-CLI entries lack both updatedAt and status — drop
    // them. Empirically CC only writes the registry once it has a
    // session in steady state.
    if (typeof meta.updatedAt !== 'number') continue
    if (now - meta.updatedAt > ACTIVE_WINDOW_MS) continue
    // PID-alive check catches the case where the CLI was killed
    // mid-flight without cleaning up its registry file.
    if (!pidAlive(meta.pid)) continue
    out.push(meta)
  }
  // Most-recently-active first
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return out
}

// Read a JSONL file tail-first, parsing each line. Stops as soon as
// `stop(parsed, all)` returns true. Avoids loading huge transcripts
// when we only need the last N relevant messages.
function readJsonlTail(filePath, stop) {
  let content
  try { content = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  const lines = content.split('\n')
  const out = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    out.push(parsed)
    if (stop && stop(parsed, out)) break
  }
  return out
}

// Returns per-session live stats. Pulled out so we can test it
// against any single session file without spinning up an entire scan.
function statsForSession(meta) {
  const cwdFolder = mangleCwd(meta.cwd || '')
  const jsonl = path.join(PROJECTS_DIR, cwdFolder, `${meta.sessionId}.jsonl`)
  const cutoff = Date.now() - THROUGHPUT_WINDOW_MS

  let lastAssistantUsage = null
  let lastAssistantModel = null
  let recentTokens = 0
  let recentMessages = 0
  let stopReadingAfter = false

  readJsonlTail(jsonl, (ev) => {
    if (ev.type !== 'assistant') return false
    const u = ev.message?.usage
    if (!u) return false
    if (!lastAssistantUsage) {
      lastAssistantUsage = u
      lastAssistantModel = ev.message?.model || null
    }
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN
    if (Number.isFinite(ts) && ts >= cutoff) {
      // Throughput = "new work" only. cache_read is replayed context
      // and dominates by 10–100×; counting it makes every session
      // look like 600k tok/min, which is technically true but useless
      // for "how fast is this conversation moving?".
      recentTokens += (u.input_tokens || 0)
                    + (u.output_tokens || 0)
                    + (u.cache_creation_input_tokens || 0)
      recentMessages += 1
    } else if (lastAssistantUsage) {
      // We've fallen out of the 15-minute window AND we already have
      // the last-assistant snapshot — nothing further back is needed.
      stopReadingAfter = true
    }
    return stopReadingAfter
  })

  const ctxSize = lastAssistantUsage
    ? (lastAssistantUsage.input_tokens || 0)
      + (lastAssistantUsage.cache_creation_input_tokens || 0)
      + (lastAssistantUsage.cache_read_input_tokens || 0)
    : 0

  const ctxLimit = contextLimitFor(lastAssistantModel)
  const ctxPct = ctxLimit > 0 ? (ctxSize / ctxLimit) * 100 : 0

  // Rate in tokens / minute, averaged over the actual elapsed time in
  // the window. If there's only one message at the start, the rate
  // is meaningless — fall back to "messages × tokens / 15min".
  const tokensPerMin = recentTokens / 15

  return {
    sessionId: meta.sessionId,
    pid: meta.pid,
    name: meta.name || path.basename(meta.cwd || ''),
    cwd: meta.cwd,
    status: meta.status || 'unknown',
    updatedAt: meta.updatedAt,
    idleMs: Math.max(0, Date.now() - (meta.updatedAt || Date.now())),
    model: lastAssistantModel,
    ctxSize,
    ctxLimit,
    ctxPct,
    recentTokens,
    recentMessages,
    tokensPerMin,
    hasUsageData: !!lastAssistantUsage,
  }
}

// Sum today's tokens across all known projects' JSONLs. "Today" means
// from local-time midnight onwards. Cheap because we only look at
// files modified since midnight (others can't have today's events
// without being touched).
function todayTotals() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const since = midnight.getTime()
  let projectDirs = []
  try { projectDirs = fs.readdirSync(PROJECTS_DIR) } catch { return { tokens: 0, messages: 0 } }

  let tokens = 0
  let messages = 0
  for (const d of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, d)
    let files = []
    try { files = fs.readdirSync(dirPath) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const fp = path.join(dirPath, f)
      let stat
      try { stat = fs.statSync(fp) } catch { continue }
      if (stat.mtimeMs < since) continue
      // Walk the file tail-first; stop when we cross midnight.
      readJsonlTail(fp, (ev) => {
        if (ev.type !== 'assistant') return false
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN
        if (!Number.isFinite(ts)) return false
        if (ts < since) return true  // past midnight — stop
        const u = ev.message?.usage
        if (!u) return false
        // Same definition as the per-session 15-min rate — "new work"
        // excluding cached replays.
        tokens += (u.input_tokens || 0)
                + (u.output_tokens || 0)
                + (u.cache_creation_input_tokens || 0)
        messages += 1
        return false
      })
    }
  }
  return { tokens, messages }
}

// Tokens-per-minute in fixed-width buckets over the last `hoursBack`
// hours, aggregated across every project's JSONL. Returns an array of
// length ⌈hoursBack·60 / bucketMin⌉; index 0 is the oldest bucket,
// index N-1 is the bucket containing "now". Each entry:
//   { t0, t1, tokens, rate }
// where rate = tokens / bucketMin (tokens-per-minute). Same "new work"
// definition as the per-session rate.
function timeSeries(hoursBack = 4, bucketMin = 5) {
  const now = Date.now()
  const since = now - hoursBack * 3_600_000
  const bucketMs = bucketMin * 60_000
  const n = Math.ceil((hoursBack * 60) / bucketMin)
  const tokens = new Array(n).fill(0)

  let projectDirs = []
  try { projectDirs = fs.readdirSync(PROJECTS_DIR) } catch { /* nothing */ }
  for (const d of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, d)
    let files = []
    try { files = fs.readdirSync(dirPath) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const fp = path.join(dirPath, f)
      let stat
      try { stat = fs.statSync(fp) } catch { continue }
      // If the file hasn't been touched in our window AND its mtime is
      // before `since`, it can't contain in-range events. (Older files
      // get skipped entirely — mtime only goes UP as events are appended.)
      if (stat.mtimeMs < since) continue
      readJsonlTail(fp, (ev) => {
        if (ev.type !== 'assistant') return false
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN
        if (!Number.isFinite(ts)) return false
        if (ts < since) return true  // walked past window — stop tail
        const u = ev.message?.usage
        if (!u) return false
        const idx = Math.min(n - 1, Math.max(0, Math.floor((ts - since) / bucketMs)))
        tokens[idx] += (u.input_tokens || 0)
                     + (u.output_tokens || 0)
                     + (u.cache_creation_input_tokens || 0)
        return false
      })
    }
  }

  const buckets = tokens.map((tk, i) => ({
    t0: since + i * bucketMs,
    t1: since + (i + 1) * bucketMs,
    tokens: tk,
    rate: tk / bucketMin,
  }))
  return { hoursBack, bucketMin, buckets }
}

function scan() {
  const sessions = listActiveSessions().map(statsForSession)
  const totals = todayTotals()
  return { sessions, totals, scannedAt: Date.now() }
}

// Slower path for the chart — separated so the renderer can poll it
// on its own cadence (much less often than scan()).
function scanSeries(hoursBack = 4, bucketMin = 5) {
  return { series: timeSeries(hoursBack, bucketMin), scannedAt: Date.now() }
}

module.exports = { scan, scanSeries, statsForSession, listActiveSessions, todayTotals, timeSeries, contextLimitFor, mangleCwd }
