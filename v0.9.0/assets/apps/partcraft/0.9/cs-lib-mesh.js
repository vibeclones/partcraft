/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lib-mesh.js — CraftScript builtins: meshes and the native element/solver kernels (DOM-free; script worker and Node).
 * Spec: docs/SCRIPTING-SPEC.md §1–§3 (builder B). Wraps PartCraft's own modules — never re-implements them:
 *   voxel.js (voxelize, exposed faces), tetmesh.js (isosurface-stuffing tet mesher, T10, quality), fea.js (h8/h8i hexahedron,
 *   von Mises, the matrix-free voxel model + geometric multigrid PCG), tetfea.js (T10 stiffness, mass, Gauss-point stress),
 *   thermal.js (hexahedron conduction/capacity), flow.js (D3Q19 lattice Boltzmann step).
 * All imports of those modules sit in ONE adapter section below (a later signature change is a one-place fix). No pool/thread
 * arguments are passed.
 *
 * Mesh values (§2): { t:'mesh', kind, nodes: Float64Array(3n), elems: Int32Array(npe·ne) — 0-BASED inside the value;
 * builtins that hand indices to a script (meshElems, edofs) add 1 }. kinds: 'tri' (surface; optional triFace, faces),
 * 'quad' (2-D grid, z = 0), 'hex8' (structured grid), 'voxel' (+ grid {h, nx, ny, nz, origin, solid, count}, elemIds = grid
 * element of each element; nodes = every grid node, so node ids are fea.js's), 'tet4' / 'tet10' (+ btri, bface, quality).
 * Hexahedron corner order (voxel, hex8): (000)(100)(110)(010)(001)(101)(111)(011); T10: corners then midsides
 * (01)(12)(02)(03)(13)(23). Element dofs are node-major: dof = 3·node + axis (edofs).
 * Field values: { t:'field', mesh, at:'node'|'elem', comps, data (entity-major, comps per entity), name?, unit? }.
 * LBM state (lbmInit) lives in this module (it holds big typed arrays and closures): the script gets a struct with an id;
 * lbmFree(S) drops it. Units: whatever the script uses consistently (PartCraft's own studies use mm, N, MPa, tonnes, s).
 */

// ─────────────────────────────────────────────────────────────── solver-module adapter (the only imports of solver modules)
import * as VX from './voxel.js';
import { tetMesh as kTetMesh, toT10 as kToT10, buildBVH as kBuildBVH, meshQuality as kMeshQuality } from './tetmesh.js';
import { hexElement as kHexElement, vonMises as kVonMises, elasticD as kElasticD, makeModel as kMakeModel, makeConstraints as kMakeConstraints, preconditioner as kPreconditioner, pcg as kVoxelPcg, rigidCheck as kRigidCheck } from './fea.js';
import { t10Stiffness as kT10Stiffness, t10Mass as kT10Mass, gpStress as kGpStress } from './tetfea.js';
import { ELEMENTS as kThermalElements } from './thermal.js';
import { buildLattice as kBuildLattice, makeState as kMakeState, step as kLbmStep, run as kLbmRun } from './flow.js';

import { mat, tensor, asTensor, scalarOf, optsOf, size2, typeName, indexList } from './cs-lib-linalg.js';

import { registerBuiltin as rtRegisterBuiltin } from './cs-runtime.js';
import { CsError } from './cs-values.js';
import { t } from './i18n.js';

const err = (msg) => new CsError(msg);
const isTensor = (v) => !!v && typeof v === 'object' && v.t === 'tensor';
const checker = (ctx) => (ctx && typeof ctx.check === 'function' ? () => ctx.check() : () => {});
const nout = (ctx) => (ctx && Number.isInteger(ctx.nargout) && ctx.nargout > 0 ? ctx.nargout : 1);
const struct = (o) => ({ t: 'struct', fields: o });
const NPE = { tri: 3, quad: 4, hex8: 8, voxel: 8, tet4: 4, tet10: 10 };
export const meshValue = (kind, nodes, elems, extra = {}) => ({ t: 'mesh', kind, nodes, elems, ...extra });

/** A mesh or model argument → mesh value. */
export function meshArg(v, what) {
  if (v && v.t === 'mesh') return v;
  if (v && v.t === 'model' && v.mesh && v.mesh.t === 'mesh') return v.mesh;
  throw err(t('script.mesh.not_mesh', { what: what ?? t('script.mesh.what.mesh'), got: typeName(v) }));
}
const triArg = (v, what) => { const m = meshArg(v, what); if (m.kind !== 'tri') throw err(t('script.mesh.not_tri', { what: what ?? t('script.mesh.what.mesh'), kind: m.kind })); return m; };
/** tri mesh value → the {positions, indices, triFace} shape PartCraft's modules read */
const triForKernel = (m) => ({ positions: m.nodes, indices: m.elems, triFace: m.triFace || null, edgeSegs: m.edgeSegs || undefined });

// ─────────────────────────────────────────────────────────────── primitives
export function boxSurface(lx, ly, lz, o = [0, 0, 0]) {
  const P = [], [x0, y0, z0] = o;
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) P.push(x0 + i * lx, y0 + j * ly, z0 + k * lz);
  // corners: index i + 2j + 4k; outward triangles
  const F = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const I = []; for (const [a, b, c, d] of F) I.push(a, b, c, a, c, d);
  return meshValue('tri', Float64Array.from(P), Int32Array.from(I), { triFace: Int32Array.from(F.flatMap((_, f) => [f, f])) });
}
export function cylinderSurface(r, h, n = 32) {
  const P = [0, 0, 0, 0, 0, h], I = [], tf = [];
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; P.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h); }
  const b = (i) => 2 + 2 * (i % n), t = (i) => 3 + 2 * (i % n);
  for (let i = 0; i < n; i++) {
    I.push(0, b(i + 1), b(i)); tf.push(0);
    I.push(1, t(i), t(i + 1)); tf.push(1);
    I.push(b(i), b(i + 1), t(i + 1), b(i), t(i + 1), t(i)); tf.push(2, 2);
  }
  return meshValue('tri', Float64Array.from(P), Int32Array.from(I), { triFace: Int32Array.from(tf) });
}
export function sphereSurface(r, n = 16) {
  const P = [0, 0, -r], I = [], rings = n, seg = 2 * n;
  for (let k = 1; k < rings; k++) { const th = Math.PI * k / rings - Math.PI / 2; for (let i = 0; i < seg; i++) { const a = 2 * Math.PI * i / seg; P.push(r * Math.cos(th) * Math.cos(a), r * Math.cos(th) * Math.sin(a), r * Math.sin(th)); } }
  P.push(0, 0, r);
  const v = (k, i) => 1 + (k - 1) * seg + (i % seg), top = P.length / 3 - 1;
  for (let i = 0; i < seg; i++) I.push(0, v(1, i + 1), v(1, i));
  for (let k = 1; k < rings - 1; k++) for (let i = 0; i < seg; i++) I.push(v(k, i), v(k, i + 1), v(k + 1, i + 1), v(k, i), v(k + 1, i + 1), v(k + 1, i));
  for (let i = 0; i < seg; i++) I.push(v(rings - 1, i), v(rings - 1, i + 1), top);
  return meshValue('tri', Float64Array.from(P), Int32Array.from(I));
}
export function hexGrid(lx, ly, lz, nx, ny, nz, o = [0, 0, 0]) {
  const N = (nx + 1) * (ny + 1) * (nz + 1), X = new Float64Array(3 * N);
  for (let k = 0, n = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, n++) { X[3 * n] = o[0] + lx * i / nx; X[3 * n + 1] = o[1] + ly * j / ny; X[3 * n + 2] = o[2] + lz * k / nz; }
  const E = new Int32Array(8 * nx * ny * nz), id = (i, j, k) => i + (nx + 1) * (j + (ny + 1) * k);
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) E.set([id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k), id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1)], 8 * e);
  return meshValue('hex8', X, E, { dims: [nx, ny, nz] });
}
export function quadGrid(lx, ly, nx, ny, o = [0, 0]) {
  const N = (nx + 1) * (ny + 1), X = new Float64Array(3 * N);
  for (let j = 0, n = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, n++) { X[3 * n] = o[0] + lx * i / nx; X[3 * n + 1] = o[1] + ly * j / ny; }
  const E = new Int32Array(4 * nx * ny), id = (i, j) => i + (nx + 1) * j;
  for (let j = 0, e = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) E.set([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)], 4 * e);
  return meshValue('quad', X, E, { dims: [nx, ny] });
}

