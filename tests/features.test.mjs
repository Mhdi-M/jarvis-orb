import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.JARVIS_PROFILE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-')), 'p.json')
process.env.JARVIS_MEMORY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-')), 'm.json')
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const memory = require('../lib/memory.js')
const monitor = require('../lib/monitor.js')
const netmode = require('../lib/netmode.js')
const offline = require('../offline.js')

test('memory: learns "remember ..." and recalls it by keyword', () => {
  memory._reset()
  assert.deepEqual(memory.learnFrom('remember that my laptop is a ThinkPad with 16GB RAM'), ['my laptop is a ThinkPad with 16GB RAM'])
  assert.match(memory.context('what RAM does my laptop have'), /16GB/)
})
test('memory: refuses to store secrets', () => {
  memory._reset()
  assert.deepEqual(memory.learnFrom('remember my password: hunter2'), [])
})
test('memory: disabled means nothing is stored; forget removes', () => {
  memory._reset(); memory.setEnabled(false)
  assert.equal(memory.add('x fact here'), false)
  memory.setEnabled(true); memory.add('likes tea please'); assert.equal(memory.forget('tea'), 1)
})
test('monitor: alerts only past limits', () => {
  assert.deepEqual(monitor.evaluate({ cpu: 20, ram: 50, gpuTemp: 55, diskFreeGb: 800 }), [])
  const a = monitor.evaluate({ cpu: 97, ram: 50, gpuTemp: 90, diskFreeGb: 5 })
  assert.equal(a.length, 3)
})
test('netmode: direct strips proxy vars, proxy sets socks on 2080 only', () => {
  const base = { HTTPS_PROXY: 'x', PATH: 'p' }
  assert.equal(netmode.envFor('direct', base).HTTPS_PROXY, undefined)
  assert.equal(netmode.envFor('proxy', base).HTTPS_PROXY, 'socks5://127.0.0.1:2080')
  assert.equal(netmode.envFor('direct', base).PATH, 'p')
})
test('offline: classify still recognises health/open/close', () => {
  assert.equal(offline.classify('how is my cpu').type, 'health')
  assert.equal(offline.classify('open notepad').type, 'open')
  assert.equal(offline.classify('close chrome').type, 'close')
  assert.equal(offline.classify('tell me a story'), null)
})

const profile = require('../lib/profile.js')
test('profile: learns short casual style, persists to disk, skips secrets', () => {
  profile._reset()
  for (const m of ['open chrome','whats my cpu','check temp','hi there','remember tea','my password: abc123']) profile.record(m)
  assert.match(profile.styleHint(), /brief/)
  assert.ok(!profile.recentContext(10).includes('abc123'))
  const saved = JSON.parse(fs.readFileSync(process.env.JARVIS_PROFILE_FILE, 'utf8'))
  assert.equal(saved.history.length, 5)
  profile._reset()
  assert.equal(JSON.parse(JSON.stringify(profile.recentContext(10))).includes('whats my cpu'), true)
})

const guard = require('../lib/guard.js')
test('guard: actions need approval, questions do not', () => {
  for (const q of ['type hello into notepad for me', 'click the save button', 'send a reply to him', 'delete the old logs', 'install node', 'restart my pc', 'close chrome', 'remind me at 5'])
    assert.equal(guard.review(q).needsApproval, true, q)
  for (const q of ['what is my cpu temperature', 'explain this picture', 'summarize this page', 'how do I delete a file', 'show my calendar'])
    assert.equal(guard.review(q).needsApproval, false, q)
})
