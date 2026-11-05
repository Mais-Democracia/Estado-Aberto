// Módulo "eleicoes": resultados eleitorais nacionais (legislativas, presidenciais, europeias, regionais) por território.
// Dados: data/eleicoes.db (ingest/jobs/eleicoes.py; fonte MAI/SGMAI). Autárquicas ficam em /api/autarquias/*.
export default function register({ one, routes, openData }) {
  const mine = openData("eleicoes");
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const missing = () => ({ available: false, note: "A base data/eleicoes.db ainda não foi gerada (python3 ingest/run_all.py eleicoes)." });
  const ok = () => !!mine && !!q1("SELECT 1 x FROM sqlite_master WHERE name='elections'");

  const LEVELS = ["nacional", "distrito", "concelho", "estrangeiro", "territorio", "freguesia"];
  const summaryOf = (id, level, code) => q1("SELECT * FROM summary WHERE election_id=? AND level=? AND code=?", id, level, code);
  const resultsOf = (id, level, code) => qa("SELECT party, family, votes, pct, valid_pct, mandates FROM results WHERE election_id=? AND level=? AND code=? ORDER BY votes DESC", id, level, code);

  routes["/api/eleicoes/list"] = () => {
    if (!ok()) return missing();
    const elections = qa(`SELECT e.*, s.registered, s.voters, s.turnout, s.abstention_pct, s.blank, s.blank_pct, s.null_votes, s.null_pct, s.mandates total_mandates
      FROM elections e LEFT JOIN summary s ON s.election_id = e.id AND s.level='nacional' ORDER BY e.date DESC`);
    for (const e of elections) {
      const w = q1("SELECT party, votes, pct, mandates FROM results WHERE election_id=? AND level='nacional' ORDER BY votes DESC LIMIT 1", e.id);
      e.winner = w || null;
      e.has_data = !!e.registered || !!e.voters;
      e.counts = { distrito: q1("SELECT COUNT(*) n FROM summary WHERE election_id=? AND level='distrito'", e.id).n, concelho: q1("SELECT COUNT(*) n FROM summary WHERE election_id=? AND level='concelho'", e.id).n };
    }
    return {
      available: true, elections,
      built: (q1("SELECT value FROM meta WHERE key='built'") || {}).value || null,
      coverage: {
        have: "Legislativas 2005–2025, presidenciais 2006–2026 (incl. 1.ª e 2.ª voltas de 2026), europeias 2009–2024, regionais da Madeira 2019–2025 e dos Açores 2020/2024: total nacional (incl. emigração), distrito/círculo e concelho (MAI/SGMAI). Legislativas 1975–2002, presidenciais 1976–2001, europeias 1987–2004 e referendos de 1998 e 2007: só totais nacionais (transcritos da Wikipedia, fonte original CNE/STAPE).",
        missing: "Antes de 2005 não há resultados por distrito/concelho em formato aberto (sites antigos do MAI só em HTML; STAPE/CNE em PDF). Resultados por freguesia, desagregação do voto no estrangeiro por consulado e regionais anteriores a 2019/2020 não estão ingeridos. Autárquicas 2017/2021/2025: ver o separador Câmaras: poder e contas.",
      },
    };
  };

  routes["/api/eleicoes/eleicao"] = (q) => {
    if (!ok()) return missing();
    const id = q.get("id");
    const e = q1("SELECT * FROM elections WHERE id=?", id);
    if (!e) return { available: true, found: false };
    const nat = e.scope === "LOCAL-500000" ? "LOCAL-500000" : e.scope;
    const natCode = q1("SELECT code FROM summary WHERE election_id=? AND level='nacional'", id)?.code || nat;
    const results = resultsOf(id, "nacional", natCode);
    const districts = qa(`SELECT t.code, t.name, s.registered, s.voters, s.turnout, s.mandates FROM territories t JOIN summary s ON s.election_id=t.election_id AND s.level=t.level AND s.code=t.code
      WHERE t.election_id=? AND t.level='distrito' ORDER BY t.name`, id);
    // trend with the previous election of the same type
    const prev = q1("SELECT id, name, year FROM elections WHERE type=? AND date < ? ORDER BY date DESC LIMIT 1", e.type, e.date);
    return {
      available: true, found: true, election: e, national: summaryOf(id, "nacional", natCode), results, districts, previous: prev || null,
      previous_results: prev ? resultsOf(prev.id, "nacional", natCode) : [], previous_summary: prev ? summaryOf(prev.id, "nacional", natCode) : null,
      source_url: e.source_url,
    };
  };

  routes["/api/eleicoes/territorio"] = (q) => {
    if (!ok()) return missing();
    const id = q.get("id"), nivel = q.get("nivel") || "distrito", code = q.get("code");
    if (!LEVELS.includes(nivel)) return { available: true, found: false };
    const e = q1("SELECT * FROM elections WHERE id=?", id);
    if (!e) return { available: true, found: false };
    if (code) {
      const t = q1("SELECT * FROM territories WHERE election_id=? AND level=? AND code=?", id, nivel, code);
      return { available: true, found: !!t, election: e, territory: t, summary: summaryOf(id, nivel, code), results: resultsOf(id, nivel, code), source_url: summaryOf(id, nivel, code)?.source_url };
    }
    const parent = q.get("parent");
    const rows = qa(`SELECT t.code, t.name, t.parent, s.registered, s.voters, s.turnout, s.blank_pct, s.null_pct, s.mandates, s.source_url, ${nivel === "freguesia" ? "(SELECT entity_id FROM freguesias f WHERE f.code=t.code)" : "NULL"} entity_id,
        (SELECT party FROM results r WHERE r.election_id=t.election_id AND r.level=t.level AND r.code=t.code ORDER BY votes DESC LIMIT 1) winner,
        (SELECT pct FROM results r WHERE r.election_id=t.election_id AND r.level=t.level AND r.code=t.code ORDER BY votes DESC LIMIT 1) winner_pct,
        (SELECT valid_pct FROM results r WHERE r.election_id=t.election_id AND r.level=t.level AND r.code=t.code ORDER BY votes DESC LIMIT 1) winner_valid
      FROM territories t JOIN summary s ON s.election_id=t.election_id AND s.level=t.level AND s.code=t.code
      WHERE t.election_id=? AND t.level=? ${parent ? "AND t.parent=?" : ""} ORDER BY t.name LIMIT 400`, ...(parent ? [id, nivel, parent] : [id, nivel]));
    return { available: true, found: true, election: e, level: nivel, rows };
  };

  function dicoOf(q) {
    let dico = q.get("dico");
    if (dico) return dico;
    const eid = q.get("entity_id");
    if (!eid) return null;
    const ent = one("SELECT id, nif, name, dico FROM entities WHERE id=? AND kind='municipio'", eid);
    if (!ent) return null;
    const m = (ent.nif && q1("SELECT dico FROM municipios WHERE nif=?", ent.nif)) || q1("SELECT dico FROM municipios WHERE entity_id=?", ent.id);
    return m ? m.dico : null;
  }

  routes["/api/eleicoes/municipio"] = (q) => {
    if (!ok()) return missing();
    const dico = dicoOf(q);
    if (!dico) return { available: true, found: false };
    const m = q1("SELECT * FROM municipios WHERE dico=?", dico);
    const elections = qa(`SELECT e.id, e.type, e.year, e.round, e.date, e.name, s.registered, s.voters, s.turnout, s.abstention_pct, s.blank, s.blank_pct, s.null_votes, s.null_pct, s.source_url
      FROM summary s JOIN elections e ON e.id=s.election_id WHERE s.level='concelho' AND s.code=? ORDER BY e.date DESC`, dico);
    for (const e of elections) {
      e.results = resultsOf(e.id, "concelho", dico).slice(0, 6);
      const nat = q1("SELECT turnout FROM summary WHERE election_id=? AND level='nacional'", e.id);
      e.national_turnout = nat ? nat.turnout : null;
    }
    return { available: true, found: !!elections.length, municipio: m || { dico }, elections, autarquicas: "#/autarquias-mapa" };
  };

  // Parish history: ?entity_id= (politica.db freguesia entity) or ?code= (6-digit DICOFRE)
  routes["/api/eleicoes/freguesia"] = (q) => {
    if (!ok()) return missing();
    let f = null;
    if (q.get("code")) f = q1("SELECT * FROM freguesias WHERE code=?", q.get("code"));
    else if (q.get("entity_id")) f = q1("SELECT * FROM freguesias WHERE entity_id=?", Number(q.get("entity_id")));
    if (!f) return { available: true, found: false };
    const m = q1("SELECT * FROM municipios WHERE dico=?", f.dico);
    const elections = qa(`SELECT e.id, e.type, e.year, e.round, e.date, e.name, s.registered, s.voters, s.turnout, s.abstention_pct, s.blank, s.blank_pct, s.null_votes, s.null_pct, s.source_url
      FROM summary s JOIN elections e ON e.id=s.election_id WHERE s.level='freguesia' AND s.code=? ORDER BY e.date DESC`, f.code);
    for (const e of elections) {
      e.results = resultsOf(e.id, "freguesia", f.code).slice(0, 6);
      const c = summaryOf(e.id, "concelho", f.dico);
      e.concelho_turnout = c ? c.turnout : null;
      const n = q1("SELECT turnout FROM summary WHERE election_id=? AND level='nacional'", e.id);
      e.national_turnout = n ? n.turnout : null;
    }
    return { available: true, found: !!elections.length, freguesia: f, municipio: m || null, elections };
  };

  routes["/api/eleicoes/series"] = (q) => {
    if (!ok()) return missing();
    const party = q.get("party"), level = q.get("level") || "nacional", code = q.get("code");
    const type = q.get("type");
    const els = qa(`SELECT e.id, e.type, e.year, e.round, e.date, e.name FROM elections e ${type ? "WHERE e.type=?" : ""} ORDER BY e.date`, ...(type ? [type] : []));
    const out = [];
    for (const e of els) {
      const c = level === "nacional" ? (q1("SELECT code FROM summary WHERE election_id=? AND level='nacional'", e.id) || {}).code : code;
      if (!c) continue;
      const s = summaryOf(e.id, level, c);
      if (!s) continue;
      let r = null;
      if (party) r = q1("SELECT SUM(votes) votes, SUM(pct) pct, SUM(valid_pct) valid_pct, SUM(mandates) mandates FROM results WHERE election_id=? AND level=? AND code=? AND (family=? OR party=?)", e.id, level, c, party, party);
      out.push({ ...e, turnout: s.turnout, abstention_pct: s.abstention_pct, blank_pct: s.blank_pct, null_pct: s.null_pct, registered: s.registered, voters: s.voters, party: r && r.votes != null ? r : null });
    }
    const families = qa("SELECT family, SUM(votes) v FROM results WHERE level='nacional' GROUP BY family ORDER BY v DESC LIMIT 14").map((r) => r.family);
    return { available: true, party, level, series: out, families };
  };
}
