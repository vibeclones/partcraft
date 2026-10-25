/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tetadapt.js — automatic mesh refinement (h-adaptive re-solve) for the tetrahedral studies (DOM-free; the compute worker
 * runs it). Builds on tetmesh.js (bisectRefine, projection onto the exact faces, toT10) and tetfea.js (the solve and the
 * Zienkiewicz–Zhu error estimate).
 *
 * Loop (adaptiveTet): mesh → solve → estimate → stop if the estimated error ≤ the target %, or the passes or the element
 * limit are used up → mark → refine → solve again.
 *  - Estimate: the Zienkiewicz–Zhu indicator per element, e_K = ‖σ* − σh‖ in the energy norm (σ* = the nodal average), and
 *    the global η = √(Σe²/(U + Σe²)) as a % (U = ∫σh:C⁻¹:σh). It is an estimate, not a bound: it can read low where the
 *    averaged field is itself wrong (a coarse mesh across a concentration) and it grows without end at singular corners.
 *  - Marking: Dörfler's bulk criterion — the fewest elements whose e_K² add up to θ (0.5) of Σe² — never more than
 *    `maxFraction` (0.3) of the elements.
 *  - New size of a marked element (Zienkiewicz–Zhu): h_new = h × (ē / e_K)^(1/p), p = 2 (quadratic elements),
 *    ē = target × √((U + Σe²) / m) the even share of the allowed error, clamped to ½…0.7 of h per pass.
 *  - Refinement: conforming longest-edge bisection (Rivara) of the linear tets until each marked element's pieces are
 *    no longer than its new size (its neighbours split only as far as conformity needs); one bisection round at a time,
 *    new vertices on boundary edges projected onto the exact faces (planes, cylinders, surfaces.js records; else the
 *    tessellation) when no tet around them inverts or drops below the worse of 10° and its angle before; then the
 *    quadratic tets again (toT10: curved midside nodes). Elements outside the marked region keep their nodes.
 * Every pass is a full re-solve (no prolongation of the previous answer). A pass that fails, or a refined mesh past the
 * limit, ends the loop with the last good answer and says why.
 */
import { Pts, bisectRefine, buildBVH, tetVolume, tetQuality, meshQuality, projectToFaces, faceCounts, toT10 } from './tetmesh.js';
import { meshJob, makeTetModel } from './tetfea.js';
import { t } from './i18n.js';

const PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];   // outward faces of a positive tet (as tetmesh finishMesh)

/** Longest edge of tet e of T (flat 4s) over coordinates A. */
function longestEdge(A, T, e) {
  let l = 0;
  for (const [i, j] of PAIRS) { const a = 3 * T[4 * e + i], b = 3 * T[4 * e + j]; l = Math.max(l, (A[a] - A[b]) ** 2 + (A[a + 1] - A[b + 1]) ** 2 + (A[a + 2] - A[b + 2]) ** 2); }
  return Math.sqrt(l);
}
/** Boundary faces (used once) of tets T → flat triangles, outward. */
function boundaryOf(T) {
  const fmap = new Map();
  for (let e = 0; e < T.length / 4; e++) for (let k = 0; k < 4; k++) {
    const f = FACES[k].map((i) => T[4 * e + i]), s = f.slice().sort((x, y) => x - y), key = s[0] + ',' + s[1] + ',' + s[2];
    if (fmap.has(key)) fmap.delete(key); else fmap.set(key, f);
  }
  const out = new Int32Array(fmap.size * 3); let i = 0;
  for (const f of fmap.values()) { out[i++] = f[0]; out[i++] = f[1]; out[i++] = f[2]; }
  return out;
}

/**
 * Refine the linear tet mesh tm (tetmesh.js shape) where target[e] (the wanted longest edge of tet e) is shorter than
 * its longest edge. faces: the job's face records; mesh: the part's tessellation (projection fallback); bvh over it.
 * → a new linear mesh { nodes, tets, btri, bface, quality, stats, parent (old tet of each new one) }.
 */
