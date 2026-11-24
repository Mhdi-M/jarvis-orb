'use strict'
/**
 * Bridge to the Hermes Agent CLI.
 *
 * Every orb message is a real Hermes turn, so the orb inherits every tool the
 * agent has: terminal, files, browser, email, cron, skills, memory.
 *
 * Conversation continuity: the first call starts a fresh Hermes session; the
 * session id is scraped from the CLI footer ("hermes --resume <id>") and saved,
 * so every later call resumes the same lineage.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const offline = require('./offline')
const memory = require('./lib/memory')
const localEngine = require('./lib/local-engine')
const netmode = require('./lib/netmode')
const profile = require('./lib/profile')
const monitor = require('./lib/monitor')
const skills = require('./lib/skills')

const settings = { netMode: 'direct', preferLocal: false, model: '', provider: '' }

const HERMES_EXE =
  process.env.JARVIS_HERMES_EXE ||
  'C:\\Users\\Source\\AppData\\Local\\hermes\\hermes-agent\\.hermes\\bin\\hermes.exe'

const STATE_FILE = path.join(__dirname, 'session.json')
const TIMEOUT_MS = 5 * 60 * 1000

let sessionId = null
/* A resumed session replays its whole transcript, so latency grows with it.
   Measured here: a fresh session answered in ~5 s, the same question in a
   41k-token session took ~13 s. Recycle well before that. */
let lastInputTokens = 0
const CTX_RECYCLE_AT = 25000
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (raw && typeof raw.sessionId === 'string') sessionId = raw.sessionId
} catch { /* first run */ }

function saveSession(id) {
  sessionId = id
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionId: id }, null, 2)) } catch {}
}

function resetSession() {
  sessionId = null
  try { fs.unlinkSync(STATE_FILE) } catch {}
}

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')

/** Pull the assistant text out of the CLI's banner-framed output. */
function parseAnswer(raw) {
  const lines = stripAnsi(raw).replace(/\r/g, '').split('\n')
  const isBar = (l) => /^[\u2500\u2501]{5,}\s*$/.test(l.trim())

  // Preferred shape:
  //   ────────────
  //   ☤ Hermes
  //   <answer>
  //   ────────────
  const marker = lines.findIndex((l) => l.includes('\u2624'))
  if (marker >= 0) {
    let end = marker + 1
    while (end < lines.length && !isBar(lines[end])) end++
    const body = lines.slice(marker + 1, end).join('\n').trim()
    if (body) return body
  }

  // Fallback: everything after the echoed query, before the session footer.
  const q = lines.findIndex((l) => /^Query:\s/.test(l))
  if (q >= 0) {
    let body = lines.slice(q + 1).filter((l) => !isBar(l)).join('\n')
    const cut = body.search(/\n\s*Resume this session with:|\n\s*Session:\s/)
    if (cut > -1) body = body.slice(0, cut)
    body = body.trim()
    if (body) return body
  }
  return ''
}

/** Serialise: Hermes sessions are not safe to drive concurrently. */
let chain = Promise.resolve()

/* The child currently answering, so Esc can stop it mid-flight. */
let activeChild = null
let cancelRequested = false

function cancel() {
  if (!activeChild) {
    // nothing running: still clear a stale flag
    cancelRequested = false
    return false
  }
  cancelRequested = true
  try { activeChild.kill('SIGKILL') } catch {}
  return true
}

/* Questions that only need an answer, not a tool chain. Keeps latency low. */
const HEAVY = /\b(write|build|code|refactor|fix|debug|create|make|install|compile|run|test|analy[sz]e|inspect|read|open|search|research|browse|download|upload|script|deploy|migrate|review|plan|step by step)\b/i

function isFastQuery(text) {
  const t = String(text || '').trim()
  if (t.length > 140) return false
  if (/\n/.test(t)) return false
  return !HEAVY.test(t)
}

/* The CLI emits NDJSON with --format stream-json: {"type":"text"} deltas and a
   final {"type":"result"} carrying the whole answer plus the session id. */
function parseJsonLine(line) {
  const t = line.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o.type === 'string' ? o : null
  } catch { return null }
}

/**
 * A session whose last turn was cut off is "paused" and refuses new turns.
 * Discard that turn and start clean, rather than leaving the user stuck.
 */
function discardPausedSession(id) {
  return new Promise((resolve) => {
    if (!id) return resolve(false)
    const { execFile } = require('child_process')
    execFile(HERMES_EXE, ['sessions', 'discard', id, '--yes'],
      { cwd: os.homedir(), windowsHide: true, timeout: 30000, env: { ...process.env } },
      (err) => {
        if (err) console.log('[bridge] discard failed:', err.message)
        resetSession()
        resolve(!err)
      })
  })
}

