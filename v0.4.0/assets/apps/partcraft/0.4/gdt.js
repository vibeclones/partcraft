/* SPDX-License-Identifier: Apache-2.0 */
/**
 * gdt.js — GD&T and surface-finish annotations on PartCraft drawings (DOM-free).
 * Every symbol is our own vector geometry (polylines and filled polygons); only plain letters and
 * numbers are text (Helvetica, WinAnsi), so the PDF needs no symbol font.
 *
 * Annotation (stored in the part file under part.drawing.notes):
 *   common  { id:'g<n>', kind:'datum'|'fcf'|'finish', view, at:[u,v] (model mm in the view's 2D
 *             coordinates — the caller turns it into sheet mm), off:[dx,dy] (sheet mm from the
 *             attachment point to the symbol) }
 *   datum   { letter }                                  datum feature symbol (ASME Y14.5)
 *   fcf     { char, dia, tol, mod, datums:[{letter, mod}] }   feature control frame (ASME Y14.5)
 *   finish  { ra, process:'any'|'removal'|'noRemoval', note }  surface texture (ASME Y14.36 / ISO 1302)
 *
 * Proportions: ASME Y14.5-2018 Fig. 3-1 / 3-2 give symbol sizes as multiples of the lettering
 * height h: frame height 2h, characteristic symbols about 1.5h, datum frame 2h square, datum
 * triangle base about h (we use 3 mm for h = 3.5). The surface texture symbol follows ISO 1302
 * (short leg H1 = 1.4h, long leg H2 = 3h, legs at 60° to the surface). Exact standard figures we
 * are not sure of are not claimed: the shapes are drawn to these ratios, not traced.
 * Display list units: sheet millimetres, origin lower-left, y up (as drawing.js makeDrawing).
 */
import { charAdvance } from './font.js';
import { t as tr } from './i18n.js';

export const DRAW = {
  h: 3.5,          // lettering height (mm)
  frame: 0.35,     // feature control frame, datum frame, symbol lines
  leader: 0.25,    // leaders
  arrowL: 3, arrowW: 0.9,   // leader arrowhead (as drawing.js dimensions)
  pad: 1.2,        // space each side of compartment contents
};

export const CHARACTERISTICS = {
  straightness: { get label() { return tr('model.gdt.char.straightness'); }, group: 'form', datums: 'none', dia: true, mod: true },
  flatness: { get label() { return tr('model.gdt.char.flatness'); }, group: 'form', datums: 'none', dia: false, mod: false },
  circularity: { get label() { return tr('model.gdt.char.circularity'); }, group: 'form', datums: 'none', dia: false, mod: false },
  cylindricity: { get label() { return tr('model.gdt.char.cylindricity'); }, group: 'form', datums: 'none', dia: false, mod: false },
  profileLine: { get label() { return tr('model.gdt.char.profile_line'); }, group: 'profile', datums: 'optional', dia: false, mod: false },
  profileSurface: { get label() { return tr('model.gdt.char.profile_surface'); }, group: 'profile', datums: 'optional', dia: false, mod: false },
  perpendicularity: { get label() { return tr('model.gdt.char.perpendicularity'); }, group: 'orientation', datums: 'required', dia: true, mod: true },
  angularity: { get label() { return tr('model.gdt.char.angularity'); }, group: 'orientation', datums: 'required', dia: true, mod: true },
  parallelism: { get label() { return tr('model.gdt.char.parallelism'); }, group: 'orientation', datums: 'required', dia: true, mod: true },
  position: { get label() { return tr('model.gdt.char.position'); }, group: 'location', datums: 'required', dia: true, mod: true },
  concentricity: { get label() { return tr('model.gdt.char.concentricity'); }, group: 'location', datums: 'required', dia: true, mod: false, legacy: true },
  symmetry: { get label() { return tr('model.gdt.char.symmetry'); }, group: 'location', datums: 'required', dia: false, mod: false, legacy: true },
  circularRunout: { get label() { return tr('model.gdt.char.circular_runout'); }, group: 'runout', datums: 'required', dia: false, mod: false },
  totalRunout: { get label() { return tr('model.gdt.char.total_runout'); }, group: 'runout', datums: 'required', dia: false, mod: false },
};

