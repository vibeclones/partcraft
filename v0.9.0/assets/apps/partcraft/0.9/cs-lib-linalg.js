/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lib-linalg.js — CraftScript builtins: dense and sparse linear algebra (DOM-free; runs in the script worker and in Node).
 * Spec: docs/SCRIPTING-SPEC.md §1–§3 (builder B). Values are the §2 shapes: tensor { t:'tensor', shape, data } column-major,
 * sparse { t:'sparse', n, m, rowPtr, col, val } CSR (0-based inside, columns sorted, no duplicates). Script-facing indices are
 * 1-based (sparse(i, j, v) as MATLAB).
 *
 * Operators on sparse values (registerMethod 'sparse'): + - * .* ./ / \ ' and S(rows, cols); dense operators are the VM's.
 * Dense: linsolve (A\b with the method used), inv, det, lu, chol, qr (Householder), eig (symmetric, and symmetric-
 * definite generalized; Householder tridiagonalisation + implicit QL, EISPACK tred2/tql2), norm, cond.
 * Sparse: sparse (triplets, duplicates summed; dense → sparse; empty n×m), full, speye, spdiags-free, nnz, issparse, csrmul,
 * spadd, spscale, sptranspose, spindex (submatrix), spdiag, assemble (element matrices → CSR without triplets), and solvers:
 *   mldivide on sparse: symmetric → envelope (skyline) Cholesky after reverse Cuthill–McKee when the envelope fits
 *     (≤ ENVELOPE_CAP entries and ≤ ENVELOPE_WORK multiply-adds, about 3 s), else PCG + IC(0) (AMG past AMG_AUTO unknowns); non-symmetric → dense LU (n ≤ DENSE_MAX),
 *     else BiCGSTAB + ILU(0).
 *   pcg(K, f, opts) — opts { tol 1e-8, maxit, prec 'ic0'|'amg'|'jacobi'|'none', x0, dofsPerNode, coords } → [x, info].
 *   bicgstab(A, b, opts) — opts { tol, maxit, prec 'ilu0'|'jacobi'|'none', x0 } → [x, info].
 *   eigs(K, M, k, opts) — the k smallest of K v = λ M v (symmetric, M SPD): dense for n ≤ DENSE_EIG, else subspace iteration
 *     on (K − σM)⁻¹M with a sparse factorisation; opts { sigma 0, tol 1e-10, maxit 300 } → [V, D] (or d with one output).
 * Kernels wrapped (never re-implemented): thermal.js csrPcg / ic0 (CG + IC(0)), amg.js buildAMG (smoothed aggregation),
 * tetfea.js rcm (ordering). Everything solver-module-shaped is imported in ONE adapter section below.
 * Every builtin is a plain exported function fn(args, ctx) → value | value[] (several outputs); `register(registerBuiltin)` adds
 * them to cs-runtime.js's registry. ctx.check() (budget/Stop) is called inside long loops; ctx.nargout (when the runtime passes
 * it) picks MATLAB's output forms (default 1).
 */

// ─────────────────────────────────────────────────────────────── solver-module adapter (the only imports of solver modules)
import { csrPcg as thermalCsrPcg, ic0 as thermalIc0 } from './thermal.js';
import { buildAMG } from './amg.js';
import { rcm as tetRcm } from './tetfea.js';

/** CG on our CSR (full, sorted) with a preconditioner {apply(r, z)} → { x, iterations, residual, converged }. */
const kPcg = (S, b, { x0, tol, maxIter, prec, cancelled }) => thermalCsrPcg({ n: S.n, rowPtr: S.rowPtr, cols: S.col }, S.val, b, { x0, tol, maxIter, prec, cancelled });
/** IC(0) of an SPD CSR (thermal.js: lower part used, diagonal shift on breakdown) → { apply, shift }. */
const kIc0 = (S) => thermalIc0({ n: S.n, rowPtr: S.rowPtr, cols: S.col }, S.val);
/** Smoothed-aggregation AMG (amg.js) → { apply, levels, ms }. groups: Int32Array of group starts; B: near-null vectors. */
const kAmg = (S, groups, B) => buildAMG({ n: S.n, ptr: S.rowPtr, col: S.col, val: S.val }, groups, B);
/** Reverse Cuthill–McKee (tetfea.js) of a graph in CSR → perm (new index of each old node). */
const kRcm = (n, ptr, adj) => tetRcm(n, ptr, adj);

// ─────────────────────────────────────────────────────────────── limits
export const DENSE_MAX = 3000;          // non-symmetric sparse systems up to this size go to dense LU
export const DENSE_EIG = 400;           // eigs: dense below this size
export const ENVELOPE_CAP = 4e7;        // skyline Cholesky only when the envelope has at most this many entries (~320 MB)
export const ENVELOPE_WORK = 3e9;       // … and when the factorisation costs at most this many multiply-adds (~3 s); else PCG
export const AMG_AUTO = 60000;          // pcg prec 'auto': AMG at and past this many unknowns, IC(0) below

// ─────────────────────────────────────────────────────────────── values (local helpers on the §2 shapes)
import { registerBuiltin as rtRegisterBuiltin, registerMethod as rtRegisterMethod } from './cs-runtime.js';
import { CsError } from './cs-values.js';
import { t } from './i18n.js';

