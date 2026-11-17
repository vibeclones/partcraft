/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mg.js — a geometric multigrid preconditioner for fea.js's voxel models (DOM-free).
 *
 * Levels: the voxel grid coarsened by two in each direction until it has ≤ ~1500 nodes; coarse element
 * matrices are exact Galerkin products Rᵀ K R over each 2×2×2 block (trilinear interpolation R), so
 * holes, thin walls and SIMP's 1e-9 voids are seen by every level. Constraints enter the preconditioner as
 * a penalty α(I − P) at each constrained node (α = the node's own stiffness), restricted to the coarse
 * levels the same way; CG itself still works in the exactly projected space (fea.js), so the answer does not
 * depend on α — only the convergence rate does. Smoother: damped block Jacobi (ω 0.6, one sweep before and
 * one after — cheaper overall than two or three in our timings); coarsest level: banded Cholesky (a small
 * model is only that level: a direct solve). One symmetric V-cycle per CG iteration.
 * Threads (pool.js, when the page is cross-origin isolated and the model is big): the levels' K·x, the smoother, restriction and
 * prolongation run on the pool, each written per output node in the serial order — the V-cycle is bitwise the one-thread one;
 * the coarsest solve stays on one thread.
 */
import { getPool, hexOperator, K as PK } from './pool.js';

const W = [[1, 0], [0.5, 0.5], [0, 1]];   // fine node at local 0, 1, 2 of a coarse cell → weights of coarse corner 0/1
const XI = [0, 1, 1, 0, 0, 1, 1, 0], ETA = [0, 0, 1, 1, 0, 0, 1, 1], ZETA = [0, 0, 0, 0, 1, 1, 1, 1];

// weights of the 8 coarse corners for a fine node at local (a,b,c) ∈ {0,1,2}³
const cornerW = (a, b, c) => XI.map((_, C) => W[a][XI[C]] * W[b][ETA[C]] * W[c][ZETA[C]]);

// R for fine octant (a,b,c): fine element corner f (24 dofs) ← coarse corner C (24 dofs), as 8×8 weights
const OCT = [];
for (let c = 0; c < 2; c++) for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) OCT.push({ a, b, c, w: XI.map((_, f) => cornerW(a + XI[f], b + ETA[f], c + ZETA[f])) });

/** Rᵀ K R for one octant: K (24×24 fine element), w[f][C] → adds s·result into out (24×24). */
function galerkin(K, w, s, out) {
  const T = new Float64Array(576);   // T = K R  (24 × 24)
  for (let i = 0; i < 24; i++) for (let C = 0; C < 8; C++) for (let d = 0; d < 3; d++) {
    let t = 0; for (let f = 0; f < 8; f++) { const wf = w[f][C]; if (wf) t += K[i * 24 + 3 * f + d] * wf; }
    T[i * 24 + 3 * C + d] = t;
  }
  for (let C = 0; C < 8; C++) for (let a = 0; a < 3; a++) for (let j = 0; j < 24; j++) {
    let t = 0; for (let f = 0; f < 8; f++) { const wf = w[f][C]; if (wf) t += wf * T[(3 * f + a) * 24 + j]; }
    out[(3 * C + a) * 24 + j] += s * t;
  }
}

function invertBlocks(B, nn, active) {
  for (let n = 0; n < nn; n++) {
    const a = B.subarray(9 * n, 9 * n + 9);
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (!active[n] || !(Math.abs(det) > 0)) { a.fill(0); continue; }
    const inv = [a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4], a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5], a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]];
    for (let k = 0; k < 9; k++) a[k] = inv[k] / det;
  }
  return B;
}

const offsets = (nx, ny) => { const NX = nx + 1, NXY = NX * (ny + 1); return Int32Array.from([0, 1, 1 + NX, NX, NXY, NXY + 1, NXY + 1 + NX, NXY + NX]); };

