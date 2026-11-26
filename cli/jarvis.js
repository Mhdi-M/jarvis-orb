#!/usr/bin/env node
'use strict'
/**
 * Jarvis — a terminal assistant.
 *
 *   jarvis                 start the session
 *   jarvis "open notepad"  run a single command and exit
 *
 * Everything the app used to show in widgets is a command here; the right-hand
 * sidebar keeps model, agent, tokens and hardware visible while you type.
 */

// --session <name> gives this process its own conversation, so several Jarvis
// windows (or a background question) can run at once without crossing streams.
const sessAt = process.argv.indexOf('--session')
if (sessAt > -1 && process.argv[sessAt + 1]) {
  process.env.JARVIS_SESSION = String(process.argv[sessAt + 1])
  process.argv.splice(sessAt, 2)
}

const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const readline = require('readline')

const ROOT = path.join(__dirname, '..')
const bridge = require(path.join(ROOT, 'hermes-bridge'))
const agents = require(path.join(ROOT, 'lib', 'agents'))
const team = require(path.join(ROOT, 'lib', 'team'))
const operator = require(path.join(ROOT, 'lib', 'operator'))
const orb = require(path.join(ROOT, 'lib', 'orb'))
const vpn = require(path.join(ROOT, 'lib', 'vpn'))
const bg = require(path.join(ROOT, 'lib', 'bg'))
const gateway = require(path.join(ROOT, 'lib', 'gateway'))
const graph = require(path.join(ROOT, 'lib', 'graph'))
const uia = require(path.join(ROOT, 'lib', 'uia'))
const sysops = require(path.join(ROOT, 'lib', 'sys'))
const { sampler } = require(path.join(ROOT, 'lib', 'cpu'))
const memory = require(path.join(ROOT, 'lib', 'memory'))
const monitorLib = require(path.join(ROOT, 'lib', 'monitor'))
const messagesLib = require(path.join(ROOT, 'lib', 'messages'))
const chromeLib = require(path.join(ROOT, 'lib', 'chrome'))
const skillsLib = require(path.join(ROOT, 'lib', 'skills'))
const profileLib = require(path.join(ROOT, 'lib', 'profile'))
const health = require(path.join(ROOT, 'lib', 'health'))
const models = require(path.join(ROOT, 'lib', 'models'))
const alerts = require(path.join(ROOT, 'lib', 'alerts'))
const quality = require(path.join(ROOT, 'lib', 'quality'))
const securityLib = require(path.join(ROOT, 'lib', 'security'))
const sentinel = require(path.join(ROOT, 'lib', 'sentinel'))
const reflect = require(path.join(ROOT, 'lib', 'reflect'))
const visionbench = require(path.join(ROOT, 'lib', 'visionbench'))
const papers = require(path.join(ROOT, 'lib', 'papers'))
const guard = require(path.join(ROOT, 'lib', 'guard'))
const orchestra = require(path.join(ROOT, 'lib', 'orchestra'))
const bench = require(path.join(ROOT, 'lib', 'bench'))
const preview = require(path.join(ROOT, 'lib', 'preview'))
const verify = require(path.join(ROOT, 'lib', 'verify'))
const remindersLib = { parseReminder: null, parseNote: null }
const intentLib = { parseIntent: null }

const CONFIG_FILE = path.join(ROOT, 'cli.config.json')
const REMINDER_FILE = path.join(ROOT, 'data', 'reminders.json')
const NOTE_FILE = path.join(ROOT, 'data', 'notes.json')

/* ------------------------------------------------------------------ style */
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  accent: '\x1b[38;2;86;138;214m',
  bright: '\x1b[38;2;236;241;247m',
  steel: '\x1b[38;2;139;147;155m',      // secondary text
  dimmer: '\x1b[38;2;106;111;117m',     // muted text, labels
  green: '\x1b[38;2;126;182;152m',
  amber: '\x1b[38;2;190;170;120m',
  red: '\x1b[38;2;196;120;126m',
  violet: '\x1b[38;2;140;150;190m',
  ghost: '\x1b[38;2;60;64;70m',         // the dimmest tone (borders, meta)
  edge: '\x1b[38;2;47;51;56m',          // hairlines, dividers
  blue: '\x1b[38;2;59;104;199m',        // accent
  blueDeep: '\x1b[38;2;40;66;121m',     // deep accent
  panel: '\x1b[48;2;15;22;33m',         // card tone from the app
  panelAlt: '\x1b[48;2;18;24;34m',
  panelSoft: '\x1b[48;2;21;28;38m',
  edgeSoft: '\x1b[38;2;47;51;56m',
}
const bar1 = (s2) => C.panel + s2 + C.reset
const paint = (c, s) => c + s + C.reset
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
/* display cells, not code points: CJK and emoji take two, combining marks none.
 * The cursor column, padding and every box edge depend on this being right. */
const strWidth = (s) => {
  let w = 0
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)
    if (cp === 0x200d || cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f)) continue
    const wide = (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x1f000 && cp <= 0x1f02f) || (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}
const pad = (s, n) => { const w = strWidth(s); return w >= n ? cut(s, n) : s + ' '.repeat(n - w) }
const cut = (s, n) => {
  if (strWidth(s) <= n) return s
  let out = '', w = 0, i = 0
  const raw = String(s)
  while (i < raw.length && w < n) {
    if (raw[i] === '\x1b') { const m = raw.slice(i).match(/^\x1b\[[0-9;]*m/); if (m) { out += m[0]; i += m[0].length; continue } }
    out += raw[i]; w++; i++
  }
  return out + C.reset
}
const bar = (pct, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const color = pct >= 85 ? C.red : pct >= 60 ? C.amber : C.green
  return paint(color, '█'.repeat(filled)) + paint(C.dimmer, '░'.repeat(width - filled))
}

/* ----------------------------------------------------------------- config */
let config = { model: '', provider: '', autoTitle: true }
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))) } catch {}
const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) } catch {} }

/* ------------------------------------------------------------------ state */
const state = {
  lines: [],                    // { role, text }
  input: '',
  pos: 0,
  histAt: -1,
  history: [],
  busy: false,
  started: Date.now(),
  spin: 0,
  scroll: 0,           // transcript rows scrolled up from the bottom
  screen: [],          // plain text of the last painted frame (for selection)
  sel: null,           // { r1, c1, r2, c2 } screen selection
  dragging: false,
  selAll: false,       // whole input line selected
  lastClick: { at: 0, y: -1 },
  lastAnswer: null,    // { ms, tokIn, tokOut, modelMs, at } for the bottom box
  asyncLast: null,
  tokens: { lastIn: 0, lastOut: 0, sessionIn: 0, sessionOut: 0, context: 0 },
  hw: { cpu: 0, ram: 0, gpu: null, diskFree: 0, diskTotal: 0 },
  model: config.model || 'session default',
  provider: config.provider || 'auto',
  session: '—',
  queued: 0,
  status: 'ready',
  lastMs: 0,
  lastSearch: [],     // last /find or /messages result, for /summarize
  lastSource: '',
  trace: true,        // show the thinking block
  showTiming: true,   // show per-step timings inside it
  thinking: null,     // lines of the current thinking block
  perf: { score: 0, label: 'unknown', parts: {} },
  sec: { gateway: false, audit: 0 },
  pendingAction: null, // a risky request waiting for /yes
  agentNow: null,      // which specialist is working right now
  orchestrate: true,   // route specialist tasks through the manager loop
}

/* --------------------------------------------------------------- messages */
function addLine(role, text) {
  const chunks = String(text ?? '').split('\n')
  const at = Date.now()
  for (const chunk of chunks) state.lines.push({ role, text: chunk, at })
  if (state.lines.length > 800) state.lines.splice(0, state.lines.length - 800)
}
const sys = (t) => addLine('sys', t)
const you = (t) => addLine('you', t)
const jarvis = (t) => addLine('jarvis', t)

/* ------------------------------------------------------------- formatting */
function wrap(text, width) {
  if (width < 10) return [text]
  const out = []
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue }
    let line = ''
    for (const word of para.split(' ')) {
      if (!line) { line = word; continue }
      if (strWidth(line) + 1 + strWidth(word) <= width) line += ' ' + word
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
  }
  return out
}

/* ------------------------------------------------------------------- disk */
function diskFree() {
  try {
    const st = fs.statfsSync ? fs.statfsSync(ROOT) : null
    if (st) return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
  } catch {}
  return { free: 0, total: 0 }
}

/* ------------------------------------------------------- specialist agents */
/* The manager (this model) cannot see. Vision is delegated to a specialist that
 * runs the same binary with a vision model and only the vision toolset, which is
 * far cheaper than letting the manager improvise screenshots and three vision
 * calls (measured: 30s vs 219s / 204k tokens). */
function visionSpecialist() {
  try {
    const cfgPath = path.join(process.env.LOCALAPPDATA || os.homedir(), 'hermes', 'config.yaml')
    const y = fs.readFileSync(cfgPath, 'utf8')
    const m = y.match(/auxiliary:\s*\n\s*vision:\s*\n\s*provider:\s*([\w.-]+)\s*\n\s*model:\s*([\w.-]+)/)
    if (m) return { provider: m[1], model: m[2] }
  } catch {}
  return { provider: 'gemini', model: 'gemini-3.6-flash' }
}

function captureScreen(file) {
  const ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    "$bmp.Save('" + file + "'); $g.Dispose(); $bmp.Dispose()"
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, () => resolve(file))
  })
}

function askVision(file, question) {
  const sp = visionSpecialist()
  const prompt = 'Call vision_analyze exactly once on this image path: ' + file +
    ' - then answer in two short sentences: ' + question
  return new Promise((resolve) => {
    execFile(bridge.HERMES_EXE,
      ['-z', prompt, '-m', sp.model, '--provider', sp.provider, '-t', 'vision'],
      { windowsHide: true, timeout: 180000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        const out = String(stdout || '').trim()
        /* The specialist reports its own failures as ordinary text ("Vision
         * analysis failed - ...", "rate limit", "misconfigured"), so an empty
         * check is not enough: those strings must also trigger the fallback. */
        const broken = /vision analysis failed|vision_analyze (?:tool )?is broken|non-existent|not exist|rate limit|quota|misconfigured|is unavailable|40[34]|503/i.test(out)
        if (out && !broken) return resolve(out)
        // cloud failed (quota / 404 / 503 / misconfigured) -> fall back to local Ollama
        sys(paint(C.dimmer, 'cloud vision failed; falling back to qwen2.5vl:3b...'))
        scheduleRender()
        askLocalVision(file, question).then(resolve)
      })
  })
}

/* call local Ollama vision model directly; used when cloud quota is spent */
function askLocalVision(file, question) {
  return new Promise((resolve) => {
    const b64 = fs.readFileSync(file).toString('base64')
    const body = JSON.stringify({
      model: 'qwen2.5vl:3b',
      prompt: 'In one short sentence: ' + question,
      images: [b64],
      stream: false
    })
    const opts = { hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json' } }
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); resolve((j.response || '').trim()) } catch (e) { resolve('local vision error: ' + e.message) }
      })
    })
    req.on('error', e => resolve('local vision connect error: ' + e.message))
    req.write(body); req.end()
  })
}
function kelvinTenthsToC(raw) {
  const n = parseFloat(String(raw == null ? '' : raw).replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const c = n / 10 - 273.15
  return (c < -40 || c > 150) ? null : Math.round(c * 10) / 10
}
function parseNvidiaSmi(text) {
  const line = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)[0]
  if (!line) return null
  const parts = line.split(',').map(p => p.trim())
  const temp = parseFloat(parts[0])
  if (!Number.isFinite(temp) || temp <= 0 || temp > 130) return null
  const name = parts[1] && parts[1] !== '[N/A]' ? parts[1] : ''
  const util = parseFloat(parts[2])
  return { temp, name, util: (util == null || util < 0) ? null : util }
}
function parseThermalZone(text) {
  const m = String(text || '').match(/CurrentTemperature\s*:?\s*(-?\d+)/i)
  return m ? kelvinTenthsToC(m[1]) : null
}
function parseStorageTemp(text) {
  const nums = String(text || '').match(/-?\d+/g) || []
  for (const raw of nums) {
    const v = parseFloat(raw)
    if (v == null) continue
    if (v > 0 && v < 110) return v
  }
  return null
}

const cpuSample = sampler()
let hwCache = { gpuTemp: null, gpuName: '', gpuUtil: null, cpuTemp: null, diskTemp: null }

function pollGpu() {
  execFile('nvidia-smi',
    ['--query-gpu=temperature.gpu,name,utilization.gpu', '--format=csv,noheader,nounits'],
    { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err || !out) return
      const parsed = parseNvidiaSmi(out)
      if (parsed) { hwCache.gpuTemp = parsed.temp; hwCache.gpuName = parsed.name; hwCache.gpuUtil = parsed.util }
    })
}

function pollCpuTemp() {
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentTemperature'],
    { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err || !out) return
      const v = parseThermalZone(out)
      if (v != null) hwCache.cpuTemp = v
    })
}

function pollDiskTemp() {
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-PhysicalDisk | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Temperature'],
    { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err || !out) return
      const v = parseStorageTemp(out)
      if (v != null) hwCache.diskTemp = v
    })
}

function refreshHw() {
  const total = os.totalmem()
  const d = diskFree()
  state.hw.cpu = cpuSample()
  state.hw.ram = total ? 100 * (1 - os.freemem() / total) : 0
  state.hw.gpuTemp = hwCache.gpuTemp
  state.hw.gpuName = hwCache.gpuName
  state.hw.gpuUtil = hwCache.gpuUtil
  state.hw.cpuTemp = hwCache.cpuTemp
  state.hw.diskTemp = hwCache.diskTemp
  state.hw.diskFree = d.free
  state.hw.diskTotal = d.total
  try {
    state.perf = health.performance({ contextTokens: state.tokens.context })
  } catch {}
}

/* Performance + security line for the sidebar, refreshed off the paint path. */
function refreshStatus() {
  try { state.perf = health.performance({ contextTokens: state.tokens.context }) } catch {}
  try { state.sec = { gateway: gateway.status().running, audit: securityLib.recentAudit(1000).length } } catch {}
}

let tempPollTimer = null
function startTempPolling() {
  if (tempPollTimer) return
  pollGpu(); pollCpuTemp(); pollDiskTemp()
  tempPollTimer = setInterval(() => { pollGpu(); pollCpuTemp(); pollDiskTemp() }, 10000)
  if (tempPollTimer.unref) tempPollTimer.unref()
  const retry = setTimeout(() => { startTempPolling() }, 30000)
  if (retry.unref) retry.unref()
}

/* ---------------------------------------------------------------- rendering */
let lastRender = 0
let renderTimer = null
function scheduleRender() {
  if (renderTimer) return
  if (state.busy) state.spin = (state.spin + 1) % 4   // galaxy rotation
  const wait = Math.max(0, state.busy ? 140 : 80 - (Date.now() - lastRender))
  renderTimer = setTimeout(() => { renderTimer = null; render() }, wait)
}

let INTERACTIVE = true
let SCR = null          // lib/screen.mjs, loaded in main()
let KEYS = null         // lib/keys.mjs, loaded in main()

/* ------------------------------------------------------------------- art */
/* A fixed strip at the top of the frame: the galaxy lives here and never
 * scrolls with the transcript. */
