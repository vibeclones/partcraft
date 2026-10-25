/* SPDX-License-Identifier: Apache-2.0 */
/**
 * surface.js — surface bodies and the freeform features of the part history (DOM-free; OCCT is passed in).
 *
 * Data side (part.js reads these): features
 *   form       { cage: form.js cage, op: new|add|cut|intersect, level: null (auto) | 0–3 }  a closed cage is a solid tool;
 *              an open one becomes a surface body. Faces `<id>.face:<cage face>_<k>` (k-th patch of that cage face).
 *   patch      { edges:[EdgeRef] | [], sheet: id|null, at:[x,y,z]|null, cont: G0|G1 }  fills a closed loop of body edges,
 *              or the open boundary of a surface body nearest `at` (G1: tangent to that surface). Face `<id>.patch:0`.
 *   surfloft   { sketches:[sketch id] }  a surface through one curve chain per sketch (open or closed), not ruled. `<id>.loft:<i>`.
 *   stitch     { sheets:[id], op, tol }  sews surface bodies; closed → a solid tool. Uses the sheets up.
 *   thicken    { sheet, t, side: out|in|both, op }  a surface body → a solid tool. The sheet's faces keep their names,
 *              the offset copies are `<name>~<id>` (`#m` the far side of a both-sides thicken), walls `<id>.side:<k>`.
 *   offsetsurf { sheet, d }  a new surface body `d` along the normals (`<name>~<id>`); the sheet stays.
 *   extendsurf { sheet, d, sides:[umin|umax|vmin|vmax] }  a one-face surface grown past its edges (same names).
 *   trimsurf   { sheet, tool: id|'body', at, keep: near|far }  splits a sheet where the tool crosses it, keeps the piece
 *              nearest `at` (or the rest).
 *   gordon     { profiles:[Curve], guides:[Curve], tol, solid, op }  one B-spline surface through a curve network
 *              (gordon.js); Curve = { sketch, entities? } (each chain of those sketch curves is one curve) | { edge: EdgeRef }.
 *              Face `<id>.gordon:0`; solid: closed profiles (or guides) capped by flat end faces `<id>.start|end`.
 * A feature that makes a surface body keeps it under its own id (`ctx.sheets`); stitch/thicken/extend/trim use theirs up.
 *
 * Shape side (also usable alone; each returns a fresh shape the caller deletes, or uses `opts.T` for an arena):
 *   fillShape(oc, edges, { supports, T })        BRepOffsetAPI_MakeFilling (degree 3, 15 points per edge, 2 iterations)
 *   loftShape(oc, wires, { solid, ruled, T })   BRepOffsetAPI_ThruSections
 *   thickenShape(oc, sheet, t, { side, T })     BRepOffsetAPI_MakeThickSolid.MakeThickSolidBySimple (oriented outward)
 *   offsetShape(oc, sheet, d, { T })            BRepOffsetAPI_MakeOffsetShape.PerformBySimple
 *   stitchShapes(oc, shapes, { tol, T })        BRepBuilderAPI_Sewing → MakeSolid when closed
 *   extendFace(oc, face, d, sides, { T })       BRepLib::ExtendFace
 *   trimShape(oc, sheet, tool, at, keep, { T }) BRepAlgoAPI_Splitter, pieces split at the section edges
 *   bsplineSurface(oc, T, s)                    a gordon.js surface { pu, pv, U, V, P } as a Geom_BSplineSurface
 *   curvature(mesh)                             discrete Gaussian (angle deficit / mixed area) and mean (cotangent
 *                                               Laplacian) curvature per vertex, for the curvature map
 *   zebra(n, view, stripes)                     the zebra stripe value of a unit normal (reflection-line test)
 */
import * as V from './vec.js';
import * as FM from './form.js';
import { formShape, sewFaces } from './form-brep.js';
import { pointXY, arcAngles, extent, splineCurve } from './sketch.js';
import * as SP from './sketch-spline.js';
import * as GD from './gordon.js';
import { t as tr } from './i18n.js';

// the types' names for people, read when shown (getters: never translated at import; part.js keeps them getters)
export const SURFACE_LABELS = {
  get form() { return tr('model.feature.form'); },
  get patch() { return tr('model.feature.patch'); },
  get surfloft() { return tr('model.feature.surfloft'); },
  get stitch() { return tr('model.feature.stitch'); },
  get thicken() { return tr('model.feature.thicken'); },
  get offsetsurf() { return tr('model.feature.offsetsurf'); },
  get extendsurf() { return tr('model.feature.extendsurf'); },
  get trimsurf() { return tr('model.feature.trimsurf'); },
  get gordon() { return tr('model.feature.gordon'); },
};
export const SURFACE_BASE = { form: 'Form', patch: 'Patch', surfloft: 'LoftSurface', stitch: 'Stitch', thicken: 'Thicken', offsetsurf: 'OffsetSurface', extendsurf: 'Extend', trimsurf: 'Trim', gordon: 'Gordon' };
export const SURFACE_EXACT_ONLY = Object.keys(SURFACE_LABELS);
export const SURFACE_OPS = ['new', 'add', 'cut', 'intersect'];
export const EXTEND_SIDES = ['umin', 'umax', 'vmin', 'vmax'];
export const SURFACE_DEFAULTS = {
  form: () => ({ cage: FM.box(2, 2, 2, 100, 100, 100), op: 'new', level: null }),
  patch: () => ({ edges: [], sheet: null, at: null, cont: 'G0' }),
  surfloft: () => ({ sketches: [] }),
  stitch: () => ({ sheets: [], op: 'new', tol: 0.01 }),
  thicken: () => ({ sheet: null, t: 2, side: 'out', op: 'new' }),
  offsetsurf: () => ({ sheet: null, d: 5 }),
  extendsurf: () => ({ sheet: null, d: 10, sides: [...EXTEND_SIDES] }),
  trimsurf: () => ({ sheet: null, tool: null, at: null, keep: 'near' }),
  gordon: () => ({ profiles: [], guides: [], tol: 0.01, solid: false, op: 'new' }),   // tangent: [PlaneRef] only when set (0.4 P11)
};
const NET_KEYS = ['profiles', 'guides'];
// the reader's "{name}: … is bad." keys for each curve family of a network (whole sentences, so each translates as one)
const NET_BAD = {
  profiles: { list: 'model.file.bad.its_profiles', curve: 'model.file.bad.a_curve_of_its_profiles', edge: 'model.file.bad.an_edge_of_its_profiles', sketch: 'model.file.bad.a_sketch_of_its_profiles', picked: 'model.file.bad.the_curves_picked_from_a_sketch_of_its_profiles' },
  guides: { list: 'model.file.bad.its_guides', curve: 'model.file.bad.a_curve_of_its_guides', edge: 'model.file.bad.an_edge_of_its_guides', sketch: 'model.file.bad.a_sketch_of_its_guides', picked: 'model.file.bad.the_curves_picked_from_a_sketch_of_its_guides' },
};
/** Feature ids in a face name (part.js nameFeatures' rule). */
const idsIn = (name) => { const out = []; const m = /^(f\d+)\./.exec(name || ''); if (m) out.push(m[1]); for (const k of String(name || '').matchAll(/[@~](f\d+)/g)) out.push(k[1]); return out; };

