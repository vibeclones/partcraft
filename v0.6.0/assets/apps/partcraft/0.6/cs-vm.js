/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-vm.js — the CraftScript stack VM: runs units from cs-compile.js. DOM-free.
 *
 *   const vm = new VM({ rt })            rt = the runtime's builtin ctx ({ call, invoke, print, display, check, ws, … })
 *   vm.addFunctions(map, locals)         library functions (name → unit), each with its file's own local table
 *   vm.runScript(unit, ws, locals)       → names written to the workspace (throws CsError with line/col/file/csStack)
 *   vm.callUnit(unit, args, nargout, locals) → values[]
 *
 * Values are cs-values.js values; tensor maths runs in cs-tensor.js kernels on typed arrays. A tensor marked SHARED is
 * copied before an indexed write; unshared ones are written in place (x(i) = v in a loop is O(1)).
 * Steps are counted per instruction and reported to rt.check() on every backward jump and call.
 */
import { CsError, StopError, SHARED, CALL, tensor, empty, isTensor, typeOf, describe, sizeOf, displayText, num, cell, struct, func, prodOf } from './cs-values.js';
import { OP, BINOPS, UNOPS } from './cs-compile.js';
import * as K from './cs-tensor.js';
import { methodFor, hasBuiltin } from './cs-runtime.js';
import { t } from './i18n.js';

export const NOVALUE = Object.freeze({ t: 'novalue' });
class CsList { constructor(items) { this.items = items; } }
const MAX_DEPTH = 256;
const OPNAME = { '+': 'plus', '-': 'minus', '*': 'mtimes', '/': 'mrdivide', '\\': 'mldivide', '^': 'mpower', '.*': 'times', './': 'rdivide', '.\\': 'ldivide', '.^': 'power', '==': 'eq', '~=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '&': 'and', '|': 'or' };
const UNNAME = { '-': 'uminus', '+': 'uplus', '~': 'not', "'": 'ctranspose', ".'": 'transpose' };
const isDenseLike = (v) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || (v !== null && typeof v === 'object' && v.t === 'tensor');
const mark = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) v[SHARED] = true; return v; };

function flatten(arr) {
  let has = false;
  for (const a of arr) if (a instanceof CsList) { has = true; break; }
  if (!has) return arr;
  const out = [];
  for (const a of arr) if (a instanceof CsList) out.push(...a.items); else out.push(a);
  return out;
}
// What single() names in its message, looked up only when it throws (single runs on every condition and assignment).
const WHAT_COND = () => t('script.vm.what.condition');
const WHAT_RHS = () => t('script.vm.what.rhs');
function single(v, what = null) {
  if (v instanceof CsList) { if (v.items.length === 1) return v.items[0]; if (!v.items.length) throw new CsError(t('script.vm.no_value', { what: what ? what() : t('script.vm.what.expr') })); return v.items[0]; }
  if (v === NOVALUE) throw new CsError(t('script.vm.no_return', { what: what ? what() : t('script.vm.what.expr') }));
  return v;
}

/** Binary operator on any values (dense fast paths, then type methods). */
export function binary(op, a, b, rt) {
  if (a instanceof CsList || a === NOVALUE) a = single(a);
  if (b instanceof CsList || b === NOVALUE) b = single(b);
  if (!isDenseLike(a) || !isDenseLike(b)) {
    const m = methodFor(OPNAME[op], [a, b]);
    if (m) return m([a, b], { ...rt, nargout: 1 });
    const bad = !isDenseLike(a) ? a : b;
    throw new CsError(t('script.vm.op_value', { op, got: describe(bad) }));
  }
  switch (op) {
    case '*': return K.matmul(a, b);
    case '/': {
      if (typeof b === 'number' || typeof b === 'boolean' || (isTensor(b) && b.data.length === 1)) return K.binop('./', a, b);
      return K.transpose(K.solve(K.transpose(b), K.transpose(a)));
    }
    case '\\': {
      if (typeof a === 'number' || typeof a === 'boolean' || (isTensor(a) && a.data.length === 1)) return K.binop('.\\', a, b);
      return K.solve(a, b);
    }
    case '^': {
      const sa = typeof a === 'number' || typeof a === 'boolean' || (isTensor(a) && a.data.length === 1);
      const sb = typeof b === 'number' || typeof b === 'boolean' || (isTensor(b) && b.data.length === 1);
      if (sa && sb) return K.binop('.^', a, b);
      if (!sb) throw new CsError(t('script.vm.mpower_matrix'));
      const p = num(b), [r, c] = sizeOf(a);
      if (r !== c) throw new CsError(t('script.vm.mpower_square', { size: `${r}×${c}` }));
      if (!Number.isInteger(p)) throw new CsError(t('script.vm.mpower_whole'));
      let base = p < 0 ? K.solve(a, eye(r)) : a, e = Math.abs(p), out = eye(r);
      while (e > 0) { if (e & 1) out = K.matmul(out, base); base = K.matmul(base, base); e >>= 1; }
      return out;
    }
    default: return K.binop(op, a, b);
  }
}
function eye(n) { const t = tensor([n, n]); for (let i = 0; i < n; i++) t.data[i + i * n] = 1; return t; }

