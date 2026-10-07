// Pure quota-period math (src/pace.js). No clock, no disk, no network:
// `now` is fixed and every period is synthetic.
const test = require('node:test')
const assert = require('node:assert/strict')
const pace = require('../src/pace.js')

const H = 3_600_000
const NOW = new Date(2026, 9, 7, 12, 0).getTime() // Mi 07.10.2026 12:00 local

test('half-way through 5h at 30% projects 60%, headroom arrow', () => {
  const a = pace.analyzePeriod({ utilization: 30, resetsAt: NOW + 2.5 * H }, '5h', NOW)
  assert.equal(a.elapsedFrac, 0.5)
  assert.equal(a.projected, 60)
  assert.equal(a.arrow, '↘')
  assert.equal(a.paceClass, 'good')
  assert.equal(a.severity, '')
  assert.equal(a.fullAt, null)
  assert.equal(pace.fmtProjected(a), '↘60%')
})

test('burning ahead of the clock: warn/crit by projection and ETA to 100%', () => {
  // 1h of 5h elapsed, 40% used -> 200% projected, full after 1.5h more.
  const a = pace.analyzePeriod({ utilization: 40, resetsAt: NOW + 4 * H }, '5h', NOW)
  assert.equal(a.severity, 'crit')
  assert.equal(a.paceClass, 'crit')
  assert.equal(a.fullAt, NOW + 1.5 * H)
  assert.equal(pace.fmtProjected(a), '↗>199%')

  const b = pace.analyzePeriod({ utilization: 55, resetsAt: NOW + 2 * H }, '5h', NOW)
  assert.ok(Math.abs(b.projected - 55 / 0.6) < 1e-9) // ~91.7
  assert.equal(b.severity, '')
  assert.equal(b.paceClass, 'even')
})

test('durationMs from the API wins over the label fallback', () => {
  const a = pace.analyzePeriod({ utilization: 10, resetsAt: NOW + 1 * H, durationMs: 2 * H }, '5h', NOW)
  assert.equal(a.elapsedFrac, 0.5)
})

test('edge cases: no reset, too early, over 100, unknown window', () => {
  const idle = pace.analyzePeriod({ utilization: 0, resetsAt: null }, '5h', NOW)
  assert.equal(idle.elapsedFrac, null)
  assert.equal(pace.fmtProjected(idle), '—')

  const early = pace.analyzePeriod({ utilization: 3, resetsAt: NOW + 4.9 * H }, '5h', NOW)
  assert.equal(early.projected, null)
  assert.equal(pace.fmtProjected(early), '…')

  const over = pace.analyzePeriod({ utilization: 104, resetsAt: NOW + 1 * H }, '5h', NOW)
  assert.equal(over.severity, 'crit')
  assert.equal(over.projected, null)
  assert.equal(over.fullAt, null)

  const unknown = pace.analyzePeriod({ utilization: 20, resetsAt: NOW + H }, 'Limit 2', NOW)
  assert.equal(unknown.elapsedFrac, null)
  assert.equal(unknown.resetsIn, H)

  // resetsIn larger than the window (clock skew) clamps to "just started".
  const skew = pace.analyzePeriod({ utilization: 5, resetsAt: NOW + 6 * H }, '5h', NOW)
  assert.equal(skew.elapsedFrac, 0)
  assert.equal(skew.projected, null)
})

test('formatting: clock with weekday once far out, remaining time', () => {
  assert.equal(pace.fmtClock(NOW + 2.5 * H, NOW), '14:30')
  assert.equal(pace.fmtClock(NOW + 45 * H, NOW), 'Fr 09:00')
  assert.equal(pace.fmtIn(30_000), 'jetzt')
  assert.equal(pace.fmtIn(42 * 60_000), 'in 42m')
  assert.equal(pace.fmtIn(2 * H + 5 * 60_000), 'in 2h05')
  assert.equal(pace.fmtIn(3 * 24 * H + 21 * H), 'in 3d21h')
  assert.equal(pace.fmtPct(42.4), '42%')
  assert.equal(pace.fmtPct(2.5), '2.5%')
})
