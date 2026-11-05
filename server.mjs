// Dependency-free API + static server.  Run: node server.mjs  (PORT=3000, ESTADO_ABERTO_DATA=./data)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const wt = process.env.ESTADO_ABERTO_NO_WORKER === "1" ? null : await import("node:worker_threads").catch(() => null);
const IS_WORKER = !!wt && !wt.isMainThread && !!wt.workerData && wt.workerData.role === "routes";
const FRESH = { on: false };

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ESTADO_ABERTO_DATA || path.join(root, "data"));
const BOOTSTRAP = "execute o bootstrap (docs/CONTRIBUTING.md)";

class DataMissing extends Error {
  constructor(name, why = "não encontrada") { super(`${name} ${why}; ${BOOTSTRAP}`); this.dbName = name; }
}
const unavailable = (name, why) => ({ available: false, note: `A base data/${name}.db ${why || "não foi encontrada"}; ${BOOTSTRAP}.` });

async function buildApp() {
const requested = new Set(["politica"]);
const handles = new Map();
const readDb = (name) => {
  const file = path.join(dataDir, `${name}.db`);
  let h = handles.get(name);
  if (h) { if (fs.existsSync(file)) return h; try { h.close(); } catch {} handles.delete(name); }
  if (!fs.existsSync(file)) throw new DataMissing(name);
  try {
    h = new DatabaseSync(file, { readOnly: true });
    h.exec("PRAGMA cache_size = -1024; PRAGMA mmap_size = 0; PRAGMA query_only = 1;");
  } catch (e) { throw new DataMissing(name, `ilegível (${e.message})`); }
  handles.set(name, h);
  return h;
};
const lazyDb = (name) => ({
  prepare: (sql) => readDb(name).prepare(sql),
  exec: (sql) => readDb(name).exec(sql),
  close() { const h = handles.get(name); if (h) { try { h.close(); } catch {} handles.delete(name); } },
});
const db = lazyDb("politica");

let userHandle = null, userTouched = false;
const userDb = {
  prepare(sql) {
    userTouched = true;
    if (!userHandle) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        userHandle = new DatabaseSync(path.join(dataDir, "user.db"));
        userHandle.exec("CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, label TEXT, created TEXT, UNIQUE(kind, ref));");
      } catch (e) { userHandle = null; throw new DataMissing("user", `não pôde ser aberta (${e.message})`); }
    }
    return userHandle.prepare(sql);
  },
};
let powersCache = null;
const powers = () => (powersCache ||= (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "seed", "powers.json"), "utf8")); } catch { return {}; } })());

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const has = (t) => !!one("SELECT 1 x FROM sqlite_master WHERE name = ?", t);
const num = (v, d, lo = 1, hi = 1e9) => Math.min(hi, Math.max(lo, Number.parseInt(v ?? d, 10) || d));
const like = (s) => `%${String(s).replace(/[%_]/g, "")}%`;
const fts = (s) => String(s).replace(/["*()^:-]/g, " ").split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
const meta = () => (has("meta") ? Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value])) : {});
const DIRECT = "procedure LIKE 'Ajuste Direto%'";

/* ---------- risk indicators (transparent, peer-relative; indicators, not accusations) ---------- */
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
const peerCache = new Map();
function peerMedians(kind) {
  if (peerCache.has(kind)) return peerCache.get(kind);
  const rows = all(`SELECT b.direct_value * 1.0 / b.value dv, b.single_bidder_n * 1.0 / NULLIF(b.competitive_n, 0) sb, b.overrun_n * 1.0 / b.n ov,
                           COALESCE(m.big_increase_n, 0) * 1.0 / b.n bm
                    FROM buyer_stats b JOIN entities e ON e.nif = b.nif LEFT JOIN buyer_mod_stats m ON m.nif = b.nif
                    WHERE e.kind = ? AND b.n >= 20 AND b.value > 0`, kind);
  const out = { n: rows.length, direct: median(rows.map((r) => r.dv).filter((x) => x != null)), single: median(rows.map((r) => r.sb).filter((x) => x != null)), overrun: median(rows.map((r) => r.ov).filter((x) => x != null)), bigmod: median(rows.map((r) => r.bm).filter((x) => x != null)) };
  if (peerCache.size >= 32) peerCache.delete(peerCache.keys().next().value);
  peerCache.set(kind, out);
  return out;
}
function flagsFor(e, b, topSeller, mods) {
  if (!b || b.n < 20 || !(b.value > 0)) return [];
  const peer = peerMedians(e.kind), f = [];
  const dshare = b.direct_value / b.value;
  if (peer.direct != null && dshare > 0.4 && dshare > peer.direct + 0.2)
    f.push({ id: "ajuste_direto", level: "atenção", label: "Elevado recurso a ajuste direto", value: dshare, peer: peer.direct,
      text: `${(dshare * 100).toFixed(0)}% do valor contratado foi por ajuste direto; a mediana de entidades semelhantes (${e.kind}) é ${(peer.direct * 100).toFixed(0)}%.` });
  if (topSeller && b.value > 100000 && topSeller.value / b.value > 0.3)
    f.push({ id: "concentracao", level: "atenção", label: "Concentração num só fornecedor", value: topSeller.value / b.value,
      text: `${(topSeller.value / b.value * 100).toFixed(0)}% do valor vai para ${topSeller.name || topSeller.seller_nif}.` });
  if (b.competitive_n >= 10 && b.single_bidder_n / b.competitive_n > 0.3 && (peer.single == null || b.single_bidder_n / b.competitive_n > peer.single + 0.15))
    f.push({ id: "concorrente_unico", level: "info", label: "Muitos concursos com um só concorrente", value: b.single_bidder_n / b.competitive_n,
      text: `${(b.single_bidder_n / b.competitive_n * 100).toFixed(0)}% dos procedimentos concorrenciais tiveram apenas um concorrente.` });
  if (b.overrun_n / b.n > 0.1 && (peer.overrun == null || b.overrun_n / b.n > peer.overrun + 0.05))
    f.push({ id: "derrapagem", level: "info", label: "Custos finais acima do contratado", value: b.overrun_n / b.n,
      text: `${b.overrun_n} contratos (${(b.overrun_n / b.n * 100).toFixed(0)}%) têm preço efetivo superior a 120% do preço contratual.` });
  if (mods && mods.big_increase_n >= 5 && mods.big_increase_n / b.n > 0.03 && (peer.bigmod == null || mods.big_increase_n / b.n > peer.bigmod + 0.03))
    f.push({ id: "modificacoes", level: "atenção", label: "Contratos alterados com grandes aumentos de preço", value: mods.big_increase_n / b.n,
      text: `${mods.big_increase_n} contratos (${(mods.big_increase_n / b.n * 100).toFixed(1)}% dos celebrados) foram modificados com aumento superior a 25% do preço; aumento acumulado de ${new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(mods.increase_value)}.` });
  return f;
}