/** y = A x for an explicit level (element matrices) */
function applyExplicit(L, x, y) {
  y.fill(0);
  const { node0, off, K } = L, xe = new Float64Array(24), dof = new Int32Array(24);
  for (let m = 0; m < node0.length; m++) {
    const n0 = node0[m], base = m * 576;
    for (let c = 0; c < 8; c++) { const d = 3 * (n0 + off[c]); dof[3 * c] = d; dof[3 * c + 1] = d + 1; dof[3 * c + 2] = d + 2; xe[3 * c] = x[d]; xe[3 * c + 1] = x[d + 1]; xe[3 * c + 2] = x[d + 2]; }
    for (let i = 0; i < 24; i++) { let t = 0; const r = base + i * 24; for (let j = 0; j < 24; j++) t += K[r + j] * xe[j]; y[dof[i]] += t; }
  }
  return y;
}

/**
 * Build the preconditioner. model, cons: fea.js; scale: per-element factors or null; applyK: fea.js's.
 * → { levels, apply(r, z) (z = M⁻¹ r, symmetric), setupMs }
 */
export function buildMG(model, cons, scale, applyK, { maxCoarseNodes = 1500, omega = 0.6, sweeps = 1 } = {}) {
  const t0 = Date.now(), g = model.grid;
  // level 0: implicit K + penalty
  const nn0 = model.nn, D0 = new Float64Array(9 * nn0);
  for (let m = 0; m < model.node0.length; m++) {
    const s = (scale ? scale[m] : 1) * model.kScale;
    for (let c = 0; c < 8; c++) { const b = 9 * (model.node0[m] + model.off[c]); for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) D0[b + a * 3 + d] += s * model.Ke[(3 * c + a) * 24 + 3 * c + d]; }
  }
  const pen = new Float64Array(9 * cons.nodes.length);
  for (let k = 0; k < cons.nodes.length; k++) {
    const n = cons.nodes[k], b = 9 * n, alpha = (D0[b] + D0[b + 4] + D0[b + 8]) / 3 || 1;
    for (let i = 0; i < 9; i++) { const v = alpha * ((i % 4 === 0 ? 1 : 0) - cons.P[9 * k + i]); pen[9 * k + i] = v; D0[b + i] += v; }
  }
  const L0 = { kind: 'implicit', nx: g.nx, ny: g.ny, nz: g.nz, nn: nn0, active: model.active, D: null, model, scale, pen, consNodes: cons.nodes };
  L0.apply = (x, y) => {
    applyK(model, x, y, scale);
    for (let k = 0; k < cons.nodes.length; k++) {
      const d = 3 * cons.nodes[k], p = 9 * k, a = x[d], b = x[d + 1], c = x[d + 2];
      y[d] += pen[p] * a + pen[p + 1] * b + pen[p + 2] * c; y[d + 1] += pen[p + 3] * a + pen[p + 4] * b + pen[p + 5] * c; y[d + 2] += pen[p + 6] * a + pen[p + 7] * b + pen[p + 8] * c;
    }
    return y;
  };
  const levels = [L0];
  // level 1's Galerkin pieces: Q_o = R_oᵀ (kScale·Ke) R_o
  const Q = OCT.map((o) => { const q = new Float64Array(576); galerkin(model.Ke, o.w, model.kScale, q); return q; });
  let fine = L0;
  while ((fine.nx + 1) * (fine.ny + 1) * (fine.nz + 1) > maxCoarseNodes && (fine.nx > 1 || fine.ny > 1 || fine.nz > 1)) {
    const cx = Math.ceil(fine.nx / 2), cy = Math.ceil(fine.ny / 2), cz = Math.ceil(fine.nz / 2);
    const cellOf = new Int32Array(cx * cy * cz).fill(-1), cells = [];
    const fineElems = [];   // [fine element index in its level, fine cell id]
    if (fine.kind === 'implicit') model.elems.forEach((e, m) => fineElems.push([m, e]));
    else fine.cells.forEach((e, m) => fineElems.push([m, e]));
    for (const [, e] of fineElems) {
      const i = e % fine.nx, j = Math.floor(e / fine.nx) % fine.ny, k = Math.floor(e / (fine.nx * fine.ny));
      const C = (i >> 1) + cx * ((j >> 1) + cy * (k >> 1));
      if (cellOf[C] < 0) { cellOf[C] = cells.length; cells.push(C); }
    }
    const ne = cells.length, K = new Float64Array(576 * ne);
    for (const [m, e] of fineElems) {
      const i = e % fine.nx, j = Math.floor(e / fine.nx) % fine.ny, k = Math.floor(e / (fine.nx * fine.ny));
      const C = cellOf[(i >> 1) + cx * ((j >> 1) + cy * (k >> 1))], o = (i & 1) + 2 * (j & 1) + 4 * (k & 1);
      const out = K.subarray(576 * C, 576 * C + 576);
      if (fine.kind === 'implicit') { const s = scale ? scale[m] : 1; if (s) for (let q = 0; q < 576; q++) out[q] += s * Q[o][q]; }
      else galerkin(fine.K.subarray(576 * m, 576 * m + 576), OCT[o].w, 1, out);
    }
    if (fine.kind === 'implicit') {   // the fine penalty blocks, each into one coarse element holding its node
      const NX = fine.nx + 1, NY = fine.ny + 1, map = new Int32Array(fine.nx * fine.ny * fine.nz).fill(-1);
      model.elems.forEach((e) => { map[e] = 1; });
      fine.consNodes.forEach((n, kk) => {
        const i = n % NX, j = Math.floor(n / NX) % NY, k = Math.floor(n / (NX * NY));
        let cell = -1;
        for (let dk = -1; dk <= 0 && cell < 0; dk++) for (let dj = -1; dj <= 0 && cell < 0; dj++) for (let di = -1; di <= 0 && cell < 0; di++) {
          const a = i + di, b = j + dj, c = k + dk;
          if (a < 0 || b < 0 || c < 0 || a >= fine.nx || b >= fine.ny || c >= fine.nz || map[a + fine.nx * (b + fine.ny * c)] < 0) continue;
          cell = (a >> 1) + cx * ((b >> 1) + cy * (c >> 1));
        }
        if (cell < 0) return;
        const I = cell % cx, J = Math.floor(cell / cx) % cy, Kc = Math.floor(cell / (cx * cy));
        const w = cornerW(i - 2 * I, j - 2 * J, k - 2 * Kc), out = K.subarray(576 * cellOf[cell], 576 * cellOf[cell] + 576), B = pen.subarray(9 * kk, 9 * kk + 9);
        for (let C = 0; C < 8; C++) if (w[C]) for (let D = 0; D < 8; D++) if (w[D]) for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) out[(3 * C + a) * 24 + 3 * D + d] += w[C] * w[D] * B[a * 3 + d];
      });
    }
    const off = offsets(cx, cy), node0 = Int32Array.from(cells, (C) => { const I = C % cx, J = Math.floor(C / cx) % cy, Kc = Math.floor(C / (cx * cy)); return I + (cx + 1) * (J + (cy + 1) * Kc); });
    const nn = (cx + 1) * (cy + 1) * (cz + 1), active = new Uint8Array(nn), D = new Float64Array(9 * nn);
    for (let m = 0; m < ne; m++) for (let c = 0; c < 8; c++) {
      const n = node0[m] + off[c]; active[n] = 1;
      for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) D[9 * n + a * 3 + d] += K[576 * m + (3 * c + a) * 24 + 3 * c + d];
    }
    const L = { kind: 'explicit', nx: cx, ny: cy, nz: cz, nn, active, cells: Int32Array.from(cells), node0, off, K, Dinv: invertBlocks(D, nn, active) };
    L.apply = (x, y) => applyExplicit(L, x, y);
    levels.push(L);
    fine = L;
  }
  L0.Dinv = invertBlocks(D0, nn0, model.active);
  // coarsest: banded Cholesky of the last level (penalised, inactive nodes = identity)
  const last = levels[levels.length - 1];
  last.chol = bandedCholesky(last, levels.length === 1 ? model : null);
  const pool = getPool();
  if (pool && pool.big(3 * nn0) && levels.length > 1) return threadedMG(pool, { levels, model, cons, scale, pen, omega, sweeps, t0 });
  const work = levels.map((L) => ({ x: new Float64Array(3 * L.nn), r: new Float64Array(3 * L.nn), t: new Float64Array(3 * L.nn), b: new Float64Array(3 * L.nn) }));
  const smooth = (L, b, x, r, zero) => {
    if (zero) r.fill(0); else L.apply(x, r);
    for (let n = 0; n < L.nn; n++) {
      const d = 3 * n, m = 9 * n, D = L.Dinv, e0 = b[d] - r[d], e1 = b[d + 1] - r[d + 1], e2 = b[d + 2] - r[d + 2];
      x[d] += omega * (D[m] * e0 + D[m + 1] * e1 + D[m + 2] * e2); x[d + 1] += omega * (D[m + 3] * e0 + D[m + 4] * e1 + D[m + 5] * e2); x[d + 2] += omega * (D[m + 6] * e0 + D[m + 7] * e1 + D[m + 8] * e2);
    }
  };
  const vcycle = (l, b, x) => {
    const L = levels[l], w = work[l];
    if (l === levels.length - 1) { x.set(b); cholSolve(L.chol, x); for (let n = 0; n < L.nn; n++) if (!L.active[n]) x[3 * n] = x[3 * n + 1] = x[3 * n + 2] = 0; return; }
    x.fill(0);
    for (let s = 0; s < sweeps; s++) smooth(L, b, x, w.r, s === 0);
    L.apply(x, w.r);
    for (let i = 0; i < w.r.length; i++) w.r[i] = b[i] - w.r[i];
    const C = levels[l + 1], wc = work[l + 1];
    restrict(L, C, w.r, wc.b);
    vcycle(l + 1, wc.b, wc.x);
    prolongAdd(L, C, wc.x, x);
    for (let s = 0; s < sweeps; s++) smooth(L, b, x, w.r);
  };
  return {
    levels: levels.map((L) => ({ nx: L.nx, ny: L.ny, nz: L.nz, nodes: L.nn })),
    setupMs: Date.now() - t0,
    apply(r, z) { vcycle(0, r, z); return z; },
  };
}

