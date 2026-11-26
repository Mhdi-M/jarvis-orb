const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.JARVIS_GATEWAY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jgw-')), 'gateway.json')
const gateway = require('../lib/gateway')

test('gateway: token is stored as a hash, never plaintext', () => {
  const st = gateway.state()
  assert.equal(st.token, undefined)
  assert.equal(typeof st.tokenHash, 'string')
  assert.equal(st.tokenHash.length, 64)
})

test('gateway: pairing code is six characters, single use, approve required', () => {
  const p = gateway.requestPair('phone')
  assert.equal(p.ok, true)
  assert.equal(p.code.length, 6)
  assert.deepEqual(gateway.pairStatus(p.code).status, 'pending')
  assert.equal(gateway.approve('ZZZZZZ').ok, false)
  assert.equal(gateway.approve(p.code).ok, true)
  const got = gateway.pairStatus(p.code)
  assert.equal(got.status, 'approved')
  assert.equal(typeof got.token, 'string')
  assert.equal(gateway.pairStatus(p.code).status, 'used')
})

test('gateway: an approved client token authenticates; a random one does not', () => {
  const p = gateway.requestPair('tablet')
  gateway.approve(p.code)
  const { token } = gateway.pairStatus(p.code)
  const st = gateway.state()
  assert.equal(gateway.authorized(st, { headers: { 'x-jarvis-token': token } }), true)
  assert.equal(gateway.authorized(st, { headers: { 'x-jarvis-token': 'nope' } }), false)
  assert.equal(gateway.authorized(st, { headers: {} }), false)
})

test('gateway: passphrase is hashed with scrypt and verifies', () => {
  assert.equal(gateway.setPassword('short').ok, false)
  assert.equal(gateway.setPassword('correct horse battery').ok, true)
  const st = gateway.state()
  assert.match(st.password, /^scrypt\$/)
  assert.equal(gateway.authorized(st, { headers: { authorization: 'Bearer correct horse battery' } }), true)
  assert.equal(gateway.authorized(st, { headers: { authorization: 'Bearer wrong pass phrase' } }), false)
})
