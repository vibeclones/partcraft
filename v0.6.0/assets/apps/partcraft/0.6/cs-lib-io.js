/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lib-io.js — CraftScript builtins: load / save files, models from PartCraft (DOM-free; script worker and Node).
 * Spec: docs/SCRIPTING-SPEC.md §1–§3, §6 (builder B).
 *
 *   load(file, opts)         by extension: .stl (binary/ASCII) .obj → model; .csv → tensor ([data, headers] with 2 outputs);
 *                            .json → value (our §2 JSON round-trips exactly; plain JSON maps numbers/arrays/objects to
 *                            numbers/tensors/structs/cells); .npy → tensor; .h5/.hdf5 → struct of the file's datasets (groups
 *                            nested; opts.dataset '/path' reads one).
 *   save(file, value, opts)  .stl (binary) .obj (a model, a tri mesh or any volume mesh's surface), .csv (2-D tensor; opts
 *                            headers = cell of names), .json (§2 JSON), .npy (tensor, Fortran order), .h5 (a struct is written
 *                            as the file's top level; anything else as /value).
 *   files() → cell of names · part() / bodies() → the open PartCraft part / its bodies as model values (when the host gives them)
 *   param(name) → the part's parameter's value (mm, degrees or a plain number) · params() → a struct of them all (0.5 WL.30;
 *                            read only; the Parameters table lists the scripts that call them, params-uses.js)
 *
 * Where files come from: an io host set with setIoHost({ readFile(name) → Uint8Array | null, writeFile(name, bytes, mime),
 * listFiles() → [names], part() → model | null, bodies() → [model], params() → { name: number } }). Node default (CLI, tests): the real file system,
 * relative to process.cwd() (or setIoHost(nodeFs(dir))). The script worker: an in-memory store of the files the page handed
 * over (memoryFs()); saved files go back to the page as downloads. Untrusted input: every reader checks sizes and counts.
 *
 * HDF5 uses the vendored h5wasm (assets/vendor/h5wasm/current, NIST + HDF5 BSD-style licences), imported lazily the first
 * time it is needed. Builtins are synchronous, so the runtime calls `await prepareIo(source)` before a run (it preloads
 * h5wasm when the source mentions .h5/.hdf5) — or `await loadH5()` directly. In HDF5 files tensors are stored in C order
 * (NumPy/h5py see the same shape and indices as the script); sparse matrices as an h5sparse-style CSR group (data, indices,
 * indptr, attrs h5sparse_format 'csr', h5sparse_shape); structs as groups; cells as groups of 1…n with attr cs_type 'cell';
 * meshes/fields/models as groups with attr cs_type.
 */
import { registerBuiltin as rtRegisterBuiltin } from './cs-runtime.js';
import { t } from './i18n.js';
import { CsError, readValue } from './cs-values.js';
import { asTensor, scalarOf, optsOf, size2, mat, tensor, typeName } from './cs-lib-linalg.js';
import { surfaceOf, meshValue } from './cs-lib-mesh.js';

const err = (msg) => new CsError(msg);
const NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof window === 'undefined';
const MAX_FILE = 512 * 1024 * 1024;
const MAX_TRIS = 20e6;
const enc = new TextEncoder(), dec = new TextDecoder();
const struct = (fields) => ({ t: 'struct', fields });
const cell = (items) => ({ t: 'cell', shape: [items.length ? 1 : 0, items.length], items });

// ─────────────────────────────────────────────────────────────── vendored libraries (one place for every URL)
/** Paths are written with /current/ so bin/release-app.php pins them to the version of the day. */
export const VENDOR = {
  h5wasm: '/assets/vendor/h5wasm/0.10.3/hdf5_hl.js',
  wasmoonJs: '/assets/vendor/wasmoon/1.16.0/index.js',
  wasmoonWasm: '/assets/vendor/wasmoon/1.16.0/glue.wasm',
  cpythonWasm: '/assets/vendor/cpython-wasi/3.14.7/python.wasm',          // Python (0.5: CPython for WASI, cs-lang-python.js)
  cpythonStdlib: '/assets/vendor/cpython-wasi/3.14.7/python-stdlib.zip',
};
const VENDOR_OVERRIDE = {};
/** The page (or worker) can hand over exact URLs: setVendorUrls({ h5wasm, wasmoonJs, wasmoonWasm }). */
export function setVendorUrls(urls = {}) { for (const k of Object.keys(VENDOR)) if (typeof urls[k] === 'string') VENDOR_OVERRIDE[k] = urls[k]; }
/** → { url (for import()/fetch), path (a file path in Node, else the url) } */
export function vendorUrl(key) {
  if (VENDOR_OVERRIDE[key]) return { url: VENDOR_OVERRIDE[key], path: VENDOR_OVERRIDE[key] };
  const p = VENDOR[key];
  const base = import.meta.url;
  if (base.startsWith('blob:') || base.startsWith('data:')) {   // a worker linked from blob: modules: same origin as the page
    const origin = globalThis.location && globalThis.location.origin && globalThis.location.origin !== 'null' ? globalThis.location.origin : '';
    const u = origin + p;
    return { url: u, path: u };
  }
  const u = new URL('../../../..' + p, base);   // dev/ → partcraft/ → apps/ → assets/ → public_html/
  if (u.protocol === 'file:') return { url: u.href, path: decodeURIComponent(u.pathname) };
  return { url: u.href, path: u.href };
}

let H5 = null, h5Loading = null;
/** Load h5wasm once (both the browser worker and Node use its ES module build; the wasm is embedded). */
export async function loadH5() {
  if (H5) return H5;
  if (!h5Loading) h5Loading = (async () => { const m = await import(vendorUrl('h5wasm').url); const mod = await m.ready; if (mod && typeof mod.activate_throwing_error_handler === 'function') mod.activate_throwing_error_handler(); H5 = m; return m; })().catch((e) => { h5Loading = null; throw e; });
  return h5Loading;
}
/** Before a run: preload what the script will need (HDF5 when it mentions .h5/.hdf5). */
export async function prepareIo(source = '') {
  if (/\.h5\b|\.hdf5\b|hdf5|h5read|h5write/i.test(String(source))) await loadH5();
}
const needH5 = () => { if (!H5) throw err(t('script.io.h5_not_loaded')); return H5; };

// ─────────────────────────────────────────────────────────────── file hosts
let HOST = null;
export function setIoHost(h) { HOST = h; }
export const getIoHost = () => HOST || (NODE ? (HOST = nodeFs()) : null);
/** In-memory files (the script worker): put(name, bytes), get(name), plus the host interface. */
export function memoryFs({ onWrite = null, part = null, bodies = null, params = null } = {}) {
  const files = new Map();
  return {
    files,
    put(name, bytes) { files.set(cleanName(name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); },
    readFile: (name) => files.get(cleanName(name)) || null,
    writeFile(name, bytes, mime) { name = cleanName(name); files.set(name, bytes); if (onWrite) onWrite(name, bytes, mime); },
    listFiles: () => [...files.keys()],
    part: () => (typeof part === 'function' ? part() : part),
    bodies: () => (typeof bodies === 'function' ? bodies() : bodies || []),
    params: () => (typeof params === 'function' ? params() : params || {}),
  };
}
/** Node: real files under `dir` (default the working directory). */
export function nodeFs(dir = null, { part = null, bodies = null, params = null } = {}) {
  let fs = null, path = null;
  const need = () => { if (!fs) { fs = process.getBuiltinModule('fs'); path = process.getBuiltinModule('path'); } };
  const full = (name) => { need(); return path.resolve(dir || process.cwd(), name); };
  return {
    readFile(name) { const p = full(name); if (!fs.existsSync(p)) return null; const st = fs.statSync(p); if (st.size > MAX_FILE) throw err(t('script.io.larger_than', { name, mb: MAX_FILE / 1048576 })); return new Uint8Array(fs.readFileSync(p)); },
    writeFile(name, bytes) { const p = full(name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); },
    listFiles() { need(); try { return fs.readdirSync(dir || process.cwd()).filter((f) => /\.(stl|obj|csv|json|npy|h5|hdf5)$/i.test(f)); } catch { return []; } },
    part: () => (typeof part === 'function' ? part() : part),
    bodies: () => (typeof bodies === 'function' ? bodies() : bodies || []),
    params: () => (typeof params === 'function' ? params() : params || {}),
  };
}
function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw err(t('script.io.name_needed'));
  if (name.length > 255 || /[\0]/.test(name)) throw err(t('script.io.name_bad'));
  return name.trim();
}
const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ''; };
function readBytes(name) {
  const h = getIoHost();
  if (!h) throw err(t('script.io.no_files'));
  const b = h.readFile(cleanName(name));
  if (!b) throw err(h.listFiles ? t('script.io.no_file_list', { name, files: h.listFiles().slice(0, 12).join(', ') || t('script.io.files_none') }) : t('script.io.no_file', { name }));
  if (b.length > MAX_FILE) throw err(t('script.io.too_large', { name }));
  return b;
}
function writeBytes(name, bytes, mime) {
  const h = getIoHost();
  if (!h || !h.writeFile) throw err(t('script.io.no_save'));
  h.writeFile(cleanName(name), bytes, mime);
}

