import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > -1 ? process.argv[i + 1] : def; };
const PORT = Number(arg("port", process.env.PORT || 3150));
const DATA = path.resolve(arg("data", process.env.ESTADO_ABERTO_DATA || path.join(root, "data")));
const EXPECT = arg("expect", "any");
const SLOW_MS = Number(arg("slow", 1500));
const REPORT = arg("report", "");

const rssOf = (pid) => {
  try { const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); return m ? Math.round(Number(m[1]) / 1024) : 0; } catch { return 0; }
};

const routeList = () => {
  const files = [path.join(root, "server.mjs"), ...fs.readdirSync(path.join(root, "server", "modules")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(root, "server", "modules", f))];
  const out = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const names = new Set([...src.matchAll(/q\.get\("([a-z_]+)"\)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/(?:routes\[|^\s+)"(\/api\/[A-Za-z0-9_/-]+)"/gm)) out.set(m[1], { file: path.basename(f), names: [...names] });
  }
  out.delete("/api/follows");
  for (const k of [...out.keys()]) if (k.endsWith("/")) out.delete(k);
  return out;
};

const harvest = (v, pool, depth = 0) => {
  if (!v || depth > 4) return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 3)) harvest(x, pool, depth + 1); return; }
  if (typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if ((typeof x === "string" || typeof x === "number") && x !== "" && /^(id|nif|key|code|bid|dico|eid|entity_id|ini_id|slug|tipo)$/.test(k) && !(k in pool)) pool[k] = String(x);
    else if (x && typeof x === "object") harvest(x, pool, depth + 1);
  }
};

const poolParams = (names, pool) => {
  const p = new URLSearchParams();
  for (const n of names) {
    const v = n === "q" ? "Exemplo" : n === "entity" || n === "entity_id" ? pool.id : pool[n] ?? (n === "id" ? pool.id : undefined);
    if (v !== undefined) p.set(n, v);
  }
  return p.toString();
};

const server = spawn(process.execPath, ["--no-warnings", path.join(root, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ESTADO_ABERTO_DATA: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => { serverErr += d; if (serverErr.length > 20000) serverErr = serverErr.slice(-20000); });
server.stdout.on("data", () => {});
let exited = null;
server.on("exit", (c) => { exited = c; });
const stop = () => new Promise((res) => { if (exited !== null) return res(); server.once("exit", res); server.kill("SIGTERM"); setTimeout(() => { if (exited === null) server.kill("SIGKILL"); }, 3000).unref(); });
process.on("SIGINT", async () => { await stop(); process.exit(130); });

const get = async (p) => {
  const t0 = performance.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(60000) });
    const text = await r.text();
    let json, valid = true;
    try { json = JSON.parse(text); } catch { valid = false; }
    return { status: r.status, ms: Math.round(performance.now() - t0), bytes: Buffer.byteLength(text), valid, json };
  } catch (e) { return { status: 0, ms: Math.round(performance.now() - t0), bytes: 0, valid: false, error: String(e.message || e) }; }
};