export function unary(op, a, rt) {
  if (a instanceof CsList || a === NOVALUE) a = single(a);
  if (!isDenseLike(a)) {
    const m = methodFor(UNNAME[op], [a]);
    if (m) return m([a], { ...rt, nargout: 1 });
    throw new CsError(op === "'" || op === ".'" ? t('script.vm.transpose_value', { got: describe(a) }) : t('script.vm.op_value', { op, got: describe(a) }));
  }
  if (op === '-') return K.unop('neg', a);
  if (op === '~') return K.unop('not', a);
  if (op === '+') return typeof a === 'string' ? K.unop('plus', a) : a;
  return K.transpose(a);
}

/** v(args) for any value (paren indexing). */
export function subsParen(v, args, rt) {
  if (isDenseLike(v) || (v && v.t === 'cell')) return K.index(v, args);
  const m = methodFor('subsref', [v]);
  if (m) {
    // MATLAB's vector rule: one index into an n×1 / 1×m matrix means S(i, 1) / S(1, i)
    if (args.length === 1 && v.t === 'sparse' && (v.m === 1 || v.n === 1)) args = v.m === 1 ? [args[0], 1] : [1, args[0]];
    return m([v, ...args], { ...rt, nargout: 1 });
  }
  if (v && v.t === 'struct') {
    if (args.every((a) => K.isColon(a) || (typeof a === 'number' && a === 1) || (isTensor(a) && a.data.length === 1 && a.data[0] === 1))) return v;
    throw new CsError(t('script.vm.struct_index'));
  }
  throw new CsError(t('script.tensor.no_index', { got: describe(v) }));
}
function fieldOf(v, name, rt) {
  if (v && v.t === 'struct') {
    if (!Object.hasOwn(v.fields, name)) {
      const ks = Object.keys(v.fields);
      throw new CsError(ks.length ? t('script.vm.no_field_list', { name, list: ks.slice(0, 12).join(', ') + (ks.length > 12 ? ', …' : '') }) : t('script.vm.no_field', { name }));
    }
    return mark(v.fields[name]);
  }
  if (v && typeof v === 'object' && typeof v.t === 'string' && v.t !== 'tensor' && v.t !== 'cell') {
    if (Object.hasOwn(v, name) && name !== 't') {
      const x = v[name];
      if (ArrayBuffer.isView(x)) return mark(tensor([x.length, 1], x instanceof Float64Array || x instanceof Int32Array || x instanceof Uint8Array ? x : Float64Array.from(x)));
      if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x;
      if (x && typeof x === 'object' && typeof x.t === 'string') return mark(x);
      if (Array.isArray(x) && x.every((y) => typeof y === 'number')) return tensor([1, x.length], Float64Array.from(x));
    }
    throw new CsError(t('script.vm.value_no_field', { got: describe(v), name }));
  }
  throw new CsError(t('script.vm.not_struct_field', { got: describe(v), name }));
}
function braceItems(v, args) {
  if (!v || v.t !== 'cell') throw new CsError(t('script.vm.brace_arrays', { got: describe(v) }));
  const sub = K.index(v, args);
  return sub.items.map(mark);
}

/** Column k of a value for a for-loop. */
function forColumns(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return { n: 1, get: () => v };
  if (typeof v === 'string') return { n: v.length, get: (k) => v[k] };
  if (isTensor(v)) {
    const s = v.shape, r = s[0], n = r === 0 ? 0 : v.data.length / r;
    const logical = v.dtype === 'u8';
    if (r === 1) return { n, get: (k) => (logical ? v.data[k] !== 0 : v.data[k]) };
    return { n, get: (k) => tensor([r, 1], v.data.slice(k * r, (k + 1) * r)) };
  }
  if (v && v.t === 'cell') { const [r, c] = sizeOf(v); return { n: r ? c : 0, get: (k) => cell(v.items.slice(k * r, (k + 1) * r), [r, 1]) }; }
  if (v && v.t === 'sparse') throw new CsError(t('script.vm.for_sparse'));
  return { n: 1, get: () => v };
}

function caseMatches(x, vals) {
  if (vals && vals.t === 'cell') return vals.items.some((y) => caseMatches(x, y));
  if (typeof x === 'string' || typeof vals === 'string') return typeof x === 'string' && typeof vals === 'string' && x === vals;
  try {
    if (isTensor(vals) && vals.data.length !== 1) return false;
    return num(x) === num(vals);
  } catch { return false; }
}

function scalarTruth(v, op) {
  v = single(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (v !== v) throw new CsError(t('script.vm.nan_logical', { op })); return v !== 0; }
  if (isTensor(v) && v.data.length === 1) return v.data[0] !== 0;
  throw new CsError(t('script.vm.shortcircuit', { op, got: describe(v) }));
}

export class VM {
  constructor({ rt }) {
    this.rt = rt;              // builtin ctx from cs-runtime createRuntime (call, invoke, print, display, check, ws, …)
    this.lib = new Map();      // library name → { unit, locals }
    this.depth = 0;
    this.steps = 0;
  }
  addFunctions(map, locals) { for (const [name, unit] of map) if (!this.lib.has(name)) this.lib.set(name, { unit, locals: locals || map }); }

