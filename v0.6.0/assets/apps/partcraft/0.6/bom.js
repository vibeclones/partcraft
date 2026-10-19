/* SPDX-License-Identifier: Apache-2.0 */
/**
 * bom.js — part properties, materials and the bill of materials of an assembly (DOM-free).
 *
 *   asm.parts[pid] = { name, part, number?, description?, material?: { name, density } }   (assembly v2)
 *     number ≤ 40 characters, description ≤ 200, material name ≤ 60, density in g/cm³, 0 < ρ ≤ 25.
 *   MATERIALS  materials with nominal densities in g/cm³: materials.js's list (Simulation, sourced there) plus cast
 *              iron, brass, copper, acetal, polycarbonate and dry oak (typical handbook values; a real grade varies
 *              by a few per cent; a custom density can be typed instead).
 *   readPartProps(raw) → { number?, description?, material? }   (untrusted: files, clipboard)
 *   bomRows(asm, builds) → [{ item, pid, qty, number, name, description, material, density, volume, massEach,
 *       massTotal, exact }]   one row per part in the order it first appears; volume is the part's built volume
 *       (exact with the exact kernel, of the tessellation with the mesh kernel); masses in grams, null without a material.
 *   bomCsv(rows) → CSV text (RFC 4180: CRLF, fields with , " CR LF or edge spaces quoted, quotes doubled; text cells
 *       starting with = + - @ tab or CR get a leading ' so a spreadsheet does not run them as formulas; UTF-8 BOM).
 */
import { MATERIALS as SIM } from './materials.js';
import { t } from './i18n.js';

// Simulation's materials (materials.js: kg/m³, with their sources) first, then a few more that only need a density.
// Names are getters (materials.js's too): read from the language file where they are shown, never frozen at import.
const named = (key, density) => ({ get name() { return t(key); }, density });
export const MATERIALS = [
  ...SIM.map((m) => ({ get name() { return m.name; }, density: m.density / 1000 })),
  named('xch.bom.mat.cast_iron', 7.2),
  named('xch.bom.mat.brass', 8.5),
  named('xch.bom.mat.copper', 8.96),
  named('xch.bom.mat.acetal', 1.41),
  named('xch.bom.mat.polycarbonate', 1.2),
  named('xch.bom.mat.oak', 0.75),
];
export const MAX_DENSITY = 25;

/** The preset a part's stored material is (its index in MATERIALS), or −1. Parts store the name in the language they were
 *  saved in, so a name in another language falls back to the preset of exactly that density (no two presets share one). */
export function presetOf(material) {
  if (!material) return -1;
  const byName = MATERIALS.findIndex((m) => m.name === material.name && m.density === material.density);
  return byName >= 0 ? byName : MATERIALS.findIndex((m) => m.density === material.density && material.name !== 'Custom');   // i18n-ignore: the stored custom name
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** A material from untrusted input, or null. Throws on a bad density. */
export function readMaterial(m) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object') throw new Error(t('xch.bom.bad_material'));
  const d = m.density;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > MAX_DENSITY) throw new Error(t('xch.bom.bad_density', { max: MAX_DENSITY }));
  return { name: clean(m.name, 60) || 'Custom', density: d };
}

export function readPartProps(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (p.number !== undefined) { const v = clean(p.number, 40); if (v) out.number = v; }
  if (p.description !== undefined) { const v = clean(p.description, 200); if (v) out.description = v; }
  const m = readMaterial(p.material);
  if (m) out.material = m;
  return out;
}

/** Grams from mm³ and g/cm³. */
export const massOf = (volume, density) => volume * density / 1000;

export function bomRows(asm, builds) {
  const rows = [], byPid = new Map();
  for (const inst of asm.instances) {
    let r = byPid.get(inst.part);
    if (!r) {
      const p = asm.parts[inst.part];
      const st = builds?.get(inst.part)?.stats;
      const volume = st ? st.volume : null;
      const density = p.material ? p.material.density : null;
      r = { item: rows.length + 1, pid: inst.part, qty: 0, number: p.number || '', name: p.name, description: p.description || '', material: p.material ? p.material.name : '', density, volume, massEach: volume !== null && density !== null ? massOf(volume, density) : null, massTotal: null, exact: !!st?.exact };
      byPid.set(inst.part, r); rows.push(r);
    }
    r.qty++;
  }
  for (const r of rows) r.massTotal = r.massEach === null ? null : r.massEach * r.qty;
  return rows;
}

/** One CSV field. */
export function csvCell(v, { text = true } = {}) {
  let s = v === null || v === undefined ? '' : String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const n3 = (v) => (v === null ? '' : String(Number(v.toFixed(3))));
// i18n-ignore: CSV column headers (file content)
export const BOM_HEADER = ['Item', 'Quantity', 'Part number', 'Name', 'Description', 'Material', 'Density (g/cm³)', 'Volume each (mm³)', 'Mass each (g)', 'Mass total (g)'];

export function bomCsv(rows) {
  const lines = [BOM_HEADER.map((h) => csvCell(h)).join(',')];
  for (const r of rows) {
    lines.push([csvCell(r.item, { text: false }), csvCell(r.qty, { text: false }), csvCell(r.number), csvCell(r.name), csvCell(r.description), csvCell(r.material),
      csvCell(r.density ?? '', { text: false }), csvCell(n3(r.volume), { text: false }), csvCell(n3(r.massEach), { text: false }), csvCell(n3(r.massTotal), { text: false })].join(','));
  }
  const total = rows.every((r) => r.massTotal !== null) && rows.length ? rows.reduce((s, r) => s + r.massTotal, 0) : null;
  lines.push(['', csvCell(rows.reduce((s, r) => s + r.qty, 0), { text: false }), '', csvCell('Total'), '', '', '', '', '', csvCell(n3(total), { text: false })].join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
