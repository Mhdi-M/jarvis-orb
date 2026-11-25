/* ------------------------------------------------------- tabs and windows
 * Two kinds of switching, because a user does not distinguish them:
 *   - browser tabs, through the CDP endpoint of their own Chrome
 *   - desktop windows, through the Windows shell's AppActivate
 * Both are read-then-act: list first, then activate by index or by name, so a
 * wrong guess is visible instead of silently focusing something random.
 */
const http = require('http')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const CDP = process.env.JARVIS_CDP || 'http://127.0.0.1:9222'

function cdpGet(pathname) {
  return new Promise((resolve) => {
    const req = http.get(CDP + pathname, { timeout: 5000 }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(String(stdout || '').trim() || (err ? '' : '')))
  })
}

async function tabs() {
  const list = await cdpGet('/json/list')
  if (!list) return null
  return list.filter((t) => t.type === 'page').map((t, i) => ({ i: i + 1, id: t.id, title: (t.title || '').slice(0, 60), url: t.url }))
}

async function activateTab(indexOrMatch) {
  const list = await tabs()
  if (!list || !list.length) return { ok: false, reason: 'no tabs (is the debug Chrome running?)' }
  let target = null
  const n = Number(indexOrMatch)
  if (Number.isFinite(n) && n >= 1) target = list[n - 1]
  else {
    const q = String(indexOrMatch).toLowerCase()
    target = list.find((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
  }
  if (!target) return { ok: false, reason: 'no tab matches ' + indexOrMatch, tabs: list }
  const res = await cdpGet('/json/activate/' + target.id)
  return { ok: true, tab: target, result: res }
}

async function windows() {
  const out = await ps('Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Sort-Object ProcessName | ForEach-Object { $_.ProcessName + "|" + $_.MainWindowTitle }')
  if (!out) return []
  return out.split(/\r?\n/).filter(Boolean).map((line, i) => {
    const [name, ...rest] = line.split('|')
    return { i: i + 1, process: name, title: rest.join('|').slice(0, 70) }
  })
}

async function focusApp(match) {
  const list = await windows()
  if (!list.length) return { ok: false, reason: 'no visible windows' }
  const n = Number(match)
  const q = String(match).toLowerCase()
  const target = Number.isFinite(n) && n >= 1
    ? list[n - 1]
    : list.find((w) => w.title.toLowerCase().includes(q) || w.process.toLowerCase().includes(q))
  if (!target) return { ok: false, reason: 'no window matches ' + match, windows: list }
  const psCmd = "(New-Object -ComObject WScript.Shell).AppActivate('" + target.title.replace(/'/g, "''") + "')"
  const out = await ps(psCmd)
  return { ok: out !== 'False', window: target }
}

module.exports = { tabs, activateTab, windows, focusApp, CDP }
