'use strict'
/**
 * Dashboard backend: weather (Open-Meteo), local calendar, hardware snapshot.
 * No dependencies. Calendar events are LOCAL only (not synced to Google).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { sampler } = require('./cpu.js')

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const HTTP_TIMEOUT_MS = 8000
const HTTP_MAX_BYTES = 256 * 1024
const CAL_MAX_EVENTS = 1000
const CAL_MAX_FILE = 1024 * 1024
const CAL_TITLE_MAX = 200
const HW_CACHE_MS = 20000
const PROBE_TIMEOUT_MS = 10000

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const numOrNull = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return num(n) }

/* ------------------------------------------------------------ http ---- */

function getJson(url, { timeout = HTTP_TIMEOUT_MS, maxBytes = HTTP_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(url) } catch { return reject(new Error('invalid URL')) }
    const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null
    if (!transport) return reject(new Error('unsupported protocol'))
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const req = transport.get(parsed, { headers: { accept: 'application/json', 'user-agent': 'jarvis-orb' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); req.destroy(); return done(reject, new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { req.destroy(); return done(reject, new Error('response too large')) }
        chunks.push(c)
      })
      res.on('end', () => {
        try { done(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(reject, new Error('invalid JSON response')) }
      })
      res.on('error', (e) => done(reject, e))
    })
    // hard wall-clock deadline (socket timeout alone does not bound slow trickles)
    const timer = setTimeout(() => { req.destroy(); done(reject, new Error('request timed out')) }, timeout)
    req.on('error', (e) => done(reject, e))
  })
}

/* --------------------------------------------------------- weather ---- */

/**
 * @param {string} city explicit user-supplied city; never guessed
 * @param {{geocodingUrl?:string, forecastUrl?:string, timeout?:number}} [opts]
 */
async function weather(city, opts = {}) {
  const name = typeof city === 'string' ? city.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 100) throw new Error('city is required (1-100 characters)')
  const reqOpts = { timeout: opts.timeout }
  const geoUrl = `${opts.geocodingUrl || GEOCODING_URL}?${new URLSearchParams({ name, count: '1', language: 'en', format: 'json' })}`
  const geo = await getJson(geoUrl, reqOpts)
  const hit = geo && Array.isArray(geo.results) ? geo.results[0] : null
  if (!hit || num(hit.latitude) === null || num(hit.longitude) === null) throw new Error(`city not found: ${name}`)

  const q = new URLSearchParams({
    latitude: String(hit.latitude), longitude: String(hit.longitude), timezone: 'auto', forecast_days: '3',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
  })
  const base = opts.forecastUrl || FORECAST_URL
  const fc = await getJson(`${base}${base.includes('?') ? '&' : '?'}${q}`, reqOpts)
  const c = fc && fc.current
  if (!c || typeof c !== 'object') throw new Error('forecast response missing current data')
  const d = fc.daily || {}
  const daily = Array.isArray(d.time) ? d.time.slice(0, 7).map((date, i) => ({
    date: String(date),
    weatherCode: numOrNull(d.weather_code && d.weather_code[i]),
    tempMax: numOrNull(d.temperature_2m_max && d.temperature_2m_max[i]),
    tempMin: numOrNull(d.temperature_2m_min && d.temperature_2m_min[i]),
    precipitation: numOrNull(d.precipitation_sum && d.precipitation_sum[i]),
  })) : []
  return {
    city: { name: String(hit.name || name), country: hit.country ? String(hit.country) : null, admin1: hit.admin1 ? String(hit.admin1) : null, latitude: hit.latitude, longitude: hit.longitude, timezone: fc.timezone || hit.timezone || null },
    current: {
      time: c.time ? String(c.time) : null,
      temperature: numOrNull(c.temperature_2m),
      apparentTemperature: numOrNull(c.apparent_temperature),
      humidity: numOrNull(c.relative_humidity_2m),
      precipitation: numOrNull(c.precipitation),
      weatherCode: numOrNull(c.weather_code),
      windSpeed: numOrNull(c.wind_speed_10m),
      windDirection: numOrNull(c.wind_direction_10m),
      isDay: c.is_day === 1 ? true : c.is_day === 0 ? false : null,
    },
    units: fc.current_units || null,
    daily,
    source: 'Open-Meteo',
    sampledAt: new Date().toISOString(),
  }
}

/* -------------------------------------------------------- calendar ---- */

const calFile = () => process.env.JARVIS_CALENDAR_FILE || path.join(__dirname, '..', 'data', 'calendar.json')
let calQueue = Promise.resolve()
const serialize = (fn) => { const run = calQueue.then(fn, fn); calQueue = run.catch(() => {}); return run }

