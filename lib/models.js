'use strict'
/**
 * Model inventory — every LLM this machine can actually reach, ranked.
 *
 * The list is data (data/models.json), not a guess: each entry is a provider +
 * model this account has a key for, or the local Ollama server. Each one is
 * probed with a two-token question, and the result lands in lib/health.js, so
 * "best available" means measured (answered, how fast, how recently) rather
 * than assumed from a vendor's marketing name.
 *
 * Local is a first-class entry: provider "ollama", no network, no key.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const health = require('./health')
const ollama = require('./ollama')

const FILE = () => process.env.JARVIS_MODELS_FILE || path.join(__dirname, '..', 'data', 'models.json')
const HERMES = require('./hermes-bin').hermesBin()
const PROBE_TTL = 6 * 3600 * 1000

/* Hand-set quality is a prior, not a measurement: 1.0 frontier, 0.8 fast
 * general, 0.5 small, 0.35 local 1.5B. Health and latency correct it at rank
 * time, so a slow "frontier" model does not stay on top. */
const DEFAULT = {
  version: 1,
  models: [
    { id: 'deepseek-flash', provider: 'custom:swm', model: 'deepseek/deepseek-v4-flash', quality: 0.88, enabled: true, note: 'primary, direct; breaks if Throne VPN is up' },
    { id: 'nemotron', provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', quality: 0.95, enabled: true, note: 'free NVIDIA tier' },
    { id: 'gemini-flash', provider: 'gemini', model: 'gemini-3.6-flash', quality: 0.85, enabled: true, note: 'fast, free tier' },
    { id: 'gemini-pro', provider: 'gemini', model: 'gemini-3.1-pro-preview', quality: 1.0, enabled: true, note: 'strongest reasoning; slower' },
    { id: 'kimi', provider: 'nvidia', model: 'moonshotai/kimi-k3.1-pro', quality: 0.9, enabled: true, note: 'long context; measured 73.6 s for OK' },
    { id: 'minimax', provider: 'nvidia', model: 'minimaxai/minimax-m3.1-flash', quality: 0.75, enabled: true, note: 'fast cheap general work' },
    { id: 'mistral', provider: 'nvidia', model: 'mistralai/mistral-large-4-1t-a52b', quality: 0.8, enabled: true, note: 'general reasoning' },
    { id: 'glm', provider: 'nvidia', model: 'z-ai/glm-5.3-flash', quality: 0.78, enabled: false, note: 'disabled: 180 s+ timeouts' },
    { id: 'local', provider: 'ollama', model: 'qwen2.5:1.5b', quality: 0.35, enabled: true, local: true, note: 'offline, free, no network' },
    { id: 'freellm-auto', provider: 'freellmapi', model: 'auto', quality: 0.8, enabled: true, direct: true, note: 'local FreeLLMAPI router (87 providers); no tools' },
    { id: 'local-vision', provider: 'ollama', model: 'qwen2.5vl:3b', quality: 0.3, enabled: true, local: true, vision: true, note: 'vision fallback' },
  ],
}

function hermesEnv() {
  const file = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env')
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"]+?)['"]?\s*$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (j && Array.isArray(j.models)) return j
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT))
}

function save(reg) {
  const dir = path.dirname(FILE())
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify(reg, null, 2) + '\n')
  } catch {}
  return reg
}

function ensure() {
  const file = FILE()
  if (!fs.existsSync(file)) save(JSON.parse(JSON.stringify(DEFAULT)))
  return load()
}

/* Provider -> the env var that proves a key exists. Values are never read into
 * this process; the hermes CLI reads them itself. */
