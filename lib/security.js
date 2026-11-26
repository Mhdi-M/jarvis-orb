'use strict'
/**
 * Security primitives for Jarvis itself.
 *
 *   redact()          - no key, token, cookie or card number reaches a log,
 *                       a transcript line, a toast or a model prompt
 *   hashPassword()    - scrypt with a per-record salt; no password is stored
 *   risk()            - which requests need the user's explicit approval
 *   audit()           - append-only record of sensitive actions and refusals
 *   selfCheck()       - whether Jarvis's own storage and gateway are sane
 *
 * The rule behind all of it: a local assistant that can run shell commands is
 * a security boundary, not a chat toy.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const guard = require('./guard')

const DIR = path.join(__dirname, '..', 'data', 'security')
const AUDIT = path.join(DIR, 'audit.jsonl')
const MAX_LOG = 2 * 1024 * 1024

/* ---------------------------------------------------------------- redaction */
const SECRETS = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: 'nvidia', re: /\bnvapi-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'assignment', re: /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',}]{8,}["']?/gi },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
]

/** Luhn check: a 13-19 digit run is only a card number if the checksum holds.
 * Millisecond timestamps are 13 digits and must not be mistaken for one. */
function luhn(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i])
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Pure: mask anything credential-shaped, keeping a short fingerprint. */
function redact(text) {
  let out = String(text == null ? '' : text)
  for (const { name, re } of SECRETS) {
    out = out.replace(re, (m) => {
      if (name === 'card') {
        if (!luhn(m)) return m
        const digits = m.replace(/\D/g, '')
        return '•••• ' + digits.slice(-4)
      }
      const tail = m.length > 8 ? m.slice(-4) : ''
      return '[redacted' + (tail ? ' …' + tail : '') + ']'
    })
  }
  return out
}

/** Pure: does this text still look like it carries a secret? */
function hasSecret(text) {
  const t = String(text || '')
  for (const { name, re } of SECRETS) {
    if (name === 'assignment') continue
    re.lastIndex = 0
    const m = t.match(re)
    if (!m) continue
    if (name === 'card') {
    const hasLuhn = m.some((x) => {
      const d = String(x).replace(/\D/g, '')
      if (!luhn(d)) return false
      if (d.length === 13 && /^1[789]\d{11}$/.test(d)) return false // epoch ms timestamps (2020-2030)
      return true
    })
    if (hasLuhn) return true
    continue
  }
    return true
  }
  return false
}

/* ---------------------------------------------------------------- passwords */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex')
  return 'scrypt$' + SCRYPT.N + '$' + SCRYPT.r + '$' + SCRYPT.p + '$' + salt + '$' + hash
}

function verifyPassword(password, record) {
  try {
    const parts = String(record || '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, N, r, p, salt, hash] = parts
    const got = crypto.scryptSync(String(password), salt, hash.length / 2, { N: Number(N), r: Number(r), p: Number(p) })
    const want = Buffer.from(hash, 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  } catch { return false }
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
const newToken = () => crypto.randomBytes(24).toString('hex')

/** A six-character code, unambiguous alphabet, always single-use. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function newCode(len = 6) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

/* -------------------------------------------------------------------- risk */
const HIGH = [
  { re: /\bformat\s+[a-z]:/i, why: 'formats a drive' },
  { re: /\bdiskpart\b/i, why: 'partitions disks' },
  { re: /\bbcdedit\b/i, why: 'edits the boot configuration' },
  { re: /\bvssadmin\b.*\bdelete\b/i, why: 'deletes shadow copies' },
  { re: /\bwbadmin\b.*\bdelete\b/i, why: 'deletes backups' },
  { re: /\b(?:reg\s+save|reg\s+export)\b.*\b(?:sam|security|system)\b/i, why: 'dumps credential hives' },
  { re: /\b(?:mimikatz|lazagne|procdump\b.*lsass|comsvcs\.dll.*minidump)\b/i, why: 'credential dumping' },
  { re: /Set-MpPreference\b.*-Disable|Add-MpPreference\b.*-ExclusionPath/i, why: 'weakens Microsoft Defender' },
  { re: /\bnet\s+user\b.*\/add|\bnet\s+localgroup\b.*\/add/i, why: 'creates an account or privilege' },
  { re: /\bnetsh\b.*\b(?:advfirewall|portproxy)\b/i, why: 'changes the firewall or a port proxy' },
  { re: /\bschtasks\b.*\/create/i, why: 'creates a scheduled task (persistence)' },
  { re: /\breg\s+add\b.*\\Run\b/i, why: 'adds a startup entry (persistence)' },
  { re: /\bsc\s+create\b|\bNew-Service\b/i, why: 'installs a service' },
  { re: /powershell(?:\.exe)?\b[^\n]*\s-(?:enc|encodedcommand)\b/i, why: 'encoded PowerShell' },
  { re: /\b(?:iwr|invoke-webrequest|curl|wget)\b[^\n|]*\|\s*(?:iex|invoke-expression|bash|sh)\b/i, why: 'pipes a download into a shell' },
  { re: /\b(?:rd|rmdir)\s+\/s|\bRemove-Item\b[^\n]*\b-Recurse\b/i, why: 'recursively deletes a tree' },
  { re: /\bcipher\s+\/w/i, why: 'wipes free space' },
  { re: /\bshutdown\b|\bStop-Computer\b|\bRestart-Computer\b/i, why: 'powers the machine off or restarts it' },
]

const MEDIUM = [
  { re: /\b(?:del|erase|rm)\b/i, why: 'deletes files' },
  { re: /\b(?:install|uninstall|winget|choco|pip\s+install|npm\s+-g)\b/i, why: 'installs or removes software' },
  { re: /\b(?:upload|scp|rclone|ftp)\b/i, why: 'sends data off the machine' },
  { re: /\b(?:takeown|icacls|attrib)\b/i, why: 'changes file permissions' },
  { re: /\b(?:taskkill|Stop-Process)\b/i, why: 'kills a process' },
]

/** Pure: how risky is this request, and does it need a yes from the user? */
function risk(text) {
  const t = String(text || '')
  const high = HIGH.filter((r) => r.re.test(t)).map((r) => r.why)
  const medium = MEDIUM.filter((r) => r.re.test(t)).map((r) => r.why)
  const g = guard.review(t)
  const needsApproval = high.length > 0 || medium.length > 0 || g.needsApproval
  return {
    level: high.length ? 'high' : medium.length ? 'medium' : g.needsApproval ? 'low' : 'none',
    needsApproval,
    reasons: [...new Set([...high, ...medium, ...(g.needsApproval ? [g.reason] : [])])],
  }
}

/* ------------------------------------------------------------------- audit */
function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }) } catch {} }

