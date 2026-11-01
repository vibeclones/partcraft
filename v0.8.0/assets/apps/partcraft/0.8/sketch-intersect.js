/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sketch-intersect.js — curve–curve intersections for sketch curves (DOM-free), used by trim, extend and offset.
 *
 * A curve here is a plain object made by `curveOf(sk, e)`:
 *   line    { kind:'line', a, b }               t in [0, 1] from a to b (infinite when asked)
 *   circle  { kind:'circle', c, r }             t = angle in [0, 2π) from +x
 *   arc     { kind:'arc', c, r, a0, sweep }     t = angle past a0 in [0, sweep] (counter-clockwise; the full circle when asked)
 *   spline  { kind:'spline', bs, closed }       t = the B-spline parameter (sketch-spline.js)
 *
 * Method: line × line, line × circle and circle × circle in closed form; anything with a spline by sampling a
 * scalar function per knot span (line: signed distance to the line, a cubic; circle: distance to the centre
 * minus r), bracketing each sign change and refining by bisection + Newton to full precision; spline × spline by
 * crossing their fine polylines, then 2-D Newton on S1(u) − S2(v) = 0. Limits: a curve that only touches another
 * (tangent, no crossing) is found in closed form for lines and circles, and for splines only when the sampled
 * distance dips below 1e-9 of the size; overlapping (collinear / concentric equal) curves have no crossing points.
 */
import * as SP from './sketch-spline.js';
import * as S from './sketch.js';

const TAU = 2 * Math.PI;

/** A sketch entity as an intersectable curve (points → null). */
export function curveOf(sk, e) {
  const pt = (id) => S.pointXY(sk, id);
  if (e.type === 'line') return { kind: 'line', id: e.id, a: pt(e.p1), b: pt(e.p2) };
  if (e.type === 'circle') return { kind: 'circle', id: e.id, c: pt(e.c), r: e.r };
  if (e.type === 'arc') { const { c, r, a0, sweep } = S.arcAngles(sk, e); return { kind: 'arc', id: e.id, c, r, a0, sweep }; }
  if (e.type === 'spline') return { kind: 'spline', id: e.id, bs: S.splineCurve(sk, e), closed: !!e.closed };
  return null;
}

export const normAng = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

/** Point at parameter t. */
export function pointOn(cv, t) {
  if (cv.kind === 'line') return [cv.a[0] + (cv.b[0] - cv.a[0]) * t, cv.a[1] + (cv.b[1] - cv.a[1]) * t];
  if (cv.kind === 'circle') return [cv.c[0] + cv.r * Math.cos(t), cv.c[1] + cv.r * Math.sin(t)];
  if (cv.kind === 'arc') return [cv.c[0] + cv.r * Math.cos(cv.a0 + t), cv.c[1] + cv.r * Math.sin(cv.a0 + t)];
  return SP.pointAt(cv.bs, t);
}

/** Unit tangent at t, along the parameter. */
export function tangentOn(cv, t) {
  let d;
  if (cv.kind === 'line') d = [cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]];
  else if (cv.kind === 'circle') d = [-Math.sin(t), Math.cos(t)];
  else if (cv.kind === 'arc') d = [-Math.sin(cv.a0 + t), Math.cos(cv.a0 + t)];
  else d = SP.derivsAt(cv.bs, t, 1)[1];
  const l = Math.hypot(d[0], d[1]) || 1e-300;
  return [d[0] / l, d[1] / l];
}

/** Parameter range [t0, t1] and whether it wraps. */
export function rangeOf(cv) {
  if (cv.kind === 'line') return { lo: 0, hi: 1, periodic: false };
  if (cv.kind === 'circle') return { lo: 0, hi: TAU, periodic: true };
  if (cv.kind === 'arc') return { lo: 0, hi: cv.sweep, periodic: false };
  const [lo, hi] = SP.domain(cv.bs);
  return { lo, hi, periodic: cv.closed };
}

/** Parameter of the nearest point (lines unclamped; arcs: angle past a0 in [0, 2π)). */
export function paramOf(cv, p) {
  if (cv.kind === 'line') {
    const dx = cv.b[0] - cv.a[0], dy = cv.b[1] - cv.a[1];
    return ((p[0] - cv.a[0]) * dx + (p[1] - cv.a[1]) * dy) / (dx * dx + dy * dy || 1e-300);
  }
  if (cv.kind === 'circle') return normAng(Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]));
  if (cv.kind === 'arc') return normAng(Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]) - cv.a0);
  return SP.closestParam(cv.bs, p);
}

/** Size of a curve (for tolerances). */
export function sizeOf(cv) {
  if (cv.kind === 'line') return Math.max(Math.abs(cv.a[0]), Math.abs(cv.a[1]), Math.abs(cv.b[0]), Math.abs(cv.b[1]), Math.hypot(cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]));
  if (cv.kind === 'circle' || cv.kind === 'arc') return Math.abs(cv.c[0]) + Math.abs(cv.c[1]) + cv.r;
  return Math.max(...cv.bs.poles.map((q) => Math.abs(q[0]) + Math.abs(q[1])));
}

// ---------------------------------------------------------------- closed forms (unbounded)

