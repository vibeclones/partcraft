/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pool.js — a small thread pool for the solvers (DOM-free): SharedArrayBuffer + Atomics, used only when the page is cross-origin
 * isolated (COOP same-origin + COEP; /lab/partcraft sends them) — otherwise everything stays on one thread, unchanged.
 *
 * Shape. The thread that solves (the compute worker in the app, the main thread in Node) is thread 0, the coordinator; it starts
 * T − 1 helper threads (Web Workers from a blob: URL, or Node worker_threads) that share its memory. A kernel call is synchronous:
 * the coordinator writes the kernel number and its arguments into a shared control block, bumps a generation counter (Atomics.notify),
 * does its own share, and waits (spin, then Atomics.wait) until every helper has done its share. Helpers spin briefly, then sleep in
 * Atomics.wait. The kernels are one function (`kernels` below) that both the coordinator and the helpers run (its source is sent to
 * the helpers), so every thread computes with the same code.
 *
 * Memory. Kernels read and write only shared arrays: pool.f64(n) / pool.i32(n) / pool.share(typedArray) allocate them on
 * SharedArrayBuffers and queue them for the helpers; the queue is handed over (postMessage + an Atomics handshake: the helpers step
 * out of their wait loop to receive it) before the next kernel. Ids are never reused; pool.free(arrays) releases them.
 *
 * Determinism. Element and row loops are partitioned so each output entry is written by one thread, summing in the serial order
 * (voxel K·x gathers per node over its elements in element order = fea.js applyK's scatter order): BITWISE equal to the one-thread
 * code. Dot products sum fixed 4096-entry chunks, then the chunks in order on the coordinator: the same for any thread count, and
 * within rounding (~1e-16 relative per sum) of the serial loop.
 *
 *   await ensurePool(threads)  → info { threads, isolated, requested }   (threads ≤ 1 or not isolated: no pool)
 *   getPool() → the pool or null; pool.n (threads incl. the coordinator); pool.big(n): worth threading at this size
 *   poolInfo() → { threads, isolated, requested, why }
 *   AUTO_THREADS(): hardwareConcurrency − 1, at most MAX_THREADS
 */
export const MAX_THREADS = 16;
export const MIN_PARALLEL = 20000;   // vector length (unknowns) below which a solve stays on one thread (measured: see docs)
let minParallel = MIN_PARALLEL;
/** Tests: the size threshold (MIN_PARALLEL by default). */
export const setMinParallel = (n) => { minParallel = n > 0 ? n : MIN_PARALLEL; };
const CH = 4096;                     // reduction chunk
const SPIN_HELPER = 20000, SPIN_MAIN = 200000;
const NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof window === 'undefined';

/** SharedArrayBuffer usable here: Node, or a cross-origin isolated page / worker. */
export const isolated = () => typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object' && (NODE || globalThis.crossOriginIsolated === true);
export const AUTO_THREADS = () => Math.max(1, Math.min(MAX_THREADS, ((globalThis.navigator && navigator.hardwareConcurrency) || (NODE ? 4 : 1)) - 1));

import { t } from './i18n.js';

let POOL = null, REQUESTED = 1, WHY = '';   // WHY: 'chosen' | 'isolation' | an error message | '' (threadWords puts it in words)
export const getPool = () => POOL;
export const poolInfo = () => ({ threads: POOL ? POOL.n : 1, isolated: isolated(), requested: REQUESTED, why: POOL ? '' : WHY });

// control block (Int32): generation, done count, kernel, ack count, then integer arguments
const GEN = 0, DONE = 1, OP = 2, ACK = 3, IARG = 8, NI = 56;
const OP_RECV = -1, OP_QUIT = -2;

/**
 * The kernels: kernels(B, I, F, P) → [fn(t, T)], run by every thread on its share t of T. B: shared arrays by id; I: integer
 * arguments (ids, sizes); F: float arguments; P: the reduction partials (one per 4096-chunk). No closures over this module: the
 * helpers get this function's source.
 */
function kernels(B, I, F, P) {
  const CHUNK = 4096;
  const span = (n, t, T) => [Math.floor(n * t / T), Math.floor(n * (t + 1) / T)];
  const chunked = (n, t, T, fn) => { const nc = Math.ceil(n / CHUNK), [c0, c1] = span(nc, t, T); for (let c = c0; c < c1; c++) P[c] = fn(c * CHUNK, Math.min(n, (c + 1) * CHUNK)); };
  const part = (id, t) => { const p = B[id]; return [p[t], p[t + 1]]; };   // a partition array (T + 1 boundaries)
  return [
    // 0 dot: P ← chunks of Σ a·b   I: a, b, n
    (t, T) => { const a = B[I[0]], b = B[I[1]]; chunked(I[2], t, T, (i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i] * b[i]; return s; }); },
    // 1 cg update: x += α p, r −= α q; P ← chunks of r·r   I: x, p, r, q, n  F: α
    (t, T) => { const x = B[I[0]], p = B[I[1]], r = B[I[2]], q = B[I[3]], a = F[0]; chunked(I[4], t, T, (i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) { x[i] += a * p[i]; r[i] -= a * q[i]; s += r[i] * r[i]; } return s; }); },
    // 2 p = z + β p   I: p, z, n  F: β
    (t, T) => { const p = B[I[0]], z = B[I[1]], b = F[0], [i0, i1] = span(I[2], t, T); for (let i = i0; i < i1; i++) p[i] = z[i] + b * p[i]; },
    // 3 CSR y = A x over a row partition   I: rowPtr, cols, vals, x, y, part
    (t, T) => { const rp = B[I[0]], cl = B[I[1]], v = B[I[2]], x = B[I[3]], y = B[I[4]], [r0, r1] = part(I[5], t); for (let r = r0; r < r1; r++) { let s = 0; for (let k = rp[r]; k < rp[r + 1]; k++) s += v[k] * x[cl[k]]; y[r] = s; } },
    // 4 copy / fill: y = x (x ≥ 0) or y = F0   I: y, x|−1, n
    (t, T) => { const y = B[I[0]], [i0, i1] = span(I[2], t, T); if (I[1] >= 0) { const x = B[I[1]]; for (let i = i0; i < i1; i++) y[i] = x[i]; } else { const c = F[0]; for (let i = i0; i < i1; i++) y[i] = c; } },
    // 5 voxel K x, gathered per node over its elements in element order (= fea.js applyK's scatter, bitwise); explicit levels
    //   (mg.js) take one 24×24 matrix per element; an optional penalty block per constrained node is added last (mg level 0)
    //   I: nodePtr, nodeElem (m·8 + corner), node0, off, Ke, scale|−1, x, y, nodes(nn), explicit(0|1), consIdx|−1, pen|−1, nodePart  F: kScale
    (t, T) => {
      const np = B[I[0]], ne = B[I[1]], n0 = B[I[2]], off = B[I[3]], K = B[I[4]], sc = I[5] >= 0 ? B[I[5]] : null, x = B[I[6]], y = B[I[7]], expl = I[9] === 1;
      const ci = I[10] >= 0 ? B[I[10]] : null, pen = I[11] >= 0 ? B[I[11]] : null, kS = F[0], [a0, a1] = part(I[12], t);
      const xe = new Float64Array(24);
      for (let n = a0; n < a1; n++) {
        let y0 = 0, y1 = 0, y2 = 0;
        for (let k = np[n]; k < np[n + 1]; k++) {
          const m = ne[k] >> 3, c = ne[k] & 7, s = expl ? 1 : (sc ? sc[m] * kS : kS);
          if (s === 0) continue;
          const b0 = n0[m];
          for (let q = 0; q < 8; q++) { const d = 3 * (b0 + off[q]); xe[3 * q] = x[d]; xe[3 * q + 1] = x[d + 1]; xe[3 * q + 2] = x[d + 2]; }
          const base = expl ? m * 576 : 0, r = base + 3 * c * 24;
          let t0 = 0, t1 = 0, t2 = 0;
          for (let j = 0; j < 24; j++) { const v = xe[j]; t0 += K[r + j] * v; t1 += K[r + 24 + j] * v; t2 += K[r + 48 + j] * v; }
          if (expl) { y0 += t0; y1 += t1; y2 += t2; } else { y0 += s * t0; y1 += s * t1; y2 += s * t2; }
        }
        if (ci && ci[n] >= 0) { const p = 9 * ci[n], d = 3 * n, a = x[d], b = x[d + 1], cc = x[d + 2]; y0 += pen[p] * a + pen[p + 1] * b + pen[p + 2] * cc; y1 += pen[p + 3] * a + pen[p + 4] * b + pen[p + 5] * cc; y2 += pen[p + 6] * a + pen[p + 7] * b + pen[p + 8] * cc; }
        y[3 * n] = y0; y[3 * n + 1] = y1; y[3 * n + 2] = y2;
      }
    },
    // 6 3×3 blocks per node: dst = M src (+= when I[4] = 1: x += ω M (b − r) for the mg smoother)   I: M, src, dst, nn, mode, b|−1  F: ω
    (t, T) => {
      const M = B[I[0]], src = B[I[1]], dst = B[I[2]], [n0, n1] = span(I[3], t, T), mode = I[4];
      if (mode === 0) for (let nd = n0; nd < n1; nd++) { const d = 3 * nd, m = 9 * nd, x = src[d], y = src[d + 1], w = src[d + 2]; dst[d] = M[m] * x + M[m + 1] * y + M[m + 2] * w; dst[d + 1] = M[m + 3] * x + M[m + 4] * y + M[m + 5] * w; dst[d + 2] = M[m + 6] * x + M[m + 7] * y + M[m + 8] * w; }
      else { const b = B[I[5]], om = F[0]; for (let nd = n0; nd < n1; nd++) { const d = 3 * nd, m = 9 * nd, e0 = b[d] - src[d], e1 = b[d + 1] - src[d + 1], e2 = b[d + 2] - src[d + 2]; dst[d] += om * (M[m] * e0 + M[m + 1] * e1 + M[m + 2] * e2); dst[d + 1] += om * (M[m + 3] * e0 + M[m + 4] * e1 + M[m + 5] * e2); dst[d + 2] += om * (M[m + 6] * e0 + M[m + 7] * e1 + M[m + 8] * e2); } }
    },
    // 7 project (fea.js projector): inactive nodes 0, constrained nodes v ← P v   I: v, active, nn, consNodes, P, ncons
    (t, T) => {
      const v = B[I[0]], act = B[I[1]], [n0, n1] = span(I[2], t, T);
      for (let n = n0; n < n1; n++) if (!act[n]) { v[3 * n] = 0; v[3 * n + 1] = 0; v[3 * n + 2] = 0; }
      if (I[5] > 0) { const cn = B[I[3]], P = B[I[4]], [m0, m1] = span(I[5], t, T); for (let m = m0; m < m1; m++) { const d = 3 * cn[m], p = 9 * m, x = v[d], y = v[d + 1], z = v[d + 2]; v[d] = P[p] * x + P[p + 1] * y + P[p + 2] * z; v[d + 1] = P[p + 3] * x + P[p + 4] * y + P[p + 5] * z; v[d + 2] = P[p + 6] * x + P[p + 7] * y + P[p + 8] * z; } }
    },
    // 8 y = a − y   I: a, y, n
    (t, T) => { const a = B[I[0]], y = B[I[1]], [i0, i1] = span(I[2], t, T); for (let i = i0; i < i1; i++) y[i] = a[i] - y[i]; },
    // 9 mg restriction gathered per coarse node (fine nodes in increasing order = mg.js restrict's scatter order)
    //   I: rf, rc, fineActive, FNX, FNY, FNZ (fine node counts per axis), CNX, CNY, CNZ  (coarse node range by t)
    (t, T) => {
      const rf = B[I[0]], rc = B[I[1]], act = B[I[2]], FX = I[3], FY = I[4], FZ = I[5], CX = I[6], CY = I[7], CZ = I[8], [c0, c1] = span(CX * CY * CZ, t, T);
      for (let N = c0; N < c1; N++) {
        const I0 = N % CX, J0 = Math.floor(N / CX) % CY, K0 = Math.floor(N / (CX * CY));
        let s0 = 0, s1 = 0, s2 = 0;
        for (let k = 2 * K0 - 1; k <= 2 * K0 + 1; k++) {
          if (k < 0 || k >= FZ) continue; const wk = k & 1 ? 0.5 : 1;
          for (let j = 2 * J0 - 1; j <= 2 * J0 + 1; j++) {
            if (j < 0 || j >= FY) continue; const wj = j & 1 ? 0.5 : 1;
            for (let i = 2 * I0 - 1; i <= 2 * I0 + 1; i++) {
              if (i < 0 || i >= FX) continue;
              const n = i + FX * (j + FY * k); if (!act[n]) continue;
              const w = (i & 1 ? 0.5 : 1) * wj * wk;
              s0 += w * rf[3 * n]; s1 += w * rf[3 * n + 1]; s2 += w * rf[3 * n + 2];
            }
          }
        }
        rc[3 * N] = s0; rc[3 * N + 1] = s1; rc[3 * N + 2] = s2;
      }
    },
    // 10 mg prolongation: xf += P xc per fine node (the order of mg.js eachTransfer)   I: xc, xf, fineActive, FNX, FNY, FNZ, CNX, CNY
    (t, T) => {
      const xc = B[I[0]], xf = B[I[1]], act = B[I[2]], FX = I[3], FY = I[4], FZ = I[5], CX = I[6], CY = I[7], [f0, f1] = span(FX * FY * FZ, t, T);
      for (let n = f0; n < f1; n++) {
        if (!act[n]) continue;
        const i = n % FX, j = Math.floor(n / FX) % FY, k = Math.floor(n / (FX * FY)), I0 = i >> 1, J0 = j >> 1, K0 = k >> 1, oi = i & 1, oj = j & 1, ok = k & 1;
        const w = (oi ? 0.5 : 1) * (oj ? 0.5 : 1) * (ok ? 0.5 : 1);
        for (let c = 0; c <= ok; c++) for (let b = 0; b <= oj; b++) for (let a = 0; a <= oi; a++) { const N = (I0 + a) + CX * ((J0 + b) + CY * (K0 + c)); xf[3 * n] += w * xc[3 * N]; xf[3 * n + 1] += w * xc[3 * N + 1]; xf[3 * n + 2] += w * xc[3 * N + 2]; }
      }
    },
    // 11 y = s·(G ⊗ I₃) x from per-element npe×npe blocks (buckling.js geometricOperator), gathered per node in element order
    //   I: nodePtr, nodeElem (e·npe + a), conn, G (ne·npe²), x, y, npe, nodePart  F: s
    (t, T) => {
      const np = B[I[0]], ne = B[I[1]], conn = B[I[2]], G = B[I[3]], x = B[I[4]], y = B[I[5]], npe = I[6], s = F[0], [a0, a1] = part(I[7], t), q = npe * npe;
      for (let n = a0; n < a1; n++) {
        let y0 = 0, y1 = 0, y2 = 0;
        for (let k = np[n]; k < np[n + 1]; k++) {
          const e = Math.floor(ne[k] / npe), a = ne[k] - e * npe, g0 = e * q + a * npe, c0 = e * npe;
          let t0 = 0, t1 = 0, t2 = 0;
          for (let b = 0; b < npe; b++) { const g = G[g0 + b], nb = 3 * conn[c0 + b]; t0 += g * x[nb]; t1 += g * x[nb + 1]; t2 += g * x[nb + 2]; }
          y0 += s * t0; y1 += s * t1; y2 += s * t2;
        }
        y[3 * n] = y0; y[3 * n + 1] = y1; y[3 * n + 2] = y2;
      }
    },
    // 12 a module kernel (pool.extKernel: e.g. flow-par.js's lattice Boltzmann slab step)   I: ext id, then its own arguments
    (t, T) => { B.ext[I[0]](t, T, I, F, B); },
  ];
}
export const K = { DOT: 0, CG: 1, XPBY: 2, CSR: 3, COPY: 4, HEX: 5, BLOCK3: 6, PROJECT: 7, AMINUS: 8, RESTRICT: 9, PROLONG: 10, GEO: 11, EXT: 12 };

