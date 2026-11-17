/* SPDX-License-Identifier: Apache-2.0 */
/**
 * thread-ui.js — the Design workspace's panels for threads (threads.js; 0.5 WL.29). A UI module (text through el());
 * partcraft.js hands in its state as `host` (as for rib-ui.js) and calls:
 *   panel(f, grid, out)   the Thread feature's right-panel rows (its faces are listed by partcraft.js refList)
 *   holeExtra(f, grid)    a tapped hole's "Modelled" switch and clearance
 */
import { THREAD_TABLES, THREAD_FORMS, THREAD_HANDS, THREAD_SOURCES, DEFAULT_CLEARANCE, threadDims, sizeLabel } from './threads.js';
import { t } from './i18n.js';

export const THREAD_TYPES = new Set(['thread']);
export const THREAD_ICONS = { thread: 'nut' };
export const THREAD_MENU = ['thread'];

export function installThreadUI(host) {
  const { el } = host;
  const set = (f, label, fn) => host.setFeature(f.id, label, fn);
  const fmt = (v) => String(+Number(v).toFixed(3));

  /** The modelled switch and its clearance, with the line saying what it does. */
  function modelledRows(f, grid) {
    grid.push(host.check(t('thread.ui.modelled'), !!f.modelled, (v) => set(f, t('thread.ui.undo.modelled'), (g) => {
      if (v) { g.modelled = true; g.clearance = g.clearance ?? DEFAULT_CLEARANCE; } else if (g.type === 'hole') { delete g.modelled; delete g.clearance; } else g.modelled = false;
    })));
    if (f.modelled) grid.push(...host.field(t('thread.ui.clearance'), host.numInput(f.clearance ?? DEFAULT_CLEARANCE, (v) => set(f, t('thread.ui.undo.clearance'), (g) => { g.clearance = v; }), { min: 0, max: 5, key: f.id + '.clearance' })));
    grid.push(el('span', { className: 'span pc-muted' }, t(f.modelled ? 'thread.ui.modelled_note' : 'thread.ui.cosmetic_note')));
  }

  function panel(f, grid, out) {
    grid.push(...host.field(t('thread.ui.form'), host.selectInput(THREAD_FORMS.map((k) => [k, t('thread.ui.form.' + k)]), f.form, (v) => set(f, t('thread.ui.undo.form'), (g) => { g.form = v; g.size = 'auto'; }))));
    const sizes = Object.keys(THREAD_TABLES[f.form]).map((k) => { const g = threadDims(f.form, k); return [k, f.form === 'tr' ? sizeLabel(f.form, k) : t('thread.ui.size_option', { size: k, pitch: fmt(g.p) })]; });
    grid.push(...host.field(t('thread.ui.size'), host.selectInput([['auto', t('thread.ui.size_auto')], ...sizes], f.size, (v) => set(f, t('thread.ui.undo.size'), (g) => { g.size = v; }))));
    grid.push(host.check(t('thread.ui.full'), f.length === null, (v) => set(f, t('thread.ui.undo.length'), (g) => { g.length = v ? null : 10; })));
    if (f.length !== null) grid.push(...host.field(t('thread.ui.length'), host.numInput(f.length, (v) => set(f, t('thread.ui.undo.length'), (g) => { g.length = v; }), { min: 1e-3, key: f.id + '.length' })));
    grid.push(host.check(t('thread.ui.flip'), f.flip, (v) => set(f, t('thread.ui.undo.flip'), (g) => { g.flip = v; })));
    grid.push(...host.field(t('thread.ui.hand'), host.selectInput(THREAD_HANDS.map((k) => [k, t('thread.ui.hand.' + k)]), f.hand, (v) => set(f, t('thread.ui.undo.hand'), (g) => { g.hand = v; }))));
    modelledRows(f, grid);
    // what was built: each face's callout
    const th = host.regen?.threads?.get?.(f.id);
    if (th) for (const c of th.callouts || []) grid.push(el('span', { className: 'span' }, (c.count > 1 ? c.count + '× ' : '') + c.callout));
    grid.push(el('span', { className: 'span pc-muted' }, THREAD_SOURCES[f.form]));
    out.push(el('div', { className: 'pc-props' }, ...grid));
    grid.length = 0;
  }

  function holeExtra(f, grid) {
    if (f.type !== 'hole' || f.kind !== 'tapped') return;
    modelledRows(f, grid);
  }

  return { panel, holeExtra };
}
