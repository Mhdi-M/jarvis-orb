import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stripAnsi, maxScroll, clampScroll, windowRows,
  normalizeSelection, selectionText, pasteLine, wordBounds, lineBounds,
} from '../lib/screen.mjs'

test('stripAnsi removes colour codes but keeps text', () => {
  assert.equal(stripAnsi('\x1b[38;2;1;2;3mhi\x1b[0m there'), 'hi there')
})

test('scrolling is clamped to the transcript', () => {
  assert.equal(maxScroll(100, 30), 70)
  assert.equal(maxScroll(10, 30), 0)
  assert.equal(clampScroll(50, 100, 30), 50)
  assert.equal(clampScroll(999, 100, 30), 70)
  assert.equal(clampScroll(-5, 100, 30), 0)
})

test('windowRows follows the bottom at scroll 0', () => {
  const rows = Array.from({ length: 50 }, (_, i) => 'r' + i)
  const w = windowRows(rows, 10, 0)
  assert.deepEqual(w.rows, rows.slice(40))
  assert.equal(w.scroll, 0)
  assert.equal(w.hidden, 40)
})

test('windowRows goes back in history when scrolled up', () => {
  const rows = Array.from({ length: 50 }, (_, i) => 'r' + i)
  const w = windowRows(rows, 10, 10)
  assert.deepEqual(w.rows, rows.slice(30, 40))
  assert.equal(w.hidden, 30)
})

test('windowRows never overscrolls past the top', () => {
  const rows = Array.from({ length: 50 }, (_, i) => 'r' + i)
  const w = windowRows(rows, 10, 999)
  assert.deepEqual(w.rows, rows.slice(0, 10))
  assert.equal(w.scroll, 40)
})

test('selection is normalized whichever way you drag', () => {
  const a = normalizeSelection({ x: 5, y: 3 }, { x: 2, y: 1 })
  assert.deepEqual(a, { r1: 1, c1: 2, r2: 3, c2: 5 })
  const b = normalizeSelection({ x: 2, y: 1 }, { x: 5, y: 3 })
  assert.deepEqual(b, { r1: 1, c1: 2, r2: 3, c2: 5 })
})

test('selectionText pulls exactly the highlighted characters', () => {
  const rows = [
    'you > what is 2+2',
    '    the answer is 4',
    '    done',
  ]
  // drag from row 1 col 7 to row 2 col 13
  const sel = { r1: 1, c1: 7, r2: 2, c2: 13 }
  assert.equal(selectionText(rows, sel), 'what is 2+2\n    the answe')
})

test('selectionText on one row keeps interior spaces', () => {
  const rows = ['abcdef ghij']
  assert.equal(selectionText(rows, { r1: 1, c1: 1, r2: 1, c2: 6 }), 'abcdef')
  assert.equal(selectionText(rows, { r1: 1, c1: 8, r2: 1, c2: 11 }), 'ghij')
})

test('a pasted block becomes one continuous message', () => {
  const pasted = 'first line\nsecond   line\n\nthird line'
  assert.equal(pasteLine(pasted), 'first line second line third line')
  assert.equal(pasteLine('  already one line  '), 'already one line')
  assert.equal(pasteLine('a\r\nb'), 'a b')
})

test('pasting code with newlines does not keep newlines', () => {
  const code = 'function f() {\n  return 1\n}'
  const line = pasteLine(code)
  assert.ok(!line.includes('\n'), 'no newline may survive a paste')
  assert.equal(line, 'function f() { return 1 }')
})

test('wordBounds finds the word under a double-click', () => {
  const line = 'the answer is 391 and that is final'
  assert.deepEqual(wordBounds(line, 15), { c1: 15, c2: 17, word: '391' })
  assert.equal(wordBounds(line, 1).word, 'the')
  assert.equal(wordBounds(line, 5).word, 'answer')
  // clicking a space picks the word after it
  assert.equal(wordBounds(line, 14).word, '391')
  // paths and urls stay one token
  assert.equal(wordBounds('see C:/tmp/a.png now', 10).word, 'C:/tmp/a.png')
  assert.equal(wordBounds('   ', 2), null)
})

test('lineBounds trims trailing spaces', () => {
  assert.deepEqual(lineBounds('hello   '), { c1: 1, c2: 5 })
  assert.deepEqual(lineBounds(''), { c1: 1, c2: 1 })
})
