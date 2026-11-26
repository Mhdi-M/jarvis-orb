'use strict'
/**
 * Bridge to the Hermes Agent CLI.
 *
 * Every Jarvis message is a real Hermes turn, so it inherits every tool the
 * agent has: terminal, files, browser, email, cron, skills, memory.
 *
 * Continuity: the first call starts a Hermes session; later calls resume it.
 * When the context grows past the recycle point the session is summarised by
 * the local model and restarted, so the thread survives without paying for a
 * 40k-token replay.
 *
 * Resilience: a rate limit, quota, dead model name or unreachable provider is
 * not the end of the answer. The turn is re-run on the next model in the ranked
 * inventory, with a handoff note so the new model continues the same thread.
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
const session = require('./lib/session')
const learner = require('./lib/learner')
const ollama = require('./lib/ollama')
const health = require('./lib/health')
const models = require('./lib/models')

const settings = {
  netMode: 'direct',
  preferLocal: false,
  model: '',
  provider: '',
  autoSwitch: process.env.JARVIS_AUTO_SWITCH !== 'off',
  fastMode: process.env.JARVIS_FAST !== 'off',
  directFirst: process.env.JARVIS_DIRECT_FIRST !== 'off',
}

/* How many exchanges between rolling summaries, and whether to learn at all. */
const LEARN_EVERY = Number(process.env.JARVIS_LEARN_EVERY || 1)
const SUMMARISE_EVERY = Number(process.env.JARVIS_SUMMARISE_EVERY || 6)
let turnCount = 0
let pendingLearn = null

const HERMES_EXE = process.env.JARVIS_HERMES_EXE || require('./lib/hermes-bin').hermesBin()

/* One session file per instance. Two Jarvis processes used to share
 * session.json, so a background question and an interactive one clobbered each
 * other's session id and token count. JARVIS_SESSION=<name> isolates them. */
const SESSION_NAME = String(process.env.JARVIS_SESSION || '').trim().replace(/[^\w-]+/g, '-')
const STATE_FILE = SESSION_NAME && SESSION_NAME !== 'default'
  ? path.join(__dirname, 'data', 'sessions', SESSION_NAME + '.json')
  : path.join(__dirname, 'session.json')
const HANDOFF_FILE = path.join(__dirname, 'data', 'handoff.json')
const TIMEOUT_MS = 5 * 60 * 1000

let sessionId = null
/* A resumed session replays its whole transcript, so latency grows with it: the
   same question took 4.5 s in a fresh session and 11-13 s in a 75k-token one.
   The size is persisted with the id so a new process recycles *before* paying
   for one slow turn. */
let lastInputTokens = 0
const CTX_RECYCLE_AT = Number(process.env.JARVIS_CTX_LIMIT || 16000)
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (raw && typeof raw.sessionId === 'string') sessionId = raw.sessionId
  if (raw && Number.isFinite(raw.tokens)) lastInputTokens = raw.tokens
} catch { /* first run */ }

/* A note carried across a model switch or a context recycle. It is injected
 * into the next prompt once, then cleared, so the new session knows it is a
 * continuation rather than a fresh conversation. */
let handoff = ''
try {
  const h = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'))
  if (h && typeof h.text === 'string' && Date.now() - (h.at || 0) < 2 * 3600 * 1000) handoff = h.text
} catch {}
function saveHandoff(text) {
  handoff = String(text || '').slice(0, 1200)
  try {
    fs.mkdirSync(path.dirname(HANDOFF_FILE), { recursive: true })
    fs.writeFileSync(HANDOFF_FILE, JSON.stringify({ text: handoff, at: Date.now() }, null, 2))
  } catch {}
}
function clearHandoff() {
  handoff = ''
  try { fs.unlinkSync(HANDOFF_FILE) } catch {}
}

function saveSession(id) {
  sessionId = id
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionId: id, tokens: lastInputTokens }, null, 2))
  } catch {}
}

function saveTokens(n) {
  if (!Number.isFinite(n)) return
  lastInputTokens = n
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionId, tokens: n }, null, 2))
  } catch {}
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

  const marker = lines.findIndex((l) => l.includes('\u2624'))
  if (marker >= 0) {
    let end = marker + 1
    while (end < lines.length && !isBar(lines[end])) end++
    const body = lines.slice(marker + 1, end).join('\n').trim()
    if (body) return body
  }

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

