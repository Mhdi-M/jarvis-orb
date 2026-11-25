/* ---------------------------------------------------------------- gateway
 * A small local control plane, the piece OpenClaw centres its architecture on:
 * one place that answers for sessions, tools, jobs and status, so any client
 * (phone, script, another app) can talk to Jarvis without a terminal.
 *
 * Deliberately minimal and loopback-only:
 *   GET  /status         model, agents, tunnel, background jobs
 *   POST /ask            {"text": "..."} -> runs one manager turn, returns the answer
 *   POST /bg             {"text": "..."} -> queues a background job, returns its id
 *   GET  /bg/:id         job metadata + tail of its log
 *
 * Auth: a token created on first start and stored in data/gateway.json. Without
 * it every request is rejected, because a control plane that can run shell
 * commands must never be open on the network.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const agents = require('./agents')
const bg = require('./bg')

const STATE = path.join(__dirname, '..', 'data', 'gateway.json')
const DEFAULT_PORT = 8787

function state() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch (e) {
    const fresh = { port: DEFAULT_PORT, token: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString() }
    try {
      fs.mkdirSync(path.dirname(STATE), { recursive: true })
      fs.writeFileSync(STATE, JSON.stringify(fresh, null, 2) + '\n')
    } catch (e2) {}
    return fresh
  }
}

let server = null

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function body(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 65536) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch (e) { resolve({}) } })
  })
}

function start(opts) {
  const o = opts || {}
  if (server) return { ok: true, already: true, port: state().port }
  const st = state()
  const port = o.port || st.port

  server = http.createServer(async (req, res) => {
    const token = req.headers['x-jarvis-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (token !== st.token) return json(res, 401, { error: 'bad or missing token' })

    const url = req.url.split('?')[0]
    try {
      if (req.method === 'GET' && url === '/status') {
        const running = bg.list().filter((j) => j.status === 'running').length
        return json(res, 200, {
          ok: true,
          model: (agents.get('manager') || {}).model || null,
          agents: agents.list().filter((a) => a.enabled).map((a) => a.name),
          background: { total: bg.list().length, running },
          uptime: process.uptime()
        })
      }
      if (req.method === 'POST' && url === '/ask') {
        const b = await body(req)
        if (!b.text) return json(res, 400, { error: 'text required' })
        const agent = agents.get('manager')
        const r = await agents.run(agent, String(b.text))
        return json(res, 200, { ok: r.status === 'ok', answer: r.text, secs: r.secs, agent: r.agent })
      }
      if (req.method === 'POST' && url === '/bg') {
        const b = await body(req)
        if (!b.text) return json(res, 400, { error: 'text required' })
        const job = bg.start(String(b.text))
        return json(res, 200, { ok: true, id: job.id })
      }
      if (req.method === 'GET' && url.startsWith('/bg/')) {
        const id = url.slice(4)
        const job = bg.list().find((j) => j.id === id)
        if (!job) return json(res, 404, { error: 'no such job' })
        return json(res, 200, { job, log: bg.log(id, 20) })
      }
      return json(res, 404, { error: 'not found', routes: ['/status', '/ask', '/bg', '/bg/:id'] })
    } catch (e) {
      return json(res, 500, { error: String(e).slice(0, 200) })
    }
  })

  return new Promise((resolve) => {
    server.on('error', (e) => { server = null; resolve({ ok: false, error: e.message }) })
    server.listen(port, '127.0.0.1', () => resolve({ ok: true, port, token: st.token }))
  })
}

function stop() {
  if (!server) return false
  server.close()
  server = null
  return true
}

function status() {
  const st = state()
  return { running: !!server, port: st.port, tokenHint: st.token.slice(0, 6) + '...', state: STATE }
}

module.exports = { start, stop, status, state }
