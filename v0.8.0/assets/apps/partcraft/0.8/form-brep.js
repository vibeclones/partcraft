/* SPDX-License-Identifier: Apache-2.0 */
/**
 * form-brep.js — a Form cage (form.js) as exact OpenCascade geometry (DOM-free; runs in the exact
 * kernel's worker and in Node, the OCCT module is passed in).
 *
 *   formShape(oc, form, { level, tol }) → { shape (TopoDS_Solid when the cage is closed, else a
 *       TopoDS_Shell; the caller deletes it), closed, faces (one per patch: { root cage face, exact }),
 *       report: { level, patches, exact, approx, irregular, gap (mm), deg (largest normal angle across
 *       a smooth patch edge), degExact (same, between exact patches only), volume? } }
 *
 * Method: form.js `patches` turns each quad of the cage refined `level` times into a bicubic Bézier
 * patch (exact limit surface where the corners are regular; a stated approximation at extraordinary
 * points). Each patch becomes a `Geom_BSplineSurface` (degree 3 × 3, knots [0, 1] with multiplicity
 * 4) face; `BRepBuilderAPI_Sewing` joins them (shared edge curves coincide to rounding, so the sewing
 * tolerance is 1e-7 of the size); a closed shell becomes a solid with `BRepBuilderAPI_MakeSolid`,
 * oriented outward (`BRepLib::OrientClosedSolid`) and checked by `BRepCheck_Analyzer`. Sharp creases
 * are patch boundaries, so they are C0 edges of the B-rep. Limit: one B-spline face per refined quad
 * (no merging of regular regions into larger surfaces yet).
 */
import * as FM from './form.js';
import { t } from './i18n.js';

class FormError extends Error {}
const fail = (m) => { throw new FormError(m); };

/** One bicubic Bézier patch as a Geom_BSplineSurface (registered in T). */
export function bezierSurface(oc, T, b) {
  const poles = T(new oc.NCollection_Array2_gp_Pnt(1, 4, 1, 4));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) poles.SetValue(i + 1, j + 1, T(new oc.gp_Pnt(b[i][j][0], b[i][j][1], b[i][j][2])));
  const knots = T(new oc.NCollection_Array1_double(1, 2)); knots.SetValue(1, 0); knots.SetValue(2, 1);
  const mults = T(new oc.NCollection_Array1_int(1, 2)); mults.SetValue(1, 4); mults.SetValue(2, 4);
  return T(new oc.Geom_BSplineSurface(poles, knots, knots, mults, mults, 3, 3, false, false));
}

/**
 * Sew faces into one shape: { shape, closed, free, shells, sew (for Modified) }. `closed`: no free edges → a solid (outward,
 * valid) is returned; otherwise the sewn shell(s).
 */
export function sewFaces(oc, T, faces, tol) {
  const sew = T(new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false));
  for (const f of faces) sew.Add(f);
  sew.Perform(T(new oc.Message_ProgressRange()));
  const sewn = T(sew.SewedShape());
  const free = sew.NbFreeEdges();
  const shells = [];
  const ex = T(new oc.TopExp_Explorer(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) shells.push(T(oc.TopoDS.Shell(T(ex.Current()))));
  if (free === 0 && shells.length === 1) {
    const ms = T(new oc.BRepBuilderAPI_MakeSolid(shells[0]));
    if (!ms.IsDone()) fail(t('form.brep.no_solid'));
    const solid = T(ms.Solid());
    oc.BRepLib.OrientClosedSolid(solid);
    const gp = T(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(solid, gp, false, false, false);
    let s = solid;
    if (gp.Mass() < 0) s = T(solid.Reversed());
    return { shape: s, closed: true, free, shells: 1, sew };
  }
  return { shape: sewn, closed: false, free, shells: shells.length, sew };
}

/**
 * The exact shape of a form (see the file header). Without `T` the returned shape is a fresh handle the
 * caller deletes; with an arena `T` everything stays in it and `faceMap` ([{ face (in the result), root, k }])
 * maps each patch to its face, k = its index among the patches of cage face `root`.
 */
export function formShape(oc, form, { level = null, tol = null, T: T0 = null } = {}) {
  const live = [];
  const T = T0 || ((o) => { if (o && typeof o.delete === 'function') live.push(o); return o; });
  try {
    const pr = FM.patches(form, { level });
    const rep = FM.patchReport(pr);
    let size = 0;
    for (const p of form.verts) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    const sewTol = tol || Math.max(1e-7, 1e-7 * size);
    const faces = pr.patches.map((p) => {
      const mf = T(new oc.BRepBuilderAPI_MakeFace(bezierSurface(oc, T, p.b), 1e-9));
      if (!mf.IsDone()) fail(t('form.brep.no_face'));
      return T(mf.Face());
    });
    const sewn = sewFaces(oc, T, faces, sewTol);
    const report = { level: pr.level, patches: pr.patches.length, exact: pr.exact, approx: pr.approx, irregular: pr.irregular, gap: rep.gap, deg: rep.deg, degExact: rep.degExact, free: sewn.free };
    if (sewn.closed) {
      const chk = T(new oc.BRepCheck_Analyzer(sewn.shape, true, false));
      report.valid = chk.IsValid();
      const gp = T(new oc.GProp_GProps());
      oc.BRepGProp.VolumeProperties(sewn.shape, gp, false, false, false);
      report.volume = gp.Mass();
      if (!report.valid) fail(t('form.brep.invalid'));
      if (!(report.volume > 0)) fail(t('form.brep.no_volume'));
    }
    const faceInfo = pr.patches.map((p) => ({ root: p.root, exact: p.exact }));
    if (T0) {
      const seen = new Map();
      const faceMap = faces.map((f, i) => {
        const root = pr.patches[i].root;
        const k = seen.get(root) || 0;
        seen.set(root, k + 1);
        const m = T(sewn.sew.Modified(f));
        return { face: m.IsNull() ? f : m, root, k };
      });
      return { shape: sewn.shape, closed: sewn.closed, faces: faceInfo, faceMap, report };
    }
    const shape = sewn.shape.Oriented(sewn.shape.Orientation());
    return { shape, closed: sewn.closed, faces: faceInfo, report };
  } finally {
    for (const o of live) { try { if (!o.isDeleted || !o.isDeleted()) o.delete(); } catch { /* gone */ } }
  }
}

/** Plain text of the conversion report, for the panel and the help: what is exact and what is approximate. */
export function describeReport(r) {
  if (!r.approx) return t('form.report.exact', { patches: r.patches, level: r.level });
  return t('form.report.approx', { patches: r.patches, level: r.level, exact: r.exact, approx: r.approx, n: r.irregular, deg: +r.deg.toFixed(2) });
}