/* ---------- routes ---------- */
const memo = (fn, ttl = 3600000) => {   // stale-while-revalidate: an expired entry is served at once and refreshed right after the response
  let at = 0, val, busy = false;
  return (...a) => {
    if (at && FRESH.on && ttl <= 3600000) { val = fn(...a); at = Date.now(); return val; }
    if (at && Date.now() - at > ttl && !busy) { busy = true; setTimeout(() => { try { val = fn(...a); at = Date.now(); } catch {} busy = false; }, 0); }
    if (!at) { val = fn(...a); at = Date.now(); }
    return val;
  };
};
const countOf = (name, sql) => { try { return db.prepare(sql).get().n; } catch (e) { if (e instanceof DataMissing) return 0; return 0; } };
function tableCounts(name, size) {
  const h = readDb(name), approx = size > BIG_DB, out = { tables: {}, rows: 0, approx };
  const names = h.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
  for (const t of names) {
    let n = 0;
    try { n = approx ? (h.prepare(`SELECT MAX(rowid) n FROM "${t}"`).get().n || 0) : h.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch {}
    out.tables[t] = n; out.rows += n;
  }
  try { const m = h.prepare("SELECT key, value FROM meta WHERE key IN ('built','updated','contracts_updated','version')").all(); if (m.length) out.meta = Object.fromEntries(m.map((r) => [r.key, r.value])); } catch {}
  return out;
}
function statusDetail() {
  const scan = scanDbsSync(), names = new Set([...requested]);
  for (const n of scan.keys()) if (n !== "user") names.add(n);
  const modules = {};
  for (const n of [...names].sort()) {
    const f = scan.get(n);
    if (!f) continue;
    try { modules[n] = tableCounts(n, f.size); } catch (e) { modules[n] = { tables: {}, rows: 0, approx: false, error: e.message }; }
  }
  const core = modules.politica, ok = !!core && !core.error && core.rows > 0;
  let m = {};
  try { m = meta(); } catch {}
  return {
    at: Date.now(), m, modules,
    counts: {
      public_bodies: ok ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE is_public = 1") : 0,
      municipios: ok ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE kind = 'municipio'") : 0,
      freguesias: ok ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE kind = 'freguesia'") : 0,
      deputies: ok ? countOf("politica", "SELECT COUNT(*) n FROM people WHERE body = 'Assembleia da República'") : 0,
    },
  };
}
let fallbackDetail = null;
const statusReport = () => {
  if (!fallbackDetail || Date.now() - fallbackDetail.at > 30 * 60e3) fallbackDetail = statusDetail();
  return composeStatus(fallbackDetail, scanDbsSync(), requested);
};
const procedureList = memo(() => all("SELECT procedure, COUNT(*) n FROM contracts GROUP BY procedure ORDER BY n DESC LIMIT 12"), 86400000);
const routes = {
  "/api/status": () => statusReport(),
  "/api/overview": memo(() => ({
    byYear: all(`SELECT year, COUNT(*) n, ROUND(SUM(price)) value, ROUND(100.0 * SUM(CASE WHEN ${DIRECT} THEN price END) / SUM(price), 1) direct_pct
                 FROM contracts WHERE year BETWEEN 2012 AND 2100 GROUP BY year ORDER BY year`),
    procedures: all(`SELECT procedure, COUNT(*) n, ROUND(SUM(price)) value FROM contracts GROUP BY procedure ORDER BY value DESC LIMIT 8`),
    topBuyers: all(`SELECT e.id, e.name, e.kind, b.n, ROUND(b.value) value FROM buyer_stats b JOIN entities e ON e.nif = b.nif ORDER BY b.value DESC LIMIT 10`),
    topSellers: all(`SELECT e.id, e.name, s.n, ROUND(s.value) value, s.n_buyers FROM seller_stats s JOIN entities e ON e.nif = s.nif ORDER BY s.value DESC LIMIT 10`),
    latest: all(`SELECT id, signed, object, price, buyer_name, buyer_nif, seller_name, procedure FROM contracts WHERE signed <= date('now') ORDER BY signed DESC, price DESC LIMIT 8`),
  })),
  "/api/search": (q) => {
    const s = (q.get("q") || "").trim();
    if (s.length < 2) return { entities: [], initiatives: [], events: [], contracts: [] };
    const nif = /^\d{9}$/.test(s) ? s : "";
    return {
      entities: all(`SELECT id, name, kind, nif, is_public, municipality FROM entities WHERE name LIKE ? OR nif = ? OR (is_public = 1 AND description LIKE ?)
                     ORDER BY is_public DESC, (buyer_value + seller_value) DESC LIMIT 10`, like(s), nif, like(s)),
      initiatives: all("SELECT key, kind, number, legislature, title FROM initiatives WHERE title LIKE ? OR key LIKE ? LIMIT 5", like(s), like(s)),
      events: all("SELECT id, title, start, section FROM events WHERE title LIKE ? ORDER BY start DESC LIMIT 5", like(s)),
      contracts: has("contracts_fts") ? all(`SELECT c.id, c.object, c.price, c.signed, c.buyer_name FROM contracts_fts f JOIN contracts c ON c.rowid = f.rowid WHERE contracts_fts MATCH ? ORDER BY c.price DESC LIMIT 5`, fts(s)) : [],
    };
  },
  "/api/entities": (q) => {
    const where = ["1=1"], args = [];
    if (q.get("kind")) { where.push("e.kind = ?"); args.push(q.get("kind")); }
    if (q.get("level")) { where.push("e.level = ?"); args.push(q.get("level")); }
    if (q.get("public") !== "0") where.push("e.is_public = 1");
    if (q.get("q")) { where.push("(e.name LIKE ? OR e.nif = ? OR e.description LIKE ?)"); args.push(like(q.get("q")), q.get("q"), like(q.get("q"))); }
    if (q.get("parent")) { where.push("e.parent_id = ?"); args.push(q.get("parent")); }
    const sorts = { value: "COALESCE(b.value,0) DESC", n: "COALESCE(b.n,0) DESC", name: "e.name COLLATE NOCASE", pop: "COALESCE(e.population,0) DESC",
      direct: "(b.direct_value * 1.0 / NULLIF(b.value,0)) DESC", percapita: "(b.value * 1.0 / NULLIF(e.population,0)) DESC" };
    const order = sorts[q.get("sort")] || sorts.value;
    const limit = num(q.get("limit"), 50, 1, 200), offset = (num(q.get("page"), 1) - 1) * limit;
    const base = `FROM entities e LEFT JOIN buyer_stats b ON b.nif = e.nif WHERE ${where.join(" AND ")}`;
    return {
      total: one(`SELECT COUNT(*) n ${base}`, ...args).n,
      rows: all(`SELECT e.id, e.name, e.kind, e.level, e.nif, e.municipality, e.district, e.population, e.population_source, e.website, e.ministry,
                        COALESCE(b.n,0) n, ROUND(COALESCE(b.value,0)) value, ROUND(100.0 * b.direct_value / NULLIF(b.value,0), 1) direct_pct
                 ${base} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset),
      kinds: all("SELECT kind, COUNT(*) n FROM entities WHERE is_public = 1 GROUP BY kind ORDER BY n DESC"),
    };
  },
  "/api/entity": (q) => {
    const e = one("SELECT * FROM entities WHERE id = ?", q.get("id"));
    if (!e) return null;
    const out = { entity: e, parent: e.parent_id ? one("SELECT id, name, kind FROM entities WHERE id = ?", e.parent_id) : null };
    out.children = all("SELECT id, name, kind, population FROM entities WHERE parent_id = ? ORDER BY name LIMIT 500", e.id);
    if (e.nif) {
      const b = one("SELECT * FROM buyer_stats WHERE nif = ?", e.nif), s = one("SELECT * FROM seller_stats WHERE nif = ?", e.nif);
      out.asBuyer = b || null; out.asSeller = s || null;
      out.years = all("SELECT year, n, ROUND(value) value, direct_n, ROUND(direct_value) direct_value FROM year_stats WHERE nif = ? ORDER BY year", e.nif);
      out.topSuppliers = all(`SELECT p.seller_nif nif, COALESCE(x.name, (SELECT seller_name FROM contracts WHERE seller_nif = p.seller_nif LIMIT 1)) name, x.id eid, p.n, ROUND(p.value) value, p.direct_n
                              FROM pair_stats p LEFT JOIN entities x ON x.nif = p.seller_nif WHERE p.buyer_nif = ? ORDER BY p.value DESC LIMIT 10`, e.nif);
      out.topClients = all(`SELECT p.buyer_nif nif, x.name, x.id eid, p.n, ROUND(p.value) value, p.direct_n
                            FROM pair_stats p LEFT JOIN entities x ON x.nif = p.buyer_nif WHERE p.seller_nif = ? ORDER BY p.value DESC LIMIT 10`, e.nif);
      out.recent = all(`SELECT id, signed, object, price, procedure, buyer_name, buyer_nif, seller_name, seller_nif FROM contracts
                        WHERE buyer_nif = ?1 OR seller_nif = ?1 ORDER BY signed DESC LIMIT 15`, e.nif);
      out.mods = has("buyer_mod_stats") ? one("SELECT * FROM buyer_mod_stats WHERE nif = ?", e.nif) || null : null;
      out.flags = flagsFor(e, b, out.topSuppliers[0] && { ...out.topSuppliers[0], seller_nif: out.topSuppliers[0].nif }, out.mods);
      out.peer = peerMedians(e.kind);
    }
    out.following = !!userDb.prepare("SELECT 1 x FROM follows WHERE kind = 'entity' AND ref = ?").get(String(e.id));
    return out;
  },
  "/api/contracts": (q) => {
    const where = ["1=1"], args = [];
    let from = "contracts c";
    if (q.get("q")) { from = "contracts_fts f JOIN contracts c ON c.rowid = f.rowid"; where.push("contracts_fts MATCH ?"); args.push(fts(q.get("q"))); }
    if (q.get("buyer")) { where.push("c.buyer_nif = ?"); args.push(q.get("buyer")); }
    if (q.get("seller")) { where.push("c.id IN (SELECT contract_id FROM contract_parties WHERE nif = ? AND role = 'seller')"); args.push(q.get("seller")); }
    if (q.get("procedure")) { where.push("c.procedure LIKE ?"); args.push(q.get("procedure") + "%"); }
    if (q.get("year")) { where.push("c.year = ?"); args.push(q.get("year")); }
    if (q.get("min")) { where.push("c.price >= ?"); args.push(Number(q.get("min"))); }
    if (q.get("cpv")) { where.push("c.cpv_code LIKE ?"); args.push(q.get("cpv") + "%"); }
    const order = { price: "c.price DESC", date: "c.signed DESC" }[q.get("sort")] || "c.signed DESC";
    const limit = num(q.get("limit"), 30, 1, 100), offset = (num(q.get("page"), 1) - 1) * limit;
    const w = where.join(" AND ");
    return {
      total: one(`SELECT COUNT(*) n FROM (SELECT 1 FROM ${from} WHERE ${w} LIMIT 20001)`, ...args).n,
      rows: all(`SELECT c.id, c.signed, c.object, c.price, c.procedure, c.cpv, c.buyer_nif, c.buyer_name, c.seller_nif, c.seller_name, c.n_sellers, c.n_bidders
                 FROM ${from} WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset),
      procedures: procedureList(),
    };
  },
  "/api/contract": (q) => {
    const c = one("SELECT * FROM contracts WHERE id = ?", q.get("id"));
    if (!c) return null;
    const mods = has("contract_mods") ? all("SELECT date, published, basis, act_type, new_price, new_duration FROM contract_mods WHERE contract_id = ? ORDER BY date", c.id) : [];
    return { contract: c, mods, parties: all("SELECT p.nif, p.name, p.role, e.id eid FROM contract_parties p LEFT JOIN entities e ON e.nif = p.nif WHERE p.contract_id = ? ORDER BY p.role", c.id) };
  },
  "/api/localgov": (q) => {
    const where = ["e.kind = ?"], args = [q.get("kind") === "freguesia" ? "freguesia" : "municipio"];
    if (args[0] === "municipio") where.push("e.nif IS NOT NULL");   // hides historical/duplicate Wikidata-only items
    if (q.get("district")) { where.push("e.district = ?"); args.push(q.get("district")); }
    if (q.get("q")) { where.push("e.name LIKE ?"); args.push(like(q.get("q"))); }
    const sorts = { value: "value DESC", percapita: "percapita DESC", direct: "direct_pct DESC", pop: "e.population DESC", name: "e.name COLLATE NOCASE", n: "n DESC" };
    const limit = num(q.get("limit"), 60, 1, 400), offset = (num(q.get("page"), 1) - 1) * limit;
    const base = `FROM entities e LEFT JOIN buyer_stats b ON b.nif = e.nif WHERE ${where.join(" AND ")}`;
    return {
      total: one(`SELECT COUNT(*) n ${base}`, ...args).n,
      rows: all(`SELECT e.id, e.name, e.district, e.municipality, e.population, e.nif, COALESCE(b.n,0) n, ROUND(COALESCE(b.value,0)) value,
                        ROUND(b.value / NULLIF(e.population,0)) percapita, ROUND(100.0 * b.direct_value / NULLIF(b.value,0), 1) direct_pct
                 ${base} ORDER BY ${sorts[q.get("sort")] || sorts.value} LIMIT ? OFFSET ?`, ...args, limit, offset),
      districts: all("SELECT DISTINCT district FROM entities WHERE kind = 'municipio' AND district IS NOT NULL ORDER BY district").map((r) => r.district),
      totals: one(`SELECT COUNT(*) municipalities, ROUND(SUM(b.value)) value FROM entities e JOIN buyer_stats b ON b.nif = e.nif WHERE e.kind = 'municipio'`),
    };
  },
  "/api/follows": (q, req, body) => {
    if (req.method === "POST") {
      userDb.prepare("INSERT OR IGNORE INTO follows (kind, ref, label, created) VALUES (?,?,?,?)").run(body.kind, String(body.ref), body.label || "", new Date().toISOString());
      return { ok: true };
    }
    if (req.method === "DELETE") { userDb.prepare("DELETE FROM follows WHERE kind = ? AND ref = ?").run(q.get("kind"), q.get("ref")); return { ok: true }; }
    return { follows: userDb.prepare("SELECT * FROM follows ORDER BY created DESC").all() };
  },
  "/api/feed": () => {
    const follows = userDb.prepare("SELECT * FROM follows ORDER BY created DESC").all();
    const items = [];
    for (const f of follows) {
      if (f.kind === "entity") {
        const e = one("SELECT id, name, nif FROM entities WHERE id = ?", f.ref);
        if (!e || !e.nif) continue;
        for (const c of all(`SELECT id, signed, published, object, price, procedure, buyer_name, seller_name FROM contracts WHERE buyer_nif = ?1 OR seller_nif = ?1 ORDER BY published DESC LIMIT 6`, e.nif))
          items.push({ type: "contract", date: c.published || c.signed, follow: f.label || e.name, ...c });
      } else if (f.kind === "topic") {
        for (const ev of all("SELECT id, title, start, section FROM events WHERE (title LIKE ? OR text LIKE ?) AND start >= date('now','-7 day') ORDER BY start LIMIT 6", like(f.ref), like(f.ref)))
          items.push({ type: "event", date: ev.start, follow: f.label || f.ref, ...ev });
        if (has("contracts_fts"))
          for (const c of all(`SELECT c.id, c.signed, c.published, c.object, c.price, c.procedure, c.buyer_name, c.seller_name FROM contracts_fts f JOIN contracts c ON c.rowid = f.rowid WHERE contracts_fts MATCH ? ORDER BY c.published DESC LIMIT 6`, fts(f.ref)))
            items.push({ type: "contract", date: c.published || c.signed, follow: f.label || f.ref, ...c });
      } else if (f.kind === "initiative") {
        for (const s of all("SELECT date, phase, body FROM initiative_steps WHERE initiative_key = ? ORDER BY date DESC LIMIT 4", f.ref))
          items.push({ type: "step", date: s.date, follow: f.label || f.ref, phase: s.phase, body: s.body, key: f.ref });
      }
    }
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { follows, items: items.slice(0, 80) };
  },
  "/api/changes": memo(() => {
    const out = {}, safe = (fn) => { try { return fn(); } catch { return null; } };
    const mx = one("SELECT MAX(published) d FROM contracts WHERE published <= date('now')")?.d;
    if (mx) out.contracts = { until: mx, ...one("SELECT COUNT(*) n, ROUND(SUM(CASE WHEN price > 0 THEN price END)) value FROM contracts WHERE published > date(?, '-7 day') AND published <= ?", mx, mx),
      top: all("SELECT id, object, price, buyer_name, buyer_nif, seller_name, signed FROM contracts WHERE published > date(?, '-7 day') AND published <= ? ORDER BY price DESC LIMIT 5", mx, mx) };
    out.dre = safe(() => routes["/api/dre/recent"]?.(new URLSearchParams())?.days?.slice(0, 2));
    out.votes = safe(() => routes["/api/votacoes/votacoes"]?.(new URLSearchParams("limit=6"))?.rows);
    out.events = all("SELECT id, title, start, section, local FROM events WHERE start >= date('now') ORDER BY start LIMIT 5");
    out.news = all("SELECT title, date, url FROM news WHERE body = 'Presidência da República' ORDER BY date DESC LIMIT 3");
    return out;
  }, 1800000),
  "/api/roadmap": () => {
    const file = path.join(root, "docs", "ROADMAP.md"), md = fs.readFileSync(file, "utf8");
    const sections = []; let cur = null, intro = [];
    for (const line of md.split("\n")) {
      const h = line.match(/^##\s+(.*)/), it = line.match(/^-\s+(.*)/);
      if (h) { cur = { title: h[1].trim(), items: [] }; sections.push(cur); }
      else if (it && cur) { const m = it[1].match(/^\*\*(.+?)\*\*\s*(.*)$/); cur.items.push(m ? { title: m[1].replace(/[.:]\s*$/, ""), text: m[2] } : { title: "", text: it[1] }); }
      else if (!cur && line.trim() && !line.startsWith("#")) intro.push(line.trim());
    }
    return { intro: intro.join(" "), updated: fs.statSync(file).mtime.toISOString(), sections };
  },
  "/api/powers": () => powers(),
  "/api/events": (q) => {
    const from = q.get("from") || "0000", to = q.get("to") || "9999";
    const where = ["start >= ?", "start < ?"], args = [from, to];
    if (q.get("section")) { where.push("section = ?"); args.push(q.get("section")); }
    if (q.get("q")) { where.push("(title LIKE ? OR text LIKE ?)"); args.push(like(q.get("q")), like(q.get("q"))); }
    return {
      events: all(`SELECT id, title, start, end, section, theme, subtitle, local, text FROM events WHERE ${where.join(" AND ")} ORDER BY start LIMIT 1500`, ...args),
      sections: all("SELECT section, COUNT(*) n FROM events GROUP BY section ORDER BY n DESC"),
    };
  },
  "/api/parties": () => ({
    parties: all("SELECT * FROM parties ORDER BY seats DESC"),
    members: all("SELECT name, role, party, since FROM people WHERE body = 'Assembleia da República' ORDER BY name"),
  }),
  "/api/government": () => ({
    president: one("SELECT * FROM people WHERE body = 'Presidência da República'"),
    members: all("SELECT name, role, party, since FROM people WHERE body = 'Governo' ORDER BY id"),
  }),
  "/api/initiatives": (q) => {
    const where = ["1=1"], args = [];
    if (q.get("kind")) { where.push("i.kind = ?"); args.push(q.get("kind")); }
    if (q.get("q")) { where.push("(i.title LIKE ? OR i.key LIKE ?)"); args.push(like(q.get("q")), like(q.get("q"))); }
    return {
      initiatives: all(`SELECT i.key, i.kind, i.number, i.legislature, i.session, i.origin, i.title, COUNT(s.event_id) steps, MAX(s.date) last_date, MIN(s.date) first_date
                        FROM initiatives i LEFT JOIN initiative_steps s ON s.initiative_key = i.key WHERE ${where.join(" AND ")} GROUP BY i.key ORDER BY last_date DESC LIMIT 400`, ...args),
      kinds: all("SELECT kind, COUNT(*) n FROM initiatives GROUP BY kind ORDER BY n DESC"),
    };
  },
  "/api/initiative": (q) => {
    const init = one("SELECT * FROM initiatives WHERE key = ?", q.get("key"));
    if (!init) return null;
    return {
      initiative: init,
      steps: all(`SELECT s.date, s.phase, s.body, s.detail, s.relator, s.source, e.title event_title, e.local, e.section FROM initiative_steps s LEFT JOIN events e ON e.id = s.event_id WHERE s.initiative_key = ? ORDER BY s.date`, init.key),
      votes: all("SELECT date, result, favor, against, abstention FROM votes WHERE initiative_key = ? ORDER BY date", init.key),
      following: !!userDb.prepare("SELECT 1 x FROM follows WHERE kind = 'initiative' AND ref = ?").get(init.key),
    };
  },
  "/api/activity": () => ({
    presidente: all("SELECT title, date, url FROM news WHERE body = 'Presidência da República' ORDER BY date DESC LIMIT 5"),
    parlamento: all("SELECT id, title, start, section, local FROM events WHERE start >= date('now') ORDER BY start LIMIT 6"),
  }),
};

/* ---------- plug-in modules: server/modules/*.mjs  (see docs/MODULES.md) ---------- */
const openData = (name) => {
  requested.add(name);
  if (!fs.existsSync(path.join(dataDir, `${name}.db`))) return null;
  return lazyDb(name);
};
const ctx = { db, userDb, all, one, has, num, like, fts, meta, routes, root, dataDir, openData, DataMissing, unavailable };
const modDir = path.join(root, "server", "modules");
const loaded = [];
for (const f of fs.existsSync(modDir) ? fs.readdirSync(modDir).filter((x) => x.endsWith(".mjs")).sort() : []) {
  try { await (await import(path.join(modDir, f))).default(ctx); loaded.push(f); } catch (e) { console.error("module failed:", f, e.message); }
}
// aggregate "overview" endpoints of plug-in modules are expensive and change rarely: cache per query string for 10 minutes
const OV_MAX = 48, OV_BYTES = 6 * 1024 * 1024;
let ovBytes = 0;
const ovCache = new Map();
for (const key of Object.keys(routes).filter((k) => /^\/api\/[a-z_]+\/overview$/.test(k))) {
  const fn = routes[key];
  const store = (k, v) => {
    const size = JSON.stringify(v ?? null).length;
    if (size > OV_BYTES / 4) return;
    const old = ovCache.get(k); if (old) { ovBytes -= old.size; ovCache.delete(k); }
    while (ovCache.size >= OV_MAX || ovBytes + size > OV_BYTES) { const [fk, fv] = ovCache.entries().next().value; ovBytes -= fv.size; ovCache.delete(fk); }
    ovCache.set(k, { at: Date.now(), v, size }); ovBytes += size;
  };
  routes[key] = (q, req, body) => {
    const k = key + "?" + q.toString(), hit = ovCache.get(k);
    if (hit && !FRESH.on) {
      if (Date.now() - hit.at > 3600000 && !hit.busy) { hit.busy = true; setTimeout(() => { try { store(k, fn(q, req, body)); } catch { hit.busy = false; } }, 0); }
      return hit.v;
    }
    const v = fn(q, req, body);
    if (!(v && v.available === false)) store(k, v);
    return v;
  };
}
// transient SQLITE_BUSY / "database is locked" (an ingest is writing): retry a few times instead of surfacing an error
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (const key of Object.keys(routes)) {
  const fn = routes[key];
  routes[key] = (...args) => { for (let i = 0; ; i++) { try { return fn(...args); } catch (e) { if (!/locked|busy/i.test(String(e.message))) throw e; if (i >= 4) return { available: false, updating: true, note: "Dados em atualização neste momento — tente novamente dentro de instantes." }; sleepMs(250 * (i + 1)); } } };
}
routes["/api/modules"] = () => ({
  server: loaded,
  client: fs.existsSync(path.join(root, "public", "modules")) ? fs.readdirSync(path.join(root, "public", "modules")).filter((x) => x.endsWith(".js")).sort() : [],
});

const exec = (m) => {
  const t0 = performance.now();
  FRESH.on = !!m.fresh; userTouched = false;
  const fin = (code, obj) => {
    let json;
    try { json = JSON.stringify(obj); } catch (e) { code = 500; json = JSON.stringify({ error: "erro_interno", detail: String(e.message) }); }
    return { code, json, user: userTouched, ms: Math.round(performance.now() - t0) };
  };
  try {
    const fn = Object.hasOwn(routes, m.path) ? routes[m.path] : null;
    if (!fn) return fin(404, { error: "not found" });
    let out;
    try { out = fn(new URLSearchParams(m.query || ""), { method: m.method, headers: {} }, m.body || {}); } catch (e) {
      const f = failure(e);
      if (f.code === 500) console.error("route failed:", m.path, e && e.stack || e);
      return fin(f.code, f.body);
    }
    const un = unavailableOf(out);
    if (un) return fin(503, dadosIndisponiveis(un.detail, un.name));
    return out ? fin(200, out) : fin(404, { error: "not found" });
  } finally { FRESH.on = false; }
};
return { routes, loaded, requested, exec, statusDetail };
}

const dadosIndisponiveis = (detail, db) => ({ error: "dados_indisponiveis", detail, ...(db ? { db } : {}) });
const unavailableOf = (out) => {
  if (!out || typeof out !== "object" || out.updating) return null;
  const txt = out.available === false ? out.note || out.error : typeof out.error === "string" ? out.error : null;
  if (!txt || !/(?:data\/)?[a-z_]+\.db/.test(txt) || !/ainda não (foi gerada|existe)|não existe|não foi encontrada|ilegível/.test(txt)) return null;
  const name = txt.match(/(?:data\/)?([a-z_]+)\.db/)[1];
  return { name, detail: `${name} não encontrada; ${BOOTSTRAP}` };
};
const failure = (e) => {
  if (e instanceof DataMissing) return { code: 503, body: dadosIndisponiveis(e.message, e.dbName) };
  const msg = String(e && e.message || e);
  if (/no such (table|column)|malformed|not a database|disk image|unable to open/i.test(msg)) return { code: 503, body: dadosIndisponiveis(`base incompleta ou inválida (${msg}); ${BOOTSTRAP}`) };
  if (e instanceof TypeError && /null|undefined/.test(msg)) return { code: 503, body: dadosIndisponiveis(`dados em falta (${msg}); ${BOOTSTRAP}`) };
  return { code: 500, body: { error: "erro_interno", detail: msg } };
};

const BIG_DB = 64 * 1024 * 1024;
const scanDbsSync = () => {
  const files = new Map();
  try { for (const f of fs.readdirSync(dataDir)) if (/^[a-z_]+\.db$/.test(f)) { try { const s = fs.statSync(path.join(dataDir, f)); files.set(f.slice(0, -3), { size: s.size, mtimeMs: s.mtimeMs }); } catch {} } } catch {}
  return files;
};
function composeStatus(detail, scan, requestedNames, mem = {}) {
  const names = new Set(requestedNames);
  for (const n of scan.keys()) if (n !== "user") names.add(n);
  const modules = {};
  for (const n of [...names].sort()) {
    const f = scan.get(n);
    if (!f) { modules[n] = { exists: false, available: false, detail: `${n}.db não encontrada; ${BOOTSTRAP}` }; continue; }
    const d = detail && detail.modules[n];
    const o = { exists: true, size_bytes: f.size, modified: new Date(f.mtimeMs).toISOString(), tables: d ? d.tables : {}, rows: d ? d.rows : 0, approx: d ? d.approx : f.size > BIG_DB };
    if (d && d.meta) o.meta = d.meta;
    if (d) {
      o.available = !d.error && d.rows > 0;
      if (d.error) o.detail = d.error; else if (!o.available) o.detail = `base vazia; ${BOOTSTRAP}`;
    } else { o.available = true; o.pending = true; }
    modules[n] = o;
  }
  const core = modules.politica || {}, t = core.tables || {}, c = (detail && detail.counts) || {}, m = (detail && detail.m) || {};
  const mtimes = Object.values(modules).filter((x) => x.modified).map((x) => x.modified).sort();
  return {
    ...m,
    available: !!core.available,
    data_dir: dataDir.startsWith(root + path.sep) ? path.relative(root, dataDir) : dataDir,
    data_version: { built: m.built || m.contracts_updated || null, newest_file: mtimes.length ? mtimes[mtimes.length - 1] : null, oldest_file: mtimes[0] || null },
    counts: {
      entities: t.entities || 0, public_bodies: c.public_bodies || 0, municipios: c.municipios || 0, freguesias: c.freguesias || 0,
      contracts: t.contracts || 0, events: t.events || 0, initiatives: t.initiatives || 0, votes: t.votes || 0, deputies: c.deputies || 0,
    },
    modules,
    unavailable: Object.keys(modules).filter((k) => !modules[k].available),
    memory: { rss_mb: Math.round(process.memoryUsage.rss() / 1048576), heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576), ...mem },
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".map": "application/json",
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg)/;
const JSON_TYPE = "application/json; charset=utf-8";
const CC_API = "public, max-age=30, stale-while-revalidate=300";
const CC_STATIC = "public, max-age=3600, stale-while-revalidate=86400";
const CC_IMMUTABLE = "public, max-age=31536000, immutable";
const WARM_RE = /^\/api\/(overview|changes|contracts|edicao\/dia|[a-z_]+\/overview)$/;
const gzipAsync = promisify(zlib.gzip), brotliAsync = promisify(zlib.brotliCompress);
const sha = (b) => crypto.createHash("sha1").update(b).digest("base64url").slice(0, 22);
const enc = new TextEncoder();

function workerLoop(app) {
  const { parentPort } = wt;
  const debug = process.env.ESTADO_ABERTO_DEBUG === "1";
  const memOf = () => { const m = process.memoryUsage(); return { heap: m.heapUsed, ext: m.external, ab: m.arrayBuffers }; };
  parentPort.postMessage({ type: "ready", routes: Object.keys(app.routes), requested: [...app.requested], loaded: app.loaded });
  parentPort.on("message", (m) => {
    if (m.kind === "status") {
      let detail = null;
      try { detail = app.statusDetail(); } catch (e) { console.error("status detail failed:", e.message); }
      parentPort.postMessage({ id: m.id, type: "result", detail, mem: debug ? memOf() : undefined });
      return;
    }
    const r = app.exec(m);
    const body = enc.encode(r.json);
    parentPort.postMessage({ id: m.id, type: "result", code: r.code, user: r.user, ms: r.ms, body, mem: debug ? memOf() : undefined }, [body.buffer]);
  });
}

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); this.bytes = 0; }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  peek(k) { return this.map.get(k); }
  set(k, v) { this.delete(k); this.map.set(k, v); v.lru = this; this.bytes += v.size; this.trim(); }
  delete(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.bytes -= v.size; v.lru = null; } }
  grow(v, n) { v.size += n; if (v.lru === this) { this.bytes += n; this.trim(); } }
  trim() {
    for (const pass of [0, 1]) {
      if (this.bytes <= this.max) return;
      for (const [k, v] of this.map) { if (this.bytes <= this.max) return; if (pass === 0 && v.hot) continue; this.delete(k); }
    }
  }
}

