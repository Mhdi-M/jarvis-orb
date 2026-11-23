'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-privacy-'))
process.env.JARVIS_MEMORY_FILE = path.join(dir, 'memory.json')
process.env.JARVIS_PROFILE_FILE = path.join(dir, 'profile.json')
process.env.JARVIS_ACTIVITY_FILE = path.join(dir, 'activity.json')

const memory = require('../lib/memory.js')
const profile = require('../lib/profile.js')
const activity = require('../lib/activity.js')

function reset() {
  memory._reset()
  profile._reset()
  activity._reset()
  for (const file of [process.env.JARVIS_MEMORY_FILE, process.env.JARVIS_PROFILE_FILE, process.env.JARVIS_ACTIVITY_FILE]) {
    try { fs.unlinkSync(file) } catch {}
  }
}

test('memory disabled fails closed for recall and context', () => {
  reset()
  assert.equal(memory.add('favorite editor is vim'), true)
  memory.setEnabled(false)
  assert.deepEqual(memory.recall('what editor'), [])
  assert.equal(memory.context('what editor'), '')
})

test('memory forget clears facts and profile history', () => {
  reset()
  memory.add('favorite editor is vim')
  profile.record('open vim')
  assert.equal(memory.forget(), 1)
  profile.clear()
  assert.deepEqual(memory.list(), [])
  assert.equal(profile.recentContext(), '')
})

test('profile correction and answer paths redact obvious secrets', () => {
  reset()
  profile.recordFeedback('correction: my api_key = abc123')
  profile.recordFeedback('Bearer abcdefghijklmnop1234567890')
  assert.equal(fs.existsSync(process.env.JARVIS_PROFILE_FILE), false)
  profile.recordFeedback('I prefer concise answers')
  const saved = JSON.parse(fs.readFileSync(process.env.JARVIS_PROFILE_FILE, 'utf8'))
  assert.equal(saved.feedback.length, 1)
  assert.ok(!JSON.stringify(saved).includes('abc123'))
})

test('activity does not collect before explicit opt-in', () => {
  reset()
  let calls = 0
  activity.start({ getCursor: () => { calls++; return { x: 1, y: 1 } }, getProcess: async () => 'Code.exe' })
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(calls, 0)
    assert.equal(activity.status().enabled, false)
    activity.stop()
    resolve()
  }, 30))
})

test('activity aggregates movement and process samples only after opt-in', async () => {
  reset()
  let cursor = { x: 1, y: 1 }
  activity.setEnabled(true)
  activity.start({ getCursor: () => cursor, getProcess: async () => 'Code.exe', intervals: { cursor: 10, process: 20 } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  cursor = { x: 2, y: 1 }
  await new Promise((resolve) => setTimeout(resolve, 30))
  activity.stop()
  const status = activity.status()
  assert.equal(status.enabled, true)
  assert.ok(status.movementEvents >= 1)
  assert.ok(status.samples >= 1)
  assert.ok(status.processes.includes('Code.exe'))
  assert.equal(status.coordinates, undefined)
})

test('activity clear removes saved observations and stop halts polling', async () => {
  reset()
  let calls = 0
  activity.setEnabled(true)
  activity.start({ getCursor: () => { calls++; return { x: calls, y: 1 } }, intervals: { cursor: 5, process: 1000 } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  activity.stop()
  const before = calls
  activity.clear()
  assert.equal(activity.status().movementEvents, 0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, before)
  const saved = JSON.parse(fs.readFileSync(process.env.JARVIS_ACTIVITY_FILE, 'utf8'))
  assert.deepEqual(saved.days, {})
})

test('activity retains only 7 days and stores no coordinates', () => {
  reset()
  const old = new Date(Date.now() - 9 * 864e5).toISOString().slice(0, 10)
  fs.writeFileSync(process.env.JARVIS_ACTIVITY_FILE, JSON.stringify({ enabled: true, days: { [old]: { move: 5, cursor: 5, proc: { 'A.exe': 1 } } } }))
  assert.equal(activity.status().movementEvents, 0)
  activity.setEnabled(true)
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(process.env.JARVIS_ACTIVITY_FILE, 'utf8'))).includes(old))
})

test('activity records unknown on process failure and ignores unsafe names', async () => {
  reset()
  let n = 0
  activity.setEnabled(true)
  activity.start({ getCursor: () => ({ x: 0, y: 0 }), getProcess: async () => { if (n++ === 0) throw new Error('x'); return 'C:\secret\a.exe' }, intervals: { cursor: 1000, process: 10 } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  activity.stop()
  const st = activity.status()
  assert.ok(st.unknown >= 1)
  assert.ok(!JSON.stringify(st).includes('secret'))
})

test('profile.clear removes history, style and feedback on disk', () => {
  reset()
  profile.record('open chrome'); profile.recordFeedback('be brief')
  profile.clear()
  const saved = JSON.parse(fs.readFileSync(process.env.JARVIS_PROFILE_FILE, 'utf8'))
  assert.deepEqual([saved.history.length, saved.feedback.length, saved.style.n], [0, 0, 0])
})
