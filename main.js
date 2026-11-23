'use strict'
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage,
  globalShortcut, shell, protocol, net, dialog, clipboard,
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile, spawn } = require('child_process')
const { pathToFileURL } = require('url')
const https = require('https')
const bridge = require('./hermes-bridge')
const memory = require('./lib/memory')
const monitor = require('./lib/monitor')
const netmode = require('./lib/netmode')
const localEngine = require('./lib/local-engine')
const guard = require('./lib/guard')
const dashboard = require('./lib/dashboard')
const media = require('./lib/media')
const notify = require('./lib/notify')
const activity = require('./lib/activity')
const profile = require('./lib/profile')
const { sampler: cpuSampler } = require('./lib/cpu')
const dragMath = require('./lib/drag')

/* ==========================================================================
   Config
   ========================================================================== */

const CONFIG_FILE = path.join(__dirname, 'orb.config.json')
const BRIEF_STATE = path.join(__dirname, 'brief.json')

const DEFAULTS = {
  startAtLogin: true,
  startHidden: true,        // stay off-screen until summoned
  autoHideSeconds: 45,      // 0 disables auto-hide
  uiScale: 1,               // 0.7 – 1.5
  briefOnStart: true,
  briefEveryHours: 8,
  briefPrompt: '',
  allowRemoteDebug: false,  // never open a CDP port in normal use
  theme: {
    accent: '#7fb4d8',
    panelOpacity: 0.94,
    panelWidth: 0,
    orbSize: 128,
    fontScale: 1,
  },
}

let config = { ...DEFAULTS }
try {
  config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  if (config.theme) config.theme = { ...DEFAULTS.theme, ...config.theme }
} catch (e) {
  console.log('[config] using defaults:', e.message)
}

bridge.settings.netMode = config.netMode === 'proxy' ? 'proxy' : 'direct'
bridge.settings.preferLocal = !!config.preferLocal
const clampScale = (v) => Math.min(1.6, Math.max(0.7, Number(v) || 1))
let scale = clampScale(config.uiScale)
const THEME = config.theme || DEFAULTS.theme
const BASE_W = 700
const BASE_H = 600
let WIN_W = Math.round(BASE_W * scale)
let WIN_H = Math.round(BASE_H * scale)

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) } catch (e) {
    console.log('[config] save failed:', e.message)
  }
}

/** Resize + rescale live, then re-anchor. Called from the tray Size menu. */
function applyScale(next) {
  scale = clampScale(next)
  WIN_W = Math.round(BASE_W * scale)
  WIN_H = Math.round(BASE_H * scale)
  config.uiScale = scale
  saveConfig()
  if (!win || win.isDestroyed()) return
  win.webContents.setZoomFactor(scale)
  win.setSize(WIN_W, WIN_H)
  const a = anchor()
  win.setPosition(a.x, a.y)
  console.log(`[ui] scale ${Math.round(scale * 100)}% (${WIN_W}×${WIN_H})`)
}

/* ==========================================================================
   Scheme: file:// refuses ES-module imports, so the UI is served over app://.
   ========================================================================== */

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function serveFromDisk(request) {
  const url = new URL(request.url)
  const rawPath = url.pathname
  let rel = decodeURIComponent(rawPath)
  if (rel === '/' || rel === '') rel = '/index.html'

  // /media/<encodeURIComponent(absolute path)> — lets a renderer play a picked
  // file itself, so the spectrum is driven by the real audio signal.
  if (rawPath.startsWith('/media/')) {
    const target = media.resolveMediaTarget(rawPath)
    if (!target.ok) return new Response(target.error, { status: target.status })
    if (!fs.existsSync(target.abs)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(target.abs).toString()).then((upstream) => {
      const headers = new Headers()
      headers.set('content-type', target.mime)
      headers.set('cache-control', 'no-store')
      headers.set('accept-ranges', 'none')
      return new Response(upstream.body, { status: 200, headers })
    })
  }
  const target = path.normalize(path.join(__dirname, rel))
  if (!target.startsWith(__dirname)) return new Response('forbidden', { status: 403 })
  return net.fetch(pathToFileURL(target).toString()).then((upstream) => {
    const headers = new Headers()
    headers.set('content-type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream')
    headers.set('cache-control', 'no-cache')
    return new Response(upstream.body, { status: upstream.status, headers })
  })
}

/* ==========================================================================
   Window
   ========================================================================== */

