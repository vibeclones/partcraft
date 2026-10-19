/* SPDX-License-Identifier: Apache-2.0 */
/**
 * measure.js — measuring in 3D, the page side (DOM-free). Works on one built part or on placed assembly instances.
 *
 * A pick (all points in world coordinates; `matrix` places the part, identity in a part):
 *   { kind: 'vertex'|'midpoint'|'center'|'point'|'edge'|'face'|'body', inst?, pid?, matrix, index? (exact face/edge),
 *     group? (mesh-kernel planar face), p (the snapped or clicked point), local (the same in part coordinates) }
 *   snapCandidates(build) → [{ kind: vertex|midpoint|center, p (part), edge }]  edge ends, line/arc midpoints, circle
 *       centres of an exact build; the sharp-edge vertices of a mesh build.
 *   snapAt(cands, project, x, y, tolPx)  nearest candidate whose projection is within tolPx of (x, y) (screen space,
 *       so a hole's centre snaps from anywhere over the hole). nearestEdge(build, project, x, y, tolPx) → edge index;
 *       nearestEdgeAt(…) → { index, d } (a point snap wins only when it is no farther than the nearest edge, + 1 px).
 *   info(build, pick) → facts of one pick: point; edge length, line direction, circle centre/radius/diameter (from the
 *       exact kernel's edge ends and middle: a full circle's middle is opposite its start); face kind, exact area, plane
 *       normal, cylinder axis/radius/diameter; body volume/area. Mesh builds: planar face area/normal of the facets.
 *   pair(A, B, infoA, infoB, exactDistance?) → { distance, p1, p2, delta, method, angle?, centre?, planeGap? }
 *       point-like pairs: exact here. Anything else: `exactDistance` (OCCT BRepExtrema_DistShapeShape from the worker)
 *       when given, else the minimum over the tessellation (vertex–triangle and segment–segment; exact for the
 *       facets, `approximate` for curved faces). Angle: plane/plane between normals (0–180°), line/line and axis/axis
 *       0–90°, line/plane 0–90°.
 *   meshMass(mesh) → { volume, area, centre, tensor (about the centre, density 1) }  divergence theorem over the
 *       closed triangle mesh (exact for the tessellation: Σ tetrahedra from the origin, ∫xxᵀ = V/20·(Σpᵢpᵢᵀ + (Σpᵢ)(Σpᵢ)ᵀ)).
 *   placeMass(props, matrix, density) → mass-weighted props in world axes (g, g·mm²); combineMass(list) (parallel axes);
 *   principal(tensor) → { moments, axes } (Jacobi).  rows(result) / asText(rows) for the panel and the clipboard.
 */
import * as V from './vec.js';
import { massOf } from './bom.js';
import { t as tr } from './i18n.js';

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const POINTS = new Set(['vertex', 'midpoint', 'center', 'point']);
export const isPointPick = (p) => POINTS.has(p.kind);

/** Centre, radius and plane normal of a circle edge of an exact regen (edges[i]: a, b, at; mesh segs give the normal). */
export function circleOf(e, build = null, index = -1) {
  const full = V.len(V.sub(e.a, e.b)) < 1e-9 * Math.max(1, V.len(e.a));
  let c;
  if (full) c = V.mul(V.add(e.a, e.at), 0.5);
  else {
    // circumcentre of a, at, b
    const A = e.a, B = e.at, C = e.b;
    const ab = V.sub(B, A), ac = V.sub(C, A), n = V.cross(ab, ac), nn = V.dot(n, n);
    if (nn < 1e-24) return null;
    c = V.add(A, V.mul(V.add(V.mul(V.cross(n, ab), V.dot(ac, ac)), V.mul(V.cross(ac, n), V.dot(ab, ab))), 1 / (2 * nn)));
  }
  const r = full ? V.len(V.sub(e.a, e.at)) / 2 : V.len(V.sub(e.a, c));
  let n = full ? null : V.norm(V.cross(V.sub(e.a, c), V.sub(e.b, c)));
  if (full || V.len(n) < 0.5) {
    // a third point off the a–at diameter from OCCT's polyline of this edge
    n = null;
    const segs = build?.mesh?.edgeSegs, se = build?.mesh?.segEdge;
    if (segs && se) {
      let best = 0;
      for (let k = 0; k < se.length; k++) {
        if (se[k] !== index) continue;
        const q = [segs[k * 6], segs[k * 6 + 1], segs[k * 6 + 2]];
        const x = V.cross(V.sub(e.a, c), V.sub(q, c));
        if (V.len(x) > best) { best = V.len(x); n = V.norm(x); }
      }
    }
  }
  return { c, r, n };
}

