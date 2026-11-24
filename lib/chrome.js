'use strict'
/**
 * Chrome access over the DevTools protocol (port 9222).
 *
 * The assistant uses it two ways: list what you have open, and read the text of
 * a tab — which is how messages in WhatsApp Web / Telegram Web / X get read
 * without touching anyone's encrypted databases.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const PORT = Number(process.env.JARVIS_CDP_PORT || 9222)
const LAUNCHER = path.join(process.env.LOCALAPPDATA || os.homedir(), 'hermes', 'chrome-debug-launch.cmd')

const APPS = [
  { kind: 'whatsapp', label: 'WhatsApp', match: /web\.whatsapp\.com/i },
  { kind: 'telegram', label: 'Telegram', match: /web\.telegram\.org/i },
  { kind: 'instagram', label: 'Instagram', match: /instagram\.com/i },
  { kind: 'x', label: 'X', match: /(^|[.\/])(x|twitter)\.com/i },
  { kind: 'linkedin', label: 'LinkedIn', match: /linkedin\.com/i },
  { kind: 'mail', label: 'Mail', match: /mail\.google\.com|outlook\.(live|office)\.com/i },
  { kind: 'slack', label: 'Slack', match: /app\.slack\.com/i },
  { kind: 'discord', label: 'Discord', match: /discord\.com\/channels/i },
]

function classify(url) {
  for (const a of APPS) if (a.match.test(String(url || ''))) return a
  return null
}

function httpJson(pathname, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function alive() {
  try { await httpJson('/json/version', 2500); return true } catch { return false }
}

/**
 * Chrome drops its debugging port when that instance exits, so every operation
 * makes sure it is up first instead of assuming.
 */
async function ensure(timeoutMs = 9000) {
  if (await alive()) return true
  launch()
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    if (await alive()) return true
  }
  return false
}

/** List open tabs with their app classification. */
async function tabs() {
  if (!(await alive())) {
    if (!(await ensure())) throw new Error('chrome debug port did not open')
  }
  const list = await httpJson('/json/list')
  return list
    .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    .map((t) => {
      const app = classify(t.url)
      return { id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl, app: app ? app.kind : null, appLabel: app ? app.label : null }
    })
}

/** Read a tab's visible text over CDP. */
function readTab(wsUrl, { maxChars = 12000, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    let ws
    const done = (v) => { try { ws && ws.close() } catch {} ; resolve(v) }
    try { ws = new WebSocket(wsUrl) } catch (e) { return resolve({ ok: false, error: e.message }) }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeout)
    let id = 0
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: ++id,
        method: 'Runtime.evaluate',
        params: {
          expression: 'document.body ? document.body.innerText : ""',
          returnByValue: true,
        },
      }))
    })
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      clearTimeout(timer)
      if (m.result && m.result.exceptionDetails) return done({ ok: false, error: m.result.exceptionDetails.text })
      const v = m.result && m.result.result ? m.result.result.value : ''
      done({ ok: true, text: String(v || '').slice(0, maxChars) })
    })
    ws.addEventListener('error', () => { clearTimeout(timer); done({ ok: false, error: 'websocket error' }) })
  })
}

/** Read the newest tab of a given app (whatsapp, telegram, x …). */
async function readApp(kind, opts = {}) {
  let list
  try { list = await tabs() } catch (e) { return { ok: false, error: 'chrome is not reachable on port ' + PORT + ' — run /chrome' } }
  const hits = list.filter((t) => t.app === kind)
  if (!hits.length) return { ok: false, error: `no ${kind} tab open in Chrome`, tabs: list }
  const tab = hits[0]
  const r = await readTab(tab.ws, opts)
  return r.ok ? { ok: true, ...r, app: kind, url: tab.url, title: tab.title } : r
}

/** Start the CDP-enabled Chrome the assistant drives. */
function launch() {
  try {
    if (fs.existsSync(LAUNCHER)) {
      spawn('cmd.exe', ['/c', LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { ok: true, how: 'launcher' }
    }
    spawn('cmd.exe', ['/c', 'start', '', 'chrome.exe', '--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return { ok: true, how: 'direct' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** Turn a message-app page into lines that look like messages. */
function messageLines(text, { max = 40 } = {}) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1 && l.length < 500)
    .filter((l) => !/^(search|chats|archived|new chat|menu|settings|profile)$/i.test(l))
    .slice(-max)
}

module.exports = { tabs, readTab, readApp, classify, launch, alive, ensure, messageLines, PORT, APPS }
