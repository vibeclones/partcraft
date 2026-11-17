/* SPDX-License-Identifier: Apache-2.0 */
/**
 * worker-ops.js — the op registry shared by PartCraft's workers (DOM-free, no imports). A module that adds work to a
 * worker calls addOps({ name(args, ctx) { … } }) at its top level; the worker that imports it answers those ops.
 *   exact kernel (brep-worker.js): one side-effect import line per module there; ctx = { oc, progress(v), transfer(...buffers) }
 *   compute workers (compute-worker.js computeWorker([modules])): ctx = { progress(v), transfer(...buffers) }
 * An op returns structured-clonable data (or a promise of it); ctx.transfer(buf) moves an ArrayBuffer instead of copying it.
 * Each worker has its own copy of this registry (its own module graph), so it holds only what that worker imported.
 */
export const RESERVED = new Set(['init', 'regen', 'step', 'stepInfo', 'drawing']);   // brep-worker.js's own ops
export const OPS = Object.create(null);
const NAME = /^[a-z][A-Za-z0-9]{1,40}$/;

export function addOps(ops) {
  for (const [name, fn] of Object.entries(ops || {})) {
    if (!NAME.test(name) || typeof fn !== 'function') throw new Error(`addOps: "${name}" must be a camelCase name with a function.`);   // i18n-ignore: developer error
    if (RESERVED.has(name) || OPS[name]) throw new Error(`addOps: the op "${name}" is already taken.`);   // i18n-ignore: developer error
    OPS[name] = fn;
  }
}