function spawnHermes(text, onDelta, onMeta) {
  return new Promise((resolve) => {
    const fast = isFastQuery(text)
    /* Resume pins the session's launch policy: --max-turns/--reasoning are
       rejected there, so they only ride along when starting a fresh session. */
    const args = sessionId
      ? ['--resume', sessionId, 'chat', '-q', text, '--format', 'stream-json']
      : ['chat', '-q', text, '--format', 'stream-json',
         '--max-turns', fast ? '4' : '12',
         ...(fast ? ['--reasoning', 'minimal'] : []),
         ...(settings.model ? ['-m', settings.model] : []),
         ...(settings.provider ? ['--provider', settings.provider] : [])]

    let child
    try {
      child = spawn(HERMES_EXE, args, {
        cwd: os.homedir(),
        windowsHide: true,
        env: { ...netmode.envFor(settings.netMode), HERMES_NO_BANNER: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ ok: false, text: `Could not start Hermes: ${e.message}` })
    }

    activeChild = child

    let out = ''
    let err = ''
    let done = false
    const finish = (payload) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (activeChild === child) activeChild = null
      resolve(payload)
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, text: 'Hermes took longer than 5 minutes. Try asking something narrower.' })
    }, TIMEOUT_MS)

    let pending = ''
    let streamed = ''
    let resultEvent = null

    child.stdout.on('data', (d) => {
      const chunk = d.toString()
      out += chunk                        // raw output, for the legacy parser
      pending += chunk
      let nl
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        const evt = parseJsonLine(line)
        if (!evt) continue
        if (evt.type === 'text' && typeof evt.text === 'string' && evt.text) {
          streamed += evt.text
          if (onDelta) { try { onDelta(evt.text) } catch {} }
        } else if (evt.type === 'result') {
          resultEvent = evt
          if (evt.session_id && evt.session_id !== sessionId) saveSession(evt.session_id)
          if (evt.tokens && Number.isFinite(evt.tokens.input)) lastInputTokens = evt.tokens.input
          if (onMeta) {
            try {
              onMeta({
                tokens: evt.tokens || null,
                sessionId: evt.session_id || sessionId,
                durationMs: evt.duration_ms || null,
                contextTokens: lastInputTokens,
              })
            } catch {}
          }
        }
      }
    })
    child.stderr.on('data', (d) => { err += d.toString() })

    child.on('error', (e) => finish({ ok: false, text: `Could not start Hermes: ${e.message}` }))

    child.on('close', (code) => {
      if (cancelRequested) {
        cancelRequested = false
        return finish({ ok: false, stopped: true, text: 'stopped.' })
      }

      const m = out.match(/hermes --resume (\S+)/)
      if (m && m[1] !== sessionId) saveSession(m[1])

      const fromEvent = resultEvent && typeof resultEvent.text === 'string' ? resultEvent.text.trim() : ''
      if (fromEvent) return finish({ ok: true, text: fromEvent })
      if (streamed.trim()) return finish({ ok: true, text: streamed.trim() })

      const answer = parseAnswer(out)
      if (answer) return finish({ ok: true, text: answer })

      const detail = stripAnsi(err || out).trim().split('\n').slice(-8).join('\n')
      finish({ ok: false, text: detail || `Hermes exited with code ${code} and said nothing.` })
    })
  })
}

/** No cloud: built-in intents first, then the local model, then an honest message. */
async function offlineAnswer(text) {
  const local = await offline.handle(text)
  if (local) return local
  if (await localEngine.available()) {
    try {
      const ctx = memory.context(text)
      const prompt = (ctx ? ctx + '\n\n' : '') + 'You are Jarvis, a concise personal assistant running locally. Answer briefly.\nUser: ' + text
      return { ok: true, offline: true, local: true, text: await localEngine.ask(prompt) }
    } catch (e) {
      return { ok: false, offline: true, text: `Local model failed: ${e.message}` }
    }
  }
  return {
    ok: false, offline: true,
    text: 'Offline, and no local model is running yet. I can still check machine health and open or close apps.',
  }
}

/** Short note so the cloud agent avoids heavy work while the PC is struggling. */
function pressureNote() {
  const last = monitor.recent(1)[0]
  if (!last || Date.now() - last.t > 120000) return ''
  const a = monitor.evaluate(last)
  return a.length ? `PC pressure right now (${a.join(', ')}): avoid heavy local tasks (builds, local models, big downloads); prefer lightweight or cloud approaches.` : ''
}

const NET_ERR = /(ECONN|ETIMEDOUT|ENOTFOUND|timed out|connection|network|unreachable|Could not start Hermes)/i

/**
 * Routing: Hermes (cloud models + its own fallbacks) ALWAYS goes first, with or without VPN/proxy.
 * The small local model is only an emergency fallback when Hermes cannot reach any cloud model.
 */
function ask(text, opts = {}) {
  const task = async () => {
    if (sessionId && lastInputTokens > CTX_RECYCLE_AT) {
      console.log(`[bridge] context at ${lastInputTokens} tokens — starting a fresh session`)
      resetSession()
      lastInputTokens = 0
    }
    const learned = memory.learnFrom(text)
    if (memory.isEnabled()) profile.record(text)
    if (settings.preferLocal) return Object.assign(await offlineAnswer(text), learned.length ? { learned } : {})
    /* skills Jarvis wrote for itself, when they match this request */
    const skillCtx = skills.toContext(text)
    const ctx = [memory.context(text), memory.isEnabled() ? profile.styleHint() : '', memory.isEnabled() ? profile.recentContext() : '', skillCtx, pressureNote()].filter(Boolean).join('\n')
    const prompt = ctx ? `[Context from Jarvis, do not mention unless relevant]\n${ctx}\n\n${text}` : text
    let res = await spawnHermes(prompt, opts.onDelta, opts.onMeta)
    if (!res.ok && /chat is paused|was not sent|paused turn/i.test(res.text || '')) {
      console.log('[bridge] session was paused — discarding the stuck turn and retrying')
      await discardPausedSession(sessionId)
      res = await spawnHermes(prompt, opts.onDelta, opts.onMeta)
    }
    if (!res.ok && NET_ERR.test(res.text || '')) {
      const local = await offlineAnswer(text)
      res = local.ok ? local : { ...res, text: res.text + '\n(Local fallback also unavailable.)' }
    }
    if (learned.length) res.learned = learned
    return res
  }
  const p = chain.then(task, task)
  chain = p.catch(() => {})
  return p
}

module.exports = {
  ask,
  cancel,
  settings,
  resetSession,
  getSessionId: () => sessionId,
  HERMES_EXE,
  _internals: { parseAnswer, stripAnsi },
}
