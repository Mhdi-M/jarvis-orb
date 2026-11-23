// Real-mouse check: open the music panel from the plain terminal view.
import fs from 'node:fs'
const wsUrl = fs.readFileSync('C:/Users/you/AppData/Local/hermes/cache/scratch/jws.txt', 'utf8').trim()
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
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call('Runtime.enable')

// back to the plain terminal
await ev("__jarvis.setMode('orb'); 'orb'")
await sleep(600)

const rail = await ev("(()=>{const r=document.getElementById('rail');const c=getComputedStyle(r);return {opacity:+c.opacity,pe:c.pointerEvents}})()")
console.log('rail in orb mode:', JSON.stringify(rail))

const b = await ev("(()=>{const el=[...document.querySelectorAll('#rail .rbtn')].find(x=>x.dataset.panel==='music');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()")
console.log('music button at', JSON.stringify(b))

// hover it first (the window ignores clicks until it sees a hover)
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y })
await sleep(300)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 })
await sleep(60)
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 })
await sleep(700)

console.log('after click:', await ev("JSON.stringify({mode:document.body.className, drawer:document.getElementById('drawer').className, title:document.getElementById('ptitle').textContent, active:[...document.querySelectorAll('.panel.active')].map(p=>p.dataset.p), eqVisible:!!document.querySelector('.panel.active canvas#m-eq')})"))
ws.close()