/** Y14.5 does not use I, O or Q as datum letters (they read as 1, 0 and O). */
export const DATUM_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'.split('');
export const VIEW_NAMES = ['front', 'top', 'right', 'iso', 'section', 'detail'];
export const PROCESSES = {
  get any() { return tr('model.gdt.process.any'); },
  get removal() { return tr('model.gdt.process.removal'); },
  get noRemoval() { return tr('model.gdt.process.no_removal'); },
};
const MODS = ['', 'M', 'L'];

export function newAnnotation(kind, props = {}) {
  const base = { id: props.id || 'g1', kind, view: props.view || 'front', at: props.at ? [...props.at] : [0, 0], off: props.off ? [...props.off] : [12, 10] };
  if (kind === 'datum') return { ...base, letter: props.letter || 'A' };
  if (kind === 'fcf') {
    const char = props.char || 'position';
    const c = CHARACTERISTICS[char];
    return {
      ...base, char, dia: props.dia ?? (char === 'position'), tol: props.tol ?? 0.1, mod: props.mod || '',
      datums: props.datums ? props.datums.map((d) => ({ letter: d.letter, mod: d.mod || '' })) : c && c.datums === 'required' ? [{ letter: 'A', mod: '' }] : [],
    };
  }
  if (kind === 'finish') return { ...base, ra: props.ra ?? 1.6, process: props.process || 'removal', note: props.note || '' };
  throw new Error(tr('model.gdt.unknown_kind'));
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** null when the annotation is right, else a plain-English reason. */
export function validate(a) {
  if (!a || typeof a !== 'object') return tr('model.gdt.missing');
  if (!VIEW_NAMES.includes(a.view)) return tr('model.gdt.unknown_view');
  if (a.kind === 'datum') return DATUM_LETTERS.includes(a.letter) ? null : tr('model.gdt.datum_letter');
  if (a.kind === 'finish') {
    if (!fin(a.ra) || a.ra <= 0 || a.ra > 1000) return tr('model.gdt.ra_range');
    if (!PROCESSES[a.process]) return tr('model.gdt.process_unknown');
    if (typeof a.note !== 'string' || a.note.length > 40) return tr('model.gdt.note_long');
    return null;
  }
  if (a.kind !== 'fcf') return tr('model.gdt.unknown_kind');
  const c = CHARACTERISTICS[a.char];
  if (!c) return tr('model.gdt.unknown_char');
  if (!fin(a.tol) || a.tol <= 0 || a.tol > 1000) return tr('model.gdt.tol_range');
  if (a.dia && !c.dia) return tr('model.gdt.no_dia', { label: c.label });
  if (!MODS.includes(a.mod)) return tr('model.gdt.mod_values');
  if (a.mod && !c.mod) return tr('model.gdt.no_mod', { label: c.label });
  if (!Array.isArray(a.datums) || a.datums.length > 3) return tr('model.gdt.max_datums');
  if (c.datums === 'none' && a.datums.length) return tr('model.gdt.form_no_datums', { label: c.label });
  if (c.datums === 'required' && !a.datums.length) return tr('model.gdt.needs_datum', { label: c.label });
  const seen = new Set();
  for (const d of a.datums) {
    if (!d || !DATUM_LETTERS.includes(d.letter)) return tr('model.gdt.datum_ref_letter');
    if (seen.has(d.letter)) return tr('model.gdt.datum_twice', { letter: d.letter });
    seen.add(d.letter);
    if (!MODS.includes(d.mod)) return tr('model.gdt.datum_mod_values');
    // kept simple: datum modifiers only where the characteristic itself takes modifiers
    if (d.mod && !c.mod) return tr('model.gdt.no_datum_mod', { label: c.label });
  }
  return null;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);

/** Check untrusted notes from a file; returns clean copies or throws Error. */
export function readNotes(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(tr('model.gdt.notes_not_list'));
  if (raw.length > 500) throw new Error(tr('model.gdt.notes_too_many'));
  const ids = new Set();
  const pair = (v, lim) => Array.isArray(v) && v.length === 2 && v.every((x) => fin(x) && Math.abs(x) <= lim);
  return raw.map((n, i) => {
    const bad = (key) => new Error(tr(key, { n: i + 1 }));
    if (!n || typeof n !== 'object') throw bad('model.gdt.note.not_note');
    if (typeof n.id !== 'string' || !/^g\d{1,9}$/.test(n.id) || ids.has(n.id)) throw bad('model.gdt.note.bad_id');
    ids.add(n.id);
    if (!['datum', 'fcf', 'finish'].includes(n.kind)) throw bad('model.gdt.note.unknown_kind');
    if (!VIEW_NAMES.includes(n.view)) throw bad('model.gdt.note.unknown_view');
    if (!pair(n.at, 1e6)) throw bad('model.gdt.note.bad_at');
    if (!pair(n.off, 2000)) throw bad('model.gdt.note.bad_off');
    const a = { id: n.id, kind: n.kind, view: n.view, at: [...n.at], off: [...n.off] };
    if (n.kind === 'datum') a.letter = clean(n.letter, 2);
    else if (n.kind === 'finish') Object.assign(a, { ra: n.ra, process: n.process, note: clean(n.note, 40) });
    else {
      if (!Array.isArray(n.datums) || n.datums.length > 3) throw bad('model.gdt.note.bad_datums');
      Object.assign(a, { char: n.char, dia: n.dia === true, tol: n.tol, mod: n.mod ?? '', datums: n.datums.map((d) => ({ letter: clean(d && d.letter, 2), mod: (d && d.mod) ?? '' })) });
    }
    const why = validate(a);
    if (why) throw new Error(tr('model.gdt.note.invalid', { n: i + 1, why: why.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) }));
    return a;
  });
}

