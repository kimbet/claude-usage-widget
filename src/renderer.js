// Renderer. Polls window.widget independently for Claude today totals
// (30 s), throughput chart (30 s), and Claude/Codex subscription quotas (60 s),
// and renders DOM from the returned snapshots. Stays dumb on purpose:
// no framework, no animation logic beyond CSS. The cadences are slow
// because the underlying numbers move slowly and every totals/series
// poll costs (cached, incremental) disk reads in the preload.

const $totals   = document.getElementById('totals')
const $scanned  = document.getElementById('scanned')

const $menu = document.getElementById('menu')
$menu.addEventListener('click', () => {
  window.widget.openContextMenu()
})

// Click-through: main decides when the title bar takes the mouse (it
// polls the cursor against the bar's height) and tells us for the hover
// look. The rest of the panel never takes clicks.
const $drag = document.getElementById('drag')
window.widget.headerHeight($drag.getBoundingClientRect().bottom)
let overHeader = false
window.widget.onHeaderHot(on => {
  overHeader = on
  $drag.classList.toggle('hot', on)
  if (on) document.body.classList.remove('peek')
})

// See-through spotlight: around the pointer the panel fades out, so the
// click target underneath is visible. Off over the title bar (that one
// takes the click) and while unlocked for resizing.
const rootStyle = document.documentElement.style
document.addEventListener('mousemove', e => {
  rootStyle.setProperty('--mx', e.clientX + 'px')
  rootStyle.setProperty('--my', e.clientY + 'px')
  document.body.classList.toggle('peek', !overHeader && !e.target.closest('#drag'))
})
document.addEventListener('mouseleave', () => document.body.classList.remove('peek'))
window.widget.onUnlocked(on => document.body.classList.toggle('unlocked', on))

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
  $totals.innerHTML = `heute <b>${fmtTokens(t.tokens)}</b> tok · <b>${t.messages}</b> msg`
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
const $rate  = document.getElementById('rate')

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

  const nowRate = Math.round(buckets[n - 1].rate)
  $rate.innerHTML = `jetzt <b>${fmtTokens(nowRate)}</b>/min · peak <b>${fmtTokens(Math.round(sorted[n - 1]))}</b> · 4h`

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

// One grid row per period: label | usage bar with pace tick | used % |
// projected % at reset | absolute reset clock + remaining time. Math and
// formatting live in pace.js (unit-tested). Everything must be readable
// without hovering — the widget is click-through, tooltips never show.
function renderQuotaRow(label, period, now) {
  if (!period) return ''
  const a = pace.analyzePeriod(period, label, now)
  const fillPct = Math.min(100, a.util)
  const tick = a.elapsedFrac == null ? ''
    : `<span class="qtick" style="left:${(a.elapsedFrac * 100).toFixed(1)}%"></span>`
  // Hatched extension from the fill to where the current burn would end.
  const ghost = a.projected == null || a.projected <= a.util ? ''
    : `<span class="qghost" style="left:${fillPct.toFixed(1)}%;width:${(Math.min(100, a.projected) - fillPct).toFixed(1)}%"></span>`
  let clock = '—', sub = ''
  if (a.resetsIn != null) {
    clock = a.resetsIn < 60_000 ? 'jetzt' : pace.fmtClock(a.resetsAt, now)
    sub = a.fullAt != null
      ? `<i class="full">voll ${pace.fmtClock(a.fullAt, now)}</i>`
      : `<i>${pace.fmtIn(a.resetsIn)}</i>`
  }
  return `<div class="qrow ${a.severity}${a.util === 0 ? ' idle' : ''}">`
    + `<span class="qlbl">${escape(label)}</span>`
    + `<span class="qbar"><span class="qcap"><span class="qfill" style="width:${fillPct.toFixed(1)}%"></span>${ghost}</span>${tick}</span>`
    + `<span class="qpct">${pace.fmtPct(a.util)}</span>`
    + `<span class="qpace ${a.paceClass}">${pace.fmtProjected(a)}</span>`
    + `<span class="qreset"><b>${clock}</b>${sub}</span>`
    + `</div>`
}

// Account block: name column spans all of the account's period rows.
function renderBlock(name, rows, extra = '', staleNote = '') {
  const n = Math.max(1, rows.length)
  return `<div class="qacc"><span class="qname" style="grid-row:span ${n}">${escape(name)}`
    + (staleNote ? `<small>${staleNote}</small>` : '') + `</span>`
    + rows.join('') + extra + `</div>`
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
  const now = Date.now()
  const rows = [renderQuotaRow('5h', q.fiveHour, now), renderQuotaRow('7d', q.sevenDay, now)].filter(Boolean)
  const staleNote = stale && q.fetchedAt ? `⟳ ${fmtAgo(now - q.fetchedAt)}` : ''
  return renderBlock(name, rows, '', staleNote)
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

// Keep Codex separate from Claude's account names and last-good values.
const $codexQuota = document.getElementById('codex-quota')
const $codexPlan = document.getElementById('codex-plan')
let codexBusy = false
let codexLastGood = null

async function refreshCodexQuota() {
  if (codexBusy) return
  codexBusy = true
  try {
    let q
    try { q = await window.widget.fetchCodexQuota() }
    catch { q = { error: 'connection', message: 'Codex-Nutzung konnte nicht abgerufen werden.' } }
    const problem = q.error ? q.message : null
    if (q.error) {
      // After logout or an incompatible account, never retain another account's limits.
      if (['auth', 'unavailable', 'missing_cli'].includes(q.error)) codexLastGood = null
      if (!codexLastGood) {
        $codexPlan.textContent = ''
        $codexQuota.innerHTML = `<div class="err">${escape(problem || 'Keine Daten')}</div>`
        return
      }
      q = codexLastGood
    } else {
      codexLastGood = q
    }
    $codexPlan.textContent = q.plan ? `· ${q.plan}` : ''
    const now = Date.now()
    const staleNote = problem ? `⟳ ${fmtAgo(now - q.fetchedAt)}` : ''
    $codexQuota.innerHTML = q.limits.map((limit, i) => renderBlock(
      q.limits.length > 1 || limit.id !== 'codex' ? limit.name : 'Codex',
      limit.periods.map(period => renderQuotaRow(period.label, period, now)),
      limit.unlimited && !limit.periods.length ? '<div class="qnote">Unbegrenztes Kontingent</div>' : '',
      i === 0 ? staleNote : '',
    )).join('')
  } finally {
    codexBusy = false
    fitHeight()
  }
}
refreshCodexQuota()
setInterval(refreshCodexQuota, 60_000)
