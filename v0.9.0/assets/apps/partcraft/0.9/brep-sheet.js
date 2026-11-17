/* SPDX-License-Identifier: Apache-2.0 */
/**
 * brep-sheet.js — the sheet metal features' solids with OpenCascade (0.4 P15, P16): installSheet(FEATURES, LIB) adds
 *   sheetbase   a closed profile → a plate t thick (prism along the sketch's normal; reverse: the other way);
 *               an open chain of lines → sheetmetal.js bentProfile (bends of inner radius r; the thickness on the inside of
 *               the first bend, reverse: outside — the same whichever end the chain is drawn from) → prism `depth` along the normal.
 *               Faces: `<id>.side:s<n>` (the profile's segments, in bentProfile's order) + caps `<id>.start` / `<id>.end`
 *               (an open profile), or the sketch's ids (a plate, as extrude names them).
 *   sheetflange on a straight edge between a big face (the sheet's top or bottom) and a side face of thickness t:
 *               a bend (inner radius r, about an axis r off the big face, at the side face) + a flat leg `length` long,
 *               swept along the edge less the offsets. Relief: a slot reliefWidth wide, r + t deep, through the sheet,
 *               beside each end that is offset. Faces `<id>.side:{iarc,leg,tip,oleg,oarc,base}` + caps.
 * The sheet (t, r, k) is the last base flange before the feature (sheetmetal.js sheetOf).
 */
import * as V from './vec.js';
import { pointXY } from './sketch.js';
import { bentProfile, sheetOf, flatOfProfile, bendAllowance, lineChain } from './sheetmetal.js';
import { t } from './i18n.js';