// ------------------------------------------------------------------------------------------- helper thread source
const helperMain = `
const NODE = typeof self === 'undefined';
const port = NODE ? require('node:worker_threads').parentPort : self;
let B = [], I, F, P = null, ctrl, me, T, ks, seen = 0, kfn;
B.ext = [];
const build = (d) => (d === null || typeof d !== 'object' ? d : '$id' in d ? B[d.$id] : '$a' in d ? d.$a.map(build) : Object.fromEntries(Object.entries(d.$o).map(([k, v]) => [k, build(v)])));
const kernels = ${kernels.toString()};
function loop() {
  for (;;) {
    let spins = 0;
    while (Atomics.load(ctrl, ${GEN}) === seen) { if (++spins > ${SPIN_HELPER}) Atomics.wait(ctrl, ${GEN}, seen); }
    seen = Atomics.load(ctrl, ${GEN});
    const op = ctrl[${OP}];
    if (op === ${OP_RECV}) return;                 // step out: a message (new arrays) is waiting
    if (op === ${OP_QUIT}) { if (NODE) process.exit(0); else self.close(); return; }
    try { ks[op](me, T); } catch (e) { ctrl[7] = 1; }
    if (Atomics.add(ctrl, ${DONE}, 1) === T - 2) Atomics.notify(ctrl, ${DONE});
  }
}
const onmsg = async (d) => {
  if (d.init) { ctrl = new Int32Array(d.ctrl); I = new Int32Array(d.ctrl, ${IARG * 4}, ${NI}); F = new Float64Array(d.fargs); me = d.me; T = d.T; seen = Atomics.load(ctrl, ${GEN}); }
  if (d.reg) for (const [id, sab, type, off, len] of d.reg) B[id] = new globalThis[type](sab, off, len);
  if (d.free) for (const id of d.free) B[id] = undefined;
  if (d.partials) P = new Float64Array(d.partials);
  if (d.ext) for (const x of d.ext) { const mod = await import(x.url); B.ext[x.id] = mod[x.name](build(x.desc), T); }
  ks = kernels(B, I, F, P);
  Atomics.add(ctrl, ${ACK}, 1); Atomics.notify(ctrl, ${ACK});
  loop();
};
if (NODE) port.on('message', onmsg); else port.onmessage = (e) => onmsg(e.data);
`;

