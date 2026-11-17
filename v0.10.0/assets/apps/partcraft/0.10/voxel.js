/* SPDX-License-Identifier: Apache-2.0 */
/**
 * voxel.js — a solid triangle mesh → a regular grid of cubes (DOM-free), for Simulation and Generative.
 *
 * Grid  { h, nx, ny, nz, origin:[x,y,z], solid: Uint8Array(nx·ny·nz) (1 = inside), count }
 *   element (i,j,k) → e = i + nx·(j + ny·k); node (i,j,k) → n = i + (nx+1)·(j + (ny+1)·k); node 0 of element e
 *   is its (i,j,k) corner; corners in the order (000)(100)(110)(010)(001)(101)(111)(011).
 * Inside test: a cube is solid when its centre is inside the mesh — parity of crossings of a ray along +x
 * through the centre (triangles binned by their y/z extent). The ray is moved by an irrational fraction of
 * h (≈ 1e-7·h) so it never runs through an edge or vertex exactly; a row whose crossing count is still odd
 * (an open mesh) is retried with another offset and then dropped from the count (`oddRows`).
 * The grid is centred on the mesh's bounding box; when the box is a whole number of cubes the grid
 * matches it exactly (so flat faces lie on grid planes).
 *
 * Surface map: every node of an exposed cube face (a solid cube whose neighbour is empty or off the grid)
 * gets the B-rep face(s) whose triangles are nearest — every face within 1e-3·h of the nearest one, so a
 * node on an edge of a box belongs to both faces — when that distance is ≤ h (the staircase is at most
 * about h·√3/2 from the true surface). `mesh.triFace` gives each triangle's face (no triFace → face 0).
 */

import { t } from './i18n.js';

const TIE = 1e-3, PERTURB = [[1.2345e-7, 2.71828e-7], [-3.14159e-7, 1.41421e-7], [5.7721e-7, -4.6692e-7]];

export function gridDims(bbox, h) {
  const size = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]);
  const n = size.map((s) => Math.max(1, Math.ceil(s / h - 1e-6)));
  const origin = [0, 1, 2].map((a) => (bbox.min[a] + bbox.max[a]) / 2 - (n[a] * h) / 2);
  return { nx: n[0], ny: n[1], nz: n[2], origin };
}

export function meshBBox(mesh) {
  const P = mesh.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < min[a]) min[a] = P[i + a]; if (P[i + a] > max[a]) max[a] = P[i + a]; }
  return { min, max };
}

/** Rough size of a study before voxelizing: element count from the solid volume, node count from the box. */
export function estimate(volume, bbox, h) {
  const { nx, ny, nz } = gridDims(bbox, h);
  const elements = Math.round(volume / (h * h * h));
  const nodes = Math.min((nx + 1) * (ny + 1) * (nz + 1), Math.round(elements * 1.3 + 2 * (nx * ny + ny * nz + nz * nx)));
  // solver memory: ~8 vectors of 3 doubles per grid node + per-element data
  const bytes = (nx + 1) * (ny + 1) * (nz + 1) * 3 * 8 * 8 + nx * ny * nz * 13;
  return { elements, nodes, nx, ny, nz, bytes };
}

