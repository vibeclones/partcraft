/* SPDX-License-Identifier: Apache-2.0 */
/**
 * flow.js — laminar, incompressible, isothermal, Newtonian flow on a voxel lattice (DOM-free): the lattice Boltzmann
 * method, D3Q19, two-relaxation-time collision (TRT, Ginzburg's "magic" Λ = 3/16, which puts a bounce-back wall exactly
 * halfway between lattice nodes whatever the viscosity) on a sparse list of fluid cells, pull streaming, link-wise
 * boundaries:
 *   wall      halfway bounce-back, or Bouzidi–Firdaouss–Lallemand (2001) linear interpolated bounce-back from the
 *             true wall distance q along the link (curved walls; falls back to bounce-back when the second node is missing),
 *             with a local mass correction: the mass an interpolated link fails to return (fout − fin) is added to the
 *             node's rest population the same step, so walls neither make nor lose fluid (lattice.massFix = false: off)
 *   velocity  bounce-back of a moving wall (Ladd 1994): f_i = f_ī* + 6 w_i ρ0 (c_i·u_w)  — inlets, far-field inflow
 *   pressure  anti-bounce-back (Ginzburg 2008; Izquierdo & Fueyo 2008): f_i = −f_ī* + 2 w_i ρ_w (1 + 4.5 (c_i·u)² − 1.5 u²),
 *             u the node's velocity — outlets, outflow
 *   slip      specular reflection (free slip) — side faces of an external-flow box
 * Forces on walls: momentum exchange over the wall links (Ladd 1994). Mass through boundaries: the populations crossing
 * each boundary link (exact, discrete). The steady state is reached by time stepping; the residual is the relative
 * change of the velocity field per step, checked every `every` steps.
 * Units inside: lattice (dx = dt = ρ0 = 1, c_s² = 1/3); `scaling` turns physical inputs into lattice ones and back.
 * Limits (said in the UI too): laminar here (turbulence: flow-turb.js, experimental), weakly compressible (density changes kept to a
 * few per cent by the choice of lattice speed), steady results only (a flow that never settles is reported as not converged).
 * Turbulence support (round 5, experimental: flow-turb.js STATUS): makeState(…, { eddy: true }) gives a per-cell eddy
 * viscosity and collideEddy (TRT with ω− ≥ OMEGA_MINUS, trace of Π^neq at BULK_OMEGA, a Smagorinsky stabilizer); a uniform
 * body force for periodic test channels; run(…, { ramp }) starts inflows gently; scaling(…, { turbulent }) budgets
 * turbulent friction. The per-step kernel is split by cell ranges (slab / slabs / stepSlab / endStep, contract at `step`)
 * so a worker pool can run z-slabs in parallel.
 *
 * Fluids (20 °C, 101.325 kPa):
 *  - Air: density from the ideal gas law ρ = p / (R T), R = 287.05 J/(kg·K) → 1.204 kg/m³; viscosity from Sutherland's
 *    law μ = μ0 (T/T0)^1.5 (T0 + S)/(T + S), μ0 1.716e-5 Pa·s, T0 273.15 K, S 110.4 K (F. M. White, Viscous Fluid Flow,
 *    3rd ed., table 1-2) → 1.813e-5 Pa·s (handbook tables give 1.81–1.82e-5).
 *  - Water: IAPWS-95 density 998.21 kg/m³ (Wagner & Pruss 2002) and the IAPWS 2008 viscosity formulation 1.0016 mPa·s
 *    (Huber et al. 2009).
 */

import { t } from './i18n.js';

export const AIR_T = 293.15;
export const sutherlandAir = (T) => 1.716e-5 * (T / 273.15) ** 1.5 * (273.15 + 110.4) / (T + 110.4);
export const FLUIDS = [
  { id: 'air', get name() { return t('study.flow.fluid.air'); }, density: +(101325 / (287.05 * AIR_T)).toFixed(4), viscosity: +sutherlandAir(AIR_T).toPrecision(4) },
  { id: 'water', get name() { return t('study.flow.fluid.water'); }, density: 998.21, viscosity: 1.0016e-3 },
];
export const fluidById = (id) => FLUIDS.find((f) => f.id === id) || null;

