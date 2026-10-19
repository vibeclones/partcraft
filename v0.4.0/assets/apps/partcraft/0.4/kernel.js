/* SPDX-License-Identifier: Apache-2.0 */
/**
 * kernel.js — rebuilds a part's solid from its feature history with manifold-3d (DOM-free).
 * The manifold-3d module object is passed in (`regenerate(part, M)`), so Node tests build real
 * parts with the same code the page runs.
 *
 * Every feature makes "tools" ({ m: Manifold, op: 'add'|'cut' }) that are applied to the body in
 * order; patterns and mirrors copy earlier features' tools. Each tool gets its own manifold
 * original ID, so every triangle of the result knows which feature made it (`triFeature`).
 * A failing feature records its error and is skipped (the body stays as it was); features that
 * need it are "skipped" with the reason. Nothing throws out of regenerate().
 *
 * Planar faces a sketch can sit on are offered per feature as candidates with stable references
 * that follow the feature when its dimensions change:
 *   extrude  'start' / 'end' caps, 'side' + line id for each straight edge of the profile
 *   revolve  'side' + line id for each profile line square to the axis (the flat rings)
 * Normals point out of the finished body (a cut's floor faces back up).
 *
 *   regenerate(part, M, { upTo }) → { results: Map(id → result), mesh, stats, frames, candidates, axes }
 *     upTo: build only the first n features (sketch editing shows the part as the sketch sees it)
 *   result = { status: 'ok'|'error'|'skipped'|'suppressed'|'rolled', message?, warning?, solve? }
 */
import * as V from './vec.js';
import { profile, insideLoops, loosePoints, byId, pointXY, tessCircle } from './sketch.js';
import { solveSketch } from './solver.js';
import { builtCount, dependsOn, EXACT_ONLY, FEATURE_LABELS } from './part.js';
import { refName, findEdge, findFace } from './brep.js';
import { refFeature } from './refgeom.js';
import { regionsAt } from './brep-design.js';
import { ISO_COARSE } from './design-features.js';
import { t } from './i18n.js';
import * as MF from './meshfaces.js';

class FeatureError extends Error {}
/** Exact-only features the mesh kernel builds anyway, approximately (0.4 K.4). */
export const MESH_BUILT = new Set(['fillet', 'chamfer', 'shell', 'draft']);
const fail = (m) => { throw new FeatureError(m); };

/** World frame of a plane reference, or throws FeatureError. */
function resolvePlane(ref, ctx) {
  if (ref.kind === 'base') return V.BASE_PLANES[ref.name];
  if (ref.kind === 'fixed') return V.frameFor(ref.n, ref.o);
  if (ref.kind === 'ref') { const g = ctx.refGeom?.get(ref.feature); if (!g || g.kind !== 'plane') fail(t('model.kernel.ref_plane_not_built')); return g.frame; }
  const res = ctx.results.get(ref.feature);
  const owner = ctx.part.features.find((f) => f.id === ref.feature);
  if (!res || res.status !== 'ok') fail(owner ? t('model.kernel.face_gone_not_built', { name: owner.name }) : t('model.kernel.face_gone_deleted'));
  if (ref.face === 'named') fail(t('kernel.mesh.named_face'));
  const c = (ctx.candidates.get(ref.feature) || []).find((k) => k.ref.face === ref.face && (ref.face !== 'side' || k.ref.entity === ref.entity));
  if (!c) fail(t('model.kernel.face_gone_from', { name: owner.name }));
  return c.frame;
}

function resolveDir(ref, ctx) {
  if (ref.kind === 'world') return { o: [0, 0, 0], d: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[ref.axis] };
  if (ref.kind === 'fixed') return { o: ref.o, d: V.norm(ref.d) };
  if (ref.kind === 'axis') {
    const a = ctx.axes.get(ref.feature);
    if (!a) fail(t('model.kernel.axis_revolve_not_built'));
    return a;
  }
  if (ref.kind === 'ref') {
    const g = ctx.refGeom.get(ref.feature);
    if (g && g.kind === 'axis') return { o: g.o, d: g.d };
    if (g && g.kind === 'plane') return { o: g.frame.o, d: g.frame.n };
    fail(t('model.kernel.ref_not_built'));
  }
  const frame = ctx.frames.get(ref.sketch);
  const sf = ctx.part.features.find((f) => f.id === ref.sketch);
  if (!frame || !sf) fail(t('model.kernel.sketch_line_not_built'));
  const l = byId(sf.sketch, ref.entity);
  if (!l || l.type !== 'line') fail(t('model.kernel.line_gone_from', { name: sf.name }));
  const a = V.toWorld(frame, ...pointXY(sf.sketch, l.p1)), b = V.toWorld(frame, ...pointXY(sf.sketch, l.p2));
  if (V.len(V.sub(b, a)) < 1e-12) fail(t('model.kernel.line_no_length'));
  return { o: a, d: V.norm(V.sub(b, a)) };
}

/** Extent of the body along a plane normal, relative to the plane: [min, max] or null. */
function bodyRange(ctx, frame) {
  if (!ctx.body) return null;
  const bb = ctx.body.boundingBox();
  let lo = Infinity, hi = -Infinity;
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) {
    const d = V.dot(V.sub([x, y, z], frame.o), frame.n);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return [lo, hi];
}

function sketchOf(ctx, id) {
  const f = ctx.part.features.find((g) => g.id === id);
  const frame = ctx.frames.get(id);
  if (!f || f.type !== 'sketch' || !frame) fail(t('model.kernel.sketch_not_built'));
  return { f, sk: f.sketch, frame };
}

function crossSection(ctx, loops) {
  const cs = ctx.T(new ctx.M.CrossSection(loops, 'EvenOdd'));
  if (cs.isEmpty() || cs.area() < 1e-12) fail(t('model.kernel.profile_no_area'));
  return cs;
}

function sideCandidates(sk, loops, frame, curves, op, extra) {
  const out = [];
  const eps = 1e-4 * Math.max(1, ...loops.flat().map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))));
  for (const { id } of curves) {
    const l = byId(sk, id);
    if (!l || l.type !== 'line') continue;
    const a = pointXY(sk, l.p1), b = pointXY(sk, l.p2);
    const r = extra(a, b, eps);
    if (!r) continue;
    let n = r.n;
    if (op === 'cut') n = V.mul(n, -1);
    out.push({ ref: { face: 'side', entity: id }, frame: V.frameFor(n, r.p) });
  }
  return out;
}

