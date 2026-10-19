/* SPDX-License-Identifier: Apache-2.0 */
/**
 * params-uses.js — where each parameter is used (0.5 WL.30; DOM-free, no part.js import).
 *
 *   paramUses(part) → Map(name → {
 *     direct:  [{ target, label, feature, kind: 'feature' | 'dimension' }]   equations that name it
 *     via:     [{ target, label, feature, kind, through: [parameter names] }] equations that use it through other parameters
 *     vars:    [names]               parameters whose value is a formula of it
 *     configs: [row names]           configurations that set it
 *     scripts: [{ name, all }]       the part's scripts that read it (all: the script calls params(), so it reads every one)
 *   })
 *   scriptParams(text) → { names: [parameter names the script reads with param('name')], all: reads them all (params()) }
 *   usesCount(u) → how many places use it (0 = unused)
 *
 * Scripts are read as text, never run: `param('width')` (any quotes, any language: CraftScript, Lua's cs.param, Python) names
 * one parameter; `params()` reads every one. A name built at run time (param(name)) is not found.
 */
import { parse } from './expr.js';
import { partAdapter } from './params-part.js';

const PARAM_CALL = /\bparam\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]{0,39})\1\s*\)/g;
const PARAMS_CALL = /\bparams\s*\(\s*\)/;

export function scriptParams(text) {
  const s = String(text ?? ''), names = [];
  for (const m of s.matchAll(PARAM_CALL)) if (!names.includes(m[2])) names.push(m[2]);
  return { names, all: PARAMS_CALL.test(s) };
}

export function paramUses(part) {
  const p = part.params || { vars: [], links: [] };
  const out = new Map(p.vars.map((v) => [v.name, { direct: [], via: [], vars: [], configs: [], scripts: [] }]));
  if (!out.size) return out;
  const names = [...out.keys()];
  const usesOfExpr = (src) => { const r = parse(src, null); return r.ok ? r.uses.filter((n) => out.has(n)) : []; };
  // parameter → the parameters its formula uses (direct)
  const deps = new Map(p.vars.map((v) => [v.name, usesOfExpr(v.expr)]));
  for (const [n, ds] of deps) for (const d of ds) if (d !== n && !out.get(d).vars.includes(n)) out.get(d).vars.push(n);
  // everything a parameter reaches upward: the parameters built on it, through any chain (cycles are stopped)
  const above = (name) => {
    const seen = new Map(), stack = [[name, []]];
    while (stack.length) {
      const [n, path] = stack.pop();
      for (const up of out.get(n).vars) if (up !== name && !seen.has(up)) { seen.set(up, [...path, up]); stack.push([up, [...path, up]]); }
    }
    return seen;   // name → the chain from `name` up to it
  };
  const tg = partAdapter.targets(part);
  const describe = (target) => {
    const t = tg.get(target);
    return { target, label: t?.label ?? target, feature: t?.feature ?? null, kind: t?.constraint ? 'dimension' : 'feature' };
  };
  const linkUses = p.links.map((l) => ({ l, uses: usesOfExpr(l.expr) }));
  for (const name of names) {
    const u = out.get(name);
    for (const { l, uses } of linkUses) if (uses.includes(name)) u.direct.push(describe(l.target));
    const up = above(name);
    for (const { l, uses } of linkUses) {
      if (uses.includes(name)) continue;
      const via = uses.find((n) => up.has(n));
      if (via) u.via.push({ ...describe(l.target), through: up.get(via) });
    }
  }
  for (const row of part.configs?.rows || []) for (const n of Object.keys(row.values || {})) if (out.has(n)) out.get(n).configs.push(row.name);
  for (const s of part.studies?.script?.scripts || []) {
    const r = scriptParams(s.text);
    for (const n of names) if (r.all || r.names.includes(n)) out.get(n).scripts.push({ name: s.name, all: r.all && !r.names.includes(n) });
  }
  return out;
}

export const usesCount = (u) => (u ? u.direct.length + u.via.length + u.vars.length + u.configs.length + u.scripts.length : 0);
