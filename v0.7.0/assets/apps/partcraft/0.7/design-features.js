/* SPDX-License-Identifier: Apache-2.0 */
/**
 * design-features.js — the data side of the Design workspace's modeling features added 2026-10-11 (DOM-free):
 * reference geometry (plane, axis, point), sweep, loft, draft, and the extra options of extrude (up to a face /
 * the next face / a vertex / an offset from a face, one contour, two directions, taper), holes (countersunk,
 * tapped), chamfers (two distances, distance + angle) and fillets (a linear radius change). part.js keeps the
 * document; this module holds their defaults, their references for dependsOn, and their untrusted-file readers.
 *
 *   plane   { mode, planes:[PlaneRef], d, angle, axis: DirRef|null, points:[PointRef], face: FaceRef|null, edge: EdgeRef|null, flip }
 *           offset (planes[0] moved d along its normal) · angle (through axis, at angle to planes[0]) · 3pt (points[0..2])
 *           · mid (between planes[0] and planes[1]; their bisector when they meet) · tangent (to cylinder face at points[0])
 *           · normal (square to edge — or to the line `axis` — at the curve point nearest points[0])
 *   axis    { mode, points, planes, face, edge }   2pt · cyl (cylinder or cone face) · planes (intersection of two)
 *           · edge (a straight edge, or a circle's axis) · normal (square to planes[0] through points[0])
 *   point   { mode, points, edge, p }              at (points[0]) · center (of a circular edge) · xyz (p)
 *           + planes, axis, face, flip              mid (of an edge, or points[0..1]) · meet (edge / axis × planes[0] / face)
 *                                                   · planes3 (planes[0..2])            (2026-10-11, written only when used)
 *   plane   + edgept (through edge / axis and points[0]) · midnormal (square to an edge, or points[0]→points[1], at its middle)
 *   sweep   { sketch (profile), path:[PathItem], op, orient, binormal: DirRef|null, guide:[PathItem]|null, scale }
 *           PathItem = { sketch, entities?:[curve id] } | { edge: EdgeRef }; orient frenet|corrected|fixed|binormal|guide
 *   loft    { sections:[{ sketch } | { face: FaceRef } | { point: PointRef }], op, ruled, rails?:[PathItem] (0.4: guide rails —
 *           the loft is then a Gordon surface through the sketch sections and the rails, capped: surface.js gordon), railTol? }
 *   draft   { faces:[FaceRef], neutral: PlaneRef, pull: DirRef|null (null = the neutral plane's normal), angle (°, ±) }
 *   op      'add' | 'cut' | 'intersect' | 'new' (a separate body; booleans later act on every body)
 *   PointRef { kind:'sketch', sketch, entity (point id or 'O') } | { kind:'vertex', edge: EdgeRef, p } (the end of that edge
 *            nearest p) | { kind:'ref', feature } (a point feature) | { kind:'fixed', p }
 *   PlaneRef/DirRef gain { kind:'ref', feature } (a plane feature; for a DirRef an axis feature, or a plane's normal).
 *   extrude + end upto|next|vertex|offset, upto: PlaneRef|null, vertex: PointRef|null, offset, two, depth2, taper (°), regions: [[x,y]]|null
 *   hole    + kind csink|tapped, csinkD, csinkAngle 90|82, size 'M2'…'M24', threadDepth (null = full depth)
 *   chamfer + mode equal|two|angle, d2, angle, flip (which face d is measured on)   fillet + r2 (null = constant), flip
 *   revolve.axis may also be a DirRef object (an axis feature, a fixed edge) lying in the sketch's plane.
 */
import { t as tr } from './i18n.js';

// the types' names for people, read when shown (getters: never translated at import; part.js keeps them getters)
export const DESIGN_LABELS = {
  get plane() { return tr('model.feature.plane'); }, get axis() { return tr('model.feature.axis'); }, get point() { return tr('model.feature.point'); },
  get sweep() { return tr('model.feature.sweep'); }, get loft() { return tr('model.feature.loft'); }, get draft() { return tr('model.feature.draft'); },
};
export const DESIGN_BASE = { plane: 'Plane', axis: 'Axis', point: 'Point', sweep: 'Sweep', loft: 'Loft', draft: 'Draft' };
/** Reference geometry: no solid, shown as quads / dashed lines / crosses, used as planes and directions. */
export const REF_TYPES = new Set(['plane', 'axis', 'point']);
/** Only OpenCascade builds these (kernel.js skips them with the reason). */
export const DESIGN_EXACT_ONLY = ['sweep', 'loft', 'draft'];
export const PLANE_MODES = ['offset', 'angle', '3pt', 'mid', 'tangent', 'normal', 'edgept', 'midnormal'];
export const AXIS_MODES = ['2pt', 'cyl', 'planes', 'edge', 'normal'];
export const POINT_MODES = ['at', 'center', 'xyz', 'mid', 'meet', 'planes3'];
export const OPS = ['add', 'cut', 'intersect', 'new'];
export const ORIENTS = ['frenet', 'corrected', 'fixed', 'binormal', 'guide'];
export const EXTRUDE_ENDS = ['blind', 'mid', 'through', 'upto', 'next', 'vertex', 'offset'];
export const HOLE_KINDS = ['simple', 'cbore', 'csink', 'tapped'];

