'use strict'
/**
 * Preview — a local window for anything Jarvis draws.
 *
 * Skills like canvas-design, frontend-design and algorithmic-art produce HTML.
 * Without a preview they are dead weight in a terminal. This serves a folder
 * over loopback (read-only, no directory traversal) and opens the file in the
 * user's browser. `demo()` renders a chart from live performance data so there
 * is always something to look at.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const DIR = process.env.JARVIS_PREVIEW_DIR || path.join(__dirname, '..', 'data', 'previews')
const PORT = Number(process.env.JARVIS_PREVIEW_PORT || 8799)

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' }

let server = null

function ensure() { try { fs.mkdirSync(DIR, { recursive: true }) } catch {} }

function list() {
  ensure()
  try {
    return fs.readdirSync(DIR).filter((f) => /\.(html?|svg|css|js)$/i.test(f)).map((f) => {
      const st = fs.statSync(path.join(DIR, f))
      return { name: f, size: st.size, at: st.mtimeMs }
    }).sort((a, b) => b.at - a.at)
  } catch { return [] }
}

/** Pure: resolve a requested name inside DIR, or null if it escapes. */
function resolve(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/[^\w.-]/g, '')
  if (!base) return null
  const full = path.join(DIR, base)
  if (!full.startsWith(path.resolve(DIR))) return null
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null
}

function start() {
  if (server) return Promise.resolve({ ok: true, already: true, port: server.address().port })
  ensure()
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(String(req.url || '/').split('?')[0])
    const name = url === '/' ? '' : url.replace(/^\//, '')
    if (!name) {
      const items = list()
      const links = items.length
        ? items.map((i) => '<li><a href="/' + encodeURIComponent(i.name) + '">' + i.name + '</a></li>').join('')
        : '<li>nothing yet — run /preview demo</li>'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><meta charset="utf-8"><title>Jarvis previews</title><body style="font:15px system-ui;padding:24px"><h1>Jarvis previews</h1><ul>' + links + '</ul></body>')
    }
    const full = resolve(name)
    if (!full) { res.writeHead(404); return res.end('not found') }
    const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
    try { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); fs.createReadStream(full).pipe(res) } catch { res.writeHead(500); res.end('read error') }
  })
  return new Promise((resolveP) => {
    server.on('error', (e) => { server = null; resolveP({ ok: false, error: e.message }) })
    server.listen(PORT, '127.0.0.1', () => resolveP({ ok: true, port: server.address().port }))
  })
}

function stop() {
  if (!server) return false
  server.close()
  server = null
  return true
}

function open(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch { return false }
}

async function show(name) {
  const full = resolve(name)
  if (!full) return { ok: false, error: 'no such preview: ' + name }
  const up = await start()
  if (!up.ok) return up
  const url = 'http://127.0.0.1:' + up.port + '/' + encodeURIComponent(path.basename(full))
  open(url)
  return { ok: true, url, file: full }
}

/** Write a self-contained HTML file and return its name. */
function write(name, html) {
  ensure()
  const base = String(name || 'preview-' + Date.now()).replace(/[^\w.-]/g, '-')
  const file = base.endsWith('.html') ? base : base + '.html'
  fs.writeFileSync(path.join(DIR, file), String(html || ''), 'utf8')
  return file
}

/** A live demo: performance parts as bars. Proves the whole path end to end. */
function demo() {
  const health = require('./health')
  const p = health.performance({ contextTokens: 0 })
  const rows = [
    ['availability', p.parts.availability],
    ['reliability', p.parts.reliability],
    ['speed', p.parts.speed],
    ['context headroom', p.parts.headroom],
  ]
  const bars = rows.map(([k, v]) => `<div class="row"><span>${k}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div><b>${Math.round(v * 100)}%</b></div>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><title>Jarvis performance</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0f1621;color:#ecf1f7;font:15px/1.5 system-ui,Segoe UI,sans-serif;padding:40px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#8b939b;margin-bottom:28px}
.score{font-size:64px;font-weight:700;letter-spacing:-2px}.score small{font-size:18px;font-weight:400;color:#8b939b;margin-left:12px}
.row{display:grid;grid-template-columns:180px 1fr 56px;gap:14px;align-items:center;margin:14px 0}
.bar{height:10px;background:#1b2533;border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#3b68c7,#79b8ff)}
b{text-align:right;font-weight:600}
</style>
<h1>Jarvis · AI performance</h1><div class="sub">measured from live model and agent outcomes · ${new Date().toLocaleString()}</div>
<div class="score">${p.score}%<small>${p.label}</small></div>
${bars}
<p class="sub">median ${p.medianSecs != null ? p.medianSecs + 's' : '—'} · ${p.attempts} recorded attempt(s)</p>`
  const file = write('performance', html)
  return { file, url: 'http://127.0.0.1:' + PORT + '/' + encodeURIComponent(file), score: p.score }
}

module.exports = { start, stop, show, open, list, resolve, write, demo, DIR, PORT }
