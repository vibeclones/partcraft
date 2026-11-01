/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sim-thermal-ui.js — the Simulation workspace's thermal, thermal-stress and buckling pieces on the page: the heat condition items
 * (registered as sim-ui ITEM kind `heat`), the study fields for each kind, the Add list, plots (temperature, heat flux, a transient's
 * time slider, buckling mode shapes), the probe text, the results table and the method notes. ws-simulation.js calls these from small
 * hooks. Top level is DOM-free (Node imports the ws files); the page is reached only through `host`.
 */
import * as U from './sim-ui.js';
import { threadWords } from './pool.js';
import { HEAT_LABEL, newHeat, newThermal, newThermalLoad, itemKinds, opFor } from './sim-thermal.js';
import { t } from './i18n.js';

export { itemKinds, opFor };

U.ITEM.heat = {
  prefix: 'h', label: (it) => HEAT_LABEL[it.type] || t('study.thermal.item.fallback'),
  icon: (it) => ({ temperature: 'thermometer-half', flux: 'brightness-high', power: 'lightning-charge', convection: 'wind', radiation: 'sun' }[it.type] || 'thermometer'),
  make: (id, type) => newHeat(id, type),
  editor(g, it, set, K) {
    const n = (label, key, min, max, what, data) => g.append(...K.field(label, K.num(it[key], (v) => set(what, (h) => { h[key] = v; }), { min, max, data })));
    if (it.type === 'temperature') n(t('study.thermal.field.temperature'), 'T', -273.15, 1e4, t('study.thermal.undo.temperature'), { simHeatT: '1' });
    if (it.type === 'flux') n(t('study.thermal.field.flux'), 'q', -1e9, 1e9, t('study.thermal.undo.flux'), { simHeatQ: '1' });
    if (it.type === 'power') n(t('study.thermal.field.power'), 'P', -1e7, 1e7, t('study.thermal.undo.power'), { simHeatP: '1' });
    if (it.type === 'convection') { n(t('study.thermal.field.h'), 'h', 0, 1e6, t('study.thermal.undo.h'), { simHeatH: '1' }); n(t('study.thermal.field.air'), 'Tamb', -273.15, 1e4, t('study.thermal.undo.air'), { simHeatTamb: '1' }); }
    if (it.type === 'radiation') { n(t('study.thermal.field.eps'), 'eps', 0, 1, t('study.thermal.undo.eps'), { simHeatEps: '1' }); n(t('study.thermal.field.surroundings'), 'Tamb', -273.15, 1e4, t('study.thermal.undo.surroundings'), { simHeatTamb: '1' }); }
  },
};

U.ITEM.heat.shown = (st) => itemKinds(st).includes('heat');   // markers only where the study uses them
U.ITEM.constraints.shown = U.ITEM.loads.shown = (st) => st.kind !== 'thermal';

/** A [value, label] pair whose label is looked up when it is read (a getter), never at import: workers and Node tests load this
 *  module before their language catalog. Spreading the outer list (flow-ui.js KINDS) keeps these same pairs, so they stay lazy. */
const choice = (value, key) => Object.defineProperty([value], 1, { get: () => t(key), enumerable: true });
const BASE_ADD = [['fixed', 'fixed'], ['frictionless', 'frictionless'], ['force', 'force'], ['pressure', 'pressure'], ['gravity', 'gravity']].map(([v, k]) => choice(v, 'study.thermal.add.' + k));
const HEAT_ADD = ['temperature', 'flux', 'power', 'convection', 'radiation'].map((v) => choice(v, 'study.thermal.add.' + v));
/** The panel's Add list for this study, and which item list a type goes to. */
export const addOptions = (st) => itemKinds(st).includes('heat') ? (st.kind === 'thermal' ? HEAT_ADD : [...BASE_ADD, ...HEAT_ADD]) : BASE_ADD;
export const kindOfType = (t) => (HEAT_ADD.some(([k]) => k === t) ? 'heat' : ['fixed', 'frictionless'].includes(t) ? 'constraints' : 'loads');
export const handles = (r) => !!r && (r.kind === 'thermal' || r.kind === 'buckling');
export const STUDY_KINDS = ['static', 'modal', 'thermal', 'buckling'].map((v) => choice(v, 'study.thermal.kind.' + v));

/** The material's thermal values in words. */
export const thermalProps = (m) => (m.k > 0 ? t('study.thermal.props', { k: U.sig(m.k), cp: U.sig(m.cp), alpha: U.sig(m.alpha * 1e6) }) : t('study.thermal.props.none'));

