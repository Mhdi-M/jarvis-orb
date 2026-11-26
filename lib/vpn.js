/* ------------------------------------------------------------------- vpn
 * Throne (mixed inbound on 127.0.0.1:2080) is the tunnel. Jarvis may start and
 * stop it, but only on request: a wrong toggle mid-task breaks the very network
 * the other agents are using.
 *
 * Decision logic that matters:
 *   - DeepSeek (custom:swm) must stay DIRECT. Its host is in NO_PROXY, so the
 *     tunnel can stay up while the primary model still answers. Verified.
 *   - Everything else may go through the tunnel.
 */
const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

const STATE = path.join(__dirname, '..', 'data', 'vpn.json')
const PROXY = process.env.JARVIS_VPN_PROXY || 'http://127.0.0.1:2080'

function cfg() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch (e) { return {} }
}

function save(patch) {
  const next = Object.assign(cfg(), patch)
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }) } catch (e) {}
  fs.writeFileSync(STATE, JSON.stringify(next, null, 2) + '\n')
  return next
}

function curl(args, timeout) {
  return new Promise((resolve) => {
    execFile('curl', args, { windowsHide: true, timeout: timeout || 12000 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim(), err: err && err.message }))
  })
}

/* Is the tunnel carrying traffic right now? */
async function status() {
  const probe = await curl(['-s', '-m', '6', '-x', PROXY, 'https://api.github.com/zen'])
  const listening = await curl(['-s', '-o', 'NUL', '-m', '3', PROXY])
  return {
    proxy: PROXY,
    listening: listening.ok || /response|HTTP/i.test(listening.err || ''),
    tunnelWorks: probe.ok && probe.out.length > 0,
    ip: (await curl(['-s', '-m', '8', '-x', PROXY, 'https://api.ipify.org'])).out || 'n/a'
  }
}

async function start() {
  const c = cfg()
  if (!c.exe) return { ok: false, reason: 'no path recorded: run /vpn set "C:\\path\\to\\Throne.exe" once' }
  if (!fs.existsSync(c.exe)) return { ok: false, reason: 'recorded path no longer exists: ' + c.exe }
  const p = spawn(c.exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  p.unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700))
    const s = await status()
    if (s.tunnelWorks) return { ok: true, secs: ((i + 1) * 0.7).toFixed(1) }
  }
  return { ok: false, reason: 'started but the tunnel never answered on ' + PROXY }
}

async function stop() {
  const c = cfg()
  if (!c.image) return { ok: false, reason: 'no process name recorded: run /vpn set <exe> first' }
  await new Promise((resolve) => {
    execFile('taskkill', ['/IM', c.image, '/F'], { windowsHide: true }, () => resolve())
  })
  await new Promise((r) => setTimeout(r, 1200))
  const s = await status()
  return { ok: !s.tunnelWorks, still: s.tunnelWorks }
}

/* ---- TUN mode ------------------------------------------------------------
 * With TUN on, the client captures packets at the IP layer, so NO_PROXY is
 * irrelevant: the DeepSeek host gets swallowed by the tunnel and the primary
 * model stops answering. The cure is a host route that stays on the physical
 * gateway. Everything here is read-only until bypass() is explicitly called.
 */
const net = require('net')

const PROVIDER = process.env.JARVIS_PROVIDER_HOST || ''
const PROVIDER_PORT = Number(process.env.JARVIS_PROVIDER_PORT || 443)

function psRead(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(String(stdout || '').trim()))
  })
}

async function tunActive() {
  const out = await psRead("Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'TUN|TAP|Wintun|Throne|sing-box|Clash' -and $_.Status -eq 'Up' } | Select-Object -ExpandProperty Name")
  return out.length > 0 ? out.split(/\r?\n/).filter(Boolean) : []
}

function reachable(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeout || 3500 })
    const done = (ok) => { try { sock.destroy() } catch (e) {}; resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/* Which default route would a packet to the provider take right now? */
async function providerRoute() {
  if (!PROVIDER) return ''
  return psRead("(Find-NetRoute -RemoteIPAddress " + PROVIDER + " -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.InterfaceAlias + ' via ' + $_.NextHop })")
}

/* The physical gateway, so the bypass route does not point back into the tunnel */
async function physicalGateway() {
  return psRead("$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Where-Object { (Get-NetAdapter -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue).InterfaceDescription -notmatch 'TUN|TAP|Wintun|Throne|sing-box|Clash' } | Select-Object -First 1; if ($r) { $r.NextHop }")
}

async function diag() {
  if (!PROVIDER) return { provider: null, error: 'JARVIS_PROVIDER_HOST is not set (see .env.example)', tun: await tunActive() }
  const dns = await psRead("Resolve-DnsName -Name " + PROVIDER + " -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty IPAddress")
  return {
    provider: PROVIDER + ':' + PROVIDER_PORT,
    tun: await tunActive(),
    reachable: await reachable(PROVIDER, PROVIDER_PORT),
    route: await providerRoute(),
    gateway: await physicalGateway()
  }
}

/* Add a persistent host route so the provider bypasses the tunnel.
 * Needs elevation: Windows will show one UAC prompt. */
async function bypass() {
  const gw = await physicalGateway()
  if (!gw) return { ok: false, reason: 'no physical gateway found' }
  const cmd = 'route add ' + PROVIDER + ' mask 255.255.255.255 ' + gw + ' metric 1 -p'
  const elevated = await new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "Start-Process cmd -ArgumentList '/c " + cmd + "' -Verb RunAs -Wait -WindowStyle Hidden"],
      { windowsHide: true, timeout: 60000 }, (err) => resolve(!err))
  })
  if (!elevated) return { ok: false, reason: 'elevation declined or failed', cmd }
  await new Promise((r) => setTimeout(r, 1500))
  return { ok: await reachable(PROVIDER, PROVIDER_PORT), cmd, gateway: gw }
}

module.exports = { status, start, stop, save, cfg, PROXY, STATE, tunActive, reachable, diag, bypass, providerRoute, PROVIDER }

