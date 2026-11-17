/* SPDX-License-Identifier: Apache-2.0 */
/**
 * stdparts.js — parametric part templates for mechanical standard parts (0.5 MQ.4). DOM-free: Node runs it
 * (tools/partcraft-test/test-stdparts.mjs). The sizes come from shapes/parts.js, a byte-identical copy of the site's
 * lib/shapes/parts.js (tools/shapes/sync.mjs) — the same tables CadCraft's Standard tab and the library's
 * items/standard-parts are made from.
 *
 *   TEMPLATES                     [{ id (= parts.js family id), name, standard, params: [names] }] — the families with a
 *                                 template (not spur gears: PartCraft has no involute gear feature, and a toothless disc
 *                                 would not be a gear)
 *   templateSizes(id)             → [{ size, name }] the sizes (configurations) a template has
 *   makeTemplate(id, size)        → a part (part.js shape): fully constrained sketches whose dimensions are driven by
 *                                 parameters, one configuration per size of the table (configs.js rows), the chosen
 *                                 size active. Open it with P.toJSON → openText, like any part file.
 *
 * What each template models (mm, Y up; threads are not modelled, as the drawing convention leaves them out):
 *   hex bolts / screws (ISO 4017, ISO 4014, ASME B18.2.1)  head: hexagon across flats `s`, `k` high, up from the top plane;
 *                                                          shank: Ø`d`, `l` long, down from it
 *   hex nuts (ISO 4032, ASME B18.2.2)                       hexagon `s` with a Ø`d` hole (the thread's nominal size), `height` (m)
 *   plain washers (ISO 7089)                                ring Ø`d2` / Ø`d1`, `h` thick
 *   parallel pins (ISO 2338)                                Ø`d` × `l` (the end chamfers are left out)
 *   deep groove ball bearings (ISO 15)                      the boundary envelope: ring Ø`D` / Ø`d`, `B` wide
 *   parallel keys (DIN 6885-1, form A)                      round-ended `b` × `l`, `h` high
 * The part's material is steel (7.85 g/cm³), so the mass panel and the BOM read a weight.
 */
import * as P from './part.js';
import * as S from './sketch.js';
import { addPolygon, addSlot } from './sketch-tools.js';
import { applyPartParams } from './params-part.js';
import { PART_FAMILIES, partSizes, partOptions, makePart, PART_STANDARDS } from './shapes/parts.js';

const IN = 25.4;
const num = (v) => String(Number(Number(v).toFixed(4)));
export const TEMPLATES = [
  ['iso4017', ['d', 's', 'k', 'l']], ['iso4014', ['d', 's', 'k', 'l']], ['asme-hex-bolt', ['d', 's', 'k', 'l']],
  ['iso4032', ['d', 's', 'height']], ['asme-hex-nut', ['d', 's', 'height']], ['iso7089', ['d1', 'd2', 'h']], ['iso2338', ['d', 'l']],
  ['iso15', ['d', 'D', 'B']], ['din6885', ['b', 'h', 'l']],
].map(([id, params]) => { const f = PART_FAMILIES.find((x) => x.id === id); return { id, name: f.name, standard: f.standard, title: PART_STANDARDS[f.standard].title, params }; });
export const findTemplate = (id) => TEMPLATES.find((x) => x.id === id) || null;

const TOP = { kind: 'base', name: 'top' };

/** A hexagon across flats `s` about the sketch origin, one flat along X; returns the across-flats dimension. */
function hexagon(sk, s) {
  const e = s * 2 / Math.sqrt(3);
  const poly = addPolygon(sk, [0, 0], [e / 2, 0], 6);
  const circ = sk.entities.find((x) => x.id === poly.circle);
  S.addConstraint(sk, 'coincident', [circ.c, S.ORIGIN]);
  S.addConstraint(sk, 'horizontal', [poly.lines[1]]);
  return S.addConstraint(sk, 'distance', [poly.lines[1], poly.lines[4]], s);
}
/** A circle Ø`d` about the origin; returns its diameter dimension. */
function round(sk, d) {
  const c = S.addCircle(sk, S.ORIGIN, d / 2);
  return S.addConstraint(sk, 'diameter', [c.id], d);
}

/** One configuration row per size: { name, values } in the template's parameters (mm). */
function rows(id) {
  return partSizes(id).map((z) => {
    const p = makePart(id, z.size, partOptions(id, z.size)).part, x = p.dims;
    const values = {
      iso4017: { d: x.d, s: x.s, k: x.k, l: x.l }, iso4014: { d: x.d, s: x.s, k: x.k, l: x.l }, 'asme-hex-bolt': { d: x.d, s: x.s, k: x.k, l: x.l },
      iso4032: { d: x.d, s: x.s, height: x.m }, 'asme-hex-nut': { d: x.d, s: x.s, height: x.m }, iso7089: { d1: x.d1, d2: x.d2, h: x.h },
      iso2338: { d: x.d, l: x.l }, iso15: { d: x.d, D: x.D, B: x.B }, din6885: { b: x.b, h: x.h, l: x.l },
    }[id];
    for (const k of Object.keys(values)) values[k] = Number(values[k].toFixed(4));
    return { name: p.sizeText, size: z.size, values };
  });
}

