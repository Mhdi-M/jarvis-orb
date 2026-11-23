import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent, resolveApp, looksLikeUrl, normalizeUrl, intentLine } from '../lib/intent.mjs'

test('resolveApp maps aliases and articles', () => {
  assert.equal(resolveApp('notepad'), 'notepad.exe')
  assert.equal(resolveApp('the calculator'), 'calc.exe')
  assert.equal(resolveApp('Task Manager'), 'taskmgr.exe')
  assert.equal(resolveApp('spotify app'), 'spotify:')
  assert.equal(resolveApp('definitely not an app'), null)
  assert.equal(resolveApp(''), null)
})

test('looksLikeUrl separates domains from sentences', () => {
  assert.equal(looksLikeUrl('github.com'), true)
  assert.equal(looksLikeUrl('https://a.b/c?d=1'), true)
  assert.equal(looksLikeUrl('open source'), false)
  assert.equal(looksLikeUrl('what is open source'), false)
  assert.equal(looksLikeUrl('notepad'), false)
})

test('normalizeUrl adds https', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com')
  assert.equal(normalizeUrl('http://x.io'), 'http://x.io')
  assert.equal(normalizeUrl(''), '')
})

test('parseIntent: bare domain', () => {
  const i = parseIntent('youtube.com')
  assert.deepEqual(i, { kind: 'url', target: 'https://youtube.com', label: 'youtube.com' })
})

test('parseIntent: open app', () => {
  const i = parseIntent('open notepad')
  assert.equal(i.kind, 'app')
  assert.equal(i.target, 'notepad.exe')
})

test('parseIntent: launch the calculator', () => {
  const i = parseIntent('launch the calculator')
  assert.equal(i.kind, 'app')
  assert.equal(i.target, 'calc.exe')
})

test('parseIntent: open url', () => {
  const i = parseIntent('open github.com')
  assert.equal(i.kind, 'url')
  assert.equal(i.target, 'https://github.com')
})

test('parseIntent: run command', () => {
  const i = parseIntent('run ipconfig /all')
  assert.equal(i.kind, 'run')
  assert.equal(i.target, 'ipconfig /all')
})

test('parseIntent: read page', () => {
  const i = parseIntent('read https://example.com/news')
  assert.equal(i.kind, 'read')
  assert.equal(i.target, 'https://example.com/news')
})

test('parseIntent: read can ask for a summary', () => {
  assert.equal(parseIntent('read https://example.com').summarize, false)
  assert.equal(parseIntent('read example.com and summarize it').summarize, true)
  assert.equal(parseIntent('summarize example.com').summarize, true)
  assert.equal(parseIntent('open example.com').summarize, undefined)
})

test('parseIntent: read rejects non-urls', () => {
  assert.equal(parseIntent('read my mind'), null)
})

test('parseIntent: questions fall through to the agent', () => {
  assert.equal(parseIntent('open source vs closed source differences'), null)
  assert.equal(parseIntent('how do I open a bank account in Germany?'), null)
  assert.equal(parseIntent('explain how to run a marathon'), null)
  assert.equal(parseIntent('write me a 400 word story about a lighthouse'), null)
})

test('parseIntent: slash commands are not intents', () => {
  assert.equal(parseIntent('/run ipconfig'), null)
  assert.equal(parseIntent('/open notepad'), null)
})

test('parseIntent: long input is ignored', () => {
  assert.equal(parseIntent('open ' + 'x'.repeat(200)), null)
})

test('intentLine renders a status line', () => {
  assert.match(intentLine({ kind: 'app', label: 'notepad' }, { ok: true }), /launched notepad/)
  assert.match(intentLine({ kind: 'run', label: 'ls' }, { ok: true, text: 'a\nb' }), /ran ls/)
  assert.match(intentLine({ kind: 'url', label: 'x.com' }, { ok: false }), /could not open/)
})
