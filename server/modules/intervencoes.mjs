import fs from "node:fs";
import path from "node:path";

export default function register({ routes, openData, num, dataDir }) {
  let mine = null;
  const dbh = () => (mine ||= openData("intervencoes"));
  const all = (sql, ...p) => dbh().prepare(sql).all(...p);
  const one = (sql, ...p) => dbh().prepare(sql).get(...p);
  const missing = { available: false, error: "intervencoes.db ainda não existe — corra `python3 ingest/run_all.py intervencoes`." };
  const ready = () => { try { return !!dbh() && !!one("SELECT 1 x FROM intervencoes LIMIT 1"); } catch { return false; } };
  const PARTY_ORDER = ["BE", "PCP", "PEV", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS-PP", "CH", "Ninsc", "N insc"];
  const dbFile = path.join(dataDir, "intervencoes.db");
  const stamp = () => { try { return fs.statSync(dbFile).mtimeMs; } catch { return 0; } };
  let cov = null;
  const excerpt = (t, n = 420) => {
    if (!t || t.length <= n) return t || "";
    const cut = t.slice(0, n), i = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf(" "));
    return cut.slice(0, i > n * 0.5 ? i + 1 : n).trim() + " …";
  };
  const shape = (r) => ({ id: r.id, data: r.data, reuniao: r.reuniao, leg: r.leg, sessao: r.sessao, numero: r.numero, pagina: r.pagina, orador: r.orador, partido: r.partido,
    dep_bid: r.dep_bid, kind: r.kind, cargo: r.cargo, palavras: r.palavras, excerto: excerpt(r.texto), agenda: excerpt(r.agenda, 260), source_url: r.source_url });

  function coverage() {
    const s = stamp();
    if (cov && cov.s === s) return cov.v;
    const n = one("SELECT COUNT(*) n FROM intervencoes").n;
    const dep = one("SELECT COUNT(*) n, SUM(dep_bid IS NOT NULL) matched FROM intervencoes WHERE kind = 'dep'");
    const linked = one("SELECT COUNT(DISTINCT iv_id) n FROM iv_ini").n;
    const linkedDb = one("SELECT COUNT(DISTINCT iv_id) n FROM iv_ini WHERE bid IS NOT NULL").n;
    const meta = Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    const v = { speeches: n, deputy_speeches: dep.n, deputy_matched: dep.matched || 0, linked, linked_in_votacoes: linkedDb,
      meetings: one("SELECT COUNT(*) n FROM reunioes").n, first: one("SELECT MIN(data) d FROM intervencoes").d, last: one("SELECT MAX(data) d FROM intervencoes").d,
      by_leg: all("SELECT leg, sessao, COUNT(*) speeches, COUNT(DISTINCT reuniao) meetings FROM intervencoes GROUP BY leg, sessao ORDER BY leg DESC, sessao DESC"),
      updated_at: meta.updated_at || null, stopped: meta.stopped || null, source: meta.source || null };
    cov = { s, v };
    return v;
  }

  routes["/api/intervencoes/stats"] = () => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "intervencoes.db ainda sem dados." };
    return { available: true, coverage: coverage() };
  };

  routes["/api/intervencoes/iniciativa"] = (q) => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "intervencoes.db ainda sem dados." };
    const key = (q.get("key") || "").trim(), bid = Number(q.get("bid") || 0);
    const limit = num(q.get("limit"), 50, 1, 200), offset = num(q.get("offset"), 0, 0, 1e6), partido = (q.get("partido") || "").trim();
    const where = bid ? "i.bid = ?" : "i.key = ?", arg = bid || key;
    const grp = "CASE WHEN v.kind = 'dep' THEN v.partido ELSE 'Governo' END";
    const counts = all(`SELECT ${grp} p, COUNT(DISTINCT v.id) n FROM intervencoes v JOIN iv_ini i ON i.iv_id = v.id WHERE ${where} GROUP BY p`, arg);
    const order = (p) => { const i = PARTY_ORDER.indexOf(p); return p === "Governo" ? 99 : i < 0 ? 50 : i; };
    const partidos = counts.map((c) => ({ partido: c.p || "—", n: c.n })).sort((a, b) => order(a.partido) - order(b.partido));
    const total = partido ? (partidos.find((p) => p.partido === partido) || { n: 0 }).n : partidos.reduce((s, p) => s + p.n, 0);
    const rows = all(`SELECT DISTINCT v.* FROM intervencoes v JOIN iv_ini i ON i.iv_id = v.id WHERE ${where}${partido ? ` AND ${grp} = ?` : ""} ORDER BY v.data, v.id LIMIT ? OFFSET ?`,
      ...(partido ? [arg, partido] : [arg]), limit, offset);
    const cv = coverage();
    return { available: true, total: partidos.reduce((s, p) => s + p.n, 0), filtered: total, limit, offset, partidos,
      items: rows.map((r) => ({ ...shape(r), grupo: r.kind === "dep" ? r.partido : "Governo" })),
      coverage: { meetings: cv.meetings, first: cv.first, last: cv.last },
      note: "Intervenções em sessão plenária (Diário da Assembleia da República, I Série) ligadas à iniciativa pelo anúncio da ordem do dia feito pelo Presidente; nunca por aproximação de texto." };
  };

  routes["/api/intervencoes/deputado"] = (q) => {
    if (!dbh()) return missing;
    if (!ready()) return { ...missing, error: "intervencoes.db ainda sem dados." };
    const id = num(q.get("id"), 0, 0, 1e9), limit = num(q.get("limit"), 12, 1, 60);
    const total = one("SELECT COUNT(*) n FROM intervencoes WHERE dep_bid = ?", id).n;
    const rows = all("SELECT * FROM intervencoes WHERE dep_bid = ? ORDER BY data DESC, id DESC LIMIT ?", id, limit);
    const links = rows.length ? all(`SELECT iv_id, bid, key, ref FROM iv_ini WHERE iv_id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id)) : [];
    return { available: true, total, linked: one("SELECT COUNT(DISTINCT v.id) n FROM intervencoes v JOIN iv_ini i ON i.iv_id = v.id WHERE v.dep_bid = ?", id).n,
      items: rows.map((r) => ({ ...shape(r), iniciativas: links.filter((l) => l.iv_id === r.id).map((l) => ({ bid: l.bid, key: l.key, ref: l.ref })) })) };
  };

  routes["/api/intervencoes/intervencao"] = (q) => {
    if (!dbh()) return missing;
    const r = one("SELECT * FROM intervencoes WHERE id = ?", num(q.get("id"), 0, 0, 1e9));
    if (!r) return { available: true, error: "Intervenção não encontrada." };
    return { available: true, ...shape(r), texto: r.texto, agenda: r.agenda,
      iniciativas: all("SELECT bid, key, ref FROM iv_ini WHERE iv_id = ?", r.id) };
  };
}