export function refineTets(tm, mesh, faces, bvh, target, { maxTets = 400000, rounds = 9 } = {}) {
  const nn0 = tm.nodes.length / 3, pts = new Pts(nn0 * 2 + 1024);
  for (let i = 0; i < nn0; i++) pts.push(tm.nodes[3 * i], tm.nodes[3 * i + 1], tm.nodes[3 * i + 2]);
  let T = Array.from(tm.tets), btri = tm.btri, bface = tm.bface, projected = 0, kept = 0, done = 0;
  const tags = { a: Array.from({ length: T.length / 4 }, (_, e) => e) };
  for (let round = 0; round < rounds; round++) {
    const n0 = pts.n;
    T = bisectRefine(pts, T, (e, Tt, G) => longestEdge(pts.a, Tt, e) > 1.0001 * target[G[e]], { rounds: 1, maxTets, tags });
    if (pts.n === n0) break;
    done++;
    // the new boundary: each triangle lies in an old boundary triangle (nothing has moved yet): it takes that one's face
    const nb = boundaryOf(T), nbf = new Int32Array(nb.length / 3).fill(-1);
    const old = buildBVH({ positions: pts.a, indices: btri });
    for (let t = 0; t < nb.length / 3; t++) {
      const c = [0, 1, 2].map((a) => (pts.a[3 * nb[3 * t] + a] + pts.a[3 * nb[3 * t + 1] + a] + pts.a[3 * nb[3 * t + 2] + a]) / 3), h = old.closest(c);
      nbf[t] = h.tri >= 0 ? bface[h.tri] : -1;
    }
    // new boundary vertices onto the exact faces of their triangles, guarded by the angles of the tets around them
    const vf = new Map();
    for (let t = 0; t < nb.length / 3; t++) for (let k = 0; k < 3; k++) { const v = nb[3 * t + k]; if (v < n0) continue; let s = vf.get(v); if (!s) vf.set(v, (s = new Set())); if (nbf[t] >= 0) s.add(nbf[t]); }
    if (vf.size) {
      const around = new Map();
      for (let e = 0; e < T.length / 4; e++) for (let k = 0; k < 4; k++) { const v = T[4 * e + k]; if (!vf.has(v)) continue; let l = around.get(v); if (!l) around.set(v, (l = [])); l.push(e); }
      const quad = (e) => [T[4 * e], T[4 * e + 1], T[4 * e + 2], T[4 * e + 3]];
      for (const [v, fs] of vf) {
        if (!fs.size || fs.size > 3) continue;
        const p = pts.get(v), q = projectToFaces(p, [...fs], faces, bvh, mesh.triFace), els = around.get(v) || [];
        if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-14 * bvh.diag) continue;
        const before = Math.min(...els.map((e) => tetQuality(pts.a, quad(e)).minDih));
        pts.a[3 * v] = q[0]; pts.a[3 * v + 1] = q[1]; pts.a[3 * v + 2] = q[2];
        if (els.every((e) => tetVolume(pts.a, ...quad(e)) > 0 && tetQuality(pts.a, quad(e)).minDih >= Math.min(10, before))) projected++;
        else { pts.a[3 * v] = p[0]; pts.a[3 * v + 1] = p[1]; pts.a[3 * v + 2] = p[2]; kept++; }
      }
    }
    btri = nb; bface = nbf;
  }
  const nodes = Float64Array.from(pts.a.subarray(0, 3 * pts.n)), tets = Int32Array.from(T), m = tets.length / 4;
  let vol = 0; for (let e = 0; e < m; e++) vol += tetVolume(nodes, tets[4 * e], tets[4 * e + 1], tets[4 * e + 2], tets[4 * e + 3]);
  return {
    nodes, tets, btri, bface, quality: meshQuality(nodes, tets), parent: Int32Array.from(tags.a),
    stats: { ...tm.stats, nodes: pts.n, tets: m, boundaryTris: btri.length / 3, volume: vol, refineRounds: done, refinedNew: pts.n - nn0, projectedNew: projected, keptOnChord: kept, ...faceCounts(bface, faces) },
  };
}

/**
 * Which elements to refine and to what size → { target: Float64Array (Infinity = leave), marked, share (of Σe² marked) }.
 * err: e_K per element; energy U; errSq Σe²; tm: the linear mesh (element sizes); opts { target %, theta, maxFraction }.
 */
