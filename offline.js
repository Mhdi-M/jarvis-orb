'use strict'
/**
 * Offline fallback.
 *
 * When the model endpoint is unreachable (VPN killed the route, no internet,
 * captive portal) the orb still has to be useful. These intents are answered
 * locally with no model at all: machine health and starting/stopping apps.
 *
 * Everything here is deliberately narrow. It recognises a handful of shapes and
 * refuses anything else, rather than pretending to be the agent offline.
 */
const net = require('net')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')

const PROBE_HOST = process.env.JARVIS_PROBE_HOST || ''
const PROBE_PORT = Number(process.env.JARVIS_PROBE_PORT || 443)
const PROBE_TTL_MS = 6000

let probeCache = { at: 0, online: null }

function probeOnce() {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (online) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(online)
    }
    sock.setTimeout(1500)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    if (!PROBE_HOST) return finish(true) // no probe host configured: assume online
    try { sock.connect(PROBE_PORT, PROBE_HOST) } catch { finish(false) }
  })
}

async function isOnline() {
  const now = Date.now()
  if (probeCache.online !== null && now - probeCache.at < PROBE_TTL_MS) return probeCache.online
  const online = await probeOnce()
  probeCache = { at: now, online }
  return online
}

const HW_MATCH = /\b(health|health ?check|status|temp|temperature|cpu|ram|memory|disk|storage|gpu|load|usage|vram|thermal)\b/i
const OPEN_MATCH = /^\s*(?:please\s+)?(?:open|launch|start|run)\s+(?:the\s+)?(.+?)\s*[.!?]?\s*$/i
const CLOSE_MATCH = /^\s*(?:please\s+)?(?:close|quit|kill|stop)\s+(?:the\s+)?(.+?)\s*[.!?]?\s*$/i

const ALIASES = {
  browser: 'chrome',
  explorer: 'explorer',
  files: 'explorer',
  editor: 'notepad',
  calculator: 'calc',
  calc: 'calc',
  settings: 'ms-settings:',
  terminal: 'wt',
  shell: 'wt',
}

function looksLikeApp(name) {
  return /^[\w .+\-:]{1,60}$/.test(name)
}

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim())
    })
  })
}

async function hwSnapshot() {
  const [gpuOut, diskOut, cpuOut] = await Promise.all([
    run('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits']),
    run('powershell', ['-NoProfile', '-Command', '(Get-PSDrive C).Free/1GB']),
    run('powershell', ['-NoProfile', '-Command', '(Get-Counter "\\Processor(_Total)\\% Processor Time").CounterSamples[0].CookedValue']),
  ])

  let gpuLine = ''
  if (gpuOut) {
    const [name, temp, util] = gpuOut.split(',').map((s) => s.trim())
    if (name) gpuLine = `\nGPU: ${name} ${temp}\u00b0C, ${util}% load`
  }

  let disk = ''
  const gb = parseFloat(diskOut)
  if (Number.isFinite(gb)) disk = `\nDisk C: ${gb.toFixed(0)} GiB free`

  const total = os.totalmem()
  const free = os.freemem()
  const usedPct = Math.round(100 * (1 - free / total))
  const cpuPct = parseFloat(cpuOut)
  return [
    'Offline health (no model needed):',
    `CPU: ${os.cpus().length} logical cores, ${Number.isFinite(cpuPct) ? Math.round(cpuPct) + '% used' : 'usage n/a'}`,
    `RAM: ${(total / 1024 ** 3).toFixed(1)} GiB total, ${(free / 1024 ** 3).toFixed(1)} GiB free (${usedPct}% used)`,
  ].join('\n') + gpuLine + disk
}

function runApp(target) {
  return new Promise((resolve) => {
    const name = ALIASES[target.toLowerCase()] || target
    const child = spawn('cmd', ['/c', 'start', '', name], {
      windowsHide: true, detached: true, stdio: 'ignore',
    })
    let settled = false
    const done = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    child.on('error', (e) => done({ ok: false, text: `Could not open "${target}": ${e.message}` }))
    setTimeout(() => done({ ok: true, text: `Asked Windows to open "${target}".` }), 900)
  })
}

function killApp(target) {
  return new Promise((resolve) => {
    const name = target.toLowerCase()
    execFile('taskkill', ['/IM', name.endsWith('.exe') ? name : `${name}.exe`],
      { windowsHide: true, timeout: 8000 },
      (err, stdout, stderr) => {
        if (err) {
          return resolve({ ok: false, text: `Nothing running as "${target}" that I can close.` })
        }
        resolve({ ok: true, text: `Closed ${target}.` })
      })
  })
}

/**
 * @returns {Promise<{ok:boolean,text:string,offline?:boolean}|null>} null = not an offline intent
 */
async function handle(text) {
  const intent = classify(text)
  if (!intent) return null
  if (intent.type === 'close') return { ...(await killApp(intent.target)), offline: true }
  if (intent.type === 'open') return { ...(await runApp(intent.target)), offline: true }
  return { ok: true, text: await hwSnapshot(), offline: true }
}

/** Pure classification — no side effects, so it is safe to unit-test. */
function classify(text) {
  const q = String(text || '').trim()
  if (!q) return null

  const closeM = q.match(CLOSE_MATCH)
  if (closeM && looksLikeApp(closeM[1])) return { type: 'close', target: closeM[1] }

  const openM = q.match(OPEN_MATCH)
  if (openM && looksLikeApp(openM[1])) return { type: 'open', target: openM[1] }

  if (HW_MATCH.test(q)) return { type: 'health' }
  return null
}

module.exports = { handle, classify, isOnline, hwSnapshot }