  /** Is `name` callable from this file (local, library or builtin)? */
  resolvable(name, locals) { return !!(locals?.get(name) || this.lib.has(name) || hasBuiltin(name) || INTRINSICS.has(name)); }

  /** Run a script unit against the workspace; returns the names it wrote (or cleared). */
  runScript(unit, ws, locals) {
    const slots = new Array(unit.nslots);
    for (let s = 0; s < unit.nslots; s++) { const nm = unit.names[s]; if (nm[0] !== '%' && ws.has(nm)) slots[s] = mark(ws.get(nm)); }
    const frame = { unit, slots, nargin: 0, nargout: 0, locals, ws, script: true, cleared: new Set() };
    let err = null;
    try { this.exec(frame); } catch (e) { err = e; }
    const written = [];
    for (let s = 0; s < unit.nslots; s++) {
      const nm = unit.names[s];
      if (nm[0] === '%') continue;
      const v = slots[s];
      if (v === undefined) { if (frame.cleared.has(nm) && ws.has(nm)) { ws.delete(nm); written.push(nm); } continue; }
      if (v === NOVALUE || v instanceof CsList) continue;
      if (ws.get(nm) !== v) written.push(nm);
      ws.set(nm, v);
    }
    if (err) { err.vars = written; throw err; }
    return written;
  }

  callUnit(unit, args, nargout, locals) {
    const np = unit.params.length;
    const vararg = np && unit.params[np - 1] === 'varargin';
    if (args.length > np && !vararg) throw new CsError(t('script.vm.too_many_inputs', { name: unit.name, n: np, given: args.length }));
    const slots = new Array(unit.nslots);
    if (vararg) {
      for (let i = 0; i < np - 1 && i < args.length; i++) slots[i] = args[i];
      const rest = args.slice(np - 1);
      slots[np - 1] = cell(rest, [rest.length ? 1 : 1, rest.length]);
    } else for (let i = 0; i < args.length; i++) slots[i] = args[i];
    const outs = unit.outs, no = outs.length;
    const varout = no && outs[no - 1] === 'varargout';
    if (nargout > no && !varout) throw new CsError(t('script.vm.too_many_outputs', { name: unit.name, n: no, asked: nargout }));
    const frame = { unit, slots, nargin: args.length, nargout, locals, script: false };
    if (++this.depth > MAX_DEPTH) { this.depth = 0; throw new CsError(t('script.vm.deep_recursive', { n: MAX_DEPTH })); }
    try { this.exec(frame); } finally { this.depth--; }
    const want = Math.max(nargout, nargout === 0 ? 0 : 1);
    const vals = [];
    for (let i = 0; i < no && vals.length < Math.max(want, 1); i++) {
      if (varout && i === no - 1) {
        const c = slots[unit.outSlots[i]];
        if (c !== undefined) { if (!c || c.t !== 'cell') throw new CsError(t('script.vm.varargout', { name: unit.name })); vals.push(...c.items); }
        break;
      }
      const v = slots[unit.outSlots[i]];
      if (v === undefined) {
        if (i < want) throw new CsError(t('script.vm.out_unset', { out: outs[i], name: unit.name }));
        break;
      }
      vals.push(v);
    }
    if (vals.length < nargout) throw new CsError(t('script.vm.gave_outputs', { name: unit.name, n: vals.length, asked: nargout }));
    return vals;
  }

  callAnon(clo, args, nargout) {
    const u = clo.unit;
    if (args.length > u.params.length) throw new CsError(t('script.vm.anon_inputs', { n: u.params.length, given: args.length }));
    const slots = new Array(u.nslots);
    for (let i = 0; i < args.length; i++) slots[i] = args[i];
    for (let i = 0; i < clo.capture.length; i += 2) slots[clo.capture[i + 1]] = clo.values[i >> 1];
    const frame = { unit: u, slots, nargin: args.length, nargout: Math.max(1, nargout), locals: clo.locals, script: false, anon: true };
    if (++this.depth > MAX_DEPTH) { this.depth = 0; throw new CsError(t('script.vm.deep', { n: MAX_DEPTH })); }
    try { return this.exec(frame); } finally { this.depth--; }
  }

  /** Call a function by name: local → library → intrinsic → builtin. Returns values[] (≥ nargout; [] allowed for 0). */
  callName(name, args, nargout, frame) {
    const loc = frame.locals?.get(name);
    if (loc) return this.callUnit(loc, args, nargout, frame.locals);
    const g = this.lib.get(name);
    if (g) return this.callUnit(g.unit, args, nargout, g.locals);
    const intr = INTRINSICS.get(name);
    if (intr) return intr(this, frame, args, nargout);
    if (!hasBuiltin(name) && !methodFor(name, args)) throw new CsError(t('script.vm.unknown_name', { name }));
    this.flushSteps();
    const r = this.rt.call(name, args, nargout);
    if (nargout > 1) {
      if (!Array.isArray(r) || r.length < nargout) throw new CsError(t('script.vm.gives_outputs', { name, n: Array.isArray(r) ? r.length : 1, asked: nargout }));
      for (const v of r) for (const a of args) if (v === a) mark(v);
      return r;
    }
    if (r === undefined) { if (nargout >= 1) throw new CsError(t('script.vm.no_return', { what: name })); return []; }
    for (const a of args) if (r === a) mark(r);
    return [r];
  }

