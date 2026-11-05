(function () {
"use strict";
const Story = (window.Story = window.Story || {});
const P = window.Portal;
const { clamp } = Story.util;
const geom = Story.geom;
const fmts = Story.fmt;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mk = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const pad2 = (n) => String(n).padStart(2, "0");
const THEME_KEY = "ed-tema";
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const DEFAULT_LINKS = [
  { label: "Parlamento", href: "#/parlamento" }, { label: "Governo", href: "#/governo" }, { label: "Dinheiro público", href: "#/contratos" },
  { label: "Poder local", href: "#/autarquias" }, { label: "Instituições", href: "#/entidades" }, { label: "Leis e justiça", href: "#/dre" },
];

Story.registry = Story.registry || {};
Story.register = (slug, def) => { Story.registry[slug] = def; };

const getPath = (o, p) => String(p).trim().split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const badText = (t) => /undefined|NaN|\[object/.test(t);
function fillCopy(copy, d) {
  const slots = [];
  const src = String(copy || "").replace(/\{\{([^}]+)\}\}/g, (_, body) => { slots.push(body); return "\u0001" + (slots.length - 1) + "\u0002"; });
  const paras = [];
  src.split(/\n\s*\n/).forEach((para) => {
    const out = [];
    para.trim().split(/(?<=[.!?…])\s+/).forEach((sent) => {
      let bad = false;
      const html = sent.split(/(\u0001\d+\u0002)/).map((part) => {
        const m = part.match(/^\u0001(\d+)\u0002$/); if (!m) return esc(part);
        const [path, f] = slots[+m[1]].split("|"), fn = fmts[(f || "str").trim()] || fmts.str;
        let v; try { v = fn(getPath(d, path)); } catch { v = null; }
        if (v == null || badText(String(v))) { bad = true; return ""; }
        return "<b>" + esc(v) + "</b>";
      }).join("");
      if (!bad && html.trim()) out.push(html.trim());
    });
    if (out.length) paras.push(out.join(" "));
  });
  return paras;
}
const headlineHtml = (s, d) => {
  let t; try { t = typeof s.headline === "function" ? s.headline(d) : s.headline; } catch { t = null; }
  if (t == null || t === "" || badText(String(t))) t = s.label || "";
  return esc(t).replace(/\*([^*]+)\*/g, "<em>$1</em>");
};

function readPal(root) {
  const cs = getComputedStyle(root), g = (n, f) => cs.getPropertyValue(n).trim() || f;
  const p = { ink: g("--st-ink", "#14120e"), mute: g("--st-mute", "#6b6558"), paper: g("--st-paper", "#faf7f0"), line: g("--st-line", "#cfc6ae"), red: g("--st-red", "#da291c"), green: g("--st-green", "#006600"), gold: g("--st-gold", "#ffcc00"), blue: g("--st-blue", "#1f4e9c"), na: g("--st-na", "#b9b19b"), ramp0: g("--st-ramp0", "#dfe7f5"), ramp1: g("--st-ramp1", "#1f4e9c"), serif: g("--st-serif", "Georgia, serif"), text: g("--st-text", "Georgia, serif"), sans: g("--st-sans", "Arial, sans-serif"), dark: document.documentElement.getAttribute("data-theme") === "dark" };
  p.cycle = [p.blue, p.red, p.green, p.gold, g("--st-violet", "#7a5aa6"), g("--st-orange", "#c4602a"), g("--st-teal", "#2a8fa0")];
  return p;
}
const TOK = ["ink", "mute", "paper", "line", "red", "green", "gold", "blue", "na"];

let mcx = null;
const measure = (t, size, w, fam, pal) => { mcx = mcx || document.createElement("canvas").getContext("2d"); mcx.font = (w || 400) + " " + size + "px " + (pal ? pal[fam] : "sans-serif"); return mcx.measureText(String(t)).width; };

function View(canvas, S, opts) {
  this.cv = canvas; this.cx = canvas.getContext("2d"); this.S = S; this.o = opts || {};
  this.W = 0; this.H = 0; this.dpr = 1; this.box = { x: 0, y: 0, w: 100, h: 100 }; this.N = 0; this.hov = -1; this.res = null; this.ov = { cur: null, prev: null, t0: 0 }; this.until = 0; this.t0 = 0; this.moving = false; this.cur = null;
}
View.prototype.init = function (N) {
  if (this.N === N) return; this.N = N;
  const f = () => new Float32Array(N);
  this.x = f(); this.y = f(); this.tx = f(); this.ty = f(); this.r = f(); this.tr = f(); this.a = f(); this.ta = f(); this.k = f(); this.dl = f();
  this.cr = f(); this.cg = f(); this.cb = f(); this.tcr = f(); this.tcg = f(); this.tcb = f(); this.rg = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) { this.x[i] = Math.random() * (this.W || 800); this.y[i] = Math.random() * (this.H || 600); this.r[i] = 1; this.k[i] = 0.045 + Math.random() * 0.07; this.cr[i] = this.cg[i] = this.cb[i] = 128; }
};
View.prototype.size = function (W, H, box) {
  if (this.cv.classList.contains("st-cv")) this.cv.style.marginBottom = -H + "px";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  this.W = W; this.H = H; this.dpr = dpr; this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr); this.box = box;
  this.cv.style.width = W + "px"; this.cv.style.height = H + "px";
};
View.prototype.ctx = function () {
  const pal = this.S.pal;
  return { pal, mobile: this.o.mobile, N: this.N, arg: this.S.arg, col: (c) => (TOK.includes(c) ? pal[c] : c || pal.blue), measure: (t, s, w, f) => measure(t, s, w, f, pal) };
};
View.prototype.set = function (m, animate) { this.cur = m; this.build(animate); };
View.prototype.build = function (animate) {
  const m = this.cur, c = this.ctx(); let res = null;
  if (m && Story.morphs[m.type]) { try { res = Story.morphs[m.type](m.spec || {}, this.box, c); } catch (e) { console.warn("[story] morph " + m.type, e); } }
  if (m && m.type === "cover") res = Story.morphs.cover({ dim: m.dim }, this.box, c);
  if (!res || !res.regions.length) res = Story.morphs._empty(this.box, c, m && m.empty);
  const prevCur = this.ov.cur, now = performance.now();
  this.res = res; this.ov = { cur: res, prev: animate ? prevCur : null, t0: now };
  this.assign(res.regions, animate, now);
  this.hov = -1; this.until = now + 1800; this.t0 = now;
};
const TAU = 6.283185307;
function place(rg, j, c, rng) {
  if (rg.k === "rect") { const cols = Math.max(1, Math.round(Math.sqrt(c * rg.w / Math.max(rg.h, 1e-6)))), rows = Math.ceil(c / cols); return geom.sample(rg, ((j % cols) + rng()) / cols, (Math.floor(j / cols) + rng()) / rows); }
  if (rg.k === "disc") return geom.sample(rg, (j + 0.5) / c, (j * 0.381966 + rng() * 0.05) % 1);
  if (rg.k === "ring") return geom.sample(rg, (j + 0.5) / c, (j * 0.618034 + rng() * 0.05) % 1);
  return geom.sample(rg, (j + rng()) / c, rng());
}
View.prototype.assign = function (regions, animate, now) {
  const N = this.N, R = regions.length, res = this.res, rng = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const areas = regions.map((r) => geom.area(r) * (r.mw || 1)), sum = areas.reduce((a, v) => a + v, 0), mn = Math.max(1, Math.min(3, Math.floor(N / R))), cap = res.maxPer || Infinity;
  const cnt = areas.map((a) => Math.min(cap, Math.max(mn, Math.floor(N * a / sum))));
  let tot = cnt.reduce((a, v) => a + v, 0);
  while (tot > N) { let bi = -1, bv = mn; for (let i = 0; i < R; i++) if (cnt[i] > bv) { bv = cnt[i]; bi = i; } if (bi < 0) break; cnt[bi]--; tot--; }
  if (tot < N && !res.maxPer) { const w = areas.map((a, i) => a / cnt[i]); while (tot < N) { let bi = 0; for (let i = 1; i < R; i++) if (w[i] > w[bi]) bi = i; cnt[bi]++; w[bi] = areas[bi] / cnt[bi]; tot++; } }
  const sx = new Float32Array(N), sy = new Float32Array(N), sr = new Float32Array(N), sa = new Float32Array(N), sc = new Array(N), sg = new Int16Array(N); let n = 0;
  regions.forEach((rg, ri) => {
    const rad = rg.rr || clamp(0.5 * Math.sqrt(geom.area(rg) / cnt[ri]) * 0.8, 1, 3.2), rgb = Story.util.hex(rg.c || "#888"), al = rg.pa != null ? rg.pa : rg.a == null ? 0.9 : rg.a;
    const pr = rg.k === "rect" && rg.w > rad * 4 && rg.h > rad * 4 ? { k: "rect", x: rg.x + rad, y: rg.y + rad, w: rg.w - 2 * rad, h: rg.h - 2 * rad } : rg;
    for (let j = 0; j < cnt[ri] && n < N; j++, n++) { const p = place(pr, j, cnt[ri], rng); sx[n] = p[0]; sy[n] = p[1]; sr[n] = rad; sa[n] = al * (0.88 + rng() * 0.12); sc[n] = rgb; sg[n] = ri; }
  });
  const dust = Story.util.hex(this.S.pal.mute), b = this.box;
  for (; n < N; n++) { sx[n] = b.x + rng() * b.w; sy[n] = b.y + rng() * b.h; sr[n] = 1; sa[n] = 0.2; sc[n] = dust; sg[n] = -1; }
  const pi = Array.from({ length: N }, (_, i) => i), si = Array.from({ length: N }, (_, i) => i);
  pi.sort((a, b2) => this.x[a] + this.y[a] * 0.35 - (this.x[b2] + this.y[b2] * 0.35));
  si.sort((a, b2) => sx[a] + sy[a] * 0.35 - (sx[b2] + sy[b2] * 0.35));
  for (let q = 0; q < N; q++) {
    const p = pi[q], t = si[q], c = sc[t];
    this.tx[p] = sx[t]; this.ty[p] = sy[t]; this.tr[p] = sr[t]; this.ta[p] = sa[t]; this.tcr[p] = c[0]; this.tcg[p] = c[1]; this.tcb[p] = c[2]; this.rg[p] = sg[t];
    this.dl[p] = animate ? Math.random() * 240 : 0;
    if (!animate) { this.x[p] = sx[t]; this.y[p] = sy[t]; this.r[p] = sr[t]; this.a[p] = sa[t]; this.cr[p] = c[0]; this.cg[p] = c[1]; this.cb[p] = c[2]; }
  }
};
View.prototype.step = function (now, dt) {
  const N = this.N, el = now - this.t0; let moving = false;
  for (let i = 0; i < N; i++) {
    if (el < this.dl[i]) { moving = true; continue; }
    const f = 1 - Math.pow(1 - this.k[i], dt / 16.67), dx = this.tx[i] - this.x[i], dy = this.ty[i] - this.y[i];
    this.x[i] += dx * f; this.y[i] += dy * f; this.r[i] += (this.tr[i] - this.r[i]) * f; this.a[i] += (this.ta[i] - this.a[i]) * f;
    this.cr[i] += (this.tcr[i] - this.cr[i]) * f; this.cg[i] += (this.tcg[i] - this.cg[i]) * f; this.cb[i] += (this.tcb[i] - this.cb[i]) * f;
    if (Math.abs(dx) > 0.06 || Math.abs(dy) > 0.06) moving = true;
  }
  this.moving = moving; return moving;
};
View.prototype.finish = function () {
  for (let i = 0; i < this.N; i++) { this.x[i] = this.tx[i]; this.y[i] = this.ty[i]; this.r[i] = this.tr[i]; this.a[i] = this.ta[i]; this.cr[i] = this.tcr[i]; this.cg[i] = this.tcg[i]; this.cb[i] = this.tcb[i]; }
  this.ov.prev = null; this.moving = false; this.draw(this.ov.t0 + 99999);
};
View.prototype.drawLabels = function (res, alpha, now) {
  const cx = this.cx, pal = this.S.pal, tc = clamp((now - this.ov.t0 - 150) / 1100, 0, 1);
  (res.labels || []).forEach((l) => {
    const col = TOK.includes(l.c) ? pal[l.c] : l.c || pal.ink; cx.globalAlpha = alpha; let size = l.size || 12, t = l.t;
    if (l.kind === "dot") { cx.fillStyle = col; cx.beginPath(); cx.arc(l.x, l.y, l.rad || 5, 0, 6.2832); cx.fill(); return; }
    if (l.num != null && res === this.ov.cur) { const fn = l.nf === "big" ? res.bigFmt : null; t = fn ? fn(l.num * ease(tc)) : String(Math.round(l.num * ease(tc))); }
    const setF = () => { cx.font = (l.w || 400) + " " + size + "px " + pal[l.f || "sans"]; }; setF();
    if (l.max) { let w = cx.measureText(t).width; if (w > l.max) { if (l.shrink) { size = Math.max(9, size * l.max / w); setF(); } else { while (t.length > 2 && cx.measureText(t + "…").width > l.max) t = t.slice(0, -1); t = t.trimEnd() + "…"; } } }
    cx.textAlign = l.al || "left"; cx.textBaseline = l.bl || "middle";
    if (l.halo !== false) { cx.lineWidth = 3.5; cx.lineJoin = "round"; cx.strokeStyle = pal.paper; cx.strokeText(t, l.x, l.y); }
    cx.fillStyle = col; cx.fillText(t, l.x, l.y);
  });
  cx.globalAlpha = 1;
};
View.prototype.drawLines = function (res, alpha) {
  const cx = this.cx, pal = this.S.pal;
  (res.lines || []).forEach((l) => {
    cx.globalAlpha = (l.a == null ? 1 : l.a) * alpha; cx.strokeStyle = TOK.includes(l.c) ? pal[l.c] : l.c; cx.lineWidth = l.w || 1; cx.setLineDash(l.dash || []);
    cx.beginPath(); cx.moveTo(l.x1, l.y1); cx.lineTo(l.x2, l.y2); cx.stroke();
  });
  cx.setLineDash([]); cx.globalAlpha = 1;
};
View.prototype.drawFills = function (res, alpha) {
  const cx = this.cx, hov = this.hov;
  (res.regions || []).forEach((r, i) => {
    if (!r.fill) return;
    let a = r.fill * alpha; if (hov >= 0) a *= hov === i ? 1.8 : 0.45;
    cx.globalAlpha = Math.min(1, a); cx.fillStyle = r.c; cx.beginPath();
    if (r.k === "rect") cx.rect(r.x, r.y, r.w, r.h);
    else if (r.k === "disc") cx.arc(r.x, r.y, r.rad, 0, TAU);
    else if (r.k === "ribbon") {
      const n = 28; for (let q = 0; q <= n; q++) { const u = q / n, e = u * u * (3 - 2 * u), x = r.x0 + (r.x1 - r.x0) * u, y = r.y0 + (r.y1 - r.y0) * e - (r.t0 + (r.t1 - r.t0) * u) / 2; if (q) cx.lineTo(x, y); else cx.moveTo(x, y); }
      for (let q = n; q >= 0; q--) { const u = q / n, e = u * u * (3 - 2 * u); cx.lineTo(r.x0 + (r.x1 - r.x0) * u, r.y0 + (r.y1 - r.y0) * e + (r.t0 + (r.t1 - r.t0) * u) / 2); }
      cx.closePath();
    } else return;
    cx.fill();
  });
  cx.globalAlpha = 1;
};
View.prototype.draw = function (now) {
  const cx = this.cx; cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); cx.clearRect(0, 0, this.W, this.H);
  const f = clamp((now - this.ov.t0 - 200) / 500, 0, 1), ov = this.ov;
  if (ov.prev && f < 1) { this.drawFills(ov.prev, 1 - f); this.drawLines(ov.prev, 1 - f); }
  if (ov.cur) { this.drawFills(ov.cur, f); this.drawLines(ov.cur, f); }
  const hov = this.hov;
  for (let i = 0; i < this.N; i++) {
    let a = this.a[i], r = this.r[i];
    if (hov >= 0) { if (this.rg[i] === hov) { a = Math.min(1, a * 1.2); r *= 1.3; } else a *= 0.4; }
    if (a < 0.02) continue;
    cx.globalAlpha = a; cx.fillStyle = "rgb(" + (this.cr[i] | 0) + "," + (this.cg[i] | 0) + "," + (this.cb[i] | 0) + ")";
    cx.beginPath(); cx.arc(this.x[i], this.y[i], r, 0, 6.2832); cx.fill();
  }
  cx.globalAlpha = 1;
  if (ov.prev && f < 1) this.drawLabels(ov.prev, 1 - f, now);
  if (ov.cur) this.drawLabels(ov.cur, f, now);
};
View.prototype.hit = function (px, py) {
  const rs = this.res ? this.res.regions : []; for (let i = rs.length - 1; i >= 0; i--) { const r = rs[i]; if ((r.tip || r.href) && geom.contains(r, px, py, 1)) return i; } return -1;
};