/** Study fields for the thermal kinds, appended to the study block g. set(label, fn(study)) is one undo step. */
export function studyFields(host, K, st, set, g) {
  const { el } = host;
  const th = st.thermal || newThermal();
  const sett = (label, fn) => set(label, (s) => { s.thermal = { ...newThermal(), ...(s.thermal || {}) }; fn(s.thermal); });
  const runFields = () => g.append(...K.field(t('study.thermal.field.t0'), K.num(th.T0, (v) => sett(t('study.thermal.undo.t0'), (x) => { x.T0 = v; }), { min: -273.15, max: 1e4, data: { simT0: '1' } })),
    ...K.field(t('study.thermal.field.span'), K.num(th.t, (v) => sett(t('study.thermal.undo.span'), (x) => { x.t = v; }), { min: 1e-3, max: 1e9, data: { simTime: '1' } })),
    ...K.field(t('study.thermal.field.steps'), K.num(th.steps, (v) => { if (!Number.isInteger(v)) { host.status(t('study.thermal.status.whole_steps')); return; } sett(t('study.thermal.field.steps'), (x) => { x.steps = v; }); }, { min: 1, max: 500, data: { simSteps: '1' } })),
    ...K.field(t('study.thermal.field.scheme'), K.sel([['euler', t('study.thermal.scheme.euler')], ['cn', t('study.thermal.scheme.cn')]], th.scheme, (v) => sett(t('study.thermal.field.scheme'), (x) => { x.scheme = v; }), { simScheme: '1' })));
  if (st.kind === 'thermal') {
    g.append(...K.field(t('study.thermal.field.gen'), K.num(th.gen, (v) => sett(t('study.thermal.undo.gen'), (x) => { x.gen = v; }), { min: -1e12, max: 1e12, data: { simGen: '1' } })));
    g.append(K.check(t('study.thermal.field.transient'), th.transient, (v) => sett(t('study.thermal.undo.transient'), (x) => { x.transient = v; }), { dataset: { simTransient: '1' } }));
    if (th.transient) runFields();
  }
  if (st.kind === 'static' || st.kind === 'buckling') {
    const l = st.thermalLoad || newThermalLoad();
    const setl = (label, fn) => set(label, (s) => { s.thermalLoad = { ...newThermalLoad(), ...(s.thermalLoad || {}) }; fn(s.thermalLoad); });
    g.append(...K.field(t('study.thermal.field.load'), K.sel([['none', t('study.thermal.load.none')], ['uniform', t('study.thermal.load.uniform')], ['field', t('study.thermal.load.field')], ['transient', t('study.thermal.load.transient')]], l.mode, (v) => setl(t('study.thermal.field.load'), (x) => { x.mode = v; }), { simThermalLoad: '1' })));
    if (l.mode === 'uniform') g.append(...K.field(t('study.thermal.field.dt'), K.num(l.dT, (v) => setl(t('study.thermal.undo.dt'), (x) => { x.dT = v; }), { min: -1e4, max: 1e4, data: { simDt: '1' } })));
    if (l.mode === 'field') g.append(...K.field(t('study.thermal.field.tref'), K.num(l.Tref, (v) => setl(t('study.thermal.undo.tref'), (x) => { x.Tref = v; }), { min: -273.15, max: 1e4, data: { simTref: '1' } })),
      el('p', { className: 'pc-note span' }, t('study.thermal.note.field')));
    if (l.mode === 'transient') {
      g.append(...K.field(t('study.thermal.field.tref'), K.num(l.Tref, (v) => setl(t('study.thermal.undo.tref'), (x) => { x.Tref = v; }), { min: -273.15, max: 1e4, data: { simTref: '1' } })));
      runFields();
      const at = st.kind === 'buckling' ? 'time' : l.at || 'worst';
      if (st.kind === 'static') g.append(...K.field(t('study.thermal.field.stress_at'), K.sel([['worst', t('study.thermal.stress_at.worst')], ['time', t('study.thermal.stress_at.time')]], at, (v) => setl(t('study.thermal.undo.stress_time'), (x) => { x.at = v; }), { simStressAt: '1' })));
      if (at === 'worst') g.append(...K.field(t('study.thermal.field.solves'), K.num(l.solves ?? 21, (v) => { if (!Number.isInteger(v)) { host.status(t('study.thermal.status.whole_solves')); return; } setl(t('study.thermal.field.solves'), (x) => { x.solves = v; }); }, { min: 2, max: 51, data: { simSolves: '1' } })));
      else g.append(...K.field(t('study.thermal.field.time'), K.num(l.time ?? th.t, (v) => setl(t('study.thermal.undo.stress_time'), (x) => { x.time = v; }), { min: 0, max: 1e9, data: { simStressTime: '1' } })));
      g.append(el('p', { className: 'pc-note span' }, at === 'worst' ? t('study.thermal.note.worst') : t('study.thermal.note.time')));
    }
  }
}

