/* SPDX-License-Identifier: Apache-2.0 */
/**
 * flow-ui.js — the Flow study kind in the Simulation workspace (incompressible, isothermal, Newtonian; laminar or turbulent
 * by steady RANS with the Spalart–Allmaras model and wall functions; flow.js, flow-turb.js).
 * `withFlow(def)` wraps ws-simulation.js's workspace definition: while the study's kind is 'flow' its hooks run here
 * (panel, picking faces for inlets/outlets, Solve in a compute worker with progress, residual plot and Stop, results as a
 * movable cut plane of speed or pressure, streamlines, surface pressure on the part, a hover probe and a table);
 * otherwise the structural hooks run as before and the flow overlays are cleared.
 * Top level is DOM-free (Node imports it); the page is reached only inside hooks, through `host`.
 */
import { readSimStudy, findFaceIndex } from './sim.js';
import { newFlow, flowJob, FLUIDS, fluidOf, openingName, describeOpening, cellEstimate, autoCell, FLOW_LIMITS, FLOW_MODELS, turbWarning, ROLE_LABEL, boxOf, liftDir } from './flow-study.js';
import { streamlines, slice } from './flow.js';
import { faceRef } from './brep.js';
import * as U from './sim-ui.js';
import { STUDY_KINDS } from './sim-thermal-ui.js';
import { threadWords } from './pool.js';
import { exactWhy } from './exact-client.js';
import { t } from './i18n.js';

export const KINDS = [...STUDY_KINDS, Object.defineProperty(['flow', ''], 1, { get: () => t('study.flow.ui.kind'), enumerable: true })];   // label read when shown
const KEY = 'simulation', OV = 'simulation-flow-';
const F = { result: null, resultMesh: null, busy: false, prog: null, live: [], worker: null, error: null, req: 0, sel: null, picking: false,
  show: 'speed', plane: true, axis: 2, at: null, look: 'solid', streams: true, nStreams: 40, progressEl: null, probeEl: null, canvasEl: null, onMove: null, wasFlow: false };
export const isFlow = (host) => { const st = host.study(KEY); return !!(st && st.kind === 'flow'); };
const study = (host) => host.study(KEY);
const flowOf = (host) => (study(host) && study(host).flow) || newFlow();
const fresh = (host) => !!(F.result && host.regen && F.resultMesh === host.regen.mesh);
const AXES = [['x', '+X', [1, 0, 0]], ['-x', '−X', [-1, 0, 0]], ['y', '+Y', [0, 1, 0]], ['-y', '−Y', [0, -1, 0]], ['z', '+Z', [0, 0, 1]], ['-z', '−Z', [0, 0, -1]]];
const axisKey = (d) => { const l = Math.hypot(...d); const a = AXES.find(([, , v]) => v.every((c, i) => Math.abs(c - d[i] / l) < 1e-9)); return a ? a[0] : 'custom'; };
const ROLE_COLOR = { inlet: '#2f6fd6', outlet: '#c0392b' };

/** One undo step on the study's flow block (fn(flow, study) edits a copy; return false to cancel). */
function edit(host, label, fn) {
  const s = JSON.parse(JSON.stringify(study(host)));
  s.flow = s.flow || newFlow();
  if (fn(s.flow, s) === false) return null;
  host.setStudy(KEY, readSimStudy(s), label);
  return s.flow;
}
const opOf = (fl, id) => fl.openings.find((o) => o.id === id) || null;

// ---------------------------------------------------------------- solving

async function solve(host) {
  const st = study(host);
  if (!st || F.busy) return;
  const { job, problems } = flowJob(st, host.regen);
  if (!job || problems.length) { host.status(problems[0] || t('study.flow.ui.nothing')); host.renderPanel(); return; }
  job.limit = FLOW_LIMITS.fluidCells;
  const id = ++F.req, mesh = host.regen.mesh;
  F.busy = true; F.prog = { f: 0, phase: 'mesh' }; F.live = []; F.error = null; F.picking = false;
  host.renderPanel();
  host.status(t('study.flow.ui.solving'), true);
  try {
    F.worker = F.worker || host.computeWorker(['flow-worker.js'], { name: 'PartCraft flow', threads: true });
    const tr = [job.mesh.positions.buffer, job.mesh.indices.buffer]; if (job.mesh.triFace) tr.push(job.mesh.triFace.buffer);
    const r = await F.worker.call('flowSolve', job, { transfer: tr, onProgress: (v) => { if (id !== F.req) return; F.prog = v; if (v && v.step) F.live.push([v.step, v.res]); paintProgress(host); } });
    if (id !== F.req) return;
    F.result = r; F.resultMesh = mesh;
    const fl = flowOf(host);
    F.axis = fl.type === 'external' ? planeAxisExternal(r) : thinAxis(r.fields);
    F.at = null; F.look = fl.type === 'internal' ? 'ghost' : 'solid';
    host.status(summaryText(r));
  } catch (e) {
    if (id !== F.req) return;
    const msg = e && e.message ? e.message : String(e);
    F.error = msg === 'Stopped.' ? null : msg;
    host.status(msg === 'Stopped.' ? t('study.flow.ui.stopped') : t('study.flow.ui.error', { msg }), msg !== 'Stopped.');
  } finally {
    if (id === F.req) { F.busy = false; plot(host); host.renderAll(); }
  }
}
function stop(host) {
  if (!F.busy) return;
  F.req++;
  if (F.worker) { F.worker.terminate(); F.worker = null; }
  F.busy = false;
  host.status(t('study.flow.ui.stopped'));
  host.renderAll();
}
function summaryText(r) {
  const head = t('study.flow.ui.sum.' + (r.converged ? 'solved' : 'not_conv') + (r.model === 'sa' ? '_sa' : ''));
  const main = r.type === 'external' ? t('study.flow.ui.sum.drag', { drag: U.sig(r.ext.drag), cd: U.sig(r.ext.cd) }) : t('study.flow.ui.sum.dp', { dp: U.sig(r.dp) });
  return t('study.flow.ui.sum.line', { head, main, re: U.sig(r.Re), cells: r.mesh.fluid.toLocaleString('en-US'), steps: r.steps.toLocaleString('en-US'), s: (r.ms / 1000).toFixed(1) });
}
function progressText() {
  const p = F.prog || {};
  if (p.phase === 'mesh' || !p.phase) return t('study.flow.ui.prog.mesh');
  if (p.phase === 'results') return t('study.flow.ui.prog.results');
  return t('study.flow.ui.prog.step', { step: (p.step || 0).toLocaleString('en-US'), res: Number.isFinite(p.res) ? p.res.toExponential(1) : '…', tol: flowTol.v.toExponential(0), pct: Math.round(100 * (p.f || 0)) });
}
const flowTol = { v: 1e-6 };
function paintProgress(host) {
  if (F.progressEl) F.progressEl.textContent = progressText();
  if (F.canvasEl) drawResiduals(host, F.canvasEl, F.live, flowTol.v, null);
}

// ---------------------------------------------------------------- residual plot (canvas)