// ─────────────────────────────────────────────────────────────── voxelize, tet mesh, surfaces, quality
export function voxelMeshOf(grid) {
  const ids = []; for (let e = 0; e < grid.solid.length; e++) if (grid.solid[e] === 1) ids.push(e);
  const off = VX.cornerOffsets(grid), E = new Int32Array(8 * ids.length);
  ids.forEach((e, m) => { const n0 = VX.elemNode0(grid, e); for (let c = 0; c < 8; c++) E[8 * m + c] = n0 + off[c]; });
  const NX = grid.nx + 1, NY = grid.ny + 1, N = NX * NY * (grid.nz + 1), X = new Float64Array(3 * N);
  for (let n = 0; n < N; n++) { const i = n % NX, j = Math.floor(n / NX) % NY, k = Math.floor(n / (NX * NY)); X[3 * n] = grid.origin[0] + i * grid.h; X[3 * n + 1] = grid.origin[1] + j * grid.h; X[3 * n + 2] = grid.origin[2] + k * grid.h; }
  const g = { h: grid.h, nx: grid.nx, ny: grid.ny, nz: grid.nz, origin: grid.origin.slice(), solid: grid.solid, count: ids.length, oddRows: grid.oddRows || 0 };
  return meshValue('voxel', X, E, { grid: g, elemIds: Int32Array.from(ids) });
}
export function voxelizeMesh(m, h, { bbox = null } = {}) {
  if (!(h > 0)) throw err(t('script.mesh.voxelize_h'));
  const g = VX.voxelize(triForKernel(m), { h, bbox, surface: false });
  if (!g.count) throw err(t('script.mesh.voxelize_empty'));
  return voxelMeshOf(g);
}
export function tetMeshOf(m, h, { order = 1, curv, thick, grade, levels, maxTets } = {}) {
  const k = triForKernel(m), faces = Array.isArray(m.faces) ? m.faces : [];
  const bvh = kBuildBVH(k);
  const o = { h, bvh }; for (const [n, v] of Object.entries({ curv, thick, grade, levels, maxTets })) if (v !== undefined) o[n] = v;
  const tm = kTetMesh(k, faces, o);
  const q = kMeshQuality(tm.nodes, tm.tets);
  const quality = { minDihedral: q.minDihedral, maxDihedral: q.maxDihedral, maxAspect: q.maxAspect, meanAspect: q.meanAspect, under5: q.under5 };
  if (order === 2) {
    const t10 = kToT10(tm, k, faces, bvh);
    return meshValue('tet10', Float64Array.from(t10.nodes), Int32Array.from(t10.tets10), { btri: Int32Array.from(tm.btri), bface: Int32Array.from(tm.bface), corners: t10.corners, quality });
  }
  return meshValue('tet4', Float64Array.from(tm.nodes), Int32Array.from(tm.tets), { btri: Int32Array.from(tm.btri), bface: Int32Array.from(tm.bface), quality });
}
/** Boundary of a volume mesh as a tri mesh (faces used once). */
export function surfaceOf(m) {
  const npe = NPE[m.kind];
  if (m.kind === 'tri') return m;
  if (m.kind === 'quad') { const I = []; for (let e = 0; e < m.elems.length / 4; e++) { const [a, b, c, d] = m.elems.subarray(4 * e, 4 * e + 4); I.push(a, b, c, a, c, d); } return meshValue('tri', m.nodes, Int32Array.from(I)); }
  if (m.kind === 'voxel') {
    const { quads } = VX.exposedQuads(m.grid), I = new Int32Array(quads.length / 4 * 6);
    for (let q = 0; q < quads.length / 4; q++) { const [a, b, c, d] = quads.subarray(4 * q, 4 * q + 4); I.set([a, b, c, a, c, d], 6 * q); }
    return meshValue('tri', m.nodes, I);
  }
  const faces = m.kind === 'hex8' ? [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]] : [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
  const seen = new Map(), ne = m.elems.length / npe;
  for (let e = 0; e < ne; e++) for (const f of faces) {
    const ids = f.map((c) => m.elems[npe * e + c]), key = ids.slice().sort((a, b) => a - b).join(',');
    if (seen.has(key)) seen.delete(key); else seen.set(key, ids);
  }
  const I = [];
  for (const ids of seen.values()) { if (ids.length === 3) I.push(...ids); else I.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]); }
  return meshValue('tri', m.nodes, Int32Array.from(I));
}

