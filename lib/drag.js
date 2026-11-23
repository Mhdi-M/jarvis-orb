'use strict'
/**
 * Window drag math, pure so it can be unit-tested.
 *
 * Positions are absolute screen coordinates. The first sample only records the
 * offset, so the window never jumps on grab.
 */

/** @returns {{wx:number, wy:number, sx:number|null, sy:number|null}} */
function begin(wx, wy) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) throw new TypeError('begin needs numeric window position')
  return { wx, wy, sx: null, sy: null }
}

/**
 * @returns {{x:number,y:number}|null} null while priming, or when input is unusable
 */
function apply(origin, sx, sy) {
  if (!origin) return null
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null
  if (origin.sx === null || origin.sy === null) {
    origin.sx = sx
    origin.sy = sy
    return null
  }
  return {
    x: Math.round(origin.wx + (sx - origin.sx)),
    y: Math.round(origin.wy + (sy - origin.sy)),
  }
}

/** Clamp so the orb can never be dragged completely off-screen. */
function clampToDisplay(pos, winSize, display) {
  if (!pos || !display) return pos
  const { width, height, x: dx = 0, y: dy = 0 } = display
  const [w, h] = winSize
  const margin = 40
  return {
    x: Math.min(Math.max(pos.x, dx - w + margin), dx + width - margin),
    y: Math.min(Math.max(pos.y, dy), dy + height - margin),
  }
}

module.exports = { begin, apply, clampToDisplay }
