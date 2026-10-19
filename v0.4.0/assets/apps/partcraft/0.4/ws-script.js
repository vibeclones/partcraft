/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ws-script.js — the Script workspace (docs/SCRIPTING-SPEC.md §5; map in docs/apps/craftscript.md, "Script workspace").
 * CraftScript and Lua scripts run in a Web Worker (cs-client.js → the worker modules in WORKER_MODULES); everything a
 * run leaves in the workspace stays for the next run. The right panel holds the editor (cs-editor.js), the console with
 * a one-line REPL, the Variables list and the Library (craftlib/index.json); the 3D view shows what scripts display
 * (meshes, fields coloured with a legend and range, deformed shapes, models) with a "Shown" list, and the sub-display
 * dock along its bottom edge (cs-dock.js) holds plots, tables, heat maps and picked values.
 * Scripts are saved in the part (part.studies.script, cs-ui.js readScriptStudy: untrusted, size-capped, never run on open).
 * Top level is DOM-free (Node imports it); the page is touched only inside the hooks, through `host`.
 */
import { registerWorkspace } from './workspaces.js';
import { registerStudyReader } from './part.js';
import { createEngine } from './cs-client.js';
import { createEditor, DEFAULT_GRAMMARS } from './cs-editor.js';
import { createDock } from './cs-dock.js';
import * as C from './cs-ui.js';
import { typeOf, valueText, isTensor, fmtNum } from './cs-values.js';
import { colorsFor, gradientCss, sig } from './sim-ui.js';
import { t } from './i18n.js';

/** The worker's modules: builder A's cs-worker.js (the whole runtime through cs-all.js). */
export const WORKER_MODULES = ['cs-worker.js'];
const KEY = C.SCRIPT_KEY;
registerStudyReader(KEY, (raw) => C.readScriptStudy(raw));

// labels are functions: never t() at load (Node tests import this module before the language catalog)
const BUDGETS = [[2e8, () => t('script.ws.budget.m200')], [2e9, () => t('script.ws.budget.b2')], [2e10, () => t('script.ws.budget.b20')], [2e11, () => t('script.ws.budget.b200')]];
const CONSOLE_MAX = 4000;
const S = {
  tabs: [], active: 0, seq: 0, studyJson: null, partRef: null,
  engine: null, busy: false, runSeq: 0, runStart: 0, timer: 0,
  vars: [], varSel: null, shown: [], shownSeq: 0, partShown: true,
  info: null, panel: 'editor', lib: { state: 'idle', groups: [], sel: null, doc: '', text: '' },
  ui: null, host: null, flushTimer: 0, pending: { prints: [], displays: [], raf: 0 }, history: [], histPos: 0,
  budget: 2e9, savedVars: null, varsOffered: false,
};
const tabOf = () => S.tabs[S.active] || null;
const partTabs = () => S.tabs.filter((tab) => !tab.lib);

// ---------------------------------------------------------------- the study (scripts saved in the part)

function studyValue() {
  const pts = partTabs();
  const empty = pts.length <= 1 && !(pts[0] && pts[0].text.trim()) && !S.savedVars;
  if (empty && !(pts[0] && pts[0].touched)) return null;
  const st = { v: 1, scripts: pts.map((tab) => ({ name: tab.name, lang: tab.lang, text: tab.text })), active: Math.max(0, pts.indexOf(tabOf())), keepVars: !!S.keepVars };
  if (S.keepVars && S.savedVars) st.vars = S.savedVars;
  return st;
}
const studyKey = (st) => JSON.stringify(st ? { s: st.scripts, k: !!st.keepVars, v: st.vars ? Object.keys(st.vars).sort() : null } : null);

/** Write the editor's scripts into the part (one undo step) when they differ from what it holds. */
function flush(host, label = t('script.ws.undo.edit')) {
  if (S.flushTimer) { clearTimeout(S.flushTimer); S.flushTimer = 0; }
  if (!host) return;
  const raw = studyValue(), want = raw ? C.readScriptStudy(raw) : null, have = host.study(KEY);
  if (JSON.stringify(want) === JSON.stringify(have ?? null)) return;
  keepingFocus(() => host.setStudy(KEY, want, label));
  S.studyJson = studyKey(host.study(KEY));
}
/** Re-render the page (renderAll, setStudy) without losing the place in the editor or the REPL line: those nodes persist. */
function keepingFocus(fn) {
  const root = S.ui && S.ui.root, doc = root && root.ownerDocument, a = doc && doc.activeElement;
  const mine = a && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') ? a : null;
  const sel = mine ? { s: mine.selectionStart, e: mine.selectionEnd, top: mine.scrollTop, left: mine.scrollLeft } : null;
  try { return fn(); } finally {
    if (mine && mine.isConnected && mine.ownerDocument.activeElement !== mine) {
      mine.focus({ preventScroll: true });
      try { mine.setSelectionRange(sel.s, sel.e); } catch { /* fine */ }
      mine.scrollTop = sel.top; mine.scrollLeft = sel.left;
    }
  }
}
function flushSoon(host, ms = 2500) {
  if (S.flushTimer) clearTimeout(S.flushTimer);
  S.flushTimer = setTimeout(() => { S.flushTimer = 0; flush(host); }, ms);
}

/** Tabs from the part's study when it changed under us (open, undo, redo, new part). */
function syncFromPart(host) {
  const st = host.study(KEY) || null, k = studyKey(st), partChanged = host.part !== S.partRef;
  S.partRef = host.part;
  if (k === S.studyJson && S.tabs.length) return;
  const mine = studyKey(studyValue());
  if (k === mine && S.tabs.length) { S.studyJson = k; return; }
  const libTabs = S.tabs.filter((tab) => tab.lib);
  const pts = (st ? st.scripts : []).map((s) => newTab(s.name, s.lang, s.text));
  if (!pts.length) pts.push(newTab('script1', 'craft', ''));
  S.tabs = [...pts, ...libTabs];
  S.active = Math.min(st ? st.active : 0, pts.length - 1);
  S.keepVars = !!(st && st.keepVars);
  S.savedVars = st && st.vars ? st.vars : null;
  S.varsOffered = false;
  S.studyJson = k;
  if (S.ui) loadTab();
  if (partChanged && st && st.scripts.length && S.ui) {
    say('note', t('script.ws.part_scripts', { n: st.scripts.length }));
  }
}
const newTab = (name, lang, text, extra = {}) => ({ id: ++S.seq, name, lang: lang === 'lua' || lang === 'python' ? lang : 'craft', text: text || '', view: null, err: 0, ...extra });

// ---------------------------------------------------------------- engine, running

function engine(host) {
  if (!S.engine) {
    S.engine = createEngine({
      makeWorker: () => host.computeWorker(WORKER_MODULES, { name: 'PartCraft scripts' }),
      onPrint: (text) => { S.pending.prints.push(text); pump(host); },
      onDisplay: (d) => { S.pending.displays.push(d); pump(host); },
      onFile: (f) => savedByScript(host, f),
    });
  }
  return S.engine;
}
/** Prints and display commands arrive fast (every loop pass): apply them once per frame. */
function pump(host) {
  if (S.pending.raf) return;
  S.pending.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => drain(host)) : setTimeout(() => drain(host), 16);
}
/** Apply what the worker sent so far (also right after a run ends, so "Done" comes after the last print). */
function drain(host) {
  {
    if (S.pending.raf) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.pending.raf); clearTimeout(S.pending.raf); }
    S.pending.raf = 0;
    const prints = S.pending.prints.splice(0), disp = S.pending.displays.splice(0);
    // prints arrive as the script wrote them (lines end with \n): one console row per batch
    if (prints.length) say('out', prints.join('').replace(/\n$/, ''));
    // only the newest of each plot/table/image key matters
    const seen = new Set(), keep = [];
    for (let i = disp.length - 1; i >= 0; i--) { const d = disp[i], k = dispKey(d); if (k && seen.has(k)) continue; if (k) seen.add(k); keep.unshift(d); }
    for (const d of keep) display(host, d);
  }
}
const dispKey = (d) => (d && d.plot ? (optsOf(d, 'plot').append ? '' : keyOf(d, 'plot')) : d && d.table !== undefined ? keyOf(d, 'table') : d && d.image ? keyOf(d, 'image') : '');
const optsOf = (d, kind) => ({ ...(d[kind] && typeof d[kind] === 'object' && !isTensor(d[kind]) && d[kind].opts && typeof d[kind].opts === 'object' ? d[kind].opts : {}), ...(d.opts && typeof d.opts === 'object' ? d.opts : {}) });
/** A plot, table or image is replaced by the next one with the same id (option 'id'), else the same title. */
const titleOf = (d, kind) => { const o = optsOf(d, kind); return String(o.title || o.name || (d[kind] && typeof d[kind] === 'object' && !isTensor(d[kind]) && d[kind].title) || '').slice(0, 80); };
const keyOf = (d, kind) => { const o = optsOf(d, kind); return kind + ':' + String(o.id || titleOf(d, kind)).slice(0, 80); };

