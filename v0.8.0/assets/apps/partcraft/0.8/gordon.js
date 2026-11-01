/* SPDX-License-Identifier: Apache-2.0 */
/**
 * gordon.js — Gordon surfaces: one B-spline surface through a network of curves (DOM-free, no OCCT; surface.js hands
 * the result to OpenCascade as one Geom_BSplineSurface, because the vendored OCCT 8.0 build binds no GeomFill_Gordon,
 * BRepFill_Gordon or GeomFill_NSections).
 *
 * Method (Gordon 1969; the transfinite Boolean sum): S = Lu + Lv − T, where Lu skins the profiles (interpolates them
 * across at the parameters v̄ where the guides meet them), Lv skins the guides at ū, and T is the tensor-product
 * interpolant of the intersection grid with the same knots, so S passes through every profile and every guide.
 *   1. Curves: lines, open sketch splines and chains of them are exact polynomial B-splines; arcs, circles, closed
 *      curves and model edges are point samplers.
 *   2. Intersections: every profile × guide pair, polylines crossed, then Gauss–Newton on |P(s) − G(t)|² (numeric
 *      derivatives), kept within the tolerance. The network must be a grid: each profile meets each guide once.
 *   3. Order and direction: guides sorted along the first profile, profiles along the first guide, curves running
 *      backwards reversed; closed curves start at the first curve of the other family, which is then used twice.
 *   4. Compatibility. Exact path (every curve polynomial, open, and the intersection parameters already equal across
 *      the family): degree raised to the family's highest and knots merged, both exactly (interpolation at the
 *      Greville points of the finer space reproduces any curve in a subspace). Otherwise each curve is
 *      reparametrised by a monotone cubic (Fritsch–Carlson) s ↦ r(s) taking the common parameters ū to its own
 *      intersection parameters (and trimming it at the outer curves), and C∘r is fitted by one cubic interpolant on a
 *      shared parameter set (full-multiplicity knots at curve corners), refined until the fit is within `fitTol`
 *      of the true curve (closest-point distance) — the same knots for the whole family.
 *   5. Lu, Lv, T by global interpolation (degree min(3, curves − 1), knots by averaging, NURBS Book 9.8); raised to
 *      a common degree and knot vector (exactly, as in 4) and summed pole by pole.
 * The boundary of S is the outer curves themselves, so neighbours sharing a boundary curve meet in G0.
 * 6. Tangency (0.4 P11, option `tangent: [{ o, n }]`): for each plane, the boundary curve lying in it is found (within tol);
 *    a knot is inserted 0.3 of the way to the next curve of that family (exact refinement), so the second row of poles only
 *    moves the surface in that thin band, and that row is projected into the plane. A clamped B-spline's cross derivative
 *    along the boundary is a multiple of (row 1 − row 0) pole by pole, and the boundary row lies in the plane with its
 *    curve, so the surface leaves the boundary tangent to the plane (G1) everywhere along it. Inside the band it may leave
 *    the guides (or profiles) that cross that boundary: the deviation check below measures it; guides drawn leaving the
 *    boundary tangent to the plane keep it near zero.
 *
 *   sketchCurves(sk, frame, { entities, label }) → curves (one per chain of the chosen sketch curves)
 *   lineCurve(a, b, label), samplerCurve(f, { closed, breaks, label })
 *   gordon(profiles, guides, { tol, fitTol, tangent }) → { surface, report (+ tangent: [{ side, curve, angle }]), grid, params }
 *   tangentToPlane(S, { o, n }, params, { tol, closedU, closedV }) → { surface, side ('u0'|'u1'|'v0'|'v1'), angle (° before) }
 *   evalCurve, evalSurface, interpolate, averagedKnots, greville, elevate, knotsToMults
 * A curve is { f(t) → [x, y, z] on [0, 1], bs: { p, U, P } | null (exact form on [0, 1]), breaks: [t] (corners),
 * seamBreak (a closed chain's start is a corner), closed, label }. A surface is { pu, pv, U, V, P[i][j] (i along u) }.
 */
import * as V from './vec.js';
import * as SP from './sketch-spline.js';
import { pointXY, arcAngles, splineCurve } from './sketch.js';
import { t, t as tr } from './i18n.js';

export class GordonError extends Error {}
const fail = (m) => { throw new GordonError(m); };
const KTOL = 1e-10;   // knot values closer than this are one knot

// ---------------------------------------------------------------- B-spline basics (any dimension, clamped, [0, 1])

export function evalCurve(c, t) {
  const n = c.P.length, k = SP.findSpan(c.U, c.p, n, t), N = SP.basisFuns(k, t, c.p, c.U);
  const d = c.P[0].length, out = new Array(d).fill(0);
  for (let j = 0; j <= c.p; j++) { const q = c.P[k - c.p + j]; for (let a = 0; a < d; a++) out[a] += N[j] * q[a]; }
  return out;
}

export function evalSurface(s, u, v) {
  const nu = s.P.length, nv = s.P[0].length;
  const ku = SP.findSpan(s.U, s.pu, nu, u), kv = SP.findSpan(s.V, s.pv, nv, v);
  const Nu = SP.basisFuns(ku, u, s.pu, s.U), Nv = SP.basisFuns(kv, v, s.pv, s.V);
  const out = [0, 0, 0];
  for (let i = 0; i <= s.pu; i++) for (let j = 0; j <= s.pv; j++) {
    const w = Nu[i] * Nv[j], q = s.P[ku - s.pu + i][kv - s.pv + j];
    out[0] += w * q[0]; out[1] += w * q[1]; out[2] += w * q[2];
  }
  return out;
}

/** Interpolation knots by averaging (NURBS Book eq. 9.8) for n params and degree p. */
export function averagedKnots(t, p) {
  const n = t.length, U = [];
  for (let i = 0; i <= p; i++) U.push(t[0]);
  for (let j = 1; j <= n - 1 - p; j++) { let s = 0; for (let i = j; i < j + p; i++) s += t[i]; U.push(s / p); }
  for (let i = 0; i <= p; i++) U.push(t[n - 1]);
  return U;
}