/** The method note for the panel's foot (null: the structural one). */
export function methodNote(st) {
  if (st.kind === 'thermal') return st.thermal && st.thermal.transient ? t('study.thermal.method.transient', { scheme: t(st.thermal.scheme === 'cn' ? 'study.thermal.method.cn' : 'study.thermal.method.euler') }) : t('study.thermal.method.steady');
  if (st.kind === 'buckling') return t('study.thermal.method.buckling');
  return null;
}
/** Extra words for a static study with a thermal load. */
export const staticNote = (st) => (st.thermalLoad && st.thermalLoad.mode !== 'none' ? ' ' + t('study.thermal.note.static') + (st.thermalLoad.mode === 'transient' ? ' ' + t('study.thermal.note.static_transient') : '') : '');

// ---------------------------------------------------------------- results

/** After a solve: the plot defaults for this result. */
export function afterSolve(r, S) {
  if (r.kind === 'thermal') { S.plot = 'temp'; S.deformed = false; S.frame = r.transient ? r.frames.length - 1 : 0; }
  else { S.mode = 0; S.deformed = true; }
}
export function statusText(r) {
  const els = t('study.thermal.status.elements', { n: r.summary.elements.toLocaleString('en-US'), sec: (r.ms / 1000).toFixed(1) });
  if (r.kind === 'thermal') {
    const v = { lo: U.sig(r.minT.value), hi: U.sig(r.maxT.value), q: U.sig(r.balance.inflow), els };
    return r.transient ? t('study.thermal.status.solved_at', { ...v, time: U.sig(r.times[r.times.length - 1]) }) : t('study.thermal.status.solved', v);
  }
  const l = r.factors[0];
  return t(l < 1 ? 'study.thermal.status.buckles' : 'study.thermal.status.buckling', { l: U.sig(l), els });
}

function tRange(r) {
  if (!r.transient) { let lo = Infinity, hi = -Infinity; for (const v of r.vertex.T) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; }
  let lo = Infinity, hi = -Infinity; for (const F of r.frames) for (const v of F) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return [lo, hi];
}
/** The plotted field { values, lo, hi, unit, title, u? }. */
export function field(r, S) {
  if (r.kind === 'buckling') {
    const u = r.shapes[S.mode] || r.shapes[0], nv = u.length / 3, mag = new Float32Array(nv);
    for (let v = 0; v < nv; v++) mag[v] = Math.hypot(u[3 * v], u[3 * v + 1], u[3 * v + 2]);
    return { values: mag, lo: 0, hi: 1, unit: t('study.thermal.unit.relative'), title: t('study.thermal.title.mode', { n: S.mode + 1, l: U.sig(r.factors[S.mode]) }), u };
  }
  if (S.plot === 'flux') { let hi = 0; for (const v of r.vertex.q) hi = Math.max(hi, v); return { values: r.vertex.q, lo: 0, hi: hi || 1, unit: 'W/m²', title: t(r.transient ? 'study.thermal.title.flux_end' : 'study.thermal.title.flux') }; }
  const [lo, hi] = tRange(r);
  const values = r.transient ? r.frames[Math.min(S.frame ?? r.frames.length - 1, r.frames.length - 1)] : r.vertex.T;
  return { values, lo, hi: hi > lo ? hi : lo + 1, unit: '°C', title: r.transient ? t('study.thermal.title.temp_at', { time: U.sig(r.times[S.frame ?? r.times.length - 1]) }) : t('study.thermal.title.temp') };
}
export function probeText(r, S, val, at) {
  if (r.kind === 'buckling') return t('study.thermal.probe.amplitude', { v: U.fmt(val(field(r, S).values), 3), at });
  const T = val(field(r, { ...S, plot: 'temp' }).values);
  return r.transient && S.frame !== r.frames.length - 1 ? t('study.thermal.probe.temp', { T: U.sig(T), at }) : t('study.thermal.probe.temp_flux', { T: U.sig(T), q: U.sig(val(r.vertex.q)), at });
}

