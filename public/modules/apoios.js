"use strict";
/* Módulo "apoios": #/apoios — Quem recebe apoios públicos (cultura, desporto, juventude, ciência) + secção nas páginas de entidade.
   API: /api/apoios/*  — listas de beneficiários publicadas pela DGARTES, ICA, IPDJ e FCT. */
(() => {
  const { esc } = Portal;
  const AREA = { cultura: "Cultura", desporto: "Desporto", juventude: "Juventude", ciencia: "Ciência" };
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>
    .ap-h{display:grid;grid-template-columns:minmax(120px,40%) 1fr auto;gap:8px;align-items:center;font-size:.84rem;padding:3px 0}
    .ap-h .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ap-h .m{height:9px;background:var(--line2);border-radius:5px;overflow:hidden}.ap-h .m i{display:block;height:100%;background:var(--bar)}
    .ap-h .v{font-variant-numeric:tabular-nums;white-space:nowrap}
    .ap-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.ap-f input,.ap-f select{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit;font-size:.88rem;max-width:100%}
    .ap-f input[name=q]{flex:1;min-width:200px}.ap-t{max-width:320px;white-space:normal}
    .ap-part{background:repeating-linear-gradient(45deg,var(--bar) 0 4px,transparent 4px 8px)!important;opacity:.55;outline:1px dashed var(--bar)}.ap-cap{color:#8a5a00;margin:6px 0 0}
    .ap-prog{border-top:1px solid var(--line2);padding:10px 0}.ap-prog:first-of-type{border-top:0}
    .ap-prog h3{margin:0 0 4px;font-size:.98rem}.ap-conc{display:inline-block;height:8px;background:var(--line2);border-radius:4px;width:90px;vertical-align:middle;overflow:hidden}.ap-conc i{display:block;height:100%;background:var(--bar)}
  </style>`;
  const hbars = (rows, label, value, opts = {}) => {
    const max = Math.max(1, ...rows.map(value));
    return rows.map((r) => `<div class="ap-h" title="${esc(label(r))}"><span class="t">${opts.html ? opts.html(r) : esc(label(r))}</span><span class="m"><i style="width:${(100 * value(r) / max).toFixed(1)}%"></i></span><span class="v">${Portal.eur(value(r))}</span></div>`).join("");
  };
  const capText = (shown) => {
    const g = {};
    shown.forEach((x) => (g[x.orgao + x.kind] = g[x.orgao + x.kind] || []).push(x));
    return Object.values(g).map((a) => (a.length > 1 && a.every((x) => x.short) ? `${esc(a[0].orgao)}: ${a.map((x) => `${x.year} ${esc(x.short)}`).join(", ")}; anos marcados com * estão incompletos, não interpretar como queda` : a.map((x) => esc(x.note)).join(" · "))).join(" · ");
  };
  // partial: [{year, kind, note}] — anos incompletos / quebras de série (vêm da API, não codificados aqui)
  const yearChart = (rows, partial = []) => {
    const max = Math.max(1, ...rows.map((y) => y.value));
    const pm = new Map(partial.map((x) => [x.year, x]));
    const bars = rows.map((y) => { const f = pm.get(y.year); return `<div class="col" title="${y.year}: ${Portal.eurFull(y.value)} · ${Portal.int(y.n)} registos${f ? " — " + esc(f.note) : ""}"><div class="b ${f ? "ap-part" : ""}" style="height:${Math.max(1, 130 * y.value / max)}px"></div><div class="lbl">${String(y.year).slice(2)}${f ? "*" : ""}</div></div>`; }).join("");
    const shown = partial.filter((x) => rows.some((y) => y.year === x.year));
    return `<div class="barchart" role="img" aria-label="Montante por ano">${bars}</div>${shown.length ? `<p class="small ap-cap">* ${capText(shown)}</p>` : ""}`;
  };
  const who = (r) => (r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.nome)}</a>` : r.nif && !r.pessoa_singular ? `<a href="#/apoios?q=${r.nif}" title="NIF ${r.nif}">${esc(r.nome)}</a>` : esc(r.nome));
  const mtag = (r) => (r.match === "nome" ? ' <span class="tag amber" title="ligação ao registo por nome exato (sem NIF na fonte)">por nome</span>' : r.match === "alias" ? ' <span class="tag amber" title="ligação ao registo por nome normalizado (sem acentos, formas jurídicas e artigos), só se único; sem NIF na fonte">por alias</span>' : "");
  const sel = (name, opts, cur, all) => `<select name="${name}" aria-label="${esc(all)}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const concBar = (c) => `<span class="ap-conc" title="Quota dos 10 maiores beneficiários"><i style="width:${Math.round(100 * c.share)}%"></i></span> <b>${Portal.pct(100 * c.share, 0)}</b>`;
  const stLabel = (s) => (s === "aprovado" ? "aprovado" : s === "pago" ? "pago" : "atribuído");

  Portal.nav("Apoios públicos", "#/apoios");

  Portal.page("apoios", async (arg, p) => {
    $app.innerHTML = `<div class="pagehead"><div><div class="kicker">Transparência</div><h1>Quem recebe apoios públicos</h1></div></div><p class="muted">A carregar…</p>`;
    const [ov, fl, s] = await Promise.all([
      Portal.api("apoios/overview"), Portal.api("apoios/filters"),
      Portal.api("apoios/search" + Portal.qs({ q: p.q, programa: p.programa, area: p.area, orgao: p.orgao, ano: p.ano, min: p.min, page: p.page })),
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Quem recebe apoios públicos</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const t = ov.totals;
    const link = (o) => `#/apoios${Portal.qs({ ...p, page: "", ...o })}`;
    const filtered = Object.keys(p).length > 0;
    const anosBy = (a) => ov.anos.filter((y) => y.area === a);
    const searchPanel = `<section class="panel" id="ap-search"><h2>Pesquisar beneficiários e apoios</h2>
        <form class="ap-f" id="ap-form">
          <input name="q" value="${esc(p.q || "")}" placeholder="Entidade, filme/projeto ou NIF (9 dígitos)…" aria-label="Pesquisa">
          ${sel("area", fl.areas.map((a) => [a.key, a.label]), p.area, "Todas as áreas")}
          ${sel("programa", fl.familias.map((f) => [f.key, `${f.orgao} · ${f.familia}`]), p.programa, "Todos os programas")}
          ${sel("ano", fl.anos.map((y) => [y, y]), p.ano, "Todos os anos")}
          <input name="min" type="number" min="0" step="1000" value="${esc(p.min || "")}" placeholder="Mínimo (€)" style="width:130px" aria-label="Montante mínimo">
          <button class="btn primary" type="submit">Filtrar</button> ${filtered ? '<a class="btn" href="#/apoios">Limpar</a>' : ""}</form>
        <p class="small muted">${Portal.int(s.total)} apoios · ${Portal.int(s.nben)} beneficiários · ${Portal.eurFull(s.amount)}</p>
        ${Portal.table([
          { h: "Beneficiário", f: (r) => who(r) + mtag(r) },
          { h: "Obra / projeto / finalidade", f: (r) => `<span class="ap-t">${esc((r.detalhe || "").slice(0, 110) || "—")}</span>` },
          { h: "Programa", f: (r) => `<span class="tag blue">${esc(r.orgao)}</span> <span class="small">${esc((r.programa || "").replace(/^(IPDJ|FCT|ICA) · /, "").slice(0, 70))}</span>` },
          { h: "Ano", f: (r) => r.year || "—" },
          { h: "Montante", num: 1, f: (r) => Portal.eurFull(r.amount) + `<div class="small muted">${stLabel(r.status)}</div>` },
          { h: "Fonte", f: (r) => ext(r.source_url, "origem") },
        ], s.rows)}
        ${Portal.pager(s.total, s.page, s.limit, (n) => link({ page: n }))}</section>`;
    const overlap = ov.fundosOverlap;
    $app.innerHTML = `${css}
      <div class="pagehead"><div><div class="kicker">Transparência</div><h1>Quem recebe apoios públicos</h1>
        <div class="small muted">Beneficiários de subvenções e apoios na cultura (DGARTES, ICA), desporto e juventude (IPDJ) e ciência (FCT), tal como publicados pelos próprios organismos. ${t.y0}–${t.y1}. Atualizado ${esc(ov.built || "")}.</div></div></div>
      <div class="kpis">
        <div class="kpi"><b>${Portal.eur(t.total)}</b><span>em ${Portal.int(t.n)} apoios listados</span></div>
        ${ov.areas.map((a) => `<div class="kpi"><b>${Portal.eur(a.total)}</b><span><a href="${link({ area: a.area })}">${esc(a.label)}</a> · ${Portal.int(a.n)} apoios · top 10 = ${Portal.pct(100 * a.conc.share, 0)}</span></div>`).join("")}
        <div class="kpi"><b>${Portal.int(t.beneficiarios)}</b><span>beneficiários distintos (organizações)</span></div>
        <div class="kpi"><b>${Portal.pct(100 * t.matchedVal / (t.total || 1), 0)}</b><span>do valor ligado ao registo de entidades</span></div></div>
      <p class="note warn"><b>Cobertura limitada.</b> Só entram as listas que os organismos publicam (ver «Fontes e limitações» abaixo). Os anos e instrumentos não são comparáveis entre organismos: DGARTES, IPDJ e ICA = montantes atribuídos por ano; FCT = financiamento aprovado (plurianual) à data de aprovação. Os valores do FCT são cofinanciados em parte por fundos europeus (COMPETE) que também aparecem em <a href="#/fundos">Fundos europeus</a> — não somar as duas páginas.</p>
      ${filtered ? searchPanel : ""}

      <div class="cols">${ov.areas.map((a) => `<section class="panel"><h2>${esc(a.label)} por ano</h2>${yearChart(anosBy(a.area), (ov.partial || []).filter((x) => x.area === a.area))}
        <p class="small muted">${esc(ov.orgaos.filter((o) => o.area === a.area).map((o) => `${o.orgao} ${o.y0}–${o.y1}`).join(" · "))}</p></section>`).join("")}</div>

      <section class="panel"><h2>Por programa: maiores beneficiários e concentração</h2>
        ${ov.familias.map((f) => `<div class="ap-prog"><h3><a href="${link({ programa: f.orgao + "|" + f.familia })}">${esc(f.familia)}</a> <span class="tag blue">${esc(f.orgao)}</span></h3>
          <div class="small muted">${Portal.eur(f.total)} · ${Portal.int(f.n)} apoios · ${Portal.int(f.conc.nben)} beneficiários · ${f.y0}–${f.y1} · os 10 maiores recebem ${concBar(f.conc)}</div>
          ${hbars(f.top, (r) => r.nome, (r) => r.total, { html: (r) => who(r) + mtag(r) })}</div>`).join("")}
        <p class="small muted">Concentração = quota do total do programa que fica nos 10 maiores beneficiários (organizações; pessoas singulares entram no total mas não nos rankings). Beneficiários sem NIF (ICA, FCT) são agrupados pelo nome tal como publicado: a mesma entidade escrita de forma diferente conta como duas, o que subestima a concentração.</p></section>

      <section class="panel"><h2>Maiores beneficiários no conjunto</h2>${Portal.table([
        { h: "Beneficiário", f: (r) => who(r) + mtag(r) }, { h: "Áreas", f: (r) => esc((r.areas || "").split(",").map((a) => AREA[a] || a).join(", ")) },
        { h: "Organismos", f: (r) => esc((r.orgaos || "").replace(/,/g, ", ")) }, { h: "Apoios", num: 1, f: (r) => Portal.int(r.n) },
        { h: "Anos", f: (r) => (r.primeiro === r.ultimo ? r.primeiro : `${r.primeiro}–${r.ultimo}`) },
        { h: "Total", num: 1, f: (r) => Portal.eurFull(r.total) }], ov.top)}
        <p class="small muted">Universidades aparecem com várias entidades gestoras (ex.: associações de I&D) e, por vezes, com duas grafias; só se ligam ao registo quando o nome exato é único.</p></section>

      ${filtered ? "" : searchPanel}

      <section class="panel"><h2>Ligação ao registo de entidades</h2>${Portal.table([
        { h: "Organismo", f: (r) => esc(r.orgao) }, { h: "Apoios", num: 1, f: (r) => Portal.int(r.n) },
        { h: "Por NIF", num: 1, f: (r) => Portal.int(r.m_nif || 0) }, { h: "Por nome exato", num: 1, f: (r) => Portal.int(r.m_nome || 0) }, { h: "Por alias", num: 1, f: (r) => Portal.int(r.m_alias || 0) },
        { h: "Pessoas singulares", num: 1, f: (r) => Portal.int(r.pers || 0) },
        { h: "% do valor ligado", num: 1, f: (r) => Portal.pct(100 * (r.m_val || 0) / (r.val || 1), 0) }], ov.matchBy)}
        <p class="small muted">«Ligado» = o NIF (ou o nome exato, se único) existe no registo de entidades do portal (≈114 mil NIF, centrado em quem contrata no Portal BASE). Muitas associações culturais e desportivas nunca contratam com o Estado e por isso ficam sem página de entidade. Nomes ambíguos nunca são ligados${ov.matchStats && (ov.matchStats.nome_ambiguo || ov.matchStats.alias_ambiguo) ? ` (${Portal.int(ov.matchStats.nome_ambiguo || 0)} apoios por nome, ${Portal.int(ov.matchStats.alias_ambiguo || 0)} por alias)` : ""}.
        Pessoas singulares: ${Portal.int(t.pessoas.n)} apoios (${Portal.eurFull(t.pessoas.total)}) publicados com NIF individual são guardados mas o nome e o NIF não são mostrados nem pesquisáveis.${overlap ? ` Beneficiários ligados da ciência têm ${Portal.eurFull(overlap)} em operações COMPETE/FCT em <a href="#/fundos">Fundos europeus</a> (possível sobreposição).` : ""}</p></section>

      <section class="panel"><h2>Fontes e limitações</h2>
        ${Portal.table([{ h: "Organismo", f: (r) => esc(r.orgao) }, { h: "Ficheiros", num: 1, f: (r) => Portal.int(r.files) }, { h: "Lidos com sucesso", num: 1, f: (r) => Portal.int(r.ok) }, { h: "Com problema", num: 1, f: (r) => Portal.int(r.problems) }, { h: "Linhas", num: 1, f: (r) => Portal.int(r.rows) }], ov.srcSum)}
        ${(ov.blocked || []).map((b) => `<p class="note warn">${esc(b)}</p>`).join("")}
        <details><summary class="small">Ficheiros de origem (${ov.sources.length})</summary>${Portal.table([
          { h: "Organismo", f: (r) => esc(r.orgao) }, { h: "Ficheiro", f: (r) => ext(r.url, r.name) }, { h: "Ano", f: (r) => r.year || "—" },
          { h: "Linhas", num: 1, f: (r) => Portal.int(r.rows) }, { h: "Estado", f: (r) => (r.status === "ok" ? "ok" : `<span class="tag amber">${esc(r.status)}</span>`) + (r.note ? `<div class="small muted">${esc(r.note)}</div>` : "") }], ov.sources)}</details>
        <p class="note">Robots e cortesia: dgartes.gov.pt (Crawl-delay 10 s respeitado), ica-ip.pt (sem robots.txt), ipdj.gov.pt (Allow /*), fct.pt (só /wp-admin proibido); pedidos com cache e ≥1,4 s por anfitrião. Quadrienais/bienais da DGARTES aparecem repetidos em cada lista anual (montante anual). «Atribuído» = montante da lista do ano; «aprovado» = financiamento concedido (FCT). Nenhum organismo publica aqui o montante efetivamente pago, exceto indicação em contrário na fonte.</p></section>`;
    $("#ap-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const o = Object.fromEntries(new FormData(e.target).entries());
      Portal.go("apoios", "", o);
    });
  });

  /* ---------------------------------------------------------- secção nas páginas de entidade */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.nif) return;
    let d;
    try { d = await Portal.api("apoios/entidade?nif=" + e.nif); } catch { return; }
    if (!d || !d.available || !d.matched) return;
    const t = d.totals;
    let html = css + `<section class="panel"><h2>Apoios públicos recebidos</h2>
      <div class="kpis">
        <div class="kpi"><b>${Portal.eur(t.total)}</b><span>em ${Portal.int(t.n)} apoios listados (${t.y0 === t.y1 ? t.y0 : `${t.y0}–${t.y1}`})</span></div>
        <div class="kpi"><b>#${Portal.int(d.rank)}</b><span>de ${Portal.int(d.nben)} beneficiários, por montante total</span></div></div>
      <div class="cols"><div><h3>Por programa</h3>${hbars(d.byProg.slice(0, 8), (r) => r.familia, (r) => r.total, { html: (r) => `<span class="tag blue">${esc(r.orgao)}</span> ${esc(r.familia)}${mtag(r)}` })}</div>
        <div>${d.byYear.length > 1 ? `<h3>Por ano</h3>${yearChart(d.byYear)}` : ""}</div></div>
      <h3>Apoios mais recentes</h3>` + Portal.table([
      { h: "Programa", f: (r) => `<span class="tag blue">${esc(r.orgao)}</span> <span class="small">${esc((r.programa || "").replace(/^(IPDJ|FCT|ICA) · /, "").slice(0, 80))}</span>` },
      { h: "Obra / projeto", f: (r) => `<span class="ap-t">${esc((r.detalhe || "").slice(0, 100) || "—")}</span>` },
      { h: "Ano", f: (r) => r.year || "—" },
      { h: "Montante", num: 1, f: (r) => Portal.eurFull(r.amount) + `<div class="small muted">${stLabel(r.status)}</div>` },
      { h: "Fonte", f: (r) => ext(r.source_url, "origem") }], d.rows.slice(0, 12));
    html += `<p class="small muted"><a href="#/apoios?q=${esc(e.nif)}">Ver todos os ${Portal.int(t.n)} apoios</a> · ${d.rows.some((r) => r.match === "nome") ? "Ligação por nome exato (a fonte não indica NIF). " : ""}Listas publicadas por DGARTES, ICA, IPDJ e FCT; cobertura parcial.${d.fundosOverlap ? ` Há ${Portal.eurFull(d.fundosOverlap)} em operações COMPETE/FCT nesta entidade também em <a href="#/fundos">Fundos europeus</a>: não somar.` : ""}</p></section>`;
    el.insertAdjacentHTML("beforeend", html);
  });
})();