  /** A func value for a named function, callable later (keeps this file's local functions). */
  handle(name, locals) {
    const vm = this;
    return func('craft', name, (args, nargout) => vm.callName(name, args, nargout, { locals, script: false }));
  }
  closure(spec, slots, locals) {
    const values = [];
    for (let i = 0; i < spec.capture.length; i += 2) { const v = slots[spec.capture[i]]; values.push(v === undefined ? undefined : mark(v)); }
    const clo = { unit: spec.unit, capture: spec.capture, values, locals };
    const vm = this;
    const f = func('craft', spec.unit.text || 'anonymous', (args, nargout) => vm.callAnon(clo, args, nargout));
    return f;
  }
  invokeValue(f, args, nargout) {
    if (typeof f[CALL] === 'function') return f[CALL](args, nargout);
    const r = this.rt.invoke(f, args, nargout);
    return nargout > 1 ? r : r === undefined ? [] : [r];
  }

  flushSteps() { if (this.steps) { const n = this.steps; this.steps = 0; this.rt.check(n); } }

  undefinedName(frame, s) {
    const name = frame.unit.names[s];
    if (this.resolvable(name, frame.locals)) { const r = this.callName(name, [], 1, frame); return r[0]; }
    throw new CsError(t('script.vm.unset', { name }));
  }

