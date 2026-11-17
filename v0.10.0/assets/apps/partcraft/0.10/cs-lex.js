/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lex.js — CraftScript lexer (MATLAB-like syntax; docs/apps/craftscript.md "Language"). DOM-free, imports cs-values.js.
 *
 *   lex(source, file?) → [{ type, value, line, col, space }]   type: num str id kw op nl eof
 *
 * Inside [ ] and { } whitespace separates elements and newlines separate rows, as in MATLAB: the lexer inserts ',' and ';'
 * tokens there ([1 -2] is two elements, [1 - 2] is one, [a' b'] transposes). "'" is a transpose after a value (no space, or
 * outside brackets) and a string start otherwise. Comments: % to the end of the line, %{ … %} blocks (on lines of their own,
 * nestable); "..." continues a line.
 */
import { CsError } from './cs-values.js';
import { t } from './i18n.js';

export const KEYWORDS = new Set(['if', 'elseif', 'else', 'end', 'for', 'parfor', 'while', 'break', 'continue', 'switch', 'case', 'otherwise', 'try', 'catch', 'function', 'return', 'global', 'persistent']);
const OPS3 = ['...', '.^\''];
const OPS2 = ['==', '~=', '!=', '<=', '>=', '&&', '||', '.*', './', '.\\', '.^', ".'"];
const OPS1 = '+-*/\\^<>=&|~!()[]{},;:.@\'';

const isDigit = (c) => c >= '0' && c <= '9';
const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdChar = (c) => isIdStart(c) || isDigit(c);

/** Does this token end a value (so a following ' is a transpose / whitespace may separate elements)? */
const endsValue = (tok) => tok && (tok.type === 'num' || tok.type === 'str' || tok.type === 'id' || (tok.type === 'kw' && tok.value === 'end') || (tok.type === 'op' && (tok.value === ')' || tok.value === ']' || tok.value === '}' || tok.value === "'" || tok.value === ".'")));

