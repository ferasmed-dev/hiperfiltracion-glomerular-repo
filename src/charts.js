// charts.js — tiny dependency-free SVG line charts with a synced crosshair.
// Each chart: one y-axis, one measure; optional background bands (KDIGO
// stages/categories), reference lines, per-point colouring and a dashed
// comparison series.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export class LineChart {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   *  title, unit, yMin, yMax (number | (maxData)=>number), log (bool),
   *  bands: [{from,to,label,cls}], refs: [{y,label,cls}],
   *  fmt: (v)=>string, onHover: (t|null)=>void
   */
  constructor(host, o) {
    this.o = { yMin: 0, fmt: (v) => v.toFixed(0), labels: () => ({ years: 'años', year: 'año', noTx: 'sin tto' }), fmtYear: (t) => t.toFixed(1), ...o };
    this.W = 360; this.H = 200;
    this.m = { l: 44, r: 40, t: 22, b: 26 };
    host.classList.add('chart');
    const head = document.createElement('div');
    head.className = 'chart-head';
    head.innerHTML = `<span class="chart-title"></span><span class="chart-value" aria-live="off"></span>`;
    host.appendChild(head);
    this.titleEl = head.querySelector('.chart-title');
    this.valueEl = head.querySelector('.chart-value');
    this.svg = el('svg', { viewBox: `0 0 ${this.W} ${this.H}`, role: 'img' }, host);
    this.setTitle(o.title);
    this.gBands = el('g', {}, this.svg);
    this.gGrid = el('g', { class: 'grid' }, this.svg);
    this.gData = el('g', {}, this.svg);
    this.gHover = el('g', { class: 'hover', visibility: 'hidden' }, this.svg);
    this.hLine = el('line', { class: 'crosshair' }, this.gHover);
    this.hDot = el('circle', { r: 4.5, class: 'hover-dot' }, this.gHover);
    this.hDotCf = el('circle', { r: 3.5, class: 'hover-dot cf' }, this.gHover);
    this.hLabel = el('text', { class: 'hover-label' }, this.gHover);
    const hit = el('rect', {
      x: this.m.l, y: this.m.t, width: this.W - this.m.l - this.m.r,
      height: this.H - this.m.t - this.m.b, fill: 'transparent',
    }, this.svg);
    const toT = (ev) => {
      const r = this.svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * this.W;
      return Math.max(0, Math.min(this.xMax, this.xInv(x)));
    };
    hit.addEventListener('pointermove', (ev) => o.onHover?.(toT(ev)));
    hit.addEventListener('pointerleave', () => o.onHover?.(null));
    this.series = []; this.xMax = 30; this.hoverT = null;
  }

  x(t) { return this.m.l + (t / this.xMax) * (this.W - this.m.l - this.m.r); }
  xInv(px) { return ((px - this.m.l) / (this.W - this.m.l - this.m.r)) * this.xMax; }
  y(v) {
    const { log } = this.o;
    const lo = log ? Math.log10(this.yMin) : this.yMin;
    const hi = log ? Math.log10(this.yMax) : this.yMax;
    const vv = log ? Math.log10(Math.max(v, this.yMin)) : v;
    const f = (Math.min(hi, Math.max(lo, vv)) - lo) / (hi - lo);
    return this.H - this.m.b - f * (this.H - this.m.t - this.m.b);
  }

  /** series: [{ pts: [[t, v, colorClass?]], cls, dashed, name }] */
  update(series, xMax) {
    this.series = series; this.xMax = xMax;
    const all = series.flatMap((s) => s.pts.map((p) => p[1]));
    const dataMax = all.length ? Math.max(...all) : 1;
    this.yMin = this.o.yMin;
    this.yMax = typeof this.o.yMax === 'function' ? this.o.yMax(dataMax) : this.o.yMax;
    this.drawFrame();
    this.drawData();
    this.drawHover();
  }

  drawFrame() {
    const { m, W, H } = this;
    this.gBands.replaceChildren();
    this.gGrid.replaceChildren();
    for (const b of this.o.bands || []) {
      const y1 = this.y(Math.min(b.to, this.yMax)), y0 = this.y(Math.max(b.from, this.yMin));
      if (y0 - y1 < 1) continue;
      el('rect', { x: m.l, y: y1, width: W - m.l - m.r, height: y0 - y1, class: `band ${b.cls}` }, this.gBands);
      if (y0 - y1 >= 10) {
        const t = el('text', { x: W - m.r + 4, y: (y0 + y1) / 2 + 3.5, class: 'band-label' }, this.gBands);
        t.textContent = b.label;
      }
    }
    // y ticks
    const ticks = this.o.log
      ? [10, 30, 100, 300, 1000].filter((v) => v >= this.yMin && v <= this.yMax)
      : niceTicks(this.yMin, this.yMax, 4);
    for (const v of ticks) {
      const yy = this.y(v);
      el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }, this.gGrid);
      const t = el('text', { x: m.l - 6, y: yy + 3.5, 'text-anchor': 'end', class: 'tick' }, this.gGrid);
      t.textContent = this.o.tickFmt ? this.o.tickFmt(v) : String(v);
    }
    // x ticks (years)
    const step = this.xMax > 40 ? 10 : 5;
    for (let t = 0; t <= this.xMax + 1e-9; t += step) {
      const xx = this.x(t);
      const tx = el('text', { x: xx, y: H - m.b + 15, 'text-anchor': 'middle', class: 'tick' }, this.gGrid);
      tx.textContent = t;
    }
    const ax = el('text', { x: W - m.r, y: H - 2, 'text-anchor': 'end', class: 'tick axis-name' }, this.gGrid);
    ax.textContent = this.o.labels().years;
    const un = el('text', { x: m.l - 6, y: 11, 'text-anchor': 'end', class: 'tick axis-name' }, this.gGrid);
    un.textContent = typeof this.o.unit === 'function' ? this.o.unit() : this.o.unit;
    el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'baseline' }, this.gGrid);
    for (const r of this.o.refs || []) {
      const v = typeof r.y === 'function' ? r.y() : r.y;
      if (v < this.yMin || v > this.yMax) continue;
      const yy = this.y(v);
      el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: `ref ${r.cls || ''}` }, this.gGrid);
      const t = el('text', { x: m.l + 4, y: yy - 4, class: `ref-label ${r.cls || ''}` }, this.gGrid);
      t.textContent = typeof r.label === 'function' ? r.label() : r.label;
    }
  }

  drawData() {
    this.gData.replaceChildren();
    for (const s of this.series) {
      if (!s.pts.length) continue;
      // split into runs of equal colour class (KDIGO colouring)
      let run = [], cls = s.pts[0][2] || s.cls;
      const flush = () => {
        if (run.length < 1) return;
        const d = run.map((p, i) => `${i ? 'L' : 'M'}${this.x(p[0]).toFixed(1)},${this.y(p[1]).toFixed(1)}`).join('');
        el('path', { d, class: `line ${cls} ${s.dashed ? 'dashed' : ''}` }, this.gData);
      };
      for (const p of s.pts) {
        const c = p[2] || s.cls;
        if (c !== cls) { run.push(p); flush(); run = [p]; cls = c; } else run.push(p);
      }
      flush();
      if (!s.dashed) {
        const last = s.pts[s.pts.length - 1];
        el('circle', { cx: this.x(last[0]), cy: this.y(last[1]), r: 4, class: `end-dot ${last[2] || s.cls}` }, this.gData);
        this.valueEl.textContent = this.o.fmt(last[1]);
      }
    }
  }

  setTitle(html) {
    this.titleEl.innerHTML = html;
    this.svg.setAttribute('aria-label', this.titleEl.textContent);
  }

  setHover(t) { this.hoverT = t; this.drawHover(); }

  drawHover() {
    const t = this.hoverT;
    const main = this.series.find((s) => !s.dashed);
    if (t == null || !main || !main.pts.length) { this.gHover.setAttribute('visibility', 'hidden'); return; }
    const p = nearest(main.pts, t);
    if (!p) { this.gHover.setAttribute('visibility', 'hidden'); return; }
    this.gHover.setAttribute('visibility', 'visible');
    const xx = this.x(p[0]);
    Object.entries({ x1: xx, x2: xx, y1: this.m.t, y2: this.H - this.m.b }).forEach(([k, v]) => this.hLine.setAttribute(k, v));
    this.hDot.setAttribute('cx', xx); this.hDot.setAttribute('cy', this.y(p[1]));
    this.hDot.setAttribute('class', `hover-dot ${p[2] || main.cls}`);
    const cf = this.series.find((s) => s.dashed);
    const L = this.o.labels();
    let label = `${L.year} ${this.o.fmtYear(p[0])} · ${this.o.fmt(p[1])}`;
    const q = cf && nearest(cf.pts, t);
    if (q) {
      this.hDotCf.setAttribute('visibility', 'visible');
      this.hDotCf.setAttribute('cx', this.x(q[0])); this.hDotCf.setAttribute('cy', this.y(q[1]));
      label += ` (${L.noTx}: ${this.o.fmt(q[1])})`;
    } else this.hDotCf.setAttribute('visibility', 'hidden');
    this.hLabel.textContent = label;
    const right = xx > this.W / 2;
    this.hLabel.setAttribute('x', right ? xx - 6 : xx + 6);
    this.hLabel.setAttribute('text-anchor', right ? 'end' : 'start');
    this.hLabel.setAttribute('y', 12);
  }
}