const num = (v) => String(Number(v.toFixed(4)));

/** Short ASCII description for lists. */
export function describe(a) {
  if (a.kind === 'datum') return tr('model.gdt.describe.datum', { letter: a.letter });
  if (a.kind === 'finish') return a.note ? tr('model.gdt.describe.finish_note', { ra: num(a.ra), process: PROCESSES[a.process], note: a.note }) : tr('model.gdt.describe.finish', { ra: num(a.ra), process: PROCESSES[a.process] });
  const c = CHARACTERISTICS[a.char];
  const m = (x) => (x ? ' (' + x + ')' : '');
  const label = c.label.replace(/ \(.*\)$/, ''), tol = num(a.tol);
  return [(a.dia ? tr('model.gdt.describe.tol_dia', { label, tol }) : tr('model.gdt.describe.tol', { label, tol })) + m(a.mod), ...a.datums.map((d) => d.letter + m(d.mod))].join(' | ');
}

// ---------------------------------------------------------------- geometry

export function circlePts(c, r, n = 32, a0 = 0, sweep = 2 * Math.PI) {
  const pts = [];
  const closed = Math.abs(sweep - 2 * Math.PI) < 1e-12;
  const m = closed ? n : n;
  for (let i = 0; i <= m; i++) { const t = a0 + sweep * i / n; pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return pts;
}
const poly = (pts, segs) => { for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]); };
const textW = (s, size) => { let w = 0; for (const ch of s) w += charAdvance(ch); return w / 1000 * size; };

function arrowHead(fills, tip, from) {
  const dx = tip[0] - from[0], dy = tip[1] - from[1], l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l, L = DRAW.arrowL, w = DRAW.arrowW;
  fills.push({ pts: [[tip[0], tip[1]], [tip[0] - ux * L - uy * w, tip[1] - uy * L + ux * w], [tip[0] - ux * L + uy * w, tip[1] - uy * L - ux * w]] });
}