function readEvents() {
  const file = calFile()
  let raw
  try {
    const st = fs.statSync(file)
    if (st.size > CAL_MAX_FILE) throw new Error('calendar file too large')
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  let data
  try { data = JSON.parse(raw) } catch { throw new Error('calendar file is corrupt') }
  const list = Array.isArray(data) ? data : data && data.events
  if (!Array.isArray(list)) throw new Error('calendar file has unexpected shape')
  return list.filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && !Number.isNaN(Date.parse(e.at)))
}

function writeEvents(events) {
  const file = calFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, events }, null, 2))
    fs.renameSync(tmp, file) // atomic replace on the same volume
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

const sorted = (events) => events.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.title.localeCompare(b.title))

/** @returns {Promise<Array<{id:string,title:string,at:string,createdAt:string}>>} local events, soonest first */
function calendarList() { return serialize(async () => sorted(readEvents())) }

/** @param {{title:string, at:string|number|Date}} input */
function calendarAdd(input) {
  return serialize(async () => {
    const title = input && typeof input.title === 'string' ? input.title.trim() : ''
    if (!title || title.length > CAL_TITLE_MAX) throw new Error(`title is required (1-${CAL_TITLE_MAX} characters)`)
    if (/[\u0000-\u001f\u007f]/.test(title)) throw new Error('title contains control characters')
    const raw = input && input.at
    const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : NaN
    if (!Number.isFinite(ms) || (typeof raw === 'string' && raw.trim() === '')) throw new Error('invalid date: "at" must be a valid date/time')
    if (ms < Date.UTC(1970, 0, 1) || ms > Date.UTC(9999, 0, 1)) throw new Error('invalid date: out of range')
    const events = readEvents()
    if (events.length >= CAL_MAX_EVENTS) throw new Error(`calendar is full (${CAL_MAX_EVENTS} events)`)
    const event = { id: crypto.randomUUID(), title, at: new Date(ms).toISOString(), createdAt: new Date().toISOString() }
    events.push(event)
    writeEvents(events)
    return event
  })
}

function calendarDelete(id) {
  return serialize(async () => {
    if (typeof id !== 'string' || !id) throw new Error('event id is required')
    const events = readEvents()
    const next = events.filter((e) => e.id !== id)
    if (next.length === events.length) return { deleted: false, id }
    writeEvents(next)
    return { deleted: true, id }
  })
}

/* -------------------------------------------------------- hardware ---- */

function run(cmd, args, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve(err ? { ok: false, error: err.code === 'ENOENT' ? `${cmd} not found` : String(err.message || err).split('\n')[0] } : { ok: true, out: String(out) })
    })
  })
}
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$r=@{}",
  "try{$r.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object{@{volume=$_.DeviceID;label=$_.VolumeName;fileSystem=$_.FileSystem;total=$_.Size;free=$_.FreeSpace}})}catch{$r.disksError=$_.Exception.Message}",
  "try{$r.battery=@(Get-CimInstance Win32_Battery | ForEach-Object{@{percent=$_.EstimatedChargeRemaining;status=$_.BatteryStatus;runtimeMinutes=$_.EstimatedRunTime}})}catch{$r.batteryError=$_.Exception.Message}",
  "try{$r.network=@(Get-NetAdapterStatistics | ForEach-Object{@{name=$_.Name;rxBytes=[double]$_.ReceivedBytes;txBytes=[double]$_.SentBytes}})}catch{$r.networkError=$_.Exception.Message}",
  "$r | ConvertTo-Json -Depth 5 -Compress",
].join(';')

async function windowsProbe() {
  if (process.platform !== 'win32') return { error: 'OS query only implemented on Windows' }
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT])
  if (!res.ok) return { error: res.error }
  try { return JSON.parse(res.out.trim()) } catch { return { error: 'could not parse PowerShell output' } }
}

async function gpuProbe() {
  const res = await run('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed', '--format=csv,noheader,nounits'], 6000)
  if (!res.ok) return { available: false, error: res.error, gpus: [] }
  const gpus = res.out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, temp, util, used, total, fan] = line.split(',').map((s) => s.trim())
    return { name: name || null, temperature: numOrNull(temp), utilization: numOrNull(util), vramUsedMiB: numOrNull(used), vramTotalMiB: numOrNull(total), fanPercent: numOrNull(fan) }
  })
  return gpus.length ? { available: true, gpus } : { available: false, error: 'nvidia-smi returned no GPUs', gpus: [] }
}

