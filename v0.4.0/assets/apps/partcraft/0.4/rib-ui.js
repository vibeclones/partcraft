/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rib-ui.js — the Design workspace's panel for the Rib (rib.js; 0.4 P20). A UI module (text through el()); partcraft.js
 * hands in its state as `host` (as for sheet-ui.js) and calls:
 *   create()            props for a new rib: the selected sketch, else the last sketch no feature uses that holds lines
 *   panel(f, grid, out) its right-panel rows
 *   afterBuild(f)       once, after a new rib's first build: when its side is open but the other one closes, flip it
 */
import * as P from './part.js';
import { RIB_SIDES } from './rib.js';
import { t } from './i18n.js';

export const RIB_TYPES = new Set(['rib']);
export const RIB_ICONS = { rib: 'triangle' };
export const RIB_MENU = ['rib'];

export function installRibUI(host) {
  const { el } = host;
  const set = (f, label, fn) => host.setFeature(f.id, label, fn);

  function create() {
    if (!host.useExact) { host.status(t('sheet.ui.needs_exact')); return null; }
    const part = host.part, sel = host.sel;
    const lines = (f) => f.type === 'sketch' && f.sketch.entities.some((e) => e.type === 'line' && !e.construction);
    if (sel?.kind === 'feature') { const f = P.featureById(part, sel.id); if (f && lines(f)) return { sketch: f.id }; }
    const used = new Set(part.features.filter((f) => typeof f.sketch === 'string').map((f) => f.sketch));
    const c = part.features.slice(0, P.builtCount(part)).filter((f) => lines(f) && !used.has(f.id));
    if (!c.length) { host.status(t('rib.ui.no_sketch')); return null; }
    return { sketch: c[c.length - 1].id };
  }

  /** A new rib whose side is open: try the other side once; keep it when that builds. → true when it flipped. */
  async function afterBuild(f) {
    const r = host.regen?.results.get(f.id);
    if (!r || r.status !== 'error' || r.message !== t('rib.err.open')) return false;   // the worker words it with the same catalog
    set(f, t('rib.ui.undo.flip'), (g) => { g.flip = !g.flip; });
    await host.built();
    const r2 = host.regen?.results.get(f.id);
    if (r2?.status === 'ok') { host.status(t('rib.ui.flipped', { name: f.name })); return true; }
    return false;
  }

  function panel(f, grid, out) {
    const sk = P.featureById(host.part, f.sketch);
    grid.push(el('span', { className: 'k' }, t('sheet.ui.sketch')), el('span', { className: 'v' }, sk ? sk.name : '—'));
    grid.push(...host.field(t('rib.ui.thickness'), host.numInput(f.t, (v) => set(f, t('rib.ui.undo.thickness'), (g) => { g.t = v; }), { min: 1e-4, max: 1e5, key: f.id + '.t' })));
    grid.push(...host.field(t('rib.ui.side'), host.selectInput(RIB_SIDES.map((k) => [k, t('rib.ui.side.' + k)]), f.side, (v) => set(f, t('rib.ui.undo.side'), (g) => { g.side = v; }))));
    grid.push(host.check(t('rib.ui.flip'), f.flip, (v) => set(f, t('rib.ui.undo.flip'), (g) => { g.flip = v; })));
    out.push(el('div', { className: 'pc-props' }, ...grid));
    grid.length = 0;
    out.push(el('p', { className: 'pc-props-sub' }, t('rib.ui.note')));
  }

  return { create, panel, afterBuild };
}
