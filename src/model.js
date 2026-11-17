// model.js — Glomerular hyperfiltration teaching model.
// Pure functions only (no DOM, no globals mutated). Units:
//   pressures mmHg · SNGFR nL/min · GFR mL/min · time years · resistances in
//   arbitrary units normalised so the healthy afferent resistance Ra0 = 1.
//
// TEACHING TOOL — NOT FOR CLINICAL USE. See README.md for every assumption.

/** Default parameters. [phys] = standard physiology / KDIGO value;
 *  [assumption] = tuning choice of the simulator. */
export const DEFAULTS = Object.freeze({
  N0: 2_000_000,       // [phys] functioning nephrons, both kidneys
  MAP: 93,             // [phys] mean arterial pressure, mmHg
  P_BS: 10,            // [phys] Bowman's space hydrostatic pressure, mmHg
  PI_GC: 25,           // [phys] mean glomerular oncotic pressure, mmHg
  P_OUT: 0,            // [assumption] post-efferent pressure (simplification)
  PGC_HEALTHY: 55,     // [phys] healthy glomerular capillary pressure, mmHg
  GFR_HEALTHY: 125,    // [phys] healthy total GFR, mL/min
  initialLossPct: 0,   // initial insult: % of nephrons lost at t = 0
  angGain: 1.5,        // [assumption] how steeply Ang II rises as nephrons fall
  effSens: 1.0,        // [assumption] efferent sensitivity to Ang II
  reRaRatio: 3,        // [phys, magnitude assumed] Re:Ra Ang II sensitivity ratio (>1)
  autoreg: 0.75,       // [phys] fraction of a MAP change buffered by afferent myogenic tone
  damageThreshold: 60, // [assumption] P_GC above which hyperfiltration injures, mmHg
  kDamage: 0.012,      // [assumption] hemodynamic loss per year per mmHg of P_GC above threshold
  kProt: 0.036,        // [assumption] proteinuric (tubular toxicity) loss per year per e-fold of ACR above 30 mg/g
  acrDamage: 30,       // [phys] ACR (mg/g) from which proteinuria adds damage (KDIGO A2 boundary)
  kAge: 0.005,         // [assumption] baseline (age) nephron loss per year
  ieca: false,         // IECA / ARA II on
  rasBlock: 0.5,       // [assumption] fraction of Ang II effect removed by IECA/ARA II
  isglt2: false,       // iSGLT2 on
  sglt2Afferent: 0.1,  // [phys/assumption] +10 % afferent resistance via TGF
  acrHealthy: 10,      // [assumption] albuminuria proxy at healthy P_GC, mg/g
  acrScale: 4.55,      // [assumption] mmHg per e-fold rise (P_GC 60 → 30 mg/g)
});

// ---------- derived constants ----------

/** Healthy efferent resistance so that P_GC = PGC_HEALTHY at MAP 93 with Ra0 = 1. */
export function healthyRe(p = DEFAULTS) {
  const f = (p.PGC_HEALTHY - p.P_OUT) / (93 - p.P_OUT); // Re/(Ra+Re)
  return f / (1 - f); // Ra0 = 1
}

/** Ultrafiltration coefficient per nephron (nL/min/mmHg) calibrated so that
 *  N0 × SNGFR = GFR_HEALTHY at the healthy P_GC. */
export function calibratedKf(p = DEFAULTS) {
  const sngfr = (p.GFR_HEALTHY * 1e6) / p.N0; // nL/min (62.5)
  return sngfr / (p.PGC_HEALTHY - p.P_BS - p.PI_GC);
}

// ---------- physiology ----------

/** Fraction of nephrons missing (0 = full complement). */
export function nephronDeficit(N, p = DEFAULTS) {
  return Math.min(1, Math.max(0, 1 - N / p.N0));
}

/** Ang II index (1 = basal). Rises non-linearly as nephron mass falls. */
export function angII(N, p = DEFAULTS) {
  const d = nephronDeficit(N, p);
  return 1 + (p.angGain * d) / (1 - d + 0.2);
}