/** Characteristic symbol centred at c, about 1.5h tall (Y14.5 Fig. 3-1 proportions). */
function charSymbol(key, c, segs, fills) {
  const r = 0.75 * DRAW.h;       // half of 1.5h
  const [cx, cy] = c;
  const L = (x1, y1, x2, y2) => segs.push([cx + x1 * r, cy + y1 * r, cx + x2 * r, cy + y2 * r]);
  const C = (x, y, rr, a0 = 0, sw = 2 * Math.PI, n = 32) => poly(circlePts([cx + x * r, cy + y * r], rr * r, n, a0, sw), segs);
  const s60 = Math.sin(Math.PI / 3), c60 = Math.cos(Math.PI / 3);
  switch (key) {
    case 'straightness': L(-1, 0, 1, 0); break;
    case 'flatness': L(-1, -0.4, 0.55, -0.4); L(0.55, -0.4, 1, 0.4); L(1, 0.4, -0.55, 0.4); L(-0.55, 0.4, -1, -0.4); break;
    case 'circularity': C(0, 0, 0.85); break;
    case 'cylindricity': {
      C(0, 0, 0.55);
      // two lines at 60° tangent to the circle
      const nx = -s60, ny = c60;
      for (const s of [1, -1]) L(nx * 0.55 * s - c60 * 1.1, ny * 0.55 * s - s60 * 1.1, nx * 0.55 * s + c60 * 1.1, ny * 0.55 * s + s60 * 1.1);
      break;
    }
    case 'profileLine': C(0, -0.45, 0.95, 0, Math.PI, 24); break;
    case 'profileSurface': C(0, -0.45, 0.95, 0, Math.PI, 24); L(-0.95, -0.45, 0.95, -0.45); break;
    case 'perpendicularity': L(-0.9, -0.85, 0.9, -0.85); L(0, -0.85, 0, 0.95); break;
    case 'angularity': {
      const len = 2.1, a = Math.PI / 6;
      L(-0.95, -0.75, 0.95, -0.75); L(-0.95, -0.75, -0.95 + len * Math.cos(a), -0.75 + len * Math.sin(a));
      break;
    }
    case 'parallelism': for (const dx of [-0.35, 0.35]) L(dx - c60 * 1.05, -s60 * 1.05, dx + c60 * 1.05, s60 * 1.05); break;
    case 'position': C(0, 0, 0.6); L(-1, 0, 1, 0); L(0, -1, 0, 1); break;
    case 'concentricity': C(0, 0, 0.4); C(0, 0, 0.9); break;
    case 'symmetry': L(-0.6, 0.5, 0.6, 0.5); L(-1, 0, 1, 0); L(-0.6, -0.5, 0.6, -0.5); break;
    case 'circularRunout': case 'totalRunout': {
      // 45° arrow(s) with filled heads (the arrow of runout); total runout: two, joined at the foot
      const xs = key === 'totalRunout' ? [-0.75, 0.15] : [-0.4];
      for (const x0 of xs) {
        const a = [cx + x0 * r, cy - 0.9 * r], b = [cx + (x0 + 1.1) * r, cy + 0.6 * r];
        segs.push([a[0], a[1], b[0], b[1]]);
        const ux = (b[0] - a[0]), uy = (b[1] - a[1]), l = Math.hypot(ux, uy);
        const tip = [b[0] + ux / l * 0.45 * r, b[1] + uy / l * 0.45 * r];
        const k = 0.5 * r, w = 0.22 * r;
        fills.push({ pts: [tip, [tip[0] - ux / l * k - uy / l * w, tip[1] - uy / l * k + ux / l * w], [tip[0] - ux / l * k + uy / l * w, tip[1] - uy / l * k - ux / l * w]] });
      }
      if (key === 'totalRunout') L(-0.75, -0.9, 0.15, -0.9);
      break;
    }
    default: throw new Error('Unknown characteristic ' + key);   // i18n-ignore: developer error (validate() refuses unknown characteristics first)
  }
}

/** Diameter symbol (circle with a 60° slash), centred at c, about cap height. */
function diaSymbol(c, segs) {
  const r = 0.36 * DRAW.h;
  poly(circlePts(c, r, 32), segs);
  const l = r * 1.35, a = Math.PI / 3;
  segs.push([c[0] - l * Math.cos(a), c[1] - l * Math.sin(a), c[0] + l * Math.cos(a), c[1] + l * Math.sin(a)]);
}
const DIA_W = 0.9 * DRAW.h;

