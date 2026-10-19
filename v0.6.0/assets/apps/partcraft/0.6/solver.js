/* SPDX-License-Identifier: Apache-2.0 */
/**
 * solver.js — numerical solver and constraint analysis for sketch.js sketches (DOM-free).
 *
 * Variables: every point's x, y, every circle's radius and a fit spline's end angles a0 / a1 where it has
 * them (a tangent relation at that end sets one; the origin is a constant).
 * Solve: damped Newton with the least-norm step  dx = Jᵀ (J Jᵀ + μI)⁻¹ (−r)  plus a halving line
 * search and Levenberg–Marquardt style growth of μ when a step does not help. The least-norm
 * step moves the sketch as little as possible, so it stays near where it was.
 * Jacobian rows are central differences over each equation's own variables (sparse).
 *
 * Analysis (at the solved geometry): Gram–Schmidt over the rows in the order the relations
 * were made → rank, redundant relations (rows already implied by earlier ones), degrees of
 * freedom = variables − rank. A variable is determined when its unit vector lies in the row
 * space (Σ q_k² = 1 over the orthonormal basis), so each entity can be coloured under- or
 * fully defined. Relations still not met after solving are conflicts.
 *
 *   solveSketch(sk, { pin: Map(pointId → [x, y]), pinRadius: Map(circleId → r) })
 *     → { ok, status: 'empty'|'under'|'full'|'over', dof, conflicts: [cid], redundant: [cid],
 *         determined: Set(entityId), iterations }
 */
import { equations, pointsOf, extent, ORIGIN } from './sketch.js';

function buildVars(sk, pinned = new Set()) {
  const vars = new Map();
  const x = [];
  for (const e of sk.entities) {
    if (e.type === 'point' && !pinned.has(e.id)) { vars.set(e.id, [x.length, x.length + 1]); x.push(e.x, e.y); }
  }
  for (const e of sk.entities) {
    if (e.type === 'circle' && !pinned.has(e.id)) { vars.set(e.id, x.length); x.push(e.r); }
    if (e.type === 'spline') for (const k of ['a0', 'a1']) if (Number.isFinite(e[k])) { vars.set(e.id + ':' + k, x.length); x.push(e[k]); }
  }
  return { vars, x };
}

function writeBack(sk, vars, x) {
  for (const e of sk.entities) {
    const v = vars.get(e.id);
    if (v === undefined) continue;
    if (e.type === 'point') { e.x = x[v[0]]; e.y = x[v[1]]; } else if (e.type === 'circle') e.r = x[v];
  }
  for (const e of sk.entities) {
    if (e.type !== 'spline') continue;
    for (const k of ['a0', 'a1']) { const v = vars.get(e.id + ':' + k); if (v !== undefined) e[k] = Math.atan2(Math.sin(x[v]), Math.cos(x[v])); }
  }
}

function residuals(eqs) { return eqs.map((q) => q.f()); }
const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);

/** Sparse Jacobian rows: [Map(varIndex → ∂f/∂x)] */
function jacobian(eqs, x) {
  return eqs.map((q) => {
    const row = new Map();
    for (const k of q.deps) {
      if (row.has(k)) continue;
      const x0 = x[k], h = 1e-6 * Math.max(1, Math.abs(x0));
      x[k] = x0 + h; const fp = q.f();
      x[k] = x0 - h; const fm = q.f();
      x[k] = x0;
      const d = (fp - fm) / (2 * h);
      if (d !== 0) row.set(k, d);
    }
    return row;
  });
}

function sparseDot(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [k, v] of a) { const w = b.get(k); if (w !== undefined) s += v * w; }
  return s;
}

/** Solve the symmetric positive (semi)definite m×m system by Cholesky; null if it breaks down. */
function cholSolve(A, b) {
  const n = b.length;
  const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (!(s > 0)) return null;
    const d = Math.sqrt(s);
    L[j][j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / d;
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const z = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * z[k]; z[i] = s / L[i][i]; }
  return z;
}

function newton(eqs, x, tol, maxIter = 100) {
  let r = residuals(eqs);
  let f = norm2(r);
  let mu = 1e-12;
  let it = 0;
  for (; it < maxIter; it++) {
    if (r.every((v) => Math.abs(v) <= tol)) return { ok: true, it };
    const J = jacobian(eqs, x);
    const m = J.length;
    const A = [];
    let scale = 0;
    for (let i = 0; i < m; i++) {
      A.push(new Array(m));
      for (let j = 0; j <= i; j++) { const v = sparseDot(J[i], J[j]); A[i][j] = v; if (j < i) A[j][i] = v; }
      scale = Math.max(scale, A[i][i]);
    }
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const B = A.map((row, i) => row.map((v, j) => (i === j ? v + mu * Math.max(scale, 1e-12) + 1e-300 : v)));
      const y = cholSolve(B, r.map((v) => -v));
      if (!y) { mu *= 100; continue; }
      const dx = new Array(x.length).fill(0);
      J.forEach((row, i) => { for (const [k, v] of row) dx[k] += v * y[i]; });
      const x0 = x.slice();
      let alpha = 1;
      for (let ls = 0; ls < 20; ls++) {
        for (let k = 0; k < x.length; k++) x[k] = x0[k] + alpha * dx[k];
        const r2 = residuals(eqs), f2 = norm2(r2);
        if (f2 < f) { r = r2; f = f2; improved = true; break; }
        alpha /= 2;
      }
      if (!improved) { for (let k = 0; k < x.length; k++) x[k] = x0[k]; mu *= 100; if (mu > 1e6) break; }
      else mu = Math.max(1e-12, mu / 10);
    }
    if (!improved) return { ok: r.every((v) => Math.abs(v) <= tol), it };
  }
  return { ok: r.every((v) => Math.abs(v) <= tol), it };
}

