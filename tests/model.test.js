// Run with:  node --test   (or: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const P = (o = {}) => M.withParams(o);
const at = (traj, years, dt = 0.05) => traj[Math.round(years / dt)];

test('healthy steady state: GFR ≈ 125 mL/min, SNGFR ≈ 60 nL/min, P_GC = 55 mmHg', () => {
  const s = M.initialState(P());
  assert.ok(Math.abs(s.gfr - 125) < 0.5, `GFR ${s.gfr}`);
  assert.ok(Math.abs(s.sngfr - 62.5) < 0.5, `SNGFR ${s.sngfr}`);
  assert.ok(Math.abs(s.P_GC - 55) < 1e-6, `P_GC ${s.P_GC}`);
  assert.equal(s.g, 'G1');
  assert.equal(s.a, 'A1');
  // 125 mL/min ≈ 180 L/day
  assert.ok(Math.abs((s.gfr * 1440) / 1000 - 180) < 1);
});

test('healthy GFR does not depend on the Re:Ra sensitivity ratio', () => {
  for (const r of [1, 2, 5, 10]) {
    assert.ok(Math.abs(M.initialState(P({ reRaRatio: r })).gfr - 125) < 0.5);
  }
});

test('healthy kidney is (almost) stable over 10 years', () => {
  const tr = M.simulate(P(), 10);
  assert.ok(at(tr, 10).gfr > 115, 'only slow age-related loss');
  assert.ok(tr.every((s) => !s.hyperfiltering));
});

test('losing 50 % of nephrons raises SNGFR (hyperfiltration) and P_GC', () => {
  const h = M.initialState(P());
  const l = M.initialState(P({ initialLossPct: 50 }));
  assert.ok(l.sngfr > h.sngfr * 1.1, `SNGFR ${h.sngfr} → ${l.sngfr}`);
  assert.ok(l.P_GC > h.P_GC);
  assert.ok(l.Re > h.Re, 'efferent constricts');
  assert.ok(l.gfr < h.gfr && l.gfr > h.gfr * 0.5, 'total GFR falls less than nephron number');
});

test('Ang II with equal afferent/efferent sensitivity (ratio 1) does not raise P_GC', () => {
  const s = M.initialState(P({ initialLossPct: 70, reRaRatio: 1 }));
  assert.ok(Math.abs(s.P_GC - 55) < 0.01, `P_GC ${s.P_GC}`);
});

test('efferent constriction raises P_GC; afferent constriction lowers it', () => {
  const base = M.glomerularPressure(2e6, P());
  // more efferent sensitivity at the same nephron loss → higher P_GC
  const lo = M.glomerularPressure(1e6, P({ reRaRatio: 2 }));
  const hi = M.glomerularPressure(1e6, P({ reRaRatio: 8 }));
  assert.ok(hi > lo && lo > base);
  // iSGLT2 = afferent constriction → lower P_GC
  assert.ok(M.glomerularPressure(2e6, P({ isglt2: true })) < base);
});

test('IECA/ARA II lowers Re and P_GC, causes an initial GFR dip, and slows decline', () => {
  const N = 0.3 * 2e6;
  const off = M.observe(N, 0, P({ initialLossPct: 70, MAP: 105 }));
  const on = M.observe(N, 0, P({ initialLossPct: 70, MAP: 105, ieca: true }));
  assert.ok(on.Re < off.Re);
  assert.ok(on.P_GC < off.P_GC);
  assert.ok(on.gfr < off.gfr, 'acute dip');
  const dip = 1 - on.gfr / off.gfr;
  assert.ok(dip > 0.05 && dip < 0.3, `dip ${(dip * 100).toFixed(1)} %`);

  const tOff = M.simulate(P({ initialLossPct: 70, MAP: 105 }), 15);
  const tOn = M.simulate(P({ initialLossPct: 70, MAP: 105, ieca: true }), 15);
  const declineOff = tOff[0].gfr - at(tOff, 15).gfr;
  const declineOn = tOn[0].gfr - at(tOn, 15).gfr;
  assert.ok(declineOn < declineOff / 3, `decline ${declineOn} vs ${declineOff}`);
  assert.ok(at(tOn, 15).gfr > at(tOff, 15).gfr, 'treated GFR ends higher');
});

test('GFR, SNGFR and N never go negative, even in extreme settings', () => {
  const extreme = P({ initialLossPct: 99, MAP: 160, kDamage: 1, reRaRatio: 10, autoreg: 0 });
  const tr = M.simulate(extreme, 60, 0.5); // coarse step on purpose
  for (const s of tr) {
    assert.ok(s.gfr >= 0 && s.sngfr >= 0 && s.N >= 0, JSON.stringify(s));
    assert.ok(Number.isFinite(s.gfr) && Number.isFinite(s.P_GC));
  }
  const low = M.initialState(P({ MAP: 40 })); // P_GC below π+P_BS
  assert.equal(low.sngfr, 0);
  assert.equal(low.gfr, 0);
});

