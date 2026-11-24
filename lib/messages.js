'use strict'
/**
 * What the machine has already been told — Windows keeps every toast in a local
 * SQLite database. That is the one honest way to read messages from WhatsApp,
 * Telegram, Mail, Teams or any other app that raises notifications, without
 * decrypting anyone's database.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const DB_REL = path.join('Microsoft', 'Windows', 'Notifications', 'wpndatabase.db')

function dbPath() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), DB_REL)
}

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pull the visible text nodes out of a toast payload. */
function parseToast(xml) {
  const text = String(xml || '')
  const out = []
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const t = decode(m[1])
    if (t) out.push(t)
  }
  return { title: out[0] || '', body: out.slice(1).join(' · ') }
}

/** "Microsoft.WindowsStore_8wekyb3d8bbwe!App" → "Microsoft Store"ish name. */
function appName(primaryId) {
  const raw = String(primaryId || '')
  if (!raw) return 'system'
  const head = raw.split('!')[0].split('_')[0]
  const known = {
    'Microsoft.Windows.Photos': 'Photos',
    'Microsoft.WindowsStore': 'Store',
    'Microsoft.WindowsTerminal': 'Terminal',
    'Microsoft.YourPhone': 'Phone Link',
    'Microsoft.OutlookForWindows': 'Outlook',
    'Microsoft.Teams': 'Teams',
    'Microsoft.ScreenSketch': 'Snipping Tool',
    'Microsoft.ZuneMusic': 'Media Player',
    'windows.immersivecontrolpanel': 'Settings',
  }
  if (known[head]) return known[head]
  const base = head.split('_')[0].split('.')
  const appPart = base[base.length - 1] || head
  if (/WhatsApp/i.test(raw)) return 'WhatsApp'
  if (/Telegram/i.test(raw)) return 'Telegram'
  if (/Discord/i.test(raw)) return 'Discord'
  if (/Slack/i.test(raw)) return 'Slack'
  if (/Instagram/i.test(raw)) return 'Instagram'
  if (/Spotify/i.test(raw)) return 'Spotify'
  return appPart
}

/**
 * Read the notification database. The live file is locked by Windows, so copy
 * it first — that is why this is safe to call while the system is running.
 */
function readNotifications({ limit = 120 } = {}) {
  let DatabaseSync
  try { ({ DatabaseSync } = require('node:sqlite')) } catch { return { ok: false, error: 'node:sqlite unavailable' } }

  const src = dbPath()
  if (!fs.existsSync(src)) return { ok: false, error: 'no notification database on this machine' }

  const tmp = path.join(os.tmpdir(), 'jarvis-wpnd-' + process.pid + '-' + Date.now() + '.db')
  let db = null
  try {
    fs.copyFileSync(src, tmp)
    db = new DatabaseSync(tmp)
    const handlers = {}
    try {
      for (const h of db.prepare('SELECT RecordId, PrimaryId FROM NotificationHandler').all()) {
        handlers[String(h.RecordId)] = String(h.PrimaryId || '')
      }
    } catch {}

    const rows = db.prepare(
      'SELECT HandlerId, CAST(Payload AS TEXT) AS payload, CAST(ArrivalTime AS TEXT) AS at, CAST(Id AS TEXT) AS id ' +
      'FROM Notification ORDER BY "Order" DESC LIMIT ?'
    ).all(limit)

    const items = []
    for (const r of rows) {
      const { title, body } = parseToast(r.payload)
      if (!title && !body) continue
      items.push({
        app: appName(handlers[String(r.HandlerId)]),
        appId: handlers[String(r.HandlerId)] || '',
        title,
        body,
        at: Number(r.at) ? fileTimeToDate(Number(r.at)).getTime() : null,
      })
    }
    return { ok: true, items }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { db && db.close() } catch {}
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/** WinRT filetime (100ns since 1601) → Date */
function fileTimeToDate(ft) {
  const ms = ft / 10000 - 11644473600000
  return new Date(Number.isFinite(ms) ? ms : Date.now())
}

/** Deep search across everything collected (case + accent insensitive). */
function search(items, term) {
  const q = String(term || '').toLowerCase().trim()
  if (!q) return []
  const words = q.split(/\s+/).filter(Boolean)
  return items
    .map((it) => {
      const hay = `${it.app} ${it.title} ${it.body}`.toLowerCase()
      let score = 0
      for (const w of words) if (hay.includes(w)) score++
      if (hay.includes(q)) score += 2
      return { it, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.it.at || 0) - (a.it.at || 0))
    .map((x) => x.it)
}

/** A compact block the agent can summarise without blowing the context. */
function asText(items, { max = 40, width = 300 } = {}) {
  return items.slice(0, max).map((it) => {
    const when = it.at ? new Date(it.at).toISOString().slice(5, 16).replace('T', ' ') : '--'
    return `${when} [${it.app}] ${it.title}${it.body ? ': ' + it.body.slice(0, width) : ''}`
  }).join('\n')
}

module.exports = { readNotifications, search, asText, parseToast, appName, dbPath }