function drawResiduals(host, cv, hist, tol, converged) {
  const g = cv.getContext && cv.getContext('2d');
  if (!g) return;
  const T = host.tokens(), W = cv.width, H = cv.height, pad = { l: 44, r: 8, t: 8, b: 20 };
  g.clearRect(0, 0, W, H);
  g.font = `11px ${T.font}`;
  g.strokeStyle = T.axis; g.fillStyle = T.cons; g.lineWidth = 1;
  g.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);
  const pts = hist.filter(([, r]) => r > 0 && Number.isFinite(r));
  if (!pts.length) { g.fillText(t('study.flow.ui.plot.empty'), pad.l + 6, pad.t + 14); return; }
  const smax = Math.max(pts[pts.length - 1][0], 1), lo = Math.floor(Math.min(Math.log10(tol), ...pts.map(([, r]) => Math.log10(r)))), hi = Math.ceil(Math.max(...pts.map(([, r]) => Math.log10(r))));
  const X = (s) => pad.l + (W - pad.l - pad.r) * s / smax, Y = (l) => pad.t + (H - pad.t - pad.b) * (hi - l) / Math.max(1, hi - lo);
  for (let e = lo; e <= hi; e++) { g.fillText(`1e${e}`, 4, Y(e) + 4); }
  g.fillText(t('study.flow.ui.plot.steps', { n: smax.toLocaleString('en-US') }), W - pad.r - 80, H - 5);
  g.strokeStyle = T.over; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(pad.l, Y(Math.log10(tol))); g.lineTo(W - pad.r, Y(Math.log10(tol))); g.stroke(); g.setLineDash([]);
  g.strokeStyle = converged === false ? T.over : T.under; g.lineWidth = 1.5; g.beginPath();
  pts.forEach(([s, r], i) => { const x = X(s), y = Y(Math.log10(r)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
}

// ---------------------------------------------------------------- plots in the view

function fluidBox(Fd) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < Fd.nz; k++) for (let j = 0; j < Fd.ny; j++) for (let i = 0; i < Fd.nx; i++) if (Fd.mask[i + Fd.nx * (j + Fd.ny * k)] === 1) { const c = [i, j, k]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], c[a]); hi[a] = Math.max(hi[a], c[a] + 1); } }
  return { min: lo.map((v, a) => Fd.origin[a] + v * Fd.h), max: hi.map((v, a) => Fd.origin[a] + v * Fd.h) };
}
function thinAxis(Fd) { const b = fluidBox(Fd), s = [0, 1, 2].map((a) => b.max[a] - b.min[a]); return [0, 1, 2].reduce((m, a) => (s[a] < s[m] ? a : m), 0); }
function planeAxisExternal(r) { const d = r.ext.dir, l = r.ext.liftDir, n = [d[1] * l[2] - d[2] * l[1], d[2] * l[0] - d[0] * l[2], d[0] * l[1] - d[1] * l[0]]; return [0, 1, 2].reduce((m, a) => (Math.abs(n[a]) > Math.abs(n[m]) ? a : m), 0); }
function planeAt(host) {
  const Fd = F.result.fields, b = fluidBox(Fd);
  if (F.at === null || F.at < b.min[F.axis] || F.at > b.max[F.axis]) F.at = (b.min[F.axis] + b.max[F.axis]) / 2;
  return { lo: b.min[F.axis], hi: b.max[F.axis], at: F.at };
}
function fieldOf(show) {
  const r = F.result, Fd = r.fields;
  if (show === 'pressure') return { values: Fd.p, lo: r.pmin, hi: r.pmax, unit: 'Pa', title: t('study.flow.ui.field.pressure') };
  if (show === 'nut' && Fd.nut) { let hi = 0; for (let e = 0; e < Fd.nut.length; e++) if (Fd.mask[e] === 1 && Fd.nut[e] > hi) hi = Fd.nut[e]; return { values: Fd.nut, lo: 0, hi: hi || 1, unit: '× ν', title: t('study.flow.ui.field.nut') }; }
  const n = Fd.mask.length, s = new Float32Array(n);
  for (let e = 0; e < n; e++) s[e] = Fd.mask[e] === 1 ? Math.hypot(Fd.vx[e], Fd.vy[e], Fd.vz[e]) : NaN;
  return { values: s, lo: 0, hi: r.vmax || 1, unit: 'm/s', title: t('study.flow.ui.field.speed') };
}
let speedCache = null;
function values(show) {
  if (show === 'speed') { if (!speedCache || speedCache.r !== F.result) speedCache = { r: F.result, f: fieldOf('speed') }; return speedCache.f; }
  return fieldOf(show === 'nut' && F.result.fields.nut ? 'nut' : 'pressure');
}

function clearOverlays(host) {
  for (const k of ['plane', 'surface', 'ghost', 'streams', 'markers']) host.view.setOverlay(OV + k, null);
}
function plot(host) {
  const { view, THREE } = host;
  for (const k of ['plane', 'surface', 'ghost', 'streams']) view.setOverlay(OV + k, null);
  if (!fresh(host)) { view.setPartVisible(true); return; }
  const r = F.result, Fd = r.fields, pm = r.plotMesh;
  view.setPartVisible(F.look === 'solid' || F.look === 'pressure');
  if (F.look === 'ghost' || F.look === 'pressure') {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pm.positions), 3));
    geo.setIndex(new THREE.BufferAttribute(pm.indices, 1));
    geo.computeVertexNormals();
    if (F.look === 'pressure') {
      const col = new Float32Array(r.surfP.length * 3), span = r.pmax - r.pmin || 1;
      for (let v = 0; v < r.surfP.length; v++) { const x = r.surfP[v], c = Number.isFinite(x) ? U.colormap((x - r.pmin) / span) : [0.62, 0.62, 0.62]; col.set(c, 3 * v); }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.userData.flowPlot = 'surface';
      view.setOverlay(OV + 'surface', m);
    } else {
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8a96a3, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = 30;
      view.setOverlay(OV + 'ghost', m);
    }
  }
  if (F.plane) {
    const pa = planeAt(host), f = values(F.show), s = slice(Fd, f.values, F.axis, pa.at);
    const data = new Uint8Array(s.w * s.hgt * 4), span = f.hi - f.lo || 1;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      const c = U.colormap((v - f.lo) / span);
      data[4 * i] = Math.round(255 * c[0]); data[4 * i + 1] = Math.round(255 * c[1]); data[4 * i + 2] = Math.round(255 * c[2]); data[4 * i + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, s.w, s.hgt, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
    const [a, b] = s.axes, corner = (ua, vb) => { const p = [0, 0, 0]; p[F.axis] = s.at; p[a] = s.origin[0] + ua * s.w * s.h; p[b] = s.origin[1] + vb * s.hgt * s.h; return p; };
    const P = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)].flat();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
    m.userData.flowPlot = 'plane'; m.userData.slice = s;
    view.setOverlay(OV + 'plane', m);
  }
  if (F.streams) {
    const lines = streamlines(Fd, seeds(host), { ds: 0.4, maxSteps: 4000 });
    const pos = [], col = [], vmax = r.vmax || 1;
    for (const L of lines) for (let i = 0; i + 1 < L.speed.length; i++) {
      pos.push(L.points[3 * i], L.points[3 * i + 1], L.points[3 * i + 2], L.points[3 * i + 3], L.points[3 * i + 4], L.points[3 * i + 5]);
      col.push(...U.colormap(L.speed[i] / vmax), ...U.colormap(L.speed[i + 1] / vmax));
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(col), 3));
      const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
      m.renderOrder = 25; m.userData.flowLines = lines.length;
      view.setOverlay(OV + 'streams', m);
    }
  }
}

