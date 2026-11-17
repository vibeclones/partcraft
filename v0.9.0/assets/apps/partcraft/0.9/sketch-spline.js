/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sketch-spline.js — cubic B-spline math for sketch splines (DOM-free; plain [x, y] arrays, no sketch.js import).
 *
 * A curve is a flat B-spline  { deg, knots, poles, periodic?, n?, P?, tau? }  over [knots[deg], knots[poles.length]]:
 * evaluation is de Boor's (basis functions by Cox–de Boor, The NURBS Book A2.2/A2.3). A periodic curve also keeps
 * its n distinct poles `P` and period knots `tau` (n + 1 values), and its flat form repeats the poles round the seam.
 *
 *   fit spline      interpFit(Q, {closed, a0, a1}) — passes through Q. Parameters by chord length (as OCCT's
 *                   GeomAPI_Interpolate), cubic, a knot at every fit point. Open: ends are natural (no curvature)
 *                   unless an end angle a0 / a1 is given (unit tangent there, per unit chord length — what
 *                   GeomAPI_Interpolate::Load(T0, T1, false) takes). Closed: periodic, C2 all round.
 *   control spline  controlCurve(P, {closed, knots}) — clamped uniform (or the given clamped knots), degree
 *                   min(3, poles − 1); closed = periodic uniform cubic.
 *   occForm(c)      the same curve as OCCT wants it: distinct knots + multiplicities (+ periodic poles).
 *
 * Also: tessellation (fixed per span, or within a chord tolerance), exact signed area (Green, 3-point Gauss is
 * exact for x·y′ of a cubic), closest parameter, knot insertion (Boehm), `segment` (exact sub-curve, clamped),
 * `reverse`, curvature, and `offsetFit` (an offset approximated by a fit spline within a stated tolerance).
 */
import { t as tr } from './i18n.js';

export const DEG = 3;

// ---------------------------------------------------------------- basis functions

/** Span k with U[k] ≤ u < U[k+1] among p ≤ k ≤ m − 1 (the last non-empty span at the end). */
export function findSpan(U, p, m, u) {
  if (u >= U[m]) { let k = m - 1; while (k > p && U[k] >= U[k + 1]) k--; return k; }
  if (u <= U[p]) { let k = p; while (k < m - 1 && U[k + 1] <= u) k++; return k; }
  let lo = p, hi = m - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (U[mid] <= u) lo = mid; else hi = mid - 1; }
  return lo;
}

export function basisFuns(k, u, p, U) {
  const N = [1], left = [], right = [];
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[k + 1 - j]; right[j] = U[k + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const t = den === 0 ? 0 : N[r] / den;
      N[r] = saved + right[r + 1] * t;
      saved = left[j - r] * t;
    }
    N[j] = saved;
  }
  return N;
}

