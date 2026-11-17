// ui.js — DOM, animation loop, explanations and language switch.
// All physiology lives in model.js; all text lives in i18n.js.
import * as M from './model.js';
import { LineChart, renderKdigoGrid } from './charts.js';
import { DICT, LANGS } from './i18n.js';

const DT = 0.05; // years per Euler step (~18 days)
const $ = (id) => document.getElementById(id);
const HEALTHY_SNGFR = (M.DEFAULTS.GFR_HEALTHY * 1e6) / M.DEFAULTS.N0; // 62.5 nL/min
const RE0 = M.healthyRe(M.DEFAULTS);

// ---------------------------------------------------------------- language
let lang = pickLang();
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && DICT[q]) return q;
  try { const s = localStorage.getItem('hf-lang'); if (s && DICT[s]) return s; } catch { /* storage unavailable */ }
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
}
const T = (key, args) => { const v = DICT[lang][key] ?? DICT.es[key] ?? key; return typeof v === 'function' ? v(args || {}) : v; };
const nf = (v, d = 0) => v.toLocaleString(LANGS[lang], { minimumFractionDigits: d, maximumFractionDigits: d });
const signedPct = (frac) => `${frac >= 0 ? '+' : '−'}${nf(Math.abs(frac) * 100)} %`;

function setLang(l) {
  lang = l;
  try { localStorage.setItem('hf-lang', l); } catch { /* ignore */ }
  const url = new URL(location.href); url.searchParams.set('lang', l); history.replaceState(null, '', url);
  applyStaticText();
  setupCharts();
  syncControls();
  renderLog();
  setPlaying(playing);
  $('cycle').replaceChildren();
  render(true);
}