/** Feature ids a surface feature uses (beyond edges/faces, which part.js reads). */
export function surfaceDeps(f) {
  const d = [];
  if (!SURFACE_LABELS[f.type]) return d;
  if (typeof f.sheet === 'string') d.push(f.sheet);
  if (Array.isArray(f.sheets)) d.push(...f.sheets);
  if (typeof f.tool === 'string' && f.tool !== 'body') d.push(f.tool);
  if (Array.isArray(f.sketches)) d.push(...f.sketches);
  if (f.type === 'gordon') for (const k of NET_KEYS) for (const c of f[k] || []) { if (c.sketch) d.push(c.sketch); if (c.edge) for (const n of c.edge.faces) d.push(...idsIn(n)); }
  if (f.type === 'gordon') for (const p of f.tangent || []) { if (p.kind === 'ref') d.push(p.feature); if (p.kind === 'face') { d.push(p.feature); if (p.name) d.push(...idsIn(p.name)); } }   // 0.4 P11
  return d;
}
export const usesSurface = (part) => part.features.some((f) => SURFACE_LABELS[f.type]);

const num = (v, lo = -1e9, hi = 1e9) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -1e7, 1e7));

/** Untrusted surface feature f → clean fields on g (c = part.js readers: ids, types, goodName, nameFeatures). */
export function readSurface(f, g, c) {
  // keys: model.file.bad.* = "{name}: … is bad."
  const need = (cond, key) => { if (!cond) throw new Error(tr(key, { name: g.name })); };
  const sheetRef = (id) => { need(typeof id === 'string' && c.ids.has(id) && SURFACE_LABELS[c.types.get(id)], 'model.file.bad.its_surface'); return id; };
  const op = () => { need(SURFACE_OPS.includes(f.op), 'model.file.bad.the_operation'); return f.op; };
  switch (f.type) {
    case 'form': {
      let cage;
      try { cage = FM.readForm(f.cage); } catch (e) { throw new Error(tr('model.surface.form_bad', { name: g.name, problem: e.message })); }
      need(cage.faces.length > 0, 'model.file.bad.its_cage');
      need(f.level === null || f.level === undefined || (Number.isInteger(f.level) && f.level >= 0 && f.level <= 3), 'model.file.bad.the_level');
      Object.assign(g, { cage, op: op(), level: f.level ?? null }); break;
    }
    case 'patch': {
      need(Array.isArray(f.edges) && f.edges.length <= 500, 'model.file.bad.its_edge_list');
      g.edges = f.edges.map((e) => {
        need(e && Array.isArray(e.faces) && e.faces.length === 2 && e.faces.every(c.goodName) && e.faces.every((n) => c.nameFeatures(n).every((x) => c.ids.has(x))), 'model.file.bad.an_edge_reference');
        need(e.at === undefined || vec3(e.at), 'model.file.bad.an_edge_position');
        return { faces: [...e.faces], ...(e.at ? { at: [...e.at] } : {}) };
      });
      g.sheet = f.sheet === null || f.sheet === undefined ? null : sheetRef(f.sheet);
      need(!!g.sheet !== !!g.edges.length || (!g.sheet && !g.edges.length), 'model.file.bad.its_boundary_edges_or_a_surface_not_both');
      need(f.at === null || f.at === undefined || vec3(f.at), 'model.file.bad.its_position');
      need(['G0', 'G1'].includes(f.cont ?? 'G0'), 'model.file.bad.the_continuity');
      Object.assign(g, { at: f.at ? [...f.at] : null, cont: f.cont ?? 'G0' }); break;
    }
    case 'surfloft':
      need(Array.isArray(f.sketches) && f.sketches.length <= 50 && f.sketches.every((s) => c.ids.has(s) && c.types.get(s) === 'sketch') && new Set(f.sketches).size === f.sketches.length, 'model.file.bad.its_sketches');
      g.sketches = [...f.sketches]; break;
    case 'stitch':
      need(Array.isArray(f.sheets) && f.sheets.length <= 200 && new Set(f.sheets).size === f.sheets.length, 'model.file.bad.its_surfaces');
      g.sheets = f.sheets.map(sheetRef);
      need(num(f.tol ?? 0.01, 1e-7, 10), 'model.file.bad.the_tolerance');
      Object.assign(g, { op: op(), tol: f.tol ?? 0.01 }); break;
    case 'thicken':
      g.sheet = f.sheet === null ? null : sheetRef(f.sheet);
      need(num(f.t, 1e-6, 1e5), 'model.file.bad.the_thickness'); need(['out', 'in', 'both'].includes(f.side), 'model.file.bad.the_side');
      Object.assign(g, { t: f.t, side: f.side, op: op() }); break;
    case 'offsetsurf':
      g.sheet = f.sheet === null ? null : sheetRef(f.sheet);
      need(num(f.d, -1e5, 1e5) && f.d !== 0, 'model.file.bad.the_distance');
      g.d = f.d; break;
    case 'extendsurf':
      g.sheet = f.sheet === null ? null : sheetRef(f.sheet);
      need(num(f.d, 1e-6, 1e5), 'model.file.bad.the_distance');
      need(Array.isArray(f.sides) && f.sides.length >= 1 && f.sides.every((s) => EXTEND_SIDES.includes(s)), 'model.file.bad.the_sides');
      Object.assign(g, { d: f.d, sides: [...new Set(f.sides)] }); break;
    case 'trimsurf':
      g.sheet = f.sheet === null ? null : sheetRef(f.sheet);
      need(f.tool === null || f.tool === 'body' || (typeof f.tool === 'string' && c.ids.has(f.tool) && SURFACE_LABELS[c.types.get(f.tool)] && f.tool !== f.sheet), 'model.file.bad.its_cutting_tool');
      need(f.at === null || f.at === undefined || vec3(f.at), 'model.file.bad.the_point_to_keep');
      need(['near', 'far'].includes(f.keep), 'model.file.bad.which_piece_to_keep');
      Object.assign(g, { tool: f.tool, at: f.at ? [...f.at] : null, keep: f.keep }); break;
    case 'gordon':
      for (const k of NET_KEYS) {
        const B = NET_BAD[k];
        need(Array.isArray(f[k]) && f[k].length <= 200, B.list);
        g[k] = f[k].map((x) => {
          need(x && typeof x === 'object', B.curve);
          if (x.edge !== undefined) {
            const e = x.edge;
            need(e && Array.isArray(e.faces) && e.faces.length === 2 && e.faces.every(c.goodName) && e.faces.every((n) => c.nameFeatures(n).every((y) => c.ids.has(y))) && (e.at === undefined || vec3(e.at)), B.edge);
            return { edge: { faces: [...e.faces], ...(e.at ? { at: [...e.at] } : {}) } };
          }
          need(typeof x.sketch === 'string' && c.ids.has(x.sketch) && c.types.get(x.sketch) === 'sketch', B.sketch);
          need(x.entities === undefined || (Array.isArray(x.entities) && x.entities.length >= 1 && x.entities.length <= 5000 && x.entities.every((y) => typeof y === 'string' && y.length <= 40)), B.picked);
          return { sketch: x.sketch, ...(x.entities ? { entities: [...x.entities] } : {}) };
        });
      }
      // 0.4 P11: planes the surface leaves tangent to, along the boundary curve lying in each
      need(f.tangent === undefined || (Array.isArray(f.tangent) && f.tangent.length <= 4), 'model.file.bad.its_tangent_planes');
      if (Array.isArray(f.tangent) && f.tangent.length) g.tangent = f.tangent.map((p) => c.readPlane(p, c.ids, c.types));
      need(num(f.tol ?? 0.01, 1e-7, 10), 'model.file.bad.the_tolerance');
      Object.assign(g, { tol: f.tol ?? 0.01, solid: f.solid === true, op: op() }); break;
  }
}

