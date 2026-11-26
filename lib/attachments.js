'use strict'
/**
 * Attachments: turn files, folders, screenshots and transcriptions into text the
 * model can actually use.
 *
 * Pure classification plus one async builder. The media helpers are injected, so
 * this module is unit-testable without touching the network or a microphone.
 */
const fs = require('fs')
const path = require('path')

const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const AUDIO = ['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.aac']
const VIDEO = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v']

/** 'folder' | 'image' | 'audio' | 'video' | 'file' | null when it does not exist */
function kindOf(file) {
  try {
    if (fs.statSync(file).isDirectory()) return 'folder'
  } catch (e) {
    return null
  }
  const ext = path.extname(String(file)).toLowerCase()
  if (IMAGE.includes(ext)) return 'image'
  if (AUDIO.includes(ext)) return 'audio'
  if (VIDEO.includes(ext)) return 'video'
  return 'file'
}

/** Same normalisation for a typed path, a dropped path and a file:// URL. */
function normalize(raw) {
  let p = String(raw == null ? '' : raw).trim().replace(/^["']|["']$/g, '')
  if (!p) return ''
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, '')) } catch (e) { /* keep */ }
  }
  return path.resolve(p.replace(/^~/, require('os').homedir()))
}

/** Pasted text that is nothing but existing paths — one per line. */
function fromText(text, max = 20) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length || lines.length > max) return []
  const out = []
  for (const line of lines) {
    const p = normalize(line)
    if (!p || !kindOf(p)) return []
    out.push({ kind: kindOf(p), path: p, label: path.basename(p) || p })
  }
  return out
}

const INLINE_LIMIT = 300000

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        resolve({ ok: false, error: (label || 'read') + ' timed out after ' + Math.round(ms / 1000) + 's' })
      }
    }, ms)
    Promise.resolve(promise).then((value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }, (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, error: String(err && err.message ? err.message : err) })
    })
  })
}

/**
 * Build the text block for a list of attachments.
 * media: { describeImage(path), transcribe(path, model) } — both may be absent.
 * opts.timeoutMs caps each slow read so one dead model cannot freeze the turn.
 * A finished read is cached on the attachment as .text, so pressing Enter twice
 * does not pay for the vision call twice.
 */
async function buildBlocks(list, media, opts) {
  const m = media || {}
  const timeoutMs = (opts && opts.timeoutMs) || 90000
  const out = []
  for (const a of list || []) {
    if (a.text) {
      out.push(a.text)
      continue
    }
    let block = ''
    if (a.kind === 'image' && m.describeImage) {
      const r = await withTimeout(m.describeImage(a.path, 'Describe this image precisely. Transcribe any text in it.'), timeoutMs, 'vision')
      block = 'IMAGE ' + a.path + '\n' + (r && r.ok ? r.text : 'unreadable: ' + ((r && r.error) || 'vision failed'))
    } else if ((a.kind === 'audio' || a.kind === 'video') && m.transcribe) {
      const r = await withTimeout(m.transcribe(a.path, 'tiny'), timeoutMs, 'transcription')
      const tag = a.kind === 'video' ? 'VIDEO TRANSCRIPT ' : 'AUDIO TRANSCRIPT '
      block = tag + a.path + '\n' + (r && r.ok ? r.text : 'unreadable: ' + ((r && r.error) || 'transcription failed'))
    } else if (a.kind === 'folder') {
      let items
      try { items = fs.readdirSync(a.path).slice(0, 300) } catch (e) { items = ['(unreadable)'] }
      block = 'FOLDER ' + a.path + '\n' + items.join('\n')
    } else {
      try {
        const st = fs.statSync(a.path)
        if (st.size <= INLINE_LIMIT) block = 'FILE ' + a.path + '\n' + fs.readFileSync(a.path, 'utf8').slice(0, 30000)
        else block = 'FILE ' + a.path + ' (' + st.size + ' bytes, too large to inline)'
      } catch (e) {
        block = 'FILE ' + a.path + ' (unreadable binary; mention only the path)'
      }
    }
    a.text = block
    out.push(block)
  }
  return out.join('\n\n')
}

/** '3 images · 1 folder' for the status hint. */
function summary(list) {
  const n = (list || []).length
  if (!n) return ''
  const kinds = {}
  for (const a of list) kinds[a.kind] = (kinds[a.kind] || 0) + 1
  return Object.entries(kinds).map(([k, v]) => v + ' ' + k).join(' · ')
}

module.exports = { kindOf, normalize, fromText, buildBlocks, summary, IMAGE, AUDIO, VIDEO }