let win = null
let tray = null
let isIgnoring = false
let hideTimer = null
let fullMode = false

function anchor() {
  const d = screen.getPrimaryDisplay()
  const y = d.workArea.y + Math.round(12 * scale)
  return { x: Math.round((d.workArea.width - WIN_W) / 2) + d.workArea.x, y }
}

function setIgnore(ignore) {
  if (!win || win.isDestroyed()) return
  if (isIgnoring === ignore) return
  isIgnoring = ignore
  win.setIgnoreMouseEvents(ignore, { forward: true })
  win.webContents.send('jarvis:mode', ignore ? 'idle' : 'active')
  if (!ignore) bumpHide()
}

/** Summon the orb (used by tray, shortcut and startup brief). */
function showOrb(focus = false) {
  if (!win || win.isDestroyed()) return
  win.showInactive()
  if (focus) { setIgnore(false); win.focus() }
  bumpHide()
}

function hideOrb() {
  if (!win || win.isDestroyed()) return
  setIgnore(true)
  win.hide()
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

/**
 * Auto-hide: the orb only lives on screen while you are using it.
 * `isIgnoring` is true when the pointer is NOT over the orb, so we never yank
 * it away mid-interaction.
 */
function bumpHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  if (fullMode) return
  const secs = Number(config.autoHideSeconds) || 0
  if (secs <= 0) return
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (!win || win.isDestroyed()) return
    if (!isIgnoring) { bumpHide(); return }   // still being used — try again later
    win.hide()
  }, secs * 1000)
}

function createWindow() {
  const { x, y } = anchor()
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    acceptFirstMouse: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (scale !== 1) win.webContents.setZoomFactor(scale)
  win.loadURL('app://bundle/index.html')

  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', JSON.stringify(d)))
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer:${['debug', 'info', 'warn', 'error'][level] || 'log'}] ${message} (${source}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer crashed]', d))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc))

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Hardening: the page is inert. It cannot navigate away, and it is never
  // granted camera, mic, geolocation, notifications or clipboard-read.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  win.webContents.session.setPermissionCheckHandler(() => false)

  win.once('ready-to-show', () => {
    setIgnore(true)
    if (!config.startHidden) showOrb()
    else console.log('[window] starting hidden — Ctrl+Alt+J to summon')
    maybeBrief()
  })

  win.on('hide', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    notifyNotch(false)
  })
  win.on('show', () => notifyNotch(true))
}

/* ==========================================================================
   Monitoring notch — a separate always-on-top strip at the top of the screen
   ========================================================================== */

let notchWin = null
const NOTCH_W = 560
const NOTCH_H = 400

