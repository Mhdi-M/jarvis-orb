'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const scratch = fs.mkdtempSync(path.join('C:/Users/you/AppData/Local/hermes/cache/scratch/', 'jarvis-dashboard-'))
process.env.JARVIS_CALENDAR_FILE = path.join(scratch, 'calendar.json')
const dashboard = require('../lib/dashboard.js')

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({
      server: s,
      url: `http://127.0.0.1:${s.address().port}`,
    }))
  })
}

test('calendar CRUD persists bounded validated local events', async () => {
  fs.rmSync(process.env.JARVIS_CALENDAR_FILE, { force: true })
  const added = await dashboard.calendarAdd({ title: 'Dentist', at: '2030-05-06T10:30:00.000Z' })
  assert.match(added.id, /^[a-f0-9-]{36}$/)
  assert.equal(added.title, 'Dentist')
  assert.equal((await dashboard.calendarList()).length, 1)
  assert.deepEqual(await dashboard.calendarDelete(added.id), { deleted: true, id: added.id })
  assert.deepEqual(await dashboard.calendarList(), [])
  await assert.rejects(() => dashboard.calendarAdd({ title: '', at: 'bad date' }), /title|date/i)
})

test('weather uses geocoding and forecast data with explicit city', async () => {
  const api = await server((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/search')) return res.end(JSON.stringify({ results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35, country: 'France' }] }))
    res.end(JSON.stringify({ current: { time: '2030-01-01T12:00', temperature_2m: 12.5, relative_humidity_2m: 60, apparent_temperature: 12, weather_code: 1, wind_speed_10m: 4 }, hourly: { time: [], temperature_2m: [] } }))
  })
  try {
    const value = await dashboard.weather(' Paris ', { geocodingUrl: `${api.url}/search`, forecastUrl: api.url })
    assert.equal(value.city.name, 'Paris')
    assert.equal(value.city.country, 'France')
    assert.equal(value.city.latitude, 48.85)
    assert.equal(value.city.longitude, 2.35)
    assert.equal(value.current.temperature, 12.5)
    assert.equal(value.source, 'Open-Meteo')
    assert.ok(value.sampledAt)
  } finally { api.server.close() }
})

test('weather rejects missing city and bounded bad responses', async () => {
  await assert.rejects(() => dashboard.weather(''), /city/i)
  const api = await server((req, res) => { res.statusCode = 500; res.end('no') })
  try { await assert.rejects(() => dashboard.weather('Paris', { geocodingUrl: api.url, forecastUrl: api.url }), /HTTP 500/) } finally { api.server.close() }
})

test('hardware returns structured unavailable fields without fabrication', async () => {
  const value = await dashboard.hardware({
    cpuPercent: async () => 23.5,
    windows: async () => ({ error: 'simulated OS query failure' }),
    gpu: async () => ({ temperature: null, utilization: null, vramUsed: null, vramTotal: null, fan: null }),
    drives: async () => [{ volume: 'C:', total: null, used: null, free: null, usedPercent: null }],
  })
  assert.equal(value.cpu.usage, 23.5)
  assert.equal(value.cpu.temperature, null)
  assert.equal(value.cpu.fan, null)
  assert.deepEqual(value.disks[0], { volume: 'C:', total: null, used: null, free: null, usedPercent: null })
  assert.equal(value.gpu.temperature, null)
  assert.equal(value.network.source, 'OS network adapter counters')
  assert.ok(value.sampledAt)
})

test('hardware coalesces concurrent calls and caches for 20 seconds', async () => {
  let calls = 0
  const probe = { cpuPercent: async () => { calls++; return 1 }, windows: async () => ({}), gpu: async () => ({}), drives: async () => [] }
  dashboard._resetHardwareCache()
  const [a, b] = await Promise.all([dashboard.hardware(probe), dashboard.hardware(probe)])
  assert.equal(calls, 1)
  assert.strictEqual(a, b)
  assert.strictEqual(await dashboard.hardware(probe), a)
})

test('http helper rejects oversized responses', async () => {
  const api = await server((req, res) => res.end(JSON.stringify({ pad: 'x'.repeat(5000) })))
  try { await assert.rejects(() => dashboard._internals.getJson(api.url, { maxBytes: 1000 }), /too large/) } finally { api.server.close() }
})

test('calendar rejects corrupt storage and invalid dates', async () => {
  fs.writeFileSync(process.env.JARVIS_CALENDAR_FILE, '{nope')
  await assert.rejects(() => dashboard.calendarList(), /corrupt/)
  fs.rmSync(process.env.JARVIS_CALENDAR_FILE, { force: true })
  await assert.rejects(() => dashboard.calendarAdd({ title: 'x', at: 'not-a-date' }), /invalid date/)
})