/** Rank / redundancy / determined variables at the current geometry. */
export function analyze(sk, tolScale) {
  const { vars, x } = buildVars(sk);
  const eqs = equations(sk, x, vars);
  const tol = 1e-8 * (tolScale ?? Math.max(1, extent(sk)));
  const J = jacobian(eqs, x);
  const n = x.length;
  const Q = [];
  const redundant = new Set();
  const conflicts = new Set();
  eqs.forEach((q, i) => {
    const r = q.f();
    if (Math.abs(r) > tol * 100) conflicts.add(q.cid);
    const v = new Float64Array(n);
    let vn = 0;
    for (const [k, d] of J[i]) { v[k] = d; vn += d * d; }
    vn = Math.sqrt(vn);
    if (vn < 1e-12) { redundant.add(q.cid); return; }
    for (let k = 0; k < n; k++) v[k] /= vn;
    for (let pass = 0; pass < 2; pass++) {
      for (const b of Q) {
        let d = 0;
        for (let k = 0; k < n; k++) d += b[k] * v[k];
        if (d !== 0) for (let k = 0; k < n; k++) v[k] -= d * b[k];
      }
    }
    let wn = 0;
    for (let k = 0; k < n; k++) wn += v[k] * v[k];
    wn = Math.sqrt(wn);
    if (wn < 1e-7) { redundant.add(q.cid); return; }
    for (let k = 0; k < n; k++) v[k] /= wn;
    Q.push(v);
  });
  const fixedVar = new Array(n).fill(0);
  for (const b of Q) for (let k = 0; k < n; k++) fixedVar[k] += b[k] * b[k];
  const det = (k) => fixedVar[k] > 1 - 1e-6;
  const determined = new Set([ORIGIN]);
  const ptDet = (id) => id === ORIGIN || (vars.has(id) && vars.get(id).every(det));
  for (const e of sk.entities) {
    let ok = pointsOf(e).every(ptDet);
    if (e.type === 'circle') ok = ok && det(vars.get(e.id));
    if (e.type === 'spline') for (const k of [':a0', ':a1']) if (vars.has(e.id + k)) ok = ok && det(vars.get(e.id + k));
    if (ok) determined.add(e.id);
  }
  const strip = (s) => [...s].filter((c) => !c.startsWith('arc:'));
  return { dof: n - Q.length, rank: Q.length, vars: n, redundant: strip(redundant), conflicts: strip(conflicts), determined };
}

/**
 * Solve the sketch in place. Pinned points/radii are held at the given values (dragging);
 * when that cannot be met the drag is dropped and the sketch solved where it was. When the
 * relations cannot all be met the geometry is left exactly as it was and the conflicts named.
 */
export function solveSketch(sk, { pin = null, pinRadius = null } = {}) {
  const snap = sk.entities.map((e) => (e.type === 'point' ? [e.x, e.y] : e.type === 'circle' ? e.r : e.type === 'spline' ? [e.a0, e.a1] : null));
  const restore = () => sk.entities.forEach((e, i) => {
    if (e.type === 'point') { e.x = snap[i][0]; e.y = snap[i][1]; } else if (e.type === 'circle') e.r = snap[i];
    else if (e.type === 'spline') for (const [j, k] of [[0, 'a0'], [1, 'a1']]) if (snap[i][j] !== undefined) e[k] = snap[i][j];
  });
  const tolScale = Math.max(1, extent(sk));
  const tol = 1e-9 * tolScale;
  let res = { ok: false, it: 0 };
  let pinnedOk = false;
  if ((pin && pin.size) || (pinRadius && pinRadius.size)) {
    const pinned = new Set([...(pin?.keys() || []), ...(pinRadius?.keys() || [])]);
    for (const e of sk.entities) {
      if (pin?.has(e.id)) { [e.x, e.y] = pin.get(e.id); }
      if (pinRadius?.has(e.id)) e.r = Math.max(1e-9, pinRadius.get(e.id));
    }
    const { vars, x } = buildVars(sk, pinned);
    res = newton(equations(sk, x, vars), x, tol, 60);
    if (res.ok) { writeBack(sk, vars, x); pinnedOk = true; } else restore();
  }
  if (!pinnedOk) {
    const { vars, x } = buildVars(sk);
    res = newton(equations(sk, x, vars), x, tol, 100);
    if (res.ok) writeBack(sk, vars, x); else restore();
  }
  const a = analyze(sk, tolScale);
  const geometry = sk.entities.some((e) => e.type !== 'point') || sk.entities.length > 0;
  let status = !geometry ? 'empty' : a.conflicts.length || a.redundant.length ? 'over' : a.dof === 0 ? 'full' : 'under';
  return { ok: res.ok, dragged: pinnedOk, status, dof: a.dof, conflicts: a.conflicts, redundant: a.redundant, determined: a.determined, iterations: res.it };
}
