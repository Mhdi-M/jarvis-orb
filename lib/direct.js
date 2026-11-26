'use strict'
/**
 * FreeLLMAPI client — the local aggregator as Jarvis's own fallback.
 *
 * The desktop app exposes an OpenAI-compatible endpoint on loopback with one
 * client key. This module talks to it directly, without going through Hermes,
 * so Jarvis still gets an answer when the Hermes provider is rate-limited or
 * unreachable. It carries no tools: it is a last-resort brain, not a worker.
 *
 * Key lives in data/freellmapi.json (0600), written by the pairing step; it is
 * never logged or printed.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')

const CFG = process.env.JARVIS_FREELLM_FILE || path.join(__dirname, '..', 'data', 'freellmapi.json')
const DEFAULT_BASE = 'http://127.0.0.1:31415/v1'

function config() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG, 'utf8'))
    if (j && j.key) return { baseUrl: j.baseUrl || DEFAULT_BASE, key: j.key }
  } catch {}
  return null
}

function request(baseUrl, pathname, { method = 'GET', key, body, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let url
    try { url = new URL(baseUrl.replace(/\/$/, '') + pathname) } catch { return resolve({ code: 0, body: 'bad base url' }) }
    const data = body ? JSON.stringify(body) : null
    const req = http.request({
      host: url.hostname, port: url.port || 80, path: url.pathname, method,
      headers: Object.assign({ 'content-type': 'application/json' }, key ? { authorization: 'Bearer ' + key } : {}, data ? { 'content-length': Buffer.byteLength(data) } : {}),
      timeout,
    }, (res) => {
      let out = ''
      res.on('data', (c) => { out += c })
      res.on('end', () => resolve({ code: res.statusCode, body: out }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: 'timeout' }) })
    req.on('error', (e) => resolve({ code: 0, body: e.message }))
    if (data) req.write(data)
    req.end()
  })
}

async function available() {
  const c = config()
  if (!c) return false
  const r = await request(c.baseUrl, '/models', { key: c.key, timeout: 3000 })
  return r.code === 200
}

async function models() {
  const c = config()
  if (!c) return []
  const r = await request(c.baseUrl, '/models', { key: c.key, timeout: 8000 })
  try { return (JSON.parse(r.body).data || []).map((m) => m.id) } catch { return [] }
}

/**
 * chat(messages, {model}) -> {ok, text, secs, model}
 * The router picks a working model when model is "auto" or absent.
 */
async function chat(messages, opts = {}) {
  const c = config()
  if (!c) return { ok: false, error: 'FreeLLMAPI is not paired (data/freellmapi.json missing)' }
  const t0 = Date.now()
  const r = await request(c.baseUrl, '/chat/completions', {
    method: 'POST', key: c.key, timeout: opts.timeout || 90000,
    body: { model: opts.model || 'auto', messages, max_tokens: opts.maxTokens || 900, temperature: opts.temperature ?? 0.3, stream: false },
  })
  const secs = Math.round((Date.now() - t0) / 100) / 10
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  if (r.code !== 200) {
    const msg = (j && (j.error && j.error.message)) || String(r.body).slice(0, 200) || ('HTTP ' + r.code)
    return { ok: false, error: msg, secs, code: r.code }
  }
  const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
  return { ok: !!text.trim(), text: String(text).trim(), secs, model: (j && j.model) || opts.model || 'auto' }
}

module.exports = { chat, models, available, config, CFG }
