const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { resolveMediaTarget, AUDIO_MIME } = require('../lib/media.js')

const enc = (p) => '/media/' + encodeURIComponent(p)

test('resolveMediaTarget: accepts an absolute audio path', () => {
  const abs = process.platform === 'win32' ? 'C:\\Music\\track.mp3' : '/home/me/track.mp3'
  const r = resolveMediaTarget(enc(abs))
  assert.equal(r.ok, true)
  assert.equal(r.abs, abs)
  assert.equal(r.mime, 'audio/mpeg')
})

test('resolveMediaTarget: every advertised extension maps to a mime type', () => {
  for (const [ext, mime] of Object.entries(AUDIO_MIME)) {
    const abs = (process.platform === 'win32' ? 'C:\\a\\b' : '/a/b') + ext
    const r = resolveMediaTarget(enc(abs))
    assert.equal(r.ok, true, ext)
    assert.equal(r.mime, mime, ext)
  }
})

test('resolveMediaTarget: extension matching is case-insensitive', () => {
  const abs = process.platform === 'win32' ? 'C:\\a\\LOUD.WAV' : '/a/LOUD.WAV'
  assert.equal(resolveMediaTarget(enc(abs)).mime, 'audio/wav')
})

test('resolveMediaTarget: rejects paths outside /media/', () => {
  assert.equal(resolveMediaTarget('/index.html').ok, false)
  assert.equal(resolveMediaTarget('/media').ok, false)
  assert.equal(resolveMediaTarget('').ok, false)
  assert.equal(resolveMediaTarget(null).ok, false)
})

test('resolveMediaTarget: rejects relative paths (no directory traversal)', () => {
  const r = resolveMediaTarget(enc('../../etc/passwd.mp3'))
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('resolveMediaTarget: rejects unsupported extensions', () => {
  const abs = process.platform === 'win32' ? 'C:\\a\\evil.exe' : '/a/evil.exe'
  const r = resolveMediaTarget(enc(abs))
  assert.equal(r.ok, false)
  assert.equal(r.status, 415)
})

test('resolveMediaTarget: rejects a NUL byte in the path', () => {
  const abs = (process.platform === 'win32' ? 'C:\\a\\b' : '/a/b') + '.mp3'
  const r = resolveMediaTarget('/media/' + encodeURIComponent(abs) + '%00.png')
  assert.equal(r.ok, false)
})

test('resolveMediaTarget: survives malformed percent-encoding', () => {
  const r = resolveMediaTarget('/media/%E0%A4%A.mp3')
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('resolveMediaTarget: decoded path equals the original for spaces and unicode', () => {
  const abs = process.platform === 'win32' ? 'C:\\My Music\\Björk — Jóga.flac' : '/My Music/Björk — Jóga.flac'
  const r = resolveMediaTarget(enc(abs))
  assert.equal(r.ok, true)
  assert.equal(r.abs, abs)
  assert.equal(path.extname(r.abs).toLowerCase(), '.flac')
})
