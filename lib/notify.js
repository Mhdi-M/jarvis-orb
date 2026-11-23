'use strict'
/* Notch notification helpers — pure, so they can be unit tested. */

const KINDS = ['copy', 'shot', 'music', 'info']

/** Collapse whitespace and trim to a single readable line. */
function clipDetail(text, max = 80) {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return one.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'info'
}

/** Build the payload the notch toast consumes. */
function notifyPayload(kind, title, detail, max = 80) {
  return { kind: normalizeKind(kind), title: String(title || ''), detail: clipDetail(detail, max) }
}

/** Only real screenshot-looking files should raise a screenshot toast. */
function looksLikeScreenshot(file, loose = false) {
  if (typeof file !== 'string') return false
  if (!/\.(png|jpe?g)$/i.test(file)) return false
  if (loose) return true
  return /screen|snip|capture/i.test(file)
}

module.exports = { KINDS, clipDetail, normalizeKind, notifyPayload, looksLikeScreenshot }
