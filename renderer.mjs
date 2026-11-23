import * as THREE from './vendor/three.module.js'
import { parseCommand } from './lib/commands.mjs'
import { parseIntent, intentLine } from './lib/intent.mjs'
import { parseReminder, parseNote } from './lib/reminders.mjs'

/* =========================================================================
   JARVIS
   Default view: the orb + floating text on a fully transparent window.
   Click the orb and the galaxy opens with the dashboard, hardware, music
   and settings panels.
   ========================================================================= */

const $ = (id) => document.getElementById(id)
const thread = $('thread')
const input = $('input')
const field = $('field')
const form = $('inputbar')
const sendBtn = $('send') // removed: Enter submits
const drawer = $('drawer')
const ptitle = $('ptitle')
const alerts = $('alerts')

let busy = false
let askToken = 0
let typingTimer = null
let liveTurn = null
let drawerFor = null
let mode = 'orb'

/* =========================================================================
   ORB — three.js
   ========================================================================= */
const canvas = $('orb')
const SIZE = 276

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.setSize(SIZE, SIZE, false)
renderer.setClearColor(0x000000, 0)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80)
camera.position.set(0, 0, 3.9)

const STATES = {
  idle: new THREE.Color('#7fb4d8'),
  listening: new THREE.Color('#b4d4ec'),
  thinking: new THREE.Color('#9db7ff'),
  done: new THREE.Color('#8fd1b8'),
  error: new THREE.Color('#e07882'),
}

let state = 'idle'
const targetColor = STATES.idle.clone()
const liveColor = STATES.idle.clone()
let energy = 0
let energyTarget = 0

/* glow plane — a circle sized to the frustum, alpha forced to 0 at the rim */
const GLOW_Z = -2
const _dist = camera.position.z - GLOW_Z
const _halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * _dist

const glowMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: liveColor } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r = length(d) * 2.0;
      float g = exp(-r * r * 3.0) * 0.58 + exp(-r * r * 12.0) * 0.34;
      g *= smoothstep(0.96, 0.34, r);
      g *= 1.0 - smoothstep(0.90, 1.0, r);
      gl_FragColor = vec4(uColor, g);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false,
})
const glow = new THREE.Mesh(new THREE.CircleGeometry(_halfH, 96), glowMat)
glow.position.z = GLOW_Z
glow.renderOrder = 0
scene.add(glow)

const coreMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: liveColor }, uEnergy: { value: 0 } },
  vertexShader: `
    varying vec3 vN; varying vec3 vP; varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vP = normalize(position);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    uniform float uTime; uniform vec3 uColor; uniform float uEnergy;
    varying vec3 vN; varying vec3 vP; varying vec3 vView;
    void main() {
      float ndv = clamp(dot(vN, vView), 0.0, 1.0);
      float rim  = pow(1.0 - ndv, 2.6);
      float body = pow(ndv, 0.9);
      float w1 = sin(vP.y * 12.0 + uTime * 1.3) * sin(vP.x * 9.0 - uTime * 0.95 + vP.z * 6.0);
      float w2 = sin(vP.z * 15.0 - uTime * 0.8) * sin(vP.y * 7.0 + uTime * 1.15);
      float veins = smoothstep(0.46, 1.0, abs(w1 * w2)) * (0.35 + 0.65 * uEnergy);
      vec3 col = uColor * (0.26 + body * 0.58 + rim * 1.65 + veins * 0.5);
      float a  = clamp(0.50 + body * 0.26 + rim * 0.40 + veins * 0.16, 0.0, 1.0);
      gl_FragColor = vec4(col, a);
    }
  `,
  transparent: true, depthWrite: false,
})
const core = new THREE.Mesh(new THREE.SphereGeometry(0.72, 72, 72), coreMat)
core.renderOrder = 2
scene.add(core)

const nucleusMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: liveColor } },
  vertexShader: `
    varying vec3 vN; varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    varying vec3 vN; varying vec3 vView;
    void main() {
      float ndv = clamp(dot(vN, vView), 0.0, 1.0);
      float c = pow(ndv, 1.6);
      gl_FragColor = vec4(uColor * (0.8 + c * 1.5), clamp(0.55 + c * 0.45, 0.0, 1.0));
    }
  `,
  transparent: true, depthWrite: false,
})
const nucleus = new THREE.Mesh(new THREE.SphereGeometry(0.40, 40, 40), nucleusMat)
nucleus.renderOrder = 1
scene.add(nucleus)

const cageMat = new THREE.LineBasicMaterial({
  color: liveColor, transparent: true, opacity: 0.13,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
const cage = new THREE.LineSegments(
  new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.0, 2)),
  cageMat,
)
cage.renderOrder = 3
scene.add(cage)

const ringMat = new THREE.MeshBasicMaterial({
  color: liveColor, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
const ring = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.0055, 8, 160), ringMat)
ring.rotation.set(-1.05, 0.25, 0)
ring.renderOrder = 4
scene.add(ring)

const TICKS = 96
const tickPos = new Float32Array(TICKS * 3)
for (let i = 0; i < TICKS; i++) {
  const a = (i / TICKS) * Math.PI * 2
  tickPos[i * 3] = Math.cos(a) * 1.30
  tickPos[i * 3 + 1] = Math.sin(a) * 1.30
  tickPos[i * 3 + 2] = 0
}
const tickGeo = new THREE.BufferGeometry()
tickGeo.setAttribute('position', new THREE.BufferAttribute(tickPos, 3))
const tickMat = new THREE.PointsMaterial({
  color: liveColor, size: 0.018, transparent: true, opacity: 0.4,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
const ticks = new THREE.Points(tickGeo, tickMat)
ticks.rotation.set(-1.05, 0.25, 0)
ticks.renderOrder = 4
scene.add(ticks)

const HALO_N = 190
const haloPos = new Float32Array(HALO_N * 3)
for (let i = 0; i < HALO_N; i++) {
  const a = Math.random() * Math.PI * 2
  const r = 1.42 + (Math.random() - 0.5) * 0.26
  haloPos[i * 3] = Math.cos(a) * r
  haloPos[i * 3 + 1] = (Math.random() - 0.5) * 0.55
  haloPos[i * 3 + 2] = Math.sin(a) * r
}
const haloGeo = new THREE.BufferGeometry()
haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3))
const haloMat = new THREE.PointsMaterial({
  color: liveColor, size: 0.022, transparent: true, opacity: 0.45,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
})
const halo = new THREE.Points(haloGeo, haloMat)
halo.rotation.x = -0.85
halo.renderOrder = 5
scene.add(halo)

