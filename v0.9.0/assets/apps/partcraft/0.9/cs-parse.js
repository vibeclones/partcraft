/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-parse.js — CraftScript parser: tokens (cs-lex.js) → AST. DOM-free.
 *
 *   parse(source, file?) → { body: [stmt], functions: [{ name, params, outs, body, line, col }], file }
 *
 * Statements: expr / assign (lhs: [{ name, chain } | { tilde }]) / if / for / while / switch / try / break / continue /
 * return / cmd (command syntax "axis equal") — each with line, col and echo (no trailing ";").
 * Expressions (k): num str id end colon bin un post range matrix cellLit index anon fh.
 * Precedence (low → high): || · && · | · & · comparisons · : · + - · * / \ .* ./ .\ · unary + - ~ · ^ .^ · ' .' and indexing.
 */
import { CsError } from './cs-values.js';
import { lex } from './cs-lex.js';
import { t } from './i18n.js';

const CMP = new Set(['==', '~=', '<', '<=', '>', '>=']);
const MUL = new Set(['*', '/', '\\', '.*', './', '.\\']);

export function parse(src, file = null) {
  const T = lex(src, file);
  let p = 0, inIndex = 0;
  const peek = (o = 0) => T[p + o];
  const at = (type, value) => { const tok = T[p]; return tok.type === type && (value === undefined || tok.value === value); };
  const isOp = (v) => at('op', v);
  const err = (msg, tok = T[p]) => { throw new CsError(msg, { line: tok.line, col: tok.col, file }); };
  const what = (tok) => (tok.type === 'eof' ? t('script.parse.tok.eof') : tok.type === 'nl' ? t('script.parse.tok.eol') : tok.type === 'str' ? t('script.parse.tok.text', { text: tok.value }) : `"${tok.value}"`);
  const expectOp = (v, ctx) => { if (!isOp(v)) err(ctx ? t('script.parse.expected_where', { op: v, where: ctx, found: what(T[p]) }) : t('script.parse.expected', { op: v, found: what(T[p]) })); return T[p++]; };
  const node = (k, tok, o) => ({ k, line: tok.line, col: tok.col, ...o });

  // ------------------------------------------------------------ expressions
  function expr() { return oror(); }
  function binLevel(next, ops) {
    return function level() {
      let a = next();
      while (T[p].type === 'op' && ops.has(T[p].value)) { const tok = T[p++]; a = node('bin', tok, { op: tok.value, a, b: next() }); }
      return a;
    };
  }
  const additive = binLevel(mult, new Set(['+', '-']));
  function range() {
    const a = additive();
    if (isOp(':') && !(peekEndsArg())) {
      const tok = T[p++];
      const b = additive();
      if (isOp(':')) { p++; const c = additive(); return node('range', tok, { a, s: b, b: c }); }
      return node('range', tok, { a, s: null, b });
    }
    return a;
  }
  function peekEndsArg() { return false; }
  const cmp = binLevel(range, CMP);
  const and = binLevel(cmp, new Set(['&']));
  const or = binLevel(and, new Set(['|']));
  const andand = binLevel(or, new Set(['&&']));
  const oror = binLevel(andand, new Set(['||']));
  function mult() {
    let a = unary();
    while (T[p].type === 'op' && MUL.has(T[p].value)) { const tok = T[p++]; a = node('bin', tok, { op: tok.value, a, b: unary() }); }
    return a;
  }
  function unary() {
    if (isOp('-') || isOp('+') || isOp('~')) { const tok = T[p++]; return node('un', tok, { op: tok.value, a: unary() }); }
    return power();
  }
  function power() {
    let a = postfix();
    while (isOp('^') || isOp('.^')) {
      const tok = T[p++];
      // MATLAB allows 2^-1 and 2^~x: unary signs bind to the exponent
      const signs = [];
      while (isOp('-') || isOp('+') || isOp('~')) signs.push(T[p++]);
      let b = postfix();
      for (let i = signs.length - 1; i >= 0; i--) b = node('un', signs[i], { op: signs[i].value, a: b });
      a = node('bin', tok, { op: tok.value, a, b });
    }
    return a;
  }
  function args(close) {
    const list = [];
    inIndex++;
    if (isOp(close)) { p++; inIndex--; return list; }
    for (;;) {
      if (isOp(':') && (peek(1).type === 'op' && (peek(1).value === ',' || peek(1).value === close))) { list.push(node('colon', T[p++])); }
      else list.push(expr());
      if (isOp(',')) { p++; continue; }
      if (isOp(close)) { p++; break; }
      err(t('script.parse.expected_comma', { close, found: what(T[p]) }));
    }
    inIndex--;
    return list;
  }
  function postfix() {
    let a = primary();
    const chain = [];
    for (;;) {
      const tok = T[p];
      if (tok.type !== 'op') break;
      if (tok.value === '(' && !(tok.space && inMatrixContext())) { p++; chain.push({ type: '()', args: args(')'), line: tok.line, col: tok.col }); continue; }
      if (tok.value === '{' && !(tok.space && inMatrixContext())) { p++; chain.push({ type: '{}', args: args('}'), line: tok.line, col: tok.col }); continue; }
      if (tok.value === '.' && !tok.space) {
        const n = peek(1);
        if (n.type === 'id' || n.type === 'kw') { p += 2; chain.push({ type: '.', name: n.value, line: tok.line, col: tok.col }); continue; }
        if (n.type === 'op' && n.value === '(') { p += 2; const e = expr(); expectOp(')', t('script.parse.where.dyn_field')); chain.push({ type: '.()', expr: e, line: tok.line, col: tok.col }); continue; }
        err(t('script.parse.field_name'), n);
      }
      if (tok.value === "'" || tok.value === ".'") {
        if (chain.length) { a = node('index', a, { base: a, chain: chain.splice(0) }); }
        p++; a = node('post', tok, { op: tok.value, a }); continue;
      }
      break;
    }
    if (chain.length) a = node('index', a, { base: a, chain });
    return a;
  }
  let matrixDepth = 0;
  function inMatrixContext() { return matrixDepth > 0 && inIndexAtMatrix === inIndex; }
  let inIndexAtMatrix = -1;
  function primary() {
    const tok = T[p];
    if (tok.type === 'num') { p++; return node('num', tok, { v: tok.value }); }
    if (tok.type === 'str') { p++; return node('str', tok, { v: tok.value }); }
    if (tok.type === 'id') { p++; return node('id', tok, { name: tok.value }); }
    if (tok.type === 'kw' && tok.value === 'end' && inIndex > 0) { p++; return node('end', tok); }
    if (tok.type === 'op') {
      if (tok.value === '(') {
        p++;
        const saveM = matrixDepth, saveI = inIndexAtMatrix; matrixDepth = 0; inIndexAtMatrix = -1;
        const e = expr();
        matrixDepth = saveM; inIndexAtMatrix = saveI;
        expectOp(')', t('script.parse.where.close_paren'));
        return node('paren', tok, { e });
      }
      if (tok.value === '[' || tok.value === '{') return matrix(tok.value);
      if (tok.value === '@') {
        p++;
        if (isOp('(')) {
          p++;
          const params = [];
          if (!isOp(')')) for (;;) {
            if (at('id')) params.push(T[p++].value);
            else if (isOp('~')) { p++; params.push('~'); }
            else err(t('script.parse.anon_param'));
            if (isOp(',')) { p++; continue; }
            break;
          }
          expectOp(')', t('script.parse.where.anon_params'));
          const saveM = matrixDepth, saveI = inIndexAtMatrix, saveX = inIndex; matrixDepth = 0; inIndexAtMatrix = -1; inIndex = 0;
          const body = expr();
          matrixDepth = saveM; inIndexAtMatrix = saveI; inIndex = saveX;
          return node('anon', tok, { params, body });
        }
        if (at('id')) {
          let name = T[p++].value;
          while (isOp('.') && peek(1).type === 'id') { p++; name += '.' + T[p++].value; }
          return node('fh', tok, { name });
        }
        err(t('script.parse.after_at'));
      }
      if (tok.value === ':' && inIndex > 0) { p++; return node('colon', tok); }
    }
    if (tok.type === 'kw') err(t('script.parse.kw_expr', { kw: tok.value }));
    err(t('script.parse.expected_value', { found: what(tok) }));
  }
  function matrix(open) {
    const tok = T[p++];
    const close = open === '[' ? ']' : '}';
    const rows = [];
    let row = [];
    matrixDepth++;
    const saveI = inIndexAtMatrix; inIndexAtMatrix = inIndex;
    for (;;) {
      if (isOp(close)) { p++; break; }
      if (isOp(';')) { p++; rows.push(row); row = []; continue; }
      if (isOp(',')) { p++; continue; }
      if (at('nl')) { p++; continue; }
      if (at('eof')) err(t('script.lex.never_closed', { op: open }), tok);
      row.push(expr());
      if (!(isOp(',') || isOp(';') || isOp(close))) err(t(open === '[' ? 'script.parse.expected_sep_matrix' : 'script.parse.expected_sep_cell', { close, found: what(T[p]) }));
    }
    rows.push(row);
    matrixDepth--; inIndexAtMatrix = saveI;
    return node(open === '[' ? 'matrix' : 'cellLit', tok, { rows: rows.filter((r) => r.length) });
  }

  // ------------------------------------------------------------ statements
  const isEnd = () => at('eof') || (at('kw') && ['end', 'else', 'elseif', 'case', 'otherwise', 'catch', 'function'].includes(T[p].value));
  function endOfStatement() {
    // → echo flag
    if (isOp(';')) { p++; if (at('nl')) p++; return false; }
    if (isOp(',') || at('nl')) { p++; return true; }
    if (at('eof') || isEnd()) return true;
    err(t('script.parse.expected_end', { found: what(T[p]) }));
  }
  function block(stopAt) {
    const body = [];
    for (;;) {
      while (at('nl') || isOp(';') || isOp(',')) p++;
      if (at('eof')) return body;
      if (at('kw') && stopAt.includes(T[p].value)) return body;
      if (at('kw') && ['end', 'else', 'elseif', 'case', 'otherwise', 'catch'].includes(T[p].value)) err(t('script.parse.stray', { kw: T[p].value }));
      if (at('kw', 'function')) return body;
      body.push(statement());
    }
  }
  function expectEnd(tok, what) {
    if (!at('kw', 'end')) err(t('script.parse.no_end', { kw: what, line: tok.line }), at('eof') ? tok : T[p]);
    p++;
  }
  function lvalueAt() {
    // try: id chain* '='   → { name, chain }
    const save = p;
    if (!at('id')) return null;
    const tok = T[p++];
    const chain = [];
    try {
      for (;;) {
        if (isOp('(') && !T[p].space) { p++; chain.push({ type: '()', args: args(')'), line: T[p - 1].line, col: T[p - 1].col }); continue; }
        if (isOp('{') && !T[p].space) { p++; chain.push({ type: '{}', args: args('}') }); continue; }
        if (isOp('.') && peek(1).type === 'id') { p++; chain.push({ type: '.', name: T[p++].value }); continue; }
        if (isOp('.') && peek(1).type === 'op' && peek(1).value === '(') { p += 2; const e = expr(); expectOp(')'); chain.push({ type: '.()', expr: e }); continue; }
        break;
      }
    } catch { p = save; return null; }
    if (isOp('=')) return { name: tok.value, chain, line: tok.line, col: tok.col };
    p = save;
    return null;
  }
  function multiAssignAt() {
    // '[' lv (, lv)* ']' '='
    if (!isOp('[')) return null;
    let depth = 0, q = p;
    for (; q < T.length; q++) {
      const x = T[q];
      if (x.type === 'op' && (x.value === '[' || x.value === '(' || x.value === '{')) depth++;
      else if (x.type === 'op' && (x.value === ']' || x.value === ')' || x.value === '}')) { depth--; if (depth === 0) break; }
      else if (x.type === 'nl' || x.type === 'eof') return null;
    }
    if (!(T[q + 1] && T[q + 1].type === 'op' && T[q + 1].value === '=')) return null;
    const tok = T[p++];
    const list = [];
    for (;;) {
      if (isOp(']')) { p++; break; }
      if (isOp(',')) { p++; continue; }
      if (isOp('~')) { const x = T[p++]; list.push({ tilde: true, line: x.line, col: x.col }); continue; }
      const save = p;
      if (!at('id')) err(t('script.parse.lhs_items'));
      const nt = T[p++];
      const chain = [];
      for (;;) {
        if (isOp('(') && !T[p].space) { p++; chain.push({ type: '()', args: args(')') }); continue; }
        if (isOp('{') && !T[p].space) { p++; chain.push({ type: '{}', args: args('}') }); continue; }
        if (isOp('.') && peek(1).type === 'id') { p++; chain.push({ type: '.', name: T[p++].value }); continue; }
        break;
      }
      if (p === save) err(t('script.parse.var_name'));
      list.push({ name: nt.value, chain, line: nt.line, col: nt.col });
    }
    expectOp('=');
    return { t: tok, list };
  }
  function statement() {
    const tok = T[p];
    if (tok.type === 'kw') {
      switch (tok.value) {
        case 'if': {
          p++;
          const clauses = [{ cond: expr(), body: block(['elseif', 'else', 'end']) }];
          let els = null;
          for (;;) {
            if (at('kw', 'elseif')) { p++; clauses.push({ cond: expr(), body: block(['elseif', 'else', 'end']) }); continue; }
            if (at('kw', 'else')) { p++; els = block(['end']); }
            break;
          }
          expectEnd(tok, 'if');
          return node('if', tok, { clauses, els });
        }
        case 'for': case 'parfor': {
          p++;
          const paren = isOp('(') && (() => { // for (i = 1:n)
            let q = p + 1; return T[q].type === 'id' && T[q + 1].type === 'op' && T[q + 1].value === '=';
          })();
          if (paren) p++;
          if (!at('id')) err(t('script.parse.loop_var'));
          const v = T[p++];
          expectOp('=', t('script.parse.where.loop_var'));
          const e = expr();
          if (paren) expectOp(')');
          const body = block(['end']);
          expectEnd(tok, 'for');
          return node('for', tok, { name: v.value, e, body });
        }
        case 'while': {
          p++;
          const cond = expr();
          const body = block(['end']);
          expectEnd(tok, 'while');
          return node('while', tok, { cond, body });
        }
        case 'switch': {
          p++;
          const e = expr();
          const cases = [];
          let other = null;
          while (at('nl') || isOp(';') || isOp(',')) p++;
          for (;;) {
            if (at('kw', 'case')) { const ct = T[p++]; const vals = expr(); cases.push({ vals, body: block(['case', 'otherwise', 'end']), line: ct.line }); continue; }
            if (at('kw', 'otherwise')) { p++; other = block(['end']); continue; }
            break;
          }
          expectEnd(tok, 'switch');
          return node('switch', tok, { e, cases, other });
        }
        case 'try': {
          p++;
          const body = block(['catch', 'end']);
          let id = null, cbody = [];
          if (at('kw', 'catch')) {
            const ct = T[p++];
            if (at('id') && T[p].line === ct.line) id = T[p++].value;
            cbody = block(['end']);
          }
          expectEnd(tok, 'try');
          return node('try', tok, { body, id, cbody });
        }
        case 'break': case 'continue': case 'return': p++; endOfStatement(); return node(tok.value, tok);
        case 'global': case 'persistent': err(t('script.parse.global', { kw: tok.value }));
        default: err(t('script.parse.kw_statement', { kw: tok.value }));
      }
    }
    const m = multiAssignAt();
    if (m) { const rhs = expr(); return node('assign', m.t, { lhs: m.list, rhs, echo: endOfStatement() }); }
    const lv = lvalueAt();
    if (lv) { p++; const rhs = expr(); return node('assign', tok, { lhs: [lv], rhs, echo: endOfStatement() }); }
    // command syntax: "axis equal", "hold on", "format long", "close all"
    if (tok.type === 'id' && T[p + 1].space && T[p + 1].line === tok.line && (T[p + 1].type === 'id' || (T[p + 1].type === 'num')) && !(T[p + 2].type === 'op' && T[p + 2].value === '=')) {
      const n2 = T[p + 2];
      if (n2.type === 'nl' || n2.type === 'eof' || (n2.type === 'op' && (n2.value === ';' || n2.value === ',')) || n2.type === 'id' || n2.type === 'num') {
        p++;
        const words = [];
        while (T[p].type === 'id' || T[p].type === 'num' || T[p].type === 'kw') words.push(String(T[p++].value));
        return node('cmd', tok, { name: tok.value, words, echo: endOfStatement() });
      }
    }
    const e = expr();
    if (isOp('=')) err(t('script.parse.lhs'));
    return node('expr', tok, { e, echo: endOfStatement() });
  }
  function fn() {
    const tok = T[p++];   // 'function'
    let outs = [];
    let name;
    // function [a, b] = name(…) | function a = name(…) | function name(…)
    if (isOp('[')) {
      p++;
      while (!isOp(']')) { if (isOp(',')) { p++; continue; } if (!at('id')) err(t('script.parse.out_name')); outs.push(T[p++].value); }
      p++;
      expectOp('=', t('script.parse.where.outputs'));
      if (!at('id')) err(t('script.parse.fn_name'));
      name = T[p++].value;
    } else {
      if (!at('id')) err(t('script.parse.fn_name_after'));
      const a = T[p++].value;
      if (isOp('=')) { p++; outs = [a]; if (!at('id')) err(t('script.parse.fn_name')); name = T[p++].value; } else name = a;
    }
    const params = [];
    if (isOp('(')) {
      p++;
      while (!isOp(')')) {
        if (isOp(',')) { p++; continue; }
        if (isOp('~')) { p++; params.push('~'); continue; }
        if (!at('id')) err(t('script.parse.param_name'));
        params.push(T[p++].value);
      }
      p++;
    }
    const body = block(['end']);
    if (at('kw', 'end')) p++;
    return { name, params, outs, body, line: tok.line, col: tok.col, file };
  }

  const body = [], functions = [];
  for (;;) {
    while (at('nl') || isOp(';') || isOp(',')) p++;
    if (at('eof')) break;
    if (at('kw', 'function')) { functions.push(fn()); continue; }
    if (at('kw') && ['end', 'else', 'elseif', 'case', 'otherwise', 'catch'].includes(T[p].value)) err(t('script.parse.stray', { kw: T[p].value }));
    body.push(statement());
  }
  return { body, functions, file };
}
