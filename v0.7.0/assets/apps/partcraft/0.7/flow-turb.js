/* SPDX-License-Identifier: Apache-2.0 */
/**
 * flow-turb.js — turbulence for flow.js (DOM-free): steady RANS with the Spalart–Allmaras one-equation model
 * ("SA-noft2", the form on NASA's Turbulence Modeling Resource: Spalart & Allmaras 1992/1994, trip term off, with the
 * negative-S̃ limiter of Allmaras, Johnson & Spalart 2012 note (c)) solved by finite volumes on the same voxel cells as the
 * lattice Boltzmann flow, coupled through the eddy viscosity: each cell relaxes with τ = ½ + 3(ν + ν_t), ν_t = ν̃ f_v1
 * (flow.js makeState(…, { eddy: true }) → collideEddy).
 *
 *   ∂ν̃/∂t + u·∇ν̃ = c_b1 S̃ ν̃ − c_w1 f_w (ν̃/d)² + (1/σ)[∇·((ν + ν̃)∇ν̃) + c_b2 |∇ν̃|²]
 *
 * Discretisation: advection second-order upwind (MUSCL, minmod limiter) on the six face neighbours, diffusion by face
 * fluxes with the face-mean (ν + ν̃), vorticity by central differences, destruction implicit (keeps ν̃ ≥ 0), explicit
 * pseudo-time steps every `every` lattice steps (only the steady state is used). d = distance to the nearest wall (a vector
 * distance transform over the lattice links, seeded by each wall cell's wall point).
 *
 * Walls: every fluid cell with a wall link is a WALL-FUNCTION cell. Its velocity parallel to the wall, U, at the true
 * wall distance y (from the links' surface hits along the cell's wall normal) gives u_τ by Spalding's (1961) law of the
 * wall (κ 0.41, B 5.0), valid from the viscous sublayer through the log layer:
 *     y⁺ = u⁺ + e^(−κB) [e^(κu⁺) − 1 − κu⁺ − (κu⁺)²/2 − (κu⁺)³/6],   u⁺ = U/u_τ, y⁺ = y u_τ/ν
 * τ_w = ρu_τ² is imposed by a SLIP VELOCITY on the cell's wall links (moving-wall term: Ladd 1994; Bouzidi's form on
 * interpolated links), u_s = U − u_τ² y/(ν + ν_t) (under-relaxed), so the lattice's wall stress (ν + ν_t)(U − u_s)/y is τ_w;
 * ν̃ there = κu_τy (SA's exact inner-layer solution, any y⁺). `feedback` (on by default since 0.4 P2) moves u_s until the
 * cell's own shear stress from Π^neq equals τ_w: identical on flat walls, better wherever the flow is not in equilibrium
 * or the wall is a staircase (step reattachment −54/−38/−28 % → −39/−26/−21 % at 6/10/14 cells per step height; fully
 * developed pipe +38/+41/+34 % → +33/+34/+30 % at 10/20/30 cells across). `ref` (off; an experiment) takes u_τ from the
 * velocity one cell further out along the normal: pipe +23 % with feedback, but flat channels +5.8/+8.1 % instead of
 * +3.3/+4.7 %. The wall links join the lattice's local mass correction, so slip terms pass no mass.
 *
 * STATUS (round 5, 2026-10-12): EXPERIMENTAL (owner's decision; flow-study.js TURB_WARNING is shown with every
 * turbulent study). Plane channels: friction within +3…+5 % of Dean for first-cell y⁺ 49–98, bulk velocity −1 % vs the
 * Re_τ 180 DNS at y⁺ 3. Pipe through voxel cells, fully developed: +30…+34 % friction vs Colebrook. Backward-facing step
 * (Driver & Seegmiller, x_r 6.26h): 3.83 / 4.6 / 4.9h at 6 / 10 / 14 cells per step height (−39…−21 %), improving
 * slowly with finer cells. The 0.4 spike (P2, docs/0.4-sessions/part.md) ended no-go: no browser-sized grid reaches 15 %.
 * tools/partcraft-test/test-flow-turb.mjs pins the channel results. See docs/apps/partcraft.md, Flow, "Turbulence".
 */
