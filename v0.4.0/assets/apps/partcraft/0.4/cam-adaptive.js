/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cam-adaptive.js — 2D adaptive clearing (0.4 P24; DOM-free): passes that keep the cutter's radial engagement near a set width
 * w all the way, instead of the full-width cuts an offset pocket makes in corners and on its first pass.
 *
 * Method (on a raster of the region, cell h ≈ R/12, capped in size): the distance from each cell to the walls (exact, from the
 * region's curves: cam-offset distToLoops) says where the tool centre may go (≥ R + leave). The tool enters by a helix where
 * it is farthest from the walls. Then, while material the tool can reach is left: the distance from each cell to the
 * remaining material (an exact Euclidean distance transform, Felzenszwalb–Huttenlocher) gives the next pass as the contour
 * at R − w from it (marching squares) — the tool centre there cuts exactly w into the material — clipped where it would come
 * nearer the walls than R + leave (those stretches follow the wall). Loops that cut nothing are dropped; the rest are
 * oriented for climb milling (material on the tool's right), simplified (Douglas–Peucker, h / 4) and swept into the
 * cleared area before the next pass. Passes are linked nearest-next, staying down when the straight move is through
 * cleared air (and away from the walls), else retracting.
 *
 *   adaptivePasses(loops, { R, w, leave = 0, helixR = R / 2, h = null, maxCells = 300000 })
 *     → { passes: [[x, y] …] (closed loops, in cutting order), links: ['down' | 'up'] (before each pass but the first),
 *         entry: { c, r }, cell, stats: { passes, rows, cols, leftover (mm² of material within reach left uncut) } }
 *   engagementCheck(loops, { R, entry, passes, links, leave }, { h }) → { angle (the largest engagement angle, degrees: the
 *     arc of the cutter's rim in material at a step, measured before the step cuts), width (R (1 − cos angle): the radial
 *     depth of a straight cut with that angle), meanAngle, uncut (mm² the tool could reach but did not), gouge (min distance
 *     from a path point to the walls − R − leave; ≥ 0 means no gouge), at }   a separate re-simulation on its own raster
 */
import * as O from './cam-offset.js';
import { t } from './i18n.js';

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher 2012) of f into d (length n), with buffers v, z. */
function dt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
    if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
/** Euclidean distance (in cells) from every cell to the nearest cell where src is set. */
function edt(src, cols, rows) {
  const n = Math.max(cols, rows), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(cols * rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = src[y * cols + x] ? 0 : INF;
    dt1(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) g[y * cols + x] = d[y];
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = g[y * cols + x];
    dt1(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) g[y * cols + x] = Math.sqrt(d[x]);
  }
  return g;
}

/** The raster of a region: cell centres, inside mask, exact distance to the walls. */
function rasterOf(loops, R, h0, maxCells) {
  const [bx0, by0, bx1, by1] = O.boxOfLoops(loops);
  const W = bx1 - bx0, Hh = by1 - by0;
  let h = h0;
  while ((W / h + 3) * (Hh / h + 3) > maxCells) h *= 1.25;
  const cols = Math.ceil(W / h) + 3, rows = Math.ceil(Hh / h) + 3;
  const x0 = bx0 - h, y0 = by0 - h;
  const inside = new Uint8Array(cols * rows), wall = new Float64Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const q = [x0 + x * h, y0 + y * h], i = y * cols + x;
    inside[i] = O.inside(loops, q) ? 1 : 0;
    wall[i] = inside[i] ? O.distToLoops(q, loops) : 0;
  }
  return { h, cols, rows, x0, y0, inside, wall, at: (x, y) => [x0 + x * h, y0 + y * h] };
}