const LABELS = { idle: 'ONLINE', listening: 'LISTENING', thinking: 'THINKING', done: 'ONLINE', error: 'ERROR' }

function setState(next) {
  state = next in STATES ? next : 'idle'
  targetColor.copy(STATES[state])
  energyTarget = state === 'thinking' ? 1 : state === 'listening' ? 0.5 : state === 'done' ? 0.28 : 0
  const dot = $('dot')
  if (dot) dot.dataset.s = state
  const t = $('state-txt')
  if (t) t.textContent = LABELS[state]
}

function applyAccent(hex) {
  const c = new THREE.Color(hex)
  STATES.idle.set(c)
  STATES.listening.set(c.clone().lerp(new THREE.Color('#ffffff'), 0.3))
  targetColor.copy(STATES[state])
  liveColor.copy(c)
  glowMat.uniforms.uColor.value = c
  coreMat.uniforms.uColor.value = c
  nucleusMat.uniforms.uColor.value = c
  cageMat.color.set(c)
  ringMat.color.set(c)
  tickMat.color.set(c)
  haloMat.color.set(c)
}

const clock = new THREE.Clock()
let elapsed = 0

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  elapsed += dt

  liveColor.lerp(targetColor, Math.min(1, dt * 5.5))
  energy += (energyTarget - energy) * Math.min(1, dt * 3.2)

  coreMat.uniforms.uTime.value = elapsed
  coreMat.uniforms.uEnergy.value = energy
  cageMat.color.copy(liveColor)
  ringMat.color.copy(liveColor)
  tickMat.color.copy(liveColor)
  haloMat.color.copy(liveColor)
  glowMat.uniforms.uColor.value = liveColor

  core.rotation.y += dt * (0.28 + energy * 1.1)
  core.rotation.x += dt * 0.10
  nucleus.rotation.y -= dt * (0.55 + energy * 2.2)
  cage.rotation.y -= dt * (0.34 + energy * 1.5)
  cage.rotation.z += dt * 0.07
  ring.rotation.z += dt * (0.16 + energy * 1.1)
  ring.rotation.y += dt * 0.08
  ticks.rotation.z -= dt * (0.05 + energy * 0.5)
  halo.rotation.y += dt * (0.30 + energy * 1.6)

  const breath = 1 + Math.sin(elapsed * (1.3 + energy * 2.6)) * (0.020 + energy * 0.028)
  core.scale.setScalar(breath)
  nucleus.scale.setScalar(1 + Math.sin(elapsed * 2.1) * 0.06 + energy * 0.10)
  cage.scale.setScalar(1 + Math.sin(elapsed * 1.05 + 1.1) * 0.016)

  ringMat.opacity = 0.34 + 0.16 * Math.sin(elapsed * 1.4) + energy * 0.26
  cageMat.opacity = 0.10 + 0.04 * Math.sin(elapsed * 0.9) + energy * 0.13
  tickMat.opacity = 0.30 + 0.12 * Math.sin(elapsed * 1.9 + 0.7)
  haloMat.opacity = 0.34 + 0.14 * Math.sin(elapsed * 1.6) + energy * 0.2

  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

/* =========================================================================
   GALAXY — the heart of Jarvis: a spiral galaxy with a live solar system
   ========================================================================= */
const gal = $('galaxy')
const gctx = gal.getContext('2d')
let galOn = false
let galRaf = 0
let galLast = 0
let gW = 0
let gH = 0
let gS = 1
let galStars = []
let galArms = []
let galPlanets = []

function sizeGalaxy() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  gW = window.innerWidth
  gH = window.innerHeight
  gS = Math.min(gW, gH)
  gal.width = Math.round(gW * dpr)
  gal.height = Math.round(gH * dpr)
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function buildGalaxy() {
  const s = gS
  const nStars = Math.min(420, Math.round((gW * gH) / 11000))
  galStars = Array.from({ length: nStars }, () => ({
    x: Math.random(), y: Math.random(),
    r: 0.35 + Math.random() * 1.05,
    a: 0.10 + Math.random() * 0.45,
    ph: Math.random() * 6.283,
    sp: 0.7 + Math.random() * 2.2,
  }))

  galArms = []
  for (let arm = 0; arm < 3; arm++) {
    for (let i = 0; i < 230; i++) {
      const rr = Math.pow(Math.random(), 0.62) * 0.46 + 0.02
      const spread = (Math.random() - 0.5) * (0.30 + rr * 0.55)
      galArms.push({
        r: rr * s,
        a: (arm / 3) * 6.283 + rr * 5.6 + spread,
        size: 0.35 + Math.random() * 1.4,
        alpha: 0.08 + Math.random() * 0.5,
        violet: Math.random() < 0.18,
        tw: Math.random() * 6.283,
      })
    }
  }

  // orbit radius (fraction of the short side), angular speed, body size, tilt
  galPlanets = [
    { d: 0.110, sp: 0.62, size: 2.0, tilt: 0.40, ph: 0.4, c: '196, 224, 246' },
    { d: 0.165, sp: 0.40, size: 2.8, tilt: 0.50, ph: 2.4, c: '156, 204, 236' },
    { d: 0.230, sp: 0.27, size: 1.7, tilt: 0.34, ph: 4.6, c: '206, 196, 240' },
    { d: 0.300, sp: 0.18, size: 3.0, tilt: 0.26, ph: 1.2, c: '176, 216, 236' },
  ]
}

