/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-plot-export.js — a script plot's geometry, drawing and export (DOM-free; 0.4 P9). The dock (cs-dock.js) paints plots on
 * screen with `paintPlot`, and exports them as PNG (the same painter on a white canvas), SVG and CSV.
 *   PLOT_PAPER                 the printed look: white paper, the paper theme's ink and layer colours (tokens.css)
 *   plotLayout(p, w, h)        margins, nice ticks, value → pixel maps for a normalizePlot() plot in a w × h box
 *   paintPlot(g, p, w, h, c)   draw on a CanvasRenderingContext2D with colours c ({ ink, ink2, grid, paper?, series[] })
 *   plotSvg(p, { w, h, colors }) → an SVG document (text, XML-escaped; no script, no external references)
 *   plotCsv(p) → text: "x,<series…>" when every series has the same x, else "series,x,y" rows; RFC 4180 quoting, CRLF, text
 *     cells that start with = + - @ get a leading ' (they are not numbers); a number keeps all its digits
 *   plotFileName(p, ext)       the title as a file name ("Compliance.png"; "plot.png" without one)
 */
import { niceTicks } from './cs-ui.js';
import { sig } from './sim-ui.js';
import { t } from './i18n.js';

export const PLOT_PAPER = { paper: '#FFFFFF', ink: '#17202B', ink2: '#34404E', grid: '#D5DDE5', series: ['#1E48C8', '#B3122E', '#17703A', '#A84A00', '#5B3CC4', '#00707E', '#9A1F86', '#8A6200'] };

