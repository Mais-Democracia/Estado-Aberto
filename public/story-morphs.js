(function () {
"use strict";
const Story = (window.Story = window.Story || {});
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === "number" ? v : v == null || v === "" || typeof v === "object" ? NaN : Number(v));
const ok = (v) => Number.isFinite(num(v));
const nfI = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0, useGrouping: "always" });
const nf1 = new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: "always" });
const nfM = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1, useGrouping: "always" });
const nfS = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 2, useGrouping: "always" });
const dfL = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const dfM = new Intl.DateTimeFormat("pt-PT", { month: "short", year: "numeric", timeZone: "UTC" });
const parseDate = (v) => { if (v == null || v === "") return NaN; if (v instanceof Date) return v.getTime(); if (typeof v === "number") return v > 1e11 ? v : NaN; const t = Date.parse(String(v)); return t; };
const compact = (v) => { v = num(v); if (!Number.isFinite(v)) return null; const a = Math.abs(v); return a >= 1e9 ? nfM.format(v / 1e9) + " mM" : a >= 1e6 ? nfM.format(v / 1e6) + " M" : a >= 1e4 ? nfI.format(v) : a >= 100 ? nfI.format(v) : nfS.format(v); };
const fmt = {
  int: (v) => { v = num(v); return Number.isFinite(v) ? nfI.format(v) : null; },
  dec1: (v) => { v = num(v); return Number.isFinite(v) ? nf1.format(v) : null; },
  pct: (v) => { v = num(v); return Number.isFinite(v) ? (Number.isInteger(v) ? nfI : nf1).format(v) + "%" : null; },
  eur: (v) => { v = num(v); if (!Number.isFinite(v)) return null; const a = Math.abs(v); return a >= 1e9 ? nfM.format(v / 1e9) + " mM€" : a >= 1e6 ? nfM.format(v / 1e6) + " M€" : a >= 1e3 ? nfM.format(v / 1e3) + " mil €" : nfI.format(v) + " €"; },
  date: (v) => { const t = typeof v === "string" || v instanceof Date ? parseDate(v) : parseDate(v); return Number.isFinite(t) ? dfL.format(t) : null; },
  str: (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) || typeof v === "object" || String(v).trim() === "" ? null : String(v)),
  compact,
};
Story.fmt = fmt;
Story.util = { clamp, num, ok, compact };

const hex = (c) => { if (c[0] === "#") { const h = c.length === 4 ? c.slice(1).replace(/./g, "$&$&") : c.slice(1, 7); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; } const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128]; };
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return "rgb(" + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",") + ")"; };
Story.util.hex = hex; Story.util.mix = mix;

const geom = {
  area(r) {
    switch (r.k) {
      case "rect": return Math.max(1, r.w * r.h);
      case "disc": return Math.max(1, Math.PI * r.rad * r.rad);
      case "ring": return Math.PI * (r.r1 * r.r1 - r.r0 * r.r0);
      case "ribbon": return Math.max(1, Math.abs(r.x1 - r.x0) * (r.t0 + r.t1) / 2);
      case "path": return Math.max(1, r.len * r.th);
    }
    return 1;
  },
  sample(r, u, v) {
    switch (r.k) {
      case "rect": return [r.x + u * r.w, r.y + v * r.h];
      case "disc": { const d = Math.sqrt(u) * r.rad, a = v * TAU; return [r.x + Math.cos(a) * d, r.y + Math.sin(a) * d]; }
      case "ring": { const d = Math.sqrt(u * (r.r1 * r.r1 - r.r0 * r.r0) + r.r0 * r.r0), a = v * TAU; return [r.x + Math.cos(a) * d, r.y + Math.sin(a) * d]; }
      case "ribbon": { const e = u * u * (3 - 2 * u), th = r.t0 + (r.t1 - r.t0) * u; return [r.x0 + (r.x1 - r.x0) * u, r.y0 + (r.y1 - r.y0) * e + (v - 0.5) * th]; }
      case "path": {
        const L = u * r.len; let i = 1; while (i < r.cum.length - 1 && r.cum[i] < L) i++;
        const a = r.pts[i - 1], b = r.pts[i], sl = r.cum[i] - r.cum[i - 1] || 1, f = (L - r.cum[i - 1]) / sl;
        const dx = b[0] - a[0], dy = b[1] - a[1], dl = Math.hypot(dx, dy) || 1;
        return [a[0] + dx * f - (dy / dl) * (v - 0.5) * r.th, a[1] + dy * f + (dx / dl) * (v - 0.5) * r.th];
      }
    }
    return [0, 0];
  },
  contains(r, px, py, pad = 0) {
    switch (r.k) {
      case "rect": return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
      case "disc": return Math.hypot(px - r.x, py - r.y) <= r.rad + pad;
      case "ring": { const d = Math.hypot(px - r.x, py - r.y); return d <= r.r1 + pad && d >= r.r0 - pad; }
      case "ribbon": {
        const w = r.x1 - r.x0; if (Math.abs(w) < 1) return false; const s = (px - r.x0) / w; if (s < 0 || s > 1) return false;
        const e = s * s * (3 - 2 * s), th = r.t0 + (r.t1 - r.t0) * s; return Math.abs(py - (r.y0 + (r.y1 - r.y0) * e)) <= th / 2 + pad;
      }
      case "path": {
        for (let i = 1; i < r.pts.length; i++) {
          const a = r.pts[i - 1], b = r.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
          const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1);
          if (Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t) <= r.th / 2 + 4 + pad) return true;
        }
        return false;
      }
    }
    return false;
  },
};
Story.geom = geom;

