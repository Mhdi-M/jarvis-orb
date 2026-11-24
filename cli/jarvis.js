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

const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const readline = require('readline')

const ROOT = path.join(__dirname, '..')
const bridge = require(path.join(ROOT, 'hermes-bridge'))
const { sampler } = require(path.join(ROOT, 'lib', 'cpu'))
const memory = require(path.join(ROOT, 'lib', 'memory'))
const monitorLib = require(path.join(ROOT, 'lib', 'monitor'))
const messagesLib = require(path.join(ROOT, 'lib', 'messages'))
const chromeLib = require(path.join(ROOT, 'lib', 'chrome'))
const skillsLib = require(path.join(ROOT, 'lib', 'skills'))
const profileLib = require(path.join(ROOT, 'lib', 'profile'))
const remindersLib = { parseReminder: null, parseNote: null }
const intentLib = { parseIntent: null }

const CONFIG_FILE = path.join(ROOT, 'cli.config.json')
const REMINDER_FILE = path.join(ROOT, 'data', 'reminders.json')
const NOTE_FILE = path.join(ROOT, 'data', 'notes.json')

/* ------------------------------------------------------------------ style */
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  accent: '\x1b[38;2;127;180;216m',
  bright: '\x1b[38;2;236;246;255m',
  steel: '\x1b[38;2;150;176;198m',
  dimmer: '\x1b[38;2;96;120;140m',
  green: '\x1b[38;2;126;214;168m',
  amber: '\x1b[38;2;240;198;116m',
  red: '\x1b[38;2;224;120;130m',
  violet: '\x1b[38;2;168;156;240m',
}
const paint = (c, s) => c + s + C.reset
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
const strWidth = (s) => [...stripAnsi(s)].length
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
}

/* --------------------------------------------------------------- messages */
function addLine(role, text) {
  const chunks = String(text ?? '').split('\n')
  for (const chunk of chunks) state.lines.push({ role, text: chunk })
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

/* ---------------------------------------------------------------- hardware */
/* state.hw: cpu, ram, gpuTemp, gpuName, gpuUtil, cpuTemp, diskTemp,
 * diskFree, diskTotal */

// --- temp parsing inlined (from lib/temps.mjs) ---
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
}

let tempPollTimer = null
function startTempPolling() {
  if (tempPollTimer) return
  pollGpu(); pollCpuTemp(); pollDiskTemp()
  tempPollTimer = setInterval(() => { pollGpu(); pollCpuTemp(); pollDiskTemp() }, 10000)
  setTimeout(() => { startTempPolling() }, 30000)
}

/* ---------------------------------------------------------------- rendering */
let lastRender = 0
let renderTimer = null
const SPINNER = ['◐','◓','◑','◒']
let spinTimer = null
function startSpinner() {
  if (spinTimer) return
  state.spin = 0
  spinTimer = setInterval(() => {
    if (!state.busy) { clearInterval(spinTimer); spinTimer = null; return }
    state.spin = (state.spin + 1) % 4
    // AGENT is the 6th sidebar row (0-based index 5). In the terminal it's at
    // thinkLines + 5 (header rows) + 1 (1-based escape code) = thinkLines + 6
    // But we don't have thinkLines here, so use the known constant offset
    // when sidebar is at top: row 6. The full render handles alignment.
    const esc = ''
    const row = 6
    const col = 12 // after 'AGENT    ' (10 chars padded)
    process.stdout.write(esc + '[' + row + ';' + col + 'H' + SPINNER[state.spin])
  }, 120)
}
function stopSpinner() {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null }
  // restore the two spaces after AGENT
  if (!state.busy) {
    const esc = ''
    const row = 6
    const col = 12
    process.stdout.write(esc + '[' + row + ';' + col + 'H' + '  ')
  }
}
function scheduleRender() {
  if (renderTimer) return
  if (state.busy && !spinTimer) startSpinner()
  if (!state.busy && spinTimer) stopSpinner()
  const wait = Math.max(0, 80 - (Date.now() - lastRender))
  renderTimer = setTimeout(() => { renderTimer = null; render() }, wait)
}

