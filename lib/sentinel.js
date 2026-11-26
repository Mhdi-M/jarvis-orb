'use strict'
/**
 * Sentinel — the machine watching its own machine.
 *
 * Not a scanner with a virus database (Windows Defender owns that). This is the
 * layer that notices *change*: a new startup entry, a new listener, a scheduled
 * task that appeared overnight, Defender or the firewall switched off, the
 * hosts file edited, a process whose name or command line is a known tool for
 * credential theft or cryptomining. First scan becomes the baseline; later
 * scans are diffed against it, and only deltas are raised.
 *
 * Everything is read-only PowerShell: it never changes, kills or removes.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const DIR = path.join(__dirname, '..', 'data', 'security')
const BASE = path.join(DIR, 'sentinel-baseline.json')
const LOG = path.join(DIR, 'sentinel.jsonl')

const SUSPICIOUS = [
  { re: /mimikatz|lazagne|procdump|comsvcs\.dll|cobaltstrike|meterpreter|beacon\.exe/i, why: 'credential theft tooling' },
  { re: /xmrig|minerd|cpuminer|nicehash|phoenixminer/i, why: 'cryptominer' },
  { re: /\bnc\.exe\b|\bncat\b|\bsocat\b|netcat/i, why: 'raw network shell' },
  { re: /keylog|keylogger|hookdump/i, why: 'keylogger' },
  { re: /psexec|wmiexec|smbexec/i, why: 'remote execution tool' },
  { re: /rclone\s+.*(?:mega|anonfiles|transfer\.sh)/i, why: 'bulk upload path' },
]

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$d = Get-MpComputerStatus
$f = @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name = $_.Name; enabled = [bool]$_.Enabled } })
$listeners = @(Get-NetTCPConnection -State Listen | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
function RunKeys($p) {
  $k = Get-ItemProperty $p
  if (-not $k) { return @() }
  $k.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { [pscustomobject]@{ name = $_.Name; value = [string]$_.Value } }
}
$run = @(RunKeys 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run') + @(RunKeys 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object { [string]($_.TaskPath + $_.TaskName) })
$hosts = @(Get-Content (Join-Path $env:WINDIR 'System32\\drivers\\etc\\hosts') | Where-Object { $_ -and $_ -notmatch '^\\s*#' } | ForEach-Object { $_.Trim() })
$procs = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ name = $_.Name; cmd = [string]$_.CommandLine } })
[pscustomobject]@{
  at = (Get-Date).ToString('o')
  defender = [pscustomobject]@{
    enabled = [bool]$d.AntivirusEnabled
    realtime = [bool]$d.RealTimeProtectionEnabled
    signatureAgeDays = if ($d.AntivirusSignatureAge -ne $null) { [int]$d.AntivirusSignatureAge } else { $null }
    signatureVersion = [string]$d.AntivirusSignatureVersion
  }
  firewall = $f
  listeners = $listeners
  runKeys = $run
  tasks = $tasks
  hosts = $hosts
  processes = $procs
} | ConvertTo-Json -Depth 5 -Compress
`

function ps(script, timeout = 45000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 12 << 20 },
      (err, stdout) => {
        const text = String(stdout || '').trim()
        if (!text) return resolve({ ok: false, error: err ? err.message : 'no output' })
        try { resolve({ ok: true, data: JSON.parse(text) }) } catch (e) { resolve({ ok: false, error: 'bad output: ' + text.slice(0, 120) }) }
      })
  })
}

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }) } catch {} }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** Pure: suspicious process names/command lines from a scan. */
function suspicious(processes) {
  const hits = []
  for (const p of Array.isArray(processes) ? processes : []) {
    const hay = String((p && p.name) || '') + ' ' + String((p && p.cmd) || '')
    for (const s of SUSPICIOUS) if (s.re.test(hay)) hits.push({ name: p.name, why: s.why, cmd: String(p.cmd || '').slice(0, 160) })
  }
  return hits
}

const normList = (a) => (Array.isArray(a) ? a.map((x) => String(typeof x === 'object' ? JSON.stringify(x) : x)).sort() : [])