/** Streamline seeds: spread over the inlets (internal), or a rake across the inflow end of the domain in the cut plane (external). */
function seeds(host) {
  const r = F.result, Fd = r.fields, n = F.nStreams, out = [];
  const cc = (e) => { const i = e % Fd.nx, j = Math.floor(e / Fd.nx) % Fd.ny, k = Math.floor(e / (Fd.nx * Fd.ny)); return [Fd.origin[0] + (i + 0.5) * Fd.h, Fd.origin[1] + (j + 0.5) * Fd.h, Fd.origin[2] + (k + 0.5) * Fd.h]; };
  if (r.type === 'internal') {
    const list = r.inletCells || [];
    if (!list.length) return out;
    // farthest-point spread over the inlet cells
    const pts = Array.from(list, cc);
    const pick = [pts[0]], d = pts.map((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]));
    while (pick.length < Math.min(n, pts.length)) { let bi = 0; for (let i = 1; i < pts.length; i++) if (d[i] > d[bi]) bi = i; if (d[bi] <= 0) break; pick.push(pts[bi]); for (let i = 0; i < pts.length; i++) d[i] = Math.min(d[i], Math.hypot(pts[i][0] - pts[bi][0], pts[i][1] - pts[bi][1], pts[i][2] - pts[bi][2])); }
    return pick;
  }
  const dir = r.ext.dir, fa = [0, 1, 2].reduce((m, a) => (Math.abs(dir[a]) > Math.abs(dir[m]) ? a : m), 0), b = fluidBox(Fd);
  const along = Math.sign(dir[fa]) > 0 ? b.min[fa] + 1.5 * Fd.h : b.max[fa] - 1.5 * Fd.h;
  const pa = planeAt(host), spread = [0, 1, 2].find((a) => a !== fa && a !== F.axis) ?? [0, 1, 2].find((a) => a !== fa);
  const fixed = [0, 1, 2].find((a) => a !== fa && a !== spread);
  for (let s = 0; s < n; s++) {
    const p = [0, 0, 0]; p[fa] = along; p[spread] = b.min[spread] + (s + 0.5) / n * (b.max[spread] - b.min[spread]);
    p[fixed] = fixed === F.axis ? pa.at : (b.min[fixed] + b.max[fixed]) / 2;
    out.push(p);
  }
  return out;
}

function probe(host, ev) {
  if (!F.probeEl || !fresh(host) || !ev) return;
  const objs = ['plane', 'surface'].map((k) => host.view.overlays && host.view.overlays.get(OV + k)).filter(Boolean);
  const hit = objs.length ? host.view.ray(ev.clientX, ev.clientY).intersectObjects(objs, false)[0] : null;
  if (!hit) { F.probeEl.textContent = t('study.flow.ui.probe.hint'); return; }
  const r = F.result, Fd = r.fields, p = hit.point.toArray(), at = p.map((v) => U.fmt(v, 2)).join(', ');
  if (hit.object.userData.flowPlot === 'plane') {
    const ijk = [0, 1, 2].map((a) => Math.min([Fd.nx, Fd.ny, Fd.nz][a] - 1, Math.max(0, Math.floor((p[a] - Fd.origin[a]) / Fd.h))));
    const e = ijk[0] + Fd.nx * (ijk[1] + Fd.ny * ijk[2]);
    if (Fd.mask[e] !== 1) { F.probeEl.textContent = t('study.flow.ui.probe.not_fluid', { at }); return; }
    F.probeEl.textContent = t('study.flow.ui.probe.cell', { speed: U.sig(Math.hypot(Fd.vx[e], Fd.vy[e], Fd.vz[e])), v: [Fd.vx[e], Fd.vy[e], Fd.vz[e]].map((v) => U.sig(v)).join(', '), p: U.sig(Fd.p[e]), at });
    return;
  }
  const v = U.valueAt(r.plotMesh, r.surfP, hit.faceIndex, p);
  F.probeEl.textContent = Number.isFinite(v) ? t('study.flow.ui.probe.surface', { p: U.sig(v), at }) : t('study.flow.ui.probe.dry', { at });
}

// ---------------------------------------------------------------- markers

function markers(host) {
  const { view, THREE } = host, rg = host.regen, fl = flowOf(host);
  view.setOverlay(OV + 'markers', null);
  view.setOverlay('simulation-markers', null);
  if (!rg || !rg.mesh || !rg.faces || !rg.stats) return;
  const grp = new THREE.Group(), P = rg.mesh.positions, I = rg.mesh.indices, tf = rg.mesh.triFace;
  if (fl.type === 'internal' && tf) for (const o of fl.openings) {
    const want = new Set(o.faces.map((f) => findFaceIndex(rg.faces, f)).filter((i) => i >= 0)), pos = [];
    for (let t = 0; t < tf.length; t++) if (want.has(tf[t])) for (let k = 0; k < 3; k++) { const v = 3 * I[3 * t + k]; pos.push(P[v], P[v + 1], P[v + 2]); }
    if (!pos.length) continue;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: ROLE_COLOR[o.role], transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    m.renderOrder = 15; grp.add(m);
  }
  if (fl.type === 'external') {
    const bb = rg.stats.bbox, h = fl.h || autoCell(fl, bb), b = boxOf(fl.ext, bb), d = fl.ext.dir.map((v) => v / Math.hypot(...fl.ext.dir));
    const ax = [0, 1, 2].reduce((m, a) => (Math.abs(d[a]) > Math.abs(d[m]) ? a : m), 0), s = Math.sign(d[ax]) || 1, pad = (v) => Math.max(1, Math.ceil(v / h - 1e-9)) * h;
    const lo = [0, 1, 2].map((a) => bb.min[a] - pad(a === ax ? (s > 0 ? b.up : b.down) : b.side)), hi = [0, 1, 2].map((a) => bb.max[a] + pad(a === ax ? (s > 0 ? b.down : b.up) : b.side));
    const box = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
    const helper = new THREE.Box3Helper(box, new THREE.Color(ROLE_COLOR.inlet)); grp.add(helper);
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2), L = Math.max(...[0, 1, 2].map((a) => bb.max[a] - bb.min[a])) * 0.6;
    const start = c.slice(); start[ax] = s > 0 ? lo[ax] : hi[ax];
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(...start), L, ROLE_COLOR.inlet, L * 0.25, L * 0.12); arrow.renderOrder = 20; grp.add(arrow);
  }
  view.setOverlay(OV + 'markers', grp);
  const sel = opOf(fl, F.sel);
  view.setMarks(sel ? { faces: sel.faces.map((f) => findFaceIndex(rg.faces, f)).filter((i) => i >= 0) } : null);
}

// ---------------------------------------------------------------- panel

