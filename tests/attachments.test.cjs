'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const att = require('../lib/attachments')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-attach-'))

test('kindOf classifies by extension and detects folders', () => {
  fs.writeFileSync(path.join(tmp, 'shot.png'), 'x')
  fs.writeFileSync(path.join(tmp, 'voice.wav'), 'x')
  fs.writeFileSync(path.join(tmp, 'clip.mp4'), 'x')
  fs.writeFileSync(path.join(tmp, 'notes.md'), 'hello')
  assert.equal(att.kindOf(path.join(tmp, 'shot.png')), 'image')
  assert.equal(att.kindOf(path.join(tmp, 'voice.wav')), 'audio')
  assert.equal(att.kindOf(path.join(tmp, 'clip.mp4')), 'video')
  assert.equal(att.kindOf(path.join(tmp, 'notes.md')), 'file')
  assert.equal(att.kindOf(tmp), 'folder')
  assert.equal(att.kindOf(path.join(tmp, 'missing.png')), null)
})

test('fromText accepts only lines that are existing paths', () => {
  const good = att.fromText(path.join(tmp, 'notes.md') + '\n' + path.join(tmp, 'shot.png'))
  assert.equal(good.length, 2)
  assert.equal(good[0].kind, 'file')
  assert.equal(good[1].kind, 'image')
  assert.deepEqual(att.fromText('this is just a sentence'), [])
  assert.deepEqual(att.fromText(path.join(tmp, 'notes.md') + '\nnot a path'), [])
})

test('fromText handles quotes and file:// urls', () => {
  const quoted = att.fromText('"' + path.join(tmp, 'notes.md') + '"')
  assert.equal(quoted.length, 1)
  const url = 'file:///' + path.join(tmp, 'notes.md').replace(/\\/g, '/')
  const asUrl = att.fromText(url)
  assert.equal(asUrl.length, 1)
  assert.equal(asUrl[0].path, path.join(tmp, 'notes.md'))
})

test('buildBlocks inlines text files and lists folders', async () => {
  const out = await att.buildBlocks([
    { kind: 'file', path: path.join(tmp, 'notes.md') },
    { kind: 'folder', path: tmp },
  ], {})
  assert.match(out, /FILE .*notes\.md\nhello/)
  assert.match(out, /FOLDER /)
  assert.match(out, /notes\.md/)
})

test('buildBlocks uses injected vision and transcription', async () => {
  const media = {
    describeImage: async () => ({ ok: true, text: 'a red square' }),
    transcribe: async () => ({ ok: true, text: 'spoken words' }),
  }
  const out = await att.buildBlocks([
    { kind: 'image', path: 'C:/x/shot.png' },
    { kind: 'audio', path: 'C:/x/voice.wav' },
  ], media)
  assert.match(out, /IMAGE C:\/x\/shot\.png\na red square/)
  assert.match(out, /AUDIO TRANSCRIPT C:\/x\/voice\.wav\nspoken words/)
})

test('buildBlocks reports failures without throwing', async () => {
  const media = { describeImage: async () => ({ ok: false, error: 'rate limit' }) }
  const out = await att.buildBlocks([{ kind: 'image', path: 'C:/x/shot.png' }], media)
  assert.match(out, /unreadable: rate limit/)
})

test('buildBlocks caches a finished read on the attachment', async () => {
  let calls = 0
  const media = { describeImage: async () => { calls++; return { ok: true, text: 'first read' } } }
  const item = { kind: 'image', path: 'C:/x/a.png' }
  await att.buildBlocks([item], media)
  const again = await att.buildBlocks([item], media)
  assert.equal(calls, 1)
  assert.match(again, /first read/)
})

test('buildBlocks gives up on a hung model instead of freezing', async () => {
  const media = { describeImage: () => new Promise(() => {}) }   // never resolves
  const t0 = Date.now()
  const out = await att.buildBlocks([{ kind: 'image', path: 'C:/x/slow.png' }], media, { timeoutMs: 60 })
  assert.match(out, /timed out/)
  assert.ok(Date.now() - t0 < 3000, 'returned quickly')
})

test('summary counts kinds', () => {
  assert.equal(att.summary([]), '')
  assert.equal(att.summary([{ kind: 'image' }, { kind: 'image' }, { kind: 'folder' }]), '2 image · 1 folder')
})
