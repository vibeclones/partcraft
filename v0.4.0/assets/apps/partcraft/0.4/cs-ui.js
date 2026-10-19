/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-ui.js — the DOM-free half of the Script workspace (ws-script.js): what the page needs to know about scripts and
 * CraftScript values without touching the page, so Node tests import it.
 *
 *   Study      readScriptStudy(raw) — part.studies.script, untrusted on open: { v: 1, scripts: [{ name, lang, text }],
 *              active, keepVars, vars? } (vars = an encoded workspace snapshot, only when "Save the variables with the
 *              part" is on); encodeVars / decodeVars (typed arrays ↔ base64, CAPS.workspace bytes at most).
 *   Display    surfaceOf(mesh) → the outer surface of any §2 mesh (tri, quad, tet4, tet10, hex8, voxel) as triangles with
 *              vertex → node and triangle → element maps; fieldScalar(field, comp) → one number per node or element;
 *              componentsOf(field); autoScale(nodes, u); rangeOf(values).
 *   Sub-displays normalizePlot(cmd), niceTicks(lo, hi, n), grid2d(tensor, slice), tableOf(value).
 *   Files      fileKind(name), varNameFromFile(name), langOfFile(name), tensorCsv(t), valuesJson(map).
 *   Library    readLibraryIndex(json), headerDoc(text).
 */
import { CAPS, NAME_RE, typeOf, sizeOf, isTensor, readValue, serializeWorkspace, fmtNum } from './cs-values.js';
import { t } from './i18n.js';

export const SCRIPT_KEY = 'script';
export const LIMITS = Object.freeze({ scripts: 64, name: 80, text: 1 << 20, total: 8 << 20, vars: CAPS.workspace });
export const LANGS = [['craft', 'CraftScript', '.craft'], ['lua', 'Lua', '.lua'], ['python', 'Python', '.py']];
export const langName = (id) => (LANGS.find((l) => l[0] === id) || [id, id])[1];
export const extOf = (lang) => (LANGS.find((l) => l[0] === lang) || [0, 0, '.txt'])[2];

/** A script name: letters, digits, _ and -, starting with a letter (so a script can be called as a function). */
export function cleanName(s, fallback = 'script') {
  let n = String(s ?? '').replace(/\.(craft|lua|m|txt)$/i, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, LIMITS.name);
  if (!n) n = fallback;
  return n;
}
export function uniqueName(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) { const n = `${base.slice(0, LIMITS.name - 4)}${i}`; if (!set.has(n)) return n; }
}

// ---------------------------------------------------------------- the study (part.studies.script)

/** Untrusted → a clean copy, or throw a plain message. Scripts are text only: opening a part never runs them. */
export function readScriptStudy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('script.ui.study.unreadable'));
  if (!Array.isArray(raw.scripts)) throw new Error(t('script.ui.study.no_list'));
  if (raw.scripts.length > LIMITS.scripts) throw new Error(t('script.ui.study.too_many', { n: LIMITS.scripts }));
  let total = 0;
  const names = new Set();
  const scripts = raw.scripts.map((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.text !== 'string') throw new Error(t('script.ui.study.not_text', { n: i + 1 }));
    if (s.text.length > LIMITS.text) throw new Error(t('script.ui.study.too_long', { n: i + 1, max: LIMITS.text.toLocaleString('en-US') }));
    total += s.text.length;
    if (total > LIMITS.total) throw new Error(t('script.ui.study.total'));
    const lang = LANGS.some((l) => l[0] === s.lang) ? s.lang : 'craft';
    const name = uniqueName(cleanName(s.name, 'script' + (i + 1)), names);
    names.add(name);
    // control characters other than tab and newline are dropped (a script is shown in the editor as text)
    return { name, lang, text: s.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') };
  });
  const out = { v: 1, scripts, active: Number.isInteger(raw.active) && raw.active >= 0 && raw.active < scripts.length ? raw.active : 0, keepVars: raw.keepVars === true };
  if (raw.vars !== undefined && raw.vars !== null) {
    if (!out.keepVars) return out;   // saved variables without the switch: dropped
    out.vars = checkEncodedVars(raw.vars);
  }
  return out;
}
export const emptyStudy = () => ({ v: 1, scripts: [], active: 0, keepVars: false });