function createNotch() {
  if (notchWin && !notchWin.isDestroyed()) return
  const d = screen.getPrimaryDisplay()
  notchWin = new BrowserWindow({
    width: NOTCH_W,
    height: NOTCH_H,
    x: Math.round((d.workArea.width - NOTCH_W) / 2) + d.workArea.x,
    y: d.workArea.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    acceptFirstMouse: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'notch-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  })

  notchWin.setAlwaysOnTop(true, 'floating')
  notchWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notchWin.setIgnoreMouseEvents(true, { forward: true })
  notchWin.loadURL('app://bundle/notch.html')

  notchWin.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[notch:${['debug', 'info', 'warn', 'error'][level] || 'log'}] ${message} (${source}:${line})`)
  })
  notchWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  notchWin.webContents.on('will-navigate', (e) => e.preventDefault())

  notchWin.once('ready-to-show', () => {
    if (config.notchOn === false) return
    if (win && win.isVisible()) return
    notchWin.showInactive()
  })
  notchWin.on('closed', () => { notchWin = null })
}

/** The notch lives on screen only while the orb window is away. */
function notifyNotch(jarvisVisible) {
  if (!notchWin || notchWin.isDestroyed()) return
  if (config.notchOn === false) { notchWin.hide(); return }
  if (jarvisVisible) {
    notchWin.webContents.send('notch:jarvis', true)
    setTimeout(() => {
      if (notchWin && !notchWin.isDestroyed() && win && win.isVisible()) notchWin.hide()
    }, 300)
  } else {
    notchWin.showInactive()
    notchWin.webContents.send('notch:show')
  }
}

/* ---- little notifications that pop out of the notch ---- */
function sendNotify(payload) {
  if (!notchWin || notchWin.isDestroyed()) return
  if (config.notchOn === false) return
  const jarvisVisible = win && !win.isDestroyed() && win.isVisible()
  // the orb is on screen: stay quiet, that is the agreed behaviour
  if (jarvisVisible) return
  // the strip may have been hidden for another reason — bring it back for this
  if (!notchWin.isVisible()) notchWin.showInactive()
  notchWin.webContents.send('notch:notify', payload)
}

let clipTimer = null
let lastClipText = ''
const clipHistory = []

function pushClip(text) {
  const v = String(text || '').trim().slice(0, 400)
  if (!v) return
  const i = clipHistory.indexOf(v)
  if (i !== -1) clipHistory.splice(i, 1)
  clipHistory.unshift(v)
  if (clipHistory.length > 6) clipHistory.length = 6
}

// NOTE: clipboard.readText() returns a Promise in this Electron build, so the
// watcher has to await it — treating it as a string produced empty toasts.
function startClipWatch() {
  Promise.resolve()
    .then(() => clipboard.readText())
    .then((t) => {
      if (typeof t === 'string') { lastClipText = t; pushClip(t) }
    })
    .catch(() => {})

  clipTimer = setInterval(async () => {
    let text = ''
    try { text = await clipboard.readText() } catch { return }
    if (typeof text !== 'string' || !text || text === lastClipText) return
    lastClipText = text
    pushClip(text)
    sendNotify(notify.notifyPayload('copy', 'copied', text))
  }, 1200)
}

const shotWatchers = []

function startShotWatch() {
  const dirs = [
    { dir: path.join(os.homedir(), 'Pictures', 'Screenshots'), loose: true },
    { dir: path.join(os.homedir(), 'Pictures'), loose: false },
    { dir: path.join(os.homedir(), 'Desktop'), loose: false },
  ]
  const seen = new Set()
  for (const { dir, loose } of dirs) {
    if (!fs.existsSync(dir)) continue
    try {
      const w = fs.watch(dir, (_ev, file) => {
        if (!notify.looksLikeScreenshot(file, loose)) return
        const full = path.join(dir, file)
        if (seen.has(full)) return
        seen.add(full)
        setTimeout(() => seen.delete(full), 8000)
        sendNotify(notify.notifyPayload('shot', 'screenshot', file.replace(/\.[^.]+$/, '')))
      })
      shotWatchers.push(w)
    } catch (e) {
      console.log('[shot] watch failed:', dir, e.message)
    }
  }
}

ipcMain.on('notch:notify', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return
  sendNotify(notify.notifyPayload(payload.kind, payload.title, payload.detail))
})

function toggleNotch(on) {
  config.notchOn = !!on
  saveConfig()
  if (!notchWin || notchWin.isDestroyed()) { if (on) createNotch(); return }
  if (!on) notchWin.hide()
  else if (!win || !win.isVisible()) { notchWin.showInactive(); notchWin.webContents.send('notch:show') }
}

/* ==========================================================================
   Drag — driven by absolute pointer coordinates, never a timer.
   The old version polled the cursor every 8 ms and only stopped when the
   renderer received pointerup; moving the window under a captured pointer
   can swallow that event, which left the interval running forever
   ("you can drag it but not drop it").
   ========================================================================== */

let dragOrigin = null

ipcMain.on('drag:start', () => {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  dragOrigin = dragMath.begin(wx, wy)
})

ipcMain.on('drag:to', (_e, p) => {
  if (!dragOrigin || !win || win.isDestroyed()) return
  if (!p) return
  const next = dragMath.apply(dragOrigin, p.sx, p.sy)
  if (!next) return
  const display = screen.getDisplayNearestPoint({ x: next.x, y: next.y })
  const safe = dragMath.clampToDisplay(next, [WIN_W, WIN_H], display.workArea)
  win.setPosition(safe.x, safe.y)
})

ipcMain.on('drag:end', () => { dragOrigin = null })

/* ==========================================================================
   Briefing
   ========================================================================== */

function maybeBrief() {
  if (!config.briefOnStart || !config.briefPrompt) return
  let last = 0
  try { last = JSON.parse(fs.readFileSync(BRIEF_STATE, 'utf8')).last || 0 } catch {}
  const gapH = (Date.now() - last) / 3600000
  if (gapH < (Number(config.briefEveryHours) || 8)) {
    console.log(`[brief] skipped, last one ${gapH.toFixed(1)}h ago`)
    return
  }
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    showOrb()
    win.webContents.send('jarvis:brief', config.briefPrompt)
    try { fs.writeFileSync(BRIEF_STATE, JSON.stringify({ last: Date.now() }, null, 2)) } catch {}
    console.log('[brief] started')
  }, 2500)
}

/* ==========================================================================
   Login item
   ========================================================================== */

function configureLogin() {
  if (!config.startAtLogin) return
  const opts = { path: process.execPath, args: [__dirname], openAtLogin: true }
  try {
    app.setLoginItemSettings(opts)
    console.log('[login] open at login =', app.getLoginItemSettings(opts).openAtLogin)
  } catch (e) {
    console.log('[login] could not register:', e.message)
  }
}

/* ==========================================================================
   Live vitals (cheap: Node counters + nvidia-smi, never the Python script)
   ========================================================================== */

let gpuTemp = null
let statsTimer = null
let gpuTimer = null
const cpuPercent = cpuSampler()

function startStats() {
  const pollGpu = () => {
    execFile('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return
        const v = parseFloat(String(stdout).trim().split('\n')[0])
        if (Number.isFinite(v)) gpuTemp = v
      })
  }
  pollGpu()
  gpuTimer = setInterval(pollGpu, 20000)

  statsTimer = setInterval(() => {
    const orbShown = win && !win.isDestroyed() && win.isVisible()
    const notchShown = notchWin && !notchWin.isDestroyed() && notchWin.isVisible()
    if (!orbShown && !notchShown) return
    const total = os.totalmem()
    const payload = {
      cpu: cpuPercent(),
      ram: total ? 100 * (1 - os.freemem() / total) : 0,
      gpu: gpuTemp,
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('jarvis:stats', payload)
    }
  }, 2500)
}

/* ==========================================================================
   Tray
   ========================================================================== */

function trayIcon() {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - 7.5, y - 7.5)
      const a = Math.max(0, Math.min(1, (7 - r) / 2))
      const i = (y * size + x) * 4
      buf[i] = 127; buf[i + 1] = 168; buf[i + 2] = 201
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function buildTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('Jarvis — Hermes orb (Ctrl+Alt+J)')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Jarvis', click: () => showOrb(true) },
    { label: 'Hide', click: hideOrb },
    { label: 'Recenter', click: () => win.setPosition(anchor().x, anchor().y) },
    {
      label: 'Monitoring notch',
      type: 'checkbox',
      checked: config.notchOn !== false,
      click: (item) => toggleNotch(item.checked),
    },
    {
      label: `Size (${Math.round(scale * 100)}%)`,
      submenu: [0.8, 1, 1.2, 1.4].map((s) => ({
        label: `${Math.round(s * 100)}%`,
        type: 'radio',
        checked: Math.abs(scale - s) < 0.01,
        click: () => applyScale(s),
      })),
    },
    { type: 'separator' },
    { label: 'New conversation', click: () => { bridge.resetSession(); win.webContents.send('jarvis:reset') } },
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => app.quit() },
  ]))
  tray.on('click', () => showOrb(true))
}

/* ==========================================================================
   IPC
   ========================================================================== */

ipcMain.on('ui:fullscreen', (_e, on) => {
  if (!win || win.isDestroyed()) return
  fullMode = !!on
  if (fullMode) {
    const d = screen.getDisplayNearestPoint({
      x: win.getBounds().x + Math.round(WIN_W / 2),
      y: win.getBounds().y + Math.round(WIN_H / 2),
    })
    win.setBounds({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height })
    setIgnore(false)
  } else {
    const a = anchor()
    win.setBounds({ x: a.x, y: a.y, width: WIN_W, height: WIN_H })
    setIgnore(true)
    bumpHide()
  }
  console.log('[ui] fullscreen', fullMode, JSON.stringify(win.getBounds()))
})

ipcMain.on('notch:hover', (_e, hovering) => {
  if (!notchWin || notchWin.isDestroyed()) return
  notchWin.setIgnoreMouseEvents(!hovering, { forward: true })
})
ipcMain.on('notch:ping', () => {})

ipcMain.handle('ask:cancel', () => bridge.cancel())

ipcMain.handle('clipboard:history', () => clipHistory.slice(0, 4))
ipcMain.handle('clipboard:clear', () => { clipHistory.length = 0; return true })

ipcMain.handle('app:open', async (_e, target) => {
  if (!target) return { ok: false, text: 'no target' }
  try {
    const { shell } = require('electron')
    if (target.startsWith('http://') || target.startsWith('https://')) {
      await shell.openExternal(target)
      return { ok: true, text: 'opened ' + target }
    }
    await shell.openPath(target)
    return { ok: true, text: 'opened ' + target }
  } catch (e) {
    return { ok: false, text: e.message }
  }
})

ipcMain.handle('web:fetch', async (_e, url) => {
  if (!url || !url.startsWith('http')) return { ok: false, text: 'invalid url' }
  try {
    const https = require('https')
    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.setTimeout(10000, () => reject(new Error('timeout')))
    })
    const text = data
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000)
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: e.message }
  }
})

ipcMain.handle('system:uptime', () => os.uptime())

ipcMain.handle('system:cmd', async (_e, cmd) => {
  if (!cmd) return { ok: false, text: 'no command' }
  try {
    const { spawn } = require('child_process')
    const child = spawn(cmd, { shell: true, windowsHide: true, cwd: os.homedir() })
    let out = '', err = ''
    await new Promise((resolve, reject) => {
      child.stdout.on('data', d => out += d.toString())
      child.stderr.on('data', d => err += d.toString())
      child.on('close', resolve)
      child.on('error', reject)
      setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 30000)
    })
    return { ok: true, text: (out + '\n' + err).slice(0, 5000) }
  } catch (e) {
    return { ok: false, text: e.message }
  }
})

/* ==========================================================================
   Reminders + notes — the assistant's own memory of things to do
   ========================================================================== */

const REMINDER_FILE = path.join(__dirname, 'data', 'reminders.json')
const NOTE_FILE = path.join(__dirname, 'data', 'notes.json')
const reminderTimers = new Map()

function readJsonList(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

function writeJsonList(file, list) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(list.slice(-200), null, 2))
  } catch (e) { console.log('[store] write failed:', e.message) }
}

function fireReminder(item) {
  const payload = { kind: 'reminder', title: item.kind === 'timer' ? 'timer done' : 'reminder', detail: item.task }
  sendNotify(notify.notifyPayload('info', payload.title, payload.detail))
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('jarvis:reminder', item)
  }
  showOrb(false)
}

function scheduleReminder(item) {
  const at = Number(item.at)
  if (!Number.isFinite(at)) return false
  const delay = at - Date.now()
  if (delay <= 0) return false
  if (reminderTimers.has(item.id)) clearTimeout(reminderTimers.get(item.id))
  const t = setTimeout(() => {
    reminderTimers.delete(item.id)
    const list = readJsonList(REMINDER_FILE).filter((r) => r.id !== item.id)
    writeJsonList(REMINDER_FILE, list)
    fireReminder(item)
  }, Math.min(delay, 2147483647))
  reminderTimers.set(item.id, t)
  return true
}

ipcMain.handle('reminder:add', (_e, item) => {
  if (!item || typeof item !== 'object') return { ok: false }
  const at = Number(item.at)
  if (!Number.isFinite(at) || at <= Date.now()) return { ok: false, text: 'that time is in the past' }
  const entry = {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at,
    kind: item.kind === 'timer' ? 'timer' : 'reminder',
    task: String(item.task || 'reminder').slice(0, 200),
    created: Date.now(),
  }
  const list = readJsonList(REMINDER_FILE)
  list.push(entry)
  writeJsonList(REMINDER_FILE, list)
  scheduleReminder(entry)
  return { ok: true, item: entry }
})

ipcMain.handle('reminder:list', () => readJsonList(REMINDER_FILE).sort((a, b) => a.at - b.at))
ipcMain.handle('reminder:clear', (_e, id) => {
  let list = readJsonList(REMINDER_FILE)
  if (id) {
    const t = reminderTimers.get(id)
    if (t) { clearTimeout(t); reminderTimers.delete(id) }
    list = list.filter((r) => r.id !== id)
  } else {
    for (const t of reminderTimers.values()) clearTimeout(t)
    reminderTimers.clear()
    list = []
  }
  writeJsonList(REMINDER_FILE, list)
  return { ok: true, list }
})

ipcMain.handle('note:add', (_e, text) => {
  const body = String(text || '').trim()
  if (!body) return { ok: false }
  const list = readJsonList(NOTE_FILE)
  const entry = { id: 'n' + Date.now().toString(36), text: body.slice(0, 500), at: Date.now() }
  list.push(entry)
  writeJsonList(NOTE_FILE, list)
  return { ok: true, item: entry }
})
ipcMain.handle('note:list', () => readJsonList(NOTE_FILE).slice(-50).reverse())
ipcMain.handle('note:clear', () => { writeJsonList(NOTE_FILE, []); return { ok: true } })

ipcMain.on('notch:summon', () => showOrb(true))
ipcMain.on('notch:newchat', () => {
  bridge.resetSession()
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:reset')
  showOrb(true)
})


/* ==========================================================================
   IPC — renderer surface
   ========================================================================== */

const THEME_RESP = () => ({ ...THEME, ...(config.theme || {}) })

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

let askSeq = 0

ipcMain.handle('ask', async (_e, text, opts) => {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, text: 'Nothing to ask.' }
  const verdict = guard.review(text)
  if (verdict.needsApproval && !(opts && opts.approved === true)) {
    return { ok: false, needsApproval: true, text: `${verdict.reason}\n\u201c${text.trim().slice(0, 200)}\u201d` }
  }
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:state', 'thinking')

  /* stream the answer in as the model produces it */
  const streamId = ++askSeq
  const res = await bridge.ask(text.trim(), {
    onDelta: (delta) => {
      if (win && !win.isDestroyed()) win.webContents.send('jarvis:stream', { id: streamId, delta })
    },
  })
  if (win && !win.isDestroyed()) {
    // a cancelled ask is not an error
    win.webContents.send('jarvis:state', res.stopped ? 'idle' : res.ok ? 'done' : 'error')
  }
  return res
})

ipcMain.handle('reset', () => { bridge.resetSession(); return true })
ipcMain.handle('pos', () => (win && !win.isDestroyed() ? [win.getBounds().x, win.getBounds().y] : [0, 0]))
ipcMain.handle('copy', async (_e, text) => {
  try { await clipboard.writeText(String(text || '')); return true } catch { return false }
})

ipcMain.handle('theme:get', () => THEME_RESP())
ipcMain.handle('theme:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return THEME_RESP()
  config.theme = { ...(config.theme || {}), ...patch }
  Object.assign(THEME, patch)
  saveConfig()
  broadcast('jarvis:theme', THEME_RESP())
  return THEME_RESP()
})

ipcMain.handle('setAutoHide', (_e, secs) => {
  const n = Number(secs)
  if (Number.isFinite(n) && n >= 0) {
    config.autoHideSeconds = n
    saveConfig()
    bumpHide()
  }
  return config.autoHideSeconds
})

ipcMain.handle('control:get', async () => {
  const net = await netmode.status(config.netMode === 'proxy' ? 'proxy' : 'direct')
  return {
    net,
    preferLocal: !!config.preferLocal,
    memoryOn: memory.isEnabled(),
    monitorOn: config.monitorOn !== false,
    activityOn: activity.isEnabled(),
  }
})

ipcMain.handle('control:set', async (_e, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {}
  if (p.netMode === 'proxy' || p.netMode === 'direct') {
    config.netMode = p.netMode
    bridge.settings.netMode = p.netMode
  }
  if (typeof p.preferLocal === 'boolean') {
    config.preferLocal = p.preferLocal
    bridge.settings.preferLocal = p.preferLocal
  }
  if (typeof p.memoryOn === 'boolean') memory.setEnabled(p.memoryOn)
  if (typeof p.monitorOn === 'boolean') {
    config.monitorOn = p.monitorOn
    if (p.monitorOn) startMonitor()
    else stopMonitor()
  }
  if (typeof p.activityOn === 'boolean') {
    activity.setEnabled(p.activityOn)
    if (p.activityOn) startActivity()
    else activity.stop()
  }
  saveConfig()
  const net = await netmode.status(config.netMode === 'proxy' ? 'proxy' : 'direct')
  return {
    net,
    preferLocal: !!config.preferLocal,
    memoryOn: memory.isEnabled(),
    monitorOn: config.monitorOn !== false,
    activityOn: activity.isEnabled(),
  }
})

ipcMain.handle('memory:list', () => memory.list())
ipcMain.handle('memory:forget', (_e, q) => { memory.forget(q); return memory.list() })
ipcMain.handle('monitor:recent', () => monitor.recent(10))

ipcMain.handle('media:pick', async () => {
  if (!win || win.isDestroyed()) return null
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick a file for Jarvis',
    properties: ['openFile'],
    filters: [
      { name: 'Everything useful', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'mp4', 'webm', 'mov', 'mkv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

ipcMain.handle('media:open', async (_e, file) => {
  try { await shell.openPath(String(file || '')); return true } catch { return false }
})

ipcMain.handle('dash:weather', async (_e, city) => {
  try { return { ok: true, data: await dashboard.weather(String(city || '')) } } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('dash:hardware', async () => {
  try { return { ok: true, data: await dashboard.hardware() } } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('dash:cal:list', async () => {
  try { return { ok: true, data: await dashboard.calendarList() } } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('dash:cal:add', async (_e, ev) => {
  try { return { ok: true, data: await dashboard.calendarAdd(ev) } } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('dash:cal:del', async (_e, id) => {
  try { return { ok: true, data: await dashboard.calendarDelete(id) } } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('activity:status', () => activity.status())
ipcMain.handle('activity:set', (_e, on) => {
  activity.setEnabled(!!on)
  if (on) startActivity()
  else activity.stop()
  saveConfig()
  return activity.status()
})

ipcMain.handle('voice:say', (_e, text) => {
  const t = String(text || '').slice(0, 1200)
  if (!t) return false
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak([Console]::In.ReadToEnd())',
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }).stdin.end(t)
    return true
  } catch { return false }
})

ipcMain.on('ui:show', () => showOrb(true))
ipcMain.on('ui:hide', () => hideOrb())
ipcMain.on('ui:hover', (_e, hovering) => setIgnore(!hovering))
ipcMain.on('ui:activity', () => bumpHide())
ipcMain.on('ui:recenter', () => {
  if (!win || win.isDestroyed()) return
  const a = anchor()
  win.setPosition(a.x, a.y)
})

/* ==========================================================================
   Background services + bootstrap
   ========================================================================== */

let monitorTimer = null

function startMonitor() {
  stopMonitor()
  try {
    monitorTimer = monitor.start({
      cpuFn: () => cpuPercent(),
      intervalMs: 30000,
      onAlert: (msgs) => {
        if (!Array.isArray(msgs) || !msgs.length) return
        if (win && !win.isDestroyed()) win.webContents.send('jarvis:alert', msgs)
        sendNotify(notify.notifyPayload('info', 'alert', msgs.join(' · ')))
      },
    })
  } catch (e) {
    console.log('[monitor] failed to start:', e.message)
  }
}

function stopMonitor() {
  if (monitorTimer && typeof monitorTimer === 'function') { try { monitorTimer() } catch {} }
  else if (monitorTimer && typeof monitorTimer.stop === 'function') { try { monitorTimer.stop() } catch {} }
  monitorTimer = null
}

function startActivity() {
  try {
    activity.start({
      getCursor: () => screen.getCursorScreenPoint(),
      isIdle: () => false,
      getProcess: () => '',
    })
  } catch (e) {
    console.log('[activity] failed to start:', e.message)
  }
}

app.whenReady().then(() => {
  configureLogin()
  protocol.handle('app', serveFromDisk)
  createWindow()
  createNotch()
  buildTray()

  for (const r of readJsonList(REMINDER_FILE)) {
    if (r && Number(r.at) > Date.now()) scheduleReminder(r)
  }

  startStats()
  startClipWatch()
  startShotWatch()
  if (config.monitorOn !== false) startMonitor()
  if (activity.isEnabled()) startActivity()

  const quitShortcut = globalShortcut.register('Control+E', () => {
    console.log('[ui] Control+E — quitting')
    app.quit()
  })
  if (!quitShortcut) console.log('[ui] Control+E could not be registered (in use by another app)')

  globalShortcut.register('Control+Alt+J', () => {
    if (!win) return
    if (win.isVisible()) hideOrb()
    else showOrb(true)
  })

  console.log('[boot] jarvis ready')
})

/* A tray app never exits when a window closes. */
app.on('window-all-closed', (e) => { if (e && e.preventDefault) e.preventDefault() })

app.on('will-quit', () => {
  if (statsTimer) clearInterval(statsTimer)
  if (gpuTimer) clearInterval(gpuTimer)
  if (hideTimer) clearTimeout(hideTimer)
  if (clipTimer) clearInterval(clipTimer)
  stopMonitor()
  activity.stop()
  try { globalShortcut.unregisterAll() } catch {}
  for (const w of shotWatchers) { try { w.close() } catch {} }
})