// fine node (i,j,k) ← coarse nodes; visit(fineNode, coarseNode, weight)
function eachTransfer(F, C, fn) {
  const FX = F.nx + 1, FY = F.ny + 1, CX = C.nx + 1, CY = C.ny + 1;
  for (let k = 0; k <= F.nz; k++) for (let j = 0; j <= F.ny; j++) for (let i = 0; i <= F.nx; i++) {
    const n = i + FX * (j + FY * k);
    if (!F.active[n]) continue;
    const I = i >> 1, J = j >> 1, K = k >> 1, oi = i & 1, oj = j & 1, ok = k & 1;
    for (let c = 0; c <= ok; c++) for (let b = 0; b <= oj; b++) for (let a = 0; a <= oi; a++) {
      const w = (oi ? 0.5 : 1) * (oj ? 0.5 : 1) * (ok ? 0.5 : 1);
      fn(n, (I + a) + CX * ((J + b) + CY * (K + c)), w);
    }
  }
}
function restrict(F, C, rf, rc) { rc.fill(0); eachTransfer(F, C, (n, N, w) => { rc[3 * N] += w * rf[3 * n]; rc[3 * N + 1] += w * rf[3 * n + 1]; rc[3 * N + 2] += w * rf[3 * n + 2]; }); }
function prolongAdd(F, C, xc, xf) { eachTransfer(F, C, (n, N, w) => { xf[3 * n] += w * xc[3 * N]; xf[3 * n + 1] += w * xc[3 * N + 1]; xf[3 * n + 2] += w * xc[3 * N + 2]; }); }