function nearest(pts, t) {
  if (!pts.length || t > pts[pts.length - 1][0] + 0.06) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid; else hi = mid; }
  return Math.abs(pts[lo][0] - t) < Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
}

function niceTicks(lo, hi, n) {
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n + 0.5);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** KDIGO 2012 G×A prognosis heat grid (green → red = increasing risk). */
export const KDIGO_RISK = {
  G1: ['low', 'mod', 'high'], G2: ['low', 'mod', 'high'],
  G3a: ['mod', 'high', 'vhigh'], G3b: ['high', 'vhigh', 'vhigh'],
  G4: ['vhigh', 'vhigh', 'vhigh'], G5: ['vhigh', 'vhigh', 'vhigh'],
};

export function renderKdigoGrid(host, G_STAGES, A_CATS, txt) {
  host.replaceChildren();
  const t = document.createElement('table');
  t.className = 'kdigo';
  const range = (lbl, id) => lbl.slice(id.length + 1).replace(/[()]/g, '');
  t.innerHTML = `<caption class="sr-only">${txt.caption}</caption>
    <thead><tr><th scope="col"></th>${A_CATS.map((a) => `<th scope="col" title="${txt.A[a.id]}">${a.id}<small>${range(a.label, a.id)}</small><small class="nm">${txt.A[a.id]}</small></th>`).join('')}</tr></thead>
    <tbody>${G_STAGES.map((g) => `<tr><th scope="row" title="${txt.G[g.id]}">${g.id} <small>${range(g.label, g.id)}</small><small class="nm">${txt.G[g.id]}</small></th>${A_CATS.map((a, j) =>
      `<td class="risk-${KDIGO_RISK[g.id][j]}" data-cell="${g.id}${a.id}" title="${g.id} ${txt.G[g.id]} · ${a.id} ${txt.A[a.id]}"></td>`).join('')}</tr>`).join('')}</tbody>`;
  host.appendChild(t);
  return (g, a) => {
    t.querySelectorAll('td.current').forEach((c) => { c.classList.remove('current'); c.textContent = ''; c.removeAttribute('aria-label'); });
    const c = t.querySelector(`[data-cell="${g}${a}"]`);
    if (c) { c.classList.add('current'); c.textContent = '●'; c.setAttribute('aria-label', `${txt.current}: ${g} ${a}`); }
  };
}
