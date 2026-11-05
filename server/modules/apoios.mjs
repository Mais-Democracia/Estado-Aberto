// Apoios públicos (cultura, desporto, juventude, ciência): quem recebe subvenções, por beneficiário.
// Dados: data/apoios.db (ingest/jobs/apoios.py). Rotas: /api/apoios/overview, /search, /filters, /entidade.
// Pessoas singulares: nunca expostas por nome/NIF (só agregadas). Ligação ao registo por NIF; nomes só se exatos e não ambíguos.
export default function register({ all, one, has, num, routes, openData }) {
  let mine = openData("apoios");
  const open = () => { if (!mine) mine = openData("apoios"); return mine; };
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const meta = (k) => { try { const r = q1("SELECT value FROM meta WHERE key=?", k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const missing = () => ({ available: false, note: "A base data/apoios.db ainda não foi gerada (python3 ingest/run_all.py apoios)." });
  const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const AREAS = { cultura: "Cultura", desporto: "Desporto", juventude: "Juventude", ciencia: "Ciência" };

  // ids do registo mudam se politica.db for reconstruído: resolve-se sempre pelo NIF no momento do pedido
  const ents = (nifs) => {
    nifs = [...new Set(nifs.filter(Boolean))];
    if (!nifs.length || !has("entities")) return new Map();
    const out = new Map();
    for (let i = 0; i < nifs.length; i += 400) {
      const part = nifs.slice(i, i + 400);
      for (const e of all(`SELECT id, nif, name, kind FROM entities WHERE nif IN (${part.map(() => "?").join(",")})`, ...part)) out.set(e.nif, e);
    }
    return out;
  };
  const decorate = (rows) => {
    const m = ents(rows.map((r) => r.ent_nif));
    return rows.map((r) => {
      if (r.pessoa_singular) return { ...r, nome: "Pessoa singular (identificação omitida)", nif: null, ent_nif: null, entity_id: null, match: null };
      const e = r.ent_nif ? m.get(r.ent_nif) : null;
      return { ...r, entity_id: e ? e.id : null, ekind: e ? e.kind : null };
    });
  };
  // concentração: quota dos 10 maiores beneficiários (exclui pessoas singulares do ranking; estas contam no total)
  const concentration = (rows) => {
    const sorted = rows.filter((r) => !r.pers).map((r) => r.total).sort((a, b) => b - a);
    const all_ = rows.reduce((a, r) => a + r.total, 0);
    const top10 = sorted.slice(0, 10).reduce((a, b) => a + b, 0);
    const hhi = all_ ? rows.reduce((a, r) => a + (r.total / all_) ** 2, 0) : 0;
    return { top10, share: all_ ? top10 / all_ : 0, nben: rows.length, hhi };
  };

  routes["/api/apoios/overview"] = () => {
    if (!open()) return missing();
    const tot = q1("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total, MIN(year) y0, MAX(year) y1 FROM apoios");
    const nb = q1("SELECT COUNT(*) n, SUM(pessoa_singular=0 AND ent_nif IS NOT NULL) matched, SUM(pessoa_singular) pers FROM ben");
    const pers = q1("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM apoios WHERE pessoa_singular=1");
    const matchedVal = q1("SELECT COALESCE(SUM(amount),0) v FROM apoios WHERE ent_nif IS NOT NULL").v;
    const perBen = (where, ...p) => qa(`SELECT bkey, pessoa_singular pers, SUM(amount) total FROM apoios ${where} GROUP BY bkey`, ...p);
    const areas = qa("SELECT area, COUNT(*) n, SUM(amount) total, COUNT(DISTINCT year) anos, MIN(year) y0, MAX(year) y1 FROM apoios GROUP BY area ORDER BY total DESC").map((a) => ({ ...a, label: AREAS[a.area] || a.area, conc: concentration(perBen("WHERE area=?", a.area)) }));
    const orgaos = qa("SELECT orgao, area, COUNT(*) n, SUM(amount) total, MIN(year) y0, MAX(year) y1 FROM apoios GROUP BY orgao, area ORDER BY total DESC");
    const anos = qa("SELECT area, year, COUNT(*) n, SUM(amount) value FROM apoios WHERE year IS NOT NULL GROUP BY area, year ORDER BY year");
    let partial = []; try { partial = qa("SELECT area, orgao, year, kind, note, short FROM partial ORDER BY area, year"); } catch {}
    const familias = qa("SELECT orgao, area, familia, COUNT(*) n, SUM(amount) total, MIN(year) y0, MAX(year) y1 FROM apoios GROUP BY orgao, familia ORDER BY total DESC LIMIT 24");
    for (const f of familias) {
      f.conc = concentration(perBen("WHERE orgao=? AND familia=?", f.orgao, f.familia));
      f.top = decorate(qa(`SELECT bkey, MAX(nif) nif, MAX(ent_nif) ent_nif, MAX(nome) nome, MAX("match") "match", MAX(pessoa_singular) pessoa_singular, COUNT(*) n, SUM(amount) total FROM apoios WHERE orgao=? AND familia=? AND pessoa_singular=0 GROUP BY bkey ORDER BY total DESC LIMIT 6`, f.orgao, f.familia));
    }
    const top = decorate(qa(`SELECT bkey, nif, ent_nif, nome, "match", pessoa_singular, n, total, areas, orgaos, primeiro, ultimo, fundos_overlap FROM ben WHERE pessoa_singular=0 ORDER BY total DESC LIMIT 25`));
    const sources = qa("SELECT orgao, name, url, year, rows, total, status, note FROM sources ORDER BY orgao, year DESC, name");
    const srcSum = qa("SELECT orgao, COUNT(*) files, SUM(rows) rows, SUM(status='ok') ok, SUM(status!='ok') problems FROM sources GROUP BY orgao");
    const matchBy = qa(`SELECT orgao, COUNT(*) n, SUM("match"='nif') m_nif, SUM("match"='nome') m_nome, SUM("match"='alias') m_alias, SUM(pessoa_singular) pers, SUM(amount) val, SUM(CASE WHEN "match" IS NOT NULL THEN amount ELSE 0 END) m_val FROM apoios GROUP BY orgao`);
    const m = meta("match") || {};
    return {
      available: true, totals: { ...tot, beneficiarios: nb.n - nb.pers, matched: nb.matched, matchedVal, pessoas: pers }, areas, orgaos, anos, partial, familias, top, sources, srcSum, matchBy,
      matchStats: m, fundosOverlap: meta("fundos_overlap_ciencia"), built: meta("built"), blocked: meta("blocked"),
    };
  };

  routes["/api/apoios/filters"] = () => {
    if (!open()) return missing();
    return {
      familias: qa("SELECT orgao, area, familia, SUM(amount) total FROM apoios GROUP BY orgao, familia ORDER BY total DESC").map((r) => ({ key: `${r.orgao}|${r.familia}`, orgao: r.orgao, area: r.area, familia: r.familia })),
      anos: qa("SELECT DISTINCT year FROM apoios WHERE year IS NOT NULL ORDER BY year DESC").map((r) => r.year),
      areas: Object.entries(AREAS).map(([k, v]) => ({ key: k, label: v })),
      orgaos: qa("SELECT DISTINCT orgao FROM apoios ORDER BY orgao").map((r) => r.orgao),
    };
  };

  routes["/api/apoios/search"] = (q) => {
    if (!open()) return missing();
    const page = Math.max(1, num(q.get("page"), 1)), limit = 25;
    const where = ["1=1"], p = [];
    const text = (q.get("q") || "").trim();
    if (/^\d{9}$/.test(text)) { where.push("(nif=? OR ent_nif=?) AND pessoa_singular=0"); p.push(text, text); }
    else if (text) {
      const toks = strip(text).split(" ").filter(Boolean).slice(0, 5);
      // pessoas singulares não são pesquisáveis por nome (privacidade): só entidades e títulos de obras/projetos
      for (const t of toks) { where.push("(nome_norm LIKE ? OR UPPER(COALESCE(detalhe,'')) LIKE ?)"); p.push(`%${t}%`, `%${t}%`); }
      where.push("pessoa_singular=0");
    }
    const prog = q.get("programa");
    if (prog) { const [o, ...f] = prog.split("|"); where.push("orgao=? AND familia=?"); p.push(o, f.join("|")); }
    if (q.get("area")) { where.push("area=?"); p.push(q.get("area")); }
    if (q.get("orgao")) { where.push("orgao=?"); p.push(q.get("orgao")); }
    if (q.get("ano")) { where.push("year=?"); p.push(num(q.get("ano"))); }
    if (q.get("min")) { where.push("amount>=?"); p.push(num(q.get("min"))); }
    const W = where.join(" AND ");
    const t = q1(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) total, COUNT(DISTINCT bkey) nben FROM apoios WHERE ${W}`, ...p);
    const rows = decorate(qa(`SELECT id, area, orgao, programa, familia, detalhe, year, nif, nome, pessoa_singular, amount, status, data_decisao, regiao, source_url, ent_nif, "match"
      FROM apoios WHERE ${W} ORDER BY amount DESC, id LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit));
    return { total: t.n, amount: t.total, nben: t.nben, page, limit, rows };
  };

  routes["/api/apoios/entidade"] = (q) => {
    if (!open()) return missing();
    const nif = (q.get("nif") || "").trim();
    if (!/^\d{9}$/.test(nif)) return { available: true, matched: false, error: "NIF inválido" };
    const t = q1("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total, MIN(year) y0, MAX(year) y1 FROM apoios WHERE (ent_nif=? OR nif=?) AND pessoa_singular=0", nif, nif);
    if (!t.n) return { available: true, matched: false, nif, built: meta("built") };
    const W = "(ent_nif=? OR nif=?) AND pessoa_singular=0";
    const byYear = qa(`SELECT year, COUNT(*) n, SUM(amount) value FROM apoios WHERE ${W} AND year IS NOT NULL GROUP BY year ORDER BY year`, nif, nif);
    const byProg = qa(`SELECT orgao, area, familia, COUNT(*) n, SUM(amount) total, MIN(year) y0, MAX(year) y1, MAX("match") "match" FROM apoios WHERE ${W} GROUP BY orgao, familia ORDER BY total DESC`, nif, nif);
    const rows = qa(`SELECT area, orgao, programa, familia, detalhe, year, amount, status, nome, source_url, "match" FROM apoios WHERE ${W} ORDER BY year DESC, amount DESC LIMIT 60`, nif, nif);
    const b = q1("SELECT fundos_overlap FROM ben WHERE ent_nif=? OR nif=?", nif, nif);
    const rank = q1("SELECT COUNT(*) r FROM ben WHERE pessoa_singular=0 AND total > ?", t.total);
    const nben = q1("SELECT COUNT(*) n FROM ben WHERE pessoa_singular=0").n;
    return { available: true, matched: true, nif, totals: t, byYear, byProg, rows, fundosOverlap: b ? b.fundos_overlap : null, rank: rank.r + 1, nben, built: meta("built") };
  };
}