function renderPanel(host, box) {
  const { el } = host, K = U.kit(host), st = study(host), fl = flowOf(host), rg = host.regen;
  F.progressEl = null; F.probeEl = null; F.canvasEl = null;
  flowTol.v = fl.tol;
  const set = (label, fn) => edit(host, label, fn);
  const fluid = fluidOf(fl.fluid);
  const g = el('div', { className: 'pc-props' },
    el('p', { className: 'pc-props-sub' }, t('study.flow.ui.panel.study')),
    ...K.field(t('study.flow.ui.panel.type'), K.sel(KINDS, st.kind, (v) => { const s = JSON.parse(JSON.stringify(st)); s.kind = v; host.setStudy(KEY, readSimStudy(s), t('study.flow.ui.undo.study_type')); }, { simKind: '1' })),
    ...K.field(t('study.flow.ui.panel.flow'), K.sel([['internal', t('study.flow.ui.panel.internal')], ['external', t('study.flow.ui.panel.external')]], fl.type, (v) => set(t('study.flow.ui.undo.flow_type'), (f) => { f.type = v; }), { flowType: '1' })),
    ...K.field(t('study.flow.ui.panel.fluid'), K.sel([...FLUIDS.map((x) => [x.id, x.name]), ['custom', typeof fl.fluid === 'object' ? fl.fluid.name : t('study.flow.ui.panel.custom')]], typeof fl.fluid === 'string' ? fl.fluid : 'custom', (v) => set(t('study.flow.ui.panel.fluid'), (f) => { f.fluid = v === 'custom' ? { name: t('study.flow.fluid.custom_name'), density: fluid.density, viscosity: fluid.viscosity } : v; }), { flowFluid: '1' })));
  if (typeof fl.fluid === 'object') g.append(
    ...K.field(t('study.flow.ui.panel.density'), K.num(fl.fluid.density, (v) => set(t('study.flow.ui.undo.density'), (f) => { f.fluid.density = v; }), { min: 0.01, max: 30000, data: { flowDensity: '1' } })),
    ...K.field(t('study.flow.ui.panel.viscosity'), K.num(fl.fluid.viscosity, (v) => set(t('study.flow.ui.undo.viscosity'), (f) => { f.fluid.viscosity = v; }), { min: 1e-7, max: 100, data: { flowViscosity: '1' } })));
  g.append(el('span', { className: 'k' }, t('study.flow.ui.panel.properties')), el('span', { className: 'v' }, t('study.flow.ui.panel.props', { rho: U.sig(fluid.density), mu: U.sig(fluid.viscosity), nu: U.sig(fluid.viscosity / fluid.density * 1e6) })));
  g.append(...K.field(t('study.flow.ui.panel.model'), K.sel(FLOW_MODELS, fl.model || 'laminar', (v) => set(t('study.flow.ui.panel.model'), (f) => { f.model = v; }), { flowModel: '1' })));
  if (fl.model === 'sa') g.append(turbBanner(el, 'panel'), el('p', { className: 'pc-note span', dataset: { flowTurbNote: '1' } }, t('study.flow.ui.panel.turb_note', { cost: t('study.flow.ui.turb_cost') })));
  g.append(...K.field(t('study.flow.ui.panel.cell'), K.num(fl.h, (v) => set(t('study.flow.ui.undo.cell'), (f) => { f.h = v; }), { min: 0.005, max: 1000, nullable: true, data: { flowSize: '1' } })));
  if (rg && rg.stats) {
    const h = fl.h || autoCell(fl, rg.stats.bbox), e = cellEstimate(fl, rg.stats.bbox, h), over = e.cells > FLOW_LIMITS.gridCells;
    g.append(el('span', { className: 'k' }, t('study.flow.ui.panel.grid_label')), el('span', { className: 'v' + (over ? ' is-bad' : ''), dataset: { flowEstimate: String(e.cells) } }, t(fl.h ? 'study.flow.ui.panel.grid' : 'study.flow.ui.panel.grid_auto', { h: U.fmt(h), nx: e.nx, ny: e.ny, nz: e.nz, cells: e.cells.toLocaleString('en-US'), max: FLOW_LIMITS.fluidCells.toLocaleString('en-US') })));
    if (fl.model === 'sa') { const sec = e.cells * fl.maxSteps / 4.5e6; g.append(el('span', { className: 'k' }, t('study.flow.ui.panel.runtime')), el('span', { className: 'v', dataset: { flowRuntime: String(Math.round(sec)) } }, t(sec < 90 ? 'study.flow.ui.panel.runtime_s' : 'study.flow.ui.panel.runtime_min', { n: sec < 90 ? Math.max(1, Math.round(sec)) : Math.round(sec / 60), cells: e.cells.toLocaleString('en-US'), steps: fl.maxSteps.toLocaleString('en-US') }))); }
  }
  g.append(...K.field(t('study.flow.ui.panel.walls'), K.sel([['interpolated', t('study.flow.ui.panel.wall_interp')], ['bounce', t('study.flow.ui.panel.wall_bounce')]], fl.wall, (v) => set(t('study.flow.ui.undo.wall'), (f) => { f.wall = v; }), { flowWall: '1' })));
  box.append(el('div', { className: 'pc-block' }, g));
  if (fl.type === 'internal') renderOpenings(host, box, K, fl, set);
  else renderExternal(host, box, K, fl, set);
  // solve
  const sb = el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub' }, t('study.flow.ui.panel.solve_head')));
  const sg = el('div', { className: 'pc-props' },
    ...K.field(t('study.flow.ui.panel.steps'), K.num(fl.maxSteps, (v) => { if (!Number.isInteger(v)) { host.status(t('study.flow.ui.panel.steps_whole')); return; } set(t('study.flow.ui.panel.steps'), (f) => { f.maxSteps = v; }); }, { min: 100, max: 1e6, data: { flowSteps: '1' } })),
    ...K.field(t('study.flow.ui.panel.tol'), K.num(fl.tol, (v) => set(t('study.flow.ui.undo.tol'), (f) => { f.tol = v; }), { min: 1e-12, max: 1e-2, data: { flowTol: '1' } })));
  sb.append(sg);
  const { problems } = flowJob(st, rg, { check: true });
  for (const p of F.busy ? [] : problems) sb.append(el('div', { className: 'pc-msg' }, el('p', {}, p)));
  if (F.error) sb.append(el('div', { className: 'pc-msg is-error', dataset: { flowError: '1' } }, el('p', {}, F.error)));
  sb.append(el('div', { className: 'pc-actions' },
    K.btn(t('study.flow.ui.btn.solve'), () => solve(host), 'pc-btn is-primary', { disabled: F.busy || problems.length > 0, dataset: { flowSolve: '1' } }),
    K.btn(t('study.flow.ui.btn.stop'), () => stop(host), 'pc-btn', { disabled: !F.busy, dataset: { flowStop: '1' } })));
  if (F.busy) {
    F.progressEl = el('p', { className: 'pc-note', dataset: { flowProgress: '1' }, role: 'status' }, progressText());
    F.canvasEl = el('canvas', { width: 560, height: 150, className: 'pc-flow-res', 'aria-label': t('study.flow.ui.res_history'), dataset: { flowResiduals: '1' } });
    F.canvasEl.style.setProperty('width', '100%');
    sb.append(F.progressEl, F.canvasEl);
    drawResiduals(host, F.canvasEl, F.live, fl.tol, null);
  }
  box.append(sb);
  if (F.result) renderResults(host, box, K);
  box.append(el('div', { className: 'pc-block' }, el('p', { className: 'pc-note', dataset: { flowMethod: fl.model || 'laminar' } }, t(fl.model === 'sa' ? 'study.flow.ui.method_turb' : 'study.flow.ui.method_laminar'))));
  markers(host);
  return t('study.flow.ui.panel.title');
}

