/**
 * Reminder + timer parsing. Pure, so the phrasing can be unit-tested.
 *
 *   "remind me in 10 minutes to drink water"
 *   "remind me at 18:30 to call mom"
 *   "timer 5 min"
 *   "remind me tomorrow at 9 to send the report"
 */

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
}

const MAX_AHEAD_MS = 30 * 86400000 // a month is plenty

const RELATIVE = /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i
const CLOCK = /\b(?:at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const DAYWORD = /\b(today|tonight|tomorrow|morning|afternoon|evening)\b/i
const REMIND = /\b(?:remind(?:\s+me)?|reminder|timer|alarm)\b/i
const NOTE = /\b(?:note|remember|save)\b/i

function cleanTask(raw) {
  let t = String(raw || '').trim()
  // strip the leading command scaffolding
  t = t.replace(/^(?:please\s+)?(?:remind\s+me|reminder|timer|alarm|set\s+a\s+(?:timer|reminder))\b/i, '')
  t = t.replace(/\b(?:in|after)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i, '')
  t = t.replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '')
  t = t.replace(/\b(?:today|tonight|tomorrow|morning|afternoon|evening)\b/i, '')
  t = t.replace(/^[\s,;:\-–]+/, '')
  t = t.replace(/^(?:to|that|about)\s+/i, '')
  t = t.replace(/[\s,;:\-–]+$/, '')
  return t.trim()
}

/**
 * @param {string} text
 * @param {Date} [now]
 * @returns {null | {kind:'timer'|'reminder', at:number, inMs:number, task:string, when:string}}
 */
export function parseReminder(text, now = new Date()) {
  if (typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw || raw.length > 200) return null
  if (!REMIND.test(raw)) return null

  const base = now.getTime()
  let at = null

  const rel = raw.match(RELATIVE)
  if (rel) {
    const n = parseFloat(rel[1])
    const unit = UNIT_MS[rel[2].toLowerCase()]
    if (Number.isFinite(n) && unit) at = base + Math.round(n * unit)
  }

  /* "timer 5 min" / "alarm 30 seconds" have no in/after preposition */
  if (at === null && /\b(?:timer|alarm)\b/i.test(raw)) {
    const bare = raw.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i)
    if (bare) {
      const n = parseFloat(bare[1])
      const unit = UNIT_MS[bare[2].toLowerCase()]
      if (Number.isFinite(n) && unit) at = base + Math.round(n * unit)
    }
  }

  if (at === null) {
    const clock = raw.match(CLOCK)
    if (clock) {
      let h = parseInt(clock[1], 10)
      const m = clock[2] ? parseInt(clock[2], 10) : 0
      const ampm = (clock[3] || '').toLowerCase()
      if (ampm === 'pm' && h < 12) h += 12
      if (ampm === 'am' && h === 12) h = 0
      if (h > 23 || m > 59) return null
      const d = new Date(base)
      const dayWord = (raw.match(DAYWORD) || [])[1]?.toLowerCase()
      if (dayWord === 'tomorrow') d.setDate(d.getDate() + 1)
      d.setHours(h, m, 0, 0)
      at = d.getTime()
      // "at 9" said at 20:00 means tomorrow 9
      if (at <= base) at += 86400000
      if (dayWord === 'morning' && h > 12) return null
    }
  }

  if (at === null) return null
  const inMs = at - base
  if (inMs < 1000 || inMs > MAX_AHEAD_MS) return null

  const task = cleanTask(raw)
  const kind = /\b(?:timer|alarm)\b/i.test(raw) && !/\bremind\b/i.test(raw) ? 'timer' : 'reminder'
  return { kind, at, inMs, task: task || (kind === 'timer' ? 'timer done' : 'reminder'), when: whenLabel(at, now) }
}

/** "in 10 minutes" / "tomorrow 18:30" — short and readable. */
export function whenLabel(at, now = new Date()) {
  const d = new Date(at)
  const ms = at - now.getTime()
  if (ms < 60000) return 'in under a minute'
  if (ms < 3600000) return `in ${Math.round(ms / 60000)} min`
  const sameDay = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  if (tomorrow) return `tomorrow ${hh}:${mm}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${hh}:${mm}`
}

/** Does this look like a note? "note: buy milk" / "remember that X". */
export function parseNote(text) {
  if (typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw || raw.length > 400) return null
  /* only "note: ..." — "remember that ..." belongs to the memory layer */
  const m = raw.match(/^note\s*[:\-]\s*(.+)$/i)
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  if (REMIND.test(raw)) return null // reminders win
  return { text: body }
}

export const _internals = { UNIT_MS, MAX_AHEAD_MS, cleanTask }