const S = Story.state = { mounted: false, slug: null, mid: 0, raf: 0, arg: "", pal: null, items: [], cur: -1, view: null, statics: [], failed: false };
const isMobile = () => window.innerWidth < 720;
const reduced = (params) => (params && params.static === "1") || new URLSearchParams(location.search).get("static") === "1" || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

function wake() { if (!S.raf && S.view) S.raf = requestAnimationFrame(loop); }
let last = 0;
function loop() {
  S.raf = 0; const v = S.view; if (!v) return; const now = performance.now();
  const dt = Math.min(1500, now - (last || now - 16)); last = now;
  const moving = v.step(now, dt); v.draw(now);
  if (moving || now < v.until) { S.raf = requestAnimationFrame(loop); } else last = 0;
}

function sceneMorph(it, d) {
  if (it.kind === "cover") return { type: "cover" };
  if (it.kind === "dir") return { type: "cover", dim: true };
  const m = it.sc.morph || {};
  let spec = null; try { spec = typeof m.items === "function" ? m.items(d) : m.items; } catch (e) { console.warn("[story] items " + it.id, e); }
  return { type: m.type, spec, empty: "Sem dados para esta cena." };
}

function computeBox(rootEl) {
  const mob = isMobile(), W = S.sc ? S.sc.clientWidth : window.innerWidth, H = S.sc ? S.sc.clientHeight : window.innerHeight;
  if (mob) { const h = Math.round(H * 0.45); return { W, H: h, box: { x: 10, y: 54, w: W - 20, h: h - 54 - 10 } }; }
  const cap = rootEl.querySelector(".st-sec:not(.st-cover) .st-cap") || rootEl.querySelector(".st-cap"), r = cap ? cap.getBoundingClientRect() : null;
  const x = Math.max(W * 0.38, r ? r.right + 36 : 0);
  return { W, H, box: { x, y: 78, w: Math.max(260, W - x - 70), h: H - 78 - 44 } };
}