function renderOpenings(host, box, K, fl, set) {
  const { el } = host, rg = host.regen;
  let addRole = 'inlet';
  box.append(el('div', { className: 'pc-block' },
    el('p', { className: 'pc-note' }, t('study.flow.ui.open.note')),
    el('div', { className: 'pc-actions' },
      K.sel([['inlet', ROLE_LABEL.inlet], ['outlet', ROLE_LABEL.outlet]], addRole, (v) => { addRole = v; }, { flowAddRole: '1' }),
      K.btn(t('study.flow.ui.btn.add'), () => addOpening(host, addRole), 'pc-btn', { dataset: { flowAdd: '1' } }))));
  const list = el('div', { className: 'pc-list', role: 'listbox', 'aria-label': t('study.flow.ui.open.list') });
  for (const o of fl.openings) {
    const missing = rg && rg.faces ? o.faces.filter((f) => findFaceIndex(rg.faces, f) < 0).length : 0;
    const flag = !o.faces.length ? t('study.flow.ui.open.no_faces') : missing ? t('study.flow.ui.open.gone', { n: missing }) : t('study.flow.ui.open.faces', { n: o.faces.length });
    list.append(el('button', { type: 'button', className: 'pc-node' + (missing || !o.faces.length ? ' is-warn' : ''), role: 'option', 'aria-selected': String(F.sel === o.id), dataset: { flowItem: o.id }, onclick: () => { F.sel = o.id; F.picking = false; host.renderPanel(); } },
      // i18n-ignore: icon class names
      el('i', { className: 'bi bi-' + (o.role === 'inlet' ? 'box-arrow-in-right' : 'box-arrow-right'), 'aria-hidden': 'true' }), el('span', { className: 'pc-node-name' }, openingName(o)), el('span', { className: 'pc-node-flag' }, flag)));
  }
  if (!fl.openings.length) list.append(el('p', { className: 'pc-note' }, t('study.flow.ui.open.none')));
  box.append(el('div', { className: 'pc-block' }, list));
  const o = opOf(fl, F.sel);
  if (!o) return;
  const seto = (label, fn) => set(label, (f) => fn(opOf(f, o.id)));
  const g = el('div', { className: 'pc-props' }, el('p', { className: 'pc-props-sub' }, openingName(o)),
    ...K.field(t('study.flow.ui.open.role'), K.sel([['inlet', ROLE_LABEL.inlet], ['outlet', ROLE_LABEL.outlet]], o.role, (v) => seto(t('study.flow.ui.undo.role'), (x) => { x.role = v; if (v === 'inlet') { x.spec = x.spec || 'velocity'; x.value = x.value || 0.01; delete x.p; } else { x.p = x.p ?? 0; delete x.spec; delete x.value; } }), { flowRole: '1' })));
  if (o.role === 'inlet') {
    g.append(...K.field(t('study.flow.ui.open.set'), K.sel([['velocity', t('study.flow.ui.open.velocity')], ['flow', t('study.flow.ui.open.volume')]], o.spec, (v) => seto(t('study.flow.ui.undo.inlet_kind'), (x) => { x.spec = v; x.value = v === 'velocity' ? 0.01 : 1 / 60000; }), { flowSpec: '1' })));
    if (o.spec === 'velocity') g.append(...K.field(t('study.flow.ui.open.velocity'), K.num(o.value, (v) => seto(t('study.flow.ui.undo.inlet_velocity'), (x) => { x.value = v; }), { min: 1e-9, max: 1000, data: { flowValue: '1' } })));
    else g.append(...K.field(t('study.flow.ui.open.volume'), K.num(o.value * 60000, (v) => seto(t('study.flow.ui.undo.inlet_flow'), (x) => { x.value = v / 60000; }), { min: 1e-10, max: 6e6, data: { flowValue: '1' } })));
  } else g.append(...K.field(t('study.flow.ui.open.pressure'), K.num(o.p, (v) => seto(t('study.flow.ui.undo.outlet_pressure'), (x) => { x.p = v; }), { min: -1e8, max: 1e8, data: { flowP: '1' } })));
  g.append(el('span', { className: 'k' }, t('study.flow.ui.open.faces_label')), el('span', { className: 'v' }, faceWords(host, o.faces)));
  const acts = el('div', { className: 'pc-actions' },
    K.btn(F.picking ? t('study.flow.ui.pick.done_btn') : t('study.flow.ui.pick.btn'), () => { F.picking = !F.picking; host.status(F.picking ? t('study.flow.ui.pick.hint') : t('study.flow.ui.pick.done')); host.renderPanel(); }, 'pc-btn' + (F.picking ? ' is-primary' : ''), { dataset: { flowPick: '1' }, 'aria-pressed': String(F.picking) }),
    K.btn(t('study.flow.ui.btn.delete'), () => { set(t('study.flow.ui.undo.delete', { name: openingName(o) }), (f) => { f.openings = f.openings.filter((y) => y.id !== o.id); }); F.sel = null; F.picking = false; host.renderPanel(); }, 'pc-btn', { dataset: { flowDelete: '1' } }));
  box.append(el('div', { className: 'pc-block' }, g, acts, el('p', { className: 'pc-note' }, t(o.role === 'inlet' ? 'study.flow.ui.open.note_inlet' : 'study.flow.ui.open.note_outlet', { what: describeOpening(o) }))));
}

function renderExternal(host, box, K, fl, set) {
  const { el } = host, rg = host.regen, e = fl.ext;
  const key = axisKey(e.dir), lkey = e.lift ? axisKey(e.lift) : 'auto';
  const b = rg && rg.stats ? boxOf(e, rg.stats.bbox) : null;
  const g = el('div', { className: 'pc-props' }, el('p', { className: 'pc-props-sub' }, t('study.flow.ui.ext.head')),
    ...K.field(t('study.flow.ui.ext.speed'), K.num(e.speed, (v) => set(t('study.flow.ui.undo.speed'), (f) => { f.ext.speed = v; }), { min: 1e-9, max: 1000, data: { flowSpeed: '1' } })),
    ...K.field(t('study.flow.ui.ext.towards'), K.sel([...AXES.map(([k, l]) => [k, l]), ...(key === 'custom' ? [['custom', t('study.flow.ui.ext.custom')]] : [])], key, (v) => { if (v !== 'custom') set(t('study.flow.ui.undo.dir'), (f) => { f.ext.dir = AXES.find((a) => a[0] === v)[2].slice(); }); }, { flowDir: '1' })),
    ...K.field(t('study.flow.ui.ext.lift'), K.sel([['auto', t('study.flow.ui.ext.lift_auto')], ...AXES.map(([k, l]) => [k, l]), ...(lkey === 'custom' ? [['custom', t('study.flow.ui.ext.custom')]] : [])], lkey, (v) => { if (v !== 'custom') set(t('study.flow.ui.undo.lift'), (f) => { f.ext.lift = v === 'auto' ? null : AXES.find((a) => a[0] === v)[2].slice(); }); }, { flowLift: '1' })),
    ...K.field(t('study.flow.ui.ext.up'), K.num(e.up, (v) => set(t('study.flow.ui.undo.up'), (f) => { f.ext.up = v; }), { min: 0, max: 1e5, nullable: true, data: { flowUp: '1' } })),
    ...K.field(t('study.flow.ui.ext.down'), K.num(e.down, (v) => set(t('study.flow.ui.undo.down'), (f) => { f.ext.down = v; }), { min: 0, max: 1e5, nullable: true, data: { flowDown: '1' } })),
    ...K.field(t('study.flow.ui.ext.side'), K.num(e.side, (v) => set(t('study.flow.ui.undo.side'), (f) => { f.ext.side = v; }), { min: 0, max: 1e5, nullable: true, data: { flowSide: '1' } })),
    ...K.field(t('study.flow.ui.ext.area'), K.num(e.refArea, (v) => set(t('study.flow.ui.res.ref_area'), (f) => { f.ext.refArea = v; }), { min: 1e-6, max: 1e12, nullable: true, data: { flowArea: '1' } })));
  if (b) g.append(el('span', { className: 'k' }, t('study.flow.ui.ext.box_label')), el('span', { className: 'v' }, t(e.up === null || e.down === null || e.side === null ? 'study.flow.ui.ext.box_auto' : 'study.flow.ui.ext.box', { up: U.fmt(b.up), down: U.fmt(b.down), side: U.fmt(b.side) })));
  const ld = liftDir(e);
  g.append(el('p', { className: 'pc-note span' }, t('study.flow.ui.ext.note', { lift: ld.map((v) => U.fmt(v, 3)).join(', ') })));
  box.append(el('div', { className: 'pc-block' }, g));
}