/** Afferent (Ra) and efferent (Re) resistances. Ang II constricts both, but
 *  the efferent `reRaRatio` times more. Structural parts are scaled so the
 *  healthy state is the same whatever the ratio. IECA/ARA II remove a
 *  fraction of the Ang II effect; iSGLT2 adds afferent tone (TGF);
 *  afferent myogenic autoregulation buffers part of a MAP change. */
export function resistances(N, p = DEFAULTS) {
  const Re0 = healthyRe(p);
  const sE = p.effSens;
  const sA = p.effSens / Math.max(0.1, p.reRaRatio);
  const A = angII(N, p) * (p.ieca ? 1 - p.rasBlock : 1);
  const Re = (Re0 / (1 + sE)) * (1 + sE * A);
  let RaAng = (1 / (1 + sA)) * (1 + sA * A);
  if (p.isglt2) RaAng *= 1 + p.sglt2Afferent;
  // Myogenic: the glomerulus "sees" MAPeff instead of MAP.
  const mapEff = effectiveMAP(p);
  const RaTotal = Math.max(
    0.05,
    ((p.MAP - p.P_OUT) / (mapEff - p.P_OUT)) * (RaAng + Re) - Re,
  );
  return { Ra: RaTotal, Re, RaAng, A };
}

/** MAP transmitted to the glomerulus after afferent (myogenic) autoregulation.
 *  Buffering only works inside the autoregulatory range (~80–180 mmHg [ext]);
 *  outside it, pressure changes are transmitted fully. */
export const AUTOREG_RANGE = [80, 180];
export function effectiveMAP(p = DEFAULTS) {
  const [lo, hi] = AUTOREG_RANGE;
  const inRange = Math.min(hi, Math.max(lo, p.MAP));
  return 93 + (1 - p.autoreg) * (inRange - 93) + (p.MAP - inRange);
}

/** Series-resistor glomerular capillary pressure (voltage divider). */
export function glomerularPressure(N, p = DEFAULTS) {
  const { Ra, Re } = resistances(N, p);
  return p.P_OUT + (p.MAP - p.P_OUT) * (Re / (Ra + Re));
}

/** Starling: SNGFR = Kf × (P_GC − P_BS − π_GC), never negative. nL/min. */
export function sngfr(P_GC, p = DEFAULTS) {
  return Math.max(0, calibratedKf(p) * (P_GC - p.P_BS - p.PI_GC));
}

/** Total GFR in mL/min. */
export function totalGFR(N, sn) {
  return Math.max(0, (N * sn) / 1e6);
}

/** Albuminuria proxy (mg/g), exponential in P_GC. */
export function albuminuria(P_GC, p = DEFAULTS) {
  return p.acrHealthy * Math.exp((P_GC - p.PGC_HEALTHY) / p.acrScale);
}

/** Relative renal blood flow (healthy = 1): ΔP / total resistance. */
export function relativeRBF(N, p = DEFAULTS) {
  const { Ra, Re } = resistances(N, p);
  const Re0 = healthyRe(p);
  return ((p.MAP - p.P_OUT) / (Ra + Re)) / ((93 - p.P_OUT) / (1 + Re0));
}

/** Nephron loss split by cause (fraction of N lost per year):
 *  age (baseline), hemodynamic (sustained hyperfiltration: P_GC above the
 *  threshold) and proteinuric (filtered protein is toxic to the tubule). */
export function damageRates(P_GC, p = DEFAULTS) {
  const acr = albuminuria(P_GC, p);
  return {
    age: p.kAge,
    hemo: p.kDamage * Math.max(0, P_GC - p.damageThreshold),
    prot: p.kProt * Math.max(0, Math.log(acr / p.acrDamage)),
  };
}

/** Nephron loss rate (nephrons/year). */
export function lossRate(N, P_GC, p = DEFAULTS) {
  const r = damageRates(P_GC, p);
  return N * (r.age + r.hemo + r.prot);
}

// ---------- classification ----------

