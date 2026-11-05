// Deputados da Assembleia da República (XVII Legislatura): lista, perfil, presenças em plenário, iniciativas, comissões.
// Dados: data/deputados.db construído por ingest/jobs/deputados.py (páginas públicas de parlamento.pt).
// Votos individuais NÃO existem na fonte (a AR só publica votações por grupo parlamentar).
export default function register({ routes, openData, num }) {
  let mine = null;
  const dbh = () => (mine ||= openData("deputados"));
  const all = (sql, ...p) => dbh().prepare(sql).all(...p);
  const one = (sql, ...p) => dbh().prepare(sql).get(...p);
  const missing = { available: false, error: "deputados.db ainda não existe — corra `python3 ingest/run_all.py deputados`." };
  const ok = () => { try { return !!dbh() && !!one("SELECT 1 x FROM deputados LIMIT 1"); } catch { return false; } };
  const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

  // presença: P = presente; AMP = ausência em missão parlamentar (não é falta); o resto (FJ, F, ...) conta como falta
  // Regra: presente = P; AMP = missão parlamentar; PNO = presença noutro órgão (nenhum conta como falta);
  // falta = FJ, FI e "Falta"/"Falta ao Quórum de Votação" (sem código); qualquer outro código -> 'outro'.
  const ISF = `(code IN ('FJ','FI') OR (code IS NULL AND status LIKE 'Falta%'))`;
  const ISO = `(code IS NOT NULL AND code NOT IN ('P','AMP','PNO','FJ','FI'))`;
  const ATT = `COUNT(*) meetings,
    SUM(CASE WHEN code = 'P' THEN 1 ELSE 0 END) present,
    SUM(CASE WHEN code = 'AMP' THEN 1 ELSE 0 END) amp,
    SUM(CASE WHEN code = 'PNO' THEN 1 ELSE 0 END) pno,
    SUM(CASE WHEN ${ISF} THEN 1 ELSE 0 END) absent,
    SUM(CASE WHEN ${ISO} THEN 1 ELSE 0 END) other`;
  const RULE = "Presente (P), ausência em missão parlamentar (AMP) e presença noutro órgão (PNO) não contam como falta. Falta = falta justificada (FJ), injustificada (FI), \"Falta\" e \"Falta ao quórum de votação\". Códigos desconhecidos aparecem como \"outro\".";
  // códigos de partido do portal (tabela parties): B.E., CDS–PP
  const TO_PORTAL = { BE: "B.E.", "CDS-PP": "CDS–PP" }, FROM_PORTAL = { "B.E.": "BE", "BE": "BE", "CDS–PP": "CDS-PP", "CDS-PP": "CDS-PP" };
  const pp = (x) => TO_PORTAL[x] || x, dbp = (x) => FROM_PORTAL[x] || x;
  const meta = () => Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));

  function coverage() {
    const m = meta();
    const c = one(`SELECT COUNT(*) listed, SUM(full_name IS NOT NULL) detailed,
        SUM(EXISTS (SELECT 1 FROM attendance a WHERE a.bid = d.bid)) with_attendance,
        SUM(EXISTS (SELECT 1 FROM authored x WHERE x.bid = d.bid)) with_initiatives
      FROM deputados d WHERE in_office = 1`);
    const x = one("SELECT (SELECT COUNT(DISTINCT bid) FROM authored WHERE truncated = 1) trunc, (SELECT MAX(date) FROM attendance) last_meeting, (SELECT MAX(fetched_at) FROM deputados) updated, (SELECT COUNT(*) FROM votes) votes");
    return {
      seats: Number(m.seats || 230), listed: c.listed, declared_by_source: m.list_total_declared ? Number(m.list_total_declared) : null,
      detailed: c.detailed, with_attendance: c.with_attendance, with_initiatives: c.with_initiatives, initiatives_truncated: x.trunc,
      list_fetched_at: m.list_fetched_at || null, detail_at: m.detail_at || null, last_meeting: x.last_meeting,
      updated_at: x.updated, ingest_complete: c.detailed >= c.listed && c.with_attendance >= c.listed,
      votes_individual: x.votes, source_list: m.list_url || null,
      official_files: { deputados: one("SELECT COUNT(*) n FROM ar_deputado").n, iniciativas: one("SELECT COUNT(*) n FROM ar_iniciativa").n },
    };
  }

  routes["/api/deputados/list"] = (q) => {
    if (!dbh()) return missing;
    if (!ok()) return { ...missing, error: "deputados.db ainda sem dados." };
    const party = dbp((q.get("party") || "").trim()), s = (q.get("q") || "").trim(), circle = (q.get("circle") || "").trim();
    const order = q.get("order") || "name";
    const where = ["d.in_office = 1"], p = [];
    if (party) { where.push("d.party = ?"); p.push(party); }
    if (circle) { where.push("d.circle = ?"); p.push(circle); }
    if (s) { where.push("(d.name LIKE ? ESCAPE '\\' OR d.full_name LIKE ? ESCAPE '\\')"); p.push(`%${likeEsc(s)}%`, `%${likeEsc(s)}%`); }
    const orderBy = { name: "d.name COLLATE NOCASE", party: "d.party, d.name COLLATE NOCASE", circle: "d.circle, d.name COLLATE NOCASE",
      absent: "absent_pct DESC, d.name", init: "n_init DESC, d.name" }[order] || "d.name COLLATE NOCASE";
    const rows = all(`SELECT d.bid, d.name, d.full_name, d.party, d.circle, d.profession,
        (SELECT COUNT(*) FROM attendance a WHERE a.bid = d.bid) meetings,
        (SELECT COUNT(*) FROM attendance a WHERE a.bid = d.bid AND ${ISF}) absent,
        (SELECT COUNT(*) FROM authored x WHERE x.bid = d.bid) n_init,
        (SELECT 100.0 * SUM(CASE WHEN ${ISF} THEN 1 ELSE 0 END) / COUNT(*) FROM attendance a WHERE a.bid = d.bid) absent_pct
      FROM deputados d WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT 300`, ...p);
    return {
      available: true, coverage: coverage(), attendance_rule: RULE, n: rows.length, deputados: rows.map((x) => ({ ...x, party: pp(x.party) })),
      parties: all("SELECT party code, COUNT(*) n FROM deputados WHERE in_office = 1 GROUP BY party ORDER BY n DESC").map((x) => ({ ...x, code: pp(x.code) })),
      circles: all("SELECT circle, COUNT(*) n FROM deputados WHERE in_office = 1 AND circle IS NOT NULL GROUP BY circle ORDER BY circle"),
    };
  };

  routes["/api/deputados/deputado"] = (q) => {
    if (!dbh()) return missing;
    const id = num(q.get("id"), 0, 0, 1e9);
    const d = one("SELECT * FROM deputados WHERE bid = ?", id);
    if (!d) return { available: true, error: "Deputado não encontrado." };
    const att = one(`SELECT ${ATT} FROM attendance WHERE bid = ?`, id);
    const bySession = all(`SELECT session, ${ATT} FROM attendance WHERE bid = ? GROUP BY session ORDER BY session DESC`, id);
    const absences = all(`SELECT date, meeting_no, session, kind, status FROM attendance WHERE bid = ? AND ${ISF} ORDER BY date DESC LIMIT 60`, id);
    const recent = all("SELECT date, meeting_no, session, kind, status, code, CASE WHEN code IS NULL AND status LIKE 'Falta%' THEN 'FALTA' ELSE code END ecode FROM attendance WHERE bid = ? ORDER BY date DESC LIMIT 15", id);
    const pm = one(`SELECT ROUND(100.0 * SUM(CASE WHEN ${ISF} THEN 1 ELSE 0 END) / COUNT(*), 1) pct FROM attendance a JOIN deputados x ON x.bid = a.bid WHERE x.party = ?`, d.party);
    const init = all("SELECT tipo, numero, sessao, titulo, source_url FROM authored WHERE bid = ? ORDER BY CAST(sessao AS INT) DESC, tipo, numero", id);
    const changes = d.name
      ? all("SELECT date, leaves, enters, circle, party, reason, source_url FROM mandate_changes WHERE leaves = ? OR enters = ? OR leaves = ? OR enters = ? ORDER BY date DESC", d.name, d.name, d.full_name || "", d.full_name || "")
      : [];
    return {
      available: true, attendance_rule: RULE, deputado: { ...d, party: pp(d.party) },
      committees: all("SELECT committee, role FROM committees WHERE bid = ? ORDER BY committee", id),
      attendance: { ...att, by_session: bySession, absences, recent, party_absent_pct: pm.pct, has_data: att.meetings > 0 },
      initiatives: init, initiatives_truncated: !!one("SELECT 1 x FROM authored WHERE bid = ? AND truncated = 1", id),
      mandate_changes: changes,
      votes: { available: false, note: "A Assembleia da República não publica votos individuais dos deputados, apenas o sentido de voto de cada grupo parlamentar." },
      source_urls: { biografia: d.source_url, atividade: `https://www.parlamento.pt/DeputadoGP/Paginas/ActividadeDeputado.aspx?BID=${id}&lg=XVII`,
        presencas: `https://www.parlamento.pt/DeputadoGP/Paginas/PresencasReunioesPlenarias.aspx?BID=${id}` },
    };
  };

  routes["/api/deputados/party"] = (q) => {
    if (!dbh()) return missing;
    const code0 = (q.get("code") || "").trim(), code = dbp(code0);
    const n = one("SELECT COUNT(*) n FROM deputados WHERE in_office = 1 AND party = ?", code).n;
    if (!n) return { available: true, error: "Partido sem deputados listados.", code };
    return {
      available: true, code: pp(code), attendance_rule: RULE, n,
      attendance: one(`SELECT ${ATT} FROM attendance a JOIN deputados d ON d.bid = a.bid WHERE d.in_office = 1 AND d.party = ?`, code),
      circles: all("SELECT circle, COUNT(*) n FROM deputados WHERE in_office = 1 AND party = ? GROUP BY circle ORDER BY n DESC", code),
      top_authors: all(`SELECT d.bid, d.name, COUNT(*) n FROM authored x JOIN deputados d ON d.bid = x.bid WHERE d.in_office = 1 AND d.party = ? GROUP BY d.bid ORDER BY n DESC LIMIT 10`, code),
      most_absent: all(`SELECT d.bid, d.name, COUNT(*) meetings, SUM(CASE WHEN ${ISF} THEN 1 ELSE 0 END) absent
        FROM attendance a JOIN deputados d ON d.bid = a.bid WHERE d.in_office = 1 AND d.party = ? GROUP BY d.bid HAVING absent > 0 ORDER BY absent DESC LIMIT 10`, code),
      committees: all(`SELECT c.committee, COUNT(*) n FROM committees c JOIN deputados d ON d.bid = c.bid WHERE d.in_office = 1 AND d.party = ? GROUP BY c.committee ORDER BY n DESC`, code),
      initiatives: one("SELECT COUNT(*) n FROM authored x JOIN deputados d ON d.bid = x.bid WHERE d.in_office = 1 AND d.party = ?", code).n,
    };
  };

  routes["/api/deputados/changes"] = () => {
    if (!dbh()) return missing;
    return { available: true, changes: all("SELECT date, leaves, enters, circle, party, reason, source_url FROM mandate_changes ORDER BY date DESC LIMIT 200") };
  };
}
