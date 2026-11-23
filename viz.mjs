/* =========================================================================
   viz.mjs — signal-driven spectrum for the Jarvis music surfaces.
   Real AnalyserNode data when an <audio> element is attached, a slow idle
   wave when nothing is playing.
   ========================================================================= */

import { buildBandRanges, bandLevel, idleLevel } from './lib/spectrum.mjs'

export function mediaUrl(absPath) {
  return 'app://bundle/media/' + encodeURIComponent(absPath)
}

export function isAudio(file) {
  return /\.(mp3|wav|m4a|flac|ogg)$/i.test(file || '')
}

export function createViz(canvas, opts = {}) {
  const BARS = opts.bars || 48
  const GAP = opts.gap ?? 2
  const MIRROR = opts.mirror ?? 0.28
  const GLOW = opts.glow ?? 1
  const accent = opts.accent || [127, 180, 216]

  const ctx = canvas.getContext('2d')
  const levels = new Float32Array(BARS)
  const peaks = new Float32Array(BARS)
  let analyser = null
  let freq = null
  let audio = null
  let ac = null
  let raf = 0
  let t0 = performance.now()
  let cssW = 0
  let cssH = 0

  function sizeDrifted() {
    const r = canvas.getBoundingClientRect()
    return Math.abs(r.width - cssW) > 0.6 || Math.abs(r.height - cssH) > 0.6
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height) return
    cssW = r.width
    cssH = r.height
    canvas.width = Math.round(r.width * dpr)
    canvas.height = Math.round(r.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* log-spaced band → FFT bin ranges, so bass gets the room it deserves */
  let bandRanges = []
  function buildBands(bins) {
    bandRanges = buildBandRanges(BARS, bins, ac ? ac.sampleRate : 48000)
  }

  function attach(el) {
    audio = el
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext
        ac = new AC()
      }
      const src = ac.createMediaElementSource(el)
      analyser = ac.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.78
      analyser.minDecibels = -88
      analyser.maxDecibels = -12
      src.connect(analyser)
      analyser.connect(ac.destination)
      freq = new Uint8Array(analyser.frequencyBinCount)
      buildBands(analyser.frequencyBinCount)
      if (ac.state === 'suspended') ac.resume()
    } catch (e) {
      analyser = null
    }
  }

  function detach() {
    try { if (ac && ac.state === 'running') ac.suspend() } catch {}
    analyser = null
    audio = null
  }

  function sample(t) {
    const playing = !!(analyser && audio && !audio.paused && !audio.ended)
    if (playing) {
      analyser.getByteFrequencyData(freq)
      // bass energy for the glow
      let bass = 0
      for (let i = 0; i < 6; i++) bass += freq[i]
      bass = bass / (6 * 255)
      for (let i = 0; i < BARS; i++) {
        const target = bandLevel(freq, bandRanges[i], i, BARS)
        levels[i] += (target - levels[i]) * (target > levels[i] ? 0.55 : 0.16)
      }
      return bass
    }
    // idle: a slow travelling wave, so the surface is never dead
    for (let i = 0; i < BARS; i++) {
      const target = idleLevel(i, BARS, t)
      levels[i] += (target - levels[i]) * 0.05
    }
    return 0
  }

  let sinceCheck = 0

  function draw() {
    raf = requestAnimationFrame(draw)
    // self-heal the backing store when the panel slides in or out
    if (!cssW || !cssH || (++sinceCheck % 15 === 0 && sizeDrifted())) resize()
    if (!cssW || !cssH) return
    const t = performance.now()
    const bass = sample(t)

    ctx.clearRect(0, 0, cssW, cssH)

    const slot = cssW / BARS
    const bw = Math.max(1, slot - GAP)
    const baseY = cssH * (1 - MIRROR)
    const maxH = baseY - 2

    // bass glow behind the bars
    if (GLOW && bass > 0.05) {
      const g = ctx.createRadialGradient(cssW / 2, baseY, 0, cssW / 2, baseY, cssW * 0.55)
      g.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},${(bass * 0.18 * GLOW).toFixed(3)})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, cssW, cssH)
    }

    for (let i = 0; i < BARS; i++) {
      const v = levels[i]
      const h = Math.max(1.5, v * maxH)
      const x = i * slot + (slot - bw) / 2

      // peak cap: falls slowly
      peaks[i] = Math.max(h, peaks[i] - maxH * 0.006)
      const ph = Math.min(maxH, peaks[i])

      // main bar
      const grad = ctx.createLinearGradient(0, baseY - h, 0, baseY)
      grad.addColorStop(0, `rgba(235, 247, 255, ${0.55 + v * 0.45})`)
      grad.addColorStop(0.35, `rgba(${accent[0]},${accent[1]},${accent[2]}, 0.95)`)
      grad.addColorStop(1, `rgba(${accent[0]},${accent[1]},${accent[2]}, 0.35)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      const r = Math.min(bw / 2, 2)
      roundRect(ctx, x, baseY - h, bw, h, r)
      ctx.fill()

      // peak line
      if (ph - h > 1.5) {
        ctx.fillStyle = `rgba(230, 244, 255, ${0.28 + v * 0.4})`
        ctx.fillRect(x, baseY - ph, bw, 1.4)
      }

      // mirrored reflection
      const rh = h * 0.42
      const rg = ctx.createLinearGradient(0, baseY + 1, 0, baseY + 1 + rh)
      rg.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]}, ${(0.16 + v * 0.22).toFixed(3)})`)
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = rg
      ctx.fillRect(x, baseY + 1, bw, rh)
    }

    // baseline
    ctx.fillStyle = 'rgba(170, 200, 225, .16)'
    ctx.fillRect(0, baseY, cssW, 1)
  }

  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y)
    c.lineTo(x + w - r, y)
    c.quadraticCurveTo(x + w, y, x + w, y + r)
    c.lineTo(x + w, y + h)
    c.lineTo(x, y + h)
    c.lineTo(x, y + r)
    c.quadraticCurveTo(x, y, x + r, y)
  }

  resize()
  window.addEventListener('resize', resize)
  // panels slide in, so the canvas box changes after creation
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
  }
  raf = requestAnimationFrame(draw)

  return {
    attach,
    detach,
    resize,
    levels: () => Array.from(levels),
    stop() { cancelAnimationFrame(raf) },
  }
}
