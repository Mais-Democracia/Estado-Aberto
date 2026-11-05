"use strict";
/* Módulo "estado_empresas": #/estado (O Estado em números: emprego público + empresas do Estado) e #/estado/empresa/<id>.
   API: /api/estado/*  — DGAEP (SIOE) e ETF (Carteira de Participações do Estado), dados.gov.pt. */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const f1 = (v, d = 1) => (v == null ? "—" : Number(v).toLocaleString("pt-PT", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const dpct = (a, b) => (a == null || !b ? null : (100 * (a - b)) / b);
  const delta = (v, d = 1, suffix = "%") => (v == null ? "" : `<span class="${v >= 0 ? "es-up" : "es-dn"}">${v >= 0 ? "▲" : "▼"} ${f1(Math.abs(v), d)}${suffix}</span>`);
  const qtr = (d) => (d ? `${d.slice(0, 4)} T${Math.ceil(+d.slice(5, 7) / 3)}` : "");
  const css = `<style>
    .es-up{color:var(--accent)} .es-dn{color:var(--alert)}
    .es-h{display:grid;grid-template-columns:minmax(110px,40%) 1fr auto;gap:8px;align-items:center;font-size:.84rem;padding:3px 0}
    .es-h .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.es-h .m{height:9px;background:var(--line2);border-radius:5px;overflow:hidden}.es-h .m i{display:block;height:100%;background:var(--bar)}
    .es-h .v{font-variant-numeric:tabular-nums;white-space:nowrap}
    .es-line{width:100%;height:auto;display:block} .es-line text{fill:var(--muted);font-size:10px} .es-line .gl{stroke:var(--line2)} .es-line .a{stroke:var(--bar);fill:none;stroke-width:2} .es-line .b{stroke:var(--bar2);fill:none;stroke-width:2}
    .es-line .da{fill:var(--bar)} .es-line .db{fill:var(--bar2)}
    .es-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.es-f input,.es-f select{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
    .es-f input[name=q]{flex:1;min-width:200px}
    .es-lg{display:flex;gap:14px;font-size:.8rem;color:var(--muted);margin:.3rem 0} .es-lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
    .es-split{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line2)} .es-split i{display:block;height:100%}
  </style>`;
  const hbars = (rows, label, value, fmt, opts = {}) => {
    const max = Math.max(1, ...rows.map((r) => Math.abs(value(r))));
    return rows.map((r) => `<div class="es-h" title="${esc(label(r))}"><span class="t">${opts.html ? opts.html(r) : esc(label(r))}</span><span class="m"><i style="width:${(100 * Math.abs(value(r)) / max).toFixed(1)}%"></i></span><span class="v">${fmt(r)}</span></div>`).join("");
  };
  // gráfico de linhas SVG: series = [{cls, pts:[[x(date 'YYYY-MM-DD'), y]]}]
  const lineChart = (series, { fmt = (v) => Portal.int(Math.round(v)), zero = false, h = 190 } = {}) => {
    const W = 640, H = h, L = 52, R = 10, T = 10, B = 22;
    const all = series.flatMap((s) => s.pts.filter((p) => p[1] != null));
    if (!all.length) return "<p class='muted small'>Sem dados.</p>";
    const xs = all.map((p) => Date.parse(p[0])), x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    if (zero) y0 = Math.min(0, y0);
    const pad = (y1 - y0) * 0.08 || 1; y1 += pad; if (!zero || y0 < 0) y0 -= pad;
    const X = (d) => L + ((Date.parse(d) - x0) / (x1 - x0 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
    const grid = [0, 1, 2, 3].map((i) => { const v = y0 + ((y1 - y0) * i) / 3; return `<line class="gl" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${esc(fmt(v))}</text>`; }).join("");
    const years = []; for (let y = new Date(x0).getUTCFullYear() + 1; y <= new Date(x1).getUTCFullYear(); y++) years.push(y);
    const step = Math.max(1, Math.ceil(years.length / 8));
    const xl = years.filter((_, i) => i % step === 0).map((y) => `<text x="${X(y + "-01-01")}" y="${H - 6}" text-anchor="middle">${y}</text>`).join("");
    const paths = series.map((s) => {
      const p = s.pts.filter((q) => q[1] != null);
      const last = p[p.length - 1];
      return `<path class="${s.cls}" d="${p.map((q, i) => `${i ? "L" : "M"}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join("")}"/>` +
        `<circle class="d${s.cls}" cx="${X(last[0])}" cy="${Y(last[1])}" r="3"><title>${esc(s.name || "")} ${last[0]}: ${esc(fmt(last[1]))}</title></circle>`;
    }).join("");
    return `<svg class="es-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">${grid}${xl}${paths}</svg>`;
  };
  const colChart = (rows, aLabel, bLabel) => { // pares entradas/saídas por trimestre
    const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
    return `<div class="barchart" role="img" aria-label="${esc(aLabel)} e ${esc(bLabel)} por trimestre">${rows.map((r) => `<div class="col" title="${qtr(r.d)}: ${aLabel} ${Portal.int(r.a)} · ${bLabel} ${Portal.int(r.b)}">
      <div style="display:flex;align-items:flex-end;gap:1px;height:120px"><div class="b" style="height:${Math.max(1, 120 * r.a / max)}px;width:7px;flex:none"></div><div class="b" style="height:${Math.max(1, 120 * r.b / max)}px;width:7px;flex:none;background:var(--bar2)"></div></div><div class="lbl">${r.d.slice(2, 4)}T${Math.ceil(+r.d.slice(5, 7) / 3)}</div></div>`).join("")}</div>
      <div class="es-lg"><span><i style="background:var(--bar)"></i>${esc(aLabel)}</span><span><i style="background:var(--bar2)"></i>${esc(bLabel)}</span></div>`;
  };

  Portal.nav("Estado e empresas", "#/estado");

  const GRP = { total: "Todas as empresas do SEE", nao_financeiras: "Não financeiras", financeiras: "Financeiras", EPR: "Públicas reclassificadas (EPR)", EPNR: "Não reclassificadas (EPNR)" };
  const PF = { principal: "Carteira principal", acessoria: "Carteira acessória", liquidacao: "Em liquidação", siee: "Só no SISEE (sem participação direta)" };

  async function pageHome(p) {
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Transparência</div><h1>O Estado em números</h1></div></div><p class="muted">A carregar…</p>`;
    const [ov, sub, em] = await Promise.all([
      Portal.api("estado/overview"), Portal.api("estado/emprego?dim=subsector"),
      Portal.api("estado/empresas" + Portal.qs({ q: p.q, sector: p.sector, sort: p.sort, page: p.page, matched: p.matched })),
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>O Estado em números</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const w = ov.workforce, last = w.last, py = w.prevYear, cm = ov.companies;
    const pctEmp = last.employed_total ? (100 * last.public_workers) / last.employed_total : null;
    const yoy = py ? dpct(last.public_workers, py.public_workers) : null;
    const pay = w.lastPay, pp = w.prevPay;
    // série longa 2011-2026 (soma por subsetor)
    const tot = {}; for (const r of sub.rows) tot[r.ref_date] = (tot[r.ref_date] || 0) + (r.workers || 0);
    const longSeries = Object.entries(tot).sort().map(([d, v]) => [d, v]);
    const subRows = sub.rows.filter((r) => r.ref_date === w.subsectorRef);
    const subTot = subRows.reduce((a, r) => a + r.workers, 0);
    const nEnt = Object.values(w.entities || {}).reduce((a, r) => a + (r.n || 0), 0);
    const contractTot = w.contract.reduce((a, r) => a + r.workers, 0);
    const flowQ = {}; for (const r of w.flows) { (flowQ[r.ref_date] ||= {})[r.flow] = r.workers; }
    const flowRows = Object.entries(flowQ).sort().map(([d, o]) => ({ d, a: o["Entradas"] || 0, b: o["Saídas"] || 0 }));
    const lastFlow = flowRows[flowRows.length - 1] || { a: 0, b: 0 };
    const sa = ov.seeAgg;
    const seeBy = (grp, ind, q = 4) => sa.filter((r) => r.grp === grp && r.indicator === ind && r.quarter === q).sort((a, b) => a.year - b.year);
    const seeYears = [...new Set(seeBy("total", "volume_negocios").map((r) => r.year))].filter((y) => y >= 2019);
    const cell = (grp, ind, y) => { const r = seeBy(grp, ind).find((x) => x.year === y); return r ? r.value : null; };
    const seeQ1 = sa.filter((r) => r.grp === "total" && r.quarter === 1 && r.indicator === "n_empresas").pop();
    const g26 = (ind) => sa.find((r) => r.grp === "total" && r.year === 2026 && r.quarter === 1 && r.indicator === ind);
    const q1v = g26("volume_negocios") ? { vn: g26("volume_negocios").value, rl: g26("resultado_liquido")?.value || 0, n: g26("n_empresas")?.value } : null;
    const empSeeTot = {}; for (const r of w.empSee) { if (r.holder !== "Detidas pela adm. regional dos Açores") (empSeeTot[r.ref_date] ||= 0), (empSeeTot[r.ref_date] += r.workers || 0); }
    const empSeeLast = w.empSeeRef ? empSeeTot[w.empSeeRef] : null;
    const link = (o) => `#/estado${Portal.qs({ ...p, page: "", ...o })}`;
    const sectors = em.sectors || [];

    const workforce = `
      <h2 style="margin-top:1.4rem">Quem trabalha para o Estado</h2>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(last.public_workers)}</b><span>trabalhadores nas administrações públicas (${qtr(last.ref_date)}${last.note ? ", provisório" : ""})</span></div>
        <div class="kpi"><b>${f1(pctEmp)}%</b><span>da população empregada (${Portal.int(last.employed_total)})</span></div>
        <div class="kpi"><b>${yoy == null ? "—" : delta(yoy, 1)}</b><span>variação em 12 meses${py ? ` (${Portal.int(py.public_workers)} em ${qtr(py.ref_date)})` : ""}</span></div>
        <div class="kpi"><b>${Portal.eurFull(pay.base_monthly)}</b><span>remuneração base média mensal ${pp ? delta(dpct(pay.base_monthly, pp.base_monthly)) : ""}</span></div>
        <div class="kpi"><b>${Portal.eurFull(pay.gain_monthly)}</b><span>ganho médio mensal ${pp ? delta(dpct(pay.gain_monthly, pp.gain_monthly)) : ""}</span></div>
        <div class="kpi"><b>${Portal.int(nEnt)}</b><span>entidades nas AP (${qtr(Object.values(w.entities)[0]?.ref_date)})</span></div></div>
      <div class="cols">
        <section class="panel"><h2>Trabalhadores nas administrações públicas</h2>${lineChart([{ cls: "a", name: "Trabalhadores", pts: longSeries }], { fmt: (v) => `${Math.round(v / 1000)} mil` })}
          <p class="small muted">Fim de trimestre, 2011–${last.ref_date.slice(0, 4)}. Série DGAEP com o universo das AP definido pelo INE (SEC 2010). ${ext(last.source_url, "dados.gov.pt")}</p></section>
        <section class="panel"><h2>Remuneração base e ganho médio</h2>${lineChart([{ cls: "a", name: "Remuneração base", pts: w.pay.map((r) => [r.ref_date, r.base_monthly]) }, { cls: "b", name: "Ganho médio", pts: w.pay.map((r) => [r.ref_date, r.gain_monthly]) }], { fmt: (v) => `${Math.round(v)} €` })}
          <div class="es-lg"><span><i style="background:var(--bar)"></i>Remuneração base média mensal</span><span><i style="background:var(--bar2)"></i>Ganho médio mensal</span></div>
          <p class="small muted">Euros correntes por mês (não deflacionados). O ganho inclui subsídios e suplementos. ${ext(w.pay[0]?.source_url, "dados.gov.pt")}</p></section></div>
      <div class="cols">
        <section class="panel"><h2>Por subsetor</h2>${hbars(w.subsector, (r) => r.subsector, (r) => r.workers, (r) => `${Portal.int(r.workers)} · ${f1(100 * r.workers / subTot, 0)}%`)}
          <p class="small muted">${qtr(w.subsectorRef)}. Administração Central, Local (municípios e freguesias), regiões autónomas e Fundos de Segurança Social.</p></section>
        <section class="panel"><h2>Administração central por área governativa</h2>${hbars(w.areas.slice(0, 14), (r) => r.area, (r) => r.workers, (r) => Portal.int(r.workers))}
          <p class="small muted">${qtr(w.subsectorRef)}. Sem dados para a Assembleia da República e serviços de apoio ao Presidente da República.</p></section></div>
      <div class="cols">
        <section class="panel"><h2>Vínculo de trabalho</h2>${hbars(w.contract, (r) => r.label, (r) => r.workers, (r) => `${Portal.int(r.workers)} · ${f1(100 * r.workers / contractTot, 0)}% ${w.contractPrev[r.label] ? delta(dpct(r.workers, w.contractPrev[r.label]), 1) : ""}`)}
          <p class="small muted">${qtr(w.contractRef)}; variação face ao mesmo trimestre do ano anterior.</p></section>
        <section class="panel"><h2>Entradas e saídas</h2>${colChart(flowRows, "Entradas", "Saídas")}
          <p class="small">${qtr(w.flowRef)}: <b>${Portal.int(lastFlow.a)}</b> entradas, <b>${Portal.int(lastFlow.b)}</b> saídas (saldo ${lastFlow.a - lastFlow.b >= 0 ? "+" : ""}${Portal.int(lastFlow.a - lastFlow.b)}). Motivos: ${w.flowMotives.filter((m) => m.flow === "Saídas").map((m) => `${esc(m.motive.replace("Saídas definitivas - ", "").toLowerCase())} ${Portal.int(m.workers)}`).join("; ")}.</p></section></div>
      <div id="es-car"></div>
      <section class="panel"><h2>Empresas públicas e demais entidades do setor público (fora das AP)</h2>
        ${empSeeLast ? `<p><b>${Portal.int(empSeeLast)}</b> postos de trabalho em ${qtr(w.empSeeRef)} nas empresas e entidades públicas detidas pela administração central, regional (Madeira) e local.</p>` : ""}
        ${Portal.table([{ h: "Detidas por", f: (r) => esc(r.holder) }, { h: "Em", f: (r) => qtr(r.ref_date) }, { h: "Postos de trabalho", num: 1, f: (r) => Portal.int(r.workers) }, { h: "Fonte", f: (r) => ext(r.source_url, "BOEP") }],
          w.empSee.filter((r) => r.ref_date === w.empSeeRef))}
        <p class="small muted">Não incluídos nos trabalhadores das AP acima. Açores: «n.d.» na fonte. Fonte: DGAEP, Boletim Estatístico do Emprego Público (quadro Q.2.1.1).</p></section>`;

    const companies = `
      <h2 style="margin-top:1.6rem">Empresas do Estado e participações</h2>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(cm.principal)}</b><span>participações diretas na carteira principal (${esc(Portal.fmtDate(cm.ref))})</span></div>
        <div class="kpi"><b>${Portal.eur(cm.nominal)}</b><span>valor nominal da participação do Estado (carteira principal e acessória)</span></div>
        <div class="kpi"><b>${Portal.int(cm.liquidacao)}</b><span>em liquidação</span></div>
        <div class="kpi"><b>${seeQ1 ? Portal.int(ov.siee?.n || seeQ1.n_companies) : "—"}</b><span>empresas no SISEE (universo SEE, inclui subsidiárias)</span></div>
        <div class="kpi"><b>${Portal.int(cm.matched)}</b><span>de ${Portal.int(cm.n)} ligadas ao registo por NIF (${f1(100 * cm.matched / cm.n, 0)}%)</span></div></div>
      <section class="panel"><h2>Sector Empresarial do Estado: resultados agregados</h2>
        ${Portal.table([{ h: "Ano (acumulado a dezembro)", f: (y) => `<b>${y}</b>` },
          { h: "Volume de negócios", num: 1, f: (y) => Portal.eur(1000 * cell("total", "volume_negocios", y)) },
          { h: "EBITDA", num: 1, f: (y) => Portal.eur(1000 * cell("total", "ebitda", y)) },
          { h: "Resultado líquido", num: 1, f: (y) => { const v = cell("total", "resultado_liquido", y); return v == null ? "—" : `<span class="${v >= 0 ? "es-up" : "es-dn"}">${Portal.eur(1000 * v)}</span>`; } },
          { h: "Endividamento", num: 1, f: (y) => Portal.eur(1000 * cell("total", "endividamento", y)) },
          { h: "Empresas analisadas", num: 1, f: (y) => Portal.int(cell("total", "n_empresas", y)) }], seeYears.filter((y) => cell("total", "volume_negocios", y) != null))}
        <p class="small muted">Soma de todas as empresas do SEE que reportaram no SISEE/SiRIEF (financeiras e não financeiras, incl. EPR). O universo e o perímetro mudam de ano para ano (p. ex. as ULS entram em 2024-26), por isso <b>os anos não são comparáveis em rigor</b>; a ETF reapresenta o ano anterior em cada relatório.
        ${q1v ? ` 1.º trim. 2026 (${Portal.int(q1v.n)} empresas): volume de negócios ${Portal.eur(1000 * q1v.vn)}, resultado líquido ${Portal.eur(1000 * q1v.rl)}.` : ""}
        ${ext("https://www.etf.gov.pt/relatorios-see", "ETF · Relatórios do SEE (PDF)")}</p>
        <details><summary><b>Por grupo de empresas (resultado líquido e endividamento, dezembro)</b></summary>
        ${Portal.table([{ h: "Grupo", f: (g) => esc(GRP[g]) }, ...seeYears.filter((y) => y >= 2021 && cell("total", "volume_negocios", y) != null).flatMap((y) => [
          { h: `RL ${y}`, num: 1, f: (g) => Portal.eur(1000 * (cell(g, "resultado_liquido", y) ?? NaN)).replace("NaN", "—") },
          { h: `Dívida ${y}`, num: 1, f: (g) => Portal.eur(1000 * (cell(g, "endividamento", y) ?? NaN)).replace("NaN", "—") }])], Object.keys(GRP))}</details></section>
      <section class="panel" id="es-emp"><h2>Empresas e participações do Estado</h2>
        <form class="es-f" id="es-form"><input name="q" placeholder="Nome ou NIF…" value="${esc(p.q || "")}">
          <select name="sector" aria-label="Setor"><option value="">Todos os setores e carteiras</option>${sectors.map((s) => `<option value="${esc(s.name)}" ${p.sector === s.name ? "selected" : ""}>${esc(s.name || "—")} (${s.n})</option>`).join("")}</select>
          <select name="sort" aria-label="Ordenar"><option value="nominal">Maior valor nominal</option><option value="pct" ${p.sort === "pct" ? "selected" : ""}>Maior % do Estado</option><option value="name" ${p.sort === "name" ? "selected" : ""}>Nome</option></select>
          <label class="small" style="align-self:center"><input type="checkbox" name="matched" value="1" ${p.matched ? "checked" : ""}> só com contratos (NIF ligado)</label>
          <button class="btn primary">Filtrar</button></form>
        <p class="small muted">${Portal.int(em.total)} resultados. «% Estado» e «valor nominal» são a participação <b>direta</b> do Estado (Estado/ETF) segundo a Carteira de Participações a ${esc(Portal.fmtDate(em.ref))}.</p>
        ${Portal.table([
          { h: "Empresa", f: (r) => `<a href="#/estado/empresa/${r.id}">${esc(r.name)}</a>${r.epr ? ' <span class="tag" title="Entidade Pública Reclassificada (conta nas AP)">EPR</span>' : ""}<div class="small muted">${esc(r.section || r.grp || "")}</div>` },
          { h: "Carteira", f: (r) => `<span class="small">${esc(PF[r.portfolio] || r.portfolio)}</span>` },
          { h: "% Estado", num: 1, f: (r) => (r.pct == null ? "—" : f1(r.pct, r.pct < 1 ? 3 : 1) + "%") },
          { h: "Valor nominal", num: 1, f: (r) => (r.nominal == null ? "—" : Portal.eur(r.nominal)) },
          { h: "Contratos públicos", num: 1, f: (r) => (r.nif ? `${r.entity_id ? `<a href="#/entidade/${r.entity_id}">` : ""}${Portal.int((r.buyer_n || 0) + (r.seller_n || 0))}${r.entity_id ? "</a>" : ""}<div class="small muted">${Portal.eur((r.buyer_value || 0) + (r.seller_value || 0))}</div>` : '<span class="muted small">sem NIF no registo</span>') },
        ], em.rows)}
        ${Portal.pager(em.total, em.page, em.limit, (n) => link({ page: n }))}</section>`;

    const sources = `
      <section class="panel"><h2>Fontes e limitações</h2>
        <ul class="small">${Object.entries(ov.sources || {}).map(([k, v]) => `<li><b>${esc(v.title || k)}</b>${v.license && v.license !== "notspecified" ? ` (${esc(v.license)})` : ""}: ${ext(v.dataset || v.url, v.dataset ? v.dataset.replace(/^https?:\/\//, "").slice(0, 60) : "ficheiro")}</li>`).join("")}</ul>
        ${(ov.docs || []).length ? `<details><summary class="small">Relatórios e boletins do SEE na ETF (${ov.docs.length} PDF, só agregados)</summary><ul class="small">${ov.docs.map((x) => `<li>${ext(x.url, x.title)}</li>`).join("")}</ul></details>` : ""}
        ${(ov.blocked || []).map((b) => `<p class="note warn"><b>${esc(b.source)}</b>: ${esc(b.reason)}</p>`).join("")}
        ${Object.keys(ov.errors || {}).length ? `<p class="note warn">Falhas na última atualização: ${esc(JSON.stringify(ov.errors))}</p>` : ""}
        <p class="note">Só agregados: não se guarda nenhum trabalhador individual. As remunerações são médias mensais por carreira publicadas pela DGAEP. Ligação das empresas ao registo de entidades por nome normalizado (${ov.match ? `${Object.entries(ov.match.by_method || {}).map(([k, v]) => `${v} ${esc(k)}`).join(", ")}` : ""}); o registo só contém entidades que contrataram no Portal BASE. Atualizado ${esc(ov.built || "")}.</p></section>`;

    $app.innerHTML = `${css}
      <div class="pagehead"><div><div class="kicker">Transparência</div><h1>O Estado em números</h1>
        <div class="small muted">Quantas pessoas trabalham para o Estado, quanto ganham em média e que empresas o Estado detém: dados abertos da DGAEP (SIOE) e da ETF (ex-DGTF).</div></div></div>
      ${workforce}${companies}${sources}`;
    $("#es-form").addEventListener("submit", (e) => { e.preventDefault(); const o = Object.fromEntries(new FormData(e.target).entries()); Portal.go("estado", "", o); });
    // carreiras (carrega depois)
    Promise.all([Portal.api("estado/emprego?dim=career"), Portal.api("estado/emprego?dim=age")]).then(([c, a]) => {
      const el = $("#es-car"); if (!el) return;
      const rows = c.rows, tw = rows.reduce((s, r) => s + r.workers, 0), women = rows.reduce((s, r) => s + r.women, 0);
      const byCareer = {};
      for (const r of rows) { const o = (byCareer[r.career] ||= { career: r.career, area: r.area, workers: 0, women: 0, wb: 0, wg: 0, pw: 0 }); o.workers += r.workers; o.women += r.women; if (r.base != null) { o.wb += r.base * r.workers; o.wg += r.gain * r.workers; o.pw += r.workers; } }
      const list = Object.values(byCareer).sort((x, y) => y.workers - x.workers).slice(0, 22);
      const ages = {}; for (const r of a.rows) { (ages[r.age] ||= { age: r.age, F: 0, M: 0 })[r.sex.startsWith("F") ? "F" : "M"] += r.workers; }
      const al = Object.values(ages), amax = Math.max(1, ...al.map((x) => x.F + x.M));
      el.innerHTML = `<div class="cols"><section class="panel"><h2>Carreiras</h2>
        <p class="small">${qtr(c.ref)}: ${Portal.int(tw)} trabalhadores com carreira classificada, <b>${f1(100 * women / tw, 0)}%</b> mulheres. Remuneração: média ponderada dos detalhes da carreira em ${qtr(c.payRef)}.</p>
        ${Portal.table([{ h: "Carreira", f: (r) => `${esc(r.career)}<div class="small muted">${esc(r.area || "")}</div>` }, { h: "Trabalhadores", num: 1, f: (r) => Portal.int(r.workers) },
          { h: "Mulheres", num: 1, f: (r) => f1(100 * r.women / r.workers, 0) + "%" }, { h: "Base média", num: 1, f: (r) => (r.pw ? Portal.eurFull(r.wb / r.pw) : "—") }, { h: "Ganho médio", num: 1, f: (r) => (r.pw ? Portal.eurFull(r.wg / r.pw) : "—") }], list)}
        <p class="small muted">${ext(c.source_url, "Carreiras")} · ${ext(c.pay_source_url, "Remunerações por carreira")}. As carreiras e as remunerações têm datas de referência diferentes.</p></section>
        <section class="panel"><h2>Idade e sexo</h2>
        ${al.map((x) => `<div class="es-h" title="${esc(x.age)}"><span class="t">${esc(x.age)}</span><span class="m"><span class="es-split" style="width:${(100 * (x.F + x.M) / amax).toFixed(1)}%"><i style="width:${(100 * x.F / (x.F + x.M || 1)).toFixed(1)}%;background:var(--bar2)"></i><i style="width:${(100 * x.M / (x.F + x.M || 1)).toFixed(1)}%;background:var(--bar)"></i></span></span><span class="v">${Portal.int(x.F + x.M)}</span></div>`).join("")}
        <div class="es-lg"><span><i style="background:var(--bar2)"></i>Mulheres</span><span><i style="background:var(--bar)"></i>Homens</span></div>
        <p class="small muted">Trabalhadores por escalão etário (${qtr(a.ref)}).</p></section></div>`;
    }).catch(() => {});
  }

  async function pageCompany(id) {
    $app.innerHTML = `${css}<p class="muted">A carregar…</p>`;
    const d = await Portal.api("estado/empresa?id=" + encodeURIComponent(id));
    if (!d.available || !d.found) { $app.innerHTML = `<div class="crumbs"><a href="#/estado">O Estado em números</a></div><p class="note warn">${esc(d.note || "Empresa não encontrada.")}</p>`; return; }
    const c = d.company, e = d.entity;
    const contr = (rows, who, nameKey, nifKey) => rows.length ? Portal.table([
      { h: "Contrato", f: (r) => `${r.link ? ext(r.link, (r.object || "").slice(0, 120) || "contrato") : esc((r.object || "").slice(0, 120))}<div class="small muted">${esc(r.procedure || "")}</div>` },
      { h: who, f: (r) => (r[nifKey] ? `<a href="#/contratos?${who === "Fornecedor" ? "seller" : "buyer"}=${esc(r[nifKey])}">${esc(r[nameKey] || r[nifKey])}</a>` : esc(r[nameKey] || "")) },
      { h: "Assinado", f: (r) => Portal.fmtDate(r.signed) }, { h: "Preço", num: 1, f: (r) => Portal.eurFull(r.price) }], rows) : '<p class="muted small">Sem contratos.</p>';
    const yrs = {}; for (const r of d.byYear) (yrs[r.year] ||= { year: r.year, buyer: 0, seller: 0 })[r.role] = r.value;
    const yl = Object.values(yrs);
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/estado">O Estado em números</a> / Empresas</div>
      <div class="pagehead"><div><div class="kicker">${esc(PF[c.portfolio] || "Empresa do Estado")}${c.epr ? " · Entidade Pública Reclassificada" : ""}</div><h1>${esc(c.name)}</h1>
        <div class="small muted">${esc([c.grp, c.section].filter(Boolean).join(" › "))}${c.nif ? ` · NIF ${esc(c.nif)}` : ""}${e ? ` · <a href="#/entidade/${e.id}">ficha da entidade</a>` : ""}</div></div></div>
      <div class="kpis">
        <div class="kpi"><b>${c.pct == null ? "—" : f1(c.pct, c.pct < 1 ? 3 : 1) + "%"}</b><span>do capital detido diretamente pelo Estado${c.ref_date ? ` (${esc(Portal.fmtDate(c.ref_date))})` : ""}</span></div>
        <div class="kpi"><b>${c.nominal == null ? "—" : Portal.eur(c.nominal)}</b><span>valor nominal da participação do Estado</span></div>
        <div class="kpi"><b>${c.capital == null ? "—" : Portal.eur(c.capital)}</b><span>capital social / estatutário</span></div>
        ${e ? `<div class="kpi"><b>${Portal.int(e.buyer_contracts)}</b><span>contratos como entidade adjudicante (${Portal.eur(e.buyer_value)})</span></div><div class="kpi"><b>${Portal.int(e.seller_contracts)}</b><span>contratos como fornecedor (${Portal.eur(e.seller_value)})</span></div>` : ""}</div>
      ${c.portfolio === "siee" ? `<p class="note">Esta entidade consta da lista de empresas do SEE reportadas no SISEE mas <b>não</b> aparece na Carteira de Participações do Estado (participação indireta, via outra empresa pública ou holding). Não há percentagem do Estado na fonte.</p>` : ""}
      ${c.status === "em liquidação" ? `<p class="note warn">Empresa em liquidação (carteira de liquidações da ETF).</p>` : ""}
      ${d.hist.length > 1 ? `<section class="panel"><h2>Participação do Estado ao longo do tempo</h2>${Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.ref_date) }, { h: "% Estado", num: 1, f: (r) => (r.pct == null ? "—" : f1(r.pct, 2) + "%") },
        { h: "Valor nominal", num: 1, f: (r) => Portal.eurFull(r.nominal) }, { h: "Capital", num: 1, f: (r) => Portal.eurFull(r.capital) }, { h: "Fonte", f: (r) => ext(r.source_url, "ETF") }], d.hist)}</section>` : ""}
      ${c.nif ? `<section class="panel"><h2>Contratos públicos</h2>
        ${yl.length ? `<div class="barchart" role="img" aria-label="Valor contratado por ano">${(() => { const mx = Math.max(1, ...yl.flatMap((y) => [y.buyer, y.seller])); return yl.map((y) => `<div class="col" title="${y.year}: adjudicante ${Portal.eurFull(y.buyer)} · fornecedor ${Portal.eurFull(y.seller)}"><div style="display:flex;align-items:flex-end;gap:1px;height:120px"><div class="b" style="height:${Math.max(1, 120 * y.buyer / mx)}px;width:7px;flex:none"></div><div class="b" style="height:${Math.max(1, 120 * y.seller / mx)}px;width:7px;flex:none;background:var(--bar2)"></div></div><div class="lbl">${String(y.year).slice(2)}</div></div>`).join(""); })()}</div>
        <div class="es-lg"><span><i style="background:var(--bar)"></i>Como adjudicante (compra)</span><span><i style="background:var(--bar2)"></i>Como fornecedor (vende)</span></div>` : ""}
        <h3>Maiores contratos como adjudicante</h3>${contr(d.asBuyer, "Fornecedor", "seller_name", "seller_nif")}
        <h3>Maiores contratos como fornecedor</h3>${contr(d.asSeller, "Adjudicante", "buyer_name", "buyer_nif")}
        <p class="small"><a href="#/contratos?buyer=${esc(c.nif)}">Todos os contratos como adjudicante →</a> · <a href="#/contratos?seller=${esc(c.nif)}">como fornecedor →</a></p></section>`
        : `<p class="note">Esta empresa não foi ligada a nenhuma entidade do registo de contratação pública (sem NIF no registo): não é possível mostrar contratos.</p>`}
      <section class="panel"><h2>Demonstrações financeiras</h2>
        ${d.blocked.map((b) => `<p class="note warn"><b>${esc(b.source)}</b>: ${esc(b.reason)}</p>`).join("")}
        ${d.docs && d.docs.length ? `<h3>Documentos oficiais do SEE (ETF) — conjunto, não desta empresa</h3><ul class="small">${d.docs.map((x) => `<li>${x.year}: ${ext(x.url, x.title)}</li>`).join("")}</ul>` : ""}
        <p class="small muted">Agregado do SEE (todas as empresas): resultado líquido e endividamento a dezembro — ${d.aggregate.filter((r) => r.indicator === "resultado_liquido").map((r) => `${r.year}: ${Portal.eur(1000 * r.value)}`).join("; ")}. <a href="#/estado">Ver o conjunto →</a></p></section>
      ${d.siblings.length ? `<section class="panel"><h2>Outras do mesmo setor</h2>${Portal.table([{ h: "Empresa", f: (r) => `<a href="#/estado/empresa/${r.id}">${esc(r.name)}</a>` }, { h: "% Estado", num: 1, f: (r) => (r.pct == null ? "—" : f1(r.pct, 1) + "%") }, { h: "Valor nominal", num: 1, f: (r) => Portal.eur(r.nominal) }], d.siblings)}</section>` : ""}
      <p class="small muted">Fonte: ${ext(c.source_url, "ETF / dados.gov.pt")}${c.match_method ? ` · ligação ao registo por ${esc(c.match_method)}${c.entity_name && c.entity_name !== c.name ? ` («${esc(c.entity_name)}»)` : ""}` : ""}.</p>`;
  }

  Portal.page("estado", async (arg, p) => {
    const m = /^empresa\/(\d+)/.exec(arg || "");
    if (m) return pageCompany(m[1]);
    return pageHome(p || {});
  });

  /* secção nas páginas de entidade */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.nif || !["empresa_publica", "empresa_municipal", "sociedade_adjudicante", "saude", "instituto_publico", "empresa_ou_particular", "outra_entidade"].includes(e.kind)) return;
    const d = await Portal.api("estado/empresa?nif=" + e.nif).catch(() => null);
    if (!d || !d.found) return;
    const c = d.company;
    el.insertAdjacentHTML("beforeend", `${css}<section class="panel"><h2>Sector Empresarial do Estado</h2>
      <div class="kpis"><div class="kpi"><b>${c.pct == null ? "—" : f1(c.pct, c.pct < 1 ? 3 : 1) + "%"}</b><span>do capital detido diretamente pelo Estado</span></div>
        <div class="kpi"><b>${c.nominal == null ? "—" : Portal.eur(c.nominal)}</b><span>valor nominal da participação</span></div>
        <div class="kpi"><b>${esc(PF[c.portfolio] || c.portfolio)}</b><span>${esc([c.grp, c.section].filter(Boolean).join(" › "))}${c.epr ? " · EPR" : ""}</span></div></div>
      <p class="small muted">Fonte: ${ext(c.source_url, "ETF, Carteira de Participações do Estado")}${c.ref_date ? ` (${esc(Portal.fmtDate(c.ref_date))})` : ""}. <a href="#/estado/empresa/${c.id}">Ficha da empresa →</a> · <a href="#/estado">O Estado em números →</a></p></section>`);
  });
})();