/** The results block for a thermal or buckling result (b: the block, already headed). api { plot(), renderPanel(), autoScale(f), study } */
export function renderResults(host, b, K, r, S, api) {
  const { el } = host;
  const ctl = el('div', { className: 'pc-props' });
  const f = field(r, S);
  if (r.kind === 'thermal') {
    ctl.append(...K.field(t('study.thermal.field.show'), K.sel([['temp', t('study.thermal.title.temp')], ['flux', t(r.transient ? 'study.thermal.show.flux_end' : 'study.thermal.title.flux')]], S.plot === 'flux' ? 'flux' : 'temp', (v) => { S.plot = v; api.plot(); host.renderPanel(); }, { simPlot: '1' })));
    if (r.transient && S.plot !== 'flux') {
      const lab = el('span', { className: 'v', dataset: { simTimeLabel: '1' } }, `${U.sig(r.times[S.frame])} s`);
      const range = el('input', { type: 'range', className: 'pc-range', min: '0', max: String(r.frames.length - 1), step: '1', value: String(S.frame), 'aria-label': t('study.thermal.label.time'), dataset: { simTimeSlider: '1' } });
      range.addEventListener('input', () => { S.frame = Number(range.value); lab.textContent = `${U.sig(r.times[S.frame])} s`; api.plot(); const sub = b.querySelector('[data-sim-legend] .pc-props-sub'); if (sub) sub.textContent = `${field(r, S).title} (°C)`; });
      ctl.append(el('span', { className: 'k' }, t('study.thermal.label.time')), lab, el('label', { className: 'span' }, range));
    }
  } else {
    ctl.append(...K.field(t('study.thermal.field.mode'), K.sel(r.factors.map((l, i) => [String(i), t('study.thermal.mode.option', { n: i + 1, l: U.sig(l) })]), String(S.mode), (v) => { S.mode = Number(v); S.scale = null; api.plot(); host.renderPanel(); }, { simMode: '1' })));
    ctl.append(K.check(t('study.thermal.field.deformed'), S.deformed, (v) => { S.deformed = v; api.plot(); host.renderPanel(); }, { dataset: { simDeformed: '1' } }));
    if (S.deformed) ctl.append(...K.field(t('study.thermal.field.scale'), K.num(S.scale ?? api.autoScale(f), (v) => { S.scale = v; api.plot(); }, { min: 0, max: 1e9, data: { simScale: '1' } })));
  }
  b.append(ctl, U.legend(host, f));
  S.probeEl = el('p', { className: 'pc-note', dataset: { simProbe: '1' }, 'aria-live': 'polite' }, t('study.thermal.probe.hint'));
  b.append(S.probeEl);
  const dl = el('dl', { className: 'pc-dl', dataset: { simTable: '1' } });
  const add = (k, v, data) => dl.append(el('dt', {}, k), el('dd', data ? { dataset: data } : {}, v));
  const xyz = (p) => `(${p.map((v) => U.fmt(v, 2)).join(', ')})`, s = r.summary, st = api.study;
  if (r.kind === 'thermal') {
    add(t('study.thermal.row.min_t'), t('study.thermal.val.t_at', { T: U.sig(r.minT.value), at: xyz(r.minT.at) }), { simMinT: String(r.minT.value) });
    add(t('study.thermal.row.max_t'), t('study.thermal.val.t_at', { T: U.sig(r.maxT.value), at: xyz(r.maxT.at) }), { simMaxT: String(r.maxT.value) });
    add(t('study.thermal.row.max_flux'), t('study.thermal.val.max_flux', { q: U.sig(r.maxFlux) }));
    const bal = r.balance;
    const inOut = (q) => t(q >= 0 ? 'study.thermal.val.in' : 'study.thermal.val.out', { q: U.sig(Math.abs(q)) });
    (st.heat || []).forEach((h, i) => { const q = bal.items[i]; if (q !== undefined) add(`  ${U.itemName('heat', h)}`, inOut(q)); });
    if (bal.gen) add('  ' + t('study.thermal.row.gen'), inOut(bal.gen));
    if (r.transient) add('  ' + t('study.thermal.row.stored'), `${U.sig(bal.stored)} W`);
    add(t('study.thermal.row.heat_in'), `${U.sig(bal.inflow)} W`, { simHeatIn: String(bal.inflow) });
    add(t('study.thermal.row.heat_out'), `${U.sig(bal.outflow)} W`, { simHeatOut: String(bal.outflow) });
    const ref = Math.max(bal.inflow, bal.outflow, 1e-300);
    add(t(r.transient ? 'study.thermal.row.imbalance_stored' : 'study.thermal.row.imbalance'), `${U.sig(bal.imbalance)} W (${U.sig(100 * Math.abs(bal.imbalance) / ref)} %)`, { simImbalance: String(bal.imbalance) });
    const radiation = r.radiation ? (r.transient ? t('study.thermal.solver.rad_each_step') : t('study.thermal.solver.rad_settled', { n: r.radiation.iterations })) : '';
    add(t('study.thermal.row.solver'), t('study.thermal.val.solver', { n: r.iterations, residual: r.residual.toExponential(1), radiation, sec: (r.ms / 1000).toFixed(1), threads: r.threads ? ', ' + threadWords(r.threads, t('study.thermal.solver.heat_serial')) : '' }), { simThreads: String(r.threads ? r.threads.used : 1) });
    add(t('study.thermal.row.mesh'), t('study.thermal.val.mesh_heat', { mesh: U.meshWords(s), n: s.dofs.toLocaleString('en-US') }));
  } else {
    const L = r.loadMagnitude;
    r.factors.forEach((l, i) => add(t('study.thermal.row.mode', { n: i + 1 }), t('study.thermal.val.mode', { l: U.sig(l), total: L > 0 ? t('study.thermal.val.mode_total', { N: U.sig(l * L) }) : '', buckles: l < 1 ? t('study.thermal.val.mode_buckles') : '' }), i === 0 ? { simLambda1: String(l) } : null));
    if (r.negative) add(t('study.thermal.row.reversed'), t('study.thermal.val.reversed', { v: U.sig(-r.negative) }));
    const loads = r.loadTotal.map((v) => U.sig(v)).join(', ');
    add(t('study.thermal.row.applied'), r.thermal ? t('study.thermal.val.applied_thermal', { loads }) : `${loads} N`);
    add(t('study.thermal.row.prestress'), t('study.thermal.val.prestress', { vm: U.sig(r.preMaxVm.value), d: U.sig(r.preMaxDisp.value) }));
    add(t('study.thermal.row.solver'), t(r.converged ? 'study.thermal.val.eig_converged' : 'study.thermal.val.eig_not_converged', { n: r.eigIterations, solves: r.solves, residual: r.solveResidual ? t('study.thermal.val.eig_residual', { r: r.solveResidual.toExponential(1) }) : '', sec: (r.ms / 1000).toFixed(1), threads: r.threads ? ', ' + threadWords(r.threads, s.mesher === 'tet' ? t('study.thermal.solver.tet_serial') : '') : '' }), { simEigConverged: String(r.converged), simThreads: String(r.threads ? r.threads.used : 1) });
    add(t('study.thermal.row.mesh'), t('study.thermal.val.mesh', { mesh: U.meshWords(s), n: s.dofs.toLocaleString('en-US') }));
  }
  b.append(dl);
  if (r.kind === 'buckling') {
    if (!r.converged) b.append(el('div', { className: 'pc-msg is-error' }, el('p', {}, t('study.thermal.msg.not_settled'))));
    if (r.factors[0] < 1) b.append(el('div', { className: 'pc-msg is-error' }, el('p', {}, t('study.thermal.msg.below_one', { l: U.sig(r.factors[0]) }))));
    b.append(el('p', { className: 'pc-note' }, t('study.thermal.note.buckling')));
  } else b.append(el('p', { className: 'pc-note' }, t('study.thermal.note.balance')));
}

