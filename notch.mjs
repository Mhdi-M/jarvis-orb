'use strict'
/* Jarvis monitoring notch — a macOS-style capsule at the top of the screen.
   Hover opens the panel; the wheel switches widget pages; it hides whenever
   the orb window is on screen. */

import { createViz, mediaUrl, isAudio } from './viz.mjs'
import { PRESETS, MAX_ZONES, addZone, removeZone, normalizeZones, zoneTime, dayOffset, labelFor } from './lib/timezones.mjs'

const $ = (id) => document.getElementById(id)
const api = window.notch
const fmt = (v, u = '') => (v == null ? 'n/a' : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${u}`)
const GB = (b) => (b == null ? null : b / 1024 ** 3)

/* ----------------------------------------------------------------- clock -- */
$('clock').innerHTML = '<span id="clock-h">--</span><span class="colon">:</span><span id="clock-m">--</span>'

function tick() {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  $('clock-h').textContent = hh
  $('clock-m').textContent = mm
  $('pill-time').textContent = hh + ':' + mm
  $('date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}
/* ---------------------------------------------------------- world clocks -- */
let zones = []
try { zones = normalizeZones(localStorage.getItem('jarvis.tz')) } catch {}

function saveZones() {
  try { localStorage.setItem('jarvis.tz', JSON.stringify(zones)) } catch {}
}

function renderZones() {
  const box = $('tzs')
  if (!box) return
  box.innerHTML = ''
  const now = new Date()
  for (const tz of zones) {
    const row = document.createElement('div')
    row.className = 'tz'
    row.title = 'click to remove ' + labelFor(tz)
    const dot = document.createElement('i')
    const name = document.createElement('span')
    name.textContent = labelFor(tz)
    const time = document.createElement('b')
    time.textContent = zoneTime(now, tz)
    const off = dayOffset(now, tz)
    row.append(dot, name, time)
    if (off !== 0) {
      const em = document.createElement('em')
      em.textContent = (off > 0 ? '+' : '') + off + 'd'
      row.appendChild(em)
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      zones = removeZone(zones, tz)
      saveZones()
      renderZones()
    })
    box.appendChild(row)
  }
}

function renderTzMenu() {
  const menu = $('tzmenu')
  menu.innerHTML = ''
  for (const p of PRESETS) {
    if (zones.includes(p.tz)) continue
    const b = document.createElement('button')
    b.textContent = p.label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      zones = addZone(zones, p.tz, MAX_ZONES)
      saveZones()
      renderZones()
      renderTzMenu()
      if (zones.length >= MAX_ZONES) menu.hidden = true
    })
    menu.appendChild(b)
  }
  if (!menu.children.length) {
    const b = document.createElement('button')
    b.textContent = 'all zones added'
    b.disabled = true
    menu.appendChild(b)
  }
}

$('tz-add').addEventListener('click', (e) => {
  e.stopPropagation()
  renderTzMenu()
  const menu = $('tzmenu')
  menu.hidden = !menu.hidden
})

document.addEventListener('click', (e) => {
  const menu = $('tzmenu')
  if (menu.hidden) return
  if (menu.contains(e.target) || e.target === $('tz-add')) return
  menu.hidden = true
})

tick()
renderZones()
setInterval(() => { tick(); renderZones() }, 5000)

async function paintUptime() {
  let secs = 0
  try { secs = await api.uptime() } catch { return }
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const el = $('uptime')
  if (el) el.textContent = 'up ' + (d ? d + 'd ' : '') + h + 'h ' + String(m).padStart(2, '0') + 'm'
}
paintUptime()
setInterval(paintUptime, 60000)

/* --------------------------------------------------------------- toast --- */
const ICONS = {
  copy: '<path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9z"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  shot: '<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.2"/><path d="M8 6l1.5-2h5L16 6"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="2.6"/><circle cx="16" cy="16" r="2.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
}

let toastTimer = null

function notify(payload) {
  if (!payload) return
  const kind = payload.kind || 'info'
  const t = $('toast')
  t.dataset.kind = kind
  $('t-ico').innerHTML = '<svg viewBox="0 0 24 24">' + (ICONS[kind] || ICONS.info) + '</svg>'
  $('t-title').textContent = payload.title || kind
  $('t-detail').textContent = payload.detail || ''
  t.classList.add('show')
  document.body.classList.add('notif')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    t.classList.remove('show')
    // only drop the shift if no other toast took over in the meantime
    setTimeout(() => {
      if (!t.classList.contains('show')) document.body.classList.remove('notif')
    }, 260)
  }, 3800)
}

api.onNotify((payload) => {
  notify(payload)
  if (payload && payload.kind === 'copy') loadClips()
})

/* ------------------------------------------------------------- paging ---- */
const PAGES = [...document.querySelectorAll('.page')]
let page = 0
let wheelLock = 0

const dots = $('dots')
PAGES.forEach((_, i) => {
  const d = document.createElement('i')
  d.addEventListener('click', () => goTo(i))
  dots.appendChild(d)
})

function goTo(i) {
  page = Math.max(0, Math.min(PAGES.length - 1, i))
  $('pages').style.transform = `translateX(-${page * 100}%)`
  PAGES.forEach((p, k) => p.classList.toggle('active', k === page))
  ;[...dots.children].forEach((d, k) => d.classList.toggle('on', k === page))
  if (page === 1) loadWeather(false)
  if (page === 2) loadNetwork(true)
  if (page === 3) loadClips()
}
goTo(0)

$('panel').addEventListener('wheel', (e) => {
  const dy = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
  if (Math.abs(dy) < 4) return
  e.preventDefault()
  const now = Date.now()
  if (now - wheelLock < 380) return
  wheelLock = now
  goTo(page + (dy > 0 ? 1 : -1))
}, { passive: false })

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { collapse(); api.hover(false); return }
  if (!open) return
  if (e.key === 'ArrowRight') goTo(page + 1)
  if (e.key === 'ArrowLeft') goTo(page - 1)
})

/* ------------------------------------------------------- expand / collapse - */
let open = false
let hovering = false
let closeTimer = null

function expand() {
  if (open) return
  open = true
  document.body.classList.add('open')
  PAGES[page].classList.remove('active')
  requestAnimationFrame(() => PAGES[page].classList.add('active'))
  refresh()
}

function collapse() {
  if (!open) return
  open = false
  document.body.classList.remove('open')
}

function armClose(delay = 340) {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => { if (!hovering) collapse() }, delay)
}

window.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const hit = !!(el && el.closest && el.closest('.hit'))
  if (hit !== hovering) {
    hovering = hit
    api.hover(hit)
  }
  if (hit) { clearTimeout(closeTimer); expand() }
  else if (open) armClose()
})

window.addEventListener('mouseleave', () => {
  hovering = false
  api.hover(false)
  armClose(200)
})

/* ------------------------------------------------------------- hardware --- */
const hw = {}

function mkRow(key, label) {
  const wrap = document.createElement('div')
  wrap.className = 'rowm'
  wrap.innerHTML = `<div class="rh"><span>${label}</span><b>--</b></div><div class="bar"><i></i></div>`
  const bar = wrap.querySelector('.bar')
  const fill = wrap.querySelector('.bar i')
  const num = wrap.querySelector('b')
  $('hw-rows').appendChild(wrap)
  hw[key] = {
    set(pct, text) {
      const p = Math.max(0, Math.min(100, Number(pct) || 0))
      fill.style.width = p + '%'
      num.textContent = text
      bar.classList.toggle('warm', p >= 70 && p < 88)
      bar.classList.toggle('hot', p >= 88)
    },
  }
}
mkRow('cpu', 'CPU')
mkRow('ram', 'RAM')
mkRow('gpu', 'GPU')

api.onStats((s) => {
  if (!s) return
  hw.cpu.set(s.cpu, Math.round(s.cpu || 0) + '%')
  hw.ram.set(s.ram, Math.round(s.ram || 0) + '%')
  const gp = s.gpu == null ? 0 : Math.max(0, Math.min(100, (s.gpu - 30) * 1.7))
  hw.gpu.set(gp, s.gpu == null ? 'n/a' : Math.round(s.gpu) + '°C')
})

let lastNet = null
let lastDh = null

async function loadHardware() {
  const r = await api.dash.hardware()
  if (!r.ok) return
  const h = r.data || {}
  const g = h.gpu || {}
  const d = (h.disks || [])[0]
  if (d) lastDh = d
  if (g.temperature != null) {
    hw.gpu.set(Math.max(0, Math.min(100, (g.temperature - 30) * 1.7)), Math.round(g.temperature) + '°C')
  }
  paintBattery(h.battery)
}

function paintBattery(b) {
  const pill = $('pill-batt')
  if (pill) pill.textContent = b && b.present ? Math.round(b.percent) + '%' : ''
  const el = $('batt')
  if (el) el.textContent = paintBatteryText(b, lastDh ? GB(lastDh.free) : null)
}

function paintBatteryText(b, freeGB) {
  const batt = b && b.present ? Math.round(b.percent) + '%' + (b.status === 2 ? ' ⚡' : '') : 'ac'
  return freeGB == null ? batt : batt + ' · ' + fmt(freeGB) + ' GB free'
}

async function loadNetwork(force) {
  const r = await api.dash.hardware()
  if (!r.ok) return
  const h = r.data || {}
  const ad = (h.network && h.network.adapters) || []
  const rx = ad.reduce((a, x) => a + (x.rxBytes || 0), 0)
  const tx = ad.reduce((a, x) => a + (x.txBytes || 0), 0)
  const now = Date.now()
  if (!ad.length) {
    $('net-rate').textContent = '—'
    $('net-label').textContent = 'no adapters'
    lastNet = { rx, tx, t: now }
    return
  }
  if (lastNet) {
    const dt = Math.max(1, (now - lastNet.t) / 1000)
    const down = Math.max(0, (rx - lastNet.rx) / dt)
    const up = Math.max(0, (tx - lastNet.tx) / dt)
    const total = down + up
    const per = (v) => (v < 1024 ? v.toFixed(0) + ' B/s' : v > 1048576 ? (v / 1048576).toFixed(1) + ' MB/s' : (v / 1024).toFixed(0) + ' KB/s')
    $('net-rate').textContent = total < 1 ? 'idle' : per(total)
    $('net-label').textContent = ad.length > 1 ? ad.length + ' adapters' : (ad[0].name || 'adapter')
    $('net-rx').textContent = per(down)
    $('net-tx').textContent = per(up)
  }
  lastNet = { rx, tx, t: now }
}

/* -------------------------------------------------------------- weather --- */
let city = ''
try { city = localStorage.getItem('jarvis.city') || '' } catch {}

let weatherAt = 0

async function loadWeather(force) {
  if (!city) { $('w-city').textContent = 'no city yet'; return }
  if (!force && Date.now() - weatherAt < 10 * 60 * 1000) return
  const r = await api.dash.weather(city)
  if (!r.ok) { $('w-city').textContent = 'weather unavailable'; return }
  weatherAt = Date.now()
  const w = r.data || {}, cur = w.current || {}
  $('w-temp').textContent = fmt(cur.temperature)
  $('pill-temp').textContent = fmt(cur.temperature, '°')
  $('w-city').textContent = `${w.city?.name ?? city}${w.city?.country ? ', ' + w.city.country : ''}`
  $('w-feels').textContent = `feels ${fmt(cur.apparentTemperature, '°')} · ${fmt(cur.humidity, '%')} humidity`
  $('w-days').textContent = (w.daily || []).slice(0, 2)
    .map((d) => `${new Date(d.date).toLocaleDateString(undefined, { weekday: 'short' })} ${fmt(d.tempMin, '°')}/${fmt(d.tempMax, '°')}`)
    .join('  ·  ')
}

/* ------------------------------------------------------------- calendar --- */
async function loadEvents() {
  const ul = $('events')
  const r = await api.dash.calList()
  ul.innerHTML = ''
  if (!r.ok || !r.data.length) {
    const li = document.createElement('li')
    li.className = 'dim'
    li.textContent = 'no events'
    ul.appendChild(li)
    return
  }
  for (const ev of r.data.slice(0, 3)) {
    const li = document.createElement('li')
    const b = document.createElement('b')
    b.textContent = new Date(ev.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const s = document.createElement('span')
    s.textContent = ev.title
    li.append(b, s)
    ul.appendChild(li)
  }
}

/* ------------------------------------------------------------ clipboard --- */
async function loadClips() {
  const ul = $('clips')
  let items = []
  try { items = await api.clipboard.history() } catch {}
  ul.innerHTML = ''
  if (!items || !items.length) {
    const li = document.createElement('li')
    li.className = 'dim'
    li.style.cursor = 'default'
    li.textContent = 'empty'
    ul.appendChild(li)
    return
  }
  for (const text of items.slice(0, 3)) {
    const li = document.createElement('li')
    li.textContent = text
    li.title = text
    li.addEventListener('click', async (e) => {
      e.stopPropagation()
      await api.clipboard.write(text)
      li.classList.add('copied')
      setTimeout(() => li.classList.remove('copied'), 900)
    })
    ul.appendChild(li)
  }
}

$('clip-clear').addEventListener('click', async (e) => {
  e.stopPropagation()
  await api.clipboard.clear()
  loadClips()
})

/* ---------------------------------------------------------------- music --- */
const viz = createViz($('eq'), { bars: 26, gap: 2, mirror: 0.22, glow: 0.7 })
let audioEl = null

$('m-pick').addEventListener('click', async (e) => {
  e.stopPropagation()
  const file = await api.media.pick()
  if (!file) return
  if (!isAudio(file)) { $('track').textContent = 'pick an audio file'; return }
  if (audioEl) { try { audioEl.pause() } catch {} }
  audioEl = new Audio(mediaUrl(file))
  audioEl.addEventListener('ended', () => { $('track').textContent = 'nothing playing' })
  try {
    viz.attach(audioEl)
    await audioEl.play()
  } catch {
    $('track').textContent = 'could not play that file'
    return
  }
  $('track').textContent = file.split(/[\\/]/).pop()
  notify({ kind: 'music', title: 'now playing', detail: file.split(/[\\/]/).pop() })
})

/* -------------------------------------------------------------- actions --- */
$('open-jarvis').addEventListener('click', (e) => { e.stopPropagation(); api.summon() })
$('new-chat').addEventListener('click', (e) => { e.stopPropagation(); api.newChat() })

let monitorOn = true

async function paintMonitor() {
  try {
    const c = await api.control.get()
    monitorOn = !!c.monitorOn
  } catch {}
  const b = $('quick-monitor')
  if (b) b.textContent = 'Watch ' + (monitorOn ? 'on' : 'off')
}

$('quick-monitor') && $('quick-monitor').addEventListener('click', async (e) => {
  e.stopPropagation()
  try { await api.control.set({ monitorOn: !monitorOn }) } catch {}
  paintMonitor()
})
paintMonitor()

$('quick-refresh').addEventListener('click', (e) => {
  e.stopPropagation()
  const n = $('act-note')
  if (n) n.textContent = 'refreshing…'
  lastNet = null
  loadHardware().then(() => loadNetwork(true)).then(() => {
    if (n) n.textContent = 'updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  })
})

/* --------------------------------------------------------------- refresh --- */
let hwTimer = null

function refresh() {
  loadEvents()
  loadClips()
  loadWeather(false)
  loadHardware().then(() => loadNetwork(false))
  clearInterval(hwTimer)
  hwTimer = setInterval(() => {
    if (!open) return
    loadHardware().then(() => loadNetwork(false))
  }, 6000)
}

/* ------------------------------------------------------ jarvis visibility - */
api.onJarvis((on) => {
  document.body.classList.toggle('hide', !!on)
  if (on) collapse()
})
api.onShow(() => document.body.classList.remove('hide'))
api.onHide(() => document.body.classList.add('hide'))

loadWeather(true)
loadHardware()
