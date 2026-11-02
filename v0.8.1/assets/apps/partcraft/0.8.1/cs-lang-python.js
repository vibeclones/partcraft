/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lang-python.js — Python as a CraftScript language (registers 'python', files .py; 0.4 P10, 0.5 on CPython for WASI).
 * DOM-free: script worker and Node. Python itself is CPython's own WebAssembly build (assets/vendor/cpython-wasi/current:
 * python.wasm + python-stdlib.zip, PSF License; wasi-libc permissive; tools/partcraft-python/vendor.mjs makes the folder),
 * fetched the first time a Python script runs (about 5 MB over the network) and run by wasi.js. No extra packages (no numpy):
 * the apps fetch nothing from outside.
 *
 * What a Python script sees (numpy-like, 0-based):
 *   cs.<builtin>(…)          every registered builtin, the analysis library and the part's own CraftScript functions (written
 *                            literally, as in Lua: cs.name( or cs.call('name')); one result
 *   cs.call(name, n, …)      the first n results as a tuple:  V, D = cs.call('eig', 2, A)
 *   cs.tensor(list)          a list → tensor ([1, 2, 3] a row; [[1, 2], [3, 4]] a matrix); lists passed to builtins convert too
 *   ws.name / ws.name = v    the workspace (shared with every language); ws_names() lists it; workspace values are also
 *                            globals at the start
 *   print(…)                 → the console;  display(cmd) → the canvas (cs.display)
 * Values: numbers, booleans, strings are Python's own; a 1×1 tensor arrives as a float; structs ↔ dicts; cells ↔ lists; other
 * tensors, sparse matrices, meshes, fields and models are `Value`s:
 *   + - * / ** elementwise, @ the matrix product, unary -; < <= > >= == != elementwise (a logical Value)
 *   v[i, j] 0-based (ints, negative from the end, slices, lists or Values of indices, a logical Value as a mask); a vector takes
 *   one index; v[i] on a matrix is row i;  v[i, j] = x assigns (copying a shared value first)
 *   v.shape (tuple) v.T v.type v.numel() v.copy() v.tolist() len(v) (rows) float(v) int(v) bool(v) (one element) repr(v)
 * Every global the script makes (not a module, function, class or a name starting with _) lands in the workspace when the run
 * ends. Instruction budget: every 1000 executed lines the run checks the budget and Stop.
 * SEALED, like CraftScript and Lua: each run is a fresh CPython in its own WebAssembly instance that sees only an in-memory file
 * tree (the standard library, /tmp) and one device, /dev/cs, through which every cs. and ws. call goes as JSON text and is
 * answered at once (wasi.js devices). No network, no real files, no JavaScript reachable from Python.
 */
import { registerLanguage, hasBuiltin } from './cs-runtime.js';
import { CsError, StopError, SHARED, typeOf, valueText, tensor as mkTensor, isTensor } from './cs-values.js';
import { binop, unop, matmul, transpose, index as tIndex, assign as tAssign, COLON } from './cs-tensor.js';
import { vendorUrl } from './cs-lib-io.js';
import { MemFS, Wasi, unzip } from './wasi.js';
import { VM } from './cs-vm.js';
import { loadLibrary } from './cs-lang-craft.js';
import { t } from './i18n.js';