/** The named faces and edges of the body as it is now (K.2b): its mesh, each triangle's tool, meshfaces.js. */
function bodyFaces(ctx) {
  const gm = ctx.body.getMesh();
  const np = gm.numProp, nv = gm.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = gm.vertProperties[i * np + k];
  const indices = new Uint32Array(gm.triVerts);
  const runs = gm.runIndex, ids = gm.runOriginalID;
  const lists = [], listOf = new Map(), triTool = new Int32Array(indices.length / 3).fill(-1);
  for (let r = 0; r + 1 < runs.length; r++) {
    const sf = ctx.toolSurfs.get(ids[r]);
    if (!sf) continue;
    let k = listOf.get(ids[r]);
    if (k === undefined) { k = lists.length; listOf.set(ids[r], k); lists.push(sf); }
    for (let ti = runs[r] / 3; ti < runs[r + 1] / 3; ti++) triTool[ti] = k;
  }
  const mesh = { positions, indices };
  return { mesh, ...MF.namedFaces(mesh, triTool, lists, { segments: ctx.part.resolution || 64 }) };
}

/**
 * Fillets and chamfers on the mesh kernel (0.4 K.4): straight edges between two flat faces only. Each edge's corner is cut
 * away along the edge (or filled, on a concave edge) by a prism whose section is the region between the corner and the
 * rounding arc (or the chamfer line). Where rounded edges meet they are mitred, not blended: approximate, and said so.
 * Names as brep.js: `<feature>.blend:<k>` (a cylinder) / `<feature>.bevel:<k>` (a plane), k = the edge's place in the list.
 */
function edgeTools(f, ctx, kind) {
  if (!ctx.body) fail(t(kind === 'fillet' ? 'model.brep.no_body_round' : 'model.brep.no_body_chamfer'));
  const size = kind === 'fillet' ? f.r : f.d;
  if (!(size > 0)) fail(t(kind === 'fillet' ? 'model.brep.radius_positive' : 'model.brep.distance_positive'));
  if (!f.edges.length) fail(t('model.brep.pick_edges'));
  if (kind === 'fillet' && typeof f.r2 === 'number') fail(t('kernel.mesh.fillet_variable'));
  if (kind === 'chamfer' && f.mode === 'two' && !(f.d2 > 0)) fail(t('model.brep.d2_positive'));
  if (kind === 'chamfer' && f.mode === 'angle' && !(f.angle > 0 && f.angle < 90)) fail(t('model.brep.chamfer_angle'));
  const B = bodyFaces(ctx);
  const P = B.mesh.positions, I = B.mesh.indices;
  const pt = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const seg = Math.max(8, ctx.part.resolution || 64);
  const cut = [], fill = [];
  const done = new Set(), ends = [];
  f.edges.forEach((ref, k) => {
    const ei = findEdge(B.edges, ref);
    if (ei < 0) fail(t(kind === 'fillet' ? 'model.brep.round_edge_gone' : 'model.brep.chamfer_edge_gone', { a: ref.faces[0], b: ref.faces[1] }));
    if (done.has(ei)) return;
    done.add(ei);
    const e = B.edges[ei];
    const fA = B.faces.find((x) => x.name === e.faces[0]), fB = B.faces.find((x) => x.name === e.faces[1]);
    if (e.type !== 'line' || fA?.type !== 'plane' || fB?.type !== 'plane') fail(t('kernel.mesh.fillet_straight', { what: FEATURE_LABELS[kind] }));
    const a = e.a, d = V.norm(V.sub(e.b, e.a)), L = V.len(V.sub(e.b, e.a)), O = a;
    ends.push(e.a, e.b);
    // a direction in each face, square to the edge, pointing into that face (from a triangle of the face along the edge)
    const into = (face, n) => {
      let u = V.norm(V.cross(d, n));
      const fi = B.faces.indexOf(face), tol = 1e-5 * Math.max(1, L);
      for (let ti = 0; ti < I.length / 3; ti++) {
        if (B.triFace[ti] !== fi) continue;
        const vs = [0, 1, 2].map((q) => pt(I[ti * 3 + q]));
        const off = vs.map((v) => { const w = V.sub(v, a); return V.len(V.sub(w, V.mul(d, V.dot(w, d)))); });
        if (off.filter((x) => x <= tol).length !== 2) continue;
        const far = vs[off.findIndex((x) => x > tol)];
        if (V.dot(V.sub(far, a), u) < 0) u = V.mul(u, -1);
        return u;
      }
      fail(t('kernel.mesh.fillet_straight', { what: FEATURE_LABELS[kind] }));
    };
    const nA = fA.n, nB = fB.n, uA = into(fA, nA), uB = into(fB, nB);
    const convex = V.dot(uA, nB) < 0;
    const s = convex ? -1 : 1;   // the arc's centre: inside the material on a convex edge, outside on a concave one
    let tA, tB, arc = [];
    if (kind === 'fillet') {
      // the centre is size from both faces: tangent points sA, sB from the corner along each face
      const k1 = 1 - V.dot(nA, nB), sA = (s * size * k1) / V.dot(uA, nB), sB = (s * size * k1) / V.dot(uB, nA);
      if (!(sA > 0 && sB > 0) || sA > L * 1e3) fail(t('model.brep.round_no_fit', { size: size }));
      tA = V.add(O, V.mul(uA, sA)); tB = V.add(O, V.mul(uB, sB));
      const c = V.add(V.add(O, V.mul(uA, sA)), V.mul(nA, s * size));
      // the arc from tA to tB the short way, on the side facing the corner
      const v0 = V.sub(tA, c), v1 = V.sub(tB, c), ax = V.norm(V.cross(v0, v1));
      const ang = Math.acos(Math.max(-1, Math.min(1, V.dot(v0, v1) / (size * size))));
      const n = Math.max(2, Math.ceil(ang / (2 * Math.PI) * seg));
      for (let i = 1; i < n; i++) arc.push(V.add(c, V.applyMat(V.rotationAbout([0, 0, 0], ax, (ang * i / n) * 180 / Math.PI), v0)));
      ctx.edgeSurfs.push(MF.cylinder(`${f.id}.blend:${k}`, c, d, size));   // i18n-ignore: a face name (identifier)
    } else {
      // the chamfer distance goes on the edge's first face (names sorted), or the other one when flipped
      const [fa, ua, fb, ub] = (f.flip ? [fB, uB, fA, uA] : [fA, uA, fB, uB]);
      const theta = Math.acos(Math.max(-1, Math.min(1, V.dot(ua, ub))));
      let da = size, db = size;
      if (f.mode === 'two') db = f.d2;
      else if (f.mode === 'angle') { const al = f.angle * Math.PI / 180; db = size * Math.sin(al) / Math.sin(Math.PI - al - theta); }
      if (!(db > 0)) fail(t('model.brep.chamfer_no_fit', { size }));
      const pa = V.add(O, V.mul(ua, da)), pb = V.add(O, V.mul(ub, db));
      [tA, tB] = fa === fA ? [pa, pb] : [pb, pa];
      ctx.edgeSurfs.push(MF.plane(`${f.id}.bevel:${k}`, V.cross(V.sub(tB, tA), d), tA));   // i18n-ignore: a face name (identifier)
      void fb;
    }
    // the section, pushed a little past the two faces so the boolean never meets them face to face
    const eps = 0.01 * size, out = V.mul(V.add(nA, nB), -s * eps);
    const poly = [V.add(O, out), V.sub(tA, V.mul(nA, s * eps)), tA, ...arc, tB, V.sub(tB, V.mul(nB, s * eps))];
    const X = V.norm(V.sub(tA, O)), Y = V.cross(d, X);
    let loop = poly.map((p) => [V.dot(V.sub(p, O), X), V.dot(V.sub(p, O), Y)]);
    let ar = 0; for (let i = 0; i < loop.length; i++) { const q = loop[i], r = loop[(i + 1) % loop.length]; ar += q[0] * r[1] - r[0] * q[1]; }
    if (ar < 0) loop = loop.reverse();
    const cs = ctx.T(new ctx.M.CrossSection([loop], 'Positive'));
    const prism = ctx.T(ctx.T(cs.extrude(L)).transform(V.basisMatrix(X, Y, d, O)));
    (convex ? cut : fill).push(prism);
  });
  const tools = [];
  if (cut.length) tools.push({ m: cut.length === 1 ? cut[0] : ctx.T(ctx.M.Manifold.union(cut)), op: 'cut' });
  if (fill.length) tools.push({ m: fill.length === 1 ? fill[0] : ctx.T(ctx.M.Manifold.union(fill)), op: 'add' });
  // two picked edges meeting at a corner are mitred there (an exact kernel would blend them): only then is it said
  const tolE = 1e-6 * Math.max(1, ...ends.map((p) => V.len(p)));
  const meet = ends.some((p, i) => ends.some((q, j) => j > i && (j >> 1) !== (i >> 1) && V.len(V.sub(p, q)) <= tolE));
  return meet ? { tools, warning: t('kernel.mesh.fillet_approx', { what: FEATURE_LABELS[kind] }) } : { tools };
}