/** Banded Cholesky of a level (explicit element matrices, or the implicit level 0 when it is the only one). */
function bandedCholesky(L, model0) {
  // renumber nodes with the longest axis slowest, so the band is the product of the two shortest
  const N = [L.nx + 1, L.ny + 1, L.nz + 1], ax = [0, 1, 2].sort((a, b) => N[a] - N[b]);
  const perm = new Int32Array(L.nn);
  for (let k = 0; k < N[2]; k++) for (let j = 0; j < N[1]; j++) for (let i = 0; i < N[0]; i++) { const c = [i, j, k]; perm[i + N[0] * (j + N[1] * k)] = c[ax[0]] + N[ax[0]] * (c[ax[1]] + N[ax[1]] * c[ax[2]]); }
  const n = 3 * L.nn, bw = 3 * (N[ax[0]] * N[ax[1]] + N[ax[0]] + 1) + 2;
  const A = new Float64Array(n * (bw + 1));   // row i holds columns i−bw … i at A[i·(bw+1) + (j − i + bw)]
  const pd = (d) => 3 * perm[(d / 3) | 0] + (d % 3);
  const add = (i, j, v) => { i = pd(i); j = pd(j); if (j > i) return; A[i * (bw + 1) + (j - i + bw)] += v; };
  if (L.kind === 'explicit') {
    for (let m = 0; m < L.node0.length; m++) for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) {
      const da = 3 * (L.node0[m] + L.off[(a / 3) | 0]) + (a % 3), db = 3 * (L.node0[m] + L.off[(b / 3) | 0]) + (b % 3);
      add(da, db, L.K[576 * m + a * 24 + b]);
    }
  } else {
    const { node0, off, Ke, kScale } = model0;
    for (let m = 0; m < node0.length; m++) {
      const s = (L.scale ? L.scale[m] : 1) * kScale;
      for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) add(3 * (node0[m] + off[(a / 3) | 0]) + (a % 3), 3 * (node0[m] + off[(b / 3) | 0]) + (b % 3), s * Ke[a * 24 + b]);
    }
    L.consNodes.forEach((nd, k) => { for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) add(3 * nd + a, 3 * nd + b, L.pen[9 * k + a * 3 + b]); });
  }
  for (let nd = 0; nd < L.nn; nd++) if (!L.active[nd]) for (let a = 0; a < 3; a++) A[(3 * perm[nd] + a) * (bw + 1) + bw] = 1;
  for (let i = 0; i < n; i++) {
    const ri = i * (bw + 1);
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      const rj = j * (bw + 1);
      let s = A[ri + (j - i + bw)];
      const k0 = Math.max(0, i - bw, j - bw);
      for (let k = k0; k < j; k++) s -= A[ri + (k - i + bw)] * A[rj + (k - j + bw)];
      if (j === i) A[ri + bw] = Math.sqrt(s > 1e-300 ? s : 1e-300);
      else A[ri + (j - i + bw)] = s / A[rj + bw];
    }
  }
  return { A, n, bw, perm, y: new Float64Array(n) };
}
function cholSolve({ A, n, bw, perm, y }, b) {
  for (let nd = 0; nd < perm.length; nd++) for (let a = 0; a < 3; a++) y[3 * perm[nd] + a] = b[3 * nd + a];
  const x = y;
  for (let i = 0; i < n; i++) { let s = x[i]; const ri = i * (bw + 1); for (let k = Math.max(0, i - bw); k < i; k++) s -= A[ri + (k - i + bw)] * x[k]; x[i] = s / A[ri + bw]; }
  for (let i = n - 1; i >= 0; i--) { x[i] /= A[i * (bw + 1) + bw]; const ri = i * (bw + 1); const xi = x[i]; for (let k = Math.max(0, i - bw); k < i; k++) x[k] -= A[ri + (k - i + bw)] * xi; }
  for (let nd = 0; nd < perm.length; nd++) for (let a = 0; a < 3; a++) b[3 * nd + a] = y[3 * perm[nd] + a];
}

