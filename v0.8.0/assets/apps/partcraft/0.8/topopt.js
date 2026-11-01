/* SPDX-License-Identifier: Apache-2.0 */
/**
 * topopt.js — generative design by topology optimisation (DOM-free), on fea.js's voxel model.
 *
 * Method: SIMP (solid isotropic material with penalisation), minimum compliance (sum over load cases)
 * subject to a volume fraction, as in Sigmund's 99-line / Andreassen et al.'s 88-line codes, in 3D:
 *   E(x) = Emin + x^p (E0 − Emin), p = 3, Emin = 1e-9·E0; density filter (linear hat, radius rmin =
 *   the minimum member size knob: features thinner than about 2·rmin do not form); optimality-criteria
 *   update (move 0.2, damping ½) with bisection on the Lagrange multiplier so the filtered (physical)
 *   densities meet the volume fraction every iteration. Stops when no density moves more than `tolChange`
 *   (0.01) or after maxIter. Each solve is fea.js's PCG with mg.js's multigrid rebuilt for the new densities,
 *   warm-started from the last iteration.
 * Regions: preserve (elements within a distance of picked faces — kept solid, x = 1; the elements touching
 *   loaded or fixed faces are always kept, frictionless ones are not: they are often symmetry planes), obstacle (elements
 *   near picked faces or inside boxes — removed from the domain). Design space: the part's own voxels, or a
 *   box around it (loads and supports then act on the grid nodes nearest the picked faces).
 * Result: the density field; `isoSurface` turns it into a closed triangle mesh (surface nets on the nodal
 *   densities at 0.5, ambiguous cells filled so the surface stays manifold, then Taubin smoothing), and
 *   `evaluate` re-solves the thresholded design (x > 0.5 solid) with the real material (h8i) to give honest
 *   mass, stress, displacement and safety factor. For one material the optimal shape does not depend on E:
 *   outcomes that differ only in material share the shape and differ in mass and stress.
 * Limits: one material, linear static, compliance (stiffness) objective — no stress constraint, no
 * manufacturing constraints (overhang, milling direction), grey elements remain at member edges; the
 * output surface is faceted (thousands of triangles), not a parametric B-rep.
 */
import * as VX from './voxel.js';
import * as FE from './fea.js';
import { readMaterial, tonnesPerMm3 } from './materials.js';
import { t } from './i18n.js';

const EMIN = 1e-9;

/** Filter neighbours: offsets within radius r (element units) with hat weights. */
function filterStencil(r) {
  const R = Math.ceil(r) - (Number.isInteger(r) ? 1 : 0) + 1, out = [];
  for (let k = -R; k <= R; k++) for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const w = r - Math.hypot(i, j, k); if (w > 0) out.push([i, j, k, w]); }
  return out;
}

/** Density filter over the model's elements: apply(src) = Σ w·src / Σ w and its transpose. */
export function makeFilter(model, rElems) {
  const g = model.grid, ne = model.elems.length, map = new Int32Array(g.nx * g.ny * g.nz).fill(-1);
  model.elems.forEach((e, m) => { map[e] = m; });
  const st = filterStencil(Math.max(rElems, 1.0001)), Hs = new Float64Array(ne);
  const ijk = new Int32Array(ne * 3);
  model.elems.forEach((e, m) => { const i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny)); ijk[3 * m] = i; ijk[3 * m + 1] = j; ijk[3 * m + 2] = k; });
  const each = (m, fn) => {
    const i = ijk[3 * m], j = ijk[3 * m + 1], k = ijk[3 * m + 2];
    for (const [di, dj, dk, w] of st) {
      const a = i + di, b = j + dj, c = k + dk;
      if (a < 0 || b < 0 || c < 0 || a >= g.nx || b >= g.ny || c >= g.nz) continue;
      const n = map[a + g.nx * (b + g.ny * c)];
      if (n >= 0) fn(n, w);
    }
  };
  // neighbour lists once (CSR): the filter runs ~40 times per iteration inside the bisection
  const start = new Int32Array(ne + 1), nb = [], wt = [];
  for (let m = 0; m < ne; m++) { each(m, (n, w) => { nb.push(n); wt.push(w); Hs[m] += w; }); start[m + 1] = nb.length; }
  const N = Int32Array.from(nb), Wt = Float64Array.from(wt);
  return {
    apply(src, dst = new Float64Array(ne)) { for (let m = 0; m < ne; m++) { let s = 0; for (let q = start[m]; q < start[m + 1]; q++) s += Wt[q] * src[N[q]]; dst[m] = s / Hs[m]; } return dst; },
    // dst_n = Σ_m w_mn src_m / Hs_m
    transpose(src, dst = new Float64Array(ne)) { dst.fill(0); for (let m = 0; m < ne; m++) { const v = src[m] / Hs[m]; for (let q = start[m]; q < start[m + 1]; q++) dst[N[q]] += Wt[q] * v; } return dst; },
    stencil: st.length,
  };
}

