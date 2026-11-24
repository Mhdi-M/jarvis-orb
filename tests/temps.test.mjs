import test from 'node:test'
import assert from 'node:assert/strict'
import {
  kelvinTenthsToC, parseNvidiaSmi, parseThermalZone, parseStorageTemp, tempBand, tempLabel,
} from '../lib/temps.mjs'

test('kelvin tenths convert and sanity-clamp', () => {
  assert.ok(Math.abs(kelvinTenthsToC(3012) - 28.05) < 0.06)   // 301.2 K
  assert.ok(Math.abs(kelvinTenthsToC('3182') - 45.05) < 0.06)  // 318.2 K
  assert.equal(kelvinTenthsToC(0), null)
  assert.equal(kelvinTenthsToC('nonsense'), null)
  // a bogus 900 K reading must not show up as a temperature
  assert.equal(kelvinTenthsToC(9000), null)
})

test('nvidia-smi line: temp, name, utilisation', () => {
  assert.deepEqual(parseNvidiaSmi('74, NVIDIA GeForce RTX 3070, 38'), { temp: 74, name: 'NVIDIA GeForce RTX 3070', util: 38 })
  assert.deepEqual(parseNvidiaSmi('51, NVIDIA GeForce GTX 1660, [N/A]\n'), { temp: 51, name: 'NVIDIA GeForce GTX 1660', util: null })
  assert.equal(parseNvidiaSmi(''), null)
  assert.equal(parseNvidiaSmi('0, x, 0'), null)
})

test('thermal zone WMI output', () => {
  assert.equal(parseThermalZone('CurrentTemperature : 3282'), 55.1)
  assert.equal(parseThermalZone('CurrentTemperature\n3282\n'), 55.1)
  assert.equal(parseThermalZone(''), null)
  assert.equal(parseThermalZone('No Instance(s) Available.'), null)
})

test('storage reliability temperature', () => {
  assert.equal(parseStorageTemp('41'), 41)
  assert.equal(parseStorageTemp('\r\n41\r\n'), 41)
  assert.equal(parseStorageTemp('0'), null)      // the counter is 0 when unknown
  assert.equal(parseStorageTemp(''), null)
})

test('bands drive the colour of the reading', () => {
  assert.equal(tempBand(null), 'none')
  assert.equal(tempBand(45), 'cool')
  assert.equal(tempBand(72), 'warm')
  assert.equal(tempBand(91), 'hot')
})

test('labels round and fall back', () => {
  assert.equal(tempLabel(58.4), '58\u00b0C')
  assert.equal(tempLabel(null), 'n/a')
})
