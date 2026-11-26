'use strict'
/**
 * /reflect — the loop that makes the team better with use.
 *
 * It reads what actually happened (team runs, per-agent outcomes, model
 * failures, how long things took) and distills it into a small preferences
 * file. That file is injected into every planning prompt, so the next run
 * starts from evidence instead of a blank slate.
 *
 * Deterministic on purpose: no model call, no invented insight. Every line
 * points at a count that can be checked in data/.
 */
const fs = require('fs')
const path = require('path')
const health = require('./health')

const DIR = path.join(__dirname, '..', 'data')
const FILE = path.join(DIR, 'preferences.json')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function runs(n = 200) {
  try {
    return fs.readFileSync(path.join(DIR, 'team-runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** Pure: lessons + runs + health -> preferences. */
function distil(input = {}) {
  const lessons = input.lessons || { agents: {} }
  const list = input.runs || []
  const h = input.health || { models: {} }
  const out = { updated: new Date().toISOString(), runs: list.length, agents: [], models: [], rules: [] }

  for (const [name, s] of Object.entries(lessons.agents || {})) {
    const ok = Number(s.ok) || 0
    const fail = Number(s.fail) || 0
    const n = ok + fail
    if (!n) continue
    const rate = ok / n
    const secs = Number.isFinite(s.secs) ? s.secs : null
    let verdict = 'ok'
    if (n >= 3 && rate >= 0.8) verdict = 'prefer'
    else if (n >= 2 && rate <= 0.4) verdict = 'avoid'
    else if (secs != null && secs > 60) verdict = 'slow'
    out.agents.push({ name, rate: Math.round(rate * 100), n, secs, verdict })
  }
  out.agents.sort((a, b) => b.rate - a.rate || (a.secs || 999) - (b.secs || 999))

  for (const [key, m] of Object.entries(h.models || {})) {
    const ok = Number(m.ok) || 0
    const fail = Number(m.fail) || 0
    if (!ok + fail) continue
    const rate = ok / (ok + fail)
    const secs = Number.isFinite(m.lastSecs) ? m.lastSecs : null
    let verdict = 'ok'
    if (fail >= 2 && rate < 0.5) verdict = 'avoid'
    else if (secs != null && secs > 60) verdict = 'slow'
    else if (rate >= 0.9 && secs != null && secs < 15) verdict = 'prefer'
    out.models.push({ key, rate: Math.round(rate * 100), n: ok + fail, secs, last: m.lastStatus || null, verdict })
  }
  out.models.sort((a, b) => b.rate - a.rate)

  const prefer = out.agents.filter((a) => a.verdict === 'prefer').map((a) => a.name)
  const avoid = out.agents.filter((a) => a.verdict === 'avoid').map((a) => a.name)
  const slow = out.agents.filter((a) => a.verdict === 'slow').map((a) => a.name)
  if (prefer.length) out.rules.push('Route to ' + prefer.join(', ') + ' first: measured success rate >= 80%.')
  if (avoid.length) out.rules.push('Do not plan work for ' + avoid.join(', ') + ': measured success rate <= 40%.')
  if (slow.length) out.rules.push(slow.join(', ') + ' is slow (>60 s): use it only when quality matters more than time.')
  const bad = out.models.filter((m) => m.verdict === 'avoid').map((m) => m.key)
  if (bad.length) out.rules.push('Keep ' + bad.join(', ') + ' at the end of the model chain: repeated failures.')
  const goodModel = out.models.find((m) => m.verdict === 'prefer')
  if (goodModel) out.rules.push(goodModel.key + ' is the fastest reliable model measured so far — keep it near the front.')
  if (!out.rules.length) out.rules.push('Not enough history yet: finish a few /team or /cascade runs.')

  const open = list.filter((r) => r && r.answer == null).length
  if (open) out.rules.push(open + ' team run(s) ended without an answer — check the attempts before trusting that route.')
  return out
}

/** Build from disk, save, return. */
function run() {
  const team = require('./team') // lazy: team requires this module
  const p = distil({ lessons: team.lessons(), runs: runs(), health: health.load() })
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(p, null, 2) + '\n')
  } catch {}
  return p
}

function current() { return readJson(FILE, null) }

/** Prompt block for planners. Empty until there is something real to say. */
function promptBlock() {
  const p = current()
  if (!p || !Array.isArray(p.rules) || !p.rules.length) return ''
  return 'What past runs taught this team (measured, not assumed):\n- ' + p.rules.slice(0, 8).join('\n- ')
}

function reset() {
  try { fs.unlinkSync(FILE) } catch {}
  return true
}

module.exports = { distil, run, current, promptBlock, reset, FILE, runs }
