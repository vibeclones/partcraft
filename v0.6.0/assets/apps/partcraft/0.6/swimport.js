/* SPDX-License-Identifier: Apache-2.0 */
/**
 * swimport.js — a `cadcraft-sw-export` v1 file (written inside SolidWorks by tools/partcraft-sw/CadCraftExport.swb)
 * → a PartCraft part rebuilt feature by feature with the exact kernel (DOM-free; OpenCascade passed in).
 *
 *   readSwExport(raw) → a clean copy of the file, or throws Error with a plain message (untrusted input: every field
 *                       type- and range-checked, sizes limited, unknown feature kinds kept as "unsupported").
 *   fromSwExport(raw, { oc }) → { part, report }
 *     part    a valid PartCraft part (it has been through part.js readPart), params included
 *     report  { carried: [names], notCarried: [{ name, why }], warnings: [text], volume: { partcraft, solidworks,
 *               same } | null, lines: [plain sentences for the UI] }
 *
 * How it maps (the format block in docs/PARAMETRIC-SPEC.md):
 *   sketch    on a base plane when its plane is one (through the origin, normal along X, Y or Z); else on a named flat
 *             face of the part built so far when one lies in that plane (so it follows later edits); else on a fixed
 *             plane. Points are moved from SolidWorks' sketch frame into PartCraft's (world coordinates in between),
 *             arcs swapped when the two frames face opposite ways. Relations and dimensions become PartCraft's;
 *             horizontal/vertical ones swap or are left out (reported) when the frames' axes differ.
 *   extrude, revolve, fillet, chamfer, shell, linear/circular pattern, mirror: as the format says; edges and faces are
 *             found from their "at" points: the nearest edge (OCCT's edge polylines) or face (triangles) of the exact
 *             model built so far, turned into named EdgeRef/FaceRef so they survive edits.
 *   globals → parameters (names made PartCraft-safe), equations → links; a dimension used inside another equation
 *             becomes a parameter of its own. Anything without a counterpart is listed, never guessed.
 */
import * as V from './vec.js';
import * as S from './sketch.js';
import * as P from './part.js';
import { solveSketch } from './solver.js';
import { regenerateBrep, edgeRef, faceRef, refForName } from './brep.js';
import { parse, evaluate, NAME_RE, RESERVED, formatNumber } from './expr.js';
import { evaluateVars } from './params.js';
import { partAdapter } from './params-part.js';
import { t } from './i18n.js';

export const FORMAT = 'cadcraft-sw-export';
export const VERSION = 1;
export const LIMITS = Object.freeze({ bytes: 50 * 1024 * 1024, features: 2000, entities: 20000, constraints: 20000, globals: 500, equations: 4000, edges: 2000, coord: 1e7, text: 1000 });
const KNOWN = new Set(['sketch', 'extrude', 'revolve', 'fillet', 'chamfer', 'shell', 'lpattern', 'cpattern', 'mirror', 'unsupported']);
const ID = /^[A-Za-z0-9_.:@#-]{1,60}$/;
const RELS = new Set(['horizontal', 'vertical', 'coincident', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'fix', 'collinear', 'symmetric']);
const DIMS = new Set(['distance', 'hdistance', 'vdistance', 'radius', 'diameter', 'angle']);

// ---------------------------------------------------------------- reading the untrusted file

// A problem's "what" is a language-file key, or { key, fills } (fills may hold such objects too): it is only read when
// the error is thrown, so the checks below cost nothing when the file is fine.
const say = (w) => (typeof w === 'string' ? t(w) : t(w.key, Object.fromEntries(Object.entries(w.fills || {}).map(([k, v]) => [k, v && typeof v === 'object' ? say(v) : v]))));
const W = (key, fills) => ({ key, fills });
const asW = (w) => (typeof w === 'string' ? W(w) : w);   // a key given as a fill must be looked up too
const of = (name, what) => W('xch.swimp.of', { name, what: asW(what) });
const bad = (what) => { throw new Error(t('xch.swimp.invalid', { what: say(what) })); };
const txt = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const isNum = (v, lim = LIMITS.coord) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const vec3 = (v, what) => { if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => isNum(x))) bad(what); return [+v[0], +v[1], +v[2]]; };
const dir3 = (v, what) => { const d = vec3(v, what); if (V.len(d) < 1e-12) bad(what); return d; };
const str = (v, what, max = 120) => { if (typeof v !== 'string' || !v.length || v.length > max) bad(what); return txt(v, max); };
const id = (v, what) => { if (typeof v !== 'string' || !ID.test(v)) bad(what); return v; };
const arr = (v, what, max) => { if (!Array.isArray(v) || v.length > max) bad(what); return v; };