/** uᵀ Ke u per element (unit E·h). */
function elementEnergy(model, u, out) {
  const { node0, off, Ke } = model, ue = new Float64Array(24);
  for (let m = 0; m < node0.length; m++) {
    const n0 = node0[m];
    for (let c = 0; c < 8; c++) { const d = 3 * (n0 + off[c]); ue[3 * c] = u[d]; ue[3 * c + 1] = u[d + 1]; ue[3 * c + 2] = u[d + 2]; }
    let s = 0;
    for (let i = 0, r = 0; i < 24; i++, r += 24) { let t = 0; for (let j = 0; j < 24; j++) t += Ke[r + j] * ue[j]; s += ue[i] * t; }
    out[m] = s;
  }
  return out;
}

/**
 * The design domain → { grid, model, passive (Int8 per model element: 1 solid, 0 free) }.
 * job { mesh, h, designSpace 'part'|'box', box?, preserve:[{faces, t}], obstacle:[{faces, t}|{box:{min,max}}] }
 */
export function designDomain(job, mat) {
  const surfaceOnly = (job.designSpace || 'part') === 'part';
  const grid = surfaceOnly ? VX.voxelize(job.mesh, { h: job.h }) : VX.boxGrid(job.box || VX.meshBBox(job.mesh), job.h);
  const keep = new Uint8Array(grid.solid.length), drop = new Uint8Array(grid.solid.length);
  for (const r of job.preserve || []) if (r.faces && r.faces.length) VX.elementsNearFaces(grid, job.mesh, r.faces, Math.max(r.t || 0, grid.h * 0.5)).forEach((v, e) => { if (v) keep[e] = 1; });
  for (const r of job.obstacle || []) {
    if (r.box) {
      for (let e = 0; e < grid.solid.length; e++) { const c = VX.elemCentre(grid, e); if ([0, 1, 2].every((a) => c[a] >= r.box.min[a] && c[a] <= r.box.max[a])) drop[e] = 1; }
    } else if (r.faces && r.faces.length) VX.elementsNearFaces(grid, job.mesh, r.faces, Math.max(r.t || 0, grid.h * 0.5)).forEach((v, e) => { if (v) drop[e] = 1; });
  }
  for (let e = 0; e < grid.solid.length; e++) if (drop[e] && !keep[e]) grid.solid[e] = 0;
  grid.count = grid.solid.reduce((s, v) => s + v, 0);
  if (surfaceOnly) grid.surf = VX.surfaceMap(grid, job.mesh);
  const model = FE.makeModel(grid, { E: mat.E, nu: mat.nu, type: job.elem || 'h8' });
  const passive = Int8Array.from(model.elems, (e) => (keep[e] ? 1 : 0));
  return { grid, model, passive, surfaceOnly };
}

/**
 * Run the optimisation. job: designDomain's fields + { material, constraints:[…], cases:[[loads…]] (or
 * loads: one case), volfrac, rmin (mm), penal 3, maxIter 60, tolChange 0.01, move 0.2, projection (threshold projection, β 1 → 16) }.
 * → { x (physical densities per model element), grid, model, history:[{c, vol, change}], iterations, converged }
 */
