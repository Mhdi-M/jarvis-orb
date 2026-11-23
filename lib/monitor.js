'use strict'
/** Background health watcher. Samples quietly, writes a log, raises alerts only when something is wrong. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const LOG = process.env.JARVIS_MONITOR_LOG || path.join(__dirname, '..', 'data', 'monitor.jsonl')
const LIMITS = { cpu: 90, ram: 90, gpuTemp: 85, diskFreeGb: 15 }

/** Pure: turn one sample into human alerts. */
function evaluate(s, limits = LIMITS) {
  const a = []
  if (s.cpu >= limits.cpu) a.push(`CPU is at ${Math.round(s.cpu)}%`)
  if (s.ram >= limits.ram) a.push(`RAM is at ${Math.round(s.ram)}%`)
  if (s.gpuTemp != null && s.gpuTemp >= limits.gpuTemp) a.push(`GPU is hot: ${Math.round(s.gpuTemp)}\u00b0C`)
  if (s.diskFreeGb != null && s.diskFreeGb <= limits.diskFreeGb) a.push(`Only ${s.diskFreeGb.toFixed(0)} GiB free on C:`)
  return a
}

function run(cmd, args, timeout = 8000) {
  return new Promise((r) => execFile(cmd, args, { timeout, windowsHide: true }, (e, out) => r(e ? '' : String(out).trim())))
}
async function slowProbe() {
  const [gpu, disk, net] = await Promise.all([
    run('nvidia-smi', ['--query-gpu=temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits']),
    run('powershell', ['-NoProfile', '-Command', '(Get-PSDrive C).Free/1GB']),
    run('powershell', ['-NoProfile', '-Command', "(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum | ForEach-Object {$_.Sum}) -join ','"]),
  ])
  const [t, u] = gpu.split(',').map((x) => parseFloat(x))
  const [rx, tx] = net.split(',').map((x) => parseFloat(x))
  const df = parseFloat(disk)
  return { gpuTemp: Number.isFinite(t) ? t : null, gpuUtil: Number.isFinite(u) ? u : null,
           diskFreeGb: Number.isFinite(df) ? df : null, rx: Number.isFinite(rx) ? rx : null, tx: Number.isFinite(tx) ? tx : null }
}

function append(sample) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(sample) + '\n') } catch {}
}
function recent(n = 30) {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)) } catch { return [] }
}

/** Start sampling. cpuFn() returns percent. onAlert(msgs[]) fires at most once per 10 min per message. */
function start({ cpuFn, onAlert, intervalMs = 30000 }) {
  const lastAlert = new Map()
  let slow = {}
  const tick = async () => {
    slow = { ...slow, ...(await slowProbe()) }
    const total = os.totalmem()
    const sample = { t: Date.now(), cpu: cpuFn(), ram: 100 * (1 - os.freemem() / total), ...slow }
    append(sample)
    const fresh = evaluate(sample).filter((m) => Date.now() - (lastAlert.get(m.split(' ')[0]) || 0) > 600000)
    fresh.forEach((m) => lastAlert.set(m.split(' ')[0], Date.now()))
    if (fresh.length && onAlert) onAlert(fresh)
  }
  tick()
  const id = setInterval(tick, intervalMs)
  return () => clearInterval(id)
}
module.exports = { evaluate, start, recent, LIMITS }
