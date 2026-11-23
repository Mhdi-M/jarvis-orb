// Final verification from the new location (D:\Repositories\jarvis-orb).
import fs from 'node:fs'
const S = 'C:/Users/you/AppData/Local/hermes/cache/scratch/'
const wsUrl = fs.readFileSync(S + 'jws2.txt', 'utf8').trim()
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const call = (method, params = {}, tmo = 240000) => new Promise((res) => {
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

const out = {}

// 1 — memory recall through the agent
const t0 = Date.now()
const recall = await ev(`(async () => { const r = await window.jarvis.ask('what is my favourite editor? one word'); return JSON.stringify(r) })()`)
out.recall = { ms: Date.now() - t0, text: String(JSON.parse(recall).text).slice(0, 60) }

// 2 — offline mode (no model): local intents only
await ev("window.jarvis.control.set({ preferLocal: true }).then(()=>'local')")
const t1 = Date.now()
const off = await ev(`(async () => { const r = await window.jarvis.ask('system health'); return JSON.stringify(r) })()`)
out.offline = { ms: Date.now() - t1, text: String(JSON.parse(off).text).slice(0, 120), offline: JSON.parse(off).offline === true }
await ev("window.jarvis.control.set({ preferLocal: false }).then(()=>'cloud')")

// 3 — open a site
await ev(`(()=>{const i=document.getElementById('input');i.value='open github.com';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(1200)
out.openSite = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")

// 4 — read a site
await ev(`(()=>{const i=document.getElementById('input');i.value='read example.com';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(3500)
out.readSite = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent.slice(0,80)})()")

// 5 — open an app
await ev(`(()=>{const i=document.getElementById('input');i.value='open notepad';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('inputbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`)
await sleep(1500)
out.openApp = await ev("(()=>{const t=document.getElementById('thread').children;return t[t.length-1].textContent})()")

// 6 — straight answer timing
const t2 = Date.now()
const ans = await ev(`(async () => { const r = await window.jarvis.ask('what is 21*2? just the number'); return JSON.stringify(r) })()`)
out.answer = { ms: Date.now() - t2, text: String(JSON.parse(ans).text).slice(0, 40) }

// 7 — what it remembers
out.memory = await ev("window.jarvis.memory.list().then(l=>JSON.stringify(l.slice(0,6)))")
out.notes = await ev("window.jarvis.notes.list().then(l=>JSON.stringify(l.slice(0,3)))")
out.zones = await ev("(()=>{const n=JSON.parse(localStorage.getItem('jarvis.tz')||'[]');return JSON.stringify(n)})()")

console.log(JSON.stringify(out, null, 1))
ws.close()