// typed arrays ↔ { $b64, $type } for JSON
const TYPES = { f64: Float64Array, f32: Float32Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array, i8: Int8Array, i16: Int16Array, u16: Uint16Array };
const typeKey = (a) => Object.keys(TYPES).find((k) => a instanceof TYPES[k]);
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2], n = (a << 16) | ((b || 0) << 8) | (c || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? '=' : B64[(n >> 6) & 63]) + (c === undefined ? '=' : B64[n & 63]);
  }
  return s;
}
export function fromB64(s) {
  if (typeof s !== 'string' || s.length % 4 || /[^A-Za-z0-9+/=]/.test(s)) throw new Error('bad base64');   // i18n-ignore: caught (the value is dropped), never shown
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0, out = new Uint8Array(s.length / 4 * 3 - pad);
  const v = (ch) => B64.indexOf(ch);
  for (let i = 0, j = 0; i < s.length; i += 4) {
    const n = (v(s[i]) << 18) | (v(s[i + 1]) << 12) | ((v(s[i + 2]) & 63) << 6) | (v(s[i + 3]) & 63);
    if (j < out.length) out[j++] = (n >> 16) & 255;
    if (j < out.length) out[j++] = (n >> 8) & 255;
    if (j < out.length) out[j++] = n & 255;
  }
  return out;
}
function encodeDeep(v, depth = 0) {
  if (depth > CAPS.depth) throw new Error('nested too deeply');   // i18n-ignore: developer-only (caught, or depth already capped)
  if (ArrayBuffer.isView(v)) { const k = typeKey(v); if (!k) throw new Error('unsupported array'); return { $type: k, $b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }; }   // i18n-ignore: developer-only
  if (Array.isArray(v)) return v.map((x) => encodeDeep(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = encodeDeep(v[k], depth + 1); return o; }
  return typeof v === 'number' && !Number.isFinite(v) ? { $num: String(v) } : v;
}
function decodeDeep(v, depth = 0) {
  if (depth > CAPS.depth) throw new Error('nested too deeply');   // i18n-ignore: developer-only (caught, or depth already capped)
  if (Array.isArray(v)) return v.map((x) => decodeDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    if (typeof v.$b64 === 'string' && TYPES[v.$type]) {
      const bytes = fromB64(v.$b64), C = TYPES[v.$type];
      if (bytes.length % C.BYTES_PER_ELEMENT) throw new Error('bad array length');   // i18n-ignore: caught (the value is dropped), never shown
      return new C(bytes.buffer, 0, bytes.length / C.BYTES_PER_ELEMENT);
    }
    if (typeof v.$num === 'string') return Number(v.$num);
    const o = {}; for (const k of Object.keys(v)) { if (k === '__proto__') continue; o[k] = decodeDeep(v[k], depth + 1); } return o;
  }
  return v;
}
/** A workspace snapshot ({name: value}) → JSON-safe { vars: {name: encoded}, skipped: [{name, why}], bytes }. */
export function encodeVars(snapshot) {
  const { vars, skipped, bytes } = serializeWorkspace(snapshot, { limit: LIMITS.vars });
  const enc = {};
  for (const [k, v] of Object.entries(vars)) enc[k] = encodeDeep(v);
  return { vars: enc, skipped, bytes };
}
function checkEncodedVars(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('script.ui.vars.unreadable'));
  let size = 0;
  const walk = (v, d) => { if (d > CAPS.depth) throw new Error(t('script.ui.vars.deep')); if (typeof v === 'string') size += v.length; else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1); };
  walk(raw, 0);
  if (size > LIMITS.vars * 1.4) throw new Error(t('script.ui.vars.big'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!NAME_RE.test(k)) continue;
    try { readValue(decodeDeep(v)); out[k] = v; } catch { /* dropped: not a value */ }
  }
  return out;
}
/** Encoded vars from the study → { vars: {name: value}, dropped: [names] }. */
export function decodeVars(enc) {
  const vars = {}, dropped = [];
  for (const [k, v] of Object.entries(enc || {})) {
    if (!NAME_RE.test(k)) { dropped.push(k); continue; }
    try { vars[k] = readValue(decodeDeep(v)); } catch { dropped.push(k); }
  }
  return { vars, dropped };
}

// ---------------------------------------------------------------- files