// ------------------------------------------------------------------------------------------- the pool
class Pool {
  constructor(n) {
    this.n = n; this.helpers = []; this.B = []; this.nextId = 1; this.pending = []; this.freed = [];
    this.ctrlBuf = new SharedArrayBuffer(4 * (IARG + NI)); this.ctrl = new Int32Array(this.ctrlBuf); this.I = new Int32Array(this.ctrlBuf, IARG * 4, NI);
    this.fBuf = new SharedArrayBuffer(8 * 16); this.F = new Float64Array(this.fBuf);
    this.pBuf = new SharedArrayBuffer(8 * 1024); this.P = new Float64Array(this.pBuf); this.pSent = null;
    this.B.ext = []; this.extPending = [];
    this.ks = kernels(this.B, this.I, this.F, this.P);
    this.calls = 0;
    this.fin = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((ids) => this.freeIds(ids)) : null;
  }
  /** Free these shared arrays once `holder` is garbage (a preconditioner, an operator, a model's cache). */
  own(holder, arrays) { const ids = arrays.filter((a) => a && a._pid).map((a) => a._pid); if (this.fin && ids.length) this.fin.register(holder, ids); return holder; }
  freeIds(ids) { for (const id of ids) if (this.B[id]) { this.B[id] = undefined; this.freed.push(id); } }
  async start() {
    let mk;
    if (NODE) { const { Worker } = await import('node:' + 'worker_threads'); mk = () => { const w = new Worker(helperMain, { eval: true }); w.unref(); return { post: (m) => w.postMessage(m), kill: () => w.terminate() }; }; }
    else { const url = URL.createObjectURL(new Blob([helperMain], { type: 'text/javascript' })); mk = () => { const w = new Worker(url, { name: 'PartCraft solver thread' });   // i18n-ignore: worker name (developer tools)
      return { post: (m) => w.postMessage(m), kill: () => w.terminate() }; }; }
    for (let i = 1; i < this.n; i++) this.helpers.push(mk());
    Atomics.store(this.ctrl, ACK, 0);
    this.helpers.forEach((h, i) => h.post({ init: true, ctrl: this.ctrlBuf, fargs: this.fBuf, me: i + 1, T: this.n, partials: this.pBuf }));
    this.pSent = this.pBuf;
    // wait (asynchronously: the helpers need this thread's event loop only to start) for every helper to answer
    const t0 = Date.now();
    while (Atomics.load(this.ctrl, ACK) < this.n - 1) {
      if (Date.now() - t0 > 10000) { this.close(); throw new Error(t('study.pool.no_start')); }
      await new Promise((r) => setTimeout(r, 2));
    }
    return this;
  }
  /** A shared Float64Array / Int32Array (registered with the helpers before the next kernel). */
  f64(n) { return this.reg(new Float64Array(new SharedArrayBuffer(8 * Math.max(1, n)), 0, n)); }
  i32(n) { return this.reg(new Int32Array(new SharedArrayBuffer(4 * Math.max(1, n)), 0, n)); }
  u8(n) { return this.reg(new Uint8Array(new SharedArrayBuffer(Math.max(1, n)), 0, n)); }
  /** A shared copy of a typed array (or the array itself when it is already shared and registered). */
  share(a) {
    if (a && a._pid) return a;
    const C = a.constructor, s = new C(new SharedArrayBuffer(Math.max(1, a.byteLength)), 0, a.length);
    s.set(a);
    return this.reg(s);
  }
  reg(a) { const id = this.nextId++; Object.defineProperty(a, '_pid', { value: id }); this.B[id] = a; this.pending.push([id, a.buffer, a.constructor.name, a.byteOffset, a.length]); return a; }
  free(list) { for (const a of list) if (a && a._pid && this.B[a._pid]) { this.B[a._pid] = undefined; this.freed.push(a._pid); } }
  /** Hand queued arrays (and frees, the partials) to the helpers: they step out of their loop to receive. */
  sync() {
    if (!this.pending.length && !this.freed.length && this.pSent === this.pBuf && !this.extPending.length) return;
    const msg = { reg: this.pending, free: this.freed, ext: this.extPending };
    this.extPending = [];
    if (this.pSent !== this.pBuf) msg.partials = this.pBuf;
    Atomics.store(this.ctrl, ACK, 0);
    for (const h of this.helpers) h.post(msg);
    this.pending = []; this.freed = []; this.pSent = this.pBuf;
    this.ctrl[OP] = OP_RECV; Atomics.add(this.ctrl, GEN, 1); Atomics.notify(this.ctrl, GEN);
    this.waitFor(ACK, this.n - 1);
  }
  waitFor(slot, target) {
    let spins = 0, v;
    while ((v = Atomics.load(this.ctrl, slot)) < target) {
      if (++spins > SPIN_MAIN) { if (Atomics.wait(this.ctrl, slot, v, 20000) === 'timed-out' && Atomics.load(this.ctrl, slot) === v) throw new Error(t('study.pool.no_answer')); }
    }
  }
  /** Run kernel k on every thread with integer args ints and float args floats (synchronous). */
  run(k, ints, floats = null) {
    this.sync();
    for (let i = 0; i < ints.length; i++) this.I[i] = ints[i];
    if (floats) for (let i = 0; i < floats.length; i++) this.F[i] = floats[i];
    Atomics.store(this.ctrl, DONE, 0);
    this.ctrl[OP] = k;
    Atomics.add(this.ctrl, GEN, 1); Atomics.notify(this.ctrl, GEN);
    this.ks[k](0, this.n);
    this.waitFor(DONE, this.n - 1);
    this.calls++;
    if (this.ctrl[7]) { this.ctrl[7] = 0; throw new Error(t('study.pool.failed')); }
  }
  /** Reductions: make room for n entries' chunks; sum the chunks in order. */
  partials(n) { const nc = Math.ceil(n / CH); if (nc > this.P.length) { this.pBuf = new SharedArrayBuffer(8 * nc * 2); this.P = new Float64Array(this.pBuf); this.ks = kernels(this.B, this.I, this.F, this.P); } return nc; }
  sum(nc) { let s = 0; for (let c = 0; c < nc; c++) s += this.P[c]; return s; }
  dot(a, b, n = a.length) { const nc = this.partials(n); this.run(K.DOT, [a._pid, b._pid, n]); return this.sum(nc); }
  copy(y, x, n = y.length) { this.run(K.COPY, [y._pid, x._pid, n]); return y; }
  fill(y, c, n = y.length) { this.run(K.COPY, [y._pid, -1, n], [c]); return y; }
  /** Balanced partition of rows 0…n by a cost prefix (rowPtr-like, cost(r) = pre[r+1] − pre[r]) → shared Int32Array(T + 1). */
  partition(n, pre = null) {
    const p = new Int32Array(this.n + 1); p[this.n] = n;
    if (!pre) { for (let t = 1; t < this.n; t++) p[t] = Math.floor(n * t / this.n); }
    else { const tot = pre[n] - pre[0]; let r = 0; for (let t = 1; t < this.n; t++) { const want = pre[0] + tot * t / this.n; while (r < n && pre[r] < want) r++; p[t] = r; } }
    return this.share(p);
  }
  big(n) { return n >= minParallel; }
  /**
   * Share a state object with the helpers: its typed arrays (nested plain objects too, up to 4 deep; functions and the keys in
   * `skip` left out) are replaced IN PLACE by shared copies, so this thread keeps using the same memory. → a descriptor the
   * helpers rebuild the object from (pool.extKernel).
   */
  mirror(obj, skip = []) {
    const desc = (v, set, depth) => {   // set(shared) puts a shared copy back where v was
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) { const sv = this.share(v); set(sv); return { $id: sv._pid }; }
      if (v === null || typeof v !== 'object') return v;
      if (depth > 4) return null;
      if (Array.isArray(v)) return { $a: v.map((x, i) => desc(x, (y) => { v[i] = y; }, depth + 1)) };
      if (Object.getPrototypeOf(v) !== Object.prototype) return null;
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!(depth === 0 && skip.includes(k)) && typeof x !== 'function' && x !== undefined) o[k] = desc(x, (y) => { v[k] = y; }, depth + 1);
      return { $o: o };
    };
    return desc(obj, () => {}, 0);
  }
  /**
   * A kernel from a module (synchronous on every thread): the helpers import `url` and call its export `name`(the state rebuilt
   * from `desc`, T) → fn(t, T, I, F, B) (B: the shared arrays by id); this thread calls `local` (the same export on its own state). → the id for run(K.EXT, [id, …]).
   */
  extKernel(url, name, desc, local) {
    const id = this.B.ext.length;
    this.B.ext.push(local(this.n));
    this.extPending.push({ id, url, name, desc });
    this.sync();
    return id;
  }
  close() { try { this.ctrl[OP] = OP_QUIT; Atomics.add(this.ctrl, GEN, 1); Atomics.notify(this.ctrl, GEN); } catch { /* gone */ } for (const h of this.helpers) { try { h.kill(); } catch { /* gone */ } } this.helpers = []; }
}

