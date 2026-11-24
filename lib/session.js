'use strict'
/**
 * Session memory — what happened in this conversation, kept as a rolling
 * summary written by the local model.
 *
 * The point is continuity without replay: instead of resuming a 40k-token
 * Hermes session (slow), Jarvis carries "session so far" as a few lines and
 * starts clean whenever the context gets heavy.
 */
const fs = require('fs')
const path = require('path')
const ollama = require('./ollama')

const DIR = process.env.JARVIS_SESSIONS_DIR || path.join(__dirname, '..', 'data', 'sessions')
const MAX_LINES = 25

function ensure() { try { fs.mkdirSync(DIR, { recursive: true }) } catch {} }
const file = (name) => path.join(DIR, String(name || 'default').replace(/[^a-z0-9._-]/gi, '_') + '.json')

function load(name) {
  ensure()
  try {
    const j = JSON.parse(fs.readFileSync(file(name), 'utf8'))
    if (j && typeof j === 'object') return { name, summary: '', turns: [], facts: [], updated: 0, ...j }
  } catch {}
  return { name, summary: '', turns: [], facts: [], updated: 0 }
}

function save(state) {
  ensure()
  state.updated = Date.now()
  if (state.turns && state.turns.length > MAX_LINES) state.turns = state.turns.slice(-MAX_LINES)
  try { fs.writeFileSync(file(state.name), JSON.stringify(state, null, 2)) } catch {}
  return state
}

/** Record one exchange (cheap, synchronous, no model). */
function append(name, role, text) {
  const s = load(name)
  const t = String(text || '').trim()
  if (!t) return s
  s.turns.push({ role, text: t.slice(0, 1200), at: Date.now() })
  return save(s)
}

/** Rewrite the summary with the local model. Returns the new summary. */
async function summarise(name, opts = {}) {
  const s = load(name)
  if (!s.turns.length) return ''
  const transcript = s.turns.slice(-MAX_LINES).map((t) => (t.role === 'you' ? 'Me' : 'Jarvis') + ': ' + t.text).join('\n')
  const prompt =
    'Summarise this session for later reference. Keep only what matters: what the user wanted, what was decided or built, ' +
    'any preference or constraint they stated, and anything still open. Max 6 short bullet lines, no preamble.\n\n' +
    (s.summary ? 'Earlier summary:\n' + s.summary + '\n\n' : '') + 'Recent turns:\n' + transcript
  let summary = ''
  try {
    summary = await ollama.generate(prompt, { maxTokens: 260, temperature: 0.2, timeout: opts.timeout || 90000 })
  } catch (e) {
    return s.summary
  }
  if (summary) { s.summary = summary; save(s) }
  return s.summary
}

/** Prompt block for continuity. */
function context(name) {
  const s = load(name)
  if (!s.summary) return ''
  return 'Session so far (from my own notes, not something you told me now):\n' + s.summary
}

function reset(name) {
  const s = load(name)
  const fresh = { name: s.name, summary: '', turns: [], facts: [], updated: Date.now() }
  save(fresh)
  return fresh
}

function list() {
  ensure()
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try { const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { name: j.name, updated: j.updated, summary: (j.summary || '').slice(0, 80) } } catch { return null }
    }).filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0))
  } catch { return [] }
}

module.exports = { append, summarise, context, reset, load, save, list, DIR }
