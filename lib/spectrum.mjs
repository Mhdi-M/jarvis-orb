/* Spectrum maths for viz.mjs — pure and testable without a canvas. */

export function buildBandRanges(bars, bins, sampleRate = 48000, minHz = 40, maxHz = 16000) {
  if (!Number.isFinite(bars) || bars < 1 || !Number.isFinite(bins) || bins < 2) return []
  const nyq = sampleRate / 2
  const out = []
  for (let i = 0; i < bars; i++) {
    const f0 = minHz * Math.pow(maxHz / minHz, i / bars)
    const f1 = minHz * Math.pow(maxHz / minHz, (i + 1) / bars)
    const b0 = Math.max(1, Math.floor((f0 / nyq) * bins))
    const b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * bins))
    out.push([b0, Math.min(bins, b1)])
  }
  return out
}

/** Average a band of FFT bytes into a 0..1 bar height. */
export function bandLevel(freq, range, barIndex, bars) {
  if (!freq || !range) return 0
  const [b0, b1] = range
  let sum = 0
  for (let b = b0; b < b1; b++) sum += freq[b] || 0
  const avg = sum / Math.max(1, b1 - b0) / 255
  const tilt = 1 + (barIndex / Math.max(1, bars)) * 0.32
  let v = Math.pow(avg, 0.82) * tilt
  if (v > 0.82) v = 0.82 + (v - 0.82) * 0.45
  return Math.min(1, Math.max(0, v))
}

/** Idle shape: a slow travelling wave so the surface is never dead. */
export function idleLevel(barIndex, bars, timeMs) {
  const w = 0.5 + 0.5 * Math.sin(timeMs * 0.0011 + barIndex * 0.42)
  const w2 = 0.5 + 0.5 * Math.sin(timeMs * 0.0007 - barIndex * 0.21)
  return 0.045 + 0.10 * w * w2
}