async function info(host) {
  if (S.info) return S.info;
  // a failed call (the worker stopped or still starting) is not kept: the next run asks again
  try { S.info = await engine(host).info(); } catch { return { languages: [], builtins: [] }; }
  // a language the runtime does not have yet stays in the list, marked and off
  if (S.ui && S.info.languages && S.info.languages.length) for (const o of S.ui.lang.options) {
    const there = S.info.languages.some((l) => l.id === o.value);
    o.disabled = !there;
    o.textContent = there ? C.langName(o.value) : t('script.ws.lang_unavailable', { name: C.langName(o.value) });
  }
  applyGrammar();
  return S.info;
}
function applyGrammar() {
  const tab = tabOf();
  if (!S.ui || !tab) return;
  const L = S.info && S.info.languages ? S.info.languages.find((l) => l.id === tab.lang) : null;
  S.ui.editor.setGrammar((L && L.highlight) || DEFAULT_GRAMMARS[tab.lang] || DEFAULT_GRAMMARS.craft, S.info ? (S.info.builtins || []).map((b) => b.name) : [], { lang: tab.lang, docs: S.info ? S.info.builtins || [] : [] });
}

async function run(host, { selection = false, source = null, repl = false } = {}) {
  if (S.busy) { host.status(t('script.ws.busy')); return null; }
  const tab = tabOf();
  if (!tab && source === null) return null;
  if (!repl) { saveTabText(); flush(host, t('script.ws.undo.edit')); }
  let text, offset = 0;
  if (source !== null) text = source;
  else if (selection) { const s = S.ui.editor.selectionOrLine(); text = s.text; offset = s.line - 1; }
  else text = tab.text;
  if (!text.trim()) { host.status(selection ? t('script.ws.select_lines') : t('script.ws.empty')); return null; }
  const lang = tab ? tab.lang : 'craft', file = tab ? tab.name : '';
  const id = ++S.runSeq;
  S.busy = true; S.runStart = Date.now();
  if (!repl && S.ui) { S.ui.editor.markError(0); tab.err = 0; }
  const from = offset + 1, to = offset + text.split('\n').length, lib = !!(tab && tab.lib);
  say('cmd', repl ? `>> ${text}` : selection ? (lib ? t('script.ws.run.lines_lib', { file, from, to }) : t('script.ws.run.lines', { file, from, to })) : lib ? t('script.ws.run.file_lib', { file }) : t('script.ws.run.file', { file }));
  host.status(repl ? t('script.ws.running') : t('script.ws.running_file', { file }), true);
  tick(host);
  updateBar(host);
  updateToolbar(host);
  try {
    const eng = engine(host);
    if (!S.info) await info(host);
    const r = await eng.run(text, { lang, file, budget: S.budget, files: partTabs().map((x) => ({ name: x.name, lang: x.lang, text: x.text })), libBase: libUrl(''), part: /\b(part|bodies)\b/.test(text) ? partModel(host) : undefined });
    if (id !== S.runSeq) return null;
    drain(host);
    S.vars = r.list || S.vars;
    const secs = ((Date.now() - S.runStart) / 1000).toFixed(r.ms !== null && r.ms < 1000 ? 2 : 1);
    if (r.ok) { say('ok', t('script.ws.done', { secs })); host.status(repl ? t('script.ws.ran_line', { secs }) : t('script.ws.ran_file', { file, secs })); }
    else {
      const line = r.error.line ? r.error.line + (repl ? 0 : offset) : 0;
      if (!repl && line && tab && (!r.error.file || r.error.file === file)) { tab.err = line; S.ui.editor.markError(line); }
      say(r.stopped ? 'stop' : 'err', r.error.message, !repl && line ? { line, col: r.error.col, tab: tab.id } : null, r.error.stack);
      host.status(r.stopped ? r.error.message : line ? t('script.ws.named_err_line', { name: file || t('script.ws.script'), why: r.error.message, line }) : t('script.ws.named_err', { name: file || t('script.ws.script'), why: r.error.message }), true);
    }
    if (S.keepVars) await keepVarsNow(host);
    return r;
  } catch (e) {
    if (id !== S.runSeq) return null;
    const msg = e && e.message ? e.message : String(e);
    const stopped = msg === t('script.rt.stopped') || msg === 'Stopped.';   // i18n-ignore: also the English text of an older worker
    say(stopped ? 'stop' : 'err', stopped ? t('script.rt.stopped') : t('script.ws.runner_failed', { why: msg }));
    host.status(stopped ? t('script.rt.stopped') : t('script.ws.named_err', { name: t('script.ws.script'), why: msg }), true);
    return null;
  } finally {
    if (id === S.runSeq) { S.busy = false; clearInterval(S.timer); S.timer = 0; updateBar(host); renderVars(host); updateToolbar(host); }
  }
}
function stop(host, { quiet = false } = {}) {
  if (!S.busy) return;
  S.runSeq++;
  S.engine && S.engine.stop();
  S.busy = false; clearInterval(S.timer); S.timer = 0;
  const lost = S.engine ? S.engine.lost : [];
  say('stop', lost.length ? t('script.ws.stopped_lost', { names: lost.join(', ') }) : t('script.ws.stopped_kept'));
  host.status(t('script.rt.stopped'));
  updateBar(host);
  if (!quiet) updateToolbar(host);
}
function tick(host) {
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (S.ui && S.busy) S.ui.runState.textContent = t('script.ws.running_secs', { secs: ((Date.now() - S.runStart) / 1000).toFixed(0) }); }, 500);
}
/** The toolbar's Run / Stop follow S.busy (toolState); renderAll redraws it, keeping the editor's focus. */
const updateToolbar = (host) => { try { keepingFocus(() => host.renderAll()); } catch { /* host gone */ } };

/** The open part as a model value for the script's part() (its display mesh; only sent when the script names it). */
function partModel(host) {
  const m = host.regen && host.regen.mesh;
  if (!m || !m.positions || !m.indices) return null;
  return { t: 'model', source: 'part', ref: String(host.part.name || 'Part').slice(0, 120) /* i18n-ignore: a data reference */, mesh: { t: 'mesh', kind: 'tri', nodes: Float64Array.from(m.positions), elems: Int32Array.from(m.indices) } };
}
/** A script saved a file (save('x.csv', …)): the page downloads it. */
function savedByScript(host, f) {
  if (!f || typeof f.name !== 'string' || !f.bytes) return;
  const name = f.name.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'file';   // i18n-ignore: a file name
  host.downloadBlob(name, new Blob([f.bytes], { type: typeof f.mime === 'string' ? f.mime : 'application/octet-stream' }), typeof f.mime === 'string' ? f.mime : 'application/octet-stream');
  say('note', t('script.ws.saved_by_script', { name }));
}

async function keepVarsNow(host) {
  try {
    const snap = await engine(host).snapshot();
    const enc = C.encodeVars(snap);
    S.savedVars = enc.vars;
    if (enc.skipped.length) say('note', t('script.ws.not_saved', { list: enc.skipped.map((s) => `${s.name} (${s.why})`).join(', ') }));
    flush(host, t('script.ws.undo.save_vars'));
  } catch (e) { say('err', t('script.ws.vars_failed', { why: e.message || e })); }
}

// ---------------------------------------------------------------- display commands → canvas and dock

