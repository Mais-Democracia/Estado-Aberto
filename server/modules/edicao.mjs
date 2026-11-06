import fs from "node:fs";
import path from "node:path";

export default function (ctx) {
  const { routes, all, one, openData, unavailable, dataDir } = ctx;
  const vot = openData("votacoes"), jus = openData("justica"), pres = openData("presidencia"), dre = openData("dre"), apo = openData("apoios"), resp = openData("responsaveis"), reg = openData("reguladores"), prov = openData("provedor"), igf = openData("igf"), pos = openData("posicoes"), ivn = openData("intervencoes"), dvd = openData("divida");
  const Q = (db, sql, ...p) => { try { return db ? db.prepare(sql).all(...p) : []; } catch { return []; } };
  const Q1 = (db, sql, ...p) => Q(db, sql, ...p)[0] || null;
  let pubIdx = null;
  const hasPub = () => (pubIdx ??= !!one("SELECT 1 x FROM sqlite_master WHERE type = 'index' AND name = 'contracts_published_cov'"));
  const bounded = (sql, p) => {
    if (!/FROM contracts/.test(sql) || !/published >= \?/.test(sql)) return sql;
    let ok = true;
    try { ok = hasPub(); } catch {}
    const a = p.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
    if (ok || !a) return sql;
    return sql.replace("WHERE ", `WHERE ${/FROM contracts c /.test(sql) ? "c." : ""}signed >= '${add(a, -90)}' AND `);
  };
  const P = (sql, ...p) => { try { return all(bounded(sql, p), ...p); } catch { return []; } };
  const P1 = (sql, ...p) => { try { return one(bounded(sql, p), ...p) || null; } catch { return null; } };

  const MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const DIA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const DT = (s) => new Date(s + "T00:00:00Z");
  const ST = (d) => d.toISOString().slice(0, 10);
  const add = (s, n) => { const d = DT(s); d.setUTCDate(d.getUTCDate() + n); return ST(d); };
  const yearAgo = (s) => { const d = DT(s), m = d.getUTCMonth(); d.setUTCFullYear(d.getUTCFullYear() - 1); if (d.getUTCMonth() !== m) d.setUTCDate(0); return ST(d); };
  const todayStr = () => process.env.ESTADO_ABERTO_TODAY || new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
  const pdate = (s) => { const d = DT(s.slice(0, 10)); return `${d.getUTCDate()} de ${MES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`; };
  const pshort = (s) => { const d = DT(s.slice(0, 10)); return `${d.getUTCDate()} de ${MES[d.getUTCMonth()]}`; };
  const range = (a, b) => {
    const x = DT(a), y = DT(b);
    if (a === b) return pdate(a);
    if (x.getUTCFullYear() !== y.getUTCFullYear()) return `${pdate(a)} a ${pdate(b)}`;
    if (x.getUTCMonth() !== y.getUTCMonth()) return `${pshort(a)} a ${pdate(b)}`;
    return `${x.getUTCDate()} a ${pdate(b)}`;
  };
  const nf = (v, d = 0) => Number(v).toLocaleString("pt-PT", { maximumFractionDigits: d });
  const eur = (v) => {
    v = Number(v);
    if (v >= 1e9) { const x = Math.round(v / 1e7) / 100; return x === 1 ? "1 mil milhões de euros" : `${nf(x, 2)} mil milhões de euros`; }
    if (v >= 1e6) { const x = Math.round(v / 1e4) / 100; return x === 1 ? "1 milhão de euros" : `${nf(x, 2)} milhões de euros`; }
    return `${nf(Math.round(v * 100) / 100, 2)} euros`;
  };
  const eurS = (v) => {
    v = Number(v);
    if (v >= 1e9) return `${nf(v / 1e9, 2)} mM€`;
    if (v >= 1e6) return `${nf(v / 1e6, 2)} M€`;
    if (v >= 1e3) return `${nf(v / 1e3, 0)} mil €`;
    return `${nf(v, 0)} €`;
  };
  const pc = (a, b, d = 0) => (b ? `${nf((100 * a) / b, d)}%` : "—");
  const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const t = s.slice(0, n); return t.slice(0, t.lastIndexOf(" ") > n * 0.6 ? t.lastIndexOf(" ") : n).replace(/[\s,;:–-]+$/, "") + "…"; };
  const lowerFirst = (s) => (/^[A-ZÀ-Ý][a-zà-ÿ]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
  const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const deshout = (s) => { const L = s.replace(/[^A-Za-zÀ-ÿ]/g, ""); const U = s.replace(/[^A-ZÀ-Ý]/g, ""); return L.length > 12 && U.length / L.length > 0.6 ? upperFirst(s.toLowerCase()) : s; };
  const objShort = (o, n = 96) => {
    let s = String(o || "").replace(/\s+/g, " ").trim().replace(/[\s\-–:;.,]+$/, "");
    s = s.replace(/^O objeto d(?:o|este)\s+(?:presente\s+)?\w+\s+(?:compreende|consiste\s+(?:em|na|no)|é)\s+(?:a\s+|o\s+)?/i, (m) => "");
    for (let i = 0; i < 2; i++) s = s.replace(/^(?:[A-Z]{1,4}\.?\s?)?\d+[\/\-.\d]*\s*[-–:]\s*/, "");
    const m = s.search(/ [-–] |;/);
    if (m >= 20) s = s.slice(0, m);
    return cut(deshout(s), n);
  };
  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const pick = (id, arr) => arr[hash(id) % arr.length];
  const list = (a) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} e ${a[a.length - 1]}`);
  const plural = (n, s, p) => (n === 1 ? s : p);
  const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const days = (a, b) => Math.round((DT(b) - DT(a)) / 864e5);

  const pk = (c) => String(c).replace(/[.\s]/g, "").replace("–", "-").toUpperCase();
  const SEATS = {};
  for (const p of P("SELECT code, seats FROM parties")) SEATS[pk(p.code)] = p.seats;
  const seatsOf = (csv) => (csv ? csv.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const seatSum = (arr) => arr.reduce((a, c) => a + (SEATS[pk(c)] || 0), 0);
  const partyName = (c) => (c === "B.E." ? "BE" : c);

  const maxes = () => {
    const t = todayStr();
    return {
      pub: P1("SELECT MAX(published) d FROM contracts WHERE published <= ?", t)?.d,
      vote: Q1(vot, "SELECT MAX(data) d FROM votos WHERE orgao = 'Plenário' AND data <= ?", t)?.d,
      tc: Q1(jus, "SELECT MAX(publicado) d FROM tcontas_docs WHERE publicado <= ?", t)?.d,
      pres: Q1(pres, "SELECT MAX(data) d FROM atos WHERE data <= ?", t)?.d,
      dre: Q1(dre, "SELECT MAX(date) d FROM acts WHERE date <= ?", t)?.d,
      reg: Q1(reg, "SELECT MAX(date) d FROM decisions WHERE date <= ?", t)?.d,
      nom: Q1(resp, "SELECT MAX(date) d FROM nomeacoes WHERE date <= ?", t)?.d,
      iv: Q1(ivn, "SELECT MAX(data) d FROM intervencoes WHERE data <= ?", t)?.d,
    };
  };
  let mxAt = 0, mxVal = null;
  const MX = () => { if (!mxVal || Date.now() - mxAt > 600000) { mxVal = maxes(); mxAt = Date.now(); } return mxVal; };
  const defaultDate = () => { const m = MX(); return [m.pub, m.vote, m.tc, m.pres, m.dre, m.reg, m.nom].filter(Boolean).sort().pop(); };
  const MIN_DATE = process.env.ESTADO_ABERTO_DIARIO_FLOOR || "2026-11-06";
  const clampDate = (s) => {
    const t = todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "") || isNaN(DT(s))) return t;
    return s > t ? t : s;
  };
  const refOf = (d, mx) => (mx && mx < d ? mx : d);

  const cstats = (a, b) => P1(`SELECT COUNT(*) n, SUM(CASE WHEN price > 0 THEN price END) v, SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' AND price > 0 THEN price END) dv FROM contracts WHERE published >= ? AND published <= ?`, a, b) || { n: 0, v: 0, dv: 0 };
  const delta = (a, b) => (b ? Math.round((1000 * (a - b)) / b) / 10 : null);
  const eidOf = (nif) => (nif ? P1("SELECT id FROM entities WHERE nif = ?", nif)?.id ?? null : null);

  const contractLink = (c) => `contrato/${c.id}`;
  const contractHed = (c) => {
    const b = cleanName(c.buyer_name), sl = cleanName(c.seller_name), v = eur(c.price), direct = /^Ajuste Direto/.test(c.procedure || "");
    const t = [
      () => `${b} contrata ${sl} por ${v}`,
      () => (direct ? `Ajuste direto: ${b} paga ${v} a ${sl}` : `${sl} ganha contrato de ${v} com ${b}`),
      () => `${upperFirst(v)} em dinheiro público: ${b} escolhe ${sl}`,
    ];
    return pick(c.id, t)();
  };
  const contractStory = (c, w, rank, section, extra = {}) => {
    const b = cleanName(c.buyer_name), s = cleanName(c.seller_name);
    const ys = P1("SELECT n, value FROM year_stats WHERE nif = ? AND year = ?", c.buyer_nif, c.year);
    const lead = [];
    lead.push(`${b} celebrou a ${pshort(c.signed)} um contrato com ${s}${c.n_sellers > 1 ? ` e mais ${c.n_sellers - 1} ${plural(c.n_sellers - 1, "fornecedor", "fornecedores")}` : ""} no valor de ${eur(c.price)}, ${rank === 1 ? "o mais elevado" : `o ${rank}.º mais elevado`} dos ${nf(w.n)} contratos publicados no Portal BASE entre ${range(w.a, w.b)}.`);
    lead.push(`Objeto: «${objShort(c.object, 140)}». Procedimento: ${String(c.procedure || "não indicado").toLowerCase()}${c.n_bidders > 0 ? `, com ${c.n_bidders} ${plural(c.n_bidders, "concorrente", "concorrentes")}` : ""}.`);
    if (w.v && c.price / w.v >= 0.002) lead.push(`Este contrato pesa ${pc(c.price, w.v, 1)} do valor total publicado no período (${eur(w.v)}).`);
    else if (ys) lead.push(`Em ${c.year}, a entidade registou ${nf(ys.n)} contratos, no valor acumulado de ${eur(ys.value)}.`);
    return { id: `contrato-${c.id}`, section, kicker: extra.kicker || "Contratação pública", hed: contractHed(c, rank), dek: upperFirst(objShort(c.object, 150)), lead, ref: contractLink(c), date: c.published, ...extra };
  };

  const voteRows = (a, b, lim = 80) => {
    const rows = Q(vot, `SELECT v.id, v.bid, v.data, v.fase, v.resultado, v.unanime, v.favor, v.contra, v.abstencao, i.tipo, i.numero, i.leg, i.titulo, i.autoria, i.data_entrada
      FROM votos v LEFT JOIN iniciativas i ON i.bid = v.bid WHERE v.orgao = 'Plenário' AND v.fase LIKE 'Votação%' AND v.data >= ? AND v.data <= ? AND v.favor IS NOT NULL ORDER BY v.data DESC, v.id DESC LIMIT ${lim}`, a, b);
    return rows.map((r) => {
      const F = seatsOf(r.favor), C = seatsOf(r.contra), A = seatsOf(r.abstencao);
      return { ...r, F, C, A, fs: seatSum(F), cs: seatSum(C), as: seatSum(A), margin: Math.abs(seatSum(F) - seatSum(C)) };
    });
  };
  const VERBS = /^(Altera|Recomenda|Revoga|Aprova|Estabelece|Procede|Cria|Determina|Institui|Regula|Define|Reforça|Garante|Promove|Adota|Assegura|Concede|Reconhece|Prevê|Autoriza|Alarga|Isenta|Transpõe|Regulamenta|Fixa|Proíbe|Impõe|Suspende|Elimina|Reduz|Aumenta|Prorroga|Cessa|Declara|Atribui|Consagra|Introduz|Adequa|Aplica|Reforma|Reabre|Extingue|Delimita|Densifica|Lança|Repõe|Torna|Salvaguarda|Exige|Impede|Cria|Reforça|Combate|Solicita|Propõe|Apela|Insta|Condena|Saúda|Manifesta|Regista|Reitera|Exorta|Visa|Permite|Habilita|Simplifica|Clarifica|Reverte|Mantém|Passa|Obriga|Veda|Dispensa)\b/;
  const approved = (r) => /^Aprovado/i.test(r.resultado || "");
  const voteTitle = (r) => cut(cleanName(r.titulo) || `${r.tipo || "Iniciativa"} n.º ${r.numero}/${r.leg}`, 118);
  const voteStory = (r, section, extra = {}) => {
    const ok = approved(r), ref = `${r.tipo || "Iniciativa"} n.º ${r.numero}/${r.leg}`;
    const fem = /^(Proposta|Petição|Iniciativa|Apreciação|Resolução)/.test(r.tipo || "");
    const verb = ok ? "aprova" : pick(r.id, ["rejeita", "chumba"]);
    const t = cleanName(r.titulo), isVerb = VERBS.test(t), tipoL = String(r.tipo || "iniciativa").toLowerCase(), art = fem ? "a" : "o";
    const hed = t ? `Parlamento ${verb} ${art} ${tipoL}${isVerb ? " que " + lowerFirst(cut(t, 150)) : " «" + cut(t, 150) + "»"}` : `Parlamento ${verb} ${art} ${tipoL} n.º ${r.numero}/${r.leg}`;
    const marginTxt = r.cs > 0 ? `${ok ? "Aprovad" : "Rejeitad"}${fem ? "a" : "o"} com ${r.margin} ${plural(r.margin, "lugar", "lugares")} de diferença entre os grupos a favor e contra` : null;
    const lead = [];
    lead.push(`No plenário de ${pdate(r.data)}, a ${String(r.fase || "votação").toLowerCase().replace(/^votação/, "votação")} do ${ref}${r.autoria ? `, da autoria de ${r.autoria}` : ""}, terminou com o resultado «${r.resultado}».`);
    const parts = [];
    if (r.F.length) parts.push(`a favor ${list(r.F.map(partyName))} (${r.fs} lugares)`);
    if (r.C.length) parts.push(`contra ${list(r.C.map(partyName))} (${r.cs} lugares)`);
    if (r.A.length) parts.push(`abstenção de ${list(r.A.map(partyName))} (${r.as} lugares)`);
    lead.push(`Votaram ${list(parts)}.`);
    lead.push(r.cs > 0 ? `A diferença entre os lugares dos grupos a favor e contra foi de ${r.margin}; o cálculo soma os lugares de cada grupo parlamentar e ignora votos divididos e ausências.` : `Nenhum grupo parlamentar votou contra.`);
    return { id: `voto-${r.id}`, section, kicker: "Votação em plenário", hed, dek: marginTxt || (r.titulo ? cut(cleanName(r.titulo), 190) : ref), lead, ref: `voto/${r.id}`, date: r.data, ...extra };
  };

  const tcRows = (a, b, extra = "") => Q(jus, `SELECT id, categoria, grupo, year, numero, data, publicado, descricao, tipo, resultado, entity_name, pdf_url FROM tcontas_docs WHERE publicado >= ? AND publicado <= ? ${extra} ORDER BY publicado DESC, data DESC LIMIT 60`, a, b);
  const tcNum = (n) => String(n || "").replace(/\s+de\s+\d{4}-\d{2}-\d{2}.*/, "").trim();
  const tcStory = (r, section, w, extra = {}) => {
    const lead = [];
    const what = r.categoria === "acordao" ? (/^Acórdão/i.test(tcNum(r.numero)) ? "" : "o acórdão") : (/^Relatório/i.test(tcNum(r.numero)) ? "" : "o relatório");
    lead.push(`O Tribunal de Contas publicou a ${pdate(r.publicado)} ${what ? what + " " : "o "}${tcNum(r.numero)}${r.data ? `, de ${pdate(r.data)}` : ""}${r.grupo ? ` (${r.grupo.toLowerCase()})` : ""}.`);
    if (r.descricao) lead.push(`Assunto: ${cut(cleanName(r.descricao), 260)}${/[.…]$/.test(cut(cleanName(r.descricao), 260)) ? "" : "."}`);
    if (w) lead.push(`Foi um de ${w.n} ${plural(w.n, "documento publicado", "documentos publicados")} pelo Tribunal de Contas entre ${range(w.a, w.b)}, dos quais ${w.aud} ${plural(w.aud, "auditoria", "auditorias")}.`);
    const hedBase = cut(cleanName(r.descricao) || tcNum(r.numero), 110);
    const hed = r.categoria === "acordao" ? `Tribunal de Contas decide: ${hedBase}` : r.grupo === "Auditoria" ? `Auditoria do Tribunal de Contas: ${hedBase}` : `Tribunal de Contas publica: ${hedBase}`;
    return { id: `tc-${r.id}`, section, kicker: r.categoria === "acordao" ? "Tribunal de Contas" : "Relatório de auditoria", hed, dek: r.entity_name ? `Entidade: ${r.entity_name}` : cleanName(r.descricao).length > 110 ? cut(cleanName(r.descricao), 240) : `${tcNum(r.numero)}${r.grupo ? ` · ${r.grupo}` : ""}`, lead, ref: `relatorio/${encodeURIComponent(r.id)}`, date: r.publicado, ...extra };
  };

  const atoRows = (tipos, a, b, lim = 30) => Q(pres, `SELECT id, data, tipo, titulo, texto, dre_act_id, mensagem_url, source_url FROM atos WHERE tipo IN (${tipos.map(() => "?").join(",")}) AND data >= ? AND data <= ? ORDER BY data DESC LIMIT ${lim}`, ...tipos, a, b);
  const atoBody = (t) => String(t || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(2);
  const promHed = (r) => {
    const t = atoBody(r.texto)[0] || "";
    const m = t.match(/promulgou (?:como ([^ ]+(?: [^ ]+)?) )?(?:o|a) (?:diploma|decreto)[^ ]* (do Governo|da Assembleia da República),? (que .+?)\.?$/);
    if (m) return cut(`Presidente promulga ${m[1] ? m[1].toLowerCase() : "diploma"} ${m[2]} ${m[3]}`, 230);
    const item = atoBody(r.texto).find((x) => /^-\s*/.test(x));
    if (item) { const it = item.replace(/^-\s*(?:Diploma\s+)?/, "").replace(/[;.]$/, ""); const h = r.titulo.replace(/\.$/, "").replace(/^Presidente da República/, "Presidente"); return cut(/^que /.test(it) ? `${h}, incluindo o diploma ${it}` : `${h}: ${it}`, 230); }
    return r.titulo.replace(/\.$/, "").replace(/^Presidente da República/, "Presidente");
  };
  const atoStory = (r, section, extra = {}) => {
    const body = atoBody(r.texto), first = body.join(" ");
    const sent = (first.match(/[^.!?:]+[.!?:]/g) || [first]).slice(0, 2).join(" ");
    const nom = r.tipo === "nomeacao", prom = r.tipo === "promulgacao", dia = r.tipo === "presidencia_dia";
    const hed = nom ? cut(r.titulo.replace(/\.$/, "").replace(/^Nomeia\s+/, "Presidente da República nomeia "), 190) : prom ? promHed(r) : cut(r.titulo.replace(/\.$/, ""), 190);
    return { id: `ato-${r.id}`, section, kicker: nom ? "Nomeação" : r.tipo === "veto" ? "Veto" : prom ? "Promulgação" : dia ? "Presidência: atos do dia" : "Presidência", hed, dek: null, lead: [nom ? `Decreto publicado a ${pdate(r.data)}: ${cut(r.titulo, 300)}` : `Em ${pdate(r.data)}: ${cut(sent || r.titulo, 360)}`], ref: `ato/${encodeURIComponent(r.id)}`, date: r.data, ...extra };
  };

  const dreCount = (a, b) => Q(dre, "SELECT kind, COUNT(*) n FROM acts WHERE date >= ? AND date <= ? GROUP BY kind ORDER BY n DESC", a, b);
  const sum = (arr, k = "n") => arr.reduce((x, y) => x + (y[k] || 0), 0);

  const dayRange = (a, b) => { const out = []; for (let d = a; d <= b; d = add(d, 1)) out.push(d); return out; };
  const series = (rows, a, b, key = "n") => { const m = new Map(rows.map((r) => [r.d, r[key] || 0])); return dayRange(a, b).map((d) => ({ d, v: m.get(d) || 0 })); };

  const cache = new Map();
  const ledgerStamp = () => {
    const f = path.join(dataDir, "diario.db");
    try { return [f, f + "-wal"].map((x) => { try { const s = fs.statSync(x); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } }).join("|"); } catch { return ""; }
  };
  const edition = (d) => {
    const hit = cache.get(d), stamp = ledgerStamp();
    if (hit && hit.stamp === stamp && Date.now() - hit.at < 600000) return hit.v;
    const v = buildEdition(d);
    cache.set(d, { at: v.partial ? Date.now() - 540000 : Date.now(), stamp, v });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return v;
  };

  const pct0 = (x) => Math.round(x * 100) / 100;
  const decay = (from, D, k = 0.97) => Math.pow(k, Math.max(0, days(from, D)));
  const isLaw = (t) => /(Proposta|Projeto) de Lei|Revisão/.test(t || "");
  const voteScore = (r) => {
    const fin = /final|global/i.test(r.fase), law = isLaw(r.tipo), ctl = /Inquérito|Apreciação|Regimento/.test(r.tipo || "");
    const base = law ? (fin ? 0.66 : 0.5) + (/^Proposta/.test(r.tipo || "") ? 0.04 : 0) : ctl ? 0.5 : /Resolução|Voto/.test(r.tipo || "") ? 0.34 : 0.4;
    return Math.min(0.95, base + (!approved(r) && !r.unanime ? 0.08 : 0) + 0.2 * Math.pow(clamp(1 - r.margin / 60), 1.5));
  };
  const voteWhy = (r) => `${r.tipo || "iniciativa"} ${approved(r) ? "aprovad" : "rejeitad"}${/^(Proposta|Petição|Apreciação|Resolução)/.test(r.tipo || "") ? "a" : "o"} a ${pshort(r.data)} com ${r.margin} lugares de diferença`;
  const notable = (t) => /Governador|Presidente|Procurador|Juiz|Chefe|Almirante|General|Provedor|Conselheiro|Tribunal|Banco de Portugal/.test(t);

  const provStory = (r, section, extra = {}) => ({
    id: `prov-${r.year}`, section, kicker: "Provedor de Justiça", hed: `Provedor de Justiça entrega à Assembleia o relatório de ${r.year}`, dek: cut(cleanName(r.title), 180),
    lead: [`O relatório anual do Provedor de Justiça referente a ${r.year} foi publicado a ${pdate(r.published)}${r.pages ? `, em ${nf(r.pages)} páginas` : ""}.`, `Reúne as queixas recebidas, as áreas e as entidades mais visadas e as recomendações dirigidas à Administração.`],
    ref: "provedor", date: r.published, ...extra,
  });
  const regStory = (r, section, extra = {}) => {
    const body = Q1(reg, "SELECT short, name FROM bodies WHERE slug = ?", r.body) || { short: r.body.toUpperCase(), name: r.body.toUpperCase() };
    const kind = { sancao: "Coima aplicada", contraordenacao: "Contraordenação", deliberacao: "Deliberação", concentracao_oposicao: "Oposição a concentração", decisao_condicionada: "Decisão condicionada", concentracao_notificada: "Concentração notificada", concentracao_nao_oposicao: "Concentração autorizada" }[r.kind] || "Decisão";
    return {
      id: `reg-${r.id}`, section, kicker: `${body.short} · ${kind}`, hed: `${body.short} ${r.kind === "sancao" ? "sanciona" : "decide"}: ${cut(cleanName(r.title), 165)}`, dek: r.amount ? `Montante indicado: ${eur(r.amount)}` : cleanName(body.name),
      lead: [`${cleanName(body.name)} registou a ${pdate(r.date)} a decisão ${cleanName(r.ref || "")}${r.amount ? `, com montante de ${eur(r.amount)}` : ""}.`, cut(cleanName(r.subject) || cleanName(r.title), 320)].filter(Boolean),
      ref: `regulador/${encodeURIComponent(r.id)}`, date: r.date, ...extra,
    };
  };
  const decStory = (r, section, extra = {}) => {
    const ini = r.titulo ? cut(cleanName(r.titulo), 130) : r.ref;
    return {
      id: `decl-${r.id}`, section, kicker: "Posições dos partidos", hed: `${r.partido} declarou voto ${r.declarado} e votou ${r.voto}: ${ini}`, dek: `${r.orador}, em ${pdate(r.data_discurso)}`,
      lead: [`No plenário de ${pdate(r.data_discurso)}, ${r.orador} (${r.partido}) declarou que o voto seria «${r.declarado}» na iniciativa ${r.ref}. Na ${String(r.fase || "votação").toLowerCase()} de ${pdate(r.data_voto)}, o sentido de voto registado foi «${r.voto}».`, `Citação do discurso: «${cut(cleanName(r.citacao).replace(/^…\s*/, ""), 260)}»`],
      ref: `declaracao/${r.id}`, date: r.data_voto, ...extra,
    };
  };
  const nomStory = (r, section, extra = {}) => {
    const verb = /exonera/i.test(r.action) ? "exonerado" : /cess/i.test(r.action) ? "cessa funções" : "nomeado";
    const role = cleanName(r.role) || "cargo não indicado";
    return {
      id: `nom-${r.id}`, section, kicker: r.source === "cresap" ? "CReSAP" : "Nomeação publicada", hed: verb === "cessa funções" ? `${cleanName(r.person)} cessa funções: ${role}` : `${cleanName(r.person)} ${verb}: ${cut(role, 150)}`, dek: r.entity ? cleanName(r.entity) : null,
      lead: [`Ato publicado a ${pdate(r.date)}${r.act ? ` (${cleanName(r.act)})` : ""}: ${cleanName(r.person)}, ${role.charAt(0).toLowerCase() + role.slice(1)}${r.entity ? `, em ${cleanName(r.entity)}` : ""}.`],
      ref: `nomeacao/${r.id}`, date: r.date, ...extra,
    };
  };
  const igfStory = (r, section, n, extra = {}) => ({
    id: `igf-${r.code}`, section, kicker: "Inspeção-Geral de Finanças", hed: `IGF: ${cut(cleanName(r.title), 180)}`, dek: r.entity_name ? `Entidade: ${r.entity_name}` : null,
    lead: [`A Inspeção-Geral de Finanças tem listado o relatório n.º ${r.num}/${r.year}${r.entity_name ? ` sobre ${r.entity_name}` : ""}. A lista oficial não indica a data de publicação; o relatório mais recente por ano e número é este.`, `Em ${r.year} a lista contém ${nf(n)} ${plural(n, "relatório", "relatórios")}.`],
    ref: "igf", when: `Relatório de ${r.year}`, date: null, ...extra,
  });
  const decCount = (a, b) => Q1(reg, "SELECT COUNT(*) n FROM decisions WHERE date >= ? AND date <= ?", a, b)?.n || 0;

  const BUDGET = Number(process.env.ESTADO_ABERTO_EDITION_BUDGET_MS) || 45000;

  function buildEdition(D) {
    const t0 = Date.now();
    let partial = false;
    const late = () => { if (Date.now() - t0 > BUDGET) { partial = true; return true; } return false; };
    const mx = MX();
    const rc = refOf(D, mx.pub), rv = refOf(D, mx.vote), rt = refOf(D, mx.tc), rp = refOf(D, mx.pres), rd = refOf(D, mx.dre), rr = refOf(D, mx.reg), rn = refOf(D, mx.nom), ri = refOf(D, mx.iv);
    const wc = { a: add(rc, -6), b: rc }, wcp = { a: add(rc, -13), b: add(rc, -7) };
    const cs = cstats(wc.a, wc.b), csp = cstats(wcp.a, wcp.b);
    const w = { ...wc, n: cs.n, v: cs.v };
    const topC = P(`SELECT * FROM contracts WHERE published >= ? AND published <= ? AND price > 0 ORDER BY price DESC LIMIT 14`, wc.a, wc.b);
    const seenB = new Set(), topUniq = [];
    for (const c of topC) { const key = c.buyer_nif + "|" + objShort(c.object, 40); if (seenB.has(key)) continue; seenB.add(key); topUniq.push(c); }

    const votes = voteRows(add(rv, -29), rv, 160).filter((r) => !/Delibera/i.test(r.fase));
    const votable = votes.filter((r) => r.fs + r.cs > 0);
    const byScore = [...votable].sort((x, y) => voteScore(y) * decay(y.data, D) - voteScore(x) * decay(x.data, D));
    const bestV = byScore[0];
    const tcw = tcRows(add(rt, -13), rt, "AND categoria = 'relatorio'");
    const tcAll = tcRows(add(rt, -13), rt);
    const tcStat = { a: add(rt, -13), b: rt, n: tcAll.length, aud: tcAll.filter((r) => r.grupo === "Auditoria").length };
    const aud = tcw.filter((r) => r.grupo === "Auditoria");
    const tcLead = aud[0] || tcw[0];
    const acord = tcAll.find((r) => r.categoria === "acordao");
    const noms = atoRows(["nomeacao"], add(rp, -30), rp, 40);
    const nomLead = noms.find((n) => notable(n.titulo));
    const prom = atoRows(["promulgacao"], add(rp, -13), rp, 12);
    const promAR = prom.find((r) => /Assembleia da República/.test(r.texto || ""));
    const vetoes = Q(pres, "SELECT id, data, origem, motivo, titulo, desfecho FROM vetos WHERE data <= ? AND data >= ? ORDER BY data DESC LIMIT 1", D, add(D, -90));
    const provR = Q1(prov, "SELECT year, title, published, pages FROM reports WHERE published <= ? AND published >= ? ORDER BY published DESC LIMIT 1", D, add(D, -120));
    const regR = Q1(reg, "SELECT * FROM decisions WHERE date <= ? AND date >= ? AND kind IN ('sancao','concentracao_oposicao','decisao_condicionada','contraordenacao') ORDER BY (kind = 'sancao') DESC, (kind = 'concentracao_oposicao') DESC, COALESCE(amount, 0) DESC, date DESC LIMIT 1", rr, add(rr, -45));
    const declR = Q1(pos, "SELECT * FROM decl WHERE coincide = 0 AND data_voto <= ? AND data_voto >= ? ORDER BY data_voto DESC LIMIT 1", D, add(D, -90));

    const cand = [];
    if (bestV) cand.push({ tipo: "votação", score: voteScore(bestV) * decay(bestV.data, D), why: voteWhy(bestV), story: () => voteStory(bestV, "Parlamento", { isLead: true }) });
    const vt = vetoes[0];
    const vetoStory = (v, extra = {}) => ({ id: `veto-${v.id}`, section: "Governo e Presidente", kicker: "Veto presidencial", hed: `Presidente veta: ${cut(cleanName(v.titulo), 170)}`, dek: null, lead: [`O Presidente da República vetou a ${pdate(v.data)} um diploma ${v.origem === "AR" ? "da Assembleia da República" : v.origem === "GOV" ? "do Governo" : "(" + v.origem + ")"}, por motivo ${v.motivo === "tc" ? "de inconstitucionalidade, após decisão do Tribunal Constitucional" : "político"}${v.desfecho ? `. Desfecho registado: ${v.desfecho}` : ""}.`], ref: `ato/${encodeURIComponent(v.id)}`, date: v.data, ...extra });
    if (vt) cand.push({ tipo: "veto", score: 0.8 * decay(vt.data, D), why: `veto presidencial a ${pshort(vt.data)}`, story: () => vetoStory(vt, { isLead: true }) });
    if (promAR) cand.push({ tipo: "promulgação", score: 0.6 * decay(promAR.data, D), why: `promulgação de diploma da Assembleia a ${pshort(promAR.data)}`, story: () => atoStory(promAR, "Governo e Presidente", { isLead: true }) });
    else if (prom[0]) cand.push({ tipo: "promulgação", score: 0.5 * decay(prom[0].data, D), why: `promulgação de diploma do Governo a ${pshort(prom[0].data)}`, story: () => atoStory(prom[0], "Governo e Presidente", { isLead: true }) });
    if (tcLead) cand.push({ tipo: "auditoria", score: (0.62 + 0.04 * Math.min(tcStat.aud, 5) / 5) * decay(tcLead.publicado, D), why: `relatório do Tribunal de Contas publicado a ${pshort(tcLead.publicado)}`, story: () => tcStory(tcLead, "Fiscalização", tcStat, { isLead: true }) });
    else if (acord) cand.push({ tipo: "acórdão", score: 0.5 * decay(acord.publicado, D), why: `acórdão do Tribunal de Contas publicado a ${pshort(acord.publicado)}`, story: () => tcStory(acord, "Fiscalização", tcStat, { isLead: true }) });
    if (provR) cand.push({ tipo: "relatório do Provedor", score: 0.55 * decay(provR.published, D, 0.985), why: `relatório anual do Provedor de Justiça de ${provR.year}`, story: () => provStory(provR, "Fiscalização", { isLead: true }) });
    if (regR) cand.push({ tipo: "regulador", score: (regR.kind === "sancao" ? 0.64 : regR.kind === "concentracao_oposicao" ? 0.58 : 0.45) * decay(regR.date, D), why: `decisão de regulador a ${pshort(regR.date)}`, story: () => regStory(regR, "Fiscalização", { isLead: true }) });
    if (nomLead) cand.push({ tipo: "nomeação", score: 0.5 * decay(nomLead.data, D), why: `nomeação de relevo publicada a ${pshort(nomLead.data)}`, story: () => atoStory(nomLead, "Nomeações", { isLead: true }) });
    if (declR) cand.push({ tipo: "voto declarado", score: 0.55 * decay(declR.data_voto, D), why: `partido votou diferente do que declarou, a ${pshort(declR.data_voto)}`, story: () => decStory(declR, "Parlamento", { isLead: true }) });
    if (topUniq[0]) {
      const c = topUniq[0];
      cand.push({ tipo: "contrato", score: (0.2 + 0.25 * clamp((Math.log10(c.price) - 6) / 2.5)) * decay(c.published, D, 0.985), why: `maior contrato publicado em ${range(wc.a, wc.b)}: ${eur(c.price)}`, story: () => contractStory(c, w, 1, "Dinheiro público", { isLead: true }) });
    }
    const yG = Math.min(Number(D.slice(0, 4)) - 1, 2025);
    const grant = Q1(apo, "SELECT * FROM apoios WHERE year = ? AND amount > 0 ORDER BY amount DESC LIMIT 1", yG);
    const grantStory = () => grant && {
      id: `apoio-${grant.id}`, section: "Dinheiro público", kicker: "Apoio público do ano",
      hed: `${cleanName(grant.nome)} recebe ${eur(grant.amount)} em apoios do Estado`,
      dek: cut(cleanName(grant.programa), 160),
      lead: [`Em ${yG}, o maior apoio individual registado nas bases de apoios do portal (cultura, desporto, juventude e ciência) foi de ${eur(grant.amount)}, atribuído a ${cleanName(grant.nome)} ao abrigo de «${cut(cleanName(grant.programa), 120)}», pelo organismo ${grant.orgao}.`],
      ref: `apoio/${grant.id}`, date: `${yG}-12-31`, when: `Ano de ${yG}`,
    };
    if (grant) cand.push({ tipo: "apoio", score: 0.3, why: `maior apoio individual de ${yG}: ${eur(grant.amount)}`, story: () => grantStory() });
    cand.sort((a, b) => b.score - a.score);
    const leadC = cand[0];
    const lead = leadC ? leadC.story() : null;
    const used = new Set(lead ? [lead.id] : []);
    const SEC = ["Parlamento", "Governo e Presidente", "Fiscalização", "Nomeações", "Poder local", "Dinheiro público"];
    const S = Object.fromEntries(SEC.map((k) => [k, []]));
    const push = (st, lim = 99) => { if (!st || used.has(st.id) || S[st.section].length >= lim) return; used.add(st.id); S[st.section].push(st); };

    const seenT = new Set();
    for (const r of byScore) { if (S.Parlamento.length >= 3) break; if (seenT.has(r.bid)) continue; seenT.add(r.bid); if (lead && lead.id === `voto-${r.id}`) continue; push(voteStory(r, "Parlamento")); }
    if (declR) push(decStory(declR, "Parlamento"), 4);
    else {
      const dc = Q1(pos, "SELECT COUNT(*) n, SUM(coincide = 1) ok FROM decl WHERE data_voto <= ?", D);
      if (dc && dc.n) push({ id: "posicoes", section: "Parlamento", kicker: "Posições dos partidos", hed: `${nf(dc.n)} declarações de voto confrontadas com o voto real: ${nf(dc.ok)} coincidem`, dek: null, lead: [`O portal compara o que os deputados declararam em plenário com o voto registado na votação seguinte. Das ${nf(dc.n)} declarações verificadas, ${nf(dc.ok)} coincidem com o voto real.`], ref: "posicoes", date: Q1(pos, "SELECT MAX(data_voto) d FROM decl WHERE data_voto <= ?", D)?.d || D }, 4);
    }
    const ivD = ri;
    const iv = ivD ? Q1(ivn, "SELECT COUNT(*) n, COUNT(DISTINCT partido) np, SUM(palavras) pal FROM intervencoes WHERE data = ?", ivD) : null;
    if (iv && iv.n) {
      const top = Q1(ivn, "SELECT i.bid, i.key, i.ref, COUNT(*) n FROM iv_ini i JOIN intervencoes v ON v.id = i.iv_id WHERE v.data = ? GROUP BY i.bid ORDER BY n DESC LIMIT 1", ivD);
      const ti = top ? Q1(vot, "SELECT titulo FROM iniciativas WHERE bid = ?", top.bid) : null;
      push({ id: `iv-${ivD}`, section: "Parlamento", kicker: "Intervenções no plenário", hed: `${nf(iv.n)} ${plural(iv.n, "intervenção", "intervenções")} no plenário de ${pshort(ivD)}${top ? `; a iniciativa mais debatida foi ${top.ref}` : ""}`, dek: ti?.titulo ? cut(cleanName(ti.titulo), 190) : null, lead: [`No plenário de ${pdate(ivD)} falaram deputados de ${nf(iv.np)} ${plural(iv.np, "partido", "partidos")}, num total de ${nf(iv.n)} ${plural(iv.n, "intervenção", "intervenções")} e ${nf(iv.pal)} palavras no Diário da Assembleia da República.${top ? ` A iniciativa com mais intervenções associadas foi ${top.ref} (${nf(top.n)}).` : ""}`], ref: top?.key ? `votacoes/${encodeURIComponent(top.key)}?tab=iv` : "votacoes", date: ivD }, 4);
    }
    const ev = P("SELECT COUNT(*) n, SUM(section = 'Plenário') p FROM events WHERE start > ? AND start <= ?", D + "T23:59:59", add(D, 7) + "T23:59:59")[0];
    if (ev && ev.n > 0 && S.Parlamento.length < 5) {
      const nxt = P("SELECT title, start FROM events WHERE start > ? AND section <> 'Visitas ao Palácio de S. Bento' ORDER BY start LIMIT 3", D + "T23:59:59");
      push({ id: "agenda", section: "Parlamento", kicker: "Agenda", hed: `${nf(ev.n)} ${plural(ev.n, "compromisso agendado", "compromissos agendados")} na Assembleia nos próximos 7 dias`, dek: null, lead: [`A agenda do Parlamento regista ${nf(ev.n)} ${plural(ev.n, "evento", "eventos")} entre ${range(add(D, 1), add(D, 7))}${ev.p ? `, ${nf(ev.p)} ${plural(ev.p, "deles sessão plenária", "deles sessões plenárias")}` : ""}.${nxt.length ? ` O primeiro é «${cut(cleanName(nxt[0].title).split("\n")[0], 110)}», a ${pdate(nxt[0].start)}.` : ""}`], ref: "calendario", date: D });
    }

    for (const v of vetoes) push(vetoStory(v));
    for (const r of prom.slice(0, 3)) { if (S["Governo e Presidente"].length >= 2) break; push(atoStory(r, "Governo e Presidente")); }
    const dc = dreCount(add(rd, -6), rd);
    const dn = sum(dc);
    if (dn) {
      const top = dc.slice(0, 4).map((k) => `${k.kind} (${nf(k.n)})`);
      push({ id: "dre", section: "Governo e Presidente", kicker: "Diário da República", hed: `${nf(dn)} ${plural(dn, "diploma publicado", "diplomas publicados")} no Diário da República em sete dias`, dek: null, lead: [`Entre ${range(add(rd, -6), rd)}, o Diário da República publicou ${nf(dn)} atos legislativos e normativos nas bases do portal. Os mais frequentes: ${list(top)}.`], ref: "dre", date: rd });
    }

    const tcOthers = tcAll.filter((r) => !lead || lead.id !== `tc-${r.id}`);
    for (const r of tcOthers.slice(0, 2)) push(tcStory(r, "Fiscalização", tcStat));
    const igfY = Q1(igf, "SELECT MAX(year) y FROM reports")?.y;
    const igfR = igfY ? Q1(igf, "SELECT * FROM reports WHERE year = ? ORDER BY num DESC LIMIT 1", igfY) : null;
    if (igfR) push(igfStory(igfR, "Fiscalização", Q1(igf, "SELECT COUNT(*) n FROM reports WHERE year = ?", igfY).n));
    if (provR) push(provStory(provR, "Fiscalização"));
    if (regR) push(regStory(regR, "Fiscalização"));
    const regOther = Q(reg, "SELECT * FROM decisions WHERE date <= ? AND date >= ? AND kind IN ('deliberacao','contraordenacao','concentracao_notificada') ORDER BY date DESC, COALESCE(amount, 0) DESC LIMIT 2", rr, add(rr, -30));
    for (const r of regOther) push(regStory(r, "Fiscalização"), 5);
    const envio = atoRows(["envio_tc"], add(rp, -60), rp, 1)[0];
    if (envio) push(atoStory(envio, "Fiscalização", { kicker: "Tribunal Constitucional" }), 5);
    const tcon = Q(dre, "SELECT COUNT(*) n FROM acts WHERE kind = 'Acórdão do Tribunal Constitucional' AND date >= ? AND date <= ?", add(rd, -13), rd)[0];
    if (tcon && tcon.n) push({ id: "tconst", section: "Fiscalização", kicker: "Tribunal Constitucional", hed: `Tribunal Constitucional publicou ${nf(tcon.n)} ${plural(tcon.n, "acórdão", "acórdãos")} em duas semanas`, dek: null, lead: [`O Diário da República publicou ${nf(tcon.n)} ${plural(tcon.n, "acórdão", "acórdãos")} do Tribunal Constitucional entre ${range(add(rd, -13), rd)}.`], ref: "justica", date: rd }, 6);

    if (nomLead && lead?.id !== `ato-${nomLead.id}`) push(atoStory(nomLead, "Nomeações"));
    for (const r of noms) { if (S["Nomeações"].length >= 2) break; push(atoStory(r, "Nomeações")); }
    const nr = Q(resp, "SELECT * FROM nomeacoes WHERE date <= ? AND date >= ? AND person IS NOT NULL ORDER BY date DESC, id DESC LIMIT 12", rn, add(rn, -45));
    const nrSeen = new Set();
    const named = () => S["Nomeações"].map((x) => x.hed).join(" ");
    for (const r of nr) { if (S["Nomeações"].length >= 4) break; if (named().includes(cleanName(r.person))) continue; const k = r.act_id || r.id; if (nrSeen.has(k + r.person)) continue; nrSeen.add(k + r.person); push(nomStory(r, "Nomeações")); }
    const cres = Q1(resp, "SELECT * FROM cresap_results WHERE date <= ? ORDER BY date DESC LIMIT 1", D);
    if (cres && cres.date >= add(D, -90) && S["Nomeações"].length < 5) {
      const cand3 = Q(resp, "SELECT candidate FROM cresap_results WHERE code = ? AND role = ? AND entity = ?", cres.code, cres.role, cres.entity).map((x) => cleanName(x.candidate));
      const prop = /^proposta/.test(cres.outcome || "");
      push({ id: `cresap-${cres.code}`, section: "Nomeações", kicker: "CReSAP", hed: prop ? `CReSAP propõe ${nf(cand3.length)} ${plural(cand3.length, "candidato", "candidatos")} para ${cleanName(cres.role)}, ${cleanName(cres.entity)}` : `CReSAP: ${cleanName(cres.role)}, ${cleanName(cres.entity)}`, dek: null, lead: [`Em ${pdate(cres.date)}, a Comissão de Recrutamento e Seleção para a Administração Pública publicou o resultado do concurso para ${cleanName(cres.role)} em ${cleanName(cres.entity)}: ${cleanName(cres.outcome || "resultado publicado")}.${cand3.length ? ` Candidatos: ${list(cand3)}.` : ""}`], ref: "responsaveis", date: cres.date });
    }

    const loc = late() ? [] : P(`SELECT c.*, e.id eid FROM contracts c CROSS JOIN entities e ON e.nif = c.buyer_nif WHERE c.published >= ? AND c.published <= ? AND c.price > 0 AND e.kind IN ('municipio','freguesia','empresa_municipal','cim_am') ORDER BY c.price DESC LIMIT 6`, wc.a, wc.b);
    loc.slice(0, 2).forEach((c, i) => push(contractStory(c, w, 1 + i, "Poder local", { kicker: "Câmaras e freguesias", hed: `${cleanName(c.buyer_name)} contrata ${cleanName(c.seller_name)} por ${eur(c.price)}` })));
    const locTop = late() ? undefined : P(`SELECT c.buyer_nif, c.buyer_name, COUNT(*) n, SUM(c.price) v FROM contracts c CROSS JOIN entities e ON e.nif = c.buyer_nif WHERE c.published >= ? AND c.published <= ? AND e.kind = 'municipio' GROUP BY c.buyer_nif ORDER BY n DESC LIMIT 1`, wc.a, wc.b)[0];
    if (locTop) push({ id: "loc-top", section: "Poder local", kicker: "Município mais ativo", hed: `${cleanName(locTop.buyer_name)} publicou mais contratos do que qualquer outro município na semana`, dek: null, lead: [`Entre ${range(wc.a, wc.b)}, o ${cleanName(locTop.buyer_name)} publicou ${nf(locTop.n)} contratos no Portal BASE, num total de ${eur(locTop.v)}.`], ref: `entidade/${eidOf(locTop.buyer_nif)}`, date: wc.b });

    for (const c of topUniq.slice(lead?.id?.startsWith("contrato") ? 1 : 0, 6)) { if (S["Dinheiro público"].length >= 2) break; push(contractStory(c, w, topUniq.indexOf(c) + 1, "Dinheiro público")); }
    const topDirect = late() ? null : P1(`SELECT * FROM contracts WHERE published >= ? AND published <= ? AND procedure LIKE 'Ajuste Direto%' AND price > 0 ORDER BY price DESC LIMIT 1`, wc.a, wc.b);
    if (topDirect) {
      const st = contractStory(topDirect, w, 1, "Dinheiro público", { kicker: "Ajuste direto" });
      st.hed = `Sem concurso: ${cleanName(topDirect.buyer_name)} contrata por ajuste direto ${eur(topDirect.price)} a ${cleanName(topDirect.seller_name)}`;
      st.lead[0] = `${cleanName(topDirect.buyer_name)} celebrou a ${pshort(topDirect.signed)} com ${cleanName(topDirect.seller_name)} um contrato de ${eur(topDirect.price)} por ajuste direto, o mais elevado desse tipo entre os ${nf(w.n)} contratos publicados entre ${range(w.a, w.b)}. Nesse período, o ajuste direto representou ${pc(cs.dv, cs.v, 1)} do valor contratado.`;
      push(st);
    }
    const dv = Q1(dvd, "SELECT date, value FROM series WHERE code = 'total' ORDER BY date DESC LIMIT 1");
    if (dv) {
      const ya = Q1(dvd, "SELECT value FROM series WHERE code = 'total' AND date = ?", `${Number(dv.date.slice(0, 4)) - 1}${dv.date.slice(4)}`);
      push({ id: "divida", section: "Dinheiro público", kicker: "Dívida pública", hed: `Dívida pública total: ${eurS(dv.value * 1e6)} em ${MES[Number(dv.date.slice(5, 7)) - 1]} de ${dv.date.slice(0, 4)}`, dek: null, lead: [`Segundo as estatísticas do IGCP, o stock de dívida total era de ${eur(dv.value * 1e6)} em ${MES[Number(dv.date.slice(5, 7)) - 1]} de ${dv.date.slice(0, 4)}${ya ? `, face a ${eur(ya.value * 1e6)} um ano antes (${dv.value >= ya.value ? "+" : ""}${nf(delta(dv.value, ya.value), 1)}%)` : ""}.`], ref: "divida", date: `${dv.date}-28`, when: `${MES[Number(dv.date.slice(5, 7)) - 1]} de ${dv.date.slice(0, 4)}` });
    }
    if (grant) push(grantStory());

    const spA = add(rc, -29);
    const spR = late() ? [] : P("SELECT published d, COUNT(*) n, SUM(CASE WHEN price > 0 THEN price END) v FROM contracts WHERE published >= ? AND published <= ? GROUP BY published", spA, rc);
    const spC = series(spR, spA, rc), spV = series(spR, spA, rc, "v");
    const spD = series(Q(dre, "SELECT date d, COUNT(*) n FROM acts WHERE date >= ? AND date <= ? GROUP BY date", add(rd, -29), rd), add(rd, -29), rd);
    const spVotes = series(Q(vot, "SELECT data d, COUNT(*) n FROM votos WHERE orgao = 'Plenário' AND data >= ? AND data <= ? GROUP BY data", add(rv, -89), rv), add(rv, -89), rv);
    const spReg = series(Q(reg, "SELECT date d, COUNT(*) n FROM decisions WHERE date >= ? AND date <= ? GROUP BY date", add(rr, -89), rr), add(rr, -89), rr);
    const nVotes = votes.length, nApp = votes.filter(approved).length;
    const dcPrev = sum(dreCount(add(rd, -13), add(rd, -7)));
    const topBuyers = late() ? [] : P(`SELECT buyer_nif nif, buyer_name name, COUNT(*) n, SUM(price) v FROM contracts WHERE published >= ? AND published <= ? AND price > 0 GROUP BY buyer_nif ORDER BY v DESC LIMIT 5`, wc.a, wc.b).map((x) => ({ ...x, eid: eidOf(x.nif) }));
    const nProm = Q1(pres, "SELECT COUNT(*) n FROM atos WHERE tipo = 'promulgacao' AND data >= ? AND data <= ?", add(rp, -29), rp)?.n || 0;
    const nVeto = Q1(pres, "SELECT COUNT(*) n FROM vetos WHERE data >= ? AND data <= ?", add(rp, -89), rp)?.n || 0;
    const nNom = Q1(pres, "SELECT COUNT(*) n FROM atos WHERE tipo = 'nomeacao' AND data >= ? AND data <= ?", add(rp, -29), rp)?.n || 0;
    const nReg = decCount(add(rr, -29), rr);
    const numeros = {
      janela: wc, ref: { contratos: rc, votos: rv, tc: rt, dr: rd, reguladores: rr },
      destaques: [
        { v: nf(nVotes), t: `votações em plenário em ${range(add(rv, -29), rv)}: ${nf(nApp)} aprovadas, ${nf(nVotes - nApp)} rejeitadas` },
        { v: nf(dn), t: `atos no Diário da República em ${range(add(rd, -6), rd)}` },
      ],
      itens: [
        { k: "Votações em plenário", v: nf(nVotes), note: `${range(add(rv, -29), rv)}: ${nf(nApp)} aprovadas, ${nf(nVotes - nApp)} rejeitadas`, spark: spVotes },
        { k: "Atos no Diário da República", v: nf(dn), d: delta(dn, dcPrev), note: `${range(add(rd, -6), rd)}; face aos 7 dias anteriores`, spark: spD },
        { k: "Promulgações presidenciais", v: nf(nProm), note: `${range(add(rp, -29), rp)}; ${nf(nVeto)} ${plural(nVeto, "veto", "vetos")} em 90 dias` },
        { k: "Documentos do Tribunal de Contas", v: nf(tcStat.n), note: `${range(tcStat.a, tcStat.b)}; ${tcStat.aud} auditorias` },
        { k: "Decisões de reguladores", v: nf(nReg), note: `${range(add(rr, -29), rr)}: ADC, ERC e outros`, spark: spReg },
        { k: "Nomeações presidenciais", v: nf(nNom), note: `${range(add(rp, -29), rp)}` },
        { k: "Contratos publicados", v: nf(cs.n), d: delta(cs.n, csp.n), note: `${range(wc.a, wc.b)}; face aos 7 dias anteriores`, spark: spC },
        { k: "Valor contratado", v: eurS(cs.v), d: delta(cs.v, csp.v), note: "soma dos preços contratuais", spark: spV },
        { k: "Por ajuste direto", v: pc(cs.dv, cs.v, 1), d: csp.v ? Math.round((100 * cs.dv / cs.v - 100 * csp.dv / csp.v) * 10) / 10 : null, dUnit: "p.p.", note: "do valor contratado" },
      ],
      topBuyers,
    };

    const Y = { a: yearAgo(wc.a), b: yearAgo(wc.b) };
    const skipAgo = late();
    const yc = skipAgo ? { n: 0, v: 0, dv: 0 } : cstats(Y.a, Y.b);
    const ytop = skipAgo ? null : P1("SELECT * FROM contracts WHERE published >= ? AND published <= ? AND price > 0 ORDER BY price DESC LIMIT 1", Y.a, Y.b);
    const yv = voteRows(yearAgo(add(rv, -29)), yearAgo(rv), 120).filter((r) => !/Delibera/i.test(r.fase));
    const yvT = [...yv].filter((r) => !r.unanime && r.fs + r.cs > 0).sort((x, y) => voteScore(y) - voteScore(x))[0];
    const yd = sum(dreCount(yearAgo(add(rd, -6)), yearAgo(rd)));
    const yApp = yv.filter(approved).length;
    const ago = {
      janela: Y, data: yearAgo(D),
      texto: yv.length || yd ? `Há um ano, entre ${range(yearAgo(add(rv, -29)), yearAgo(rv))}, o plenário realizou ${nf(yv.length)} ${plural(yv.length, "votação", "votações")}: ${nf(yApp)} ${plural(yApp, "aprovada", "aprovadas")} e ${nf(yv.length - yApp)} ${plural(yv.length - yApp, "rejeitada", "rejeitadas")}. Nos 30 dias que terminam na referência desta edição foram ${nf(nVotes)}.` : `Sem registos de votações há um ano nas bases do portal.`,
      itens: [
        yvT && { t: "Votação mais renhida", text: `${voteTitle(yvT)} (${yvT.resultado.toLowerCase()}, ${yvT.margin} lugares de diferença, ${pshort(yvT.data)})`, ref: `voto/${yvT.id}` },
        yd && { t: "Diário da República", text: `${nf(yd)} atos publicados em ${range(yearAgo(add(rd, -6)), yearAgo(rd))}` },
        ytop && { t: "Maior contrato", text: `${cleanName(ytop.buyer_name)} com ${cleanName(ytop.seller_name)}: ${eur(ytop.price)}`, ref: contractLink(ytop) },
      ].filter(Boolean),
    };

    const tick = [];
    for (const r of votes.slice(0, 8)) tick.push({ k: "Votação", t: `${cut(cleanName(r.titulo), 80)}: ${r.resultado.toLowerCase()}`, ref: `voto/${r.id}`, d: r.data });
    for (const r of tcAll.slice(0, 4)) tick.push({ k: "Tribunal de Contas", t: cut(cleanName(r.descricao) || tcNum(r.numero), 90), ref: `relatorio/${encodeURIComponent(r.id)}`, d: r.publicado });
    for (const r of prom.slice(0, 3)) tick.push({ k: "Promulgação", t: promHed(r).replace(/^Presidente promulga /, ""), ref: `ato/${encodeURIComponent(r.id)}`, d: r.data });
    for (const r of noms.slice(0, 2)) tick.push({ k: "Nomeação", t: cut(r.titulo.replace(/^Nomeia\s+/, ""), 90), ref: `ato/${encodeURIComponent(r.id)}`, d: r.data });
    for (const c of P("SELECT id, published, buyer_name, seller_name, price FROM contracts WHERE published >= ? AND published <= ? AND price >= 500000 ORDER BY published DESC, price DESC LIMIT 4", add(rc, -2), rc))
      tick.push({ k: "Contrato", t: `${cut(cleanName(c.buyer_name), 46)} → ${cut(cleanName(c.seller_name), 36)}: ${eurS(c.price)}`, ref: contractLink(c), d: c.published });
    tick.sort((a, b) => (a.d < b.d ? 1 : -1));

    const runners = cand.slice(1, 4).map((c) => ({ tipo: c.tipo, score: pct0(c.score), why: c.why }));
    const d = DT(D);
    const leadNote = lead && lead.date && lead.date < D ? `Último registo disponível à data desta edição: ${pdate(lead.date)}.` : null;
    return {
      data: D, extenso: pdate(D), diaSemana: DIA[d.getUTCDay()], numero: days(MIN_DATE, D) + 1,
      defaultData: todayStr(), min: MIN_DATE, max: todayStr(),
      lead, leadNote, leadWhy: leadC ? { tipo: leadC.tipo, score: pct0(leadC.score), why: leadC.why, outros: runners } : null,
      seccoes: S, numeros, haUmAno: ago, ticker: tick.slice(0, 20),
      ...(partial ? { partial: true } : {}),
    };
  }

  const SECS = [["parlamento", "Parlamento"], ["governo", "Governo e Presidente"], ["fiscalizacao", "Fiscalização"], ["nomeacoes", "Nomeações"], ["poder-local", "Poder local"], ["dinheiro", "Dinheiro público"], ["indicadores", "Indicadores"]];
  const SEC_TITLE = Object.fromEntries(SECS);
  const SEC_ORDER = Object.fromEntries(SECS.map(([k], i) => [k, i]));
  const RESUMO_MAX = 12;
  const stateDir = () => process.env.ESTADO_ABERTO_STATE || process.env.STATE_DIR || path.join(dataDir, "state");
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(), f), "utf8")); } catch { return null; } };
  const J = (v, d) => { if (v == null || v === "") return d; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return d; } };
  const S = (v) => (v == null ? "" : String(v));
  const day10 = (v) => (/^\d{4}-\d{2}-\d{2}/.test(S(v)) ? S(v).slice(0, 10) : "");
  const safeUrl = (u) => (/^https?:\/\//i.test(S(u)) ? S(u) : null);
  const fontesOf = (v) => (Array.isArray(J(v, [])) ? J(v, []) : []).map((f) => (typeof f === "string" ? { label: f, href: null } : { label: S(f && f.label), href: safeUrl(f && f.href) })).filter((f) => f.label);
  const listOf = (v) => { const a = J(v, []); return Array.isArray(a) ? a : []; };
  const horaOf = (v) => (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(S(v)) ? S(v).slice(11, 16) : "");

  const frescura = (dia, D) => {
    const m = new Map();
    const put = (fonte, ultima, ok) => {
      fonte = S(fonte); if (!fonte) return;
      const cur = m.get(fonte) || { fonte, ultima_data: "", ok: "" };
      if (day10(ultima) > cur.ultima_data) cur.ultima_data = day10(ultima);
      if (S(ok) > cur.ok) cur.ok = S(ok);
      m.set(fonte, cur);
    };
    for (const r of Q(dia, "SELECT fonte, max_data, atualizado_em FROM cursores")) put(r.fonte, r.max_data, r.atualizado_em);
    const st = readJson(".ingest_state.json");
    const steps = st && typeof st === "object" ? (st.steps && typeof st.steps === "object" ? st.steps : st) : {};
    for (const [k, v] of Object.entries(steps)) if (v && typeof v === "object") put(k, v.last_data_date, v.last_ok);
    const lim = add(D, -1);
    return [...m.values()].map((x) => ({ fonte: x.fonte, ultima_data: x.ultima_data || null, atrasada: !x.ultima_data || x.ultima_data < lim, ultima_ok: x.ok || null })).sort((x, y) => (x.fonte < y.fonte ? -1 : 1));
  };

  const navOf = (D) => {
    const t = todayStr();
    return { anterior: D > MIN_DATE ? add(D, -1) : null, seguinte: D < t ? add(D, 1) : null, primeira: MIN_DATE, ultima: t };
  };
  const head = (D) => ({ data: D, numero: days(MIN_DATE, D) + 1, extenso: pdate(D), diaSemana: DIA[DT(D).getUTCDay()], reporta: add(D, -1), reporta_extenso: pdate(add(D, -1)), min: MIN_DATE, max: todayStr(), defaultData: todayStr(), navegacao: navOf(D) });

  const VOTOS = new Set(["favor", "contra", "abstencao", "ausente", "ausencia"]);
  const safeRota = (r) => (/^#\/[\w\-./%?=&|]+$/.test(S(r)) ? S(r) : "");
  const blocosOf = (v) => {
    const b = J(v, null);
    if (!b || typeof b !== "object") return null;
    const l = b.lei && typeof b.lei === "object" ? b.lei : null, vt = b.votacao && typeof b.votacao === "object" ? b.votacao : null;
    const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Math.max(0, Math.round(Number(x))) : null);
    const lei = l ? { titulo: S(l.titulo), tipo: S(l.tipo), numero: S(l.numero), legislatura: S(l.legislatura), autor: S(l.autor), origem: S(l.origem), rota: safeRota(l.rota), texto_url: safeUrl(l.texto_url) } : null;
    const voteOf = (x) => ({
      data: day10(x.data), fase: S(x.fase), orgao: S(x.orgao), resultado: S(x.resultado), unanime: x.unanime === true,
      por_partido: listOf(x.por_partido).filter((p) => p && p.partido && VOTOS.has(p.voto)).map((p) => ({ partido: S(p.partido), voto: p.voto === "ausencia" ? "ausente" : p.voto, lugares: num(p.lugares) })),
      totais: { favor: num(x.totais && x.totais.favor) || 0, contra: num(x.totais && x.totais.contra) || 0, abstencao: num(x.totais && x.totais.abstencao) || 0 },
    });
    const votacao = vt ? voteOf(vt) : null;
    const anteriores = listOf(b.votacoes_anteriores).filter((x) => x && typeof x === "object").slice(-10).map(voteOf);
    const intervencoes = listOf(b.intervencoes).filter((x) => x && S(x.excerto)).slice(0, 6).map((x) => ({ id: S(x.id), deputado: S(x.deputado), partido: S(x.partido), data: day10(x.data), excerto: cut(S(x.excerto), 280), rota: safeRota(x.rota) }));
    if (!lei && !votacao && !intervencoes.length) return null;
    return { lei, votacao, votacoes_anteriores: anteriores, intervencoes };
  };
  const explicacaoOf = (v) => {
    const x = J(v, null);
    if (!x || typeof x !== "object") return null;
    const do_que_trata = S(x.do_que_trata).trim(), o_que_muda = listOf(x.o_que_muda).map(S).map((y) => y.trim()).filter(Boolean);
    return do_que_trata || o_que_muda.length ? { do_que_trata, o_que_muda } : null;
  };
  let iaCols = null;
  const iaSel = (dia) => {
    iaCols ??= new Set(Q(dia, "PRAGMA table_info(artigos_ia)").map((c) => c.name));
    return ["blocos", "explicacao"].map((c) => (iaCols.has(c) ? c : `NULL ${c}`)).join(", ");
  };

  const GENERIC_ROTA = /^#?\/?[a-z-]+(\/[a-z-]+)?(\?.*)?$/;
  const enc = encodeURIComponent;
  const entId = (e, tipo) => { const x = listOf(e.entidades).find((y) => y && y.tipo === tipo && y.id); return x ? S(x.id) : ""; };
  const rotaObjeto = (e) => {
    const rota = S(e.rota), ref = S(e.fonte_ref), mod = S(e.fonte_modulo), tipo = S(e.tipo);
    if (rota && !GENERIC_ROTA.test(rota)) return rota;
    let r = "";
    if (mod === "votacoes") { const b = tipo === "iniciativa_entrada" ? ref : entId(e, "iniciativa"); if (/^\d+$/.test(b)) r = "#/votacoes/" + b; }
    else if (mod === "intervencoes") { if (/^\d+$/.test(ref)) r = "#/votacoes/" + ref; }
    else if (mod === "posicoes") { if (ref) r = "#/artigo/declaracao/" + enc(ref); }
    else if (mod === "presidencia") { if (tipo === "comunicado") r = ""; else if (ref) r = "#/atos-presidente/" + enc(ref); }
    else if (mod === "dre") { if (ref) r = "#/dre/" + enc(ref); }
    else if (mod === "justica") { if (ref) r = "#/artigo/relatorio/" + enc(ref); }
    else if (mod === "reguladores") { if (ref) r = "#/artigo/regulador/" + enc(ref); }
    else if (mod === "responsaveis") { if (tipo === "nomeacao_gabinete") r = ""; else if (ref) r = "#/artigo/nomeacao/" + enc(ref); }
    else if (mod === "politica") { const c = tipo === "alteracao_contrato" ? ref.split(":")[0] : ref; if (/^[\w-]+$/.test(c) && /^contrato|^alteracao/.test(tipo)) r = "#/artigo/contrato/" + enc(c); }
    else if (mod === "apoios") { if (tipo === "apoio" && ref) r = "#/artigo/apoio/" + enc(ref); }
    else if (mod === "provedor") { if (/^\d{4}$/.test(ref)) r = "#/provedor?ano=" + ref; }
    else if (mod === "igf") { if (ref) r = "#/igf?q=" + enc(ref); }
    else if (mod === "ine_series") { if (ref) r = "#/indicadores/" + enc(ref); }
    return r || (rota && !/^#?\/?(parlamento|justica|responsaveis|dre|votacoes|igf|provedor|poderes\/presidente|anuncios|apoios)$/.test(rota) ? rota : "");
  };

  const cardBlocos = (b) => (b ? { lei: b.lei, votacao: b.votacao } : null);
  const itemOf = (e, D, art) => {
    const late = !!e.atrasado;
    const it = { id: e.id, titulo: S(e.titulo), resumo_curto: S(e.resumo_curto), rota: rotaObjeto(e), source_url: safeUrl(e.source_url), atrasado: late, tipo: S(e.tipo), hora: horaOf(e.ingerido_em), data_evento: day10(e.data_evento) };
    if (late && it.data_evento) it.atraso = `${D === todayStr() ? "Registado hoje" : "Registado a " + pshort(D)} · ocorreu a ${pdate(it.data_evento)}`;
    if (art) { it.ia = true; it.artigo_id = art; }
    return it;
  };

  const ledgerDay = (D, vista) => {
    const dia = openData("diario");
    if (!dia) return null;
    const ed = Q1(dia, "SELECT numero, data, estado, fechada_em FROM edicoes WHERE data = ?", D);
    const evs = Q(dia, "SELECT id, data_evento, ingerido_em, secao, tipo, titulo, resumo_curto, fonte_modulo, fonte_ref, entidades, rota, source_url, score, atrasado, ia_artigo_id FROM eventos WHERE edicao_data = ? ORDER BY score DESC, id", D);
    if (!ed && !evs.length) return null;
    const arts = Q(dia, `SELECT id, evidence_hash, evento_ids, titulo, lead, corpo, pontos_chave, fontes, entidades, confianca, modelo, revisor, verificacao, criado_em, ${iaSel(dia)} FROM artigos_ia WHERE edicao_data = ? AND estado = 'publicado' ORDER BY id`, D);
    const artIds = new Set(arts.map((a) => a.id));
    const byEv = new Map(evs.map((e) => [e.id, e]));
    const cover = new Map();
    for (const a of arts) for (const id of listOf(a.evento_ids)) if (!cover.has(Number(id))) cover.set(Number(id), a.id);
    for (const e of evs) if (e.ia_artigo_id != null && artIds.has(e.ia_artigo_id)) cover.set(e.id, e.ia_artigo_id);
    const ia = arts.map((a) => {
      const linked = listOf(a.evento_ids).map((id) => byEv.get(Number(id))).filter(Boolean);
      const cnt = {};
      for (const e of linked) cnt[e.secao] = (cnt[e.secao] || 0) + 1;
      const secao = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x] || (SEC_ORDER[x] ?? 99) - (SEC_ORDER[y] ?? 99))[0] || "governo";
      return { id: a.id, secao, secao_titulo: SEC_TITLE[secao] || "", titulo: S(a.titulo), lead: S(a.lead), corpo: S(a.corpo), pontos_chave: listOf(a.pontos_chave).map(S).filter(Boolean), fontes: fontesOf(a.fontes), modelo: S(a.modelo), revisor: S(a.revisor), verificacao: J(a.verificacao, null), confianca: a.confianca, rota_detalhe: `#/edicao/${D}/ia/${a.id}`, blocos: cardBlocos(blocosOf(a.blocos)), tem_explicacao: !!explicacaoOf(a.explicacao), _s: linked.reduce((m, e) => Math.max(m, Number(e.score) || 0), 0) };
    }).sort((x, y) => y._s - x._s || x.id - y.id).map(({ _s, ...r }) => r);
    const fres = frescura(dia, D);
    const grupos = Object.fromEntries(SECS.map(([k]) => [k, []]));
    for (const e of evs) if (grupos[e.secao]) grupos[e.secao].push(e);
    const secoes = SECS.map(([k, t]) => {
      const rest = grupos[k].filter((e) => !cover.has(e.id));
      return rest.length ? { secao: k, titulo: t, total: rest.length, mais: Math.max(0, rest.length - RESUMO_MAX), itens: rest.slice(0, RESUMO_MAX).map((e) => itemOf(e, D)) } : null;
    }).filter(Boolean);
    const upd = [ed && ed.fechada_em, ...evs.map((e) => e.ingerido_em), ...Q(dia, "SELECT atualizado_em FROM cursores").map((r) => r.atualizado_em)].filter(Boolean).map(S).sort().pop() || null;
    const out = {
      fonte: "diario", vista, ...head(D), estado: ed ? ed.estado : "preliminar", atualizado_em: upd, frescura: fres,
      ia, secoes, divisao: { rotulo: `Ver tudo o que aconteceu em ${pdate(add(D, -1))}`, total: evs.length },
    };
    if (vista === "tudo") {
      out.tudo = SECS.map(([k, t]) => {
        const rows = grupos[k];
        if (rows.length) return { secao: k, titulo: t, vazio: false, motivo: null, itens: rows.map((e) => itemOf(e, D, cover.get(e.id))) };
        return { secao: k, titulo: t, vazio: true, motivo: "Sem registos para este dia", itens: [] };
      });
    }
    return out;
  };

  routes["/api/edicao/dia"] = (q) => {
    const D = clampDate(q.get("data"));
    const vista = q.get("vista") === "tudo" ? "tudo" : "resumo";
    if (D < MIN_DATE) return { sem_edicao: true, fonte: "diario", data: D, extenso: pdate(D), min: MIN_DATE, max: todayStr(), defaultData: todayStr(), navegacao: navOf(MIN_DATE), primeira: MIN_DATE };
    const led = ledgerDay(D, vista);
    if (led) return led;
    if (!one("SELECT 1 x FROM sqlite_master WHERE name = 'contracts'")) return unavailable("politica", "não foi encontrada ou está vazia");
    const e = edition(D);
    return { ...e, fonte: "legado", navegacao: navOf(D) };
  };

  routes["/api/edicao/arquivo"] = (q) => {
    const t = todayStr();
    let m = /^\d{4}-\d{2}$/.test(q.get("mes") || "") ? q.get("mes") : t.slice(0, 7);
    if (m < MIN_DATE.slice(0, 7)) m = MIN_DATE.slice(0, 7);
    if (m > t.slice(0, 7)) m = t.slice(0, 7);
    const a = m + "-01", b = m + "-31";
    const dia = openData("diario");
    const n = new Map(dia ? Q(dia, "SELECT edicao_data d, COUNT(*) n FROM eventos WHERE edicao_data >= ? AND edicao_data <= ? GROUP BY edicao_data", a, b).map((r) => [r.d, r.n]) : []);
    const c = new Map(P("SELECT published d, COUNT(*) n FROM contracts WHERE published >= ? AND published <= ? GROUP BY published", a, b).map((r) => [r.d, r.n]));
    const v = new Map(Q(vot, "SELECT data d, COUNT(*) n FROM votos WHERE orgao = 'Plenário' AND data >= ? AND data <= ? GROUP BY data", a, b).map((r) => [r.d, r.n]));
    const r = new Map(Q(dre, "SELECT date d, COUNT(*) n FROM acts WHERE date >= ? AND date <= ? GROUP BY date", a, b).map((x) => [x.d, x.n]));
    const out = [];
    for (let d = a < MIN_DATE ? MIN_DATE : a; d.slice(0, 7) === m && d <= t; d = add(d, 1)) out.push({ d, ...(dia ? { n: n.get(d) || 0 } : {}), c: c.get(d) || 0, v: v.get(d) || 0, r: r.get(d) || 0 });
    return { mes: m, dias: out, min: MIN_DATE, max: t, defaultData: t, fonte: dia ? "diario" : "legado" };
  };

  const ledgerArticle = (id) => {
    const dia = openData("diario");
    if (!dia) return null;
    const a = Q1(dia, "SELECT * FROM artigos_ia WHERE id = ?", id);
    if (!a) return null;
    const ver = J(a.verificacao, null), ret = ver && ver.retirada ? ver.retirada : null;
    if (a.estado !== "publicado" && !ret) return null;
    const D = day10(a.edicao_data);
    const ids = new Set(listOf(a.evento_ids).map(Number));
    const rows = Q(dia, "SELECT id, data_evento, ingerido_em, edicao_data, secao, tipo, titulo, resumo_curto, fonte_modulo, fonte_ref, entidades, rota, source_url, score, atrasado, ia_artigo_id FROM eventos WHERE ia_artigo_id = ? OR edicao_data = ? ORDER BY score DESC, id", a.id, D);
    const linked = rows.filter((e) => ids.has(e.id) || e.ia_artigo_id === a.id);
    const cnt = {};
    for (const e of linked) cnt[e.secao] = (cnt[e.secao] || 0) + 1;
    const secao = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x] || (SEC_ORDER[x] ?? 99) - (SEC_ORDER[y] ?? 99))[0] || "governo";
    if (a.estado !== "publicado") {
      return { tipo: "ia", id: a.id, data: D, ...head(D), secao, secao_titulo: SEC_TITLE[secao] || "", titulo: S(a.titulo), lead: "", paragraphs: [], pontos_chave: [], fontes: [], numeros_citados: [], entidades: [], confianca: null, modelo: S(a.modelo), revisor: "", verificacao: null, criado_em: S(a.criado_em), revisao: a.revisao, retirado: { motivo: S(ret.motivo).slice(0, 300), em: S(ret.em).slice(0, 25) }, eventos: linked.map((e) => itemOf(e, D)) };
    }
    return {
      tipo: "ia", id: a.id, data: D, ...head(D), secao, secao_titulo: SEC_TITLE[secao] || "", titulo: S(a.titulo), lead: S(a.lead),
      paragraphs: S(a.corpo).split(/\n{2,}/).map((x) => x.trim()).filter(Boolean), pontos_chave: listOf(a.pontos_chave).map(S).filter(Boolean), fontes: fontesOf(a.fontes),
      numeros_citados: listOf(a.numeros_citados), entidades: listOf(a.entidades).map((x) => (typeof x === "string" ? x : S(x && (x.nome || x.name || x.label)))).filter(Boolean),
      confianca: a.confianca, modelo: S(a.modelo), revisor: S(a.revisor), verificacao: J(a.verificacao, null), criado_em: S(a.criado_em), revisao: a.revisao,
      blocos: blocosOf(a.blocos), explicacao: explicacaoOf(a.explicacao),
      eventos: linked.map((e) => itemOf(e, D)),
    };
  };

  const chartYears = (nif, hi) => P("SELECT year, value FROM year_stats WHERE nif = ? ORDER BY year DESC LIMIT 10", nif).reverse().map((y) => ({ l: String(y.year), v: y.value, hi: y.year === hi }));

  const artContrato = (id) => {
    const c = P1("SELECT * FROM contracts WHERE id = ?", id);
    if (!c) return null;
    const b = P1("SELECT * FROM buyer_stats WHERE nif = ?", c.buyer_nif), s = P1("SELECT * FROM seller_stats WHERE nif = ?", c.seller_nif);
    const pair = P1("SELECT * FROM pair_stats WHERE buyer_nif = ? AND seller_nif = ?", c.buyer_nif, c.seller_nif);
    const mods = P("SELECT date, published, act_type, new_price, new_duration FROM contract_mods WHERE contract_id = ? ORDER BY date", c.id);
    const rank = c.price > 0 ? (P1("SELECT COUNT(*) n FROM contracts WHERE buyer_nif = ? AND price > ?", c.buyer_nif, c.price)?.n ?? 0) + 1 : null;
    const buyer = cleanName(c.buyer_name), seller = cleanName(c.seller_name);
    const eb = eidOf(c.buyer_nif), es = eidOf(c.seller_nif);
    const par = [], fn = [];
    const f = (label, url) => { fn.push({ n: fn.length + 1, label, url }); return `[^${fn.length}]`; };
    const m1 = f(`Portal BASE, contrato n.º ${c.id}`, c.link || `https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=${c.id}`);
    par.push(`${buyer} celebrou a ${pdate(c.signed)} um contrato com ${seller} no valor de ${eur(c.price)}, publicado no Portal BASE a ${pdate(c.published)}.${m1} O objeto declarado é «${cut(cleanName(c.object), 260)}».`);
    const pp = [];
    pp.push(`O procedimento foi ${String(c.procedure || "não indicado").toLowerCase()}${c.legal_basis ? `, com fundamento em ${cut(c.legal_basis, 140)}` : ""}${c.n_bidders > 0 ? `, com ${c.n_bidders} ${plural(c.n_bidders, "concorrente", "concorrentes")}` : ""}.`);
    if (c.base_price > 0 && c.price > 0 && Math.abs(c.base_price - c.price) / c.base_price > 0.001) pp.push(`O preço base era de ${eur(c.base_price)}; o preço contratual ficou ${nf(Math.abs(100 - 100 * c.price / c.base_price), 1)}% ${c.price < c.base_price ? "abaixo" : "acima"} desse valor.`);
    if (c.effective_price > 0 && Math.abs(c.effective_price - c.price) > 1) pp.push(`O preço efetivo, entretanto registado, é de ${eur(c.effective_price)}.`);
    if (c.duration_days > 0) pp.push(`O prazo de execução é de ${nf(c.duration_days)} dias${c.duration_days >= 60 ? `, cerca de ${nf(c.duration_days / 30.4, 1)} meses` : ""}.`);
    if (c.location) pp.push(`Local de execução: ${cut(c.location.replace(/^Portugal, /, ""), 120)}.`);
    par.push(pp.join(" "));
    if (b) par.push(`${buyer} tem ${nf(b.n)} contratos registados desde 2012, no total de ${eur(b.value)}; ${pc(b.direct_value, b.value, 1)} do valor foi adjudicado por ajuste direto.${rank ? ` Este contrato é ${rank === 1 ? "o mais caro" : `o ${rank}.º mais caro`} da entidade nesse período.` : ""}`);
    if (s) par.push(`${seller} surge em ${nf(s.n)} contratos públicos, no total de ${eur(s.value)}, com ${nf(s.n_buyers)} ${plural(s.n_buyers, "entidade adjudicante", "entidades adjudicantes")} diferentes.${pair && pair.n > 1 ? ` Só com ${buyer} há ${nf(pair.n)} contratos, no valor de ${eur(pair.value)}.` : ""}`);
    if (mods.length) par.push(`O contrato foi modificado ${nf(mods.length)} ${plural(mods.length, "vez", "vezes")}${mods.some((x) => x.new_price) ? `; o último preço registado é de ${eur(mods.filter((x) => x.new_price).pop().new_price)}` : ""}.`);
    const charts = [];
    if (c.buyer_nif) charts.push({ type: "bars", title: `Contratação anual de ${buyer}`, sub: `valor dos contratos por ano de celebração; destacado ${c.year}`, data: chartYears(c.buyer_nif, c.year), fmt: "eur" });
    const procs = P("SELECT procedure l, COUNT(*) n, SUM(price) v FROM contracts WHERE buyer_nif = ? AND price > 0 GROUP BY procedure ORDER BY v DESC LIMIT 6", c.buyer_nif);
    if (procs.length > 1) charts.push({ type: "hbars", title: "Valor por tipo de procedimento", sub: `todos os contratos de ${buyer} desde 2012`, data: procs.map((p) => ({ l: cut(p.l || "n/d", 38), v: p.v, hi: p.l === c.procedure })), fmt: "eur" });
    let flags = [];
    if (eb) { try { flags = routes["/api/entity"](new URLSearchParams({ id: eb }))?.flags || []; } catch {} }
    const frase = rank === 1 && b && b.n > 20 ? `O contrato mais caro de ${buyer} em ${nf(b.n)} contratos registados` : `${pc(c.price, b?.value, 2)} de tudo o que ${buyer} contratou desde 2012`;
    fn.push({ n: fn.length + 1, label: "dados.gov.pt, Portal BASE / IMPIC: contratos públicos", url: "https://dados.gov.pt" });
    return {
      tipo: "contrato", id: c.id, kicker: "Contratação pública", date: c.published,
      hed: contractHed(c), dek: upperFirst(objShort(c.object, 160)), by: "Redação automática a partir do Portal BASE",
      paragraphs: par, pull: frase, charts, flags: flags.map((x) => ({ label: x.label, text: x.text })),
      stats: [["Preço", eur(c.price)], ["Celebrado", pdate(c.signed)], ["Procedimento", c.procedure], ["Entidade", buyer], ["Fornecedor", seller], ["CPV", cut(c.cpv || "", 60)]].filter((x) => x[1]),
      links: [eb && { label: `Ficha de ${buyer}`, ref: `entidade/${eb}` }, es && { label: `Ficha de ${seller}`, ref: `entidade/${es}` }].filter(Boolean),
      fontes: fn,
    };
  };

  const artVoto = (id) => {
    const v = Q1(vot, "SELECT * FROM votos WHERE id = ?", id);
    if (!v) return null;
    const i = Q1(vot, "SELECT * FROM iniciativas WHERE bid = ?", v.bid) || {};
    const r = voteRows(v.data, v.data, 400).find((x) => x.id === v.id) || { ...v, F: seatsOf(v.favor), C: seatsOf(v.contra), A: seatsOf(v.abstencao) };
    const F = seatsOf(v.favor), C = seatsOf(v.contra), A = seatsOf(v.abstencao);
    const fs = seatSum(F), cs = seatSum(C), as = seatSum(A);
    const pv = Q(vot, "SELECT partido, sentido, kind, COUNT(*) n FROM voto_partido WHERE voto_id = ? AND kind IN ('gp','dividido') GROUP BY partido, sentido, kind", v.id);
    const split = pv.filter((x) => x.kind === "dividido");
    const fases = Q(vot, "SELECT ord, data, fase, comissao, obs FROM fases WHERE bid = ? ORDER BY ord", v.bid);
    const nv = Q1(vot, "SELECT COUNT(*) n FROM votos WHERE bid = ?", v.bid)?.n;
    const ivN = Q1(ivn, "SELECT COUNT(*) n FROM iv_ini WHERE bid = ?", v.bid)?.n || 0;
    const fn = [];
    const f = (label, url) => { fn.push({ n: fn.length + 1, label, url }); return `[^${fn.length}]`; };
    const ref = `${i.tipo || "Iniciativa"} n.º ${i.numero}/${i.leg}`;
    const ok = approved(v);
    const par = [];
    par.push(`No plenário de ${pdate(v.data)}, a Assembleia da República votou o ${ref}${i.autoria ? `, apresentado por ${i.autoria}` : ""}, sob o título «${cleanName(i.titulo)}».${f("Parlamento.pt, detalhe da iniciativa", v.source_url || i.source_url)} A ${String(v.fase).toLowerCase()} terminou com o resultado «${v.resultado}».`);
    const parts = [];
    if (F.length) parts.push(`a favor ${list(F.map(partyName))} (${fs} lugares)`);
    if (C.length) parts.push(`contra ${list(C.map(partyName))} (${cs} lugares)`);
    if (A.length) parts.push(`abstenção de ${list(A.map(partyName))} (${as} lugares)`);
    par.push(`Votaram ${list(parts)}. Somando os lugares de cada grupo parlamentar, a diferença entre favor e contra foi de ${Math.abs(fs - cs)}.${split.length ? ` Houve votos divididos em ${list([...new Set(split.map((x) => partyName(x.partido)))])}, não contabilizados nos lugares acima.` : ""}`);
    if (v.unanime) par.push("A votação foi registada como unânime.");
    if (fases.length) par.push(`A iniciativa deu entrada a ${pdate(i.data_entrada || fases[0].data)} e conta ${fases.length} ${plural(fases.length, "fase registada", "fases registadas")} e ${nv} ${plural(nv, "votação", "votações")}${i.estado ? `; estado atual: ${i.estado.toLowerCase()}` : ""}.`);
    if (i.lei_ref) par.push(`Convertida em ${i.lei_ref}.`);
    const seatRows = Object.entries(SEATS).map(([k, seats]) => {
      const hit = pv.find((x) => x.kind === "gp" && pk(x.partido) === k) || pv.find((x) => pk(x.partido) === k);
      return { l: k === "BE" ? "BE" : k, seats, s: hit ? hit.sentido : F.map(pk).includes(k) ? "favor" : C.map(pk).includes(k) ? "contra" : A.map(pk).includes(k) ? "abstencao" : "ausencia" };
    }).sort((a, b) => b.seats - a.seats);
    const charts = [{ type: "seats", title: "Como votou cada grupo parlamentar", sub: "largura proporcional ao número de lugares", data: seatRows, tot: { f: fs, c: cs, a: as } }];
    if (fases.length) charts.push({ type: "timeline", title: "Percurso da iniciativa", data: fases.map((x) => ({ d: x.data, l: x.fase, c: x.comissao })) });
    fn.push({ n: fn.length + 1, label: "Assembleia da República, Atividade Parlamentar (dados abertos)", url: "https://www.parlamento.pt" });
    return {
      tipo: "voto", id: v.id, kicker: "Votação em plenário", date: v.data,
      hed: voteStory({ ...r, ...i, margin: Math.abs(fs - cs), cs, fs, as, titulo: i.titulo, F, C, A }, "").hed, dek: cut(cleanName(i.titulo), 220), by: "Redação automática a partir dos dados abertos do Parlamento",
      paragraphs: par, pull: cs > 0 ? `${fs} lugares a favor, ${cs} contra: ${Math.abs(fs - cs)} de diferença` : `${fs} lugares a favor, nenhum contra`, charts, flags: [],
      stats: [["Resultado", v.resultado], ["Data", pdate(v.data)], ["Fase", v.fase], ["Autoria", i.autoria || ""], ["Iniciativa", ref]].filter((x) => x[1]),
      links: [i.key && { label: "Votações e percurso da iniciativa", ref: `votacoes/${encodeURIComponent(i.key)}` }, i.key && ivN > 0 && { label: `Intervenções dos deputados (${nf(ivN)})`, ref: `votacoes/${encodeURIComponent(i.key)}?tab=iv` }, { label: "Todas as votações", ref: "votacoes" }].filter(Boolean),
      fontes: fn,
    };
  };

  const artRelatorio = (id) => {
    const r = Q1(jus, "SELECT * FROM tcontas_docs WHERE id = ?", id);
    if (!r) return null;
    const cat = Q(jus, "SELECT substr(publicado,1,7) l, COUNT(*) v FROM tcontas_docs WHERE grupo = ? AND publicado IS NOT NULL AND publicado <= ? AND publicado >= ? GROUP BY l ORDER BY l", r.grupo, add(r.publicado || todayStr(), 31), add(r.publicado || todayStr(), -365));
    const nYear = Q1(jus, "SELECT COUNT(*) n FROM tcontas_docs WHERE grupo = ? AND year = ?", r.grupo, r.year)?.n;
    const fn = [{ n: 1, label: `Tribunal de Contas, ${tcNum(r.numero)}`, url: r.pdf_url || r.source_url }, { n: 2, label: "Tribunal de Contas, relatórios e acórdãos", url: r.source_url || "https://www.tcontas.pt" }];
    const par = [];
    par.push(`O Tribunal de Contas publicou a ${r.publicado ? pdate(r.publicado) : "data não indicada"} ${/^(Relatório|Acórdão)/i.test(tcNum(r.numero)) ? "o" : r.categoria === "acordao" ? "o acórdão" : "o relatório"} ${tcNum(r.numero)}${r.data ? `, com data de ${pdate(r.data)}` : ""}.[^1] ${r.descricao ? `Assunto: ${cleanName(r.descricao)}.` : ""}`);
    par.push(`O documento enquadra-se em «${r.grupo}»${r.tipo ? ` (${r.tipo.toLowerCase()})` : ""}. Em ${r.year}, o portal tem registados ${nf(nYear)} ${plural(nYear, "documento", "documentos")} desta categoria.[^2]${r.resultado ? ` Resultado indicado: ${r.resultado}.` : ""}${r.entity_name ? ` Entidade visada: ${r.entity_name}.` : ""}`);
    par.push("Este texto é gerado a partir dos metadados publicados pelo Tribunal de Contas. As conclusões e recomendações constam do documento original, disponível nas fontes.");
    return {
      tipo: "relatorio", id: r.id, kicker: r.categoria === "acordao" ? "Tribunal de Contas" : "Relatório de auditoria", date: r.publicado,
      hed: `${r.categoria === "acordao" ? "Tribunal de Contas decide" : r.grupo === "Auditoria" ? "Auditoria do Tribunal de Contas" : "Tribunal de Contas publica"}: ${cleanName(r.descricao) || tcNum(r.numero)}`, dek: r.entity_name ? `Entidade: ${r.entity_name}` : null, by: "Redação automática a partir dos dados do Tribunal de Contas",
      paragraphs: par, pull: r.descricao ? cut(cleanName(r.descricao), 160) : tcNum(r.numero), flags: [],
      charts: cat.length > 1 ? [{ type: "bars", title: `Publicações mensais: ${r.grupo}`, sub: "documentos publicados por mês, últimos 12 meses", data: cat.map((x) => ({ l: x.l.slice(5) + "/" + x.l.slice(2, 4), v: x.v, hi: x.l === (r.publicado || "").slice(0, 7) })), fmt: "int" }] : [],
      stats: [["Número", tcNum(r.numero)], ["Publicado", r.publicado ? pdate(r.publicado) : ""], ["Categoria", r.grupo]].filter((x) => x[1]), links: [{ label: "Tribunal de Contas no portal", ref: "justica" }], fontes: fn,
    };
  };

  const artAto = (id) => {
    const a = Q1(pres, "SELECT * FROM atos WHERE id = ?", id) || Q1(pres, "SELECT id, data, 'veto' tipo, titulo, motivo texto, mensagem_url, source_url FROM vetos WHERE id = ?", id);
    if (!a) return null;
    const body = atoBody(a.texto);
    const act = a.dre_act_id ? Q1(dre, "SELECT kind, number, date, url FROM acts WHERE id = ?", a.dre_act_id) : null;
    const fn = [];
    if (a.mensagem_url) fn.push({ n: fn.length + 1, label: "Mensagem do Presidente da República", url: a.mensagem_url });
    if (a.source_url) fn.push({ n: fn.length + 1, label: "Presidência da República, atos", url: a.source_url });
    if (act?.url) fn.push({ n: fn.length + 1, label: `Diário da República: ${act.kind} n.º ${act.number}`, url: act.url });
    const par = body.length ? body.slice(0, 8) : [a.titulo];
    return {
      tipo: "ato", id: a.id, kicker: a.tipo === "nomeacao" ? "Nomeação" : a.tipo === "promulgacao" ? "Promulgação" : a.tipo === "presidencia_dia" ? "Presidência: atos do dia" : "Presidência", date: a.data,
      hed: a.titulo.replace(/\.$/, ""), dek: `Publicado a ${pdate(a.data)}`, by: "Texto da Presidência da República, reproduzido dos dados do portal",
      paragraphs: par, pull: null, charts: [], flags: [], stats: [["Tipo", a.tipo], ["Data", pdate(a.data)]], links: [{ label: a.tipo === "nomeacao" ? "Quem decide e nomeações" : "Atos do Presidente", ref: a.tipo === "nomeacao" ? "responsaveis" : "atos-presidente" }], fontes: fn,
    };
  };

  const artApoio = (id) => {
    const a = Q1(apo, "SELECT * FROM apoios WHERE id = ?", id);
    if (!a) return null;
    const ben = Q1(apo, "SELECT * FROM ben WHERE bkey = ?", a.bkey);
    const yrs = Q(apo, "SELECT year l, SUM(amount) v FROM apoios WHERE bkey = ? GROUP BY year ORDER BY year", a.bkey);
    const rank = Q1(apo, "SELECT COUNT(*) n FROM apoios WHERE year = ? AND amount > ?", a.year, a.amount)?.n + 1;
    const fn = [{ n: 1, label: `${a.orgao}, apoios ${a.year}`, url: a.source_url || "https://dados.gov.pt" }];
    const par = [`Em ${a.year}, ${cleanName(a.nome)} recebeu ${eur(a.amount)} ao abrigo de «${cleanName(a.programa)}», atribuído pelo organismo ${a.orgao}${a.regiao ? `, na região ${a.regiao}` : ""}.[^1]${a.detalhe ? ` Projeto: ${cut(cleanName(a.detalhe), 200)}.` : ""}`,
      `Este foi o ${rank === 1 ? "maior" : `${rank}.º maior`} apoio individual registado em ${a.year} nas bases de apoios do portal.`];
    if (ben) par.push(`No conjunto das bases, o beneficiário reúne ${nf(ben.n)} apoios entre ${ben.primeiro} e ${ben.ultimo}, num total de ${eur(ben.total)}.`);
    return {
      tipo: "apoio", id: a.id, kicker: "Apoio público", date: `${a.year}-12-31`,
      hed: `${cleanName(a.nome)} recebe ${eur(a.amount)} em apoios do Estado`, dek: cut(cleanName(a.programa), 180), by: "Redação automática a partir das bases de apoios públicos",
      paragraphs: par, pull: `${rank === 1 ? "O maior" : `O ${rank}.º maior`} apoio individual de ${a.year}`, flags: [],
      charts: yrs.length > 1 ? [{ type: "bars", title: "Apoios por ano ao mesmo beneficiário", sub: "soma anual", data: yrs.map((y) => ({ l: String(y.l), v: y.v, hi: y.l === a.year })), fmt: "eur" }] : [],
      stats: [["Montante", eur(a.amount)], ["Organismo", a.orgao], ["Área", a.area], ["Ano", String(a.year)]].filter((x) => x[1]), links: [], fontes: fn,
    };
  };

  const artEntidade = (id) => {
    const e = P1("SELECT * FROM entities WHERE id = ?", id);
    if (!e) return null;
    const b = e.nif ? P1("SELECT * FROM buyer_stats WHERE nif = ?", e.nif) : null, s = e.nif ? P1("SELECT * FROM seller_stats WHERE nif = ?", e.nif) : null;
    const sup = b ? P("SELECT p.seller_nif nif, COALESCE(x.name, (SELECT seller_name FROM contracts WHERE seller_nif = p.seller_nif LIMIT 1)) name, p.n, p.value FROM pair_stats p LEFT JOIN entities x ON x.nif = p.seller_nif WHERE p.buyer_nif = ? ORDER BY p.value DESC LIMIT 6", e.nif) : [];
    let flags = [];
    try { flags = routes["/api/entity"](new URLSearchParams({ id }))?.flags || []; } catch {}
    const par = [];
    par.push(`${e.name}${e.kind ? ` (${e.kind.replace(/_/g, " ")})` : ""}${e.municipality ? `, em ${e.municipality}` : ""}${e.nif ? `, NIF ${e.nif}` : ""}.${e.description ? " " + cut(cleanName(e.description), 280) : ""}`);
    if (b) par.push(`Como entidade adjudicante, registou ${nf(b.n)} contratos entre ${b.first_signed?.slice(0, 4)} e ${b.last_signed?.slice(0, 4)}, no total de ${eur(b.value)}; ${pc(b.direct_value, b.value, 1)} desse valor foi por ajuste direto.${sup[0] ? ` O principal fornecedor é ${cleanName(sup[0].name)}, com ${nf(sup[0].n)} contratos e ${eur(sup[0].value)}.` : ""}`);
    if (s) par.push(`Como fornecedor do Estado, surge em ${nf(s.n)} contratos, no total de ${eur(s.value)}, com ${nf(s.n_buyers)} entidades adjudicantes diferentes.`);
    if (!b && !s) par.push("Não há contratos públicos associados a esta entidade nas bases do portal.");
    const charts = [];
    if (e.nif) { const y = chartYears(e.nif, null); if (y.length > 1) charts.push({ type: "bars", title: "Contratação por ano", sub: "valor dos contratos celebrados como adjudicante", data: y, fmt: "eur" }); }
    if (sup.length > 1) charts.push({ type: "hbars", title: "Principais fornecedores", sub: "valor acumulado desde 2012", data: sup.map((x) => ({ l: cut(cleanName(x.name), 38), v: x.value })), fmt: "eur" });
    return {
      tipo: "entidade", id: e.id, kicker: "Perfil de entidade", date: null, hed: e.name, dek: e.ministry ? `Tutela: ${e.ministry}` : (e.district || null), by: "Perfil gerado a partir do Portal BASE e de registos públicos",
      paragraphs: par, pull: b ? `${eurS(b.value)} contratados em ${nf(b.n)} contratos` : null, charts, flags: flags.map((x) => ({ label: x.label, text: x.text })),
      stats: [["Contratos", b ? nf(b.n) : ""], ["Valor", b ? eur(b.value) : ""], ["Ajuste direto", b ? pc(b.direct_value, b.value, 1) : ""], ["População", e.population ? nf(e.population) : ""]].filter((x) => x[1]),
      links: [{ label: "Ficha completa no diretório", ref: `entidades/${e.id}`, raw: true }],
      fontes: [{ n: 1, label: "Portal BASE / IMPIC, contratos públicos", url: "https://dados.gov.pt" }, ...(e.website ? [{ n: 2, label: "Sítio oficial", url: e.website }] : [])],
    };
  };

  const artRegulador = (id) => {
    const r = Q1(reg, "SELECT * FROM decisions WHERE id = ?", id);
    if (!r) return null;
    const b = Q1(reg, "SELECT * FROM bodies WHERE slug = ?", r.body) || { short: r.body.toUpperCase(), name: r.body.toUpperCase() };
    const nY = Q1(reg, "SELECT COUNT(*) n FROM decisions WHERE body = ? AND year = ?", r.body, r.year)?.n;
    const monthly = Q(reg, "SELECT substr(date,1,7) l, COUNT(*) v FROM decisions WHERE body = ? AND date IS NOT NULL AND date <= ? AND date >= ? GROUP BY l ORDER BY l", r.body, add(r.date || todayStr(), 31), add(r.date || todayStr(), -365));
    const par = [`${cleanName(b.name)} registou${r.date ? ` a ${pdate(r.date)}` : ""} a decisão ${cleanName(r.ref || r.id)}.[^1] ${cleanName(r.title)}.`];
    if (r.subject) par.push(`Assunto: ${cut(cleanName(r.subject), 400)}`);
    if (r.amount) par.push(`Montante indicado: ${eur(r.amount)}${r.amount_note ? ` (${cleanName(r.amount_note)})` : ""}.`);
    par.push(`Em ${r.year}, o portal tem registadas ${nf(nY)} ${plural(nY, "decisão", "decisões")} de ${b.short}.`);
    return {
      tipo: "regulador", id: r.id, kicker: `${b.short} · regulador`, date: r.date, hed: `${b.short}: ${cut(cleanName(r.title), 170)}`, dek: cleanName(b.name), by: "Redação automática a partir dos dados publicados pelo regulador",
      paragraphs: par, pull: r.amount ? `Montante: ${eur(r.amount)}` : null, flags: [],
      charts: monthly.length > 1 ? [{ type: "bars", title: `Decisões mensais de ${b.short}`, sub: "últimos 12 meses", data: monthly.map((x) => ({ l: x.l.slice(5) + "/" + x.l.slice(2, 4), v: x.v, hi: x.l === (r.date || "").slice(0, 7) })), fmt: "int" }] : [],
      stats: [["Regulador", b.short], ["Tipo", r.kind], ["Data", r.date ? pdate(r.date) : String(r.year)], ["Referência", cleanName(r.ref || "")], ["Montante", r.amount ? eur(r.amount) : ""]].filter((x) => x[1]),
      links: [{ label: `${b.short} no portal`, ref: `reguladores/${r.body}` }, { label: "Todos os reguladores", ref: "reguladores" }],
      fontes: [{ n: 1, label: `${b.short}, ${cleanName(r.ref || r.id)}`, url: r.url || r.source_url }],
    };
  };

  const artDeclaracao = (id) => {
    const r = Q1(pos, "SELECT * FROM decl WHERE id = ?", id);
    if (!r) return null;
    const same = r.coincide === 1;
    const par = [`No plenário de ${pdate(r.data_discurso)}, ${r.orador} (${r.partido}) declarou que o voto seria «${r.declarado}» na iniciativa ${r.ref}, «${cleanName(r.titulo)}».[^1]`,
      `Na ${String(r.fase || "votação").toLowerCase()} de ${pdate(r.data_voto)}, o sentido de voto registado foi «${r.voto}».[^2] ${same ? "A declaração e o voto coincidem." : "A declaração e o voto não coincidem."}`,
      `Excerto do discurso: «${cut(cleanName(r.citacao).replace(/^…\s*/, ""), 400)}»`];
    return {
      tipo: "declaracao", id: r.id, kicker: "Posições dos partidos", date: r.data_voto, hed: `${r.partido} declarou voto ${r.declarado} e votou ${r.voto}`, dek: cut(cleanName(r.titulo), 200), by: "Redação automática a partir do Diário da Assembleia da República e dos votos registados",
      paragraphs: par, pull: same ? `Declarou ${r.declarado}; votou ${r.voto}` : `Declarou ${r.declarado}, votou ${r.voto}`, charts: [], flags: [],
      stats: [["Partido", r.partido], ["Orador", r.orador], ["Declarado", r.declarado], ["Voto", r.voto], ["Iniciativa", r.ref]].filter((x) => x[1]),
      links: [{ label: "Posições dos partidos", ref: "posicoes" }, { label: "Todas as votações", ref: "votacoes" }],
      fontes: [{ n: 1, label: "Diário da Assembleia da República", url: r.source_url }, { n: 2, label: "Parlamento.pt, detalhe da iniciativa", url: r.voto_url }],
    };
  };

  const artNomeacao = (id) => {
    const r = Q1(resp, "SELECT * FROM nomeacoes WHERE id = ?", id);
    if (!r) return null;
    const role = cleanName(r.role);
    const par = [`${cleanName(r.person)} foi ${/exonera/i.test(r.action) ? "exonerado" : "nomeado"}${role ? `, ${role.charAt(0).toLowerCase() + role.slice(1)}` : ""}${r.entity ? `, em ${cleanName(r.entity)}` : ""}, em ato publicado a ${pdate(r.date)}.[^1]`];
    const same = r.entity_nif ? Q(resp, "SELECT person, role, date FROM nomeacoes WHERE entity_nif = ? AND id <> ? ORDER BY date DESC LIMIT 4", r.entity_nif, r.id) : [];
    if (same.length) par.push(`Outros atos recentes relativos à mesma entidade: ${list(same.map((x) => `${cleanName(x.person)} (${pshort(x.date)})`))}.`);
    return {
      tipo: "nomeacao", id: r.id, kicker: "Nomeação publicada", date: r.date, hed: `${cleanName(r.person)}: ${cut(role || cleanName(r.action), 150)}`, dek: r.entity ? cleanName(r.entity) : null, by: "Redação automática a partir do Diário da República",
      paragraphs: par, pull: null, charts: [], flags: [],
      stats: [["Pessoa", cleanName(r.person)], ["Ação", r.action], ["Cargo", role], ["Entidade", cleanName(r.entity || "")], ["Ato", cleanName(r.act || "")], ["Data", pdate(r.date)]].filter((x) => x[1]),
      links: [{ label: "Quem decide e nomeações", ref: "responsaveis" }],
      fontes: [{ n: 1, label: `Diário da República${r.act ? `, ${cleanName(r.act)}` : ""}`, url: r.source_url }],
    };
  };

  routes["/api/edicao/artigo"] = (q) => {
    const t = q.get("tipo"), id = q.get("id");
    if (!t && /^\d+$/.test(id || "")) return ledgerArticle(Number(id));
    const fn = { contrato: artContrato, voto: artVoto, relatorio: artRelatorio, ato: artAto, apoio: artApoio, entidade: artEntidade, regulador: artRegulador, declaracao: artDeclaracao, nomeacao: artNomeacao }[t];
    if (!fn || !id) return null;
    const a = fn(id);
    if (!a) return null;
    const rel = [];
    if (a.date && a.tipo !== "entidade") rel.push({ label: `Ver a edição de ${pdate(a.date)}`, ref: `edicao/${a.date}` });
    return { ...a, relacionados: rel, defaultData: todayStr() };
  };
}
