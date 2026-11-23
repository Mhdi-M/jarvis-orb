// Measures Jarvis latency (local fast path vs agent) and checks answers.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = async (expr, tmo) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tmo)
  if (r.result?.exceptionDetails) return 'EXC ' + r.result.exceptionDetails.text
  return r.result?.result?.value
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await call('Runtime.enable')
await ev("window.jarvis.show(); 'shown'")

const rows = []

// ---------- 1. UI path: submit → transcript row appears ----------
async function uiAsk(text, limitMs = 120000) {
  const script = `(async () => {
    const thread = document.getElementById('thread')
    const before = thread.children.length
    const t0 = performance.now()
    const i = document.getElementById('input')
    i.value = ${JSON.stringify(text)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('inputbar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const deadline = t0 + ${limitMs}
    while (performance.now() < deadline) {
      await new Promise(r => setTimeout(r, 60))
      const last = thread.lastElementChild
      if (thread.children.length > before && last && last.classList.contains('bot') && !last.classList.contains('typing')) {
        return { ms: Math.round(performance.now() - t0), text: last.textContent.slice(0, 220) }
      }
    }
    return { ms: -1, text: '(timeout)' }
  })()`
  return ev(script, limitMs + 20000)
}

// ---------- 2. direct IPC latency ----------
async function ipcAsk(q) {
  const script = `(async () => {
    const t0 = performance.now()
    let r
    try { r = await window.jarvis.ask(${JSON.stringify(q)}) } catch (e) { r = { ok: false, text: String(e) } }
    return { ms: Math.round(performance.now() - t0), ok: r.ok, text: String(r.text).slice(0, 200) }
  })()`
  return ev(script)
}

console.log('=== local fast path (should be tens of ms) ===')
for (const q of ['open notepad', 'run echo speed-check-ok', 'read example.com']) {
  const r = await uiAsk(q, 25000)
  rows.push(['local: ' + q, r.ms, r.text.replace(/\s+/g, ' ').slice(0, 70)])
  console.log(`  ${String(r.ms).padStart(6)} ms  ${q}  ->  ${r.text.replace(/\s+/g, ' ').slice(0, 60)}`)
}

console.log('\n=== agent answers (timed, correctness checked) ===')
const checks = [
  { q: 'what is 147 * 23? answer with just the number', want: '3381' },
  { q: 'what is the capital of Australia? one word', want: 'canberra' },
  { q: 'how many days are in February 2024? one word', want: '29' },
]
for (const c of checks) {
  const r = await ipcAsk(c.q)
  const ok = String(r.text).toLowerCase().includes(c.want)
  rows.push(['agent: ' + c.q, r.ms, (ok ? 'CORRECT ' : 'WRONG ') + r.text.replace(/\s+/g, ' ').slice(0, 60)])
  console.log(`  ${String(r.ms).padStart(6)} ms  ${ok ? 'PASS' : 'FAIL'}  ${c.q}  ->  ${r.text.replace(/\s+/g, ' ').slice(0, 70)}`)
}

console.log('\n=== UI path for a real question (includes typing) ===')
const ui = await uiAsk('say good morning in one short line')
console.log(`  ${String(ui.ms).padStart(6)} ms  ->  ${ui.text.replace(/\s+/g, ' ').slice(0, 70)}`)
rows.push(['ui: say good morning', ui.ms, ui.text.replace(/\s+/g, ' ').slice(0, 60)])

console.log('\nSUMMARY (ms)')
for (const [k, ms, note] of rows) console.log(`  ${String(ms).padStart(6)}  ${k}   ${note}`)
ws.close()
