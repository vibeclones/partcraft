/* SPDX-License-Identifier: Apache-2.0 */
/**
 * surface-ui.js — the Design workspace's panels for the surface features of surface.js (patch, loft surface, stitch,
 * thicken, offset / extend / trim surface, and the form feature that Form's Finish adds). A UI module (text reaches
 * the DOM only through el()); partcraft.js hands in its state as `host` (getters) and calls:
 *   create(type)        props for a new feature from the selection (null + a status message when it cannot start)
 *   panel(f, grid, out) the right-panel rows of a surface feature
 *   showSheets(regen)   surface bodies drawn in the view (view.setSheets)
 * Surface bodies are not part of the solid, so they are picked by name in the panel; a "Pick a point" button takes
 * the next click on a surface body (its own raycast) for trim's "keep this piece" and patch's "this opening".
 *   onPick(hit, ev)     a click in the view while a Gordon surface's "Pick model edges" slot is armed (true = taken)
 * Gordon surface: each sketch before it is set to Not used / Profiles / Guides (every chain of its curves is one curve);
 * model edges are added by Pick (clicks add edges until Esc).
 */
import * as P from './part.js';
import * as V from './vec.js';
import { SURFACE_LABELS, EXTEND_SIDES } from './surface.js';
import { describeReport } from './form-brep.js';
import { t } from './i18n.js';
import { describeGordon } from './gordon.js';
import { edgeRef } from './brep.js';
import { exactWhy } from './exact-client.js';

export const SURFACE_TYPES = new Set(Object.keys(SURFACE_LABELS));
export const SURFACE_ICONS = { form: 'bezier', patch: 'bandaid', surfloft: 'layers-half', stitch: 'link-45deg', thicken: 'layers-fill', offsetsurf: 'distribute-vertical', extendsurf: 'arrows-angle-expand', trimsurf: 'scissors', gordon: 'grid-3x3' };
export const SURFACE_MENU = ['patch', 'surfloft', 'gordon', 'stitch', 'thicken', 'offsetsurf', 'extendsurf', 'trimsurf'];
/** Features that leave a surface body (form only when its cage is open). */
const SHEET_MAKERS = new Set(['form', 'patch', 'surfloft', 'offsetsurf', 'extendsurf', 'trimsurf', 'gordon']);
const opOptions = () => [['new', t('ui.surface.op.new')], ['add', t('ui.surface.op.add')], ['cut', t('ui.surface.op.cut')], ['intersect', t('ui.surface.op.intersect')]];

