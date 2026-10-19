/* SPDX-License-Identifier: Apache-2.0 */
/**
 * flow-par.js — the lattice Boltzmann step (flow.js) on the solver threads (pool.js; DOM-free). Laminar states only: a state
 * with turbulence (S.turb / eddy viscosity) keeps one thread (flowJob refuses turbulence today anyway).
 *
 * flow.js's PARALLEL CONTRACT (on `step`): within a step, stepSlab for disjoint cell ranges may run at the same time — each
 * reads `src` anywhere and writes only its own cells' dst, ghost slots, rho/u and corr — then endStep once. Here: the state's
 * arrays are shared (pool.mirror replaces them in place by shared copies), each thread t runs stepSlab on slab t of T
 * (flow.js slabs: equal cell counts; cells are numbered z-first, so a range is a z-slab), the pool's kernel return is the
 * barrier, then endStep(S) on this thread swaps src/dst (the helpers get the two buffers' ids every step). Every cell is computed
 * by the same code from the same inputs, so the result is bit-identical to step() on one thread
 * (tools/partcraft-test/test-threads.mjs checks it).
 *
 *   threadFlow(S) → true when S now steps on the pool (S.par set: flow.js step() hands over), false = one thread
 *   helperKernel(S, T) → (t, T, I, F, B) => stepSlab on slab t (the same function on every thread: the helpers call it on
 *   their rebuilt state, this thread on S itself); I: [ext id, src id, dst id]
 */
import { slabs, stepSlab, endStep } from './flow.js';
import { getPool, K } from './pool.js';

/** The per-thread slab step on a state (a helper's rebuilt copy, or this thread's own). */
export function helperKernel(S, T) {
  const parts = slabs(S, T);
  return (t, _T, I, F, B) => { S.src = B[I[1]]; S.dst = B[I[2]]; stepSlab(S, parts[t]); };
}

/** Put a laminar state on the pool when it is big enough → true, or leave it on one thread → false. */
export function threadFlow(S) {
  const P = getPool();
  if (!P || S.turb || S.nut || !P.big(S.lat.nf)) return false;
  const desc = P.mirror(S, ['turb', 'par', 'whole']);
  const id = P.extKernel(import.meta.url, 'helperKernel', desc, (T) => helperKernel(S, T));
  S.par = (st) => { P.run(K.EXT, [id, st.src._pid, st.dst._pid]); endStep(st); };
  S.threads = P.n;
  return true;
}
