// Unit tests for the pure parts of src/quota.js — the quota-percent /
// reset-window flattening logic (shapePeriod). Deliberately does not
// touch fetchQuota()/network/credentials — that's an I/O boundary, not
// calculation logic.
//
// Rescued from agent/ideas-2026-07-11 and adapted to the current code.

const test = require('node:test')
const assert = require('node:assert/strict')
const { shapePeriod } = require('../src/quota.js')

test('shapePeriod: null period passes through as null', () => {
  assert.equal(shapePeriod(null), null)
  assert.equal(shapePeriod(undefined), null)
})

test('shapePeriod: flattens utilization and computes resetsAt/resetsInMs', () => {
  const now = Date.parse('2026-07-11T12:00:00Z')
  const period = { utilization: 42, resets_at: '2026-07-11T17:00:00Z' }
  const shaped = shapePeriod(period, now)
  assert.equal(shaped.utilization, 42)
  assert.equal(shaped.resetsAt, Date.parse('2026-07-11T17:00:00Z'))
  assert.equal(shaped.resetsInMs, 5 * 3_600_000)
})

test('shapePeriod: missing utilization defaults to 0', () => {
  const shaped = shapePeriod({ resets_at: '2026-07-11T17:00:00Z' }, Date.parse('2026-07-11T12:00:00Z'))
  assert.equal(shaped.utilization, 0)
})

test('shapePeriod: missing resets_at yields null resetsAt/resetsInMs', () => {
  const shaped = shapePeriod({ utilization: 10 }, Date.now())
  assert.equal(shaped.resetsAt, null)
  assert.equal(shaped.resetsInMs, null)
})

test('shapePeriod: a reset time already in the past clamps resetsInMs to 0', () => {
  const now = Date.parse('2026-07-11T12:00:00Z')
  const period = { utilization: 100, resets_at: '2026-07-11T11:00:00Z' } // 1h ago
  const shaped = shapePeriod(period, now)
  assert.equal(shaped.resetsInMs, 0)
})

test('shapePeriod: utilization over 100 (extra usage) passes through unclamped', () => {
  const shaped = shapePeriod({ utilization: 137 }, Date.now())
  assert.equal(shaped.utilization, 137)
})
