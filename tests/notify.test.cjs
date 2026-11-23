const test = require('node:test')
const assert = require('node:assert/strict')

const { clipDetail, normalizeKind, notifyPayload, looksLikeScreenshot, KINDS } = require('../lib/notify.js')

test('clipDetail: collapses newlines and runs of spaces', () => {
  assert.equal(clipDetail('hello\n\n   world\t\tagain'), 'hello world again')
})

test('clipDetail: trims the edges', () => {
  assert.equal(clipDetail('   padded   '), 'padded')
})

test('clipDetail: truncates with an ellipsis at the limit', () => {
  const out = clipDetail('a'.repeat(200), 20)
  assert.equal(out.length, 20)
  assert.ok(out.endsWith('…'))
})

test('clipDetail: leaves text shorter than the limit alone', () => {
  assert.equal(clipDetail('short', 80), 'short')
})

test('clipDetail: tolerates non-strings', () => {
  assert.equal(clipDetail(null), '')
  assert.equal(clipDetail(undefined), '')
  assert.equal(clipDetail(42), '')
  assert.equal(clipDetail({}), '')
})

test('clipDetail: a very long single word still truncates cleanly', () => {
  const out = clipDetail('x'.repeat(5000), 80)
  assert.equal(out.length, 80)
})

test('normalizeKind: keeps the supported kinds', () => {
  for (const k of KINDS) assert.equal(normalizeKind(k), k)
})

test('normalizeKind: anything else falls back to info', () => {
  assert.equal(normalizeKind('nonsense'), 'info')
  assert.equal(normalizeKind(undefined), 'info')
  assert.equal(normalizeKind(null), 'info')
})

test('notifyPayload: builds a clean payload', () => {
  assert.deepEqual(
    notifyPayload('copy', 'copied', '  two   lines\nhere '),
    { kind: 'copy', title: 'copied', detail: 'two lines here' },
  )
})

test('notifyPayload: unknown kinds are downgraded', () => {
  assert.equal(notifyPayload('bogus', 'x', 'y').kind, 'info')
})

test('notifyPayload: empty title and detail stay strings', () => {
  const p = notifyPayload('shot', undefined, undefined)
  assert.equal(p.title, '')
  assert.equal(p.detail, '')
})

test('looksLikeScreenshot: only images count', () => {
  assert.equal(looksLikeScreenshot('Screenshot 2026-11-23.png', true), true)
  assert.equal(looksLikeScreenshot('notes.txt', true), false)
  assert.equal(looksLikeScreenshot('video.mp4', true), false)
})

test('looksLikeScreenshot: strict mode needs a screenshot-ish name', () => {
  assert.equal(looksLikeScreenshot('Screenshot 2026.png', false), true)
  assert.equal(looksLikeScreenshot('Snip 12.jpg', false), true)
  assert.equal(looksLikeScreenshot('holiday.JPG', false), false)
  assert.equal(looksLikeScreenshot('holiday.JPG', true), true)
})

test('looksLikeScreenshot: tolerates non-strings', () => {
  assert.equal(looksLikeScreenshot(null), false)
  assert.equal(looksLikeScreenshot(undefined), false)
})
