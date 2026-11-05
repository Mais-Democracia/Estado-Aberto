import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > -1 ? process.argv[i + 1] : def; };
const PORT = Number(arg("port", 3160));
const DATA = path.resolve(arg("data", process.env.ESTADO_ABERTO_DATA || path.join(root, "data")));
const SERVER = path.resolve(arg("server", path.join(root, "server.mjs")));
const DURATION = Number(arg("duration", 40)) * 1000;
const CLIENTS = Number(arg("clients", 20));
const WARM_AT = Number(arg("warm-at", 3)) * 1000;
const LABEL = arg("label", path.basename(path.dirname(SERVER)));
const JSON_OUT = arg("json", "");
const LAG_LIMIT = Number(arg("lag-limit", 100));
const P95_LIMIT = Number(arg("p95-limit", 50));
const ROUTES = ["/", "/api/status", "/api/overview", "/api/changes", "/api/contracts", "/api/edicao/dia", "/api/saude/overview", "/api/seguranca/overview", "/api/justica/overview", "/api/educacao/overview", "/api/search?q=saude", "/app.js"];
const WEIGHTS = new Map([["/", 4], ["/api/status", 3]]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ea-bench-"));
const probeFile = path.join(tmp, "probe.mjs");
const probeOut = path.join(tmp, "lag.json");
fs.writeFileSync(probeFile, `import { isMainThread } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import fs from "node:fs";
if (isMainThread) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const dump = () => { try { fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ max: h.max / 1e6, p99: h.percentile(99) / 1e6, p50: h.percentile(50) / 1e6, min: h.min / 1e6 })); } catch {} };
  setInterval(dump, 250).unref();
}
`);

const rssOf = (pid) => { try { const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); return m ? Math.round(Number(m[1]) / 1024) : 0; } catch { return 0; } };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const env = { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ESTADO_ABERTO_DATA: DATA, ESTADO_ABERTO_DEBUG: "1", ESTADO_ABERTO_CACHE: path.join(tmp, "cache") };
const t0 = performance.now();
const child = spawn(process.execPath, ["--no-warnings", "--max-old-space-size=256", "--import", probeFile, SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
let exited = null, log = "";
child.on("exit", (c) => { exited = c; });
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const stop = () => new Promise((res) => { if (exited !== null) return res(); child.once("exit", res); child.kill("SIGTERM"); setTimeout(() => { if (exited === null) child.kill("SIGKILL"); }, 4000).unref(); });
process.on("SIGINT", async () => { await stop(); process.exit(130); });

const base = `http://127.0.0.1:${PORT}`;
const get = async (p, timeout = 120000) => {
  const s = performance.now();
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(timeout) });
    await r.arrayBuffer();
    return { status: r.status, ms: performance.now() - s };
  } catch (e) { return { status: 0, ms: performance.now() - s, error: String(e.message || e) }; }
};

let startMs = null;
for (let i = 0; i < 600 && exited === null; i++) {
  const r = await get("/api/modules", 2000);
  if (r.status === 200) { startMs = performance.now() - t0; break; }
  await new Promise((r2) => setTimeout(r2, 100));
}
if (startMs === null) { console.log("servidor não arrancou\n" + log.slice(-1500)); await stop(); process.exit(2); }

const samples = new Map(ROUTES.map((r) => [r, { ms: [], status: {} }]));
const pickList = ROUTES.flatMap((r) => Array(WEIGHTS.get(r) || 1).fill(r));
let stopAt = performance.now() + DURATION, rssPeak = 0, workerPeak = 0, perfLast = null;
const client = async (id) => {
  let i = id;
  while (performance.now() < stopAt) {
    const r = pickList[i++ % pickList.length];
    const x = await get(r);
    const s = samples.get(r);
    s.ms.push(x.ms); s.status[x.status] = (s.status[x.status] || 0) + 1;
  }
};
const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, rssOf(child.pid)); }, 500);
const perfFetch = async () => { try { const r = await fetch(base + "/api/_perf", { signal: AbortSignal.timeout(5000) }); if (r.ok) return await r.json(); } catch {} return null; };
const perfTimer = setInterval(async () => { const p = await perfFetch(); if (p) { perfLast = p; if (p.memory_mb.worker_heap_max != null) workerPeak = Math.max(workerPeak, p.memory_mb.worker_heap_max); } }, 1500);
const warmTimer = setTimeout(() => { get("/api/_perf?warm=1", 5000); }, WARM_AT);

await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
clearInterval(sampler); clearInterval(perfTimer); clearTimeout(warmTimer);
const perfEnd = await perfFetch();
if (perfEnd) { perfLast = perfEnd; workerPeak = Math.max(workerPeak, perfEnd.memory_mb.worker_heap_max || 0); }
const rssEnd = rssOf(child.pid);
rssPeak = Math.max(rssPeak, rssEnd);
let lag = null;
try { lag = JSON.parse(fs.readFileSync(probeOut, "utf8")); } catch {}
await stop();

const rows = [...samples].map(([route, s]) => ({ route, n: s.ms.length, p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95), max: Math.max(0, ...s.ms), status: s.status }));
const total = rows.reduce((a, r) => a + r.n, 0);
const lagMax = lag ? Math.max(0, lag.max - 5) : null;
console.log(`# ${LABEL}  data=${DATA}  clients=${CLIENTS}  duration=${DURATION / 1000}s  startup=${Math.round(startMs)}ms`);
console.log("route".padEnd(30), "n".padStart(6), "p50ms".padStart(8), "p95ms".padStart(8), "maxms".padStart(8), " status");
for (const r of rows) console.log(r.route.padEnd(30), String(r.n).padStart(6), r.p50.toFixed(1).padStart(8), r.p95.toFixed(1).padStart(8), r.max.toFixed(0).padStart(8), " " + JSON.stringify(r.status));
console.log(`requests=${total}  eventloop lag max=${lagMax == null ? "n/d" : lagMax.toFixed(1) + "ms"} p99=${lag ? (lag.p99 - 5).toFixed(1) : "n/d"}ms`);
console.log(`RSS processo: pico ${rssPeak} MB, final ${rssEnd} MB` + (perfLast ? `  | heap principal ${perfLast.memory_mb.main_heap} MB (+${perfLast.memory_mb.main_external} externo), heap worker pico ${workerPeak} MB` : ""));
const get_ = (r) => rows.find((x) => x.route === r);
const checks = [
  ["lag do event loop < " + LAG_LIMIT + " ms", lagMax != null && lagMax < LAG_LIMIT],
  ["p95 de / < " + P95_LIMIT + " ms", get_("/").p95 < P95_LIMIT],
  ["p95 de /api/status < " + P95_LIMIT + " ms", get_("/api/status").p95 < P95_LIMIT],
  ["sem 5xx nem erros de ligação", rows.every((r) => Object.keys(r.status).every((s) => Number(s) > 0 && Number(s) < 500))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, data: DATA, startMs, rows, lagMax, lag, rssPeak, rssEnd, workerPeak, perf: perfLast, checks }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(checks.every((c) => c[1]) ? 0 : 1);
