/* SPDX-License-Identifier: Apache-2.0 */
/**
 * design-ui.js — the Design workspace's panels and picking for the features of design-features.js (reference planes,
 * axes and points, sweep, loft, draft, the extended extrude / hole / chamfer / fillet / revolve options). A UI module
 * (text reaches the DOM only through el()); partcraft.js owns the state and hands it in as `host` (getters), and calls:
 *   panel(f, grid, out)     the right-panel rows of a new feature type (true when it drew them)
 *   extra(f, grid)          the extra rows of extrude / hole / chamfer / fillet
 *   onPick(hit, ev)         a click in the view while a reference slot is waiting (true = taken)
 *   refsForView()           reference geometry and cosmetic threads for view3d (setRefs / sketch lines)
 *   create(type)            a new feature from the current selection
 * Slot picking: a panel's "Pick" button arms one slot (plane, point, face, edge, axis, path edge, loft face, region);
 * the next click in the view fills it (one undo step) and the slot disarms. Esc (host.cancelSlot) or Cancel drops it.
 */
import { t } from './i18n.js';
import * as V from './vec.js';
import * as P from './part.js';
import * as S from './sketch.js';
import { refForName, edgeRef, faceRef, findFace, findEdge } from './brep.js';
import { planeQuad } from './refgeom.js';
import { ISO_COARSE, THREAD_SOURCE, threadCallout, REF_TYPES } from './design-features.js';
import { exactWhy } from './exact-client.js';

export const DESIGN_TYPES = new Set(['plane', 'axis', 'point', 'sweep', 'loft', 'draft']);
export const DESIGN_ICONS = { plane: 'square-half', axis: 'arrows-vertical', point: 'crosshair', sweep: 'bezier2', loft: 'layers', draft: 'triangle-half' };
// Option lists [value, label]: the label is a getter (t() runs when a list is shown, never at import: workers and
// Node tests load this module before the language catalog arrives). `[v, l]` destructuring reads it then.
const lazyOptions = (prefix, values) => values.map((v) => Object.defineProperty([v], 1, { get: () => t(prefix + v), enumerable: true }));
export const EXTRUDE_END_OPTIONS = lazyOptions('ui.design.end.', ['blind', 'mid', 'through', 'upto', 'next', 'vertex', 'offset']);
export const HOLE_TYPE_OPTIONS = lazyOptions('ui.design.hole.', ['simple', 'cbore', 'csink', 'tapped']);
const OP_OPTIONS = lazyOptions('ui.design.op.', ['add', 'cut', 'intersect', 'new']);
const PLANE_MODE_OPTIONS = lazyOptions('ui.design.plane_mode.', ['offset', 'angle', '3pt', 'mid', 'tangent', 'normal', 'edgept', 'midnormal']);
const AXIS_MODE_OPTIONS = lazyOptions('ui.design.axis_mode.', ['2pt', 'cyl', 'planes', 'edge', 'normal']);
const POINT_MODE_OPTIONS = lazyOptions('ui.design.point_mode.', ['xyz', 'at', 'center', 'mid', 'meet', 'planes3']);
const ORIENT_OPTIONS = lazyOptions('ui.design.orient.', ['corrected', 'frenet', 'fixed', 'binormal', 'guide']);
// slot kinds → status key ui.design.slot.<kind> ("Click … in the view for {name}. Esc cancels.")
const SLOT_KEYS = { plane: 'plane', point: 'point', face: 'face', edge: 'edge', axis: 'axis', pathEdge: 'path_edge', loftFace: 'loft_face', region: 'region' };

