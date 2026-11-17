/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-edit-tools.js — the script editor's find and replace, code folding and autocompletion, as pure functions (DOM-free; the
 * editor in cs-editor.js calls them, Node tests drive them). 0.4 P7.
 *
 *   findAll(text, query, { matchCase, wholeWord, regex }) → { matches: [{ s, e }], error }   (error: a bad regular expression)
 *   replaceAll(text, query, repl, opts) → { text, count }      replaceMatch(text, m, query, repl, opts) → the replacement for m
 *     (regex: $1…$9, $& and $$ in repl, like String.replace; otherwise repl is literal)
 *   foldBlocks(lines, lang) → [{ start, end }]   block opener line → its closing line (0-based, start < end − 1: something to
 *     hide); craft: if for while switch try function … end ('end' inside ( ) [ ] { } is indexing); lua: function do if repeat …
 *     end / until (a for / while line counts its do; elseif/else do not open). Strings and comments never count.
 *   completions(prefix, { keywords, builtins: [{ name, args, doc }], vars: [names], text, max }) → [{ label, kind, detail }]
 *     kind 'var' | 'builtin' | 'keyword' | 'word' (other words of the script); case-sensitive prefix first, then the rest;
 *     the prefix itself is never offered.
 *   Fold markers (the textarea holds a folded block as one marker at the end of its first line; the folded lines live in the
 *   editor): FOLD_OPEN … FOLD_CLOSE around the fold id in base 4 of zero-width characters, so the caret and the drawn text do
 *   not move. foldMarker(id) · markersIn(text) → [{ id, at, len }] · stripMarkers(text) · expandFolds(text, hidden: Map id → the
 *   folded lines' text, '\n'-joined) → the full text: each marker is removed and its lines go after the END of its line.
 */
export const FOLD_OPEN = '⁣', FOLD_CLOSE = '⁤';
const DIGITS = ['​', '‌', '‍', '⁠'];
const MARK_RE = /⁣([​‌‍⁠]+)⁤/g;
export const MARK_CHARS = /[⁣⁤​‌‍⁠]/;

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWord = (c) => !!c && /[A-Za-z0-9_]/.test(c);

/** The query as a global RegExp (or an error message). */
function queryRe(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { re: null };
  let src = regex ? query : escRe(query);
  if (wholeWord) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
  try { return { re: new RegExp(src, 'g' + (matchCase ? '' : 'i') + 'u') }; } catch (e) { return { re: null, error: e.message }; }
}

export function findAll(text, query, opts = {}) {
  const { re, error } = queryRe(query, opts);
  if (!re) return { matches: [], error: error || null };
  const matches = [];
  let m;
  while ((m = re.exec(text)) && matches.length < 100000) {
    if (m[0].length === 0) { re.lastIndex++; continue; }   // empty matches (a regex like a*) find nothing to replace
    matches.push({ s: m.index, e: m.index + m[0].length });
  }
  return { matches, error: null };
}

/** repl with $1…$9, $& and $$ filled from a match's groups (String.replace's rules for those). */
function fill(repl, g) {
  return repl.replace(/\$(\$|&|[1-9])/g, (_, k) => (k === '$' ? '$' : k === '&' ? g[0] : g[+k] ?? ''));
}
/** The replacement text for one match m of findAll (its groups read at its own place, so lookbehinds see their context). */
export function replaceMatch(text, m, query, repl, opts = {}) {
  if (!opts.regex) return repl;
  const { re } = queryRe(query, opts);
  const one = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  one.lastIndex = m.s;
  const g = one.exec(text);
  return g ? fill(repl, g) : repl;
}

export function replaceAll(text, query, repl, opts = {}) {
  const { matches } = findAll(text, query, opts);
  if (!matches.length) return { text, count: 0 };
  let out = '', at = 0;
  for (const m of matches) { out += text.slice(at, m.s) + replaceMatch(text, m, query, repl, opts); at = m.e; }
  return { text: out + text.slice(at), count: matches.length };
}

// ---------------------------------------------------------------- folding
const OPENERS = { craft: new Set(['if', 'for', 'while', 'switch', 'try', 'function', 'parfor']), lua: new Set(['function', 'do', 'if', 'repeat']) };
const CLOSERS = { craft: new Set(['end']), lua: new Set(['end', 'until']) };

/** The block words of one line, outside strings and comments: [{ w, depth (brackets open before it) }]. */
function blockWords(line, lang, state) {
  const out = [], q = lang === 'lua' ? ['"', "'"] : ['"', "'"];
  let depth = 0, i = 0, prev = '';
  const n = line.length;
  if (state.block) {
    const close = lang === 'lua' ? ']]' : '%}';
    const e = lang === 'lua' ? line.indexOf(close) : (line.trim() === close ? 0 : -1);
    if (e < 0) return out;
    state.block = false; i = lang === 'lua' ? e + 2 : n;
  }
  while (i < n) {
    const c = line[i];
    if (lang === 'craft' && c === '%') { if (line.trim() === '%{') state.block = true; break; }
    if (lang === 'lua' && line.startsWith('--', i)) { if (line.startsWith('--[[', i)) { const e = line.indexOf(']]', i + 4); if (e < 0) { state.block = true; break; } i = e + 2; continue; } break; }
    if (q.includes(c) && !(lang === 'craft' && c === "'" && /[\w)\].'}]/.test(prev))) { let j = i + 1; while (j < n && line[j] !== c) { if (line[j] === '\\' && c === '"') j++; j++; } i = j + 1; prev = '"'; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i, i + 64));
    if (m && !isWord(line[i - 1])) { out.push({ w: m[0], depth }); i += m[0].length; prev = 'a'; continue; }
    if (c !== ' ' && c !== '\t') prev = c;
    i++;
  }
  return out;
}

export function foldBlocks(lines, lang = 'craft') {
  if (lang === 'python') return [];   // indentation blocks are not folded yet (0.4 P10)
  const L = lang === 'lua' ? 'lua' : 'craft', open = OPENERS[L], close = CLOSERS[L], stack = [], out = [], state = { block: false };
  lines.forEach((line, li) => {
    for (const { w, depth } of blockWords(line, L, state)) {
      if (depth > 0) continue;   // MATLAB a(end), x{end}: indexing, not a block end
      if (open.has(w)) stack.push(li);
      else if (close.has(w) && stack.length) { const s = stack.pop(); if (li - s > 1) out.push({ start: s, end: li }); }
    }
  });
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

// ---------------------------------------------------------------- completion
export function completions(prefix, { keywords = [], builtins = [], vars = [], text = '', max = 40 } = {}) {
  if (!prefix || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) return [];
  const seen = new Set([prefix]), out = [];
  const add = (label, kind, detail = '') => { if (seen.has(label) || !label.toLowerCase().startsWith(prefix.toLowerCase())) return; seen.add(label); out.push({ label, kind, detail }); };
  for (const v of vars) add(v, 'var');
  for (const b of builtins) { const sig = !b.args ? '' : String(b.args).startsWith(b.name + '(') ? String(b.args) : `${b.name}(${b.args})`; add(b.name, 'builtin', sig && b.doc ? sig + ' — ' + b.doc : sig || b.doc || ''); }
  for (const k of keywords) add(k, 'keyword');
  for (const w of new Set(stripMarkers(text).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])) add(w, 'word');
  const rank = (c) => (c.label.startsWith(prefix) ? 0 : 1) * 10 + { var: 0, builtin: 1, keyword: 2, word: 3 }[c.kind];
  return out.sort((a, b) => rank(a) - rank(b) || a.label.length - b.label.length || (a.label < b.label ? -1 : 1)).slice(0, max);
}

// ---------------------------------------------------------------- fold markers
export function foldMarker(id) {
  let s = '', n = id;
  do { s = DIGITS[n % 4] + s; n = Math.floor(n / 4); } while (n > 0);
  return FOLD_OPEN + s + FOLD_CLOSE;
}
export function markersIn(text) {
  const out = [];
  for (const m of text.matchAll(MARK_RE)) { let id = 0; for (const ch of m[1]) id = id * 4 + DIGITS.indexOf(ch); out.push({ id, at: m.index, len: m[0].length }); }
  return out;
}
export const stripMarkers = (text) => String(text).replace(MARK_RE, '').replace(new RegExp(MARK_CHARS.source, 'g'), '');
/** The full text: every marker removed, its folded lines put back after the end of its line (folds inside folds too). */
export function expandFolds(text, hidden) {
  let t = String(text);
  for (let guard = 0; guard < 10000; guard++) {
    const ms = markersIn(t);
    const m = ms.find((x) => hidden.has(x.id));
    if (!m) break;
    const before = t.slice(0, m.at), after = t.slice(m.at + m.len), eol = after.indexOf('\n');
    const rest = eol < 0 ? after : after.slice(0, eol), tail = eol < 0 ? '' : after.slice(eol);
    t = before + rest + '\n' + hidden.get(m.id) + tail;
  }
  return stripMarkers(t);
}