/** ders[i][j]: i-th derivative of basis function k − p + j at u (i ≤ n). */
export function dersBasisFuns(k, u, p, n, U) {
  const ndu = [[1]], left = [], right = [];
  for (let j = 1; j <= p; j++) {
    ndu[j] = [];
    left[j] = u - U[k + 1 - j]; right[j] = U[k + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const t = ndu[j][r] === 0 ? 0 : ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * t;
      saved = left[j - r] * t;
    }
    ndu[j][j] = saved;
  }
  const ders = [];
  for (let i = 0; i <= n; i++) ders.push(new Array(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    const a = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
    a[0][0] = 1;
    for (let kk = 1; kk <= n; kk++) {
      let d = 0;
      const rk = r - kk, pk = p - kk;
      if (r >= kk) { a[s2][0] = ndu[pk + 1][rk] === 0 ? 0 : a[s1][0] / ndu[pk + 1][rk]; d = a[s2][0] * ndu[rk][pk]; }
      const j1 = rk >= -1 ? 1 : -rk, j2 = r - 1 <= pk ? kk - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = ndu[pk + 1][rk + j] === 0 ? 0 : (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) { a[s2][kk] = ndu[pk + 1][r] === 0 ? 0 : -a[s1][kk - 1] / ndu[pk + 1][r]; d += a[s2][kk] * ndu[r][pk]; }
      ders[kk][r] = d;
      [s1, s2] = [s2, s1];
    }
  }
  let f = p;
  for (let kk = 1; kk <= n; kk++) { for (let j = 0; j <= p; j++) ders[kk][j] *= f; f *= p - kk; }
  return ders;
}

// ---------------------------------------------------------------- evaluation

export const domain = (c) => [c.knots[c.deg], c.knots[c.poles.length]];

export function pointAt(c, u) {
  const { deg: p, knots: U, poles: P } = c;
  const k = findSpan(U, p, P.length, u);
  const N = basisFuns(k, u, p, U);
  let x = 0, y = 0;
  for (let j = 0; j <= p; j++) { const q = P[k - p + j]; x += N[j] * q[0]; y += N[j] * q[1]; }
  return [x, y];
}

/** [C(u), C′(u), C″(u), …] up to the n-th derivative. */
export function derivsAt(c, u, n = 1) {
  const { deg: p, knots: U, poles: P } = c;
  const k = findSpan(U, p, P.length, u);
  const D = dersBasisFuns(k, u, p, Math.min(n, p), U);
  const out = [];
  for (let i = 0; i <= n; i++) {
    let x = 0, y = 0;
    if (i <= p) for (let j = 0; j <= p; j++) { const q = P[k - p + j]; x += D[i][j] * q[0]; y += D[i][j] * q[1]; }
    out.push([x, y]);
  }
  return out;
}

/** Non-empty knot spans [[u0, u1]…]. */
export function spans(c) {
  const { deg: p, knots: U, poles: P } = c, out = [];
  for (let k = p; k < P.length; k++) if (U[k + 1] > U[k]) out.push([U[k], U[k + 1]]);
  return out;
}

// ---------------------------------------------------------------- construction

/** Periodic flat form: n distinct poles P, period knots tau (n + 1), over `periods` periods. */
export function periodicCurve(P, tau, periods = 1) {
  const n = P.length, T = tau[n] - tau[0];
  const tk = (i) => { const q = Math.floor(i / n); return tau[i - q * n] + q * T; };
  const m = periods * n + DEG;
  const knots = [], poles = [];
  for (let j = 0; j <= m + DEG; j++) knots.push(tk(j - DEG));
  for (let j = 0; j < m; j++) poles.push(P[((j % n) + n) % n].slice());
  return { deg: DEG, knots, poles, periodic: true, n, P: P.map((q) => q.slice()), tau: tau.slice() };
}

export function clampedUniform(m, p) {
  const U = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let i = 1; i <= m - p - 1; i++) U.push(i);
  for (let i = 0; i <= p; i++) U.push(m - p);
  return U;
}

/** A control-point spline: open clamped (uniform or `knots`) or closed periodic uniform. */
export function controlCurve(P, { closed = false, knots = null } = {}) {
  if (closed) return periodicCurve(P, P.map((_, i) => i).concat(P.length));
  const p = Math.min(DEG, P.length - 1);
  return { deg: p, knots: knots ? knots.slice() : clampedUniform(P.length, p), poles: P.map((q) => q.slice()) };
}

/** Check a stored knot vector for an open clamped control spline of m poles; returns the whole file-reader message or null. */
export function knotProblem(U, m) {
  const p = Math.min(DEG, m - 1);
  if (!Array.isArray(U) || U.length !== m + p + 1 || !U.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9)) return tr('model.sketch_spline.knots.mismatch');
  for (let i = 1; i < U.length; i++) if (U[i] < U[i - 1]) return tr('model.sketch_spline.knots.backwards');
  for (let i = 1; i <= p; i++) if (U[i] !== U[0] || U[U.length - 1 - i] !== U[U.length - 1]) return tr('model.sketch_spline.knots.unclamped');
  if (!(U[U.length - 1] > U[0])) return tr('model.sketch_spline.knots.no_length');
  let run = 1;
  for (let i = p + 1; i < U.length - p - 1; i++) { run = U[i] === U[i - 1] ? run + 1 : 1; if (run > p) return tr('model.sketch_spline.knots.repeats'); }
  return null;
}

function chordParams(Q, closed) {
  const t = [0];
  const n = Q.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = Q[i - 1], b = Q[i % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(d > 0)) throw new Error(tr('model.sketch_spline.fit_points_coincide'));
    t.push(t[i - 1] + d);
  }
  return t;
}

/** Dense solve A·X = B (B: columns), Gaussian elimination with partial pivoting. */
function solveDense(A, B) {
  const n = A.length, M = A.map((r, i) => [...r, ...B[i]]), w = B[0].length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-300)) throw new Error(tr('model.sketch_spline.cannot_pass'));
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < n + w; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r.slice(n).map((v) => v / M[i][i]));
}