/** Eroded / dilated bodies by feature, so a later edit does not redo them (each takes ~2 ms per triangle of the body). */
const offsetCache = new Map();
const OFFSET_CACHE_MAX = 8;

/**
 * Shell on the mesh kernel (0.4 K.5): inward, the body less its erosion by a ball of radius t (the true inward offset:
 * sharp where the body has outside corners, rounded at inside ones); outward, the body's dilation less the body. Each
 * opened flat face is cut through by sweeping the removed solid along that face's normal past it. The inner faces are named
 * `<face>~<feature>` as brep.js names them (planes and cylinders offset by t). Faces may only be flat to be opened.
 */
function shellTools(f, ctx) {
  if (!ctx.body) fail(t('model.brep.no_body_shell'));
  if (!(f.t > 0)) fail(t('model.brep.wall_positive'));
  if (!f.faces.length) fail(t('model.brep.shell_pick_faces'));
  const B = bodyFaces(ctx);
  const open = f.faces.map((ref) => {
    const i = findFace(B.faces, ref);
    if (i < 0) fail(t('model.brep.shell_face_gone', { face: ref.name }));
    if (B.faces[i].type !== 'plane') fail(t('kernel.mesh.shell_flat'));
    return B.faces[i];
  });
  const M = ctx.M, th = f.t;
  const key = f.id + '|' + th + '|' + !!f.outward + '|' + ctx.body.numTri() + '|' + ctx.body.volume().toPrecision(12);
  let off = offsetCache.get(key);
  if (!off) {
    const ball = M.Manifold.sphere(th, Math.max(8, Math.min(32, (ctx.part.resolution || 64) / 2)));
    off = f.outward ? ctx.body.minkowskiSum(ball) : ctx.body.minkowskiDifference(ball);
    ball.delete();
    offsetCache.set(key, off);
    if (offsetCache.size > OFFSET_CACHE_MAX) { const k0 = offsetCache.keys().next().value; try { offsetCache.get(k0).delete(); } catch { /* gone */ } offsetCache.delete(k0); }
  }
  if (off.isEmpty()) fail(t('model.brep.shell_thickness'));
  // what is taken away: the eroded inside (inward) or the body itself (outward), swept out through each opened face
  let hollow = f.outward ? ctx.body : off;
  for (const fc of open) {
    const n = fc.n, len = th * 1.5 + 1e-3;
    const bar = ctx.T(ctx.T(M.Manifold.cube([1e-7 * th, 1e-7 * th, len], true)).transform(V.basisMatrix(...(() => { const x = V.norm(V.cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])); return [x, V.cross(n, x), n]; })(), V.mul(n, len / 2))));
    hollow = ctx.T(hollow.add(ctx.T(hollow.minkowskiSum(bar))));
  }
  // the offset faces: each named face of the body moved by t (in for inward, out for outward), named as brep.js names them;
  // a cylinder moves to r + t or r − t depending on whether it is a boss or a hole: both are offered, the facets pick one
  const s = f.outward ? 1 : -1, moved = [], kept = [];
  for (const fc of B.faces) {
    if (!fc.name) continue;
    const nm = `${fc.name}~${f.id}`;   // i18n-ignore: a face name (identifier)
    if (fc.type === 'plane') { moved.push(MF.plane(nm, fc.n, V.add(fc.o, V.mul(fc.n, s * th)))); kept.push(MF.plane(fc.name, fc.n, fc.o)); }
    else if (fc.type === 'cylinder') {
      moved.push(MF.cylinder(nm, fc.axis.o, fc.axis.d, fc.r + th), MF.cylinder(nm, fc.axis.o, fc.axis.d, Math.max(1e-9, fc.r - th)));
      kept.push(MF.cylinder(fc.name, fc.axis.o, fc.axis.d, fc.r));
    }
  }
  // outward: the dilated body, then the original (opened) taken out of it, its faces keeping their names; inward: the hollow cut
  if (f.outward) return { tools: [{ m: off, op: 'add', surfs: moved }, { m: hollow, op: 'cut', surfs: kept }] };
  return { tools: [{ m: hollow, op: 'cut', surfs: moved }] };
}

/**
 * Draft on the mesh kernel (0.4 K.5), flat faces only: each picked face turns about the line where it meets the neutral
 * plane until it leans `angle` from the pull direction (OpenCascade's convention: its normal becomes n·cos a + pull·sin a,
 * so a positive angle leans it inward along the pull). Within the face's own outline (a prism square to it), the wedge
 * between the old and the new plane is cut on one side of that line and added on the other. Named `<feature>.draft:<i>`.
 */
