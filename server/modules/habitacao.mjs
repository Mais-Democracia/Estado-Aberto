// Módulo "habitacao": habitação por concelho — alojamento local (RNAL), preços e rendas (INE), licenciamento, Censos 2021,
// PRR C02, contratação pública e legislação. Dados: data/habitacao.db (ingest/jobs/habitacao.py). Ver docs/MODULES.md.
export default function register({ routes, openData, all }) {
  const mine = openData("habitacao");
  const aut = openData("autarquias");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const missing = () => ({ available: false, note: "A base data/habitacao.db ainda não foi gerada (python3 ingest/run_all.py habitacao)." });
  const meta = () => Object.fromEntries(qa("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
  const pts = (rows) => rows.map((r) => ({ period: r.period, year: r.year, q: r.q, value: r.value, flag: r.flag || null }));

  const munis = () => {
    if (!aut) return new Map();
    return new Map(aut.prepare("SELECT dico, name, district, nif, population, population_year FROM municipios").all().map((m) => [m.dico, m]));
  };
  let EID = null;
  const eids = () => (EID ||= new Map((safe(() => all("SELECT id, nif FROM entities WHERE kind='municipio'"), []) || []).map((e) => [e.nif, e.id])));
  let M = null;
  const muni = () => (M ||= munis());

  // Série de um indicador (família + dim) para um nível/geo.
  const serie = (family, dim, dico) => dico
    ? pts(qa("SELECT period, year, q, value, flag FROM ine_series WHERE family=? AND level='concelho' AND dico=? AND dim=? ORDER BY period", family, dico, dim))
    : pts(qa("SELECT period, year, q, value, flag FROM ine_series WHERE family=? AND level='PT' AND dim=? ORDER BY period", family, dim));
  const lastOf = (a) => (a.length ? a[a.length - 1] : null);
  const latestPeriod = (family, dim) => (q1("SELECT MAX(period) p FROM ine_series WHERE family=? AND level='concelho' AND dim=?", family, dim) || {}).p;

  const INDICADORES = {
    venda_m2: { label: "Preço mediano de venda (€/m²)", unit: "€/m²", fam: "venda", dim: "Total", src: "INE, vendas últimos 12 meses", timed: true, desc: true },
    renda_m2: { label: "Renda mediana de novos contratos (€/m²)", unit: "€/m²", fam: "renda", dim: "", src: "INE, rendas de novos contratos, últimos 12 meses", timed: true, desc: true },
    al_per100: { label: "Alojamento local por 100 alojamentos (Censos 2021)", unit: "AL/100 aloj.", src: "RNAL + INE Censos 2021", desc: true },
    al_per100_hab: { label: "Alojamento local por 100 alojamentos de residência habitual", unit: "AL/100 res. hab.", src: "RNAL + INE Censos 2021", desc: true },
    al_n: { label: "Estabelecimentos de alojamento local ativos", unit: "n.º", src: "RNAL", desc: true },
    al_utentes_hab: { label: "Capacidade de AL (utentes) por 100 habitantes", unit: "utentes/100 hab.", src: "RNAL + INE Censos 2021", desc: true },
    licenciados: { label: "Fogos licenciados em construção nova", unit: "fogos", fam: "licenciados", dim: "Total", src: "INE", timed: true, desc: true },
    licenciados_1000: { label: "Fogos licenciados por 1000 alojamentos (Censos 2021)", unit: "fogos/1000 aloj.", fam: "licenciados", dim: "Total", src: "INE", timed: true, desc: true, per: true },
    concluidos: { label: "Fogos concluídos em construção nova", unit: "fogos", fam: "concluidos", dim: "Total", src: "INE", timed: true, desc: true },
    arrendados_pct: { label: "Residência habitual arrendada (% , Censos 2021)", unit: "%", src: "INE Censos 2021", desc: true },
    secundaria_pct: { label: "Residência secundária (% dos alojamentos, Censos 2021)", unit: "%", src: "INE Censos 2021", desc: true },
    vagos_pct: { label: "Alojamentos vagos (% , Censos 2021)", unit: "%", src: "INE Censos 2021", desc: true },
    social_fogos: { label: "Fogos de habitação social (inquérito às câmaras, 2015)", unit: "fogos", fam: "social", dim: "Total", src: "INE (2015, desatualizado)", timed: true, desc: true },
    prr_fogos: { label: "Fogos em projetos PRR C02 Habitação", unit: "fogos", src: "PRR (Estrutura de Missão)", desc: true },
    prr_aprovado: { label: "Investimento aprovado PRR C02 Habitação", unit: "€", src: "PRR (Estrutura de Missão)", desc: true },
    prr_aprovado_pc: { label: "Investimento aprovado PRR C02 por habitante", unit: "€/hab.", src: "PRR + INE", desc: true },
    contratos_valor: { label: "Contratação pública de habitação (comprador município, empresa municipal ou freguesia)", unit: "€", src: "Portal BASE", desc: true },
  };

  // Mapa dico -> censos
  function censos() {
    const out = {};
    for (const r of qa("SELECT dico, dim, value FROM ine_series WHERE family='censos_ocup' AND level='concelho'")) (out[r.dico] ||= {})[r.dim] = r.value;
    const reg = {};
    for (const r of qa("SELECT dico, dim, value FROM ine_series WHERE family='censos_regime' AND level='concelho'")) (reg[r.dico] ||= {})[r.dim] = r.value;
    return { ocup: out, reg };
  }

  routes["/api/habitacao/overview"] = () => {
    if (!mine) return missing();
    const m = meta();
    const al = q1("SELECT SUM(n) n, SUM(utentes) u, COUNT(*) c FROM al_conc");
    const ocupPT = {};
    for (const r of qa("SELECT dim, value FROM ine_series WHERE family='censos_ocup' AND level='PT'")) ocupPT[r.dim] = r.value;
    const regPT = {};
    for (const r of qa("SELECT dim, value FROM ine_series WHERE family='censos_regime' AND level='PT'")) regPT[r.dim] = r.value;
    const venda = serie("venda", "Total", null);
    const renda = serie("renda", "", null);
    const lic = serie("licenciados", "Total", null);
    const conc = serie("concluidos", "Total", null);
    const alAno = qa("SELECT year, n, cum_n FROM al_ano WHERE dico='' ORDER BY year");
    const alMes = qa("SELECT month, n FROM al_mes ORDER BY month DESC LIMIT 36").reverse();
    const modal = qa("SELECT modalidade, n, utentes FROM al_modal WHERE dico='' ORDER BY n DESC");
    const prr = qa("SELECT code, label, n, fogos, aprovado, pago, n_sem_concelho, aprovado_sem_concelho, source_url FROM prr_hab_nat ORDER BY aprovado DESC");
    const ihru = qa("SELECT year, n, value, direct_n, direct_value FROM ihru_year ORDER BY year");
    const ihruTop = qa("SELECT seller_nif, seller_name, entity_id, n, value FROM ihru_top ORDER BY value DESC LIMIT 10");
    const empresas = qa("SELECT nif, name, dico, method, entity_id, n, value FROM hab_empresas WHERE n>0 ORDER BY value DESC LIMIT 15").map((e) => ({ ...e, municipio: (muni().get(e.dico) || {}).name || null }));
    const leisTema = qa("SELECT tema, src, COUNT(*) n FROM leis GROUP BY tema, src");
    const social = serie("social", "Total", null);
    const alTot = ocupPT.Total;
    return {
      available: true,
      meta: { built: m.built, rnal_snapshot: m.rnal_snapshot, rnal_records: m.rnal_records },
      fontes: qa("SELECT * FROM fontes"),
      al: {
        n: al.n, utentes: al.u, concelhos: al.c, snapshot: m.rnal_snapshot, alojamentos_2021: alTot,
        per100: alTot ? (100 * al.n) / alTot : null, serie_ano: alAno, serie_mes: alMes, modalidades: modal,
        nota: "Registos ativos no RNAL em " + m.rnal_snapshot + ". A série por ano é a dos registos ainda ativos (os cancelados desaparecem), por isso subestima o stock passado.",
        source_url: "https://dados.gov.pt/pt/datasets/estabelecimentos-de-alojamento-local-1/",
      },
      mercado: {
        venda: { points: venda, unit: "€/m²", source_url: "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0012241&lang=PT", n_concelhos: (q1("SELECT COUNT(DISTINCT dico) c FROM ine_series WHERE family='venda' AND level='concelho' AND dim='Total'") || {}).c },
        renda: { points: renda, unit: "€/m²", source_url: "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0014696&lang=PT", n_concelhos: (q1("SELECT COUNT(DISTINCT dico) c FROM ine_series WHERE family='renda' AND level='concelho'") || {}).c },
        licenciados: { points: lic, unit: "fogos", source_url: "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0013235&lang=PT" },
        concluidos: { points: conc, unit: "fogos", source_url: "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0013248&lang=PT" },
      },
      censos: {
        ocupacao: ocupPT, regime: regPT, ano: 2021,
        arrendados_pct: regPT.Total ? (100 * regPT["Arrendamento ou subarrendamento"]) / regPT.Total : null,
        secundaria_pct: ocupPT.Total ? (100 * ocupPT["Residência secundária"]) / ocupPT.Total : null,
        vagos_pct: ocupPT.Total ? (100 * ((ocupPT["Vago para venda ou arrendamento"] || 0) + (ocupPT["Vago por outros motivos"] || 0))) / ocupPT.Total : null,
        source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0012502&lang=PT",
      },
      social: { points: social, unit: "fogos", nota: "Inquérito às câmaras municipais; última edição disponível (2015). Não inclui o parque do IHRU atual.", source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0009016&lang=PT" },
      politica: {
        prr, ihru, ihruTop, empresas,
        bloqueado: "1.º Direito (candidaturas/contratos por município), Porta de Entrada, Arrendamento Acessível e Estratégias Locais de Habitação não têm dados abertos estruturados: o IHRU publica-os num painel Power BI embebido e em páginas descritivas. O PRR C02-i01 'Programa de apoio ao acesso à habitação' (financia o 1.º Direito) é o único indicador municipal disponível.",
      },
      leis: leisTema,
    };
  };

  routes["/api/habitacao/ranking"] = (q) => {
    if (!mine) return missing();
    const ind = q.get("indicador") || "venda_m2";
    const def = INDICADORES[ind];
    if (!def) return { error: "indicador desconhecido", indicadores: Object.entries(INDICADORES).map(([k, v]) => ({ id: k, label: v.label, unit: v.unit })) };
    const limit = Math.min(400, Math.max(1, Number.parseInt(q.get("limit") || "50", 10) || 50));
    const order = q.get("ordem") === "asc" ? 1 : 0;
    const M0 = muni();
    const C = censos();
    let periodos = null, periodo = null, vals = new Map();
    const addInd = (dico, v, extra) => { if (v != null && Number.isFinite(v) && M0.has(dico)) vals.set(dico, { value: v, ...(extra || {}) }); };
    if (def.fam) {
      const dim = ind === "renda_m2" ? "" : def.dim;
      periodos = qa("SELECT DISTINCT period FROM ine_series WHERE family=? AND level='concelho' AND dim=? ORDER BY period DESC", def.fam, dim).map((r) => r.period);
      periodo = q.get("periodo") && periodos.includes(q.get("periodo")) ? q.get("periodo") : periodos[0];
      for (const r of qa("SELECT dico, value FROM ine_series WHERE family=? AND level='concelho' AND dim=? AND period=?", def.fam, dim, periodo)) {
        let v = r.value;
        if (def.per) { const t = (C.ocup[r.dico] || {}).Total; v = t ? (1000 * v) / t : null; }
        addInd(r.dico, v);
      }
    } else if (ind.startsWith("al_")) {
      for (const r of qa("SELECT dico, n, utentes, alojamentos, per100_alojamentos p1, per100_residencia_habitual p2, utentes_per100_hab p3 FROM al_dens")) {
        const v = ind === "al_n" ? r.n : ind === "al_per100" ? r.p1 : ind === "al_per100_hab" ? r.p2 : r.p3;
        addInd(r.dico, v, { n: r.n, utentes: r.utentes, alojamentos: r.alojamentos });
      }
      periodo = "snapshot " + (meta().rnal_snapshot || "");
    } else if (ind.endsWith("_pct") && !ind.startsWith("prr")) {
      periodo = "Censos 2021";
      for (const dico of Object.keys(C.ocup)) {
        const o = C.ocup[dico], r = C.reg[dico] || {};
        let v = null;
        if (ind === "arrendados_pct") v = r.Total ? (100 * (r["Arrendamento ou subarrendamento"] || 0)) / r.Total : null;
        if (ind === "secundaria_pct") v = o.Total ? (100 * (o["Residência secundária"] || 0)) / o.Total : null;
        if (ind === "vagos_pct") v = o.Total ? (100 * ((o["Vago para venda ou arrendamento"] || 0) + (o["Vago por outros motivos"] || 0))) / o.Total : null;
        addInd(dico, v, { alojamentos: o.Total });
      }
    } else if (ind.startsWith("prr_")) {
      periodo = "PRR, estado atual";
      for (const r of qa("SELECT dico, SUM(fogos) fogos, SUM(aprovado) apr, SUM(pago) pago, SUM(n) n FROM prr_hab GROUP BY dico")) {
        const pop = (M0.get(r.dico) || {}).population;
        const v = ind === "prr_fogos" ? r.fogos : ind === "prr_aprovado" ? r.apr : pop ? r.apr / pop : null;
        addInd(r.dico, v, { n: r.n, fogos: r.fogos, aprovado: r.apr, pago: r.pago });
      }
    } else if (ind === "contratos_valor") {
      periodo = "2012–2026";
      for (const r of qa("SELECT dico, SUM(value) v, SUM(n) n FROM contr_agg WHERE lens='comprador' GROUP BY dico")) addInd(r.dico, r.v, { n: r.n });
    }
    const rows = [...vals.entries()].map(([dico, o]) => {
      const m = M0.get(dico);
      return { dico, name: m.name, district: m.district, population: m.population, eid: eids().get(m.nif) || null, ...o };
    });
    rows.sort((a, b) => (order ? a.value - b.value : b.value - a.value));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return {
      available: true, indicador: ind, label: def.label, unit: def.unit, source: def.src, periodo, periodos, ordem: order ? "asc" : "desc",
      n: rows.length, n_municipios: M0.size, nota: rows.length < M0.size ? `Valor disponível para ${rows.length} de ${M0.size} municípios (sem valor = sem dados ou sigilo estatístico/amostra insuficiente).` : null,
      rows: rows.slice(0, limit),
    };
  };

  routes["/api/habitacao/concelho"] = (q) => {
    if (!mine) return missing();
    let dico = (q.get("dico") || "").trim();
    const nif = (q.get("nif") || "").trim();
    const M0 = muni();
    if (!dico && nif) for (const m of M0.values()) if (m.nif === nif) dico = m.dico;
    const m = M0.get(dico);
    if (!m) return { found: false };
    const meta0 = meta();
    const C = censos();
    const o = C.ocup[dico] || {}, r = C.reg[dico] || {};
    const alc = q1("SELECT * FROM al_dens WHERE dico=?", dico);
    const rankOf = (sql, v) => (v == null ? null : (q1(sql, v) || {}).c + 1);
    const vendaS = serie("venda", "Total", dico), rendaS = serie("renda", "", dico);
    const vendaTip = {};
    for (const t of ["T0 ou T1", "T2", "T3"]) { const s = serie("venda", t, dico); if (s.length) vendaTip[t] = s; }
    const rendaTip = {};
    for (const t of ["T0 e T1", "T2 e T3", "T2", "T3", "T0 ou T1"]) { const s = serie("renda_tip", t, dico); if (s.length) rendaTip[t] = s; }
    const vPer = latestPeriod("venda", "Total"), rPer = latestPeriod("renda", "");
    const vLast = lastOf(vendaS), rLast = lastOf(rendaS);
    const vRank = vLast && vLast.period === vPer ? rankOf("SELECT COUNT(*) c FROM ine_series WHERE family='venda' AND level='concelho' AND dim='Total' AND period='" + vPer + "' AND value > ?", vLast.value) : null;
    const vN = vPer ? (q1("SELECT COUNT(*) c FROM ine_series WHERE family='venda' AND level='concelho' AND dim='Total' AND period=?", vPer) || {}).c : 0;
    const rRank = rLast && rLast.period === rPer ? rankOf("SELECT COUNT(*) c FROM ine_series WHERE family='renda' AND level='concelho' AND period='" + rPer + "' AND value > ?", rLast.value) : null;
    const rN = rPer ? (q1("SELECT COUNT(*) c FROM ine_series WHERE family='renda' AND level='concelho' AND period=?", rPer) || {}).c : 0;
    const prr = qa("SELECT code, label, n, fogos, fogos_titles, aprovado, pago, source_url FROM prr_hab WHERE dico=? ORDER BY aprovado DESC", dico);
    const contr = qa("SELECT lens, buyer_type, grp, year, n, value, direct_n, direct_value FROM contr_agg WHERE dico=? ORDER BY year", dico);
    const tops = qa("SELECT lens, id, signed, object, price, buyer_type, buyer_name, buyer_nif, seller_name, seller_nif, grp, procedure, source_url FROM contr_top WHERE dico=? ORDER BY lens, price DESC", dico);
    const emp = qa("SELECT nif, name, entity_id, method, n, value FROM hab_empresas WHERE dico=?", dico);
    const freg = qa("SELECT dicofre, freguesia, n, utentes FROM al_freg WHERE dico=? ORDER BY n DESC LIMIT 15", dico);
    const alAno = qa("SELECT year, n, cum_n, cum_utentes FROM al_ano WHERE dico=? ORDER BY year", dico);
    const modal = qa("SELECT modalidade, n, utentes FROM al_modal WHERE dico=? ORDER BY n DESC", dico);
    const lic = serie("licenciados", "Total", dico), conc = serie("concluidos", "Total", dico), soc = serie("social", "Total", dico);
    const socDest = {};
    for (const d of ["Vagos", "Ocupados ilegalmente", "Arrendados"]) { const s = serie("social_destino", d, dico); if (s.length) socDest[d] = s; }
    const rankAl = alc ? (q1("SELECT COUNT(*) c FROM al_dens WHERE per100_alojamentos > ?", alc.per100_alojamentos) || {}).c + 1 : null;
    return {
      found: true, available: true,
      municipio: { dico, eid: eids().get(m.nif) || null, name: m.name, district: m.district, population: m.population, population_year: m.population_year },
      al: alc ? { ...alc, rank_per100: rankAl, n_municipios_al: (q1("SELECT COUNT(*) c FROM al_dens") || {}).c, serie_ano: alAno, modalidades: modal, freguesias: freg,
        snapshot: meta0.rnal_snapshot, source_url: "https://dados.gov.pt/pt/datasets/estabelecimentos-de-alojamento-local-1/" } : { n: 0, nota: "Sem registos ativos de alojamento local no RNAL para este município." },
      mercado: {
        venda: { points: vendaS, tip: vendaTip, rank: vRank, de: vN, periodo_rank: vPer, source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0012241&lang=PT" },
        renda: { points: rendaS, tip: rendaTip, rank: rRank, de: rN, periodo_rank: rPer, source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0014696&lang=PT" },
        licenciados: lic, concluidos: conc,
        nota: !vendaS.length ? "O INE não publica o preço mediano de venda deste município (poucas transações ou sigilo estatístico)." : null,
      },
      censos: {
        ano: 2021, alojamentos: o.Total, residencia_habitual: o["Residência habitual"], secundaria: o["Residência secundária"],
        vagos_venda_arrend: o["Vago para venda ou arrendamento"], vagos_outros: o["Vago por outros motivos"],
        arrendados: r["Arrendamento ou subarrendamento"], proprios: r["Propriedade ou copropriedade"], regime_total: r.Total,
        arrendados_pct: r.Total ? (100 * r["Arrendamento ou subarrendamento"]) / r.Total : null,
        secundaria_pct: o.Total ? (100 * o["Residência secundária"]) / o.Total : null,
        source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0012502&lang=PT",
      },
      social: { points: soc, destino: socDest, nota: "Inquérito às câmaras municipais (INE); última edição disponível é de 2015.", source_url: "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0009016&lang=PT" },
      prr: { rows: prr, nota: "PRR C02 Habitação: C02-i01 'Programa de apoio ao acesso à habitação' financia o 1.º Direito. Os dados do IHRU por município (candidaturas, contratos) não são abertos." },
      contratacao: { agg: contr, top: tops, empresas: emp, nota: "Contratos do Portal BASE: CPV 45211 (construção residencial), CPV 70 (imobiliário) ou objeto que menciona habitação/fogos. 'comprador' = município, freguesias ou empresa municipal de habitação; 'local' = local de execução indicado no contrato." },
    };
  };

  routes["/api/habitacao/leis"] = (q) => {
    if (!mine) return missing();
    const tema = q.get("tema") || "";
    const src = q.get("src") || "";
    const term = (q.get("q") || "").trim();
    const where = [], args = [];
    if (tema) { where.push("tema=?"); args.push(tema); }
    if (src) { where.push("src=?"); args.push(src); }
    if (term) { where.push("title LIKE ?"); args.push("%" + term.replace(/[%_]/g, "") + "%"); }
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.get("limit") || "150", 10) || 150));
    const rows = qa(`SELECT ref, src, kind, number, title, date, leg, autoria, estado, resultado, lei_ref, dre_id, tema, source_url FROM leis ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date DESC LIMIT ${limit}`, ...args);
    const votos = {};
    const refs = rows.filter((r) => r.src === "parlamento").map((r) => r.ref);
    for (let i = 0; i < refs.length; i += 200) {
      const part = refs.slice(i, i + 200);
      for (const v of qa(`SELECT ref, data, fase, orgao, resultado, favor, contra, abstencao, source_url FROM leis_votos WHERE ref IN (${part.map(() => "?").join(",")}) ORDER BY data`, ...part)) (votos[v.ref] ||= []).push(v);
    }
    for (const r of rows) if (votos[r.ref]) r.votos = votos[r.ref];
    const temas = qa("SELECT tema, COUNT(*) n FROM leis GROUP BY tema ORDER BY n DESC");
    const porAno = qa("SELECT substr(date,1,4) y, src, COUNT(*) n FROM leis WHERE date IS NOT NULL GROUP BY y, src ORDER BY y");
    const aprov = qa("SELECT resultado, COUNT(*) n FROM leis WHERE src='parlamento' AND resultado IS NOT NULL GROUP BY resultado ORDER BY n DESC LIMIT 8");
    return { available: true, n: rows.length, temas, porAno, resultados: aprov, rows,
      nota: "Iniciativas legislativas da AR (XV–XVII legislaturas, desde 2022) e atos do Diário da República com palavras de habitação/arrendamento/alojamento local no título ou sumário. Pesquisa por palavras: pode incluir diplomas só tangenciais." };
  };
}
