/* SPDX-License-Identifier: Apache-2.0 */
/**
 * analysis.js — surface analyses on the part's mesh for the view (DOM-free; 0.4 P21, P22).
 *
 *   draftAngle(n, pull)                       degrees: asin(n·pull) — 90 facing the pull, 0 along it (a vertical wall), −90 against
 *   draftAnalysis(mesh, pull, minDeg, colors) → { colors: Float32Array (9 per triangle: RGB per corner), areas: { positive,
 *       needs, negative, total } (mm²) }   per corner (OpenCascade's surface normals when the mesh has them, else the
 *       triangle's): positive ≥ minDeg, negative ≤ −minDeg, needs draft between. A triangle's area is shared among its corners
 *       by class (a third each). colors = { positive, needs, negative: [r, g, b] 0…1 }.
 *   PULLS = { '+x': [1,0,0], … '-z': [0,0,-1] }   (Y is up in PartCraft)
 *   zebraColors(mesh, view, stripes, { dark, light }) → Float32Array (9 per triangle)   reflection stripes (surface.js zebra) of
 *       each corner's normal seen along `view`: they bend smoothly across a tangent-continuous join and jump at a crease (0.4 P22)
 *   curvatureColors(mesh, { concave, flat, convex }) → { colors, lim }   mean curvature per vertex (surface.js curvature: the
 *       cotangent Laplacian), clamped at its 95th percentile `lim` (1/mm), blue (concave) — paper (flat) — red (convex)
 */
import { curvature, zebra } from './surface.js';
export const PULLS = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
export const draftAngle = (n, pull) => Math.asin(Math.max(-1, Math.min(1, n[0] * pull[0] + n[1] * pull[1] + n[2] * pull[2]))) * 180 / Math.PI;

export function draftAnalysis(mesh, pull, minDeg, colors) {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3, CN = mesh.cornerNormals && mesh.cornerNormals.length === nt * 9 ? mesh.cornerNormals : null;
  const d = unit(pull), m = Math.abs(minDeg);
  const out = new Float32Array(nt * 9);
  const areas = { positive: 0, needs: 0, negative: 0, total: 0 };
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(cr[0], cr[1], cr[2]) / 2, tn = unit(cr);
    areas.total += area;
    for (let k = 0; k < 3; k++) {
      const n = CN ? unit([CN[t * 9 + k * 3], CN[t * 9 + k * 3 + 1], CN[t * 9 + k * 3 + 2]]) : tn;
      const ang = draftAngle(n, d);
      const cls = ang >= m - 1e-9 ? 'positive' : ang <= -m + 1e-9 ? 'negative' : 'needs';
      areas[cls] += area / 3;
      const col = colors[cls];
      out[t * 9 + k * 3] = col[0]; out[t * 9 + k * 3 + 1] = col[1]; out[t * 9 + k * 3 + 2] = col[2];
    }
  }
  return { colors: out, areas };
}

export function zebraColors(mesh, view, stripes, { dark, light }) {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3, CN = mesh.cornerNormals && mesh.cornerNormals.length === nt * 9 ? mesh.cornerNormals : null;
  const out = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const tn = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    for (let k = 0; k < 3; k++) {
      const n = CN ? unit([CN[t * 9 + k * 3], CN[t * 9 + k * 3 + 1], CN[t * 9 + k * 3 + 2]]) : tn;
      const col = zebra(n, view, stripes) ? light : dark;
      out[t * 9 + k * 3] = col[0]; out[t * 9 + k * 3 + 1] = col[1]; out[t * 9 + k * 3 + 2] = col[2];
    }
  }
  return out;
}

export function curvatureColors(mesh, { concave, flat, convex }) {
  const { mean } = curvature(mesh);
  const abs = Array.from(mean, Math.abs).sort((x, y) => x - y);
  const lim = abs[Math.floor(abs.length * 0.95)] || 1;
  const n = mesh.positions.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.max(-1, Math.min(1, mean[i] / lim)), to = t < 0 ? concave : convex, w = Math.abs(t);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = flat[k] + (to[k] - flat[k]) * w;
  }
  return { colors: out, lim };
}
