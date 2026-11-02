/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ws-generative.js — the Generative workspace: topology optimisation (topopt.js: SIMP, density filter, threshold
 * projection, optimality criteria) on the part's voxels or a box around it, with supports, loads, preserve and
 * obstacle regions picked on faces, several target volumes × materials as outcomes, each re-solved as a solid
 * (fea.js) and turned into a smooth closed surface. The study lives in `part.studies.generative` (sim.js
 * readGenStudy); the work runs in a compute worker (sim-worker.js: genOutcomes) with progress and Stop. Outcomes
 * stay on the page; one previews as an overlay and downloads as STL, faceted STEP or a new part file.
 * Top level is DOM-free (Node imports it); the page is touched only in the hooks, through `host`.
 */
import { registerWorkspace } from './workspaces.js';
import { registerStudyReader } from './part.js';
import { newGenStudy, readGenStudy, genJob, MATERIALS, materialOf, autoSize, AUTO_ELEMENTS, LIMITS } from './sim.js';
import { stlBinary, stepFaceted } from './export.js';
import * as U from './sim-ui.js';
import { exactWhy, noExactKernel } from './exact-client.js';
import { t } from './i18n.js';

registerStudyReader('generative', (raw) => readGenStudy(raw));

const KEY = 'generative';
const ctx = U.makeCtx(KEY, newGenStudy, readGenStudy);
const S = { out: null, outMesh: null, outBox: null, busy: false, progress: 0, worker: null, pickOut: -1, showPart: false, error: null, progressEl: null, req: 0, started: 0 };
const VOLS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
const study = (host) => host.study(KEY);
const fresh = (host) => !!(S.out && host.regen && S.outMesh === host.regen.mesh);

async function generate(host) {
  const st = study(host);
  if (!st) { host.status(t('gen.start_first')); return; }
  if (S.busy) return;
  const { job, variants, problems } = genJob(st, host.regen);
  if (!job || problems.length) { host.status(problems[0] || t('gen.nothing')); host.renderPanel(); return; }
  const id = ++S.req, mesh = host.regen.mesh;
  S.busy = true; S.progress = 0; S.error = null; ctx.picking = false; S.started = Date.now();
  host.renderPanel();
  host.status(t('gen.generating', { n: variants.length }), true);
  try {
    S.worker = S.worker || host.computeWorker(['sim-worker.js'], { name: 'PartCraft generative design' });   // i18n-ignore: worker name (developer tools only)
    const tr = [job.mesh.positions.buffer, job.mesh.indices.buffer]; if (job.mesh.triFace) tr.push(job.mesh.triFace.buffer);
    const r = await S.worker.call('genOutcomes', { job, variants }, { transfer: tr, onProgress: (v) => { S.progress = v; if (S.progressEl) S.progressEl.textContent = progressText(); } });
    if (id !== S.req) return;
    S.out = r; S.outMesh = mesh; S.pickOut = 0; S.showPart = false;
    host.status(t('gen.ready', { n: r.outcomes.length, elements: r.summary.elements.toLocaleString('en-US'), secs: (r.ms / 1000).toFixed(0) }));
  } catch (e) {
    if (id !== S.req) return;
    const msg = e && e.message ? e.message : String(e);
    S.error = msg === 'Stopped.' ? null : msg;   // i18n-ignore: the worker client's own message, compared, not shown
    host.status(msg === 'Stopped.' ? t('gen.stopped') : t('gen.error', { msg }), msg !== 'Stopped.');   // i18n-ignore: compared with the worker client's message
  } finally {
    if (id === S.req) { S.busy = false; preview(host); host.renderAll(); }
  }
}
function stop(host) {
  if (!S.busy) return;
  S.req++;
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  S.busy = false;
  host.status(t('gen.stopped'));
  host.renderAll();
}
function progressText() {
  const secs = (Date.now() - S.started) / 1000, p = S.progress;
  const left = p > 0.03 ? Math.max(0, secs / p - secs) : null;
  const pct = Math.round(100 * p);
  if (left === null) return t('gen.working', { pct });
  return left > 90 ? t('gen.working_min', { pct, n: Math.round(left / 60) }) : t('gen.working_s', { pct, n: Math.round(left) });
}