  exec(frame) {
    const { unit, slots } = frame;
    const code = unit.code, consts = unit.consts, rt = this.rt;
    const st = [];
    const endSt = [], lvSt = [], handlers = [];
    let sp = 0, pc = 0, cur = 0;
    for (;;) {
      try {
        for (;;) {
          cur = pc;
          this.steps++;
          switch (code[pc]) {
            case OP.CONST: st[sp++] = consts[code[pc + 1]]; pc += 2; break;
            case OP.LOAD: { let v = slots[code[pc + 1]]; if (v === undefined) v = this.undefinedName(frame, code[pc + 1]); st[sp++] = v; pc += 2; break; }
            case OP.LOADS: { let v = slots[code[pc + 1]]; if (v === undefined) v = this.undefinedName(frame, code[pc + 1]); st[sp++] = mark(v); pc += 2; break; }
            case OP.STORE: { const v = st[--sp]; slots[code[pc + 1]] = v instanceof CsList || v === NOVALUE ? single(v, WHAT_RHS) : v; pc += 2; break; }
            case OP.POP: sp--; pc += 1; break;
            case OP.DUP: st[sp] = st[sp - 1]; sp++; pc += 1; break;
            case OP.CALLN: {
              const name = consts[code[pc + 1]], nargs = code[pc + 2];
              let nargout = code[pc + 3];
              if (nargout === -1) nargout = frame.nargout;
              const args = flatten(st.slice(sp - nargs, sp));
              sp -= nargs;
              for (let i = 0; i < args.length; i++) if (args[i] === NOVALUE) throw new CsError(t('script.vm.arg_no_value', { i: i + 1, name }));
              const vals = this.callName(name, args, nargout, frame);
              if (nargout === 0) st[sp++] = vals.length ? vals[0] : NOVALUE;
              else for (let i = 0; i < nargout; i++) st[sp++] = vals[i];
              pc += 4;
              break;
            }
            case OP.INDEX: {
              const nargs = code[pc + 1];
              let nargout = code[pc + 2];
              if (nargout === -1) nargout = frame.nargout;
              const args = flatten(st.slice(sp - nargs, sp));
              sp -= nargs;
              const base = single(st[--sp]);
              if (base && base.t === 'func') {
                const vals = this.invokeValue(base, args, nargout);
                if (nargout === 0) st[sp++] = vals.length ? vals[0] : NOVALUE;
                else { if (vals.length < nargout) throw new CsError(t('script.vm.fn_gave_values', { n: vals.length, asked: nargout })); for (let i = 0; i < nargout; i++) st[sp++] = vals[i]; }
              } else {
                if (nargout > 1) throw new CsError(t('script.vm.paren_one_value'));
                st[sp++] = subsParen(base, args, rt);
              }
              pc += 4;
              break;
            }
            case OP.BRACE: {
              const nargs = code[pc + 1], nargout = code[pc + 2] === -1 ? frame.nargout : code[pc + 2], inArgs = code[pc + 3];
              const args = flatten(st.slice(sp - nargs, sp));
              sp -= nargs;
              const items = braceItems(single(st[--sp]), args);
              if (nargout > 1) { if (items.length < nargout) throw new CsError(t('script.vm.cell_gives_values', { n: items.length, asked: nargout })); for (let i = 0; i < nargout; i++) st[sp++] = items[i]; }
              else if (items.length === 1) st[sp++] = items[0];
              else if (inArgs) st[sp++] = new CsList(items);
              else if (!items.length) throw new CsError(t('script.vm.brace_nothing'));
              else st[sp++] = new CsList(items);
              pc += 4;
              break;
            }
            case OP.FIELD: st[sp - 1] = fieldOf(single(st[sp - 1]), consts[code[pc + 1]], rt); pc += 2; break;
            case OP.DFIELD: { const nm = single(st[--sp]); if (typeof nm !== 'string') throw new CsError(t('script.vm.dyn_field')); st[sp - 1] = fieldOf(single(st[sp - 1]), nm, rt); pc += 1; break; }
            case OP.ENDPUSH: endSt.push(single(st[sp - 1])); pc += 1; break;
            case OP.ENDPOP: endSt.pop(); pc += 1; break;
            case OP.ENDV: {
              const v = endSt[endSt.length - 1];
              if (v && v.t === 'func') throw new CsError(t('script.vm.end_handle'));
              st[sp++] = K.sizeAlong(v === undefined ? empty() : v, code[pc + 1], code[pc + 2]);
              pc += 3;
              break;
            }
            case OP.BIN: {
              const b = st[--sp], a = st[sp - 1], op = BINOPS[code[pc + 1]];
              if (typeof a === 'number' && typeof b === 'number') {
                let r;
                switch (op) {
                  case '+': r = a + b; break; case '-': r = a - b; break;
                  case '*': case '.*': r = a * b; break; case '/': case './': r = a / b; break;
                  case '<': r = a < b; break; case '>': r = a > b; break; case '<=': r = a <= b; break; case '>=': r = a >= b; break;
                  case '==': r = a === b; break; case '~=': r = a !== b; break;
                  default: r = binary(op, a, b, rt);
                }
                st[sp - 1] = r;
              } else st[sp - 1] = binary(op, a, b, rt);
              pc += 2;
              break;
            }
            case OP.UN: { const a = st[sp - 1]; const op = UNOPS[code[pc + 1]]; st[sp - 1] = typeof a === 'number' ? (op === '-' ? -a : op === '~' ? a === 0 : a) : unary(op, a, rt); pc += 2; break; }
            case OP.RANGE: {
              const b = single(st[--sp]), s = single(st[--sp]), a = single(st[--sp]);
              st[sp++] = K.range(rnum(a, 'start'), rnum(s, 'step'), rnum(b, 'end'));
              pc += 1;
              break;
            }
            case OP.MATRIX: {
              const counts = consts[code[pc + 1]];
              let total = 0; for (const c of counts) total += c;
              const els = st.slice(sp - total, sp); sp -= total;
              let at = 0;
              const rows = [];
              for (const c of counts) { const row = flatten(els.slice(at, at + c)); at += c; for (const x of row) if (x === NOVALUE) throw new CsError(t('script.vm.concat_novalue')); rows.push(row); }
              st[sp++] = buildMatrix(rows, rt);
              pc += 2;
              break;
            }
            case OP.CELL: {
              const counts = consts[code[pc + 1]];
              let total = 0; for (const c of counts) total += c;
              const els = st.slice(sp - total, sp); sp -= total;
              const rows = []; let at = 0;
              for (const c of counts) { rows.push(flatten(els.slice(at, at + c))); at += c; }
              st[sp++] = buildCell(rows);
              pc += 2;
              break;
            }
            case OP.JMP: { const t = code[pc + 1]; if (t <= pc) { const n = this.steps; this.steps = 0; rt.check(n); } pc = t; break; }
            case OP.JF: { const v = single(st[--sp], WHAT_COND); pc = (typeof v === 'boolean' ? v : K.truth(v)) ? pc + 2 : code[pc + 1]; break; }
            case OP.SCAND: { const v = scalarTruth(st[--sp], '&&'); if (!v) { st[sp++] = false; pc = code[pc + 1]; } else pc += 2; break; }
            case OP.SCOR: { const v = scalarTruth(st[--sp], '||'); if (v) { st[sp++] = true; pc = code[pc + 1]; } else pc += 2; break; }
            case OP.TOBOOL: st[sp - 1] = scalarTruth(st[sp - 1], '&& / ||'); pc += 1; break;
            case OP.FORR_INIT: {
              const b = single(st[--sp]), s = single(st[--sp]), a = single(st[--sp]);
              const A = rnum(a, 'start'), S = rnum(s, 'step'), B = rnum(b, 'end');
              slots[code[pc + 1]] = { a: A, s: S, b: B, n: K.rangeCount(A, S, B), k: 0 };
              pc += 2;
              break;
            }
            case OP.FORR_NEXT: {
              const r = slots[code[pc + 2]];
              if (r.k < r.n) { let x = r.a + r.k * r.s; if (r.k === r.n - 1 && r.n > 1 && Math.abs(x - r.b) < 1e-10 * Math.max(1, Math.abs(r.b))) x = r.b; slots[code[pc + 1]] = x; r.k++; pc += 4; }
              else pc = code[pc + 3];
              break;
            }
            case OP.FOR_INIT: { const v = single(st[--sp]); const c = forColumns(v); slots[code[pc + 1]] = { c, k: 0 }; pc += 2; break; }
            case OP.FOR_NEXT: {
              const r = slots[code[pc + 2]];
              if (r.k < r.c.n) { slots[code[pc + 1]] = r.c.get(r.k++); pc += 4; } else pc = code[pc + 3];
              break;
            }
            case OP.LV_BEGIN: lvSt.push({ vals: [slots[code[pc + 1]]], steps: [] }); pc += 2; break;
            case OP.LV_ENDPUSH: { const f = lvSt[lvSt.length - 1]; const v = f.vals[f.vals.length - 1]; endSt.push(v === undefined ? empty() : v); pc += 1; break; }
            case OP.LV_STEP: {
              const kind = code[pc + 1], nargs = code[pc + 2], isLast = code[pc + 4];
              const f = lvSt[lvSt.length - 1];
              let step;
              if (kind === 2) step = { kind, name: consts[code[pc + 3]] };
              else if (kind === 3) { const nm = single(st[--sp]); if (typeof nm !== 'string') throw new CsError(t('script.vm.dyn_field')); step = { kind: 2, name: nm }; }
              else { const args = flatten(st.slice(sp - nargs, sp)); sp -= nargs; step = { kind, args }; }
              f.steps.push(step);
              if (!isLast) f.vals.push(lvGet(f.vals[f.vals.length - 1], step, rt));
              pc += 5;
              break;
            }
            case OP.LV_SET: {
              const f = lvSt.pop();
              let v = single(st[--sp], WHAT_RHS);
              for (let i = f.steps.length - 1; i >= 0; i--) v = lvSet(f.vals[i], f.steps[i], v, rt);
              slots[code[pc + 1]] = v;
              pc += 3;
              break;
            }
            case OP.RET: return null;
            case OP.RETVALS: {
              const out = [];
              for (let i = 0; i < sp; i++) { const v = st[i]; if (v instanceof CsList) out.push(...v.items); else if (v !== NOVALUE) out.push(v); }
              return out;
            }
            case OP.MKANON: st[sp++] = this.closure(consts[code[pc + 1]], slots, frame.locals); pc += 2; break;
            case OP.FHANDLE: {
              const name = consts[code[pc + 1]];
              if (!this.resolvable(name, frame.locals)) throw new CsError(t('script.vm.handle_unknown', { name }));
              st[sp++] = this.handle(name, frame.locals);
              pc += 2;
              break;
            }
            case OP.ECHO: { const s = code[pc + 1]; rt.print(displayText(unit.names[s], slots[s]) + '\n'); pc += 2; break; }
            case OP.SETANS: {
              let v = st[--sp];
              if (v instanceof CsList) v = v.items.length ? v.items[v.items.length - 1] : NOVALUE;
              if (v !== NOVALUE) { slots[code[pc + 1]] = v; if (code[pc + 2]) rt.print(displayText('ans', v) + '\n'); }
              pc += 3;
              break;
            }
            case OP.TRY: handlers.push({ pc: code[pc + 1], slot: code[pc + 2], sp, endLen: endSt.length, lvLen: lvSt.length, depth: this.depth }); pc += 3; break;
            case OP.TRYEND: handlers.pop(); pc += 1; break;
            case OP.CASEQ: { const vals = single(st[--sp]); const x = single(st[--sp]); st[sp++] = caseMatches(x, vals); pc += 1; break; }
            case OP.NARGIN: st[sp++] = frame.nargin; pc += 1; break;
            case OP.NARGOUT: st[sp++] = frame.nargout; pc += 1; break;
            default: throw new CsError(`Internal: bad instruction ${code[pc]} at ${pc}.`);   // i18n-ignore: a VM bug, never a script author's doing
          }
        }
      } catch (e0) {
        let e = e0;
        if (e instanceof StopError) { if (e.line == null) { e.line = unit.lines[cur]; e.col = unit.cols[cur]; e.file = unit.file; } throw e; }   // never caught by try/catch
        if (!(e instanceof CsError)) {
          const msg = e instanceof RangeError && /call stack/i.test(e.message) ? t('script.vm.deep_js') : e && e.message ? e.message : String(e);
          const ne = new CsError(msg); ne.internal = !(e instanceof RangeError); ne.cause = e; e = ne;
        }
        if (e.line === undefined || e.line === null) { e.line = unit.lines[cur]; e.col = unit.cols[cur]; e.file = unit.file; }
        if (handlers.length) {
          const h = handlers.pop();
          sp = h.sp; endSt.length = h.endLen; lvSt.length = h.lvLen; this.depth = h.depth;
          if (h.slot >= 0) slots[h.slot] = errorStruct(e);
          pc = h.pc;
          continue;
        }
        (e.csStack ||= []).push({ name: unit.kind === 'script' ? '' : unit.name, line: unit.lines[cur], col: unit.cols[cur], file: unit.file });
        throw e;
      }
    }
  }
}

