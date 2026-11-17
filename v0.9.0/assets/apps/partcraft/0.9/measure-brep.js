/* SPDX-License-Identifier: Apache-2.0 */
/**
 * measure-brep.js — the exact side of measuring and of whole-assembly output, on OpenCascade (DOM-free;
 * `oc` is passed in, so the worker and the Node tests run the same code).
 *
 *   distance(oc, { a: Item, b: Item }) → { distance, p1, p2, solutions, inside, exact: true }
 *       BRepExtrema_DistShapeShape between two picked entities (minimum distance and its two closest points).
 *       Item = { part, matrix?: 16 numbers (placement, world = matrix · part), sub: Sub }
 *       Sub  = { kind: 'face'|'edge', index, at? } (index into a regen's faces/edges; `at` checks it, the nearest
 *              by `at` wins when the index no longer matches) | { kind: 'body' } | { kind: 'point', p: [x,y,z] } (part coords)
 *   massProps(oc, { part }) → { volume, area, centre, tensor (3×3 rows, about the centre, part axes, density 1),
 *       exact: true }   BRepGProp volume properties; the tensor from GProp's MomentOfInertia about six axes through
 *       the centre (gp_Mat is not bound in this build): Ixx = I(x), Ixy = I((x+y)/√2) − (Ixx + Iyy)/2, …
 *   assemblyShape(oc, items) → TopoDS_Compound of every placed body (caller deletes)   items: [{ part, matrix }]
 *   assemblyStep(oc, { name, items, schema }) → { text, solids }   one STEP file, each part placed (stepText: Z up)
 *   assemblyViews(oc, { items, view }) → { view: { visible, hidden, box }, anchors: [[u,v]…], exact: true }
 *       HLR of the placed bodies (for the assembly drawing); anchors = per item [u, v, depth]: where the line of
 *       sight through its middle meets its body nearest the viewer (where a balloon's leader ends; the larger depth is nearer).
 * Built parts are cached by their JSON (4 kept; evicted shapes deleted): clearCache() drops them.
 * Worker ops (worker-ops.js): measureDistance, measureMass, asmStep, asmViews (same arguments as above).
 */
import * as V from './vec.js';
import { regenerateBrep, stepText } from './brep.js';
import { VIEWS } from './drawing.js';
import { addOps } from './worker-ops.js';
import { t as tr } from './i18n.js';

