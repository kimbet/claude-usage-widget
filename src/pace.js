// Pure quota-period math + formatting, shared by the renderer (plain
// <script>, exposes window.pace) and node --test (module.exports). No DOM,
// no clock reads: `now` is always passed in.

(function (root) {
  const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 24 * 3_600_000 }
  // Extrapolating from the first ~5% of a window is noise, not a forecast.
  const MIN_ELAPSED_FRAC = 0.05

  function analyzePeriod(period, label, now) {
    const util = Math.max(0, Number(period.utilization) || 0)
    const winMs = period.durationMs || WINDOW_MS[label] || null
    const resetsAt = period.resetsAt ?? null
    const resetsIn = resetsAt != null ? Math.max(0, resetsAt - now) : null

    let elapsedFrac = null, elapsedMs = null
    if (winMs && resetsIn != null && resetsIn > 0) {
      elapsedMs = Math.max(0, Math.min(winMs, winMs - resetsIn))
      elapsedFrac = elapsedMs / winMs
    }

    // projected = utilization at reset if the current average burn holds.
    let projected = null
    if (elapsedFrac != null && elapsedFrac >= MIN_ELAPSED_FRAC && util < 100) {
      projected = util / elapsedFrac
    }
    const paceTooEarly = elapsedFrac != null && elapsedFrac < MIN_ELAPSED_FRAC && util < 100

    // When does the same burn rate hit 100%? Only relevant before reset.
    let fullAt = null
    if (projected != null && util > 0 && projected >= 100) {
      const eta = now + ((100 - util) / util) * elapsedMs
      if (eta < resetsAt) fullAt = eta
    }

    let arrow = '→'
    if (elapsedFrac != null) {
      const ePct = elapsedFrac * 100
      if (util > ePct + 5) arrow = '↗'
      else if (util < ePct - 5) arrow = '↘'
    }

    let severity = ''
    if (util >= 90 || (projected != null && projected >= 120)) severity = 'crit'
    else if (util >= 75 || (projected != null && projected >= 100)) severity = 'warn'

    let paceClass = ''
    if (projected != null) {
      paceClass = projected >= 120 ? 'crit' : projected >= 100 ? 'warn'
        : projected >= 85 ? 'even' : 'good'
    }

    return { util, winMs, resetsAt, resetsIn, elapsedFrac, projected, paceTooEarly, fullAt, arrow, severity, paceClass }
  }

  function pad2(n) { return String(n).padStart(2, '0') }
  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

  // Absolute clock time; prefixed with the weekday once it is a day or so out.
  function fmtClock(ts, now) {
    const d = new Date(ts)
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    return ts - now >= 20 * 3_600_000 ? `${WEEKDAYS[d.getDay()]} ${hm}` : hm
  }

  function fmtIn(ms) {
    if (ms < 60_000) return 'jetzt'
    if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000)
      return `in ${h}h${pad2(Math.floor((ms % 3_600_000) / 60_000))}`
    }
    return `in ${Math.floor(ms / 86_400_000)}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`
  }

  function fmtPct(util) {
    return util < 10 && util % 1 ? util.toFixed(1) + '%' : Math.round(util) + '%'
  }

  function fmtProjected(a) {
    if (a.projected == null) return a.paceTooEarly ? '…' : '—'
    return a.arrow + (a.projected > 199 ? '>199' : Math.round(a.projected)) + '%'
  }

  const api = { WINDOW_MS, analyzePeriod, fmtClock, fmtIn, fmtPct, fmtProjected }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.pace = api
})(this)
