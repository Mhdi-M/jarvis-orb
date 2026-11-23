'use strict'
/**
 * Network mode. Detects the Throne/VPN tunnel and decides, per app, whether
 * Jarvis's own child processes use the proxy. Never touches the system proxy or TUN,
 * so ChatGPT and everything else on the machine stays on the direct connection.
 */
const net = require('net')

const PROXY_HOST = '127.0.0.1'
const PROXY_PORT = 2080

function portOpen(port = PROXY_PORT, host = PROXY_HOST, ms = 600) {
  return new Promise((res) => {
    const s = new net.Socket(); let done = false
    const end = (v) => { if (!done) { done = true; s.destroy(); res(v) } }
    s.setTimeout(ms); s.once('connect', () => end(true)); s.once('timeout', () => end(false)); s.once('error', () => end(false))
    s.connect(port, host)
  })
}

/** Pure: env for a child process given the chosen mode. */
function envFor(mode, base = process.env) {
  const env = { ...base }
  const proxy = `socks5://${PROXY_HOST}:${PROXY_PORT}`
  if (mode === 'proxy') { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; env.NO_PROXY = 'localhost,127.0.0.1,REDACTED_PROVIDER_HOST' }
  else for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete env[k]
  return env
}
async function status(mode) {
  const tunnel = await portOpen()
  return { mode, tunnelRunning: tunnel, label: mode === 'proxy' ? (tunnel ? 'Proxy on' : 'Proxy on (tunnel not running)') : 'Direct' }
}
module.exports = { envFor, status, portOpen, PROXY_PORT }