export const greville = (p, U, n) => Array.from({ length: n }, (_, i) => { let s = 0; for (let k = 1; k <= p; k++) s += U[i + k]; return s / p; });

/**
 * The collocation matrix of degree p / knots U (n functions) at n params, factored as a band LU without pivoting
 * (B-spline collocation matrices are totally positive: de Boor). → solve(points) → poles.
 */
function bandLU(p, U, n, params) {
  if (params.length !== n) fail('Internal: the interpolation is not square.');   // i18n-ignore: internal check, never reached by a person
  const rows = params.map((t) => { const k = SP.findSpan(U, p, n, t); return { lo: k - p, N: SP.basisFuns(k, t, p, U) }; });
  let kl = 0, ku = 0;
  rows.forEach((r, i) => { kl = Math.max(kl, i - r.lo); ku = Math.max(ku, r.lo + p - i); });
  const w = kl + ku + 1, A = new Float64Array(n * w);
  rows.forEach((r, i) => r.N.forEach((v, j) => { A[i * w + (r.lo + j - i + kl)] = v; }));
  for (let c = 0; c < n; c++) {
    const piv = A[c * w + kl];
    if (!(Math.abs(piv) > 1e-13)) fail(tr('model.gordon.err.too_close'));
    for (let r = c + 1; r <= Math.min(n - 1, c + kl); r++) {
      const ir = r * w + (c - r + kl), f = A[ir] / piv;
      if (f === 0) continue;
      A[ir] = f;
      for (let j = c + 1; j <= Math.min(n - 1, c + ku); j++) A[r * w + (j - r + kl)] -= f * A[c * w + (j - c + kl)];
    }
  }
  return (Q) => {
    const d = Q[0].length, X = Q.map((q) => q.slice());
    for (let r = 0; r < n; r++) for (let c = Math.max(0, r - kl); c < r; c++) { const f = A[r * w + (c - r + kl)]; if (f) for (let a = 0; a < d; a++) X[r][a] -= f * X[c][a]; }
    for (let r = n - 1; r >= 0; r--) {
      for (let j = r + 1; j <= Math.min(n - 1, r + ku); j++) { const v = A[r * w + (j - r + kl)]; if (v) for (let a = 0; a < d; a++) X[r][a] -= v * X[j][a]; }
      const piv = A[r * w + kl];
      for (let a = 0; a < d; a++) X[r][a] /= piv;
    }
    return X;
  };
}

/** Global interpolation of points Q at params t (degree p, knots by averaging unless given). */
export function interpolate(Q, t, p, U = null) {
  const K = U || averagedKnots(t, p);
  return { p, U: K, P: bandLU(p, K, Q.length, t)(Q) };
}

/** Distinct knots and multiplicities. */
export function knotsToMults(U, tol = KTOL) {
  const k = [], m = [];
  for (const u of U) { if (k.length && Math.abs(u - k[k.length - 1]) <= tol) m[m.length - 1]++; else { k.push(u); m.push(1); } }
  return { k, m };
}
const multsToKnots = (k, m) => k.flatMap((u, i) => new Array(m[i]).fill(u));

/** The knot vector of degree d holding a degree-p curve on U (each distinct interior knot gains d − p). */
export function elevatedKnots(p, U, d) {
  const { k, m } = knotsToMults(U);
  return multsToKnots(k, m.map((x, i) => (i === 0 || i === k.length - 1 ? d + 1 : x + (d - p))));
}

/** The smallest degree-d knot vector containing each of the (degree-d) knot vectors. */
function unionKnots(list, d) {
  const all = [];
  for (const U of list) { const { k, m } = knotsToMults(U); k.forEach((u, i) => all.push([u, m[i]])); }
  all.sort((a, b) => a[0] - b[0]);
  const k = [], m = [];
  for (const [u, x] of all) { if (k.length && u - k[k.length - 1] <= 1e-9) m[m.length - 1] = Math.max(m[m.length - 1], x); else { k.push(u); m.push(x); } }
  k[0] = 0; k[k.length - 1] = 1;
  return multsToKnots(k, m.map((x, i) => (i === 0 || i === k.length - 1 ? d + 1 : Math.min(x, d))));
}

const sameSpace = (p, U, d, W) => p === d && U.length === W.length && U.every((u, i) => Math.abs(u - W[i]) <= 1e-12);

/** Poles in (p, U) → poles of the same curve in the finer space (d, W): interpolation at W's Greville points (exact). */
function projector(p, U, n, d, W) {
  if (sameSpace(p, U, d, W)) return (P) => P.map((q) => q.slice());
  const m = W.length - d - 1, g = greville(d, W, m), solve = bandLU(d, W, m, g);
  const rows = g.map((t) => { const k = SP.findSpan(U, p, n, t); return { lo: k - p, N: SP.basisFuns(k, t, p, U) }; });
  return (P) => {
    const dim = P[0].length;
    return solve(rows.map((r) => { const o = new Array(dim).fill(0); r.N.forEach((v, j) => { const q = P[r.lo + j]; for (let a = 0; a < dim; a++) o[a] += v * q[a]; }); return o; }));
  };
}

/** The curve c raised to degree d (exact). */
export function elevate(c, d) {
  if (d === c.p) return c;
  const W = elevatedKnots(c.p, c.U, d);
  return { p: d, U: W, P: projector(c.p, c.U, c.P.length, d, W)(c.P) };
}

function projectSurface(s, du, Uc, dv, Vc) {
  let P = s.P;
  if (!sameSpace(s.pu, s.U, du, Uc)) {
    const pr = projector(s.pu, s.U, P.length, du, Uc), nv = P[0].length, cols = [];
    for (let j = 0; j < nv; j++) cols.push(pr(P.map((row) => row[j])));
    P = cols[0].map((_, i) => cols.map((col) => col[i]));
  }
  if (!sameSpace(s.pv, s.V, dv, Vc)) { const pr = projector(s.pv, s.V, P[0].length, dv, Vc); P = P.map((row) => pr(row)); }
  return { pu: du, pv: dv, U: Uc, V: Vc, P };
}