/** A clean copy of an export file (string or object), or throws Error with a plain message. */
export function readSwExport(raw) {
  let j = raw;
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.bytes) throw new Error(t('xch.swimp.too_big'));
    try { j = JSON.parse(raw); } catch { throw new Error(t('xch.swimp.not_json')); }
  }
  if (!j || typeof j !== 'object' || j.format !== FORMAT) throw new Error(t('xch.swimp.not_export'));
  if (!Number.isInteger(j.version) || j.version < 1) bad('xch.swimp.what.no_version');
  if (j.version > VERSION) throw new Error(t('xch.swimp.newer', { version: j.version, reads: VERSION }));
  if (j.units !== 'mm') bad('xch.swimp.what.units');
  const out = { format: FORMAT, version: 1, units: 'mm', name: txt(j.name) || 'Part', source: {}, globals: [], equations: [], features: [] };
  if (j.source && typeof j.source === 'object') for (const k of ['app', 'appVersion', 'file', 'exported']) if (typeof j.source[k] === 'string') out.source[k] = txt(j.source[k], 260);
  for (const g of arr(j.globals ?? [], 'xch.swimp.what.globals', LIMITS.globals)) {
    if (!g || typeof g !== 'object') bad('xch.swimp.what.global');
    out.globals.push({ name: str(g.name, 'xch.swimp.what.global_name'), expr: str(String(g.expr ?? ''), W('xch.swimp.what.global_value', { name: txt(g.name, 40) }), LIMITS.text) });
  }
  for (const e of arr(j.equations ?? [], 'xch.swimp.what.equations', LIMITS.equations)) {
    if (!e || typeof e !== 'object') bad('xch.swimp.what.equation');
    out.equations.push({ lhs: str(e.lhs, 'xch.swimp.what.equation', 200), rhs: str(String(e.rhs ?? ''), 'xch.swimp.what.equation', LIMITS.text), ...(typeof e.raw === 'string' ? { raw: txt(e.raw, LIMITS.text) } : {}) });
  }
  if (j.check && typeof j.check === 'object' && isNum(j.check.volume, 1e21) && j.check.volume >= 0) out.check = { volume: j.check.volume };
  const names = new Set();
  for (const f of arr(j.features, 'xch.swimp.what.features', LIMITS.features)) {
    if (!f || typeof f !== 'object') bad('xch.swimp.what.feature');
    const g = { name: str(f.name, 'xch.swimp.what.feature_name'), type: typeof f.type === 'string' && KNOWN.has(f.type) ? f.type : 'unsupported' };
    if (names.has(g.name)) bad(W('xch.swimp.what.same_name', { name: g.name }));
    names.add(g.name);
    if (f.suppressed === true) g.suppressed = true;
    if (g.type === 'unsupported') { g.swType = txt(f.swType ?? f.type, 40) || 'unknown'; if (typeof f.why === 'string') g.why = txt(f.why, 200); out.features.push(g); continue; }
    const need = (c, what) => { if (!c) bad(of(g.name, what)); };
    const dims = (allowed) => {
      const d = {};
      if (f.dims && typeof f.dims === 'object') for (const k of allowed) if (typeof f.dims[k] === 'string' && f.dims[k].length <= 200) d[k] = txt(f.dims[k], 200);
      return d;
    };
    switch (g.type) {
      case 'sketch': readSketchFeature(f, g, need); break;
      case 'extrude':
        g.sketch = str(f.sketch, of(g.name, 'xch.swimp.what.sketch')); need(['add', 'cut'].includes(f.op ?? 'add'), 'xch.swimp.what.operation'); g.op = f.op ?? 'add';
        g.end = typeof f.end === 'string' ? txt(f.end, 30) : 'blind';
        if (g.end === 'blind' || g.end === 'mid') { need(isNum(f.depth, 1e6) && f.depth > 0, 'xch.swimp.what.depth'); g.depth = f.depth; } else if (isNum(f.depth, 1e6) && f.depth > 0) g.depth = f.depth;
        g.reverse = f.reverse === true; g.dims = dims(['depth']); break;
      case 'revolve':
        g.sketch = str(f.sketch, of(g.name, 'xch.swimp.what.sketch')); need(['add', 'cut'].includes(f.op ?? 'add'), 'xch.swimp.what.operation'); g.op = f.op ?? 'add';
        need(isNum(f.angle, 360) && f.angle > 0, 'xch.swimp.what.angle'); g.angle = f.angle;
        if (f.axis !== undefined && f.axis !== null) g.axis = id(f.axis, of(g.name, 'xch.swimp.what.axis'));
        g.reverse = f.reverse === true; g.dims = dims(['angle']); break;
      case 'fillet': case 'chamfer': {
        const k = g.type === 'fillet' ? 'r' : 'd';
        need(isNum(f[k], 1e5) && f[k] > 0, g.type === 'fillet' ? 'xch.swimp.what.radius' : 'xch.swimp.what.distance'); g[k] = f[k];
        if (g.type === 'chamfer') { if (isNum(f.d2, 1e5) && f.d2 > 0) g.d2 = f.d2; if (isNum(f.angle, 90) && f.angle > 0) g.angle = f.angle; }
        g.edges = arr(f.edges, of(g.name, 'xch.swimp.what.edges'), LIMITS.edges).map((e) => ({ at: vec3(e && e.at, of(g.name, 'xch.swimp.what.edge_point')) }));
        need(g.edges.length, 'xch.swimp.what.no_edges'); g.dims = dims([k]); break;
      }
      case 'shell':
        need(isNum(f.t, 1e5) && f.t > 0, 'xch.swimp.what.thickness'); g.t = f.t; g.outward = f.outward === true;
        g.faces = arr(f.faces, of(g.name, 'xch.swimp.what.faces'), 500).map((e) => ({ at: vec3(e && e.at, of(g.name, 'xch.swimp.what.face_point')) }));
        g.dims = dims(['t']); break;
      case 'lpattern':
        g.seeds = arr(f.seeds, of(g.name, 'xch.swimp.what.seeds'), 200).map((s) => str(s, of(g.name, 'xch.swimp.what.seed'))); need(g.seeds.length, 'xch.swimp.what.copies_nothing');
        g.dir = dir3(f.dir, of(g.name, 'xch.swimp.what.direction')); need(Number.isInteger(f.count) && f.count >= 1 && f.count <= 1000, 'xch.swimp.what.count'); g.count = f.count;
        need(isNum(f.spacing, 1e6), 'xch.swimp.what.spacing'); g.spacing = f.spacing; g.dims = dims(['count', 'spacing']); break;
      case 'cpattern':
        g.seeds = arr(f.seeds, of(g.name, 'xch.swimp.what.seeds'), 200).map((s) => str(s, of(g.name, 'xch.swimp.what.seed'))); need(g.seeds.length, 'xch.swimp.what.copies_nothing');
        need(f.axis && typeof f.axis === 'object', 'xch.swimp.what.axis'); g.axis = { o: vec3(f.axis.o, of(g.name, 'xch.swimp.what.axis')), d: dir3(f.axis.d, of(g.name, 'xch.swimp.what.axis')) };
        need(Number.isInteger(f.count) && f.count >= 1 && f.count <= 1000, 'xch.swimp.what.count'); g.count = f.count;
        need(isNum(f.angle ?? 360, 360) && (f.angle ?? 360) > 0, 'xch.swimp.what.angle'); g.angle = f.angle ?? 360; g.reverse = f.reverse === true; g.dims = dims(['count', 'angle']); break;
      case 'mirror':
        if (f.seeds === 'body') g.seeds = 'body';
        else { g.seeds = arr(f.seeds, of(g.name, 'xch.swimp.what.mirrors_what'), 200).map((s) => str(s, of(g.name, 'xch.swimp.what.seed'))); need(g.seeds.length, 'xch.swimp.what.mirrors_nothing'); }
        g.plane = readPlaneSpec(f.plane, g.name, true); break;
    }
    out.features.push(g);
  }
  return out;
}