const SCRIPT_EXT = ['craft', 'lua', 'm', 'py'], DATA_EXT = ['stl', 'obj', 'csv', 'json', 'npy', 'h5', 'hdf5', 'txt'];
/** 'script' | 'data' | 'part' | null for a file name. */
export function fileKind(name) {
  const n = String(name || '').toLowerCase();
  if (/\.partcraft\.json$/.test(n) || /\.(step|stp)$/.test(n)) return 'part';
  const ext = (/\.([a-z0-9]+)$/.exec(n) || [])[1];
  if (SCRIPT_EXT.includes(ext)) return 'script';
  if (DATA_EXT.includes(ext)) return 'data';
  return null;
}
export const langOfFile = (name) => (/\.lua$/i.test(name) ? 'lua' : /\.py$/i.test(name) ? 'python' : 'craft');
/** A workspace name for a loaded data file: "beam mesh (2).stl" → "beam_mesh_2". */
export function varNameFromFile(name) {
  const n = String(name || '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^A-Za-z]+/, '').slice(0, 60);
  return NAME_RE.test(n) ? n : 'data';
}

/** A tensor (≤ 2-D, or the first 2-D page) as CSV text. */
export function tensorCsv(t) {
  const g = grid2d(t);
  const rows = [];
  for (let i = 0; i < g.rows; i++) { const r = []; for (let j = 0; j < g.cols; j++) r.push(csvNum(g.get(i, j))); rows.push(r.join(',')); }
  return rows.join('\r\n') + '\r\n';
}
const csvNum = (x) => (Number.isFinite(x) ? String(x) : Number.isNaN(x) ? 'NaN' : x > 0 ? 'Inf' : '-Inf');
/** Values as JSON text (typed arrays → arrays; non-finite numbers → strings). */
export function valuesJson(map) {
  const conv = (v, d = 0) => {
    if (d > CAPS.depth) return null;
    if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (Number.isFinite(x) ? x : String(x)));
    if (Array.isArray(v)) return v.map((x) => conv(x, d + 1));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = conv(v[k], d + 1); return o; }
    return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
  };
  return JSON.stringify({ format: 'craftscript-workspace', version: 1, vars: conv(map) }, null, 1);
}

// ---------------------------------------------------------------- variables panel text

export function sizeText(size) { return Array.isArray(size) && size.length ? size.join('×') : ''; }
export const numText = (x) => (typeof x === 'number' ? fmtNum(x) : '');
export function bytesText(b) {
  if (!(b >= 0)) return '';
  // i18n-ignore: unit symbols
  return b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- canvas display: meshes and fields

const TET_FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
const TET10_EDGE = { '0,1': 4, '1,2': 5, '0,2': 6, '0,3': 7, '1,3': 8, '2,3': 9 };
const HEX_FACES = [[0, 3, 7, 4], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 1, 2, 3], [4, 7, 6, 5]];
const NPE = { tri: 3, quad: 4, tet4: 4, tet10: 10, hex8: 8 };

/** The mesh inside a model or a PartCraft display mesh, as a §2 mesh (or null). */
export function meshOfValue(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.t === 'model') return meshOfValue(v.mesh);
  if (v.t === 'mesh') return v;
  if (v.positions && v.indices) return { t: 'mesh', kind: 'tri', nodes: v.positions, elems: v.indices };
  return null;
}

/**
 * The outer surface of a mesh → { positions: Float32Array (3 per vertex), indices: Uint32Array, vertNode: Int32Array
 * (node of each vertex), triElem: Int32Array (element of each triangle), lines: Uint32Array (vertex pairs of the
 * element edges on the surface; empty past maxLines), nodes, elems } or throws a plain message.
 */
