/* SPDX-License-Identifier: Apache-2.0 */
/**
 * flow-study.js — the Flow study as plain data (DOM-free): `part.studies.simulation.kind === 'flow'` keeps its settings in
 * `part.studies.simulation.flow` (the structural fields of the study stay as they were, so switching back loses nothing).
 *
 * flow = { v:1, type 'internal'|'external', fluid ('air'|'water' | {name, density kg/m³, viscosity Pa·s}), h (cell mm | null = auto),
 *   wall 'interpolated'|'bounce', model 'laminar'|'sa' (absent in files from before: laminar; 'sa' = steady RANS, Spalart–Allmaras
 *   with Spalding wall functions, flow-turb.js — experimental: see TURB_WARNING), maxSteps, tol, seq,
 *   openings: [{id 'o<n>', role 'inlet'|'outlet', faces:[FaceRef], spec 'velocity'|'flow' (inlets), value (m/s | m³/s), p (Pa, outlets)}],
 *   ext: {speed m/s, dir [x,y,z], up, down, side (mm | null = auto: 1, 3, 1 × the part's largest size), refArea (mm² | null = frontal),
 *         lift [x,y,z] | null (null: +Y, or +Z when the flow is along Y)} }
 */
import { NAME_RE } from './brep.js';
import { FLUIDS, fluidById } from './flow.js';
import { t } from './i18n.js';

// the same rules as sim.js (kept here so sim.js can read flow blocks without an import cycle)
function findFaceIndex(faces, ref) {
  let best = -1, bd = Infinity;
  faces.forEach((f, i) => { if (f.name !== ref.name) return; const d = Math.hypot(f.at[0] - ref.at[0], f.at[1] - ref.at[1], f.at[2] - ref.at[2]); if (d < bd) { bd = d; best = i; } });
  return best;
}
function autoSize(volume, target) {
  const raw = Math.cbrt(volume / target), e = Math.floor(Math.log10(raw)), b = raw / 10 ** e;
  const s = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= b - 1e-9) || 10;
  return +(s * 10 ** e).toPrecision(3);
}

export const FLOW_LIMITS = { fluidCells: 600000, gridCells: 6e6, openings: 16, refs: 64 };
export const FLOW_AUTO = { internal: 150000, external: 120000 };   // cells in the grid box for the automatic cell size
// 'sa' = steady RANS, Spalart–Allmaras + Spalding wall functions (flow-turb.js), EXPERIMENTAL (owner, 2026-10-12): it did not
// pass its pipe-friction and backward-facing-step checks; the panel carries TURB_WARNING wherever it is used.
export const FLOW_MODEL_IDS = ['laminar', 'sa'];
// [id, label] rows; the label is a getter so the text comes from the language file when it is read, not at import
const modelRow = (id, k) => Object.defineProperty([id, ''], 1, { get: () => t(k), enumerable: true });
export const FLOW_MODELS = [modelRow('laminar', 'study.flow.model.laminar'), modelRow('sa', 'study.flow.model.sa')];
export const FLOW_AUTO_TURB = { internal: 60000, external: 30000 };   // smaller automatic grids: a turbulent run needs more steps
// TURB_WARNING stays the English reference text (tests read it); the panel shows turbWarning(), the same text from the language file
// i18n-ignore: English reference copy of study.flow.turb_warning
export const TURB_WARNING = 'Experimental: this turbulence model did not pass its accuracy checks. Measured errors: flat channels, friction +3 to +5 % (Dean, first cell at y⁺ 49–98); resolved-wall channel, bulk velocity −1 % (Moser et al., y⁺ ≈ 3); pipe friction 30 to 34 % too high; reattachment behind a backward-facing step 21 to 39 % too short; results improve only slowly with finer cells. Use it for qualitative flow patterns (where flow separates, recirculates or speeds up), not for design numbers.';
export const turbWarning = () => t('study.flow.turb_warning');

export function newFlow() {
  return { v: 1, type: 'internal', fluid: 'water', h: null, wall: 'interpolated', model: 'laminar', maxSteps: 40000, tol: 1e-6, seq: 0, openings: [],
    ext: { speed: 1, dir: [1, 0, 0], up: null, down: null, side: null, refArea: null, lift: null } };
}

const bad = (m) => { throw new Error(m); };
const num = (v, lo, hi, what) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(t(what)));   // what: the key of the whole message
const opt = (v, lo, hi, what) => (v === null || v === undefined ? null : num(v, lo, hi, what));
const vec = (v, what) => (Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c) && Math.abs(c) <= 1e6) && Math.hypot(...v) > 1e-9 ? v.slice() : bad(t(what)));
function faceRefs(list) {
  if (!Array.isArray(list) || list.length > FLOW_LIMITS.refs) bad(t('study.flow.err.bad_face_list'));
  return list.map((f) => {
    if (!f || typeof f.name !== 'string' || f.name.length > 600 || !NAME_RE.test(f.name)) bad(t('study.flow.err.bad_face_name'));
    if (!Array.isArray(f.at) || f.at.length !== 3 || !f.at.every((c) => typeof c === 'number' && Number.isFinite(c) && Math.abs(c) <= 1e7)) bad(t('study.flow.err.bad_face_point'));
    return { name: f.name, at: f.at.slice() };
  });
}
export function readFluid(f) {
  if (typeof f === 'string') return fluidById(f) ? f : bad(t('study.flow.err.unknown_fluid'));
  if (!f || typeof f !== 'object') bad(t('study.flow.err.bad_fluid'));
  return { name: typeof f.name === 'string' && f.name.trim() ? f.name.slice(0, 60) : t('study.flow.fluid.custom_name'), density: num(f.density, 0.01, 30000, 'study.flow.range.density'), viscosity: num(f.viscosity, 1e-7, 100, 'study.flow.range.viscosity') };
}
export const fluidOf = (f) => (typeof f === 'string' ? fluidById(f) : { id: 'custom', ...f });