// D3Q19: rest, 6 faces, 12 edges; i odd ↔ i + 1 opposite
export const CX = Int8Array.from([0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
export const CY = Int8Array.from([0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1]);
export const CZ = Int8Array.from([0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1]);
export const W = Float64Array.from([1 / 3, ...Array(6).fill(1 / 18), ...Array(12).fill(1 / 36)]);
export const OPP = Int8Array.from(Array.from({ length: 19 }, (_, i) => (i === 0 ? 0 : i % 2 ? i + 1 : i - 1)));
export const Q = 19;
export const MAGIC = 3 / 16;

const K_WALL = 1, K_BOUZIDI = 2, K_VEL = 3, K_PRES = 4, K_SLIP = 5;

/**
 * A lattice from a cell classification.
 * dom = { nx, ny, nz, kind: Int32Array(nx·ny·nz): −1 solid/outside, 0 fluid, g ≥ 1 a boundary cell of group g,
 *         periodic: [bx, by, bz], groups: [null, {type 'wall'|'velocity'|'pressure'|'slip', u?:[3], rho?, axis?, force?}] (index ≥ 1),
 *         wallGroup(cell, i) → {g, q, d?, n?} | null : what a link from fluid cell `cell` along direction i (towards a solid cell)
 *         hits: a group (≥ 1, e.g. an inlet drawn on a capped face) and the wall distance q in (0, 1] used by the link (null =
 *         plain wall, q ½); d, n: the true distance fraction and surface normal (into the solid) for the turbulence wall model,
 *         profile(g, x, y, z) → [ux, uy, uz] | null : a velocity group's value at a boundary cell (tests: parabolic inflow) }
 * Wall group 0 is the part (counted for forces). Returns the lattice (arrays) — solve with `run`.
 */
export function buildLattice(dom) {
  const { nx, ny, nz, kind } = dom, per = dom.periodic || [false, false, false], groups = dom.groups || [null];
  const ncell = nx * ny * nz;
  const index = new Int32Array(ncell).fill(-1);
  let nf = 0;
  for (let c = 0; c < ncell; c++) if (kind[c] === 0) index[c] = nf++;
  if (!nf) throw new Error(t('study.flow.err.no_fluid_space'));
  const cells = new Int32Array(nf);
  for (let c = 0; c < ncell; c++) if (index[c] >= 0) cells[index[c]] = c;
  const nbo = new Int32Array(nf * Q);
  const bulk = new Uint8Array(nf);
  const L = { kind: [], cell: [], dir: [], a: [], src: [], g: [], force: [], wd: [], wn: [] };
  const wrap = (v, n, p) => (v >= 0 && v < n ? v : p ? (v + n) % n : -1);
  const cellAt = (i, j, k) => (i < 0 || j < 0 || k < 0 ? -1 : i + nx * (j + ny * k));
  for (let n = 0; n < nf; n++) {
    const c = cells[n], i0 = c % nx, j0 = ((c - i0) / nx) % ny, k0 = (c - i0 - nx * j0) / (nx * ny);
    let isBulk = 1;
    nbo[n * Q] = n * Q;
    for (let q = 1; q < Q; q++) {
      // pull: the population moving along c_q arrives from x − c_q
      const si = wrap(i0 - CX[q], nx, per[0]), sj = wrap(j0 - CY[q], ny, per[1]), sk = wrap(k0 - CZ[q], nz, per[2]);
      const sc = cellAt(si, sj, sk), sn = sc >= 0 ? index[sc] : -1;
      if (sn >= 0) { nbo[n * Q + q] = sn * Q + q; continue; }
      isBulk = 0;
      const sg = sc >= 0 ? kind[sc] : -1, oq = OPP[q];
      let lk = K_WALL, a = 0.5, src = -1, g = 0, force = 1, wd = NaN, wn = null;
      if (sg >= 1) {
        g = sg; const G = groups[g];
        if (!G) throw new Error('A boundary cell names no group.');   // i18n-ignore: internal check, never reaches a person
        if (G.type === 'velocity') {
          const u = (dom.profile && dom.profile(g, i0 - CX[q], j0 - CY[q], k0 - CZ[q])) || G.u;
          lk = K_VEL; a = 6 * W[q] * (CX[q] * u[0] + CY[q] * u[1] + CZ[q] * u[2]); force = 0;
        } else if (G.type === 'pressure') { lk = K_PRES; a = G.rho; force = 0; }
        else if (G.type === 'slip') {
          lk = K_SLIP; force = 0;
          // specular: the population arriving along c_q left x − (tangential part of c_q) along c_q mirrored in the normal axis
          const ax = G.axis, t = [CX[q], CY[q], CZ[q]], m = t.slice(); t[ax] = 0; m[ax] = -m[ax];
          const mi = findDir(m[0], m[1], m[2]);
          const xi = wrap(i0 - t[0], nx, per[0]), xj = wrap(j0 - t[1], ny, per[1]), xk = wrap(k0 - t[2], nz, per[2]);
          const xc = cellAt(xi, xj, xk), xn = xc >= 0 ? index[xc] : -1;
          src = xn >= 0 && mi >= 0 ? xn * Q + mi : -1;
        } else { lk = K_WALL; force = G.force ? 1 : 0; }
      } else {
        // a solid (or outside) cell: the outgoing population ō = OPP[q] travels x → x + c_ō = x − c_q and hits a wall there
        const wg = sc >= 0 && dom.wallGroup ? dom.wallGroup(c, oq) : null;
        if (sc < 0) force = 0;   // off the grid (tests' channel walls): a wall, not the part
        if (wg) { wd = wg.d ?? wg.q ?? NaN; wn = wg.n || null; }
        if (wg && wg.g >= 1) {
          g = wg.g; const G = groups[g];
          if (G.type === 'velocity') { lk = K_VEL; a = 6 * W[q] * (CX[q] * G.u[0] + CY[q] * G.u[1] + CZ[q] * G.u[2]); force = 0; }
          else if (G.type === 'pressure') { lk = K_PRES; a = G.rho; force = 0; }
          else { lk = K_WALL; force = G.force ? 1 : 0; }
        } else if (wg && wg.q !== undefined && Math.abs(wg.q - 0.5) > 1e-6) {
          lk = K_BOUZIDI; a = Math.min(1, Math.max(1e-3, wg.q));
          // the second fluid node behind x (x + c_q) for q < ½
          const fi = wrap(i0 + CX[q], nx, per[0]), fj = wrap(j0 + CY[q], ny, per[1]), fk = wrap(k0 + CZ[q], nz, per[2]);
          const fc = cellAt(fi, fj, fk), fn = fc >= 0 ? index[fc] : -1;
          src = fn >= 0 ? fn * Q + oq : -1;
          if (a < 0.5 && src < 0) { lk = K_WALL; a = 0.5; }
        }
      }
      nbo[n * Q + q] = nf * Q + L.kind.length;
      L.kind.push(lk); L.cell.push(n); L.dir.push(q); L.a.push(a); L.src.push(src); L.g.push(g); L.force.push(force);
      L.wd.push(wd); L.wn.push(...(wn || [NaN, NaN, NaN]));
    }
    bulk[n] = isBulk;
  }
  const links = { kind: Uint8Array.from(L.kind), cell: Int32Array.from(L.cell), dir: Uint8Array.from(L.dir), a: Float64Array.from(L.a), src: Int32Array.from(L.src), g: Int32Array.from(L.g), force: Uint8Array.from(L.force), n: L.kind.length,
    wd: Float64Array.from(L.wd), wn: Float32Array.from(L.wn) };   // wall links: true distance fraction and surface normal (NaN: not known)
  return { nx, ny, nz, nf, cells, index, nbo, bulk, links, groups, ncell, periodic: per.slice() };
}

function findDir(x, y, z) { for (let q = 0; q < Q; q++) if (CX[q] === x && CY[q] === y && CZ[q] === z) return q; return -1; }

/** The population arriving at a boundary link's node, from the post-collision populations `src` (and the node velocity). */
function incoming(lat, k, src, ux, uy, uz) {
  const L = lat.links, n = L.cell[k], q = L.dir[k], b = n * Q, o = OPP[q];
  switch (L.kind[k]) {
    case K_WALL: return src[b + o];
    case K_BOUZIDI: {
      const qq = L.a[k], fo = src[b + o];
      if (qq < 0.5) return 2 * qq * fo + (1 - 2 * qq) * src[L.src[k]];
      return (fo + (2 * qq - 1) * src[b + q]) / (2 * qq);
    }
    case K_VEL: return src[b + o] + L.a[k];
    case K_PRES: {
      const u0 = ux[n], u1 = uy[n], u2 = uz[n], cu = CX[q] * u0 + CY[q] * u1 + CZ[q] * u2;
      return -src[b + o] + 2 * W[q] * L.a[k] * (1 + 4.5 * cu * cu - 1.5 * (u0 * u0 + u1 * u1 + u2 * u2));
    }
    case K_SLIP: return L.src[k] >= 0 ? src[L.src[k]] : src[b + o];
  }
  return src[b + o];
}

/**
 * A solver state on a lattice: tau (symmetric relaxation time, ν = (τ − ½)/3), initial velocity u0 (lattice).
 * Options for turbulence (flow-turb.js) and tests: eddy: true gives the state a per-cell eddy viscosity `nut` (lattice,
 * Float64Array(nf), 0 at first) and the eddy collision (collideEddy); with it every wall link joins the local mass
 * correction (wall-model slip terms must pass no mass). smagorinsky: the stabilizer's constant (eddy only, 0 = off).
 * force: [fx, fy, fz] a uniform body force per unit volume (lattice; added as (1 − ω−/2)·3 w_i c_i·F after collision,
 * velocity u = (Σ c f + F/2)/ρ) — periodic test channels.
 */
export function makeState(lat, { tau, u0 = [0, 0, 0], magic = MAGIC, eddy = false, force = null, smagorinsky = 0 }) {
  if (!(tau > 0.5)) throw new Error('The relaxation time must be above one half.');   // i18n-ignore: caller error (scaling() refuses first)
  const nf = lat.nf, A = new Float64Array(nf * Q + lat.links.n), B = new Float64Array(nf * Q + lat.links.n);
  const ux = new Float64Array(nf).fill(u0[0]), uy = new Float64Array(nf).fill(u0[1]), uz = new Float64Array(nf).fill(u0[2]), rho = new Float64Array(nf).fill(1);
  const usq = u0[0] ** 2 + u0[1] ** 2 + u0[2] ** 2;
  for (let n = 0; n < nf; n++) for (let q = 0; q < Q; q++) { const cu = CX[q] * u0[0] + CY[q] * u0[1] + CZ[q] * u0[2]; A[n * Q + q] = W[q] * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * usq); }
  const tm = 0.5 + magic / (tau - 0.5);
  const S = { lat, src: A, dst: B, ux, uy, uz, rho, tau, tauMinus: tm, wp: 1 / tau, wm: 1 / tm, magic, step: 0, smagorinsky, omegaMinus: OMEGA_MINUS, nueff: null, wallSlot: null, wallStress: null, nut: eddy ? new Float64Array(nf) : null, force: force && force.some((v) => v) ? Float64Array.from(force) : null, turb: null, ...linearLinks(lat, eddy) };
  S.whole = slab(S, 0, nf);
  return S;
}

/** Every boundary link but the pressure ones as f = c1·src[o1] + c2·src[o2] + a (bounce-back, Bouzidi, slip, moving wall), for a tight loop. */
function linearLinks(lat, allWalls = false) {
  const L = lat.links, k = [], o1 = [], o2 = [], c1 = [], c2 = [], a = [], prs = [];
  for (let i = 0; i < L.n; i++) {
    const b = L.cell[i] * Q, q = L.dir[i], own = b + OPP[q];
    switch (L.kind[i]) {
      case K_PRES: prs.push(i); continue;
      case K_BOUZIDI: {
        const qq = L.a[i];
        if (qq < 0.5) { k.push(i); o1.push(own); o2.push(L.src[i]); c1.push(2 * qq); c2.push(1 - 2 * qq); a.push(0); }
        else { k.push(i); o1.push(own); o2.push(b + q); c1.push(1 / (2 * qq)); c2.push((2 * qq - 1) / (2 * qq)); a.push(0); }
        continue;
      }
      case K_VEL: k.push(i); o1.push(own); o2.push(own); c1.push(1); c2.push(0); a.push(L.a[i]); continue;
      case K_SLIP: k.push(i); o1.push(L.src[i] >= 0 ? L.src[i] : own); o2.push(own); c1.push(1); c2.push(0); a.push(0); continue;
      default: k.push(i); o1.push(own); o2.push(own); c1.push(1); c2.push(0); a.push(0);
    }
  }
  const bz = { k: [], cell: [], own: [] };
  if (lat.massFix !== false) for (let i = 0; i < L.n; i++) if (L.kind[i] === K_BOUZIDI || (allWalls && L.kind[i] === K_WALL)) { bz.k.push(i); bz.cell.push(L.cell[i]); bz.own.push(L.cell[i] * Q + OPP[L.dir[i]]); }
  return { bz: { k: Int32Array.from(bz.k), cell: Int32Array.from(bz.cell), own: Int32Array.from(bz.own) }, corr: new Float64Array(lat.nf), lin: { k: Int32Array.from(k), cell: Int32Array.from(k, (i) => L.cell[i]), o1: Int32Array.from(o1), o2: Int32Array.from(o2), c1: Float64Array.from(c1), c2: Float64Array.from(c2), a: Float64Array.from(a) }, prs: Int32Array.from(prs), prsCell: Int32Array.from(prs, (i) => L.cell[i]) };
}

const lowerBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
/**
 * A slab of the cell list for the per-step kernel: cells [n0, n1) and the ranges of the boundary-link lists that belong
 * to them (links are made in cell order, so each list is sorted by cell). Cells are ordered i + nx(j + ny·k), so a range of
 * cells is a z-slab (plus partial rows at its ends). `slabs(S, parts)` cuts the cells into `parts` slabs of equal count.
 */
export function slab(S, n0, n1) {
  return { n0, n1, l0: lowerBound(S.lin.cell, n0), l1: lowerBound(S.lin.cell, n1), b0: lowerBound(S.bz.cell, n0), b1: lowerBound(S.bz.cell, n1), p0: lowerBound(S.prsCell, n0), p1: lowerBound(S.prsCell, n1) };
}
export function slabs(S, parts) {
  const nf = S.lat.nf, out = [];
  for (let p = 0; p < parts; p++) out.push(slab(S, Math.floor(nf * p / parts), Math.floor(nf * (p + 1) / parts)));
  return out;
}

/**
 * One time step: `stepSlab` over every cell, then (with turbulence) the model's update, then the swap.
 * PARALLEL CONTRACT (for a worker split): within one step, `stepSlab(S, sl)` for disjoint slabs may run at the same time
 * (each reads `src` anywhere, writes only its own cells' `dst`, ghost slots, rho/u, corr, nueff and wall stresses); then —
 * after a barrier — `S.turb.updateSlab(S, sl)` for the same slabs (reads u, nueff, wall stresses and the old ν̃ anywhere,
 * writes its own cells' new ν̃, ν_t and their wall links' slip terms); then — after a barrier — `endStep(S)` once.
 */
export function step(S) {
  if (S.par) return S.par(S);   // flow-par.js: the same slabs on the solver threads (bit-identical)
  stepSlab(S, S.whole);
  if (S.turb) S.turb.updateSlab(S, S.whole);
  endStep(S);
}
export function endStep(S) {
  if (S.turb) S.turb.swap(S);
  const t = S.src; S.src = S.dst; S.dst = t; S.step++;
}

/**
 * The kernel on one slab. The boundary links' arriving populations are computed first into ghost slots after the cells'
 * (src[nf·19 + k]), which only the link's own cell reads (its `nbo` entry points there) — so the cell loop has no
 * branches: pull, collide (TRT; collideEddy with an eddy viscosity), store.
 */
export function stepSlab(S, sl) {
  const { lat, src, dst, ux, uy, uz, rho, wp, wm, nut, force } = S, { nbo, nf } = lat, G = nf * Q;
  const P = S.lin, PK = P.k, O1 = P.o1, O2 = P.o2, C1 = P.c1, C2 = P.c2, PA = P.a, PR = S.prs;
  for (let m = sl.l0; m < sl.l1; m++) src[G + PK[m]] = C1[m] * src[O1[m]] + C2[m] * src[O2[m]] + PA[m];
  // interpolated walls: each link's mass defect (what left minus what came back) goes back into the node's rest population
  const BZ = S.bz, corr = S.corr;
  if (BZ.k.length) { corr.fill(0, sl.n0, sl.n1); for (let m = sl.b0; m < sl.b1; m++) corr[BZ.cell[m]] += src[BZ.own[m]] - src[G + BZ.k[m]]; }
  for (let m = sl.p0; m < sl.p1; m++) { const k = PR[m]; src[G + k] = incoming(lat, k, src, ux, uy, uz); }
  if (nut) { collideEddy(S, sl); return; }
  const Fx = force ? force[0] : 0, Fy = force ? force[1] : 0, Fz = force ? force[2] : 0;
  let f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, ep, em, sp, sm, w;
  for (let n = sl.n0; n < sl.n1; n++) {
    const b = n * Q;
    f0 = src[b] + corr[n];
    f1 = src[nbo[b + 1]];
    f2 = src[nbo[b + 2]];
    f3 = src[nbo[b + 3]];
    f4 = src[nbo[b + 4]];
    f5 = src[nbo[b + 5]];
    f6 = src[nbo[b + 6]];
    f7 = src[nbo[b + 7]];
    f8 = src[nbo[b + 8]];
    f9 = src[nbo[b + 9]];
    f10 = src[nbo[b + 10]];
    f11 = src[nbo[b + 11]];
    f12 = src[nbo[b + 12]];
    f13 = src[nbo[b + 13]];
    f14 = src[nbo[b + 14]];
    f15 = src[nbo[b + 15]];
    f16 = src[nbo[b + 16]];
    f17 = src[nbo[b + 17]];
    f18 = src[nbo[b + 18]];
    const r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18;
    const ir = 1 / r;
    const u0 = (f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14 + 0.5 * Fx) * ir;
    const u1 = (f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18 + 0.5 * Fy) * ir;
    const u2 = (f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18 + 0.5 * Fz) * ir;
    rho[n] = r; ux[n] = u0; uy[n] = u1; uz[n] = u2;
    const us = 1.5 * (u0 * u0 + u1 * u1 + u2 * u2);
    dst[b] = f0 - wp * (f0 - r * (1 / 3) * (1 - us));
    // TRT on the 9 pairs (a, a+1): symmetric part relaxed with ω+, antisymmetric with ω−
    w = r / 18;
    ep = w * (1 + 4.5 * (u0) * (u0) - us); em = w * 3 * (u0);
    sp = wp * (0.5 * (f1 + f2) - ep); sm = wm * (0.5 * (f1 - f2) - em);
    dst[b + 1] = f1 - sp - sm; dst[b + 2] = f2 - sp + sm;
    ep = w * (1 + 4.5 * (u1) * (u1) - us); em = w * 3 * (u1);
    sp = wp * (0.5 * (f3 + f4) - ep); sm = wm * (0.5 * (f3 - f4) - em);
    dst[b + 3] = f3 - sp - sm; dst[b + 4] = f4 - sp + sm;
    ep = w * (1 + 4.5 * (u2) * (u2) - us); em = w * 3 * (u2);
    sp = wp * (0.5 * (f5 + f6) - ep); sm = wm * (0.5 * (f5 - f6) - em);
    dst[b + 5] = f5 - sp - sm; dst[b + 6] = f6 - sp + sm;
    w = r / 36;
    ep = w * (1 + 4.5 * (u0 + u1) * (u0 + u1) - us); em = w * 3 * (u0 + u1);
    sp = wp * (0.5 * (f7 + f8) - ep); sm = wm * (0.5 * (f7 - f8) - em);
    dst[b + 7] = f7 - sp - sm; dst[b + 8] = f8 - sp + sm;
    ep = w * (1 + 4.5 * (u0 - u1) * (u0 - u1) - us); em = w * 3 * (u0 - u1);
    sp = wp * (0.5 * (f9 + f10) - ep); sm = wm * (0.5 * (f9 - f10) - em);
    dst[b + 9] = f9 - sp - sm; dst[b + 10] = f10 - sp + sm;
    ep = w * (1 + 4.5 * (u0 + u2) * (u0 + u2) - us); em = w * 3 * (u0 + u2);
    sp = wp * (0.5 * (f11 + f12) - ep); sm = wm * (0.5 * (f11 - f12) - em);
    dst[b + 11] = f11 - sp - sm; dst[b + 12] = f12 - sp + sm;
    ep = w * (1 + 4.5 * (u0 - u2) * (u0 - u2) - us); em = w * 3 * (u0 - u2);
    sp = wp * (0.5 * (f13 + f14) - ep); sm = wm * (0.5 * (f13 - f14) - em);
    dst[b + 13] = f13 - sp - sm; dst[b + 14] = f14 - sp + sm;
    ep = w * (1 + 4.5 * (u1 + u2) * (u1 + u2) - us); em = w * 3 * (u1 + u2);
    sp = wp * (0.5 * (f15 + f16) - ep); sm = wm * (0.5 * (f15 - f16) - em);
    dst[b + 15] = f15 - sp - sm; dst[b + 16] = f16 - sp + sm;
    ep = w * (1 + 4.5 * (u1 - u2) * (u1 - u2) - us); em = w * 3 * (u1 - u2);
    sp = wp * (0.5 * (f17 + f18) - ep); sm = wm * (0.5 * (f17 - f18) - em);
    dst[b + 17] = f17 - sp - sm; dst[b + 18] = f18 - sp + sm;
  }
  // body force on the antisymmetric part, (1 − ω−/2)·3 w c·F (Guo et al. 2002 in TRT form; consistent with the F/2 velocity shift)
  if (force) for (let n = sl.n0; n < sl.n1; n++) for (let q = 1; q < Q; q += 2) { const g = (1 - 0.5 * wm) * 3 * W[q] * (CX[q] * Fx + CY[q] * Fy + CZ[q] * Fz); dst[n * Q + q] += g; dst[n * Q + q + 1] -= g; }
}

export const BULK_OMEGA = 1, OMEGA_MINUS = 1.8;
/**
 * The collision with a per-cell eddy viscosity (turbulent runs): TRT, τ+ = ½ + 3(ν + ν_t) per cell, τ− from the magic
 * Λ = 3/16 but with ω− ≥ OMEGA_MINUS, plus a STABILIZER: τ+ = max(τ+, τ_s), τ_s the Smagorinsky relaxation time of the
 * resolved strain read from the non-equilibrium stress Π^neq (Hou et al. 1996 with ν → 0: τ_s = ¼ + √(1/16 + (9/2)√2
 * C²|Π^neq|/ρ), C = S.smagorinsky). In an equilibrium boundary layer the model's ν_t = κu_τy exceeds C²|S| = C²u_τ/(κy)
 * wherever y > C/κ cells (0.41 cells at C 0.17), so it does not act on a wall-function profile, nor in a free stream; it
 * acts where the grid sees gradients the turbulence model does not cover (sharp inlet corners, start-up transients),
 * which a lattice with the molecular τ at ½ cannot survive otherwise. The bulk (trace) part of Π^neq relaxes at
 * BULK_OMEGA. S.nueff (if present) receives the viscosity used, ν_eff − ν; for cells with S.wallSlot[n] = w ≥ 0,
 * S.wallStress[6w…] receives the viscous stress −(1 − ω+/2)Π^neq (xx yy zz xy xz yz) for the wall model.
 */
function collideEddy(S, sl) {
  const { lat, src, dst, ux, uy, uz, rho, nut, force } = S, nbo = lat.nbo, nu0 = (S.tau - 0.5) / 3, corr = S.corr, mg = S.magic;
  const cs2 = 4.5 * Math.SQRT2 * S.smagorinsky ** 2, nue = S.nueff, wmMin = S.omegaMinus, wsl = S.wallSlot, wst = S.wallStress;
  const Fx = force ? force[0] : 0, Fy = force ? force[1] : 0, Fz = force ? force[2] : 0;
  for (let n = sl.n0; n < sl.n1; n++) {
    const b = n * Q;
    const f0 = src[b] + corr[n];
    const f1 = src[nbo[b + 1]];
    const f2 = src[nbo[b + 2]];
    const f3 = src[nbo[b + 3]];
    const f4 = src[nbo[b + 4]];
    const f5 = src[nbo[b + 5]];
    const f6 = src[nbo[b + 6]];
    const f7 = src[nbo[b + 7]];
    const f8 = src[nbo[b + 8]];
    const f9 = src[nbo[b + 9]];
    const f10 = src[nbo[b + 10]];
    const f11 = src[nbo[b + 11]];
    const f12 = src[nbo[b + 12]];
    const f13 = src[nbo[b + 13]];
    const f14 = src[nbo[b + 14]];
    const f15 = src[nbo[b + 15]];
    const f16 = src[nbo[b + 16]];
    const f17 = src[nbo[b + 17]];
    const f18 = src[nbo[b + 18]];
    const r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18, ir = 1 / r;
    const u0 = (f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14 + 0.5 * Fx) * ir;
    const u1 = (f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18 + 0.5 * Fy) * ir;
    const u2 = (f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18 + 0.5 * Fz) * ir;
    rho[n] = r; ux[n] = u0; uy[n] = u1; uz[n] = u2;
    const us = 1.5 * (u0 * u0 + u1 * u1 + u2 * u2), w1 = r / 18, w2 = r / 36;
    const c0 = u0, e0 = w1 * (1 + 4.5 * c0 * c0 - us), d0 = f1 + f2 - 2 * e0;
    const c1 = u1, e1 = w1 * (1 + 4.5 * c1 * c1 - us), d1 = f3 + f4 - 2 * e1;
    const c2 = u2, e2 = w1 * (1 + 4.5 * c2 * c2 - us), d2 = f5 + f6 - 2 * e2;
    const c3 = u0 + u1, e3 = w2 * (1 + 4.5 * c3 * c3 - us), d3 = f7 + f8 - 2 * e3;
    const c4 = u0 - u1, e4 = w2 * (1 + 4.5 * c4 * c4 - us), d4 = f9 + f10 - 2 * e4;
    const c5 = u0 + u2, e5 = w2 * (1 + 4.5 * c5 * c5 - us), d5 = f11 + f12 - 2 * e5;
    const c6 = u0 - u2, e6 = w2 * (1 + 4.5 * c6 * c6 - us), d6 = f13 + f14 - 2 * e6;
    const c7 = u1 + u2, e7 = w2 * (1 + 4.5 * c7 * c7 - us), d7 = f15 + f16 - 2 * e7;
    const c8 = u1 - u2, e8 = w2 * (1 + 4.5 * c8 * c8 - us), d8 = f17 + f18 - 2 * e8;
    const pxx = d0 + d3 + d4 + d5 + d6, pyy = d1 + d3 + d4 + d7 + d8, pzz = d2 + d5 + d6 + d7 + d8;
    const pxy = d3 - d4, pxz = d5 - d6, pyz = d7 - d8;
    let t = 0.5 + 3 * (nu0 + nut[n]);
    if (cs2) { const ts = 0.25 + Math.sqrt(0.0625 + cs2 * Math.sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)) * ir); if (ts > t) t = ts; }
    if (nue) nue[n] = (t - 0.5) / 3 - nu0;
    // ω− = max(OMEGA_MINUS, magic): at the small τ+ of turbulent runs the magic Λ would leave the odd moments all but
    // unrelaxed (ω− → 0), which staircase walls and corners cannot survive
    const wp = 1 / t, tm = t - 0.5, wm = Math.max(wmMin, tm / (0.5 * tm + mg));
    if (wsl) { const w = wsl[n]; if (w >= 0) { const k = -(1 - 0.5 * wp), o = 6 * w; wst[o] = k * pxx; wst[o + 1] = k * pyy; wst[o + 2] = k * pzz; wst[o + 3] = k * pxy; wst[o + 4] = k * pxz; wst[o + 5] = k * pyz; } }
    // bulk (trace) part of Π^neq relaxed at ω_b instead of ω+: Δf_i = −(ω_b − ω+)·(9/2) w_i (|c_i|² − 1) tr Π/3 changes
    // the trace only (mass, momentum and the deviatoric stress are untouched) — damps the sound waves a lattice at τ ≈ ½
    // would otherwise keep ringing between inlets and outlets
    const tb = (BULK_OMEGA - wp) * 1.5 * (pxx + pyy + pzz), te = tb / 36;
    dst[b] = f0 - wp * (f0 - r * (1 / 3) * (1 - us)) + tb / 3;
    const kf = force ? (1 - 0.5 * wm) * 3 : 0;
    { const sp = wp * (0.5 * (f1 + f2) - e0), sm = wm * (0.5 * (f1 - f2) - w1 * 3 * c0), g = kf * (Fx) * 1 / 18;
      dst[b + 1] = f1 - sp - sm + g; dst[b + 2] = f2 - sp + sm - g; }
    { const sp = wp * (0.5 * (f3 + f4) - e1), sm = wm * (0.5 * (f3 - f4) - w1 * 3 * c1), g = kf * (Fy) * 1 / 18;
      dst[b + 3] = f3 - sp - sm + g; dst[b + 4] = f4 - sp + sm - g; }
    { const sp = wp * (0.5 * (f5 + f6) - e2), sm = wm * (0.5 * (f5 - f6) - w1 * 3 * c2), g = kf * (Fz) * 1 / 18;
      dst[b + 5] = f5 - sp - sm + g; dst[b + 6] = f6 - sp + sm - g; }
    { const sp = wp * (0.5 * (f7 + f8) - e3), sm = wm * (0.5 * (f7 - f8) - w2 * 3 * c3), g = kf * (Fx + Fy) * 1 / 36;
      dst[b + 7] = f7 - sp - sm + g - te; dst[b + 8] = f8 - sp + sm - g - te; }
    { const sp = wp * (0.5 * (f9 + f10) - e4), sm = wm * (0.5 * (f9 - f10) - w2 * 3 * c4), g = kf * (Fx - Fy) * 1 / 36;
      dst[b + 9] = f9 - sp - sm + g - te; dst[b + 10] = f10 - sp + sm - g - te; }
    { const sp = wp * (0.5 * (f11 + f12) - e5), sm = wm * (0.5 * (f11 - f12) - w2 * 3 * c5), g = kf * (Fx + Fz) * 1 / 36;
      dst[b + 11] = f11 - sp - sm + g - te; dst[b + 12] = f12 - sp + sm - g - te; }
    { const sp = wp * (0.5 * (f13 + f14) - e6), sm = wm * (0.5 * (f13 - f14) - w2 * 3 * c6), g = kf * (Fx - Fz) * 1 / 36;
      dst[b + 13] = f13 - sp - sm + g - te; dst[b + 14] = f14 - sp + sm - g - te; }
    { const sp = wp * (0.5 * (f15 + f16) - e7), sm = wm * (0.5 * (f15 - f16) - w2 * 3 * c7), g = kf * (Fy + Fz) * 1 / 36;
      dst[b + 15] = f15 - sp - sm + g - te; dst[b + 16] = f16 - sp + sm - g - te; }
    { const sp = wp * (0.5 * (f17 + f18) - e8), sm = wm * (0.5 * (f17 - f18) - w2 * 3 * c8), g = kf * (Fy - Fz) * 1 / 36;
      dst[b + 17] = f17 - sp - sm + g - te; dst[b + 18] = f18 - sp + sm - g - te; }
  }
}