function drawGalaxy(t) {
  const w = gW, h = gH, s = gS
  const cx = w / 2, cy = h * 0.5

  const base = gctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.8)
  base.addColorStop(0, 'rgba(15, 27, 41, .97)')
  base.addColorStop(0.45, 'rgba(8, 14, 23, .98)')
  base.addColorStop(1, 'rgba(3, 5, 10, 1)')
  gctx.fillStyle = base
  gctx.fillRect(0, 0, w, h)

  gctx.globalCompositeOperation = 'lighter'

  // nebula
  const clouds = [
    { x: cx + Math.sin(t * 0.05) * s * 0.06, y: cy - s * 0.10, r: s * 0.60, c: 'rgba(52, 92, 138, .17)' },
    { x: cx - s * 0.24, y: cy + s * 0.20, r: s * 0.44, c: 'rgba(82, 70, 132, .13)' },
    { x: cx + s * 0.26, y: cy + s * 0.05, r: s * 0.38, c: 'rgba(38, 108, 140, .10)' },
  ]
  for (const c of clouds) {
    const g = gctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r)
    g.addColorStop(0, c.c)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    gctx.fillStyle = g
    gctx.fillRect(0, 0, w, h)
  }

  // spiral arms — differential rotation, flattened by perspective
  for (const p of galArms) {
    const speed = 0.05 + (0.10 * s) / (p.r + 40)
    const a = p.a + t * speed
    const x = cx + Math.cos(a) * p.r
    const y = cy + Math.sin(a) * p.r * 0.60
    const tw = 0.6 + 0.4 * Math.sin(t * 1.8 + p.tw)
    gctx.beginPath()
    gctx.arc(x, y, p.size, 0, 6.283)
    gctx.fillStyle = p.violet
      ? 'rgba(192, 188, 242, ' + (p.alpha * tw * 0.8).toFixed(3) + ')'
      : 'rgba(208, 228, 245, ' + (p.alpha * tw).toFixed(3) + ')'
    gctx.fill()
  }

  // orbits
  gctx.globalCompositeOperation = 'source-over'
  for (const pl of galPlanets) {
    gctx.beginPath()
    gctx.ellipse(cx, cy, pl.d * s, pl.d * s * pl.tilt, 0, 0, 6.283)
    gctx.strokeStyle = 'rgba(176, 204, 228, .11)'
    gctx.lineWidth = 1
    gctx.stroke()
  }

  // planets with a glow head
  gctx.globalCompositeOperation = 'lighter'
  for (const pl of galPlanets) {
    const a = pl.ph + t * pl.sp
    const x = cx + Math.cos(a) * pl.d * s
    const y = cy + Math.sin(a) * pl.d * s * pl.tilt
    const glow = gctx.createRadialGradient(x, y, 0, x, y, pl.size * 6)
    glow.addColorStop(0, 'rgba(' + pl.c + ', .8)')
    glow.addColorStop(1, 'rgba(' + pl.c + ', 0)')
    gctx.fillStyle = glow
    gctx.beginPath()
    gctx.arc(x, y, pl.size * 6, 0, 6.283)
    gctx.fill()
    gctx.fillStyle = '#eff8ff'
    gctx.beginPath()
    gctx.arc(x, y, pl.size, 0, 6.283)
    gctx.fill()
  }

  // the heart: a pulsing core
  const beat = 1 + 0.07 * Math.sin(t * 1.7) + 0.035 * Math.sin(t * 3.4)
  const coreR = s * 0.072 * beat
  const core = gctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 4.4)
  core.addColorStop(0, 'rgba(255, 255, 255, .95)')
  core.addColorStop(0.22, 'rgba(176, 216, 246, .55)')
  core.addColorStop(0.55, 'rgba(110, 165, 210, .18)')
  core.addColorStop(1, 'rgba(60, 110, 160, 0)')
  gctx.fillStyle = core
  gctx.beginPath()
  gctx.arc(cx, cy, coreR * 4.4, 0, 6.283)
  gctx.fill()

  // far starfield
  gctx.globalCompositeOperation = 'source-over'
  for (const st of galStars) {
    const tw = 0.45 + 0.55 * Math.sin(t * st.sp + st.ph)
    gctx.beginPath()
    gctx.arc(st.x * w, st.y * h, st.r, 0, 6.283)
    gctx.fillStyle = 'rgba(212, 230, 246, ' + (st.a * tw).toFixed(3) + ')'
    gctx.fill()
  }
}

function paintGalaxy(ts) {
  galRaf = requestAnimationFrame(paintGalaxy)
  if (ts - galLast < 28) return
  galLast = ts
  drawGalaxy(ts / 1000)
}

function setGalaxy(on) {
  if (on === galOn) return
  galOn = on
  if (on) {
    sizeGalaxy()
    buildGalaxy()
    galLast = 0
    galRaf = requestAnimationFrame(paintGalaxy)
  } else {
    cancelAnimationFrame(galRaf)
  }
}

window.addEventListener('resize', () => {
  if (!galOn) return
  sizeGalaxy()
  buildGalaxy()
})

/* =========================================================================
   MODES
   ========================================================================= */
function setMode(next) {
  mode = next
  document.body.classList.toggle('mode-inside', next === 'inside')
  document.body.classList.toggle('mode-orb', next !== 'inside')
  setGalaxy(next === 'inside')
}

function enterInside() {
  if (mode === 'inside') return
  setMode('inside')
}

function backToOrb() {
  closeDrawer(true)
  setMode('orb')
  input.focus()
}

/* =========================================================================
   THREAD
   ========================================================================= */
function atBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90
}
function scrollThread(force = true) {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight
}

function addTurn(role, text, cls = '') {
  const el = document.createElement('div')
  el.className = 'turn ' + role + (cls ? ' ' + cls : '')
  el.textContent = text
  thread.appendChild(el)
  scrollThread()
  return el
}
const addSys = (text, plain = false) => addTurn('sys', text, plain ? 'plain' : '')

function clearThread(placeholder) {
  thread.innerHTML = ''
  liveTurn = null
  if (placeholder) addSys(placeholder)
}

