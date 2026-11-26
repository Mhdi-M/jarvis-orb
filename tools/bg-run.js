/* Runs one Jarvis task with no console window, writes a log, then notifies.
 * Started detached by lib/bg.js so the interactive TUI is never blocked. */
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')

const id = process.argv[2]
const task = process.argv.slice(3).join(' ')
const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, 'data', 'bg')
const HERMES = process.env.HERMES_BIN || require('../lib/hermes-bin').hermesBin()

function finish(code, note) {
  const meta = path.join(DIR, id + '.json')
  let m = {}
  try { m = JSON.parse(fs.readFileSync(meta, 'utf8')) } catch (e) {}
  m.status = code === 0 ? 'done' : 'failed'
  m.ended = new Date().toISOString()
  m.note = note || ''
  try { fs.writeFileSync(meta, JSON.stringify(m, null, 2) + '\n') } catch (e) {}
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'tools', 'toast.ps1'), '-Title', 'Jarvis',
    '-Message', id + ' ' + m.status + ': ' + String(task).slice(0, 80)],
    { windowsHide: true }, () => {})
}

const out = fs.openSync(path.join(DIR, id + '.log'), 'a')
const env = Object.assign({}, process.env)
try {
  const text = fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env'), 'utf8')
  for (const line of text.split(String.fromCharCode(10))) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"]+?)['"]?\s*$/)
    if (mm && !env[mm[1]]) env[mm[1]] = mm[2]
  }
} catch (e) {}

const child = spawn(HERMES, ['-z', task], { env, stdio: ['ignore', out, out], windowsHide: true })
child.on('exit', (code) => finish(code === null ? 1 : code))
child.on('error', (e) => finish(1, e.message))
