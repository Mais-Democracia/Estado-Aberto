// Quem decide: dirigentes, administradores, gabinetes e declarações de interesses (registo de interesses público).
// Dados: data/responsaveis.db (ingest/jobs/responsaveis.py). Fontes: Entidade para a Transparência (API pública),
// CReSAP, portugal.gov.pt (via ministerios.db), BASE (contratos). Ligações declaradas = informação oficial, sem juízo de valor.
import { statSync } from "node:fs";
import path from "node:path";

export default function register({ routes, openData, dataDir, db: pol }) {
  let mine = null, mtime = 0;
  const file = path.join(dataDir, "responsaveis.db");
  const dbh = () => {
    try { const m = statSync(file).mtimeMs; if (!mine || m !== mtime) { try { mine?.close(); } catch {} mine = openData("responsaveis"); mtime = m; } } catch { mine = null; }
    return mine;
  };
  // the ingest job writes while we read: retry briefly on SQLITE_BUSY
  const run = (fn, tries = 4) => { for (let i = 0; ; i++) { try { return fn(); } catch (e) { if (i >= tries || !/lock|busy/i.test(String(e.message))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); } } };
  const all = (sql, ...p) => run(() => dbh().prepare(sql).all(...p));
  const one = (sql, ...p) => run(() => dbh().prepare(sql).get(...p));
  const missing = { available: false, error: "responsaveis.db ainda não existe — corra `python3 ingest/run_all.py responsaveis`." };
  const ok = () => { try { return !!dbh() && !!one("SELECT 1 x FROM mandates LIMIT 1"); } catch { return false; } };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const today = () => new Date().toISOString().slice(0, 10);
  const meta = () => Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));

  // ---- in-memory index of mandates (≈17k rows) for accent-insensitive search
  let idx = null, idxAt = 0;
  const index = () => {
    if (idx && idxAt === mtime) return idx;
    const rows = all("SELECT id, entity_id, entity, entity_nif, role, holder_id, holder, begin_date, end_date, board FROM mandates");
    const t = today();
    for (const r of rows) { r._h = norm(r.holder); r._e = norm(r.entity); r._r = norm(r.role); r.active = !r.end_date || r.end_date >= t ? 1 : 0; }
    idx = rows; idxAt = mtime; return idx;
  };
  let appx = null, appxAt = 0;
  const appIndex = () => {
    if (appx && appxAt === mtime) return appx;
    appx = all("SELECT id, person, role, organ, ministry, start, act, source_url FROM appointments");
    for (const r of appx) { r._p = norm(r.person); r._o = norm((r.organ || "") + " " + (r.ministry || "")); r._r = norm(r.role); }
    appxAt = mtime; return appx;
  };

  const intCount = () => Object.fromEntries(all("SELECT holder_id, COUNT(*) n FROM interests GROUP BY holder_id").map((r) => [r.holder_id, r.n]));
  const linkCount = () => Object.fromEntries(all("SELECT holder_id, COUNT(*) n FROM links GROUP BY holder_id").map((r) => [r.holder_id, r.n]));

  // one snapshot per 5 minutes: the ingest job keeps writing, so live counts would drift between calls
  let covCache = null;
  routes["/api/responsaveis/coverage"] = () => {
    if (!ok()) return missing;
    if (covCache && Date.now() - covCache.at < 300000) return covCache.v;
    const v = coverageNow(); covCache = { at: Date.now(), v }; return v;
  };
  const coverageNow = () => {
    const m = meta();
    const c = one(`SELECT (SELECT COUNT(*) FROM mandates) mandates, (SELECT COUNT(DISTINCT holder_id) FROM mandates) holders,
      (SELECT COUNT(DISTINCT entity_id) FROM mandates) entities, (SELECT COUNT(*) FROM holders) holders_checked,
      (SELECT COUNT(*) FROM declarations) declarations, (SELECT COUNT(*) FROM declarations WHERE detail_at IS NOT NULL) declarations_detailed,
      (SELECT COUNT(*) FROM declarations WHERE state_id = 8) declarations_published,
      (SELECT COUNT(DISTINCT holder_id) FROM interests) holders_with_interests,
      (SELECT COUNT(*) FROM interests) interests, (SELECT COUNT(*) FROM interests WHERE company_nif IS NOT NULL) interests_nif,
      (SELECT COUNT(*) FROM links) links, (SELECT COUNT(*) FROM cresap) cresap, (SELECT COUNT(*) FROM appointments) appointments,
      (SELECT COUNT(DISTINCT entity_id) FROM mandates WHERE entity_nif IS NOT NULL) entities_nif,
      (SELECT MIN(begin_date) FROM mandates WHERE begin_date > '1990') first_begin, (SELECT MAX(begin_date) FROM mandates) last_begin`);
    return { available: true, as_of: new Date().toISOString(), ...c, mandates_crawled_at: m.mandates_at || null, updated: m.updated || null, blocked: all("SELECT source, reason FROM blocked") };
  };

  // roles & bodies facets
  routes["/api/responsaveis/facets"] = () => {
    if (!ok()) return missing;
    return {
      roles: all("SELECT role, COUNT(*) n FROM mandates GROUP BY role ORDER BY n DESC LIMIT 40"),
      boards: all("SELECT COALESCE(board,'—') board, COUNT(*) n FROM mandates GROUP BY board ORDER BY n DESC LIMIT 20"),
    };
  };

  routes["/api/responsaveis/search"] = (q) => {
    if (!ok()) return missing;
    const qs = norm(q.get("q") || ""), role = norm(q.get("role") || ""), body = norm(q.get("body") || "");
    const kind = q.get("kind") || "mandates"; // mandates | gabinete | cresap
    const active = q.get("active") === "1", withInt = q.get("interests") === "1";
    const limit = Math.min(Number(q.get("limit")) || 40, 100), offset = Math.max(Number(q.get("offset")) || 0, 0);
    const out = { available: true, kind, q: q.get("q") || "", counts: {} };
    const words = qs.split(" ").filter(Boolean);
    const matchAll = (txt) => words.every((w) => txt.includes(w));

    // counts for the three tabs (for the same free-text query)
    const nCres = qs || body || role
      ? one("SELECT COUNT(*) n FROM cresap").n && all("SELECT entity, role, code FROM cresap").filter((r) => matchAll(norm(r.entity + " " + r.role + " " + r.code)) && (!role || norm(r.role).includes(role)) && (!body || norm(r.entity).includes(body))).length
      : one("SELECT COUNT(*) n FROM cresap").n;
    const apps = appIndex().filter((r) => (!qs || matchAll(r._p + " " + r._o + " " + r._r)) && (!role || r._r.includes(role)) && (!body || r._o.includes(body)));
    let rows = index().filter((r) => (!qs || matchAll(r._h + " " + r._e + " " + r._r)) && (!role || r._r.includes(role)) && (!body || r._e.includes(body)) && (!active || r.active));
    const ic = intCount(), lc = linkCount();
    // group by holder
    const by = new Map();
    for (const r of rows) {
      let g = by.get(r.holder_id);
      if (!g) by.set(r.holder_id, (g = { id: r.holder_id, name: r.holder, active: 0, n: 0, last: "", mandates: [] }));
      g.n++; g.active += r.active; if ((r.end_date || "9999") > g.last) g.last = r.end_date || "9999";
      g.mandates.push(r);
    }
    let people = [...by.values()];
    if (withInt) people = people.filter((g) => ic[g.id]);
    people.sort((a, b) => (b.active > 0) - (a.active > 0) || (b.last > a.last ? 1 : b.last < a.last ? -1 : 0) || a.name.localeCompare(b.name, "pt"));
    out.counts = { mandates: people.length, gabinete: apps.length, cresap: nCres };
    if (kind === "mandates") {
      out.total = people.length;
      out.results = people.slice(offset, offset + limit).map((g) => {
        const cur = g.mandates.filter((m) => m.active).sort((a, b) => (b.begin_date || "") > (a.begin_date || "") ? 1 : -1);
        const shown = (cur.length ? cur : g.mandates.sort((a, b) => ((b.end_date || "") > (a.end_date || "") ? 1 : -1))).slice(0, 3);
        return { id: g.id, name: g.name, n_mandates: g.n, n_active: g.active, interests: ic[g.id] || 0, links: lc[g.id] || 0,
          mandates: shown.map((m) => ({ role: m.role, entity: m.entity, entity_id: m.entity_id, entity_nif: m.entity_nif, board: m.board, begin: m.begin_date, end: m.end_date, active: m.active })) };
      });
    } else if (kind === "gabinete") {
      out.total = apps.length;
      out.results = apps.slice(offset, offset + limit).map(({ _p, _o, _r, ...r }) => r);
    } else {
      const cs = all("SELECT code, status, entity, entity_nif, role, proposal_url, despacho_url, item_url, source_url FROM cresap")
        .filter((r) => matchAll(norm(r.entity + " " + r.role + " " + r.code)) && (!role || norm(r.role).includes(role)) && (!body || norm(r.entity).includes(body)));
      out.total = cs.length; out.results = cs.slice(offset, offset + limit);
    }
    return out;
  };

  const SECTION = { atividade: "Atividades e cargos (profissionais, públicos, privados)", associativa: "Entidades associativas", apoio: "Apoios ou benefícios", servico: "Serviços prestados", sociedade: "Sociedades (participações)", outra: "Outras situações" };

  routes["/api/responsaveis/person"] = (q) => {
    if (!ok()) return missing;
    const raw = q.get("id") || "";
    if (raw.startsWith("a")) { // gabinete appointment
      const a = one("SELECT * FROM appointments WHERE id = ?", Number(raw.slice(1)));
      if (!a) return { error: "Pessoa não encontrada" };
      const same = all("SELECT id, role, organ, ministry, start, act, source_url FROM appointments WHERE person = ? ORDER BY start DESC", a.person);
      const n = norm(a.person);
      const et = index().filter((r) => r._h === n).slice(0, 10).map((r) => ({ holder_id: r.holder_id, role: r.role, entity: r.entity, begin: r.begin_date, end: r.end_date }));
      return { available: true, kind: "gabinete", name: a.person, appointments: same, same_name_in_et: et,
        note: "A correspondência com o registo da Entidade para a Transparência é apenas por nome completo idêntico e não confirma que seja a mesma pessoa." };
    }
    const id = Number(raw);
    const mandates = all("SELECT id, entity_id, entity, entity_nif, role, board, begin_date, end_date, source_url FROM mandates WHERE holder_id = ? ORDER BY COALESCE(end_date,'9999') DESC, begin_date DESC", id);
    if (!mandates.length) return { error: "Titular não encontrado" };
    const h = one("SELECT * FROM holders WHERE holder_id = ?", id) || {};
    const declarations = all("SELECT id, entity, board, role, nature, state, year, start_date, end_date, delivery_date, detail_at, n_interests FROM declarations WHERE holder_id = ? ORDER BY delivery_date DESC", id);
    const interests = all(`SELECT i.id, i.declaration_id, i.section, i.role, i.company, i.company_nif, i.nature, i.start_date, i.end_date,
        d.year, d.nature decl_nature, d.role decl_role, d.entity decl_entity,
        l.n_contracts, l.total, l.first_signed, l.last_signed, l.n_in_period, l.total_in_period, l.n_with_own_entity, l.total_with_own_entity
      FROM interests i JOIN declarations d ON d.id = i.declaration_id LEFT JOIN links l ON l.interest_id = i.id
      WHERE i.holder_id = ? ORDER BY d.delivery_date DESC, i.section, i.id`, id);
    // collapse the same line repeated across successive declarations (same section/role/company/start)
    const seen = new Map();
    for (const r of interests) {
      const k = [r.section, norm(r.role), norm(r.company), r.start_date].join("|");
      const g = seen.get(k);
      if (g) g.declared_in.push(r.year); else seen.set(k, { ...r, declared_in: [r.year] });
    }
    const lines = [...seen.values()];
    const sections = {};
    for (const l of lines) (sections[l.section] ||= []).push(l);
    // companies in those lines: link to the portal's entity registry when the NIF is known
    const nifs = [...new Set(lines.map((l) => l.company_nif).filter(Boolean))];
    const ents = {};
    for (const nif of nifs) { const e = pol.prepare("SELECT id, name FROM entities WHERE nif = ?").get(nif); if (e) ents[nif] = e; }
    const appts = all("SELECT id, role, organ, ministry, start, act, source_url FROM appointments WHERE person = ?", h.name || mandates[0].holder || "").slice(0, 5);
    return { available: true, kind: "mandates", id, name: h.name || mandates[0].holder || (one("SELECT holder FROM mandates WHERE holder_id = ?", id) || {}).holder,
      mandates, declarations, sections, section_labels: SECTION, entities: ents, appointments: appts,
      holder_checked_at: h.checked_at || null, source_url: "https://entidadetransparencia.pt/consultardeclaracaopublica" };
  };

  routes["/api/responsaveis/entity"] = (q) => {
    if (!ok()) return missing;
    const nif = (q.get("nif") || "").replace(/\D/g, "");
    if (!nif) return { error: "nif em falta" };
    const t = today();
    const mandates = all(`SELECT id, entity_id, entity, role, holder_id, holder, board, begin_date, end_date, match_method FROM mandates WHERE entity_nif = ?
      ORDER BY (CASE WHEN end_date IS NULL OR end_date >= ? THEN 0 ELSE 1 END), begin_date DESC LIMIT 300`, nif, t);
    const interested = all(`SELECT i.id, i.holder_id, i.section, i.role, i.start_date, i.end_date,
        (SELECT holder FROM mandates WHERE holder_id = i.holder_id LIMIT 1) holder, (SELECT role FROM mandates WHERE holder_id = i.holder_id ORDER BY COALESCE(end_date,'9999') DESC LIMIT 1) holder_role,
        (SELECT entity FROM mandates WHERE holder_id = i.holder_id ORDER BY COALESCE(end_date,'9999') DESC LIMIT 1) holder_entity,
        d.year, d.id declaration_id, l.n_contracts, l.total, l.n_in_period, l.total_in_period, l.n_with_own_entity, l.total_with_own_entity
      FROM interests i JOIN declarations d ON d.id = i.declaration_id LEFT JOIN links l ON l.interest_id = i.id
      WHERE i.company_nif = ? ORDER BY d.delivery_date DESC LIMIT 300`, nif);
    const seen = new Map();
    for (const r of interested) { const k = [r.holder_id, r.section, norm(r.role), r.start_date].join("|"); if (!seen.has(k)) seen.set(k, r); }
    const cres = all("SELECT code, status, role, proposal_url, despacho_url, item_url FROM cresap WHERE entity_nif = ? LIMIT 50", nif);
    const nomeacoes = all("SELECT source, action, person, role, entity, date, act, source_url FROM nomeacoes WHERE entity_nif = ? ORDER BY date DESC LIMIT 100", nif);
    const cresap_results = all("SELECT code, role, outcome, candidate, date, pdf_url FROM cresap_results WHERE entity_nif = ? ORDER BY date DESC LIMIT 100", nif);
    return { available: true, nif, mandates, interested: [...seen.values()], cresap: cres, nomeacoes, cresap_results };
  };

  routes["/api/responsaveis/nomeacoes"] = (q) => {
    if (!ok()) return missing;
    const qs = norm(q.get("q") || ""), limit = Math.min(Number(q.get("limit")) || 40, 100), offset = Math.max(Number(q.get("offset")) || 0, 0);
    const action = q.get("action") || "", year = /^\d{4}$/.test(q.get("year") || "") ? q.get("year") : "";
    const rows = all("SELECT source, action, person, role, entity, entity_nif, date, act, source_url, match_method FROM nomeacoes ORDER BY date DESC")
      .filter((r) => (!qs || norm(`${r.person} ${r.role} ${r.entity || ""}`).includes(qs)) && (!action || r.action === action) && (!year || (r.date || "").startsWith(year)));
    const years = [...new Set(all("SELECT substr(date,1,4) y FROM nomeacoes WHERE date IS NOT NULL").map((r) => r.y))].sort().reverse();
    const cres = all("SELECT code, role, entity, entity_nif, outcome, candidate, date, pdf_url FROM cresap_results ORDER BY date DESC");
    return { available: true, years, total: rows.length, results: rows.slice(offset, offset + limit), cresap_total: cres.length, cresap_results: cres.slice(0, limit),
      note: "Atos da série I do Diário da República (resoluções do Conselho de Ministros e decretos do Presidente da República) e propostas de designação da CReSAP. Ligação à entidade apenas por nome exato; a CReSAP propõe três candidatos, a designação final é do Governo." };
  };

  routes["/api/responsaveis/links"] = (q) => {
    if (!ok()) return missing;
    const qs = norm(q.get("q") || ""), limit = Math.min(Number(q.get("limit")) || 40, 100), offset = Math.max(Number(q.get("offset")) || 0, 0);
    const all_ = q.get("all") === "1"; // default: only commercial-company stakes/roles in non-public entities, alphabetical
    const rows = all(`SELECT l.interest_id, l.holder_id, l.company_nif, l.n_contracts, l.total, l.first_signed, l.last_signed, l.n_in_period, l.total_in_period,
        l.n_with_own_entity, l.total_with_own_entity, l.is_public, i.section, i.role, i.company, i.start_date, i.end_date,
        (SELECT holder FROM mandates WHERE holder_id = l.holder_id LIMIT 1) holder,
        (SELECT role || ' — ' || entity FROM mandates WHERE holder_id = l.holder_id ORDER BY COALESCE(end_date,'9999') DESC LIMIT 1) office,
        (SELECT MAX(d.delivery_date) FROM declarations d WHERE d.id = i.declaration_id) declared_on
      FROM links l JOIN interests i ON i.id = l.interest_id ${all_ ? "" : "WHERE l.is_public = 0 AND i.section = 'sociedade'"}
      ORDER BY holder COLLATE NOCASE, i.company COLLATE NOCASE`);
    // a company declared in several declarations of the same holder counts once
    const seen = new Set(), res = [];
    for (const r of rows) {
      const k = r.holder_id + "|" + r.company_nif + "|" + r.section;
      if (seen.has(k)) continue; seen.add(k);
      if (qs && !norm(`${r.holder} ${r.company} ${r.office}`).includes(qs)) continue;
      res.push(r);
    }
    const ents = {};
    for (const r of res.slice(offset, offset + limit)) { if (!ents[r.company_nif]) { const e = pol.prepare("SELECT id, name FROM entities WHERE nif = ?").get(r.company_nif); if (e) ents[r.company_nif] = e; } }
    return { available: true, total: res.length, results: res.slice(offset, offset + limit), entities: ents,
      note: "Ligação declarada: o titular indicou, no registo de interesses oficial, uma atividade, cargo ou participação nesta sociedade; a sociedade consta como adjudicatária no Portal BASE. Não indica irregularidade nem relação causal." };
  };
}