export function optimize(job, onProgress = () => {}, cancelled = null) {
  const mat = readMaterial(job.material);
  onProgress(0, t('gen.opt.building'));
  const { grid, model, passive, surfaceOnly } = designDomain(job, mat);
  const ne = model.elems.length;
  if (!ne) throw new Error(t('gen.opt.empty'));
  const volfrac = job.volfrac, p = job.penal || 3, move0 = job.move ?? 0.2, maxIter = job.maxIter || 60, tolChange = job.tolChange ?? 0.01;
  if (!(volfrac > 0 && volfrac <= 1)) throw new Error(t('gen.opt.volfrac'));
  const exactArea = job.faces ? job.faces.map((f) => f.area || 0) : null, rho = tonnesPerMm3(mat.density);
  const cases = (job.cases || [job.loads || []]).map((loads) => FE.boundaryConditions(model, job.mesh, { constraints: job.constraints, loads: loads.filter((l) => l.type !== 'gravity') }, { surfaceOnly, exactArea, density: rho }));
  const cons = cases[0].cons;
  // the elements touching loaded or fixed nodes stay solid (so the design keeps hold of its supports and loads);
  // frictionless faces are often symmetry planes and are left free
  if (job.keepBC !== false) {
    const bcNodes = new Uint8Array(model.nn);
    cases[0].groups.constraints.forEach((gr, i) => { if (job.constraints[i].type === 'fixed') for (const n of gr.nodes) bcNodes[n] = 1; });
    for (const bc of cases) for (const gr of bc.groups.loads) for (const n of gr.nodes) bcNodes[n] = 1;
    for (let m = 0; m < ne; m++) for (let c = 0; c < 8; c++) if (bcNodes[model.node0[m] + model.off[c]]) { passive[m] = 1; break; }
  }
  const nPass = passive.reduce((s, v) => s + v, 0);
  if (nPass >= volfrac * ne) throw new Error(t('gen.opt.preserve_full'));
  const free = FE.rigidCheck(model, cons);
  if (free) throw new Error(t('gen.opt.not_held', { motions: free.join(', ') }));
  const filt = makeFilter(model, (job.rmin || 1.5 * grid.h) / grid.h);
  // start uniform: free elements at the value that meets the volume with passives solid
  const x = new Float64Array(ne).fill(Math.min(1, (volfrac * ne - nPass) / (ne - nPass)));
  for (let m = 0; m < ne; m++) if (passive[m]) x[m] = 1;
  // optional threshold projection (Wang, Lazarov & Sigmund 2011, η = 0.5) with β doubling 1 → 16 (every 15 iterations, or sooner when the design settles; the move limit 0.2/√β):
  // xPhys = (tanh βη + tanh β(x̃ − η)) / (tanh βη + tanh β(1 − η)) pushes the filtered densities to 0/1, so the
  // solid extraction keeps the joints the optimum relies on
  const proj = !!job.projection, betaMax = job.betaMax || 16, eta = 0.5;
  let beta = 1, sinceBeta = 0;
  const H = (xt, out) => { const d = Math.tanh(beta * eta) + Math.tanh(beta * (1 - eta)); for (let m = 0; m < ne; m++) out[m] = passive[m] ? 1 : proj ? (Math.tanh(beta * eta) + Math.tanh(beta * (xt[m] - eta))) / d : xt[m]; return out; };
  const dH = (xt, out) => { const d = Math.tanh(beta * eta) + Math.tanh(beta * (1 - eta)); for (let m = 0; m < ne; m++) out[m] = proj ? beta * (1 - Math.tanh(beta * (xt[m] - eta)) ** 2) / d : 1; return out; };
  // filter: 'density' (default; x̃ = H x, exact sensitivities) or 'sensitivity' (Sigmund 1997: x̃ = x, the
  // compliance sensitivities averaged — heuristic, but crisper 0/1 designs with no projection needed)
  const sens = job.filter === 'sensitivity';
  const tilde = (v) => (sens ? Float64Array.from(v) : filt.apply(v));
  let xTilde = tilde(x), xPhys = H(xTilde, new Float64Array(ne));
  const scale = new Float64Array(ne), energy = new Float64Array(ne), dc = new Float64Array(ne), dv = new Float64Array(ne), dh = new Float64Array(ne);
  const us = cases.map(() => null), history = [];
  const xnew = new Float64Array(ne);
  let it = 0, change = 1;
  for (; it < maxIter; it++) {
    for (let m = 0; m < ne; m++) scale[m] = EMIN + Math.pow(xPhys[m], p) * (1 - EMIN);
    let c = 0, cg = 0; dc.fill(0);
    const pre = FE.preconditioner(model, cons, scale);
    cases.forEach((bc, ci) => {
      const sol = FE.pcg(model, bc.cons, bc.f, { x0: us[ci], scale, ...pre, tol: 1e-6, cancelled, onProgress: (fr, msg) => onProgress((it + fr) / maxIter, t('gen.opt.iter', { n: it + 1, msg })) });
      us[ci] = sol.u; cg += sol.iterations;
      elementEnergy(model, sol.u, energy);
      for (let m = 0; m < ne; m++) { c += model.kScale * scale[m] * energy[m]; dc[m] -= p * Math.pow(xPhys[m], p - 1) * (1 - EMIN) * model.kScale * energy[m]; }
    });
    // filter sensitivities (density filter, and the projection: chain rule through both)
    dH(xTilde, dh);
    for (let m = 0; m < ne; m++) { dc[m] *= dh[m]; dv[m] = dh[m]; }
    let dcF, dvF;
    if (sens) { const xd = Float64Array.from(dc, (v, m) => v * x[m]); dcF = filt.apply(xd); for (let m = 0; m < ne; m++) dcF[m] /= Math.max(1e-3, x[m]); dvF = dv; }
    else { dcF = filt.transpose(dc); dvF = filt.transpose(dv); }
    let dmax = 0;
    for (let m = 0; m < ne; m++) { if (passive[m]) dcF[m] = 0; dmax = Math.max(dmax, -dcF[m]); }
    for (let m = 0; m < ne; m++) dcF[m] /= dmax || 1;   // scaled to 1 so the multiplier's bisection range fits any units
    // OC with bisection on the physical volume; the move limit shrinks as the projection sharpens (OC oscillates
    // at a high β with the full 0.2)
    const move = proj ? Math.max(0.02, move0 / Math.sqrt(beta)) : move0;
    let l1 = 0, l2 = 1e9;
    const target = volfrac * ne;
    let xp = xPhys, xt = xTilde;
    while ((l2 - l1) / (l1 + l2) > 1e-5) {
      const lm = 0.5 * (l1 + l2);
      for (let m = 0; m < ne; m++) {
        if (passive[m]) { xnew[m] = 1; continue; }
        const be = Math.sqrt(Math.max(0, -dcF[m]) / (dvF[m] * lm));
        xnew[m] = Math.max(0, Math.max(x[m] - move, Math.min(1, Math.min(x[m] + move, x[m] * be))));
      }
      xt = tilde(xnew); xp = H(xt, new Float64Array(ne));
      let vol = 0; for (let m = 0; m < ne; m++) vol += xp[m];
      if (vol > target) l1 = lm; else l2 = lm;
    }
    change = 0; for (let m = 0; m < ne; m++) change = Math.max(change, Math.abs(xnew[m] - x[m]));
    x.set(xnew); xPhys = xp; xTilde = xt;
    let vol = 0; for (let m = 0; m < ne; m++) vol += xPhys[m];
    history.push({ c, vol: vol / ne, change, cg, beta: proj ? beta : null });
    onProgress((it + 1) / maxIter, t('gen.opt.iter_done', { n: it + 1, c: c.toPrecision(5), vol: (100 * vol / ne).toFixed(1), change: change.toFixed(3) }));
    if (cancelled && cancelled()) throw new Error('Cancelled');   // i18n-ignore: sentinel the callers compare
    sinceBeta++;
    if (proj && beta < betaMax && (change < tolChange || sinceBeta >= 15)) { beta *= 2; sinceBeta = 0; xPhys = H(xTilde, new Float64Array(ne)); continue; }
    if (change < tolChange) { it++; break; }
  }
  // the compliance of the densities returned (the last history entry is of the step before)
  for (let m = 0; m < ne; m++) scale[m] = EMIN + Math.pow(xPhys[m], p) * (1 - EMIN);
  const preF = FE.preconditioner(model, cons, scale);
  let finalC = 0;
  cases.forEach((bc, ci) => { const sol = FE.pcg(model, bc.cons, bc.f, { x0: us[ci], scale, ...preF, tol: 1e-8, cancelled }); for (let i = 0; i < bc.f.length; i++) finalC += bc.f[i] * sol.u[i]; });
  return { x: Float32Array.from(xPhys), grid, model, passive, history, finalC, iterations: it, converged: change < tolChange, material: mat, surfaceOnly, volfrac, consNodes: cons.nodes };
}

