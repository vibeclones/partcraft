/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-compile.js — CraftScript compiler: AST (cs-parse.js) → bytecode units for the stack VM (cs-vm.js). DOM-free.
 *
 *   compileProgram(ast, { knownVars, kind: 'script' | 'library', name }) → { main: unit | null, functions: Map(name → unit) }
 *   unit = { name, kind, file, params, outs, names (slot → name), nslots, code: Int32Array, lines, cols, consts, refs: Set }
 *
 * Name resolution is static, as MATLAB does it: a name is a variable in a unit when it is a parameter or output, is assigned
 * anywhere in the unit (=, for, catch), or (scripts) already exists in the workspace; any other name is a function call
 * (local function → library → builtin), resolved by the VM. `end` inside an index means the size of the value indexed.
 */
import { CsError } from './cs-values.js';
import { t } from './i18n.js';

export const OP = {
  CONST: 1, LOAD: 2, LOADS: 3, STORE: 4, POP: 5, DUP: 6,
  CALLN: 7, INDEX: 8, BRACE: 9, FIELD: 10, DFIELD: 11,
  ENDPUSH: 12, ENDPOP: 13, ENDV: 14,
  BIN: 15, UN: 16, RANGE: 17, MATRIX: 18, CELL: 19,
  JMP: 20, JF: 21, SCAND: 22, SCOR: 23, TOBOOL: 24,
  FORR_INIT: 25, FORR_NEXT: 26, FOR_INIT: 27, FOR_NEXT: 28,
  LV_BEGIN: 29, LV_STEP: 30, LV_SET: 31, LV_ENDPUSH: 32,
  RET: 33, MKANON: 34, FHANDLE: 35, ECHO: 36, SETANS: 37,
  TRY: 38, TRYEND: 39, CASEQ: 40, NARGIN: 41, NARGOUT: 42, RETVALS: 43, CMD: 44,
};
export const BINOPS = ['+', '-', '*', '/', '\\', '^', '.*', './', '.\\', '.^', '==', '~=', '<', '<=', '>', '>=', '&', '|'];
export const UNOPS = ['-', '+', '~', "'", ".'"];
const LV_KIND = { '()': 0, '{}': 1, '.': 2, '.()': 3 };

/** Names assigned anywhere in a statement list (not descending into anonymous functions). */
function assignedNames(stmts, set) {
  for (const s of stmts) {
    switch (s.k) {
      case 'assign': for (const l of s.lhs) if (!l.tilde) set.add(l.name); break;
      case 'for': set.add(s.name); assignedNames(s.body, set); break;
      case 'while': assignedNames(s.body, set); break;
      case 'if': for (const c of s.clauses) assignedNames(c.body, set); if (s.els) assignedNames(s.els, set); break;
      case 'switch': for (const c of s.cases) assignedNames(c.body, set); if (s.other) assignedNames(s.other, set); break;
      case 'try': assignedNames(s.body, set); if (s.id) set.add(s.id); assignedNames(s.cbody, set); break;
      case 'expr': set.add('ans'); break;
      case 'cmd': break;
      default: break;
    }
  }
  return set;
}
/** Identifiers read in an expression tree (for anonymous-function captures). */
function freeIds(e, set) {
  if (!e || typeof e !== 'object') return set;
  if (Array.isArray(e)) { for (const x of e) freeIds(x, set); return set; }
  if (e.k === 'id') { set.add(e.name); return set; }
  if (e.k === 'anon') { const inner = freeIds(e.body, new Set()); for (const p of e.params) inner.delete(p); for (const x of inner) set.add(x); return set; }
  for (const key of ['a', 'b', 's', 'e', 'base', 'body']) if (e[key]) freeIds(e[key], set);
  if (e.rows) for (const r of e.rows) freeIds(r, set);
  if (e.chain) for (const c of e.chain) { if (c.args) freeIds(c.args, set); if (c.expr) freeIds(c.expr, set); }
  return set;
}
const hasEnd = (e) => {
  if (!e || typeof e !== 'object') return false;
  if (Array.isArray(e)) return e.some(hasEnd);
  if (e.k === 'end') return true;
  if (e.k === 'anon') return false;
  for (const key of ['a', 'b', 's', 'e', 'base']) if (e[key] && hasEnd(e[key])) return true;
  if (e.rows && e.rows.some((r) => r.some(hasEnd))) return true;
  if (e.chain && e.chain.some((c) => (c.args && c.args.some(hasEnd)) || (c.expr && hasEnd(c.expr)))) return true;
  return false;
};