/**
 * Boundary bookkeeping from the current post-collision populations: per group the net mass rate into the fluid
 * (lattice units, + = in), the number of links, and the force on wall links counted for forces (momentum exchange).
 */
export function boundaryStats(S) {
  const { lat, src, ux, uy, uz } = S, L = lat.links, ng = lat.groups.length;
  const mass = new Float64Array(ng), links = new Int32Array(ng), force = [0, 0, 0];
  for (let k = 0; k < L.n; k++) {
    const n = L.cell[k], q = L.dir[k], o = OPP[q], fin = incoming(lat, k, src, ux, uy, uz), fout = src[n * Q + o];
    mass[L.g[k]] += L.kind[k] === K_BOUZIDI && lat.massFix !== false ? 0 : fin - fout; links[L.g[k]]++;
    if (L.force[k]) { const s = fin + fout; force[0] -= CX[q] * s; force[1] -= CY[q] * s; force[2] -= CZ[q] * s; }
  }
  return { mass, links, force };
}

/**
 * Time-step to a steady state. opts: { maxSteps, tol (relative velocity change per step), every (check interval),
 * minSteps, onCheck({step, res}) → true to stop early (cancel), accept() → false to keep going although res < tol,
 * ramp (steps over which inflow speeds rise from 0) }.
 * Returns { steps, converged, res, history: [{step, res}], blewUp }.
 */
