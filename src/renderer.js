// Renderer. Polls window.widget on three independent cadences — today
// totals (30 s), throughput chart (30 s), subscription quota (60 s) —
// and renders DOM from the returned snapshots. Stays dumb on purpose:
// no framework, no animation logic beyond CSS. The cadences are slow
// because the underlying numbers move slowly and every totals/series
// poll costs (cached, incremental) disk reads in the preload.

const $totals   = document.getElementById('totals')
const $scanned  = document.getElementById('scanned')

document.getElementById('menu').addEventListener('click', () => {
  window.widget.openContextMenu()
})

// Format integers as "1.2k", "12.4k", "1.2M".
function fmtTokens(n) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M'
}

// "3m ago", "12s ago", "1h ago"
function fmtAgo(ms) {
  if (ms < 60_000) return Math.floor(ms / 1000) + 's'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm'
  return (ms / 3_600_000).toFixed(1) + 'h'
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

async function refreshTotals() {
  let snap
  try { snap = await window.widget.todayTotals() } catch (e) {
    return
  }

  $scanned.textContent = new Date(snap.scannedAt).toLocaleTimeString()

  const t = snap.totals
  $totals.innerHTML = `
    <span>Today: ${fmtTokens(t.tokens)}</span>
    <span>${t.messages} msg</span>
  `
  fitHeight()
}

// Window fits its content height: with the per-session context-window
// list gone, a fixed window would leave dead space below the quota. Ask
// main to size the window to the rendered content instead.
let lastFitH = 0
function fitHeight() {
  requestAnimationFrame(() => {
    const h = document.body.offsetHeight
    if (h && Math.abs(h - lastFitH) > 2) {
      lastFitH = h
      window.widget.resizeContent(h)
    }
  })
}

// Totals mutate on every assistant reply, but the display only shows
// two coarse numbers — 30 s is plenty, and each poll beyond the first
// only reads what was appended to the transcripts since the last one.
refreshTotals()
setInterval(refreshTotals, 30_000)

// Chart — 5-minute buckets can't visibly change faster than this.
const SVG_NS = 'http://www.w3.org/2000/svg'
const $chart = document.getElementById('chart')
const $peak  = document.getElementById('chart-peak')

function renderChart(series) {
  const buckets = series.buckets
  if (!buckets.length) return
  const W = 200, H = 40
  const n = buckets.length

  // Cap the y-axis at the 95th-percentile rate. Without capping a
  // single session-start cache_creation spike (200k+ tok/min) crushes
  // the rest of the chart. We still draw spikes — they just clip at
  // the top of the panel — but the visible scale stays informative.
  const sorted = buckets.map(b => b.rate).sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  const maxRate = Math.max(p95, ...sorted.slice(-3)) // include top 3 in case of all-zero
  const yMax = Math.max(maxRate, 1)

  $peak.textContent = `peak ${fmtTokens(Math.round(Math.max(...sorted)))} tok/min`

  // x = bucket centre; first bucket at x=0, last bucket at x=W
  const xOf = i => (n === 1) ? W : (i / (n - 1)) * W
  const yOf = rate => H - Math.min(H, (rate / yMax) * H)

  // Polyline path
  let line = ''
  for (let i = 0; i < n; i++) {
    line += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(2) + ',' + yOf(buckets[i].rate).toFixed(2)
  }
  // Filled area under the line, closed back at baseline
  const area = line + `L${W},${H} L0,${H} Z`

  $chart.innerHTML = `
    <defs>
      <linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"  stop-color="#60a5fa" />
        <stop offset="100%" stop-color="#60a5fa" stop-opacity="0" />
      </linearGradient>
    </defs>
    <line class="axis" x1="0" y1="${H}" x2="${W}" y2="${H}" />
    <path  class="area" d="${area}" />
    <path  class="line" d="${line}" />
    <line  class="now"  x1="${W - 0.5}" y1="0" x2="${W - 0.5}" y2="${H}" />
  `
}

async function refreshChart() {
  try {
    const snap = await window.widget.scanSeries(4, 5)
    renderChart(snap.series)
    fitHeight()
  } catch (e) {
    // swallow — chart is non-critical
  }
}
refreshChart()
setInterval(refreshChart, 30_000)

// Subscription quota — Anthropic OAuth /api/oauth/usage endpoint.
// Updates much more slowly than session data; poll every 60 s.
const $quota = document.getElementById('quota')

function fmtResetIn(ms) {
  if (ms == null) return ''
  if (ms <= 0) return 'now'
  if (ms < 60_000) return Math.floor(ms / 1000) + 's'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return m === 0 ? `${h}h` : `${h}h${m}m`
}

function severityPct(pct) {
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return ''
}

// Length of each rolling window, so we can show how far through the
// current window we are by TIME — a second, thinner bar under the
// utilization bar. Compare the two at a glance: if the usage bar is
// ahead of the time bar you're burning faster than the clock; if it's
// behind, you have headroom.
const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 24 * 3_600_000 }

