'use strict'
/**
 * The manager loop.
 *
 * One model does not do everything here. The manager plans, hands each piece to
 * the specialist whose role fits, runs independent pieces in parallel, VALIDATES
 * every result before using it, retries a bad one on a different agent, and only
 * then merges. If the merged answer still fails validation the round repeats
 * with the failures named — up to four rounds — and a final failure is reported
 * as a failure, never dressed up as an answer.
 *
 * Every phase is emitted through onTrace so the terminal can show which agent
 * is working and what the manager is thinking, and the whole run is appended to
 * data/orchestra.jsonl for review.
 */
const fs = require('fs')
const path = require('path')
const agents = require('./agents')
const team = require('./team')
const quality = require('./quality')
const health = require('./health')

const LOG = path.join(__dirname, '..', 'data', 'orchestra.jsonl')
const MAX_ROUNDS = 4

/** Pure: what kind of work this is, which decides how a result is checked. */
function kindOf(task) {
  const t = String(task || '')
  if (/\b(screen|screenshot|see|look at|image|picture|photo|visible|what'?s on)\b/i.test(t)) return 'vision'
  if (/\b(calculate|compute|how much is|what is\s*[\d(]|\d+\s*[+\-*/^%]\s*\d+|percent of)\b/i.test(t)) return 'calc'
  if (/\b(search|look up|find on the web|google|latest|news|price of|weather|who is|research)\b/i.test(t)) return 'search'
  if (/\b(file|folder|directory|disk|process|cpu|ram|memory|install|run |command|shell|git|repo)\b/i.test(t)) return 'shell'
  return 'general'
}

/** Pure: does this request need more than one model at all? */
function shouldOrchestrate(task) {
  const kind = kindOf(task)
  if (kind !== 'general') return true
  return /\b(then|after that|and also|compare|summar)\b/i.test(String(task || '')) && String(task).length > 60
}

/** Pure: validate one specialist result. Junk scores 0 and names why. */
function validate({ kind, task, answer, secs, agent }) {
  const a = String(answer == null ? '' : answer).trim()
  const q = quality.assess(a, { prompt: task })
  if (!q.ok) return { ok: false, score: 0, reason: q.reason, by: agent || null }
  /* Correctness, not just shape: arithmetic is recomputed and JSON is parsed. */
  const check = require('./verify').verdict(task, a)
  if (!check.ok) return { ok: false, score: 0.05, reason: check.reason, by: agent || null }
  if (/\b(as an ai|i can(?:'|no)t help|i cannot assist|cannot access|no access to)\b/i.test(a)) {
    return { ok: false, score: 0.1, reason: 'refusal instead of an attempt', by: agent || null }
  }
  let score = 0.5
  if (a.length > 40) score += 0.1
  if (a.length > 160) score += 0.1
  if (kind === 'calc' && /\d/.test(a)) score += 0.2
  if (kind === 'vision' && /[a-z]{3}/i.test(a)) score += 0.1
  if (kind === 'search' && /https?:\/\//i.test(a)) score += 0.1
  if (kind === 'shell' && /(?:^|\n)(?:\/|[A-Za-z]:\\|~\/)|exit code|cpu|ram|gb|mb/i.test(a)) score += 0.05
  if (Number.isFinite(secs) && secs > 120) score -= 0.15
  score = Math.max(0, Math.min(1, score))
  return { ok: score >= 0.55, score: +score.toFixed(2), reason: q.kind, by: agent || null }
}

function log(row) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
  } catch {}
}

function recent(n = 30) {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/**
 * solve(task, {onTrace}) -> {ok, answer, validations, attempts, rounds, secs}
 */
async function solve(task, opts = {}) {
  const onTrace = opts.onTrace || (() => {})
  const started = Date.now()
  const kind = kindOf(task)
  const trace = (e) => { try { onTrace({ kind, ...e }) } catch {} }

  trace({ phase: 'start', text: 'manager is planning' })
  const planned = await team.plan(task, (e) => trace({ phase: e.phase, text: e.status || '', secs: e.secs }))
  let subtasks = planned.plan && Array.isArray(planned.plan.subtasks) ? planned.plan.subtasks : null

  if (!subtasks) {
    trace({ phase: 'plan', ok: false, text: 'plan unreadable — one manager pass with failover' })
    subtasks = [{ agent: 'manager', task, needs: [] }]
  } else {
    trace({ phase: 'plan', ok: true, text: subtasks.map((s) => s.agent + ': ' + String(s.task).slice(0, 48)).join(' | ') })
  }

  const attempts = []
  let results = []
  let round = 0

  while (round < MAX_ROUNDS) {
    round += 1
    results = []
    let pending = subtasks.map((s, i) => ({ ...s, i }))
    let wave = 0

    /* Dispatch: every ready subtask runs at the same time. */
    while (pending.length && wave < 4) {
      const ready = pending.filter((s) => (s.needs || []).every((n) => results[n]))
      const batch = ready.length ? ready : pending.slice(0, 1)
      pending = pending.filter((s) => !batch.includes(s))

      await Promise.all(batch.map(async (s) => {
        trace({ phase: 'dispatch', agent: s.agent, text: s.task })
        let res = await agents.cascade(s.task, {
          agents: [s.agent],
          onAttempt: (e) => { if (e.phase === 'done') trace({ phase: 'agent', agent: e.agent, ok: e.status === 'ok', text: e.status, secs: e.secs }) },
        })
        attempts.push(...(res.attempts || []))
        let v = validate({ kind: kindOf(s.task) || kind, task: s.task, answer: res.answer, secs: res.secs, agent: res.agent })

        if (!v.ok) {
          trace({ phase: 'validate', agent: res.agent || s.agent, ok: false, text: v.reason })
          /* one retry on a different agent before the manager sees a hole */
          trace({ phase: 'retry', agent: s.agent, text: 'retrying after: ' + v.reason })
          res = await agents.cascade(s.task, {
            agents: [],
            onAttempt: (e) => { if (e.phase === 'done') trace({ phase: 'agent', agent: e.agent, ok: e.status === 'ok', text: e.status, secs: e.secs }) },
          })
          attempts.push(...(res.attempts || []))
          v = validate({ kind: kindOf(s.task) || kind, task: s.task, answer: res.answer, secs: res.secs, agent: res.agent })
        }

        trace({ phase: 'validate', agent: res.agent || s.agent, ok: v.ok, text: 'score ' + v.score + (v.ok ? '' : ' · ' + v.reason) })
        results[s.i] = {
          agent: res.agent || s.agent,
          model: res.model || null,
          answer: res.answer || '',
          validation: v,
          task: s.task,
        }
      }))
      wave += 1
    }

    const good = results.filter((r) => r && r.validation.ok)
    const bad = results.filter((r) => r && !r.validation.ok)
    trace({ phase: 'round', round, ok: bad.length === 0, text: good.length + ' valid · ' + bad.length + ' rejected' })

    if (bad.length && round < MAX_ROUNDS) {
      /* Ask again with the specific failure, not the whole task. */
      subtasks = bad.map((r) => ({ agent: r.agent, task: r.task + '\n\nYour previous answer was rejected: ' + r.validation.reason + '. Give the concrete result, no preamble.', needs: [] }))
      trace({ phase: 'round', round, ok: false, text: 're-asking ' + bad.length + ' rejected subtask(s)' })
      continue
    }
    break
  }

  const good = results.filter((r) => r && r.validation.ok)
  if (!good.length) {
    const reason = results.filter(Boolean).map((r) => (r.agent || 'agent') + ': ' + r.validation.reason).join('; ') || 'no agent produced a usable result'
    const out = { ok: false, task, kind, answer: null, reason, results, attempts, rounds: round, secs: Math.round((Date.now() - started) / 100) / 10 }
    log(out)
    trace({ phase: 'answer', ok: false, text: reason })
    return out
  }

  /* Merge only validated material. */
  let answer
  if (good.length === 1) {
    answer = good[0].answer
  } else {
    trace({ phase: 'merge', agent: 'manager', text: 'combining ' + good.length + ' validated result(s)' })
    const body = good.map((r, i) => '[' + i + '] ' + r.agent + ': ' + r.answer).join('\n\n')
    const prompt = 'You are the manager. Combine these VALIDATED specialist results into one direct answer for the user.\n' +
      'Rules: do not mention internal agents unless it matters; do not add facts that are not in the results; if a result is missing, say what is missing.\n\n' +
      'Task: ' + task + '\n\nResults:\n' + body
    const merged = await agents.run(agents.get('manager') || { name: 'manager', model: 'deepseek/deepseek-v4-flash', provider: 'custom:swm' }, prompt)
    const mv = validate({ kind, task, answer: merged.status === 'ok' ? merged.text : '', secs: merged.secs, agent: 'manager' })
    trace({ phase: 'validate', agent: 'manager', ok: mv.ok, text: 'merged score ' + mv.score })
    if (mv.ok) answer = merged.text
    else {
      answer = good.map((r) => r.answer).join('\n\n')
      trace({ phase: 'merge', ok: false, text: 'merge failed validation — returning the validated parts verbatim' })
    }
  }

  const finalV = validate({ kind, task, answer, secs: null, agent: 'manager' })
  const out = {
    ok: finalV.ok,
    task, kind, answer: finalV.ok ? answer : null,
    reason: finalV.ok ? null : finalV.reason,
    validations: results.filter(Boolean).map((r) => ({ agent: r.agent, ok: r.validation.ok, score: r.validation.score, reason: r.validation.reason })),
    attempts,
    rounds: round,
    secs: Math.round((Date.now() - started) / 100) / 10,
  }
  log(out)
  health.note('orchestra', { task: String(task).slice(0, 120), ok: out.ok, rounds: round, valid: good.length })
  trace({ phase: 'answer', ok: out.ok, text: out.ok ? String(answer).slice(0, 90) : out.reason })
  return out
}

/**
 * race(task) — the same question to several agents at once, best validated
 * answer wins. This is how "use all of them" stays honest: parallel work, one
 * answer, chosen by score then speed, with every attempt recorded.
 */
async function race(task, opts = {}) {
  const limit = Math.max(2, Math.min(4, Number(opts.n) || 3))
  const trace = opts.onTrace || (() => {})
  const started = Date.now()
  const kind = kindOf(task)
  const reg = agents.list().filter((a) => a.enabled !== false && !['operator', 'papers'].includes(a.name))
  const picks = []
  const providers = new Set()
  for (const a of reg) {
    if (!a.provider) continue
    if (!providers.has(a.provider) || picks.length === 0) { picks.push(a); providers.add(a.provider) }
    if (picks.length >= limit) break
  }
  if (!picks.length) return { ok: false, task, answer: null, reason: 'no enabled agents', results: [], secs: 0 }

  trace({ phase: 'start', text: 'racing ' + picks.map((p) => p.name).join(', ') })
  const results = await Promise.all(picks.map(async (a) => {
    const r = await agents.cascade(task, { agents: [a.name] })
    const v = validate({ kind, task, answer: r.answer, secs: r.secs, agent: r.agent })
    trace({ phase: 'agent', agent: a.name, ok: v.ok, secs: r.secs, text: 'score ' + v.score + (v.ok ? '' : ' · ' + v.reason) })
    return { agent: r.agent, model: r.model, answer: r.answer || '', validation: v, secs: r.secs }
  }))
  const good = results.filter((r) => r.validation.ok).sort((a, b) => b.validation.score - a.validation.score || (a.secs || 999) - (b.secs || 999))
  const out = {
    ok: good.length > 0, task, kind, winner: good[0] || null,
    answer: good.length ? good[0].answer : null,
    reason: good.length ? null : results.map((r) => r.agent + ': ' + r.validation.reason).join('; '),
    results: results.map((r) => ({ agent: r.agent, score: r.validation.score, ok: r.validation.ok, secs: r.secs })),
    secs: Math.round((Date.now() - started) / 100) / 10,
  }
  log({ ...out, mode: 'race' })
  trace({ phase: 'answer', ok: out.ok, text: out.ok ? good[0].agent + ' won (score ' + good[0].validation.score + ')' : out.reason })
  return out
}

module.exports = { solve, race, validate, kindOf, shouldOrchestrate, recent, LOG, MAX_ROUNDS }