import { CX, CY, CZ, W, OPP, Q } from './flow.js';

export const SA = { cb1: 0.1355, sigma: 2 / 3, cb2: 0.622, kappa: 0.41, cw2: 0.3, cw3: 2, cv1: 7.1, cv2: 0.7, cv3: 0.9 };
SA.cw1 = SA.cb1 / SA.kappa ** 2 + (1 + SA.cb2) / SA.sigma;
export const WALL_LAW = { kappa: 0.41, B: 5.0 };
/** The range of first-cell y⁺ this solver was checked over (channel, pipe and step tests); outside it the UI warns. */
export const YPLUS_RANGE = [1, 400];
/** The Smagorinsky constant of the lattice's stabilizer (flow.js collideEddy): acts only where it exceeds the model's ν_t. */
export const STABILIZER = 0.17;

const K_WALL = 1, K_BOUZIDI = 2, K_VEL = 3;   // flow.js link kinds
const EKB = Math.exp(-WALL_LAW.kappa * WALL_LAW.B);

/** Spalding's law: y⁺ from u⁺. */
export function spalding(up) { const k = WALL_LAW.kappa * up; return up + EKB * (Math.exp(k) - 1 - k - k * k / 2 - k * k * k / 6); }
const dSpalding = (up) => { const k = WALL_LAW.kappa * up; return 1 + EKB * WALL_LAW.kappa * (Math.exp(k) - 1 - k - k * k / 2); };

/** Friction velocity from the wall-parallel speed U at distance y (Spalding's law; monotone, Newton with a bisection guard). */
export function frictionVelocity(U, y, nu, guess = 0) {
  if (!(U > 0) || !(y > 0)) return 0;
  // f(t) = spalding(U/t) − y t/ν is strictly decreasing in t; Spalding's y⁺ ≥ u⁺, so the linear law t = √(Uν/y) is a lower
  // bound, and 2·max(U, that) an upper one
  const tl = Math.sqrt(U * nu / y);
  let lo = tl * (1 - 1e-12), hi = 2 * Math.max(U, tl);
  let t = guess > lo && guess < hi ? guess : Math.max(tl, U / 20);
  for (let it = 0; it < 60; it++) {
    const up = U / t, f = spalding(up) - y * t / nu;
    if (Math.abs(f) < 1e-10 * (1 + y * t / nu)) return t;
    if (f > 0) lo = t; else hi = t;
    const df = dSpalding(up) * (-U / (t * t)) - y / nu;
    let tn = t - f / df;
    if (!(tn > lo && tn < hi)) tn = 0.5 * (lo + hi);
    if (Math.abs(tn - t) < 1e-13 * t) return tn;
    t = tn;
  }
  return t;
}

const fv1 = (chi) => { const c3 = chi * chi * chi; return c3 / (c3 + SA.cv1 ** 3); };

/**
 * Attach the SA model to a state made with makeState(lat, { eddy: true }). opts: { nu (molecular, lattice), nuIn (ν̃ at
 * inflows; SA's free-stream value 3ν by default), inflow (Float64Array(nf): per-cell ν̃ for cells next to an inflow, e.g. a
 * boundary-layer profile; overrides nuIn), nt0 (initial ν̃, default nuIn), every (model update interval in steps, 2),
 * relax (under-relaxation of the wall slip, 0.2) }.
 * Sets S.turb; flow.js `step` then calls updateSlab/swap. Returns the model object.
 */
