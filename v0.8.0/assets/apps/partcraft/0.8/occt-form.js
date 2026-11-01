/* SPDX-License-Identifier: Apache-2.0 */
/**
 * occt-form.js — exact-worker ops of the Form workspace (DOM-free; worker-ops.js registry, imported by brep-worker.js).
 *   formCheck({ cage, level }) → the form-brep.js conversion report of a cage (patches, exact/approximated, gaps,
 *       normal angles, closed/valid/volume) without adding it to the part: Form's "Check exact" button.
 */
import { addOps } from './worker-ops.js';
import { readForm } from './form.js';
import { formShape } from './form-brep.js';

addOps({
  formCheck(args, ctx) {
    const cage = readForm(args.cage);
    const level = Number.isInteger(args.level) && args.level >= 0 && args.level <= 3 ? args.level : null;
    const r = formShape(ctx.oc, cage, { level });
    try { return { closed: r.closed, report: r.report }; } finally { r.shape.delete(); }
  },
});
