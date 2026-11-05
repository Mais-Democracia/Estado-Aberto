export default function register({ routes, openData, all: coreAll, one: coreOne, DataMissing, unavailable }) {
  const TTL = 600000;
  const dbs = {};
  const db = (n) => (dbs[n] ||= openData(n)) || (() => { throw new DataMissing(n); })();
  const Q = (n, sql, ...a) => db(n).prepare(sql).all(...a);
  const Q1 = (n, sql, ...a) => db(n).prepare(sql).get(...a);
  const call = (p, params = {}) => routes[p](new URLSearchParams(params));
  const ok = (r) => (r && r.available !== false && !r.error ? r : null);
  const r1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const enc = encodeURIComponent;

  const PCOL = { PSD: "#f48a1f", "PSD+": "#f9b565", CH: "#202056", PS: "#e8537a", IL: "#00a7e6", L: "#8bc34a", PCP: "#c8102e", CDU: "#c8102e", BE: "#a00000", "CDS-PP": "#0073c2", PAN: "#2a9d8f", JPP: "#6a4c93", PEV: "#2e7d32", Independentes: "#868e96", Outros: "#b0b7c3" };
  const SENSE_COL = { favor: "#2e9e5b", contra: "#d64545", abstencao: "#e0a526", ausencia: "#aab0bb", dividido: "#8a63d2" };
  const partyGroup = (p) => {
    const s = String(p || "");
    if (s === "PS") return "PS";
    if (s === "PPD/PSD") return "PSD";
    if (/PPD\/PSD/.test(s)) return "PSD+";
    if (/^PCP/.test(s)) return "CDU";
    if (["CDS-PP", "CH", "JPP", "IL", "L", "BE", "PAN"].includes(s)) return s;
    return /^[A-Z#0-9. -]{1,12}$/.test(s) || /\d/.test(s) ? "Independentes" : "Independentes";
  };

  const counter = (value, label, unit, delta, asof, extra = {}) => ({ type: "counter", value, label, unit, delta: delta ?? null, asof, ...extra });
  const bars = (rows, asof, extra = {}) => (rows && rows.length ? { type: "bars", asof, rows, ...extra } : null);
  const list = (rows, asof, extra = {}) => (rows && rows.length ? { type: "list", asof, rows, ...extra } : null);
  const tiles = (t, asof, extra = {}) => (t && t.length ? { type: "tiles", asof, tiles: t, ...extra } : null);
  const timeline = (points, asof, events = [], extra = {}) => (points && points.length ? { type: "timeline", asof, points, events, ...extra } : null);
  const sankey = (nodes, links, asof, extra = {}) => (links && links.length ? { type: "sankey", asof, nodes, links, ...extra } : null);
  const network = (nodes, links, asof, extra = {}) => (nodes && nodes.length ? { type: "network", asof, nodes, links, ...extra } : null);
  const scatter = (points, xLabel, yLabel, median, asof, extra = {}) => (points && points.length ? { type: "scatter", asof, points, xLabel, yLabel, median, ...extra } : null);

  const today = () => new Date().toISOString().slice(0, 10);
  const monthKey = (d) => String(d || "").slice(0, 7);

  let muniCache = null;
  const munis = () => {
    if (muniCache && Date.now() - muniCache.at < TTL) return muniCache.v;
    const rows = call("/api/autarquias/list").rows || [];
    muniCache = { at: Date.now(), v: rows };
    return rows;
  };
  const findMuni = (s) => {
    const k = norm(s);
    if (!k) return null;
    const rows = munis();
    return rows.find((m) => m.dico === s) || rows.find((m) => norm(m.name) === k) || rows.find((m) => norm(m.name).startsWith(k)) || null;
  };

  const phaseFlow = () => {
    const rows = Q("votacoes", `SELECT i.bid, i.resultado_generalidade rg,
        MAX(f.fase = 'Votação na generalidade') g, MAX(f.fase = 'Votação final global') fg,
        MAX(f.fase LIKE 'Promulgação%') prom, MAX(f.fase LIKE 'Veto (Rece%') veto, MAX(f.fase = 'Lei (Publicação DR)') pub
        FROM iniciativas i LEFT JOIN fases f ON f.bid = i.bid
        WHERE i.leg = 'XVII' AND i.tipo IN ('Projeto de Lei', 'Proposta de Lei') GROUP BY i.bid`);
    const c = { n: rows.length, semVotacao: 0, gRej: 0, gOk: 0, espec: 0, fg: 0, fgProm: 0, fgVeto: 0, fgAguarda: 0, pub: 0 };
    for (const r of rows) {
      if (!r.g) { c.semVotacao++; continue; }
      const aprov = /^Aprovad/.test(r.rg || "");
      if (!aprov) { c.gRej++; continue; }
      c.gOk++;
      if (!r.fg) { c.espec++; continue; }
      c.fg++;
      if (r.veto) c.fgVeto++; else if (r.prom) { c.fgProm++; if (r.pub) c.pub++; } else c.fgAguarda++;
    }
    return c;
  };
  const billSankey = () => {
    const c = phaseFlow();
    const nodes = [
      ["entrada", "Projetos e propostas de lei (XVII)"], ["semvot", "Sem votação na generalidade"], ["rej", "Rejeitados na generalidade"], ["gok", "Aprovados na generalidade"],
      ["espec", "Em especialidade"], ["fg", "Votação final global"], ["aguarda", "Aguardam promulgação"], ["prom", "Promulgados"], ["veto", "Vetados"], ["pub", "Publicados em DR"],
    ].map(([id, label]) => ({ id, label }));
    const L = [["entrada", "semvot", c.semVotacao], ["entrada", "rej", c.gRej], ["entrada", "gok", c.gOk], ["gok", "espec", c.espec], ["gok", "fg", c.fg],
      ["fg", "aguarda", c.fgAguarda], ["fg", "prom", c.fgProm], ["fg", "veto", c.fgVeto], ["prom", "pub", c.pub]];
    const last = Q1("votacoes", "SELECT MAX(data_ultima) d FROM iniciativas WHERE leg = 'XVII'").d;
    return sankey(nodes, L.filter((l) => l[2] > 0).map(([s, t, v]) => ({ s, t, v })), last, { href: "#/votacoes", total: c.n });
  };

  const fontes = {
    parlamento: [["Votações e processo legislativo (parlamento.pt)", "#/votacoes"], ["Posições dos partidos", "#/posicoes"], ["Intervenções parlamentares", "#/intervencoes"], ["Deputados", "#/deputados"], ["Atos do Presidente", "#/atos-presidente"], ["Diário da República", "#/dre"]],
    governo: [["Ministérios", "#/ministerios"], ["Responsáveis e nomeações", "#/responsaveis"], ["Diário da República", "#/dre"], ["Estado empregador", "#/estado"], ["Atos do Presidente", "#/atos-presidente"]],
    dinheiro: [["Orçamento e execução", "#/orcamento"], ["Contratos públicos", "#/contratos"], ["Indicadores de risco", "#/risco"], ["Fundos europeus", "#/fundos"], ["Dívida pública", "#/divida"], ["Ministérios", "#/ministerios"]],
    "poder-local": [["Autarquias", "#/autarquias-mapa"], ["IGF", "#/igf"], ["Fundos europeus", "#/fundos"], ["Empresas locais", "#/empresas-locais"], ["Regiões autónomas", "#/regioes"], ["Eleições", "#/eleicoes"]],
    instituicoes: [["Entidades públicas", "#/entidades"], ["Reguladores", "#/reguladores"], ["Saúde", "#/saude"], ["Segurança", "#/seguranca"], ["Educação", "#/educacao"]],
    "leis-justica": [["Diário da República", "#/dre"], ["Votações", "#/votacoes"], ["Atos do Presidente", "#/atos-presidente"], ["Justiça", "#/justica"], ["Provedor de Justiça", "#/provedor"], ["IGF", "#/igf"]],
    indicadores: [["Indicadores INE", "#/indicadores"], ["Habitação", "#/habitacao"], ["Imigração", "#/imigracao"], ["Educação (DGEEC)", "#/dgeec"]],
  };

  const builders = {};

  builders.parlamento = (D) => {
    const st = ok(call("/api/votacoes/stats"));
    const lastVote = st?.coverage?.last_vote;
    D("votos", () => {
      const cov = st.coverage;
      const win = (a, b) => Q1("votacoes", "SELECT COUNT(*) n FROM votos WHERE orgao = 'Plenário' AND data > date(?, ?) AND data <= date(?, ?)", lastVote, a, lastVote, b).n;
      const cur = win("-28 days", "+0 days"), prev = win("-56 days", "-28 days");
      return { type: "counters", asof: lastVote, items: [
        counter(cov.plenary_votes, "Votações em plenário", "votações", null, lastVote, { href: "#/votacoes" }),
        counter(cur, "Votações nas últimas 4 semanas", "votações", cur - prev, lastVote, { href: "#/votacoes" }),
        counter(cov.stored, "Iniciativas acompanhadas", "iniciativas", null, cov.updated_at?.slice(0, 10), { href: "#/votacoes" }),
        counter(cov.individual_votes, "Votos individuais divergentes", "votos", null, lastVote),
        counter(cov.dre_linked, "Iniciativas ligadas ao Diário da República", "iniciativas", null, cov.updated_at?.slice(0, 10), { href: "#/dre" }),
      ] };
    });
    D("hemiciclo", () => {
      const v = Q1("votacoes", `SELECT v.id, v.data, v.resultado, v.fase, i.key, i.titulo, i.leg FROM votos v JOIN iniciativas i ON i.bid = v.bid
          WHERE v.orgao = 'Plenário' AND v.fase LIKE '%final global%' AND (SELECT COUNT(*) FROM voto_partido x WHERE x.voto_id = v.id AND x.kind IN ('gp','dividido')) >= 5
          ORDER BY v.data DESC, v.id DESC LIMIT 1`);
      const seats = JSON.parse(Q1("votacoes", "SELECT value FROM meta WHERE key = ?", "seats_" + v.leg).value);
      const tk = Q("votacoes", "SELECT partido, kind, sentido FROM voto_partido WHERE voto_id = ? AND kind IN ('gp','dividido')", v.id);
      const by = {};
      for (const t of tk) by[t.partido] = t.kind === "dividido" ? "dividido" : t.sentido;
      const order = ["BE", "PCP", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS-PP", "CH"];
      const parties = Object.keys(seats).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      const tot = {};
      for (const p of parties) { const s = by[p] || null; if (s) tot[s] = (tot[s] || 0) + seats[p]; }
      return { type: "hemicycle", asof: v.data, title: v.titulo, result: v.resultado, fase: v.fase, href: "#/votacoes/" + enc(v.key), legislatura: v.leg,
        seats: parties.map((p) => ({ party: p, color: PCOL[p] || "#999", vote: by[p] || null, n: seats[p] })), seatsBySense: tot, senseColors: SENSE_COL };
    });
    D("votosSemana", () => {
      const rows = Q("votacoes", `SELECT v.data, v.fase, v.resultado, i.key, i.tipo, i.numero, i.titulo FROM votos v JOIN iniciativas i ON i.bid = v.bid
          WHERE v.orgao = 'Plenário' AND v.fase LIKE '%final global%' AND v.data > date(?, '-7 days') GROUP BY i.bid, v.data ORDER BY v.data DESC, v.id DESC LIMIT 10`, lastVote);
      return list(rows.map((r) => ({ title: r.titulo.slice(0, 140), sub: `${r.tipo} ${r.numero} · ${r.data}`, tag: r.resultado, href: "#/votacoes/" + enc(r.key) })), lastVote);
    });
    D("funil", billSankey);
    D("posicoes", () => {
      const d = ok(call("/api/posicoes/declaracoes", { limit: 1 }));
      const pts = d.partidos.filter((p) => p.comparaveis > 0).map((p) => ({ x: p.comparaveis, y: r1(100 * p.coincidem / p.comparaveis, 0), label: p.partido, color: PCOL[p.partido] || "#999", href: "#/posicoes/" + enc(p.partido) }));
      return scatter(pts, "Declarações comparáveis (n.º)", "Votaram como declararam (%)", { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) }, ok(call("/api/posicoes/stats"))?.updated_at?.slice(0, 10),
        { total: { declaracoes: d.declaracoes, comparaveis: d.comparaveis, coincidem: d.coincidem, divergem: d.divergem } });
    });
    D("intervencoes", () => {
      const m = ok(call("/api/posicoes/matriz"));
      const asof = ok(call("/api/intervencoes/stats"))?.coverage?.last;
      return bars(m.totals.sort((a, b) => b.n - a.n).map((t) => ({ label: t.partido, value: t.n, color: PCOL[t.partido] || "#999", href: "#/posicoes/" + enc(t.partido) })), asof, { unit: "intervenções" });
    });
    D("alteracoesBancada", () => {
      const ch = ok(call("/api/deputados/changes")).changes;
      const by = {};
      for (const c of ch) by[c.party] = (by[c.party] || 0) + 1;
      return bars(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ label: p, value: n, color: PCOL[p] || "#999", href: "#/deputados" })), ch.map((c) => c.date).sort().pop(), { unit: "substituições" });
    });
    D("agenda", () => {
      const rows = coreAll("SELECT id, title, start, section, local FROM events WHERE start >= date('now') ORDER BY start LIMIT 8");
      return list(rows.map((e) => ({ title: e.title, sub: [e.section, e.local].filter(Boolean).join(" · "), tag: String(e.start).slice(0, 10), href: "#/calendario" })), today());
    });
  };

  builders.governo = (D) => {
    D("rede", () => {
      const mins = ok({ available: true, ...call("/api/ministerios/list") }).ministries;
      const nodes = [{ id: "gov", label: "Governo", size: mins.length, group: "governo", href: "#/ministerios" }];
      const links = [];
      const eid = Object.fromEntries(Q("ministerios", "SELECT nif, MAX(entity_id) e FROM bodies WHERE nif IS NOT NULL GROUP BY nif").map((r) => [r.nif, r.e]));
      for (const m of mins) {
        nodes.push({ id: m.slug, label: m.short || m.name, size: m.spend || 1, group: "ministerio", href: "#/ministerios/" + m.slug });
        links.push({ s: "gov", t: m.slug, v: Math.round(m.spend || 1) });
        for (const p of Q("ministerios", "SELECT name, role, kind FROM people WHERE ministry = ? AND kind = 'secretario_estado'", m.slug)) {
          const id = "se:" + m.slug + ":" + norm(p.name).replace(/\W+/g, "-");
          nodes.push({ id, label: p.name, size: 1, group: "secretario", href: "#/ministerios/" + m.slug });
          links.push({ s: m.slug, t: id, v: 1 });
        }
        for (const b of Q("ministerios", "SELECT nif, name, value FROM spend_body WHERE ministry = ? ORDER BY value DESC LIMIT 3", m.slug)) {
          const id = "ent:" + b.nif;
          if (!nodes.some((n) => n.id === id)) nodes.push({ id, label: b.name.slice(0, 48), size: Math.round(b.value), group: "entidade", href: eid[b.nif] ? "#/entidade/" + eid[b.nif] : "#/ministerios/" + m.slug });
          links.push({ s: m.slug, t: id, v: Math.round(b.value) });
        }
      }
      return network(nodes, links, ok(call("/api/ministerios/list")) ? Q1("ministerios", "SELECT value v FROM meta WHERE key = 'updated'")?.v?.slice(0, 10) : null, { unitLinks: "EUR contratados (gabinetes: 1)" });
    });
    D("nomeacoes", () => {
      const rows = Q("responsaveis", "SELECT substr(date,1,7) m, COUNT(*) n FROM nomeacoes WHERE date IS NOT NULL GROUP BY m ORDER BY m");
      const max = Q1("responsaveis", "SELECT MAX(date) d FROM nomeacoes").d;
      return timeline(rows.map((r) => ({ t: r.m, v: r.n })), max, [], { label: "Nomeações, designações e exonerações publicadas no DR (por mês)", href: "#/responsaveis" });
    });
    D("decretosLei", () => {
      const rows = Q("dre", "SELECT substr(date,1,7) m, COUNT(*) n FROM acts WHERE kind = 'Decreto-Lei' AND date >= '2024-01-01' GROUP BY m ORDER BY m");
      const since = Q1("ministerios", "SELECT MIN(minister_since) d FROM ministries").d;
      return timeline(rows.map((r) => ({ t: r.m, v: r.n })), Q1("dre", "SELECT MAX(date) d FROM acts").d, since ? [{ t: since.slice(0, 7), label: "Ministros em funções desde " + since, href: "#/ministerios" }] : [], { label: "Decretos-Lei publicados (por mês)", href: "#/dre" });
    });
    D("empregoPublico", () => {
      const o = call("/api/estado/overview").workforce;
      const rows = o.subsector.map((s) => ({ label: s.subsector, value: s.workers, color: "#4c78a8", href: "#/estado" }));
      return bars(rows, o.ref, { unit: "trabalhadores", total: o.last.public_workers, delta: o.last.public_workers - o.prevYear.public_workers });
    });
    D("empregoContrato", () => {
      const o = call("/api/estado/overview").workforce;
      return bars(o.contract.map((c) => ({ label: c.label, value: c.workers, color: "#7a8fb3", href: "#/estado" })), o.contractRef, { unit: "trabalhadores" });
    });
    D("empregoSerie", () => {
      const o = call("/api/estado/emprego");
      return timeline(o.rows.map((r) => ({ t: r.ref_date, v: r.public_workers })), o.rows[o.rows.length - 1].ref_date, [], { label: "Trabalhadores das administrações públicas", href: "#/estado" });
    });
    D("promulgacoesVetos", () => {
      const o = ok(call("/api/presidencia/overview"));
      const p = o.presidentes[o.presidentes.length - 1];
      return { type: "counters", asof: o.total.b, presidente: p.presidente, items: [
        counter(p.promulgacoes, "Promulgações", "diplomas", null, o.total.b, { href: "#/atos-presidente" }),
        counter(p.vetos, "Vetos", "diplomas", null, o.total.b, { href: "#/atos-presidente" }),
        counter(p.pedidos_tc, "Pedidos ao Tribunal Constitucional", "pedidos", null, o.total.b),
      ] };
    });
  };

  builders.dinheiro = (D) => {
    D("orcamento", () => {
      const o = call("/api/orcamento/oe");
      const AGG = ["Impostos Diretos", "Impostos Indiretos", "Receita Fiscal do Estado"];
      const taxes = o.taxes.filter((t) => t.value > 0 && !AGG.includes(t.line) && !/^Outros/.test(t.line)).sort((a, b) => b.value - a.value).slice(0, 7);
      const byMin = {};
      for (const p of o.programas) if (p.value > 0) (byMin[p.ministry || "soberania"] ||= { name: p.ministryName || "Órgãos de soberania", value: 0, progs: [] }, byMin[p.ministry || "soberania"]).value += p.value, byMin[p.ministry || "soberania"].progs.push(p);
      const mins = Object.entries(byMin).sort((a, b) => b[1].value - a[1].value).slice(0, 12);
      const nodes = [{ id: "oe", label: "Orçamento do Estado " + o.oe }, ...taxes.map((t, i) => ({ id: "r" + i, label: t.line })), ...mins.map(([k, m]) => ({ id: "m:" + k, label: m.name }))];
      const links = [...taxes.map((t, i) => ({ s: "r" + i, t: "oe", v: Math.round(t.value) })), ...mins.map(([k, m]) => ({ s: "oe", t: "m:" + k, v: Math.round(m.value) }))];
      for (const [k, m] of mins) if (m.progs.length > 1) for (const p of m.progs) { const id = "p:" + k + ":" + p.line; nodes.push({ id, label: p.line }); links.push({ s: "m:" + k, t: id, v: Math.round(p.value) }); }
      return sankey(nodes, links, String(o.oe), { unit: "M€", href: "#/orcamento", note: "receita (impostos) e despesa (programas por ministério) não se equilibram: o saldo é financiado por outras receitas e dívida" });
    });
    D("contratosMes", () => {
      const rows = coreAll("SELECT substr(signed,1,7) m, COUNT(*) n, ROUND(SUM(price)/1e6, 1) v FROM contracts WHERE signed >= date('now', 'start of month', '-35 months') AND signed <= date('now') GROUP BY m ORDER BY m");
      const asof = coreOne("SELECT MAX(signed) d FROM contracts WHERE signed <= date('now')").d;
      return { type: "timeline", asof, points: rows.map((r) => ({ t: r.m, v: r.v })), events: [], label: "Valor contratado por mês (M€)", href: "#/contratos",
        count: rows.map((r) => ({ t: r.m, v: r.n })) };
    });
    D("rede", () => {
      const ms = Q("ministerios", "SELECT slug, name, short FROM ministries");
      const mv = Object.fromEntries(Q("ministerios", "SELECT ministry, SUM(value) v FROM spend_body GROUP BY ministry").map((r) => [r.ministry, r.v]));
      const bodies = Q("ministerios", "SELECT ministry, nif, name, value FROM spend_body ORDER BY value DESC LIMIT 90");
      const sups = Q("ministerios", "SELECT ministry, seller_nif nif, seller_name name, value FROM spend_sup ORDER BY value DESC LIMIT 110");
      const eid = Object.fromEntries(Q("ministerios", "SELECT nif, MAX(entity_id) e FROM bodies WHERE nif IS NOT NULL GROUP BY nif").map((r) => [r.nif, r.e]));
      const nodes = new Map(), links = [];
      for (const m of ms) nodes.set(m.slug, { id: m.slug, label: m.short || m.name, size: Math.round(mv[m.slug] || 1), group: "ministerio", href: "#/ministerios/" + m.slug });
      const add = (m, r, group) => {
        const id = (group === "entidade" ? "e:" : "f:") + r.nif;
        if (!nodes.has(id)) { if (nodes.size >= 200) return; nodes.set(id, { id, label: String(r.name || r.nif).slice(0, 42), size: 0, group, href: eid[r.nif] ? "#/entidade/" + eid[r.nif] : "#/contratos" }); }
        nodes.get(id).size += Math.round(r.value);
        links.push({ s: m, t: id, v: Math.round(r.value) });
      };
      for (const b of bodies) add(b.ministry, b, "entidade");
      for (const s of sups) add(s.ministry, s, "fornecedor");
      return network([...nodes.values()], links, Q1("ministerios", "SELECT value v FROM meta WHERE key = 'updated'")?.v?.slice(0, 10), { unitLinks: "EUR contratados" });
    });
    D("risco", () => {
      const r = ok(call("/api/risco/entities", { limit: 12 }));
      return bars(r.rows.slice(0, 12).map((e) => ({ label: e.name, value: e.score, color: e.score >= 7 ? "#d64545" : "#e0a526", href: e.entity_id ? "#/entidade/" + e.entity_id : "#/risco" })), ok(call("/api/risco/overview"))?.built?.slice(0, 10), { unit: "pontuação de risco (0-10)", note: "indicadores, não acusações" });
    });
    D("fundosConcelho", () => {
      const pop = Object.fromEntries(munis().map((m) => [norm(m.name), m]));
      const rows = Q("fundos", "SELECT concelho, aprovado, pago FROM conc_totals").map((r) => ({ ...r, m: pop[norm(r.concelho)] })).filter((r) => r.m && r.m.population > 0);
      const all = rows.map((r) => ({ x: r.m.population, y: r1(r.aprovado / r.m.population, 0), label: r.concelho, color: PCOL[partyGroup(r.m.party)] || "#999", href: r.m.entity_id ? "#/entidade/" + r.m.entity_id : "#/fundos" }));
      const med = { x: median(all.map((p) => p.x)), y: median(all.map((p) => p.y)) };
      const pts = all.sort((a, b) => b.x - a.x).slice(0, 110);
      return scatter(pts, "População residente", "Fundos aprovados por habitante (EUR)", med, Q1("fundos", "SELECT value v FROM meta WHERE key = 'built'").v.replace(/"/g, "").slice(0, 10), { n: all.length, shown: pts.length });
    });
    D("divida", () => {
      const d = ok(call("/api/divida/overview"));
      return counter(Math.round(d.latest.total), "Dívida direta do Estado", "M€", Math.round(d.yoy), d.latest.date, { href: "#/divida", prazoMedioAnos: r1(d.latest.prazo_medio, 1), pctTaxaFixa: r1(d.latest.pct_fixa, 0) });
    });
  };

  builders["poder-local"] = (D) => {
    D("mapa", () => {
      const rows = munis();
      return tiles(rows.slice().sort((a, b) => b.population - a.population).map((m) => ({ label: m.name, value: m.population, href: "#/entidade/" + m.entity_id, group: partyGroup(m.party) })), "2025-10-12", { source: "Eleições autárquicas 2025", colors: PCOL });
    });
    D("partidos", () => {
      const by = {};
      for (const m of munis()) by[partyGroup(m.party)] = (by[partyGroup(m.party)] || 0) + 1;
      return bars(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ label: p, value: n, color: PCOL[p] || "#999", href: "#/autarquias-mapa" })), "2025-10-12", { unit: "municípios" });
    });
    D("indicadores", () => {
      const rows = munis().filter((m) => m.debt_pc != null && m.expense_pc != null);
      const med = { x: median(rows.map((m) => m.debt_pc)), y: median(rows.map((m) => m.expense_pc)) };
      const pts = rows.sort((a, b) => b.population - a.population).slice(0, 100).map((m) => ({ x: r1(m.debt_pc, 0), y: r1(m.expense_pc, 0), label: m.name, color: PCOL[partyGroup(m.party)] || "#999", href: "#/entidade/" + m.entity_id }));
      return scatter(pts, "Dívida por habitante (EUR)", "Despesa por habitante (EUR)", med, String(rows[0]?.fin_year), { n: rows.length, shown: pts.length });
    });
    D("igfAno", () => {
      const o = ok(call("/api/igf/overview"));
      return bars(o.years.map((y) => ({ label: String(y.year), value: y.n, color: "#4c78a8", href: "#/igf" })), o.built, { unit: "relatórios", total: o.total.n });
    });
    D("igfMunicipio", () => {
      const rows = Q("igf", "SELECT entity_name n, entity_nif nif, COUNT(*) c FROM reports WHERE kind = 'municipio' AND entity_name IS NOT NULL GROUP BY entity_nif ORDER BY c DESC, entity_name LIMIT 12");
      const byNif = Object.fromEntries(munis().map((m) => [m.nif, m]));
      return bars(rows.map((r) => ({ label: r.n, value: r.c, color: "#7a8fb3", href: byNif[r.nif]?.entity_id ? "#/entidade/" + byNif[r.nif].entity_id : "#/igf" })), ok(call("/api/igf/overview"))?.built, { unit: "relatórios" });
    });
    D("empresasLocais", () => {
      const o = ok(call("/api/empresas_locais/overview"));
      return bars(o.bySector.filter((s) => s.n > 0).sort((a, b) => b.n - a.n).slice(0, 10).map((s) => ({ label: s.sector, value: s.n, color: "#59a14f", href: "#/empresas-locais" })), Q1("empresas_locais", "SELECT value v FROM meta WHERE key = 'built'")?.v?.replace(/"/g, "").slice(0, 10) || null, { unit: "empresas", total: o.kpis.n });
    });
    D("regioes", () => {
      const rows = ["acores", "madeira"].map((id) => ok(call("/api/regioes/overview", { regiao: id }))).filter(Boolean);
      return bars(rows.map((r) => ({ label: r.region.short, value: Math.round(r.contracts.value / 1e6), color: "#4c78a8", href: "#/regioes/" + r.region.id })), Q1("regioes", "SELECT value v FROM meta WHERE key = 'built_at'").v, { unit: "M€ contratados", detalhe: rows.map((r) => ({ regiao: r.region.short, governo: r.region.gov_label, desde: r.region.gov_since, lugares: r.seats, contratos: r.contracts.n })) });
    });
  };
  const indexMunis = () => munis().map((m) => [m.name, m.entity_id, partyGroup(m.party)]);

  const inePanel = (m) => {
    const r = call("/api/ine_series/ranking");
    const row = r.rows.find((x) => x.dico === m.dico);
    if (!row) return null;
    return r.indicadores.map((i) => ({ key: i.key, label: i.label, unit: i.unit, value: row.v[i.key] ?? null, median: r.nacional[i.key]?.median ?? null, pt: r.nacional[i.key]?.ine_pt ?? null, year: i.last_year }));
  };

  const poderLocalConcelho = (name) => {
    const m = findMuni(name);
    if (!m) return { found: false, error: "Município não encontrado" };
    const igf = Q("igf", "SELECT code, year, title, report_url FROM reports WHERE entity_nif = ? OR (entity_nif IS NULL AND title LIKE ?) ORDER BY year DESC", m.nif, `%Município d_ ${m.name}%`);
    const fu = Q1("fundos", "SELECT n, aprovado, pago FROM conc_totals WHERE concelho = ?", m.name);
    const bs = coreOne("SELECT n, value, direct_value, single_bidder_n, competitive_n FROM buyer_stats WHERE nif = ?", m.nif);
    const el = Q1("empresas_locais", "SELECT n_companies, muni_to_companies_value, share_pct FROM muni WHERE dico = ?", m.dico);
    return { found: true, asof: today(),
      municipio: { name: m.name, dico: m.dico, district: m.district, population: m.population, populationYear: m.population_year, mayor: m.mayor, party: m.party, partyGroup: partyGroup(m.party), changed2025: !!m.changed_2025, winnerPct: m.winner_pct, majority: !!m.majority, turnout2025: m.turnout_2025, href: "#/entidade/" + m.entity_id },
      financas: { year: m.fin_year, expensePc: m.expense_pc, debtPc: m.debt_pc, personnelPct: m.personnel_pct, investPct: m.invest_pct, ownRevenuePct: m.own_revenue_pct, pmpDays: m.pmp_days, rankExpensePc: m.rank_expense_pc, rankDebtPc: m.rank_debt_pc, nRanked: m.n_ranked,
        medianExpensePc: median(munis().map((x) => x.expense_pc)), medianDebtPc: median(munis().map((x) => x.debt_pc)) },
      igf: { n: igf.length, reports: igf.slice(0, 6).map((r) => ({ title: r.title, year: r.year, href: r.report_url })), href: "#/igf" },
      fundos: fu ? { n: fu.n, aprovado: Math.round(fu.aprovado), pago: Math.round(fu.pago), aprovadoPc: m.population ? r1(fu.aprovado / m.population, 0) : null, href: "#/fundos" } : null,
      contratos: bs ? { n: bs.n, value: Math.round(bs.value), directShare: bs.value ? r1(bs.direct_value / bs.value, 2) : null, singleBidderShare: bs.competitive_n ? r1(bs.single_bidder_n / bs.competitive_n, 2) : null, href: "#/entidade/" + m.entity_id } : null,
      empresasLocais: el && el.n_companies ? { n: el.n_companies, valueFromMunicipality: Math.round(el.muni_to_companies_value), sharePct: r1(el.share_pct, 1), href: "#/empresas-locais" } : null,
      indicadores: inePanel(m) };
  };

  builders.instituicoes = (D) => {
    D("rede", () => {
      const kinds = coreAll("SELECT kind, COUNT(*) n, SUM(buyer_value) v FROM entities WHERE is_public = 1 GROUP BY kind ORDER BY n DESC LIMIT 12");
      const nodes = [{ id: "estado", label: "Estado", size: kinds.reduce((a, k) => a + k.n, 0), group: "estado", href: "#/entidades" }], links = [];
      for (const k of kinds) {
        nodes.push({ id: "k:" + k.kind, label: k.kind, size: k.n, group: "tipo", href: "#/entidades?kind=" + enc(k.kind) });
        links.push({ s: "estado", t: "k:" + k.kind, v: k.n });
        for (const e of coreAll("SELECT id, name, buyer_value v FROM entities WHERE is_public = 1 AND kind = ? ORDER BY buyer_value DESC LIMIT 8", k.kind)) {
          nodes.push({ id: "e:" + e.id, label: String(e.name).slice(0, 40), size: Math.round(e.v || 1), group: k.kind, href: "#/entidade/" + e.id });
          links.push({ s: "k:" + k.kind, t: "e:" + e.id, v: Math.round(e.v || 1) });
        }
      }
      return network(nodes, links, today(), { unitLinks: "entidades (tipo) / EUR contratados (entidade)" });
    });
    D("reguladoresDecisoes", () => {
      const l = call("/api/reguladores/lista");
      return bars(l.bodies.filter((b) => b.n_decisions > 0).sort((a, b) => b.n_decisions - a.n_decisions).map((b) => ({ label: b.short, value: b.n_decisions, color: "#4c78a8", href: "#/reguladores/" + b.slug })), l.meta.updated, { unit: "decisões publicadas" });
    });
    D("reguladoresCoimas", () => {
      const l = call("/api/reguladores/lista");
      return bars(l.bodies.filter((b) => b.n_fines > 0).sort((a, b) => b.n_fines - a.n_fines).map((b) => ({ label: b.short, value: b.n_fines, color: "#d64545", href: "#/reguladores/" + b.slug })), l.meta.updated, { unit: "coimas e sanções" });
    });
    D("saudeConsultas", () => {
      const s = ok(call("/api/saude/series", { indicator: "0007424" }));
      const pts = s.rows.filter((r) => r.dim === "Total de consultas" && r.value != null).map((r) => ({ t: r.period, v: r.value }));
      return timeline(pts, pts[pts.length - 1].t, [], { label: s.name, unit: s.unit, href: "#/saude" });
    });
    D("segurancaCrimes", () => {
      const s = call("/api/seguranca/series", { indicador: "crime" });
      return bars(s.categorias.rows.sort((a, b) => b.value - a.value).slice(0, 10).map((r) => ({ label: r.dim, value: r.value, color: "#8a63d2", href: "#/seguranca" })), String(s.categorias.year), { unit: "crimes registados" });
    });
    D("educacaoDistritos", () => {
      const o = ok(call("/api/educacao/overview"));
      return tiles(o.districts.map((d) => ({ label: d.district, value: d.students, href: "#/educacao", group: "distrito" })), o.counts.students_year, { unit: "alunos" });
    });
  };

  builders["leis-justica"] = (D) => {
    for (const [name, kind] of [["dreLeis", "Lei"], ["dreDecretosLei", "Decreto-Lei"], ["drePortarias", "Portaria"], ["dreResolucoes", "Resolução do Conselho de Ministros"]]) {
      D(name, () => {
        const rows = Q("dre", "SELECT substr(date,1,7) m, COUNT(*) n FROM acts WHERE kind = ? AND date >= '2024-01-01' GROUP BY m ORDER BY m", kind);
        return timeline(rows.map((r) => ({ t: r.m, v: r.n })), Q1("dre", "SELECT MAX(date) d FROM acts").d, [], { label: kind + " publicados por mês", href: "#/dre" });
      });
    }
    D("funil", billSankey);
    D("vetos", () => {
      const v = ok(call("/api/presidencia/vetos"));
      return { type: "counters", asof: v.rows[0]?.data, items: [counter(v.total, "Vetos do Presidente (desde 2022)", "vetos", null, v.rows[0]?.data, { href: "#/atos-presidente" }),
        ...Object.entries(v.desfechos).map(([k, n]) => counter(n, "Desfecho: " + k, "vetos", null, v.rows[0]?.data))] };
    });
    D("tcAno", () => {
      const o = ok(call("/api/justica/overview"));
      return bars(o.tcByYear.slice(-20).map((r) => ({ label: String(r.year), value: r.n, color: "#4c78a8", href: "#/justica" })), o.built.slice(0, 10), { unit: "acórdãos do Tribunal Constitucional" });
    });
    D("justicaProcessos", () => {
      const o = ok(call("/api/justica/overview"));
      return bars(o.series.pendentes.slice(-12).map((r) => ({ label: r.period, value: r.value, color: "#e0a526", href: "#/justica" })), o.built.slice(0, 10), { unit: "processos pendentes nos tribunais judiciais" });
    });
    D("provedor", () => {
      const o = ok(call("/api/provedor/overview"));
      return bars(o.series.filter((s) => s.metric === "opened").slice(-14).map((s) => ({ label: String(s.year), value: s.value, color: "#59a14f", href: "#/provedor" })), o.built.slice(0, 10), { unit: "processos abertos" });
    });
    D("auditorias", () => {
      const a = ok(call("/api/justica/auditorias"));
      const g = ok(call("/api/igf/relatorios", { limit: 10 }));
      const rows = [
        ...a.rows.slice(0, 8).map((r) => ({ title: (r.numero || r.titulo_ref) + (r.descricao ? " — " + r.descricao : ""), sub: "Tribunal de Contas · " + (r.tipo || r.grupo || ""), tag: r.data || String(r.year), href: r.entity_id ? "#/entidade/" + r.entity_id : "#/justica", d: r.data || r.year + "" })),
        ...g.rows.slice(0, 6).map((r) => ({ title: String(r.title).slice(0, 140), sub: "IGF · " + (r.ename || r.kind), tag: String(r.year), href: "#/igf", d: String(r.year) })),
      ].sort((x, y) => String(y.d).localeCompare(String(x.d))).map(({ d, ...x }) => x);
      return list(rows, a.rows[0]?.data);
    });
  };

  builders.indicadores = (D) => {
    D("ine", () => {
      const o = ok(call("/api/ine_series/overview"));
      return counter(o.indicadores.length, "Indicadores INE por município", "indicadores", null, o.built.slice(0, 10), { municipios: o.municipios, href: "#/indicadores" });
    });
    D("ranking", () => {
      const r = ok(call("/api/ine_series/ranking"));
      const rows = r.rows.filter((x) => x.v.poder_compra != null && x.v.envelhecimento != null);
      const pts = rows.sort((a, b) => (b.v.pop || 0) - (a.v.pop || 0)).slice(0, 110).map((x) => ({ x: x.v.poder_compra, y: x.v.envelhecimento, label: x.name, color: "#4c78a8", href: "#/entidade/" + x.eid }));
      return scatter(pts, "Poder de compra (PT = 100)", "Índice de envelhecimento", { x: r.nacional.poder_compra.median, y: r.nacional.envelhecimento.median }, r.built?.slice(0, 10) || ok(call("/api/ine_series/overview")).built.slice(0, 10), { n: rows.length, shown: pts.length });
    });
    D("habitacao", () => {
      const r = ok(call("/api/habitacao/ranking", { limit: 100 }));
      return tiles(r.rows.map((x) => ({ label: x.name, value: x.value, href: "#/entidade/" + x.eid, group: x.district })), r.periodo, { unit: r.unit, indicator: r.label });
    });
    D("imigracao", () => {
      const r = ok(call("/api/imigracao/municipios"));
      return bars(r.municipios.slice().sort((a, b) => b.total - a.total).slice(0, 15).map((m) => ({ label: m.name, value: m.total, color: "#e8537a", href: "#/entidade/" + m.eid })), String(r.year), { unit: "residentes estrangeiros" });
    });
    D("dgeec", () => {
      const d = ok(call("/api/dgeec/indicator", { id: "1.1" }));
      const by = {};
      for (const x of d.rows) if (x.grp === "Total" || x.grp == null) by[x.year] = (by[x.year] || 0) + x.value;
      const pts = Object.entries(by).sort().map(([t, v]) => ({ t, v }));
      return timeline(pts, pts[pts.length - 1]?.t, [], { label: d.title, href: "#/dgeec" });
    });
  };

  const concelhoIndicadores = (name) => {
    const m = findMuni(name);
    if (!m) return { found: false, error: "Município não encontrado" };
    const hab = (ind) => { const r = call("/api/habitacao/ranking", { indicador: ind, limit: 400 }); const x = r.rows?.find((y) => y.dico === m.dico); return x ? { indicator: r.label, unit: r.unit, period: r.periodo, value: x.value, rank: x.rank, of: r.n } : null; };
    const im = call("/api/imigracao/municipios").municipios.find((x) => x.dico === m.dico);
    const ed = call("/api/dgeec/municipios").rows?.find((x) => x.dico === m.dico);
    return { found: true, asof: today(), municipio: { name: m.name, dico: m.dico, district: m.district, population: m.population, href: "#/entidade/" + m.entity_id },
      indicadores: inePanel(m), habitacao: { venda: hab("venda_m2"), renda: hab("renda_m2") },
      imigracao: im ? { total: im.total, per100: r1(im.per100, 1), year: call("/api/imigracao/municipios").year } : null,
      educacao: ed ? { students: ed.students, schools: ed.schools, per1000: ed.per1000, year: "2018/2019" } : null };
  };

  const cache = new Map();
  const build = (slug) => {
    const D = (name, fn) => {
      try { const v = fn(); if (v) out.datasets[name] = v; else out.skipped.push(name); }
      catch (e) { out.skipped.push(name); out.errors[name] = String(e.message || e).slice(0, 120); }
    };
    const out = { slug, question: QUESTIONS[slug], built: new Date().toISOString(), datasets: {}, skipped: [], errors: {}, fontes: fontes[slug].map(([label, href]) => ({ label, href })) };
    builders[slug](D);
    if (!Object.keys(out.errors).length) delete out.errors;
    return out;
  };
  const QUESTIONS = {
    parlamento: "Quem decidiu esta semana, e cada partido votou como falou?", governo: "Quem governa, quem nomeia, o que decidiu?",
    dinheiro: "Quem decidiu gastar, em quê, e quem fiscalizou?", "poder-local": "Quem governa o seu concelho e o que dizem as auditorias?",
    instituicoes: "Quem regula, quem serve, com que resultados?", "leis-justica": "Como uma decisão se torna lei, e quem a contesta?",
    indicadores: "Como está o país que estas decisões mudam?",
  };
  const cached = (key, fn) => {
    if (cache.size >= 64 && !cache.has(key)) cache.delete(cache.keys().next().value);
    const hit = cache.get(key);
    if (hit) {
      if (Date.now() - hit.at > TTL && !hit.busy) { hit.busy = true; setTimeout(() => { try { cache.set(key, { at: Date.now(), v: fn() }); } catch { hit.busy = false; } }, 0); }
      return hit.v;
    }
    const v = fn();
    cache.set(key, { at: Date.now(), v });
    return v;
  };

  for (const slug of Object.keys(builders)) {
    const handler = (q) => {
      const c = q.get("concelho");
      if (c && slug === "poder-local") return cached("pl:" + norm(c), () => poderLocalConcelho(c));
      if (c && slug === "indicadores") return cached("ind:" + norm(c), () => concelhoIndicadores(c));
      if (q.get("index") && slug === "poder-local") return cached("pl:index", () => ({ asof: "2025-10-12", fields: ["name", "id", "party"], rows: indexMunis() }));
      return cached(slug, () => build(slug));
    };
    routes["/api/historias/" + slug] = (q) => {
      const v = handler(q);
      return v && v.datasets && !Object.keys(v.datasets).length ? unavailable("politica", "não foi encontrada ou está vazia") : v;
    };
  }
  routes["/api/historias"] = () => ({ slugs: Object.keys(builders), questions: QUESTIONS });

  setTimeout(() => {
    for (const slug of Object.keys(builders)) { try { cached(slug, () => build(slug)); } catch (e) { console.error("historias warm failed:", slug, e.message); } }
  }, 4000).unref();
}