export function attachSA(S, { nu, nuIn = 3 * nu, nt0 = null, every = 2, inflow = null, relax = 0.2, feedback = true, ref = false } = {}) {
  const lat = S.lat, nf = lat.nf, G = nf * Q, L = lat.links, nbo = lat.nbo;
  if (!S.nut) throw new Error('The flow state has no eddy viscosity (make it with eddy: true).');   // i18n-ignore: caller error, never reaches a person
  // face neighbours: ≥ 0 a fluid cell, −1 wall, −2 inflow (ν̃ = nuIn), −3 zero gradient (outlet, slip)
  const nb6 = new Int32Array(nf * 6);
  for (let n = 0; n < nf; n++) for (let q = 1; q <= 6; q++) {
    const e = nbo[n * Q + OPP[q]];   // the cell at x + c_q (pull index of the opposite direction)
    let v;
    if (e < G) v = (e / Q) | 0;
    else { const kd = L.kind[e - G]; v = kd === K_WALL || kd === K_BOUZIDI ? -1 : kd === K_VEL ? -2 : -3; }
    nb6[n * 6 + q - 1] = v;
  }
  // wall-function cells: wall normal (into the wall), wall distance, and the reference point one cell further out
  const linIndex = new Int32Array(L.n).fill(-1);
  for (let m = 0; m < S.lin.k.length; m++) linIndex[S.lin.k[m]] = m;
  const wallOf = new Int32Array(nf).fill(-1), wc = [], wn = [], wd = [], wpart = [], ws = [0], wlLin = [], wlC = [], wlFac = [];
  for (let n = 0; n < nf; n++) {
    let mx = 0, my = 0, mz = 0, part = 0; const ks = [], ns = [];
    for (let q = 1; q < Q; q++) {
      const e = nbo[n * Q + q];
      if (e < G) continue;
      const k = e - G, kd = L.kind[k];
      if (kd !== K_WALL && kd !== K_BOUZIDI) continue;
      // the surface normal where the link meets the wall (into the solid), else the link direction −c_q
      const cl = Math.hypot(CX[q], CY[q], CZ[q]);
      const nn = L.wn ? [L.wn[3 * k], L.wn[3 * k + 1], L.wn[3 * k + 2]] : [NaN];
      const known = Number.isFinite(nn[0]);
      ks.push(k); ns.push(known ? nn : null); if (L.force[k]) part = 1;
      mx += W[q] * (known ? nn[0] : -CX[q] / cl); my += W[q] * (known ? nn[1] : -CY[q] / cl); mz += W[q] * (known ? nn[2] : -CZ[q] / cl);
    }
    if (!ks.length) continue;
    const ml = Math.hypot(mx, my, mz), m = ml > 1e-12 ? [mx / ml, my / ml, mz / ml] : [0, 0, 0];
    for (let i = 0; i < ns.length; i++) if (!ns[i]) ns[i] = m;   // no surface normal known (grid-edge walls): the cell's
    let sw = 0, sd = 0, dmin = Infinity;
    ks.forEach((k, i) => {
      const q = L.dir[k], nn = ns[i], qt = L.wd && Number.isFinite(L.wd[k]) ? L.wd[k] : L.kind[k] === K_BOUZIDI ? L.a[k] : 0.5;
      const cn = -(CX[q] * nn[0] + CY[q] * nn[1] + CZ[q] * nn[2]);   // c_o · n, c_o = −c_q towards the wall
      const dk = qt * cn;                                              // node-to-wall distance along the normal by this link
      if (cn > 0.3) { sw += W[q] * cn; sd += W[q] * cn * dk; }
      if (dk > 0) dmin = Math.min(dmin, dk);
      const li = linIndex[k];
      if (li < 0) return;
      // the moving-wall term of this link per unit wall velocity: Ladd's 6 w_i (Bouzidi's q ≥ ½ form divides it by 2q)
      wlLin.push(li); wlC.push(CX[q], CY[q], CZ[q]);
      wlFac.push(6 * W[q] * (L.kind[k] === K_BOUZIDI && L.a[k] >= 0.5 ? 1 / (2 * L.a[k]) : 1));
    });
    wallOf[n] = wc.length; wc.push(n); wn.push(...m); wd.push(Math.max(0.05, sw > 0 ? sd / sw : Number.isFinite(dmin) ? dmin : 0.5)); wpart.push(part); ws.push(wlLin.length);
  }
  const nw = wc.length;
  const wall = { cell: Int32Array.from(wc), n: Float64Array.from(wn), d: Float64Array.from(wd), part: Uint8Array.from(wpart), utau: new Float64Array(nw), yplus: new Float64Array(nw), us: new Float64Array(nw), uw: new Float64Array(3 * nw),
    start: Int32Array.from(ws), lin: Int32Array.from(wlLin), c: Int8Array.from(wlC), fac: Float64Array.from(wlFac), refIdx: new Int32Array(8 * nw).fill(-1), refW: new Float64Array(8 * nw) };
  // reference point x + 1·(−m): trilinear over the fluid cells around it (renormalised; periodic sides wrap)
  const per = lat.periodic || [false, false, false], dims = [lat.nx, lat.ny, lat.nz];
  for (let w = 0; w < nw; w++) {
    const c = wall.cell[w], ijk = [c % lat.nx, Math.floor(c / lat.nx) % lat.ny, Math.floor(c / (lat.nx * lat.ny))];
    const p = [0, 1, 2].map((a) => ijk[a] - wall.n[3 * w + a]), b0 = p.map(Math.floor), fr = p.map((v, a) => v - b0[a]);
    let ws = 0, o = 8 * w;
    for (let cn = 0; cn < 8; cn++) {
      const id = [0, 1, 2].map((a) => { let v = b0[a] + ((cn >> a) & 1); if (per[a]) v = ((v % dims[a]) + dims[a]) % dims[a]; return v; });
      if (id.some((v, a) => v < 0 || v >= dims[a])) continue;
      const fi = lat.index[id[0] + lat.nx * (id[1] + lat.ny * id[2])];
      if (fi < 0) continue;
      const wt = [0, 1, 2].reduce((acc, a) => acc * (((cn >> a) & 1) ? fr[a] : 1 - fr[a]), 1);
      if (wt <= 1e-12) continue;
      wall.refIdx[o] = fi; wall.refW[o] = wt; ws += wt; o++;
    }
    for (let k = 8 * w; k < o; k++) wall.refW[k] /= ws;
    if (o === 8 * w) { wall.refIdx[o] = c; wall.refW[o] = 1; }   // nothing around: the cell itself
  }
  const dist = wallDistance(lat, wall);
  const T = {
    kind: 'sa', nu, nuIn, every, relax, nb6, wallOf, wall, dist, dt: every, inflow,
    nt: new Float64Array(nf).fill(nt0 ?? nuIn), ntNew: new Float64Array(nf).fill(nt0 ?? nuIn), updates: 0,
    updateSlab: (S2, sl) => updateSlab(T, S2, sl), swap: (S2) => swap(T, S2),
  };
  for (let n = 0; n < nf; n++) S.nut[n] = T.nt[n] * fv1(T.nt[n] / nu);
  if (!S.nueff) S.nueff = Float64Array.from(S.nut);
  T.ref = ref;
  if (feedback) { T.feedback = true; S.wallSlot = wallOf; S.wallStress = new Float64Array(6 * nw); }
  S.turb = T;
  return T;
}

