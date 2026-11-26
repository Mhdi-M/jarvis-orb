'use strict'
/**
 * Resolve the Python interpreter that has the optional media helpers installed
 * (yt-dlp, youtube-transcript-api, faster-whisper).
 *
 * Order, first hit wins. An explicit override is trusted as-is; every other
 * candidate is probed by importing the media packages, so a bare system python
 * that lacks them is skipped instead of silently breaking /watch and /listen.
 *
 *   1. JARVIS_PY / PYTHON            explicit override
 *   2. $VIRTUAL_ENV                  the active virtualenv
 *   3. ~/venvs/main, ~/.venv         layout the installer suggests
 *   4. <drive>:/venvs/main, /venv    a venv on another drive (C, D, E)
 *   5. %LOCALAPPDATA%\Programs\Python\Python3xx
 *   6. python3 / python              whatever is on PATH
 *
 * No username or personal folder is hardcoded here.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const isWin = process.platform === 'win32'
const exe = isWin ? 'python.exe' : 'python'

function candidates() {
  const out = []
  if (process.env.JARVIS_PY) out.push(process.env.JARVIS_PY)
  if (process.env.PYTHON) out.push(process.env.PYTHON)
  if (process.env.VIRTUAL_ENV) {
    out.push(isWin
      ? path.join(process.env.VIRTUAL_ENV, 'Scripts', exe)
      : path.join(process.env.VIRTUAL_ENV, 'bin', 'python'))
  }
  const home = os.homedir()
  const rels = isWin
    ? [['venvs', 'main', 'Scripts', exe], ['.venv', 'Scripts', exe]]
    : [['venvs', 'main', 'bin', 'python'], ['.venv', 'bin', 'python']]
  for (const parts of rels) out.push(path.join(home, ...parts))

  if (isWin) {
    for (const drive of ['C:', 'D:', 'E:']) {
      out.push(path.join(drive + path.sep, 'venvs', 'main', 'Scripts', exe))
      out.push(path.join(drive + path.sep, 'venv', 'Scripts', exe))
      out.push(path.join(drive + path.sep, '.venv', 'Scripts', exe))
    }
    if (process.env.LOCALAPPDATA) {
      for (const v of ['Python313', 'Python312', 'Python311', 'Python310']) {
        out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', v, 'python.exe'))
      }
    }
  }
  out.push(isWin ? 'python' : 'python3', 'python')
  return out
}

/** True when this interpreter can import the media stack. */
function hasMedia(py) {
  try {
    execFileSync(py, ['-c', 'import yt_dlp, faster_whisper'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
    return true
  } catch (e) {
    return false
  }
}

let cached = null

/** Path (or PATH name) of an interpreter with the media packages, else a fallback. */
function python() {
  if (cached) return cached
  for (const c of candidates()) {
    const explicit = c === process.env.JARVIS_PY || c === process.env.PYTHON
    const bare = c === 'python' || c === 'python3'
    if (explicit) {
      cached = c
      return c
    }
    if (!bare) {
      try {
        if (!fs.existsSync(c)) continue
      } catch (e) {
        continue
      }
    }
    if (hasMedia(c)) {
      cached = c
      return c
    }
  }
  cached = isWin ? 'python' : 'python3'
  return cached
}

module.exports = { python, candidates, hasMedia }