function typewrite(text, ok) {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
  if (!liveTurn) liveTurn = addTurn('bot', '')
  liveTurn.classList.toggle('bad', !ok)
  liveTurn.classList.add('typing')
  liveTurn.textContent = ''
  const body = text == null ? '' : String(text)
  if (!body) { liveTurn.classList.remove('typing'); return }

  // Instant for long answers, fast typewriter for short ones
  if (body.length > 500) {
    liveTurn.textContent = body
    liveTurn.classList.remove('typing')
    scrollThread()
    return
  }
  const step = Math.max(1, Math.ceil(body.length / 80))
  /* hold the element: liveTurn can be reassigned when the next answer starts */
  const el = liveTurn
  let i = 0
  typingTimer = setInterval(() => {
    if (!el || !el.isConnected) { clearInterval(typingTimer); typingTimer = null; return }
    i += step
    el.textContent = body.slice(0, i)
    scrollThread(atBottom())
    if (i >= body.length) {
      clearInterval(typingTimer); typingTimer = null
      el.textContent = body
      el.classList.remove('typing')
      scrollThread()
    }
  }, 4)
}

/* =========================================================================
   DRAWER
   ========================================================================= */
const TITLES = { dashboard: 'SYSTEM', hardware: 'HARDWARE', settings: 'SETTINGS' }

function applyPanel(name) {
  if (!name) return
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.p === name)
  for (const b of document.querySelectorAll('.rbtn')) b.classList.toggle('on', b.dataset.panel === name)
  ptitle.textContent = TITLES[name] || name.toUpperCase()
  drawer.classList.add('open')
  drawer.setAttribute('aria-hidden', 'false')
  drawerFor = name
  drawer.querySelector('.pbody').scrollTop = 0
  input.blur()

  if (name === 'dashboard') {
    loadHw('dash')
  }
  if (name === 'hardware') loadHw('hw')
  if (name === 'settings') { syncSettingsUI(); renderMemory() }
}

function openPanel(name) {
  if (!name) return
  if (mode !== 'inside') setMode('inside')
  applyPanel(name)
}

function closeDrawer(silent) {
  drawer.classList.remove('open')
  drawer.setAttribute('aria-hidden', 'true')
  for (const b of document.querySelectorAll('.rbtn')) b.classList.remove('on')
  drawerFor = null
  if (!silent) setMode('orb')
}

function backFromDrawer() {
  closeDrawer(true)
  setMode('orb')
  input.focus()
}

/* =========================================================================
   ASK
   ========================================================================= */
const askQueue = []

/* Small dev hook so the queue state can be inspected from CDP / tests. */
window.__jarvisQueue = () => ({ busy, queued: askQueue.length, state })

async function runAsk(text, opts = {}) {
  if (!text) return
  if (!opts.silent) addTurn('me', text)

  // If already answering, queue this question
  if (busy) {
    askQueue.push({ text, opts })
    return
  }

  await processQueue(text, opts)
}

async function processQueue(firstText, firstOpts) {
  const token = ++askToken
  busy = true
  if (sendBtn) sendBtn.disabled = true
  setState('thinking')

  let text = firstText
  let opts = firstOpts

  try {
    while (true) {
      let res
      try {
        res = await window.jarvis.ask(text, opts.approved ? { approved: true } : undefined)
      } catch (e) {
        res = { ok: false, text: String((e && e.message) || e) }
      }

      if (token !== askToken) return

      /* If the answer already streamed in, finish that bubble instead of
         printing the same text a second time. */
      const streamed = liveTurn && liveTurn.classList && liveTurn.classList.contains('streaming') ? liveTurn : null
      if (streamed) {
        streamed.textContent = (res.text || streamed.textContent || '').trim()
        streamed.classList.remove('typing', 'streaming')
        streamed.classList.toggle('bad', !res.ok)
        liveTurn = streamed
        scrollThread()
      } else {
        liveTurn = null
        typewrite(res.text || '(empty reply)', res.ok)
      }
      if (res.needsApproval) showApproval(text)

      if (askQueue.length > 0) {
        const next = askQueue.shift()
        text = next.text
        opts = next.opts
        /* the question is already in the transcript (runAsk added it) */
        liveTurn = null
        setState('thinking')
        continue
      }
      break
    }
  } finally {
    busy = false
    if (sendBtn) sendBtn.disabled = false
    setState('idle')
    if (mode === 'orb') input.focus()
  }
}

window.jarvis.onReminder((item) => {
  addSys(`⏰ ${item.kind === 'timer' ? 'timer' : 'reminder'} — ${item.task}`, true)
  setState('done')
})

/* Live tokens from the model: the answer grows as it is generated. */
let streamId = -1
window.jarvis.onStream(({ id, delta }) => {
  if (typeof delta !== 'string' || !delta) return
  if (id !== streamId) { streamId = id; liveTurn = null }
  if (!liveTurn) {
    liveTurn = addTurn('bot', '', 'streaming')
    liveTurn.classList.add('typing')
  }
  liveTurn.textContent += delta
  scrollThread(atBottom())
})

async function cancelAsk() {
  askToken++
  try { await window.jarvis.cancel?.() } catch {}
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
  if (liveTurn) {
    liveTurn.classList.remove('typing')
    if (!liveTurn.textContent.trim()) liveTurn.textContent = '—'
    liveTurn = null
  }
  busy = false
  if (sendBtn) sendBtn.disabled = false
  setState('idle')
  addSys('stopped', true)
  input.focus()
}

function showApproval(text) {
  const row = document.createElement('div')
  row.className = 'approve'
  const mk = (label, fn, ghost) => {
    const b = document.createElement('button')
    b.textContent = label
    if (ghost) b.classList.add('ghost')
    b.addEventListener('click', () => { row.remove(); fn() })
    return b
  }
  row.append(
    mk('Approve', () => runAsk(text, { approved: true, silent: true })),
    mk('Cancel', () => addSys('cancelled'), true),
  )
  thread.appendChild(row)
  scrollThread()
}

/* =========================================================================
   COMMANDS + INPUT
   ========================================================================= */