const ANIM = [
  ['   \u00b7   \u2726   \u00b7   ',
   '  \u2726 \u2584\u2588\u2588\u2588\u2584 \u2726  ',
   '   \u00b7   \u2726   \u00b7   '],
  ['  \u00b7    \u2726    \u00b7  ',
   '   \u2726\u2584\u2588\u2588\u2588\u2584\u2726   ',
   '  \u00b7    \u2726    \u00b7  '],
  ['   \u2726   \u00b7   \u2726   ',
   '  \u00b7 \u2584\u2588\u2588\u2588\u2584 \u00b7  ',
   '   \u2726   \u00b7   \u2726   '],
  ['  \u2726    \u00b7    \u2726  ',
   '   \u00b7\u2584\u2588\u2588\u2588\u2584\u00b7   ',
   '  \u2726    \u00b7    \u2726  '],
]

const BANNER = [
  '  \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  '  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d',
  '  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  '\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255a\u2588\u2588\u2557 \u2588\u2588\u2554\u255d\u2588\u2588\u2551\u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2551',
  '\u255a\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551 \u255a\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551',
  ' \u255a\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u255d  \u255a\u2550\u2550\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d',
]

/* The writing box grows with the prompt: text wraps into up to MAX_INPUT_ROWS
 * rows and the view scrolls only when it needs to, so the cursor is always
 * visible and never lands on the wrong cell (wide characters count as two). */
const MAX_INPUT_ROWS = 5
const cellOf = (ch) => {
  const cp = ch.codePointAt(0)
  if (cp === 0x200d || cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f)) return 0
  const wide = (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f000 && cp <= 0x1f02f) || (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 2 : 1
}

function wrapInput(text, pos, width, maxRows) {
  const s2 = String(text)
  const rows = []
  let i2 = 0
  // word wrap: fill a row with whole words, hard-break only a word too long to fit
  while (i2 < s2.length) {
    const start = i2
    let line = ''
    let w = 0
    while (i2 < s2.length) {
      const m = s2.slice(i2).match(/^(\s*\S+|\s+)/)
      const tok = m ? m[0] : s2[i2]
      const tw = strWidth(tok)
      if (line && w + tw > width) break
      if (!line && tw > width) {
        let take = ''
        let tw2 = 0
        for (const ch of tok) {
          const cw = cellOf(ch)
          if (tw2 + cw > width) break
          take += ch; tw2 += cw
        }
        line += take; w += tw2; i2 += take.length
        break
      }
      line += tok; w += tw; i2 += tok.length
      if (w >= width) break
    }
    if (i2 === start) i2 += 1          // never spin on a zero-width token
    rows.push({ text: line, start })
  }
  if (!rows.length) rows.push({ text: '', start: 0 })

  let cursorRow = rows.length - 1
  let cursorCol = strWidth(rows[cursorRow].text)
  for (let k = 0; k < rows.length; k++) {
    const until = k + 1 < rows.length ? rows[k + 1].start : s2.length
    if (pos >= rows[k].start && pos < until) {
      cursorRow = k
      cursorCol = strWidth(s2.slice(rows[k].start, pos))
      break
    }
    if (k === rows.length - 1 && pos >= rows[k].start) {
      cursorRow = k
      cursorCol = strWidth(s2.slice(rows[k].start, pos))
    }
  }

  const shown = Math.min(rows.length, Math.max(1, maxRows))
  const startRow = Math.max(0, Math.min(cursorRow - shown + 1, rows.length - shown))
  return {
    rows: rows.slice(startRow, startRow + shown).map((r2) => r2.text),
    cursorRow: cursorRow - startRow,
    cursorCol,
    count: shown,
  }
}

