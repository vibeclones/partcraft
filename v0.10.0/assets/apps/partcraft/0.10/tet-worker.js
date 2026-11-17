/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tet-worker.js — the tetrahedral-mesh studies as one compute-worker op (compute-worker.js; DOM-free).
 *   tetSolve(job)   job.kind static (with or without a thermal load) | modal | thermal | buckling on the T10 mesh; with
 *                   job.adaptive { target %, passes, maxElements } a static study without a thermal load or a steady
 *                   thermal study is refined and re-solved (tetadapt.js) and the result carries `adaptive` (the table);
 *                   (tetfea.js, tet-elements.js) → the same result shapes as sim-worker simSolve / thermal-worker ops, but
 *                   the plot mesh is the tet mesh's own surface: every boundary T6 face split into 4 triangles through its
 *                   midside nodes (so curved faces stay curved), carrying nodal values directly (no resampling), plus
 *                   `lines` (index pairs along the element edges, for the mesh overlay) and `summary.quality`.
 * Cancel = terminate the worker. Progress: ctx.progress(0…1).
 */
import { addOps } from './worker-ops.js';
import { solveTetStudy, solveTetOnMesh } from './tetfea.js';
import { solveTetThermal, solveTetThermalOnMesh, solveTetThermoStatic, solveTetBuckling, solveTetBucklingOnMesh } from './tet-elements.js';
import { adaptiveTet } from './tetadapt.js';

const progress = (ctx) => { let last = 0; return (f) => { const now = Date.now(); if (now - last > 150) { last = now; ctx.progress(Math.max(0, Math.min(1, f))); } }; };

/** The boundary of a T10 model as a plot mesh → { positions, indices, triFace, lines, node (model node per vertex) } */
export function tetPlotMesh(model) {
  const map = new Map(), node = [];
  const vid = (n) => { let v = map.get(n); if (v === undefined) { v = node.length; map.set(n, v); node.push(n); } return v; };
  const nb = model.btri6.length / 6, idx = new Uint32Array(nb * 12), tf = new Int32Array(nb * 4), seen = new Set(), lines = [];
  for (let t = 0; t < nb; t++) {
    const [c0, c1, c2, m01, m12, m20] = Array.from(model.btri6.subarray(6 * t, 6 * t + 6), vid);
    idx.set([c0, m01, m20, m01, c1, m12, m20, m12, c2, m01, m12, m20], 12 * t);
    tf.fill(model.bface[t], 4 * t, 4 * t + 4);
    for (const [a, m, b] of [[c0, m01, c1], [c1, m12, c2], [c2, m20, c0]]) { const k = Math.min(a, b) * 4294967296 + Math.max(a, b); if (seen.has(k)) continue; seen.add(k); lines.push(a, m, m, b); }
  }
  const positions = new Float32Array(3 * node.length);
  node.forEach((n, v) => { positions[3 * v] = model.X[3 * n]; positions[3 * v + 1] = model.X[3 * n + 1]; positions[3 * v + 2] = model.X[3 * n + 2]; });
  return { positions, indices: idx, triFace: tf, lines: Uint32Array.from(lines), node: Int32Array.from(node) };
}
const at = (pm, values, comps = 1) => { const out = new Float32Array(pm.node.length * comps); pm.node.forEach((n, v) => { for (let c = 0; c < comps; c++) out[comps * v + c] = values[comps * n + c]; }); return out; };
const shapeAt = (pm, u) => { const out = at(pm, u, 3); let mx = 0; for (let v = 0; v < out.length; v += 3) mx = Math.max(mx, Math.hypot(out[v], out[v + 1], out[v + 2])); for (let i = 0; i < out.length; i++) out[i] /= mx || 1; return out; };
const send = (ctx, pm) => { ctx.transfer(pm.positions.buffer, pm.indices.buffer, pm.triFace.buffer, pm.lines.buffer); return { positions: pm.positions, indices: pm.indices, triFace: pm.triFace, lines: pm.lines }; };

/** Adaptive refinement applies to a static or buckling study without a thermal load, a modal study (0.4) and a steady thermal study (tetadapt.js). */
const noThermalLoad = (job) => !(job.thermalLoad && job.thermalLoad.mode && job.thermalLoad.mode !== 'none');
export const adaptiveApplies = (job) => !!job.adaptive && (((job.kind === 'static' || job.kind === 'buckling') && noThermalLoad(job)) || job.kind === 'modal' || (job.kind === 'thermal' && !job.transient));
/** The last pass's result with `adaptive` (the convergence table and why it stopped) attached. */
function adaptive(job, solve, prog) { const out = adaptiveTet(job, (cur, p) => solve(job, cur, p), { onProgress: prog }); out.result.adaptive = out.adaptive; return out.result; }

