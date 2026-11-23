/* World-clock helpers for the notch clock widget — pure, so they are testable. */

export const PRESETS = [
  { tz: 'Asia/Tehran', label: 'Tehran' },
  { tz: 'Asia/Dubai', label: 'Dubai' },
  { tz: 'Asia/Kolkata', label: 'Mumbai' },
  { tz: 'Asia/Shanghai', label: 'Shanghai' },
  { tz: 'Asia/Tokyo', label: 'Tokyo' },
  { tz: 'Europe/Berlin', label: 'Berlin' },
  { tz: 'Europe/Rome', label: 'Milan' },
  { tz: 'Europe/London', label: 'London' },
  { tz: 'America/New_York', label: 'New York' },
  { tz: 'America/Los_Angeles', label: 'Los Angeles' },
  { tz: 'Australia/Sydney', label: 'Sydney' },
]

export const MAX_ZONES = 4

export function isValidZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  if (tz !== 'UTC' && !tz.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function zoneParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const out = {}
  for (const p of parts) out[p.type] = p.value
  return out
}

/** "14:05" for the given zone, or '--:--' when the zone is unusable. */
export function zoneTime(date, tz) {
  if (!isValidZone(tz)) return '--:--'
  const p = zoneParts(date, tz)
  return `${p.hour}:${p.minute}`
}

/** Whole days the zone's calendar is ahead of the reference zone (default: local). */
export function dayOffset(date, tz, refTz = undefined) {
  if (!isValidZone(tz)) return 0
  const a = zoneParts(date, tz)
  const b = refTz && isValidZone(refTz)
    ? zoneParts(date, refTz)
    : { year: String(date.getFullYear()), month: String(date.getMonth() + 1).padStart(2, '0'), day: String(date.getDate()).padStart(2, '0') }
  const da = Date.UTC(Number(a.year), Number(a.month) - 1, Number(a.day))
  const db = Date.UTC(Number(b.year), Number(b.month) - 1, Number(b.day))
  return Math.round((da - db) / 86400000)
}

export function labelFor(tz) {
  const preset = PRESETS.find((p) => p.tz === tz)
  if (preset) return preset.label
  const city = String(tz || '').split('/').pop() || tz
  return city.replace(/_/g, ' ')
}

export function addZone(list, tz, max = MAX_ZONES) {
  const base = Array.isArray(list) ? list.filter(isValidZone) : []
  if (!isValidZone(tz)) return base
  if (base.includes(tz)) return base
  const next = [...base, tz]
  return next.slice(Math.max(0, next.length - max))
}

export function removeZone(list, tz) {
  return Array.isArray(list) ? list.filter((z) => z !== tz && isValidZone(z)) : []
}

/** Anything read back from storage may be junk — clean it. */
export function normalizeZones(raw, max = MAX_ZONES) {
  let arr = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { arr = [] }
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const z of arr) {
    if (isValidZone(z) && !out.includes(z)) out.push(z)
    if (out.length >= max) break
  }
  return out
}