export function run(S, { maxSteps = 20000, tol = 1e-7, every = 100, minSteps = 0, onCheck = null, accept = null, ramp = 0 } = {}) {
  const nf = S.lat.nf, prev = new Float64Array(nf * 3), hist = [];
  let res = Infinity, converged = false;
  const snap = () => { for (let n = 0; n < nf; n++) { prev[3 * n] = S.ux[n]; prev[3 * n + 1] = S.uy[n]; prev[3 * n + 2] = S.uz[n]; } };
  // ramp: the inflow links' speeds rise smoothly (½ − ½cos) over `ramp` steps — a gentle start for runs near τ = ½
  let rl = null, ra = null;
  if (ramp > 0) { const L = S.lat.links, ids = []; for (let m = 0; m < S.lin.k.length; m++) if (L.kind[S.lin.k[m]] === K_VEL) ids.push(m); rl = Int32Array.from(ids); ra = Float64Array.from(ids, (m) => S.lin.a[m]); }
  const stepR = () => {
    if (rl && S.step <= ramp) { const f = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, S.step / ramp)); for (let i = 0; i < rl.length; i++) S.lin.a[rl[i]] = f * ra[i]; }
    step(S);
  };
  stepR(); snap();
  while (S.step < maxSteps) {
    const k = Math.min(every, maxSteps - S.step);
    for (let s = 0; s < k; s++) stepR();
    let d = 0, m = 0;
    for (let n = 0; n < nf; n++) {
      const a = S.ux[n], b = S.uy[n], c = S.uz[n];
      d += (a - prev[3 * n]) ** 2 + (b - prev[3 * n + 1]) ** 2 + (c - prev[3 * n + 2]) ** 2; m += a * a + b * b + c * c;
    }
    if (!Number.isFinite(d) || !Number.isFinite(m)) return { steps: S.step, converged: false, res: NaN, history: hist, blewUp: true };
    res = m > 0 ? Math.sqrt(d / m) / k : (d > 0 ? Infinity : 0);
    hist.push({ step: S.step, res });
    snap();
    if (onCheck && onCheck({ step: S.step, res })) break;
    if (S.step >= minSteps && res < tol && (!accept || accept())) { converged = true; break; }
  }
  return { steps: S.step, converged, res, history: hist, blewUp: false };
}

