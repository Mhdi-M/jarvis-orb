import test from 'node:test'
import assert from 'node:assert/strict'

import bridge from '../hermes-bridge.js'
import drag from '../lib/drag.js'
import cpu from '../lib/cpu.js'
import offline from '../offline.js'

const { parseAnswer, stripAnsi } = bridge._internals

/* ------------------------------------------------------------- parsing ---- */

test('parseAnswer: pulls the answer out of the banner block', () => {
  const raw = [
    'Query: hi',
    '',
    '────────────────────────────────────────',
    '☤ Hermes',
    'Hello there.',
    '────────────────────────────────────────',
    '',
    'Resume this session with:',
    '  hermes --resume local-abc',
  ].join('\n')
  assert.equal(parseAnswer(raw), 'Hello there.')
})

test('parseAnswer: keeps multi-line and blank lines inside the block', () => {
  const raw = [
    '──────────',
    '☤ Hermes',
    'line one',
    '',
    'line three',
    '──────────',
  ].join('\n')
  assert.equal(parseAnswer(raw), 'line one\n\nline three')
})

test('parseAnswer: tolerates CRLF', () => {
  const raw = '──────\r\n☤ Hermes\r\nwindows\r\n──────\r\n'
  assert.equal(parseAnswer(raw), 'windows')
})

test('parseAnswer: falls back when there is no banner', () => {
  const raw = 'Query: what\n\nanswer text\n\nSession: x'
  assert.equal(parseAnswer(raw), 'answer text')
})

test('parseAnswer: returns empty string when there is nothing useful', () => {
  assert.equal(parseAnswer(''), '')
  assert.equal(parseAnswer('just noise'), '')
})

test('stripAnsi: removes colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
})

/* ---------------------------------------------------------------- drag ---- */

test('drag: first sample primes, second sample moves by the delta', () => {
  const origin = drag.begin(100, 200)
  assert.equal(drag.apply(origin, 500, 500), null)          // priming
  assert.deepEqual(drag.apply(origin, 540, 470), { x: 140, y: 170 })
})

test('drag: no origin means no movement (this was the "cannot drop" bug)', () => {
  assert.equal(drag.apply(null, 10, 10), null)
})

test('drag: bad samples are ignored instead of producing NaN', () => {
  const origin = drag.begin(0, 0)
  drag.apply(origin, 10, 10)
  assert.equal(drag.apply(origin, NaN, 20), null)
  assert.equal(drag.apply(origin, 30, undefined), null)
  assert.deepEqual(drag.apply(origin, 40, 10), { x: 30, y: 0 })
})

test('drag: begin rejects non-numeric window positions', () => {
  assert.throws(() => drag.begin(undefined, 0), TypeError)
})

test('drag: clamp keeps the window reachable', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  const far = drag.clampToDisplay({ x: -9999, y: -9999 }, [520, 480], display)
  assert.ok(far.x >= -480 && far.y >= 0)
  const huge = drag.clampToDisplay({ x: 9999, y: 9999 }, [520, 480], display)
  assert.ok(huge.x <= 1920 && huge.y <= 1080)
})

/* ----------------------------------------------------------------- cpu ---- */

const cpus = (idle, busy) => [{
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
}]

test('cpu: first sample is 0, second reflects the delta', () => {
  let frame = cpus(100, 0)
  const pct = cpu.sampler(() => frame)
  assert.equal(pct(), 0)
  frame = cpus(150, 50)                 // 50 idle, 50 busy => 50%
  assert.equal(pct(), 50)
})

test('cpu: fully idle reads 0, fully busy reads 100', () => {
  let frame = cpus(0, 0)
  const pct = cpu.sampler(() => frame)
  pct()
  frame = cpus(100, 0)
  assert.equal(pct(), 0)
  frame = cpus(100, 100)
  assert.equal(pct(), 100)
})

test('cpu: never returns NaN or out-of-range values', () => {
  let frame = cpus(0, 0)
  const pct = cpu.sampler(() => frame)
  pct()
  frame = cpus(0, 0)                    // no time passed at all
  const v = pct()
  assert.ok(Number.isFinite(v) && v >= 0 && v <= 100)
})

/* ------------------------------------------------------------- offline ---- */

test('offline: recognises health questions', () => {
  for (const q of ['health check', 'how much RAM', 'cpu and gpu temp?', 'disk space', 'status']) {
    assert.equal(offline.classify(q)?.type, 'health', q)
  }
})

test('offline: recognises open and close intents', () => {
  assert.deepEqual(offline.classify('open notepad'), { type: 'open', target: 'notepad' })
  assert.deepEqual(offline.classify('please close Chrome'), { type: 'close', target: 'Chrome' })
  assert.deepEqual(offline.classify('kill spotify.'), { type: 'close', target: 'spotify' })
})

test('offline: refuses to treat prose as a command', () => {
  assert.equal(offline.classify('what do you think about open source'), null)
  assert.equal(offline.classify(''), null)
  assert.equal(offline.classify(null), null)
})

test('offline: rejects app names with shell metacharacters', () => {
  assert.equal(offline.classify('open notepad && calc'), null)
  assert.equal(offline.classify('open ../../evil.exe'), null)
})