export function plotLayout(p, w, h) {
  const tx = (v) => (p.log.includes('x') ? (v > 0 ? Math.log10(v) : NaN) : v), ty = (v) => (p.log.includes('y') ? (v > 0 ? Math.log10(v) : NaN) : v);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of p.series) for (let i = 0; i < s.y.length; i++) { const x = tx(s.x[i]), y = ty(s.y[i]); if (Number.isFinite(x)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } if (Number.isFinite(y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  const X = niceTicks(x0, x1, 6), Y = niceTicks(y0, y1, 4);
  const L = 58, R = 12, T = p.title ? 22 : 10, B = p.xlabel ? 38 : 24, pw = Math.max(10, w - L - R), ph = Math.max(10, h - T - B);
  const sx = (v) => L + (v - X.lo) / (X.hi - X.lo || 1) * pw, sy = (v) => T + ph - (v - Y.lo) / (Y.hi - Y.lo || 1) * ph;
  const tickText = (v, log) => (log ? `1e${Math.round(v)}` : sig(v));
  return { L, R, T, B, pw, ph, X, Y, sx, sy, tx, ty, tickText };
}

/** Each drawable run of a series: [[px, py], …] polylines (NaNs and non-positive values on a log axis break the line). */
function runs(p, s, Ly) {
  const out = [];
  let cur = null;
  for (let i = 0; i < s.y.length; i++) {
    const x = Ly.tx(s.x[i]), y = Ly.ty(s.y[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { cur = null; continue; }
    if (!cur) { cur = []; out.push(cur); }
    cur.push([Ly.sx(x), Ly.sy(y)]);
  }
  return out;
}
const dotsOnly = (p, s) => p.kind === 'scatter' || s.y.length === 1;

export function paintPlot(g, p, w, h, c) {
  const Ly = plotLayout(p, w, h), { L, T, pw, ph, X, Y, sx, sy, tickText } = Ly;
  const font = '12px system-ui, sans-serif';
  if (c.paper) { g.fillStyle = c.paper; g.fillRect(0, 0, w, h); }
  g.font = font; g.lineWidth = 1;
  g.strokeStyle = c.grid; g.fillStyle = c.ink2;
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const t of X.ticks) { const x = Math.round(sx(t)) + 0.5; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillText(tickText(t, p.log.includes('x')), x, T + ph + 4); }
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const t of Y.ticks) { const y = Math.round(sy(t)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.fillText(tickText(t, p.log.includes('y')), L - 6, y); }
  g.strokeStyle = c.ink; g.strokeRect(L + 0.5, T + 0.5, pw, ph);
  g.fillStyle = c.ink; g.textAlign = 'center'; g.textBaseline = 'top';
  if (p.title) { g.font = '600 ' + font; g.fillText(p.title, L + pw / 2, 4); g.font = font; }
  if (p.xlabel) g.fillText(p.xlabel, L + pw / 2, T + ph + 20);
  if (p.ylabel) { g.save(); g.translate(12, T + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'top'; g.fillText(p.ylabel, 0, -8); g.restore(); }
  g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
  p.series.forEach((s, k) => {
    const col = c.series[k % c.series.length];
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.75;
    for (const r of runs(p, s, Ly)) {
      if (dotsOnly(p, s)) { for (const [x, y] of r) { g.beginPath(); g.arc(x, y, 2.5, 0, 2 * Math.PI); g.fill(); } continue; }
      g.beginPath(); r.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
  });
  g.restore();
  // the legend on paper (on screen the dock lists names under the plot)
  if (c.legend) {
    const named = p.series.map((s, k) => [s, k]).filter(([s]) => s.name);
    g.font = font; g.textAlign = 'left'; g.textBaseline = 'middle';
    if (named.length) { const bw = 36 + Math.max(...named.map(([s]) => g.measureText(s.name).width)); g.fillStyle = c.paper || '#FFFFFF'; g.strokeStyle = c.grid; g.fillRect(L + 4, T + 3, bw, 16 * named.length - 2); g.strokeRect(L + 4.5, T + 3.5, bw, 16 * named.length - 2); }
    named.forEach(([s, k], i) => { const y = T + 10 + 16 * i; g.fillStyle = c.series[k % c.series.length]; g.fillRect(L + 8, y - 4, 14, 8); g.fillStyle = c.ink; g.fillText(s.name, L + 28, y); });
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const n2 = (v) => +v.toFixed(2);

export function plotSvg(p, { w = 800, h = 500, colors = PLOT_PAPER } = {}) {
  const c = colors, Ly = plotLayout(p, w, h), { L, T, pw, ph, X, Y, sx, sy, tickText } = Ly;
  const o = [];
  o.push(`<?xml version="1.0" encoding="UTF-8"?>`, `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif" font-size="12">`);
  if (p.title) o.push(`<title>${esc(p.title)}</title>`);
  o.push(`<rect width="${w}" height="${h}" fill="${c.paper || '#FFFFFF'}"/>`, `<g stroke="${c.grid}" stroke-width="1">`);
  for (const t of X.ticks) { const x = n2(sx(t)); o.push(`<line x1="${x}" y1="${T}" x2="${x}" y2="${n2(T + ph)}"/>`); }
  for (const t of Y.ticks) { const y = n2(sy(t)); o.push(`<line x1="${L}" y1="${y}" x2="${n2(L + pw)}" y2="${y}"/>`); }
  o.push('</g>', `<g fill="${c.ink2}" text-anchor="middle">`);
  for (const t of X.ticks) o.push(`<text x="${n2(sx(t))}" y="${n2(T + ph + 16)}">${esc(tickText(t, p.log.includes('x')))}</text>`);
  o.push('</g>', `<g fill="${c.ink2}" text-anchor="end">`);
  for (const t of Y.ticks) o.push(`<text x="${L - 6}" y="${n2(sy(t) + 4)}">${esc(tickText(t, p.log.includes('y')))}</text>`);
  o.push('</g>', `<rect x="${L}" y="${T}" width="${n2(pw)}" height="${n2(ph)}" fill="none" stroke="${c.ink}" stroke-width="1"/>`);
  if (p.title) o.push(`<text x="${n2(L + pw / 2)}" y="16" text-anchor="middle" font-weight="600" fill="${c.ink}">${esc(p.title)}</text>`);
  if (p.xlabel) o.push(`<text x="${n2(L + pw / 2)}" y="${n2(T + ph + 32)}" text-anchor="middle" fill="${c.ink}">${esc(p.xlabel)}</text>`);
  if (p.ylabel) o.push(`<text transform="translate(16 ${n2(T + ph / 2)}) rotate(-90)" text-anchor="middle" fill="${c.ink}">${esc(p.ylabel)}</text>`);
  o.push(`<clipPath id="plot-area"><rect x="${L}" y="${T}" width="${n2(pw)}" height="${n2(ph)}"/></clipPath>`, '<g clip-path="url(#plot-area)">');
  p.series.forEach((s, k) => {
    const col = c.series[k % c.series.length];
    const label = s.name ? ` data-series="${esc(s.name)}"` : '';
    for (const r of runs(p, s, Ly)) {
      if (dotsOnly(p, s)) { o.push(`<g fill="${col}"${label}>${r.map(([x, y]) => `<circle cx="${n2(x)}" cy="${n2(y)}" r="2.5"/>`).join('')}</g>`); continue; }
      o.push(`<polyline fill="none" stroke="${col}" stroke-width="1.75" stroke-linejoin="round"${label} points="${r.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ')}"/>`);
    }
  });
  o.push('</g>');
  const named = p.series.map((s, k) => [s, k]).filter(([s]) => s.name);
  if (named.length) o.push(`<rect x="${L + 4}" y="${T + 3}" width="${36 + 7 * Math.max(...named.map(([s]) => s.name.length))}" height="${16 * named.length - 2}" fill="${c.paper || '#FFFFFF'}" stroke="${c.grid}"/>`);   // ~7 px per character at 12 px
  named.forEach(([s, k], i) => { const y = T + 10 + 16 * i; o.push(`<rect x="${L + 8}" y="${y - 4}" width="14" height="8" fill="${c.series[k % c.series.length]}"/><text x="${L + 28}" y="${y + 4}" fill="${c.ink}">${esc(s.name)}</text>`); });
  o.push('</svg>');
  return o.join('\n') + '\n';
}

const csvCell = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function plotCsv(p) {
  const S = p.series;
  const same = S.every((s) => s.x.length === S[0].x.length && s.x.every((v, i) => v === S[0].x[i]));
  const rows = [];
  if (same) {
    rows.push([p.xlabel || 'x', ...S.map((s, k) => s.name || (S.length > 1 ? `y${k + 1}` : p.ylabel || 'y'))]);
    for (let i = 0; i < S[0].x.length; i++) rows.push([S[0].x[i], ...S.map((s) => s.y[i])]);
  } else {
    rows.push([t('cs.plot.csv.series'), p.xlabel || 'x', p.ylabel || 'y']);
    S.forEach((s, k) => { for (let i = 0; i < s.y.length; i++) rows.push([s.name || t('cs.plot.csv.series_n', { n: k + 1 }), s.x[i], s.y[i]]); });
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const plotFileName = (p, ext) => (String(p.title || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').trim().slice(0, 80) || 'plot') + '.' + ext;