function rnum(v, what) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (isTensor(v) && v.data.length >= 1) return v.data[0];
  if (typeof v === 'string' && v.length === 1) return v.charCodeAt(0);
  throw new CsError(t({ start: 'script.vm.range_start', step: 'script.vm.range_step' }[what] || 'script.vm.range_end', { got: describe(v) }));
}

export function errorStruct(e) {
  return struct({
    message: e.message,
    identifier: e.identifier || '',
    stack: cell((e.csStack || []).map((f) => struct({ name: f.name || '', line: f.line || 0, file: f.file || '' }))),
  });
}

function buildMatrix(rows, rt) {
  const needsMethod = rows.some((r) => r.some((x) => !(isDenseLike(x) || (x && x.t === 'cell'))));
  const hrow = (row) => {
    if (row.length === 1) return row[0];
    if (needsMethod) { const m = methodFor('horzcat', row); if (m) return m(row, { ...rt, nargout: 1 }); }
    return K.hcat(row);
  };
  const rs = rows.map(hrow);
  if (rs.length === 0) return empty();
  if (rs.length === 1) return rs.length === 1 && rows[0].length === 0 ? empty() : rs[0];
  if (needsMethod) { const m = methodFor('vertcat', rs); if (m) return m(rs, { ...rt, nargout: 1 }); }
  return K.vcat(rs);
}
function buildCell(rows) {
  if (!rows.length) return cell([], [0, 0]);
  const c = rows[0].length;
  for (const r of rows) if (r.length !== c) throw new CsError(t('script.vm.cell_rows', { a: c, b: r.length }));
  const r = rows.length, items = new Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) { const v = rows[i][j]; if (v === NOVALUE) throw new CsError(t('script.vm.cell_novalue')); items[i + j * r] = mark(v); }
  return cell(items, [r, c]);
}