/** Closed iso-contours {F = 0} of a cell-centre field (F > 0 outside the region of interest; the border is > 0). */
function contours(F, cols, rows) {
  const segs = new Map();   // edge key → [other edge key, point] pairs via adjacency
  const pts = new Map(), adj = new Map();
  const ek = (x, y, dir) => (y * cols + x) * 2 + dir;   // dir 0: edge to (x+1, y); 1: edge to (x, y+1)
  const cross = (x, y, dir) => {
    const k = ek(x, y, dir);
    if (!pts.has(k)) {
      const a = F[y * cols + x], b = dir ? F[(y + 1) * cols + x] : F[y * cols + x + 1], t = a / (a - b);
      pts.set(k, dir ? [x, y + t] : [x + t, y]);
    }
    return k;
  };
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let y = 0; y + 1 < rows; y++) for (let x = 0; x + 1 < cols; x++) {
    const v = [F[y * cols + x], F[y * cols + x + 1], F[(y + 1) * cols + x + 1], F[(y + 1) * cols + x]];
    const c = (v[0] <= 0 ? 1 : 0) | (v[1] <= 0 ? 2 : 0) | (v[2] <= 0 ? 4 : 0) | (v[3] <= 0 ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const E = [() => cross(x, y, 0), () => cross(x + 1, y, 1), () => cross(x, y + 1, 0), () => cross(x, y, 1)];   // bottom, right, top, left
    const T = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]],
    }[c];
    if (T) { for (const [a, b] of T) link(E[a](), E[b]()); continue; }
    const mid = (v[0] + v[1] + v[2] + v[3]) / 4;
    if (c === 5) { if (mid <= 0) { link(E[3](), E[2]()); link(E[1](), E[0]()); } else { link(E[3](), E[0]()); link(E[1](), E[2]()); } }
    else if (c === 10) { if (mid <= 0) { link(E[0](), E[3]()); link(E[2](), E[1]()); } else { link(E[0](), E[1]()); link(E[2](), E[3]()); } }
  }
  void segs;
  const out = [], seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    for (let guard = 0; guard < 1e7; guard++) {
      seen.add(cur); loop.push(pts.get(cur));
      const nx = (adj.get(cur) || []).find((k) => k !== prev && !seen.has(k)) ?? null;
      if (nx === null) break;
      prev = cur; cur = nx;
    }
    if (loop.length >= 3) out.push(loop);
  }
  return out;
}

/** Douglas–Peucker on a closed loop. */
function simplify(loop, tol) {
  if (loop.length < 4) return loop;
  const keep = new Uint8Array(loop.length);
  const rec = (a, b) => {
    let worst = -1, wi = -1;
    const A = loop[a], B = loop[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((loop[i][0] - A[0]) * dy - (loop[i][1] - A[1]) * dx) / L; if (d > worst) { worst = d; wi = i; } }
    if (worst > tol) { keep[wi] = 1; rec(a, wi); rec(wi, b); }
  };
  const far = loop.reduce((bi, p, i) => (Math.hypot(p[0] - loop[0][0], p[1] - loop[0][1]) > Math.hypot(loop[bi][0] - loop[0][0], loop[bi][1] - loop[0][1]) ? i : bi), 0);
  keep[0] = keep[far] = 1;
  rec(0, far);
  const tail = [...loop.slice(far), loop[0]];
  const keep2 = new Uint8Array(tail.length);
  const rec2 = (a, b) => {
    let worst = -1, wi = -1;
    const A = tail[a], B = tail[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((tail[i][0] - A[0]) * dy - (tail[i][1] - A[1]) * dx) / L; if (d > worst) { worst = d; wi = i; } }
    if (worst > tol) { keep2[wi] = 1; rec2(a, wi); rec2(wi, b); }
  };
  rec2(0, tail.length - 1);
  const out = loop.filter((_, i) => keep[i] && i <= far);
  for (let i = 1; i < tail.length - 1; i++) if (keep2[i]) out.push(tail[i]);
  return out;
}

/** Mark every cell within r of the polyline (closed when `closed`). */
function sweep(mask, ras, poly, r, closed) {
  const { h, cols, rows, x0, y0 } = ras, rr = r * r;
  const n = poly.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const xa = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r - x0) / h)), xb = Math.min(cols - 1, Math.ceil((Math.max(a[0], b[0]) + r - x0) / h));
    const ya = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r - y0) / h)), yb = Math.min(rows - 1, Math.ceil((Math.max(a[1], b[1]) + r - y0) / h));
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const i2 = y * cols + x;
      if (mask[i2]) continue;
      const px = x0 + x * h - a[0], py = y0 + y * h - a[1];
      const t = L2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
      const ex = px - t * dx, ey = py - t * dy;
      if (ex * ex + ey * ey <= rr) mask[i2] = 1;
    }
  }
}
const area2 = (l) => l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);