const reverseBs = (c) => ({ p: c.p, U: c.U.slice().reverse().map((u) => 1 - u), P: c.P.slice().reverse() });

/** The same surface with the knot t added to U ('u') or V ('v') (exact). */
function withKnot(S, dir, t) {
  const W = (dir === 'u' ? S.U : S.V).slice();
  W.splice(W.findIndex((x) => x > t), 0, t);
  return dir === 'u' ? projectSurface(S, S.pu, W, S.pv, S.V) : projectSurface(S, S.pu, S.U, S.pv, W);
}

export function tangentToPlane(S, plane, params, { tol = 0.01, closedU = false, closedV = false, skip = [] } = {}) {
  const n = V.norm(plane.n), dist = (q) => Math.abs(V.dot(V.sub(q, plane.o), n));
  const sides = [];
  if (!closedV) sides.push(['v0', (t) => evalSurface(S, t, 0)], ['v1', (t) => evalSurface(S, t, 1)]);
  if (!closedU) sides.push(['u0', (t) => evalSurface(S, 0, t)], ['u1', (t) => evalSurface(S, 1, t)]);
  let best = null;
  for (const [side, f] of sides) { if (skip.includes(side)) continue; let d = 0; for (let k = 0; k <= 64; k++) d = Math.max(d, dist(f(k / 64))); if (!best || d < best.d) best = { side, d }; }
  if (!best || best.d > tol) fail(t('gordon.err.no_boundary', { d: fmt(best ? best.d : Infinity), tol }));
  const { side } = best, dir = side[0], end = side[1] === '1';
  // the angle the surface makes with the plane along that boundary now
  const deriv = (T, t) => { const h = 1e-6, a = dir === 'v' ? [t, end ? 1 - h : h] : [end ? 1 - h : h, t], b = dir === 'v' ? [t, end ? 1 : 0] : [end ? 1 : 0, t]; return V.sub(evalSurface(T, a[0], a[1]), evalSurface(T, b[0], b[1])); };
  let angle = 0;
  for (let k = 0; k <= 32; k++) { const d = deriv(S, k / 32), l = V.len(d); if (l > 0) angle = Math.max(angle, Math.asin(Math.min(1, Math.abs(V.dot(d, n)) / l)) * 180 / Math.PI); }
  // localise: a knot 0.3 of the way to the next curve of that family, unless one is that close already
  const par = dir === 'v' ? params.v : params.u, K = dir === 'v' ? S.V : S.U, deg = dir === 'v' ? S.pv : S.pu;
  const next = end ? par[par.length - 2] : par[1], tk = end ? 1 - 0.3 * (1 - next) : 0.3 * next;
  const firstInner = end ? K[K.length - deg - 2] : K[deg + 1];
  let T = S;
  if (end ? firstInner < tk - 1e-9 : firstInner > tk + 1e-9) T = withKnot(S, dir, tk);
  // the second row (or column) of poles into the plane
  const P = T.P.map((row) => row.map((q) => q.slice()));
  const into = (a, b) => { const d = V.sub(b, a); return V.add(a, V.sub(d, V.mul(n, V.dot(d, n)))); };
  if (dir === 'v') { const j0 = end ? P[0].length - 1 : 0, j1 = end ? j0 - 1 : 1; for (const row of P) row[j1] = into(row[j0], row[j1]); }
  else { const i0 = end ? P.length - 1 : 0, i1 = end ? i0 - 1 : 1; P[i1] = P[i1].map((q, j) => into(P[i0][j], q)); }
  return { surface: { ...T, P }, side, angle };
}

// ---------------------------------------------------------------- input curves

export const lineCurve = (a, b, label = tr('model.gordon.label.line')) => ({ f: (t) => V.add(a, V.mul(V.sub(b, a), t)), bs: { p: 1, U: [0, 0, 1, 1], P: [a.slice(), b.slice()] }, breaks: [], closed: false, label });
export const samplerCurve = (f, { closed = false, breaks = [], seamBreak = false, label = tr('model.gordon.label.curve'), bs = null } = {}) => ({ f, bs, breaks, seamBreak, closed, label });

/**
 * The chosen curves of a sketch (all non-construction lines, arcs, circles and splines, or `entities`) as world curves,
 * one per chain joined end to end. A branch (three curves at a point) is refused.
 */
