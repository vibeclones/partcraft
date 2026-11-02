/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-surf.js — a face's exact surface as plain data for the compute worker (no OpenCascade there): surfaces.js reads it.
 * brep.js faceTableOf calls exactSurface for every face that is not a plane or a cylinder (those already carry n/o and
 * axis/r). → a surfaces.js record { type sphere | cone | torus | revolution | extrusion | bspline, …, range } or null.
 *   sphere: gp_Sphere (Location, Radius). cone, torus: gp_Cone / gp_Torus are not bound in this build, so their axis,
 *   radii and angle come from the adaptor's derivatives at the middle of the face (P, ∂²P/∂u², ∂P/∂v, ∂²P/∂v²): exact.
 *   revolution / extrusion: the axis or direction and the basis curve (line, circle, ellipse, B-spline, Bézier → B-spline).
 *   bspline (and Bézier → B-spline by GeomConvert, exact): degrees, poles, weights when rational, the full knot vectors
 *   (periodic ones made non-periodic first, exactly). range = BRepTools::UVBounds (the trimmed parameter box).
 * Every record is checked before it is returned: 25 points of the OCCT face (a 5 × 5 grid over its parameter box) must lie
 * on the JS surface to 1e-9 of the face's size, else null (the mesher then follows the tessellation, and counts the face).
 * Size caps: ≤ 40,000 surface poles, ≤ 10,000 curve poles.
 */
import { closestOnSurface, readSurface } from './surfaces.js';

const xyz = (p) => [p.X(), p.Y(), p.Z()];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

/** Knot vector of a B-spline (curve: Knot/Multiplicity; surface: UKnot/UMultiplicity …) */
function knots(n, at, mult) { const out = []; for (let i = 1; i <= n; i++) { const k = at(i); for (let m = mult(i); m > 0; m--) out.push(k); } return out; }

function curveRecord(oc, T, c) {
  const type = c.GetType();
  if (type === 'GeomAbs_Line') { const d = T(c.EvalDN(0, 1)); return { kind: 'line', o: xyz(T(c.EvalD0(0))), d: unit(xyz(d)) }; }
  if (type === 'GeomAbs_Circle') { const ci = T(c.Circle()); return { kind: 'circle', c: xyz(T(ci.Location())), x: xyz(T(T(ci.XAxis()).Direction())), y: xyz(T(T(ci.YAxis()).Direction())), r: ci.Radius() }; }
  if (type === 'GeomAbs_Ellipse') { const e = T(c.Ellipse()); return { kind: 'ellipse', c: xyz(T(e.Location())), x: xyz(T(T(e.XAxis()).Direction())), y: xyz(T(T(e.YAxis()).Direction())), a: e.MajorRadius(), b: e.MinorRadius() }; }
  let bs = null;
  if (type === 'GeomAbs_BSplineCurve') bs = T(c.BSpline());
  else if (type === 'GeomAbs_BezierCurve') bs = T(oc.GeomConvert.CurveToBSplineCurve(T(c.Bezier())));
  if (!bs) return null;
  if (bs.IsPeriodic()) { bs = T(new oc.Geom_BSplineCurve(bs)); bs.SetNotPeriodic(); }
  const n = bs.NbPoles();
  if (n > 10000) return null;
  const P = [], W = bs.IsRational() ? [] : null;
  for (let i = 1; i <= n; i++) { P.push(...xyz(T(bs.Pole(i)))); if (W) W.push(bs.Weight(i)); }
  return { kind: 'nurbs', deg: bs.Degree(), k: knots(bs.NbKnots(), (i) => bs.Knot(i), (i) => bs.Multiplicity(i)), P, W };
}

function bsplineRecord(oc, T, bs) {
  if (bs.IsUPeriodic() || bs.IsVPeriodic()) { bs = T(new oc.Geom_BSplineSurface(bs)); if (bs.IsUPeriodic()) bs.SetUNotPeriodic(); if (bs.IsVPeriodic()) bs.SetVNotPeriodic(); }
  const nu = bs.NbUPoles(), nv = bs.NbVPoles();
  if (nu * nv > 40000) return null;
  const rational = bs.IsURational() || bs.IsVRational(), P = new Array(3 * nu * nv), W = rational ? new Array(nu * nv) : null;
  for (let i = 1; i <= nu; i++) for (let j = 1; j <= nv; j++) {
    const k = (i - 1) * nv + (j - 1), p = T(bs.Pole(i, j));
    P[3 * k] = p.X(); P[3 * k + 1] = p.Y(); P[3 * k + 2] = p.Z();
    if (W) W[k] = bs.Weight(i, j);
  }
  return { type: 'bspline', ud: bs.UDegree(), vd: bs.VDegree(), nu, nv, uk: knots(bs.NbUKnots(), (i) => bs.UKnot(i), (i) => bs.UMultiplicity(i)), vk: knots(bs.NbVKnots(), (i) => bs.VKnot(i), (i) => bs.VMultiplicity(i)), P, W };
}

