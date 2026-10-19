/* SPDX-License-Identifier: Apache-2.0 */
/**
 * workspaces.js — PartCraft's workspaces (Design, Form, Simulation, Generative, Manufacture …): a registry and the
 * small bits of markup partcraft.js puts on the page for them. DOM-free: markup is made with the `el` passed in
 * (ui-util.js), so Node tests import this and every ws-<name>.js. The API is documented in
 * docs/apps/partcraft-workspaces.md — keep the two in step.
 *
 *   registerWorkspace({ id, label, icon, blurb?, groups: [{ label, items: [{ cmd, icon, label, title }] }],
 *     enter?(host), exit?(host), command?(cmd, host) → bool, renderPanel?(host, container) → heading?,
 *     onPick?(hit, host, ev), onHover?(hit, host), keydown?(ev, host) → bool, editState?(host) → { cmd: {ok, why} },
 *     toolState?(cmd, host) → { ok, why }, rebuilt?(host) })
 * Design is built in (its tools are ui.inc's); the others come from ws-<id>.js, each imported by one line in
 * partcraft.js. A workspace's commands are named `<id>-<name>` so they never meet Design's or each other's.
 */

import { t } from './i18n.js';

export const DESIGN = Object.freeze({ id: 'design', get label() { return t('ui.ws.design'); }, icon: 'box', builtin: true, groups: [] });   // label is a getter: never t() at load (workers, Node tests)
/** The switcher's order; workspaces not listed here follow in the order they registered. */
export const ORDER = ['design', 'form', 'simulation', 'generative', 'manufacture'];
const HOOKS = ['enter', 'exit', 'command', 'renderPanel', 'onPick', 'onHover', 'keydown', 'editState', 'toolState', 'rebuilt'];
const ID_RE = /^[a-z][a-z0-9]{1,23}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;

const REG = new Map([[DESIGN.id, DESIGN]]);
const CMDS = new Map();   // cmd → workspace id

const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Add a workspace. Throws Error with a plain message when the definition is bad. Returns the stored definition. */
export function registerWorkspace(def) {
  if (!def || typeof def !== 'object') throw new Error('registerWorkspace: no definition.');   // i18n-ignore: errors for the workspace's programmer, not shown in the app
  const { id } = def;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`registerWorkspace: id "${id}" must be 2–24 lower-case letters or digits.`);   // i18n-ignore: programmer error
  if (REG.has(id)) throw new Error(`registerWorkspace: a workspace "${id}" is already registered.`);   // i18n-ignore: programmer error
  if (!str(def.label, 40)) throw new Error(`registerWorkspace(${id}): label is missing.`);
  if (def.icon !== undefined && !(typeof def.icon === 'string' && ICON_RE.test(def.icon))) throw new Error(`registerWorkspace(${id}): icon must be a Bootstrap Icons name.`);
  if (def.blurb !== undefined && !str(def.blurb, 600)) throw new Error(`registerWorkspace(${id}): blurb must be text.`);
  for (const h of HOOKS) if (def[h] !== undefined && typeof def[h] !== 'function') throw new Error(`registerWorkspace(${id}): ${h} must be a function.`);
  const groups = def.groups ?? [];
  if (!Array.isArray(groups) || groups.length > 4) throw new Error(`registerWorkspace(${id}): groups must be a list of at most 4.`);
  const cmds = [];
  const clean = groups.map((g) => {
    if (!g || !str(g.label, 30) || !Array.isArray(g.items) || g.items.length > 24) throw new Error(`registerWorkspace(${id}): each group needs a label and at most 24 items.`);
    return { label: g.label, items: g.items.map((it) => {
      if (!it || typeof it.cmd !== 'string' || !new RegExp(`^${id}-[a-z0-9-]{1,40}$`).test(it.cmd)) throw new Error(`registerWorkspace(${id}): command "${it?.cmd}" must be named ${id}-<name>.`);
      if (CMDS.has(it.cmd) || cmds.includes(it.cmd)) throw new Error(`registerWorkspace(${id}): command "${it.cmd}" is already used.`);
      if (!ICON_RE.test(it.icon || '') || !str(it.label, 24) || !str(it.title, 300)) throw new Error(`registerWorkspace(${id}): ${it.cmd} needs an icon, a label (≤ 24) and a title.`);
      cmds.push(it.cmd);
      return { cmd: it.cmd, icon: it.icon, label: it.label, title: it.title };
    }) };
  });
  const stored = { ...def, icon: def.icon || 'grid', groups: clean, builtin: false };
  REG.set(id, stored);
  for (const c of cmds) CMDS.set(c, id);
  return stored;
}

export const getWorkspace = (id) => REG.get(id) || null;
/** Every workspace, Design first, in ORDER then registration order. */
export function listWorkspaces() {
  const rank = (w) => { const i = ORDER.indexOf(w.id); return i < 0 ? ORDER.length : i; };
  return [...REG.values()].map((w, i) => [w, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([w]) => w);
}
/** The workspace a toolbar command belongs to (null for Design's own commands). */
export const workspaceOfCmd = (cmd) => CMDS.get(cmd) || null;

// ---------------------------------------------------------------- markup (el = ui-util.js el)

/** A workspace's toolbar groups, the same markup as ui.inc's (pc-tool-group / pc-tool / data-cmd / bi icon). */
export function toolbarGroups(ws, el) {
  const groups = ws.groups.length ? ws.groups : [{ label: ws.label, items: [] }];
  return groups.map((g) => el('div', { className: 'pc-tool-group', role: 'group', 'aria-label': g.label, dataset: { group: 'ws-' + ws.id, workspaceGroup: ws.id }, hidden: true },
    el('span', { className: 'pc-tool-label', 'aria-hidden': 'true' }, g.label),
    el('div', { className: 'pc-tool-row' }, ...(g.items.length ? g.items.map((it) => el('button', { type: 'button', className: 'pc-tool', title: it.title, dataset: { cmd: it.cmd } },
      // i18n-ignore: 'bi bi-' is the icon font's CSS class prefix
      el('i', { className: 'bi bi-' + it.icon, 'aria-hidden': 'true' }), el('span', {}, it.label)))
      : [el('span', { className: 'pc-tool-empty' }, t('ui.ws.tools_coming'))]))));
}

/** The right panel of a workspace that draws none of its own: says, honestly, that it is being built. */
export function placeholderPanel(ws, el) {
  return el('div', { className: 'pc-ws-placeholder', dataset: { wsPlaceholder: ws.id } },
    el('p', {}, t('ui.ws.being_built', { name: ws.label })),
    ws.blurb ? el('p', { className: 'pc-note' }, t('ui.ws.planned', { blurb: ws.blurb })) : null,
    el('p', { className: 'pc-note' }, t('ui.ws.kept', { design: DESIGN.label })));
}
