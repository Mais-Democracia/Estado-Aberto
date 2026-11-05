import fs from "node:fs";
import path from "node:path";

export default function register({ routes, openData, num, root, dataDir }) {
  let mine = null, iv = null;
  const dbh = () => (mine ||= openData("posicoes"));
  const ivh = () => (iv ||= openData("intervencoes"));
  const all = (sql, ...p) => dbh().prepare(sql).all(...p);
  const one = (sql, ...p) => dbh().prepare(sql).get(...p);
  const missing = { available: false, error: "posicoes.db ainda não existe — corra `python3 ingest/run_all.py posicoes` (depende de intervencoes.db e votacoes.db)." };
  
  const PARTIES = ["BE", "PCP", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS-PP", "CH"];
  const file = path.join(dataDir, "posicoes.db");
  const topicsFile = path.join(root || process.cwd(), "seed", "posicoes_topicos.json");
  const stamp = () => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  let cache = null;
  const cached = (k, fn) => {
    const s = stamp();
    if (!cache || cache.s !== s) cache = { s, m: new Map() };
    if (!cache.m.has(k)) cache.m.set(k, fn());
    return cache.m.get(k);
  };
  const config = () => cached("cfg", () => {
    try { const c = JSON.parse(fs.readFileSync(topicsFile, "utf8")); return { nota: c._nota, temas: c.temas }; } catch { return { nota: null, temas: {} }; }
  });
  const stats = (rows) => {
    const comp = rows.filter((r) => r.estado === "comparavel");
    const ok = comp.filter((r) => r.coincide === 1).length;
    return { declaracoes: rows.length, comparaveis: comp.length, coincidem: ok, divergem: comp.length - ok, nao_comparaveis: rows.length - comp.length };
  };
  const declRows = (where, arg) => all(`SELECT id, iv_id, dep_bid, orador, partido, bid, ref, titulo, data_discurso, declarado, citacao, fase, data_voto, voto, voto_origem, estado, coincide, n_inic_discurso, source_url, voto_url FROM decl WHERE ${where} ORDER BY data_discurso DESC, id DESC`, arg);

  routes["/api/posicoes/stats"] = () => {
    if (!dbh()) return missing;
    return cached("stats", () => {
      const meta = Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
      const deps = one("SELECT COUNT(*) n, SUM(ligada) lig FROM fala WHERE kind = 'dep'");
      const withTopic = one("SELECT COUNT(DISTINCT iv_id) n FROM iv_tema").n;
      const linked = one("SELECT COUNT(*) n FROM fala WHERE ligada = 1").n;
      const total = one("SELECT COUNT(*) n FROM fala").n;
      const comp = stats(all("SELECT estado, coincide FROM decl"));
      return {
        available: true, updated_at: meta.updated_at, janela_dias: Number(meta.janela_dias),
        coverage: { speeches: total, linked, linked_pct: total ? linked / total : 0, deputy_speeches: deps.n, with_topic: withTopic,
          legs: all("SELECT leg, COUNT(*) n, MIN(data) primeira, MAX(data) ultima FROM fala GROUP BY leg ORDER BY leg DESC"),
          initiatives_party_voted: one("SELECT COUNT(*) n FROM ini_partido").n },
        declarations: comp,
        excluded: all("SELECT motivo, n FROM excl ORDER BY n DESC"),
        topics: Object.keys(config().temas), parties: PARTIES,
      };
    });
  };

  routes["/api/posicoes/overview"] = () => routes["/api/posicoes/stats"]();

  routes["/api/posicoes/config"] = () => ({ available: true, ...config() });

  routes["/api/posicoes/matriz"] = () => {
    if (!dbh()) return missing;
    return cached("matriz", () => {
      const rows = all(`SELECT t.tema, f.partido, COUNT(*) n, SUM(f.palavras) palavras FROM iv_tema t JOIN fala f ON f.id = t.iv_id
                        WHERE f.kind = 'dep' AND f.partido IN (${PARTIES.map(() => "?").join(",")}) GROUP BY t.tema, f.partido`, ...PARTIES);
      const totals = all(`SELECT partido, COUNT(*) n, SUM(palavras) palavras, SUM(ligada) ligadas FROM fala WHERE kind = 'dep' AND partido IN (${PARTIES.map(() => "?").join(",")}) GROUP BY partido`, ...PARTIES);
      const topics = Object.keys(config().temas);
      return { available: true, parties: PARTIES, topics, cells: rows, totals,
        note: "Cada intervenção conta uma vez por tema; uma intervenção ligada a iniciativas de vários temas conta em todos. Só entram intervenções ligadas a iniciativas (sem tema atribuído = sem ligação ou título sem palavra-chave)." };
    });
  };

  routes["/api/posicoes/declaracoes"] = (q) => {
    if (!dbh()) return missing;
    const p = (q.get("partido") || "").trim(), limit = num(q.get("limit"), 200, 1, 500);
    const rows = p ? declRows("partido = ?", p) : all("SELECT id, iv_id, dep_bid, orador, partido, bid, ref, titulo, data_discurso, declarado, citacao, fase, data_voto, voto, voto_origem, estado, coincide, n_inic_discurso, source_url, voto_url FROM decl ORDER BY partido, data_discurso DESC, id DESC");
    const byParty = {};
    for (const r of rows) (byParty[r.partido] ||= []).push(r);
    return { available: true, total: rows.length, ...stats(rows), partidos: PARTIES.filter((x) => byParty[x]).map((x) => ({ partido: x, ...stats(byParty[x]), items: byParty[x].slice(0, limit) })) };
  };

  function profile(whereFala, whereDecl, arg, party) {
    const fal = one(`SELECT COUNT(*) n, SUM(palavras) palavras, SUM(ligada) ligadas, MIN(data) primeira, MAX(data) ultima FROM fala WHERE ${whereFala}`, arg);
    const temas = all(`SELECT t.tema, COUNT(*) n, SUM(f.palavras) palavras FROM iv_tema t JOIN fala f ON f.id = t.iv_id WHERE ${whereFala.replace(/\b(partido|dep_bid)\b/g, "f.$1")} GROUP BY t.tema ORDER BY n DESC`, arg);
    const decl = declRows(whereDecl, arg);
    const votos = party ? all("SELECT voto, COUNT(*) n FROM ini_partido WHERE partido = ? GROUP BY voto", arg) : [];
    const spokeVoted = party ? one("SELECT COUNT(*) n, SUM(decl_id IS NOT NULL) decl FROM ini_partido WHERE partido = ?", arg) : null;
    const porTema = party ? all(`SELECT t.tema, p.voto, COUNT(*) n FROM ini_partido p JOIN ini_tema t ON t.bid = p.bid WHERE p.partido = ? GROUP BY t.tema, p.voto`, arg) : [];
    return { available: true, fala: fal, temas, votos, falou_e_votou: spokeVoted, voto_por_tema: porTema, ...stats(decl), declaracoes_itens: decl };
  }

  routes["/api/posicoes/partido"] = (q) => {
    if (!dbh()) return missing;
    const p = (q.get("p") || "").trim();
    if (!PARTIES.includes(p)) return { available: true, error: "Partido não reconhecido." };
    const r = profile("kind = 'dep' AND partido = ?", "partido = ?", p, true);
    r.deputados = all(`SELECT dep_bid, orador, COUNT(*) n, SUM(palavras) palavras FROM fala WHERE kind = 'dep' AND partido = ? AND dep_bid IS NOT NULL GROUP BY dep_bid, orador ORDER BY n DESC LIMIT 15`, p);
    return { partido: p, ...r };
  };

  routes["/api/posicoes/deputado"] = (q) => {
    if (!dbh()) return missing;
    const id = num(q.get("id"), 0, 0, 1e9);
    const r = profile("dep_bid = ?", "dep_bid = ?", id, false);
    if (!r.fala.n) return { available: true, empty: true };
    const who = one("SELECT orador, partido FROM fala WHERE dep_bid = ? ORDER BY data DESC LIMIT 1", id);
    return { ...r, deputado: who };
  };

  routes["/api/posicoes/iniciativas"] = (q) => {
    if (!dbh()) return missing;
    const p = (q.get("p") || "").trim(), tema = (q.get("tema") || "").trim(), limit = num(q.get("limit"), 60, 1, 200);
    if (!PARTIES.includes(p)) return { available: true, items: [] };
    const rows = tema
      ? all("SELECT p.* FROM ini_partido p JOIN ini_tema t ON t.bid = p.bid WHERE p.partido = ? AND t.tema = ? ORDER BY p.primeira_fala DESC LIMIT ?", p, tema, limit)
      : all("SELECT * FROM ini_partido WHERE partido = ? ORDER BY primeira_fala DESC LIMIT ?", p, limit);
    return { available: true, items: rows };
  };
}
