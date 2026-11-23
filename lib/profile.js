'use strict'
/** Persistent history + typing style. Survives reboots (JSON on disk). Secrets are never stored. */
const fs = require('fs')
const path = require('path')
const FILE = process.env.JARVIS_PROFILE_FILE || path.join(__dirname, '..', 'data', 'profile.json')
const SECRET = /(password|passwd|pwd|api[_ -]?key|secret|token|bearer|authorization|private[_ -]?key|card number|cvv|iban|otp|2fa)\s*[:=]?\s*\S+|\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+\/_-]{40,}={0,2}|\b(?:\d[ -]?){13,19}\b|-----BEGIN [A-Z ]*PRIVATE KEY/i
let st = null
function load() {
  if (st) return st
  try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { st = {} }
  if (!Array.isArray(st.history)) st.history = []; if (!Array.isArray(st.feedback)) st.feedback = []; st.style = st.style || { n: 0, avgLen: 0, lower: 0, persian: 0, short: 0 }
  return st
}
function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.unlinkSync(tmp) } catch {} }
}
function save() { writeAtomic(FILE, JSON.stringify(st, null, 2)) }

function record(text) {
  const s = load(); const t = String(text || '').trim()
  if (!t || SECRET.test(t)) return
  const k = s.style; k.n++
  const upd = (key, v) => { k[key] = +(k[key] + (v - k[key]) / k.n).toFixed(3) }
  upd('avgLen', t.length); upd('lower', /^[a-z]/.test(t) ? 1 : 0); upd('persian', /[\u0600-\u06ff]/.test(t) ? 1 : 0); upd('short', t.length < 40 ? 1 : 0)
  s.history.push({ t: t.slice(0, 200), at: Date.now() })
  if (s.history.length > 300) s.history.splice(0, s.history.length - 300)
  save()
}
/** Explicit user correction/preference; short, refused on obvious secrets, bounded. */
function recordFeedback(text) {
  const s = load(); const t = String(text || '').trim()
  if (!t || SECRET.test(t)) return false
  s.feedback.push({ t: t.slice(0, 200), at: Date.now() })
  if (s.feedback.length > 50) s.feedback.splice(0, s.feedback.length - 50)
  save(); return true
}
/** Wipe all learned profile data (history, style, feedback) and persist the empty state. */
function clear() {
  st = { history: [], feedback: [], style: { n: 0, avgLen: 0, lower: 0, persian: 0, short: 0 } }
  save()
}
function styleHint() {
  const k = load().style
  if (k.n < 5) return ''
  const bits = []
  bits.push(k.short > 0.6 ? 'writes short messages, keep replies brief' : 'writes detailed messages')
  if (k.persian > 0.3) bits.push('often writes Persian; reply in the language used')
  if (k.lower > 0.7) bits.push('casual lowercase style')
  return 'User style: ' + bits.join('; ') + '.'
}
function recentContext(n = 6) {
  const h = load().history.slice(-n - 1, -1)
  return h.length ? 'Recent things the user asked (for continuity):\n- ' + h.map((x) => x.t).join('\n- ') : ''
}
function _reset() { st = null }
module.exports = { record, recordFeedback, clear, styleHint, recentContext, _reset }
