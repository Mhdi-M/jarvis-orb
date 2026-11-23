// Minimal CDP driver for the Jarvis orb window (no deps, Node's global WebSocket).
// usage:
//   node cdp.mjs <wsUrl> eval "<js expression>"
//   node cdp.mjs <wsUrl> shot <outfile.png> [x y w h]
import fs from 'node:fs'

const [, , wsUrl, mode, a, b, c, d, e] = process.argv
if (!wsUrl || !mode) { console.error('usage: node cdp.mjs <wsUrl> eval|shot ...'); process.exit(2) }

const ws = new WebSocket(wsUrl)
const pending = new Map()
let nextId = 1

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) }
    }, 60000)
  })
}

ws.onmessage = (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

ws.onerror = (err) => { console.error('ws error', err.message || err); process.exit(1) }

ws.onopen = async () => {
  try {
    if (mode === 'eval') {
      const r = await send('Runtime.evaluate', {
        expression: a,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (r.exceptionDetails) {
        console.log('EXCEPTION:', JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails, null, 2))
        process.exitCode = 1
      } else {
        const v = r.result?.value
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      }
    } else if (mode === 'raw') {
      const req = JSON.parse(a)
      const r = await send(req.method, req.params || {})
      console.log(JSON.stringify(r))
    } else if (mode === 'shot') {
      const params = { format: 'png', captureBeyondViewport: false, fromSurface: true }
      if (b !== undefined) {
        params.clip = { x: Number(b), y: Number(c), width: Number(d), height: Number(e), scale: 2 }
      }
      const r = await send('Page.captureScreenshot', params)
      fs.writeFileSync(a, Buffer.from(r.data, 'base64'))
      console.log('saved', a, fs.statSync(a).size, 'bytes')
    } else {
      console.error('unknown mode', mode)
      process.exitCode = 2
    }
  } catch (err) {
    console.error('ERR', err.message)
    process.exitCode = 1
  } finally {
    ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 50)
  }
}