function readPlaneSpec(p, owner, mirror = false) {
  if (!p || typeof p !== 'object') bad(of(owner, 'xch.swimp.what.plane'));
  if (typeof p.base === 'string') { if (!['front', 'top', 'right'].includes(p.base)) bad(of(owner, 'xch.swimp.what.plane')); return { base: p.base }; }
  const o = vec3(p.o, of(owner, 'xch.swimp.what.plane')), n = dir3(p.n, of(owner, 'xch.swimp.what.plane'));
  if (mirror) return { o, n };
  const x = dir3(p.x, of(owner, 'xch.swimp.what.plane_x'));
  if (Math.abs(V.dot(V.norm(x), V.norm(n))) > 1e-6) bad(of(owner, 'xch.swimp.what.plane_x_off'));
  return { o, x, n };
}

function readSketchFeature(f, g, need) {
  g.plane = readPlaneSpec(f.plane, g.name);
  const ids = new Set();
  const take = (v, what) => { const k = id(v, of(g.name, what)); if (ids.has(k)) bad(of(g.name, W('xch.swimp.what.id_twice', { id: k }))); ids.add(k); return k; };
  g.points = arr(f.points ?? [], of(g.name, 'xch.swimp.what.points'), LIMITS.entities).map((p) => {
    need(p && typeof p === 'object', 'xch.swimp.what.point');
    need(isNum(p.x) && isNum(p.y), W('xch.swimp.what.point_id', { id: txt(p.id, 40) }));
    return { id: take(p.id, 'xch.swimp.what.a_point_id'), x: p.x, y: p.y, construction: p.construction === true };
  });
  const pts = new Set(g.points.map((p) => p.id));
  const pt = (v, what) => { if (v === 'O') return 'O'; if (typeof v !== 'string' || !pts.has(v)) bad(of(g.name, W('xch.swimp.what.names_point', { what: asW(what) }))); return v; };
  g.segments = arr(f.segments ?? [], of(g.name, 'xch.swimp.what.curves'), LIMITS.entities).map((s) => {
    need(s && typeof s === 'object', 'xch.swimp.what.curve');
    const sid = take(s.id, 'xch.swimp.what.a_curve_id');
    const c = { id: sid, type: s.type, construction: s.construction === true };
    if (s.type === 'line') { c.a = pt(s.a, W('xch.swimp.what.line', { id: sid })); c.b = pt(s.b, W('xch.swimp.what.line', { id: sid })); need(c.a !== c.b, W('xch.swimp.what.line_no_length', { id: sid })); }
    else if (s.type === 'arc') { c.c = pt(s.c, W('xch.swimp.what.arc', { id: sid })); c.s = pt(s.s, W('xch.swimp.what.arc', { id: sid })); c.e = pt(s.e, W('xch.swimp.what.arc', { id: sid })); }
    else if (s.type === 'circle') { c.c = pt(s.c, W('xch.swimp.what.circle', { id: sid })); need(isNum(s.r, 1e6) && s.r > 0, W('xch.swimp.what.circle_radius', { id: sid })); c.r = s.r; }
    else { c.type = 'unsupported'; c.swType = txt(s.type, 30) || 'unknown'; }
    return c;
  });
  const known = new Set([...pts, ...g.segments.map((s) => s.id), 'O']);
  const refs = (r, what) => arr(r, what, 4).map((x) => { if (typeof x !== 'string' || !known.has(x)) bad(of(g.name, W('xch.swimp.what.names_geometry', { what: asW(what) }))); return x; });
  g.relations = arr(f.relations ?? [], of(g.name, 'xch.swimp.what.relations'), LIMITS.constraints).map((r) => {
    need(r && typeof r === 'object', 'xch.swimp.what.relation');
    return { type: typeof r.type === 'string' && RELS.has(r.type) ? r.type : 'other', swType: txt(r.swType ?? r.type, 40), refs: refs(r.refs, 'xch.swimp.what.relation') };
  });
  g.dimensions = arr(f.dimensions ?? [], of(g.name, 'xch.swimp.what.dimensions'), LIMITS.constraints).map((d) => {
    need(d && typeof d === 'object', 'xch.swimp.what.dimension');
    need(isNum(d.value, 1e6) && d.value >= 0, W('xch.swimp.what.dimension_value', { name: txt(d.name, 40) }));
    return { name: txt(d.name, 60), full: txt(d.full ?? `${d.name}@${g.name}`, 200), type: typeof d.type === 'string' && DIMS.has(d.type) ? d.type : 'other', value: d.value, refs: refs(d.refs, 'xch.swimp.what.dimension') };
  });
}

