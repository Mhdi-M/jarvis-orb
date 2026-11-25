/* ---------------------------------------------------------------- agents
 * A registry of specialists (model + provider + toolset) and a cascade that
 * fails over between them. This is the manager's delegation layer: it does not
 * guess, it reads data/agents.json, and when an agent is rate-limited, missing
 * a key, timing out or answering with an error, the next one in the chain takes
 * the task. Every attempt is reported so the trace shows what was tried.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const REG_PATH = path.join(__dirname, '..', 'data', 'agents.json')
const HERMES = process.env.HERMES_BIN ||
  'C:\\Users\\Source\\AppData\\Local\\hermes\\hermes-agent\\.hermes\\bin\\hermes.exe'

function load() {
  try {
    return JSON.parse(fs.readFileSync(REG_PATH, 'utf8'))
  } catch (e) {
    return { agents: [], cascade: [], failover: { timeout_ms: 180000, patterns: [] } }
  }
}

function save(reg) {
  reg.updated = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(REG_PATH, JSON.stringify(reg, null, 2) + '\n')
}

function list() {
  const reg = load()
  return reg.agents.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99))
}

function get(name) {
  return list().find((a) => a.name === name) || null
}

function isFailure(text) {
  const t = String(text || '').toLowerCase()
  const pats = (load().failover && load().failover.patterns) || []
  return pats.some((p) => t.includes(String(p).toLowerCase()))
}

function run(agent, task, opts) {
  const o = opts || {}
  const timeout = o.timeout || agent.timeout || (load().failover && load().failover.timeout_ms) || 180000
  const args = ['-z', task, '-m', agent.model, '--provider', agent.provider]
  if (agent.toolsets) args.push('-t', agent.toolsets)

  const env = Object.assign({}, process.env)
  // per-agent proxy: an agent that needs the tunnel gets one, the rest stay direct
  if (agent.vpn) {
    env.HTTPS_PROXY = env.JARVIS_VPN_PROXY || 'socks5://127.0.0.1:2080'
    env.HTTP_PROXY = env.HTTPS_PROXY
  } else {
    delete env.HTTPS_PROXY
    delete env.HTTP_PROXY
    delete env.ALL_PROXY
  }

  const t0 = Date.now()
  return new Promise((resolve) => {
    execFile(HERMES, args, { env, timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errText = String(stderr || '').trim()
      const secs = Math.round((Date.now() - t0) / 100) / 10
      let status = 'ok'
      let text = out
      if (err && !out) { status = 'error'; text = errText || err.message }
      else if (!out) { status = 'empty'; text = errText || 'no output' }
      else if (isFailure(out)) { status = 'failed'; text = out }
      if (err && out) status = 'failed'
      resolve({ agent: agent.name, model: agent.model, status, secs, text, err: errText })
    })
  })
}

/* Try agents in cascade order (or the given list) until one really answers.
 * A task with no usable specialist comes back with attempts so the caller can
 * tell the user which agents were tried and why each one bailed. */
async function cascade(task, opts) {
  const o = opts || {}
  const reg = load()
  const onAttempt = o.onAttempt || (() => {})
  const order = o.agents && o.agents.length ? o.agents : (reg.cascade || [])
  const injected = process.env.JARVIS_CASCADE_INJECT
    ? [{ name: 'injected-slow', model: 'deepseek/deepseek-v4-flash', provider: 'custom:swm', toolsets: null, enabled: true, timeout: 1200 }]
    : []

  const pool = injected.concat(order.map((n) => get(n)).filter(Boolean)).filter((a) => a.enabled !== false)
  const attempts = []

  for (const agent of pool) {
    if (o.only && agent.name !== o.only) continue
    onAttempt({ phase: 'start', agent: agent.name, model: agent.model })
    const res = await run(agent, task, o)
    attempts.push(res)
    onAttempt({ phase: 'done', agent: agent.name, model: agent.model, status: res.status, secs: res.secs })
    if (res.status === 'ok') return { answer: res.text, agent: res.agent, model: res.model, secs: res.secs, attempts }
  }
  return { answer: null, agent: null, model: null, secs: attempts.reduce((s, a) => s + a.secs, 0), attempts }
}

module.exports = { load, save, list, get, run, cascade, isFailure, REG_PATH, HERMES }