/** Start (or keep, or stop) the pool for `threads` threads in all. → poolInfo(). Never throws: a failure leaves one thread. */
export async function ensurePool(threads) {
  REQUESTED = Math.max(1, Math.min(MAX_THREADS, Math.round(+threads || 1)));
  if (REQUESTED <= 1 || !isolated()) {
    WHY = REQUESTED <= 1 ? 'chosen' : 'isolation';
    if (POOL) { POOL.close(); POOL = null; }
    return poolInfo();
  }
  if (POOL && POOL.n === REQUESTED) return poolInfo();
  if (POOL) { POOL.close(); POOL = null; }
  try { POOL = await new Pool(REQUESTED).start(); WHY = ''; } catch (e) { POOL = null; WHY = e && e.message ? e.message : ''; }
  return poolInfo();
}
/** Stop the pool (tests). */
export function closePool() { if (POOL) { POOL.close(); POOL = null; } }
/** Run fn with the pool off (one thread), e.g. to compare. */
export function withoutPool(fn) { const p = POOL; POOL = null; try { return fn(); } finally { POOL = p; } }

// ------------------------------------------------------------------------------------------- voxel models (fea.js, mg.js)

/** Node → its elements (m·8 + corner, in element order) for a hex model, and a node partition balanced by element count. */
function nodeAdjacency(P, node0, off, nn) {
  const cnt = new Int32Array(nn + 1);
  for (let m = 0; m < node0.length; m++) for (let c = 0; c < 8; c++) cnt[node0[m] + off[c] + 1]++;
  for (let n = 0; n < nn; n++) cnt[n + 1] += cnt[n];
  const fill = cnt.slice(0, nn), adj = new Int32Array(cnt[nn]);
  for (let m = 0; m < node0.length; m++) for (let c = 0; c < 8; c++) adj[fill[node0[m] + off[c]]++] = m * 8 + c;
  // partition by work (elements per node + 1)
  const pre = new Float64Array(nn + 1); for (let n = 0; n < nn; n++) pre[n + 1] = pre[n] + (cnt[n + 1] - cnt[n]) + 1;
  return { ptr: P.share(cnt), adj: P.share(adj), part: P.partition(nn, pre) };
}

