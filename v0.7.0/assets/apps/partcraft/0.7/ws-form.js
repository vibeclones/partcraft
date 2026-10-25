/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ws-form.js — the Form workspace (freeform surfacing, like a T-spline "Form"): push and pull a control cage
 * whose Catmull–Clark limit surface is the shape, then Finish turns it into a `form` feature of the part history
 * (surface.js / form-brep.js build it as exact B-spline patches). DOM-free at the top level; the page is reached
 * only through `host` inside the hooks.
 *
 * State: the cage being edited is the part's study `form` = { cage (form.js), editing: feature id | null } — so
 * every edit is one undo step of the part history (Ctrl+Z works) and an unfinished form is saved with the part.
 * Viewer state (selection, gizmo mode, display, analysis) lives here.
 * Overlays: form-surface (limit surface or the cage's faces), form-cage (edges; creases in the pick colour),
 * form-verts, form-sel (picked edges and faces), form-gizmo (three's TransformControls), form-dots (face clicks).
 * Picking: nearest cage vertex within 9 px, else nearest edge within 7 px, else the face under the pointer
 * (screen-space, own raycast); Shift adds or drops.
 */
import { registerWorkspace } from './workspaces.js';
import { registerStudyReader } from './part.js';
import * as FM from './form.js';
import { curvature, zebra } from './surface.js';
import { describeReport } from './form-brep.js';
import { exactWhy } from './exact-client.js';
import { t } from './i18n.js';

registerStudyReader('form', (raw, { ids }) => {
  if (!raw || typeof raw !== 'object') throw new Error(t('form.file.study_bad'));
  const cage = FM.readForm(raw.cage);
  return { cage, editing: typeof raw.editing === 'string' && ids.has(raw.editing) ? raw.editing : null };
});

const S = {
  sel: { verts: [], edges: [], faces: [] }, mode: 'translate', soft: 0, display: 'smooth', analysis: 'none', size: 100, divs: 2,
  dist: 20, crease: FM.SHARP, drawn: '', tc: null, pivot: null, drag: null, check: null, faceDots: null, onCam: null, host: null,
};
const PRIMS = {
  box: () => FM.box(S.divs, S.divs, S.divs, S.size, S.size, S.size),
  sphere: () => FM.sphere(Math.max(1, S.divs), S.size / 2),
  plane: () => FM.plane(S.divs, S.divs, S.size, S.size),
  cylinder: () => FM.cylinder(Math.max(6, 4 * S.divs), Math.max(1, S.divs), S.size / 2, S.size),
  torus: () => FM.torusFitted(Math.max(6, 4 * S.divs), Math.max(4, 3 * S.divs), S.size * 0.35, S.size * 0.15),
};
const primWord = (kind) => t('form.prim.' + kind);   // looked up on use, never at import

const st = (host) => host.study('form') || null;
const cageOf = (host) => st(host)?.cage || null;
const clearSel = () => { S.sel = { verts: [], edges: [], faces: [] }; };
const selCount = () => S.sel.verts.length + S.sel.edges.length + S.sel.faces.length;
const level = (cage) => (cage.faces.length <= 60 ? 3 : cage.faces.length <= 500 ? 2 : 1);

/** Save a new cage as one undo step (keeps `editing`). */
function save(host, cage, label) {
  const cur = st(host);
  host.setStudy('form', { cage, editing: cur?.editing ?? null }, label);
}
/** Run a pure edit on the selection; a refusal becomes a status message. */
function edit(host, label, fn, { keepSel = false } = {}) {
  const cage = cageOf(host);
  if (!cage) { host.status(t('form.start_first')); return; }
  let next;
  try { next = fn(cage); } catch (e) { host.status(t('form.status.failed', { label, msg: e.message })); return; }
  if (!keepSel) clearSel();
  save(host, next, label);
  host.status(t('form.status.done', { label }));
}

// ---------------------------------------------------------------- drawing

function draw(host, force = false, preview = null) {
  const cage = preview || cageOf(host);
  const key = cage ? JSON.stringify(cage) + S.display + S.analysis + JSON.stringify(S.sel) : '';
  if (!force && key === S.drawn) return;
  S.drawn = key;
  const { view, THREE } = host;
  if (!cage) { for (const id of ['form-surface', 'form-cage', 'form-verts', 'form-sel']) view.setOverlay(id, null); placeGizmo(host); return; }
  const tk = host.tokens();
  // surface
  let geo;
  const faceOfTri = [];
  if (S.display === 'smooth') {
    const lm = FM.limitMesh(cage, level(cage));
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(lm.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(lm.indices, 1));
    geo.computeVertexNormals();
    faceOfTri.push(...lm.triFace);
    if (S.analysis !== 'none') colorize(host, geo, lm);
  } else {
    const pos = [];
    cage.faces.forEach((f, fi) => { for (let k = 1; k < f.length - 1; k++) { for (const v of [f[0], f[k], f[k + 1]]) pos.push(...cage.verts[v]); faceOfTri.push(fi); } });
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.computeVertexNormals();
  }
  const mat = new THREE.MeshStandardMaterial({ color: S.analysis === 'none' ? (view.dark ? '#9aa6b4' : '#c3cbd5') : '#ffffff', vertexColors: S.analysis !== 'none' && S.display === 'smooth', roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide, flatShading: S.display === 'box', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.faceOfTri = faceOfTri;
  view.setOverlay('form-surface', mesh);
  // cage edges (creases in the pick colour)
  const edges = FM.cageEdges(cage);
  const lp = [], lc = [];
  const ink = new THREE.Color(view.dark ? '#e6ebf0' : '#1d232b'), cr = new THREE.Color(tk.sel);
  for (const e of edges) { lp.push(...cage.verts[e.a], ...cage.verts[e.b]); const c = e.w > 0 ? cr : ink; lc.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: S.display === 'box' }));
  lines.renderOrder = 2;
  view.setOverlay('form-cage', lines);
  // vertices
  const sv = new Set(FM.selVerts(cage, { verts: S.sel.verts })), corners = new Set(cage.corners || []);
  const vp = [], vc = [];
  const cs = new THREE.Color(tk.sel), cc = new THREE.Color(tk.under);
  cage.verts.forEach((p, i) => { vp.push(...p); const c = sv.has(i) ? cs : corners.has(i) ? cc : ink; vc.push(c.r, c.g, c.b); });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
  pg.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
  const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }));
  pts.renderOrder = 3;
  view.setOverlay('form-verts', pts);
  // selection: picked edges as lines on top, picked faces tinted
  const g = new THREE.Group();
  if (S.sel.edges.length) {
    const ep = [];
    for (const k of S.sel.edges) { const [a, b] = k.split(',').map(Number); if (cage.verts[a] && cage.verts[b]) ep.push(...cage.verts[a], ...cage.verts[b]); }
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    const l = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: tk.sel, depthTest: false })); l.renderOrder = 4; g.add(l);
  }
  if (S.sel.faces.length) {
    const fp = [];
    for (const fi of S.sel.faces) { const f = cage.faces[fi]; if (!f) continue; for (let k = 1; k < f.length - 1; k++) for (const v of [f[0], f[k], f[k + 1]]) fp.push(...cage.verts[v]); }
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    const m = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: tk.sel, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false })); m.renderOrder = 4; g.add(m);
  }
  view.setOverlay('form-sel', g);
  placeGizmo(host);
}

