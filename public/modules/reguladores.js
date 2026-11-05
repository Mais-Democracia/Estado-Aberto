"use strict";
/* Módulo "reguladores": #/reguladores e #/reguladores/<slug>  (API: /api/reguladores/*) */
(() => {
  const { esc } = Portal;
  const link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const GRP = { regulador: "Regulador independente", supervisao: "Supervisão / garantia", inspecao: "Inspeção e fiscalização" };
  const KIND = {
    sancao: "Sanção", acusacao: "Acusação", decisao_judicial: "Decisão judicial", concentracao_nao_oposicao: "Concentração: não oposição",
    concentracao_oposicao: "Concentração: oposição", concentracao_notificada: "Concentração notificada", decisao_condicionada: "Decisão com condições",
    arquivamento: "Arquivamento", deliberacao: "Deliberação", parecer: "Parecer", diretriz: "Diretriz", regulamento: "Regulamento", contraordenacao: "Contraordenação",
  };
  const kl = (k) => KIND[k] || k;

  Portal.nav("Reguladores", "#/reguladores");

  // barras de coimas por ano (reutiliza as classes CSS do gráfico de barras do portal)
  function fbars(rows, label) {
    if (!rows.length) return '<p class="muted small">Sem valores de coimas publicados.</p>';
    const max = Math.max(1, ...rows.map((y) => y.value));
    return `<div class="barchart" role="img" aria-label="${esc(label)}">${rows.map((y) => `<div class="col" title="${y.year}: ${Portal.eurFull ? Portal.eurFull(y.value) : Portal.eur(y.value)} · ${y.n} decisões com coima">
      <div class="b" style="height:${Math.max(1, 130 * y.value / max)}px"></div><div class="lbl">${String(y.year).slice(2)}</div></div>`).join("")}</div>
      <div class="legend"><span><i style="background:var(--bar)"></i>${esc(label)}</span></div>`;
  }
  const hbar = (rows, key = "short") => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="small">${rows.map((r) => `<div style="display:flex;gap:.5rem;align-items:center;margin:.2rem 0"><span style="width:6rem">${esc(r[key])}</span>
      <span style="flex:1;background:var(--line,#ddd);border-radius:3px;height:.8rem"><i style="display:block;height:100%;width:${100 * r.value / max}%;background:var(--bar);border-radius:3px"></i></span><b style="width:6.5rem;text-align:right">${Portal.eur(r.value)}</b></div>`).join("")}</div>`;
  };
  const decRow = (showBody) => [
    { h: "Data", f: (r) => (r.date ? Portal.fmtDate(r.date) : esc(r.year || "—")) },
    ...(showBody ? [{ h: "Regulador", f: (r) => `<a href="#/reguladores/${esc(r.body)}">${esc(r.short)}</a>` }] : []),
    { h: "Tipo", f: (r) => `<span class="tag">${esc(kl(r.kind))}</span>` },
    { h: "Decisão", f: (r) => `${r.ref ? `<span class="small muted">${esc(r.ref)}</span><br>` : ""}${link(r.url || r.source_url, r.title)}${r.subject ? `<div class="small muted">${esc(r.subject)}</div>` : ""}` },
    { h: "Coima", num: 1, f: (r) => (r.amount ? `<span title="${esc(r.amount_note || "")}">${Portal.eur(r.amount)}</span>` : "—") },
  ];

  async function pageList(params) {
    const [ov, ls] = await Promise.all([Portal.api("reguladores/overview"), Portal.api("reguladores/lista")]);
    if (ov.error) { $app.innerHTML = `<div class="pagehead"><h1>Reguladores</h1></div><p class="note warn">${esc(ov.error)}</p>`; return; }
    const q = params.q || "", page = +params.page || 1;
    const dec = await Portal.api("reguladores/decisoes" + Portal.qs({ q, body: params.body, ano: params.ano, coima: params.coima, page }));
    const groups = ["regulador", "supervisao", "inspecao"];
    const href = (o) => `#/reguladores${Portal.qs({ q, body: params.body, ano: params.ano, coima: params.coima, ...o })}`;
    $app.innerHTML = `
      <div class="pagehead"><div><div class="kicker">Poder independente e supervisão</div><h1>Reguladores e autoridades de supervisão</h1>
        <div class="small muted">Missão, administração, decisões e coimas que cada autoridade publica, e a sua própria contratação pública.</div></div></div>
      <div class="kpis">
        <div class="kpi"><b>${ov.n_bodies}</b><span>organismos (${ov.n_matched} ligados ao registo por NIF)</span></div>
        <div class="kpi"><b>${ov.n_board}</b><span>membros em funções (mandatos ET)</span></div>
        <div class="kpi"><b>${Portal.int(ov.n_decisions)}</b><span>decisões/deliberações recolhidas</span></div>
        <div class="kpi"><b>${Portal.int(ov.n_fines)}</b><span>decisões com valor de coima lido do texto (sem total agregado)</span></div></div>
      ${groups.map((g) => { const items = ls.bodies.filter((b) => b.grp === g); return items.length ? `<h2>${GRP[g]}</h2><div class="grid">${items.map((b) => `<a class="card link" href="#/reguladores/${esc(b.slug)}">
        <div class="kicker">${esc(b.short)}</div><h3 style="margin:.2rem 0">${esc(b.name)}</h3>
        <div class="small">${b.leader ? `${esc(b.leader.role)} <b>${esc(b.leader.holder)}</b>${b.leader.begin_date ? ` <span class="muted">desde ${Portal.fmtDate(b.leader.begin_date)}</span>` : ""}` : '<span class="muted">sem titular na fonte</span>'}</div>
        <div class="small muted" style="margin-top:.4rem">${b.n_board} em funções · ${Portal.int(b.n_decisions)} decisões${b.n_fines ? ` · ${b.n_fines} com coima` : ""}</div>
        <div class="small">${b.contracts != null ? `<b>${Portal.eur(b.spend)}</b> contratados${b.direct_share != null ? ` · ${Portal.pct(100 * b.direct_share)} por ajuste direto` : ""}` : '<span class="muted">sem NIF no registo</span>'}</div>
        ${b.robots === "forbidden" ? `<div class="small"><span class="tag amber">acesso automático bloqueado</span></div>` : ""}</a>`).join("")}</div>` : ""; }).join("")}
      <section class="panel"><h2>Maiores coimas com valor lido (por decisão)</h2>
        ${Portal.table([{ h: "Data", f: (r) => (r.date ? Portal.fmtDate(r.date) : esc(r.year)) }, { h: "Regulador", f: (r) => `<a href="#/reguladores/${esc(r.body)}">${esc(r.short)}</a>` }, { h: "Decisão", f: (r) => `${link(r.url, r.title)}<div class="small muted">${esc(r.amount_note || "")}</div>` }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.amount) }], ov.top_fines)}
        <p class="note warn">Sem total agregado nem soma por ano: os valores são lidos automaticamente do texto de cada comunicado (só AdC e AMT) e o mesmo caso pode aparecer em várias fases (decisão, confirmação judicial). Cada valor tem a nota do que foi lido; os maiores foram conferidos à mão contra o texto integral. Onde não há valor, não foi publicado ou não foi lido.</p></section>
      <section class="panel"><h2>Pesquisar decisões</h2>
        <form class="small" onsubmit="event.preventDefault();location.hash='#/reguladores'+Portal.qs({q:this.q.value,body:this.body.value,ano:this.ano.value,coima:this.coima.checked?1:''});return false;" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem">
          <input name="q" value="${esc(q)}" placeholder="palavra, empresa, nº…" style="flex:1;min-width:12rem">
          <select name="body"><option value="">Todos os reguladores</option>${dec.bodies.map((b) => `<option value="${esc(b.slug)}" ${params.body === b.slug ? "selected" : ""}>${esc(b.short)} (${Portal.int(b.n)})</option>`).join("")}</select>
          <input name="ano" value="${esc(params.ano || "")}" placeholder="ano" size="4">
          <label><input type="checkbox" name="coima" ${params.coima ? "checked" : ""}> só com coima</label><button class="btn">Pesquisar</button></form>
        <p class="small muted">${Portal.int(dec.total)} resultados</p>${Portal.table(decRow(true), dec.rows)}${Portal.pager(dec.total, dec.page, dec.per, (p) => href({ page: p }))}</section>
      <details class="panel"><summary><b>O que está bloqueado / em falta</b></summary><ul>${(ls.blocked || []).map((b) => `<li><b>${esc(b.body === "*" ? "Todos" : b.body.toUpperCase())}</b> — ${esc(b.what)}: ${esc(b.reason)}</li>`).join("")}</ul></details>
      <p class="note">Fontes: sítios oficiais de cada regulador (só informação que publicam), Entidade para a Transparência (mandatos), Diário da República e Portal BASE. As coimas são as indicadas no texto da própria decisão/comunicado; um valor ausente significa «não publicado», não «zero». Nomes de pessoas singulares sancionadas não são mostrados.</p>`;
  }

  async function pageOne(slug, params) {
    const d = await Portal.api("reguladores/entidade" + Portal.qs({ slug }));
    if (d.error) { $app.innerHTML = `<div class="crumbs"><a href="#/reguladores">Reguladores</a></div><p class="note warn">${esc(d.error)}</p>`; return; }
    const b = d.body, sp = d.spend, t = sp ? sp.total : null;
    const act = d.board.filter((x) => x.active), past = d.board.filter((x) => !x.active);
        const dq = await Portal.api("reguladores/decisoes" + Portal.qs({ body: slug, q: params.q, ano: params.ano, page: params.page }));
    const href = (o) => `#/reguladores/${slug}${Portal.qs({ q: params.q, ano: params.ano, ...o })}`;
    const person = (m) => `<tr><td><b>${esc(m.holder)}</b></td><td>${esc(m.role || "")}</td><td>${m.begin_date ? Portal.fmtDate(m.begin_date) : "—"}</td><td>${m.end_date ? Portal.fmtDate(m.end_date) : "em funções"}</td><td>${link(m.source_url, "fonte")}</td></tr>`;
    $app.innerHTML = `
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/reguladores">Reguladores</a></div>
      <div class="pagehead"><div><div class="kicker">${esc(GRP[b.grp] || "")}</div><h1>${esc(b.name)}</h1>
        <div class="small muted">${link(b.site, b.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}${d.eid ? ` · <a href="#/entidade/${d.eid}">ficha no registo de entidades</a> (NIF ${esc(b.nif)})` : ""}</div></div></div>
      <section class="panel"><h2>Missão e enquadramento</h2><p>${esc(b.mission)}</p>
        ${b.law ? `<p class="small"><b>Criação / estatutos:</b> ${esc(b.law)}. <span class="muted">Referência indicada pelo portal; confirme no Diário da República.</span></p>` : '<p class="small muted">Lei orgânica: ver o sítio oficial e o Diário da República.</p>'}
        ${b.robots === "forbidden" ? `<p class="note warn">O servidor/robots.txt deste organismo não permite recolha automática (${esc(b.robots)}). Não foi recolhido nada do respetivo sítio.</p>` : ""}</section>
      <div class="kpis">
        <div class="kpi"><b>${act.length}</b><span>membros em funções</span></div>
        <div class="kpi"><b>${Portal.int(d.kinds.reduce((a, k) => a + k.n, 0))}</b><span>decisões recolhidas</span></div>
        <div class="kpi"><b>${Portal.int(d.kinds.reduce((a, k) => a + (k.n_fines || 0), 0))}</b><span>decisões com valor de coima lido</span></div>
        <div class="kpi"><b>${t ? Portal.eur(t.value) : "—"}</b><span>contratado${t ? ` (${Portal.int(t.n)} contratos${t.value ? ", " + Portal.pct(100 * t.direct_value / t.value) + " ajuste direto" : ""})` : " (sem NIF no registo)"}</span></div></div>
      <section class="panel"><h2>Administração</h2>
        ${act.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Nome</th><th>Cargo</th><th>Início</th><th>Fim do mandato</th><th></th></tr></thead><tbody>${act.map(person).join("")}</tbody></table></div>` : '<p class="muted">Sem mandatos em curso na Entidade para a Transparência.</p>'}
        ${past.length ? `<details><summary class="small">Mandatos anteriores (${past.length})</summary><div class="tblwrap"><table class="tbl"><tbody>${past.map(person).join("")}</tbody></table></div></details>` : ""}
        <p class="small muted">Fonte: mandatos declarados à Entidade para a Transparência; a data de fim de mandato indica o termo legal previsto, não a cessação efetiva.</p></section>
      ${d.dre.length ? `<section class="panel"><h2>Diário da República — atos relacionados</h2>${Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.date) }, { h: "Ato", f: (r) => `<span class="small muted">${esc(r.kind || "")} ${esc(r.number || "")}</span><br>${link(r.source_url, r.title)}` }], d.dre)}</section>` : ""}
      ${d.years.length ? `<div class="cols"><section class="panel"><h2>Decisões por ano</h2>${fbars(d.years.map((y) => ({ year: y.year, value: y.n, n: y.n })), "Decisões recolhidas")}</section>
        <section class="panel"><h2>Maiores coimas (por decisão)</h2>
        ${d.topFines.length ? Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Decisão", f: (r) => `${link(r.url, r.title.slice(0, 140))}<div class="small muted">${esc(r.amount_note || "")}</div>` }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.amount) }], d.topFines) + '<p class="small muted">Sem soma anual: valores lidos do texto de cada decisão; o mesmo caso pode surgir em várias fases.</p>' : '<p class="muted small">Sem valores de coimas lidos.</p>'}</section></div>` : ""}
      <section class="panel"><h2>Decisões e deliberações</h2>
        ${d.kinds.length ? `<p class="small">${d.kinds.map((k) => `<span class="tag">${esc(kl(k.kind))} ${Portal.int(k.n)}</span>`).join(" ")}</p>` : '<p class="muted">Este organismo não tem decisões recolhidas (ver abaixo o motivo).</p>'}
        ${dq.total || params.q || params.ano ? `<form class="small" onsubmit="event.preventDefault();location.hash='#/reguladores/${esc(slug)}'+Portal.qs({q:this.q.value,ano:this.ano.value});return false;" style="display:flex;gap:.5rem;margin:.6rem 0"><input name="q" value="${esc(params.q || "")}" placeholder="pesquisar" style="flex:1"><input name="ano" value="${esc(params.ano || "")}" placeholder="ano" size="4"><button class="btn">Filtrar</button></form>
        <p class="small muted">${Portal.int(dq.total)} resultados</p>${Portal.table(decRow(false), dq.rows)}${Portal.pager(dq.total, dq.page, dq.per, (p) => href({ page: p }))}` : ""}</section>
      ${t ? `<section class="panel"><h2>Contratação pública do organismo</h2>
        ${sp.years.length ? Portal.bars(sp.years) : ""}
        <div class="cols"><div><h3>Principais fornecedores</h3>${Portal.table([{ h: "Fornecedor", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name || r.nif)) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], d.suppliers)}</div>
        <div><h3>Procedimentos</h3>${Portal.table([{ h: "Procedimento", f: (r) => esc(r.procedure || "—") }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], d.procs)}</div></div>
        <p class="small muted">Contratos do Portal BASE em que o organismo (NIF ${esc(b.nif)}) é entidade adjudicante, desde 2012.</p></section>` : ""}
      ${d.blocked.length ? `<section class="panel"><h2>O que não foi possível recolher</h2><ul>${d.blocked.map((x) => `<li><b>${esc(x.what)}</b>: ${esc(x.reason)} ${x.url ? link(x.url, "página") : ""}</li>`).join("")}</ul></section>` : ""}`;
  }

  Portal.page("reguladores", async (arg, params) => { if (arg) await pageOne(arg, params || {}); else await pageList(params || {}); });

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.nif) return;
    const r = await Portal.api("reguladores/porNif" + Portal.qs({ nif: e.nif }));
    if (!r.body) return;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Regulador</h2><p><a href="#/reguladores/${esc(r.body.slug)}"><b>${esc(r.body.name)}</b></a>
      ${r.leader ? ` — ${esc(r.leader.role)} ${esc(r.leader.holder)}` : ""}</p>
      <p class="small muted">${Portal.int(r.n_decisions)} decisões recolhidas${r.n_fines ? ` · ${r.n_fines} com valor de coima lido` : ""}.</p></section>`);
  });
})();