/** The same V-cycle with the big levels' loops on the pool (pool.js kernels; arrays shared). */
function threadedMG(P, { levels, model, cons, scale, pen, omega, sweeps, t0 }) {
  const consIdx = new Int32Array(model.nn).fill(-1); cons.nodes.forEach((n, k) => { consIdx[n] = k; });
  const held = [];
  const sh = (a) => { const s = P.share(a); held.push(s); return s; };
  const f64 = (n) => { const a = P.f64(n); held.push(a); return a; };
  const Ls = levels.map((L, l) => {
    const n = 3 * L.nn, big = P.big(n) && l < levels.length - 1;
    const o = { L, n, big, active: sh(L.active), Dinv: big ? sh(L.Dinv) : L.Dinv, x: f64(n), r: f64(n), b: f64(n) };
    o.apply = !big ? L.apply : l === 0 ? hexOperator(P, model, { scale, consIdx, pen }) : hexOperator(P, L, { explicit: true });
    return o;
  });
  const smooth = (o, b, x, r, zero) => {
    if (o.big) { if (zero) P.fill(r, 0); else o.apply(x, r); P.run(PK.BLOCK3, [o.Dinv._pid, r._pid, x._pid, o.L.nn, 1, b._pid], [omega]); return; }
    if (zero) r.fill(0); else o.apply(x, r);
    for (let n = 0; n < o.L.nn; n++) {
      const d = 3 * n, m = 9 * n, D = o.Dinv, e0 = b[d] - r[d], e1 = b[d + 1] - r[d + 1], e2 = b[d + 2] - r[d + 2];
      x[d] += omega * (D[m] * e0 + D[m + 1] * e1 + D[m + 2] * e2); x[d + 1] += omega * (D[m + 3] * e0 + D[m + 4] * e1 + D[m + 5] * e2); x[d + 2] += omega * (D[m + 6] * e0 + D[m + 7] * e1 + D[m + 8] * e2);
    }
  };
  const vcycle = (l, b, x) => {
    const o = Ls[l], L = o.L;
    if (l === levels.length - 1) { x.set(b); cholSolve(L.chol, x); for (let n = 0; n < L.nn; n++) if (!L.active[n]) x[3 * n] = x[3 * n + 1] = x[3 * n + 2] = 0; return; }
    if (o.big) P.fill(x, 0); else x.fill(0);
    for (let s = 0; s < sweeps; s++) smooth(o, b, x, o.r, s === 0);
    o.apply(x, o.r);
    if (o.big) P.run(PK.AMINUS, [b._pid, o.r._pid, o.n]); else for (let i = 0; i < o.n; i++) o.r[i] = b[i] - o.r[i];
    const c = Ls[l + 1], C = c.L, dims = [L.nx + 1, L.ny + 1, L.nz + 1, C.nx + 1, C.ny + 1, C.nz + 1];
    if (o.big) P.run(PK.RESTRICT, [o.r._pid, c.b._pid, o.active._pid, ...dims]); else restrict(L, C, o.r, c.b);
    vcycle(l + 1, c.b, c.x);
    if (o.big) P.run(PK.PROLONG, [c.x._pid, x._pid, o.active._pid, ...dims.slice(0, 5)]); else prolongAdd(L, C, c.x, x);
    for (let s = 0; s < sweeps; s++) smooth(o, b, x, o.r);
  };
  const rIn = f64(Ls[0].n), zOut = f64(Ls[0].n);
  const mg = {
    levels: levels.map((L) => ({ nx: L.nx, ny: L.ny, nz: L.nz, nodes: L.nn })),
    setupMs: Date.now() - t0, threads: P.n,
    apply(r, z) {
      if (r._pid && z._pid) { vcycle(0, r, z); return z; }
      rIn.set(r); vcycle(0, rIn, zOut); z.set(zOut); return z;
    },
  };
  return P.own(mg, held);
}
