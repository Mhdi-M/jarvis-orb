/* ------------------------------------------------------------------- orb
 * A terminal take on thinking-orbs (Jakubantalik/thinking-orbs): a dotted
 * sphere drawn with braille cells, one motion per agent state, so the top
 * strip says what Jarvis is actually doing instead of spinning the same way
 * for everything.
 *
 * Braille gives 2x4 dots per character, so a 64-column strip is a 128x12 dot
 * canvas — enough to read as a sphere without WebGL or a font with glyphs.
 */

const BLANK = 0x2800
const STATES = ['working', 'searching', 'solving', 'listening', 'connecting', 'weaving', 'composing', 'breathing', 'shaping']

/* dots on a fibonacci sphere: even coverage, no seam */
function sphereDots(n) {
  const pts = []
  const ga = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = ga * i
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r })
  }
  return pts
}

/* view rotation, so the sphere reads as 3D rather than a flat disc */
function rotate(p, ax, ay) {
  const cy = Math.cos(ay), sy = Math.sin(ay)
  const cx = Math.cos(ax), sx = Math.sin(ax)
  const x1 = p.x * cy - p.z * sy
  const z1 = p.x * sy + p.z * cy
  const y1 = p.y * cx - z1 * sx
  const z2 = p.y * sx + z1 * cx
  return { x: x1, y: y1, z: z2 }
}

/* every state: (dot, t, frame) -> 0..1 presence */
function intensity(state, d, t, p) {
  const lat = Math.asin(Math.max(-1, Math.min(1, d.y)))     // -pi/2..pi/2
  const lon = Math.atan2(d.z, d.x)                           // -pi..pi
  const spin = t * 0.9

  switch (state) {
    case 'searching': {
      /* a wide scan arc sweeps the visible face */
      const rlon = Math.atan2((p && p.z) || 0, (p && p.x) || 1)
      const band = Math.cos(rlon - t * 2)
      return band > -0.3 ? 1 : 0
    }

    case 'solving': {
      /* bands scramble, then click back into place */
      const settle = (t % 4) > 2.6
      const band = Math.sin(lat * 7 + (settle ? 0 : spin * 3))
      return Math.abs(band) > 0.7 ? 1 : 0.30
    }
    case 'listening': {
      /* a waveform rolls through the rings */
      return Math.abs(Math.sin(lat * 6 + t * 2.2)) > 0.55 ? 1 : 0.1
    }
    case 'connecting': {
      /* a constellation wires itself */
      const k = (Math.sin(lon * 3 + t) + Math.sin(lat * 4 - t * 0.6)) / 2
      return k > 0.3 ? 1 : 0.26
    }
    case 'weaving': {
      /* three strands plaiting */
      const s = Math.sin(lon * 3 + lat * 4 + t * 2)
      return Math.abs(s) > 0.5 ? 1 : 0.28
    }
    case 'composing': {
      /* undulating sash */
      const s = Math.sin(lat * 3 - t * 2.1)
      return s > -0.2 ? 0.9 : 0.1
    }
    case 'breathing': {
      /* slow pulse, whole sphere */
      const p = (Math.sin(t * 1.1) + 1) / 2
      return 0.25 + p * 0.75
    }
    case 'shaping': {
      /* circle -> triangle -> square: radius follows the phase */
      const ph = (t * 0.5) % 3
      const seg = Math.floor(ph)
      const f = ph - seg
      const ang = lon
      const polyR = (n) => {
        const a = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        const slice = (2 * Math.PI) / n
        return Math.cos(slice / 2) / Math.cos((a % slice) - slice / 2)
      }
      const target = seg === 0 ? 1 : seg === 1 ? polyR(3) : polyR(4)
      const r = 0.72 + (target - 0.72) * f
      const rad = Math.sqrt(d.x * d.x + d.z * d.z) || 0.001
      return Math.abs(rad - r * 0.95) < 0.16 ? 1 : 0.06
    }
    case 'working':
    default: {
      /* particles on three tilted orbits */
      const s = Math.sin(lon * 2 + lat * 5 + spin * 2)
      return Math.abs(s) > 0.5 ? 1 : 0.30
    }
  }
}

/* Render one frame: rows of braille characters, values from intensity. */
function render(state, cols, rows, t) {
  const st = STATES.includes(state) ? state : 'working'
  const w = Math.max(8, Math.floor(cols)) * 2
  const h = Math.max(2, Math.floor(rows)) * 4
  const dots = sphereDots(Math.round(w * h * 0.85))
  const grid = new Uint8Array(Math.ceil(w / 2) * Math.ceil(h / 4))
  const ay = t * 0.55
  const ax = Math.sin(t * 0.4) * 0.35

  for (const d of dots) {
    const p = rotate(d, ax, ay)
    if (p.z <= 0.02) continue                       // back face hidden
    const sx = Math.round((p.x * 0.86 + 1) * 0.5 * (w - 1))
    const sy = Math.round((1 - (p.y * 0.86 + 1) * 0.5) * (h - 1))
    const v = intensity(st, d, t, p) * (0.62 + 0.38 * Math.max(0, p.z))
    if (v < 0.34) continue
    const cx = Math.floor(sx / 2)
    const cy = Math.floor(sy / 4)
    const bitX = sx % 2
    const bitY = sy % 4
    const bits = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]]
    grid[cy * Math.ceil(w / 2) + cx] |= bits[bitX][bitY]
  }

  const lines = []
  for (let r = 0; r < Math.ceil(h / 4); r++) {
    let line = ''
    for (let c = 0; c < Math.ceil(w / 2); c++) {
      const v = grid[r * Math.ceil(w / 2) + c]
      line += String.fromCharCode(BLANK + v)
    }
    lines.push(line)
  }
  return lines
}

/* Single character stand-in for tight spaces (sidebar, status rows). */
const GLYPHS = { working: '◐', searching: '◓', solving: '◑', listening: '◒', connecting: '◔', weaving: '◕', composing: '◖', breathing: '◗', shaping: '◉' }
function glyph(state, t) {
  const st = STATES.includes(state) ? state : 'working'
  const spin = ['◐', '◓', '◑', '◒']
  return st === 'working' ? spin[(t | 0) % 4] : GLYPHS[st]
}

module.exports = { render, glyph, STATES, sphereDots }
