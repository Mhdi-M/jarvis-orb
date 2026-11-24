import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInput, parseMouse } from '../lib/keys.mjs'

test('plain text becomes one text event', () => {
  assert.deepEqual(parseInput('hello'), [{ type: 'text', value: 'hello' }])
})

test('enter, backspace and tab', () => {
  assert.deepEqual(parseInput('\r'), [{ type: 'enter' }])
  assert.deepEqual(parseInput('\n'), [{ type: 'enter' }])
  assert.deepEqual(parseInput('\x7f'), [{ type: 'backspace' }])
  assert.deepEqual(parseInput('\x08'), [{ type: 'backspace' }])
  assert.deepEqual(parseInput('\t'), [{ type: 'tab' }])
})

test('ctrl keys that the TUI binds', () => {
  assert.deepEqual(parseInput('\x03'), [{ type: 'ctrl', key: 'c' }])
  assert.deepEqual(parseInput('\x0c'), [{ type: 'ctrl', key: 'l' }])
  assert.deepEqual(parseInput('\x01'), [{ type: 'ctrl', key: 'a' }])
  assert.deepEqual(parseInput('\x05'), [{ type: 'ctrl', key: 'e' }])
  assert.deepEqual(parseInput('\x15'), [{ type: 'ctrl', key: 'u' }])
})

test('arrow keys', () => {
  assert.deepEqual(parseInput('\x1b[A'), [{ type: 'up' }])
  assert.deepEqual(parseInput('\x1b[B'), [{ type: 'down' }])
  assert.deepEqual(parseInput('\x1b[C'), [{ type: 'right' }])
  assert.deepEqual(parseInput('\x1b[D'), [{ type: 'left' }])
  // application cursor keys
  assert.deepEqual(parseInput('\x1bOA'), [{ type: 'up' }])
})

test('home, end, page keys, delete', () => {
  assert.deepEqual(parseInput('\x1b[H'), [{ type: 'home' }])
  assert.deepEqual(parseInput('\x1b[F'), [{ type: 'end' }])
  assert.deepEqual(parseInput('\x1b[1~'), [{ type: 'home' }])
  assert.deepEqual(parseInput('\x1b[4~'), [{ type: 'end' }])
  assert.deepEqual(parseInput('\x1b[5~'), [{ type: 'pgup' }])
  assert.deepEqual(parseInput('\x1b[6~'), [{ type: 'pgdn' }])
  assert.deepEqual(parseInput('\x1b[3~'), [{ type: 'delete' }])
})

test('lone escape is esc', () => {
  assert.deepEqual(parseInput('\x1b'), [{ type: 'esc' }])
})

test('bracketed paste arrives as ONE paste event, newlines included', () => {
  const chunk = '\x1b[200~line one\nline two\r\nline three\x1b[201~'
  assert.deepEqual(parseInput(chunk), [{ type: 'paste', value: 'line one\nline two\r\nline three' }])
})

test('paste keeps text after the marker in order', () => {
  const ev = parseInput('ab\x1b[200~x\ny\x1b[201~cd')
  assert.deepEqual(ev, [
    { type: 'text', value: 'ab' },
    { type: 'paste', value: 'x\ny' },
    { type: 'text', value: 'cd' },
  ])
})

test('mouse wheel up / down', () => {
  assert.deepEqual(parseMouse(64, 10, 5, 'M'), { type: 'mouse', button: 'wheelup', x: 10, y: 5 })
  assert.deepEqual(parseMouse(65, 10, 5, 'M'), { type: 'mouse', button: 'wheeldown', x: 10, y: 5 })
})

test('mouse press, drag and release from a real SGR report', () => {
  assert.deepEqual(parseInput('\x1b[<0;12;8M'), [{ type: 'mouse', button: 'left', x: 12, y: 8 }])
  assert.deepEqual(parseInput('\x1b[<32;15;9M'), [{ type: 'mouse', button: 'motion', last: 'left', x: 15, y: 9 }])
  assert.deepEqual(parseInput('\x1b[<0;15;9m'), [{ type: 'mouse', button: 'release', last: 'left', x: 15, y: 9 }])
  assert.deepEqual(parseInput('\x1b[<2;4;4M'), [{ type: 'mouse', button: 'right', x: 4, y: 4 }])
})

test('mixed typing and keys in one chunk', () => {
  const ev = parseInput('ab\x1b[Dc\r')
  assert.deepEqual(ev, [
    { type: 'text', value: 'ab' },
    { type: 'left' },
    { type: 'text', value: 'c' },
    { type: 'enter' },
  ])
})
