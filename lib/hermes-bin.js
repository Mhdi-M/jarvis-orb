'use strict'
/**
 * Where the Hermes CLI lives, without hard-coding one machine's user folder.
 * HERMES_BIN wins; otherwise the usual install locations are checked.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

function hermesBin() {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN
  const exe = process.platform === 'win32' ? 'hermes.exe' : 'hermes'
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    path.join(local, 'hermes', 'hermes-agent', '.hermes', 'bin', exe),
    path.join(os.homedir(), '.hermes', 'bin', exe),
    path.join(os.homedir(), '.local', 'bin', 'hermes'),
    path.join('/usr', 'local', 'bin', 'hermes'),
  ]
  for (const c of candidates) { try { if (fs.existsSync(c)) return c } catch {} }
  return candidates[0]
}

module.exports = { hermesBin }