function render() {
  if (!INTERACTIVE) return
  lastRender = Date.now()
  const cols = process.stdout.columns || 100
  const rows = process.stdout.rows || 30
  const sideW = cols >= 92 ? 34 : 0
  const chatW = cols - sideW - 3
  const animRows = rows >= 20 ? 3 : 0
  const promptW = 1 + strWidth('\u203a ')
  const inputAvail = Math.max(8, cols - 1 - promptW)
  const iv = wrapInput(state.input, state.pos, inputAvail, rows < 22 ? 3 : MAX_INPUT_ROWS)
  const inputRows = iv.count
  const bodyRows = rows - animRows - inputRows - 3    // anim + body + rule + input + box + spare
  if (bodyRows < 4) return

  // ---- transcript rows (schema is role-tagged so questions cannot be confused
  //      with answers: amber gutter for you, blue labelled gutter for Jarvis)
  const all = []
  const push = (head, text, plain, src) => all.push({ head, text, plain, src })

  if (!state.lines.length) {
    for (let b = 0; b < BANNER.length; b++) push('', paint(C.accent, C.bold + cut(BANNER[b], chatW)), cut(BANNER[b], chatW), -1)
    push('', '', '', -1)
    push('', paint(C.dimmer, '  type a question, or ') + paint(C.accent, '/help') + paint(C.dimmer, '   \u00b7   open notepad \u00b7 read example.com'), '', -1)
  } else {

    // the procedure is plain text: no box, no background, just dim small-looking
    // lines tucked under the question
    const pushThinkBox = (run) => {
      for (const item of run) {
        for (const piece of wrap(item.text, Math.max(8, chatW - 6))) {
          push('    ', paint(C.dimmer, piece), '    ' + piece, item.li)
        }
      }
    }

    let prevRole = null
    for (let li = 0; li < state.lines.length; li++) {
      const l = state.lines[li]
      if (l.role === 'meta') continue

      if (l.role === 'think') {
        const run = []
        let ri = li
        while (ri < state.lines.length && state.lines[ri].role === 'think') { run.push({ text: state.lines[ri].text, li: ri }); ri++ }
        li = ri - 1
        pushThinkBox(run)
        prevRole = 'think'
        continue
      }

      // chat style: a small header line per message, then the text underneath
      if (l.role === 'you' || l.role === 'jarvis') {
        if (prevRole && prevRole !== 'you' && prevRole !== 'jarvis') push('', '', '', -3)
        if (prevRole === 'jarvis' && l.role === 'you') push('', '', '', -3)
        const isYou = l.role === 'you'
        const label = isYou
          ? paint(C.dimmer, C.bold + 'you')
          : paint(C.accent, C.bold + 'JARVIS')
        const when = new Date(l.at || Date.now()).toTimeString().slice(0, 5)
        const meta = paint(C.ghost, '  ' + when)
        push('', label + meta, (isYou ? 'you' : 'JARVIS'), li)
      }
      const indent = (l.role === 'you' || l.role === 'jarvis') ? '  ' : '    '
      const color = l.role === 'you' ? C.steel
        : l.role === 'jarvis' ? C.bright
        : C.dimmer
      const prefix = l.role === 'sys' ? '\u00b7 ' : ''
      const avail = Math.max(8, chatW - strWidth(indent) - strWidth(prefix))
      const wrapped = wrap(l.text, avail)
      for (const piece of wrapped) {
        push(indent + prefix, paint(color, piece), indent + prefix + piece, li)
      }
      prevRole = l.role
    }
  }

  // ---- viewport (never includes the animation)
  const total = all.length
  const scroll = SCR ? SCR.clampScroll(state.scroll, total, bodyRows) : Math.max(0, Math.min(Math.max(0, total - bodyRows), state.scroll))
  state.scroll = scroll
  const end = total - scroll
  const start = Math.max(0, end - bodyRows)
  const visible = all.slice(start, end)

  // ---- sidebar
  const side = []
  const rule = paint(C.edge, '\u2500'.repeat(Math.max(0, sideW - 2)))
  const kv = (k, v) => side.push(' ' + paint(C.dimmer, pad(k, 10)) + pad(paint(C.steel, v), sideW - 13))
  side.push(paint(C.accent, C.bold + ' JARVIS') + paint(C.dimmer, '  ' + new Date().toTimeString().slice(0, 5)))
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'MODEL'))
  side.push(' ' + paint(C.bright, cut(state.model, sideW - 3)))
  side.push(' ' + paint(C.dimmer, 'PROVIDER ') + paint(C.steel, cut(state.provider, sideW - 13)))
  const elapsed = state.busy && state.busySince ? ((Date.now() - state.busySince) / 1000).toFixed(1) + 's' : ''
  side.push(' ' + paint(C.dimmer, 'AGENT    ') + paint(state.busy ? C.amber : C.green, state.busy ? (state.agentNow ? '→ ' + String(state.agentNow).slice(0, 14) : 'working ' + elapsed) : 'idle'))
  side.push(' ' + paint(C.dimmer, 'SESSION  ') + paint(C.steel, cut(state.session, sideW - 13)))
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'TOKENS'))
  kv('turn in', String(state.tokens.lastIn))
  kv('turn out', String(state.tokens.lastOut))
  kv('session', state.tokens.sessionIn + ' / ' + state.tokens.sessionOut)
  kv('context', state.tokens.context ? (state.tokens.context / 1000).toFixed(1) + 'k' : '\u2014')
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'HARDWARE'))
  side.push(' ' + paint(C.dimmer, 'CPU ') + bar(state.hw.cpu, 10) + ' ' +
    paint(C.steel, Math.round(state.hw.cpu) + '%') +
    (state.hw.cpuTemp != null ? ' ' + paint(C.steel, Math.round(state.hw.cpuTemp) + '\u00b0C') : ''))
  side.push(' ' + paint(C.dimmer, 'RAM ') + bar(state.hw.ram, 10) + ' ' + paint(C.steel, Math.round(state.hw.ram) + '%'))
  const gpu = state.hw.gpuTemp != null ? Math.round(state.hw.gpuTemp) + '\u00b0C' : 'n/a'
  const gpuUtil = state.hw.gpuUtil != null ? ' ' + state.hw.gpuUtil + '%' : ''
  const gpuName = state.hw.gpuName ? ' ' + state.hw.gpuName : ''
  side.push(' ' + paint(C.dimmer, 'GPU') + gpuName + ' ' + paint(C.steel, gpu + gpuUtil))
  if (state.hw.diskTemp != null) side.push(' ' + paint(C.dimmer, 'SSD ') + paint(C.steel, Math.round(state.hw.diskTemp) + '\u00b0C'))
  const diskUsed = state.hw.diskTotal ? 100 * (1 - state.hw.diskFree / state.hw.diskTotal) : 0
  side.push(' ' + paint(C.dimmer, 'DISK') + ' ' + paint(C.steel, diskUsed ? Math.round(diskUsed) + '% used' : '\u2014'))
  side.push(rule)
  /* AI PERFORMANCE: measured from model/agent outcomes, not invented */
  const perf = state.perf || {}
  const pScore = Number.isFinite(perf.score) ? perf.score : 0
  const pLabel = perf.label || 'unknown'
  side.push(' ' + paint(C.dimmer, 'PERFORMANCE'))
  side.push(' ' + paint(C.dimmer, 'AI ') + bar(pScore, 10) + ' ' + paint(C.steel, pScore + '%') + ' ' + paint(pLabel === 'healthy' ? C.green : pLabel === 'steady' ? C.steel : pLabel === 'strained' ? C.amber : pLabel === 'no data' ? C.dimmer : C.red, pLabel))
  const h = health.load()
  const modelRows = Object.values(h.models || {})
  const modelsOk = modelRows.filter((m) => m.lastOk && (!m.lastFail || m.lastOk >= m.lastFail)).length
  const agentRows = Object.values(h.agents || {})
  const agentsOk = agentRows.filter((a) => a.lastOk && (!a.lastFail || a.lastOk >= a.lastFail)).length
  side.push(' ' + paint(C.dimmer, 'llm ') + paint(C.steel, modelsOk + '/' + modelRows.length) + paint(C.dimmer, ' · ag ') + paint(C.steel, agentsOk + '/' + agentRows.length) + paint(C.dimmer, ' · bench ') + paint(C.steel, perf.parts && perf.parts.benchmark != null ? Math.round(perf.parts.benchmark * 100) + '%' : '—'))
  side.push(' ' + paint(C.dimmer, 'SEC ') + paint(C.steel, 'gw ' + (state.sec.gateway ? 'on' : 'off') + ' · audit ' + state.sec.audit))
  side.push(rule)
  const rem = readList(REMINDER_FILE).filter((r) => r.at > Date.now()).length
  kv('reminders', String(rem))
  kv('memory', memory.list().length + ' facts')
  kv('uptime', Math.round((Date.now() - state.started) / 60000) + ' min')

  // ---- the animation strip: fixed at the top, never part of the transcript
  const anim = []
  if (animRows) {
    /* while busy the strip is the dotted orb for the current activity, not the
     * static banner: the motion itself says what is happening. */
    const orbLines = state.busy
      ? orb.render(state.orbState || 'working', Math.max(10, chatW), animRows, (state.spin || 0) * 0.22)
      : null
    const frame = orbLines && orbLines.length ? orbLines : ANIM[state.busy ? state.spin % ANIM.length : 0]
    for (let a = 0; a < animRows; a++) {
      const line = cut(frame[a] || '', Math.max(4, chatW))
      anim.push(paint(C.accent, line))
    }
  }

  // ---- bottom box: time, tokens, model, session for the last answer
  const la = state.lastAnswer
  const segs = []
  if (la) {
    segs.push('\u23f1 ' + (la.ms / 1000).toFixed(1) + 's')
    if (la.tokIn) segs.push(la.tokIn + ' in / ' + la.tokOut + ' out')
    if (la.modelMs) segs.push('model ' + (la.modelMs / 1000).toFixed(1) + 's')
    segs.push(new Date(la.at).toTimeString().slice(0, 8))
  } else {
    segs.push('no answer yet')
  }
  segs.push('session ' + state.tokens.sessionIn + '/' + state.tokens.sessionOut)
  segs.push('ctx ' + (state.tokens.context ? (state.tokens.context / 1000).toFixed(1) + 'k' : '\u2014'))
  let boxText = segs.join('   \u00b7   ')
  while (strWidth(boxText) > chatW - 6 && segs.length > 2) { segs.pop(); boxText = segs.join('   \u00b7   ') }
  const fill = Math.max(0, chatW - strWidth(boxText) - 4)
  const boxLeft = C.panel + paint(C.edge, '\u251c\u2500 ') + paint(C.steel, boxText) +
    paint(C.edge, ' ' + '\u2500'.repeat(fill) + '\u2524') + C.reset

  // ---- input line
  const inputLabel = state.busy ? paint(C.amber, '\u2026 ') : paint(C.accent, '\u203a ')
  let hint = state.busy ? paint(C.dimmer, 'esc stops') : paint(C.dimmer, '/help')
  if (scroll > 0) hint = paint(C.amber, '\u2191 ' + scroll + ' lines \u00b7 End for bottom')
  if (state.selAll) hint = paint(C.amber, 'all selected \u00b7 type to replace')

  // ---- compose
  const out = []
  const screen = []
  const rowSrc = []
  out.push('\x1b[?25l')
  out.push('\x1b[H')

  const put = (left, right) => {
    out.push(left + (sideW ? paint(C.edge, '\u2502') + pad(right || '', sideW) : '') + '\r\n')
    screen.push(left.replace(/\x1b\[[0-9;]*m/g, '') + (sideW ? '\u2502' : ''))
    return left.replace(/\x1b\[[0-9;]*m/g, '')
  }

  for (let a = 0; a < animRows; a++) {
    put(pad(anim[a] || '', chatW), side[a] || '')
    rowSrc.push(-2)
  }
  for (let r = 0; r < bodyRows; r++) {
    const row = visible[r]
    const left = row ? pad(cut(row.head + row.text, chatW), chatW) : ' '.repeat(chatW)
    const plain = row ? row.plain : ''
    out.push(left + (sideW ? paint(C.edge, '\u2502') + pad(side[animRows + r] || '', sideW) : '') + '\r\n')
    screen.push(pad(cut(plain, chatW), chatW) + (sideW ? '\u2502' : ''))
    rowSrc.push(row ? row.src : -2)
  }
  out.push(paint(C.edge, '\u2500'.repeat(cols)) + '\r\n')
  screen.push('\u2500'.repeat(cols))
  rowSrc.push(-2)



  const inputStart = 1 + promptW          // 1-based column where the text begins
  for (let k = 0; k < iv.rows.length; k++) {
    const body = iv.rows[k] || ''
    const lead = k === 0 ? ' ' + inputLabel : ' '.repeat(promptW)
    const painted = (state.selAll && body)
      ? lead + '\x1b[7m' + body + '\x1b[0m'
      : lead + paint(C.bright, body)
    const line = pad(painted, cols - 1)
    out.push(C.panelAlt + line + ' '.repeat(Math.max(0, cols - 1 - strWidth(line))) + C.reset + '\r\n')
    screen.push((lead + body).replace(/\x1b\[[0-9;]*m/g, ''))
    rowSrc.push(-2)
  }

  // detail box sits under the writing box, as the last row of the frame
  out.push(pad(boxLeft, chatW) + (sideW ? paint(C.edge, '\u2502') + pad(side[animRows + bodyRows + 1 + inputRows] || '', sideW) : ''))
  screen.push(pad(boxLeft.replace(/\x1b\[[0-9;]*m/g, ''), chatW) + (sideW ? '\u2502' : ''))
  rowSrc.push(-2)
  state.screen = screen
  state.rowSrc = rowSrc
  state.chatW = chatW

  const cursorRowAbs = animRows + bodyRows + 1 + iv.cursorRow + 1   // 1-based row of the caret
  const hintPlain = hint.replace(/\x1b\[[0-9;]*m/g, '')
  const hintCol = cols - strWidth(hintPlain) - 1
  const lastInputRow = animRows + bodyRows + 1 + inputRows
  if (hintCol > inputStart + strWidth(iv.rows[iv.rows.length - 1] || '') + 2) {
    out.push('\x1b[' + lastInputRow + ';' + hintCol + 'H' + hint)
  }

  // ---- selection painted on top of the frame
  const sel = state.sel
  if (sel && sel.r1 != null) {
    const a = Math.min(sel.r1, sel.r2)
    const b = Math.max(sel.r1, sel.r2)
    for (let r = a; r <= b; r++) {
      const line = screen[r - 1]
      if (!line) continue
      const from = (r === a) ? Math.max(0, sel.c1 - 1) : 0
      const to = (r === b) ? Math.max(0, sel.c2) : line.length
      const piece = line.slice(from, Math.max(from, to))
      if (!piece.trim()) continue
      out.push('\x1b[' + r + ';' + (from + 1) + 'H' + '\x1b[7m' + piece + '\x1b[0m')
    }
  }

  // cursor lands after the visible prefix, so wide characters do not shift it
  const cursorCol = inputStart + iv.cursorCol
  out.push('\x1b[' + cursorRowAbs + ';' + Math.max(1, Math.min(cols - 1, cursorCol)) + 'H')
  out.push('\x1b[?25h')
  process.stdout.write(out.join(''))
}

/* ------------------------------------------------------------- input line */
const stdin = process.stdin

function submit() {
  const text = state.input.trim()
  if (!text) return
  state.input = ''
  state.pos = 0
  state.selAll = false
  if (state.history[state.history.length - 1] !== text) state.history.push(text)
  state.histAt = -1
  handle(text)
  scheduleRender()
}

/* A request that would act on the machine waits for an explicit yes. The guard
 * is a policy, not a sandbox: it stops requests made through Jarvis's own input
 * path, and records what was held, approved or refused. */
async function approvePending(ok) {
  const t = state.pendingAction
  state.pendingAction = null
  if (!t) { sys(paint(C.dimmer, 'nothing is waiting for approval')); return scheduleRender() }
  if (!ok) {
    securityLib.audit({ area: 'permission', action: 'denied', request: t })
    sys(paint(C.dimmer, '✗ cancelled'))
    return scheduleRender()
  }
  securityLib.audit({ area: 'permission', action: 'approved', request: t })
  sys(paint(C.green, '✓ approved'))
  return handle(t, { approved: true })
}

async function handle(text, opts = {}) {
  if (text.startsWith('/')) return command(text)
  if (!opts.approved) {
    if (state.pendingAction && /^(yes|y|approve|ok|do it)\b/i.test(text.trim())) return approvePending(true)
    if (state.pendingAction && /^(no|n|cancel|stop)\b/i.test(text.trim())) return approvePending(false)
    const risk = securityLib.risk(text)
    if (risk.needsApproval && risk.level !== 'none') {
      state.pendingAction = text
      securityLib.audit({ area: 'permission', action: 'held', request: text, level: risk.level, reasons: risk.reasons })
      sys(paint(C.amber, '⚠ this needs your approval: ' + risk.reasons.join('; ')))
      if (!INTERACTIVE && process.env.JARVIS_ALLOW_RISKY !== '1') {
        state.pendingAction = null
        sys(paint(C.dimmer, 'one-shot mode refuses risky actions (set JARVIS_ALLOW_RISKY=1 to allow).'))
        return scheduleRender()
      }
      sys(paint(C.dimmer, 'type /yes to run it, /no to cancel'))
      return scheduleRender()
    }
  }
  // local intents first
  const intent = intentLib.parseIntent ? intentLib.parseIntent(text) : null
  if (intent) { you(text); return runIntent(intent) }
  const rem = remindersLib.parseReminder ? remindersLib.parseReminder(text) : null
  if (rem) {
    you(text)
    const res = addReminder(rem)
    sys(res.ok ? `⏰ ${rem.when} — ${rem.task}` : '✗ could not set that reminder')
    return scheduleRender()
  }
  const note = remindersLib.parseNote ? remindersLib.parseNote(text) : null
  if (note) {
    you(text)
    addList(NOTE_FILE, { id: 'n' + Date.now().toString(36), text: note.text, at: Date.now() })
    sys(`→ noted: ${note.text}`)
    return scheduleRender()
  }
  you(text)
  if (state.orchestrate && orchestra.shouldOrchestrate(text)) return askOrchestra(text)
  await askAgent(text)
}

/* The manager loop: plan → dispatch in parallel → validate → retry → merge.
 * Every step is a dim think line under the question, and the sidebar names the
 * agent that is working right now. A result that fails validation is never
 * printed as an answer. */
async function askOrchestra(text) {
  state.busy = true
  state.busySince = Date.now()
  state.status = 'orchestrating'
  state.agentNow = 'manager'
  const t0 = Date.now()
  const mark2 = (m) => {
    if (!state.trace) return
    addLine('think', m + (state.showTiming ? '  +' + ((Date.now() - t0) / 1000).toFixed(1) + 's' : ''))
    scheduleRender()
  }
  mark2('manager · planning')
  scheduleRender()
  try {
    const r = await orchestra.solve(text, {
      onTrace: (e) => {
        if (e.agent) state.agentNow = e.agent
        const who = e.agent ? String(e.agent) + ' ' : ''
        const t = String(e.text == null ? '' : e.text).slice(0, 90)
        if (e.phase === 'dispatch') mark2('→ ' + who + '· ' + t)
        else if (e.phase === 'agent') mark2((e.ok ? '✓ ' : '✗ ') + who + t + (e.secs != null ? ' ' + e.secs + 's' : ''))
        else if (e.phase === 'validate') mark2((e.ok ? '✓ ' : '✗ ') + 'validate ' + who + t)
        else if (e.phase === 'retry') mark2('↻ ' + who + t)
        else if (e.phase === 'round') mark2('· round ' + e.round + ' · ' + t)
        else if (e.phase === 'merge') mark2('· ' + who + t)
        else if (e.phase === 'answer') mark2((e.ok ? '✓ ' : '✗ ') + 'answer · ' + t)
        else if (e.phase === 'plan') mark2('· plan ' + t)
        else if (e.phase === 'start') mark2('· ' + t)
        scheduleRender()
      },
    })
    if (r.ok) {
      jarvis(r.answer)
      state.lastAnswer = { ms: Date.now() - t0, tokIn: 0, tokOut: 0, modelMs: 0, at: Date.now() }
    } else {
      sys(paint(C.amber, '⚠ no validated answer — ' + r.reason))
      sys(paint(C.dimmer, 'the result was rejected, so it is not being shown as an answer. /reflect shows what the agents have been doing.'))
      alerts.raise('unavailable', 'orchestra rejected every result: ' + r.reason, {})
    }
    try { state.perf = health.performance({ contextTokens: state.tokens.context }) } catch {}
  } catch (e) {
    sys('✗ ' + (e && e.message ? e.message : String(e)))
  } finally {
    state.busy = false
    state.busySince = 0
    state.agentNow = null
    state.status = 'ready'
    scheduleRender()
  }
}

async function askAgent(text) {
  state.busy = true
  state.busySince = Date.now()
  state.status = 'thinking'
  state.thinking = []
  const t0 = Date.now()
  let answered = false
  const post = []
  const mark = (m) => {
    if (!state.trace) return
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (answered) { post.push(m); return }      // keep the answer clean
    addLine('think', m + (state.showTiming ? '  +' + secs + 's' : ''))
    scheduleRender()
  }
  mark('asking ' + state.model)
  try {
    const c = bridge.pickChoice()
    if (c && c.model) { state.model = c.model; state.provider = c.provider }
  } catch {}
  scheduleRender()
  let first = true
  try {
    const res = await bridge.ask(text, {
      onTrace: (evt) => {
        if (!state.trace || !evt) return
        const oneLine = (v) => String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)))
          .replace(/\s+/g, ' ').trim().slice(0, 120)
        const name = oneLine(evt.name || evt.tool || evt.tool_name || evt.toolName)
        const cmd = evt.input && typeof evt.input === 'object'
          ? (evt.input.command || evt.input.path || evt.input.query || evt.input.pattern || evt.input.url || '')
          : ''
        const arg = oneLine(cmd || evt.command || evt.input || evt.args || evt.arguments || '')
        if (evt.type === 'tool_use') mark('→ ' + (name || 'tool') + (arg ? ' ' + arg : ''))
        else if (evt.type === 'tool_result') mark('✓ ' + (name || 'tool') + ' done')
        else if (evt.type === 'thinking' || evt.type === 'reasoning') {
          const t = oneLine(evt.text || evt.thinking || evt.reasoning || evt.content)
          if (t) mark('… ' + t)
        } else if (evt.type === 'status') {
          const t = oneLine(evt.status || evt.message || evt.text)
          if (t) mark('· ' + t)
        }
      },
      onDelta: (d) => {
        if (first && state.trace) mark('first token')
        const clean = first ? String(d).replace(/^\n+/, '') : d
        const last = state.lines[state.lines.length - 1]
        if (first) {
          first = false
          answered = true
          state.lines.push({ role: 'jarvis', text: clean, streaming: true })
        } else if (last && last.streaming) {
          last.text += d
        } else {
          state.lines.push({ role: 'jarvis', text: d, streaming: true })
        }
        scheduleRender()
      },
      onLearn: (facts) => {
        for (const f of facts) sys(paint(C.violet, 'learned: ') + f)
        scheduleRender()
      },
      onSwitch: (next, why) => {
        state.model = next.model
        state.provider = next.provider
        sys(paint(C.violet, '↻ switched to ' + next.model + ' — ' + why.plain))
        scheduleRender()
      },
      onNotice: (kind, detail) => {
        sys(paint(C.amber, '⚠ ' + detail))
        alerts.raise(kind, detail, {})
        scheduleRender()
      },
      onMeta: (m) => {
        if (state.trace) {
          if (m.tokens) mark('tokens ' + m.tokens.input + ' in / ' + m.tokens.output + ' out')
          if (m.durationMs) mark('model ' + m.durationMs + ' ms')
          if (m.sessionId) mark('session ' + String(m.sessionId).slice(0, 14))
        }
        if (m.tokens) {
          state.tokens.lastIn = m.tokens.input || 0
          state.tokens.lastOut = m.tokens.output || 0
          state.tokens.sessionIn += m.tokens.input || 0
          state.tokens.sessionOut += m.tokens.output || 0
          state.tokens.context = m.contextTokens || 0
        }
        if (m.sessionId) state.session = String(m.sessionId).slice(0, 12)
        if (m.durationMs) state.lastMs = m.durationMs
        scheduleRender()
      },
    })
    // finalise whatever streamed
    const last = state.lines[state.lines.length - 1]
    if (last && last.role === 'jarvis') {
      last.streaming = false
      if (res.text) last.text = res.text
      if (!res.ok) last.role = 'sys'
    } else if (res.text) {
      jarvis(res.text)
    }

    /* Nothing junk reaches the transcript as an answer: an error page, a stack
     * trace, an echo or an empty reply becomes one plain sentence + a toast. */
    const verdict = res.stopped ? { ok: true } : res.ok ? quality.assess(res.text) : { ok: false, kind: health.classifyFailure(res.text).kind }
    if (!verdict.ok) {
      const d = quality.describeFailure(res.text, verdict.kind)
      const lastLine = state.lines[state.lines.length - 1]
      if (lastLine && lastLine.role === 'jarvis') { lastLine.role = 'sys'; lastLine.text = '⚠ ' + d.headline }
      else sys(paint(C.amber, '⚠ ' + d.headline))
      if (d.detail) sys(paint(C.dimmer, d.detail))
      const limited = verdict.kind === 'rate_limit' || verdict.kind === 'context' || verdict.kind === 'overloaded'
      alerts.raise(limited ? 'limited' : 'unavailable', (state.model || 'model') + ' — ' + d.headline.replace(/^No answer — /, ''), {})
    } else {
      /* The manager checks the answer: arithmetic is recomputed locally, JSON is
       * parsed, and (opt-in) a second model can review it. */
      const check = verify.verdict(text, res.text)
      const cross = check.ok ? await verify.crossCheck(text, res.text) : { checked: false }
      if (!check.ok) {
        sys(paint(C.amber, '⚠ check failed: ' + check.reason + (check.right != null ? ' — correct value: ' + check.right : '')))
        alerts.raise('junk', 'answer failed verification: ' + check.reason, {})
      } else if (!cross.ok) {
        sys(paint(C.amber, '⚠ second opinion: ' + (cross.reason || 'the other model disagrees')))
      } else if (check.checked || cross.checked) sys(paint(C.dimmer, '✓ verified'))
    }
  } catch (e) {
    sys('✗ ' + (e && e.message ? e.message : String(e)))
    mark('failed: ' + (e && e.message ? e.message : String(e)))
  } finally {
    const total = Date.now() - t0
    const modelMs = state.lastMs && state.lastMs !== total ? state.lastMs : 0
    state.lastMs = total
    state.lastAnswer = {
      ms: total,
      tokIn: state.tokens.lastIn,
      tokOut: state.tokens.lastOut,
      modelMs,
      at: Date.now(),
    }
    state.busy = false
    state.busySince = 0
    state.status = 'ready'
    try { state.perf = health.performance({ contextTokens: state.tokens.context }) } catch {}
    scheduleRender()
  }
}

/* -------------------------------------------------------------------- lists */
function readList(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
}
function addList(file, item) {
  const list = readList(file)
  list.push(item)
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(list, null, 2)) } catch {}
  return item
}
function addReminder(r) {
  if (!r || !Number.isFinite(r.at) || r.at <= Date.now()) return { ok: false }
  const item = { id: 'r' + Date.now().toString(36), at: r.at, kind: r.kind, task: r.task, created: Date.now() }
  addList(REMINDER_FILE, item)
  const t = setTimeout(() => {
    sys(`⏰ ${r.kind === 'timer' ? 'timer' : 'reminder'} — ${r.task}`)
    scheduleRender()
    try { process.stdout.write('\x07') } catch {}
  }, r.at - Date.now())
  t.unref?.()
  return { ok: true, item }
}

