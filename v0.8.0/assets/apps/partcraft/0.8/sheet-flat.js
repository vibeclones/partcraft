/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sheet-flat.js — the flat pattern of a sheet metal part (0.4 P17): sheetFlat(part, oc) → the outline in the plane of the
 * base flange's sketch, with the bend lines, and a worker op `sheetFlat` (brep-worker.js imports this file).
 *
 *   plate base: the final body's faces lying on the sketch plane (so holes, cuts and reliefs come along), plus for every
 *     edge flange on it the bend strip (the bend allowance θ(r + k t) wide, from the plate's edge) and the leg's inner face
 *     turned back about the bend axis and moved out by the allowance (cuts in the leg come along too). The pieces are
 *     fused and merged in that plane (ShapeUpgrade_UnifySameDomain), so lines stay lines and arcs stay arcs.
 *   bent base (an open profile): the developed rectangle (the flat length × the depth) with its bend lines; later cuts are
 *     not unfolded yet (a note says so).
 * → { kind: 'plate'|'bent', segs: [{type: 'line', a, b} | {type: 'arc', c, r, a0, a1 (degrees, CCW)} | {type: 'circle', c, r} |
 *     {type: 'poly', pts}], bends: [{a, b, angle, r, up, name}], box: {x0, y0, x1, y1}, area, notes: [] }   (mm, 2-D)
 * Refuses (Error, in words) a part with no base flange, a flange whose leg face is gone, flanges on a bent base.
 */
import * as V from './vec.js';
import { regenerateBrep } from './brep.js';
import { addOps } from './worker-ops.js';
import { t } from './i18n.js';

function arena() {
  const live = [];
  const T = (o) => { if (o && typeof o.delete === 'function') live.push(o); return o; };
  T.free = () => { for (const o of live) { try { if (!o.isDeleted || !o.isDeleted()) o.delete(); } catch { /* gone */ } } live.length = 0; };
  return T;
}

/** Join straight segments that continue each other through a point no third segment touches (the seams between the plate,
 *  the bend strips and the legs that face merging leaves behind). */
export function mergeLines(segs, tol = 1e-6) {
  const out = segs.slice();
  const key = (p) => Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol);
  for (let changed = true; changed;) {
    changed = false;
    const at = new Map();
    out.forEach((s, i) => { const ends = s.type === 'line' ? [s.a, s.b] : s.type === 'arc' ? arcPoints(s, 1) : s.type === 'poly' ? [s.pts[0], s.pts.at(-1)] : []; for (const p of ends) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
    for (const [, ids] of at) {
      if (ids.length !== 2) continue;
      const [i, j] = ids, A = out[i], B = out[j];
      if (A.type !== 'line' || B.type !== 'line' || i === j) continue;
      const shared = key(A.a) === key(B.a) || key(A.a) === key(B.b) ? A.a : A.b;
      const pa = key(A.a) === key(shared) ? A.b : A.a, pb = key(B.a) === key(shared) ? B.b : B.a;
      const d1 = [shared[0] - pa[0], shared[1] - pa[1]], d2 = [pb[0] - shared[0], pb[1] - shared[1]];
      const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-9 * l1 * l2 || d1[0] * d2[0] + d1[1] * d2[1] <= 0) continue;
      out[i] = { type: 'line', a: pa, b: pb };
      out.splice(j, 1);
      changed = true;
      break;
    }
  }
  return out;
}

/** Points along an arc or circle of a flat (for its extent). */
export function arcPoints(s, n = 64) {
  const a0 = s.type === 'circle' ? 0 : s.a0, sw = s.type === 'circle' ? 360 : ((s.a1 - s.a0) % 360 + 360) % 360 || 360;
  const out = [];
  for (let k = 0; k <= n; k++) { const a = (a0 + sw * k / n) * Math.PI / 180; out.push([s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]); }
  return out;
}

export function sheetFlat(part, oc) {
  const r = regenerateBrep(part, oc, { keep: true, noMesh: true });
  const T = arena();
  try {
    if (r.shape) T(r.shape);
    const sm = r.sheetmetal || new Map();
    const ok = (id) => r.results.get(id)?.status === 'ok';
    const baseF = part.features.find((f) => f.type === 'sheetbase' && !f.suppressed && ok(f.id));
    if (!baseF) throw new Error(t('sheet.flat.no_base'));
    const base = sm.get(baseF.id);
    const notes = [];
    if (part.features.filter((f) => f.type === 'sheetbase' && !f.suppressed).length > 1) notes.push(t('sheet.flat.first_base', { name: baseF.name }));
    const flanges = part.features.filter((f) => f.type === 'sheetflange' && !f.suppressed && ok(f.id) && sm.get(f.id)?.base === baseF.id).map((f) => ({ f, i: sm.get(f.id) }));
    const after = part.features.slice(part.features.indexOf(baseF) + 1).filter((f) => !f.suppressed && f.type !== 'sheetflange' && f.type !== 'sketch');
    if (base.kind === 'bent') {
      if (flanges.length) throw new Error(t('sheet.flat.bent_flanges'));
      if (after.length) notes.push(t('sheet.flat.bent_cuts'));
      const L = base.length, D = base.depth;
      const segs = [[[0, 0], [L, 0]], [[L, 0], [L, D]], [[L, D], [0, D]], [[0, D], [0, 0]]].map(([a, b]) => ({ type: 'line', a, b }));
      const bends = base.bends.map((b, i) => ({ a: [b.at, 0], b: [b.at, D], angle: b.angle, r: b.r, up: b.up, name: `${baseF.name} ${i + 1}` }));   // i18n-ignore: a bend's name
      return { kind: 'bent', segs, bends, box: { x0: 0, y0: 0, x1: L, y1: D }, area: L * D, notes };
    }
    if (!r.shape) throw new Error(t('sheet.flat.no_base'));
    const fr = base.frame, n = fr.n;
    const to2 = (p) => { const d = V.sub(p, fr.o); return [V.dot(d, fr.x), V.dot(d, fr.y)]; };
    const pnt = (p) => T(new oc.gp_Pnt(p[0], p[1], p[2])), dir = (d) => T(new oc.gp_Dir(d[0], d[1], d[2]));
    const ENUM = oc.TopAbs_ShapeEnum;
    const explore = (s, type) => { const out = []; const ex = T(new oc.TopExp_Explorer(s, ENUM['TopAbs_' + type], ENUM.TopAbs_SHAPE)); for (; ex.More(); ex.Next()) out.push(T(ex.Current())); return out; };
    const xyz = (p) => [p.X(), p.Y(), p.Z()];
    /** Planar faces of the body: { face, n (outward), o, c (centroid) }. */
    const planes = [];
    for (const face of explore(r.shape, 'FACE')) {
      const F = T(oc.TopoDS.Face(face));
      const ad = T(new oc.BRepAdaptor_Surface(F, true));
      if (ad.GetType() !== 'GeomAbs_Plane') continue;
      const pl = T(ad.Plane()), ax = T(pl.Axis());
      let d = V.mul(xyz(T(ax.Direction())), T(pl.Position()).Direct() ? 1 : -1);
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) d = V.mul(d, -1);
      const gp = T(new oc.GProp_GProps());
      oc.BRepGProp.SurfaceProperties(face, gp, false, false);
      planes.push({ face, n: d, o: xyz(T(pl.Location())), c: xyz(T(gp.CentreOfMass())) });
    }
    const size = Math.max(1, ...planes.map((p) => V.len(V.sub(p.c, fr.o))));
    const tol = 1e-6 * size;
    const onPlane = (p, o, nn) => Math.abs(V.dot(n0(nn), V.sub(p.c, o))) <= tol && Math.abs(Math.abs(V.dot(p.n, n0(nn))) - 1) <= 1e-9 && V.dot(p.n, nn) > 0;
    const n0 = (v) => V.norm(v);
    // the plate: faces on the sketch plane facing away from the sheet (the sheet lies on +n unless reversed)
    const outward = baseF.reverse ? n : V.mul(n, -1);
    const pieces = planes.filter((p) => onPlane(p, fr.o, outward)).map((p) => p.face);
    if (!pieces.length) throw new Error(t('sheet.flat.no_plate'));
    // project a face (already parallel to the sketch plane) onto it
    const toPlane = (shape, p0) => {
      const d = V.mul(n, V.dot(V.sub(fr.o, p0), n));
      if (V.len(d) < 1e-12) return shape;
      const tr = T(new oc.gp_Trsf()); tr.SetTranslation(T(new oc.gp_Vec(d[0], d[1], d[2])));
      return T(T(new oc.BRepBuilderAPI_Transform(shape, tr, true)).Shape());
    };
    /** A face of the flat facing the same way as the plate's (faces facing opposite ways do not merge). */
    const facing = (shape) => {
      const F = T(oc.TopoDS.Face(shape));
      const ad = T(new oc.BRepAdaptor_Surface(F, true));
      const pl = T(ad.Plane());
      let d = V.mul(xyz(T(T(pl.Axis()).Direction())), T(pl.Position()).Direct() ? 1 : -1);
      if (shape.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) d = V.mul(d, -1);
      return V.dot(d, outward) > 0 ? shape : T(shape.Reversed());
    };
    const bends = [];
    for (const { f, i } of flanges) {
      const { S0, e, u, run, ba, C, Ie, tan, nIn, theta, length } = i;
      // the leg's inner face: on the plane through Ie with outward normal nIn, its centroid within the leg's run and length
      const legs = planes.filter((p) => {
        if (Math.abs(V.dot(p.n, nIn) - 1) > 1e-9 || Math.abs(V.dot(V.sub(p.c, Ie), nIn)) > tol) return false;
        const s = V.dot(V.sub(p.c, S0), e), w = V.dot(V.sub(p.c, Ie), tan);
        return s > -tol && s < run + tol && w > -tol && w < length + tol;
      });
      if (!legs.length) throw new Error(t('sheet.flat.leg_gone', { name: f.name }));
      // turn the leg back about the bend axis (through C along e) by θ, then out by the bend allowance
      const axis = V.norm(V.cross(u, i.v));
      const rot = T(new oc.gp_Trsf()); rot.SetRotation(T(new oc.gp_Ax1(pnt(C), dir(axis))), -theta);
      const mv = T(new oc.gp_Trsf()); mv.SetTranslation(T(new oc.gp_Vec(...V.mul(u, ba))));
      const both = T(mv.Multiplied(rot));
      for (const lf of legs) pieces.push(facing(toPlane(T(T(new oc.BRepBuilderAPI_Transform(lf.face, both, true)).Shape()), S0)));
      // the bend strip: from the plate's edge out by the allowance, along the run
      const q = [S0, V.add(S0, V.mul(e, run)), V.add(V.add(S0, V.mul(e, run)), V.mul(u, ba)), V.add(S0, V.mul(u, ba))];
      const mw = T(new oc.BRepBuilderAPI_MakeWire());
      for (let k = 0; k < 4; k++) mw.Add(T(T(new oc.BRepBuilderAPI_MakeEdge(pnt(q[k]), pnt(q[(k + 1) % 4]))).Edge()));
      pieces.push(facing(toPlane(T(T(new oc.BRepBuilderAPI_MakeFace(T(mw.Wire()), true)).Face()), S0)));
      const m0 = V.add(S0, V.mul(u, ba / 2)), m1 = V.add(m0, V.mul(e, run));
      bends.push({ a: to2(m0), b: to2(m1), angle: f.angle, r: i.r, up: V.dot(i.v, n) > 0, name: f.name });
    }
    // fuse the pieces in the plane and merge faces and edges that continue each other
    let flat = pieces[0];
    if (pieces.length > 1) {
      const mk = T(new oc.BRepAlgoAPI_Fuse());
      const l0 = T(new oc.NCollection_List_TopoDS_Shape()); l0.Append(pieces[0]);
      const l1 = T(new oc.NCollection_List_TopoDS_Shape()); for (const p of pieces.slice(1)) l1.Append(p);
      mk.SetArguments(l0); mk.SetTools(l1); mk.SetRunParallel(false);
      mk.Build(T(new oc.Message_ProgressRange()));
      if (!mk.IsDone() || mk.HasErrors()) throw new Error(t('sheet.flat.fuse'));
      flat = T(mk.Shape());
    }
    const un = T(new oc.ShapeUpgrade_UnifySameDomain(flat, true, true, false));
    un.Build();
    flat = T(un.Shape());
    // edges → 2-D lines, arcs, circles (others sampled)
    const segs = [];
    const seen = [];
    for (const ed of explore(flat, 'EDGE')) {
      if (seen.some((x) => x.IsSame(ed))) continue;
      seen.push(ed);
      const E = T(oc.TopoDS.Edge(ed));
      if (oc.BRep_Tool.Degenerated(E)) continue;
      const c = T(new oc.BRepAdaptor_Curve(E));
      const t0 = c.FirstParameter(), t1 = c.LastParameter();
      const P = (s) => to2(xyz(T(c.EvalD0(s))));
      const type = c.GetType();
      if (type === 'GeomAbs_Line') segs.push({ type: 'line', a: P(t0), b: P(t1) });
      else if (type === 'GeomAbs_Circle') {
        const ci = T(c.Circle()), cc = to2(xyz(T(ci.Location()))), rr = ci.Radius();
        if (Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9) segs.push({ type: 'circle', c: cc, r: rr });
        else {
          // CCW in the plane from a0 to a1: the axis along n keeps the parameter's sense, against n reverses it
          const ccw = V.dot(xyz(T(T(ci.Axis()).Direction())), n) > 0;
          const ang = (p) => Math.atan2(p[1] - cc[1], p[0] - cc[0]) * 180 / Math.PI;
          const [s0, s1] = ccw ? [P(t0), P(t1)] : [P(t1), P(t0)];
          segs.push({ type: 'arc', c: cc, r: rr, a0: (ang(s0) + 360) % 360, a1: (ang(s1) + 360) % 360 });
        }
      } else {
        const pts = [];
        for (let k = 0; k <= 64; k++) pts.push(P(t0 + (t1 - t0) * k / 64));
        segs.push({ type: 'poly', pts });
      }
    }
    const merged = mergeLines(segs, 1e-7 * size);
    const gp = T(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(flat, gp, false, false);
    // the box from the segments themselves
    const xs = [], ys = [];
    for (const s of merged) {
      const ps = s.type === 'line' ? [s.a, s.b] : s.type === 'poly' ? s.pts : arcPoints(s);
      for (const p of ps) { xs.push(p[0]); ys.push(p[1]); }
    }
    return { kind: 'plate', segs: merged, bends, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, area: gp.Mass(), notes };
  } finally {
    T.free();
  }
}

addOps({ sheetFlat({ part }, ctx) { return sheetFlat(part, ctx.oc); } });
