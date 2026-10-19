/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sim-worker.js — Simulation and Generative ops for a compute worker (compute-worker.js; DOM-free).
 *   simSolve(job)                  fea.js solveStudy → summary, maxima, reactions, and a plot mesh (the part's mesh with
 *                                  edges split to ≤ the element size, so a flat face is not two triangles) carrying
 *                                  vm / |u| / u per vertex (static) or the mode shapes (modal, each scaled to max |u| = 1)
 *   genOutcomes({job, variants})   topopt.js outcomes → per outcome: history, honest evaluation, iso-surface mesh
 * Cancel = terminate the worker (the ops run to the end otherwise). Progress: ctx.progress(0…1).
 */
import { addOps } from './worker-ops.js';
import { solveStudy, onMesh, sampleField, refineMesh } from './fea.js';
import { outcomes } from './topopt.js';

export function simSolve(job, ctx = { progress() {}, transfer() {} }) {
  let last = 0;
  const prog = (f) => { const now = Date.now(); if (now - last > 150) { last = now; ctx.progress(Math.max(0, Math.min(1, f))); } };
  const r = solveStudy(job, prog);
  const s = r.summary;
  const pm = refineMesh(job.mesh, job.h);
  const plotMesh = { positions: pm.positions, indices: pm.indices, triFace: pm.triFace };
  ctx.transfer(pm.positions.buffer, pm.indices.buffer, pm.triFace.buffer);
  if (r.kind === 'modal') {
    const shapes = r.shapes.map((u) => {
      const nv = pm.positions.length / 3, out = new Float32Array(nv * 3), t = new Float64Array(3);
      let mx = 0;
      for (let v = 0; v < nv; v++) { sampleField(r.model, u, 3, [pm.positions[3 * v], pm.positions[3 * v + 1], pm.positions[3 * v + 2]], t); out.set(t, 3 * v); mx = Math.max(mx, Math.hypot(t[0], t[1], t[2])); }
      for (let i = 0; i < out.length; i++) out[i] /= mx || 1;
      ctx.transfer(out.buffer);
      return out;
    });
    return { kind: 'modal', summary: s, freqs: r.freqs, shapes, plotMesh, ms: r.ms };
  }
  const v = onMesh(r.model, r, r.u, pm);
  ctx.transfer(v.vm.buffer, v.disp.buffer, v.u.buffer);
  return {
    kind: 'static', summary: s, iterations: r.iterations, residual: r.residual, material: r.material, ms: r.ms,
    maxVm: r.maxVm, maxVmElem: r.maxVmElem, maxDisp: r.maxDisp, minSafety: r.minSafety, reaction: r.reaction, groupReactions: r.groupReactions, loadTotal: r.loadTotal,
    vertex: v, plotMesh,
  };
}

export function genOutcomes({ job, variants }, ctx = { progress() {}, transfer() {} }) {
  let last = 0;
  const prog = (f) => { const now = Date.now(); if (now - last > 150) { last = now; ctx.progress(Math.max(0, Math.min(1, f))); } };
  const t0 = Date.now();
  const outs = outcomes(job, variants, prog);
  const g = outs[0].opt.grid;
  const list = outs.map((o) => {
    ctx.transfer(o.mesh.positions.buffer, o.mesh.indices.buffer);
    return {
      volfrac: o.volfrac, material: o.material, iterations: o.iterations, converged: o.converged, finalC: o.finalC,
      history: o.history.map((h) => ({ c: h.c, vol: h.vol, change: h.change })), eval: o.eval,
      mesh: { positions: o.mesh.positions, indices: o.mesh.indices, volume: o.mesh.volume, iso: o.mesh.iso },
    };
  });
  return { outcomes: list, summary: { elements: outs[0].opt.model.elems.length, h: g.h, nx: g.nx, ny: g.ny, nz: g.nz }, ms: Date.now() - t0 };
}

addOps({ simSolve, genOutcomes });
