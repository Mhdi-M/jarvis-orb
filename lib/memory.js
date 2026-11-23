'use strict'
/** Local personal memory. Plain JSON on disk, nothing leaves the machine. */
const fs = require('fs')
const path = require('path')

const FILE = process.env.JARVIS_MEMORY_FILE || path.join(__dirname, '..', 'data', 'memory.json')
const MAX_FACTS = 500
const SECRET = /(password|passwd|pwd|api[_ -]?key|secret|token|bearer|authorization|private[_ -]?key|card number|cvv|iban|otp|2fa)\s*[:=]?\s*\S+|\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+\/_-]{40,}={0,2}|\b(?:\d[ -]?){13,19}\b|-----BEGIN [A-Z ]*PRIVATE KEY/i

let state = null
function load() {
  if (state) return state
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { state = { enabled: true, facts: [] } }
  if (!Array.isArray(state.facts)) state.facts = []
  return state
}
function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.unlinkSync(tmp) } catch {} }
}
function save() { writeAtomic(FILE, JSON.stringify(state, null, 2)) }

/** Pull "remember ..." / "my name is ..." style facts out of what the user said. */
function extract(text) {
  const t = String(text || '').trim()
  if (!t || SECRET.test(t)) return []
  const out = []
  let m
  if ((m = t.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.{3,200})$/i))) out.push(m[1].trim())
  if ((m = t.match(/\bmy name is\s+([A-Za-z][\w .'-]{1,40})/i))) out.push(`User's name is ${m[1].trim()}`)
  if ((m = t.match(/\bi (?:prefer|like|love|hate|use)\s+(.{2,80}?)[.!?]?$/i))) out.push(`User ${/prefer/i.test(t) ? 'prefers' : 'mentioned'} ${m[1].trim()}`)
  return out
}

function add(fact) {
  const s = load()
  const f = String(fact || '').trim()
  if (!s.enabled || !f || SECRET.test(f)) return false
  if (s.facts.some((x) => x.text.toLowerCase() === f.toLowerCase())) return false
  s.facts.push({ text: f, at: Date.now() })
  if (s.facts.length > MAX_FACTS) s.facts.splice(0, s.facts.length - MAX_FACTS)
  save()
  return true
}
function learnFrom(text) { return extract(text).filter(add) }

const words = (s) => String(s).toLowerCase().match(/[a-z0-9\u0600-\u06ff]{3,}/g) || []
function recall(query, limit = 5) {
  if (!load().enabled) return []
  const q = new Set(words(query))
  return load().facts
    .map((f) => ({ f, score: words(f.text).filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.f.at - a.f.at)
    .slice(0, limit).map((x) => x.f.text)
}
function context(query) {
  if (!load().enabled) return ''
  const hits = recall(query)
  return hits.length ? 'Known about the user:\n- ' + hits.join('\n- ') : ''
}
function forget(match) {
  const s = load(); const before = s.facts.length
  s.facts = match ? s.facts.filter((f) => !f.text.toLowerCase().includes(String(match).toLowerCase())) : []
  save(); return before - s.facts.length
}
function setEnabled(v) { load().enabled = !!v; save(); return state.enabled }
function list() { return load().facts.map((f) => f.text) }
function _reset() { state = null }
module.exports = { add, learnFrom, recall, context, forget, setEnabled, list, extract, _reset, isEnabled: () => load().enabled }