let INTERACTIVE = true

function render() {
  if (!INTERACTIVE) return
  lastRender = Date.now()
  const cols = process.stdout.columns || 100
  const rows = process.stdout.rows || 30
  const sideW = cols >= 92 ? 34 : 0
  const chatW = cols - sideW - 3
  // reserve rows for the thinking block: if the frame is taller than the window the
  // terminal scrolls on every repaint, which is the fast black-screen flicker
  const thinkLines = (state.trace && state.thinking && state.thinking.length)
    ? Math.min(state.thinking.length, Math.max(0, Math.min(6, Math.floor((rows - 9) / 3))))
    : 0
  const bodyRows = rows - 3 - thinkLines
  if (bodyRows < 5) return

  // ---- chat lines
  const rendered = []
  for (const l of state.lines) {
    const isYou = l.role === 'you'
    const isSys = l.role === 'sys'
    const head = isYou ? paint(C.dimmer, 'you ') + paint(C.accent, '› ') : isSys ? '    ' : '      '
    const color = isYou ? C.steel : isSys ? C.dimmer : C.bright
    const avail = chatW - strWidth(head)
    const wrapped = wrap(l.text, Math.max(8, avail))
    wrapped.forEach((w, i) => {
      rendered.push({ head: i === 0 ? head : ' '.repeat(strWidth(head)), text: paint(color, w) })
    })
  }
  const visible = rendered.slice(-bodyRows)

  // ---- thinking block (above the sidebar, capped so the frame always fits)
  const think = []
  if (thinkLines > 0) {
    const shown = state.thinking.slice(-(thinkLines - 2))
    think.push(paint(C.accent, '┌─ thinking ' + '─'.repeat(Math.max(0, chatW - 13))))
    for (const line of shown) {
      think.push(paint(C.dimmer, '│ ' + cut(line, Math.max(4, chatW - 3))))
    }
    think.push(paint(C.accent, '└' + '─'.repeat(Math.max(0, chatW - 2))))
  }

  // ---- sidebar
  const side = []
  const rule = paint(C.dimmer, '─'.repeat(sideW - 2))
  const kv = (k, v) => side.push(' ' + paint(C.dimmer, pad(k, 10)) + pad(v, sideW - 13))
  side.push(paint(C.accent, C.bold + ' JARVIS') + paint(C.dimmer, '  ' + new Date().toTimeString().slice(0, 5)))
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'MODEL'))
  side.push(' ' + paint(C.bright, cut(state.model, sideW - 3)))
  side.push(' ' + paint(C.dimmer, 'PROVIDER ') + paint(C.steel, cut(state.provider, sideW - 13)))
  const spinChar = state.busy ? paint(C.amber, SPINNER[state.spin]) + ' ' : '  '
  side.push(' ' + paint(C.dimmer, 'AGENT    ') + spinChar + paint(state.busy ? C.amber : C.green, state.busy ? 'working' : 'idle'))
  side.push(' ' + paint(C.dimmer, 'SESSION  ') + paint(C.steel, cut(state.session, sideW - 13)))
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'TOKENS'))
  kv('turn in', String(state.tokens.lastIn))
  kv('turn out', String(state.tokens.lastOut))
  kv('session', state.tokens.sessionIn + ' / ' + state.tokens.sessionOut)
  kv('context', state.tokens.context ? (state.tokens.context / 1000).toFixed(1) + 'k' : '—')
  side.push(rule)
  side.push(' ' + paint(C.dimmer, 'HARDWARE'))
  side.push(' ' + paint(C.dimmer, 'CPU ') + bar(state.hw.cpu, 10) + ' ' +
    paint(C.steel, Math.round(state.hw.cpu) + '%') +
    (state.hw.cpuTemp != null ? ' ' + paint(C.steel, Math.round(state.hw.cpuTemp) + '°C') : ''))
  side.push(' ' + paint(C.dimmer, 'RAM ') + bar(state.hw.ram, 10) + ' ' + paint(C.steel, Math.round(state.hw.ram) + '%'))
  const gpu = state.hw.gpuTemp != null ? Math.round(state.hw.gpuTemp) + '°C' : 'n/a'
  const gpuUtil = state.hw.gpuUtil != null ? ' ' + state.hw.gpuUtil + '%' : ''
  const gpuName = state.hw.gpuName ? ' ' + state.hw.gpuName : ''
  side.push(' ' + paint(C.dimmer, 'GPU') + gpuName + ' ' + paint(C.steel, gpu + gpuUtil))
  if (state.hw.diskTemp != null) side.push(' ' + paint(C.dimmer, 'SSD ') + paint(C.steel, Math.round(state.hw.diskTemp) + '°C'))
  const diskUsed = state.hw.diskTotal ? 100 * (1 - state.hw.diskFree / state.hw.diskTotal) : 0
  side.push(' ' + paint(C.dimmer, 'DISK') + ' ' + paint(C.steel, diskUsed ? Math.round(diskUsed) + '% used' : '—'))
  side.push(rule)
  const rem = readList(REMINDER_FILE).filter((r) => r.at > Date.now()).length
  kv('reminders', String(rem))
  kv('memory', memory.list().length + ' facts')
  kv('uptime', Math.round((Date.now() - state.started) / 60000) + ' min')

  // ---- input line
  const inputLabel = state.busy ? paint(C.amber, '… ') : paint(C.accent, '› ')
  const hint = state.busy
    ? paint(C.dimmer, 'esc stops · enter queues')
    : paint(C.dimmer, '/help for commands')

  // ---- compose
  const out = []
  const chatPane = []
  for (let i = 0; i < bodyRows; i++) {
    const l = visible[i]
    chatPane.push(l ? cut(l.head + l.text, chatW) : '')
  }
  if (!state.lines.length) {
    chatPane[0] = paint(C.bright, '  Jarvis. Type a question, or a command — ') + paint(C.accent, '/help')
    chatPane[1] = paint(C.dimmer, '  try: open notepad · read example.com · remind me in 10 min to stretch')
  }

  out.push('\x1b[?25l')            // hide only while repainting
  out.push('\x1b[H')
  for (let i = 0; i < thinkLines; i++) {
    out.push(pad(think[i] || '', chatW) + (sideW ? paint(C.dimmer, '│') + ' '.repeat(sideW) : '') + '\r\n')
  }
  for (let i = 0; i < bodyRows; i++) {
    const left = pad(chatPane[i] || '', chatW)
    const right = side[i] || ''
    out.push(left + (sideW ? paint(C.dimmer, '│') + pad(right, sideW) : '') + '\r\n')
  }
  out.push(paint(C.dimmer, '─'.repeat(cols)) + '\r\n')
  // the input row carries no trailing newline, otherwise the terminal scrolls 1 line
  out.push(pad(' ' + inputLabel + state.input, cols - 1))

  const inputRow = thinkLines + bodyRows + 2
  const cursorCol = 2 + strWidth(inputLabel) + state.pos
  out.push('\x1b[' + inputRow + ';' + Math.max(1, Math.min(cols - 1, cursorCol)) + 'H')
  out.push('\x1b[?25h')            // cursor visible again, parked on the input row
  process.stdout.write(out.join(''))
}