const mkPath = (pts, th, o) => { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return { k: "path", pts, th, cum, len: cum[cum.length - 1] || 1, ...o }; };
const rect = (x, y, w, h, o) => ({ k: "rect", x, y, w, h, ...o });
const disc = (x, y, rad, o) => ({ k: "disc", x, y, rad, ...o });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lab = (x, y, t, o) => ({ x, y, t: String(t), ...o });
const lc = (v) => String(v == null ? "" : v).toLowerCase();

const niceStep = (span, n) => { const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };
const niceTicks = (lo, hi, n) => { if (!(hi > lo)) hi = lo + 1; const st = niceStep(hi - lo, n), out = []; for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-6; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v); return out; };

const M = {};
Story.morphs = M;

M.counter = (s, b, c) => {
  const v = num(s.value); if (!Number.isFinite(v)) return null;
  const ls = 62, cx = b.x + b.w / 2, R = Math.min(b.w * 0.5, (b.h - ls) / 2) - 4, cy = b.y + (b.h - ls) / 2;
  const regions = [
    { k: "ring", x: cx, y: cy, r0: R * 0.9, r1: R, mw: 2.5, c: c.col("green"), a: 0.95, tip: s.label ? "<b>" + esc(s.label) + "</b>" : null },
    disc(cx, cy, R * 0.86, { c: c.col("gold"), a: 0.55, fill: c.pal.dark ? 0.22 : 0.4 }),
  ];
  const big = a => { const x = Math.abs(a); return x >= 1e6 ? compact(a) : x >= 100 || Number.isInteger(a) ? nfI.format(a) : nf1.format(a); };
  const labels = [lab(cx, cy - (s.unit ? R * 0.1 : 0), "", { num: v, nf: "big", size: clamp(R * 0.5, 30, 118), f: "serif", w: 800, al: "center", max: R * 1.6, shrink: true, c: "ink" })];
  labels[0].t = big(v);
  if (s.unit) labels.push(lab(cx, cy + R * 0.34, s.unit, { size: clamp(R * 0.16, 13, 26), f: "sans", w: 600, al: "center", c: "mute", max: R * 1.6, shrink: true }));
  if (s.label) labels.push(lab(cx, cy + R + 26, s.label, { size: 15, f: "text", w: 500, al: "center", c: "ink", max: b.w, shrink: true }));
  if (s.delta != null && s.delta !== "") {
    const dn = num(s.delta), isN = Number.isFinite(dn), t = isN ? (dn >= 0 ? "▲ " : "▼ ") + nf1.format(Math.abs(dn)) + "%" : String(s.delta);
    labels.push(lab(cx, cy + R + 52, t, { size: 15, f: "sans", w: 700, al: "center", c: isN ? (dn >= 0 ? "green" : "red") : "mute" }));
  }
  return { regions, labels, bigFmt: big };
};

M.bars = (s, b, c) => {
  const rows = (s.rows || []).filter((r) => r && ok(r.value)).slice(0, c.mobile ? 10 : 14); if (!rows.length) return null;
  const vals = rows.map((r) => num(r.value)), max = num(s.max) > 0 ? num(s.max) : Math.max(...vals.map(Math.abs), 1e-9);
  const labW = clamp(b.w * 0.3, c.mobile ? 78 : 100, 230), vtxt = vals.map((v) => compact(v) + (s.unit ? " " + s.unit : "")), valW = Math.min(b.w * 0.42, Math.max(...vtxt.map((t) => c.measure(t, c.mobile ? 11.5 : 13, 700, "sans"))) + 10), rowH = Math.min(54, b.h / rows.length), total = rowH * rows.length, y0 = b.y + (b.h - total) / 2, barH = rowH * 0.58;
  const x0 = b.x + labW + 8, span = Math.max(20, b.w - labW - valW - 12), arg = lc(c.arg), regions = [], labels = [], lines = [];
  rows.forEach((r, i) => {
    const hl = arg && lc(r.label) === arg, len = clamp(Math.abs(vals[i]) / max, 0, 1) * span, y = y0 + i * rowH + (rowH - barH) / 2;
    const col = hl ? c.col("red") : r.color ? c.col(r.color) : c.col("blue");
    regions.push(rect(x0, y, Math.max(len, 3), barH, { c: col, a: 0.9, fill: 0.3, href: r.href, tip: "<b>" + esc(r.label) + "</b><br>" + esc(compact(vals[i])) + (s.unit ? " " + esc(s.unit) : "") }));
    labels.push(lab(b.x + labW, y + barH / 2, r.label, { al: "right", size: c.mobile ? 11.5 : 13, f: "sans", w: hl ? 800 : 600, max: labW, c: "ink" }));
    labels.push(lab(x0 + Math.max(len, 3) + 8, y + barH / 2, vtxt[i], { size: c.mobile ? 11.5 : 13, f: "sans", w: 700, c: "mute", max: valW }));
  });
  lines.push({ x1: x0, y1: y0, x2: x0, y2: y0 + total, c: "line", w: 1.5, a: 1 });
  return { regions, labels, lines };
};

