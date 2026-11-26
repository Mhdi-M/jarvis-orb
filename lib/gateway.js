/* ---------------------------------------------------------------- gateway
 * A small local control plane: one place that answers for sessions, agents,
 * jobs and status, so any client (phone, script, another app) can talk to
 * Jarvis without a terminal.
 *
 *   POST /pair            {"name":"phone"} -> one-time code (no token needed, loopback only)
 *   GET  /pair?code=XXXX  -> pending | approved (returns a client token exactly once)
 *   GET  /status          model, agents, performance, background jobs
 *   POST /ask             {"text":"..."} -> one manager turn
 *   POST /bg              {"text":"..."} -> background job id
 *   GET  /bg/:id          job metadata + tail of its log
 *
 * Auth: the master token is generated on first start and stored ONLY as a
 * sha256 hash; an optional passphrase is stored as scrypt. Every rejected
 * request is rate-limited and written to the security audit log. The listener
 * is bound to 127.0.0.1 and nothing else.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const agents = require('./agents')
const bg = require('./bg')
const health = require('./health')
const security = require('./security')
const reflect = require('./reflect')

const STATE = process.env.JARVIS_GATEWAY_FILE || path.join(__dirname, '..', 'data', 'gateway.json')
const DEFAULT_PORT = 8787
const PAIR_TTL = 5 * 60 * 1000
const MAX_PAIRS = 8
const FAIL_WINDOW = 60 * 1000
const FAIL_LIMIT = 5

let server = null
let liveToken = null            // plaintext, only in the process that started the server
const fails = new Map()          // ip -> { n, until }

function freshState() {
  const token = security.newToken()
  liveToken = token
  return { port: DEFAULT_PORT, tokenHash: security.hashToken(token), bind: '127.0.0.1', createdAt: new Date().toISOString(), pairs: [] }
}

function state() {
  let j = null
  try { j = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch {}
  if (!j || typeof j !== 'object') j = freshState()
  /* migrate a pre-hash state: hash the plaintext in place, never keep both */
  if (j.token && !j.tokenHash) { j.tokenHash = security.hashToken(j.token); delete j.token }
  if (!j.tokenHash) { const t = security.newToken(); liveToken = t; j.tokenHash = security.hashToken(t) }
  if (!Array.isArray(j.pairs)) j.pairs = []
  if (!Array.isArray(j.clients)) j.clients = []
  j.clients = j.clients.filter((c) => !c.expires || c.expires > Date.now())
  j.bind = j.bind || '127.0.0.1'
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify(j, null, 2) + '\n')
  } catch {}
  return j
}

function saveState(j) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify(j, null, 2) + '\n')
  } catch {}
  return j
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function body(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 65536) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
  })
}

