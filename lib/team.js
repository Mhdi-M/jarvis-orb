/* ------------------------------------------------------------------ team
 * The layer above lib/agents.js.
 *
 *   upper manager  — decomposes one task into subtasks and assigns each to the
 *                    agent whose role fits, then merges what comes back
 *   peers          — run in parallel where the plan allows it, and each gets the
 *                    notes of the ones that finished before it (handoff)
 *   lessons        — every run updates per-agent success/seconds, and the better
 *                    agents are named in the next plan prompt, so the team
 *                    improves at choosing itself
 *
 * Everything is recorded under data/ so a later run can read it. No hidden state.
 */
const fs = require('fs')
const path = require('path')
const agents = require('./agents')

const DIR = path.join(__dirname, '..', 'data')
const RUNS = path.join(DIR, 'team-runs.jsonl')
const LESSONS = path.join(DIR, 'team-lessons.json')
const DRAFTS = path.join(DIR, 'skills-draft')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return fallback }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }) } catch (e) {}
}

function lessons() {
  return readJson(LESSONS, { agents: {}, runs: 0 })
}

function lessonLine() {
  const l = lessons()
  const rows = Object.entries(l.agents || {})
    .map(([name, s]) => {
      const n = (s.ok || 0) + (s.fail || 0)
      const rate = n ? Math.round(((s.ok || 0) / n) * 100) : 0
      return { name, rate, secs: s.secs || null, n }
    })
    .filter((r) => r.n > 0)
    .sort((a, b) => b.rate - a.rate || (a.secs || 999) - (b.secs || 999))
  if (!rows.length) return 'no history yet'
  return rows.map((r) => `${r.name} ${r.rate}% ok${r.secs ? ' ~' + r.secs + 's' : ''} (n=${r.n})`).join('; ')
}

function record(result) {
  ensureDir(DIR)
  try { fs.appendFileSync(RUNS, JSON.stringify(result) + '\n') } catch (e) {}

  const l = lessons()
  l.runs = (l.runs || 0) + 1
  l.agents = l.agents || {}
  for (const a of result.attempts || []) {
    const s = l.agents[a.agent] || { ok: 0, fail: 0, secs: null }
    if (a.status === 'ok') {
      s.ok += 1
      s.secs = s.secs ? Math.round((s.secs + a.secs) / 2) : Math.round(a.secs)
    } else {
      s.fail += 1
    }
    l.agents[a.agent] = s
  }
  ensureDir(DIR)
  try { fs.writeFileSync(LESSONS, JSON.stringify(l, null, 2)) } catch (e) {}
}

function availableAgents() {
  return agents.list().map((a) => `${a.name}: ${a.enabled ? a.role : 'UNAVAILABLE (' + (a.needs || 'disabled') + ')'}`).join('\n')
}

function parsePlan(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const p = JSON.parse(m[0])
    if (!p || !Array.isArray(p.subtasks) || !p.subtasks.length) return null
    p.subtasks = p.subtasks.slice(0, 4).map((s) => ({
      agent: String(s.agent || 'manager').trim(),
      task: String(s.task || '').trim(),
      needs: Array.isArray(s.needs) ? s.needs.map(Number) : []
    })).filter((s) => s.task)
    return p.subtasks.length ? p : null
  } catch (e) { return null }
}

async function plan(task, onTrace) {
  const prompt =
    'You are the upper manager of a team of agents. Decompose the task into at most 4 subtasks ' +
    'and assign each to exactly one agent.\n\nAgents:\n' + availableAgents() +
    '\n\nTeam history (success rate, average seconds): ' + lessonLine() +
    '\n\nRules: pick the specialist whose role fits; put independent subtasks in the same plan ' +
    '(they run in parallel); use "needs" with 0-based indexes only when a subtask requires another ' +
    "result. If one agent can do everything, return a single subtask.\n" +
    'Answer with JSON only, no prose: {"subtasks":[{"agent":"hands","task":"...","needs":[]}],"merge":"one line on how to combine"}\n\n' +
    'Task: ' + task

  const res = await agents.run(agents.get('manager') || { name: 'manager', model: 'deepseek/deepseek-v4-flash', provider: 'custom:swm' }, prompt)
  if (onTrace) onTrace({ phase: 'plan', status: res.status, secs: res.secs, text: res.text })
  return { plan: parsePlan(res.text), raw: res.text, secs: res.secs }
}