function preview(host) {
  const { view, THREE } = host;
  view.setOverlay('generative-outcome', null);
  if (!fresh(host) || S.pickOut < 0) { view.setPartVisible(true); return; }
  const o = S.out.outcomes[S.pickOut];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(o.mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(o.mesh.indices, 1));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#c9a46a', roughness: 0.55, metalness: 0.1, transparent: S.showPart, opacity: S.showPart ? 0.85 : 1 }));
  view.setPartVisible(S.showPart);
  view.setOverlay('generative-outcome', m);
}
const outName = (host, o) => `${U.baseName(host)}-outcome-${Math.round(o.volfrac * 100)}-${o.material.id}`;   // i18n-ignore: file name
function download(host, kind) {
  if (!fresh(host) || S.pickOut < 0) return;
  const o = S.out.outcomes[S.pickOut], name = outName(host, o), mesh = { positions: o.mesh.positions, indices: o.mesh.indices };
  if (kind === 'stl') host.downloadBlob(name + '.stl', new Blob([stlBinary(mesh, name)], { type: 'model/stl' }), 'model/stl');
  else {
    const step = stepFaceted(mesh, name).text;
    if (kind === 'step') host.downloadBlob(name + '.step', new Blob([step], { type: 'model/step' }), 'model/step');
    else {
      const p = host.P.newPart(name.slice(0, 120));
      host.P.addFeature(p, 'import', { file: name + '.step', step, up: 'y' });
      host.downloadBlob(name + '.partcraft.json', new Blob([host.P.toJSON(p)], { type: 'application/json' }), 'application/json');
    }
  }
  host.status(t(kind === 'part' ? 'gen.dl.part' : kind === 'step' ? 'gen.dl.step' : 'gen.dl.stl'));
}
function addToPart(host) {
  if (!fresh(host) || S.pickOut < 0) return;
  const o = S.out.outcomes[S.pickOut], name = outName(host, o);
  const step = stepFaceted({ positions: o.mesh.positions, indices: o.mesh.indices }, name).text;
  host.commit(t('gen.undo.add_outcome'), () => host.P.addFeature(host.part, 'import', { file: name + '.step', step, up: 'y' }));
  host.status(t('gen.added'));
}

// ---------------------------------------------------------------- panel