export function sketchCurves(sk, frame, { entities = null, label = tr('model.gordon.label.sketch') } = {}) {
  const want = entities ? new Set(entities) : null;
  const W = (p) => V.toWorld(frame, p[0], p[1]);
  const pieces = [];
  let size = 1;
  for (const e of sk.entities) {
    if (want ? !want.has(e.id) : e.construction) continue;
    if (e.type === 'line') { const a = pointXY(sk, e.p1), b = pointXY(sk, e.p2); pieces.push({ kind: 'line', a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }); }
    else if (e.type === 'arc') {
      const { c, r, a0, sweep } = arcAngles(sk, e);
      pieces.push({ kind: 'arc', c, r, a0, sweep, a: [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)], b: [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)], len: r * sweep });
    } else if (e.type === 'circle') { const c = pointXY(sk, e.c); pieces.push({ kind: 'arc', c, r: e.r, a0: 0, sweep: 2 * Math.PI, closed: true, len: 2 * Math.PI * e.r }); }
    else if (e.type === 'spline') {
      const bs = splineCurve(sk, e), [lo, hi] = SP.domain(bs);
      const at = (u) => SP.pointAt(bs, lo + (hi - lo) * u);
      pieces.push({ kind: 'spline', bs, lo, hi, closed: !!e.closed, a: at(0), b: at(1), len: SP.arcLength(bs) });
    } else continue;
    for (const p of [pieces[pieces.length - 1].a, pieces[pieces.length - 1].b, pieces[pieces.length - 1].c]) if (p) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  }
  if (!pieces.length) fail(tr('model.gordon.err.no_curves', { label }));
  const tol = 1e-6 * size;
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
  const at2 = (pc, u) => {   // a piece at its own parameter u ∈ [0, 1], sketch coordinates
    if (pc.kind === 'line') return [pc.a[0] + (pc.b[0] - pc.a[0]) * u, pc.a[1] + (pc.b[1] - pc.a[1]) * u];
    if (pc.kind === 'arc') { const t = pc.a0 + pc.sweep * u; return [pc.c[0] + pc.r * Math.cos(t), pc.c[1] + pc.r * Math.sin(t)]; }
    return SP.pointAt(pc.bs, pc.lo + (pc.hi - pc.lo) * u);
  };
  const out = [];
  const open = [];
  for (const pc of pieces) {
    if (!pc.closed) { open.push(pc); continue; }
    out.push(samplerCurve((t) => W(at2(pc, ((t % 1) + 1) % 1)), { closed: true, label: pc.kind === 'arc' ? tr('model.gordon.label.circle', { label }) : tr('model.gordon.label.closed_spline', { label }) }));
  }
  const deg = (p) => open.reduce((k, pc) => k + (near(pc.a, p) ? 1 : 0) + (near(pc.b, p) ? 1 : 0), 0);
  for (const pc of open) for (const p of [pc.a, pc.b]) if (deg(p) > 2) fail(tr('model.gordon.err.branches', { label, at: p.map((v) => +v.toFixed(3)).join(', ') }));
  const used = new Set();
  while (used.size < open.length) {
    // start at a free end when the chain has one
    let first = open.find((pc) => !used.has(pc) && (deg(pc.a) === 1 || deg(pc.b) === 1)) || open.find((pc) => !used.has(pc));
    const chain = [{ pc: first, rev: deg(first.a) !== 1 && deg(first.b) === 1 }];
    used.add(first);
    for (;;) {
      const last = chain[chain.length - 1], tip = last.rev ? last.pc.a : last.pc.b;
      const nx = open.find((pc) => !used.has(pc) && (near(pc.a, tip) || near(pc.b, tip)));
      if (!nx) break;
      used.add(nx); chain.push({ pc: nx, rev: !near(nx.a, tip) });
    }
    const start = chain[0].rev ? chain[0].pc.b : chain[0].pc.a, end = chain[chain.length - 1].rev ? chain[chain.length - 1].pc.a : chain[chain.length - 1].pc.b;
    const closed = chain.length > 1 && near(start, end);
    const total = chain.reduce((s, x) => s + x.pc.len, 0);
    if (!(total > 0)) fail(tr('model.gordon.err.zero_length', { label }));
    const ts = [0];
    for (const x of chain) ts.push(ts[ts.length - 1] + x.pc.len / total);
    ts[ts.length - 1] = 1;
    const f = (t0) => {
      const t = closed ? ((t0 % 1) + 1) % 1 : Math.min(1, Math.max(0, t0));
      let k = 0;
      while (k < chain.length - 1 && t > ts[k + 1]) k++;
      const u = (t - ts[k]) / (ts[k + 1] - ts[k]);
      return W(at2(chain[k].pc, chain[k].rev ? 1 - u : u));
    };
    // exact form when every piece is polynomial (lines, open clamped splines)
    let bs = null;
    if (!closed && chain.every((x) => x.pc.kind === 'line' || (x.pc.kind === 'spline' && clamped(x.pc.bs)))) {
      const parts = chain.map((x) => {
        let c;
        if (x.pc.kind === 'line') c = { p: 1, U: [0, 0, 1, 1], P: [W(x.pc.a), W(x.pc.b)] };
        else { const b = x.pc.bs, [lo, hi] = SP.domain(b); c = { p: b.deg, U: b.knots.map((u) => (u - lo) / (hi - lo)), P: b.poles.map(W) }; }
        return x.rev ? reverseBs(c) : c;
      });
      bs = concatenate(parts, ts);
    }
    out.push(samplerCurve(f, { breaks: ts.slice(1, -1), seamBreak: closed, closed, bs, label: chain.length > 1 ? tr('model.gordon.label.chain', { label, n: chain.length }) : label }));
  }
  return out;
}

const clamped = (b) => { const p = b.deg, U = b.knots, n = b.poles.length; for (let i = 1; i <= p; i++) if (U[i] !== U[0] || U[n + p - i] !== U[n + p]) return false; return !b.periodic; };

/** Exact curves on [0, 1] placed end to end at the breaks ts (C0 joins). */
function concatenate(parts, ts) {
  const d = Math.max(...parts.map((c) => c.p));
  const el = parts.map((c) => elevate(c, d));
  const U = new Array(d + 1).fill(0), P = [];
  el.forEach((c, k) => {
    const a = ts[k], b = ts[k + 1];
    const inner = c.U.slice(d + 1, c.U.length - d - 1).map((u) => a + (b - a) * u);
    U.push(...inner);
    if (k < el.length - 1) U.push(...new Array(d).fill(b));
    P.push(...(k ? c.P.slice(1) : c.P));
  });
  U.push(...new Array(d + 1).fill(1));
  return { p: d, U, P };
}

// ---------------------------------------------------------------- intersections

function segSeg(p1, q1, p2, q2) {
  // closest points of two segments (Ericson, Real-Time Collision Detection 5.1.9)
  const d1 = V.sub(q1, p1), d2 = V.sub(q2, p2), r = V.sub(p1, p2);
  const a = V.dot(d1, d1), e = V.dot(d2, d2), f = V.dot(d2, r);
  let s, t;
  if (a <= 1e-300 && e <= 1e-300) { s = t = 0; }
  else if (a <= 1e-300) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = V.dot(d1, r);
    if (e <= 1e-300) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = V.dot(d1, d2), den = a * e - b * b;
      s = den > 1e-300 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return { s, t, d: V.len(V.sub(V.add(p1, V.mul(d1, s)), V.add(p2, V.mul(d2, t)))) };
}

