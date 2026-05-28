// Renderer. Polls window.widget.scan() every 2s, renders DOM from the
// returned snapshot. Stays dumb on purpose: no caching, no animation
// logic beyond CSS, no event coalescing. Performance is fine because
// the snapshot is tiny (~N sessions × ~10 numbers) and parser.js does
// the heavy lifting once per tick.

const $sessions = document.getElementById('sessions')
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

function severity(pct) {
  if (pct >= 90) return 'crit'
  if (pct >= 70) return 'warn'
  return ''
}

function renderSession(s) {
  const el = document.createElement('div')
  const sev = severity(s.ctxPct)
  el.className = ['session', s.status === 'busy' ? 'busy' : 'idle', sev].filter(Boolean).join(' ')

  const statusLabel = s.status === 'busy'
    ? 'busy'
    : (s.idleMs > 1000 ? `idle ${fmtAgo(s.idleMs)}` : 'idle')

  el.innerHTML = `
    <div class="row1">
      <span class="dot"></span>
      <span class="name" title="${escape(s.cwd || '')}">${escape(s.name)}</span>
      <span class="status">${statusLabel}</span>
    </div>
    <div class="bar"><span style="width: ${Math.min(100, s.ctxPct).toFixed(1)}%"></span></div>
    <div class="row2">
      <span class="ctx">${fmtTokens(s.ctxSize)} / ${fmtTokens(s.ctxLimit)} (${s.ctxPct.toFixed(0)}%)</span>
      <span class="rate">${s.tokensPerMin > 0 ? fmtTokens(Math.round(s.tokensPerMin)) + ' tok/min' : '—'}</span>
    </div>
  `
  return el
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

async function refresh() {
  let snap
  try { snap = await window.widget.scan() } catch (e) {
    $sessions.innerHTML = `<div class="empty">scan error: ${escape(e.message)}</div>`
    return
  }

  $scanned.textContent = new Date(snap.scannedAt).toLocaleTimeString()

  if (snap.sessions.length === 0) {
    $sessions.innerHTML = '<div class="empty">no active sessions</div>'
  } else {
    $sessions.replaceChildren(...snap.sessions.map(renderSession))
  }

  const t = snap.totals
  $totals.innerHTML = `
    <span>Today: ${fmtTokens(t.tokens)}</span>
    <span>${t.messages} msg</span>
  `
}

refresh()
setInterval(refresh, 2000)

// Chart — separate cadence because the bucket data only mutates every
// few minutes; polling it on the 2-second loop is wasted I/O.
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
  } catch (e) {
    // swallow — chart is non-critical
  }
}
refreshChart()
setInterval(refreshChart, 10_000)

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

function fmtResetAt(t) {
  if (!t) return ''
  const d = new Date(t)
  // Today → HH:MM, otherwise DD.MM
  const today = new Date(); today.setHours(0,0,0,0)
  const isToday = d.getTime() < today.getTime() + 86_400_000
  return isToday
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

function severityPct(pct) {
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return ''
}

function renderQuotaRow(label, period) {
  if (!period) return ''
  const pct = period.utilization || 0
  const sev = severityPct(pct)
  return `
    <div class="qrow ${sev}">
      <span class="qlbl">${label}</span>
      <span class="qbar"><span style="width:${Math.min(100, pct)}%"></span></span>
      <span class="qpct">${pct}%</span>
      <span class="qreset" title="${period.resetsAt ? new Date(period.resetsAt).toLocaleString() : ''}">${fmtResetIn(period.resetsInMs)}</span>
    </div>
  `
}

async function refreshQuota() {
  let q
  try { q = await window.widget.fetchQuota() } catch (e) {
    $quota.innerHTML = `<div class="err">quota: ${escape(e.message)}</div>`
    return
  }
  if (q.error) {
    $quota.innerHTML = `<div class="err">${escape(q.message || q.error)}</div>`
    return
  }
  $quota.innerHTML = renderQuotaRow('5h', q.fiveHour) + renderQuotaRow('7d', q.sevenDay)
}
refreshQuota()
setInterval(refreshQuota, 60_000)
