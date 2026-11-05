// Módulo "estado_empresas": emprego público (DGAEP/SIOE) + Sector Empresarial do Estado e participações (ETF).
// Dados: data/estado_empresas.db (ingest/jobs/estado_empresas.py). Rotas: /api/estado/overview, /emprego, /empresas, /empresa.
export default function register({ db, all, one, has, num, routes, openData }) {
  const mine = openData("estado_empresas");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const missing = () => ({ available: false, note: "A base data/estado_empresas.db ainda não foi gerada (python3 ingest/run_all.py estado_empresas)." });
  const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const latest = (t, col = "ref_date") => q1(`SELECT MAX(${col}) d FROM ${t}`)?.d;
  const minusYear = (d, n = 1) => `${+d.slice(0, 4) - n}${d.slice(4)}`;

  // ids do registo mudam quando politica.db é reconstruído: resolve-se sempre pelo NIF no momento do pedido
  const entityByNif = (nif) => (nif && has("entities") ? safe(() => one("SELECT id, name, kind, level, buyer_contracts, buyer_value, seller_contracts, seller_value, website FROM entities WHERE nif = ?", nif)) : null);

  routes["/api/estado/overview"] = () => {
    if (!mine) return missing();
    const total = qa("SELECT ref_date, year, employed_total, public_workers, note, source_url FROM wf_total ORDER BY ref_date");
    const last = total[total.length - 1];
    const prevY = total.find((r) => r.ref_date === minusYear(last.ref_date)) || null;
    const pay = qa("SELECT ref_date, year, base_monthly, gain_monthly, source_url FROM wf_pay ORDER BY ref_date");
    const lp = pay[pay.length - 1], pp = pay.find((r) => r.ref_date === minusYear(lp.ref_date));
    const dC = latest("wf_contract");
    const contract = qa("SELECT label, workers FROM wf_contract WHERE ref_date=? ORDER BY workers DESC", dC);
    const contractPrev = Object.fromEntries(qa("SELECT label, workers FROM wf_contract WHERE ref_date=?", minusYear(dC)).map((r) => [r.label, r.workers]));
    const dS = latest("wf_subsector");
    const subsector = qa("SELECT subsector_code code, subsector, SUM(workers) workers FROM wf_subsector WHERE ref_date=? GROUP BY 1,2 ORDER BY workers DESC", dS);
    const ents = Object.fromEntries(qa("SELECT subsector_code c, n_entities n, ref_date FROM wf_entities").map((r) => [r.c, r]));
    const areas = qa("SELECT area, SUM(workers) workers FROM wf_subsector WHERE ref_date=? AND subsector_code='AC' GROUP BY 1 ORDER BY workers DESC", dS);
    const dF = latest("wf_flows");
    const flows = qa("SELECT ref_date, flow, SUM(workers) workers FROM wf_flows GROUP BY 1,2 ORDER BY 1,2").filter((r) => r.ref_date >= minusYear(dF, 3));
    const flowMotives = qa("SELECT flow, motive, SUM(workers) workers FROM wf_flows WHERE ref_date=? GROUP BY 1,2 ORDER BY 1, workers DESC", dF);
    const empSee = qa("SELECT ref_date, holder, sub, workers, source_url FROM sector_emp WHERE sex='Total' AND sub='Total' ORDER BY ref_date");
    const dE = empSee.length ? empSee[empSee.length - 1].ref_date : null;
    const dirig = qa(`SELECT career, detail, base_monthly base, gain_monthly gain FROM wf_pay_career WHERE ref_date=(SELECT MAX(ref_date) FROM wf_pay_career) AND (area LIKE 'Dirigentes%') ORDER BY base_monthly DESC LIMIT 24`);
    // empresas
    const cs = q1(`SELECT COUNT(*) n, SUM(portfolio='principal') principal, SUM(portfolio='acessoria') acessoria, SUM(portfolio='liquidacao') liquidacao, SUM(portfolio='siee') siee,
      SUM(nif IS NOT NULL) matched, SUM(CASE WHEN portfolio IN ('principal','acessoria') THEN nominal ELSE 0 END) nominal, MAX(ref_date) ref FROM companies`);
    const byGrp = qa(`SELECT COALESCE(grp,'—') grp, COUNT(*) n, SUM(nominal) nominal FROM companies WHERE portfolio IN ('principal') GROUP BY 1 ORDER BY nominal DESC`);
    const seeAgg = qa("SELECT year, quarter, grp, indicator, value, restated, unit, n_companies, source_url FROM see_agg WHERE indicator IN ('volume_negocios','ebitda','resultado_liquido','endividamento','n_empresas','gastos_operacionais','cash_flow') ORDER BY year, quarter");
    const docs = safe(() => qa("SELECT kind, year, quarter, title, url FROM see_docs ORDER BY year DESC, kind, quarter DESC"), []);
    const garantias = qa("SELECT indicator, year, value, unit, source_url FROM misc_series ORDER BY year");
    return {
      available: true,
      workforce: {
        ref: last.ref_date, total, last, prevYear: prevY, pay, lastPay: lp, prevPay: pp || null,
        contract, contractPrev, contractRef: dC, subsector, subsectorRef: dS, entities: ents, areas, flows, flowMotives, flowRef: dF,
        empSee, empSeeRef: dE, dirigentes: dirig,
        maxRef: { career: latest("wf_career"), education: latest("wf_education"), pay_career: latest("wf_pay_career") },
      },
      companies: { ...cs, byGrp }, seeAgg, garantias, docs,
      built: meta("built"), sources: meta("sources"), errors: meta("errors"), blocked: meta("blocked"), match: meta("match_stats"), siee: meta("siee_list"),
    };
  };

  routes["/api/estado/emprego"] = (p) => {
    if (!mine) return missing();
    const dim = p.get("dim") || "total";
    const src = (t) => q1(`SELECT source_url u FROM ${t} LIMIT 1`)?.u;
    if (dim === "total") return { dim, rows: qa("SELECT ref_date, year, employed_total, public_workers, note FROM wf_total ORDER BY ref_date"), source_url: src("wf_total"), unit: "pessoas" };
    if (dim === "pay") return { dim, rows: qa("SELECT ref_date, year, base_monthly, gain_monthly FROM wf_pay ORDER BY ref_date"), source_url: src("wf_pay"), unit: "EUR/mês" };
    if (dim === "contract") return { dim, rows: qa("SELECT ref_date, year, label, workers FROM wf_contract ORDER BY ref_date, workers DESC"), source_url: src("wf_contract"), unit: "pessoas" };
    if (dim === "subsector") return { dim, rows: qa("SELECT ref_date, year, subsector_code code, subsector, SUM(workers) workers FROM wf_subsector GROUP BY 1,2,3,4 ORDER BY ref_date"), source_url: src("wf_subsector"), unit: "pessoas" };
    if (dim === "area") {
      const d = p.get("ref") || latest("wf_subsector");
      return { dim, ref: d, rows: qa("SELECT subsector_code code, subsector, area, workers FROM wf_subsector WHERE ref_date=? ORDER BY workers DESC", d), source_url: src("wf_subsector"), unit: "pessoas" };
    }
    if (dim === "activity") {
      const d = p.get("ref") || latest("wf_activity");
      return { dim, ref: d, rows: qa("SELECT grp, subgroup, label, cae, workers FROM wf_activity WHERE ref_date=? ORDER BY workers DESC", d), source_url: src("wf_activity"), unit: "pessoas" };
    }
    if (dim === "career") {
      const d = p.get("ref") || latest("wf_career"), dp = latest("wf_pay_career");
      const rows = qa(`SELECT area, career_code, career, detail_code, detail, SUM(workers) workers, SUM(CASE WHEN sex LIKE 'F%' THEN workers ELSE 0 END) women FROM wf_career WHERE ref_date=? GROUP BY 1,2,3,4,5 ORDER BY workers DESC`, d);
      const pay = new Map(qa("SELECT career_code, detail_code, base_monthly base, gain_monthly gain FROM wf_pay_career WHERE ref_date=?", dp).map((r) => [r.career_code + "|" + r.detail_code, r]));
      return { dim, ref: d, payRef: dp, rows: rows.map((r) => ({ ...r, ...(pay.get(r.career_code + "|" + r.detail_code) || {}) })), source_url: src("wf_career"), pay_source_url: src("wf_pay_career"), unit: "pessoas" };
    }
    if (dim === "age") {
      const d = p.get("ref") || latest("wf_career");
      const career = p.get("career");
      const rows = career
        ? qa("SELECT age_code, age, sex, SUM(workers) workers FROM wf_career WHERE ref_date=? AND career_code=? GROUP BY 1,2,3 ORDER BY age_code", d, career)
        : qa("SELECT age_code, age, sex, SUM(workers) workers FROM wf_career WHERE ref_date=? GROUP BY 1,2,3 ORDER BY age_code", d);
      return { dim, ref: d, career: career || null, rows, source_url: src("wf_career"), unit: "pessoas" };
    }
    if (dim === "sex") return { dim, rows: qa("SELECT ref_date, year, sex, SUM(workers) workers FROM wf_career GROUP BY 1,2,3 ORDER BY ref_date"), source_url: src("wf_career"), unit: "pessoas" };
    if (dim === "pay_career") {
      const d = p.get("ref") || latest("wf_pay_career");
      const career = p.get("career");
      return career
        ? { dim, career, rows: qa("SELECT ref_date, year, detail, base_monthly base, gain_monthly gain FROM wf_pay_career WHERE career_code=? AND detail_code=? ORDER BY ref_date", career, p.get("detail") || career), source_url: src("wf_pay_career"), unit: "EUR/mês" }
        : { dim, ref: d, rows: qa("SELECT area, career_code, career, detail_code, detail, base_monthly base, gain_monthly gain FROM wf_pay_career WHERE ref_date=? ORDER BY gain_monthly DESC", d), source_url: src("wf_pay_career"), unit: "EUR/mês" };
    }
    if (dim === "education") {
      const d = p.get("ref") || latest("wf_education");
      return { dim, ref: d, rows: qa("SELECT ref_date, grp, level, sex, workers FROM wf_education WHERE ref_date IN (?, ?) ORDER BY ref_date, level_code", d, minusYear(d, 5)), source_url: src("wf_education"), unit: "pessoas" };
    }
    if (dim === "disability") return { dim, rows: qa("SELECT ref_date, year, sex, workers FROM wf_disability ORDER BY ref_date"), source_url: src("wf_disability"), unit: "pessoas" };
    if (dim === "flows") return { dim, rows: qa("SELECT ref_date, year, flow, motive, SUM(workers) workers FROM wf_flows GROUP BY 1,2,3,4 ORDER BY ref_date"), source_url: src("wf_flows"), unit: "pessoas" };
    if (dim === "entities") return { dim, rows: qa("SELECT ref_date, subsector_code code, subsector, n_entities FROM wf_entities"), source_url: src("wf_entities"), unit: "entidades" };
    if (dim === "empresas_publicas") return { dim, rows: qa("SELECT ref_date, year, holder, sub, sex, workers FROM sector_emp ORDER BY ref_date"), source_url: src("sector_emp"), unit: "postos de trabalho" };
    return { error: "dim desconhecida: " + dim, dims: ["total", "pay", "contract", "subsector", "area", "activity", "career", "age", "sex", "pay_career", "education", "disability", "flows", "entities", "empresas_publicas"] };
  };

  const SORTS = { name: "c.name COLLATE NOCASE ASC", pct: "c.pct DESC NULLS LAST", nominal: "c.nominal DESC NULLS LAST", capital: "c.capital DESC NULLS LAST", contracts: "c.nominal DESC NULLS LAST" };

  routes["/api/estado/empresas"] = (p) => {
    if (!mine) return missing();
    const where = [], par = [];
    const text = (p.get("q") || "").trim();
    if (/^\d{9}$/.test(text)) { where.push("c.nif = ?"); par.push(text); }
    else if (text) for (const t of strip(text).split(" ").filter(Boolean).slice(0, 6)) { where.push("c.key LIKE ?"); par.push(`%${t}%`); }
    const sec = p.get("sector");
    if (sec) { where.push("(c.grp = ? OR c.section = ? OR c.portfolio = ?)"); par.push(sec, sec, sec); }
    if (p.get("epr") === "1") where.push("c.epr = 1");
    if (p.get("matched") === "1") where.push("c.nif IS NOT NULL");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const page = Math.max(1, num(p.get("page"), 1)), limit = 40;
    const sort = p.get("sort") || "nominal";
    const total = q1(`SELECT COUNT(*) n FROM companies c ${w}`, ...par).n;
    const rows = qa(`SELECT c.id, c.name, c.nif, c.grp, c.section, c.epr, c.portfolio, c.pct, c.nominal, c.capital, c.ref_date, c.in_siee, c.status, c.match_method, c.source_url FROM companies c ${w}
      ORDER BY CASE c.portfolio WHEN 'principal' THEN 0 WHEN 'siee' THEN 1 WHEN 'acessoria' THEN 2 ELSE 3 END, ${SORTS[sort] || SORTS.nominal} LIMIT ? OFFSET ?`, ...par, limit, (page - 1) * limit);
    for (const r of rows) {
      const e = entityByNif(r.nif);
      if (e) Object.assign(r, { entity_id: e.id, ekind: e.kind, buyer_n: e.buyer_contracts, buyer_value: e.buyer_value, seller_n: e.seller_contracts, seller_value: e.seller_value });
    }
    const sectors = qa("SELECT grp, COUNT(*) n FROM companies GROUP BY 1 ORDER BY n DESC").map((r) => ({ name: r.grp, n: r.n }));
    return { available: true, total, page, limit, rows, sectors, ref: latest("companies") };
  };

  routes["/api/estado/empresa"] = (p) => {
    if (!mine) return missing();
    let c;
    if (p.get("id")) c = q1("SELECT * FROM companies WHERE id = ?", +p.get("id"));
    else if (p.get("nif")) c = q1("SELECT * FROM companies WHERE nif = ? ORDER BY (portfolio='principal') DESC LIMIT 1", p.get("nif"));
    if (!c) return { available: true, found: false };
    const hist = qa("SELECT ref_date, pct, nominal, capital, source_url FROM company_hist WHERE company_id = ? ORDER BY ref_date", c.id);
    let entity = null, asBuyer = [], asSeller = [], byYear = [];
    if (c.nif && has("contracts")) {
      entity = entityByNif(c.nif);
      asBuyer = safe(() => all("SELECT id, year, signed, object, price, procedure, seller_name, seller_nif, link FROM contracts WHERE buyer_nif = ? ORDER BY price DESC LIMIT 15", c.nif), []);
      asSeller = safe(() => all("SELECT id, year, signed, object, price, procedure, buyer_name, buyer_nif, link FROM contracts WHERE seller_nif = ? ORDER BY price DESC LIMIT 15", c.nif), []);
      byYear = safe(() => all(`SELECT year, 'buyer' role, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif = ? GROUP BY year
        UNION ALL SELECT year, 'seller', COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE seller_nif = ? GROUP BY year ORDER BY year`, c.nif, c.nif), []);
    }
    return {
      available: true, found: true, company: c, hist, entity, asBuyer, asSeller, byYear,
      siblings: c.grp ? qa("SELECT id, name, pct, nominal FROM companies WHERE grp = ? AND section IS ? AND id != ? AND portfolio = ? ORDER BY nominal DESC NULLS LAST LIMIT 12", c.grp, c.section, c.id, c.portfolio) : [],
      aggregate: qa("SELECT year, quarter, indicator, value FROM see_agg WHERE grp='total' AND indicator IN ('volume_negocios','resultado_liquido','endividamento') AND quarter=4 ORDER BY year"),
      docs: safe(() => qa("SELECT kind, year, quarter, title, url FROM see_docs WHERE kind IN ('relatorio','situacao','bom_governo') ORDER BY year DESC, kind"), []),
      blocked: (meta("blocked") || []).filter((b) => /Financeiras por empresa|Documentos por empresa|Indemniza/.test(b.source)),
    };
  };
}
