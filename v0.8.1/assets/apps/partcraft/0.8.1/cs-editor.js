/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-editor.js — the Script workspace's code editor: a plain <textarea> (the browser's own editing, undo, selection,
 * IME and screen-reader support) with a highlighted copy of the visible lines drawn underneath it and line numbers
 * beside it. Only the lines on screen are highlighted, so a 10,000-line script edits as fast as a short one.
 *
 *   tokenizeLine(text, grammar, state) → { tokens: [{ t: 'kw'|'bi'|'str'|'num'|'com'|'op'|'id'|'sp', s }], state }  (pure)
 *   const ed = createEditor({ el, onRun, onRunSelection, onFlush, onChange, label })
 *   ed.root · ed.textarea · setText(text, { readOnly, view }) · getText() · setGrammar(grammar, builtinNames)
 *   markError(line | 0) · goTo(line, col) · selectionOrLine() → { text, line } · view() → { top, left, start, end } · refresh()
 *
 * A grammar is the adapter's `highlight` (docs/SCRIPTING-SPEC.md §3): { keywords: [..], comment: '%' | { line, block: [open,
 * close] }, string: ["'", '"'], number: true }. Keys in the editor: F5 runs, Ctrl+Enter runs the selection (or the line),
 * Tab / Shift+Tab indent, Esc then Tab leaves the editor, Enter keeps the indent, Ctrl+/ comments lines out and back.
 * The DOM is made with the `el` passed in (ui-util.js), so text from a script only ever becomes text nodes.
 *
 * 0.4 P7 (pure parts in cs-edit-tools.js): FIND AND REPLACE — Ctrl+F / Ctrl+H open a bar over the code (match case, whole
 * word, regular expression; Enter / Shift+Enter or F3 / Shift+F3 next / previous; Replace; Replace all = one undo step; the
 * matches on screen are highlighted; opening it unfolds the code). FOLDING — the gutter's ▾ / ▸ or Ctrl+Shift+[ / ] fold
 * and unfold the block on the caret's line (if/for/while/switch/try/function … end; Lua function/do/if/repeat … end/until):
 * the folded lines leave the textarea and one zero-width marker stays at the end of the block's first line, so getText(),
 * Run, Save and copy always see the whole script, line numbers stay true, and an edit that touches a folded line unfolds it
 * first; folding is an undo step like any edit. AUTOCOMPLETE — typing two letters of a name, or Ctrl+Space, lists variables
 * (createEditor's `words`), the language's functions with their arguments, keywords and the script's own names; arrows
 * choose, Enter or Tab takes one, Esc closes.
 */
import { findAll, replaceMatch, replaceAll, foldBlocks, completions, foldMarker, markersIn, expandFolds, stripMarkers, MARK_CHARS } from './cs-edit-tools.js';
import { t } from './i18n.js';

export const DEFAULT_GRAMMARS = {
  craft: { keywords: ['if', 'elseif', 'else', 'end', 'for', 'while', 'break', 'continue', 'switch', 'case', 'otherwise', 'try', 'catch', 'function', 'return', 'global', 'persistent'], comment: { line: '%', block: ['%{', '%}'] }, string: ["'", '"'], number: true },
  lua: { keywords: ['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'], comment: { line: '--', block: ['--[[', ']]'] }, string: ["'", '"'], number: true },
  python: { keywords: ['False', 'None', 'True', 'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'], comment: { line: '#' }, string: ["'", '"'], number: true },   // 0.4 P10
};

function normGrammar(g) {
  const kw = new Set(Array.isArray(g?.keywords) ? g.keywords.filter((k) => typeof k === 'string') : g?.keywords instanceof Set ? g.keywords : []);
  let c = g?.comment;
  if (Array.isArray(c)) c = { line: c[0], block: c.length >= 3 ? [c[1], c[2]] : null };   // [line, blockOpen, blockClose]
  const line = typeof c === 'string' ? [c] : c && typeof c === 'object' ? [].concat(c.line || []).filter((x) => typeof x === 'string' && x) : [];
  const block = c && Array.isArray(c.block) && c.block.length === 2 && c.block.every((x) => typeof x === 'string' && x) ? c.block : null;
  const quotes = Array.isArray(g?.string) ? g.string.filter((q) => typeof q === 'string' && q.length === 1) : ["'", '"'];
  return { kw, line, block, quotes, number: g?.number !== false };
}

/** Tokens of one line, given the state at its start ({ block: bool }); returns the state at its end. */
export function tokenizeLine(text, grammar, state = { block: false }, builtins = null) {
  const G = grammar && grammar.kw ? grammar : normGrammar(grammar);
  const out = [];
  let i = 0, inBlock = !!(state && state.block), prevSig = '';
  const push = (t, s) => { if (s) out.push({ t, s }); };
  // a block comment that opens only as a whole line (MATLAB's %{): its opener starts with the line-comment marker
  const blockAlone = G.block && G.line.some((l) => G.block[0].startsWith(l));
  while (i < text.length) {
    if (inBlock) {
      if (blockAlone) { push('com', text.slice(i)); if (text.trim() === G.block[1]) inBlock = false; i = text.length; break; }
      const e = text.indexOf(G.block[1], i);
      if (e < 0) { push('com', text.slice(i)); i = text.length; break; }
      push('com', text.slice(i, e + G.block[1].length)); i = e + G.block[1].length; inBlock = false; continue;
    }
    const ch = text[i];
    if (ch === ' ' || ch === '\t') { let j = i; while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++; push('sp', text.slice(i, j)); i = j; continue; }
    if (G.block && text.startsWith(G.block[0], i) && (!blockAlone || text.trim() === G.block[0])) {
      const e = blockAlone ? -1 : text.indexOf(G.block[1], i + G.block[0].length);
      if (e < 0) { push('com', text.slice(i)); i = text.length; inBlock = true; break; }
      push('com', text.slice(i, e + G.block[1].length)); i = e + G.block[1].length; continue;
    }
    if (G.line.some((l) => text.startsWith(l, i))) { push('com', text.slice(i)); break; }
    if (G.quotes.includes(ch) && !(ch === "'" && /[\w)\].'}]/.test(prevSig))) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (text[j] === '\\' && ch === '"') j++; j++; }
      push('str', text.slice(i, Math.min(text.length, j + 1))); i = j + 1; prevSig = '"'; continue;
    }
    const num = G.number && /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (num && !/\w/.test(text[i - 1] || '')) { push('num', num[0]); i += num[0].length; prevSig = '0'; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 128));
    if (id) { const w = id[0]; push(G.kw.has(w) ? 'kw' : builtins && builtins.has(w) ? 'bi' : 'id', w); i += w.length; prevSig = 'a'; continue; }
    push('op', ch); prevSig = ch; i++;
  }
  return { tokens: out, state: { block: inBlock } };
}