let activeChild = null
let cancelRequested = false

function cancel() {
  if (!activeChild) {
    cancelRequested = false
    return false
  }
  cancelRequested = true
  try { activeChild.kill('SIGKILL') } catch {}
  return true
}

const HEAVY = /\b(write|build|code|refactor|fix|debug|create|make|install|compile|run|test|analy[sz]e|inspect|read|open|search|research|browse|download|upload|script|deploy|migrate|review|plan|step by step)\b/i

function isFastQuery(text) {
  const t = String(text || '').trim()
  if (t.length > 140) return false
  if (/\n/.test(t)) return false
  return !HEAVY.test(t)
}

function parseJsonLine(line) {
  const t = line.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o.type === 'string' ? o : null
  } catch { return null }
}

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

/* Which model this turn should start on: the explicit setting, the quickest
 * reliable one for a short question, or the best ranked model. */
function pickChoice(opts = {}) {
  if (settings.model) return { provider: settings.provider || 'auto', model: settings.model }
  if (opts.fast && settings.fastMode) {
    const quick = models.fastest()
    if (quick) return { provider: quick.provider, model: quick.model, id: quick.id, local: quick.local }
  }
  const best = models.best()
  if (best) return { provider: best.provider, model: best.model, id: best.id, local: best.local }
  return { provider: settings.provider || 'auto', model: settings.model || '' }
}

