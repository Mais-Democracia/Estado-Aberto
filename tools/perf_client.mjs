import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes("--" + n);
const BASE = arg("base", "http://127.0.0.1:3170").replace(/\/$/, "");
const LABEL = arg("label", "run");
const OUT = arg("out", "");
const CHROME = arg("chrome", process.env.CHROME || "/usr/bin/chromium");
const CPU = Number(arg("cpu", 1));
const ONLY = arg("only", "");
const PAGES = [["home", "/"], ["igf", "/#/igf"], ["historia", "/#/historia/parlamento"], ["votacoes", "/#/votacoes"]];
const PROFILES = {
  "slow4g": { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  "fast3g": { latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
};
const NAV_ROUTES = ["igf", "votacoes", "deputados", "orcamento", "ministerios"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INJECT = `(() => {
  const m = (window.__m = { fcp: 0, lcp: 0, lt: [], app: 0, click: 0, render: 0, cls: 0 });
  const obs = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  obs("paint", (e) => { if (e.name === "first-contentful-paint") m.fcp = e.startTime; });
  obs("largest-contentful-paint", (e) => { m.lcp = e.startTime; });
  obs("layout-shift", (e) => { if (!e.hadRecentInput) m.cls += e.value; });
  obs("longtask", (e) => m.lt.push([e.startTime, e.duration]));
  document.addEventListener("click", () => { m.click = performance.now(); m.render = 0; const h = document.querySelector("#app h1"); m.prev = h ? h.textContent : null; }, true);
  const watch = () => {
    const app = document.getElementById("app");
    if (!app) return requestAnimationFrame(watch);
    new MutationObserver(() => {
      if (app.querySelector(".sk, .sk-boot") || !app.firstElementChild || app.innerText.length < 150) return;
      const t = performance.now();
      if (!m.app) m.app = t;
      const h = app.querySelector("h1");
      if (m.click && !m.render && t > m.click && (!m.prev || !h || h.textContent !== m.prev)) m.render = t - m.click;
    }).observe(app, { childList: true, subtree: true });
  };
  document.addEventListener("DOMContentLoaded", watch);
  if (document.readyState !== "loading") watch();
})();`;

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.cb = new Map(); this.ev = []; ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id) { const c = this.cb.get(j.id); this.cb.delete(j.id); j.error ? c[1](new Error(j.error.message)) : c[0](j.result); } else for (const h of this.ev) h(j); }; }
  send(method, params = {}, sessionId) { return new Promise((res, rej) => { const id = ++this.id; this.cb.set(id, [res, rej]); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  on(h) { this.ev.push(h); }
}

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-perf-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--window-size=1366,900", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  let list;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.some((t) => t.type === "page")) break; } catch {}
    await sleep(250);
  }
  const t = list.find((x) => x.type === "page");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);
  const bws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
  cdp.browser = new CDP(bws);
  const stop = async () => { try { ws.close(); bws.close(); } catch {} proc.kill("SIGKILL"); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); };
  return { cdp, stop };
}

async function setup(cdp, profile) {
  await cdp.send("Page.enable"); await cdp.send("Network.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Debugger.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const st = { reqs: new Map(), inflight: 0, last: Date.now(), scripts: new Map(), sw: [], net: PROFILES[profile] };
  st.apply = async (c) => { st.net = c; const cond = { offline: false, latency: c.latency, downloadThroughput: c.downloadThroughput, uploadThroughput: c.uploadThroughput }; await cdp.send("Network.emulateNetworkConditions", cond); for (const sid of st.sw) await cdp.browser.send("Network.emulateNetworkConditions", cond, sid).catch(() => {}); };
  cdp.browser.on((j) => {
    const p = j.params;
    if (j.method === "Target.targetCreated" && p.targetInfo.type === "service_worker") cdp.browser.send("Target.attachToTarget", { targetId: p.targetInfo.targetId, flatten: true }).then((r) => { st.sw.push(r.sessionId); return cdp.browser.send("Network.enable", {}, r.sessionId).then(() => st.apply(st.net)); }).catch(() => {});
  });
  await cdp.browser.send("Target.setDiscoverTargets", { discover: true });
  cdp.on((j) => {
    const p = j.params;
    if (j.method === "Network.requestWillBeSent") { if (!/^(data|chrome|blob)/.test(p.request.url)) { st.reqs.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, status: 0, fromSW: false }); st.inflight++; st.last = Date.now(); } }
    else if (j.method === "Network.responseReceived") { const r = st.reqs.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.fromSW = !!p.response.fromServiceWorker; r.fromCache = !!p.response.fromDiskCache || !!p.response.fromPrefetchCache; } }
    else if (j.method === "Network.loadingFinished") { const r = st.reqs.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; r.done = true; st.inflight--; st.last = Date.now(); } }
    else if (j.method === "Network.loadingFailed") { const r = st.reqs.get(p.requestId); if (r) { r.done = true; st.inflight--; st.last = Date.now(); } }
    else if (j.method === "Debugger.scriptParsed") st.scripts.set(p.scriptId, { url: p.url, length: p.length });
  });
  await st.apply(PROFILES[profile]);
  return st;
}