// ---------------------------------------------------------------- snapping
export function snapCandidates(build) {
  const out = [];
  const seen = new Set();
  const add = (kind, p, edge) => { const k = kind + p.map((v) => v.toFixed(6)).join(','); if (seen.has(k)) return; seen.add(k); out.push({ kind, p, edge }); };
  if (build?.edges?.length) {
    build.edges.forEach((e, i) => {
      if (V.len(V.sub(e.a, e.b)) > 1e-9) { add('vertex', e.a, i); add('vertex', e.b, i); }
      if (e.type === 'line') add('midpoint', V.mul(V.add(e.a, e.b), 0.5), i);
      else if (e.type === 'circle') {
        const ci = circleOf(e, build, i);
        if (ci) add('center', ci.c, i);
        if (V.len(V.sub(e.a, e.b)) > 1e-9) add('midpoint', e.at, i);
      } else add('midpoint', e.at, i);
    });
    return out;
  }
  // mesh kernel: vertices where at least two sharp (> 20°) edges meet
  const m = build?.mesh;
  if (!m) return out;
  const P = m.positions, I = m.indices, nt = I.length / 3;
  const tn = [];
  for (let t = 0; t < nt; t++) { const p = (k) => [P[I[t * 3 + k] * 3], P[I[t * 3 + k] * 3 + 1], P[I[t * 3 + k] * 3 + 2]]; tn.push(V.norm(V.cross(V.sub(p(1), p(0)), V.sub(p(2), p(0))))); }
  const edgeT = new Map();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3]; const key = a < b ? a + ',' + b : b + ',' + a; (edgeT.get(key) || edgeT.set(key, []).get(key)).push(t); }
  const deg = new Map();
  for (const [key, ts] of edgeT) {
    if (ts.length === 2 && V.dot(tn[ts[0]], tn[ts[1]]) > Math.cos(20 * Math.PI / 180)) continue;
    for (const v of key.split(',')) deg.set(+v, (deg.get(+v) || 0) + 1);
  }
  for (const [v, d] of deg) if (d >= 3 && out.length < 20000) add('vertex', [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], -1);
  return out;
}