/** The stretches of a closed loop where engaged(p) holds, each carried on `ext` mm into the air at both ends. → [{ pts, closed }] */
function engagedRuns(lp, engaged, ext) {
  const n = lp.length, e = lp.map(engaged);
  if (e.every(Boolean)) return [{ pts: lp, closed: true }];
  // grow each engaged point by ext along the loop, both ways
  const segL = lp.map((p, i) => Math.hypot(lp[(i + 1) % n][0] - p[0], lp[(i + 1) % n][1] - p[1]));
  const on = e.slice();
  for (let i = 0; i < n; i++) if (e[i]) {
    for (let k = 1, d = 0; k < n; k++) { d += segL[(i + k - 1) % n]; if (d > ext) break; on[(i + k) % n] = true; }
    for (let k = 1, d = 0; k < n; k++) { d += segL[(i - k + n) % n]; if (d > ext) break; on[(i - k + n) % n] = true; }
  }
  if (on.every(Boolean)) return [{ pts: lp, closed: true }];
  const start = on.findIndex((v) => !v), runs = [];
  let cur = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (on[i]) { if (!cur) cur = []; cur.push(lp[i]); } else if (cur) { if (cur.length >= 2) runs.push({ pts: cur, closed: false }); cur = null; }
  }
  if (cur && cur.length >= 2) runs.push({ pts: cur, closed: false });
  return runs;
}