function renderQuotaRow(label, period) {
  if (!period) return ''
  const pct = period.utilization || 0
  const sev = severityPct(pct)

  const winMs = WINDOW_MS[label]
  let timePct = null
  if (winMs && period.resetsInMs != null) {
    timePct = Math.max(0, Math.min(100, (1 - period.resetsInMs / winMs) * 100))
  }
  const timeBar = timePct == null ? '' : `
      <div class="qtime" title="Zeit im ${label}-Fenster verstrichen">
        <span></span>
        <span class="qtrack"><span class="qtfill" style="width:${timePct.toFixed(1)}%"></span></span>
        <span class="qtpct">${Math.round(timePct)}%</span>
        <span class="qtlbl">Zeit</span>
      </div>`

  return `
    <div class="qgroup ${sev}">
      <div class="qrow">
        <span class="qlbl">${label}</span>
        <span class="qbar"><span style="width:${Math.min(100, pct)}%"></span></span>
        <span class="qpct">${pct}%</span>
        <span class="qreset" title="${period.resetsAt ? new Date(period.resetsAt).toLocaleString() : ''}">${fmtResetIn(period.resetsInMs)}</span>
      </div>${timeBar}
    </div>
  `
}

// Per-account last-good cache. On a transient error (network blip, token
// refresh in flight, rate limit) we keep showing THAT account's last good
// numbers rather than blanking it — the numbers move slowly, so a slightly
// stale value beats an error. Other accounts are unaffected.
const lastGood = new Map()  // name -> quota result

function renderAccountQuota(name, q) {
  let stale = false
  if (!q || q.error) {
    const prev = lastGood.get(name)
    if (prev) { q = prev; stale = true }
    else {
      return `<div class="qacc err"><span class="qname">${escape(name)}</span>`
        + `<div class="err">${escape((q && (q.message || q.error)) || 'no data')}</div></div>`
    }
  } else {
    lastGood.set(name, q)
  }
  const staleTag = stale && q.fetchedAt
    ? `<div class="qstale">stale · ${fmtAgo(Date.now() - q.fetchedAt)} ago</div>` : ''
  return `<div class="qacc${stale ? ' stale' : ''}">`
    + `<span class="qname">${escape(name)}</span>`
    + renderQuotaRow('5h', q.fiveHour) + renderQuotaRow('7d', q.sevenDay)
    + staleTag + `</div>`
}

async function refreshQuota() {
  let all
  try { all = await window.widget.fetchAllQuota() } catch (e) {
    $quota.innerHTML = `<div class="err">quota: ${escape(e.message)}</div>`
    return
  }
  if (!all.accounts || !all.accounts.length) {
    $quota.innerHTML = `<div class="empty">no accounts</div>`
    return
  }
  $quota.innerHTML = all.accounts.map(a => renderAccountQuota(a.name, a.quota)).join('')
  fitHeight()
}
refreshQuota()
setInterval(refreshQuota, 60_000)