M.hemicycle = (s, b, c) => {
  const groups = (s.seats || []).filter((g) => g && ok(g.n) && num(g.n) > 0).map((g) => ({ ...g, n: Math.round(num(g.n)) }));
  const total = groups.reduce((a, g) => a + g.n, 0); if (!total) return null;
  const legendH = c.mobile ? 64 : 78, R = Math.max(40, Math.min(b.w / 2 - 6, b.h - legendH - 8)), cx = b.x + b.w / 2, top = b.y + Math.max(0, (b.h - legendH - R) / 2), cy = top + R;
  const nr = clamp(Math.round(Math.sqrt(total) / 2.2), 3, 9), rIn = R * 0.45, gap = (R - rIn) / (nr - 1), radii = [];
  for (let k = 0; k < nr; k++) radii.push(rIn + gap * k);
  const sum = radii.reduce((a, v) => a + v, 0), cnt = radii.map((r) => Math.round(total * r / sum)); cnt[nr - 1] += total - cnt.reduce((a, v) => a + v, 0);
  let seatR = Infinity; radii.forEach((r, k) => { seatR = Math.min(seatR, Math.min(gap, Math.PI * r / cnt[k]) * 0.46); });
  const seats = []; radii.forEach((r, k) => { for (let j = 0; j < cnt[k]; j++) { const a = Math.PI - Math.PI * (j + 0.5) / cnt[k]; seats.push({ x: cx + r * Math.cos(a), y: cy - r * Math.sin(a), a, r }); } });
  seats.sort((p, q) => q.a - p.a || p.r - q.r);
  const byVote = groups.some((g) => g.vote), VC = { favor: "green", contra: "red", abstencao: "gold" }, VL = { favor: "A favor", contra: "Contra", abstencao: "Abstenção" };
  const tally = { favor: 0, contra: 0, abstencao: 0, none: 0 }, regions = []; let gi = 0, used = 0;
  seats.forEach((p, i) => {
    while (used >= groups[gi].n) { gi++; used = 0; } used++;
    const g = groups[gi], v = VC[g.vote] ? g.vote : null; tally[v || "none"]++;
    const col = byVote ? c.col(v ? VC[v] : "na") : c.col(g.color || c.pal.cycle[gi % c.pal.cycle.length]);
    regions.push(disc(p.x, p.y, seatR, { c: col, a: 0.95, fill: 0.35, tip: "<b>" + esc(g.party) + "</b><br>" + g.n + (g.n === 1 ? " lugar" : " lugares") + (v ? " · " + VL[v] : byVote ? " · sem voto" : "") }));
  });
  const labels = [];
  if (s.title) labels.push(lab(cx, cy - R * 0.2, s.title, { size: clamp(R * 0.11, 14, 24), f: "serif", w: 700, al: "center", max: rIn * 1.7, c: "ink" }));
  labels.push(lab(cx, cy - R * 0.2 + clamp(R * 0.11, 14, 24) * 1.5, total + " lugares", { size: 13, f: "sans", w: 600, al: "center", c: "mute" }));
  const items = byVote ? ["favor", "contra", "abstencao"].filter((k) => tally[k]).map((k) => ({ t: VL[k] + " " + tally[k], c: c.col(VC[k]) })) : groups.map((g, i) => ({ t: g.party + " " + g.n, c: c.col(g.color || c.pal.cycle[i % c.pal.cycle.length]) }));
  if (byVote && tally.none) items.push({ t: "Sem voto " + tally.none, c: c.col("na") });
  let lx = b.x, ly = cy + 30; const lh = 20, sz = c.mobile ? 11.5 : 13;
  const widths = items.map((it) => c.measure(it.t, sz, 600, "sans") + 26);
  const lineW = []; { let acc = 0, ln = 0; widths.forEach((w, i) => { if (acc + w > b.w && acc > 0) { ln++; acc = 0; } lineW[i] = ln; acc += w; }); }
  const rowsW = {}; widths.forEach((w, i) => { rowsW[lineW[i]] = (rowsW[lineW[i]] || 0) + w; });
  let cur = -1;
  items.forEach((it, i) => {
    if (lineW[i] !== cur) { cur = lineW[i]; lx = b.x + (b.w - rowsW[cur]) / 2; ly = cy + 30 + cur * lh; }
    labels.push(lab(lx + 6, ly, "", { kind: "dot", rad: 5, c: it.c })); labels.push(lab(lx + 16, ly, it.t, { size: sz, f: "sans", w: 600, c: "ink" })); lx += widths[i];
  });
  return { regions, labels };
};

