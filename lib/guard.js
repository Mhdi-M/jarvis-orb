'use strict'
/**
 * Approval guard. Decides whether a request would ACT on the PC for the user
 * (type, click, send, delete, install, pay, schedule). Such requests are held
 * until the user taps Approve. Pure, so it is testable.
 */
const ACTION = [
  /\b(type|write|paste)\b.*\b(for me|into|in the|on my)\b/i,
  /\btype (this|that|it|for me)\b/i,
  /\b(click|press|tap|double.?click)\b/i,
  /\b(send|reply|answer|respond)\b.*\b(message|mail|email|dm|text|him|her|them)\b/i,
  /\b(delete|remove|erase|uninstall|format|wipe)\b/i,
  /\b(install|download|update|upgrade)\b/i,
  /\b(buy|pay|purchase|order|transfer)\b/i,
  /\b(shut ?down|restart|reboot|log ?off|sleep|hibernate)\b/i,
  /\b(close|kill|quit|stop)\s+(?:the\s+)?[\w .+-]{1,40}$/i,
  /\b(schedule|every day|every morning|remind me)\b/i,
]
const SAFE = [/^\s*(what|how|why|who|when|where|is|are|does|do|can you explain|explain|summari[sz]e|show|check|tell|list|read)\b/i]

/** @returns {{needsApproval:boolean, reason:string}} */
function review(text) {
  const t = String(text || '').trim()
  if (!t) return { needsApproval: false, reason: '' }
  // Questions and explanations never act. Imperative verbs ("delete x") do.
  if (SAFE.some((r) => r.test(t)) || /\?\s*$/.test(t)) return { needsApproval: false, reason: '' }
  const hit = ACTION.find((r) => r.test(t))
  return hit ? { needsApproval: true, reason: 'This would act on your PC for you.' } : { needsApproval: false, reason: '' }
}
module.exports = { review }
