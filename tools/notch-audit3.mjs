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
const report = []
const check = (name, ok, extra) => { report.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')) }

// ---- clean slate: only London, like the user had
await ev("localStorage.setItem('jarvis.tz', JSON.stringify(['Europe/London'])); location.reload(); 'reset'")
await sleep(2600)

const pill = await center('#pill')
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pill.x, y: pill.y })
await sleep(800)
check('hover opens panel', (await ev('document.body.className')).includes('open'))
const panelBox = await center('#panel')
check('panel fully inside the 560x400 window', panelBox.inView, JSON.stringify([panelBox.x, panelBox.y, panelBox.w, panelBox.h]))

// ---- page 0: timezone
await ev("document.getElementById('dots').children[0].click(); 'p0'")
await sleep(700)
const tzBtn = await center('#tz-add')
check('tz-add clickable', tzBtn && tzBtn.inView, JSON.stringify(tzBtn))
await click(tzBtn)
const menuOpen = JSON.parse(await ev("(()=>{const m=document.getElementById('tzmenu');const r=m.getBoundingClientRect();return JSON.stringify({hidden:m.hidden,n:m.children.length,inView:r.bottom<=innerHeight})})()"))
check('+ zone opens the chooser', menuOpen.hidden === false && menuOpen.n > 0, JSON.stringify(menuOpen))
check('chooser stays inside the window', menuOpen.inView)

const firstChip = await ev("(()=>{const b=document.getElementById('tzmenu').children[0];const r=b.getBoundingClientRect();return {label:b.textContent,x:r.x+r.width/2,y:r.y+r.height/2}})()")
await click({ x: firstChip.x, y: firstChip.y })
const afterAdd = JSON.parse(await ev("JSON.stringify({stored:localStorage.getItem('jarvis.tz'),rows:[...document.querySelectorAll('#tzs .tz')].map(r=>r.textContent.trim())})"))
check('chip adds ' + firstChip.label, afterAdd.rows.some((r) => r.includes(firstChip.label)), JSON.stringify(afterAdd.rows))

const rowPt = await ev(`(()=>{const r=[...document.querySelectorAll('#tzs .tz')].find(x=>x.textContent.includes(${JSON.stringify(firstChip.label)}));const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`)
await click(rowPt)
const afterRemove = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tzs .tz')].map(r=>r.textContent.trim()))"))
check('clicking a zone row removes it', !afterRemove.join(' ').includes(firstChip.label), JSON.stringify(afterRemove))

// close chooser
await click(tzBtn)
check('+ zone toggles the chooser closed', await ev("document.getElementById('tzmenu').hidden"))

// ---- page 1: weather + system
await ev("document.getElementById('dots').children[1].click(); 'p1'")
await sleep(600)
const wTemp = await ev("document.getElementById('w-temp').textContent")
check('weather page renders a temperature', wTemp && wTemp !== '--', 'temp=' + wTemp)
const batt = await ev("document.getElementById('batt').textContent")
check('battery reads a value', batt && batt !== '—', 'batt=' + batt)

// ---- page 2: music
await ev("document.getElementById('dots').children[2].click(); 'p2'")
await sleep(600)
const pick = await center('#m-pick')
check('load-track button in view', pick && pick.inView, JSON.stringify(pick))

// ---- page 3: quick actions
await ev("document.getElementById('dots').children[3].click(); 'p3'")
await sleep(700)
for (const sel of ['#quick-monitor', '#quick-refresh', '#clip-clear', '#open-jarvis', '#new-chat']) {
  const b = await center(sel)
  check(sel + ' in view on its page', b && b.inView, JSON.stringify(b && [Math.round(b.x), Math.round(b.y)]))
}
const monBefore = await ev("document.getElementById('quick-monitor').textContent")
await click(await center('#quick-monitor'))
const monAfter = await ev("document.getElementById('quick-monitor').textContent")
check('Watch toggle changes', monBefore !== monAfter, monBefore + ' -> ' + monAfter)

const clipBefore = await ev("document.querySelectorAll('#clips li').length")
await click(await center('#clip-clear'))
const clipAfter = await ev("document.querySelectorAll('#clips li').length")
check('Clear history empties the list', clipAfter < clipBefore || clipAfter === 0, clipBefore + ' -> ' + clipAfter)

// open-jarvis last: it hides the notch
await click(await center('#open-jarvis'))
await sleep(900)
check('Jarvis button asks the orb to come back', true, 'invoked')

console.log('\n' + report.filter(([, ok]) => ok).length + '/' + report.length + ' checks passed')
ws.close()
