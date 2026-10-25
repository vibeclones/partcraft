/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-thread.js — the Thread feature on the exact kernel (0.5 WL.29): installThread(FEATURES, LIB) from brep.js.
 *
 * Cosmetic only: each picked cylinder of the body gets a thread record (ctx.threads: the dashed circles in the view and the
 * callout on the drawing), sized like the mesh kernel's (threads.js). A modelled thread is built by the mesh kernel
 * (kernel.js); here it stays cosmetic and the feature says so. The thread starts at the face's lower end along its axis
 * (Flip: the other end); the open-end test is the mesh kernel's.
 */
import * as V from './vec.js';
import { threadDims, sizeFor, threadCallout } from './threads.js';
import { t } from './i18n.js';

export function installThread(FEATURES, lib) {
  const { fail, nearest } = lib;

  FEATURES.thread = (f, ctx) => {
    if (!ctx.body) fail(t('thread.err.no_body'));
    if (!f.faces.length) fail(t('thread.err.pick'));
    const table = ctx.faceTable(), list = [];
    for (const ref of f.faces) {
      const cands = table.filter((x) => x.name === ref.name);
      if (!cands.length) fail(t('thread.err.face_gone', { face: ref.name }));
      const fc = nearest(cands, ref.at, (x) => x.at);
      if (fc.type !== 'cylinder' || !fc.v) fail(t('thread.err.round'));
      const external = fc.outside, d = V.norm(fc.axis.d);
      const size = f.size === 'auto' ? sizeFor(f.form, 2 * fc.r, external) : f.size;
      if (!size) fail(t('thread.err.no_size', { d: String(+(2 * fc.r).toFixed(2)) }));
      const g = threadDims(f.form, size);
      const [v0, v1] = fc.v[0] <= fc.v[1] ? fc.v : [fc.v[1], fc.v[0]];
      const full = v1 - v0, len = Math.min(full, f.length ?? full);
      const from = f.flip ? v1 : v0, dz = f.flip ? V.mul(d, -1) : d;
      list.push({ o: V.add(fc.axis.o, V.mul(d, from)), d: dz, r: external ? g.d1 / 2 : g.d / 2, r0: Math.min(g.d1 / 2, fc.r), r1: Math.max(g.d / 2, external ? fc.r : 0), depth: len,
        callout: threadCallout(f.form, size, { external, length: len }) });
    }
    const callouts = [];
    for (const th of list) { const k = callouts.find((x) => x.callout === th.callout); if (k) k.count++; else callouts.push({ callout: th.callout, count: 1 }); }
    ctx.threads.set(f.id, { callout: callouts[0].callout, callouts, modelled: false, list });
    return f.modelled ? { warning: t('thread.warn.exact') } : {};
  };
}
