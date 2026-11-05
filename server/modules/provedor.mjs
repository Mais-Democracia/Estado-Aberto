export default function register({ routes, openData }) {
  const mine = openData("provedor");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const missing = () => ({ available: false, note: "A base data/provedor.db ainda não foi gerada (python3 ingest/run_all.py provedor)." });
  const meta = (k) => q1("SELECT value FROM meta WHERE key=?", k)?.value ?? null;

  routes["/api/provedor/overview"] = () => {
    if (!mine) return missing();
    const reports = qa("SELECT r.year, r.title, r.published, r.page_url, r.pdf_url, r.pages, r.text_ok, (SELECT value FROM stats s WHERE s.year=r.year AND s.metric='opened') opened FROM reports r ORDER BY r.year DESC");
    const series = qa("SELECT year, metric, value, quote, page, source_url FROM stats WHERE metric IN ('opened','written','verbal') ORDER BY year");
    const counts = q1("SELECT COUNT(*) n, MIN(year) y0, MAX(year) y1, SUM(text_ok) with_text FROM reports");
    const years = qa("SELECT year, COUNT(*) n FROM stats WHERE metric IN ('area','entity') GROUP BY year ORDER BY year DESC");
    return { available: true, counts, reports, series, detailYears: years, built: meta("built"), source: meta("source"), errors: meta("errors") };
  };

  routes["/api/provedor/year"] = (p) => {
    if (!mine) return missing();
    const y = +p.get("year");
    const report = q1("SELECT year, title, published, page_url, pdf_url, pages, text_ok FROM reports WHERE year=?", y);
    if (!report) return { available: true, report: null, stats: [] };
    const stats = qa("SELECT metric, scope, label, value, unit, quote, page, source_url FROM stats WHERE year=? ORDER BY CASE metric WHEN 'opened' THEN 0 WHEN 'written' THEN 1 WHEN 'verbal' THEN 2 ELSE 3 END, value DESC", y);
    return { available: true, report, stats };
  };
}