function applyScene(i, animate) {
  const it = S.items[i]; if (!it) return;
  if (S.view) { S.view.set(sceneMorph(it, S.data), animate); if (animate) wake(); else { S.view.finish(); } }
}

function relayout(animate) {
  if (!S.mounted || !S.root) return;
  S.pal = readPal(S.root);
  if (S.static) { S.statics.forEach((s) => paintStatic(s)); return; }
  const g = computeBox(S.root), v = S.view, mob = isMobile(); v.o.mobile = mob; v.init(mob ? 900 : 2400); v.size(g.W, g.H, g.box);
  S.root.classList.toggle("mobile", mob);
  applyScene(Math.max(0, S.cur), animate); wake();
}

function paintStatic(s) {
  const fig = s.fig, w = Math.min(960, Math.max(280, fig.parentElement.clientWidth)), mob = w < 560 || isMobile(), h = mob ? 340 : 460;
  s.view.o.mobile = mob; s.view.init(mob ? 900 : 2400); s.view.size(w, h, { x: 8, y: 14, w: w - 16, h: h - 28 });
  s.view.set(sceneMorph(s.it, S.data), false); s.view.finish();
}

function jump(i, smooth, frac) {
  const sec = S.secs[i]; if (!sec || !S.sc) return;
  const sc = S.sc, top = sec.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + (frac ? frac * Math.max(0, sec.offsetHeight - sc.clientHeight) : 0);
  sc.scrollTo({ top: Math.max(0, top), behavior: smooth && !S.static ? "smooth" : "instant" });
}

