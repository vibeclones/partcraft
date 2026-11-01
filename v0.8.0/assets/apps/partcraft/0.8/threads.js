/* SPDX-License-Identifier: Apache-2.0 */
/**
 * threads.js — threads on round faces and modelled (helical) threads (0.5 WL.29; DOM-free).
 *
 * Two things live here:
 *  - the Thread feature's data: a thread on picked cylindrical faces (a shaft: external; a bore: internal), cosmetic by
 *    default (a dashed major diameter and a callout, as tapped holes always had), or modelled as real helical geometry
 *    (for 3D printing);
 *  - the helical solid both the Thread feature and a tapped hole's "Modelled" option build on the mesh kernel (kernel.js).
 *
 *   thread { faces: [FaceRef], form: 'iso' | 'tr', size: 'auto' | 'M10' | 'Tr16x4', length: null (the whole face) | mm,
 *            flip (start at the other end), modelled, clearance (mm, radial), hand: 'right' | 'left' }
 *   hole   + modelled, clearance (written only when modelled is on; a tapped hole's thread)
 *
 * Profiles are the basic profiles: ISO 68-1 (60°, flat crest P/8 at the major diameter, flat root P/4 at the minor
 * diameter D1 = D − 1.0825 P) and ISO 2901 (30° trapezoidal, depth P/2, crest and root flats 0.366 P). A modelled thread
 * is that profile moved `clearance` inward (a shaft) or outward (a bore), so printed parts fit; 0 = the basic profile.
 *
 * The solid: a thread is unchanged by a screw motion (turn θ, advance P·θ/2π), so its cross-section square to the axis,
 * extruded with a twist of 360° per pitch (manifold-3d `CrossSection.extrude(h, n, twist)`), is the helical solid itself:
 * `boltSection` is that cross-section (r(θ) = the profile at u = −P·θ/2π, every profile corner on a vertex), `boltSolid`
 * extrudes it along +z. A bore's thread is cut by the mating bolt's shape; a shaft's by a tube less that shape.
 */
import { registerParamField } from './params-part.js';
import { t } from './i18n.js';

// the type's name for people, read when shown (a getter: never translated at import)
export const THREAD_LABELS = { get thread() { return t('model.feature.thread'); } };
export const THREAD_BASE = { thread: 'Thread' };
export const THREAD_FORMS = ['iso', 'tr'];
export const THREAD_HANDS = ['right', 'left'];
/** A modelled thread's default radial clearance (mm): a common fit for printed parts. */
export const DEFAULT_CLEARANCE = 0.1;
export const THREAD_DEFAULTS = { thread: () => ({ faces: [], form: 'iso', size: 'auto', length: null, flip: false, modelled: false, clearance: DEFAULT_CLEARANCE, hand: 'right' }) };

registerParamField('thread', 'length', { get label() { return t('thread.param.length'); }, kind: 'length', min: 1e-3, max: 1e5 });
registerParamField('thread', 'clearance', { get label() { return t('thread.param.clearance'); }, kind: 'length', min: 0, max: 5 });

