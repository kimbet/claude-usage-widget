// Tests for src/parser.js — the incremental tail reader and the
// cached today-totals aggregation.
//
// parser.js resolves ~/.claude/projects from os.homedir() once at
// require() time. Rather than touch the real developer's Claude Code
// data, every test redirects os.homedir() to a throwaway temp fixture
// home first, then requires a FRESH parser instance against it (which
// also resets the module-level offset cache). Callers must run
// cleanup() in a finally so os.homedir() and the require cache are
// restored and the fixture is removed.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const realHomedir = os.homedir
const parserPath = require.resolve('../src/parser.js')

function freshParser(fakeHome) {
  fakeHome = fakeHome || fs.mkdtempSync(path.join(os.tmpdir(), 'uw-parser-'))
  os.homedir = () => fakeHome
  delete require.cache[parserPath]
  const parser = require('../src/parser.js')
  return {
    parser,
    fakeHome,
    projectsDir: path.join(fakeHome, '.claude', 'projects'),
    cleanup(keepHome) {
      os.homedir = realHomedir
      delete require.cache[parserPath]
      if (!keepHome) fs.rmSync(fakeHome, { recursive: true, force: true })
    },
  }
}

// A second, cache-free parser instance against the SAME fixture home —
// its first todayTotals() call is by definition a full scan, which the
// cached instance's numbers must match exactly.
function fullScanTotals(fakeHome) {
  os.homedir = () => fakeHome
  delete require.cache[parserPath]
  const fresh = require('../src/parser.js')
  const totals = fresh.todayTotals()
  delete require.cache[parserPath]
  return totals
}

function localMidnight() {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const jsonl = (events) => events.map(e => JSON.stringify(e)).join('\n') + '\n'

function assistantEvent(ts, inTok, outTok, cacheCreate = 0, cacheRead = 0) {
  return {
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  }
}

function writeProjectFile(projectsDir, folder, file, content) {
  const dir = path.join(projectsDir, folder)
  fs.mkdirSync(dir, { recursive: true })
  const fp = path.join(dir, file)
  fs.writeFileSync(fp, content)
  return fp
}

// ---- readJsonlTail: chunked backward reading ----

test('readJsonlTail: newest-first, stop callback includes the triggering event', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const fp = writeProjectFile(projectsDir, 'p', 's.jsonl',
      jsonl([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]))
    const out = parser.readJsonlTail(fp, (ev) => ev.n === 2)
    assert.deepEqual(out.map(e => e.n), [4, 3, 2])
  } finally { cleanup() }
})

test('readJsonlTail: matches a whole-file scan on a multi-chunk file with long and multi-byte lines', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    // Build ~300 KB: many short lines with multi-byte chars, plus one
    // ~80 KB line (bigger than the 64 KB chunk, so it MUST span a
    // chunk boundary), plus garbage lines, no trailing newline.
    const events = []
    for (let i = 0; i < 2000; i++) events.push({ i, txt: `zeile-${i}-äöü€…` })
    events[700] = { i: 700, big: 'X'.repeat(80 * 1024) + 'ÄÖÜ-ende' }
    let content = events.map(e => JSON.stringify(e)).join('\n')
    // splice garbage into the middle and leave the last line unterminated
    content = content.replace('"zeile-1000-', '"zeile-1000-') + '\n{not json}\n'
      + JSON.stringify({ i: 2000, txt: 'letzte-zeile-ohne-newline-ÿ' })
    const fp = writeProjectFile(projectsDir, 'p', 'big.jsonl', content)

    // Reference: naive whole-file read (the old implementation).
    const reference = fs.readFileSync(fp, 'utf8').split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(e => e !== null)
      .reverse()

    const out = parser.readJsonlTail(fp)
    assert.equal(out.length, reference.length)
    assert.deepEqual(out, reference)
    // spot-check the boundary-spanning payload survived intact
    const big = out.find(e => e.i === 700)
    assert.equal(big.big.length, 80 * 1024 + 'ÄÖÜ-ende'.length)
    assert.ok(big.big.endsWith('ÄÖÜ-ende'))
    assert.equal(out[0].txt, 'letzte-zeile-ohne-newline-ÿ')
  } finally { cleanup() }
})

test('readJsonlTail: missing file yields an empty array', () => {
  const { parser, cleanup } = freshParser()
  try {
    assert.deepEqual(parser.readJsonlTail(path.join(os.tmpdir(), 'uw-no-such-file.jsonl')), [])
  } finally { cleanup() }
})

