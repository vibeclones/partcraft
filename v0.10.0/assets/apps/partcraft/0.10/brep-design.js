/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-design.js — the exact kernel's Design features added 2026-10-11 (DOM-free; OCCT is passed in through brep.js's
 * ctx): reference planes / axes / points, sweep (BRepOffsetAPI_MakePipeShell), loft (BRepOffsetAPI_ThruSections),
 * draft (BRepOffsetAPI_DraftAngle) and the extended extrude (up to a face / the next face / a vertex / an offset from a
 * face, picked regions, two directions, taper). brep.js imports it and calls installDesign(FEATURES, lib) with its own
 * internals (no import back, so the worker's module graph has no cycle).
 *
 * Face names (partcraft.md): sweep and loft  <id>.side:<curve> (the face a profile curve sweeps; a loft names them after
 * its first sketch section, else side:e<k>), <id>.start / <id>.end (caps); draft  <id>.draft:<i> (the i-th picked
 * face, tilted; the faces it propagates to keep theirs); extended extrude  start = the cap on the far side of the
 * direction, end = the cap (or the face it was cut back to) at the far end, side:<curve> as before.
 */
import { t } from './i18n.js';
import * as V from './vec.js';
import { byId, pointXY, insideLoops } from './sketch.js';
import { refFeature } from './refgeom.js';

/** Regions picked in a sketch (points in sketch coordinates) → [{ outer, holes }] (loop indices), or throws via fail. */
export function regionsAt(loops, pts, fail) {
  const contains = (i, p) => insideLoops([loops[i].poly], p);
  const depthOf = (i) => loops.reduce((k, L, j) => k + (j !== i && insideLoops([L.poly], loops[i].poly[0]) && !contains(i, L.poly[0]) ? 1 : 0), 0);
  const depth = loops.map((_, i) => depthOf(i));
  const out = [], seen = new Set();
  for (const p of pts) {
    const inside = loops.map((_, i) => i).filter((i) => contains(i, p));
    if (!inside.length) fail(t('model.brep_design.region_gone', { x: +p[0].toFixed(3), y: +p[1].toFixed(3) }));
    const outer = inside.reduce((a, b) => (depth[b] > depth[a] ? b : a));
    if (seen.has(outer)) continue;
    seen.add(outer);
    const holes = loops.map((_, j) => j).filter((j) => j !== outer && depth[j] === depth[outer] + 1 && insideLoops([loops[outer].poly], loops[j].poly[0]));
    out.push({ outer, holes });
  }
  return out;
}

export function installDesign(FEATURES, lib) {
  const { fail, SMap, profileCurves, profileFaces, nameSweep, sketchOf, resolvePlane, resolveDir, occtMessage, describeName, nearest, bodyRange } = lib;

  // ---------------------------------------------------------------- lookups shared by the resolvers
  // what: 'face' | 'section' (a loft section face) | 'draft' (a face to draft) → [no body yet, gone] message keys
  const FACE_GONE = {
    face: ['model.brep_design.face_gone_no_body', 'model.brep_design.face_gone'],
    section: ['model.brep_design.section_face_gone_no_body', 'model.brep_design.section_face_gone'],
    draft: ['model.brep_design.draft_face_gone_no_body', 'model.brep_design.draft_face_gone'],
  };
  const faceRec = (ctx, ref, what = 'face') => {
    const keys = FACE_GONE[what] || FACE_GONE.face;
    if (!ctx.body) fail(t(keys[0]));
    const cands = ctx.faceTable().filter((x) => x.name === ref.name);
    if (!cands.length) fail(t(keys[1], { face: describeName(ctx.part, ref.name) }));
    return nearest(cands, ref.at, (x) => x.at);
  };
  const edgeRec = (ctx, ref) => {
    if (!ctx.body) fail(t('model.brep_design.edge_gone_no_body'));
    const key = [...ref.faces].sort().join('|');
    const cands = ctx.edgeTable().filter((e) => e.key === key);
    if (!cands.length) fail(t('model.brep_design.edge_gone', { a: describeName(ctx.part, ref.faces[0]), b: describeName(ctx.part, ref.faces[1]) }));
    return nearest(cands, ref.at, (e) => e.at);
  };
  const circleAxis = (ctx, edge) => {
    const { oc, T, H } = ctx;
    const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(edge))));
    if (c.GetType() !== 'GeomAbs_Circle') return null;
    const ci = T(c.Circle()), ax = T(ci.Axis());
    return { o: H.xyz(T(ax.Location())), d: H.xyz(T(ax.Direction())), r: ci.Radius() };
  };
  /** The curve point of an edge nearest p and the unit tangent there (sampled, then refined by golden section). */
  const edgeNear = (ctx, edge) => (p) => {
    const { oc, T, H } = ctx;
    const ca = circleAxis(ctx, edge);
    if (ca) {
      // a circle: exactly, from its centre and axis
      const d = V.norm(ca.d), w = V.sub(p, ca.o), radial = V.sub(w, V.mul(d, V.dot(w, d)));
      if (V.len(radial) < 1e-12) fail(t('model.brep_design.point_on_axis'));
      const u = V.norm(radial);
      return { p: V.add(ca.o, V.mul(u, ca.r)), t: V.cross(d, u) };
    }
    const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(edge))));
    const t0 = c.FirstParameter(), t1 = c.LastParameter();
    const at = (t) => H.xyz(T(c.EvalD0(t)));
    const d2 = (t) => { const q = at(t); return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; };
    let bt = t0, bd = Infinity;
    for (let i = 0; i <= 200; i++) { const t = t0 + (t1 - t0) * i / 200; const d = d2(t); if (d < bd) { bd = d; bt = t; } }
    let lo = Math.max(t0, bt - (t1 - t0) / 200), hi = Math.min(t1, bt + (t1 - t0) / 200);
    const g = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 80; i++) { const a = hi - g * (hi - lo), b = lo + g * (hi - lo); if (d2(a) < d2(b)) hi = b; else lo = a; }
    const tm = (lo + hi) / 2, h = (t1 - t0) * 1e-6;
    const tan = V.norm(V.sub(at(Math.min(t1, tm + h)), at(Math.max(t0, tm - h))));
    return { p: at(tm), t: tan };
  };
  /** Half way along an edge by length (8-point Gauss–Legendre on 32 pieces, then bisection): { p, t }. */
  const GL8 = [[-0.9602898564975363, 0.1012285362903763], [-0.7966664774136267, 0.2223810344533745], [-0.525532409916329, 0.3137066458778873], [-0.1834346424956498, 0.362683783378362],
    [0.1834346424956498, 0.362683783378362], [0.525532409916329, 0.3137066458778873], [0.7966664774136267, 0.2223810344533745], [0.9602898564975363, 0.1012285362903763]];
  const edgeMid = (ctx, edge) => () => {
    const { oc, T, H } = ctx;
    const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(edge))));
    const d1 = (t) => { const r = c.EvalD1(t); const out = { p: H.xyz(r.Point), v: [r.D1.X(), r.D1.Y(), r.D1.Z()] }; r.Point.delete(); r.D1.delete(); return out; };
    const t0 = c.FirstParameter(), t1 = c.LastParameter();
    const len = (a, b) => { let s = 0; const h = (b - a) / 2, m = (a + b) / 2; for (const [x, w] of GL8) s += w * V.len(d1(m + h * x).v); return s * h; };
    const cum = [0], ts = [];
    for (let k = 0; k <= 32; k++) ts.push(t0 + (t1 - t0) * k / 32);
    for (let k = 0; k < 32; k++) cum.push(cum[k] + len(ts[k], ts[k + 1]));
    const half = cum[32] / 2;
    const k = Math.max(0, cum.findIndex((x) => x >= half) - 1);
    let lo = ts[k], hi = ts[k + 1];
    for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (cum[k] + len(ts[k], m) < half) lo = m; else hi = m; }
    const r = d1((lo + hi) / 2);
    return { p: r.p, t: r.v };
  };
  /** Where an edge crosses a plane { o, n }: sign changes of the distance (400 samples), bisected; in order along the edge. */
  const edgeCross = (ctx, edge) => (pl) => {
    const { oc, T, H } = ctx;
    const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(edge))));
    const t0 = c.FirstParameter(), t1 = c.LastParameter();
    const at = (t) => H.xyz(T(c.EvalD0(t)));
    const g = (t) => V.dot(V.sub(at(t), pl.o), pl.n);
    const out = [];
    let ta = t0, ga = g(t0);
    if (Math.abs(ga) < 1e-12) out.push(at(t0));
    for (let k = 1; k <= 400; k++) {
      const tb = t0 + (t1 - t0) * k / 400, gb = g(tb);
      if (Math.abs(gb) < 1e-12) out.push(at(tb));
      else if (ga * gb < 0 && Math.abs(ga) >= 1e-12) {
        let lo = ta, hi = tb, glo = ga;
        for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi)); i++) { const m = (lo + hi) / 2, gm = g(m); if (gm * glo <= 0) hi = m; else { lo = m; glo = gm; } }
        out.push(at((lo + hi) / 2));
      }
      ta = tb; ga = gb;
    }
    return out;
  };
  /** A face record → { type, n, o, axis, r } for refgeom (a cone's axis from one of its circular edges). */
  const faceGeom = (ctx, rec) => {
    const out = { type: rec.type, n: rec.n, o: rec.o, axis: rec.axis, r: rec.r };
    if (rec.type === 'cone') for (const e of ctx.H.unique(rec.face, 'EDGE')) { const a = circleAxis(ctx, e); if (a) { out.axis = { o: a.o, d: a.d }; break; } }
    return out;
  };
  const planeC = (ref, ctx) => {
    const fr = resolvePlane(ref, ctx);
    let center = null;
    if (ref.kind === 'ref') center = ctx.refGeom.get(ref.feature)?.center || null;
    else if (ref.kind === 'face' && ctx.body) {
      const name = lib.refName(ref);
      const hit = ctx.faceTable().find((f) => f.name === name && f.type === 'plane');
      if (hit) center = hit.at;
    }
    return { ...fr, center: center || fr.o };
  };
  const pointOf = (ref, ctx) => {
    if (ref.kind === 'fixed') return [...ref.p];
    if (ref.kind === 'ref') { const g = ctx.refGeom.get(ref.feature); if (!g || g.kind !== 'point') fail(t('model.brep_design.point_feature_not_built')); return g.p; }
    if (ref.kind === 'sketch') {
      const sf = ctx.part.features.find((x) => x.id === ref.sketch);
      const fr = ctx.frames.get(ref.sketch);
      if (!sf || !fr) fail(t('model.brep_design.point_sketch_not_built'));
      if (ref.entity === 'O') return V.toWorld(fr, 0, 0);
      const q = pointXY(sf.sketch, ref.entity);
      if (!q) fail(t('model.brep_design.point_gone_from', { name: sf.name }));
      return V.toWorld(fr, q[0], q[1]);
    }
    if (ref.kind === 'vertex') { const e = edgeRec(ctx, ref.edge); return V.len(V.sub(e.a, ref.p)) <= V.len(V.sub(e.b, ref.p)) ? e.a : e.b; }
    return fail(t('model.brep_design.point_ref_bad'));
  };
  const resolvers = (ctx) => ({
    plane: (r) => planeC(r, ctx),
    dir: (r) => resolveDir(r, ctx),
    point: (r) => pointOf(r, ctx),
    face: (r) => faceGeom(ctx, faceRec(ctx, r)),
    edge: (r) => { const e = edgeRec(ctx, r); const ax = e.type === 'circle' ? circleAxis(ctx, e.edge) : null; return { type: e.type, a: e.a, b: e.b, axis: ax, near: edgeNear(ctx, e.edge), mid: edgeMid(ctx, e.edge), cross: edgeCross(ctx, e.edge) }; },
    fail,
  });
  lib.pointOf = pointOf;
  lib.refResolvers = resolvers;   // brep-bodies.js (move axes, align planes)

  // ---------------------------------------------------------------- reference geometry
  for (const type of ['plane', 'axis', 'point']) {
    FEATURES[type] = (f, ctx) => {
      const g = refFeature(f, resolvers(ctx));
      if (!g.o && g.kind === 'axis') fail(t('model.brep_design.axis_unknown'));
      for (const v of [g.frame?.o, g.frame?.n, g.o, g.d, g.p]) if (v && !v.every(Number.isFinite)) fail(t('model.brep_design.refs_infinite'));
      ctx.refGeom.set(f.id, g);
      if (g.kind === 'axis') ctx.axes.set(f.id, { o: g.o, d: g.d });
      return {};
    };
  }

  // ---------------------------------------------------------------- shared OCCT helpers
  /** Boolean of A with tools keeping face names (same rule as brep.js applyTools). kind 'fuse' | 'cut' | 'common'. */
  function combine(ctx, kind, A, namesA, tools) {
    const { oc, T, H } = ctx;
    const mk = T(kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse() : kind === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common());
    mk.SetArguments(H.shapeList([A]));
    mk.SetTools(H.shapeList(tools.map((t) => t.shape)));
    mk.SetRunParallel(false);
    try { mk.Build(H.prog()); } catch (e) { fail(t('model.brep.boolean_failed_why', { why: occtMessage(oc, e) })); }
    if (!mk.IsDone() || mk.HasErrors()) fail(t('model.brep_design.boolean_failed'));
    const shape = T(mk.Shape());
    const names = new SMap(H.hash);
    for (const src of [namesA, ...tools.map((t) => t.names)]) {
      for (const [face, name] of src.entries()) {
        if (mk.IsDeleted(face)) continue;
        const mods = H.list(mk.Modified(face));
        if (mods.length) for (const m of mods) names.set(m, name); else names.set(face, name);
      }
    }
    mk.Clear();
    return { shape, names };
  }
  lib.combine = combine;
  const wiresOf = (ctx, face) => {
    const { oc, T, H } = ctx;
    const outer = T(oc.BRepTools.OuterWire(T(oc.TopoDS.Face(face))));
    const inner = H.explore(face, 'WIRE').filter((w) => !w.IsSame(outer)).map((w) => T(oc.TopoDS.Wire(w)));
    return { outer, inner };
  };
  const curveEnds = (ctx, edge) => {
    const { oc, T, H } = ctx;
    const c = T(new oc.BRepAdaptor_Curve(T(oc.TopoDS.Edge(edge))));
    return [H.xyz(T(c.EvalD0(c.FirstParameter()))), H.xyz(T(c.EvalD0(c.LastParameter())))];
  };

  /** World edges of path pieces (sketch curves, model edges), chained end to end into one wire. → { wire, ends:[p0, p1], closed } */
  function pathWire(ctx, items, what) {
    const { oc, T, H } = ctx;
    // what: 'path' | 'guide' — each message is a whole sentence per kind
    const K = what === 'guide'
      ? { pick: 'model.brep_design.guide_pick', type: 'model.brep_design.guide_curve_type', none: 'model.brep_design.guide_no_curves', branch: 'model.brep_design.guide_branches', gap: 'model.brep_design.guide_gap', chain: 'model.brep_design.guide_no_chain' }
      : { pick: 'model.brep_design.path_pick', type: 'model.brep_design.path_curve_type', none: 'model.brep_design.path_no_curves', branch: 'model.brep_design.path_branches', gap: 'model.brep_design.path_gap', chain: 'model.brep_design.path_no_chain' };
    if (!items || !items.length) fail(t(K.pick));
    const edges = [];
    for (const it of items) {
      if (it.edge) { edges.push(T(oc.TopoDS.Edge(edgeRec(ctx, it.edge).edge))); continue; }
      const { f, sk, frame } = sketchOf(ctx, it.sketch);
      const W = (p) => V.toWorld(frame, p[0], p[1]);
      const want = it.entities ? new Set(it.entities) : null;
      let n = 0;
      for (const e of sk.entities) {
        if (want ? !want.has(e.id) : e.construction || e.type === 'point') continue;
        if (want && !byId(sk, e.id)) continue;
        let edge;
        if (e.type === 'line') {
          const a = pointXY(sk, e.p1), b = pointXY(sk, e.p2);
          edge = T(new oc.BRepBuilderAPI_MakeEdge(H.pnt(W(a)), H.pnt(W(b)))).Edge();
        } else if (e.type === 'arc') {
          const c = pointXY(sk, e.c), s = pointXY(sk, e.s), en = pointXY(sk, e.e);
          const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
          let a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = Math.atan2(en[1] - c[1], en[0] - c[0]);
          if (a1 <= a0) a1 += 2 * Math.PI;
          const m = [c[0] + r * Math.cos((a0 + a1) / 2), c[1] + r * Math.sin((a0 + a1) / 2)];
          edge = T(new oc.BRepBuilderAPI_MakeEdge(T(T(new oc.GC_MakeArcOfCircle(H.pnt(W(s)), H.pnt(W(m)), H.pnt(W(en)))).Value()))).Edge();
        } else if (e.type === 'circle') {
          const c = pointXY(sk, e.c);
          edge = T(new oc.BRepBuilderAPI_MakeEdge(T(new oc.gp_Circ(T(new oc.gp_Ax2(H.pnt(W(c)), H.dir(frame.n), H.dir(frame.x))), e.r)))).Edge();
        } else if (want) fail(t(K.type, { name: f.name, type: e.type }));
        else continue;
        edges.push(T(edge)); n++;
      }
      if (!n) fail(t(K.none, { name: f.name }));
    }
    // chain: start at a free end when there is one
    const ends = edges.map((e) => curveEnds(ctx, e));
    const scale = Math.max(1, ...ends.flat().map((p) => V.len(p)));
    const tol = 1e-6 * scale;
    const same = (p, q) => V.len(V.sub(p, q)) <= tol;
    const degree = (p) => ends.reduce((k, [a, b]) => k + (same(a, p) ? 1 : 0) + (same(b, p) ? 1 : 0), 0);
    for (const [a, b] of ends) for (const p of [a, b]) if (degree(p) > 2) fail(t(K.branch, { at: p.map((v) => +v.toFixed(3)).join(', ') }));
    let start = 0, startEnd = 0;
    const free = [];
    ends.forEach(([a, b], i) => { if (degree(a) === 1) free.push([i, 0]); if (degree(b) === 1) free.push([i, 1]); });
    if (free.length) [start, startEnd] = free[0];
    const order = [start], used = new Set([start]);
    let tip = ends[start][1 - startEnd];
    const first = ends[start][startEnd];
    while (order.length < edges.length) {
      const k = ends.findIndex(([a, b], i) => !used.has(i) && (same(a, tip) || same(b, tip)));
      if (k < 0) fail(t(K.gap, { n: edges.length - order.length }));
      used.add(k); order.push(k);
      tip = same(ends[k][0], tip) ? ends[k][1] : ends[k][0];
    }
    const mw = T(new oc.BRepBuilderAPI_MakeWire());
    for (const i of order) mw.Add(edges[i]);
    if (!mw.IsDone()) fail(t(K.chain));
    return { wire: T(mw.Wire()), ends: [first, tip], closed: same(first, tip) };
  }

  lib.pathWire = pathWire;   // brep-bodies.js (path pattern)

  /** The tools of a solid swept from profile faces: outer wire minus the swept holes, each face named. */
  function solidsFromWires(ctx, faces, edgeOf, fid, makeOne) {
    const { H } = ctx;
    const out = [];
    for (const face of faces) {
      const { outer, inner } = wiresOf(ctx, face);
      const one = (w) => {
        const r = makeOne(w);
        const names = new SMap(H.hash);
        for (const [id, e] of edgeOf) for (const g of H.list(r.gen(e))) if (g.ShapeType() === H.ENUM.TopAbs_FACE) names.set(g, `${fid}.side:${id}`);   // i18n-ignore: face names (identifiers)
        for (const [k, s] of [['start', r.first], ['end', r.last]]) if (s && !s.IsNull()) for (const fc of H.explore(s, 'FACE')) names.set(fc, `${fid}.${k}`);
        return { shape: r.shape, names };
      };
      let A = one(outer);
      if (inner.length) A = combine(ctx, 'cut', A.shape, A.names, inner.map(one));
      out.push(A);
    }
    return out;
  }

  // ---------------------------------------------------------------- sweep
  FEATURES.sweep = (f, ctx) => {
    const { oc, T, H } = ctx;
    const { sk, frame } = sketchOf(ctx, f.sketch);
    const pr = profileCurves(sk);
    if (pr.error) fail(t('model.brep_design.sweep_profile_error', { why: pr.error[0].toLowerCase() + pr.error.slice(1) }));
    if (!pr.loops.length) fail(t('model.brep_design.sweep_no_loop'));
    if (f.path.some((it) => it.sketch === f.sketch)) fail(t('model.brep_design.sweep_path_same_sketch'));
    const path = pathWire(ctx, f.path, 'path');
    // the profile has to sit at one end of the path
    const scale = Math.max(1, V.len(V.sub(path.ends[1], path.ends[0])));
    const off = (p) => Math.abs(V.dot(V.sub(p, frame.o), frame.n));
    let spine = path.wire;
    if (off(path.ends[0]) > 1e-6 * scale) {
      if (off(path.ends[1]) > 1e-6 * scale) fail(t('model.brep_design.sweep_profile_at_end'));
      spine = T(oc.TopoDS.Wire(T(path.wire.Reversed())));
    }
    let aux = null;
    if (f.orient === 'guide') { if (!f.guide || !f.guide.length) fail(t('model.brep_design.sweep_pick_guide')); aux = pathWire(ctx, f.guide, 'guide').wire; }
    const binormal = f.orient === 'binormal' ? (f.binormal ? resolveDir(f.binormal, ctx).d : fail(t('model.brep_design.sweep_pick_binormal'))) : null;
    const { faces, edgeOf } = profileFaces(oc, T, H, pr.loops, frame, 0);
    const tools = solidsFromWires(ctx, faces, edgeOf, f.id, (w) => {
      const mk = T(new oc.BRepOffsetAPI_MakePipeShell(spine));
      if (f.orient === 'frenet') mk.SetMode(true);
      else if (f.orient === 'fixed') mk.SetMode(T(new oc.gp_Ax2(H.pnt(frame.o), H.dir(frame.n), H.dir(frame.x))));
      else if (f.orient === 'binormal') mk.SetMode(H.dir(binormal));
      else if (f.orient === 'guide') mk.SetMode(aux, true, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
      else mk.SetMode(false);
      mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);   // sharp corners of the path: mitred
      if (Math.abs(f.scale - 1) > 1e-12) { const law = T(new oc.Law_Linear()); law.Set(0, 1, 1, f.scale); mk.SetLaw(w, law, false, false); }
      else mk.Add(w, false, false);
      try { mk.Build(H.prog()); } catch (e) { fail(t('model.brep_design.sweep_failed_why', { why: occtMessage(oc, e) })); }
      if (!mk.IsDone()) fail(t('model.brep_design.sweep_failed'));
      if (!mk.MakeSolid()) fail(t('model.brep_design.sweep_not_solid'));
      return { shape: T(mk.Shape()), gen: (e) => mk.Generated(e), first: T(mk.FirstShape()), last: T(mk.LastShape()) };
    });
    return { tools: tools.map((t) => ({ ...t, op: f.op })) };
  };

  // ---------------------------------------------------------------- loft
  FEATURES.loft = (f, ctx) => {
    const { oc, T, H } = ctx;
    if (f.sections.length < 2) fail(t('model.brep_design.loft_two_sections'));
    // 0.4 P6: guide rails — the loft through the sections and along the rails is a Gordon surface (surface.js gordon, gordon.js):
    // the sections are its profiles, the rails its guides, capped flat at both ends into a solid. Names <id>.gordon:0, .start, .end.
    if (f.rails && f.rails.length) {
      if (f.sections.some((s) => !s.sketch)) fail(t('loft.rails.sketches_only'));
      // gordon.js counts the curves (each chain of a rail sketch is one rail); its "network" words become the loft's
      try { return FEATURES.gordon({ ...f, profiles: f.sections.map((s) => ({ sketch: s.sketch })), guides: f.rails, tol: f.railTol ?? 0.01, solid: true, op: f.op }, ctx); } catch (e) {
        if (/needs at least two profiles and two guides/.test(e && e.message)) fail(t('loft.rails.two'));
        throw e;
      }
    }
    const secs = [];
    f.sections.forEach((s, i) => {
      if (s.point) {
        if (i !== 0 && i !== f.sections.length - 1) fail(t('model.brep_design.loft_point_end'));
        secs.push({ vertex: T(T(new oc.BRepBuilderAPI_MakeVertex(H.pnt(pointOf(s.point, ctx)))).Vertex()) });
        return;
      }
      if (s.face) {
        const rec = faceRec(ctx, s.face, 'section');
        const { outer } = wiresOf(ctx, rec.face);
        secs.push({ wire: outer, edgeOf: new Map(H.explore(outer, 'EDGE').map((e, k) => ['e' + k, e])), n: H.explore(outer, 'EDGE').length });
        return;
      }
      const { f: sf, sk, frame } = sketchOf(ctx, s.sketch);
      const pr = profileCurves(sk);
      if (pr.error) fail(t('model.brep_design.loft_section_error', { name: sf.name, why: pr.error }));
      if (pr.loops.length !== 1) fail(t('model.brep_design.loft_loops', { name: sf.name, n: pr.loops.length }));
      const { faces, edgeOf } = profileFaces(oc, T, H, pr.loops, frame, 0);
      secs.push({ wire: wiresOf(ctx, faces[0]).outer, edgeOf, n: pr.loops[0].segs.length, sketch: sf });
    });
    const mk = T(new oc.BRepOffsetAPI_ThruSections(true, f.ruled, 1e-6));
    for (const s of secs) { if (s.vertex) mk.AddVertex(s.vertex); else mk.AddWire(s.wire); }
    mk.CheckCompatibility(true);
    try { mk.Build(H.prog()); } catch (e) { fail(t('model.brep_design.loft_failed_why', { why: occtMessage(oc, e) })); }
    if (!mk.IsDone()) fail(t('model.brep_design.loft_failed'));
    const shape = T(mk.Shape());
    const names = new SMap(H.hash);
    const named = secs.find((s) => s.sketch) || secs.find((s) => s.wire);
    for (const [id, e] of named.edgeOf) { const g = T(mk.GeneratedFace(e)); if (!g.IsNull() && names.get(g) === undefined) names.set(g, `${f.id}.side:${id}`); }   // i18n-ignore: face names (identifiers)
    for (const [k, s] of [['start', T(mk.FirstShape())], ['end', T(mk.LastShape())]]) if (!s.IsNull()) for (const fc of H.explore(s, 'FACE')) names.set(fc, `${f.id}.${k}`);
    let k = 0;
    for (const fc of H.unique(shape, 'FACE')) if (names.get(fc) === undefined) names.set(fc, `${f.id}.side:x${k++}`);   // i18n-ignore: a face name (identifier)
    const counts = secs.filter((s) => s.n).map((s) => s.n);
    const warning = new Set(counts).size > 1 ? t('model.brep_design.loft_sides_differ', { counts: counts.join(', ') }) : undefined;
    return { tools: [{ shape, op: f.op, names }], warning };
  };

  // ---------------------------------------------------------------- draft
  // a face's surface kind → the key that says it cannot be drafted
  const DRAFT_KIND = { other: 'model.brep_design.draft_curved', sphere: 'model.brep_design.draft_sphere', torus: 'model.brep_design.draft_torus', spline: 'model.brep_design.draft_spline' };
  FEATURES.draft = (f, ctx) => {
    const { oc, T, H } = ctx;
    if (!ctx.body) fail(t('model.brep_design.no_body_draft'));
    if (!f.faces.length) fail(t('model.brep_design.draft_pick_faces'));
    if (!(Math.abs(f.angle) > 0)) fail(t('model.brep_design.draft_angle_zero'));
    const neutral = resolvePlane(f.neutral, ctx);
    const pull = f.pull ? V.norm(resolveDir(f.pull, ctx).d) : neutral.n;
    const faces = f.faces.map((r) => faceRec(ctx, r, 'draft'));
    const mk = T(new oc.BRepOffsetAPI_DraftAngle(ctx.body));
    const pln = T(new oc.gp_Pln(H.pnt(neutral.o), H.dir(neutral.n)));
    const seen = new SMap(H.hash);
    faces.forEach((rec) => {
      if (seen.get(rec.face)) return;
      seen.set(rec.face, true);
      if (!['plane', 'cylinder', 'cone'].includes(rec.type)) fail(t(DRAFT_KIND[rec.type] || DRAFT_KIND.other, { face: describeName(ctx.part, rec.name) }));
      try { mk.Add(T(oc.TopoDS.Face(rec.face)), H.dir(pull), f.angle * Math.PI / 180, pln, true); } catch (e) { fail(t('model.brep_design.draft_add_failed_why', { why: occtMessage(oc, e) })); }
      if (!mk.AddDone()) fail(t('model.brep_design.draft_neutral', { face: describeName(ctx.part, rec.name) }));
    });
    try { mk.Build(H.prog()); } catch (e) { fail(t('model.brep_design.draft_failed_why', { why: occtMessage(oc, e) })); }
    if (!mk.IsDone()) fail(t('model.brep_design.draft_failed'));
    const shape = T(mk.Shape());
    const names = new SMap(H.hash);
    const picked = new SMap(H.hash);
    faces.forEach((rec, i) => { if (picked.get(rec.face) === undefined) picked.set(rec.face, i); });
    for (const [face, name] of ctx.names.entries()) {
      const i = picked.get(face);
      const nm = i === undefined ? name : `${f.id}.draft:${i}`;   // i18n-ignore: a face name (identifier)
      // DraftAngle reports the tilted faces themselves only through ModifiedShape (Modified lists their neighbours)
      const m = T(mk.ModifiedShape(face));
      names.set(m.IsNull() ? face : m, nm);
    }
    return { replace: { shape, names } };
  };

  // ---------------------------------------------------------------- extrude: up to, next, vertex, offset, regions, two directions, taper
  /** Does this extrude need the extended builder? (Plain blind / mid / through parts keep the old one, and so their names.) */
  lib.extrudeExtended = (f) => ['upto', 'next', 'vertex', 'offset'].includes(f.end) || f.two || (f.taper && f.taper !== 0) || (Array.isArray(f.regions) && f.regions.length);

  lib.extrudeExt = (f, ctx, pr, frame) => {
    const { oc, T, H } = ctx;
    const s = (f.op === 'cut' ? -1 : 1) * (f.reverse ? -1 : 1);
    const u = V.mul(frame.n, s);
    const W = (p) => V.toWorld(frame, p[0], p[1]);
    const polyPts = (f.regions?.length ? regionsAt(pr.loops, f.regions, fail).flatMap((r) => [r.outer, ...r.holes]) : pr.loops.map((_, i) => i)).flatMap((i) => pr.loops[i].poly).map(W);
    const regions = f.regions?.length ? regionsAt(pr.loops, f.regions, fail) : null;
    const rg = () => bodyRange(ctx, frame);
    let a = 0, b = f.depth, clip = null;   // extent along u; clip = { o, n } the face plane it stops at
    // which: 'upto' (the face it goes up to) | 'next' (the next face)
    const toPlane = (o, n, which) => {
      const un = V.dot(u, n);
      if (Math.abs(un) < 1e-9) fail(t(which === 'next' ? 'model.brep_design.next_parallel' : 'model.brep_design.upto_parallel'));
      const ts = polyPts.map((x) => V.dot(V.sub(o, x), n) / un);
      const lo = Math.min(...ts), hi = Math.max(...ts);
      const sc = Math.max(1, ...polyPts.map((x) => V.len(V.sub(x, frame.o))));
      if (lo <= 1e-9 * sc) fail(t(which === 'next' ? 'model.brep_design.next_behind' : 'model.brep_design.upto_behind'));
      if (hi - lo <= 1e-9 * sc) { b = lo; return; }   // parallel to the sketch: an exact depth
      b = hi * 1.02 + 1;
      clip = { o, n };
    };
    if (f.end === 'blind') b = f.depth;
    else if (f.end === 'mid') { a = -f.depth / 2; b = f.depth / 2; }
    else if (f.end === 'through') {
      if (f.op !== 'cut') fail(t('model.brep.through_all_cuts'));
      const r = rg(); if (!r) fail(t('model.brep.nothing_to_cut'));
      const far = s > 0 ? r[1] : -r[0];
      if (far <= 1e-9) fail(t('model.brep.nothing_to_cut_side'));
      b = far + 1 + 0.01 * (r[1] - r[0]);
    } else if (f.end === 'upto' || f.end === 'offset') {
      if (!f.upto) fail(t('model.brep_design.upto_pick'));
      const tp = resolvePlane(f.upto, ctx);
      let o = tp.o;
      if (f.end === 'offset') { const side = Math.sign(V.dot(u, tp.n)) || 1; o = V.sub(tp.o, V.mul(tp.n, side * f.offset)); }
      toPlane(o, tp.n, 'upto');
    } else if (f.end === 'vertex') {
      if (!f.vertex) fail(t('model.brep_design.vertex_pick'));
      const p = pointOf(f.vertex, ctx);
      b = V.dot(V.sub(p, frame.o), u);
      if (b <= 1e-9) fail(t('model.brep_design.vertex_behind'));
    } else if (f.end === 'next') {
      const r = rg(); if (!r) fail(t('model.brep_design.next_no_body'));
      const far = (s > 0 ? r[1] : -r[0]) + 1 + 0.01 * (r[1] - r[0]);
      if (far <= 1e-9) fail(t('model.brep_design.next_nothing_side'));
      const long = prism(0, far);
      const ov = combine(ctx, 'common', long.shape, long.names, [{ shape: ctx.body, names: ctx.names }]);
      let best = null;
      const sc = Math.max(1, far);
      for (const fc of H.unique(ov.shape, 'FACE')) {
        const ts = H.explore(fc, 'VERTEX').map((v) => V.dot(V.sub(H.xyz(T(oc.BRep_Tool.Pnt(T(oc.TopoDS.Vertex(v))))), frame.o), u));
        if (!ts.length) continue;
        const lo = Math.min(...ts), hi = Math.max(...ts);
        if (hi <= 1e-7 * sc || lo >= far - 1e-7 * sc) continue;   // the sketch plane and the far cap
        // the prism's own side walls (planes or cylinders along the direction) are not faces it meets
        const ad = T(new oc.BRepAdaptor_Surface(T(oc.TopoDS.Face(fc)), true));
        const ty = ad.GetType();
        if (ty === 'GeomAbs_Plane' && Math.abs(V.dot(H.xyz(T(T(T(ad.Plane()).Axis()).Direction())), u)) < 1e-9) continue;
        if (ty === 'GeomAbs_Cylinder' && Math.abs(V.dot(H.xyz(T(T(T(ad.Cylinder()).Axis()).Direction())), u)) > 1 - 1e-9) continue;
        const gp = T(new oc.GProp_GProps());
        oc.BRepGProp.SurfaceProperties(fc, gp, false, false);
        const mid = V.dot(V.sub(H.xyz(T(gp.CentreOfMass())), frame.o), u);
        if (!best || lo < best.lo - 1e-7 * sc || (Math.abs(lo - best.lo) <= 1e-7 * sc && mid < best.mid)) best = { lo, mid, fc };
      }
      if (!best) fail(t('model.brep_design.next_no_face'));
      const ad = T(new oc.BRepAdaptor_Surface(T(oc.TopoDS.Face(best.fc)), true));
      if (ad.GetType() !== 'GeomAbs_Plane') fail(t('model.brep_design.next_curved'));
      const pl = T(ad.Plane());
      toPlane(H.xyz(T(pl.Location())), H.xyz(T(T(pl.Axis()).Direction())), 'next');
    }
    if (f.two) {
      if (f.end === 'mid') fail(t('model.brep_design.mid_two'));
      a = -f.depth2;
    }
    if (f.taper && f.two) fail(t('model.brep_design.taper_two'));
    if (f.taper && f.end === 'mid') fail(t('model.brep_design.taper_mid'));
    if (!(b - a > 0)) fail(t('model.brep.depth_positive'));

    function prism(a0, b0) {
      const lift = s > 0 ? a0 : -b0;
      const { faces, edgeOf } = profileFaces(oc, T, H, pr.loops, frame, lift, regions);
      const out = [];
      for (const face of faces) {
        const mk = T(new oc.BRepPrimAPI_MakePrism(face, H.vec(V.mul(frame.n, b0 - a0)), false, true));
        if (!mk.IsDone()) fail(t('model.brep.extrude_failed'));
        const names = nameSweep(ctx, mk, f.id, edgeOf, false);
        // start = the cap at a (behind), end = the cap at b (ahead along the direction)
        const [ka, kb] = s > 0 ? ['start', 'end'] : ['end', 'start'];
        for (const [k, sh] of [[ka, mk.FirstShape()], [kb, mk.LastShape()]]) { T(sh); if (!sh.IsNull()) for (const fc of H.explore(sh, 'FACE')) names.set(fc, `${f.id}.${k}`); }   // i18n-ignore: face names
        out.push({ shape: T(mk.Shape()), names });
      }
      if (out.length === 1) return out[0];
      let acc = out[0];
      for (const t of out.slice(1)) acc = combine(ctx, 'fuse', acc.shape, acc.names, [t]);
      return acc;
    }

    let tool = prism(a, b);
    if (f.taper) {
      const mk = T(new oc.BRepOffsetAPI_DraftAngle(tool.shape));
      const pln = T(new oc.gp_Pln(H.pnt(frame.o), H.dir(u)));
      for (const [face, name] of tool.names.entries()) {
        if (!/\.side:/.test(name)) continue;
        try { mk.Add(T(oc.TopoDS.Face(face)), H.dir(u), f.taper * Math.PI / 180, pln, true); } catch (e) { fail(t('model.brep_design.taper_add_failed_why', { why: occtMessage(oc, e) })); }
        if (!mk.AddDone()) fail(t('model.brep_design.taper_add_failed'));
      }
      try { mk.Build(H.prog()); } catch (e) { fail(t('model.brep_design.taper_failed_why', { why: occtMessage(oc, e) })); }
      if (!mk.IsDone()) fail(t('model.brep_design.taper_failed'));
      const shape = T(mk.Shape());
      const names = new SMap(H.hash);
      for (const [face, name] of tool.names.entries()) { const m = T(mk.ModifiedShape(face)); names.set(m.IsNull() ? face : m, name); }
      tool = { shape, names };
    }
    if (clip) {
      // keep the part of the long prism on the sketch's side of the face plane; the cut face is the end
      const face = T(T(new oc.BRepBuilderAPI_MakeFace(T(new oc.gp_Pln(H.pnt(clip.o), H.dir(clip.n))))).Face());
      const ref = polyPts[0];
      const hs = T(T(new oc.BRepPrimAPI_MakeHalfSpace(face, H.pnt(ref))).Solid());
      const hsNames = new SMap(H.hash);
      for (const fc of H.explore(hs, 'FACE')) hsNames.set(fc, `${f.id}.end`);   // i18n-ignore: a face name
      for (const [fc, name] of [...tool.names.entries()]) if (name === `${f.id}.end`) tool.names.set(fc, `${f.id}.far`);   // i18n-ignore: face names
      tool = combine(ctx, 'common', tool.shape, tool.names, [{ shape: hs, names: hsNames }]);
    }
    return { tools: [{ ...tool, op: f.op }] };
  };
}