/** ISO 261 coarse pitches, M1.6–M64: { size: [nominal d, pitch] }. */
export const ISO_METRIC = {
  'M1.6': [1.6, 0.35], M2: [2, 0.4], 'M2.5': [2.5, 0.45], M3: [3, 0.5], 'M3.5': [3.5, 0.6], M4: [4, 0.7], M5: [5, 0.8], M6: [6, 1],
  M8: [8, 1.25], M10: [10, 1.5], M12: [12, 1.75], M14: [14, 2], M16: [16, 2], M18: [18, 2.5], M20: [20, 2.5], M22: [22, 2.5],
  M24: [24, 3], M27: [27, 3], M30: [30, 3.5], M33: [33, 3.5], M36: [36, 4], M39: [39, 4], M42: [42, 4.5], M45: [45, 4.5],
  M48: [48, 5], M52: [52, 5], M56: [56, 5.5], M60: [60, 5.5], M64: [64, 6],
};
/** ISO 2904 trapezoidal threads, the preferred pitch of each diameter 8–60: { size: [nominal d, pitch] }. */
export const ISO_TRAPEZOIDAL = {
  Tr8x1_5: [8, 1.5], Tr10x2: [10, 2], Tr12x3: [12, 3], Tr14x3: [14, 3], Tr16x4: [16, 4], Tr18x4: [18, 4], Tr20x4: [20, 4],
  Tr22x5: [22, 5], Tr24x5: [24, 5], Tr26x5: [26, 5], Tr28x5: [28, 5], Tr30x6: [30, 6], Tr32x6: [32, 6], Tr36x6: [36, 6],
  Tr40x7: [40, 7], Tr44x7: [44, 7], Tr48x8: [48, 8], Tr52x8: [52, 8], Tr60x9: [60, 9],
};
export const THREAD_TABLES = { iso: ISO_METRIC, tr: ISO_TRAPEZOIDAL };
export const THREAD_SOURCES = { iso: 'ISO 68-1 basic profile, ISO 261 coarse pitches', tr: 'ISO 2901 basic profile, ISO 2904 pitches' };
/** How a size is written: "M10", "Tr16×4" (the key Tr8x1_5 → Tr8×1.5). */
export const sizeLabel = (form, size) => (form === 'tr' ? size.replace('x', '×').replace('_', '.') : size);

/** The basic profile's diameters: { d (major), d1 (minor), d2 (pitch), p, depth }. */
export function threadDims(form, size) {
  const row = THREAD_TABLES[form]?.[size];
  if (!row) return null;
  const [d, p] = row;
  const depth = form === 'tr' ? p / 2 : 5 * Math.sqrt(3) / 16 * p;   // tr: H1 = P/2 · iso: 5H/8 with H = √3/2 · P
  return { d, p, d1: d - 2 * depth, d2: form === 'tr' ? d - p / 2 : d - 0.649519 * p, depth };
}

/**
 * The size that fits a round face of diameter `dia`: a shaft wants its major diameter (external), a bore its minor
 * diameter (the tap drill: ≥ D1, below the pitch diameter). → the size key, or null when none is within 12 %.
 */
export function sizeFor(form, dia, external) {
  let best = null, bd = Infinity;
  for (const size of Object.keys(THREAD_TABLES[form] || {})) {
    const g = threadDims(form, size);
    const want = external ? g.d : (g.d1 + g.d2) / 2;   // a bore: between the minor and pitch diameters
    const dd = Math.abs(dia - want);
    if (dd < bd) { bd = dd; best = size; }
  }
  return best !== null && bd <= 0.12 * dia ? best : null;
}

/**
 * The profile over one pitch as (u, r) corners, u ∈ [0, P] along the axis, r the radius; crest first. `shift` moves it
 * radially (− for a shaft's clearance, + for a bore's).
 */
export function profileCorners(form, size, shift = 0) {
  const g = threadDims(form, size);
  if (!g) return null;
  const R = g.d / 2 + shift, r = g.d1 / 2 + shift, p = g.p;
  // iso: crest P/8, flank 5P/16, root P/4, flank 5P/16 · tr: crest 0.366P, flank, root 0.366P, flank (flank = P/2·tan 15°)
  const crest = form === 'tr' ? p * (0.5 - Math.tan(Math.PI / 12) / 2) : p / 8;
  const root = form === 'tr' ? crest : p / 4;
  const flank = (p - crest - root) / 2;
  return [[0, R], [crest, R], [crest + flank, r], [crest + flank + root, r], [p, R]];
}