function opening(o) {
  if (!o || typeof o !== 'object') bad(t('study.flow.err.bad_opening'));
  const id = typeof o.id === 'string' && /^o\d{1,6}$/.test(o.id) ? o.id : bad(t('study.flow.err.bad_opening_id'));
  const role = ['inlet', 'outlet'].includes(o.role) ? o.role : bad(t('study.flow.err.bad_role'));
  const out = { id, role, faces: faceRefs(o.faces) };
  if (role === 'inlet') {
    out.spec = ['velocity', 'flow'].includes(o.spec) ? o.spec : bad(t('study.flow.err.bad_inlet_kind'));
    out.value = out.spec === 'velocity' ? num(o.value, 1e-9, 1000, 'study.flow.range.inlet_velocity') : num(o.value, 1e-15, 100, 'study.flow.range.inlet_flow');
  } else out.p = num(o.p ?? 0, -1e8, 1e8, 'study.flow.range.outlet_pressure');
  return out;
}

/** study.flow from a file (untrusted) → a clean copy, or throws. A missing block → the defaults. */
export function readFlow(raw) {
  if (raw === undefined || raw === null) return newFlow();
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) bad(t('study.flow.err.bad_study'));
  const e = raw.ext && typeof raw.ext === 'object' ? raw.ext : bad(t('study.flow.err.no_ext'));
  if (!Array.isArray(raw.openings) || raw.openings.length > FLOW_LIMITS.openings) bad(t('study.flow.err.bad_openings'));
  const seen = new Set();
  const openings = raw.openings.map((o) => { const r = opening(o); if (seen.has(r.id)) bad(t('study.flow.err.dup_id')); seen.add(r.id); return r; });
  return {
    v: 1, type: ['internal', 'external'].includes(raw.type) ? raw.type : bad(t('study.flow.err.bad_type')),
    fluid: readFluid(raw.fluid), h: opt(raw.h, 0.005, 1000, 'study.flow.range.cell_size'),
    wall: ['interpolated', 'bounce'].includes(raw.wall) ? raw.wall : bad(t('study.flow.err.bad_wall')),
    model: raw.model === undefined ? 'laminar' : FLOW_MODEL_IDS.includes(raw.model) ? raw.model : bad(t('study.flow.err.bad_model')),
    maxSteps: Math.round(num(raw.maxSteps ?? 40000, 100, 1e6, 'study.flow.range.step_limit')), tol: num(raw.tol ?? 1e-6, 1e-12, 1e-2, 'study.flow.range.tol'),
    seq: Math.round(num(raw.seq ?? 0, 0, 1e6, 'study.flow.range.seq')), openings,
    ext: {
      speed: num(e.speed, 1e-9, 1000, 'study.flow.range.speed'), dir: vec(e.dir, 'study.flow.dir.flow'), up: opt(e.up, 0, 1e5, 'study.flow.range.up'),
      down: opt(e.down, 0, 1e5, 'study.flow.range.down'), side: opt(e.side, 0, 1e5, 'study.flow.range.side'), refArea: opt(e.refArea, 1e-6, 1e12, 'study.flow.range.ref_area'),
      lift: e.lift === null || e.lift === undefined ? null : vec(e.lift, 'study.flow.dir.lift'),
    },
  };
}

export const ROLE_LABEL = { get inlet() { return t('study.flow.role.inlet'); }, get outlet() { return t('study.flow.role.outlet'); } };
export const openingName = (o) => t(o.role === 'inlet' ? 'study.flow.opening.inlet_n' : 'study.flow.opening.outlet_n', { n: o.id.replace(/\D/g, '') });
export function describeOpening(o) {
  const n = o.faces.length;
  if (o.role === 'outlet') return t('study.flow.opening.desc_outlet', { p: +o.p.toPrecision(6), n });
  return o.spec === 'velocity' ? t('study.flow.opening.desc_velocity', { v: +o.value.toPrecision(6), n }) : t('study.flow.opening.desc_flow', { v: +(o.value * 60000).toPrecision(6), n });
}

