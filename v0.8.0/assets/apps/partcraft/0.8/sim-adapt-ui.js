/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sim-adapt-ui.js — the Simulation panel's automatic refinement (tetadapt.js): the "Refine automatically" fields of a
 * tetrahedral static or steady thermal study, and the convergence results (stop message, table, two small charts:
 * estimated error and the peak value against the number of unknowns). ws-simulation.js and sim-thermal-ui.js call it.
 * Top level is DOM-free (Node imports it); the page is touched only through `host`.
 */
import { ADAPTIVE_DEFAULT, mesherOf } from './sim.js';
import * as U from './sim-ui.js';
import { t } from './i18n.js';

/** Does this study offer automatic refinement? (tets; static or buckling without a thermal load, modal (0.4), or steady thermal) */
export function offers(st) {
  if (!st || mesherOf(st) !== 'tet') return false;
  if (st.kind === 'static' || st.kind === 'buckling') return !(st.thermalLoad && st.thermalLoad.mode && st.thermalLoad.mode !== 'none');
  if (st.kind === 'modal') return true;
  return st.kind === 'thermal' && !(st.thermal && st.thermal.transient);
}
/** Modal and buckling passes: the value the table and chart follow (first frequency, first load factor). */
const eigKind = (k) => (k === 'modal' || k === 'buckling' ? k : null);

/** The fields: a check, and when on the target % and the most passes. g: the study's pc-props grid. */
export function fields(host, K, st, set, g) {
  if (!offers(st)) return;
  const a = st.adaptive;
  g.append(K.check(t('study.adapt.check'), !!a, (v) => set(t('study.adapt.heading'), (s) => { if (v) s.adaptive = { ...ADAPTIVE_DEFAULT }; else delete s.adaptive; }), { dataset: { simAdaptive: '1' } }));
  if (!a) return;
  g.append(...K.field(t('study.adapt.target'), K.num(a.target, (v) => set(t('study.adapt.target_undo'), (s) => { s.adaptive.target = v; }), { min: 0.05, max: 50, data: { simAdaptTarget: '1' } })));
  g.append(...K.field(t('study.adapt.passes'), K.num(a.passes, (v) => { if (!Number.isInteger(v)) { host.status(t('study.adapt.whole_passes')); return; } set(t('study.adapt.passes_undo'), (s) => { s.adaptive.passes = v; }); }, { min: 1, max: 10, data: { simAdaptPasses: '1' } })));
  if (eigKind(st.kind)) { g.append(host.el('p', { className: 'pc-note span', dataset: { simAdaptNote: '1' } }, t('sim.adapt.note.' + st.kind))); return; }
  g.append(host.el('p', { className: 'pc-note span', dataset: { simAdaptNote: '1' } }, st.kind === 'thermal' ? t('study.adapt.note_thermal') : t('study.adapt.note_stress')));
}

const fmtN = (n) => n.toLocaleString('en-US');

