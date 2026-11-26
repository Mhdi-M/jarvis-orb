'use strict'
/**
 * Health + performance.
 *
 * One store for every model and agent outcome, and one number derived from it.
 * The sidebar's PERFORMANCE meter reads `score()`; the failover chain reads
 * `models`; the alert layer reads `classifyFailure()`. Nothing here calls a
 * model — recording is free, so it can happen on every single turn.
 */
const fs = require('fs')
const path = require('path')

const FILE = () => process.env.JARVIS_HEALTH_FILE || path.join(__dirname, '..', 'data', 'health.json')
const MAX_EVENTS = 300

let cache = null
let cacheFile = null

function blank() {
  return { updated: 0, models: {}, agents: {}, events: [] }
}

function load() {
  const file = FILE()
  if (cache && cacheFile === file) return cache
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const s = raw && typeof raw === 'object' ? raw : blank()
  s.models = s.models && typeof s.models === 'object' ? s.models : {}
  s.agents = s.agents && typeof s.agents === 'object' ? s.agents : {}
  s.events = Array.isArray(s.events) ? s.events : []
  cache = s
  cacheFile = file
  return s
}

function save() {
  const s = load()
  s.updated = Date.now()
  const file = FILE()
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
    fs.renameSync(tmp, file)
  } catch {}
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
const keyOf = (provider, model) => String(provider || 'auto') + '/' + String(model || 'default')

/* ------------------------------------------------------------ classification */
const RULES = [
  { kind: 'rate_limit', limited: true, retryable: true, hit: [/rate.?limit/i, /quota/i, /\b429\b/, /too many requests/i, /insufficient (?:quota|balance|credits)/i, /out of credits/i, /exceeded your current quota/i], plain: 'the provider is rate-limiting or out of quota' },
  { kind: 'context', limited: true, retryable: true, hit: [/context length/i, /maximum context/i, /prompt is too long/i, /too many tokens/i, /context window/i], plain: 'the conversation outgrew the model context window' },
  { kind: 'auth', limited: false, retryable: false, hit: [/invalid api key/i, /unauthori[sz]ed/i, /\b401\b/, /forbidden/i, /\b403\b/, /no api key/i, /authentication/i], plain: 'the API key was rejected' },
  { kind: 'model', limited: false, retryable: true, hit: [/no such model/i, /model not found/i, /unknown model/i, /model.*does not exist/i, /unsupported model/i], plain: 'that model name does not exist on the provider' },
  { kind: 'network', limited: false, retryable: true, hit: [/econnrefused/i, /econnreset/i, /enotfound/i, /etimedout/i, /timed out/i, /network/i, /unreachable/i, /socket hang up/i, /could not start hermes/i], plain: 'the network could not reach the provider' },
  { kind: 'overloaded', limited: true, retryable: true, hit: [/overloaded/i, /service unavailable/i, /bad gateway/i, /\b50[234]\b/i, /internal server error/i], plain: 'the provider is overloaded' },
]

/** Pure: what went wrong, whether it is quota-shaped, and how to say it plainly. */
function classifyFailure(text) {
  const t = String(text || '')
  if (!t.trim()) return { kind: 'empty', limited: false, retryable: true, plain: 'the model returned nothing' }
  for (const r of RULES) if (r.hit.some((re) => re.test(t))) return { kind: r.kind, limited: r.limited, retryable: r.retryable, plain: r.plain }
  return { kind: 'unknown', limited: false, retryable: true, plain: 'the model failed' }
}

/* -------------------------------------------------------------- score maths */
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n >= 0).sort((x, y) => x - y)
  if (!a.length) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function labelFor(score) {
  if (!Number.isFinite(score)) return 'unknown'
  if (score >= 85) return 'healthy'
  if (score >= 65) return 'steady'
  if (score >= 40) return 'strained'
  return 'degraded'
}

/**
 * Pure: 0-100 from four measured parts.
 *   availability - share of models whose last outcome was a success (24h)
 *   reliability  - successful attempts / all attempts on record
 *   speed        - median recent latency: 3 s scores 1, 120 s scores 0
 *   headroom     - how much context budget is left before the next recycle
 */