function faceWords(host, faces) {
  const rg = host.regen;
  if (!faces.length) return t('study.flow.ui.fw.none');
  const words = faces.map((f) => { const i = rg && rg.faces ? findFaceIndex(rg.faces, f) : -1; if (i < 0) return t('study.flow.ui.fw.gone'); const x = rg.faces[i]; return x.type === 'cylinder' ? t('study.flow.ui.fw.round', { d: U.fmt(2 * x.r) }) : x.type === 'plane' ? t('study.flow.ui.fw.flat') : t('study.flow.ui.fw.other', { type: x.type }); });
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Object.entries(counts).map(([w, n]) => (n > 1 ? t('study.flow.ui.fw.count', { n, what: w }) : w)).join(', ');
}

function addOpening(host, role) {
  if (!host.regen || !(host.regen.exact || host.regen.named)) { host.status(exactWhy(t('kernel.what.flow'), t('study.flow.ui.need_exact'))); return; }
  let made = null;
  edit(host, t(role === 'inlet' ? 'study.flow.ui.undo.add_inlet' : 'study.flow.ui.undo.add_outlet'), (f) => {
    if (f.openings.length >= FLOW_LIMITS.openings) { host.status(t('study.flow.ui.max_openings', { n: FLOW_LIMITS.openings })); return false; }
    f.seq = (f.seq || 0) + 1;
    made = role === 'inlet' ? { id: 'o' + f.seq, role, faces: [], spec: 'velocity', value: 0.01 } : { id: 'o' + f.seq, role, faces: [], p: 0 };
    f.openings.push(made);
  });
  if (!made) return;
  F.sel = made.id; F.picking = true;
  host.status(t('study.flow.ui.pick.start', { name: openingName(made) }), true);
  host.renderPanel();
}
function togglePick(host, hit) {
  const fl = flowOf(host), o = opOf(fl, F.sel), rg = host.regen;
  if (!o || !rg || !rg.faces) return;
  if (!hit || hit.kind !== 'face' || hit.face === undefined || hit.face < 0) { host.status(t('study.flow.ui.pick.need_face')); return; }
  const ref = faceRef(rg.faces[hit.face]);
  edit(host, t('study.flow.ui.undo.pick', { name: openingName(o) }), (f) => {
    const x = opOf(f, o.id), k = x.faces.findIndex((r) => findFaceIndex(rg.faces, r) === hit.face);
    if (k >= 0) x.faces.splice(k, 1);
    else { if (x.faces.length >= 64) { host.status(t('study.flow.ui.pick.max')); return false; } x.faces.push(ref); }
  });
}