// ---- todayTotals: correctness across days ----

test('todayTotals: multi-day file only counts events since local midnight', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const m = midnight.getTime()
    writeProjectFile(projectsDir, 'proj-a', 's1.jsonl', jsonl([
      assistantEvent(m - 30 * 3_600_000, 7_000, 7_000),      // day before yesterday-ish
      assistantEvent(m - 60_000, 5_000, 5_000),              // yesterday 23:59
      { type: 'user', timestamp: new Date(m + 1_000).toISOString() },
      assistantEvent(m + 60_000, 100, 200, 50, 999_999),     // today (cache_read ignored)
      assistantEvent(m + 120_000, 10, 20),                   // today
    ]))
    const totals = parser.todayTotals()
    assert.deepEqual(totals, { tokens: 380, messages: 2 })
  } finally { cleanup() }
})

test('todayTotals: sums across multiple project dirs and files', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const m = localMidnight()
    writeProjectFile(projectsDir, 'proj-a', 's1.jsonl', jsonl([assistantEvent(m + 60_000, 10, 20)]))
    writeProjectFile(projectsDir, 'proj-b', 's2.jsonl', jsonl([assistantEvent(m + 60_000, 1, 2)]))
    writeProjectFile(projectsDir, 'proj-b', 'notes.txt', 'not a transcript')
    assert.deepEqual(parser.todayTotals(), { tokens: 33, messages: 2 })
  } finally { cleanup() }
})

// ---- todayTotals: offset cache vs. full scan ----

test('todayTotals: file grows between two polls — delta matches a full scan', () => {
  const { parser, projectsDir, fakeHome, cleanup } = freshParser()
  try {
    // Midnight-relative timestamps: always "today", even if the test
    // happens to run seconds after 00:00.
    const m = localMidnight()
    const fp = writeProjectFile(projectsDir, 'proj-grow', 's.jsonl', jsonl([
      assistantEvent(m + 60_000, 100, 100),
      assistantEvent(m + 120_000, 10, 10),
    ]))
    assert.deepEqual(parser.todayTotals(), { tokens: 220, messages: 2 })

    // Append: an assistant event, a non-assistant event, garbage.
    fs.appendFileSync(fp, jsonl([
      assistantEvent(m + 180_000, 1, 2, 3),
      { type: 'user', timestamp: new Date(m + 200_000).toISOString() },
    ]) + 'garbage-line\n')
    const cached = parser.todayTotals()
    assert.deepEqual(cached, { tokens: 226, messages: 3 })
    // Cold instance (= unavoidable full scan) sees the same numbers.
    assert.deepEqual(fullScanTotals(fakeHome), cached)
    // Third poll without changes: stable (nothing double-counted).
    assert.deepEqual(parser.todayTotals(), cached)
  } finally { cleanup() }
})

test('todayTotals: new file appearing between polls is picked up', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const m = localMidnight()
    writeProjectFile(projectsDir, 'proj-a', 's1.jsonl', jsonl([assistantEvent(m + 60_000, 5, 5)]))
    assert.deepEqual(parser.todayTotals(), { tokens: 10, messages: 1 })
    writeProjectFile(projectsDir, 'proj-a', 's2.jsonl', jsonl([assistantEvent(m + 60_000, 1, 1)]))
    assert.deepEqual(parser.todayTotals(), { tokens: 12, messages: 2 })
  } finally { cleanup() }
})

test('todayTotals: rotated/shrunk file resets its cache entry', () => {
  const { parser, projectsDir, fakeHome, cleanup } = freshParser()
  try {
    const m = localMidnight()
    const fp = writeProjectFile(projectsDir, 'proj-rot', 's.jsonl', jsonl([
      assistantEvent(m + 60_000, 1_000, 1_000),
      assistantEvent(m + 70_000, 2_000, 2_000),
      assistantEvent(m + 80_000, 4_000, 4_000),
    ]))
    assert.deepEqual(parser.todayTotals(), { tokens: 14_000, messages: 3 })

    // Rotation: file replaced by a much smaller one.
    fs.writeFileSync(fp, jsonl([assistantEvent(m + 90_000, 7, 8)]))
    const after = parser.todayTotals()
    assert.deepEqual(after, { tokens: 15, messages: 1 })
    assert.deepEqual(fullScanTotals(fakeHome), after)
  } finally { cleanup() }
})