const err = (msg) => new CsError(msg);
export const tensor = (shape, data) => ({ t: 'tensor', shape: shape.slice(), data: data instanceof Float64Array ? data : Float64Array.from(data) });
export const mat = (r, c, data = new Float64Array(r * c)) => ({ t: 'tensor', shape: [r, c], data });
const isTensor = (v) => !!v && typeof v === 'object' && v.t === 'tensor';
export const isSparse = (v) => !!v && typeof v === 'object' && v.t === 'sparse';
/** Any number-like value → tensor (Float64 data). */
export function asTensor(v, what) {
  if (typeof v === 'number') return mat(1, 1, Float64Array.of(v));
  if (typeof v === 'boolean') return mat(1, 1, Float64Array.of(v ? 1 : 0));
  if (isTensor(v)) return v.data instanceof Float64Array ? v : { t: 'tensor', shape: v.shape.slice(), data: Float64Array.from(v.data) };
  if (isSparse(v)) return toDense(v);
  throw err(t('script.linalg.not_number', { what: what ?? t('script.linalg.what.argument'), got: typeName(v) }));
}
export function typeName(v) {
  if (v === null || v === undefined) return t('script.linalg.type.nothing');
  if (typeof v !== 'object') return typeof v;
  return v.t || (Array.isArray(v) ? 'list' : 'object');
}
/** 2-D size of a tensor (trailing singleton dims allowed). */
export function size2(tv, what) {
  const s = tv.shape;
  if (s.length > 2 && s.slice(2).some((d) => d !== 1)) throw err(t('script.linalg.not_2d', { what: what ?? t('script.linalg.what.matrix'), size: s.join('×') }));
  return [s[0] ?? 1, s.length > 1 ? s[1] : 1];
}
export function scalarOf(v, what) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTensor(v) && v.data.length === 1) return v.data[0];
  throw err(t('script.linalg.not_scalar', { what: what ?? t('script.linalg.what.argument') }));
}
const strOf = (v) => (typeof v === 'string' ? v : null);
/** A struct (or plain object) of options → plain object (scalars unwrapped, vectors as Float64Array, strings kept). */
export function optsOf(v) {
  if (v === undefined || v === null) return {};
  const f = v && v.t === 'struct' ? v.fields : (v && typeof v === 'object' && !v.t ? v : null);
  if (!f) throw err(t('script.linalg.opts_struct'));
  const o = {};
  for (const [k, x] of Object.entries(f)) o[k] = isTensor(x) ? (x.data.length === 1 ? x.data[0] : x) : x;
  return o;
}
const vec = (t) => (isTensor(t) ? t.data : asTensor(t).data);
const nout = (ctx) => (ctx && Number.isInteger(ctx.nargout) && ctx.nargout > 0 ? ctx.nargout : 1);
const checker = (ctx) => (ctx && typeof ctx.check === 'function' ? () => ctx.check() : () => {});
/** 1-based index list (tensor or number) → Int32Array of 0-based indices in [0, n). Logical masks of length n accepted. */
export function indexList(v, n, what) {
  if ((typeof v === 'string' && v === ':') || (v && v.t === 'colon')) return Int32Array.from({ length: n }, (_, i) => i);
  const tv = asTensor(v, what ?? t('script.linalg.what.index')), d = tv.data;
  if (tv.dtype === 'u8' || (v && v.dtype === 'u8')) { const out = []; for (let i = 0; i < d.length; i++) if (d[i]) out.push(i); return Int32Array.from(out); }
  const out = new Int32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const k = d[i];
    if (!Number.isInteger(k) || k < 1) throw err(t('script.linalg.index_not_positive', { what: what ?? t('script.linalg.what.index'), k }));
    if (k > n) throw err(t('script.linalg.index_past_end', { what: what ?? t('script.linalg.what.index'), k, n }));
    out[i] = k - 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── sparse core (CSR)
const sp = (n, m, rowPtr, col, val) => ({ t: 'sparse', n, m, rowPtr, col, val });

/** Triplets (0-based rows/cols) → CSR, duplicates summed, columns sorted; two counting sorts (column, then stable row). */
export function fromTriplets(I, J, V, n, m) {
  const nz = I.length;
  // pass 1: by column
  const cc = new Int32Array(m + 1);
  for (let k = 0; k < nz; k++) cc[J[k] + 1]++;
  for (let c = 0; c < m; c++) cc[c + 1] += cc[c];
  const o1 = new Int32Array(nz), fc = cc.slice(0, m);
  for (let k = 0; k < nz; k++) o1[fc[J[k]]++] = k;
  // pass 2: stable by row
  const rc = new Int32Array(n + 1);
  for (let k = 0; k < nz; k++) rc[I[k] + 1]++;
  for (let r = 0; r < n; r++) rc[r + 1] += rc[r];
  const o2 = new Int32Array(nz), fr = rc.slice(0, n);
  for (let q = 0; q < nz; q++) { const k = o1[q]; o2[fr[I[k]]++] = k; }
  // merge duplicates
  const rowPtr = new Int32Array(n + 1), col = new Int32Array(nz), val = new Float64Array(nz);
  let w = 0;
  for (let r = 0; r < n; r++) {
    const start = w;
    for (let q = rc[r]; q < rc[r + 1]; q++) {
      const k = o2[q], c = J[k];
      if (w > start && col[w - 1] === c) val[w - 1] += V[k];
      else { col[w] = c; val[w] = V[k]; w++; }
    }
    rowPtr[r + 1] = w;
  }
  return sp(n, m, rowPtr, col.slice(0, w), val.slice(0, w));
}
export function toDense(S) {
  const A = new Float64Array(S.n * S.m);
  for (let r = 0; r < S.n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) A[r + S.col[k] * S.n] += S.val[k];
  return mat(S.n, S.m, A);
}
export function fromDense(t, drop = 0) {
  const [n, m] = size2(t), d = t.data, rowPtr = new Int32Array(n + 1), col = [], val = [];
  for (let r = 0; r < n; r++) { for (let c = 0; c < m; c++) { const v = d[r + c * n]; if (v !== 0 && Math.abs(v) > drop) { col.push(c); val.push(v); } } rowPtr[r + 1] = col.length; }
  return sp(n, m, rowPtr, Int32Array.from(col), Float64Array.from(val));
}
export function spTranspose(S) {
  const ptr = new Int32Array(S.m + 1), nz = S.col.length;
  for (let k = 0; k < nz; k++) ptr[S.col[k] + 1]++;
  for (let c = 0; c < S.m; c++) ptr[c + 1] += ptr[c];
  const fill = ptr.slice(0, S.m), col = new Int32Array(nz), val = new Float64Array(nz);
  for (let r = 0; r < S.n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) { const p = fill[S.col[k]]++; col[p] = r; val[p] = S.val[k]; }
  return sp(S.m, S.n, ptr, col, val);
}
/** a·A + b·B (same size). */
export function spAdd(A, B, a = 1, b = 1) {
  if (A.n !== B.n || A.m !== B.m) throw err(t('script.linalg.sparse_sizes_differ', { a: `${A.n}×${A.m}`, b: `${B.n}×${B.m}` }));
  const rowPtr = new Int32Array(A.n + 1), cap = A.col.length + B.col.length, col = new Int32Array(cap), val = new Float64Array(cap);
  let w = 0;
  for (let r = 0; r < A.n; r++) {
    let i = A.rowPtr[r], j = B.rowPtr[r];
    const ie = A.rowPtr[r + 1], je = B.rowPtr[r + 1];
    while (i < ie || j < je) {
      if (j >= je || (i < ie && A.col[i] < B.col[j])) { col[w] = A.col[i]; val[w++] = a * A.val[i++]; }
      else if (i >= ie || B.col[j] < A.col[i]) { col[w] = B.col[j]; val[w++] = b * B.val[j++]; }
      else { col[w] = A.col[i]; val[w++] = a * A.val[i++] + b * B.val[j++]; }
    }
    rowPtr[r + 1] = w;
  }
  return sp(A.n, A.m, rowPtr, col.slice(0, w), val.slice(0, w));
}
export const spScale = (S, s) => sp(S.n, S.m, S.rowPtr, S.col, S.val.map((v) => v * s));
/** y = S x (x Float64Array) */
export function spMulVec(S, x, y = new Float64Array(S.n)) {
  const { rowPtr, col, val } = S;
  for (let r = 0; r < S.n; r++) { let s = 0; for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) s += val[k] * x[col[k]]; y[r] = s; }
  return y;
}
/** S · B (B dense, m×c) → dense n×c */
export function spMulDense(S, B) {
  const [bm, c] = size2(B);
  if (bm !== S.m) throw err(t('script.linalg.inner_sizes', { a: `${S.n}×${S.m}`, b: `${bm}×${c}` }));
  const out = new Float64Array(S.n * c);
  for (let j = 0; j < c; j++) spMulVec(S, B.data.subarray(j * bm, (j + 1) * bm), out.subarray(j * S.n, (j + 1) * S.n));
  return mat(S.n, c, out);
}
/** Sparse × sparse (Gustavson). */
export function spMulSp(A, B) {
  if (A.m !== B.n) throw err(t('script.linalg.inner_sizes', { a: `${A.n}×${A.m}`, b: `${B.n}×${B.m}` }));
  const mark = new Int32Array(B.m).fill(-1), acc = new Float64Array(B.m), list = new Int32Array(B.m);
  const rowPtr = new Int32Array(A.n + 1); let col = new Int32Array(Math.max(16, A.col.length + B.col.length)), val = new Float64Array(col.length), w = 0;
  for (let i = 0; i < A.n; i++) {
    let m = 0;
    for (let k = A.rowPtr[i]; k < A.rowPtr[i + 1]; k++) {
      const a = A.val[k], r = A.col[k];
      for (let q = B.rowPtr[r]; q < B.rowPtr[r + 1]; q++) { const j = B.col[q]; if (mark[j] !== i) { mark[j] = i; acc[j] = 0; list[m++] = j; } acc[j] += a * B.val[q]; }
    }
    const l = list.subarray(0, m).sort();
    if (w + m > col.length) { const nc = new Int32Array(2 * (w + m)), nv = new Float64Array(2 * (w + m)); nc.set(col); nv.set(val); col = nc; val = nv; }
    for (let t = 0; t < m; t++) { col[w] = l[t]; val[w++] = acc[l[t]]; }
    rowPtr[i + 1] = w;
  }
  return sp(A.n, B.m, rowPtr, col.slice(0, w), val.slice(0, w));
}
/** S(rows, cols) for 0-based index lists (any order, repeats allowed). */
export function spSub(S, rows, cols) {
  const cmap = new Map();   // old column → new positions
  for (let j = 0; j < cols.length; j++) { const l = cmap.get(cols[j]); if (l) l.push(j); else cmap.set(cols[j], [j]); }
  const simple = cmap.size === cols.length;
  const cm = simple ? new Int32Array(S.m).fill(-1) : null;
  if (simple) for (let j = 0; j < cols.length; j++) cm[cols[j]] = j;
  const rowPtr = new Int32Array(rows.length + 1), C = [], V = [];
  const tc = [], tv = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; tc.length = 0; tv.length = 0;
    for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) {
      if (simple) { const j = cm[S.col[k]]; if (j >= 0) { tc.push(j); tv.push(S.val[k]); } }
      else { const l = cmap.get(S.col[k]); if (l) for (const j of l) { tc.push(j); tv.push(S.val[k]); } }
    }
    let sorted = true; for (let q = 1; q < tc.length; q++) if (tc[q] < tc[q - 1]) { sorted = false; break; }
    if (sorted) { for (let q = 0; q < tc.length; q++) { C.push(tc[q]); V.push(tv[q]); } }
    else { const ord = tc.map((_, q) => q).sort((a, b) => tc[a] - tc[b]); for (const q of ord) { C.push(tc[q]); V.push(tv[q]); } }
    rowPtr[i + 1] = C.length;
  }
  return sp(rows.length, cols.length, rowPtr, Int32Array.from(C), Float64Array.from(V));
}
export function spDiag(S) {
  const n = Math.min(S.n, S.m), d = new Float64Array(n);
  for (let r = 0; r < n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) if (S.col[k] === r) d[r] = S.val[k];
  return d;
}
/** Is S symmetric (pattern and values within rel·max|v|)? */
export function spIsSymmetric(S, rel = 1e-10) {
  if (S.n !== S.m) return false;
  const T = spTranspose(S);
  let mx = 0; for (const v of S.val) mx = Math.max(mx, Math.abs(v));
  const tol = rel * (mx || 1);
  const D = spAdd(S, T, 1, -1);
  for (const v of D.val) if (Math.abs(v) > tol) return false;
  return true;
}
/** Make sure a CSR is a valid §2 sparse (untrusted input, e.g. from a file). */
export function checkSparse(S) {
  const { n, m, rowPtr, col, val } = S;
  if (!(Number.isInteger(n) && Number.isInteger(m) && n >= 0 && m >= 0)) throw err(t('script.linalg.sparse_bad_size'));
  if (!(rowPtr instanceof Int32Array) || rowPtr.length !== n + 1 || rowPtr[0] !== 0) throw err(t('script.linalg.sparse_bad_rows'));
  if (!(col instanceof Int32Array) || !(val instanceof Float64Array) || col.length !== val.length || rowPtr[n] !== col.length) throw err(t('script.linalg.sparse_bad_cols'));
  for (let r = 0; r < n; r++) {
    if (rowPtr[r + 1] < rowPtr[r]) throw err(t('script.linalg.sparse_bad_rows'));
    for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) if (col[k] < 0 || col[k] >= m || (k > rowPtr[r] && col[k] <= col[k - 1])) throw err(t('script.linalg.sparse_cols_sorted'));
  }
  return S;
}