/**
 * The design as solid elements: the densest elements up to the optimised volume (Σx, so every outcome holds its
 * target), passives always — and when that leaves a kept (loaded) region cut off from every support, as an
 * unconverged grey design can, the next densest elements until it is not (`added`) — then only the
 * face-connected pieces that touch a support (a floating island carries nothing and would make the check
 * singular), and edge/corner-only contacts bridged (`bridged`). → { solid: Uint8Array per model element, dropped
 * (elements in islands), added, bridged, level (the density of the last element kept), xClean (the field whose 0.5
 * surface wraps exactly the solid elements, densities kept for the surface's shape) }
 */
export function solidDesign(out) {
  const { model, x, passive, grid: g } = out, ne = x.length;
  let total = 0; for (let m = 0; m < ne; m++) total += x[m];
  const order = Array.from({ length: ne }, (_, m) => m).sort((a, b) => (passive[b] - passive[a]) || (x[b] - x[a]));
  const map = new Int32Array(g.nx * g.ny * g.nz).fill(-1);
  model.elems.forEach((e, m) => { map[e] = m; });
  const held = new Uint8Array(model.nn); for (const n of out.consNodes || []) held[n] = 1;
  const anyHeld = !!(out.consNodes && out.consNodes.length);
  // elements that touch only along an edge or at a corner are a hinge to the solver: bridge each such contact
  // with the denser element(s) between them (the iso-surface fills the same places, so mesh and check agree)
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz ? -1 : map[i + g.nx * (j + g.ny * k)]);
  const bridge = (solid) => {
  let bridged = 0;
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (let m = 0; m < ne; m++) {
      if (!solid[m]) continue;
      const e = model.elems[m], i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny));
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const nz = (di !== 0) + (dj !== 0) + (dk !== 0);
        if (nz < 2) continue;
        const q = at(i + di, j + dj, k + dk);
        if (q < 0 || !solid[q]) continue;
        // monotone paths from m to q through face neighbours: one step per nonzero axis
        const axes = [[di, 0, 0], [0, dj, 0], [0, 0, dk]].filter((v) => v[0] || v[1] || v[2]);
        const perms = nz === 2 ? [[0, 1], [1, 0]] : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        let ok = false, best = null, bestV = -1;
        for (const p of perms) {
          const path = []; let c = [i, j, k], valid = true;
          for (let s2 = 0; s2 < p.length - 1; s2++) { const a = axes[p[s2]]; c = [c[0] + a[0], c[1] + a[1], c[2] + a[2]]; const r = at(...c); if (r < 0) { valid = false; break; } path.push(r); }
          if (!valid) continue;
          if (path.every((r) => solid[r])) { ok = true; break; }
          const v = Math.min(...path.map((r) => x[r]));
          if (v > bestV) { bestV = v; best = path; }
        }
        if (!ok && best) { for (const r of best) if (!solid[r]) { solid[r] = 1; bridged++; } changed = true; }
      }
    }
  }
  // and the empty side: in every 2×2×2 block the empty elements must be face-connected too (else the surface
  // pinches to a non-manifold point there) — fill the empty element with the most solid neighbours until they are
  const B8 = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const CE = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const parts = (mask, want) => { const seen = new Uint8Array(8); let n = 0; for (let s0 = 0; s0 < 8; s0++) { if (seen[s0] || ((mask >> s0) & 1) !== want) continue; n++; const st = [s0]; seen[s0] = 1; while (st.length) { const a = st.pop(); for (const [u, v] of CE) { const b = u === a ? v : v === a ? u : -1; if (b >= 0 && !seen[b] && ((mask >> b) & 1) === want) { seen[b] = 1; st.push(b); } } } } return n; };
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (let k = -1; k < g.nz; k++) for (let j = -1; j < g.ny; j++) for (let i = -1; i < g.nx; i++) {
      for (let guard = 0; guard < 8; guard++) {
        const ids = B8.map(([a, b, c]) => at(i + a, j + b, k + c));
        let mask = 0; ids.forEach((q, c) => { if (q >= 0 && solid[q]) mask |= 1 << c; });
        if (mask === 0 || parts(mask, 0) <= 1) break;
        let best = -1, bn = -1;
        ids.forEach((q, c) => { if (q < 0 || solid[q]) return; let cnt = 0; for (const [u, v] of CE) if ((u === c && ((mask >> v) & 1)) || (v === c && ((mask >> u) & 1))) cnt++; if (cnt > bn) { bn = cnt; best = q; } });
        if (best < 0) break;   // the empties outside the domain cannot be filled
        solid[best] = 1; bridged++; changed = true;
      }
    }
  }
  return bridged;
  };
  // face-connected components of the densest n elements, contacts bridged → { solid, comp, keepComp, bridged, allHeld (every passive piece is held) }
  const build = (n) => {
    const solid = new Uint8Array(ne);
    for (let k = 0; k < n; k++) solid[order[k]] = 1;
    const bridged = bridge(solid);
    const comp = new Int32Array(ne).fill(-1), keepComp = [];
    let allHeld = true;
    for (let s0 = 0; s0 < ne; s0++) {
      if (!solid[s0] || comp[s0] >= 0) continue;
      const id = keepComp.length, st = [s0]; comp[s0] = id; let isHeld = false, hasPassive = false;
      while (st.length) {
        const m = st.pop(), e = model.elems[m];
        if (passive[m]) hasPassive = true;
        for (let c = 0; c < 8 && !isHeld; c++) if (held[model.node0[m] + model.off[c]]) isHeld = true;
        const i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny));
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const a = i + di, b = j + dj, cc = k + dk;
          if (a < 0 || b < 0 || cc < 0 || a >= g.nx || b >= g.ny || cc >= g.nz) continue;
          const q = map[a + g.nx * (b + g.ny * cc)];
          if (q >= 0 && solid[q] && comp[q] < 0) { comp[q] = id; st.push(q); }
        }
      }
      keepComp.push(isHeld || !anyHeld);
      if (hasPassive && !isHeld && anyHeld) allHeld = false;
    }
    return { solid, comp, keepComp, allHeld, bridged };
  };
  const n0 = Math.min(ne, Math.max(Math.round(total), passive.reduce((s, v) => s + v, 0)));
  let n = n0, b = build(n);
  if (!b.allHeld) {   // grey designs: add the next densest elements until every kept (loaded) region reaches a support
    let lo = n0, hi = ne;
    const full = build(hi);
    if (full.allHeld) {
      while (hi - lo > Math.max(1, ne * 0.002)) { const mid = (lo + hi) >> 1; if (build(mid).allHeld) hi = mid; else lo = mid; }
      n = hi; b = build(n);
    }
  }
  const { solid, comp, keepComp, bridged } = b;
  const level = n > 0 ? x[order[n - 1]] : 1;
  let dropped = 0;
  const xClean = Float32Array.from(x);
  for (let m = 0; m < ne; m++) if (solid[m] && !keepComp[comp[m]]) { solid[m] = 0; xClean[m] = 0; dropped++; }
  // the surface field: exactly the checked design (1 solid, 0 not)
  for (let m = 0; m < ne; m++) xClean[m] = solid[m] ? 1 : 0;
  return { solid, dropped, level, xClean, added: n - n0, bridged };
}