export function adaptivePasses(loops, { R, w, leave = 0, helixR = null, h = null, maxCells = 300000 } = {}) {
  if (!(R > 0) || !(w > 0) || !(w < R)) throw new Error('adaptive: R > 0 and 0 < w < R.');   // i18n-ignore: a programming error
  const ras = rasterOf(loops, R, h || R / 12, maxCells), { cols, rows, inside, wall } = ras, cell = ras.h;
  const reach = R + leave, margin = 0.5 * cell;
  const allowed = new Uint8Array(cols * rows);
  let best = -1;
  for (let i = 0; i < cols * rows; i++) { if (inside[i] && wall[i] >= reach + margin) { allowed[i] = 1; if (best < 0 || wall[i] > wall[best]) best = i; } }
  if (best < 0) throw new Error(t('cam.adaptive.err.fit'));
  const c = ras.at(best % cols, Math.floor(best / cols));
  const er = Math.min(helixR ?? R / 2, Math.max(0, wall[best] - reach - margin));
  // cleared: what the tool sweeps; the helix entry first
  const cleared = new Uint8Array(cols * rows);
  sweep(cleared, ras, [c, c], R + er, false);
  // reachable material: inside cells within R of an allowed cell (the rest the tool can never touch)
  const dAllowed = edt(allowed, cols, rows);
  const reachable = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) reachable[i] = inside[i] && dAllowed[i] * cell <= R ? 1 : 0;
  const passes = [];
  const Fv = new Float64Array(cols * rows);
  for (let iter = 0; iter < 5000; iter++) {
    const mat = new Uint8Array(cols * rows);
    let left = 0;
    for (let i = 0; i < cols * rows; i++) if (reachable[i] && !cleared[i]) { mat[i] = 1; left++; }
    if (!left) break;
    const dM = edt(mat, cols, rows);
    // F ≤ 0: the cleared side at ≥ R − w from the material, and allowed
    for (let i = 0; i < cols * rows; i++) Fv[i] = allowed[i] ? (R - w) - dM[i] * cell : Math.max(1, (reach + margin) - wall[i]) + cell;
    const found = contours(Fv, cols, rows).map((l) => l.map(([x, y]) => [ras.x0 + x * cell, ras.y0 + y * cell]));
    let cut = 0;
    const engagedAt = (p) => { const x = Math.round((p[0] - ras.x0) / cell), y = Math.round((p[1] - ras.y0) / cell); return x >= 0 && y >= 0 && x < cols && y < rows && dM[y * cols + x] * cell <= R - w + 1.5 * cell; };
    for (let lp of found) {
      const eng = lp.map(engagedAt), engaged = eng.filter(Boolean).length;
      if (engaged < Math.max(2, 0.02 * lp.length)) continue;
      lp = simplify(lp, cell / 4);
      // material (F > 0 side) on the right: climb milling
      const a = lp[0], b = lp[1], nx = b[1] - a[1], ny = -(b[0] - a[0]), nl = Math.hypot(nx, ny) || 1;
      const q = [(a[0] + b[0]) / 2 + nx / nl * cell, (a[1] + b[1]) / 2 + ny / nl * cell];
      const xi = Math.round((q[0] - ras.x0) / cell), yi = Math.round((q[1] - ras.y0) / cell);
      if (xi >= 0 && yi >= 0 && xi < cols && yi < rows && Fv[yi * cols + xi] <= 0) lp = lp.reverse();
      // never nearer the walls than R + leave (the raster's interpolation): nudge such points inward
      lp = lp.map((p) => {
        const d = O.distToLoops(p, loops);
        if (d >= reach) return p;
        const near = loops.flat().reduce((bq, pr) => { const cq = O.closestOnPrim(p, pr); return !bq || cq.d < bq.d ? cq : bq; }, null);
        const ux = p[0] - near.p[0], uy = p[1] - near.p[1], ul = Math.hypot(ux, uy) || 1;
        return [near.p[0] + ux / ul * (reach + 1e-6), near.p[1] + uy / ul * (reach + 1e-6)];
      });
      // only the stretches that cut (each carried on 2 mm into air at both ends); a loop that cuts all round stays closed
      const runs = engagedRuns(lp, engagedAt, 2);
      for (const run of runs) {
        passes.push({ lp: run.pts, closed: run.closed, iter, dM: { grid: dM, ras } });
        sweep(cleared, ras, run.pts, R, run.closed);
      }
      cut++;
    }
    if (!cut) break;
  }
  // order: pass by pass as made (each assumes the ones before it are cut); within one round of passes, nearest-next; each loop
  // starts at its point nearest the tool. Then link down through cleared air, else up
  const order = [], used = new Set();
  let pos = [c[0] + er, c[1]];   // where the entry helix ends
  while (order.length < passes.length) {
    const it = Math.min(...passes.filter((_, i) => !used.has(i)).map((q) => q.iter));
    let bi = -1, bj = 0, bd = Infinity;
    passes.forEach((q, i) => { if (used.has(i) || q.iter !== it) return; (q.closed ? q.lp : [q.lp[0]]).forEach((p, j) => { const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]); if (d < bd) { bd = d; bi = i; bj = j; } }); });
    used.add(bi);
    const q = passes[bi], rot = q.closed ? [...q.lp.slice(bj), ...q.lp.slice(0, bj)] : q.lp;
    order.push({ pts: rot, closed: q.closed, dM: q.dM });
    pos = q.closed ? rot[0] : rot[rot.length - 1];
  }
  // a link stays down when it keeps R − w from the material left before that pass (so it bites no more than a pass) and
  // R + leave from the walls; else the tool lifts, moves and comes down at the start (in cleared air, ≤ w into material)
  const links = [];
  let from = [c[0] + er, c[1]];
  for (const q of order) {
    const to = q.pts[0], n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (cell / 2)));
    const { grid, ras: rs } = q.dM;
    let down = true;
    for (let k = 1; k < n && down; k++) {
      const p = [from[0] + (to[0] - from[0]) * k / n, from[1] + (to[1] - from[1]) * k / n];
      const x = Math.round((p[0] - rs.x0) / cell), y = Math.round((p[1] - rs.y0) / cell);
      if (O.distToLoops(p, loops) < reach - 1e-9 || !O.inside(loops, p) || !(x >= 0 && y >= 0 && x < cols && y < rows) || grid[y * cols + x] * cell < R - w) down = false;   // never biting more than a pass does
    }
    links.push(down ? 'down' : 'up');
    from = q.closed ? q.pts[0] : q.pts[q.pts.length - 1];
  }
  let leftover = 0;
  for (let i = 0; i < cols * rows; i++) if (reachable[i] && !cleared[i]) leftover++;
  return { passes: order.map((q) => q.pts), closed: order.map((q) => q.closed), links: links.slice(1), firstLink: links[0], entry: { c, r: er }, cell, stats: { passes: order.length, rows, cols, leftover: leftover * cell * cell } };
}

