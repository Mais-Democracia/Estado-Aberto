// Votações e processo legislativo (Assembleia da República): percurso completo de cada iniciativa e sentido de voto por grupo parlamentar.
// Dados: data/votacoes.db construído por ingest/jobs/votacoes.py (páginas públicas DetalheIniciativa.aspx de parlamento.pt).
// A AR publica votos por grupo parlamentar; deputados só aparecem nominalmente quando votam diferente do seu grupo.
import fs from "node:fs";
import path from "node:path";

export default function register({ routes, openData, one: coreOne, root }) {
  let mine = null, dre = null;
  const dbh = () => (mine ||= openData("votacoes"));
  const dreh = () => (dre ||= openData("dre"));
  const all = (sql, ...p) => dbh().prepare(sql).all(...p);
  const one = (sql, ...p) => dbh().prepare(sql).get(...p);
  const missing = { available: false, error: "votacoes.db ainda não existe — corra `python3 ingest/run_all.py votacoes`." };
  const ready = () => { try { return !!dbh() && !!one("SELECT 1 x FROM iniciativas LIMIT 1"); } catch { return false; } };
  const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
  const dbFile = path.join(root || process.cwd(), "data", "votacoes.db");
  const stamp = () => { try { return fs.statSync(dbFile).mtimeMs + ":" + (fs.existsSync(dbFile + "-wal") ? fs.statSync(dbFile + "-wal").mtimeMs : 0); } catch { return "0"; } };
  const cache = new Map();
  const cached = (k, fn) => { const s = stamp(), c = cache.get(k); if (c && c.s === s) return c.v; const v = fn(); cache.set(k, { s, v }); if (cache.size > 200) cache.delete(cache.keys().next().value); return v; };
  const SENSES = ["favor", "contra", "abstencao", "ausencia"];
  const PARTY_ORDER = ["BE", "PCP", "PEV", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS-PP", "CH", "Ninsc"];
  const meta = () => Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));

  function coverage() {
    return cached("coverage", () => {
      const m = meta();
      return {
        updated_at: m.updated_at || null, stopped: m.stopped || null, legs: m.legs || null, listed: Number(m.listed || 0), source: m.source || null,
        stored: one("SELECT COUNT(*) n FROM iniciativas").n,
        votes: one("SELECT COUNT(*) n FROM votos").n, plenary_votes: one("SELECT COUNT(*) n FROM votos WHERE orgao = 'Plenário'").n,
        phases: one("SELECT COUNT(*) n FROM fases").n, dre_linked: one("SELECT COUNT(*) n FROM iniciativas WHERE dre_act_id IS NOT NULL").n,
        by_leg: all(`SELECT l.leg, l.tipo, COUNT(*) listed, COUNT(i.bid) stored FROM listagem l LEFT JOIN iniciativas i ON i.bid = l.bid GROUP BY l.leg, l.tipo ORDER BY l.leg DESC, listed DESC`),
        last_vote: one("SELECT MAX(data) d FROM votos WHERE orgao = 'Plenário'").d,
        individual_votes: one("SELECT COUNT(*) n FROM voto_partido WHERE kind = 'dep'").n,
        inconsistent: all(`SELECT i.leg, COUNT(*) n FROM votos v JOIN iniciativas i ON i.bid = v.bid WHERE v.orgao = 'Plenário' AND v.inconsistente = 1 GROUP BY i.leg ORDER BY i.leg DESC`),
        checked: one("SELECT COUNT(*) n FROM votos WHERE orgao = 'Plenário' AND inconsistente IS NOT NULL").n,
        split_votes: one("SELECT COUNT(DISTINCT voto_id) n FROM voto_partido WHERE kind = 'dividido'").n,
        closed: all(`SELECT leg, leg_fim, COUNT(*) n, SUM(estado LIKE '%legislatura terminada%') unfinished, SUM(transitou) carried FROM iniciativas WHERE leg_fim IS NOT NULL GROUP BY leg, leg_fim ORDER BY leg DESC`),
      };
    });
  }

  const tokensFor = (ids) => {
    if (!ids.length) return new Map();
    const rows = all(`SELECT voto_id, partido, sentido, kind, nome, n FROM voto_partido WHERE voto_id IN (${ids.map(() => "?").join(",")})`, ...ids);
    const m = new Map();
    for (const r of rows) { if (!m.has(r.voto_id)) m.set(r.voto_id, []); m.get(r.voto_id).push(r); }
    return m;
  };

  function dreAct(id) {
    if (!id || !dreh()) return null;
    try { return dreh().prepare("SELECT id, kind, number, date, title, url, dr_title, eli FROM acts WHERE id = ?").get(id) || null; } catch { return null; }
  }

  let pres = null;
  function presidencia(ini) {
    try {
      pres ||= openData("presidencia");
      const ato = pres.prepare("SELECT id, data, tipo, subtipo, presidente, diploma_ref, source_url, mensagem_url, acordao_tc FROM atos WHERE canon = 1 AND (iniciativa_key = ? OR (? IS NOT NULL AND dre_act_id = ?)) ORDER BY data LIMIT 5").all(ini.key, ini.dre_act_id || null, ini.dre_act_id || null);
      const vetos = pres.prepare("SELECT id, data, presidente, desfecho, desfecho_data, motivo, mensagem_url, source_url FROM vetos WHERE iniciativas LIKE ? ESCAPE '\\' ORDER BY data").all('%"' + likeEsc(ini.key) + '"%');
      return { atos: ato, vetos };
    } catch { return null; }
  }

  routes["/api/votacoes/stats"] = () => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "votacoes.db ainda sem dados." };
    return { available: true, coverage: coverage(),
      estados: all("SELECT estado, COUNT(*) n FROM iniciativas GROUP BY estado ORDER BY n DESC"),
      tipos: all("SELECT tipo, COUNT(*) n FROM iniciativas GROUP BY tipo ORDER BY n DESC"),
      legs: all("SELECT leg, COUNT(*) n FROM iniciativas GROUP BY leg ORDER BY MIN(bid) DESC") };
  };

  routes["/api/votacoes/iniciativa"] = (q) => {
    if (!dbh()) return missing;
    const key = (q.get("key") || "").trim(), bid = Number(q.get("bid") || 0);
    const ini = bid ? one("SELECT * FROM iniciativas WHERE bid = ?", bid) : one("SELECT * FROM iniciativas WHERE key = ? ORDER BY bid DESC", key);
    if (!ini) {
      const l = key ? one("SELECT * FROM listagem WHERE tipo || '|' || CAST(numero AS INTEGER) || '|' || leg = ?", key) : null;
      return { available: true, error: l ? "Iniciativa listada mas o detalhe ainda não foi recolhido." : "Iniciativa não encontrada nos dados recolhidos.", listed: l || null, coverage: coverage() };
    }
    ini.autores = JSON.parse(ini.autores_json || "[]"); delete ini.autores_json;
    const fases = all("SELECT ord, data, fase, comissao, competente, obs, publicacoes, texto_titulo, texto_tipo FROM fases WHERE bid = ? ORDER BY ord", ini.bid);
    const votos = all("SELECT * FROM votos WHERE bid = ? ORDER BY ord, id", ini.bid);
    const tk = tokensFor(votos.map((v) => v.id));
    for (const v of votos) v.partidos = tk.get(v.id) || [];
    const rel = all("SELECT ord, comissao, dep_bid, nome, partido, motivo FROM relatores WHERE bid = ?", ini.bid);
    const conj = all("SELECT c.ord, c.outro_bid, c.numero, c.autor, c.titulo, i.key FROM conjuntas c LEFT JOIN iniciativas i ON i.bid = c.outro_bid WHERE c.bid = ?", ini.bid);
    for (const f of fases) {
      f.publicacoes = f.publicacoes ? JSON.parse(f.publicacoes) : [];
      f.votos = votos.filter((v) => v.ord === f.ord);
      f.relatores = rel.filter((r) => r.ord === f.ord);
      f.conjuntas = conj.filter((c) => c.ord === f.ord);
    }
    let portal = null;
    try { portal = coreOne("SELECT key, title FROM initiatives WHERE key = ?", ini.key) || null; } catch { portal = null; }
    let seats = null;
    try { const m = one("SELECT value FROM meta WHERE key = ?", "seats_" + ini.leg); seats = m ? JSON.parse(m.value) : null; } catch { seats = null; }
    return { available: true, iniciativa: ini, fases, n_votos: votos.length, dre: dreAct(ini.dre_act_id), portal, seats, presidencia: presidencia(ini),
      note: "Sentido de voto por grupo parlamentar, tal como publicado pela Assembleia da República. Votos individuais só aparecem quando um deputado votou de forma diferente do seu grupo e a AR o indicou." };
  };

  routes["/api/votacoes/search"] = (q) => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "votacoes.db ainda sem dados." };
    const s = (q.get("q") || "").trim(), tipo = (q.get("tipo") || "").trim(), leg = (q.get("leg") || "").trim(), estado = (q.get("estado") || "").trim();
    const origem = (q.get("origem") || "").trim();
    const page = Math.max(1, Number(q.get("page") || 1)), limit = Math.min(100, Math.max(5, Number(q.get("limit") || 30)));
    const where = [], p = [];
    if (s) {
      const m = s.match(/^(\d+)(?:\/([IVX]+))?$/);
      if (m) { where.push("numero = ?"); p.push(Number(m[1])); if (m[2]) { where.push("leg = ?"); p.push(m[2]); } }
      else { where.push("(titulo LIKE ? ESCAPE '\\' OR autoria LIKE ? ESCAPE '\\')"); p.push(`%${likeEsc(s)}%`, `%${likeEsc(s)}%`); }
    }
    if (tipo) { where.push("tipo = ?"); p.push(tipo); }
    if (leg) { where.push("leg = ?"); p.push(leg); }
    if (estado) { where.push("estado = ?"); p.push(estado); }
    if (origem) { where.push("origem = ?"); p.push(origem); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = one(`SELECT COUNT(*) n FROM iniciativas ${w}`, ...p).n;
    const rows = all(`SELECT bid, key, tipo, numero, leg, sessao, titulo, autoria, origem, estado, resultado_generalidade, resultado_final,
        data_entrada, data_ultima, ultima_fase, n_votos, dr_ref, dre_act_id, leg_fim, transitou FROM iniciativas ${w}
        ORDER BY COALESCE(data_ultima, data_entrada) DESC, bid DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
    return { available: true, total, page, limit, rows,
      facets: cached("facets", () => ({ tipos: all("SELECT tipo, COUNT(*) n FROM iniciativas GROUP BY tipo ORDER BY n DESC"),
        legs: all("SELECT leg, COUNT(*) n FROM iniciativas GROUP BY leg ORDER BY MIN(bid) DESC"),
        estados: all("SELECT estado, COUNT(*) n FROM iniciativas GROUP BY estado ORDER BY n DESC"),
        origens: all("SELECT origem, COUNT(*) n FROM iniciativas GROUP BY origem ORDER BY n DESC") })) };
  };

  const SHORT = (f) => (/generalidade/i.test(f) ? "generalidade" : /final global/i.test(f) ? "final global" : /especialidade/i.test(f) ? "especialidade" : null);
  const faseLabel = (fs) => {
    if (fs.length <= 1) return fs[0] || "";
    const sh = fs.map(SHORT);
    if (sh.every(Boolean)) { const u = [...new Set(sh)]; return "Votação na " + (u.length > 1 ? u.slice(0, -1).join(", ") + " e " + u[u.length - 1] : u[0]); }
    return fs.join(" + ");
  };

  routes["/api/votacoes/votacoes"] = (q) => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "votacoes.db ainda sem dados." };
    const date = (q.get("date") || "").trim(), leg = (q.get("leg") || "").trim(), party = (q.get("party") || "").trim(), sense = (q.get("sense") || "").trim();
    const orgao = q.get("orgao") === "comissao" ? "Comissão" : q.get("orgao") === "todos" ? null : "Plenário";
    const fase = (q.get("fase") || "").trim(), resultado = (q.get("resultado") || "").trim(), tipo = (q.get("tipo") || "").trim();
    const page = Math.max(1, Number(q.get("page") || 1)), limit = Math.min(200, Math.max(10, Number(q.get("limit") || 50)));
    const where = [], p = [];
    if (date) { where.push("v.data = ?"); p.push(date); }
    if (orgao) { where.push("v.orgao = ?"); p.push(orgao); }
    if (leg) { where.push("i.leg = ?"); p.push(leg); }
    if (tipo) { where.push("i.tipo = ?"); p.push(tipo); }
    if (fase === "generalidade") where.push("v.fase LIKE '%generalidade%'");
    else if (fase === "final") where.push("v.fase LIKE '%final global%'");
    else if (fase === "especialidade") where.push("v.fase LIKE '%especialidade%'");
    if (resultado === "aprovado") where.push("v.resultado LIKE 'Aprovad%'");
    else if (resultado === "rejeitado") where.push("v.resultado LIKE 'Rejeitad%'");
    if (party && SENSES.includes(sense)) { where.push("EXISTS (SELECT 1 FROM voto_partido x WHERE x.voto_id = v.id AND x.kind = 'gp' AND x.partido = ? AND x.sentido = ?)"); p.push(party, sense); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    // identical votes on the same initiative, day and body (e.g. generalidade + especialidade + final global in one go) -> one row with `fases`
    const FROM = `FROM votos v JOIN iniciativas i ON i.bid = v.bid LEFT JOIN fases f ON f.bid = v.bid AND f.ord = v.ord ${w}
        GROUP BY v.bid, v.data, v.orgao, COALESCE(v.resultado, ''), COALESCE(v.detalhe, ''), CASE WHEN v.orgao = 'Comissão' THEN COALESCE(f.comissao, '') ELSE '' END`;
    const total = one(`SELECT COUNT(*) n FROM (SELECT 1 ${FROM})`, ...p).n;
    const rows = all(`SELECT MIN(v.id) id, v.bid, v.data, group_concat(v.fase, '||') fases_raw, COUNT(*) n_votos, v.orgao, MIN(v.reuniao) reuniao, v.resultado, MAX(v.unanime) unanime, v.detalhe,
        MIN(f.comissao) comissao, MAX(v.inconsistente) inconsistente, i.source_url, i.key, i.tipo, i.numero, i.leg, i.titulo, i.autoria, i.estado
        ${FROM} ORDER BY v.data DESC, MIN(v.id) DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
    const tk = tokensFor(rows.map((r) => r.id));
    for (const r of rows) {
      r.partidos = tk.get(r.id) || [];
      r.fases = [...new Set(String(r.fases_raw || "").split("||").filter(Boolean))]; delete r.fases_raw;
      r.fase = faseLabel(r.fases);
    }
    const dates = cached("dates:" + (orgao || "all"), () => all(`SELECT data, COUNT(*) n FROM votos ${orgao ? "WHERE orgao = ?" : ""} GROUP BY data ORDER BY data DESC LIMIT 60`, ...(orgao ? [orgao] : [])));
    return { available: true, total, page, limit, rows, dates };
  };

  // how a party voted + agreement matrix (plenary votes, group-level senses only; "ausência" excluded from agreement)
  function partyStats(leg, fase) {
    return cached(`party:${leg}:${fase}`, () => {
      const where = ["v.orgao = 'Plenário'", "x.kind IN ('gp', 'dividido')"], p = [];
      if (leg) { where.push("i.leg = ?"); p.push(leg); }
      if (fase === "generalidade") where.push("v.fase LIKE '%generalidade%'");
      else if (fase === "final") where.push("v.fase LIKE '%final global%'");
      const rows = all(`SELECT DISTINCT x.voto_id, x.partido, CASE WHEN x.kind = 'dividido' THEN 'dividido' ELSE x.sentido END sentido
          FROM voto_partido x JOIN votos v ON v.id = x.voto_id JOIN iniciativas i ON i.bid = v.bid WHERE ${where.join(" AND ")}`, ...p);
      const byVote = new Map(), totals = {};
      for (const r of rows) {
        if (!byVote.has(r.voto_id)) byVote.set(r.voto_id, {});
        if (r.sentido !== "dividido") byVote.get(r.voto_id)[r.partido] = r.sentido; // a split group has no single sense: left out of the agreement matrix
        const t = (totals[r.partido] ||= { partido: r.partido, votes: 0, favor: 0, contra: 0, abstencao: 0, ausencia: 0, dividido: 0 });
        t.votes++; t[r.sentido]++;
      }
      const parties = Object.keys(totals).filter((k) => totals[k].votes >= 5).sort((a, b) => (PARTY_ORDER.indexOf(a) + 1 || 99) - (PARTY_ORDER.indexOf(b) + 1 || 99));
      const matrix = {};
      for (const a of parties) { matrix[a] = {}; for (const b of parties) matrix[a][b] = { same: 0, both: 0 }; }
      for (const m of byVote.values()) {
        const ps = parties.filter((k) => m[k] && m[k] !== "ausencia");
        for (const a of ps) for (const b of ps) { matrix[a][b].both++; if (m[a] === m[b]) matrix[a][b].same++; }
      }
      return { n_votes: byVote.size, parties, totals: parties.map((k) => totals[k]), matrix };
    });
  }

  routes["/api/votacoes/partido"] = (q) => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "votacoes.db ainda sem dados." };
    const code = (q.get("code") || "").trim().replace("B.E.", "BE").replace("CDS–PP", "CDS-PP"), leg = (q.get("leg") || "").trim(), fase = (q.get("fase") || "").trim();
    const st = partyStats(leg, fase);
    const out = { available: true, leg: leg || null, fase: fase || null, ...st,
      note: "Votações em plenário com sentido de voto por grupo parlamentar. Concordância = % das votações em que ambos os grupos votaram (ausências excluídas) com o mesmo sentido." };
    if (code) {
      out.party = code;
      out.summary = st.totals.find((t) => t.partido === code) || null;
      const p = [code], w = leg ? "AND i.leg = ?" : "";
      if (leg) p.push(leg);
      out.by_tipo = all(`SELECT i.tipo, x.sentido, COUNT(*) n FROM voto_partido x JOIN votos v ON v.id = x.voto_id JOIN iniciativas i ON i.bid = v.bid
          WHERE v.orgao = 'Plenário' AND x.kind = 'gp' AND x.partido = ? ${w} GROUP BY i.tipo, x.sentido`, ...p);
      out.dissent = all(`SELECT v.data, v.fase, x.nome, x.sentido, i.key, i.tipo, i.numero, i.leg, i.titulo FROM voto_partido x JOIN votos v ON v.id = x.voto_id JOIN iniciativas i ON i.bid = v.bid
          WHERE v.orgao = 'Plenário' AND x.kind IN ('dep','parcial') AND x.partido = ? ${w} ORDER BY v.data DESC LIMIT 50`, ...p);
      out.recent = all(`SELECT v.data, v.fase, v.resultado, x.sentido, i.key, i.tipo, i.numero, i.leg, i.titulo FROM voto_partido x JOIN votos v ON v.id = x.voto_id JOIN iniciativas i ON i.bid = v.bid
          WHERE v.orgao = 'Plenário' AND x.kind = 'gp' AND x.partido = ? ${w} ORDER BY v.data DESC, v.id DESC LIMIT 30`, ...p);
    }
    return out;
  };

  // deputy as rapporteur / author (deputy BID = parlamento.pt BID used by the deputados module)
  routes["/api/votacoes/deputado"] = (q) => {
    if (!dbh()) return missing;
    const id = Number(q.get("bid") || q.get("id") || 0);
    if (!id) return { error: "bid em falta" };
    return { available: true,
      relator: all(`SELECT r.comissao, r.motivo, f.data, i.key, i.tipo, i.numero, i.leg, i.titulo, i.estado FROM relatores r JOIN iniciativas i ON i.bid = r.bid
          LEFT JOIN fases f ON f.bid = r.bid AND f.ord = r.ord WHERE r.dep_bid = ? ORDER BY f.data DESC LIMIT 200`, id),
      autor: one("SELECT COUNT(*) n FROM autores WHERE dep_bid = ?", id).n };
  };
}