/* ------------------------------------------------------------------- auth */
function offered(req) {
  return req.headers['x-jarvis-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
}

function authorized(st, req) {
  const given = String(offered(req) || '')
  if (!given) return false
  if (st.tokenHash && security.hashToken(given) === st.tokenHash) return true
  if (liveToken && given === liveToken) return true
  if (st.password && security.verifyPassword(given, st.password)) return true
  /* tokens handed out by the pairing flow, stored only as hashes */
  if (Array.isArray(st.clients) && st.clients.some((c) => c.hash === security.hashToken(given))) return true
  return false
}

function blocked(ip) {
  const f = fails.get(ip)
  return f && f.until > Date.now() ? f : null
}

function noteFail(ip) {
  const now = Date.now()
  const f = fails.get(ip) || { n: 0, until: 0 }
  if (now - (f.at || 0) > FAIL_WINDOW) f.n = 0
  f.n += 1
  f.at = now
  if (f.n >= FAIL_LIMIT) f.until = now + FAIL_WINDOW
  fails.set(ip, f)
  return f
}

function clearFail(ip) { fails.delete(ip) }

/* ----------------------------------------------------------------- pairing */
function prunePairs(st, now = Date.now()) {
  st.pairs = (st.pairs || []).filter((p) => p.expires > now).slice(-MAX_PAIRS)
  return st.pairs
}

/** New one-time code. The code itself is never stored; only its hash. */
function requestPair(name) {
  const st = state()
  prunePairs(st)
  if (st.pairs.length >= MAX_PAIRS) return { ok: false, error: 'too many pending pairings' }
  const code = security.newCode(6)
  const rec = { name: String(name || 'client').slice(0, 40), codeHash: security.hashToken(code), createdAt: Date.now(), expires: Date.now() + PAIR_TTL, approved: false, used: false }
  st.pairs.push(rec)
  saveState(st)
  security.audit({ area: 'gateway', action: 'pair-request', name: rec.name })
  return { ok: true, code, expiresIn: Math.round(PAIR_TTL / 1000) }
}

function findPair(st, code) {
  const h = security.hashToken(String(code || '').trim().toUpperCase())
  return (st.pairs || []).find((p) => p.codeHash === h) || null
}

function approve(code) {
  const st = state()
  prunePairs(st)
  const p = findPair(st, code)
  if (!p) return { ok: false, error: 'no such or expired code' }
  if (p.used) return { ok: false, error: 'code already used' }
  p.approved = true
  p.grant = crypto.randomBytes(24).toString('hex') // handed over exactly once
  saveState(st)
  security.audit({ area: 'gateway', action: 'pair-approve', name: p.name })
  return { ok: true, name: p.name }
}

function pairStatus(code) {
  const st = state()
  const p = findPair(st, code)
  if (!p) return { status: 'unknown' }
  if (p.expires <= Date.now()) return { status: 'expired' }
  if (!p.approved) return { status: 'pending', expiresIn: Math.max(0, Math.round((p.expires - Date.now()) / 1000)) }
  if (!p.grant) return { status: 'used' }
  const token = p.grant
  p.grant = null
  p.used = true
  st.clients.push({ name: p.name, hash: security.hashToken(token), at: Date.now(), expires: Date.now() + 90 * 864e5 })
  saveState(st)
  security.audit({ area: 'gateway', action: 'pair-collected', name: p.name })
  return { status: 'approved', token, name: p.name }
}

function pending() {
  const st = state()
  prunePairs(st)
  return st.pairs.filter((p) => !p.used).map((p) => ({ name: p.name, expiresIn: Math.max(0, Math.round((p.expires - Date.now()) / 1000)), approved: !!p.approved }))
}

function setPassword(pw) {
  const st = state()
  const pass = String(pw || '').trim()
  if (pass.length < 8) return { ok: false, error: 'password needs at least 8 characters' }
  st.password = security.hashPassword(pass)
  st.passwordSetAt = new Date().toISOString()
  saveState(st)
  security.audit({ area: 'gateway', action: 'password-set' })
  return { ok: true }
}

/* ------------------------------------------------------------------ server */
function start(opts) {
  const o = opts || {}
  if (server) return Promise.resolve({ ok: true, already: true, port: state().port, token: liveToken })
  const st = state()
  const port = o.port || st.port

  server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    const ip = (req.socket && req.socket.remoteAddress) || 'local'
    const url = String(req.url || '').split('?')[0]

    const deny = (code, msg) => {
      noteFail(ip)
      security.audit({ area: 'gateway', action: 'denied', path: url, status: code, ip, ms: Date.now() - t0 })
      return json(res, code, { error: msg })
    }

    if (blocked(ip)) return json(res, 429, { error: 'too many bad attempts; wait a minute' })

    try {
      /* pairing is the only surface reachable without a credential */
      if (req.method === 'POST' && url === '/pair') {
        const payload = await body(req)
        const r = requestPair(payload.name)
        return r.ok ? json(res, 200, r) : json(res, 429, r)
      }
      if (req.method === 'GET' && url === '/pair') {
        const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('code')
        return json(res, 200, pairStatus(q))
      }

      if (!authorized(state(), req)) return deny(401, 'bad or missing token')
      clearFail(ip)

      if (req.method === 'GET' && url === '/status') {
        const running = bg.list().filter((j) => j.status === 'running').length
        return json(res, 200, {
          ok: true,
          model: (agents.get('manager') || {}).model || null,
          agents: agents.list().filter((a) => a.enabled).map((a) => a.name),
          performance: health.performance({ contextTokens: 0 }),
          rules: (reflect.current() || {}).rules || [],
          background: { total: bg.list().length, running },
          uptime: process.uptime(),
          paired: pending().length,
        })
      }
      if (req.method === 'POST' && url === '/ask') {
        const payload = await body(req)
        if (!payload.text) return json(res, 400, { error: 'text required' })
        const r = await agents.cascade(String(payload.text), {})
        return json(res, r.answer ? 200 : 503, {
          ok: !!r.answer, answer: r.answer, agent: r.agent, model: r.model, secs: r.secs,
          tries: r.attempts.map((a) => ({ agent: a.agent, status: a.status, secs: a.secs })),
        })
      }
      if (req.method === 'POST' && url === '/bg') {
        const payload = await body(req)
        if (!payload.text) return json(res, 400, { error: 'text required' })
        const job = bg.start(String(payload.text))
        return json(res, 200, { ok: true, id: job.id })
      }
      if (req.method === 'GET' && url.startsWith('/bg/')) {
        const id = url.slice(4)
        const job = bg.list().find((j) => j.id === id)
        if (!job) return json(res, 404, { error: 'no such job' })
        return json(res, 200, { job, log: bg.log(id, 20) })
      }
      return json(res, 404, { error: 'not found', routes: ['/pair', '/status', '/ask', '/bg', '/bg/:id'] })
    } catch (e) {
      security.audit({ area: 'gateway', action: 'error', path: url, detail: String(e).slice(0, 200) })
      return json(res, 500, { error: String(e).slice(0, 200) })
    }
  })

  return new Promise((resolve) => {
    server.on('error', (e) => { server = null; resolve({ ok: false, error: e.message }) })
    server.listen(port, '127.0.0.1', () => {
      security.audit({ area: 'gateway', action: 'start', port, bind: '127.0.0.1' })
      resolve({ ok: true, port, token: liveToken || undefined })
    })
  })
}

function stop() {
  if (!server) return false
  server.close()
  server = null
  security.audit({ area: 'gateway', action: 'stop' })
  return true
}

function status() {
  const st = state()
  return {
    running: !!server, port: st.port, bind: st.bind,
    tokenHash: st.tokenHash ? st.tokenHash.slice(0, 8) + '…' : null,
    password: !!st.password, pending: pending().length, state: STATE,
  }
}

module.exports = { start, stop, status, state, approve, requestPair, pairStatus, pending, setPassword, authorized, STATE, PAIR_TTL }