/** project(p part coords) → [x, y] screen pixels. */
export function snapAt(cands, project, x, y, tolPx = 10) {
  let best = null, bd = tolPx;
  const rank = { vertex: 0, center: 1, midpoint: 2 };
  for (const c of cands) {
    const s = project(c.p);
    if (!s) continue;
    const d = Math.hypot(s[0] - x, s[1] - y) - (2 - rank[c.kind]) * 0.01;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

export const nearestEdge = (build, project, x, y, tolPx = 6) => nearestEdgeAt(build, project, x, y, tolPx).index;
/** → { index (−1 when none within tolPx), d (pixels) } */
export function nearestEdgeAt(build, project, x, y, tolPx = 6) {
  const segs = build?.mesh?.edgeSegs, se = build?.mesh?.segEdge;
  if (!segs || !se) return { index: -1, d: Infinity };
  let best = -1, bd = tolPx;
  for (let k = 0; k < se.length; k++) {
    if (se[k] < 0) continue;
    const a = project([segs[k * 6], segs[k * 6 + 1], segs[k * 6 + 2]]), b = project([segs[k * 6 + 3], segs[k * 6 + 4], segs[k * 6 + 5]]);
    if (!a || !b) continue;
    const d = segPoint2(a, b, [x, y]);
    if (d < bd) { bd = d; best = se[k]; }
  }
  return { index: best, d: best < 0 ? Infinity : bd };
}
function segPoint2(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

// ---------------------------------------------------------------- facts of one pick
const W = (m, p) => V.applyMat(m || IDENT, p);
const Wd = (m, d) => V.norm(V.applyDir(m || IDENT, d));

/** Mesh triangles (part coordinates) of a picked face: exact face index or mesh planar group. */
function faceTris(build, pick) {
  const m = build.mesh, out = [];
  if (!m) return out;
  if (pick.index !== undefined && pick.index >= 0 && m.triFace) { for (let t = 0; t < m.triFace.length; t++) if (m.triFace[t] === pick.index) out.push(t); }
  else if (pick.tris) out.push(...pick.tris);
  return out;
}
const triPts = (m, t) => [0, 1, 2].map((k) => [m.positions[m.indices[t * 3 + k] * 3], m.positions[m.indices[t * 3 + k] * 3 + 1], m.positions[m.indices[t * 3 + k] * 3 + 2]]);

export function info(build, pick) {
  const M = pick.matrix || IDENT;
  const out = { kind: pick.kind, exact: !!build?.exact };
  if (isPointPick(pick)) { out.p = W(M, pick.local); return out; }
  if (pick.kind === 'body') {
    const st = build.stats;
    Object.assign(out, { volume: st?.volume ?? null, area: st?.area ?? null });
    return out;
  }
  if (pick.kind === 'edge') {
    const e = build.edges?.[pick.index];
    if (!e) throw new Error(tr('model.measure.edge_gone'));
    Object.assign(out, { type: e.type, length: e.len, a: W(M, e.a), b: W(M, e.b), p: W(M, e.at), name: e.key });
    if (e.type === 'line') out.dir = Wd(M, V.sub(e.b, e.a));
    if (e.type === 'circle') {
      const ci = circleOf(e, build, pick.index);
      if (ci) { out.centre = W(M, ci.c); out.r = ci.r; if (ci.n) out.axis = Wd(M, ci.n); out.full = V.len(V.sub(e.a, e.b)) < 1e-9 * Math.max(1, V.len(e.a)); }
    }
    return out;
  }
  if (pick.kind === 'face') {
    if ((build.exact || build.named) && pick.index !== undefined && build.faces?.[pick.index]) {
      const f = build.faces[pick.index];
      Object.assign(out, { type: f.type, area: f.area, p: W(M, f.at), name: f.name });
      if (f.type === 'plane') { out.n = Wd(M, f.n); out.o = W(M, f.o); }
      if (f.type === 'cylinder') { out.r = f.r; out.axisLine = { o: W(M, f.axis.o), d: Wd(M, f.axis.d) }; }
      return out;
    }
    // mesh kernel: the planar group's facets
    const tris = faceTris(build, pick);
    let area = 0, nsum = [0, 0, 0];
    for (const t of tris) { const [a, b, c] = triPts(build.mesh, t); const x = V.cross(V.sub(b, a), V.sub(c, a)); area += V.len(x) / 2; nsum = V.add(nsum, x); }
    Object.assign(out, { type: 'facets', area, exact: false, p: W(M, pick.local) });
    if (V.len(nsum) > 0.999 * 2 * area) { out.type = 'plane'; out.n = Wd(M, nsum); out.o = W(M, pick.local); }
    return out;
  }
  throw new Error('Unknown kind of pick.');   // i18n-ignore: picks are made by the app's own code
}

/** The sub-shape request the worker's exact distance takes. */
export function exactSub(pick) {
  if (isPointPick(pick)) return { kind: 'point', p: pick.local };
  if (pick.kind === 'body') return { kind: 'body' };
  return { kind: pick.kind, index: pick.index, ...(pick.at ? { at: pick.at } : {}) };
}

// ---------------------------------------------------------------- tessellated geometry for the fallback distance
/** { pts, segs, tris } in world coordinates for a pick. */
export function geometryOf(build, pick) {
  const M = pick.matrix || IDENT;
  if (isPointPick(pick)) return { pts: [W(M, pick.local)], segs: [], tris: [] };
  const m = build.mesh;
  if (pick.kind === 'edge') {
    const segs = [];
    for (let k = 0; k < m.segEdge.length; k++) if (m.segEdge[k] === pick.index) { const s = m.edgeSegs; segs.push([W(M, [s[k * 6], s[k * 6 + 1], s[k * 6 + 2]]), W(M, [s[k * 6 + 3], s[k * 6 + 4], s[k * 6 + 5]])]); }
    return { pts: segs.flatMap((s) => s), segs, tris: [] };
  }
  const tris = (pick.kind === 'body' ? Array.from({ length: m.indices.length / 3 }, (_, t) => t) : faceTris(build, pick)).map((t) => triPts(m, t).map((p) => W(M, p)));
  const segs = [], pts = [];
  for (const [a, b, c] of tris) { segs.push([a, b], [b, c], [c, a]); pts.push(a, b, c); }
  return { pts, segs, tris };
}

export function pointTri(p, [a, b, c]) {
  // closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5)
  const ab = V.sub(b, a), ac = V.sub(c, a), ap = V.sub(p, a);
  const d1 = V.dot(ab, ap), d2 = V.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = V.sub(p, b), d3 = V.dot(ab, bp), d4 = V.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return V.add(a, V.mul(ab, d1 / (d1 - d3)));
  const cp = V.sub(p, c), d5 = V.dot(ab, cp), d6 = V.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return V.add(a, V.mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return V.add(b, V.mul(V.sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return V.add(a, V.add(V.mul(ab, vb * den), V.mul(ac, vc * den)));
}

export function segSeg([p1, q1], [p2, q2]) {
  // closest points of two segments (Ericson 5.1.9)
  const d1 = V.sub(q1, p1), d2 = V.sub(q2, p2), r = V.sub(p1, p2);
  const a = V.dot(d1, d1), e = V.dot(d2, d2), f = V.dot(d2, r);
  let s, t;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  if (a <= 1e-18 && e <= 1e-18) return [p1, p2];
  if (a <= 1e-18) { s = 0; t = clamp(f / e); }
  else {
    const c = V.dot(d1, r);
    if (e <= 1e-18) { t = 0; s = clamp(-c / a); }
    else {
      const b = V.dot(d1, d2), den = a * e - b * b;
      s = den > 1e-18 ? clamp((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a); } else if (t > 1) { t = 1; s = clamp((b - c) / a); }
    }
  }
  return [V.add(p1, V.mul(d1, s)), V.add(p2, V.mul(d2, t))];
}

/** Minimum distance between two tessellated pick geometries (exact for the facets, when they do not cross). */
export function meshDistance(A, B) {
  let best = { distance: Infinity, p1: null, p2: null };
  const take = (p, q) => { const d = V.len(V.sub(p, q)); if (d < best.distance) best = { distance: d, p1: p, p2: q }; };
  for (const p of A.pts) for (const q of B.pts) take(p, q);
  for (const p of A.pts) for (const t of B.tris) take(p, pointTri(p, t));
  for (const q of B.pts) for (const t of A.tris) take(pointTri(q, t), q);
  for (const p of A.pts) for (const s of B.segs) take(p, segSeg([p, p], s)[1]);
  for (const q of B.pts) for (const s of A.segs) take(segSeg(s, [q, q])[0], q);
  if (A.segs.length * B.segs.length <= 4e6) for (const s of A.segs) for (const u of B.segs) { const [p, q] = segSeg(s, u); take(p, q); }
  return best;
}

// ---------------------------------------------------------------- two picks
const deg = (r) => r * 180 / Math.PI;
const acosC = (x) => Math.acos(Math.max(-1, Math.min(1, x)));

/** A direction a pick stands for, for angles: { kind: 'plane'|'line', d }. */
function dirOf(inf) {
  if (inf.n) return { kind: 'plane', d: inf.n };
  if (inf.dir) return { kind: 'line', d: inf.dir };
  if (inf.axisLine) return { kind: 'line', d: inf.axisLine.d };
  if (inf.axis && inf.centre) return { kind: 'line', d: inf.axis };   // circle: its axis
  return null;
}
function centreLine(inf) {
  if (inf.axisLine) return inf.axisLine;
  if (inf.centre && inf.axis) return { o: inf.centre, d: inf.axis };
  return null;
}

export function pair(A, B, ia, ib, exactDistance = null) {
  const out = {};
  if (isPointPick(A) && isPointPick(B)) Object.assign(out, { distance: V.len(V.sub(ib.p, ia.p)), p1: ia.p, p2: ib.p, method: 'exact' });
  else if (exactDistance) Object.assign(out, { distance: exactDistance.distance, p1: exactDistance.p1, p2: exactDistance.p2, method: 'exact', inside: exactDistance.inside });
  else if (A.geometry && B.geometry) {
    const d = meshDistance(A.geometry, B.geometry);
    Object.assign(out, d, { method: 'facets' });
  }
  if (out.p1) out.delta = V.sub(out.p2, out.p1);
  const da = dirOf(ia), db = dirOf(ib);
  if (da && db) {
    const c = V.dot(da.d, db.d);
    if (da.kind === 'plane' && db.kind === 'plane') out.angle = deg(acosC(c));
    else if (da.kind === 'line' && db.kind === 'line') out.angle = deg(acosC(Math.abs(c)));
    else out.angle = 90 - deg(acosC(Math.abs(c)));
  }
  // parallel planes: their gap; circles/holes: centre to centre (and axis to axis when parallel)
  if (da?.kind === 'plane' && db?.kind === 'plane' && Math.abs(Math.abs(V.dot(da.d, db.d)) - 1) < 1e-9) out.planeGap = Math.abs(V.dot(V.sub(ib.o, ia.o), da.d));
  if (ia.centre && ib.centre) out.centre = V.len(V.sub(ib.centre, ia.centre));
  const la = centreLine(ia), lb = centreLine(ib);
  if (la && lb && Math.abs(Math.abs(V.dot(la.d, lb.d)) - 1) < 1e-9) {
    const w = V.sub(lb.o, la.o);
    out.axisGap = V.len(V.sub(w, V.mul(la.d, V.dot(w, la.d))));
  }
  return out;
}

// ---------------------------------------------------------------- mass properties
/** Divergence theorem over a closed triangle mesh (part coordinates). */
export function meshMass(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let vol = 0, area = 0;
  const s1 = [0, 0, 0];
  const C = [0, 0, 0, 0, 0, 0];   // ∫ xx yy zz xy yz xz
  for (let t = 0; t < I.length; t += 3) {
    const a = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
    const v = V.dot(a, V.cross(b, c)) / 6;
    area += V.len(V.cross(V.sub(b, a), V.sub(c, a))) / 2;
    vol += v;
    const s = V.add(V.add(a, b), c);
    for (let k = 0; k < 3; k++) s1[k] += v * s[k] / 4;
    const q = (i, j) => v / 20 * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + s[i] * s[j]);
    C[0] += q(0, 0); C[1] += q(1, 1); C[2] += q(2, 2); C[3] += q(0, 1); C[4] += q(1, 2); C[5] += q(0, 2);
  }
  const g = V.mul(s1, 1 / vol);
  // second moments about the centre, then the inertia tensor (density 1)
  const cxx = C[0] - vol * g[0] * g[0], cyy = C[1] - vol * g[1] * g[1], czz = C[2] - vol * g[2] * g[2];
  const cxy = C[3] - vol * g[0] * g[1], cyz = C[4] - vol * g[1] * g[2], cxz = C[5] - vol * g[0] * g[2];
  const tensor = [[cyy + czz, -cxy, -cxz], [-cxy, cxx + czz, -cyz], [-cxz, -cyz, cxx + cyy]];
  return { volume: vol, area, centre: g, tensor, exact: false };
}

/** Mass-weighted properties in world axes: { mass (g), volume, area, centre, tensor (g·mm²) }. */
export function placeMass(props, matrix, density) {
  const M = matrix || IDENT;
  const R = [[M[0], M[4], M[8]], [M[1], M[5], M[9]], [M[2], M[6], M[10]]];
  const k = density / 1000;
  const T = props.tensor;
  const RT = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i][0] * T[0][j] + R[i][1] * T[1][j] + R[i][2] * T[2][j]));
  const tensor = [0, 1, 2].map((i) => [0, 1, 2].map((j) => k * (RT[i][0] * R[j][0] + RT[i][1] * R[j][1] + RT[i][2] * R[j][2])));
  return { mass: massOf(props.volume, density), volume: props.volume, area: props.area, centre: V.applyMat(M, props.centre), tensor, exact: !!props.exact };
}

export function combineMass(list) {
  const mass = list.reduce((s, x) => s + x.mass, 0);
  const centre = [0, 1, 2].map((k) => list.reduce((s, x) => s + x.mass * x.centre[k], 0) / (mass || 1));
  const tensor = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const x of list) {
    const d = V.sub(x.centre, centre), dd = V.dot(d, d);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tensor[i][j] += x.tensor[i][j] + x.mass * ((i === j ? dd : 0) - d[i] * d[j]);
  }
  return { mass, volume: list.reduce((s, x) => s + x.volume, 0), area: list.reduce((s, x) => s + x.area, 0), centre, tensor, exact: list.every((x) => x.exact) };
}

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric 3×3 (cyclic Jacobi). */
export function principal(T) {
  const a = T.map((r) => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { moments: order.map((i) => a[i][i]), axes: order.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}

// ---------------------------------------------------------------- presentation
const f = (v, dp = 4) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(dp))));
const P3 = (p) => `${f(p[0])}, ${f(p[1])}, ${f(p[2])}`;
const KIND = { vertex: 'model.measure.kind.vertex', midpoint: 'model.measure.kind.midpoint', center: 'model.measure.kind.center', point: 'model.measure.kind.point', edge: 'model.measure.kind.edge', face: 'model.measure.kind.face', body: 'model.measure.kind.body' };
export const kindLabel = (k) => (KIND[k] ? tr(KIND[k]) : k);

