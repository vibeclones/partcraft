/* SPDX-License-Identifier: Apache-2.0 */
/**
 * materials.js — isotropic linear-elastic materials for Simulation and Generative (DOM-free).
 * Units: E and yield in MPa (N/mm²), density in kg/m³ (`tonnesPerMm3` converts for the solver, whose
 * mass unit is the tonne so that N = t·mm/s²). ν is Poisson's ratio.
 *
 * Sources (typical room-temperature values; a real design uses the supplier's certified figures):
 *  - steel (ASTM A36 structural), stainless 304 (annealed), aluminium 6061-T6, Ti-6Al-4V (grade 5,
 *    annealed): ASM International / ASM Aerospace Specification Metals data sheets as published on
 *    MatWeb (asm.matweb.com): A36 E 200 GPa ν 0.26 ρ 7850 Sy 250; 304 E 193 GPa ν 0.29 ρ 8000 Sy 215;
 *    6061-T6 E 68.9 GPa ν 0.33 ρ 2700 Sy 276; Ti-6Al-4V E 113.8 GPa ν 0.342 ρ 4430 Sy 880.
 *  - ABS (injection moulded, general purpose), nylon 6/6 (unfilled, dry as moulded): MatWeb's
 *    "overview of materials" averages — ABS E 2.3 GPa ν 0.35 ρ 1050 Sy 40; PA66 E 2.9 GPa ν 0.39 ρ 1140 Sy 70.
 *  - PLA: NatureWorks Ingeo 4043D technical data sheet — tensile modulus 3.6 GPa, tensile yield 60 MPa,
 *    density 1.24 g/cm³; ν 0.36 (typical literature value, not on the sheet).
 * 3D-printed plastics are anisotropic and weaker across layers (often 50–80 % of these); the solver
 * treats every material as isotropic, and the UI says so.
 *
 * Thermal (Simulation › Thermal, thermal stress): k conductivity W/(m·K), cp specific heat J/(kg·K), alpha linear expansion
 * 1/K, typical room-temperature values (they vary with temperature, temper and, for plastics, grade and crystallinity ±30 %):
 *  - stainless 304, 6061-T6, Ti-6Al-4V: the same ASM data sheets (asm.matweb.com): 304 k 16.2 cp 500 α 17.3e-6;
 *    6061-T6 k 167 cp 896 α 23.6e-6; Ti-6Al-4V k 6.7 cp 526.3 α 8.6e-6 (α over 20–100 °C).
 *  - steel: the A36 sheet gives no thermal data; these are ASM's AISI 1020 (a similar low-carbon steel): k 51.9 cp 486 α 11.7e-6.
 *  - ABS k 0.17 cp 1400 α 90e-6, nylon 6/6 k 0.25 cp 1670 α 80e-6: mid-range of the typical ranges on MatWeb's overview sheets
 *    and the Engineering ToolBox tables (thermal conductivity, specific heat, linear expansion of plastics).
 *  - PLA k 0.13 cp 1800 α 68e-6: typical literature values for unfilled PLA (NatureWorks' sheet gives none); printed parts
 *    with infill conduct less.
 * Names come from the language files (a getter, read where they are shown; ids are the data).
 */
import { t } from './i18n.js';

export const MATERIALS = [
  { id: 'steel', get name() { return t('study.mat.steel'); }, E: 200000, nu: 0.26,  density: 7850, yield: 250, k: 51.9, cp: 486,   alpha: 11.7e-6 },
  { id: 'ss304', get name() { return t('study.mat.ss304'); }, E: 193000, nu: 0.29,  density: 8000, yield: 215, k: 16.2, cp: 500,   alpha: 17.3e-6 },
  { id: 'al6061', get name() { return t('study.mat.al6061'); }, E: 68900,  nu: 0.33,  density: 2700, yield: 276, k: 167,  cp: 896,   alpha: 23.6e-6 },
  { id: 'ti64', get name() { return t('study.mat.ti64'); }, E: 113800, nu: 0.342, density: 4430, yield: 880, k: 6.7,  cp: 526.3, alpha: 8.6e-6 },
  { id: 'abs', get name() { return t('study.mat.abs'); }, E: 2300,   nu: 0.35,  density: 1050, yield: 40,  k: 0.17, cp: 1400,  alpha: 90e-6 },
  { id: 'pla', get name() { return t('study.mat.pla'); }, E: 3600,   nu: 0.36,  density: 1240, yield: 60,  k: 0.13, cp: 1800,  alpha: 68e-6 },
  { id: 'nylon', get name() { return t('study.mat.nylon'); }, E: 2900,   nu: 0.39,  density: 1140, yield: 70,  k: 0.25, cp: 1670,  alpha: 80e-6 },
];

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || null;
export const tonnesPerMm3 = (kgPerM3) => kgPerM3 * 1e-12;
export const G_MM = 9810;   // standard gravity, mm/s²

/** A custom material from untrusted input → material or throws. */
export function readMaterial(m) {
  if (typeof m === 'string') { const k = materialById(m); if (!k) throw new Error(t('study.mat.unknown')); return k; }
  if (!m || typeof m !== 'object') throw new Error(t('study.mat.missing'));
  const num = (v, lo, hi, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(t('study.mat.range.' + what)); return v; };
  const out = {
    id: 'custom', name: typeof m.name === 'string' ? m.name.slice(0, 60) : t('study.mat.custom'),
    E: num(m.E, 1, 2e6, 'e'), nu: num(m.nu, 0, 0.49, 'nu'), density: num(m.density, 1, 30000, 'density'), yield: num(m.yield, 0.01, 1e5, 'yield'),
  };
  // thermal properties are optional on a custom material (a thermal study asks for them)
  if (m.k !== undefined && m.k !== null) out.k = num(m.k, 1e-3, 5000, 'k');
  if (m.cp !== undefined && m.cp !== null) out.cp = num(m.cp, 1, 1e5, 'cp');
  if (m.alpha !== undefined && m.alpha !== null) out.alpha = num(m.alpha, 0, 1e-3, 'alpha');
  const lib = typeof m.id === 'string' ? materialById(m.id) : null;   // a library material passed as an object keeps its id
  if (lib && ['E', 'nu', 'density', 'yield'].every((k) => lib[k] === out[k])) { out.id = lib.id; out.name = lib.name; for (const k of ['k', 'cp', 'alpha']) if (out[k] === undefined) out[k] = lib[k]; }
  return out;
}
