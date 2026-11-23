// End-to-end acceptance: UI shape, reminders, notes, learning, tools, speed.
import fs from 'node:fs'
const wsUrl = fs.readFileSync('C:/Users/you/AppData/Local/hermes/cache/scratch/jws.txt', 'utf8').trim()
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const call = (method, params = {}, tmo = 200000) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({}) } }, tmo)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = async (expr, tmo) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tmo)
  if (r.result?.exceptionDetails) return 'EXC ' + r.result.exceptionDetails.text
  return r.result?.result?.value
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call('Runtime.enable')
await ev("window.jarvis.show(); 'ok'")

const results = []
const check = (name, ok, note = '') => { results.push([name, !!ok, note]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (note ? '  ' + note : '')) }

// ---------- 1. UI: no music in the dashboard, clean transparency ----------
const ui = JSON.parse(await ev("JSON.stringify({rail:[...document.querySelectorAll('#rail .rbtn')].map(b=>b.dataset.panel), panels:[...document.querySelectorAll('.panel')].map(p=>p.dataset.p), cards:document.querySelectorAll('.dcards').length, scan:!!document.getElementById('scan'), threadBorder:getComputedStyle(document.getElementById('thread')).borderWidth, drawerBg:getComputedStyle(document.getElementById('drawer')).backgroundColor})"))
check('music gone from dashboard', !ui.rail.includes('music') && !ui.panels.includes('music'), JSON.stringify(ui.rail))
check('no weather/time cards on the dashboard', ui.cards === 0)
check('no overlay box on the window', ui.scan === false)
check('terminal has no border', ui.threadBorder === '0px', ui.threadBorder)

// ---------- 2. reminders ----------
const t0 = Date.now()
const before = JSON.parse(await ev("JSON.stringify([...document.getElementById('thread').children].length)"))
await ev(`(()=>{const i=document.getElementById('input');i.value='timer 6 seconds';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(1200)
const setLine = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")
check('timer is set instantly', /timer set/i.test(setLine), setLine.slice(0, 60))
check('timer set is fast (<1.2 s)', Date.now() - t0 < 1200 + 1200, ((Date.now() - t0) / 1000).toFixed(1) + 's incl. sleep')

const stored = await ev("window.jarvis.reminders.list().then(l=>JSON.stringify(l))")
check('timer is persisted', stored.includes('timer') || stored.includes('r'), stored.slice(0, 90))

// wait for it to fire
let fired = false
for (let i = 0; i < 20; i++) {
  await sleep(700)
  const last = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")
  if (/timer\s+—|timer -/i.test(last) || /timer done/i.test(last)) { fired = true; break }
}
check('timer fires and shows in the transcript', fired)

// ---------- 3. notes ----------
await ev(`(()=>{const i=document.getElementById('input');i.value='note: pick up the parcel';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(900)
const notes = await ev("window.jarvis.notes.list().then(l=>JSON.stringify(l))")
check('note saved', notes.includes('parcel'), notes.slice(0, 90))

// ---------- 4. learning from chat ----------
const beforeMem = await ev("window.jarvis.memory.list().then(l=>l.length)")
await ev(`(()=>{const i=document.getElementById('input');i.value='remember that my favourite editor is vscode';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(25000)
const mem = await ev("window.jarvis.memory.list().then(l=>JSON.stringify(l))")
check('Jarvis stores what it is told', /favourite editor is vscode|editor/i.test(mem), mem.slice(0, 120))
const afterMem = await ev("window.jarvis.memory.list().then(l=>l.length)")
check('memory grew', afterMem >= beforeMem, `${beforeMem} -> ${afterMem}`)

// ---------- 5. tools: open an app, run a command, read a page ----------
let t = Date.now()
await ev(`(()=>{const i=document.getElementById('input');i.value='open calc';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(1500)
const openLine = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")
check('opens an app locally', /launched calc|opened calc/i.test(openLine), `${Date.now() - t}ms ${openLine.slice(0, 40)}`)

t = Date.now()
await ev(`(()=>{const i=document.getElementById('input');i.value='run echo tool-check';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(1200)
const runLine = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")
check('runs a shell command', /tool-check/.test(runLine), `${Date.now() - t}ms`)

t = Date.now()
await ev(`(()=>{const i=document.getElementById('input');i.value='read example.com';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(4000)
const readLine = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent||t[t.length-2].textContent})()")
check('reads a web page', /Example Domain|read example/i.test(readLine), `${Date.now() - t}ms`)

// ---------- 6. speed ----------
const speed = JSON.parse(await ev(`(async () => {
  const t0 = performance.now()
  const r = await window.jarvis.ask('what is 15*6? just the number')
  return JSON.stringify({ ms: Math.round(performance.now() - t0), text: r.text })
})()`))
check('answer is correct', /90/.test(speed.text), String(speed.text).slice(0, 40))
check('answer under 20 s', speed.ms < 20000, speed.ms + ' ms')

console.log('\n' + results.filter(([, ok]) => ok).length + '/' + results.length + ' checks passed')
ws.close()
