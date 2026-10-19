/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-runtime.js — the language-neutral CraftScript host (docs/SCRIPTING-SPEC.md §3, docs/apps/craftscript.md
 * "Runtime/adapter API"). DOM-free: runs in a Web Worker (cs-worker.js) and in Node (CLI, tests).
 *
 *   registerBuiltin(name, fn, { args, doc, module, provisional })   fn(argsArray, ctx) → value | value[] (several outputs);
 *                                                                   no doc → the language file's script.doc.<name> (docKey)
 *   registerMethod(type, name, fn, { provisional })                 the same, used when an argument is a value of `type`
 *                                                                   (e.g. 'sparse'); operators use MATLAB's names:
 *                                                                   plus minus times rdivide ldivide power mtimes mrdivide
 *                                                                   mldivide mpower eq ne lt le gt ge and or not uminus
 *                                                                   uplus transpose ctranspose subsref subsasgn horzcat vertcat
 *   registerLanguage({ id, name, ext: ['.craft'], load: async () => adapter })
 *     adapter.run(source, { ws, call, ctx }) → Promise<{ ok, error?: { message, line, col, file?, stack? }, vars }>
 *     adapter.highlight = { keywords: [...], comment: ['%', '%{', '%}'], string: ["'", '"'], number: true }
 *   createRuntime({ budget, onPrint, onDisplay, library, stopFlag }) → { run(source, { lang, file }), ws, call, builtins(),
 *     languages(), steps }
 *
 * Builtin ctx: { nargout, print(text), display(cmd), check(n = 1), call(name, args, nargout), invoke(func, args, nargout),
 * ws, library(name) }. A builtin that cannot do its job throws CsError (or any Error) with a plain message.
 * Results: a builtin returns one value, or a JS array of values when it has several outputs (values are never JS arrays).
 */
import { CsError, StopError, CALL, SHARED, typeOf, describe, summary, isTensor } from './cs-values.js';
import { t, has } from './i18n.js';

export { CsError, StopError };

const BUILTINS = new Map();          // name → { fn, args, doc, module, provisional }
const METHODS = new Map();           // type → Map(name → { fn, provisional })
const LANGS = new Map();             // id → { id, name, ext, load, adapter? }
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** The language-file key of a builtin's one-line help ("script.doc.zeros"). The builtin modules give no doc text of their own:
 * it is looked up when asked for (never at import: the worker gets its catalog after the modules load). */
export const docKey = (name) => 'script.doc.' + String(name).toLowerCase();
/** A builtin's help text: its own doc (text, or a function returning text) when it gave one, else the language file's. */
function docOf(b) {
  if (typeof b.doc0 === 'function') return String(b.doc0() ?? '');
  if (b.doc0) return String(b.doc0);
  const k = docKey(b.name);
  return has(k) ? t(k) : '';
}

export function registerBuiltin(name, fn, { args = '', doc = '', module = 'core', provisional = false } = {}) {
  if (!NAME.test(name) || typeof fn !== 'function') throw new Error(`registerBuiltin: "${name}" needs a valid name and a function.`);   // i18n-ignore: developer error (a module's registration)
  const old = BUILTINS.get(name);
  if (old) {
    if (provisional) return false;                       // a real one is there already: keep it
    if (!old.provisional) throw new Error(`registerBuiltin: "${name}" is already registered (module ${old.module}).`);   // i18n-ignore: developer error
  }
  BUILTINS.set(name, { name, fn, args, doc0: doc, get doc() { return docOf(this); }, module, provisional });
  return true;
}

export function registerMethod(type, name, fn, { provisional = false, module = 'core' } = {}) {
  if (!/^[a-z][a-z0-9]{0,20}$/.test(type) || !NAME.test(name) || typeof fn !== 'function') throw new Error(`registerMethod: bad type "${type}" or name "${name}".`);   // i18n-ignore: developer error
  if (!METHODS.has(type)) METHODS.set(type, new Map());
  const m = METHODS.get(type), old = m.get(name);
  if (old) {
    if (provisional) return false;
    if (!old.provisional) throw new Error(`registerMethod: ${type}.${name} is already registered (module ${old.module}).`);   // i18n-ignore: developer error
  }
  m.set(name, { fn, provisional, module });
  return true;
}

