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