function computePerformance(input = {}) {
  const models = input.models && typeof input.models === 'object' ? input.models : {}
  const agents = input.agents && typeof input.agents === 'object' ? input.agents : {}
  const now = Number(input.now) || Date.now()
  const day = 24 * 3600 * 1000
  const rows = Object.values(models).concat(Object.values(agents))
  let available = 0.5
  if (rows.length) {
    const live = rows.filter((m) => m && m.lastOk && now - m.lastOk < day)
    available = live.length / rows.length
  }

  let ok = 0
  let fail = 0
  for (const r of rows) { ok += Number(r.ok) || 0; fail += Number(r.fail) || 0 }
  const reliability = ok + fail ? ok / (ok + fail) : 0.5
  const attempts = ok + fail

  const recent = Array.isArray(input.recentSecs) ? input.recentSecs : []
  const med = median(recent.slice(-20))
  const speed = med == null ? 0.5 : clamp01(1 - (med - 3) / 117)

  const limit = Number(input.contextLimit) || 0
  const used = Number(input.contextTokens) || 0
  const headroom = limit > 0 ? clamp01(1 - used / limit) : 1

  const parts = { availability: clamp01(available), reliability: clamp01(reliability), speed: clamp01(speed), headroom }
  /* A benchmark is the only part that measures answer quality; without one the
   * term is neutral (0.5) and labelled null, never silently perfect. */
  const bench = Number.isFinite(input.benchmark) ? clamp01(input.benchmark) : null
  parts.benchmark = bench

  /* No measurements yet is not "58%": it is unknown, and saying so is the only
   * honest number before the first turn. */
  if (!attempts) return { score: 0, label: 'no data', parts, medianSecs: med, attempts: 0 }

  const b = bench == null ? 0.5 : bench
  const score = Math.round(100 * (0.30 * parts.availability + 0.25 * parts.reliability + 0.20 * parts.speed + 0.10 * parts.headroom + 0.15 * b))
  return {
    score: Math.max(0, Math.min(100, score)),
    label: labelFor(score),
    parts,
    medianSecs: med,
    attempts,
  }
}

/* --------------------------------------------------------------- recording */
function recordModel({ provider, model, ok, secs, status, error }) {
  const s = load()
  const k = keyOf(provider, model)
  const m = s.models[k] || { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastSecs: null, lastStatus: null, streak: 0 }
  if (ok) {
    m.ok += 1
    m.lastOk = Date.now()
    m.streak = m.streak >= 0 ? m.streak + 1 : 1
    if (Number.isFinite(secs)) m.lastSecs = secs
  } else {
    m.fail += 1
    m.lastFail = Date.now()
    m.streak = m.streak <= 0 ? m.streak - 1 : -1
  }
  m.lastStatus = status || (ok ? 'ok' : 'failed')
  if (error) m.lastError = String(error).slice(0, 300)
  m.provider = provider || m.provider || null
  m.model = model || m.model || null
  s.models[k] = m
  pushEvent(s, { kind: 'model', key: k, provider, model, ok: !!ok, status: m.lastStatus, secs: Number.isFinite(secs) ? secs : null, error: error ? String(error).slice(0, 200) : undefined })
  save()
  return m
}

function recordAgent({ agent, ok, secs, status, error, model, provider }) {
  const s = load()
  const a = s.agents[agent] || { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastSecs: null, lastStatus: null }
  if (ok) { a.ok += 1; a.lastOk = Date.now(); if (Number.isFinite(secs)) a.lastSecs = secs } else { a.fail += 1; a.lastFail = Date.now() }
  a.lastStatus = status || (ok ? 'ok' : 'failed')
  if (error) a.lastError = String(error).slice(0, 200)
  s.agents[agent] = a
  pushEvent(s, { kind: 'agent', agent, ok: !!ok, status: a.lastStatus, secs: Number.isFinite(secs) ? secs : null, model, provider })
  save()
  return a
}

function note(kind, detail) {
  const s = load()
  pushEvent(s, { kind, ...detail })
  save()
}

function pushEvent(s, evt) {
  s.events.push({ at: Date.now(), ...evt })
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS)
}

/** Recent latencies for the score's speed term (successful turns only). */
function recentSecs(n = 20) {
  const s = load()
  return s.events.filter((e) => e.ok && Number.isFinite(e.secs)).slice(-n).map((e) => e.secs)
}

function performance(extra = {}) {
  const s = load()
  let benchmark
  try { benchmark = require('./bench').latestScore() } catch {}
  return computePerformance({ models: s.models, agents: s.agents, recentSecs: recentSecs(), benchmark, ...extra })
}

function lastFailure() {
  const s = load()
  for (let i = s.events.length - 1; i >= 0; i--) if (!s.events[i].ok) return s.events[i]
  return null
}

function recentFailures(n = 5) {
  return load().events.filter((e) => !e.ok && (e.kind === 'model' || e.kind === 'agent')).slice(-n)
}

function reset() { cache = blank(); save() }

module.exports = {
  classifyFailure, computePerformance, labelFor, median,
  recordModel, recordAgent, note, performance, recentSecs,
  lastFailure, recentFailures, load, save, reset,
  FILE, keyOf,
}
