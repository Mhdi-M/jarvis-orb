// Measures perceived latency: time until the first characters appear on screen.
import fs from 'node:fs'
const wsUrl = fs.readFileSync('C:/Users/you/AppData/Local/hermes/cache/scratch/jws.txt', 'utf8').trim()
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const call = (method, params = {}, tmo = 180000) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({}) } }, tmo)
})
const ev = async (x, tmo) => {
  const r = await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, tmo)
  if (r.result?.exceptionDetails) return 'EXC ' + r.result.exceptionDetails.text
  return r.result?.result?.value
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call('Runtime.enable')
await ev("window.jarvis.show(); 'shown'")

const script = `(async () => {
  const thread = document.getElementById('thread')
  const t0 = performance.now()
  const i = document.getElementById('input')
  i.value = 'list three fruits, comma separated'
  i.dispatchEvent(new Event('input', { bubbles: true }))
  document.getElementById('inputbar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

  let firstChar = 0
  let lastLen = 0
  const seen = []
  while (performance.now() - t0 < 150000) {
    await new Promise(r => setTimeout(r, 50))
    const bot = thread.lastElementChild
    if (bot && bot.classList.contains('bot')) {
      const len = bot.textContent.length
      if (len > 0 && !firstChar) { firstChar = Math.round(performance.now() - t0); seen.push('first char') }
      if (len > lastLen) { lastLen = len; seen.push(len) }
      if (!bot.classList.contains('typing') && len > 0 && performance.now() - t0 > 1500) {
        return { firstCharMs: firstChar, fullMs: Math.round(performance.now() - t0), len, text: bot.textContent.slice(0, 120), growth: seen.length }
      }
    }
  }
  return { firstCharMs: firstChar, fullMs: -1, len: lastLen, text: '(timeout)', growth: seen.length }
})()`

const r = await ev(script)
console.log(JSON.stringify(r, null, 1))
ws.close()