async function idle(st, quiet = 700, cap = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < cap) { if (st.inflight <= 0 && Date.now() - st.last > quiet) return; await sleep(100); }
}

const coveredBytes = (cov, st) => {
  let run = 0, total = 0;
  for (const s of cov) {
    const sc = st.scripts.get(s.scriptId); if (!sc || !sc.length) continue;
    const arr = new Uint8Array(sc.length);
    for (const f of s.functions) for (const r of f.ranges) arr.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(sc.length, r.endOffset));
    let c = 0; for (const v of arr) c += v;
    run += c; total += sc.length;
  }
  return { executed: run, parsed: total };
};

async function visit(cdp, st, url) {
  st.reqs.clear(); st.inflight = 0; st.scripts.clear(); st.last = Date.now();
  await cdp.send("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
  await cdp.send("Page.navigate", { url: "about:blank" }); await sleep(150);
  st.reqs.clear(); st.inflight = 0; st.scripts.clear();
  await cdp.send("Profiler.stopPreciseCoverage").catch(() => {});
  await cdp.send("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
  const t0 = Date.now();
  await cdp.send("Page.navigate", { url });
  await sleep(300);
  await idle(st);
  await sleep(600);
  const wall = Date.now() - t0;
  const m = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { const n = performance.getEntriesByType("navigation")[0] || {}; const m = window.__m || {}; return { ttfb: n.responseStart, fcp: m.fcp, lcp: m.lcp, app: m.app, lt: m.lt || [], cls: m.cls || 0, load: n.loadEventEnd, dcl: n.domContentLoadedEventEnd, sw: !!navigator.serviceWorker && !!navigator.serviceWorker.controller }; })()` })).result.value;
  if (flag("verbose")) { const rs = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `performance.getEntriesByType("resource").map((e) => [e.name.replace(location.origin, ""), Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize])` })).result.value; console.error(rs.map((r) => r.join(" ")).join("\n")); console.error(JSON.stringify((await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "(() => { const n = performance.getEntriesByType(\"navigation\")[0]; return [n.workerStart, n.fetchStart, n.requestStart, n.responseStart, n.responseEnd, n.deliveryType, n.transferSize].join(\" \"); })()" })).result.value)); }
  const cov = (await cdp.send("Profiler.takePreciseCoverage")).result;
  await cdp.send("Profiler.stopPreciseCoverage");
  const seen = new Set();
  const reqs = [...st.reqs.entries()].filter(([, r]) => r.done && (seen.has(r.url) ? false : seen.add(r.url)));
  let transferred = 0, jsCssRaw = 0, jsCssGz = 0, jsCssBr = 0, jsGz = 0, cssGz = 0, scriptReqs = 0;
  for (const [id, r] of reqs) {
    transferred += r.bytes;
    const isJs = r.type === "Script", isCss = r.type === "Stylesheet";
    if (!isJs && !isCss) continue;
    if (isJs) scriptReqs++;
    try {
      const b = await cdp.send("Network.getResponseBody", { requestId: id });
      const buf = Buffer.from(b.body, b.base64Encoded ? "base64" : "utf8");
      const gz = zlib.gzipSync(buf, { level: 9 }).length;
      jsCssRaw += buf.length; jsCssGz += gz; jsCssBr += zlib.brotliCompressSync(buf).length;
      if (isJs) jsGz += gz; else cssGz += gz;
    } catch {}
  }
  const tbtFrom = m.fcp || 0;
  const tbt = m.lt.filter(([s]) => s >= tbtFrom).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
  const cv = coveredBytes(cov, st);
  return {
    url, requests: reqs.length, scriptRequests: scriptReqs, transferredKB: +(transferred / 1024).toFixed(1),
    jsCssRawKB: +(jsCssRaw / 1024).toFixed(1), jsCssGzKB: +(jsCssGz / 1024).toFixed(1), jsGzKB: +(jsGz / 1024).toFixed(1), cssGzKB: +(cssGz / 1024).toFixed(1), jsCssBrKB: +(jsCssBr / 1024).toFixed(1),
    ttfbMs: Math.round(m.ttfb || 0), fcpMs: Math.round(m.fcp || 0), lcpMs: Math.round(m.lcp || 0), contentMs: Math.round(m.app || 0), loadMs: Math.round(m.load || 0), wallMs: wall,
    longTasks: m.lt.length, longestTaskMs: Math.round(Math.max(0, ...m.lt.map((x) => x[1]))), tbtMs: Math.round(tbt), cls: +(m.cls || 0).toFixed(3),
    jsParsedKB: +(cv.parsed / 1024).toFixed(1), jsExecutedKB: +(cv.executed / 1024).toFixed(1), swControlled: m.sw,
  };
}

async function loadScenarios() {
  const out = [];
  for (const prof of Object.keys(PROFILES)) for (const [name, p] of PAGES) {
    if (ONLY && !ONLY.split(",").includes(name)) continue;
    const { cdp, stop } = await launch();
    try {
      const st = await setup(cdp, prof);
      const cold = await visit(cdp, st, BASE + p);
      await sleep(3000);
      await st.apply({ latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(1500);
      await st.apply(PROFILES[prof]);
      const warm = await visit(cdp, st, BASE + p);
      out.push({ page: name, profile: prof, cold, warm });
      console.error(`${prof} ${name}: cold fcp ${cold.fcpMs} ${cold.transferredKB}KB / warm fcp ${warm.fcpMs}`);
    } finally { await stop(); }
  }
  return out;
}

async function navScenario(prefetch) {
  const { cdp, stop } = await launch();
  try {
    const st = await setup(cdp, "slow4g");
    await visit(cdp, st, BASE + "/" + (prefetch ? "" : "?prefetch=0"));
    await sleep(2500);
    const res = [];
    for (const r of NAV_ROUTES) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 600 });
      await sleep(150);
      const rect = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { window.scrollTo(0, 0); const a = document.querySelector('.mainnav .menu a[data-r="${r}"]'); if (!a) return null; const g = a.closest('.grp'); g.classList.add('open'); const b = a.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? hit.outerHTML.slice(0, 80) : null, w: b.width, h: b.height }; })()` })).result.value;
      if (!rect) { res.push({ route: r, ms: null }); continue; }
      await sleep(100);
      if (prefetch) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
        await sleep(700);
      }
      await cdp.send("Runtime.evaluate", { expression: "window.__m.render = 0; window.__m.click = 0" });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + 1, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      let ms = null;
      for (let i = 0; i < 100; i++) { await sleep(100); ms = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "window.__m.render" })).result.value; if (ms) break; }
      const hash = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "location.hash" })).result.value;
      res.push({ route: r, ms: ms ? Math.round(ms) : null, hash, dbg: rect.hit });
      await idle(st, 400, 8000);
      await cdp.send("Runtime.evaluate", { expression: "document.querySelectorAll('.grp.open').forEach(g => g.classList.remove('open'))" });
    }
    return res;
  } finally { await stop(); }
}

