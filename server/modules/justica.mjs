// Justiça module: courts & councils, DGPJ/INE statistics, Tribunal Constitucional acórdãos, Tribunal de Contas reports/acórdãos,
// and the procurement of courts and Ministry-of-Justice bodies (joined live from politica.db). See docs/MODULES.md.
export default function register({ db, all, one, has, num, like, routes, openData }) {
  const mine = openData("justica");
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const missing = () => ({ available: false, note: "A base data/justica.db ainda não foi gerada (python3 ingest/run_all.py justica)." });
  const DIRECT = "procedure LIKE '%diret%'";
  const CAT = { tribunal_superior: "Tribunais superiores", tribunal_relacao: "Tribunais da Relação", tribunal_1_instancia: "1.ª instância (comarcas, juízos)", tribunal_administrativo: "Tribunais administrativos e fiscais", ministerio_publico: "Ministério Público", conselho: "Conselhos superiores", prisional: "Estabelecimentos prisionais", organismo_mj: "Polícia Judiciária e registos", outro: "Outros organismos da justiça" };
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); return r ? r.value : null; };
  const inList = (n) => Array(n).fill("?").join(",");
  const hasC = () => has("contracts");

  function procurement(nifs, { suppliers = 12, recent = 0 } = {}) {
    if (!hasC() || !nifs.length) return { n: 0 };
    const ph = inList(nifs.length);
    const tot = one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph})`, ...nifs);
    if (!tot || !tot.n) return { n: 0 };
    const out = {
      ...tot,
      years: all(`SELECT year, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${ph}) AND year IS NOT NULL GROUP BY year ORDER BY year`, ...nifs),
      byProcedure: all(`SELECT procedure, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif IN (${ph}) GROUP BY procedure ORDER BY value DESC LIMIT 8`, ...nifs),
      topSuppliers: all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${ph}) AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers),
    };
    for (const s of out.topSuppliers) { const e = s.nif ? one("SELECT id, name FROM entities WHERE nif = ?", s.nif) : null; s.eid = e ? e.id : null; if (e && e.name) s.name = e.name; }
    if (recent) out.recent = all(`SELECT id, signed, object, price, seller_name, buyer_name, procedure FROM contracts WHERE buyer_nif IN (${ph}) ORDER BY signed DESC LIMIT ?`, ...nifs, recent);
    return out;
  }
  const buyersTable = (nifs, limit = 15) => {
    if (!hasC() || !nifs.length) return [];
    const ph = inList(nifs.length);
    return all(`SELECT buyer_nif nif, MAX(buyer_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${ph}) GROUP BY buyer_nif ORDER BY value DESC LIMIT ?`, ...nifs, limit)
      .map((r) => { const e = one("SELECT id, name FROM entities WHERE nif = ?", r.nif); return { ...r, eid: e ? e.id : null, name: e ? e.name : r.name }; });
  };
  const courtNifs = () => qa("SELECT nif FROM tribunais WHERE nif IS NOT NULL AND nif NOT IN (SELECT nif FROM mj_bodies)").map((r) => r.nif);
  const mjNifs = () => qa("SELECT nif FROM mj_bodies").map((r) => r.nif);

  let ovCache = null;
  routes["/api/justica/overview"] = () => {
    if (!mine) return missing();
    if (ovCache && Date.now() - ovCache.t < 10 * 60e3) return ovCache.v;
    const ine = (ind, dim1, dim2) => qa(`SELECT period, SUM(value) value FROM stats_series WHERE indicator=? AND geo='Portugal' ${dim1 ? "AND dim1=?" : ""} ${dim2 ? "AND dim2=?" : ""} GROUP BY period ORDER BY period`, ind, ...(dim1 ? [dim1] : []), ...(dim2 ? [dim2] : []));
    const v = {
      available: true,
      built: meta("built"),
      counts: {
        orgaos: q1("SELECT COUNT(*) n FROM orgaos").n,
        tribunais: q1("SELECT COUNT(*) n FROM tribunais").n,
        acordaos_tc: q1("SELECT COUNT(*) n FROM tc_acordaos").n,
        docs_tdc: q1("SELECT COUNT(*) n FROM tcontas_docs").n,
        docs_tdc_ligados: q1("SELECT COUNT(*) n FROM tcontas_docs WHERE entity_id IS NOT NULL").n,
        series: q1("SELECT COUNT(*) n FROM stats_series").n,
      },
      tcByYear: qa("SELECT year, COUNT(*) n FROM tc_acordaos GROUP BY year ORDER BY year"),
      tdcByYear: qa("SELECT year, COUNT(*) n FROM tcontas_docs WHERE categoria='relatorio' GROUP BY year ORDER BY year"),
      tdcRecusas: qa("SELECT year, COUNT(*) n FROM tcontas_docs WHERE resultado='Recusa de visto' GROUP BY year ORDER BY year"),
      blocked: qa("SELECT source, reason FROM blocked"),
      courtsProcurement: (() => { const p = procurement(courtNifs(), { suppliers: 0 }); return { n: p.n, value: p.value, direct_value: p.direct_value, direct_n: p.direct_n }; })(),
      mjProcurement: (() => { const p = procurement(mjNifs(), { suppliers: 0 }); return { n: p.n, value: p.value, direct_value: p.direct_value, direct_n: p.direct_n }; })(),
      series: {
        entrados: ine("0000853", null, "Entrados").filter((r) => r.period >= "2000"),
        findos: ine("0000853", null, "Findos").filter((r) => r.period >= "2000"),
        pendentes: ine("0000853", null, "Pendentes em 31 de dezembro").filter((r) => r.period >= "2000"),
      },
    };
    ovCache = { t: Date.now(), v };
    return v;
  };

  // --------- tribunais: curated bodies + registry courts, with the number of INE court counts by year
  routes["/api/justica/tribunais"] = (q) => {
    if (!mine) return missing();
    const text = (q.get("q") || "").trim(), cat = q.get("cat") || "";
    const limit = 60, page = num(q.get("page"), 1);
    const orgaos = qa("SELECT o.* FROM orgaos o ORDER BY CASE category WHEN 'tribunal_superior' THEN 1 WHEN 'tribunal_relacao' THEN 2 WHEN 'conselho' THEN 3 ELSE 4 END, name")
      .filter((o) => !text || o.name.toLowerCase().includes(text.toLowerCase()))
      .map((o) => ({ ...o, eid: o.entity_id, categoria: CAT[o.category] || o.category }));
    const where = [], args = [];
    if (text) { where.push("(name LIKE ? OR comarca LIKE ? OR nif = ?)"); args.push(like(text), like(text), text); }
    if (cat) { where.push("category = ?"); args.push(cat); }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = q1(`SELECT COUNT(*) n FROM tribunais ${W}`, ...args).n;
    const rows = qa(`SELECT * FROM tribunais ${W} ORDER BY COALESCE(buyer_value,0) DESC, name LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)
      .map((r) => ({ ...r, eid: r.entity_id, categoria: CAT[r.category] || r.category }));
    const cats = qa("SELECT category, COUNT(*) n FROM tribunais GROUP BY category ORDER BY n DESC").map((r) => ({ ...r, label: CAT[r.category] || r.category }));
    const comarcas = qa("SELECT comarca, COUNT(*) n, SUM(buyer_value) value FROM tribunais WHERE comarca IS NOT NULL GROUP BY comarca ORDER BY comarca");
    return { orgaos: page === 1 ? orgaos : [], total, page, pages: Math.ceil(total / limit), rows, cats, comarcas };
  };

  // --------- statistics (INE republishing DGPJ)
  routes["/api/justica/estatisticas"] = (q) => {
    if (!mine) return missing();
    const indicators = qa("SELECT m.indicator, m.name, m.updated, m.source_url, (SELECT unit FROM stats_series s WHERE s.indicator=m.indicator LIMIT 1) unit, (SELECT COUNT(*) FROM stats_series s WHERE s.indicator=m.indicator) n FROM stats_meta m ORDER BY m.indicator");
    const ind = q.get("indicador");
    if (!ind) return { indicators };
    const m = indicators.find((i) => i.indicator === ind);
    if (!m) return { indicators, error: "indicador desconhecido" };
    const geo = q.get("tribunal") || "Portugal";   // «tribunal» = geography (comarca/distrito) when the indicator has one
    const geos = qa("SELECT geo, COUNT(*) n FROM stats_series WHERE indicator=? GROUP BY geo ORDER BY (geo='Portugal') DESC, geo", ind).map((r) => r.geo);
    const dims1 = qa("SELECT DISTINCT dim1 FROM stats_series WHERE indicator=? AND dim1 IS NOT NULL ORDER BY dim1", ind).map((r) => r.dim1);
    const dims2 = qa("SELECT DISTINCT dim2 FROM stats_series WHERE indicator=? AND dim2 IS NOT NULL ORDER BY dim2", ind).map((r) => r.dim2);
    const rows = qa("SELECT period, dim1, dim2, geo, value FROM stats_series WHERE indicator=? AND geo=? ORDER BY period, dim1, dim2 LIMIT 4000", ind, geos.includes(geo) ? geo : geos[0]);
    // ranking of geographies in the latest year (for indicators with comarca/distrito detail)
    let ranking = [];
    if (geos.length > 3) {
      const lastP = q1("SELECT MAX(period) p FROM stats_series WHERE indicator=?", ind).p;
      const d1 = q.get("dim1") || dims1.find((x) => /^Total|Cíveis/.test(x)) || dims1[0];
      ranking = qa("SELECT geo, value, period FROM stats_series WHERE indicator=? AND period=? AND geo NOT IN ('Portugal','Continente','Açores','Madeira') " + (d1 ? "AND dim1=?" : "") + " ORDER BY value DESC LIMIT 40", ind, lastP, ...(d1 ? [d1] : []));
    }
    return { indicator: m, geos, geo, dims1, dims2, rows, ranking };
  };
  // --------- Tribunal Constitucional
  routes["/api/justica/acordaos"] = (q) => {
    if (!mine) return missing();
    const where = [], args = [];
    const text = (q.get("q") || "").trim();
    if (text) {
      const m = text.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
      if (m) { const y = +m[2] < 100 ? (+m[2] < 50 ? 2000 : 1900) + +m[2] : +m[2]; where.push("(id = ? OR processo = ?)"); args.push(`${y}/${+m[1]}`, text); }
      else { where.push("(processo LIKE ? OR relator LIKE ? OR norma LIKE ? OR sumario LIKE ? OR resultado LIKE ?)"); args.push(like(text), like(text), like(text), like(text), like(text)); }
    }
    if (q.get("tipo")) { where.push("tipo = ?"); args.push(q.get("tipo")); }
    if (q.get("ano")) { where.push("year = ?"); args.push(num(q.get("ano"), 0, 0, 3000)); }
    if (q.get("resultado")) { where.push("resultado LIKE ?"); args.push(like(q.get("resultado"))); }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = 40, page = num(q.get("page"), 1);
    const total = q1(`SELECT COUNT(*) n FROM tc_acordaos ${W}`, ...args).n;
    const rows = qa(`SELECT id, year, num, processo, formacao, especie, tipo, data, relator, norma, resultado, sumario, dre_act_id, url FROM tc_acordaos ${W} ORDER BY year DESC, num DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    for (const r of rows) {
      r.sumario = r.sumario ? r.sumario.slice(0, 500) : null;
      if (r.dre_act_id && has("acts")) { /* link handled client-side via /#/lei or dre module when id known */ }
    }
    const out = { total, page, pages: Math.ceil(total / limit), rows };
    if (page === 1) {
      out.tipos = qa("SELECT tipo, COUNT(*) n FROM tc_acordaos GROUP BY tipo ORDER BY n DESC");
      out.anos = qa("SELECT year FROM tc_acordaos GROUP BY year ORDER BY year DESC").map((r) => r.year);
      out.porAno = qa("SELECT year, tipo, COUNT(*) n FROM tc_acordaos GROUP BY year, tipo ORDER BY year");
      out.resultados = qa("SELECT resultado, COUNT(*) n FROM tc_acordaos WHERE resultado IS NOT NULL GROUP BY resultado ORDER BY n DESC");
      out.resultadosAno = qa("SELECT year, resultado, COUNT(*) n FROM tc_acordaos WHERE resultado IS NOT NULL AND resultado NOT LIKE '(%' GROUP BY year, resultado ORDER BY year");
      out.dreLinked = q1("SELECT COUNT(*) n FROM tc_acordaos WHERE dre_act_id IS NOT NULL").n;
      out.detailed = q1("SELECT COUNT(*) n FROM tc_acordaos WHERE resultado IS NOT NULL").n;
    }
    return out;
  };

  // --------- Tribunal de Contas
  routes["/api/justica/auditorias"] = (q) => {
    if (!mine) return missing();
    const where = [], args = [];
    const text = (q.get("q") || "").trim();
    if (text) { where.push("(descricao LIKE ? OR titulo_ref LIKE ?)"); args.push(like(text), like(text)); }
    if (q.get("entity")) { where.push("entity_id = ?"); args.push(num(q.get("entity"), 0, 0)); }
    if (q.get("cat")) { where.push("categoria = ?"); args.push(q.get("cat")); }
    if (q.get("grupo")) { where.push("grupo = ?"); args.push(q.get("grupo")); }
    if (q.get("ano")) { where.push("year = ?"); args.push(num(q.get("ano"), 0, 0, 3000)); }
    if (q.get("resultado")) { where.push("resultado = ?"); args.push(q.get("resultado")); }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = 40, page = num(q.get("page"), 1);
    const total = q1(`SELECT COUNT(*) n FROM tcontas_docs ${W}`, ...args).n;
    const rows = qa(`SELECT id, categoria, grupo, year, titulo_ref, numero, data, publicado, descricao, tipo, resultado, entity_id, pdf_url, source_url FROM tcontas_docs ${W} ORDER BY COALESCE(data, publicado) DESC, id LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    for (const r of rows) { const e = r.entity_id ? one("SELECT name FROM entities WHERE id=?", r.entity_id) : null; r.entity_name = e ? e.name : null; }
    const out = { total, page, pages: Math.ceil(total / limit), rows };
    if (page === 1) {
      out.grupos = qa("SELECT categoria, grupo, COUNT(*) n, MIN(year) y0, MAX(year) y1 FROM tcontas_docs GROUP BY categoria, grupo ORDER BY categoria, n DESC");
      out.anos = qa("SELECT DISTINCT year FROM tcontas_docs ORDER BY year DESC").map((r) => r.year);
      out.porAno = qa("SELECT year, categoria, COUNT(*) n FROM tcontas_docs GROUP BY year, categoria ORDER BY year");
      out.vistos = qa("SELECT resultado, COUNT(*) n FROM tcontas_docs WHERE resultado IS NOT NULL GROUP BY resultado ORDER BY n DESC");
      out.ligados = q1("SELECT COUNT(*) n FROM tcontas_docs WHERE entity_id IS NOT NULL").n;
      out.topEntidades = qa("SELECT entity_id, COUNT(*) n FROM tcontas_docs WHERE entity_id IS NOT NULL GROUP BY entity_id ORDER BY n DESC LIMIT 12")
        .map((r) => ({ ...r, name: (one("SELECT name FROM entities WHERE id=?", r.entity_id) || {}).name }));
    }
    return out;
  };

  // Entity page hook: Tribunal de Contas items for one entity (matched by name in the registry)
  routes["/api/justica/entidade"] = (q) => {
    if (!mine) return { rows: [] };
    const id = num(q.get("id"), 0, 0);
    if (!id) return { rows: [] };
    const rows = qa("SELECT categoria, grupo, year, numero, titulo_ref, data, publicado, descricao, tipo, resultado, pdf_url, source_url FROM tcontas_docs WHERE entity_id=? ORDER BY COALESCE(data, publicado) DESC LIMIT 60", id);
    return { rows, method: "Associação por nome da entidade no título (aproximada)" };
  };

  // --------- procurement of courts and justice bodies
  routes["/api/justica/contratacao"] = () => {
    if (!mine) return missing();
    const cn = courtNifs(), mn = mjNifs();
    const all2 = [...new Set([...cn, ...mn])];
    const kindNifs = qa("SELECT nif FROM tribunais WHERE nif IS NOT NULL").map((r) => r.nif);   // every entity of kind tribunal_justica
    const sm = (p) => ({ n: p.n || 0, value: p.value || 0, direct_value: p.direct_value || 0, direct_n: p.direct_n || 0 });
    const resumo = {
      tribunais: { label: "Tribunais e órgãos judiciais (kind «tribunal_justica», sem organismos do MJ)", nbuyers: cn.length, ...sm(procurement(cn, { suppliers: 0 })) },
      mj: { label: "Ministério da Justiça e organismos (IRN, PJ, DGRSP, IGFEJ…)", nbuyers: mn.length, ...sm(procurement(mn, { suppliers: 0 })) },
      total: { label: "Total (união, sem dupla contagem)", nbuyers: all2.length, ...sm(procurement(all2, { suppliers: 0 })) },
      kind: { label: "Memo: todo o kind «tribunal_justica» do diretório (inclui IRN, PJ e PJ Militar)", nbuyers: kindNifs.length, ...sm(procurement(kindNifs, { suppliers: 0 })) },
      tribunaisNames: qa("SELECT name FROM tribunais WHERE nif IN (" + inList(Math.max(cn.length, 1)) + ") ORDER BY COALESCE(buyer_value,0) DESC LIMIT 6", ...(cn.length ? cn : [""])).map((r) => r.name),
      mjNames: qa("SELECT name FROM mj_bodies ORDER BY name").map((r) => r.name),
    };
    return {
      available: hasC(),
      resumo,
      tribunais: { ...procurement(cn, { suppliers: 12, recent: 10 }), buyers: buyersTable(cn, 15), nbuyers: cn.length },
      mj: { ...procurement(mn, { suppliers: 12, recent: 0 }), buyers: buyersTable(mn, 15), nbuyers: mn.length },
      total: procurement(all2, { suppliers: 0 }),
      note: "Compradores: entidades do tipo «tribunal_justica» do registo (inclui conselhos superiores, Tribunal de Contas e PGR) e organismos da tutela do Ministério da Justiça (ministerios.db).",
    };
  };
}
