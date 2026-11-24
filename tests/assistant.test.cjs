'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const messages = require('../lib/messages')
const chrome = require('../lib/chrome')

test('toast payload → title + body', () => {
  const xml = '<toast><visual><binding template="ToastGeneric"><text>Alice</text><text>see you at 9</text></binding></visual></toast>'
  const r = messages.parseToast(xml)
  assert.equal(r.title, 'Alice')
  assert.equal(r.body, 'see you at 9')
})

test('toast payload decodes entities and CDATA', () => {
  const xml = '<toast><text><![CDATA[Group & co]]></text><text>a &amp; b &lt;ok&gt;</text></toast>'
  const r = messages.parseToast(xml)
  assert.equal(r.title, 'Group & co')
  assert.equal(r.body, 'a & b <ok>')
})

test('toast with no text nodes is empty', () => {
  assert.deepEqual(messages.parseToast('<toast><visual/></toast>'), { title: '', body: '' })
})

test('app names are readable', () => {
  assert.equal(messages.appName('Microsoft.WindowsStore_8wekyb3d8bbwe!App'), 'Store')
  assert.equal(messages.appName('com.squirrel.Telegram.Telegram'), 'Telegram')
  assert.equal(messages.appName('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'), 'WhatsApp')
  assert.equal(messages.appName(''), 'system')
})

test('search ranks exact phrase above loose words', () => {
  const items = [
    { app: 'WhatsApp', title: 'Bob', body: 'lunch tomorrow?', at: 100 },
    { app: 'Telegram', title: 'Team', body: 'the report is ready', at: 200 },
    { app: 'WhatsApp', title: 'Alice', body: 'report report report', at: 300 },
  ]
  const hits = messages.search(items, 'report')
  assert.equal(hits.length, 2)
  assert.equal(hits[0].at, 300)
  assert.equal(messages.search(items, '').length, 0)
  assert.equal(messages.search(items, 'nothing-here').length, 0)
})

test('asText is compact and dated', () => {
  const t = messages.asText([{ app: 'X', title: 'hi', body: 'there', at: Date.now() }])
  assert.match(t, /\[X\] hi: there/)
})

test('chrome tab classification', () => {
  assert.equal(chrome.classify('https://web.whatsapp.com/').kind, 'whatsapp')
  assert.equal(chrome.classify('https://web.telegram.org/k/').kind, 'telegram')
  assert.equal(chrome.classify('https://x.com/home').kind, 'x')
  assert.equal(chrome.classify('https://mail.google.com/mail/u/0').kind, 'mail')
  assert.equal(chrome.classify('https://example.com'), null)
})

test('message lines drop chrome-of-the-site noise', () => {
  const page = 'Search\nChats\nArchived\nAlice\nsee you at 9\nBob\nok\nMenu'
  const lines = chrome.messageLines(page, { max: 10 })
  assert.deepEqual(lines, ['Alice', 'see you at 9', 'Bob', 'ok'])
})

// skills need their own directory for the test
const tmpSkills = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-'))
process.env.JARVIS_SKILLS_DIR = tmpSkills
const skills = require('../lib/skills')

test('skills save → list → read', () => {
  skills.save({ name: 'Deploy Flow', when: 'deploy release build', body: '1. run tests\n2. push to main\n3. never force-push' })
  const all = skills.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'Deploy Flow')
  const one = skills.read('deploy-flow')
  assert.match(one.body, /never force-push/)
})

test('skills match by their "when" line', () => {
  const hits = skills.match('how do I deploy the service?')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'Deploy Flow')
  assert.equal(skills.match('what is the weather').length, 0)
})

test('skill context is a prompt block', () => {
  const ctx = skills.toContext('deploy the release')
  assert.match(ctx, /Skills I wrote earlier/)
  assert.match(ctx, /Deploy Flow/)
  assert.equal(skills.toContext('unrelated question'), '')
})

test('transcript becomes a skill body', () => {
  const body = skills.fromTranscript([
    { role: 'you', text: 'always use pnpm' },
    { role: 'jarvis', text: 'noted' },
  ])
  assert.match(body, /Me: always use pnpm/)
  assert.match(body, /Jarvis: noted/)
})

test('skills can be removed', () => {
  assert.equal(skills.remove('deploy-flow'), true)
  assert.equal(skills.list().length, 0)
})
