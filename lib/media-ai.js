'use strict'
/**
 * Media understanding — images, YouTube, and audio.
 *
 * Three capabilities the terminal assistant needs to be useful in practice:
 *   describeImage(file, question)  - any local picture, through the vision model
 *   youtube(url)                   - captions, without downloading the video
 *   transcribe(file)               - English speech to text with faster-whisper
 *
 * Python helpers live in tools/ and print one JSON object, so failures come
 * back as data (ok:false, error) instead of a stack trace in the transcript.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile, spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PY = process.env.JARVIS_PY || (process.platform === 'win32'
  ? 'python'
  : (process.env.HOME ? path.join(process.env.HOME, '.venv', 'bin', 'python') : 'python3'))

function runPy(script, args, timeout = 300000) {
  return new Promise((resolve) => {
    execFile(PY, [path.join(ROOT, 'tools', script)].concat(args),
      { timeout, windowsHide: true, maxBuffer: 16 << 20, env: Object.assign({}, process.env) },
      (err, stdout, stderr) => {
        const text = String(stdout || '').trim()
        if (!text) return resolve({ ok: false, error: (stderr || (err && err.message) || 'no output').toString().slice(0, 300) })
        try { resolve(JSON.parse(text.split('\n').pop())) } catch { resolve({ ok: false, error: text.slice(0, 300) }) }
      })
  })
}

/** Any local image, through the same vision path /look uses. */
async function describeImage(file, question) {
  const full = path.resolve(String(file || '').replace(/^~/, os.homedir()))
  if (!fs.existsSync(full)) return { ok: false, error: 'no such file: ' + full }
  const ext = path.extname(full).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    return { ok: false, error: 'not an image: ' + ext }
  }
  const visionact = require('./visionact')
  const prompt = (question || 'Describe this image precisely. If it contains text, transcribe it. If it is a screenshot, say which application and what state it is in.') +
    ' Image path: ' + full
  const t0 = Date.now()
  const text = await visionact.askCloud(prompt, full)
  const ok = !!String(text || '').trim()
  return { ok, text: String(text || '').trim(), secs: Math.round((Date.now() - t0) / 100) / 10, file: full }
}

/** YouTube captions. No video download, no ffmpeg. Tries yt-dlp first (fast, robust),
 * falls back to youtube-transcript-api. */
async function youtube(url) {
  if (!/youtu\.?be/i.test(String(url))) return { ok: false, error: 'not a YouTube URL' }
  const r = await runYtdlp(url)
  if (r && r.ok) return r
  const r2 = await runPy('yt_transcript.py', [String(url)], 90000)
  if (r2 && r2.ok) return r2
  return { ok: false, error: (r && r.error) || (r2 && r2.error) || 'no captions available' }
}

function runYtdlp(url) {
  const args = [
    '-m', 'yt_dlp',
    '--js-runtimes', 'node',
    '--write-auto-sub', '--sub-lang', 'en', '--skip-download',
    '--convert-subs', 'srt', url, '-o', '-'
  ]
  return new Promise((resolve) => {
    const proc = spawn(PY, args, { timeout: 90000, windowsHide: true, env: Object.assign({}, process.env) })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err.slice(0, 300) })
      const lines = out.split('\n')
      const text = lines.filter(l => !/^\d+$/.test(l.trim()) && !/-->/ .test(l)).join(' ').trim()
      if (!text) return resolve({ ok: false, error: 'no subtitle text' })
      resolve({ ok: true, id: '', lang: 'en', chars: text.length, text })
    })
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
}

/** English speech to text. */
async function transcribe(file, model) {
  const full = path.resolve(String(file || '').replace(/^~/, os.homedir()))
  if (!fs.existsSync(full)) return { ok: false, error: 'no such file: ' + full }
  const args = [full]
  if (model) args.push(String(model))
  return runPy('transcribe.py', args, 1800000)
}

const clip = (text, max = 12000) => {
  const t = String(text || '')
  return t.length <= max ? t : t.slice(0, max) + '\n…[truncated ' + (t.length - max) + ' chars]'
}

module.exports = { describeImage, youtube, transcribe, clip, PY, runPy }