/** Rows [label, value] for one pick's facts. */
export function infoRows(inf) {
  const r = [];
  if (inf.p && (POINTS.has(inf.kind))) r.push(['X, Y, Z', P3(inf.p)]);
  if (inf.kind === 'edge') {
    r.push([tr('model.measure.row.edge'), tr(inf.type === 'line' ? 'model.measure.edge.straight' : inf.type === 'circle' ? (inf.full ? 'model.measure.edge.circle' : 'model.measure.edge.arc') : 'model.measure.edge.curve')], [tr('model.measure.row.length'), f(inf.length) + ' mm']);
    if (inf.r !== undefined) r.push([tr('model.measure.row.radius'), f(inf.r) + ' mm'], [tr('model.measure.row.diameter'), f(2 * inf.r) + ' mm'], [tr('model.measure.row.centre'), P3(inf.centre)]);
  }
  if (inf.kind === 'face') {
    const fk = { plane: 'model.measure.face.plane', cylinder: 'model.measure.face.cylinder', cone: 'model.measure.face.cone', sphere: 'model.measure.face.sphere', torus: 'model.measure.face.torus', spline: 'model.measure.face.spline', facets: 'model.measure.face.facets', other: 'model.measure.face.other' }[inf.type];
    const ft = fk ? tr(fk) : inf.type;
    r.push([tr('model.measure.row.face'), ft], [tr('model.measure.row.area'), inf.exact ? f(inf.area) + ' mm²' : tr('model.measure.area_facets', { v: f(inf.area) })]);
    if (inf.n) r.push([tr('model.measure.row.normal'), P3(inf.n)]);
    if (inf.r !== undefined) r.push([tr('model.measure.row.radius'), f(inf.r) + ' mm'], [tr('model.measure.row.diameter'), f(2 * inf.r) + ' mm']);
  }
  if (inf.kind === 'body') r.push([tr('model.measure.row.volume'), f(inf.volume, 3) + ' mm³'], [tr('model.measure.row.area'), f(inf.area, 3) + ' mm²']);
  return r;
}