/** The exact surface record of face F (its BRepAdaptor_Surface ad), checked against OCCT, or null. */
export function exactSurface(oc, T, F, ad) {
  const type = ad.GetType(), b = oc.BRepTools.UVBounds(F), range = [b.UMin, b.UMax, b.VMin, b.VMax];
  if (!range.every(Number.isFinite) || !(range[1] > range[0]) || !(range[3] > range[2])) return null;
  const um = (range[0] + range[1]) / 2, vm = (range[2] + range[3]) / 2;
  const D = (nu, nv) => xyz(T(ad.EvalDN(um, vm, nu, nv)));
  let s = null;
  if (type === 'GeomAbs_Sphere') { const sp = T(ad.Sphere()); s = { type: 'sphere', c: xyz(T(sp.Location())), r: sp.Radius() }; }
  else if (type === 'GeomAbs_Cone') {
    // P = L + (R + v sinα)(cos u X + sin u Y) + v cosα Z: ∂²P/∂u² = −ρe (ρ the radius here), ∂P/∂v = sinα e + cosα Z
    const P = xyz(T(ad.EvalD0(um, vm))), Puu = D(2, 0), Pv = D(0, 1), rho = Math.hypot(...Puu), e = Puu.map((x) => -x / rho);
    const se = Pv[0] * e[0] + Pv[1] * e[1] + Pv[2] * e[2], z = [0, 1, 2].map((a) => Pv[a] - se * e[a]), zl = Math.hypot(...z);
    s = { type: 'cone', o: [0, 1, 2].map((a) => P[a] - rho * e[a]), d: z.map((x) => x / zl), r0: rho, k: se / zl };
  } else if (type === 'GeomAbs_Torus') {
    // ∂²P/∂u² = −ρe (ρ = R + r cos v, the distance to the axis), ∂²P/∂v² = −r n (n from the tube centre)
    const P = xyz(T(ad.EvalD0(um, vm))), Puu = D(2, 0), Pu = D(1, 0), Pvv = D(0, 2), rho = Math.hypot(...Puu), e = Puu.map((x) => -x / rho);
    const A = [0, 1, 2].map((a) => P[a] - rho * e[a]), d = unit([e[1] * Pu[2] - e[2] * Pu[1], e[2] * Pu[0] - e[0] * Pu[2], e[0] * Pu[1] - e[1] * Pu[0]]);
    const M = [0, 1, 2].map((a) => P[a] + Pvv[a]), t = (M[0] - A[0]) * d[0] + (M[1] - A[1]) * d[1] + (M[2] - A[2]) * d[2], c = [0, 1, 2].map((a) => A[a] + t * d[a]);
    s = { type: 'torus', c, d, R: Math.hypot(M[0] - c[0], M[1] - c[1], M[2] - c[2]), r: Math.hypot(...Pvv) };
  } else if (type === 'GeomAbs_SurfaceOfRevolution') {
    const ax = T(ad.AxeOfRevolution()), curve = curveRecord(oc, T, T(ad.BasisCurve()));
    if (curve) s = { type: 'revolution', o: xyz(T(ax.Location())), d: unit(xyz(T(ax.Direction()))), curve };
  } else if (type === 'GeomAbs_SurfaceOfExtrusion') {
    const curve = curveRecord(oc, T, T(ad.BasisCurve()));
    if (curve) s = { type: 'extrusion', d: unit(xyz(T(ad.Direction()))), curve };
  } else if (type === 'GeomAbs_BSplineSurface') s = bsplineRecord(oc, T, T(ad.BSpline()));
  else if (type === 'GeomAbs_BezierSurface') s = bsplineRecord(oc, T, T(oc.GeomConvert.SurfaceToBSplineSurface(T(ad.GeomSurface()))));
  if (!s) return null;
  s.range = range;
  if (!readSurface(s)) return null;
  // check: points of the OCCT face lie on the record's surface
  const pts = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push(xyz(T(ad.EvalD0(range[0] + (range[1] - range[0]) * (0.02 + 0.24 * i), range[2] + (range[3] - range[2]) * (0.02 + 0.24 * j)))));
  let size = 0; for (const p of pts) size = Math.max(size, Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]));
  size = Math.max(size, s.r || 0, s.R || 0, 1e-6);
  for (const p of pts) if (!(closestOnSurface(s, p).d <= 1e-9 * size)) return null;
  return s;
}