function display(host, d) {
  if (!d || typeof d !== 'object') return;
  try {
    if (d.clear) { S.shown = []; drawShown(host); S.ui && S.ui.dock.clear(); return; }
    if (d.show) { addShown(host, { kind: d.show, value: d.value, opts: d.opts || {} }); return; }
    if (d.plot) {
      const p = C.normalizePlot(d), o = optsOf(d, 'plot'), key = keyOf(d, 'plot');
      const prev = o.append ? S.ui.dock.items.find((x) => x.key === key) : null;
      // 'append': one more series on the plot with that id (several curves on one plot)
      if (prev) { const series = [...prev.data.series.filter((x) => !p.series[0].name || x.name !== p.series[0].name), ...p.series].slice(-16); S.ui.dock.add({ ...prev, data: { ...prev.data, series } }); return; }
      S.ui.dock.add({ kind: 'plot', title: titleOf(d, 'plot') || t('script.ws.title.plot'), data: p, key });
      return;
    }
    if (d.table !== undefined) { S.ui.dock.add({ kind: 'table', title: titleOf(d, 'table') || t('script.ws.title.table'), data: { value: d.table }, key: keyOf(d, 'table') }); return; }
    if (d.image) {
      if (!isTensor(d.image)) throw new Error(t('script.ws.image_array'));
      const o = optsOf(d, 'image');
      S.ui.dock.add({ kind: 'image', title: titleOf(d, 'image') || t('script.ws.title.image'), data: { t: d.image, colormap: o.colormap === 'gray' ? 'gray' : undefined, range: o.scaled === false ? [0, 1] : optList(o.range) }, key: keyOf(d, 'image') });
      return;
    }
    say('note', t('script.ws.display_skipped'));
  } catch (e) { say('err', t('script.ws.display_err', { why: e.message || e })); }
}

/** Option values from a script: numbers may come as 1×1 arrays, lists as arrays. */
const optNum = (v) => (typeof v === 'number' ? v : isTensor(v) && v.data.length === 1 ? v.data[0] : typeof v === 'boolean' ? +v : NaN);
const optList = (v) => (Array.isArray(v) ? v.map(Number) : isTensor(v) ? Array.from(v.data) : null);
async function addShown(host, { kind, value, opts: rawOpts, name }) {
  const opts = { ...(rawOpts || {}) };
  for (const k of ['scale']) if (opts[k] !== undefined) opts[k] = optNum(opts[k]);
  for (const k of ['reverse', 'edges', 'deformed']) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') opts[k] = !!optNum(opts[k]);
  if (opts.range !== undefined) opts.range = optList(opts.range);
  if (opts.component !== undefined) opts.component = String(opts.component).toLowerCase();
  const nm = String(name || opts.name || (value && value.name) || kind).slice(0, 60);
  const it = { id: ++S.shownSeq, name: nm, kind, value, opts, visible: true, comp: opts.component || null, range: null, scale: Number.isFinite(opts.scale) ? opts.scale : null, deform: null, surf: null, err: '' };
  try {
    if (kind === 'field') {
      if (!value || !value.data) throw new Error(t('script.ws.field_empty'));
      it.mesh = typeof value.mesh === 'string' ? await engine(host).get(value.mesh) : value.mesh;
      if (opts.deform) it.deform = typeof opts.deform === 'string' ? await engine(host).get(opts.deform) : opts.deform;
      if (it.deform && !(it.deform.data && it.deform.comps === 3 && it.deform.at !== 'elem')) throw new Error(t('script.ws.deform_field'));
      if (opts.deformed && !it.deform && value.comps === 3 && value.at !== 'elem') it.deform = value;
      if (Array.isArray(opts.range) && opts.range.length === 2) it.range = { lo: +opts.range[0], hi: +opts.range[1] };
    } else it.mesh = value;
    it.surf = C.surfaceOf(it.mesh);
    if (kind === 'field') {
      const n = value.at === 'elem' ? it.surf.elems : it.surf.nodes;
      if (value.data.length / (value.comps || 1) < n) { const got = Math.floor(value.data.length / (value.comps || 1)); throw new Error(value.at === 'elem' ? t('script.ws.field_short_elems', { got, n }) : t('script.ws.field_short_nodes', { got, n })); }
    }
  } catch (e) { say('err', t('script.ws.show_err', { name: nm, why: e.message || e })); return; }
  // a newer show of the same name replaces the old one
  S.shown = S.shown.filter((x) => x.name !== it.name);
  S.shown.push(it);
  if (S.shown.length > 16) S.shown.shift();
  if (it.kind === 'field' && it.deform && S.partShown) S.partShown = false;
  drawShown(host);
  if (S.shown.length === 1) fitShown(host);
}

/**
 * Fit the view to what is shown (scripts' items, and the part while it is visible), in the part of the view above the
 * dock. view3d.js fits to the part's box, so the box is lent for the call.
 */
function fitShown(host) {
  const v = host.view, T = host.THREE, box = new T.Box3();
  for (const [id, o] of v.overlays) if (id.startsWith('script-')) box.expandByObject(o);
  if (box.isEmpty()) { v.fit(); return; }
  if (S.partShown && v.mesh) box.union(v.box);
  const keep = v.box;
  try { v.box = box; v.fit(); } finally { v.box = keep; }
  const dock = S.ui && S.ui.dock.root, H = v.canvas.clientHeight;
  const dh = dock && !dock.hidden ? dock.offsetHeight : 0;
  if (H > 0 && dh > 0 && dh < H * 0.7) { v.zoomBy((H - dh) / H); v.panBy(0, -(dh / 2) / H); }
}

function drawShown(host) {
  const { view, THREE } = host;
  for (const id of [...view.overlays.keys()]) if (id.startsWith('script-')) view.setOverlay(id, null);
  for (const it of S.shown) if (it.visible && it.surf) view.setOverlay('script-' + it.id, objectFor(host, it));
  view.setPartVisible(S.partShown);
  renderShownBox(host);
  void THREE;
}
function objectFor(host, it) {
  const { THREE } = host, s = it.surf, grp = new THREE.Group();
  grp.userData.csShown = it.id;
  let pos = s.positions;
  if (it.deform) {
    if (it.scale === null) it.scale = C.autoScale(s.positions, it.deform.data, s.vertNode);
    pos = new Float32Array(s.positions.length);
    const u = it.deform.data;
    for (let v = 0; v < s.vertNode.length; v++) { const n = s.vertNode[v]; for (let c = 0; c < 3; c++) pos[3 * v + c] = s.positions[3 * v + c] + it.scale * u[3 * n + c]; }
  }
  const geo = new THREE.BufferGeometry();
  let mat;
  if (it.kind === 'field') {
    const f = C.fieldScalar(it.value, it.comp);
    it.compLabel = f.label;
    const auto = C.rangeOf(f.values);
    it.auto = auto;
    const r = it.range || auto;
    if (it.value.at === 'elem') {
      // flat colour per element: one vertex per triangle corner
      const nt = s.indices.length / 3, p = new Float32Array(nt * 9), vals = new Float32Array(nt * 3);
      for (let tri = 0; tri < nt; tri++) for (let k = 0; k < 3; k++) { const v = s.indices[3 * tri + k]; for (let c = 0; c < 3; c++) p[9 * tri + 3 * k + c] = pos[3 * v + c]; vals[3 * tri + k] = f.values[s.triElem[tri]]; }
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colorsFor(vals, r.lo, r.hi, !!it.opts.reverse), 3));
    } else {
      const vals = new Float32Array(s.vertNode.length);
      for (let v = 0; v < vals.length; v++) vals[v] = f.values[s.vertNode[v]];
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
      geo.setAttribute('color', new THREE.BufferAttribute(colorsFor(vals, r.lo, r.hi, !!it.opts.reverse), 3));
    }
    mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  } else {
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    mat = new THREE.MeshLambertMaterial({ color: it.kind === 'model' ? 0xb7c2cf : 0x9fb6cf, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.userData.csShown = it.id;
  grp.add(m);
  if (it.kind !== 'model' && s.lines.length && it.opts.edges !== false) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lg.setIndex(new THREE.BufferAttribute(s.lines, 1));
    const ls = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: it.kind === 'mesh' ? 0.6 : 0.3 }));
    ls.renderOrder = 12;
    grp.add(ls);
  }
  return grp;
}