/** mesh {positions, indices, triFace?} → grid. opts { h, bbox? (grid box; default the mesh's), surface: true } */
export function voxelize(mesh, { h, bbox = null, surface = true } = {}) {
  if (!(h > 0)) throw new Error(t('study.mesh.size_positive'));
  const box = bbox || meshBBox(mesh);
  const { nx, ny, nz, origin } = gridDims(box, h);
  if (nx * ny * nz > 64e6) throw new Error(t('study.mesh.too_many'));
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3;
  const solid = new Uint8Array(nx * ny * nz);
  // bin triangles by the (j,k) rows their y/z extent covers
  const rows = new Map();
  for (let t = 0; t < nt; t++) {
    let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let c = 0; c < 3; c++) { const v = I[t * 3 + c] * 3; y0 = Math.min(y0, P[v + 1]); y1 = Math.max(y1, P[v + 1]); z0 = Math.min(z0, P[v + 2]); z1 = Math.max(z1, P[v + 2]); }
    const j0 = Math.max(0, Math.floor((y0 - origin[1]) / h - 0.5)), j1 = Math.min(ny - 1, Math.ceil((y1 - origin[1]) / h - 0.5));
    const k0 = Math.max(0, Math.floor((z0 - origin[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.ceil((z1 - origin[2]) / h - 0.5));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) { const key = j + ny * k; let l = rows.get(key); if (!l) rows.set(key, (l = [])); l.push(t); }
  }
  let oddRows = 0, count = 0;
  const xs = [];
  for (const [key, tris] of rows) {
    const j = key % ny, k = (key - j) / ny;
    let ok = false;
    for (let attempt = 0; attempt < PERTURB.length && !ok; attempt++) {
      const y = origin[1] + (j + 0.5 + PERTURB[attempt][0]) * h, z = origin[2] + (k + 0.5 + PERTURB[attempt][1]) * h;
      xs.length = 0;
      for (const t of tris) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ay = P[a + 1] - y, az = P[a + 2] - z, by = P[b + 1] - y, bz = P[b + 2] - z, cy = P[c + 1] - y, cz = P[c + 2] - z;
        const w0 = by * cz - bz * cy, w1 = cy * az - cz * ay, w2 = ay * bz - az * by;   // barycentric (×2 area) in the y/z projection
        if ((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0)) {
          const s = w0 + w1 + w2;
          xs.push((w0 * P[a] + w1 * P[b] + w2 * P[c]) / s);
        }
      }
      ok = xs.length % 2 === 0;
    }
    if (!ok) { oddRows++; xs.pop(); }
    if (!xs.length) continue;
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const i0 = Math.max(0, Math.ceil((xs[m] - origin[0]) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - origin[0]) / h - 0.5));
      for (let i = i0; i <= i1; i++) { const e = i + nx * key; if (!solid[e]) { solid[e] = 1; count++; } }
    }
  }
  const grid = { h, nx, ny, nz, origin, solid, count, oddRows };
  if (surface) grid.surf = surfaceMap(grid, mesh);
  return grid;
}

/** A solid box grid (every cube inside), for a box design space. */
export function boxGrid(bbox, h) {
  const { nx, ny, nz, origin } = gridDims(bbox, h);
  const solid = new Uint8Array(nx * ny * nz).fill(1);
  return { h, nx, ny, nz, origin, solid, count: solid.length, oddRows: 0 };
}

export const nodeXYZ = (g, n) => {
  const NX = g.nx + 1, NY = g.ny + 1, i = n % NX, j = Math.floor(n / NX) % NY, k = Math.floor(n / (NX * NY));
  return [g.origin[0] + i * g.h, g.origin[1] + j * g.h, g.origin[2] + k * g.h];
};
export const elemCentre = (g, e) => {
  const i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny));
  return [g.origin[0] + (i + 0.5) * g.h, g.origin[1] + (j + 0.5) * g.h, g.origin[2] + (k + 0.5) * g.h];
};
/** The 8 corner offsets of an element, in node indices, for this grid. */
export function cornerOffsets(g) {
  const NX = g.nx + 1, NXY = NX * (g.ny + 1);
  return [0, 1, 1 + NX, NX, NXY, NXY + 1, NXY + 1 + NX, NXY + NX];
}
export const elemNode0 = (g, e) => { const i = e % g.nx, j = Math.floor(e / g.nx) % g.ny, k = Math.floor(e / (g.nx * g.ny)); return i + (g.nx + 1) * (j + (g.ny + 1) * k); };

// the 6 faces of a cube as corner indices (outward order), with axis and side
const CUBE_FACES = [[0, 3, 7, 4, 0, -1], [1, 5, 6, 2, 0, 1], [0, 4, 5, 1, 1, -1], [3, 2, 6, 7, 1, 1], [0, 1, 2, 3, 2, -1], [4, 7, 6, 5, 2, 1]];

/** Exposed cube faces of a grid → { quads: Int32Array (4 node ids each), qdir: Int8Array (axis·2 + (side>0)) } */
export function exposedQuads(g, isSolid = (e) => g.solid[e] === 1) {
  const off = cornerOffsets(g), q = [], d = [];
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const e = i + g.nx * (j + g.ny * k);
    if (!isSolid(e)) continue;
    const n0 = i + (g.nx + 1) * (j + (g.ny + 1) * k), ijk = [i, j, k], dims = [g.nx, g.ny, g.nz], step = [1, g.nx, g.nx * g.ny];
    for (const [c0, c1, c2, c3, ax, s] of CUBE_FACES) {
      const ni = ijk[ax] + s;
      if (ni >= 0 && ni < dims[ax] && isSolid(e + s * step[ax])) continue;
      q.push(n0 + off[c0], n0 + off[c1], n0 + off[c2], n0 + off[c3]); d.push(ax * 2 + (s > 0 ? 1 : 0));
    }
  }
  return { quads: Int32Array.from(q), qdir: Int8Array.from(d) };
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5) → squared distance. */
function triDist2(p, P, a, b, c) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az, acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  const set = (u, v) => { qx = ax + abx * u + acx * v; qy = ay + aby * u + acy * v; qz = az + abz * u + acz * v; };
  if (d1 <= 0 && d2 <= 0) set(0, 0);
  else {
    const bpx = p[0] - P[b], bpy = p[1] - P[b + 1], bpz = p[2] - P[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = p[0] - P[c], cpy = p[1] - P[c + 1], cpz = p[2] - P[c + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) set(1, 0);
    else if (d6 >= 0 && d5 <= d6) set(0, 1);
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) set(d1 / (d1 - d3), 0);
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) set(0, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); set(1 - w, w); }
    else { const den = 1 / (va + vb + vc); set(vb * den, vc * den); }
  }
  return (p[0] - qx) ** 2 + (p[1] - qy) ** 2 + (p[2] - qz) ** 2;
}