// ─────────────────────────────────────────────────────────────── element kernels
const D_CACHE = new Map();
const elasticD = (nu) => { if (!D_CACHE.has(nu)) D_CACHE.set(nu, kElasticD(nu)); return D_CACHE.get(nu); };
const hexType = (ty) => { if (ty === undefined) return 'h8i'; if (ty !== 'h8' && ty !== 'h8i') throw err(t('script.mesh.hex_type')); return ty; };
const checkEnu = (E, nu) => { if (!(E > 0)) throw err(t('script.mesh.young')); if (!(nu > -1 && nu < 0.5)) throw err(t('script.mesh.poisson')); };
/** h8/h8i stiffness of a cube of side h → 24×24 (= E·h·Ke of the unit cube). */
export function hexKe(E, nu, h, type = 'h8i') {
  checkEnu(E, nu);
  const el = kHexElement(nu, hexType(type)), s = E * h;
  return mat(24, 24, el.Ke.map((v) => v * s));   // symmetric: row-major = column-major
}
/** Stress operator of a cube: rows (point·6 + component) for the 8 corners then the centre, σ = op · ue → 54×24. */
export function hexStressOp(E, nu, h, type = 'h8i') {
  checkEnu(E, nu);
  const S = kHexElement(nu, hexType(type)).S, s = E / h, out = new Float64Array(54 * 24);
  for (let r = 0; r < 54; r++) for (let j = 0; j < 24; j++) out[r + j * 54] = S[r * 24 + j] * s;
  return mat(54, 24, out);
}
const cubeX = (h) => Float64Array.from([0, 0, 0, h, 0, 0, h, h, 0, 0, h, 0, 0, 0, h, h, 0, h, h, h, h, 0, h, h]);
export function hexKt(k, h) { const out = new Float64Array(64); kThermalElements.h8.conductivity(cubeX(h), k, out); return mat(8, 8, out); }
export function hexCt(rc, h, lumped = false) {
  const el = kThermalElements.h8;
  if (lumped) { const out = new Float64Array(8); el.capacity(cubeX(h), rc, out, true); const M = new Float64Array(64); for (let i = 0; i < 8; i++) M[i * 9] = out[i]; return mat(8, 8, M); }
  const out = new Float64Array(64); el.capacity(cubeX(h), rc, out, false); return mat(8, 8, out);
}
const X10 = (Xt) => { const tx = asTensor(Xt, 'X'); const [r, c] = size2(tx); if (r !== 10 || c !== 3) throw err(t('script.mesh.t10_coords', { size: `${r}×${c}` })); const X = new Float64Array(30); for (let a = 0; a < 10; a++) for (let i = 0; i < 3; i++) X[3 * a + i] = tx.data[a + i * 10]; return X; };
const EL10 = Int32Array.from({ length: 10 }, (_, i) => i);
export function t10Ke(Xt, E, nu) { checkEnu(E, nu); const Ke = new Float64Array(900); kT10Stiffness(X10(Xt), EL10, E, elasticD(nu), Ke); return mat(30, 30, Ke); }
const expandMass = (Me, out, off) => { for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) { const v = Me[a * 10 + b]; for (let i = 0; i < 3; i++) out[off + (3 * a + i) + (3 * b + i) * 30] = v; } };
export function t10Me(Xt, rho) { const Me = new Float64Array(100); kT10Mass(X10(Xt), EL10, rho, Me); const out = new Float64Array(900); expandMass(Me, out, 0); return mat(30, 30, out); }
const t10Mesh = (m) => { m = meshArg(m); if (m.kind !== 'tet10') throw err(t('script.mesh.need_tet10', { kind: m.kind })); return m; };
export function t10KeAll(m, E, nu, check = () => {}) {
  m = t10Mesh(m); checkEnu(E, nu);
  const ne = m.elems.length / 10, out = new Float64Array(900 * ne), D = elasticD(nu), el = new Int32Array(10), Ke = new Float64Array(900);
  for (let e = 0; e < ne; e++) { if ((e & 1023) === 0) check(); for (let a = 0; a < 10; a++) el[a] = m.elems[10 * e + a]; kT10Stiffness(m.nodes, el, E, D, Ke); out.set(Ke, 900 * e); }
  return tensor([30, 30, ne], out);
}
export function t10MeAll(m, rho, check = () => {}) {
  m = t10Mesh(m);
  const ne = m.elems.length / 10, out = new Float64Array(900 * ne), el = new Int32Array(10), Me = new Float64Array(100);
  for (let e = 0; e < ne; e++) { if ((e & 1023) === 0) check(); for (let a = 0; a < 10; a++) el[a] = m.elems[10 * e + a]; kT10Mass(m.nodes, el, rho, Me); expandMass(Me, out, 900 * e); }
  return tensor([30, 30, ne], out);
}
/** Element-mean stress (average of the 4 Gauss points) → ne×6 [xx yy zz xy yz zx]. */
export function t10Stress(m, u, E, nu) {
  m = t10Mesh(m); checkEnu(E, nu);
  const ne = m.elems.length / 10, D = elasticD(nu), el = new Int32Array(10), ue = new Float64Array(30), sig = new Float64Array(6), eps = new Float64Array(6), out = new Float64Array(6 * ne);
  if (u.length !== m.nodes.length) throw err(t('script.mesh.t10_u', { n: m.nodes.length }));
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 10; a++) { el[a] = m.elems[10 * e + a]; for (let i = 0; i < 3; i++) ue[3 * a + i] = u[3 * el[a] + i]; }
    for (let p = 0; p < 4; p++) { kGpStress(m.nodes, el, p, ue, E, D, sig, eps); for (let c = 0; c < 6; c++) out[e + c * ne] += sig[c] / 4; }
  }
  return mat(ne, 6, out);
}
export function vonMisesOf(s) {
  const ts = asTensor(s, t('script.mesh.what.stresses')), [n, c] = size2(ts);
  if (c !== 6) throw err(t('script.mesh.vonmises', { size: `${n}×${c}` }));
  const out = new Float64Array(n), v = new Float64Array(6);
  for (let i = 0; i < n; i++) { for (let k = 0; k < 6; k++) v[k] = ts.data[i + k * n]; out[i] = kVonMises(v); }
  return mat(n, 1, out);
}
/** 1-based dof numbers per element, node-major (dpn per node) → ne × (npe·dpn). */
export function edofsOf(m, dpn = 3) {
  m = meshArg(m);
  const npe = NPE[m.kind], ne = m.elems.length / npe, nd = npe * dpn, out = new Float64Array(ne * nd);
  for (let e = 0; e < ne; e++) for (let a = 0; a < npe; a++) for (let i = 0; i < dpn; i++) out[e + (a * dpn + i) * ne] = dpn * m.elems[npe * e + a] + i + 1;
  return mat(ne, nd, out);
}

