/* --------------------------------------------------------------- system ops
 * Things a person does without thinking: volume, power plan, lock, brightness.
 * Each is one OS call, and each is read back, so a silent failure is visible.
 */
const { execFile } = require('child_process')

function ps(command, timeout) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: timeout || 20000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').slice(0, 160)
      }))
  })
}

const VK = { up: 0xAF, down: 0xAE, mute: 0xAD }

/* one media key press; Windows applies it to the default output device */
async function volume(action, steps) {
  const key = VK[action]
  if (!key) return { ok: false, error: 'volume expects up|down|mute' }
  const n = Math.max(1, Math.min(50, Number(steps) || 2))
  const tap = '[W.K]::keybd_event(' + key + ',0,0,[System.IntPtr]::Zero); [W.K]::keybd_event(' + key + ',0,2,[System.IntPtr]::Zero); Start-Sleep -Milliseconds 60'
  const cmd = "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, System.IntPtr e);'; " +
    new Array(n).fill(tap).join('; ')
  const r = await ps(cmd)
  return { ok: r.ok, action, steps: n, via: 'media-key' }
}

async function plans() {
  const r = await ps('powercfg /list')
  const active = await ps('powercfg /getactivescheme')
  const list = []
  for (const line of (r.out || '').split(/\r?\n/)) {
    const m = line.match(/([0-9a-f-]{36})\s+\(([^)]*)\)/)
    if (m) list.push({ guid: m[1], name: m[2], active: line.includes('*') })
  }
  const cur = (active.out || '').match(/\(([^)]*)\)/)
  return { schemes: list, active: cur ? cur[1] : null }
}

/* power plan by name fragment (or guid prefix): silent, balanced, turbo */
async function power(which) {
  const q = String(which || '').toLowerCase()
  const pick = (p) => p.schemes.find((s) => s.name.toLowerCase().includes(q)) ||
    p.schemes.find((s) => s.guid.toLowerCase().startsWith(q))
  let p = await plans()
  let hit = pick(p)
  if (!hit) {
    /* the list can lag right after a switch, so give it one retry */
    await new Promise((r) => setTimeout(r, 800))
    p = await plans()
    hit = pick(p)
  }
  if (!hit) return { ok: false, error: 'no scheme matches ' + which, schemes: p.schemes.map((s) => s.name) }
  const r = await ps('powercfg /setactive ' + hit.guid)
  const after = await plans()
  const ok = r.ok && (after.active || '').toLowerCase().includes(hit.name.toLowerCase())
  return { ok, plan: hit.name, active: after.active }
}

async function lockScreen() {
  const r = await ps('rundll32.exe user32.dll,LockWorkStation')
  return { ok: r.ok, via: 'LockWorkStation' }
}

/* internal panels only; most desktops expose no controllable backlight */
async function brightness(level) {
  if (level === undefined) {
    const r = await ps('Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentBrightness')
    return { ok: !!r.out, current: r.out || null }
  }
  const v = Math.max(0, Math.min(100, Number(level)))
  const r = await ps('(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1).WmiSetBrightness(1,' + v + ')')
  const after = await brightness()
  return {
    ok: r.ok && String(after.current) === String(v),
    set: v,
    current: after.current,
    note: after.current ? '' : 'no WMI backlight on this display'
  }
}

async function status() {
  const p = await plans()
  const b = await brightness()
  return { power: p.active, schemes: p.schemes.map((s) => s.name), brightness: b.current || 'n/a' }
}

module.exports = { volume, power, plans, lockScreen, brightness, status }