class Unit {
  constructor(name, kind, file) {
    this.name = name; this.kind = kind; this.file = file;
    this.params = []; this.outs = [];
    this.names = []; this.slotOf = new Map();
    this.code = []; this.lines = []; this.cols = [];
    this.consts = []; this.constIdx = new Map();
    this.refs = new Set();
    this.vars = new Set();
    this.line = 1; this.col = 1;
    this.hidden = 0;
  }
  slot(name) { let s = this.slotOf.get(name); if (s === undefined) { s = this.names.length; this.names.push(name); this.slotOf.set(name, s); } return s; }
  hiddenSlot(tag) { return this.slot(`%${tag}${this.hidden++}`); }
  k(v) {
    if (typeof v === 'string' || typeof v === 'number') { const key = typeof v + ':' + v; let i = this.constIdx.get(key); if (i === undefined) { i = this.consts.length; this.consts.push(v); this.constIdx.set(key, i); } return i; }
    this.consts.push(v); return this.consts.length - 1;
  }
  emit(op, ...args) { const pc = this.code.length; this.code.push(op, ...args); this.lines.push(this.line); this.cols.push(this.col); for (let i = 0; i < args.length; i++) { this.lines.push(this.line); this.cols.push(this.col); } return pc; }
  at(n) { if (n && n.line) { this.line = n.line; this.col = n.col; } }
  get pc() { return this.code.length; }
  patch(at, value) { this.code[at] = value; }
  finish() {
    this.code = Int32Array.from(this.code);
    this.lines = Int32Array.from(this.lines);
    this.cols = Int32Array.from(this.cols);
    this.nslots = this.names.length;
    delete this.constIdx;
    return this;
  }
}

export function compileProgram(ast, { knownVars = new Set(), kind = 'script', name = 'script' } = {}) {
  const file = ast.file;
  const functions = new Map();
  for (const f of ast.functions) {
    if (functions.has(f.name)) throw new CsError(t('script.compile.fn_twice', { name: f.name }), { line: f.line, col: f.col, file });
    functions.set(f.name, null);
  }
  const localNames = new Set(functions.keys());
  for (const f of ast.functions) functions.set(f.name, compileFunction(f, file, localNames));
  let main = null;
  if (kind === 'script' && ast.body.length) {
    const u = new Unit(name, 'script', file);
    const vars = assignedNames(ast.body, new Set());
    const used = freeIds(ast.body.map(stmtExprs), new Set());
    for (const v of knownVars) if (used.has(v)) vars.add(v);
    for (const v of vars) u.vars.add(v);
    for (const v of vars) u.slot(v);
    const C = new Compiler(u, localNames);
    C.block(ast.body);
    u.emit(OP.RET);
    main = u.finish();
  } else if (kind === 'library' && ast.body.length) {
    const s = ast.body[0];
    throw new CsError(t('script.compile.lib_only_fns'), { line: s.line, col: s.col, file });
  }
  return { main, functions };
}
function stmtExprs(s) {
  // every expression in a statement tree, for free-variable scans
  const out = [];
  const walk = (st) => {
    for (const x of st) {
      if (x.e) out.push(x.e);
      if (x.rhs) out.push(x.rhs);
      if (x.lhs) for (const l of x.lhs) { if (!l.tilde) { out.push({ k: 'id', name: l.name }); if (l.chain) for (const c of l.chain) { if (c.args) out.push(...c.args); if (c.expr) out.push(c.expr); } } }
      if (x.cond) out.push(x.cond);
      if (x.clauses) for (const c of x.clauses) { out.push(c.cond); walk(c.body); }
      if (x.els) walk(x.els);
      if (x.body) walk(x.body);
      if (x.cbody) walk(x.cbody);
      if (x.cases) for (const c of x.cases) { out.push(c.vals); walk(c.body); }
      if (x.other) walk(x.other);
    }
  };
  walk([s]);
  return out;
}

