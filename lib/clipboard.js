'use strict'
/**
 * System clipboard and file pickers for the TUI.
 *
 * The terminal cannot give us a real clipboard API, so everything goes through
 * PowerShell (Get-Clipboard / Set-Clipboard / WinForms dialogs). Each call is a
 * short-lived process, so a hung dialog can never block the UI thread: callers
 * await a promise with a timeout.
 *
 * Exposed:
 *   readText()            clipboard as text ('' when empty)
 *   writeText(s)          put text on the clipboard
 *   readFiles()           FileDropList: paths copied from Explorer
 *   pickFiles()           multi-select open dialog -> [paths]
 *   pickFolder()          folder browser -> path | null
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

function ps(script, timeout = 20000) {
  const prelude = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; '
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-STA', '-Command', prelude + script],
      { windowsHide: true, timeout, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim(),
      }))
  })
}

async function readText() {
  const r = await ps('Get-Clipboard -Raw')
  return r.ok ? r.out : ''
}

async function writeText(text) {
  const tmp = path.join(os.tmpdir(), 'jarvis-clip-' + process.pid + '-' + Date.now() + '.txt')
  fs.writeFileSync(tmp, String(text == null ? '' : text), 'utf8')
  const r = await ps("Get-Content -Raw -Encoding UTF8 -LiteralPath '" + tmp.replace(/'/g, "''") + "' | Set-Clipboard")
  try { fs.unlinkSync(tmp) } catch (e) { /* temp file is best effort */ }
  return r.ok
}

async function readFiles() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$list = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($list) { foreach ($f in $list) { $f } }',
  ].join('; ')
  const r = await ps(script, 15000)
  if (!r.ok || !r.out) return []
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

async function pickFiles(title) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = '" + String(title || 'Attach to Jarvis').replace(/'/g, "''") + "'",
    "$d.Filter = 'All files (*.*)|*.*|Images|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp|Audio|*.wav;*.mp3;*.m4a;*.ogg;*.opus;*.flac|Video|*.mp4;*.mkv;*.webm;*.mov;*.avi'",
    '$d.Multiselect = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames }',
  ].join('; ')
  const r = await ps(script, 120000)
  if (!r.ok || !r.out) return []
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

async function pickFolder(title) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '" + String(title || 'Attach a folder to Jarvis').replace(/'/g, "''") + "'",
    '$d.ShowNewFolderButton = $false',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
  ].join('; ')
  const r = await ps(script, 120000)
  return r.ok && r.out ? r.out : null
}

module.exports = { readText, writeText, readFiles, pickFiles, pickFolder }