function renderResults(host, box, K) {
  const { el } = host, r = F.result, ok = fresh(host);
  const b = el('div', { className: 'pc-block', dataset: { flowResults: '1' } }, el('p', { className: 'pc-props-sub' }, t('study.flow.ui.res.head')));
  if (!ok) { b.append(el('div', { className: 'pc-msg' }, el('p', {}, t('study.flow.ui.res.stale')))); box.append(b); return; }
  if (r.model === 'sa') b.append(turbBanner(el, 'results'));
  if (!r.converged) b.append(el('div', { className: 'pc-msg is-error', dataset: { flowConv: '0' } }, el('p', {}, t('study.flow.ui.res.not_conv', { steps: r.steps.toLocaleString('en-US'), res: r.res.toExponential(1), tol: flowTol.v.toExponential(0) }))));
  else b.append(el('div', { className: 'pc-msg is-ok', dataset: { flowConv: '1' } }, el('p', {}, t('study.flow.ui.res.conv', { steps: r.steps.toLocaleString('en-US'), res: r.res.toExponential(1) }))));
  for (const w of regimeWarnings(r)) b.append(el('div', { className: 'pc-msg' + (w.bad ? ' is-error' : ''), dataset: { flowWarn: '1' } }, el('p', {}, w.text)));
  const pa = planeAt(host), redo = () => { plot(host); host.renderPanel(); };
  const ctl = el('div', { className: 'pc-props' },
    K.check(t('study.flow.ui.res.plane'), F.plane, (v) => { F.plane = v; redo(); }, { dataset: { flowPlane: '1' } }),
    ...K.field(t('study.flow.ui.res.shows'), K.sel([['speed', t('study.flow.ui.field.speed')], ['pressure', t('study.flow.ui.field.pressure')], ...(r.fields.nut ? [['nut', t('study.flow.ui.res.nut_ratio')]] : [])], F.show === 'nut' && !r.fields.nut ? 'speed' : F.show, (v) => { F.show = v; redo(); }, { flowShow: '1' })),
    ...K.field(t('study.flow.ui.res.normal'), K.sel([['0', 'X'], ['1', 'Y'], ['2', 'Z']], String(F.axis), (v) => { F.axis = Number(v); F.at = null; redo(); }, { flowAxis: '1' })));
  const range = el('input', { type: 'range', className: 'pc-range', id: 'pc-flow-at', min: String(pa.lo), max: String(pa.hi), step: String(r.fields.h / 2), value: String(pa.at), 'aria-label': t('study.flow.ui.res.at_aria'), dataset: { flowAt: '1' } });
  const atText = el('span', { className: 'v' }, t('study.flow.ui.mm', { v: U.fmt(pa.at, 2) }));
  range.addEventListener('input', () => { F.at = Number(range.value); atText.textContent = t('study.flow.ui.mm', { v: U.fmt(F.at, 2) }); plot(host); });
  ctl.append(el('label', { htmlFor: 'pc-flow-at' }, t('study.flow.ui.res.at')), range, el('span', { className: 'k' }), atText,
    K.check(t('study.flow.ui.res.streams'), F.streams, (v) => { F.streams = v; redo(); }, { dataset: { flowStreams: '1' } }),
    ...K.field(t('study.flow.ui.res.streams'), K.num(F.nStreams, (v) => { if (!Number.isInteger(v)) { host.status(t('study.flow.ui.res.streams_whole')); return; } F.nStreams = v; redo(); }, { min: 1, max: 400, data: { flowNStreams: '1' } })),
    ...K.field(t('study.flow.ui.res.part'), K.sel([['solid', t('study.flow.ui.res.solid')], ['ghost', t('study.flow.ui.res.ghost')], ['pressure', t('study.flow.ui.res.surface')], ['hidden', t('study.flow.ui.res.hidden')]], F.look, (v) => { F.look = v; redo(); }, { flowLook: '1' })));
  b.append(ctl);
  if (F.plane) b.append(U.legend(host, values(F.show)));
  if (F.look === 'pressure' && !(F.plane && F.show === 'pressure')) b.append(U.legend(host, { title: t('study.flow.ui.res.surface'), lo: r.pmin, hi: r.pmax, unit: 'Pa' }));
  if (F.streams && !(F.plane && F.show === 'speed')) b.append(U.legend(host, { title: t('study.flow.ui.res.stream_speed'), lo: 0, hi: r.vmax, unit: 'm/s' }));
  F.probeEl = el('p', { className: 'pc-note', dataset: { flowProbe: '1' }, 'aria-live': 'polite' }, t('study.flow.ui.probe.hint'));
  b.append(F.probeEl);
  const dl = el('dl', { className: 'pc-dl', dataset: { flowTable: '1' } });
  const add = (k, v, data) => dl.append(el('dt', {}, k), el('dd', data ? { dataset: data } : {}, v));
  add(t('study.flow.ui.panel.model'), r.model === 'sa' ? t('study.flow.ui.res.model_sa') : t('study.flow.model.laminar'), { flowModelUsed: r.model || 'laminar' });
  if (r.model === 'sa') add(t('study.flow.ui.res.accuracy'), turbWarning(), { flowTurbWarning: 'table' });
  add(t('study.flow.ui.res.re'), r.type === 'internal' ? t('study.flow.ui.res.re_internal', { re: U.sig(r.Re) }) : t('study.flow.ui.res.re_external', { re: U.sig(r.Re), l: U.fmt(r.ext.lref, 2) }), { flowRe: String(r.Re) });
  if (r.turb && r.turb.yplus) {
    const y = r.turb.yplus;
    const outY = y.min < r.turb.range[0] || y.max > r.turb.range[1];
    add(t('study.flow.ui.res.yplus_label'), t(outY ? 'study.flow.ui.res.yplus_out' : 'study.flow.ui.res.yplus', { min: U.sig(y.min), mean: U.sig(y.mean), max: U.sig(y.max), cells: y.cells.toLocaleString('en-US'), p05: U.sig(y.p05), p95: U.sig(y.p95), lo: r.turb.range[0], hi: r.turb.range[1].toLocaleString('en-US') }), { flowYplus: `${y.min},${y.mean},${y.max}`, flowYplusOut: outY ? '1' : '0' });
    add(t('study.flow.ui.res.nut_label'), t('study.flow.ui.res.nut', { n: U.sig(r.turb.nutMax) }));
    if (r.turb.tauWall) add(t('study.flow.ui.res.tau_label'), t('study.flow.ui.res.tau', { lo: U.sig(r.turb.tauWall[0]), hi: U.sig(r.turb.tauWall[1]) }));
  }
  if (r.type === 'internal') {
    add(t('study.flow.ui.res.dp_label'), t('study.flow.ui.res.dp', { dp: U.sig(r.dp) }), { flowDp: String(r.dp) });
    for (const o of r.openings) add('  ' + openingName(o), t(o.mass >= 0 ? 'study.flow.ui.res.open_in' : 'study.flow.ui.res.open_out', { q: U.sig(Math.abs(o.flow) * 60000), m: U.sig(Math.abs(o.mass)), p: U.sig(o.p) }) + (o.U !== null ? t('study.flow.ui.res.open_speed', { u: U.sig(o.U), a: U.sig(o.area * 1e6) }) : '') + (o.modes ? t('study.flow.ui.res.open_modes', { modes: [...new Set(o.modes)].map((m) => (m === 'lid' || m === 'cap' ? t('study.flow.ui.res.mode_' + m) : m)).join(t('study.flow.ui.res.and')) }) : ''), { flowOpening: o.id });
  } else {
    add(t('study.flow.ui.res.drag_label'), t('study.flow.ui.res.drag', { f: U.sig(r.ext.drag), c: U.sig(r.ext.cd) }), { flowCd: String(r.ext.cd), flowDrag: String(r.ext.drag) });
    add(t('study.flow.ui.res.lift_label'), t('study.flow.ui.res.lift', { f: U.sig(r.ext.lift), c: U.sig(r.ext.cl) }), { flowCl: String(r.ext.cl) });
    add(t('study.flow.ui.res.ref_area'), t(r.ext.refAuto ? 'study.flow.ui.res.area_auto' : 'study.flow.ui.res.area_set', { a: U.sig(r.ext.refArea), q: U.sig(r.ext.q) }), { flowAref: String(r.ext.refArea) });
    add(t('study.flow.ui.res.pdiff_label'), t('study.flow.ui.res.pdiff', { dp: U.sig(r.dp) }));
  }
  add(t('study.flow.ui.res.force_label'), t(r.forceBy === 'box' ? 'study.flow.ui.res.force_box' : r.forceBy === 'openings' ? 'study.flow.ui.res.force_openings' : 'study.flow.ui.res.force', { f: r.force.map((v) => U.sig(v)).join(', ') }), { flowForce: r.force.join(',') });
  const bal = r.massIn > 0 ? (r.massIn - r.massOut) / r.massIn : 0;
  add(t('study.flow.ui.res.mass_label'), t('study.flow.ui.res.mass', { in: U.sig(r.massIn), out: U.sig(r.massOut), pct: U.sig(100 * bal), wall: U.sig(100 * r.wallLeak / (r.massIn || 1)) }), { flowBalance: String(bal) });
  add(t('study.flow.ui.res.speed_label'), t('study.flow.ui.res.speed', { v: U.sig(r.vmax) }));
  add(t('study.flow.ui.res.pressure_label'), t('study.flow.ui.res.pressure', { lo: U.sig(r.pmin), hi: U.sig(r.pmax) }));
  add(t('study.flow.ui.res.mesh_label'), t(r.mesh.interpolated ? 'study.flow.ui.res.mesh_interp' : 'study.flow.ui.res.mesh_bounce', { cells: r.mesh.fluid.toLocaleString('en-US'), h: U.fmt(r.mesh.h), nx: r.fields.nx, ny: r.fields.ny, nz: r.fields.nz }), { flowCells: String(r.mesh.fluid) });
  add(t('study.flow.ui.res.solver_label'), t('study.flow.ui.res.solver', { steps: r.steps.toLocaleString('en-US'), res: r.res.toExponential(1), s: (r.ms / 1000).toFixed(1), threads: r.threads ? ', ' + threadWords(r.threads, r.model === 'sa' ? t('study.flow.ui.res.one_thread') : '') : '', tau: r.lattice.tau.toFixed(4), u: U.sig(r.lattice.u), mach: U.sig(r.lattice.u * Math.sqrt(3)), re: U.sig(r.lattice.Reg) }), { flowThreads: String(r.threads ? r.threads.used : 1) });
  b.append(dl);
  const cv = el('canvas', { width: 560, height: 150, className: 'pc-flow-res', 'aria-label': t('study.flow.ui.res_history'), dataset: { flowResiduals: 'done' } });
  cv.style.setProperty('width', '100%');
  b.append(el('p', { className: 'pc-props-sub' }, t('study.flow.ui.res_history')), cv);
  drawResiduals(host, cv, r.history, flowTol.v, r.converged);
  b.append(el('p', { className: 'pc-note' }, t('study.flow.ui.res.note')));
  box.append(b);
}