/** Vertex colours of the limit mesh: zebra stripes (from the current view direction) or mean curvature. */
function colorize(host, geo, lm) {
  const { THREE, view } = host;
  const n = lm.positions.length / 3;
  const col = new Float32Array(n * 3);
  if (S.analysis === 'zebra') {
    const nr = geo.getAttribute('normal');
    const d = new THREE.Vector3(); view.camera.getWorldDirection(d);
    for (let i = 0; i < n; i++) { const z = zebra([nr.getX(i), nr.getY(i), nr.getZ(i)], [d.x, d.y, d.z], 16); const c = z ? 0.97 : 0.08; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c; }
  } else {
    const { mean } = curvature(lm);
    const abs = [...mean].map(Math.abs).sort((a, b) => a - b);
    const lim = abs[Math.floor(abs.length * 0.95)] || 1;
    for (let i = 0; i < n; i++) {
      const t = Math.max(-1, Math.min(1, mean[i] / lim));
      // diverging: blue (concave) — white (flat) — red (convex)
      const r = t > 0 ? 1 : 1 + t, b = t < 0 ? 1 : 1 - t, gg = 1 - Math.abs(t) * 0.75;
      col[i * 3] = r * (t < 0 ? 0.35 + 0.65 * (1 + t) : 1); col[i * 3 + 1] = gg; col[i * 3 + 2] = b * (t > 0 ? 0.35 + 0.65 * (1 - t) : 1);
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// ---------------------------------------------------------------- gizmo (three's TransformControls)

function placeGizmo(host) {
  const tc = S.tc, cage = cageOf(host);
  if (!tc || S.drag) return;
  if (!cage || !selCount()) { tc.detach(); tc.getHelper().visible = false; host.view.render(); return; }
  const c = FM.selCenter(cage, S.sel);
  S.pivot.position.set(c[0], c[1], c[2]); S.pivot.rotation.set(0, 0, 0); S.pivot.scale.set(1, 1, 1); S.pivot.updateMatrixWorld(true);
  tc.attach(S.pivot); tc.setMode(S.mode); tc.getHelper().visible = true;
  host.view.render();
}

async function makeGizmo(host) {
  const { TransformControls } = await import('three/addons/controls/TransformControls.js');
  if (S.host !== host || S.tc) return;
  const { view, THREE } = host;
  const tc = new TransformControls(view.camera, view.canvas);
  tc.setSize(0.8);
  S.pivot = new THREE.Object3D();
  view.setOverlay('form-pivot', S.pivot);
  view.setOverlay('form-gizmo', tc.getHelper());
  tc.addEventListener('change', () => view.render());
  tc.addEventListener('dragging-changed', (e) => {
    view.controls.enabled = !e.value;
    const cage = cageOf(host);
    if (e.value && cage) { S.pivot.updateMatrixWorld(true); S.drag = { cage, inv: S.pivot.matrixWorld.clone().invert(), last: cage }; return; }
    if (!e.value && S.drag) {
      const d = S.drag; S.drag = null;
      if (d.last !== d.cage) save(host, d.last, t({ translate: 'form.undo.move_cage', rotate: 'form.undo.rotate_cage', scale: 'form.undo.scale_cage' }[S.mode]));
    }
  });
  tc.addEventListener('objectChange', () => {
    if (!S.drag) return;
    S.pivot.updateMatrixWorld(true);
    const M = S.pivot.matrixWorld.clone().multiply(S.drag.inv);
    S.drag.last = FM.transform(S.drag.cage, S.sel, M.elements, { soft: S.soft });
    previewCage(host, S.drag.last);
  });
  S.tc = tc;
  placeGizmo(host);
}
/** Draw a cage that is not saved yet (during a drag). */
function previewCage(host, cage) { draw(host, true, cage); S.drawn = ''; }

// ---------------------------------------------------------------- picking

function project(host, p) {
  const { view, THREE } = host;
  const r = view.canvas.getBoundingClientRect();
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(view.camera);
  return [(v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top];
}
function pickCage(host, x, y) {
  const cage = cageOf(host);
  if (!cage) return null;
  const sp = cage.verts.map((p) => project(host, p));
  // the surface under the pointer hides the cage behind it: only vertices and edges in front of that hit count
  const surf = host.view.overlays.get('form-surface');
  const ray = host.view.ray(x, y);
  const hit = surf && ray.intersectObject(surf, false)[0];
  let size = 0; for (const p of cage.verts) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const o = ray.ray.origin, dr = ray.ray.direction;
  const depth = (p) => (p[0] - o.x) * dr.x + (p[1] - o.y) * dr.y + (p[2] - o.z) * dr.z;
  const front = (p) => !hit || depth(p) <= hit.distance + 0.02 * Math.max(1, size);
  let bv = -1, bd = 9;
  sp.forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd && front(cage.verts[i])) { bd = d; bv = i; } });
  if (bv >= 0) return { kind: 'vert', id: bv };
  let be = null, ed = 7;
  for (const e of FM.cageEdges(cage)) {
    const a = sp[e.a], b = sp[e.b];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
    const d = Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
    const pa = cage.verts[e.a], pb = cage.verts[e.b];
    if (d < ed && front([0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * t))) { ed = d; be = e.key; }
  }
  if (be) return { kind: 'edge', id: be };
  if (hit) return { kind: 'face', id: surf.userData.faceOfTri[hit.faceIndex] };
  return null;
}
function toggle(list, id, add) {
  const i = list.indexOf(id);
  if (!add) return [id];
  if (i >= 0) return list.filter((x) => x !== id);
  return [...list, id];
}

// ---------------------------------------------------------------- faces by clicks

function faceClick(host, x, y) {
  const { THREE, view } = host;
  const cage = cageOf(host) || FM.emptyForm();
  let p = null;
  cage.verts.forEach((q) => { const s = project(host, q); if (!p && Math.hypot(s[0] - x, s[1] - y) < 9) p = [...q]; });
  if (!p) {
    const ray = view.ray(x, y).ray;
    const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!hit) { host.status(t('form.face.click_ground')); return; }
    p = hit.toArray().map((v) => Math.round(v * 1000) / 1000);
  }
  S.faceDots.push(p);
  drawDots(host);
  if (S.faceDots.length === 4) finishFace(host);
  else host.status(t('form.face.point', { n: S.faceDots.length }), true);
}
function drawDots(host) {
  const { THREE, view } = host;
  if (!S.faceDots || !S.faceDots.length) { view.setOverlay('form-dots', null); return; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(S.faceDots.flat(), 3));
  const grp = new THREE.Group();
  grp.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: host.tokens().sel, depthTest: false })));
  grp.add(new THREE.Line(g.clone(), new THREE.LineBasicMaterial({ color: host.tokens().sel, depthTest: false })));
  view.setOverlay('form-dots', grp);
}
function finishFace(host) {
  const pts = S.faceDots;
  S.faceDots = [];
  drawDots(host);
  const cage = cageOf(host) || FM.emptyForm();
  try { const next = FM.addFace(cage, pts, { tol: 1e-6 * Math.max(1, S.size) }); save(host, next, t('form.undo.add_face')); host.status(t('form.face.added'), true); }
  catch (e) { host.status(t('form.face.error', { msg: e.message })); }
}