// ─────────────────────────────────────────────────────────────── models
/** A triangle mesh in PartCraft's shape ({positions, indices, triFace?}) → a model value. */
export function modelFromMesh(m, { source = 'file', ref = '', faces = null } = {}) {
  const nodes = Float64Array.from(m.positions), elems = Int32Array.from(m.indices);
  const nn = nodes.length / 3;
  for (const i of elems) if (!(i >= 0 && i < nn)) throw err(t('script.io.mesh_vertex'));
  const extra = {};
  if (m.triFace && m.triFace.length === elems.length / 3) extra.triFace = Int32Array.from(m.triFace);
  if (Array.isArray(faces)) extra.faces = faces;
  return { t: 'model', source, ref: String(ref).slice(0, 255), mesh: meshValue('tri', nodes, elems, extra) };
}
/** Weld a triangle soup by exact coordinates. */
function weld(P) {
  const map = new Map(), nodes = [], idx = new Int32Array(P.length / 3);
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2], k = x + ',' + y + ',' + z;
    let id = map.get(k);
    if (id === undefined) { id = nodes.length / 3; map.set(k, id); nodes.push(x, y, z); }
    idx[v] = id;
  }
  return { nodes: Float64Array.from(nodes), elems: idx };
}
export function readStl(bytes, name = 'model.stl') {
  if (bytes.length < 15) throw err(t('script.io.stl_short', { name }));
  const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nb = bytes.length >= 84 ? dv.getUint32(80, true) : -1;
  let P;
  if (bytes.length >= 84 && 84 + 50 * nb === bytes.length) {
    if (nb > MAX_TRIS) throw err(t('script.io.too_many_tris', { name }));
    P = new Float64Array(9 * nb);
    for (let t = 0; t < nb; t++) for (let k = 0; k < 9; k++) P[9 * t + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
  } else if (/^\s*solid/i.test(head)) {
    const text = dec.decode(bytes), out = [], re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    let m;
    while ((m = re.exec(text))) { out.push(+m[1], +m[2], +m[3]); if (out.length > 9 * MAX_TRIS) throw err(t('script.io.too_many_tris', { name })); }
    if (out.length % 9) throw err(t('script.io.stl_facet', { name }));
    P = Float64Array.from(out);
  } else throw err(t('script.io.stl_bad', { name }));
  for (const v of P) if (!Number.isFinite(v)) throw err(t('script.io.vertex_finite', { name }));
  if (!P.length) throw err(t('script.io.no_tris', { name }));
  const w = weld(P);
  return { t: 'model', source: 'file', ref: name, mesh: meshValue('tri', w.nodes, w.elems) };
}
export function readObj(bytes, name = 'model.obj') {
  const text = dec.decode(bytes), V = [], I = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) { const p = line.split(/\s+/); V.push(+p[1], +p[2], +p[3]); }
    else if (line.startsWith('f ')) {
      const nv = V.length / 3, ids = line.split(/\s+/).slice(1).map((s) => { const k = parseInt(s.split('/')[0], 10); return k < 0 ? nv + k : k - 1; });
      for (const k of ids) if (!(Number.isInteger(k) && k >= 0 && k < nv)) throw err(t('script.io.obj_face', { name }));
      for (let j = 1; j + 1 < ids.length; j++) I.push(ids[0], ids[j], ids[j + 1]);
      if (I.length > 3 * MAX_TRIS) throw err(t('script.io.too_many_tris', { name }));
    }
  }
  for (const v of V) if (!Number.isFinite(v)) throw err(t('script.io.vertex_finite', { name }));
  if (!I.length) throw err(t('script.io.no_faces', { name }));
  return { t: 'model', source: 'file', ref: name, mesh: meshValue('tri', Float64Array.from(V), Int32Array.from(I)) };
}
const triOf = (v, what) => {
  const m = v && v.t === 'model' ? v.mesh : v;
  if (!m || m.t !== 'mesh') throw err(t('script.io.need_mesh', { what, got: typeName(v) }));
  return m.kind === 'tri' ? m : surfaceOf(m);
};
export function writeStl(v, name = 'model') {
  const m = triOf(v, 'save .stl'),   // i18n-ignore: a command name
    nt = m.elems.length / 3, out = new Uint8Array(84 + 50 * nt), dv = new DataView(out.buffer);
  out.set(enc.encode(('CraftScript ' + name).slice(0, 80)));
  dv.setUint32(80, nt, true);
  const X = m.nodes;
  for (let t = 0; t < nt; t++) {
    const a = 3 * m.elems[3 * t], b = 3 * m.elems[3 * t + 1], c = 3 * m.elems[3 * t + 2];
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = 84 + 50 * t;
    [nx, ny, nz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]].forEach((x, k) => dv.setFloat32(o + 4 * k, x, true));
  }
  return out;
}
export function writeObj(v) {
  const m = triOf(v, 'save .obj'),   // i18n-ignore: a command name
    lines = ['# CraftScript'];
  for (let i = 0; i < m.nodes.length; i += 3) lines.push(`v ${m.nodes[i]} ${m.nodes[i + 1]} ${m.nodes[i + 2]}`);
  for (let t = 0; t < m.elems.length; t += 3) lines.push(`f ${m.elems[t] + 1} ${m.elems[t + 1] + 1} ${m.elems[t + 2] + 1}`);
  return enc.encode(lines.join('\n') + '\n');
}

