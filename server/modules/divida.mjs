export default function register({ openData, routes }) {
  const mine = openData("divida");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const meta = (k) => q1("SELECT value FROM meta WHERE key=?", k)?.value ?? null;
  const missing = () => ({ available: false, note: "A base data/divida.db ainda não foi gerada (python3 ingest/run_all.py divida)." });

  routes["/api/divida/overview"] = () => {
    if (!mine) return missing();
    const last = (code) => q1("SELECT date, value FROM series WHERE code = ? ORDER BY date DESC LIMIT 1", code);
    const first = q1("SELECT MIN(date) d FROM series WHERE code = 'total'").d;
    const lastTotal = last("total");
    const prev = q1("SELECT value FROM series WHERE code='total' AND date = ?", `${Number(lastTotal.date.slice(0, 4)) - 1}${lastTotal.date.slice(4)}`);
    return {
      available: true,
      latest: { date: lastTotal.date, total: lastTotal.value, ot: last("ot")?.value, aforro: last("aforro")?.value, ct: last("ct")?.value, prazo_medio: last("prazo_medio")?.value, pct_fixa: last("pct_fixa")?.value, pct_euro: last("pct_euro")?.value, duracao: last("duracao")?.value },
      yoy: prev ? lastTotal.value - prev.value : null,
      first, built: meta("built"), source: meta("source"),
      note: "Dívida direta do Estado (IGCP), milhões de euros, valores mensais. O perfil de maturidades só é publicado como imagem e não está na base.",
    };
  };

  routes["/api/divida/series"] = (q) => {
    if (!mine) return missing();
    const codes = (q.get("codes") || "total").split(",").filter((c) => /^[a-z_]+$/.test(c)).slice(0, 8);
    const out = {};
    for (const c of codes) out[c] = qa("SELECT date, value FROM series WHERE code = ? ORDER BY date", c);
    return { available: true, series: out, meta: qa("SELECT code, label, unit, grp FROM series_meta") };
  };
}
