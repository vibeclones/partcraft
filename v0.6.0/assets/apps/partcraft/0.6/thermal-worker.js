/* SPDX-License-Identifier: Apache-2.0 */
/**
 * thermal-worker.js — thermal, thermal-stress and buckling ops for the Simulation compute worker (compute-worker.js; DOM-free).
 *   thermalSolve(job)       thermal.js solveThermalStudy → summary, min/max T, heat balance, a plot mesh (the part's mesh split to ≤ h)
 *                           with T and |q| (W/m²) per vertex; transient: T per vertex for every stored frame and its time
 *   thermoStaticSolve(job)  buckling.js solveThermoStatic → the same shape as sim-worker simSolve's static result, plus `thermal`
 *                           (ΔT range, the temperature field's min/max/balance) and ΔT per vertex
 *   bucklingSolve(job)      buckling.js solveBuckling → load factors, mode shapes per vertex (each scaled to max |u| = 1), pre-stress
 *   thermoHistorySolve(job) thermal-history.js solveThermoHistory (a static study with a transient thermal load, voxel or tet mesh)
 *                           → thermoStaticSolve's shape for the worst (or chosen) step, plus `history` (times, peak von Mises,
 *                           peak displacement, worst) and `frames` (per stress step: the vertex fields vm, disp, u, dT, + s1/s3/strain
 *                           on tets) for the time slider; the plot mesh is the tet surface on tets (tet-worker.js tetPlotMesh)
 * Cancel = terminate the worker. Progress: ctx.progress(0…1).
 */
import { addOps } from './worker-ops.js';
import { onMesh, sampleField, refineMesh } from './fea.js';
import { solveThermalStudy } from './thermal.js';
import { solveThermoStatic, solveBuckling } from './buckling.js';
import { solveThermoHistory } from './thermal-history.js';
import { tetPlotMesh } from './tet-worker.js';

const progress = (ctx) => { let last = 0; return (f) => { const now = Date.now(); if (now - last > 150) { last = now; ctx.progress(Math.max(0, Math.min(1, f))); } }; };
function plotMeshOf(job, ctx) {
  const pm = refineMesh(job.mesh, job.h);
  ctx.transfer(pm.positions.buffer, pm.indices.buffer, pm.triFace.buffer);
  return { positions: pm.positions, indices: pm.indices, triFace: pm.triFace };
}
/** A nodal grid field (comps per node) at every plot-mesh vertex. */
function sample(model, values, comps, pm) {
  const nv = pm.positions.length / 3, out = new Float32Array(nv * comps), t = new Float64Array(comps);
  for (let v = 0; v < nv; v++) { sampleField(model, values, comps, [pm.positions[3 * v], pm.positions[3 * v + 1], pm.positions[3 * v + 2]], t); for (let c = 0; c < comps; c++) out[comps * v + c] = t[c]; }
  return out;
}

export function thermalSolve(job, ctx = { progress() {}, transfer() {} }) {
  const r = solveThermalStudy(job, progress(ctx));
  const pm = plotMeshOf(job, ctx);
  const T = sample(r.model, r.T, 1, pm);
  const qn = Float64Array.from(r.flux.node, (v) => (Number.isFinite(v) ? v * 1e6 : 0));   // W/mm² → W/m²
  const qv = sample(r.model, qn, 3, pm), q = new Float32Array(T.length);
  for (let v = 0; v < q.length; v++) q[v] = Math.hypot(qv[3 * v], qv[3 * v + 1], qv[3 * v + 2]);
  ctx.transfer(T.buffer, q.buffer, qv.buffer);
  const frames = r.transient ? r.frames.map((F) => { const f = sample(r.model, F, 1, pm); ctx.transfer(f.buffer); return f; }) : [];
  return {
    kind: 'thermal', transient: r.transient, summary: r.summary, material: r.material, minT: r.minT, maxT: r.maxT, maxFlux: r.maxFlux,
    balance: r.balance, bcAreas: r.bcAreas, iterations: r.iterations, residual: r.residual, radiation: r.radiation, times: r.times, ms: r.ms,
    vertex: { T, q, qv }, frames, plotMesh: pm,
  };
}