/* ------------------------------------------------------------- input line */
const stdin = process.stdin
readline.emitKeypressEvents(stdin)

function submit() {
  const text = state.input.trim()
  if (!text) return
  state.input = ''
  state.pos = 0
  if (state.history[state.history.length - 1] !== text) state.history.push(text)
  state.histAt = -1
  handle(text)
  scheduleRender()
}

async function handle(text) {
  if (text.startsWith('/')) return command(text)
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
  await askAgent(text)
}

async function askAgent(text) {
  state.busy = true
  state.busySince = Date.now()
  state.status = 'thinking'
  state.thinking = []
  const t0 = Date.now()
  const mark = (m) => {
    if (!state.trace) return
    const t = state.showTiming ? '  +' + ((Date.now() - t0) / 1000).toFixed(1) + 's' : ''
    state.thinking.push(m + t)
    if (state.thinking.length > 40) state.thinking.shift()
    scheduleRender()
  }
  mark('asking ' + state.model)
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
        const last = state.lines[state.lines.length - 1]
        if (first) {
          first = false
          state.lines.push({ role: 'jarvis', text: d, streaming: true })
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
  } catch (e) {
    sys('✗ ' + (e && e.message ? e.message : String(e)))
    mark('failed: ' + (e && e.message ? e.message : String(e)))
  } finally {
    const total = Date.now() - t0
    state.lastMs = total
    mark('answered in ' + (total / 1000).toFixed(1) + 's')
    state.busy = false
    state.busySince = 0
    state.status = 'ready'
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
  ['/think [on|off]', 'show or hide the thinking block above the sidebar'],
  ['/timing [on|off]', 'show or hide per-step timings inside the thinking block'],
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
  ['/notch', 'start the monitoring notch'],
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
      refreshHw()
      sys(`CPU  ${Math.round(state.hw.cpu)}%   RAM ${Math.round(state.hw.ram)}%   GPU ${state.hw.gpu == null ? 'n/a' : Math.round(state.hw.gpu) + '°C'}`)
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

    case 'notch': {
      const { spawn } = require('child_process')
      spawn('cmd.exe', ['/c', 'start', '', path.join(ROOT, '..', 'jarvis-notch', 'node_modules', '.bin', 'electron.cmd'), '.'], { cwd: path.join(ROOT, '..', 'jarvis-notch'), detached: true, stdio: 'ignore' })
      sys('notch launching')
      break
    }

    default:
      sys(`unknown command /${cmd} — /help`)
  }
  scheduleRender()
}