// ─────────────────────────────────────────────────────────────── sparse direct: envelope (skyline) Cholesky after RCM
/** Symmetric adjacency (no diagonal) of a square CSR → { ptr, adj } */
function symGraph(S) {
  const T = spTranspose(S), n = S.n, ptr = new Int32Array(n + 1), tmp = [];
  const lists = new Array(n);
  for (let r = 0; r < n; r++) {
    tmp.length = 0;
    let i = S.rowPtr[r], j = T.rowPtr[r];
    const ie = S.rowPtr[r + 1], je = T.rowPtr[r + 1];
    while (i < ie || j < je) {
      let c;
      if (j >= je || (i < ie && S.col[i] < T.col[j])) c = S.col[i++];
      else if (i >= ie || T.col[j] < S.col[i]) c = T.col[j++];
      else { c = S.col[i++]; j++; }
      if (c !== r) tmp.push(c);
    }
    lists[r] = Int32Array.from(tmp); ptr[r + 1] = ptr[r] + tmp.length;
  }
  const adj = new Int32Array(ptr[n]); for (let r = 0; r < n; r++) adj.set(lists[r], ptr[r]);
  return { ptr, adj };
}
/** Envelope size after a permutation (new index of each old node). */
function envelopeOf(S, perm) {
  const n = S.n, first = new Int32Array(n);
  for (let i = 0; i < n; i++) first[i] = i;
  for (let r = 0; r < n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) {
    const a = perm[r], b = perm[S.col[k]], hi = a > b ? a : b, lo = a > b ? b : a;
    if (lo < first[hi]) first[hi] = lo;
  }
  let tot = 0, work = 0; for (let i = 0; i < n; i++) { const w = i - first[i] + 1; tot += w; work += w * w / 2; }
  return { first, tot, work };
}
/** Factor an SPD sparse matrix (envelope Cholesky, RCM order) → { solve(b, x), n, envelope, ms } or null when it does not fit (cap entries, maxWork multiply-adds). Throws 'not positive definite'. */
export function envelopeCholesky(S, { cap = ENVELOPE_CAP, maxWork = ENVELOPE_WORK, check = () => {} } = {}) {
  const t0 = Date.now(), n = S.n;
  const g = symGraph(S), perm = n > 1 ? kRcm(n, g.ptr, g.adj) : new Int32Array(n);
  const { first, tot, work } = envelopeOf(S, perm);
  if (tot > cap || work > maxWork) return null;
  const start = new Float64Array(n + 1);   // offset of row i (Float64 index arithmetic safe beyond 2^31 is not needed below the cap)
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + (i - first[i] + 1);
  const L = new Float64Array(tot);
  // scatter A (lower part, permuted) into the envelope; L[start[i] + (j − first[i])] = A_ij
  for (let r = 0; r < n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) {
    const a = perm[r], b = perm[S.col[k]];
    if (b > a) continue;
    L[start[a] + (b - first[a])] += S.val[k];
  }
  // in-place row-oriented Cholesky
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0) check();
    const fi = first[i], si = start[i];
    for (let j = fi; j < i; j++) {
      const fj = first[j], sj = start[j], k0 = fi > fj ? fi : fj;
      let s = L[si + (j - fi)];
      let p = si + (k0 - fi), q = sj + (k0 - fj);
      for (let k = k0; k < j; k++) s -= L[p++] * L[q++];
      L[si + (j - fi)] = s / L[sj + (j - fj)];
    }
    let d = L[si + (i - fi)];
    for (let p = si, e = si + (i - fi); p < e; p++) d -= L[p] * L[p];
    if (!(d > 0)) { const e = err(t('script.linalg.not_pd')); e.notPD = true; throw e; }
    L[si + (i - fi)] = Math.sqrt(d);
  }
  const y = new Float64Array(n);
  return {
    n, envelope: tot, ms: Date.now() - t0, kind: 'envelope Cholesky (RCM)',   // i18n-ignore: a method name scripts read from info.method
    solve(b, x = new Float64Array(n)) {
      for (let i = 0; i < n; i++) y[perm[i]] = b[i];
      for (let i = 0; i < n; i++) { const fi = first[i], si = start[i]; let s = y[i]; for (let k = fi, p = si; k < i; k++) s -= L[p++] * y[k]; y[i] = s / L[si + (i - fi)]; }
      for (let i = n - 1; i >= 0; i--) { const fi = first[i], si = start[i]; const v = (y[i] /= L[si + (i - fi)]); for (let k = fi, p = si; k < i; k++) y[k] -= L[p++] * v; }
      for (let i = 0; i < n; i++) x[i] = y[perm[i]];
      return x;
    },
  };
}

// ─────────────────────────────────────────────────────────────── iterative solvers and preconditioners
function jacobiPrec(S) {
  const d = spDiag(S), inv = d.map((v) => (v ? 1 / v : 1));
  return { kind: 'jacobi', apply(r, z) { for (let i = 0; i < r.length; i++) z[i] = r[i] * inv[i]; return z; } };
}
/** Near-null space for AMG: constants per dof direction, plus rotations when node coordinates are given. */
function nearNull(n, dpn, coords) {
  const B = [];
  for (let d = 0; d < dpn; d++) { const v = new Float64Array(n); for (let i = d; i < n; i += dpn) v[i] = 1; B.push(v); }
  if (coords && (dpn === 2 || dpn === 3)) {
    const nn = n / dpn, X = coords;
    if (X.length < nn * dpn) throw err(t('script.linalg.pcg_coords', { dpn, nn }));
    let c = [0, 0, 0]; for (let i = 0; i < nn; i++) for (let a = 0; a < dpn; a++) c[a] += X[i * dpn + a] / nn;
    if (dpn === 2) { const v = new Float64Array(n); for (let i = 0; i < nn; i++) { v[2 * i] = -(X[2 * i + 1] - c[1]); v[2 * i + 1] = X[2 * i] - c[0]; } B.push(v); }
    else for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const v = new Float64Array(n); for (let i = 0; i < nn; i++) { v[3 * i + a] = -(X[3 * i + b] - c[b]); v[3 * i + b] = X[3 * i + a] - c[a]; } B.push(v); }
  }
  return B;
}
export function makePrec(S, kind, { dofsPerNode = 1, coords = null } = {}) {
  if (kind === 'auto') kind = S.n >= AMG_AUTO ? 'amg' : 'ic0';
  if (kind === 'none') return { kind, apply(r, z) { z.set(r); return z; } };
  if (kind === 'jacobi') return jacobiPrec(S);
  // i18n-ignore: preconditioner names are values scripts read from info.prec
  if (kind === 'ic0') { const p = kIc0(S); return { kind: p.shift ? `ic0 (shift ${p.shift === Infinity ? 'failed: jacobi' : p.shift})` : 'ic0', apply: p.apply }; }
  if (kind === 'amg') {
    const dpn = Math.max(1, Math.round(dofsPerNode) || 1);
    if (S.n % dpn) throw err(t('script.linalg.pcg_dpn', { n: S.n, dpn }));
    const groups = new Int32Array(S.n / dpn + 1); for (let g = 0; g < groups.length; g++) groups[g] = g * dpn;
    const a = kAmg(S, groups, nearNull(S.n, dpn, coords));
    return { kind: `amg (${a.levels.length} levels)`,   // i18n-ignore: a preconditioner name scripts read from info.prec
      apply: a.apply, levels: a.levels };
  }
  throw err(t('script.linalg.unknown_prec', { kind }));
}
/** PCG on a sparse SPD system. */
export function pcgSolve(S, b, { tol = 1e-8, maxit = 0, prec = 'auto', x0 = null, dofsPerNode = 1, coords = null, check = () => {} } = {}) {
  if (S.n !== S.m) throw err(t('script.linalg.pcg_square', { size: `${S.n}×${S.m}` }));
  if (b.length !== S.n) throw err(t('script.linalg.pcg_rhs', { b: b.length, n: S.n }));
  const t0 = Date.now(), M = typeof prec === 'object' ? prec : makePrec(S, prec, { dofsPerNode, coords }), t1 = Date.now();
  const r = kPcg(S, b, { x0, tol, maxIter: maxit, prec: M, cancelled: () => { check(); return false; } });
  return { x: r.x, iterations: r.iterations, residual: r.residual, converged: r.converged, prec: M.kind, setupMs: t1 - t0, ms: Date.now() - t0 };
}
/** ILU(0) of a square CSR with sorted columns → {apply}. */
export function ilu0(S) {
  const { n, rowPtr, col } = S, LU = Float64Array.from(S.val), diag = new Int32Array(n).fill(-1);
  for (let r = 0; r < n; r++) for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) if (col[k] === r) diag[r] = k;
  for (let r = 0; r < n; r++) if (diag[r] < 0) throw err(t('script.linalg.ilu0_diag'));
  const pos = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) pos[col[k]] = k;
    for (let k = rowPtr[i]; k < rowPtr[i + 1] && col[k] < i; k++) {
      const j = col[k], piv = LU[diag[j]];
      if (piv === 0) throw err(t('script.linalg.ilu0_pivot'));
      const f = (LU[k] /= piv);
      for (let q = diag[j] + 1; q < rowPtr[j + 1]; q++) { const p = pos[col[q]]; if (p >= 0) LU[p] -= f * LU[q]; }
    }
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) pos[col[k]] = -1;
  }
  return {
    kind: 'ilu0',
    apply(r, z) {
      for (let i = 0; i < n; i++) { let s = r[i]; for (let k = rowPtr[i]; k < diag[i]; k++) s -= LU[k] * z[col[k]]; z[i] = s; }
      for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = diag[i] + 1; k < rowPtr[i + 1]; k++) s -= LU[k] * z[col[k]]; z[i] = s / LU[diag[i]]; }
      return z;
    },
  };
}
/** Right-preconditioned BiCGSTAB (van der Vorst 1992). */
export function bicgstabSolve(S, b, { tol = 1e-8, maxit = 0, prec = 'ilu0', x0 = null, check = () => {} } = {}) {
  const n = S.n, t0 = Date.now();
  const M = prec === 'ilu0' ? ilu0(S) : prec === 'jacobi' ? jacobiPrec(S) : { kind: 'none', apply(r, z) { z.set(r); return z; } };
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n), r = new Float64Array(n), rh = new Float64Array(n), p = new Float64Array(n), v = new Float64Array(n);
  const s = new Float64Array(n), t = new Float64Array(n), ph = new Float64Array(n), sh = new Float64Array(n);
  const dot = (a, c) => { let q = 0; for (let i = 0; i < n; i++) q += a[i] * c[i]; return q; };
  spMulVec(S, x, r); for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
  rh.set(r);
  const bn = Math.sqrt(dot(b, b)) || 1;
  let rho = 1, alpha = 1, omega = 1, it = 0, res = Math.sqrt(dot(r, r)) / bn;
  const cap = maxit || Math.max(1000, 2 * n);
  for (; it < cap && res >= tol; it++) {
    if ((it & 31) === 0) check();
    const rho1 = dot(rh, r);
    if (rho1 === 0) break;
    const beta = (rho1 / rho) * (alpha / omega); rho = rho1;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * (p[i] - omega * v[i]);
    M.apply(p, ph); spMulVec(S, ph, v);
    alpha = rho / dot(rh, v);
    for (let i = 0; i < n; i++) s[i] = r[i] - alpha * v[i];
    if (Math.sqrt(dot(s, s)) / bn < tol) { for (let i = 0; i < n; i++) x[i] += alpha * ph[i]; res = Math.sqrt(dot(s, s)) / bn; it++; break; }
    M.apply(s, sh); spMulVec(S, sh, t);
    omega = dot(t, s) / dot(t, t);
    for (let i = 0; i < n; i++) { x[i] += alpha * ph[i] + omega * sh[i]; r[i] = s[i] - omega * t[i]; }
    res = Math.sqrt(dot(r, r)) / bn;
    if (omega === 0) break;
  }
  return { x, iterations: it, residual: res, converged: res < tol, prec: M.kind, ms: Date.now() - t0 };
}