export function thermoStaticSolve(job, ctx = { progress() {}, transfer() {} }) {
  const r = solveThermoStatic(job, progress(ctx));
  const pm = plotMeshOf(job, ctx);
  const v = onMesh(r.model, r, r.u, pm);
  ctx.transfer(v.vm.buffer, v.disp.buffer, v.u.buffer);
  if (r.dT) { v.dT = sample(r.model, r.dT, 1, pm); ctx.transfer(v.dT.buffer); }
  return {
    kind: 'static', summary: r.summary, iterations: r.iterations, residual: r.residual, material: r.material, ms: r.ms,
    maxVm: r.maxVm, maxVmElem: r.maxVmElem, maxDisp: r.maxDisp, minSafety: r.minSafety, reaction: r.reaction, groupReactions: r.groupReactions, loadTotal: r.loadTotal,
    thermal: r.thermal, vertex: v, plotMesh: pm,
  };
}

export function bucklingSolve(job, ctx = { progress() {}, transfer() {} }) {
  const r = solveBuckling(job, progress(ctx));
  const pm = plotMeshOf(job, ctx);
  const shapes = r.shapes.map((u) => {
    const out = sample(r.model, u, 3, pm);
    let mx = 0; for (let v = 0; v < out.length; v += 3) mx = Math.max(mx, Math.hypot(out[v], out[v + 1], out[v + 2]));
    for (let i = 0; i < out.length; i++) out[i] /= mx || 1;
    ctx.transfer(out.buffer);
    return out;
  });
  return {
    kind: 'buckling', summary: r.summary, material: r.material, factors: r.factors, converged: r.converged, eigIterations: r.eigIterations, solves: r.solves, solveResidual: r.solveResidual,
    negative: r.negative, loadTotal: r.loadTotal, loadMagnitude: r.loadMagnitude, preMaxVm: r.preMaxVm, preMaxDisp: r.preMaxDisp, reaction: r.reaction, preIterations: r.preIterations,
    thermal: r.thermal, shapes, plotMesh: pm, ms: r.ms,
  };
}

export function thermoHistorySolve(job, ctx = { progress() {}, transfer() {} }) {
  const tet = job.mesher === 'tet', frames = [];
  let pm = null;
  const at = (values, comps = 1) => { const out = new Float32Array(pm.node.length * comps); pm.node.forEach((n, v) => { for (let c = 0; c < comps; c++) out[comps * v + c] = values[comps * n + c]; }); return out; };
  const r = solveThermoHistory(job, progress(ctx), null, {
    onFrame(i, { u, res, dT, model }) {
      if (!pm) pm = tet ? tetPlotMesh(model) : refineMesh(job.mesh, job.h);
      let v;
      if (tet) v = { vm: at(res.vm), disp: at(res.disp), u: at(u, 3), s1: at(res.s1), s3: at(res.s3), strain: at(res.strain), dT: at(dT) };
      else { v = onMesh(model, res, u, pm); v.dT = sample(model, dT, 1, pm); }
      frames.push(v);
    },
  });
  const h = r.history, vertex = frames[h.worst];
  for (const f of frames) ctx.transfer(...Object.values(f).map((a) => a.buffer));
  const plotMesh = tet ? { positions: pm.positions, indices: pm.indices, triFace: pm.triFace, lines: pm.lines } : { positions: pm.positions, indices: pm.indices, triFace: pm.triFace };
  ctx.transfer(...Object.values(plotMesh).map((a) => a.buffer));
  return {
    kind: 'static', ...(tet ? { mesher: 'tet' } : {}), summary: r.summary, iterations: r.iterations, residual: r.residual, material: r.material, ms: r.ms,
    maxVm: r.maxVm, maxVmElem: r.maxVmElem, maxDisp: r.maxDisp, minSafety: r.minSafety, reaction: r.reaction, groupReactions: r.groupReactions, loadTotal: r.loadTotal,
    ...(tet ? { maxS1: r.maxS1, minS3: r.minS3, errorPct: r.errorPct } : {}),
    thermal: r.thermal, history: { at: h.at, times: h.times, maxVm: h.maxVm, maxDisp: h.maxDisp, iterations: h.iterations, worst: h.worst, maxVmAt: h.maxVmAt },
    vertex, frames, plotMesh,
  };
}

addOps({ thermalSolve, thermoStaticSolve, bucklingSolve, thermoHistorySolve });
