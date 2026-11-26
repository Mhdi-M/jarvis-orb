const test = require('node:test')
const assert = require('node:assert/strict')
const verify = require('../lib/verify')
const health = require('../lib/health')
const quality = require('../lib/quality')

test('verify: correct arithmetic passes and is marked checked', () => {
  const r = verify.verdict('what is 37 * 19?', '37 * 19 = 703')
  assert.equal(r.ok, true)
  assert.equal(r.checked, true)
})

test('verify: wrong arithmetic fails and names the correct value', () => {
  const r = verify.verdict('what is 37 * 19?', 'the answer is 700')
  assert.equal(r.ok, false)
  assert.equal(r.right, 703)
})

test('verify: a bare number answer is accepted when it equals the result', () => {
  assert.equal(verify.verdict('12 + 30 = ?', '42').ok, true)
  assert.equal(verify.verdict('12 + 30 = ?', 'I think 41').ok, false)
})

test('verify: percent-of expressions are computed', () => {
  assert.equal(verify.verdict('what is 20% of 250?', '50').ok, true)
  assert.equal(verify.verdict('what is 20% of 250?', '25').ok, false)
})

test('verify: JSON request must parse', () => {
  assert.equal(verify.verdict('reply with json {"ok":true}', '{"ok":true}').ok, true)
  assert.equal(verify.verdict('reply with json {"ok":true}', 'yes ok').ok, false)
})

test('quality: error shapes are not answers', () => {
  for (const t of ['', '   ', '{"error":"rate limit"}', '<!doctype html><html>', 'Traceback (most recent call last):\n  File "x.py"', 'HTTP 503 Service Unavailable'])
    assert.equal(quality.assess(t).ok, false, JSON.stringify(t))
  assert.equal(quality.assess('The capital of France is Paris.').ok, true)
})

test('health: performance includes the benchmark term and labels no-data honestly', () => {
  const now = Date.now()
  const m = { ok: 10, fail: 0, lastOk: now, lastSecs: 5 }
  const noBench = health.computePerformance({ models: { 'p/m': m }, recentSecs: [5] })
  const withBench = health.computePerformance({ models: { 'p/m': m }, recentSecs: [5], benchmark: 1 })
  assert.ok(withBench.score > noBench.score)
  assert.equal(withBench.parts.benchmark, 1)
  assert.equal(noBench.parts.benchmark, null)
  assert.equal(health.computePerformance({}).label, 'no data')
})

test('health: a failing model ranks lower than a succeeding one', () => {
  const now = Date.now()
  const good = { ok: 5, fail: 0, lastOk: now, lastSecs: 4 }
  const bad = { ok: 0, fail: 5, lastOk: 0, lastFail: now }
  const g = health.computePerformance({ models: { a: good }, recentSecs: [4] })
  const b = health.computePerformance({ models: { a: bad }, recentSecs: [] })
  assert.ok(g.score > b.score)
})