test('KDIGO G and A classification boundaries', () => {
  assert.equal(M.gStage(90), 'G1');
  assert.equal(M.gStage(89.9), 'G2');
  assert.equal(M.gStage(60), 'G2');
  assert.equal(M.gStage(59), 'G3a');
  assert.equal(M.gStage(45), 'G3a');
  assert.equal(M.gStage(44), 'G3b');
  assert.equal(M.gStage(30), 'G3b');
  assert.equal(M.gStage(29), 'G4');
  assert.equal(M.gStage(15), 'G4');
  assert.equal(M.gStage(14.9), 'G5');
  assert.equal(M.aCategory(29.9), 'A1');
  assert.equal(M.aCategory(30), 'A2');
  assert.equal(M.aCategory(300), 'A3');
});

// ---------- presets behave as described ----------

test('preset "Sano": stays G1/A1 for 30 years', () => {
  const tr = M.simulatePreset(M.PRESETS.sano, 30);
  assert.ok(tr.every((s) => s.g === 'G1' && s.a === 'A1'));
});

test('preset "Nefrectomía unilateral": GFR drops, SNGFR rises, no vicious cycle', () => {
  const tr = M.simulatePreset(M.PRESETS.nefrectomia, 30);
  const s0 = tr[0];
  assert.ok(s0.gfr > 62.5 && s0.gfr < 90, `GFR ${s0.gfr}`);
  assert.ok(s0.sngfr > 62.5 * 1.15);
  assert.ok(!s0.hyperfiltering);
  assert.ok(at(tr, 30).gfr > 60, 'remains G2 after 30 y');
});

test('preset "HTA mantenida": hyperfiltration above threshold accelerates loss', () => {
  const tr = M.simulatePreset(M.PRESETS.hta, 40);
  assert.ok(tr[0].hyperfiltering);
  const d1 = tr[0].gfr - at(tr, 10).gfr;            // first decade
  const d2 = at(tr, 10).gfr - at(tr, 20).gfr;       // second decade
  assert.ok(d2 > d1, `acceleration ${d1} → ${d2}`);
  assert.ok(at(tr, 30).gfr < 30);
});

test('preset "ERC + IECA": dip when IECA starts at year 3, then slower decline', () => {
  const pr = M.PRESETS.ercIeca;
  const tr = M.simulatePreset(pr, 20);
  const cf = M.simulatePreset(pr, 20, 0.05, { ieca: false });
  const before = at(tr, 2.95), after = at(tr, 3);
  assert.ok(after.gfr < before.gfr * 0.95, 'initial dip');
  assert.ok(after.P_GC < before.P_GC);
  assert.ok(at(tr, 20).gfr > at(cf, 20).gfr * 2, 'treated stays much higher');
  const slopeTx = (at(tr, 3).gfr - at(tr, 13).gfr) / 10;
  const slopeCf = (at(cf, 3).gfr - at(cf, 13).gfr) / 10;
  assert.ok(slopeTx < slopeCf / 2, `slopes ${slopeTx} vs ${slopeCf}`);
});

test('model functions are pure (inputs unchanged, deterministic)', () => {
  const p = P({ initialLossPct: 40 });
  const copy = JSON.stringify(p);
  const a = M.simulate(p, 5);
  const b = M.simulate(p, 5);
  assert.equal(JSON.stringify(p), copy);
  assert.deepEqual(a, b);
});

test('proteinuria adds damage on its own (tubular toxicity), from A2 upwards', () => {
  // raise the hemodynamic threshold out of reach: only proteinuric damage remains
  const p = P({ initialLossPct: 70, MAP: 105, damageThreshold: 90 });
  const s = M.initialState(p);
  const r = M.damageRates(s.P_GC, p);
  assert.equal(r.hemo, 0);
  assert.ok(s.acr > 30 && r.prot > 0, `ACR ${s.acr}, prot ${r.prot}`);
  // in A1 there is no proteinuric damage
  const h = M.initialState(P());
  assert.equal(M.damageRates(h.P_GC, P()).prot, 0);
  // and lowering P_GC with IECA lowers albuminuria and the proteinuric term
  const pi = { ...p, ieca: true };
  const si = M.initialState(pi);
  assert.ok(si.acr < s.acr && M.damageRates(si.P_GC, pi).prot < r.prot);
});