/** The convergence results into block b (when r.adaptive). */
export function results(host, b, r) {
  const a = r.adaptive;
  if (!a) return;
  const { el } = host, heat = r.kind === 'thermal', eig = eigKind(r.kind);
  b.append(el('p', { className: 'pc-props-sub' }, t('study.adapt.heading')));
  b.append(el('div', { className: 'pc-msg' + (a.converged ? ' is-ok' : a.stop === 'failed' ? ' is-error' : ''), dataset: { simAdaptStop: a.stop } }, el('p', {}, a.message)));
  if (eig) { eigResults(host, b, a, eig); return; }
  const head = [t('sim.adapt.pass'), t('sim.adapt.elements'), t('sim.adapt.unknowns'), t('sim.adapt.error'), heat ? t('study.adapt.max_t') : t('study.adapt.peak_stress'), heat ? t('study.adapt.max_flux') : t('study.adapt.max_disp')];
  const table = el('table', { className: 'pc-sim-table', dataset: { simAdaptTable: String(a.passes.length) } },
    el('thead', {}, el('tr', {}, ...head.map((x) => el('th', { scope: 'col' }, x)))),
    el('tbody', {}, ...a.passes.map((p) => el('tr', { className: p.pass === a.passes.length ? 'is-sel' : '' },
      el('td', {}, String(p.pass)), el('td', {}, fmtN(p.elements)), el('td', {}, fmtN(p.dofs)), el('td', { dataset: { simAdaptErr: String(p.errorPct) } }, U.sig(p.errorPct)),
      el('td', {}, U.sig(heat ? p.maxT : p.maxVm)), el('td', {}, U.sig(heat ? p.maxFlux * 1e6 : p.maxDisp))))));
  b.append(el('div', { className: 'pc-sim-scroll' }, table));
  b.append(el('p', { className: 'pc-note' }, heat ? t('study.adapt.units_thermal') : t('study.adapt.units_static')));
  if (a.passes.length > 1) {
    const cv = el('canvas', { width: 560, height: 260, className: 'pc-flow-res', role: 'img', 'aria-label': t('study.adapt.chart'), dataset: { simAdaptChart: '1' } });
    cv.style.setProperty('width', '100%');
    b.append(cv);
    draw(host, cv, a, heat);
    // once on the page: redrawn at its displayed size (crisp text at the panel's width)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { const w = cv.clientWidth; if (w > 0) { const r = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1; cv.width = Math.round(w * r); cv.height = Math.round(240 * r); cv.style.setProperty('height', '240px'); draw(host, cv, a, heat, r); } });
  }
  b.append(el('p', { className: 'pc-note' }, t('study.adapt.how')));
}

/** Modal / buckling convergence (0.4 P5): the first two frequencies or load factors per pass, the chart on the first. */
function eigResults(host, b, a, kind) {
  const { el } = host, vals = (p) => (kind === 'modal' ? p.freqs : p.factors) || [], two = a.passes.some((p) => vals(p).length > 1);
  const head = [t('sim.adapt.pass'), t('sim.adapt.elements'), t('sim.adapt.unknowns'), t('sim.adapt.error'), t(`sim.adapt.${kind}.first`), ...(two ? [t(`sim.adapt.${kind}.second`)] : [])];
  const table = el('table', { className: 'pc-sim-table', dataset: { simAdaptTable: String(a.passes.length) } },
    el('thead', {}, el('tr', {}, ...head.map((x) => el('th', { scope: 'col' }, x)))),
    el('tbody', {}, ...a.passes.map((p) => el('tr', { className: p.pass === a.passes.length ? 'is-sel' : '' },
      el('td', {}, String(p.pass)), el('td', {}, fmtN(p.elements)), el('td', {}, fmtN(p.dofs)), el('td', { dataset: { simAdaptErr: String(p.errorPct) } }, U.sig(p.errorPct)),
      el('td', { dataset: { simAdaptVal: String(vals(p)[0] ?? '') } }, vals(p).length ? U.sig(vals(p)[0]) : '—'), ...(two ? [el('td', {}, vals(p).length > 1 ? U.sig(vals(p)[1]) : '—')] : [])))));
  b.append(el('div', { className: 'pc-sim-scroll' }, table));
  b.append(el('p', { className: 'pc-note' }, t(`sim.adapt.${kind}.units`)));
  if (a.passes.length > 1) {
    const cv = el('canvas', { width: 560, height: 260, className: 'pc-flow-res', role: 'img', 'aria-label': t(`sim.adapt.${kind}.chart`), dataset: { simAdaptChart: '1' } });
    cv.style.setProperty('width', '100%');
    b.append(cv);
    const series = { title: t(`sim.adapt.${kind}.first`), vals: a.passes.map((p) => vals(p)[0] ?? NaN) };
    draw(host, cv, a, false, 1, series);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { const w = cv.clientWidth; if (w > 0) { const r = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1; cv.width = Math.round(w * r); cv.height = Math.round(240 * r); cv.style.setProperty('height', '240px'); draw(host, cv, a, false, r, series); } });
  }
  b.append(el('p', { className: 'pc-note' }, t(`sim.adapt.${kind}.how`)));
}