// ─────────────────────────────────────────────────────────────── CSV
export function readCsv(bytes, name = 'data.csv', { delimiter = null, header = null } = {}) {
  const text = dec.decode(bytes).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { data: mat(0, 0), headers: [] };
  const d = delimiter || (lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
  const split = (l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
  let rows = lines.map(split);
  const isNum = (s) => s === '' || /^nan$/i.test(s) || /^[-+]?inf(inity)?$/i.test(s) || Number.isFinite(Number(s));
  let headers = [];
  if (header === true || (header === null && rows[0].some((s) => !isNum(s)))) { headers = rows[0]; rows = rows.slice(1); }
  const nc = Math.max(headers.length, ...rows.map((r) => r.length), 0), nr = rows.length;
  if (nr * nc > 2 ** 27) throw err(t('script.io.too_many_values', { name }));
  const out = new Float64Array(nr * nc).fill(NaN);
  rows.forEach((r, i) => r.forEach((s, j) => {
    const v = s === '' ? NaN : /^[-+]?inf(inity)?$/i.test(s) ? (s.startsWith('-') ? -Infinity : Infinity) : Number(s);
    if (s !== '' && Number.isNaN(v) && !/^nan$/i.test(s)) throw err(t('script.io.csv_nan', { name, row: i + 1 + (headers.length ? 1 : 0), col: j + 1, text: s.slice(0, 20) }));
    out[i + j * nr] = v;
  }));
  return { data: mat(nr, nc, out), headers };
}
export function writeCsv(v, headers = null) {
  // i18n-ignore: 'save .csv' is a command name
  const tc = asTensor(v, 'save .csv'), [n, m] = size2(tc, 'save .csv');
  const q = (s) => { s = String(s); if (/^[=+\-@]/.test(s)) s = '\'' + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [];
  if (headers && headers.length) lines.push(headers.map(q).join(','));
  for (let i = 0; i < n; i++) { const r = []; for (let j = 0; j < m; j++) { const x = tc.data[i + j * n]; r.push(Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Inf' : x === -Infinity ? '-Inf' : String(x)); } lines.push(r.join(',')); }
  return enc.encode(lines.join('\n') + '\n');
}

// ─────────────────────────────────────────────────────────────── JSON
const finite = (x) => (Number.isFinite(x) ? x : Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity');
/** A value → JSON-safe plain data (§2 shapes with arrays for typed arrays; non-finite numbers as strings). */
export function toJsonValue(v, depth = 0) {
  if (depth > 32) throw err(t('script.io.json_deep_save'));
  if (typeof v === 'number') return finite(v);
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (typeof x === 'bigint' ? Number(x) : finite(x)));
  if (Array.isArray(v)) return v.map((x) => toJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    if (v.t === 'func') throw err(t('script.io.save_func'));
    const o = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== 'function' && typeof x !== 'symbol') o[k] = toJsonValue(x, depth + 1);
    return o;
  }
  throw err(t('script.io.json_cannot', { type: typeof v }));
}
const reviveNums = (raw, depth = 0) => {   // "NaN"/"Infinity" back inside typed-array fields happens in readValue via Number()
  if (depth > 40 || !raw || typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return raw;
  for (const k of Object.keys(raw)) raw[k] = reviveNums(raw[k], depth + 1);
  return raw;
};
/** Plain JSON → a value: numbers, strings, bools; numeric arrays → row tensors; arrays of equal numeric rows → matrices;
 *  other arrays → cells; objects → structs; null → NaN. Objects with a "t" of a §2 type are read as values. */
export function fromJson(raw, depth = 0) {
  if (depth > 32) throw err(t('script.io.json_deep'));
  if (raw === null) return NaN;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    if (raw.length && raw.every((x) => typeof x === 'number')) return tensor([1, raw.length], raw);
    if (raw.length && raw.every((r) => Array.isArray(r) && r.length === raw[0].length && r.every((x) => typeof x === 'number'))) {
      const n = raw.length, m = raw[0].length, d = new Float64Array(n * m); raw.forEach((r, i) => r.forEach((x, j) => { d[i + j * n] = x; })); return mat(n, m, d);
    }
    return cell(raw.map((x) => fromJson(x, depth + 1)));
  }
  if (typeof raw === 'object') {
    if (typeof raw.t === 'string' && ['tensor', 'sparse', 'mesh', 'field', 'model', 'struct', 'cell'].includes(raw.t)) return readValue(reviveNums(raw));
    const f = {};
    for (const [k, x] of Object.entries(raw)) { const key = /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(k) ? k : ('x' + k.replace(/[^A-Za-z0-9_]/g, '_')).slice(0, 63); f[key] = fromJson(x, depth + 1); }
    return struct(f);
  }
  throw err(t('script.io.json_value'));
}

// ─────────────────────────────────────────────────────────────── NPY (NumPy format 1.0/2.0/3.0)
const NPY_TYPES = { f8: [Float64Array, 8, 'getFloat64'], f4: [Float32Array, 4, 'getFloat32'], i8: [null, 8, 'getBigInt64'], u8: [null, 8, 'getBigUint64'], i4: [Int32Array, 4, 'getInt32'], u4: [Uint32Array, 4, 'getUint32'], i2: [Int16Array, 2, 'getInt16'], u2: [Uint16Array, 2, 'getUint16'], i1: [Int8Array, 1, 'getInt8'], u1: [Uint8Array, 1, 'getUint8'], b1: [Uint8Array, 1, 'getUint8'] };
/** C-order data of shape s → column-major (Fortran) copy. */
export function cToF(src, shape) {
  const n = src.length, k = shape.length, out = new Float64Array(n);
  if (k <= 1) { out.set(src); return out; }
  const cs = new Array(k); cs[k - 1] = 1; for (let j = k - 2; j >= 0; j--) cs[j] = cs[j + 1] * shape[j + 1];
  const idx = new Array(k).fill(0);
  for (let f = 0; f < n; f++) {
    let c = 0; for (let j = 0; j < k; j++) c += idx[j] * cs[j];
    out[f] = src[c];
    for (let j = 0; j < k; j++) { if (++idx[j] < shape[j]) break; idx[j] = 0; }
  }
  return out;
}
export function fToC(src, shape) {
  const n = src.length, k = shape.length, out = new Float64Array(n);
  if (k <= 1) { out.set(src); return out; }
  const cs = new Array(k); cs[k - 1] = 1; for (let j = k - 2; j >= 0; j--) cs[j] = cs[j + 1] * shape[j + 1];
  const idx = new Array(k).fill(0);
  for (let f = 0; f < n; f++) {
    let c = 0; for (let j = 0; j < k; j++) c += idx[j] * cs[j];
    out[c] = src[f];
    for (let j = 0; j < k; j++) { if (++idx[j] < shape[j]) break; idx[j] = 0; }
  }
  return out;
}
const shapeOut = (s) => (s.length === 0 ? [1, 1] : s.length === 1 ? [s[0], 1] : s);
export function readNpy(bytes, name = 'data.npy') {
  if (bytes.length < 10 || bytes[0] !== 0x93 || dec.decode(bytes.subarray(1, 6)) !== 'NUMPY') throw err(t('script.io.npy_not', { name }));
  const major = bytes[6], dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true), h0 = major === 1 ? 10 : 12;
  if (h0 + hl > bytes.length) throw err(t('script.io.npy_header_end', { name }));
  const header = dec.decode(bytes.subarray(h0, h0 + hl));
  const descr = /'descr'\s*:\s*'([<>|=])([a-z]\d+)'/.exec(header), fo = /'fortran_order'\s*:\s*(True|False)/.exec(header), sh = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descr || !fo || !sh) throw err(t('script.io.npy_header', { name }));
  const T = NPY_TYPES[descr[2]];
  if (!T) throw err(t('script.io.npy_type', { name, type: descr[2] }));
  const shape = sh[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!shape.every((s) => Number.isInteger(s) && s >= 0)) throw err(t('script.io.npy_shape', { name }));
  const n = shape.reduce((a, b) => a * b, 1), size = T[1], off = h0 + hl;
  if (n > 2 ** 27) throw err(t('script.io.too_many_values', { name }));
  if (off + n * size > bytes.length) throw err(t('script.io.npy_short', { name }));
  const little = descr[1] !== '>';
  const data = new Float64Array(n);
  for (let i = 0; i < n; i++) { const x = dv[T[2]](off + i * size, little); data[i] = typeof x === 'bigint' ? Number(x) : x; }
  const s = shapeOut(shape);
  const out = fo[1] === 'True' ? data : cToF(data, shape.length ? shape : [1]);
  const tn = tensor(s, out);
  if (descr[2] === 'b1') tn.dtype = 'u8', tn.data = Uint8Array.from(out);
  return tn;
}
export function writeNpy(v) {
  const t = asTensor(v, 'save .npy');   // i18n-ignore: a command name
  const shape = t.shape.length === 2 && t.shape[1] === 1 ? [t.shape[0], 1] : t.shape;
  let header = `{'descr': '<f8', 'fortran_order': True, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += ' '.repeat(pad % 64) + '\n';
  const hb = enc.encode(header), out = new Uint8Array(10 + hb.length + 8 * t.data.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  new DataView(out.buffer).setUint16(8, hb.length, true);
  out.set(hb, 10);
  const body = new DataView(out.buffer, 10 + hb.length);
  for (let i = 0; i < t.data.length; i++) body.setFloat64(8 * i, t.data[i], true);
  return out;
}

// ─────────────────────────────────────────────────────────────── HDF5 (h5wasm)
let h5seq = 0;
const h5tmp = () => `/cs-${Date.now().toString(36)}-${++h5seq}.h5`;
const unlink = (FS, p) => { try { FS.unlink(p); } catch { /* gone */ } };
function writeH5Value(g, name, v, depth = 0) {
  if (depth > 32) throw err(t('script.io.h5_deep_save'));
  if (typeof v === 'number') { g.create_dataset({ name, data: new Float64Array([v]), shape: [] }); return; }
  if (typeof v === 'boolean') { const d = g.create_dataset({ name, data: new Uint8Array([v ? 1 : 0]), shape: [] }); d.create_attribute('cs_type', 'bool'); return; }
  if (typeof v === 'string') { g.create_dataset({ name, data: v }); return; }
  if (!v || typeof v !== 'object') throw err(t('script.io.h5_cannot', { type: typeName(v) }));
  switch (v.t) {
    case 'tensor': {
      const shape = v.shape.slice();
      const data = v.dtype === 'u8' ? Uint8Array.from(fToC(v.data, shape)) : v.dtype === 'i32' ? Int32Array.from(fToC(v.data, shape)) : fToC(v.data, shape);
      const d = g.create_dataset({ name, data, shape });
      if (v.dtype === 'u8') d.create_attribute('cs_type', 'logical');
      return;
    }
    case 'sparse': {
      const s = g.create_group(name);
      s.create_attribute('h5sparse_format', 'csr');
      s.create_attribute('h5sparse_shape', new Int32Array([v.n, v.m]));
      s.create_dataset({ name: 'data', data: Float64Array.from(v.val), shape: [v.val.length] });
      s.create_dataset({ name: 'indices', data: Int32Array.from(v.col), shape: [v.col.length] });
      s.create_dataset({ name: 'indptr', data: Int32Array.from(v.rowPtr), shape: [v.rowPtr.length] });
      return;
    }
    case 'struct': { const s = g.create_group(name); for (const [k, x] of Object.entries(v.fields)) writeH5Value(s, k, x, depth + 1); return; }
    case 'cell': { const s = g.create_group(name); s.create_attribute('cs_type', 'cell'); if (v.shape) s.create_attribute('cs_shape', new Int32Array(v.shape)); v.items.forEach((x, i) => writeH5Value(s, String(i + 1), x, depth + 1)); return; }
    case 'mesh': case 'field': case 'model': {
      const s = g.create_group(name); s.create_attribute('cs_type', v.t);
      for (const [k, x] of Object.entries(v)) {
        if (k === 't' || x === undefined || x === null) continue;
        if (ArrayBuffer.isView(x)) s.create_dataset({ name: k, data: x.slice(), shape: [x.length] });
        else if (typeof x === 'string' || typeof x === 'number') s.create_attribute(k, x);
        else if (typeof x === 'boolean') s.create_attribute(k, x ? 1 : 0);
        else if (Array.isArray(x)) { if (x.every((y) => typeof y === 'number')) s.create_attribute(k, Float64Array.from(x)); else s.create_attribute('json_' + k, JSON.stringify(toJsonValue(x))); }
        else if (typeof x === 'object' && x.t) writeH5Value(s, k, x, depth + 1);
        else if (typeof x === 'object') { const sub = s.create_group(k); sub.create_attribute('cs_type', 'object'); for (const [kk, y] of Object.entries(x)) { if (ArrayBuffer.isView(y)) sub.create_dataset({ name: kk, data: y.slice(), shape: [y.length] }); else if (typeof y === 'number' || typeof y === 'string') sub.create_attribute(kk, y); else if (Array.isArray(y) && y.every((q) => typeof q === 'number')) sub.create_attribute(kk, Float64Array.from(y)); } }
      }
      return;
    }
    default: throw err(t('script.io.h5_cannot', { type: typeName(v) }));
  }
}
/** Values ({name: value} or a struct) → HDF5 bytes. */
export function writeH5(vars) {
  const h5 = needH5(), path = h5tmp();
  const f = new h5.File(path, 'w');
  try {
    const entries = vars && vars.t === 'struct' ? Object.entries(vars.fields) : vars instanceof Map ? [...vars] : Object.entries(vars);
    for (const [k, v] of entries) writeH5Value(f, k, v);
  } finally { f.close(); }
  const bytes = h5.FS.readFile(path);
  unlink(h5.FS, path);
  return bytes;
}
const attrsOf = (o) => { const out = {}; try { for (const [k, a] of Object.entries(o.attrs || {})) out[k] = a.value; } catch { /* no attributes */ } return out; };
const toNum = (x) => (typeof x === 'bigint' ? Number(x) : x);
function readH5Entity(h5, e, depth = 0) {
  if (depth > 32) throw err(t('script.io.h5_deep'));
  const at = attrsOf(e);
  if (e instanceof h5.Dataset) {
    const shape = (e.shape || []).map(toNum), v = e.value;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return cell(v);
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number' || typeof v === 'bigint') return at.cs_type === 'bool' ? !!toNum(v) : toNum(v);
    if (typeof v === 'boolean') return v;
    if (!ArrayBuffer.isView(v)) throw err(t('script.io.h5_type'));
    const n = shape.reduce((a, b) => a * b, 1);
    if (v.length !== n) throw err(t('script.io.h5_size'));
    const f = cToF(Float64Array.from(v, toNum), shape.length ? shape : [1]);
    if (!shape.length && at.cs_type === 'bool') return !!f[0];
    if (!shape.length) return f[0];
    const tn = tensor(shapeOut(shape), f);
    if (at.cs_type === 'logical') { tn.dtype = 'u8'; tn.data = Uint8Array.from(f); }
    return tn;
  }
  if (e instanceof h5.Group) {
    const keys = e.keys();
    if (keys.length > 100000) throw err(t('script.io.h5_members'));
    if (at.h5sparse_format === 'csr' || (keys.includes('indptr') && keys.includes('indices') && keys.includes('data') && at.h5sparse_shape)) {
      const sh = Array.from(at.h5sparse_shape || [], toNum), val = Float64Array.from(e.get('data').value, toNum), col = Int32Array.from(e.get('indices').value, toNum), rowPtr = Int32Array.from(e.get('indptr').value, toNum);
      return readValue({ t: 'sparse', n: sh[0], m: sh[1], rowPtr, col, val });
    }
    const kids = {};
    for (const k of keys) { const c = e.get(k); if (c) kids[k] = readH5Entity(h5, c, depth + 1); }
    if (at.cs_type === 'cell') { const n = keys.length, items = []; for (let i = 1; i <= n; i++) items.push(kids[String(i)]); const shp = at.cs_shape ? Array.from(at.cs_shape, toNum) : null; return { t: 'cell', shape: shp && shp[0] * shp[1] === n ? shp : [n ? 1 : 0, n], items }; }
    if (['mesh', 'field', 'model'].includes(at.cs_type)) {
      const o = { t: at.cs_type };
      for (const [k, x] of Object.entries(at)) if (k !== 'cs_type') o[k.startsWith('json_') ? k.slice(5) : k] = k.startsWith('json_') ? JSON.parse(x) : ArrayBuffer.isView(x) ? Array.from(x, toNum) : toNum(x);
      for (const k of keys) {
        const c = e.get(k);
        if (c instanceof h5.Dataset) { const raw = c.value; o[k] = ['elems', 'triFace', 'elemIds', 'btri', 'bface', 'rowPtr', 'col'].includes(k) ? Int32Array.from(raw, toNum) : k === 'solid' ? Uint8Array.from(raw, toNum) : Float64Array.from(raw, toNum); }
        else if (attrsOf(c).cs_type === 'object') { const sub = {}; for (const [kk, x] of Object.entries(attrsOf(c))) if (kk !== 'cs_type') sub[kk] = ArrayBuffer.isView(x) ? Array.from(x, toNum) : toNum(x); for (const kk of c.keys()) { const raw = c.get(kk).value; sub[kk] = kk === 'solid' ? Uint8Array.from(raw, toNum) : Float64Array.from(raw, toNum); } o[k] = sub; }
        else o[k] = kids[k];
      }
      return o;
    }
    const f = {};
    for (const [k, x] of Object.entries(kids)) { const key = /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(k) ? k : ('x' + k.replace(/[^A-Za-z0-9_]/g, '_')).slice(0, 63); f[key] = x; }
    return struct(f);
  }
  return NaN;   // links, datatypes
}
/** HDF5 bytes → struct of the file's contents (or one dataset by path). */
export function readH5(bytes, { dataset = null } = {}) {
  const h5 = needH5(), path = h5tmp();
  const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];   // the superblock signature: at 0, 512, 1024, 2048 …
  let found = false;
  for (let o = 0; o + 8 <= bytes.length && !found; o = o ? o * 2 : 512) found = sig.every((b, i) => bytes[o + i] === b);
  if (!found) throw err(t('script.io.h5_sig'));
  h5.FS.writeFile(path, bytes);
  let f = null;
  try {
    try { f = new h5.File(path, 'r'); } catch { throw err(t('script.io.h5_damaged')); }
    if (dataset) { const e = f.get(dataset); if (!e) throw err(t('script.io.h5_no_dataset', { name: dataset, top: f.keys().slice(0, 12).join(', ') })); return readH5Entity(h5, e); }
    return readH5Entity(h5, f);
  } finally { try { f && f.close(); } catch { /* closed */ } unlink(h5.FS, path); }
}

// ─────────────────────────────────────────────────────────────── load / save dispatch
export function loadFile(name, opts = {}, nargout = 1) {
  const ext = extOf(name), bytes = readBytes(name);
  switch (ext) {
    case 'stl': return readStl(bytes, name);
    case 'obj': return readObj(bytes, name);
    case 'csv': case 'txt': { const r = readCsv(bytes, name, opts); return nargout > 1 ? [r.data, cell(r.headers)] : r.data; }
    case 'json': { let raw; try { raw = JSON.parse(dec.decode(bytes)); } catch (e) { throw err(t('script.io.json_bad', { name, why: e.message })); } return fromJson(raw); }
    case 'npy': return readNpy(bytes, name);
    case 'h5': case 'hdf5': return readH5(bytes, { dataset: typeof opts.dataset === 'string' ? opts.dataset : null });
    default: throw err(t('script.io.load_ext', { ext: ext || '?' }));
  }
}
export function saveFile(name, value, opts = {}) {
  const ext = extOf(name);
  let bytes, mime = 'application/octet-stream';
  switch (ext) {
    case 'stl': bytes = writeStl(value, name.replace(/\.[^.]*$/, '')); mime = 'model/stl'; break;
    case 'obj': bytes = writeObj(value); mime = 'model/obj'; break;
    case 'csv': case 'txt': bytes = writeCsv(value, opts.headers && opts.headers.t === 'cell' ? opts.headers.items.map(String) : null); mime = 'text/csv'; break;
    case 'json': bytes = enc.encode(JSON.stringify(toJsonValue(value))); mime = 'application/json'; break;
    case 'npy': bytes = writeNpy(value); break;
    case 'h5': case 'hdf5': bytes = writeH5(value && value.t === 'struct' ? value : { value }); mime = 'application/x-hdf5'; break;
    default: throw err(t('script.io.save_ext', { ext: ext || '?' }));
  }
  writeBytes(name, bytes, mime);
  return bytes.length;
}

// ─────────────────────────────────────────────────────────────── builtins
const strArg = (v, what) => { if (typeof v !== 'string') throw err(t('script.io.not_text', { what })); return v; };
/** name → [fn, signature]. The one-line help is the language file's script.doc.<name> (cs-runtime.js docKey), looked up when shown. */
export const BUILTINS = {
  load: [(a, ctx) => loadFile(strArg(a[0], t('script.io.what.load_file')), optsOf(a[1]), ctx && ctx.nargout), 'v = load(file, opts)'],
  save: [(a) => { if (a.length < 2) throw err(t('script.io.save_value')); return saveFile(strArg(a[0], t('script.io.what.save_file')), a[1], optsOf(a[2])); }, 'n = save(file, value, opts)'],
  files: [() => { const h = getIoHost(); return cell(h && h.listFiles ? h.listFiles() : []); }, 'c = files()'],
  part: [() => { const h = getIoHost(), p = h && h.part ? h.part() : null; if (!p) throw err(t('script.io.no_part')); return p; }, 'm = part()'],
  bodies: [() => { const h = getIoHost(), b = h && h.bodies ? h.bodies() : []; return cell(b || []); }, 'c = bodies()'],
  param: [(a) => {
    if (typeof a[0] !== 'string') throw err(t('script.io.param_text'));
    const name = a[0], all = partParams();
    if (!Object.hasOwn(all, name)) throw err(Object.keys(all).length ? t('script.io.no_param', { name, list: Object.keys(all).join(', ') }) : t('script.io.no_params', { name }));
    return all[name];
  }, 'v = param(name)'],
  params: [() => { const all = partParams(), fields = {}; for (const k of Object.keys(all)) fields[k] = all[k]; return { t: 'struct', fields }; }, 's = params()'],
};
/** The part's parameters with a value, as { name: number } (no host, or no part: none). */
function partParams() {
  const h = getIoHost(), raw = h && h.params ? h.params() : null, out = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}
/**
 * Register every builtin with cs-runtime.js. Runs once when this module is imported; calling
 * it again (or with another registry) is harmless. A name another module registered first is skipped (listed in `skipped`).
 */
export const skipped = [];
let registered = false;
export function register(registerBuiltin = rtRegisterBuiltin) {
  const own = registerBuiltin === rtRegisterBuiltin;
  if (own && registered) return skipped;
  for (const [name, [fn, args]] of Object.entries(BUILTINS)) {
    try { registerBuiltin(name, fn, { args, module: 'io' }); } catch { if (own) skipped.push(name); }   // doc: script.doc.<name> in the language file (cs-runtime.js docKey)
  }
  if (own) registered = true;
  return skipped;
}
register();
export { scalarOf };