/** The "Shown" box over the view: eye toggles, remove, and the legend of the top field. */
function renderShownBox(host) {
  if (!S.ui) return;
  const { el } = host, box = S.ui.shownBox;
  box.hidden = !S.shown.length;
  if (!S.shown.length) { box.replaceChildren(); return; }
  const eye = (on, label, fn, data) => el('button', { type: 'button', className: 'cs-eye', 'aria-pressed': String(on), title: on ? t('script.ws.eye.hide', { name: label }) : t('script.ws.eye.show', { name: label }), 'aria-label': on ? t('script.ws.eye.hide', { name: label }) : t('script.ws.eye.show', { name: label }), onclick: fn, dataset: data }, el('i', { className: 'bi bi-' + (on ? 'eye' : 'eye-slash'), 'aria-hidden': 'true' }));   // i18n-ignore: class names
  const list = el('ul', { className: 'cs-shown-list' },
    el('li', {}, eye(S.partShown, t('script.ws.the_part'), () => { S.partShown = !S.partShown; drawShown(host); }, { csPartEye: '1' }), el('span', { className: 'cs-shown-name' }, t('script.ws.part')), el('span', { className: 'cs-shown-kind' }, host.part ? host.part.name : '')),
    ...S.shown.map((it) => el('li', { dataset: { csShownItem: it.name } },
      eye(it.visible, it.name, () => { it.visible = !it.visible; drawShown(host); }, { csEye: it.name }),
      el('span', { className: 'cs-shown-name' }, it.name),
      el('span', { className: 'cs-shown-kind' }, it.deform ? t('script.ws.kind_deformed', { kind: it.kind }) : it.kind),
      el('button', { type: 'button', className: 'cs-x', title: t('script.ws.remove_from_view', { name: it.name }), 'aria-label': t('script.ws.remove_from_view', { name: it.name }), onclick: () => { S.shown = S.shown.filter((x) => x !== it); drawShown(host); } }, el('i', { className: 'bi bi-x', 'aria-hidden': 'true' })))));
  const fold = el('button', { type: 'button', className: 'cs-shown-h', 'aria-expanded': String(!S.shownFolded), title: S.shownFolded ? t('script.ws.shown.unfold') : t('script.ws.shown.fold'), dataset: { csShownFold: '1' }, onclick: () => { S.shownFolded = !S.shownFolded; renderShownBox(host); } },
    el('i', { className: 'bi bi-chevron-' + (S.shownFolded ? 'right' : 'down'), 'aria-hidden': 'true' }), ' ' + t('script.ws.shown'), S.shownFolded ? ` (${S.shown.length})` : '');   // i18n-ignore: class names
  if (S.shownFolded) { box.replaceChildren(fold); return; }
  const kids = [fold, list];
  const f = [...S.shown].reverse().find((x) => x.visible && x.kind === 'field');
  if (f && f.auto) {
    const r = f.range || f.auto;
    const bar = el('div', { className: 'pc-sim-bar', 'aria-hidden': 'true' });
    bar.style.setProperty('background', gradientCss(!!f.opts.reverse));
    const num = (v, set, label) => {
      const i = el('input', { type: 'number', className: 'pc-input cs-range-in', value: String(+v.toPrecision(6)), step: 'any', 'aria-label': label });
      i.addEventListener('change', () => { const x = Number(i.value); if (!Number.isFinite(x)) { i.value = String(+v.toPrecision(6)); return; } set(x); drawShown(host); });
      return i;
    };
    const comps = C.componentsOf(f.value);
    const unit = f.value.unit ? ` (${String(f.value.unit).slice(0, 20)})` : '';
    const leg = el('div', { className: 'cs-legend', dataset: { csLegend: f.name } },
      el('p', { className: 'cs-legend-h' }, `${f.value.name || f.name}${f.compLabel && comps.length > 1 ? ', ' + f.compLabel.toLowerCase() : ''}${unit}`),
      bar,
      el('div', { className: 'pc-sim-ticks' }, ...[0, 0.25, 0.5, 0.75, 1].map((k) => el('span', {}, sig(r.lo + k * (r.hi - r.lo))))),
      el('div', { className: 'cs-legend-row' },
        el('label', {}, t('script.ws.range.from') + ' ', num(r.lo, (x) => { f.range = { lo: x, hi: (f.range || f.auto).hi }; }, t('script.ws.range.from_aria'))),
        el('label', {}, t('script.ws.range.to') + ' ', num(r.hi, (x) => { f.range = { lo: (f.range || f.auto).lo, hi: x }; }, t('script.ws.range.to_aria'))),
        el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !f.range, onclick: () => { f.range = null; drawShown(host); }, title: t('script.ws.range.auto.title') }, t('script.ws.range.auto'))));
    if (comps.length > 1) {
      const sel = el('select', { className: 'pc-select pc-select-sm', 'aria-label': t('script.ws.component') }, ...comps.map(([k, l]) => el('option', { value: k, selected: k === (f.comp || comps[0][0]) }, l)));
      sel.addEventListener('change', () => { f.comp = sel.value; f.range = null; drawShown(host); });
      leg.append(el('div', { className: 'cs-legend-row' }, el('label', {}, t('script.ws.show') + ' ', sel)));
    }
    if (f.deform) leg.append(el('div', { className: 'cs-legend-row' }, el('label', {}, t('script.ws.deformed_x') + ' ', num(f.scale ?? 1, (x) => { f.scale = Math.max(0, x); }, t('script.ws.deform_scale'))), el('span', { className: 'cs-shown-kind' }, t('script.ws.deform_note'))));
    kids.push(leg);
  }
  box.replaceChildren(...kids);
}

/** A click on what scripts showed: the node or element under the pointer, in the dock. */
function pick(host, ev) {
  const objs = [];
  for (const [id, o] of host.view.overlays) if (id.startsWith('script-')) o.traverse((x) => { if (x.isMesh) objs.push(x); });
  if (!objs.length || !ev) return false;
  const h = host.view.ray(ev.clientX, ev.clientY).intersectObjects(objs, false)[0];
  if (!h) return false;
  const it = S.shown.find((x) => x.id === h.object.userData.csShown);
  if (!it) return false;
  const s = it.surf, elemField = it.kind === 'field' && it.value.at === 'elem';
  const tri = h.faceIndex, idx = elemField ? null : [0, 1, 2].map((k) => s.indices[3 * tri + k]);
  const triOf = elemField ? tri : tri;
  const elem = s.triElem[triOf];
  const rows = [[t('script.ws.pick.item'), `${it.name} (${it.kind})`], [t('script.ws.pick.point'), h.point.toArray().map((v) => fmtNum(+v.toFixed(4))).join(', ')]];
  let node = -1;
  if (idx) {
    const pos = h.object.geometry.attributes.position;
    let best = Infinity;
    for (const v of idx) { const d = Math.hypot(pos.getX(v) - h.point.x, pos.getY(v) - h.point.y, pos.getZ(v) - h.point.z); if (d < best) { best = d; node = s.vertNode[v]; } }
  } else {
    const v0 = s.indices[3 * tri];
    node = s.vertNode[v0];
  }
  if (s.kind !== 'tri' || it.kind !== 'model') rows.push([t('script.ws.pick.element'), String(elem + 1)]);
  if (node >= 0) rows.push([t('script.ws.pick.node'), String(node + 1)]);
  for (const f of S.shown.filter((x) => x.kind === 'field' && x.visible && x.mesh === it.mesh)) {
    const c = f.value.comps || 1, at = f.value.at === 'elem' ? elem : node;
    if (at < 0) continue;
    const vals = Array.from(f.value.data.subarray ? f.value.data.subarray(at * c, at * c + c) : f.value.data.slice(at * c, at * c + c), (x) => sig(x));
    rows.push([f.value.at === 'elem' ? t('script.ws.pick.at_element', { name: f.name }) : t('script.ws.pick.at_node', { name: f.name }), vals.join(', ') + (f.value.unit ? ' ' + f.value.unit : '')]);
  }
  S.ui.dock.add({ kind: 'picked', title: t('script.ws.pick.title'), data: { rows }, key: 'picked' });
  return true;
}

// ---------------------------------------------------------------- console

function say(kind, text, jump = null, stack = null) {
  if (!S.ui) return;
  const { el } = S.host, log = S.ui.log;
  const row = el('div', { className: 'cs-out cs-out-' + kind, dataset: { csOut: kind } });
  row.append(el('span', { className: 'cs-out-text' }, String(text)));
  if (jump) row.append(' ', el('button', { type: 'button', className: 'pc-linkbtn', dataset: { csJump: String(jump.line) }, onclick: () => jumpTo(jump) }, t('script.ws.line_n', { n: jump.line })));
  if (stack && stack.length) row.append(el('div', { className: 'cs-out-stack' }, stack.join('\n')));
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.append(row);
  while (log.childElementCount > CONSOLE_MAX) log.firstElementChild.remove();
  if (stick || kind !== 'out') log.scrollTop = log.scrollHeight;
}
function jumpTo({ line, col, tab }) {
  const i = S.tabs.findIndex((x) => x.id === tab);
  if (i >= 0 && i !== S.active) selectTab(i);
  showPane('editor');
  S.ui.editor.goTo(line, col || 1);
  S.ui.editor.markError(line);
}

// ---------------------------------------------------------------- tabs

