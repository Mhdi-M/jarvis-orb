'use strict'
/**
 * Vision-path ground truth.
 *
 * lib/visionact.js guesses coordinates from a screenshot when no accessibility
 * tree exists. "It works" is not a measurement, so this benches it: UIA reports
 * a control's real rectangle, the vision model is asked for the same control,
 * and the two centres are compared in pixels. Hit = the guessed point landed
 * inside the real rectangle.
 *
 * Both inputs are real: the rectangle comes from UI Automation, the guess from
 * a model looking at the actual window capture.
 */
const path = require('path')
const uia = require('./uia')
const visionact = require('./visionact')

const dist = (dx, dy) => Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10

/** Pure: compare one vision point (image space) with a UIA rect (screen space). */
function compare(rect, origin, point) {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const sx = origin.x + point.x
  const sy = origin.y + point.y
  const dx = Math.round((sx - cx) * 10) / 10
  const dy = Math.round((sy - cy) * 10) / 10
  const inside = sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h
  return { dx, dy, dist: dist(dx, dy), inside, screen: { x: sx, y: sy }, centre: { x: cx, y: cy } }
}

/** Pure: aggregate rows into the numbers a report quotes. */
function summarize(rows) {
  const n = rows.length
  const hits = rows.filter((r) => r.inside).length
  const ds = rows.map((r) => r.dist).filter(Number.isFinite).sort((a, b) => a - b)
  const med = ds.length ? (ds.length % 2 ? ds[(ds.length - 1) / 2] : (ds[Math.floor(ds.length / 2) - 1] + ds[Math.floor(ds.length / 2)]) / 2) : null
  return {
    trials: n,
    hits,
    hitRate: n ? Math.round((hits / n) * 100) : 0,
    medianPx: med == null ? null : Math.round(med * 10) / 10,
    maxPx: ds.length ? Math.round(ds[ds.length - 1] * 10) / 10 : null,
    avgSecs: n ? Math.round((rows.reduce((s, r) => s + (r.secs || 0), 0) / n) * 10) / 10 : null,
  }
}

/**
 * measure({ win, element, trials })
 * Defaults target Chrome's address bar, which UIA can locate exactly.
 */
async function measure(opts = {}) {
  const win = opts.win || 'chrome'
  const element = opts.element || 'Address and search bar'
  const trials = Math.max(1, Math.min(10, Number(opts.trials) || 3))

  const found = await uia.find(win, element, 200)
  if (!found.ok) return { ok: false, error: found.error || 'UIA could not read the window' }
  const norm = (s) => String(s || '').trim().toLowerCase()
  const usable = (found.matches || []).filter((m) => m.w > 4 && m.h > 4 && !/pane|document/i.test(m.type || ''))
  const match = usable.sort((a, b) => {
    const ae = norm(a.name) === norm(element) ? 1 : 0
    const be = norm(b.name) === norm(element) ? 1 : 0
    if (ae !== be) return be - ae
    return (a.w * a.h) - (b.w * b.h)
  })[0] || (found.matches || [])[0]
  if (!match) return { ok: false, error: 'UIA found no control matching "' + element + '"' }

  const rows = []
  for (let i = 1; i <= trials; i++) {
    const t0 = Date.now()
    const shot = await visionact.capture(win)
    if (!shot || !shot.file) { rows.push({ trial: i, ok: false, error: 'capture failed' }); continue }
    const prompt = visionact.promptFor(element)
    const answer = await visionact.look(prompt, shot.file)
    const point = visionact.parsePoint(answer.text)
    const secs = Math.round((Date.now() - t0) / 100) / 10
    if (!point) { rows.push({ trial: i, ok: false, secs, via: answer.via, error: 'no coordinates', answer: String(answer.text || '').slice(0, 120) }); continue }
    const cmp = compare(match, shot.origin, point)
    rows.push({ trial: i, ok: true, secs, via: answer.via, point, ...cmp })
    if (opts.onTrial) { try { opts.onTrial(rows[rows.length - 1]) } catch {} }
  }

  const good = rows.filter((r) => r.ok)
  return {
    ok: good.length > 0,
    window: win,
    element: match.name,
    type: match.type,
    rect: { x: match.x, y: match.y, w: match.w, h: match.h },
    rows,
    summary: summarize(good),
  }
}

function save(result) {
  const file = process.env.JARVIS_VISION_BENCH || path.join(__dirname, '..', 'data', 'vision-accuracy.json')
  try {
    const fs = require('fs')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + '\n')
    return file
  } catch { return null }
}

module.exports = { measure, compare, summarize, save }