// ─────────────────────────────────────────────────────────────── dense kernels (column-major)
export function matmul(A, B) {
  const [n, k] = size2(A), [k2, m] = size2(B);
  if (k !== k2) throw err(t('script.linalg.inner_sizes', { a: `${n}×${k}`, b: `${k2}×${m}` }));
  const a = A.data, b = B.data, c = new Float64Array(n * m);
  for (let j = 0; j < m; j++) {
    const cj = j * n;
    for (let p = 0; p < k; p++) { const bv = b[p + j * k]; if (bv === 0) continue; const ap = p * n; for (let i = 0; i < n; i++) c[cj + i] += a[ap + i] * bv; }
  }
  return mat(n, m, c);
}
const transposeD = (A) => { const [n, m] = size2(A), d = new Float64Array(n * m); for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) d[j + i * m] = A.data[i + j * n]; return mat(m, n, d); };
/** LU with partial pivoting (in place on a copy) → { LU, piv (row order), sign, singular } */
export function luFactor(A) {
  const [n, m] = size2(A);
  if (n !== m) throw err(t('script.linalg.square', { size: `${n}×${m}` }));
  const a = Float64Array.from(A.data), piv = Int32Array.from({ length: n }, (_, i) => i);
  let sign = 1, singular = false;
  let scale = 0; for (const v of a) scale = Math.max(scale, Math.abs(v));
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(a[c + c * n]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(a[r + c * n]); if (v > best) { best = v; p = r; } }
    if (best <= 1e-15 * scale || best === 0) { singular = true; continue; }
    if (p !== c) { for (let k = 0; k < n; k++) { const t = a[c + k * n]; a[c + k * n] = a[p + k * n]; a[p + k * n] = t; } const t = piv[c]; piv[c] = piv[p]; piv[p] = t; sign = -sign; }
    const d = a[c + c * n];
    for (let r = c + 1; r < n; r++) a[r + c * n] /= d;
    for (let k = c + 1; k < n; k++) { const f = a[c + k * n]; if (f === 0) continue; const ck = k * n, cc = c * n; for (let r = c + 1; r < n; r++) a[r + ck] -= a[r + cc] * f; }
  }
  return { n, LU: a, piv, sign, singular };
}
function luSolveInto(F, B) {   // B dense n×m → X
  const { n, LU, piv } = F, [, m] = size2(B), X = new Float64Array(n * m);
  for (let j = 0; j < m; j++) {
    const x = X.subarray(j * n, (j + 1) * n), b = B.data.subarray(j * n, (j + 1) * n);
    for (let i = 0; i < n; i++) x[i] = b[piv[i]];
    for (let c = 0; c < n; c++) { const v = x[c]; if (v) for (let r = c + 1; r < n; r++) x[r] -= LU[r + c * n] * v; }
    for (let c = n - 1; c >= 0; c--) { x[c] /= LU[c + c * n]; const v = x[c]; if (v) for (let r = 0; r < c; r++) x[r] -= LU[r + c * n] * v; }
  }
  return mat(n, m, X);
}
/** Cholesky A = Rᵀ R (upper R) or null when not positive definite. */
export function cholFactor(A) {
  const [n, m] = size2(A);
  if (n !== m) throw err(t('script.linalg.square', { size: `${n}×${m}` }));
  const a = A.data, R = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let d = a[j + j * n];
    for (let k = 0; k < j; k++) d -= R[k + j * n] * R[k + j * n];
    if (!(d > 0)) return null;
    const rjj = Math.sqrt(d); R[j + j * n] = rjj;
    for (let i = j + 1; i < n; i++) { let s = a[j + i * n]; for (let k = 0; k < j; k++) s -= R[k + j * n] * R[k + i * n]; R[j + i * n] = s / rjj; }
  }
  return mat(n, n, R);
}
const isSymD = (A, rel = 1e-12) => { const [n, m] = size2(A); if (n !== m) return false; let mx = 0; for (const v of A.data) mx = Math.max(mx, Math.abs(v)); for (let j = 0; j < n; j++) for (let i = j + 1; i < n; i++) if (Math.abs(A.data[i + j * n] - A.data[j + i * n]) > rel * (mx || 1)) return false; return true; };
function cholSolve(R, B) {   // Rᵀ R X = B
  const n = R.shape[0], [, m] = size2(B), X = Float64Array.from(B.data), r = R.data;
  for (let j = 0; j < m; j++) {
    const x = X.subarray(j * n, (j + 1) * n);
    for (let i = 0; i < n; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= r[k + i * n] * x[k]; x[i] = s / r[i + i * n]; }
    for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= r[i + k * n] * x[k]; x[i] = s / r[i + i * n]; }
  }
  return mat(n, m, X);
}
/** Householder QR → { Q (n×n or n×k econ), R } */
export function qrFactor(A, econ = false) {
  const [n, m] = size2(A), a = Float64Array.from(A.data), k = Math.min(n, m), vs = [], betas = [];
  for (let c = 0; c < k; c++) {
    let nrm = 0; for (let r = c; r < n; r++) nrm += a[r + c * n] ** 2;
    nrm = Math.sqrt(nrm);
    const v = new Float64Array(n - c);
    if (nrm === 0) { vs.push(v); betas.push(0); continue; }
    const alpha = a[c + c * n] > 0 ? -nrm : nrm;
    for (let r = c; r < n; r++) v[r - c] = a[r + c * n];
    v[0] -= alpha;
    let vv = 0; for (const x of v) vv += x * x;
    const beta = vv ? 2 / vv : 0;
    for (let j = c; j < m; j++) { let s = 0; for (let r = c; r < n; r++) s += v[r - c] * a[r + j * n]; s *= beta; for (let r = c; r < n; r++) a[r + j * n] -= s * v[r - c]; }
    vs.push(v); betas.push(beta);
  }
  const qc = econ ? k : n, Q = new Float64Array(n * qc);
  for (let i = 0; i < qc; i++) Q[i + i * n] = 1;
  for (let c = k - 1; c >= 0; c--) {
    const v = vs[c], beta = betas[c]; if (!beta) continue;
    for (let j = 0; j < qc; j++) { let s = 0; for (let r = c; r < n; r++) s += v[r - c] * Q[r + j * n]; s *= beta; for (let r = c; r < n; r++) Q[r + j * n] -= s * v[r - c]; }
  }
  const rr = econ ? k : n, R = new Float64Array(rr * m);
  for (let j = 0; j < m; j++) for (let i = 0; i <= Math.min(j, rr - 1); i++) R[i + j * rr] = a[i + j * n];
  return { Q: mat(n, qc, Q), R: mat(rr, m, R) };
}
/** Symmetric eigen-decomposition (tred2 + tql2) → { d ascending Float64Array, V column-major n×n } */
export function symEigen(A, wantV = true) {
  const [n, m] = size2(A);
  if (n !== m) throw err(t('script.linalg.eig_square', { size: `${n}×${m}` }));
  const V = Float64Array.from(A.data), d = new Float64Array(n), e = new Float64Array(n);
  const v = (i, j) => V[i + j * n];
  // tred2 (JAMA's port of EISPACK), V symmetric in, orthogonal out
  for (let j = 0; j < n; j++) d[j] = v(n - 1, j);
  for (let i = n - 1; i > 0; i--) {
    let scale = 0, h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j++) { d[j] = v(i - 1, j); V[i + j * n] = 0; V[j + i * n] = 0; }
    } else {
      for (let k = 0; k < i; k++) { d[k] /= scale; h += d[k] * d[k]; }
      let f = d[i - 1], g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g; h -= f * g; d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j]; V[j + i * n] = f; g = e[j] + v(j, j) * f;
        for (let k = j + 1; k <= i - 1; k++) { g += v(k, j) * d[k]; e[k] += v(k, j) * f; }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) { e[j] /= h; f += e[j] * d[j]; }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] -= hh * d[j];
      for (let j = 0; j < i; j++) {
        f = d[j]; g = e[j];
        for (let k = j; k <= i - 1; k++) V[k + j * n] -= f * e[k] + g * d[k];
        d[j] = v(i - 1, j); V[i + j * n] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[n - 1 + i * n] = v(i, i); V[i + i * n] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = v(k, i + 1) / h;
      for (let j = 0; j <= i; j++) {
        let g = 0; for (let k = 0; k <= i; k++) g += v(k, i + 1) * v(k, j);
        for (let k = 0; k <= i; k++) V[k + j * n] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k++) V[k + (i + 1) * n] = 0;
  }
  for (let j = 0; j < n; j++) { d[j] = v(n - 1, j); V[n - 1 + j * n] = 0; }
  if (n) V[n - 1 + (n - 1) * n] = 1;
  e[0] = 0;
  // tql2
  for (let i = 1; i < n; i++) e[i - 1] = e[i];
  if (n) e[n - 1] = 0;
  let f = 0, tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m2 = l;
    while (m2 < n) { if (Math.abs(e[m2]) <= eps * tst1) break; m2++; }
    if (m2 > l) {
      let iter = 0;
      do {
        if (++iter > 60) throw err(t('script.linalg.eig_noconv'));
        let g = d[l], p = (d[l + 1] - g) / (2 * e[l]), r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r); d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1]; let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        p = d[m2];
        let c = 1, c2 = c, c3 = c, el1 = e[l + 1], s = 0, s2 = 0;
        for (let i = m2 - 1; i >= l; i--) {
          c3 = c2; c2 = c; s2 = s;
          g = c * e[i]; h = c * p; r = Math.hypot(p, e[i]);
          e[i + 1] = s * r; s = e[i] / r; c = p / r; p = c * d[i] - s * g; d[i + 1] = h + s * (c * g + s * d[i]);
          if (wantV) for (let k = 0; k < n; k++) { h = V[k + (i + 1) * n]; V[k + (i + 1) * n] = s * V[k + i * n] + c * h; V[k + i * n] = c * V[k + i * n] - s * h; }
        }
        p = -s * s2 * c3 * el1 * e[l] / dl1; e[l] = s * p; d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1);
    }
    d[l] += f; e[l] = 0;
  }
  // sort ascending
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[a] - d[b]);
  const ds = Float64Array.from(ord, (i) => d[i]), Vs = new Float64Array(n * n);
  ord.forEach((i, j) => Vs.set(V.subarray(i * n, (i + 1) * n), j * n));
  return { d: ds, V: Vs };
}
/** Generalized symmetric-definite K v = λ M v (dense) → { d, V } with Vᵀ M V = I. */
export function symGenEigen(K, M) {
  const R = cholFactor(M);
  if (!R) throw err(t('script.linalg.eig_second_spd'));
  const n = K.shape[0], r = R.data;
  // C = R⁻ᵀ K R⁻¹
  const Y = Float64Array.from(K.data);   // Y = R⁻ᵀ K (solve Rᵀ Y = K column by column)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = Y[i + j * n]; for (let k = 0; k < i; k++) s -= r[k + i * n] * Y[k + j * n]; Y[i + j * n] = s / r[i + i * n]; }
  const C = new Float64Array(n * n);   // C = Y R⁻¹ → Cᵀ = R⁻ᵀ Yᵀ
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) C[j + i * n] = Y[i + j * n];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = C[i + j * n]; for (let k = 0; k < i; k++) s -= r[k + i * n] * C[k + j * n]; C[i + j * n] = s / r[i + i * n]; }
  for (let j = 0; j < n; j++) for (let i = j + 1; i < n; i++) { const m = (C[i + j * n] + C[j + i * n]) / 2; C[i + j * n] = C[j + i * n] = m; }
  const { d, V } = symEigen(mat(n, n, C));
  // v = R⁻¹ y
  for (let j = 0; j < n; j++) for (let i = n - 1; i >= 0; i--) { let s = V[i + j * n]; for (let k = i + 1; k < n; k++) s -= r[i + k * n] * V[k + j * n]; V[i + j * n] = s / r[i + i * n]; }
  return { d, V };
}