function saveTabText() {
  const tab = tabOf();
  if (!tab || !S.ui) return;
  if (!tab.lib) tab.text = S.ui.editor.getText();
  tab.view = S.ui.editor.view();
}
function loadTab() {
  const tab = tabOf();
  if (!tab || !S.ui) return;
  S.ui.editor.setText(tab.text, { readOnly: !!tab.lib, view: tab.view });
  S.ui.editor.markError(tab.err || 0);
  S.ui.lang.value = tab.lang;
  S.ui.lang.disabled = !!tab.lib;
  applyGrammar();
  renderTabs();
  renderTabNote();
}
function selectTab(i) {
  if (i === S.active || !S.tabs[i]) return;
  saveTabText();
  S.active = i;
  loadTab();
  flush(S.host, t('script.ws.undo.switch'));
}
function addTab(host, name, lang, text, extra = {}) {
  saveTabText();
  const nm = extra.lib ? name : C.uniqueName(C.cleanName(name), S.tabs.filter((tab) => !tab.lib).map((tab) => tab.name));
  const tab = newTab(nm, lang, text, { touched: true, ...extra });
  S.tabs.push(tab);
  S.active = S.tabs.length - 1;
  loadTab();
  if (!extra.lib) flush(host, t('script.ws.undo.add'));
  return tab;
}
async function closeTab(host, i) {
  const tab = S.tabs[i];
  if (!tab) return;
  if (!tab.lib && tab.text.trim() && !(await host.confirm(t('script.ws.undo.remove'), t('script.ws.remove_confirm', { name: tab.name }), t('script.ws.remove')))) return;
  saveTabText();
  S.tabs.splice(i, 1);
  if (!S.tabs.some((x) => !x.lib)) S.tabs.unshift(newTab(C.uniqueName('script1', []), 'craft', ''));
  S.active = Math.max(0, Math.min(S.active >= i ? S.active - 1 : S.active, S.tabs.length - 1));
  loadTab();
  if (!tab.lib) flush(host, t('script.ws.undo.remove'));
}
function renameTab(host, i) {
  const tab = S.tabs[i];
  if (!tab || tab.lib || !S.ui) return;
  const { el } = host;
  const btn = S.ui.tabs.children[i];
  const input = el('input', { type: 'text', className: 'pc-input cs-tab-rename', value: tab.name, 'aria-label': t('script.ws.script_name'), maxLength: C.LIMITS.name });
  const done = (save) => {
    if (save) {
      const nm = C.uniqueName(C.cleanName(input.value, tab.name), S.tabs.filter((x) => x !== tab && !x.lib).map((x) => x.name));
      if (nm !== tab.name) { tab.name = nm; flush(host, t('script.ws.undo.rename')); }
    }
    renderTabs(); renderTabNote();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } e.stopPropagation(); });
  input.addEventListener('blur', () => done(true), { once: true });
  btn.replaceWith(input);
  input.focus(); input.select();
}
function renderTabs() {
  if (!S.ui) return;
  const { el } = S.host;
  S.ui.tabs.replaceChildren(...S.tabs.map((tab, i) => el('div', { className: 'cs-tab' + (i === S.active ? ' is-active' : '') + (tab.lib ? ' is-lib' : ''), dataset: { csTab: tab.name } },
    el('button', { type: 'button', className: 'cs-tab-name', role: 'tab', 'aria-selected': String(i === S.active), title: tab.lib ? t('script.ws.tab.lib', { name: tab.name }) : t('script.ws.tab.title', { name: tab.name, lang: C.langName(tab.lang) }), onclick: () => selectTab(i), ondblclick: () => renameTab(S.host, i) },
      tab.lib ? el('i', { className: 'bi bi-book', 'aria-hidden': 'true' }) : null, tab.name + C.extOf(tab.lang)),
    el('button', { type: 'button', className: 'cs-x', title: tab.lib ? t('script.ws.tab.close', { name: tab.name }) : t('script.ws.tab.remove_title', { name: tab.name }), 'aria-label': tab.lib ? t('script.ws.tab.close', { name: tab.name }) : t('script.ws.tab.remove', { name: tab.name }), onclick: () => closeTab(S.host, i) }, el('i', { className: 'bi bi-x', 'aria-hidden': 'true' })))),
  el('button', { type: 'button', className: 'cs-tab-add', title: t('script.ws.tab.new_title'), 'aria-label': t('script.ws.tab.new'), dataset: { csNewTab: '1' }, onclick: () => newScript(S.host) }, el('i', { className: 'bi bi-plus-lg', 'aria-hidden': 'true' })));
}
function renderTabNote() {
  if (!S.ui) return;
  const { el } = S.host, tab = tabOf(), n = S.ui.tabNote;
  n.replaceChildren();
  n.hidden = true;
  if (!tab) return;
  if (tab.lib) {
    n.hidden = false;
    n.append(el('span', {}, t('script.ws.lib_note', { name: tab.name }) + ' '), el('button', { type: 'button', className: 'pc-linkbtn', dataset: { csCopy: tab.name }, onclick: () => makeCopy(S.host, tab.name, tab.text, tab.lang) }, t('script.ws.copy_to_edit')));
    return;
  }
  const libNames = new Set(S.lib.groups.flatMap((g) => g.items.map((x) => x.name)));
  if (libNames.has(tab.name)) { n.hidden = false; n.append(t('script.ws.shadows_lib', { name: tab.name })); }
}
function newScript(host) {
  const tab = addTab(host, 'script' + (partTabs().length + 1), tabOf() ? tabOf().lang : 'craft', '');
  showPane('editor');
  S.ui.editor.textarea.focus();
  host.status(t('script.ws.new_script', { name: tab.name }));
}
function makeCopy(host, name, text, lang) {
  const tab = addTab(host, name, lang, text);
  host.status(tab.name === name ? t('script.ws.copied', { name }) : t('script.ws.copied_as', { name, as: tab.name }));
}

// ---------------------------------------------------------------- variables

