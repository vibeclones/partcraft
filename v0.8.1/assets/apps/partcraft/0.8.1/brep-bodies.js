/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-bodies.js — the exact kernel's body tools (DOM-free; OCCT comes in through brep.js's ctx, 2026-10-11): body
 * tracking (which solid is which body, across rebuilds), Combine (BRepAlgoAPI_Fuse / Cut / Common between bodies),
 * Move/Copy body (BRepBuilderAPI_Transform: translate, point to point, rotate about an axis, align plane to plane),
 * Scale body (uniform: gp_Trsf scale; non-uniform: brep-gtrsf.js), the path pattern, and body copies for linear and
 * circular patterns. brep.js calls installBodies(FEATURES, lib) after installDesign (it uses lib.combine, lib.pathWire,
 * lib.refResolvers, lib.pointOf from there) and lib.trackBodies(ctx, f) after every feature that changed the solid.
 *
 * Body ids: bodies.js header. Tracking (trackBodies): each solid's faces carry names (brep.js); a solid takes the body
 * id its face names had before the feature (the earliest-made one when a boolean merged bodies), unless the feature
 * gave its result names an id (ctx.bodyHint: Combine → its target, copies → '<src>@<feature>#<i>'); a solid whose
 * faces are all new starts a body named after the feature. Copies and Combine's tool faces get name suffixes
 * (@<feature>#i / @<feature>) so no name is in two bodies.
 *
 * Face names: a moved body keeps its names; a copy's are suffixed @<move>#1, a pattern copy's @<pattern>#i; a scaled body
 * keeps its names; Combine's result keeps the target's names and the tool faces it took gain @<combine>.
 */
import * as V from './vec.js';
import { refFeature } from './refgeom.js';
import * as BD from './bodies.js';
import { affineShape } from './brep-gtrsf.js';
import { t as tr } from './i18n.js';

export function installBodies(FEATURES, lib) {
  const { fail, SMap, occtMessage, resolveDir } = lib;

  // ---------------------------------------------------------------- tracking
  /** After a feature changed ctx.body: give every solid its body id (see the header). */
  lib.trackBodies = (ctx, f) => {
    const { H } = ctx;
    const st = (ctx.bodyState ||= { nameBody: new Map(), order: [], solidBody: null });
    const hint = ctx.bodyHint && ctx.bodyHint.fid === f.id ? ctx.bodyHint.map : null;
    ctx.bodyHint = null;
    st.solidBody = new SMap(H.hash);
    const res = ctx.results.get(f.id);
    if (!ctx.body) { st.nameBody = new Map(); if (res) res.bodies = []; return; }
    const rank = (id) => { const k = st.order.indexOf(id); return k < 0 ? Infinity : k; };
    const next = new Map();
    let fresh = 0;
    const seen = new Set();
    for (const so of H.explore(ctx.body, 'SOLID')) {
      const names = H.unique(so, 'FACE').map((fc) => ctx.names.get(fc)).filter(Boolean);
      const ids = new Set();
      for (const n of names) { const id = hint?.get(n) ?? st.nameBody.get(n); if (id) ids.add(id); }
      let id;
      if (ids.size) id = [...ids].reduce((a, b) => (rank(b) < rank(a) ? b : a));
      else { id = fresh ? `${f.id}:${fresh + 1}` : f.id; fresh++; }
      if (!st.order.includes(id)) st.order.push(id);
      for (const n of names) if (!next.has(n)) next.set(n, id);
      st.solidBody.set(so, id);
      seen.add(id);
    }
    st.nameBody = next;
    // the bodies after this feature, in the order they were made (the page lists what a later feature can pick)
    if (res) res.bodies = st.order.filter((id) => seen.has(id));
  };
  /** The body id of a solid of the current ctx.body. */
  const bodyOf = (ctx, so) => {
    const st = ctx.bodyState;
    if (!st || !st.solidBody) return null;
    const id = st.solidBody.get(so);
    if (id) return id;
    for (const fc of ctx.H.unique(so, 'FACE')) { const n = ctx.names.get(fc); if (n && st.nameBody.has(n)) return st.nameBody.get(n); }
    return null;
  };
  lib.bodyOf = bodyOf;
  /** Plain data for the page: each body's id, solids, exact volume and box; the body of each face (regen.faces order). */
  lib.bodyList = (ctx) => {
    if (!ctx.body) return { bodies: [], faceBody: [] };
    const { oc, T, H } = ctx;
    const by = new Map(), faceId = new SMap(H.hash);
    for (const so of H.explore(ctx.body, 'SOLID')) {
      const id = bodyOf(ctx, so) || '?';
      const gp = T(new oc.GProp_GProps());
      oc.BRepGProp.VolumeProperties(so, gp, false, false, false);
      const bb = ctx.bbox(so);
      const b = by.get(id) || { id, solids: 0, volume: 0, bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
      b.solids++; b.volume += gp.Mass();
      for (let k = 0; k < 3; k++) { b.bbox.min[k] = Math.min(b.bbox.min[k], bb.min[k]); b.bbox.max[k] = Math.max(b.bbox.max[k], bb.max[k]); }
      by.set(id, b);
      for (const fc of H.unique(so, 'FACE')) faceId.set(fc, id);
    }
    return { bodies: [...by.values()], faceBody: ctx.faceTable().map((r) => faceId.get(r.face) || null) };
  };

  // ---------------------------------------------------------------- shared helpers
  const word = (ctx, id) => BD.bodyLabel(ctx.part, id);
  /** The solids of the bodies `ids`, failing in words when one is gone. */
  function solidsOf(ctx, ids, what) {
    if (!ctx.body) fail(tr('model.brep_bodies.no_bodies'));
    const all = ctx.H.explore(ctx.body, 'SOLID');
    const out = [];
    for (const id of ids) {
      const mine = all.filter((so) => bodyOf(ctx, so) === id);
      if (!mine.length) fail(what === 'target' ? tr('model.brep_bodies.gone.target', { body: word(ctx, id) }) : what === 'tool' ? tr('model.brep_bodies.gone.tool', { body: word(ctx, id) }) : tr('model.brep_bodies.gone.body', { body: word(ctx, id) }));
      out.push(...mine);
    }
    return out;
  }
  const others = (ctx, used) => ctx.H.explore(ctx.body, 'SOLID').filter((so) => !used.some((u) => u.IsSame(so)));
  function compound(ctx, solids) {
    const { oc, T } = ctx;
    const b = T(new oc.TopoDS_Builder());
    const comp = T(new oc.TopoDS_Compound());
    b.MakeCompound(comp);
    for (const s of solids) b.Add(comp, s);
    return comp;
  }
  /** shape → its image under column-major M4 (rigid: located; with a scale: copied), names carried (+ suffix). */
  function transformed(ctx, shape, M4, suffix = '', { scale = null } = {}) {
    const { oc, T, H } = ctx;
    let tr;
    if (scale) {
      const t = T(new oc.gp_Trsf());
      t.SetScale(H.pnt(scale.c), scale.s);
      tr = T(new oc.BRepBuilderAPI_Transform(shape, t, true, false));
    } else tr = T(new oc.BRepBuilderAPI_Transform(shape, H.trsf(M4), false, false));
    const out = T(tr.Shape());
    const names = new SMap(H.hash);
    for (const fc of H.unique(shape, 'FACE')) {
      const n = ctx.names.get(fc);
      const m = T(tr.ModifiedShape(fc));
      if (n && !m.IsNull()) names.set(m, n + suffix);
    }
    return { shape: out, names };
  }
  /** A new ctx.body made of these solids, names from the given maps. */
  function result(ctx, parts) {
    const { H } = ctx;
    const solids = [], names = new SMap(H.hash);
    for (const p of parts) {
      for (const so of H.explore(p.shape, 'SOLID')) {
        solids.push(so);
        for (const fc of H.unique(so, 'FACE')) { const n = p.names.get(fc) ?? ctx.names.get(fc); if (n) names.set(fc, n); }
      }
    }
    if (!solids.length) return null;
    return { shape: solids.length === 1 ? solids[0] : compound(ctx, solids), names };
  }
  const hintAll = (ctx, f, parts) => {
    const map = new Map();
    for (const { shape, names, id } of parts) for (const fc of ctx.H.unique(shape, 'FACE')) { const n = names.get(fc); if (n) map.set(n, id); }
    ctx.bodyHint = { fid: f.id, map };
  };

  // ---------------------------------------------------------------- Combine
  FEATURES.combine = (f, ctx) => {
    const { oc, T, H } = ctx;
    if (!ctx.body) fail(tr('model.brep_bodies.combine.no_bodies'));
    if (!f.target) fail(tr('model.brep_bodies.combine.pick_target'));
    if (!f.tools.length) fail(tr('model.brep_bodies.combine.pick_tools'));
    if (f.tools.includes(f.target)) fail(tr('model.brep_bodies.combine.target_is_tool'));
    const tgt = solidsOf(ctx, [f.target], 'target');
    const groups = f.tools.map((id) => ({ id, solids: solidsOf(ctx, [id], 'tool') }));
    const toolSolids = groups.flatMap((g) => g.solids);
    const rest = others(ctx, [...tgt, ...toolSolids]);
    const suffixed = (solids) => { const m = new SMap(H.hash); for (const so of solids) for (const fc of H.unique(so, 'FACE')) { const n = ctx.names.get(fc); if (n) m.set(fc, n + '@' + f.id); } return m; };
    let res = { shape: tgt.length === 1 ? tgt[0] : compound(ctx, tgt), names: ctx.names };
    if (f.op === 'intersect') {
      // SolidWorks' "common": what all of them share, one tool after another
      for (const g of groups) res = lib.combine(ctx, 'common', res.shape, res.names, [{ shape: g.solids.length === 1 ? g.solids[0] : compound(ctx, g.solids), names: suffixed(g.solids) }]);
    } else res = lib.combine(ctx, f.op === 'join' ? 'fuse' : 'cut', res.shape, res.names, [{ shape: compound(ctx, toolSolids), names: suffixed(toolSolids) }]);
    if (!H.explore(res.shape, 'SOLID').length) fail(f.op === 'cut' ? tr('model.brep_bodies.combine.cut_all') : f.op === 'intersect' ? tr('model.brep_bodies.combine.no_overlap') : tr('model.brep_bodies.combine.no_solid'));
    const parts = [{ shape: res.shape, names: res.names, id: f.target }];
    if (f.keep) for (const g of groups) for (const so of g.solids) {
      // kept tools are copied, so no face is in two solids
      const cp = transformed(ctx, so, null, '', { scale: { c: [0, 0, 0], s: 1 } });
      parts.push({ ...cp, id: g.id });
    }
    for (const so of rest) parts.push({ shape: so, names: ctx.names, id: bodyOf(ctx, so) });
    const out = result(ctx, parts);
    hintAll(ctx, f, parts.filter((p) => p.id));
    return { replace: out };
  };

  // ---------------------------------------------------------------- Move/Copy body
  const resolvers = (ctx) => lib.refResolvers(ctx);
  /** The axis of a rotate: a straight edge or a circle's axis, a cylinder's axis, or a direction reference. */
  function axisOf(f, ctx) {
    if (f.edge) return refFeature({ type: 'axis', mode: 'edge', edge: f.edge }, resolvers(ctx));
    if (f.face) return refFeature({ type: 'axis', mode: 'cyl', face: f.face }, resolvers(ctx));
    if (f.axis) { const a = resolveDir(f.axis, ctx); return { o: a.o, d: V.norm(a.d) }; }
    return fail(tr('model.brep_bodies.move.pick_axis'));
  }
  /** The column-major 4×4 a Move body applies. */
  function moveMatrix(f, ctx) {
    if (f.mode === 'translate') return V.translation([f.dx, f.dy, f.dz]);
    if (f.mode === 'points') {
      if (!f.from || !f.to) fail(tr('model.brep_bodies.move.pick_points'));
      return V.translation(V.sub(lib.pointOf(f.to, ctx), lib.pointOf(f.from, ctx)));
    }
    if (f.mode === 'rotate') { const a = axisOf(f, ctx); return V.rotationAbout(a.o, a.d, f.angle); }
    if (f.mode === 'align') {
      if (f.planes.length < 2) fail(tr('model.brep_bodies.move.pick_faces'));
      const R = resolvers(ctx);
      const a = R.plane(f.planes[0]), b = R.plane(f.planes[1]);
      const want = f.flip ? b.n : V.mul(b.n, -1);   // faces meet face to face (opposite normals) unless flipped
      const Rm = BD.minimalRotation(V.norm(a.n), V.norm(want), V.norm(V.cross(a.n, Math.abs(a.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])));
      const c = a.center || a.o;
      const t = V.mul(b.n, V.dot(V.sub(b.o, c), b.n));
      return BD.rigid(Rm, c, t);
    }
    return fail(tr('model.brep_bodies.move.unknown'));
  }
  lib.moveMatrix = moveMatrix;
  FEATURES.movebody = (f, ctx) => {
    if (!f.bodies.length) fail(tr('model.brep_bodies.move.pick_bodies'));
    const groups = f.bodies.map((id) => ({ id, solids: solidsOf(ctx, [id], 'body') }));
    const M4 = moveMatrix(f, ctx);
    if (!M4.every(Number.isFinite)) fail(tr('model.brep_bodies.move.not_finite'));
    const used = groups.flatMap((g) => g.solids);
    const parts = others(ctx, used).map((so) => ({ shape: so, names: ctx.names, id: bodyOf(ctx, so) }));
    for (const g of groups) for (const so of g.solids) {
      const moved = transformed(ctx, so, M4, f.copy ? `@${f.id}#1` : '');
      if (f.copy) parts.push({ shape: so, names: ctx.names, id: g.id }, { ...moved, id: `${g.id}@${f.id}#1` });
      else parts.push({ ...moved, id: g.id });
    }
    const out = result(ctx, parts);
    hintAll(ctx, f, parts.filter((p) => p.id));
    return { replace: out };
  };

  // ---------------------------------------------------------------- Scale body
  FEATURES.scalebody = (f, ctx) => {
    const { oc, T, H } = ctx;
    if (!f.bodies.length) fail(tr('model.brep_bodies.scale.pick_bodies'));
    const groups = f.bodies.map((id) => ({ id, solids: solidsOf(ctx, [id], 'body') }));
    const used = groups.flatMap((g) => g.solids);
    const sel = compound(ctx, used);
    const bb = ctx.bbox(sel);
    const c = f.point ? lib.pointOf(f.point, ctx) : V.mul(V.add(bb.min, bb.max), 0.5);
    const parts = others(ctx, used).map((so) => ({ shape: so, names: ctx.names, id: bodyOf(ctx, so) }));
    let note;
    const s = [f.uniform ? f.s : f.sx, f.uniform ? f.s : f.sy, f.uniform ? f.s : f.sz];
    if (!s.every((v) => v > 0)) fail(tr('model.brep_bodies.scale.factor_positive'));
    if (f.uniform || (Math.abs(s[0] - s[1]) < 1e-15 && Math.abs(s[1] - s[2]) < 1e-15)) {
      for (const g of groups) for (const so of g.solids) parts.push({ ...transformed(ctx, so, null, '', { scale: { c, s: s[0] } }), id: g.id });
    } else {
      // non-uniform: an affine map of the BRep (this build has no BRepBuilderAPI_GTransform; brep-gtrsf.js)
      const A = { m: [[s[0], 0, 0], [0, s[1], 0], [0, 0, s[2]]], t: [c[0] * (1 - s[0]), c[1] * (1 - s[1]), c[2] * (1 - s[2])] };
      let out;
      try { out = affineShape(oc, sel, A, { bbox: bb }); } catch (e) { fail(tr('model.brep_bodies.scale.failed', { why: occtMessage(oc, e).replace(/\.$/, '') })); }
      const shape = T(out.shape);
      const check = T(new oc.BRepCheck_Analyzer(shape, true, false));
      if (!check.IsValid()) fail(tr('model.brep_bodies.scale.invalid'));
      const oldF = H.explore(sel, 'FACE'), newF = H.explore(shape, 'FACE');
      if (oldF.length !== newF.length) fail(tr('model.brep_bodies.scale.lost_faces'));
      const names = new SMap(H.hash);
      oldF.forEach((fc, i) => { const n = ctx.names.get(fc); if (n) names.set(newF[i], n); });
      // body ids by solid order (the map keeps the order)
      const oldS = H.explore(sel, 'SOLID'), newS = H.explore(shape, 'SOLID');
      oldS.forEach((so, i) => parts.push({ shape: newS[i], names, id: bodyOf(ctx, so) }));
      note = out.approximated
        ? tr('model.brep_bodies.scale.note_approx', { sx: fmt(s[0]), sy: fmt(s[1]), sz: fmt(s[2]), n: out.approximated, dev: fmtE(out.deviation) })
        : tr('model.brep_bodies.scale.note_exact', { sx: fmt(s[0]), sy: fmt(s[1]), sz: fmt(s[2]) });
    }
    const out = result(ctx, parts);
    hintAll(ctx, f, parts.filter((p) => p.id));
    return { replace: out, note };
  };
  const fmt = (v) => String(+Number(v).toPrecision(8));
  const fmtE = (v) => (v < 1e-3 ? v.toExponential(1) : String(+v.toFixed(6)));

  // ---------------------------------------------------------------- copies of bodies (patterns)
  /** Tools for copies of f.bodies under matrixOf(i), i = 1 … count−1: new bodies '<src>@<f>#i'. */
  lib.bodyCopies = (ctx, f, count, matrixOf) => {
    const groups = f.bodies.map((id) => ({ id, solids: solidsOf(ctx, [id], 'body') }));
    const tools = [], parts = [];
    for (let i = 1; i < count; i++) {
      const M4 = matrixOf(i);
      for (const g of groups) for (const so of g.solids) {
        const t = transformed(ctx, so, M4, `@${f.id}#${i}`);
        tools.push({ ...t, op: 'new' });
        parts.push({ ...t, id: `${g.id}@${f.id}#${i}` });
      }
    }
    hintAll(ctx, f, parts);
    return { tools };
  };

  // ---------------------------------------------------------------- path pattern
  /** Arc length along a wire (BRepAdaptor_CompCurve), by 8-point Gauss–Legendre on 24 pieces of every smooth stretch. */
  const GL = [[-0.9602898564975363, 0.1012285362903763], [-0.7966664774136267, 0.2223810344533745], [-0.5255324099163290, 0.3137066458778873], [-0.1834346424956498, 0.3626837833783620],
    [0.1834346424956498, 0.3626837833783620], [0.5255324099163290, 0.3137066458778873], [0.7966664774136267, 0.2223810344533745], [0.9602898564975363, 0.1012285362903763]];
  function pathCurve(ctx, wire) {
    const { oc, T, H } = ctx;
    const cc = T(new oc.BRepAdaptor_CompCurve(wire, false));
    const t0 = cc.FirstParameter(), t1 = cc.LastParameter();
    const d1 = (t) => { const r = cc.EvalD1(t); const v = [r.D1.X(), r.D1.Y(), r.D1.Z()]; const p = H.xyz(r.Point); r.Point.delete(); r.D1.delete(); return { p, v }; };
    const speed = (t) => V.len(d1(t).v);
    let br = [t0, t1];
    try {
      const n = cc.NbIntervals(oc.GeomAbs_Shape.GeomAbs_C1);
      const arr = T(new oc.NCollection_Array1_double(1, n + 1));
      cc.Intervals(arr, oc.GeomAbs_Shape.GeomAbs_C1);
      br = []; for (let i = 1; i <= n + 1; i++) br.push(arr.Value(i));
    } catch { br = [t0, t1]; }
    const knots = [], cum = [0];
    for (let k = 0; k < br.length - 1; k++) for (let j = 0; j < 24; j++) knots.push(br[k] + (br[k + 1] - br[k]) * j / 24);
    knots.push(t1);
    const seg = (a, b) => { let s = 0; const h = (b - a) / 2, m = (a + b) / 2; for (const [x, w] of GL) s += w * speed(m + h * x); return s * h; };
    for (let i = 0; i < knots.length - 1; i++) cum.push(cum[i] + seg(knots[i], knots[i + 1]));
    const L = cum[cum.length - 1];
    /** the parameter at arc length s (Newton inside its piece, bisection-guarded) */
    const paramAt = (s) => {
      s = Math.max(0, Math.min(L, s));
      let i = cum.findIndex((c) => c > s) - 1;
      if (i < 0) i = knots.length - 2;
      let a = knots[i], b = knots[i + 1], lo = a, hi = b, t = a + (b - a) * ((s - cum[i]) / Math.max(1e-300, cum[i + 1] - cum[i]));
      for (let it = 0; it < 60; it++) {
        const f0 = cum[i] + seg(a, t) - s;
        if (Math.abs(f0) < 1e-13 * Math.max(1, L)) break;
        if (f0 > 0) hi = t; else lo = t;
        let tn = t - f0 / Math.max(1e-300, speed(t));
        if (!(tn > lo && tn < hi)) tn = (lo + hi) / 2;
        t = tn;
      }
      return t;
    };
    /** the arc length of the path point nearest p: sampled, then the root of (C(s) − p)·C'(s) bisected */
    const nearestS = (p) => {
      let best = 0, bd = Infinity;
      const n = (knots.length - 1) * 8;
      const sAt = (k) => (L * k) / n;
      for (let k = 0; k <= n; k++) { const q = d1(paramAt(sAt(k))).p; const d = V.len(V.sub(q, p)); if (d < bd) { bd = d; best = k; } }
      const g = (s) => { const r = d1(paramAt(s)); return V.dot(V.sub(r.p, p), r.v); };
      const pick = (lo, hi) => {
        let glo = g(lo); const ghi = g(hi);
        if (glo > 0 || ghi < 0) return null;   // no minimum inside
        for (let it = 0; it < 200 && hi - lo > 1e-15 * Math.max(1, L); it++) { const m = (lo + hi) / 2, gm = g(m); if (gm < 0) { lo = m; glo = gm; } else hi = m; }
        return (lo + hi) / 2;
      };
      const cands = [pick(sAt(Math.max(0, best - 1)), sAt(best)), pick(sAt(best), sAt(Math.min(n, best + 1))), sAt(best)].filter((x) => x !== null);
      return cands.reduce((a, b) => (V.len(V.sub(d1(paramAt(b)).p, p)) < V.len(V.sub(d1(paramAt(a)).p, p)) - 1e-15 ? b : a));
    };
    const at = (s) => { const r = d1(paramAt(s)); return { p: r.p, t: V.norm(r.v) }; };
    return { L, at, nearestS };
  }
  lib.pathCurve = pathCurve;

  FEATURES.pathpattern = (f, ctx) => {
    const { H } = ctx;
    const useBodies = f.bodies && f.bodies.length;
    if (!useBodies && !f.seeds.length) fail(tr('model.brep_bodies.path.pick_seeds'));
    const path = lib.pathWire(ctx, f.path, 'path');
    const pc = pathCurve(ctx, path.wire);
    if (!(pc.L > 1e-9)) fail(tr('model.brep_bodies.path.no_length'));
    // what is copied, and where it sits now (the centre of its box picks the start along the path)
    let seedShapes = [];
    let tools = [];
    if (useBodies) seedShapes = solidsOf(ctx, f.bodies, 'body');
    else {
      for (const id of f.seeds) {
        const g = ctx.part.features.find((x) => x.id === id);
        const t = ctx.tools.get(id);
        if (g && ['fillet', 'chamfer', 'shell', 'draft'].includes(g.type)) fail(tr('model.brep_bodies.path.not_copyable', { name: g.name }));
        if (!t) fail(g ? tr('model.brep_bodies.path.no_solid', { name: g.name }) : tr('model.brep_bodies.path.no_solid_any'));
        tools.push(...t);
      }
      seedShapes = tools.map((t) => t.shape);
    }
    const bb = ctx.bbox(compound(ctx, seedShapes.flatMap((s) => H.explore(s, 'SOLID'))));
    const centre = V.mul(V.add(bb.min, bb.max), 0.5);
    const s0 = pc.nearestS(centre);
    const st = BD.pathStations({ L: pc.L, s0, closed: path.closed, count: f.count, spacing: f.spacing, d: f.d, reverse: f.reverse });
    if (st.error) fail(st.error);
    const base = pc.at(s0);
    // the turn of each copy: the tangent carried along the path without twisting (exact for flat paths)
    const dir = f.reverse ? -1 : 1;
    const turns = [];
    const offs = st.map((x) => { let o = (x - s0) * dir; if (path.closed) o = ((o % pc.L) + pc.L) % pc.L; return Math.abs(o); });
    let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tPrev = base.t, walked = 0;
    for (let i = 0; i < st.length; i++) {
      if (f.orient !== 'path' || i === 0) { turns.push(R); continue; }
      const dist = offs[i] - walked;
      const n = Math.max(1, Math.ceil(dist / (pc.L / 2000)));
      for (let k = 1; k <= n; k++) {
        let s = s0 + dir * (walked + dist * k / n);
        if (path.closed) s = ((s % pc.L) + pc.L) % pc.L;
        const t = pc.at(s).t;
        R = BD.mat3Mul(BD.minimalRotation(tPrev, t), R);
        tPrev = t;
      }
      walked = offs[i];
      turns.push(R);
    }
    const matrixOf = (i) => BD.rigid(turns[i], base.p, V.sub(pc.at(st[i]).p, base.p));
    if (useBodies) return lib.bodyCopies(ctx, f, f.count, matrixOf);
    const out = [];
    for (let i = 1; i < f.count; i++) {
      const M4 = matrixOf(i);
      for (const t of tools) {
        const { oc, T } = ctx;
        const tr = T(new oc.BRepBuilderAPI_Transform(t.shape, ctx.H.trsf(M4), false, false));
        const shape = T(tr.Shape());
        const names = new SMap(H.hash);
        for (const [fc, nm] of t.names.entries()) { const m = T(tr.ModifiedShape(fc)); if (!m.IsNull()) names.set(m, `${nm}@${f.id}#${i}`); }
        out.push({ shape, op: t.op, names });
      }
    }
    return { tools: out };
  };
}