function lineLine(A, B) {
  const d1 = [A.b[0] - A.a[0], A.b[1] - A.a[1]], d2 = [B.b[0] - B.a[0], B.b[1] - B.a[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) <= 1e-14 * Math.hypot(...d1) * Math.hypot(...d2)) return [];
  const w = [B.a[0] - A.a[0], B.a[1] - A.a[1]];
  const ta = (w[0] * d2[1] - w[1] * d2[0]) / den, tb = (w[0] * d1[1] - w[1] * d1[0]) / den;
  return [{ ta, tb }];
}

/** Line a + t·d against a circle (c, r): parameters t. */
function lineCircleT(a, b, c, r) {
  const d = [b[0] - a[0], b[1] - a[1]], f = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1], Bq = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - r * r;
  const disc = Bq * Bq - 4 * A * C;
  const scale = Bq * Bq + Math.abs(4 * A * C);
  if (disc < -1e-12 * scale) return [];
  if (disc <= 1e-12 * scale) return [-Bq / (2 * A)];
  const s = Math.sqrt(disc);
  // stable roots
  const q = -0.5 * (Bq + Math.sign(Bq || 1) * s);
  const t1 = q / A, t2 = C / q;
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

function circleCircleP(c1, r1, c2, r2) {
  const dx = c2[0] - c1[0], dy = c2[1] - c1[1], d = Math.hypot(dx, dy);
  if (d <= 1e-14 * (r1 + r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const m = [c1[0] + a * dx / d, c1[1] + a * dy / d];
  if (h2 < -1e-12 * r1 * r1) return [];
  if (h2 <= 1e-12 * r1 * r1) return [m];
  const h = Math.sqrt(h2);
  return [[m[0] - h * dy / d, m[1] + h * dx / d], [m[0] + h * dy / d, m[1] - h * dx / d]];
}

// ---------------------------------------------------------------- spline root finding

/** Roots of f on [lo, hi] by sampling n steps, bisection on sign changes, Newton polish (numeric f′). */
function roots1(f, lo, hi, n, tolF) {
  const out = [];
  let u0 = lo, f0 = f(lo);
  if (Math.abs(f0) <= tolF * 1e-3) out.push(lo);
  let fPrev = null;
  for (let i = 1; i <= n; i++) {
    const u1 = lo + (hi - lo) * i / n, f1 = f(u1);
    if (f1 === 0) out.push(u1);
    else if (f0 !== 0 && (f0 < 0) !== (f1 < 0)) {
      let a = u0, b = u1, fa = f0;
      for (let it = 0; it < 200 && b - a > 1e-16 * Math.max(1, Math.abs(a)); it++) {
        const m = (a + b) / 2, fm = f(m);
        if (fm === 0) { a = b = m; break; }
        if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m;
      }
      out.push((a + b) / 2);
    } else if (fPrev !== null && Math.abs(f0) < Math.abs(fPrev) && Math.abs(f0) < Math.abs(f1) && Math.abs(f0) <= tolF) {
      // a touch: |f| has a local minimum near zero between samples — refine the minimum (golden section)
      let a = lo + (hi - lo) * (i - 2) / n, b = u1;
      for (let it = 0; it < 100; it++) {
        const m1 = b - (b - a) * 0.618, m2 = a + (b - a) * 0.618;
        if (Math.abs(f(m1)) < Math.abs(f(m2))) b = m2; else a = m1;
      }
      const m = (a + b) / 2;
      if (Math.abs(f(m)) <= tolF * 1e-3) out.push(m);
    }
    fPrev = f0; u0 = u1; f0 = f1;
  }
  return out;
}

function splineVsImplicit(cv, F, tolF) {
  const out = [];
  for (const [u0, u1] of SP.spans(cv.bs)) for (const u of roots1((u) => F(SP.pointAt(cv.bs, u)), u0, u1, 24, tolF)) out.push(u);
  return out;
}

function splineSpline(A, B, scale) {
  const sample = (cv) => {
    const pts = [];
    for (const [u0, u1] of SP.spans(cv.bs)) for (let i = 0; i < 48; i++) { const u = u0 + (u1 - u0) * i / 48; pts.push({ u, p: SP.pointAt(cv.bs, u) }); }
    const [, hi] = SP.domain(cv.bs);
    pts.push({ u: hi, p: SP.pointAt(cv.bs, hi) });
    return pts;
  };
  const pa = sample(A), pb = sample(B), out = [];
  for (let i = 0; i + 1 < pa.length; i++) {
    const a0 = pa[i].p, a1 = pa[i + 1].p;
    const ax0 = Math.min(a0[0], a1[0]), ax1 = Math.max(a0[0], a1[0]), ay0 = Math.min(a0[1], a1[1]), ay1 = Math.max(a0[1], a1[1]);
    for (let j = 0; j + 1 < pb.length; j++) {
      const b0 = pb[j].p, b1 = pb[j + 1].p;
      if (Math.max(b0[0], b1[0]) < ax0 || Math.min(b0[0], b1[0]) > ax1 || Math.max(b0[1], b1[1]) < ay0 || Math.min(b0[1], b1[1]) > ay1) continue;
      const x = lineLine({ a: a0, b: a1 }, { a: b0, b: b1 })[0];
      if (!x || x.ta < -0.01 || x.ta > 1.01 || x.tb < -0.01 || x.tb > 1.01) continue;
      let u = pa[i].u + (pa[i + 1].u - pa[i].u) * x.ta, v = pb[j].u + (pb[j + 1].u - pb[j].u) * x.tb;
      const [la, ha] = SP.domain(A.bs), [lb, hb] = SP.domain(B.bs);
      for (let it = 0; it < 40; it++) {
        const [p, dp] = SP.derivsAt(A.bs, u, 1), [q, dq] = SP.derivsAt(B.bs, v, 1);
        const r = [p[0] - q[0], p[1] - q[1]];
        const det = -dp[0] * dq[1] + dp[1] * dq[0];
        if (!det) break;
        const du = (-r[0] * -dq[1] + r[1] * -dq[0]) / det, dv = (dp[0] * -r[1] - dp[1] * -r[0]) / det;
        u = Math.max(la, Math.min(ha, u + du)); v = Math.max(lb, Math.min(hb, v + dv));
        if (Math.abs(du) + Math.abs(dv) < 1e-15 * Math.max(1, Math.abs(u) + Math.abs(v))) break;
      }
      const p = SP.pointAt(A.bs, u), q = SP.pointAt(B.bs, v);
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1e-9 * scale) out.push({ ta: u, tb: v });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the general case

const round = (cv) => cv.kind === 'circle' || cv.kind === 'arc';

/** Is parameter t on the curve (bounded), allowing eps in length units? Returns the parameter snapped into range, or null. */
function within(cv, t, epsLen) {
  if (cv.kind === 'line') {
    const L = Math.hypot(cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]) || 1e-300, e = epsLen / L;
    return t >= -e && t <= 1 + e ? Math.max(0, Math.min(1, t)) : null;
  }
  if (cv.kind === 'circle') return normAng(t);
  if (cv.kind === 'arc') {
    const e = epsLen / cv.r, a = normAng(t);
    if (a <= cv.sweep + e) return Math.min(a, cv.sweep);
    if (TAU - a <= e) return 0;
    return null;
  }
  return t;
}

/**
 * Crossing points of curves A and B → [{ p, ta, tb }] (sorted along A). `infA` / `infB`: a line is
 * infinite, an arc its full circle (parameters then run outside [0, 1] / past the sweep, angles in [0, 2π)).
 */
export function intersect(A, B, { infA = false, infB = false } = {}) {
  if (A.kind === 'spline' && B.kind !== 'spline') return intersect(B, A, { infA: infB, infB: infA }).map((x) => ({ p: x.p, ta: x.tb, tb: x.ta })).sort((x, y) => x.ta - y.ta);
  const scale = Math.max(1, sizeOf(A), sizeOf(B));
  const eps = 1e-9 * scale;
  let raw = [];   // {ta, tb} unbounded
  if (A.kind === 'line' && B.kind === 'line') raw = lineLine(A, B);
  else if (A.kind === 'line' && round(B)) raw = lineCircleT(A.a, A.b, B.c, B.r).map((t) => { const p = pointOn(A, t); return { ta: t, tb: paramOf(B, p) }; });
  else if (round(A) && B.kind === 'line') raw = lineCircleT(B.a, B.b, A.c, A.r).map((t) => { const p = pointOn(B, t); return { ta: paramOf(A, p), tb: t }; });
  else if (round(A) && round(B)) raw = circleCircleP(A.c, A.r, B.c, B.r).map((p) => ({ ta: paramOf(A, p), tb: paramOf(B, p) }));
  else if (B.kind === 'spline' && A.kind === 'line') {
    const d = [A.b[0] - A.a[0], A.b[1] - A.a[1]], l = Math.hypot(...d) || 1e-300;
    raw = splineVsImplicit(B, (q) => (d[0] * (q[1] - A.a[1]) - d[1] * (q[0] - A.a[0])) / l, eps).map((u) => ({ ta: paramOf(A, SP.pointAt(B.bs, u)), tb: u }));
  } else if (B.kind === 'spline' && round(A)) {
    raw = splineVsImplicit(B, (q) => Math.hypot(q[0] - A.c[0], q[1] - A.c[1]) - A.r, eps).map((u) => ({ ta: paramOf(A, SP.pointAt(B.bs, u)), tb: u }));
  } else raw = splineSpline(A, B, scale);
  const out = [];
  for (const x of raw) {
    const ta = infA ? (A.kind === 'arc' ? normAng(x.ta) : x.ta) : within(A, x.ta, eps);
    const tb = infB ? (B.kind === 'arc' ? normAng(x.tb) : x.tb) : within(B, x.tb, eps);
    if (ta === null || tb === null) continue;
    const p = pointOn(A, ta);
    if (out.some((y) => Math.hypot(y.p[0] - p[0], y.p[1] - p[1]) <= 10 * eps)) continue;
    out.push({ p, ta, tb });
  }
  return out.sort((x, y) => x.ta - y.ta);
}
