/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cs-dock.js — the Script workspace's sub-displays (spec §5, "Sub-display dock"): the context-sensitive strip along the
 * bottom of the 3D view. Each display command or click that has something to show adds a sub-display; the newest is
 * shown, the others stay a click away in the strip's tabs (the last 12).
 *
 *   const dock = createDock({ el, download })  // el = ui-util.js el; download(fileName, blob) saves a file (0.4 P9)
 *   dock.root                                  // put it in the stage
 *   dock.add({ kind: 'plot' | 'image' | 'table' | 'picked' | 'value', title, data, key? })  // key: replace the one with that key
 *   dock.clear() · dock.collapsed · dock.toggle(open?) · dock.items · dock.active
 *
 * plot data = cs-ui.js normalizePlot(); image data = { t: tensor, colormap? }; table data = a value (tableOf);
 * picked data = { rows: [[label, text]] }; value data = { text }. Drawn on <canvas> with the page's colour tokens.
 * 0.4 P9: **Side by side** (shown when there are two or more plots) puts every plot in a grid (the newest 6); every plot has
 * PNG, SVG and CSV buttons (cs-plot-export.js: PNG and SVG print on white in the paper colours, whatever the theme).
 */
import { normalizePlot, grid2d, tableOf, rangeOf } from './cs-ui.js';
import { colormap, sig } from './sim-ui.js';
import { paintPlot, plotSvg, plotCsv, plotFileName, PLOT_PAPER } from './cs-plot-export.js';
import { t } from './i18n.js';

const MAX = 12;
const SERIES = ['--layer-blue', '--layer-red', '--layer-green', '--layer-orange', '--layer-violet', '--layer-cyan', '--layer-magenta', '--layer-ochre'];

const SIDE_MAX = 6;

