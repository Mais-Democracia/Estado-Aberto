export default function register({ db, one, has, num, routes, openData }) {
  const mine = openData("igf");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const meta = (k) => q1("SELECT value FROM meta WHERE key=?", k)?.value ?? null;
  const missing = () => ({ available: false, note: "A base data/igf.db ainda não foi gerada (python3 ingest/run_all.py igf)." });
  const entityByNif = (nif) => { try { return nif && has("entities") ? one("SELECT id, name, kind FROM entities WHERE nif = ?", nif) : null; } catch { return null; } };
  const COLS = "code, year, num, title, subject, kind, report_url, n_docs, match_kind, entity_nif, entity_name, source_url";
  const withEntity = (r) => { const e = entityByNif(r.entity_nif); return { ...r, eid: e ? e.id : null, ename: e ? e.name : null }; };

  routes["/api/igf/overview"] = () => {
    if (!mine) return missing();
    return {
      available: true,
      total: q1("SELECT COUNT(*) n, SUM(entity_nif IS NOT NULL) linked, MIN(year) y0, MAX(year) y1 FROM reports"),
      years: qa("SELECT year, COUNT(*) n, SUM(kind='municipio') municipios, SUM(kind='entidade') entidades, SUM(kind='tematico') tematicos FROM reports WHERE year IS NOT NULL GROUP BY year ORDER BY year"),
      kinds: qa("SELECT kind, COUNT(*) n FROM reports GROUP BY kind ORDER BY n DESC"),
      built: meta("built"), source: meta("source"), errors: meta("errors"),
      note: "A listagem pública do IGF pagina de forma instável; a base é a união de várias pesquisas e pode não incluir todos os relatórios publicados.",
    };
  };

  routes["/api/igf/relatorios"] = (q) => {
    if (!mine) return missing();
    const where = [], p = [];
    const year = num(q.get("year"), 0, 0), kind = q.get("kind") || "", s = (q.get("q") || "").trim().slice(0, 80);
    if (year) { where.push("year = ?"); p.push(year); }
    if (kind) { where.push("kind = ?"); p.push(kind); }
    if (s) { where.push("title LIKE ? ESCAPE '\\'"); p.push("%" + s.replace(/[\\%_]/g, "\\$&") + "%"); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = 50, page = Math.max(1, num(q.get("page"), 1, 1));
    const total = q1(`SELECT COUNT(*) n FROM reports ${w}`, ...p).n;
    const rows = qa(`SELECT ${COLS} FROM reports ${w} ORDER BY year DESC, num DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit).map(withEntity);
    return { total, page, limit, rows };
  };

  routes["/api/igf/relatorio"] = (q) => {
    if (!mine) return missing();
    const code = q.get("code") || "";
    const r = q1(`SELECT ${COLS} FROM reports WHERE code = ?`, code);
    if (!r) return { available: true, row: null };
    return { available: true, row: withEntity(r), docs: qa("SELECT label, filename, url FROM docs WHERE code = ?", code) };
  };

  routes["/api/igf/entidade"] = (q) => {
    if (!mine) return { rows: [] };
    const id = num(q.get("id"), 0, 0);
    if (!id || !has("entities")) return { rows: [] };
    const e = one("SELECT nif FROM entities WHERE id = ?", id);
    if (!e || !e.nif) return { rows: [] };
    return { rows: qa(`SELECT ${COLS} FROM reports WHERE entity_nif = ? ORDER BY year DESC, num DESC`, e.nif), method: "Associação por nome exato normalizado («Município de …» ou nome da entidade)" };
  };
}
