'use strict'
/**
 * Ollama client — the local brain Jarvis uses for everything that does not need
 * the big model: session summaries, fact extraction, skill drafting, and
 * answering when the network is gone.
 *
 * The server is slow to load a model but fast once it is warm (~0.2-0.3 s for a
 * short answer), so `warm()` exists to kick it at startup and `keep_alive` keeps
 * it resident.
 */
const http = require('http')

const BASE = process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434'
const MODEL = process.env.JARVIS_OLLAMA_MODEL || 'qwen2.5:1.5b'
const KEEP = '10m'

function post(path, body, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const url = new URL(BASE + path)
    const req = http.request(
      { host: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (out += c))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('ollama HTTP ' + res.statusCode))
          try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
        })
      })
    req.on('timeout', () => req.destroy(new Error('ollama timeout')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function get(path, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path)
    const req = http.get({ host: url.hostname, port: url.port || 80, path: url.pathname, timeout }, (res) => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (out += c))
      res.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function available() {
  try { await get('/api/tags', 1200); return true } catch { return false }
}

async function models() {
  try {
    const j = await get('/api/tags')
    return (j.models || []).map((m) => ({ name: m.name, size: m.size, params: m.details && m.details.parameter_size }))
  } catch { return [] }
}

/** Chat completion with optional system prompt. Returns plain text. */
async function chat(messages, opts = {}) {
  const body = {
    model: opts.model || MODEL,
    messages,
    stream: false,
    keep_alive: KEEP,
    options: {
      temperature: opts.temperature ?? 0.3,
      num_predict: opts.maxTokens ?? 300,
    },
  }
  const j = await post('/api/chat', body, opts.timeout || 120000)
  const text = j && j.message && j.message.content ? String(j.message.content) : ''
  return text.trim()
}

async function generate(prompt, opts = {}) {
  return chat([{ role: 'user', content: prompt }], opts)
}

/** Load the model into memory so the first real request is not a 19 s wait. */
async function warm() {
  try {
    const t0 = Date.now()
    await chat([{ role: 'user', content: 'ok' }], { maxTokens: 4, timeout: 90000 })
    return { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** Ask for JSON and tolerate the small model's habit of wrapping it in prose. */
async function json(prompt, opts = {}) {
  const raw = await generate(prompt + '\n\nReply with JSON only, no explanation, no code fences.', { temperature: 0.1, ...opts })
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.search(/[[{]/)
  if (start === -1) return null
  for (let end = cleaned.length; end > start; end--) {
    const slice = cleaned.slice(start, end)
    try { return JSON.parse(slice) } catch {}
  }
  return null
}

module.exports = { available, models, chat, generate, warm, json, BASE, MODEL }