/** A spatial hash of triangles (cells of size `cell`, each triangle's box grown by `pad`). */
export function triangleHash(mesh, cell, pad) {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3, map = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  for (let t = 0; t < nt; t++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) { const v = P[I[t * 3 + c] * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    const c0 = lo.map((v) => Math.floor((v - pad) / cell)), c1 = hi.map((v) => Math.floor((v + pad) / cell));
    for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) {
      const k = key(x, y, z); let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(t);
    }
  }
  return {
    near(p) { return map.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell))) || []; },
  };
}

/** For each point: the nearest faces (ties within TIE·h) within maxDist → { faces: [[fi...]], normals: [[[nx,ny,nz] per face]], dist }
 *  (each face's normal is that of its own nearest triangle, outward by the mesh's winding). */
export function nearestFaces(mesh, points, h, maxDist) {
  const P = mesh.positions, I = mesh.indices, tf = mesh.triFace;
  const hash = triangleHash(mesh, Math.max(2 * h, maxDist), maxDist);
  const out = { faces: [], normals: [], dist: new Float64Array(points.length) };
  const tie2 = (TIE * h) ** 2;
  const triN = (t) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  points.forEach((p, idx) => {
    let best = Infinity;
    const cand = hash.near(p), d2s = new Float64Array(cand.length);
    cand.forEach((t, m) => { const d2 = triDist2(p, P, I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3); d2s[m] = d2; if (d2 < best) best = d2; });
    const fs = [], ns = [], fd = [];
    if (best <= maxDist * maxDist) {
      const lim = Math.max(best + tie2, (Math.sqrt(best) + TIE * h) ** 2);
      cand.forEach((t, m) => {
        if (d2s[m] > lim) return;
        const f = tf ? tf[t] : 0; if (f < 0) return;
        const k = fs.indexOf(f);
        if (k < 0) { fs.push(f); ns.push(triN(t)); fd.push(d2s[m]); } else if (d2s[m] < fd[k]) { ns[k] = triN(t); fd[k] = d2s[m]; }
      });
    }
    out.faces.push(fs); out.normals.push(ns);
    out.dist[idx] = Math.sqrt(best);
  });
  return out;
}

/** Surface nodes of a grid and the B-rep faces they lie on. */
export function surfaceMap(g, mesh) {
  const { quads, qdir } = exposedQuads(g);
  const seen = new Map(), nodes = [];
  for (const n of quads) if (!seen.has(n)) { seen.set(n, nodes.length); nodes.push(n); }
  const nf = nearestFaces(mesh, nodes.map((n) => nodeXYZ(g, n)), g.h, g.h);
  return { quads, qdir, nodes: Int32Array.from(nodes), index: seen, faces: nf.faces, normals: nf.normals, dist: nf.dist };
}

/**
 * Nodes of a grid on a set of B-rep faces → { nodes: Int32Array, weight: Float64Array (tributary area,
 * mm²), normal: Float32Array (outward unit, the mean of the picked faces' normals at the node), normals:
 * [[[x,y,z] per picked face at the node]] (a node on the edge between two picked faces has both), area,
 * quadArea }.
 * surfaceOnly (default, a part design space): the surface nodes mapped to those faces; weights from the
 * exposed quads whose four corners all lie on them (a face with no such quad shares equally).
 * Otherwise (a box design space, where the face is inside the grid): every grid node of a solid cube
 * within h/2 of the faces' triangles, sharing equally.
 */