/**
 * Interpolating cubic through Q (chord-length parameters, a knot at every fit point).
 * Open: natural ends, or a unit tangent at angle a0 / a1. Closed: periodic.
 */
export function interpFit(Q, { closed = false, a0 = null, a1 = null } = {}) {
  if (closed) {
    const n = Q.length;
    if (n < 3) throw new Error(tr('model.sketch_spline.closed_three'));
    const tau = chordParams(Q, true);
    const flat = periodicCurve(Q, tau);
    const A = Q.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      const k = i + DEG, N = basisFuns(k, tau[i], DEG, flat.knots);
      for (let j = 0; j <= DEG; j++) A[i][(k - DEG + j) % n] += N[j];
    }
    const P = solveDense(A, Q.map((q) => [q[0], q[1]]));
    return periodicCurve(P, tau);
  }
  const n1 = Q.length;
  if (n1 < 2) throw new Error(tr('model.sketch_spline.open_two'));
  const t = chordParams(Q, false);
  const U = [t[0], t[0], t[0], t[0], ...t.slice(1, -1), t[n1 - 1], t[n1 - 1], t[n1 - 1], t[n1 - 1]];
  const m = n1 + 2, p = DEG;
  const A = [], B = [];
  const row = (u, d, rhs) => {
    const k = findSpan(U, p, m, u), D = dersBasisFuns(k, u, p, d, U), r = new Array(m).fill(0);
    for (let j = 0; j <= p; j++) r[k - p + j] = D[d][j];
    A.push(r); B.push(rhs);
  };
  const end = (u, ang) => (Number.isFinite(ang) ? row(u, 1, [Math.cos(ang), Math.sin(ang)]) : row(u, 2, [0, 0]));
  row(t[0], 0, Q[0].slice()); end(t[0], a0);
  for (let i = 1; i < n1 - 1; i++) row(t[i], 0, Q[i].slice());
  end(t[n1 - 1], a1); row(t[n1 - 1], 0, Q[n1 - 1].slice());
  const P = solveDense(A, B);
  P[0] = Q[0].slice(); P[m - 1] = Q[n1 - 1].slice();   // exactly through the end points (shared profile vertices)
  return { deg: p, knots: U, poles: P };
}

/** OCCT's form: distinct knots + multiplicities; periodic curves give their distinct poles and period knots. */
export function occForm(c) {
  if (c.periodic) return { poles: c.P.map((q) => q.slice()), knots: c.tau.slice(), mults: c.tau.map(() => 1), deg: c.deg, periodic: true };
  const knots = [], mults = [];
  for (const u of c.knots) { if (knots.length && u === knots[knots.length - 1]) mults[mults.length - 1]++; else { knots.push(u); mults.push(1); } }
  return { poles: c.poles.map((q) => q.slice()), knots, mults, deg: c.deg, periodic: false };
}

// ---------------------------------------------------------------- tessellation, area, closest point

/** Points along the curve, `perSpan` segments per knot span, both ends included (a periodic curve repeats its start). */
export function tessellate(c, perSpan = 16) {
  const out = [];
  for (const [u0, u1] of spans(c)) for (let i = 0; i < perSpan; i++) out.push(pointAt(c, u0 + (u1 - u0) * i / perSpan));
  out.push(pointAt(c, domain(c)[1]));
  return out;
}

/** Points with every chord within `tol` of the curve (checked at chord quarter points), ends included. */
export function tessellateTol(c, tol) {
  const out = [];
  const rec = (u0, p0, u1, p1, depth) => {
    let worst = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const q = pointAt(c, u0 + (u1 - u0) * f);
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy);
      const d = l > 0 ? Math.abs(dx * (q[1] - p0[1]) - dy * (q[0] - p0[0])) / l : Math.hypot(q[0] - p0[0], q[1] - p0[1]);
      worst = Math.max(worst, d);
    }
    if (worst <= tol || depth > 14) { out.push(p1); return; }
    const um = (u0 + u1) / 2, pm = pointAt(c, um);
    rec(u0, p0, um, pm, depth + 1); rec(um, pm, u1, p1, depth + 1);
  };
  const sp = spans(c);
  out.push(pointAt(c, sp[0][0]));
  for (const [u0, u1] of sp) for (let i = 0; i < 4; i++) { const a = u0 + (u1 - u0) * i / 4, b = u0 + (u1 - u0) * (i + 1) / 4; rec(a, pointAt(c, a), b, pointAt(c, b), 0); }
  return out;
}

