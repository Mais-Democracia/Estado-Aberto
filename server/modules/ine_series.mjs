export default function register({ routes, openData, all }) {
  const mine = openData("ine_series");
  const aut = openData("autarquias");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const missing = () => ({ available: false, note: "A base data/ine_series.db ainda não foi gerada (python3 ingest/run_all.py ine_series)." });
  let M = null;
  const muni = () => (M ||= new Map((aut ? aut.prepare("SELECT dico, name, district, nif, population FROM municipios").all() : []).map((m) => [m.dico, m])));
  let EID = null;
  const eids = () => (EID ||= new Map((safe(() => all("SELECT id, nif FROM entities WHERE kind='municipio'"), []) || []).map((e) => [e.nif, e.id])));
  const inds = () => qa("SELECT key, theme, label, unit, ids, first_year, last_year, n_municipios, source_url, updated FROM indicador ORDER BY rowid");

  routes["/api/ine_series/overview"] = () => {
    if (!mine) return missing();
    const built = (safe(() => qa("SELECT value FROM meta WHERE key='built'"), [])[0] || {}).value || null;
    return { available: true, built, municipios: muni().size, indicadores: inds() };
  };

  routes["/api/ine_series/concelho"] = (q) => {
    if (!mine) return missing();
    let dico = (q.get("dico") || "").trim();
    const nif = (q.get("nif") || "").trim();
    if (!dico && nif) for (const m of muni().values()) if (m.nif === nif) dico = m.dico;
    const m = muni().get(dico);
    if (!m) return { available: true, found: false };
    const out = [];
    for (const ind of inds()) {
      const serie = qa("SELECT o.year, o.value, n.median, n.ine_pt FROM obs o JOIN nacional n ON n.ind=o.ind AND n.year=o.year WHERE o.ind=? AND o.dico=? ORDER BY o.year", ind.key, dico);
      if (!serie.length) continue;
      const last = serie[serie.length - 1];
      const rk = qa("SELECT COUNT(*) + 1 AS r, (SELECT COUNT(*) FROM obs WHERE ind=? AND year=?) AS n FROM obs WHERE ind=? AND year=? AND value > ?", ind.key, last.year, ind.key, last.year, last.value)[0];
      out.push({ ...ind, serie, rank: rk.r, de: rk.n });
    }
    return { available: true, found: true, municipio: { dico, name: m.name, district: m.district, population: m.population, eid: eids().get(m.nif) || null }, indicadores: out };
  };

  routes["/api/ine_series/ranking"] = () => {
    if (!mine) return missing();
    const list = inds();
    const rows = new Map();
    for (const [dico, m] of muni()) rows.set(dico, { dico, name: m.name, district: m.district, eid: eids().get(m.nif) || null, v: {} });
    for (const ind of list) {
      for (const r of qa("SELECT dico, value FROM obs WHERE ind=? AND year=?", ind.key, ind.last_year)) {
        const row = rows.get(r.dico);
        if (row) row.v[ind.key] = r.value;
      }
    }
    const nat = {};
    for (const ind of list) {
      const n = qa("SELECT median, ine_pt FROM nacional WHERE ind=? AND year=?", ind.key, ind.last_year)[0];
      nat[ind.key] = n ? { median: n.median, ine_pt: n.ine_pt } : null;
    }
    return { available: true, indicadores: list, nacional: nat, rows: [...rows.values()] };
  };
}