const t0 = Date.now();
const result = { label: LABEL, base: BASE, at: new Date().toISOString(), cpuThrottle: CPU };
if (!flag("no-load")) result.loads = await loadScenarios();
if (!flag("no-nav")) {
  const off = await navScenario(false), on = await navScenario(true);
  const med = (a) => { const v = a.map((x) => x.ms).filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  result.nav = { prefetchOff: off, prefetchOn: on, medianOffMs: med(off), medianOnMs: med(on) };
  console.error(`nav median off ${result.nav.medianOffMs} on ${result.nav.medianOnMs}`);
}
result.seconds = Math.round((Date.now() - t0) / 1000);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));

const rows = (result.loads || []).flatMap((s) => [["cold", s.cold], ["warm", s.warm]].map(([k, v]) => `| ${s.page} | ${s.profile} | ${k} | ${v.transferredKB} | ${v.jsCssGzKB} | ${v.requests} | ${v.ttfbMs} | ${v.fcpMs} | ${v.lcpMs} | ${v.contentMs} | ${v.tbtMs} (${v.longTasks}) | ${v.cls} | ${v.jsExecutedKB}/${v.jsParsedKB} |`));
if (rows.length) console.log(`| page | net | cache | transferred KB | JS+CSS gz KB | requests | TTFB | FCP | LCP | content | TBT ms (long tasks) | CLS | JS exec/parsed KB |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}`);
if (result.nav) console.log(`\nnav click-to-render ms (slow 4G): prefetch off ${JSON.stringify(result.nav.prefetchOff.map((x) => x.ms))} median ${result.nav.medianOffMs}; on ${JSON.stringify(result.nav.prefetchOn.map((x) => x.ms))} median ${result.nav.medianOnMs}`);
process.exit(0);