// ---------------------------------------------------------------- shape side

function arenaOf(T) {
  if (T) return { T, done: (s) => s };
  const live = [];
  const A = (o) => { if (o && typeof o.delete === 'function') live.push(o); return o; };
  const free = () => { for (const o of live) { try { if (!o.isDeleted || !o.isDeleted()) o.delete(); } catch { /* gone */ } } live.length = 0; };
  return { T: A, done: (s) => { const out = s.Oriented(s.Orientation()); free(); return out; }, free };
}
const prog = (oc, T) => T(new oc.Message_ProgressRange());
function explore(oc, T, s, type) {
  const out = [];
  const ex = T(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum['TopAbs_' + type], oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) out.push(T(ex.Current()));
  return out;
}
function listOf(oc, T, l) {
  const out = [];
  if (!l) return out;
  T(l);
  const c = T(new oc.NCollection_List_TopoDS_Shape(l));
  while (!c.IsEmpty()) { const f = T(c.First()); out.push(T(f.Oriented(f.Orientation()))); c.RemoveFirst(); }
  return out;
}
function volumeOf(oc, T, s) { const g = T(new oc.GProp_GProps()); oc.BRepGProp.VolumeProperties(s, g, false, false, false); return g.Mass(); }
function centroidOf(oc, T, s) { const g = T(new oc.GProp_GProps()); oc.BRepGProp.SurfaceProperties(s, g, false, false); const c = T(g.CentreOfMass()); return [c.X(), c.Y(), c.Z()]; }
function distTo(oc, T, p, shape) {
  const v = T(T(new oc.BRepBuilderAPI_MakeVertex(T(new oc.gp_Pnt(p[0], p[1], p[2])))).Vertex());
  const d = T(new oc.BRepExtrema_DistShapeShape(v, shape, 1e-9, undefined, undefined, prog(oc, T)));
  return d.IsDone() ? d.Value() : Infinity;
}
class SurfaceError extends Error {}
const sfail = (m) => { throw new SurfaceError(m); };

/** A filling surface through closed boundary edges (and tangent to `supports[i]` faces where given). */
export function fillShape(oc, edges, { supports = null, T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  const mk = T(new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9));
  edges.forEach((e, i) => {
    const E = T(oc.TopoDS.Edge(e));
    const sup = supports && supports[i];
    if (sup) mk.Add(E, T(oc.TopoDS.Face(sup)), oc.GeomAbs_Shape.GeomAbs_G1, true);
    else mk.Add(E, oc.GeomAbs_Shape.GeomAbs_C0, true);
  });
  try { mk.Build(prog(oc, T)); } catch { sfail(tr('model.surface.the_patch_could_not_be_made')); }
  if (!mk.IsDone()) sfail(tr('model.surface.the_patch_could_not_be_made'));
  const g0 = mk.G0Error(), g1 = supports ? mk.G1Error() : 0;
  return { shape: done(T(mk.Shape())), g0, g1 };
}

