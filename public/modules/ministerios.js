"use strict";
/* Módulo "ministerios": #/ministerios e #/ministerios/<slug>  (API: /api/ministerios/*) */
(() => {
  const { esc } = Portal;
  const link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const METHOD = { regra: "regra por nome/sector", wikidata: "Wikidata" };
  const KIND_LABEL = { ministro: "Ministro(a)", secretario_estado: "Secretário(a) de Estado", gabinete: "Gabinete" };

  Portal.nav("Ministérios", "#/ministerios");

  async function pageList() {
    const d = await Portal.api("ministerios/list");
    const ms = d.ministries || [];
    const tot = ms.reduce((a, m) => a + m.spend, 0);
    $app.innerHTML = `
      <div class="pagehead"><div><div class="kicker">XXV Governo Constitucional</div><h1>Ministérios</h1>
        <div class="small muted">O que faz cada ministério e o que tutela: liderança, organismos tutelados, decisões do Conselho de Ministros e contratação pública.</div></div></div>
      ${d.error ? `<p class="note warn">${esc(d.error)}</p>` : ""}
      <div class="kpis">
        <div class="kpi"><b>${ms.length}</b><span>ministérios</span></div>
        <div class="kpi"><b>${Portal.int(d.matched)}</b><span>organismos tutelados identificados</span></div>
        <div class="kpi"><b>${Portal.eur(tot)}</b><span>contratado pelos organismos (2012–hoje)</span></div>
        <div class="kpi"><b>${Portal.int(ms.reduce((a, m) => a + m.n_decisions, 0))}</b><span>decisões do Conselho de Ministros</span></div></div>
      <div class="grid">${ms.map((m) => `<a class="card link" href="#/ministerios/${esc(m.slug)}">
        <div class="kicker">${esc(m.short)}</div><h3 style="margin:.2rem 0">${esc(m.name)}</h3>
        <div>${m.minister ? `${esc(m.minister_role || "Ministro(a)")} <b>${esc(m.minister)}</b>` : '<span class="muted">sem titular na fonte</span>'}</div>
        <div class="small muted" style="margin-top:.5rem">${Portal.int(m.n_secretaries)} secretários de Estado · ${Portal.int(m.n_bodies)} organismos tutelados</div>
        <div class="small"><b>${Portal.eur(m.spend)}</b> contratados${m.direct_share != null ? ` · ${Portal.pct(100 * m.direct_share)} por ajuste direto` : ""}</div></a>`).join("")}</div>
      <p class="note">A lista de organismos tutelados é construída por <b>regras sobre o nome e o sector</b> aplicadas ao registo de entidades públicas (e por ligações do Wikidata) — não é uma extração das leis orgânicas. Cada organismo indica a base da atribuição. Os valores são o preço contratual dos contratos publicados no Portal BASE onde o organismo é entidade adjudicante.</p>
      ${(d.blocked || []).length ? `<details class="panel"><summary><b>O que está bloqueado / em falta</b></summary><ul>${d.blocked.map((b) => `<li><b>${esc(b.source)}</b>: ${esc(b.reason)}</li>`).join("")}</ul></details>` : ""}`;
  }

  async function pageOne(slug) {
    const d = await Portal.api("ministerios/ministerio?slug=" + encodeURIComponent(slug));
    if (d.error) { $app.innerHTML = `<div class="crumbs"><a href="#/ministerios">Ministérios</a></div><p class="note warn">${esc(d.error)}</p>`; return; }
    const m = d.ministry, sp = d.spend, t = sp.total;
    const lead = d.people.filter((p) => p.kind !== "gabinete");
    const cab = d.people.filter((p) => p.kind === "gabinete");
    const cabUnits = [...new Set(cab.map((p) => p.unit))];
    const chiefs = cab.filter((p) => /chefe do gabinete/i.test(p.role || ""));
    const todayEv = new Date().toISOString().slice(0, 10);
    $app.innerHTML = `
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/ministerios">Ministérios</a></div>
      <div class="pagehead"><div><div class="kicker">Ministério · XXV Governo</div><h1>${esc(m.name)}</h1>
        <div class="small muted">${m.minister ? `${esc(m.minister_role || "Ministro(a)")} ${esc(m.minister)}${m.since ? ` desde ${Portal.fmtDate(m.since)}` : ""}` : ""} · ${link(m.url, "portugal.gov.pt")}</div></div></div>
      ${d.alt ? `<p class="note warn"><b>${esc(d.alt.text)}</b>. Mostra-se o nome apoiado pela evidência mais recente; verifique no Diário da República.</p>` : ""}
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(d.totalBodies)}</b><span>organismos tutelados</span></div>
        <div class="kpi"><b>${Portal.eur(t.value)}</b><span>contratado (${Portal.int(t.n)} contratos)</span></div>
        <div class="kpi"><b>${t.value ? Portal.pct(100 * t.direct_value / t.value) : "—"}</b><span>do valor por ajuste direto</span></div>
        <div class="kpi"><b>${Portal.int(d.decisions.length)}${d.decisions.length >= 25 ? "+" : ""}</b><span>decisões recentes do CM</span></div></div>

      <section class="panel"><h2>Liderança</h2>
        ${Portal.table([{ h: "Cargo", f: (r) => esc(r.role || KIND_LABEL[r.kind]) }, { h: "Nome", f: (r) => `<b>${esc(r.name)}</b>` }, { h: "Área", f: (r) => esc(r.portfolio || "") },
          { h: "Desde", f: (r) => Portal.fmtDate(r.start) }, { h: "Contacto", f: (r) => (r.email ? `<span class="small">${esc(r.email)}</span>` : "") }, { h: "Fonte", f: (r) => link(r.source_url, "portugal.gov.pt") }], lead)}
        ${m.address ? `<p class="small muted">${esc(m.address)}</p>` : ""}</section>

      <section class="panel"><h2>Gabinetes (chefes de gabinete e adjuntos)</h2>
        ${cab.length ? `<p class="small muted">Nomeações publicadas pelo Governo com o despacho do Diário da República; ${cab.length} pessoas em ${cabUnits.length} ${cabUnits.length === 1 ? "gabinete" : "gabinetes"}. Chefes de gabinete: ${chiefs.map((c) => `<b>${esc(c.name)}</b> (${esc((c.unit || "").replace(/^Gabinete d[aoe]s? /i, ""))})`).join("; ") || "—"}.</p>
        <details><summary>Ver todos os membros dos gabinetes</summary>${Portal.table([{ h: "Gabinete", f: (r) => `<span class="small">${esc(r.unit || "")}</span>` }, { h: "Função", f: (r) => esc(r.role || "") }, { h: "Nome", f: (r) => esc(r.name) },
          { h: "Remuneração bruta", num: 1, f: (r) => esc(r.gross || "") }, { h: "Nomeação", f: (r) => esc(r.start || "") }, { h: "DRE", f: (r) => link(r.source_url, r.despacho || "fonte") }], cab)}</details>`
        : '<p class="note warn">Sem dados de gabinete na fonte.</p>'}</section>

      <section class="panel"><h2>Contratação pública dos organismos tutelados</h2>
        ${sp.years.length ? Portal.bars(sp.years) : '<p class="note">Sem contratos associados aos organismos identificados.</p>'}
        <div class="cols">
          <div><h3>Como contrata</h3>${Portal.table([{ h: "Procedimento", f: (r) => esc(r.procedure || "—") }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], sp.procs)}</div>
          <div><h3>Principais fornecedores</h3>${Portal.table([{ h: "Fornecedor", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.seller_name || r.seller_nif)}</a>` : esc(r.seller_name || r.seller_nif)) },
            { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "% direto", num: 1, f: (r) => (r.value ? Math.round(100 * r.direct_value / r.value) + "%" : "—") }], sp.suppliers)}</div></div>
        <h3>Organismos que mais contratam</h3>${Portal.table([{ h: "Organismo", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)) }, { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) },
          { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "% direto", num: 1, f: (r) => (r.value ? Math.round(100 * r.direct_value / r.value) + "%" : "—") }], sp.buyers)}
        <p class="small muted">Preço contratual dos contratos do Portal BASE (IMPIC) em que o organismo é adjudicante; só organismos identificados na tutela (ver abaixo), sem empresas participadas nem entidades sem NIF no registo.</p></section>

      <section class="panel"><h2>Estrutura e tutela (${Portal.int(d.totalBodies)} organismos)</h2>
        <p class="note">Atribuição por <b>regra</b> (nome/sector) ou <b>Wikidata</b> — não foi extraída das leis orgânicas (Diário da República inacessível). Verifique a orgânica antes de citar. Esta lista só contém entidades que constam do registo de contratação pública.</p>
        <input id="bflt" class="search" placeholder="Filtrar organismos…" style="margin:.5rem 0;max-width:340px">
        <div id="btbl">${bodiesTable(d.bodies)}</div>
        ${d.totalBodies > d.bodies.length ? `<p class="small muted">A mostrar ${d.bodies.length} de ${d.totalBodies} (os de maior valor contratado).</p>` : ""}</section>

      <section class="panel"><h2>Decisões do Conselho de Ministros</h2>
        <p class="small muted">Itens dos comunicados oficiais atribuídos a este ministério por <b>palavras-chave e nomes de organismos</b> (heurística; uma decisão pode aparecer em mais de um ministério).</p>
        ${d.decisions.length ? d.decisions.map((x) => `<div class="row" style="margin:.7rem 0"><div class="small muted">${Portal.fmtDate(x.cm_date)} · ${link(x.source_url, "comunicado")} · ponto ${x.n}</div><div>${esc(x.text.length > 420 ? x.text.slice(0, 420) + "…" : x.text)}</div></div>`).join("") : '<p class="note">Sem decisões atribuídas.</p>'}</section>

      <section class="panel"><h2>Agenda parlamentar</h2>
        ${d.events.length ? Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.start) + (r.start && r.start.slice(0, 10) >= todayEv ? ' <span class="tag blue">próximo</span>' : "") },
          { h: "Evento", f: (r) => esc(r.title || "") }, { h: "Local", f: (r) => `<span class="small">${esc(r.local || r.section || "")}</span>` }], d.events) : '<p class="note">Nenhuma entrada da agenda parlamentar (≈2 meses para trás) menciona o ministro ou o ministério.</p>'}
        <h3>Iniciativas do Governo (propostas de lei) possivelmente relacionadas</h3>
        ${d.initiatives.length ? Portal.table([{ h: "Iniciativa", f: (r) => esc(r.title || r.key) }, { h: "Último passo", f: (r) => Portal.fmtDate(r.last) }], d.initiatives) : '<p class="note">Nenhuma iniciativa com origem GOV corresponde às palavras-chave deste ministério.</p>'}</section>

      <section class="panel"><h2>Notícias</h2>
        <p class="note warn">As listas de notícias por ministério em portugal.gov.pt carregam via JavaScript (Sitecore Search) e o endpoint não é acessível; por isso mostram-se apenas destaques da página inicial do Governo. Consulte <a href="${esc(m.url)}/noticias" target="_blank" rel="noopener">as notícias do ministério ↗</a>.</p>
        ${d.news.length ? `<ul>${d.news.map((n) => `<li>${link(n.url, n.title)} <span class="small muted">${esc(n.source || "")}</span></li>`).join("")}</ul>` : ""}</section>`;
    const f = $("#bflt");
    if (f) f.oninput = () => { const q = f.value.toLowerCase(); $("#btbl").innerHTML = bodiesTable(d.bodies.filter((b) => b.name.toLowerCase().includes(q))); };
  }

  function bodiesTable(rows) {
    return Portal.table([
      { h: "Organismo", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)) },
      { h: "Tipo", f: (r) => `<span class="small">${esc(Portal.kindLabel(r.ekind))}</span>` },
      { h: "Valor contratado", num: 1, f: (r) => Portal.eur(r.value) },
      { h: "Base da tutela", f: (r) => `<span class="tag ${r.method === "wikidata" ? "blue" : "amber"}" title="${esc(r.basis || "")}">${esc(METHOD[r.method] || r.method)}</span>${r.wikidata ? ` ${link("https://www.wikidata.org/wiki/" + r.wikidata, r.wikidata)}` : ""}` },
    ], rows.slice(0, 400));
  }

  Portal.page("ministerios", async (arg) => { if (arg) await pageOne(arg); else await pageList(); });

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    const r = await Portal.api("ministerios/entidade" + Portal.qs({ nif: e.nif, name: e.name }));
    if (!r.tutela || !r.tutela.length) return;
    const t = r.tutela[0];
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Tutela</h2><p>Tutelado por: <a href="#/ministerios/${esc(t.ministry)}"><b>Ministério — ${esc(t.mname)}</b></a>${t.minister ? ` (${esc(t.minister)})` : ""}
      <span class="tag amber" title="${esc(t.basis || "")}">${esc(METHOD[t.method] || t.method)}</span></p>
      <p class="small muted">${esc(t.basis || "")}. ${link(t.source_url, "fonte")}. Atribuição indicativa — não extraída da lei orgânica.</p></section>`);
  });
})();