/**
 * Density field → a closed, manifold, smoothed triangle mesh { positions, indices, volume, iso }. iso: a
 * density level, or 'volume' (default): the level (to ~0.001) whose surface encloses the optimised material
 * volume Σx·h³ — a plain 0.5 surface cuts the corners of members one or two elements thick (≈ 20 % light).
 * binary: x is 0/1 (solidDesign's xClean): each vertex sits at its cell's middle (a grid node), so before smoothing
 * the surface is exactly the solid elements' boundary (a one-element plate keeps its thickness); after the smoothing
 * the vertices move out along their normals until the volume is the elements' again (`inflate`).
 * Surface nets on the element densities (padded with 0 so the surface closes); every cell whose inside or
 * outside corners are not edge-connected (the ambiguous cases that make non-manifold vertices or
 * edges) gets outside corners filled until both are; Taubin λ|μ smoothing (0.5 / −0.53) `smooth` times.
 */
export function isoSurface(model, x, { iso = 'volume', smooth = 12, binary = false } = {}) {
  if (iso === 'volume') {   // the level whose surface holds the optimised volume (Σ densities): bisection
    let target = 0; for (let m = 0; m < x.length; m++) target += x[m];
    target *= model.grid.h ** 3;
    let lo = 0.05, hi = 0.95, best = null;
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2, s = isoSurface(model, x, { iso: mid, smooth });
      best = s;
      if (s.volume > target) lo = mid; else hi = mid;
    }
    best.target = target;
    return best;
  }
  // the field lives at element centres (a dual grid), padded with a layer of 0 each side: a solid element next
  // to an empty one or the outside puts the surface on their shared face, so a full design is the voxel box
  const g = model.grid, NX = g.nx + 2, NY = g.ny + 2, NZ = g.nz + 2;
  const val = new Float64Array(NX * NY * NZ);
  model.elems.forEach((e, m) => { const i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny)); val[(i + 1) + NX * ((j + 1) + NY * (k + 1))] = x[m]; });
  const inside = Uint8Array.from(val, (v) => (v > iso ? 1 : 0));
  const CX = NX - 1, CY = NY - 1, CZ = NZ - 1;
  const cOff = [0, 1, 1 + NX, NX, NX * NY, NX * NY + 1, NX * NY + 1 + NX, NX * NY + NX];
  const CE = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const comps = (mask, want) => {   // number of edge-connected components among corners with inside == want
    const seen = new Uint8Array(8); let n = 0;
    for (let s = 0; s < 8; s++) {
      if (seen[s] || ((mask >> s) & 1) !== want) continue;
      n++; const st = [s]; seen[s] = 1;
      while (st.length) { const a = st.pop(); for (const [u, v] of CE) { const b = u === a ? v : v === a ? u : -1; if (b >= 0 && !seen[b] && ((mask >> b) & 1) === want) { seen[b] = 1; st.push(b); } } }
    }
    return n;
  };
  for (let pass = 0, dirty = true; dirty && pass < 20; pass++) {
    dirty = false;
    for (let k = 0; k < CZ; k++) for (let j = 0; j < CY; j++) for (let i = 0; i < CX; i++) {
      const b = i + NX * (j + NY * k);
      for (let guard = 0; guard < 8; guard++) {
        let mask = 0; for (let c = 0; c < 8; c++) mask |= inside[b + cOff[c]] << c;
        if (mask === 0 || mask === 255 || (comps(mask, 1) <= 1 && comps(mask, 0) <= 1)) break;
        // fill the outside corner with the most inside neighbours (never the padding layer)
        let best = -1, bn = -1;
        for (let c = 0; c < 8; c++) {
          if ((mask >> c) & 1) continue;
          const n = b + cOff[c], ii = n % NX, jj = Math.floor(n / NX) % NY, kk = Math.floor(n / (NX * NY));
          if (ii === 0 || jj === 0 || kk === 0 || ii === NX - 1 || jj === NY - 1 || kk === NZ - 1) continue;
          let cnt = 0; for (const [u, v] of CE) if ((u === c && ((mask >> v) & 1)) || (v === c && ((mask >> u) & 1))) cnt++;
          if (cnt > bn) { bn = cnt; best = c; }
        }
        if (best < 0) break;
        inside[b + cOff[best]] = 1; dirty = true;
      }
    }
  }
  // one vertex per sign-changing cell: mean of its edge crossings (t from the field, kept in (0.1, 0.9) when consistent)
  const vid = new Int32Array(CX * CY * CZ).fill(-1), pos = [];
  const P = (n) => { const ii = n % NX, jj = Math.floor(n / NX) % NY, kk = Math.floor(n / (NX * NY)); return [g.origin[0] + (ii - 0.5) * g.h, g.origin[1] + (jj - 0.5) * g.h, g.origin[2] + (kk - 0.5) * g.h]; };
  for (let k = 0; k < CZ; k++) for (let j = 0; j < CY; j++) for (let i = 0; i < CX; i++) {
    const b = i + NX * (j + NY * k);
    let s = [0, 0, 0], cnt = 0;
    for (const [u, v] of CE) {
      const a = b + cOff[u], c = b + cOff[v];
      if (inside[a] === inside[c]) continue;
      const va = val[a], vc = val[c];
      let t = (va - vc) !== 0 ? (va - iso) / (va - vc) : 0.5;
      if (!(t > 0.1 && t < 0.9)) t = Math.min(0.9, Math.max(0.1, Number.isFinite(t) ? t : 0.5));
      const pa = P(a), pc = P(c);
      s = [s[0] + pa[0] + t * (pc[0] - pa[0]), s[1] + pa[1] + t * (pc[1] - pa[1]), s[2] + pa[2] + t * (pc[2] - pa[2])]; cnt++;
    }
    if (!cnt) continue;
    vid[i + CX * (j + CY * k)] = pos.length / 3;
    if (binary) { const c = P(b); pos.push(c[0] + g.h / 2, c[1] + g.h / 2, c[2] + g.h / 2); }   // the cell's middle = a grid node: the voxels' own boundary before smoothing
    else pos.push(s[0] / cnt, s[1] / cnt, s[2] / cnt);
  }
  // one quad per sign-changing grid edge, from the four cells around it; outward = from inside to outside
  const idx = [];
  const cell = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= CX || j >= CY || k >= CZ ? -1 : vid[i + CX * (j + CY * k)]);
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    const dd = (p, q) => (pos[3 * p] - pos[3 * q]) ** 2 + (pos[3 * p + 1] - pos[3 * q + 1]) ** 2 + (pos[3 * p + 2] - pos[3 * q + 2]) ** 2;
    if (dd(a, c) <= dd(b, d)) idx.push(a, b, c, a, c, d); else idx.push(a, b, d, b, c, d);
  };
  for (let k = 1; k < NZ - 1; k++) for (let j = 1; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {   // x edges
    const n = i + NX * (j + NY * k);
    if (inside[n] !== inside[n + 1]) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !inside[n]);
  }
  for (let k = 1; k < NZ - 1; k++) for (let j = 0; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {   // y edges
    const n = i + NX * (j + NY * k);
    if (inside[n] !== inside[n + NX]) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !inside[n]);
  }
  for (let k = 0; k < NZ - 1; k++) for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {   // z edges
    const n = i + NX * (j + NY * k);
    if (inside[n] !== inside[n + NX * NY]) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !inside[n]);
  }
  const positions = Float64Array.from(pos), indices = Uint32Array.from(idx);
  const v0 = meshVolume(positions, indices);
  taubin(positions, indices, smooth);
  if (binary && smooth) inflate(positions, indices, v0);
  return { positions: Float32Array.from(positions), indices, volume: meshVolume(positions, indices), iso };
}

