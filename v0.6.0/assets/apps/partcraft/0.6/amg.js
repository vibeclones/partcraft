/* SPDX-License-Identifier: Apache-2.0 */
/**
 * amg.js — smoothed-aggregation algebraic multigrid (Vaněk, Mandel & Brezina 1996) as a preconditioner for SPD systems
 * from elasticity (DOM-free). Used by tetfea.js on the T10 stiffness.
 *
 * Setup per level: strength of connection between dof groups (nodes) by the Frobenius norm of their block,
 * ‖A_IJ‖² > θ²‖A_II‖‖A_JJ‖ (θ 0.08); greedy aggregation (a root with its free strong neighbours, then leftovers join a
 * strongly connected aggregate, then new aggregates); the tentative prolongator from the near-null space B (the six rigid
 * motions on level 0, projected onto the constraints) by a QR per aggregate (columns that vanish dropped, so the
 * coarse groups have ≤ 6 dofs); prolongator smoothing P = (I − ω D⁻¹A) P̂, ω = 4/(3 λmax(D⁻¹A)) (power iterations);
 * Galerkin A_c = Pᵀ A P (Gustavson sparse products); the prolongator is smoothed on the finest level only (coarser
 * levels use the tentative one, which keeps them sparse). Down to ≤ 600 dofs, solved by dense Cholesky.
 * Cycle: a V-cycle, one symmetric Gauss–Seidel sweep before (forward) and after (backward), so it is a symmetric
 * positive definite preconditioner for conjugate gradients.
 * CSR here is full (both triangles): { n, ptr, col, val }, columns sorted.
 * One thread: the round-5 threaded V-cycle was removed in 0.4 (P4; measurements in pool.js, "tets: one thread").
 */

/** Lower-triangle CSR (diagonal last in each row) → full CSR. */
export function fullFromLower(N, rp, col, val) {
  const cnt = new Int32Array(N + 1);
  for (let r = 0; r < N; r++) { cnt[r + 1] += rp[r + 1] - rp[r]; for (let k = rp[r]; k < rp[r + 1] - 1; k++) cnt[col[k] + 1]++; }
  for (let r = 0; r < N; r++) cnt[r + 1] += cnt[r];
  const ptr = Int32Array.from(cnt), fill = cnt.slice(0, N), C = new Int32Array(ptr[N]), V = new Float64Array(ptr[N]);
  // rows in column order: upper entries (from the transposes, columns < r come first) then the row's own lower part
  for (let r = 0; r < N; r++) for (let k = rp[r]; k < rp[r + 1]; k++) { const c = col[k]; C[fill[r]] = c; V[fill[r]++] = val[k]; if (c !== r) { C[fill[c]] = r; V[fill[c]++] = val[k]; } }
  // sort each row by column
  for (let r = 0; r < N; r++) sortRow(C, V, ptr[r], ptr[r + 1]);
  return { n: N, ptr, col: C, val: V };
}
function sortRow(C, V, a, b) {
  for (let i = a + 1; i < b; i++) { const c = C[i], v = V[i]; let j = i - 1; while (j >= a && C[j] > c) { C[j + 1] = C[j]; V[j + 1] = V[j]; j--; } C[j + 1] = c; V[j + 1] = v; }
}
class Grow {
  constructor(n = 1 << 16) { this.c = new Int32Array(n); this.v = new Float64Array(n); this.n = 0; }
  push(c, v) { if (this.n === this.c.length) { const c2 = new Int32Array(this.n * 2), v2 = new Float64Array(this.n * 2); c2.set(this.c); v2.set(this.v); this.c = c2; this.v = v2; } this.c[this.n] = c; this.v[this.n++] = v; }
}
/** C = A·B (CSR, B with ncols columns) */
export function spgemm(A, B, ncols) {
  const ptr = new Int32Array(A.n + 1), mark = new Int32Array(ncols).fill(-1), acc = new Float64Array(ncols), g = new Grow(A.col.length * 2);
  const list = new Int32Array(ncols);
  for (let i = 0; i < A.n; i++) {
    let m = 0;
    for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) {
      const a = A.val[k], r = A.col[k];
      for (let q = B.ptr[r]; q < B.ptr[r + 1]; q++) { const j = B.col[q]; if (mark[j] !== i) { mark[j] = i; acc[j] = 0; list[m++] = j; } acc[j] += a * B.val[q]; }
    }
    const l = list.subarray(0, m).sort();
    for (let t = 0; t < m; t++) g.push(l[t], acc[l[t]]);
    ptr[i + 1] = g.n;
  }
  return { n: A.n, ptr, col: g.c.slice(0, g.n), val: g.v.slice(0, g.n) };
}
/** Transpose of an n × ncols CSR → ncols × n */
export function transpose(A, ncols) {
  const ptr = new Int32Array(ncols + 1);
  for (let k = 0; k < A.col.length; k++) ptr[A.col[k] + 1]++;
  for (let c = 0; c < ncols; c++) ptr[c + 1] += ptr[c];
  const fill = ptr.slice(0, ncols), col = new Int32Array(A.col.length), val = new Float64Array(A.col.length);
  for (let r = 0; r < A.n; r++) for (let k = A.ptr[r]; k < A.ptr[r + 1]; k++) { const c = A.col[k], p = fill[c]++; col[p] = r; val[p] = A.val[k]; }
  return { n: ncols, ptr, col, val };
}
/** One Gauss–Seidel sweep on full CSR M (diagonal diag): forward (rows up) or backward (rows down); x updated in place.
 *  The smoother of the V-cycle (with csrMul, the only kernels the cycle runs besides the coarse Cholesky). */
