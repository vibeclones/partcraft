/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-xcaf.js — STEP through OpenCascade's XCAF document (DOM-free; the OCCT module is passed in): the solid as a
 * named, coloured product in millimetres — what a part modeler shows as the part's name and colour on import.
 * Written for SolidWorks: Y up (SolidWorks' world is Y up like PartCraft's, so the STEP lands where the macro builds
 * the native part); `up: 'z'` writes Z up like brep.js stepText.
 *
 *   xcafStepText(oc, shape, { name, color '#rrggbb', schema 'AP214'|'AP242', up 'y'|'z' }) → STEP text
 *   exportXcafStep(part, oc, opts) → { text, volume (mm³), name, color }
 *   DEFAULT_COLOR  the light theme's body colour in the 3D view
 *
 * Classes (all in the vendored replicad-opencascadejs build): TDocStd_Document ('MDTV-XCAF'), XCAFDoc_DocumentTool
 * ShapeTool/ColorTool, XCAFDoc_ShapeTool.AddShape, TDataStd_Name.Set (product name), Quantity_Color.ColorFromHex,
 * XCAFDoc_ColorTool.SetColor (XCAFDoc_ColorSurf), STEPCAFControl_Writer (ColorMode, NameMode, Perform),
 * Interface_Static write.step.schema / write.step.unit. (XCAFDoc_LengthUnit is not bound in this build:
 * write.step.unit = MM carries the unit.)
 *
 * Worker ops (worker-ops.js; brep-worker.js imports this module):
 *   swExport { part, name?, schema?, color? } → { swb: { text, notes, stats }, step: { text, volume } | null, stepError }
 *     the macro (swmacro.js, with an exact regen per step for face/edge picks and the body checks) and the STEP beside it
 *   swImport { json } → { part, report }   swimport.js fromSwExport with this worker's OpenCascade
 */
import { regenerateBrep, Y_TO_Z } from './brep.js';
import { partToSwb } from './swmacro.js';
import { fromSwExport } from './swimport.js';
import { addOps } from './worker-ops.js';
import { t } from './i18n.js';

export const DEFAULT_COLOR = '#c8ced6';
const HEX = /^#[0-9a-fA-F]{6}$/;

function arena() {
  const live = [];
  const T = (o) => { if (o && typeof o.delete === 'function') live.push(o); return o; };
  T.free = () => { for (const o of live.reverse()) { try { o.delete(); } catch { /* gone */ } } live.length = 0; };
  return T;
}

/**
 * The product name as plain ASCII: OCCT writes other characters as raw UTF-8 (not STEP's \X2\ escapes), which
 * readers decode differently; accents are dropped (é → e), anything else becomes "_".
 */
export function productName(name) {
  const s = String(name || 'Part').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/'/g, '_').trim().slice(0, 120);
  return s || 'Part';
}

/** STEP text of one solid (or compound) as a named, coloured XCAF product. */
export function xcafStepText(oc, shape, { name = 'Part', color = DEFAULT_COLOR, schema = 'AP214', up = 'y' } = {}) {
  const T = arena();
  const path = '/xcaf-' + Math.random().toString(36).slice(2) + '.step';
  let doc = null;
  try {
    const writer = T(new oc.STEPCAFControl_Writer());   // makes the STEP statics exist before they are set
    oc.Interface_Static.SetCVal('write.step.schema', schema === 'AP242' ? 'AP242DIS' : 'AP214IS');
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    let s = shape;
    if (up === 'z') {
      const t = T(new oc.gp_Trsf());
      const m = Y_TO_Z;
      t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
      s = T(T(new oc.BRepBuilderAPI_Transform(shape, t, true)).Shape());
    }
    doc = new oc.TDocStd_Document(T(new oc.TCollection_ExtendedString('MDTV-XCAF')));
    const main = T(doc.Main());
    const shapes = T(oc.XCAFDoc_DocumentTool.ShapeTool(main));
    const colors = T(oc.XCAFDoc_DocumentTool.ColorTool(main));
    const label = T(shapes.AddShape(s, false, true));
    const clean = productName(name);
    oc.TDataStd_Name.Set(label, T(new oc.TCollection_ExtendedString(clean, true)));
    const col = T(new oc.Quantity_Color());
    if (!oc.Quantity_Color.ColorFromHex(HEX.test(color) ? color : DEFAULT_COLOR, col)) throw new Error(t('xch.step.colour_failed'));
    colors.SetColor(label, col, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    writer.SetColorMode(true);
    writer.SetNameMode(true);
    if (!writer.Perform(doc, path, T(new oc.Message_ProgressRange()))) throw new Error(t('xch.step.writer_failed'));
    return oc.FS.readFile(path, { encoding: 'utf8' });
  } finally {
    try { oc.FS.unlink(path); } catch { /* not written */ }
    T.free();
    try { doc?.delete(); } catch { /* gone */ }
  }
}

/** Rebuild with the exact kernel and write the named, coloured STEP. Throws Error when there is no solid. */
export function exportXcafStep(part, oc, opts = {}) {
  const r = regenerateBrep(part, oc, { keep: true, noMesh: true });
  if (!r.shape) throw new Error(t('xch.step.no_solid'));
  const name = opts.name || part.name || 'Part';
  const color = HEX.test(opts.color || '') ? opts.color : DEFAULT_COLOR;
  try {
    const text = xcafStepText(oc, r.shape, { ...opts, name, color });
    const g = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(r.shape, g, false, false, false);
    const volume = g.Mass();
    g.delete();
    return { text, volume, name, color };
  } finally { r.shape.delete(); }
}

/** The macro with an exact regen for every step (cached), and the whole part's regen for its final volume. */
export function swbWithKernel(part, oc, opts = {}) {
  const copy = JSON.parse(JSON.stringify(part));
  const cache = new Map();
  const regenAt = (i) => {
    if (!cache.has(i)) cache.set(i, regenerateBrep(JSON.parse(JSON.stringify(copy)), oc, { upTo: i }));
    return cache.get(i);
  };
  const regen = regenerateBrep(JSON.parse(JSON.stringify(copy)), oc);
  return partToSwb(copy, { ...opts, regen, regenAt });
}

addOps({
  swExport({ part, name, schema = 'AP214', color }, { oc }) {
    const base = name || part.name || 'Part';
    let step = null, stepError = null;
    try { step = exportXcafStep(part, oc, { name: base, schema, color }); } catch (e) { stepError = e.message; }
    const swb = swbWithKernel(part, oc, { name: base, stepFile: base + '.step' });
    return { swb, step, stepError };
  },
  swImport({ json }, { oc }) { return fromSwExport(json, { oc }); },
});
