#!/usr/bin/env node
'use strict'
/**
 * Jarvis self-test — run it with:  node tools/selftest.js
 *
 * Exercises every capability the assistant claims, prints a pass/fail table and
 * a JSON block. Safe to run repeatedly; it does not touch your real notes or
 * reminders (skills run against a temp directory).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'cli', 'jarvis.js')

const results = []
const record = (area, name, ok, detail = '') => {
  results.push({ area, name, ok: !!ok, detail: String(detail).slice(0, 160) })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${area.padEnd(11)} ${name}${detail ? '  — ' + detail : ''}`)
}

function run(args, timeout = 120000) {
  const t0 = Date.now()
  let out = ''
  let ok = true
  try {
    out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, env: process.env })
  } catch (e) {
    ok = false
    out = String((e.stdout || '') + (e.stderr || '') + (e.message || ''))
  }
  return { ok, out: out.replace(/\x1b\[[0-9;]*m/g, ''), ms: Date.now() - t0 }
}

async function main() {
  console.log('Jarvis self-test — ' + new Date().toISOString())
  console.log('node ' + process.version + ' · ' + os.type() + ' ' + os.release() + ' · ' + os.cpus().length + ' cores')
  console.log('')

  /* ---------------------------------------------------------------- boot */
  const frame = run(['--frame'], 20000)
  record('ui', 'terminal frame renders', frame.ok && /JARVIS/.test(frame.out) && /HARDWARE/.test(frame.out), 'layout + sidebar')
  record('ui', 'sidebar shows tokens/model/hardware', /TOKENS/.test(frame.out) && /MODEL/.test(frame.out) && /CPU/.test(frame.out))

  /* ------------------------------------------------------------ local path */
  const echo = run(['run echo selftest-ok'], 30000)
  record('local', 'run a shell command', /selftest-ok/.test(echo.out), echo.ms + ' ms')

  const { parseIntent } = await import(require('url').pathToFileURL(path.join(ROOT, 'lib', 'intent.mjs')).href)
  const cases = [
    ['open notepad', 'app'], ['open github.com', 'url'], ['run ipconfig', 'run'],
    ['read example.com', 'read'], ['what is open source', null],
    ['explain how to open a port', null],
  ]
  const intentOk = cases.every(([q, want]) => ((parseIntent(q) || {}).kind || null) === want)
  record('local', 'intent router (6 phrasings)', intentOk, 'no false positives on questions')

  /* --------------------------------------------------------------- the PC */
  const list = run(['/ls ' + ROOT], 20000)
  record('pc', 'read a directory', /cli|lib|tests/.test(list.out))
  const cat = run(['/cat package.json'], 20000)
  record('pc', 'read a file', /jarvis-cli/.test(cat.out))

  /* --------------------------------------------------------------- Chrome */
  const tabs = run(['/tabs'], 40000)
  const tabCount = (tabs.out.match(/^\s*\d+\./gm) || []).length
  record('chrome', 'launch CDP chrome + list tabs', tabs.ok && tabCount > 0, tabCount + ' tab(s)')

  /* ------------------------------------------------------------ messages */
  const messages = require(path.join(ROOT, 'lib', 'messages'))
  const feed = messages.readNotifications({ limit: 200 })
  record('messages', 'read notification history', feed.ok && feed.items.length > 0, feed.ok ? feed.items.length + ' items' : feed.error)
  if (feed.ok && feed.items.length) {
    const apps = [...new Set(feed.items.map((i) => i.app))].slice(0, 6).join(', ')
    record('messages', 'decode sending apps', apps.length > 0, apps)
    const term = (feed.items[0].title || '').split(' ')[0] || 'a'
    const hits = messages.search(feed.items, term)
    record('messages', 'search history', hits.length > 0, `"${term}" → ${hits.length} hits`)
    record('messages', 'compact prompt block', messages.asText(feed.items).length > 0)
  }

  /* -------------------------------------------------------------- skills */
  const tmpSkills = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-selftest-'))
  process.env.JARVIS_SKILLS_DIR = tmpSkills
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'skills'))]
  const skills = require(path.join(ROOT, 'lib', 'skills'))
  skills.save({ name: 'Selftest style', when: 'selftest answer style', body: 'Answer with exactly the word SELFTEST.' })
  record('skills', 'save + list', skills.list().length === 1)
  record('skills', 'match by wording', skills.match('what is the selftest answer style').length === 1)
  record('skills', 'prompt injection block', /Skills I wrote earlier/.test(skills.toContext('selftest answer style')))
  skills.remove('selftest style')
  record('skills', 'remove', skills.list().length === 0)

  /* -------------------------------------------------------------- memory */
  const memory = require(path.join(ROOT, 'lib', 'memory'))
  const facts = memory.list()
  record('memory', 'facts stored', Array.isArray(facts), facts.length + ' facts')
  record('memory', 'recall by wording', Array.isArray(memory.recall(facts[0] || 'editor')), 'query path works')

  /* --------------------------------------------------------------- speed */
  const q = [
    ['what is 21*2? just the number', '42'],
    ['name two colours, comma separated', null],
  ]
  const timings = []
  for (const [question, expect] of q) {
    const r = run([question], 120000)
    const hit = expect ? new RegExp('\\b' + expect + '\\b').test(r.out) : r.out.split('\n').filter(Boolean).length > 2
    timings.push(r.ms)
    record('speed', `"${question.slice(0, 32)}"`, r.ok && hit, r.ms + ' ms')
  }

  /* -------------------------------------------------------------- summary */
  const pass = results.filter((r) => r.ok).length
  console.log('')
  console.log(`${pass}/${results.length} checks passed`)
  console.log('answer times: ' + timings.map((t) => (t / 1000).toFixed(1) + 's').join(', '))

  const out = path.join(ROOT, 'data', 'selftest.json')
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, timings, results }, null, 2))
    console.log('written to ' + out)
  } catch {}

  fs.rmSync(tmpSkills, { recursive: true, force: true })
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error('selftest crashed:', e); process.exit(2) })