const HELP = [
  '/dashboard  weather, calendar, system',
  '/hardware   CPU, RAM, GPU live',
  '/settings   theme, switches, memory',
  '/attach     send a file for me to read',
  '/voice      read my last answer aloud',
  '/clr        clear the chat and its memory (alias: /clear)',
  '/new        start a fresh conversation',
  '',
  '/reminders  list what is scheduled',
  '/notes      list saved notes',
  '',
  'shortcuts   these skip the model and answer instantly:',
  '            remind me in 10 min to call mom · timer 5 min',
  '            note: buy milk · remember that <fact>',
  '            open notepad · open github.com · run ipconfig',
  '            read example.com',
  '',
  'esc         stop the answer · ctrl+e quit Jarvis',
].join('\n')

const history = []
let histAt = -1

function paintField() {
  const empty = input.value.length === 0
  field.classList.toggle('idle', empty)
  field.classList.toggle('has', !empty)
}

function submit() {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  paintField()
  if (history[history.length - 1] !== text) history.push(text)
  histAt = -1
  handle(text)
}

/* Fast path: apps, links and shell commands resolve locally in ms. */
async function localIntent(text, intent) {
  addTurn('me', text)
  let res = { ok: false, text: '' }
  try {
    if (intent.kind === 'app' || intent.kind === 'url') {
      res = (await window.jarvis.app.open(intent.target)) || { ok: true }
    } else if (intent.kind === 'run') {
      res = (await window.jarvis.system.cmd(intent.target)) || { ok: false, text: 'no output' }
    } else if (intent.kind === 'read') {
      res = (await window.jarvis.web.fetch(intent.target)) || { ok: false, text: 'no output' }
    }
  } catch (e) {
    res = { ok: false, text: String((e && e.message) || e) }
  }

  const line = intentLine(intent, res)
  if (line) addSys(line, true)

  if (intent.kind === 'run' && res.ok && res.text && res.text.trim()) {
    addTurn('bot', res.text.trim().slice(0, 1500), 'plain')
  }
  if (intent.kind === 'read' && res.ok && res.text) {
    const body = String(res.text).trim()
    if (intent.summarize) {
      /* read it here, then hand the text to the agent to answer about it */
      addSys(`\u2192 read ${body.length.toLocaleString()} chars from ${intent.label}`, true)
      runAsk(
        `Answer from this page only, in 3 short bullets, no preamble.\n` +
        `Page: ${intent.target}\n\n${body.slice(0, 6000)}`
      )
      return true
    }
    addTurn('bot', body.slice(0, 700) + (body.length > 700 ? '\n…' : ''), 'plain')
  }
  scrollThread()
  return true
}

async function localReminder(text, r) {
  addTurn('me', text)
  const res = await window.jarvis.reminders.add({ at: r.at, task: r.task, kind: r.kind })
  if (res && res.ok) addSys(`⏰ ${r.kind === 'timer' ? 'timer' : 'reminder'} set ${r.when} — ${r.task}`, true)
  else addSys('✗ could not set that reminder', true)
}

async function localNote(text, n) {
  addTurn('me', text)
  const res = await window.jarvis.notes.add(n.text)
  if (res && res.ok) addSys(`→ noted: ${n.text}`, true)
  else addSys('✗ could not save that note', true)
}

function handle(text) {
  const parsed = parseCommand(text)
  if (parsed.type === 'ask') {
    const intent = parseIntent(parsed.text)
    if (intent) { localIntent(parsed.text, intent); return }
    const rem = parseReminder(parsed.text)
    if (rem) { localReminder(parsed.text, rem); return }
    const note = parseNote(parsed.text)
    if (note) { localNote(parsed.text, note); return }
    runAsk(parsed.text)
    return
  }
  if (parsed.type !== 'command') return
  switch (parsed.name) {
    case 'help': addTurn('me', text); addSys(HELP, true); break
    case 'dashboard': case 'hardware': case 'settings':
      addTurn('me', text); openPanel(cmd.toLowerCase()); break
    case 'reminders':
      addTurn('me', text)
      window.jarvis.reminders.list().then((list) => {
        if (!list || !list.length) return addSys('no reminders set', true)
        for (const r of list) {
          const d = new Date(r.at)
          const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          addSys(`⏰ ${t} — ${r.task}`, true)
        }
      })
      break
    case 'notes':
      addTurn('me', text)
      window.jarvis.notes.list().then((list) => {
        if (!list || !list.length) return addSys('no notes saved', true)
        for (const n of list.slice(0, 10)) addSys(`• ${n.text}`, true)
      })
      break
    case 'attach': addTurn('me', text); pickFile(); break
    case 'voice': addTurn('me', text); speakLast(); break
    case 'clear': case 'clr':
      // wipe the transcript AND the agent session behind it
      window.jarvis.reset()
      clearThread('conversation cleared')
      input.focus()
      break
    case 'new': window.jarvis.reset(); clearThread('new conversation'); break
    case 'back': backFromDrawer(); break
    default:
      addTurn('me', text)
      addSys('unknown command · /help', true)
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); submit() })
input.addEventListener('input', paintField)
input.addEventListener('focus', paintField)
input.addEventListener('blur', paintField)

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (busy) { e.preventDefault(); cancelAsk(); return }
    if (mode === 'inside') { backFromDrawer(); e.preventDefault(); return }
    if (document.activeElement === input) { input.blur(); return }
  }
  if (document.activeElement === input) {
    if (e.key === 'ArrowUp' && history.length) {
      if (histAt === -1) histAt = history.length
      histAt = Math.max(0, histAt - 1)
      input.value = history[histAt] || ''
      paintField(); e.preventDefault()
    } else if (e.key === 'ArrowDown' && histAt !== -1) {
      histAt = Math.min(history.length, histAt + 1)
      input.value = histAt === history.length ? '' : history[histAt]
      paintField(); e.preventDefault()
    }
    return
  }
  if (mode !== 'orb') return
  if (e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey)) {
    input.focus()
    if (e.key === 'Enter') e.preventDefault()
  }
})

/* =========================================================================
   HOVER / DRAG
   ========================================================================= */
let hovering = false
let lastActivity = 0

function reportActivity() {
  const now = Date.now()
  if (now - lastActivity < 1200) return
  lastActivity = now
  window.jarvis.ping()
}