/** The profile's radius at u (any real number; periodic in P). */
export function profileAt(corners, u) {
  const p = corners[corners.length - 1][0];
  const w = ((u % p) + p) % p;
  for (let k = 1; k < corners.length; k++) {
    const [u0, r0] = corners[k - 1], [u1, r1] = corners[k];
    if (w <= u1 + 1e-15) return u1 - u0 < 1e-15 ? r1 : r0 + (r1 - r0) * (w - u0) / (u1 - u0);
  }
  return corners[0][1];
}

/**
 * The thread's cross-section square to the axis at z = 0 as one CCW polygon [[x, y]…]: r(θ) = profile(u) with
 * u = −P·θ/2π (right hand; left: +P·θ/2π), every profile corner a vertex, else steps of at most 360/segments degrees.
 */
export function boltSection(corners, { hand = 'right', segments = 96 } = {}) {
  const p = corners[corners.length - 1][0];
  const s = hand === 'left' ? 1 : -1;
  const th = new Set([0, 2 * Math.PI]);
  for (const [u] of corners) th.add((((s * u / p) % 1 + 1) % 1) * 2 * Math.PI);   // θ where u hits a corner
  const n = Math.max(24, segments);
  for (let k = 1; k < n; k++) th.add(2 * Math.PI * k / n);
  const list = [...th].sort((a, b) => a - b).filter((a, i, all) => i === 0 || a - all[i - 1] > 1e-9);
  if (2 * Math.PI - list[list.length - 1] < 1e-9) list.pop();
  return list.map((a) => { const r = profileAt(corners, s * p * a / (2 * Math.PI)); return [r * Math.cos(a), r * Math.sin(a)]; });
}

/**
 * The helical solid (a bolt's shape) from z = 0 to z = h along +z, twisted 360° per pitch; the screw motion keeps the
 * profile phase at z = 0. M = manifold-3d, T = its arena. → a Manifold.
 */
export function boltSolid(M, T, corners, h, { hand = 'right', segments = 96 } = {}) {
  const p = corners[corners.length - 1][0];
  const poly = boltSection(corners, { hand: 'right', segments });
  const cs = T(new M.CrossSection([poly], 'Positive'));
  const turns = h / p;
  const slices = Math.max(1, Math.ceil(turns * Math.max(24, segments)));
  const right = T(cs.extrude(h, slices - 1, 360 * turns));
  // a left-hand thread is the mirror image of a right-hand one (y → −y): manifold triangulates a negative twist's side
  // quads across their fold, ~1e-3 of the volume, so it is never extruded that way
  return hand === 'left' ? T(right.mirror([0, 1, 0])) : right;
}

/**
 * A thread's cutting tool in its own frame (axis +z, the thread from z = 0 to z = len): a bore's = the bolt's shape
 * (outward by `clearance`), a shaft's = a tube of radius `outer` less the bolt's shape (inward by `clearance`).
 * ext0 / ext1: how far it carries on past z = 0 / z = len (past an open end, so the cut is clean). → Manifold
 */
export function threadTool(M, T, { form, size, external, len, clearance = 0, hand = 'right', segments = 96, outer = 0, ext0 = 0, ext1 = 0, face = null }) {
  const corners = profileCorners(form, size, external ? -clearance : clearance);
  if (!corners) return null;
  // face { r, segments }: the faceted round face the thread is cut into. A shaft's crest (a bore's root) lying on those
  // facets would leave hundreds of slivers of them, so it moves just inside the facets (a hair, at most their sag)
  if (face) {
    const lo = face.r * Math.cos(Math.PI / Math.max(8, face.segments)), eps = 1e-4 * face.r;
    const k = external ? 0 : 2;   // the corner pair on the face: crest (0, 1) or root (2, 3)
    const v = corners[k][1];
    if (v > lo - eps && v < face.r + eps) {
      const to = external ? lo - eps : face.r + eps;
      for (const c of corners) if (Math.abs(c[1] - v) < 1e-12) c[1] = to;
    }
  }
  const h = len + ext0 + ext1;
  // start the bolt one pitch early so the phase at z = 0 stays the same whatever ext0 is (a whole number of turns)
  const p = corners[corners.length - 1][0];
  const pre = Math.ceil(ext0 / p) * p;
  const bolt = T(T(boltSolid(M, T, corners, len + pre + ext1, { hand, segments })).translate([0, 0, -pre]));
  if (!external) return pre > ext0 + 1e-9 ? T(bolt.trimByPlane([0, 0, 1], -ext0)) : bolt;
  const tube = T(T(T(M.CrossSection.circle(outer, Math.max(24, segments))).extrude(h)).translate([0, 0, -ext0]));
  const cut = T(tube.subtract(bolt));
  return cut;
}