/**
 * ISO metric coarse threads M2–M24: pitch from ISO 261 (coarse series) and the tap drill for a 6H internal thread
 * from ISO 2306 (drills for use prior to tapping) — nominal diameter minus pitch, rounded to the drill series.
 * { size: [nominal d, pitch, tap drill] }
 */
export const ISO_COARSE = {
  M2: [2, 0.4, 1.6], 'M2.5': [2.5, 0.45, 2.05], M3: [3, 0.5, 2.5], M4: [4, 0.7, 3.3], M5: [5, 0.8, 4.2], M6: [6, 1, 5],
  M8: [8, 1.25, 6.8], M10: [10, 1.5, 8.5], M12: [12, 1.75, 10.2], M14: [14, 2, 12], M16: [16, 2, 14], M18: [18, 2.5, 15.5],
  M20: [20, 2.5, 17.5], M22: [22, 2.5, 19.5], M24: [24, 3, 21],
};
export const THREAD_SOURCE = 'ISO 261 coarse pitch; tap drill per ISO 2306 (6H)';
/** The callout of a tapped hole: "M8×1.25 - 6H, thread 12 deep" (or "through"). */
export function threadCallout(f, depth = null) {
  const t = ISO_COARSE[f.size];
  if (!t) return '';
  if (f.through && !f.threadDepth) return tr('model.design_features.callout.through', { size: f.size, pitch: fmt(t[1]) });
  return tr('model.design_features.callout.deep', { size: f.size, pitch: fmt(t[1]), depth: fmt(f.threadDepth || depth || f.depth) });
}
const fmt = (v) => String(+Number(v).toFixed(3));

export const DESIGN_DEFAULTS = {
  plane: () => ({ mode: 'offset', planes: [{ kind: 'base', name: 'top' }], d: 20, angle: 30, axis: null, points: [], face: null, edge: null, flip: false }),
  axis: () => ({ mode: 'planes', planes: [{ kind: 'base', name: 'front' }, { kind: 'base', name: 'right' }], points: [], face: null, edge: null }),
  point: () => ({ mode: 'xyz', points: [], edge: null, p: [0, 0, 0] }),
  sweep: () => ({ sketch: null, path: [], op: 'add', orient: 'corrected', binormal: null, guide: null, scale: 1 }),
  loft: () => ({ sections: [], op: 'add', ruled: false }),
  draft: () => ({ faces: [], neutral: { kind: 'base', name: 'top' }, pull: null, angle: 3 }),
};
/** Extra fields the older features gained (added on read when absent, so old files stay valid as they were). */
export const EXTRUDE_EXTRA = { upto: null, vertex: null, offset: 0, two: false, depth2: 10, taper: 0, regions: null };
export const HOLE_EXTRA = { csinkD: 12, csinkAngle: 90, size: 'M6', threadDepth: null };

// ---------------------------------------------------------------- references (for dependsOn)

/** Feature ids a PlaneRef / DirRef / PointRef / EdgeRef / FaceRef / PathItem / section depends on. */
export function refDeps(r, add, nameFeatures) {
  if (!r || typeof r !== 'object') return;
  if (r.kind === 'ref' || (r.kind === 'face' && r.feature) || r.kind === 'axis') add(r.feature);
  if (r.kind === 'face' && r.name) nameFeatures(r.name).forEach(add);
  if (r.kind === 'line' || r.kind === 'sketch') add(r.sketch);
  if (r.kind === 'vertex') refDeps(r.edge, add, nameFeatures);
  if (Array.isArray(r.faces) && r.faces.every((n) => typeof n === 'string')) r.faces.forEach((n) => nameFeatures(n).forEach(add));   // EdgeRef
  if (typeof r.name === 'string' && !r.kind) nameFeatures(r.name).forEach(add);                                                        // FaceRef
  if (!r.kind && typeof r.sketch === 'string') add(r.sketch);                                                                           // PathItem / section
  if (!r.kind && r.edge) refDeps(r.edge, add, nameFeatures);
  if (!r.kind && r.face) refDeps(r.face, add, nameFeatures);
  if (!r.kind && r.point) refDeps(r.point, add, nameFeatures);
}