const wrap = (c, t) => (c.closed ? ((t % 1) + 1) % 1 : Math.min(1, Math.max(0, t)));
function deriv(c, t, h = 1e-7) {
  if (c.closed || (t - h >= 0 && t + h <= 1)) return V.mul(V.sub(c.f(wrap(c, t + h)), c.f(wrap(c, t - h))), 1 / (2 * h));
  return t < h ? V.mul(V.sub(c.f(t + h), c.f(t)), 1 / h) : V.mul(V.sub(c.f(t), c.f(t - h)), 1 / h);
}

/** Gauss–Newton on |A(s) − B(t)|² from (s, t). */
function refine(A, B, s, t) {
  let a = A.f(s), b = B.f(t);
  for (let it = 0; it < 40; it++) {
    const r = V.sub(a, b), da = deriv(A, s), db = deriv(B, t);
    const m11 = V.dot(da, da), m12 = -V.dot(da, db), m22 = V.dot(db, db);
    const g1 = -V.dot(da, r), g2 = V.dot(db, r);
    const det = m11 * m22 - m12 * m12;
    if (!(Math.abs(det) > 1e-300)) break;
    const ds = (g1 * m22 - m12 * g2) / det, dt = (m11 * g2 - m12 * g1) / det;
    const s2 = wrap(A, s + ds), t2 = wrap(B, t + dt);
    const a2 = A.f(s2), b2 = B.f(t2);
    if (V.len(V.sub(a2, b2)) > V.len(r) * (1 + 1e-12) + 1e-300 && it > 3) break;
    s = s2; t = t2; a = a2; b = b2;
    if (Math.abs(ds) < 1e-15 && Math.abs(dt) < 1e-15) break;
  }
  return { s, t, d: V.len(V.sub(a, b)), p: V.mul(V.add(a, b), 0.5) };
}

function polyline(c, K) {
  const ts = new Set();
  for (let k = 0; k <= K; k++) ts.add(k / K);
  for (const b of c.breaks) ts.add(b);
  return [...ts].sort((x, y) => x - y).map((t) => ({ t, p: c.f(t) }));
}

/** Every point where curves A and B come within tol: [{ s, t, d, p }]. */
function crossings(A, B, tol, KA, KB) {
  const pa = polyline(A, KA), pb = polyline(B, KB);
  const D = [];
  for (let k = 0; k < pa.length - 1; k++) {
    const row = [];
    for (let l = 0; l < pb.length - 1; l++) row.push(segSeg(pa[k].p, pa[k + 1].p, pb[l].p, pb[l + 1].p));
    D.push(row);
  }
  const out = [];
  const lenA = (k) => V.len(V.sub(pa[k + 1].p, pa[k].p)), lenB = (l) => V.len(V.sub(pb[l + 1].p, pb[l].p));
  for (let k = 0; k < D.length; k++) for (let l = 0; l < D[k].length; l++) {
    const x = D[k][l];
    if (x.d > tol + 0.25 * (lenA(k) + lenB(l))) continue;
    let min = true;
    for (let dk = -1; dk <= 1 && min; dk++) for (let dl = -1; dl <= 1; dl++) {
      const y = D[k + dk]?.[l + dl];
      if ((dk || dl) && y && (y.d < x.d || (y.d === x.d && (dk < 0 || (dk === 0 && dl < 0))))) { min = false; break; }
    }
    if (!min) continue;
    const s0 = pa[k].t + (pa[k + 1].t - pa[k].t) * x.s, t0 = pb[l].t + (pb[l + 1].t - pb[l].t) * x.t;
    const r = refine(A, B, s0, t0);
    if (r.d > tol) continue;
    const cyc = (c, u, w) => { const d = Math.abs(u - w); return c.closed ? Math.min(d, 1 - d) : d; };
    if (out.some((o) => (cyc(A, o.s, r.s) < 1e-7 && cyc(B, o.t, r.t) < 1e-7) || V.len(V.sub(o.p, r.p)) < Math.max(tol, 1e-9) * 1e-2)) continue;
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- reparametrisation and fitting

/** Monotone piecewise cubic through (x_k, y_k), x and y strictly increasing (Fritsch–Carlson / Fritsch–Butland slopes). */
function pchip(x, y) {
  const n = x.length, h = [], d = [];
  for (let k = 0; k < n - 1; k++) { h.push(x[k + 1] - x[k]); d.push((y[k + 1] - y[k]) / h[k]); }
  const m = new Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) { m[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  return (t) => {
    let k = 0;
    while (k < n - 2 && t > x[k + 1]) k++;
    const s = (t - x[k]) / h[k], s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[k] + (s3 - 2 * s2 + s) * h[k] * m[k] + (-2 * s3 + 3 * s2) * y[k + 1] + (s3 - s2) * h[k] * m[k + 1];
  };
}
const invert = (r, y) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (r(mid) < y) lo = mid; else hi = mid; } return (lo + hi) / 2; };

/** Distance from q to the curve g between parameters a and b (golden section on |g(t) − q|). */
function distNear(g, q, a, b) {
  const R = (Math.sqrt(5) - 1) / 2;
  let lo = Math.min(a, b), hi = Math.max(a, b);
  const pad = (hi - lo) * 0.5; lo = Math.max(0, lo - pad); hi = Math.min(1, hi + pad);
  let x1 = hi - R * (hi - lo), x2 = lo + R * (hi - lo);
  let f1 = V.len(V.sub(g(x1), q)), f2 = V.len(V.sub(g(x2), q));
  for (let i = 0; i < 60 && hi - lo > 1e-15; i++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - R * (hi - lo); f1 = V.len(V.sub(g(x1), q)); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + R * (hi - lo); f2 = V.len(V.sub(g(x2), q)); }
  }
  return Math.min(f1, f2);
}

const MAX_FIT = 6000;

/**
 * One family (profiles or guides) made compatible: { p, U, P: [poles of each curve], approx, err, maps }.
 * cs: oriented curves { g(σ) on [0, 1], bs, breaks (in σ), closed }; sig[i][j] = σ where curve i meets column j;
 * tbar[j] = the common parameters.
 */
