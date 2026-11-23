/**
 * Stress harness — no network, no model, no Electron.
 * Hammers the hot paths that run on every message / every drag frame and fails
 * loudly if any of them throws, leaks, or degrades badly.
 *
 *   node tests/stress.mjs [scale]
 */
import bridge from '../hermes-bridge.js'
import drag from '../lib/drag.js'
import cpu from '../lib/cpu.js'
import offline from '../offline.js'
import notify from '../lib/notify.js'
import media from '../lib/media.js'
import { parseCommand } from '../lib/commands.mjs'
import { buildBandRanges, bandLevel } from '../lib/spectrum.mjs'
import { zoneTime, dayOffset, addZone, normalizeZones } from '../lib/timezones.mjs'

const SCALE = Number(process.argv[2] || 1)
const { parseAnswer } = bridge._internals

const now = () => Number(process.hrtime.bigint()) / 1e6
let failures = 0

function bench(name, iterations, fn) {
  const t0 = now()
  let checksum = 0
  for (let i = 0; i < iterations; i++) {
    try {
      checksum += fn(i) ? 1 : 0
    } catch (e) {
      failures++
      console.error(`  FAIL in ${name} at iteration ${i}: ${e.message}`)
      break
    }
  }
  const ms = now() - t0
  const ops = iterations / (ms / 1000)
  console.log(
    `  ${name.padEnd(28)} ${String(iterations).padStart(9)} iters  ` +
    `${ms.toFixed(0).padStart(7)} ms  ${Math.round(ops).toString().padStart(9)} ops/s  checksum=${checksum}`,
  )
  return ms
}

/* Build realistic CLI output, including the worst cases. */
function makeOutput(i) {
  const filler = 'x'.repeat(200)
  const body = [
    'Query: something',
    '',
    '────────────────────────────────────────',
    '☤ Hermes',
    `answer ${i}: ${filler}`,
    'second line',
    '',
    'fourth line',
    '────────────────────────────────────────',
    '',
    'Resume this session with:',
    `  hermes --resume local-${i}`,
  ].join(i % 2 ? '\r\n' : '\n')
  return i % 17 === 0 ? '\u001b[31m' + body + '\u001b[0m' : body
}

console.log(`\nSTRESS scale=${SCALE}  (heap at start ${(process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1)} MB)\n`)

bench('parseAnswer (full output)', 20000 * SCALE, (i) => parseAnswer(makeOutput(i)).startsWith('answer'))

bench('parseAnswer (no banner)', 20000 * SCALE, () => parseAnswer('Query: a\n\nb\n\nSession: c') === 'b')

bench('parseAnswer (garbage)', 20000 * SCALE, () => parseAnswer('nonsense \u0000 \u001b[0m') === '')

bench('offline.classify', 50000 * SCALE, (i) => {
  const q = [
    'health check', 'open notepad', 'close chrome', 'how much ram',
    'what do you think about open source', '', 'open ../../evil',
    'open app && rm -rf', 'cpu temp', 'kill spotify',
  ][i % 10]
  return offline.classify(q) !== undefined
})

bench('commands.parseCommand', 100000 * SCALE, (i) => {
  const q = ['hello there', '/clr', '/Dashboard berlin', '/frobnicate x', '', '  '][i % 6]
  const r = parseCommand(q)
  return r.type !== undefined
})

/* The visualiser runs a full frame of band maths on every animation tick. */
const RANGES = buildBandRanges(48, 1024)
const FRAME = new Uint8Array(1024)
for (let i = 0; i < FRAME.length; i++) FRAME[i] = (i * 7) % 255

bench('spectrum.frame (48 bars)', 50000 * SCALE, () => {
  let sum = 0
  for (let i = 0; i < RANGES.length; i++) sum += bandLevel(FRAME, RANGES[i], i, RANGES.length)
  return sum > 0
})

bench('notify.clipDetail (copy toast)', 200000 * SCALE, (i) => notify.clipDetail('line one\nline two ' + i, 60).length > 0)

