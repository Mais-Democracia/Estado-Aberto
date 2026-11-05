// Módulo "ministerios": /api/ministerios/*  (dados em data/ministerios.db, produzidos por ingest/jobs/ministerios.py)
export default function register({ db, all, one, num, routes, openData }) {
  const mine = openData("ministerios");
  const q = (sql, ...p) => (mine ? mine.prepare(sql).all(...p) : []);
  const q1 = (sql, ...p) => (mine ? mine.prepare(sql).get(...p) : undefined);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };

  // resolve entity ids (by NIF) in the main registry; ids may change if politica.db is rebuilt
  const eidByNif = (nifs) => {
    const out = {};
    for (const n of new Set(nifs.filter(Boolean))) { const r = safe(() => one("SELECT id FROM entities WHERE nif = ?", n)); if (r) out[n] = r.id; }
    return out;
  };

  routes["/api/ministerios/list"] = () => {
    if (!mine) return { ministries: [], error: "data/ministerios.db não existe; corra: python3 ingest/run_all.py ministerios" };
    const ms = q("SELECT * FROM ministries ORDER BY ord");
    const out = ms.map((m) => {
      const sp = q1("SELECT SUM(value) v, SUM(n) n, SUM(direct_value) dv FROM spend_year WHERE ministry = ?", m.slug) || {};
      return {
        slug: m.slug, name: m.name, short: m.short, minister: m.minister, minister_role: m.minister_role, since: m.minister_since,
        n_bodies: q1("SELECT COUNT(*) n FROM bodies WHERE ministry = ?", m.slug).n,
        n_secretaries: q1("SELECT COUNT(*) n FROM people WHERE ministry = ? AND kind = 'secretario_estado'", m.slug).n,
        n_decisions: q1("SELECT COUNT(*) n FROM decisions WHERE ministry = ?", m.slug).n,
        spend: sp.v || 0, contracts: sp.n || 0, direct_share: sp.v ? (sp.dv || 0) / sp.v : null,
      };
    });
    const meta = Object.fromEntries(q("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    const matched = q1("SELECT COUNT(DISTINCT name) n FROM bodies").n;
    return { ministries: out, meta, matched, blocked: q("SELECT * FROM blocked") };
  };

  routes["/api/ministerios/ministerio"] = (p) => {
    if (!mine) return { error: "sem dados" };
    const slug = p.get("slug");
    const m = q1("SELECT * FROM ministries WHERE slug = ?", slug);
    if (!m) return { error: "ministério não encontrado" };
    const people = q("SELECT * FROM people WHERE ministry = ? ORDER BY CASE kind WHEN 'ministro' THEN 0 WHEN 'secretario_estado' THEN 1 ELSE 2 END, id", slug);
    const bodies = q("SELECT b.*, COALESCE(s.n,0) n, COALESCE(s.value,0) value, COALESCE(s.direct_value,0) direct_value FROM bodies b LEFT JOIN spend_body s ON s.ministry = b.ministry AND s.nif = b.nif WHERE b.ministry = ? ORDER BY value DESC, b.name LIMIT 1500", slug);
    const totalBodies = q1("SELECT COUNT(*) n FROM bodies WHERE ministry = ?", slug).n;
    const sups = q("SELECT * FROM spend_sup WHERE ministry = ? ORDER BY value DESC LIMIT 15", slug);
    const topBuyers = q("SELECT * FROM spend_body WHERE ministry = ? ORDER BY value DESC LIMIT 15", slug);
    const ids = eidByNif([...bodies.map((b) => b.nif), ...sups.map((s) => s.seller_nif), ...topBuyers.map((s) => s.nif)]);
    for (const b of bodies) b.eid = (b.nif && ids[b.nif]) || null;
    for (const s of sups) s.eid = ids[s.seller_nif] || null;
    for (const s of topBuyers) s.eid = ids[s.nif] || null;
    const years = q("SELECT year, n, value, direct_n, direct_value FROM spend_year WHERE ministry = ? AND year >= 2012 ORDER BY year", slug);
    const procs = q("SELECT * FROM spend_proc WHERE ministry = ? ORDER BY value DESC LIMIT 8", slug);
    const tot = years.reduce((a, y) => ({ n: a.n + y.n, value: a.value + y.value, direct_value: a.direct_value + y.direct_value }), { n: 0, value: 0, direct_value: 0 });
    const decisions = q("SELECT cm_date, cm_title, n, text, source_url FROM decisions WHERE ministry = ? ORDER BY cm_date DESC, n LIMIT 25", slug);
    const news = q("SELECT * FROM news WHERE ministry = ? OR ministry IS NULL LIMIT 10", slug);

    // parliamentary agenda mentions (hearings etc.): minister name or "Ministr[oa] da/do <área>"
    let events = [];
    const toks = [m.minister, m.name].filter(Boolean);
    if (m.minister) {
      const like = "%" + m.minister.replace(/[%_]/g, "") + "%";
      const like2 = "%" + m.name.replace(/[%_]/g, "") + "%";
      events = safe(() => all("SELECT id, title, start, section, local, source FROM events WHERE title LIKE ? OR text LIKE ? OR title LIKE ? OR subtitle LIKE ? ORDER BY start DESC LIMIT 30", like, like, like2, like2), []);
    }
    // government initiatives (origin GOV) matched by the ministry's keywords
    let initiatives = [];
    if (m.keywords) {
      const rx = safe(() => new RegExp(m.keywords), null);
      if (rx) {
        const all_ = safe(() => all("SELECT key, kind, number, title, source FROM initiatives WHERE origin = 'GOV'"), []);
        initiatives = all_.filter((i) => rx.test(norm(i.title))).slice(0, 20).map((i) => ({
          ...i, last: safe(() => one("SELECT MAX(date) d FROM initiative_steps WHERE initiative_key = ?", i.key))?.d || null,
        }));
      }
    }
    const alt = m.divergence ? { text: m.divergence, name: m.alt_name, since: m.alt_since, source: m.alt_source } : null;
    return {
      alt,
      ministry: { slug: m.slug, name: m.name, short: m.short, minister: m.minister, minister_role: m.minister_role, since: m.minister_since, url: m.url, address: m.address },
      people, bodies, totalBodies, spend: { total: tot, years, procs, suppliers: sups, buyers: topBuyers },
      decisions, news, events, initiatives,
      blocked: q("SELECT * FROM blocked"),
      sources: [{ label: "Página oficial do ministério (portugal.gov.pt)", url: m.url }],
    };
  };

  // used by the entity-page hook: which ministry (if any) tutela this entity
  routes["/api/ministerios/entidade"] = (p) => {
    if (!mine) return { tutela: [] };
    const nif = p.get("nif");
    const name = p.get("name") || "";
    const rows = nif ? q("SELECT b.ministry, b.method, b.basis, b.source_url, b.wikidata, m.name mname, m.minister FROM bodies b JOIN ministries m ON m.slug = b.ministry WHERE b.nif = ?", nif) : [];
    const rows2 = rows.length || !name ? rows : q("SELECT b.ministry, b.method, b.basis, b.source_url, b.wikidata, m.name mname, m.minister FROM bodies b JOIN ministries m ON m.slug = b.ministry WHERE b.name = ?", name);
    return { tutela: rows2 };
  };
}