// ─────────────────────────────────────────────────────────────── voxel model: matrix-free K, multigrid PCG (fea.js)
const voxelArg = (m) => { m = meshArg(m); if (m.kind !== 'voxel') throw err(t('script.mesh.need_voxel', { kind: m.kind })); return m; };
/** Constraints from 1-based dof numbers (dof = 3·node + axis + 1). */
function consFromDofs(dofs, nn) {
  const by = new Map(), ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const d of dofs) {
    if (!Number.isInteger(d) || d < 1 || d > 3 * nn) throw err(t('script.mesh.fixed_dof', { d, n: 3 * nn }));
    const n = Math.floor((d - 1) / 3), a = (d - 1) % 3;
    if (!by.has(n)) by.set(n, []); by.get(n).push(ax[a]);
  }
  return kMakeConstraints(by);
}
export function voxelSolveRun(m, E, nu, fixed, F, { scale = null, tol = 1e-8, maxit = 0, type = 'h8i', x0 = null } = {}, check = () => {}) {
  m = voxelArg(m); checkEnu(E, nu);
  const t0 = Date.now(), model = kMakeModel(m.grid, { E, nu, type: hexType(type) });
  if (scale && scale.length !== model.elems.length) throw err(t('script.mesh.voxel_scale', { n: model.elems.length }));
  const cons = consFromDofs(fixed, model.nn);
  const free = kRigidCheck(model, cons);
  if (free) throw err(t('script.mesh.voxel_free', { free: free.join(', ') }));
  if (F.length !== 3 * model.nn) throw err(t('script.mesh.voxel_f', { n: 3 * model.nn }));
  const pre = kPreconditioner(model, cons, scale);
  const t1 = Date.now();
  const sol = kVoxelPcg(model, cons, F, { x0, tol, maxIter: maxit, scale, ...pre, cancelled: () => { check(); return false; } });
  return { u: sol.u, iterations: sol.iterations, residual: sol.residual, converged: sol.converged, setupMs: t1 - t0, ms: Date.now() - t0, dofs: 3 * model.active.reduce((s, a) => s + a, 0) };
}
/** Element-centre stress of a voxel mesh → ne×6, and von Mises ne×1. */
export function voxelStressOf(m, u, E, nu, type = 'h8i') {
  m = voxelArg(m); checkEnu(E, nu);
  const S = kHexElement(nu, hexType(type)).S, s = E / m.grid.h, ne = m.elems.length / 8, out = new Float64Array(6 * ne), vm = new Float64Array(ne), v = new Float64Array(6);
  if (u.length !== m.nodes.length) throw err(t('script.mesh.voxel_u', { n: m.nodes.length }));
  for (let e = 0; e < ne; e++) {
    for (let r = 0; r < 6; r++) { let q = 0; for (let a = 0; a < 8; a++) { const n = m.elems[8 * e + a]; for (let i = 0; i < 3; i++) q += S[8 * 144 + r * 24 + 3 * a + i] * u[3 * n + i]; } v[r] = q * s; out[e + r * ne] = v[r]; }
    vm[e] = kVonMises(v);
  }
  return [mat(ne, 6, out), mat(ne, 1, vm)];
}

