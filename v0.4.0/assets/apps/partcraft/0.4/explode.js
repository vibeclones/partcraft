/* SPDX-License-Identifier: Apache-2.0 */
/**
 * explode.js — exploded views of an assembly (DOM-free). Saved in the assembly file (v2) as
 *   asm.views = [{ id: 'v<n>', name, steps: [{ id: 's<n>', insts: [instance ids], dir: [x,y,z] (unit), dist (mm) }] }]
 * An exploded view only moves what is drawn: it never changes joints, `place` or the placement placeAll() works out.
 *   offsets(view, t) → Map(inst → [dx,dy,dz])   t 0 (assembled) … 1 (fully exploded); the steps play one after
 *       another (step k moves during t ∈ [k/n, (k+1)/n]), each moving its parts dir·dist.
 *   exploded(world, offs) → Map(inst → mat4)   translation(offset) · world, for the view, drawings and exports
 *   trails(view, centres, t) → [{ inst, pts: [[x,y,z]…] }]   rest centre through each step's end, up to t
 *   autoSteps(items, mode, opts) → steps   mode 'radial': each part away from the assembly's centre (one step per
 *       part, the grounded part stays); mode 'joints': down the joint tree, each child (with everything joined below
 *       it) along the parent's mate normal, parents first. Distances = 1.25 × the moved parts' extent along the
 *       direction (+ a gap), a layout choice, not a measurement.
 *   readViews(raw, instIds) → clean views (untrusted)
 */
import * as V from './vec.js';
import { t } from './i18n.js';

export const MAX_VIEWS = 50, MAX_STEPS = 200;

export function newView(asm, name) {
  const v = { id: 'v' + asm.seq++, name: name || t('xch.explode.default_name', { n: (asm.views?.length || 0) + 1 }), steps: [] };
  (asm.views ||= []).push(v);
  return v;
}

export function addStep(asm, view, insts, dir, dist) {
  if (!insts.length) throw new Error(t('xch.explode.pick_parts'));
  const d = V.norm(dir);
  if (!dir.every(Number.isFinite) || V.len(dir) < 1e-12) throw new Error(t('xch.explode.need_dir'));
  if (!Number.isFinite(dist)) throw new Error(t('xch.explode.need_dist'));
  const s = { id: 's' + asm.seq++, insts: [...new Set(insts)], dir: d, dist };
  view.steps.push(s);
  return s;
}

/** Progress of step k of n at t. */
export const stepProgress = (k, n, t) => Math.max(0, Math.min(1, t * n - k));

export function offsets(view, t = 1) {
  const out = new Map();
  if (!view) return out;
  const n = view.steps.length;
  view.steps.forEach((s, k) => {
    const p = stepProgress(k, n, t);
    if (!p) return;
    for (const id of s.insts) out.set(id, V.add(out.get(id) || [0, 0, 0], V.mul(s.dir, s.dist * p)));
  });
  return out;
}

export function exploded(world, offs) {
  const out = new Map();
  for (const [id, m] of world) { const o = offs.get(id); out.set(id, o ? V.matMul(V.translation(o), m) : m); }
  return out;
}

/** centres: Map(inst → rest world centre). */
export function trails(view, centres, t = 1) {
  const out = [];
  if (!view) return out;
  const n = view.steps.length;
  for (const [id, c] of centres) {
    const pts = [c];
    let at = c;
    view.steps.forEach((s, k) => {
      if (!s.insts.includes(id)) return;
      const p = stepProgress(k, n, t);
      if (!p) return;
      at = V.add(at, V.mul(s.dir, s.dist * p));
      pts.push(at);
    });
    if (pts.length > 1) out.push({ inst: id, pts });
  }
  return out;
}

/** Extent of a set of world boxes along d. boxes: [{ min, max }] */
function extentAlong(boxes, d) {
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes) for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
    const x = V.dot(p, d); lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * items: [{ id, box: { min, max } (world, assembled) }] with items[0] the grounded part.
 * mode 'joints' also needs opts.tree: [{ parent, child, normal (world unit, out of the parent's face) }] in tree order.
 */
export function autoSteps(items, mode = 'radial', { tree = [], factor = 1.25 } = {}) {
  const box = new Map(items.map((i) => [i.id, i.box]));
  const all = items.map((i) => i.box);
  const size = Math.max(1, ...all.map((b) => V.len(V.sub(b.max, b.min))));
  const gap = size * 0.05;
  const centreOf = (b) => V.mul(V.add(b.min, b.max), 0.5);
  const steps = [];
  if (mode === 'radial') {
    const C = V.mul(items.reduce((s, i) => V.add(s, centreOf(i.box)), [0, 0, 0]), 1 / items.length);
    for (const it of items.slice(1)) {
      let d = V.sub(centreOf(it.box), C);
      if (V.len(d) < 1e-6 * size) d = [0, 1, 0];
      d = V.norm(d);
      steps.push({ insts: [it.id], dir: d, dist: factor * extentAlong([it.box], d) + gap });
    }
    return steps;
  }
  if (mode === 'joints') {
    const kids = new Map();
    for (const e of tree) (kids.get(e.parent) || kids.set(e.parent, []).get(e.parent)).push(e.child);
    const below = (id, seen = new Set()) => { if (seen.has(id)) return []; seen.add(id); return [id, ...(kids.get(id) || []).flatMap((k) => below(k, seen))]; };
    for (const e of tree) {
      const insts = below(e.child);
      const d = V.norm(e.normal);
      steps.push({ insts, dir: d, dist: factor * extentAlong([box.get(e.child)].filter(Boolean), d) + gap });
    }
    return steps;
  }
  throw new Error(t('xch.explode.unknown_method'));
}

const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** Check views from a file; returns clean views or throws Error. `take(id, re)` registers ids (shared with the assembly). */
export function readViews(raw, instIds, take) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_VIEWS) throw new Error(t('xch.explode.views_bad'));
  return raw.map((v) => {
    if (!v || !Array.isArray(v.steps) || v.steps.length > MAX_STEPS) throw new Error(t('xch.explode.view_bad'));
    const view = { id: take(v.id, /^v\d{1,9}$/), name: clean(v.name, 60) || t('xch.explode.name_fallback'), steps: [] };
    for (const s of v.steps) {
      if (!s || !Array.isArray(s.insts) || !s.insts.length || s.insts.length > 500 || !s.insts.every((i) => instIds.has(i))) throw new Error(t('xch.explode.step_missing_part'));
      if (!Array.isArray(s.dir) || s.dir.length !== 3 || !s.dir.every(num) || V.len(s.dir) < 1e-9 || !num(s.dist)) throw new Error(t('xch.explode.step_bad'));
      view.steps.push({ id: take(s.id, /^s\d{1,9}$/), insts: [...new Set(s.insts)], dir: V.norm(s.dir), dist: s.dist });
    }
    return view;
  });
}
