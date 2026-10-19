/* SPDX-License-Identifier: Apache-2.0 */
/**
 * configs.js — configurations: design-table rows saved in the part (0.4 P18; DOM-free, no part.js import).
 *
 *   part.configs (optional, file version 3; absent when there are no rows):
 *     { rows: [{ name, values: { <parameter name>: number } }], active: <row name> | null }
 *   A row holds values for the part's driving parameters (plain numbers, params.js isDriving); applying it sets those
 *   parameters (applyOverrides) and marks it active. Equations and formula parameters follow as usual.
 *
 *   readConfigs(raw, params)       untrusted file data → clean configs, or null (no rows); throws Error in words
 *   rowFromCurrent(params, name)   { name, values } of every driving parameter's current value
 *   saveRow(cfg, row)              add, or replace the row of that name → cfg
 *   applyRow(params, row)          the parameters take the row's values (throws for a parameter the part lacks)
 *   rowMatches(params, row)        do the current values equal the row's? (the active row is "changed" when not)
 *   renameRow / deleteRow          → cfg (null when the last row goes)
 *   followParams(cfg, before, after)  after a parameter edit: renamed parameters carry their values, deleted ones drop out
 *   rowsFromTable(csv, params)     a CSV design table (params.js readDesignTable) → rows
 *   configsCsv(cfg, params)        the rows as CSV (name + one column per parameter any row sets)
 */
import { readDesignTable, isDriving, evaluateVars } from './params.js';
import { formatNumber } from './expr.js';
import { t } from './i18n.js';

export const CONFIG_MAX_ROWS = 500;
export const CONFIG_NAME_MAX = 60;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export const cleanName = (s) => String(s ?? '').replace(CONTROL, '').trim().slice(0, CONFIG_NAME_MAX);
const varNames = (params) => new Set((params?.vars || []).map((v) => v.name));

export function readConfigs(raw, params) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || !Array.isArray(raw.rows) || raw.rows.length > CONFIG_MAX_ROWS) throw new Error(t('configs.err.list'));
  const names = varNames(params), seen = new Set(), rows = [];
  for (const r of raw.rows) {
    const name = r && typeof r.name === 'string' ? cleanName(r.name) : '';
    if (!name || seen.has(name.toLowerCase())) throw new Error(t('configs.err.name'));
    seen.add(name.toLowerCase());
    if (!r.values || typeof r.values !== 'object' || Array.isArray(r.values)) throw new Error(t('configs.err.values', { name }));
    const values = {};
    for (const [k, v] of Object.entries(r.values)) {
      if (!names.has(k)) throw new Error(t('configs.err.unknown', { name, param: String(k).slice(0, 40) }));
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(t('configs.err.number', { name, param: k }));
      values[k] = v;
    }
    rows.push({ name, values });
  }
  if (!rows.length) return null;
  const active = typeof raw.active === 'string' && rows.some((r) => r.name === raw.active) ? raw.active : null;
  return { rows, active };
}

export function rowFromCurrent(params, name) {
  const vals = evaluateVars(params).values, values = {};
  for (const v of params?.vars || []) if (isDriving(v) && Number.isFinite(vals.get(v.name))) values[v.name] = vals.get(v.name);
  return { name: cleanName(name), values };
}

export function saveRow(cfg, row) {
  const out = cfg ? { rows: cfg.rows.map((r) => ({ name: r.name, values: { ...r.values } })), active: cfg.active } : { rows: [], active: null };
  const i = out.rows.findIndex((r) => r.name.toLowerCase() === row.name.toLowerCase());
  if (i >= 0) out.rows[i] = { name: out.rows[i].name, values: { ...row.values } };
  else { if (out.rows.length >= CONFIG_MAX_ROWS) throw new Error(t('configs.err.many', { n: CONFIG_MAX_ROWS })); out.rows.push({ name: row.name, values: { ...row.values } }); }
  return out;
}

export function applyRow(params, row) {
  for (const [k, v] of Object.entries(row.values)) {
    const w = (params?.vars || []).find((x) => x.name === k);
    if (!w) throw new Error(t('configs.err.missing', { name: row.name, param: k }));
    w.expr = formatNumber(v);
  }
}

export function rowMatches(params, row) {
  const vals = evaluateVars(params).values;
  return Object.entries(row.values).every(([k, v]) => { const c = vals.get(k); return Number.isFinite(c) && Math.abs(c - v) <= 1e-12 * Math.max(1, Math.abs(v)); });
}

export function renameRow(cfg, from, to) {
  const name = cleanName(to);
  if (!name) throw new Error(t('configs.err.name'));
  if (cfg.rows.some((r) => r.name !== from && r.name.toLowerCase() === name.toLowerCase())) throw new Error(t('configs.err.taken', { name }));
  return { rows: cfg.rows.map((r) => (r.name === from ? { name, values: { ...r.values } } : { name: r.name, values: { ...r.values } })), active: cfg.active === from ? name : cfg.active };
}

export function deleteRow(cfg, name) {
  const rows = cfg.rows.filter((r) => r.name !== name).map((r) => ({ name: r.name, values: { ...r.values } }));
  return rows.length ? { rows, active: cfg.active === name ? null : cfg.active } : null;
}

/** Parameters renamed in place (same position, new name) carry their values; values of parameters that are gone drop. */
export function followParams(cfg, before, after) {
  if (!cfg) return null;
  const b = before?.vars || [], a = after?.vars || [];
  const ren = new Map();
  if (b.length === a.length) b.forEach((v, i) => { if (v.name !== a[i].name) ren.set(v.name, a[i].name); });
  const names = varNames(after);
  const rows = cfg.rows.map((r) => {
    const values = {};
    for (const [k, v] of Object.entries(r.values)) { const n = ren.get(k) || k; if (names.has(n)) values[n] = v; }
    return { name: r.name, values };
  });
  return { rows, active: cfg.active };
}

export function rowsFromTable(csv, params) {
  const r = readDesignTable(csv, params);
  if (!r.ok) throw new Error(r.error);
  return r.rows.map((row) => ({ name: cleanName(row.name), values: Object.fromEntries(row.overrides) }));
}

export function configsCsv(cfg) {
  const cols = [];
  for (const r of cfg?.rows || []) for (const k of Object.keys(r.values)) if (!cols.includes(k)) cols.push(k);
  // a name a spreadsheet would read as a formula gets a leading ' (as every CSV PartCraft writes)
  const cell = (s) => { let x = String(s); if (/^[=+\-@]/.test(x) && !/^-?\d/.test(x)) x = "'" + x; return /[",;\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const lines = [['name', ...cols], ...(cfg?.rows || []).map((r) => [r.name, ...cols.map((c) => (r.values[c] === undefined ? '' : formatNumber(r.values[c])))])];
  return lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}