export function surfaceOf(mesh, { maxLines = 600000 } = {}) {
  const m = meshOfValue(mesh);
  if (!m) throw new Error(t('script.ui.mesh.not_mesh'));
  if (m.kind === 'voxel') return voxelSurface(m.grid || m, maxLines);
  const npe = NPE[m.kind];
  if (!npe) throw new Error(t('script.ui.mesh.kind', { kind: String(m.kind).slice(0, 20) }));
  const N = m.nodes;
  let E = m.elems;
  if (!N || !E || typeof N.length !== 'number' || typeof E.length !== 'number') throw new Error(t('script.ui.mesh.empty', { kind: m.kind }));
  if (!ArrayBuffer.isView(E)) E = Int32Array.from(E);
  const nn = Math.floor(N.length / 3), ne = Math.floor(E.length / npe);
  if (E.length % npe) throw new Error(t('script.ui.mesh.multiple', { kind: m.kind, n: npe }));
  for (let i = 0; i < E.length; i++) if (!(E[i] >= 0 && E[i] < nn)) throw new Error(t('script.ui.mesh.bad_node', { elem: Math.floor(i / npe) + 1, node: E[i] + 1 }));
  const polys = [];   // [nodes…, elem] per surface polygon (tri or quad); tet10 faces carry 6 nodes
  if (m.kind === 'tri' || m.kind === 'quad') {
    for (let e = 0; e < ne; e++) polys.push({ n: Array.from(E.subarray(e * npe, e * npe + npe)), e });
  } else {
    const faces = new Map();
    const face = (key, nodes, e) => { const f = faces.get(key); if (f) f.count++; else faces.set(key, { nodes, e, count: 1 }); };
    for (let e = 0; e < ne; e++) {
      const en = E.subarray(e * npe, e * npe + npe);
      if (m.kind === 'hex8') { for (const f of HEX_FACES) { const nodes = f.map((k) => en[k]); face(nodes.slice().sort((a, b) => a - b).join(','), nodes, e); } continue; }
      for (const f of TET_FACES) {
        let nodes = f.map((k) => en[k]);
        // outward: the fourth corner is behind the face
        const opp = en[[0, 1, 2, 3].find((k) => !f.includes(k))];
        if (orient(N, nodes, opp) > 0) nodes = [nodes[0], nodes[2], nodes[1]];
        if (m.kind === 'tet10') {
          const loc = nodes.map((nd) => Array.prototype.indexOf.call(en, nd));
          const mid = (a, b) => en[TET10_EDGE[[Math.min(a, b), Math.max(a, b)].join(',')]];
          nodes = [...nodes, mid(loc[0], loc[1]), mid(loc[1], loc[2]), mid(loc[2], loc[0])];
        }
        face(nodes.slice(0, 3).sort((a, b) => a - b).join(','), nodes, e);
      }
    }
    for (const f of faces.values()) if (f.count === 1) polys.push({ n: f.nodes, e: f.e });
  }
  return build((n) => [N[3 * n], N[3 * n + 1], N[3 * n + 2]], polys, maxLines, m);
}
function orient(N, f, opp) {
  const p = (i) => [N[3 * i], N[3 * i + 1], N[3 * i + 2]];
  const a = p(f[0]), b = p(f[1]), c = p(f[2]), o = p(opp);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  return n[0] * (o[0] - a[0]) + n[1] * (o[1] - a[1]) + n[2] * (o[2] - a[2]);
}
function build(xyz, polys, maxLines, m) {
  const vOf = new Map(), vertNode = [], pos = [], idx = [], triElem = [], lineSet = new Set(), lines = [];
  const v = (node) => { let k = vOf.get(node); if (k === undefined) { k = vertNode.length; vOf.set(node, k); vertNode.push(node); pos.push(...xyz(node)); } return k; };
  const tri = (a, b, c, e) => { idx.push(v(a), v(b), v(c)); triElem.push(e); };
  const edge = (a, b) => { if (lines.length / 2 >= maxLines) return; const key = a < b ? a + ',' + b : b + ',' + a; if (lineSet.has(key)) return; lineSet.add(key); lines.push(v(a), v(b)); };
  for (const { n, e } of polys) {
    if (n.length === 3) { tri(n[0], n[1], n[2], e); edge(n[0], n[1]); edge(n[1], n[2]); edge(n[2], n[0]); }
    else if (n.length === 4) { tri(n[0], n[1], n[2], e); tri(n[0], n[2], n[3], e); edge(n[0], n[1]); edge(n[1], n[2]); edge(n[2], n[3]); edge(n[3], n[0]); }
    else if (n.length === 6) {   // quadratic triangle: corners a b c, midsides ab bc ca
      const [a, b, c, ab, bc, ca] = n;
      tri(a, ab, ca, e); tri(ab, b, bc, e); tri(ca, bc, c, e); tri(ab, bc, ca, e);
      edge(a, ab); edge(ab, b); edge(b, bc); edge(bc, c); edge(c, ca); edge(ca, a);
    }
  }
  if (lines.length / 2 >= maxLines) lines.length = 0;
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), vertNode: Int32Array.from(vertNode), triElem: Int32Array.from(triElem), lines: Uint32Array.from(lines), nodes: m ? Math.floor(m.nodes.length / 3) : 0, elems: m ? Math.floor(m.elems.length / NPE[m.kind]) : 0, kind: m ? m.kind : 'voxel' };
}
function voxelSurface(g, maxLines) {
  const { nx, ny, nz, h, origin, solid } = g || {};
  const okOrigin = (Array.isArray(origin) || ArrayBuffer.isView(origin)) && origin.length === 3;
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n > 0) || !(h > 0) || !okOrigin || !solid || solid.length !== nx * ny * nz) throw new Error(t('script.ui.mesh.voxel'));
  const NX = nx + 1, NXY = NX * (ny + 1), off = [0, 1, 1 + NX, NX, NXY, NXY + 1, NXY + 1 + NX, NXY + NX];
  const FACES = [[0, 3, 7, 4, 0, -1], [1, 2, 6, 5, 0, 1], [0, 1, 5, 4, 1, -1], [3, 7, 6, 2, 1, 1], [0, 1, 2, 3, 2, -1], [4, 7, 6, 5, 2, 1]];
  const polys = [], dimsA = [nx, ny, nz], step = [1, nx, nx * ny];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const e = i + nx * (j + ny * k);
    if (!solid[e]) continue;
    const n0 = i + NX * (j + (ny + 1) * k), ijk = [i, j, k];
    for (const [c0, c1, c2, c3, ax, s] of FACES) {
      const ni = ijk[ax] + s;
      if (ni >= 0 && ni < dimsA[ax] && solid[e + s * step[ax]]) continue;
      polys.push({ n: [n0 + off[c0], n0 + off[c1], n0 + off[c2], n0 + off[c3]], e });
    }
  }
  const nodeCount = NX * (ny + 1) * (nz + 1);
  const xyz = (n) => [origin[0] + (n % NX) * h, origin[1] + (Math.floor(n / NX) % (ny + 1)) * h, origin[2] + Math.floor(n / NXY) * h];
  const s = build(xyz, polys, maxLines, null);
  s.nodes = nodeCount; s.elems = nx * ny * nz; s.kind = 'voxel';
  return s;
}