async function refreshVars(host) {
  if (!S.engine) { renderVars(host); return; }
  try { S.vars = await S.engine.list(); } catch { /* the worker is restarting */ }
  renderVars(host);
}
function renderVars(host) {
  if (!S.ui) return;
  const { el } = host;
  S.ui.varsTab.textContent = t('script.ws.pane.vars') + (S.vars.length ? ` (${S.vars.length})` : '');
  const box = S.ui.varsPane;
  const rows = S.vars.map((v) => el('tr', { className: v.name === S.varSel ? 'is-sel' : '', dataset: { csVar: v.name }, tabIndex: 0, title: t('script.ws.eye.show', { name: v.name }),
    onclick: () => { S.varSel = v.name; renderVars(host); showVar(host, v.name); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.varSel = v.name; renderVars(host); showVar(host, v.name); } } },
  el('th', { scope: 'row' }, v.name), el('td', {}, v.type), el('td', {}, C.sizeText(v.size)), el('td', { className: 'num' }, C.numText(v.min)), el('td', { className: 'num' }, C.numText(v.max))));
  const kids = [];
  if (!S.vars.length) kids.push(el('p', { className: 'pc-note' }, t('script.ws.no_vars')));
  else kids.push(el('div', { className: 'cs-table-wrap' }, el('table', { className: 'cs-table cs-vars', dataset: { csVars: '1' } }, el('thead', {}, el('tr', {}, ...[t('script.ws.col.name'), t('script.ws.col.type'), t('script.ws.col.size'), t('script.ws.col.min'), t('script.ws.col.max')].map((h) => el('th', { scope: 'col' }, h)))), el('tbody', {}, ...rows))));
  const sel = S.vars.find((v) => v.name === S.varSel);
  if (sel) {
    const isT = sel.type === 'tensor' && sel.size.length <= 2;
    kids.push(el('div', { className: 'pc-actions cs-var-acts' },
      el('span', { className: 'cs-var-h' }, sel.name),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', onclick: () => showVar(host, sel.name), dataset: { csVarShow: '1' } }, t('script.ws.show')),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', onclick: () => saveVars(host, [sel.name], 'json'), dataset: { csVarJson: '1' } }, t('script.ws.save_json')),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !isT, title: isT ? t('script.ws.csv.title') : t('script.ws.csv.why'), onclick: () => saveVars(host, [sel.name], 'csv'), dataset: { csVarCsv: '1' } }, t('script.ws.save_csv')),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', onclick: () => saveVars(host, [sel.name], 'h5'), dataset: { csVarH5: '1' } }, t('script.ws.save_h5')),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', onclick: () => deleteVar(host, sel.name), dataset: { csVarDelete: '1' } }, t('script.ws.delete'))));
  }
  const keep = el('input', { type: 'checkbox', checked: !!S.keepVars, dataset: { csKeepVars: '1' } });
  keep.addEventListener('change', async () => {
    S.keepVars = keep.checked;
    if (S.keepVars) await keepVarsNow(host); else { S.savedVars = null; flush(host, t('script.ws.undo.stop_saving_vars')); }
  });
  kids.push(el('div', { className: 'pc-actions' },
    el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !S.vars.length, onclick: () => saveVars(host, S.vars.map((v) => v.name), 'json'), dataset: { csSaveAll: '1' } }, t('script.ws.save_all_json')),
    el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !S.vars.length || S.busy, onclick: async () => { if (await host.confirm(t('script.ws.clear_vars.title'), t('script.ws.clear_vars.ask'), t('script.ws.clear'))) { await engine(host).clear(); S.varSel = null; await refreshVars(host); say('note', t('script.ws.clear_vars.done')); } }, dataset: { csClearVars: '1' } }, t('script.ws.clear_all'))));
  kids.push(el('label', { className: 'pc-check' }, keep, t('script.ws.keep_vars')));
  if (S.savedVars && !S.varsOffered) {
    const n = Object.keys(S.savedVars).length;
    kids.push(el('div', { className: 'pc-msg' }, el('p', {}, t('script.ws.saved_vars', { n }) + ' '),
      el('button', { type: 'button', className: 'pc-btn pc-btn-sm', dataset: { csLoadSaved: '1' }, onclick: async () => {
        const { vars, dropped } = C.decodeVars(S.savedVars);
        await engine(host).load(vars);
        S.varsOffered = true;
        say('note', dropped.length ? t('script.ws.loaded_vars_skipped', { n: Object.keys(vars).length, names: dropped.join(', ') }) : t('script.ws.loaded_vars', { n: Object.keys(vars).length }));
        await refreshVars(host);
      } }, t('script.ws.load_them'))));
  }
  box.replaceChildren(...kids);
}
async function showVar(host, name) {
  try {
    const v = await engine(host).get(name), ty = typeOf(v);
    if (ty === 'mesh' || ty === 'field' || ty === 'model') { addShown(host, { kind: ty, value: v, opts: {}, name }); host.status(t('script.ws.shown_in_view', { name })); return; }
    if (ty === 'tensor') {
      const [r, c] = v.shape;
      S.ui.dock.add({ kind: 'table', title: name, data: { value: v }, key: 'var:' + name });
      if (v.shape.length <= 3 && r > 1 && c > 1) S.ui.dock.add({ kind: 'image', title: t('script.ws.title.map', { name }), data: { t: v }, key: 'varimg:' + name });
      else if ((r === 1 || c === 1) && v.data.length > 1) S.ui.dock.add({ kind: 'plot', title: t('script.ws.title.var_plot', { name }), data: C.normalizePlot({ plot: { y: v, title: name } }), key: 'varplot:' + name });
      S.ui.dock.toggle(true);
      return;
    }
    S.ui.dock.add({ kind: 'value', title: name, data: { text: valueText(v) }, key: 'var:' + name });
    S.ui.dock.toggle(true);
  } catch (e) { host.status(t('script.ws.named_err', { name, why: e.message || e })); }
}
async function deleteVar(host, name) {
  try { await engine(host).del(name); } catch (e) { host.status(e.message || String(e)); return; }
  S.varSel = null;
  await refreshVars(host);
  say('note', t('script.ws.deleted', { name }));
}
async function saveVars(host, names, format) {
  try {
    const base = names.length === 1 ? names[0] : C.cleanName(host.part ? host.part.name : 'workspace', 'workspace') + '-workspace';   // i18n-ignore: a file name
    if (format === 'h5') {
      const r = await engine(host).saveFile(names, 'h5');
      host.downloadBlob(r.fileName || base + '.h5', new Blob([r.bytes], { type: r.mime || 'application/x-hdf5' }), r.mime || 'application/x-hdf5');
      host.status(t('script.ws.saved', { name: r.fileName || base + '.h5' }));
      return;
    }
    const vals = {};
    for (const n of names) vals[n] = await engine(host).get(n);
    if (format === 'csv') host.downloadBlob(base + '.csv', new Blob([C.tensorCsv(vals[names[0]])], { type: 'text/csv' }), 'text/csv');
    else host.downloadBlob(base + '.json', new Blob([C.valuesJson(vals)], { type: 'application/json' }), 'application/json');
    host.status(names.length === 1 ? t('script.ws.saved_as', { name: names[0], format: format.toUpperCase() }) : t('script.ws.saved_n_as', { n: names.length, format: format.toUpperCase() }));
  } catch (e) { host.status(t('script.ws.named_err', { name: format === 'h5' ? 'HDF5' : format.toUpperCase(), why: e.message || e }), true); }
}

// ---------------------------------------------------------------- library (craftlib/, builder D)

const libUrl = (f) => { try { return new URL('./craftlib/' + f, import.meta.url).href; } catch { return 'craftlib/' + f; } };
async function loadLibrary(host) {
  if (S.lib.state === 'loading' || S.lib.state === 'ok') return;
  S.lib.state = 'loading';
  try {
    const r = await fetch(libUrl('index.json'), { cache: 'no-cache' });
    if (r.status === 404) { S.lib.state = 'missing'; }
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);   // i18n-ignore: a protocol status code
    else { S.lib.groups = C.readLibraryIndex(await r.json()); S.lib.state = 'ok'; }
  } catch (e) { S.lib.state = 'error'; S.lib.error = e.message || String(e); }
  renderLib(host); renderTabNote();
}
async function libText(item) {
  const r = await fetch(libUrl(item.file), { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status === 404 ? t('script.ws.lib.not_there') : `HTTP ${r.status}`);   // i18n-ignore: HTTP status code
  const text = await r.text();
  if (text.length > C.LIMITS.text) throw new Error(t('script.ws.lib.too_long'));
  return text;
}
function renderLib(host) {
  if (!S.ui) return;
  const { el } = host, box = S.ui.libPane, L = S.lib;
  const kids = [];
  if (L.state === 'loading' || L.state === 'idle') kids.push(el('p', { className: 'pc-note' }, t('script.ws.lib.reading')));
  else if (L.state === 'missing' || (L.state === 'ok' && !L.groups.length)) kids.push(el('p', { className: 'pc-note', dataset: { csLibEmpty: '1' } }, t('script.ws.lib.empty')));
  else if (L.state === 'error') kids.push(el('div', { className: 'pc-msg is-error' }, el('p', {}, t('script.ws.lib.error', { why: L.error }))));
  else {
    for (const g of L.groups) {
      kids.push(el('p', { className: 'pc-props-sub' }, g.label));
      kids.push(el('div', { className: 'pc-list cs-lib-list', role: 'listbox', 'aria-label': g.label }, ...g.items.map((it) => el('button', { type: 'button', role: 'option', className: 'pc-node', 'aria-selected': String(L.sel === it), dataset: { csLib: it.name },
        onclick: async () => { L.sel = it; L.doc = ''; L.text = ''; renderLib(host); try { L.text = await libText(it); L.doc = C.headerDoc(L.text) || t('script.ws.lib.no_doc'); } catch (e) { L.doc = e.message; L.text = ''; } if (L.sel === it) renderLib(host); } },
      el('i', { className: 'bi bi-file-earmark-code', 'aria-hidden': 'true' }), el('span', { className: 'pc-node-name' }, it.name), el('span', { className: 'pc-node-flag' }, it.summary.slice(0, 60))))));
    }
    if (L.sel) {
      const it = L.sel;
      kids.push(el('div', { className: 'pc-block cs-lib-doc' }, el('p', { className: 'pc-props-sub' }, it.name), el('pre', { className: 'cs-doc', dataset: { csLibDoc: it.name } }, L.doc || t('script.ws.reading')),
        el('div', { className: 'pc-actions' },
          el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !L.text, dataset: { csLibOpen: it.name }, onclick: () => { const ex = S.tabs.findIndex((tab) => tab.lib && tab.name === it.name); if (ex >= 0) selectTab(ex); else addTab(host, it.name, C.langOfFile(it.file), L.text, { lib: { file: it.file } }); showPane('editor'); } }, t('script.ws.lib.open')),
          el('button', { type: 'button', className: 'pc-btn pc-btn-sm', disabled: !L.text, dataset: { csLibCopy: it.name }, onclick: () => { makeCopy(host, it.name, L.text, C.langOfFile(it.file)); showPane('editor'); } }, t('script.ws.lib.copy')))));
    }
  }
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- files

