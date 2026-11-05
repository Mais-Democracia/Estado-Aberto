"use strict";
/* Quem decide — #/responsaveis (pesquisa), #/responsaveis/h<id> (titular), #/responsaveis/a<id> (gabinete), #/responsaveis/ligacoes.
   Dados: data/responsaveis.db (ingest/jobs/responsaveis.py). Fontes: Entidade para a Transparência (acesso público), CReSAP,
   portugal.gov.pt (nomeações para gabinetes), Portal BASE (contratos). */
(() => {
  const { esc, api, int, fmtDate, qs, table, eur } = Portal;
  const ext = (u, l) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
  const cresapLabel = (o) => (/proposta/.test(o || "") ? "lista de candidatos (3 finalistas)" : o || "");
  const d10 = (s) => (s ? fmtDate(s) : "");
  const period = (a, b) => (a || b ? `${d10(a) || "?"} → ${b ? d10(b) : "em curso"}` : "");
  const ET = "https://entidadetransparencia.pt/consultardeclaracaopublica";
  const css = `<style id="resp-css">
    .rs-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
    .rs-tabs a { text-decoration: none; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: .86rem; color: var(--ink); background: var(--card); }
    .rs-tabs a.on { background: var(--ink); color: var(--card); }
    .rs-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; align-items: center; }
    .rs-filters input[type=search] { flex: 1; min-width: 220px; } .rs-filters label { font-size: .86rem; white-space: nowrap; }
    .rs-sub { font-size: .82rem; color: var(--muted); margin-top: 2px; }
    .rs-link { border-left: 3px solid var(--accent); padding: 6px 10px; margin: 6px 0; background: var(--info-bg); border-radius: 0 6px 6px 0; font-size: .86rem; }
    .rs-neutral { font-size: .8rem; color: var(--muted); }
  </style>`;

  const NOTICE = `<p class="note" style="border-left:3px solid var(--accent)"><b>Nota:</b> as ligações mostradas são informação declarada pelos próprios titulares no registo oficial, cruzada com contratos públicos publicados. <b>Não constituem acusação</b> nem indicam irregularidade ou relação causal.</p>`;
  Portal.nav("Quem decide", "#/responsaveis");

  function banner(c) {
    if (!c || c.available === false) return `<p class="note warn"><b>Dados ainda não disponíveis.</b> ${esc((c && c.error) || "")}</p>`;
    const pctH = c.holders ? Math.round(100 * c.holders_checked / c.holders) : 0;
    return `<div class="note ${pctH < 100 ? "warn" : ""}"><b>O que cobre:</b>
      <ul style="margin:.3rem 0 .3rem 1.1rem;padding:0">
      <li><b>Cargos registados na Entidade para a Transparência</b> (administradores e gestores públicos, dirigentes superiores, membros do Governo, deputados, autarcas e outros titulares obrigados a declarar): <b>${int(c.mandates)}</b> mandatos de <b>${int(c.holders)}</b> pessoas em <b>${int(c.entities)}</b> entidades${c.first_begin ? `, de ${esc(c.first_begin.slice(0, 4))} a ${esc((c.last_begin || "").slice(0, 4))}` : ""}.</li>
      <li><b>Declarações – registo de interesses</b> (a parte pública: atividades e cargos, entidades associativas, apoios, serviços prestados, participações em sociedades): lidas para <b>${int(c.holders_checked)}</b> de ${int(c.holders)} titulares (${pctH}%) — ${int(c.declarations_detailed)} declarações publicadas, <b>${int(c.interests)}</b> linhas de interesses de <b>${int(c.holders_with_interests)}</b> titulares; ${int(c.interests_nif)} com NIF de sociedade válido.</li>
      <li><b>Gabinetes ministeriais</b> (portugal.gov.pt, com despacho do DR): ${int(c.appointments)} nomeações. <b>CReSAP</b>: ${int(c.cresap)} procedimentos concursais de dirigentes superiores (sem os nomes dos designados).</li>
      <li><b>Ligações declaradas</b> a contratos públicos: ${int(c.links)} (só sociedades com NIF indicado na declaração).</li></ul>
      <b>O que não cobre:</b> nomeações publicadas só em Diário da República série II (despachos); o rendimento e o património declarados (acesso restrito, não recolhidos); sociedades declaradas sem NIF (guardadas só pelo nome, sem ligação a contratos); titulares ainda não lidos${pctH < 100 ? " (a leitura é feita por lotes, dos cargos atuais para os mais antigos)" : ""}.
      ${(c.blocked || []).length ? `<details style="margin-top:.4rem"><summary>Fontes bloqueadas ou não usadas</summary><ul>${c.blocked.map((b) => `<li><b>${esc(b.source)}</b>: ${esc(b.reason)}</li>`).join("")}</ul></details>` : ""}
      <div class="small muted" style="margin-top:.3rem">Contagens atualizadas em ${esc((c.as_of || "").replace("T", " ").slice(0, 16))} (UTC; instantâneo renovado de 5 em 5 minutos, a leitura de declarações continua em segundo plano). As ligações declaradas descrevem o que o próprio titular indicou no registo oficial; não implicam irregularidade nem relação causal.</div></div>`;
  }

  function tabs(p, counts) {
    const t = (k, label, n) => `<a class="${(p.kind || "mandates") === k ? "on" : ""}" href="#/responsaveis${qs({ ...p, kind: k === "mandates" ? "" : k, page: 1 })}">${label}${n != null ? ` (${int(n)})` : ""}</a>`;
    return `<div class="rs-tabs">${t("mandates", "Cargos e declarações", counts.mandates)}${t("gabinete", "Gabinetes ministeriais", counts.gabinete)}${t("cresap", "Concursos CReSAP", counts.cresap)}<a href="#/responsaveis/nomeacoes">Nomeações recentes</a><a href="#/responsaveis/ligacoes">Ligações declaradas</a></div>`;
  }

  async function pageSearch(p) {
    const page = Math.max(+p.page || 1, 1), limit = 40, kind = p.kind || "mandates";
    const [cov, d, fac] = await Promise.all([api("responsaveis/coverage"), api("responsaveis/search" + qs({ q: p.q, role: p.role, body: p.body, kind, active: p.active, interests: p.interests, limit, offset: (page - 1) * limit })), api("responsaveis/facets")]);
    const link = (o) => `#/responsaveis${qs({ ...p, ...o })}`;
    let body = "";
    if (d.available === false) body = "";
    else if (kind === "mandates") {
      body = table([
        { h: "Pessoa", f: (r) => `<a href="#/responsaveis/h${r.id}">${esc(r.name)}</a><div class="rs-sub">${r.n_active ? `${r.n_active} cargo(s) em curso` : "sem cargo em curso"} · ${r.n_mandates} mandato(s)</div>` },
        { h: "Cargo e entidade", f: (r) => r.mandates.map((m) => `<div>${esc(m.role)} — ${m.entity_nif ? `<a href="#/entidades?q=${esc(m.entity_nif)}">${esc(m.entity)}</a>` : esc(m.entity)}${m.board ? ` <span class="rs-sub">(${esc(m.board)})</span>` : ""}<div class="rs-sub">${esc(period(m.begin, m.end))}</div></div>`).join("") },
        { h: "Declarações", num: 1, f: (r) => (r.interests ? `<span class="tag blue">${r.interests} interesse(s)</span>` : '<span class="muted small">—</span>') + (r.links ? `<br><span class="tag amber">${r.links} ligação(ões)</span>` : "") },
      ], d.results);
    } else if (kind === "gabinete") {
      body = table([
        { h: "Nome", f: (r) => `<a href="#/responsaveis/a${r.id}">${esc(r.person)}</a>` }, { h: "Função", f: (r) => esc(r.role || "") },
        { h: "Gabinete", f: (r) => `<span class="small">${esc(r.organ || "")}</span>` }, { h: "Ato (DR)", f: (r) => esc(r.act || "") }, { h: "Fonte", f: (r) => ext(r.source_url, "portugal.gov.pt") },
      ], d.results);
    } else {
      body = table([
        { h: "Concurso", f: (r) => `<span class="small">${esc(r.code)}</span>` }, { h: "Cargo", f: (r) => esc(r.role) },
        { h: "Entidade", f: (r) => (r.entity_nif ? `<a href="#/entidades?q=${esc(r.entity_nif)}">${esc(r.entity)}</a>` : esc(r.entity)) }, { h: "Estado", f: (r) => `<span class="tag">${esc(r.status)}</span>` },
        { h: "Documentos", f: (r) => [ext(r.proposal_url, "proposta"), r.despacho_url && r.despacho_url !== r.proposal_url ? ext(r.despacho_url, "despacho") : "", ext(r.item_url, "ficha")].filter(Boolean).join(" · ") },
      ], d.results);
    }
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / Quem decide</div>
      <div class="pagehead"><div><div class="kicker">Transparência</div><h1>Quem decide</h1>
        <p class="lead">Quem ocupa cargos de responsabilidade no Estado — administradores, dirigentes, governantes, assessores de gabinete — e o que declararam publicamente: atividades, cargos e participações em empresas.</p></div></div>
      ${banner(cov)}
      ${NOTICE}
      ${d.available === false ? "" : `${tabs(p, d.counts || {})}
      <form class="rs-filters" id="rsf">
        <input type="search" name="q" placeholder="Pessoa, organização ou cargo" value="${esc(p.q || "")}">
        <input type="search" name="role" list="rs-roles" placeholder="Cargo (ex.: Presidente)" value="${esc(p.role || "")}" style="max-width:200px;min-width:140px;flex:0 1 200px">
        <datalist id="rs-roles">${(fac.roles || []).map((r) => `<option value="${esc(r.role)}">`).join("")}</datalist>
        <input type="search" name="body" placeholder="Organismo" value="${esc(p.body || "")}" style="max-width:220px;min-width:140px;flex:0 1 220px">
        ${kind === "mandates" ? `<label><input type="checkbox" name="active" value="1" ${p.active === "1" ? "checked" : ""}> em funções</label><label><input type="checkbox" name="interests" value="1" ${p.interests === "1" ? "checked" : ""}> com interesses declarados</label>` : ""}
        <button class="btn" type="submit">Pesquisar</button></form>
      <p class="small muted">${int(d.total || 0)} resultado(s).</p>
      <div class="panel" style="padding:0">${body}</div>
      ${Portal.pager(d.total || 0, page, limit, (n) => link({ page: n }))}`}`;
    const f = $("#rsf");
    if (f) f.onsubmit = (e) => { e.preventDefault(); const fd = new FormData(f); location.hash = `#/responsaveis${qs({ q: fd.get("q"), role: fd.get("role"), body: fd.get("body"), active: fd.get("active"), interests: fd.get("interests"), kind: p.kind })}`; };
  }

  function interestRow(l, ents) {
    const e = l.company_nif && ents[l.company_nif];
    const co = l.company ? (e ? `<a href="#/entidade/${e.id}">${esc(l.company)}</a>` : esc(l.company)) : "";
    const nif = l.company_nif ? `<span class="rs-sub">NIF ${esc(l.company_nif)}</span>` : l.company ? '<span class="rs-sub">sem NIF na declaração (não ligada a contratos)</span>' : "";
    const lnk = l.n_contracts && l.section === "sociedade" ? `<div class="rs-link"><b>Ligação declarada:</b> esta entidade consta como adjudicatária em <b>${int(l.n_contracts)}</b> contrato(s) públicos (${eur(l.total)}, ${esc((l.first_signed || "").slice(0, 4))}–${esc((l.last_signed || "").slice(0, 4))})${l.n_in_period != null && (l.start_date || l.end_date) ? `; ${int(l.n_in_period)} assinado(s) no período declarado` : ""}${l.n_with_own_entity ? `; ${int(l.n_with_own_entity)} com a própria entidade onde o titular exerce/exerceu funções (${eur(l.total_with_own_entity)})` : ""}. <a href="#/contratos?seller=${esc(l.company_nif)}">ver contratos →</a><div class="rs-neutral">Informação cruzada de duas fontes oficiais; não indica irregularidade.</div></div>` : "";
    return `<tr><td>${esc(l.role || "")}${l.section === "sociedade" && l.role ? "" : ""}</td><td>${co}${nif}${lnk}</td>
      <td class="small">${esc(l.nature || "")}</td><td class="small">${esc(period(l.start_date, l.end_date))}</td>
      <td class="small muted">${esc((l.declared_in || []).filter((x, i, a) => a.indexOf(x) === i).join(", "))}</td></tr>`;
  }

  async function pageHolder(id) {
    const d = await api("responsaveis/person?id=" + encodeURIComponent(id));
    if (d.error || d.available === false) { $app.innerHTML = `${css}<div class="crumbs"><a href="#/responsaveis">Quem decide</a></div><p class="note warn">${esc(d.error || "Sem dados")}</p>`; return; }
    if (d.kind === "gabinete") {
      $app.innerHTML = `${css}<div class="crumbs"><a href="#/">Início</a> / <a href="#/responsaveis?kind=gabinete">Quem decide</a></div>
        <div class="pagehead"><div><div class="kicker">Gabinete ministerial</div><h1>${esc(d.name)}</h1></div></div>
        <section class="panel"><h2>Nomeações</h2>${table([{ h: "Função", f: (r) => esc(r.role || "") }, { h: "Gabinete", f: (r) => esc(r.organ || "") }, { h: "Desde", f: (r) => d10(r.start) }, { h: "Ato", f: (r) => esc(r.act || "") }, { h: "Fonte", f: (r) => ext(r.source_url, "portugal.gov.pt") }], d.appointments)}</section>
        ${d.same_name_in_et.length ? `<section class="panel"><h2>Nome idêntico no registo da Entidade para a Transparência</h2><p class="small muted">${esc(d.note)}</p>${table([{ h: "Cargo", f: (r) => esc(r.role) }, { h: "Entidade", f: (r) => esc(r.entity) }, { h: "Período", f: (r) => esc(period(r.begin, r.end)) }, { h: "", f: (r) => `<a href="#/responsaveis/h${r.holder_id}">ver →</a>` }], d.same_name_in_et)}</section>` : ""}`;
      return;
    }
    const secs = Object.entries(d.sections);
    const nInt = secs.reduce((a, [, v]) => a + v.length, 0);
    const nLinks = secs.reduce((a, [, v]) => a + v.filter((x) => x.n_contracts).length, 0);
    const ndet = d.declarations.filter((x) => x.detail_at).length;
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/responsaveis">Quem decide</a></div>
      <div class="pagehead"><div><div class="kicker">Titular de cargo · registo público</div><h1>${esc(d.name)}</h1>
        <div class="small muted">${d.mandates.length} mandato(s) · ${d.declarations.length} declaração(ões) · fonte ${ext(ET, "Entidade para a Transparência")}</div></div></div>
      ${NOTICE}
      <div class="kpis"><div class="kpi"><b>${d.mandates.filter((m) => !m.end_date || m.end_date >= new Date().toISOString().slice(0, 10)).length}</b><span>cargos em curso</span></div>
        <div class="kpi"><b>${nInt}</b><span>interesses declarados</span></div><div class="kpi"><b>${nLinks}</b><span>ligações declaradas a contratos</span></div></div>
      <section class="panel"><h2>Cargos</h2>${table([{ h: "Cargo", f: (r) => esc(r.role) }, { h: "Entidade", f: (r) => (r.entity_nif ? `<a href="#/entidades?q=${esc(r.entity_nif)}">${esc(r.entity)}</a>` : esc(r.entity)) },
        { h: "Órgão", f: (r) => esc(r.board || "") }, { h: "Período", f: (r) => esc(period(r.begin_date, r.end_date)) }], d.mandates)}</section>
      ${d.appointments && d.appointments.length ? `<section class="panel"><h2>Gabinetes (nome idêntico)</h2>${table([{ h: "Função", f: (r) => esc(r.role || "") }, { h: "Gabinete", f: (r) => esc(r.organ || "") }, { h: "Ato", f: (r) => esc(r.act || "") }], d.appointments)}<p class="small muted">Correspondência apenas por nome completo idêntico.</p></section>` : ""}
      <section class="panel"><h2>Registo de interesses declarado</h2>
        ${ndet ? `<p class="small muted">Linhas do registo de interesses (parte pública da declaração única) em ${ndet} declaração(ões) publicada(s); linhas repetidas em declarações sucessivas aparecem uma vez, com os anos em que constam. Não se mostram dados pessoais, rendimentos, património, valores de participações nem relações familiares; itens declarados em nome de familiares não são recolhidos.</p>` :
          `<p class="note">${d.holder_checked_at ? "Sem declaração publicada com registo de interesses para este titular." : "As declarações deste titular ainda não foram lidas (leitura por lotes)."} ${ext(ET, "Consultar na Entidade para a Transparência")}</p>`}
        ${secs.map(([k, rows]) => `<h3 style="margin:1rem 0 .3rem">${esc(d.section_labels[k] || k)}</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>${k === "sociedade" ? "Objeto" : "Cargo / descrição"}</th><th>Entidade / sociedade</th><th>Natureza</th><th>Período</th><th>Declarado no registo oficial (ano)</th></tr></thead><tbody>${rows.map((l) => interestRow(l, d.entities)).join("")}</tbody></table></div>`).join("")}</section>
      <section class="panel"><h2>Declarações entregues</h2>${table([{ h: "Ano", f: (r) => esc(r.year) }, { h: "Natureza", f: (r) => esc(r.nature || "") }, { h: "Cargo", f: (r) => esc(r.role || "") }, { h: "Entidade", f: (r) => esc(r.entity || "") }, { h: "Entregue", f: (r) => d10(r.delivery_date) }, { h: "Interesses", num: 1, f: (r) => (r.detail_at ? int(r.n_interests) : "—") }], d.declarations)}
        <p class="small muted">Fonte: ${ext(ET, "acesso público da Entidade para a Transparência")} (separador “Registo de interesses” das declarações com estado Publicada).</p></section>`;
  }

  async function pageNomeacoes(p) {
    const page = Math.max(+p.page || 1, 1), limit = 40;
    const d = await api("responsaveis/nomeacoes" + qs({ q: p.q, year: p.year, action: p.action, limit, offset: (page - 1) * limit }));
    const link = (o) => `#/responsaveis/nomeacoes${qs({ ...p, ...o })}`;
    if (d.available === false) { $app.innerHTML = `${css}<p class="note warn">${esc(d.error || "Dados ainda não disponíveis.")}</p>`; return; }
    const sel = (name, val, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(val || "") === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const kind = { "nomeação": "blue", "designação": "blue", "exoneração": "amber" };
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/responsaveis">Quem decide</a> / Nomeações recentes</div>
      <div class="pagehead"><div><div class="kicker">Diário da República</div><h1>Nomeações recentes</h1>
        <p class="lead">Nomeações, designações e exonerações publicadas na série I do Diário da República (resoluções do Conselho de Ministros e decretos do Presidente da República).</p></div></div>
      <p class="note">${esc(d.note || "")} Não inclui despachos da série II nem nomeações para gabinetes (separador próprio). A ligação à entidade só existe quando o nome coincide exatamente com uma entidade registada; sem ligação, a entidade não é mostrada.</p>
      <div class="rs-tabs"><a href="#/responsaveis">← Pesquisa</a></div>
      <form class="rs-filters" id="rsn"><input type="search" name="q" placeholder="Pessoa, cargo ou entidade" value="${esc(p.q || "")}">
        ${sel("year", p.year, [["", "Todos os anos"], ...(d.years || []).map((y) => [y, y])])}
        ${sel("action", p.action, [["", "Nomeação e exoneração"], ["nomeação", "Nomeações"], ["designação", "Designações (gestores)"], ["exoneração", "Exonerações"]])}
        <button class="btn" type="submit">Filtrar</button></form>
      <p class="small muted">${int(d.total)} ato(s) individual(is).</p>
      <div class="panel" style="padding:0">${d.total ? table([
        { h: "Data", f: (r) => esc(d10(r.date)) },
        { h: "Tipo", f: (r) => `<span class="tag ${kind[r.action] || ""}">${esc(r.action)}</span>` },
        { h: "Pessoa", f: (r) => esc(r.person) },
        { h: "Cargo", f: (r) => esc(r.role || "—") },
        { h: "Entidade", f: (r) => (r.entity_nif ? `<a href="#/entidades?q=${esc(r.entity_nif)}">${esc(r.entity)}</a>` : r.entity ? esc(r.entity) : '<span class="muted small">—</span>') },
        { h: "Fonte (DRE)", f: (r) => `${ext(r.source_url, r.act || "DRE")}` },
      ], d.results) : '<p class="muted" style="padding:1rem">Nenhuma nomeação encontrada para estes filtros.</p>'}</div>
      ${Portal.pager(d.total, page, limit, (n) => link({ page: n }))}
      <section class="panel" style="margin-top:1rem"><h2>Propostas de designação da CReSAP</h2>
        <p class="note warn"><b>Lista de candidatos, não designação.</b> A CReSAP propõe ao Governo uma lista de três finalistas por concurso (ordem alfabética); a designação final é do Governo e pode recair em qualquer um deles. Estas linhas <b>não indicam quem foi nomeado</b>.</p>
        ${d.cresap_total ? `<p class="small muted">${int(d.cresap_total)} candidatura(s) finalista(s) em propostas; as ${int(d.cresap_results.length)} mais recentes.</p>${table([
          { h: "Data", f: (r) => esc(d10(r.date) || "—") }, { h: "Cargo", f: (r) => esc(r.role) },
          { h: "Entidade", f: (r) => (r.entity_nif ? `<a href="#/entidades?q=${esc(r.entity_nif)}">${esc(r.entity)}</a>` : esc(r.entity || "")) },
          { h: "Finalista", f: (r) => esc(r.candidate || "—") }, { h: "Tipo", f: (r) => `<span class="small">${esc(cresapLabel(r.outcome))}</span>` },
          { h: "Fonte", f: (r) => ext(r.pdf_url, "CReSAP") }], d.cresap_results)}` : '<p class="muted small">Sem propostas da CReSAP carregadas.</p>'}</section>`;
    const f = $("#rsn");
    if (f) f.onsubmit = (e) => { e.preventDefault(); const fd = new FormData(f); location.hash = link({ q: fd.get("q"), year: fd.get("year"), action: fd.get("action"), page: 1 }); };
  }

  async function pageLinks(p) {
    const page = Math.max(+p.page || 1, 1), limit = 40;
    const d = await api("responsaveis/links" + qs({ q: p.q, all: p.all, limit, offset: (page - 1) * limit }));
    const link = (o) => `#/responsaveis/ligacoes${qs({ ...p, ...o })}`;
    if (d.available === false) { $app.innerHTML = `${css}<p class="note warn">${esc(d.error)}</p>`; return; }
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/responsaveis">Quem decide</a> / Ligações declaradas</div>
      <div class="pagehead"><div><div class="kicker">Cruzamento de fontes oficiais</div><h1>Ligações declaradas</h1>
        <p class="lead">Sociedades onde um titular de cargo declarou, no registo de interesses, uma atividade, cargo ou participação — e que figuram como adjudicatárias de contratos públicos no Portal BASE.</p></div></div>
      ${NOTICE}
      <p class="note">${esc(d.note)} Por omissão só se listam participações ou cargos em <b>sociedades comerciais</b> (ordem alfabética, sem classificação por valor); só entram sociedades com NIF indicado na declaração.</p>
      <div class="rs-tabs"><a href="#/responsaveis">← Pesquisa</a></div>
      <form class="rs-filters" id="rsl"><input type="search" name="q" placeholder="Pessoa, sociedade ou cargo" value="${esc(p.q || "")}"><label><input type="checkbox" name="all" value="1" ${p.all === "1" ? "checked" : ""}> incluir outras atividades e cargos declarados (associações, entidades públicas, outras funções)</label><button class="btn" type="submit">Filtrar</button></form>
      <p class="small muted">${int(d.total)} ligação(ões).</p>
      <div class="panel" style="padding:0">${table([
        { h: "Titular", f: (r) => `<a href="#/responsaveis/h${r.holder_id}">${esc(r.holder)}</a><div class="rs-sub">${esc(r.office || "")}</div>` },
        { h: "Interesse declarado", f: (r) => `${esc(r.role || r.section)}<div class="rs-sub">${[period(r.start_date, r.end_date), r.declared_on ? "declarado no registo oficial em " + fmtDate(r.declared_on) : ""].filter(Boolean).map(esc).join(" · ")}</div>` },
        { h: "Sociedade", f: (r) => { const e = d.entities[r.company_nif]; return `${e ? `<a href="#/entidade/${e.id}">${esc(r.company)}</a>` : esc(r.company)}<div class="rs-sub">NIF ${esc(r.company_nif)}</div>`; } },
        { h: "Contratos", num: 1, f: (r) => `${int(r.n_contracts)}${r.start_date || r.end_date ? `<div class="rs-sub">${int(r.n_in_period)} no período</div>` : ""}` },
        { h: "Valor", num: 1, f: (r) => `${eur(r.total)}${r.n_with_own_entity ? `<div class="rs-sub">${eur(r.total_with_own_entity)} com a própria entidade</div>` : ""}` },
      ], d.results)}</div>
      ${Portal.pager(d.total, page, limit, (n) => link({ page: n }))}`;
    const f = $("#rsl"); if (f) f.onsubmit = (e) => { e.preventDefault(); { const fd = new FormData(f); location.hash = link({ q: fd.get("q"), all: fd.get("all"), page: 1 }); } };
  }

  Portal.page("responsaveis", async (arg, p) => {
    p = p || {};
    if (arg === "ligacoes") return pageLinks(p);
    if (arg === "nomeacoes") return pageNomeacoes(p);
    if (arg && /^[ha]\d+$/.test(arg)) return pageHolder(arg[0] === "a" ? arg : arg.slice(1));
    return pageSearch(p);
  });

  // entity pages: dirigentes e administradores + titulares com interesses declarados nesta sociedade
  Portal.entityHooks.push(async (data, el) => {
    const nif = data && data.entity && data.entity.nif;
    if (!nif || !el) return;
    const d = await api("responsaveis/entity?nif=" + encodeURIComponent(nif));
    if (!d || d.available === false || (!d.mandates.length && !d.interested.length && !d.cresap.length && !(d.nomeacoes || []).length && !(d.cresap_results || []).length)) return;
    const t = new Date().toISOString().slice(0, 10);
    const cur = d.mandates.filter((m) => !m.end_date || m.end_date >= t), past = d.mandates.filter((m) => m.end_date && m.end_date < t);
    const row = (m) => ({ h: "", m });
    const tbl = (rows) => table([{ h: "Cargo", f: (m) => esc(m.role) }, { h: "Pessoa", f: (m) => `<a href="#/responsaveis/h${m.holder_id}">${esc(m.holder)}</a>` }, { h: "Órgão", f: (m) => esc(m.board || "") }, { h: "Período", f: (m) => esc(period(m.begin_date, m.end_date)) }], rows);
    el.insertAdjacentHTML("beforeend", `${document.getElementById("resp-css") ? "" : css}<section class="panel"><h2>Dirigentes e administradores</h2>${NOTICE}
      ${cur.length ? `<h3 style="margin:.2rem 0">Em funções (${cur.length})</h3>${tbl(cur)}` : '<p class="muted small">Sem cargos em curso no registo.</p>'}
      ${past.length ? `<details style="margin-top:.6rem"><summary>Anteriores (${past.length})</summary>${tbl(past)}</details>` : ""}
      ${d.mandates.length ? `<p class="small muted">Fonte: ${ext(ET, "Entidade para a Transparência")} — associação da entidade ao NIF por nome exato e único no registo de entidades.</p>` : ""}
      ${d.interested.length ? `<h3 style="margin:1rem 0 .2rem">Titulares que declararam um interesse nesta entidade</h3>${table([{ h: "Titular", f: (r) => `<a href="#/responsaveis/h${r.holder_id}">${esc(r.holder)}</a><div class="rs-sub">${esc(r.holder_role || "")} — ${esc(r.holder_entity || "")}</div>` },
        { h: "Interesse declarado", f: (r) => `${esc(r.role || r.section)}<div class="rs-sub">${[period(r.start_date, r.end_date), r.declared_on ? "declarado no registo oficial em " + fmtDate(r.declared_on) : ""].filter(Boolean).map(esc).join(" · ")}</div>` },
        { h: "Declaração", f: (r) => esc(r.year) }], d.interested)}<p class="rs-neutral">Ligação declarada pelo próprio titular no registo de interesses oficial; não implica irregularidade.</p>` : ""}
      ${d.cresap.length ? `<h3 style="margin:1rem 0 .2rem">Concursos CReSAP</h3>${table([{ h: "Concurso", f: (r) => `<span class="small">${esc(r.code)}</span>` }, { h: "Cargo", f: (r) => esc(r.role) }, { h: "Estado", f: (r) => esc(r.status) }, { h: "Documentos", f: (r) => [ext(r.proposal_url, "proposta"), ext(r.item_url, "ficha")].filter(Boolean).join(" · ") }], d.cresap)}` : ""}
      <h3 style="margin:1rem 0 .2rem">Histórico de nomeações e propostas</h3>
      ${(d.nomeacoes || []).length ? `<h4 style="margin:.4rem 0">Nomeações e exonerações no Diário da República</h4>${table([{ h: "Data", f: (r) => esc(d10(r.date)) }, { h: "Tipo", f: (r) => esc(r.action) }, { h: "Pessoa", f: (r) => esc(r.person) }, { h: "Cargo", f: (r) => esc(r.role || "—") }, { h: "Fonte", f: (r) => ext(r.source_url, r.act || "DRE") }], d.nomeacoes)}` : '<p class="muted small">Sem nomeações ou exonerações desta entidade na série I do Diário da República (cobertura parcial: só ligações por nome exato).</p>'}
      ${(d.cresap_results || []).length ? `<h4 style="margin:.8rem 0 .2rem">Propostas da CReSAP</h4><p class="note warn small"><b>Lista de candidatos (3 finalistas), não designação final.</b> A escolha é do Governo; estas linhas não dizem quem ocupou o cargo.</p>${table([{ h: "Data", f: (r) => esc(d10(r.date) || "—") }, { h: "Cargo", f: (r) => esc(r.role) }, { h: "Finalista", f: (r) => esc(r.candidate || "—") }, { h: "Natureza", f: (r) => `<span class="small">${esc(cresapLabel(r.outcome))}</span>` }, { h: "Fonte", f: (r) => ext(r.pdf_url, "CReSAP") }], d.cresap_results)}` : ""}
      </section>`);
  });
})();
