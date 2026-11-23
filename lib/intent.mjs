/**
 * Instant local intent router.
 *
 * The Hermes agent turn costs seconds. Anything this module can resolve is
 * answered locally in a few milliseconds, so the terminal feels immediate.
 *
 * Deliberately conservative: it only claims input that is unambiguous —
 * a known app alias, a bare domain/URL, or an explicit `run`/`read` verb with
 * a short payload. Everything else falls through to the agent.
 */

const APPS = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  calculator: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  files: 'explorer.exe',
  'file explorer': 'explorer.exe',
  cmd: 'cmd.exe',
  command: 'cmd.exe',
  terminal: 'wt.exe',
  powershell: 'powershell.exe',
  'task manager': 'taskmgr.exe',
  taskmgr: 'taskmgr.exe',
  settings: 'ms-settings:',
  'control panel': 'control.exe',
  vscode: 'code',
  code: 'code',
  chrome: 'chrome',
  edge: 'msedge',
  firefox: 'firefox',
  spotify: 'spotify:',
  discord: 'discord:',
  steam: 'steam:',
  slack: 'slack:',
  telegram: 'tg://',
  whatsapp: 'whatsapp:',
  snipping: 'ms-screenclip:',
  camera: 'microsoft.windows.camera:',
  store: 'ms-windows-store:',
  mail: 'outlookmail:',
  photos: 'ms-photos:',
  clock: 'ms-clock:',
  recycle: 'shell:RecycleBinFolder',
  downloads: 'shell:Downloads',
  documents: 'shell:Personal',
  pictures: 'shell:Pictures',
  desktop: 'shell:Desktop',
}

const URL_RE = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/i

/** True when `s` is a bare domain or full URL rather than an app name. */
export function looksLikeUrl(s) {
  if (typeof s !== 'string') return false
  const v = s.trim()
  if (!v) return false
  if (/\s/.test(v)) return false // a sentence, not an address
  if (/^https?:\/\//i.test(v)) return true
  return URL_RE.test(v)
}

export function normalizeUrl(s) {
  const v = String(s || '').trim()
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

export function resolveApp(name) {
  if (typeof name !== 'string') return null
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!key) return null
  if (APPS[key]) return APPS[key]
  // "open the calculator" → strip articles
  const stripped = key.replace(/^(the|my|a)\s+/, '').replace(/\s+(app|application|window)$/, '')
  if (APPS[stripped]) return APPS[stripped]
  return null
}

const VERB = /^(?:please\s+)?(open|launch|start|run|execute|read|fetch|summarize|open up)\s+(.+)$/i

/**
 * @returns {null | {kind:'app'|'url'|'run'|'read', target:string, label:string}}
 */
export function parseIntent(text) {
  if (typeof text !== 'string') return null
  const raw = text.trim().replace(/[.!?]+$/, '')
  if (!raw || raw.length > 120) return null
  if (raw.startsWith('/')) return null // slash commands are handled elsewhere

  // -------- bare domain / url -------------------------------------------
  if (looksLikeUrl(raw)) {
    return { kind: 'url', target: normalizeUrl(raw), label: raw }
  }

  const m = raw.match(VERB)
  if (!m) return null
  const verb = m[1].toLowerCase()
  const rest = m[2].trim().replace(/^["'`]|["'`]$/g, '')

  if (!rest) return null

  // -------- read / summarize a page --------------------------------------
  if (verb === 'read' || verb === 'fetch' || verb === 'summarize') {
    /* "read example.com and summarize it" — the address is inside the phrase */
    const found = rest.match(/((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?)/i)
    const addr = found ? found[1] : (looksLikeUrl(rest) ? rest : '')
    if (!addr) return null
    const wants = verb === 'summarize' || /\b(summari[sz]e|summary|explain|what(?:'s| is) it about|brief|tl;?dr|key points)\b/i.test(raw)
    return { kind: 'read', target: normalizeUrl(addr), label: addr, summarize: wants }
  }

  // -------- explicit shell -------------------------------------------------
  if (verb === 'run' || verb === 'execute') {
    return { kind: 'run', target: rest, label: rest }
  }

  // -------- open something ------------------------------------------------
  if (looksLikeUrl(rest)) {
    return { kind: 'url', target: normalizeUrl(rest), label: rest }
  }

  const app = resolveApp(rest)
  if (app) return { kind: 'app', target: app, label: rest }

  // an explicit path is an app too
  if (/^[a-z]:[\\/]/i.test(rest) || /^%[a-z]+%/i.test(rest)) {
    return { kind: 'app', target: rest, label: rest }
  }

  // "open downloads folder"
  if (/^(downloads|documents|pictures|desktop|recycle)\s+(folder|bin)?$/i.test(rest)) {
    const a = resolveApp(rest.split(/\s+/)[0])
    if (a) return { kind: 'app', target: a, label: rest }
  }

  return null
}

/** One-line status text for the transcript. */
export function intentLine(intent, res) {
  const ok = res && res.ok !== false
  const detail = res && res.text ? String(res.text).trim() : ''
  if (!intent) return ''
  switch (intent.kind) {
    case 'app': return ok ? `\u2192 launched ${intent.label}` : `\u2717 could not launch ${intent.label}`
    case 'url': return ok ? `\u2192 opened ${intent.label}` : `\u2717 could not open ${intent.label}`
    case 'run': return ok ? `\u2192 ran ${intent.label}` : `\u2717 ${detail || 'command failed'}`
    case 'read': return ok ? `\u2192 read ${intent.label}` : `\u2717 ${detail || 'could not read'}`
    default: return detail
  }
}

export const _internals = { APPS, URL_RE, VERB }