/** The standing, non-dismissable warning on every turbulent study (panel, results). */
function turbBanner(el, where) {
  return el('div', { className: 'pc-msg is-error span', role: 'note', dataset: { flowTurbWarning: where } }, el('p', {}, turbWarning()));
}

/** Plain-words warnings on the flow regime, the model's range and the lattice. */
export function regimeWarnings(r) {
  const out = [];
  if (r.model === 'sa') {
    if (r.type === 'internal') {
      if (r.Re < 2300) out.push({ bad: true, text: t('study.flow.ui.w.sa_pipe_laminar', { re: U.sig(r.Re) }) });
      else if (r.Re < 4000) out.push({ bad: true, text: t('study.flow.ui.w.sa_pipe_trans', { re: U.sig(r.Re) }) });
    } else {
      if (r.Re < 1e3) out.push({ bad: true, text: t('study.flow.ui.w.sa_ext_laminar', { re: U.sig(r.Re) }) });
      else if (r.Re < 5e5) out.push({ bad: false, text: t('study.flow.ui.w.sa_ext_trans', { re: U.sig(r.Re) }) });
      if (!r.converged) out.push({ bad: true, text: t('study.flow.ui.w.sa_unsteady') });
    }
    const y = r.turb && r.turb.yplus;
    if (y) {
      const [lo, hi] = r.turb.range;
      if (y.max > hi) out.push({ bad: true, text: t('study.flow.ui.w.yplus_high', { max: U.sig(y.max), hi: hi.toLocaleString('en-US'), pct: U.sig(100 * y.above) }) });
      if (y.min < lo) out.push({ bad: false, text: t('study.flow.ui.w.yplus_low', { min: U.sig(y.min), lo, pct: U.sig(100 * y.below) }) });
      if (y.p50 < 15 && y.p50 >= lo) out.push({ bad: false, text: t('study.flow.ui.w.yplus_buffer', { med: U.sig(y.p50) }) });
    }
  } else if (r.type === 'internal') {
    if (r.Re > 4000) out.push({ bad: true, text: t('study.flow.ui.w.lam_pipe_turb', { re: U.sig(r.Re) }) });
    else if (r.Re > 2000) out.push({ bad: true, text: t('study.flow.ui.w.lam_pipe_trans', { re: U.sig(r.Re) }) });
  } else {
    if (r.Re > 2e5) out.push({ bad: true, text: t('study.flow.ui.w.lam_ext_turb', { re: U.sig(r.Re) }) });
    else if (r.Re > 50) out.push({ bad: !r.converged, text: t(r.converged ? 'study.flow.ui.w.lam_ext_shed_ok' : 'study.flow.ui.w.lam_ext_shed_bad', { re: U.sig(r.Re) }) });
  }
  if (r.model !== 'sa' && r.lattice.tau < 0.52) out.push({ bad: false, text: t('study.flow.ui.w.coarse', { tau: r.lattice.tau.toFixed(3), re: U.sig(r.lattice.Reg) }) });
  const mach = r.vmax * r.lattice.dt / (r.mesh.h / 1000) * Math.sqrt(3);   // the fastest cell, in lattice speed of sound
  if (mach > 0.3) out.push({ bad: false, text: t('study.flow.ui.w.mach', { mach: U.sig(mach) }) });
  return out;
}


// ---------------------------------------------------------------- wrapping the Simulation workspace

/** ws-simulation.js passes its definition through this: flow studies are handled here, the rest as before. */
export function withFlow(def) {
  const o = { ...def };
  const leaveFlow = (host) => { if (F.wasFlow) { F.wasFlow = false; F.picking = false; clearOverlays(host); host.view.setPartVisible(true); if (o.rebuilt) o.rebuilt.call(def, host); } };
  const enterFlow = (host) => { if (!F.wasFlow) { F.wasFlow = true; host.view.setOverlay('simulation-plot', null); host.view.setOverlay('simulation-markers', null); host.view.setPartVisible(true); } };
  def.enter = function (host) {
    if (o.enter) o.enter.call(def, host);
    if (!F.onMove) F.onMove = (e) => { if (isFlow(host) && !F.picking) probe(host, e); };
    host.view.canvas.addEventListener('pointermove', F.onMove, { passive: true });
    F.wasFlow = false;
    if (isFlow(host)) { enterFlow(host); markers(host); plot(host); }
  };
  def.exit = function (host) {
    if (F.onMove) host.view.canvas.removeEventListener('pointermove', F.onMove);
    F.req++;
    if (F.worker) { F.worker.terminate(); F.worker = null; }
    F.busy = false; F.picking = false; F.wasFlow = false;
    if (o.exit) o.exit.call(def, host);
  };
  def.command = function (cmd, host) {
    if (isFlow(host)) {
      if (cmd === 'simulation-solve') { solve(host); return true; }
      if (cmd.startsWith('simulation-')) { host.status(t('study.flow.ui.hook.no_cmd')); return true; }
      return false;
    }
    return o.command ? o.command.call(def, cmd, host) : false;
  };
  def.renderPanel = function (host, box) {
    if (isFlow(host)) { enterFlow(host); return renderPanel(host, box); }
    const h = o.renderPanel ? o.renderPanel.call(def, host, box) : undefined;
    leaveFlow(host);
    return h;
  };
  def.onPick = function (hit, host, ev) {
    if (isFlow(host)) { if (F.picking) togglePick(host, hit); else if (hit && hit.kind === 'face' && !fresh(host)) host.status(t('study.flow.ui.hook.choose')); return; }
    if (o.onPick) o.onPick.call(def, hit, host, ev);
  };
  def.onHover = function (hit, host) {
    if (isFlow(host)) { if (F.picking) U.hoverFace(host, hit); else host.view.setHover(null); return; }
    if (o.onHover) o.onHover.call(def, hit, host);
  };
  def.keydown = function (ev, host) {
    if (isFlow(host)) { if (ev.key === 'Escape' && F.picking) { F.picking = false; host.status(t('study.flow.ui.pick.done')); host.renderPanel(); return true; } return false; }
    return o.keydown ? o.keydown.call(def, ev, host) : false;
  };
  def.toolState = function (cmd, host) {
    if (isFlow(host)) {
      if (cmd === 'simulation-solve') {
        if (F.busy) return { ok: false, why: t('study.flow.ui.hook.busy') };
        const { problems } = flowJob(study(host), host.regen, { check: true });
        return problems.length ? { ok: false, why: problems[0] } : { ok: true };
      }
      return { ok: false, why: t('study.flow.ui.hook.no_tool') };
    }
    return o.toolState ? o.toolState.call(def, cmd, host) : { ok: true };
  };
  def.rebuilt = function (host) {
    if (isFlow(host)) { enterFlow(host); markers(host); plot(host); return; }
    if (o.rebuilt) o.rebuilt.call(def, host);
  };
  return def;
}

export const _flowState = F;   // tests
