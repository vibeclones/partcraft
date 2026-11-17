/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-worker.js — runs the exact kernel (brep.js on OpenCascade) off the page's main thread.
 * Started by exact-client.js as a module worker. OpenCascade is loaded here, lazily, by a dynamic
 * import() of the URL the page passes in ('init'), so the LGPL library stays its own replaceable
 * file (assets/vendor/replicad-opencascadejs/current/) and is fetched only when this worker starts.
 *
 * Messages in:  { id, op, args }   ops: init { url } · regen { part, upTo } · step { part, schema }
 *               · stepInfo { text } · drawing { part, drawing }
 *               · any op another module added with addOps() (worker-ops.js; listed below)
 * Messages out: { id, ok: true, result, heap } | { id, ok: false, error } | { id, progress } (ctx.progress, before the reply)
 */
import { regenerateBrep, exportStep, stepInfo } from './brep.js';
import { drawingViews } from './brep-draw.js';
import { OPS as EXTRA } from './worker-ops.js';
import { t as tr } from './i18n.js';
// Modules adding OpenCascade ops (docs/apps/partcraft-workspaces.md): one side-effect import line per module below this
// comment, written with single quotes (exact-client.js links the worker's modules by that text); each module calls
// addOps({ name(args, ctx) }) with ctx = { oc, progress(v), transfer(...buffers) }.
import './measure-brep.js';
import './worker-i18n.js';   // the page's language for messages made here (0.4)
import './sheet-flat.js';
import './occt-form.js';
import './brep-xcaf.js';

let oc = null;

const OPS = {
  async init({ url }) {
    if (oc) return { ms: 0 };
    const t0 = performance.now();
    const mod = await import(url);
    oc = await mod.default({ print: () => {}, printErr: () => {} });
    return { ms: Math.round(performance.now() - t0) };
  },
  regen({ part, upTo = null }) {
    const r = regenerateBrep(part, oc, { upTo });
    // the solved sketches go back too (the solver runs here as well)
    const sketches = {};
    for (const f of part.features) if (f.type === 'sketch') sketches[f.id] = f.sketch;
    return { ...r, shape: null, sketches };
  },
  step({ part, schema }) { return exportStep(part, oc, { schema }); },
  stepInfo({ text }) { return stepInfo(oc, text); },
  drawing({ part, drawing }) { return drawingViews(part, oc, drawing); },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  try {
    const fn = OPS[op] || EXTRA[op];
    if (!fn) throw new Error('Unknown request ' + op);   // i18n-ignore: ops are sent by the app's own code
    if (op !== 'init' && !oc) throw new Error(tr('model.brep_worker.not_loaded'));
    const transfer = new Set();
    const ctx = { oc, progress: (v) => self.postMessage({ id, progress: v }), transfer: (...b) => b.forEach((x) => transfer.add(x)) };
    const result = await fn(args || {}, ctx);
    if (result && result.mesh) for (const v of Object.values(result.mesh)) if (ArrayBuffer.isView(v)) transfer.add(v.buffer);
    self.postMessage({ id, ok: true, result, heap: oc ? oc.wasmMemory.buffer.byteLength : 0 }, [...transfer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err), heap: oc ? oc.wasmMemory.buffer.byteLength : 0 });
  }
};