/** Taubin smoothing (λ 0.5, μ −0.53) over the mesh's edge graph, in place. */
export function taubin(pos, idx, passes) {
  const nv = pos.length / 3, nb = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) for (let c = 0; c < 3; c++) { const a = idx[t + c], b = idx[t + (c + 1) % 3]; nb[a].add(b); nb[b].add(a); }
  const lists = nb.map((s) => Int32Array.from(s)), tmp = new Float64Array(pos.length);
  for (let p = 0; p < passes * 2; p++) {
    const f = p % 2 === 0 ? 0.5 : -0.53;
    for (let v = 0; v < nv; v++) {
      const l = lists[v]; if (!l.length) { tmp[3 * v] = pos[3 * v]; tmp[3 * v + 1] = pos[3 * v + 1]; tmp[3 * v + 2] = pos[3 * v + 2]; continue; }
      let sx = 0, sy = 0, sz = 0; for (const w of l) { sx += pos[3 * w]; sy += pos[3 * w + 1]; sz += pos[3 * w + 2]; }
      tmp[3 * v] = pos[3 * v] + f * (sx / l.length - pos[3 * v]); tmp[3 * v + 1] = pos[3 * v + 1] + f * (sy / l.length - pos[3 * v + 1]); tmp[3 * v + 2] = pos[3 * v + 2] + f * (sz / l.length - pos[3 * v + 2]);
    }
    pos.set(tmp);
  }
}