// ─────────────────────────────────────────────────────────────── lattice Boltzmann (flow.js D3Q19)
const LBM = new Map();
let lbmSeq = 0;
const lbmOf = (S) => {
  const id = S && S.t === 'struct' ? scalarOf(S.fields.lbm, t('script.mesh.what.lbm')) : scalarOf(S, t('script.mesh.what.lbm'));
  const st = LBM.get(id);
  if (!st) throw err(t('script.mesh.lbm_gone'));
  return { id, st };
};
const lbmStruct = (id, st) => struct({ lbm: id, nx: st.dims[0], ny: st.dims[1], nz: st.dims[2], fluid: st.S.lat.nf, step: st.S.step, tau: st.S.tau });
export function lbmInitRun(dom) {
  const o = optsOf(dom);
  const kt = o.kind && isTensor(o.kind) ? o.kind : null;
  if (!kt) throw err(t('script.mesh.lbm_kind'));
  const [nx, ny, nz = 1] = kt.shape;
  const kind = new Int32Array(nx * ny * nz);
  for (let i = 0; i < kind.length; i++) { const v = kt.data[i]; if (!Number.isInteger(v) || v < -1) throw err(t('script.mesh.lbm_kind_values')); kind[i] = v; }
  const groups = [null];
  const gl = o.groups ? (o.groups.t === 'cell' ? o.groups.items : [o.groups]) : [];
  for (const g of gl) {
    const f = optsOf(g), type = f.type;
    if (!['wall', 'velocity', 'pressure', 'slip'].includes(type)) throw err(t('script.mesh.lbm_group_type'));
    const vec3 = (v) => (v === undefined ? undefined : typeof v === 'number' ? [v, 0, 0] : Array.from(asTensor(v).data).concat([0, 0, 0]).slice(0, 3));
    groups.push({ type, u: vec3(f.u), rho: f.rho, axis: f.axis });
  }
  for (const v of kind) if (v >= groups.length) throw err(t('script.mesh.lbm_group_n', { g: v, n: groups.length - 1 }));
  const per = o.periodic ? Array.from(asTensor(o.periodic).data, (v) => !!v).concat([false, false, false]).slice(0, 3) : [false, false, nz === 1];
  const lat = kBuildLattice({ nx, ny, nz, kind, periodic: per, groups });
  const force = o.force !== undefined ? Array.from(typeof o.force === 'number' ? [o.force, 0, 0] : asTensor(o.force).data).concat([0, 0, 0]).slice(0, 3) : null;
  const S = kMakeState(lat, { tau: o.tau ?? 0.8, force, u0: o.u0 !== undefined ? Array.from(asTensor(o.u0).data).concat([0, 0, 0]).slice(0, 3) : [0, 0, 0] });
  const id = ++lbmSeq;
  LBM.set(id, { S, dims: [nx, ny, nz] });
  return lbmStruct(id, LBM.get(id));
}
export function lbmStepRun(Sv, n = 1, check = () => {}) {
  const { id, st } = lbmOf(Sv);
  for (let i = 0; i < n; i++) { if ((i & 63) === 0) check(); kLbmStep(st.S); }
  return lbmStruct(id, st);
}
export function lbmFieldOf(Sv) {
  const { st } = lbmOf(Sv), [nx, ny, nz] = st.dims, N = nx * ny * nz, { cells } = st.S.lat;
  const mk = () => new Float64Array(N).fill(NaN), ux = mk(), uy = mk(), uz = mk(), rho = mk();
  for (let k = 0; k < cells.length; k++) { const c = cells[k]; ux[c] = st.S.ux[k]; uy[c] = st.S.uy[k]; uz[c] = st.S.uz[k]; rho[c] = st.S.rho[k]; }
  const shape = nz === 1 ? [nx, ny] : [nx, ny, nz];
  return struct({ ux: tensor(shape, ux), uy: tensor(shape, uy), uz: tensor(shape, uz), rho: tensor(shape, rho), step: st.S.step });
}

