/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-draw.js — drawing views of the exact solid with OpenCascade's hidden-line removal (HLRBRep),
 * DOM-free. Each view is a parallel projection: sharp edges and the silhouettes ("outlines") of
 * curved faces, split by OCCT into visible and hidden parts, as 2D segments in model millimetres
 * (u to the view's right, v up). drawing.js lays the views out on the sheet.
 *
 *   drawingViews(part, oc, drawing) → { views: { front, top, right, iso, section? }, exact: true }
 *     view = { visible: [[u1,v1,u2,v2]…], hidden: […], box: { u0, v0, u1, v1 } }
 *     section (when drawing.section is set): the solid cut by a plane square to the chosen view's
 *       direction, the near half taken away (BRepAlgoAPI_Cut with a box), the rest projected the same
 *       way; `cut` = the boundary segments of the faces lying in the cutting plane (drawing.js hatches
 *       them), `line` = the cutting plane's trace for the view where it is seen edge-on.
 */
import * as V from './vec.js';
import { regenerateBrep } from './brep.js';
import { VIEWS, SECTION_TRACE } from './drawing.js';
import { t as tr } from './i18n.js';

function arena() {
  const live = [];
  const T = (o) => { if (o && typeof o.delete === 'function') live.push(o); return o; };
  T.free = () => { for (const o of live) { try { o.delete(); } catch { /* gone */ } } live.length = 0; };
  return T;
}

const edgesOf = (oc, T, s) => {
  const out = [];
  if (!s || s.IsNull()) return out;
  const ex = T(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) out.push(T(oc.TopoDS.Edge(T(ex.Current()))));
  return out;
};

/**
 * Points along an edge: the two ends of a straight one; for curves, even steps in the parameter
 * (at least every 3°-ish of a circle) with the points that sit on a straight run dropped again.
 */
function edgePoints(oc, T, e, size) {
  const c = T(new oc.BRepAdaptor_Curve(e));
  const t0 = c.FirstParameter(), t1 = c.LastParameter();
  const P = (t) => { const p = T(c.EvalD0(t)); return [p.X(), p.Y(), p.Z()]; };
  if (c.GetType() === 'GeomAbs_Line') return [P(t0), P(t1)];
  const n = c.GetType() === 'GeomAbs_Circle' ? Math.max(8, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 60))) : 96;
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(P(t0 + (t1 - t0) * i / n));
  const tol = size * 1e-7;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i + 1], p = pts[i];
    const ab = V.sub(b, a), l = V.len(ab);
    const off = l > 0 ? V.len(V.cross(V.sub(p, a), ab)) / l : V.len(V.sub(p, a));
    if (off > tol) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function hlr(oc, T, shape, view, size) {
  const algo = T(new oc.HLRBRep_Algo());
  algo.Add(shape, 0);
  const ax = T(new oc.gp_Ax2(T(new oc.gp_Pnt(0, 0, 0)), T(new oc.gp_Dir(...view.dir)), T(new oc.gp_Dir(...view.right))));
  algo.Projector(T(new oc.HLRAlgo_Projector(ax)));
  algo.Update();
  algo.Hide();
  const h = T(new oc.HLRBRep_HLRToShape(algo));
  const segs = (compounds) => {
    const out = [];
    for (const s of compounds) {
      T(s);
      if (s.IsNull()) continue;
      oc.BRepLib.BuildCurves3d(s);   // HLR edges come with 2D curves only
      for (const e of edgesOf(oc, T, s)) {
        const pts = edgePoints(oc, T, e, size);
        for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
      }
    }
    return out;
  };
  const visible = segs([h.VCompound(), h.OutLineVCompound()]);
  const hidden = segs([h.HCompound(), h.OutLineHCompound()]);
  return { visible, hidden };
}

/** Extents of a shape seen along a view (from its exact bounding box corners, then the drawn segments). */
function boxOf(segs) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const s of segs) { u0 = Math.min(u0, s[0], s[2]); u1 = Math.max(u1, s[0], s[2]); v0 = Math.min(v0, s[1], s[3]); v1 = Math.max(v1, s[1], s[3]); }
  if (u0 === Infinity) return { u0: 0, v0: 0, u1: 1, v1: 1 };
  return { u0, v0, u1, v1 };
}

