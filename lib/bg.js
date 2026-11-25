/* Background tasks: no window, no prompt, a log on disk and a toast at the end.
 * The TUI never waits on these; they survive until the process exits. */
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')

const DIR = path.join(__dirname, '..', 'data', 'bg')

function ensure() { try { fs.mkdirSync(DIR, { recursive: true }) } catch (e) {} }

function start(task) {
  ensure()
  const id = 'bg-' + Date.now().toString(36)
  const meta = { id, task, started: new Date().toISOString(), status: 'running', pid: null }
  const file = path.join(DIR, id + '.json')
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n')

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'bg-run.js'), id, task],
    { detached: true, stdio: 'ignore', windowsHide: true })
  meta.pid = child.pid
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n')
  child.unref()
  return meta
}

function list() {
  ensure()
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) } catch (e) { return null }
  }).filter(Boolean).sort((a, b) => (a.started < b.started ? 1 : -1))
}

function log(id, tail) {
  const f = path.join(DIR, id + '.log')
  if (!fs.existsSync(f)) return ''
  const t = fs.readFileSync(f, 'utf8')
  return tail ? t.split('\n').slice(-tail).join('\n') : t
}

function kill(id) {
  const m = list().find((x) => x.id === id)
  if (!m || !m.pid) return false
  try { execFile('taskkill', ['/PID', String(m.pid), '/T', '/F'], { windowsHide: true }, () => {}) } catch (e) { return false }
  return true
}

module.exports = { start, list, log, kill, DIR }