function compileFunction(f, file, localNames) {
  const u = new Unit(f.name, 'function', file);
  u.at(f);
  u.params = f.params.slice();
  u.outs = f.outs.slice();
  const seen = new Set();
  for (const p of f.params) { if (p !== '~' && seen.has(p)) throw new CsError(t('script.compile.param_twice', { name: p }), { line: f.line, col: f.col, file }); seen.add(p); }
  const seenOut = new Set();
  for (const o of f.outs) { if (seenOut.has(o)) throw new CsError(t('script.compile.out_twice', { name: o }), { line: f.line, col: f.col, file }); seenOut.add(o); }
  for (const p of f.params) u.slot(p === '~' ? `%unused${u.hidden++}` : p);   // i18n-ignore: an internal slot name
  for (const o of f.outs) u.slot(o);
  const vars = assignedNames(f.body, new Set([...f.params.filter((p) => p !== '~'), ...f.outs]));
  for (const v of vars) { u.vars.add(v); u.slot(v); }
  u.paramSlots = f.params.map((p, i) => i);
  u.outSlots = f.outs.map((o) => u.slotOf.get(o));
  const C = new Compiler(u, localNames);
  C.block(f.body);
  u.emit(OP.RET);
  return u.finish();
}

class Compiler {
  constructor(u, localNames) { this.u = u; this.local = localNames; this.loops = []; this.endCtx = []; }
  err(msg, n) { throw new CsError(msg, { line: n?.line ?? this.u.line, col: n?.col ?? this.u.col, file: this.u.file }); }
  isVar(name) { return this.u.vars.has(name); }
  /** Does `end` inside these expressions refer to the index being compiled now? (Indexes of variables have their own.) */
  endHere(e) {
    if (!e || typeof e !== 'object') return false;
    if (Array.isArray(e)) return e.some((x) => this.endHere(x));
    if (e.k === 'end') return true;
    if (e.k === 'anon') return false;
    if (e.k === 'index') {
      const call = e.base.k === 'id' && !this.isVar(e.base.name);
      if (this.endHere(e.base)) return true;
      for (let i = 0; i < e.chain.length; i++) {
        const c = e.chain[i];
        if (c.expr && this.endHere(c.expr)) return true;
        if (c.args && call && i === 0 && c.type === '()' && this.endHere(c.args)) return true;
      }
      return false;
    }
    for (const key of ['a', 'b', 's', 'e']) if (e[key] && this.endHere(e[key])) return true;
    if (e.rows && e.rows.some((r) => this.endHere(r))) return true;
    return false;
  }