// ─────────────────────────────────────────────────────────────── solve dispatch
/** A \ B for dense or sparse A → { X (tensor), method, info } */
export function solve(A, B, { check = () => {}, tol = 1e-10, prec = 'auto' } = {}) {
  B = asTensor(B, t('script.linalg.what.rhs'));
  const [bn, bm] = size2(B);
  if (isSparse(A)) {
    if (A.n !== A.m) throw err(t('script.linalg.solve_square', { size: `${A.n}×${A.m}` }));
    if (bn !== A.n) throw err(t('script.linalg.solve_rhs', { b: bn, n: A.n }));
    const sym = spIsSymmetric(A);
    if (A.n <= 200) return solve(toDense(A), B, { check });
    if (sym) {
      let F = null;
      try { F = envelopeCholesky(A, { check }); } catch (e) { if (!e.notPD) throw e; F = false; }
      if (F) { const X = new Float64Array(bn * bm); for (let j = 0; j < bm; j++) F.solve(B.data.subarray(j * bn, (j + 1) * bn), X.subarray(j * bn, (j + 1) * bn)); return { X: mat(bn, bm, X), method: F.kind, info: { envelope: F.envelope, ms: F.ms } }; }
      if (F === null) {   // too big for the envelope: PCG
        const M = makePrec(A, prec), X = new Float64Array(bn * bm), its = [];
        for (let j = 0; j < bm; j++) {
          const r = pcgSolve(A, B.data.subarray(j * bn, (j + 1) * bn), { tol, prec: M, check });
          if (!r.converged) throw err(t('script.linalg.solve_pcg', { res: r.residual.toExponential(2), its: r.iterations }));
          X.set(r.x, j * bn); its.push(r.iterations);
        }
        return { X: mat(bn, bm, X), method: `pcg + ${M.kind}`,   // i18n-ignore: a method name scripts read from info.method
        info: { iterations: its } };
      }
      // symmetric but not positive definite: fall through to the general path
    }
    if (A.n <= DENSE_MAX) return solve(toDense(A), B, { check });
    const X = new Float64Array(bn * bm);
    for (let j = 0; j < bm; j++) {
      const r = bicgstabSolve(A, B.data.subarray(j * bn, (j + 1) * bn), { tol, check });
      if (!r.converged) throw err(t('script.linalg.solve_bicg', { res: r.residual.toExponential(2) }));
      X.set(r.x, j * bn);
    }
    return { X: mat(bn, bm, X), method: 'bicgstab + ilu0', info: {} };   // i18n-ignore: a method name scripts read
  }
  A = asTensor(A, t('script.linalg.what.matrix'));
  const [n, m] = size2(A);
  if (n === 1 && m === 1) return { X: mat(bn, bm, B.data.map((v) => v / A.data[0])), method: 'scalar', info: {} };
  if (bn !== n) throw err(t('script.linalg.solve_rhs', { b: bn, n }));
  if (n !== m) {   // least squares via QR (full column rank assumed)
    if (n < m) throw err(t('script.linalg.solve_under'));
    const { Q, R } = qrFactor(A, true), QtB = matmul(transposeD(Q), B), X = new Float64Array(m * bm);
    for (let j = 0; j < bm; j++) for (let i = m - 1; i >= 0; i--) { let s = QtB.data[i + j * m]; for (let k = i + 1; k < m; k++) s -= R.data[i + k * m] * X[k + j * m]; const d = R.data[i + i * m]; if (Math.abs(d) < 1e-14) throw err(t('script.linalg.solve_rank')); X[i + j * m] = s / d; }
    return { X: mat(m, bm, X), method: 'least squares (QR)', info: {} };   // i18n-ignore: a method name scripts read
  }
  if (isSymD(A)) { const R = cholFactor(A); if (R) return { X: cholSolve(R, B), method: 'Cholesky', info: {} }; }
  const F = luFactor(A);
  if (F.singular) throw err(t('script.linalg.solve_singular'));
  return { X: luSolveInto(F, B), method: 'LU', info: {} };
}

// ─────────────────────────────────────────────────────────────── eigs (small symmetric generalized)
export function eigsSolve(K, M, k, { sigma = 0, tol = 1e-10, maxit = 300, check = () => {} } = {}) {
  const n = isSparse(K) ? K.n : size2(K)[0];
  if (!Number.isInteger(k) || k < 1 || k > n) throw err(t('script.linalg.eigs_k', { n }));
  if (M && (isSparse(M) ? M.n : size2(M)[0]) !== n) throw err(t('script.linalg.eigs_size'));
  if (n <= DENSE_EIG) {
    const Kd = isSparse(K) ? toDense(K) : asTensor(K), Md = M ? (isSparse(M) ? toDense(M) : asTensor(M)) : null;
    const { d, V } = Md ? symGenEigen(Kd, Md) : symEigen(Kd);
    return { d: d.slice(0, k), V: V.slice(0, n * k), iterations: 0, method: 'dense' };
  }
  const Ks = isSparse(K) ? K : fromDense(asTensor(K)), Ms = M ? (isSparse(M) ? M : fromDense(asTensor(M))) : null;
  const shifted = sigma ? spAdd(Ks, Ms || speyeS(n), 1, -sigma) : Ks;
  let F = envelopeCholesky(shifted, { check });
  const solveK = F ? (b, x) => F.solve(b, x) : (() => { const P = makePrec(shifted, 'auto'); return (b, x) => { const r = pcgSolve(shifted, b, { tol: 1e-12, prec: P, check }); x.set(r.x); return x; }; })();
  const Mmul = Ms ? (x, y) => spMulVec(Ms, x, y) : (x, y) => { y.set(x); return y; };
  const p = Math.min(n, Math.max(2 * k, k + 8));
  let X = new Float64Array(n * p);
  let s = 12345; for (let i = 0; i < X.length; i++) { s = (s * 16807) % 2147483647; X[i] = s / 2147483647 - 0.5; }
  let lam = new Float64Array(k).fill(Infinity), it = 0;
  const Y = new Float64Array(n * p), tw = new Float64Array(n), u = new Float64Array(n);
  for (; it < maxit; it++) {
    check();
    for (let j = 0; j < p; j++) { Mmul(X.subarray(j * n, (j + 1) * n), tw); solveK(tw, Y.subarray(j * n, (j + 1) * n)); }
    // Rayleigh–Ritz: Kr = Yᵀ(K−σM)Y, Mr = YᵀMY
    const Kr = new Float64Array(p * p), Mr = new Float64Array(p * p), KY = new Float64Array(n * p), MY = new Float64Array(n * p);
    for (let j = 0; j < p; j++) { spMulVec(shifted, Y.subarray(j * n, (j + 1) * n), u); KY.set(u, j * n); Mmul(Y.subarray(j * n, (j + 1) * n), u); MY.set(u, j * n); }
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { let s1 = 0, s2 = 0; for (let i = 0; i < n; i++) { const ya = Y[a * n + i]; s1 += ya * KY[b * n + i]; s2 += ya * MY[b * n + i]; } Kr[a + b * p] = Kr[b + a * p] = s1; Mr[a + b * p] = Mr[b + a * p] = s2; }
    const { d, V: Q } = symGenEigen(mat(p, p, Kr), mat(p, p, Mr));
    X = new Float64Array(n * p);
    for (let j = 0; j < p; j++) for (let a = 0; a < p; a++) { const q = Q[a + j * p]; if (q) for (let i = 0; i < n; i++) X[j * n + i] += Y[a * n + i] * q; }
    let done = true;
    for (let j = 0; j < k; j++) { if (!(Math.abs(d[j] - lam[j]) <= tol * Math.max(1e-300, Math.abs(d[j])))) done = false; lam[j] = d[j]; }
    if (done) break;
  }
  return { d: Float64Array.from(lam, (v) => v + sigma), V: X.slice(0, n * k), iterations: it + 1, method: F ? 'subspace iteration (envelope Cholesky)' : 'subspace iteration (pcg)' };   // i18n-ignore: method names scripts read
}
const speyeS = (n) => sp(n, n, Int32Array.from({ length: n + 1 }, (_, i) => i), Int32Array.from({ length: n }, (_, i) => i), new Float64Array(n).fill(1));