/* ---------------------------------------------------------------------- tui */
function draw() { render() }

function quit() {
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

function onKey(str, key) {
  if (!key) return
  const k = key.name

  if (key.ctrl && k === 'c') { if (state.busy) { bridge.cancel(); sys('stopped'); state.busy = false; scheduleRender(); return } return quit() }
  if (key.ctrl && k === 'l') { process.stdout.write('\x1b[2J'); return scheduleRender() }

  if (k === 'escape') {
    if (state.busy) { bridge.cancel(); state.busy = false; state.status = 'ready'; sys('stopped') }
    else { state.input = ''; state.pos = 0 }
    return scheduleRender()
  }

  if (k === 'return' || k === 'enter') { submit(); return }

  if (k === 'backspace') {
    if (state.pos > 0) { state.input = state.input.slice(0, state.pos - 1) + state.input.slice(state.pos); state.pos-- }
    return scheduleRender()
  }
  if (k === 'delete') {
    state.input = state.input.slice(0, state.pos) + state.input.slice(state.pos + 1)
    return scheduleRender()
  }
  if (k === 'left') { state.pos = Math.max(0, state.pos - 1); return scheduleRender() }
  if (k === 'right') { state.pos = Math.min(state.input.length, state.pos + 1); return scheduleRender() }
  if (k === 'home' || (key.ctrl && k === 'a')) { state.pos = 0; return scheduleRender() }
  if (k === 'end' || (key.ctrl && k === 'e')) { state.pos = state.input.length; return scheduleRender() }

  if (k === 'up') {
    if (!state.history.length) return
    if (state.histAt === -1) state.histAt = state.history.length
    state.histAt = Math.max(0, state.histAt - 1)
    state.input = state.history[state.histAt] || ''
    state.pos = state.input.length
    return scheduleRender()
  }
  if (k === 'down') {
    if (state.histAt === -1) return
    state.histAt = Math.min(state.history.length, state.histAt + 1)
    state.input = state.histAt === state.history.length ? '' : state.history[state.histAt]
    state.pos = state.input.length
    return scheduleRender()
  }

  if (str && !key.ctrl && !key.meta && str >= ' ') {
    state.input = state.input.slice(0, state.pos) + str + state.input.slice(state.pos)
    state.pos += str.length
    return scheduleRender()
  }
}

/* --------------------------------------------------------------------- boot */
async function main() {
  // ESM helpers
  const intentMod = await import(pathToFileUrl(path.join(ROOT, 'lib', 'intent.mjs')))
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

  const frameOnly = process.argv.includes('--frame')
  if (frameOnly) {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true })
    INTERACTIVE = true
    state.model = 'deepseek-v4-flash'
    state.provider = 'custom:swm'
    state.session = 'local-e323ac'
    state.tokens = { lastIn: 13328, lastOut: 162, sessionIn: 41825, sessionOut: 640, context: 27724 }
    state.lines = [
      { role: 'sys', text: 'Jarvis · terminal · /help for commands' },
      { role: 'you', text: 'open notepad' },
      { role: 'sys', text: '→ launched notepad' },
      { role: 'you', text: 'read example.com and summarize it' },
      { role: 'jarvis', text: '- Example Domain is a placeholder reserved for documentation examples and needs no permission.' },
      { role: 'jarvis', text: '- It exists so authors can use a link in samples without asking anyone first.' },
      { role: 'jarvis', text: '- Nothing is served beyond that page; do not expect a real service there.' },
    ]
    state.input = 'remind me in 10 min to stretch'
    state.pos = state.input.length
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
    const answer = state.lines.filter((l) => l.role === 'jarvis').map((l) => l.text).join(' ').trim()
    orig('answer: ' + answer.slice(0, 120) + '\n')
    orig('thinking block (' + (state.thinking ? state.thinking.length : 0) + ' lines):\n')
    for (const l of state.thinking || []) orig('  ' + l + '\n')
    return
  }

  /* Warm the local model in the background so summaries are instant later. */
  bridge.ollama.available().then((ok) => { if (ok) bridge.ollama.warm() }).catch(() => {})

  refreshHw()
  startTempPolling()
  const hwTimer = setInterval(() => { refreshHw(); if (!oneShot) scheduleRender() }, 2000)
  hwTimer.unref?.()

  sys(paint(C.accent, 'Jarvis') + paint(C.dimmer, ' · terminal · /help for commands'))
  if (sid) sys(paint(C.dimmer, 'resumed session ' + String(sid).slice(0, 12)))

  if (oneShot) {
    await handle(oneShot)
    // print the transcript and exit (no TUI)
    for (const l of state.lines) {
      const t = l.text
      if (l.role === 'you') process.stdout.write(paint(C.steel, 'you › ') + t + '\n')
      else if (l.role === 'sys') process.stdout.write(paint(C.dimmer, t) + '\n')
      else process.stdout.write(t + '\n')
    }
    return
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
  process.stdin.on('keypress', onKey)
  process.stdout.on('resize', () => scheduleRender())
  render()
}

function pathToFileUrl(p) {
  const url = require('url')
  return url.pathToFileURL(p).toString()
}

process.on('uncaughtException', (e) => {
  try { process.stdout.write('\x1b[?25h\x1b[?1049l') } catch {}
  console.error('jarvis crashed:', e && e.stack ? e.stack : e)
  process.exit(1)
})

main().catch((e) => {
  try { process.stdout.write('\x1b[?25h\x1b[?1049l') } catch {}
  console.error('jarvis failed to start:', e && e.message ? e.message : e)
  process.exit(1)
})
