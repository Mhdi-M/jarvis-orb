// dev: capture a clipped region twice and diff it — proves the canvas animates
import fs from 'node:fs'

const [, , wsUrl, sel, outA, outB, gapMs] = process.argv
const gap = Number(gapMs) || 400

const ws = new WebSocket(wsUrl)
let id = 1
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = id++
  pending.set(n, { res, rej })
  ws.send(JSON.stringify({ id: n, method, params }))
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)) } }, 20000)
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
ws.onopen = async () => {
  try {
    const rect = JSON.parse(await evalJs(`(()=>{const r=document.querySelector('${sel}').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height})})()`))
    const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
    const a = await send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true })
    fs.writeFileSync(outA, Buffer.from(a.data, 'base64'))
    await new Promise((r) => setTimeout(r, gap))
    const b = await send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true })
    fs.writeFileSync(outB, Buffer.from(b.data, 'base64'))
    console.log('captured', JSON.stringify(rect))
  } catch (e) {
    console.error('ERR', e.message)
    process.exitCode = 1
  } finally {
    ws.close(); setTimeout(() => process.exit(process.exitCode || 0), 50)
  }
}