/** The sizes a template opens at: [{ size, name }] (name = the configuration's, e.g. "M10 × 40"). */
export const templateSizes = (id) => rows(id).map((r) => ({ size: r.size, name: r.name }));

/** The part for a family, set to one of its sizes (default the first). */
export function makeTemplate(id, size = null) {
  const tpl = findTemplate(id);
  if (!tpl) throw new Error('No template for ' + id);   // i18n-ignore (developer message: the UI lists only TEMPLATES)
  const all = rows(id);
  const row = all.find((r) => r.size === size) || all[0];
  const v = row.values;
  const part = P.newPart(tpl.name + ' ' + tpl.standard);
  const links = [];
  const sketch = (draw) => { const sk = S.newSketch(); const dims = draw(sk); return { f: P.addFeature(part, 'sketch', { plane: TOP, sketch: sk }), dims }; };
  const extrude = (sk, depth, expr, extra = {}) => { const f = P.addFeature(part, 'extrude', { sketch: sk.f.id, depth, ...extra }); links.push({ target: f.id + '.depth', expr }); return f; };
  const dim = (sk, c, expr) => links.push({ target: sk.f.id + '.' + c.id, expr });
  switch (id) {
    case 'iso4017': case 'iso4014': case 'asme-hex-bolt': {
      const head = sketch((sk) => ({ s: hexagon(sk, v.s) }));
      dim(head, head.dims.s, 's');
      extrude(head, v.k, 'k');
      const shank = sketch((sk) => ({ d: round(sk, v.d) }));
      dim(shank, shank.dims.d, 'd');
      extrude(shank, v.l, 'l', { reverse: true });
      break;
    }
    case 'iso4032': case 'asme-hex-nut': {
      const sk = sketch((s) => ({ s: hexagon(s, v.s), d: round(s, v.d) }));
      dim(sk, sk.dims.s, 's'); dim(sk, sk.dims.d, 'd');
      extrude(sk, v.height, 'height');   // "m" is the metre in an expression
      break;
    }
    case 'iso7089': {
      const sk = sketch((s) => ({ d2: round(s, v.d2), d1: round(s, v.d1) }));
      dim(sk, sk.dims.d2, 'd2'); dim(sk, sk.dims.d1, 'd1');
      extrude(sk, v.h, 'h');
      break;
    }
    case 'iso2338': {
      const sk = sketch((s) => ({ d: round(s, v.d) }));
      dim(sk, sk.dims.d, 'd');
      extrude(sk, v.l, 'l');
      break;
    }
    case 'iso15': {
      const sk = sketch((s) => ({ D: round(s, v.D), d: round(s, v.d) }));
      dim(sk, sk.dims.D, 'D'); dim(sk, sk.dims.d, 'd');
      extrude(sk, v.B, 'B');
      break;
    }
    case 'din6885': {
      const sk = sketch((s) => {
        const half = (v.l - v.b) / 2;
        const slot = addSlot(s, [-half, 0], [half, 0], v.b);
        const [ca, cb] = slot.centres;
        S.addConstraint(s, 'horizontal', [ca, cb]);
        // symmetric about a fixed construction line up the Y axis through the origin
        const ax = S.addLine(s, S.ORIGIN, [0, 1], { construction: true });
        S.addConstraint(s, 'vertical', [ax.id]);
        S.addConstraint(s, 'fix', [ax.p2]);
        S.addConstraint(s, 'symmetric', [ca, cb, ax.id]);
        return { len: S.addConstraint(s, 'distance', [ca, cb], v.l - v.b), r: S.addConstraint(s, 'radius', [slot.arcs[0]], v.b / 2) };
      });
      dim(sk, sk.dims.len, 'l - b'); dim(sk, sk.dims.r, 'b / 2');
      extrude(sk, v.h, 'h');
      break;
    }
  }
  part.material = { name: 'Steel', density: 7.85 };
  part.params = { vars: tpl.params.map((name) => ({ name, expr: num(v[name]) })), links };
  part.configs = { rows: all.map((r) => ({ name: r.name, values: r.values })), active: row.name };
  const res = applyPartParams(part);
  if (res && res.ok === false) throw new Error('The template does not solve: ' + (res.errors || []).map((e) => e.message).join('; '));   // i18n-ignore (developer message: the test solves every size)
  return part;
}
