/* ------------------------------------------------------------------- uia
 * Accessibility-first interaction with desktop apps.
 *
 * Coordinate guessing is the reason "click Send in Feishu" used to be a coin
 * flip: the agent had to look at a screenshot and hope. UI Automation exposes
 * the real tree instead - name, control type, id, bounds, enabled - so an
 * element can be chosen by what it IS, then clicked by its own rectangle (or
 * invoked directly, which works even when the window is partly covered).
 */
const path = require('path')
const { execFile } = require('child_process')

const SCRIPT = path.join(__dirname, '..', 'tools', 'uia.ps1')

function run(args) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT].concat(args),
      { windowsHide: true, timeout: 30000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        const text = String(stdout || '').trim()
        try { resolve(JSON.parse(text)) } catch (e) {
          resolve({ ok: false, error: text.slice(0, 200) || (err && err.message) || 'no output' })
        }
      })
  })
}

function list(win, max) {
  return run(['-Action', 'list', '-Window', win, '-Max', String(max || 60)])
}

function focus(win) {
  return run(['-Action', 'focus', '-Window', win])
}

/* Click by element name. Prefers InvokePattern; falls back to the element's
 * own bounding box, which is far safer than a screenshot guess. */
async function click(win, name) {
  const r = await run(['-Action', 'invoke', '-Window', win, '-Name', name])
  if (r.ok) return r
  if (r.x !== undefined && r.y !== undefined) {
    const op = require('./operator')
    await op.move(r.x, r.y)
    await new Promise((s) => setTimeout(s, 120))
    await op.click('left')
    return { ok: true, via: 'bounds-click', element: r.element, x: r.x, y: r.y }
  }
  return r
}

/* Type into a named field: ValuePattern when the control supports it,
 * otherwise focus it and paste (unicode-safe). */
async function typeInto(win, name, text) {
  const r = await run(['-Action', 'set', '-Window', win, '-Name', name, '-Value', text])
  if (r.ok) return r
  if (r.x !== undefined && r.y !== undefined) {
    const op = require('./operator')
    await op.move(r.x, r.y)
    await new Promise((s) => setTimeout(s, 120))
    await op.click('left')
    await new Promise((s) => setTimeout(s, 180))
    await op.pasteText(text)
    return { ok: true, via: 'focus-paste', element: r.element }
  }
  return r
}

/* Find elements by type or name fragment, for planning steps. */
async function find(win, query, max) {
  const r = await list(win, max || 200)
  if (!r.ok) return r
  const q = String(query || '').toLowerCase()
  return { ok: true, matches: (r.elements || []).filter((e) =>
    (e.name || '').toLowerCase().includes(q) || (e.type || '').toLowerCase().includes(q)) }
}

module.exports = { list, click, typeInto, focus, find, SCRIPT }