window.addEventListener('mousemove', (e) => {
  reportActivity()
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const want = !!(el && el.closest && el.closest('.hit'))
  if (want === hovering) return
  hovering = want
  window.jarvis.hover(want)
})
window.addEventListener('mouseleave', () => {
  if (!hovering) return
  hovering = false
  window.jarvis.hover(false)
})
window.addEventListener('keydown', reportActivity)

const bar = $('bar')
const stage = $('stage')
let downAt = null
let dragging = false

function finishDrag() {
  if (dragging) window.jarvis.dragEnd()
  dragging = false
  downAt = null
}

function attachDrag(el, onClick) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    downAt = { x: e.screenX, y: e.screenY }
    dragging = false
    try { el.setPointerCapture(e.pointerId) } catch {}
  })
  el.addEventListener('pointermove', (e) => {
    if (!downAt) return
    if (!dragging) {
      if (Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) <= 6) return
      dragging = true
      window.jarvis.dragStart()
    }
    window.jarvis.dragTo(e.screenX, e.screenY)
  })
  el.addEventListener('pointerup', (e) => {
    try { el.releasePointerCapture(e.pointerId) } catch {}
    const wasDrag = dragging
    finishDrag()
    if (!wasDrag && onClick) onClick()
  })
  for (const ev of ['pointercancel', 'lostpointercapture']) el.addEventListener(ev, finishDrag)
  window.addEventListener('blur', finishDrag)
}

attachDrag(bar, null)
attachDrag(stage, () => openPanel('dashboard'))

/* =========================================================================
   RAIL
   ========================================================================= */
for (const btn of document.querySelectorAll('.rbtn')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const name = btn.dataset.panel
    if (name === 'attach') { openPanel(drawerFor || 'dashboard'); pickFile(); return }
    if (name === 'voice') { speakLast(); return }
    if (name === 'exit') { backFromDrawer(); return }
    if (drawerFor === name) { backFromDrawer(); return }
    btn.classList.add('press')
    setTimeout(() => btn.classList.remove('press'), 420)
    openPanel(name)
  })
}
$('drawer-close').addEventListener('click', backFromDrawer)

/* =========================================================================
   GAUGES + METERS
   ========================================================================= */
const C = 2 * Math.PI * 26

function mkGauge(label) {
  const wrap = document.createElement('div')
  wrap.className = 'gwrap'
  wrap.innerHTML =
    `<div class="gring">
       <svg viewBox="0 0 64 64" aria-hidden="true">
         <circle class="trk" cx="32" cy="32" r="26"></circle>
         <circle class="val" cx="32" cy="32" r="26"></circle>
       </svg>
       <div class="gval">--</div>
     </div>
     <div class="glab">${label}</div>`
  const val = wrap.querySelector('.val')
  const num = wrap.querySelector('.gval')
  val.style.strokeDasharray = String(C)
  val.style.strokeDashoffset = String(C)
  return {
    el: wrap,
    set(pct, text) {
      const p = Math.max(0, Math.min(100, Number(pct) || 0))
      val.style.strokeDashoffset = String(C - (C * p) / 100)
      num.textContent = text
      wrap.classList.toggle('warm', p >= 70 && p < 88)
      wrap.classList.toggle('hot', p >= 88)
    },
  }
}

function mkMeter(label) {
  const m = document.createElement('div')
  m.className = 'meter'
  m.innerHTML = `<div class="mh"><span>${label}</span><b>--</b></div><div class="bar"><i></i></div>`
  const barEl = m.querySelector('.bar')
  const fill = m.querySelector('.bar i')
  const num = m.querySelector('b')
  return {
    el: m,
    set(pct, text) {
      const p = Math.max(0, Math.min(100, Number(pct) || 0))
      fill.style.width = p + '%'
      num.textContent = text
      barEl.classList.toggle('warm', p >= 70 && p < 88)
      barEl.classList.toggle('hot', p >= 88)
    },
  }
}

const dashG = { cpu: mkGauge('CPU'), ram: mkGauge('RAM'), gpu: mkGauge('GPU °C') }
$('d-gauges').append(dashG.cpu.el, dashG.ram.el, dashG.gpu.el)

const hwG = { cpu: mkGauge('CPU LOAD'), ram: mkGauge('RAM'), gpu: mkGauge('GPU °C') }
$('h-gauges').append(hwG.cpu.el, hwG.ram.el, hwG.gpu.el)

const hwMeters = { disk: mkMeter('DISK C:'), vram: mkMeter('VRAM') }
$('h-meters').append(hwMeters.disk.el, hwMeters.vram.el)

const dashMeters = { disk: mkMeter('DISK C:'), vram: mkMeter('VRAM') }
$('d-meters').append(dashMeters.disk.el, dashMeters.vram.el)

const SPARK_N = 60
const spark = []
let lastGpu = null

