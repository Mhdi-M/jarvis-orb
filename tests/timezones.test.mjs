import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRESETS, MAX_ZONES, isValidZone, zoneTime, dayOffset,
  labelFor, addZone, removeZone, normalizeZones,
} from '../lib/timezones.mjs'

const AT = new Date('2026-11-23T12:00:00Z')

test('isValidZone: accepts IANA names', () => {
  assert.equal(isValidZone('Asia/Tokyo'), true)
  assert.equal(isValidZone('America/New_York'), true)
  assert.equal(isValidZone('UTC'), true)
  assert.equal(isValidZone('GMT+3'), false)
})

test('isValidZone: rejects junk without throwing', () => {
  for (const bad of ['', null, undefined, 42, {}, '../etc/passwd', 'Mars/Olympus', 'x'.repeat(80)]) {
    assert.equal(isValidZone(bad), false, String(bad))
  }
})

test('zoneTime: formats known offsets', () => {
  assert.equal(zoneTime(AT, 'Asia/Tokyo'), '21:00')       // +9
  assert.equal(zoneTime(AT, 'America/New_York'), '07:00') // -5 in November
  assert.equal(zoneTime(AT, 'Europe/London'), '12:00')    // GMT
  assert.equal(zoneTime(AT, 'Asia/Kolkata'), '17:30')     // +5:30
})

test('zoneTime: always two digits', () => {
  const t = zoneTime(AT, 'Asia/Tokyo')
  assert.match(t, /^\d{2}:\d{2}$/)
})

test('zoneTime: bad zone degrades to a placeholder', () => {
  assert.equal(zoneTime(AT, 'Nowhere/Land'), '--:--')
})

test('dayOffset: same-day zones are zero against UTC', () => {
  assert.equal(dayOffset(AT, 'Europe/London', 'UTC'), 0)
  assert.equal(dayOffset(AT, 'Asia/Tokyo', 'UTC'), 0)
})

test('dayOffset: crosses midnight ahead and behind', () => {
  const late = new Date('2026-11-23T23:30:00Z')
  assert.equal(dayOffset(late, 'Asia/Tokyo', 'UTC'), 1)          // 08:30 next day
  assert.equal(dayOffset(late, 'America/Los_Angeles', 'UTC'), 0) // 15:30 same day
  const early = new Date('2026-11-23T02:00:00Z')
  assert.equal(dayOffset(early, 'America/Los_Angeles', 'UTC'), -1)
})

test('labelFor: presets get friendly names, others get the city', () => {
  assert.equal(labelFor('Asia/Tokyo'), 'Tokyo')
  assert.equal(labelFor('America/New_York'), 'New York')
  assert.equal(labelFor('Africa/Casablanca'), 'Casablanca')
  assert.equal(labelFor('Pacific/Port_Moresby'), 'Port Moresby')
})

test('addZone: appends valid zones once', () => {
  assert.deepEqual(addZone([], 'Asia/Tokyo'), ['Asia/Tokyo'])
  assert.deepEqual(addZone(['Asia/Tokyo'], 'Asia/Tokyo'), ['Asia/Tokyo'])
  assert.deepEqual(addZone(['Asia/Tokyo'], 'Europe/London'), ['Asia/Tokyo', 'Europe/London'])
})

test('addZone: ignores invalid zones', () => {
  assert.deepEqual(addZone([], 'Nope/Nope'), [])
  assert.deepEqual(addZone(['Asia/Tokyo'], 42), ['Asia/Tokyo'])
})

test('addZone: caps the list, dropping the oldest', () => {
  let list = []
  for (const p of PRESETS) list = addZone(list, p.tz, 3)
  assert.equal(list.length, 3)
  assert.deepEqual(list, PRESETS.slice(-3).map((p) => p.tz))
  assert.equal(MAX_ZONES, 4)
})

test('removeZone: removes only the requested zone', () => {
  assert.deepEqual(removeZone(['Asia/Tokyo', 'Europe/London'], 'Asia/Tokyo'), ['Europe/London'])
  assert.deepEqual(removeZone(['Asia/Tokyo'], 'Europe/London'), ['Asia/Tokyo'])
  assert.deepEqual(removeZone(null, 'Asia/Tokyo'), [])
})

test('normalizeZones: cleans anything from storage', () => {
  assert.deepEqual(normalizeZones('["Asia/Tokyo","bogus","Asia/Tokyo"]'), ['Asia/Tokyo'])
  assert.deepEqual(normalizeZones('not json'), [])
  assert.deepEqual(normalizeZones(null), [])
  assert.deepEqual(normalizeZones(['Europe/London', 'Europe/London', 'Europe/Berlin']), ['Europe/London', 'Europe/Berlin'])
})

test('normalizeZones: enforces the cap', () => {
  const many = PRESETS.map((p) => p.tz)
  assert.equal(normalizeZones(many).length, MAX_ZONES)
  assert.equal(normalizeZones(many, 2).length, 2)
})

test('every preset is a valid zone with a label', () => {
  for (const p of PRESETS) {
    assert.equal(isValidZone(p.tz), true, p.tz)
    assert.ok(p.label && p.label.length > 1, p.tz)
    assert.ok(!/[\/_]/.test(p.label), 'labels should be human readable: ' + p.label)
  }
})
