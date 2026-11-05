// Diário da República (série I): search, recent publications and per-act lineage (origin -> amendments -> current form).
// Data: data/dre.db built by ingest/jobs/dre.py from diariodarepublica.pt public screen services.
const DRE = "https://diariodarepublica.pt";
const REL_LABEL = {
  altera: "altera", revoga: "revoga", republica: "republica", retifica: "retifica", regulamenta: "regulamenta", prorroga: "prorroga",
  suspende: "suspende", aprova: "aprova", autoriza: "autoriza", interpreta: "interpreta", executa: "executa",
  declara_inconstitucional: "declara inconstitucional", refere: "refere",
};
const MAIN_TYPES = ["Lei", "Lei Orgânica", "Lei Constitucional", "Decreto-Lei", "Decreto Regulamentar", "Decreto Legislativo Regional",
  "Resolução do Conselho de Ministros", "Resolução da Assembleia da República", "Portaria", "Decreto do Presidente da República", "Declaração de Retificação"];

export default function register({ db, all: coreAll, one: coreOne, has, num, routes, openData }) {
  let mine = null;
  const dre = () => (mine ||= openData("dre"));
  const all = (sql, ...p) => dre().prepare(sql).all(...p);
  const one = (sql, ...p) => dre().prepare(sql).get(...p);
  const ftsq = (s) => String(s).replace(/["*()^:+\-]/g, " ").split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
  const missing = { error: "dre.db ainda não existe — corra `python3 ingest/run_all.py dre`.", available: false };
  const LIST = "a.id, a.kind, a.number, a.date, a.title, a.issuer, a.proponent, a.summary, a.url, a.eli, a.in_window, a.vigencia, a.cons_url, a.n_amendments";
  const coreHas = (t) => { try { return has(t); } catch { return false; } };

  routes["/api/dre/meta"] = () => {
    if (!dre()) return missing;
    const m = Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    Object.assign(m, one(`SELECT (SELECT COUNT(*) FROM acts WHERE in_window = 1) acts_in_window, (SELECT COUNT(*) FROM links) links,
      (SELECT COUNT(*) FROM amendments) amendments, (SELECT COUNT(*) FROM acts WHERE cons_url IS NOT NULL) consolidated,
      (SELECT MIN(date) FROM days) window_start`));
    return {
      available: true, meta: m,
      types: all("SELECT kind, COUNT(*) n FROM acts WHERE in_window = 1 AND kind IS NOT NULL GROUP BY kind ORDER BY n DESC"),
      issuers: all("SELECT issuer, COUNT(*) n FROM acts WHERE in_window = 1 AND issuer IS NOT NULL GROUP BY issuer ORDER BY n DESC LIMIT 80"),
      years: all("SELECT year, COUNT(*) n FROM acts WHERE in_window = 1 GROUP BY year ORDER BY year DESC"),
      days: one("SELECT MIN(date) first, MAX(date) last, COUNT(*) n FROM days"),
      main_types: MAIN_TYPES,
    };
  };

  routes["/api/dre/search"] = (q) => {
    if (!dre()) return missing;
    const s = (q.get("q") || "").trim(), type = q.get("type") || "", year = q.get("year") || "", issuer = q.get("issuer") || "";
    const page = num(q.get("page"), 1, 1, 1000), limit = num(q.get("limit"), 30, 1, 100);
    const where = ["a.date IS NOT NULL"], p = [];
    if (q.get("all") !== "1") where.push("(a.in_window = 1 OR a.detail_at IS NOT NULL)");
    if (type) { where.push("a.kind = ?"); p.push(type); }
    if (year) { where.push("a.year = ?"); p.push(Number(year)); }
    if (issuer) { where.push("(a.issuer = ? OR a.proponent = ?)"); p.push(issuer, issuer); }
    // "Lei n.º 7/2009", "DL 102-D/2020", "7/2009"
    const numM = s.match(/(\d+(?:-[a-z])?\/\d{4}(?:\/[a-z0-9]+)?)/i);
    let from = "acts a";
    if (s && numM && s.replace(numM[0], "").replace(/lei|decreto-lei|dl|portaria|n\.?º|n\.?o|resolu\S*|[\s.]/gi, "") === "") {
      where.push("UPPER(a.number) = UPPER(?)"); p.push(numM[1]);
      if (/^\s*(dl|decreto-lei)/i.test(s)) where.push("a.kind = 'Decreto-Lei'");
      else if (/^\s*lei\b/i.test(s)) where.push("a.kind LIKE 'Lei%'");
      else if (/^\s*portaria/i.test(s)) where.push("a.kind = 'Portaria'");
    } else if (s) {
      const f = ftsq(s);
      if (f) { from = "acts_fts JOIN acts a ON a.rowid = acts_fts.rowid"; where.push("acts_fts MATCH ?"); p.push(f); }
    }
    const w = where.join(" AND ");
    const total = one(`SELECT COUNT(*) n FROM ${from} WHERE ${w}`, ...p).n;
    const rows = all(`SELECT ${LIST} FROM ${from} WHERE ${w} ORDER BY a.date DESC, a.id DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
    return { total, page, limit, rows };
  };

  routes["/api/dre/recent"] = (q) => {
    if (!dre()) return missing;
    const type = q.get("type") || "", issuer = q.get("issuer") || "", ndays = num(q.get("days"), 6, 1, 30);
    const where = ["in_window = 1"], p = [];
    if (type) { where.push("kind = ?"); p.push(type); }
    if (issuer) { where.push("(issuer = ? OR proponent = ?)"); p.push(issuer, issuer); }
    const dates = all(`SELECT DISTINCT date FROM acts WHERE ${where.join(" AND ")} ORDER BY date DESC LIMIT ?`, ...p, ndays).map((r) => r.date);
    if (!dates.length) return { days: [] };
    const rows = all(`SELECT id, kind, number, date, title, issuer, proponent, summary, url, dr_title, dr_url FROM acts
                      WHERE ${where.join(" AND ")} AND date >= ? ORDER BY date DESC, id`, ...p, dates[dates.length - 1]);
    const outRel = all(`SELECT l.src_id, l.relation, l.dst_id, l.dst_label FROM links l WHERE l.origin = 'sumario' AND l.src_id IN (${rows.map(() => "?").join(",") || "''"})`, ...rows.map((r) => r.id));
    const byId = Object.groupBy ? Object.groupBy(outRel, (r) => r.src_id) : outRel.reduce((a, r) => ((a[r.src_id] ||= []).push(r), a), {});
    return { days: dates.map((d) => ({ date: d, acts: rows.filter((r) => r.date === d).map((r) => ({ ...r, relations: byId[r.id] || [] })) })) };
  };

  routes["/api/dre/act"] = (q) => {
    if (!dre()) return missing;
    const id = String(q.get("id") || "").replace(/\D/g, "");
    const a = one("SELECT * FROM acts WHERE id = ?", id);
    if (!a) return null;
    const text = a.text || "";
    delete a.text; delete a.summary_html;
    a.signatories = a.signatories ? JSON.parse(a.signatories) : [];
    a.text_excerpt = text.slice(0, 2500);
    a.text_length = text.length;

    // what this act does to other acts (sumário links + official consolidation records)
    const out = all(`SELECT l.dst_id id, l.relation, l.dst_label label, l.origin, t.kind, t.number, t.date, t.title, t.summary, t.url
                     FROM links l LEFT JOIN acts t ON t.id = l.dst_id WHERE l.src_id = ? ORDER BY t.date`, id);
    const outOfficial = all(`SELECT m.target_id id, m.n_changes, m.changes_json, t.kind, t.number, t.date, t.title, t.url, m.source_url
                             FROM amendments m LEFT JOIN acts t ON t.id = m.target_id WHERE m.amending_id = ? AND m.target_id != ?`, id, id);
    const affects = new Map();
    for (const r of out) affects.set(r.id, { ...r, relations: [r.relation], changes: [] });
    for (const r of outOfficial) {
      const e = affects.get(r.id) || { ...r, relations: ["altera"], origin: "consolidacao" };
      e.changes = JSON.parse(r.changes_json || "[]"); e.consolidated_source = r.source_url; e.official = true;
      affects.set(r.id, e);
    }
    for (const e of affects.values()) { delete e.changes_json; delete e.relation; }

    // what happened to this act afterwards: official consolidated timeline + sumário links + rectifications
    const events = new Map();
    for (const m of all(`SELECT m.*, s.issuer, s.government, s.legislature, s.proponent FROM amendments m LEFT JOIN acts s ON s.id = m.amending_id
                         WHERE m.target_id = ? ORDER BY m.date`, id)) {
      if (m.amending_id === id) continue;
      events.set(m.amending_id, { id: m.amending_id, kind: m.amending_kind, number: m.amending_number, title: (m.amending_title || "").replace(/\s*-\s*\d\.ª Série$/, ""),
        date: m.date, summary: m.summary, url: m.url, relations: [], changes: JSON.parse(m.changes_json || "[]"), official: true,
        issuer: m.issuer, government: m.government, legislature: m.legislature, proponent: m.proponent, source_url: m.source_url });
    }
    for (const l of all(`SELECT l.src_id, l.relation, l.origin, s.kind, s.number, s.title, s.date, s.summary, s.url, s.issuer, s.government, s.legislature, s.proponent
                         FROM links l JOIN acts s ON s.id = l.src_id WHERE l.dst_id = ? AND l.src_id != ?`, id, id)) {
      const e = events.get(l.src_id) || { id: l.src_id, kind: l.kind, number: l.number, title: l.title, date: l.date, summary: l.summary, url: l.url,
        relations: [], changes: [], official: false, issuer: l.issuer, government: l.government, legislature: l.legislature, proponent: l.proponent, source_url: l.url };
      if (!e.relations.includes(l.relation)) e.relations.push(l.relation);
      events.set(l.src_id, e);
    }
    const later = [...events.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
    for (const e of later) if (!e.relations.length) e.relations.push(e.kind === "Declaração de Retificação" ? "retifica" : "altera");
    const consDate = (a.cons_eli || "").match(/\/cons\/(\d{4})(\d{2})(\d{2})\//);
    const consolidatedAsOf = consDate ? `${consDate[1]}-${consDate[2]}-${consDate[3]}` : null;
    for (const e of later) e.pending_consolidation = !!(a.cons_url && consolidatedAsOf && !e.official && e.date > consolidatedAsOf && /altera|republica|revoga/.test(e.relations.join()));

    const revokedBy = later.filter((e) => e.relations.includes("revoga"));
    const unconst = later.filter((e) => e.relations.includes("declara_inconstitucional"));
    const status = {
      vigencia: a.vigencia, // VIGENTE / NÃO VIGENTE (as reported by DRE)
      revoked_by: revokedBy.map((e) => ({ id: e.id, title: e.title, date: e.date })),
      unconstitutional_by: unconst.map((e) => ({ id: e.id, title: e.title, date: e.date })),
      n_changes: later.filter((e) => e.relations.some((r) => ["altera", "republica", "revoga", "retifica", "suspende", "prorroga"].includes(r))).length,
      consolidated: a.cons_url ? { url: a.cons_url, eli: a.cons_eli, as_of: consolidatedAsOf } : null,
    };

    // parliament initiative (politica.db) + votes when available
    let initiatives = [];
    const links = all("SELECT initiative_key, method, score, evidence FROM act_initiatives WHERE act_id = ?", id);
    for (const l of links) {
      const ini = coreHas("initiatives") ? coreOne("SELECT * FROM initiatives WHERE key = ?", l.initiative_key) : null;
      const votes = coreHas("votes") ? coreAll("SELECT date, result, favor, against, abstention FROM votes WHERE initiative_key = ? ORDER BY date", l.initiative_key) : [];
      const steps = coreHas("initiative_steps") ? coreAll("SELECT date, phase, body, detail FROM initiative_steps WHERE initiative_key = ? ORDER BY date", l.initiative_key) : [];
      initiatives.push({ ...l, initiative: ini, votes, steps });
    }
    const rects = all("SELECT rect_id id, label, url FROM rectifications WHERE act_id = ?", id);
    return {
      act: a, status, affects: [...affects.values()], later, rectifications: rects, initiatives,
      links: {
        dre: a.url, eli: a.eli, pdf: a.pdf_url, diario: a.dr_url, consolidated: a.cons_url, consolidated_eli: a.cons_eli,
        parliament_tab: a.has_parliament && a.url ? a.url.replace("/dr/detalhe/", "/dr/parlamento/") : null,
      },
    };
  };

  routes["/api/dre/issuers"] = () => (dre() ? all(`SELECT issuer, COUNT(*) n, MAX(date) last FROM acts WHERE in_window = 1 AND issuer IS NOT NULL GROUP BY issuer ORDER BY n DESC`) : missing);
}