export function registerLanguage({ id, name, ext = [], load }) {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(id) || typeof load !== 'function') throw new Error(`registerLanguage: "${id}" needs an id and load().`);   // i18n-ignore: developer error
  if (LANGS.has(id)) throw new Error(`registerLanguage: "${id}" is already registered.`);   // i18n-ignore: developer error
  LANGS.set(id, { id, name: String(name || id), ext: ext.map(String), load, adapter: null });
}

export const hasBuiltin = (name) => BUILTINS.has(name);
export const getBuiltin = (name) => BUILTINS.get(name) || null;
export const builtinList = () => [...BUILTINS.values()].map((b) => ({ name: b.name, args: b.args, doc: b.doc, module: b.module, provisional: b.provisional }));
export const languageList = () => [...LANGS.values()].map(({ id, name, ext }) => ({ id, name, ext }));
/** The language whose extension matches a file name, or null. */
export const languageForFile = (file) => { const f = String(file).toLowerCase(); for (const l of LANGS.values()) if (l.ext.some((e) => f.endsWith(e))) return l.id; return null; };
export async function loadLanguage(id) {
  const l = LANGS.get(id);
  if (!l) throw new CsError(t('script.rt.no_language', { id, list: [...LANGS.keys()].join(', ') }));
  if (!l.adapter) l.adapter = await l.load();
  return l.adapter;
}

/** The method for (value type, name) if any argument is of a type that has one. */
export function methodFor(name, args) {
  for (const a of args) {
    if (a && typeof a === 'object' && typeof a.t === 'string' && a.t !== 'tensor') {
      const m = METHODS.get(a.t)?.get(name);
      if (m) return m.fn;
    }
  }
  return null;
}
export const hasMethod = (type, name) => !!METHODS.get(type)?.has(name);

/** Mark the tensors reachable from a value as shared (a language must copy before writing into them). */
export function markShared(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (v.t === 'tensor') { v[SHARED] = true; return v; }
  if (v.t === 'struct') for (const x of Object.values(v.fields)) markShared(x, depth + 1);
  else if (v.t === 'cell') for (const x of v.items) markShared(x, depth + 1);
  else if (!v.t) for (const x of Object.values(v)) markShared(x, depth + 1);
  return v;
}

/** The workspace: named values that persist between runs (any language). */
export function createWorkspace(init) {
  const map = new Map(init instanceof Map ? init : Object.entries(init || {}));
  for (const v of map.values()) markShared(v);
  return {
    map,
    get: (name) => map.get(name),
    set(name, v) {
      if (!NAME.test(name)) throw new CsError(t('script.rt.bad_var', { name: String(name).slice(0, 40) }));
      if (v === undefined) { map.delete(name); return; }
      map.set(name, v);
    },
    has: (name) => map.has(name),
    delete: (name) => map.delete(name),
    clear: () => map.clear(),
    names: () => [...map.keys()],
    /** [{ name, type, size, bytes, min?, max? }] for the Variables panel. */
    list: () => [...map].map(([name, v]) => ({ name, ...summary(v) })),
  };
}

const plural = (n) => n.toLocaleString('en-US');

/**
 * A runtime: one workspace, one budget, print/display sinks.
 *   budget    instruction budget per run (default 2e9 steps)
 *   onPrint(text)   text without a trailing newline handling: each call is what the script printed (may contain \n)
 *   onDisplay(cmd)  { show, value, opts } | { plot } | { table } | { image } | { clear }
 *   library(name) → Promise<{ source, file, lang? } | null>   finds craftlib/ (or user) functions by name
 *   prepare(source, { lang, file }) → Promise   runs before each run (cs-all.js: cs-lib-io.js prepareIo)
 *   stopFlag  optional Int32Array (on a SharedArrayBuffer): a non-zero [0] stops the run at the next check
 */
