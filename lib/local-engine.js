'use strict'

const http = require('http')
const https = require('https')

const DEFAULT_URL = process.env.JARVIS_LOCAL_URL || 'http://127.0.0.1:11434'
const DEFAULT_MODEL = process.env.JARVIS_LOCAL_MODEL || 'qwen2.5:1.5b'

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.request(parsed, { ...options, method: options.method || 'GET', timeout: options.timeout || 1500 }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`local model returned HTTP ${res.statusCode}`))
        try { resolve(data ? JSON.parse(data) : {}) } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('local model timeout')))
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function available(baseUrl = DEFAULT_URL) {
  try { await requestJson(`${baseUrl}/api/tags`, { timeout: 900 }); return true } catch { return false }
}

async function ask(prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_URL
  const model = options.model || DEFAULT_MODEL
  const result = await requestJson(`${baseUrl}/api/generate`, {
    method: 'POST', timeout: options.timeout || 120000,
    headers: { 'content-type': 'application/json' },
  }, { model, prompt, stream: false, keep_alive: '2m' })
  if (!result.response) throw new Error('local model returned no response')
  return String(result.response)
}

module.exports = { available, ask, DEFAULT_URL, DEFAULT_MODEL, _internals: { requestJson } }