const GL3 = [[-Math.sqrt(3 / 5), 5 / 9], [0, 8 / 9], [Math.sqrt(3 / 5), 5 / 9]];

/** ½∫(x y′ − y x′) du over the curve: exact for a cubic (degree-5 integrand, 3-point Gauss–Legendre). */
export function areaTerm(c) {
  let s = 0;
  for (const [u0, u1] of spans(c)) {
    const h = (u1 - u0) / 2, m = (u0 + u1) / 2;
    for (const [g, w] of GL3) { const [p, d] = derivsAt(c, m + h * g, 1); s += w * h * (p[0] * d[1] - p[1] * d[0]) / 2; }
  }
  return s;
}

/** Arc length (Gauss–Legendre, 5 points per span; not exact — a cubic's speed is not a polynomial). */
export function arcLength(c) {
  const G5 = [[0, 128 / 225], [Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3, (322 + 13 * Math.sqrt(70)) / 900], [Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3, (322 - 13 * Math.sqrt(70)) / 900]];
  let s = 0;
  for (const [u0, u1] of spans(c)) for (let i = 0; i < 8; i++) {
    const a = u0 + (u1 - u0) * i / 8, b = u0 + (u1 - u0) * (i + 1) / 8, h = (b - a) / 2, m = (a + b) / 2;
    for (const [g, w] of G5) for (const sg of g ? [-1, 1] : [1]) { const d = derivsAt(c, m + sg * h * g, 1)[1]; s += w * h * Math.hypot(d[0], d[1]); }
  }
  return s;
}

/** Parameter of the point on the curve nearest p (sampled, then Newton on (C − p)·C′ = 0). */
export function closestParam(c, p, perSpan = 12) {
  const [lo, hi] = domain(c);
  let best = lo, bd = Infinity;
  for (const [u0, u1] of spans(c)) for (let i = 0; i <= perSpan; i++) {
    const u = u0 + (u1 - u0) * i / perSpan, q = pointAt(c, u), d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bd) { bd = d; best = u; }
  }
  let u = best;
  for (let it = 0; it < 30; it++) {
    const [q, d1, d2] = derivsAt(c, u, 2);
    const r = [q[0] - p[0], q[1] - p[1]];
    const f = r[0] * d1[0] + r[1] * d1[1], df = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1];
    if (!(df > 0)) break;
    let un = u - f / df;
    if (c.periodic) { const T = hi - lo; while (un < lo) un += T; while (un > hi) un -= T; } else un = Math.max(lo, Math.min(hi, un));
    if (Math.abs(un - u) < 1e-15 * Math.max(1, Math.abs(u))) { u = un; break; }
    u = un;
  }
  return u;
}

/** Signed curvature at u (left turn positive). */
export function curvatureAt(c, u) {
  const [, d1, d2] = derivsAt(c, u, 2);
  const s = Math.hypot(d1[0], d1[1]);
  return s > 0 ? (d1[0] * d2[1] - d1[1] * d2[0]) / (s * s * s) : 0;
}

// ---------------------------------------------------------------- knot insertion, segments

/** Insert knot u once (Boehm); returns a new open flat curve. */
export function insertKnot(c, u) {
  const { deg: p, knots: U, poles: P } = c;
  const m = P.length, k = findSpan(U, p, m, u);
  const Q = [];
  for (let i = 0; i <= k - p; i++) Q.push(P[i].slice());
  for (let i = k - p + 1; i <= k; i++) {
    const a = (u - U[i]) / (U[i + p] - U[i]);
    Q.push([(1 - a) * P[i - 1][0] + a * P[i][0], (1 - a) * P[i - 1][1] + a * P[i][1]]);
  }
  for (let i = k; i < m; i++) Q.push(P[i].slice());
  const K = [...U.slice(0, k + 1), u, ...U.slice(k + 1)];
  return { deg: p, knots: K, poles: Q };
}

const multOf = (U, u) => U.filter((v) => v === u).length;

/** Insert u until it has multiplicity p (snapping to an existing knot within eps). */
function raise(c, u, eps) {
  const near = c.knots.find((v) => Math.abs(v - u) <= eps);
  if (near !== undefined) u = near;
  let cur = { deg: c.deg, knots: c.knots.slice(), poles: c.poles };
  while (multOf(cur.knots, u) < c.deg) cur = insertKnot(cur, u);
  return { c: cur, u };
}

