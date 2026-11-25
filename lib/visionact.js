/* --------------------------------------------------------------- visionact
 * The last resort for apps that draw their own UI (Electron canvases, games,
 * remote desktops): they expose no accessibility tree, so the only locator left
 * is a screenshot plus a model that can read it.
 *
 * The order matters, and it is deliberate:
 *   1. UI Automation by name      - exact, free, no model call
 *   2. vision coordinates         - costs a model call, approximate
 * A caller asks to "act on <element>"; this module decides which layer answers.
 *
 * Coordinates come back relative to the captured image, which is the window
 * rectangle, so they are converted to screen space before any click.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const uia = require('./uia')
const operator = require('./operator')

const SHOT = path.join(os.tmpdir(), 'jarvis-canvas.png')

function ps(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 25000 },
      (err, stdout) => resolve(String(stdout || '').trim()))
  })
}

/* Capture one window's rectangle. Falls back to the full screen if the rect is
 * unusable (minimised windows report negative or zero height). */
async function capture(win) {
  const r = await uia.list(win, 1)
  let rect = null
  if (r.ok && r.elements && r.elements.length) {
    const root = r.elements[0]
    if (root.w > 50 && root.h > 50 && root.x > -5000) rect = root
  }
  const psCmd = rect
    ? 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
      '$b=New-Object System.Drawing.Rectangle(' + rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + '); ' +
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
      "$bmp.Save('" + SHOT + "'); $g.Dispose(); $bmp.Dispose(); 'window'"
    : 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
      "$bmp.Save('" + SHOT + "'); $g.Dispose(); $bmp.Dispose(); 'screen'"
  const scope = await ps(psCmd)
  const origin = rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 }
  return { file: SHOT, scope, origin, rect }
}

function askCloud(prompt, file) {
  const bin = process.env.HERMES_BIN || 'C:/Users/you/AppData/Local/hermes/hermes-agent/.hermes/bin/hermes.exe'
  const full = prompt + ' Image path: ' + file
  return new Promise((resolve) => {
    execFile(bin, ['-z', full, '-m', 'gemini-3.6-flash', '--provider', 'gemini', '-t', 'vision'],
      { windowsHide: true, timeout: 120000, maxBuffer: 4 << 20 },
      (err, stdout) => resolve(String(stdout || '').trim()))
  })
}

function askLocal(prompt, file) {
  return new Promise((resolve) => {
    const b64 = fs.readFileSync(file).toString('base64')
    const body = JSON.stringify({ model: 'qwen2.5vl:3b', prompt, images: [b64], stream: false })
    const req = require('http').request({ hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d).response || '') } catch (e) { resolve('') } })
    })
    req.on('error', () => resolve(''))
    req.write(body); req.end()
  })
}

function parsePoint(text) {
  const m = String(text || '').match(/\{[\s\S]*?\}/)
  if (m) {
    try {
      const o = JSON.parse(m[0])
      if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y }
    } catch (e) {}
  }
  const alt = String(text || '').match(/(-?\d+)\s*[,;]\s*(-?\d+)/)
  if (alt) return { x: Number(alt[1]), y: Number(alt[2]) }
  return null
}

/* Act on a named element: accessibility first, vision if there is no tree. */
async function act(win, element) {
  const found = await uia.find(win, element, 300)
  if (found.ok && found.matches && found.matches.length) {
    const hit = found.matches.find((m) => m.enabled !== false) || found.matches[0]
    const r = await uia.click(win, hit.name)
    if (r.ok) return { ok: true, via: 'uia', element: hit.name, type: hit.type }
  }

  await uia.focus(win)
  await new Promise((s) => setTimeout(s, 250))
  const shot = await capture(win)
  const prompt = 'This is a Windows screenshot. Find the control labelled "' + element +
    '". Reply with JSON only: {"x":<pixel>,"y":<pixel>,"found":true|false} where x,y are the centre of that control in image pixels.'
  let answer = await askCloud(prompt, shot.file)
  let via = 'vision-cloud'
  let pt = parsePoint(answer)
  if (!pt) {
    answer = await askLocal(prompt, shot.file)
    via = 'vision-local'
    pt = parsePoint(answer)
  }
  if (!pt) return { ok: false, error: 'no coordinates from either vision model', answer: String(answer).slice(0, 160) }

  const x = shot.origin.x + pt.x
  const y = shot.origin.y + pt.y
  await operator.move(x, y)
  await new Promise((s) => setTimeout(s, 150))
  await operator.click('left')
  return { ok: true, via, element, at: { x, y }, scope: shot.scope }
}

module.exports = { act, capture, parsePoint, SHOT }
