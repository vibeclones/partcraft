/* SPDX-License-Identifier: Apache-2.0 */
import { t } from './i18n.js';
/**
 * vec.js — small 2D/3D vector, plane-frame and 4×4 matrix helpers for PartCraft (DOM-free).
 * 3D vectors are [x, y, z] arrays; matrices are 16 numbers in COLUMN-major order (what
 * manifold-3d's transform() and three.js Matrix4.fromArray() take).
 *
 * World axes follow the usual part-modeling convention: Y is up. The three base planes:
 *   front  XY (normal +Z) · top  XZ (normal +Y, sketch y = -Z) · right  YZ (normal +X, sketch x = -Z)
 * A plane frame is { o, x, y, n } with x × y = n (right-handed), all unit length.
 */

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const BASE_PLANES = {
  front: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  top: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0] },
  right: { o: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0] },
};
/** The base planes in words: getters, so the language file is read where they are shown (0.4 G). */
export const PLANE_NAMES = {
  get front() { return t('model.plane.front'); },
  get top() { return t('model.plane.top'); },
  get right() { return t('model.plane.right'); },
};

/**
 * The frame PartCraft gives any plane with normal n through point p: origin = the world origin
 * projected onto the plane; x = world X when the plane faces up/down, else Y × n (so a plane
 * parallel to a base plane gets exactly that base plane's axes); y = n × x.
 */
export function frameFor(n, p) {
  n = norm(n);
  let x;
  if (Math.abs(n[1]) > 0.9) x = norm(sub([1, 0, 0], mul(n, n[0])));
  else x = norm(cross([0, 1, 0], n));
  const y = cross(n, x);
  const d = dot(p, n);
  return { o: mul(n, d), x, y, n };
}

export const toWorld = (f, u, v) => [f.o[0] + f.x[0] * u + f.y[0] * v, f.o[1] + f.x[1] * u + f.y[1] * v, f.o[2] + f.x[2] * u + f.y[2] * v];
export const toPlane = (f, p) => { const d = sub(p, f.o); return [dot(d, f.x), dot(d, f.y)]; };
export const flipFrame = (f) => ({ o: f.o, x: mul(f.x, -1), y: f.y, n: mul(f.n, -1) });

/** Column-major matrix whose columns are the frame's axes: local (u, v, w) → o + u·x + v·y + w·n. */
export const frameMatrix = (f) => [...f.x, 0, ...f.y, 0, ...f.n, 0, ...f.o, 1];

/** Matrix taking local X→a, Y→b, Z→c, origin → o (columns). */
export const basisMatrix = (a, b, c, o) => [...a, 0, ...b, 0, ...c, 0, ...o, 1];

export const translation = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];

/** Rotation by `deg` about the axis through point p with direction d (right-hand rule). */
export function rotationAbout(p, d, deg) {
  const [x, y, z] = norm(d);
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const r = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ]; // column-major 3×3
  const rp = [r[0] * p[0] + r[3] * p[1] + r[6] * p[2], r[1] * p[0] + r[4] * p[1] + r[7] * p[2], r[2] * p[0] + r[5] * p[1] + r[8] * p[2]];
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, p[0] - rp[0], p[1] - rp[1], p[2] - rp[2], 1];
}

/** Reflection in the plane through o with normal n. */
export function reflection(o, n) {
  n = norm(n);
  const k = 2 * dot(o, n);
  const m = (i, j) => (i === j ? 1 : 0) - 2 * n[i] * n[j];
  return [m(0, 0), m(1, 0), m(2, 0), 0, m(0, 1), m(1, 1), m(2, 1), 0, m(0, 2), m(1, 2), m(2, 2), 0, k * n[0], k * n[1], k * n[2], 1];
}

export function applyMat(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
export const applyDir = (m, d) => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];

export function matMul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rI = 0; rI < 4; rI++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rI] * b[c * 4 + k];
    r[c * 4 + rI] = s;
  }
  return r;
}

/** Solve A x = b for a small dense square system (Gaussian elimination, partial pivoting). Returns null when singular. */
export function solveDense(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Display a length/number: up to 4 decimals, no trailing zeros. */
export function fmt(n, dp = 4) {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n) < 1e-9 ? 0 : n;
  return Number(a.toFixed(dp)).toString();
}
