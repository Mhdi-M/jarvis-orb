'use strict'
/**
 * Benchmarks — the fifth input to the performance score.
 *
 * Health says whether a model answers and how fast; it does not say whether the
 * answer is any good. This runs a tiny fixed suite (arithmetic, instruction
 * following, JSON shape) against a model and stores the result. Three prompts,
 * a few hundred tokens, so it can be run on demand from /perf bench without
 * burning a budget.
 *
 * The score is correctness on those tasks, not a vendor benchmark.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const health = require('./health')

const FILE = () => process.env.JARVIS_BENCH_FILE || path.join(__dirname, '..', 'data', 'bench.json')
const HERMES = require('./hermes-bin').hermesBin()

const TASKS = [
  { id: 'calc', prompt: 'What is 37 * 19? Reply with the number only.', check: (t) => /(^|\D)703(\D|$)/.test(t) },
  { id: 'follow', prompt: 'Reply with exactly the word ALPHA and nothing else.', check: (t) => t.trim().replace(/[.!]$/, '').toUpperCase() === 'ALPHA' },
  { id: 'json', prompt: 'Reply with JSON only, no prose: {"ok":true}', check: (t) => { try { return JSON.parse(String(t).replace(/^```json|```$/g, '').trim()).ok === true } catch { return false } } },
]

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); if (j && typeof j === 'object') return j.models ? j : { models: j } } catch {}
  return { models: {} }
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify(state, null, 2) + '\n')
  } catch {}
  return state
}

function run(entry, prompt, timeout = 60000) {
  return new Promise((resolve) => {
    const args = ['-z', prompt]
    if (entry.model) args.push('-m', entry.model)
    if (entry.provider) args.push('--provider', entry.provider)
    const env = Object.assign({}, process.env)
    if (!entry.vpn) { delete env.HTTPS_PROXY; delete env.HTTP_PROXY; delete env.ALL_PROXY }
    const t0 = Date.now()
    execFile(HERMES, args, { env, timeout, windowsHide: true, maxBuffer: 2 << 20 }, (err, stdout) => {
      resolve({ text: String(stdout || '').trim(), secs: Math.round((Date.now() - t0) / 100) / 10, err: err ? err.message : null })
    })
  })
}

/** Benchmark one model. Returns {score 0..1, tasks:[{id,ok,secs}], secs}. */
async function runFor(entry, opts = {}) {
  const rows = []
  for (const t of TASKS) {
    const r = await run(entry, t.prompt, opts.timeout)
    rows.push({ id: t.id, ok: t.check(r.text), secs: r.secs, text: r.text.slice(0, 120) })
  }
  const score = rows.filter((r) => r.ok).length / rows.length
  const key = health.keyOf(entry.provider, entry.model)
  const state = load()
  state.models[key] = {
    provider: entry.provider || null, model: entry.model || null,
    score: Math.round(score * 100), tasks: rows.map((r) => ({ id: r.id, ok: r.ok, secs: r.secs })),
    at: new Date().toISOString(),
  }
  save(state)
  return { key, score, tasks: rows, secs: rows.reduce((s, r) => s + r.secs, 0) }
}

/** Run the suite over the ranked inventory (top N), storing each result. */
async function runAll(opts = {}) {
  const models = require('./models')
  const rows = models.status().slice(0, opts.limit || 4)
  const out = []
  for (const e of rows) {
    const r = await runFor(e, opts)
    out.push({ id: e.id, model: e.model, score: r.score, secs: Math.round(r.secs * 10) / 10 })
    if (opts.onStep) { try { opts.onStep(out[out.length - 1]) } catch {} }
  }
  return out
}

/** Average of stored scores, or null when nothing has been benchmarked. */
function latestScore() {
  const state = load()
  const rows = Object.values(state.models || {}).filter((r) => Number.isFinite(r.score))
  if (!rows.length) return null
  return rows.reduce((s, r) => s + r.score, 0) / rows.length / 100
}

function summary() {
  const state = load()
  return Object.entries(state.models || {}).map(([key, r]) => ({ key, ...r })).sort((a, b) => (b.score || 0) - (a.score || 0))
}

module.exports = { runFor, runAll, latestScore, summary, load, save, TASKS, FILE }