/** The component choices of a field: [[key, label]]. */
export function componentsOf(field) {
  const c = field && field.comps;
  if (c === 3) return [['mag', t('script.ui.comp.magnitude')], ['x', 'X'], ['y', 'Y'], ['z', 'Z']];
  if (c === 6) return [['vm', t('script.ui.comp.von_mises')], ['xx', 'XX'], ['yy', 'YY'], ['zz', 'ZZ'], ['xy', 'XY'], ['yz', 'YZ'], ['zx', 'ZX']];
  return [['v', t('script.ui.comp.value')]];
}
/** One number per node or element: { values: Float64Array, label }. */
export function fieldScalar(field, comp) {
  const c = field.comps || 1, d = field.data, n = Math.floor(d.length / c), out = new Float64Array(n);
  if (!(c === 1 || c === 3 || c === 6) || d.length % c) throw new Error(t('script.ui.field.comps'));
  if (c === 1) { out.set(d.subarray ? d.subarray(0, n) : d.slice(0, n)); return { values: out, label: '' }; }
  const comps = componentsOf(field), key = comps.some(([k]) => k === comp) ? comp : comps[0][0], k = comps.findIndex(([q]) => q === key) - 1;
  for (let i = 0; i < n; i++) {
    const o = i * c;
    if (c === 3) out[i] = key === 'mag' ? Math.hypot(d[o], d[o + 1], d[o + 2]) : d[o + k];
    else if (key === 'vm') { const [sx, sy, sz, txy, tyz, tzx] = [d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5]]; out[i] = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx)); }
    else out[i] = d[o + k];
  }
  return { values: out, label: comps.find(([q]) => q === key)[1] };
}
export function rangeOf(values) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) { const x = values[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  if (!(hi > lo)) hi = lo + (Math.abs(lo) || 1) * 1e-6;
  return { lo, hi };
}
/** A round deformation scale making the largest displacement about 8 % of the model's size. */
export function autoScale(positions, u, vertNode) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], positions[i + a]); hi[a] = Math.max(hi[a], positions[i + a]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  let m = 0;
  for (let v = 0; v < vertNode.length; v++) { const n = vertNode[v]; m = Math.max(m, Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2])); }
  if (!(m > 0)) return 1;
  const raw = 0.08 * diag / m, e = Math.floor(Math.log10(raw)), b = raw / 10 ** e;
  return +(([1, 2, 5, 10].find((s) => s >= b) || 10) * 10 ** e).toPrecision(2);
}