export function markForRefinement(tm, err, energy, errSq, { target = 5, theta = 0.5, maxFraction = 0.3, p = 2 } = {}) {
  const m = err.length, order = Array.from({ length: m }, (_, e) => e).sort((a, b) => err[b] - err[a]);
  const goal = theta * errSq, cap = Math.max(1, Math.floor(maxFraction * m)), out = new Float64Array(m).fill(Infinity);
  const ebar = target / 100 * Math.sqrt((energy + errSq) / m);
  let sum = 0, marked = 0;
  for (const e of order) {
    if (sum >= goal || marked >= cap) break;
    sum += err[e] * err[e]; marked++;
    const xi = err[e] / Math.max(ebar, 1e-300), f = Math.max(0.5, Math.min(0.7, xi ** (-1 / p)));
    out[e] = f * longestEdge(tm.nodes, tm.tets, e);
  }
  return { target: out, marked, share: errSq > 0 ? sum / errSq : 0 };
}

/**
 * The adaptive loop. job: a tet job with job.adaptive { target (%), passes (max solves, 1–10), maxElements };
 * solvePass(mesh { tm, t10, model, bvh, faces }, onProgress) → a result with err (per element), errorPct, energy, errSq,
 * and the plotted quantities (maxVm, maxDisp — or maxT, maxFlux for heat). → { result (the last good pass), adaptive:
 * { passes: [{ pass, elements, nodes, dofs, errorPct, maxVm, maxDisp, maxT, maxFlux, freqs, factors (modal / buckling, 0.4), ms }], stop 'target' | 'passes' |
 * 'elements' | 'failed', converged, message, target } }
 */
export function adaptiveTet(job, solvePass, { onProgress = () => {}, cancelled = null } = {}) {
  const a = job.adaptive || {}, target = a.target ?? 5, passes = Math.max(1, Math.min(10, a.passes ?? 5)), maxElements = a.maxElements || 150000;
  const span = (i) => (f, what) => onProgress(Math.min(0.999, (i + f) / passes), `Pass ${i + 1}: ${what || ''}`.trim());   // i18n-ignore: progress label, never shown
  let cur = meshJob(job, span(0)), last = null, stop = null, message = '';
  const rows = [];
  for (let i = 0; ; i++) {
    const t0 = Date.now();
    let r;
    try { r = solvePass(cur, span(i)); } catch (e) {
      if (!last || (e && e.message === 'Cancelled')) throw e;
      stop = 'failed'; message = t('study.adapt.msg.failed', { n: i + 1, msg: e && e.message ? e.message : String(e), prev: i }); break;
    }
    last = r;
    rows.push({ pass: i + 1, elements: r.summary.elements, nodes: r.summary.nodes, dofs: r.summary.dofs, errorPct: r.errorPct, maxVm: r.maxVm ? r.maxVm.value : null, maxDisp: r.maxDisp ? r.maxDisp.value : null, maxT: r.maxT ?? null, maxFlux: r.maxFlux ?? null, freqs: r.freqs ? r.freqs.slice(0, 6) : null, factors: r.factors ? r.factors.slice(0, 6) : null, errorParts: r.errorParts || null, quality: r.summary.quality ? r.summary.quality.minDihedral : null, ms: Date.now() - t0 });
    if (r.errorPct <= target) { stop = 'target'; message = t('study.adapt.msg.target', { err: r.errorPct.toFixed(2), target, n: i + 1 }); break; }
    if (i + 1 >= passes) { stop = 'passes'; message = t('study.adapt.msg.passes', { n: passes, err: r.errorPct.toFixed(2), target }); break; }
    if (cancelled && cancelled()) throw new Error('Cancelled');
    span(i)(0.99, 'Refining');
    const mk = markForRefinement(cur.tm, r.err, r.energy, r.errSq, { target });
    let tm2;
    try { tm2 = refineTets(cur.tm, job.mesh, cur.faces, cur.bvh, mk.target, { maxTets: 2 * maxElements }); } catch (e) { stop = 'failed'; message = t('study.adapt.msg.refine_failed', { n: i + 1, msg: e && e.message ? e.message : String(e) }); break; }
    if (tm2.tets.length / 4 > maxElements) { stop = 'elements'; message = t('study.adapt.msg.elements', { n: i + 1, count: (tm2.tets.length / 4).toLocaleString('en-US'), max: maxElements.toLocaleString('en-US'), err: r.errorPct.toFixed(2), target }); break; }
    const t10 = toT10(tm2, job.mesh, cur.faces, cur.bvh);
    cur = { tm: tm2, t10, model: makeTetModel(t10), bvh: cur.bvh, faces: cur.faces };
  }
  return { result: last, adaptive: { passes: rows, stop, converged: stop === 'target', message, target } };
}