M.sankey = (s, b, c) => {
  const ids = new Map(); (s.nodes || []).forEach((n, i) => { if (n && n.id != null) ids.set(n.id, i); });
  const links = (s.links || []).filter((l) => l && ok(l.v) && num(l.v) > 0 && ids.has(l.s) && ids.has(l.t) && l.s !== l.t); if (!links.length) return null;
  const nodes = (s.nodes || []).map((n, i) => ({ ...n, i, dep: 0, vin: 0, vout: 0 })); links.forEach((l) => { l.si = ids.get(l.s); l.ti = ids.get(l.t); nodes[l.si].vout += num(l.v); nodes[l.ti].vin += num(l.v); });
  const used = nodes.filter((n) => n.vin || n.vout), nU = used.length;
  for (let it = 0; it < nU; it++) { let ch = false; links.forEach((l) => { if (nodes[l.ti].dep < Math.min(nU - 1, nodes[l.si].dep + 1)) { nodes[l.ti].dep = nodes[l.si].dep + 1; ch = true; } }); if (!ch) break; }
  const ncol = Math.max(...used.map((n) => n.dep)) + 1, cols = Array.from({ length: ncol }, () => []); used.forEach((n) => { n.v = Math.max(n.vin, n.vout); cols[n.dep].push(n); });
  const nodeW = c.mobile ? 10 : 16, gap = c.mobile ? 8 : 14, availH = b.h - 8;
  let scale = Infinity; cols.forEach((col) => { const sm = col.reduce((a, n) => a + n.v, 0); scale = Math.min(scale, Math.max(1, availH - gap * (col.length - 1)) / sm); });
  const labL = c.mobile ? 66 : clamp(b.w * 0.2, 80, 170), labR = labL, xs = b.x + labL, xe = b.x + b.w - labR - nodeW;
  cols.forEach((col, ci) => {
    const hSum = col.reduce((a, n) => a + n.v * scale, 0) + gap * (col.length - 1); let y = b.y + 4 + (availH - hSum) / 2;
    col.forEach((n) => { n.x = ncol === 1 ? (xs + xe) / 2 : xs + (xe - xs) * ci / (ncol - 1); n.h = Math.max(3, n.v * scale); n.y = y; y += n.h + gap; n.col = c.col(n.color || c.pal.cycle[n.i % c.pal.cycle.length]); n.oo = 0; n.io = 0; });
  });
  const regions = [], labels = [], sorted = links.slice().sort((p, q) => nodes[p.ti].y - nodes[q.ti].y);
  const outs = new Map(), ins = new Map();
  sorted.forEach((l) => { (outs.get(l.si) || outs.set(l.si, []).get(l.si)).push(l); });
  links.slice().sort((p, q) => nodes[p.si].y - nodes[q.si].y).forEach((l) => { (ins.get(l.ti) || ins.set(l.ti, []).get(l.ti)).push(l); });
  outs.forEach((arr, k) => arr.forEach((l) => { const n = nodes[k], th = Math.max(1.5, num(l.v) * scale); l.th = th; l.y0 = n.y + n.oo + th / 2; n.oo += th; }));
  ins.forEach((arr, k) => arr.forEach((l) => { const n = nodes[k], th = l.th; l.y1 = n.y + n.io + th / 2; n.io += th; }));
  links.forEach((l) => {
    const a = nodes[l.si], t = nodes[l.ti];
    regions.push({ k: "ribbon", x0: a.x + nodeW, y0: l.y0, x1: t.x, y1: l.y1, t0: l.th, t1: l.th, len: t.x - a.x, c: a.col, a: 0.4, pa: 0.5, fill: 0.3, tip: "<b>" + esc(a.label || a.id) + " → " + esc(t.label || t.id) + "</b><br>" + esc(compact(l.v)) });
  });
  const arg = lc(c.arg);
  used.forEach((n) => {
    const hl = arg && (lc(n.label) === arg || lc(n.id) === arg);
    regions.push(rect(n.x, n.y, nodeW, n.h, { c: hl ? c.col("red") : n.col, a: 1, fill: 1, href: n.href, tip: "<b>" + esc(n.label || n.id) + "</b><br>" + esc(compact(n.v)) }));
    if (n.h < (c.mobile ? 14 : 9) && n.dep > 0 && n.dep < ncol - 1) return;
    const left = n.dep === 0 && ncol > 1, right = n.dep === ncol - 1 && ncol > 1, sz = c.mobile ? 10.5 : 12.5;
    labels.push(lab(left ? n.x - 8 : n.x + nodeW + 8, n.y + n.h / 2, (n.label || n.id) + " · " + compact(n.v), { al: left ? "right" : "left", size: sz, f: "sans", w: 600, c: "ink", max: left || right ? labL - 10 : Math.max(40, Math.min(150, (xe - xs) / Math.max(1, ncol - 1) - nodeW - 14)) }));
  });
  return { regions, labels };
};