export function faceNodes(g, mesh, faceIdx, { surfaceOnly = true } = {}) {
  const want = new Set(faceIdx);
  const pack = (nodes, weight, normals, area, quadArea) => {
    const normal = new Float32Array(nodes.length * 3);
    normals.forEach((ns, i) => { const s = [0, 0, 0]; for (const n of ns) for (let a = 0; a < 3; a++) s[a] += n[a]; const l = Math.hypot(...s) || 1; for (let a = 0; a < 3; a++) normal[i * 3 + a] = s[a] / l; });
    return { nodes: Int32Array.from(nodes), weight: Float64Array.from(weight), normal, normals, area, quadArea };
  };
  if (surfaceOnly) {
    const s = g.surf, pick = new Map();
    s.nodes.forEach((n, m) => { if (s.faces[m].some((f) => want.has(f))) pick.set(n, m); });
    const w = new Map(); let area = 0;
    for (let q = 0; q < s.quads.length; q += 4) {
      if (!pick.has(s.quads[q]) || !pick.has(s.quads[q + 1]) || !pick.has(s.quads[q + 2]) || !pick.has(s.quads[q + 3])) continue;
      for (let c = 0; c < 4; c++) w.set(s.quads[q + c], (w.get(s.quads[q + c]) || 0) + g.h * g.h / 4);
      area += g.h * g.h;
    }
    const nodes = [], weight = [], normals = [];
    for (const [n, m] of pick) {
      const wt = area > 0 ? (w.get(n) || 0) : 1;
      if (!(wt > 0)) continue;
      nodes.push(n); weight.push(wt); normals.push(s.faces[m].map((f, k) => (want.has(f) ? s.normals[m][k] : null)).filter(Boolean));
    }
    return pack(nodes, weight, normals, area || nodes.length, area);
  }
  // box design space: nodes of solid cubes near the faces' triangles
  const sub = { positions: mesh.positions, indices: [], triFace: [] };
  for (let t = 0; t < mesh.indices.length / 3; t++) if (want.has(mesh.triFace ? mesh.triFace[t] : 0)) { sub.indices.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]); sub.triFace.push(mesh.triFace ? mesh.triFace[t] : 0); }
  if (!sub.indices.length) return pack([], [], [], 0, 0);
  const active = activeNodes(g), cand = [];
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const v of sub.indices) for (let a = 0; a < 3; a++) { bb.min[a] = Math.min(bb.min[a], mesh.positions[v * 3 + a]); bb.max[a] = Math.max(bb.max[a], mesh.positions[v * 3 + a]); }
  const r = g.h * 0.5 + 1e-9;
  const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((bb.min[a] - r - g.origin[a]) / g.h))), hi = [0, 1, 2].map((a, ai) => Math.min([g.nx, g.ny, g.nz][ai], Math.ceil((bb.max[a] + r - g.origin[a]) / g.h)));
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) { const n = i + (g.nx + 1) * (j + (g.ny + 1) * k); if (active[n]) cand.push(n); }
  const nf = nearestFaces(sub, cand.map((n) => nodeXYZ(g, n)), g.h, r);
  const keep = cand.map((n, i) => i).filter((i) => nf.faces[i].length);
  return pack(keep.map((i) => cand[i]), keep.map(() => 1), keep.map((i) => nf.normals[i]), keep.length, 0);
}

/** Uint8Array over grid nodes: 1 where a node belongs to a solid cube. */
export function activeNodes(g, isSolid = (e) => g.solid[e] === 1) {
  const a = new Uint8Array((g.nx + 1) * (g.ny + 1) * (g.nz + 1)), off = cornerOffsets(g);
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    if (!isSolid(i + g.nx * (j + g.ny * k))) continue;
    const n0 = i + (g.nx + 1) * (j + (g.ny + 1) * k);
    for (const o of off) a[n0 + o] = 1;
  }
  return a;
}

/** Elements whose centre is within dist of the given faces' triangles (preserve / obstacle regions). */
export function elementsNearFaces(g, mesh, faceIdx, dist) {
  const want = new Set(faceIdx);
  const sub = { positions: mesh.positions, indices: [], triFace: [] };
  for (let t = 0; t < mesh.indices.length / 3; t++) if (want.has(mesh.triFace ? mesh.triFace[t] : 0)) { sub.indices.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]); sub.triFace.push(0); }
  const out = new Uint8Array(g.nx * g.ny * g.nz);
  if (!sub.indices.length) return out;
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const v of sub.indices) for (let a = 0; a < 3; a++) { bb.min[a] = Math.min(bb.min[a], mesh.positions[v * 3 + a]); bb.max[a] = Math.max(bb.max[a], mesh.positions[v * 3 + a]); }
  const dims = [g.nx, g.ny, g.nz];
  const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((bb.min[a] - dist - g.origin[a]) / g.h - 0.5))), hi = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.ceil((bb.max[a] + dist - g.origin[a]) / g.h - 0.5)));
  const cand = [];
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) cand.push(i + g.nx * (j + g.ny * k));
  const nf = nearestFaces(sub, cand.map((e) => elemCentre(g, e)), g.h, dist);
  cand.forEach((e, i) => { if (nf.faces[i].length) out[e] = 1; });
  return out;
}