/**
 * The exact piece of c between ua < ub, as an open clamped curve (poles, knots). For a periodic curve
 * ub may pass the end of the period (the piece runs round the seam).
 */
export function segment(c, ua, ub) {
  const [lo, hi] = domain(c);
  let src = c;
  if (c.periodic && ub > hi + 1e-12 * Math.max(1, Math.abs(hi))) src = periodicCurve(c.P, c.tau, 2);
  const eps = 1e-12 * Math.max(1, Math.abs(lo), Math.abs(hi), hi - lo);
  let r = raise(src, ua, eps); const A = r.u;
  r = raise(r.c, ub, eps); const Bu = r.u;
  const { knots: K, poles: P } = r.c, p = c.deg;
  let lastA = -1, firstB = -1;
  for (let j = 0; j < K.length; j++) { if (K[j] === A) lastA = j; if (K[j] === Bu && firstB < 0) firstB = j; }
  const i0 = lastA - p + 1, i1 = firstB + p - 1;
  const knots = [A, ...K.slice(i0, i1 + 1), Bu];
  const nP = knots.length - p - 1;
  return { deg: p, knots, poles: P.slice(i0 - 1, i0 - 1 + nP).map((q) => q.slice()) };
}

/** The same open curve run the other way. */
export function reverse(c) {
  const U = c.knots, a = U[0], b = U[U.length - 1];
  return { deg: c.deg, knots: U.map((_, j) => a + b - U[U.length - 1 - j]), poles: c.poles.slice().reverse().map((q) => q.slice()) };
}

/** Normalise an open curve's knots to start at 0 (keeps the shape; makes stored knots tidy). */
export function normalizeKnots(c) {
  const a = c.knots[0], L = c.knots[c.knots.length - 1] - a;
  const s = L > 0 ? (c.poles.length - c.deg) / L : 1;
  return { deg: c.deg, knots: c.knots.map((u) => (u - a) * s), poles: c.poles };
}

// ---------------------------------------------------------------- offset

/**
 * Offset of c by d to its left (d < 0: right), approximated by a fit spline through points on the true
 * offset, ends tangent to it. Doubles the samples until the largest gap (closest-point distance from 400+
 * points of the true offset) is within tol. → { Q, a0, a1, closed, err, curve } or throws (the bend is too
 * tight for d, or the tolerance cannot be met).
 */
export function offsetFit(c, d, tol) {
  const sp = spans(c);
  const off = (u) => {
    const [q, t] = derivsAt(c, u, 1), l = Math.hypot(t[0], t[1]);
    return [q[0] - d * t[1] / l, q[1] + d * t[0] / l];
  };
  // the tightest bend on the offset side
  for (const [u0, u1] of sp) for (let i = 0; i <= 32; i++) {
    const k = curvatureAt(c, u0 + (u1 - u0) * i / 32);
    if (k * d > 0 && Math.abs(d) >= 1 / Math.abs(k) - 1e-12) throw new Error(tr('model.sketch_spline.offset_too_big', { r: +(1 / Math.abs(k)).toFixed(3) }));
  }
  const closed = !!c.periodic;
  const truth = [];
  for (const [u0, u1] of sp) for (let i = 0; i < 40; i++) truth.push(off(u0 + (u1 - u0) * (i + 0.5) / 40));
  const angle = (u) => { const t = derivsAt(c, u, 1)[1]; return Math.atan2(t[1], t[0]); };
  const [lo, hi] = domain(c);
  for (let per = 2; per <= 64; per *= 2) {
    const Q = [];
    for (const [u0, u1] of sp) for (let i = 0; i < per; i++) Q.push(off(u0 + (u1 - u0) * i / per));
    if (!closed) Q.push(off(hi));
    const opts = closed ? { closed: true } : { a0: angle(lo), a1: angle(hi) };
    let fit;
    try { fit = interpFit(Q, opts); } catch { continue; }
    let err = 0;
    for (const p of truth) { const q = pointAt(fit, closestParam(fit, p, 6)); err = Math.max(err, Math.hypot(q[0] - p[0], q[1] - p[1])); }
    if (err <= tol) return { Q, a0: opts.a0 ?? null, a1: opts.a1 ?? null, closed, err, curve: fit };
  }
  throw new Error(tr('model.sketch_spline.offset_tolerance', { tol }));
}
