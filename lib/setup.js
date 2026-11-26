'use strict'
/**
 * First-run setup — what makes the one-line install work on another machine.
 *
 * It does not assume this machine's providers. It reads whatever keys exist in
 * the environment or in the Hermes .env, asks Ollama what models are installed,
 * probes the resulting inventory with a two-token question, and writes the best
 * working model into cli.config.json. Paid and free keys are treated the same:
 * presence is detected, health is measured, ranking decides.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const models = require('./models')
const health = require('./health')
const ollama = require('./ollama')

const CONFIG = path.join(__dirname, '..', 'cli.config.json')
const HERMES = process.env.HERMES_BIN ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'hermes', 'hermes-agent', '.hermes', 'bin',
    process.platform === 'win32' ? 'hermes.exe' : 'hermes')

const PROVIDERS = [
  { provider: 'custom:swm', env: [], label: 'Custom OpenAI-compatible provider', any: /^HERMES_CUSTOM_.*_API_KEY$/ },
  { provider: 'nvidia', env: ['NVIDIA_API_KEY'], label: 'NVIDIA NIM (free tier)' },
  { provider: 'gemini', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], label: 'Google Gemini' },
  { provider: 'deepseek', env: ['DEEPSEEK_API_KEY'], label: 'DeepSeek API' },
  { provider: 'openai', env: ['OPENAI_API_KEY'], label: 'OpenAI' },
  { provider: 'openrouter', env: ['OPENROUTER_API_KEY'], label: 'OpenRouter' },
]

function envFile() {
  const home = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'hermes')
  return path.join(home, '.env')
}

function readEnv() {
  const out = {}
  for (const line of (() => { try { return fs.readFileSync(envFile(), 'utf8') } catch { return '' } })().split(String.fromCharCode(10))) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"]*)['"]?\s*$/)
    if (m && m[2]) out[m[1]] = m[2]
  }
  return out
}

/** Pure: which providers this machine can actually call, and why. */
function detect(env) {
  return PROVIDERS.map((p) => {
    if (p.any) {
      const hit = Object.keys(env || {}).find((k) => p.any.test(k) && String(env[k] || '').length > 8)
      return { provider: p.provider, label: p.label, key: hit || null, ok: !!hit }
    }
    const hit = p.env.find((n) => env && String(env[n] || '').trim().length > 8)
    return { provider: p.provider, label: p.label, key: hit || null, ok: !!hit }
  })
}

function hermesPresent() {
  try { return fs.existsSync(HERMES) } catch { return false }
}

function writeConfig(model, provider) {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch {}
  cfg.model = model || ''
  cfg.provider = provider || ''
  if (cfg.autoTitle === undefined) cfg.autoTitle = true
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n') } catch {}
  return cfg
}

/**
 * setup({ probe, onLine }) -> report
 * probe=false only detects and writes, for tests and for offline machines.
 */
async function setup(opts = {}) {
  const say = opts.onLine || ((l) => process.stdout.write(l + '\n'))
  const env = { ...readEnv(), ...process.env }
  const found = detect(env)

  say('jarvis setup')
  say('  hermes   ' + (hermesPresent() ? 'found' : 'NOT found — install it first: https://hermes-agent.nousresearch.com'))

  for (const f of found) say('  ' + (f.ok ? 'key  ' : 'no key') + '  ' + f.label + (f.key ? '  (' + f.key + ')' : ''))

  /* Enable the entries whose provider has a key; keep the rest visible as unusable. */
  const reg = models.ensure()
  const usable = new Set(found.filter((f) => f.ok).map((f) => f.provider))
  for (const e of reg.models) {
    if (e.local) continue
    e.enabled = usable.has(e.provider)
  }

  /* Local models actually installed on this machine become entries. */
  const local = await ollama.models()
  if (local.length) {
    for (const m of local) {
      if (!reg.models.some((e) => e.model === m.name && e.local)) {
        reg.models.push({ id: 'local-' + m.name.replace(/[^a-z0-9]+/gi, '-'), provider: 'ollama', model: m.name, quality: 0.35, enabled: true, local: true, note: 'installed locally' })
      }
    }
    say('  ollama   ' + local.map((m) => m.name).join(', '))
  } else {
    say('  ollama   not running (local option unavailable until `ollama serve`)')
  }
  models.save(reg)

  let best = null
  if (opts.probe !== false) {
    say('  probing  ' + models.status().length + ' model(s), one tiny question each...')
    await models.refresh({ all: true, onStep: (s) => say('    ' + (s.ok ? 'ok  ' : 'fail') + '  ' + s.id.padEnd(14) + (s.secs != null ? s.secs + 's' : '') + '  ' + String(s.text || '').slice(0, 50)) })
    best = models.best()
  } else {
    best = models.status()[0]
  }

  if (best) {
    writeConfig(best.model, best.provider)
    say('  chosen   ' + best.model + '  (' + best.provider + ')  score ' + Math.round(best.score * 100))
  } else {
    writeConfig('', '')
    say('  chosen   none — add a key to ' + envFile() + ' and run: jarvis --setup')
  }

  health.note('setup', { providers: found.filter((f) => f.ok).map((f) => f.provider), best: best ? best.model : null })
  say('  next     jarvis          (interactive)')
  say('           jarvis "/models" (see the ranked inventory)')
  return { ok: !!best && hermesPresent(), found, local: local.length, best, hermes: hermesPresent() }
}

module.exports = { setup, detect, readEnv, hermesPresent, writeConfig, PROVIDERS, envFile, CONFIG }
