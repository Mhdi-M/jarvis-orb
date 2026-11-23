// Real-mouse audit of the notch: hover the pill, open the panel, click each
// control with Input.dispatchMouseEvent and report what actually changed.
// usage: node tools/notch-audit.mjs
import fs from 'node:fs'

const wsUrl = fs.readFileSync('C:/Users/you/AppData/Local/hermes/cache/scratch/nws.txt', 'utf8').trim()
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})

const call = (method, params = {}) => new Promise((res) => {
  const myId = ++id
  pending.set(myId, res)
  ws.send(JSON.stringify({ id: myId, method, params }))
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({}) } }, 8000)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await new Promise((res, rej) => {
  if (ws.readyState === 1) return res()
  ws.addEventListener('open', () => res(), { once: true })
  ws.addEventListener('error', (e) => rej(new Error('ws error')), { once: true })
})

async function ev(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (!r || !r.result) return null
  if (r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.text || '')
  const out = r.result.result
  return out ? out.value : null
}

async function mouse(type, x, y) {
  await call('Input.dispatchMouseEvent', {
    type, x, y, button: 'left',
    clickCount: type.includes('Pressed') || type.includes('Released') ? 1 : 0,
    buttons: type === 'mousePressed' ? 1 : 0,
  })
}

async function clickAt(p) {
  await mouse('mouseMoved', p.x, p.y)
  await sleep(50)
  await mouse('mousePressed', p.x, p.y)
  await sleep(40)
  await mouse('mouseReleased', p.x, p.y)
  await sleep(260)
}

async function rect(sel) {
  return ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:Math.round(r.width),h:Math.round(r.height)}})()`)
}

await call('Runtime.enable')
await call('Page.enable')

// start on page 0
await ev("document.getElementById('dots')?.children[0]?.click(); 'p0'")
await sleep(600)

const pill = await rect('#pill')
console.log('pill:', JSON.stringify(pill))
await mouse('mouseMoved', pill.x, pill.y)
await sleep(800)
console.log('body:', await ev('document.body.className'))
console.log('panel:', JSON.stringify(await rect('#panel')))

const results = {}

async function step(name, sel, after) {
  const p = await rect(sel)
  if (!p) { results[name] = 'missing'; console.log(name, '-> missing'); return null }
  const offscreen = p.x < 0 || p.y < 0 || p.x > 560 || p.y > 400
  await clickAt(p)
  const state = after ? await ev(after) : null
  results[name] = { at: [Math.round(p.x), Math.round(p.y)], offscreen, state }
  console.log(name, '->', JSON.stringify(results[name]))
  return state
}

// 1 — timezone control
await step('tz-add', '#tz-add', "(()=>{const m=document.getElementById('tzmenu');return JSON.stringify({hidden:m.hidden,n:m.children.length})})()")
const tokyoPt = await ev("(()=>{const b=[...document.getElementById('tzmenu').children].find(x=>x.textContent==='Tokyo');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
if (tokyoPt) {
  await clickAt(tokyoPt)
  console.log('tz after Tokyo ->', await ev("JSON.stringify({zones:localStorage.getItem('jarvis.tz'),rows:[...document.querySelectorAll('#tzs .tz')].map(r=>r.textContent.trim())})"))
}

// 2 — quick monitor toggle
await step('quick-monitor', '#quick-monitor', "document.getElementById('quick-monitor').textContent")

// 3 — refresh
await step('quick-refresh', '#quick-refresh', "'clicked'")

// 4 — page dots
const dot = await ev("(()=>{const d=document.getElementById('dots').children[1];const r=d.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
await clickAt(dot)
console.log('after dot#2 ->', await ev("JSON.stringify({page:[...document.querySelectorAll('.page')].findIndex(p=>p.classList.contains('active')),transform:document.getElementById('pages').style.transform})"))

// 5 — back to page 3 (music page) and hit its buttons
await ev("document.getElementById('dots').children[2].click(); 'p3'")
await sleep(700)
await step('m-pick', '#m-pick', "'picked'")
await eval_ignore()
async function eval_ignore() {}

// 6 — clipboard page
await ev("document.getElementById('dots').children[3].click(); 'p4'")
await sleep(700)
await step('clip-clear', '#clip-clear', "JSON.stringify({items:document.querySelectorAll('#clips li, #clips .clip').length})")

console.log('\nsummary:', JSON.stringify(results, null, 1))
ws.close()