const HASH = 2147483647;
function arena() {
  const live = [];
  const T = (o) => { if (o && typeof o.delete === 'function') live.push(o); return o; };
  T.free = () => { for (const o of live) { try { if (!o.isDeleted || !o.isDeleted()) o.delete(); } catch { /* gone */ } } live.length = 0; };
  return T;
}
const xyz = (p) => [p.X(), p.Y(), p.Z()];
function trsfOf(oc, T, m) {
  const t = T(new oc.gp_Trsf());
  t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  return t;
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdent = (m) => !m || m.every((v, i) => Math.abs(v - IDENT[i]) < 1e-15);

// ---------------------------------------------------------------- the cache of built bodies with their face/edge tables
const cache = new Map();   // part JSON → { shape, faces: [TopoDS_Face], edges: [TopoDS_Edge], keep: [handles] }
export function clearCache() {
  for (const c of cache.values()) for (const h of c.keep) { try { h.delete(); } catch { /* gone */ } }
  cache.clear();
}

/** The body of a part plus its faces and edges in the order brep.js lists them (regen `faces` / `edges`). */
function bodyOf(oc, part) {
  const key = JSON.stringify(part);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const r = regenerateBrep(part, oc, { keep: true, noMesh: true });
  if (!r.shape) throw new Error(part.name ? tr('model.measure_brep.no_solid', { name: part.name }) : tr('model.measure_brep.no_solid_part'));
  const keep = [r.shape];
  const K = (o) => { keep.push(o); return o; };
  const hash = (s) => oc.ReplicadShapeHasher.HashCode(s, HASH);
  const uniq = (shape, type) => {
    const seen = new Map(), out = [];
    const ex = K(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum['TopAbs_' + type], oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const s = K(ex.Current());
      const h = hash(s), l = seen.get(h) || [];
      if (l.some((o) => o.IsSame(s))) continue;
      l.push(s); seen.set(h, l); out.push(s);
    }
    return out;
  };
  // faces: brep.js faceTableOf order; edges: edgeTableOf order (per face, unique, joining exactly two faces, not degenerate)
  const faceShapes = uniq(r.shape, 'FACE');
  const byEdge = new Map(), list = [];
  for (const f of faceShapes) {
    for (const e of uniq(f, 'EDGE')) {
      const h = hash(e), l = byEdge.get(h) || [];
      let x = l.find((o) => o.edge.IsSame(e));
      if (!x) { x = { edge: e, n: 0 }; l.push(x); byEdge.set(h, l); list.push(x); }
      x.n++;
    }
  }
  const edges = [];
  for (const x of list) {
    if (x.n !== 2) continue;
    const E = K(oc.TopoDS.Edge(x.edge));
    if (oc.BRep_Tool.Degenerated(E)) continue;
    edges.push(E);
  }
  const faces = faceShapes.map((f) => K(oc.TopoDS.Face(f)));
  const out = { shape: r.shape, faces, edges, keep };
  cache.set(key, out);
  while (cache.size > 4) { const [k0, c0] = cache.entries().next().value; cache.delete(k0); for (const h of c0.keep) { try { h.delete(); } catch { /* gone */ } } }
  return out;
}

/** A point standing for a face or edge (centroid / midpoint), to check that an index still means the same thing. */
function markOf(oc, T, s, kind) {
  if (kind === 'edge') {
    const c = T(new oc.BRepAdaptor_Curve(s));
    return xyz(T(c.EvalD0((c.FirstParameter() + c.LastParameter()) / 2)));
  }
  const gp = T(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(s, gp, false, false);
  return xyz(T(gp.CentreOfMass()));
}

function subShape(oc, T, body, sub) {
  if (!sub || typeof sub !== 'object') throw new Error(tr('model.measure_brep.nothing_picked'));
  if (sub.kind === 'body') return body.shape;
  if (sub.kind === 'point') {
    if (!Array.isArray(sub.p) || sub.p.length !== 3 || !sub.p.every(Number.isFinite)) throw new Error(tr('model.measure_brep.bad_point'));
    return T(T(new oc.BRepBuilderAPI_MakeVertex(T(new oc.gp_Pnt(...sub.p)))).Vertex());
  }
  const listOf = sub.kind === 'face' ? body.faces : sub.kind === 'edge' ? body.edges : null;
  if (!listOf) throw new Error('Unknown kind of pick.');   // i18n-ignore: picks are made by the app's own code
  let s = Number.isInteger(sub.index) ? listOf[sub.index] : null;
  if (Array.isArray(sub.at) && sub.at.length === 3) {
    const tol = 1e-6 * Math.max(1, ...sub.at.map(Math.abs));
    if (!s || V.len(V.sub(markOf(oc, T, s, sub.kind), sub.at)) > tol) {
      let best = Infinity; s = null;
      for (const c of listOf) { const d = V.len(V.sub(markOf(oc, T, c, sub.kind), sub.at)); if (d < best) { best = d; s = c; } }
    }
  }
  if (!s) throw new Error(tr(sub.kind === 'face' ? 'model.measure_brep.face_gone' : 'model.measure_brep.edge_gone'));
  return s;
}

function placed(oc, T, shape, m) {
  if (isIdent(m)) return shape;
  return T(T(new oc.BRepBuilderAPI_Transform(shape, trsfOf(oc, T, m), true, false)).Shape());
}

/** Minimum distance between two picked entities, exact (OCCT). */
export function distance(oc, { a, b }) {
  const T = arena();
  try {
    const sa = placed(oc, T, subShape(oc, T, bodyOf(oc, a.part), a.sub), a.matrix);
    const sb = placed(oc, T, subShape(oc, T, bodyOf(oc, b.part), b.sub), b.matrix);
    const d = T(new oc.BRepExtrema_DistShapeShape(sa, sb, 1e-9, undefined, undefined, T(new oc.Message_ProgressRange())));
    if (!d.IsDone() || d.NbSolution() < 1) throw new Error(tr('model.measure_brep.no_distance'));
    const p1 = xyz(T(d.PointOnShape1(1))), p2 = xyz(T(d.PointOnShape2(1)));
    return { distance: d.Value(), p1, p2, solutions: d.NbSolution(), inside: !!d.InnerSolution(), exact: true };
  } finally { T.free(); }
}

/** Exact volume, area, centre of mass and inertia tensor (density 1) of a part's body, in part coordinates. */
export function massProps(oc, { part }) {
  const T = arena();
  try {
    const body = bodyOf(oc, part);
    const gv = T(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(body.shape, gv, false, false, false);
    const ga = T(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(body.shape, ga, false, false);
    const G = T(gv.CentreOfMass());
    const c = xyz(G);
    const I = (d) => { const n = V.norm(d); return gv.MomentOfInertia(T(new oc.gp_Ax1(G, T(new oc.gp_Dir(n[0], n[1], n[2]))))); };
    const xx = I([1, 0, 0]), yy = I([0, 1, 0]), zz = I([0, 0, 1]);
    const xy = I([1, 1, 0]) - (xx + yy) / 2, yz = I([0, 1, 1]) - (yy + zz) / 2, xz = I([1, 0, 1]) - (xx + zz) / 2;
    return { volume: gv.Mass(), area: ga.Mass(), centre: c, tensor: [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]], exact: true };
  } finally { T.free(); }
}

/** Every placed body in one compound (the caller deletes it). */
export function assemblyShape(oc, items) {
  const T = arena();
  try {
    const comp = new oc.TopoDS_Compound();
    const bld = T(new oc.TopoDS_Builder());
    bld.MakeCompound(comp);
    let solids = 0;
    for (const it of items) {
      const body = bodyOf(oc, it.part);
      const s = placed(oc, T, body.shape, it.matrix);
      bld.Add(comp, s);
      const ex = T(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) solids++;
    }
    return { shape: comp, solids };
  } finally { T.free(); }
}

export function assemblyStep(oc, { name = 'Assembly', items, schema = 'AP242' }) {
  if (!items?.length) throw new Error(tr('model.measure_brep.no_parts'));
  const { shape, solids } = assemblyShape(oc, items);
  try { return { text: stepText(oc, shape, { name, schema }), solids }; } finally { shape.delete(); }
}

function edgePts(oc, T, e, size) {
  const c = T(new oc.BRepAdaptor_Curve(e));
  const t0 = c.FirstParameter(), t1 = c.LastParameter();
  const P = (t) => xyz(T(c.EvalD0(t)));
  if (c.GetType() === 'GeomAbs_Line') return [P(t0), P(t1)];
  const a = P(t0), b = P(t1), m = P((t0 + t1) / 2);
  const span = V.len(V.sub(a, m)) + V.len(V.sub(m, b));
  const n = Math.max(8, Math.min(240, Math.ceil(span / Math.max(1e-6, size) * 160)));
  return Array.from({ length: n + 1 }, (_, i) => P(t0 + (t1 - t0) * i / n));
}

/** Hidden-line view of the placed bodies along one of drawing.js's VIEWS, plus a balloon anchor per item. */
export function assemblyViews(oc, { items, view = 'iso' }) {
  const vw = VIEWS[view];
  if (!vw) throw new Error('Unknown view.');   // i18n-ignore: view names come from the app's own code
  const T = arena();
  const { shape } = assemblyShape(oc, items);
  T(shape);
  try {
    const bb = T(new oc.Bnd_Box());
    oc.BRepBndLib.AddOptimal(shape, bb, false, false);
    const size = Math.max(1e-6, V.len(V.sub([bb.GetXMax(), bb.GetYMax(), bb.GetZMax()], [bb.GetXMin(), bb.GetYMin(), bb.GetZMin()])));
    const algo = T(new oc.HLRBRep_Algo());
    algo.Add(shape, 0);
    algo.Projector(T(new oc.HLRAlgo_Projector(T(new oc.gp_Ax2(T(new oc.gp_Pnt(0, 0, 0)), T(new oc.gp_Dir(...vw.dir)), T(new oc.gp_Dir(...vw.right)))))));
    algo.Update();
    algo.Hide();
    const h = T(new oc.HLRBRep_HLRToShape(algo));
    const segs = (list) => {
      const out = [];
      for (const s of list) {
        T(s);
        if (s.IsNull()) continue;
        oc.BRepLib.BuildCurves3d(s);
        const ex = T(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
        for (; ex.More(); ex.Next()) {
          const pts = edgePts(oc, T, T(oc.TopoDS.Edge(T(ex.Current()))), size);
          for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
        }
      }
      return out;
    };
    const visible = segs([h.VCompound(), h.OutLineVCompound()]);
    const hidden = segs([h.HCompound(), h.OutLineHCompound()]);
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const s of visible) { u0 = Math.min(u0, s[0], s[2]); u1 = Math.max(u1, s[0], s[2]); v0 = Math.min(v0, s[1], s[3]); v1 = Math.max(v1, s[1], s[3]); }
    if (u0 === Infinity) { u0 = v0 = 0; u1 = v1 = 1; }
    // balloon anchors: where the line of sight through the body's middle meets it, the hit nearest the viewer
    // (OCCT distance from the body to that line; a hollow middle gives the body's nearest point to the line)
    const anchors = items.map((it) => {
      const body = placed(oc, T, bodyOf(oc, it.part).shape, it.matrix);
      const b = T(new oc.Bnd_Box());
      oc.BRepBndLib.AddOptimal(body, b, false, false);
      const mid = [(b.GetXMin() + b.GetXMax()) / 2, (b.GetYMin() + b.GetYMax()) / 2, (b.GetZMin() + b.GetZMax()) / 2];
      const line = T(T(new oc.BRepBuilderAPI_MakeEdge(T(new oc.gp_Pnt(...V.sub(mid, V.mul(vw.dir, size * 2)))), T(new oc.gp_Pnt(...V.add(mid, V.mul(vw.dir, size * 2)))))).Edge());
      const d = T(new oc.BRepExtrema_DistShapeShape(body, line, 1e-7, undefined, undefined, T(new oc.Message_ProgressRange())));
      let p = mid, depth = -Infinity;
      if (d.IsDone()) for (let k = 1; k <= d.NbSolution(); k++) { const q = xyz(T(d.PointOnShape1(k))); if (V.dot(q, vw.dir) > depth) { depth = V.dot(q, vw.dir); p = q; } }
      return [V.dot(p, vw.right), V.dot(p, vw.up), V.dot(p, vw.dir)];
    });
    return { view: { visible, hidden, box: { u0, v0, u1, v1 } }, anchors, exact: true };
  } finally { T.free(); }
}

// ---------------------------------------------------------------- worker ops (brep-worker.js imports this module)
addOps({
  measureDistance(args, { oc }) { return distance(oc, args); },
  measureMass(args, { oc }) { return massProps(oc, args); },
  asmStep(args, { oc }) { return assemblyStep(oc, args); },
  asmViews(args, { oc }) { return assemblyViews(oc, args); },
});