/** A lofted surface (or solid) through wires in order. */
export function loftShape(oc, wires, { solid = false, ruled = false, T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  if (wires.length < 2) sfail(tr('model.surface.a_loft_needs_at_least_two_curves'));
  const mk = T(new oc.BRepOffsetAPI_ThruSections(solid, ruled, 1e-6));
  for (const w of wires) mk.AddWire(T(oc.TopoDS.Wire(w)));
  mk.CheckCompatibility(true);
  try { mk.Build(prog(oc, T)); } catch { sfail(tr('model.surface.the_loft_could_not_be_made_through')); }
  if (!mk.IsDone()) sfail(tr('model.surface.the_loft_could_not_be_made_through'));
  return { shape: done(T(mk.Shape())), mk };
}

/** A gordon.js surface (full clamped knots, poles P[i][j]) as a Geom_BSplineSurface, registered in T. */
export function bsplineSurface(oc, T, s) {
  const nu = s.P.length, nv = s.P[0].length;
  const poles = T(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const q = s.P[i][j]; poles.SetValue(i + 1, j + 1, T(new oc.gp_Pnt(q[0], q[1], q[2]))); }
  const arr = (vals, Ctor) => { const a = T(new Ctor(1, vals.length)); vals.forEach((v, i) => a.SetValue(i + 1, v)); return a; };
  const ku = GD.knotsToMults(s.U), kv = GD.knotsToMults(s.V);
  return T(new oc.Geom_BSplineSurface(poles, arr(ku.k, oc.NCollection_Array1_double), arr(kv.k, oc.NCollection_Array1_double), arr(ku.m, oc.NCollection_Array1_int), arr(kv.m, oc.NCollection_Array1_int), s.pu, s.pv, false, false));
}

/** Thicken a surface into a solid: out (along its normal), in, or both (half each way). */
export function thickenShape(oc, sheet, t, { side = 'out', T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  if (!(t > 0)) sfail(tr('model.surface.the_thickness_must_be_more_than_zero'));
  let base = sheet;
  if (side === 'both') base = offsetShape(oc, sheet, -t / 2, { T }).shape;
  const mk = T(new oc.BRepOffsetAPI_MakeThickSolid());
  try { mk.MakeThickSolidBySimple(base, side === 'in' ? -t : t); mk.Build(prog(oc, T)); } catch { sfail(tr('model.surface.the_surface_could_not_be_thickened')); }
  if (!mk.IsDone()) sfail(tr('model.surface.the_surface_could_not_be_thickened'));
  let s = T(mk.Shape());
  const solids = explore(oc, T, s, 'SOLID');
  if (!solids.length) sfail(tr('model.surface.thickening_made_no_solid'));
  if (volumeOf(oc, T, s) < 0) s = T(s.Reversed());
  return { shape: done(s) };
}

/** Offset a surface along its normals. */
export function offsetShape(oc, sheet, d, { T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  const mk = T(new oc.BRepOffsetAPI_MakeOffsetShape());
  try { mk.PerformBySimple(sheet, d); } catch { sfail(tr('model.surface.the_surface_could_not_be_offset')); }
  if (!mk.IsDone()) sfail(tr('model.surface.the_surface_could_not_be_offset'));
  return { shape: done(T(mk.Shape())), mk };
}

/** Sew shapes; closed → { shape: solid, closed: true }. */
export function stitchShapes(oc, shapes, { tol = 0.01, T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  const faces = shapes.flatMap((s) => explore(oc, T, s, 'FACE'));
  if (!faces.length) sfail(tr('model.surface.there_are_no_surfaces_to_stitch'));
  const r = sewFaces(oc, T, faces, tol);
  return { shape: done(r.shape), closed: r.closed, free: r.free, sew: r.sew, faces };
}

/** Grow a one-face surface by d on the chosen parameter sides. */
export function extendFace(oc, face, d, sides = EXTEND_SIDES, { T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  const out = T(new oc.TopoDS_Face());
  try { oc.BRepLib.ExtendFace(T(oc.TopoDS.Face(face)), d, sides.includes('umin'), sides.includes('umax'), sides.includes('vmin'), sides.includes('vmax'), out); } catch { sfail(tr('model.surface.the_surface_could_not_be_extended')); }
  if (out.IsNull()) sfail(tr('model.surface.the_surface_could_not_be_extended'));
  return { shape: done(out) };
}

/**
 * Split a sheet where a tool crosses it and keep the connected piece nearest `at` ('near') or every
 * other piece ('far'). → { shape, pieces, kept, split (the splitter, for history) }
 */
export function trimShape(oc, sheet, tool, at, keep = 'near', { T: T0 = null } = {}) {
  const { T, done } = arenaOf(T0);
  const sp = T(new oc.BRepAlgoAPI_Splitter());
  const la = T(new oc.NCollection_List_TopoDS_Shape()); la.Append(sheet);
  const lt = T(new oc.NCollection_List_TopoDS_Shape()); lt.Append(tool);
  sp.SetArguments(la); sp.SetTools(lt); sp.SetRunParallel(false);
  try { sp.Build(prog(oc, T)); } catch { sfail(tr('model.surface.the_surface_could_not_be_trimmed')); }
  if (!sp.IsDone() || sp.HasErrors()) sfail(tr('model.surface.the_surface_could_not_be_trimmed'));
  const res = T(sp.Shape());
  const hash = (s) => oc.ReplicadShapeHasher.HashCode(s, 2147483647);
  const section = listOf(oc, T, sp.SectionEdges());
  const isSection = (e) => section.some((s) => hash(s) === hash(e) && s.IsSame(e));
  const faces = explore(oc, T, res, 'FACE');
  // components: faces joined by a shared edge that is not a section edge
  const parent = faces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byEdge = new Map();
  faces.forEach((f, i) => {
    for (const e of explore(oc, T, f, 'EDGE')) {
      if (isSection(e)) continue;
      const h = hash(e);
      const l = byEdge.get(h) || [];
      const hit = l.find((x) => x.e.IsSame(e));
      if (hit) parent[find(i)] = find(hit.i); else { l.push({ e, i }); byEdge.set(h, l); }
    }
  });
  const groups = new Map();
  faces.forEach((f, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  if (groups.size < 2) sfail(tr('model.surface.the_tool_does_not_cut_the_surface'));
  let best = null, bd = Infinity;
  for (const [r, idx] of groups) for (const i of idx) { const d = at ? distTo(oc, T, at, faces[i]) : 0; if (d < bd) { bd = d; best = r; } }
  const keepIdx = keep === 'near' ? groups.get(best) : [...groups].filter(([r]) => r !== best).flatMap(([, l]) => l);
  const b = T(new oc.TopoDS_Builder());
  const comp = T(new oc.TopoDS_Compound());
  b.MakeCompound(comp);
  for (const i of keepIdx) b.Add(comp, faces[i]);
  return { shape: done(comp), pieces: groups.size, kept: keepIdx.length, split: sp };
}

// ---------------------------------------------------------------- analysis (pure JS on a triangle mesh)

/**
 * Discrete curvature per vertex of a closed or open triangle mesh { positions, indices }:
 *   gauss = (2π − Σ angles) / A_mixed   (π − Σ on boundary vertices, so open edges read near 0)
 *   mean  = |Σ (cot α + cot β)(p_i − p_j)| / (4 A_mixed), signed by the vertex normal
 * (Meyer, Desbrun, Schröder, Barr 2003, with the barycentric area as A_mixed). On a sphere of radius r:
 * gauss → 1/r², mean → 1/r as the mesh is refined.
 */
export function curvature(mesh) {
  const P = mesh.positions, I = mesh.indices;
  const n = P.length / 3;
  const angle = new Float64Array(n), area = new Float64Array(n);
  const lap = new Float64Array(n * 3), nrm = new Float64Array(n * 3);
  const p = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const edgeCount = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]];
    const q = ids.map(p);
    const cr = V.cross(V.sub(q[1], q[0]), V.sub(q[2], q[0]));
    const A = V.len(cr) / 2;
    if (!(A > 0)) continue;
    for (let k = 0; k < 3; k++) {
      const i = ids[k], j = ids[(k + 1) % 3], l = ids[(k + 2) % 3];
      const a = V.sub(q[(k + 1) % 3], q[k]), b = V.sub(q[(k + 2) % 3], q[k]);
      angle[i] += Math.atan2(V.len(V.cross(a, b)), V.dot(a, b));
      area[i] += A / 3;
      for (let c = 0; c < 3; c++) nrm[i * 3 + c] += cr[c];
      // cot of the angle at l, opposite edge (i, j)
      const u = V.sub(q[k], q[(k + 2) % 3]), w = V.sub(q[(k + 1) % 3], q[(k + 2) % 3]);
      const cot = V.dot(u, w) / V.len(V.cross(u, w));
      const d = V.sub(q[k], q[(k + 1) % 3]);
      for (let c = 0; c < 3; c++) { lap[i * 3 + c] += cot * d[c]; lap[j * 3 + c] -= cot * d[c]; }
      const key = i < j ? i + ',' + j : j + ',' + i;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      void l;
    }
  }
  const boundary = new Uint8Array(n);
  for (const [k, c] of edgeCount) if (c === 1) for (const v of k.split(',')) boundary[+v] = 1;
  const gauss = new Float64Array(n), mean = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!(area[i] > 0)) continue;
    gauss[i] = ((boundary[i] ? Math.PI : 2 * Math.PI) - angle[i]) / area[i];
    const L = [lap[i * 3], lap[i * 3 + 1], lap[i * 3 + 2]];
    const N = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
    mean[i] = boundary[i] ? 0 : (V.dot(L, N) >= 0 ? 1 : -1) * V.len(L) / (4 * area[i]);
  }
  return { gauss, mean, boundary };
}

/** Zebra stripe value (0 or 1) of a unit normal seen along `view`: stripes of a vertical reflected light pattern. */
export function zebra(n, view = [0, 0, -1], stripes = 12) {
  const d = V.norm(view);
  const r = V.sub(d, V.mul(n, 2 * V.dot(d, n)));   // reflected view ray
  const a = Math.atan2(r[0], r[2]);
  return Math.floor((a / Math.PI + 1) * stripes / 2) % 2;
}

// ---------------------------------------------------------------- features in the part history (brep.js installs them)

/** Display meshes of the surface bodies left after a rebuild: [{ feature, positions, indices }]. */
export function sheetMeshes(ctx) {
  const out = [];
  if (!ctx.sheets) return out;
  const { oc, T } = ctx;
  for (const [id, sh] of ctx.sheets) {
    try {
      const bb = ctx.bbox(sh.shape);
      const diag = Math.max(1e-6, V.len(V.sub(bb.max, bb.min)));
      const md = T(oc.ReplicadMeshExtractor.extract(sh.shape, diag * 2e-4, 2 * Math.PI / 64, false));
      const mem = oc.wasmMemory.buffer;
      const positions = new Float32Array(mem, md.getVerticesPtr(), md.getVerticesSize()).slice();
      const indices = Uint32Array.from(new Int32Array(mem, md.getTrianglesPtr(), md.getTrianglesSize()));
      oc.BRepTools.Clean(sh.shape, true);
      let area = 0;
      for (const f of explore(oc, T, sh.shape, 'FACE')) { const g = T(new oc.GProp_GProps()); oc.BRepGProp.SurfaceProperties(f, g, false, false); area += g.Mass(); }
      out.push({ feature: id, positions, indices, area, faces: [...sh.names.entries()].length });
    } catch { /* a sheet that cannot be meshed is left out of the view */ }
  }
  return out;
}

/** Add the surface features to brep.js's FEATURES table (lib: brep.js internals — fail, SMap, sketchOf, splineGeom, nearest, describeName). */
export function installSurface(FEATURES, lib) {
  const { fail, SMap, sketchOf, splineGeom, nearest, describeName, resolvePlane } = lib;
  // our own plain messages (surface.js, form-brep.js, form.js) become feature errors; OCCT exceptions and bugs pass through
  const guard = (fn) => (f, ctx) => {
    try { return fn(f, ctx); } catch (e) { if (e instanceof SurfaceError || (e instanceof Error && (e.constructor === Error || e.constructor.name === 'FormError' || e instanceof GD.GordonError))) fail(e.message); throw e; }
  };
  const sheets = (ctx) => (ctx.sheets ||= new Map());
  const getSheet = (ctx, id) => {
    const s = sheets(ctx).get(id);
    if (!s) { const g = ctx.part.features.find((x) => x.id === id); fail(g ? tr('model.surface.not_surface_body', { name: g.name }) : tr('model.surface.not_surface_body_unnamed')); }
    return s;
  };
  const report = (ctx, f, data) => { const r = ctx.results.get(f.id); if (r) Object.assign(r, data); };
  const sizeOf = (ctx, s) => { const bb = ctx.bbox(s); return Math.max(1, V.len(V.sub(bb.max, bb.min))); };

  /** Free (boundary) edges of a sheet grouped into loops: [{ edges, faces (the face of each edge) }]. */
  const freeLoops = (ctx, sh) => {
    const { oc, T, H } = ctx;
    const byEdge = new SMap(H.hash), list = [];
    for (const face of H.unique(sh, 'FACE')) for (const e of H.explore(face, 'EDGE')) {   // a seam edge shows twice in its face: not free
      let x = byEdge.get(e);
      if (!x) { x = { e, faces: [] }; byEdge.set(e, x); list.push(x); }
      x.faces.push(face);
    }
    const free = list.filter((x) => x.faces.length === 1 && !oc.BRep_Tool.Degenerated(T(oc.TopoDS.Edge(x.e))));
    const vkey = (e) => H.explore(e, 'VERTEX').map((v) => H.xyz(T(oc.BRep_Tool.Pnt(T(oc.TopoDS.Vertex(v))))));
    const ends = free.map((x) => vkey(x.e));
    const used = new Set(), loops = [];
    const same = (a, b) => V.len(V.sub(a, b)) < 1e-6 * sizeOf(ctx, sh);
    for (let i = 0; i < free.length; i++) {
      if (used.has(i)) continue;
      const loop = [i]; used.add(i);
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < free.length; j++) {
          if (used.has(j)) continue;
          if (loop.some((k) => ends[k].some((p) => ends[j].some((q) => same(p, q))))) { loop.push(j); used.add(j); grew = true; }
        }
      }
      loops.push({ edges: loop.map((k) => free[k].e), faces: loop.map((k) => free[k].faces[0]) });
    }
    return loops;
  };

  /** One curve chain of a sketch (open or closed) as a wire. */
  const sketchWire = (ctx, id) => {
    const { oc, T, H } = ctx;
    const { sk, frame } = sketchOf(ctx, id);
    const tol = 1e-6 * Math.max(1, extent(sk));
    const W = (p) => V.toWorld(frame, p[0], p[1]);
    const segs = [];
    for (const e of sk.entities) {
      if (e.construction) continue;
      if (e.type === 'line') segs.push({ e, a: pointXY(sk, e.p1), b: pointXY(sk, e.p2) });
      else if (e.type === 'arc') { const { c, r, a0, sweep } = arcAngles(sk, e); segs.push({ e, a: [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)], b: [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)], mid: [c[0] + r * Math.cos(a0 + sweep / 2), c[1] + r * Math.sin(a0 + sweep / 2)] }); }
      else if (e.type === 'circle') segs.push({ e, closed: true, c: pointXY(sk, e.c), r: e.r });
      else if (e.type === 'spline') { const bs = splineCurve(sk, e); const pts = SP.tessellate(bs, 4); segs.push({ e, bs, closed: !!e.closed, a: pts[0], b: pts[pts.length - 1] }); }
    }
    if (!segs.length) fail(tr('model.surface.a_sketch_it_lofts_through_has_no'));
    const closedOne = segs.filter((s) => s.closed);
    if (closedOne.length && segs.length > 1) fail(tr('model.surface.a_sketch_it_lofts_through'));
    const mw = T(new oc.BRepBuilderAPI_MakeWire());
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol * 10;
    const edgeOf = (s, rev) => {
      if (s.c) return T(new oc.BRepBuilderAPI_MakeEdge(T(new oc.gp_Circ(T(new oc.gp_Ax2(H.pnt(W(s.c)), H.dir(frame.n), H.dir(frame.x))), s.r)))).Edge();
      if (s.bs) return T(new oc.BRepBuilderAPI_MakeEdge(splineGeom(oc, T, rev ? SP.reverse(s.bs) : s.bs, W))).Edge();
      const [a, b] = rev ? [s.b, s.a] : [s.a, s.b];
      if (s.mid) return T(new oc.BRepBuilderAPI_MakeEdge(T(T(new oc.GC_MakeArcOfCircle(H.pnt(W(a)), H.pnt(W(s.mid)), H.pnt(W(b)))).Value()))).Edge();
      return T(new oc.BRepBuilderAPI_MakeEdge(H.pnt(W(a)), H.pnt(W(b)))).Edge();
    };
    if (closedOne.length) { mw.Add(T(edgeOf(closedOne[0], false))); return T(mw.Wire()); }
    // chain: start at an end used once (open) or anywhere (closed)
    const deg = (p) => segs.filter((s) => near(s.a, p) || near(s.b, p)).length;
    for (const s of segs) for (const p of [s.a, s.b]) if (deg(p) > 2) fail(tr('model.surface.a_sketch_it_lofts_through_branches_use'));
    let cur = segs.find((s) => deg(s.a) === 1) || segs[0];
    let rev = deg(cur.a) !== 1 && deg(cur.b) === 1;
    const used = new Set();
    for (let k = 0; k < segs.length; k++) {
      used.add(cur);
      mw.Add(T(edgeOf(cur, rev)));
      const end = rev ? cur.a : cur.b;
      const nx = segs.find((s) => !used.has(s) && (near(s.a, end) || near(s.b, end)));
      if (!nx) break;
      rev = !near(nx.a, end);
      cur = nx;
    }
    if (used.size !== segs.length) fail(tr('model.surface.a_sketch_it_lofts_through_has_curves'));
    if (!mw.IsDone()) fail(tr('model.surface.a_sketch_s_curves_do_not_join_into'));
    return T(mw.Wire());
  };

  const setSheet = (ctx, id, shape, names) => sheets(ctx).set(id, { shape, names });
  const useUp = (ctx, ...ids) => { for (const id of ids) sheets(ctx).delete(id); };

  /** Name the faces of a thickened sheet: originals by position, offset copies `~id`, walls by the nearest free edge. */
  const nameThick = (ctx, f, sh, solid, t, side) => {
    const { oc, T, H } = ctx;
    const names = new SMap(H.hash);
    const L = sizeOf(ctx, solid);
    const refs = [];   // [shape, suffix] the faces of the solid lie on
    const src = [...sh.names.entries()];
    const offs = side === 'out' ? [[0, ''], [t, `~${f.id}`]] : side === 'in' ? [[0, ''], [-t, `~${f.id}`]] : [[t / 2, `~${f.id}`], [-t / 2, `~${f.id}#m`]];
    for (const [d, suffix] of offs) {
      if (d === 0) { for (const [face, name] of src) refs.push([face, name]); continue; }
      const mk = T(new oc.BRepOffsetAPI_MakeOffsetShape());
      mk.PerformBySimple(sh.shape, d);
      if (!mk.IsDone()) continue;
      for (const [face, name] of src) for (const g of H.list(mk.Generated(face))) refs.push([g, name + suffix]);
    }
    const loops = freeLoops(ctx, sh.shape).flatMap((l) => l.edges);
    let k = 0;
    for (const rf of H.unique(solid, 'FACE')) {
      const c = centroidOf(oc, T, rf);
      let best = null, bd = Infinity;
      for (const [face, name] of refs) { const d = distTo(oc, T, c, face); if (d < bd) { bd = d; best = name; } }
      if (bd < 1e-6 * L) { names.set(rf, best); continue; }
      let ei = 0, ed = Infinity;
      loops.forEach((e, i) => { const d = distTo(oc, T, c, e); if (d < ed) { ed = d; ei = i; } });
      names.set(rf, `${f.id}.side:${loops.length ? ei : k++}`);   // i18n-ignore: face names (identifiers saved in files)
    }
    return names;
  };

  const F = {
    form(f, ctx) {
      const { T, H } = ctx;
      const res = formShape(ctx.oc, f.cage, { level: f.level, T });
      const names = new SMap(H.hash);
      for (const x of res.faceMap) names.set(x.face, `${f.id}.face:${x.root}_${x.k}`);   // i18n-ignore: face names (identifiers saved in files)
      report(ctx, f, { form: res.report, count: res.report.patches });
      if (res.closed) return { tools: [{ shape: res.shape, op: f.op, names }] };
      setSheet(ctx, f.id, res.shape, names);
      return f.op === 'new' ? {} : { warning: tr('model.surface.the_form_is_open') };
    },

    patch(f, ctx) {
      const { T, H } = ctx;
      let edges, supports = null;
      if (f.sheet) {
        const sh = getSheet(ctx, f.sheet);
        const loops = freeLoops(ctx, sh.shape);
        if (!loops.length) fail(tr('model.surface.that_surface_has_no_open_edges'));
        let loop = loops[0];
        if (loops.length > 1) {
          if (!f.at) fail(tr('model.surface.that_surface_has_several_openings_pick'));
          let bd = Infinity;
          for (const l of loops) for (const e of l.edges) { const d = distTo(ctx.oc, T, f.at, e); if (d < bd) { bd = d; loop = l; } }
        }
        edges = loop.edges;
        if (f.cont === 'G1') supports = loop.faces;
      } else {
        if (!f.edges.length) fail(tr('model.surface.pick_the_edges_of_a_closed_loop'));
        if (!ctx.body) fail(tr('model.surface.there_is_no_body_so_the_edges'));
        const table = ctx.edgeTable();
        edges = f.edges.map((ref) => {
          const want = [...ref.faces].sort().join('|');
          const cands = table.filter((e) => e.key === want);
          if (!cands.length) fail(tr('model.surface.patch_edge_gone', { a: describeName(ctx.part, ref.faces[0]), b: describeName(ctx.part, ref.faces[1]) }));
          return nearest(cands, ref.at, (e) => e.at).edge;
        });
      }
      const r = fillShape(ctx.oc, edges, { supports, T });
      const names = new SMap(H.hash);
      for (const face of H.unique(r.shape, 'FACE')) names.set(face, `${f.id}.patch:0`);   // i18n-ignore: face names (identifiers saved in files)
      setSheet(ctx, f.id, r.shape, names);
      report(ctx, f, { patch: { g0: r.g0, g1: r.g1 } });
      return {};
    },

    surfloft(f, ctx) {
      const { T, H } = ctx;
      if (f.sketches.length < 2) fail(tr('model.surface.pick_two_or_more_sketches_to_loft'));
      const wires = f.sketches.map((id) => sketchWire(ctx, id));
      const r = loftShape(ctx.oc, wires, { T });
      const names = new SMap(H.hash);
      H.unique(r.shape, 'FACE').forEach((face, i) => names.set(face, `${f.id}.loft:${i}`));   // i18n-ignore: face names (identifiers saved in files)
      setSheet(ctx, f.id, r.shape, names);
      return {};
    },

    stitch(f, ctx) {
      const { T, H } = ctx;
      if (!f.sheets.length) fail(tr('model.surface.pick_the_surfaces_to_stitch'));
      const srcs = f.sheets.map((id) => getSheet(ctx, id));
      const r = stitchShapes(ctx.oc, srcs.map((s) => s.shape), { tol: f.tol, T });
      if (!r.closed) fail(tr('model.surface.stitch_open', { n: r.free, tol: f.tol }));
      const names = new SMap(H.hash);
      const inResult = new SMap(H.hash);
      for (const rf of H.unique(r.shape, 'FACE')) inResult.set(rf, true);
      for (const s of srcs) for (const [face, name] of s.names.entries()) {
        const m = T(r.sew.Modified(face));
        if (!m.IsNull() && inResult.get(m)) names.set(m, name); else if (inResult.get(face)) names.set(face, name);
      }
      useUp(ctx, ...f.sheets);
      return { tools: [{ shape: r.shape, op: f.op, names }] };
    },

    thicken(f, ctx) {
      if (!f.sheet) fail(tr('model.surface.pick_a_surface_to_thicken'));
      const sh = getSheet(ctx, f.sheet);
      const r = thickenShape(ctx.oc, sh.shape, f.t, { side: f.side, T: ctx.T });
      const names = nameThick(ctx, f, sh, r.shape, f.t, f.side);
      useUp(ctx, f.sheet);
      return { tools: [{ shape: r.shape, op: f.op, names }] };
    },

    offsetsurf(f, ctx) {
      const { H } = ctx;
      if (!f.sheet) fail(tr('model.surface.pick_a_surface_to_offset'));
      const sh = getSheet(ctx, f.sheet);
      const r = offsetShape(ctx.oc, sh.shape, f.d, { T: ctx.T });
      const names = new SMap(H.hash);
      for (const [face, name] of sh.names.entries()) for (const g of H.list(r.mk.Generated(face))) names.set(g, `${name}~${f.id}`);
      setSheet(ctx, f.id, r.shape, names);
      return {};
    },

    extendsurf(f, ctx) {
      const { H } = ctx;
      if (!f.sheet) fail(tr('model.surface.pick_a_surface_to_extend'));
      const sh = getSheet(ctx, f.sheet);
      const faces = H.unique(sh.shape, 'FACE');
      if (faces.length !== 1) fail(tr('model.surface.extend_one_face_only', { n: faces.length }));
      const r = extendFace(ctx.oc, faces[0], f.d, f.sides, { T: ctx.T });
      const names = new SMap(H.hash);
      names.set(r.shape, sh.names.get(faces[0]) || `${f.id}.face:0`);   // i18n-ignore: face names (identifiers saved in files)
      useUp(ctx, f.sheet);
      setSheet(ctx, f.id, r.shape, names);
      return {};
    },

    gordon(f, ctx) {
      const { oc, T, H } = ctx;
      const edgeCurve = (ref) => {
        if (!ctx.body) fail(tr('model.surface.there_is_no_body_so_the_edge'));
        const want = [...ref.faces].sort().join('|');
        const cands = ctx.edgeTable().filter((e) => e.key === want);
        const fa = describeName(ctx.part, ref.faces[0]), fb = describeName(ctx.part, ref.faces[1]);
        const words = tr('model.surface.edge_between', { a: fa, b: fb });
        if (!cands.length) fail(tr('model.surface.net_curve_gone', { a: fa, b: fb }));
        const rec = nearest(cands, ref.at, (e) => e.at);
        const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(rec.edge))));
        const a = c.FirstParameter(), b = c.LastParameter();
        const at = (t) => { const p = c.Value(a + (b - a) * Math.min(1, Math.max(0, t))); const r = [p.X(), p.Y(), p.Z()]; p.delete(); return r; };
        if (c.GetType() === 'GeomAbs_Line') return GD.lineCurve(at(0), at(1), words);
        const closed = V.len(V.sub(at(0), at(1))) <= 1e-9 * Math.max(1, V.len(at(0)));
        return GD.samplerCurve(closed ? (t) => at(((t % 1) + 1) % 1) : at, { closed, label: words });
      };
      const curvesOf = (list) => list.flatMap((x) => {
        if (x.edge) return [edgeCurve(x.edge)];
        const { f: sf, sk, frame } = sketchOf(ctx, x.sketch);
        return GD.sketchCurves(sk, frame, { entities: x.entities || null, label: sf.name });
      });
      if (!f.profiles.length || !f.guides.length) fail(tr('model.surface.choose_the_profiles_and_the_guides'));
      // tangent to planes along boundary curves (0.4 P11): flat faces, base or reference planes
      const tangent = (f.tangent || []).map((p) => { const fr = resolvePlane(p, ctx); return { o: fr.o, n: fr.n }; });
      const g = GD.gordon(curvesOf(f.profiles), curvesOf(f.guides), { tol: f.tol, tangent });
      const rep = g.report;
      const mf = T(new oc.BRepBuilderAPI_MakeFace(bsplineSurface(oc, T, g.surface), 1e-9));
      if (!mf.IsDone()) fail(tr('model.surface.the_network_surface_could_not_be_made'));
      const face = T(mf.Face());
      const sewTol = Math.max(1e-7, 1e-7 * rep.size);
      const names = new SMap(H.hash);
      const nameAll = (shape) => { for (const fc of H.unique(shape, 'FACE')) if (names.get(fc) === undefined) names.set(fc, `${f.id}.gordon:0`); };   // i18n-ignore: face names (identifiers saved in files)
      report(ctx, f, { gordon: rep });
      if (!f.solid) {
        let shape = face;
        if (rep.closedU || rep.closedV) {
          // join the coincident seam edges (sewing a single face), keeping a shell
          const sew = T(new oc.BRepBuilderAPI_Sewing(sewTol, true, true, true, false));
          sew.Add(face); sew.Perform(prog(oc, T));
          shape = T(sew.SewedShape());
        }
        nameAll(shape);
        setSheet(ctx, f.id, shape, names);
        return {};
      }
      if (!rep.closedU && !rep.closedV) fail(tr('model.surface.an_open_network_does_not_bound'));
      let parts = [face];
      if (!(rep.closedU && rep.closedV)) {
        const sew = T(new oc.BRepBuilderAPI_Sewing(sewTol, true, true, true, false));
        sew.Add(face); sew.Perform(prog(oc, T));
        const shell = T(sew.SewedShape());
        const loops = freeLoops(ctx, shell);
        if (loops.length !== 2) fail(tr('model.surface.net_boundaries', { n: loops.length }));
        const start = g.grid[0][0];
        const caps = loops.map((l, k) => {
          const mw = T(new oc.BRepBuilderAPI_MakeWire());
          for (const e of l.edges) mw.Add(T(oc.TopoDS.Edge(e)));
          if (!mw.IsDone()) fail(tr('model.surface.an_end_of_the_network_surface'));
          const cf = T(new oc.BRepBuilderAPI_MakeFace(T(mw.Wire()), true));
          if (!cf.IsDone()) fail(rep.closedU ? (k ? tr('model.surface.end_not_flat.last_profile') : tr('model.surface.end_not_flat.first_profile')) : (k ? tr('model.surface.end_not_flat.last_guide') : tr('model.surface.end_not_flat.first_guide')));
          return { face: T(cf.Face()), d: Math.min(...l.edges.map((e) => distTo(oc, T, start, e))) };
        });
        caps.sort((a, b) => a.d - b.d);
        names.set(caps[0].face, `${f.id}.start`); names.set(caps[1].face, `${f.id}.end`);   // i18n-ignore: face names (identifiers saved in files)
        parts = [...H.unique(shell, 'FACE'), caps[0].face, caps[1].face];
      }
      const r = sewFaces(oc, T, parts, sewTol);
      if (!r.closed) fail(tr('model.surface.net_open', { n: r.free }));
      const out = new SMap(H.hash);
      for (const p of parts) { const m = T(r.sew.Modified(p)); const nm = names.get(p) || `${f.id}.gordon:0`; out.set(m.IsNull() ? p : m, nm); }   // i18n-ignore: face names (identifiers saved in files)
      for (const fc of H.unique(r.shape, 'FACE')) if (out.get(fc) === undefined) out.set(fc, `${f.id}.gordon:0`);   // i18n-ignore: face names (identifiers saved in files)
      const chk = T(new oc.BRepCheck_Analyzer(r.shape, true, false));
      if (!chk.IsValid()) fail(tr('model.surface.the_closed_network_did_not_make'));
      return { tools: [{ shape: r.shape, op: f.op, names: out }] };
    },

    trimsurf(f, ctx) {
      const { H } = ctx;
      if (!f.sheet) fail(tr('model.surface.pick_a_surface_to_trim'));
      const sh = getSheet(ctx, f.sheet);
      let tool;
      if (f.tool === 'body') { if (!ctx.body) fail(tr('model.surface.there_is_no_body_to_trim_with')); tool = ctx.body; }
      else if (f.tool) tool = getSheet(ctx, f.tool).shape;
      else fail(tr('model.surface.pick_the_surface_or_body_that_cuts'));
      const r = trimShape(ctx.oc, sh.shape, tool, f.at, f.keep, { T: ctx.T });
      const names = new SMap(H.hash);
      const kept = new SMap(H.hash);
      for (const rf of H.unique(r.shape, 'FACE')) kept.set(rf, true);
      for (const [face, name] of sh.names.entries()) {
        const mods = H.list(r.split.Modified(face));
        for (const m of mods.length ? mods : [face]) if (kept.get(m)) names.set(m, name);
      }
      useUp(ctx, f.sheet);
      setSheet(ctx, f.id, r.shape, names);
      report(ctx, f, { count: r.kept });
      return {};
    },
  };
  for (const [k, fn] of Object.entries(F)) FEATURES[k] = guard(fn);
}