function draftTools(f, ctx) {
  if (!ctx.body) fail(t('model.brep_design.no_body_draft'));
  if (!f.faces.length) fail(t('model.brep_design.draft_pick_faces'));
  if (!(Math.abs(f.angle) > 0)) fail(t('model.brep_design.draft_angle_zero'));
  const neutral = resolvePlane(f.neutral, ctx);
  const pull = f.pull ? V.norm(resolveDir(f.pull, ctx).d) : neutral.n;
  const B = bodyFaces(ctx);
  const P = B.mesh.positions, I = B.mesh.indices;
  const bb = ctx.body.boundingBox(), size = Math.max(1, V.len(V.sub([...bb.max], [...bb.min])));
  const a = f.angle * Math.PI / 180, cuts = [], adds = [], surfs = [], seen = new Set();
  f.faces.forEach((ref, i) => {
    const fi = findFace(B.faces, ref);
    if (fi < 0) fail(t('model.brep_design.draft_face_gone', { face: ref.name }));
    if (seen.has(fi)) return;
    seen.add(fi);
    const fc = B.faces[fi];
    if (fc.type !== 'plane') fail(t('kernel.mesh.draft_flat'));
    const n = fc.n, c0 = V.dot(fc.o, n);
    // the new normal: the face's direction square to the pull, leaned by the angle towards the pull
    const np = V.sub(n, V.mul(pull, V.dot(n, pull)));
    if (V.len(np) < 1e-9) fail(t('model.brep_design.draft_neutral', { face: ref.name }));
    const n2 = V.norm(V.add(V.mul(V.norm(np), Math.cos(a)), V.mul(pull, Math.sin(a))));
    // the hinge: where the face's plane meets the neutral plane
    const m = neutral.n, d1 = c0, d2 = V.dot(neutral.o, m), nm = V.dot(n, m), den = 1 - nm * nm;
    if (Math.abs(den) < 1e-12) fail(t('model.brep_design.draft_neutral', { face: ref.name }));
    const q = V.add(V.mul(n, (d1 - d2 * nm) / den), V.mul(m, (d2 - d1 * nm) / den));
    const c1 = V.dot(q, n2);
    // the face's outline: the edges only one of its triangles uses, chained into loops in the face's plane
    const X = V.norm(Math.abs(n[0]) < 0.9 ? V.cross(n, [1, 0, 0]) : V.cross(n, [0, 1, 0])), Y = V.cross(n, X);
    const cnt = new Map(), dir = new Map();
    for (let ti = 0; ti < I.length / 3; ti++) {
      if (B.triFace[ti] !== fi) continue;
      for (let k = 0; k < 3; k++) {
        const u = I[ti * 3 + k], v = I[ti * 3 + (k + 1) % 3], key = u < v ? u + ',' + v : v + ',' + u;
        cnt.set(key, (cnt.get(key) || 0) + 1); dir.set(key, [u, v]);
      }
    }
    const next = new Map();
    for (const [key, c] of cnt) if (c === 1) { const [u, v] = dir.get(key); next.set(u, v); }
    const loops = [], used = new Set();
    for (const st of next.keys()) {
      if (used.has(st)) continue;
      const loop = [];
      for (let v = st, g = 0; v !== undefined && !used.has(v) && g < next.size + 1; v = next.get(v), g++) { used.add(v); const w = V.sub([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], fc.o); loop.push([V.dot(w, X), V.dot(w, Y)]); }
      if (loop.length >= 3) loops.push(loop);
    }
    if (!loops.length) fail(t('model.brep_design.draft_failed'));
    const L = size * 2;
    const prism = ctx.T(ctx.T(ctx.T(new ctx.M.CrossSection(loops, 'EvenOdd')).extrude(2 * L)).transform(V.basisMatrix(X, Y, n, V.sub(fc.o, V.mul(n, L)))));
    // cut: inside the old plane, outside the new; add: outside the old, inside the new
    const cut = ctx.T(ctx.T(prism.trimByPlane(V.mul(n, -1), -c0)).trimByPlane(n2, c1));
    const add = ctx.T(ctx.T(prism.trimByPlane(n, c0)).trimByPlane(V.mul(n2, -1), -c1));
    if (!cut.isEmpty()) cuts.push(cut);
    if (!add.isEmpty()) adds.push(add);
    surfs.push(MF.plane(`${f.id}.draft:${i}`, n2, q));   // i18n-ignore: a face name (identifier)
  });
  const tools = [];
  if (cuts.length) tools.push({ m: cuts.length === 1 ? cuts[0] : ctx.T(ctx.M.Manifold.union(cuts)), op: 'cut', surfs });
  if (adds.length) tools.push({ m: adds.length === 1 ? adds[0] : ctx.T(ctx.M.Manifold.union(adds)), op: 'add', surfs });
  return { tools };
}

