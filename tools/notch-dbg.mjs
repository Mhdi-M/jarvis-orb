// Diagnose why a real mouse click on #tz-add does nothing.
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
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({}) } }, 6000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

await call('Runtime.enable')
await ev("document.getElementById('dots').children[0].click(); 'p0'")
await sleep(500)
const pill = await ev("(()=>{const r=document.getElementById('pill').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pill.x, y: pill.y })
await sleep(700)

// instrument
await ev(`
  window.__clicks = [];
  document.addEventListener('click', (e) => {
    window.__clicks.push({ t: e.target.id || e.target.className || e.target.tagName, x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, true);
  window.__hover = [];
  document.addEventListener('mouseover', (e) => { window.__hover.push(e.target.id || e.target.className || e.target.tagName) }, true);
  window.__menuLog = [];
  const btn = document.getElementById('tz-add');
  btn.addEventListener('click', () => window.__menuLog.push('tz-add handler fired'));
  'instrumented'
`)

const pt = await ev("(()=>{const r=document.getElementById('tz-add').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()")
console.log('tz-add center', pt)
console.log('elementFromPoint:', await ev(`(()=>{const e=document.elementFromPoint(${pt.x},${pt.y});return e ? (e.id||e.className||e.tagName) : 'none'})()`))
console.log('ignoreState body:', await ev("document.body.className"))

await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
await sleep(120)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 })
await sleep(60)
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 0 })
await sleep(400)

console.log('clicks seen:', JSON.stringify(await ev('window.__clicks')))
console.log('menu log:', JSON.stringify(await ev('window.__menuLog')))
console.log('menu hidden:', await ev("document.getElementById('tzmenu').hidden"))
console.log('hover trail:', JSON.stringify(await ev('window.__hover.slice(-8)')))
ws.close()
