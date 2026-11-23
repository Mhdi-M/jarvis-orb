import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReminder, whenLabel, parseNote } from '../lib/reminders.mjs'

const NOW = new Date('2026-11-23T20:00:00')

test('relative minutes', () => {
  const r = parseReminder('remind me in 10 minutes to drink water', NOW)
  assert.equal(r.kind, 'reminder')
  assert.equal(r.inMs, 600000)
  assert.equal(r.task, 'drink water')
  assert.match(r.when, /in 10 min/)
})

test('relative seconds and hours', () => {
  assert.equal(parseReminder('timer 30 seconds', NOW).inMs, 30000)
  assert.equal(parseReminder('remind me in 2 hours to stretch', NOW).inMs, 7200000)
  assert.equal(parseReminder('remind me in 1 day to renew', NOW).inMs, 86400000)
})

test('clock time later today', () => {
  const r = parseReminder('remind me at 21:30 to call mom', NOW)
  const d = new Date(r.at)
  assert.equal(d.getHours(), 21)
  assert.equal(d.getMinutes(), 30)
  assert.equal(r.task, 'call mom')
})

test('clock time already passed rolls to tomorrow', () => {
  const r = parseReminder('remind me at 9 to send the report', NOW)
  const d = new Date(r.at)
  assert.equal(d.getHours(), 9)
  assert.ok(r.at > NOW.getTime() + 12 * 3600000)
})

test('tomorrow + am/pm', () => {
  const r = parseReminder('remind me tomorrow at 7 am to run', NOW)
  const d = new Date(r.at)
  assert.equal(d.getHours(), 7)
  assert.ok(d.getDate() === new Date(NOW.getTime() + 86400000).getDate())
})

test('timer word sets kind', () => {
  assert.equal(parseReminder('timer 5 min', NOW).kind, 'timer')
  assert.equal(parseReminder('remind me in 5 min to eat', NOW).kind, 'reminder')
})

test('non-reminders fall through', () => {
  assert.equal(parseReminder('what is the capital of France?', NOW), null)
  assert.equal(parseReminder('open notepad', NOW), null)
  assert.equal(parseReminder('remind me about the meeting', NOW), null) // no time
  assert.equal(parseReminder('remind me in 400 days to x', NOW), null) // too far
})

test('task text is cleaned', () => {
  const r = parseReminder('please remind me in 5 minutes to take the bins out', NOW)
  assert.equal(r.task, 'take the bins out')
})

test('whenLabel is human', () => {
  assert.equal(whenLabel(NOW.getTime() + 30000, NOW), 'in under a minute')
  assert.equal(whenLabel(NOW.getTime() + 5 * 60000, NOW), 'in 5 min')
  assert.match(whenLabel(new Date('2026-11-23T22:15:00').getTime(), NOW), /22:15/)
  assert.match(whenLabel(new Date('2026-11-24T09:00:00').getTime(), NOW), /tomorrow 09:00/)
})

test('notes', () => {
  assert.deepEqual(parseNote('note: buy milk'), { text: 'buy milk' })
  assert.equal(parseNote('remember that the wifi password is hunter2'), null) // memory layer owns this
  assert.equal(parseNote('remind me in 5 min to x'), null)
  assert.equal(parseNote('what is 2+2'), null)
})
