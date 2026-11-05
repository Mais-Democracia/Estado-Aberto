// Education module: schools / agrupamentos / higher education, teacher lists (AGSE), DGEEC teacher stats,
// Parque Escolar (Construção Pública) portfolio, and procurement linkage to politica.db. See docs/MODULES.md.
export default function register({ db, all, one, has, num, like, routes, openData }) {
  const mine = openData("educacao");
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const missing = () => ({ available: false, note: "A base data/educacao.db ainda não foi gerada (python3 ingest/run_all.py educacao)." });
  const KINDS = { agrupamento: "Agrupamento de escolas", escola_nao_agrupada: "Escola não agrupada", escola_privada: "Escola privada", ensino_superior: "Ensino superior", outra: "Outra" };
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : null; } catch { return r ? r.value : null; } };

  function procurement(nif) {
    if (!nif || !has("contracts")) return null;
    const tot = one("SELECT COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN procedure LIKE '%diret%' THEN price END),0) direct_value FROM contracts WHERE buyer_nif = ?", nif);
    if (!tot || !tot.n) return { n: 0 };
    return {
      ...tot,
      years: all("SELECT year, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN procedure LIKE '%diret%' THEN price END),0) direct_value FROM contracts WHERE buyer_nif = ? AND year IS NOT NULL GROUP BY year ORDER BY year", nif),
      topSuppliers: all("SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif = ? GROUP BY seller_nif ORDER BY value DESC LIMIT 8", nif),
      recent: all("SELECT id, signed, object, price, seller_name FROM contracts WHERE buyer_nif = ? ORDER BY signed DESC LIMIT 10", nif),
    };
  }

  routes["/api/educacao/overview"] = () => {
    if (!mine) return missing();
    const byKind = qa("SELECT kind, nature, COUNT(*) n, COALESCE(SUM(students),0) students FROM units GROUP BY kind, nature ORDER BY n DESC");
    const lists = qa("SELECT family, kind, school_year, COUNT(*) pdfs, COALESCE(SUM(n_rows),0) rows_n, MAX(pub_date) last_pub FROM teacher_lists WHERE parsed=1 AND kind!='skip' GROUP BY family, kind, school_year");
    const stats = qa("SELECT indicator, title, grp, series, year, value, source_url FROM teacher_stats WHERE indicator IN ('1.8','3.9','5.9') ORDER BY indicator, grp, series, year");
    const districts = qa("SELECT district, COUNT(*) n, COALESCE(SUM(students),0) students FROM units WHERE district IS NOT NULL AND kind IN ('agrupamento','escola_nao_agrupada') GROUP BY district ORDER BY n DESC");
    return {
      available: true,
      counts: {
        units: q1("SELECT COUNT(*) n FROM units").n,
        agrupamentos: q1("SELECT COUNT(*) n FROM units WHERE kind='agrupamento'").n,
        ena: q1("SELECT COUNT(*) n FROM units WHERE kind='escola_nao_agrupada'").n,
        privadas: q1("SELECT COUNT(*) n FROM units WHERE kind='escola_privada'").n,
        superior: q1("SELECT COUNT(*) n FROM units WHERE kind='ensino_superior'").n,
        schools: q1("SELECT COUNT(*) n FROM schools").n,
        students_year: q1("SELECT MAX(students_year) y FROM units").y,
        students: q1("SELECT COALESCE(SUM(students),0) n FROM units WHERE kind != 'ensino_superior'").n,
        vagas: q1("SELECT COALESCE(SUM(vagas_2026),0) n FROM units WHERE kind='ensino_superior'").n,
        teacher_rows: q1("SELECT COUNT(*) n FROM teacher_entries").n,
        teacher_lists: q1("SELECT COUNT(*) n FROM teacher_lists WHERE parsed=1 AND kind!='skip'").n,
        pe_schools: q1("SELECT COUNT(*) n FROM pe_schools").n,
      },
      byKind, lists, stats, districts, matchStats: meta("match_stats"), builtAt: meta("built_at"),
    };
  };

  routes["/api/educacao/escolas"] = (q) => {
    if (!mine) return missing();
    const where = ["1=1"], args = [];
    const text = (q.get("q") || "").trim();
    if (text) { where.push("(u.name LIKE ? OR u.code = ? OR u.norm LIKE ?)"); args.push(like(text), text, like(strip(text).toLowerCase())); }
    if (q.get("municipio")) { where.push("u.municipality LIKE ?"); args.push(like(q.get("municipio"))); }
    if (q.get("distrito")) { where.push("u.district LIKE ?"); args.push(like(q.get("distrito"))); }
    if (q.get("nature")) { where.push("u.nature = ?"); args.push(q.get("nature")); }
    if (q.get("kind")) { where.push("u.kind = ?"); args.push(q.get("kind")); }
    if (q.get("level")) { where.push("u.students_json LIKE ?"); args.push(like(q.get("level"))); }
    const limit = 40, page = num(q.get("page"), 1);
    const order = q.get("sort") === "name" ? "u.name" : "COALESCE(u.students,0) DESC, u.vagas_2026 DESC, u.name";
    const total = q1(`SELECT COUNT(*) n FROM units u WHERE ${where.join(" AND ")}`, ...args).n;
    const rows = qa(`SELECT u.code, u.name, u.kind, u.nature, u.subsystem, u.municipality, u.district, u.website, u.students, u.students_year, u.students_json, u.vagas_2026, u.nif, u.entity_id
                     FROM units u WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    const schoolsMatch = text.length >= 3 || q.get("municipio")
      ? qa(`SELECT code, name, municipality, levels, students FROM schools WHERE ${text ? "(name LIKE ? OR code = ? OR norm LIKE ?)" : "1=1"} ${q.get("municipio") ? "AND municipality LIKE ?" : ""} ORDER BY students DESC LIMIT 25`,
        ...(text ? [like(text), text, like(strip(text).toLowerCase())] : []), ...(q.get("municipio") ? [like(q.get("municipio"))] : []))
      : [];
    return {
      available: true, total, page, limit, kindLabels: KINDS, schoolsMatch,
      rows: rows.map((r) => ({ ...r, students_json: r.students_json ? JSON.parse(r.students_json) : null })),
      facets: { districts: qa("SELECT district d, COUNT(*) n FROM units WHERE district IS NOT NULL GROUP BY district ORDER BY d").map((x) => x.d) },
    };
  };

  routes["/api/educacao/escola"] = (q) => {
    if (!mine) return missing();
    let u = null;
    if (q.get("id")) u = q1("SELECT * FROM units WHERE code = ?", q.get("id"));
    if (!u && q.get("nif")) u = q1("SELECT * FROM units WHERE nif = ?", q.get("nif"));
    if (!u && q.get("entity")) u = q1("SELECT * FROM units WHERE entity_id = ?", Number(q.get("entity")));
    if (!u) return null;
    const schools = qa("SELECT code, name, municipality, levels, students, students_year FROM schools WHERE unit_code = ? OR code = ? ORDER BY students DESC", u.code, u.code);
    // The open data does not publish the agrupamento -> school hierarchy, so we only offer the schools of the same municipality (clearly labelled in the UI).
    const munSchools = u.municipality && u.kind !== "ensino_superior" ? qa("SELECT code, name, municipality, levels, students FROM schools WHERE municipality = ? ORDER BY students DESC LIMIT 40", u.municipality) : [];
    const placed = u.kind === "ensino_superior" ? [] : qa(
      `SELECT l.kind, l.school_year, l.page_title, l.pub_date, l.pdf_url, l.group_code, l.group_name, COUNT(*) n
       FROM teacher_entries e JOIN teacher_lists l ON l.id = e.list_id WHERE e.placed_code = ? GROUP BY l.id ORDER BY l.pub_date DESC, l.group_code`, u.code);
    const pe = qa("SELECT id, name, phase, architect, completed, source_url FROM pe_schools WHERE unit_code = ?", u.code);
    return {
      available: true,
      unit: { ...u, students_json: u.students_json ? JSON.parse(u.students_json) : null, kindLabel: KINDS[u.kind] || u.kind },
      schools, munSchools, placedSummary: placed, nPlaced: placed.reduce((a, b) => a + b.n, 0), parqueEscolar: pe,
      procurement: procurement(u.nif),
      entity: u.entity_id ? one("SELECT id, name, nif, kind FROM entities WHERE id = ?", u.entity_id) : null,
    };
  };

  // Teacher lists: only the content the official body (AGSE) itself publishes as public lists. A filter is required
  // so the endpoint cannot be used to dump the whole table.
  routes["/api/educacao/docentes"] = (q) => {
    if (!mine) return missing();
    const where = ["l.kind != 'skip'"], args = [];
    const name = strip(q.get("q") || "");
    const school = (q.get("school") || "").trim(), group = (q.get("group") || "").trim(), kind = (q.get("kind") || "").trim();
    const hasFilter = name.length >= 3 || school || group || kind;
    if (name.length >= 3) { where.push("e.name_norm LIKE ?"); args.push(`%${name}%`); }
    if (school) { where.push("e.placed_code = ?"); args.push(school); }
    if (group) { where.push("l.group_code = ?"); args.push(group); }
    if (kind) { where.push("l.kind = ?"); args.push(kind); }
    if (q.get("sit")) { where.push("e.situacao = ?"); args.push(q.get("sit")); }
    const facets = {
      kinds: qa("SELECT kind, school_year, COUNT(*) pdfs, SUM(n_rows) n FROM teacher_lists WHERE parsed=1 AND kind!='skip' GROUP BY kind, school_year ORDER BY school_year DESC"),
      groups: qa("SELECT group_code c, MAX(group_name) n FROM teacher_lists WHERE parsed=1 AND kind!='skip' AND group_code IS NOT NULL GROUP BY group_code ORDER BY group_code"),
      lists: qa("SELECT page_title, page_url, kind, pub_date, COUNT(*) pdfs, SUM(n_rows) n FROM teacher_lists WHERE parsed=1 AND kind!='skip' GROUP BY page_url ORDER BY pub_date DESC, page_title LIMIT 60"),
    };
    if (!hasFilter) return { available: true, needFilter: true, facets, rows: [], total: 0, page: 1, limit: 50 };
    const limit = 50, page = num(q.get("page"), 1);
    const total = q1(`SELECT COUNT(*) n FROM teacher_entries e JOIN teacher_lists l ON l.id = e.list_id WHERE ${where.join(" AND ")}`, ...args).n;
    const rows = qa(`SELECT e.name, e.ordem, e.tipo, e.graduacao, e.situacao, e.sublist, e.placed_code, COALESCE(u.name, e.placed_name) placed_name, e.provimento,
                            l.kind, l.school_year, l.group_code, l.group_name, l.page_title, l.pub_date, l.pdf_url, l.page_url
                     FROM teacher_entries e JOIN teacher_lists l ON l.id = e.list_id LEFT JOIN units u ON u.code = e.placed_code
                     WHERE ${where.join(" AND ")} ORDER BY l.pub_date DESC, l.group_code, e.sublist, e.ordem LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    return { available: true, total, page, limit, rows, facets, privacy: "Listas publicadas pela AGSE (ex-DGAE). Não são guardados o número de utilizador nem a data de nascimento constantes dos PDFs." };
  };

  routes["/api/educacao/estatisticas-docentes"] = (q) => {
    if (!mine) return missing();
    const ind = q.get("indicator");
    if (!ind) return { available: true, indicators: qa("SELECT indicator, MIN(title) title, MIN(source_url) source_url, COUNT(*) n FROM teacher_stats GROUP BY indicator ORDER BY CAST(SUBSTR(indicator,1,INSTR(indicator,'.')-1) AS INT), CAST(SUBSTR(indicator,INSTR(indicator,'.')+1) AS INT)") };
    return { available: true, rows: qa("SELECT indicator, title, grp, series, year, value, source_url FROM teacher_stats WHERE indicator = ? ORDER BY grp, series, year", ind) };
  };

  routes["/api/educacao/parque-escolar"] = (q) => {
    if (!mine) return missing();
    const where = ["1=1"], args = [];
    if (q.get("q")) { where.push("(name LIKE ? OR address LIKE ? OR architect LIKE ?)"); const l = like(q.get("q")); args.push(l, l, l); }
    if (q.get("distrito")) { where.push("district = ?"); args.push(q.get("distrito")); }
    if (q.get("phase")) { where.push("phase = ?"); args.push(q.get("phase")); }
    const schools = qa(`SELECT id, name, phase, district, architect, address, postcode, lat, lon, completed, indicators_json, unit_code, source_url FROM pe_schools WHERE ${where.join(" AND ")} ORDER BY district, name LIMIT 300`, ...args)
      .map((r) => ({ ...r, indicators: r.indicators_json ? JSON.parse(r.indicators_json) : {}, indicators_json: undefined }));
    // The legal entity is the same (NIF 508069645): Parque Escolar, E.P.E. -> Construção Pública, E.P.E. since June 2023.
    const nif = "508069645";
    const ent = has("entities") ? one("SELECT id, name, nif FROM entities WHERE nif = ?", nif) : null;
    let proc = null;
    if (has("contracts")) {
      proc = {
        total: one("SELECT COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif = ?", nif),
        years: all("SELECT year, COUNT(*) n, COALESCE(SUM(price),0) value, COALESCE(SUM(CASE WHEN procedure LIKE '%diret%' THEN price END),0) direct_value FROM contracts WHERE buyer_nif = ? AND year IS NOT NULL GROUP BY year ORDER BY year", nif),
        biggest: all("SELECT id, signed, object, price, seller_name, seller_nif FROM contracts WHERE buyer_nif = ? ORDER BY price DESC LIMIT 10", nif),
        topSuppliers: all("SELECT seller_nif nif, MAX(seller_name) name, COUNT(*) n, COALESCE(SUM(price),0) value FROM contracts WHERE buyer_nif = ? GROUP BY seller_nif ORDER BY value DESC LIMIT 10", nif),
      };
    }
    return {
      available: true,
      body: { name_old: "Parque Escolar, E.P.E.", name_now: "Construção Pública, E.P.E.", nif, entity: ent, created: "2007 (DL n.º 41/2007)", restructured: "junho de 2023 — mudou de denominação e alargou o objeto à habitação pública",
        wikidata: "Q56350139", website: "https://www.construcaopublica.gov.pt", programme: "PMEES — Programa de Modernização do Parque Escolar destinado ao Ensino Secundário (RCM n.º 1/2007)" },
      totals: qa("SELECT label, value, source_url FROM pe_totals"),
      docs: qa("SELECT title, category, year, url FROM pe_docs ORDER BY category, year DESC, title"),
      districts: qa("SELECT district d, COUNT(*) n FROM pe_schools GROUP BY district ORDER BY d").map((x) => x.d),
      phases: qa("SELECT phase p, COUNT(*) n FROM pe_schools GROUP BY phase ORDER BY phase"),
      schools, procurement: proc,
    };
  };
}
