// Autarquias module: who governs each município/freguesia (MAI election results 2017-2025, mayors, heads of list)
// and how it spends (DGAL executed budget 2020+, DGAL debt 2014+). Data: data/autarquias.db (ingest/jobs/autarquias.py).
export default function register({ one, routes, openData }) {
  const mine = openData("autarquias");
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const missing = () => ({ available: false, note: "A base data/autarquias.db ainda não foi gerada (python3 ingest/run_all.py autarquias)." });
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const muniKey = (s) => norm(s).replace(/^(municipio|camara municipal)( (de|da|do|das|dos))? /, "");
  const fregKey = (name, mun) => norm(name).replace(/^(junta de freguesia|freguesia)( (de|da|do|das|dos))? /, "").replace(/^uniao das freguesias (de|da|do|das|dos) /, "uf ") + "|" + muniKey(mun);
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : null; } catch { return r ? r.value : null; } };

  let nameIdx = null;
  const byName = (name) => {
    if (!nameIdx) { nameIdx = new Map(); for (const r of qa("SELECT dico, name FROM municipios")) { const k = muniKey(r.name); nameIdx.set(k, nameIdx.has(k) ? null : r.dico); } }
    return nameIdx.get(muniKey(name)) || null;
  };
  function findMunicipio(e) {
    if (!e) return null;
    let r = e.nif ? q1("SELECT dico FROM municipios WHERE nif = ? OR entity_nif = ?", e.nif, e.nif) : null;
    if (!r && e.wikidata) r = q1("SELECT dico FROM municipios WHERE wikidata = ?", e.wikidata);
    if (!r && !/a[cç]ores|s[aã]o jorge|s[aã]o miguel/i.test(e.name || "")) { const d = byName(e.name); if (d) r = { dico: d }; }
    return r ? r.dico : null;
  }

  function elections(level, code) {
    const out = {};
    for (const s of qa("SELECT * FROM election_summary WHERE level=? AND code=? ORDER BY year DESC", level, String(code))) {
      (out[s.year] ||= {})[s.organ] = { ...s, results: qa("SELECT party, party_type, list_name, votes, pct, mandates, president FROM election_results WHERE level=? AND code=? AND year=? AND organ=? ORDER BY votes DESC", level, String(code), s.year, s.organ) };
    }
    return out;
  }

  let peerCache = null;
  function peers() {
    if (peerCache) return peerCache;
    const med = (col) => { const v = qa(`SELECT ${col} v FROM metrics WHERE ${col} IS NOT NULL ORDER BY ${col}`).map((r) => r.v); return v.length ? v[Math.floor(v.length / 2)] : null; };
    peerCache = { n: q1("SELECT COUNT(*) n FROM metrics WHERE expense_pc IS NOT NULL").n,
      median: { expense_pc: med("expense_pc"), debt_pc: med("debt_pc"), personnel_pct: med("personnel_pct"), invest_pct: med("invest_pct"), own_revenue_pct: med("own_revenue_pct"), debt_pct_limit: med("debt_pct_limit") } };
    return peerCache;
  }

  function municipio(dico) {
    const m = q1("SELECT * FROM metrics WHERE dico = ?", dico);
    if (!m) return null;
    const base = q1("SELECT * FROM municipios WHERE dico = ?", dico);
    const fin = {};
    for (const r of qa("SELECT year, kind, code, label, value, source_url FROM finance WHERE dico = ? ORDER BY year, kind, code", dico)) {
      const y = (fin[r.year] ||= { year: r.year, despesa: {}, receita: {}, source_url: {} });
      y[r.kind][r.code] = r.value; y.source_url[r.kind] = r.source_url;
    }
    const labels = {};
    for (const r of qa("SELECT DISTINCT kind, code, label FROM finance")) (labels[r.kind] ||= {})[r.code] = r.label;
    const budget = {};
    for (const r of qa("SELECT year, kind, stage, code, value FROM budget WHERE dico = ? ORDER BY year", dico)) {
      const y = (budget[r.year] ||= { year: r.year, despesa: { orcamento: 0, executado: 0, chapters: {} }, receita: { orcamento: 0, executado: 0, chapters: {} } });
      if (!(r.kind === "receita" && r.code === "16")) y[r.kind][r.stage] += r.value || 0;
      ((y[r.kind].chapters[r.code] ||= {})[r.stage] = r.value);
    }
    const budgetSrc = q1("SELECT source_url FROM budget WHERE dico=? AND stage='orcamento' ORDER BY year DESC LIMIT 1", dico);
    const cim = base.nuts3 ? q1("SELECT * FROM cim WHERE nuts3 = ? OR (nuts3 = 'AML' AND ? IN ('1A0','1B0'))", base.nuts3, base.nuts3) : null;
    const cimEnt = cim && cim.entity_nif ? one("SELECT id FROM entities WHERE nif = ?", cim.entity_nif) : null;
    const district = m.district;
    const dpeers = qa("SELECT dico, name, expense_pc, debt_pc, personnel_pct, party FROM metrics WHERE district = ? ORDER BY expense_pc DESC", district);
    return {
      metrics: m, municipio: base,
      people: {
        mayor: q1("SELECT * FROM mandates WHERE dico=? AND year=2025 AND role='presidente'", dico) || null,
        heads2025: qa("SELECT name, party, list_name, party_type, list_mandates, elected, role, source_url FROM mandates WHERE dico=? AND year=2025 ORDER BY elected DESC, list_mandates DESC, party", dico),
        mayor2021: q1("SELECT name, party, source_url FROM mandates WHERE dico=? AND year=2021 AND role='presidente'", dico) || null,
      },
      elections: elections("municipio", dico),
      finance: Object.values(fin), labels,
      debt: qa("SELECT year, debt_limit, debt_total, debt_excluded, fam, debt_for_limit, source_url FROM debt WHERE dico=? ORDER BY year", dico),
      freguesias: qa(`SELECT f.mai25_id id, f.name, f.entity_nif,
                        (SELECT party FROM election_results r WHERE r.level='freguesia' AND r.code=CAST(f.mai25_id AS TEXT) AND r.year=2025 AND r.organ='AF' ORDER BY president DESC, votes DESC LIMIT 1) party25,
                        (SELECT pct FROM election_results r WHERE r.level='freguesia' AND r.code=CAST(f.mai25_id AS TEXT) AND r.year=2025 AND r.organ='AF' ORDER BY president DESC, votes DESC LIMIT 1) pct25,
                        (SELECT party FROM election_results r WHERE r.level='freguesia' AND r.code=CAST(f.mai25_id AS TEXT) AND r.year=2021 AND r.organ='AF' ORDER BY president DESC, votes DESC LIMIT 1) party21
                      FROM freguesias f WHERE f.dico = ? ORDER BY f.name`, dico),
      peers: { ...peers(), district, districtRows: dpeers },
      budget: Object.values(budget), budget_source: budgetSrc ? budgetSrc.source_url : null,
      pmp: qa("SELECT date, days, partial, source_url FROM pmp WHERE dico = ? ORDER BY date", dico),
      cim: cim ? { ...cim, entity_id: cimEnt ? cimEnt.id : null } : null,
    };
  }

  routes["/api/autarquias/municipio"] = (q) => {
    if (!mine) return missing();
    let entity = null, dico = q.get("dico");
    if (q.get("id")) {
      entity = one("SELECT id, nif, name, kind, wikidata, municipality, parent_id FROM entities WHERE id = ?", q.get("id"));
      if (!entity) return { available: true, found: false };
      if (entity.kind === "freguesia") {
        const f = (entity.nif && q1("SELECT * FROM freguesias WHERE entity_nif = ?", entity.nif)) || q1("SELECT * FROM freguesias WHERE name_key = ?", fregKey(entity.name, entity.municipality)) || null;
        if (!f) return { available: true, found: false, level: "freguesia", entity };
        const parent = q1("SELECT dico, name, nif, entity_nif FROM municipios WHERE dico = ?", f.dico);
        const pm = q1("SELECT mayor, party, list_name FROM metrics WHERE dico = ?", f.dico);
        return { available: true, found: true, level: "freguesia", entity, freguesia: f, parent: { ...parent, ...pm }, elections: elections("freguesia", f.mai25_id) };
      }
      if (entity.kind !== "municipio") return { available: true, found: false, entity };
      dico = findMunicipio(entity);
    } else if (q.get("nif")) dico = (q1("SELECT dico FROM municipios WHERE nif = ?1 OR entity_nif = ?1", q.get("nif")) || {}).dico;
    if (!dico) return { available: true, found: false, entity };
    const d = municipio(dico);
    return d ? { available: true, found: true, level: "municipio", entity, ...d, updated: meta("updated") } : { available: true, found: false, entity };
  };

  const SORTS = new Set(["name", "district", "population", "party", "winner_pct", "turnout_2025", "expense", "expense_pc", "personnel_pct", "invest_pct",
    "own_revenue_pct", "debt", "debt_pc", "debt_pct_limit", "balance", "changed_2025", "pmp_days", "budget_exec_pct"]);
  routes["/api/autarquias/list"] = (q) => {
    if (!mine) return missing();
    const where = ["1=1"], args = [];
    if (q.get("district")) { where.push("m.district = ?"); args.push(q.get("district")); }
    if (q.get("party")) { where.push("m.party = ?"); args.push(q.get("party")); }
    const FAM = ["PPD/PSD", "PS", "PCP-PEV", "CDS-PP", "CH", "IL", "B.E.", "L", "PAN", "JPP", "PPM", "MPT"];
    if (q.get("family") === "Grupos de cidadãos / outros") where.push(`(m.party_family IS NULL OR m.party_family NOT IN (${FAM.map(() => "?").join(",")}))`), args.push(...FAM);
    else if (q.get("family")) { where.push("m.party_family = ?"); args.push(q.get("family")); }
    if (q.get("q")) { where.push("m.name LIKE ?"); args.push(`%${q.get("q").replace(/[%_]/g, "")}%`); }
    const sort = SORTS.has(q.get("sort")) ? q.get("sort") : "expense_pc", dir = q.get("dir") === "asc" ? "ASC" : "DESC";
    const rows = qa(`SELECT m.* FROM metrics m WHERE ${where.join(" AND ")} ORDER BY m.${sort} IS NULL, m.${sort} ${dir}, m.name LIMIT 400`, ...args);
    // resolve entity ids (politica.db) so the table can link to entity pages
    for (const r of rows) {
      const e = (r.entity_nif && one("SELECT id FROM entities WHERE nif = ?", r.entity_nif)) || (r.nif && one("SELECT id FROM entities WHERE nif = ?", r.nif)) || null;
      r.entity_id = e ? e.id : null;
    }
    return {
      available: true, rows, sort, dir: dir.toLowerCase(), peers: peers(),
      districts: qa("SELECT DISTINCT district FROM metrics WHERE district IS NOT NULL ORDER BY district").map((r) => r.district),
      parties: qa("SELECT party, COUNT(*) n FROM metrics WHERE party IS NOT NULL GROUP BY party ORDER BY n DESC"),
      fin_year: q1("SELECT MAX(fin_year) y FROM metrics").y, debt_year: q1("SELECT MAX(debt_year) y FROM metrics").y,
      updated: meta("updated"), match: meta("entity_match"),
    };
  };

  routes["/api/autarquias/partidos"] = () => {
    if (!mine) return missing();
    const by = (y) => qa(`SELECT party, COUNT(*) n FROM (SELECT code, party FROM election_results WHERE level='municipio' AND organ='CM' AND year=? AND president=1) GROUP BY party ORDER BY n DESC`, y);
    return { available: true, 2025: by(2025), 2021: by(2021), 2017: by(2017),
      freguesias2025: qa("SELECT party, COUNT(*) n FROM election_results WHERE level='freguesia' AND organ='AF' AND year=2025 AND president=1 GROUP BY party ORDER BY n DESC LIMIT 25") };
  };

  routes["/api/autarquias/cim"] = (q) => {
    if (!mine) return missing();
    const e = q.get("id") ? one("SELECT id, nif, name, kind FROM entities WHERE id = ?", q.get("id")) : null;
    const c = e && e.nif ? q1("SELECT * FROM cim WHERE entity_nif = ?", e.nif) : q.get("nuts3") ? q1("SELECT * FROM cim WHERE nuts3 = ?", q.get("nuts3")) : null;
    if (!c) return { available: true, found: false };
    const codes = c.nuts3 === "AML" ? ["1A0", "1B0"] : [c.nuts3, c.nuts3];
    const members = qa(`SELECT m.dico, m.name, m.population, m.party, m.expense, m.expense_pc, m.debt, m.debt_pc, m.personnel_pct, m.entity_nif
                        FROM metrics m JOIN municipios u ON u.dico = m.dico WHERE u.nuts3 IN (?, ?) ORDER BY m.population DESC`, ...codes);
    for (const r of members) { const x = r.entity_nif && one("SELECT id FROM entities WHERE nif = ?", r.entity_nif); r.entity_id = x ? x.id : null; }
    return { available: true, found: true, cim: c, members };
  };

  routes["/api/autarquias/por-partido"] = () => {
    if (!mine) return missing();
    const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
    const groups = {};
    for (const r of qa("SELECT party_family, expense_pc, personnel_pct, invest_pct, debt_pc, own_revenue_pct, pmp_days, population FROM metrics")) {
      const k = /^[A-Z.\/-]+$/.test(r.party_family || "") && ["PPD/PSD", "PS", "PCP-PEV", "CDS-PP", "CH", "IL", "B.E.", "L", "PAN", "JPP", "PPM", "MPT"].includes(r.party_family) ? r.party_family : "Grupos de cidadãos / outros";
      (groups[k] ||= []).push(r);
    }
    const rows = Object.entries(groups).map(([party, a]) => ({ party, n: a.length, population: a.reduce((t, r) => t + (r.population || 0), 0),
      expense_pc: med(a.map((r) => r.expense_pc)), personnel_pct: med(a.map((r) => r.personnel_pct)), invest_pct: med(a.map((r) => r.invest_pct)),
      debt_pc: med(a.map((r) => r.debt_pc)), own_revenue_pct: med(a.map((r) => r.own_revenue_pct)), pmp_days: med(a.map((r) => r.pmp_days)) })).sort((a, b) => b.n - a.n);
    return { available: true, rows, fin_year: q1("SELECT MAX(fin_year) y FROM metrics").y };
  };

  routes["/api/autarquias/meta"] = () => {
    if (!mine) return missing();
    const c = (t) => q1(`SELECT COUNT(*) n FROM ${t}`).n;
    return { available: true, updated: meta("updated"), entity_match: meta("entity_match"), freguesia_match: meta("freguesia_match"),
      counts: { municipios: c("municipios"), freguesias: c("freguesias"), election_results: c("election_results"), mandates: c("mandates"), finance: c("finance"), debt: c("debt"), budget: c("budget"), pmp: c("pmp"), cim: c("cim") },
      finance_years: qa("SELECT DISTINCT year FROM finance ORDER BY year").map((r) => r.year), debt_years: qa("SELECT DISTINCT year FROM debt ORDER BY year").map((r) => r.year) };
  };
}