function family(cs, sig, tbar, fitTol, what) {
  const aligned = cs.every((c, i) => sig[i].every((x, j) => Math.abs(x - tbar[j]) < 1e-10));
  if (aligned && cs.every((c) => c.bs && !c.closed)) {
    const d = Math.max(...cs.map((c) => c.bs.p));
    const el = cs.map((c) => elevate(c.bs, d));
    const U = unionKnots(el.map((c) => c.U), d);
    return { p: d, U, P: el.map((c) => projector(d, c.U, c.P.length, d, U)(c.P)), approx: false, err: 0, maps: cs.map(() => (s) => s) };
  }
  const maps = cs.map((c, i) => (aligned ? (s) => s : pchip(tbar, sig[i])));
  const bounds = new Set([0, 1]);
  cs.forEach((c, i) => { for (const b of c.breaks) if (b > 1e-9 && b < 1 - 1e-9) bounds.add(aligned ? b : invert(maps[i], b)); });
  const bl = [...bounds].sort((a, b) => a - b).filter((b, k, l) => k === 0 || b - l[k - 1] > 1e-9);
  const anchors = [...new Set([...bl, ...tbar])].sort((a, b) => a - b).filter((b, k, l) => k === 0 || b - l[k - 1] > 1e-9);
  const isBound = (s) => bl.some((b) => Math.abs(b - s) <= 1e-9);
  for (let nsub = 4; ; nsub *= 2) {
    const params = [];
    for (let k = 0; k < anchors.length - 1; k++) for (let q = 0; q < nsub; q++) params.push(anchors[k] + (anchors[k + 1] - anchors[k]) * q / nsub);
    params.push(1);
    if (params.length > MAX_FIT) fail(tr(what === 'profiles' ? 'model.gordon.err.fit_profiles' : 'model.gordon.err.fit_guides', { max: MAX_FIT, tol: fitTol.toExponential(1) }));
    // knots: averaged within each run between corners, full multiplicity at corners
    const U = [0, 0, 0, 0];
    let run = [params[0]];
    for (let k = 1; k < params.length; k++) {
      run.push(params[k]);
      if (isBound(params[k]) || k === params.length - 1) {
        const Kr = averagedKnots(run, 3);
        U.push(...Kr.slice(4, Kr.length - 4));
        if (k < params.length - 1) U.push(params[k], params[k], params[k]);
        run = [params[k]];
      }
    }
    U.push(1, 1, 1, 1);
    const solve = bandLU(3, U, params.length, params);
    let err = 0;
    const P = cs.map((c, i) => {
      const r = maps[i];
      const poles = solve(params.map((s) => c.g(r(s))));
      const bsC = { p: 3, U, P: poles };
      for (let k = 0; k < params.length - 1; k++) for (const w of [0.25, 0.5, 0.75]) {
        const s = params[k] + (params[k + 1] - params[k]) * w, q = evalCurve(bsC, s);
        let e = V.len(V.sub(q, c.g(r(s))));
        if (e > fitTol) e = distNear(c.g, q, r(params[k]), r(params[k + 1]));
        err = Math.max(err, e);
      }
      return poles;
    });
    if (err <= fitTol) return { p: 3, U, P, approx: true, err, maps, points: params.length };
  }
}

// ---------------------------------------------------------------- the network

/**
 * The Gordon surface through profiles and guides (curves as above). Options: tol (largest gap at a crossing, mm),
 * fitTol (approximation tolerance; default 1e-7 of the network's size). Throws GordonError with a plain message.
 */