async function merge(task, done, onTrace) {
  const body = done.map((d, i) => `[${i}] ${d.agent} (${d.model}) said: ${d.answer}`).join('\n\n')
  const prompt = 'You are the upper manager. Combine these specialist results into one answer for the user.\n' +
    'Keep it short, do not mention the internal agents unless it matters.\n\nTask: ' + task + '\n\nResults:\n' + body
  const res = await agents.run(agents.get('manager') || { name: 'manager', model: 'deepseek/deepseek-v4-flash', provider: 'custom:swm' }, prompt)
  if (onTrace) onTrace({ phase: 'merge', status: res.status, secs: res.secs })
  return res.status === 'ok' ? res.text : done.map((d) => d.answer).join('\n\n')
}

/* Run one task through the whole pyramid. */
async function run(task, opts) {
  const o = opts || {}
  const onTrace = o.onTrace || (() => {})
  const started = Date.now()

  const planned = await plan(task, onTrace)
  let subtasks = planned.plan && Array.isArray(planned.plan.subtasks) ? planned.plan.subtasks : null
  if (!subtasks) {
    onTrace({ phase: 'plan', status: 'invalid', note: 'plan unreadable, using the cascade directly' })
    const res = await agents.cascade(task, { onAttempt: (e) => onTrace({ phase: 'agent', attempt: e }) })
    const out = { task, plan: null, attempts: res.attempts, answer: res.answer, agent: res.agent, secs: Math.round((Date.now() - started) / 100) / 10 }
    record(out)
    return out
  }

  onTrace({ phase: 'plan', status: 'ok', subtasks })
  const results = []
  const attempts = []
  const notes = []

  // successive waves: a subtask whose "needs" are not finished waits one wave
  let pending = subtasks.map((s, i) => ({ ...s, i }))
  let wave = 0
  while (pending.length && wave < 4) {
    const ready = pending.filter((s) => s.needs.every((n) => results[n]))
    const batch = ready.length ? ready : pending.slice(0, 1)
    pending = pending.filter((s) => !batch.includes(s))

    await Promise.all(batch.map(async (s) => {
      const brief = [
        s.task,
        notes.length ? '\nWhat your teammates already found:\n' + notes.join('\n') : ''
      ].join('')
      onTrace({ phase: 'dispatch', agent: s.agent, task: s.task })
      const res = await agents.cascade(brief, {
        agents: [s.agent],
        onAttempt: (e) => { if (e.phase === 'done') onTrace({ phase: 'agent', attempt: e }) }
      })
      attempts.push(...res.attempts)
      results[s.i] = { agent: res.agent || s.agent, model: res.model, answer: res.answer || '(no answer)' }
      if (res.answer) notes.push('- ' + (res.agent || s.agent) + ': ' + String(res.answer).slice(0, 400))
    }))
    wave += 1
  }

  const done = results.filter(Boolean)
  const answer = done.length > 1 ? await merge(task, done, onTrace) : (done[0] && done[0].answer)

  const out = {
    task,
    plan: subtasks,
    attempts,
    answer,
    agent: done.length === 1 ? done[0].agent : 'manager(merge)',
    secs: Math.round((Date.now() - started) / 100) / 10,
    ranAt: new Date().toISOString()
  }
  record(out)
  return out
}

/* Turn a successful run into a skill draft the user can promote. Kept opt-in:
 * one extra model call, and drafts are never installed silently. */
async function draftSkill(out) {
  ensureDir(DRAFTS)
  const prompt =
    'A team of agents just completed this task. If the procedure is reusable, write a short ' +
    'skill file for it (imperative steps, when to use, pitfalls) in markdown, starting with a ' +
    'heading. If it is a one-off, reply exactly NONE.\n\nTask: ' + out.task +
    '\nPlan: ' + JSON.stringify(out.plan) + '\nAnswer: ' + String(out.answer).slice(0, 800)
  const res = await agents.run(agents.get('manager'), prompt)
  if (res.status !== 'ok' || /^none\b/i.test(res.text.trim())) return null
  const name = 'draft-' + new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(DRAFTS, name + '.md')
  fs.writeFileSync(file, res.text.trim() + '\n')
  return file
}

module.exports = { run, plan, merge, lessons, lessonLine, record, draftSkill, RUNS, LESSONS, DRAFTS }