const FEATURES = {
  draft(f, ctx) { return draftTools(f, ctx); },
  shell(f, ctx) { return shellTools(f, ctx); },
  fillet(f, ctx) { ctx.edgeSurfs = []; const out = edgeTools(f, ctx, 'fillet'); for (const tl of out.tools) tl.surfs = ctx.edgeSurfs; return out; },
  chamfer(f, ctx) { ctx.edgeSurfs = []; const out = edgeTools(f, ctx, 'chamfer'); for (const tl of out.tools) tl.surfs = ctx.edgeSurfs; return out; },

  sketch(f, ctx) {
    const frame = resolvePlane(f.plane, ctx);
    ctx.frames.set(f.id, frame);
    const s = solveSketch(f.sketch);
    const res = { solve: { status: s.status, dof: s.dof, conflicts: s.conflicts, redundant: s.redundant } };
    ctx.solveInfo = res.solve;
    if (s.conflicts.length) fail(t('model.kernel.over_defined.conflicts', { n: s.conflicts.length }));
    if (s.redundant.length) res.warning = t('model.kernel.over_defined.redundant', { n: s.redundant.length });
    // sketch lines become reference lines (axes, directions)
    return res;
  },

  extrude(f, ctx) {
    const { sk, frame } = sketchOf(ctx, f.sketch);
    const pr = profile(sk, ctx.part.resolution);
    if (pr.error) fail(pr.error);
    if (!pr.loops.length) fail(t('model.kernel.no_profile_extrude'));
    if (['upto', 'next', 'vertex', 'offset'].includes(f.end) || f.taper) fail(t(f.taper ? 'kernel.mesh.taper' : 'kernel.mesh.extrude_to'));
    let loops = pr.loops;
    if (f.regions?.length) loops = regionsAt(pr.loops.map((poly) => ({ poly })), f.regions, fail).flatMap((g) => [g.outer, ...g.holes]).map((i) => pr.loops[i]);
    const cs = crossSection(ctx, loops);
    const sign = (f.op === 'cut' ? -1 : 1) * (f.reverse ? -1 : 1);
    let h = f.depth, z0;
    if (f.two && f.end === 'blind') { h = f.depth + f.depth2; z0 = sign > 0 ? -f.depth2 : -f.depth; }
    else if (f.end === 'blind') z0 = sign > 0 ? 0 : -h;
    else if (f.end === 'mid') z0 = -h / 2;
    else {
      if (f.op !== 'cut') fail(t('model.kernel.through_all_cuts'));
      const rg = bodyRange(ctx, frame);
      if (!rg) fail(t('model.kernel.nothing_to_cut'));
      const margin = 1 + 0.01 * (rg[1] - rg[0]);
      if (sign > 0) { if (rg[1] <= 1e-9) fail(t('model.kernel.nothing_to_cut_side')); z0 = 0; h = rg[1] + margin; }
      else { if (rg[0] >= -1e-9) fail(t('model.kernel.nothing_to_cut_side')); h = -rg[0] + margin; z0 = -h; }
    }
    if (!(h > 0)) fail(t('model.kernel.depth_zero'));
    const tool = ctx.T(ctx.T(ctx.T(cs.extrude(h)).translate([0, 0, z0])).transform(V.frameMatrix(frame)));
    // faces a sketch can sit on
    const cand = [];
    const at = (z) => V.add(frame.o, V.mul(frame.n, z));
    const flip = f.op === 'cut' ? -1 : 1;
    cand.push({ ref: { face: 'start' }, frame: V.frameFor(V.mul(frame.n, -flip), at(z0)) });
    cand.push({ ref: { face: 'end' }, frame: V.frameFor(V.mul(frame.n, flip), at(z0 + h)) });
    cand.push(...sideCandidates(sk, pr.loops, frame, pr.curves, f.op, (a, b, eps) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      let nn = [dy / l, -dx / l];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (insideLoops(pr.loops, [m[0] + nn[0] * eps, m[1] + nn[1] * eps])) nn = [-nn[0], -nn[1]];
      return { n: V.add(V.mul(frame.x, nn[0]), V.mul(frame.y, nn[1])), p: V.toWorld(frame, ...a) };
    }));
    ctx.candidates.set(f.id, cand);
    // its surfaces, named as brep.js names them (K.2b): the caps and one per profile curve
    const surfs = [MF.plane(`${f.id}.start`, frame.n, at(z0)), MF.plane(`${f.id}.end`, frame.n, at(z0 + h))];   // i18n-ignore: face names (identifiers)
    for (const { id } of pr.curves) {
      const e = byId(sk, id);
      if (!e) continue;
      const nm = `${f.id}.side:${id}`;   // i18n-ignore: a face name (identifier)
      if (e.type === 'line') {
        const a = V.toWorld(frame, ...pointXY(sk, e.p1)), b = V.toWorld(frame, ...pointXY(sk, e.p2));
        surfs.push(MF.span(MF.plane(nm, V.cross(V.sub(b, a), frame.n), a), a, b));
      } else if (e.type === 'circle' || e.type === 'arc') {
        const c = V.toWorld(frame, ...pointXY(sk, e.c));
        const r = e.type === 'circle' ? e.r : V.len(V.sub(V.toWorld(frame, ...pointXY(sk, e.s)), c));
        surfs.push(MF.cylinder(nm, c, frame.n, r));
      } else surfs.push(MF.other(nm));
    }
    return { tools: [{ m: tool, op: f.op, surfs }] };
  },

  revolve(f, ctx) {
    const { sk, frame } = sketchOf(ctx, f.sketch);
    let axis, a2, b2;
    if (f.axis && typeof f.axis === 'object') {
      const ax = resolveDir(f.axis, ctx);
      if (Math.abs(V.dot(ax.d, frame.n)) > 1e-9 || Math.abs(V.dot(V.sub(ax.o, frame.o), frame.n)) > 1e-7 * Math.max(1, V.len(V.sub(ax.o, frame.o)))) fail(t('model.kernel.axis_in_plane'));
      a2 = V.toPlane(frame, ax.o); b2 = V.toPlane(frame, V.add(ax.o, ax.d)); axis = { id: null, construction: true };
    } else {
      axis = f.axis ? byId(sk, f.axis) : sk.entities.find((e) => e.type === 'line' && e.construction);
      if (!axis || axis.type !== 'line') fail(f.axis ? t('model.kernel.axis_gone') : t('model.kernel.draw_centerline'));
      a2 = pointXY(sk, axis.p1); b2 = pointXY(sk, axis.p2);
    }
    const ul = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
    if (ul < 1e-12) fail(t('model.kernel.axis_no_length'));
    const u = [(b2[0] - a2[0]) / ul, (b2[1] - a2[1]) / ul];
    // the profile without the axis line itself when it is a solid line
    const skNoAxis = axis.construction ? sk : { ...sk, entities: sk.entities.map((e) => (e.id === axis.id ? { ...e, construction: true } : e)) };
    let pr = profile(skNoAxis, ctx.part.resolution);
    if (pr.error && !axis.construction) pr = profile(sk, ctx.part.resolution);
    if (pr.error) fail(pr.error);
    if (!pr.loops.length) fail(t('model.kernel.no_profile_revolve'));
    const scale = Math.max(1, ...pr.loops.flat().map((p) => Math.hypot(p[0] - a2[0], p[1] - a2[1])));
    let pos = 0, neg = 0;
    for (const p of pr.loops.flat()) {
      const s = -u[1] * (p[0] - a2[0]) + u[0] * (p[1] - a2[1]);
      if (s > 1e-7 * scale) pos++; else if (s < -1e-7 * scale) neg++;
    }
    if (pos && neg) fail(t('model.kernel.profile_crosses_axis'));
    const side = neg ? -1 : 1;
    const n2 = [-u[1] * side, u[0] * side];
    const loops = pr.loops.map((loop) => loop.map((p) => {
      const d = [p[0] - a2[0], p[1] - a2[1]];
      return [Math.max(0, d[0] * n2[0] + d[1] * n2[1]), d[0] * u[0] + d[1] * u[1]];
    }));
    const cs = crossSection(ctx, loops);
    const U3 = V.add(V.mul(frame.x, u[0]), V.mul(frame.y, u[1]));
    const N3 = V.add(V.mul(frame.x, n2[0]), V.mul(frame.y, n2[1]));
    const W3 = V.cross(U3, N3);
    const A = V.toWorld(frame, ...a2);
    const tool = ctx.T(ctx.T(cs.revolve(ctx.part.resolution, f.angle)).transform(V.basisMatrix(N3, W3, U3, A)));
    ctx.axes.set(f.id, { o: A, d: U3 });
    const cand = sideCandidates(sk, pr.loops, frame, pr.curves, f.op, (a, b, eps) => {
      const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d);
      if (Math.abs(d[0] * u[0] + d[1] * u[1]) > 1e-9 * l) return null;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const up = insideLoops(pr.loops, [m[0] + u[0] * eps, m[1] + u[1] * eps]);
      const t = (a[0] - a2[0]) * u[0] + (a[1] - a2[1]) * u[1];
      return { n: V.mul(U3, up ? -1 : 1), p: V.add(A, V.mul(U3, t)) };
    });
    ctx.candidates.set(f.id, cand);
    // its surfaces (K.2b): a profile line square to the axis sweeps a plane, one along it a cylinder, a slanted one a cone;
    // arcs sweep tori and spheres (named, not classified); a partial turn has start and end caps
    const surfs = [];
    const rz = (q) => { const d = [q[0] - a2[0], q[1] - a2[1]]; return [d[0] * n2[0] + d[1] * n2[1], d[0] * u[0] + d[1] * u[1]]; };
    for (const { id } of pr.curves) {
      const e = byId(sk, id);
      if (!e || (axis.id && e.id === axis.id)) continue;
      const nm = `${f.id}.side:${id}`;   // i18n-ignore: a face name (identifier)
      if (e.type === 'arc' || e.type === 'circle') {
        // an arc swept round the axis: a sphere when its centre is on the axis, else a torus
        const [rc, zc] = rz(pointXY(sk, e.c));
        const ra = e.type === 'circle' ? e.r : Math.hypot(...[0, 1].map((k) => pointXY(sk, e.s)[k] - pointXY(sk, e.c)[k]));
        const C3 = V.add(A, V.mul(U3, zc));
        surfs.push(Math.abs(rc) <= 1e-9 * scale ? MF.sphere(nm, C3, ra) : MF.torus(nm, C3, U3, rc, ra));
        continue;
      }
      if (e.type !== 'line') { surfs.push(MF.other(nm)); continue; }
      const [r1, z1] = rz(pointXY(sk, e.p1)), [r2, z2] = rz(pointXY(sk, e.p2));
      const eps = 1e-9 * scale;
      if (Math.abs(z2 - z1) <= eps) surfs.push(MF.plane(nm, U3, V.add(A, V.mul(U3, z1))));
      else if (Math.abs(r2 - r1) <= eps) { if (r1 > eps) surfs.push(MF.cylinder(nm, A, U3, r1)); }
      else {
        const slope = (r2 - r1) / (z2 - z1), za = z1 - r1 / slope;
        surfs.push(MF.cone(nm, V.add(A, V.mul(U3, za)), slope > 0 ? U3 : V.mul(U3, -1), Math.abs(slope)));
      }
    }
    if (Math.abs(f.angle - 360) > 1e-9) {
      surfs.push(MF.plane(`${f.id}.start`, W3, A));   // i18n-ignore: a face name (identifier)
      surfs.push(MF.plane(`${f.id}.end`, V.applyMat(V.rotationAbout([0, 0, 0], U3, f.angle), W3), A));   // i18n-ignore: a face name (identifier)
    }
    return { tools: [{ m: tool, op: f.op, surfs }] };
  },

  hole(f, ctx) {
    const { sk, frame } = sketchOf(ctx, f.sketch);
    const pts = loosePoints(sk).filter((p) => !p.construction);
    if (!pts.length) fail(t('model.kernel.hole_points'));
    if (!(f.d > 0)) fail(t('model.kernel.hole_diameter_zero'));
    const thread = f.kind === 'tapped' ? ISO_COARSE[f.size] : null;
    if (f.kind === 'tapped' && !thread) fail(t('model.kernel.thread_size'));
    const sign = f.reverse ? 1 : -1;   // into the material = against the face's outward normal
    let depth = f.depth;
    if (f.through) {
      const rg = bodyRange(ctx, frame);
      if (!rg) fail(t('model.kernel.nothing_to_drill'));
      const margin = 1 + 0.01 * (rg[1] - rg[0]);
      depth = sign < 0 ? -rg[0] + margin : rg[1] + margin;
      if (depth <= margin) fail(t('model.kernel.nothing_to_drill_side'));
    }
    if (!(depth > 0)) fail(t('model.kernel.hole_depth_zero'));
    if (f.kind === 'cbore') {
      if (!(f.cboreD > f.d)) fail(t('model.kernel.cbore_wider'));
      if (!(f.cboreDepth > 0) || (!f.through && f.cboreDepth >= depth)) fail(t('model.kernel.cbore_shallower'));
    }
    const res = ctx.part.resolution;
    const disk = (r, x, y) => ctx.T(new ctx.M.CrossSection([tessCircle([x, y], r, res)], 'Positive'));
    const parts = [];
    const hd = thread ? thread[2] : f.d;
    if (f.kind === 'csink' && !(f.csinkD > f.d)) fail(t('model.kernel.csink_wider'));
    for (const p of pts) {
      const z0 = sign < 0 ? -depth : 0;
      parts.push(ctx.T(ctx.T(disk(hd / 2, p.x, p.y).extrude(depth)).translate([0, 0, z0])));
      if (f.kind === 'csink') {
        const R = f.csinkD / 2, r = f.d / 2, hc = (R - r) / Math.tan(f.csinkAngle * Math.PI / 360);
        const cone = ctx.T(ctx.T(disk(R, 0, 0).extrude(hc, 0, 0, [r / R, r / R])));
        parts.push(ctx.T(ctx.T(sign < 0 ? ctx.T(cone.scale([1, 1, -1])) : cone).translate([p.x, p.y, 0])));
      }
      if (f.kind === 'cbore') {
        const cz = sign < 0 ? -f.cboreDepth : 0;
        parts.push(ctx.T(ctx.T(disk(f.cboreD / 2, p.x, p.y).extrude(f.cboreDepth)).translate([0, 0, cz])));
      }
    }
    const local = parts.length === 1 ? parts[0] : ctx.T(ctx.M.Manifold.union(parts));
    const tool = ctx.T(local.transform(V.frameMatrix(frame)));
    ctx.holeAxes.set(f.id, pts.map((p) => ({ o: V.toWorld(frame, p.x, p.y), d: V.mul(frame.n, -sign) })));
    // its surfaces (K.2b), per point as brep.js names them: wall, floor, counterbore + its floor, countersink cone
    const din = V.mul(frame.n, sign), surfs = [];
    for (const p of pts) {
      const P0 = V.toWorld(frame, p.x, p.y), nm = (k) => `${f.id}.${k}:${p.id}`;   // i18n-ignore: face names (identifiers)
      const Rmax = Math.max(hd / 2, f.kind === 'cbore' ? f.cboreD / 2 : 0, f.kind === 'csink' ? f.csinkD / 2 : 0);
      const own = (sf) => MF.within(sf, P0, din, Rmax);   // this hole's surfaces only (neighbours' floors share the plane)
      surfs.push(own(MF.cylinder(nm('wall'), P0, din, hd / 2)));
      if (!f.through) surfs.push(own(MF.plane(nm('floor'), din, V.add(P0, V.mul(din, depth)))));
      if (f.kind === 'cbore') { surfs.push(own(MF.cylinder(nm('cbore'), P0, din, f.cboreD / 2))); surfs.push(own(MF.plane(nm('cfloor'), din, V.add(P0, V.mul(din, f.cboreDepth))))); }
      if (f.kind === 'csink') {
        const R = f.csinkD / 2, r = f.d / 2, hc = (R - r) / Math.tan(f.csinkAngle * Math.PI / 360);
        surfs.push(own(MF.cone(nm('csink'), V.add(P0, V.mul(din, R * hc / (R - r))), V.mul(din, -1), (R - r) / hc)));
      }
    }
    return { tools: [{ m: tool, op: 'cut', surfs }], count: pts.length };
  },

  lpattern(f, ctx) {
    if (f.bodies?.length) fail(t('kernel.mesh.pattern_bodies'));
    const seeds = seedTools(f, ctx);
    const { d } = resolveDir(f.dir, ctx);
    const dir = V.mul(d, f.reverse ? -1 : 1);
    const tools = [];
    for (let i = 1; i < f.count; i++) {
      const M4 = V.translation(V.mul(dir, f.spacing * i));
      for (const sd of seeds) tools.push({ m: ctx.T(sd.m.transform(M4)), op: sd.op, surfs: MF.moveSurfs(sd.surfs, M4, `@${f.id}#${i}`) });
    }
    return { tools };
  },

  cpattern(f, ctx) {
    if (f.bodies?.length) fail(t('kernel.mesh.pattern_bodies'));
    const seeds = seedTools(f, ctx);
    const { o, d } = resolveDir(f.axis, ctx);
    const full = Math.abs(f.angle - 360) < 1e-9;
    const step = (full ? 360 / f.count : f.count > 1 ? f.angle / (f.count - 1) : 0) * (f.reverse ? -1 : 1);
    const tools = [];
    for (let i = 1; i < f.count; i++) {
      const M4 = V.rotationAbout(o, d, step * i);
      for (const sd of seeds) tools.push({ m: ctx.T(sd.m.transform(M4)), op: sd.op, surfs: MF.moveSurfs(sd.surfs, M4, `@${f.id}#${i}`) });
    }
    return { tools };
  },

  ...Object.fromEntries(['plane', 'axis', 'point'].map((type) => [type, (f, ctx) => {
    // reference geometry from base planes, sketch points, other references and fixed values; faces and edges need OpenCascade
    const exact = () => fail(t('kernel.mesh.ref_face'));
    const g = refFeature(f, {
      plane: (r) => ({ ...resolvePlane(r, ctx), center: r.kind === 'ref' ? ctx.refGeom.get(r.feature)?.center : undefined }),
      dir: (r) => resolveDir(r, ctx),
      point: (r) => {
        if (r.kind === 'fixed') return [...r.p];
        if (r.kind === 'ref') { const q = ctx.refGeom.get(r.feature); if (!q || q.kind !== 'point') fail(t('model.kernel.point_feature_not_built')); return q.p; }
        if (r.kind === 'sketch') { const fr = ctx.frames.get(r.sketch), sf = ctx.part.features.find((x) => x.id === r.sketch); if (!fr || !sf) fail(t('model.kernel.point_sketch_not_built')); const q = r.entity === 'O' ? [0, 0] : pointXY(sf.sketch, r.entity); if (!q) fail(t('model.kernel.point_gone_from', { name: sf.name })); return V.toWorld(fr, q[0], q[1]); }
        return exact();
      },
      face: exact, edge: exact, fail,
    });
    ctx.refGeom.set(f.id, g);
    if (g.kind === 'axis') ctx.axes.set(f.id, { o: g.o, d: g.d });
    return {};
  }])),

  mirror(f, ctx) {
    const frame = resolvePlane(f.plane, ctx);
    const M4 = V.reflection(frame.o, frame.n);
    if (f.seeds === 'body') {
      if (!ctx.body) fail(t('model.kernel.nothing_to_mirror'));
      return { tools: [{ m: ctx.T(ctx.body.transform(M4)), op: 'add' }] };
    }
    return { tools: seedTools(f, ctx).map((sd) => ({ m: ctx.T(sd.m.transform(M4)), op: sd.op, surfs: MF.moveSurfs(sd.surfs, M4, `@${f.id}#m`) })) };
  },
};