/** Read one step of an assignment chain (missing parts → undefined, so they are created). */
function lvGet(base, step, rt) {
  if (base === undefined) return undefined;
  let sub;
  if (step.kind === 2) {
    if (base.t === 'struct') sub = base.fields[step.name];
    else if (typeof base === 'object' && base.t === 'tensor' && base.data.length === 0) sub = undefined;
    else throw new CsError(t('script.vm.set_not_struct', { name: step.name, got: describe(base) }));
  } else if (step.kind === 1) {
    if (base.t !== 'cell') { if (isTensor(base) && base.data.length === 0) return undefined; throw new CsError(t('script.vm.brace_cells', { got: describe(base) })); }
    const total = base.items.length;
    if (step.args.length === 1 && typeof step.args[0] === 'number') sub = step.args[0] >= 1 && step.args[0] <= total ? base.items[step.args[0] - 1] : undefined;
    else { try { const s = K.index(base, step.args); sub = s.items.length === 1 ? s.items[0] : undefined; } catch { sub = undefined; } }
  } else {
    if (base && base.t === 'struct') return base;   // s(1).a = …
    if (base && base.t === 'cell') throw new CsError(t('script.vm.cell_field'));
    throw new CsError(t('script.vm.nested_assign', { got: describe(base) }));
  }
  if (sub !== undefined && base[SHARED]) mark(sub);
  return sub;
}

/** Write one step of an assignment chain; returns the new container (in place when it is not shared). */
function lvSet(base, step, value, rt) {
  if (step.kind === 2) {
    if (base === undefined || (isTensor(base) && base.data.length === 0)) return struct({ [step.name]: value });
    if (base.t !== 'struct') throw new CsError(t('script.vm.set_not_struct', { name: step.name, got: describe(base) }));
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(step.name)) throw new CsError(t('script.vm.bad_field', { name: step.name }));
    if (base[SHARED]) { const nf = { ...base.fields }; for (const v of Object.values(nf)) mark(v); nf[step.name] = value; return struct(nf); }
    base.fields[step.name] = value;
    return base;
  }
  if (step.kind === 1) {
    let c = base;
    if (c === undefined || (isTensor(c) && c.data.length === 0)) c = cell([], [0, 0]);
    if (c.t !== 'cell') throw new CsError(t('script.vm.brace_cells', { got: describe(c) }));
    if (c[SHARED]) { const items = c.items.map(mark); c = cell(items, sizeOf(c).slice()); }
    // positions of the assignment: -1 marks the selected ones, 0 the new ones growth adds, k > 0 the old item k
    const ids = K.assign(tensor(sizeOf(c), Float64Array.from({ length: c.items.length }, (_, i) => i + 1)), step.args, -1, false);
    const shape = ids.shape ? ids.shape.slice(0, 2) : [1, 1];
    const data = ids.data || [ids];
    const items = new Array(data.length);
    let count = 0;
    for (let i = 0; i < data.length; i++) { if (data[i] === -1) { items[i] = value; count++; } else items[i] = data[i] === 0 ? empty() : c.items[data[i] - 1]; }
    if (count === 0) return c;
    if (!c[SHARED] && items.length === c.items.length && base === c) { c.items = items; c.shape = shape; return c; }
    return cell(items, shape);
  }
  // ( )
  if (base && base.t === 'cell') {
    if (value && value.t === 'cell') {
      const ids = K.assign(tensor(sizeOf(base), Float64Array.from({ length: base.items.length }, (_, i) => i + 1)), step.args, -1, false);
      const data = ids.data || [ids];
      const sel = []; for (let i = 0; i < data.length; i++) if (data[i] === -1) sel.push(i);
      if (value.items.length !== sel.length && value.items.length !== 1) throw new CsError(t('script.vm.cells_places', { n: value.items.length, places: sel.length }));
      const items = Array.from(data, (d) => (d <= 0 ? undefined : base.items[d - 1]));
      sel.forEach((p, k) => { items[p] = mark(value.items[value.items.length === 1 ? 0 : k]); });
      for (let i = 0; i < items.length; i++) if (items[i] === undefined) items[i] = empty();
      return cell(items, ids.shape ? ids.shape.slice(0, 2) : [1, 1]);
    }
    if (isTensor(value) && value.data.length === 0) return K.deleteAt(base, step.args);
    throw new CsError(t('script.vm.cell_assign'));
  }
  if (base === undefined && value && value.t === 'cell') return lvSet(cell([], [0, 0]), step, value, rt);
  if (base !== undefined && !isDenseLike(base)) {
    const m = methodFor('subsasgn', [base]);
    if (m) return m([base, value, ...step.args], { ...rt, nargout: 1 });
    if (base.t === 'struct') {
      if (step.args.every((a) => K.isColon(a) || num(a) === 1) && value && value.t === 'struct') return value;
      throw new CsError(t('script.vm.struct_array'));
    }
    throw new CsError(t('script.vm.no_assign', { got: describe(base) }));
  }
  if (value !== undefined && !isDenseLike(value)) {
    const m = methodFor('subsasgn', [value]);
    if (m) return m([base === undefined ? empty() : base, value, ...step.args], { ...rt, nargout: 1 });
    if (value && value.t === 'struct' && base === undefined && step.args.every((a) => num(a) === 1)) return value;
  }
  return K.assign(base, step.args, value, true);
}