function applyStaticText() {
  document.documentElement.lang = l10nTag();
  document.title = T('doc.title');
  document.querySelector('meta[name="description"]').setAttribute('content', T('doc.desc'));
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = T(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', T(el.dataset.i18nAria)));
  $('normals-list').innerHTML = T('normals.list').map((li) => `<li>${li}</li>`).join('');
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  document.querySelectorAll('.btn.preset').forEach((b) => { b.textContent = T(`p.${b.dataset.key}`); });
  if (G.svg) {
    G.svg.setAttribute('aria-label', T('g.aria'));
    G.static.forEach(([el, key]) => { el.textContent = T(key); });
  }
}
const l10nTag = () => (lang === 'es' ? 'es' : 'en');

// ---------------------------------------------------------------- state
const ui = { speed: 2, horizon: 30, showCf: true };
let params = { ...M.DEFAULTS };
let state, cfState, hist, cfHist, playing = false, treatedEver = false;
let activePreset = null, pendingEvents = [], prev = null, logEntries = [];

const cfParams = () => ({ ...params, ieca: false, isglt2: false });

// ---------------------------------------------------------------- controls
const SLIDERS = [
  { id: 's-loss', key: 'initialLossPct', out: 'o-loss', label: 's.loss', fmt: (v) => `${nf(v)} %`, resets: true },
  { id: 's-map', key: 'MAP', out: 'o-map', label: 's.map', fmt: (v) => `${nf(v)} mmHg` },
  { id: 's-ratio', key: 'reRaRatio', out: 'o-ratio', label: 's.ratio', fmt: (v) => `${nf(v, 1)} : 1` },
  { id: 's-thr', key: 'damageThreshold', out: 'o-thr', label: 's.thr', fmt: (v) => `${nf(v, 1)} mmHg` },
  { id: 'a-autoreg', key: 'autoreg', out: 'o-autoreg', label: 'a.autoreg', fmt: (v) => `${nf(v * 100)} %` },
  { id: 'a-block', key: 'rasBlock', out: 'o-block', label: 'a.block', fmt: (v) => `${nf(v * 100)} %` },
  { id: 'a-sglt', key: 'sglt2Afferent', out: 'o-sglt', label: 'a.sglt', fmt: (v) => `+${nf(v * 100)} %` },
  { id: 'a-kdmg', key: 'kDamage', out: 'o-kdmg', label: 'a.kdmg', fmt: (v) => `${nf(v * 100, 1)} ${T('unit.perYmm')}` },
  { id: 'a-kprot', key: 'kProt', out: 'o-kprot', label: 'a.kprot', fmt: (v) => `${nf(v * 100, 1)} ${T('unit.perYe')}` },
  { id: 'a-kage', key: 'kAge', out: 'o-kage', label: 'a.kage', fmt: (v) => `${nf(v * 100, 1)} ${T('unit.peryear')}` },
  { id: 'a-gain', key: 'angGain', out: 'o-gain', label: 'a.gain', fmt: (v) => nf(v, 1) },
];
const UI_SLIDERS = [
  { id: 's-speed', key: 'speed', out: 'o-speed', fmt: (v) => `${nf(v, 2)} ${T('unit.yps')}` },
  { id: 'a-horizon', key: 'horizon', out: 'o-horizon', fmt: (v) => `${nf(v)} ${T('unit.years')}` },
];

function syncControls() {
  for (const s of SLIDERS) { $(s.id).value = params[s.key]; $(s.out).textContent = s.fmt(params[s.key]); }
  for (const s of UI_SLIDERS) { $(s.id).value = ui[s.key]; $(s.out).textContent = s.fmt(ui[s.key]); }
  $('t-ieca').checked = params.ieca;
  $('t-sglt2').checked = params.isglt2;
  $('t-cf').checked = ui.showCf;
  document.querySelectorAll('.btn.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === activePreset)));
  $('preset-expect').innerHTML = activePreset ? `${T('expected')} ${T(`pe.${activePreset}`)}` : '';
}

function setupControls() {
  for (const s of SLIDERS) {
    $(s.id).addEventListener('input', (e) => {
      params = { ...params, [s.key]: +e.target.value };
      $(s.out).textContent = s.fmt(params[s.key]);
      clearPreset();
      if (s.resets) reset();
      else { const v = params[s.key]; paramsChanged(() => `${T(s.label).replace(/<[^>]+>/g, '')} → ${s.fmt(v)}`); }
    });
  }
  for (const s of UI_SLIDERS) {
    $(s.id).addEventListener('input', (e) => {
      ui[s.key] = +e.target.value;
      $(s.out).textContent = s.fmt(ui[s.key]);
      if (s.key === 'horizon') { setPlaying(playing); render(true); }
    });
  }
  $('t-ieca').addEventListener('change', (e) => { pendingEvents = []; setTreatment('ieca', e.target.checked); });
  $('t-sglt2').addEventListener('change', (e) => { pendingEvents = []; setTreatment('isglt2', e.target.checked); });
  $('t-cf').addEventListener('change', (e) => { ui.showCf = e.target.checked; render(true); });
  $('btn-play').addEventListener('click', () => setPlaying(!playing));
  $('btn-reset').addEventListener('click', () => { reset(); });
  $('btn-defaults').addEventListener('click', () => {
    params = { ...M.DEFAULTS, initialLossPct: params.initialLossPct, MAP: params.MAP, ieca: params.ieca, isglt2: params.isglt2 };
    ui.horizon = 30; syncControls(); paramsChanged(() => T('log.defaults'));
  });
  const row = $('presets');
  for (const key of Object.keys(M.PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn preset'; b.dataset.key = key;
    b.addEventListener('click', () => loadPreset(key));
    row.appendChild(b);
  }
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, button, summary')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  });
}

function clearPreset() { activePreset = null; syncControls(); }

function loadPreset(key) {
  const pr = M.PRESETS[key];
  params = { ...M.DEFAULTS, ...pr.params };
  activePreset = key;
  syncControls();
  reset();
  pendingEvents = (pr.events || []).map((e) => ({ ...e }));
  for (const ev of pendingEvents) {
    addLog(0, () => T('log.scheduled', {
      what: Object.entries(ev.set).map(([k, v]) => `${T(`name.${k}`)} ${T(v ? 'on' : 'off')}`).join(', '),
      t: nf(ev.t, 1),
    }));
  }
  setPlaying(true);
}

function setPlaying(on) {
  const done = state.t >= ui.horizon - 1e-9;
  playing = on && !done;
  const b = $('btn-play');
  b.textContent = playing ? T('pause') : (done ? T('end') : T('play'));
  b.setAttribute('aria-pressed', String(playing));
}

// ---------------------------------------------------------------- simulation
function reset() {
  state = M.initialState(params);
  cfState = M.initialState(cfParams());
  hist = [state]; cfHist = [cfState];
  treatedEver = params.ieca || params.isglt2;
  pendingEvents = [];
  prev = { g: state.g, a: state.a, hf: state.hyperfiltering, milestone: milestoneOf(state.N), sentinel: false };
  logEntries = [];
  const s0 = state, lost = params.initialLossPct;
  addLog(0, lost > 0
    ? () => T('log.injury', { pct: nf(lost), n: nf(s0.N / 1e6, 2), gfr: nf(s0.gfr), ga: s0.g + s0.a })
    : () => T('log.healthy', { n: nf(s0.N / 1e6, 1), gfr: nf(s0.gfr), l: nf(s0.gfr * 1.44) }));
  if (s0.a !== 'A1' && (s0.g === 'G1' || s0.g === 'G2')) { prev.sentinel = true; addLog(0, () => T('log.sentinel')); }
  if (s0.hyperfiltering) { const thr = params.damageThreshold; addLog(0, () => T('log.hfStart0', { p: nf(s0.P_GC, 1), thr: nf(thr, 1) }), 'warn'); }
  setPlaying(false);
  render(true);
}

/** Live parameter change: vessels respond immediately (same N, same t). */
function paramsChanged(what) {
  const before = state;
  state = M.observe(state.N, state.t, params);
  cfState = M.observe(cfState.N, cfState.t, cfParams());
  hist.push(state); cfHist.push(cfState);
  const after = state;
  if (what) addLog(after.t, () => T('log.param', { what: what(), p0: nf(before.P_GC, 1), p1: nf(after.P_GC, 1), g0: nf(before.gfr), g1: nf(after.gfr) }));
  checkTransitions();
  render(true);
}

function setTreatment(key, on, fromEvent = false) {
  const before = state;
  params = { ...params, [key]: on };
  if (on) treatedEver = true;
  if (!fromEvent) clearPreset(); else syncControls();
  state = M.observe(state.N, state.t, params);
  hist.push(state); cfHist.push(cfState);
  const after = state;
  if (on) {
    const dip = after.gfr / before.gfr - 1;
    addLog(after.t, () => T('log.txOn', { name: T(`name.${key}`), mech: T(key === 'ieca' ? 'mech.ieca' : 'mech.sglt2'),
      p0: nf(before.P_GC, 1), p1: nf(after.P_GC, 1), g0: nf(before.gfr), g1: nf(after.gfr), d: signedPct(dip) }), 'tx');
  } else {
    addLog(after.t, () => T('log.txOff', { name: T(`name.${key}`), p0: nf(before.P_GC, 1), p1: nf(after.P_GC, 1) }));
  }
  checkTransitions();
  render(true);
}

function stepOnce() {
  for (const ev of pendingEvents) {
    if (!ev.done && state.t >= ev.t - 1e-9) {
      ev.done = true;
      for (const [k, v] of Object.entries(ev.set)) {
        if (k === 'ieca' || k === 'isglt2') setTreatment(k, v, true);
        else { params = { ...params, [k]: v }; syncControls(); paramsChanged(() => `${k} → ${v}`); }
      }
    }
  }
  state = M.step(state, params, DT);
  cfState = M.step(cfState, cfParams(), DT);
  hist.push(state); cfHist.push(cfState);
  checkTransitions();
}

function milestoneOf(N) {
  const f = N / M.DEFAULTS.N0;
  return f <= 0.1 ? 3 : f <= 0.25 ? 2 : f <= 0.5 ? 1 : 0;
}
const G_ORDER = M.G_STAGES.map((g) => g.id);
const worse = (a, b) => G_ORDER.indexOf(b) > G_ORDER.indexOf(a);

function checkTransitions() {
  const s = state, thr = params.damageThreshold;
  if (s.g !== prev.g) { const a = prev.g; addLog(s.t, () => T('log.g', { gfr: nf(s.gfr), a, b: s.g }), worse(a, s.g) ? 'warn' : ''); }
  if (s.a !== prev.a) {
    const a = prev.a;
    addLog(s.t, () => T('log.a', { acr: nf(s.acr), a, b: s.a }), s.a > a ? 'warn' : '');
    if (s.a > a && (s.g === 'G1' || s.g === 'G2') && !prev.sentinel) { prev.sentinel = true; addLog(s.t, () => T('log.sentinel')); }
  }
  if (s.hyperfiltering !== prev.hf) {
    addLog(s.t, s.hyperfiltering ? () => T('log.hfOn', { p: nf(s.P_GC, 1), thr: nf(thr, 1) }) : () => T('log.hfOff', { p: nf(s.P_GC, 1) }), s.hyperfiltering ? 'warn' : 'tx');
  }
  const m = milestoneOf(s.N);
  if (m > prev.milestone) addLog(s.t, () => T('log.milestone', { pct: ['', '50', '25', '10'][m], n: nf(s.N / 1e6, 2) }), 'warn');
  prev = { ...prev, g: s.g, a: s.a, hf: s.hyperfiltering, milestone: Math.max(prev.milestone, m) };
}

/** Log entries keep a text factory so they can be re-rendered in another language. */
function addLog(t, make, cls = '') {
  logEntries.push({ t, make, cls });
  $('log').prepend(logItem(logEntries[logEntries.length - 1]));
}
function logItem(e) {
  const li = document.createElement('li');
  if (e.cls) li.className = e.cls;
  li.innerHTML = `<b>${T('log.year', { t: nf(e.t, 1) })}</b> · ${e.make()}`;
  return li;
}
function renderLog() { $('log').replaceChildren(...logEntries.slice().reverse().map(logItem)); }

// ---------------------------------------------------------------- glomerulus SVG
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const SUB = (base, sub) => `${base}<tspan baseline-shift="sub" font-size="72%">${sub}</tspan>`;

const AFF = 'M10,150 L212,150';
const TUFT = 'M212,150 C250,150 242,92 282,88 C322,84 300,140 322,128 C344,116 330,74 362,84 C398,96 362,150 392,168 C418,184 398,240 360,236 C324,232 348,196 314,206 C282,216 300,252 264,236 C232,222 246,184 276,180 C304,176 300,160 330,156 C368,151 398,150 428,150';
const EFF = 'M428,150 L630,150';
const TUBULE = 'M372,268 C392,300 420,312 470,322 C520,332 560,326 630,334';

const G = {};
function buildGlomerulus() {
  const svg = svgEl('svg', { viewBox: '0 -34 640 400', role: 'img' });
  G.svg = svg;
  $('glomerulus').appendChild(svg);
  svgEl('circle', { cx: 320, cy: 165, r: 118, fill: 'var(--surface-2)', stroke: 'var(--capsule)', 'stroke-width': 3 }, svg);
  svgEl('path', { d: TUBULE, fill: 'none', stroke: 'var(--capsule)', 'stroke-width': 30, 'stroke-linecap': 'butt' }, svg);
  svgEl('path', { d: 'M350,240 ' + TUBULE.replace('M372,268', 'L372,268'), fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 24 }, svg);
  G.glow = svgEl('path', { d: TUFT, fill: 'none', stroke: 'var(--g4)', 'stroke-width': 26, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, svg);
  G.affWall = svgEl('path', { d: AFF, fill: 'none', stroke: 'var(--wall)', 'stroke-linecap': 'butt' }, svg);
  G.effWall = svgEl('path', { d: EFF, fill: 'none', stroke: 'var(--wall)', 'stroke-linecap': 'butt' }, svg);
  svgEl('path', { d: TUFT, fill: 'none', stroke: 'var(--wall)', 'stroke-width': 13, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  G.affLumen = svgEl('path', { d: AFF, fill: 'none', stroke: 'var(--blood-2)', 'stroke-linecap': 'butt' }, svg);
  G.effLumen = svgEl('path', { d: EFF, fill: 'none', stroke: 'var(--blood-2)', 'stroke-linecap': 'butt' }, svg);
  G.tuftLumen = svgEl('path', { d: TUFT, fill: 'none', stroke: 'var(--blood-2)', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  G.recAff = svgEl('g', {}, svg);
  G.recEff = svgEl('g', {}, svg);
  G.blood = svgEl('g', {}, svg);
  G.filt = svgEl('g', {}, svg);
  G.route = svgEl('path', { d: AFF + ' ' + TUFT.replace('M212,150', 'L212,150') + ' ' + EFF.replace('M428,150', 'L428,150'), fill: 'none', stroke: 'none' }, svg);
  G.tuftPath = svgEl('path', { d: TUFT, fill: 'none', stroke: 'none' }, svg);
  G.tubPath = svgEl('path', { d: TUBULE, fill: 'none', stroke: 'none' }, svg);
  const text = (x, y, cls = '', anchor = 'start') => svgEl('text', { x, y, class: cls, 'text-anchor': anchor }, svg);
  G.static = [
    [text(16, 112), 'g.aff'], [text(624, 112, '', 'end'), 'g.eff'], [text(320, -16, 'lbl-2', 'middle'), 'g.cap'],
    [text(16, 300), 'g.bowman'], [text(630, 356, 'lbl-2', 'end'), 'g.tubule'],
  ];
  G.mapTxt = text(16, 94, 'lbl-2');
  G.raTxt = text(16, 192, 'lbl-2');
  G.raSub = text(16, 207, 'lbl-2');
  G.reTxt = text(624, 192, 'lbl-2', 'end');
  G.pgcTxt = text(320, 4, 'lbl-big', 'middle');
  G.hfTxt = text(320, 24, 'lbl-2', 'middle');
  G.bsTxt = text(16, 317, 'lbl-2');
  G.snTxt = text(630, 306, '', 'end');
  G.angTxt = text(16, 232, 'lbl-2');
  G.rbfTxt = text(16, 250, 'lbl-2');
  const lg = svgEl('g', { transform: 'translate(16,334)' }, svg);
  svgEl('path', { d: 'M0,8 L5,0 L10,8 Z', fill: '#7b5cd6' }, lg);
  G.static.push([svgEl('text', { x: 16, y: 9, class: 'lbl-2' }, lg), 'g.receptor']);
  G.len = G.route.getTotalLength();
  G.tuftLen = G.tuftPath.getTotalLength();
  G.tubLen = G.tubPath.getTotalLength();
  G.tubStart = G.tubPath.getPointAtLength(0);
  G.bloodDots = [];
  for (let i = 0; i < 34; i++) G.bloodDots.push({ el: svgEl('circle', { r: 3.4, fill: 'var(--blood)' }, G.blood), s: (i / 34) * G.len });
  G.filtDots = [];
  G.emitAcc = 0;
}

function receptors(group, x0, x1, n, wallHalf, intensity) {
  group.replaceChildren();
  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0);
    const y = 150 - wallHalf - 1;
    svgEl('path', { d: `M${x - 5},${y} L${x},${y - 9} L${x + 5},${y} Z`, fill: '#7b5cd6', opacity: (0.35 + 0.65 * intensity).toFixed(2) }, group);
  }
}

function vesselDims(Rrel) {
  // exaggerated geometry: narrower lumen and thicker wall when constricted
  const lumen = Math.max(4, Math.min(24, 13 * Math.pow(Rrel, -1.1)));
  const wall = Math.max(3, Math.min(14, 5 * Math.pow(Rrel, 0.9)));
  return { lumen, outer: lumen + 2 * wall };
}

function drawGlomerulus(s) {
  const a = vesselDims(s.Ra);
  const e = vesselDims(s.Re / RE0);
  G.affLumen.setAttribute('stroke-width', a.lumen); G.affWall.setAttribute('stroke-width', a.outer);
  G.effLumen.setAttribute('stroke-width', e.lumen); G.effWall.setAttribute('stroke-width', e.outer);
  const press = Math.max(0, Math.min(1, (s.P_GC - 50) / 22));
  G.tuftLumen.setAttribute('stroke-width', (7 + 3 * press).toFixed(1));
  const thr = params.damageThreshold;
  const hf = s.P_GC > thr;
  G.glow.setAttribute('opacity', hf ? (0.18 + 0.35 * Math.min(1, (s.P_GC - thr) / 8)).toFixed(2) : (0.08 * press).toFixed(2));
  const angI = Math.min(1, (s.angII - 1) / 4);
  receptors(G.recAff, 30, 200, 3, a.outer / 2, angI);
  receptors(G.recEff, 440, 610, Math.min(16, Math.round(3 * params.reRaRatio)), e.outer / 2, angI);
  G.mapTxt.textContent = T('g.map', { v: nf(params.MAP) });
  G.raTxt.textContent = `Ra ×${nf(s.Ra, 2)}`;
  G.raSub.textContent = Math.abs(s.Ra - s.RaAng) > 0.03 ? T('g.raSub', { who: params.isglt2 ? `Ang II+${T('name.isglt2')}` : 'Ang II', v: nf(s.RaAng, 2) }) : '';
  G.reTxt.textContent = `Re ×${nf(s.Re / RE0, 2)}`;
  G.pgcTxt.innerHTML = `${SUB('P', 'GC')} = ${nf(s.P_GC, 1)} mmHg`;
  G.hfTxt.textContent = hf ? T('g.hf', { thr: nf(thr, 1) }) : T('g.ok', { thr: nf(thr, 1) });
  G.hfTxt.setAttribute('style', hf ? 'fill: var(--g4); font-weight: 600' : '');
  G.bsTxt.innerHTML = `${SUB('P', 'BS')} ${nf(params.P_BS)} mmHg · ${SUB('π', 'GC')} ${nf(params.PI_GC)} mmHg`;
  G.snTxt.textContent = T('g.sn', { v: nf(s.sngfr) });
  G.angTxt.textContent = T('g.ang', { v: nf(s.angII, 1), b: params.ieca ? nf(params.rasBlock * 100) : '' });
  G.rbfTxt.textContent = T('g.rbf', { v: nf(s.rbf, 2) });
}

function animateParticles(dtSec) {
  const s = state;
  const speed = 140 * Math.max(0.15, s.rbf);
  for (const d of G.bloodDots) {
    d.s = (d.s + speed * dtSec) % G.len;
    const p = G.route.getPointAtLength(d.s);
    d.el.setAttribute('cx', p.x.toFixed(1)); d.el.setAttribute('cy', p.y.toFixed(1));
  }
  G.emitAcc += dtSec * 7 * (s.sngfr / HEALTHY_SNGFR);
  while (G.emitAcc >= 1 && G.filtDots.length < 120) {
    G.emitAcc -= 1;
    const p0 = G.tuftPath.getPointAtLength((0.12 + 0.76 * Math.random()) * G.tuftLen);
    G.filtDots.push({ el: svgEl('circle', { r: 2.6, fill: 'var(--filtrate)' }, G.filt), x0: p0.x, y0: p0.y, ph: 0, tl: 0 });
  }
  G.emitAcc = Math.min(G.emitAcc, 2);
  for (const f of G.filtDots) {
    if (f.ph < 1) {
      f.ph += dtSec / 1.6;
      const k = Math.min(1, f.ph), ease = k * k * (3 - 2 * k);
      const x = f.x0 + (G.tubStart.x - f.x0) * ease, y = f.y0 + (G.tubStart.y - f.y0) * ease + Math.sin(k * Math.PI) * 10;
      f.el.setAttribute('cx', x.toFixed(1)); f.el.setAttribute('cy', y.toFixed(1));
    } else {
      f.tl += dtSec * 120;
      const p = G.tubPath.getPointAtLength(Math.min(f.tl, G.tubLen));
      f.el.setAttribute('cx', p.x.toFixed(1)); f.el.setAttribute('cy', p.y.toFixed(1));
    }
  }
  G.filtDots = G.filtDots.filter((f) => { if (f.tl >= G.tubLen) { f.el.remove(); return false; } return true; });
}

// ---------------------------------------------------------------- explanations
function renderCycle(s) {
  const d = M.nephronDeficit(s.N, params);
  const reRel = s.Re / RE0, raRel = s.RaAng;
  const thr = params.damageThreshold;
  const rates = M.damageRates(s.P_GC, params);
  const injury = rates.hemo + rates.prot;
  const items = [
    [d > 0.02, T('cy.1', { n: nf(s.N / 1e6, 2), pct: nf((1 - d) * 100) })],
    [s.angII > 1.05, T('cy.2', { a: nf(s.angII, 1), b: params.ieca ? nf(params.rasBlock * 100) : '' })],
    [reRel - 1 > (raRel - 1) + 0.02, T('cy.3', { r: nf(params.reRaRatio, 1), re: nf(reRel, 2), ra: nf(raRel, 2) })],
    [s.sngfr > HEALTHY_SNGFR * 1.05, T('cy.4', { p: nf(s.P_GC, 1), sn: nf(s.sngfr), d: signedPct(s.sngfr / HEALTHY_SNGFR - 1), gfr: nf(s.gfr) })],
    [injury > 0, injury > 0
      ? T('cy.5on', { thr: nf(thr, 1), loss: nf(Math.round((s.N * injury) / 1000) * 1000), hemo: nf((rates.hemo / injury) * 100), prot: nf((rates.prot / injury) * 100) })
      : T('cy.5off', { thr: nf(thr, 1) })],
  ];
  const ol = $('cycle');
  if (!ol.children.length) items.forEach((_, i) => { const li = document.createElement('li'); if (i === 4) li.classList.add('loop'); ol.appendChild(li); });
  items.forEach(([on, html], i) => {
    const li = ol.children[i];
    li.classList.toggle('on', on);
    if (li.innerHTML !== html) li.innerHTML = html;
  });
  const parts = [];
  if (params.ieca) parts.push(T('tn.ieca'));
  if (params.isglt2) parts.push(T('tn.sglt2'));
  if (params.MAP > 100) parts.push(T('tn.hta', { map: nf(params.MAP), a: nf(params.autoreg * 100) }));
  if (injury > 0 || params.ieca || params.isglt2) parts.push(T('tn.priority'));
  const tn = $('treat-note');
  tn.hidden = !parts.length;
  const html = parts.map((p) => `<p>${p}</p>`).join('');
  if (tn.innerHTML !== html) tn.innerHTML = html;
}

function renderTiles(s) {
  const thr = params.damageThreshold;
  const tiles = [
    [T('tile.gfr'), `${nf(s.gfr)}<small>mL/min</small>`, `${T('tile.lday', { v: nf(s.gfr * 1.44) })} · <span class="stage-chip" style="background:var(--${s.g.toLowerCase()})">${s.g}</span>`],
    [T('tile.sn'), `${nf(s.sngfr)}<small>nL/min</small>`, T('tile.vsHealthy', { v: signedPct(s.sngfr / HEALTHY_SNGFR - 1) })],
    [T('tile.n'), `${nf(s.N / 1e6, 2)}<small>M</small>`, T('tile.ofTotal', { v: nf((s.N / M.DEFAULTS.N0) * 100) })],
    [T('tile.pgc'), `${nf(s.P_GC, 1)}<small>mmHg</small>`, s.P_GC > thr ? T('tile.over', { v: nf(s.P_GC - thr, 1) }) : T('tile.thr', { v: nf(thr, 1) })],
    [T('tile.acr'), `${nf(s.acr)}<small>mg/g</small>`, T('tile.cat', { v: s.a })],
  ];
  $('tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
}

function renderStarling(s) {
  const scale = (v) => `${Math.max(0, Math.min(100, (v / 80) * 100))}%`;
  $('sb-pgc').style.width = scale(s.P_GC);
  $('sb-pbs').style.width = scale(params.P_BS);
  $('sb-pi').style.width = scale(params.PI_GC);
  const net = Math.max(0, s.P_GC - params.P_BS - params.PI_GC);
  $('sb-net').style.width = scale(net);
  $('sb-pgc-v').textContent = `${nf(s.P_GC, 1)} mmHg`;
  $('sb-against-v').textContent = `${nf(params.P_BS + params.PI_GC)} mmHg`;
  $('sb-net-v').textContent = `${nf(net, 1)} mmHg`;
}

// ---------------------------------------------------------------- charts
let charts = null, setKdigo;
const hoverAll = (t) => Object.values(charts).forEach((c) => c.setHover(t));
function setupCharts() {
  const common = {
    onHover: hoverAll,
    labels: () => ({ years: T('unit.years'), year: T('unit.year'), noTx: T('hover.noTx') }),
    fmtYear: (t) => nf(t, 1),
  };
  const gBands = [
    { from: 90, to: 1e9, label: 'G1', cls: 'b-G1' }, { from: 60, to: 90, label: 'G2', cls: 'b-G2' },
    { from: 45, to: 60, label: 'G3a', cls: 'b-G3a' }, { from: 30, to: 45, label: 'G3b', cls: 'b-G3b' },
    { from: 15, to: 30, label: 'G4', cls: 'b-G4' }, { from: 0, to: 15, label: 'G5', cls: 'b-G5' },
  ];
  const defs = {
    gfr: ['c-gfr', { title: T('c.gfr'), unit: 'mL/min', yMax: (m) => Math.max(140, Math.ceil(m / 20) * 20), bands: gBands, fmt: (v) => `${nf(v)} mL/min`, tickFmt: (v) => nf(v) }],
    sngfr: ['c-sngfr', { title: T('c.sngfr'), unit: 'nL/min', yMax: (m) => Math.max(100, Math.ceil(m / 20) * 20), refs: [{ y: HEALTHY_SNGFR, label: () => T('ref.healthy', { v: nf(HEALTHY_SNGFR, 1) }) }], fmt: (v) => `${nf(v)} nL/min`, tickFmt: (v) => nf(v) }],
    n: ['c-n', { title: T('c.n'), unit: () => T('u.millions'), yMax: 2.1, fmt: (v) => `${nf(v, 2)} M`, tickFmt: (v) => nf(v, 1) }],
    pgc: ['c-pgc', { title: T('c.pgc'), unit: 'mmHg', yMin: 40, yMax: (m) => Math.max(75, Math.ceil(m / 5) * 5),
      refs: [{ y: () => params.damageThreshold, label: () => T('ref.thr', { v: nf(params.damageThreshold, 1) }), cls: 'thr' }, { y: 55, label: () => T('ref.healthy', { v: '55' }) }], fmt: (v) => `${nf(v, 1)} mmHg`, tickFmt: (v) => nf(v) }],
    acr: ['c-acr', { title: T('c.acr'), unit: 'mg/g', log: true, yMin: 5, yMax: (m) => (m > 900 ? 3000 : 1000),
      bands: [{ from: 0, to: 30, label: 'A1', cls: 'b-A1' }, { from: 30, to: 300, label: 'A2', cls: 'b-A2' }, { from: 300, to: 1e9, label: 'A3', cls: 'b-A3' }],
      fmt: (v) => `${nf(v)} mg/g`, tickFmt: (v) => nf(v) }],
  };
  charts = {};
  for (const [k, [id, o]] of Object.entries(defs)) { $(id).replaceChildren(); charts[k] = new LineChart($(id), { ...common, ...o }); }
  setKdigo = renderKdigoGrid($('kdigo'), M.G_STAGES, M.A_CATS, { G: T('G.names'), A: T('A.names'), caption: T('kdigo.caption'), current: T('kdigo.current') });
}

function renderCharts() {
  const cfOn = ui.showCf && treatedEver;
  $('cf-legend').hidden = !cfOn;
  const xMax = ui.horizon;
  const mk = (h, f, cls) => h.map((s) => [s.t, f(s), cls?.(s)]);
  const S = (h, f, colour) => ({ pts: mk(h, f, colour), cls: 's-main' });
  const C = (h, f) => ({ pts: mk(h, f), cls: 's-cf', dashed: true });
  const both = (f, colour) => (cfOn ? [C(cfHist, f), S(hist, f, colour)] : [S(hist, f, colour)]);
  charts.gfr.update(both((s) => s.gfr, (s) => `st-${s.g}`), xMax);
  charts.sngfr.update(both((s) => s.sngfr), xMax);
  charts.n.update(both((s) => s.N / 1e6), xMax);
  charts.pgc.update(both((s) => s.P_GC), xMax);
  charts.acr.update(both((s) => s.acr), xMax);
  setKdigo(state.g, state.a);
}

function renderTable() {
  const det = document.querySelector('.table-view');
  if (!det.open) return;
  const cfOn = treatedEver;
  const rows = [];
  for (let y = 0; y <= state.t + 1e-9; y += 1) { const r = hist.find((h) => h.t >= y - DT / 2); if (r) rows.push(r); }
  if (rows[rows.length - 1] !== state) rows.push(state);
  const cfAt = (t) => cfHist.find((c) => Math.abs(c.t - t) < DT / 2);
  const th = T('th').filter((_, i) => i !== 2 || cfOn);
  $('data-table').innerHTML = `<div class="table-wrap"><table><thead><tr>${th.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((s) => `<tr><td>${nf(s.t, 1)}</td><td>${nf(s.gfr)}</td>${cfOn ? `<td>${cfAt(s.t) ? nf(cfAt(s.t).gfr) : ''}</td>` : ''}<td>${nf(s.sngfr)}</td><td>${nf(s.N / 1e6, 2)}</td><td>${nf(s.P_GC, 1)}</td><td>${nf(s.acr)}</td><td>${s.g}${s.a}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- render loop
let lastUi = 0, lastTable = 0;
function render(force = false) {
  $('clock').textContent = T('clock', { t: nf(state.t, 1), h: nf(ui.horizon) });
  drawGlomerulus(state);
  renderStarling(state);
  const now = performance.now();
  if (force || now - lastUi > 120) {
    lastUi = now;
    renderCycle(state); renderTiles(state); renderCharts();
    if (force || now - lastTable > 1000) { lastTable = now; renderTable(); }
  }
}

let lastTs = null, acc = 0;
function frame(ts) {
  const dtSec = lastTs == null ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing) {
    acc += dtSec * ui.speed;
    while (acc >= DT && state.t < ui.horizon - 1e-9) { stepOnce(); acc -= DT; }
    if (state.t >= ui.horizon - 1e-9) { acc = 0; setPlaying(false); addLog(state.t, () => T('log.end')); }
    render();
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches || playing) animateParticles(dtSec);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
setupControls();
buildGlomerulus();
setupCharts();
applyStaticText();
document.querySelector('.table-view').addEventListener('toggle', renderTable);
syncControls();
reset();
requestAnimationFrame(frame);

// small hook for automated checks (no effect on the app)
window.__sim = {
  get state() { return state; }, get hist() { return hist; }, get cfHist() { return cfHist; }, get params() { return params; },
  get lang() { return lang; }, setLang, loadPreset, setPlaying,
  runTo(t) { setPlaying(false); while (state.t < Math.min(t, ui.horizon) - 1e-9) stepOnce(); render(true); },
};