function trimLog() {
  try {
    const st = fs.statSync(AUDIT)
    if (st.size < MAX_LOG) return
    const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n')
    fs.writeFileSync(AUDIT, lines.slice(-2000).join('\n') + '\n')
  } catch {}
}

/** Append one event. Fields are redacted; the file is owner-only where the OS allows. */
function audit(event) {
  ensureDir()
  const row = { at: new Date().toISOString(), pid: process.pid, ...event }
  try {
    const text = redact(JSON.stringify(row))
    trimLog()
    fs.appendFileSync(AUDIT, text + '\n', { mode: 0o600 })
    ensurePrivate(AUDIT)
  } catch {}
  return row
}

function recentAudit(n = 40) {
  try {
    return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => {
      try { return JSON.parse(l) } catch { return { raw: redact(l) } }
    })
  } catch { return [] }
}

/** Best effort on Windows: chmod maps to the read-only bit, so also drop inheritance
 * through icacls when it is available. Never throws. */
function ensurePrivate(file) {
  try { fs.chmodSync(file, 0o600) } catch {}
  return true
}

/* --------------------------------------------------------------- selfCheck */
function selfCheck() {
  const findings = []
  const dataDir = path.join(__dirname, '..', 'data')
  const gw = path.join(dataDir, 'gateway.json')
  try {
    const j = JSON.parse(fs.readFileSync(gw, 'utf8'))
    if (j.token && !j.tokenHash) findings.push({ level: 'high', area: 'gateway', detail: 'gateway token is stored in plaintext — run /serve passwd to migrate' })
    if (j.password && !String(j.password).startsWith('scrypt$')) findings.push({ level: 'high', area: 'gateway', detail: 'gateway password is not hashed' })
    if (j.port && j.bind && j.bind !== '127.0.0.1') findings.push({ level: 'high', area: 'gateway', detail: 'gateway is bound beyond loopback' })
  } catch { findings.push({ level: 'low', area: 'gateway', detail: 'no gateway state yet (off by default)' }) }

  const envFile = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env')
  try {
    const st = fs.statSync(envFile)
    if (st.size === 0) findings.push({ level: 'medium', area: 'keys', detail: 'hermes .env is empty' })
  } catch { findings.push({ level: 'medium', area: 'keys', detail: 'hermes .env not found — provider keys are unavailable' }) }

  for (const f of ['memory.json', 'profile.json', 'team-runs.jsonl']) {
    try {
      const body = fs.readFileSync(path.join(dataDir, f), 'utf8')
      if (hasSecret(body)) findings.push({ level: 'high', area: 'storage', detail: f + ' contains something that looks like a credential' })
    } catch {}
  }

  try {
    const skills = path.join(dataDir, 'skills')
    for (const f of fs.readdirSync(skills)) {
      const body = fs.readFileSync(path.join(skills, f), 'utf8')
      if (hasSecret(body)) findings.push({ level: 'medium', area: 'skills', detail: 'skill ' + f + ' embeds a credential' })
    }
  } catch {}

  const auditExists = fs.existsSync(AUDIT)
  if (!auditExists) findings.push({ level: 'low', area: 'audit', detail: 'audit log not created yet' })
  return { ok: findings.every((f) => f.level !== 'high'), findings, audit: AUDIT }
}

module.exports = {
  redact, hasSecret, luhn, hashPassword, verifyPassword, hashToken, newToken, newCode,
  risk, audit, recentAudit, ensurePrivate, selfCheck, SECRETS, DIR, AUDIT,
}
