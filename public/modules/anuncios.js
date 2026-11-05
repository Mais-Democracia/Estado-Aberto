"use strict";
/* Módulo "anuncios": #/anuncios (Concursos e anúncios) e #/anuncios/<NIF> (vista por comprador) + secção nas páginas de entidade.
   API: /api/anuncios/* — anúncios de procedimento do Portal BASE (IMPIC), ligados aos contratos por nº de anúncio + NIF do comprador. */
(() => {
  const { esc } = Portal;
  const css = `<style>
    .an-warn{border:2px solid #b45309;background:color-mix(in srgb,#f59e0b 12%,var(--card));border-radius:10px;padding:14px 16px;margin:0 0 16px}
    .an-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.an-f select,.an-f input{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit;font-size:.88rem;max-width:100%}
    .an-f input[type=search]{flex:1 1 200px;min-width:0}
    .an-hb{display:grid;grid-template-columns:minmax(60px,150px) minmax(70px,1fr) auto;gap:8px;align-items:center;margin:3px 0;font-size:.86rem}
    .an-hb .t{background:var(--line2);border-radius:4px;height:14px;position:relative;overflow:hidden}.an-hb .t i{display:block;height:100%;background:var(--bar);border-radius:4px}
    .an-hb .t i.b2{background:var(--bar2);position:absolute;left:0;top:0;min-width:3px}
    .an-hb .v{font-variant-numeric:tabular-nums;white-space:nowrap}
    .an-ev{font-size:.82rem;margin:4px 0 0;padding:6px 8px;border-left:3px solid var(--line);background:var(--line2);border-radius:4px;overflow-wrap:anywhere}
    .an-ev ul{margin:4px 0 0 16px;padding:0}.an-ev li{margin:1px 0}
    .an-kp .kpi span{text-transform:none;letter-spacing:0;font-size:.8rem}
    .an-short{color:#b45309;font-weight:600}
    .an-n{font-variant-numeric:tabular-nums}
    .an-tbl td{vertical-align:top}
    .an-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px}
    details.an summary{cursor:pointer;color:var(--accent,inherit)}
  </style>`;
  const nf = Portal.int;
  const pct1 = (x) => (x == null ? "—" : (100 * x).toFixed(x < 0.1 ? 1 : 0).replace(".", ",") + "%");
  const days = (d) => (d == null ? "—" : `${d} d`);
  const sel = (name, opts, cur, all) => `<select name="${name}" aria-label="${esc(all)}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur ?? "") === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const ctr = (id, text) => `<a href="#/contrato/${esc(id)}">${esc(text || id)}</a>`;
  const buyerLink = (nif, name) => (nif ? `<a href="#/anuncios/${esc(nif)}">${esc(name || nif)}</a>` : esc(name || "—"));
  const hbars = (rows, opts = {}) => {
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.map((r) => `<div class="an-hb"><span>${esc(r[0])}</span><span class="t" title="${esc(r[0])}: ${nf(r[1])}"><i style="width:${(100 * r[1] / max).toFixed(1)}%"></i>${r[2] != null ? `<i class="b2" style="width:${(100 * r[2] / max).toFixed(1)}%"></i>` : ""}</span><span class="v">${opts.fmt ? opts.fmt(r) : nf(r[1])}</span></div>`).join("");
  };
  const NOTE = `<div class="an-warn"><b>Não é uma acusação.</b> Estes indicadores são sinais estatísticos calculados sobre dados oficiais do Portal BASE: cada um tem explicações legítimas (procedimentos desertos ou revogados, urgência, mercados pequenos, falhas de registo, mudança de NIF…). Servem para saber onde olhar, não para concluir. Cada linha mostra a evidência e a comparação com entidades do mesmo tipo.</div>`;
  const linkTag = (r) => (r.n_contracts > 0 ? `<span class="tag green" title="Contrato(s) publicado(s) ligado(s) por nº de anúncio + NIF">${r.n_contracts} contrato${r.n_contracts > 1 ? "s" : ""}</span>` : r.unfollowed ? `<span class="tag amber" title="Sem contrato ligado há mais de ~13 meses">sem contrato</span>` : `<span class="tag" title="Sem contrato ligado (ainda dentro do prazo, ou fora dos tipos que originam contrato)">—</span>`);

  function annTable(rows, opts = {}) {
    return Portal.table([
      { h: "Publicado", f: (r) => Portal.fmtDate(r.published) },
      { h: "Anúncio", f: (r) => `<b>${esc((r.description || "").slice(0, 150) || "(sem descrição)")}</b><div class="small muted">${esc(r.procedure || "")}${r.tipo_acto && r.tipo_acto !== "Anúncio de procedimento" ? ` · ${esc(r.tipo_acto)}` : ""} · n.º ${esc(r.n_anuncio)}${r.cpv_code ? ` · CPV ${esc(r.cpv_code)}${r.cpv_desc ? " " + esc(String(r.cpv_desc).slice(0, 50)) : ""}` : ""}${r.n_lotes ? ` · ${r.n_lotes} lotes` : ""}</div>${r.url ? `<div class="small"><a href="${esc(r.url)}" target="_blank" rel="noopener">aviso original ↗</a></div>` : ""}` },
      ...(opts.noBuyer ? [] : [{ h: "Comprador", f: (r) => `${buyerLink(r.buyer_nif, r.entity_name || r.buyer_name)}<div class="small muted">${esc(Portal.kindLabel(r.buyer_kind) || "")}${r.location ? " · " + esc(r.location) : ""}</div>` }]),
      { h: "Preço base", num: 1, f: (r) => (r.base_price ? Portal.eur(r.base_price) : '<span class="muted">n/d</span>') },
      { h: "Prazo", num: 1, f: (r) => (r.prazo_dias != null && r.deadline ? `<span title="publicação → limite de propostas (${esc(Portal.fmtDate(r.deadline))})" class="${r.short ? "an-short" : ""}">${days(r.prazo_dias)}${r.short ? " ▾" : ""}</span>` : '<span class="muted">—</span>') },
      { h: "Contrato", f: (r) => `${linkTag(r)}${r.first_contract_id ? `<div class="small">${ctr(r.first_contract_id, "ver contrato →")}${r.contract_value ? " · " + Portal.eur(r.contract_value) : ""}</div>` : ""}` },
    ], rows);
  }

  function evidence(kind, e) {
    if (!e) return "";
    const li = [];
    if (kind === "prazo_curto") {
      li.push(`<span>Limiares (p10 por regime): ${Object.entries(e.limiares_p10 || {}).map(([k, v]) => `${k.replace("bens_servicos", "bens/serviços").replace("ate_2017", "até 2017").replace("desde_2018", "desde 2018").replace("_", " ")} ≤ ${v} d`).join("; ")} · mediana do comprador: ${days(e.mediana_dias)}</span>`);
      return `<div class="an-ev">${li.join("")}<ul>${(e.anuncios || []).map((a) => `<li>${esc(Portal.fmtDate(a[2]))} · <b>${a[3]} dias</b> · ${a[4] ? Portal.eur(a[4]) : "n/d"} · ${esc((a[5] || "").slice(0, 110))} <span class="muted">(n.º ${esc(a[1])})</span></li>`).join("")}</ul></div>`;
    }
    if (kind === "sem_anuncio") {
      const m = e.motivos || {};
      return `<div class="an-ev"><span>Motivos: ${Object.entries(m).map(([k, v]) => `${{ sem_referencia: "sem referência a anúncio", nao_encontrada: "referência inexistente nos dados", outro_comprador: "nº existe com outro NIF (ambíguo, não contado)", anterior_2012: "anterior a 2012 (não contado)" }[k] || k}: ${nf(v)}`).join(" · ")}</span><ul>${(e.contratos || []).map((c) => `<li>${esc(Portal.fmtDate(c[1]))} · ${ctr(c[0], (c[6] || "contrato " + c[0]).slice(0, 110))} · ${c[2] ? Portal.eur(c[2]) : "n/d"} · ${esc(c[3] === "sem_referencia" ? "sem referência" : "ref. " + (c[4] || ""))} → ${esc(c[5] || "")}</li>`).join("")}</ul></div>`;
    }
    if (kind === "sem_contrato") {
      return `<div class="an-ev"><span>Anúncios publicados até ${esc(Portal.fmtDate(e.corte_publicacao))} sem contrato ligado:</span><ul>${(e.anuncios || []).map((a) => `<li>${esc(Portal.fmtDate(a[2]))} · ${a[3] ? Portal.eur(a[3]) : "n/d"} · ${esc((a[4] || "").slice(0, 120))} <span class="muted">(n.º ${esc(a[1])})</span></li>`).join("")}</ul></div>`;
    }
    if (kind === "preco_base") {
      return `<div class="an-ev"><span>Dos quais com 1 concorrente (ou nenhum registado): ${nf(e.ao_preco_base_com_1_concorrente)}</span><ul>${(e.contratos || []).map((c) => `<li>${esc(Portal.fmtDate(c[1]))} · ${ctr(c[0], "contrato " + c[0])} · ${Portal.eurFull(c[2])} · ${c[3] ?? "?"} concorrentes → ${esc(c[4] || "")}</li>`).join("")}</ul></div>`;
    }
    if (kind === "vencedor_repetido") {
      return `<div class="an-ev"><span>Fornecedor: <a href="#/contratos?seller=${esc(e.vencedor_nif)}">${esc(e.vencedor || e.vencedor_nif)}</a> (NIF ${esc(e.vencedor_nif)}) · ${e.procedimentos_ganhos} procedimentos, ${e.procedimentos_com_1_concorrente} deles com 1 concorrente · ${e.vencedores_distintos} vencedores distintos no comprador · pares comparáveis: ${e.n_pares}</span><ul>${(e.anuncios || []).map((a) => `<li>${esc(Portal.fmtDate(a[2]))} · ${esc((a[5] || "").slice(0, 100))} · ${Portal.eurFull(a[3])} · ${a[4] ?? "?"} concorrentes</li>`).join("")}</ul></div>`;
    }
    return "";
  }

  // ---------------------------------------------------------------- página principal
  Portal.nav("Anúncios", "#/anuncios");
  Portal.page("anuncios", async (arg, p) => {
    if (arg) return buyerPage(arg);
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Contratação pública</div><h1>Concursos e anúncios</h1></div></div><p class="muted">A carregar…</p>`;
    const ov = await Portal.api("anuncios/overview");
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Concursos e anúncios</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const kind = ov.defs[p.kind] ? p.kind : "prazo_curto";
    const [se, fl] = await Promise.all([
      Portal.api("anuncios/search" + Portal.qs({ q: p.q, buyer: p.buyer, cpv: p.cpv, year: p.year, procedure: p.procedure, status: p.status, page: p.page })),
      Portal.api("anuncios/flags" + Portal.qs({ kind, ekind: p.ekind, page: p.fpage })),
    ]);
    const link = (o) => `#/anuncios${Portal.qs({ ...p, ...o })}`;
    const L = ov.link || {}, dd = ov.deadline || {};
    const years = (ov.by_year || []).map((r) => r[0]).reverse();
    const tn = ov.tenders || 0;
    const unfRate = ov.unfollowed?.eligible ? ov.unfollowed.n / ov.unfollowed.eligible : null;
    const noannN = (ov.noann || []).filter((r) => r[0] !== "outro_comprador").reduce((s, r) => s + r[1], 0);
    const noannAmb = (ov.noann || []).find((r) => r[0] === "outro_comprador")?.[1] || 0;
    const ph = `Preço base n/d em ${nf(ov.no_base_price)} anúncios`;

    const flagTabs = Object.entries(ov.defs).map(([k, d]) => `<a class="btn ${k === kind ? "on" : ""}" href="${link({ kind: k, fpage: "", ekind: "" })}">${esc(d.label)} <span class="muted">(${nf(ov.flagCounts[k] || 0)})</span></a>`).join(" ");
    const rankTbl = Portal.table([
      { h: "Comprador", f: (r) => `${r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : esc(r.name || r.nif)}<div class="small muted">${esc(Portal.kindLabel(r.ekind) || "tipo n/d")} · NIF ${esc(r.nif)} · <a href="#/anuncios/${esc(r.nif)}">vista de anúncios →</a></div>` },
      { h: "Casos / base", num: 1, f: (r) => `<b class="an-n">${nf(r.k)}</b> / ${nf(r.n)}` },
      { h: "Taxa", num: 1, f: (r) => `<b class="an-n">${pct1(r.rate)}</b>` },
      { h: "Pares (mediana · p90)", num: 1, f: (r) => `${pct1(r.peer_rate)}${r.peer_p90 != null ? " · " + pct1(r.peer_p90) : ""}<div class="small muted">país: ${pct1(r.nat_rate)}</div>` },
      { h: "Desvio", num: 1, f: (r) => `<span title="erros-padrão acima da taxa dos pares (aproximação binomial, para ordenar)">${r.z.toFixed(1).replace(".", ",")}</span>` },
      { h: "Evidência", f: (r) => `<details class="an"><summary class="small">ver</summary>${evidence(fl.kind, r.evidence)}</details>` },
    ], fl.rows || []);

    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Contratação pública · antes do contrato</div><h1>Concursos e anúncios</h1></div></div>
      <p class="muted">Os anúncios de procedimento são a fase pública que antecede o contrato: quem abre o concurso, para quê, com que preço base e quanto tempo dá para concorrer. Fonte: <a href="${esc(ov.dataset?.url || "#")}" target="_blank" rel="noopener">Portal BASE (IMPIC) — Anúncios 2012–2026</a>, ligados aos contratos pelo número de anúncio e NIF do comprador.</p>
      ${NOTE}
      <div class="kpis an-kp">
        <div class="kpi"><b>${nf(ov.primary)}</b><span>avisos de procedimento (${nf(tn)} concursos, ${esc(String(ov.snapshot || "").slice(0, 10))})</span></div>
        <div class="kpi"><b>${Portal.eur(ov.base_total)}</b><span>preço base anunciado (concursos; ${ph})</span></div>
        <div class="kpi"><b>${pct1(L.match_rate)}</b><span>dos ${nf(L.contracts_with_ref)} contratos com nº de anúncio ligam a um anúncio (${pct1(L.match_rate_2013plus)} desde 2013)</span></div>
        <div class="kpi"><b>${pct1(unfRate)}</b><span>dos concursos com mais de ~13 meses sem contrato ligado (${nf(ov.unfollowed?.n)})</span></div>
        <div class="kpi"><b>${nf(noannN)}</b><span>contratos concorrenciais sem anúncio associado (${pct1(noannN / (ov.competitive_contracts_2013plus || 1))} de ${nf(ov.competitive_contracts_2013plus)}) + ${nf(noannAmb)} ambíguos</span></div>
        <div class="kpi"><b>${nf(ov.buyers)}</b><span>compradores com anúncios (${nf(ov.buyers_in_registry)} no registo de entidades)</span></div>
      </div>

      <div class="an-grid">
        <section class="panel"><h2>Anúncios por ano</h2><p class="small muted"><span style="display:inline-block;width:10px;height:10px;background:var(--bar2);vertical-align:middle"></span> vermelho: sem contrato ligado (concursos com ≥ ~13 meses); barra: total de anúncios originais (procedimento e concurso urgente) por ano.</p>
          ${hbars((ov.by_year || []).map((r) => [r[0], r[1], r[4]]), { fmt: (r) => `${nf(r[1])}${r[2] != null ? ` · ${nf(r[2])} s/ contrato` : ""}` })}</section>
        <section class="panel"><h2>Dias entre a publicação e o limite de propostas</h2>
          <p class="small muted">Concursos públicos e limitados (não urgentes), só o anúncio inicial (prorrogações e retificações excluídas). Prazo = data limite − data de publicação. Separado por regime porque há uma quebra clara em 2018.</p>
          ${Object.entries(dd).map(([k, v]) => `<h3 style="font-size:.95rem;margin:10px 0 2px">${esc(k)}</h3><p class="small muted">${nf(v.n)} concursos · mediana ${v.median} d · p10 ${v.p10} d · p25 ${v.p25} d · p75 ${v.p75} d</p>${hbars(v.bins)}`).join("")}
          <h3 style="font-size:.95rem;margin:12px 0 2px">Quota de prazos curtos por ano (limiares fixos)</h3>
          ${hbars((ov.short_year || []).map((r) => [r[0], r[2], null, r[1]]), { fmt: (r) => `${pct1(r[3] ? r[1] / r[3] : null)} ≤ 6 d (bens/serviços, ${nf(r[3])})` })}
          <p class="small muted">A quota de bens/serviços com prazo ≤ 6 dias passa de menos de 1% até 2017 para cerca de 15% desde 2018. A quebra coincide com a revisão do Código dos Contratos Públicos pelo <a href="https://diariodarepublica.pt/dr/detalhe/decreto-lei/111-b-2017-108086621" target="_blank" rel="noopener">Decreto-Lei n.º 111-B/2017, de 31 de agosto</a> (em vigor desde 1 de janeiro de 2018), que encurtou prazos mínimos em procedimentos abaixo dos limiares europeus. Que esta revisão explique a quebra é uma hipótese: os dias mínimos de cada artigo não foram verificados aqui, e uma alteração na forma como o BASE regista o campo também é possível. Por isso o limiar de "prazo curto" (p10) é calculado por regime e por tipo.</p></section>
        <section class="panel"><h2>Preço contratado face ao preço base</h2>
          <p class="small muted">${nf(ov.discount_n)} contratos concorrenciais cujo anúncio tem preço base e um único contrato e nenhum lote (comparação limpa). Mediana: ${ov.discount_median != null ? pct1(ov.discount_median) + " abaixo" : "n/d"}.</p>
          ${hbars(ov.discount_hist || [])}
          <h3 style="font-size:.95rem;margin:12px 0 2px">Ao preço base, por n.º de concorrentes</h3>
          ${hbars((ov.at_base_by_bidders || []).map((r) => [`${r[0]} concorrente(s)`, r[2], null, r[1]]), { fmt: (r) => `${nf(r[1])} de ${nf(r[3])} (${pct1(r[3] ? r[1] / r[3] : null)})` })}
          <p class="small muted">Preço base do anúncio. O campo "preço base" dos contratos não se usa: mistura lotes e acordos-quadro. Anúncios com preço base acima de ${Portal.eur(ov.base_max)} (${nf(ov.base_implausible)} registos) são tratados como erro de registo.</p></section>
        <section class="panel"><h2>Concursos sem anúncio, por ano</h2>
          <p class="small muted">Contratos por procedimento concorrencial sem referência a anúncio (ou com referência inexistente). Por ano de assinatura.</p>
          ${hbars((ov.noann_by_year || []).map((r) => [r[0], r[1], null, r[2]]), { fmt: (r) => `${nf(r[1])} de ${nf(r[3])} (${pct1(r[3] ? r[1] / r[3] : null)})` })}</section>
      </div>

      <section class="panel"><h2>Pesquisar anúncios</h2>
        <form class="an-f" id="an-form"><input type="search" name="q" placeholder="Texto do anúncio ou comprador…" value="${esc(p.q || "")}" aria-label="Texto">
          <input type="search" name="buyer" placeholder="NIF ou nome do comprador" value="${esc(p.buyer || "")}" aria-label="Comprador" style="max-width:200px">
          <input type="search" name="cpv" placeholder="CPV (prefixo)" value="${esc(p.cpv || "")}" aria-label="CPV" style="max-width:130px">
          ${sel("year", years.map((y) => [y, y]), p.year, "Todos os anos")}
          ${sel("procedure", ov.procedures, p.procedure, "Todos os procedimentos")}
          ${sel("status", [["followed", "Com contrato ligado"], ["unfollowed", "Sem contrato (≥13 meses)"], ["short", "Prazo curto (≤ p10 do regime)"]], p.status, "Qualquer estado")}
          <button class="btn" type="submit">Filtrar</button></form>
        <p class="small muted">${nf(se.total)} anúncios · 25 por página · só o primeiro aviso de cada procedimento (prorrogações e retificações contadas à parte).</p>
        ${annTable(se.rows || [])}${Portal.pager(se.total, se.page, se.limit, (n) => link({ page: n }))}</section>

      <section class="panel"><h2>Compradores comparados com os pares</h2>
        <p class="small muted">Só compradores com pelo menos ${ov.min_n} observações e acima da taxa dos pares do mesmo tipo (entities.kind); ordenados pelo desvio (erros-padrão) face à taxa agregada dos pares. Um desvio alto com poucos casos continua a ser um sinal fraco.</p>
        <div class="an-f" style="gap:6px">${flagTabs}</div>
        <p><b>${esc(fl.def?.label || "")}.</b> ${esc(fl.def?.what || "")}</p>
        <form class="an-f" id="an-fk">${sel("ekind", (fl.kinds || []).filter((k) => k.ekind).map((k) => [k.ekind, `${Portal.kindLabel(k.ekind)} (${k.n})`]), p.ekind, "Todos os tipos de entidade")}<input type="hidden" name="kind" value="${esc(kind)}"></form>
        <p class="small muted">${nf(fl.total)} compradores</p>
        ${rankTbl}${Portal.pager(fl.total, fl.page, fl.limit, (n) => link({ kind, fpage: n }))}</section>

      <section class="panel"><h2>Como lemos os dados e o que falta</h2><ul class="small">
        <li><b>Ligação anúncio–contrato:</b> um contrato liga-se ao anúncio com o mesmo número (<code>contracts.announcement</code>) e o mesmo NIF de comprador. ${nf(L.linked)} de ${nf(L.contracts_with_ref)} contratos com referência ligam (${pct1(L.match_rate)}). ${nf(noannAmb)} contratos concorrenciais citam um número que existe com outro NIF: os números repetem-se entre entidades e os NIF mudam em reorganizações — ficam como ambíguos, fora dos indicadores.</li>
        <li><b>Contratos assinados antes de 2013 / anúncios anteriores a 2012</b> não podem ser verificados (o conjunto começa em 2012).</li>
        <li><b>"Sem contrato"</b> não significa que o concurso não foi adjudicado: pode ser deserto, revogado, anulado, repetido com novo anúncio, ou o contrato ainda não foi publicado. ${nf(ov.unfollowed?.n)} concursos; excluídos os que citam o mesmo número noutro comprador e os que não têm NIF.</li>
        <li><b>Lotes e vários contratos por anúncio:</b> excluídos da comparação preço base vs adjudicado, porque o preço base do anúncio é o total.</li>
        <li><b>Fora do âmbito:</b> consulta prévia e ajuste direto não têm anúncio no Diário da República; os acordos-quadro e concursos por lotes têm vários contratos por anúncio.</li>
        <li><b>Prazo:</b> o prazo é a diferença entre a data de publicação e a data limite de propostas no anúncio inicial. Avisos de prorrogação, alteração e retificação (${nf(ov.amend?.total)}) não contam como concursos nem nas estatísticas de prazo; ${nf(ov.amend?.with_original)} têm o anúncio original com o mesmo número e NIF no conjunto, e ${nf(ov.amend?.linked_to_contract)} servem de ligação a contratos quando o original não consta.</li>
      </ul></section>`;
    document.getElementById("an-form")?.addEventListener("submit", (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = link({ q: f.get("q"), buyer: f.get("buyer"), cpv: f.get("cpv"), year: f.get("year"), procedure: f.get("procedure"), status: f.get("status"), page: "" }); });
    document.getElementById("an-fk")?.addEventListener("change", (e) => { const f = new FormData(document.getElementById("an-fk")); location.hash = link({ ekind: f.get("ekind"), kind: f.get("kind"), fpage: "" }); });
  });

  // ---------------------------------------------------------------- vista por comprador
  function buyerBlock(d, nif, compact) {
    const s = d.stats, pr = d.peers || {};
    const rate = (a, b) => (b ? a / b : null);
    const rows = [
      ["Prazo curto (≤ p10 do regime)", s.dl_short, s.n_dl, rate(pr.dls, pr.dl), "concursos públicos com prazo conhecido"],
      ["Concursos sem anúncio associado", s.n_noann, s.n_comp, rate(pr.noann, pr.comp), "contratos concorrenciais desde 2013"],
      ["Anúncios sem contrato ligado", s.n_unfollowed, s.n_eligible_unf, rate(pr.unf, pr.elig), "concursos com ≥ ~13 meses"],
      ["Adjudicado ao preço base", s.n_at_base, s.n_base_cmp, rate(pr.atb, pr.bcmp), "contratos ligados com preço base"],
    ];
    const peerNote = s.kind ? `${nf(pr.n || 0)} entidades do tipo «${esc(Portal.kindLabel(s.kind))}» com anúncios` : "tipo de entidade desconhecido";
    const fl = Object.fromEntries((d.flags || []).map((f) => [f.kind, f]));
    return `<div class="kpis an-kp"><div class="kpi"><b>${nf(s.n_ann)}</b><span>avisos de procedimento (${esc(String(s.first_pub || "").slice(0, 4))}–${esc(String(s.last_pub || "").slice(0, 4))})</span></div>
        <div class="kpi"><b>${nf(s.n_tender)}</b><span>concursos, ${Portal.eur(s.base_total)} de preço base</span></div>
        <div class="kpi"><b>${s.dl_median != null ? days(s.dl_median) : "—"}</b><span>prazo mediano de propostas${d.peer_dl_median != null ? ` (pares: ${d.peer_dl_median} d, ${d.peer_dl_n} entidades)` : ""}</span></div></div>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>Indicador</th><th class="num">Comprador</th><th class="num">Pares (${esc(peerNote)})</th><th>Leitura</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r[0])}<div class="small muted">${esc(r[4])}</div></td><td class="num"><b>${nf(r[1])}</b> / ${nf(r[2])}<div class="small">${pct1(rate(r[1], r[2]))}</div></td><td class="num">${pct1(r[3])}</td><td class="small">${r[2] < ((d.min_n) || 10) ? '<span class="muted">poucos casos para comparar</span>' : rate(r[1], r[2]) > (r[3] ?? 1) * 1.5 && r[1] >= 3 ? '<span class="tag amber">acima dos pares</span>' : '<span class="muted">dentro do esperado</span>'}</td></tr>`).join("")}</tbody></table></div>
      ${(d.flags || []).length ? `<h3 style="font-size:1rem;margin:12px 0 4px">Sinais face aos pares</h3>${d.flags.map((f) => `<div class="flag"><div><b>${esc(d.defs[f.kind]?.label || f.kind)}</b> <span class="tag amber">${pct1(f.rate)} vs ${pct1(f.peer_rate)} nos pares</span>
        <p class="small">${esc(d.defs[f.kind]?.what || "")}</p><details class="an"><summary class="small">evidência</summary>${evidence(f.kind, f.evidence)}</details></div></div>`).join("")}` : '<p class="small muted">Sem sinais acima dos pares (com o mínimo de observações exigido).</p>'}`;
  }

  async function buyerPage(nif) {
    $app.innerHTML = `${css}<p class="muted">A carregar…</p>`;
    const d = await Portal.api("anuncios/buyer?nif=" + encodeURIComponent(nif));
    if (!d.available || !d.found) { $app.innerHTML = `${css}<div class="pagehead"><div><h1>Anúncios</h1></div></div><p class="note warn">${esc(d.note || "Sem anúncios para este NIF.")}</p><p><a href="#/anuncios">← Concursos e anúncios</a></p>`; return; }
    const s = d.stats;
    d.min_n = 10;
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker"><a href="#/anuncios">Concursos e anúncios</a> · comprador</div><h1>${esc(s.name || nif)}</h1><p class="small muted">NIF ${esc(nif)} · ${esc(Portal.kindLabel(s.kind) || "tipo n/d")}${s.entity_id ? ` · <a href="#/entidade/${s.entity_id}">perfil da entidade</a>` : ""} · <a href="#/contratos?buyer=${esc(nif)}">contratos →</a></p></div></div>
      ${NOTE}<section class="panel"><h2>Indicadores face aos pares</h2>${buyerBlock(d, nif)}</section>
      <section class="panel"><h2>Por ano</h2>${hbars(d.byYear.map((r) => [r.year, r.n, r.unfollowed]), { fmt: (r) => `${nf(r[1])}${r[2] ? ` · ${nf(r[2])} s/ contrato` : ""}` })}</section>
      <section class="panel"><h2>Anúncios recentes</h2>${annTable(d.recent, { noBuyer: true })}<p><a href="#/anuncios${Portal.qs({ buyer: nif })}">Todos os anúncios deste comprador →</a></p></section>
      ${d.noann.length ? `<section class="panel"><h2>Contratos concorrenciais sem anúncio associado</h2>${Portal.table([
        { h: "Assinado", f: (r) => Portal.fmtDate(r.signed) }, { h: "Contrato", f: (r) => `${ctr(r.contract_id, (r.object || "").slice(0, 110))}<div class="small muted">${esc(r.procedure)} → ${esc(r.seller_name || "")}</div>` },
        { h: "Referência", f: (r) => esc(r.reason === "sem_referencia" ? "sem referência" : r.reason === "outro_comprador" ? `${r.announcement_ref} (existe com outro NIF)` : `${r.announcement_ref} (inexistente)`) },
        { h: "Preço", num: 1, f: (r) => Portal.eurFull(r.price) }], d.noann)}</section>` : ""}`;
  }

  // ---------------------------------------------------------------- secção nas páginas de entidade
  Portal.entityHooks.push(async (data, el) => {
    const nif = data?.entity?.nif;
    if (!nif) return;
    const d = await Portal.api("anuncios/buyer?nif=" + encodeURIComponent(nif));
    if (!d || d.available === false || !d.found || !d.stats.n_ann) return;
    d.min_n = 10;
    el.insertAdjacentHTML("beforeend", `${css}<section class="panel"><h2>Anúncios de concurso</h2>
      <p class="small muted">Indicadores estatísticos comparados com entidades do mesmo tipo — <b>não são acusações</b>. <a href="#/anuncios/${esc(nif)}">Vista completa →</a></p>
      ${buyerBlock(d, nif, true)}
      <h3 style="font-size:1rem;margin:12px 0 4px">Anúncios recentes</h3>${annTable(d.recent.slice(0, 6), { noBuyer: true })}</section>`);
  });
})();