const acceptEncoding = (req) => {
  const h = String(req.headers["accept-encoding"] || "");
  if (!h) return null;
  const q = {};
  for (const part of h.split(",")) { const [name, ...ps] = part.trim().split(";"); const m = ps.join(";").match(/q=([0-9.]+)/); q[name.trim().toLowerCase()] = m ? Number(m[1]) : 1; }
  if (q.br > 0) return "br";
  if (q.gzip > 0 || q["*"] > 0) return "gzip";
  return null;
};
const compress = (buf, e, quality) => e === "br"
  ? brotliAsync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
  : gzipAsync(buf, { level: 6 });
const etagMatches = (req, etag) => {
  const h = req.headers["if-none-match"];
  if (!h) return false;
  if (h.trim() === "*") return true;
  return h.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
};

async function main() {
  const PORT = process.env.PORT || 3000;
  const DEBUG = process.env.ESTADO_ABERTO_DEBUG === "1";
  const cacheDir = path.resolve(process.env.ESTADO_ABERTO_CACHE || path.join(dataDir, "cache"));
  const publicDir = path.join(root, "public");
  const indexFile = path.join(publicDir, "index.html");
  const moduleDir = path.join(root, "server", "modules");
  const WAIT_MS = 6000, HOT_MS = 300, HOT_TTL = 10 * 60e3, SOFT_TTL = 30e3, SOFT_STALE = 5 * 60e3, ACTIVE_MS = 6 * 3600e3;
  const STATUS_EVERY = 30 * 60e3, MAX_HI = 128, MAX_LO = 32, WATCHDOG = 180e3, SLOW_MS = 500, MIN_COMPRESS = 860;
  const MAX_ENTRY = 8 * 1048576, MAX_DISK = 48, MAX_STATIC_FILE = 1048576;

  const codeStamp = (() => {
    let m = 0, v = "";
    const bump = (f) => { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {} };
    bump(fileURLToPath(import.meta.url));
    try { for (const f of fs.readdirSync(moduleDir)) bump(path.join(moduleDir, f)); } catch {}
    try { v = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(); } catch {}
    return sha(v + ":" + m);
  })();
  const appVersion = (() => { try { return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(); } catch { return ""; } })();

  const cache = new Lru(24 * 1048576);
  const staticCache = new Lru(20 * 1048576);
  const refreshing = new Set();
  const uncacheable = new Set();
  const fsp = fs.promises;
  let scan = new Map(), dbSig = "";
  let detail = null, detailBusy = false;
  let lag = null, workerMem = null, workerMemMax = 0;

  if (DEBUG) { lag = monitorEventLoopDelay({ resolution: 5 }); lag.enable(); }

  const rescan = async () => {
    try {
      const names = (await fsp.readdir(dataDir)).filter((f) => /^[a-z_]+\.db$/.test(f));
      const files = new Map();
      await Promise.all(names.map(async (f) => { try { const s = await fsp.stat(path.join(dataDir, f)); files.set(f.slice(0, -3), { size: s.size, mtimeMs: s.mtimeMs }); } catch {} }));
      scan = files;
      dbSig = sha([...files].filter(([n]) => n !== "user").sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, f]) => `${n}:${f.size}:${Math.floor(f.mtimeMs)}`).join("|"));
    } catch { scan = new Map(); }
  };

  const pool = { worker: null, app: null, ready: false, routes: new Set(), requested: [], loaded: [], inflight: null, hi: [], lo: [], byKey: new Map(), seq: 0, restarts: 0, stableTimer: null, respawn: null };
  const busy = () => !!pool.inflight || pool.hi.length > 0 || pool.lo.length > 0;

  const settle = (job, fn, v) => {
    clearTimeout(job.timer);
    if (job.key && pool.byKey.get(job.key) === job) pool.byKey.delete(job.key);
    if (pool.inflight === job) pool.inflight = null;
    fn(v);
  };
  const pump = () => {
    if (!pool.ready || pool.inflight) return;
    const job = pool.hi.shift() || pool.lo.shift();
    if (!job) return;
    pool.inflight = job; job.sent = true; job.sig = dbSig;
    const msg = { id: job.id, ...job.spec };
    if (pool.worker) {
      job.timer = setTimeout(() => { console.error("worker watchdog:", job.spec.path || job.spec.kind); try { pool.worker.terminate(); } catch {} }, WATCHDOG);
      pool.worker.postMessage(msg);
    } else {
      setImmediate(() => {
        let r;
        if (msg.kind === "status") r = { detail: pool.app.statusDetail() };
        else { const x = pool.app.exec(msg); r = { code: x.code, user: x.user, ms: x.ms, body: enc.encode(x.json) }; }
        r.sig = job.sig;
        settle(job, job.res, r); pump();
      });
    }
  };
  const submit = (spec, prio = "hi") => {
    const key = spec.coalesce ? `${spec.method}|${spec.path}?${spec.query}` : null;
    const found = key && pool.byKey.get(key);
    if (found) {
      if (prio === "hi" && found.prio === "lo" && !found.sent) { const i = pool.lo.indexOf(found); if (i >= 0) { pool.lo.splice(i, 1); found.prio = "hi"; pool.hi.push(found); } }
      return found.promise;
    }
    if (prio === "hi" && pool.hi.length >= MAX_HI) return Promise.reject(Object.assign(new Error("fila cheia"), { busy: true }));
    if (prio === "lo" && pool.lo.length >= MAX_LO) return Promise.resolve(null);
    const job = { id: ++pool.seq, spec: { kind: "route", ...spec }, prio, key, sent: false, timer: null };
    job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
    job.promise.catch(() => {});
    (prio === "hi" ? pool.hi : pool.lo).push(job);
    if (key) pool.byKey.set(key, job);
    pump();
    return job.promise;
  };

  const onWorkerGone = (why) => {
    pool.ready = false; pool.worker = null;
    clearTimeout(pool.stableTimer);
    const job = pool.inflight;
    if (job) settle(job, job.rej, new Error("worker: " + why));
    const delay = Math.min(30000, 500 * 2 ** pool.restarts++);
    console.error(`worker terminou (${why}); novo em ${delay} ms`);
    pool.respawn = setTimeout(startWorker, delay);
  };
  const startWorker = () => {
    let w;
    try {
      w = new wt.Worker(fileURLToPath(import.meta.url), { workerData: { role: "routes" }, resourceLimits: { maxOldGenerationSizeMb: 120, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    } catch (e) { console.error("worker indisponível, a executar no processo principal:", e.message); return startInline(); }
    pool.worker = w;
    w.on("message", (m) => {
      if (m.type === "ready") {
        pool.routes = new Set(m.routes); pool.requested = m.requested; pool.loaded = m.loaded; pool.ready = true;
        pool.stableTimer = setTimeout(() => { pool.restarts = 0; }, 60000); pool.stableTimer.unref();
        pump();
        return;
      }
      if (m.mem) { workerMem = m.mem; workerMemMax = Math.max(workerMemMax, m.mem.heap); }
      const job = pool.inflight;
      if (!job || job.id !== m.id) return;
      m.sig = job.sig;
      settle(job, job.res, m);
      pump();
    });
    w.on("error", (e) => console.error("worker error:", e && e.message));
    w.on("exit", (code) => { if (pool.worker === w) onWorkerGone("exit " + code); });
  };
  const startInline = async () => {
    pool.app = await buildApp();
    pool.routes = new Set(Object.keys(pool.app.routes)); pool.requested = [...pool.app.requested]; pool.loaded = pool.app.loaded; pool.ready = true;
    pump();
  };
  if (wt) startWorker(); else await startInline();

  const hashKey = (key) => crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
  const diskFiles = new Map();
  const persist = (e) => {
    const name = hashKey(e.key) + ".json";
    const head = JSON.stringify({ key: e.key, path: e.path, query: e.query, sig: e.sig, at: e.at, ms: e.ms, code: codeStamp, seed: e.seed });
    const data = Buffer.concat([Buffer.from(head.slice(0, -1) + ',"body":'), e.raw, Buffer.from("}")]);
    diskFiles.set(name, e.at);
    fsp.mkdir(cacheDir, { recursive: true })
      .then(() => fsp.writeFile(path.join(cacheDir, name + ".tmp"), data))
      .then(() => fsp.rename(path.join(cacheDir, name + ".tmp"), path.join(cacheDir, name)))
      .then(() => {
        if (diskFiles.size <= MAX_DISK) return;
        const old = [...diskFiles].sort((a, b) => a[1] - b[1]).slice(0, diskFiles.size - MAX_DISK);
        return Promise.all(old.map(([n]) => { diskFiles.delete(n); return fsp.unlink(path.join(cacheDir, n)).catch(() => {}); }));
      })
      .catch(() => {});
  };
  const loadDisk = async () => {
    let files;
    try { files = await fsp.readdir(cacheDir); } catch { return; }
    for (const f of files) {
      const file = path.join(cacheDir, f);
      try {
        if (f === "_status.json") {
          const d = JSON.parse(await fsp.readFile(file, "utf8"));
          if (d.code === codeStamp && d.detail && !detail) detail = d.detail;
          continue;
        }
        if (!f.endsWith(".json")) { if (f.endsWith(".tmp")) fsp.unlink(file).catch(() => {}); continue; }
        const buf = await fsp.readFile(file);
        const i = buf.indexOf('"body":');
        const h = JSON.parse(buf.toString("utf8", 0, i).replace(/,$/, "") + "}");
        if (h.code !== codeStamp) { fsp.unlink(file).catch(() => {}); continue; }
        const raw = buf.subarray(i + 7, buf.length - 1);
        if (!cache.peek(h.key)) cache.set(h.key, { raw, size: raw.length, tag: null, v: {}, key: h.key, path: h.path, query: h.query, at: h.at, sig: h.sig, ms: h.ms, hot: true, seed: !!h.seed, last: 0, lru: null });
        diskFiles.set(f, h.at);
      } catch { fsp.unlink(file).catch(() => {}); }
    }
  };
  const persistDetail = () => {
    fsp.mkdir(cacheDir, { recursive: true }).then(() => fsp.writeFile(path.join(cacheDir, "_status.json"), JSON.stringify({ code: codeStamp, detail }))).catch(() => {});
  };

  const accept = (key, p, q, r) => {
    if (r.entry !== undefined) return r.entry;
    r.entry = null;
    if (r.code !== 200) return null;
    if (r.user) { uncacheable.add(p); return null; }
    const raw = Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength);
    if (raw.length > MAX_ENTRY) return null;
    const old = cache.peek(key);
    const seed = q === "" && WARM_RE.test(p);
    const e = { raw, size: raw.length, tag: null, v: {}, key, path: p, query: q, at: Date.now(), sig: r.sig, ms: r.ms, hot: !!(old && old.hot) || r.ms >= HOT_MS || seed, seed, last: old ? old.last : Date.now(), lru: null };
    cache.set(key, e);
    if (e.hot) persist(e);
    r.entry = e;
    return e;
  };
  const refresh = (t) => {
    const key = t.path + "?" + t.query;
    if (refreshing.has(key)) return Promise.resolve();
    refreshing.add(key);
    return submit({ method: "GET", path: t.path, query: t.query, coalesce: true, fresh: true }, "lo")
      .then((r) => { if (r) accept(key, t.path, t.query, r); })
      .catch(() => {})
      .finally(() => refreshing.delete(key));
  };
  const refreshDetail = () => {
    if (detailBusy) return Promise.resolve();
    detailBusy = true;
    return submit({ kind: "status" }, "lo")
      .then((r) => { if (r && r.detail) { detail = r.detail; persistDetail(); } })
      .catch(() => {})
      .finally(() => { detailBusy = false; });
  };
  const tick = () => {
    if (!pool.ready || busy()) return;
    const now = Date.now();
    for (const p of pool.routes) if (WARM_RE.test(p) && !cache.peek(p + "?") && !refreshing.has(p + "?")) return void refresh({ path: p, query: "" });
    let pick = null;
    for (const e of cache.map.values()) {
      if (!e.hot || refreshing.has(e.key)) continue;
      if (!(e.seed || now - e.last < ACTIVE_MS)) continue;
      if (e.sig !== dbSig || now - e.at > HOT_TTL) if (!pick || e.at < pick.at) pick = e;
    }
    if (pick) return void refresh(pick);
    if (!detail || now - detail.at > STATUS_EVERY) refreshDetail();
  };
  const forceWarm = () => {
    let n = 0;
    for (const p of pool.routes) if (WARM_RE.test(p)) { refresh({ path: p, query: "" }); n++; }
    for (const e of cache.map.values()) if (e.hot && !e.seed) { refresh(e); n++; }
    refreshDetail();
    return n;
  };

  const variant = (body, e, quality) => {
    if (body.v[e]) return body.v[e];
    const p = compress(body.raw, e, quality).then((b) => { const owner = body.lru; if (owner) owner.grow(body, b.length); else body.size += b.length; body.vb = body.vb || {}; body.vb[e] = b; return b; });
    body.v[e] = p;
    p.catch(() => { delete body.v[e]; });
    return p;
  };

  const timing = (rc) => {
    const parts = [`app;dur=${(performance.now() - rc.t0).toFixed(1)}`];
    if (rc.db != null) parts.push(`db;dur=${rc.db}`);
    if (rc.cache) parts.push(`cache;desc="${rc.cache}"`);
    return parts.join(", ");
  };
  async function sendBody(req, res, rc, body, o) {
    const code = o.code || 200, type = o.type;
    let e = null, buf = body.raw;
    if (o.compress !== false && buf.length >= MIN_COMPRESS && COMPRESSIBLE.test(type)) e = acceptEncoding(req);
    if (e) {
      try { buf = await variant(body, e, o.quality || 5); } catch { buf = body.raw; e = null; }
      if (buf.length >= body.raw.length) { buf = body.raw; e = null; }
    }
    if (res.destroyed || res.writableEnded) return;
    const headers = { "Content-Type": type, "Cache-Control": o.cc, Vary: "Accept-Encoding", "Server-Timing": timing(rc) };
    if (o.link) headers.Link = o.link;
    let etag = null;
    if (code === 200 && o.etag !== false) {
      body.tag = body.tag || sha(body.raw);
      etag = `"${body.tag}${e ? "-" + e : ""}"`;
      headers.ETag = etag;
      if (etagMatches(req, etag)) { delete headers["Content-Type"]; res.writeHead(304, headers); return res.end(); }
    }
    headers["Content-Length"] = buf.length;
    if (e) headers["Content-Encoding"] = e;
    res.writeHead(code, headers);
    res.end(req.method === "HEAD" ? undefined : buf);
  }
  const sendWithHeaders = (req, res, rc, code, obj, headers) => {
    if (res.destroyed || res.writableEnded) return;
    const raw = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "Content-Length": raw.length, "Server-Timing": timing(rc), ...headers });
    res.end(req.method === "HEAD" ? undefined : raw);
  };

  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
  const TIMEOUT = Symbol("timeout");

  const readBody = (req) => new Promise((resolve) => {
    let d = "", n = 0;
    req.on("data", (c) => { n += c.length; if (n <= (1 << 20)) d += c; });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });

  let statusBody = null, statusAt = 0;
  const serveStatus = (req, res, rc) => {
    const now = Date.now();
    if (!statusBody || now - statusAt > 2000) {
      const mem = { worker_heap_mb: workerMem ? Math.round(workerMem.heap / 1048576) : 0 };
      const raw = Buffer.from(JSON.stringify(composeStatus(detail, scan, new Set([...pool.requested, "politica"]), mem)));
      statusBody = { raw, size: raw.length, v: {}, tag: null, lru: null };
      statusAt = now;
    }
    rc.cache = "status";
    return sendBody(req, res, rc, statusBody, { type: JSON_TYPE, cc: "public, max-age=10", quality: 4 });
  };

  const perfBody = () => {
    const mu = process.memoryUsage();
    const ms = (v) => Math.round(v / 1e4) / 100;
    return {
      eventloop: lag ? { resolution_ms: 5, min_ms: ms(lag.min), mean_ms: ms(lag.mean), p50_ms: ms(lag.percentile(50)), p99_ms: ms(lag.percentile(99)), max_ms: ms(lag.max), lag_max_ms: Math.max(0, ms(lag.max) - 5) } : null,
      memory_mb: { rss: Math.round(mu.rss / 1048576), main_heap: Math.round(mu.heapUsed / 1048576), main_external: Math.round(mu.external / 1048576), worker_heap: workerMem ? Math.round(workerMem.heap / 1048576) : null, worker_heap_max: Math.round(workerMemMax / 1048576), worker_external: workerMem ? Math.round(workerMem.ext / 1048576) : null },
      queue: { hi: pool.hi.length, lo: pool.lo.length, inflight: pool.inflight ? pool.inflight.spec.path || pool.inflight.spec.kind : null, ready: pool.ready, worker: !!pool.worker },
      cache: { api_entries: cache.map.size, api_mb: Math.round(cache.bytes / 10485.76) / 100, static_entries: staticCache.map.size, static_mb: Math.round(staticCache.bytes / 10485.76) / 100 },
    };
  };

  async function apiRoute(req, res, url, rc) {
    const p = url.pathname, query = url.search.slice(1);
    rc.route = p;
    if (p === "/api/status" && (req.method === "GET" || req.method === "HEAD")) return serveStatus(req, res, rc);
    if (DEBUG && p === "/api/_perf") {
      const warmed = url.searchParams.has("warm") ? forceWarm() : undefined;
      const out = { ...perfBody(), ...(warmed !== undefined ? { warm_queued: warmed } : {}) };
      if (url.searchParams.has("reset") && lag) lag.reset();
      return sendWithHeaders(req, res, rc, 200, out, {});
    }
    if (pool.ready && !pool.routes.has(p)) return sendWithHeaders(req, res, rc, 404, { error: "not found" }, {});
    const read = req.method === "GET" || req.method === "HEAD";
    const retry = { "Retry-After": "2" };

    if (!read) {
      const body = req.method === "POST" ? await readBody(req) : {};
      let r;
      try { r = await withTimeout(submit({ method: req.method, path: p, query, body }, "hi"), 30000); } catch (e) { return sendWithHeaders(req, res, rc, 503, { error: "ocupado", detail: String(e.message) }, retry); }
      if (r === TIMEOUT) return sendWithHeaders(req, res, rc, 202, { status: "carregando", retry_after: 2 }, retry);
      rc.db = r.ms; rc.cache = "bypass";
      return sendBody(req, res, rc, { raw: Buffer.from(r.body), v: {}, tag: null, size: 0, lru: null }, { code: r.code, type: JSON_TYPE, cc: "no-store", etag: false });
    }

    const key = p + "?" + query;
    let e = uncacheable.has(p) ? null : cache.get(key);
    const now = Date.now();
    if (e) {
      e.last = now;
      const age = now - e.at, fresh = e.sig === dbSig && age < (e.hot ? HOT_TTL : SOFT_TTL);
      if (!fresh) refresh(e);
      if (fresh || e.hot || age < SOFT_STALE) {
        rc.cache = fresh ? "hit" : "stale";
        return sendBody(req, res, rc, e, { type: JSON_TYPE, cc: CC_API, quality: 4 });
      }
    }
    let r;
    try { r = await withTimeout(submit({ method: "GET", path: p, query, coalesce: true }, "hi"), WAIT_MS); } catch (err) {
      return sendWithHeaders(req, res, rc, 503, { error: "ocupado", detail: String(err.message) }, retry);
    }
    if (r === TIMEOUT) { rc.cache = "wait"; return sendWithHeaders(req, res, rc, 202, { status: "carregando", retry_after: 2 }, retry); }
    rc.cache = "miss"; rc.db = r.ms;
    const entry = accept(key, p, query, r);
    if (entry) return sendBody(req, res, rc, entry, { type: JSON_TYPE, cc: CC_API, quality: 4 });
    const body = { raw: Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength), v: {}, tag: null, size: 0, lru: null };
    return sendBody(req, res, rc, body, { code: r.code, type: JSON_TYPE, cc: r.code === 200 && !r.user ? CC_API : "no-store", etag: r.code === 200 && !r.user });
  }

  const statMemo = new Map();
  const statOf = async (file) => {
    const c = statMemo.get(file), now = Date.now();
    if (c && now - c.at < 2000) return c.st;
    let st = null;
    try { st = await fsp.stat(file); } catch {}
    if (statMemo.size > 512) statMemo.clear();
    statMemo.set(file, { at: now, st });
    return st;
  };
  const filePending = new Map();
  const readStatic = (ck, file) => {
    let p = filePending.get(ck);
    if (!p) {
      p = fsp.readFile(file).then((raw) => { const b = { raw, size: raw.length, tag: null, v: {}, lru: null }; staticCache.set(ck, b); return b; }).finally(() => filePending.delete(ck));
      filePending.set(ck, p);
    }
    return p;
  };

  let indexInfo = null, indexBody = null, indexReading = null;
  const loadIndex = async (st) => {
    if (indexInfo && indexInfo.mtime === st.mtimeMs) return indexInfo;
    if (!indexReading) {
      indexReading = fsp.readFile(indexFile, "utf8").then((html) => {
        const links = [];
        const css = html.match(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/i);
        const href = (tag) => { const m = tag.match(/\bhref=["']([^"']+)["']/i); return m ? m[1] : null; };
        if (css && href(css[0])) links.push(`<${href(css[0])}>; rel=preload; as=style`);
        let n = 0;
        for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
          if (n++ >= 3) break;
          links.push(`<${m[1]}>; rel=${/type=["']module["']/i.test(m[0]) ? "modulepreload" : "preload; as=script"}`);
        }
        indexInfo = { mtime: st.mtimeMs, html, links };
        indexBody = null;
        return indexInfo;
      }).finally(() => { indexReading = null; });
    }
    return indexReading;
  };
  const jsonForScript = (s) => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");
  const indexFor = (info) => {
    const boot = cache.peek("/api/edicao/dia?");
    let tag = "";
    if (boot) { boot.tag = boot.tag || sha(boot.raw); tag = boot.tag; }
    const ck = info.mtime + "|" + tag;
    if (indexBody && indexBody.ck === ck) return indexBody;
    let html = info.html;
    if (html.includes("<!--EA-BOOT-->")) {
      const inj = boot ? `<script>window.__EA_BOOT={"/api/edicao/dia":${jsonForScript(boot.raw.toString("utf8"))}}</script>` : "";
      html = html.split("<!--EA-BOOT-->").join(inj);
    }
    html = html.replace(/(<meta name="ea-version" content=")(")/, `$1${appVersion}$2`);
    const raw = Buffer.from(html);
    indexBody = { ck, raw, size: raw.length, tag: null, v: {}, lru: null };
    return indexBody;
  };

  async function staticRoute(req, res, url, rc) {
    rc.route = "static";
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    let file = path.join(publicDir, rel === "/" ? "index.html" : rel);
    let st = file.startsWith(publicDir + path.sep) ? await statOf(file) : null;
    if (!st || st.isDirectory()) { file = indexFile; st = await statOf(file); }
    if (!st) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    const type = MIME[path.extname(file)] || "application/octet-stream";

    if (file === indexFile) {
      const known = indexInfo;
      if (known && known.links.length && req.httpVersion !== "1.0" && process.env.ESTADO_ABERTO_EARLY_HINTS !== "0" && typeof res.writeEarlyHints === "function") res.writeEarlyHints({ link: known.links });
      const info = await loadIndex(st);
      const body = indexFor(info);
      rc.cache = "html";
      return sendBody(req, res, rc, body, { type, cc: "no-cache", link: info.links.join(", ") || undefined });
    }

    const cc = url.searchParams.has("v") ? CC_IMMUTABLE : CC_STATIC;
    if (st.size > MAX_STATIC_FILE || !COMPRESSIBLE.test(type)) {
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = { "Content-Type": type, "Cache-Control": cc, ETag: etag, "Server-Timing": timing(rc) };
      if (etagMatches(req, etag)) { delete headers["Content-Type"]; res.writeHead(304, headers); return res.end(); }
      headers["Content-Length"] = st.size;
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      const rs = fs.createReadStream(file);
      rs.on("error", () => res.destroy());
      res.on("close", () => rs.destroy());
      rs.pipe(res);
      return;
    }
    const ck = `${file}|${Math.floor(st.mtimeMs)}|${st.size}`;
    const body = staticCache.get(ck) || await readStatic(ck, file);
    rc.cache = "asset";
    return sendBody(req, res, rc, body, { type, cc });
  }

  const server = http.createServer((req, res) => {
    const rc = { t0: performance.now(), route: null, cache: null, db: null };
    res.on("close", () => {
      const ms = performance.now() - rc.t0;
      if (ms > SLOW_MS) console.log(`slow ${req.method} ${rc.route || req.url.split("?")[0]} ${Math.round(ms)}ms status=${res.statusCode} cache=${rc.cache || "-"} db=${rc.db == null ? "-" : rc.db + "ms"}`);
    });
    let url;
    try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
    (url.pathname.startsWith("/api/") ? apiRoute(req, res, url, rc) : staticRoute(req, res, url, rc)).catch((e) => {
      console.error("request failed:", url.pathname, e && e.message);
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "erro_interno", detail: String(e && e.message || e) })); }
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 70000;
  server.setTimeout(120000);

  await rescan();
  loadDisk().catch(() => {});
  setInterval(rescan, 10000).unref();
  setInterval(tick, 5000).unref();
  statOf(indexFile).then((st) => st && loadIndex(st)).catch(() => {});
  server.listen(PORT, process.env.HOST || "0.0.0.0", () => console.log("http://localhost:" + PORT));
  const bye = () => { try { if (pool.worker) pool.worker.terminate(); } catch {} process.exit(0); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

if (IS_WORKER) workerLoop(await buildApp());
else await main();