test('todayTotals: torn write — trailing line counts once, never twice', () => {
  const { parser, projectsDir, fakeHome, cleanup } = freshParser()
  try {
    const m = localMidnight()
    const fp = writeProjectFile(projectsDir, 'proj-torn', 's.jsonl',
      jsonl([assistantEvent(m + 60_000, 100, 100)]))
    assert.deepEqual(parser.todayTotals(), { tokens: 200, messages: 1 })

    // Complete JSON appended WITHOUT its newline yet: a whole-file scan
    // would count it, so the widget does too (transiently)...
    fs.appendFileSync(fp, JSON.stringify(assistantEvent(m + 120_000, 10, 20)))
    assert.deepEqual(parser.todayTotals(), { tokens: 230, messages: 2 })
    assert.deepEqual(fullScanTotals(fakeHome), { tokens: 230, messages: 2 })
    // ...and repeated polls must not double-count it.
    assert.deepEqual(parser.todayTotals(), { tokens: 230, messages: 2 })

    // The newline arrives, plus one more event: still counted exactly once.
    fs.appendFileSync(fp, '\n' + jsonl([assistantEvent(m + 180_000, 1, 2)]))
    const done = parser.todayTotals()
    assert.deepEqual(done, { tokens: 233, messages: 3 })
    assert.deepEqual(fullScanTotals(fakeHome), done)
    assert.deepEqual(parser.todayTotals(), done)
  } finally { cleanup() }
})

test('todayTotals: genuinely incomplete trailing fragment is ignored without crashing', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const m = localMidnight()
    const fp = writeProjectFile(projectsDir, 'proj-frag', 's.jsonl',
      jsonl([assistantEvent(m + 60_000, 10, 10)]))
    fs.appendFileSync(fp, '{"type":"assistant","message":{"usage":{"input_tokens":999')
    assert.deepEqual(parser.todayTotals(), { tokens: 20, messages: 1 })
    assert.deepEqual(parser.todayTotals(), { tokens: 20, messages: 1 })
  } finally { cleanup() }
})

test('todayTotals: empty projects dir yields zeros', () => {
  const { parser, cleanup } = freshParser()
  try {
    assert.deepEqual(parser.todayTotals(), { tokens: 0, messages: 0 })
  } finally { cleanup() }
})

// ---- timeSeries(): bucket boundary handling ----
// Rescued from agent/ideas-2026-07-11 and adapted (the transcript
// helper there used mangleCwd(), which is gone — the aggregators
// enumerate every project folder regardless of its name).

test('timeSeries: places tokens into the correct time bucket', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const now = Date.now()
    const hoursBack = 1
    const bucketMin = 10 // 6 buckets of 10 minutes across the 1h window
    const since = now - hoursBack * 3_600_000
    writeProjectFile(projectsDir, 'proj-series', 's.jsonl', jsonl([
      // First bucket (just after `since`; 5s slack so the window edge
      // computed inside scanSeries a moment later still contains it).
      assistantEvent(since + 5_000, 1_000, 0),
      // Last bucket (just before "now").
      assistantEvent(now - 1_000, 2_000, 0),
    ]))
    const { series } = parser.scanSeries(hoursBack, bucketMin)
    assert.equal(series.buckets.length, 6)
    assert.equal(series.buckets[0].tokens, 1_000)
    assert.equal(series.buckets[5].tokens, 2_000)
    assert.equal(series.buckets[0].rate, 1_000 / bucketMin)
    assert.equal(series.hoursBack, hoursBack)
    assert.equal(series.bucketMin, bucketMin)
  } finally { cleanup() }
})

test('timeSeries: events outside the window are excluded', () => {
  const { parser, projectsDir, cleanup } = freshParser()
  try {
    const now = Date.now()
    writeProjectFile(projectsDir, 'proj-series', 's.jsonl', jsonl([
      assistantEvent(now - 2 * 3_600_000, 9_000, 9_000),  // 2h ago — outside 1h window
      assistantEvent(now - 60_000, 10, 20),               // inside
    ]))
    const { series } = parser.scanSeries(1, 10)
    const total = series.buckets.reduce((s, b) => s + b.tokens, 0)
    assert.equal(total, 30)
  } finally { cleanup() }
})
