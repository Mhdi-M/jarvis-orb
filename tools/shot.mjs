// Dev-only: capture the page as a PNG with an opaque backdrop so the
// transparent Electron window does not screenshot as white.
// usage: node tools/shot.mjs <wsUrl> <outfile.png> [scale]
import fs from 'node:fs'

const [, , wsUrl, out, scaleArg] = process.argv
if (!wsUrl || !out) { console.error('usage: node tools/shot.mjs <wsUrl> <out.png> [scale]'); process.exit(2) }
const scale = Number(scaleArg) || 2

const ws = new WebSocket(wsUrl)
let id = 1
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = id++
  pending.set(n, { res, rej })
  ws.send(JSON.stringify({ id: n, method, params }))
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)) } }, 30000)
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
}
ws.onerror = (e) => { console.error('ws', e.message || e); process.exit(1) }
ws.onopen = async () => {
  try {
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 9, g: 15, b: 22, a: 1 } })
    await send('Emulation.setDeviceMetricsOverride', {
      width: 700, height: 600, deviceScaleFactor: scale, mobile: false,
    })
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'))
    console.log('saved', out, fs.statSync(out).size, 'bytes @', scale + 'x')
  } catch (e) {
    console.error('ERR', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 50)
  }
}
