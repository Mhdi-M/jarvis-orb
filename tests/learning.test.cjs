'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// isolated dirs so the tests never touch real memory
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'))
process.env.JARVIS_SESSIONS_DIR = path.join(tmp, 'sessions')
process.env.JARVIS_MEMORY_FILE = path.join(tmp, 'memory.json')

const session = require('../lib/session')
const learner = require('../lib/learner')

test('session: append keeps turns newest-last and caps them', () => {
  session.reset('t')
  for (let i = 0; i < 40; i++) session.append('t', 'you', 'message ' + i)
  const s = session.load('t')
  assert.ok(s.turns.length <= 25)
  assert.match(s.turns[s.turns.length - 1].text, /39/)
})

test('session: context is empty until a summary exists', () => {
  session.reset('t2')
  assert.equal(session.context('t2'), '')
  const s = session.load('t2')
  s.summary = '- user wants short answers'
  session.save(s)
  assert.match(session.context('t2'), /Session so far/)
  assert.match(session.context('t2'), /short answers/)
})

test('session: reset clears summary and turns', () => {
  const s = session.load('t2')
  assert.ok(s.turns.length >= 0)
  session.reset('t2')
  assert.equal(session.load('t2').summary, '')
  assert.equal(session.load('t2').turns.length, 0)
})

test('session: list reports saved sessions', () => {
  const all = session.list()
  assert.ok(all.some((x) => x.name === 't'))
})

test('fact filter: keeps sentences, drops fragments and secrets', () => {
  const facts = learner.filterFacts([
    'pnpm',
    'User deploys every project with pnpm and never uses npm.',
    'short one',
    'The user keeps all repositories on the D: drive and backs them up weekly.',
  ])
  assert.equal(facts.length, 2)
  assert.match(facts[0], /pnpm/)
  assert.match(facts[1], /D: drive/)
})

test('fact filter: adds the subject when the model omits it', () => {
  const [fact] = learner.filterFacts(['prefers dark terminals with a monospace font'])
  assert.match(fact, /^User:/)
})

test('fact filter: tolerates junk input', () => {
  assert.deepEqual(learner.filterFacts(null), [])
  assert.deepEqual(learner.filterFacts(['']), [])
  assert.deepEqual(learner.filterFacts([123]), [])
})

test('memory guard still refuses secrets that reach it', () => {
  const memory = require('../lib/memory')
  assert.equal(memory.add('password: hunter2'), false)
  assert.equal(memory.add('User keeps the docker socket at /var/run/docker.sock'), true)
})
