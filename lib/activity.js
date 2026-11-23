'use strict'
/**
 * Opt-in, local-only work-pattern observation. No network, no coordinates stored, no titles/paths/keystrokes.
 * Nothing is sampled until setEnabled(true). Only aggregate counts per day are kept, for RETENTION_DAYS.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const FILE = () => process.env.JARVIS_ACTIVITY_FILE || path.join(__dirname, '..', 'data', 'activity.json')
const RETENTION_DAYS = 7
const CURSOR_MS = 5000
const PROCESS_MS = 60000
const MAX_PROCS_PER_DAY = 50
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/

const PS = "Add-Type -Namespace J -Name W -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);';" +
  "$p=0; $h=[J.W]::GetForegroundWindow(); [void][J.W]::GetWindowThreadProcessId($h,[ref]$p); if($p -gt 0){(Get-Process -Id $p -ErrorAction Stop).ProcessName}"

let state = null
let opts = null
let cursorTimer = null
let procTimer = null
let lastPos = null
let inflight = false
let dirty = false

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
const emptyDay = () => ({ move: 0, cursor: 0, samples: 0, unknown: 0, minutes: 0, proc: {} })

function prune(s) {
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 864e5)
  for (const k of Object.keys(s.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k <= cutoff) delete s.days[k]
}
function load() {
  if (state) return state
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch {}
  state = { enabled: !!(raw && raw.enabled === true), days: {} }
  if (raw && raw.days && typeof raw.days === 'object') {
    for (const [k, d] of Object.entries(raw.days)) {
      if (!d || typeof d !== 'object') continue
      const day = emptyDay()
      for (const f of ['move', 'cursor', 'samples', 'unknown', 'minutes']) day[f] = Number.isFinite(+d[f]) ? +d[f] : 0
      for (const [n, c] of Object.entries(d.proc || {})) if (SAFE_NAME.test(n) && Number.isFinite(+c)) day.proc[n] = +c
      state.days[k] = day
    }
  }
  prune(state)
  return state
}
function save() {
  const s = load(); prune(s)
  const f = FILE(); const tmp = f + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, f)
    dirty = false
  } catch { try { fs.unlinkSync(tmp) } catch {} }
}
function today() { const s = load(); return s.days[dayKey()] || (s.days[dayKey()] = emptyDay()) }
const idle = () => { try { return !!(opts && opts.isIdle && opts.isIdle()) } catch { return false } }

function sampleCursor() {
  if (!load().enabled || !opts) return
  try {
    if (idle()) return
    const p = opts.getCursor()
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const d = today(); d.cursor++
    if (lastPos && (lastPos.x !== p.x || lastPos.y !== p.y)) d.move++
    lastPos = { x: p.x, y: p.y } // memory only, never persisted
    dirty = true
  } catch {}
}

function defaultProcess() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS],
      { timeout: 5000, windowsHide: true, maxBuffer: 4096 },
      (e, out) => (e ? reject(e) : resolve(String(out || '').trim())))
  })
}
async function sampleProcess() {
  if (!load().enabled || !opts || inflight || idle()) return
  inflight = true
  let name = null
  try { name = await (opts.getProcess || defaultProcess)() } catch {}
  inflight = false
  const s = load()
  if (!s.enabled || !opts) return // stopped/disabled while awaiting
  const d = today()
  d.samples++; d.minutes += (opts.intervals.process || PROCESS_MS) / 60000
  name = typeof name === 'string' ? name.trim().replace(/\.exe$/i, '') + (/\.exe$/i.test(String(name).trim()) ? '.exe' : '') : null
  if (name && SAFE_NAME.test(name) && (d.proc[name] !== undefined || Object.keys(d.proc).length < MAX_PROCS_PER_DAY)) d.proc[name] = (d.proc[name] || 0) + 1
  else d.unknown++
  save()
}

function clearTimers() {
  if (cursorTimer) clearInterval(cursorTimer)
  if (procTimer) clearInterval(procTimer)
  cursorTimer = procTimer = null
}
function arm() {
  clearTimers()
  if (!opts || !load().enabled) return
  const iv = opts.intervals
  cursorTimer = setInterval(sampleCursor, iv.cursor); if (cursorTimer.unref) cursorTimer.unref()
  procTimer = setInterval(sampleProcess, iv.process); if (procTimer.unref) procTimer.unref()
  sampleCursor(); sampleProcess()
}

/** start({getCursor, isIdle?, getProcess?, intervals?}) — collects only if enabled was explicitly set. */
function start(o = {}) {
  stop()
  if (typeof o.getCursor !== 'function') return false
  const iv = o.intervals || {}
  opts = {
    getCursor: o.getCursor, isIdle: o.isIdle, getProcess: o.getProcess,
    intervals: { cursor: iv.cursor > 0 ? iv.cursor : CURSOR_MS, process: iv.process > 0 ? iv.process : PROCESS_MS },
  }
  arm()
  return true
}
function stop() {
  clearTimers(); opts = null; lastPos = null
  if (dirty && state) save()
}
function setEnabled(v) {
  const s = load(); s.enabled = v === true
  lastPos = null
  if (!s.enabled) clearTimers()
  save()
  if (s.enabled && opts) arm()
  return s.enabled
}
function clear() {
  const s = load(); s.days = {}; lastPos = null; save()
}
function status() {
  const s = load(); prune(s)
  const t = { enabled: s.enabled, running: !!cursorTimer, retentionDays: RETENTION_DAYS, minutesSampled: 0, movementEvents: 0, cursorSamples: 0, samples: 0, unknown: 0, processes: [], processCounts: {} }
  for (const d of Object.values(s.days)) {
    t.minutesSampled += d.minutes; t.movementEvents += d.move; t.cursorSamples += d.cursor; t.samples += d.samples; t.unknown += d.unknown
    for (const [n, c] of Object.entries(d.proc)) t.processCounts[n] = (t.processCounts[n] || 0) + c
  }
  t.minutesSampled = +t.minutesSampled.toFixed(2)
  t.processes = Object.keys(t.processCounts).sort((a, b) => t.processCounts[b] - t.processCounts[a])
  return t
}
function _reset() { clearTimers(); opts = null; lastPos = null; state = null; inflight = false; dirty = false }

module.exports = { start, stop, status, clear, setEnabled, isEnabled: () => load().enabled, _reset }
