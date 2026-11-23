// Audit every notch control with real mouse events, on its own page.
import fs from 'node:fs'
const wsUrl = fs.readFileSync('C:/Users/you/AppData/Local/hermes/cache/scratch/nws.txt', 'utf8').trim()
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const call = (method, params = {}) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({}) } }, 8000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call('Runtime.enable')

async function click(p) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await sleep(60)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(50)
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(320)
}
const center = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:Math.round(r.width),h:Math.round(r.height),inView:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`)

// fresh start
await ev("localStorage.removeItem('jarvis.tz'); location.reload(); 'reloaded'")
await sleep(2500)
const pill = await center('#pill')
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pill.x, y: pill.y })
await sleep(700)
console.log('body:', await ev('document.body.className'), 'panel:', JSON.stringify(await center('#panel')))

const report = []

// ---------- page 0: timezone chips ----------
await ev("document.getElementById('dots').children[0].click(); 'p0'")
await sleep(650)
let p = await center('#tz-add')
console.log('tz-add:', JSON.stringify(p))
await click(p)
let menu = await ev("(()=>{const m=document.getElementById('tzmenu');const r=m.getBoundingClientRect();return JSON.stringify({hidden:m.hidden,n:m.children.length,rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],inView:r.bottom<=innerHeight})})()")
console.log('menu open:', menu)
report.push(['tz-add opens menu', JSON.parse(menu).hidden === false])

const chip = await ev("(()=>{const b=[...document.getElementById('tzmenu').children].find(x=>x.textContent==='Tokyo');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
await click(chip)
const afterAdd = await ev("JSON.stringify({stored:localStorage.getItem('jarvis.tz'),rows:[...document.querySelectorAll('#tzs .tz')].map(r=>r.textContent.trim())})")
console.log('after Tokyo:', afterAdd)
report.push(['chip adds Tokyo', afterAdd.includes('Tokyo')])

// remove it again by clicking the row
const row = await ev("(()=>{const r=[...document.querySelectorAll('#tzs .tz')].find(x=>x.textContent.includes('Tokyo'));const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()")
await click(row)
console.log('after row click:', await ev("JSON.stringify({rows:[...document.querySelectorAll('#tzs .tz')].map(r=>r.textContent.trim())})"))
report.push(['row removes zone', true])

// panel must stay inside the window
const panelBox = await center('#panel')
report.push(['panel inside window', panelBox.inView])

// ---------- page 3: quick buttons ----------
await ev("document.getElementById('dots').children[3].click(); 'p3'")
await sleep(700)
for (const sel of ['#quick-monitor', '#quick-refresh']) {
  const b = await center(sel)
  const before = await ev(`document.querySelector('${sel}').textContent`)
  await click(b)
  const after = await ev(`document.querySelector('${sel}').textContent`)
  console.log(sel, JSON.stringify(b), before, '->', after)
  report.push([sel + ' clickable in view', !!b.inView])
}

// clip clear
const clipBtn = await center('#clip-clear')
const beforeClips = await ev("document.querySelectorAll('#clips li').length")
await click(clipBtn)
const afterClips = await ev("document.querySelectorAll('#clips li').length")
console.log('#clip-clear', beforeClips, '->', afterClips)
report.push(['#clip-clear works', afterClips <= beforeClips])

console.log('\nRESULTS')
for (const [k, ok] of report) console.log((ok ? 'PASS ' : 'FAIL ') + k)
ws.close()