/** The ids the new fields of a feature depend on (old fields stay with part.js dependsOn). */
export function designDeps(f, nameFeatures) {
  const d = new Set();
  const add = (x) => { if (x) d.add(x); };
  const each = (v) => { if (Array.isArray(v)) v.forEach((r) => refDeps(r, add, nameFeatures)); else refDeps(v, add, nameFeatures); };
  for (const k of ['planes', 'points', 'path', 'guide', 'sections', 'rails']) each(f[k]);
  for (const k of ['face', 'edge', 'upto', 'vertex', 'neutral', 'pull', 'binormal']) each(f[k]);
  if (f.type === 'plane' || f.type === 'axis' || f.type === 'point') each(f.axis);
  if (f.type === 'revolve' && f.axis && typeof f.axis === 'object') each(f.axis);
  return [...d];
}

// ---------------------------------------------------------------- reading untrusted files

const num = (v, lo = -1e9, hi = 1e9) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x)) && Math.hypot(...v) <= 1e9;
const ENT = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 40 && /^[A-Za-z0-9_:-]+$/.test(s);

/**
 * Readers for the new references. `c` = { ids, types (id → type), goodName(name), nameFeatures(name), readPlane, readDir }.
 * Each returns a clean copy or throws Error.
 */
export function makeReaders(c) {
  const known = (n) => c.goodName(n) && c.nameFeatures(n).every((x) => c.ids.has(x));
  const edgeRef = (e) => {
    if (!e || !Array.isArray(e.faces) || e.faces.length !== 2 || !e.faces.every(known) || (e.at !== undefined && !vec3(e.at))) throw new Error(tr('model.design_features.ref.an_edge_reference_is_bad'));
    return { faces: [...e.faces], ...(e.at ? { at: [...e.at] } : {}) };
  };
  const faceRef = (r) => {
    if (!r || !known(r.name) || (r.at !== undefined && !vec3(r.at))) throw new Error(tr('model.design_features.ref.a_face_reference_is_bad'));
    return { name: r.name, ...(r.at ? { at: [...r.at] } : {}) };
  };
  const pointRef = (p) => {
    if (!p || typeof p !== 'object') throw new Error(tr('model.design_features.ref.a_point_reference_is_missing'));
    if (p.kind === 'sketch' && c.types.get(p.sketch) === 'sketch' && ENT(p.entity)) return { kind: 'sketch', sketch: p.sketch, entity: p.entity };
    if (p.kind === 'vertex' && vec3(p.p)) return { kind: 'vertex', edge: edgeRef(p.edge), p: [...p.p] };
    if (p.kind === 'ref' && c.types.get(p.feature) === 'point') return { kind: 'ref', feature: p.feature };
    if (p.kind === 'fixed' && vec3(p.p)) return { kind: 'fixed', p: [...p.p] };
    throw new Error(tr('model.design_features.ref.a_point_reference_is_bad'));
  };
  const pathItem = (it) => {
    if (it && typeof it.sketch === 'string') {
      if (c.types.get(it.sketch) !== 'sketch') throw new Error(tr('model.design_features.ref.a_path_sketch_is_bad'));
      if (it.entities !== undefined && it.entities !== null && !(Array.isArray(it.entities) && it.entities.length <= 500 && it.entities.every(ENT))) throw new Error(tr('model.design_features.ref.a_path_curve_list_is_bad'));
      return { sketch: it.sketch, ...(Array.isArray(it.entities) ? { entities: [...it.entities] } : {}) };
    }
    if (it && it.edge) return { edge: edgeRef(it.edge) };
    throw new Error(tr('model.design_features.ref.a_path_piece_is_bad'));
  };
  const list = (v, fn, max, key) => { if (!Array.isArray(v) || v.length > max) throw new Error(tr(key)); return v.map(fn); };   // key: model.file.list.* = "The … is bad."
  return { edgeRef, faceRef, pointRef, pathItem, list };
}