function renderPanel(host, box) {
  const { el } = host;
  const K = U.kit(host);
  const st = study(host);
  S.progressEl = null;
  if (!st) {
    box.append(el('div', { className: 'pc-block' },
      el('p', { className: 'pc-note' }, t('gen.intro')),
      el('div', { className: 'pc-actions' }, K.btn(t('gen.new_study'), () => { U.edit(host, ctx, t('gen.undo.new_study'), () => {}); host.renderPanel(); }, 'pc-btn is-primary', { dataset: { genNew: '1' } }))));
    U.marks(host, ctx);
    return t('gen.ws.label');
  }
  const rg = host.regen;
  const set = (label, fn) => U.edit(host, ctx, label, fn);
  const g = el('div', { className: 'pc-props' },
    el('p', { className: 'pc-props-sub' }, t('gen.design_space')),
    ...K.field(t('gen.space'), K.sel([['part', t('gen.space.part')], ['box', t('gen.space.box')]], st.designSpace, (v) => set(t('gen.design_space'), (s) => { s.designSpace = v; }), { genSpace: '1' })));
  if (st.designSpace === 'box') g.append(...K.field(t('gen.margin'), K.num(st.margin, (v) => set(t('gen.undo.margin'), (s) => { s.margin = v; }), { min: 0, max: 1000 })));
  g.append(...K.field(t('gen.h'), K.num(st.h, (v) => set(t('gen.undo.h'), (s) => { s.h = v; }), { min: 0.01, max: 1000, nullable: true, data: { genSize: '1' } })));
  const { problems, h, estimate } = genJob(st, rg, { check: true });
  if (h) g.append(el('span', { className: 'k' }, t('gen.mesh')), el('span', { className: 'v' + (estimate > LIMITS.genElements ? ' is-bad' : ''), dataset: { genEstimate: String(estimate) } }, st.h ? t('gen.mesh.cubes', { n: estimate.toLocaleString('en-US') }) : t('gen.mesh.auto', { h: U.fmt(h), n: estimate.toLocaleString('en-US') })));
  g.append(...K.field(t('gen.rmin'), K.num(st.rmin, (v) => set(t('gen.undo.rmin'), (s) => { s.rmin = v; }), { min: 0.01, max: 1000, nullable: true })),
    el('span', { className: 'k' }, ''), el('span', { className: 'v' }, t('gen.rmin.note', { r: U.fmt(st.rmin || 1.5 * (h || 1)) })),
    ...K.field(t('gen.iters'), K.num(st.maxIter, (v) => { if (!Number.isInteger(v)) { host.status(t('gen.iters_whole')); return; } set(t('gen.undo.iters'), (s) => { s.maxIter = v; }); }, { min: 5, max: 300 })),
    el('p', { className: 'pc-props-sub' }, t('gen.outcomes')));
  const vols = el('div', { className: 'pc-checks pc-sim-grid', role: 'group', 'aria-label': t('gen.vols') }, ...VOLS.map((v) => K.check(`${Math.round(v * 100)} %`, st.volfracs.includes(v), (on) => set(t('gen.vols'), (s) => {
    const next = on ? [...new Set([...s.volfracs, v])].sort((a, b) => a - b) : s.volfracs.filter((x) => x !== v);
    if (!next.length || next.length > 6) { host.status(next.length ? t('gen.vols.max') : t('gen.vols.min')); host.renderPanel(); return false; }
    s.volfracs = next;
  }), { dataset: { genVol: String(v) } })));
  const mats = el('div', { className: 'pc-checks pc-sim-grid', role: 'group', 'aria-label': t('gen.materials') }, ...MATERIALS.map((m) => K.check(m.name, st.materials.includes(m.id), (on) => set(t('gen.materials'), (s) => {
    const next = on ? [...new Set([...s.materials, m.id])] : s.materials.filter((x) => x !== m.id);
    if (!next.length || next.length > 4) { host.status(next.length ? t('gen.mats.max') : t('gen.mats.min')); host.renderPanel(); return false; }
    s.materials = next; s.material = next[0];
  }), { dataset: { genMat: m.id } })));
  g.append(el('span', { className: 'k span' }, t('gen.vol_label')), vols, el('span', { className: 'k span' }, t('gen.materials')), mats);
  box.append(el('div', { className: 'pc-block' }, g));
  let addType = 'fixed';
  box.append(el('div', { className: 'pc-block' }, el('div', { className: 'pc-actions' },
    K.sel([['fixed', t('gen.add.fixed')], ['frictionless', t('gen.add.frictionless')], ['force', t('gen.add.force')], ['pressure', t('gen.add.pressure')], ['preserve', t('gen.add.preserve')], ['obstacle', t('gen.add.obstacle')]], addType, (v) => { addType = v; }, { genAddType: '1' }),
    K.btn(t('gen.add'), () => U.addItem(host, ctx, ['fixed', 'frictionless'].includes(addType) ? 'constraints' : ['force', 'pressure'].includes(addType) ? 'loads' : addType, ['preserve', 'obstacle'].includes(addType) ? null : addType), 'pc-btn', { dataset: { genAdd: '1' } }))));
  U.renderItems(host, ctx, box, K, ['constraints', 'loads', 'preserve', 'obstacle']);
  const sb = el('div', { className: 'pc-block' }, el('p', { className: 'pc-props-sub' }, t('gen.generate')));
  for (const p of S.busy ? [] : problems) sb.append(el('div', { className: 'pc-msg' }, el('p', {}, p)));
  if (S.error) sb.append(el('div', { className: 'pc-msg is-error' }, el('p', {}, S.error)));
  const n = st.volfracs.length * st.materials.length;
  sb.append(el('div', { className: 'pc-actions' },
    K.btn(t('gen.generate_n', { n }), () => generate(host), 'pc-btn is-primary', { disabled: S.busy || problems.length > 0, dataset: { genGenerate: '1' } }),
    K.btn(t('gen.stop'), () => stop(host), 'pc-btn', { disabled: !S.busy, dataset: { genStop: '1' } })));
  if (S.busy) { S.progressEl = el('p', { className: 'pc-note', role: 'status', dataset: { genProgress: '1' } }, progressText()); sb.append(S.progressEl); }
  box.append(sb);
  if (S.out) renderOutcomes(host, box, K);
  box.append(el('div', { className: 'pc-block' }, el('p', { className: 'pc-note' }, t('gen.method'))));
  U.marks(host, ctx);
  return t('gen.ws.label');
}