// ─────────────────────────────────────────────────────────────── builtins
const N = (v, what) => scalarOf(v, what);
const vecOf = (v, what) => asTensor(v, what).data;
const optNum = (v, d) => (v === undefined ? d : scalarOf(v));
const fieldValue = (m, data, at, comps, name, unit) => ({ t: 'field', mesh: m, at, comps, data, ...(name ? { name } : {}), ...(unit ? { unit } : {}) });

/** name → [fn, signature]. The one-line help is the language file's script.doc.<name> (cs-runtime.js docKey), looked up when shown. */
export const BUILTINS = {
  meshBox: [(a) => boxSurface(N(a[0], 'lx'), N(a[1], 'ly'), N(a[2], 'lz'), a[3] ? Array.from(vecOf(a[3])) : undefined), 'm = meshBox(lx, ly, lz, origin)'],
  meshCylinder: [(a) => cylinderSurface(N(a[0], 'r'), N(a[1], 'h'), optNum(a[2], 32)), 'm = meshCylinder(r, h, n)'],
  meshSphere: [(a) => sphereSurface(N(a[0], 'r'), optNum(a[1], 16)), 'm = meshSphere(r, n)'],
  hexGrid: [(a) => hexGrid(N(a[0]), N(a[1]), N(a[2]), N(a[3]), N(a[4]), N(a[5]), a[6] ? Array.from(vecOf(a[6])) : undefined), 'm = hexGrid(lx, ly, lz, nx, ny, nz, origin)'],
  quadGrid: [(a) => quadGrid(N(a[0]), N(a[1]), N(a[2]), N(a[3]), a[4] ? Array.from(vecOf(a[4])) : undefined), 'm = quadGrid(lx, ly, nx, ny, origin)'],
  voxelize: [(a) => voxelizeMesh(triArg(a[0], 'voxelize'), N(a[1], 'h'), optsOf(a[2])), 'v = voxelize(model, h)'],
  tetmesh: [(a) => tetMeshOf(triArg(a[0], 'tetmesh'), N(a[1], 'h'), optsOf(a[2])), 't = tetmesh(model, h, opts)'],
  meshOf: [(a) => meshArg(a[0]), 'm = meshOf(model)'],
  meshNodes: [(a) => { const m = meshArg(a[0]), n = m.nodes.length / 3, d = new Float64Array(3 * n); for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) d[i + k * n] = m.nodes[3 * i + k]; return mat(n, 3, d); }, 'X = meshNodes(m)'],
  meshElems: [(a) => { const m = meshArg(a[0]), p = NPE[m.kind], ne = m.elems.length / p, d = new Float64Array(ne * p); for (let e = 0; e < ne; e++) for (let k = 0; k < p; k++) d[e + k * ne] = m.elems[p * e + k] + 1; return mat(ne, p, d); }, 'E = meshElems(m)'],
  meshInfo: [(a) => { const m = meshArg(a[0]), p = NPE[m.kind], f = { kind: m.kind, nodes: m.nodes.length / 3, elements: m.elems.length / p, nodesPerElement: p }; if (m.grid) Object.assign(f, { h: m.grid.h, nx: m.grid.nx, ny: m.grid.ny, nz: m.grid.nz, origin: tensor([1, 3], m.grid.origin) }); if (m.quality) f.quality = struct({ ...m.quality }); return struct(f); }, 's = meshInfo(m)'],
  meshSurface: [(a) => surfaceOf(meshArg(a[0])), 's = meshSurface(m)'],
  meshQuality: [(a) => { const m = meshArg(a[0]); if (m.kind !== 'tet4' && m.kind !== 'tet10') throw err(t('script.mesh.quality_tet')); const p = NPE[m.kind], ne = m.elems.length / p, t4 = new Int32Array(4 * ne); for (let e = 0; e < ne; e++) for (let k = 0; k < 4; k++) t4[4 * e + k] = m.elems[p * e + k]; const q = kMeshQuality(m.nodes, t4); return struct({ minDihedral: q.minDihedral, maxDihedral: q.maxDihedral, maxAspect: q.maxAspect, meanAspect: q.meanAspect, under5: q.under5, hist: tensor([1, 10], q.hist) }); }, 'q = meshQuality(t)'],
  edofs: [(a) => edofsOf(a[0], optNum(a[1], 3)), 'D = edofs(m, dpn)'],
  field: [(a) => { const m = meshArg(a[0]), tv = asTensor(a[1], t('script.mesh.what.values')), at = a[2] === undefined ? 'node' : a[2]; if (at !== 'node' && at !== 'elem') throw err(t('script.mesh.field_at')); const n = at === 'node' ? m.nodes.length / 3 : m.elems.length / NPE[m.kind], [r, c0] = size2(tv), c = r === n ? c0 : 1; if (r * c0 !== n * c) throw err(t(at === 'node' ? 'script.mesh.field_nodes' : 'script.mesh.field_elems', { n, size: `${r}×${c0}` })); if (![1, 3, 6].includes(c)) throw err(t('script.mesh.field_comps')); const d = new Float64Array(n * c); for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) d[i * c + k] = r === n ? tv.data[i + k * n] : tv.data[i * c + k]; return fieldValue(m, d, at, c, typeof a[3] === 'string' ? a[3] : undefined, typeof a[4] === 'string' ? a[4] : undefined); }, 'f = field(m, values, at, name, unit)'],
  hexKe: [(a) => hexKe(N(a[0], 'E'), N(a[1], 'nu'), optNum(a[2], 1), a[3]), 'Ke = hexKe(E, nu, h, type)'],
  hexStressOp: [(a) => hexStressOp(N(a[0], 'E'), N(a[1], 'nu'), optNum(a[2], 1), a[3]), 'S = hexStressOp(E, nu, h, type)'],
  hexKt: [(a) => hexKt(N(a[0], 'k'), optNum(a[1], 1)), 'Kt = hexKt(k, h)'],
  hexCt: [(a) => hexCt(N(a[0], 'rho*c'), optNum(a[1], 1), !!(a[2] && scalarOf(a[2]))), 'Ct = hexCt(rc, h, lumped)'],
  t10Ke: [(a) => t10Ke(a[0], N(a[1], 'E'), N(a[2], 'nu')), 'Ke = t10Ke(X, E, nu)'],
  t10Me: [(a) => t10Me(a[0], N(a[1], 'rho')), 'Me = t10Me(X, rho)'],
  t10KeAll: [(a, ctx) => t10KeAll(a[0], N(a[1], 'E'), N(a[2], 'nu'), checker(ctx)), 'Ke = t10KeAll(mesh, E, nu)'],
  t10MeAll: [(a, ctx) => t10MeAll(a[0], N(a[1], 'rho'), checker(ctx)), 'Me = t10MeAll(mesh, rho)'],
  t10Stress: [(a) => t10Stress(a[0], vecOf(a[1], 'u'), N(a[2], 'E'), N(a[3], 'nu')), 's = t10Stress(mesh, u, E, nu)'],
  vonMises: [(a) => vonMisesOf(a[0]), 'v = vonMises(s)'],
  voxelSolve: [(a, ctx) => {
    const o = optsOf(a[5]), r = voxelSolveRun(a[0], N(a[1], 'E'), N(a[2], 'nu'), Array.from(vecOf(a[3], t('script.mesh.what.fixed_dofs'))), vecOf(a[4], 'F'), { scale: o.scale !== undefined ? asTensor(o.scale).data : null, tol: o.tol ?? 1e-8, maxit: o.maxit ?? 0, type: o.type, x0: o.x0 !== undefined ? asTensor(o.x0).data : null }, checker(ctx));
    if (!r.converged && nout(ctx) <= 1) throw err(t('script.mesh.voxel_noconv', { res: r.residual.toExponential(2), its: r.iterations }));
    const u = mat(r.u.length, 1, r.u);
    return nout(ctx) <= 1 ? u : [u, struct({ iterations: r.iterations, residual: r.residual, converged: r.converged, dofs: r.dofs, setupMs: r.setupMs, ms: r.ms, prec: 'geometric multigrid' })];   // i18n-ignore: a preconditioner name scripts read from info.prec
  }, '[u, info] = voxelSolve(v, E, nu, fixedDofs, F, opts)'],
  voxelStress: [(a, ctx) => { const r = voxelStressOf(a[0], vecOf(a[1], 'u'), N(a[2], 'E'), N(a[3], 'nu'), a[4]); return nout(ctx) <= 1 ? r[1] : r; }, '[vm, s] = voxelStress(v, u, E, nu)'],
  lbmInit: [(a) => lbmInitRun(a[0]), 'S = lbmInit(dom)'],
  lbmStep: [(a, ctx) => lbmStepRun(a[0], optNum(a[1], 1), checker(ctx)), 'S = lbmStep(S, n)'],
  lbmRun: [(a, ctx) => { const { id, st } = lbmOf(a[0]), o = optsOf(a[1]), check = checker(ctx); const r = kLbmRun(st.S, { maxSteps: o.maxSteps ?? 20000, tol: o.tol ?? 1e-7, every: o.every ?? 100, onCheck: () => { check(); return false; } }); return nout(ctx) <= 1 ? lbmStruct(id, st) : [lbmStruct(id, st), struct({ steps: r.steps, converged: r.converged, res: r.res, blewUp: r.blewUp })]; }, '[S, info] = lbmRun(S, opts)'],
  lbmField: [(a) => lbmFieldOf(a[0]), 'f = lbmField(S)'],
  lbmFree: [(a) => { const { id } = lbmOf(a[0]); LBM.delete(id); return true; }, 'lbmFree(S)'],
};
/**
 * Register every builtin with cs-runtime.js. Runs once when this module is imported; calling
 * it again (or with another registry) is harmless. A name another module registered first is skipped (listed in `skipped`).
 */
export const skipped = [];
let registered = false;
export function register(registerBuiltin = rtRegisterBuiltin) {
  const own = registerBuiltin === rtRegisterBuiltin;
  if (own && registered) return skipped;
  for (const [name, [fn, args]] of Object.entries(BUILTINS)) {
    try { registerBuiltin(name, fn, { args, module: 'mesh' }); } catch { if (own) skipped.push(name); }   // doc: script.doc.<name> in the language file (cs-runtime.js docKey)
  }
  if (own) registered = true;
  return skipped;
}
register();
export { indexList };
