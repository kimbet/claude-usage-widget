// "MultiBrow" display mode: pure math + formatting, modelled on the iOS app
// MultiBrow (Sources/SiteUsage.swift, ContainerData.swift). Shared by the
// renderer (plain <script>, window.mbview) and node --test. No DOM, no clock
// reads: `now` is always passed in. Utilization is in percent (0..100).

(function (root) {
  const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 24 * 3_600_000 }

  // Zange ink densities (opacity on the foreground colour).
  const INK_USED = 0.42          // used share, from the bottom
  const INK_LEFT = 0.15          // remaining time, hanging from the top
  const INK_OVERLAP_MIN = 0.58   // smallest lead
  const OVERLAP_FULL = 0.30      // lead at which the overlap is opaque

  function windowLen(period, label) {
    return period.durationMs || WINDOW_MS[label] || null
  }

  // Share of the window's clock already elapsed, 0..1; null without reset/length.
  function elapsedFraction(period, label, now) {
    const len = windowLen(period, label)
    const resetsAt = period.resetsAt ?? null
    if (!len || len <= 0 || resetsAt == null) return null
    return Math.min(1, Math.max(0, (len - (resetsAt - now)) / len))
  }

  function utilOf(period) { return Math.max(0, Number(period.utilization) || 0) }

  function isAheadOfClock(util, elapsed) {
    return elapsed != null && util > elapsed * 100 + 10
  }

  function tint(util, elapsed) {
    if (util >= 85) return 'red'
    if (util >= 60) return 'orange'
    return isAheadOfClock(util, elapsed) ? 'yellow' : 'green'
  }

  function fmtPct(frac0to100) {
    return Math.round(Math.min(100, Math.max(0, frac0to100))) + ' %'
  }

  // Remaining time in words, max two units: "2 Std. 14 Min.", "3 Tg. 5 Std.".
  function fmtRemaining(ms) {
    const s = Math.max(0, ms) / 1000
    if (s < 60) return 'weniger als 1 Min.'
    const parts = []
    if (s >= 86400) {
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
      parts.push(`${d} Tg.`)
      if (h) parts.push(`${h} Std.`)
    } else {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
      if (h) parts.push(`${h} Std.`)
      if (m) parts.push(`${m} Min.`)
    }
    return parts.join(' ')
  }

  function fmtReset(period, now) {
    if (period.resetsAt == null) return ''
    return 'in ' + fmtRemaining(period.resetsAt - now)
  }

  function analyzeWindow(period, label, now) {
    const util = utilOf(period)
    const elapsed = elapsedFraction(period, label, now)
    return {
      label,
      util,
      elapsed,
      tint: tint(util, elapsed),
      ahead: isAheadOfClock(util, elapsed),
      usedText: fmtPct(util),
      elapsedText: elapsed == null ? '' : '· ' + fmtPct(elapsed * 100),
      resetText: fmtReset(period, now),
    }
  }

  function overlapInk(lead) {
    const t = Math.min(1, Math.max(0, lead) / OVERLAP_FULL)
    return INK_OVERLAP_MIN + (1 - INK_OVERLAP_MIN) * t
  }

  // One Zange lane as non-overlapping vertical zones (fractions of the lane
  // height, y from the top). null window -> empty outlined lane; unknown
  // reset -> outlined hollow chamber above the used block.
  function zangeLane(period, label, now) {
    if (!period) return { kind: 'empty' }
    const v = Math.min(1, utilOf(period) / 100)
    const e = elapsedFraction(period, label, now)
    if (e == null) {
      return { kind: 'outline', hollow: { y: 0, h: 1 - v }, used: { y: 1 - v, h: v, ink: INK_USED } }
    }
    const z = Math.min(1, Math.max(0, e))
    const lo = Math.min(v, z), hi = Math.max(v, z)
    return {
      kind: 'zones',
      left: { y: 0, h: 1 - hi, ink: INK_LEFT },
      overlap: { y: 1 - hi, h: hi - lo, ink: v > z ? overlapInk(v - z) : 0 },
      used: { y: 1 - lo, h: lo, ink: INK_USED },
    }
  }

  // Claude: short = 5h, long = 7d. `periods` is [{label, period}].
  // Codex: `limits` [{id, name, periods:[{label,...}]}] -> pair of the
  // highest-utilization bucket, sorted by window length.
  function pickLanes(entries) {
    const byLbl = l => entries.find(x => x.label === l)
    const p5 = byLbl('5h'), p7 = byLbl('7d')
    if (p5 || p7) return { short: p5 || null, long: p7 || null }
    const sorted = [...entries].sort((a, b) => (windowLen(a.period, a.label) || 0) - (windowLen(b.period, b.label) || 0))
    return { short: sorted[0] || null, long: sorted[1] || null }
  }

  function pickCodexLanes(limits) {
    let lead = null, leadUtil = -1
    for (const lim of limits || []) {
      for (const p of lim.periods || []) {
        if (utilOf(p) > leadUtil) { leadUtil = utilOf(p); lead = lim }
      }
    }
    if (!lead) return { short: null, long: null, limit: null }
    const pair = lead.periods.map(p => ({ label: p.label, period: p }))
      .sort((a, b) => (windowLen(a.period, a.label) || 0) - (windowLen(b.period, b.label) || 0))
    return { short: pair[0] || null, long: pair[1] || null, limit: lead }
  }

  // Claude only: the known window that has no value right now.
  function missingKnown(labels) {
    const has5 = labels.includes('5h'), has7 = labels.includes('7d')
    if (has7 && !has5) return '5h'
    if (has5 && !has7) return '7d'
    return null
  }

  const api = {
    INK_USED, INK_LEFT, INK_OVERLAP_MIN, OVERLAP_FULL,
    elapsedFraction, isAheadOfClock, tint, fmtPct, fmtRemaining, fmtReset,
    analyzeWindow, overlapInk, zangeLane, pickLanes, pickCodexLanes, missingKnown,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.mbview = api
})(this)
