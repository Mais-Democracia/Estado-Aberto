export default function register({ routes, openData }) {
  const mine = openData("dgeec");
  const aut = openData("autarquias");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const missing = () => ({ available: false, note: "A base data/dgeec.db ainda não foi gerada (python3 ingest/run_all.py dgeec)." });
  const munis = () => (aut ? new Map(aut.prepare("SELECT dico, name, district, population FROM municipios").all().map((m) => [m.dico, m])) : new Map());

  routes["/api/dgeec/overview"] = () => {
    if (!mine) return missing();
    const meta = Object.fromEntries(qa("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    const pick = (ind) => qa("SELECT series, grp, year, value FROM indicators WHERE indicator = ? ORDER BY series, year", ind);
    return {
      available: true, meta,
      indicators: qa("SELECT indicator id, title, COUNT(*) n, MIN(year) y0, MAX(year) y1 FROM indicators GROUP BY indicator ORDER BY CAST(substr(indicator,1,instr(indicator,'.')-1) AS INT), CAST(substr(indicator,instr(indicator,'.')+1) AS INT)"),
      alunos: pick("1.1"), docentes: pick("1.8"), naoDocentes: pick("1.9"), alunosPorDocente: pick("3.13"), vagasSuperior: pick("5.1"), inscritosSuperior: pick("5.3"),
      source: "DGEEC, Indicadores gerais da educação (estatisticas-educacao.dgeec.medu.pt) via dados.gov.pt",
    };
  };

  routes["/api/dgeec/indicator"] = (q) => {
    if (!mine) return missing();
    const id = q.get("id") || "1.1";
    const rows = qa("SELECT title, grp, series, year, value, source_url FROM indicators WHERE indicator = ? ORDER BY series, year", id);
    return { available: true, id, title: rows[0]?.title || null, source_url: rows[0]?.source_url || null, rows };
  };

  routes["/api/dgeec/municipios"] = (q) => {
    if (!mine) return missing();
    const year = q.get("year") || (q1("SELECT MAX(year) y FROM mun_students") || {}).y;
    const level = q.get("level") || "";
    const M = munis();
    const rows = qa(`SELECT dico, municipality, SUM(students) students, SUM(schools) schools FROM mun_students WHERE year = ?${level ? " AND level = ?" : ""} GROUP BY dico`, ...(level ? [year, level] : [year]))
      .map((r) => { const m = M.get(r.dico) || {}; return { ...r, district: m.district || null, population: m.population || null, per1000: m.population ? Math.round((1000 * r.students) / m.population * 10) / 10 : null }; })
      .sort((a, b) => b.students - a.students);
    return {
      available: true, year, level, rows,
      years: qa("SELECT DISTINCT year FROM mun_students ORDER BY year").map((r) => r.year),
      levels: qa("SELECT DISTINCT level FROM mun_students ORDER BY level").map((r) => r.level),
      national: qa("SELECT level, year, students, source_url FROM national_check ORDER BY level, year"),
      note: "Alunos matriculados no ensino básico geral e secundário (Continente), agregados por município a partir do Infoescolas 2020 (DGEEC). Valores suprimidos pela fonte por confidencialidade não são somados. Açores e Madeira não são abrangidos.",
    };
  };

  routes["/api/dgeec/municipio"] = (q) => {
    if (!mine) return missing();
    const dico = q.get("dico") || "";
    const m = munis().get(dico);
    if (!m) return { available: true, found: false };
    const rows = qa("SELECT level, year, students, schools, source_url FROM mun_students WHERE dico = ? ORDER BY level, year", dico);
    const tot = {};
    for (const r of rows) { tot[r.year] ||= { year: r.year, students: 0, schools: 0 }; tot[r.year].students += r.students; tot[r.year].schools += r.schools; }
    return { available: true, found: true, municipio: { dico, name: m.name, district: m.district, population: m.population }, rows, totals: Object.values(tot).sort((a, b) => (a.year < b.year ? -1 : 1)) };
  };
}