/** Rows for a static result with a thermal load (add(k, v, data) as in ws-simulation's table). */
export function staticRows(r, add) {
  if (!r.thermal) return;
  const h = r.history;
  const timed = r.thermal.time !== null && r.thermal.time !== undefined;
  const dT = { lo: U.sig(r.thermal.minDT), hi: U.sig(r.thermal.maxDT) };
  add(t('study.thermal.field.load'), timed ? t('study.thermal.val.dt_at', { ...dT, time: U.sig(r.thermal.time) }) : t('study.thermal.val.dt', dT), { simThermalDt: String(r.thermal.maxDT) });
  if (h && h.at === 'worst') add(t('study.thermal.row.worst'), t('study.thermal.val.worst', { time: U.sig(h.times[h.worst]), vm: U.sig(h.maxVm[h.worst]), n: h.times.length, end: U.sig(h.times[h.times.length - 1]) }), { simWorstTime: String(h.times[h.worst]) });
  if (r.thermal.heat) {
    const T = { lo: U.sig(r.thermal.heat.minT.value), hi: U.sig(r.thermal.heat.maxT.value) };
    add(t('study.thermal.row.temps_used'), r.thermal.transient
      ? t('study.thermal.val.temps_transient', { ...T, from: U.sig(h ? h.times[0] : 0), to: U.sig(r.thermal.heat.end) })
      : timed ? t('study.thermal.val.temps_at', { ...T, time: U.sig(r.thermal.time) }) : t('study.thermal.val.temps_steady', { ...T, q: U.sig(r.thermal.heat.balance.inflow) }));
  }
}

