'use strict'
/**
 * The learning loop — the local model watches what happens and writes down
 * what is worth keeping:
 *
 *   facts   "user prefers pnpm, keeps repos on D:"
 *   skills  how a piece of work is done here, so it can be repeated later
 *
 * Everything runs on Ollama, so it costs nothing and never leaves the machine.
 */
const ollama = require('./ollama')
const memory = require('./memory')
const skills = require('./skills')

const FACT_PROMPT =
  'Extract durable facts about the user from the exchange below.\n' +
  'Rules: each fact is a complete sentence of 5-25 words in third person about the user ' +
  '(for example "User deploys every project with pnpm and never uses npm").\n' +
  'Only preferences, tools, projects, constraints, names or standing instructions. ' +
  'Never include passwords, keys, tokens or card numbers. Max 2 facts. ' +
  'Reply as a JSON array of strings. If nothing is worth keeping, reply [].'

const SKILL_PROMPT =
  'Turn this work into a reusable skill for an assistant.\n' +
  'Reply as JSON: {"name": "short title", "when": "comma separated trigger words", ' +
  '"body": "3 to 6 numbered steps, one action per line, written as instructions, ' +
  'and include every preference the user stated"}.\n' +
  'If it is not a repeatable procedure, reply {"skip": true}.'

/** Keep only fact-shaped strings: sentences, third person, no fragments. */
function filterFacts(arr) {
  const out = []
  if (!Array.isArray(arr)) return out
  for (const raw of arr) {
    if (out.length >= 3) break
    let fact = String(raw || '').trim().replace(/^["'\-\s]+|["'\s]+$/g, '')
    if (!fact) continue
    if (fact.split(/\s+/).length < 4 || fact.length < 18 || fact.length > 220) continue
    if (!/^(user|me|my|the user)/i.test(fact)) fact = 'User: ' + fact
    out.push(fact)
  }
  return out
}

/** Pull durable facts out of one exchange and store the new ones. */
async function learnFacts(userText, assistantText, opts = {}) {
  const text = `Me: ${String(userText || '').slice(0, 800)}\nJarvis: ${String(assistantText || '').slice(0, 800)}`
  let arr = null
  try {
    arr = await ollama.json(FACT_PROMPT + '\n\n' + text, { maxTokens: 200, timeout: opts.timeout || 60000 })
  } catch { return [] }
  if (!Array.isArray(arr)) return []
  const added = []
  for (const fact of filterFacts(arr)) {
    if (memory.add(fact)) added.push(fact)
  }
  return added
}

/** Turn the recent transcript into a skill; returns the saved skill or null. */
async function draftSkill(lines, { name = '', hints = '' } = {}, opts = {}) {
  const transcript = lines.slice(-30).map((l) => (l.role === 'you' ? 'Me' : l.role === 'sys' ? '(tool)' : 'Jarvis') + ': ' + l.text).join('\n')
  if (transcript.length < 40) return null
  let out = null
  try {
    out = await ollama.json(SKILL_PROMPT + (hints ? `\nFocus: ${hints}` : '') + '\n\n' + transcript, { maxTokens: 320, timeout: opts.timeout || 90000 })
  } catch { return null }
  if (!out || out.skip || !out.body) return null
  const skillName = String(name || out.name || 'learned-' + new Date().toISOString().slice(0, 10)).slice(0, 60)
  const saved = skills.save({ name: skillName, when: String(out.when || '').slice(0, 160), body: String(out.body), source: 'ollama' })
  return { ...saved, name: skillName, when: out.when || '' }
}

module.exports = { learnFacts, draftSkill, filterFacts, FACT_PROMPT, SKILL_PROMPT }