/** Threaded y = K x (+ penalty) for a fea.js model (implicit, Ke shared by all elements) or an mg.js explicit level. Cached on the object. */
export function hexOperator(P, obj, { explicit = false, scale = null, consIdx = null, pen = null } = {}) {
  const key = explicit ? '_parE' : '_parK';
  let c = obj[key];
  if (!c || c.pool !== P) {
    const nn = obj.nn, adj = nodeAdjacency(P, obj.node0, obj.off, nn);
    c = obj[key] = { pool: P, ...adj, node0: P.share(obj.node0), off: P.share(obj.off), K: P.share(explicit ? obj.K : obj.Ke), nn };
    P.own(obj, [c.ptr, c.adj, c.part, c.node0, c.off, c.K]);
  }
  const sc = scale ? P.share(scale) : null, ci = consIdx ? P.share(consIdx) : null, pe = pen ? P.share(pen) : null;
  const fn = (x, y) => { P.run(K.HEX, [c.ptr._pid, c.adj._pid, c.node0._pid, c.off._pid, c.K._pid, sc ? sc._pid : -1, x._pid, y._pid, c.nn, explicit ? 1 : 0, ci ? ci._pid : -1, pe ? pe._pid : -1, c.part._pid], [explicit ? 1 : obj.kScale]); return y; };
  return P.own(fn, [sc !== scale ? sc : null, ci !== consIdx ? ci : null, pe !== pen ? pe : null]);
}