export function pairRows(res) {
  const r = [];
  if (res.distance !== undefined) r.push([tr('model.measure.row.min_distance'), res.method === 'facets' ? tr('model.measure.distance_facets', { v: f(res.distance) }) : f(res.distance) + ' mm']);
  if (res.delta) r.push(['ΔX', f(res.delta[0]) + ' mm'], ['ΔY', f(res.delta[1]) + ' mm'], ['ΔZ', f(res.delta[2]) + ' mm']);
  if (res.p1) r.push([tr('model.measure.row.closest'), tr('model.measure.closest_points', { a: P3(res.p1), b: P3(res.p2) })]);
  if (res.inside) r.push([tr('model.measure.row.note'), tr('model.measure.inside')]);
  if (res.angle !== undefined) r.push([tr('model.measure.row.angle'), f(res.angle, 6) + '°']);
  if (res.planeGap !== undefined) r.push([tr('model.measure.row.plane_gap'), f(res.planeGap) + ' mm']);
  if (res.centre !== undefined) r.push([tr('model.measure.row.centre_to_centre'), f(res.centre) + ' mm']);
  if (res.axisGap !== undefined) r.push([tr('model.measure.row.axis_to_axis'), f(res.axisGap) + ' mm']);
  return r;
}

export function massRows(m) {
  const pr = principal(m.tensor);
  const kg = (v) => f(v / 1000, 3);   // g·mm² → kg·mm²
  const r = [];
  if (m.mass !== undefined) r.push([tr('model.measure.row.mass'), m.mass >= 1000 ? f(m.mass / 1000, 4) + ' kg' : f(m.mass, 3) + ' g']);
  r.push([tr('model.measure.row.volume'), f(m.volume, 3) + ' mm³'], [tr('model.measure.row.area'), f(m.area, 3) + ' mm²'], [tr('model.measure.row.centre_of_mass'), P3(m.centre)]);
  const unit = m.mass !== undefined ? ' kg·mm²' : ' mm⁵';
  const s = m.mass !== undefined ? kg : (v) => f(v, 3);
  // i18n-ignore: tensor component symbols
  r.push(['Ixx, Iyy, Izz', `${s(m.tensor[0][0])}, ${s(m.tensor[1][1])}, ${s(m.tensor[2][2])}${unit}`], ['Ixy, Iyz, Ixz', `${s(m.tensor[0][1])}, ${s(m.tensor[1][2])}, ${s(m.tensor[0][2])}${unit}`]);
  r.push([tr('model.measure.row.principal'), pr.moments.map(s).join(', ') + unit]);
  r.push([tr('model.measure.row.method'), tr(m.exact ? 'model.measure.method.exact' : 'model.measure.method.mesh')]);
  return r;
}

export const asText = (rows) => rows.map(([k, v]) => k + '\t' + v).join('\n');