/* ----------------------------------------------------------------- intents */
async function runIntent(intent) {
  try {
    if (intent.kind === 'app' || intent.kind === 'url') {
      const target = intent.target
      const cmd = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', target]] : ['xdg-open', [target]]
      require('child_process').spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      sys(`→ ${intent.kind === 'url' ? 'opened' : 'launched'} ${intent.label}`)
      return scheduleRender()
    }
    if (intent.kind === 'run') {
      sys(`→ $ ${intent.target}`)
      scheduleRender()
      await new Promise((resolve) => {
        const child = require('child_process').spawn(intent.target, { shell: true, windowsHide: true })
        child.stdout.on('data', (d) => { addLine('jarvis', String(d).replace(/\s+$/, '')); scheduleRender() })
        child.stderr.on('data', (d) => { addLine('sys', String(d).replace(/\s+$/, '')); scheduleRender() })
        child.on('close', resolve)
        child.on('error', (e) => { sys('✗ ' + e.message); resolve() })
      })
      return scheduleRender()
    }
    if (intent.kind === 'read') {
      sys(`→ reading ${intent.target}`)
      scheduleRender()
      const res = await fetchPage(intent.target)
      if (!res.ok) { sys('✗ ' + res.error); return scheduleRender() }
      if (intent.summarize) return askAgent(`Answer from this page only, in 3 short bullets, no preamble.\nPage: ${intent.target}\n\n${res.text.slice(0, 6000)}`)
      addLine('jarvis', res.text.slice(0, 1200) + (res.text.length > 1200 ? '\n…' : ''))
      return scheduleRender()
    }
  } catch (e) {
    sys('✗ ' + (e && e.message ? e.message : String(e)))
    scheduleRender()
  }
}

function fetchPage(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http')
    const req = lib.get(url, { headers: { 'user-agent': 'jarvis-cli' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(fetchPage(new URL(res.headers.location, url).toString()))
      }
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        const text = data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ').trim()
        resolve({ ok: true, text })
      })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
  })
}

/* ---------------------------------------------------------------- commands */
const HELP = [
  ['/help', 'this list'],
  ['/look [question]', 'screenshot the screen and ask the vision specialist'],
  ['/agents', 'list the agent registry: model, provider, status'],
  ['/agents run <name> <task>', 'send one task straight to one registered agent'],
  ['/cascade <task>', 'try agents in order until one answers (failover)'],
  ['/solve <task>', 'manager loop: plan, parallel agents, validate, retry, merge'],
  ['/race <task>', 'same question to several agents; best validated answer wins'],
  ['/orchestra [on|off]', 'route specialist questions through the manager loop'],
  ['/ui list|click|type', 'accessibility-first control of desktop apps'],
  ['/graph [open]', 'render the agent brain network to data/graph.html'],
  ['/serve [on|stop|pair|approve|passwd]', 'local gateway: /status /ask /bg · one-time pairing codes'],
  ['/models [refresh|all|use|on|off]', 'every reachable LLM, ranked by measured health · local included'],
  ['/perf [bench]', 'AI performance: availability, reliability, speed, headroom, benchmark'],
  ['/preview [list|demo|<name>]', 'open a local HTML preview (canva/design skills)'],
  ['/verify [cross|off]', 'answer checking: deterministic always, cross-model optional'],
  ['/auto [on|off]', 'switch model automatically on a limit or failure'],
  ['/heal', 'probe the current model; switch if it is down'],
  ['/alerts [on|off|test|recent]', 'desktop notifications for limits and failures'],
  ['/reflect [reset]', 'distil past runs into routing preferences'],
  ['/paper <check|run|env> [dir] [template]', 'drive paper-orchestra (LaTeX paper writer)'],
  ['/visionbench [element] [trials]', 'measure vision coordinates against UIA ground truth'],
  ['/security [status|scan|baseline|audit]', 'self-check, change monitor, audit log'],
  ['/yes · /no', 'approve or cancel a request the guard is holding'],
  ['/quit', 'leave'],
  ['/bg <task>', 'run a task in the background, no window, toast on finish'],
  ['/bg list|log <id>|kill <id>', 'manage background jobs'],
  ['/browse <url>', 'open a page in your own Chrome (CDP, no bundled browser)'],
  ['/vpn [on|off|set|diag|bypass]', 'tunnel status; TUN diag; keep the provider off the tunnel'],
  ['/takeover <task>', 'let Jarvis drive the mouse and keyboard (robot cursor on)'],
  ['/takeover off', 'take the pointer back now'],
  ['/team <task>', 'upper manager: plan, dispatch specialists, merge'],
  ['/team log', 'what the team learned about its own agents'],
  ['/team learn <task>', 'run it, then draft a skill from the procedure'],
  ['/think [on|off]', 'show or hide the procedure under each question'],
  ['/timing [on|off]', 'show or hide the +0.0s timings on those lines'],
  ['/model [name]', 'show or set the model (used for the next new session)'],
  ['/agent [cloud|local]', 'where answers come from'],
  ['/new', 'start a fresh conversation'],
  ['/clear', 'wipe the transcript'],
  ['/tokens', 'token usage for this session'],
  ['/hw', 'hardware snapshot'],
  ['/sys', 'OS, uptime, disk, node version'],
  ['/open <app|url>', 'launch an app or a site'],
  ['/run <cmd>', 'run a shell command'],
  ['/read <url>', 'fetch a page, or "and summarize it"'],
  ['/ls [dir]', 'list a folder'],
  ['/cat <file>', 'print a file'],
  ['/remind <in 10 min|at 18:30|tomorrow 9> <text>', 'set a reminder'],
  ['/reminders [clear]', 'list or clear reminders'],
  ['/note <text>', 'save a note'],
  ['/notes [clear]', 'list or clear notes'],
  ['/memory', 'what Jarvis remembers about you'],
  ['/forget <text>', 'drop matching facts'],
  ['/tabs · /tab <n> · /chrome', 'list, read a Chrome tab, launch CDP Chrome'],
  ['/messages [n]', 'recent notifications from every app on the PC'],
  ['/msg <app>', 'read an open WhatsApp/Telegram/X/… tab'],
  ['/find <term>', 'search notification history'],
  ['/summarize [term]', 'summarise the last search or the recent messages'],
  ['/skill save <name>', 'write a skill from what we just did'],
  ['/skill auto [name]', 'let the local model write the skill'],
  ['/summary', 'summarise this session (local model)'],
  ['/sessions', 'session notes on disk'],
  ['/remember <fact>', 'store a fact about you'],
  ['/recall [term]', 'what it knows, or search it'],
  ['/models', 'local Ollama models'],
  ['/local on|off', 'answer from the local model only'],
  ['/skills · /skill show|rm <name>', 'manage self-written skills'],
  ['/profile', 'what Jarvis learned about your style'],
  ['/quit', 'leave'],
]