export function createDock({ el, download = null }) {
  const items = [];
  let active = -1, collapsed = false, seq = 0, ro = null, ros = [], slice = 0, side = false;
  const tabs = el('div', { className: 'cs-dock-tabs', role: 'tablist', 'aria-label': t('script.dock.title') });
  const body = el('div', { className: 'cs-dock-body', role: 'tabpanel', tabIndex: -1 });
  const toggleBtn = el('button', { type: 'button', className: 'pc-btn pc-btn-sm cs-dock-toggle', title: t('script.dock.hide'), 'aria-expanded': 'true', dataset: { csDockToggle: '1' } }, el('i', { className: 'bi bi-chevron-down', 'aria-hidden': 'true' }));
  const clearBtn = el('button', { type: 'button', className: 'pc-btn pc-btn-sm', title: t('script.dock.clear.title'), dataset: { csDockClear: '1' } }, t('script.dock.clear'));
  const sideBtn = el('button', { type: 'button', className: 'pc-btn pc-btn-sm', title: t('cs.dock.side.title'), 'aria-pressed': 'false', hidden: true, dataset: { csDockSide: '1' } }, el('i', { className: 'bi bi-grid', 'aria-hidden': 'true' }), ' ', t('cs.dock.side'));
  sideBtn.addEventListener('click', () => { side = !side; if (side && items[active]?.kind !== 'plot') { const k = items.map((x) => x.kind).lastIndexOf('plot'); if (k >= 0) active = k; } render(); });
  const head = el('div', { className: 'cs-dock-head' }, el('span', { className: 'cs-dock-h' }, t('script.dock.title')), tabs, el('span', { className: 'cs-dock-acts' }, sideBtn, clearBtn, toggleBtn));
  const root = el('section', { className: 'cs-dock', 'aria-label': t('script.dock.title'), dataset: { csDock: '1' }, hidden: true }, head, body);
  toggleBtn.addEventListener('click', () => dock.toggle(collapsed));
  clearBtn.addEventListener('click', () => dock.clear());

  const tok = (n, d) => { const v = root.ownerDocument.defaultView.getComputedStyle(root.ownerDocument.documentElement).getPropertyValue(n).trim(); return v || d; };

  function renderTabs() {
    tabs.replaceChildren(...items.map((it, i) => el('button', { type: 'button', role: 'tab', className: 'cs-dock-tab', 'aria-selected': String(i === active), tabIndex: i === active ? 0 : -1, title: it.title, dataset: { csSub: it.kind },
      onclick: () => { active = i; slice = 0; if (it.kind !== 'plot') side = false; render(); },
      onkeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); active = (active + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length; render(); tabs.children[active]?.focus(); } },
    }, el('i', { className: 'bi bi-' + ({ plot: 'graph-up', image: 'grid-3x3', table: 'table', picked: 'crosshair', value: 'card-text' }[it.kind] || 'square'), 'aria-hidden': 'true' }), ' ', it.title || it.kind)));   // i18n-ignore: class names / CSS
  }
  function render() {
    root.hidden = !items.length;
    root.classList.toggle('is-collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.title = collapsed ? t('script.dock.show') : t('script.dock.hide');
    toggleBtn.firstChild.className = 'bi bi-chevron-' + (collapsed ? 'up' : 'down');   // i18n-ignore: class names / CSS
    renderTabs();
    if (ro) { ro.disconnect(); ro = null; }
    for (const r of ros) r.disconnect(); ros = [];
    body.replaceChildren();
    const plots = items.filter((x) => x.kind === 'plot');
    sideBtn.hidden = plots.length < 2;
    if (plots.length < 2) side = false;
    sideBtn.setAttribute('aria-pressed', String(side));
    const it = items[active];
    if (!it || collapsed) return;
    body.dataset.csKind = side ? 'plots' : it.kind;
    root.classList.toggle('is-side', side);
    try {
      if (side) drawPlots(plots.slice(-SIDE_MAX));
      else if (it.kind === 'plot') drawPlot(it);
      else if (it.kind === 'image') drawImage(it);
      else if (it.kind === 'table') drawTable(it);
      else if (it.kind === 'picked') body.append(el('dl', { className: 'pc-dl cs-picked', dataset: { csPicked: '1' } }, ...it.data.rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
      else body.append(el('pre', { className: 'cs-value' }, it.data.text));
    } catch (e) {
      body.append(el('p', { className: 'pc-note' }, t('script.dock.draw_failed', { why: e.message || e })));
    }
  }
  function canvasBox(cls, draw, into = body) {
    const c = el('canvas', { className: cls });
    const box = el('div', { className: 'cs-canvas-box' }, c);
    into.append(box);
    const paint = () => {
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, root.ownerDocument.defaultView.devicePixelRatio || 1);
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g, w, h);
    };
    const RO = root.ownerDocument.defaultView.ResizeObserver;
    if (RO) { const r = new RO(() => paint()); r.observe(box); if (into === body) ro = r; else ros.push(r); }
    paint();
    return { c, box, paint };
  }

  // ---- export (0.4 P9)
  const screenColors = () => ({ ink: tok('--ink', '#1d232b'), ink2: tok('--ink-2', '#55606c'), grid: tok('--line', '#c9d1d9'), series: SERIES.map((n) => tok(n, '#2f6fd6')) });
  function exportPlot(p, kind) {
    if (!download) return;
    if (kind === 'svg') { download(plotFileName(p, 'svg'), new Blob([plotSvg(p)], { type: 'image/svg+xml' })); return; }
    if (kind === 'csv') { download(plotFileName(p, 'csv'), new Blob(['\uFEFF' + plotCsv(p)], { type: 'text/csv' })); return; }
    const doc = root.ownerDocument, c = doc.createElement('canvas'), W = 1600, H = 1000;   // 800 × 500 drawn at 2×
    c.width = W; c.height = H;
    const g = c.getContext('2d'); g.setTransform(2, 0, 0, 2, 0, 0);
    paintPlot(g, p, W / 2, H / 2, { ...PLOT_PAPER, legend: true });
    c.toBlob((b) => { if (b) download(plotFileName(p, 'png'), b); }, 'image/png');
  }
  const exportRow = (p) => el('span', { className: 'cs-plot-export', dataset: { csPlotExport: '1' } },
    ...[['png', 'PNG'], ['svg', 'SVG'], ['csv', 'CSV']]   // i18n-ignore: file format names
      .map(([k, label]) => el('button', { type: 'button', className: 'pc-btn pc-btn-sm', title: t('cs.dock.export.' + k), onclick: () => exportPlot(p, k), dataset: { csPlotSave: k } }, label)));

  /** Every plot at once, in a grid (Side by side). */
  function drawPlots(list) {
    const grid = el('div', { className: 'cs-plot-grid', dataset: { csPlotGrid: String(list.length) } });
    body.append(grid);
    for (const it of list) {
      const p = it.data, cell = el('div', { className: 'cs-plot-cell' + (it === items[active] ? ' is-active' : ''), dataset: { csPlotCell: p.title || it.title || '' } });
      grid.append(cell);
      canvasBox('cs-plot', (g, w, h) => paintPlot(g, p, w, h, screenColors()), cell);
      cell.append(el('div', { className: 'cs-plot-foot' }, el('span', { className: 'cs-dock-note' }, it.title || p.title || t('script.dock.plot')), exportRow(p)));
    }
  }

  function drawPlot(it) {
    const p = it.data;
    const legend = el('div', { className: 'cs-plot-legend' }, ...p.series.filter((x) => x.name).map((x, i) => el('span', {}, el('i', { className: 'cs-swatch', style: `background:${tok(SERIES[i % SERIES.length], '#2f6fd6')}` }), x.name)));   // i18n-ignore: class names / CSS
    canvasBox('cs-plot', (g, w, h) => paintPlot(g, p, w, h, screenColors()));
    if (legend.children.length) body.append(legend);
    const last = p.series[0], n = last.y.length;
    body.append(el('div', { className: 'cs-plot-foot' }, el('p', { className: 'cs-dock-note', dataset: { csPlotInfo: String(n) } }, n ? t('script.dock.plot_info', { series: p.series.length, n, last: sig(last.y[n - 1]) }) : t('script.dock.plot_info_empty', { series: p.series.length })), exportRow(p)));
  }

  function drawImage(it) {
    const ten = it.data.t, g0 = grid2d(ten, slice);
    let map = it.data.colormap === 'gray' ? 'gray' : 'rainbow';
    const vals = ten.data.subarray ? ten.data.subarray(g0.page * g0.rows * g0.cols, (g0.page + 1) * g0.rows * g0.cols) : ten.data;
    const { lo, hi } = Array.isArray(it.data.range) && it.data.range.length === 2 && it.data.range[1] > it.data.range[0] ? { lo: +it.data.range[0], hi: +it.data.range[1] } : rangeOf(vals);
    const readout = el('span', { className: 'cs-dock-note', 'aria-live': 'polite' }, t('script.dock.image.range', { rows: g0.rows, cols: g0.cols, lo: sig(lo), hi: sig(hi) }));
    const sel = el('select', { className: 'pc-select pc-select-sm', 'aria-label': t('script.dock.colours') }, el('option', { value: 'rainbow', selected: map === 'rainbow' }, t('script.dock.rainbow')), el('option', { value: 'gray', selected: map === 'gray' }, t('script.dock.gray')));
    const ctl = el('div', { className: 'cs-dock-ctl' }, sel, readout);
    if (g0.pages > 1) {
      const sl = el('input', { type: 'range', min: '0', max: String(g0.pages - 1), value: String(g0.page), 'aria-label': t('script.dock.slice'), className: 'cs-slice' });
      sl.addEventListener('input', () => { slice = Number(sl.value); render(); });
      ctl.prepend(el('label', { className: 'cs-dock-note' }, t('script.dock.slice_of', { n: g0.page + 1, all: g0.pages }) + ' ', sl));
    }
    body.append(ctl);
    const color = (v) => { const f = (v - lo) / (hi - lo || 1); if (map === 'gray') { const k = Math.round(255 * (1 - Math.max(0, Math.min(1, f)))); return [k, k, k]; } return colormap(f).map((c) => Math.round(c * 255)); };
    let geom = null;
    const cb = canvasBox('cs-image', (g, w, h) => {
      const bar = 46, cw = Math.max(10, w - bar - 8), s = Math.min(cw / g0.cols, (h - 4) / g0.rows), iw = g0.cols * s, ih = g0.rows * s, ox = Math.floor((cw - iw) / 2), oy = Math.floor((h - ih) / 2);
      const img = new OffscreenCanvasOr(g0.cols, g0.rows, root.ownerDocument);
      const ig = img.getContext('2d'), id = ig.createImageData(g0.cols, g0.rows);
      for (let i = 0; i < g0.rows; i++) for (let j = 0; j < g0.cols; j++) { const c = color(g0.get(i, j)), k = 4 * (i * g0.cols + j); id.data[k] = c[0]; id.data[k + 1] = c[1]; id.data[k + 2] = c[2]; id.data[k + 3] = 255; }
      ig.putImageData(id, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(img, ox, oy, iw, ih);
      g.strokeStyle = tok('--ink', '#1d232b'); g.strokeRect(ox + 0.5, oy + 0.5, iw, ih);
      // colour bar
      const bx = w - bar + 4, by = 6, bh = h - 12;
      for (let y = 0; y < bh; y++) { const c = color(hi - (y / bh) * (hi - lo)); g.fillStyle = `rgb(${c.join(',')})`; g.fillRect(bx, by + y, 10, 1); }
      g.fillStyle = tok('--ink-2', '#55606c'); g.font = '11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(sig(hi), bx + 13, by); g.textBaseline = 'bottom'; g.fillText(sig(lo), bx + 13, by + bh);
      geom = { ox, oy, s };
    });
    sel.addEventListener('change', () => { map = sel.value; it.data.colormap = map; cb.paint(); });
    cb.c.addEventListener('pointermove', (e) => {
      if (!geom) return;
      const r = cb.c.getBoundingClientRect(), j = Math.floor((e.clientX - r.left - geom.ox) / geom.s), i = Math.floor((e.clientY - r.top - geom.oy) / geom.s);
      readout.textContent = i >= 0 && j >= 0 && i < g0.rows && j < g0.cols ? `(${i + 1}, ${j + 1}) = ${sig(g0.get(i, j))}` /* i18n-ignore: notation */ : t('script.dock.image.range', { rows: g0.rows, cols: g0.cols, lo: sig(lo), hi: sig(hi) });
    });
  }

  function drawTable(it) {
    const tb = tableOf(it.data.value, { slice });
    if (tb.pages > 1) {
      const sl = el('input', { type: 'range', min: '0', max: String(tb.pages - 1), value: String(tb.page), 'aria-label': t('script.dock.slice'), className: 'cs-slice' });
      sl.addEventListener('input', () => { slice = Number(sl.value); render(); });
      body.append(el('div', { className: 'cs-dock-ctl' }, el('label', { className: 'cs-dock-note' }, t('script.dock.slice_of', { n: tb.page + 1, all: tb.pages }) + ' ', sl)));
    }
    body.append(el('div', { className: 'cs-table-wrap' }, el('table', { className: 'cs-table', dataset: { csTable: '1' } },
      el('thead', {}, el('tr', {}, ...tb.head.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, ...tb.rows.map((r) => el('tr', {}, ...r.map((c, j) => (j === 0 && tb.head[0] === '' ? el('th', { scope: 'row' }, c) : el('td', {}, c)))))))));
    if (tb.more) body.append(el('p', { className: 'cs-dock-note' }, tb.more));
  }

  const dock = {
    root,
    get items() { return items; },
    get active() { return items[active] || null; },
    get collapsed() { return collapsed; },
    add(sub) {
      const it = { ...sub, id: ++seq };
      if (it.kind === 'plot' && !(it.data && it.data.series)) it.data = normalizePlot(it.data);
      const k = it.key ? items.findIndex((x) => x.key === it.key) : -1;
      if (k >= 0) { items[k] = it; active = k; }
      else { items.push(it); if (items.length > MAX) items.shift(); active = items.length - 1; }
      slice = 0;
      render();
      return it;
    },
    clear() { items.length = 0; active = -1; side = false; render(); },
    get sideBySide() { return side; },
    toggle(open = collapsed) { collapsed = !open; render(); },
    render,
  };
  return dock;
}

/** A small canvas for the image (OffscreenCanvas where there is one). */
function OffscreenCanvasOr(w, h, doc) {
  const W = doc.defaultView;
  if (W.OffscreenCanvas) return new W.OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = doc.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
}