function seedTools(f, ctx) {
  if (!f.seeds.length) fail(t('model.kernel.choose_seeds'));
  const out = [];
  for (const id of f.seeds) {
    const tl = ctx.tools.get(id);
    const g = ctx.part.features.find((x) => x.id === id);
    if (!tl) fail(g ? t('model.kernel.seed_no_solid', { name: g.name }) : t('model.kernel.seed_no_solid_gone'));
    out.push(...tl);
  }
  if (!out.length) fail(t('model.kernel.seeds_no_solid'));
  return out;
}

/**
 * Rebuild the part. Mutates each sketch's geometry to its solved state. Never throws for a
 * feature problem; returns everything the UI and exports need as plain data (no live WASM objects).
 */
export function regenerate(part, M, { upTo = null } = {}) {
  const live = [];
  const ctx = {
    part, M, body: null,
    T: (m) => { live.push(m); return m; },
    results: new Map(), frames: new Map(), candidates: new Map(), axes: new Map(), holeAxes: new Map(), tools: new Map(), refGeom: new Map(),
  };
  const origin = new Map();   // manifold original id → feature id
  const toolSurfs = new Map();   // manifold original id → that tool's named surfaces (meshfaces.js, K.2b)
  ctx.toolSurfs = toolSurfs;
  const built = upTo === null ? builtCount(part) : Math.min(upTo, part.features.length);
  part.features.forEach((f, i) => {
    const r = { status: 'ok' };
    ctx.results.set(f.id, r);
    if (i >= built) { r.status = 'rolled'; return; }
    if (f.suppressed) { r.status = 'suppressed'; return; }
    const blocked = dependsOn(f).map((d) => [d, ctx.results.get(d)]).find(([, x]) => !x || x.status !== 'ok');
    if (blocked) {
      const g = part.features.find((x) => x.id === blocked[0]);
      r.status = 'skipped';
      r.message = g ? t(NEEDS_KEY[blocked[1]?.status] || 'model.kernel.needs.not_built', { name: g.name }) : t('model.kernel.needs.gone');
      return;
    }
    ctx.solveInfo = null;
    if (EXACT_ONLY.has(f.type) && !MESH_BUILT.has(f.type)) { r.status = 'skipped'; r.message = t('kernel.feature.not_built', { label: FEATURE_LABELS[f.type] }); return; }
    try {
      const out = FEATURES[f.type](f, ctx) || {};
      if (out.solve) r.solve = out.solve;
      if (out.warning) r.warning = out.warning;
      if (out.count) r.count = out.count;
      if (out.tools) {
        const tools = out.tools.map((tl) => {
          const m = ctx.T(tl.m.asOriginal());
          origin.set(m.originalID(), f.id);
          if (tl.surfs) toolSurfs.set(m.originalID(), tl.surfs);
          return { m, op: tl.op, surfs: tl.surfs || null };
        });
        ctx.tools.set(f.id, tools);
        let body = ctx.body;
        for (const tl of tools) {
          if (tl.op === 'new') fail(t('kernel.mesh.new_body'));
          if (tl.op === 'add') body = body ? ctx.T(body.add(tl.m)) : tl.m;
          else if (tl.op === 'intersect') { if (!body) fail(t('model.kernel.nothing_to_intersect')); body = ctx.T(body.intersect(tl.m)); }
          else {
            if (!body) fail(t('model.kernel.nothing_to_cut'));
            body = ctx.T(body.subtract(tl.m));
          }
        }
        const st = body.status();
        if (st !== 'NoError') fail(t('model.kernel.kernel_failed', { status: String(st) }));
        if (ctx.body && body.isEmpty()) r.warning = t('model.kernel.nothing_left');
        ctx.body = body.isEmpty() ? null : body;
      }
    } catch (e) {
      r.status = 'error';
      r.message = e instanceof FeatureError ? e.message : t('model.kernel.build_failed', { error: e && e.message ? e.message : String(e) });
      if (f.type === 'sketch' && ctx.solveInfo) r.solve = ctx.solveInfo;
    }
  });

  let mesh = null, stats = null, faces = null, edges = null;
  if (ctx.body) {
    const b = ctx.body;
    const gm = b.getMesh();
    const np = gm.numProp;
    const nv = gm.vertProperties.length / np;
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = gm.vertProperties[i * np + k];
    const indices = new Uint32Array(gm.triVerts);
    const ntri = indices.length / 3;
    const featIds = [];
    const triFeature = new Int32Array(ntri).fill(-1);
    const runs = gm.runIndex, ids = gm.runOriginalID;
    for (let r = 0; r + 1 < runs.length; r++) {
      const fid = origin.get(ids[r]);
      let k = -1;
      if (fid) { k = featIds.indexOf(fid); if (k < 0) { featIds.push(fid); k = featIds.length - 1; } }
      for (let t = runs[r] / 3; t < runs[r + 1] / 3; t++) triFeature[t] = k;
    }
    const bb = b.boundingBox();
    stats = {
      volume: b.volume(), area: b.surfaceArea(), genus: b.genus(), tris: ntri,
      bodies: (() => { const parts = b.decompose(); const n = parts.length; parts.forEach((p) => p.delete()); return n; })(),
      bbox: { min: [...bb.min], max: [...bb.max] },
    };
    mesh = { positions, indices, triFeature, featIds };
    // named faces and edges (K.2b): each triangle matched to a surface of the tool that made it
    const surfLists = [], listOf = new Map();
    const triTool = new Int32Array(ntri).fill(-1);
    for (let r = 0; r + 1 < runs.length; r++) {
      const sf = toolSurfs.get(ids[r]);
      if (!sf) continue;
      let k = listOf.get(ids[r]);
      if (k === undefined) { k = surfLists.length; listOf.set(ids[r], k); surfLists.push(sf); }
      for (let ti = runs[r] / 3; ti < runs[r + 1] / 3; ti++) triTool[ti] = k;
    }
    const nf = MF.namedFaces(mesh, triTool, surfLists, { segments: part.resolution || 64 });
    faces = nf.faces; edges = nf.edges;
    mesh.triFace = nf.triFace;
    // the view draws these edges instead of its own 25° feature edges, so only when every triangle has its face
    if (!nf.triFace.includes(-1)) Object.assign(mesh, { edgeSegs: nf.edgeSegs, segEdge: nf.segEdge });
    stats.faces = faces.length; stats.edges = edges.length;
  }
  for (const m of live) { try { m.delete(); } catch { /* already gone */ } }
  // sketch lines in world space (for reference picking and display)
  // faces / edges: brep.js's tables from the mesh (meshfaces.js), so the workspaces and picking read either kernel's result
  return { results: ctx.results, mesh, stats, frames: ctx.frames, candidates: ctx.candidates, axes: ctx.axes, holeAxes: ctx.holeAxes, refGeom: ctx.refGeom, faces, edges, named: !!faces };
}