export function gordon(profiles, guides, { tol = 0.01, fitTol = null, tangent = [] } = {}) {
  const n0 = profiles.length, m0 = guides.length;
  if (n0 < 2 || m0 < 2) fail(tr('model.gordon.err.too_few', { profiles: tr('model.gordon.n_profiles', { n: n0 }), guides: tr('model.gordon.n_guides', { n: m0 }) }));
  const name = (fam, i) => tr(fam === 'p' ? 'model.gordon.profile_n' : 'model.gordon.guide_n', { n: i + 1, label: (fam === 'p' ? profiles : guides)[i].label });
  for (const [fam, cs] of [['p', profiles], ['g', guides]]) if (new Set(cs.map((c) => !!c.closed)).size > 1) fail(tr(fam === 'p' ? 'model.gordon.err.mixed_profiles' : 'model.gordon.err.mixed_guides'));
  const pClosed = profiles[0].closed, gClosed = guides[0].closed;
  // size of the network
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of [...profiles, ...guides]) for (let k = 0; k <= 32; k++) { const p = c.f(k / 32); lo = lo.map((v, a) => Math.min(v, p[a])); hi = hi.map((v, a) => Math.max(v, p[a])); }
  const size = Math.max(1, V.len(V.sub(hi, lo)));
  const ftol = fitTol || 1e-7 * size;
  // crossings
  const K = (c) => 96 + 16 * c.breaks.length;
  const X = profiles.map((A, i) => guides.map((B, j) => {
    const xs = crossings(A, B, tol, K(A), K(B));
    if (!xs.length) {
      const near = crossings(A, B, Infinity, K(A), K(B)).reduce((b, x) => (x.d < b ? x.d : b), Infinity);
      fail(tr('model.gordon.err.no_meet', { profile: name('p', i), guide: name('g', j), d: fmt(near), tol }));
    }
    if (xs.length > 1) fail(tr('model.gordon.err.meets_often', { profile: name('p', i), guide: name('g', j), n: xs.length }));
    return xs[0];
  }));
  let gap = 0;
  for (const row of X) for (const x of row) gap = Math.max(gap, x.d);
  // orientation and order: guides along profile 0, then profiles along guide 0
  const rev = (c) => ({ ...c, f: (t) => c.f(c.closed ? ((1 - t) % 1 + 1) % 1 : 1 - t), bs: c.bs ? reverseBs(c.bs) : null, breaks: c.breaks.map((b) => 1 - b).reverse() });
  const P = profiles.slice(), G = guides.slice();
  const pIdx = P.map((_, i) => i), gIdx = G.map((_, j) => j);
  let gOrder = gIdx.slice().sort((a, b) => X[0][a].s - X[0][b].s);
  const direction = (seq, closed, tangentSign) => {
    const k = seq.length;
    if (!closed) {
      if (seq.every((v, q) => q === 0 || v > seq[q - 1])) return 1;
      if (seq.every((v, q) => q === 0 || v < seq[q - 1])) return -1;
      return 0;
    }
    if (k === 2) return tangentSign;
    let up = 0, down = 0;
    for (let q = 0; q < k; q++) { const a = seq[q], b = seq[(q + 1) % k]; if (b > a) up++; else down++; }
    return down === 1 ? 1 : up === 1 ? -1 : 0;
  };
  const tanAt = (c, t) => V.norm(deriv(c, t));
  for (let i = 0; i < n0; i++) {
    const seq = gOrder.map((j) => X[i][j].s);
    const ts = pClosed && m0 === 2 ? Math.sign(V.dot(tanAt(P[i], X[i][gOrder[0]].s), tanAt(P[0], X[0][gOrder[0]].s))) || 1 : 1;
    const dir = direction(seq, pClosed, i === 0 ? 1 : ts);
    if (!dir) fail(tr('model.gordon.err.order_profile', { curve: name('p', i), first: name('p', 0) }));
    if (dir < 0) { P[i] = rev(P[i]); for (const j of gIdx) X[i][j] = { ...X[i][j], s: pClosed ? ((1 - X[i][j].s) % 1 + 1) % 1 : 1 - X[i][j].s }; }
  }
  const g0 = gOrder[0];
  let pOrder = pIdx.slice().sort((a, b) => X[a][g0].t - X[b][g0].t);
  for (let j = 0; j < m0; j++) {
    const seq = pOrder.map((i) => X[i][j].t);
    const ts = gClosed && n0 === 2 ? Math.sign(V.dot(tanAt(G[j], X[pOrder[0]][j].t), tanAt(G[g0], X[pOrder[0]][g0].t))) || 1 : 1;
    const dir = direction(seq, gClosed, j === g0 ? 1 : ts);
    if (!dir) fail(tr('model.gordon.err.order_guide', { curve: name('g', j), first: name('g', g0) }));
    if (dir < 0) { G[j] = rev(G[j]); for (const i of pIdx) X[i][j] = { ...X[i][j], t: gClosed ? ((1 - X[i][j].t) % 1 + 1) % 1 : 1 - X[i][j].t }; }
  }
  // closed families start at the first curve of the other family (used again at the end)
  const pCols = pClosed ? [...gOrder, gOrder[0]] : gOrder, gRows = gClosed ? [...pOrder, pOrder[0]] : pOrder;
  const orient = (c, own, seam) => {
    if (!c.closed) return { g: c.f, bs: c.bs, breaks: c.breaks, closed: false };
    const br = [...c.breaks, ...(c.seamBreak ? [0] : [])].map((b) => ((b - seam) % 1 + 1) % 1).filter((b) => b > 1e-9 && b < 1 - 1e-9);
    void own;
    return { g: (s) => c.f(((s + seam) % 1 + 1) % 1), bs: null, breaks: br, closed: true };
  };
  const pc = pOrder.map((i) => orient(P[i], 'p', X[i][g0].s));
  const gc = gOrder.map((j) => orient(G[j], 'g', X[pOrder[0]][j].t));
  const sig = pOrder.map((i) => pCols.map((j, q) => (pClosed ? (q === pCols.length - 1 ? 1 : ((X[i][j].s - X[i][g0].s) % 1 + 1) % 1) : X[i][j].s)));
  const tau = gOrder.map((j) => gRows.map((i, q) => (gClosed ? (q === gRows.length - 1 ? 1 : ((X[i][j].t - X[pOrder[0]][j].t) % 1 + 1) % 1) : X[i][j].t)));
  const common = (rows, what) => {
    const m = rows[0].length, t = new Array(m).fill(0);
    for (const r of rows) {
      const a = r[0], b = r[m - 1];
      if (!(b - a > 1e-9)) fail(tr(what === 'profiles' ? 'model.gordon.err.same_point_profiles' : 'model.gordon.err.same_point_guides'));
      r.forEach((x, q) => { t[q] += (x - a) / (b - a) / rows.length; });
    }
    t[0] = 0; t[m - 1] = 1;
    for (let q = 1; q < m; q++) if (!(t[q] - t[q - 1] > 1e-6)) fail(tr(what === 'profiles' ? 'model.gordon.err.too_close_profiles' : 'model.gordon.err.too_close_guides'));
    return t;
  };
  const ubar = common(sig, 'guides'), vbar = common(tau, 'profiles');
  const grid = gRows.map((i) => pCols.map((j) => X[i][j].p));   // grid[row (v)][column (u)]
  // compatible families
  const FP = family(pc, sig, ubar, ftol, 'profiles');
  const FG = family(gc, tau, vbar, ftol, 'guides');
  const rowsP = gClosed ? [...FP.P, FP.P[0]] : FP.P;   // profiles in v order (closed guides: the first again)
  const colsG = pClosed ? [...FG.P, FG.P[0]] : FG.P;
  const nv = vbar.length, nu = ubar.length;
  const qv = Math.min(3, nv - 1), qu = Math.min(3, nu - 1);
  const Vl = averagedKnots(vbar, qv), Ul = averagedKnots(ubar, qu);
  // Lu: profiles skinned across v
  const sv = bandLU(qv, Vl, nv, vbar), su = bandLU(qu, Ul, nu, ubar);
  const LuP = FP.P[0].map((_, k) => sv(rowsP.map((poles) => poles[k])));
  const Lu = { pu: FP.p, pv: qv, U: FP.U, V: Vl, P: LuP };
  // Lv: guides skinned across u
  const LvCols = FG.P[0].map((_, l) => su(colsG.map((poles) => poles[l])));   // [l][j']
  const Lv = { pu: qu, pv: FG.p, U: Ul, V: FG.U, P: LvCols[0].map((_, jj) => LvCols.map((col) => col[jj])) };
  // T: the grid interpolated with the same knots
  const Tu = grid.map((row) => su(row));                          // [row i][u pole]
  const Tc = Tu[0].map((_, k) => sv(Tu.map((r) => r[k])));        // [u pole][v pole]
  const Tt = { pu: qu, pv: qv, U: Ul, V: Vl, P: Tc };
  // common space and the Boolean sum
  const du = Math.max(Lu.pu, qu), dv = Math.max(qv, Lv.pv);
  const Uc = unionKnots([elevatedKnots(Lu.pu, Lu.U, du), elevatedKnots(qu, Ul, du)], du);
  const Vc = unionKnots([elevatedKnots(qv, Vl, dv), elevatedKnots(Lv.pv, Lv.V, dv)], dv);
  const [A, B, C] = [Lu, Lv, Tt].map((s) => projectSurface(s, du, Uc, dv, Vc));
  let S = { pu: du, pv: dv, U: Uc, V: Vc, P: A.P.map((row, i) => row.map((q, j) => V.sub(V.add(q, B.P[i][j]), C.P[i][j]))) };
  // tangency to planes along boundary curves (6.)
  const tangents = [];
  for (const pl of tangent || []) {
    // a plane holding two boundary curves (a floor under both ends) may be given twice: each takes the next free one
    const r = tangentToPlane(S, pl, { u: ubar, v: vbar }, { tol, closedU: pClosed, closedV: gClosed, skip: tangents.map((x) => x.side) });
    S = r.surface;
    const curve = r.side === 'v0' ? name('p', pOrder[0]) : r.side === 'v1' ? name('p', pOrder[pOrder.length - 1]) : r.side === 'u0' ? name('g', gOrder[0]) : name('g', gOrder[gOrder.length - 1]);
    tangents.push({ side: r.side, curve, angle: r.angle });
  }
  foldCheck(S);
  // how far the surface strays from each input curve
  let dev = 0;
  const check = (c, r, iso, isU) => {
    for (let k = 0; k <= 400; k++) {
      const s = k / 400, q = isU ? evalSurface(S, s, iso) : evalSurface(S, iso, s);
      let e = V.len(V.sub(q, c.g(r(s))));
      if (e > ftol) e = distNear(c.g, q, r(Math.max(0, s - 1 / 400)), r(Math.min(1, s + 1 / 400)));
      dev = Math.max(dev, e);
    }
  };
  pc.forEach((c, i) => check(c, FP.maps[i], vbar[i], true));
  gc.forEach((c, j) => check(c, FG.maps[j], ubar[j], false));
  const report = {
    profiles: n0, guides: m0, closedU: pClosed, closedV: gClosed, gap, dev: Math.max(dev, 0), size,
    exact: !FP.approx && !FG.approx, fitErr: Math.max(FP.err, FG.err), fitTol: ftol,
    poles: [S.P.length, S.P[0].length], degree: [du, dv], tangent: tangents,
  };
  return { surface: S, report, grid, params: { u: ubar, v: vbar }, order: { profiles: pOrder, guides: gOrder } };
}