function paintSpark() {
  if (spark.length < 2) return
  const W = 300, H = 46
  const pts = spark.map((v, i) => {
    const x = (i / (SPARK_N - 1)) * W
    const y = H - (Math.max(0, Math.min(100, v)) / 100) * (H - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  $('spark-line').setAttribute('points', pts.join(' '))
  $('spark-fill').setAttribute('points', `0,${H} ` + pts.join(' ') + ` ${W},${H}`)
}

/* =========================================================================
   STATS
   ========================================================================= */
const gpuPct = (t) => (t == null ? 0 : Math.max(0, Math.min(100, (t - 30) * 1.7)))

function paintStats(s) {
  const cpu = s.cpu || 0
  const ram = s.ram || 0
  lastGpu = s.gpu == null ? null : s.gpu

  $('v-cpu').textContent = Math.round(cpu) + '%'
  $('v-ram').textContent = Math.round(ram) + '%'
  $('v-gpu').textContent = lastGpu == null ? '–' : Math.round(lastGpu) + '°C'

  dashG.cpu.set(cpu, Math.round(cpu) + '%')
  dashG.ram.set(ram, Math.round(ram) + '%')
  dashG.gpu.set(gpuPct(lastGpu), lastGpu == null ? '–' : Math.round(lastGpu) + '°')
  hwG.cpu.set(cpu, Math.round(cpu) + '%')
  hwG.ram.set(ram, Math.round(ram) + '%')
  hwG.gpu.set(gpuPct(lastGpu), lastGpu == null ? '–' : Math.round(lastGpu) + '°')

  spark.push(cpu)
  if (spark.length > SPARK_N) spark.shift()
  paintSpark()
}

window.jarvis.onStats((s) => { if (s) paintStats(s) })

/* =========================================================================
   DASHBOARD
   ========================================================================= */
function paintClock() {
  const now = new Date()
  const hm = $('clock-hm')
  if (hm) hm.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  const d = $('clock-date')
  if (d) {
    d.textContent =
      now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) +
      ' · ' + now.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop()
  }
}
paintClock()
setInterval(paintClock, 15000)

const fmt = (v, u = '') => (v == null ? 'n/a' : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${u}`)
const GB = (b) => (b == null ? null : b / 1024 ** 3)

async function loadHw(where) {
  const detail = where === 'hw' ? $('hw-detail') : $('hw-out')
  if (detail) detail.textContent = 'reading…'
  const r = await window.jarvis.dash.hardware()
  if (!r.ok) {
    if (detail) detail.textContent = 'unavailable: ' + r.error
    return
  }
  const h = r.data || {}
  const c = h.cpu || {}, m = h.ram || {}, g = h.gpu || {}

  if (where !== 'hw') {
    // dashboard: two lines only, the gauges and meters carry the rest
    const d1 = (h.disks || [])[0]
    const short = [
      `RAM  ${fmt(m.usedPercent, '%')} · ${fmt(GB(m.used))} / ${fmt(GB(m.total))} GB`,
      `GPU  ${fmt(g.temperature, '°C')} · load ${fmt(g.utilization, '%')}` + (d1 ? `  ·  ${d1.volume} ${fmt(GB(d1.free))} GB free` : ''),
    ]
    if (detail) detail.textContent = short.join('\n')
    const meters = dashMeters
    if (d1) meters.disk.set(d1.usedPercent, fmt(GB(d1.free)) + ' GB free')
    if (g.vramUsedMiB != null && g.vramTotalMiB) {
      meters.vram.set((g.vramUsedMiB / g.vramTotalMiB) * 100, `${fmt(g.vramUsedMiB)} / ${fmt(g.vramTotalMiB)} MiB`)
    } else {
      meters.vram.set(0, 'n/a')
    }
    return
  }

  const lines = [
    `CPU   ${c.model || 'unknown'}`,
    `      load ${fmt(c.usage, '%')} · temp ${fmt(c.temperature, '°C')}${c.temperature == null ? '  (no sensor)' : ''}`,
    `RAM   ${fmt(m.usedPercent, '%')} used · ${fmt(GB(m.used))} / ${fmt(GB(m.total))} GB`,
    `GPU   ${g.name || 'none'}`,
    `      ${fmt(g.temperature, '°C')} · load ${fmt(g.utilization, '%')} · vram ${fmt(g.vramUsedMiB)} / ${fmt(g.vramTotalMiB)} MiB`,
  ]
  for (const d of h.disks || []) {
    lines.push(`DISK  ${d.volume}${d.label ? ' ' + d.label : ''}: ${fmt(GB(d.free))} GB free of ${fmt(GB(d.total))} (${fmt(d.usedPercent, '%')} used)`)
  }
  if (h.battery && h.battery.present) lines.push(`BATT  ${fmt(h.battery.percent, '%')}`)
  if (detail) detail.textContent = lines.join('\n')

  const meters = where === 'hw' ? hwMeters : dashMeters
  const d0 = (h.disks || [])[0]
  if (d0) meters.disk.set(d0.usedPercent, fmt(GB(d0.free)) + ' GB free')
  if (g.vramUsedMiB != null && g.vramTotalMiB) {
    meters.vram.set((g.vramUsedMiB / g.vramTotalMiB) * 100, `${fmt(g.vramUsedMiB)} / ${fmt(g.vramTotalMiB)} MiB`)
  } else {
    meters.vram.set(0, 'n/a')
  }
}

$('hw-go').addEventListener('click', () => loadHw('hw'))

/* =========================================================================
   ATTACH / VOICE
   ========================================================================= */
async function pickFile() {
  if (busy) return
  const file = await window.jarvis.media.pick()
  if (!file) return
  backToOrb()
  const kind = /\.(png|jpe?g|gif|webp)$/i.test(file) ? 'picture'
    : /\.(mp4|webm|mov|mkv)$/i.test(file) ? 'video'
    : /\.(mp3|wav|m4a|flac|ogg)$/i.test(file) ? 'audio recording'
    : 'document'
  runAsk(`Explain this ${kind} for me in simple words. File: ${file}`)
}

function speakLast() {
  const bots = [...thread.querySelectorAll('.turn.bot:not(.bad)')]
  const last = bots[bots.length - 1]
  if (last && last.textContent.trim()) {
    window.jarvis.voice.say(last.textContent.trim())
  } else {
    addSys('nothing to read yet', true)
  }
}

/* =========================================================================
   CONTROLS
   ========================================================================= */
const tNet = $('t-net'), tLocal = $('t-local'), tMem = $('t-mem'), tMon = $('t-mon'), tAct = $('t-act')

function paintControls(c) {
  if (!c) return
  const set = (el, on) => el && el.setAttribute('aria-pressed', String(!!on))
  set(tNet, c.net && c.net.mode === 'proxy')
  set(tLocal, c.preferLocal)
  set(tMem, c.memoryOn)
  set(tMon, c.monitorOn)
  if (tNet) tNet.title = c.net && c.net.mode === 'proxy' && !c.net.tunnelRunning ? 'Throne is not running on 2080' : ''
}

const refreshControls = () => window.jarvis.control.get().then(paintControls)
const flip = (el, key, val) => el && el.addEventListener('click', async (e) => {
  e.stopPropagation()
  paintControls(await window.jarvis.control.set({ [key]: val(el) }))
})
const pressed = (el) => el.getAttribute('aria-pressed') === 'true'
flip(tNet, 'netMode', (el) => (pressed(el) ? 'direct' : 'proxy'))
flip(tLocal, 'preferLocal', (el) => !pressed(el))
flip(tMem, 'memoryOn', (el) => !pressed(el))
flip(tMon, 'monitorOn', (el) => !pressed(el))
refreshControls()

for (const row of document.querySelectorAll('.swrow')) {
  row.addEventListener('click', (e) => {
    const sw = row.querySelector('.sw')
    if (!sw || e.target === sw || sw.contains(e.target)) return
    sw.click()
  })
}

const paintAct = (s) => {
  if (!tAct) return
  tAct.setAttribute('aria-pressed', String(!!s.enabled))
  tAct.title = s.enabled ? `${s.minutesSampled || 0} min sampled` : ''
}
window.jarvis.activity.status().then(paintAct)
tAct.addEventListener('click', async (e) => {
  e.stopPropagation()
  paintAct(await window.jarvis.activity.set(!pressed(tAct)))
})

window.jarvis.onAlert((msgs) => {
  alerts.textContent = 'heads up: ' + msgs.join(' · ')
  alerts.hidden = false
  setTimeout(() => { alerts.hidden = true }, 20000)
})

/* =========================================================================
   SETTINGS
   ========================================================================= */
const sAccent = $('s-accent'), sAccentHex = $('s-accent-hex')
const sFont = $('s-font'), sOrb = $('s-orb'), sAutoHide = $('s-autohide')

function pushTheme(patch) {
  window.jarvis.theme.set(patch)
  applyTheme(patch)
}

function applyTheme(t) {
  const root = document.documentElement
  if (!t) return
  if (t.accent && /^#[0-9a-f]{6}$/i.test(t.accent)) {
    root.style.setProperty('--accent', t.accent)
    const n = parseInt(t.accent.slice(1), 16)
    root.style.setProperty('--accent-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`)
    applyAccent(t.accent)
    if (sAccent) sAccent.value = t.accent
    if (sAccentHex) sAccentHex.value = t.accent
    if ($('v-accent')) $('v-accent').textContent = t.accent
  }
  if (typeof t.fontScale === 'number') {
    root.style.setProperty('--font-scale', String(t.fontScale))
    if ($('v-font')) $('v-font').textContent = t.fontScale.toFixed(2) + '×'
  }
  if (typeof t.orbSize === 'number') {
    root.style.setProperty('--orb-size', `${Math.round(t.orbSize)}px`)
    if (sOrb) sOrb.value = t.orbSize
    if ($('v-orb')) $('v-orb').textContent = Math.round(t.orbSize) + 'px'
  }
  if (typeof t.autoHideSeconds === 'number') {
    if ($('v-autohide')) $('v-autohide').textContent = t.autoHideSeconds + 's'
    window.jarvis.setAutoHide?.(t.autoHideSeconds)
  }
}