/** Material modifier: circled M or L, the letter drawn as strokes. */
function modSymbol(letter, c, segs) {
  const r = 0.48 * DRAW.h;
  poly(circlePts(c, r, 32), segs);
  const u = r * 0.5, [x, y] = c;
  if (letter === 'M') poly([[x - u, y - u], [x - u, y + u], [x, y - 0.1 * u], [x + u, y + u], [x + u, y - u]], segs);
  else poly([[x - 0.6 * u, y + u], [x - 0.6 * u, y - u], [x + 0.75 * u, y - u]], segs);
}
const MOD_W = 1.05 * DRAW.h;

function boxOf(strokes, fills, texts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const s of strokes) for (const g of s.segs) { add(g[0], g[1]); add(g[2], g[3]); }
  for (const f of fills) for (const p of f.pts) add(p[0], p[1]);
  for (const t of texts) {
    const w = textW(t.text, t.size), dx = t.anchor === 'middle' ? -w / 2 : t.anchor === 'end' ? -w : 0;
    add(t.x + dx, t.y - 0.25 * t.size); add(t.x + dx + w, t.y + 0.75 * t.size);
  }
  return [x0, y0, x1, y1];
}

/** Nearest point of a rectangle [x0,y0,x1,y1] to p (p itself when inside). */
function nearestOnBox(b, p) { return [Math.min(b[2], Math.max(b[0], p[0])), Math.min(b[3], Math.max(b[1], p[1]))]; }
const inside = (b, p) => p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];

/**
 * Geometry of one annotation with its attachment point at `anchor` (sheet mm).
 * → { strokes:[{width, segs}], fills:[{pts}], texts, box:[x0,y0,x1,y1], parts? }
 * `parts` (fcf) lists the compartment rectangles, for tests and hit tests.
 */
