// Módulo "seguranca": segurança interna, proteção civil e defesa.
// Dados: data/seguranca.db (INE: crimes, incêndios rurais, sinistralidade, bombeiros; órgãos; corporações do registo do portal)
// + contratação pública lida ao vivo de politica.db / ministerios.db. Ver docs/MODULES.md.
export default function register({ db, all, one, has, routes, openData }) {
  const mine = openData("seguranca");
  const mini = openData("ministerios");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const missing = () => ({ available: false, note: "A base data/seguranca.db ainda não foi gerada (python3 ingest/run_all.py seguranca)." });
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const DIRECT = "procedure LIKE '%diret%'";
  const ph = (n) => Array(n).fill("?").join(",");
  const hasC = () => has("contracts");

  // Séries expostas. ids: indicadores INE por ordem de preferência (o mais recente primeiro; anos em falta
  // são preenchidos pela série anterior, que usa outra versão da NUTS mas a mesma definição).
  const SERIES = {
    crime: { label: "Crimes registados pelas polícias", unit: "n.º", ids: ["0012261", "0008073"], dim: "Total", src: "DGPJ/SGSI via INE" },
    crime_taxa: { label: "Taxa de criminalidade", unit: "‰", ids: ["0012260", "0008074"], dim: "Total", src: "DGPJ/SGSI via INE" },
    homicidios: { label: "Homicídios voluntários consumados", unit: "n.º", ids: ["0010714"], dim: "", src: "DGPJ via INE" },
    incendios: { label: "Incêndios rurais", unit: "n.º", ids: ["0013509"], dim: "", src: "ICNF via INE" },
    area_ardida: { label: "Superfície ardida", unit: "ha", ids: ["0013510"], dim: "Total", src: "ICNF via INE" },
    area_ardida_pct: { label: "Superfície ardida (% do território)", unit: "%", ids: ["0013538"], dim: "Total", src: "ICNF via INE" },
    acidentes: { label: "Acidentes de viação com vítimas", unit: "n.º", ids: ["0012774", "0008639"], dim: "Total de acidentes / Total", src: "ANSR via INE" },
    acidentes_mortais: { label: "Acidentes com vítimas mortais", unit: "n.º", ids: ["0012774"], dim: "Acidentes de viação com vítimas mortais / Total", src: "ANSR via INE" },
    mortos: { label: "Mortos em acidentes de viação", unit: "n.º", ids: ["0012775", "0008640"], dim: "Mortos", src: "ANSR via INE" },
    feridos_graves: { label: "Feridos graves em acidentes de viação", unit: "n.º", ids: ["0012775", "0008640"], dim: "Feridos graves", src: "ANSR via INE" },
    bombeiros_corpos: { label: "Corpos de bombeiros", unit: "n.º", ids: ["0013372"], dim: "", src: "ANEPC via INE" },
    bombeiros_pessoal: { label: "Bombeiros (pessoal)", unit: "n.º", ids: ["0013371"], dim: "", src: "ANEPC via INE" },
    bombeiros_servicos: { label: "Serviços prestados pelos bombeiros", unit: "n.º", ids: ["0013370"], dim: "Total", src: "ANEPC via INE" },
  };

  // Procura o valor de um dim por correspondência exata; para indicadores cujo dim "Total" tem prefixos, aceita sufixo.
  function pts(key, where, args) {
    const s = SERIES[key];
    const byYear = new Map();
    for (const id of s.ids) {
      const rows = qa(`SELECT year, value, flag, dim FROM ine_series WHERE indicator=? AND ${where} ORDER BY year`, id, ...args);
      const pick = rows.filter((r) => r.dim === s.dim || (s.dim && r.dim.endsWith(" / " + s.dim) && r.dim === s.dim));
      for (const r of pick) if (!byYear.has(r.year)) byYear.set(r.year, { year: r.year, value: r.value, flag: r.flag, ind: id });
    }
    return [...byYear.values()].sort((a, b) => a.year - b.year);
  }
  const seriesAt = (key, geo) => pts(key, "geo_code = ?", [geo]);
  const seriesDico = (key, dico) => pts(key, "level='concelho' AND dico = ?", [dico]);
  const last = (a) => (a.length ? a[a.length - 1] : null);

  const metaAll = () => Object.fromEntries(qa("SELECT key, value FROM meta").map((r) => [r.key, r.value]));

  // ---------------------------------------------------------------- contratação
  function eids(nifs) {
    const out = {};
    for (const n of new Set(nifs.filter(Boolean))) { const r = safe(() => one("SELECT id FROM entities WHERE nif = ?", n)); if (r) out[n] = r.id; }
    return out;
  }
  const CPV_LABEL = {
    "35": "Segurança, defesa, armamento e equipamento policial", "34": "Veículos e equipamento de transporte", "18": "Vestuário e equipamento individual",
    "33": "Equipamento e produtos médicos", "32": "Rádio, comunicações e equipamento", "30": "Equipamento informático e de escritório", "48": "Software",
    "72": "Serviços informáticos", "09": "Combustíveis e energia", "15": "Alimentação", "50": "Reparação e manutenção", "45": "Construção",
    "79": "Serviços às empresas (segurança, limpeza…)", "60": "Serviços de transporte", "63": "Serviços auxiliares de transporte", "39": "Mobiliário e equipamento doméstico",
    "38": "Equipamento de laboratório, ótico e de precisão", "31": "Equipamento elétrico", "42": "Máquinas industriais", "44": "Materiais de construção",
    "55": "Alojamento e restauração", "64": "Correios e telecomunicações", "65": "Serviços de utilidade pública", "66": "Serviços financeiros e seguros",
    "71": "Serviços de arquitetura e engenharia", "75": "Administração pública, defesa e segurança social", "80": "Educação e formação", "85": "Saúde e ação social",
    "90": "Serviços de esgotos e resíduos", "98": "Outros serviços", "03": "Produtos agrícolas", "24": "Produtos químicos", "37": "Instrumentos musicais, desporto", "92": "Serviços culturais e desportivos",
  };
  function procurement(nifs, { suppliers = 10, recent = 0, cpv = false } = {}) {
    if (!hasC() || !nifs.length) return null;
    const p = ph(nifs.length);
    const tot = one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${p})`, ...nifs);
    if (!tot || !tot.n) return { n: 0 };
    const out = {
      ...tot,
      years: all(`SELECT year, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${p}) AND year IS NOT NULL GROUP BY year ORDER BY year`, ...nifs),
      byProcedure: all(`SELECT procedure, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif IN (${p}) GROUP BY procedure ORDER BY value DESC LIMIT 8`, ...nifs),
      topSuppliers: all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${p}) AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers),
    };
    if (cpv) {
      out.cpv = all(`SELECT SUBSTR(cpv_code,1,2) div, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${p}) AND cpv_code IS NOT NULL AND cpv_code != '' GROUP BY div ORDER BY value DESC LIMIT 12`, ...nifs)
        .map((r) => ({ ...r, label: CPV_LABEL[r.div] || "CPV " + r.div }));
      out.defesa35 = all(`SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n FROM contracts WHERE buyer_nif IN (${p}) AND cpv_code LIKE '35%' AND seller_nif IS NOT NULL AND seller_nif != '' GROUP BY seller_nif ORDER BY value DESC LIMIT ?`, ...nifs, suppliers);
      out.cpv35 = one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN ${DIRECT} THEN price END),0) direct_value FROM contracts WHERE buyer_nif IN (${p}) AND cpv_code LIKE '35%'`, ...nifs);
    }
    if (recent) out.recent = all(`SELECT id, signed, object, price, seller_name, procedure FROM contracts WHERE buyer_nif IN (${p}) ORDER BY signed DESC LIMIT ?`, ...nifs, recent);
    const ids = eids([...out.topSuppliers, ...(out.defesa35 || [])].map((s) => s.nif));
    for (const k of ["topSuppliers", "defesa35"]) for (const s of out[k] || []) { s.eid = ids[s.nif] || null; }
    return out;
  }
  const stat = (nifs) => {
    if (!hasC() || !nifs.length) return {};
    const rows = all(`SELECT nif, n, value, direct_n, direct_value, first_signed, last_signed FROM buyer_stats WHERE nif IN (${ph(nifs.length)})`, ...nifs);
    return Object.fromEntries(rows.map((r) => [r.nif, r]));
  };

  const orgNifs = (grps) => qa(`SELECT nif FROM orgaos WHERE nif IS NOT NULL ${grps ? `AND grp IN (${ph(grps.length)})` : ""}`, ...(grps || [])).map((r) => r.nif);
  const bombNifs = () => qa("SELECT nif FROM bombeiros WHERE nif IS NOT NULL").map((r) => r.nif);

  // ---------------------------------------------------------------- overview
  routes["/api/seguranca/overview"] = () => {
    if (!mine) return missing();
    const m = metaAll();
    const nat = {};
    for (const k of Object.keys(SERIES)) nat[k] = { ...SERIES[k], ids: undefined, points: seriesAt(k, "PT") };
    // Diferença entre o total nacional e a soma dos territórios (mesmo indicador INE por ano)
    const crimeGap = (nat.crime.points || []).map((pt) => {
      const g = (lvl) => q1("SELECT SUM(value) v FROM ine_series WHERE indicator=? AND year=? AND dim='Total' AND level=?", pt.ind, pt.year, lvl)?.v ?? null;
      const conc = g("concelho"), areas = g("area");
      return { year: pt.year, total: pt.value, areas, concelhos: conc, gap_areas: areas == null ? null : pt.value - areas, gap_conc: conc == null ? null : pt.value - conc, pct_conc: conc == null ? null : (100 * (pt.value - conc)) / pt.value };
    });
    const armed = orgNifs(["forca_armada", "defesa"]);
    const policing = orgNifs(["forca_seguranca", "investigacao", "imigracao", "fiscalizacao", "inspecao", "coordenacao"]);
    const civil = orgNifs(["protecao_civil", "emergencia"]);
    const bomb = bombNifs();
    const allSd = hasC() ? all("SELECT nif FROM entities WHERE kind='seguranca_defesa' AND nif IS NOT NULL").map((r) => r.nif) : [];
    const groups = {
      defesa: { label: "Defesa (Forças Armadas e serviços do MDN)", nifs: armed },
      seguranca: { label: "Segurança interna, investigação e fiscalização", nifs: policing },
      protecao_civil: { label: "Proteção civil e emergência", nifs: civil },
      bombeiros: { label: "Corporações de bombeiros (no registo do portal)", nifs: bomb },
    };
    const proc = {};
    for (const [k, g] of Object.entries(groups)) {
      const p = procurement(g.nifs, { suppliers: 8, cpv: k === "defesa" || k === "seguranca" });
      proc[k] = { label: g.label, n_entities: g.nifs.length, ...(p || { n: 0 }) };
    }
    const sd = procurement(allSd, { suppliers: 12, cpv: true });
    const spendMin = mini ? ["defesa-nacional", "administracao-interna"].map((slug) => ({
      slug, name: safe(() => mini.prepare("SELECT name FROM ministries WHERE slug=?").get(slug)?.name),
      years: safe(() => mini.prepare("SELECT year, n, value, direct_value FROM spend_year WHERE ministry=? AND year>=2012 ORDER BY year").all(slug), []),
    })) : [];
    const topBodies = (() => {
      const nifs = orgNifs();
      const st = stat(nifs);
      return qa("SELECT sigla, name, grp, nif FROM orgaos WHERE nif IS NOT NULL").map((o) => ({ ...o, ...(st[o.nif] || {}), eid: eids([o.nif])[o.nif] || null })).sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 12);
    })();
    return {
      available: true, meta: m, national: nat, crimeGap, procurement: proc, security_entities: { n: allSd.length, total: sd },
      ministries: spendMin, topBodies,
      counts: {
        orgaos: q1("SELECT COUNT(*) n FROM orgaos").n, bombeiros: q1("SELECT COUNT(*) n FROM bombeiros").n,
        bombeiros_assoc: q1("SELECT COUNT(*) n FROM bombeiros WHERE tipo='associacao'").n,
        bombeiros_concelho: q1("SELECT COUNT(*) n FROM bombeiros WHERE dico IS NOT NULL").n,
        ine_rows: q1("SELECT COUNT(*) n FROM ine_series").n, concelhos: q1("SELECT COUNT(DISTINCT dico) n FROM ine_series WHERE level='concelho'").n,
      },
    };
  };

  // ---------------------------------------------------------------- órgãos
  routes["/api/seguranca/orgaos"] = (p) => {
    if (!mine) return missing();
    const q = norm(p.get("q") || "");
    const grp = p.get("grp") || "";
    let rows = qa("SELECT * FROM orgaos ORDER BY name");
    if (q) rows = rows.filter((r) => norm(r.sigla + " " + r.name + " " + (r.description || "")).includes(q));
    if (grp) rows = rows.filter((r) => r.grp === grp);
    const st = stat(rows.map((r) => r.nif).filter(Boolean));
    const ids = eids(rows.map((r) => r.nif));
    const tutelas = mini ? Object.fromEntries(safe(() => mini.prepare("SELECT slug, short FROM ministries").all(), []).map((m) => [m.slug, m.short])) : {};
    const out = rows.map((r) => {
      const s = st[r.nif] || {};
      return { ...r, eid: ids[r.nif] || null, tutela_short: tutelas[r.tutela] || null, n: s.n || 0, value: s.value || 0, direct_n: s.direct_n || 0, direct_value: s.direct_value || 0, direct_share: s.value ? s.direct_value / s.value : null, first: s.first_signed, last: s.last_signed };
    }).sort((a, b) => b.value - a.value);
    // other registry entities of kind seguranca_defesa that are not fire brigades or listed bodies
    let others = [];
    if (hasC() && (q || p.get("outros"))) {
      const known = new Set(out.map((o) => o.nif));
      const bn = new Set(bombNifs());
      const like = q ? `%${String(p.get("q")).replace(/[%_]/g, "")}%` : "%";
      others = all("SELECT id, nif, name, buyer_contracts n, buyer_value value FROM entities WHERE kind='seguranca_defesa' AND name LIKE ? ORDER BY buyer_value DESC LIMIT 60", like)
        .filter((e) => !known.has(e.nif) && !bn.has(e.nif)).slice(0, 25);
    }
    const g = qa("SELECT grp, COUNT(*) n FROM orgaos GROUP BY grp");
    return { rows: out, others, groups: g };
  };

  // ---------------------------------------------------------------- bombeiros
  routes["/api/seguranca/bombeiros"] = (p) => {
    if (!mine) return missing();
    const q = norm(p.get("q") || "");
    const dico = (p.get("concelho") || "").trim();
    const tipo = p.get("tipo") || "";
    const limit = Math.min(+p.get("limit") || 50, 200), offset = Math.max(+p.get("offset") || 0, 0);
    const where = [], args = [];
    if (dico) { where.push("dico = ?"); args.push(dico); }
    if (tipo) { where.push("tipo = ?"); args.push(tipo); }
    if (p.get("sem") === "1") where.push("dico IS NULL");
    let rows = qa(`SELECT * FROM bombeiros ${where.length ? "WHERE " + where.join(" AND ") : ""}`, ...args);
    if (q) rows = rows.filter((r) => norm(r.name + " " + (r.concelho || "")).includes(q));
    const st = stat(rows.map((r) => r.nif).filter(Boolean));
    rows = rows.map((r) => { const s = st[r.nif] || {}; return { ...r, n: s.n || 0, value: s.value || 0, direct_value: s.direct_value || 0, direct_share: s.value ? s.direct_value / s.value : null }; });
    rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    const mun = Object.fromEntries(qa("SELECT dico, MAX(concelho) c, COUNT(*) n FROM bombeiros WHERE dico IS NOT NULL GROUP BY dico").map((r) => [r.dico, r]));
    // INE: corpos de bombeiros por concelho (última ano) para comparação
    const ine = {};
    for (const r of qa("SELECT dico, geo_name, value, year FROM ine_series WHERE indicator='0013372' AND level='concelho' AND year=(SELECT MAX(year) FROM ine_series WHERE indicator='0013372')")) ine[r.dico] = r;
    const byConcelho = qa("SELECT dico, MAX(concelho) concelho, COUNT(*) n FROM bombeiros WHERE dico IS NOT NULL GROUP BY dico ORDER BY n DESC, concelho LIMIT 400")
      .map((r) => ({ ...r, ine_corpos: ine[r.dico]?.value ?? null, ine_year: ine[r.dico]?.year ?? null }));
    const ids = eids(page.map((r) => r.nif));
    const cov = {
      total: q1("SELECT COUNT(*) n FROM bombeiros").n, com_concelho: q1("SELECT COUNT(*) n FROM bombeiros WHERE dico IS NOT NULL").n,
      ine_corpos_pt: last(seriesAt("bombeiros_corpos", "PT")),
    };
    return { total, rows: page.map((r) => ({ ...r, eid: ids[r.nif] || null })), byConcelho: dico || q ? undefined : byConcelho, coverage: cov, concelhos_com_corpos: Object.keys(mun).length };
  };

  // ---------------------------------------------------------------- séries
  routes["/api/seguranca/series"] = (p) => {
    if (!mine) return missing();
    const key = p.get("indicador") || "crime";
    const s = SERIES[key];
    if (!s) return { error: "indicador desconhecido", indicadores: Object.entries(SERIES).map(([k, v]) => ({ key: k, label: v.label, unit: v.unit })) };
    const terr = (p.get("territorio") || "PT").trim();
    let points;
    let geo = null;
    if (/^\d{4}$/.test(terr)) { points = seriesDico(key, terr); geo = q1("SELECT geo_name n FROM ine_series WHERE dico=? LIMIT 1", terr)?.n; }
    else { points = seriesAt(key, terr); geo = q1("SELECT geo_name n FROM ine_series WHERE geo_code=? LIMIT 1", terr)?.n; }
    const out = { indicador: key, label: s.label, unit: s.unit, source: s.src, territorio: terr, nome: geo, points, ids: s.ids };
    if (p.get("ranking") === "1" || p.get("ranking") === "true") {
      const lastY = points.length || key ? q1(`SELECT MAX(year) y FROM ine_series WHERE indicator=? AND level='concelho'`, s.ids[0])?.y : null;
      const rows = lastY ? qa(`SELECT dico, geo_name, value FROM ine_series WHERE indicator=? AND level='concelho' AND year=? AND dim=? ORDER BY value DESC LIMIT 20`, s.ids[0], lastY, s.dim) : [];
      out.ranking = { year: lastY, rows };
    }
    if (key === "crime" || key === "crime_taxa") {
      // distribuição por categoria no último ano (apenas versão mais recente)
      const id = s.ids[0], y = q1("SELECT MAX(year) y FROM ine_series WHERE indicator=?", id)?.y;
      const g = /^\d{4}$/.test(terr) ? "level='concelho' AND dico=?" : "geo_code=?";
      out.categorias = { year: y, rows: qa(`SELECT dim, value FROM ine_series WHERE indicator=? AND year=? AND ${g} AND dim != 'Total' ORDER BY value DESC`, id, y, terr) };
    }
    if (key === "area_ardida") {
      const id = s.ids[0];
      const g = /^\d{4}$/.test(terr) ? "level='concelho' AND dico=?" : "geo_code=?";
      out.tipos = qa(`SELECT year, dim, value FROM ine_series WHERE indicator=? AND ${g} AND dim != 'Total' ORDER BY year`, id, terr);
    }
    return out;
  };

  // ---------------------------------------------------------------- concelho
  routes["/api/seguranca/concelho"] = (p) => {
    if (!mine) return missing();
    let dico = (p.get("dico") || "");
    if (!dico && p.get("nif")) {
      const aut = openData("autarquias");
      const r = aut ? safe(() => aut.prepare("SELECT dico FROM municipios WHERE nif = ? OR entity_nif = ? LIMIT 1").get(p.get("nif"), p.get("nif"))) : null;
      if (!r) return { available: true, found: false };
      dico = r.dico;
    }
    dico = dico.padStart(4, "0");
    if (!/^\d{4}$/.test(dico)) return { error: "dico inválido" };
    const info = q1("SELECT geo_name name FROM ine_series WHERE level='concelho' AND dico=? LIMIT 1", dico);
    if (!info) return { available: true, dico, found: false };
    const series = {};
    for (const k of ["crime", "crime_taxa", "incendios", "area_ardida", "acidentes", "acidentes_mortais", "mortos", "feridos_graves", "bombeiros_corpos", "bombeiros_pessoal", "bombeiros_servicos"]) {
      const pts_ = seriesDico(k, dico);
      if (pts_.length) series[k] = { label: SERIES[k].label, unit: SERIES[k].unit, source: SERIES[k].src, points: pts_ };
    }
    // posição no ranking nacional (último ano comum) para crime_taxa e área ardida
    const rank = (k) => {
      const s = SERIES[k], id = s.ids[0];
      const y = q1("SELECT MAX(year) y FROM ine_series WHERE indicator=? AND level='concelho' AND dico=? AND dim=?", id, dico, s.dim)?.y;
      if (!y) return null;
      const rows = qa("SELECT dico, value FROM ine_series WHERE indicator=? AND level='concelho' AND year=? AND dim=? ORDER BY value DESC", id, y, s.dim);
      const i = rows.findIndex((r) => r.dico === dico);
      return i < 0 ? null : { year: y, pos: i + 1, of: rows.length, value: rows[i].value };
    };
    const categorias = (() => {
      const id = SERIES.crime.ids[0], y = q1("SELECT MAX(year) y FROM ine_series WHERE indicator=? AND dico=?", id, dico)?.y;
      return y ? { year: y, rows: qa("SELECT dim, value FROM ine_series WHERE indicator=? AND year=? AND dico=? AND dim != 'Total' ORDER BY value DESC", id, y, dico) } : null;
    })();
    const bomb = qa("SELECT * FROM bombeiros WHERE dico = ? ORDER BY name", dico);
    const st = stat(bomb.map((b) => b.nif).filter(Boolean));
    const ids = eids(bomb.map((b) => b.nif));
    return {
      available: true, found: true, dico, name: info.name, series, categorias,
      ranks: { crime_taxa: rank("crime_taxa"), area_ardida: rank("area_ardida"), incendios: rank("incendios") },
      bombeiros: bomb.map((b) => ({ ...b, eid: ids[b.nif] || null, n: st[b.nif]?.n || 0, value: st[b.nif]?.value || 0 })),
      note: "Séries INE por concelho (fontes: DGPJ/SGSI, ICNF, ANSR, ANEPC). As corporações são as do registo de entidades do portal cujo nome identifica o concelho; pode haver corporações em falta.",
    };
  };
}