// ─────────────────────────────────────────────────────────────── assembly of equal-size element matrices (no triplets)
/**
 * K = Σ_e w_e · P_eᵀ Ke(e) P_e — edof (ne × nd, 1-based dof numbers), Ke (nd × nd, or nd × nd × ne), w (ne, optional),
 * n (size, default the largest dof). → sparse n × n. Pattern built once from the connectivity (no triplet arrays).
 */
export function assembleElements(edof, Ke, w = null, n = 0, check = () => {}) {
  const [ne, nd] = size2(edof, 'edof');
  const per = Ke.shape.length === 3 && Ke.shape[2] > 1;
  if (Ke.shape[0] !== nd || Ke.shape[1] !== nd || (per && Ke.shape[2] !== ne)) throw err(t('script.linalg.assemble_ke', { size: `${nd}×${nd}${per ? `×${ne}` : ''}`, nd }));
  if (w && w.length !== ne) throw err(t('script.linalg.assemble_w', { w: w.length, ne }));
  const E = new Int32Array(ne * nd);   // row-major element dofs, 0-based
  let mx = 0;
  for (let e = 0; e < ne; e++) for (let a = 0; a < nd; a++) {
    const v = edof.data[e + a * ne];
    if (!Number.isInteger(v) || v < 1) throw err(t('script.linalg.assemble_dof', { dof: v, e: e + 1 }));
    E[e * nd + a] = v - 1; if (v > mx) mx = v;
  }
  n = n || mx;
  if (mx > n) throw err(t('script.linalg.assemble_past', { dof: mx, n }));
  // node-free pattern: for each dof, the set of dofs sharing an element
  const cnt = new Int32Array(n + 1);
  for (let i = 0; i < E.length; i++) cnt[E[i] + 1]++;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const elOf = new Int32Array(E.length), fill = cnt.slice(0, n);
  for (let e = 0; e < ne; e++) for (let a = 0; a < nd; a++) elOf[fill[E[e * nd + a]]++] = e;
  const mark = new Int32Array(n).fill(-1), rowPtr = new Int32Array(n + 1), rows = new Array(n);
  let nnz = 0;
  for (let r = 0; r < n; r++) {
    const l = [];
    for (let q = cnt[r]; q < cnt[r + 1]; q++) { const e = elOf[q]; for (let b = 0; b < nd; b++) { const c = E[e * nd + b]; if (mark[c] !== r) { mark[c] = r; l.push(c); } } }
    rows[r] = Int32Array.from(l).sort(); nnz += l.length; rowPtr[r + 1] = nnz;
    if ((r & 4095) === 0) check();
  }
  const col = new Int32Array(nnz); for (let r = 0; r < n; r++) col.set(rows[r], rowPtr[r]);
  const val = new Float64Array(nnz), loc = new Int32Array(nd * nd), K = Ke.data;
  const find = (r, c) => { let lo = rowPtr[r], hi = rowPtr[r + 1] - 1; while (lo <= hi) { const m = (lo + hi) >> 1, v = col[m]; if (v === c) return m; if (v < c) lo = m + 1; else hi = m - 1; } return -1; };
  for (let e = 0; e < ne; e++) {
    if ((e & 4095) === 0) check();
    const s = w ? w[e] : 1; if (s === 0) continue;
    const off = per ? e * nd * nd : 0;
    for (let a = 0; a < nd; a++) for (let b = 0; b < nd; b++) loc[a * nd + b] = find(E[e * nd + a], E[e * nd + b]);
    for (let b = 0; b < nd; b++) for (let a = 0; a < nd; a++) val[loc[a * nd + b]] += s * K[off + a + b * nd];
  }
  return sp(n, n, rowPtr, col, val);
}

// ─────────────────────────────────────────────────────────────── builtins
const T1 = (a, what) => asTensor(a, what);
const outOrOne = (ctx, list) => (nout(ctx) <= 1 ? list[0] : list.slice(0, Math.max(1, nout(ctx))));
const infoStruct = (o) => ({ t: 'struct', fields: Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? tensor([1, v.length], v) : v])) });

export function bi_mtimes([A, B]) {
  if (isSparse(A) && isSparse(B)) return spMulSp(A, B);
  if (isSparse(A)) { if (typeof B === 'number' || (isTensor(B) && B.data.length === 1 && A.m !== 1)) return spScale(A, scalarOf(B)); return spMulDense(A, T1(B)); }
  if (isSparse(B)) { if (typeof A === 'number' || (isTensor(A) && A.data.length === 1 && B.n !== 1)) return spScale(B, scalarOf(A)); return transposeD(spMulDense(spTranspose(B), transposeD(T1(A)))); }
  const a = T1(A), b = T1(B);
  if (a.data.length === 1) return { t: 'tensor', shape: b.shape.slice(), data: b.data.map((v) => v * a.data[0]) };
  if (b.data.length === 1) return { t: 'tensor', shape: a.shape.slice(), data: a.data.map((v) => v * b.data[0]) };
  return matmul(a, b);
}
export function bi_mldivide([A, B], ctx) { return solve(A, B, { check: checker(ctx) }).X; }
export function bi_mrdivide([B, A], ctx) {   // B / A = (Aᵀ \ Bᵀ)ᵀ
  if (typeof A === 'number' || (isTensor(A) && A.data.length === 1)) { const s = scalarOf(A); return isSparse(B) ? spScale(B, 1 / s) : (() => { const b = T1(B); return { t: 'tensor', shape: b.shape.slice(), data: b.data.map((v) => v / s) }; })(); }
  const At = isSparse(A) ? spTranspose(A) : transposeD(T1(A)), Bt = isSparse(B) ? toDense(spTranspose(B)) : transposeD(T1(B));
  return transposeD(solve(At, Bt, { check: checker(ctx) }).X);
}
export function bi_linsolve([A, B, o], ctx) {
  const r = solve(A, B, { check: checker(ctx), ...optsOf(o) });
  return outOrOne(ctx, [r.X, infoStruct({ method: r.method, ...r.info })]);
}
export function bi_inv([A]) {
  const a = T1(A, t('script.linalg.what.matrix')), [n] = size2(a), F = luFactor(a);
  if (F.singular) throw err(t('script.linalg.inv_singular'));
  const I = new Float64Array(n * n); for (let i = 0; i < n; i++) I[i + i * n] = 1;
  return luSolveInto(F, mat(n, n, I));
}
export function bi_det([A]) {
  const F = luFactor(T1(A, t('script.linalg.what.matrix')));
  if (F.singular) return 0;
  let d = F.sign; for (let i = 0; i < F.n; i++) d *= F.LU[i + i * F.n];
  return d;
}
export function bi_lu([A], ctx) {
  const F = luFactor(T1(A, t('script.linalg.what.matrix'))), n = F.n, L = new Float64Array(n * n), U = new Float64Array(n * n), P = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { if (i > j) L[i + j * n] = F.LU[i + j * n]; else U[i + j * n] = F.LU[i + j * n]; if (i === j) L[i + j * n] = 1; }
  for (let i = 0; i < n; i++) P[i + F.piv[i] * n] = 1;
  const k = nout(ctx);
  if (k <= 1) { const Y = Float64Array.from(U); for (let j = 0; j < n; j++) for (let i = j + 1; i < n; i++) Y[i + j * n] = L[i + j * n]; return mat(n, n, Y); }
  if (k === 2) { const PL = matmul(transposeD(mat(n, n, P)), mat(n, n, L)); return [PL, mat(n, n, U)]; }
  return [mat(n, n, L), mat(n, n, U), mat(n, n, P)];
}
export function bi_chol([A]) {
  const a = isSparse(A) ? toDense(A) : T1(A, t('script.linalg.what.matrix'));
  if (!isSymD(a, 1e-10)) throw err(t('script.linalg.chol_sym'));
  const R = cholFactor(a);
  if (!R) throw err(t('script.linalg.chol_pd'));
  return R;
}
export function bi_qr([A, e], ctx) {
  const { Q, R } = qrFactor(T1(A, t('script.linalg.what.matrix')), e !== undefined && scalarOf(e) === 0);
  return nout(ctx) <= 1 ? R : [Q, R];
}
export function bi_eig([A, B], ctx) {
  const a = isSparse(A) ? toDense(A) : T1(A, t('script.linalg.what.matrix'));
  if (!isSymD(a, 1e-10)) throw err(t('script.linalg.eig_sym_only'));
  const n = a.shape[0];
  let r;
  if (B !== undefined) { const b = isSparse(B) ? toDense(B) : T1(B, t('script.linalg.what.matrix')); if (!isSymD(b, 1e-10)) throw err(t('script.linalg.eig_second_sym')); r = symGenEigen(a, b); }
  else r = symEigen(a, nout(ctx) > 1);
  if (nout(ctx) <= 1) return mat(n, 1, r.d);
  const D = new Float64Array(n * n); for (let i = 0; i < n; i++) D[i + i * n] = r.d[i];
  return [mat(n, n, r.V), mat(n, n, D)];
}
export function normOf(A, p = 2) {
  if (isSparse(A)) A = toDense(A);
  const a = T1(A), [n, m] = size2(a), d = a.data;
  if (p === 'fro' || ((n === 1 || m === 1) && p === 2)) { let s = 0; for (const v of d) s += v * v; return Math.sqrt(s); }
  if (n === 1 || m === 1) {
    if (p === Infinity || p === 'inf') { let s = 0; for (const v of d) s = Math.max(s, Math.abs(v)); return s; }
    if (p === -Infinity) { let s = Infinity; for (const v of d) s = Math.min(s, Math.abs(v)); return s; }
    if (typeof p !== 'number' || !(p > 0)) throw err(t('script.linalg.norm_p'));
    let s = 0; for (const v of d) s += Math.abs(v) ** p; return s ** (1 / p);
  }
  if (p === 1) { let s = 0; for (let j = 0; j < m; j++) { let c = 0; for (let i = 0; i < n; i++) c += Math.abs(d[i + j * n]); s = Math.max(s, c); } return s; }
  if (p === Infinity || p === 'inf') { let s = 0; for (let i = 0; i < n; i++) { let c = 0; for (let j = 0; j < m; j++) c += Math.abs(d[i + j * n]); s = Math.max(s, c); } return s; }
  if (p === 2) { const { d: ev } = symEigen(matmul(transposeD(a), a), false); return Math.sqrt(Math.max(0, ev[ev.length - 1])); }
  throw err(t('script.linalg.norm_matrix_p'));
}
export function bi_norm([A, p]) { return normOf(A, p === undefined ? 2 : typeof p === 'string' ? (p === 'inf' || p === 'Inf' ? Infinity : p) : scalarOf(p)); }
export function bi_cond([A]) {
  const a = isSparse(A) ? toDense(A) : T1(A, t('script.linalg.what.matrix'));
  const { d } = symEigen(matmul(transposeD(a), a), false);
  const lo = Math.max(0, d[0]), hi = Math.max(0, d[d.length - 1]);
  return lo === 0 ? Infinity : Math.sqrt(hi / lo);
}

