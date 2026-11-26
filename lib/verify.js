'use strict'
/**
 * Answer verification — the manager checking the answer, not just accepting it.
 *
 * Two layers, in order of cost:
 *   1. deterministic: arithmetic in the question is recomputed locally, JSON is
 *      parsed, numbers in a "= X" claim are checked. Free and instant.
 *   2. cross-check (opt-in): a second model is asked whether the answer is
 *      correct, capped and cached. Off unless JARVIS_VERIFY=cross.
 *
 * A failed check never silently replaces the answer: it is reported with the
 * correct value, so the user sees the disagreement.
 */
const crypto = require('crypto')
const quality = require('./quality')

const OP = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, 'x': (a, b) => a * b, '×': (a, b) => a * b, '/': (a, b) => (b === 0 ? NaN : a / b) }

/** Pure: simple arithmetic expressions present in a question. */
function expressions(text) {
  const out = []
  const re = /(-?\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(-?\d+(?:\.\d+)?)/g
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push({ a: Number(m[1]), op: m[2], b: Number(m[3]), raw: m[0] })
  }
  const pct = String(text || '').match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i)
  if (pct) out.push({ a: Number(pct[1]), op: '%', b: Number(pct[2]), raw: pct[0] })
  return out
}

const compute = (e) => (e.op === '%' ? (e.a / 100) * e.b : (OP[e.op] || (() => NaN))(e.a, e.b))
const fmt = (n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(Math.round(n * 1000) / 1000))

/** Pure: numbers the answer claims, including "= 391" forms. */
function claimedNumbers(answer) {
  const out = []
  const eq = String(answer || '').match(/=\s*(-?\d+(?:\.\d+)?)/g) || []
  for (const s of eq) out.push(Number(s.replace(/=\s*/, '')))
  return out
}

/**
 * verdict(task, answer) -> {ok, checked, reason?, wrong?, right?}
 * Deterministic only; no model call.
 */
function verdict(task, answer) {
  const q = quality.assess(answer, { prompt: task })
  if (!q.ok) return { ok: false, checked: true, reason: q.reason }

  const exprs = expressions(task)
  if (exprs.length) {
    for (const e of exprs) {
      const right = compute(e)
      if (!Number.isFinite(right)) continue
      const claims = claimedNumbers(answer)
      if (claims.length) {
        const hit = claims.some((c) => Math.abs(c - right) < 1e-6)
        if (!hit) {
          return { ok: false, checked: true, reason: 'arithmetic mismatch on ' + e.raw, wrong: claims[0], right }
        }
      } else {
        /* no "= X" claim: the correct value must appear somewhere */
        const nums = (String(answer).match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
        if (nums.length && !nums.some((n) => Math.abs(n - right) < 1e-6)) {
          return { ok: false, checked: true, reason: 'the answer never states ' + e.raw + ' = ' + fmt(right), right }
        }
      }
    }
  }

  const wantsJson = /\bjson\b/i.test(task)
  if (wantsJson) {
    try { JSON.parse(String(answer).replace(/^```(?:json)?|```$/g, '').trim()) } catch {
      return { ok: false, checked: true, reason: 'the answer was asked to be JSON and is not valid JSON' }
    }
  }
  return { ok: true, checked: exprs.length > 0 || wantsJson }
}

/* ------------------------------------------------------- optional cross-check */
const cache = new Map()
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')

function crossEnabled() { return String(process.env.JARVIS_VERIFY || '').toLowerCase() === 'cross' }

async function crossCheck(task, answer, opts = {}) {
  if (!crossEnabled()) return { ok: true, checked: false, skipped: true }
  const key = hash(task + '\u0000' + answer)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value
  const { execFile } = require('child_process')
  const HERMES = require('./hermes-bin').hermesBin()
  const prompt = 'You are a strict answer checker. Question:\n' + task + '\n\nProposed answer:\n' + String(answer).slice(0, 2000) +
    '\n\nIs the answer materially correct and sufficient? Reply JSON only: {"ok":true|false,"reason":"<short>"}'
  const value = await new Promise((resolve) => {
    execFile(HERMES, ['-z', prompt, '-m', opts.model || 'gemini-3.6-flash', '--provider', opts.provider || 'gemini'],
      { windowsHide: true, timeout: 45000, maxBuffer: 1 << 20 }, (err, stdout) => {
        const t = String(stdout || '').trim()
        const m = t.match(/\{[\s\S]*\}/)
        if (m) { try { const j = JSON.parse(m[0]); return resolve({ ok: j.ok === true, reason: j.reason || '', checked: true }) } catch {} }
        resolve({ ok: true, checked: false, reason: err ? err.message : 'unreadable verdict' })
      })
  })
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 100) cache.delete(cache.keys().next().value)
  return value
}

module.exports = { verdict, crossCheck, expressions, claimedNumbers, compute, crossEnabled }
