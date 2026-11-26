'use strict'
/**
 * Resolve the Python interpreter that has the optional media helpers installed
 * (yt-dlp, youtube-transcript-api, faster-whisper).
 *
 * Resolution order, first hit wins:
 *   1. JARVIS_PY                explicit override, always trusted
 *   2. PYTHON                   generic override
 *   3. ~/venvs/main/...         the layout the installer suggests
 *   4. ~/.venv/...              a project-local virtualenv
 *   5. python3 / python         whatever is on PATH
 *
 * Nothing here hardcodes a drive letter or a username, so the repo stays
 * portable and reveals nothing about the machine it was written on.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const isWin = process.platform === 'win32'

function candidates() {
  const out = []
  if (process.env.JARVIS_PY) out.push(process.env.JARVIS_PY)
  if (process.env.PYTHON) out.push(process.env.PYTHON)
  const home = os.homedir()
  const rels = isWin
    ? [
        'venvs/main/Scripts/python.exe',
        '.venv/Scripts/python.exe',
        'AppData/Local/Programs/Python/Python313/python.exe',
        'AppData/Local/Programs/Python/Python312/python.exe',
        'AppData/Local/Programs/Python/Python311/python.exe',
      ]
    : ['venvs/main/bin/python', '.venv/bin/python', '.venv/bin/python3', 'venvs/main/bin/python3']
  for (const rel of rels) out.push(path.join(home, rel))
  out.push(isWin ? 'python' : 'python3', 'python')
  return out
}

let cached = null

/** Absolute path to an interpreter if a known one exists, else a PATH name. */
function python() {
  if (cached) return cached
  for (const c of candidates()) {
    if (c === 'python' || c === 'python3') {
      cached = c
      return c
    }
    try {
      if (fs.existsSync(c)) {
        cached = c
        return c
      }
    } catch (e) {
      /* unreadable candidate, keep looking */
    }
  }
  cached = isWin ? 'python' : 'python3'
  return cached
}

module.exports = { python, candidates }
