'use strict'
/**
 * Skills Jarvis writes for itself.
 *
 * A skill is a small markdown file in data/skills — a procedure, a preference,
 * or the way you like something done. Matching skills are injected into the
 * prompt, so the next time the same work comes up it is done your way without
 * being told again.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = process.env.JARVIS_SKILLS_DIR || path.join(__dirname, '..', 'data', 'skills')

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }) } catch {}
}

const slug = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill'

function splitFront(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: String(text) }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: m[2] }
}

/** Write (or overwrite) a skill. */
function save({ name, when = '', body, source = 'learned' }) {
  ensureDir()
  const s = slug(name)
  const file = path.join(DIR, s + '.md')
  const meta = [
    '---',
    `name: ${name}`,
    `when: ${when}`,
    `created: ${new Date().toISOString()}`,
    `source: ${source}`,
    '---',
    '',
  ].join('\n')
  fs.writeFileSync(file, meta + String(body || '').trim() + '\n')
  return { ok: true, file, name: s }
}

function list() {
  ensureDir()
  let names = []
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')) } catch {}
  return names.map((f) => {
    const full = path.join(DIR, f)
    const { meta, body } = splitFront(fs.readFileSync(full, 'utf8'))
    return { name: meta.name || f.replace(/\.md$/, ''), when: meta.when || '', created: meta.created || '', file: full, size: body.length }
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function read(name) {
  ensureDir()
  const file = path.join(DIR, slug(name) + '.md')
  if (!fs.existsSync(file)) return null
  const { meta, body } = splitFront(fs.readFileSync(file, 'utf8'))
  return { name: meta.name || name, when: meta.when || '', body }
}

function remove(name) {
  const file = path.join(DIR, slug(name) + '.md')
  try { fs.unlinkSync(file); return true } catch { return false }
}

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9\u0600-\u06ff]{3,}/g) || []

/* Skill matching is on every turn, and reading 30+ SKILL.md files each time is
 * the slowest part of a short turn. Cache the corpus briefly; a new skill shows
 * up within half a minute or on the next turn after it is written. */
let corpusCache = null
let corpusAt = 0
const CORPUS_TTL = 30000

function corpus() {
  if (corpusCache && Date.now() - corpusAt < CORPUS_TTL) return corpusCache
  const items = list().map((s) => {
    const full = read(s.name)
    return full ? { skill: s, hay: words(s.name + ' ' + (s.when || '') + ' ' + full.body), body: full.body } : null
  }).filter(Boolean)
  corpusCache = items
  corpusAt = Date.now()
  return items
}

/** Skills that look relevant to this message. */
function match(query, limit = 3) {
  const q = new Set(words(query))
  if (!q.size) return []
  const scored = []
  for (const item of corpus()) {
    let score = 0
    for (const w of item.hay) if (q.has(w)) score++
    if (score > 0) scored.push({ skill: item.skill, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.skill)
}

/** Prompt block for the matched skills. */
function toContext(query, limit = 2) {
  const hits = match(query, limit)
  if (!hits.length) return ''
  const blocks = hits.map((h) => {
    const full = read(h.name)
    return `### ${h.name}${h.when ? ' (for: ' + h.when + ')' : ''}\n${(full.body || '').slice(0, 1200)}`
  })
  return 'Skills I wrote earlier for this kind of work — follow them unless I say otherwise:\n' + blocks.join('\n\n')
}

/** Turn the tail of a conversation into a skill body. */
function fromTranscript(lines, { max = 24 } = {}) {
  const tail = lines.slice(-max)
  return tail.map((l) => {
    const who = l.role === 'you' ? 'Me' : l.role === 'sys' ? '(tool)' : 'Jarvis'
    return `${who}: ${String(l.text).trim()}`
  }).join('\n')
}

module.exports = { save, list, read, remove, match, toContext, fromTranscript, DIR, slug }