function renderOutcomes(host, box, K) {
  const { el } = host;
  const b = el('div', { className: 'pc-block', dataset: { genOutcomes: '1' } }, el('p', { className: 'pc-props-sub' }, t('gen.outcomes')));
  if (!fresh(host)) { b.append(el('div', { className: 'pc-msg' }, el('p', {}, t('gen.stale')))); box.append(b); return; }
  const r = S.out;
  const head = [t('gen.col.volume'), t('gen.col.material'), t('gen.col.mass'), t('gen.col.stress'), t('gen.col.displ'), t('gen.col.safety')];
  const table = el('table', { className: 'pc-sim-table' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...r.outcomes.map((o, i) => {
      const e = o.eval;
      const tr = el('tr', { className: i === S.pickOut ? 'is-sel' : '', dataset: { genRow: String(i) } },
        el('td', {}, el('button', { type: 'button', className: 'pc-btn pc-btn-sm', 'aria-pressed': String(i === S.pickOut), onclick: () => { S.pickOut = i; preview(host); host.renderPanel(); } }, `${Math.round(o.volfrac * 100)} %`)),   // i18n-ignore: a percentage
        el('td', {}, o.material.name), el('td', { dataset: { genMass: String(e.mass) } }, U.sig(e.mass * 1000)), el('td', {}, U.sig(e.maxVm)), el('td', {}, U.sig(e.maxDisp)),
        el('td', { className: e.minSafety < 1 ? 'is-bad' : '' }, U.sig(e.minSafety)));
      return tr;
    })));
  b.append(el('div', { className: 'pc-sim-scroll' }, table));
  const o = r.outcomes[S.pickOut];
  if (o) {
    const e = o.eval;
    b.append(el('dl', { className: 'pc-dl' },
      el('dt', {}, t('gen.optimisation')), el('dd', {}, t(o.converged ? 'gen.iters.settled' : 'gen.iters.limit', { n: o.iterations })),
      el('dt', {}, t('gen.stiffness')), el('dd', {}, t('gen.stiffness.v', { solid: U.sig(e.compliance), opt: U.sig(o.finalC) })),
      el('dt', {}, t('gen.solid_check')), el('dd', {}, e.dropped ? t('gen.solid.dropped', { n: e.elements.toLocaleString('en-US'), h: U.fmt(r.summary.h), v: U.sig(e.volume), dropped: e.dropped }) : t('gen.solid.v', { n: e.elements.toLocaleString('en-US'), h: U.fmt(r.summary.h), v: U.sig(e.volume) })),
      el('dt', {}, t('gen.surface')), el('dd', {}, t('gen.surface.v', { n: (o.mesh.indices.length / 3).toLocaleString('en-US'), v: U.sig(o.mesh.volume) }))),
    el('div', { className: 'pc-checks' }, K.check(t('gen.show_part'), S.showPart, (v) => { S.showPart = v; preview(host); }, { dataset: { genShowPart: '1' } })),
    el('div', { className: 'pc-actions' },
      K.btn('STL', () => download(host, 'stl'), 'pc-btn', { dataset: { genStl: '1' } }),
      K.btn(t('gen.btn.step'), () => download(host, 'step'), 'pc-btn', { dataset: { genStep: '1' } }),
      // an outcome as a part is an imported solid, which only an exact kernel builds (0.4: none): say so on both buttons
      ...(noExactKernel() ? [
        K.btn(t('gen.btn.part'), () => {}, 'pc-btn', { disabled: true, title: t('kernel.not_built', { what: t('gen.what.outcome_part') }), dataset: { genPart: '1' } }),
        K.btn(t('gen.btn.add'), () => {}, 'pc-btn', { disabled: true, title: t('kernel.not_built', { what: t('gen.what.outcome_part') }), dataset: { genAddPart: '1' } })] : [
        K.btn(t('gen.btn.part'), () => download(host, 'part'), 'pc-btn', { dataset: { genPart: '1' } }),
        K.btn(t('gen.btn.add'), () => addToPart(host), 'pc-btn', study(host).designSpace === 'box' ? { dataset: { genAddPart: '1' } } : { disabled: true, title: t('gen.btn.add_off'), dataset: { genAddPart: '1' } })])),
    el('p', { className: 'pc-note' }, t('gen.outcome_note')));
  }
  box.append(b);
}

