'use strict'
/**
 * Quality gate — keeps junk out of the transcript.
 *
 * A model that is rate-limited, misconfigured or simply broken still exits 0
 * sometimes and hands back a stack trace, an HTML error page, a JSON error
 * object or an empty string. Printing that as JARVIS's answer is what makes an
 * assistant feel broken. This module decides whether text is an answer, and
 * turns a failure into one plain sentence plus what to do next.
 */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

const PATTERNS = [
  { kind: 'stack', re: /\n\s*at\s+[\w$.<>]+\s*\(|Traceback \(most recent call last\)|File ".*", line \d+/i },
  { kind: 'http', re: /^\s*(?:HTTP\s*)?(?:4\d\d|5\d\d)\s*(?:error|[-:])|error code:?\s*(?:4\d\d|5\d\d)/i },
  { kind: 'json_error', re: /^\s*\{\s*"(?:error|detail|message)"\s*:/i },
  { kind: 'html', re: /^\s*<!doctype html|^\s*<html[\s>]/i },
  { kind: 'shell', re: /command not found|is not recognized as an internal|No such file or directory|\$ .+\n/i },
  { kind: 'provider', re: /rate.?limit|quota exceeded|insufficient (?:quota|balance)|invalid api key|no such model|service unavailable|overloaded|econnrefused|enotfound|etimedout/i },
]

/** Pure: strip control codes and surrounding noise without touching real text. */
function clean(text) {
  return String(text == null ? '' : text)
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(/^\s*(?:assistant|jarvis)\s*:\s*/i, '')
    .trim()
}

/** Pure: is this an actual answer rather than an error, an echo or a stub? */
function assess(text, opts = {}) {
  const raw = clean(text)
  if (!raw) return { ok: false, kind: 'empty', reason: 'nothing came back' }
  if (raw.length < 2) return { ok: false, kind: 'stub', reason: 'only ' + raw.length + ' character came back' }
  if (!/[\p{L}\p{N}]/u.test(raw)) return { ok: false, kind: 'noise', reason: 'no words in the reply' }

  for (const p of PATTERNS) {
    if (p.re.test(raw)) {
      /* a real answer may quote an error; only reject when it IS the error */
      const firstLine = raw.split('\n')[0].trim()
      const wholeLooks = raw.length < 600 || p.re.test(firstLine)
      if (wholeLooks) return { ok: false, kind: p.kind, reason: 'the reply is an error message, not an answer' }
    }
  }

  const words = raw.split(/\s+/)
  if (words.length > 8 && new Set(words.map((w) => w.toLowerCase())).size <= 2) {
    return { ok: false, kind: 'loop', reason: 'the reply repeats itself instead of answering' }
  }
  if (opts.prompt) {
    const a = raw.toLowerCase().replace(/\s+/g, ' ')
    const b = String(opts.prompt).toLowerCase().replace(/\s+/g, ' ').slice(0, 160)
    if (b.length > 12 && a === b) return { ok: false, kind: 'echo', reason: 'the reply is just the question echoed back' }
  }
  return { ok: true, kind: 'answer', text: raw }
}

const HINTS = {
  rate_limit: 'The provider has hit its rate or quota limit. Jarvis can switch model — try again, or run /models.',
  context: 'The conversation outgrew the context window. Jarvis recycles it with a summary — ask again.',
  auth: 'The provider rejected the API key. Fix the key in the Hermes .env, then run /heal.',
  model: 'That model name does not exist on the provider. Run /models to pick a real one.',
  network: 'The provider could not be reached. Check the connection (or the tunnel), then run /heal.',
  overloaded: 'The provider is overloaded. Jarvis will try the next model in the chain.',
  empty: 'The model returned nothing. Jarvis will try the next model in the chain.',
  unknown: 'The model failed. Jarvis will try the next model in the chain.',
}

/** Pure: one plain sentence + a next action, for a failed turn. */
function describeFailure(text, kind) {
  const k = kind || require('./health').classifyFailure(text).kind
  return {
    kind: k,
    headline: 'No answer — ' + (HINTS[k] || HINTS.unknown).replace(/^The /, 'the '),
    hint: HINTS[k] || HINTS.unknown,
    detail: clean(text).split('\n').slice(0, 3).join(' ').slice(0, 240),
  }
}

module.exports = { clean, assess, describeFailure, PATTERNS }