export function createRuntime({ budget = 2e9, onPrint = () => {}, onDisplay = () => {}, library = null, stopFlag = null, workspace = null, prepare = null } = {}) {
  const ws = workspace && workspace.map ? workspace : createWorkspace(workspace);
  const rt = { ws, steps: 0, budget, running: false };
  const check = (n = 1) => {
    rt.steps += n;
    if (rt.steps > rt.budget) throw new StopError(t('script.rt.budget', { n: plural(rt.budget) }));
    if (stopFlag && Atomics.load(stopFlag, 0)) throw new StopError(t('script.rt.stopped'));
  };
  const print = (text) => onPrint(String(text));
  const display = (cmd) => { if (!cmd || typeof cmd !== 'object') throw new CsError(t('script.rt.display_arg')); markShared(cmd); onDisplay(cmd); };
  const libCache = new Map();
  const lib = async (name) => {
    if (!library || !NAME.test(name)) return null;
    if (!libCache.has(name)) libCache.set(name, Promise.resolve(library(name)).catch(() => null));
    return libCache.get(name);
  };
  const invoke = (f, args, nargout = 1) => {
    if (typeOf(f) === 'string') return call(f, args, nargout);
    if (typeOf(f) !== 'func') throw new CsError(t('script.rt.not_handle', { got: describe(f) }));
    if (typeof f[CALL] !== 'function') {
      if (BUILTINS.has(f.name)) return call(f.name, args, nargout);
      throw new CsError(t('script.rt.stale_handle', { name: f.name }));
    }
    const out = f[CALL](args, nargout);
    return nargout > 1 ? out : out[0];
  };
  function call(name, args = [], nargout = 1) {
    const m = methodFor(name, args);
    const b = m ? null : BUILTINS.get(name);
    if (!m && !b) throw new CsError(t('script.rt.no_function', { name }));
    const ctx = { nargout, print, display, check, call, invoke, ws, library: lib, runtime: rt };
    const r = (m || b.fn)(args, ctx);
    if (nargout > 1) return Array.isArray(r) ? r : [r];
    return Array.isArray(r) ? r[0] : r;
  }
  rt.call = call;
  rt.invoke = invoke;
  rt.check = check;
  rt.builtins = builtinList;
  rt.languages = languageList;
  rt.ctx = { print, display, check, call, invoke, ws, library: lib, runtime: rt, nargout: 1 };
  /** Run a script; resolves { ok, error?, vars, steps, ms } — never rejects for script errors. */
  rt.run = async (source, { lang = null, file = null } = {}) => {
    const id = lang || (file && languageForFile(file)) || 'craft';
    const t0 = Date.now();
    rt.steps = 0;
    if (stopFlag) Atomics.store(stopFlag, 0, 0);
    rt.running = true;
    try {
      const adapter = await loadLanguage(id);
      if (prepare) await prepare(String(source), { lang: id, file });   // e.g. cs-lib-io.js prepareIo (HDF5 preload)
      const r = await adapter.run(String(source), { ws, call, ctx: { ...rt.ctx, file, lang: id } });
      return { ok: !!r.ok, ...(r.error ? { error: r.error } : {}), vars: r.vars || [], steps: rt.steps, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: { message: e && e.message ? e.message : String(e), line: e?.line ?? null, col: e?.col ?? null, file, stopped: e instanceof StopError }, vars: [], steps: rt.steps, ms: Date.now() - t0 };
    } finally { rt.running = false; }
  };
  return rt;
}

/** For tests and docs: is this value something a builtin may receive? */
export const isValue = (v) => ['number', 'bool', 'string'].includes(typeOf(v)) || (v && typeof v === 'object' && typeof v.t === 'string');
export { isTensor };