/** Threaded projector (fea.js projector) for a model + constraint set (cached on cons). */
export function projectOperator(P, model, cons) {
  let c = cons._par;
  if (!c || c.pool !== P) { c = cons._par = { pool: P, active: P.share(model.active), nodes: P.share(cons.nodes.length ? cons.nodes : new Int32Array(1)), P: P.share(cons.P.length ? cons.P : new Float64Array(9)), n: cons.nodes.length }; P.own(cons, [c.active, c.nodes, c.P]); }
  return (v) => { P.run(K.PROJECT, [v._pid, c.active._pid, model.nn, c.nodes._pid, c.P._pid, c.n]); return v; };
}

/**
 * fea.js pcg on the pool: the same projected PCG (same operator, preconditioner and stopping test; dot products summed in chunks).
 * mg: an mg.js preconditioner (threaded when built with the pool); else M: node-block Jacobi (9 per node). → { u (a plain copy), … }
 */
export function voxelPCG(P, model, cons, f, { x0 = null, tol = 1e-8, maxIter = 0, scale = null, mg = null, M = null, onProgress = null, cancelled = null, label = 'Solving' } = {}) {
  const n = 3 * model.nn, proj = projectOperator(P, model, cons), applyK = hexOperator(P, model, { scale });
  const u = P.f64(n), r = P.f64(n), z = P.f64(n), p = P.f64(n), q = P.f64(n), b = P.f64(n), tmp = mg ? P.f64(n) : null, Ms = mg ? null : P.share(M);
  try {
    if (x0) u.set(x0);
    proj(u);
    b.set(f); proj(b);
    const bn = Math.sqrt(P.dot(b, b));
    if (bn === 0) return { u: new Float64Array(n), iterations: 0, residual: 0, converged: true, threads: P.n };
    applyK(u, q);
    P.run(K.AMINUS, [b._pid, q._pid, n]); P.copy(r, q);   // r = b − K u
    proj(r);
    const prec = (src, dst) => {
      if (mg) { P.copy(tmp, src); proj(tmp); mg.apply(tmp, dst); return proj(dst); }
      P.run(K.BLOCK3, [Ms._pid, src._pid, dst._pid, model.nn, 0, -1]);
      return proj(dst);
    };
    prec(r, z); P.copy(p, z);
    let rz = P.dot(r, z), rn = P.dot(r, r);
    const nc = P.partials(n);
    const cap = maxIter || Math.max(2000, 20 * Math.cbrt(model.elems.length) * 30);
    let it = 0, res = 1, t0 = Date.now();
    for (; it < cap; it++) {
      res = Math.sqrt(rn) / bn;
      if (res < tol) break;
      if (onProgress && Date.now() - t0 > 200) { t0 = Date.now(); onProgress(Math.min(0.99, Math.log(res) / Math.log(tol)), `${label}: iteration ${it}, residual ${res.toExponential(1)}`); }   // i18n-ignore: progress label, never shown
      if (cancelled && (it & 15) === 0 && cancelled()) throw new Error('Cancelled');
      applyK(p, q); proj(q);
      const pq = P.dot(p, q);
      if (!(pq > 0)) break;
      const a = rz / pq;
      P.run(K.CG, [u._pid, p._pid, r._pid, q._pid, n], [a]); rn = P.sum(nc);
      prec(r, z);
      const rz2 = P.dot(r, z);
      const beta = rz2 / rz; rz = rz2;
      P.run(K.XPBY, [p._pid, z._pid, n], [beta]);
    }
    return { u: Float64Array.from(u), iterations: it, residual: res, converged: res < tol, threads: P.n };
  } finally { P.free([u, r, z, p, q, b, tmp, Ms === M ? null : Ms].filter(Boolean)); }
}