const KEY_FOR = {
  nvidia: ['NVIDIA_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
}

function hasKey(provider, env) {
  /* Custom OpenAI-compatible providers get an auto-named key from Hermes
   * (HERMES_CUSTOM_*_API_KEY), so presence is detected by pattern rather than
   * by hard-coding one machine's host in the source. */
  if (String(provider).startsWith('custom:')) {
    return Object.keys(env || {}).some((k) => /^HERMES_CUSTOM_.*_API_KEY$/.test(k) && String(env[k] || '').length > 8)
  }
  const names = KEY_FOR[provider]
  if (!names) return true // ollama, or a provider configured some other way
  return names.some((n) => env[n] && String(env[n]).trim().length > 8)
}

const speedScore = (secs) => (Number.isFinite(secs) ? Math.max(0, Math.min(1, 1 - (secs - 2) / 58)) : 0.5)

/** Pure: rank entries by measured health on top of the quality prior. */
function rank(entries, h, opts = {}) {
  const now = Date.now()
  const models = (h && h.models) || {}
  return entries
    .filter((e) => e.enabled !== false)
    .map((e) => {
      const k = health.keyOf(e.provider, e.model)
      const m = models[k] || null
      const attempts = m ? (m.ok || 0) + (m.fail || 0) : 0
      const reliability = attempts ? (m.ok || 0) / attempts : 0.5
      const fresh = m && m.lastOk ? Math.max(0, 1 - (now - m.lastOk) / (24 * 3600e3)) : 0
      let score = 0.45 * (e.quality || 0.5) + 0.25 * reliability + 0.20 * speedScore(m && m.lastSecs) + 0.10 * fresh
      const cooling = m && m.lastFail && (!m.lastOk || m.lastFail > m.lastOk) && now - m.lastFail < 10 * 60e3
      if (cooling) score *= 0.25
      if (e.local) score -= 0.08
      const row = {
        id: e.id, provider: e.provider, model: e.model, local: !!e.local,
        quality: e.quality || 0.5, score: Math.round(score * 1000) / 1000,
        attempts, ok: m ? m.ok || 0 : 0, fail: m ? m.fail || 0 : 0,
        secs: m && Number.isFinite(m.lastSecs) ? m.lastSecs : null,
        status: m ? m.lastStatus : 'untested', cooling: !!cooling,
        note: e.note || '', usable: true,
      }
      return row
    })
    .filter((r) => (opts.all ? true : r.usable))
    .sort((a, b) => b.score - a.score || (a.secs || 999) - (b.secs || 999))
}

/** Ranked view. Reads keys + health, writes nothing. */
function status(opts = {}) {
  const reg = ensure()
  const env = hermesEnv()
  let directOk = false
  try { directOk = !!require('./direct').config() } catch {}
  const rows = reg.models.map((e) => ({ ...e, usable: e.direct || e.provider === 'freellmapi' ? directOk : e.local ? true : hasKey(e.provider, env) }))
  return rank(rows, health.load(), opts)
}

/** The next model worth trying, skipping ids/providers already attempted. */
function best(exclude = []) {
  const skip = new Set(exclude)
  const rows = status()
  return rows.find((r) => !skip.has(r.id) && !skip.has(r.model) && !r.cooling) || rows[0] || null
}

/** The quickest model with a good recent record, for short questions. */
function fastest(exclude = []) {
  const skip = new Set(exclude)
  const rows = status().filter((r) => !skip.has(r.id) && !skip.has(r.model) && !r.cooling)
  const scored = rows.map((r) => {
    const attempts = (r.ok || 0) + (r.fail || 0)
    const rel = attempts ? (r.ok || 0) / attempts : 0.5
    const sp = r.secs != null ? Math.max(0, 1 - (r.secs - 1) / 20) : 0.35
    return { ...r, fast: 0.45 * sp + 0.35 * rel + 0.20 * (r.quality || 0.5) }
  }).sort((a, b) => b.fast - a.fast)
  return scored[0] || null
}

function runHermes(entry, prompt, timeout) {
  const args = ['-z', prompt, '-m', entry.model, '--provider', entry.provider]
  const env = Object.assign({}, process.env)
  if (!entry.vpn) { delete env.HTTPS_PROXY; delete env.HTTP_PROXY; delete env.ALL_PROXY }
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile(HERMES, args, { env, timeout, windowsHide: true, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim()
      const secs = Math.round((Date.now() - t0) / 100) / 10
      if (err && !text) return resolve({ ok: false, secs, text: String(stderr || err.message).slice(0, 300) })
      const ok = !!text && !health.classifyFailure(text).limited && text.length < 400
      resolve({ ok, secs, text: text || String(stderr || '').slice(0, 300) })
    })
  })
}