export function gaussSeidel(M, diag, b, x, forward) {
  const nn = M.n;
  if (forward) for (let r = 0; r < nn; r++) { let s = b[r]; for (let k = M.ptr[r]; k < M.ptr[r + 1]; k++) { const c = M.col[k]; if (c !== r) s -= M.val[k] * x[c]; } x[r] = diag[r] ? s / diag[r] : 0; }
  else for (let r = nn - 1; r >= 0; r--) { let s = b[r]; for (let k = M.ptr[r]; k < M.ptr[r + 1]; k++) { const c = M.col[k]; if (c !== r) s -= M.val[k] * x[c]; } x[r] = diag[r] ? s / diag[r] : 0; }
  return x;
}
/** y = A x (full CSR). */
export function csrMul(A, x, y) {
  for (let r = 0; r < A.n; r++) { let s = 0; for (let k = A.ptr[r]; k < A.ptr[r + 1]; k++) s += A.val[k] * x[A.col[k]]; y[r] = s; }
  return y;
}

/**
 * Build the hierarchy. A full CSR (SPD), groups: Int32Array of group start offsets (dofs of a node are contiguous),
 * B: array of nb Float64Array(n) near-null vectors. → { apply(r, z), levels: [{n, nnz}], ms }
 */
export function buildAMG(A, groups, B, { theta = 0.08, coarse = 600, maxLevels = 12, merge = [0], smooth = [true, false] } = {}) {
  const t0 = Date.now(), levels = [];
  let cur = A, grp = groups, Bc = B;
  while (true) {
    const lev = { A: cur, n: cur.n };
    lev.diag = new Float64Array(cur.n);
    for (let r = 0; r < cur.n; r++) for (let k = cur.ptr[r]; k < cur.ptr[r + 1]; k++) if (cur.col[k] === r) lev.diag[r] = cur.val[k];
    levels.push(lev);
    if (cur.n <= coarse || levels.length >= maxLevels) break;
    const ng = grp.length - 1, gof = new Int32Array(cur.n);
    for (let g = 0; g < ng; g++) for (let d = grp[g]; d < grp[g + 1]; d++) gof[d] = g;
    // group strength graph
    const gd = new Float64Array(ng), nbr = Array.from({ length: ng }, () => []);
    const acc = new Float64Array(ng), mark = new Int32Array(ng).fill(-1), lst = [];
    for (let g = 0; g < ng; g++) {
      lst.length = 0;
      for (let r = grp[g]; r < grp[g + 1]; r++) for (let k = cur.ptr[r]; k < cur.ptr[r + 1]; k++) { const h = gof[cur.col[k]]; if (mark[h] !== g) { mark[h] = g; acc[h] = 0; lst.push(h); } acc[h] += cur.val[k] * cur.val[k]; }
      for (const h of lst) { if (h === g) gd[g] = Math.sqrt(acc[h]); else nbr[g].push(h, Math.sqrt(acc[h])); }
    }
    const strong = nbr.map((l, g) => { const out = []; for (let i = 0; i < l.length; i += 2) if (l[i + 1] > theta * Math.sqrt(gd[g] * gd[l[i]])) out.push(l[i]); return out; });
    let { agg, na } = aggregate(ng, strong, nbr);
    // merging passes: aggregate the aggregates (larger aggregates, sparser coarse levels)
    for (let mp = 0; mp < (merge[levels.length - 1] ?? 0); mp++) {
      const sa = Array.from({ length: na }, () => new Set());
      for (let g = 0; g < ng; g++) for (const h of strong[g]) if (agg[h] !== agg[g]) sa[agg[g]].add(agg[h]);
      const s2 = sa.map((x) => [...x]), n2 = s2.map((l) => l.flatMap((h) => [h, 1]));
      const r = aggregate(na, s2, n2);
      for (let g = 0; g < ng; g++) agg[g] = r.agg[agg[g]];
      na = r.na;
    }
    if (na >= ng) break;   // no coarsening possible
    // tentative prolongator: QR of B restricted to each aggregate
    const members = Array.from({ length: na }, () => []);
    for (let g = 0; g < ng; g++) members[agg[g]].push(g);
    const nb = Bc.length, rowsP = Array.from({ length: cur.n }, () => []), newB = [], cgrp = [0];
    let nc = 0;
    for (let a = 0; a < na; a++) {
      const dofs = []; for (const g of members[a]) for (let d = grp[g]; d < grp[g + 1]; d++) dofs.push(d);
      const m = dofs.length, Q = Bc.map((b) => Float64Array.from(dofs, (d) => b[d])), R = [];
      let scale = 0; for (const q of Q) for (const v of q) scale = Math.max(scale, Math.abs(v));
      const kept = [];
      for (let j = 0; j < nb; j++) {
        const q = Q[j], r = new Float64Array(nb);
        for (let t = 0; t < 2; t++) for (const i of kept) { let s = 0; for (let k = 0; k < m; k++) s += Q[i][k] * q[k]; r[i] += s; for (let k = 0; k < m; k++) q[k] -= s * Q[i][k]; }
        let l = 0; for (let k = 0; k < m; k++) l += q[k] * q[k]; l = Math.sqrt(l);
        if (l > 1e-10 * Math.max(scale, 1e-300) * Math.sqrt(m)) { for (let k = 0; k < m; k++) q[k] /= l; r[j] = l; kept.push(j); }
        R.push(r);
      }
      // coarse dofs = kept columns; B_c rows = R rows of the kept columns (R[j][i] = component of B_j on q_i)
      kept.forEach((i, ci) => { const c = nc + ci; dofs.forEach((d, k) => { if (Q[i][k] !== 0) rowsP[d].push(c, Q[i][k]); }); });
      for (const i of kept) { const row = new Float64Array(nb); for (let j = 0; j < nb; j++) row[j] = R[j][i]; newB.push(row); }
      nc += kept.length; cgrp.push(nc);
    }
    if (!nc) break;
    const Pt = csrFromRows(rowsP);
    // smoothing: P = (I − ω D⁻¹ A) P̂
    let P = Pt;
    if (smooth[levels.length - 1] ?? smooth[smooth.length - 1]) {
      const lam = powerMax(cur, lev.diag), w = 4 / (3 * lam);
      const AP = spgemm(cur, Pt, nc);
      for (let r = 0; r < cur.n; r++) { const s = lev.diag[r] > 0 ? w / lev.diag[r] : 0; for (let k = AP.ptr[r]; k < AP.ptr[r + 1]; k++) AP.val[k] *= -s; }
      P = addCsr(Pt, AP);
    }
    const PT = transpose(P, nc);
    lev.P = P; lev.PT = PT;
    cur = spgemm(PT, spgemm(cur, P, nc), nc);
    grp = Int32Array.from(cgrp);
    Bc = Array.from({ length: nb }, (_, j) => Float64Array.from(newB, (row) => row[j]));
  }
  // coarsest: dense Cholesky (with a tiny shift if singular)
  const last = levels[levels.length - 1], n = last.n, Dm = new Float64Array(n * n);
  for (let r = 0; r < n; r++) for (let k = last.A.ptr[r]; k < last.A.ptr[r + 1]; k++) Dm[r * n + last.A.col[k]] = last.A.val[k];
  let dmax = 0; for (let i = 0; i < n; i++) dmax = Math.max(dmax, Dm[i * n + i]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = Dm[i * n + j]; for (let k = 0; k < j; k++) s -= Dm[i * n + k] * Dm[j * n + k];
      if (i === j) Dm[i * n + i] = Math.sqrt(s > 1e-12 * dmax ? s : 1e-12 * dmax + Math.abs(s)); else Dm[i * n + j] = s / Dm[j * n + j];
    }
  }
  const coarseSolve = (b, x) => {
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= Dm[i * n + k] * x[k]; x[i] = s / Dm[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= Dm[k * n + i] * x[k]; x[i] = s / Dm[i * n + i]; }
    return x;
  };
  const work = levels.map((l) => ({ r: new Float64Array(l.n), x: new Float64Array(l.n), b: new Float64Array(l.n) }));
  const gs = (lev, b, x, forward) => gaussSeidel(lev.A, lev.diag, b, x, forward);
  const cycle = (l, b, x) => {
    const lev = levels[l];
    if (l === levels.length - 1) return coarseSolve(b, x);
    x.fill(0);
    gs(lev, b, x, true);
    const r = work[l].r; csrMul(lev.A, x, r); for (let i = 0; i < lev.n; i++) r[i] = b[i] - r[i];
    const bc = work[l + 1].b, xc = work[l + 1].x;
    csrMul(lev.PT, r, bc);
    cycle(l + 1, bc, xc);
    const e = work[l].r; csrMul(lev.P, xc, e); for (let i = 0; i < lev.n; i++) x[i] += e[i];
    gs(lev, b, x, false);
    return x;
  };
  return {
    apply: (r, z) => cycle(0, r, z),
    levels: levels.map((l) => ({ n: l.n, nnz: l.A.col.length })),
    ms: Date.now() - t0,
  };
}
/** Greedy aggregation of a graph (strong[g]: strong neighbours; nbr[g]: [h, weight, …]) → { agg, na } */
function aggregate(ng, strong, nbr) {
  const agg = new Int32Array(ng).fill(-1);
  let na = 0;
  for (let g = 0; g < ng; g++) {
    if (agg[g] >= 0 || !strong[g].length || strong[g].some((h) => agg[h] >= 0)) continue;
    agg[g] = na; for (const h of strong[g]) agg[h] = na; na++;
  }
  for (let g = 0; g < ng; g++) {
    if (agg[g] >= 0) continue;
    let best = -1, bw = 0; const l = nbr[g], st = new Set(strong[g]);
    for (let i = 0; i < l.length; i += 2) { const h = l[i]; if (agg[h] >= 0 && l[i + 1] > bw && st.has(h)) { bw = l[i + 1]; best = agg[h]; } }
    if (best >= 0) agg[g] = best;
  }
  for (let g = 0; g < ng; g++) { if (agg[g] >= 0) continue; agg[g] = na; for (const h of strong[g]) if (agg[h] < 0) agg[h] = na; na++; }
  return { agg, na };
}
function csrFromRows(rows) {
  const n = rows.length, ptr = new Int32Array(n + 1);
  for (let r = 0; r < n; r++) ptr[r + 1] = ptr[r] + rows[r].length / 2;
  const col = new Int32Array(ptr[n]), val = new Float64Array(ptr[n]);
  for (let r = 0; r < n; r++) { const l = rows[r]; for (let i = 0; i < l.length; i += 2) { col[ptr[r] + i / 2] = l[i]; val[ptr[r] + i / 2] = l[i + 1]; } sortRow(col, val, ptr[r], ptr[r + 1]); }
  return { n, ptr, col, val };
}
function addCsr(A, B) {
  const g = new Grow(A.col.length + B.col.length), ptr = new Int32Array(A.n + 1);
  for (let r = 0; r < A.n; r++) {
    let i = A.ptr[r], j = B.ptr[r];
    const ie = A.ptr[r + 1], je = B.ptr[r + 1];
    while (i < ie || j < je) {
      if (j >= je || (i < ie && A.col[i] < B.col[j])) { g.push(A.col[i], A.val[i]); i++; }
      else if (i >= ie || B.col[j] < A.col[i]) { g.push(B.col[j], B.val[j]); j++; }
      else { g.push(A.col[i], A.val[i] + B.val[j]); i++; j++; }
    }
    ptr[r + 1] = g.n;
  }
  return { n: A.n, ptr, col: g.c.slice(0, g.n), val: g.v.slice(0, g.n) };
}
/** λmax of D⁻¹A by power iteration (15 steps, +5 % margin) */
function powerMax(A, diag) {
  let x = new Float64Array(A.n), y = new Float64Array(A.n), lam = 1;
  let s = 7; for (let i = 0; i < A.n; i++) { s = (s * 16807) % 2147483647; x[i] = s / 2147483647 - 0.5; }
  for (let it = 0; it < 15; it++) {
    csrMul(A, x, y); for (let i = 0; i < A.n; i++) y[i] = diag[i] ? y[i] / diag[i] : 0;
    let nx = 0, ny = 0; for (let i = 0; i < A.n; i++) { nx += x[i] * x[i]; ny += y[i] * y[i]; }
    lam = Math.sqrt(ny / (nx || 1)); const l = Math.sqrt(ny) || 1; for (let i = 0; i < A.n; i++) x[i] = y[i] / l;
  }
  return 1.05 * lam;
}