// a blocking feature's status → the message key ("Needs Extrude1, which is failing.")
const NEEDS_KEY = { error: 'model.kernel.needs.failing', skipped: 'model.kernel.needs.not_built', suppressed: 'model.kernel.needs.suppressed', rolled: 'model.kernel.needs.rolled' };

/** The stable face reference for a picked planar triangle (feature-made faces), else a fixed plane. */
export function faceRefAt(regen, featureId, normal, point) {
  const n = V.norm(normal);
  for (const c of regen.candidates.get(featureId) || []) {
    if (V.dot(c.frame.n, n) > 1 - 1e-6 && Math.abs(V.dot(V.sub(point, c.frame.o), c.frame.n)) < 1e-4 * Math.max(1, V.len(point))) {
      return { kind: 'face', feature: featureId, face: c.ref.face, ...(c.ref.entity ? { entity: c.ref.entity } : {}) };
    }
  }
  return { kind: 'fixed', o: point.map((v) => +v.toFixed(9)), n: n.map((v) => +v.toFixed(12)) };
}

export function planeFrame(ref, regen, part) {
  if (ref.kind === 'ref') { const g = regen?.refGeom?.get(ref.feature); return g && g.kind === 'plane' ? g.frame : null; }
  if (regen && regen.exact) {
    // the exact kernel lists every flat face of the body by name (brep.js)
    if (ref.kind === 'base') return V.BASE_PLANES[ref.name];
    if (ref.kind === 'fixed') return V.frameFor(ref.n, ref.o);
    const p = regen.planes && regen.planes[refName(ref)];
    return p ? V.frameFor(p.n, p.o) : null;
  }
  const ctx = { part, results: regen.results, candidates: regen.candidates };
  try { return resolvePlane(ref, ctx); } catch { return null; }
}