function spawnHermes(text, onDelta, onMeta, onTrace, choice) {
  return new Promise((resolve) => {
    const fast = isFastQuery(text)
    const use = choice || pickChoice()
    /* Resume pins the session's launch policy: --max-turns/--reasoning are
       rejected there, so they only ride along when starting a fresh session. */
    const args = sessionId
      ? ['--resume', sessionId, 'chat', '-q', text, '--format', 'stream-json']
      : ['chat', '-q', text, '--format', 'stream-json',
         '--max-turns', fast ? '4' : '12',
         ...(fast ? ['--reasoning', 'minimal'] : []),
         ...(use.model ? ['-m', use.model] : []),
         ...(use.provider ? ['--provider', use.provider] : [])]

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
      out += chunk
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
        } else if (evt.type === 'tool_use' || evt.type === 'tool_result' ||
                   evt.type === 'thinking' || evt.type === 'reasoning' || evt.type === 'status') {
          if (onTrace) { try { onTrace(evt) } catch {} }
        } else if (evt.type === 'result') {
          resultEvent = evt
          if (evt.session_id && evt.session_id !== sessionId) saveSession(evt.session_id)
          if (evt.tokens && Number.isFinite(evt.tokens.input)) saveTokens(evt.tokens.input)
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

function pressureNote() {
  const last = monitor.recent(1)[0]
  if (!last || Date.now() - last.t > 120000) return ''
  const a = monitor.evaluate(last)
  return a.length ? `PC pressure right now (${a.join(', ')}): avoid heavy local tasks (builds, local models, big downloads); prefer lightweight or cloud approaches.` : ''
}

/** Summarise the thread, then start a clean session, carrying the note forward. */
async function recycle(reason) {
  let summary = ''
  try { summary = await session.summarise('default', { timeout: 20000 }) } catch {}
  resetSession()
  lastInputTokens = 0
  saveHandoff('Context was recycled (' + reason + '). Continue the same conversation; do not restart it.' +
    (summary ? '\nSession so far:\n' + summary : ''))
  health.note('recycle', { reason, summary: !!summary })
  return summary
}

/* Short, repeated questions should not pay for a fresh model call. Only fast
 * questions are cached, and only for ten minutes. */
const replies = new Map()
const REPLY_TTL = 10 * 60 * 1000
const REPLY_MAX = 60
const replyKey = (text) => String(text).trim().toLowerCase().slice(0, 500) + '\u0000' + (settings.model || 'auto')
function replyGet(k) {
  const h = replies.get(k)
  if (!h) return null
  if (Date.now() - h.at > REPLY_TTL) { replies.delete(k); return null }
  return h.text
}
function replySet(k, text) {
  replies.set(k, { text, at: Date.now() })
  if (replies.size > REPLY_MAX) replies.delete(replies.keys().next().value)
}

function buildPrompt(text, skillCtx, sessionCtx) {
  const ctx = [memory.context(text), memory.isEnabled() ? profile.styleHint() : '', memory.isEnabled() ? profile.recentContext() : '', sessionCtx, skillCtx, pressureNote()].filter(Boolean).join('\n')
  const head = handoff ? '[Continuity note from Jarvis itself]\n' + handoff + '\n\n' : ''
  /* Tell the model about the preview path only when the request is visual. */
  const visual = /\b(html|chart|diagram|graph|plot|visuali[sz]e|preview|poster|landing page|dashboard|svg)\b/i.test(text)
  const hint = visual ? 'You can render visuals on this machine: write a self-contained .html file into data/previews/<name>.html, then tell the user to run /preview <name>.' : ''
  const body = ctx ? `[Context from Jarvis, do not mention unless relevant]\n${ctx}${hint ? '\n' + hint : ''}\n\n${text}` : (hint ? hint + '\n\n' + text : text)
  return head + body
}

const NET_ERR = /(ECONN|ETIMEDOUT|ENOTFOUND|timed out|connection|network|unreachable|Could not start Hermes)/i

function ask(text, opts = {}) {
  const task = async () => {
    if (sessionId && lastInputTokens > CTX_RECYCLE_AT) await recycle('context at ' + lastInputTokens + ' tokens')

    const learned = memory.learnFrom(text)
    if (memory.isEnabled()) profile.record(text)
    if (settings.preferLocal) return Object.assign(await offlineAnswer(text), learned.length ? { learned } : {})

    /* Cache first: a repeated short question should not even scan skills. */
    const fast = isFastQuery(text)
    if (fast) {
      const cached = replyGet(replyKey(text))
      if (cached) { health.note('cache', { text: String(text).slice(0, 80) }); return { ok: true, text: cached, cached: true, secs: 0 } }
    }

    /* Short question: the local FreeLLMAPI router answers in about a second and
     * needs no Hermes session. Tool work still goes through Hermes below. */
    if (fast && settings.directFirst) {
      try {
        const direct = require('./lib/direct')
        if (direct.config()) {
          const d = await direct.chat([
            { role: 'system', content: 'You are Jarvis, a concise personal assistant on the user machine. Answer directly and briefly.' },
            { role: 'user', content: text },
          ], { model: process.env.JARVIS_DIRECT_MODEL || 'auto', maxTokens: 600 })
          health.recordModel({ provider: 'freellmapi', model: d.model || 'auto', ok: d.ok, secs: d.secs, status: d.ok ? 'ok' : 'failed', error: d.ok ? undefined : d.error })
          if (d.ok) {
            replySet(replyKey(text), d.text)
            return { ok: true, text: d.text, via: 'freellmapi', model: d.model, secs: d.secs }
          }
        }
      } catch {}
    }

    const skillCtx = skills.toContext(text)
    const sessionCtx = session.context('default')

    let choice = pickChoice({ fast })
    let res = null
    const tried = []

    for (let attempt = 0; attempt <= 2; attempt++) {
      const prompt = buildPrompt(text, skillCtx, sessionCtx)
      const t0 = Date.now()
      res = await spawnHermes(prompt, opts.onDelta, opts.onMeta, opts.onTrace, choice)
      const secs = Math.round((Date.now() - t0) / 100) / 10
      const cls = res.ok ? null : health.classifyFailure(res.text)
      health.recordModel({
        provider: choice.provider, model: choice.model, ok: !!res.ok, secs: res.stopped ? undefined : secs,
        status: res.ok ? 'ok' : res.stopped ? 'stopped' : cls.kind,
        error: res.ok ? undefined : res.text,
      })

      if (res.ok || res.stopped) break
      if (!settings.autoSwitch) break

      /* A paused/cut turn is Hermes state, not the model: discard and retry once. */
      if (/chat is paused|was not sent|paused turn/i.test(res.text || '')) {
        await discardPausedSession(sessionId)
        res = await spawnHermes(text, opts.onDelta, opts.onMeta, opts.onTrace, choice)
        if (res.ok) break
      }
      if (!cls || !cls.retryable) break

      if (cls.kind === 'context') {
        await recycle('context window')
        if (opts.onNotice) { try { opts.onNotice('limited', 'context window reached — recycled with a summary') } catch {} }
        continue
      }

      tried.push(choice.model)
      const next = models.best(tried)
      if (!next || next.model === choice.model) break

      /* Switching model starts a clean session: resume pins the old model. The
         handoff note keeps the thread, which is the point. */
      resetSession()
      lastInputTokens = 0
      saveHandoff('The previous model (' + (choice.model || 'unknown') + ') failed because ' + cls.plain +
        '. You are continuing the same conversation on ' + next.model + '; do not restart it.')
      if (opts.onSwitch) { try { opts.onSwitch(next, cls) } catch {} }
      if (opts.onNotice) { try { opts.onNotice(cls.limited ? 'limited' : 'unavailable', (choice.model || 'model') + ' — ' + cls.plain) } catch {} }
      choice = { provider: next.provider, model: next.model, id: next.id, local: next.local }
      settings.model = next.model
      settings.provider = next.provider
    }

    if (!res.ok && (NET_ERR.test(res.text || '') || health.classifyFailure(res.text).limited)) {
      /* Last resort before the offline path: the local FreeLLMAPI aggregator.
         It has no tools, but a plain answer beats "no answer". */
      try {
        const direct = require('./lib/direct')
        const d = await direct.chat([
          { role: 'system', content: 'You are Jarvis, a concise personal assistant on the user machine. Answer directly.' },
          { role: 'user', content: text },
        ], { model: process.env.JARVIS_DIRECT_MODEL || 'auto' })
        health.recordModel({ provider: 'freellmapi', model: d.model || 'auto', ok: d.ok, secs: d.secs, status: d.ok ? 'ok' : 'failed', error: d.ok ? undefined : d.error })
        if (d.ok) {
          res = { ok: true, text: d.text, via: 'freellmapi', model: d.model }
          if (opts.onNotice) { try { opts.onNotice('switched', 'answered through FreeLLMAPI (' + d.model + ')') } catch {} }
        }
      } catch {}
    }

    if (!res.ok && NET_ERR.test(res.text || '')) {
      const local = await offlineAnswer(text)
      res = local.ok ? local : { ...res, text: res.text + '\n(Local fallback also unavailable.)' }
    }
    if (learned.length) res.learned = learned

    if (res.ok && !res.stopped) {
      clearHandoff()
      if (fast && res.text && res.text.length < 2000 && !res.via) replySet(replyKey(text), res.text)
      turnCount++
      try {
        session.append('default', 'you', text)
        session.append('default', 'jarvis', res.text)
      } catch {}

      if (turnCount % LEARN_EVERY === 0 && !pendingLearn) {
        pendingLearn = learner.learnFacts(text, res.text)
          .then((facts) => {
            if (facts && facts.length && opts.onLearn) { try { opts.onLearn(facts) } catch {} }
            return facts
          })
          .catch(() => [])
          .finally(() => { pendingLearn = null })
      }

      if (turnCount % SUMMARISE_EVERY === 0) session.summarise('default').catch(() => {})
    }
    return res
  }
  const p = chain.then(task, task)
  chain = p.catch(() => {})
  return p
}

/** One cheap probe of the model a turn would use now. */
async function selfCheck() {
  const choice = pickChoice()
  const entry = models.status().find((r) => r.model === choice.model && r.provider === choice.provider) ||
    { provider: choice.provider, model: choice.model, local: choice.local }
  if (!entry.model) return { ok: false, error: 'no model configured' }
  const r = await models.probe(entry, { timeout: 45000 })
  return { ok: r.ok, model: entry.model, provider: entry.provider, secs: r.secs, text: String(r.text || '').slice(0, 120) }
}

module.exports = {
  ask,
  cancel,
  settings,
  session,
  learner,
  ollama,
  whenLearned: () => pendingLearn || Promise.resolve([]),
  resetSession,
  getSessionId: () => sessionId,
  pickChoice,
  selfCheck,
  recycle,
  HERMES_EXE,
  _internals: { parseAnswer, stripAnsi, buildPrompt },
}
