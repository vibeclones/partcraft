/* SPDX-License-Identifier: Apache-2.0 */
/**
 * refgeom.js — reference geometry (DOM-free, kernel-free): the plane, axis and point features worked out from what
 * they reference. Both kernels call refFeature() with their own resolvers, so a reference plane follows a face of
 * the exact kernel or a base plane / sketch point / other reference in either kernel.
 *
 *   refFeature(f, R) → { kind:'plane', frame, center } | { kind:'axis', o, d, a, b } | { kind:'point', p }
 *   R = { plane(PlaneRef) → frame, dir(DirRef) → { o, d }, point(PointRef) → [x,y,z],
 *         face(FaceRef) → { type, n?, o?, axis?, r? }, edge(EdgeRef) → { type, a, b, axis?, near?(p) → { p, t },
 *         mid?() → { p, t } (half way along it), cross?(frame) → [points where it crosses the plane, in order along it] },
 *         fail(message) (throws) }
 * Modes added 2026-10-11 (datum geometry between objects): point mid (of an edge, or between two points) · meet (a
 * straight edge, axis or curved edge with a plane or flat face; a line with a cylinder; flip = the other crossing) ·
 * planes3 (three planes); plane edgept (through a straight edge or axis and a point) · midnormal (square to an edge, or
 * to the segment between two points, at its middle).
 * Each mode fails with a plain message when its references do not fit (parallel planes for an intersection, three
 * points on a line, …); nothing is guessed.
 */
import * as V from './vec.js';
import { t as tr } from './i18n.js';

const EPS = 1e-9;
const unit = (v, R, what) => { const l = V.len(v); if (!(l > EPS)) R.fail(what); return V.mul(v, 1 / l); };
const project = (frame, p) => V.sub(p, V.mul(frame.n, V.dot(V.sub(p, frame.o), frame.n)));
const planeOf = (n, o, center) => ({ kind: 'plane', frame: V.frameFor(n, o), center: center || o });
/** v rotated about unit axis u by a radians (Rodrigues). */
export function rotate(v, u, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return V.add(V.add(V.mul(v, c), V.mul(V.cross(u, v), s)), V.mul(u, V.dot(u, v) * (1 - c)));
}

