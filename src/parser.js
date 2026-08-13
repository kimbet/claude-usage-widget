// Data layer for the widget. Reads Claude Code's per-session transcripts
//
//   ~/.claude/projects/<cwd-mangled>/<sessionId>.jsonl
//
// where each `type: "assistant"` line carries a `usage` block with
// input / output / cache_read / cache_creation token counts, and
// computes two aggregates for the UI:
//
//   - todayTotals(): "new work" tokens + message count since local
//     midnight, across every project
//   - timeSeries(): tokens-per-minute buckets over the last N hours,
//     for the sparkline
//
// "New work" = input + output + cache_creation, NOT cache_read —
// cache_read replays of the conversation dominate raw counts by
// 10-100x and would make every number meaningless.
//
// Transcripts are append-only and can get big (tens of MB), so nothing
// here ever reads a whole file per poll:
//
//   - readJsonlTail() walks a file BACKWARDS in fixed-size chunks via
//     a file descriptor and stops as soon as the caller has seen
//     enough (e.g. crossed the time-window boundary).
//   - todayTotals() additionally keeps a per-file offset cache
//     (position + running sums): repeated polls only read and parse
//     the bytes appended since the previous poll. Shrunk/rotated
//     files reset the entry; a trailing line that hasn't received its
//     newline yet is counted transiently and only folded into the
//     cache once complete, so torn writes are neither lost nor
//     double-counted.
//
// Everything is synchronous; per poll the widget now touches a few KB,
// not the whole corpus. Pure Node, no Electron dependency.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const HOME = os.homedir()
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

const TAIL_CHUNK = 64 * 1024

// ---------------------------------------------------------------- io --

function readRange(fd, start, end) {
  const buf = Buffer.alloc(end - start)
  fs.readSync(fd, buf, 0, end - start, start)
  return buf.toString('utf8')
}

// Byte offset just after the last '\n' in [0, size); 0 if none. Scans
// backwards chunk-wise, so a huge file with a short trailing line costs
// one small read.
function lastLineBoundary(fd, size) {
  let end = size
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK)
    const buf = Buffer.alloc(end - start)
    fs.readSync(fd, buf, 0, end - start, start)
    const idx = buf.lastIndexOf(0x0A)
    if (idx !== -1) return start + idx + 1
    end = start
  }
  return 0
}

// Walk the complete ('\n'-terminated) JSON lines of [0, endOffset)
// backwards (newest first). cb(parsed) returning true stops the walk.
// Chunk boundaries: the partial line at a chunk's start is carried over
// (as raw bytes, so multi-byte UTF-8 sequences split by the boundary
// stay intact) and completed by the next-earlier chunk; only whole
// lines are ever decoded and parsed. Unparseable lines are skipped.
function forEachJsonLineBackward(fd, endOffset, cb) {
  let end = endOffset
  let carry = null
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK)
    let chunk = Buffer.alloc(end - start)
    fs.readSync(fd, chunk, 0, end - start, start)
    if (carry && carry.length) chunk = Buffer.concat([chunk, carry])
    let parseFrom = 0
    if (start > 0) {
      const firstNl = chunk.indexOf(0x0A)
      if (firstNl === -1) { carry = chunk; end = start; continue }
      carry = chunk.subarray(0, firstNl)
      parseFrom = firstNl + 1
    }
    const lines = chunk.subarray(parseFrom).toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      if (cb(parsed)) return
    }
    end = start
  }
}

// Read a JSONL file tail-first, parsing each line. Stops as soon as
// `stop(parsed, all)` returns true. The trailing line is included even
// if the file doesn't end in '\n' (matching what a whole-file read
// would parse), provided it is complete JSON.
function readJsonlTail(filePath, stop) {
  let fd
  try { fd = fs.openSync(filePath, 'r') } catch { return [] }
  const out = []
  try {
    const size = fs.fstatSync(fd).size
    const boundary = lastLineBoundary(fd, size)
    let stopped = false
    const consume = (parsed) => {
      out.push(parsed)
      stopped = !!(stop && stop(parsed, out))
      return stopped
    }
    if (boundary < size) {
      const frag = readRange(fd, boundary, size).trim()
      if (frag) {
        let parsed = null
        try { parsed = JSON.parse(frag) } catch { /* incomplete write */ }
        if (parsed !== null) consume(parsed)
      }
    }
    if (!stopped) forEachJsonLineBackward(fd, boundary, consume)
    return out
  } catch { return out }
  finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
}

// ------------------------------------------------------------ totals --

function newWork(u) {
  return (u.input_tokens || 0)
       + (u.output_tokens || 0)
       + (u.cache_creation_input_tokens || 0)
}

