"use strict";
/* Módulo "empresas_locais": #/empresas-locais (empresas municipais e intermunicipais) e #/empresas-locais/<id>.
   API: /api/empresas_locais/*. Dono (município) por nome = HEURÍSTICA; ver avisos na página. */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>
    .el-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.el-f input,.el-f select{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
    .el-f input[name=q]{flex:1;min-width:200px}
    .el-h{display:grid;grid-template-columns:minmax(110px,42%) 1fr auto;gap:8px;align-items:center;font-size:.84rem;padding:3px 0}
    .el-h .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.el-h .m{height:9px;background:var(--line2);border-radius:5px;overflow:hidden}.el-h .m i{display:block;height:100%;background:var(--bar)}
    .el-h .v{font-variant-numeric:tabular-nums;white-space:nowrap}
    .el-h2{font-size:.72rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px;white-space:nowrap}
  </style>`;
  const eurS = (v) => (v == null ? "—" : Portal.eur(v));
  const heur = '<span class="el-h2" title="Heurística: ver notas da página">heur.</span>';
  const ownerLinks = (owners) => (owners && owners.length
    ? owners.map((o) => `<a href="#/empresas-locais?concelho=${esc(o.dico)}">${esc(o.municipality)}</a>`).join(", ") + (owners.some((o) => o.confidence) ? heur : "")
    : '<span class="muted">sem dono identificado</span>');
  const hbars = (rows, label, value, fmt) => {
    const max = Math.max(1, ...rows.map((r) => Math.abs(value(r))));
    return rows.map((r) => `<div class="el-h" title="${esc(label(r))}"><span class="t">${esc(label(r))}</span><span class="m"><i style="width:${(100 * Math.abs(value(r)) / max).toFixed(1)}%"></i></span><span class="v">${fmt(r)}</span></div>`).join("");
  };
  const coverage = (d) => `<section class="panel"><h2>Cobertura e limites</h2>
    <ul class="small">
      <li><b>Lista de empresas:</b> entidades do registo do portal (Portal BASE/IMPIC) com nome de empresa local. Não é a lista oficial da DGAL: empresas sem NIF registado não aparecem, e as que nunca tiveram contratos só aparecem se o registo as tiver (${Portal.int(d.kpis.idle)} das listadas não têm nenhum contrato).</li>
      <li><b>Dono (município):</b> deduzido do <i>nome</i> da empresa (ex. «Águas de Fafe, EM» → Fafe) ou, em poucos casos, do município que mais lhe contrata; ambos são heurísticas assinaladas «heur.». <b>Percentagens de participação não existem em dados abertos</b>: nunca são mostradas.</li>
      <li><b>Setor e forma jurídica:</b> classificados por palavras do nome. <b>Estado</b> (ativa/em liquidação): sem fonte aberta; só se o nome o indicar.</li>
      <li><b>Finanças:</b> a DGAL só publica em dados abertos agregados por município, e só 2016 é utilizável: o ficheiro de 2015 é idêntico ao de 2016 em todos os municípios e campos (duplicado na fonte, não fiável) e o de 2017 só tem trimestres sem totais. Não há contas por empresa.</li>
      <li><b>Administradores:</b> mandatos da Entidade para a Transparência, nomes como publicados; só as empresas ligadas por NIF ou nome exato.</li>
    </ul>
    ${(d.blocked || []).length ? `<details><summary class="small">Fontes bloqueadas ou sem dados (${d.blocked.length})</summary><ul class="small">${d.blocked.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></details>` : ""}
    ${(d.selNote || []).length ? `<ul class="small">${d.selNote.map((b) => `<li>DGAL ${esc(b)}</li>`).join("")}</ul>` : ""}
    ${(d.errors || []).length ? `<p class="note warn">Erros na recolha: ${esc(d.errors.join("; "))}</p>` : ""}
    <p class="muted small">Atualizado: ${esc(d.built || "?")}. Fontes: ${ext("https://dados.gov.pt/pt/datasets/?q=setor+empresarial+local", "DGAL, Setor Empresarial Local")} · ${ext("https://www.base.gov.pt/", "Portal BASE")} · ${ext("https://www.entidadetransparencia.pt/", "Entidade para a Transparência")}.</p></section>`;

  async function pageHome(p) {
    const lista = await Portal.api("empresas_locais/lista?" + new URLSearchParams(p).toString());
    const ov = await Portal.api("empresas_locais/overview");
    if (!ov.available) { $app.innerHTML = `<p class="note warn">${esc(ov.note)}</p>`; return; }
    const k = ov.kpis;
    const link = (o) => "#/empresas-locais?" + new URLSearchParams({ ...p, ...o }).toString();
    const filtered = p.q || p.concelho || p.setor || p.forma || p.semdono;
    $app.innerHTML = css + `<h1>Empresas municipais e intermunicipais</h1>
      <p class="muted">Sector Empresarial Local: empresas detidas ou controladas por municípios e comunidades intermunicipais, com contratação pública, administradores e peso no total contratado de cada município.</p>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(k.n)}</b><span>empresas no registo (${Portal.int(k.inter)} intermunicipais pelo nome)</span></div>
        <div class="kpi"><b>${Portal.int(k.n_owned_med)}</b><span>com dono provável (heurística de nome), em ${Portal.int(k.munis_med)} de ${Portal.int(k.municipios)} municípios; + ${Portal.int(k.n_owned_low)} de baixa confiança (fragmento do nome ou cliente principal)</span></div>
        <div class="kpi"><b>${eurS(k.seller_value)}</b><span>contratos como fornecedor (${Portal.int(k.seller_contracts)})</span></div>
        <div class="kpi"><b>${eurS(k.muni_to_companies_value)}</b><span>municípios → as suas empresas (${Portal.int(k.muni_to_companies_contracts)} contratos; ${eurS(k.excluded_value)} em «contratação excluída», onde cabe o in-house)</span></div>
        <div class="kpi"><b>${Portal.int(k.with_admins)}</b><span>com administradores nos mandatos da ET</span></div>
      </div>
      ${filtered ? "" : `<div class="cols">
        <section class="panel"><h2>Por setor (heurística pelo nome)</h2>${hbars(ov.bySector, (r) => r.sector, (r) => r.n, (r) => Portal.int(r.n))}</section>
        <section class="panel"><h2>Maiores fornecedores</h2>${Portal.table([
          { h: "Empresa", f: (r) => `<a href="#/empresas-locais/${r.id}">${esc(r.name)}</a>` },
          { h: "Dono", f: (r) => ownerLinks(r.owners) },
          { h: "Contratos", num: 1, f: (r) => eurS(r.seller_value) }], ov.top.slice(0, 10))}</section>
        <section class="panel"><h2>Municípios: mais contratação às próprias empresas</h2>${Portal.table([
          { h: "Município", f: (r) => `<a href="#/empresas-locais?concelho=${esc(r.dico)}">${esc(r.name)}</a>` },
          { h: "Empresas", num: 1, f: (r) => Portal.int(r.n_companies) },
          { h: "→ empresas", num: 1, f: (r) => eurS(r.muni_to_companies_value) },
          { h: "% do total", num: 1, f: (r) => (r.share_pct == null ? "—" : r.share_pct.toFixed(1) + "%") }], ov.topMunis.slice(0, 10))}</section>
        <section class="panel"><h2>Dados DGAL (agregados por município)</h2>${Portal.table([
          { h: "Ano", f: (r) => r.year }, { h: "Entidades", num: 1, f: (r) => Portal.int(r.n_entities) },
          { h: "Trabalhadores", num: 1, f: (r) => Portal.int(r.employees) }, { h: "Resultados", num: 1, f: (r) => eurS(r.result) }, { h: "Dívida", num: 1, f: (r) => eurS(r.debt) }], ov.sel)}
          <p class="muted small">Soma dos municípios; o ficheiro de 2015 é idêntico ao de 2016 (duplicado na fonte, omitido); 2017 só tem trimestres sem totais; 2018 sem ficheiros.</p></section>
      </div>`}
      <section class="panel"><h2>Empresas${p.concelho ? " do município " + esc(p.concelho) : ""} (${Portal.int(lista.total)})</h2>
        <form class="el-f" onsubmit="event.preventDefault();location.hash='#/empresas-locais?'+new URLSearchParams(Object.fromEntries([...new FormData(this)].filter(x=>x[1]))).toString()">
          <input name="q" placeholder="Nome ou NIF" value="${esc(p.q || "")}">
          <select name="setor"><option value="">Todos os setores</option>${ov.setores.map((s) => `<option ${p.setor === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
          <select name="sort">${[["valor", "Maior valor vendido"], ["contratos", "Mais contratos"], ["comprador", "Maior valor comprado"], ["recente", "Mais recente"], ["nome", "Nome"]].map(([v, l]) => `<option value="${v}" ${p.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${p.concelho ? `<input type="hidden" name="concelho" value="${esc(p.concelho)}">` : ""}
          <label class="small"><input type="checkbox" name="semdono" value="1" ${p.semdono ? "checked" : ""}> sem dono identificado</label>
          <button class="btn">Filtrar</button></form>
        ${Portal.table([
          { h: "Empresa", f: (r) => `<a href="#/empresas-locais/${r.id}">${esc(r.name)}</a><div class="muted small">${esc(r.legal_form)} · ${esc(r.sector)}${r.status !== "não indicado" ? " · " + esc(r.status) : ""}</div>` },
          { h: "Município(s)", f: (r) => ownerLinks(r.owners) },
          { h: "Vendas", num: 1, f: (r) => `${eurS(r.seller_value)}<div class="muted small">${Portal.int(r.seller_contracts)} contr.</div>` },
          { h: "Compras", num: 1, f: (r) => `${eurS(r.buyer_value)}<div class="muted small">${Portal.int(r.buyer_contracts)} contr.</div>` },
          { h: "Último", f: (r) => esc(r.last_signed || "—") },
          { h: "Adm.", num: 1, f: (r) => (r.n_admins ? Portal.int(r.n_admins) : "—") }], lista.rows)}
        ${Portal.pager(lista.total, lista.page, lista.limit, (n) => link({ page: n }))}</section>
      ${coverage(ov)}`;
  }

  async function pageCompany(id) {
    const d = await Portal.api("empresas_locais/empresa?id=" + id);
    if (!d.available || !d.found) { $app.innerHTML = `<p class="note warn">${esc(d.note || "Empresa não encontrada.")}</p><p><a href="#/empresas-locais">← Empresas municipais</a></p>`; return; }
    const c = d.company;
    const cl = (r, nm, nif, ent) => (ent ? `<a href="#/entidade/${ent}">${esc(nm || nif)}</a>` : esc(nm || nif || "—"));
    const yrs = {};
    d.years.forEach((r) => { (yrs[r.year] ||= {})[r.role] = r; });
    const yrRows = Object.keys(yrs).sort().reverse().map((y) => ({ y, s: yrs[y].vendedor, b: yrs[y].comprador }));
    const conTbl = (rows, who, whoNif) => Portal.table([
      { h: "Data", f: (r) => esc(r.signed || "") }, { h: "Objeto", f: (r) => (r.link ? ext(r.link, (r.object || "").slice(0, 110)) : esc((r.object || "").slice(0, 110))) },
      { h: who, f: (r) => esc(r[whoNif] || "") }, { h: "Procedimento", f: (r) => esc(r.procedure || "") }, { h: "Preço", num: 1, f: (r) => eurS(r.price) }], rows);
    $app.innerHTML = css + `<p><a href="#/empresas-locais">← Empresas municipais</a></p>
      <h1>${esc(c.name)}</h1>
      <p class="muted">NIF ${esc(c.nif)} · ${esc(c.legal_form)} (${c.scope === "intermunicipal" ? "intermunicipal" : "municipal"}, pelo nome) · ${esc(c.sector)} (heurística) · estado: ${esc(c.status)}${c.entity_id ? ` · <a href="#/entidade/${c.entity_id}">ficha da entidade</a>` : ""}</p>
      <div class="kpis">
        <div class="kpi"><b>${eurS(c.seller_value)}</b><span>vendido em ${Portal.int(c.seller_contracts)} contratos</span></div>
        <div class="kpi"><b>${eurS(c.buyer_value)}</b><span>comprado em ${Portal.int(c.buyer_contracts)} contratos</span></div>
        <div class="kpi"><b>${eurS(c.seller_to_owner_value)}</b><span>vendido ao(s) município(s) dono(s) (${Portal.int(c.seller_to_owner_contracts)}); ${eurS(c.excluded_to_owner_value)} como «contratação excluída»</span></div>
        <div class="kpi"><b>${esc(c.last_signed || "—")}</b><span>último contrato (desde ${esc(c.first_signed || "—")})</span></div>
      </div>
      <div class="cols">
      <section class="panel"><h2>Donos</h2>${d.owners.length ? Portal.table([
        { h: "Município", f: (o) => (o.entity_id ? `<a href="#/entidade/${o.entity_id}">${esc(o.municipality)}</a>` : esc(o.municipality)) },
        { h: "%", num: 1, f: (o) => (o.pct == null ? "n/d" : o.pct + "%") },
        { h: "Como foi identificado", f: (o) => `${esc(o.method)} <span class="muted small">(${esc(o.confidence)}; ${esc(o.evidence)})</span>` }], d.owners)
        : '<p class="note">Sem município identificado: o nome não o indica e nenhum município concentra os contratos.</p>'}
        <p class="note small">Heurística: sem fonte aberta com a estrutura acionista. Confirme no relatório e contas da empresa ou na deliberação de constituição.</p></section>
      <section class="panel"><h2>Administradores (Entidade para a Transparência)</h2>${d.admins.length ? Portal.table([
        { h: "Nome", f: (a) => esc(a.holder) }, { h: "Cargo", f: (a) => esc(a.role || "") },
        { h: "Início", f: (a) => esc(a.begin_date || "") }, { h: "Fim", f: (a) => esc(a.end_date || "em funções") },
        { h: "Fonte", f: (a) => (a.source_url ? ext(a.source_url, "ET") : "") }], d.admins)
        : '<p class="note">Sem mandatos ligados a esta empresa na base da ET (por NIF ou nome exato).</p>'}</section>
      </div>
      <section class="panel"><h2>Contratação por ano</h2>${Portal.table([{ h: "Ano", f: (r) => r.y }, { h: "Vendas", num: 1, f: (r) => (r.s ? `${eurS(r.s.value)} (${r.s.n})` : "—") }, { h: "Compras", num: 1, f: (r) => (r.b ? `${eurS(r.b.value)} (${r.b.n})` : "—") }], yrRows)}</section>
      <div class="cols">
      <section class="panel"><h2>Principais clientes</h2>${Portal.table([{ h: "Entidade", f: (r) => cl(r, r.name, r.nif, r.entity_id) }, { h: "Valor", num: 1, f: (r) => eurS(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], d.buyers)}</section>
      <section class="panel"><h2>Principais fornecedores</h2>${Portal.table([{ h: "Entidade", f: (r) => cl(r, r.name, r.nif, r.entity_id) }, { h: "Valor", num: 1, f: (r) => eurS(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], d.sellers)}</section>
      </div>
      ${d.fromOwner.length ? `<section class="panel"><h2>Contratos do(s) município(s) dono(s) à empresa (maiores)</h2>${conTbl(d.fromOwner, "Município", "buyer_name")}</section>` : ""}
      <section class="panel"><h2>Contratos como fornecedor (mais recentes)</h2>${conTbl(d.asSeller, "Comprador", "buyer_name")}</section>
      <section class="panel"><h2>Contratos como comprador (mais recentes)</h2>${conTbl(d.asBuyer, "Fornecedor", "seller_name")}</section>
      <p class="muted small">Dados: ${ext(c.source_url, "Portal BASE (registo e contratos)")}. Valores de contratos são preços contratuais, não pagamentos.</p>`;
  }

  Portal.page("empresas-locais", async (arg, p) => {
    if (arg && /^\d+$/.test(arg)) return pageCompany(arg);
    return pageHome(p || {});
  });
  Portal.nav("Empresas municipais", "#/empresas-locais");

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e) return;
    if (e.kind === "municipio") {
      const d = await Portal.api("empresas_locais/concelho?" + (e.dico ? "dico=" + e.dico : "nif=" + e.nif)).catch(() => null);
      if (!d || !d.found || (!d.companies.length && !d.sel.some((s) => s.n_entities))) return;
      const m = d.muni;
      el.insertAdjacentHTML("beforeend", css + `<section class="panel"><h2>Empresas municipais</h2>
        ${d.companies.length ? `<div class="kpis"><div class="kpi"><b>${Portal.int(m.n_companies)}</b><span>empresas (dono por heurística${m.n_companies_certain < m.n_companies ? "; " + Portal.int(m.n_companies - m.n_companies_certain) + " de baixa confiança" : ""})</span></div>
        <div class="kpi"><b>${eurS(m.muni_to_companies_value)}</b><span>do município para as empresas (${Portal.int(m.muni_to_companies_contracts)} contratos)</span></div>
        <div class="kpi"><b>${m.share_pct == null ? "—" : m.share_pct.toFixed(1) + "%"}</b><span>do total contratado pelo município (${eurS(m.muni_buyer_value)})</span></div>
        <div class="kpi"><b>${eurS(m.companies_seller_value)}</b><span>vendido pelas empresas a todos os clientes</span></div></div>
        ${Portal.table([{ h: "Empresa", f: (r) => `<a href="#/empresas-locais/${r.id}">${esc(r.name)}</a><div class="muted small">${esc(r.sector)}</div>` }, { h: "Vendas", num: 1, f: (r) => eurS(r.seller_value) }, { h: "Ao município", num: 1, f: (r) => eurS(r.seller_to_owner_value) }, { h: "Dono", f: (r) => `${esc(r.method)}` }], d.companies)}`
          : '<p class="note">Nenhuma empresa municipal identificada para este município no registo.</p>'}
        ${d.sel.length ? `<p class="small">DGAL (dados abertos): ${d.sel.map((s) => `${s.year}: ${s.n_entities} entidades, ${Portal.int(s.employees)} trabalhadores`).join(" · ")}.</p>` : ""}
        <p class="muted small"><a href="#/empresas-locais?concelho=${esc(m.dico)}">Ver na página das empresas municipais</a></p></section>`);
    } else if (e.nif) {
      const d = await Portal.api("empresas_locais/empresa?nif=" + e.nif).catch(() => null);
      if (!d || !d.found) return;
      el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Empresa municipal</h2><p>${d.owners.length ? "Município: " + ownerLinks(d.owners) : "Município dono não identificado"} · ${esc(d.company.sector)} · <a href="#/empresas-locais/${d.company.id}">ver administradores e contratação</a></p></section>`);
    }
  });
})();