// ---------------------------------------------------------------- sub-displays

const asArr = (v) => (v === null || v === undefined ? null : typeof v === 'number' ? Float64Array.of(v) : isTensor(v) ? v.data : ArrayBuffer.isView(v) ? v : Array.isArray(v) ? Float64Array.from(v, Number) : null);
/** A display command's plot → { title, xlabel, ylabel, log ('' | 'x' | 'y' | 'xy'), kind ('line' | 'scatter'), series: [{ name, x, y }] }. */
export function normalizePlot(cmd) {
  let p = cmd && cmd.plot;
  if (isTensor(p) || ArrayBuffer.isView(p) || Array.isArray(p)) p = { y: p };
  if (!p || typeof p !== 'object') throw new Error(t('script.ui.plot.empty'));
  const o = { ...(cmd.opts || {}), ...(p.opts && typeof p.opts === 'object' ? p.opts : {}), ...p };
  const raw = Array.isArray(o.series) ? o.series : [o];
  const series = [];
  for (const s of raw.slice(0, 32)) {
    const yT = s.y, y = asArr(yT);
    if (!y) continue;
    // a matrix y: one series per column (as MATLAB plots columns)
    if (isTensor(yT) && yT.shape.length === 2 && yT.shape[0] > 1 && yT.shape[1] > 1) {
      const [r, c] = yT.shape, x = asArr(s.x);
      for (let j = 0; j < Math.min(c, 32); j++) series.push({ name: s.name ? `${s.name} ${j + 1}` : t('script.ui.plot.column', { n: j + 1 }), x: x && x.length === r ? Float64Array.from(x) : seq(r), y: y.slice(j * r, j * r + r) });
      continue;
    }
    const x = asArr(s.x);
    series.push({ name: String(s.name || ''), x: x && x.length === y.length ? Float64Array.from(x) : seq(y.length), y: Float64Array.from(y) });
  }
  if (!series.length) throw new Error(t('script.ui.plot.empty'));
  const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const log = ['x', 'y', 'xy'].includes(o.log) ? o.log : o.logy ? 'y' : '';
  return { title: str(o.title), xlabel: str(o.xlabel), ylabel: str(o.ylabel), log, kind: o.kind === 'scatter' ? 'scatter' : 'line', series };
}
const seq = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i + 1; return a; };

/** Round axis ticks between lo and hi: { lo, hi, step, ticks }. */
export function niceTicks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const raw = (hi - lo) / Math.max(1, n), e = Math.floor(Math.log10(raw)), b = raw / 10 ** e;
  const step = ([1, 2, 2.5, 5, 10].find((s) => s >= b - 1e-9) || 10) * 10 ** e;
  const a = Math.floor(lo / step + 1e-9) * step, z = Math.ceil(hi / step - 1e-9) * step, ticks = [];
  for (let t = a; t <= z + step * 1e-6 && ticks.length < 50; t += step) ticks.push(+t.toPrecision(12));
  return { lo: a, hi: z, step, ticks };
}

/** A tensor's 2-D page: { rows, cols, pages, page, get(i, j) } (dims past the second pick page `slice`, 0-based). */
export function grid2d(ten, slice = 0) {
  if (!isTensor(ten)) throw new Error(t('script.ui.table.not_array'));
  const [r, c = 1] = ten.shape, pages = ten.shape.slice(2).reduce((a, b) => a * b, 1);
  const page = Math.max(0, Math.min(pages - 1, Math.floor(slice) || 0)), off = page * r * c, d = ten.data;
  return { rows: r, cols: c, pages, page, get: (i, j) => d[off + i + j * r] };
}