// Fold one parsed event into an accumulator if it is a today's-work
// assistant event.
function addUsage(acc, ev, since) {
  if (!ev || ev.type !== 'assistant') return
  const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN
  if (!Number.isFinite(ts) || ts < since) return
  const u = ev.message?.usage
  if (!u) return
  acc.tokens += newWork(u)
  acc.messages += 1
}

// Per-file incremental state for todayTotals():
//   pos              — byte offset just after the last complete line
//                      folded into the sums
//   tokens/messages  — today's sums up to pos
// Cleared wholesale when the local day rolls over. Assumes transcripts
// are append-only (which they are); a same-size in-place rewrite would
// go unnoticed, a shrink/rotation resets the entry.
const totalsCache = new Map()
let totalsCacheDay = 0

function fileTotalsForToday(fp, since) {
  let fd
  try { fd = fs.openSync(fp, 'r') } catch { return { tokens: 0, messages: 0 } }
  try {
    const size = fs.fstatSync(fd).size
    let e = totalsCache.get(fp)
    let fragText = null

    if (!e || size < e.pos) {
      // First sight of the file today, or it shrank (rotation): full
      // recount — but tail-bounded, stopping at the first assistant
      // event from before midnight (transcripts are chronological).
      e = { pos: lastLineBoundary(fd, size), tokens: 0, messages: 0 }
      forEachJsonLineBackward(fd, e.pos, (ev) => {
        if (ev.type !== 'assistant') return false
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN
        if (!Number.isFinite(ts)) return false
        if (ts < since) return true
        const u = ev.message?.usage
        if (u) { e.tokens += newWork(u); e.messages += 1 }
        return false
      })
      totalsCache.set(fp, e)
      if (size > e.pos) fragText = readRange(fd, e.pos, size)
    } else if (size > e.pos) {
      // Grown: read only the appended bytes. Complete lines go into
      // the persistent sums; whatever follows the last '\n' becomes
      // the transient fragment.
      const text = readRange(fd, e.pos, size)
      const lastNl = text.lastIndexOf('\n')
      if (lastNl === -1) {
        fragText = text
      } else {
        for (const line of text.slice(0, lastNl).split('\n')) {
          const s = line.trim()
          if (!s) continue
          let ev
          try { ev = JSON.parse(s) } catch { continue }
          addUsage(e, ev, since)
        }
        e.pos += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
        if (lastNl + 1 < text.length) fragText = text.slice(lastNl + 1)
      }
    }

    // Trailing not-yet-terminated line: count it for THIS call only
    // (a whole-file scan would see it too); it enters the cache once
    // its '\n' arrives. Torn writes simply fail JSON.parse.
    let extraTokens = 0
    let extraMessages = 0
    if (fragText && fragText.trim()) {
      let ev = null
      try { ev = JSON.parse(fragText.trim()) } catch { /* incomplete */ }
      if (ev !== null) {
        const acc = { tokens: 0, messages: 0 }
        addUsage(acc, ev, since)
        extraTokens = acc.tokens
        extraMessages = acc.messages
      }
    }
    return { tokens: e.tokens + extraTokens, messages: e.messages + extraMessages }
  } catch {
    return { tokens: 0, messages: 0 }
  } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
}

// Sum today's tokens across all known projects' JSONLs. "Today" means
// from local-time midnight onwards. Cheap on repeated polls: files not
// touched since midnight are skipped via mtime, everything else is
// served from the per-file offset cache and only reads its append
// delta.
function todayTotals() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const since = midnight.getTime()
  if (totalsCacheDay !== since) { totalsCache.clear(); totalsCacheDay = since }

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
      // Untouched since midnight -> cannot contain today's events
      // (mtime only moves forward as events are appended).
      if (stat.mtimeMs < since) continue
      const t = fileTotalsForToday(fp, since)
      tokens += t.tokens
      messages += t.messages
    }
  }
  return { tokens, messages }
}

// ------------------------------------------------------------ series --

// Tokens-per-minute in fixed-width buckets over the last `hoursBack`
// hours, aggregated across every project's JSONL. Returns an array of
// length ⌈hoursBack·60 / bucketMin⌉; index 0 is the oldest bucket,
// index N-1 is the bucket containing "now". Each entry:
//   { t0, t1, tokens, rate }
// where rate = tokens / bucketMin (tokens-per-minute). Same "new work"
// definition as the totals. The tail walk stops at the window edge, so
// per call this reads at most the last `hoursBack` hours of each file.
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
        tokens[idx] += newWork(u)
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

// Wrapper for the chart bridge — keeps the { series, scannedAt } shape.
function scanSeries(hoursBack = 4, bucketMin = 5) {
  return { series: timeSeries(hoursBack, bucketMin), scannedAt: Date.now() }
}

module.exports = { todayTotals, timeSeries, scanSeries, readJsonlTail }