/** Smoothing thins members one or two elements wide; move every vertex along its normal by one distance so the
 *  volume is v0 again (three Newton steps on d = ΔV / area). */
export function inflate(pos, idx, v0) {
  const nv = pos.length / 3, nrm = new Float64Array(pos.length);
  for (let step = 0; step < 3; step++) {
    nrm.fill(0); let area = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
      const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], w = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      area += Math.hypot(...n) / 2;
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) nrm[v + k] += n[k];
    }
    const d = (v0 - meshVolume(pos, idx)) / area;
    if (!(Math.abs(d) > 1e-12)) break;
    for (let v = 0; v < nv; v++) { const l = Math.hypot(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]) || 1; for (let k = 0; k < 3; k++) pos[3 * v + k] += d * nrm[3 * v + k] / l; }
  }
}

export function meshVolume(P, I) {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/** Closed-mesh check → { closed (every edge in exactly two triangles, opposite ways), edges, bad }. */
export function meshCheck(I) {
  const m = new Map();
  for (let t = 0; t < I.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = I[t + c], b = I[t + (c + 1) % 3], k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    const e = m.get(k) || [0, 0]; e[a < b ? 0 : 1]++; m.set(k, e);
  }
  let bad = 0; for (const [, e] of m) if (e[0] !== 1 || e[1] !== 1) bad++;
  return { closed: bad === 0, edges: m.size, bad };
}

/**
 * The design as solid elements (solidDesign: the densest up to the optimised volume, islands dropped) solved again with the real material (h8i) and the
 * same supports and loads (all cases, worst value kept) → { mass (kg), volume, maxVm, maxDisp, minSafety }.
 */
export function evaluate(job, out, onProgress = () => {}, cancelled = null, design = null) {
  const mat = out.material, rho = tonnesPerMm3(mat.density), g = out.grid;
  const d = design || solidDesign(out), solid = new Uint8Array(g.solid.length);
  out.model.elems.forEach((e, m) => { if (d.solid[m]) solid[e] = 1; });
  const g2 = { ...g, solid };
  const model = FE.makeModel(g2, { E: mat.E, nu: mat.nu, type: 'h8i' });
  const exactArea = job.faces ? job.faces.map((f) => f.area || 0) : null;
  let worst = { maxVm: 0, maxDisp: 0, at: null, compliance: 0 };
  const cases = job.cases || [job.loads || []];
  cases.forEach((loads, ci) => {
    const bc = FE.boundaryConditions(model, job.mesh, { constraints: job.constraints, loads }, { surfaceOnly: out.surfaceOnly, exactArea, density: rho });
    const sol = FE.pcg(model, bc.cons, bc.f, { tol: 1e-8, cancelled, ...FE.preconditioner(model, bc.cons), onProgress: (f, msg) => onProgress((ci + f) / cases.length, t('gen.opt.checking', { msg })) });
    const r = FE.postprocess(model, sol.u, bc.f, bc.cons, { yieldStress: mat.yield });
    if (r.maxVm.value > worst.maxVm) { worst.maxVm = r.maxVm.value; worst.at = r.maxVm.at; }
    worst.maxDisp = Math.max(worst.maxDisp, r.maxDisp.value);
    worst.compliance += r.compliance;
  });
  const volume = model.elems.length * g.h ** 3;
  let grey = 0; for (const v of out.x) if (v > 0.1 && v < 0.9) grey++;
  return { volume, mass: volume * rho * 1000, maxVm: worst.maxVm, maxVmAt: worst.at, maxDisp: worst.maxDisp, compliance: worst.compliance, minSafety: worst.maxVm > 0 ? mat.yield / worst.maxVm : Infinity, elements: model.elems.length, grey: grey / out.x.length };
}

/**
 * Several outcomes: one optimisation per distinct volume fraction (materials sharing it reuse the shape,
 * since the optimum does not depend on E), each evaluated in its material and turned into a mesh.
 * variants [{volfrac, material}] → [{volfrac, material, history, iterations, converged, eval, mesh}]
 */
export function outcomes(job, variants, onProgress = () => {}, cancelled = null) {
  const shapes = new Map(), out = [];
  variants.forEach((v, vi) => {
    const prog = (f, msg) => onProgress((vi + f) / variants.length, t('gen.opt.outcome', { k: vi + 1, n: variants.length, msg }));
    let opt = shapes.get(v.volfrac);
    if (!opt) { opt = optimize({ ...job, volfrac: v.volfrac }, prog, cancelled); opt.design = solidDesign(opt); opt.mesh = isoSurface(opt.model, opt.design.xClean, { iso: 0.5, binary: true }); shapes.set(v.volfrac, opt); }
    const mat = readMaterial(v.material);
    const ev = evaluate({ ...job }, { ...opt, material: mat }, prog, cancelled, opt.design);
    ev.dropped = opt.design.dropped;
    out.push({ volfrac: v.volfrac, material: mat, history: opt.history, finalC: opt.finalC * opt.material.E / mat.E, iterations: opt.iterations, converged: opt.converged, eval: ev, opt, mesh: opt.mesh });
  });
  return out;
}