export function installSurfaceUI(host) {
  const { el } = host;
  let armed = null;   // { id, key } waiting for a click on a surface body
  const set = (f, label, fn) => host.setFeature(f.id, label, fn);
  const nameOf = (id) => P.featureById(host.part, id)?.name || t('ui.surface.deleted_feature');
  const isOpenForm = (g) => g.type === 'form' && g.cage.faces.length && (() => { const e = new Map(); for (const fc of g.cage.faces) fc.forEach((v, k) => { const w = fc[(k + 1) % fc.length]; const key = v < w ? v + ',' + w : w + ',' + v; e.set(key, (e.get(key) || 0) + 1); }); return [...e.values()].some((c) => c === 1); })();
  /** Surface-making features before f (or all, when f is null). */
  const sheetsBefore = (f) => {
    const feats = host.part.features;
    const end = f ? P.indexOf(host.part, f.id) : feats.length;
    return feats.slice(0, end).filter((g) => SHEET_MAKERS.has(g.type) && (g.type !== 'form' || isOpenForm(g)) && !(g.type === 'gordon' && g.solid));
  };
  const live = () => new Set((host.regen?.sheets || []).map((s) => s.feature));
  const pickedSheet = () => {
    const s = host.sel?.kind === 'feature' ? P.featureById(host.part, host.sel.id) : null;
    if (s && SHEET_MAKERS.has(s.type) && live().has(s.id)) return s.id;
    const l = [...live()];
    return l.length ? l[l.length - 1] : null;
  };

  function create(type) {
    const need = (v, m) => { if (!v) host.status(m); return v; };
    if (!host.useExact) { host.status(exactWhy(SURFACE_LABELS[type], t('ui.surface.needs_exact', { label: SURFACE_LABELS[type] }))); return null; }
    if (type === 'patch') {
      const edges = [...host.multi, ...(host.pick && !host.multi.length ? [host.pick] : [])].filter((m) => m.kind === 'edge' && m.ref);
      if (edges.length) return { edges: edges.map((m) => m.ref), sheet: null };
      const sh = need(pickedSheet(), t('ui.surface.patch.need'));
      return sh ? { sheet: sh, edges: [] } : null;
    }
    if (type === 'surfloft') {
      const used = new Set(host.part.features.filter((g) => Array.isArray(g.sketches)).flatMap((g) => g.sketches));
      const sks = host.part.features.slice(0, P.builtCount(host.part)).filter((g) => g.type === 'sketch' && !used.has(g.id) && g.sketch.entities.some((e) => e.type !== 'point' && !e.construction));
      if (!need(sks.length >= 2, t('ui.surface.loft.need'))) return null;
      return { sketches: sks.slice(-2).map((g) => g.id) };
    }
    if (type === 'gordon') {
      // unused sketches with curves; profiles = those in planes parallel to the first, guides = the rest
      const used = new Set(host.part.features.flatMap((g) => [typeof g.sketch === 'string' ? g.sketch : null, ...(Array.isArray(g.sketches) ? g.sketches : []), ...['profiles', 'guides'].flatMap((k) => (Array.isArray(g[k]) ? g[k].map((x) => x.sketch) : [])), ...(Array.isArray(g.path) ? g.path.map((x) => x.sketch) : [])]));
      const sks = host.part.features.slice(0, P.builtCount(host.part)).filter((g) => g.type === 'sketch' && !used.has(g.id) && g.sketch.entities.some((e) => e.type !== 'point' && !e.construction));
      const fr = (g) => host.regen?.frames?.get(g.id);
      const n0 = sks.length ? fr(sks[0])?.n : null;
      const par = (g) => { const n = fr(g)?.n; return !!(n && n0 && Math.abs(V.dot(n, n0)) > 1 - 1e-9); };
      const profiles = sks.filter(par), guides = sks.filter((g) => !par(g));
      if (sks.length && !guides.length) host.status(t('ui.surface.gordon.all_parallel'));
      return { profiles: profiles.map((g) => ({ sketch: g.id })), guides: guides.map((g) => ({ sketch: g.id })) };
    }
    if (type === 'stitch') {
      const l = [...live()];
      return need(l.length, t('ui.surface.stitch.need')) ? { sheets: l } : null;
    }
    const sh = need(pickedSheet(), t('ui.surface.need_sheet', { label: SURFACE_LABELS[type] }));
    if (!sh) return null;
    if (type === 'trimsurf') { const other = [...live()].filter((x) => x !== sh); return { sheet: sh, tool: other.length ? other[other.length - 1] : 'body', at: null, keep: 'near' }; }
    return { sheet: sh };
  }

  function arm(f, key) {
    if (armed && armed.id === f.id && armed.key === key) { armed = null; host.status(''); host.renderProps(); return; }
    armed = { id: f.id, key };
    host.status(t('ui.surface.pick.prompt'), true);
    host.renderProps();
    const canvas = host.view.canvas;
    let down = null;
    const onDown = (e) => { down = [e.clientX, e.clientY]; };
    const onUp = (e) => {
      if (!armed || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
      const hit = host.view.ray(e.clientX, e.clientY).intersectObjects(host.view.sheetRoot ? host.view.sheetRoot.children : [], false)[0];
      if (!hit) { host.status(t('ui.surface.pick.miss'), true); return; }
      const p = hit.point.toArray().map((v) => +v.toFixed(6));
      const a = armed; armed = null; done();
      set(P.featureById(host.part, a.id), t('ui.surface.undo.pick_point'), (g) => { g[a.key] = p; });
      host.status(t('ui.surface.pick.done'));
    };
    const onKey = (e) => { if (e.key === 'Escape' && armed) { armed = null; done(); host.status(t('ui.surface.pick.cancelled')); host.renderProps(); } };
    function done() { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp, true); document.removeEventListener('keydown', onKey, true); }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp, true);
    document.addEventListener('keydown', onKey, true);
  }
  // ---- Gordon: a slot for model edges (clicks add edges to profiles or guides until Esc)
  let edgeSlot = null;   // { id, key }
  let escOff = null;
  const disarm = (msg) => { edgeSlot = null; if (escOff) { escOff(); escOff = null; } if (msg) host.status(msg); host.renderProps(); };
  function armEdges(f, key) {
    if (edgeSlot && edgeSlot.id === f.id && edgeSlot.key === key) { disarm(''); return; }
    if (!host.regen?.exact || !host.regen.edges?.length) { host.status(t('ui.surface.edges.none')); return; }
    edgeSlot = { id: f.id, key };
    const onKey = (e) => { if (e.key === 'Escape' && edgeSlot) { e.stopPropagation(); disarm(t('ui.surface.edges.done')); } };
    document.addEventListener('keydown', onKey, true);
    escOff = () => document.removeEventListener('keydown', onKey, true);
    host.status(t(key === 'profiles' ? 'ui.surface.edges.prompt_profiles' : 'ui.surface.edges.prompt_guides'), true);
    host.renderProps();
  }
  function onPick(h) {
    if (!edgeSlot) return false;
    const f = P.featureById(host.part, edgeSlot.id);
    if (!f) { disarm(''); return false; }
    const edge = h && h.kind === 'edge' && host.regen?.exact && h.edge !== undefined ? host.regen.edges[h.edge] : null;
    if (!edge) { host.status(t('ui.surface.edges.miss'), true); return true; }
    const ref = edgeRef(edge), key = edgeSlot.key, same = (x) => x.edge && x.edge.faces.join() === ref.faces.join() && V.len(V.sub(x.edge.at || [0, 0, 0], ref.at)) < 1e-6;
    if ([...f.profiles, ...f.guides].some(same)) { host.status(t('ui.surface.edges.already'), true); return true; }
    const slot = edgeSlot;
    set(f, key === 'profiles' ? t('ui.surface.undo.profile_edge') : t('ui.surface.undo.guide_edge'), (g) => { g[key] = [...g[key], { edge: ref }]; });
    edgeSlot = slot;
    host.status(t(key === 'profiles' ? 'ui.surface.edges.added_profiles' : 'ui.surface.edges.added_guides', { name: f.name }), true);
    host.renderProps();
    return true;
  }
  const edgeBtn = (f, key, label) => host.btn(edgeSlot && edgeSlot.id === f.id && edgeSlot.key === key ? t('ui.surface.picking_done') : label, () => armEdges(f, key), edgeSlot && edgeSlot.id === f.id && edgeSlot.key === key ? 'pc-btn is-primary' : 'pc-btn', { dataset: { slot: 'edges-' + key } });

  const pickBtn = (f, key, label) => host.btn(armed && armed.id === f.id && armed.key === key ? t('ui.surface.picking_cancel') : label, () => arm(f, key), armed && armed.id === f.id ? 'pc-btn is-primary' : 'pc-btn', { dataset: { slot: key } });
  const sheetSelect = (f, key, extra = []) => {
    const opts = [...extra, ...sheetsBefore(f).map((g) => [g.id, g.name])];
    if (!opts.length) opts.push(['', t('ui.surface.no_sheet_before')]);
    return host.selectInput(opts, f[key] ?? '', (v) => set(f, t('ui.surface.undo.surface'), (g) => { g[key] = v || null; }));
  };
  const note = (text) => el('span', { className: 'span pc-muted' }, text);

  function panel(f, grid, out) {
    const r = host.regen?.results.get(f.id);
    const dl = (rows) => { const d = el('dl', { className: 'pc-dl' }); for (const [k, v] of rows) d.append(el('dt', {}, k), el('dd', {}, v)); return d; };
    switch (f.type) {
      case 'form': {
        const st = f.cage;
        out.push(dl([[t('ui.surface.form.cage'), st.creases?.length ? t('ui.surface.form.cage_creased', { verts: st.verts.length, faces: st.faces.length, creases: st.creases.length }) : t('ui.surface.form.cage_plain', { verts: st.verts.length, faces: st.faces.length })], [t('ui.surface.form.exact'), r?.form ? describeReport(r.form) : t('ui.surface.form.not_built')], [t('ui.surface.result'), r?.form ? (r.form.volume ? t('ui.surface.form.closed_solid', { v: V.fmt(r.form.volume, 2) }) : t('ui.surface.form.open_body')) : '']]));
        grid.push(...host.field(t('ui.surface.operation'), host.selectInput(opOptions(), f.op, (v) => set(f, t('ui.surface.operation'), (g) => { g.op = v; }))));
        grid.push(...host.field(t('ui.surface.form.level'), host.selectInput([['', t('ui.surface.form.level_auto')], ['0', '0'], ['1', '1'], ['2', t('ui.surface.form.level_2')], ['3', '3']], f.level === null ? '' : String(f.level), (v) => set(f, t('ui.surface.form.level'), (g) => { g.level = v === '' ? null : Number(v); }))));
        grid.push(note(t('ui.surface.form.note')));
        out.push(el('div', { className: 'pc-actions' }, host.btn(t('ui.surface.form.edit'), () => host.editForm?.(f.id), 'pc-btn is-primary', { dataset: { act: 'edit-form' } })));
        break;
      }
      case 'patch':
        if (f.edges.length) { grid.push(el('span', { className: 'k' }, t('ui.surface.patch.boundary')), el('span', { className: 'v' }, t('ui.surface.patch.edges', { n: f.edges.length }))); }
        else {
          grid.push(...host.field(t('ui.surface.patch.opening_of'), sheetSelect(f, 'sheet')));
          grid.push(...host.field(t('ui.surface.patch.continuity'), host.selectInput([['G0', t('ui.surface.patch.g0')], ['G1', t('ui.surface.patch.g1')]], f.cont, (v) => set(f, t('ui.surface.patch.continuity'), (g) => { g.cont = v; }))));
          out.push(el('div', { className: 'pc-actions' }, pickBtn(f, 'at', f.at ? t('ui.surface.patch.pick_again') : t('ui.surface.patch.pick'))));
        }
        if (r?.patch) grid.push(note(f.cont === 'G1' ? t('ui.surface.patch.note_g1', { g0: r.patch.g0.toExponential(1), g1: (r.patch.g1 * 180 / Math.PI).toFixed(2) }) : t('ui.surface.patch.note', { g0: r.patch.g0.toExponential(1) })));
        break;
      case 'surfloft': {
        const sks = host.part.features.slice(0, P.indexOf(host.part, f.id)).filter((g) => g.type === 'sketch');
        for (const g of sks) grid.push(host.check(g.name, f.sketches.includes(g.id), (on) => set(f, t('ui.surface.undo.loft_sketches'), (h) => { h.sketches = on ? sks.filter((x) => h.sketches.includes(x.id) || x.id === g.id).map((x) => x.id) : h.sketches.filter((x) => x !== g.id); })));
        grid.push(note(t('ui.surface.loft.note')));
        break;
      }
      case 'stitch': {
        for (const g of sheetsBefore(f)) grid.push(host.check(g.name, f.sheets.includes(g.id), (on) => set(f, t('ui.surface.undo.stitch'), (h) => { h.sheets = on ? [...new Set([...h.sheets, g.id])] : h.sheets.filter((x) => x !== g.id); })));
        grid.push(...host.field(t('ui.surface.tolerance_mm'), host.numInput(f.tol, (v) => set(f, t('ui.surface.undo.tolerance'), (g) => { g.tol = v; }), { min: 1e-7, max: 10 })));
        grid.push(...host.field(t('ui.surface.operation'), host.selectInput(opOptions(), f.op, (v) => set(f, t('ui.surface.operation'), (g) => { g.op = v; }))));
        grid.push(note(t('ui.surface.stitch.note')));
        break;
      }
      case 'thicken':
        grid.push(...host.field(t('ui.surface.surface'), sheetSelect(f, 'sheet')));
        grid.push(...host.field(t('ui.surface.thickness_mm'), host.numInput(f.t, (v) => set(f, t('ui.surface.undo.thickness'), (g) => { g.t = v; }), { min: 1e-6 })));
        grid.push(...host.field(t('ui.surface.side'), host.selectInput([['out', t('ui.surface.side.out')], ['in', t('ui.surface.side.in')], ['both', t('ui.surface.side.both')]], f.side, (v) => set(f, t('ui.surface.side'), (g) => { g.side = v; }))));
        grid.push(...host.field(t('ui.surface.operation'), host.selectInput(opOptions(), f.op, (v) => set(f, t('ui.surface.operation'), (g) => { g.op = v; }))));
        break;
      case 'offsetsurf':
        grid.push(...host.field(t('ui.surface.surface'), sheetSelect(f, 'sheet')));
        grid.push(...host.field(t('ui.surface.distance_mm'), host.numInput(f.d, (v) => { if (v === 0) { host.status(t('ui.surface.offset.zero')); return; } set(f, t('ui.surface.undo.distance'), (g) => { g.d = v; }); })));
        grid.push(note(t('ui.surface.offset.note')));
        break;
      case 'extendsurf':
        grid.push(...host.field(t('ui.surface.surface'), sheetSelect(f, 'sheet')));
        grid.push(...host.field(t('ui.surface.distance_mm'), host.numInput(f.d, (v) => set(f, t('ui.surface.undo.distance'), (g) => { g.d = v; }), { min: 1e-6 })));
        for (const s of EXTEND_SIDES) grid.push(host.check({ umin: t('ui.surface.extend.umin'), umax: t('ui.surface.extend.umax'), vmin: t('ui.surface.extend.vmin'), vmax: t('ui.surface.extend.vmax') }[s], f.sides.includes(s), (on) => { const next = on ? [...new Set([...f.sides, s])] : f.sides.filter((x) => x !== s); if (!next.length) { host.status(t('ui.surface.extend.one_side')); host.renderProps(); return; } set(f, t('ui.surface.undo.extend_sides'), (g) => { g.sides = next; }); }));
        grid.push(note(t('ui.surface.extend.note')));
        break;
      case 'gordon': {
        const sks = host.part.features.slice(0, P.indexOf(host.part, f.id)).filter((g) => g.type === 'sketch');
        const roleOf = (g) => (f.profiles.some((x) => x.sketch === g.id) ? 'profiles' : f.guides.some((x) => x.sketch === g.id) ? 'guides' : '');
        for (const g of sks) {
          const sel = host.selectInput([['', t('ui.surface.gordon.not_used')], ['profiles', t('ui.surface.gordon.profiles')], ['guides', t('ui.surface.gordon.guides')]], roleOf(g), (v) => set(f, t('ui.surface.undo.network'), (h) => {
            h.profiles = h.profiles.filter((x) => x.sketch !== g.id); h.guides = h.guides.filter((x) => x.sketch !== g.id);
            if (v) h[v] = [...h[v], { sketch: g.id }];
          }));
          sel.dataset.gordonSketch = g.id;
          grid.push(...host.field(g.name, sel));
        }
        if (!sks.length) grid.push(note(t('ui.surface.gordon.no_sketches')));
        grid.push(note(t('ui.surface.gordon.chains')));
        grid.push(...host.field(t('ui.surface.tolerance_mm'), host.numInput(f.tol, (v) => set(f, t('ui.surface.undo.tolerance'), (g) => { g.tol = v; }), { min: 1e-7, max: 10 })));
        grid.push(host.check(t('ui.surface.gordon.solid'), f.solid, (on) => set(f, t('ui.surface.undo.solid'), (g) => { g.solid = on; })));
        if (f.solid) grid.push(...host.field(t('ui.surface.operation'), host.selectInput(opOptions(), f.op, (v) => set(f, t('ui.surface.operation'), (g) => { g.op = v; }))));
        out.push(el('div', { className: 'pc-props' }, ...grid));
        grid.length = 0;
        const items = [];
        for (const key of ['profiles', 'guides']) f[key].forEach((x, i) => {
          if (!x.edge) return;
          items.push(el('li', {}, el('span', { className: 'grow' }, t(key === 'profiles' ? 'ui.surface.gordon.profile_edge' : 'ui.surface.gordon.guide_edge', host.faceWords ? { a: host.faceWords(x.edge.faces[0]), b: host.faceWords(x.edge.faces[1]) } : { a: x.edge.faces[0], b: x.edge.faces[1] })),
            host.btn(t('ui.surface.remove'), () => set(f, t('ui.surface.undo.remove_edge'), (h) => { h[key] = h[key].filter((_, k) => k !== i); }), 'pc-linkbtn')));
        });
        out.push(el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub', style: 'margin-top:0' }, t('ui.surface.gordon.edges_title')),
          items.length ? el('ul', { className: 'pc-list' }, ...items) : el('p', { className: 'pc-note' }, t('ui.surface.none')),
          el('div', { className: 'pc-actions' }, edgeBtn(f, 'profiles', t('ui.surface.gordon.pick_profiles')), edgeBtn(f, 'guides', t('ui.surface.gordon.pick_guides')))));
        // 0.4 P11: tangent to planes along boundary curves
        {
          const planes = f.tangent || [];
          const words = (p) => (p.kind === 'base' ? t('gordon.ui.base.' + p.name) : p.kind === 'ref' ? (P.featureById(host.part, p.feature)?.name || p.feature) : p.name && host.faceWords ? host.faceWords(p.name) : t('gordon.ui.face'));
          const rows = planes.map((p, i) => el('li', { dataset: { gordonTangent: String(i) } }, el('span', { className: 'grow' }, words(p)),
            host.btn(t('gordon.ui.remove'), () => set(f, t('gordon.ui.undo'), (h) => { h.tangent = (h.tangent || []).filter((_, k) => k !== i); }), 'pc-linkbtn')));
          const refs = host.part.features.slice(0, P.indexOf(host.part, f.id)).filter((g) => g.type === 'plane');
          const add = host.selectInput([['', t('gordon.ui.add')], ...['front', 'top', 'right'].map((k) => ['base:' + k, t('gordon.ui.base.' + k)]), ...refs.map((g) => ['ref:' + g.id, g.name])], '', (v) => {
            if (!v) return;
            const [kind, id] = v.split(':');
            const ref = kind === 'base' ? { kind: 'base', name: id } : { kind: 'ref', feature: id };
            set(f, t('gordon.ui.undo'), (h) => { h.tangent = [...(h.tangent || []), ref].slice(0, 4); });
          });
          add.dataset.gordonTangentAdd = '';
          const pk = host.pick, flat = pk && pk.kind === 'face' && pk.flat && pk.ref;
          out.push(el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub', style: 'margin-top:0' }, t('gordon.ui.title')),
            rows.length ? el('ul', { className: 'pc-list' }, ...rows) : el('p', { className: 'pc-note' }, t('gordon.ui.none')),
            el('div', { className: 'pc-actions' }, add, host.btn(t('gordon.ui.add_face'), () => set(f, t('gordon.ui.undo'), (h) => { h.tangent = [...(h.tangent || []), pk.ref].slice(0, 4); }), 'pc-btn', { disabled: !flat || planes.length >= 4, title: t('gordon.ui.add_face_title'), dataset: { gordonTangentFace: '' } })),
            el('p', { className: 'pc-note' }, t('gordon.ui.note'))));
        }
        if (r?.gordon) out.push(dl([[t('ui.surface.gordon.network'), describeGordon(r.gordon)], [t('ui.surface.result'), f.solid ? t('ui.surface.gordon.closed_solid') : t('ui.surface.gordon.sheet_body')]]));
        out.push(el('p', { className: 'pc-note' }, t('ui.surface.gordon.note')));
        break;
      }
      case 'trimsurf':
        grid.push(...host.field(t('ui.surface.surface'), sheetSelect(f, 'sheet')));
        grid.push(...host.field(t('ui.surface.trim.cut_by'), sheetSelect(f, 'tool', [['body', t('ui.surface.trim.solid_body')]])));
        grid.push(...host.field(t('ui.surface.trim.keep'), host.selectInput([['near', t('ui.surface.trim.near')], ['far', t('ui.surface.trim.far')]], f.keep, (v) => set(f, t('ui.surface.trim.keep'), (g) => { g.keep = v; }))));
        out.push(el('div', { className: 'pc-actions' }, pickBtn(f, 'at', f.at ? t('ui.surface.trim.pick_again') : t('ui.surface.trim.pick'))));
        if (!f.at) grid.push(note(t('ui.surface.trim.no_point')));
        break;
    }
    void nameOf;
  }

  function showSheets(regen) { host.view.setSheets?.(regen?.sheets || []); }
  return { create, panel, showSheets, onPick, cancel: () => { if (edgeSlot) { disarm(''); return true; } if (!armed) return false; armed = null; return true; } };
}