// ------------------------------------------------------------------------------------------- units

/**
 * Lattice parameters from physical ones. dx (m), U (m/s, the reference speed: inlet or free stream), nu (m²/s),
 * Lc / Dc (flow path length and the narrowest width, in cells: they bound the density change), opts {uMax 0.05, nuMax 0.5, drho 0.03}.
 * → { u, nu, tau, dt, Reg (cell Reynolds number), cu (m/s per lattice speed), cp (Pa per lattice density·ρ), estDrho, ok, why }
 */
export function scaling({ dx, U, nu, Lc = 50, Dc = 10, uMax = 0.05, nuMax = 0.5, drho = 0.03, internal = true, turbulent = false }) {
  const Reg = U * dx / nu, Re = Reg * Dc;
  // density change budget: pipe-friction loss over the path (Hagen–Poiseuille 64/Re, or Blasius 0.316 Re^−¼ when turbulent)
  // + a few dynamic heads (internal); dynamic heads (external)
  const f = turbulent ? Math.max(64 / Math.max(Re, 1e-12), 0.316 * Math.max(Re, 1) ** -0.25) : 64 / Math.max(Re, 1e-12);
  const k = internal ? 3 * (f / 2 * Lc / Dc + 2) : 3 * 1.5;
  let u = Math.min(uMax, Math.sqrt(drho / k), turbulent ? Infinity : nuMax * Reg);
  const nuL = u / Reg, tau = 3 * nuL + 0.5, dt = u * dx / U;
  const out = { u, nu: nuL, tau, dt, dx, Reg, Re, cu: dx / dt, estDrho: k * u * u, ok: true, why: '' };
  // laminar: the cell must resolve the viscosity itself; turbulent: the eddy viscosity carries the stress, the molecular τ
  // may sit at ½ (refused only when even a wall cell would be far outside the wall law's checked range)
  if (!turbulent && tau < 0.5 + 5e-4) { out.ok = false; out.why = t('study.flow.err.cells_too_large', { re: Reg.toPrecision(3), n: Math.ceil(Reg / 30) }); }
  if (turbulent && Reg > 1e5) { out.ok = false; out.why = t('study.flow.err.cells_too_large_turb', { re: Reg.toPrecision(3), n: Math.ceil(Reg / 2e4) }); }
  return out;
}