function setHash(i, frac) {
  const it = S.items[i]; if (!it) return;
  const h = "#/historia/" + S.slug + (i > 0 || S.arg ? "/" + it.id + (S.arg ? "/" + encodeURIComponent(S.arg) : "") : "") + (frac ? "?t=" + frac.toFixed(2) : "");
  if (location.hash !== h) history.replaceState(null, "", h);
}

function setCurrent(i, force) {
  if (i === S.cur && !force) return;
  S.cur = i;
  S.root.querySelectorAll(".st-tabs button, .st-rail button").forEach((b) => { const on = +b.dataset.i === i; b.classList.toggle("on", on); if (on) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); });
  const pos = S.root.querySelector(".st-pos"); if (pos) pos.textContent = pad2(i + 1) + "/" + pad2(S.items.length) + " · " + S.items[i].label;
  const on = S.root.querySelector(".st-tabs button.on"); if (on && on.scrollIntoView) { const tabs = on.parentElement; tabs.scrollLeft = on.offsetLeft - tabs.clientWidth / 2 + on.clientWidth / 2; }
  S.secs.forEach((s, k) => s.classList.toggle("act", k === i));
  if (!S.static) { applyScene(i, true); wake(); }
  S.root.classList.toggle("end", S.items[i].kind === "dir");
}