function syncSettingsUI() {
  const t = window._theme || {}
  if (sFont) { sFont.value = t.fontScale ?? 1; $('v-font').textContent = (t.fontScale ?? 1).toFixed(2) + '×' }
  if (sOrb) { sOrb.value = t.orbSize ?? 128; $('v-orb').textContent = Math.round(t.orbSize ?? 128) + 'px' }
  if (sAutoHide) { sAutoHide.value = t.autoHideSeconds ?? 45; $('v-autohide').textContent = (t.autoHideSeconds ?? 45) + 's' }
  if (sAccent) sAccent.value = t.accent || '#7fb4d8'
  if (sAccentHex) sAccentHex.value = t.accent || '#7fb4d8'
  if ($('v-accent')) $('v-accent').textContent = t.accent || '#7fb4d8'
}

sAccent.addEventListener('input', () => { sAccentHex.value = sAccent.value; pushTheme({ accent: sAccent.value }) })
sAccentHex.addEventListener('change', () => {
  if (!/^#[0-9a-f]{6}$/i.test(sAccentHex.value)) { sAccentHex.value = sAccent.value; return }
  pushTheme({ accent: sAccentHex.value })
})
sFont.addEventListener('input', () => { $('v-font').textContent = Number(sFont.value).toFixed(2) + '×'; pushTheme({ fontScale: Number(sFont.value) }) })
sOrb.addEventListener('input', () => { $('v-orb').textContent = sOrb.value + 'px'; pushTheme({ orbSize: Number(sOrb.value) }) })
sAutoHide.addEventListener('input', () => { $('v-autohide').textContent = sAutoHide.value + 's'; pushTheme({ autoHideSeconds: Number(sAutoHide.value) }) })

async function renderMemory() {
  const items = await window.jarvis.memory.list()
  const ul = $('memlist')
  ul.innerHTML = ''
  if (!items.length) {
    const li = document.createElement('li')
    li.textContent = 'nothing yet — say "remember that …" to teach me'
    ul.appendChild(li)
    return
  }
  for (const t of items.slice(-20)) {
    const li = document.createElement('li')
    li.textContent = t
    ul.appendChild(li)
  }
}
$('mem-clear').addEventListener('click', async () => {
  await window.jarvis.memory.forget('')
  renderMemory()
  refreshControls()
})

/* =========================================================================
   MAIN EVENTS
   ========================================================================= */
window.jarvis.onState((s) => setState(s))
window.jarvis.onReset(() => clearThread('new conversation'))
window.jarvis.onBrief((prompt) => { if (prompt) { clearThread('startup brief'); runAsk(prompt, { silent: true }) } })
window.jarvis.onTheme((t) => { window._theme = t; applyTheme(t); if (drawerFor === 'settings') syncSettingsUI() })
window.jarvis.theme.get().then((t) => { window._theme = t; applyTheme(t) })

/* =========================================================================
   START
   ========================================================================= */
thread.addEventListener('click', async (e) => {
  const turn = e.target.closest('.turn.bot')
  if (!turn || turn.classList.contains('bad') || turn.classList.contains('typing')) return
  const text = turn.textContent.trim()
  if (!text) return
  const ok = await window.jarvis.copy(text)
  if (!ok) return
  turn.classList.add('copied')
  setTimeout(() => turn.classList.remove('copied'), 700)
})

window.__jarvis = {
  openPanel, backToOrb, setMode,
  stats: () => ({ on: mode, players: spark.length }),
}

setState('idle')
paintField()
setMode('orb')
input.focus()
