/* -------------------------------------------------------------- operator
 * Jarvis can drive the pointer and the keyboard, but only after the user asks
 * for it: `/takeover <task>` is the permission grant, `off` or the task ending
 * takes it back.
 *
 * While it drives, the real cursor keeps working (the overlay is click-through)
 * but a small robot face follows the pointer so it is obvious that an agent,
 * not the user, is moving things.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')
const agents = require('./agents')

const STOP = path.join(os.tmpdir(), 'jarvis-operator.stop')
const PS1 = path.join(__dirname, '..', 'tools', 'robot-cursor.ps1')
let overlay = null
let active = false

function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(String(stdout || '').trim() || (err ? 'error: ' + err.message : '')))
  })
}

async function startOverlay() {
  if (overlay) return true
  try { fs.unlinkSync(STOP) } catch (e) {}
  /* stdio must be piped: with stdio:'ignore' the WinForms message loop exits
   * immediately (verified: exit 0 at once vs still alive after 4s with pipes).
   * The streams are drained and discarded, and the child is not detached, so the
   * overlay dies with Jarvis instead of outliving it. */
  overlay = spawn('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-StopFile', STOP],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  overlay.stdout.on('data', () => {})
  overlay.stderr.on('data', () => {})
  overlay.on('exit', () => { overlay = null })
  await new Promise((r) => setTimeout(r, 1200))
  return !!alive()
}

function alive() {
  return overlay && overlay.exitCode === null && !overlay.killed
}

async function stopOverlay() {
  try { fs.writeFileSync(STOP, '1') } catch (e) {}
  await new Promise((r) => setTimeout(r, 700))
  if (overlay) { try { overlay.kill() } catch (e) {} overlay = null }
  try { fs.unlinkSync(STOP) } catch (e) {}
  active = false
  return true
}

/* --- input primitives: C# P/Invoke through powershell, no native deps --- */
async function move(x, y) {
  return ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(' + Math.round(x) + ',' + Math.round(y) + ')')
}

async function pos() {
  const out = await ps('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"')
  const [x, y] = String(out).split(',').map(Number)
  return { x, y }
}

async function click(button) {
  const b = (button || 'left').toLowerCase()
  const down = b === 'right' ? '0x0008' : (b === 'middle' ? '0x0020' : '0x0002')
  const up = b === 'right' ? '0x0010' : (b === 'middle' ? '0x0040' : '0x0004')
  return ps('Add-Type -AssemblyName System.Windows.Forms; ' +
    "Add-Type -Name U -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);'; " +
    '[W.U]::mouse_event(' + down + ',0,0,0,0); Start-Sleep -Milliseconds 40; [W.U]::mouse_event(' + up + ',0,0,0,0)')
}

async function typeText(text) {
  const safe = String(text).replace(/'/g, "''")
  return ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + safe + "')")
}

/* --- the takeover itself -------------------------------------------------
 * The operator is a normal registry agent with the desktop toolset, so it
 * inherits the same failover rules as every other specialist. The overlay is
 * decoration: it never gates or intercepts input. */
async function run(task, opts) {
  const o = opts || {}
  const onTrace = o.onTrace || (() => {})
  const op = agents.get('operator') || {
    name: 'operator', provider: 'custom:swm', model: 'deepseek/deepseek-v4-flash', toolsets: 'computer_use'
  }

  active = true
  onTrace({ phase: 'overlay', status: (await startOverlay()) ? 'on' : 'failed' })
  const res = await agents.run(op, task, o)
  await stopOverlay()
  onTrace({ phase: 'done', status: res.status, secs: res.secs })
  return res
}

module.exports = { run, startOverlay, stopOverlay, alive, move, pos, click, typeText,
  get active() { return active }, STOP, PS1 }
