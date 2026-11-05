"use strict";
/* Módulo "fundos": #/fundos (PRR, Portugal 2020/2030, FEADER, MAR2020 por beneficiário) + secção nas páginas de entidade.
   API: /api/fundos/*  — dados abertos da Estrutura de Missão Recuperar Portugal e da AD&C (dados.gov.pt). */
(() => {
  const { esc } = Portal;
  const FW = { PRR: "PRR", PT2020: "Portugal 2020", PT2030: "Portugal 2030", FEADER: "FEADER", MAR2020: "MAR 2020 (FEAMP)" };
  const fwl = (k) => FW[k] || k;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>
    .fd-h{display:grid;grid-template-columns:minmax(120px,38%) 1fr auto;gap:8px;align-items:center;font-size:.84rem;padding:3px 0}
    .fd-h .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fd-h .m{height:9px;background:var(--line2);border-radius:5px;overflow:hidden}.fd-h .m i{display:block;height:100%;background:var(--bar)}
    .fd-h .v{font-variant-numeric:tabular-nums;white-space:nowrap}
    .fd-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.fd-f input,.fd-f select{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit;font-size:.88rem;max-width:100%}
    .fd-f input[name=q]{flex:1;min-width:200px}.fd-t{max-width:340px;white-space:normal}
  </style>`;
  const hbars = (rows, label, value, opts = {}) => {
    const max = Math.max(1, ...rows.map(value));
    return rows.map((r) => `<div class="fd-h" title="${esc(label(r))}"><span class="t">${opts.html ? opts.html(r) : esc(label(r))}</span><span class="m"><i style="width:${(100 * value(r) / max).toFixed(1)}%"></i></span><span class="v">${Portal.eur(value(r))}</span></div>`).join("");
  };
  const yearChart = (rows) => {
    const max = Math.max(1, ...rows.map((y) => y.value));
    return `<div class="barchart" role="img" aria-label="Montante aprovado por ano">${rows.map((y) => `<div class="col" title="${y.year}: ${Portal.eurFull(y.value)} · ${Portal.int(y.n)} registos"><div class="b" style="height:${Math.max(1, 130 * y.value / max)}px"></div><div class="lbl">${String(y.year).slice(2)}</div></div>`).join("")}</div>`;
  };
  const entLink = (r) => (r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : r.nif ? `<a href="#/fundos?q=${r.nif}" title="NIF ${r.nif}">${esc(r.name)}</a>` : esc(r.name));
  const sel = (name, opts, cur, all) => `<select name="${name}" aria-label="${esc(all)}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;

  Portal.nav("Fundos europeus", "#/fundos");

  Portal.page("fundos", async (arg, p) => {
    $app.innerHTML = `<div class="pagehead"><div><div class="kicker">Transparência</div><h1>Fundos europeus e PRR</h1></div></div><p class="muted">A carregar…</p>`;
    const [ov, fl, s] = await Promise.all([
      Portal.api("fundos/overview"), Portal.api("fundos/filters"),
      Portal.api("fundos/search" + Portal.qs({ q: p.q, programa: p.programa, fw: p.fw, tipo: p.tipo, regiao: p.regiao, year: p.year, min: p.min, page: p.page, sort: p.sort })),
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Fundos europeus e PRR</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const t = ov.totals, m = ov.match || [];
    const mv = m.reduce((a, x) => a + (x.m_val || 0), 0), vn = m.reduce((a, x) => a + (x.val_nif || 0), 0);
    const link = (o) => `#/fundos${Portal.qs({ ...p, page: "", ...o })}`;
    const filtered = Object.keys(p).length > 0;
    const searchPanel = `<section class="panel"><h2>Pesquisar beneficiários e projetos</h2>
        <form class="fd-f" id="fd-form">
          <input name="q" value="${esc(p.q || "")}" placeholder="Nome, título do projeto ou NIF (9 dígitos)…" aria-label="Pesquisa">
          ${sel("fw", Object.entries(FW), p.fw, "Todos os fundos")}
          ${sel("programa", fl.programas.map((x) => [x.programa, `${fwl(x.fw)} · ${x.programa}`]), p.programa, "Todos os programas")}
          ${sel("year", fl.anos.map((y) => [y, y]), p.year, "Todos os anos")}
          ${sel("tipo", fl.tipos.map((x) => [x, x]), p.tipo, "Todos os tipos")}
          ${sel("regiao", fl.regioes.map((x) => [x, x]), p.regiao, "Todas as regiões")}
          <input name="min" type="number" min="0" step="1000" value="${esc(p.min || "")}" placeholder="Mínimo (€)" style="width:130px" aria-label="Montante mínimo">
          <button class="btn primary" type="submit">Filtrar</button> ${Object.keys(p).length ? '<a class="btn" href="#/fundos">Limpar</a>' : ""}</form>
        <p class="small muted">${Portal.int(s.total)} resultados · ${Portal.eurFull(s.aprovado)} aprovados · ${Portal.eurFull(s.pago)} pagos</p>
        ${Portal.table([
          { h: "Beneficiário", f: (r) => entLink(r) + (r.match === "nome" ? ' <span class="tag amber" title="ligação por nome (sem NIF)">por nome</span>' : "") },
          { h: "Projeto", f: (r) => `<span class="fd-t">${esc((r.titulo || r.code || "").slice(0, 140))}</span><div class="small muted">${esc(r.code || "")}</div>` },
          { h: "Fundo / programa", f: (r) => `<span class="tag blue">${esc(fwl(r.fw))}</span> <span class="small">${esc(r.programa || "")}</span>` },
          { h: "Ano", f: (r) => r.ano || "—" },
          { h: "Região", f: (r) => esc(r.concelho ? `${r.concelho}${r.regiao ? " · " + r.regiao : ""}` : r.regiao || "—") },
          { h: "Aprovado", num: 1, sort: "aprovado", f: (r) => Portal.eurFull(r.aprovado) },
          { h: "Pago", num: 1, sort: "pago", f: (r) => Portal.eurFull(r.pago) },
          { h: "Fonte", f: (r) => ext(r.source_url, "dados.gov.pt") },
        ], s.rows, { sort: p.sort || "aprovado", sortLink: (k) => link({ sort: k }) })}
        ${Portal.pager(s.total, s.page, s.limit, (n) => link({ page: n }))}</section>`;
    $app.innerHTML = `${css}
      <div class="pagehead"><div><div class="kicker">Transparência</div><h1>Fundos europeus e PRR</h1>
        <div class="small muted">Para onde vai o dinheiro do Plano de Recuperação e Resiliência, do Portugal 2020/2030, do FEADER e do FEAMP: por beneficiário, programa, ano e região. Atualizado ${esc(ov.built || "")}.</div></div></div>
      <div class="kpis">
        <div class="kpi"><b>${Portal.eur(t.aprovado)}</b><span>aprovado / contratado</span></div>
        <div class="kpi"><b>${Portal.eur(t.pago)}</b><span>pago / executado</span></div>
        <div class="kpi"><b>${Portal.int(t.n)}</b><span>registos de beneficiário-operação</span></div>
        <div class="kpi"><b>${Portal.int(t.beneficiarios)}</b><span>beneficiários com NIF</span></div>
        <div class="kpi"><b>${vn ? Portal.pct(100 * mv / vn) : "—"}</b><span>do valor com NIF ligado ao registo de entidades</span></div></div>
      ${filtered ? searchPanel : ""}

      <div class="cols">
        <section class="panel"><h2>Por fundo / quadro</h2>${hbars(ov.fw, (r) => fwl(r.fw), (r) => r.aprovado, { html: (r) => `<a href="${link({ fw: r.fw })}">${esc(fwl(r.fw))}</a>` })}
          <p class="small muted">Aprovado/contratado. Os quadros não se sobrepõem (PT2020 e FEADER/MAR2020 são listas distintas).</p></section>
        <section class="panel"><h2>Por ano</h2>${yearChart(ov.anos.map((a) => ({ year: a.year, value: a.aprovado, n: a.n })))}
          <p class="small muted">Ano de início da operação (PT2030, PRR); ano de conclusão efetiva ou prevista (PT2020, FEADER, MAR2020).</p></section></div>
      <div class="cols">
        <section class="panel"><h2>Maiores programas</h2>${hbars(ov.programas, (r) => `${fwl(r.fw)} · ${r.programa}`, (r) => r.aprovado, { html: (r) => `<a href="${link({ programa: r.programa, fw: r.fw })}">${esc(r.programa.replace(/^PRR · /, ""))}</a> <span class="tag">${esc(fwl(r.fw))}</span>` })}</section>
        <section class="panel"><h2>Por tipo de beneficiário</h2>${hbars(ov.tipos, (r) => r.tipo, (r) => r.aprovado, { html: (r) => `<a href="${link({ tipo: r.tipo })}">${esc(r.tipo)}</a>` })}
          <p class="small muted">Tipo do registo de entidades quando há ligação; caso contrário, heurística pelo NIF e pelo nome. ${ov.pessoas.n ? `${Portal.int(ov.pessoas.n)} registos de pessoas singulares (${Portal.eur(ov.pessoas.v)}) não mostram nome nem NIF.` : ""}</p></section></div>
      <div class="cols">
        <section class="panel"><h2>Por região (NUTS II)</h2>${hbars(ov.regioes, (r) => r.regiao, (r) => r.aprovado, { html: (r) => `<a href="${link({ regiao: r.regiao })}">${esc(r.regiao)}</a>` })}
          <p class="small muted">Região da localização principal do projeto; só existe para PRR, PT2020 e PT2030.</p></section>
        <section class="panel"><h2>Concelhos com mais investimento localizado</h2>${hbars(ov.concelhos.slice(0, 12), (r) => r.concelho, (r) => r.aprovado)}
          <p class="small muted">Montante aprovado dos projetos localizados no concelho (repartido pela percentagem de localização).</p></section></div>

      <section class="panel"><h2>Maiores beneficiários</h2>${Portal.table([
        { h: "Beneficiário", f: (r) => entLink(r) }, { h: "Tipo", f: (r) => esc(r.tipo) }, { h: "Registos", num: 1, f: (r) => Portal.int(r.n) },
        { h: "Aprovado", num: 1, f: (r) => Portal.eurFull(r.aprovado) }, { h: "Pago", num: 1, f: (r) => Portal.eurFull(r.pago) }], ov.top)}
        <p class="small muted">Inclui organismos intermédios e entidades com papel de beneficiário direto no PRR. Os beneficiários finais do PRR são contados uma vez (os valores dos intermediários não são somados, para evitar duplicações).</p></section>

      ${filtered ? "" : searchPanel}
      <section class="panel"><h2>Municípios (como beneficiários)</h2>${Portal.table([
        { h: "Município", f: (r) => `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` }, { h: "Registos", num: 1, f: (r) => Portal.int(r.n) },
        { h: "Aprovado", num: 1, f: (r) => Portal.eurFull(r.aprovado) }, { h: "Pago", num: 1, f: (r) => Portal.eurFull(r.pago) },
        { h: "€ por habitante", num: 1, f: (r) => (r.per_capita == null ? "—" : Portal.eurFull(r.per_capita)) }], ov.municipios)}
        <p class="small muted">Só o que o próprio município (NIF da câmara) recebe; não inclui empresas municipais, freguesias nem investimentos de terceiros no concelho.</p></section>

      <section class="panel"><h2>Ligação ao registo de entidades</h2>${Portal.table([
        { h: "Fundo", f: (r) => fwl(r.fw) }, { h: "Registos", num: 1, f: (r) => Portal.int(r.rows) },
        { h: "Com NIF de pessoa coletiva", num: 1, f: (r) => Portal.pct(100 * (r.rows_nif || 0) / (r.rows || 1), 1) },
        { h: "Ligados por NIF", num: 1, f: (r) => Portal.pct(100 * (r.m_rows || 0) / (r.rows_nif || 1), 1) + " dos que têm NIF" },
        { h: "Valor ligado", num: 1, f: (r) => Portal.pct(100 * (r.m_val || 0) / (r.val_nif || 1), 1) },
        { h: "Por nome", num: 1, f: (r) => Portal.int(r.n_rows || 0) }], m)}
        <p class="small muted">«Ligado» = o NIF existe no registo de entidades públicas/adjudicantes do portal (≈114 mil NIF, centrado em quem contrata no Portal BASE); beneficiários sem ligação são sobretudo empresas e associações que nunca contrataram como entidade pública. A ligação por nome só é feita quando falta o NIF e o nome é único; nunca em caso ambíguo.</p></section>

      <section class="panel"><h2>Fontes e limitações</h2>
        <ul class="small">${Object.entries(ov.sources || {}).map(([k, v]) => `<li><b>${esc(k)}</b>: ${ext(v.dataset, v.title)}</li>`).join("")}</ul>
        ${(ov.blocked || []).map((b) => `<p class="note warn"><b>${esc(b.source)}</b>: ${esc(b.reason)}</p>`).join("")}
        ${Object.keys(ov.errors || {}).length ? `<p class="note warn">Falhas na última atualização: ${esc(JSON.stringify(ov.errors))}</p>` : ""}
        <p class="note">Montantes: PRR = valor contratado (subvenções e empréstimos) e pago por projeto; PT2020/FEADER/FEAMP = apoio aprovado e executado; PT2030 = fundo (comparticipação UE) aprovado e pago. Pessoas singulares são omitidas por privacidade. Os valores dependem da última atualização das fontes oficiais.</p></section>`;
    $("#fd-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const o = Object.fromEntries(new FormData(e.target).entries());
      Portal.go("fundos", "", o);
    });
  });

  /* ---------------------------------------------------------- secção nas páginas de entidade */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.nif) return;
    const [d, c] = await Promise.all([
      Portal.api("fundos/entity?nif=" + e.nif),
      e.kind === "municipio" ? Portal.api("fundos/concelho?name=" + encodeURIComponent(e.name)).catch(() => null) : Promise.resolve(null),
    ]);
    if (!d || !d.available || (!d.matched && !(c && c.matched))) return;
    let html = css + `<section class="panel"><h2>Fundos europeus e PRR</h2>`;
    if (d.matched) {
      const t = d.totals;
      html += `<div class="kpis">
        <div class="kpi"><b>${Portal.eur(t.aprovado)}</b><span>aprovado / contratado</span></div>
        <div class="kpi"><b>${Portal.eur(t.pago)}</b><span>pago / executado</span></div>
        <div class="kpi"><b>${Portal.int(t.n)}</b><span>operações</span></div></div>`;
      if (d.byFw.length) html += `<div class="cols"><div><h3>Por fundo</h3>${hbars(d.byFw, (r) => fwl(r.fw), (r) => r.aprovado, { html: (r) => esc(fwl(r.fw)) })}</div>
        <div>${d.byYear.length ? `<h3>Por ano</h3>${yearChart(d.byYear)}` : ""}</div></div>`;
      if (d.top.length) html += `<h3>Maiores operações</h3>` + Portal.table([
        { h: "Projeto", f: (r) => `<span class="fd-t">${esc((r.titulo || r.code || "").slice(0, 140))}</span><div class="small muted">${esc(r.code || "")}</div>` },
        { h: "Programa", f: (r) => `<span class="tag blue">${esc(fwl(r.fw))}</span> <span class="small">${esc(r.programa || "")}</span>` },
        { h: "Ano", f: (r) => r.ano || "—" }, { h: "Estado", f: (r) => esc(r.estado || "—") },
        { h: "Aprovado", num: 1, f: (r) => Portal.eurFull(r.aprovado) }, { h: "Pago", num: 1, f: (r) => Portal.eurFull(r.pago) },
        { h: "Fonte", f: (r) => ext(r.source_url, "dados.gov.pt") }], d.top);
      html += `<p class="small"><a href="#/fundos?q=${e.nif}">Ver todas as ${Portal.int(t.n)} operações →</a></p>`;
    }
    if (d.contractsTotal && d.contractsTotal.n) html += `<h3>Contratos PRR como beneficiário direto/intermediário</h3>
      <p class="small muted">${Portal.int(d.contractsTotal.n)} contratos com a Estrutura de Missão: ${Portal.eurFull(d.contractsTotal.contratado)} contratados, ${Portal.eurFull(d.contractsTotal.pago)} pagos. Este valor é repassado a beneficiários finais e <b>não</b> está somado acima.</p>` +
      Portal.table([{ h: "Contrato", f: (r) => esc((r.title || r.code || "").slice(0, 140)) }, { h: "Assinado", f: (r) => Portal.fmtDate(r.signed) }, { h: "Estado", f: (r) => esc(r.estado || "") },
        { h: "Contratado", num: 1, f: (r) => Portal.eurFull(r.contratado) }, { h: "Pago", num: 1, f: (r) => Portal.eurFull(r.pago) }], d.contracts);
    if (d.intermediary) html += `<p class="small muted">Beneficiário intermediário em ${Portal.int(d.intermediary.n)} projetos PRR (${Portal.eurFull(d.intermediary.contratado)}); os valores aparecem nos beneficiários finais.</p>`;
    if (d.auxiliary && d.auxiliary.n) html += `<p class="small muted">Também figura como fornecedor/parceiro em ${Portal.int(d.auxiliary.n)} projetos PRR (${Portal.eurFull(d.auxiliary.aprovado)}), não incluídos nos totais.</p>`;
    if (c && c.matched) html += `<h3>Investimento localizado no concelho</h3><p class="small">${Portal.eurFull(c.aprovado)} aprovados em ${Portal.int(c.n)} projetos localizados em ${esc(c.concelho)} (PRR, PT2020, PT2030), independentemente de quem os executa. Pago: ${Portal.eurFull(c.pago)}. Concelho associado pelo nome da entidade.</p>`;
    html += `<p class="small muted">Fonte: dados abertos da Estrutura de Missão Recuperar Portugal e da AD&amp;C (dados.gov.pt), ligados por NIF. <a href="#/fundos">Portal de fundos →</a></p></section>`;
    el.insertAdjacentHTML("beforeend", html);
  });
})();