/** The views of the part's solid. Throws Error when there is no solid. */
export function drawingViews(part, oc, drawing = {}) {
  const r = regenerateBrep(part, oc, { keep: true, noMesh: true });
  if (!r.shape) throw new Error(tr('model.brep_draw.no_solid'));
  const T = arena();
  try {
    const shape = T(r.shape);
    const bb = T(new oc.Bnd_Box());
    oc.BRepBndLib.AddOptimal(shape, bb, false, false);
    const min = [bb.GetXMin(), bb.GetYMin(), bb.GetZMin()], max = [bb.GetXMax(), bb.GetYMax(), bb.GetZMax()];
    const size = Math.max(1e-6, V.len(V.sub(max, min)));
    const views = {};
    for (const k of ['front', 'top', 'right', 'iso']) {
      const v = hlr(oc, T, shape, VIEWS[k], size);
      views[k] = { ...v, box: boxOf(v.visible.concat(v.hidden)) };
    }
    const sec = drawing.section;
    if (sec && VIEWS[sec.of]) {
      const view = VIEWS[sec.of];
      const centre = V.mul(V.add(min, max), 0.5);
      const at = Number.isFinite(sec.at) ? sec.at : V.dot(centre, view.dir);
      const o = V.add(V.sub(centre, V.mul(view.dir, V.dot(centre, view.dir))), V.mul(view.dir, at));
      // a box on the viewer's side of the plane, larger than the part
      const big = size * 2 + 10;
      const ax = T(new oc.gp_Ax2(T(new oc.gp_Pnt(...V.sub(V.sub(o, V.mul(view.right, big)), V.mul(view.up, big)))), T(new oc.gp_Dir(...view.dir)), T(new oc.gp_Dir(...view.right))));
      const box = T(T(new oc.BRepPrimAPI_MakeBox(ax, 2 * big, 2 * big, big)).Shape());
      const cut = T(new oc.BRepAlgoAPI_Cut(shape, box, T(new oc.Message_ProgressRange())));
      const rest = T(cut.Shape());
      cut.Clear();
      const v = hlr(oc, T, rest, view, size);
      // faces in the cutting plane: their edges bound the hatched area
      const cutSegs = [];
      const ex = T(new oc.TopExp_Explorer(rest, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        const F = T(oc.TopoDS.Face(T(ex.Current())));
        const ad = T(new oc.BRepAdaptor_Surface(F, true));
        if (ad.GetType() !== 'GeomAbs_Plane') continue;
        const pl = T(ad.Plane());
        const n = T(T(pl.Axis()).Direction());
        const p = T(pl.Location());
        if (Math.abs(Math.abs(V.dot([n.X(), n.Y(), n.Z()], view.dir)) - 1) > 1e-9) continue;
        if (Math.abs(V.dot(V.sub([p.X(), p.Y(), p.Z()], o), view.dir)) > 1e-6 * size) continue;
        for (const e of edgesOf(oc, T, F)) {
          const pts = edgePoints(oc, T, e, size).map((q) => [V.dot(q, view.right), V.dot(q, view.up)]);
          for (let i = 0; i + 1 < pts.length; i++) cutSegs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
        }
      }
      // where the plane shows edge-on: its trace in the neighbouring view (drawing.js draws the cutting-plane line there)
      const traceView = SECTION_TRACE[sec.of];
      const tv = VIEWS[traceView];
      const tb = views[traceView].box;
      // the plane's points project onto a line in that view: the direction in the plane square to the view's own direction
      const along = V.norm(V.cross(view.dir, tv.dir));
      const p0 = [V.dot(o, tv.right), V.dot(o, tv.up)];
      const d2 = [V.dot(along, tv.right), V.dot(along, tv.up)];
      const sight = [V.dot(V.mul(view.dir, -1), tv.right), V.dot(V.mul(view.dir, -1), tv.up)];
      views.section = { visible: v.visible, hidden: [], cut: cutSegs, box: boxOf(v.visible.concat(cutSegs)), of: sec.of, at, trace: { view: traceView, p: p0, d: d2, sight, box: tb } };
    }
    // tapped holes (cosmetic threads): their callouts go on the sheet as notes
    const threads = [...(r.threads || new Map()).values()].map((t) => ({ callout: t.callout, count: t.list.length }));
    return { views, exact: true, bbox: { min, max }, threads };
  } finally {
    T.free();
  }
}