/** A static result over time (thermal-history.js): the time slider (starts at the worst time) and the peak-stress chart.
 *  ctl: the results' control grid; replot(): ws-simulation's plot. The slider swaps r.vertex for that time's fields. */
export function historyControls(host, ctl, r, S, replot) {
  const h = r.history, { el } = host;
  if (!h || !r.frames || !r.frames.length) return;
  if (S.historyOf !== r) { S.historyOf = r; S.frame = h.worst; }
  const i = Math.min(S.frame ?? h.worst, r.frames.length - 1);
  r.vertex = r.frames[i];
  const words = (k) => t(k === h.worst ? 'study.thermal.history.peak_worst' : 'study.thermal.history.peak', { time: U.sig(h.times[k]), vm: U.sig(h.maxVm[k]) });
  const lab = el('span', { className: 'v', dataset: { simTimeLabel: '1' } }, words(i));
  ctl.append(el('span', { className: 'k' }, t('study.thermal.label.time')), lab);
  if (r.frames.length > 1) {
    const range = el('input', { type: 'range', className: 'pc-range', min: '0', max: String(r.frames.length - 1), step: '1', value: String(i), 'aria-label': t('study.thermal.label.time'), dataset: { simTimeSlider: '1' } });
    const cv = el('canvas', { width: 560, height: 140, className: 'pc-flow-res', role: 'img', 'aria-label': t('study.thermal.history.chart'), dataset: { simHistory: '1' } });
    cv.style.setProperty('width', '100%'); cv.style.setProperty('height', '7.5rem');
    range.addEventListener('input', () => { S.frame = Number(range.value); r.vertex = r.frames[S.frame]; lab.textContent = words(S.frame); replot(); drawHistory(host, cv, h, S.frame); });
    ctl.append(el('label', { className: 'span' }, range), el('div', { className: 'span' }, cv));
    drawHistory(host, cv, h, i);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => drawHistory(host, cv, h, S.frame ?? i));   // once it has a size on the page
  }
}

function drawHistory(host, cv, h, cur) {
  const g = cv.getContext && cv.getContext('2d');
  if (!g || !host.tokens) return;
  // drawn at the canvas's size on the page × the pixel ratio, in CSS pixels
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, cw = cv.clientWidth || 280, ch = cv.clientHeight || 120;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const T = host.tokens(), W = cw, H = ch, pad = { l: 8, r: 8, t: 18, b: 18 };
  g.clearRect(0, 0, W, H);
  g.font = `11px ${T.font}`; g.strokeStyle = T.axis; g.fillStyle = T.cons; g.lineWidth = 1;
  g.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);
  const tmax = h.times[h.times.length - 1] || 1, smax = Math.max(...h.maxVm, 1e-30);
  const X = (tm) => pad.l + (W - pad.l - pad.r) * tm / tmax, Y = (s) => pad.t + (H - pad.t - pad.b) * (1 - s / smax);
  g.textBaseline = 'alphabetic';
  g.fillText(t('study.thermal.history.axis', { vm: U.sig(smax) }), pad.l, pad.t - 5); g.fillText('0 s', pad.l, H - 4);
  g.textAlign = 'right'; g.fillText(`${U.sig(tmax)} s`, W - pad.r, H - 4); g.textAlign = 'left';
  g.strokeStyle = T.under; g.lineWidth = 1.5; g.beginPath();
  h.times.forEach((tm, k) => { if (k) g.lineTo(X(tm), Y(h.maxVm[k])); else g.moveTo(X(tm), Y(h.maxVm[k])); });
  g.stroke();
  g.fillStyle = T.over; g.beginPath(); g.arc(X(h.times[h.worst]), Y(h.maxVm[h.worst]), 4, 0, 2 * Math.PI); g.fill();
  g.strokeStyle = T.cons; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(X(h.times[cur]), pad.t); g.lineTo(X(h.times[cur]), H - pad.b); g.stroke(); g.setLineDash([]);
}