let scrollQ = 0, hashT = 0;
function onScroll() {
  if (scrollQ || !S.mounted) return;
  scrollQ = requestAnimationFrame(() => { scrollQ = 0; syncScroll(); });
}
function sceneFrac(i) {
  const sec = S.secs[i == null ? S.cur : i]; if (!sec) return 0;
  const vh = S.sc.clientHeight, r = sec.getBoundingClientRect(), span = sec.offsetHeight - vh;
  return span > 40 ? clamp(-(r.top - S.sc.getBoundingClientRect().top) / span, 0, 1) : 0;
}
function syncScroll() {
  if (!S.mounted || !S.sc) return;
  const vh = S.sc.clientHeight; let idx = 0;
  S.secs.forEach((sec, k) => { const r = sec.getBoundingClientRect(); if (r.top + Math.min(r.height, vh) / 2 <= vh * 0.62) idx = k; });
  const max = Math.max(1, S.sc.scrollHeight - vh), t = clamp(S.sc.scrollTop / max, 0, 1);
  const fill = S.root.querySelector(".st-bar i"); if (fill) fill.style.transform = "scaleX(" + t.toFixed(4) + ")";
  const rf = S.root.querySelector(".st-rail-fill"); if (rf) rf.style.height = (t * 100).toFixed(2) + "%";
  setCurrent(idx);
  clearTimeout(hashT); hashT = setTimeout(() => {
    if (!S.mounted || !S.sc) return;
    const f = sceneFrac(); S.keep = { i: S.cur, f };
    setHash(S.cur, f);
  }, 350);
  S.keep = { i: idx, f: sceneFrac(idx) };
}

function goScene(i, smooth) {
  i = clamp(i, 0, S.items.length - 1); jump(i, smooth); if (S.static) { setCurrent(i); setHash(i, 0); }
  closeMenu();
}

function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark", t = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem(THEME_KEY, t); } catch {}
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "dark" ? "#131210" : "#faf7f0";
}

function openMenu(focus) { if (!S.menu) return; S.menu.classList.add("open"); document.body.classList.add("st-noscroll"); if (focus) setTimeout(() => S.menu.querySelector("input").focus(), 30); }
function closeMenu() { if (S.menu) { S.menu.classList.remove("open"); document.body.classList.remove("st-noscroll"); if (S.sc) S.sc.focus({ preventScroll: true }); } }

function onKey(e) {
  if (!S.mounted || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (e.key === "Escape") { closeMenu(); return; }
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "ArrowRight") { e.preventDefault(); goScene(S.cur + 1, true); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); goScene(S.cur - 1, true); }
  else if (/^[1-9]$/.test(e.key)) { goScene(+e.key - 1, true); }
  else if (e.key === "m" || e.key === "M") { S.menu.classList.contains("open") ? closeMenu() : openMenu(); }
  else if (e.key === "/") { e.preventDefault(); openMenu(true); }
}

function bindHover(v, cv, tipEl) {
  const show = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, h = v.hit(x, y);
    if (h !== v.hov) { v.hov = h; if (S.static) v.draw(v.ov.t0 + 99999); else { v.until = Math.max(v.until, performance.now() + 250); wake(); } }
    cv.style.cursor = h >= 0 && v.res.regions[h].href ? "pointer" : "default";
    if (h >= 0 && v.res.regions[h].tip) {
      const rg = v.res.regions[h], t = typeof rg.tip === "function" ? rg.tip(x, y) : rg.tip;
      tipEl.innerHTML = t + (rg.href ? '<span class="st-go">abrir →</span>' : ""); tipEl.classList.add("on");
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight; tipEl.style.left = clamp(e.clientX + 14, 8, window.innerWidth - tw - 8) + "px"; tipEl.style.top = clamp(e.clientY + 14, 8, window.innerHeight - th - 8) + "px";
    } else tipEl.classList.remove("on");
  };
  cv.addEventListener("pointermove", show);
  cv.addEventListener("pointerleave", () => { v.hov = -1; tipEl.classList.remove("on"); if (S.static) v.draw(v.ov.t0 + 99999); else wake(); });
  cv.addEventListener("click", (e) => {
    const r = cv.getBoundingClientRect(), h = v.hit(e.clientX - r.left, e.clientY - r.top), rg = h >= 0 ? v.res.regions[h] : null;
    if (rg && rg.href) { if (rg.href[0] === "#") location.hash = rg.href; else location.assign(rg.href); }
  });
}

