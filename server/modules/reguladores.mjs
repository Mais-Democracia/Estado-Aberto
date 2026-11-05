// Módulo "reguladores": /api/reguladores/*  (dados em data/reguladores.db, produzidos por ingest/jobs/reguladores.py)
export default function register({ db, one, all, routes, openData }) {
  const mine = openData("reguladores");
  const q = (sql, ...p) => { try { return mine ? mine.prepare(sql).all(...p) : []; } catch { return []; } };
  const q1 = (sql, ...p) => { try { return mine ? mine.prepare(sql).get(...p) : undefined; } catch { return undefined; } };
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const DIRECT = "(procedure LIKE 'Ajuste Direto%' OR procedure LIKE 'Ajuste direto%')";
  const NOMSG = "data/reguladores.db não existe; corra: python3 ingest/run_all.py reguladores";

  // contratação pública do organismo (comprador), a partir do registo do portal
  const spend = (nif) => {
    if (!nif) return null;
    const years = safe(() => all(`SELECT year, COUNT(*) n, SUM(price) value, SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) direct_n, SUM(CASE WHEN ${DIRECT} THEN price ELSE 0 END) direct_value FROM contracts WHERE buyer_nif = ? AND year >= 2012 GROUP BY year ORDER BY year`, nif), []);
    const tot = years.reduce((a, y) => ({ n: a.n + y.n, value: a.value + (y.value || 0), direct_n: a.direct_n + y.direct_n, direct_value: a.direct_value + (y.direct_value || 0) }), { n: 0, value: 0, direct_n: 0, direct_value: 0 });
    return { years, total: tot };
  };

  const boardOf = (slug) => q("SELECT holder, role, begin_date, end_date, active, origin, source_url FROM board WHERE body = ? ORDER BY active DESC, CASE WHEN role LIKE 'Presid%' OR role LIKE 'Governador%' OR role LIKE 'Provedor%' THEN 0 ELSE 1 END, begin_date DESC", slug);
  const leaderOf = (slug) => q1("SELECT holder, role, begin_date FROM board WHERE body = ? AND active = 1 ORDER BY CASE WHEN role LIKE 'Presid%' OR role LIKE 'Governador%' OR role LIKE 'Provedor%' THEN 0 ELSE 1 END, begin_date DESC LIMIT 1", slug);

  routes["/api/reguladores/overview"] = () => {
    if (!mine) return { error: NOMSG };
    const bodies = q("SELECT * FROM bodies ORDER BY ord");
    const meta = Object.fromEntries(q("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    const n = (sql, ...p) => q1(sql, ...p)?.n || 0;
    const topFines = q("SELECT d.id, d.body, b.short, d.date, d.year, d.title, d.amount, d.amount_note, d.url FROM decisions d JOIN bodies b ON b.slug = d.body WHERE d.amount > 0 ORDER BY d.amount DESC LIMIT 12");
    return {
      n_bodies: bodies.length, n_matched: bodies.filter((b) => b.nif).length,
      n_board: n("SELECT COUNT(*) n FROM board WHERE active = 1"), n_decisions: n("SELECT COUNT(*) n FROM decisions"),
      n_fines: n("SELECT COUNT(*) n FROM decisions WHERE amount > 0"), top_fines: topFines,
      fines_by_body: q("SELECT d.body, b.short, COUNT(*) n FROM decisions d JOIN bodies b ON b.slug = d.body WHERE d.amount > 0 GROUP BY d.body"),
      by_body: q("SELECT body, COUNT(*) n FROM decisions GROUP BY body"), meta,
    };
  };

  routes["/api/reguladores/lista"] = () => {
    if (!mine) return { error: NOMSG, bodies: [] };
    const bodies = q("SELECT * FROM bodies ORDER BY ord");
    const dec = Object.fromEntries(q("SELECT body, COUNT(*) n, SUM(amount > 0) n_fines, MAX(date) last FROM decisions GROUP BY body").map((r) => [r.body, r]));
    const out = bodies.map((b) => {
      const sp = spend(b.nif);
      const l = leaderOf(b.slug);
      return {
        slug: b.slug, short: b.short, name: b.name, grp: b.grp, site: b.site, nif: b.nif, robots: b.robots,
        leader: l || null, n_board: q1("SELECT COUNT(*) n FROM board WHERE body = ? AND active = 1", b.slug)?.n || 0,
        n_decisions: dec[b.slug]?.n || 0, n_fines: dec[b.slug]?.n_fines || 0,
        spend: sp ? sp.total.value : null, contracts: sp ? sp.total.n : null,
        direct_share: sp && sp.total.value ? sp.total.direct_value / sp.total.value : null,
      };
    });
    return { bodies: out, blocked: q("SELECT * FROM blocked"), meta: Object.fromEntries(q("SELECT key, value FROM meta").map((r) => [r.key, r.value])) };
  };

  routes["/api/reguladores/entidade"] = (p) => {
    if (!mine) return { error: NOMSG };
    const slug = p.get("slug");
    const b = q1("SELECT * FROM bodies WHERE slug = ?", slug);
    if (!b) return { error: "regulador não encontrado" };
    const sp = spend(b.nif);
    let suppliers = [], procs = [], eid = null;
    if (b.nif) {
      eid = safe(() => one("SELECT id FROM entities WHERE nif = ?", b.nif), null)?.id || null;
      suppliers = safe(() => all(`SELECT seller_nif nif, seller_name name, COUNT(*) n, SUM(price) value, SUM(CASE WHEN ${DIRECT} THEN price ELSE 0 END) direct_value FROM contracts WHERE buyer_nif = ? AND seller_nif IS NOT NULL GROUP BY seller_nif ORDER BY value DESC LIMIT 12`, b.nif), []);
      procs = safe(() => all("SELECT procedure, COUNT(*) n, SUM(price) value FROM contracts WHERE buyer_nif = ? GROUP BY procedure ORDER BY value DESC LIMIT 8", b.nif), []);
      for (const s of suppliers) s.eid = safe(() => one("SELECT id FROM entities WHERE nif = ?", s.nif), null)?.id || null;
    }
    const years = q("SELECT year, COUNT(*) n, SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) n_fines FROM decisions WHERE body = ? AND year IS NOT NULL GROUP BY year ORDER BY year", slug);
    const kinds = q("SELECT kind, COUNT(*) n, SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) n_fines FROM decisions WHERE body = ? GROUP BY kind ORDER BY n DESC", slug);
    const recent = q("SELECT id, kind, ref, date, year, title, subject, amount, url, source_url FROM decisions WHERE body = ? ORDER BY COALESCE(date, year) DESC, id DESC LIMIT 15", slug);
    const topFines = q("SELECT id, kind, ref, date, year, title, subject, amount, amount_note, url FROM decisions WHERE body = ? AND amount > 0 ORDER BY amount DESC LIMIT 10", slug);
    return {
      body: b, eid, board: boardOf(slug), dre: q("SELECT id, date, kind, number, title, source_url FROM dre_acts WHERE body = ? ORDER BY date DESC LIMIT 25", slug),
      spend: sp, suppliers, procs, years, kinds, recent, topFines,
      blocked: q("SELECT what, url, reason FROM blocked WHERE body IN (?, '*')", slug),
    };
  };

  routes["/api/reguladores/decisoes"] = (p) => {
    if (!mine) return { error: NOMSG, rows: [] };
    const where = [], args = [];
    const body = p.get("body"), ano = p.get("ano"), kind = p.get("kind"), s = (p.get("q") || "").trim();
    if (body) { where.push("d.body = ?"); args.push(body); }
    if (ano && /^\d{4}$/.test(ano)) { where.push("d.year = ?"); args.push(+ano); }
    if (kind) { where.push("d.kind = ?"); args.push(kind); }
    if (p.get("coima") === "1") where.push("d.amount > 0");
    for (const w of s.split(/\s+/).filter(Boolean).slice(0, 5)) {
      where.push("(d.title LIKE ? OR d.subject LIKE ? OR d.ref LIKE ?)");
      const l = "%" + w.replace(/[%_]/g, "") + "%"; args.push(l, l, l);
    }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const page = Math.max(1, +(p.get("page") || 1)), per = 25;
    const total = q1(`SELECT COUNT(*) n FROM decisions d ${W}`, ...args)?.n || 0;
    const rows = q(`SELECT d.id, d.body, b.short, d.kind, d.ref, d.date, d.year, d.title, d.subject, d.amount, d.amount_note, d.url, d.source_url FROM decisions d JOIN bodies b ON b.slug = d.body ${W} ORDER BY COALESCE(d.date, d.year || '-00') DESC, d.id DESC LIMIT ? OFFSET ?`, ...args, per, (page - 1) * per);
    return { total, page, per, rows, bodies: q("SELECT b.slug, b.short, COUNT(d.id) n FROM bodies b JOIN decisions d ON d.body = b.slug GROUP BY b.slug ORDER BY n DESC"), kinds: q("SELECT kind, COUNT(*) n FROM decisions GROUP BY kind ORDER BY n DESC") };
  };

  routes["/api/reguladores/coimas"] = (p) => {
    if (!mine) return { error: NOMSG };
    const ano = p.get("ano");
    const yw = ano && /^\d{4}$/.test(ano) ? " AND d.year = " + +ano : "";
    const per_year = q(`SELECT d.year, d.body, COUNT(*) n FROM decisions d WHERE d.amount > 0 AND d.year IS NOT NULL ${yw} GROUP BY d.year, d.body ORDER BY d.year`);
    const rows = q(`SELECT d.id, d.body, b.short, d.kind, d.ref, d.date, d.year, d.title, d.subject, d.amount, d.amount_note, d.url FROM decisions d JOIN bodies b ON b.slug = d.body WHERE d.amount > 0 ${yw} ORDER BY d.amount DESC LIMIT 50`);
    return { per_year, top: rows, meta_warnings: JSON.parse(q1("SELECT value FROM meta WHERE key='warnings'")?.value || "[]"),
      note: "Valores por decisão, lidos do texto do regulador (ver nota em cada linha). Não há total agregado: os valores ainda não estão todos verificados e o mesmo caso pode surgir em várias fases." };
  };

  // usado pelo hook da página de entidade
  routes["/api/reguladores/porNif"] = (p) => {
    const nif = p.get("nif");
    if (!mine || !nif) return { body: null };
    const b = q1("SELECT slug, short, name FROM bodies WHERE nif = ?", nif);
    if (!b) return { body: null };
    const l = leaderOf(b.slug);
    const d = q1("SELECT COUNT(*) n, SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) n_fines FROM decisions WHERE body = ?", b.slug);
    return { body: b, leader: l || null, n_decisions: d?.n || 0, n_fines: d?.n_fines || 0 };
  };
}
