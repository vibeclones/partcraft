/* SPDX-License-Identifier: Apache-2.0 */
/**
 * compute-worker.js — plain Web Workers for heavy compute that is not OpenCascade (FEA, topology optimisation,
 * toolpaths …), built the way exact-client.js builds the kernel's worker: the modules are fetched through the page's
 * cache-busted URLs and linked as blob: modules (import maps do not reach workers).
 *
 *   const w = computeWorker(['fea-solve.js'], { name: 'PartCraft simulation' });
 *   const r = await w.call('solveStatic', { nodes, elems }, { transfer: [nodes.buffer], onProgress: (v) => … });
 *   w.terminate();                       // stops a running op (its promise rejects) — call() starts a fresh worker
 * Each listed module (a file of this build, DOM-free, relative single-quoted imports only) calls
 * addOps({ name(args, ctx) }) from './worker-ops.js' at its top level; ctx = { progress(v), transfer(...buffers) }.
 * The worker starts on the first call and stays up for the next ones.
 * Threads: when a call's args carry `threads` (the Settings › PartCraft "Solver threads" count; host.computeWorker adds it for
 * callers that ask with { threads: true }), the worker first starts pool.js's pool of that size (cross-origin isolated pages only)
 * and the result gets `threads` = pool.js poolInfo() + used (threads a kernel actually ran on during the op).
 */
import { blobModules, pageCatalog } from './exact-client.js';
import { t } from './i18n.js';

export function computeWorker(modules, { name = 'PartCraft compute' } = {}) {
  if (!Array.isArray(modules) || !modules.length || !modules.every((m) => /^[a-z0-9-]+\.js$/.test(m))) throw new Error('computeWorker: list this build\'s module files, e.g. [\'fea-solve.js\'].');   // i18n-ignore: developer error
  let worker = null, starting = null, seq = 0;
  const pending = new Map();
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  async function start() {
    if (worker) return worker;
    if (!starting) starting = (async () => {
      const urls = await blobModules(['worker-ops.js', 'pool.js', 'worker-i18n.js', ...modules]);
      const src = `import { OPS } from '${urls.get('worker-ops.js')}';\nimport { ensurePool, getPool, poolInfo } from '${urls.get('pool.js')}';\nimport '${urls.get('worker-i18n.js')}';\n` + modules.map((m) => `import '${urls.get(m)}';\n`).join('') + `
self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  const transfer = new Set();
  const ctx = { progress: (v) => self.postMessage({ id, progress: v }), transfer: (...b) => b.forEach((x) => transfer.add(x)) };
  try {
    if (!OPS[op]) throw new Error('Unknown request ' + op);
    const threaded = !!args && args.threads !== undefined;
    if (threaded) await ensurePool(args.threads);
    const P0 = getPool(), c0 = P0 ? P0.calls : 0;
    const result = await OPS[op](args || {}, ctx);
    if (threaded && result && typeof result === 'object' && !Array.isArray(result)) { const P1 = getPool(); result.threads = { ...poolInfo(), used: P1 && P1 === P0 && P1.calls > c0 ? P1.n : 1 }; }
    self.postMessage({ id, ok: true, result }, [...transfer]);
  } catch (err) { self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) }); }
};`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module', name });
      w.onmessage = (e) => {
        const { id, ok, result, error, progress } = e.data || {};
        const p = pending.get(id);
        if (!p) return;
        if (progress !== undefined) { try { p.onProgress?.(progress); } catch { /* the caller's problem */ } return; }
        pending.delete(id);
        if (ok) p.resolve(result); else p.reject(new Error(error));
      };
      w.onerror = (e) => { e.preventDefault?.(); failAll(new Error(e.message || t('script.worker.died', { name }))); };
      const cat = pageCatalog();
      if (cat) w.postMessage({ id: 0, op: 'i18nInit', args: cat });   // first, so every op after it speaks the page's language (worker-i18n.js)
      worker = w;
      return w;
    })().finally(() => { starting = null; });
    return starting;
  }
  return {
    /** Run an op; opts: { transfer: [ArrayBuffer] moved to the worker, onProgress(v) }. Resolves with the op's result. */
    async call(op, args, { transfer = [], onProgress } = {}) {
      const w = await start();
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, onProgress });
        w.postMessage({ id, op, args }, transfer);
      });
    },
    terminate() {
      try { worker?.terminate(); } catch { /* gone */ }
      worker = null;
      failAll(new Error(t('script.rt.stopped')));
    },
    get busy() { return pending.size > 0; },
  };
}