function buildItems(def, d) {
  const items = [{ id: "inicio", label: "Início", kind: "cover" }];
  (def.scenes || []).forEach((sc) => { let ok = true; try { ok = sc.when ? !!sc.when(d) : true; } catch { ok = false; } if (ok && sc.morph) items.push({ id: sc.id, label: sc.label || sc.id, kind: "scene", sc }); });
  items.push({ id: "directorio", label: "Directório", kind: "dir" });
  return items;
}

function sourceHtml(sc, d) {
  const s = sc.source; if (!s) return "";
  let asof = null; try { asof = s.asof ? s.asof(d) : null; } catch {}
  if (asof != null && badText(String(asof))) asof = null;
  const lab = s.href ? '<a href="' + esc(s.href) + '">' + esc(s.label || "fonte") + "</a>" : esc(s.label || "");
  return '<p class="st-src">Fonte: ' + lab + (asof ? " · dados de " + esc(asof) : "") + "</p>";
}

function dirHtml(def, items, d) {
  const dir = (def.directory || []).filter((x) => x && x.label && x.href), srcs = [], seen = new Set();
  items.forEach((it) => { if (it.kind === "scene" && it.sc.source && it.sc.source.label && !seen.has(it.sc.source.label)) { seen.add(it.sc.source.label); srcs.push(it.sc.source); } });
  return '<div class="st-dirin"><p class="st-kick">Directório</p><h2>Continue a <em>explorar</em></h2><p class="st-lede">Cada página abaixo mostra os dados por trás desta história, com as fontes originais.</p>' +
    '<div class="st-dirgrid">' + dir.map((x) => '<a class="st-card" href="' + esc(x.href) + '"><b>' + esc(x.label) + "</b><span>" + esc(x.desc || "") + "</span></a>").join("") + "</div>" +
    (srcs.length ? '<h3 class="st-srch">Fontes desta história</h3><ul class="st-srcs">' + srcs.map((s) => "<li>" + (s.href ? '<a href="' + esc(s.href) + '">' + esc(s.label) + "</a>" : esc(s.label)) + "</li>").join("") + "</ul>" : "") +
    '<p class="st-note">Os indicadores são sinais estatísticos e não constituem acusação nem prova de irregularidade.</p></div>';
}

function unavailable(root, def, slug, why) {
  const links = (def && def.fallback) || DEFAULT_LINKS;
  root.className = "st-root st-fail";
  root.innerHTML = '<div class="st-failbox" role="alert"><p class="st-kick">Estado Aberto</p><h1>Dados indisponíveis</h1><p>' + esc(why || "Não foi possível carregar os dados desta história neste momento.") + " Os dados não foram inventados nem substituídos: tente novamente mais tarde ou consulte directamente as páginas da secção.</p>" +
    '<div class="st-failact"><button type="button" class="st-btn" id="st-retry">Tentar de novo</button><a class="st-btn ghost" href="#/">Página inicial</a></div><ul class="st-faillinks">' + links.map((l) => '<li><a href="' + esc(l.href) + '">' + esc(l.label) + "</a></li>").join("") + "</ul></div>";
  const rb = root.querySelector("#st-retry"); if (rb) rb.onclick = () => { unmountDom(); mount(slug + (S.arg ? "/" + S.arg : ""), {}); };
}

function loadOne(url) {
  return new Promise((res) => { const s = document.createElement("script"); s.src = url; s.onload = () => res(true); s.onerror = () => res(false); document.head.appendChild(s); });
}
async function loadScript(slug) {
  const n = encodeURIComponent(slug);
  for (const f of [n, "_" + n]) {
    const url = "/historias/" + f + ".js";
    let js = false; try { const r = await fetch(url, { method: "HEAD" }); js = r.ok && /javascript/.test(r.headers.get("content-type") || ""); } catch {}
    if (!js) continue;
    await loadOne(url + "?v=" + Date.now()); if (Story.registry[slug]) return true;
  }
  return false;
}

function unmountDom() {
  cancelAnimationFrame(S.raf); S.raf = 0; cancelAnimationFrame(scrollQ); scrollQ = 0; clearTimeout(hashT);
  if (S.sc) S.sc.removeEventListener("scroll", onScroll); window.removeEventListener("resize", S.onResize); window.removeEventListener("keydown", onKey);
  if (S.mo) S.mo.disconnect(); S.mo = null;
  if (S.root) S.root.remove(); if (S.tip) S.tip.remove();
  S.root = S.tip = S.menu = S.view = S.sc = null; S.statics = []; S.mounted = false; S.cur = -1;
  document.body.classList.remove("story-mode", "st-noscroll");
}