// ---------------------------------------------------------------- geometry lookups in a regen

function pointSegDist(p, a, b) {
  const ab = V.sub(b, a), t = Math.max(0, Math.min(1, V.dot(V.sub(p, a), ab) / (V.dot(ab, ab) || 1e-300)));
  return V.len(V.sub(p, V.add(a, V.mul(ab, t))));
}
/** The index of the regen edge nearest a point (OCCT's edge polylines), and that distance. */
function nearestEdge(rg, p) {
  const S6 = rg.mesh?.edgeSegs, E = rg.mesh?.segEdge;
  let best = -1, bd = Infinity;
  if (S6 && E) {
    for (let k = 0; k < E.length; k++) {
      if (E[k] < 0) continue;
      const d = pointSegDist(p, [S6[6 * k], S6[6 * k + 1], S6[6 * k + 2]], [S6[6 * k + 3], S6[6 * k + 4], S6[6 * k + 5]]);
      if (d < bd) { bd = d; best = E[k]; }
    }
  } else rg.edges.forEach((e, i) => { const d = Math.min(V.len(V.sub(e.at, p)), V.len(V.sub(e.a, p)), V.len(V.sub(e.b, p))); if (d < bd) { bd = d; best = i; } });
  return { index: best, dist: bd };
}
function pointTriDist(p, a, b, c) {
  const n = V.cross(V.sub(b, a), V.sub(c, a)), nl = V.len(n);
  if (nl > 1e-300) {
    const u = V.mul(n, 1 / nl), d = V.dot(V.sub(p, a), u), q = V.sub(p, V.mul(u, d));
    const inside = [[a, b], [b, c], [c, a]].every(([x, y]) => V.dot(V.cross(V.sub(y, x), V.sub(q, x)), n) >= -1e-12 * nl * V.len(V.sub(y, x)));
    if (inside) return Math.abs(d);
  }
  return Math.min(pointSegDist(p, a, b), pointSegDist(p, b, c), pointSegDist(p, c, a));
}
/** The index of the regen face nearest a point (its triangles), and that distance. */
function nearestFace(rg, p) {
  const M = rg.mesh, Pp = M.positions, I = M.indices, TF = M.triFace;
  let best = -1, bd = Infinity;
  const at = (i) => [Pp[i * 3], Pp[i * 3 + 1], Pp[i * 3 + 2]];
  for (let t = 0; t < TF.length; t++) { const d = pointTriDist(p, at(I[3 * t]), at(I[3 * t + 1]), at(I[3 * t + 2])); if (d < bd) { bd = d; best = TF[t]; } }
  return { index: best, dist: bd };
}

// ---------------------------------------------------------------- expressions: SolidWorks equation text → PartCraft

const FN_IN = { sin: 'sin', cos: 'cos', tan: 'tan', arcsin: 'asin', arccos: 'acos', atn: 'atan', sqr: 'sqrt', abs: 'abs', exp: 'exp', log: 'ln', sgn: 'sign', int: 'int', iif: 'if' };
/**
 * SolidWorks equation text → PartCraft expression text. `ref(name)` turns a quoted name ("width", "D1@Sketch1") into a
 * PartCraft variable name or throws. Throws Error(reason) for anything without a counterpart.
 */
export function fromSwExpr(src, ref) {
  let out = '', i = 0, depthIf = 0;
  const s = String(src);
  const stack = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) throw new Error(t('xch.swimp.expr.quote'));
      out += ref(s.slice(i + 1, j)); i = j + 1; continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (w) {
      const lw = w[0].toLowerCase();
      const after = s.slice(i + w[0].length).trimStart();
      if (after.startsWith('(')) {
        if (!FN_IN[lw]) throw new Error(t('xch.swimp.expr.function', { name: w[0] }));
        out += FN_IN[lw]; stack.push(lw === 'iif'); if (lw === 'iif') depthIf++;
      } else if (lw === 'pi') out += 'pi';
      else if (['mm', 'cm', 'm', 'in', 'ft', 'deg', 'rad'].includes(lw) && /[0-9.]\s*$/.test(out)) out += lw;
      else throw new Error(t('xch.swimp.expr.name', { name: w[0] }));
      i += w[0].length; continue;
    }
    if (c === '(') { if (stack.length && stack[stack.length - 1] === '(') stack.push(false); out += c; i++; continue; }
    if (c === ')') { const top = stack.pop(); if (top === true) depthIf--; out += c; i++; continue; }
    if (c === '<' && s[i + 1] === '>') { out += '!='; i += 2; continue; }
    if (c === '=' ) { if (!depthIf) throw new Error(t('xch.swimp.expr.comparison')); out += '=='; i++; continue; }
    if (c === '<' || c === '>') { if (s[i + 1] === '=') { out += c + '='; i += 2; } else { out += c; i++; } continue; }
    if ('+-*/^,.0123456789 \t'.includes(c)) { out += c; i++; continue; }
    throw new Error(t('xch.swimp.expr.char', { char: c }));
  }
  return out.trim();
}