export function tetSolve(job, ctx = { progress() {}, transfer() {} }) {
  const prog = progress(ctx);
  const loaded = job.thermalLoad && job.thermalLoad.mode && job.thermalLoad.mode !== 'none';
  const adapt = adaptiveApplies(job);
  if (job.kind === 'thermal') {
    const r = adapt ? adaptive(job, solveTetThermalOnMesh, prog) : solveTetThermal(job, prog), pm = tetPlotMesh(r.model);
    const T = at(pm, r.T), qn = Float64Array.from(r.flux.node, (v) => (Number.isFinite(v) ? v * 1e6 : 0)), qv = at(pm, qn, 3), q = new Float32Array(T.length);
    for (let v = 0; v < q.length; v++) q[v] = Math.hypot(qv[3 * v], qv[3 * v + 1], qv[3 * v + 2]);
    ctx.transfer(T.buffer, q.buffer, qv.buffer);
    const frames = r.transient ? r.frames.map((F) => { const f = at(pm, F); ctx.transfer(f.buffer); return f; }) : [];
    return {
      kind: 'thermal', mesher: 'tet', transient: r.transient, summary: r.summary, material: r.material, minT: r.minT, maxT: r.maxT, maxFlux: r.maxFlux,
      balance: r.balance, bcAreas: r.bcAreas, iterations: r.iterations, residual: r.residual, radiation: r.radiation, times: r.times, ms: r.ms,
      errorPct: r.errorPct ?? null, adaptive: r.adaptive || null, vertex: { T, q, qv }, frames, plotMesh: send(ctx, pm),
    };
  }
  if (job.kind === 'buckling') {
    const r = adapt ? adaptive(job, solveTetBucklingOnMesh, prog) : solveTetBuckling(job, prog), pm = tetPlotMesh(r.model);
    const shapes = r.shapes.map((u) => { const s = shapeAt(pm, u); ctx.transfer(s.buffer); return s; });
    return {
      kind: 'buckling', mesher: 'tet', summary: r.summary, material: r.material, factors: r.factors, converged: r.converged, eigIterations: r.eigIterations, solves: r.solves, solveResidual: r.solveResidual,
      negative: r.negative, loadTotal: r.loadTotal, loadMagnitude: r.loadMagnitude, preMaxVm: r.preMaxVm, preMaxDisp: r.preMaxDisp, reaction: r.reaction, preIterations: r.preIterations,
      thermal: r.thermal, shapes, plotMesh: send(ctx, pm), ms: r.ms, errorPct: r.errorPct ?? null, adaptive: r.adaptive || null,
    };
  }
  if (job.kind === 'modal') {
    const r = adapt ? adaptive(job, solveTetOnMesh, prog) : solveTetStudy(job, prog), pm = tetPlotMesh(r.model);
    const shapes = r.shapes.map((u) => { const s = shapeAt(pm, u); ctx.transfer(s.buffer); return s; });
    return { kind: 'modal', mesher: 'tet', summary: r.summary, freqs: r.freqs, shapes, iterations: r.iterations, residuals: r.residuals, plotMesh: send(ctx, pm), ms: r.ms, errorPct: r.errorPct ?? null, adaptive: r.adaptive || null };
  }
  const r = loaded ? solveTetThermoStatic(job, prog) : adapt ? adaptive(job, solveTetOnMesh, prog) : solveTetStudy(job, prog), pm = tetPlotMesh(r.model);
  const vertex = { vm: at(pm, r.vm), disp: at(pm, r.disp), u: at(pm, r.u, 3), s1: at(pm, r.s1), s3: at(pm, r.s3), strain: at(pm, r.strain) };
  if (r.dT) vertex.dT = at(pm, r.dT);
  ctx.transfer(...Object.values(vertex).map((a) => a.buffer));
  return {
    kind: 'static', mesher: 'tet', summary: r.summary, iterations: r.iterations, residual: r.residual, material: r.material, ms: r.ms,
    maxVm: r.maxVm, maxVmElem: r.maxVmElem, maxDisp: r.maxDisp, minSafety: r.minSafety, reaction: r.reaction, groupReactions: r.groupReactions, loadTotal: r.loadTotal,
    maxS1: r.maxS1, minS3: r.minS3, errorPct: r.errorPct, loadAreas: r.groups.loads.map((g) => ({ type: g.type, area: g.area ?? null, exactArea: g.exactArea ?? null })),
    thermal: r.thermal || null, adaptive: r.adaptive || null, vertex, plotMesh: send(ctx, pm),
  };
}

addOps({ tetSolve });
