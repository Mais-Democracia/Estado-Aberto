// Atos do Presidente da República: promulgações, vetos, fiscalização pelo TC, nomeações… (data/presidencia.db, ingest/jobs/presidencia.py).
// Ligações às votações/DRE só por referência explícita; a cobertura de cada fonte é devolvida em `cobertura`.
export default function register({ routes, openData }) {
  let mine = null;
  const h = () => (mine ||= openData("presidencia"));
  const all = (sql, ...p) => h().prepare(sql).all(...p);
  const one = (sql, ...p) => h().prepare(sql).get(...p);
  const ready = () => { try { return !!h() && !!one("SELECT 1 x FROM atos LIMIT 1"); } catch { return false; } };
  const missing = { available: false, error: "presidencia.db ainda não existe — corra `python3 ingest/run_all.py presidencia`." };
  const esc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const PRES_ORDER = ["Américo Thomaz", "António de Spínola", "Francisco da Costa Gomes", "António Ramalho Eanes", "Mário Soares", "Jorge Sampaio", "Aníbal Cavaco Silva", "Marcelo Rebelo de Sousa", "António José Seguro"];
  const TIPOS = { promulgacao: "Promulgação", veto: "Veto", envio_tc: "Pedido ao Tribunal Constitucional", nomeacao: "Nomeação", exoneracao: "Exoneração", ratificacao: "Ratificação de tratado", homologacao: "Homologação/confirmação (militares)", dissolucao: "Dissolução", indulto: "Indulto", condecoracao: "Condecoração", eleicoes: "Marcação de eleições", outro: "Outro" };
  const meta = () => Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
  const cobertura = () => Object.fromEntries(all("SELECT chave, valor FROM cobertura").map((r) => [r.chave, r.valor]));

  // Uma fonte por período para decretos da AR: <2022-04-27 DRE (parcial); 2022-04-27..2023-12-31 só votações (linhas com iniciativa); >=2024 DRE completo + decretos sem lei publicada.
  const AR = "diploma_tipo IN ('Lei','Lei Orgânica','Decreto da Assembleia da República') AND (data < '2022-04-27' OR data >= '2024-01-01' OR iniciativa_key IS NOT NULL)";
  const PROM_OK = "(diploma_tipo NOT IN ('Lei','Lei Orgânica','Decreto da Assembleia da República') OR data < '2022-04-27' OR data >= '2024-01-01' OR iniciativa_key IS NOT NULL)";
  function daysStats(where, params = []) {
    const rows = all(`SELECT ano, dias_aprovacao d, diploma_tipo t, presidente p FROM atos WHERE canon=1 AND tipo='promulgacao' AND dias_aprovacao IS NOT NULL AND ((${AR}) OR diploma_tipo='Decreto-Lei') ${where}`, ...params);
    return rows;
  }

  routes["/api/presidencia/overview"] = () => {
    if (!ready()) return missing;
    const m = meta();
    const porAno = all(`SELECT ano, tipo, COUNT(*) n FROM atos WHERE canon=1 AND tipo IN ('promulgacao','veto','envio_tc') AND (tipo<>'promulgacao' OR ${PROM_OK}) GROUP BY ano, tipo ORDER BY ano`);
    const anos = {};
    // vetos: sem fonte estruturada antes de 2022-04 -> null (n/d), nunca 0
    for (const r of porAno) (anos[r.ano] ||= { ano: r.ano, promulgacao: 0, veto: r.ano >= 2022 ? 0 : null, envio_tc: 0 })[r.tipo] = r.tipo === "veto" && r.ano < 2022 ? null : r.n;
    const ar = Object.fromEntries(all(`SELECT ano, COUNT(*) n FROM atos WHERE canon=1 AND tipo='promulgacao' AND ${AR} GROUP BY ano`).map((r) => [r.ano, r.n]));
    const dlc = Object.fromEntries(all(`SELECT ano, COUNT(*) n FROM atos WHERE canon=1 AND tipo='promulgacao' AND diploma_tipo='Decreto-Lei' GROUP BY ano`).map((r) => [r.ano, r.n]));
    const orgn = (a) => (a < 2022 ? "dre_parcial" : a === 2022 ? "misto" : a === 2023 ? "votacoes" : "dre");
    for (const a of Object.values(anos)) { a.ar = ar[a.ano] || 0; a.dl = dlc[a.ano] || 0; a.fonte_ar = orgn(a.ano); a.dl_parcial = a.ano < 2024; }
    const dias = daysStats("");
    const dAno = {};
    for (const r of dias) (dAno[r.ano] ||= { Lei: [], "Decreto-Lei": [] });
    for (const r of dias) { const k = r.t === "Decreto-Lei" ? "Decreto-Lei" : r.t === "Lei" || r.t === "Lei Orgânica" || r.t === "Decreto da Assembleia da República" ? "Lei" : null; if (k) dAno[r.ano][k].push(r.d); }
    const diasAno = Object.keys(dAno).sort().filter((a) => a >= 2016).map((a) => ({ ano: Number(a), lei: median(dAno[a].Lei), n_lei: dAno[a].Lei.length, dl: median(dAno[a]["Decreto-Lei"]), n_dl: dAno[a]["Decreto-Lei"].length }));
    const pres = PRES_ORDER.map((p) => {
      const covV = p === "António José Seguro" || p === "Marcelo Rebelo de Sousa";   // vetos: votações XV–XVII (2022-04 em diante)
      const c = (t) => one(`SELECT COUNT(*) n FROM atos WHERE canon=1 AND presidente=? AND tipo=? AND (tipo<>'promulgacao' OR ${PROM_OK})`, p, t).n;
      const d = dias.filter((r) => r.p === p);
      const lei = d.filter((r) => r.t === "Lei" || r.t === "Lei Orgânica").map((r) => r.d), dl = d.filter((r) => r.t === "Decreto-Lei").map((r) => r.d);
      const env = all("SELECT dias_envio d FROM atos WHERE canon=1 AND presidente=? AND tipo='promulgacao' AND dias_envio IS NOT NULL", p).map((r) => r.d);
      const vt = all("SELECT desfecho, motivo FROM vetos WHERE presidente=?", p);
      const first = one("SELECT MIN(data) a, MAX(data) b FROM atos WHERE canon=1 AND presidente=? AND fonte IN ('dre','votacoes','tc')", p);
      const vcov = one("SELECT COUNT(*) n FROM atos WHERE presidente=? AND fonte='votacoes'", p).n;
      return { presidente: p, promulgacoes: c("promulgacao"), vetos: covV ? c("veto") : null, vetos_politicos: covV ? vt.filter((v) => v.motivo === "politico").length : null, vetos_tc: covV ? vt.filter((v) => v.motivo === "tc").length : null, vetos_desde: covV ? "2022-04-27" : null,
        pedidos_tc: c("envio_tc"), nomeacoes: c("nomeacao"),
        confirmados: vt.filter((v) => v.desfecho === "confirmado").length, reformulados: vt.filter((v) => v.desfecho === "reformulado").length, caducados: vt.filter((v) => v.desfecho === "caducou").length, sem_desfecho: vt.filter((v) => !["confirmado", "reformulado", "caducou"].includes(v.desfecho)).length,
        dias_mediana_lei: median(lei), n_lei: lei.length, dias_mediana_dl: median(dl), n_dl: dl.length, dias_envio_mediana: median(env), n_envio: env.length,
        cobertura_votacoes: covV, primeiro: first.a, ultimo: first.b };
    }).filter((p) => p.promulgacoes + (p.vetos || 0) + p.pedidos_tc > 0);
    const tipos = all(`SELECT tipo, COUNT(*) n FROM atos WHERE canon=1 GROUP BY tipo ORDER BY n DESC`).map((r) => ({ ...r, label: TIPOS[r.tipo] || r.tipo }));
    const tot = one("SELECT COUNT(*) n, MIN(data) a, MAX(data) b FROM atos WHERE canon=1");
    // linking rates
    const lei = one(`SELECT COUNT(*) n, SUM(iniciativa_key IS NOT NULL) l FROM atos WHERE canon=1 AND fonte='dre' AND diploma_tipo IN ('Lei','Lei Orgânica') AND data>='2022-04-27'`);
    const ven = one(`SELECT COUNT(*) n, SUM(mensagem_url IS NOT NULL) m, SUM(decreto_ref IS NOT NULL) d FROM vetos WHERE data>='2026-03-09'`);
    const tcp = one(`SELECT COUNT(*) n, SUM(iniciativa_key IS NOT NULL) l, SUM(decreto_ref IS NOT NULL) d FROM tc_pedidos WHERE data>='2022-04-27'`);
    const news = one(`SELECT COUNT(*) n, SUM(n_diplomas) nd FROM comunicados WHERE tipo LIKE 'promulgacao%'`);
    const dreNow = one(`SELECT COUNT(*) n FROM atos WHERE canon=1 AND fonte='dre' AND tipo='promulgacao' AND data>='2026-03-09'`).n;
    const recentes = all(`SELECT id, data, tipo, subtipo, presidente, titulo, diploma_ref, source_url, mensagem_url FROM atos WHERE canon=1 AND tipo IN ('promulgacao','veto','envio_tc','dissolucao') ORDER BY data DESC, id LIMIT 12`);
    return { available: true, built_at: m.built_at, total: tot, tipos, anos: Object.values(anos), dias_ano: diasAno, presidentes: pres, recentes, cobertura: cobertura(),
      ligacoes: { leis_ligadas: lei, vetos_2026: ven, tc_pedidos: tcp, comunicados_promulgacao: news, promulgacoes_dre_desde_mandato: dreNow } };
  };

  routes["/api/presidencia/atos"] = (q) => {
    if (!ready()) return missing;
    const w = ["canon=1"], p = [];
    const tipo = q.get("tipo"); if (tipo) { w.push("tipo=?"); p.push(tipo); }
    const ano = q.get("ano"); if (ano && /^\d{4}$/.test(ano)) { w.push("ano=?"); p.push(Number(ano)); }
    const pr = q.get("presidente"); if (pr) { w.push("presidente=?"); p.push(pr); }
    const text = (q.get("q") || "").trim().slice(0, 80);
    if (text) { w.push("(titulo LIKE ? ESCAPE '\\' OR diploma_ref LIKE ? ESCAPE '\\' OR decreto_ref LIKE ? ESCAPE '\\')"); const l = `%${esc(text)}%`; p.push(l, l, l); }
    if (q.get("todos") === "1") w.shift();
    const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1), limit = 40;
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const total = one(`SELECT COUNT(*) n FROM atos ${where}`, ...p).n;
    const rows = all(`SELECT id, data, tipo, subtipo, presidente, diploma_tipo, diploma_ref, decreto_ref, iniciativa_key, dre_act_id, titulo, dias_aprovacao, dias_envio, fonte, source_url, mensagem_url, acordao_tc, canon
      FROM atos ${where} ORDER BY data DESC, id LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
    return { available: true, total, page, limit, rows, tipos: Object.entries(TIPOS).map(([k, v]) => ({ tipo: k, label: v })),
      anos: all("SELECT DISTINCT ano FROM atos WHERE canon=1 ORDER BY ano DESC").map((r) => r.ano) };
  };

  routes["/api/presidencia/ato"] = (q) => {
    if (!ready()) return missing;
    const id = q.get("id") || "";
    const a = one("SELECT * FROM atos WHERE id=?", id);
    if (!a) return { error: "Ato não encontrado." };
    const out = { available: true, ato: a, veto: one("SELECT * FROM vetos WHERE id=?", id) || null };
    if (out.veto) { try { out.veto.iniciativas = JSON.parse(out.veto.iniciativas || "[]"); } catch { out.veto.iniciativas = []; } }
    out.tc = a.acordao_tc ? all("SELECT * FROM tc_pedidos WHERE acordao_id=? OR acordao_id=?", a.acordao_tc.split(", ")[0], id.replace(/^tc:/, "")) : id.startsWith("tc:") ? all("SELECT * FROM tc_pedidos WHERE acordao_id=?", id.slice(3)) : [];
    out.comunicados = all("SELECT url, data, titulo, link_metodo FROM comunicados WHERE ato_id=?", id);
    return out;
  };

  routes["/api/presidencia/vetos"] = (q) => {
    if (!ready()) return missing;
    const w = [], p = [];
    const pr = q.get("presidente"); if (pr) { w.push("presidente=?"); p.push(pr); }
    const rows = all(`SELECT * FROM vetos ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY data DESC`, ...p).map((v) => {
      try { v.iniciativas = JSON.parse(v.iniciativas || "[]"); } catch { v.iniciativas = []; }
      if (v.mensagem_texto) v.mensagem_texto = v.mensagem_texto.slice(0, 1500);
      return v;
    });
    const por = {};
    for (const v of rows) { const k = v.desfecho || "sem_desfecho"; por[k] = (por[k] || 0) + 1; }
    const tc = all(`SELECT t.*, v.data veto_data FROM tc_pedidos t LEFT JOIN vetos v ON v.id=t.veto_id WHERE t.requerente='Presidente da República' ORDER BY t.data DESC LIMIT 120`);
    const tcPor = all(`SELECT presidente, requerente, tipo, COUNT(*) n, SUM(resultado LIKE 'Pronúncia pela inconst%' OR resultado LIKE '%declaração de inconst%') inconst FROM tc_pedidos GROUP BY presidente, requerente, tipo`);
    return { available: true, total: rows.length, rows, desfechos: por, tc_pedidos_pr: tc, tc_por_requerente: tcPor, cobertura: cobertura() };
  };
}