/** Fill `g` (the clean feature) from `f` (untrusted) for the new types and the new fields of old ones. */
export function readDesign(f, g, c) {
  const R = makeReaders(c);
  // keys: model.file.bad.* = "{name}: … is bad.", model.file.in.* = "{name}: {problem} (…)."
  const need = (cond, key) => { if (!cond) throw new Error(tr(key, { name: g.name })); };
  const wrap = (fn, key) => { try { return fn(); } catch (e) { throw new Error(tr(key, { name: g.name, problem: e.message.replace(/\.$/, '') })); } };
  const planes = (n) => wrap(() => R.list(f.planes ?? [], (p) => c.readPlane(p, c.ids, c.types), n, 'model.file.list.the_plane_list'), 'model.file.in.its_planes');
  const points = (n) => wrap(() => R.list(f.points ?? [], R.pointRef, n, 'model.file.list.the_point_list'), 'model.file.in.its_points');
  const opt = (v, fn, what) => (v === null || v === undefined ? null : wrap(() => fn(v), what));
  switch (f.type) {
    case 'plane':
      need(PLANE_MODES.includes(f.mode), 'model.file.bad.the_plane_type');
      need(num(f.d ?? 0), 'model.file.bad.the_distance'); need(num(f.angle ?? 0, -360, 360), 'model.file.bad.the_angle');
      Object.assign(g, { mode: f.mode, planes: planes(2), d: f.d ?? 0, angle: f.angle ?? 0, axis: opt(f.axis, (a) => c.readDir(a, c.ids, c.types), 'model.file.in.its_axis'),
        points: points(3), face: opt(f.face, R.faceRef, 'model.file.in.its_face'), edge: opt(f.edge, R.edgeRef, 'model.file.in.its_edge'), flip: f.flip === true });
      return true;
    case 'axis':
      need(AXIS_MODES.includes(f.mode), 'model.file.bad.the_axis_type');
      Object.assign(g, { mode: f.mode, planes: planes(2), points: points(2), face: opt(f.face, R.faceRef, 'model.file.in.its_face'), edge: opt(f.edge, R.edgeRef, 'model.file.in.its_edge') });
      return true;
    case 'point':
      need(POINT_MODES.includes(f.mode), 'model.file.bad.the_point_type'); need(f.p === undefined || vec3(f.p), 'model.file.bad.the_coordinates');
      Object.assign(g, { mode: f.mode, points: points(2), edge: opt(f.edge, R.edgeRef, 'model.file.in.its_edge'), p: f.p ? [...f.p] : [0, 0, 0] });
      // the "between objects" modes (refgeom.js mid / meet / planes3): their fields are written only when used
      if (f.planes !== undefined && f.planes !== null) g.planes = planes(3);
      if (f.axis !== undefined && f.axis !== null) g.axis = opt(f.axis, (a) => c.readDir(a, c.ids, c.types), 'model.file.in.its_axis');
      if (f.face !== undefined && f.face !== null) g.face = opt(f.face, R.faceRef, 'model.file.in.its_face');
      if (f.flip === true) g.flip = true;
      return true;
    case 'sweep':
      need(c.types.get(f.sketch) === 'sketch', 'model.file.bad.its_profile_sketch'); need(OPS.includes(f.op), 'model.file.bad.the_operation'); need(ORIENTS.includes(f.orient), 'model.file.bad.the_orientation');
      need(num(f.scale ?? 1, 1e-3, 1e3), 'model.file.bad.the_end_scale');
      Object.assign(g, { sketch: f.sketch, path: wrap(() => R.list(f.path, R.pathItem, 200, 'model.file.list.the_path'), 'model.file.in.its_path'), op: f.op, orient: f.orient,
        binormal: opt(f.binormal, (a) => c.readDir(a, c.ids, c.types), 'model.file.in.its_direction'), guide: opt(f.guide, (v) => R.list(v, R.pathItem, 200, 'model.file.list.the_guide'), 'model.file.in.its_guide'), scale: f.scale ?? 1 });
      return true;
    case 'loft':
      need(OPS.includes(f.op), 'model.file.bad.the_operation');
      g.sections = wrap(() => R.list(f.sections, (s) => {
        if (s && typeof s.sketch === 'string') { if (c.types.get(s.sketch) !== 'sketch') throw new Error(tr('model.design_features.ref.a_section_sketch_is_bad')); return { sketch: s.sketch }; }
        if (s && s.face) return { face: R.faceRef(s.face) };
        if (s && s.point) return { point: R.pointRef(s.point) };
        throw new Error(tr('model.design_features.ref.a_section_is_bad'));
      }, 100, 'model.file.list.the_section_list'), 'model.file.in.its_sections');
      Object.assign(g, { op: f.op, ruled: f.ruled === true });
      if (f.rails !== undefined && f.rails !== null) { const r = wrap(() => R.list(f.rails, R.pathItem, 200, 'model.file.list.the_rail_list'), 'model.file.in.its_guide_rails'); if (r.length) g.rails = r; }
      if (f.railTol !== undefined) { need(num(f.railTol, 1e-7, 10), 'model.file.bad.the_rail_tolerance'); g.railTol = f.railTol; }
      return true;
    case 'draft':
      need(num(f.angle, -89, 89), 'model.file.bad.the_angle');
      Object.assign(g, { faces: wrap(() => R.list(f.faces, R.faceRef, 500, 'model.file.list.the_face_list'), 'model.file.in.its_faces'), neutral: wrap(() => c.readPlane(f.neutral, c.ids, c.types), 'model.file.in.its_neutral_plane'),
        pull: opt(f.pull, (a) => c.readDir(a, c.ids, c.types), 'model.file.in.its_pull_direction'), angle: f.angle });
      return true;
    case 'extrude': {
      need(f.offset === undefined || num(f.offset, -1e6, 1e6), 'model.file.bad.the_offset'); need(f.depth2 === undefined || num(f.depth2, 1e-6, 1e6), 'model.file.bad.the_second_depth');
      need(f.taper === undefined || num(f.taper, -89, 89), 'model.file.bad.the_taper_angle');
      need(f.regions === undefined || f.regions === null || (Array.isArray(f.regions) && f.regions.length <= 200 && f.regions.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => num(v)))), 'model.file.bad.the_picked_regions');
      const extra = { upto: opt(f.upto, (p) => c.readPlane(p, c.ids, c.types), 'model.file.in.the_face_it_goes_up_to'), vertex: opt(f.vertex, R.pointRef, 'model.file.in.its_vertex'),
        offset: f.offset ?? 0, two: f.two === true, depth2: f.depth2 ?? 10, taper: f.taper ?? 0, regions: Array.isArray(f.regions) ? f.regions.map((p) => [...p]) : null };
      // only written back when used, so an old part reads back byte-for-byte the same
      for (const [k, v] of Object.entries(extra)) if (JSON.stringify(v) !== JSON.stringify(EXTRUDE_EXTRA[k])) g[k] = v;
      return true;
    }
    case 'hole': {
      need(f.csinkD === undefined || num(f.csinkD, 1e-6, 1e6), 'model.file.bad.the_countersink_diameter'); need(f.csinkAngle === undefined || [90, 82].includes(f.csinkAngle), 'model.file.bad.the_countersink_angle');
      need(f.size === undefined || Object.hasOwn(ISO_COARSE, f.size), 'model.file.bad.the_thread_size'); need(f.threadDepth === undefined || f.threadDepth === null || num(f.threadDepth, 1e-6, 1e6), 'model.file.bad.the_thread_depth');
      if (f.kind === 'csink' || f.kind === 'tapped' || f.csinkD !== undefined || f.size !== undefined) Object.assign(g, { csinkD: f.csinkD ?? 12, csinkAngle: f.csinkAngle ?? 90, size: f.size ?? 'M6', threadDepth: f.threadDepth ?? null });
      return true;
    }
    case 'chamfer':
      need(f.mode === undefined || ['equal', 'two', 'angle'].includes(f.mode), 'model.file.bad.the_chamfer_type'); need(f.d2 === undefined || num(f.d2, 1e-6, 1e5), 'model.file.bad.the_second_distance');
      need(f.angle === undefined || num(f.angle, 1e-3, 89.999), 'model.file.bad.the_angle');
      if (f.mode && f.mode !== 'equal') Object.assign(g, { mode: f.mode, d2: f.d2 ?? g.d, angle: f.angle ?? 45, flip: f.flip === true });
      return true;
    case 'fillet':
      need(f.r2 === undefined || f.r2 === null || num(f.r2, 1e-6, 1e5), 'model.file.bad.the_end_radius');
      if (typeof f.r2 === 'number') Object.assign(g, { r2: f.r2, flip: f.flip === true });
      return true;
  }
  return false;
}

/** Does this part use anything a version-2 reader would refuse? (Its file then says version 3.) */
export function usesDesign(part) {
  return part.features.some((f) => DESIGN_LABELS[f.type] || ['upto', 'next', 'vertex', 'offset'].includes(f.end) || f.two || f.taper || f.regions
    || f.kind === 'csink' || f.kind === 'tapped' || (f.mode && f.type === 'chamfer' && f.mode !== 'equal') || typeof f.r2 === 'number'
    || (f.type === 'revolve' && f.axis && typeof f.axis === 'object')
    || (f.plane && f.plane.kind === 'ref') || [f.dir, f.axis].some((d) => d && typeof d === 'object' && d.kind === 'ref'));
}