// ---------------------------------------------------------------- registration

// Labels, blurb and titles go in as language-file keys (they pass registerWorkspace's checks) and are then turned into
// getters on the stored definition, so t() runs when the toolbar or switcher is drawn, never at import.
function lazyLabels(ws) {
  const lazy = (o, f) => { const key = o[f]; Object.defineProperty(o, f, { get: () => t(key), enumerable: true, configurable: true }); };
  lazy(ws, 'label'); if (ws.blurb !== undefined) lazy(ws, 'blurb');
  for (const g of ws.groups) { lazy(g, 'label'); for (const it of g.items) { lazy(it, 'label'); lazy(it, 'title'); } }
  return ws;
}

lazyLabels(registerWorkspace({
  id: 'generative',
  label: 'gen.ws.label',
  icon: 'diagram-3',
  blurb: 'gen.ws.blurb',
  groups: [{ label: 'gen.tb.goals', items: [
    { cmd: 'generative-fixed', icon: 'pin-angle', label: 'gen.tb.fixed', title: 'gen.tb.fixed.title' },
    { cmd: 'generative-force', icon: 'arrow-down', label: 'gen.tb.force', title: 'gen.tb.force.title' },
    { cmd: 'generative-preserve', icon: 'shield-check', label: 'gen.tb.preserve', title: 'gen.tb.preserve.title' },
    { cmd: 'generative-obstacle', icon: 'slash-circle', label: 'gen.tb.obstacle', title: 'gen.tb.obstacle.title' },
    { cmd: 'generative-generate', icon: 'play-fill', label: 'gen.tb.generate', title: 'gen.tb.generate.title' },
  ] }],
  enter(host) { U.drawMarkers(host, ctx, 'generative'); preview(host); },
  exit(host) {
    S.req++;
    if (S.worker) { S.worker.terminate(); S.worker = null; }
    S.busy = false; ctx.picking = false;
    host.view.setMarks(null);
  },
  command(cmd, host) {
    if (cmd === 'generative-fixed') { U.addItem(host, ctx, 'constraints', 'fixed'); return true; }
    if (cmd === 'generative-force') { U.addItem(host, ctx, 'loads', 'force'); return true; }
    if (cmd === 'generative-preserve') { U.addItem(host, ctx, 'preserve', null); return true; }
    if (cmd === 'generative-obstacle') { U.addItem(host, ctx, 'obstacle', null); return true; }
    if (cmd === 'generative-generate') { generate(host); return true; }
    return false;
  },
  renderPanel(host, box) { const h = renderPanel(host, box); U.drawMarkers(host, ctx, 'generative'); return h; },
  onPick(hit, host) {
    if (ctx.picking) { U.togglePick(host, ctx, hit); return; }
    if (hit && hit.kind === 'face') host.status(t('gen.pick.choose'));
  },
  onHover(hit, host) { if (ctx.picking) U.hoverFace(host, hit); else host.view.setHover(null); },
  keydown(ev, host) {
    if (ev.key === 'Escape' && ctx.picking) { ctx.picking = false; host.status(t('mfg.pick.done')); host.renderPanel(); return true; }
    return false;
  },
  toolState(cmd, host) {
    if (/^generative-(fixed|force|preserve|obstacle)$/.test(cmd) && !(host.regen?.exact || host.regen?.named)) return { ok: false, why: exactWhy(t('kernel.what.generative'), t('gen.need_exact')) };
    if (cmd === 'generative-generate') {
      if (S.busy) return { ok: false, why: t('gen.busy') };
      const st = study(host);
      if (!st) return { ok: false, why: t('gen.start_first') };
      const { problems } = genJob(st, host.regen, { check: true });
      if (problems.length) return { ok: false, why: problems[0] };
    }
    return { ok: true };
  },
  rebuilt(host) { U.drawMarkers(host, ctx, 'generative'); preview(host); },
}));

export const _state = S;   // tests
export const _ctx = ctx;