async function openFiles(host, files) {
  for (const f of [...files].slice(0, 20)) {
    const kind = C.fileKind(f.name);
    if (kind === 'script') {
      if (f.size > C.LIMITS.text) { say('err', t('script.ws.file.too_long', { name: f.name, max: C.LIMITS.text.toLocaleString('en-US') })); continue; }
      const text = (await f.text()).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      const tab = addTab(host, f.name, C.langOfFile(f.name), text);
      say('note', t('script.ws.file.opened', { name: f.name, as: tab.name + C.extOf(tab.lang) }));
      showPane('editor');
    } else if (kind === 'data') {
      if (f.size > 512 * 1048576) { say('err', t('script.ws.file.too_big', { name: f.name })); continue; }
      const name = C.varNameFromFile(f.name);
      say('cmd', t('script.ws.file.load', { name: f.name }));
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const r = await engine(host).loadFile(name, f.name, bytes);
        say('ok', !r.type ? t('script.ws.file.loaded', { name: f.name, as: r.name || name }) : r.size ? t('script.ws.file.loaded_type_size', { name: f.name, as: r.name || name, type: r.type, size: C.sizeText(r.size) }) : t('script.ws.file.loaded_type', { name: f.name, as: r.name || name, type: r.type }));
        await refreshVars(host);
      } catch (e) { say('err', t('script.ws.named_err', { name: f.name, why: e.message || e })); }
    } else if (kind === 'part') say('note', t('script.ws.file.is_part', { name: f.name }));
    else say('err', t('cs.file.unknown', { name: f.name }));
  }
}
function pickFiles(host) {
  const { el } = host;
  const input = el('input', { type: 'file', multiple: true, accept: '.craft,.lua,.py,.m,.stl,.obj,.csv,.json,.npy,.h5,.hdf5,.txt' });
  input.addEventListener('change', () => { if (input.files && input.files.length) openFiles(host, input.files); });
  input.click();
}
function saveScript(host) {
  saveTabText();
  const tab = tabOf();
  if (!tab) return;
  host.downloadBlob(tab.name + C.extOf(tab.lang), new Blob([tab.text], { type: 'text/plain' }), 'text/plain');
  host.status(t('script.ws.saved', { name: tab.name + C.extOf(tab.lang) }));
}

// ---------------------------------------------------------------- the panel

function showPane(which) {
  if (!S.ui) return;
  S.panel = which;
  for (const [k, b] of Object.entries(S.ui.paneTabs)) { const on = k === which; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; S.ui.panes[k].hidden = !on; }
  if (which === 'editor') S.ui.editor.refresh();
  if (which === 'lib' && S.host) loadLibrary(S.host);
}
function updateBar(host) {
  if (!S.ui) return;
  const tab = tabOf();
  S.ui.runBtn.disabled = S.busy;
  S.ui.selBtn.disabled = S.busy;
  S.ui.stopBtn.disabled = !S.busy;
  S.ui.replInput.disabled = false;
  if (!S.busy) S.ui.runState.textContent = S.info && S.info.stub ? t('script.ws.stub') : '';
  S.ui.root.classList.toggle('is-busy', S.busy);
  void tab; void host;
}

function buildUi(host) {
  const { el } = host;
  const editor = createEditor({
    el, label: t('script.ws.editor_label'),
    onRun: () => run(host),
    onRunSelection: () => run(host, { selection: true }),
    onFlush: () => { saveTabText(); flush(host); },
    onChange: (v) => { const tab = tabOf(); if (tab && !tab.lib) { tab.text = v; tab.touched = true; flushSoon(host); } },
    words: () => (S.vars || []).map((v) => v.name),   // autocomplete: the workspace's variables (0.4 P7)
  });
  editor.textarea.addEventListener('focusout', () => { setTimeout(() => { saveTabText(); flush(host); }, 0); });
  const lang = el('select', { className: 'pc-select pc-select-sm', 'aria-label': t('script.ws.language'), dataset: { csLang: '1' } }, ...C.LANGS.map(([id, name]) => el('option', { value: id }, name)));
  lang.addEventListener('change', () => { const tab = tabOf(); if (tab && !tab.lib) { tab.lang = lang.value; applyGrammar(); renderTabs(); flush(host, t('script.ws.undo.language')); } });
  const btn = (label, icon, title, fn, data) => el('button', { type: 'button', className: 'pc-btn pc-btn-sm', title, onclick: fn, dataset: data }, el('i', { className: 'bi bi-' + icon, 'aria-hidden': 'true' }), ' ', label);   // i18n-ignore: class names
  const runBtn = btn(t('script.ws.cmd.run'), 'play-fill', t('script.ws.cmd.run.title'), () => run(host), { csRun: '1' });
  const selBtn = btn(t('script.ws.cmd.sel'), 'play', t('script.ws.cmd.sel.title'), () => run(host, { selection: true }), { csRunSel: '1' });
  const stopBtn = btn(t('script.ws.cmd.stop'), 'stop-fill', t('script.ws.cmd.stop.title'), () => stop(host), { csStop: '1' });
  runBtn.classList.add('is-primary');
  const runState = el('span', { className: 'cs-run-state', role: 'status' });
  const tabs = el('div', { className: 'cs-tabs', role: 'tablist', 'aria-label': t('script.ws.scripts') });
  const tabNote = el('p', { className: 'pc-note cs-tab-note', hidden: true });
  const log = el('div', { className: 'cs-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('script.ws.console'), tabIndex: 0, dataset: { csConsole: '1' } });
  const replInput = el('input', { type: 'text', className: 'pc-input cs-repl-in', spellcheck: false, autocomplete: 'off', 'aria-label': t('script.ws.repl.aria'), placeholder: t('script.ws.repl.placeholder'), dataset: { csRepl: '1' } });
  replInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = replInput.value;
      if (!v.trim()) return;
      S.history.push(v); if (S.history.length > 200) S.history.shift(); S.histPos = S.history.length;
      replInput.value = '';
      run(host, { source: v, repl: true });
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!S.history.length) return;
      e.preventDefault();
      S.histPos = Math.max(0, Math.min(S.history.length, S.histPos + (e.key === 'ArrowUp' ? -1 : 1)));
      replInput.value = S.history[S.histPos] || '';
    }
  });
  const budget = el('select', { className: 'pc-select pc-select-sm', 'aria-label': t('script.ws.budget'), dataset: { csBudget: '1' } }, ...BUDGETS.map(([v, l]) => el('option', { value: String(v), selected: v === S.budget }, l())));
  budget.addEventListener('change', () => { S.budget = Number(budget.value); try { localStorage.setItem('partcraft.script', JSON.stringify({ budget: S.budget })); } catch { /* this visit keeps it */ } });
  const clearLog = el('button', { type: 'button', className: 'pc-btn pc-btn-sm', onclick: () => log.replaceChildren(), dataset: { csClearConsole: '1' } }, t('script.ws.clear'));
  const editorPane = el('div', { className: 'cs-pane', role: 'tabpanel', id: 'cs-pane-editor', 'aria-labelledby': 'cs-ptab-editor' },
    tabs,
    el('div', { className: 'cs-bar' }, lang, runBtn, selBtn, stopBtn, runState),
    tabNote,
    editor.root,
    el('div', { className: 'cs-con-head' }, el('h3', { className: 'cs-h' }, t('script.ws.console')), clearLog),
    log,
    el('div', { className: 'cs-repl' }, el('span', { className: 'cs-prompt', 'aria-hidden': 'true' }, '>>'), replInput),
    el('details', { className: 'cs-opts' }, el('summary', {}, t('script.ws.run_options')), el('label', { className: 'cs-opt' }, t('script.ws.stop_after') + ' ', budget),
      el('p', { className: 'pc-note' }, t('script.ws.run_options.note'))));
  const varsPane = el('div', { className: 'cs-pane', role: 'tabpanel', id: 'cs-pane-vars', 'aria-labelledby': 'cs-ptab-vars', hidden: true, dataset: { csVarsPane: '1' } });
  const libPane = el('div', { className: 'cs-pane', role: 'tabpanel', id: 'cs-pane-lib', 'aria-labelledby': 'cs-ptab-lib', hidden: true, dataset: { csLibPane: '1' } });
  const paneTab = (k, label) => el('button', { type: 'button', className: 'pc-tab', role: 'tab', id: 'cs-ptab-' + k, 'aria-controls': 'cs-pane-' + k, 'aria-selected': String(k === 'editor'), tabIndex: k === 'editor' ? 0 : -1, dataset: { csPane: k }, onclick: () => showPane(k) }, label);
  const paneTabs = { editor: paneTab('editor', t('script.ws.pane.editor')), vars: paneTab('vars', t('script.ws.pane.vars')), lib: paneTab('lib', t('script.ws.pane.lib')) };
  const tabList = el('div', { className: 'pc-tabs', role: 'tablist', 'aria-label': t('script.ws.panel') }, ...Object.values(paneTabs));
  tabList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const ks = Object.keys(paneTabs), i = (ks.indexOf(S.panel) + (e.key === 'ArrowRight' ? 1 : -1) + ks.length) % ks.length;
    showPane(ks[i]); paneTabs[ks[i]].focus();
  });
  const root = el('div', { className: 'cs-panel', dataset: { csPanel: '1' } }, tabList, editorPane, varsPane, libPane);
  // F5 anywhere in the panel runs (and never reloads the page); files dropped on the panel open here
  root.addEventListener('keydown', (e) => { if (e.key === 'F5') { e.preventDefault(); e.stopPropagation(); run(host); } });
  root.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  root.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); openFiles(host, e.dataTransfer.files); } });
  const dock = createDock({ el, download: (name, blob) => host.downloadBlob(name, blob, blob.type) });   // plot export (0.4 P9)
  const shownBox = el('div', { className: 'cs-shown', dataset: { csShown: '1' }, hidden: true });
  S.ui = { root, editor, lang, runBtn, selBtn, stopBtn, runState, tabs, tabNote, log, replInput, varsPane, libPane, varsTab: paneTabs.vars, paneTabs, panes: { editor: editorPane, vars: varsPane, lib: libPane }, dock, shownBox };
  try { const v = JSON.parse(localStorage.getItem('partcraft.script') || '{}'); if (BUDGETS.some(([b]) => b === v.budget)) { S.budget = v.budget; budget.value = String(v.budget); } } catch { /* defaults */ }
  say('note', t('script.ws.welcome'));
}

