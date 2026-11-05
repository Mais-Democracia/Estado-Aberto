"use strict";
/* Módulo "autarquias": secções "Quem governa" e "Como gasta" nas páginas de município/freguesia + página #/autarquias-mapa
   (tabela comparativa dos 308 municípios). API: /api/autarquias/*  — fontes: MAI/SGMAI (eleições), DGAL (contas, dívida). */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const eur = Portal.eur, int = Portal.int;
  const pc = (v) => (v == null ? "—" : `${int(Math.round(v))} €`);
  const pct = (v, d = 1) => (v == null ? "—" : `${Number(v).toFixed(d).replace(".", ",")}%`);
  const TYPE = { partido: "partido", coligacao: "coligação", grupo_cidadaos: "grupo de cidadãos" };

  // Conventional party colours — identity only; the acronym is always printed next to the mark.
  function partyColor(p) {
    const a = String(p || "").toUpperCase();
    if (/PPD\/PSD|^PSD|\.PSD|PSD\./.test(a)) return "#e8862a";
    if (/^PS$|^PS\.|\.PS$|\.PS\./.test(a)) return "#d6337a";
    if (/PCP|CDU/.test(a)) return "#c62828";
    if (/^CH$|CHEGA/.test(a)) return "#1a237e";
    if (/CDS/.test(a)) return "#1f6fb5";
    if (/^IL$|\bIL\b/.test(a)) return "#00a3d9";
    if (/B\.E\.|^BE$/.test(a)) return "#7b1f1f";
    if (/^L$|LIVRE/.test(a)) return "#5a9e3a";
    if (/PAN/.test(a)) return "#00897b";
    if (/JPP/.test(a)) return "#2e7d32";
    return "#7a8090";
  }
  const chip = (p) => `<span class="aut-chip"><i style="background:${partyColor(p)}"></i>${esc(p || "—")}</span>`;
  const css = `<style>
    .aut-chip{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.aut-chip i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
    .aut-seats{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0 10px}.aut-seats i{width:18px;height:18px;border-radius:4px;display:inline-block}
    .aut-hbar{display:grid;grid-template-columns:minmax(90px,170px) 1fr 64px;gap:8px;align-items:center;margin:3px 0;font-size:.9rem}
    .aut-hbar .t{background:var(--line2);border-radius:4px;height:14px;overflow:hidden}.aut-hbar .t i{display:block;height:100%;border-radius:0 4px 4px 0}
    .aut-hbar .v{text-align:right;font-variant-numeric:tabular-nums}
    .aut-yr{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
    .aut-vbars{display:flex;align-items:flex-end;gap:10px;height:150px;padding-top:8px;border-bottom:1px solid var(--line)}
    .aut-vbars .c{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:26px}
    .aut-vbars .b{width:70%;max-width:46px;background:var(--bar);border-radius:4px 4px 0 0}
    .aut-vbars .l{font-size:.75rem;color:var(--muted);margin-top:4px}.aut-vbars .n{font-size:.72rem;color:var(--muted);margin-bottom:3px;font-variant-numeric:tabular-nums}
    .aut-rank{font-size:.8rem;color:var(--muted)}
    .aut-tbl td,.aut-tbl th{white-space:nowrap}.aut-tbl td:first-child{white-space:normal;min-width:220px}
    .aut-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.aut-filters input{flex:1;min-width:200px}
  </style>`;

  const hbars = (rows, valueKey = "pct", fmt = (v) => pct(v)) => {
    const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
    return rows.map((r) => `<div class="aut-hbar" title="${esc(r.party)}: ${int(r.votes)} votos · ${pct(r.pct)} · ${r.mandates ?? 0} mandato(s)">
      <span>${chip(r.party)}</span><span class="t"><i style="width:${100 * (r[valueKey] || 0) / max}%;background:${partyColor(r.party)}"></i></span><span class="v">${fmt(r[valueKey])}</span></div>`).join("");
  };
  const seats = (results) => `<div class="aut-seats" role="img" aria-label="Distribuição de mandatos">${results.filter((r) => r.mandates > 0).flatMap((r) => Array.from({ length: r.mandates }, () => `<i title="${esc(r.party)}" style="background:${partyColor(r.party)}"></i>`)).join("")}</div>`;
  const vbars = (items, fmt) => {
    const max = Math.max(1, ...items.map((i) => i.v || 0));
    return `<div class="aut-vbars">${items.map((i) => `<div class="c" title="${esc(i.l)}: ${esc(fmt(i.v))}"><span class="n">${esc(fmt(i.v))}</span><div class="b" style="height:${Math.max(2, 110 * (i.v || 0) / max)}px"></div><span class="l">${esc(i.l)}</span></div>`).join("")}</div>`;
  };
  const rankTxt = (r, n, what) => (r ? `<span class="aut-rank">${r}.º de ${n} em ${what}</span>` : "");

  /* ------------------------------------------------------------- CIM / AM entity pages */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || e.kind !== "cim_am") return;
    let d;
    try { d = await Portal.api("autarquias/cim?id=" + encodeURIComponent(e.id)); } catch { return; }
    if (!d.available || !d.found) return;
    const c = d.cim;
    el.insertAdjacentHTML("beforeend", css + `<section class="panel"><h2>Municípios membros e contas agregadas</h2>
      <div class="kpis"><div class="kpi"><b>${int(c.n_municipios)}</b><span>municípios (território NUTS III 2024${c.nuts3 === "AML" ? ": Grande Lisboa + Península de Setúbal" : ""})</span></div>
        <div class="kpi"><b>${int(c.population)}</b><span>habitantes (Censos 2021)</span></div>
        <div class="kpi"><b>${eur(c.transfer_oe2026)}</b><span>transferência do Orçamento do Estado 2026 para a ${esc(cimLabel(c))}</span></div>
        <div class="kpi"><b>${eur(c.expense)}</b><span>despesa paga dos municípios membros em ${c.fin_year} (soma)</span></div>
        <div class="kpi"><b>${eur(c.debt)}</b><span>dívida total dos municípios membros ${c.debt_year} (soma)</span></div></div>
      ${Portal.table([
        { h: "Município", f: (r) => (r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : esc(r.name)) }, { h: "Partido no poder", f: (r) => chip(r.party) },
        { h: "População", num: 1, f: (r) => int(r.population) }, { h: "Despesa/hab.", num: 1, f: (r) => pc(r.expense_pc) }, { h: "Dívida/hab.", num: 1, f: (r) => pc(r.debt_pc) }, { h: "% pessoal", num: 1, f: (r) => pct(r.personnel_pct) },
      ], d.members)}
      <p class="note">As contas próprias das CIM/áreas metropolitanas (receita, despesa, dívida da própria entidade) não são publicadas em formato aberto pela DGAL nem pelo INE; mostram-se a transferência do OE (${ext(c.source_url, "DGAL, mapa AM/CIM OE 2026")}) e a soma das contas dos municípios membros (DGAL). Pertença por NUTS III 2024 (${ext(c.nuts_source_url, "INE")}).</p></section>`);
  });

  /* ------------------------------------------------------------- entity hook */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !["municipio", "freguesia"].includes(e.kind)) return;
    let d;
    try { d = await Portal.api("autarquias/municipio?id=" + encodeURIComponent(e.id)); } catch { return; }
    if (!d.available) { el.insertAdjacentHTML("beforeend", `<p class="note warn">${esc(d.note)}</p>`); return; }
    if (!d.found) {
      el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Quem governa</h2><p class="note">Não foi possível associar esta ${e.kind === "freguesia" ? "freguesia" : "entidade"} aos resultados eleitorais do MAI (associação por NIF/nome).</p></section>`);
      return;
    }
    el.insertAdjacentHTML("beforeend", css + (d.level === "freguesia" ? freguesiaHtml(d) : governaHtml(d) + gastaHtml(d)));
  });

  function freguesiaHtml(d) {
    const af = d.elections[2025]?.AF, af21 = d.elections[2021]?.AF;
    const win = af ? af.results.find((r) => r.president) || af.results[0] : null;
    return `<section class="panel"><h2>Quem governa</h2>
      ${win ? `<div class="kpis"><div class="kpi"><b>${chip(win.party)}</b><span>lista mais votada para a Assembleia de Freguesia (2025) — o cabeça de lista preside à Junta</span></div>
        <div class="kpi"><b>${pct(win.pct)}</b><span>dos votos · ${win.mandates} de ${af.total_mandates} mandatos</span></div><div class="kpi"><b>${pct(af.turnout)}</b><span>participação</span></div></div>` : ""}
      <div class="aut-yr">${af ? `<div><h3>Assembleia de Freguesia 2025</h3>${seats(af.results)}${hbars(af.results.slice(0, 8))}</div>` : ""}
        ${af21 ? `<div><h3>2021</h3>${seats(af21.results)}${hbars(af21.results.slice(0, 8))}</div>` : ""}</div>
      <p class="small muted">Município: <b>${esc(d.parent?.name || "")}</b>${d.parent?.mayor ? ` — presidente da câmara ${esc(d.parent.mayor)} (${esc(d.parent.party || "")})` : ""}. O nome do presidente da junta não é publicado nos dados abertos do MAI.
        Fonte: ${ext(af?.source_url, "MAI — Autárquicas 2025")}.</p></section>`;
  }

  function governaHtml(d) {
    const m = d.metrics, p = d.people, cm = d.elections[2025]?.CM, am = d.elections[2025]?.AM;
    const yrs = [2025, 2021, 2017].filter((y) => d.elections[y]?.CM);
    const major = m.majority ? "maioria absoluta" : "sem maioria absoluta";
    const lists = p.heads2025.map((h) => ({ ...h, res: (cm?.results || []).find((r) => r.party === h.party) || {} })).sort((a, b) => (b.res.votes || 0) - (a.res.votes || 0));
    return `<section class="panel" id="aut-governa"><h2>Quem governa</h2>
      <div class="kpis">
        <div class="kpi"><b style="font-size:1.15rem">${esc(p.mayor?.name || "—")}</b><span>Presidente da Câmara (eleito/a em 12-10-2025)</span></div>
        <div class="kpi"><b>${chip(m.party)}</b><span>${esc(p.mayor?.list_name || "")}${p.mayor?.party_type ? ` · ${esc(TYPE[p.mayor.party_type] || p.mayor.party_type)}` : ""}</span></div>
        <div class="kpi"><b>${pct(m.winner_pct)}</b><span>dos votos · ${esc(major)}${cm ? ` (${(cm.results.find((r) => r.party === m.party) || {}).mandates ?? "?"} de ${cm.total_mandates} vereadores)` : ""}</span></div>
        <div class="kpi"><b>${pct(m.turnout_2025)}</b><span>participação eleitoral 2025</span></div>
      </div>
      ${m.changed_2025 ? `<div class="flag info"><div><b>Mudança de cor política em 2025</b><p>Em 2021 venceu ${esc(m.party_2021)}${p.mayor2021 ? ` (${esc(p.mayor2021.name)})` : ""}; em 2025 venceu ${esc(m.party)}.</p></div></div>` : m.party_2021 ? `<p class="small muted">Em 2021 a câmara foi ganha por ${esc(m.party_2021)}${p.mayor2021 ? ` (presidente ${esc(p.mayor2021.name)})` : ""}${m.party_2017 ? `; em 2017 por ${esc(m.party_2017)}` : ""}.</p>` : ""}
      <h3>Composição da Câmara Municipal (mandato 2025-2029)</h3>
      ${cm ? seats(cm.results) : ""}
      ${Portal.table([
        { h: "Lista", f: (r) => `${chip(r.party)}<div class="small muted">${esc(r.list_name || "")}${r.party_type ? ` · ${esc(TYPE[r.party_type] || r.party_type)}` : ""}</div>` },
        { h: "Votos", num: 1, f: (r) => int(r.res.votes) }, { h: "%", num: 1, f: (r) => pct(r.res.pct) },
        { h: "Vereadores", num: 1, f: (r) => r.res.mandates ?? 0 },
        { h: "Cabeça de lista", f: (r) => `${esc(r.name)}<div class="small muted">${r.role === "presidente" ? "<b>Presidente da Câmara</b>" : r.elected ? "eleito/a vereador/a (1.º da lista)" : "não eleito/a"}</div>` },
      ], lists)}
      <p class="note">Os nomes dos restantes vereadores, a distribuição de pelouros e o presidente da Assembleia Municipal (eleito internamente) não são publicados em dados abertos pelo MAI; constam das atas e dos sítios de cada câmara.</p>
      <h3>Resultados para a Câmara Municipal</h3>
      <div class="aut-yr">${yrs.map((y) => { const e = d.elections[y].CM; return `<div><h4>${y} <span class="small muted">· participação ${pct(e.turnout)}</span></h4>${hbars(e.results.slice(0, 7))}</div>`; }).join("")}</div>
      ${am ? `<h3>Assembleia Municipal 2025</h3>${seats(am.results)}<div class="small muted">${am.results.filter((r) => r.mandates > 0).map((r) => `${esc(r.party)} ${r.mandates}`).join(" · ")} — ${am.total_mandates} membros eleitos diretamente (mais os presidentes de junta, por inerência).</div>` : ""}
      ${d.freguesias.length ? `<details style="margin-top:12px"><summary><b>Freguesias (${d.freguesias.length}) — lista vencedora 2025 vs 2021</b></summary>${Portal.table([
        { h: "Freguesia", f: (r) => esc(r.name) }, { h: "2025", f: (r) => chip(r.party25) }, { h: "%", num: 1, f: (r) => pct(r.pct25) },
        { h: "2021", f: (r) => `${chip(r.party21)}${r.party21 && r.party25 && r.party21 !== r.party25 ? ' <span class="tag">mudou</span>' : ""}` },
      ], d.freguesias)}</details>` : ""}
      <p class="small muted">Fonte: ${ext(cm?.source_url, "MAI/SGMAI — Autárquicas 2025")} (inclui 2021) · ${ext(d.elections[2021]?.CM?.source_url, "Autárquicas 2021")} (inclui 2017) · candidatos: ${ext(p.mayor?.source_url, "MAI")}.</p>
    </section>`;
  }

  function gastaHtml(d) {
    const m = d.metrics, pr = d.peers, nif = m.entity_nif || m.nif, L = d.labels.despesa || {};
    const fin = d.finance, last = fin[fin.length - 1];
    const tot = (o, skip = []) => Object.entries(o || {}).filter(([k]) => !skip.includes(k)).reduce((a, [, v]) => a + (v || 0), 0);
    const debt = d.debt;
    const pcRow = (label, v, med, rank, fmt) => `<tr><td>${label}</td><td class="num">${fmt(v)}</td><td class="num">${fmt(med)}</td><td class="num">${rank ? `${rank}.º / ${pr.n}` : "—"}</td></tr>`;
    return `<section class="panel" id="aut-gasta"><h2>Como gasta${last ? ` <span class="small muted">· contas de ${last.year}</span>` : ""}</h2>
      ${last ? `<div class="kpis">
        <div class="kpi"><b>${eur(m.expense)}</b><span>despesa paga em ${m.fin_year}</span></div>
        <div class="kpi"><b>${pc(m.expense_pc)}</b><span>por habitante ${rankTxt(m.rank_expense_pc, pr.n, "despesa/hab.")}</span></div>
        <div class="kpi"><b>${pct(m.personnel_pct)}</b><span>da despesa em pessoal</span></div>
        <div class="kpi"><b>${pct(m.invest_pct)}</b><span>em investimento (bens de capital)</span></div>
        <div class="kpi"><b>${eur(m.debt)}</b><span>dívida total ${m.debt_year || ""}${m.debt_pct_limit != null ? ` · ${pct(m.debt_pct_limit, 0)} do limite legal` : ""}</span></div>
        <div class="kpi"><b>${pct(m.own_revenue_pct)}</b><span>da receita é própria (impostos, taxas, vendas)</span></div>
        <div class="kpi"><b>${int(m.population)}</b><span>População (${/Censos 2021/.test(m.population_source || "") ? "Censos 2021 · INE" : esc(`${m.population_source || "—"} ${m.population_year || ""}`)}) — base dos valores por habitante</span></div>
      </div>` : '<p class="note warn">Sem contas de gerência DGAL associadas a este município.</p>'}
      ${nif ? `<p><a class="btn primary" href="#/contratos?buyer=${esc(nif)}">Ver os contratos públicos deste município →</a> <span class="small muted">— a quem a câmara paga, por ajuste direto ou concurso.</span></p>` : ""}
      <div class="cols">
        ${fin.length ? `<div><h3>Despesa paga por ano</h3>${vbars(fin.map((y) => ({ l: String(y.year), v: tot(y.despesa) })), eur)}</div>` : ""}
        ${debt.length ? `<div><h3>Dívida total (31 dez.)</h3>${vbars(debt.slice(-8).map((y) => ({ l: String(y.year), v: y.debt_total })), eur)}<p class="small muted">Limite legal ${debt.at(-1).year}: ${eur(debt.at(-1).debt_limit)} (art. 52.º Lei 73/2013).</p></div>` : ""}
      </div>
      ${fin.length ? `<h3>Despesa por agrupamento económico</h3>${Portal.table([
        { h: "Agrupamento", f: (r) => esc(L[r] || r) },
        ...fin.map((y) => ({ h: String(y.year), num: 1, f: (r) => eur(y.despesa[r]) })),
        { h: `% ${last.year}`, num: 1, f: (r) => pct(100 * (last.despesa[r] || 0) / (tot(last.despesa) || 1)) },
      ], Object.keys(L).sort().filter((k) => fin.some((y) => y.despesa[k])), {})}
      <h3>Receita cobrada (${last.year})</h3>${hbarsMoney(Object.entries(last.receita).filter(([k, v]) => k !== "16" && v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ l: (d.labels.receita || {})[k] || k, v })))}
      ${last.receita["16"] ? `<p class="small muted">Saldo da gerência anterior (excluído do total): ${eur(last.receita["16"])}.</p>` : ""}` : ""}
      ${budgetHtml(d)}
      ${pmpHtml(d)}
      ${d.cim ? `<p class="small">Integra ${d.cim.entity_id ? `<a href="#/entidade/${d.cim.entity_id}">${esc(cimLabel(d.cim))}</a>` : esc(cimLabel(d.cim))} (${d.cim.n_municipios} municípios).</p>` : ""}
      <h3>Comparação com os ${pr.n} municípios</h3>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>Indicador (${m.fin_year || "—"})</th><th class="num">Este município</th><th class="num">Mediana nacional</th><th class="num">Posição (maior = 1.º)</th></tr></thead><tbody>
        ${pcRow("Despesa por habitante", m.expense_pc, pr.median.expense_pc, m.rank_expense_pc, pc)}
        ${pcRow("Dívida por habitante", m.debt_pc, pr.median.debt_pc, m.rank_debt_pc, pc)}
        ${pcRow("% despesa com pessoal", m.personnel_pct, pr.median.personnel_pct, m.rank_personnel_pct, pct)}
        ${pcRow("% despesa em investimento", m.invest_pct, pr.median.invest_pct, m.rank_invest_pct, pct)}
        ${pcRow("% receita própria", m.own_revenue_pct, pr.median.own_revenue_pct, null, pct)}
      </tbody></table></div>
      <details style="margin-top:10px"><summary><b>Municípios do distrito de ${esc(pr.district)}</b></summary>${Portal.table([
        { h: "Município", f: (r) => (r.dico === m.dico ? `<b>${esc(r.name)}</b>` : esc(r.name)) }, { h: "Partido", f: (r) => chip(r.party) },
        { h: "Despesa/hab.", num: 1, f: (r) => pc(r.expense_pc) }, { h: "Dívida/hab.", num: 1, f: (r) => pc(r.debt_pc) }, { h: "% pessoal", num: 1, f: (r) => pct(r.personnel_pct) },
      ], pr.districtRows)}</details>
      <p class="small muted">Despesa paga e receita cobrada líquidas (base de caixa), Demonstrações de Execução Orçamental — ${ext(last?.source_url?.despesa, "DGAL, Contas de Gerência")}; dívida — ${ext(debt.at(-1)?.source_url, "DGAL, Evolução do endividamento")}. População (denominador de todos os valores por habitante): ${esc(d.municipio.population_source || "—")} = ${int(m.population)} hab.${d.municipio.population_est_2023 ? ` A estimativa anual do INE para 2023 (base administrativa, indicador 0008273) é ${int(d.municipio.population_est_2023)} hab.; não é usada por não ser comparável com os Censos.` : ""}
        Orçamento inicial/corrigido vs. execução não está disponível em formato aberto para 2020+ (a DGAL só publica a execução). <a href="#/autarquias-mapa">Comparar todos os municípios →</a></p>
    </section>`;
  }

  const cimLabel = (c) => (/^Região Autónoma/.test(c.name) ? c.name : /Área Metropolitana/.test(c.name) ? c.name : `CIM ${c.name}`);
  function budgetHtml(d) {
    const b = d.budget || [];
    if (!b.length) return "";
    const rate = (x) => (x.orcamento ? pct(100 * x.executado / x.orcamento, 1) : "—");
    return `<h3>Orçamento vs. execução (${b[0].year}–${b.at(-1).year})</h3>
      ${Portal.table([
        { h: "Ano", f: (r) => String(r.year) },
        { h: "Despesa orçamentada (dotações corrigidas)", num: 1, f: (r) => eur(r.despesa.orcamento) }, { h: "Despesa paga", num: 1, f: (r) => eur(r.despesa.executado) },
        { h: "% execução despesa", num: 1, f: (r) => `<span class="meter"><i style="width:${Math.min(100, r.despesa.orcamento ? 100 * r.despesa.executado / r.despesa.orcamento : 0)}%"></i></span>${rate(r.despesa)}` },
        { h: "Receita prevista (corrigida)", num: 1, f: (r) => eur(r.receita.orcamento) }, { h: "Receita cobrada", num: 1, f: (r) => eur(r.receita.executado) },
        { h: "% execução receita", num: 1, f: (r) => rate(r.receita) },
        { h: "% execução investimento (07)", num: 1, f: (r) => { const c = r.despesa.chapters["07"] || {}; return c.orcamento ? pct(100 * (c.executado || 0) / c.orcamento, 1) : "—"; } },
      ], b)}
      <p class="note">Orçamento = previsões/dotações <b>corrigidas</b> (orçamento final após alterações), DGAL — ${ext(d.budget_source, "Contas de Gerência 2015–2019")}. Receita exclui o saldo da gerência anterior. <b>A partir de 2020 a DGAL só publica a execução</b> (despesa paga, receita cobrada) — não é possível comparar com o orçamento nesses anos.</p>`;
  }
  function pmpHtml(d) {
    const all = d.pmp || [], full = all.filter((r) => !r.partial), part = all.filter((r) => r.partial);
    if (!all.length) return "";
    const last = full.at(-1), ye = full.filter((r) => r.date.endsWith("12-31"));
    return `<h3>Prazo médio de pagamento a fornecedores</h3>
      <div class="kpis"><div class="kpi"><b>${last ? int(last.days) + " dias" : "—"}</b><span>em ${last ? fmtD(last.date) : "—"}</span></div>
        ${part.length ? `<div class="kpi"><b>${int(part.at(-1).days)} dias</b><span>em ${fmtD(part.at(-1).date)} — consta da lista DGAL de municípios com PMP &gt; 60 dias</span></div>` : ""}</div>
      ${ye.length > 1 ? vbars(ye.map((r) => ({ l: r.date.slice(0, 4), v: r.days })), (v) => `${int(v)} d`) : ""}
      <p class="small muted">Fonte: ${ext((last || all.at(-1)).source_url, "DGAL — Prazo médio de pagamentos")}. Lei dos compromissos: acima de 60 dias há obrigações de redução de pagamentos em atraso.${part.length ? "" : " Os dados trimestrais de 2026 só listam municípios acima de 60 dias; este município não consta."}</p>`;
  }
  const fmtD = (iso) => iso.split("-").reverse().join("/");
  const hbarsMoney = (rows) => { const max = Math.max(1, ...rows.map((r) => r.v)); return rows.map((r) => `<div class="aut-hbar" title="${esc(r.l)}: ${esc(Portal.eurFull(r.v))}"><span class="small">${esc(r.l)}</span><span class="t"><i style="width:${100 * r.v / max}%;background:var(--bar)"></i></span><span class="v">${eur(r.v)}</span></div>`).join(""); };

  /* ------------------------------------------------------------- comparison page */
  Portal.nav("Câmaras: poder e contas", "#/autarquias-mapa");
  Portal.page("autarquias-mapa", async (_, p) => {
    const sort = p.sort || "expense_pc", dir = p.dir || (["name", "district", "party"].includes(sort) ? "asc" : "desc");
    const [d, pt] = await Promise.all([Portal.api("autarquias/list" + Portal.qs({ sort, dir, district: p.district, party: p.party, q: p.q })), Portal.api("autarquias/partidos")]);
    if (!d.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Câmaras municipais</h1></div></div><p class="note warn">${esc(d.note)}</p>`; return; }
    const link = (o) => `#/autarquias-mapa${Portal.qs({ ...p, ...o })}`;
    const th = (key, label, num) => `<th class="${num ? "num" : ""}"><a href="${link({ sort: key, dir: sort === key && dir === "desc" ? "asc" : "desc" })}" class="${sort === key ? "on" : ""}">${esc(label)}${sort === key ? (dir === "desc" ? " ↓" : " ↑") : ""}</a></th>`;
    const sel = (id, opts, cur, all) => `<select id="${id}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${o[0] === cur ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
    const top = pt["2025"].slice(0, 8);
    if (p.view === "partido") return partyView(p, d);
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/autarquias">Autarquias</a> / Poder e contas</div>
      <div class="pagehead"><div><div class="kicker">Poder local · eleições 2025 · contas ${esc(d.fin_year)}</div><h1>Quem governa cada câmara e como gasta</h1>
        <p class="lead">Os 308 municípios: partido no poder, presidente eleito em 2025, despesa por habitante, peso do pessoal e do investimento, e dívida face ao limite legal. Clique num cabeçalho para ordenar.</p></div>
        <div><a class="btn" href="#/autarquias-mapa?view=partido">Por partido no poder →</a> <a class="btn" href="/api/autarquias/list?sort=${esc(sort)}&dir=${esc(dir)}" target="_blank">JSON</a></div></div>
      <div class="cols"><section class="panel"><h2>Câmaras por força política (2025)</h2>${hbarsCount(top)}<p class="small muted">Em 2021: ${pt["2021"].slice(0, 5).map((r) => `${esc(r.party)} ${r.n}`).join(" · ")}. Coligações contadas pela sigla com que concorreram.</p></section>
        <section class="panel"><h2>Juntas de freguesia por força política (2025)</h2>${hbarsCount(pt.freguesias2025.slice(0, 8))}</section></div>
      <div class="aut-filters"><input type="search" id="aq" placeholder="Filtrar município" value="${esc(p.q || "")}">
        ${sel("ad", d.districts.map((x) => [x, x]), p.district, "Todos os distritos")}${sel("ap", d.parties.map((x) => [x.party, `${x.party} (${x.n})`]), p.party, "Todas as forças políticas")}</div>
      <p class="small muted">${d.rows.length} municípios · medianas nacionais: despesa ${pc(d.peers.median.expense_pc)}/hab., dívida ${pc(d.peers.median.debt_pc)}/hab., pessoal ${pct(d.peers.median.personnel_pct)} da despesa.</p>
      <div class="panel" style="padding:0"><div class="tblwrap"><table class="tbl aut-tbl"><thead><tr>
        ${th("name", "Município")}${th("party", "Partido no poder")}${th("winner_pct", "% 2025", 1)}${th("population", "População (Censos 2021)", 1)}
        ${th("expense", "Despesa", 1)}${th("expense_pc", "€/hab.", 1)}${th("personnel_pct", "% pessoal", 1)}${th("invest_pct", "% invest.", 1)}
        ${th("own_revenue_pct", "% receita própria", 1)}${th("debt_pc", "Dívida €/hab.", 1)}${th("debt_pct_limit", "% do limite", 1)}${th("pmp_days", "PMP (dias)", 1)}</tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>${r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : esc(r.name)}<div class="small muted">${esc(r.district || "")}${r.mayor ? ` · ${esc(r.mayor)}` : ""}</div></td>
          <td>${chip(r.party)}${r.changed_2025 ? ` <span class="tag" title="Em 2021: ${esc(r.party_2021)}">mudou</span>` : ""}</td><td class="num">${pct(r.winner_pct)}</td><td class="num">${int(r.population)}</td>
          <td class="num">${eur(r.expense)}</td><td class="num">${pc(r.expense_pc)}</td><td class="num">${pct(r.personnel_pct)}</td><td class="num">${pct(r.invest_pct)}</td>
          <td class="num">${pct(r.own_revenue_pct)}</td><td class="num">${pc(r.debt_pc)}</td><td class="num">${pct(r.debt_pct_limit, 0)}</td><td class="num">${r.pmp_days ?? "—"}</td></tr>`).join("") || '<tr><td colspan="12" class="empty">Sem resultados.</td></tr>'}
      </tbody></table></div></div>
      <p class="small muted">Fontes: MAI/SGMAI (resultados autárquicos 2017, 2021, 2025), DGAL — Contas de Gerência ${esc(d.fin_year)} (despesa paga, receita cobrada) e Evolução do endividamento ${esc(d.debt_year)}. População: INE, Censos 2021 (indicador 0011609). Exportação para análise: <code>data/exports/autarquias.csv</code>. Atualizado ${esc(String(d.updated || "").slice(0, 10))}.</p>`;
    document.getElementById("aq").onchange = (e) => Portal.go("autarquias-mapa", "", { ...p, q: e.target.value });
    document.getElementById("ad").onchange = (e) => Portal.go("autarquias-mapa", "", { ...p, district: e.target.value });
    document.getElementById("ap").onchange = (e) => Portal.go("autarquias-mapa", "", { ...p, party: e.target.value });
  });
  async function partyView(p, d) {
    const g = await Portal.api("autarquias/por-partido");
    const fam = p.family || "";
    const rows = fam ? (await Portal.api("autarquias/list" + Portal.qs({ family: fam, sort: p.sort || "expense_pc", dir: p.dir || "desc" }))).rows : [];
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/autarquias-mapa">Poder e contas</a> / Por partido no poder</div>
      <div class="pagehead"><div><div class="kicker">Contas ${esc(g.fin_year)} · câmaras eleitas em 2025</div><h1>Como gastam as câmaras, por partido no poder</h1>
        <p class="lead">Medianas por força política que preside à câmara desde as eleições de 12-10-2025. As contas de ${esc(g.fin_year)} refletem sobretudo o mandato anterior.</p></div>
        <div><a class="btn" href="#/autarquias-mapa">← Todos os municípios</a></div></div>
      <div class="panel" style="padding:0">${Portal.table([
        { h: "Partido (principal da lista)", f: (r) => `<a href="#/autarquias-mapa?view=partido&family=${encodeURIComponent(r.party)}">${chip(r.party)}</a>` },
        { h: "N.º câmaras", num: 1, f: (r) => int(r.n) }, { h: "População governada", num: 1, f: (r) => int(r.population) },
        { h: "Despesa €/hab. (mediana)", num: 1, f: (r) => pc(r.expense_pc) }, { h: "% pessoal (mediana)", num: 1, f: (r) => pct(r.personnel_pct) },
        { h: "% investimento (mediana)", num: 1, f: (r) => pct(r.invest_pct) }, { h: "Dívida €/hab. (mediana)", num: 1, f: (r) => pc(r.debt_pc) },
        { h: "PMP dias (mediana)", num: 1, f: (r) => (r.pmp_days == null ? "—" : int(r.pmp_days)) },
      ], g.rows)}</div>
      <p class="note">Descritivo, não causal: os grupos diferem em dimensão, região e população (ex.: concelhos pequenos do interior têm despesa por habitante muito superior), e com poucos casos (n pequeno) a mediana é instável. Coligações contam pelo partido principal (PPD/PSD.CDS-PP → PPD/PSD); listas de cidadãos agrupadas.</p>
      ${fam ? `<h2>${chip(fam)} — ${rows.length} câmaras</h2><div class="panel" style="padding:0">${Portal.table([
        { h: "Município", f: (r) => (r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : esc(r.name)) + `<div class="small muted">${esc(r.district || "")} · ${esc(r.party)}</div>` },
        { h: "População", num: 1, f: (r) => int(r.population) }, { h: "€/hab.", num: 1, f: (r) => pc(r.expense_pc) }, { h: "% pessoal", num: 1, f: (r) => pct(r.personnel_pct) },
        { h: "Dívida €/hab.", num: 1, f: (r) => pc(r.debt_pc) }, { h: "PMP", num: 1, f: (r) => r.pmp_days ?? "—" },
      ], rows)}</div>` : ""}`;
  }
  const hbarsCount = (rows) => { const max = Math.max(1, ...rows.map((r) => r.n)); return rows.map((r) => `<div class="aut-hbar"><span>${chip(r.party)}</span><span class="t"><i style="width:${100 * r.n / max}%;background:${partyColor(r.party)}"></i></span><span class="v">${int(r.n)}</span></div>`).join(""); };
})();