/** Wall distance for every fluid cell: nearest wall point propagated over the lattice links (Dijkstra on the true distance). */
function wallDistance(lat, wall) {
  const nf = lat.nf, G = nf * Q, nbo = lat.nbo, nw = wall.cell.length;
  const dist = new Float64Array(nf).fill(1e30);
  if (!nw) return dist;
  const vx = new Float64Array(nf), vy = new Float64Array(nf), vz = new Float64Array(nf);
  // binary heap of (distance, cell)
  let hk = new Float64Array(1024), hv = new Int32Array(1024), hn = 0;
  const push = (k, v) => {
    if (hn === hk.length) { const a = new Float64Array(2 * hn); a.set(hk); hk = a; const b = new Int32Array(2 * hn); b.set(hv); hv = b; }
    let i = hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], k = hk[--hn], vl = hv[hn];
    let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; }
    hk[i] = k; hv[i] = vl;
    return v;
  };
  for (let w = 0; w < nw; w++) {
    const n = wall.cell[w], d = wall.d[w];
    dist[n] = d; vx[n] = d * wall.n[3 * w]; vy[n] = d * wall.n[3 * w + 1]; vz[n] = d * wall.n[3 * w + 2];
    push(d, n);
  }
  const done = new Uint8Array(nf);
  while (hn) {
    const n = pop();
    if (done[n]) continue;
    done[n] = 1;
    for (let q = 1; q < Q; q++) {
      const e = nbo[n * Q + OPP[q]];   // neighbour m = n + c_q
      if (e >= G) continue;
      const m = (e / Q) | 0;
      if (done[m]) continue;
      const ax = vx[n] - CX[q], ay = vy[n] - CY[q], az = vz[n] - CZ[q], d = Math.hypot(ax, ay, az);
      if (d < dist[m] - 1e-12) { dist[m] = d; vx[m] = ax; vy[m] = ay; vz[m] = az; push(d, m); }
    }
  }
  return dist;
}