// ------------------------------------------------------------------------------------------- fields and tracing

/** Cell-centred velocity at a point (grid units: cell (i,j,k) centre at i+½…), trilinear over fluid cells, 0 in solid. */
export function sampleVelocity(F, x, y, z, out) {
  const { nx, ny, nz, mask, vx, vy, vz } = F;
  const fx = x - 0.5, fy = y - 0.5, fz = z - 0.5, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), tx = fx - i, ty = fy - j, tz = fz - k;
  out[0] = out[1] = out[2] = 0;
  let wsum = 0;
  for (let c = 0; c < 8; c++) {
    const ii = i + (c & 1), jj = j + ((c >> 1) & 1), kk = k + ((c >> 2) & 1);
    if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
    const e = ii + nx * (jj + ny * kk);
    const w = (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * ((c >> 2) & 1 ? tz : 1 - tz);
    wsum += w;
    if (mask[e] !== 1) continue;           // solid and boundary cells count as zero velocity (no-slip)
    out[0] += w * vx[e]; out[1] += w * vy[e]; out[2] += w * vz[e];
  }
  return wsum;
}
export const isFluidAt = (F, x, y, z) => {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  return i >= 0 && j >= 0 && k >= 0 && i < F.nx && j < F.ny && k < F.nz && F.mask[i + F.nx * (j + F.ny * k)] === 1;
};