export function lex(src, file = null) {
  const toks = [];
  const stack = [];           // open brackets: '(' '[' '{'
  let i = 0, line = 1, lineStart = 0;
  const n = src.length;
  const err = (msg, l = line, c = i - lineStart + 1) => { throw new CsError(msg, { line: l, col: c, file }); };
  const inMatrix = () => stack.length && stack[stack.length - 1] !== '(';
  const last = () => toks[toks.length - 1];
  const push = (type, value, l, c, space) => {
    // whitespace separating elements inside [ ] / { }
    if (space && inMatrix() && endsValue(last())) {
      const next = src[i];   // first char after this token (for + / -)
      let sep = false;
      if (type === 'num' || type === 'str' || type === 'id') sep = true;
      else if (type === 'kw') sep = value !== 'end' ? false : true;
      else if (type === 'op') {
        if (value === '(' || value === '[' || value === '{' || value === '@') sep = true;
        else if ((value === '~' || value === '!')) sep = true;
        else if ((value === '+' || value === '-') && next !== undefined && next !== ' ' && next !== '\t') sep = true;
      }
      if (sep) toks.push({ type: 'op', value: ',', line: l, col: c, space: true, auto: true });
    }
    toks.push({ type, value, line: l, col: c, space });
  };
  let space = false;
  const lineIsOnly = (s, at) => { // is the line containing position `at` just `s` (plus whitespace)?
    let a = at; while (a > 0 && src[a - 1] !== '\n') a--;
    let b = at; while (b < n && src[b] !== '\n') b++;
    return src.slice(a, b).trim() === s;
  };
  while (i < n) {
    const c = src[i];
    const col = i - lineStart + 1;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; space = true; continue; }
    if (c === '\n') {
      if (inMatrix()) {
        const tok = last();
        if (tok && !(tok.type === 'op' && (tok.value === ';' || tok.value === '[' || tok.value === '{' || tok.value === ','))) toks.push({ type: 'op', value: ';', line, col, space, auto: true });
      } else if (!stack.length) toks.push({ type: 'nl', value: '\n', line, col, space });
      i++; line++; lineStart = i; space = false;
      continue;
    }
    // comments
    if (c === '%' || (c === '#' && false)) {
      if (src[i + 1] === '{' && lineIsOnly('%{', i)) {
        let depth = 0, j = i;
        const startLine = line;
        for (;;) {
          let e = j; while (e < n && src[e] !== '\n') e++;
          const tok = src.slice(j, e).trim();
          if (tok === '%{') depth++; else if (tok === '%}') depth--;
          j = e;
          if (depth === 0) break;
          if (j >= n) err(t('script.lex.block_comment'), startLine, col);
          j++; line++; lineStart = j;
        }
        i = j; continue;
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // continuation
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      while (i < n && src[i] !== '\n') i++;
      if (i < n) { i++; line++; lineStart = i; }
      space = true;
      continue;
    }
    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      let j = i;
      while (isDigit(src[j] || '')) j++;
      if (src[j] === '.' && !'*/\\^\''.includes(src[j + 1] || ' ') && !(src[j + 1] === '.' && src[j + 2] === '.')) { j++; while (isDigit(src[j] || '')) j++; }
      if ((src[j] === 'e' || src[j] === 'E') && (isDigit(src[j + 1] || '') || ((src[j + 1] === '+' || src[j + 1] === '-') && isDigit(src[j + 2] || '')))) { j += 2; while (isDigit(src[j] || '')) j++; }
      if ((src[j] === 'i' || src[j] === 'j') && !isIdChar(src[j + 1] || ' ')) err(t('script.lex.complex'));
      if (isIdStart(src[j] || ' ')) err(t('script.lex.bad_number', { text: src.slice(i, j + 1) }));
      const text = src.slice(i, j);
      i = j;
      push('num', Number(text), line, col, space);
      space = false;
      continue;
    }
    // names and keywords
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      // `end` inside ( ) or { } index brackets is a value, not a block end; the parser decides — keep it a kw
      push(KEYWORDS.has(w) ? 'kw' : 'id', w, line, col, space);
      space = false;
      continue;
    }
    // strings vs transpose
    if (c === "'") {
      const prev = last();
      const transpose = endsValue(prev) && !(space && inMatrix()) && !(prev.type === 'op' && prev.auto);
      if (transpose) { i++; push('op', "'", line, col, space); space = false; continue; }
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') err(t('script.lex.open_quote_single'), line, col);
        if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; }
        s += src[j++];
      }
      i = j + 1;
      push('str', s, line, col, space);
      space = false;
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') err(t('script.lex.open_quote_double'), line, col);
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      i = j + 1;
      push('str', s, line, col, space);
      space = false;
      continue;
    }
    // operators
    let op = null;
    for (const o of OPS2) if (src.startsWith(o, i)) { op = o; break; }
    if (!op && OPS1.includes(c)) op = c;
    if (!op) err(t('script.lex.bad_char', { char: c }));
    // "a = ..." vs "a == b": the comparison wins (OPS2 first). "!=" means "~=".
    i += op.length;
    if (op === '(' || op === '[' || op === '{') { push('op', op, line, col, space); stack.push(op); space = false; continue; }
    if (op === ')' || op === ']' || op === '}') {
      const want = { ')': '(', ']': '[', '}': '{' }[op];
      // drop a trailing auto separator before the closing bracket ([1 2 ;] / rows ending in a newline)
      while (last() && last().auto && (op !== ')')) toks.pop();
      if (stack[stack.length - 1] !== want) err(stack.length ? t('script.lex.expected_close', { want: { '(': ')', '[': ']', '{': '}' }[stack[stack.length - 1]], got: op }) : t('script.lex.no_open', { op }));
      stack.pop();
      push('op', op, line, col, space);
      space = false;
      continue;
    }
    push('op', op === '!=' ? '~=' : op === '!' ? '~' : op, line, col, space);
    space = false;
  }
  if (stack.length) {
    const open = [...toks].reverse().find((tok) => tok.type === 'op' && tok.value === stack[stack.length - 1]);
    throw new CsError(t('script.lex.never_closed', { op: stack[stack.length - 1] }), { line: open ? open.line : line, col: open ? open.col : 1, file });
  }
  toks.push({ type: 'nl', value: '\n', line, col: i - lineStart + 1, space: false });
  toks.push({ type: 'eof', value: null, line, col: i - lineStart + 1, space: false });
  return toks;
}