/** Re-simulate the passes on a separate, finer raster: the engagement (material area removed per mm of path) and what is left. */
export function engagementCheck(loops, { R, entry, passes, closed = null, links = null, leave = 0, finish = null }, { h = R / 20 } = {}) {
  const ras = rasterOf(loops, R, h, 2e6), { cols, rows, inside, wall } = ras, cell = ras.h;
  const allowed = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) allowed[i] = inside[i] && wall[i] >= R + leave ? 1 : 0;
  const dA = edt(allowed, cols, rows);
  const mat = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) mat[i] = inside[i] ? 1 : 0;
  const clearDisk = (p, r) => {
    let n = 0;
    const xa = Math.max(0, Math.floor((p[0] - r - ras.x0) / cell)), xb = Math.min(cols - 1, Math.ceil((p[0] + r - ras.x0) / cell));
    const ya = Math.max(0, Math.floor((p[1] - r - ras.y0) / cell)), yb = Math.min(rows - 1, Math.ceil((p[1] + r - ras.y0) / cell));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const i = y * cols + x; if (!mat[i]) continue; const dx = ras.x0 + x * cell - p[0], dy = ras.y0 + y * cell - p[1]; if (dx * dx + dy * dy <= r * r) { mat[i] = 0; n++; } }
    return n * cell * cell;
  };
  clearDisk(entry.c, R + entry.r);
  // the cutter's rim, sampled: the arc in material before each step cuts = the engagement angle there
  const NR = 360, rim = Array.from({ length: NR }, (_, k) => [Math.cos(2 * Math.PI * k / NR), Math.sin(2 * Math.PI * k / NR)]);
  const inMat = (q) => { const x = Math.round((q[0] - ras.x0) / cell), y = Math.round((q[1] - ras.y0) / cell); return x >= 0 && y >= 0 && x < cols && y < rows && mat[y * cols + x] === 1; };
  const rr = R - cell;   // just inside the rim, so the cells the step is about to cut are the ones counted
  let angle = 0, sumA = 0, nA = 0, gouge = Infinity, at = null, pos = [entry.c[0] + entry.r, entry.c[1]], inCut = 0, pathLen = 0;
  const step = cell;
  const along = (a, b, pi) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) {
      const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
      let m = 0;
      for (const [cx, cy] of rim) if (inMat([p[0] + cx * rr, p[1] + cy * rr])) m++;
      const ang = 360 * m / NR;
      if (ang > angle) { angle = ang; at = { pass: pi, p }; }
      sumA += ang; nA++; if (ang > 0) inCut += L / n; pathLen += L / n;
      clearDisk(p, R);
    }
  };
  for (const [pi, lp] of passes.entries()) {
    const isClosed = closed ? closed[pi] : true;
    if (!links || pi === 0 || links[pi - 1] !== 'up') along(pos, lp[0], pi); else clearDisk(lp[0], R);
    for (let i = 0; i < (isClosed ? lp.length : lp.length - 1); i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length];
      gouge = Math.min(gouge, O.distToLoops(a, loops) - R - leave);
      along(a, b, pi);
    }
    pos = isClosed ? lp[0] : lp[lp.length - 1];
  }
  // the wall pass (exact, at R + leave) the operation ends a level with
  for (const wl of finish || []) { for (const pr of wl) { const n = Math.max(1, Math.ceil(O.lengthOf(pr) / (cell / 2))); for (let k = 0; k <= n; k++) clearDisk(O.pointAt(pr, k / n), R); } }
  let uncut = 0;
  for (let i = 0; i < cols * rows; i++) if (mat[i] && dA[i] * cell <= R - 1.5 * cell) uncut++;
  return { angle, width: R * (1 - Math.cos(Math.min(180, angle) * Math.PI / 180)), meanAngle: nA ? sumA / nA : 0, uncut: uncut * cell * cell, gouge, at, pathLen, inCut };
}