function renderPanel(host, box) {
  S.host = host;
  if (!S.ui) buildUi(host);
  syncFromPart(host);
  if (!S.ui.tabs.childElementCount) loadTab();
  const note = host.el('p', { className: 'pc-note', dataset: { csPreview: '' } }, t('script.ws.preview'));
  // the editor stays where it is when the panel re-renders (an auto-save every 2.5 s): moving it would lose the textarea's undo
  S.ui.root.dataset.wsKeep = 'script';
  if (S.ui.root.parentNode === box) box.insertBefore(note, S.ui.root); else box.append(note, S.ui.root);
  renderTabs(); renderTabNote(); renderVars(host); renderLib(host); updateBar(host);
  S.ui.editor.refresh();
  return t('script.ws.label');
}

// ---------------------------------------------------------------- stage: the dock and the "Shown" box, drops

let dropHandler = null, dropText = null;
function enterStage(host) {
  const stage = host.view.canvas.parentElement;
  if (!stage) return;
  stage.append(S.ui.shownBox, S.ui.dock.root);
  stage.classList.add('cs-stage');
  // script and data files dropped on the view load here; parts still open as parts (partcraft.js)
  dropHandler = (e) => {
    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    if (!files.length || files.every((f) => C.fileKind(f.name) === 'part')) return;
    e.preventDefault(); e.stopPropagation();
    for (let i = 0; i < 16; i++) stage.dispatchEvent(new Event('dragleave'));   // let partcraft.js hide its drop sign
    openFiles(host, files.filter((f) => C.fileKind(f.name) !== 'part'));
  };
  stage.addEventListener('drop', dropHandler, true);
  const sign = stage.querySelector('[data-drop] span');
  const tn = sign && [...sign.childNodes].reverse().find((n) => n.nodeType === 3 && n.data.trim());
  if (tn) { dropText = { tn, was: tn.data }; tn.data = ' ' + t('cs.drop.hint'); }
}
function exitStage(host) {
  const stage = host.view.canvas.parentElement;
  if (S.ui) { S.ui.shownBox.remove(); S.ui.dock.root.remove(); }
  if (stage) { stage.classList.remove('cs-stage'); if (dropHandler) stage.removeEventListener('drop', dropHandler, true); }
  dropHandler = null;
  if (dropText) { dropText.tn.data = dropText.was; dropText = null; }
}

// ---------------------------------------------------------------- registration

// Labels are getters (never t() at load: Node tests import this module before the language catalog). registerWorkspace
// copies them into its own record, so lazyLabels() puts the getters back on that record afterwards.
const CMD_LABELS = {
  'script-new': { get label() { return t('script.ws.cmd.new'); }, get title() { return t('script.ws.cmd.new.title'); } },
  'script-open': { get label() { return t('script.ws.cmd.open'); }, get title() { return t('cs.open.title'); } },
  'script-save': { get label() { return t('script.ws.cmd.save'); }, get title() { return t('script.ws.cmd.save.title'); } },
  'script-run': { get label() { return t('script.ws.cmd.run'); }, get title() { return t('script.ws.cmd.run.title'); } },
  'script-run-sel': { get label() { return t('script.ws.cmd.sel'); }, get title() { return t('script.ws.cmd.sel.title'); } },
  'script-stop': { get label() { return t('script.ws.cmd.stop'); }, get title() { return t('script.ws.cmd.stop.title'); } },
};
const WS_LABELS = { get label() { return t('script.ws.label'); }, get blurb() { return t('script.ws.blurb'); } };
const GROUP_LABEL = { get label() { return t('script.ws.label'); } };
const ICONS = { 'script-new': 'file-earmark-plus', 'script-open': 'folder2-open', 'script-save': 'download', 'script-run': 'play-fill', 'script-run-sel': 'play', 'script-stop': 'stop-fill' };
const getters = (o) => Object.getOwnPropertyDescriptors(o);
function lazyLabels(stored) {
  if (!stored || typeof stored !== 'object') return stored;
  Object.defineProperties(stored, getters(WS_LABELS));
  for (const g of stored.groups || []) {
    Object.defineProperties(g, getters(GROUP_LABEL));
    for (const it of g.items || []) if (CMD_LABELS[it.cmd]) Object.defineProperties(it, getters(CMD_LABELS[it.cmd]));
  }
  return stored;
}

lazyLabels(registerWorkspace({
  id: 'script',
  get label() { return t('script.ws.label'); },
  get blurb() { return t('script.ws.blurb'); },
  icon: 'code-square',
  groups: [Object.defineProperties({ items: Object.keys(CMD_LABELS).map((cmd) => Object.defineProperties({ cmd, icon: ICONS[cmd] }, getters(CMD_LABELS[cmd]))) }, getters(GROUP_LABEL))],
  enter(host) {
    S.host = host;
    if (!S.ui) buildUi(host);
    syncFromPart(host);
    enterStage(host);
    drawShown(host);
    loadLibrary(host);
    info(host).then(() => updateBar(host));
  },
  exit(host) {
    saveTabText();
    flush(host);
    if (S.busy) stop(host, { quiet: true });   // leaving stops a run (its variables before the run are kept)
    if (S.engine) S.engine.stop();
    exitStage(host);
  },
  command(cmd, host) {
    if (cmd === 'save') { saveTabText(); flush(host); return false; }   // then Design saves the part, scripts in it
    if (cmd === 'view-fit' && S.shown.some((x) => x.visible)) { fitShown(host); return true; }
    if (cmd === 'script-new') { newScript(host); return true; }
    if (cmd === 'script-open') { pickFiles(host); return true; }
    if (cmd === 'script-save') { saveScript(host); return true; }
    if (cmd === 'script-run') { run(host); return true; }
    if (cmd === 'script-run-sel') { run(host, { selection: true }); return true; }
    if (cmd === 'script-stop') { stop(host); return true; }
    return false;
  },
  renderPanel,
  onPick(hit, host, ev) {
    if (pick(host, ev)) return;
    if (hit && hit.kind === 'face' && S.ui) S.ui.dock.add({ kind: 'picked', title: t('script.ws.pick.title'), data: { rows: [[t('script.ws.part'), host.part.name], [t('script.ws.pick.point'), hit.point.map((v) => fmtNum(+v.toFixed(4))).join(', ')]] }, key: 'picked' });
  },
  onHover(hit, host) { host.view.setHover(null); },
  keydown(ev, host) {
    if (ev.key === 'F5') { run(host); return true; }
    if ((ev.key === 'f' || ev.key === 'F') && !ev.altKey && !ev.ctrlKey && !ev.metaKey && S.shown.some((x) => x.visible)) { fitShown(host); return true; }
    return false;
  },
  toolState(cmd) {
    if (cmd === 'script-stop') return S.busy ? { ok: true } : { ok: false, why: t('script.ws.why.idle') };
    if ((cmd === 'script-run' || cmd === 'script-run-sel') && S.busy) return { ok: false, why: t('script.ws.why.busy') };
    return { ok: true };
  },
  rebuilt(host) { drawShown(host); },
}));

export const _state = S;   // tests
