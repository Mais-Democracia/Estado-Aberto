// Dependency-free API + static server.  Run: node server.mjs  (PORT=3000)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(root, "data", "politica.db"), { readOnly: true });
const userDb = new DatabaseSync(path.join(root, "data", "user.db"));
userDb.exec(`CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, label TEXT, created TEXT, UNIQUE(kind, ref));`);
const powers = JSON.parse(fs.readFileSync(path.join(root, "seed", "powers.json"), "utf8"));

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const has = (t) => !!one("SELECT 1 x FROM sqlite_master WHERE name = ?", t);
const num = (v, d, lo = 1, hi = 1e9) => Math.min(hi, Math.max(lo, Number.parseInt(v ?? d, 10) || d));
const like = (s) => `%${String(s).replace(/[%_]/g, "")}%`;
const fts = (s) => String(s).replace(/["*()^:-]/g, " ").split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
const meta = () => Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
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
const procedureList = memo(() => all("SELECT procedure, COUNT(*) n FROM contracts GROUP BY procedure ORDER BY n DESC LIMIT 12"), 86400000);
const routes = {
  "/api/status": memo(() => ({
    ...meta(),
    counts: {
      entities: one("SELECT COUNT(*) n FROM entities").n,
      public_bodies: one("SELECT COUNT(*) n FROM entities WHERE is_public = 1").n,
      municipios: one("SELECT COUNT(*) n FROM entities WHERE kind = 'municipio'").n,
      freguesias: one("SELECT COUNT(*) n FROM entities WHERE kind = 'freguesia'").n,
      contracts: has("contracts") ? one("SELECT COUNT(*) n FROM contracts").n : 0,
      events: one("SELECT COUNT(*) n FROM events").n,
      initiatives: one("SELECT COUNT(*) n FROM initiatives").n,
      votes: one("SELECT COUNT(*) n FROM votes").n,
      deputies: one("SELECT COUNT(*) n FROM people WHERE body = 'Assembleia da República'").n,
    },
  })),
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
  "/api/powers": () => powers,
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
const openData = (name) => { const f = path.join(root, "data", `${name}.db`); return fs.existsSync(f) ? new DatabaseSync(f, { readOnly: true }) : null; };
const ctx = { db, userDb, all, one, has, num, like, fts, meta, routes, root, openData };
const modDir = path.join(root, "server", "modules");
const loaded = [];
for (const f of fs.existsSync(modDir) ? fs.readdirSync(modDir).filter((x) => x.endsWith(".mjs")).sort() : []) {
  try { await (await import(path.join(modDir, f))).default(ctx); loaded.push(f); } catch (e) { console.error("module failed:", f, e.message); }
}
// aggregate "overview" endpoints of plug-in modules are expensive and change rarely: cache per query string for 10 minutes
for (const key of Object.keys(routes).filter((k) => /^\/api\/[a-z_]+\/overview$/.test(k))) {
  const fn = routes[key], cache = new Map();
  routes[key] = (q, req, body) => { const k = q.toString(), hit = cache.get(k); if (hit) { if (Date.now() - hit.at > 3600000 && !hit.busy) { hit.busy = true; setTimeout(() => { try { cache.set(k, { at: Date.now(), v: fn(q, req, body) }); } catch { hit.busy = false; } }, 0); } return hit.v; } const v = fn(q, req, body); cache.set(k, { at: Date.now(), v }); return v; };
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
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) {
      const fn = routes[url.pathname];
      const body = req.method === "POST" ? await readBody(req) : {};
      const out = fn ? fn(url.searchParams, req, body) : null;
      res.writeHead(out ? 200 : 404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(JSON.stringify(out ?? { error: "not found" }));
    }
    let file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "public", "index.html");
    const st = fs.statSync(file), etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const hdr = { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, hdr); return res.end(); }
    res.writeHead(200, hdr);
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("http://localhost:" + (process.env.PORT || 3000));
  const warm = () => { for (const k of Object.keys(routes).filter((x) => /^\/api\/(overview|changes|status|contracts|(saude|seguranca|justica|educacao)\/overview)$/.test(x))) { try { const t0 = Date.now(); routes[k](new URLSearchParams()); console.log('warm', k, Date.now() - t0, 'ms'); } catch (e) { console.error("warm-up failed:", k, e.message); } } };
  setTimeout(warm, 200); setInterval(warm, 3 * 60 * 1000).unref();   // < half of the shortest cache TTL (5 min for /api/changes) so entries never go stale   // keep the 10-min memo hot so the home page never pays the 3 s query
});