// ---------------------------------------------------------------- commands

function startPrim(host, kind, ask = true) {
  const go = () => { clearSel(); host.setStudy('form', { cage: PRIMS[kind](), editing: st(host)?.editing ?? null }, t('form.undo.new_prim', { prim: primWord(kind).toLowerCase() })); host.status(t('form.prim.started', { prim: primWord(kind) })); };
  if (!cageOf(host) || !ask) { go(); return; }
  host.confirm(t('form.replace.title'), t('form.replace.body', { prim: primWord(kind).toLowerCase() }), t('form.replace.btn')).then((y) => { if (y) go(); });
}

function extrude(host) {
  if (S.sel.faces.length) return edit(host, t('form.act.extrude'), (c) => FM.extrudeFaces(c, S.sel.faces, S.dist));
  if (S.sel.edges.length) {
    return edit(host, t('form.undo.extrude_edges'), (c) => {
      const topo = FM.topo(FM.meshOf(c));
      let d = [0, 0, 0];
      for (const k of S.sel.edges) {
        const e = topo.E.get(k); if (!e || e.f.length !== 1) throw new Error(t('form.err.extrude_open'));
        const f = c.faces[e.f[0]]; const cen = f.reduce((s, v) => s.map((x, i) => x + c.verts[v][i] / f.length), [0, 0, 0]);
        const mid = [0, 1, 2].map((i) => (c.verts[e.a][i] + c.verts[e.b][i]) / 2);
        d = d.map((x, i) => x + mid[i] - cen[i]);
      }
      const l = Math.hypot(...d) || 1;
      return FM.extrudeEdges(c, S.sel.edges, d.map((x) => x / l * S.dist));
    });
  }
  host.status(t('form.extrude.pick'));
}

