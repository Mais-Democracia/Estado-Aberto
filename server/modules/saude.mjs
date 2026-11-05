// Saúde module: SNS institutions (ULS / IPO / hospitals / ARS / central bodies), INE hospital & health-centre series,
// the catalogue of SNS Transparency indicators (data blocked by robots.txt) and procurement joined live from politica.db.
// See docs/MODULES.md.
export default function register({ db, all, one, has, num, like, routes, openData }) {
  const mine = openData("saude");
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const missing = () => ({ available: false, note: "A base data/saude.db ainda não foi gerada (python3 ingest/run_all.py saude)." });
  const KINDS = { uls: "Unidade Local de Saúde", ipo: "Instituto Português de Oncologia", hospital: "Hospital / centro hospitalar", ars: "Administração Regional de Saúde", regional: "Serviço regional (RA)", central: "Organismo central do SNS" };
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : null; } catch { return r ? r.value : null; } };
  const DIRECT = "procedure LIKE '%diret%'";
  const hasC = () => has("contracts");

  const nifsOf = (where = "nif IS NOT NULL", ...args) => qa(`SELECT DISTINCT nif FROM institutions WHERE ${where}`, ...args).map((r) => r.nif);
  const inList = (n) => Array(n).fill("?").join(",");

  // Procurement for a set of buyer NIFs (indexed on contracts.buyer_nif).
  function procurement(nifs, { suppliers = 10, recent = 0 } = {}) {
    if (!hasC() || !nifs.length) return null;
    const ph = inList(nifs.length);
    const tot = one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph})`, ...nifs);
    if (!tot || !tot.n) return { n: 0 };
    const year = (extra = "") => all(`SELECT year, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${ph}) AND year IS NOT NULL ${extra} GROUP BY year ORDER BY year`, ...nifs);
    const cat = (prefix) => one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph}) AND cpv_code LIKE ?`, ...nifs, prefix + "%");
    const out = {
      ...tot,
      years: year(),
      categories: {
        pharma_equipment: { label: "Produtos farmacêuticos e equipamento médico (CPV 33)", ...cat("33") },
        health_services: { label: "Serviços de saúde e ação social (CPV 85)", ...cat("85") },
      },
      byProcedure: all(`SELECT procedure, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif IN (${ph}) GROUP BY procedure ORDER BY value DESC LIMIT 8`, ...nifs),
      topSuppliers: all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph}) AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers),
      topSuppliers33: all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph}) AND cpv_code LIKE '33%' AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers),
      topSuppliers85: all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph}) AND cpv_code LIKE '85%' AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers),
    };
    if (recent) out.recent = all(`SELECT id, signed, object, price, seller_name, procedure FROM contracts WHERE buyer_nif IN (${ph}) ORDER BY signed DESC LIMIT ?`, ...nifs, recent);
    // attach entity ids to suppliers for links
    for (const k of ["topSuppliers", "topSuppliers33", "topSuppliers85"]) {
      for (const s of out[k]) { const e = s.nif ? one("SELECT id, name FROM entities WHERE nif = ?", s.nif) : null; s.eid = e ? e.id : null; if (e && e.name) s.name = e.name; }
    }
    return out;
  }

  let ovCache = null;
  routes["/api/saude/overview"] = () => {
    if (!mine) return missing();
    if (ovCache && Date.now() - ovCache.t < 10 * 60e3) return ovCache.v;
    const byKind = qa("SELECT kind, COUNT(*) n, SUM(nif IS NOT NULL) matched FROM institutions GROUP BY kind ORDER BY n DESC");
    const nifs = nifsOf();
    const proc = procurement(nifs, { suppliers: 12 });
    // Spend per institution (buyer_stats is precomputed, indexed on nif)
    let topInst = [];
    if (hasC() && nifs.length) {
      topInst = all(`SELECT s.nif, s.n, s.value, s.direct_n, s.direct_value FROM buyer_stats s WHERE s.nif IN (${inList(nifs.length)}) ORDER BY s.value DESC LIMIT 15`, ...nifs)
        .map((r) => ({ ...r, ...q1("SELECT id, name, kind, region FROM institutions WHERE nif = ? LIMIT 1", r.nif) }));
    }
    const ine = (ind, geo = "PT") => {
      const rows = qa("SELECT period, value FROM ine_series WHERE indicator=? AND geo_code=? AND (dim LIKE 'Total%' OR dim='') ORDER BY period", ind, geo);
      const last = rows[rows.length - 1], prev = rows[rows.length - 2];
      return last ? { period: last.period, value: last.value, prev: prev ? { period: prev.period, value: prev.value } : null } : null;
    };
    const v = {
      available: true,
      counts: {
        institutions: q1("SELECT COUNT(*) n FROM institutions").n,
        uls: q1("SELECT COUNT(*) n FROM institutions WHERE kind='uls'").n,
        hospitals_in_uls: q1("SELECT COALESCE(SUM(n_hospitals),0) n FROM institutions").n,
        aces: q1("SELECT COALESCE(SUM(n_aces),0) n FROM institutions").n,
        centros_saude: q1("SELECT COALESCE(SUM(n_cs),0) n FROM institutions").n,
        matched: q1("SELECT COUNT(*) n FROM institutions WHERE nif IS NOT NULL").n,
        catalog: q1("SELECT COUNT(*) n FROM catalog").n,
        ine_rows: q1("SELECT COUNT(*) n FROM ine_series").n,
      },
      byKind, kindLabels: KINDS,
      national: {
        beds: ine("0012893"), admissions: ine("0008103"), emergency: ine("0008108"), consultations: ine("0008105"), hospitals: ine("0012885", "PT"), staff: ine("0012899"),
      },
      regions: qa("SELECT region, COUNT(*) n FROM institutions WHERE region IS NOT NULL GROUP BY region ORDER BY n DESC"),
      catalogTopics: qa("SELECT topic, COUNT(*) n FROM catalog GROUP BY topic ORDER BY n DESC"),
      ineIndicators: qa("SELECT indicator, MIN(indicator_name) name, MIN(family) family, MIN(unit) unit, MIN(period) first, MAX(period) last, MIN(source_url) source_url FROM ine_series GROUP BY indicator ORDER BY family, indicator"),
      procurement: proc, topInstitutions: topInst,
      matchStats: meta("match_stats"), transparencia: meta("transparencia_blocked"), builtAt: meta("built_at"),
    };
    ovCache = { t: Date.now(), v };
    return v;
  };

  routes["/api/saude/instituicoes"] = (q) => {
    if (!mine) return missing();
    const where = ["1=1"], args = [];
    const text = (q.get("q") || "").trim();
    if (text) { where.push("(i.name LIKE ? OR i.locality LIKE ? OR i.nif = ? OR i.id IN (SELECT inst_id FROM units WHERE name LIKE ?))"); args.push(like(text), like(text), text, like(text)); }
    if (q.get("regiao")) { where.push("i.region = ?"); args.push(q.get("regiao")); }
    if (q.get("kind")) { where.push("i.kind = ?"); args.push(q.get("kind")); }
    const limit = 40, page = num(q.get("page"), 1);
    const total = q1(`SELECT COUNT(*) n FROM institutions i WHERE ${where.join(" AND ")}`, ...args).n;
    const rows = qa(`SELECT i.id, i.name, i.kind, i.region, i.locality, i.website, i.nif, i.entity_id, i.n_hospitals, i.n_aces, i.n_cs, i.president, i.source_url
                     FROM institutions i WHERE ${where.join(" AND ")} ORDER BY CASE i.kind WHEN 'uls' THEN 0 WHEN 'ipo' THEN 1 WHEN 'hospital' THEN 2 WHEN 'ars' THEN 3 ELSE 4 END, i.name LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    if (hasC()) for (const r of rows) {
      const s = r.nif ? one("SELECT n, value, direct_n, direct_value FROM buyer_stats WHERE nif = ?", r.nif) : null;
      r.contracts = s ? { n: s.n, value: s.value, direct_share: s.value ? s.direct_value / s.value : null } : null;
    }
    return { available: true, total, page, limit, rows, kindLabels: KINDS, facets: { regions: qa("SELECT DISTINCT region r FROM institutions WHERE region IS NOT NULL ORDER BY r").map((x) => x.r), kinds: qa("SELECT kind, COUNT(*) n FROM institutions GROUP BY kind ORDER BY n DESC") } };
  };

  routes["/api/saude/instituicao"] = (q) => {
    if (!mine) return missing();
    let inst = null;
    if (q.get("id")) inst = q1("SELECT * FROM institutions WHERE id = ?", q.get("id"));
    if (!inst && q.get("nif")) inst = q1("SELECT * FROM institutions WHERE nif = ?", q.get("nif"));
    if (!inst && q.get("entity")) inst = q1("SELECT * FROM institutions WHERE entity_id = ?", Number(q.get("entity")));
    if (!inst) return null;
    const units = qa("SELECT kind, name, parent FROM units WHERE inst_id = ? ORDER BY CASE kind WHEN 'hospital' THEN 0 WHEN 'aces' THEN 1 ELSE 2 END, rowid", inst.id);
    const { norm, ...rest } = inst;
    return {
      available: true, institution: { ...rest, kindLabel: KINDS[inst.kind] || inst.kind }, units,
      procurement: inst.nif ? procurement([inst.nif], { suppliers: 10, recent: 10 }) : null,
      entity: inst.entity_id ? one("SELECT id, name, nif, kind FROM entities WHERE id = ?", inst.entity_id) : null,
      indicatorsNote: meta("transparencia_blocked"),
    };
  };

  // INE series (not per institution): ?indicator=ID&geo=PT|11|...  or ?inst=<institution id> (uses the ARS region name).
  routes["/api/saude/series"] = (q) => {
    if (!mine) return missing();
    const ind = q.get("indicator");
    if (!ind) return { available: true, indicators: qa("SELECT indicator, MIN(indicator_name) name, MIN(family) family, MIN(unit) unit, MIN(period) first, MAX(period) last, MIN(source_url) source_url FROM ine_series GROUP BY indicator ORDER BY family, indicator") };
    let geo = q.get("geo") || "PT";
    let region = null;
    if (q.get("inst")) {
      const i = q1("SELECT region FROM institutions WHERE id = ?", q.get("inst"));
      region = i && i.region;
      const g = region ? q1("SELECT geo_code FROM ine_series WHERE indicator = ? AND geo_name = ? AND level IN ('nuts2','area') LIMIT 1", ind, region.replace("Região Autónoma dos ", "Região Autónoma dos ")) : null;
      if (g) geo = g.geo_code;
    }
    const info = q1("SELECT indicator_name name, unit, family, source_url FROM ine_series WHERE indicator = ? LIMIT 1", ind);
    if (!info) return { available: true, rows: [], note: "Indicador desconhecido." };
    const rows = qa("SELECT period, dim, value, flag FROM ine_series WHERE indicator = ? AND geo_code = ? ORDER BY dim, period", ind, geo);
    const geos = qa("SELECT DISTINCT geo_code, geo_name, level FROM ine_series WHERE indicator = ? AND level IN ('PT','nuts2','area') ORDER BY level, geo_name", ind);
    const dims = [...new Set(rows.map((r) => r.dim))];
    return { available: true, indicator: ind, ...info, geo, region, geos, dims, rows, scope: "Agregados regionais/nacionais do INE (Inquérito aos hospitais); o INE não publica estes valores por instituição." };
  };

  routes["/api/saude/catalogo"] = (q) => {
    if (!mine) return missing();
    const where = ["1=1"], args = [];
    if (q.get("topic")) { where.push("topic = ?"); args.push(q.get("topic")); }
    if (q.get("q")) { where.push("title LIKE ?"); args.push(like(q.get("q"))); }
    return { available: true, rows: qa(`SELECT dataset_id, title, publisher, topic, frequency, license, last_update, dados_url, portal_url, formats, status, note FROM catalog WHERE ${where.join(" AND ")} ORDER BY topic, title LIMIT 200`, ...args) };
  };
}