export function annotationGeometry(a, anchor) {
  const h = DRAW.h;
  const frame = { width: DRAW.frame, segs: [] }, leader = { width: DRAW.leader, segs: [] };
  const fills = [], texts = [];
  const P = [anchor[0] + a.off[0], anchor[1] + a.off[1]];
  const out = { strokes: [frame, leader], fills, texts };
  const rect = (x0, y0, x1, y1, segs) => segs.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]);
  const leaderTo = (from) => { if (Math.hypot(anchor[0] - from[0], anchor[1] - from[1]) > DRAW.arrowL * 1.2) { leader.segs.push([from[0], from[1], anchor[0], anchor[1]]); arrowHead(fills, anchor, from); } };

  if (a.kind === 'fcf') {
    const H = 2 * h, pad = DRAW.pad, y0 = P[1] - H / 2, y1 = P[1] + H / 2, ty = P[1] - 0.35 * h;
    const parts = [];
    let x = P[0];
    // [symbol]
    parts.push({ kind: 'char', box: [x, y0, x + H, y1] });
    charSymbol(a.char, [x + H / 2, P[1]], frame.segs, fills);
    x += H;
    // [dia tol mod]
    const tolText = num(a.tol);
    let w = pad + (a.dia ? DIA_W : 0) + textW(tolText, h) + (a.mod ? 0.6 + MOD_W : 0) + pad;
    w = Math.max(w, H);
    let cx = x + pad;
    if (a.dia) { diaSymbol([cx + DIA_W / 2, P[1]], frame.segs); cx += DIA_W; }
    texts.push({ x: cx, y: ty, size: h, text: tolText, anchor: 'start' });
    cx += textW(tolText, h);
    if (a.mod) modSymbol(a.mod, [cx + 0.6 + MOD_W / 2, P[1]], frame.segs);
    parts.push({ kind: 'tol', box: [x, y0, x + w, y1] });
    x += w;
    // [datum mod] …
    for (const d of a.datums) {
      const dw = Math.max(H, pad + textW(d.letter, h) + (d.mod ? 0.6 + MOD_W : 0) + pad);
      const inner = textW(d.letter, h) + (d.mod ? 0.6 + MOD_W : 0);
      const sx = x + (dw - inner) / 2;
      texts.push({ x: sx, y: ty, size: h, text: d.letter, anchor: 'start' });
      if (d.mod) modSymbol(d.mod, [sx + textW(d.letter, h) + 0.6 + MOD_W / 2, P[1]], frame.segs);
      parts.push({ kind: 'datum', letter: d.letter, box: [x, y0, x + dw, y1] });
      x += dw;
    }
    rect(P[0], y0, x, y1, frame.segs);
    for (const p of parts.slice(1)) frame.segs.push([p.box[0], y0, p.box[0], y1]);
    const fb = [P[0], y0, x, y1];
    if (!inside(fb, anchor)) leaderTo(nearestOnBox(fb, anchor));
    out.parts = parts;
    out.frameBox = fb;
  } else if (a.kind === 'datum') {
    // square frame 2h centred at P, letter centred; leader to an equilateral filled triangle whose base sits on the feature at the anchor
    const S = 2 * h;
    const fb = [P[0] - S / 2, P[1] - S / 2, P[0] + S / 2, P[1] + S / 2];
    rect(fb[0], fb[1], fb[2], fb[3], frame.segs);
    texts.push({ x: P[0], y: P[1] - 0.35 * h, size: h, text: a.letter, anchor: 'middle' });
    // the triangle sits on the feature (drawn square to the nearer sheet axis, as a surface seen
    // edge-on in an orthographic view); the leader may run at any angle from the frame to its apex
    const dx = P[0] - anchor[0], dy = P[1] - anchor[1];
    const vertical = Math.abs(dx) <= 2 * Math.abs(dy);   // apex up or down unless the leader runs mostly sideways
    const ux = vertical ? 0 : Math.sign(dx), uy = vertical ? (dy < 0 ? -1 : 1) : 0;   // from the feature toward the frame
    const side = 3, th = side * Math.sqrt(3) / 2;
    const apex = [anchor[0] + ux * th, anchor[1] + uy * th];
    fills.push({ pts: [[anchor[0] - uy * side / 2, anchor[1] + ux * side / 2], [anchor[0] + uy * side / 2, anchor[1] - ux * side / 2], apex] });
    const start = nearestOnBox(fb, apex);
    if (!inside(fb, apex) && Math.hypot(start[0] - apex[0], start[1] - apex[1]) > 1e-9) leader.segs.push([start[0], start[1], apex[0], apex[1]]);
    out.frameBox = fb;
    out.triangle = fills[0].pts;
  } else if (a.kind === 'finish') {
    // ISO 1302: legs at 60° to the surface, short leg H1 = 1.4h, long leg H2 = 3h. The requirement
    // (here Ra) is written under the long leg's horizontal extension (ISO 1302 position "a").
    const H1 = 1.4 * h, H2 = 3 * h, k = 1 / Math.tan(Math.PI / 3);
    const tip = P;
    const sTop = [tip[0] - H1 * k, tip[1] + H1], lTop = [tip[0] + H2 * k, tip[1] + H2];
    frame.segs.push([tip[0], tip[1], sTop[0], sTop[1]], [tip[0], tip[1], lTop[0], lTop[1]]);
    if (a.process === 'removal') frame.segs.push([sTop[0], sTop[1], tip[0] + H1 * k, tip[1] + H1]);
    if (a.process === 'noRemoval') { const rc = H1 / 3; poly(circlePts([tip[0], tip[1] + 2 * rc], rc, 32), frame.segs); out.circle = { c: [tip[0], tip[1] + 2 * rc], r: rc }; }
    const raText = 'Ra ' + num(a.ra);
    const ext = Math.max(textW(raText, h), a.note ? textW(a.note, 2.5) : 0) + 2;
    frame.segs.push([lTop[0], lTop[1], lTop[0] + ext, lTop[1]]);
    texts.push({ x: lTop[0] + 1, y: lTop[1] - 1 - 0.75 * h, size: h, text: raText, anchor: 'start' });
    if (a.note) texts.push({ x: lTop[0] + 1, y: lTop[1] + 1, size: 2.5, text: a.note, anchor: 'start' });
    if (Math.hypot(a.off[0], a.off[1]) > 1e-9) leaderTo(tip);
  } else throw new Error(tr('model.gdt.unknown_kind'));
  out.box = boxOf(out.strokes, fills, texts);
  return out;
}