function finish(host) {
  const s = st(host);
  if (!s) { host.status(t('form.finish.none')); return; }
  let id = s.editing;
  host.commit(t('form.finish'), () => {
    const P = host.P;
    const f = id && P.featureById(host.part, id);
    if (f && f.type === 'form') f.cage = s.cage;
    else { const g = P.addFeature(host.part, 'form', { cage: s.cage, op: 'new' }); id = g.id; }
    P.setStudy(host.part, 'form', null);
  });
  clearSel();
  const f = host.P.featureById(host.part, id);
  window.partcraft?.setWorkspace?.('design');
  host.built().then(() => {
    const r = host.regen?.results.get(id);
    host.status(r?.status === 'error' ? t('form.finish.error', { name: f?.name, msg: r.message }) : r?.form ? t('form.finish.done_report', { name: f?.name, report: describeReport(r.form) }) : t('form.finish.done', { name: f?.name }));
  });
}

function command(cmd, host) {
  if (cmd === 'undo' || cmd === 'redo') { clearSel(); return false; }
  if (!cmd.startsWith('form-')) return false;
  const c = cmd.slice(5);
  if (PRIMS[c]) { startPrim(host, c); return true; }
  switch (c) {
    case 'face': S.faceDots = []; host.status(t('form.face.start'), true); host.focusStage(); return true;
    case 'edit': {
      const order = ['translate', 'rotate', 'scale'];
      S.mode = order[(order.indexOf(S.mode) + 1) % 3];
      placeGizmo(host); host.renderPanel();
      host.status(t({ translate: 'form.gizmo.move', rotate: 'form.gizmo.rotate', scale: 'form.gizmo.scale' }[S.mode]));
      return true;
    }
    case 'extrude': extrude(host); return true;
    case 'loop':
      if (!S.sel.edges.length) { host.status(t('form.loop.pick')); return true; }
      edit(host, t('form.act.loop'), (cg) => FM.insertEdgeLoop(cg, S.sel.edges[0], 0.5)); return true;
    case 'crease':
      if (!S.sel.edges.length) { host.status(t('form.crease.pick')); return true; }
      edit(host, t('form.act.crease'), (cg) => FM.crease(cg, S.sel.edges, S.crease), { keepSel: true }); return true;
    case 'display': S.display = S.display === 'smooth' ? 'box' : 'smooth'; draw(host, true); host.renderPanel(); host.status(S.display === 'box' ? t('form.display.box') : t('form.display.smooth')); return true;
    case 'finish': finish(host); return true;
  }
  return false;
}