  block(stmts) { for (const s of stmts) this.stmt(s); }
  stmt(s) {
    const u = this.u;
    u.at(s);
    switch (s.k) {
      case 'expr': {
        this.expr(s.e, 0, false);
        u.emit(OP.SETANS, u.slot('ans'), s.echo ? 1 : 0);
        return;
      }
      case 'cmd': {
        for (const w of s.words) u.emit(OP.CONST, u.k(w));
        u.refs.add(s.name);
        u.emit(OP.CALLN, u.k(s.name), s.words.length, 0);
        u.emit(OP.SETANS, u.slot('ans'), s.echo ? 1 : 0);
        return;
      }
      case 'assign': return this.assign(s);
      case 'if': {
        const ends = [];
        for (const c of s.clauses) {
          u.at(c.cond);
          this.expr(c.cond, 1, false);
          const jf = u.emit(OP.JF, 0);
          this.block(c.body);
          ends.push(u.emit(OP.JMP, 0));
          u.patch(jf + 1, u.pc);
        }
        if (s.els) this.block(s.els);
        for (const e of ends) u.patch(e + 1, u.pc);
        return;
      }
      case 'while': {
        const top = u.pc;
        this.expr(s.cond, 1, false);
        const jf = u.emit(OP.JF, 0);
        const loop = { breaks: [], continueTo: top };
        this.loops.push(loop);
        this.block(s.body);
        this.loops.pop();
        u.at(s);
        u.emit(OP.JMP, top);
        u.patch(jf + 1, u.pc);
        for (const b of loop.breaks) u.patch(b + 1, u.pc);
        return;
      }
      case 'for': {
        const v = u.slot(s.name);
        const h = u.hiddenSlot('for');
        let next;
        if (s.e.k === 'range') {
          this.expr(s.e.a, 1, false);
          if (s.e.s) this.expr(s.e.s, 1, false); else u.emit(OP.CONST, u.k(1));
          this.expr(s.e.b, 1, false);
          u.at(s);
          u.emit(OP.FORR_INIT, h);
          next = u.emit(OP.FORR_NEXT, v, h, 0);
        } else {
          this.expr(s.e, 1, false);
          u.at(s);
          u.emit(OP.FOR_INIT, h);
          next = u.emit(OP.FOR_NEXT, v, h, 0);
        }
        const loop = { breaks: [], continueTo: next };
        this.loops.push(loop);
        this.block(s.body);
        this.loops.pop();
        u.at(s);
        u.emit(OP.JMP, next);
        u.patch(next + 3, u.pc);
        for (const b of loop.breaks) u.patch(b + 1, u.pc);
        return;
      }
      case 'break': case 'continue': {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) this.err(t('script.compile.loop_only', { kw: s.k }), s);
        if (s.k === 'break') loop.breaks.push(u.emit(OP.JMP, 0)); else u.emit(OP.JMP, loop.continueTo);
        return;
      }
      case 'return': u.emit(OP.RET); return;
      case 'switch': {
        const h = u.hiddenSlot('sw');
        this.expr(s.e, 1, false);
        u.emit(OP.STORE, h);
        const ends = [];
        for (const c of s.cases) {
          u.at({ line: c.line, col: 1 });
          u.emit(OP.LOAD, h);
          this.expr(c.vals, 1, false);
          u.emit(OP.CASEQ);
          const jf = u.emit(OP.JF, 0);
          this.block(c.body);
          ends.push(u.emit(OP.JMP, 0));
          u.patch(jf + 1, u.pc);
        }
        if (s.other) this.block(s.other);
        for (const e of ends) u.patch(e + 1, u.pc);
        return;
      }
      case 'try': {
        const tr = u.emit(OP.TRY, 0, s.id ? u.slot(s.id) : -1);
        this.block(s.body);
        u.emit(OP.TRYEND);
        const j = u.emit(OP.JMP, 0);
        u.patch(tr + 1, u.pc);
        this.block(s.cbody);
        u.patch(j + 1, u.pc);
        return;
      }
      default: this.err(`Internal: unknown statement ${s.k}.`, s);   // i18n-ignore: a compiler bug, never a script author's doing
    }
  }

  assign(s) {
    const u = this.u;
    const n = s.lhs.length;
    if (n === 1) {
      const l = s.lhs[0];
      if (l.tilde) this.err(t('script.compile.tilde_only'), s);
      this.expr(s.rhs, 1, true);
      u.at(s);
      if (!l.chain.length) u.emit(OP.STORE, u.slot(l.name));
      else this.lvalue(l);
      if (s.echo) u.emit(OP.ECHO, u.slot(l.name));
      return;
    }
    // [a, b, ~] = f(…)
    this.expr(s.rhs, n, true);
    u.at(s);
    for (let i = n - 1; i >= 0; i--) {
      const l = s.lhs[i];
      if (l.tilde) { u.emit(OP.POP); continue; }
      if (!l.chain.length) u.emit(OP.STORE, u.slot(l.name)); else this.lvalue(l);
    }
    if (s.echo) for (const l of s.lhs) if (!l.tilde) u.emit(OP.ECHO, u.slot(l.name));
  }
  /** rhs on the stack → store through an index/field chain. */
  lvalue(l) {
    const u = this.u;
    const slot = u.slot(l.name);
    u.emit(OP.LV_BEGIN, slot);
    const last = l.chain.length - 1;
    l.chain.forEach((c, i) => {
      const kind = LV_KIND[c.type];
      if (c.type === '()' || c.type === '{}') {
        const needEnd = this.endHere(c.args);
        if (needEnd) u.emit(OP.LV_ENDPUSH);
        this.args(c.args, needEnd);
        if (needEnd) u.emit(OP.ENDPOP);
        u.emit(OP.LV_STEP, kind, c.args.length, -1, i === last ? 1 : 0);
      } else if (c.type === '.') u.emit(OP.LV_STEP, kind, 0, u.k(c.name), i === last ? 1 : 0);
      else { this.expr(c.expr, 1, false); u.emit(OP.LV_STEP, kind, 1, -1, i === last ? 1 : 0); }
    });
    u.emit(OP.LV_SET, slot, l.chain.length);
  }

  args(list, endScope) {
    const n = list.length;
    list.forEach((a, i) => {
      if (a.k === 'colon') { this.u.emit(OP.CONST, this.u.k(':')); return; }
      if (endScope) this.endCtx.push({ k: i, n });
      this.expr(a, 1, true, true);
      if (endScope) this.endCtx.pop();
    });
  }

  /**
   * Compile an expression leaving `nargout` values on the stack (0 = statement context: one value or none).
   * escape: the value may be stored elsewhere (a variable read is marked shared). inArgs: cs-lists may expand.
   */
  expr(e, nargout = 1, escape = false, inArgs = false) {
    const u = this.u;
    u.at(e);
    const one = () => { if (nargout > 1) this.err(t('script.compile.one_value'), e); };
    switch (e.k) {
      case 'num': one(); u.emit(OP.CONST, u.k(e.v)); return;
      case 'str': one(); u.emit(OP.CONST, u.k(e.v)); return;
      case 'paren': return this.expr(e.e, nargout, escape, false);
      case 'colon': one(); u.emit(OP.CONST, u.k(':')); return;
      case 'end': {
        one();
        const ctx = this.endCtx[this.endCtx.length - 1];
        if (!ctx) this.err(t('script.compile.end_outside'), e);
        u.emit(OP.ENDV, ctx.k, ctx.n);
        return;
      }
      case 'id': {
        if (this.isVar(e.name)) { one(); u.emit(escape ? OP.LOADS : OP.LOAD, u.slot(e.name)); return; }
        if ((e.name === 'nargin' || e.name === 'nargout') && u.kind === 'function') { one(); u.emit(e.name === 'nargin' ? OP.NARGIN : OP.NARGOUT); return; }
        u.refs.add(e.name);
        u.emit(OP.CALLN, u.k(e.name), 0, nargout);
        return;
      }
      case 'bin': {
        one();
        if (e.op === '&&' || e.op === '||') {
          this.expr(e.a, 1, false);
          const j = u.emit(e.op === '&&' ? OP.SCAND : OP.SCOR, 0);
          this.expr(e.b, 1, false);
          u.emit(OP.TOBOOL);
          u.patch(j + 1, u.pc);
          return;
        }
        this.expr(e.a, 1, false);
        this.expr(e.b, 1, false);
        u.at(e);
        u.emit(OP.BIN, BINOPS.indexOf(e.op));
        return;
      }
      case 'un': one(); this.expr(e.a, 1, false); u.at(e); u.emit(OP.UN, UNOPS.indexOf(e.op)); return;
      case 'post': one(); this.expr(e.a, 1, false); u.at(e); u.emit(OP.UN, UNOPS.indexOf(e.op)); return;
      case 'range': {
        one();
        this.expr(e.a, 1, false);
        if (e.s) this.expr(e.s, 1, false); else u.emit(OP.CONST, u.k(1));
        this.expr(e.b, 1, false);
        u.at(e);
        u.emit(OP.RANGE);
        return;
      }
      case 'matrix': case 'cellLit': {
        one();
        const counts = [];
        for (const row of e.rows) { for (const x of row) this.expr(x, 1, e.k === 'cellLit', true); counts.push(row.length); }
        u.at(e);
        u.emit(e.k === 'matrix' ? OP.MATRIX : OP.CELL, u.k(Int32Array.from(counts)));
        return;
      }
      case 'anon': {
        one();
        const inner = new Unit('@(' + e.params.join(',') + ')', 'anon', u.file);
        inner.at(e);
        inner.params = e.params.slice();
        e.params.forEach((p, i) => { inner.slot(p === '~' ? `%unused${i}` : p); if (p !== '~') inner.vars.add(p); });   // i18n-ignore: %unused is an internal slot name
        const free = freeIds(e.body, new Set());
        const capture = [];
        for (const name of free) {
          if (e.params.includes(name)) continue;
          if (this.isVar(name)) { const is = inner.slot(name); inner.vars.add(name); capture.push(u.slot(name), is); }
        }
        const IC = new Compiler(inner, this.local);
        IC.expr(e.body, -1, true);
        inner.emit(OP.RETVALS);
        inner.paramSlots = e.params.map((_, i) => i);
        inner.text = anonText(e);
        inner.finish();
        u.emit(OP.MKANON, u.k({ unit: inner, capture: Int32Array.from(capture) }));
        return;
      }
      case 'fh': one(); u.refs.add(e.name.split('.')[0]); u.emit(OP.FHANDLE, u.k(e.name)); return;
      case 'index': return this.index(e, nargout, escape, inArgs);
      default: this.err(`Internal: unknown expression ${e.k}.`, e);   // i18n-ignore: a compiler bug
    }
  }

  index(e, nargout, escape, inArgs) {
    const u = this.u;
    const chain = e.chain;
    let start = 0;
    const lastNargout = (i) => (i === chain.length - 1 ? nargout : 1);
    if (e.base.k === 'id' && !this.isVar(e.base.name) && !(u.kind === 'function' && (e.base.name === 'nargin' || e.base.name === 'nargout'))) {
      // a function call: name(args) …
      const name = e.base.name;
      u.refs.add(name);
      if (chain[0].type === '()') {
        // `end` in a call's arguments means the size of the enclosing index (x(max(1, end-2):end)), as in MATLAB
        if (this.endHere(chain[0].args) && !this.endCtx.length) this.err(t('script.compile.end_in_call', { name }), chain[0]);
        this.args(chain[0].args, false);
        u.at(chain[0].line ? chain[0] : e);
        u.emit(OP.CALLN, u.k(name), chain[0].args.length, lastNargout(0));
        start = 1;
      } else {
        u.at(e.base);
        u.emit(OP.CALLN, u.k(name), 0, 1);
      }
    } else {
      this.expr(e.base, 1, false);
    }
    for (let i = start; i < chain.length; i++) {
      const c = chain[i];
      const no = lastNargout(i);
      if (c.type === '()' || c.type === '{}') {
        const needEnd = this.endHere(c.args);
        if (needEnd) u.emit(OP.ENDPUSH);
        const saved = this.endCtx; this.endCtx = needEnd ? [] : this.endCtx;
        this.args(c.args, needEnd);
        this.endCtx = saved;
        if (needEnd) u.emit(OP.ENDPOP);
        u.at(c.line ? c : e);
        u.emit(c.type === '()' ? OP.INDEX : OP.BRACE, c.args.length, no, inArgs && i === chain.length - 1 ? 1 : 0);
      } else if (c.type === '.') { u.at(c.line ? c : e); u.emit(OP.FIELD, u.k(c.name)); }
      else { this.expr(c.expr, 1, false); u.emit(OP.DFIELD); }
    }
    void escape;
  }
}

function anonText(e) {
  return '@(' + e.params.join(',') + ') …';
}
