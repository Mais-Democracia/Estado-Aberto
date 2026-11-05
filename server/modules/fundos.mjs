// Fundos europeus e PRR: PRR, Portugal 2020, MAR2020, Portugal 2030, FEADER -> beneficiários ligados ao registo por NIF.
// Dados: data/fundos.db (ingest/jobs/fundos.py). Rotas: /api/fundos/overview, /search, /entity.
export default function register({ db, all, one, has, num, routes, openData }) {
  const mine = openData("fundos");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const missing = () => ({ available: false, note: "A base data/fundos.db ainda não foi gerada (python3 ingest/run_all.py fundos)." });
  const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const muniKey = (name) => strip(String(name || "").replace(/-\s*c[aâ]mara municipal.*$/i, "").replace(/^munic[ií]pio d[eoa]s?\s+/i, ""));
  const FW_ORDER = ["PRR", "PT2030", "PT2020", "FEADER", "MAR2020"];

  // ids do registo mudam quando politica.db é reconstruído: resolve-se sempre pelo NIF no momento do pedido
  const withIds = (rows) => {
    const nifs = [...new Set(rows.map((r) => r.nif).filter(Boolean))];
    if (!nifs.length || !has("entities")) return rows;
    const m = new Map(all(`SELECT id, nif, kind, population FROM entities WHERE nif IN (${nifs.map(() => "?").join(",")})`, ...nifs).map((e) => [e.nif, e]));
    return rows.map((r) => ({ ...r, entity_id: m.get(r.nif)?.id ?? null, ekind: m.get(r.nif)?.kind ?? null, population: m.get(r.nif)?.population ?? null }));
  };

  routes["/api/fundos/overview"] = () => {
    if (!mine) return missing();
    const fw = qa("SELECT key fw, n, aprovado, pago FROM agg WHERE dim='fw'").sort((a, b) => FW_ORDER.indexOf(a.fw) - FW_ORDER.indexOf(b.fw));
    const tot = q1("SELECT COUNT(*) n, COALESCE(SUM(aprovado),0) aprovado, COALESCE(SUM(pago),0) pago FROM awards WHERE counts=1");
    const ben = q1("SELECT COUNT(*) n, SUM(entity_id IS NOT NULL) matched FROM ent_totals");
    const prog = qa("SELECT key, n, aprovado, pago FROM agg WHERE dim='programa' ORDER BY aprovado DESC LIMIT 14").map((r) => { const [fw0, ...p] = r.key.split("|"); return { ...r, fw: fw0, programa: p.join("|") }; });
    const anos = qa("SELECT key ano, n, aprovado, pago FROM agg WHERE dim='ano' AND key>0 ORDER BY CAST(key AS INT)").map((r) => ({ ...r, year: +r.ano }));
    const anoFw = qa("SELECT key fw, key2 ano, aprovado FROM agg WHERE dim='fw_ano' AND key2>0 ORDER BY CAST(key2 AS INT)");
    const reg = qa("SELECT key regiao, n, aprovado, pago FROM agg WHERE dim='regiao' ORDER BY aprovado DESC LIMIT 12");
    const tipos = qa("SELECT key tipo, n, aprovado, pago FROM agg WHERE dim='tipo' ORDER BY aprovado DESC");
    const top = withIds(qa("SELECT nif, name, tipo, n, aprovado, pago FROM ent_totals WHERE tipo != 'Agregado (não identificado)' ORDER BY aprovado DESC LIMIT 20"));
    const agg = q1("SELECT COALESCE(SUM(aprovado),0) v, COUNT(*) n FROM awards WHERE counts=1 AND tipo='Agregado (não identificado)'");
    const pers = q1("SELECT COALESCE(SUM(aprovado),0) v, COUNT(*) n FROM awards WHERE counts=1 AND tipo='Pessoa singular'");
    // municípios (kind='municipio') como beneficiários
    const munis = withIds(qa("SELECT nif, name, n, aprovado, pago FROM ent_totals WHERE nif IS NOT NULL ORDER BY aprovado DESC LIMIT 4000"))
      .filter((r) => r.ekind === "municipio").slice(0, 25).map((r) => ({ ...r, per_capita: r.population ? r.aprovado / r.population : null }));
    const concelhos = qa("SELECT concelho, n, aprovado, pago FROM conc_totals ORDER BY aprovado DESC LIMIT 25");
    const ms = meta("match_stats") || {};
    const matchRows = FW_ORDER.filter((f) => ms[f]).map((f) => ({ fw: f, ...ms[f] }));
    return {
      available: true, totals: { ...tot, beneficiarios: ben.n, matched: ben.matched }, fw, programas: prog, anos, anoFw, regioes: reg, tipos, top, municipios: munis, concelhos,
      agregado: agg, pessoas: pers, match: matchRows, built: meta("built"), sources: meta("sources"), errors: meta("errors"), blocked: meta("blocked"), labels: meta("fw_label"),
    };
  };

  routes["/api/fundos/search"] = (q) => {
    if (!mine) return missing();
    const page = Math.max(1, num(q.get("page"), 1)), limit = 25;
    const where = ["a.counts=1"], p = [];
    const text = (q.get("q") || "").trim();
    let from = "awards a";
    if (/^\d{9}$/.test(text)) { where.push("a.nif=?"); p.push(text); }
    else if (text) {
      const toks = strip(text).split(" ").filter(Boolean).slice(0, 6).map((t) => `"${t}"*`);
      if (toks.length) { from = "awards_fts f JOIN awards a ON a.id=f.rowid"; where.push("awards_fts MATCH ?"); p.push(toks.join(" ")); }
    }
    if (q.get("programa")) { where.push("a.programa=?"); p.push(q.get("programa")); }
    if (q.get("fw")) { where.push("a.fw=?"); p.push(q.get("fw")); }
    if (q.get("tipo")) { where.push("a.tipo=?"); p.push(q.get("tipo")); }
    if (q.get("regiao")) { where.push("a.regiao=?"); p.push(q.get("regiao")); }
    if (q.get("year")) { where.push("a.ano=?"); p.push(num(q.get("year"))); }
    if (q.get("min")) { where.push("a.aprovado>=?"); p.push(num(q.get("min"))); }
    const W = where.join(" AND ");
    const total = q1(`SELECT COUNT(*) n, COALESCE(SUM(a.aprovado),0) aprovado, COALESCE(SUM(a.pago),0) pago FROM ${from} WHERE ${W}`, ...p);
    const sort = q.get("sort") === "pago" ? "a.pago" : "a.aprovado";
    const rows = withIds(qa(`SELECT a.id, a.fw, a.code, a.role, a.nif, a.name, a.entity_id, a.match, a.tipo, a.programa, a.fundo, a.ano, a.titulo, a.estado, a.concelho, a.regiao, a.aprovado, a.pago, a.source_url
      FROM ${from} WHERE ${W} ORDER BY ${sort} DESC NULLS LAST LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit));
    return { total: total.n, aprovado: total.aprovado, pago: total.pago, page, limit, rows };
  };

  routes["/api/fundos/filters"] = () => {
    if (!mine) return missing();
    return {
      programas: qa("SELECT key FROM agg WHERE dim='programa' ORDER BY aprovado DESC LIMIT 60").map((r) => { const [fw, ...p] = r.key.split("|"); return { fw, programa: p.join("|") }; }),
      anos: qa("SELECT key FROM agg WHERE dim='ano' AND key>0 ORDER BY CAST(key AS INT) DESC").map((r) => +r.key),
      tipos: qa("SELECT key FROM agg WHERE dim='tipo' ORDER BY aprovado DESC").map((r) => r.key),
      regioes: qa("SELECT key FROM agg WHERE dim='regiao' ORDER BY aprovado DESC").map((r) => r.key),
    };
  };

  routes["/api/fundos/entity"] = (q) => {
    if (!mine) return missing();
    let nif = (q.get("nif") || "").trim();
    if (!/^\d{9}$/.test(nif)) return { available: true, matched: false, error: "NIF inválido" };
    const t = q1("SELECT COUNT(*) n, COALESCE(SUM(aprovado),0) aprovado, COALESCE(SUM(pago),0) pago FROM awards WHERE nif=? AND counts=1", nif);
    const aux = q1("SELECT COUNT(*) n, COALESCE(SUM(aprovado),0) aprovado FROM awards WHERE nif=? AND counts=0", nif);
    const interm = q1("SELECT SUM(n) n, SUM(contratado) contratado, SUM(pago) pago FROM prr_interm WHERE nif=?", nif);
    const contracts = qa("SELECT code, title, signed, contratado, subvencao, emprestimo, transferido, pago, estado, source_url FROM prr_contracts WHERE nif=? ORDER BY contratado DESC LIMIT 15", nif);
    const contractsTot = q1("SELECT COUNT(*) n, COALESCE(SUM(contratado),0) contratado, COALESCE(SUM(pago),0) pago FROM prr_contracts WHERE nif=?", nif);
    if (!t.n && !aux.n && !(interm && interm.n) && !contractsTot.n) return { available: true, matched: false, nif, built: meta("built") };
    const byFw = qa("SELECT fw, COUNT(*) n, SUM(aprovado) aprovado, SUM(pago) pago FROM awards WHERE nif=? AND counts=1 GROUP BY fw ORDER BY aprovado DESC", nif);
    const byYear = qa("SELECT ano year, COUNT(*) n, SUM(aprovado) value FROM awards WHERE nif=? AND counts=1 AND ano IS NOT NULL GROUP BY ano ORDER BY ano", nif);
    const byProg = qa("SELECT fw, programa, COUNT(*) n, SUM(aprovado) aprovado, SUM(pago) pago FROM awards WHERE nif=? AND counts=1 GROUP BY fw, programa ORDER BY aprovado DESC LIMIT 12", nif);
    const top = qa("SELECT fw, code, role, programa, ano, titulo, estado, concelho, aprovado, pago, source_url FROM awards WHERE nif=? AND counts=1 ORDER BY aprovado DESC NULLS LAST LIMIT 15", nif);
    const supplier = aux.n ? qa("SELECT fw, code, role, programa, titulo, aprovado, source_url FROM awards WHERE nif=? AND counts=0 ORDER BY aprovado DESC LIMIT 8", nif) : [];
    return { available: true, matched: true, nif, totals: t, auxiliary: aux, intermediary: interm && interm.n ? interm : null, contracts, contractsTotal: contractsTot, byFw, byYear, byProg, top, supplier, built: meta("built") };
  };

  // Projetos localizados num município (localização do investimento, não o beneficiário)
  routes["/api/fundos/concelho"] = (q) => {
    if (!mine) return missing();
    const key = muniKey(q.get("name"));
    if (!key) return { available: true, matched: false };
    const cand = qa("SELECT concelho, n, aprovado, pago FROM conc_totals");
    const r = cand.find((c) => strip(c.concelho) === key);
    if (!r) return { available: true, matched: false };
    return { available: true, matched: true, ...r, byFw: qa("SELECT fw, COUNT(DISTINCT code) n, SUM(aprovado) aprovado, SUM(pago) pago FROM locs WHERE concelho=? GROUP BY fw ORDER BY aprovado DESC", r.concelho) };
  };
}