/** The callout: "M10×1.5 - 6g, thread 20 long", "M10×1.5 - 6H, thread 12 deep", "Tr16×4 - 7e …"; modelled ones say so. */
export function threadCallout(form, size, { external, length, through = false, modelled = false } = {}) {
  const g = threadDims(form, size);
  if (!g) return '';
  const name = form === 'tr' ? sizeLabel(form, size) : `${size}×${fmt(g.p)}`;   // i18n-ignore: a thread designation
  const cls = form === 'tr' ? (external ? '7e' : '7H') : (external ? '6g' : '6H');   // i18n-ignore: ISO tolerance classes
  const key = through ? 'thread.callout.through' : external ? 'thread.callout.long' : 'thread.callout.deep';
  const text = t(key, { size: name, cls, length: fmt(length) });
  return modelled ? t('thread.callout.modelled', { callout: text }) : text;
}
const fmt = (v) => String(+Number(v).toFixed(3));

/** The drawing's thread notes from a rebuild's threads (either kernel): one per callout, with how many there are. */
export function threadNotes(threads) {
  return [...(threads || new Map()).values()].flatMap((th) => th.callouts || [{ callout: th.callout, count: th.list.length }]);
}

// ---------------------------------------------------------------- reading untrusted files

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Fill g from the untrusted feature f (part.js's reader context c, design-features.js's readers R). → true for a thread. */
export function readThread(f, g, c, R) {
  if (f.type !== 'thread') return false;
  const need = (ok, key) => { if (!ok) throw new Error(t(key, { name: g.name })); };   // key: "{name}: … is bad."
  need(THREAD_FORMS.includes(f.form), 'thread.file.bad.form');
  need(f.size === 'auto' || Object.hasOwn(THREAD_TABLES[f.form], f.size), 'model.file.bad.the_thread_size');
  need(f.length === null || f.length === undefined || num(f.length, 1e-3, 1e5), 'thread.file.bad.length');
  need(f.clearance === undefined || num(f.clearance, 0, 5), 'thread.file.bad.clearance');
  need(f.hand === undefined || THREAD_HANDS.includes(f.hand), 'thread.file.bad.hand');
  need(Array.isArray(f.faces) && f.faces.length <= 100, 'model.file.list.the_face_list');
  let faces;
  try { faces = f.faces.map(R.faceRef); } catch (e) { throw new Error(t('model.file.in.its_faces', { name: g.name, problem: e.message.replace(/\.$/, '') })); }
  Object.assign(g, { faces, form: f.form, size: f.size, length: f.length ?? null, flip: f.flip === true, modelled: f.modelled === true,
    clearance: f.clearance ?? DEFAULT_CLEARANCE, hand: f.hand ?? 'right' });
  return true;
}

/** A hole's modelled-thread fields (written only when on, so older parts read back the same). */
export function readHoleThread(f, g) {
  if (f.modelled === undefined && f.clearance === undefined) return;
  if (f.clearance !== undefined && !num(f.clearance, 0, 5)) throw new Error(t('thread.file.bad.clearance', { name: g.name }));
  if (f.modelled === true) Object.assign(g, { modelled: true, clearance: f.clearance ?? DEFAULT_CLEARANCE });
}

export const usesThread = (part) => part.features.some((f) => f.type === 'thread' || (f.type === 'hole' && f.modelled));