const minmod = (a, b) => (a * b <= 0 ? 0 : Math.abs(a) < Math.abs(b) ? a : b);
/** ∂a along an axis at cell n from its neighbours p (+) and m (−): central where both are fluid, one-sided at open boundaries. */
const grad = (a, n, p, m) => (p >= 0 && m >= 0 ? 0.5 * (a[p] - a[m]) : p >= 0 ? a[p] - a[n] : m >= 0 ? a[n] - a[m] : 0);

/** Spalding's law inverted: u⁺ from y⁺ (Newton; monotone). */
export function uPlus(yp) {
  if (!(yp > 0)) return 0;
  let u = Math.min(yp, Math.log(1 + WALL_LAW.kappa * yp) / WALL_LAW.kappa + 7.8);
  for (let it = 0; it < 50; it++) { const f = spalding(u) - yp, du = f / dSpalding(u); u = Math.max(0.5 * u, u - du); if (Math.abs(du) < 1e-12 * (1 + u)) break; }
  return u;
}

/**
 * The model on a slab of cells, every `every` lattice steps: the wall-function cells (u_τ, ν̃ = κu_τy, the slip terms of
 * their wall links), then the SA equation in the other cells (new ν̃ into ntNew, ν_t into S.nut).
 */
function updateSlab(T, S, sl) {
  const { nb6, wallOf, wall, dist, nt, ntNew, nu, nuIn, dt } = T, { ux, uy, uz, nut } = S, la = S.lin.a;
  const { cb1, sigma, cb2, kappa, cw1, cw2, cw3, cv1, cv2, cv3 } = SA, k2 = kappa * kappa, cw36 = cw3 ** 6, cv13 = cv1 ** 3, isg = 1 / sigma;
  const doSA = S.step % T.every === 0, nu0 = (S.tau - 0.5) / 3;
  if (!doSA) return;
  const nin = T.inflow;   // per-cell ν̃ at an inflow face (tests' boundary-layer inflow), else nuIn
  const val = (a, j, own, c) => (j >= 0 ? a[j] : j === -2 && a === nt ? (nin ? nin[c] : nuIn) : own);
  for (let n = sl.n0; n < sl.n1; n++) {
    const w = wallOf[n];
    if (w >= 0) {
      // wall function: u_τ from Spalding's law at the cell's true wall distance, ν̃ = κu_τy, and the slip velocity on its
      // wall links that makes the lattice's wall stress (ν + ν_t)(U − u_s)/y equal τ_w = ρu_τ²
      const mx = wall.n[3 * w], my = wall.n[3 * w + 1], mz = wall.n[3 * w + 2], y = wall.d[w];
      const u0 = ux[n], u1 = uy[n], u2 = uz[n], un = u0 * mx + u1 * my + u2 * mz;
      const t0 = u0 - un * mx, t1 = u1 - un * my, t2 = u2 - un * mz, U = Math.hypot(t0, t1, t2);
      // u_τ from the wall law at the reference point one cell further out (the cell's own speed misleads where a staircase
      // puts it much nearer the wall than its neighbours), or at the cell itself
      let ut;
      if (T.ref) {
        let r0 = 0, r1 = 0, r2 = 0;
        for (let k = 8 * w; k < 8 * w + 8; k++) { const c = wall.refIdx[k]; if (c < 0) break; const wt = wall.refW[k]; r0 += wt * ux[c]; r1 += wt * uy[c]; r2 += wt * uz[c]; }
        const rn = r0 * mx + r1 * my + r2 * mz, Ur = Math.hypot(r0 - rn * mx, r1 - rn * my, r2 - rn * mz);
        ut = frictionVelocity(Ur, y + 1, nu, wall.utau[w]);
      } else ut = frictionVelocity(U, y, nu, wall.utau[w]);
      wall.utau[w] = ut; wall.yplus[w] = y * ut / nu;
      const v = kappa * ut * y, chi = v / nu, c3 = chi * chi * chi, nt1 = v * c3 / (c3 + cv13);
      ntNew[n] = v; nut[n] = nt1;
      // the cell's viscosity as the lattice used it (the stabilizer may have raised it above ν_t)
      const ne = S.nueff ? Math.max(nt1, S.nueff[n]) : nt1;
      let us;
      if (T.feedback && U > 1e-300) {
        // feedback: move the slip until the cell's own shear stress (from Π^neq) is τ_w — whatever the staircase does
        const e0 = t0 / U, e1 = t1 / U, e2 = t2 / U, o = 6 * w, st = S.wallStress;
        const snt = mx * (st[o] * e0 + st[o + 3] * e1 + st[o + 4] * e2) + my * (st[o + 3] * e0 + st[o + 1] * e1 + st[o + 5] * e2) + mz * (st[o + 4] * e0 + st[o + 5] * e1 + st[o + 2] * e2);
        us = wall.us[w] - (snt + S.rho[n] * ut * ut) * y / (nu0 + ne);   // a Newton step on σ_nt ≈ −(ν + ν_t)(U − u_s)/y; relaxed below
      } else us = U > 0 ? U - ut * ut * y / (nu0 + ne) : 0;
      us = Math.min(U, Math.max(0, us));
      // under-relaxed: the slip follows the cell's speed with a lag, which keeps the coupling from ringing at staircase cells
      us = wall.us[w] + T.relax * (us - wall.us[w]);
      wall.us[w] = us;
      const sc = U > 1e-300 ? us / U : 0;
      wall.uw[3 * w] = sc * t0; wall.uw[3 * w + 1] = sc * t1; wall.uw[3 * w + 2] = sc * t2;
      for (let m = wall.start[w]; m < wall.start[w + 1]; m++) la[wall.lin[m]] = wall.fac[m] * sc * (wall.c[3 * m] * t0 + wall.c[3 * m + 1] * t1 + wall.c[3 * m + 2] * t2);
      continue;
    }
    const b = n * 6, v = nt[n];
    const xp = nb6[b], xm = nb6[b + 1], yp = nb6[b + 2], ym = nb6[b + 3], zp = nb6[b + 4], zm = nb6[b + 5];
    // vorticity magnitude
    const wx = grad(uz, n, yp, ym) - grad(uy, n, zp, zm), wy = grad(ux, n, zp, zm) - grad(uz, n, xp, xm), wz = grad(uy, n, xp, xm) - grad(ux, n, yp, ym);
    const Om = Math.hypot(wx, wy, wz);
    // advection (MUSCL, minmod) and diffusion over the three axes
    let adv = 0, dif = 0, gsq = 0;
    for (let a = 0; a < 3; a++) {
      const p = nb6[b + 2 * a], m = nb6[b + 2 * a + 1], ua = a === 0 ? ux : a === 1 ? uy : uz;
      const vp = val(nt, p, v, n), vm = val(nt, m, v, n);
      const upp = p >= 0 ? val(nt, nb6[6 * p + 2 * a], vp, p) : vp, vmm = m >= 0 ? val(nt, nb6[6 * m + 2 * a + 1], vm, m) : vm;
      const uc = ua[n], ur = p >= 0 ? 0.5 * (uc + ua[p]) : uc, ul = m >= 0 ? 0.5 * (uc + ua[m]) : uc;
      const fr = ur > 0 ? v + 0.5 * minmod(v - vm, vp - v) : vp - 0.5 * minmod(vp - v, upp - vp);
      const fl = ul > 0 ? vm + 0.5 * minmod(vm - vmm, v - vm) : v - 0.5 * minmod(v - vm, vp - v);
      adv += ur * (fr - v) - ul * (fl - v);
      // zero-gradient sides carry no diffusive flux; the inflow side is a Dirichlet value half a cell out (taken at one)
      const dr = p === -3 ? 0 : (nu + 0.5 * (v + vp)) * (vp - v), dl = m === -3 ? 0 : (nu + 0.5 * (v + vm)) * (v - vm);
      dif += dr - dl;
      const gg = 0.5 * (vp - vm); gsq += gg * gg;
    }
    const d = dist[n], d2 = d * d, chi = v / nu, c3 = chi * chi * chi, f1 = c3 / (c3 + cv13), f2 = 1 - chi / (1 + chi * f1);
    const Sb = v * f2 / (k2 * d2);
    const St = Sb >= -cv2 * Om ? Om + Sb : Om + Om * (cv2 * cv2 * Om + cv3 * Sb) / ((cv3 - 2 * cv2) * Om - Sb);
    let r = St > 1e-30 ? v / (St * k2 * d2) : 10; if (r > 10) r = 10;
    const gr = r + cw2 * (r ** 6 - r), fw = gr * Math.pow((1 + cw36) / (gr ** 6 + cw36), 1 / 6);
    const rhs = cb1 * St * v - adv + isg * (dif + cb2 * gsq);
    let vn = (v + dt * rhs) / (1 + dt * cw1 * fw * v / d2);
    if (!(vn > 0)) vn = 0;
    ntNew[n] = vn;
    const cn = vn / nu, cn3 = cn * cn * cn;
    nut[n] = vn * cn3 / (cn3 + cv13);
  }
}

