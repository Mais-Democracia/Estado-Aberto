// Dependency-free API + static server.  Run: node server.mjs  (PORT=3000, ESTADO_ABERTO_DATA=./data)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ESTADO_ABERTO_DATA || path.join(root, "data"));
const BOOTSTRAP = "execute o bootstrap (docs/CONTRIBUTING.md)";

class DataMissing extends Error {
  constructor(name, why = "não encontrada") { super(`${name} ${why}; ${BOOTSTRAP}`); this.dbName = name; }
}
const unavailable = (name, why) => ({ available: false, note: `A base data/${name}.db ${why || "não foi encontrada"}; ${BOOTSTRAP}.` });

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
const lazyDb = (name) => ({ prepare: (sql) => readDb(name).prepare(sql), exec: (sql) => readDb(name).exec(sql) });
const db = lazyDb("politica");

let userHandle = null;
const userDb = {
  prepare(sql) {
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
    if (at && Date.now() - at > ttl && !busy) { busy = true; setTimeout(() => { try { val = fn(...a); at = Date.now(); } catch {} busy = false; }, 0); }
    if (!at) { val = fn(...a); at = Date.now(); }
    return val;
  };
};
const countOf = (name, sql) => { try { return db.prepare(sql).get().n; } catch (e) { if (e instanceof DataMissing) return 0; return 0; } };
const BIG = 200 * 1024 * 1024;
function dbReport(name) {
  const file = path.join(dataDir, `${name}.db`);
  if (!fs.existsSync(file)) return { exists: false, available: false, detail: `${name}.db não encontrada; ${BOOTSTRAP}` };
  const st = fs.statSync(file), out = { exists: true, size_bytes: st.size, modified: st.mtime.toISOString(), tables: {}, rows: 0, approx: st.size > BIG };
  try {
    const h = readDb(name);
    const names = h.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
    for (const t of names) {
      let n = 0;
      try { n = out.approx ? (h.prepare(`SELECT MAX(rowid) n FROM "${t}"`).get().n || 0) : h.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch {}
      out.tables[t] = n; out.rows += n;
    }
    try { const m = h.prepare("SELECT key, value FROM meta WHERE key IN ('built','updated','contracts_updated','version')").all(); if (m.length) out.meta = Object.fromEntries(m.map((r) => [r.key, r.value])); } catch {}
    out.available = out.rows > 0;
    if (!out.available) out.detail = `base vazia; ${BOOTSTRAP}`;
  } catch (e) { out.available = false; out.detail = e.message; }
  return out;
}
let statusAt = 0, statusVal = null;
function statusReport() {
  if (statusVal && Date.now() - statusAt < 30000) return statusVal;
  const names = new Set([...requested]);
  try { for (const f of fs.readdirSync(dataDir)) if (/^[a-z_]+\.db$/.test(f) && f !== "user.db") names.add(f.slice(0, -3)); } catch {}
  const modules = {};
  for (const n of [...names].sort()) modules[n] = dbReport(n);
  const core = modules.politica || {};
  let m = {};
  try { m = meta(); } catch {}
  const mtimes = Object.values(modules).filter((x) => x.modified).map((x) => x.modified).sort();
  const t = core.tables || {};
  statusVal = {
    ...m,
    available: !!core.available,
    data_dir: dataDir.startsWith(root + path.sep) ? path.relative(root, dataDir) : dataDir,
    data_version: { built: m.built || m.contracts_updated || null, newest_file: mtimes.length ? mtimes[mtimes.length - 1] : null, oldest_file: mtimes[0] || null },
    counts: {
      entities: t.entities || 0, public_bodies: core.available ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE is_public = 1") : 0,
      municipios: core.available ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE kind = 'municipio'") : 0,
      freguesias: core.available ? countOf("politica", "SELECT COUNT(*) n FROM entities WHERE kind = 'freguesia'") : 0,
      contracts: t.contracts || 0, events: t.events || 0, initiatives: t.initiatives || 0, votes: t.votes || 0,
      deputies: core.available ? countOf("politica", "SELECT COUNT(*) n FROM people WHERE body = 'Assembleia da República'") : 0,
    },
    modules,
    unavailable: Object.keys(modules).filter((k) => !modules[k].available),
    memory: { rss_mb: Math.round(process.memoryUsage.rss() / 1048576), heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576) },
  };
  statusAt = Date.now();
  return statusVal;
}
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
const ctx = { db, userDb, all, one, has, num, like, fts, meta, routes, root, openData, DataMissing, unavailable };
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
    if (hit) {
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

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

const MAX_BODY = 1 << 20;
const readBody2 = (req) => new Promise((res) => { let d = "", n = 0; req.on("data", (c) => { n += c.length; if (n <= MAX_BODY) d += c; }); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
};
const dadosIndisponiveis = (detail, db) => ({ error: "dados_indisponiveis", detail, ...(db ? { db } : {}) });
const unavailableOf = (out) => {
  if (!out || typeof out !== "object" || out.updating) return null;
  const txt = out.available === false ? out.note : typeof out.error === "string" ? out.error : null;
  if (!txt || !/data\/[a-z_]+\.db/.test(txt) || !/ainda não foi gerada|não existe|não foi encontrada|ilegível/.test(txt)) return null;
  const name = txt.match(/data\/([a-z_]+)\.db/)[1];
  return { name, detail: `${name} não encontrada; ${BOOTSTRAP}` };
};
const failure = (e) => {
  if (e instanceof DataMissing) return { code: 503, body: dadosIndisponiveis(e.message, e.dbName) };
  const msg = String(e && e.message || e);
  if (/no such (table|column)|malformed|not a database|disk image|unable to open/i.test(msg)) return { code: 503, body: dadosIndisponiveis(`base incompleta ou inválida (${msg}); ${BOOTSTRAP}`) };
  if (e instanceof TypeError && /null|undefined/.test(msg)) return { code: 503, body: dadosIndisponiveis(`dados em falta (${msg}); ${BOOTSTRAP}`) };
  return { code: 500, body: { error: "erro_interno", detail: msg } };
};
const publicDir = path.join(root, "public");

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) {
      const fn = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
      if (!fn) return sendJson(res, 404, { error: "not found" });
      const body = req.method === "POST" ? await readBody2(req) : {};
      let out;
      try { out = fn(url.searchParams, req, body); } catch (e) {
        const f = failure(e);
        if (f.code === 500) console.error("route failed:", url.pathname, e && e.stack || e);
        return sendJson(res, f.code, f.body);
      }
      const un = unavailableOf(out);
      if (un) return sendJson(res, 503, dadosIndisponiveis(un.detail, un.name));
      return out ? sendJson(res, 200, out) : sendJson(res, 404, { error: "not found" });
    }
    let file = path.join(publicDir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(publicDir, "index.html");
    const st = fs.statSync(file), etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const hdr = { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, hdr); return res.end(); }
    res.writeHead(200, hdr);
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error("request failed:", url.pathname, e && e.message);
    if (!res.headersSent) sendJson(res, 500, { error: "erro_interno", detail: String(e && e.message || e) });
    else res.end();
  }
}).listen(process.env.PORT || 3000, process.env.HOST || "0.0.0.0", () => {
  console.log("http://localhost:" + (process.env.PORT || 3000));
  const warm = () => {
    for (const k of Object.keys(routes).filter((x) => /^\/api\/(overview|changes|status|contracts|(saude|seguranca|justica|educacao)\/overview)$/.test(x))) {
      try { const t0 = Date.now(); routes[k](new URLSearchParams()); console.log("warm", k, Date.now() - t0, "ms"); }
      catch (e) { if (!(e instanceof DataMissing) && !/no such/.test(String(e.message))) console.error("warm-up failed:", k, e.message); }
    }
  };
  setTimeout(warm, 200); setInterval(warm, 3 * 60 * 1000).unref();
});