function toolState(cmd, host) {
  const cage = cageOf(host);
  const c = cmd.slice(5);
  if (PRIMS[c] || c === 'face') return { ok: true };
  if (!cage) return { ok: false, why: t('form.start_first2') };
  if (c === 'extrude' && !S.sel.faces.length && !S.sel.edges.length) return { ok: false, why: t('form.pick.faces_edges') };
  if ((c === 'loop' || c === 'crease') && !S.sel.edges.length) return { ok: false, why: t('form.pick.edge') };
  return { ok: true };
}

// ---------------------------------------------------------------- panel

function renderPanel(host, box) {
  const { el } = host;
  const s = st(host);
  const cage = s?.cage;
  const btn = (label, fn, cls = 'pc-btn', data = {}) => el('button', { type: 'button', className: cls, onclick: fn, dataset: data }, label);
  const num = (label, value, onchange, opts = {}) => {
    const i = el('input', { type: 'number', className: 'pc-input', value: String(value), step: opts.step || 'any', min: opts.min ?? '', max: opts.max ?? '', dataset: opts.data || {} });
    i.addEventListener('change', () => { const v = Number(i.value); if (!Number.isFinite(v) || (opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) { host.status(opts.min !== undefined && opts.max !== undefined ? t('mfg.num.range', { min: opts.min, max: opts.max }) : opts.min !== undefined ? t('mfg.num.from', { min: opts.min }) : opts.max !== undefined ? t('mfg.num.to', { max: opts.max }) : t('mfg.num.any')); i.value = String(value); return; } onchange(v); });
    return [el('label', {}, label), i];
  };
  const sel = (label, options, value, onchange, data = {}) => {
    const x = el('select', { className: 'pc-select', dataset: data }, ...options.map(([v, l]) => el('option', { value: v, selected: v === value }, l)));
    x.addEventListener('change', () => onchange(x.value));
    return [el('label', {}, label), x];
  };
  const forms = host.part.features.filter((f) => f.type === 'form');
  if (!cage) {
    box.append(
      el('p', { className: 'pc-note' }, t('form.intro')),
      el('div', { className: 'pc-props' }, ...num(t('form.size'), S.size, (v) => { S.size = v; }, { min: 0.01, max: 1e5, data: { formSize: '' } }), ...num(t('form.divs'), S.divs, (v) => { S.divs = Math.round(v); }, { min: 1, max: 8, step: 1 })),
      el('div', { className: 'pc-actions' }, ...Object.keys(PRIMS).map((k) => btn(primWord(k), () => startPrim(host, k, false), 'pc-btn', { prim: k })), btn(t('form.faces_by_clicks'), () => command('form-face', host))),
    );
    if (forms.length) box.append(el('h3', { className: 'pc-h3' }, t('form.in_part')), el('div', { className: 'pc-actions' }, ...forms.map((f) => btn(t('form.edit_feature', { name: f.name }), () => editFeature(f.id, host), 'pc-btn', { editForm: f.id }))));
    draw(host);
    host.view.setPartVisible(true);
    return t('form.ws.label');
  }
  const stx = FM.formStats(cage);
  const dl = el('dl', { className: 'pc-dl' });
  const row = (k, v) => dl.append(el('dt', {}, k), el('dd', {}, v));
  row(t('form.row.editing'), s.editing ? (host.P.featureById(host.part, s.editing)?.name || t('form.row.a_feature')) : t('form.row.new'));
  row(t('form.row.cage'), t(stx.closed ? (stx.nonQuads ? 'form.cage.closed_nq' : 'form.cage.closed') : (stx.nonQuads ? 'form.cage.open_nq' : 'form.cage.open'), { verts: stx.verts, faces: stx.faces, nq: stx.nonQuads, open: stx.boundary }));
  row(t('form.row.extraordinary'), String(stx.extraordinary));
  row(t('form.row.picked'), selCount() ? ['verts', 'edges', 'faces'].filter((k) => S.sel[k].length).map((k) => t('form.count.' + k, { n: S.sel[k].length })).join(', ') : t('form.row.nothing'));
  box.append(dl);
  // gizmo
  box.append(el('div', { className: 'pc-actions', role: 'group', 'aria-label': t('form.gizmo') },
    ...[['translate', t('form.gizmo.btn.move')], ['rotate', t('form.gizmo.btn.rotate')], ['scale', t('form.gizmo.btn.scale')]].map(([m, l]) => btn(l, () => { S.mode = m; placeGizmo(host); host.renderPanel(); }, S.mode === m ? 'pc-btn is-primary' : 'pc-btn', { gizmo: m }))));
  box.append(el('div', { className: 'pc-props' },
    ...num(t('form.soft'), S.soft, (v) => { S.soft = v; }, { min: 0, max: 1e5, data: { soft: '' } }),
    ...num(t('form.dist'), S.dist, (v) => { S.dist = v; }, { min: -1e5, max: 1e5, data: { dist: '' } }),
    ...num(t('form.crease_weight'), S.crease, (v) => { S.crease = v; }, { min: 0.1, max: FM.SHARP, data: { weight: '' } }),
    el('span', { className: 'span pc-muted' }, t('form.crease_note', { max: FM.SHARP }))));
  const T = (label, fn, data) => btn(label, fn, 'pc-btn', { formAct: data });
  const run = (label, fn, o) => () => edit(host, label, fn, o);
  const one = (kind, n, what, fn) => () => { if (S.sel[kind].length < n) { host.status(n > 1 ? t('form.pick_n.' + kind, { what, n }) : t('form.pick_one.' + kind, { what })); return; } fn(); };
  box.append(el('h3', { className: 'pc-h3' }, t('form.modify')), el('div', { className: 'pc-actions pc-wrap' },
    T(t('form.act.extrude'), () => extrude(host), 'extrude'),
    T(t('form.act.loop'), one('edges', 1, t('form.act.loop'), run(t('form.act.loop'), (c) => FM.insertEdgeLoop(c, S.sel.edges[0], 0.5))), 'loop'),
    T(t('form.act.point'), one('edges', 1, t('form.act.point'), run(t('form.act.point'), (c) => FM.insertPoint(c, S.sel.edges[0], 0.5))), 'point'),
    T(t('form.act.subdivide'), one('faces', 1, t('form.act.subdivide'), run(t('form.act.subdivide'), (c) => FM.subdivideFaces(c, S.sel.faces))), 'subdivide'),
    T(t('form.act.bridge'), () => {
      if (S.sel.faces.length === 2) return edit(host, t('form.act.bridge'), (c) => FM.bridge(c, { face: S.sel.faces[0] }, { face: S.sel.faces[1] }));
      if (S.sel.edges.length === 2) return edit(host, t('form.act.bridge'), (c) => FM.bridge(c, { edge: S.sel.edges[0] }, { edge: S.sel.edges[1] }));
      host.status(t('form.bridge.pick'));
    }, 'bridge'),
    T(t('form.act.fill'), one('edges', 1, t('form.act.fill'), run(t('form.act.fill'), (c) => FM.fillHole(c, S.sel.edges[0]))), 'fill'),
    T(t('form.act.weld'), () => { const vs = S.sel.verts; if (vs.length < 2) { host.status(t('form.weld.pick')); return; } edit(host, t('form.act.weld'), (c) => FM.weld(c, vs)); }, 'weld'),
    T(t('form.act.flatten'), () => edit(host, t('form.act.flatten'), (c) => FM.flatten(c, S.sel), { keepSel: true }), 'flatten'),
    T(t('form.act.delete'), () => {
      if (S.sel.faces.length) return edit(host, t('form.undo.del_faces'), (c) => FM.deleteFaces(c, S.sel.faces));
      if (S.sel.edges.length) return edit(host, t('form.undo.del_edges'), (c) => FM.deleteEdges(c, S.sel.edges));
      if (S.sel.verts.length) return edit(host, t('form.undo.del_verts'), (c) => FM.deleteVerts(c, S.sel.verts));
      host.status(t('form.delete.pick'));
    }, 'delete'),
  ));
  box.append(el('h3', { className: 'pc-h3' }, t('form.sharpness')), el('div', { className: 'pc-actions pc-wrap' },
    T(t('form.act.crease'), one('edges', 1, t('form.act.crease'), run(t('form.act.crease'), (c) => FM.crease(c, S.sel.edges, S.crease), { keepSel: true })), 'crease'),
    T(t('form.act.uncrease'), one('edges', 1, t('form.act.uncrease'), run(t('form.act.uncrease'), (c) => FM.uncrease(c, S.sel.edges), { keepSel: true })), 'uncrease'),
    T(t('form.act.corner'), one('verts', 1, t('form.act.corner'), run(t('form.act.corner'), (c) => FM.setCorners(c, S.sel.verts, !S.sel.verts.every((v) => (c.corners || []).includes(v))), { keepSel: true })), 'corner'),
    T(t('form.act.select_loop'), one('edges', 1, t('form.act.select_loop'), () => { S.sel = { verts: [], faces: [], edges: FM.edgeLoop(cage, S.sel.edges[0]) }; draw(host); host.renderAll(); }), 'select-loop'),
    T(t('form.act.select_ring'), one('edges', 1, t('form.act.select_ring'), () => { S.sel = { verts: [], faces: [], edges: FM.edgeRing(cage, S.sel.edges[0]) }; draw(host); host.renderAll(); }), 'select-ring'),
  ));
  box.append(el('div', { className: 'pc-props' },
    ...sel(t('form.sym'), [['', t('form.sym.off_opt')], ['x', t('form.sym.mirror', { axis: 'X' })], ['y', t('form.sym.mirror', { axis: 'Y' })], ['z', t('form.sym.mirror', { axis: 'Z' })]], cage.sym ? cage.sym.axis : '', (v) => edit(host, v ? t('form.sym') : t('form.sym.off'), (c) => (v ? FM.setSymmetry(c, v, 0, 1) : FM.clearSymmetry(c))), { sym: '' }),
    ...sel(t('form.display'), [['smooth', t('form.display.smooth_opt')], ['box', t('form.display.box_opt')]], S.display, (v) => { S.display = v; draw(host, true); }, { display: '' }),
    ...sel(t('form.analysis'), [['none', t('form.analysis.none')], ['zebra', t('form.analysis.zebra')], ['curvature', t('form.analysis.curvature')]], S.analysis, (v) => { S.analysis = v; if (v !== 'none') S.display = 'smooth'; draw(host, true); host.renderPanel(); }, { analysis: '' })));
  if (cage.sym) box.append(el('p', { className: 'pc-note' }, t('form.sym.note', { axis: cage.sym.axis.toUpperCase(), at: cage.sym.at })));
  if (S.analysis === 'curvature') box.append(el('p', { className: 'pc-note' }, t('form.analysis.curvature_note')));
  if (S.analysis === 'zebra') box.append(el('p', { className: 'pc-note' }, t('form.analysis.zebra_note')));
  // exact check + finish
  if (S.check) box.append(el('p', { className: 'pc-note', dataset: { formCheck: '' } }, S.check));
  box.append(el('div', { className: 'pc-actions' },
    btn(t('form.check'), () => {
      if (!host.useExact) { host.status(exactWhy(t('kernel.what.form_check'), t('form.check.no_kernel'))); return; }
      S.check = t('form.check.busy'); host.renderPanel();
      host.exact.call('formCheck', { cage }).then((r) => { S.check = r.closed ? t('form.check.closed', { report: describeReport(r.report), v: r.report.volume.toFixed(2) }) : t('form.check.open', { report: describeReport(r.report) }); host.renderPanel(); }, (e) => { S.check = t('form.check.fail', { msg: e.message }); host.renderPanel(); });
    }, 'pc-btn', { formAct: 'check' }),
    btn(t('form.finish'), () => finish(host), 'pc-btn is-primary', { formAct: 'finish' }),
    btn(t('form.discard'), () => host.confirm(t('form.discard.title'), t('form.discard.body'), t('form.discard')).then((y) => { if (y) { clearSel(); host.setStudy('form', null, t('form.undo.discard')); } }), 'pc-btn', { formAct: 'discard' })));
  draw(host);
  host.view.setPartVisible(!s.editing);
  return s.editing ? t('form.heading.editing', { name: host.P.featureById(host.part, s.editing)?.name || '' }) : t('form.ws.label');
}

/** Open a form feature's cage for editing (from Design's panel or this panel). */
function editFeature(id, host) {
  const f = host.P.featureById(host.part, id);
  if (!f || f.type !== 'form') return;
  clearSel();
  host.setStudy('form', { cage: f.cage, editing: id }, t('form.edit_feature', { name: f.name }));
  if (window.partcraft?.workspace !== 'form') window.partcraft?.setWorkspace?.('form');
  host.status(t('form.editing', { name: f.name }));
}

// Labels, blurb and titles go in as language-file keys (they pass registerWorkspace's checks) and are then turned into
// getters on the stored definition, so t() runs when the toolbar or switcher is drawn, never at import.
function lazyLabels(ws) {
  const lazy = (o, f) => { const key = o[f]; Object.defineProperty(o, f, { get: () => t(key), enumerable: true, configurable: true }); };
  lazy(ws, 'label'); if (ws.blurb !== undefined) lazy(ws, 'blurb');
  for (const g of ws.groups) { lazy(g, 'label'); for (const it of g.items) { lazy(it, 'label'); lazy(it, 'title'); } }
  return ws;
}

lazyLabels(registerWorkspace({
  id: 'form',
  label: 'form.ws.label',
  icon: 'bezier',
  blurb: 'form.ws.blurb',
  groups: [
    { label: 'form.tb.create', items: [
      { cmd: 'form-box', icon: 'box', label: 'form.tb.box', title: 'form.tb.box.title' },
      { cmd: 'form-sphere', icon: 'circle', label: 'form.tb.sphere', title: 'form.tb.sphere.title' },
      { cmd: 'form-plane', icon: 'square', label: 'form.tb.plane', title: 'form.tb.plane.title' },
    ] },
    { label: 'form.tb.modify', items: [
      { cmd: 'form-edit', icon: 'arrows-move', label: 'form.tb.edit', title: 'form.tb.edit.title' },
      { cmd: 'form-extrude', icon: 'box-arrow-up', label: 'form.tb.extrude', title: 'form.tb.extrude.title' },
      { cmd: 'form-loop', icon: 'distribute-horizontal', label: 'form.tb.loop', title: 'form.tb.loop.title' },
      { cmd: 'form-crease', icon: 'slash-lg', label: 'form.tb.crease', title: 'form.tb.crease.title' },
    ] },
    { label: 'form.tb.finish', items: [
      { cmd: 'form-display', icon: 'eye', label: 'form.tb.display', title: 'form.tb.display.title' },
      { cmd: 'form-finish', icon: 'check2-circle', label: 'form.tb.finish', title: 'form.tb.finish.title' },
    ] },
  ],
  editFeature,
  enter(host) {
    S.host = host; S.drawn = ''; S.check = null;
    S.onCam = () => { if (S.analysis === 'zebra' && S.display === 'smooth' && !S.drag) { clearTimeout(S.camT); S.camT = setTimeout(() => draw(host, true), 60); } };
    host.view.controls.addEventListener('change', S.onCam);
    makeGizmo(host).catch((e) => host.status(t('form.gizmo.fail', { msg: e.message })));
    if (!cageOf(host)) host.status(t('form.enter'));
  },
  exit(host) {
    if (S.onCam) host.view.controls.removeEventListener('change', S.onCam);
    if (S.tc) { S.tc.detach(); S.tc.dispose(); }
    S.tc = null; S.pivot = null; S.drag = null; S.faceDots = null; S.host = null; S.drawn = '';
    host.view.controls.enabled = true;
  },
  command,
  toolState,
  renderPanel,
  rebuilt(host) { draw(host); },
  onPick(hit, host, ev) {
    if (S.tc && (S.tc.axis !== null || S.tc.dragging)) return;
    if (!ev) return;
    if (S.faceDots) { faceClick(host, ev.clientX, ev.clientY); return; }
    const h = pickCage(host, ev.clientX, ev.clientY);
    const add = ev.shiftKey;
    if (!h) { if (!add) clearSel(); }
    else {
      const key = { vert: 'verts', edge: 'edges', face: 'faces' }[h.kind];
      const next = add ? { ...S.sel } : { verts: [], edges: [], faces: [] };
      next[key] = toggle(S.sel[key], h.id, add);
      S.sel = next;
    }
    draw(host); host.renderAll();
  },
  keydown(ev, host) {
    if (S.faceDots) {
      if (ev.key === 'Escape') { S.faceDots = null; drawDots(host); host.status(t('form.face.stopped')); return true; }
      if (ev.key === 'Enter' && S.faceDots.length >= 3) { finishFace(host); return true; }
    }
    const k = ev.key.toLowerCase();
    if (k === 'w' || k === 'e' || k === 'r') { S.mode = { w: 'translate', e: 'rotate', r: 'scale' }[k]; placeGizmo(host); host.renderPanel(); return true; }
    if (ev.key === 'Escape' && selCount()) { clearSel(); draw(host); host.renderAll(); return true; }
    if ((ev.key === t('form.act.delete') || ev.key === 'Backspace') && selCount()) {
      if (S.sel.faces.length) edit(host, t('form.undo.del_faces'), (c) => FM.deleteFaces(c, S.sel.faces));
      else if (S.sel.edges.length) edit(host, t('form.undo.del_edges'), (c) => FM.deleteEdges(c, S.sel.edges));
      else edit(host, t('form.undo.del_verts'), (c) => FM.deleteVerts(c, S.sel.verts));
      return true;
    }
    return false;
  },
}));
