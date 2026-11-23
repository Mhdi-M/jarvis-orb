// Watch console + exceptions for N seconds after a reload.
// usage: node tools/watch.mjs <wsUrl> [seconds]
const [, , wsUrl, secs] = process.argv
const seconds = Number(secs || 8)

const ws = new WebSocket(wsUrl)
let id = 1
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }))

ws.onopen = () => {
  send('Runtime.enable')
  send('Log.enable')
  send('Page.enable')
  setTimeout(() => send('Page.reload', { ignoreCache: true }), 250)
  setTimeout(() => { ws.close(); process.exit(0) }, seconds * 1000 + 250)
}

ws.onmessage = (ev) => {
  let m
  try { m = JSON.parse(ev.data) } catch { return }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    console.log(`[console.${m.params.type}] ${text}`)
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    console.log(`[exception] ${d.text} ${d.exception?.description || ''}`)
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry
    console.log(`[log.${e.level}] ${e.text}${e.url ? ` (${e.url})` : ''}`)
  }
}
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1) }