/** Two stacked charts on one canvas (no shared y-scale): estimated error % (log) and the peak value, against unknowns (log).
 *  series { title, vals } replaces the peak value (modal / buckling). */
function draw(host, cv, a, heat, scale = 1, series = null) {
  const g = cv.getContext && cv.getContext('2d');
  if (!g) return;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const T = host.tokens(), W = cv.width / scale, H = cv.height / scale, pad = { l: 46, r: 10, t: 18, b: 22 }, gap = 28, ph = (H - pad.t - pad.b - gap) / 2;
  g.clearRect(0, 0, W, H);
  g.font = `11px ${T.font}`;
  const P = a.passes, xs = P.map((p) => Math.log10(p.dofs)), x0 = Math.min(...xs), x1 = Math.max(...xs) + 1e-9;
  const X = (v) => pad.l + (W - pad.l - pad.r) * (v - x0) / (x1 - x0 || 1);
  const panel = (top, title, vals, log, ref) => {
    const ys = vals.map((v) => (log ? Math.log10(Math.max(v, 1e-12)) : v)), all = ref !== null ? [...ys, log ? Math.log10(ref) : ref] : ys;
    let lo = Math.min(...all), hi = Math.max(...all); if (!(hi > lo)) { lo -= 0.5; hi += 0.5; } const m = (hi - lo) * 0.08; lo -= m; hi += m;
    const Y = (v) => top + ph * (hi - v) / (hi - lo);
    g.strokeStyle = T.axis; g.lineWidth = 1; g.strokeRect(pad.l, top, W - pad.l - pad.r, ph);
    g.fillStyle = T.cons; g.fillText(title, pad.l, top - 5);
    const lab = (v) => (log ? U.sig(10 ** v) : U.sig(v));
    g.fillText(lab(hi - m), 4, top + 10); g.fillText(lab(lo + m), 4, top + ph - 2);
    if (ref !== null) { g.strokeStyle = T.over; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(pad.l, Y(log ? Math.log10(ref) : ref)); g.lineTo(W - pad.r, Y(log ? Math.log10(ref) : ref)); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = T.under; g.fillStyle = T.under; g.lineWidth = 2; g.beginPath();
    ys.forEach((y, i) => { if (i) g.lineTo(X(xs[i]), Y(y)); else g.moveTo(X(xs[i]), Y(y)); }); g.stroke();
    ys.forEach((y, i) => { g.beginPath(); g.arc(X(xs[i]), Y(y), 4, 0, 2 * Math.PI); g.fill(); });
  };
  panel(pad.t, t('study.adapt.chart_error', { target: a.target }), P.map((p) => p.errorPct), true, a.target);
  panel(pad.t + ph + gap, series ? series.title : heat ? t('study.adapt.chart_max_t') : t('study.adapt.chart_peak_vm'), series ? series.vals : P.map((p) => (heat ? p.maxT : p.maxVm)), false, null);
  g.fillStyle = T.cons; g.fillText(t('study.adapt.chart_x', { lo: fmtN(P[0].dofs), hi: fmtN(P[P.length - 1].dofs) }), pad.l, H - 6);
}

/** A table row for the mesh report: faces on their exact surface vs following the tessellation (tetmesh faceCounts). */
export function exactRow(s, add) {
  if (s.mesher !== 'tet' || s.exactFaces === undefined) return;
  add(t('study.adapt.exact'), s.tessFaces ? t('study.adapt.exact_some', { exact: s.exactFaces, tess: s.tessFaces, types: (s.tessTypes || []).join(', ') || t('study.adapt.no_exact_form') }) : t('study.adapt.exact_all', { n: s.exactFaces }), { simExactFaces: String(s.exactFaces), simTessFaces: String(s.tessFaces) });
}