/**
 * Refuse a surface that folds over: its normal S_u × S_v, sampled up to 4 times per knot span each way, must not turn by more
 * than 90° between neighbouring samples (pairs across a corner knot — multiplicity = degree — are not compared).
 */
function foldCheck(S) {
  const ts = (U, p) => {
    const { k, m } = knotsToMults(U), out = [], per = Math.max(1, Math.min(4, Math.floor(160 / (k.length - 1))));
    for (let q = 0; q < k.length - 1; q++) for (let w = 0; w < per; w++) out.push({ t: k[q] + (k[q + 1] - k[q]) * (w + 0.5) / per, cut: w === 0 && q > 0 && m[q] >= p });
    return out;
  };
  const us = ts(S.U, S.pu), vs = ts(S.V, S.pv), h = 1e-7;
  const N = us.map(({ t: u }) => vs.map(({ t: v }) => {
    const su = V.sub(evalSurface(S, Math.min(1, u + h), v), evalSurface(S, Math.max(0, u - h), v));
    const sv = V.sub(evalSurface(S, u, Math.min(1, v + h)), evalSurface(S, u, Math.max(0, v - h)));
    return V.cross(su, sv);
  }));
  const bad = (a, b) => { const la = V.len(a), lb = V.len(b); return la > 0 && lb > 0 && V.dot(a, b) < 0; };
  for (let i = 0; i < us.length; i++) for (let j = 0; j < vs.length; j++) {
    if ((i + 1 < us.length && !us[i + 1].cut && bad(N[i][j], N[i + 1][j])) || (j + 1 < vs.length && !vs[j + 1].cut && bad(N[i][j], N[i][j + 1]))) {
      fail(tr('model.gordon.err.folds'));
    }
  }
}

const fmt = (v) => (!Number.isFinite(v) ? 'far' : v !== 0 && Math.abs(v) < 1e-3 ? v.toExponential(1) : (+v.toPrecision(3)).toString());

/** Plain text of a network report for the panel. */
export function describeGordon(r) {
  const size = r.closedU && r.closedV ? 'model.gordon.desc.size_closed_both' : r.closedU ? 'model.gordon.desc.size_closed_profiles' : r.closedV ? 'model.gordon.desc.size_closed_guides' : 'model.gordon.desc.size';
  const parts = [tr(size, { profiles: r.profiles, guides: r.guides }),
    tr('model.gordon.desc.surface', { du: r.degree[0], dv: r.degree[1], nu: r.poles[0], nv: r.poles[1] }),
    r.exact ? tr('model.gordon.desc.exact') : tr('model.gordon.desc.fitted', { d: fmt(r.fitErr) }),
    tr('model.gordon.desc.follows', { d: fmt(r.dev) })];
  if (r.gap > 1e-9) parts.push(tr('model.gordon.desc.gap', { d: fmt(r.gap) }));
  for (const x of r.tangent || []) parts.push(t('gordon.tangent', { curve: x.curve, angle: fmt(x.angle) }));   // 0.4 P11
  return parts.join('; ') + '.';
}