export function bi_sparse(args) {
  if (args.length === 1) { if (isSparse(args[0])) return args[0]; return fromDense(T1(args[0], t('script.linalg.what.matrix'))); }
  if (args.length === 2) { const n = scalarOf(args[0], t('script.linalg.what.rows')), m = scalarOf(args[1], t('script.linalg.what.columns')); if (!(Number.isInteger(n) && Number.isInteger(m) && n >= 0 && m >= 0)) throw err(t('script.linalg.sparse_nm')); return sp(n, m, new Int32Array(n + 1), new Int32Array(0), new Float64Array(0)); }
  const [i, j, v, n0, m0] = args;
  const I = T1(i, t('script.linalg.what.row_indices')).data, J = T1(j, t('script.linalg.what.column_indices')).data, vt = T1(v, t('script.linalg.what.values'));
  let V = vt.data;
  const nz = Math.max(I.length, J.length);
  if (V.length === 1 && nz > 1) V = new Float64Array(nz).fill(V[0]);
  if (I.length !== J.length || V.length !== nz) throw err(t('script.linalg.sparse_len', { i: I.length, j: J.length, v: V.length }));
  let mi = 0, mj = 0;
  const Ii = new Int32Array(nz), Jj = new Int32Array(nz);
  for (let k = 0; k < nz; k++) {
    const a = I[k], b = J[k];
    if (!Number.isInteger(a) || a < 1) throw err(t('script.linalg.sparse_row', { k: a }));
    if (!Number.isInteger(b) || b < 1) throw err(t('script.linalg.sparse_col', { k: b }));
    Ii[k] = a - 1; Jj[k] = b - 1; if (a > mi) mi = a; if (b > mj) mj = b;
  }
  const n = n0 === undefined ? mi : scalarOf(n0, 'rows'), m = m0 === undefined ? mj : scalarOf(m0, 'columns');
  if (mi > n || mj > m) throw err(t('script.linalg.sparse_past', { size: `${n}×${m}` }));
  return fromTriplets(Ii, Jj, V, n, m);
}
export const bi_full = ([S]) => (isSparse(S) ? toDense(S) : T1(S));
export const bi_speye = ([n, m]) => { const a = scalarOf(n), b = m === undefined ? a : scalarOf(m), k = Math.min(a, b); return sp(a, b, Int32Array.from({ length: a + 1 }, (_, i) => Math.min(i, k)), Int32Array.from({ length: k }, (_, i) => i), new Float64Array(k).fill(1)); };
export const bi_nnz = ([S]) => { if (isSparse(S)) { let c = 0; for (const v of S.val) if (v !== 0) c++; return c; } let c = 0; for (const v of T1(S).data) if (v !== 0) c++; return c; };
export const bi_issparse = ([S]) => isSparse(S);
export function bi_csrmul([S, x]) {
  if (!isSparse(S)) throw err(t('script.linalg.csrmul_sparse'));
  const X = T1(x, 'vector');
  if (X.data.length === S.m && size2(X)[1] === 1) return mat(S.n, 1, spMulVec(S, X.data));
  return spMulDense(S, X);
}
export function bi_spadd([A, B, a, b]) {
  const sa = a === undefined ? 1 : scalarOf(a), sb = b === undefined ? 1 : scalarOf(b);
  if (!isSparse(A) || !isSparse(B)) throw err(t('script.linalg.spadd_sparse'));
  return spAdd(A, B, sa, sb);
}
export const bi_spscale = ([A, s]) => { if (!isSparse(A)) throw err(t('script.linalg.must_be_sparse', { fn: 'spscale' })); return spScale(A, scalarOf(s)); };
export const bi_sptranspose = ([A]) => { if (!isSparse(A)) throw err(t('script.linalg.must_be_sparse', { fn: 'sptranspose' })); return spTranspose(A); };
export function bi_spindex([A, r, c]) {
  if (!isSparse(A)) throw err(t('script.linalg.must_be_sparse', { fn: 'spindex' }));
  return spSub(A, indexList(r, A.n, t('script.linalg.what.row_index')), indexList(c === undefined ? r : c, A.m, t('script.linalg.what.column_index')));
}
export const bi_spdiag = ([A]) => { if (!isSparse(A)) throw err(t('script.linalg.must_be_sparse', { fn: 'spdiag' })); const d = spDiag(A); return mat(d.length, 1, d); };
export function bi_assemble([edof, Ke, w, n], ctx) {
  const K = T1(Ke, 'Ke');
  return assembleElements(T1(edof, 'edof'), K, w === undefined || (isTensor(w) && w.data.length === 0) ? null : T1(w, t('script.linalg.what.weights')).data, n === undefined ? 0 : scalarOf(n, t('script.linalg.what.size')), checker(ctx));
}
export function bi_pcg([K, f, o], ctx) {
  const S = isSparse(K) ? K : fromDense(T1(K, t('script.linalg.what.matrix'))), op = optsOf(o);
  const r = pcgSolve(S, vec(f), { tol: op.tol ?? 1e-8, maxit: op.maxit ?? 0, prec: strOf(op.prec) || 'auto', x0: op.x0 ? vec(op.x0) : null, dofsPerNode: op.dofsPerNode ?? 1, coords: op.coords ? vec(op.coords) : null, check: checker(ctx) });
  const x = mat(S.n, 1, r.x);
  if (nout(ctx) <= 1 && !r.converged) throw err(t('script.linalg.pcg_noconv', { res: r.residual.toExponential(2), its: r.iterations }));
  return outOrOne(ctx, [x, infoStruct({ iterations: r.iterations, residual: r.residual, converged: r.converged, prec: r.prec, setupMs: r.setupMs, ms: r.ms })]);
}
export function bi_bicgstab([A, b, o], ctx) {
  const S = isSparse(A) ? A : fromDense(T1(A, t('script.linalg.what.matrix'))), op = optsOf(o);
  const r = bicgstabSolve(S, vec(b), { tol: op.tol ?? 1e-8, maxit: op.maxit ?? 0, prec: strOf(op.prec) || 'ilu0', x0: op.x0 ? vec(op.x0) : null, check: checker(ctx) });
  if (nout(ctx) <= 1 && !r.converged) throw err(t('script.linalg.bicg_noconv', { res: r.residual.toExponential(2), its: r.iterations }));
  return outOrOne(ctx, [mat(S.n, 1, r.x), infoStruct({ iterations: r.iterations, residual: r.residual, converged: r.converged, prec: r.prec, ms: r.ms })]);
}
export function bi_eigs([K, M, k, o], ctx) {
  if (M !== undefined && !isSparse(M) && !isTensor(M) && typeof M !== 'number') { o = k; k = M; M = undefined; }   // eigs(K, k, opts)
  if (typeof M === 'number' || (isTensor(M) && M.data.length === 1 && k === undefined)) { o = k; k = M; M = undefined; }
  const op = optsOf(o), r = eigsSolve(K, M ?? null, k === undefined ? 6 : scalarOf(k, 'k'), { sigma: op.sigma ?? 0, tol: op.tol ?? 1e-10, maxit: op.maxit ?? 300, check: checker(ctx) });
  const n = r.V.length / r.d.length, kk = r.d.length;
  if (nout(ctx) <= 1) return mat(kk, 1, r.d);
  const D = new Float64Array(kk * kk); for (let i = 0; i < kk; i++) D[i + i * kk] = r.d[i];
  return [mat(n, kk, r.V), mat(kk, kk, D), infoStruct({ iterations: r.iterations, method: r.method })];
}

