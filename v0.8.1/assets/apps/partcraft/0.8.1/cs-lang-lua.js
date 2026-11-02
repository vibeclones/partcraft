/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lang-lua.js — the Lua 5.4 language adapter (registers language 'lua', files .lua). DOM-free: script worker and Node.
 * Spec: docs/SCRIPTING-SPEC.md §3 "Lua 5.4" (builder B). Lua itself is the vendored wasmoon (assets/vendor/wasmoon/current,
 * MIT; Lua 5.4, MIT), imported the first time a Lua script runs; its glue.wasm is fetched from the same origin.
 *
 * What a Lua script sees:
 *   cs.<builtin>(…)          every registered builtin (cs.zeros(3, 3), cs.pcg(K, f), cs.voxelize(m, 2) …); one result
 *   cs.call(name, n, …)      the first n results of a builtin as n Lua values (local V, D = cs.call('eig', 2, A))
 *   cs.<library fn>(…)       0.4 P8: the analysis library (craftlib/) and the part's own CraftScript functions too —
 *                            cs.static_tet(t, 200e3, 0.3, bc), cs.call('modal_tet', 2, …). Found before the run, so write
 *                            the name literally (cs.name( or cs.call('name'); a name built at run time reaches builtins only
 *   cs.tensor(t)             a Lua table → tensor ({1, 2, 3} row; {{1, 2}, {3, 4}} matrix); cs.struct(t), cs.cell(t)
 *   ws.name / ws.name = v    the workspace (shared with every language); ws_names() lists it
 *   print(…)                 → the console;  display(cmd) → the canvas (same as cs.display)
 * Values: numbers, booleans, strings are Lua's own; a 1×1 tensor arrives as a number; other tensors, sparse matrices,
 * meshes, fields and models are userdata (metatable 'cs_value') with
 *   t(i, j) / t:get(i, j)    indexing (1-based; ':' for a whole dimension; tensors of indices), t[k] linear element
 *   t:set(i, j, v) / t[k] = v  assignment (copies first when the tensor is shared, e.g. a workspace value)
 *   t:shape() → {r, c}  t:size(k)  #t (number of elements)  t:numel()  t:type()  t:totable()  t:copy()  t:T() (transpose)
 *   + - * / ^ unary -        MATLAB meaning: * is the matrix product, / and ^ matrix divide/power (scalars as usual);
 *                            t:times(u) t:rdivide(u) t:power(u) elementwise; t:eq/ne/lt/le/gt/ge(u) → logical tensors
 *   == (same shape and values), tostring(t) (the CraftScript echo text)
 *   structs ↔ Lua tables with string keys, cells ↔ sequence tables.
 * Every global the script defines (not a function) lands in the workspace when the run ends; workspace values are also
 * pre-set as globals (unless the name is one of Lua's own). Instruction budget: a count hook every 1000 Lua instructions
 * calls ctx.check(1000); Stop/budget raise a Lua error that pcall cannot keep (it fires again at the next hook).
 * Sandbox: io, os (but os.clock/os.time/os.date), package/require, dofile, loadfile, debug and collectgarbage('...') beyond
 * 'count' are removed.
 */
import { registerLanguage } from './cs-runtime.js';
import { CsError, StopError, SHARED, typeOf, valueText, tensor as mkTensor, isTensor } from './cs-values.js';
import { binop, unop, matmul, solve, transpose, index as tIndex, assign as tAssign, COLON } from './cs-tensor.js';
import { vendorUrl } from './cs-lib-io.js';
import { hasBuiltin } from './cs-runtime.js';
import { VM } from './cs-vm.js';
import { loadLibrary } from './cs-lang-craft.js';
import { t } from './i18n.js';

export const highlight = {
  keywords: ['and', 'break', 'do', 'else', 'elseif', 'end', 'for', 'function', 'goto', 'if', 'in', 'local', 'not', 'or', 'repeat', 'return', 'then', 'until', 'while'],
  comment: ['--', '--[[', ']]'],
  string: ['"', "'"],
  number: true,
  constants: ['nil', 'true', 'false'],
};

// ─────────────────────────────────────────────────────────────── wasmoon (lazy)
let W = null, factory = null, loading = null;
export async function loadLua() {
  if (factory) return { W, factory };
  if (!loading) loading = (async () => {
    const m = await import(vendorUrl('wasmoonJs').url);
    W = m && m.LuaFactory ? m : m && m.default && m.default.LuaFactory ? m.default : globalThis.wasmoon;
    if (!W || !W.LuaFactory) throw new Error(t('script.lua.load'));
    factory = new W.LuaFactory(vendorUrl('wasmoonWasm').path);
    await factory.getLuaModule();
    return { W, factory };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** A CraftScript value inside Lua (the userdata's JS side). `v` is replaced on assignment. */
class Box { constructor(v) { this.v = v; } }

function makeExtension(thread) {
  const NAME = 'cs_value', L = thread.lua;
  class CsValueExtension extends W.LuaTypeExtension {
    constructor() {
      super(thread, NAME);
      this.gcPointer = L.module.addFunction((state) => { const p = L.luaL_checkudata(state, 1, NAME); L.unref(L.module.getValue(p, '*')); return 0; }, 'ii');
      if (L.luaL_newmetatable(thread.address, NAME)) {
        const mt = L.lua_gettop(thread.address);
        L.lua_pushcclosure(thread.address, this.gcPointer, 0);
        L.lua_setfield(thread.address, mt, '__gc');
      }
      L.lua_pop(thread.address, 1);
    }
    isType(_t, _i, type, name) { return type === W.LuaType.Userdata && name === NAME; }
    getValue(th, index) { const p = th.lua.lua_touserdata(th.address, index); return th.lua.getRef(th.lua.module.getValue(p, '*')); }
    pushValue(th, decorated) { return decorated.target instanceof Box ? super.pushValue(th, decorated) : false; }
    close() { L.module.removeFunction(this.gcPointer); }
  }
  return new CsValueExtension();
}

// ─────────────────────────────────────────────────────────────── value conversion
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
/** CraftScript value → what is pushed to Lua. */
export function toLua(v, depth = 0) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (depth > 32) throw new CsError(t('script.lua.deep_out'));
  if (isTensor(v) && v.data.length === 1 && v.shape.length === 2) return v.dtype === 'u8' ? v.data[0] !== 0 : v.data[0];
  if (v.t === 'struct') { const o = {}; for (const [k, x] of Object.entries(v.fields)) o[k] = toLua(x, depth + 1); return o; }
  if (v.t === 'cell') return v.items.map((x) => toLua(x, depth + 1));
  return new Box(v);
}
/** What Lua handed over → CraftScript value. */
export function fromLua(x, depth = 0) {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'bigint') return Number(x);
  if (x instanceof Box) return x.v;
  if (depth > 32) throw new CsError(t('script.lua.deep_in'));
  if (typeof x === 'function') throw new CsError(t('script.lua.function'));
  if (Array.isArray(x)) {
    if (x.length && x.every((y) => typeof y === 'number')) return mkTensor([1, x.length], Float64Array.from(x));
    if (x.length && x.every((r) => Array.isArray(r) && r.length === x[0].length && r.length && r.every((y) => typeof y === 'number'))) {
      const n = x.length, m = x[0].length, d = new Float64Array(n * m); x.forEach((r, i) => r.forEach((y, j) => { d[i + j * n] = y; })); return mkTensor([n, m], d);
    }
    if (x.length && x.every((y) => typeof y === 'boolean')) return mkTensor([1, x.length], Uint8Array.from(x, (b) => (b ? 1 : 0)));
    const items = x.map((y) => fromLua(y, depth + 1));
    return { t: 'cell', shape: [items.length ? 1 : 0, items.length], items };
  }
  if (typeof x === 'object') {
    const keys = Object.keys(x);
    if (!keys.length) return mkTensor([0, 0]);
    const f = {};
    for (const k of keys) { if (!NAME_RE.test(k)) throw new CsError(t('cs.python.err.field', { name: k.slice(0, 30) })); const y = fromLua(x[k], depth + 1); if (y !== undefined) f[k] = y; }
    return { t: 'struct', fields: f };
  }
  throw new CsError(t('script.lua.value', { type: typeof x }));
}
const argv = (list) => list.map((a) => fromLua(a)).filter((a, i, arr) => a !== undefined || i < arr.length - 1);
const idxArg = (a) => (a === ':' ? COLON : fromLua(a));
const isScalar = (v) => typeof v === 'number' || typeof v === 'boolean' || (isTensor(v) && v.data.length === 1);
const special = (v) => v && typeof v === 'object' && v.t && v.t !== 'tensor';

// ─────────────────────────────────────────────────────────────── the Lua side
const PRELUDE = String.raw`return function(J)
local reg = debug.getregistry()
local mt = reg.cs_value
local call1, calln, op, idx, setidx, meth, tostr, numel, eqv = J.call1, J.calln, J.op, J.idx, J.setidx, J.meth, J.tostr, J.numel, J.eqv
local wsget, wsset, wsnames, pr, disp = J.wsget, J.wsset, J.wsnames, J.print, J.display
local methods = {}
for _, name in ipairs({'get', 'set', 'shape', 'size', 'numel', 'type', 'totable', 'copy', 'T', 'times', 'rdivide', 'power', 'eq', 'ne', 'lt', 'le', 'gt', 'ge'}) do
  methods[name] = function(self, ...) return meth(name, self, ...) end
end
mt.__metatable = 'cs_value'
mt.__index = function(u, k) if type(k) == 'number' then return idx(u, k) end return methods[k] end
mt.__newindex = function(u, k, v) if type(k) == 'number' then setidx(u, k, v) else error('cannot set field ' .. tostring(k) .. ' of a ' .. meth('type', u), 2) end end
mt.__call = function(u, ...) return idx(u, ...) end
mt.__len = function(u) return numel(u) end
mt.__tostring = function(u) return tostr(u) end
mt.__eq = function(a, b) return eqv(a, b) end
mt.__lt = function(a, b) return op('lt1', a, b) end
mt.__le = function(a, b) return op('le1', a, b) end
mt.__unm = function(a) return op('uminus', a) end
for lname, opname in pairs({__add = 'plus', __sub = 'minus', __mul = 'mtimes', __div = 'mrdivide', __pow = 'mpower', __mod = 'mod', __idiv = 'idiv'}) do
  mt[lname] = function(a, b) return op(opname, a, b) end
end
-- a failing call raises its error at the script's line that made the call (0.4: it used to carry no line)
local pack, unpack, pcall0, err0 = table.pack, table.unpack, pcall, error
local tostr0 = tostring
local getinfo, setline = debug.getinfo, J.setline
-- raise is called (never tail-called) from the wrappers below: level 1 raise, 2 the wrapper, 3 the script's line
local function raise(e) local i = getinfo(3, 'l'); if i then setline(i.currentline) end err0(tostr0(e), 3) end
cs = setmetatable({}, { __index = function(t, name)
  local f = function(...) local r = pack(pcall0(call1, name, ...)); if not r[1] then raise(r[2]) end; return unpack(r, 2, r.n) end
  rawset(t, name, f); return f end })
cs.call = function(name, n, ...) local r = pack(pcall0(calln, name, n, ...)); if not r[1] then raise(r[2]) end; return unpack(r, 2, r.n) end
cs.tensor = function(t) return J.tensor(t) end
cs.struct = function(t) return J.struct(t) end
cs.cell = function(t) return J.cell(t) end
cs.display = function(cmd) return disp(cmd) end
display = cs.display
ws = setmetatable({}, { __index = function(_, k) return wsget(k) end, __newindex = function(_, k, v) wsset(k, v) end })
ws_names = function() return wsnames() end
print = function(...) local n = select('#', ...); local t = {}; for i = 1, n do t[i] = tostring((select(i, ...))) end; pr(table.concat(t, '\t')) end
local keepos = { clock = os.clock, time = os.time, date = os.date }
os = keepos
io, package, require, dofile, loadfile, debug = nil, nil, nil, nil, nil, nil
local cg = collectgarbage
collectgarbage = function(opt) if opt == nil or opt == 'count' then return cg('count') end error('collectgarbage: only "count" is available', 2) end
end
`;
const LUA_OWN = new Set(['_G', '_VERSION', 'assert', 'collectgarbage', 'coroutine', 'error', 'getmetatable', 'ipairs', 'load', 'math', 'next', 'os', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'select', 'setmetatable', 'string', 'table', 'tonumber', 'tostring', 'type', 'utf8', 'warn', 'xpcall', 'cs', 'ws', 'ws_names', 'display', 'require', 'package', 'io', 'debug', 'dofile', 'loadfile']);

/** Parse "script:12: message" (and wasmoon's wrappers) → { message, line }. */
export function luaError(e, file) {
  let msg = e && e.message ? e.message : String(e);
  msg = msg.replace(/^Error:\s*/, '').replace(/\nstack traceback:[\s\S]*$/, '');
  const chunk = (file || 'script').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|\\s)' + chunk + ':(\\d+):\\s*([\\s\\S]*)$').exec(msg) || /\[string "[^"]*"\]:(\d+):\s*([\s\S]*)$/.exec(msg) || /^[^:\s]+:(\d+):\s*([\s\S]*)$/.exec(msg);
  return m ? { message: m[2].trim(), line: +m[1], col: null } : { message: msg.trim(), line: null, col: null };
}

export const adapter = {
  id: 'lua',
  highlight,
  async run(source, { ws, call, ctx }) {
    await loadLua();
    const file = ctx.file || 'script';
    // 0.4 P8: library functions the script names (cs.name( / cs.call('name') that are not builtins, loaded into a CraftScript VM
    const OWN = new Set(['call', 'tensor', 'struct', 'cell', 'display']);
    const wanted = new Set([...String(source).matchAll(/\bcs\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]).filter((n) => !OWN.has(n)));
    for (const m of String(source).matchAll(/\bcs\s*\.\s*call\s*\(\s*(['"])([A-Za-z_]\w*)\1/g)) wanted.add(m[2]);
    const vm = new VM({ rt: { ...ctx, call } });
    let libNames = new Set();
    try { libNames = new Set(await loadLibrary(vm, [...wanted].filter((n) => !hasBuiltin(n)), ctx.library)); } catch (e) { return { ok: false, error: { message: e.message, line: null, col: null, file: ctx.file || null }, vars: [] }; }
    /** A library function's outputs (≥ n), with an error inside it saying where. */
    const callLib = (name, args, n) => {
      try { const r = vm.callUnit(vm.lib.get(name).unit, args, n, vm.lib.get(name).locals); vm.flushSteps(); return r; } catch (e) {
        if (e instanceof StopError) throw e;
        const at = e && e.line ? ' ' + t('cs.lua.lib_at', { file: e.file || name + '.craft', line: e.line }) : '';
        const msg = e && e.message ? e.message : String(e);
        throw new CsError(`${msg.startsWith(name + ' ') ? '' : name + ': '}${msg}${at}`);
      }
    };
    const callAny = (name, args, n) => (libNames.has(name) ? (n > 1 ? callLib(name, args, n) : callLib(name, args, 1)[0]) : call(name, args, n));
    const engine = await factory.createEngine({ enableProxy: false, injectObjects: false, openStandardLibs: true });
    const G = engine.global, Lw = G.lua;
    let stopped = null, hookPtr = 0, callLine = 0;
    const ext = makeExtension(G);
    G.registerTypeExtension(10, ext);
    const guard = (fn) => (...a) => {
      if (stopped) throw stopped;
      try { return fn(...a); } catch (e) { if (e instanceof StopError) stopped = e; throw e; }
    };
    const out = (v) => toLua(v);
    const doOp = (name, a, b) => {
      const A = fromLua(a), B = fromLua(b);
      if (special(A) || special(B)) return call(name === 'lt1' || name === 'le1' ? name.slice(0, 2) : name, B === undefined ? [A] : [A, B]);
      switch (name) {
        case 'plus': return binop('+', A, B);
        case 'minus': return binop('-', A, B);
        case 'uminus': return unop('neg', A);
        case 'mtimes': return isScalar(A) || isScalar(B) ? binop('.*', A, B) : matmul(A, B);
        case 'mrdivide': return isScalar(B) ? binop('./', A, B) : transpose(solve(transpose(B), transpose(A)));
        case 'mpower': {
          if (isScalar(A) && isScalar(B)) return binop('.^', A, B);
          const k = typeof B === 'number' ? B : NaN;
          if (!Number.isInteger(k) || k < 0) throw new CsError(t('script.lua.mpower'));
          let r = null, base = A;
          for (let e = k; e > 0; e >>= 1) { if (e & 1) r = r ? matmul(r, base) : base; if (e > 1) base = matmul(base, base); }
          if (!r) { const n = A.shape[0], I = new Float64Array(n * n); for (let i = 0; i < n; i++) I[i * (n + 1)] = 1; r = mkTensor([n, n], I); }
          return r;
        }
        case 'mod': return binop('mod', A, B);
        case 'idiv': return unop('floor', binop('./', A, B));
        case 'lt1': case 'le1': {
          if (!isScalar(A) || !isScalar(B)) throw new CsError(t('script.lua.compare'));
          const r = binop(name === 'lt1' ? '<' : '<=', A, B); return typeof r === 'boolean' ? r : !!(isTensor(r) ? r.data[0] : r);
        }
        default: throw new CsError(t('cs.python.err.op', { name }));
      }
    };
    const getIdx = (u, ...ix) => {
      const v = fromLua(u);
      if (special(v)) return out(call('subsref', [v, { type: '()', subs: ix.map(idxArg) }]));
      return out(tIndex(v, ix.map(idxArg)));
    };
    const setIdx = (u, ...rest) => {
      if (!(u instanceof Box)) throw new CsError(t('script.lua.assign_tensor'));
      const rhs = fromLua(rest.pop()), v = u.v;
      if (!isTensor(v)) throw new CsError(t('script.lua.assign_type', { type: typeOf(v) }));
      u.v = tAssign(v, rest.map(idxArg), rhs, !v[SHARED]);
    };
    const toTable = (v) => {
      if (!isTensor(v)) throw new CsError(t('script.lua.totable'));
      const [r, c] = v.shape;
      if (v.shape.length > 2) return Array.from(v.data);
      if (r === 1 || c === 1) return Array.from(v.data, Number);
      const rows = []; for (let i = 0; i < r; i++) { const row = []; for (let j = 0; j < c; j++) row.push(v.data[i + j * r]); rows.push(row); }
      return rows;
    };
    const method = (name, u, ...a) => {
      const v = fromLua(u);
      switch (name) {
        case 'get': return getIdx(u, ...a);
        case 'set': setIdx(u, ...a); return u;
        case 'shape': return typeOf(v) === 'sparse' ? [v.n, v.m] : isTensor(v) ? v.shape.slice() : [1, 1];
        case 'size': { const s = typeOf(v) === 'sparse' ? [v.n, v.m] : isTensor(v) ? v.shape : [1, 1]; return a.length ? (s[a[0] - 1] ?? 1) : s.slice(); }
        case 'numel': return isTensor(v) ? v.data.length : typeOf(v) === 'sparse' ? v.n * v.m : 1;
        case 'type': return typeOf(v);
        case 'totable': return toTable(v);
        case 'copy': return isTensor(v) ? new Box(mkTensor(v.shape, v.data.slice())) : u;
        case 'T': return out(special(v) ? call('transpose', [v]) : transpose(v));
        case 'times': return out(special(v) ? call('times', [v, fromLua(a[0])]) : binop('.*', v, fromLua(a[0])));
        case 'rdivide': return out(special(v) ? call('rdivide', [v, fromLua(a[0])]) : binop('./', v, fromLua(a[0])));
        case 'power': return out(binop('.^', v, fromLua(a[0])));
        case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': return out(binop({ eq: '==', ne: '~=', lt: '<', le: '<=', gt: '>', ge: '>=' }[name], v, fromLua(a[0])));
        default: throw new CsError(t('cs.python.err.method', { name }));
      }
    };
    const eqv = (a, b) => {
      const A = fromLua(a), B = fromLua(b);
      if (!isTensor(A) || !isTensor(B)) return A === B;
      if (A.shape.join() !== B.shape.join()) return false;
      for (let i = 0; i < A.data.length; i++) if (A.data[i] !== B.data[i]) return false;
      return true;
    };
    const J = {
      call1: guard((name, ...a) => out(callAny(String(name), argv(a), 1))),
      calln: guard((name, n, ...a) => { n = Math.max(1, Math.min(16, n | 0)); const r = callAny(String(name), argv(a), n); const m = new W.LuaMultiReturn(); for (const x of (n > 1 ? r : [r])) m.push(out(x)); return m; }),
      op: guard((name, a, b) => out(doOp(name, a, b))),
      idx: guard(getIdx),
      setidx: guard(setIdx),
      meth: guard(method),
      tostr: guard((u) => { const v = fromLua(u); return typeOf(v) === 'tensor' || typeOf(v) === 'sparse' ? valueText(v) : `[${typeOf(v)}${v.kind ? ' ' + v.kind : ''}]`; }),
      numel: guard((u) => method('numel', u)),
      eqv: guard(eqv),
      tensor: guard((tbl) => { const v = fromLua(tbl); return out(isTensor(v) ? v : typeof v === 'number' ? mkTensor([1, 1], Float64Array.of(v)) : (() => { throw new CsError(t('script.lua.tensor_arg')); })()); }),
      struct: guard((t) => out(fromLua(t && typeof t === 'object' && !Array.isArray(t) ? t : {}))),
      cell: guard((t) => out({ t: 'cell', shape: [1, (t || []).length], items: (t || []).map((x) => fromLua(x)) })),
      wsget: guard((k) => out(ws.get(String(k)))),
      wsset: guard((k, v) => ws.set(String(k), fromLua(v))),
      wsnames: guard(() => ws.names()),
      print: guard((s) => ctx.print(String(s) + '\n')),
      display: guard((cmd) => { const c = fromLua(cmd); ctx.display(c && c.t === 'struct' ? c.fields : c); }),
      setline: (n) => { callLine = n | 0; },   // the script line of the call that failed (wasmoon rethrows the JS error, dropping Lua's position)
    };
    try {
      // the prelude (with debug available), then the sandboxed globals snapshot
      engine.doStringSync(PRELUDE)(J);
      for (const name of ws.names()) if (!LUA_OWN.has(name)) { try { G.set(name, toLua(ws.get(name))); } catch { /* not representable */ } }
      const before = new Set(engine.doStringSync('local t = {} for k in pairs(_G) do t[#t + 1] = k end return t') || []);
      const T = G.newThread(), tIndexOnStack = G.getTop();
      hookPtr = Lw.module.addFunction((L) => {
        try { if (stopped) throw stopped; ctx.check(1000); } catch (e) {
          if (e instanceof StopError) stopped = e;
          T.pushValue(e && e.message ? e.message : String(e));
          Lw.lua_error(L);
        }
      }, 'vii');
      Lw.lua_sethook(T.address, hookPtr, 8 /* LUA_MASKCOUNT */, 1000);
      let error = null;
      try {
        T.loadString(String(source), '=' + file);
        await T.run(0);
      } catch (e) { error = e; }
      Lw.lua_sethook(T.address, null, 0, 0);
      G.remove(tIndexOnStack);
      if (stopped) return { ok: false, error: { message: stopped.message, line: null, col: null, file: ctx.file || null, stopped: true }, vars: [] };
      // globals → workspace
      const vars = [];
      const names = engine.doStringSync('local t = {} for k, v in pairs(_G) do if type(k) == "string" and type(v) ~= "function" and type(v) ~= "thread" then t[#t + 1] = k end end return t') || [];
      for (const k of names) {
        if (LUA_OWN.has(k) || (before.has(k) && !ws.has(k)) || !NAME_RE.test(k)) continue;
        try { const v = fromLua(G.get(k)); if (v !== undefined && v !== ws.get(k)) { ws.set(k, v); vars.push(k); } } catch { /* a value CraftScript cannot hold: left in Lua */ }
      }
      if (error) { const le = luaError(error, file); if (le.line === null && callLine > 0) le.line = callLine; return { ok: false, error: { ...le, file: ctx.file || null }, vars }; }
      return { ok: true, vars };
    } finally {
      try { engine.global.close(); } catch { /* closed */ }
      if (hookPtr) try { Lw.module.removeFunction(hookPtr); } catch { /* gone */ }
    }
  },
};

registerLanguage({ id: 'lua', name: 'Lua', ext: ['.lua'], load: async () => { await loadLua(); return adapter; } });
