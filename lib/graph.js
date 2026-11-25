/* ------------------------------------------------------------ brain graph
 * Renders what Jarvis actually is: a manager in the middle, specialists around
 * it, the models and tools each one leans on, and the skills it can pick up.
 * Output is one self-contained HTML file (no CDN, no build step) that can be
 * opened in the browser or dropped into the desktop preview pane.
 *
 * Edges are not decoration: agent -> provider is who answers for it, and
 * manager -> specialist is the cascade order that actually runs.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'data', 'graph.html')

function readAgents() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agents.json'), 'utf8')) } catch (e) { return { agents: [], cascade: [] } }
}

function skills() {
  const dir = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'skills')
  const out = []
  const walk = (d, depth) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        const skill = path.join(d, e.name, 'SKILL.md')
        if (fs.existsSync(skill)) out.push({ name: e.name, group: path.basename(d) })
        else if (depth > 0) walk(path.join(d, e.name), depth - 1)
      }
    }
  }
  walk(dir, 2)
  return out
}

function envKeys() {
  const file = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env')
  const keys = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const m = line.match(/^([A-Z0-9_]+)_?(API_KEY|TOKEN|KEY)=/)
      if (m) keys.push(m[1] + (m[2] ? '_' + m[2] : ''))
    }
  } catch (e) {}
  return Array.from(new Set(keys))
}

function build() {
  const reg = readAgents()
  const agents = (reg.agents || []).slice().sort((a, b) => (a.priority || 99) - (b.priority || 99))
  const sk = skills()
  const keys = envKeys()
  const cascade = reg.cascade || []

  return { agents, cascade, skills: sk, keys, generated: new Date().toISOString() }
}

function html(g) {
  const data = JSON.stringify(g)
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Jarvis — agent brain</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e17;color:#c9d4e5;font:13px/1.4 ui-monospace,Consolas,monospace}
  #wrap{position:relative;width:100%;height:100%;overflow:hidden}
  svg{width:100%;height:100%;display:block}
  .node{cursor:pointer}
  .lbl{font-size:11px;fill:#a9b6cc;pointer-events:none}
  .lbl.big{font-size:13px;fill:#e6eefc}
  .edge{stroke:#2a3550;stroke-width:1.2;fill:none}
  .edge.cascade{stroke:#7ed6a8;stroke-dasharray:4 4;opacity:.55}
  .pulse{fill:#7ed6a8}
  #legend{position:absolute;left:14px;top:12px;font-size:11px;color:#8fa0bb;line-height:1.7}
  #legend b{color:#dbe6f7;font-weight:600}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
</style></head><body>
<div id="wrap"><svg id="s"></svg>
<div id="legend">
  <div><b>Jarvis brain</b> — generated ${new Date(g.generated).toLocaleString()}</div>
  <div><span class="dot" style="background:#7ed6a8"></span>cascade order (who runs next on failure)</div>
  <div><span class="dot" style="background:#7fb4d8"></span>specialist agents</div>
  <div><span class="dot" style="background:#a89cf0"></span>skills on disk</div>
</div></div>
<script>
const G = ${data};
const SVG = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('s');
let W = innerWidth, H = innerHeight;

function el(n, a) { const e = document.createElementNS(SVG, n); for (const k in a) e.setAttribute(k, a[k]); return e; }

function draw() {
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.innerHTML = '';
  const cx = W / 2, cy = H / 2;
  const R1 = Math.min(W, H) * 0.24;      // agent ring
  const R2 = Math.min(W, H) * 0.42;      // skills ring
  const agents = G.agents || [];
  const pos = {};

  // ---- edges first so nodes sit on top
  const manager = agents.find(a => a.name === 'manager');
  const specialists = agents.filter(a => a.name !== 'manager');
  specialists.forEach((a, i) => {
    const ang = (i / Math.max(1, specialists.length)) * Math.PI * 2 - Math.PI / 2;
    pos[a.name] = { x: cx + Math.cos(ang) * R1, y: cy + Math.sin(ang) * R1, ang };
    svg.appendChild(el('line', { x1: cx, y1: cy, x2: pos[a.name].x, y2: pos[a.name].y, class: 'edge' }));
  });

  // cascade path: dashed line through the specialists in order
  const order = (G.cascade || []).filter(n => pos[n]);
  for (let i = 0; i < order.length - 1; i++) {
    const a = pos[order[i]], b = pos[order[i + 1]];
    svg.appendChild(el('path', { d: 'M' + a.x + ' ' + a.y + ' Q ' + cx + ' ' + cy + ' ' + b.x + ' ' + b.y, class: 'edge cascade' }));
  }

  // skills: outer ring, grouped by category angle
  const sk = G.skills || [];
  const byGroup = {};
  sk.forEach(s => { (byGroup[s.group] = byGroup[s.group] || []).push(s) });
  const groups = Object.keys(byGroup);
  let si = 0;
  groups.forEach((grp, gi) => {
    const base = (gi / Math.max(1, groups.length)) * Math.PI * 2;
    byGroup[grp].forEach((s, k) => {
      const ang = base + (k - (byGroup[grp].length - 1) / 2) * 0.045;
      const x = cx + Math.cos(ang) * (R2 + (si % 3) * 12);
      const y = cy + Math.sin(ang) * (R2 + (si % 3) * 12);
      svg.appendChild(el('circle', { cx: x, cy: y, r: 2.2, fill: '#a89cf0', opacity: 0.75 }));
      if (k === 0) {
        const t = el('text', { x: x, y: y - 7, class: 'lbl', 'text-anchor': 'middle' });
        t.textContent = grp;
        svg.appendChild(t);
      }
      si++;
    });
  });

  // manager
  svg.appendChild(el('circle', { cx, cy, r: 26, fill: '#16203a', stroke: '#7ed6a8', 'stroke-width': 2 }));
  const mt = el('text', { x: cx, y: cy + 4, class: 'lbl big', 'text-anchor': 'middle' });
  mt.textContent = 'manager';
  svg.appendChild(mt);

  // specialists
  specialists.forEach(a => {
    const p = pos[a.name];
    const on = a.enabled !== false;
    svg.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: 17,
      fill: on ? '#16203a' : '#151821',
      stroke: on ? '#7fb4d8' : '#3a4457',
      'stroke-width': on ? 1.8 : 1,
      opacity: on ? 1 : 0.55
    }));
    const t = el('text', { x: p.x, y: p.y + 3.5, class: 'lbl', 'text-anchor': 'middle' });
    t.textContent = a.name;
    svg.appendChild(t);
    const m = el('text', { x: p.x, y: p.y + 30, class: 'lbl', 'text-anchor': 'middle', opacity: 0.62 });
    m.textContent = String(a.model || '').split('/').pop().slice(0, 18);
    svg.appendChild(m);
    if (!on && a.needs) {
      const n = el('text', { x: p.x, y: p.y + 42, class: 'lbl', 'text-anchor': 'middle', opacity: 0.5 });
      n.textContent = String(a.needs).slice(0, 22);
      svg.appendChild(n);
    }
  });

  // travelling pulse along the cascade, the "signal" of the brain
  if (order.length > 1) {
    const dot = el('circle', { r: 3, class: 'pulse' });
    svg.appendChild(dot);
    let seg = 0, t = 0;
    setInterval(() => {
      t += 0.035;
      if (t >= 1) { t = 0; seg = (seg + 1) % (order.length - 1); }
      const a = pos[order[seg]], b = pos[order[seg + 1]];
      dot.setAttribute('cx', a.x + (b.x - a.x) * t);
      dot.setAttribute('cy', a.y + (b.y - a.y) * t);
    }, 40);
  }
}

draw();
addEventListener('resize', () => { W = innerWidth; H = innerHeight; draw(); });
</script></body></html>`
}

function write() {
  const g = build()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, html(g))
  return { file: OUT, agents: g.agents.length, skills: g.skills.length, keys: g.keys.length }
}

module.exports = { build, write, OUT }