M.scatter = (s, b, c) => {
  let pts = (s.points || []).filter((p) => p && ok(p.x) && ok(p.y)); if (!pts.length) return null;
  const cap = Math.max(10, Math.floor(c.N / 3)); if (pts.length > cap) { const st = pts.length / cap; pts = Array.from({ length: cap }, (_, i) => pts[Math.floor(i * st)]); }
  const L = c.mobile ? 40 : 54, B = c.mobile ? 40 : 46, T = 22, Rr = 16, px0 = b.x + L, px1 = b.x + b.w - Rr, py0 = b.y + b.h - B, py1 = b.y + T;
  const xs = pts.map((p) => num(p.x)), ys = pts.map((p) => num(p.y));
  const med = s.median && ok(s.median.x) && ok(s.median.y) ? s.median : null;
  let x0 = Math.min(...xs, med ? num(med.x) : Infinity), x1 = Math.max(...xs, med ? num(med.x) : -Infinity), y0 = Math.min(...ys, med ? num(med.y) : Infinity), y1 = Math.max(...ys, med ? num(med.y) : -Infinity);
  const padX = (x1 - x0 || 1) * 0.05, padY = (y1 - y0 || 1) * 0.07; x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const X = (v) => px0 + (v - x0) / (x1 - x0) * (px1 - px0), Y = (v) => py0 - (v - y0) / (y1 - y0) * (py0 - py1);
  const lines = [], labels = [], regions = [], tx = niceTicks(x0, x1, c.mobile ? 4 : 6), ty = niceTicks(y0, y1, 5), sz = c.mobile ? 10.5 : 11.5;
  ty.forEach((v) => { lines.push({ x1: px0, y1: Y(v), x2: px1, y2: Y(v), c: "line", w: 1, a: 0.5 }); labels.push(lab(px0 - 6, Y(v), compact(v), { al: "right", size: sz, f: "sans", c: "mute" })); });
  tx.forEach((v) => { lines.push({ x1: X(v), y1: py1, x2: X(v), y2: py0, c: "line", w: 1, a: 0.28 }); labels.push(lab(X(v), py0 + 14, compact(v), { al: "center", size: sz, f: "sans", c: "mute" })); });
  lines.push({ x1: px0, y1: py0, x2: px1, y2: py0, c: "ink", w: 1.5, a: 0.9 }, { x1: px0, y1: py0, x2: px0, y2: py1, c: "ink", w: 1.5, a: 0.9 });
  if (s.xLabel) labels.push(lab((px0 + px1) / 2, py0 + 32, s.xLabel, { al: "center", size: 12.5, f: "sans", w: 700, c: "ink", max: px1 - px0 }));
  if (s.yLabel) labels.push(lab(b.x + 2, b.y + 4, s.yLabel, { size: 12.5, f: "sans", w: 700, c: "ink", max: b.w - 4 }));
  if (med) {
    lines.push({ x1: X(num(med.x)), y1: py1, x2: X(num(med.x)), y2: py0, c: "red", w: 1.5, a: 0.85, dash: [6, 5] }, { x1: px0, y1: Y(num(med.y)), x2: px1, y2: Y(num(med.y)), c: "red", w: 1.5, a: 0.85, dash: [6, 5] });
    labels.push(lab(X(num(med.x)) + 4, py1 + 2, "mediana", { size: 11, f: "sans", w: 700, c: "red" }));
  }
  const arg = lc(c.arg), rad = c.mobile ? 3.4 : 4.4, want = new Set();
  const ext = (arr, f) => arr.indexOf(f(...arr)); [ext(xs, Math.max), ext(xs, Math.min), ext(ys, Math.max), ext(ys, Math.min)].forEach((i) => want.add(i));
  pts.forEach((p, i) => { if (arg && lc(p.label) === arg) want.add(i); });
  pts.forEach((p, i) => {
    const hl = arg && lc(p.label) === arg;
    regions.push(disc(X(xs[i]), Y(ys[i]), hl ? rad * 1.6 : rad, { c: hl ? c.col("red") : c.col(p.color || "blue"), a: 0.9, fill: 0.5, href: p.href, tip: "<b>" + esc(p.label) + "</b><br>" + esc(s.xLabel || "x") + ": " + esc(compact(xs[i])) + "<br>" + esc(s.yLabel || "y") + ": " + esc(compact(ys[i])) }));
  });
  const placed = [];
  [...want].forEach((i) => { const p = pts[i]; if (!p || !p.label) return; const x = X(xs[i]), y = Y(ys[i]); if (placed.some((q) => Math.hypot(q[0] - x, q[1] - y) < 60)) return; placed.push([x, y]); const right = x > px1 - 110; labels.push(lab(x + (right ? -8 : 8), y - 9, p.label, { al: right ? "right" : "left", size: sz, f: "sans", w: 700, c: "ink", max: 130 })); });
  return { regions, labels, lines, maxPer: 20 };
};