export function refFeature(f, R) {
  const P = (i) => { const r = f.points?.[i]; if (!r) R.fail(tr('model.refgeom.pick_point', { n: i + 1 })); return R.point(r); };
  const PL = (i) => { const r = f.planes?.[i]; if (!r) R.fail(i ? tr('model.refgeom.pick_second_plane') : tr('model.refgeom.pick_plane')); return R.plane(r); };
  if (f.type === 'point') {
    if (f.mode === 'xyz') return { kind: 'point', p: [...f.p] };
    if (f.mode === 'at') return { kind: 'point', p: P(0) };
    if (f.mode === 'mid') return { kind: 'point', p: midOf(f, R, P).p };
    if (f.mode === 'meet') return { kind: 'point', p: meet(f, R) };
    if (f.mode === 'planes3') {
      const a = PL(0), b = PL(1), c = f.planes?.[2] ? R.plane(f.planes[2]) : R.fail(tr('model.refgeom.pick_third_plane'));
      const p = V.solveDense([[...a.n], [...b.n], [...c.n]], [V.dot(a.n, a.o), V.dot(b.n, b.o), V.dot(c.n, c.o)]);
      const det = V.dot(a.n, V.cross(b.n, c.n));
      if (!p || Math.abs(det) < 1e-9) R.fail(tr('model.refgeom.planes3_no_point'));
      return { kind: 'point', p };
    }
    if (!f.edge) R.fail(tr('model.refgeom.pick_circular_edge'));
    const e = R.edge(f.edge);
    if (e.type !== 'circle' || !e.axis) R.fail(tr('model.refgeom.centre_needs_circle'));
    return { kind: 'point', p: e.axis.o };
  }
  if (f.type === 'axis') {
    let o, d;
    if (f.mode === '2pt') { o = P(0); d = unit(V.sub(P(1), o), R, tr('model.refgeom.same_point')); }
    else if (f.mode === 'cyl') {
      if (!f.face) R.fail(tr('model.refgeom.pick_cyl_cone_face'));
      const fc = R.face(f.face);
      if (!fc.axis) R.fail(tr('model.refgeom.face_no_axis'));
      ({ o, d } = fc.axis);
    } else if (f.mode === 'planes') {
      const a = PL(0), b = PL(1);
      d = V.cross(a.n, b.n);
      if (V.len(d) < 1e-9) R.fail(tr('model.refgeom.planes_parallel'));
      d = V.norm(d);
      // the point of the line nearest the planes' origins: solve n_a·x = c_a, n_b·x = c_b, d·x = d·(o_a+o_b)/2
      const ca = V.dot(a.n, a.o), cb = V.dot(b.n, b.o), cd = V.dot(d, V.mul(V.add(a.o, b.o), 0.5));
      o = V.solveDense([[...a.n], [...b.n], [...d]], [ca, cb, cd]);
      if (!o) R.fail(tr('model.refgeom.planes_no_line'));
    } else if (f.mode === 'edge') {
      if (!f.edge) R.fail(tr('model.refgeom.pick_edge_or_circle'));
      const e = R.edge(f.edge);
      if (e.type === 'line') { o = e.a; d = unit(V.sub(e.b, e.a), R, tr('model.refgeom.edge_no_length')); }
      else if (e.type === 'circle' && e.axis) ({ o, d } = e.axis);
      else R.fail(tr('model.refgeom.edge_curved_axis'));
    } else if (f.mode === 'normal') {
      const pl = PL(0);
      o = P(0); d = pl.n;
    } else R.fail(tr('model.refgeom.unknown_axis'));
    return { kind: 'axis', o, d: V.norm(d) };
  }
  // planes
  const flip = (n) => (f.flip ? V.mul(n, -1) : n);
  switch (f.mode) {
    case 'offset': {
      const b = PL(0);
      const n = b.n, o = V.add(b.o, V.mul(n, f.d));
      return planeOf(flip(n), o, V.add(b.center || b.o, V.mul(n, f.d)));
    }
    case 'angle': {
      const b = PL(0);
      if (!f.axis) R.fail(tr('model.refgeom.pick_turn_axis'));
      const ax = R.dir(f.axis);
      const u = V.norm(ax.d);
      const perp = V.sub(b.n, V.mul(u, V.dot(b.n, u)));
      if (V.len(perp) < 1e-9) R.fail(tr('model.refgeom.axis_square'));
      const n0 = V.norm(perp);
      const n = rotate(n0, u, f.angle * Math.PI / 180);
      return planeOf(flip(n), ax.o, ax.o);
    }
    case '3pt': {
      const a = P(0), b = P(1), c = P(2);
      const n = V.cross(V.sub(b, a), V.sub(c, a));
      if (V.len(n) < 1e-9 * Math.max(1, V.len(V.sub(b, a)) * V.len(V.sub(c, a)))) R.fail(tr('model.refgeom.points_on_line'));
      return planeOf(flip(V.norm(n)), a, V.mul(V.add(V.add(a, b), c), 1 / 3));
    }
    case 'mid': {
      const a = PL(0), b = PL(1);
      const diff = V.sub(a.n, b.n);
      let n, o;
      if (V.len(diff) > 1e-9) {
        // points as far from one as from the other: (x − oa)·na = (x − ob)·nb, i.e. x·(na − nb) = oa·na − ob·nb
        const L = V.len(diff);
        n = V.mul(diff, 1 / L);
        const c = (V.dot(a.o, a.n) - V.dot(b.o, b.n)) / L;
        o = V.mul(n, c);
      } else {
        // same facing and parallel: half way between them
        n = a.n;
        o = V.add(a.o, V.mul(n, V.dot(V.sub(b.o, a.o), n) / 2));
      }
      const ca = a.center || a.o, cb = b.center || b.o;
      const mid = V.mul(V.add(ca, cb), 0.5);
      const fr = V.frameFor(n, o);
      return planeOf(flip(n), o, project(fr, mid));
    }
    case 'tangent': {
      if (!f.face) R.fail(tr('model.refgeom.pick_cyl_face'));
      const fc = R.face(f.face);
      if (fc.type !== 'cylinder' || !fc.axis) R.fail(tr('model.refgeom.tangent_needs_cyl'));
      const p = P(0);
      const d = V.norm(fc.axis.d);
      const w = V.sub(p, fc.axis.o);
      const radial = V.sub(w, V.mul(d, V.dot(w, d)));
      if (V.len(radial) < 1e-9) R.fail(tr('model.refgeom.point_on_axis'));
      const n = V.norm(radial);
      const foot = V.add(fc.axis.o, V.mul(d, V.dot(w, d)));
      const o = V.add(foot, V.mul(n, fc.r));
      return planeOf(flip(n), o, o);
    }
    case 'edgept': {
      const ln = lineOf(f, R, tr('model.refgeom.pick_line_through'));
      const p = P(0);
      const n = V.cross(ln.d, V.sub(p, ln.o));
      if (V.len(n) < 1e-9 * Math.max(1, V.len(V.sub(p, ln.o)))) R.fail(tr('model.refgeom.point_on_line'));
      return planeOf(flip(V.norm(n)), ln.o, V.add(ln.o, V.mul(V.sub(p, ln.o), 0.5)));
    }
    case 'midnormal': {
      const m = midOf(f, R, P);
      if (!m.t || V.len(m.t) < 1e-12) R.fail(tr('model.refgeom.same_point_no_dir'));
      return planeOf(flip(V.norm(m.t)), m.p, m.p);
    }
    case 'normal': {
      const p = P(0);
      let at, t;
      if (f.edge) {
        const e = R.edge(f.edge);
        if (e.type === 'line') { const u = unit(V.sub(e.b, e.a), R, tr('model.refgeom.edge_no_length')); t = u; at = V.add(e.a, V.mul(u, V.dot(V.sub(p, e.a), u))); }
        else if (e.near) ({ p: at, t } = e.near(p));
        else R.fail(tr('model.refgeom.normal_curved_exact'));
      } else if (f.axis) {
        const ax = R.dir(f.axis);
        t = V.norm(ax.d); at = V.add(ax.o, V.mul(t, V.dot(V.sub(p, ax.o), t)));
      } else R.fail(tr('model.refgeom.pick_normal_edge'));
      return planeOf(flip(V.norm(t)), at, at);
    }
  }
  return R.fail(tr('model.refgeom.unknown_plane'));
}