/** A result's `threads` (compute-worker.js) in words for the solver details; serial: why this solver ran on one thread anyway
 *  (a solver that is not threaded), else "below the size worth threading". */
export const threadWords = (th, serial = '') => (!th ? '' : th.used > 1 ? t('study.pool.threads', { n: th.used })
  : !th.isolated ? t('study.pool.one_not_isolated')
    : th.requested <= 1 ? t('study.pool.one_chosen')
      : t('study.pool.one_why', { why: th.threads > 1 ? serial || t('study.pool.below_size') : th.why === 'chosen' ? t('study.pool.why_chosen') : th.why === 'isolation' ? t('study.pool.why_isolation') : th.why || t('study.pool.unavailable') }));

// ------------------------------------------------------------------------------------------- CSR matrices (thermal.js)
const shared = new WeakMap();   // a CSR value array → its shared copy (value arrays are not changed after their first solve)
/** Threaded y = A x for a full CSR pattern { n, rowPtr, cols } and values (rows partitioned by nonzeros). */
export function csrOperator(P, pat, val) {
  let c = pat._par;
  if (!c || c.pool !== P) { c = pat._par = { pool: P, rowPtr: P.share(pat.rowPtr), cols: P.share(pat.cols), part: P.partition(pat.n, pat.rowPtr) }; P.own(pat, [c.rowPtr, c.cols, c.part]); }
  let v = shared.get(val);
  if (!v || v.pool !== P) { v = { pool: P, a: P.share(val) }; shared.set(val, v); P.own(val, [v.a]); }
  return (x, y) => { P.run(K.CSR, [c.rowPtr._pid, c.cols._pid, v.a._pid, x._pid, y._pid, c.part._pid]); return y; };
}
/** thermal.js csrPcg on the pool: the matrix products and vector updates threaded; the preconditioner M (IC(0)) stays serial. */
export function csrPCG(P, pat, val, b, { x0 = null, tol = 1e-10, maxIter = 0, cancelled = null } = {}, M) {
  const n = pat.n, A = csrOperator(P, pat, val);
  const x = P.f64(n), r = P.f64(n), z = P.f64(n), p = P.f64(n), q = P.f64(n), bs = P.share(b);
  try {
    const bn = Math.sqrt(P.dot(bs, bs));
    if (bn === 0) return { x: new Float64Array(n), iterations: 0, residual: 0, converged: true };
    if (x0) x.set(x0);
    A(x, q);
    P.copy(r, q); P.run(K.AMINUS, [bs._pid, r._pid, n]);
    M.apply(r, z); P.copy(p, z);
    let rz = P.dot(r, z), rn = P.dot(r, r);
    const nc = P.partials(n);
    const cap = maxIter || Math.max(1000, 10 * Math.round(Math.cbrt(n)) * 10);
    let it = 0, res = 1;
    for (; it < cap; it++) {
      res = Math.sqrt(rn) / bn;
      if (res < tol) break;
      if (cancelled && (it & 31) === 0 && cancelled()) throw new Error('Cancelled');
      A(p, q);
      const pq = P.dot(p, q);
      if (!(pq > 0)) break;
      const a = rz / pq;
      P.run(K.CG, [x._pid, p._pid, r._pid, q._pid, n], [a]); rn = P.sum(nc);
      M.apply(r, z);
      const rz2 = P.dot(r, z);
      const beta = rz2 / rz; rz = rz2;
      P.run(K.XPBY, [p._pid, z._pid, n], [beta]);
    }
    return { x: Float64Array.from(x), iterations: it, residual: res, converged: res < tol };
  } finally { P.free([x, r, z, p, q, bs === b ? null : bs].filter(Boolean)); }
}