M.timeline = (s, b, c) => {
  const raw = (s.points || []).filter((p) => p && ok(p.v)), isDate = raw.some((p) => typeof p.t === "string");
  const T = (t) => (isDate ? parseDate(t) : num(t));
  const pts = raw.map((p) => ({ t: T(p.t), v: num(p.v) })).filter((p) => Number.isFinite(p.t)).sort((p, q) => p.t - q.t); if (pts.length < 2) return null;
  const L = c.mobile ? 44 : 58, B = 34, Tp = 56, px0 = b.x + L, px1 = b.x + b.w - 18, py0 = b.y + b.h - B, py1 = b.y + Tp;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, vmin = Math.min(0, ...pts.map((p) => p.v)), vmax = Math.max(...pts.map((p) => p.v), vmin + 1e-9) * 1.08;
  const X = (t) => px0 + (t - t0) / (t1 - t0 || 1) * (px1 - px0), Y = (v) => py0 - (v - vmin) / (vmax - vmin) * (py0 - py1);
  const vAt = (t) => { let i = 1; while (i < pts.length - 1 && pts[i].t < t) i++; const a = pts[i - 1], q = pts[i], f = q.t === a.t ? 0 : clamp((t - a.t) / (q.t - a.t), 0, 1); return a.v + (q.v - a.v) * f; };
  const lines = [], labels = [], regions = [], sz = c.mobile ? 10.5 : 11.5;
  niceTicks(vmin, vmax, 4).forEach((v) => { lines.push({ x1: px0, y1: Y(v), x2: px1, y2: Y(v), c: "line", w: 1, a: 0.5 }); labels.push(lab(px0 - 6, Y(v), compact(v), { al: "right", size: sz, f: "sans", c: "mute" })); });
  const nt = c.mobile ? 4 : 6, fmtT = (t) => { if (!isDate) return nfI.format(t); const span = t1 - t0; return span > 2 * 365 * 864e5 ? String(new Date(t).getUTCFullYear()) : dfM.format(t); };
  let lastT = null;
  for (let i = 0; i <= nt; i++) { const t = t0 + (t1 - t0) * i / nt, ft = fmtT(t); if (ft === lastT) { lines.push({ x1: X(t), y1: py0, x2: X(t), y2: py0 + 4, c: "ink", w: 1, a: 0.7 }); continue; } lastT = ft; labels.push(lab(X(t), py0 + 16, ft, { al: i === 0 ? "left" : i === nt ? "right" : "center", size: sz, f: "sans", c: "mute" })); lines.push({ x1: X(t), y1: py0, x2: X(t), y2: py0 + 4, c: "ink", w: 1, a: 0.7 }); }
  lines.push({ x1: px0, y1: py0, x2: px1, y2: py0, c: "ink", w: 1.5, a: 0.9 });
  const strips = c.mobile ? 36 : 56, sw = (px1 - px0) / strips;
  for (let i = 0; i < strips; i++) { const tm = t0 + (t1 - t0) * (i + 0.5) / strips, yt = Y(vAt(tm)); if (py0 - yt > 0.5) regions.push(rect(px0 + i * sw, yt, sw, py0 - yt, { c: c.col("blue"), a: 0.2, rr: 1.6, fill: 0.2, mw: 0.35 })); }
  const path = pts.map((p) => [X(p.t), Y(p.v)]);
  const stepN = Math.max(1, Math.ceil(pts.length / 220)), thin = pts.filter((_, i) => i % stepN === 0 || i === pts.length - 1), pp = thin.map((p) => [X(p.t), Y(p.v)]);
  regions.push(mkPath(pp, 5, { c: c.col("blue"), a: 1, mw: 8, tip: (mx) => { const t = t0 + clamp((mx - px0) / (px1 - px0), 0, 1) * (t1 - t0); return "<b>" + esc(fmtT(t)) + "</b><br>" + esc(compact(vAt(t))); } }));
  const last = path[path.length - 1];
  regions.push(disc(last[0], last[1], 6, { c: c.col("red"), a: 1, tip: "<b>" + esc(fmtT(t1)) + "</b><br>" + esc(compact(pts[pts.length - 1].v)) }));
  labels.push(lab(last[0] - 10, last[1] - 14, compact(pts[pts.length - 1].v), { al: "right", size: 13, f: "sans", w: 800, c: "red" }));
  (s.events || []).filter((e) => e && Number.isFinite(T(e.t)) && T(e.t) >= t0 && T(e.t) <= t1).forEach((e, i) => {
    const x = X(T(e.t)), y = Y(vAt(T(e.t))), row = i % 3, right = x > px1 - 150;
    lines.push({ x1: x, y1: b.y + 8 + row * 15 + 6, x2: x, y2: py0, c: "gold", w: 1.5, a: 0.9, dash: [3, 4] });
    regions.push(disc(x, y, 6, { c: c.col("gold"), a: 1, href: e.href, tip: "<b>" + esc(e.label) + "</b><br>" + esc(fmtT(T(e.t))) }));
    labels.push(lab(x + (right ? -5 : 5), b.y + 8 + row * 15, e.label, { al: right ? "right" : "left", size: sz, f: "sans", w: 700, c: "ink", max: 160 }));
  });
  return { regions, labels, lines };
};