/* ------------------------------------------------------------------ intrinsics (need the frame) */

const INTRINSICS = new Map([
  ['clear', (vm, frame, args) => clearVars(frame, args)],
  ['clearvars', (vm, frame, args) => clearVars(frame, args)],
  ['exist', (vm, frame, args) => {
    const name = args[0];
    if (typeof name !== 'string') throw new CsError(t('script.vm.exist_arg'));
    const s = frame.unit.slotOf ? undefined : undefined; void s;
    const idx = frame.unit.names.indexOf(name);
    if (idx >= 0 && frame.slots[idx] !== undefined) return [1];
    if (frame.script && frame.ws && frame.ws.has(name)) return [1];
    if (frame.locals?.get(name) || vm.lib.has(name)) return [2];
    if (hasBuiltin(name) || INTRINSICS.has(name)) return [5];
    return [0];
  }],
  ['who', (vm, frame) => {
    const names = new Set();
    frame.unit.names.forEach((nm, i) => { if (nm[0] !== '%' && frame.slots[i] !== undefined) names.add(nm); });
    if (frame.script && frame.ws) for (const n of frame.ws.names()) names.add(n);
    vm.rt.print([...names].sort().join('  ') + '\n');
    return [];
  }],
  ['whos', (vm, frame) => {
    const rows = [];
    const seen = new Set();
    frame.unit.names.forEach((nm, i) => { const v = frame.slots[i]; if (nm[0] !== '%' && v !== undefined) { seen.add(nm); rows.push([nm, v]); } });
    if (frame.script && frame.ws) for (const n of frame.ws.names()) if (!seen.has(n)) rows.push([n, frame.ws.get(n)]);
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    vm.rt.print(rows.map(([n, v]) => `  ${n.padEnd(16)} ${sizeOf(v).join('×').padEnd(12)} ${typeOf(v)}`).join('\n') + '\n');
    return [];
  }],
  ['feval', (vm, frame, args, nargout) => {
    const f = args[0];
    if (typeof f === 'string') return vm.callName(f, args.slice(1), nargout, frame);
    if (f && f.t === 'func') return vm.invokeValue(f, args.slice(1), nargout);
    throw new CsError(t('script.vm.feval_arg'));
  }],
  ['str2func', (vm, frame, args) => {
    const s = args[0];
    if (typeof s !== 'string') throw new CsError(t('script.vm.str2func_arg'));
    if (s.startsWith('@')) throw new CsError(t('script.vm.str2func_anon'));
    if (!vm.resolvable(s, frame.locals)) throw new CsError(t('script.rt.no_function', { name: s }));
    return [vm.handle(s, frame.locals)];
  }],
  ['eval', () => { throw new CsError(t('script.vm.eval')); }],
]);

function clearVars(frame, args) {
  const all = !args.length || (args.length === 1 && (args[0] === 'all' || args[0] === 'variables' || args[0] === '-all'));
  const names = frame.unit.names;
  for (let i = 0; i < names.length; i++) {
    const nm = names[i];
    if (nm[0] === '%') continue;
    if (all || args.includes(nm)) { frame.slots[i] = undefined; if (frame.cleared) frame.cleared.add(nm); }
  }
  if (frame.script && frame.ws) for (const n of frame.ws.names()) if (all || args.includes(n)) { frame.ws.delete(n); frame.cleared.add(n); }
  return [];
}

export { CsList, prodOf };