bench('media.resolveMediaTarget', 100000 * SCALE, (i) => {
  const enc = '/media/' + encodeURIComponent((process.platform === 'win32' ? 'C:\\a\\b' : '/a/b') + (i % 2 ? '.mp3' : '.exe'))
  return media.resolveMediaTarget(enc).ok === (i % 2 === 1)
})

bench('timezones.zoneTime', 50000 * SCALE, (i) => zoneTime(new Date(1760000000000 + i * 1000), 'Asia/Tokyo').length === 5)

bench('timezones.dayOffset', 50000 * SCALE, (i) => {
  const d = dayOffset(new Date(1760000000000 + i * 600000), 'America/New_York', 'UTC')
  return d >= -1 && d <= 1
})

bench('timezones.addZone', 200000 * SCALE, (i) => {
  let l = []
  l = addZone(l, 'Asia/Tokyo')
  l = addZone(l, 'Europe/London')
  return l.length <= 4 && i >= 0
})

bench('drag.apply (drag frames)', 100000 * SCALE, (i) => {
  const origin = drag.begin(0, 0)
  drag.apply(origin, 100, 100)
  const r = drag.apply(origin, 100 + (i % 500), 100 + (i % 300))
  return r && Number.isFinite(r.x) && Number.isFinite(r.y)
})

bench('drag.clampToDisplay', 100000 * SCALE, (i) => {
  const p = drag.clampToDisplay({ x: (i % 4000) - 2000, y: (i % 2000) - 1000 }, [520, 480],
    { x: 0, y: 0, width: 1920, height: 1080 })
  return p.x >= -520 && p.y >= 0
})

bench('cpu.sampler', 100000 * SCALE, (i) => {
  const pct = cpu.sampler(() => [{
    times: { user: i, nice: 0, sys: i % 7, idle: i * 2, irq: 0 },
  }])
  pct()
  const v = pct()
  return v >= 0 && v <= 100
})

/* A long-lived sampler must stay bounded — this is the real leak risk. */
const churn = cpu.sampler(() => Array.from({ length: 16 }, (_, k) => ({
  times: { user: k * 3, nice: 0, sys: k, idle: k * 5, irq: 0 },
})))
const before = process.memoryUsage().heapUsed
for (let i = 0; i < 200000 * SCALE; i++) churn()
const after = process.memoryUsage().heapUsed
const growth = (after - before) / 1024 ** 2
console.log(`\n  200k sustained cpu.sampler calls grew heap by ${growth.toFixed(2)} MB`)
if (growth > 25) {
  failures++
  console.error('  FAIL: heap growth suggests a leak in the sampler')
}

/* The per-frame spectrum maths must not allocate per call. */
const specBefore = process.memoryUsage().heapUsed
for (let i = 0; i < 50000 * SCALE; i++) {
  for (let b = 0; b < RANGES.length; b++) bandLevel(FRAME, RANGES[b], b, RANGES.length)
}
const specGrowth = (process.memoryUsage().heapUsed - specBefore) / 1024 ** 2
console.log(`  2.4M bandLevel calls grew heap by ${specGrowth.toFixed(2)} MB`)
if (specGrowth > 25) {
  failures++
  console.error('  FAIL: heap growth suggests a leak in the spectrum maths')
}

/* Concurrency: the bridge must serialise and never reject. */
console.log('\n  concurrency: 50 parallel offline asks')
const t = now()
const results = await Promise.all(
  Array.from({ length: 50 }, (_, i) => offline.handle(i % 2 ? 'health' : 'tell me a story')),
)
const answered = results.filter((r) => r === null || typeof r.text === 'string').length
console.log(`  ${answered}/50 resolved cleanly in ${(now() - t).toFixed(0)} ms`)
if (answered !== 50) { failures++; console.error('  FAIL: some offline calls did not resolve') }

console.log(`\n${failures === 0 ? 'STRESS PASS' : `STRESS FAILED (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