export function installDesignUI(host) {
  const { el } = host;
  let slot = null;   // { id, key, kind, index? }

  const feats = () => host.part.features;
  const before = (f) => feats().slice(0, P.indexOf(host.part, f.id));
  const nameOf = (id) => P.featureById(host.part, id)?.name || t('ui.design.deleted_feature');
  const isSlot = (f, key, index) => slot && slot.id === f.id && slot.key === key && (index === undefined || slot.index === index);
  function arm(f, key, kind, index) {
    if (isSlot(f, key, index)) { slot = null; host.status(''); host.renderProps(); return; }
    if (kind !== 'plane' && kind !== 'point' && kind !== 'region' && kind !== 'axis' && !host.useExact && !host.regen?.named) { host.status(exactWhy(t('kernel.what.pick'), t('ui.design.exact.pick'))); return; }
    slot = { id: f.id, key, kind, index };
    host.status(t('ui.design.slot.' + SLOT_KEYS[kind], { name: f.name }), true);
    host.renderProps();
    host.focusStage();
  }
  const cancel = () => { if (!slot) return false; slot = null; host.status(t('ui.design.pick_cancelled')); host.renderProps(); return true; };
  const pickBtn = (f, key, kind, index, label = t('ui.design.pick')) => host.btn(isSlot(f, key, index) ? t('ui.design.picking') : label, () => arm(f, key, kind, index), isSlot(f, key, index) ? 'pc-btn is-primary' : 'pc-btn', { dataset: { slot: key + (index !== undefined ? index : '') } });
  const set = (f, label, fn) => host.setFeature(f.id, label, fn);

  // ---------------------------------------------------------------- words for references
  function planeWords(r) {
    if (!r) return t('ui.design.none');
    if (r.kind === 'base') return V.PLANE_NAMES[r.name];
    if (r.kind === 'ref') return nameOf(r.feature);
    if (r.kind === 'face') return host.faceWords(r.name || `${r.feature}.${r.face}${r.entity ? ':' + r.entity : ''}`);
    return t('ui.design.fixed_plane');
  }
  function pointWords(r) {
    if (!r) return t('ui.design.none');
    if (r.kind === 'fixed') return '(' + r.p.map((v) => V.fmt(v, 3)).join(', ') + ')';
    if (r.kind === 'ref') return nameOf(r.feature);
    if (r.kind === 'sketch') return r.entity === 'O' ? t('ui.design.origin_of', { name: nameOf(r.sketch) }) : t('ui.design.point_of', { id: r.entity, name: nameOf(r.sketch) });
    return t('ui.design.edge_end', { a: host.faceWords(r.edge.faces[0]), b: host.faceWords(r.edge.faces[1]) });
  }
  function dirWords(r) {
    if (!r) return t('ui.design.none');
    if (r.kind === 'world') return t('ui.design.world_axis', { axis: r.axis.toUpperCase() });
    if (r.kind === 'ref') return nameOf(r.feature);
    if (r.kind === 'axis') return t('ui.design.axis_of', { name: nameOf(r.feature) });
    if (r.kind === 'line') return t('ui.design.line_of', { name: nameOf(r.sketch) });
    return t('ui.design.picked_edge');
  }
  const edgeWords = (r) => (r ? host.faceWords(r.faces[0]) + ' × ' + host.faceWords(r.faces[1]) : t('ui.design.none'));
  const faceWordsR = (r) => (r ? host.faceWords(r.name) : t('ui.design.none'));

  // ---------------------------------------------------------------- slot widgets
  const row = (label, ...kids) => [el('span', { className: 'k' }, label), el('span', { className: 'v pc-slot' }, ...kids)];
  function planeSlot(f, key, index, label) {
    const cur = index === undefined ? f[key] : f[key]?.[index];
    const opts = [['base:front', t('ui.design.front_plane')], ['base:top', t('ui.design.top_plane')], ['base:right', t('ui.design.right_plane')], ...before(f).filter((g) => g.type === 'plane').map((g) => ['ref:' + g.id, g.name])];
    const val = !cur ? '' : cur.kind === 'base' ? 'base:' + cur.name : cur.kind === 'ref' ? 'ref:' + cur.feature : 'cur';
    if (val === 'cur' || !cur) opts.push([val, cur ? planeWords(cur) : t('ui.design.pick_one')]);
    const s = host.selectInput(opts, val, (v) => {
      if (!v || v === 'cur') return;
      const [k, a] = v.split(':');
      const nr = k === 'base' ? { kind: 'base', name: a } : { kind: 'ref', feature: a };
      set(f, label, (g) => { if (index === undefined) g[key] = nr; else g[key][index] = nr; });
    });
    s.setAttribute('aria-label', label);
    return [el('label', { htmlFor: s.id }, label), el('span', { className: 'pc-slot' }, s, pickBtn(f, key, 'plane', index))];
  }
  const pointSlot = (f, key, index, label) => row(label, el('span', { className: 'grow' }, pointWords(index === undefined ? f[key] : f[key]?.[index])), pickBtn(f, key, 'point', index));
  const faceSlot = (f, key, label) => row(label, el('span', { className: 'grow' }, faceWordsR(f[key])), pickBtn(f, key, 'face'));
  const edgeSlot = (f, key, label) => row(label, el('span', { className: 'grow' }, edgeWords(f[key])), pickBtn(f, key, 'edge'));
  function dirSlot(f, key, label, { allowNull = null } = {}) {
    const cur = f[key];
    const opts = [];
    if (allowNull) opts.push(['', allowNull]);
    opts.push(['world:x', t('ui.design.world_axis', { axis: 'X' })], ['world:y', t('ui.design.world_axis', { axis: 'Y' })], ['world:z', t('ui.design.world_axis', { axis: 'Z' })]);
    for (const g of before(f)) {
      if (g.type === 'axis') opts.push(['ref:' + g.id, g.name]);
      if (g.type === 'plane') opts.push(['ref:' + g.id, t('ui.design.its_normal', { name: g.name })]);
      if (g.type === 'revolve') opts.push(['axis:' + g.id, t('ui.design.axis_of_opt', { name: g.name })]);
    }
    const val = !cur ? '' : cur.kind === 'world' ? 'world:' + cur.axis : cur.kind === 'ref' ? 'ref:' + cur.feature : cur.kind === 'axis' ? 'axis:' + cur.feature : 'cur';
    if (val === 'cur') opts.push(['cur', dirWords(cur)]);
    if (!cur && !allowNull) opts.unshift(['', t('ui.design.pick_one')]);
    const s = host.selectInput(opts, val, (v) => {
      if (v === 'cur') return;
      const [k, a] = v.split(':');
      const nr = !v ? null : k === 'world' ? { kind: 'world', axis: a } : k === 'ref' ? { kind: 'ref', feature: a } : { kind: 'axis', feature: a };
      set(f, label, (g) => { g[key] = nr; });
    });
    return [el('label', { htmlFor: s.id }, label), el('span', { className: 'pc-slot' }, s, pickBtn(f, key, 'axis'))];
  }
  const opSelect = (f) => host.field(t('ui.design.operation'), host.selectInput(OP_OPTIONS, f.op, (v) => set(f, t('ui.design.operation'), (g) => { g.op = v; })));

  // ---------------------------------------------------------------- picking into a slot
  function onPick(h, ev) {
    if (!slot) return false;
    const f = P.featureById(host.part, slot.id);
    if (!f) { slot = null; return false; }
    const regen = host.regen;
    const face = h && h.kind === 'face' && (regen?.exact || regen?.named) && h.face !== undefined ? regen.faces[h.face] : null;
    const edge = h && h.kind === 'edge' && (regen?.exact || regen?.named) && h.edge !== undefined ? regen.edges[h.edge] : null;
    const refHit = h && h.kind === 'ref' ? P.featureById(host.part, h.id) : null;
    // what = plane|point|face|edge|direction|path_edge|section|region: undo label ui.design.put.<what>, status ….<what>_set
    const put = (what, val) => {
      const { key, index } = slot;
      slot = null;
      set(f, t('ui.design.put.' + what), (g) => {
        if (key === 'path') g.path = [...g.path, val];
        else if (key === 'sections') g.sections = [...g.sections, val];
        else if (key === 'rails') g.rails = [...(g.rails || []), val];
        else if (key === 'regions') g.regions = [...(g.regions || []), val];
        else if (index === undefined) g[key] = val;
        else { g[key] = [...(g[key] || [])]; g[key][index] = val; }
      });
      host.status(t('ui.design.put.' + what + '_set', { name: f.name }));
    };
    // every refusal ends "Esc cancels." inside its own text (ui.design.nope.*)
    const nope = (key) => { host.status(t('ui.design.nope.' + key), true); return true; };
    switch (slot.kind) {
      case 'plane':
        if (h && h.kind === 'plane') return put('plane', { kind: 'base', name: h.name }), true;
        if (refHit && refHit.type === 'plane' && refHit.id !== f.id) return put('plane', { kind: 'ref', feature: refHit.id }), true;
        if (face && face.type === 'plane') return face.name ? (put('plane', refForName(face.name)), true) : nope('face_unnamed');
        return nope('plane');
      case 'point': {
        if (refHit && refHit.type === 'point') return put('point', { kind: 'ref', feature: refHit.id }), true;
        if (edge) { const p = nearestEnd(edge, h); return put('point', { kind: 'vertex', edge: edgeRef(edge), p: p.map((v) => +v.toFixed(6)) }), true; }
        if (h && h.kind === 'face') return put('point', { kind: 'fixed', p: h.point.map((v) => +v.toFixed(6)) }), true;
        return nope('point');
      }
      case 'face': if (face && face.name) return put('face', faceRef(face)), true; return nope('face');
      case 'edge': if (edge) return put('edge', edgeRef(edge)), true; return nope('edge');
      case 'axis':
        if (refHit && (refHit.type === 'axis' || refHit.type === 'plane') && refHit.id !== f.id) return put('direction', { kind: 'ref', feature: refHit.id }), true;
        if (h && h.kind === 'edge') {
          const a = edge ? edge.a : h.a, b = edge ? edge.b : h.b;
          if (edge && edge.type !== 'line') return nope('curved');
          return put('direction', { kind: 'fixed', o: a.map((v) => +v.toFixed(9)), d: V.norm(V.sub(b, a)).map((v) => +v.toFixed(12)) }), true;
        }
        return nope('axis');
      case 'pathEdge': if (edge) { slot = { ...slot, kind: 'pathEdge' }; const k = slot; put('path_edge', { edge: edgeRef(edge) }); slot = k; host.renderProps(); host.status(t('ui.design.path_edge_added', { name: f.name }), true); return true; } return nope('edge');
      case 'loftFace': if (face && face.name) return put('section', { face: faceRef(face) }), true; return nope('flat_face');
      case 'region': {
        const fr = regen?.frames.get(f.sketch);
        if (!fr || !ev) return nope('sketch_not_built');
        const ray = host.view.ray(ev.clientX, ev.clientY).ray;
        const n = fr.n, den = n[0] * ray.direction.x + n[1] * ray.direction.y + n[2] * ray.direction.z;
        if (Math.abs(den) < 1e-9) return nope('edge_on');
        const o = [ray.origin.x, ray.origin.y, ray.origin.z];
        const tt = V.dot(V.sub(fr.o, o), n) / den;   // ray parameter (not named t: that is the i18n function)
        const p = V.add(o, V.mul([ray.direction.x, ray.direction.y, ray.direction.z], tt));
        const q = V.toPlane(fr, p).map((v) => +v.toFixed(6));
        const k = slot;
        put('region', q);
        slot = k; host.renderProps();
        host.status(t('ui.design.region_picked', { name: f.name, at: q.join(', ') }), true);
        return true;
      }
    }
    return false;
  }
  function nearestEnd(e, h) { const m = h.a && h.b ? V.mul(V.add(h.a, h.b), 0.5) : e.at; return V.len(V.sub(e.a, m)) <= V.len(V.sub(e.b, m)) ? e.a : e.b; }

  // ---------------------------------------------------------------- panels of the new types
  function panel(f, grid, out) {
    const r = host.regen?.results.get(f.id);
    if (f.type === 'plane') {
      grid.push(...host.field(t('ui.design.type'), host.selectInput(PLANE_MODE_OPTIONS, f.mode, (v) => set(f, t('ui.design.undo.plane_type'), (g) => { g.mode = v; }))));
      if (['offset', 'angle', 'mid'].includes(f.mode)) grid.push(...planeSlot(f, 'planes', 0, f.mode === 'mid' ? t('ui.design.first_plane') : t('ui.design.from_plane')));
      if (f.mode === 'mid') grid.push(...planeSlot(f, 'planes', 1, t('ui.design.second_plane')));
      if (f.mode === 'offset') grid.push(...host.field(t('ui.design.distance_mm'), host.numInput(f.d, (v) => set(f, t('ui.design.undo.distance'), (g) => { g.d = v; }), { key: f.id + '.d' })));
      if (f.mode === 'angle') { grid.push(...dirSlot(f, 'axis', t('ui.design.turn_about'))); grid.push(...host.field(t('ui.design.angle_deg'), host.numInput(f.angle, (v) => set(f, t('ui.design.undo.angle'), (g) => { g.angle = v; }), { key: f.id + '.angle', min: -360, max: 360 }))); }
      if (f.mode === '3pt') for (let i = 0; i < 3; i++) grid.push(...pointSlot(f, 'points', i, t('ui.design.point_n', { n: i + 1 })));
      if (f.mode === 'tangent') { grid.push(...faceSlot(f, 'face', t('ui.design.cylinder'))); grid.push(...pointSlot(f, 'points', 0, t('ui.design.near_point'))); }
      if (f.mode === 'normal') { grid.push(...edgeSlot(f, 'edge', t('ui.design.edge'))); grid.push(...pointSlot(f, 'points', 0, t('ui.design.at_point'))); }
      if (f.mode === 'edgept') { grid.push(...edgeSlot(f, 'edge', t('ui.design.straight_edge'))); grid.push(...dirSlot(f, 'axis', t('ui.design.or_axis'), { allowNull: t('ui.design.none_use_edge') })); grid.push(...pointSlot(f, 'points', 0, t('ui.design.through_point'))); }
      if (f.mode === 'midnormal') { grid.push(...edgeSlot(f, 'edge', t('ui.design.edge'))); grid.push(el('span', { className: 'span pc-muted' }, t('ui.design.between_points'))); grid.push(...pointSlot(f, 'points', 0, t('ui.design.point_n', { n: 1 }))); grid.push(...pointSlot(f, 'points', 1, t('ui.design.point_n', { n: 2 }))); }
      grid.push(host.check(t('ui.design.flip_normal'), f.flip, (v) => set(f, t('ui.design.undo.flip'), (g) => { g.flip = v; })));
      const g = host.regen?.refGeom?.get(f.id);
      if (g) out.push(el('dl', { className: 'pc-dl' }, el('dt', {}, t('ui.design.normal')), el('dd', {}, g.frame.n.map((v) => V.fmt(v, 4)).join(', ')), el('dt', {}, t('ui.design.through')), el('dd', {}, g.center.map((v) => V.fmt(v, 3)).join(', '))));
      out.push(el('div', { className: 'pc-actions' }, host.btn(t('ui.design.sketch_on_it'), () => host.startSketchOn({ kind: 'ref', feature: f.id }), 'pc-btn is-primary', { disabled: r?.status !== 'ok' })));
      out.push(el('p', { className: 'pc-note' }, t('ui.design.plane_note')));
      return true;
    }
    if (f.type === 'axis') {
      grid.push(...host.field(t('ui.design.type'), host.selectInput(AXIS_MODE_OPTIONS, f.mode, (v) => set(f, t('ui.design.undo.axis_type'), (g) => { g.mode = v; }))));
      if (f.mode === '2pt') { grid.push(...pointSlot(f, 'points', 0, t('ui.design.point_n', { n: 1 }))); grid.push(...pointSlot(f, 'points', 1, t('ui.design.point_n', { n: 2 }))); }
      if (f.mode === 'cyl') grid.push(...faceSlot(f, 'face', t('ui.design.face')));
      if (f.mode === 'planes') { grid.push(...planeSlot(f, 'planes', 0, t('ui.design.first_plane'))); grid.push(...planeSlot(f, 'planes', 1, t('ui.design.second_plane'))); }
      if (f.mode === 'edge') grid.push(...edgeSlot(f, 'edge', t('ui.design.edge')));
      if (f.mode === 'normal') { grid.push(...planeSlot(f, 'planes', 0, t('ui.design.face'))); grid.push(...pointSlot(f, 'points', 0, t('ui.design.through_point'))); }
      const g = host.regen?.refGeom?.get(f.id);
      if (g) out.push(el('dl', { className: 'pc-dl' }, el('dt', {}, t('ui.design.direction')), el('dd', {}, g.d.map((v) => V.fmt(v, 4)).join(', ')), el('dt', {}, t('ui.design.through')), el('dd', {}, g.o.map((v) => V.fmt(v, 3)).join(', '))));
      out.push(el('p', { className: 'pc-note' }, t('ui.design.axis_note')));
      return true;
    }
    if (f.type === 'point') {
      grid.push(...host.field(t('ui.design.type'), host.selectInput(POINT_MODE_OPTIONS, f.mode, (v) => set(f, t('ui.design.undo.point_type'), (g) => { g.mode = v; if ((v === 'meet' || v === 'planes3') && !g.planes) g.planes = []; }))));
      if (f.mode === 'xyz') ['X', 'Y', 'Z'].forEach((a, i) => grid.push(...host.field(t('ui.design.coord_mm', { axis: a }), host.numInput(f.p[i], (v) => set(f, t('ui.design.undo.coordinates'), (g) => { g.p = [...g.p]; g.p[i] = v; })))));
      if (f.mode === 'at') grid.push(...pointSlot(f, 'points', 0, t('ui.design.at')));
      if (f.mode === 'center') grid.push(...edgeSlot(f, 'edge', t('ui.design.circle_edge')));
      if (f.mode === 'mid') { grid.push(...edgeSlot(f, 'edge', t('ui.design.edge'))); grid.push(el('span', { className: 'span pc-muted' }, t('ui.design.between_points'))); grid.push(...pointSlot(f, 'points', 0, t('ui.design.point_n', { n: 1 }))); grid.push(...pointSlot(f, 'points', 1, t('ui.design.point_n', { n: 2 }))); }
      if (f.mode === 'meet') {
        grid.push(...edgeSlot(f, 'edge', t('ui.design.edge')));
        grid.push(...dirSlot(f, 'axis', t('ui.design.or_axis'), { allowNull: t('ui.design.none_use_edge') }));
        grid.push(...planeSlot(f, 'planes', 0, t('ui.design.meets_plane')));
        grid.push(...faceSlot(f, 'face', t('ui.design.or_face')));
        grid.push(host.check(t('ui.design.other_crossing'), f.flip, (v) => set(f, t('ui.design.undo.other_crossing'), (g) => { if (v) g.flip = true; else delete g.flip; })));
      }
      if (f.mode === 'planes3') for (let i = 0; i < 3; i++) grid.push(...planeSlot(f, 'planes', i, t(['ui.design.first_plane', 'ui.design.second_plane', 'ui.design.third_plane'][i])));
      const pg = host.regen?.refGeom?.get(f.id);
      if (pg) out.push(el('dl', { className: 'pc-dl' }, el('dt', {}, t('ui.design.at')), el('dd', { dataset: { pointAt: '1' } }, pg.p.map((v) => V.fmt(v, 4)).join(', '))));
      return true;
    }
    if (f.type === 'sweep') {
      grid.push(el('span', { className: 'k' }, t('ui.design.profile')), el('span', { className: 'v' }, nameOf(f.sketch)));
      grid.push(...opSelect(f));
      out.push(el('div', { className: 'pc-props' }, ...grid)); grid.length = 0;
      const sks = before(f).filter((g) => g.type === 'sketch' && g.id !== f.sketch);
      const inPath = new Set(f.path.filter((x) => x.sketch).map((x) => x.sketch));
      const boxes = sks.map((g) => host.check(g.name, inPath.has(g.id), (v) => set(f, t('ui.design.undo.path'), (h) => { h.path = v ? [...h.path, { sketch: g.id }] : h.path.filter((x) => x.sketch !== g.id); })));
      const edges = f.path.map((x, i) => (x.edge ? el('li', {}, el('span', { className: 'grow' }, t('ui.design.edge_item', { name: edgeWords(x.edge) })), host.btn(t('ui.design.remove'), () => set(f, t('ui.design.undo.path'), (h) => { h.path.splice(i, 1); }), 'pc-linkbtn')) : null)).filter(Boolean);
      out.push(el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub', style: 'margin-top:0' }, t('ui.design.sweep.path_title')), el('div', { className: 'pc-checks' }, ...boxes),
        edges.length ? el('ul', { className: 'pc-list' }, ...edges) : null, el('div', { className: 'pc-actions' }, pickBtn(f, 'path', 'pathEdge', undefined, t('ui.design.sweep.pick_edges')))));
      grid.push(...host.field(t('ui.design.orientation'), host.selectInput(ORIENT_OPTIONS, f.orient, (v) => set(f, t('ui.design.orientation'), (g) => { g.orient = v; if (v === 'binormal' && !g.binormal) g.binormal = { kind: 'world', axis: 'z' }; }))));
      if (f.orient === 'binormal') grid.push(...dirSlot(f, 'binormal', t('ui.design.keep_direction')));
      if (f.orient === 'guide') {
        const cur = f.guide?.[0]?.sketch || '';
        grid.push(...host.field(t('ui.design.guide_sketch'), host.selectInput([['', t('ui.design.pick_one')], ...sks.filter((g) => !inPath.has(g.id)).map((g) => [g.id, g.name])], cur, (v) => set(f, t('ui.design.undo.guide'), (g) => { g.guide = v ? [{ sketch: v }] : null; }))));
      }
      grid.push(...host.field(t('ui.design.end_scale'), host.numInput(f.scale, (v) => set(f, t('ui.design.end_scale'), (g) => { g.scale = v; }), { key: f.id + '.scale', min: 0.001, max: 1000 })));
      out.push(el('div', { className: 'pc-props' }, ...grid)); grid.length = 0;
      out.push(el('p', { className: 'pc-note' }, t('ui.design.sweep.note')));
      return true;
    }
    if (f.type === 'loft') {
      grid.push(...opSelect(f));
      grid.push(host.check(t('ui.design.loft.ruled'), f.ruled, (v) => set(f, t('ui.design.undo.ruled'), (g) => { g.ruled = v; })));
      out.push(el('div', { className: 'pc-props' }, ...grid)); grid.length = 0;
      const items = f.sections.map((s, i) => el('li', {},
        el('span', { className: 'grow' }, s.sketch ? t('ui.design.loft.item', { n: i + 1, name: nameOf(s.sketch) }) : s.face ? t('ui.design.loft.item_face', { n: i + 1, face: faceWordsR(s.face) }) : t('ui.design.loft.item_point', { n: i + 1, point: pointWords(s.point) })),
        host.btn(t('ui.design.up'), () => set(f, t('ui.design.undo.section_order'), (g) => { [g.sections[i - 1], g.sections[i]] = [g.sections[i], g.sections[i - 1]]; }), 'pc-linkbtn', { disabled: i === 0 }),
        host.btn(t('ui.design.remove'), () => set(f, t('ui.design.undo.remove_section'), (g) => { g.sections.splice(i, 1); }), 'pc-linkbtn')));
      const used = new Set(f.sections.map((s) => s.sketch));
      const addable = before(f).filter((g) => g.type === 'sketch' && !used.has(g.id));
      const add = host.selectInput([['', t('ui.design.loft.add_sketch')], ...addable.map((g) => [g.id, g.name])], '', (v) => { if (v) set(f, t('ui.design.undo.add_section'), (g) => { g.sections = [...g.sections, { sketch: v }]; }); });
      out.push(el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub', style: 'margin-top:0' }, t('ui.design.loft.sections_title')), items.length ? el('ol', { className: 'pc-list' }, ...items) : el('p', { className: 'pc-muted' }, t('ui.design.loft.no_sections')),
        el('div', { className: 'pc-actions' }, add, pickBtn(f, 'sections', 'loftFace', undefined, t('ui.design.loft.pick_face')))));
      // guide rails (0.4 P6): earlier sketches not used as sections, and model edges
      const rails = f.rails || [], inRails = new Set(rails.filter((x) => x.sketch).map((x) => x.sketch));
      const railBoxes = addable.map((g) => { const c = host.check(g.name, inRails.has(g.id), (v) => set(f, t('loft.rails.undo'), (h) => { const r = (h.rails || []).filter((x) => x.sketch !== g.id); if (v) r.push({ sketch: g.id }); if (r.length) h.rails = r; else delete h.rails; })); c.dataset.loftRail = g.id; return c; });
      const railEdges = rails.map((x, i) => (x.edge ? el('li', {}, el('span', { className: 'grow' }, t('loft.rails.edge', { name: edgeWords(x.edge) })), host.btn(t('loft.rails.remove'), () => set(f, t('loft.rails.undo'), (h) => { h.rails.splice(i, 1); if (!h.rails.length) delete h.rails; }), 'pc-linkbtn')) : null)).filter(Boolean);
      out.push(el('div', { className: 'pc-block', dataset: { loftRails: String(rails.length) } }, el('p', { className: 'pc-props-sub', style: 'margin-top:0' }, t('loft.rails.title')),
        addable.length ? el('div', { className: 'pc-checks' }, ...railBoxes) : null, railEdges.length ? el('ul', { className: 'pc-list' }, ...railEdges) : null,
        el('div', { className: 'pc-actions' }, pickBtn(f, 'rails', 'pathEdge', undefined, t('loft.rails.pick'))),
        el('p', { className: 'pc-note' }, rails.length ? t('loft.rails.note_on') : t('loft.rails.note_off'))));
      const gr = host.regen?.results?.get(f.id)?.gordon;   // surface.js report()
      if (rails.length && gr) out.push(el('p', { className: 'pc-note', dataset: { loftRailDev: String(gr.dev) } }, t('loft.rails.report', { dev: V.fmt(gr.dev, 6), n: gr.guides })));
      out.push(el('p', { className: 'pc-note' }, t('ui.design.loft.note')));
      return true;
    }
    if (f.type === 'draft') {
      grid.push(...host.field(t('ui.design.angle_deg'), host.numInput(f.angle, (v) => set(f, t('ui.design.undo.draft_angle'), (g) => { g.angle = v; }), { key: f.id + '.angle', min: -89, max: 89 })));
      grid.push(...planeSlot(f, 'neutral', undefined, t('ui.design.neutral_plane')));
      grid.push(...dirSlot(f, 'pull', t('ui.design.pull_direction'), { allowNull: t('ui.design.neutral_normal') }));
      out.push(el('div', { className: 'pc-props' }, ...grid)); grid.length = 0;
      out.push(host.refList(f, 'faces'));
      out.push(el('p', { className: 'pc-note' }, t('ui.design.draft.note')));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- extra rows of the older features
  function extra(f, grid) {
    if (f.type === 'extrude') {
      if (f.end === 'upto' || f.end === 'offset') grid.push(...planeSlot(f, 'upto', undefined, t('ui.design.up_to')));
      if (f.end === 'offset') grid.push(...host.field(t('ui.design.offset_mm'), host.numInput(f.offset ?? 0, (v) => set(f, t('ui.design.undo.offset'), (g) => { g.offset = v; }), { key: f.id + '.offset' })));
      if (f.end === 'vertex') grid.push(...pointSlot(f, 'vertex', undefined, t('ui.design.up_to_vertex')));
      if (f.end === 'next') grid.push(el('span', { className: 'span pc-muted' }, t('ui.design.next_note')));
      if (f.end === 'blind') {
        grid.push(host.check(t('ui.design.second_direction'), f.two, (v) => set(f, t('ui.design.second_direction'), (g) => { if (v) { g.two = true; g.depth2 = g.depth2 || 10; } else delete g.two; })));
        if (f.two) grid.push(...host.field(t('ui.design.second_depth_mm'), host.numInput(f.depth2 ?? 10, (v) => set(f, t('ui.design.undo.second_depth'), (g) => { g.depth2 = v; }), { key: f.id + '.depth2', min: 0.000001 })));
      }
      if (f.end !== 'mid' && !f.two) grid.push(...host.field(t('ui.design.taper_deg'), host.numInput(f.taper ?? 0, (v) => set(f, t('ui.design.undo.taper'), (g) => { if (v) g.taper = v; else delete g.taper; }), { key: f.id + '.taper', min: -89, max: 89 })));
      const n = f.regions?.length || 0;
      grid.push(...row(t('ui.design.regions'), el('span', { className: 'grow' }, n ? t('ui.design.regions_picked', { n }) : t('ui.design.every_loop')), pickBtn(f, 'regions', 'region', undefined, t('ui.design.pick_regions')),
        n ? host.btn(t('ui.design.all'), () => set(f, t('ui.design.regions'), (g) => { delete g.regions; }), 'pc-btn') : null));
      return;
    }
    if (f.type === 'hole') {
      if (f.kind === 'csink') {
        grid.push(...host.field(t('ui.design.csink_d'), host.numInput(f.csinkD ?? 12, (v) => set(f, t('ui.design.undo.csink_d'), (g) => { g.csinkD = v; }), { key: f.id + '.csinkD', min: 0.000001 })));
        grid.push(...host.field(t('ui.design.csink_angle'), host.selectInput([['90', t('ui.design.csink_90')], ['82', t('ui.design.csink_82')]], String(f.csinkAngle ?? 90), (v) => set(f, t('ui.design.csink_angle'), (g) => { g.csinkAngle = Number(v); }))));
      }
      if (f.kind === 'tapped') {
        grid.push(...host.field(t('ui.design.thread'), host.selectInput(Object.entries(ISO_COARSE).map(([k, [, p, d]]) => [k, t('ui.design.thread_option', { size: k, pitch: p, drill: d })]), f.size || 'M6', (v) => set(f, t('ui.design.undo.thread_size'), (g) => { g.size = v; }))));
        if (!f.through) grid.push(...host.field(t('ui.design.thread_depth_mm'), host.numInput(f.threadDepth ?? f.depth, (v) => set(f, t('ui.design.undo.thread_depth'), (g) => { g.threadDepth = v; }), { key: f.id + '.threadDepth', min: 0.000001 })));
        grid.push(el('span', { className: 'span pc-muted' }, t('ui.design.tapped_note', { callout: threadCallout({ ...f, size: f.size || 'M6' }, f.depth), source: THREAD_SOURCE })));
      }
      return;
    }
    if (f.type === 'chamfer') {
      grid.push(...host.field(t('ui.design.type'), host.selectInput([['equal', t('ui.design.chamfer.equal')], ['two', t('ui.design.chamfer.two')], ['angle', t('ui.design.chamfer.angle')]], f.mode || 'equal', (v) => set(f, t('ui.design.undo.chamfer_type'), (g) => { if (v === 'equal') { delete g.mode; delete g.d2; delete g.angle; delete g.flip; } else { g.mode = v; g.d2 = g.d2 ?? g.d * 2; g.angle = g.angle ?? 45; g.flip = !!g.flip; } }))));
      if (f.mode === 'two') grid.push(...host.field(t('ui.design.second_distance'), host.numInput(f.d2, (v) => set(f, t('ui.design.second_distance'), (g) => { g.d2 = v; }), { key: f.id + '.d2', min: 0.000001 })));
      if (f.mode === 'angle') grid.push(...host.field(t('ui.design.angle_deg'), host.numInput(f.angle, (v) => set(f, t('ui.design.undo.chamfer_angle'), (g) => { g.angle = v; }), { key: f.id + '.angle', min: 0.001, max: 89.999 })));
      if (f.mode && f.mode !== 'equal') grid.push(host.check(t('ui.design.chamfer.flip'), f.flip, (v) => set(f, t('ui.design.undo.flip'), (g) => { g.flip = v; })));
      return;
    }
    if (f.type === 'fillet') {
      grid.push(host.check(t('ui.design.fillet.variable'), typeof f.r2 === 'number', (v) => set(f, t('ui.design.undo.variable_radius'), (g) => { if (v) { g.r2 = g.r * 2; g.flip = false; } else { delete g.r2; delete g.flip; } })));
      if (typeof f.r2 === 'number') {
        grid.push(...host.field(t('ui.design.end_radius_mm'), host.numInput(f.r2, (v) => set(f, t('ui.design.undo.end_radius'), (g) => { g.r2 = v; }), { key: f.id + '.r2', min: 0.000001 })));
        grid.push(host.check(t('ui.design.fillet.swap'), f.flip, (v) => set(f, t('ui.design.undo.swap_ends'), (g) => { g.flip = v; })));
      }
    }
  }

  // ---------------------------------------------------------------- the view
  function refsForView(selId, size) {
    const regen = host.regen;
    const out = [], lines = [];
    if (!regen?.refGeom) return { refs: out, lines };
    const s = Math.max(5, size * 0.45);
    for (const [id, g] of regen.refGeom) {
      const f = P.featureById(host.part, id);
      if (!f || host.regen.results.get(id)?.status !== 'ok') continue;
      const selected = id === selId;
      if (g.kind === 'plane') out.push({ id, kind: 'plane', corners: planeQuad(g, s), selected });
      else if (g.kind === 'axis') out.push({ id, kind: 'axis', a: V.add(g.o, V.mul(g.d, -s * 1.4)), b: V.add(g.o, V.mul(g.d, s * 1.4)), selected });
      else out.push({ id, kind: 'point', p: g.p, selected });
    }
    // cosmetic threads: the major diameter, dashed, at the top and the thread's end
    for (const [, t] of regen.threads || []) for (const th of t.list) {
      const fr = V.frameFor(th.d, th.o);
      for (const z of [0, th.depth]) {
        const c = V.add(th.o, V.mul(th.d, z));
        const pts = [];
        for (let k = 0; k <= 48; k++) { const a = k / 48 * 2 * Math.PI; pts.push(V.add(c, V.add(V.mul(fr.x, th.r * Math.cos(a)), V.mul(fr.y, th.r * Math.sin(a))))); }
        lines.push({ pts, dashed: true });
      }
    }
    // a region-picking extrude: its sketch and the picked points
    const f = slot?.kind === 'region' ? P.featureById(host.part, slot.id) : null;
    if (f) {
      const fr = regen.frames.get(f.sketch);
      if (fr) for (const q of f.regions || []) { const p = V.toWorld(fr, q[0], q[1]); const d = size * 0.02; lines.push({ pts: [V.toWorld(fr, q[0] - d, q[1]), V.toWorld(fr, q[0] + d, q[1])] }, { pts: [V.toWorld(fr, q[0], q[1] - d), V.toWorld(fr, q[0], q[1] + d)] }); void p; }
    }
    return { refs: out, lines, regionSketch: f?.sketch || null };
  }

  // ---------------------------------------------------------------- new features from the selection
  function create(type) {
    const part = host.part, regen = host.regen, pick = host.pick, sel = host.sel;
    const selF = sel?.kind === 'feature' ? P.featureById(part, sel.id) : null;
    const size = regen?.stats ? Math.max(...regen.stats.bbox.max.map((v, i) => v - regen.stats.bbox.min[i])) : 100;
    let props = {};
    if (type === 'plane') {
      let base = { kind: 'base', name: 'top' };
      if (pick?.kind === 'face' && pick.flat && pick.ref) base = pick.ref;
      else if (sel?.kind === 'plane') base = { kind: 'base', name: sel.name };
      else if (selF?.type === 'plane') base = { kind: 'ref', feature: selF.id };
      props = { mode: 'offset', planes: [base], d: +(Math.round(size * 0.2) || 10) };
    } else if (type === 'axis') {
      const e = pick?.kind === 'edge' && pick.info ? pick.info : null;
      if (e && (e.type === 'line' || e.type === 'circle')) props = { mode: 'edge', edge: edgeRef(e) };
      else if (pick?.kind === 'face' && pick.info?.name && ['cylinder', 'cone'].includes(pick.info.type)) props = { mode: 'cyl', face: faceRef(pick.info) };
    } else if (type === 'point') {
      if (pick?.kind === 'edge' && pick.info) props = { mode: 'at', points: [{ kind: 'vertex', edge: edgeRef(pick.info), p: pick.info.a }] };
    } else if (type === 'sweep') {
      if (!host.useExact) { host.status(exactWhy(t('kernel.what.sweep'), t('ui.design.exact.sweep'))); return null; }
      const sketches = part.features.slice(0, P.builtCount(part)).filter((g) => g.type === 'sketch' && regen?.results.get(g.id)?.status === 'ok');
      const profile = selF?.type === 'sketch' ? selF : sketches.filter((g) => S.profile(g.sketch).loops?.length).at(-1);
      if (!profile) { host.status(t('ui.design.sweep.no_profile')); return null; }
      const pathSk = sketches.filter((g) => g.id !== profile.id && g.sketch.entities.some((e) => e.type !== 'point')).at(-1);
      const edges = host.multi.filter((m) => m.kind === 'edge').map((m) => ({ edge: m.ref }));
      props = { sketch: profile.id, path: edges.length ? edges : pathSk ? [{ sketch: pathSk.id }] : [] };
    } else if (type === 'loft') {
      if (!host.useExact) { host.status(exactWhy(t('kernel.what.loft'), t('ui.design.exact.loft'))); return null; }
      const used = new Set(part.features.filter((g) => typeof g.sketch === 'string').map((g) => g.sketch));
      const sks = part.features.slice(0, P.builtCount(part)).filter((g) => g.type === 'sketch' && !used.has(g.id) && regen?.results.get(g.id)?.status === 'ok' && S.profile(g.sketch).loops?.length === 1);
      props = { sections: sks.map((g) => ({ sketch: g.id })) };
    } else if (type === 'draft') {
      const faces = [...host.multi, ...(pick && !host.multi.length ? [pick] : [])].filter((m) => m.kind === 'face' && m.info?.name).map((m) => faceRef(m.info));
      props = { faces };
    }
    return props;
  }

  return {
    panel, extra, onPick, refsForView, create, cancel,
    get slot() { return slot; },
    clearIfGone() { if (slot && !P.featureById(host.part, slot.id)) slot = null; },
    isRef: (f) => REF_TYPES.has(f.type),
    findFace, findEdge,
  };
}