/** Rows for the table sub-display of any value: { head: [..], rows: [[..]], more: text | '' }. */
export function tableOf(v, { maxRows = 200, maxCols = 40, slice = 0 } = {}) {
  const ty = typeOf(v);
  if (ty === 'tensor') {
    const g = grid2d(v, slice), rows = [];
    for (let i = 0; i < Math.min(g.rows, maxRows); i++) { const r = [String(i + 1)]; for (let j = 0; j < Math.min(g.cols, maxCols); j++) r.push(fmtNum(g.get(i, j))); rows.push(r); }
    const head = ['', ...Array.from({ length: Math.min(g.cols, maxCols) }, (_, j) => String(j + 1))];
    const more = g.rows > maxRows || g.cols > maxCols ? t('script.ui.table.more_grid', { rows: Math.min(g.rows, maxRows), allRows: g.rows, cols: Math.min(g.cols, maxCols), allCols: g.cols }) : '';
    return { head, rows, more, page: g.page, pages: g.pages };
  }
  if (ty === 'struct') return { head: [t('script.ui.table.field'), t('script.ui.comp.value')], rows: Object.entries(v.fields).slice(0, maxRows).map(([k, x]) => [k, short(x)]), more: '' };
  if (ty === 'cell') return { head: ['', t('script.ui.comp.value')], rows: v.items.slice(0, maxRows).map((x, i) => [String(i + 1), short(x)]), more: v.items.length > maxRows ? t('script.ui.table.more', { n: maxRows, all: v.items.length }) : '' };
  return { head: [t('script.ui.comp.value')], rows: [[short(v)]], more: '' };
}
function short(x) {
  const t = typeOf(x);
  if (t === 'number') return fmtNum(x);
  if (t === 'bool') return x ? 'true' : 'false';
  if (t === 'string') return x.length > 80 ? x.slice(0, 80) + '…' : x;
  if (t === 'tensor' && x.data.length === 1) return fmtNum(x.data[0]);
  return `${sizeText(sizeOf(x))} ${t}`;
}

// ---------------------------------------------------------------- library (craftlib/index.json, builder D)

/**
 * index.json → [{ id, label, items: [{ name, file, summary }] }]. Accepts { groups: [{ id|name, label|title, items|functions }] }
 * or { "<group>": [ … ] }; an item is a name, or { name, file?, summary|doc|title? }. Untrusted: names checked, lists capped.
 */
export function readLibraryIndex(json) {
  const groups = [];
  const items = (list) => (Array.isArray(list) ? list : []).slice(0, 200).map((it) => {
    const o = typeof it === 'string' ? { name: it } : it && typeof it === 'object' ? it : null;
    if (!o || typeof o.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(o.name)) return null;
    const file = typeof o.file === 'string' && /^[A-Za-z0-9_/-]{1,120}\.(craft|lua)$/.test(o.file) && !o.file.includes('..') ? o.file : `${o.name}.craft`;   // i18n-ignore: a file name
    const summary = [o.summary, o.doc, o.title, o.description].find((x) => typeof x === 'string') || '';
    return { name: o.name, file, summary: summary.slice(0, 400) };
  }).filter(Boolean);
  const label = (s) => String(s).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 60);
  if (json && Array.isArray(json.groups)) {
    for (const g of json.groups.slice(0, 40)) {
      if (!g || typeof g !== 'object') continue;
      const id = String(g.id || g.name || g.label || 'group').slice(0, 40);
      groups.push({ id, label: label(g.label || g.title || g.name || id), items: items(g.items || g.functions || g.files) });
    }
  } else if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [k, v] of Object.entries(json).slice(0, 40)) if (Array.isArray(v)) groups.push({ id: k.slice(0, 40), label: label(k), items: items(v) });
  }
  return groups.filter((g) => g.items.length);
}

/** The header comment of a library file (what it computes, method, references, check) as plain text. */
export function headerDoc(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^\s*%\{\s*$/.test(lines[i] || '')) { for (i++; i < lines.length && !/^\s*%\}\s*$/.test(lines[i]); i++) out.push(lines[i]); return trimDoc(out); }
  if (/^\s*--\[\[/.test(lines[i] || '')) { for (i++; i < lines.length && !/\]\]/.test(lines[i]); i++) out.push(lines[i]); return trimDoc(out); }
  // a function line first: its doc follows it
  if (/^\s*function\b/.test(lines[i] || '')) i++;
  for (; i < lines.length && /^\s*(%|--)/.test(lines[i]); i++) out.push(lines[i].replace(/^\s*(%+|-{2,})\s?/, ''));
  return trimDoc(out);
}
const trimDoc = (a) => a.join('\n').replace(/^\n+|\s+$/g, '').slice(0, 8000);