/** A straight edge (f.edge) or a direction reference (f.axis) as a line { o, d (unit), a?, b? }. */
function lineOf(f, R, what) {
  if (f.edge) {
    const e = R.edge(f.edge);
    if (e.type !== 'line') R.fail(tr('model.refgeom.edge_curved_line'));
    return { o: e.a, d: unit(V.sub(e.b, e.a), R, tr('model.refgeom.edge_no_length')), a: e.a, b: e.b };
  }
  if (f.axis) { const ax = R.dir(f.axis); return { o: ax.o, d: V.norm(ax.d) }; }
  return R.fail(what);
}
/** Half way along an edge (by length), or between points 1 and 2: { p, t (direction there) }. */
function midOf(f, R, P) {
  if (f.edge) {
    const e = R.edge(f.edge);
    if (e.type === 'line') return { p: V.mul(V.add(e.a, e.b), 0.5), t: V.sub(e.b, e.a) };
    if (!e.mid) R.fail(tr('model.refgeom.mid_curved_exact'));
    return e.mid();
  }
  if (!f.points?.[0] || !f.points?.[1]) R.fail(tr('model.refgeom.pick_mid'));
  const a = P(0), b = P(1);
  return { p: V.mul(V.add(a, b), 0.5), t: V.sub(b, a) };
}
/** Where a line (straight edge, axis) or a curved edge meets a plane, a flat face or a cylinder. */
function meet(f, R) {
  const surf = f.face ? R.face(f.face) : f.planes?.[0] ? { type: 'plane', ...R.plane(f.planes[0]) } : R.fail(tr('model.refgeom.pick_meet_surface'));
  const curved = f.edge ? R.edge(f.edge) : null;
  if (curved && curved.type !== 'line') {
    if (surf.type !== 'plane') R.fail(tr('model.refgeom.curved_curved'));
    if (!curved.cross) R.fail(tr('model.refgeom.curved_cross_exact'));
    const hits = curved.cross({ o: surf.o, n: surf.n });
    if (!hits.length) R.fail(tr('model.refgeom.edge_misses_plane'));
    return hits[f.flip && hits.length > 1 ? 1 : 0];
  }
  const ln = lineOf(f, R, tr('model.refgeom.pick_meet_line'));
  if (surf.type === 'plane') {
    const dn = V.dot(ln.d, surf.n);
    if (Math.abs(dn) < 1e-12) R.fail(tr('model.refgeom.line_parallel_plane'));
    return V.add(ln.o, V.mul(ln.d, V.dot(V.sub(surf.o, ln.o), surf.n) / dn));
  }
  if (surf.type === 'cylinder' && surf.axis) {
    // |w − (w·a)a|² = r², w = o + t d − c: a quadratic in t
    const a = V.norm(surf.axis.d), w0 = V.sub(ln.o, surf.axis.o);
    const dp = V.sub(ln.d, V.mul(a, V.dot(ln.d, a))), wp = V.sub(w0, V.mul(a, V.dot(w0, a)));
    const A = V.dot(dp, dp), B = 2 * V.dot(dp, wp), C = V.dot(wp, wp) - surf.r * surf.r;
    if (A < 1e-18) R.fail(tr('model.refgeom.line_along_axis'));
    const disc = B * B - 4 * A * C;
    if (disc < 0) R.fail(tr('model.refgeom.line_misses_cyl'));
    const q = Math.sqrt(disc);
    // the crossing nearer the line's own point first (an edge: its middle)
    const t0 = ln.a ? V.dot(V.sub(V.mul(V.add(ln.a, ln.b), 0.5), ln.o), ln.d) : 0;
    const ts = [(-B - q) / (2 * A), (-B + q) / (2 * A)].sort((x, y) => Math.abs(x - t0) - Math.abs(y - t0));
    return V.add(ln.o, V.mul(ln.d, ts[f.flip ? 1 : 0]));
  }
  return R.fail(tr('model.refgeom.meet_other_curved'));
}

/** Corners of a reference plane's quad (half size s) for the view. */
export function planeQuad(g, s) {
  const c = V.toPlane(g.frame, g.center);
  return [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => V.toWorld(g.frame, c[0] + u, c[1] + v));
}
