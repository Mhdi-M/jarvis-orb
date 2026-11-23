import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBandRanges, bandLevel, idleLevel } from '../lib/spectrum.mjs'

test('buildBandRanges: one range per bar', () => {
  const r = buildBandRanges(48, 1024)
  assert.equal(r.length, 48)
})

test('buildBandRanges: ranges are ordered, non-empty and inside the FFT', () => {
  const bins = 1024
  const r = buildBandRanges(48, bins)
  let prevStart = 0
  for (const [b0, b1] of r) {
    assert.ok(b1 > b0, 'range must not be empty')
    assert.ok(b0 >= 1 && b1 <= bins, 'range must stay inside the spectrum')
    assert.ok(b0 >= prevStart, 'ranges must move upwards')
    prevStart = b0
  }
})

test('buildBandRanges: covers the advertised frequency span', () => {
  const r = buildBandRanges(16, 2048, 48000)
  const firstStart = r[0][0]
  const lastEnd = r[r.length - 1][1]
  // 40 Hz at 48k/2048 is bin ~1.7, 16 kHz is bin ~683
  assert.ok(firstStart <= 3, 'starts near 40 Hz')
  assert.ok(lastEnd >= 600, 'reaches near 16 kHz')
})

test('buildBandRanges: gracefully handles nonsense arguments', () => {
  assert.deepEqual(buildBandRanges(0, 1024), [])
  assert.deepEqual(buildBandRanges(-3, 1024), [])
  assert.deepEqual(buildBandRanges(48, 0), [])
  assert.deepEqual(buildBandRanges(NaN, 1024), [])
})

test('buildBandRanges: a 44.1 kHz device still yields valid ranges', () => {
  const r = buildBandRanges(32, 1024, 44100)
  assert.equal(r.length, 32)
  for (const [b0, b1] of r) assert.ok(b1 > b0 && b1 <= 1024)
})

test('bandLevel: silence is zero', () => {
  const freq = new Uint8Array(1024)
  const range = buildBandRanges(8, 1024)[2]
  assert.equal(bandLevel(freq, range, 2, 8), 0)
})

test('bandLevel: louder input gives a taller bar', () => {
  const range = buildBandRanges(8, 1024)[2]
  const quiet = new Uint8Array(1024).fill(10)
  const loud = new Uint8Array(1024).fill(200)
  assert.ok(bandLevel(loud, range, 2, 8) > bandLevel(quiet, range, 2, 8))
})

test('bandLevel: always inside 0..1, even when saturated', () => {
  const range = buildBandRanges(8, 1024)[2]
  const maxed = new Uint8Array(1024).fill(255)
  const v = bandLevel(maxed, range, 2, 8)
  assert.ok(v >= 0 && v <= 1, 'got ' + v)
  assert.ok(v < 1, 'the soft knee should keep it below a pinned 1.0')
})

test('bandLevel: the high end is tilted up relative to an equal signal', () => {
  const freq = new Uint8Array(1024).fill(120)
  const ranges = buildBandRanges(32, 1024)
  const low = bandLevel(freq, ranges[2], 2, 32)
  const high = bandLevel(freq, ranges[29], 29, 32)
  assert.ok(high > low, 'high bands should read louder for the same input')
})

test('bandLevel: tolerates missing data', () => {
  assert.equal(bandLevel(null, [1, 2], 0, 8), 0)
  assert.equal(bandLevel(new Uint8Array(4), null, 0, 8), 0)
})

test('idleLevel: stays small and positive, and moves over time', () => {
  let min = 1
  let max = 0
  for (let t = 0; t < 20000; t += 250) {
    const v = idleLevel(3, 32, t)
    assert.ok(v > 0 && v < 0.2, 'idle level ' + v)
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  assert.ok(max - min > 0.01, 'the idle wave should travel')
})