// ------------------------------------------------------------------------------------------- element-block operators (buckling.js)

/** Node → (element, local node) pairs in element order from a connectivity (ne·npe), and a node partition balanced by work. */
function connAdjacency(P, conn, npe, nn) {
  const cnt = new Int32Array(nn + 1);
  for (let i = 0; i < conn.length; i++) cnt[conn[i] + 1]++;
  for (let n = 0; n < nn; n++) cnt[n + 1] += cnt[n];
  const fill = cnt.slice(0, nn), adj = new Int32Array(cnt[nn]);
  for (let i = 0; i < conn.length; i++) adj[fill[conn[i]]++] = i;   // i = e·npe + a, in element order
  const pre = new Float64Array(nn + 1); for (let n = 0; n < nn; n++) pre[n + 1] = pre[n] + (cnt[n + 1] - cnt[n]) * npe + 1;
  return { ptr: P.share(cnt), adj: P.share(adj), part: P.partition(nn, pre) };
}
/** Threaded y = s·Σ (Ge ⊗ I₃) x for a MESH INTERFACE mesh and per-element blocks G (ne·npe², the element's geometricStiffness). */
export function blockOperator(P, mesh, G, s = 1) {
  let c = mesh._parG;
  if (!c || c.pool !== P) { c = mesh._parG = { pool: P, ...connAdjacency(P, mesh.conn, mesh.npe, mesh.nn), conn: P.share(mesh.conn) }; P.own(mesh, [c.ptr, c.adj, c.part, c.conn]); }
  const Gs = P.share(G);
  const fn = (x, y) => { P.run(K.GEO, [c.ptr._pid, c.adj._pid, c.conn._pid, Gs._pid, x._pid, y._pid, mesh.npe, c.part._pid], [s]); return y; };
  return P.own(fn, [Gs !== G ? Gs : null]);
}
/** An operator on shared arrays used with plain ones: x copied in, y copied out (bucklingEigen hands plain vectors). */
export function plainIO(P, n, op) {
  const xs = P.f64(n), ys = P.f64(n);
  const fn = (x, y) => { if (x._pid) { op(x, ys); y.set(ys); return y; } xs.set(x); op(xs, ys); y.set(ys); return y; };
  return P.own(fn, [xs, ys]);
}

// ------------------------------------------------------------------------------------------- tets: one thread
// Quadratic-tet solves (tetfea.js, amg.js) stay on one thread. Threading them was built in round 5 and left off; 0.4 (P4)
// measured it again and removed it: on 68,727 unknowns the AMG setup is ~1/3 of the solve and dominated by one memory-bound
// Galerkin product (7,164 × 9.5M nonzeros: 1.09 s on one thread, 1.06 s row-parallel on 4), the V-cycle's products gain
// little, and a parallel (hybrid) Gauss–Seidel halves the V-cycle (78 → 36 ms on 4 threads) but doubles the CG iterations
// (53 → 111; 71 on 2 threads), so the solve is at best ~10 % faster and swings with machine load. A faster tet solve needs a
// parallel smoother that keeps the iteration count (e.g. Chebyshev), not threads on the present one.