export function installSheet(FEATURES, lib) {
  const { fail, SMap, profileCurves, profileFaces, nameSweep, sketchOf, nearest, describeName } = lib;

  /** The open chain of a sketch's non-construction lines, end to end (null when it is not one chain of lines). */
  function openChain(sk) {
    const lines = sk.entities.filter((e) => !e.construction && e.type !== 'point');
    if (!lines.length || lines.some((e) => e.type !== 'line')) return null;
    return lineChain(lines.map((e) => [pointXY(sk, e.p1), pointXY(sk, e.p2)]));
  }

  const sheetFor = (ctx, f) => {
    const i = ctx.part.features.findIndex((x) => x.id === f.id);
    const s = sheetOf(ctx.part, i);
    if (!s) fail(t('sheet.err.no_base'));
    return s;
  };

  FEATURES.sheetbase = (f, ctx) => {
    const { oc, T, H } = ctx;
    const { sk, frame } = sketchOf(ctx, f.sketch);
    const pr = profileCurves(sk);
    const dir = f.reverse ? -1 : 1;
    if (!pr.error && pr.loops.length) {
      // a plate: the closed profile, t thick
      const { faces, edgeOf } = profileFaces(oc, T, H, pr.loops, frame, dir > 0 ? 0 : -f.t);
      ctx.sheetmetal?.set(f.id, { kind: 'plate', frame, t: f.t, r: f.r, k: f.k });   // sheet-flat.js lays the part flat from these
      return { tools: faces.map((face) => {
        const mk = T(new oc.BRepPrimAPI_MakePrism(face, H.vec(V.mul(frame.n, f.t)), false, true));
        if (!mk.IsDone()) fail(t('sheet.err.build'));
        return { shape: T(mk.Shape()), op: 'add', names: nameSweep(ctx, mk, f.id, edgeOf, true) };
      }) };
    }
    const pts = openChain(sk);
    if (!pts) fail(pr.error && !/open/.test(pr.error) ? pr.error : t('sheet.err.profile'));
    // the thickness goes inside the first bend (reverse: outside), whichever end the chain is walked from
    const turn = pts.length > 2 ? Math.sign((pts[1][0] - pts[0][0]) * (pts[2][1] - pts[1][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[1][0])) : 0;
    let bp;
    try { bp = bentProfile(pts, { t: f.t, r: f.r, side: dir * (turn || 1) }); } catch (e) { fail(e.message); }
    const { faces, edgeOf } = profileFaces(oc, T, H, [bp.loop], frame, 0);
    if (faces.length !== 1) fail(t('sheet.err.build'));
    // the flat: viewed from the drawn face, a bend that turns toward the thickness takes the next leg away (down)
    const flat = flatOfProfile(bp, f.t, f.k), side = dir * (turn || 1);
    ctx.sheetmetal?.set(f.id, { kind: 'bent', frame, t: f.t, r: f.r, k: f.k, depth: f.depth, length: flat.length,
      bends: flat.lines.map((l, i) => ({ at: l.at, from: l.from, to: l.to, angle: Math.abs(l.angle), r: l.r, up: side * Math.sign(bp.bends[i].theta) < 0 })) });
    const mk = T(new oc.BRepPrimAPI_MakePrism(faces[0], H.vec(V.mul(frame.n, f.depth)), false, true));
    if (!mk.IsDone()) fail(t('sheet.err.build'));
    return { tools: [{ shape: T(mk.Shape()), op: 'add', names: nameSweep(ctx, mk, f.id, edgeOf, true) }] };
  };

  /** The edge flange's frame: A, B the edge's ends; e along it; v the big face's outward normal (flip: the other big
   *  face, A/B moved onto it); u the side face's outward normal. */
  function flangeFrame(ctx, f, sheet) {
    if (!ctx.body) fail(t('sheet.err.no_body'));
    if (!f.edge) fail(t('sheet.err.pick_edge'));
    const key = [...f.edge.faces].sort().join('|');
    const cands = ctx.edgeTable().filter((x) => x.key === key);
    if (!cands.length) fail(t('sheet.err.edge_gone', { a: describeName(ctx.part, f.edge.faces[0]), b: describeName(ctx.part, f.edge.faces[1]) }));
    const er = nearest(cands, f.edge.at, (x) => x.at);
    if (er.type !== 'line') fail(t('sheet.err.straight'));
    const faces = ctx.faceTable().filter((x) => f.edge.faces.includes(x.name) && x.type === 'plane' && ctx.H.explore(x.face, 'EDGE').some((g) => g.IsSame(er.edge)));
    if (faces.length !== 2) fail(t('sheet.err.planar'));
    const e = V.norm(V.sub(er.b, er.a));
    // the big face: the larger one; the side face must be t wide across the edge
    const [big, side] = faces[0].area >= faces[1].area ? faces : [faces[1], faces[0]];
    if (Math.abs(V.dot(big.n, side.n)) > 1e-6) fail(t('sheet.err.square'));
    let v = big.n, u = side.n, A = er.a, B = er.b;
    if (f.flip) { v = V.mul(v, -1); A = V.add(A, V.mul(v, sheet.t)); B = V.add(B, V.mul(v, sheet.t)); }   // onto the other big face
    // the sheet is t thick here: the side face reaches t below the edge
    const P = V.add(V.mul(V.add(A, B), 0.5), V.mul(v, -sheet.t * 0.5)), sideOk = Math.abs(V.dot(V.sub(P, side.o), side.n)) < 1e-6 * Math.max(1, V.len(P));
    if (!sideOk) fail(t('sheet.err.thickness', { t: sheet.t }));
    return { A, B, e, u, v, len: V.len(V.sub(B, A)) };
  }

  FEATURES.sheetflange = (f, ctx) => {
    const { oc, T, H } = ctx;
    const sheet = sheetFor(ctx, f);
    const { A, e, u, v, len } = flangeFrame(ctx, f, sheet);
    const [o0, o1] = f.offsets, run = len - o0 - o1;
    if (!(run > 1e-6)) fail(t('sheet.err.offsets', { len: +len.toFixed(4) }));
    const r = sheet.r, th = sheet.t, ang = f.angle * Math.PI / 180;
    // the section in (u, v) about the start of the flange's run; C = the bend centre
    const S0 = V.add(A, V.mul(e, o0));
    const W = (p) => V.add(S0, V.add(V.mul(u, p[0]), V.mul(v, p[1])));
    const C = [0, r];
    const at = (rad, phi) => [C[0] + rad * Math.cos(phi), C[1] + rad * Math.sin(phi)];
    const p0 = -Math.PI / 2, p1 = p0 + ang, pm = p0 + ang / 2;
    const tan = [-Math.sin(p1), Math.cos(p1)];
    const Ie = at(r, p1), Oe = at(r + th, p1);
    const It = [Ie[0] + tan[0] * f.length, Ie[1] + tan[1] * f.length], Ot = [Oe[0] + tan[0] * f.length, Oe[1] + tan[1] * f.length];
    const P0 = [0, 0], Q0 = [0, -th];
    const edgeOf = new Map();
    const vtx = new Map();
    const V3 = (p) => { const k = p.join(','); let x = vtx.get(k); if (!x) { x = T(T(new oc.BRepBuilderAPI_MakeVertex(H.pnt(W(p)))).Vertex()); vtx.set(k, x); } return x; };
    const line = (id, a, b) => { const ed = T(T(new oc.BRepBuilderAPI_MakeEdge(V3(a), V3(b))).Edge()); edgeOf.set(id, ed); return ed; };
    const arc = (id, a, m, b) => { const c = T(T(new oc.GC_MakeArcOfCircle(H.pnt(W(a)), H.pnt(W(m)), H.pnt(W(b)))).Value()); const ed = T(T(new oc.BRepBuilderAPI_MakeEdge(c, V3(a), V3(b))).Edge()); edgeOf.set(id, ed); return ed; };
    const mw = T(new oc.BRepBuilderAPI_MakeWire());
    if (r > 1e-9) mw.Add(arc('iarc', P0, at(r, pm), Ie));
    mw.Add(line('leg', r > 1e-9 ? Ie : P0, It));
    mw.Add(line('tip', It, Ot));
    mw.Add(line('oleg', Ot, Oe));
    mw.Add(arc('oarc', Oe, at(r + th, pm), Q0));
    mw.Add(line('base', Q0, P0));
    if (!mw.IsDone()) fail(t('sheet.err.build'));
    const mf = T(new oc.BRepBuilderAPI_MakeFace(T(mw.Wire()), true));
    if (!mf.IsDone()) fail(t('sheet.err.build'));
    const mk = T(new oc.BRepPrimAPI_MakePrism(T(mf.Face()), H.vec(V.mul(e, run)), false, true));
    if (!mk.IsDone()) fail(t('sheet.err.build'));
    // for the flat (sheet-flat.js): the bend's frame; the leg's inner face lies on the line Ie + w·tan, w 0…length
    ctx.sheetmetal?.set(f.id, { kind: 'flange', base: sheet.id, S0, e, u, v, run, angle: f.angle, theta: ang, r, t: th, length: f.length,
      ba: bendAllowance(ang, r, th, sheet.k), C: W(C), Ie: W(Ie), tan: V.add(V.mul(u, tan[0]), V.mul(v, tan[1])), nIn: V.mul(V.add(V.mul(u, Math.cos(p1)), V.mul(v, Math.sin(p1))), -1) });
    const tools = [];
    // bend reliefs beside each offset end: through the sheet, r + t deep into it
    if (f.relief === 'rect') {
      const deep = r + th, w = f.reliefWidth;
      const slot = (s0, s1) => {
        if (!(s1 - s0 > 1e-6)) return;
        // gp_Ax2(o, N = u × e, X = u): Y = N × X = e; the box spans 2t along N, centred on the sheet whichever way N points
        const N = V.cross(u, e), up = V.dot(N, v) > 0;
        const o = V.add(A, V.add(V.mul(e, s0), V.add(V.mul(u, -deep), V.mul(v, up ? -th * 1.5 : th * 0.5))));
        const mb = T(new oc.BRepPrimAPI_MakeBox(T(new oc.gp_Ax2(H.pnt(o), H.dir(N), H.dir(u))), deep + 1e-3 * Math.max(1, deep), s1 - s0, th * 2));
        const shape = T(mb.Shape()), names = new SMap(H.hash);
        H.unique(shape, 'FACE').forEach((fc, i) => names.set(fc, `${f.id}.relief:${i}`));   // i18n-ignore: a face name
        tools.push({ shape, op: 'cut', names });
      };
      if (o0 > 1e-9) slot(Math.max(0, o0 - w), o0);
      if (o1 > 1e-9) slot(len - o1, Math.min(len, len - o1 + w));
    }
    tools.push({ shape: T(mk.Shape()), op: 'add', names: nameSweep(ctx, mk, f.id, edgeOf, true) });
    return { tools };
  };

  return { openChain };
}