async function command(raw) {
  const [name, ...rest] = raw.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  const cmd = name.toLowerCase()
  you(raw)

  switch (cmd) {
    case 'help': case 'h': case '?':
      for (const [c, d] of HELP) sys(pad(c, 34) + ' ' + d)
      break

    case 'solve': {
      const t = String(arg || '').trim()
      if (!t) { sys(paint(C.dimmer, 'usage: /solve <task>   (manager plans, agents run in parallel, results are validated)')); break }
      return askOrchestra(t)
    }

    case 'race': {
      const t = String(arg || '').trim()
      if (!t) { sys(paint(C.dimmer, 'usage: /race <task>   (same question to several agents, best validated answer wins)')); break }
      you(t)
      state.busy = true
      state.busySince = Date.now()
      const t0 = Date.now()
      const mark3 = (m) => { if (state.trace) addLine('think', m + (state.showTiming ? '  +' + ((Date.now() - t0) / 1000).toFixed(1) + 's' : '')); scheduleRender() }
      try {
        const r = await orchestra.race(t, { onTrace: (e) => {
          if (e.agent) state.agentNow = e.agent
          if (e.phase === 'start') mark3('· ' + e.text)
          else if (e.phase === 'agent') mark3((e.ok ? '✓ ' : '✗ ') + e.agent + ' ' + e.text)
          else if (e.phase === 'answer') mark3((e.ok ? '✓ ' : '✗ ') + e.text)
        } })
        if (r.ok) {
          jarvis(r.answer)
          const others = r.results.filter((x) => x.agent !== r.winner.agent)
          if (others.length) sys(paint(C.dimmer, 'compared with ' + others.map((x) => x.agent + ' ' + Math.round(x.score * 100) + '%').join(', ')))
          state.lastAnswer = { ms: Date.now() - t0, tokIn: 0, tokOut: 0, modelMs: 0, at: Date.now() }
        } else sys(paint(C.amber, '⚠ no valid answer — ' + r.reason))
      } catch (e) { sys('✗ ' + e.message) }
      finally { state.busy = false; state.busySince = 0; state.agentNow = null; scheduleRender() }
      break
    }

    case 'orchestra': {
      const v = String(arg || '').trim().toLowerCase()
      if (v === 'on' || v === 'off') state.orchestrate = v === 'on'
      sys(paint(C.dimmer, 'manager loop is ' + (state.orchestrate ? 'on for vision/calc/search/shell tasks' : 'off — /ask goes straight to one model')))
      break
    }

    case 'yes': case 'approve':
      return approvePending(true)

    case 'no': case 'cancel':
      return approvePending(false)

    case 'models': {
      const v = String(arg || '').trim()
      if (v === 'refresh' || v === 'all') {
        sys(paint(C.dimmer, 'probing the inventory — one small question per model...'))
        scheduleRender()
        const steps = []
        await models.refresh({ all: v === 'all', onStep: (s) => {
          sys(pad(s.id, 14) + (s.ok ? paint(C.green, 'ok  ') : paint(C.red, 'fail')) + ' ' + (s.secs != null ? s.secs + 's' : '') + '  ' + String(s.text || '').slice(0, 60))
          scheduleRender()
        } })
        sys(paint(C.dimmer, 'done · ' + models.status().length + ' usable'))
        break
      }
      if (v.startsWith('use ')) {
        const id = v.slice(4).trim()
        const reg = models.load()
        const e = (reg.models || []).find((x) => x.id === id || x.model === id)
        if (!e) { sys(paint(C.red, 'no model with id ' + id)); break }
        config.model = e.model; config.provider = e.provider; saveConfig()
        bridge.settings.model = e.model; bridge.settings.provider = e.provider
        state.model = e.model; state.provider = e.provider
        securityLib.audit({ area: 'model', action: 'select', model: e.model, provider: e.provider })
        sys(paint(C.green, '→ ' + e.model + ' (' + e.provider + ')'))
        break
      }
      if (v.startsWith('on ') || v.startsWith('off ')) {
        const id = v.slice(3).trim()
        const ok = models.setEnabled(id, v.startsWith('on '))
        sys(paint(C.dimmer, ok ? id + (v.startsWith('on ') ? ' enabled' : ' disabled') : 'no model ' + id))
        break
      }
      const rows = models.status({ all: true })
      for (const r of rows) {
        const state2 = r.usable ? (r.cooling ? paint(C.amber, 'cooling') : r.status === 'ok' ? paint(C.green, 'ok') : r.attempts ? paint(C.red, r.status) : paint(C.dimmer, 'untested')) : paint(C.dimmer, 'no key')
        sys(pad(r.id, 18) + pad(r.model, 30) + pad(String(Math.round(r.score * 100)), 5) + pad(r.secs != null ? r.secs + 's' : '—', 7) + state2 + (r.local ? paint(C.violet, ' local') : ''))
      }
      sys(paint(C.dimmer, '/models refresh | all | use <id> | on|off <id>'))
      break
    }

    case 'perf': {
      const v = String(arg || '').trim()
      if (v === 'bench' || v === 'bench all') {
        sys(paint(C.dimmer, 'running the 3-task benchmark on the top models...'))
        scheduleRender()
        const rows = await bench.runAll({ limit: v === 'bench all' ? 6 : 3, onStep: (r) => {
          sys(pad(r.id, 16) + pad(Math.round(r.score * 100) + '%', 6) + r.secs + 's')
          scheduleRender()
        } })
        const avg = bench.latestScore()
        sys(paint(C.green, 'benchmark average ' + (avg != null ? Math.round(avg * 100) + '%' : '—') + ' · saved to data/bench.json'))
        refreshStatus()
        break
      }
      const p = health.performance({ contextTokens: state.tokens.context })
      const pct = (n) => Math.round(n * 100) + '%'
      sys(paint(C.dimmer, 'AI PERFORMANCE'))
      sys(' ' + bar(p.score, 14) + ' ' + paint(C.bright, p.score + '%') + ' ' + paint(C.steel, p.label))
      sys(paint(C.dimmer, 'availability ') + pad(pct(p.parts.availability), 6) + paint(C.dimmer, 'reliability ') + pad(pct(p.parts.reliability), 6) + paint(C.dimmer, 'speed ') + pad(pct(p.parts.speed), 6) + paint(C.dimmer, 'headroom ') + pct(p.parts.headroom))
      sys(paint(C.dimmer, 'benchmark ') + (p.parts.benchmark != null ? pct(p.parts.benchmark) : 'not measured — /perf bench'))
      sys(paint(C.dimmer, 'median ' + (p.medianSecs != null ? p.medianSecs + 's' : '—') + ' · ' + p.attempts + ' recorded attempt(s)'))
      const last = health.lastFailure()
      if (last) sys(paint(C.amber, 'last failure: ' + (last.key || last.agent) + ' · ' + (last.status || 'failed')))
      break
    }

    case 'preview': {
      const a = String(arg || '').trim()
      if (a === 'stop') { preview.stop(); sys(paint(C.dimmer, 'preview server stopped')); break }
      if (!a || a === 'list') {
        const items = preview.list()
        if (!items.length) { sys(paint(C.dimmer, 'no previews yet — /preview demo')); break }
        for (const i of items.slice(0, 10)) sys(pad(i.name, 32) + paint(C.dimmer, new Date(i.at).toLocaleString()))
        sys(paint(C.dimmer, '/preview <name> to open one'))
        break
      }
      if (a === 'demo') {
        const d = preview.demo()
        const r = await preview.show(d.file)
        sys(r.ok ? paint(C.green, '✓ opened ' + r.url) : paint(C.red, '✗ ' + r.error))
        break
      }
      const r = await preview.show(a)
      sys(r.ok ? paint(C.green, '✓ opening ' + r.url) : paint(C.red, '✗ ' + r.error))
      break
    }

    case 'verify': {
      const v = String(arg || '').trim().toLowerCase()
      if (v === 'cross' || v === 'on') process.env.JARVIS_VERIFY = 'cross'
      else if (v === 'off') delete process.env.JARVIS_VERIFY
      sys(paint(C.dimmer, 'verification: deterministic checks always on' + (verify.crossEnabled() ? ' + cross-model second opinion' : ' · /verify cross for a second model')))
      break
    }

    case 'auto': {
      const v = String(arg || '').trim().toLowerCase()
      if (v === 'on' || v === 'off') bridge.settings.autoSwitch = v === 'on'
      sys(paint(C.dimmer, 'auto-switch is ' + (bridge.settings.autoSwitch ? 'on' : 'off') + ' · /auto on|off'))
      break
    }

    case 'heal': {
      sys(paint(C.dimmer, 'probing the current model...'))
      scheduleRender()
      const r = await bridge.selfCheck()
      if (r.ok) { sys(paint(C.green, '✓ ' + r.model + ' answered in ' + r.secs + 's')); break }
      sys(paint(C.red, '✗ ' + r.model + ' failed: ' + (r.text || r.error || 'no answer')))
      const next = models.best([r.model])
      if (next) {
        config.model = next.model; config.provider = next.provider; saveConfig()
        bridge.settings.model = next.model; bridge.settings.provider = next.provider
        state.model = next.model; state.provider = next.provider
        alerts.raise('switched', 'moved to ' + next.model, {})
        sys(paint(C.violet, '↻ switched to ' + next.model + ' for new turns'))
      } else sys(paint(C.amber, 'no other model is usable — check keys with /models'))
      break
    }

    case 'alerts': {
      const v = String(arg || '').trim().toLowerCase()
      if (v === 'off') { process.env.JARVIS_ALERTS = 'off'; sys(paint(C.dimmer, 'desktop alerts off')) }
      else if (v === 'on') { delete process.env.JARVIS_ALERTS; sys(paint(C.dimmer, 'desktop alerts on')) }
      else if (v === 'test') { const t = alerts.test(); sys(paint(C.dimmer, t.toasted ? 'test notification sent' : 'notification attempted (toast may be blocked)')) }
      else if (v === 'recent') {
        for (const a of alerts.recent(8)) sys(paint(C.dimmer, new Date(a.at).toTimeString().slice(0, 5) + '  ' + a.kind + '  ' + String(a.message || '').slice(0, 70)))
      } else sys(paint(C.dimmer, 'alerts ' + (alerts.enabled() ? 'on' : 'off') + ' · /alerts on|off|test|recent'))
      break
    }

    case 'reflect': {
      if (String(arg || '').trim() === 'reset') { reflect.reset(); sys(paint(C.dimmer, 'preferences cleared')); break }
      const p = reflect.run()
      sys(paint(C.violet, 'reflected on ' + p.runs + ' run(s)'))
      for (const r of p.rules) sys(paint(C.steel, '· ' + r))
      for (const a of p.agents.slice(0, 6)) sys(pad(a.name, 12) + pad(a.rate + '%', 6) + pad('n=' + a.n, 6) + (a.secs ? a.secs + 's' : '') + '  ' + a.verdict)
      for (const m of p.models.slice(0, 6)) sys(pad(m.key.split('/').pop(), 28) + pad(m.rate + '%', 6) + (m.secs ? m.secs + 's' : '') + '  ' + m.verdict)
      sys(paint(C.dimmer, 'saved to ' + reflect.FILE + ' · injected into agent prompts'))
      break
    }

    case 'paper': {
      const parts = String(arg || '').trim().split(/\s+/)
      const sub = parts[0] || 'check'
      if (sub === 'env') {
        const e = papers.ensureEnv()
        sys(paint(C.dimmer, 'env written to ' + e.file + ' · gemini ' + (e.gemini ? 'yes' : 'no') + ' · openai ' + (e.openai ? 'yes' : 'no')))
        break
      }
      const materials = parts[1] || ''
      const template = parts[2] || 'iclr2025'
      const pre = papers.preflight({ materials })
      for (const c of pre.checks) sys((c.ok ? paint(C.green, '✓ ') : paint(C.red, '✗ ')) + pad(c.name, 18) + paint(C.dimmer, String(c.detail).slice(0, 60)))
      if (sub === 'check' || !materials) break
      if (!pre.ok) { sys(paint(C.red, 'preflight failed — fix the ✗ rows first')); break }
      sys(paint(C.dimmer, 'starting paper-orchestra · template ' + template + ' · log streams below'))
      scheduleRender()
      let n = 0
      const res = await papers.run({ materials, template }, (line) => {
        if (n++ < 300) { sys(line.slice(0, 130)); scheduleRender() }
      })
      sys(res.ok ? paint(C.green, '✓ paper finished → ' + res.output) : paint(C.red, '✗ paper failed (code ' + res.code + ')'))
      break
    }

    case 'visionbench': {
      const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
      const trials = Math.max(1, Math.min(6, Number(parts[0]) || 3))
      const element = parts.slice(1).join(' ').trim() || 'Address and search bar'
      sys(paint(C.dimmer, 'measuring vision coordinates against UIA · ' + trials + ' trial(s) · target "' + element + '"'))
      scheduleRender()
      const r = await visionbench.measure({ trials, element, onTrial: (t) => {
        sys(paint(C.dimmer, 'trial ' + t.trial + ' · ' + (t.ok ? Math.round(t.dist) + 'px off · ' + (t.inside ? 'hit' : 'miss') : t.error)))
        scheduleRender()
      } })
      if (!r.ok) { sys(paint(C.red, '✗ ' + r.error)); break }
      const s = r.summary
      sys(paint(C.bright, 'hit ' + s.hits + '/' + s.trials + ' (' + s.hitRate + '%) · median ' + s.medianPx + 'px · max ' + s.maxPx + 'px · avg ' + s.avgSecs + 's'))
      sys(paint(C.dimmer, 'element: ' + r.element + ' · saved to data/vision-accuracy.json'))
      visionbench.save(r)
      break
    }

    case 'security': {
      const v = String(arg || '').trim().split(/\s+/)[0] || 'status'
      if (v === 'audit') {
        const n = Number(String(arg || '').split(/\s+/)[1]) || 15
        for (const a of securityLib.recentAudit(n)) sys(paint(C.dimmer, String(a.at || '').slice(11, 19) + '  ' + pad(String(a.area || ''), 9) + String(a.action || '') + ' ' + String(a.request || a.detail || a.path || '').slice(0, 60)))
        break
      }
      if (v === 'scan' || v === 'baseline') {
        sys(paint(C.dimmer, v === 'baseline' ? 'scanning and replacing the baseline...' : 'scanning the machine...'))
        scheduleRender()
        const r = await sentinel.check({ setBase: v === 'baseline' })
        if (!r.ok) { sys(paint(C.red, '✗ scan failed: ' + r.error)); break }
        if (v === 'baseline') { sys(paint(C.green, '✓ baseline saved')); break }
        if (r.created) { sys(paint(C.green, '✓ first scan: baseline created — future scans compare against it')); break }
        if (!r.findings.length) sys(paint(C.green, '✓ nothing changed since the baseline'))
        for (const f of r.findings) sys((f.level === 'high' ? paint(C.red, '▲ ') : paint(C.amber, '· ')) + pad(f.area, 11) + f.detail)
        alerts.raise('security', r.findings.filter((f) => f.level === 'high').map((f) => f.detail).join('; ') || 'scan complete', { force: false })
        break
      }
      const self = securityLib.selfCheck()
      const gw = gateway.status()
      sys(paint(C.dimmer, 'SECURITY'))
      sys(' ' + pad('gateway', 12) + (gw.running ? paint(C.green, 'on') : paint(C.dimmer, 'off')) + paint(C.dimmer, ' · bind ') + gw.bind + paint(C.dimmer, ' · password ') + (gw.password ? 'hashed' : 'not set'))
      sys(' ' + pad('audit', 12) + securityLib.recentAudit(1000).length + paint(C.dimmer, ' events · ') + securityLib.AUDIT)
      sys(' ' + pad('self-check', 12) + (self.ok ? paint(C.green, 'no high findings') : paint(C.red, self.findings.filter((f) => f.level === 'high').length + ' high finding(s)')))
      for (const f of self.findings.slice(0, 8)) sys('   ' + (f.level === 'high' ? paint(C.red, '▲ ') : paint(C.amber, '· ')) + pad(f.area, 10) + f.detail)
      sys(paint(C.dimmer, '/security scan | baseline | audit [n]'))
      break
    }

    case 'quit': case 'exit': case 'q':
      return quit()

    case 'clear': case 'clr':
      state.lines = []
      sys('transcript cleared (memory kept — use /new for a fresh session)')
      break

    case 'new':
      bridge.resetSession()
      state.session = '—'
      state.tokens.sessionIn = 0
      state.tokens.sessionOut = 0
      state.lines = []
      sys('new conversation · session reset')
      break

    case 'model': {
      if (!arg) {
        sys(`model    ${state.model}`)
        sys(`provider ${state.provider}`)
        sys('set with: /model deepseek-v4-flash   (takes effect on /new)')
        break
      }
      config.model = arg
      saveConfig()
      bridge.settings.model = arg
      state.model = arg
      sys(`model → ${arg} (applies to the next new session; run /new to switch now)`)
      break
    }

    case 'agent': {
      if (!arg) { sys(`agent: ${config.provider || 'auto'} · local=${bridge.settings.preferLocal}`); break }
      if (arg === 'local') { bridge.settings.preferLocal = true; sys('agent → local only (no model)') }
      else if (arg === 'cloud') { bridge.settings.preferLocal = false; sys('agent → cloud') }
      else { config.provider = arg; saveConfig(); bridge.settings.provider = arg; state.provider = arg; sys(`provider → ${arg}`) }
      break
    }

    case 'tokens':
      sys(`turn    in ${state.tokens.lastIn} · out ${state.tokens.lastOut}`)
      sys(`session in ${state.tokens.sessionIn} · out ${state.tokens.sessionOut}`)
      sys(`context ${state.tokens.context || 0} tokens`)
      break

    case 'hw': {
      // sensors answer asynchronously: give the first poll a moment on a cold start
      if (state.hw.gpuTemp == null && state.hw.cpuTemp == null) {
        pollGpu(); pollCpuTemp(); pollDiskTemp()
        await new Promise((r) => setTimeout(r, 900))
      }
      refreshHw()
      const t = (c) => (c == null ? 'n/a' : Math.round(c) + '°C')
      sys(`CPU  ${Math.round(state.hw.cpu)}%  ${t(state.hw.cpuTemp)}   RAM ${Math.round(state.hw.ram)}%`)
      sys(`GPU  ${state.hw.gpuName || 'n/a'}  ${t(state.hw.gpuTemp)}${state.hw.gpuUtil != null ? '  ' + state.hw.gpuUtil + '%' : ''}`)
      if (state.hw.diskTemp != null) sys(`SSD  ${t(state.hw.diskTemp)}`)
      const used = state.hw.diskTotal ? 100 * (1 - state.hw.diskFree / state.hw.diskTotal) : 0
      sys(`disk ${used ? Math.round(used) + '% used · ' + (state.hw.diskFree / 1e9).toFixed(0) + ' GB free' : 'n/a'}`)
      break
    }

    case 'sys':
      sys(`${os.type()} ${os.release()} · ${os.arch()}`)
      sys(`cpu ${os.cpus().length} cores · ${(os.totalmem() / 1e9).toFixed(1)} GB RAM`)
      sys(`node ${process.version} · uptime ${Math.round(os.uptime() / 3600)}h · cwd ${process.cwd()}`)
      break

    case 'open':
      if (!arg) { sys('usage: /open notepad | /open github.com'); break }
      return runIntent({ kind: /^https?:\/\/|^[\w-]+(\.[\w-]+)+/.test(arg) ? 'url' : 'app', target: /^https?:\/\//.test(arg) ? arg : (/^[\w-]+(\.[\w-]+)+/.test(arg) ? 'https://' + arg : arg), label: arg })

    case 'run':
      if (!arg) { sys('usage: /run ipconfig'); break }
      return runIntent({ kind: 'run', target: arg, label: arg })

    case 'read':
      if (!arg) { sys('usage: /read example.com [and summarize it]'); break }
      return runIntent({ kind: 'read', target: /^https?:\/\//.test(arg) ? arg.split(' ')[0] : 'https://' + arg.split(' ')[0], label: arg.split(' ')[0], summarize: /summar/i.test(arg) })

    case 'ls': case 'dir': {
      const dir = arg || process.cwd()
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 60)
        sys(dir)
        for (const it of items) {
          const p = path.join(dir, it.name)
          let size = ''
          try { if (it.isFile()) size = (fs.statSync(p).size / 1024).toFixed(1) + 'k' } catch {}
          sys((it.isDirectory() ? '▸ ' : '  ') + it.name + (size ? '  ' + paint(C.dimmer, size) : ''))
        }
      } catch (e) { sys('✗ ' + e.message) }
      break
    }

    case 'cat': {
      if (!arg) { sys('usage: /cat <file>'); break }
      try {
        const t = fs.readFileSync(arg, 'utf8')
        const lines = t.split('\n').slice(0, 40)
        for (const l of lines) addLine('jarvis', l)
        if (t.split('\n').length > 40) sys(`… ${t.split('\n').length - 40} more lines`)
      } catch (e) { sys('✗ ' + e.message) }
      break
    }

    case 'remind': {
      const r = remindersLib.parseReminder ? remindersLib.parseReminder('remind me ' + arg) : null
      if (!r) { sys('usage: /remind in 10 min call mom · /remind at 18:30 stand up'); break }
      addReminder(r)
      sys(`⏰ ${r.when} — ${r.task}`)
      break
    }

    case 'reminders': {
      const list = readList(REMINDER_FILE).filter((r) => r.at > Date.now()).sort((a, b) => a.at - b.at)
      if (arg === 'clear') { fs.writeFileSync(REMINDER_FILE, '[]'); sys('reminders cleared'); break }
      if (!list.length) { sys('nothing scheduled'); break }
      for (const r of list) {
        const d = new Date(r.at)
        sys(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}  ${r.task}`)
      }
      break
    }

    case 'note': {
      if (!arg) { sys('usage: /note buy milk'); break }
      addList(NOTE_FILE, { id: 'n' + Date.now().toString(36), text: arg, at: Date.now() })
      sys('→ noted')
      break
    }

    case 'notes': {
      if (arg === 'clear') { fs.writeFileSync(NOTE_FILE, '[]'); sys('notes cleared'); break }
      const list = readList(NOTE_FILE).slice(-10).reverse()
      if (!list.length) { sys('no notes'); break }
      for (const n of list) sys('• ' + n.text)
      break
    }

    case 'memory': {
      const facts = memory.list()
      if (!facts.length) { sys('nothing learned yet — say "remember that …"'); break }
      for (const f of facts.slice(-12)) sys('• ' + f)
      break
    }

    case 'forget': {
      if (!arg) { sys('usage: /forget editor'); break }
      const n = memory.forget(arg)
      sys(`${n} fact(s) forgotten`)
      break
    }

    case 'tabs': {
      try {
        const list = await chromeLib.tabs()
        if (!list.length) { sys('Chrome is open but has no tabs.'); break }
        list.slice(0, 15).forEach((t, i) => {
          const tag = t.appLabel ? paint(C.green, '[' + t.appLabel + '] ') : ''
          sys(`${String(i + 1).padStart(2)}. ${tag}${(t.title || '(no title)').slice(0, 60)}`)
          sys(`    ${paint(C.dimmer, t.url.slice(0, 70))}`)
        })
      } catch (e) {
        sys('✗ Chrome not reachable on port 9222 — run /chrome')
      }
      break
    }

    case 'chrome': {
      const r = chromeLib.launch()
      sys(r.ok ? 'Chrome starting with the debug port (127.0.0.1:9222)…' : '✗ ' + r.error)
      break
    }

    case 'tab': {
      if (!arg) { sys('usage: /tab 2'); break }
      try {
        const list = await chromeLib.tabs()
        const t = list[parseInt(arg, 10) - 1]
        if (!t) { sys('no tab ' + arg); break }
        const r = await chromeLib.readTab(t.ws, { maxChars: 4000 })
        sys(`${t.title} — ${t.url}`)
        if (!r.ok) { sys('✗ ' + r.error); break }
        for (const line of chromeLib.messageLines(r.text, { max: 30 })) addLine('jarvis', line)
      } catch { sys('✗ Chrome not reachable — run /chrome') }
      break
    }

    case 'msg': case 'messages-app': {
      const kind = (arg || '').toLowerCase() || 'whatsapp'
      const r = await chromeLib.readApp(kind, { maxChars: 20000 })
      if (!r.ok) { sys('✗ ' + r.error); break }
      const lines = chromeLib.messageLines(r.text, { max: 25 })
      state.lastSearch = lines.map((l) => ({ app: kind, title: l, body: '', at: Date.now() }))
      state.lastSource = kind + ' (live tab)'
      sys(`${kind} — ${lines.length} lines from the open tab`)
      for (const l of lines) addLine('jarvis', l)
      break
    }

    case 'messages': {
      const n = parseInt(arg, 10) || 15
      const r = messagesLib.readNotifications({ limit: 200 })
      if (!r.ok) { sys('✗ ' + r.error); break }
      state.lastSearch = r.items
      state.lastSource = 'notification history'
      sys(`${r.items.length} notifications on this machine · newest first`)
      for (const it of r.items.slice(0, n)) {
        const when = it.at ? new Date(it.at).toLocaleTimeString().slice(0, 5) : '--:--'
        sys(`${when} ${paint(C.accent, '[' + it.app + ']')} ${it.title}${it.body ? ' — ' + it.body.slice(0, 70) : ''}`)
      }
      break
    }

    case 'find': {
      if (!arg) { sys('usage: /find invoice'); break }
      const r = messagesLib.readNotifications({ limit: 400 })
      if (!r.ok) { sys('✗ ' + r.error); break }
      const hits = messagesLib.search(r.items, arg)
      state.lastSearch = hits
      state.lastSource = `search "${arg}" in notifications`
      if (!hits.length) { sys(`nothing matches "${arg}"`); break }
      sys(`${hits.length} matches for "${arg}"`)
      for (const it of hits.slice(0, 12)) {
        const when = it.at ? new Date(it.at).toLocaleString().slice(0, 16) : ''
        sys(`${paint(C.dimmer, when)} ${paint(C.accent, '[' + it.app + ']')} ${it.title.slice(0, 40)} — ${it.body.slice(0, 80)}`)
      }
      break
    }

    case 'summarize': {
      let items = state.lastSearch
      let source = state.lastSource
      if (!items || !items.length) {
        const r = messagesLib.readNotifications({ limit: 200 })
        if (!r.ok) { sys('✗ ' + r.error); break }
        items = arg ? messagesLib.search(r.items, arg) : r.items
        source = arg ? `search "${arg}"` : 'notification history'
      }
      if (!items.length) { sys('nothing to summarise — run /messages or /find first'); break }
      const block = items.slice(0, 40).map((it) => `[${it.app}] ${it.title}${it.body ? ': ' + it.body.slice(0, 200) : ''}`).join('\n')
      return askAgent(
        `Summarise these ${items.length} messages from ${source}. Group by sender/app, call out anything that needs a reply or a decision, and keep it under 120 words. Do not invent anything.\n\n${block}`
      )
    }

    case 'msgapps': {
      const list = await chromeLib.tabs().catch(() => [])
      const found = [...new Set(list.filter((t) => t.app).map((t) => t.app))]
      sys(found.length ? 'open apps: ' + found.join(', ') : 'no message apps open in Chrome — run /chrome then open one')
      break
    }

    case 'skill': {
      const [sub, ...rest2] = arg.split(/\s+/)
      if (!sub || sub === 'list') {
        const all = skillsLib.list()
        if (!all.length) { sys('no skills yet — /skill save <name>  (writes what we just did)'); break }
        for (const sk of all) sys(paint(C.accent, sk.name) + (sk.when ? paint(C.dimmer, '  when: ' + sk.when) : ''))
        break
      }
      if (sub === 'save') {
        const name = rest2.join(' ').trim() || 'conversation-' + new Date().toISOString().slice(0, 10)
        const body = skillsLib.fromTranscript(state.lines, { max: 30 })
        const when = state.history.slice(-5).join(' ')
        const r = skillsLib.save({ name, when, body })
        sys(`skill saved: ${paint(C.accent, name)} → ${path.relative(ROOT, r.file)}`)
        sys(paint(C.dimmer, 'it will be offered automatically next time the same words come up'))
        break
      }
      if (sub === 'auto') {
        sys(paint(C.dimmer, 'drafting a skill from this conversation with the local model…'))
        scheduleRender()
        const made = await bridge.learner.draftSkill(state.lines, { name: rest2.join(' ').trim() })
        if (!made) { sys('nothing repeatable to save yet — do the task first, then /skill auto'); break }
        sys(paint(C.violet, 'skill written: ') + made.name + (made.when ? paint(C.dimmer, '  when: ' + made.when) : ''))
        sys(paint(C.dimmer, 'it will be offered automatically next time you ask for this'))
        break
      }
      if (sub === 'show') {
        const one = skillsLib.read(rest2.join(' '))
        if (!one) { sys('no such skill'); break }
        sys(paint(C.accent, one.name) + (one.when ? paint(C.dimmer, '  when: ' + one.when) : ''))
        for (const line of one.body.split('\n')) sys(line)
        break
      }
      if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
        const ok = skillsLib.remove(rest2.join(' '))
        sys(ok ? 'skill removed' : 'no such skill')
        break
      }
      sys('usage: /skill save <name> · /skill show <name> · /skill rm <name> · /skill list')
      break
    }

    case 'skills': {
      const all = skillsLib.list()
      if (!all.length) { sys('no skills yet — /skill save <name>'); break }
      for (const sk of all) sys(paint(C.accent, sk.name) + (sk.when ? paint(C.dimmer, '  when: ' + sk.when.slice(0, 60)) : ''))
      break
    }

    case 'profile': {
      try {
        const hint = profileLib.styleHint ? profileLib.styleHint() : ''
        sys(hint || 'nothing learned about your style yet — keep talking')
      } catch { sys('profile unavailable') }
      break
    }

    case 'remind-all': {
      sys('usage: /reminders')
      break
    }

    case 'summary': {
      sys(paint(C.dimmer, 'summarising this session with the local model…'))
      scheduleRender()
      const sum = await bridge.session.summarise('default')
      state.lines = state.lines.filter((l) => !l.transient)
      if (!sum) { sys('nothing to summarise yet'); break }
      sys(paint(C.accent, 'session so far:'))
      for (const line of sum.split('\n')) sys(line)
      break
    }

    case 'sessions': {
      const list = bridge.session.list()
      if (!list.length) { sys('no session notes yet'); break }
      for (const s2 of list.slice(0, 8)) {
        const when = s2.updated ? new Date(s2.updated).toLocaleString().slice(0, 16) : ''
        sys(paint(C.dimmer, when + ' ') + paint(C.accent, s2.name) + ' — ' + (s2.summary || '').slice(0, 60))
      }
      break
    }

    case 'remember': {
      if (!arg) { sys('usage: /remember my repos live on D:'); break }
      const ok = memory.add(arg)
      sys(ok ? paint(C.violet, 'remembered: ') + arg : 'already knew that, or it looked like a secret')
      break
    }

    case 'recall': {
      if (!arg) {
        const facts = memory.list()
        sys(facts.length ? facts.slice(-10).map((f) => '• ' + f).join('\n') : 'nothing learned yet')
        break
      }
      const hits = memory.recall(arg, 6)
      if (!hits.length) { sys('nothing matches that'); break }
      for (const h of hits) sys('• ' + h)
      break
    }

    case 'models': {
      const list = await bridge.ollama.models()
      if (!list.length) { sys('ollama is not reachable on 127.0.0.1:11434'); break }
      for (const m of list) sys(paint(C.accent, m.name) + paint(C.dimmer, '  ' + (m.params || '') + '  ' + ((m.size || 0) / 1e9).toFixed(1) + ' GB'))
      sys(paint(C.dimmer, 'local model: ' + bridge.ollama.MODEL))
      break
    }

    case 'local': {
      if (arg === 'on') { bridge.settings.preferLocal = true; sys('local only — answers come from Ollama, no network needed') }
      else if (arg === 'off') { bridge.settings.preferLocal = false; sys('back to the cloud agent') }
      else sys('local: ' + (bridge.settings.preferLocal ? 'on' : 'off') + '  (use /local on|off)')
      break
    }

    case 'think': {
      if (arg === 'on') state.trace = true
      else if (arg === 'off') state.trace = false
      else state.trace = !state.trace
      sys('thinking ' + (state.trace ? 'ON' : 'OFF'))
      break
    }

    case 'timing': {
      if (arg === 'on') state.showTiming = true
      else if (arg === 'off') state.showTiming = false
      else state.showTiming = !state.showTiming
      sys('timing ' + (state.showTiming ? 'ON' : 'OFF'))
      break
    }

    case 'agents': {
      const aParts = String(arg || '').trim().split(/\s+/)
      if (aParts[0] === 'run') {
        const who = aParts[1]
        const task = aParts.slice(2).join(' ')
        if (!who || !task) { sys(paint(C.dimmer, 'usage: /agents run <name> <task>')); break }
        const one = agents.get(who)
        if (!one) { sys(paint(C.dimmer, 'unknown agent: ' + who + ' - try /agents')); break }
        sys(paint(C.dimmer, '-> ' + one.name + ' (' + one.model + ')'))
        scheduleRender()
        const r1 = await agents.run(one, task)
        addLine('jarvis', r1.text)
        sys(paint(C.dimmer, '  ' + (r1.status === 'ok' ? 'ok' : r1.status) + ' in ' + r1.secs + 's on ' + one.model))
        break
      }
      const rows = agents.list()
      const ready = rows.filter((a) => a.enabled)
      addLine('system', ready.length + ' ready, ' + rows.length + ' registered')
      for (const a of rows) {
        const flag = a.enabled ? (a.needs ? '~' : '+') : 'x'
        const note = a.needs || a.role
        addLine('system', ' ' + flag + ' ' + String(a.name).padEnd(9) + String(a.model).padEnd(40) + note)
      }
      break
    }

    case 'ctl': {
      const parts = String(arg || '').trim().split(/\s+/)
      const what = (parts[0] || '').toLowerCase()
      if (!what || what === 'status') {
        const st = await sysops.status()
        sys('power      ' + (st.power || '?'))
        sys('schemes    ' + st.schemes.join(' / '))
        sys('brightness ' + st.brightness)
        break
      }
      if (what === 'volume') {
        const dir = parts[1] === 'up' ? 'up' : (parts[1] === 'mute' ? 'mute' : 'down')
        const r = await sysops.volume(dir, parts[2])
        sys(paint(C.dimmer, r.ok ? 'volume ' + r.action + ' x' + (r.steps || 1) : 'failed: ' + r.error))
        break
      }
      if (what === 'power') {
        const r = await sysops.power(parts.slice(1).join(' '))
        sys(paint(C.dimmer, r.ok ? 'power plan -> ' + r.plan + ' (active: ' + r.active + ')' : 'failed: ' + r.error + ' ' + (r.schemes || []).join('/')))
        break
      }
      if (what === 'lock') {
        const r = await sysops.lockScreen()
        sys(paint(C.dimmer, r.ok ? 'locking' : 'failed: ' + r.error))
        break
      }
      if (what === 'brightness') {
        const r = await sysops.brightness(parts[1])
        sys(paint(C.dimmer, r.current ? 'brightness ' + r.current + '%' + (r.note ? ' (' + r.note + ')' : '') : 'no controllable backlight'))
        break
      }
      sys(paint(C.dimmer, 'usage: /sys status | volume up|down|mute [n] | power <scheme> | lock | brightness [%]'))
      break
    }

    case 'ui': {
      const parts = String(arg || '').trim().split(/\s+/)
      const what = parts[0] || 'list'
      if (what === 'list') {
        const win = parts.slice(1).join(' ') || 'chrome'
        const r = await uia.list(win, 14)
        if (!r.ok) { sys(paint(C.dimmer, 'uia: ' + r.error)); break }
        sys(paint(C.dimmer, 'window: ' + r.window + '  (' + r.count + ' elements, showing ' + Math.min(14, r.count) + ')'))
        for (const e of (r.elements || []).slice(0, 14)) {
          sys(pad(e.type || '?', 12) + pad(String(e.name).slice(0, 34), 36) + (e.enabled ? '' : 'disabled '))
        }
        break
      }
      if (what === 'click' || what === 'type') {
        const rest = parts.slice(1)
        if (rest.length < 2) { sys(paint(C.dimmer, 'usage: /ui click <window> <element>   |   /ui type <window> <field> <text>')); break }
        const win = rest[0]
        if (what === 'click') {
          const r = await uia.click(win, rest.slice(1).join(' '))
          sys(paint(C.dimmer, r.ok ? 'clicked ' + (r.element || '') + ' via ' + r.via : 'failed: ' + r.error))
        } else {
          const field = rest[1]
          const text = rest.slice(2).join(' ')
          const r = await uia.typeInto(win, field, text)
          sys(paint(C.dimmer, r.ok ? 'typed into ' + (r.element || field) + ' via ' + r.via : 'failed: ' + r.error))
        }
        break
      }
      sys(paint(C.dimmer, 'usage: /ui list <window> | /ui click <window> <element> | /ui type <window> <field> <text>'))
      break
    }

    case 'graph': {
      const g = graph.write()
      sys('brain graph: ' + g.agents + ' agents, ' + g.skills + ' skills, ' + g.keys + ' keys')
      sys(paint(C.dimmer, g.file))
      if (String(arg || '').includes('open')) {
        const { spawn: sp } = require('child_process')
        sp('cmd.exe', ['/c', 'start', '', g.file], { detached: true, stdio: 'ignore' }).unref()
        sys(paint(C.dimmer, 'opening in the browser'))
      }
      break
    }

    case 'serve': {
      const raw = String(arg || '').trim()
      const sp = raw.split(/\s+/)
      const sub = sp[0] || ''
      const tail = sp.slice(1).join(' ').trim()
      if (sub === 'stop') { gateway.stop(); sys(paint(C.dimmer, 'gateway stopped')); break }
      if (sub === 'on') {
        const r = await gateway.start()
        if (!r.ok) { sys(paint(C.red, 'gateway failed: ' + r.error)); break }
        sys(paint(C.dimmer, 'gateway on 127.0.0.1:' + r.port + ' · token/pairing required'))
        if (r.token) sys(paint(C.dimmer, 'master token (this process only): ') + r.token)
        break
      }
      if (sub === 'pair') {
        const r = gateway.requestPair(tail || 'client')
        if (!r.ok) { sys(paint(C.red, '✗ ' + r.error)); break }
        sys(paint(C.bright, 'pairing code ' + r.code) + paint(C.dimmer, '  · valid ' + r.expiresIn + 's · one use'))
        sys(paint(C.dimmer, 'client: GET /pair?code=' + r.code + '   then approve here: /serve approve ' + r.code))
        alerts.raise('ok', 'pairing code ' + r.code + ' requested', { key: 'pair' + r.code, force: true })
        break
      }
      if (sub === 'approve') {
        const r = gateway.approve(tail)
        sys(r.ok ? paint(C.green, '✓ approved ' + r.name + ' — the client can collect its token once') : paint(C.red, '✗ ' + r.error))
        break
      }
      if (sub === 'pending') {
        const p = gateway.pending()
        if (!p.length) { sys(paint(C.dimmer, 'no pending pairings')); break }
        for (const x of p) sys(pad(x.name, 20) + pad(x.expiresIn + 's', 8) + (x.approved ? 'approved, waiting to collect' : 'waiting for /serve approve'))
        break
      }
      if (sub === 'passwd') {
        const pw = tail || securityLib.newToken().slice(0, 20)
        const r = gateway.setPassword(pw)
        if (!r.ok) { sys(paint(C.red, '✗ ' + r.error)); break }
        sys(paint(C.green, 'gateway passphrase set — stored as a scrypt hash, never plaintext'))
        sys(paint(C.bright, 'passphrase (shown once): ') + pw)
        break
      }
      if (sub === 'token') {
        sys(paint(C.dimmer, 'the master token is stored only as a sha256 hash; it cannot be printed after startup.'))
        sys(paint(C.dimmer, 'use /serve pair, or set a passphrase with /serve passwd'))
        break
      }
      const st = gateway.status()
      sys('gateway ' + (st.running ? paint(C.green, 'running on 127.0.0.1:' + st.port) : paint(C.dimmer, 'stopped')))
      sys(paint(C.dimmer, 'token ' + (st.tokenHash || '—') + ' · password ' + (st.password ? 'hashed' : 'not set') + ' · pending pairs ' + st.pending))
      sys(paint(C.dimmer, 'pairings never travel in a URL that outlives five minutes; codes are single-use.'))
      sys(paint(C.dimmer, '/serve on|stop|pair [name]|approve <code>|pending|passwd [pw]'))
      break
    }

    case 'bg': {
      const t = String(arg || '').trim()
      if (!t || t === 'list') {
        const jobs = bg.list().slice(0, 8)
        if (!jobs.length) { sys(paint(C.dimmer, 'no background jobs - run: /bg <task>')); break }
        for (const j of jobs) {
          sys(pad(j.id, 12) + pad(j.status, 8) + String(j.task).slice(0, 52))
        }
        sys(paint(C.dimmer, '/bg log <id>   /bg kill <id>'))
        break
      }
      if (t.startsWith('log ')) {
        const id = t.slice(4).trim()
        const text = bg.log(id, 20).trim()
        sys(text || 'no log yet for ' + id)
        break
      }
      if (t.startsWith('kill ')) {
        const ok = bg.kill(t.slice(5).trim())
        sys(paint(C.dimmer, ok ? 'job stopped' : 'no such job'))
        break
      }
      const job = bg.start(t)
      sys(paint(C.dimmer, 'running in background: ' + job.id + ' (no window, toast when done)'))
      sys(paint(C.dimmer, 'log: data/bg/' + job.id + '.log'))
      break
    }

    case 'browse': {
      const url = String(arg || '').trim()
      if (!url) { sys(paint(C.dimmer, 'usage: /browse <url>   (drives your own Chrome over CDP)')); break }
      sys(paint(C.dimmer, 'opening in your Chrome...'))
      scheduleRender()
      const py = process.env.JARVIS_PY || 'python'
      const script = path.join(ROOT, 'tools', 'browse.py')
      const env2 = Object.assign({}, process.env)
      delete env2.HTTPS_PROXY; delete env2.HTTP_PROXY; delete env2.ALL_PROXY
      const res = await new Promise((resolve) => {
        execFile(py, [script, url, '--text'], { env: env2, timeout: 90000, windowsHide: true, maxBuffer: 8 << 20 },
          (err, stdout) => resolve(String(stdout || '').trim() || (err ? err.message : '')))
      })
      let j = null
      try { j = JSON.parse(res) } catch (e) {}
      if (j && j.ok) {
        addLine('jarvis', (j.title ? j.title + String.fromCharCode(10) : '') + (j.text || '').slice(0, 1200))
        sys(paint(C.dimmer, j.url))
      } else {
        sys(paint(C.dimmer, 'browse failed: ' + ((j && j.error) || res).slice(0, 200)))
        sys(paint(C.dimmer, 'is the debug Chrome running? chrome-debug-launch.cmd'))
      }
      break
    }

    case 'vpn': {
      const v = String(arg || '').trim()
      if (v.startsWith('set ')) {
        const exe = v.slice(4).replace(/^["']|["']$/g, '')
        vpn.save({ exe, image: path.basename(exe) })
        sys(paint(C.dimmer, 'vpn client recorded: ' + exe))
        break
      }
      if (v === 'on') {
        const r = await vpn.start()
        sys(paint(C.dimmer, r.ok ? 'tunnel up in ' + r.secs + 's' : 'vpn start failed: ' + r.reason))
        break
      }
      if (v === 'off') {
        const r = await vpn.stop()
        sys(paint(C.dimmer, r.ok ? 'tunnel down' : 'still up: ' + (r.reason || 'check the client')))
        break
      }
      if (v === 'diag') {
        const d = await vpn.diag()
        sys('provider  ' + d.provider)
        sys('tun       ' + (d.tun.length ? d.tun.join(', ') : 'off'))
        sys('reachable ' + (d.reachable ? 'yes (direct)' : 'NO - the tunnel is swallowing it'))
        sys('route     ' + (d.route || 'n/a') + '   gateway ' + (d.gateway || 'n/a'))
        if (!d.reachable) sys(paint(C.dimmer, 'fix: /vpn bypass  (one UAC prompt, adds a host route that stays physical)'))
        break
      }
      if (v === 'bypass') {
        const b = await vpn.bypass()
        sys(paint(C.dimmer, b.ok ? 'provider now bypasses the tunnel' : 'bypass failed: ' + b.reason))
        if (b.cmd) sys(paint(C.dimmer, b.cmd))
        break
      }
      const s2 = await vpn.status()
      sys('proxy    ' + s2.proxy)
      sys('listening ' + (s2.listening ? 'yes' : 'no') + '   tunnel ' + (s2.tunnelWorks ? 'carrying traffic' : 'dead') + '   exit ip ' + s2.ip)
      sys(paint(C.dimmer, 'deepseek stays direct via NO_PROXY; /vpn on|off|set <exe>'))
      break
    }

    case 'takeover': {
      const tArg = String(arg || '').trim()
      if (!tArg || tArg === 'off') {
        await operator.stopOverlay()
        sys(paint(C.dimmer, 'robot released - the pointer is yours'))
        break
      }
      sys(paint(C.dimmer, 'robot driving: click-through overlay on; /takeover off to stop'))
      scheduleRender()
      const r = await operator.run(tArg, {
        onTrace: (e) => {
          if (e.phase === 'overlay') sys(paint(C.dimmer, 'overlay ' + e.status))
          scheduleRender()
        }
      })
      if (r.text) addLine('jarvis', r.text)
      sys(paint(C.dimmer, 'robot released after ' + r.secs + 's (' + r.status + ')'))
      break
    }

    case 'team': {
      const tArg = String(arg || '').trim()
      if (!tArg) { sys(paint(C.dimmer, 'usage: /team <task>   |   /team log   |   /team skills')); break }
      if (tArg === 'log') {
        sys(paint(C.dimmer, 'team lessons: ' + team.lessonLine()))
        for (const [n, v] of Object.entries(team.lessons().agents || {})) {
          const tot = (v.ok || 0) + (v.fail || 0)
          sys(pad(n, 10) + String(v.ok || 0) + ' ok / ' + String(v.fail || 0) + ' fail  ' + (v.secs ? '~' + v.secs + 's' : ''))
        }
        break
      }
      if (tArg === 'skills') {
        let files = []
        try { files = fs.readdirSync(team.DRAFTS) } catch (e) {}
        if (!files.length) { sys(paint(C.dimmer, 'no skill drafts yet - run: /team learn <task>')); break }
        for (const f of files) sys(' ' + f)
        sys(paint(C.dimmer, 'drafts live in ' + team.DRAFTS))
        break
      }

      const learn = tArg.startsWith('learn ')
      const task = learn ? tArg.slice(6).trim() : tArg
      const res = await team.run(task, {
        onTrace: (e) => {
          if (e.phase === 'plan' && e.subtasks) {
            sys(paint(C.dimmer, 'plan: ' + e.subtasks.length + ' subtask(s)'))
            e.subtasks.forEach((st, i) => sys(paint(C.dimmer, '  ' + (i + 1) + '. ' + st.agent + ' - ' + st.task.slice(0, 64))))
          } else if (e.phase === 'plan') {
            sys(paint(C.dimmer, 'plan: ' + e.status + (e.note ? ' (' + e.note + ')' : '')))
          } else if (e.phase === 'dispatch') {
            state.orbState = 'connecting'
            sys(paint(C.dimmer, '-> ' + e.agent + ' working'))
          } else if (e.phase === 'agent' && e.attempt) {
            const a = e.attempt
            sys(paint(C.dimmer, '   ' + (a.status === 'ok' ? 'ok' : a.status) + ' ' + a.agent + ' ' + a.secs + 's'))
          } else if (e.phase === 'merge') {
            state.orbState = 'weaving'
            sys(paint(C.dimmer, 'merging (' + e.status + ' ' + e.secs + 's)'))
          }
          scheduleRender()
        }
      })
      if (res.answer) addLine('jarvis', res.answer)
      else sys(paint(C.dimmer, 'the team produced no answer - ' + (res.attempts || []).map((a) => a.agent + ':' + a.status).join(', ')))
      sys(paint(C.dimmer, 'team: ' + res.agent + ' in ' + res.secs + 's, ' + (res.attempts || []).length + ' agent call(s)'))
      if (learn) {
        const f = await team.draftSkill(res)
        sys(paint(C.dimmer, f ? 'skill draft saved: ' + f : 'no reusable procedure found'))
      }
      break
    }

    case 'cascade': {
      if (!arg) { sys(paint(C.dimmer, 'usage: /cascade <task>  - tries agents in order until one answers')); break }
      const res = await agents.cascade(arg, {
        onAttempt: (e) => {
          if (e.phase === 'start') sys(paint(C.dimmer, '-> ' + e.agent + ' (' + e.model + ')'))
          else sys(paint(C.dimmer, '   ' + (e.status === 'ok' ? 'ok' : e.status) + ' ' + e.agent + ' ' + e.secs + 's'))
          scheduleRender()
        }
      })
      if (res.answer) {
        addLine('jarvis', res.answer)
        sys(paint(C.dimmer, 'answered by ' + res.agent + ' after ' + res.attempts.length + ' attempt(s), ' + res.secs + 's total'))
      } else {
        sys(paint(C.dimmer, 'no agent answered - ' + res.attempts.map((a) => a.agent + ':' + a.status).join(', ')))
      }
      break
    }

    case 'look': {
      const shot = path.join(os.tmpdir(), 'jarvis-eye.png')
      sys(paint(C.dimmer, 'capturing the screen...'))
      scheduleRender()
      await captureScreen(shot)
      sys(paint(C.dimmer, 'eye: asking the vision specialist (' + visionSpecialist().model + ')...'))
      scheduleRender()
      const answer = await askVision(shot, arg || 'name the app that is open and anything notable on screen')
      addLine('jarvis', answer)
      sys(paint(C.dimmer, 'image ' + shot))
      break
    }

  }
  scheduleRender()
}

/* ---------------------------------------------------------------------- tui */
function draw() { render() }

function quit() {
  const off = KEYS ? KEYS.MOUSE_OFF + KEYS.PASTE_OFF : ''
  process.stdout.write(off + '\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

function clearSel() {
  state.sel = null
  state.selAll = false
  state.dragging = false
}

function scrollBy(n) {
  state.scroll = Math.max(0, state.scroll + n)
  scheduleRender()
}

/* right click on a highlighted block -> clipboard */
function copySelection() {
  const sel = state.sel
  if (!sel) return false
  const text = SCR ? SCR.selectionText(state.screen, sel) : ''
  if (!text.trim()) return false
  try {
    const tmp = path.join(os.tmpdir(), 'jarvis-clip-' + process.pid + '.txt')
    fs.writeFileSync(tmp, text, 'utf8')
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-Content -Raw -LiteralPath '" + tmp + "' | Set-Clipboard"],
      { windowsHide: true, timeout: 8000 }, () => {
        try { fs.unlinkSync(tmp) } catch {}
      })
    sys(paint(C.green, '\u2713 copied ' + text.length + ' chars \u2014 right click again to copy another block'))
  } catch (e) {
    sys('copy failed: ' + (e && e.message ? e.message : e))
  }
  scheduleRender()
  return true
}

/* double click selects the whole entry under the pointer */
function selectBlockAt(row) {
  const src = state.rowSrc && state.rowSrc[row - 1]
  if (src == null || src < 0) return false
  let a = row
  let b = row
  while (a > 1 && state.rowSrc[a - 2] === src) a--
  while (b < state.rowSrc.length && state.rowSrc[b] === src) b++
  const lastLine = state.screen[b - 1] || ''
  const limit = Math.min(lastLine.length, state.chatW || lastLine.length)
  const end = Math.max(1, lastLine.slice(0, limit).replace(/\s+$/, '').length)
  state.sel = { r1: a, c1: 1, r2: b, c2: end }
  scheduleRender()
  return true
}

function onMouse(ev) {
  const b = ev.button
  if (b === 'wheelup') return scrollBy(3)
  if (b === 'wheeldown') return scrollBy(-3)
  if (b === 'left') {
    const now = Date.now()
    const dbl = now - state.lastClick.at < 400 && state.lastClick.y === ev.y
    state.lastClick = { at: now, y: ev.y }
    if (dbl && selectBlockAt(ev.y)) return
    state.dragging = true
    state.sel = { r1: ev.y, c1: ev.x, r2: ev.y, c2: ev.x }
    return scheduleRender()
  }
  if (b === 'motion') {
    if (!state.dragging || !state.sel) return
    state.sel.r2 = ev.y
    state.sel.c2 = ev.x
    return scheduleRender()
  }
  if (b === 'release') { state.dragging = false; return }
  if (b === 'right') return copySelection()
}

function insertText(v) {
  if (state.selAll) {
    state.input = v
    state.pos = v.length
    state.selAll = false
    return scheduleRender()
  }
  state.input = state.input.slice(0, state.pos) + v + state.input.slice(state.pos)
  state.pos += v.length
  scheduleRender()
}

function onEvent(ev) {
  if (!ev || !ev.type) return
  const t = ev.type

  if (t === 'ctrl') {
    if (ev.key === 'c') {
      if (state.busy) { bridge.cancel(); state.busy = false; state.status = 'ready'; sys('stopped'); return scheduleRender() }
      return quit()
    }
    if (ev.key === 'l') { process.stdout.write('\x1b[2J'); return scheduleRender() }
    if (ev.key === 'a') { state.selAll = !!state.input.length; return scheduleRender() }
    if (ev.key === 'e') { state.pos = state.input.length; state.selAll = false; return scheduleRender() }
    if (ev.key === 'u') { state.input = ''; state.pos = 0; state.selAll = false; return scheduleRender() }
    return
  }

  if (t === 'esc') {
    if (state.busy) {
      bridge.cancel(); state.busy = false; state.status = 'ready'; sys('stopped')
    } else if (state.sel) {
      clearSel()
    } else if (state.scroll) {
      state.scroll = 0
    } else {
      state.input = ''; state.pos = 0; state.selAll = false
    }
    return scheduleRender()
  }

  if (t === 'enter') return submit()

  if (t === 'backspace') {
    if (state.selAll) { state.input = ''; state.pos = 0; state.selAll = false; return scheduleRender() }
    if (state.pos > 0) { state.input = state.input.slice(0, state.pos - 1) + state.input.slice(state.pos); state.pos-- }
    return scheduleRender()
  }
  if (t === 'delete') {
    if (state.selAll) { state.input = ''; state.pos = 0; state.selAll = false; return scheduleRender() }
    state.input = state.input.slice(0, state.pos) + state.input.slice(state.pos + 1)
    return scheduleRender()
  }
  if (t === 'left') { state.selAll = false; state.pos = Math.max(0, state.pos - 1); return scheduleRender() }
  if (t === 'right') { state.selAll = false; state.pos = Math.min(state.input.length, state.pos + 1); return scheduleRender() }
  if (t === 'home') { state.selAll = false; state.pos = 0; return scheduleRender() }
  if (t === 'end') { state.selAll = false; state.pos = state.input.length; state.scroll = 0; return scheduleRender() }

  if (t === 'up') {
    if (!state.history.length) return
    if (state.histAt === -1) state.histAt = state.history.length
    state.histAt = Math.max(0, state.histAt - 1)
    state.input = state.history[state.histAt] || ''
    state.pos = state.input.length
    state.selAll = false
    return scheduleRender()
  }
  if (t === 'down') {
    if (state.histAt === -1) return
    state.histAt = Math.min(state.history.length, state.histAt + 1)
    state.input = state.histAt === state.history.length ? '' : state.history[state.histAt]
    state.pos = state.input.length
    state.selAll = false
    return scheduleRender()
  }

  if (t === 'pgup') return scrollBy(8)
  if (t === 'pgdown' || t === 'pgdn') return scrollBy(-8)

  if (t === 'text') return insertText(ev.value)
  if (t === 'paste') {
    const one = SCR ? SCR.pasteLine(ev.value) : String(ev.value).replace(/\s+/g, ' ').trim()
    return insertText(one)
  }
  if (t === 'mouse') return onMouse(ev)
}

/* --------------------------------------------------------------------- boot */
async function main() {
  // ESM helpers
  const intentMod = await import(pathToFileUrl(path.join(ROOT, 'lib', 'intent.mjs')))
  SCR = await import(pathToFileUrl(path.join(ROOT, 'lib', 'screen.mjs')))
  KEYS = await import(pathToFileUrl(path.join(ROOT, 'lib', 'keys.mjs')))
  const remMod = await import(pathToFileUrl(path.join(ROOT, 'lib', 'reminders.mjs')))
  intentLib.parseIntent = intentMod.parseIntent
  remindersLib.parseReminder = remMod.parseReminder
  remindersLib.parseNote = remMod.parseNote

  bridge.settings.model = config.model || ''
  bridge.settings.provider = config.provider || ''
  state.model = config.model || 'session default'
  state.provider = config.provider || 'auto'
  const sid = bridge.getSessionId && bridge.getSessionId()
  state.session = sid ? String(sid).slice(0, 12) : 'new'

  const oneShot = process.argv.slice(2).join(' ').trim().replace(/^["']+|["']+$/g, '')
  INTERACTIVE = !oneShot

  if (process.argv.includes('--setup')) {
    const setupMod = require(path.join(ROOT, 'lib', 'setup'))
    const r = await setupMod.setup({ probe: !process.argv.includes('--no-probe') })
    process.exit(r.ok ? 0 : 2)
  }

  const frameOnly = process.argv.includes('--frame')
  if (frameOnly) {
    const sizeAt = process.argv.indexOf('--size')
    const size = sizeAt > -1 ? String(process.argv[sizeAt + 1] || '120x30').split('x') : ['120', '30']
    Object.defineProperty(process.stdout, 'columns', { value: Number(size[0]) || 120, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: Number(size[1]) || 30, configurable: true })
    INTERACTIVE = true
    state.model = 'deepseek-v4-flash'
    state.provider = 'custom:swm'
    state.session = 'local-e323ac'
    state.tokens = { lastIn: 13328, lastOut: 162, sessionIn: 41825, sessionOut: 640, context: 27724 }
    const demo = [
      { role: 'sys', text: 'Jarvis · terminal · /help for commands' },
      { role: 'you', text: 'how much disk is free on C:?' },
      { role: 'think', text: 'asking deepseek-v4-flash  +0.0s' },
      { role: 'think', text: '→ terminal df -h /c  +6.5s' },
      { role: 'think', text: '✓ terminal done  +7.5s' },
      { role: 'jarvis', text: '794G free on C: (208G used of 1002G, 21%).' },
      { role: 'you', text: 'open notepad' },
      { role: 'sys', text: '→ launched notepad' },
      { role: 'you', text: 'summarise what you can see in this session' },
      { role: 'think', text: '→ terminal df -h /c  +2.1s' },
      { role: 'jarvis', text: 'Two things so far: the C: drive has 794G free, and notepad is running. Nothing else has been asked yet, so there is no session summary to give beyond those two actions.' },
    ]
    state.lines = process.argv.includes('--empty') ? [] : demo
    state.input = 'remind me in 10 min to stretch'
    state.pos = state.input.length
    const scrollAt = process.argv.indexOf('--scroll')
    if (scrollAt > -1) state.scroll = Number(process.argv[scrollAt + 1] || 10) || 10
    if (process.argv.includes('--sel')) state.sel = { r1: 2, c1: 1, r2: 3, c2: 24 }
    if (process.argv.includes('--selall')) state.selAll = true
    if (process.argv.includes('--long')) {
      state.input = 'summarise everything you have seen in this session so far, then list the exact commands you ran and how long each of them took, and finally tell me which of them changed something on the machine'
      state.pos = state.input.length
    }
    if (process.argv.includes('--busy')) { state.busy = true; state.busySince = Date.now() - 4200 }
    if (!process.argv.includes('--empty')) {
      state.lastAnswer = { ms: 10100, tokIn: 28127, tokOut: 82, modelMs: 7400, at: Date.now() }
    }
    if (process.argv.includes('--think')) {
      state.trace = true
      state.thinking = [
        'asking deepseek-v4-flash  +0.0s',
        'tool terminal echo $((12*12))  +0.4s',
        'tool done 1 result  +0.9s',
        'first token  +2.1s',
        'tokens 13749 in / 2 out  +2.4s',
        'model 2380 ms  +2.4s',
        'session local-e323ac  +2.5s',
        'answered in 2.6s  +2.6s',
      ]
    }
    refreshHw()
    render()
    process.stdout.write('\n')
    return
  }

  // dev probe: run one real turn headlessly and report what the thinking block held
  const probeAt = process.argv.indexOf('--probe-turn')
  if (probeAt > -1) {
    const q = process.argv[probeAt + 1] || 'what is 6*7? just the number'
    const orig = process.stdout.write.bind(process.stdout)
    INTERACTIVE = true
    process.stdout.write = () => true
    await askAgent(q)
    INTERACTIVE = false
    process.stdout.write = orig
    orig('transcript:\n')
    for (const l of state.lines) orig('  [' + l.role.padEnd(6) + '] ' + l.text.slice(0, 100) + '\n')
    return
  }

  // dev probe: drive the real event handlers headlessly and report the state
  const inputAt = process.argv.indexOf('--probe-input')
  if (inputAt > -1) {
    const orig = process.stdout.write.bind(process.stdout)
    INTERACTIVE = true
    process.stdout.write = () => true
    state.lines = [
      { role: 'you', text: 'first question' },
      { role: 'think', text: 'asking deepseek-v4-flash  +0.0s' },
      { role: 'jarvis', text: 'first answer line one' },
      { role: 'jarvis', text: 'first answer line two' },
      { role: 'you', text: 'second question' },
    ]
    render()
    const out = {}
    insertText('hello')
    out.typed = state.input
    onEvent({ type: 'paste', value: 'line one\nline two\nline three' })
    out.afterPaste = state.input
    out.pasteIsOneLine = !out.afterPaste.includes('\n')
    onEvent({ type: 'ctrl', key: 'a' })
    out.selAll = state.selAll
    insertText('replaced')
    out.afterReplace = state.input
    out.selAllCleared = state.selAll === false
    onEvent({ type: 'pgup' })
    out.scrollAfterPgUp = state.scroll
    onMouse({ button: 'wheelup', x: 5, y: 5 })
    out.scrollAfterWheel = state.scroll
    onMouse({ button: 'left', x: 3, y: 5 })
    onMouse({ button: 'left', x: 3, y: 5 })
    out.blockSel = state.sel
    out.blockText = SCR ? SCR.selectionText(state.screen, state.sel) : null
    onEvent({ type: 'esc' })
    out.escClearedSelection = state.sel === null
    out.screenRows = state.screen.length
    // cursor placement: width-aware, and scrolled when the line is too long
    const cursorOf = () => {
      const chunks = []
      const orig2 = process.stdout.write
      process.stdout.write = (c) => { chunks.push(String(c)); return true }
      INTERACTIVE = true
      render()
      process.stdout.write = orig2
      const m = String(chunks.join("")).match(/\x1b\[(\d+);(\d+)H\x1b\[\?25h$/)
      return m ? Number(m[2]) : -1
    }
    const cols = process.stdout.columns || 120
    state.input = 'hello'
    state.pos = 5
    out.cursorShort = cursorOf()
    state.input = '\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8'
    state.pos = 3
    out.cursorWide = cursorOf()
    state.input = 'x'.repeat(300)
    state.pos = 300
    const c2 = cursorOf()
    out.cursorLong = c2
    out.cursorLongVisible = c2 > 0 && c2 <= cols - 1
    state.input = 'middle'
    state.pos = 2
    out.cursorMid = cursorOf()
    state.input = ''
    state.pos = 0
    process.stdout.write = orig
    INTERACTIVE = false
    orig(JSON.stringify(out) + '\n')
    return
  }

  /* Warm the local model in the background so summaries are instant later. */
  bridge.ollama.available().then((ok) => { if (ok) bridge.ollama.warm() }).catch(() => {})

  refreshHw()
  startTempPolling()
  refreshStatus()
  const secTimer = setInterval(refreshStatus, 10000)
  secTimer.unref?.()
  const hwTimer = setInterval(() => { refreshHw(); if (!oneShot) scheduleRender() }, 2000)
  hwTimer.unref?.()

  sys(paint(C.accent, 'Jarvis') + paint(C.dimmer, ' · terminal · /help for commands'))
  if (sid) sys(paint(C.dimmer, 'resumed session ' + String(sid).slice(0, 12)))

  if (oneShot) {
    await handle(oneShot)
    // print the transcript and exit (no TUI)
    // piped output must be clean text: no colour codes when stdout is not a terminal
    const ttyOut = !!process.stdout.isTTY
    for (const l of state.lines) {
      const t = ttyOut ? l.text : stripAnsi(l.text)
      if (l.role === 'you') process.stdout.write((ttyOut ? paint(C.steel, 'you › ') : 'you › ') + t + '\n')
      else if (l.role === 'sys') process.stdout.write((ttyOut ? paint(C.dimmer, t) : t) + '\n')
      else process.stdout.write(t + '\n')
    }
    process.exit(0)
  }

  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    process.stdout.write('jarvis needs an interactive terminal to run its interface.\n')
    process.stdout.write('Try:  jarvis "what is 2+2"   for a single command\n')
    return
  }
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  if (KEYS) process.stdout.write(KEYS.MOUSE_ON + KEYS.PASTE_ON)
  process.stdin.on('data', (buf) => {
    if (!KEYS) return
    for (const e of KEYS.parseInput(String(buf))) onEvent(e)
  })
  process.stdout.on('resize', () => { state.sel = null; state.scroll = 0; scheduleRender() })

  /* The machine watching itself: a baseline of startup entries, listeners,
   * tasks, hosts and Defender state, diffed every 10 minutes. Read-only. */
  sentinel.watch({
    intervalMs: 600000,
    onFinding: (findings) => {
      const high = findings.filter((f) => f.level === 'high')
      if (!high.length) return
      for (const f of high.slice(0, 4)) sys(paint(C.red, '▲ security: ' + f.detail))
      alerts.raise('security', high.map((f) => f.detail).join('; '), { force: true })
      scheduleRender()
    },
  })

  /* Self-check: if the active model stops answering, say so and move on. One
   * two-token ping every 15 minutes, skipped while busy or just after a turn. */
  const beat = setInterval(async () => {
    if (state.busy) return
    const idleFor = Date.now() - (state.lastAnswer ? state.lastAnswer.at : state.started)
    if (idleFor < 120000) return
    const r = await bridge.selfCheck()
    if (r.ok) return
    sys(paint(C.amber, '⚠ heartbeat: ' + (r.model || 'model') + ' is not answering'))
    alerts.raise('unavailable', 'heartbeat failed for ' + (r.model || 'model'), {})
    const next = models.best([r.model])
    if (next) {
      bridge.settings.model = next.model
      bridge.settings.provider = next.provider
      state.model = next.model
      state.provider = next.provider
      sys(paint(C.violet, '↻ moved to ' + next.model))
      alerts.raise('switched', 'heartbeat moved to ' + next.model, {})
    }
    scheduleRender()
  }, 900000)
  beat.unref?.()

  render()
}

function pathToFileUrl(p) {
  const url = require('url')
  return url.pathToFileURL(p).toString()
}

process.on('uncaughtException', (e) => {
  try { process.stdout.write((KEYS ? KEYS.MOUSE_OFF + KEYS.PASTE_OFF : '') + '\x1b[?25h\x1b[?1049l') } catch {}
  console.error('jarvis crashed:', e && e.stack ? e.stack : e)
  process.exit(1)
})

main().catch((e) => {
  try { process.stdout.write((KEYS ? KEYS.MOUSE_OFF + KEYS.PASTE_OFF : '') + '\x1b[?25h\x1b[?1049l') } catch {}
  console.error('jarvis failed to start:', e && e.message ? e.message : e)
  process.exit(1)
})