export function createEditor({ el, onRun = () => {}, onRunSelection = () => {}, onFlush = () => {}, onChange = () => {}, label = 'Script', words = () => [] }) {
  let grammar = normGrammar(DEFAULT_GRAMMARS.craft), builtins = new Set(), builtinDocs = [], lines = [''], states = [{ block: false }], validTo = 0;
  let errLine = 0, raf = 0, lh = 0, cw = 0, tabEscapes = false, lang = 'craft';
  const hidden = new Map();   // fold id → the folded lines (P7); ids never reused, entries kept so Redo of a fold still expands
  let nextFold = 1;
  const find = { open: false, replace: false, q: '', r: '', matchCase: false, wholeWord: false, regex: false, matches: [], cur: -1, error: null };
  const ac = { open: false, items: [], sel: 0, start: 0 };
  const gutterIn = el('div', { className: 'cs-gutter-in' });
  const gutter = el('div', { className: 'cs-gutter', 'aria-hidden': 'true' }, gutterIn);
  const hlIn = el('div', { className: 'cs-hl-in' });
  const hl = el('pre', { className: 'cs-hl', 'aria-hidden': 'true' }, hlIn);
  const ta = el('textarea', { className: 'cs-ta', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': label, dataset: { csEditor: '1' } });
  ta.setAttribute('autocorrect', 'off');
  // find bar, match boxes and the completion list (P7)
  const uid = Math.random().toString(36).slice(2, 8);
  const hits = el('div', { className: 'cs-hits', 'aria-hidden': 'true' });
  const fq = el('input', { type: 'text', className: 'pc-input cs-find-q', spellcheck: false, autocomplete: 'off', 'aria-label': t('cs.find.q'), placeholder: t('cs.find.q'), dataset: { csFind: '1' } });
  const fr = el('input', { type: 'text', className: 'pc-input cs-find-r', spellcheck: false, autocomplete: 'off', 'aria-label': t('cs.find.r'), placeholder: t('cs.find.r'), dataset: { csReplace: '1' } });
  const tog = (key, label, title) => { const b = el('button', { type: 'button', className: 'pc-btn pc-btn-sm cs-find-opt', title, 'aria-pressed': 'false', dataset: { csFindOpt: key } }, label); b.addEventListener('click', () => { find[key] = !find[key]; b.setAttribute('aria-pressed', String(find[key])); runFind(true); fq.focus(); }); return b; };
  const fbtn = (label, title, fn, data) => el('button', { type: 'button', className: 'pc-btn pc-btn-sm', title, onclick: fn, dataset: data }, label);
  const fcount = el('span', { className: 'cs-find-count', 'aria-live': 'polite', dataset: { csFindCount: '1' } });
  const replRow = el('div', { className: 'cs-find-row', dataset: { csReplaceRow: '1' } }, fr, fbtn(t('cs.find.replace'), t('cs.find.replace.title'), () => replaceOne(), { csReplaceOne: '1' }), fbtn(t('cs.find.replace_all'), t('cs.find.replace_all.title'), () => replaceEvery(), { csReplaceAll: '1' }));
  const findBar = el('div', { className: 'cs-find', role: 'search', 'aria-label': t('cs.find.title'), hidden: true },
    el('div', { className: 'cs-find-row' }, fq, tog('matchCase', 'Aa', t('cs.find.case')), tog('wholeWord', 'W', t('cs.find.word')), tog('regex', '.*', t('cs.find.regex')), fcount,
      fbtn('↑', t('cs.find.prev'), () => step(-1), { csFindPrev: '1' }), fbtn('↓', t('cs.find.next'), () => step(1), { csFindNext: '1' }), fbtn('×', t('cs.find.close'), () => closeFind(), { csFindClose: '1' })),
    replRow);
  const acList = el('ul', { className: 'cs-ac', role: 'listbox', id: 'cs-ac-' + uid, hidden: true, 'aria-label': t('cs.ac.title'), dataset: { csAc: '1' } });
  ta.setAttribute('aria-autocomplete', 'list'); ta.setAttribute('aria-controls', acList.id);
  const box = el('div', { className: 'cs-ed' }, gutter, el('div', { className: 'cs-code' }, hits, hl, ta, acList));
  const root = el('div', { className: 'cs-ed-wrap' }, findBar, box);   // the find bar sits above the code, never over it

  const schedule = () => { if (raf) return; const w = ta.ownerDocument.defaultView || globalThis; raf = w.requestAnimationFrame(() => { raf = 0; render(); }); };
  function syncLines() {
    const next = ta.value.split('\n');
    let k = 0;
    const n = Math.min(next.length, lines.length);
    while (k < n && next[k] === lines[k]) k++;
    lines = next;
    validTo = Math.min(validTo, k);
    states.length = Math.min(states.length, validTo + 1);
  }
  function stateAt(i) {
    while (validTo < i) { const r = tokenizeLine(lines[validTo] || '', grammar, states[validTo], builtins); states[validTo + 1] = r.state; validTo++; }
    return states[i];
  }
  function measure() {
    const cs = ta.ownerDocument.defaultView.getComputedStyle(ta);
    lh = parseFloat(cs.lineHeight) || 18;
  }
  /** Folds in the textarea now: per visible line, its markers' folded line counts; real line numbers follow. */
  function foldInfo() {
    const byLine = new Map(), v = ta.value;
    let li = 0, at = 0;
    for (const m of markersIn(v)) {
      if (!hidden.has(m.id)) continue;
      while (at < m.at) { const nl = v.indexOf('\n', at); if (nl < 0 || nl >= m.at) break; li++; at = nl + 1; }
      const n = expandFolds(hidden.get(m.id), hidden).split('\n').length;
      byLine.set(li, (byLine.get(li) || 0) + n);
    }
    return byLine;
  }
  /** Visible line i → its real (1-based) line number in the whole script. */
  function realLines(byLine) {
    const real = new Int32Array(lines.length + 1);
    let add = 0;
    for (let i = 0; i < lines.length; i++) { real[i] = i + 1 + add; add += byLine.get(i) || 0; }
    real[lines.length] = lines.length + 1 + add;
    return real;
  }
  function render() {
    if (!ta.isConnected || !ta.clientHeight) return;
    if (!lh) measure();
    const top = ta.scrollTop, h = ta.clientHeight;
    const first = Math.max(0, Math.floor(top / lh) - 2), last = Math.min(lines.length - 1, Math.ceil((top + h) / lh) + 2);
    const rows = [], nums = [], byLine = foldInfo(), real = realLines(byLine);
    const starts = new Set(foldBlocks(lines.map(stripMarkers), lang).map((b) => b.start));
    stateAt(first);
    let st = states[first];
    for (let i = first; i <= last; i++) {
      const r = tokenizeLine(lines[i], grammar, st, builtins);
      if (i + 1 > validTo && i === validTo) { states[i + 1] = r.state; validTo = i + 1; }
      st = r.state;
      const folded = byLine.get(i) || 0, isErr = real[i] === errLine;
      const cls = 'cs-line' + (isErr ? ' is-err' : '');
      rows.push(el('div', { className: cls }, r.tokens.length ? r.tokens.map((x) => (x.t === 'id' || x.t === 'sp' || x.t === 'op' ? x.s : el('span', { className: 'cs-t-' + x.t }, x.s))) : '​',
        folded ? el('span', { className: 'cs-fold-badge', dataset: { csFolded: String(folded) } }, ' ' + t('cs.fold.badge', { n: folded })) : null));
      const mark = folded ? '▸' : starts.has(i) ? '▾' : '';
      nums.push(el('div', { className: isErr ? 'is-err' : '', dataset: { line: String(i) } }, mark ? el('span', { className: 'cs-fold-tog', dataset: { csFoldTog: String(i) } }, mark) : null, String(real[i])));
    }
    hlIn.replaceChildren(...rows);
    gutterIn.replaceChildren(...nums);
    const y = first * lh - top;
    hlIn.style.transform = `translate(${-ta.scrollLeft}px, ${y}px)`;
    gutterIn.style.transform = `translateY(${y}px)`;
    gutter.style.width = `${String(real[lines.length]).length + 3}ch`;   // + room for the fold toggle   // i18n-ignore: CSS
    drawHits(first, last);
  }
  /** Find matches on screen as boxes under the text (the current one stronger). */
  function drawHits(first, last) {
    if (!find.open || !find.matches.length) { hits.replaceChildren(); return; }
    if (!cw) measureCh();
    const v = ta.value, pad = padding(), boxes = [];
    let li = 0, ls = 0;
    for (let k = 0; k < find.matches.length && li <= last; k++) {
      const m = find.matches[k];
      while (true) { const nl = v.indexOf('\n', ls); if (nl < 0 || nl >= m.s) break; li++; ls = nl + 1; }
      if (li < first || li > last) continue;
      const line = v.slice(ls, v.indexOf('\n', ls) < 0 ? v.length : v.indexOf('\n', ls));
      const x0 = visCol(line, m.s - ls), x1 = visCol(line, Math.min(m.e, ls + line.length) - ls);
      boxes.push(el('div', { className: 'cs-hit' + (k === find.cur ? ' is-cur' : ''), style: `left:${pad.l + x0 * cw - ta.scrollLeft}px;top:${pad.t + li * lh - ta.scrollTop}px;width:${Math.max(2, (x1 - x0) * cw)}px;height:${lh}px` }));
    }
    hits.replaceChildren(...boxes);
  }
  const visCol = (line, idx) => { let c = 0; for (let i = 0; i < idx && i < line.length; i++) { const ch = line[i]; if (ch === '\t') c += 4 - (c % 4); else if (!MARK_CHARS.test(ch)) c++; } return c; };
  function measureCh() { const sp = el('span', { style: 'visibility:hidden;position:absolute;white-space:pre' }, 'M'.repeat(40)); hl.append(sp); cw = sp.getBoundingClientRect().width / 40 || 8; sp.remove(); }
  function padding() { const cs = ta.ownerDocument.defaultView.getComputedStyle(ta); return { l: parseFloat(cs.paddingLeft) || 0, t: parseFloat(cs.paddingTop) || 0 }; }

  // ---- editing helpers (execCommand keeps the textarea's own undo; setRangeText is the fallback)
  let internal = false;
  function insert(text, start = ta.selectionStart, end = ta.selectionEnd) {
    internal = true;
    try { insertRaw(text, start, end); } finally { internal = false; }
  }
  function insertRaw(text, start, end) {
    ta.focus();
    if (start !== ta.selectionStart || end !== ta.selectionEnd) ta.setSelectionRange(start, end);
    let done = false;
    try { done = ta.ownerDocument.execCommand('insertText', false, text); } catch { done = false; }
    if (!done) { ta.setRangeText(text, start, end, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function lineRange() {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const a = v.lastIndexOf('\n', s - 1) + 1;
    let b = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e); if (b < 0) b = v.length;
    return { a, b, text: v.slice(a, b) };
  }
  function mapLines(fn) {
    const { a, b, text } = lineRange();
    const s0 = ta.selectionStart, e0 = ta.selectionEnd, out = text.split('\n').map(fn).join('\n');
    insert(out, a, b);
    if (s0 !== e0) ta.setSelectionRange(a, a + out.length);
  }
  function toggleComment() {
    const mark = grammar.line[0];
    if (!mark) return;
    const { text } = lineRange();
    const all = text.split('\n').filter((l) => l.trim()).every((l) => l.trimStart().startsWith(mark));
    mapLines((l) => (!l.trim() ? l : all ? l.replace(new RegExp('^(\\s*)' + mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ?'), '$1') : l.replace(/^(\s*)/, `$1${mark} `)));
  }

  // ---- folding (P7)
  const lineStart = (v, pos) => v.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (v, pos) => { const n = v.indexOf('\n', pos); return n < 0 ? v.length : n; };
  const posOfLine = (v, i) => { let p = 0; for (let k = 0; k < i && p >= 0; k++) { const n = v.indexOf('\n', p); if (n < 0) return v.length; p = n + 1; } return p; };
  /** Fold the block whose first line is visible line i (or the innermost block around it). */
  function foldAt(i) {
    const vis = ta.value.split('\n');
    const blocks = foldBlocks(vis.map(stripMarkers), lang);
    const b = blocks.find((x) => x.start === i) || blocks.filter((x) => x.start < i && x.end > i).sort((x, y) => y.start - x.start)[0];
    if (!b) return false;
    const v = ta.value, a = lineEnd(v, posOfLine(v, b.start)), z = lineEnd(v, posOfLine(v, b.end - 1));
    const id = nextFold++;
    hidden.set(id, v.slice(a + 1, z));
    insert(foldMarker(id), a, z);   // one undo step: Ctrl+Z puts the lines back and the marker goes with them
    ta.setSelectionRange(lineStart(ta.value, a), lineStart(ta.value, a));
    return true;
  }
  /** Unfold the markers (each { id, at, len }), latest first so earlier positions stay put. The text positions `track`
   *  are moved with the edit: a marker before one takes its length off; the folded lines come back at the end of the marker's
   *  line, and push a position only when they land before it (a caret at that line's end stays on that line). → the moved positions. */
  function unfold(ms, track = [], atEndIsAfter = []) {
    const out = [...track];
    for (const m of [...ms].sort((x, y) => y.at - x.at)) {
      const v = ta.value, e = lineEnd(v, m.at), rest = v.slice(m.at + m.len, e), add = '\n' + hidden.get(m.id);
      insert(rest + add, m.at, e);
      // atEndIsAfter[k]: position k starts a range at that line's newline — the newline after the whole block once it is open
      for (let k = 0; k < out.length; k++) { const p = out[k]; out[k] = p - (m.at < p ? Math.min(m.len, p - m.at) : 0) + (e < p || (e === p && atEndIsAfter[k]) ? add.length : 0); }
    }
    return out;
  }
  function unfoldAt(i) {
    const v = ta.value, a = posOfLine(v, i), ms = markersIn(v).filter((m) => m.at >= a && m.at <= lineEnd(v, a) && hidden.has(m.id));
    if (!ms.length) return false;
    unfold(ms);
    ta.setSelectionRange(a, a);
    return true;
  }
  const unfoldAll = () => { const ms = markersIn(ta.value).filter((m) => hidden.has(m.id)); if (ms.length) unfold(ms); return ms.length; };
  /** Before an edit of [s, e): unfold every fold whose first line (newline included) it touches. → [s, e] after unfolding. */
  function guard(s, e) {
    const v = ta.value, ms = markersIn(v).filter((m) => hidden.has(m.id) && lineStart(v, m.at) <= e && s <= lineEnd(v, m.at) + 1);
    if (!ms.length) return null;
    return unfold(ms, [s, e], [e > s, false]);
  }
  const curLine = () => ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  /** Real (1-based) line → visible line index, unfolding what hides it. */
  function visibleLine(real) {
    for (let guardN = 0; guardN < 1000; guardN++) {
      const byLine = foldInfo(), r = realLines(byLine);
      let i = 0; while (i + 1 < lines.length && r[i + 1] <= real) i++;
      if (r[i] === real || !(byLine.get(i))) return i;
      if (!unfoldAt(i)) return i;
      syncLines();
    }
    return 0;
  }

  // ---- find and replace (P7): the bar searches the whole script, so it unfolds everything when it opens
  function openFind(withReplace) {
    unfoldAll(); syncLines();
    find.open = true; find.replace = !!withReplace || find.replace;
    findBar.hidden = false; replRow.hidden = !find.replace;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n')) { fq.value = sel; }
    find.q = fq.value; runFind(true);
    fq.focus(); fq.select();
  }
  function closeFind() { find.open = false; findBar.hidden = true; find.matches = []; hits.replaceChildren(); ta.focus(); }
  function runFind(keepPlace) {
    find.q = fq.value; find.r = fr.value;
    const r = findAll(ta.value, find.q, find);
    find.matches = r.matches; find.error = r.error;
    if (!keepPlace || find.cur >= find.matches.length) find.cur = -1;
    if (find.cur < 0 && find.matches.length) { const c = ta.selectionStart; find.cur = Math.max(0, find.matches.findIndex((m) => m.s >= c)); if (find.matches[find.cur]?.s < c) find.cur = 0; }
    fcount.textContent = find.error ? t('cs.find.bad', { why: find.error }) : find.q ? (find.matches.length ? t('cs.find.count', { i: find.cur + 1, n: find.matches.length }) : t('cs.find.none')) : '';
    fcount.classList.toggle('is-bad', !!find.error);
    schedule();
  }
  function step(d) {
    if (!find.matches.length) { runFind(false); if (!find.matches.length) return; }
    find.cur = (find.cur + d + find.matches.length) % find.matches.length;
    const m = find.matches[find.cur];
    ta.setSelectionRange(m.s, m.e);
    const line = ta.value.slice(0, m.s).split('\n').length;
    if (!lh) measure();
    if ((line - 1) * lh < ta.scrollTop || line * lh > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 3);
    fcount.textContent = t('cs.find.count', { i: find.cur + 1, n: find.matches.length });
    schedule();
  }
  function replaceOne() {
    if (ta.readOnly) return;
    runFind(true);
    const m = find.matches[find.cur];
    if (!m) return;
    const rep2 = replaceMatch(ta.value, m, find.q, fr.value, find);
    insert(rep2, m.s, m.e);
    syncLines(); runFind(true); step(0);
    fr.focus();   // keep replacing from the bar
  }
  function replaceEvery() {
    if (ta.readOnly) return;
    unfoldAll(); syncLines();
    const r = replaceAll(ta.value, fq.value, fr.value, find);
    if (!r.count) { runFind(true); return; }
    insert(r.text, 0, ta.value.length);   // one undo step
    syncLines(); runFind(false);
    fcount.textContent = t('cs.find.replaced', { n: r.count });
    fr.focus();
  }
  fq.addEventListener('input', () => runFind(false));
  fr.addEventListener('input', () => { find.r = fr.value; });
  findBar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
    if (e.key === 'Enter' && e.target === fq) { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Enter' && e.target === fr) { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceEvery(); else replaceOne(); return; }
    if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    e.stopPropagation();   // the page's own keys never see typing here
  });

  // ---- autocomplete (P7)
  function prefixAtCaret() { const v = ta.value, c = ta.selectionStart; let a = c; while (a > 0 && /[A-Za-z0-9_]/.test(v[a - 1])) a--; return /^[A-Za-z_]/.test(v.slice(a, c)) ? { s: a, text: v.slice(a, c) } : { s: c, text: '' }; }
  function openAc(force) {
    if (ta.readOnly || ta.selectionStart !== ta.selectionEnd) return closeAc();
    const p = prefixAtCaret();
    if (!p.text || (!force && p.text.length < 2)) return closeAc();
    let vars = [];
    try { vars = words() || []; } catch { vars = []; }
    const items = completions(p.text, { keywords: [...grammar.kw], builtins: builtinDocs, vars, text: ta.value });
    if (!items.length) return closeAc();
    ac.open = true; ac.items = items; ac.sel = 0; ac.start = p.s;
    acList.replaceChildren(...items.map((it, k) => el('li', { id: `${acList.id}-${k}`, role: 'option', className: 'cs-ac-item' + (k === 0 ? ' is-sel' : ''), 'aria-selected': String(k === 0), dataset: { csAcItem: it.label } },
      el('span', { className: 'cs-ac-kind cs-ac-' + it.kind }, t('cs.ac.kind.' + it.kind)), el('span', { className: 'cs-ac-label' }, it.label), it.detail ? el('span', { className: 'cs-ac-detail' }, it.detail) : null)));
    for (const [k, li] of [...acList.children].entries()) li.addEventListener('mousedown', (e) => { e.preventDefault(); ac.sel = k; acceptAc(); });
    if (!lh) measure(); if (!cw) measureCh();
    const v = ta.value, ls = lineStart(v, p.s), line = v.slice(0, p.s).split('\n').length - 1, pad = padding();
    acList.style.left = `${Math.max(0, pad.l + visCol(v.slice(ls, lineEnd(v, ls)), p.s - ls) * cw - ta.scrollLeft)}px`;   // i18n-ignore: CSS
    acList.style.top = `${pad.t + (line + 1) * lh - ta.scrollTop}px`;   // i18n-ignore: CSS
    acList.hidden = false;
    ta.setAttribute('aria-expanded', 'true'); ta.setAttribute('aria-activedescendant', `${acList.id}-0`);
  }
  function closeAc() { if (!ac.open) return; ac.open = false; acList.hidden = true; acList.replaceChildren(); ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); }
  function moveAc(d) {
    const kids = acList.children;
    kids[ac.sel]?.classList.remove('is-sel'); kids[ac.sel]?.setAttribute('aria-selected', 'false');
    ac.sel = (ac.sel + d + ac.items.length) % ac.items.length;
    kids[ac.sel].classList.add('is-sel'); kids[ac.sel].setAttribute('aria-selected', 'true'); kids[ac.sel].scrollIntoView?.({ block: 'nearest' });
    ta.setAttribute('aria-activedescendant', kids[ac.sel].id);
  }
  function acceptAc() {
    const it = ac.items[ac.sel];
    closeAc();
    if (!it) return;
    insert(it.label, ac.start, ta.selectionStart);
  }

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (ac.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveAc(e.key === 'ArrowDown' ? 1 : -1); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !mod && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAc(); return; }
    }
    if (e.key === 'Escape' && find.open) { e.preventDefault(); closeFind(); return; }
    if (mod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); e.stopPropagation(); openFind(false); return; }
    if (mod && !e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); e.stopPropagation(); openFind(true); return; }
    if (e.key === 'F3' && find.open) { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (mod && e.key === ' ') { e.preventDefault(); e.stopPropagation(); openAc(true); return; }
    if (mod && e.shiftKey && (e.key === '[' || e.key === '{' || e.code === 'BracketLeft')) { e.preventDefault(); e.stopPropagation(); foldAt(curLine()); return; }
    if (mod && e.shiftKey && (e.key === ']' || e.key === '}' || e.code === 'BracketRight')) { e.preventDefault(); e.stopPropagation(); unfoldAt(curLine()); return; }
    if (e.key === 'F5') { e.preventDefault(); e.stopPropagation(); onRun(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onRunSelection(eds.selectionOrLine()); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { onFlush(); return; }   // the page saves after this
    if (e.key === 'Escape') { tabEscapes = true; return; }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (tabEscapes || ta.readOnly) { tabEscapes = false; return; }   // let focus move on
      e.preventDefault();
      if (e.shiftKey) mapLines((l) => l.replace(/^( {1,2}|\t)/, ''));
      else if (ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) mapLines((l) => (l ? '  ' + l : l));
      else insert('  ');
      return;
    }
    tabEscapes = false;
    if (ta.readOnly) return;
    if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !e.isComposing) {
      const v = ta.value, s = ta.selectionStart, a = v.lastIndexOf('\n', s - 1) + 1;
      const ind = /^[ \t]*/.exec(v.slice(a, s))[0];
      if (ind) { e.preventDefault(); insert('\n' + ind); }
      return;
    }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); }
  });
  ta.addEventListener('beforeinput', (e) => {
    if (ta.readOnly || internal) return;
    const it = e.inputType || '', s0 = ta.selectionStart, e0 = ta.selectionEnd;
    const data = it === 'insertFromPaste' || it === 'insertFromDrop' ? (e.dataTransfer?.getData('text/plain') ?? e.data ?? '') : (e.data ?? '');
    if (MARK_CHARS.test(data)) { e.preventDefault(); insert(stripMarkers(data)); return; }   // markers only come from folding
    let s = s0, z = e0;
    if (s === z) { if (it === 'deleteContentBackward') s = Math.max(0, s - 1); else if (it === 'deleteContentForward') z = Math.min(ta.value.length, z + 1); else if (it.startsWith('delete')) { s = lineStart(ta.value, s); z = lineEnd(ta.value, z) + 1; } }
    const g = guard(s, z);
    if (!g) return;
    e.preventDefault();   // the folds it touched are open now; do the same edit on the unfolded text
    if (it === 'insertText' || it === 'insertReplacementText' || it === 'insertFromPaste' || it === 'insertFromDrop') insert(data, g[0] + (s0 - s), g[1] - (z - e0));
    else if (it === 'insertLineBreak' || it === 'insertParagraph') insert('\n', g[0] + (s0 - s), g[1] - (z - e0));
    else if (it === 'deleteContentBackward' || it === 'deleteContentForward') insert('', g[0], g[1]);
    else ta.setSelectionRange(g[0] + (s0 - s), g[0] + (s0 - s));   // other deletions: the fold opens; press again
  });
  const clip = (e, cut) => {
    const s = ta.selectionStart, z = ta.selectionEnd;
    if (s === z || !MARK_CHARS.test(ta.value.slice(s, z))) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', expandFolds(ta.value.slice(s, z), hidden));
    if (cut && !ta.readOnly) { const g = guard(s, z) || [s, z]; insert('', g[0], g[1]); }
  };
  ta.addEventListener('copy', (e) => clip(e, false));
  ta.addEventListener('cut', (e) => clip(e, true));
  gutter.addEventListener('mousedown', (e) => {
    const tog = e.target.closest?.('[data-cs-fold-tog]');
    if (!tog) return;
    e.preventDefault();
    const i = Number(tog.dataset.csFoldTog);
    if (!unfoldAt(i)) foldAt(i);
    ta.focus();
  });
  gutter.style.pointerEvents = 'auto';
  ta.addEventListener('input', (e) => {
    syncLines(); schedule(); onChange(getText());
    if (find.open) runFind(true);
    if (!internal && e.inputType === 'insertText' && /[A-Za-z0-9_]/.test(e.data || '')) openAc(false); else if (ac.open && !internal) openAc(false);
  });
  ta.addEventListener('blur', () => setTimeout(closeAc, 120));
  ta.addEventListener('scroll', schedule, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { lh = 0; schedule(); }).observe(ta);

  /** The whole script: folded lines put back (P7). */
  function getText() { return hidden.size ? expandFolds(ta.value, hidden) : ta.value; }
  const eds = {
    root, textarea: ta,
    setText(text, { readOnly = false, view = null } = {}) {
      hidden.clear(); closeAc();
      if (find.open) closeFind();
      ta.value = stripMarkers(String(text ?? ''));
      ta.readOnly = !!readOnly;
      box.classList.toggle('is-readonly', !!readOnly);
      lines = ta.value.split('\n'); states = [{ block: false }]; validTo = 0; errLine = 0;
      if (view) { ta.scrollTop = view.top || 0; ta.scrollLeft = view.left || 0; try { ta.setSelectionRange(view.start || 0, view.end || 0); } catch { /* detached */ } }
      else { ta.scrollTop = 0; ta.scrollLeft = 0; }
      schedule();
    },
    getText,
    /** g: the language's highlight; names: its function names; opts { lang 'craft' | 'lua' (folding), docs [{ name, args, doc }] (autocomplete) }. */
    setGrammar(g, names, { lang: lg = null, docs = null } = {}) {
      grammar = normGrammar(g); if (names) builtins = new Set(names);
      if (docs) builtinDocs = docs.filter((b) => b && typeof b.name === 'string');
      else if (names) builtinDocs = names.map((name) => ({ name }));
      lang = lg === 'lua' || (!lg && grammar.line.includes('--')) ? 'lua' : 'craft';
      states = [{ block: false }]; validTo = 0; schedule();
    },
    /** line: the real (whole-script) line; a fold hiding it opens. */
    markError(line) { errLine = line > 0 ? line : 0; if (errLine) { visibleLine(errLine); syncLines(); } schedule(); },
    get errorLine() { return errLine; },
    goTo(line, col = 1) {
      const vis = visibleLine(line);
      syncLines();
      const v = ta.value;
      const pos = Math.min(v.length, posOfLine(v, vis) + Math.max(0, col - 1));
      ta.focus();
      ta.setSelectionRange(pos, pos);
      if (!lh) measure();
      ta.scrollTop = Math.max(0, vis * lh - ta.clientHeight / 3);
      schedule();
    },
    /** The selected text, or the line the caret is on (folded lines included); line = its first real line number. */
    selectionOrLine() {
      const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      const vis = v.slice(0, s).split('\n').length - 1, line = realLines(foldInfo())[vis];
      if (e > s) return { text: expandFolds(v.slice(s, e), hidden), line };
      const { text } = lineRange();
      return { text: expandFolds(text, hidden), line };
    },
    fold: (line) => foldAt(visibleLine(line)), unfold: (line) => unfoldAt(visibleLine(line)), unfoldAll: () => { const n = unfoldAll(); syncLines(); return n; },
    openFind, closeFind, get folds() { return markersIn(ta.value).filter((m) => hidden.has(m.id)).length; }, get completionsShown() { return ac.open ? ac.items.map((x) => x.label) : []; },
    view: () => ({ top: ta.scrollTop, left: ta.scrollLeft, start: ta.selectionStart, end: ta.selectionEnd }),
    refresh() { lh = 0; schedule(); },
  };
  root.csEditor = eds; box.csEditor = eds;   // tests reach the editor through its element (browser-script-editor.mjs)
  return eds;
}
