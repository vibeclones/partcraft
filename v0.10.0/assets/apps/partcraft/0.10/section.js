/* SPDX-License-Identifier: Apache-2.0 */
/**
 * section.js — the live section view's plane (DOM-free; 0.4 P13). The view (view3d.js setSection) cuts away every
 * point p with n·p > c and caps the cut. This module holds the plane arithmetic of the panel
 * (section-ui.js), which keeps { n, c, flip }: the cut is { n, c } or, flipped, { −n, −c }.
 *   SECTION_BASES             front / top / right → the base plane's normal (world, Y up: front = XY, top = XZ, right = YZ)
 *   sectionRange(box, n)      [lo, hi] of n·p over the model's box: the slider's ends (lo = all cut away, hi = nothing)
 *   faceSection(face, M)      a picked flat face (brep.js face record: type 'plane', n, o) placed by a 4×4 column-major matrix
 *                             (assembly instances; null = identity) → { n, c } through the face, cutting its outside away
 *   flipSection(s)            the same plane, the other side cut away
 */
import { t } from './i18n.js';

export const SECTION_BASES = { front: [0, 0, 1], top: [0, 1, 0], right: [1, 0, 0] };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); if (!(l > 1e-12)) throw new Error(t('section.no_direction')); return [v[0] / l, v[1] / l, v[2] / l]; };

/** [lo, hi] of n·p over the 8 corners of box { min: [x,y,z], max: [x,y,z] }. */
export function sectionRange(box, n) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
    const d = dot(n, p); if (d < lo) lo = d; if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** Apply a column-major 4×4 matrix to a point (w = 1) or a direction (w = 0). */
const xf = (M, p, w) => (M ? [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + w * M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + w * M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + w * M[14]] : p.slice());

/**
 * A flat face's plane as a section: n = the face's outward normal (placed), c = n·(a point of the face). Cutting away
 * n·p > c removes what lies outside the face, so the cut starts flush with it. Directions go through the matrix's
 * inverse transpose (exact for rotations and uniform scale, which is all an assembly placement holds).
 */
export function faceSection(face, M = null) {
  if (!face || face.type !== 'plane' || !face.n || !face.o) throw new Error(t('section.need_flat'));
  const n = unit(xf(M, face.n, 0)), o = xf(M, face.o, 1);
  return { n, c: dot(n, o) };
}

/** The other side: the same plane, the other half cut away. */
export const flipSection = (s) => ({ n: [-s.n[0], -s.n[1], -s.n[2]], c: -s.c });