export const G_STAGES = [
  { id: 'G1', min: 90, label: 'G1 (≥90)' },
  { id: 'G2', min: 60, label: 'G2 (60–89)' },
  { id: 'G3a', min: 45, label: 'G3a (45–59)' },
  { id: 'G3b', min: 30, label: 'G3b (30–44)' },
  { id: 'G4', min: 15, label: 'G4 (15–29)' },
  { id: 'G5', min: -Infinity, label: 'G5 (<15)' },
];
export const A_CATS = [
  { id: 'A1', max: 30, label: 'A1 (<30)' },
  { id: 'A2', max: 300, label: 'A2 (30–300)' },
  { id: 'A3', max: Infinity, label: 'A3 (>300)' },
];

export function gStage(gfr) {
  return G_STAGES.find((s) => gfr >= s.min).id;
}
export function aCategory(acr) {
  return A_CATS.find((c) => acr < c.max).id;
}

// ---------- state & integration ----------

/** Snapshot of every derived quantity for a given nephron number. */
export function observe(N, t, p = DEFAULTS) {
  const P_GC = glomerularPressure(N, p);
  const sn = sngfr(P_GC, p);
  const gfr = totalGFR(N, sn);
  const acr = albuminuria(P_GC, p);
  const r = resistances(N, p);
  return {
    t, N, P_GC, sngfr: sn, gfr, acr,
    Ra: r.Ra, Re: r.Re, RaAng: r.RaAng, angII: r.A,
    rbf: relativeRBF(N, p),
    g: gStage(gfr), a: aCategory(acr),
    hyperfiltering: P_GC > p.damageThreshold,
  };
}

export function initialState(p = DEFAULTS) {
  const N = p.N0 * (1 - Math.min(100, Math.max(0, p.initialLossPct)) / 100);
  return observe(N, 0, p);
}

/** One explicit Euler step of dN/dt = −lossRate. */
export function step(state, p = DEFAULTS, dt = 0.05) {
  const dN = lossRate(state.N, state.P_GC, p) * dt;
  const N = Math.max(0, state.N - dN);
  return observe(N, state.t + dt, p);
}

/** Run a whole simulation; returns the trajectory (array of observations). */
export function simulate(p = DEFAULTS, years = 30, dt = 0.05) {
  let s = initialState(p);
  const out = [s];
  const n = Math.round(years / dt);
  for (let i = 0; i < n; i++) {
    s = step(s, p, dt);
    out.push(s);
  }
  return out;
}

export function withParams(over = {}) {
  return { ...DEFAULTS, ...over };
}

// ---------- scenario presets ----------

/** Each preset: params applied at reset and optional timed `events`
 *  ({ t: years, set: {...params} }). Names and expected behaviour live in i18n.js. */
export const PRESETS = {
  sano: {
    params: { initialLossPct: 0, MAP: 93, ieca: false, isglt2: false },
    events: [],
  },
  nefrectomia: {
    params: { initialLossPct: 50, MAP: 93, ieca: false, isglt2: false },
    events: [],
  },
  hta: {
    params: { initialLossPct: 25, MAP: 115, ieca: false, isglt2: false },
    events: [],
  },
  ercIeca: {
    params: { initialLossPct: 70, MAP: 105, ieca: false, isglt2: false },
    events: [{ t: 3, set: { ieca: true } }],
  },
};

/** Parameters in force at time t for a preset (base + events already due). */
export function paramsAt(preset, t, base = DEFAULTS) {
  let p = { ...base, ...preset.params };
  for (const ev of preset.events || []) if (t >= ev.t - 1e-9) p = { ...p, ...ev.set };
  return p;
}

/** Simulate a preset including its timed events. `override` changes params
 *  for the whole run (used for the "sin tratamiento" counterfactual). */
export function simulatePreset(preset, years = 30, dt = 0.05, override = {}) {
  let p = { ...paramsAt(preset, 0), ...override };
  let s = initialState(p);
  const out = [s];
  const n = Math.round(years / dt);
  for (let i = 0; i < n; i++) {
    s = step(s, p, dt);
    p = { ...paramsAt(preset, s.t), ...override };
    s = observe(s.N, s.t, p); // resistances respond immediately to new params
    out.push(s);
  }
  return out;
}