/** name → [fn, signature]. The one-line help is the language file's script.doc.<name> (cs-runtime.js docKey), looked up when shown. */
export const BUILTINS = {
  linsolve: [bi_linsolve, '[x, info] = linsolve(A, b, opts)'],
  inv: [bi_inv, 'X = inv(A)'],
  det: [bi_det, 'd = det(A)'],
  lu: [bi_lu, '[L, U, P] = lu(A)'],
  chol: [bi_chol, 'R = chol(A)'],
  qr: [bi_qr, '[Q, R] = qr(A) | qr(A, 0)'],
  eig: [bi_eig, 'd = eig(A) | [V, D] = eig(A) | eig(A, B)'],
  norm: [bi_norm, 'n = norm(x, p)'],
  cond: [bi_cond, 'c = cond(A)'],
  sparse: [bi_sparse, 'S = sparse(i, j, v, n, m) | sparse(A) | sparse(n, m)'],
  full: [bi_full, 'A = full(S)'],
  speye: [bi_speye, 'S = speye(n, m)'],
  nnz: [bi_nnz, 'k = nnz(A)'],
  issparse: [bi_issparse, 'tf = issparse(A)'],
  csrmul: [bi_csrmul, 'y = csrmul(S, x)'],
  spadd: [bi_spadd, 'C = spadd(A, B, a, b)'],
  spscale: [bi_spscale, 'C = spscale(A, s)'],
  sptranspose: [bi_sptranspose, 'T = sptranspose(A)'],
  spindex: [bi_spindex, 'B = spindex(A, rows, cols)'],
  spdiag: [bi_spdiag, 'd = spdiag(A)'],
  assemble: [bi_assemble, 'K = assemble(edof, Ke, w, n)'],
  pcg: [bi_pcg, '[x, info] = pcg(K, f, opts)'],
  bicgstab: [bi_bicgstab, '[x, info] = bicgstab(A, b, opts)'],
  eigs: [bi_eigs, '[V, D] = eigs(K, M, k, opts)'],
};
// ─────────────────────────────────────────────────────────────── operators on sparse values (cs-runtime.js registerMethod)
const dense = (v) => (isSparse(v) ? toDense(v) : asTensor(v));
const isScalarLike = (v) => typeof v === 'number' || typeof v === 'boolean' || (isTensor(v) && v.data.length === 1);
function denseElementwise(a, b, f) {
  const A = dense(a), B = dense(b);
  if (A.data.length === 1) return { t: 'tensor', shape: B.shape.slice(), data: B.data.map((y) => f(A.data[0], y)) };
  if (B.data.length === 1) return { t: 'tensor', shape: A.shape.slice(), data: A.data.map((x) => f(x, B.data[0])) };
  if (A.data.length !== B.data.length || A.shape.join() !== B.shape.join()) throw err(t('script.linalg.sizes_differ', { a: A.shape.join('×'), b: B.shape.join('×') }));
  return { t: 'tensor', shape: A.shape.slice(), data: A.data.map((x, i) => f(x, B.data[i])) };
}
/** S .* T keeping S's pattern (T sparse or dense of the same size). */
function spTimesPattern(S, T) {
  const out = Float64Array.from(S.val);
  if (isSparse(T)) { for (let r = 0; r < S.n; r++) { let q = T.rowPtr[r]; for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) { while (q < T.rowPtr[r + 1] && T.col[q] < S.col[k]) q++; out[k] *= q < T.rowPtr[r + 1] && T.col[q] === S.col[k] ? T.val[q] : 0; } } }
  else { const D = asTensor(T); const [n, m] = size2(D); if (n !== S.n || m !== S.m) throw err(t('script.linalg.sizes_differ', { a: `${S.n}×${S.m}`, b: `${n}×${m}` })); for (let r = 0; r < S.n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) out[k] *= D.data[r + S.col[k] * n]; }
  return sp(S.n, S.m, S.rowPtr, S.col, out);
}
/** Index arguments as the VM passes them ({type:'()', subs}) or as a plain list. */
const subsOf = (rest) => (rest.length === 1 && rest[0] && rest[0].type === '()' && Array.isArray(rest[0].subs) ? rest[0].subs : rest[0] && rest[0].type ? (() => { throw err(t(rest[0].type === '.' ? 'script.linalg.no_fields' : 'script.linalg.no_brace')); })() : rest);
export const SPARSE_METHODS = {
  plus: ([a, b]) => (isSparse(a) && isSparse(b) ? spAdd(a, b) : denseElementwise(a, b, (x, y) => x + y)),
  minus: ([a, b]) => (isSparse(a) && isSparse(b) ? spAdd(a, b, 1, -1) : denseElementwise(a, b, (x, y) => x - y)),
  uminus: ([a]) => spScale(a, -1),
  uplus: ([a]) => a,
  mtimes: (args) => bi_mtimes(args),
  times: ([a, b]) => (isScalarLike(a) ? spScale(b, scalarOf(a)) : isScalarLike(b) ? spScale(a, scalarOf(b)) : isSparse(a) ? spTimesPattern(a, b) : spTimesPattern(b, a)),
  rdivide: ([a, b]) => { if (isSparse(a) && isScalarLike(b)) return spScale(a, 1 / scalarOf(b)); return denseElementwise(a, b, (x, y) => x / y); },
  mrdivide: (args, ctx) => bi_mrdivide(args, ctx),
  mldivide: ([A, B], ctx) => solve(isSparse(A) ? A : asTensor(A), isSparse(B) ? toDense(B) : B, { check: checker(ctx) }).X,
  transpose: ([a]) => spTranspose(a),
  ctranspose: ([a]) => spTranspose(a),
  subsref: ([S, ...rest]) => {
    if (!isSparse(S)) throw err(t('script.linalg.idx_sparse'));
    const idx = subsOf(rest);
    if (idx.length !== 2) throw err(t('script.linalg.idx_two'));
    const R = spSub(S, indexList(idx[0], S.n, t('script.linalg.what.row_index')), indexList(idx[1], S.m, t('script.linalg.what.column_index')));
    return R.n === 1 && R.m === 1 ? (R.val.length ? R.val[0] : 0) : R;
  },
  subsasgn: ([S, rhs, ...rest]) => {   // the VM calls subsasgn(base, value, i1, i2) (spec §3), like subsref
    if (!isSparse(S)) throw err(t('script.linalg.asgn_sparse'));
    const idx = subsOf(rest);
    if (idx.length === 1 && (S.m === 1 || S.n === 1)) { if (S.m === 1) idx.push(1); else idx.unshift(1); }   // F(i) on a vector
    if (idx.length !== 2) throw err(t('script.linalg.asgn_two'));
    const R = indexList(idx[0], S.n, t('script.linalg.what.row_index')), C = indexList(idx[1], S.m, t('script.linalg.what.column_index'));
    const V = isSparse(rhs) ? toDense(rhs).data : asTensor(rhs, 'values').data;
    if (V.length !== 1 && V.length !== R.length * C.length) throw err(t('script.linalg.places', { size: `${R.length}×${C.length}`, v: V.length }));
    const rowSel = new Uint8Array(S.n), colSel = new Uint8Array(S.m); for (const r of R) rowSel[r] = 1; for (const c of C) colSel[c] = 1;
    const I = [], J = [], X = [];
    for (let r = 0; r < S.n; r++) for (let k = S.rowPtr[r]; k < S.rowPtr[r + 1]; k++) if (!(rowSel[r] && colSel[S.col[k]])) { I.push(r); J.push(S.col[k]); X.push(S.val[k]); }
    const last = new Map();   // repeated places: the last value wins, as MATLAB
    for (let j = 0; j < C.length; j++) for (let i = 0; i < R.length; i++) last.set(R[i] * S.m + C[j], V.length === 1 ? V[0] : V[i + j * R.length]);
    for (const [key, v] of last) if (v !== 0) { I.push(Math.floor(key / S.m)); J.push(key % S.m); X.push(v); }
    return fromTriplets(Int32Array.from(I), Int32Array.from(J), Float64Array.from(X), S.n, S.m);
  },
};
/**
 * Register every builtin and the sparse operators with cs-runtime.js. Runs once when this module is imported; calling
 * it again (or with another registry) is harmless. A name another module registered first is skipped (listed in `skipped`).
 */
export const skipped = [];
let registered = false;
export function register(registerBuiltin = rtRegisterBuiltin, registerMethod = rtRegisterMethod) {
  const own = registerBuiltin === rtRegisterBuiltin;
  if (own && registered) return skipped;
  for (const [name, [fn, args]] of Object.entries(BUILTINS)) {
    try { registerBuiltin(name, fn, { args, module: 'linalg' }); } catch { if (own) skipped.push(name); }   // doc: script.doc.<name> in the language file (cs-runtime.js docKey)
  }
  if (registerMethod) for (const [name, fn] of Object.entries(SPARSE_METHODS)) { try { registerMethod('sparse', name, fn, { module: 'linalg' }); } catch { if (own) skipped.push('sparse.' + name); } }
  if (own) registered = true;
  return skipped;
}
register();
