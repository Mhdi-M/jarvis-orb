'use strict'
/**
 * paper-orchestra wiring.
 *
 * The upstream repo (paper-orchestra) is a multi-agent paper writer: raw
 * materials in, a LaTeX manuscript out. Its Python dependencies live in a
 * virtualenv (JARVIS_PY or ~/venvs/main). This module is the part Jarvis needs: find the
 * interpreter and the templates, prove the API keys exist (without printing
 * them), build the exact command, and stream the run.
 *
 * Nothing here invents a step: `preflight()` reports what is missing, and
 * `build()` returns the argv a human could paste.
 */
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')

const LOCAL_CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'papers.json'), 'utf8')) } catch { return {} }
})()
const ROOT = process.env.JARVIS_PAPER_ORCHESTRA || LOCAL_CFG.root || path.join(require('os').homedir(), 'paper-orchestra')
const PYTHON = process.env.JARVIS_PAPER_PYTHON || LOCAL_CFG.python || (process.platform === 'win32' ? 'python.exe' : 'python3')
const SCRIPT = 'paper_writing_cli.py'
const TEMPLATES = ['cvpr2025', 'iclr2025']

function envKeys() {
  const out = {}
  const hermes = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env')
  const paper = path.join(ROOT, '.env')
  for (const file of [hermes, paper]) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"]*)['"]?\s*$/)
        if (m && m[2] && !out[m[1]]) out[m[1]] = m[2]
      }
    } catch {}
  }
  return out
}

/** Copy the keys paper-orchestra expects into its own .env, without echoing
 * values. It wants GEMINI_API_KEY; this machine stores GOOGLE_API_KEY. */
function ensureEnv() {
  const keys = envKeys()
  const gemini = keys.GEMINI_API_KEY || keys.GOOGLE_API_KEY || ''
  const openai = keys.OPENAI_API_KEY || ''
  const lines = [
    '# written by jarvis-cli (lib/papers.js) — values are copied from the hermes .env',
    'GEMINI_API_KEY=' + (gemini || ''),
    'OPENAI_API_KEY=' + (openai || ''),
    'SEMANTIC_SCHOLAR_API_KEY=' + (keys.SEMANTIC_SCHOLAR_API_KEY || ''),
  ]
  const file = path.join(ROOT, '.env')
  try { fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 }) } catch {}
  return { file, gemini: !!gemini, openai: !!openai, scholar: !!keys.SEMANTIC_SCHOLAR_API_KEY }
}

function templates() {
  try { return fs.readdirSync(path.join(ROOT, 'templates')).filter((d) => fs.statSync(path.join(ROOT, 'templates', d)).isDirectory()) } catch { return [] }
}

/** Pure: the argv for one run, with sane defaults. */
function build(opts = {}) {
  const materials = opts.materials || ''
  const tpl = opts.template || 'iclr2025'
  const out = opts.output || path.join(ROOT, 'runs', 'run-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
  const args = [SCRIPT,
    '--raw_materials_dir', materials,
    '--latex_template_dir', path.join(ROOT, 'templates', tpl),
    '--output_dir', out,
    '--writer_model_name', opts.writer || 'gemini-3.1-pro-preview',
    '--reflection_model_name', opts.reflection || 'gemini-3.1-pro-preview',
    '--idea_filename', opts.idea || 'idea_sparse.md',
    '--experimental_log_filename', opts.log || 'experimental_log.md',
  ]
  if (opts.plotting) args.push('--use_plotting', 'true', '--plotting_model_name', opts.plottingModel || 'gemini-3.1-pro-preview')
  return { args, output: out, command: ['"' + PYTHON + '"'].concat(args.map((a) => (/[\s"]/.test(a) ? '"' + a + '"' : a))).join(' ') }
}

/** What is present, what is missing. No model call, no side effects except the .env copy. */
function preflight(opts = {}) {
  const checks = []
  const has = (p) => { try { return fs.existsSync(p) } catch { return false } }
  checks.push({ name: 'repo', ok: has(path.join(ROOT, SCRIPT)), detail: ROOT })
  checks.push({ name: 'python', ok: has(PYTHON), detail: PYTHON })
  const env = ensureEnv()
  checks.push({ name: 'gemini key', ok: env.gemini, detail: env.file })
  checks.push({ name: 'templates', ok: templates().length > 0, detail: templates().join(', ') || 'none' })
  if (opts.materials) {
    const m = opts.materials
    checks.push({ name: 'materials', ok: has(m), detail: m })
    checks.push({ name: 'idea file', ok: has(path.join(m, opts.idea || 'idea_sparse.md')), detail: opts.idea || 'idea_sparse.md' })
    checks.push({ name: 'experimental log', ok: has(path.join(m, opts.log || 'experimental_log.md')), detail: opts.log || 'experimental_log.md' })
    const figures = path.join(m, 'figures')
    const n = has(figures) ? fs.readdirSync(figures).filter((f) => /\.(png|jpe?g|pdf)$/i.test(f)).length : 0
    checks.push({ name: 'figures', ok: n > 0 || !!opts.plotting, detail: n + ' file(s)' + (opts.plotting ? ' · plotting on' : '') })
  }
  return { ok: checks.every((c) => c.ok), checks, root: ROOT, python: PYTHON }
}

/** `--help` through the real interpreter: proves the script imports cleanly. */
function probe() {
  return new Promise((resolve) => {
    execFile(PYTHON, [SCRIPT, '--help'], { cwd: ROOT, timeout: 60000, windowsHide: true, maxBuffer: 2 << 20 },
      (err, stdout, stderr) => {
        const text = String(stdout || '') + String(stderr || '')
        resolve({ ok: !err && /usage:/i.test(text), firstLine: text.split('\n').find((l) => /usage|error/i.test(l)) || '', error: err ? err.message : null })
      })
  })
}

/** Run the pipeline. Streams stdout/stderr lines; resolves with the outcome. */
function run(opts = {}, onLine) {
  const pre = preflight(opts)
  if (!opts.materials) return Promise.resolve({ ok: false, error: 'materials directory is required' })
  if (!pre.ok) return Promise.resolve({ ok: false, error: 'preflight failed: ' + pre.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') })
  const b = build(opts)
  const env = Object.assign({}, process.env)
  delete env.HTTPS_PROXY; delete env.HTTP_PROXY; delete env.ALL_PROXY
  return new Promise((resolve) => {
    const child = spawn(PYTHON, b.args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const tail = []
    const feed = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 60) tail.shift()
        if (onLine) { try { onLine(line) } catch {} }
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, opts.timeout || 3 * 3600 * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, output: b.output, command: b.command, tail: tail.slice(-12) })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, command: b.command }) })
  })
}

module.exports = { preflight, probe, build, run, ensureEnv, templates, ROOT, PYTHON, SCRIPT }
