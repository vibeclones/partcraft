/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-lang-craft.js — the CraftScript language adapter (registers language 'craft', files .craft and .m). DOM-free.
 * Parse (cs-parse.js) → compile (cs-compile.js) → run on the VM (cs-vm.js) against the runtime's workspace.
 * Library functions (craftlib/ or the part's own scripts, through ctx.library) are found by name before the run starts,
 * transitively, so a run never waits on a fetch half way. Exports `adapter` for tests and `check(source)` for the editor.
 */
import { registerLanguage } from './cs-runtime.js';
import { CsError, StopError } from './cs-values.js';
import { parse } from './cs-parse.js';
import { compileProgram } from './cs-compile.js';
import { VM } from './cs-vm.js';
import { KEYWORDS } from './cs-lex.js';
import { t } from './i18n.js';

const libCache = new Map();   // file + '\0' + source → compiled { functions }

function compileLibrary(source, file) {
  const key = file + '\0' + source;
  let c = libCache.get(key);
  if (!c) {
    c = compileProgram(parse(source, file), { kind: 'library', name: file });
    if (libCache.size > 200) libCache.clear();
    libCache.set(key, c);
  }
  return c;
}

export function errorInfo(e, fallbackFile = null) {
  const stack = (e.csStack || []).filter((f) => f.name).map((f) => ({ name: f.name, line: f.line, col: f.col, file: f.file || null }));
  return {
    message: e && e.message ? e.message : String(e),
    line: e.line ?? null,
    col: e.col ?? null,
    file: e.file ?? fallbackFile,
    ...(stack.length ? { stack } : {}),
    ...(e instanceof StopError ? { stopped: true } : {}),
    ...(e.internal ? { internal: true } : {}),
  };
}

/**
 * Load library functions into a VM by name, transitively (each one's own calls too), before a run — so a run never waits on
 * a fetch half way. names: the names asked for; skip(name): already known (a local function, a builtin…); library(name) →
 * Promise<{ source, file, lang? } | null> (ctx.library). Names nobody has are left (the run reports them where they are called).
 * → the names it loaded. Also used by the Lua adapter (0.4 P8: Lua scripts call craftlib/ functions).
 */
export async function loadLibrary(vm, names, library, skip = () => false) {
  const pending = [...names], tried = new Set(), loaded = [];
  while (pending.length) {
    const name = pending.pop();
    if (tried.has(name) || skip(name) || vm.lib.has(name)) continue;
    tried.add(name);
    const found = library ? await library(name) : null;
    if (!found || typeof found.source !== 'string' || (found.lang && found.lang !== 'craft')) continue;
    const lib = compileLibrary(found.source, found.file || name + '.craft');
    if (!lib.functions.has(name)) throw new CsError(t('script.craft.lib_missing_fn', { file: found.file || name, name }), { file: found.file || null, line: 1, col: 1 });
    vm.addFunctions(new Map([[name, lib.functions.get(name)]]), lib.functions);
    loaded.push(name);
    for (const u of lib.functions.values()) for (const r of u.refs) pending.push(r);
  }
  return loaded;
}

/** Syntax-check a script (no run): { ok, error? }. */
export function check(source, file = null) {
  try { compileProgram(parse(String(source), file), { kind: 'script', name: file || 'script' }); return { ok: true }; } catch (e) { return { ok: false, error: errorInfo(e, file) }; }
}

export const adapter = {
  id: 'craft',
  highlight: {
    keywords: [...KEYWORDS].filter((k) => k !== 'parfor' && k !== 'global' && k !== 'persistent'),
    comment: ['%', '%{', '%}'],
    string: ["'", '"'],
    number: true,
    constants: ['pi', 'Inf', 'NaN', 'eps', 'true', 'false'],
  },
  check,
  async run(source, { ws, call, ctx }) {
    const file = ctx.file || null;
    let prog;
    try {
      prog = compileProgram(parse(String(source), file), { knownVars: new Set(ws.names()), kind: 'script', name: file || 'script' });
    } catch (e) {
      return { ok: false, error: errorInfo(e, file), vars: [] };
    }
    const vm = new VM({ rt: { ...ctx, call } });
    // find library functions by name, transitively
    const names = [];
    if (prog.main) names.push(...prog.main.refs);
    for (const u of prog.functions.values()) names.push(...u.refs);
    try {
      await loadLibrary(vm, names, ctx.library, (n) => prog.functions.has(n));
    } catch (e) {
      return { ok: false, error: errorInfo(e, file), vars: [] };
    }
    if (!prog.main) return { ok: true, vars: [] };
    try {
      const vars = vm.runScript(prog.main, ws, prog.functions);
      vm.flushSteps();
      return { ok: true, vars };
    } catch (e) {
      return { ok: false, error: errorInfo(e, file), vars: e.vars || [] };
    }
  },
};

registerLanguage({ id: 'craft', name: 'CraftScript', ext: ['.craft', '.m'], load: async () => adapter });