/** Pure: compare a scan against the baseline and return only findings. */
function diff(base, cur) {
  const out = []
  if (!cur) return [{ level: 'high', area: 'sentinel', detail: 'scan failed, nothing to compare' }]

  const d = cur.defender || {}
  if (d.enabled === false) out.push({ level: 'high', area: 'defender', detail: 'Microsoft Defender antivirus is off' })
  if (d.realtime === false) out.push({ level: 'high', area: 'defender', detail: 'Defender real-time protection is off' })
  if (Number.isFinite(d.signatureAgeDays) && d.signatureAgeDays > 7) out.push({ level: 'medium', area: 'defender', detail: 'Defender signatures are ' + d.signatureAgeDays + ' days old' })

  for (const f of Array.isArray(cur.firewall) ? cur.firewall : []) {
    if (f && f.enabled === false) out.push({ level: 'high', area: 'firewall', detail: 'firewall profile ' + f.name + ' is off' })
  }

  const hits = suspicious(cur.processes)
  for (const h of hits) out.push({ level: 'high', area: 'process', detail: 'suspicious process ' + h.name + ' (' + h.why + ')' })

  if (base) {
    const bPorts = new Set(normList(base.listeners))
    for (const p of normList(cur.listeners)) if (!bPorts.has(p)) out.push({ level: 'medium', area: 'network', detail: 'new listening port ' + p })
    const bRun = new Set(normList((base.runKeys || []).map((r) => r && r.name)))
    for (const r of Array.isArray(cur.runKeys) ? cur.runKeys : []) {
      if (r && !bRun.has(r.name)) out.push({ level: 'high', area: 'startup', detail: 'new startup entry ' + r.name })
    }
    const bTasks = new Set(normList(base.tasks))
    for (const t of normList(cur.tasks)) if (!bTasks.has(t)) out.push({ level: 'medium', area: 'persistence', detail: 'new scheduled task ' + t })
    const bHosts = new Set(normList(base.hosts))
    for (const h of normList(cur.hosts)) if (!bHosts.has(h)) out.push({ level: 'medium', area: 'dns', detail: 'hosts file changed: ' + h.slice(0, 90) })
  }
  return out
}

function saveBaseline(scan) {
  ensureDir()
  const base = { at: new Date().toISOString(), ...scan }
  try { fs.writeFileSync(BASE, JSON.stringify(base, null, 2)) } catch {}
  return base
}

function logRow(row) {
  ensureDir()
  try { fs.appendFileSync(LOG, JSON.stringify(row) + '\n', { mode: 0o600 }) } catch {}
}

/** Run one scan. */
async function scan() {
  const r = await ps(SCRIPT)
  if (!r.ok) return r
  return { ok: true, data: r.data }
}

/** Scan and diff. `setBase` makes this scan the new normal. */
async function check(opts = {}) {
  const r = await scan()
  if (!r.ok) return { ok: false, error: r.error, findings: [] }
  const base = opts.base !== undefined ? opts.base : readJson(BASE, null)
  const findings = diff(base, r.data)
  logRow({ at: new Date().toISOString(), findings, scanned: true })
  if (opts.setBase || (!base && opts.bootstrap !== false)) saveBaseline(r.data)
  return { ok: true, findings, data: r.data, baseline: base ? base.at : null, created: !base }
}

function baseline() { const b = readJson(BASE, null); return b ? { at: b.at, ports: (b.listeners || []).length, tasks: (b.tasks || []).length } : null }
function recent(n = 30) {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)) } catch { return [] }
}

/** Watch on an interval; fires onAlert only for high findings, throttled upstream. */
function watch(opts = {}) {
  const every = Math.max(60000, opts.intervalMs || 600000)
  let timer = null
  const tick = async () => {
    const r = await check()
    if (r.ok && r.findings && r.findings.length && opts.onFinding) {
      try { opts.onFinding(r.findings) } catch {}
    }
    return r
  }
  const first = setTimeout(tick, 8000)
  if (first.unref) first.unref()
  timer = setInterval(tick, every)
  if (timer.unref) timer.unref()
  return () => { clearInterval(timer); clearTimeout(first) }
}

module.exports = { scan, check, diff, suspicious, baseline, recent, watch, saveBaseline, BASE, LOG, SCRIPT }
