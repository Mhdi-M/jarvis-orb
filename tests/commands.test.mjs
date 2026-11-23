import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCommand, KNOWN } from '../lib/commands.mjs'

test('parseCommand: plain text is a question', () => {
  assert.deepEqual(parseCommand('what is my cpu doing'), { type: 'ask', text: 'what is my cpu doing' })
})

test('parseCommand: trims surrounding whitespace', () => {
  assert.deepEqual(parseCommand('   hello  '), { type: 'ask', text: 'hello' })
})

test('parseCommand: empty and whitespace-only input', () => {
  assert.equal(parseCommand('').type, 'empty')
  assert.equal(parseCommand('   ').type, 'empty')
  assert.equal(parseCommand(null).type, 'empty')
  assert.equal(parseCommand(undefined).type, 'empty')
})

test('parseCommand: a bare slash is empty, not a command', () => {
  assert.equal(parseCommand('/').type, 'empty')
})

test('parseCommand: /clr is a known command', () => {
  const r = parseCommand('/clr')
  assert.equal(r.type, 'command')
  assert.equal(r.name, 'clr')
  assert.equal(r.known, true)
  assert.equal(r.arg, '')
})

test('parseCommand: commands are case-insensitive', () => {
  assert.equal(parseCommand('/CLR').name, 'clr')
  assert.equal(parseCommand('/Music').name, 'music')
})

test('parseCommand: arguments are kept and joined', () => {
  const r = parseCommand('/dashboard  berlin  weather')
  assert.equal(r.name, 'dashboard')
  assert.equal(r.arg, 'berlin weather')
})

test('parseCommand: unknown slash commands are flagged, not treated as questions', () => {
  const r = parseCommand('/frobnicate now')
  assert.equal(r.type, 'command')
  assert.equal(r.name, 'frobnicate')
  assert.equal(r.known, false)
  assert.equal(r.arg, 'now')
})

test('parseCommand: every advertised command is in the known list', () => {
  for (const name of ['help', 'music', 'dashboard', 'hardware', 'settings', 'attach', 'voice', 'clear', 'clr', 'new', 'back']) {
    assert.ok(KNOWN.includes(name), name + ' should be known')
    assert.equal(parseCommand('/' + name).known, true, name)
  }
})

test('parseCommand: a slash inside a sentence is not a command', () => {
  assert.equal(parseCommand('what is 4/5 as a percent').type, 'ask')
})
