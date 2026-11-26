'use strict'
/**
 * Alerts — the one place that decides when the user is told something, and
 * whether it is worth a Windows notification or just a line in the transcript.
 *
 * Rules: a quota/unavailable event is always surfaced in the TUI; the toast is
 * throttled per key so a chain of five failing models does not stack five
 * balloons. Everything raised is also written to the security audit log,
 * because "the model went away" is an incident worth being able to review.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const DIR = path.join(__dirname, '..', 'data')
const LOG = path.join(DIR, 'alerts.jsonl')
const THROTTLE_MS = 5 * 60 * 1000
const last = new Map()

const TOAST = path.join(__dirname, '..', 'tools', 'toast.ps1')

function enabled() {
  if (process.env.JARVIS_ALERTS === 'off') return false
  return true
}

/** Pure: the toast payload, kept short enough for a balloon. */
function payload(kind, detail, extra = {}) {
  const titles = {
    limited: 'Jarvis — model limit',
    unavailable: 'Jarvis — model unavailable',
    agent: 'Jarvis — agent failed',
    switched: 'Jarvis — switched model',
    junk: 'Jarvis — answer rejected',
    security: 'Jarvis — security',
    ok: 'Jarvis',
  }
  const title = titles[kind] || 'Jarvis'
  const message = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 220)
  return { kind, title, message, ...extra }
}

/** Pure: throttle key + clock, testable without the process. */
function shouldFire(key, now = Date.now(), windowMs = THROTTLE_MS) {
  const prev = last.get(key) || 0
  return now - prev >= windowMs
}

function markFired(key, now = Date.now()) { last.set(key, now) }

function toast(p) {
  if (!enabled()) return false
  try {
    const child = execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST,
      '-Title', p.title, '-Message', p.message], { windowsHide: true }, () => {})
    if (child.unref) child.unref()
    return true
  } catch { return false }
}

function log(p, fired) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...p, toasted: !!fired }) + '\n')
  } catch {}
}

/**
 * raise('limited', 'deepseek … 429') -> { shown, toasted, payload }
 * key defaults to kind+message so repeats of the same incident stay quiet.
 */
function raise(kind, detail, opts = {}) {
  const p = payload(kind, detail, opts.extra || {})
  const key = opts.key || kind + '|' + p.message.slice(0, 80)
  const fire = opts.force === true || shouldFire(key)
  if (fire) markFired(key)
  const toasted = fire && opts.toast !== false ? toast(p) : false
  log(p, toasted)
  return { shown: true, toasted, payload: p, throttled: !fire }
}

function test() {
  return raise('ok', 'Notifications are working — this is a test.', { force: true, key: 'test' })
}

function recent(n = 20) {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l))
  } catch { return [] }
}

function _reset() { last.clear() }

module.exports = { raise, payload, shouldFire, markFired, test, recent, enabled, _reset, LOG, THROTTLE_MS }