M.network = (s, b, c) => {
  let nodes = (s.nodes || []).filter((n) => n && n.id != null).map((n) => ({ ...n, size: ok(n.size) ? Math.max(0, num(n.size)) : 1 })); if (!nodes.length) return null;
  const cap = Math.min(400, Math.floor(c.N / 3)); if (nodes.length > cap) nodes = nodes.sort((p, q) => q.size - p.size).slice(0, cap);
  const idx = new Map(nodes.map((n, i) => [n.id, i])), links = (s.links || []).filter((l) => l && idx.has(l.s) && idx.has(l.t) && l.s !== l.t).slice(0, 900).map((l) => [idx.get(l.s), idx.get(l.t), ok(l.v) ? Math.max(0.2, num(l.v)) : 1]);
  const n = nodes.length; let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const W = Math.max(b.w, 100), H = Math.max(b.h, 100), k = Math.sqrt(W * H / n) * 0.62, grp = new Map();
  nodes.forEach((nd) => { const g = nd.group == null ? "" : String(nd.group); if (!grp.has(g)) grp.set(g, grp.size); nd.gi = grp.get(g); });
  const gc = new Map(); grp.forEach((gi) => gc.set(gi, [W / 2 + Math.cos(gi * 2.4) * W * 0.25, H / 2 + Math.sin(gi * 2.4) * H * 0.25]));
  nodes.forEach((nd) => { const g = gc.get(nd.gi); nd.px = g[0] + (rnd() - 0.5) * W * 0.3; nd.py = g[1] + (rnd() - 0.5) * H * 0.3; nd.dx = 0; nd.dy = 0; });
  const iters = n > 250 ? 90 : 150;
  for (let it = 0; it < iters; it++) {
    const temp = (1 - it / iters) * k * 0.9 + 0.5;
    for (let i = 0; i < n; i++) { nodes[i].dx = 0; nodes[i].dy = 0; }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = nodes[i], q = nodes[j]; let dx = a.px - q.px, dy = a.py - q.py, d2 = dx * dx + dy * dy; if (d2 < 0.01) { dx = rnd() - 0.5; dy = rnd() - 0.5; d2 = 0.25; }
      if (d2 > k * k * 16) continue; const f = k * k / d2; a.dx += dx * f; a.dy += dy * f; q.dx -= dx * f; q.dy -= dy * f;
    }
    links.forEach(([i, j, w]) => { const a = nodes[i], q = nodes[j], dx = a.px - q.px, dy = a.py - q.py, d = Math.hypot(dx, dy) || 0.01, f = d / k * Math.min(2, 0.6 + w * 0.1); a.dx -= dx * f; a.dy -= dy * f; q.dx += dx * f; q.dy += dy * f; });
    nodes.forEach((nd) => { const g = gc.get(nd.gi); nd.dx += (W / 2 - nd.px) * 0.06 + (g[0] - nd.px) * 0.015; nd.dy += (H / 2 - nd.py) * 0.06 + (g[1] - nd.py) * 0.015; const d = Math.hypot(nd.dx, nd.dy) || 1, m = Math.min(d, temp); nd.px += nd.dx / d * m; nd.py += nd.dy / d * m; });
  }
  const maxS = Math.max(...nodes.map((nd) => nd.size), 1e-9), rmax = c.mobile ? 11 : 16, rmin = c.mobile ? 2.6 : 3.2;
  nodes.forEach((nd) => { nd.rad = rmin + Math.sqrt(nd.size / maxS) * (rmax - rmin); });
  const minx = Math.min(...nodes.map((q) => q.px - q.rad)), maxx = Math.max(...nodes.map((q) => q.px + q.rad)), miny = Math.min(...nodes.map((q) => q.py - q.rad)), maxy = Math.max(...nodes.map((q) => q.py + q.rad));
  const sc = Math.min((b.w - 24) / (maxx - minx || 1), (b.h - 24) / (maxy - miny || 1)), ox = b.x + (b.w - (maxx - minx) * sc) / 2 - minx * sc, oy = b.y + (b.h - (maxy - miny) * sc) / 2 - miny * sc;
  nodes.forEach((nd) => { nd.X = ox + nd.px * sc; nd.Y = oy + nd.py * sc; });
  const arg = lc(c.arg), regions = [], lines = [], labels = [];
  links.forEach(([i, j]) => lines.push({ x1: nodes[i].X, y1: nodes[i].Y, x2: nodes[j].X, y2: nodes[j].Y, c: "mute", w: 1, a: 0.2 }));
  const gcol = (gi) => c.pal.cycle[gi % c.pal.cycle.length];
  nodes.forEach((nd) => {
    const hl = arg && (lc(nd.label) === arg || lc(nd.id) === arg);
    regions.push(disc(nd.X, nd.Y, hl ? nd.rad * 1.5 : nd.rad, { c: hl ? c.col("red") : gcol(nd.gi), a: 0.9, fill: 0.35, href: nd.href, tip: "<b>" + esc(nd.label || nd.id) + "</b>" + (nd.group != null && nd.group !== "" ? "<br>" + esc(nd.group) : "") + "<br>" + esc(compact(nd.size)) }));
  });
  const placed = [];
  nodes.slice().sort((p, q) => q.size - p.size).slice(0, 9).forEach((nd) => { if (!nd.label || placed.some((q) => Math.hypot(q[0] - nd.X, q[1] - nd.Y) < 70)) return; placed.push([nd.X, nd.Y]); labels.push(lab(nd.X, nd.Y - nd.rad - 8, nd.label, { al: "center", size: c.mobile ? 10.5 : 12, f: "sans", w: 700, c: "ink", max: 130 })); });
  return { regions, labels, lines };
};