/** A PartCraft parameter name for a SolidWorks name ("Wall thickness" → Wall_thickness), unique in `taken`. */
export function varName(sw, taken) {
  let b = String(sw).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+(?=[A-Za-z])/, '').slice(0, 36) || 'p';
  if (!/^[A-Za-z_]/.test(b)) b = 'p_' + b;
  if (RESERVED.has(b) || RESERVED.has(b.toLowerCase())) b += '_';
  let s = b, k = 2;
  while (taken.has(s) || !NAME_RE.test(s)) s = `${b.slice(0, 36)}_${k++}`;
  taken.add(s);
  return s;
}

// ---------------------------------------------------------------- the import

/** Build a PartCraft part from an export. Throws Error for a bad file; feature problems go in the report. */
export function fromSwExport(raw, { oc } = {}) {
  if (!oc) throw new Error(t('xch.swimp.needs_kernel'));
  const j = readSwExport(raw);
  const part = P.newPart(j.name);
  const report = { carried: [], notCarried: [], warnings: [], volume: null, lines: [] };
  const fid = new Map();          // SolidWorks feature name → PartCraft feature id
  const sketchMaps = new Map();   // sketch name → { id, map: SW id → PartCraft id, frame, swFrame, flipped, axes }
  const dimTarget = new Map();    // SolidWorks dimension full name → { key, value }
  const not = (f, why) => report.notCarried.push({ name: f.name, why });
  const warn = (s) => report.warnings.push(s);
  let regenCache = null;
  const regen = () => {
    if (!regenCache || regenCache.n !== part.features.length) regenCache = { n: part.features.length, r: regenerateBrep(JSON.parse(JSON.stringify(part)), oc) };
    return regenCache.r;
  };
  const failed = (g) => { const r = regenerateBrep(JSON.parse(JSON.stringify(part)), oc, { noMesh: true }).results.get(g.id); return r && r.status === 'error' ? r.message : null; };
  const addDim = (full, key, value) => { if (full) dimTarget.set(full, { key, value }); };

  for (const f of j.features) {
    if (f.type === 'unsupported') { not(f, f.why ? t('xch.swimp.unsupported_why', { type: f.swType, why: f.why }) : f.swType); continue; }
    try {
      let g = null;
      switch (f.type) {
        case 'sketch': g = importSketch(f); break;
        case 'extrude': {
          const sm = sketchMaps.get(f.sketch);
          if (!sm) throw new Error(t('xch.swimp.sketch_missing', { sketch: f.sketch }));
          const ends = { blind: 'blind', through: 'through', mid: 'mid' };
          if (!ends[f.end]) throw new Error(t('xch.swimp.end_condition', { end: f.end }));
          if (f.end === 'through' && f.op !== 'cut') throw new Error(t('xch.swimp.through_cut'));
          g = P.addFeature(part, 'extrude', { sketch: sm.id, op: f.op, end: f.end, depth: f.depth ?? 10, reverse: f.reverse !== sm.flipped });
          if (f.dims.depth) addDim(f.dims.depth, `${g.id}.depth`, f.depth);   // i18n-ignore: parameter target key
          break;
        }
        case 'revolve': {
          const sm = sketchMaps.get(f.sketch);
          if (!sm) throw new Error(t('xch.swimp.sketch_missing', { sketch: f.sketch }));
          let axis = null;
          if (f.axis) { axis = sm.map.get(f.axis); if (!axis) throw new Error(t('xch.swimp.axis_missing')); }
          else {
            const cl = sm.sketch.entities.filter((e) => e.type === 'line' && e.construction);
            if (cl.length > 1) warn(t('xch.swimp.warn.centerlines', { name: f.name, n: cl.length }));
          }
          g = P.addFeature(part, 'revolve', { sketch: sm.id, op: f.op, axis, angle: f.angle });
          if (Math.abs(f.angle - 360) > 1e-9) warn(t('xch.swimp.warn.revolve', { name: f.name, angle: formatNumber(f.angle) }));
          if (f.dims.angle) addDim(f.dims.angle, `${g.id}.angle`, f.angle);   // i18n-ignore: parameter target key
          break;
        }
        case 'fillet': case 'chamfer': {
          const rg = regen();
          if (!rg.stats) throw new Error(t('xch.swimp.no_body'));
          const refs = [], seen = new Set();
          let far = 0;
          for (const e of f.edges) {
            const hit = nearestEdge(rg, e.at);
            if (hit.index < 0) throw new Error(t('xch.swimp.edge_not_found'));
            far = Math.max(far, hit.dist);
            if (seen.has(hit.index)) continue;
            seen.add(hit.index); refs.push(edgeRef(rg.edges[hit.index]));
          }
          const props = f.type === 'fillet' ? { edges: refs, r: f.r } : { edges: refs, d: f.d, ...(f.d2 ? { mode: 'two', d2: f.d2 } : f.angle && Math.abs(f.angle - 45) > 1e-9 ? { mode: 'angle', angle: f.angle } : {}) };
          g = P.addFeature(part, f.type, props);
          const size = f.type === 'fillet' ? f.r : f.d;
          if (far > Math.max(1e-3, size)) warn(t('xch.swimp.warn.edge_far', { name: f.name, d: formatNumber(+far.toFixed(4)) }));
          const k = f.type === 'fillet' ? 'r' : 'd';
          if (f.dims[k]) addDim(f.dims[k], `${g.id}.${k}`, f[k]);
          break;
        }
        case 'shell': {
          const rg = regen();
          if (!rg.stats) throw new Error(t('xch.swimp.no_body_shell'));
          const refs = [];
          for (const p of f.faces) { const hit = nearestFace(rg, p.at); if (hit.index < 0) throw new Error(t('xch.swimp.face_not_found')); const r = faceRef(rg.faces[hit.index]); if (!r.name) throw new Error(t('xch.swimp.face_no_name')); refs.push(r); }
          g = P.addFeature(part, 'shell', { faces: refs, t: f.t, outward: f.outward });
          if (f.dims.t) addDim(f.dims.t, `${g.id}.t`, f.t);   // i18n-ignore: parameter target key
          break;
        }
        case 'lpattern': case 'cpattern': {
          const seeds = f.seeds.map((s) => fid.get(s));
          if (seeds.some((s) => !s)) throw new Error(t('xch.swimp.seed_missing', { name: f.seeds[seeds.findIndex((s) => !s)] }));
          if (f.type === 'lpattern') {
            const d = V.norm(f.dir);
            const w = worldAxis(d);
            g = P.addFeature(part, 'lpattern', { seeds, dir: w ? { kind: 'world', axis: w.axis } : { kind: 'fixed', o: [0, 0, 0], d }, count: f.count, spacing: f.spacing, reverse: w ? w.sign < 0 : false });
            if (f.dims.spacing) addDim(f.dims.spacing, `${g.id}.spacing`, f.spacing);   // i18n-ignore: parameter target key
          } else {
            const d = V.norm(f.axis.d);
            let axis = null, rev = f.reverse;
            const rg = regen();
            for (const [id2, a] of rg.axes || []) {
              const par = V.dot(V.norm(a.d), d);
              if (Math.abs(Math.abs(par) - 1) < 1e-9 && V.len(V.cross(V.sub(f.axis.o, a.o), d)) < 1e-6 * Math.max(1, V.len(f.axis.o))) { axis = { kind: 'axis', feature: id2 }; if (par < 0) rev = !rev; break; }
            }
            const w = worldAxis(d);
            if (!axis && w && V.len(V.cross(f.axis.o, d)) < 1e-6 * Math.max(1, V.len(f.axis.o))) { axis = { kind: 'world', axis: w.axis }; if (w.sign < 0) rev = !rev; }
            if (!axis) axis = { kind: 'fixed', o: f.axis.o, d };
            g = P.addFeature(part, 'cpattern', { seeds, axis, count: f.count, angle: f.angle, reverse: rev });
            if (Math.abs(f.angle - 360) > 1e-9) warn(t('xch.swimp.warn.cpattern', { name: f.name, angle: formatNumber(f.angle) }));
            if (f.dims.angle) addDim(f.dims.angle, `${g.id}.angle`, f.angle);   // i18n-ignore: parameter target key
          }
          if (f.dims.count) addDim(f.dims.count, `${g.id}.count`, f.count);   // i18n-ignore: parameter target key
          break;
        }
        case 'mirror': {
          let seeds = 'body';
          if (f.seeds !== 'body') { seeds = f.seeds.map((s) => fid.get(s)); if (seeds.some((s) => !s)) throw new Error(t('xch.swimp.mirror_missing')); }
          let plane;
          if (f.plane.base) plane = { kind: 'base', name: f.plane.base };
          else {
            const b = baseOf(f.plane.o, f.plane.n);
            plane = b ? { kind: 'base', name: b } : { kind: 'fixed', o: f.plane.o, n: V.norm(f.plane.n) };
          }
          g = P.addFeature(part, 'mirror', { seeds, plane });
          break;
        }
      }
      if (!g) continue;
      if (f.suppressed) g.suppressed = true;
      fid.set(f.name, g.id);
      g.name = uniqueName(f.name);
      if (f.type !== 'sketch' && !f.suppressed) {
        const msg = failed(g);
        if (msg) { warn(t('xch.swimp.warn.no_build', { name: f.name, why: msg })); }
      }
      report.carried.push(f.name);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      not(f, e.message);
    }
  }

  function uniqueName(n0) {
    const names = new Set(part.features.slice(0, -1).map((x) => x.name));
    let s = txt(n0, 60) || 'Feature', k = 2;
    while (names.has(s)) s = `${txt(n0, 54)} (${k++})`;
    return s;
  }

  function importSketch(f) {
    // SolidWorks' frame for the sketch, and PartCraft's plane
    let swFrame, ref, frame;
    if (f.plane.base) { swFrame = V.BASE_PLANES[f.plane.base]; ref = { kind: 'base', name: f.plane.base }; frame = swFrame; }
    else {
      const n = V.norm(f.plane.n), x = V.norm(V.sub(f.plane.x, V.mul(n, V.dot(f.plane.x, n))));
      swFrame = { o: f.plane.o, x, y: V.cross(n, x), n };
      const b = baseOf(f.plane.o, n);
      if (b) { ref = { kind: 'base', name: b }; frame = V.BASE_PLANES[b]; }
      else {
        const face = part.features.length ? planarFaceAt(f.plane.o, n) : null;
        if (face) { ref = refForName(face.name); frame = V.frameFor(face.n, face.o); }
        else { ref = { kind: 'fixed', o: [...f.plane.o], n }; frame = V.frameFor(n, f.plane.o); }
      }
    }
    const flipped = V.dot(swFrame.n, frame.n) < 0;
    const ax = Math.abs(V.dot(swFrame.x, frame.x));
    const axes = ax > 1 - 1e-9 ? 'same' : Math.abs(V.dot(swFrame.x, frame.y)) > 1 - 1e-9 ? 'swapped' : 'turned';
    const to = (u, v) => V.toPlane(frame, V.toWorld(swFrame, u, v));
    const sk = S.newSketch();
    const map = new Map();
    const nid = (pre) => pre + sk.seq++;
    // SolidWorks' sketch origin (the model origin projected on the plane) is PartCraft's 'O' when the two coincide
    const swO = V.toPlane(frame, swFrame.o);
    const originSame = Math.hypot(swO[0], swO[1]) < 1e-9 * Math.max(1, V.len(swFrame.o));
    if (originSame) map.set('O', S.ORIGIN);
    else { const pid = nid('p'); sk.entities.push({ id: pid, type: 'point', x: swO[0], y: swO[1], construction: true }); map.set('O', pid); sk.constraints.push({ id: nid('k'), type: 'fix', refs: [pid], value: [swO[0], swO[1]] }); }
    for (const p of f.points) {
      const [x, y] = to(p.x, p.y);
      const pid = nid('p');
      const e = { id: pid, type: 'point', x, y };
      if (p.construction) e.construction = true;
      sk.entities.push(e); map.set(p.id, pid);
    }
    const lost = [];
    for (const s of f.segments) {
      let e;
      if (s.type === 'line') e = { id: nid('l'), type: 'line', p1: map.get(s.a), p2: map.get(s.b) };
      else if (s.type === 'circle') e = { id: nid('c'), type: 'circle', c: map.get(s.c), r: s.r };
      else if (s.type === 'arc') e = { id: nid('a'), type: 'arc', c: map.get(s.c), s: map.get(flipped ? s.e : s.s), e: map.get(flipped ? s.s : s.e) };
      else { lost.push(t('xch.swimp.lost.curve_type', { type: s.swType })); continue; }
      if ([e.p1, e.p2, e.c, e.s, e.e].some((v) => v === S.ORIGIN)) { lost.push(t('xch.swimp.lost.origin', { id: s.id })); continue; }
      if (s.construction) e.construction = true;
      sk.entities.push(e); map.set(s.id, e.id);
    }
    const g = P.addFeature(part, 'sketch', { plane: ref, sketch: sk });
    const sm = { id: g.id, map, frame, swFrame, flipped, axes, sketch: sk };
    sketchMaps.set(f.name, sm);
    const skipped = [];
    for (const r of f.relations) {
      const refs = r.refs.map((x) => map.get(x));
      if (refs.some((x) => !x)) { skipped.push(r.swType || r.type); continue; }
      let type = r.type;
      if (type === 'horizontal' || type === 'vertical') { if (axes === 'turned') { skipped.push(type); continue; } if (axes === 'swapped') type = type === 'horizontal' ? 'vertical' : 'horizontal'; }
      if (type === 'coincident' && refs[0] === refs[1]) continue;
      if (type === 'concentric' && refs.length === 2) {
        const a = S.byId(sk, refs[0]), b = S.byId(sk, refs[1]);
        if (a && b && a.type === 'point' && b.type === 'point') type = 'coincident';
      }
      if (!['horizontal', 'vertical', 'coincident', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'fix', 'symmetric'].includes(type)) { skipped.push(r.swType || r.type); continue; }
      try { S.addConstraint(sk, type, refs); } catch { skipped.push(r.swType || r.type); }
    }
    const dimsLeft = [];
    for (const d of f.dimensions) {
      const refs = d.refs.map((x) => map.get(x));
      let type = d.type;
      if (type === 'hdistance' || type === 'vdistance') { if (axes === 'turned') { dimsLeft.push(d.name); continue; } if (axes === 'swapped') type = type === 'hdistance' ? 'vdistance' : 'hdistance'; }
      if (!DIMS.has(type) || refs.some((x) => !x)) { dimsLeft.push(d.name); continue; }
      try {
        const c = S.addConstraint(sk, type, refs, d.value);
        addDim(d.full, `${g.id}.${c.id}`, d.value);
      } catch { dimsLeft.push(d.name); }
    }
    if (lost.length) warn(t('xch.swimp.warn.lost', { name: f.name, list: lost.join(', ') }));
    if (skipped.length) warn(t('xch.swimp.warn.relations', { name: f.name, n: skipped.length, list: [...new Set(skipped)].join(', ') }));
    if (dimsLeft.length) warn(t('xch.swimp.warn.dimensions', { name: f.name, n: dimsLeft.length, list: dimsLeft.join(', ') }));
    const s = solveSketch(sk);
    if (s.conflicts?.length) warn(t('xch.swimp.warn.conflicts', { name: f.name, n: s.conflicts.length }));
    return g;
  }

  /** A named flat face of the part so far lying in the plane (o, n) (same side first). */
  function planarFaceAt(o, n) {
    const rg = regen();
    if (!rg.faces) return null;
    const scale = Math.max(1, V.len(o));
    const hits = rg.faces.filter((f) => f.type === 'plane' && f.name && Math.abs(Math.abs(V.dot(f.n, n)) - 1) < 1e-9 && Math.abs(V.dot(V.sub(o, f.o), f.n)) < 1e-7 * scale);
    return hits.find((f) => V.dot(f.n, n) > 0) || hits[0] || null;
  }

  // ---------------------------------------------------------------- equations → params
  const taken = new Set();
  const vars = [], links = [];
  const globalName = new Map();     // SolidWorks name (lower case) → PartCraft name
  for (const gv of j.globals) globalName.set(gv.name.toLowerCase(), varName(gv.name, taken));
  const dimVar = new Map();         // dimension full name → variable standing for it
  const ref = (nm) => {
    const g = globalName.get(nm.toLowerCase());
    if (g) return g;
    const tgt = dimTarget.get(nm) || [...dimTarget.entries()].find(([k]) => k.toLowerCase() === nm.toLowerCase())?.[1];
    if (!tgt) throw new Error(t('xch.swimp.ref_missing', { name: nm }));
    if (!dimVar.has(nm)) dimVar.set(nm, varName(nm.replace('@', '_'), taken));
    return dimVar.get(nm);
  };
  for (const gv of j.globals) {
    try {
      const e = fromSwExpr(gv.expr, ref);
      if (!parse(e).ok) throw new Error(parse(e).error);
      vars.push({ name: globalName.get(gv.name.toLowerCase()), expr: e });
    } catch (err) { warn(t('xch.swimp.warn.global', { name: gv.name, why: err.message })); }
  }
  const linked = new Set();
  for (const eq of j.equations) {
    const lhs = eq.lhs.replace(/^"|"$/g, '');
    const tgt = dimTarget.get(lhs);
    if (!tgt) { warn(t('xch.swimp.warn.equation_dim', { name: lhs })); continue; }
    try {
      const e = fromSwExpr(eq.rhs, ref);
      if (!parse(e).ok) throw new Error(parse(e).error);
      if (dimVar.has(lhs)) { vars.push({ name: dimVar.get(lhs), expr: e }); links.push({ target: tgt.key, expr: dimVar.get(lhs) }); }
      else links.push({ target: tgt.key, expr: e });
      linked.add(lhs);
    } catch (err) { warn(t('xch.swimp.warn.equation', { name: lhs, why: err.message })); }
  }
  // dimensions used in other equations but with no equation of their own: a driving parameter holding their value
  for (const [full, nm] of dimVar) {
    if (linked.has(full)) continue;
    const tgt = dimTarget.get(full);
    vars.push({ name: nm, expr: formatNumber(tgt.value) });
    links.push({ target: tgt.key, expr: nm });
  }
  if (vars.length || links.length) {
    // order variables so the file reads top-down (evaluateVars handles any order; this is for people)
    const ev = evaluateVars({ vars, links: [] });
    const ordered = ev.order.map((n0) => vars.find((v) => v.name === n0)).filter(Boolean);
    part.params = { vars: ordered, links };
    for (const [nm, msg] of ev.errors) warn(t('xch.swimp.warn.parameter', { name: nm, why: msg }));
    // the stored numbers are SolidWorks' evaluated values; say when an equation would give another
    try {
      const targets = partAdapter.targets(part);
      for (const l of links) {
        const p = parse(l.expr, ordered.map((v) => v.name));
        if (!p.ok) continue;
        const tg = targets.get(l.target);
        if (!tg) continue;
        let v; try { v = evaluate(p.ast, ev.values); } catch { continue; }
        const cur = tg.get();
        if (Number.isFinite(v) && Math.abs(v - cur) > 1e-6 * Math.max(1, Math.abs(cur))) warn(t('xch.swimp.warn.equation_value', { name: tg.label, v: formatNumber(v), held: formatNumber(cur) }));
      }
    } catch { /* the adapter is optional for the report */ }
  }

  // ---------------------------------------------------------------- the result, read back like any file
  let clean;
  try { clean = P.readPart(P.toJSON(part)); } catch (e) { throw new Error(t('xch.swimp.file_check', { why: e.message })); }
  const final = regenerateBrep(JSON.parse(JSON.stringify(clean)), oc, { noMesh: false });
  const vol = final.stats?.volume;
  if (Number.isFinite(vol)) report.volume = { partcraft: vol, solidworks: j.check?.volume ?? null, same: j.check ? Math.abs(vol - j.check.volume) <= 1e-4 * Math.max(1, j.check.volume) : null };
  const L = report.lines;
  const from = j.source.app || t('xch.swimp.the_export');
  const fills = { carried: report.carried.length, n: j.features.length, from };
  L.push(j.source.file ? t('xch.swimp.line.carried_file', { ...fills, file: j.source.file.split(/[\\/]/).pop() }) : t('xch.swimp.line.carried', fills));
  for (const x of report.notCarried) L.push(t('xch.swimp.line.not_carried', { name: x.name, why: x.why }));
  for (const w of report.warnings) L.push(w);
  if (report.volume) {
    const pc = formatNumber(+vol.toFixed(3));
    if (report.volume.solidworks === null) L.push(t('xch.swimp.line.volume', { v: pc }));
    else L.push(t(report.volume.same ? 'xch.swimp.line.volume_same' : 'xch.swimp.line.volume_different', { v: pc, sw: formatNumber(+report.volume.solidworks.toFixed(3)) }));
  }
  if (part.params) L.push(t('xch.swimp.line.params', { params: t('xch.swimp.n_params', { n: part.params.vars.length }), equations: t('xch.swimp.n_equations', { n: part.params.links.length }) }));
  return { part: clean, report };
}

/** The base plane (o, n) is, if any: through the origin, normal along X, Y or Z. */
function baseOf(o, n) {
  const u = V.norm(n);
  for (const [name, f] of Object.entries(V.BASE_PLANES)) if (Math.abs(Math.abs(V.dot(u, f.n)) - 1) < 1e-9 && Math.abs(V.dot(o, f.n)) < 1e-9 * Math.max(1, V.len(o))) return name;
  return null;
}
/** { axis: 'x'|'y'|'z', sign } when d is along a world axis. */
function worldAxis(d) {
  for (const [k, a] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) { const c = V.dot(d, a); if (Math.abs(Math.abs(c) - 1) < 1e-9) return { axis: k, sign: Math.sign(c) }; }
  return null;
}