export const highlight = {
  keywords: ['False', 'None', 'True', 'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
  comment: ['#'],
  string: ['"', "'"],
  number: true,
  constants: ['None', 'True', 'False'],
};

// ─────────────────────────────────────────────────────────────── CPython for WASI
let py = null, loading = null;
const NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof window === 'undefined';
/** The bytes of a vendored file (Node: the file; else fetched). */
async function vendorBytes(key) {
  const v = vendorUrl(key);
  if (NODE && !/^(https?|blob|data):/.test(v.path)) return new Uint8Array(await process.getBuiltinModule('fs').promises.readFile(v.path));
  const r = await fetch(v.url);
  if (!r.ok) throw new Error(t('cs.python.err.load'));
  return new Uint8Array(await r.arrayBuffer());
}
/** CPython, loaded once: the compiled module and the standard library's directory (shared by every run, read only). */
export async function loadPython() {
  if (py) return py;
  if (!loading) loading = (async () => {
    const [wasm, stdlib] = await Promise.all([vendorBytes('cpythonWasm'), vendorBytes('cpythonStdlib')]);
    const module = await WebAssembly.compile(wasm);
    const tree = new MemFS();
    for (const [name, bytes] of await unzip(stdlib)) tree.writeFile('/lib/python3.14/' + name, bytes);
    tree.mkdirp('/lib/python3.14/lib-dynload');   // where CPython looks for extension modules (there are none)
    py = { module, lib: tree.lookup('/lib') };
    return py;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// ─────────────────────────────────────────────────────────────── values across the bridge (JSON + handles)
let cur = null;   // the run in progress: { ws, call, ctx, callAny, handles: Map, seq, stopped }
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const isScalar = (v) => typeof v === 'number' || typeof v === 'boolean' || (isTensor(v) && v.data.length === 1);
const special = (v) => v && typeof v === 'object' && v.t && v.t !== 'tensor';
const num = (x) => (Number.isFinite(x) ? x : { $f: Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf' });

/** A CraftScript value → its JSON-able form for Python. */
function enc(v, depth = 0) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (depth > 32) throw new CsError(t('cs.python.err.deep_out'));
  if (isTensor(v) && v.data.length === 1 && v.shape.length === 2) return v.dtype === 'u8' ? v.data[0] !== 0 : num(v.data[0]);
  if (v.t === 'struct') { const o = {}; for (const [k, x] of Object.entries(v.fields)) o[k] = enc(x, depth + 1); return { $s: o }; }
  if (v.t === 'cell') return { $c: v.items.map((x) => enc(x, depth + 1)) };
  const h = ++cur.seq;
  cur.handles.set(h, v);
  return { $h: h, k: typeOf(v) };
}
/** Python's JSON form → a CraftScript value. */
function dec(x, depth = 0) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string') return x;
  if (depth > 32) throw new CsError(t('cs.python.err.deep_in'));
  if (Array.isArray(x)) {
    if (x.length && x.every((y) => typeof y === 'number' || (y && y.$f))) return mkTensor([1, x.length], Float64Array.from(x, (y) => dec(y)));
    if (x.length && x.every((r) => Array.isArray(r) && r.length === x[0].length && r.length && r.every((y) => typeof y === 'number' || (y && y.$f)))) {
      const n = x.length, m = x[0].length, d = new Float64Array(n * m); x.forEach((r, i) => r.forEach((y, j) => { d[i + j * n] = dec(y); })); return mkTensor([n, m], d);
    }
    if (x.length && x.every((y) => typeof y === 'boolean')) return mkTensor([1, x.length], Uint8Array.from(x, (b) => (b ? 1 : 0)));
    const items = x.map((y) => dec(y, depth + 1));
    return { t: 'cell', shape: [items.length ? 1 : 0, items.length], items };
  }
  if (typeof x === 'object') {
    if (x.$f) return x.$f === 'nan' ? NaN : x.$f === 'inf' ? Infinity : -Infinity;
    if (x.$h !== undefined) { if (!cur.handles.has(x.$h)) throw new CsError(t('cs.python.err.gone')); return cur.handles.get(x.$h); }
    if (x.$s) {
      const f = {};
      for (const [k, y] of Object.entries(x.$s)) { if (!NAME_RE.test(k)) throw new CsError(t('cs.python.err.field', { name: k.slice(0, 30) })); const v = dec(y, depth + 1); if (v !== undefined) f[k] = v; }
      return { t: 'struct', fields: f };
    }
  }
  throw new CsError(t('cs.python.err.value'));
}
const J = (s) => JSON.parse(s);
const out = (v) => JSON.stringify(enc(v));
const guard = (fn) => (...a) => {
  if (cur.stopped) throw cur.stopped;
  try { return fn(...a); } catch (e) { if (e instanceof StopError) cur.stopped = e; throw e; }
};

/** Tensor arithmetic as Python spells it (numpy conventions: * / ** elementwise, @ the matrix product). */
function doOp(name, A, B) {
  if (special(A) || special(B)) return cur.call({ plus: 'plus', minus: 'minus', times: 'times', rdivide: 'rdivide', power: 'power', mtimes: 'mtimes', uminus: 'uminus' }[name] || name, B === undefined ? [A] : [A, B]);
  switch (name) {
    case 'plus': return binop('+', A, B);
    case 'minus': return binop('-', A, B);
    case 'times': return binop('.*', A, B);
    case 'rdivide': return binop('./', A, B);
    case 'power': return binop('.^', A, B);
    case 'mod': return binop('mod', A, B);
    case 'floordiv': return unop('floor', binop('./', A, B));
    case 'mtimes': return isScalar(A) || isScalar(B) ? binop('.*', A, B) : matmul(A, B);
    case 'uminus': return unop('neg', A);
    case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': return binop({ eq: '==', ne: '~=', lt: '<', le: '<=', gt: '>', ge: '>=' }[name], A, B);
    default: throw new CsError(t('cs.python.err.op', { name }));
  }
}
const idxArg = (a) => (a === ':' ? COLON : dec(a));

/** The functions Python reaches (as JSON requests on /dev/cs). Every argument and result is JSON text, a number or a string. */
const BRIDGE = Object.freeze({
  call1: (name, args) => guard(() => out(cur.callAny(String(name), J(args).map((a) => dec(a)), 1)))(),
  calln: (name, n, args) => guard(() => { n = Math.max(1, Math.min(16, n | 0)); const r = cur.callAny(String(name), J(args).map((a) => dec(a)), n); return JSON.stringify((n > 1 ? r : [r]).map((x) => enc(x))); })(),
  op: (name, a, b) => guard(() => out(doOp(String(name), dec(J(a)), b === undefined || b === null ? undefined : dec(J(b)))))(),
  getidx: (a, ix) => guard(() => { const v = dec(J(a)); const I = J(ix).map(idxArg); return out(special(v) ? cur.call('subsref', [v, { type: '()', subs: I }]) : tIndex(v, I)); })(),
  setidx: (a, ix, b) => guard(() => {
    const v = dec(J(a));
    if (!isTensor(v)) throw new CsError(t('cs.python.err.assign', { type: typeOf(v) }));
    return out(tAssign(v, J(ix).map(idxArg), dec(J(b)), !v[SHARED]));
  })(),
  meth: (name, a) => guard(() => {
    const v = dec(J(a));
    switch (String(name)) {
      case 'shape': return JSON.stringify(typeOf(v) === 'sparse' ? [v.n, v.m] : isTensor(v) ? v.shape.slice() : [1, 1]);
      case 'type': return JSON.stringify(typeOf(v));
      case 'numel': return JSON.stringify(isTensor(v) ? v.data.length : typeOf(v) === 'sparse' ? v.n * v.m : 1);
      case 'T': return out(special(v) ? cur.call('transpose', [v]) : transpose(v));
      case 'copy': return out(isTensor(v) ? mkTensor(v.shape, v.data.slice()) : v);
      case 'logical': return JSON.stringify(isTensor(v) && v.dtype === 'u8');
      case 'tolist': {
        if (!isTensor(v)) throw new CsError(t('cs.python.err.tolist'));
        const [r, c] = v.shape, x = (i) => num(v.dtype === 'u8' ? v.data[i] : v.data[i]);
        if (v.shape.length > 2 || r === 1 || c === 1) return JSON.stringify(Array.from(v.data, (_, i) => x(i)));
        const rows = []; for (let i = 0; i < r; i++) { const row = []; for (let j = 0; j < c; j++) row.push(x(i + j * r)); rows.push(row); }
        return JSON.stringify(rows);
      }
      case 'repr': return typeOf(v) === 'tensor' || typeOf(v) === 'sparse' ? valueText(v) : `[${typeOf(v)}${v.kind ? ' ' + v.kind : ''}]`;
      default: throw new CsError(t('cs.python.err.method', { name }));
    }
  })(),
  tensor: (a) => guard(() => { const v = dec(J(a)); return out(typeof v === 'number' ? mkTensor([1, 1], Float64Array.of(v)) : v); })(),
  drop: (h) => { cur?.handles.delete(h | 0); },
  wsget: (k) => guard(() => out(cur.ws.get(String(k))))(),
  wsset: (k, v) => guard(() => { if (!NAME_RE.test(String(k))) throw new CsError(t('cs.python.err.var', { name: String(k).slice(0, 30) })); cur.ws.set(String(k), dec(J(v))); })(),
  wsnames: () => JSON.stringify(cur.ws.names()),
  display: (cmd) => guard(() => { const c = dec(J(cmd)); cur.ctx.display(c && c.t === 'struct' ? c.fields : c); })(),
  check: (n) => guard(() => { cur.ctx.check(n | 0); })(),
  keep: (k, v) => guard(() => { cur.vars.push([String(k), dec(J(v))]); })(),
});

// ─────────────────────────────────────────────────────────────── the Python side (run once at load)
const PRELUDE = String.raw`
import json as _json, math as _math, sys as _sys, builtins as _bi, os as _os, traceback as _tb

# the host: every call is one JSON request written to /dev/cs and its answer read back at once
_fd = _os.open('/dev/cs', _os.O_RDWR)
class CraftScriptError(Exception):
    pass
class _Stopped(BaseException):
    pass
def _rpc(*a):
    _os.write(_fd, _json.dumps(a).encode())
    parts = []
    while True:
        b = _os.read(_fd, 1 << 20)
        if not b: break
        parts.append(b)
    r = _json.loads(b''.join(parts))
    if 'e' in r:
        if r.get('stop'): raise _Stopped(r['e'])
        raise CraftScriptError(r['e'])
    return r.get('r')
class _Host:
    def __getattr__(self, name):
        def f(*a): return _rpc(name, *a)
        return f
_J = _Host()

def _enc(x, d=0):
    if d > 32: raise ValueError('value nested too deeply for CraftScript')
    if x is None or isinstance(x, (bool, str)): return x
    if isinstance(x, (int, float)):
        x = float(x)
        return x if _math.isfinite(x) else {'$f': 'nan' if x != x else ('inf' if x > 0 else '-inf')}
    if isinstance(x, Value): return {'$h': x._h}
    if isinstance(x, dict): return {'$s': {str(k): _enc(v, d + 1) for k, v in x.items()}}
    if isinstance(x, (list, tuple, range)): return [_enc(v, d + 1) for v in x]
    raise TypeError('a ' + type(x).__name__ + ' cannot be passed to CraftScript')

def _dec(x):
    if isinstance(x, dict):
        if '$h' in x: return Value(x['$h'], x.get('k'))
        if '$f' in x: return {'nan': float('nan'), 'inf': float('inf'), '-inf': float('-inf')}[x['$f']]
        if '$s' in x: return {k: _dec(v) for k, v in x['$s'].items()}
        if '$c' in x: return [_dec(v) for v in x['$c']]
    return x

def _j(x): return _json.dumps(_enc(x))
def _o(s): return _dec(_json.loads(s))

class Value:
    """A CraftScript value: tensor, sparse matrix, mesh, field, model (numpy-like, 0-based)."""
    __slots__ = ('_h', '_k')
    def __init__(self, h, k=None): self._h = h; self._k = k
    def __del__(self):
        try: _J.drop(self._h)
        except Exception: pass
    def _op(self, name, other=None, swap=False):
        a, b = (other, self) if swap else (self, other)
        return _o(_J.op(name, _j(a), None if (b is None and not swap) else _j(b)))
    def __add__(s, o): return s._op('plus', o)
    def __radd__(s, o): return s._op('plus', o, True)
    def __sub__(s, o): return s._op('minus', o)
    def __rsub__(s, o): return s._op('minus', o, True)
    def __mul__(s, o): return s._op('times', o)
    def __rmul__(s, o): return s._op('times', o, True)
    def __truediv__(s, o): return s._op('rdivide', o)
    def __rtruediv__(s, o): return s._op('rdivide', o, True)
    def __floordiv__(s, o): return s._op('floordiv', o)
    def __mod__(s, o): return s._op('mod', o)
    def __pow__(s, o): return s._op('power', o)
    def __rpow__(s, o): return s._op('power', o, True)
    def __matmul__(s, o): return s._op('mtimes', o)
    def __rmatmul__(s, o): return s._op('mtimes', o, True)
    def __neg__(s): return _o(_J.op('uminus', _j(s), None))
    def __pos__(s): return s
    def __lt__(s, o): return s._op('lt', o)
    def __le__(s, o): return s._op('le', o)
    def __gt__(s, o): return s._op('gt', o)
    def __ge__(s, o): return s._op('ge', o)
    def __eq__(s, o): return s._op('eq', o)
    def __ne__(s, o): return s._op('ne', o)
    __hash__ = None
    @property
    def shape(s): return tuple(_json.loads(_J.meth('shape', _j(s))))
    @property
    def type(s): return _json.loads(_J.meth('type', _j(s)))
    @property
    def T(s): return _o(_J.meth('T', _j(s)))
    def numel(s): return _json.loads(_J.meth('numel', _j(s)))
    def copy(s): return _o(_J.meth('copy', _j(s)))
    def tolist(s): return [_dec(v) for v in _json.loads(_J.meth('tolist', _j(s)))]
    def __len__(s): return s.shape[0]
    def __iter__(s):
        r, c = s.shape[0], s.shape[1] if len(s.shape) > 1 else 1
        if r == 1 or c == 1:
            for i in range(r * c): yield s[i]
        else:
            for i in range(r): yield s[i]
    def _one(s):
        v = s.tolist()
        while isinstance(v, list) and len(v) == 1: v = v[0]
        if isinstance(v, list): raise ValueError('a Value of ' + str(s.numel()) + ' elements has no single value')
        return v
    def __float__(s): return float(s._one())
    def __int__(s): return int(s._one())
    def __index__(s): return int(s._one())
    def __bool__(s): return bool(s._one())
    def __repr__(s): return _J.meth('repr', _j(s))
    __str__ = __repr__
    def _ix(s, k):
        sh = s.shape
        if not isinstance(k, tuple):
            n = 1
            for d in sh: n *= d
            # a vector takes one index; so does a logical mask (element by element, like numpy's a[a > 0])
            if (len(sh) == 2 and (sh[0] == 1 or sh[1] == 1)) or (isinstance(k, Value) and _json.loads(_J.meth('logical', _j(k)))): return [s._ax(k, n)]
            k = (k, slice(None))
        if len(k) != len(sh): raise IndexError('give ' + str(len(sh)) + ' indices (or one for a vector)')
        return [s._ax(i, n) for i, n in zip(k, sh)]
    def _ax(s, i, n):
        if isinstance(i, slice):
            if i == slice(None): return ':'
            return [j + 1 for j in range(*i.indices(n))]
        if isinstance(i, Value):
            if _json.loads(_J.meth('logical', _j(i))): return _enc(i)
            return _enc(i + 1)
        if isinstance(i, (list, tuple, range)): return [(j % n if j < 0 else j) + 1 for j in i]
        if isinstance(i, bool) or not isinstance(i, int): raise IndexError('indices are whole numbers, slices or lists')
        if i < -n or i >= n: raise IndexError('index ' + str(i) + ' is out of range for ' + str(n))
        return (i % n) + 1
    def __getitem__(s, k): return _o(_J.getidx(_j(s), _json.dumps(s._ix(k))))
    def __setitem__(s, k, v):
        r = _json.loads(_J.setidx(_j(s), _json.dumps(s._ix(k)), _j(v)))
        old = s._h
        if isinstance(r, dict) and '$h' in r: s._h = r['$h']
        _J.drop(old)

class _CS:
    def __getattr__(self, name):
        if name.startswith('_'): raise AttributeError(name)
        def f(*a): return _o(_J.call1(name, _j(list(a))))
        f.__name__ = name
        return f
    def call(self, name, n, *a): return tuple(_dec(v) for v in _json.loads(_J.calln(name, n, _j(list(a)))))
    def tensor(self, x): return x if isinstance(x, Value) else _o(_J.tensor(_j(x)))
    def struct(self, d=None): return dict(d or {})
    def cell(self, items=()): return list(items)
    def display(self, cmd): _J.display(_j(cmd))

class _WS:
    def __getattr__(self, k):
        if k.startswith('_'): raise AttributeError(k)
        return _o(_J.wsget(k))
    def __setattr__(self, k, v): _J.wsset(k, _j(v))
    def __call__(self): return _json.loads(_J.wsnames())

cs = _CS()
ws = _WS()
def ws_names(): return _json.loads(_J.wsnames())
def display(cmd): cs.display(cmd)

def _run(src, file, ns):
    code = compile(src, file, 'exec')
    count = [0]
    def tr(frame, event, arg):
        if event == 'line':
            count[0] += 1
            if count[0] >= 1000:
                count[0] = 0
                _J.check(1000)
        return tr
    _sys.settrace(tr)
    try: exec(code, ns)
    finally: _sys.settrace(None)

def _keep(ns, before):
    import types as _t
    for k, v in list(ns.items()):
        if k.startswith('_') or k in before or isinstance(v, (_t.ModuleType, _t.FunctionType, type, _CS, _WS)) or callable(v): continue
        try: _J.keep(k, _j(v))
        except Exception: pass

def _fresh(names):
    ns = {'__name__': '__main__', '__builtins__': _bi, 'cs': cs, 'ws': ws, 'ws_names': ws_names, 'display': display, 'Value': Value}
    for k in names:
        try: ns[k] = _o(_J.wsget(k))
        except Exception: pass
    return ns

def _main():
    job = _rpc('job')
    ns = _fresh(job['names'])
    before = set(job['own'])
    try:
        _run(job['src'], job['file'], ns)
    except _Stopped:
        raise
    except SystemExit:
        pass
    except BaseException as e:
        _keep(ns, before)
        _rpc('error', ''.join(_tb.format_exception(e)))
        return
    _keep(ns, before)

_main()
`;
const PY_OWN = new Set(['cs', 'ws', 'ws_names', 'display', 'Value']);

/** A Python traceback (text) → { message, line } for the script's own file. */
export function pyError(e, file) {
  const text = e && e.message ? String(e.message) : String(e);
  const esc = (file || 'script').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let line = null;
  for (const m of text.matchAll(new RegExp('File "' + esc + '", line (\\d+)', 'g'))) line = +m[1];
  const last = text.trim().split('\n').filter((l) => l.trim()).pop() || text;
  // an error raised in CraftScript keeps its words; Python's own keep their names (ZeroDivisionError: …)
  const msg = /^(?:__main__\.)?CraftScriptError:/.test(last) ? last.replace(/^(?:__main__\.)?CraftScriptError:\s*/, '').trim() : last.trim();
  return { message: msg, line, col: null };
}

export const adapter = {
  id: 'python',
  highlight,
  async run(source, { ws, call, ctx }) {
    const P = await loadPython();
    const file = ctx.file || 'script.py';
    // library functions the script names (cs.name( / cs.call('name')) that are not builtins, as in Lua (0.4 P8)
    const wanted = new Set([...String(source).matchAll(/\bcs\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]).filter((n) => !['call', 'tensor', 'struct', 'cell', 'display'].includes(n)));
    for (const m of String(source).matchAll(/\bcs\s*\.\s*call\s*\(\s*(['"])([A-Za-z_]\w*)\1/g)) wanted.add(m[2]);
    const vm = new VM({ rt: { ...ctx, call } });
    let libNames = new Set();
    try { libNames = new Set(await loadLibrary(vm, [...wanted].filter((n) => !hasBuiltin(n)), ctx.library)); } catch (e) { return { ok: false, error: { message: e.message, line: null, col: null, file: ctx.file || null }, vars: [] }; }
    const callLib = (name, args, n) => {
      try { const r = vm.callUnit(vm.lib.get(name).unit, args, n, vm.lib.get(name).locals); vm.flushSteps(); return r; } catch (e) {
        if (e instanceof StopError) throw e;
        const at = e && e.line ? ' ' + t('cs.lua.lib_at', { file: e.file || name + '.craft', line: e.line }) : '';
        const msg = e && e.message ? e.message : String(e);
        throw new CsError(`${msg.startsWith(name + ' ') ? '' : name + ': '}${msg}${at}`);
      }
    };
    const callAny = (name, args, n) => (libNames.has(name) ? (n > 1 ? callLib(name, args, n) : callLib(name, args, 1)[0]) : call(name, args, n));
    cur = { ws, call, ctx, callAny, handles: new Map(), seq: 0, stopped: null, vars: [] };
    // the run's own file tree: the shared (read-only) standard library, /tmp, the program, the host device
    const fs = new MemFS();
    fs.root.entries.set('lib', P.lib);
    fs.mkdirp('/tmp');
    fs.writeFile('/run/main.py', PRELUDE);
    let answer = new Uint8Array(0), error = null;
    const job = { src: String(source), file, names: ws.names().filter((k) => !PY_OWN.has(k)), own: [...PY_OWN, '__name__', '__builtins__'] };
    const enc = new TextEncoder(), decIn = new TextDecoder();
    fs.device('/dev/cs', {
      write(bytes) {
        let reply;
        try {
          const [name, ...args] = JSON.parse(decIn.decode(bytes));
          if (name === 'job') reply = { r: job };
          else if (name === 'error') { error = String(args[0] || ''); reply = { r: null }; }
          else if (Object.hasOwn(BRIDGE, name)) reply = { r: BRIDGE[name](...args) ?? null };
          else reply = { e: t('cs.python.err.host', { name: String(name).slice(0, 40) }) };
        } catch (e) {
          reply = { e: e && e.message ? e.message : String(e), ...(e instanceof StopError ? { stop: true } : {}) };
        }
        answer = enc.encode(JSON.stringify(reply));
      },
      read(max) { const out = answer.subarray(0, max); answer = answer.subarray(out.length); return out; },
    });
    const outDec = new TextDecoder(), errDec = new TextDecoder();
    const w = new Wasi({
      args: ['python', '-I', '-B', '-u', '-X', 'utf8', '/run/main.py'], fs,
      stdout: (b) => ctx.print(outDec.decode(b, { stream: true })), stderr: (b) => ctx.print(errDec.decode(b, { stream: true })),
    });
    try {
      const inst = await WebAssembly.instantiate(P.module, { wasi_snapshot_preview1: w.imports });
      try { w.start(inst); } catch (e) { if (!cur.stopped) error = error || (e && e.message ? e.message : String(e)); }
      if (cur.stopped) return { ok: false, error: { message: cur.stopped.message, line: null, col: null, file: ctx.file || null, stopped: true }, vars: [] };
      // globals → workspace (changed or new), even after an error: what was computed is kept
      const vars = [];
      for (const [k, v] of cur.vars) { if (v !== undefined && NAME_RE.test(k) && v !== ws.get(k)) { ws.set(k, v); vars.push(k); } }
      if (error) return { ok: false, error: { ...pyError(error, file), file: ctx.file || null }, vars };
      return { ok: true, vars };
    } finally {
      cur = null;
    }
  },
};

registerLanguage({ id: 'python', name: 'Python', ext: ['.py'], load: async () => { await loadPython(); return adapter; } });