const unitv = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
/** The lift direction: the user's (made square to the flow) or +Y (+Z when the flow is mostly along Y). */
export function liftDir(ext) {
  const d = unitv(ext.dir);
  let l = ext.lift ? unitv(ext.lift) : Math.abs(d[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const k = l[0] * d[0] + l[1] * d[1] + l[2] * d[2];
  l = l.map((c, i) => c - k * d[i]);
  return Math.hypot(...l) > 1e-6 ? unitv(l) : (Math.abs(d[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
}
/** External box distances (mm): the study's, or 1 / 3 / 1 × the part's largest size. */
export function boxOf(ext, bbox) {
  const L = Math.max(...[0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]));
  return { up: ext.up ?? L, down: ext.down ?? 3 * L, side: ext.side ?? L, L };
}
/** The grid box (mm) the cells fill, for the automatic size and the estimate. */
export function gridBox(fl, bbox) {
  if (fl.type === 'internal') return bbox;
  const b = boxOf(fl.ext, bbox), d = unitv(fl.ext.dir), ax = [0, 1, 2].reduce((m, a) => (Math.abs(d[a]) > Math.abs(d[m]) ? a : m), 0), s = Math.sign(d[ax]) || 1;
  return { min: [0, 1, 2].map((a) => bbox.min[a] - (a === ax ? (s > 0 ? b.up : b.down) : b.side)), max: [0, 1, 2].map((a) => bbox.max[a] + (a === ax ? (s > 0 ? b.down : b.up) : b.side)) };
}
export function cellEstimate(fl, bbox, h) {
  const g = gridBox(fl, bbox), n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((g.max[a] - g.min[a]) / h - 1e-6)) + (fl.type === 'internal' ? 4 : 2));
  return { nx: n[0], ny: n[1], nz: n[2], cells: n[0] * n[1] * n[2] };
}
export function autoCell(fl, bbox) {
  const g = gridBox(fl, bbox), vol = [0, 1, 2].reduce((p, a) => p * Math.max(g.max[a] - g.min[a], 1e-6), 1);
  return autoSize(vol, (fl.model === 'sa' ? FLOW_AUTO_TURB : FLOW_AUTO)[fl.type]);
}

/** Flow study + exact build → { job, problems, h, estimate }; check: no mesh copy. (experimental: accepted for old callers; no effect.) */
export function flowJob(st, regen, { check = false, experimental = false } = {}) {
  void experimental;
  const fl = st.flow || newFlow(), problems = [];
  if (!regen || !(regen.exact || regen.named) || !regen.mesh || !regen.faces || !regen.stats) return { job: null, problems: [t('study.flow.problem.need_exact')] };
  const gone = [], openings = fl.openings.map((o) => {
    const idx = o.faces.map((f) => findFaceIndex(regen.faces, f));
    if (idx.some((i) => i < 0)) gone.push(openingName(o));
    return { ...o, faces: idx.filter((i) => i >= 0) };
  });
  if (gone.length) problems.push(t('study.flow.problem.faces_gone', { names: gone.join(', ') }));
  if (fl.type === 'internal') {
    if (!openings.some((o) => o.role === 'inlet')) problems.push(t('study.flow.problem.no_inlet'));
    if (!openings.some((o) => o.role === 'outlet')) problems.push(t('study.flow.problem.no_outlet'));
    for (const o of openings) if (!o.faces.length) problems.push(t('study.flow.problem.no_faces', { name: openingName(o) }));
    const used = new Map();
    for (const o of openings) for (const f of o.faces) { if (used.has(f) && used.get(f) !== o.id) problems.push(t('study.flow.problem.face_twice', { name: openingName(o) })); used.set(f, o.id); }
  }
  const bbox = regen.stats.bbox, h = fl.h || autoCell(fl, bbox), est = cellEstimate(fl, bbox, h);
  if (est.cells > FLOW_LIMITS.gridCells) problems.push(t('study.flow.problem.grid_cells', { cells: est.cells.toLocaleString('en-US'), max: FLOW_LIMITS.gridCells.toLocaleString('en-US') }));
  const fluid = fluidOf(fl.fluid);
  const meshCopy = check ? null : { positions: Float32Array.from(regen.mesh.positions), indices: Uint32Array.from(regen.mesh.indices), triFace: regen.mesh.triFace ? Int32Array.from(regen.mesh.triFace) : null };
  const job = {
    type: fl.type, h, fluid: { name: fluid.name, density: fluid.density, viscosity: fluid.viscosity }, wall: fl.wall, model: fl.model || 'laminar', maxSteps: fl.maxSteps, tol: fl.tol,
    openings: openings.map((o) => ({ id: o.id, role: o.role, faces: o.faces, spec: o.spec, value: o.value, p: o.p })),
    faces: regen.faces.map((f) => ({ type: f.type, n: f.n ? f.n.slice() : null, o: f.o ? f.o.slice() : null, area: f.area })),
    ext: fl.type === 'external' ? { ...boxOf(fl.ext, bbox), speed: fl.ext.speed, dir: unitv(fl.ext.dir), lift: liftDir(fl.ext), refArea: fl.ext.refArea } : null,
    mesh: meshCopy, bbox: { min: bbox.min.slice(), max: bbox.max.slice() },
  };
  return { job, problems, h, estimate: est };
}

export { FLUIDS };