function build(def, d, params) {
  S.items = buildItems(def, d); S.data = d; S.static = reduced(params) || !document.createElement("canvas").getContext;
  const root = S.root, items = S.items, mob = isMobile();
  root.className = "st-root" + (S.static ? " static" : "") + (mob ? " mobile" : "");
  const tabs = items.map((it, i) => '<button type="button" data-i="' + i + '"><b>' + pad2(i + 1) + "</b>" + esc(it.label) + "</button>").join("");
  const rail = items.map((it, i) => '<button type="button" data-i="' + i + '" aria-label="' + esc(it.label) + '"><span>' + esc(it.label) + "</span></button>").join("");
  const secs = items.map((it, i) => {
    if (it.kind === "cover") return '<section class="st-sec st-cover" id="st-inicio" data-i="0"><article class="st-cap"><p class="st-kick">Estado Aberto · história</p><h1>' + headlineTitle(def) + "</h1>" + (def.question ? '<p class="st-q">' + esc(def.question) + "</p>" : "") + '<span class="st-cue" aria-hidden="true"><i></i>Deslize para ler</span></article>' + (S.static ? '<figure class="st-fig"><canvas aria-label="Ilustração de abertura"></canvas></figure>' : "") + "</section>";
    if (it.kind === "dir") return '<section class="st-sec st-dir" id="st-directorio" data-i="' + i + '">' + dirHtml(def, items, d) + "</section>";
    const sc = it.sc, paras = fillCopy(sc.copy, d);
    return '<section class="st-sec" id="st-' + esc(it.id) + '" data-i="' + i + '"><article class="st-cap"><p class="st-kick"><b>' + pad2(i + 1) + "</b>" + esc(sc.kicker || sc.label || "") + "</p><h2>" + headlineHtml(sc, d) + "</h2>" + paras.map((p) => "<p>" + p + "</p>").join("") + sourceHtml(sc, d) + "</article>" + (S.static ? '<figure class="st-fig"><canvas aria-label="' + esc(sc.label || "") + '"></canvas></figure>' : "") + "</section>";
  }).join("");
  root.innerHTML = '<header class="st-nav"><a class="st-back" href="#/">← Estado Aberto</a><span class="st-title">' + esc(def.title || "") + '</span><nav class="st-tabs" aria-label="Cenas">' + tabs + '</nav><span class="st-pos"></span><span class="st-actions"><button type="button" class="st-btn" data-act="menu" aria-label="Directório (M)">Directório</button><button type="button" class="st-btn icon" data-act="theme" aria-label="Alternar modo noite">◐</button></span></header>' +
    '<div class="st-bar"><i></i></div><nav class="st-rail" aria-label="Progresso"><u class="st-rail-fill"></u>' + rail + "</nav>" +
    '<div class="st-scroll" tabindex="-1">' + (S.static ? "" : '<canvas class="st-cv" role="img" aria-label="' + esc(def.title || "") + '"></canvas>') + '<main class="st-main">' + secs + "</main></div>" +
    '<div class="st-help"><span><kbd>←</kbd><kbd>→</kbd> cenas</span><span><kbd>1</kbd>–<kbd>9</kbd> saltar</span><span><kbd>M</kbd> directório</span><span><kbd>/</kbd> procurar</span></div>' +
    '<div class="st-menu" role="dialog" aria-label="Directório"><button type="button" class="st-btn st-close" data-act="close">Fechar ✕</button><div class="st-menuin"><input type="search" placeholder="Filtrar cenas e páginas…" aria-label="Filtrar"><h3>Cenas</h3><div class="st-mscenes"></div><h3>Páginas</h3><div class="st-mdir"></div></div></div>';
  S.menu = root.querySelector(".st-menu"); S.sc = root.querySelector(".st-scroll"); S.secs = [...root.querySelectorAll(".st-sec")];
  const dir = (def.directory || []).filter((x) => x && x.label && x.href);
  const fillMenu = (q) => {
    q = (q || "").toLowerCase();
    S.menu.querySelector(".st-mscenes").innerHTML = items.map((it, i) => ({ it, i })).filter((o) => !q || o.it.label.toLowerCase().includes(q)).map((o) => '<button type="button" data-i="' + o.i + '"><b>' + pad2(o.i + 1) + "</b>" + esc(o.it.label) + "</button>").join("") || '<p class="st-none">Sem resultados.</p>';
    S.menu.querySelector(".st-mdir").innerHTML = dir.filter((x) => !q || (x.label + " " + (x.desc || "")).toLowerCase().includes(q)).map((x) => '<a href="' + esc(x.href) + '"><b>' + esc(x.label) + "</b><span>" + esc(x.desc || "") + "</span></a>").join("") || '<p class="st-none">Sem resultados.</p>';
  };
  fillMenu(""); S.menu.querySelector("input").oninput = (e) => fillMenu(e.target.value);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]"); if (b) { goScene(+b.dataset.i, true); return; }
    const a = e.target.closest("[data-act]"); if (!a) return;
    if (a.dataset.act === "menu") openMenu(); else if (a.dataset.act === "close") closeMenu(); else if (a.dataset.act === "theme") toggleTheme();
    if (e.target.closest(".st-menu a")) closeMenu();
  });
  S.menu.addEventListener("click", (e) => { if (e.target === S.menu) closeMenu(); if (e.target.closest("a")) closeMenu(); });
  S.tip = mk("div", "st-tip"); document.body.append(S.tip);
  S.pal = readPal(root);
  if (S.static) {
    S.statics = S.secs.map((sec, i) => ({ fig: sec.querySelector("canvas"), it: items[i] })).filter((o) => o.fig).map((o) => { o.view = new View(o.fig, S, { mobile: false }); bindHover(o.view, o.fig, S.tip); return o; });
    S.statics.forEach((o) => paintStatic(o));
  } else {
    const cv = root.querySelector(".st-cv"); S.view = new View(cv, S, { mobile: mob }); bindHover(S.view, cv, S.tip);
    const g = computeBox(root); S.view.init(mob ? 900 : 2400); S.view.size(g.W, g.H, g.box);
  }
}

const headlineTitle = (def) => esc(def.title || "").replace(/\*([^*]+)\*/g, "<em>$1</em>");