async function cpuPercentProbe() {
  const pct = sampler()
  pct() // prime
  await new Promise((r) => setTimeout(r, 400))
  return pct()
}

let hwCache = null // { at, value }
let hwInflight = null

function _resetHardwareCache() { hwCache = null; hwInflight = null }

async function collectHardware(probes = {}) {
  const startedAt = new Date()
  const [cpuRes, win, gpu] = await Promise.all([
    (probes.cpuPercent || cpuPercentProbe)().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    (probes.windows || windowsProbe)().catch((e) => ({ error: String(e && e.message || e) })),
    (probes.gpu || gpuProbe)().catch((e) => ({ available: false, error: String(e && e.message || e), gpus: [] })),
  ])
  const sampledAt = new Date().toISOString()
  const total = os.totalmem()
  const free = os.freemem()
  const cpus = os.cpus() || []

  let disks
  if (probes.drives) disks = await probes.drives()
  else disks = asArray(win.disks).map((d) => {
    const t = numOrNull(d.total); const f = numOrNull(d.free)
    const used = t !== null && f !== null ? t - f : null
    return { volume: d.volume || null, label: d.label || null, fileSystem: d.fileSystem || null, total: t, free: f, used, usedPercent: used !== null && t > 0 ? +(100 * used / t).toFixed(1) : null }
  })
  const batteries = asArray(win.battery)
  const network = asArray(win.network)
  const first = gpu && Array.isArray(gpu.gpus) && gpu.gpus[0] ? gpu.gpus[0] : {}
  const gpuFlat = gpu && gpu.temperature !== undefined ? gpu : null

  return {
    sampledAt,
    collectedMs: Date.now() - startedAt.getTime(),
    cacheTtlMs: HW_CACHE_MS,
    cpu: {
      model: cpus[0] ? cpus[0].model.trim() : null,
      logicalCores: cpus.length || null,
      usage: cpuRes.ok ? num(cpuRes.v) : null,
      usageSource: 'os.cpus() delta via lib/cpu.js, ~400ms sample',
      temperature: null,
      temperatureNote: 'unavailable: Windows exposes no unprivileged CPU temperature sensor',
      fan: null,
      fanNote: 'unavailable: no unprivileged CPU/system fan sensor on Windows',
      error: cpuRes.ok ? null : String(cpuRes.e && cpuRes.e.message || cpuRes.e),
    },
    ram: { total, free, used: total - free, usedPercent: total > 0 ? +(100 * (total - free) / total).toFixed(1) : null, source: 'os.totalmem/os.freemem' },
    disks,
    disksSource: 'Win32_LogicalDisk DriveType=3 (fixed volumes)',
    disksError: win.error || win.disksError || null,
    battery: {
      present: batteries.length > 0,
      percent: batteries[0] ? numOrNull(batteries[0].percent) : null,
      status: batteries[0] ? numOrNull(batteries[0].status) : null,
      runtimeMinutes: batteries[0] && numOrNull(batteries[0].runtimeMinutes) !== null && batteries[0].runtimeMinutes < 71582788 ? batteries[0].runtimeMinutes : null,
      source: 'Win32_Battery',
      error: win.error || win.batteryError || null,
    },
    gpu: gpuFlat ? { ...gpuFlat, source: 'injected' } : {
      available: !!(gpu && gpu.available),
      name: first.name ?? null,
      temperature: first.temperature ?? null,
      utilization: first.utilization ?? null,
      vramUsedMiB: first.vramUsedMiB ?? null,
      vramTotalMiB: first.vramTotalMiB ?? null,
      fanPercent: first.fanPercent ?? null,
      gpus: gpu && gpu.gpus || [],
      source: 'nvidia-smi',
      error: gpu && gpu.error || null,
    },
    network: {
      adapters: network,
      note: 'cumulative adapter byte counters since adapter start; not internet usage',
      source: 'OS network adapter counters',
      error: win.error || win.networkError || null,
    },
  }
}

/**
 * Detailed snapshot. Cached 20 s; concurrent callers share one in-flight collection.
 * Unavailable numeric fields are null, never invented.
 */
function hardware(probes) {
  if (hwCache && Date.now() - hwCache.at < HW_CACHE_MS) return Promise.resolve(hwCache.value)
  if (hwInflight) return hwInflight
  hwInflight = collectHardware(probes).then((value) => {
    hwCache = { at: Date.now(), value }
    return value
  }).finally(() => { hwInflight = null })
  return hwInflight
}

module.exports = {
  weather, calendarList, calendarAdd, calendarDelete, hardware,
  _resetHardwareCache, _internals: { getJson, collectHardware },
}