/** After every slab's update: ν̃ ← new, and the next pseudo-time step from the advection and diffusion limits. */
function swap(T, S) {
  if (S.step % T.every !== 0) return;
  const t = T.nt; T.nt = T.ntNew; T.ntNew = t; T.updates++;
  if (T.updates % 20 === 1) {
    let vmax = 0, umax = 0;
    const nt = T.nt, nf = nt.length;
    for (let n = 0; n < nf; n++) { if (nt[n] > vmax) vmax = nt[n]; const s = Math.abs(S.ux[n]) + Math.abs(S.uy[n]) + Math.abs(S.uz[n]); if (s > umax) umax = s; }
    T.dt = Math.max(0.05, Math.min(T.every, 0.5 / Math.max(umax, 1e-9), 0.8 * SA.sigma / (6 * (T.nu + vmax))));
  }
}

/** Wall statistics over the wall-function cells: first-cell y⁺ (min, max, mean, 5th/50th/95th percentiles) and the share of cells below / above YPLUS_RANGE. */
export function wallStats(T) {
  const W2 = T.wall, n = W2.cell.length;
  if (!n) return null;
  const y = Float64Array.from(W2.yplus).sort();
  let s = 0, lo = 0, hi = 0;
  for (let i = 0; i < n; i++) { s += y[i]; if (y[i] < YPLUS_RANGE[0]) lo++; else if (y[i] > YPLUS_RANGE[1]) hi++; }
  const pct = (p) => y[Math.min(n - 1, Math.floor(p * n))];
  return { cells: n, min: y[0], max: y[n - 1], mean: s / n, p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), below: lo / n, above: hi / n };
}

/**
 * The correction that makes the momentum-exchange force Galilean invariant on wall links that carry a slip velocity u_w
 * (Wen et al. 2014): force on the wall = −Σ c(f_in + f_out) + Σ u_w (f_in − f_out). Plain momentum exchange counts the slip
 * terms' momentum as wall force (≈ a dynamic pressure per wall cell). Lattice force per step; add to boundaryStats' force.
 */
export function wallForceCorrection(T, S) {
  const W2 = T.wall, P = S.lin, src = S.src, G = S.lat.nf * Q, f = [0, 0, 0];
  for (let w = 0; w < W2.cell.length; w++) {
    if (!W2.part[w]) continue;
    let d = 0;
    for (let m = W2.start[w]; m < W2.start[w + 1]; m++) { const li = W2.lin[m]; d += src[G + P.k[li]] - src[P.o1[li]]; }
    f[0] += W2.uw[3 * w] * d; f[1] += W2.uw[3 * w + 1] * d; f[2] += W2.uw[3 * w + 2] * d;
  }
  return f;
}