function startRuntime() {
  let rt = 0; S.onResize = () => { clearTimeout(rt); rt = setTimeout(() => { relayout(false); if (S.keep) jump(S.keep.i, false, S.keep.f); }, 120); };
  window.addEventListener("resize", S.onResize); S.sc.addEventListener("scroll", onScroll, { passive: true }); window.addEventListener("keydown", onKey);
  S.mo = new MutationObserver(() => relayout(false)); S.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.mounted && S.root) relayout(false); });
}

function locate(arg) {
  const parts = String(arg || "").split("/"), slug = parts[0], id = parts[1] || "", rest = parts.slice(2).join("/");
  return { slug, id, rest };
}

function gotoInitial(id, params) {
  let i = Math.max(0, S.items.findIndex((it) => it.id === id));
  const t = params && params.t != null ? parseFloat(params.t) : NaN;
  if (!id && Number.isFinite(t)) { S.sc.scrollTo(0, clamp(t, 0, 1) * (S.sc.scrollHeight - S.sc.clientHeight)); return; }
  jump(i, false, Number.isFinite(t) ? clamp(t, 0, 1) : 0);
}

async function mount(arg, params) {
  const { slug, id, rest } = locate(arg), app = document.getElementById("app");
  unmountDom(); const mid = ++S.mid; S.slug = slug; S.arg = rest; S.failed = false; S.mounted = true;
  document.body.classList.add("story-mode");
  const root = mk("div", "st-root"); S.root = root; document.body.append(root); if (app) app.innerHTML = "";
  if (!slug) { S.mounted = false; listStories(root); return; }
  root.innerHTML = '<div class="st-load"><i class="st-coin"></i><p>A carregar os dados abertos…</p></div>';
  let def = Story.registry[slug];
  if (!def) { await loadScript(slug); def = Story.registry[slug]; }
  if (mid !== S.mid) return;
  if (!def) { S.failed = true; if (!underConstruction(root, slug)) unavailable(root, null, slug, "Esta história não existe ou ainda não foi publicada."); return; }
  let d;
  try { d = await Promise.race([Promise.resolve(def.load()), new Promise((_, rej) => setTimeout(() => rej(new Error("tempo esgotado")), 45000))]); if (d == null || typeof d !== "object") throw new Error("resposta vazia"); }
  catch (e) { console.warn("[story] load", e); if (mid !== S.mid) return; S.failed = true; unavailable(root, def, slug); return; }
  if (mid !== S.mid) return;
  try { build(def, d, params); } catch (e) { console.error(e); S.failed = true; unavailable(root, def, slug, "Ocorreu um erro ao montar a história."); return; }
  if (S.items.length < 3) { S.failed = true; unavailable(root, def, slug, "Esta história não tem dados suficientes de momento."); return; }
  document.title = String(def.title || "História").replace(/\*/g, "") + " — Estado Aberto";
  startRuntime();
  relayout(true);
  gotoInitial(id, params);
  syncScroll();
  setCurrent(Math.max(0, S.items.findIndex((it) => it.id === id)), true);
  S.sc.focus({ preventScroll: true });
  const ld = root.querySelector(".st-load"); if (ld) { ld.classList.add("gone"); setTimeout(() => ld.remove(), 600); }
  wake();
}

function underConstruction(root, slug) {
  const g = ((P && P.NAV_GROUPS) || []).find((x) => x[1] === slug); if (!g) return false;
  root.className = "st-root st-fail";
  root.innerHTML = '<div class="st-failbox"><p class="st-kick">Estado Aberto</p><h1>' + esc(g[0]) + '</h1><p>Em construção: a história desta secção ainda não está publicada. Entretanto, consulte as páginas da secção.</p><ul class="st-faillinks">' + g[2].map(([r, l]) => '<li><a href="#/' + esc(r) + '">' + esc(l) + "</a></li>").join("") + '</ul><div class="st-failact"><a class="st-btn ghost" href="#/">Página inicial</a></div></div>';
  return true;
}

function listStories(root) {
  const items = Object.keys(Story.registry).filter((k) => k[0] !== "_" && !k.startsWith("demo"));
  root.className = "st-root st-fail";
  root.innerHTML = '<div class="st-failbox"><p class="st-kick">Estado Aberto</p><h1>Histórias</h1><ul class="st-faillinks">' + (items.length ? items.map((k) => '<li><a href="#/historia/' + esc(k) + '">' + esc(Story.registry[k].title || k) + "</a></li>").join("") : DEFAULT_LINKS.map((l) => '<li><a href="' + esc(l.href) + '">' + esc(l.label) + "</a></li>").join("")) + "</ul></div>";
}

if (P) {
  P.page("historia", mount);
  P.storyHandle = (name, arg, params) => {
    if (name !== "historia" || !S.mounted || S.failed) return false;
    const { slug, id, rest } = locate(arg); if (slug !== S.slug || !S.items.length) return false;
    S.arg = rest; const i = Math.max(0, S.items.findIndex((it) => it.id === id));
    if (S.static) { setCurrent(i, true); } else applyScene(i, true);
    gotoInitial(id, params); wake(); return true;
  };
  P.storyUnmount = () => { if (S.mounted || S.root) { unmountDom(); document.title = "Estado Aberto — o poder público, escrutinado"; } };
}
window.addEventListener("pagehide", () => cancelAnimationFrame(S.raf));
})();
