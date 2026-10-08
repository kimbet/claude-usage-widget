// MultiBrow display mode math (src/mbview.js). No clock, no disk, no network:
// `now` is fixed and every period is synthetic.
const test = require('node:test')
const assert = require('node:assert/strict')
const mb = require('../src/mbview.js')

const H = 3_600_000
const NOW = new Date(2026, 9, 7, 12, 0).getTime()

test('row: rounded used %, elapsed share, reset in words', () => {
  const a = mb.analyzeWindow({ utilization: 41.6, resetsAt: NOW + 2 * H + 14 * 60_000 }, '5h', NOW)
  assert.equal(a.usedText, '42 %')
  assert.ok(Math.abs(a.elapsed - (5 * H - (2 * H + 14 * 60_000)) / (5 * H)) < 1e-12)
  assert.equal(a.elapsedText, '· 55 %')
  assert.equal(a.resetText, 'in 2 Std. 14 Min.')
  assert.equal(a.tint, 'green')
  assert.equal(a.ahead, false)
})

test('elapsed is clamped and null without reset or length', () => {
  assert.equal(mb.elapsedFraction({ resetsAt: NOW + 10 * H }, '5h', NOW), 0)
  assert.equal(mb.elapsedFraction({ resetsAt: NOW - H }, '5h', NOW), 1)
  assert.equal(mb.elapsedFraction({ utilization: 5 }, '5h', NOW), null)
  assert.equal(mb.elapsedFraction({ resetsAt: NOW + H }, 'Limit 1', NOW), null)
  assert.equal(mb.elapsedFraction({ resetsAt: NOW + H, durationMs: 2 * H }, 'x', NOW), 0.5)
  const a = mb.analyzeWindow({ utilization: 5 }, '5h', NOW)
  assert.equal(a.elapsedText, '')
  assert.equal(a.resetText, '')
})

test('tint: red >=85, orange >=60, yellow when >10 pts ahead, else green', () => {
  assert.equal(mb.tint(85, 0.9), 'red')
  assert.equal(mb.tint(60, 0.9), 'orange')
  assert.equal(mb.tint(41, 0.3), 'yellow')
  assert.equal(mb.tint(40, 0.3), 'green')   // exactly +10 is not ahead
  assert.equal(mb.tint(50, null), 'green')
  assert.equal(mb.isAheadOfClock(41, 0.3), true)
})

test('remaining time in words: max two units, days+hours, < 1 min', () => {
  assert.equal(mb.fmtRemaining(59_000), 'weniger als 1 Min.')
  assert.equal(mb.fmtRemaining(-5), 'weniger als 1 Min.')
  assert.equal(mb.fmtRemaining(5 * 60_000), '5 Min.')
  assert.equal(mb.fmtRemaining(3 * H), '3 Std.')
  assert.equal(mb.fmtRemaining(2 * H + 14 * 60_000 + 30_000), '2 Std. 14 Min.')
  assert.equal(mb.fmtRemaining(3 * 24 * H + 5 * H + 40 * 60_000), '3 Tg. 5 Std.')
  assert.equal(mb.fmtRemaining(24 * H + 59_000), '1 Tg.')
})

test('zange lane: three non-overlapping zones, overlap ink by lead', () => {
  // used 75 %, elapsed 25 % -> lead 0.5 -> full ink
  const z = mb.zangeLane({ utilization: 75, resetsAt: NOW + 3.75 * H }, '5h', NOW)
  assert.equal(z.kind, 'zones')
  assert.ok(Math.abs(z.left.h - 0.25) < 1e-12)
  assert.ok(Math.abs(z.overlap.h - 0.5) < 1e-12)
  assert.ok(Math.abs(z.used.h - 0.25) < 1e-12)
  assert.equal(z.overlap.ink, 1)
  assert.equal(z.left.ink, 0.15)
  assert.equal(z.used.ink, 0.42)
  // gap (time ahead of usage) -> no ink in the middle zone
  const g = mb.zangeLane({ utilization: 20, resetsAt: NOW + 2.25 * H }, '5h', NOW)
  assert.equal(g.overlap.ink, 0)
  assert.ok(Math.abs(g.used.h - 0.2) < 1e-12)
  // small lead scales from 0.58
  assert.ok(Math.abs(mb.overlapInk(0.15) - (0.58 + 0.42 * 0.5)) < 1e-12)
  assert.equal(mb.overlapInk(0), 0.58)
  // unknown reset -> outline; missing window -> empty lane
  assert.equal(mb.zangeLane({ utilization: 30 }, '5h', NOW).kind, 'outline')
  assert.equal(mb.zangeLane(null, '5h', NOW).kind, 'empty')
})

test('lanes and missing known window', () => {
  const e7 = [{ label: '7d', period: { utilization: 10 } }]
  assert.deepEqual(mb.pickLanes(e7), { short: null, long: e7[0] })
  assert.equal(mb.missingKnown(['7d']), '5h')
  assert.equal(mb.missingKnown(['5h']), '7d')
  assert.equal(mb.missingKnown(['5h', '7d']), null)
  assert.equal(mb.missingKnown([]), null)
})

test('codex compact lanes: highest-utilization bucket and its sibling', () => {
  const limits = [
    { id: 'codex', name: 'Codex', periods: [
      { label: '7d', utilization: 20, durationMs: 7 * 24 * H },
      { label: '5h', utilization: 30, durationMs: 5 * H },
    ] },
    { id: 'other', name: 'Spark', periods: [
      { label: '5h', utilization: 70, durationMs: 5 * H },
      { label: '7d', utilization: 10, durationMs: 7 * 24 * H },
    ] },
  ]
  const l = mb.pickCodexLanes(limits)
  assert.equal(l.limit.id, 'other')
  assert.equal(l.short.period.utilization, 70)
  assert.equal(l.long.period.utilization, 10)
  assert.deepEqual(mb.pickCodexLanes([]), { short: null, long: null, limit: null })
})
