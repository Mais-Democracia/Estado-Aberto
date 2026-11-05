export default function register({ routes, openData, all }) {
  const mine = openData("imigracao");
  const aut = openData("autarquias");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const missing = () => ({ available: false, note: "A base data/imigracao.db ainda não foi gerada (python3 ingest/run_all.py imigracao)." });
  const AGG = (c) => !c || c === "T" || c === "TOP" || /^\d/.test(c) || c.length > 2;
  let M = null;
  const muni = () => (M ||= new Map(((aut && aut.prepare("SELECT dico, name, district, nif, population, population_year FROM municipios").all()) || []).map((m) => [m.dico, m])));
  const lastYear = (ds) => (q1("SELECT MAX(year) y FROM series WHERE ds=?", ds) || {}).y;
  let EID = null;
  const eids = () => (EID ||= new Map((() => { try { return all("SELECT id, nif FROM entities WHERE kind='municipio'"); } catch { return []; } })().map((e) => [e.nif, e.id])));
  const datasets = () => qa("SELECT ds, indicator, label, title, first_year, last_year, updated, source_url, api_url FROM datasets");
  const popOf = (m) => (m ? m.population || null : null);

  const AMA_NOTE = "Pedidos ao serviço de registo de estrangeiros (NIF, Segurança Social e número de utente) publicados pela AMA. Cada ficheiro tem um único total de pedidos acumulado; não discrimina nacionalidade nem território e não é uma contagem de residentes.";

  routes["/api/imigracao/overview"] = () => {
    if (!mine) return missing();
    const ly = lastYear("resid_sex");
    const total = qa("SELECT year, value FROM series WHERE ds='resid_sex' AND sex='HM' ORDER BY year");
    const sex = qa("SELECT year, sex, value FROM series WHERE ds='resid_sex' AND sex IN ('H','M') ORDER BY year");
    const ny = lastYear("resid_nat");
    const natAll = qa("SELECT nat_code, nat_name, value FROM series WHERE ds='resid_nat' AND level='PT' AND year=? ORDER BY value DESC", ny);
    const totNat = (natAll.find((r) => r.nat_code === "T") || {}).value;
    const top = natAll.filter((r) => !AGG(r.nat_code)).slice(0, 15);
    const groups = natAll.filter((r) => /^(1|2|3|4|5|99)$/.test(r.nat_code) || ["UE27_2020", "PALOP"].includes(r.nat_code));
    const topCodes = top.slice(0, 6).map((r) => r.nat_code);
    const natSerie = topCodes.length ? qa(`SELECT nat_code, nat_name, year, value FROM series WHERE ds='resid_nat' AND level='PT' AND nat_code IN (${topCodes.map(() => "?").join(",")}) ORDER BY year`, ...topCodes) : [];
    const my = lastYear("resid_conc");
    const reg = qa("SELECT level, geo_code, geo_name, value FROM series WHERE ds='resid_conc' AND nat_code='T' AND year=? AND level IN ('nuts1','nuts2','nuts3') ORDER BY value DESC", my);
    const muniTrend = qa("SELECT year, value FROM series WHERE ds='resid_conc' AND level='PT' AND nat_code='T' ORDER BY year");
    const ama = qa("SELECT resource, period, scope, value, published, source_url FROM ama_pedidos ORDER BY published DESC, resource");
    const pedidos = qa("SELECT year, sex, value FROM series WHERE ds='pedidos_sex' ORDER BY year");
    return {
      available: true,
      built: (q1("SELECT value FROM meta WHERE key='built'") || {}).value,
      residentes: { total, sex, ultimo_ano: ly, unidade: "pessoas com título de residência válido em 31 de dezembro", fonte: "INE, População estrangeira com estatuto legal de residente (fonte administrativa SEF/AIMA)", source_url: "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd=0001274&lingua=PT" },
      nacionalidades: { ano: ny, total: totNat, top, grupos: groups, serie: natSerie, source_url: "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd=0001236&lingua=PT" },
      regioes: { ano: my, linhas: reg, serie_municipios: muniTrend, source_url: "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd=0010247&lingua=PT" },
      pedidos_residencia: pedidos,
      ama: { linhas: ama, nota: AMA_NOTE, pagina: "https://dados.gov.pt/datasets/registo-estrangeiros-estatisticas-pmc-1" },
      datasets: datasets(),
    };
  };

  routes["/api/imigracao/municipios"] = (q) => {
    if (!mine) return missing();
    const my = lastYear("resid_conc");
    const year = Number(q.get("year")) || my;
    const M0 = muni();
    const rows = qa("SELECT dico, geo_name, nat_code, nat_name, value FROM series WHERE ds='resid_conc' AND level='concelho' AND year=?", year);
    const by = new Map();
    for (const r of rows) {
      const o = by.get(r.dico) || { dico: r.dico, name: r.geo_name, nat: [] };
      if (r.nat_code === "T") o.total = r.value;
      else if (r.nat_code === "TOP") o.outros = r.value;
      else o.nat.push({ code: r.nat_code, name: r.nat_name, value: r.value });
      by.set(r.dico, o);
    }
    const prev = new Map(qa("SELECT dico, value FROM series WHERE ds='resid_conc' AND level='concelho' AND nat_code='T' AND year=?", year - 5).map((r) => [r.dico, r.value]));
    const out = [...by.values()].map((o) => {
      const m = M0.get(o.dico) || {};
      const pop = popOf(m);
      o.nat.sort((a, b) => b.value - a.value);
      return { dico: o.dico, name: m.name || o.name, district: m.district || null, eid: eids().get(m.nif) || null, total: o.total, per100: pop && o.total != null ? (100 * o.total) / pop : null, population: pop, antes: prev.get(o.dico) ?? null, top: o.nat.slice(0, 3) };
    });
    const distr = new Map();
    for (const r of out) {
      const k = r.district || "—";
      const d = distr.get(k) || { district: k, total: 0, pop: 0, n: 0 };
      d.total += r.total || 0; d.pop += r.population || 0; d.n++;
      distr.set(k, d);
    }
    const distritos = [...distr.values()].map((d) => ({ district: d.district, total: d.total, per100: d.pop ? (100 * d.total) / d.pop : null, municipios: d.n })).sort((a, b) => b.total - a.total);
    return { available: true, year, years: qa("SELECT DISTINCT year FROM series WHERE ds='resid_conc' ORDER BY year DESC").map((r) => r.year), total: out.reduce((a, r) => a + (r.total || 0), 0), municipios: out, distritos, source_url: "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd=0010247&lingua=PT" };
  };

  routes["/api/imigracao/concelho"] = (q) => {
    if (!mine) return missing();
    let dico = (q.get("dico") || "").trim();
    const nif = (q.get("nif") || "").trim();
    const M0 = muni();
    if (!dico && nif) for (const m of M0.values()) if (m.nif === nif) dico = m.dico;
    const m = M0.get(dico);
    if (!m) return { found: false };
    const my = lastYear("resid_conc");
    const serie = qa("SELECT year, value FROM series WHERE ds='resid_conc' AND dico=? AND nat_code='T' ORDER BY year", dico);
    const nat = qa("SELECT nat_code, nat_name, value FROM series WHERE ds='resid_conc' AND dico=? AND year=? AND nat_code NOT IN ('T','TOP') ORDER BY value DESC", dico, my);
    const outros = (q1("SELECT value FROM series WHERE ds='resid_conc' AND dico=? AND year=? AND nat_code='TOP'", dico, my) || {}).value;
    const all = qa("SELECT dico, value FROM series WHERE ds='resid_conc' AND level='concelho' AND nat_code='T' AND year=? ORDER BY value DESC", my);
    const rank = all.findIndex((r) => r.dico === dico) + 1;
    const pop = popOf(m);
    const last = serie.length ? serie[serie.length - 1].value : null;
    return {
      found: true, municipio: { dico, name: m.name, district: m.district }, ano: my, serie, nacionalidades: nat, outros, total: last,
      rank: rank || null, de: all.length, per100: pop && last != null ? (100 * last) / pop : null, populacao: pop, populacao_ano: m.population_year,
      source_url: "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd=0010247&lingua=PT",
    };
  };
}