const empty = (j) => j == null || (Array.isArray(j) && !j.length) || (typeof j === "object" && !Object.keys(j).length);
const failures = [];
let honestCount = 0;
let code = 0;
try {
  let up = false, rss0 = 0;
  for (let i = 0; i < 100 && exited === null; i++) { const r = await get("/api/modules"); if (r.status === 200) { up = true; break; } await new Promise((r2) => setTimeout(r2, 200)); }
  if (!up) { failures.push("servidor não arrancou" + (serverErr ? `: ${serverErr.split("\n").find((l) => l && !/Experimental/.test(l))}` : "")); throw new Error("no-start"); }
  await new Promise((r) => setTimeout(r, 1500));
  rss0 = rssOf(server.pid);

  const mods = (await get("/api/modules")).json;
  const files = fs.readdirSync(path.join(root, "server", "modules")).filter((f) => f.endsWith(".mjs")).sort();
  for (const f of files) if (!mods.server.includes(f)) failures.push(`módulo não carregou: ${f}`);
  for (const c of mods.client) { const r = await get("/modules/" + c); if (r.status !== 200) failures.push(`cliente /modules/${c} -> ${r.status}`); }

  const routes = routeList();
  const rows = [], gpool = {}, mpool = {};
  const order = [...routes.keys()].sort((a, b) => (/overview|search|entities|list|status|contracts|initiatives|deputados|relatorios$/.test(b) ? 1 : 0) - (/overview|search|entities|list|status|contracts|initiatives|deputados|relatorios$/.test(a) ? 1 : 0));
  let peak = rss0, lastRss = rss0;
  for (const route of order) {
    const info = routes.get(route);
    let r = await get(route);
    let used = route;
    const mod = route.split("/")[2];
    if (r.valid && r.status === 200) { harvest(r.json, gpool); harvest(r.json, (mpool[mod] ||= {})); }
    const pool = { ...gpool, ...(mpool[mod] || {}) };
    const needsIds = r.status === 404 || r.bytes < 400 || (r.valid && r.status === 200 && r.json && (r.json.row === null || (r.json.available === true && empty(r.json.rows) && Object.keys(r.json).length <= 3)));
    if (needsIds) {
      const qs = poolParams(info.names, pool);
      if (qs) { const r2 = await get(`${route}?${qs}`); if (r2.status >= 500 || (r2.status === 200 && r2.bytes >= r.bytes)) { r = r2; used = `${route}?${qs}`; } }
    }
    const rss = rssOf(server.pid);
    const jump = rss - lastRss;
    lastRss = rss; peak = Math.max(peak, rss);
    rows.push({ route: used.length > 70 ? used.slice(0, 67) + "..." : used, status: r.status, ms: r.ms, kb: Math.round(r.bytes / 1024), rss, jump, valid: r.valid, json: r.json, plain: route, used, detail: r.json && (r.json.detail || r.json.error) || "" });
    const honest = r.status === 503 && r.json && r.json.error === "dados_indisponiveis" && EXPECT !== "sample";
    if (honest) honestCount++;
    else if (r.status === 0 || r.status >= 500) failures.push(`${used} -> ${r.status} ${r.error || (r.json && (r.json.detail || r.json.error)) || ""}`);
    else if (!r.valid) failures.push(`${used} -> JSON inválido`);
    else if (EXPECT === "sample" && r.status !== 200 && !(r.status === 404 && needsIds)) failures.push(`${used} -> ${r.status} (esperado 2xx com dados de exemplo)`);
    if (EXPECT === "empty" && r.status === 200 && !/follows|roadmap|powers|modules|status|historias$|arquivo/.test(route) && r.json && r.json.available === true && used === route) failures.push(`${used} -> 200 available:true em dados vazios`);
  }

  if (EXPECT === "sample") {
    const dia = rows.find((x) => x.plain === "/api/edicao/dia");
    const n = dia && dia.json && dia.json.seccoes ? Object.values(dia.json.seccoes).reduce((a, s) => a + (Array.isArray(s) ? s.length : Array.isArray(s?.itens) ? s.itens.length : s ? 1 : 0), 0) : 0;
    if (!dia || dia.status !== 200 || !n) failures.push("edicao/dia vazia nos dados de exemplo");
    for (const slug of ["parlamento", "governo", "dinheiro", "poder-local", "instituicoes", "leis-justica", "indicadores"]) {
      const h = await get("/api/historias/" + slug);
      const k = h.json && h.json.datasets ? Object.keys(h.json.datasets).length : 0;
      if (h.status !== 200 || !k) failures.push(`historias/${slug} sem datasets (${h.status})`);
      rows.push({ route: `/api/historias/${slug} [datasets=${k}]`, status: h.status, ms: h.ms, kb: Math.round(h.bytes / 1024), rss: rssOf(server.pid), jump: 0, valid: h.valid });
    }
  }

  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(rows.map((x) => ({ route: x.used || x.plain, status: x.status, detail: x.detail || "" }))));
  const finalRss = rssOf(server.pid);
  const st = (await get("/api/status")).json || {};
  console.log("rota".padEnd(72), "http", "ms".padStart(6), "KB".padStart(6), "RSS".padStart(5), "Δ".padStart(5));
  for (const x of rows) console.log(x.route.padEnd(72), String(x.status).padEnd(4), String(x.ms).padStart(6), String(x.kb).padStart(6), String(x.rss).padStart(5), (x.jump > 0 ? "+" + x.jump : "").padStart(5), x.ms > SLOW_MS ? " LENTA" : "", x.kb > 1024 ? " GRANDE" : "");
  const by = {}; for (const x of rows) by[x.status] = (by[x.status] || 0) + 1;
  console.log(`\nrotas testadas: ${rows.length}  por estado: ${JSON.stringify(by)}  503 dados_indisponiveis aceites: ${honestCount}`);
  console.log(`RSS: arranque ${rss0} MB, pico ${peak} MB, final ${finalRss} MB`);
  const spikes = rows.filter((x) => x.jump >= 15).map((x) => `${x.plain} +${x.jump}MB`);
  if (spikes.length) console.log("picos de memória:", spikes.join(", "));
  if (st.unavailable) console.log(`bases indisponíveis: ${st.unavailable.length}/${Object.keys(st.modules || {}).length}`);
  if (serverErr.replace(/.*ExperimentalWarning.*\n?/g, "").trim()) console.log("stderr do servidor:\n" + serverErr.split("\n").filter((l) => l && !/Experimental|trace-warnings/.test(l)).slice(-8).join("\n"));
} catch (e) {
  if (e.message !== "no-start") failures.push(String(e.stack || e));
} finally {
  await stop();
}
if (failures.length) { console.log(`\nFALHAS (${failures.length}):`); for (const f of failures.slice(0, 40)) console.log(" - " + f); code = 1; } else console.log("\nOK: sem 5xx nem JSON inválido");
process.exit(code);