/** Probe one entry (two tokens) and record the outcome. */
async function probe(entry, opts = {}) {
  if (!entry) return { ok: false, error: 'no such model' }
  if (entry.direct || entry.provider === 'freellmapi') {
    try {
      const direct = require('./direct')
      const r = await direct.chat([{ role: 'user', content: opts.prompt || 'Reply with exactly: OK' }], { model: entry.model || 'auto', maxTokens: 8, timeout: opts.timeout || 60000 })
      health.recordModel({ provider: entry.provider, model: entry.model, ok: r.ok, secs: r.secs, status: r.ok ? 'ok' : 'failed', error: r.ok ? undefined : r.error })
      return { ok: r.ok, secs: r.secs, text: r.text || r.error }
    } catch (e) {
      health.recordModel({ provider: entry.provider, model: entry.model, ok: false, status: 'failed', error: e.message })
      return { ok: false, text: e.message }
    }
  }
  if (entry.local) {
    try {
      const t0 = Date.now()
      const text = await ollama.generate('Reply with exactly: OK', { model: entry.model, maxTokens: 4, timeout: 60000 })
      const secs = Math.round((Date.now() - t0) / 100) / 10
      const ok = /ok/i.test(text)
      health.recordModel({ provider: entry.provider, model: entry.model, ok, secs, status: ok ? 'ok' : 'failed', error: ok ? undefined : text.slice(0, 120) })
      return { ok, secs, text }
    } catch (e) {
      health.recordModel({ provider: entry.provider, model: entry.model, ok: false, status: 'failed', error: e.message })
      return { ok: false, secs: null, text: e.message }
    }
  }
  const r = await runHermes(entry, opts.prompt || 'Reply with exactly: OK', opts.timeout || 60000)
  const kind = r.ok ? null : health.classifyFailure(r.text).kind
  health.recordModel({ provider: entry.provider, model: entry.model, ok: r.ok, secs: r.secs, status: r.ok ? 'ok' : (kind || 'failed'), error: r.ok ? undefined : r.text })
  return { ...r, kind }
}

/** Probe stale (or all) entries. Sequential on purpose: parallel probes make
 * a rate-limited provider look broken for every model behind it. */
async function refresh(opts = {}) {
  const reg = ensure()
  const env = hermesEnv()
  const h = health.load()
  const out = []
  for (const e of reg.models) {
    if (e.enabled === false) continue
    if (!e.local && !hasKey(e.provider, env)) { out.push({ id: e.id, skipped: 'no key' }); continue }
    const k = health.keyOf(e.provider, e.model)
    const m = h.models[k]
    const stale = !m || !m.lastOk || Date.now() - m.lastOk > PROBE_TTL
    if (!opts.all && !opts.force && !stale) { out.push({ id: e.id, skipped: 'fresh' }); continue }
    const r = await probe(e, opts)
    out.push({ id: e.id, ok: r.ok, secs: r.secs, text: String(r.text || '').slice(0, 80) })
    if (opts.onStep) opts.onStep({ id: e.id, ...r })
  }
  return out
}

function setEnabled(id, on) {
  const reg = ensure()
  const e = reg.models.find((x) => x.id === id || x.model === id)
  if (!e) return false
  e.enabled = !!on
  save(reg)
  return true
}

function add(entry) {
  if (!entry || !entry.provider || !entry.model) return false
  const reg = ensure()
  const id = entry.id || String(entry.provider).replace(/[^a-z0-9]+/gi, '-') + '-' + String(entry.model).split('/').pop()
  if (reg.models.some((x) => x.id === id)) return false
  reg.models.push({ id, quality: 0.6, enabled: true, ...entry, id })
  save(reg)
  return true
}

module.exports = { load, save, ensure, status, rank, best, fastest, probe, refresh, setEnabled, add, hasKey, hermesEnv, DEFAULT, FILE, KEY_FOR }