/**
 * Streamlines through a cell-centred field F {nx, ny, nz, h, origin, mask (1 fluid), vx, vy, vz} from seed points (world mm):
 * RK2 (midpoint) with steps of `ds` cells along the direction of flow, stopping on leaving the fluid, stalling, or after
 * `maxSteps`. → [{ points: Float32Array (xyz world), speed: Float32Array }]
 */
export function streamlines(F, seeds, { ds = 0.4, maxSteps = 3000, both = false } = {}) {
  const out = [], v = [0, 0, 0], v2 = [0, 0, 0], h = F.h, o = F.origin;
  let vmax = 0;
  for (let e = 0; e < F.mask.length; e++) if (F.mask[e] === 1) vmax = Math.max(vmax, Math.hypot(F.vx[e], F.vy[e], F.vz[e]));
  const stall = 1e-4 * (vmax || 1);
  const trace = (p0, dirSign) => {
    const pts = [], sp = [];
    let x = (p0[0] - o[0]) / h, y = (p0[1] - o[1]) / h, z = (p0[2] - o[2]) / h;
    for (let s = 0; s < maxSteps; s++) {
      if (!isFluidAt(F, x, y, z)) break;
      sampleVelocity(F, x, y, z, v);
      const m = Math.hypot(v[0], v[1], v[2]);
      pts.push(o[0] + x * h, o[1] + y * h, o[2] + z * h); sp.push(m);
      if (m < stall) break;
      const a = dirSign * ds / m;
      sampleVelocity(F, x + 0.5 * a * v[0], y + 0.5 * a * v[1], z + 0.5 * a * v[2], v2);
      const m2 = Math.hypot(v2[0], v2[1], v2[2]);
      if (m2 < stall) break;
      const b = dirSign * ds / m2;
      x += b * v2[0]; y += b * v2[1]; z += b * v2[2];
    }
    return { pts, sp };
  };
  for (const p of seeds) {
    const f = trace(p, 1);
    let pts = f.pts, sp = f.sp;
    if (both) { const r = trace(p, -1); const n = r.sp.length; const rp = []; const rs = []; for (let i = n - 1; i >= 1; i--) { rp.push(r.pts[3 * i], r.pts[3 * i + 1], r.pts[3 * i + 2]); rs.push(r.sp[i]); } pts = rp.concat(pts); sp = rs.concat(sp); }
    if (sp.length >= 2) out.push({ points: Float32Array.from(pts), speed: Float32Array.from(sp) });
  }
  return out;
}

/**
 * A slice of a cell field through the grid: axis 0/1/2, world coordinate `at` → { w, hgt, values: Float32Array (w·hgt,
 * NaN where not fluid), u0/v0 (world min corner of the slice in the in-plane axes), du, axes: [a, b], layer }.
 */
export function slice(F, values, axis, at) {
  const dims = [F.nx, F.ny, F.nz], a = axis === 0 ? 1 : 0, b = axis === 2 ? 1 : 2;
  const layer = Math.max(0, Math.min(dims[axis] - 1, Math.floor((at - F.origin[axis]) / F.h)));
  const w = dims[a], hgt = dims[b], out = new Float32Array(w * hgt);
  const st = [1, F.nx, F.nx * F.ny];
  for (let jb = 0; jb < hgt; jb++) for (let ia = 0; ia < w; ia++) {
    const e = layer * st[axis] + ia * st[a] + jb * st[b];
    out[ia + w * jb] = F.mask[e] === 1 ? values[e] : NaN;
  }
  return { w, hgt, values: out, axes: [a, b], layer, origin: [F.origin[a], F.origin[b]], h: F.h, at: F.origin[axis] + (layer + 0.5) * F.h };
}