M.tiles = (s, b, c) => {
  let tiles = (s.tiles || []).filter((t) => t && t.label != null); if (!tiles.length) return null;
  const cap = Math.floor(c.N / Math.min(3, Math.max(1, Math.floor(c.N / tiles.length)))); if (tiles.length > cap) tiles = tiles.slice(0, cap);
  const hasG = tiles.some((t) => t.group != null && t.group !== ""), gap = 3, legendH = 26, labH = 20, order = [];
  const groups = new Map(); tiles.forEach((t) => { const g = hasG ? String(t.group == null ? "" : t.group) : ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); });
  groups.forEach((arr, g) => { arr.sort((p, q) => (ok(q.value) ? num(q.value) : -Infinity) - (ok(p.value) ? num(p.value) : -Infinity)); order.push([g, arr]); });
  const availH = b.h - legendH - 6; let sz = 8;
  for (let t = c.mobile ? 34 : 56; t >= 8; t--) {
    const cols = Math.max(1, Math.floor((b.w + gap) / (t + gap))); let h = 0; order.forEach(([g, arr]) => { h += Math.ceil(arr.length / cols) * (t + gap) + (hasG ? labH : 0); });
    if (h <= availH) { sz = t; break; }
  }
  const cols = Math.max(1, Math.floor((b.w + gap) / (sz + gap))), vals = tiles.filter((t) => ok(t.value)).map((t) => num(t.value)), lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
  const ramp = (v) => (ok(v) ? mix(c.pal.ramp0, c.pal.ramp1, hi === lo ? 0.5 : (num(v) - lo) / (hi - lo)) : c.col("na"));
  const regions = [], labels = [], arg = lc(c.arg);
  let y = b.y; const totalH = order.reduce((a, [, arr]) => a + Math.ceil(arr.length / cols) * (sz + gap) + (hasG ? labH : 0), 0); y += Math.max(0, (availH - totalH) / 2);
  order.forEach(([g, arr]) => {
    if (hasG) { labels.push(lab(b.x, y + labH / 2, g, { size: 12, f: "sans", w: 800, c: "ink", max: b.w })); y += labH; }
    arr.forEach((t, i) => {
      const x = b.x + (i % cols) * (sz + gap), yy = y + Math.floor(i / cols) * (sz + gap), hl = arg && lc(t.label) === arg;
      regions.push(rect(x, yy, sz, sz, { c: hl ? c.col("red") : ramp(t.value), a: 0.55, rr: 1.5, fill: 0.9, href: t.href, tip: "<b>" + esc(t.label) + "</b>" + (ok(t.value) ? "<br>" + esc(compact(t.value)) : "<br>sem dados") }));
      if (sz >= 36) labels.push(lab(x + sz / 2, yy + sz / 2, t.label, { al: "center", size: 9, f: "sans", w: 700, c: "ink", max: sz - 4 }));
    });
    y += Math.ceil(arr.length / cols) * (sz + gap);
  });
  if (vals.length) {
    const ly = b.y + b.h - legendH / 2 - 2, lx = b.x + b.w / 2 - 80;
    labels.push(lab(lx - 8, ly, compact(lo), { al: "right", size: 11.5, f: "sans", w: 700, c: "mute" }));
    for (let i = 0; i < 9; i++) labels.push(lab(lx + i * 18 + 8, ly, "", { kind: "dot", rad: 6, c: mix(c.pal.ramp0, c.pal.ramp1, i / 8) }));
    labels.push(lab(lx + 9 * 18 + 6, ly, compact(hi), { size: 11.5, f: "sans", w: 700, c: "mute" }));
  }
  return { regions, labels };
};

M.list = (s, b, c) => {
  const rows = (s.rows || []).filter((r) => r && r.title != null).slice(0, c.mobile ? 6 : 8); if (!rows.length) return null;
  const rowH = Math.min(c.mobile ? 62 : 74, b.h / rows.length), total = rowH * rows.length, y0 = b.y + (b.h - total) / 2, regions = [], labels = [], arg = lc(c.arg);
  rows.forEach((r, i) => {
    const y = y0 + i * rowH, hl = arg && lc(r.title) === arg, tip = r.href ? "<b>" + esc(r.title) + "</b>" : null;
    regions.push(rect(b.x, y + 3, b.w, rowH - 8, { c: c.col(hl ? "gold" : "mute"), a: 0.22, pa: 0.1, rr: 1.4, fill: hl ? 0.3 : 0.14, href: r.href, tip }));
    regions.push(rect(b.x, y + 3, 5, rowH - 8, { c: c.col(hl ? "red" : "green"), a: 1, rr: 1.2, fill: 1, href: r.href }));
    const px = b.x + 16;
    if (r.tag) labels.push(lab(px, y + rowH * 0.27, String(r.tag).toUpperCase(), { size: 10.5, f: "sans", w: 800, c: "red", max: b.w - 30 }));
    labels.push(lab(px, y + rowH * (r.tag ? 0.5 : 0.4), r.title, { size: c.mobile ? 14 : 17, f: "serif", w: 700, c: "ink", max: b.w - 30 }));
    if (r.sub) labels.push(lab(px, y + rowH * (r.tag ? 0.76 : 0.72), r.sub, { size: c.mobile ? 11 : 12.5, f: "sans", w: 500, c: "mute", max: b.w - 30 }));
  });
  return { regions, labels };
};

M.cover = (s, b, c) => {
  const regions = [], cols = c.mobile ? 9 : 16, rows = c.mobile ? 5 : 9, cw = b.w / cols, ch = b.h / rows, rad = Math.min(cw, ch) * 0.34, accent = ["red", "gold", "green"];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = (i * 7 + j * 3) % 11, col = k === 0 ? accent[(i + j) % 3] : k < 4 ? "blue" : "line", big = col === "blue" || k === 0;
    regions.push(disc(b.x + cw * (i + 0.5), b.y + ch * (j + 0.5), big ? rad : rad * 0.6, { c: c.col(col), a: s && s.dim ? 0.22 : col === "line" ? 0.7 : 0.9 }));
  }
  return { regions, labels: [] };
};

M._empty = (b, c, msg) => {
  const r = M.cover({ dim: true }, b, c);
  r.labels.push(lab(b.x + b.w / 2, b.y + b.h / 2, msg || "Sem dados para esta vista.", { al: "center", size: 17, f: "serif", w: 700, c: "ink", max: b.w - 20, shrink: true }));
  return r;
};
})();
