"use strict";
/* Módulo "orcamento": #/orcamento ("Para onde vai o dinheiro") e #/orcamento/<slug-do-ministério>
   API: /api/orcamento/*  — dados: Entidade Orçamental (ex-DGO) SEO mensal + Propostas OE, Eurostat. Valores em M€. */
(() => {
  const { esc } = Portal;
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const MESF = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const M = (v) => (v == null ? "—" : Portal.eur(v * 1e6));            // M€ -> texto
  const pct = (a, b) => (a != null && b ? (100 * a / b) : null);
  const delta = (a, b) => { if (a == null || !b) return ""; const d = 100 * (a - b) / Math.abs(b); return `<span class="orc-d ${d >= 0 ? "up" : "dn"}">${d >= 0 ? "+" : ""}${d.toFixed(1)}%</span>`; };
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>
    .orc-d{font-size:.78rem;font-variant-numeric:tabular-nums;margin-left:4px}.orc-d.up{color:var(--accent)}.orc-d.dn{color:var(--alert)}
    .orc-years{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.orc-years a{padding:.25rem .65rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:.88rem;color:var(--ink)}
    .orc-years a.on{background:var(--navy);color:#fff;border-color:var(--navy)}
    .orc-chart svg{width:100%;height:auto;display:block}.orc-chart text{font:11px system-ui;fill:var(--muted)}
    .orc-chart .grid{stroke:var(--line2);stroke-width:1}.orc-chart .axis{stroke:var(--line);stroke-width:1}
    .orc-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;color:var(--muted);margin-top:6px}.orc-legend i{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px}
    .orc-hb{display:grid;grid-template-columns:minmax(120px,32%) 1fr auto;gap:4px 10px;align-items:center;font-size:.88rem}
    .orc-hb .t{position:relative;height:14px;background:var(--line2);border-radius:0 4px 4px 0}
    .orc-hb .t b{position:absolute;left:0;top:0;bottom:0;background:var(--bar);border-radius:0 4px 4px 0}
    .orc-hb .t s{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.55;text-decoration:none}
    .orc-hb .v{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
    .orc-hb a{color:var(--ink)}
    .orc-tip{position:fixed;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font-size:.82rem;box-shadow:0 6px 18px rgba(0,0,0,.15);z-index:60;display:none}
  </style>`;

  Portal.nav("Orçamento", "#/orcamento");

  /* ---------- gráfico de linhas acumuladas (um eixo, M€) ---------- */
  function lineChart(series, { budget, height = 240 } = {}) {
    const W = 720, H = height, L = 56, R = 14, T = 12, B = 26;
    const all = series.flatMap((s) => s.pts.map((p) => p[1])).concat(budget ? [budget] : []);
    const max = Math.max(1, ...all) * 1.05;
    const x = (m) => L + (W - L - R) * (m - 1) / 11, y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = 4, grid = [...Array(ticks + 1)].map((_, i) => max * i / ticks);
    const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">`;
    svg += grid.map((g) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end">${(g / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 0 })} mM€</text>`).join("");
    svg += MES.map((m, i) => `<text x="${x(i + 1)}" y="${H - 8}" text-anchor="middle">${m}</text>`).join("");
    if (budget) svg += `<line x1="${x(1)}" y1="${y(budget / 12)}" x2="${x(12)}" y2="${y(budget)}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    for (const s of series) {
      if (!s.pts.length) continue;
      svg += `<path d="${path(s.pts)}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
      svg += s.pts.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="4" fill="${s.color}" stroke="var(--card)" stroke-width="2"/>`).join("");
    }
    // camada de hover: uma coluna por mês
    svg += MES.map((_, i) => {
      const m = i + 1, rows = series.map((s) => { const p = s.pts.find((q) => q[0] === m); return p ? `${s.name}: <b>${M(p[1])}</b>` : null; }).filter(Boolean);
      if (budget) rows.push(`Ritmo linear do orçamento: ${M(budget * m / 12)}`);
      return rows.length ? `<rect x="${x(m) - (W - L - R) / 22}" y="${T}" width="${(W - L - R) / 11}" height="${H - T - B}" fill="transparent" data-tip="${esc(`<b>${MESF[i]} (acumulado)</b><br>` + rows.join("<br>"))}"/>` : "";
    }).join("");
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
    const leg = series.map((s) => `<span><i style="background:${s.color}${s.dash ? ";opacity:.6" : ""}"></i>${esc(s.name)}</span>`).join("") + (budget ? `<span><i style="background:var(--muted);height:2px"></i>Orçamento inicial (ritmo linear)</span>` : "");
    return `<div class="orc-chart">${svg}<div class="orc-legend">${leg}</div></div>`;
  }

  /* ---------- barras horizontais (valor + marcador de referência) ---------- */
  function hbars(rows, { refLabel } = {}) {
    const max = Math.max(1, ...rows.flatMap((r) => [r.value || 0, r.ref || 0]));
    return `<div class="orc-hb">${rows.map((r) => `<div>${r.href ? `<a href="${r.href}">${esc(r.label)}</a>` : esc(r.label)}${r.sub ? `<div class="small muted">${esc(r.sub)}</div>` : ""}</div>
      <div class="t" data-tip="${esc(`<b>${esc(r.label)}</b><br>${r.tip || M(r.value)}`)}"><b style="width:${Math.max(0.3, 100 * (r.value || 0) / max)}%"></b>${r.ref ? `<s style="left:${100 * r.ref / max}%"></s>` : ""}</div>
      <div class="v">${M(r.value)}${r.extra || ""}</div>`).join("")}</div>
      ${refLabel ? `<div class="orc-legend"><span><i style="background:var(--bar)"></i>Executado</span><span><i style="background:var(--ink);width:2px;height:12px;opacity:.55"></i>${esc(refLabel)}</span></div>` : ""}`;
  }

  function tips(root) {
    let tip = document.querySelector(".orc-tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "orc-tip"; document.body.appendChild(tip); }
    root.addEventListener("mousemove", (e) => {
      const t = e.target.closest("[data-tip]");
      if (!t) { tip.style.display = "none"; return; }
      tip.innerHTML = t.getAttribute("data-tip"); tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px";
    });
    root.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }


  /* ---------- série longa (anos no eixo x, um eixo, M€) ---------- */
  function yearChart(rows, series, { height = 230, unit = "mM€", div = 1000 } = {}) {
    const W = 720, H = height, L = 56, R = 14, T = 12, B = 26;
    if (!rows.length) return "";
    const ys = rows.map((r) => r.year), y0 = ys[0], y1 = ys[ys.length - 1];
    const vals = rows.flatMap((r) => series.map((s) => r[s.key])).filter((v) => v != null);
    const rawMax = Math.max(0, ...vals), rawMin = Math.min(0, ...vals);
    const st0 = (rawMax - rawMin) / 4 || 1, mag = 10 ** Math.floor(Math.log10(st0)), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= st0);
    const max = Math.ceil(rawMax / step) * step, min = Math.floor(rawMin / step) * step;
    const x = (y) => L + (W - L - R) * (y1 === y0 ? 0.5 : (y - y0) / (y1 - y0)), y = (v) => T + (H - T - B) * (max - v) / ((max - min) || 1);
    const grid = []; for (let g = min; g <= max + step / 2; g += step) grid.push(g);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">`;
    svg += grid.map((g) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end">${(g / div).toLocaleString("pt-PT", { maximumFractionDigits: div === 1 ? 1 : 0 })} ${unit}</text>`).join("");
    const lstep = Math.ceil(ys.length / 12);
    svg += ys.map((yy, i) => (i % lstep === 0 || i === ys.length - 1 ? `<text x="${x(yy)}" y="${H - 8}" text-anchor="middle">${yy}</text>` : "")).join("");
    if (min < 0) svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    for (const s of series) {
      const pts = rows.filter((r) => r[s.key] != null);
      if (s.bars) {
        const bw = Math.max(3, (W - L - R) / ys.length * 0.55);
        svg += pts.map((r) => `<rect x="${x(r.year) - bw / 2}" y="${Math.min(y(0), y(r[s.key]))}" width="${bw}" height="${Math.max(1, Math.abs(y(r[s.key]) - y(0)))}" rx="2" fill="${r[s.key] < 0 ? "var(--bar2)" : "var(--accent)"}" opacity="${r.partial ? .45 : 1}"/>`).join("");
      } else {
        svg += `<path d="${pts.map((r, i) => `${i ? "L" : "M"}${x(r.year).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
        svg += pts.map((r) => `<circle cx="${x(r.year)}" cy="${y(r[s.key])}" r="4" fill="${r.partial ? "var(--card)" : s.color}" stroke="${s.color}" stroke-width="2"/>`).join("");
      }
    }
    const cw = (W - L - R) / Math.max(1, ys.length - 1);
    svg += rows.map((r) => `<rect x="${x(r.year) - cw / 2}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" data-tip="${esc(`<b>${r.year}${r.partial ? ` (jan–${MES[r.month - 1]})` : ""}</b><br>` + series.map((s) => `${s.name}: <b>${r[s.key] == null ? "—" : div === 1 ? r[s.key].toFixed(1) + "%" : M(r[s.key])}</b>`).join("<br>"))}"/>`).join("");
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/></svg>`;
    const leg = series.map((s) => `<span><i style="background:${s.bars ? "var(--bar2)" : s.color}"></i>${esc(s.name)}</span>`).join("");
    return `<div class="orc-chart">${svg}<div class="orc-legend">${leg}${rows.some((r) => r.partial) ? "<span>○ / barra clara = ano incompleto</span>" : ""}</div></div>`;
  }

  function longrunPanel(d, params) {
    const all = (d.longrun || []).map((r) => ({ ...r, partial: r.month && r.month < 12 }));
    if (!all.length) return "";
    const yrs = all.map((r) => r.year);
    const from = Number(params.de) || yrs[0], to = Number(params.ate) || yrs[yrs.length - 1];
    const rows = all.filter((r) => r.year >= from && r.year <= to);
    const opt = (cur) => yrs.map((y) => `<option ${y === cur ? "selected" : ""}>${y}</option>`).join("");
    const eu = rows.filter((r) => r.saldoPIB != null);
    return `<section class="panel" id="longo"><h2>A longo prazo: receita, despesa e saldo do Estado</h2>
      <form class="orc-years" id="orc-range" style="margin-bottom:8px"><label class="small">De <select name="de">${opt(from)}</select></label>
        <label class="small">até <select name="ate">${opt(to)}</select></label></form>
      <div class="cols"><div><h3>Receita e despesa efetiva (subsetor Estado)</h3>${yearChart(rows.map((r) => (r.partial ? { ...r, receita: null, despesa: null } : r)), [{ key: "receita", name: "Receita efetiva", color: "var(--accent)" }, { key: "despesa", name: "Despesa efetiva", color: "var(--bar)" }, { key: "budgetDespesa", name: "Despesa orçada (OE inicial)", color: "var(--muted)", dash: "3 4" }])}</div>
        <div><h3>Saldo do Estado (M€)</h3>${yearChart(rows, [{ key: "saldo", name: "Saldo global do Estado", bars: true }])}</div></div>
      ${eu.length ? `<div style="max-width:760px"><h3>Saldo das Administrações Públicas em % do PIB (Eurostat, contas nacionais)</h3>${yearChart(eu, [{ key: "saldoPIB", name: "Saldo das AP (% PIB)", bars: true }], { height: 170, unit: "%", div: 1 })}</div>` : ""}
      <p class="small muted">Execução em contabilidade pública (caixa), valor acumulado a dezembro de cada ano (o ano corrente, incompleto, só aparece no saldo, em barra clara). 2009 vem das edições de 2010 (coluna do ano anterior). Para 2009–2012 a receita e a despesa efetivas são calculadas como corrente + capital (os quadros antigos não trazem esse total).</p></section>`;
  }

  function cgePanel(c) {
    if (!c || !c.lines.length) return "";
    const rows = c.lines.filter((l) => !l.sub && l.exec != null).sort((a, b) => b.exec - a.exec);
    return `<section class="panel"><h2>Conta Geral do Estado ${c.year}: orçado vs gasto por ministério</h2>
      ${hbars(rows.map((l) => ({ label: l.line, value: l.exec, ref: l.oe_final, href: l.ministry ? `#/orcamento/${l.ministry}` : null,
        tip: `Executado: ${M(l.exec)}<br>Orçamento inicial: ${M(l.oe_inicial)}<br>Orçamento final (após alterações): ${M(l.oe_final)}<br>Execução / orçamento final: ${l.oe_final ? Portal.pct(100 * l.exec / l.oe_final, 1) : "—"}`,
        extra: l.oe_final ? ` <span class="small muted">${Portal.pct(100 * l.exec / l.oe_final, 0)}</span>` : "" })), { refLabel: "Orçamento final (com alterações orçamentais)" })}
      <p class="small muted">Despesa efetiva consolidada da Administração Central por ministério (classificação orgânica). Total executado ${M(c.total?.exec)} de ${M(c.total?.oe_final)} orçamentados (orçamento inicial ${M(c.total?.oe_inicial)}). Contas disponíveis: ${c.years.join(", ")}. Fonte: ${ext(c.source_url, "CGE — quadros (Entidade Orçamental)")}.</p></section>`;
  }

  /* ---------- página principal ---------- */
  async function pageMain(params) {
    const d = await Portal.api("orcamento/overview" + Portal.qs({ year: params.ano }));
    if (d.error) { $app.innerHTML = `<h1>Orçamento do Estado</h1><p class="note warn">${esc(d.error)}</p>`; return; }
    const y = d.year, m = d.month, k = d.kpis, mesTxt = `jan–${MES[m - 1]} ${y}`;
    const ser = (arr) => arr.filter((p) => p.month <= 12).map((p) => [p.month, p.cum]);
    const oe = d.oeNext;
    const ecoRows = d.eco.filter((e) => e.exec != null).map((e) => ({ label: e.label, value: e.exec, ref: e.budget ? e.budget * m / 12 : null,
      tip: `Executado ${mesTxt}: ${M(e.exec)}<br>Mesmo período ${y - 1}: ${M(e.prev)}<br>Orçamento inicial ${y}: ${M(e.budget)} (execução ${e.budget ? Portal.pct(pct(e.exec, e.budget), 1) : "—"})`,
      extra: delta(e.exec, e.prev) }));
    const progRows = d.byProgram.filter((p) => p.exec != null).sort((a, b) => b.exec - a.exec).map((p) => ({ label: p.line.replace(/^\d{3}\s*-\s*/, ""), value: p.exec, 
      sub: p.ministry ? (p.ministryName && p.ministryName.toLowerCase() !== p.line.replace(/^\d{3}\s*-\s*/, "").toLowerCase() ? p.ministryName : "") : "Encargos gerais do Estado", href: p.ministry ? `#/orcamento/${p.ministry}` : null,
      tip: `Despesa efetiva consolidada ${mesTxt}: ${M(p.exec)}<br>Mesmo período ${y - 1}: ${M(p.prev)}${p.proposta ? `<br>Proposta OE${y} (despesa total consolidada, inclui fluxos): ${M(p.proposta)}` : ""}`,
      extra: delta(p.exec, p.prev) }));
    const taxRows = d.taxes.map((t) => ({ label: t.label, value: t.exec, ref: t.budget ? t.budget * m / 12 : null, tip: `Cobrado ${mesTxt}: ${M(t.exec)}<br>Mesmo período ${y - 1}: ${M(t.prev)}<br>Previsto no OE${y}: ${M(t.budget)}`, extra: delta(t.exec, t.prev) }));
    const def = d.deficit, lastDef = def.saldo[def.saldo.length - 1], lastDebt = def.divida[def.divida.length - 1];
    const oeYear = oe && oe.oe;
    const yrLinks = `<label class="small muted" for="orc-ano">Ano</label> <select id="orc-ano">${d.years.slice().reverse().map((yy) => `<option ${yy === y ? "selected" : ""}>${yy}</option>`).join("")}</select>`
      + d.years.slice(-4).map((yy) => `<a class="${yy === y ? "on" : ""}" href="#/orcamento?ano=${yy}">${yy}</a>`).join("");
    $app.innerHTML = css + `
      <div class="pagehead"><div><div class="kicker">Orçamento do Estado · contabilidade pública</div><h1>Para onde vai o dinheiro</h1>
        <div class="lead">Quanto o Estado planeou gastar, quanto gastou de facto e em quê — execução mensal do Orçamento do Estado, receitas fiscais e despesa por ministério.</div></div>
        <div class="orc-years" aria-label="Ano">${yrLinks}</div></div>
      ${oeYear && oeYear > y ? `<p class="note">Em discussão no Parlamento: <b>Proposta de Orçamento do Estado para ${oeYear}</b>${oe.law ? ` — <a href="${oe.law}">Proposta de Lei 110/XVII (votações e calendário)</a>` : ""} · <a href="#oe-next">ver números da proposta ↓</a></p>` : ""}
      <h2 style="margin:.4rem 0 .6rem">Estado (subsetor) · ${esc(mesTxt)}</h2>
      <div class="kpis">
        <div class="kpi"><b>${M(k.receita.exec)}</b><span>receita efetiva ${delta(k.receita.exec, k.receita.prev)}</span></div>
        <div class="kpi"><b>${M(k.despesa.exec)}</b><span>despesa efetiva ${delta(k.despesa.exec, k.despesa.prev)}</span></div>
        <div class="kpi"><b>${M(k.saldo.exec)}</b><span>saldo do Estado (${y - 1}: ${M(k.saldo.prev)})</span></div>
        <div class="kpi"><b>${k.despesa.budget ? Portal.pct(pct(k.despesa.exec, k.despesa.budget), 1) : "—"}</b><span>da despesa orçada executada (${M(k.despesa.budget)})</span></div>
        <div class="kpi"><b>${M(d.ap.saldo.exec)}</b><span>saldo das Administrações Públicas (${y - 1}: ${M(d.ap.saldo.prev)})</span></div>
        <div class="kpi"><b>${lastDef ? Portal.pct(lastDef.value, 1) : "—"} / ${lastDebt ? Portal.pct(lastDebt.value, 1) : "—"}</b><span>saldo / dívida das AP em % do PIB (${lastDef ? lastDef.year : ""}, Eurostat)</span></div>
      </div>
      <section class="panel"><h2>Orçamento vs execução, mês a mês</h2>
        <div class="cols">
          <div><h3>Despesa efetiva do Estado (acumulada)</h3>${lineChart([
            { name: `Despesa ${y}`, color: "var(--bar)", pts: ser(d.series.despesa) },
            { name: `Despesa ${y - 1}`, color: "var(--bar)", dash: "5 4", pts: ser(d.series.despesaPrev) }], { budget: k.despesa.budget })}</div>
          <div><h3>Receita efetiva do Estado (acumulada)</h3>${lineChart([
            { name: `Receita ${y}`, color: "var(--accent)", pts: ser(d.series.receita) },
            { name: `Receita ${y - 1}`, color: "var(--accent)", dash: "5 4", pts: ser(d.series.receitaPrev) }], { budget: k.receita.budget })}</div>
        </div>
        <details><summary>Ver tabela mensal</summary>${Portal.table([
          { h: "Mês", f: (r) => MESF[r.month - 1] }, { h: "Receita do mês", num: 1, f: (r) => M(r.rv) }, { h: "Despesa do mês", num: 1, f: (r) => M(r.dv) },
          { h: "Receita acumulada", num: 1, f: (r) => M(r.rc) }, { h: "Despesa acumulada", num: 1, f: (r) => M(r.dc) }, { h: "Saldo acumulado", num: 1, f: (r) => M(r.rc != null && r.dc != null ? r.rc - r.dc : null) },
          { h: "Saldo AP acumulado", num: 1, f: (r) => M(r.ap) }],
          d.series.despesa.map((x) => { const r = d.series.receita.find((z) => z.month === x.month) || {}; const a = d.series.saldoAP.find((z) => z.month === x.month) || {};
            return { month: x.month, dv: x.value, dc: x.cum, rv: r.value, rc: r.cum, ap: a.cum }; }))}</details>
        <p class="small muted">Valores acumulados de janeiro ao mês indicado, em contabilidade pública (ótica de caixa), subsetor Estado. A linha pontilhada cinzenta é o orçamento inicial repartido de forma linear pelo ano — referência visual, não um objetivo mensal oficial. ${y > 2021 && d.kpis.despesa.cge ? `Conta Geral do Estado ${y}: despesa ${M(d.kpis.despesa.cge)}.` : ""}</p></section>

      <div class="cols">
        <section class="panel"><h2>Em que se gasta (classificação económica)</h2>${hbars(ecoRows, { refLabel: `Orçamento inicial ${y} pro-rata a ${MES[m - 1]}` })}
          <p class="small muted">Despesa do subsetor Estado, ${esc(mesTxt)}. As transferências correntes incluem as verbas passadas à Segurança Social, SNS, autarquias e UE.</p></section>
        <section class="panel"><h2>De onde vem a receita (impostos)</h2>${hbars(taxRows, { refLabel: `Previsto no OE${y} pro-rata a ${MES[m - 1]}` })}
          <p class="small muted">Receita fiscal do Estado cobrada, ${esc(mesTxt)}; variação face ao mesmo período de ${y - 1}.</p></section>
      </div>

      <section class="panel"><h2>Despesa por ministério (${d.byProgram.some((p) => p.legacy) ? "subsetor Estado, ministérios da época" : "programa orçamental"})</h2>${progRows.length ? hbars(progRows) : '<p class="note warn">Sem dados por programa para este ano.</p>'}
        <p class="small muted">${d.byProgram.some((p) => p.legacy) ? "Despesa efetiva do subsetor Estado por ministério (quadro antigo da Síntese da Execução Orçamental; não inclui serviços e fundos autónomos)" : "Despesa efetiva consolidada da Administração Central por programa orçamental"}, ${esc(mesTxt)} (exclui ativos/passivos financeiros). Total: ${M(d.programsTotal?.exec)}${d.programsTotal ? delta(d.programsTotal.exec, d.programsTotal.prev) : ""}. Clique num ministério para ver a evolução e as entidades.</p></section>

      ${cgePanel(d.cge)}
      ${longrunPanel(d, params)}
      ${oe ? oeBlock(oe) : ""}

      <div class="cols">
        <section class="panel"><h2>Défice e dívida das Administrações Públicas</h2>${defChart(def)}
          <p class="small muted">Contabilidade nacional (Procedimento dos Défices Excessivos), % do PIB. Fonte: ${ext(def.source, "Eurostat gov_10dd_edpt1")}.</p></section>
        <section class="panel"><h2>Despesa pública por função (COFOG, ${esc(d.cofog.year)})</h2>${hbars(d.cofog.rows.filter((r) => r.code !== "TOTAL").map((r) => ({ label: COFOG[r.code] || r.label, value: r.mio, extra: r.pct != null ? ` <span class="small muted">${r.pct.toFixed(1)}% PIB</span>` : "" })))}
          <p class="small muted">Todas as Administrações Públicas (Estado, Segurança Social, autarquias, regiões). Total ${M(d.cofog.rows.find((r) => r.code === "TOTAL")?.mio)}. Fonte: ${ext(d.cofog.source, "Eurostat gov_10a_exp")}.</p></section>
      </div>

      <section class="panel"><h2>Fontes</h2><ul class="small">
        <li>${ext(d.edition?.url, `Síntese da Execução Orçamental — ${MESF[m - 1]} ${y}, Anexo Estatístico`)} (Entidade Orçamental, ex-DGO)</li>
        ${oe ? `<li>${ext(oe.source_url, `Proposta de Orçamento do Estado ${oe.oe} — quadros do Relatório`)}</li>` : ""}
        <li>Eurostat: ${ext(d.deficit.source, "défice e dívida")}, ${ext(d.cofog.source, "despesa por função")}</li>
        <li class="muted">Atualizado: ${esc(d.meta.updated || "")}</li>
        ${d.checks?.sums?.n ? `<li class="muted">Verificações automáticas: ${Portal.int(d.checks.sums.n)} totais comparados com a soma das parcelas, ${Portal.int(d.checks.sums.bad || 0)} com diferença &gt; 0,5% (máx. ${(d.checks.sums.worst || 0).toFixed(2)}%).</li>` : ""}</ul>
        ${(d.blocked || []).length ? `<details><summary>O que não está incluído / bloqueado</summary><ul class="small">${d.blocked.map((b) => `<li><b>${esc(b.source)}</b>: ${esc(b.reason)}</li>`).join("")}</ul></details>` : ""}</section>`;
    tips($app);
    const sel = document.getElementById("orc-ano");
    if (sel) sel.onchange = () => Portal.go("orcamento", "", { ...params, ano: sel.value });
    const fr = document.getElementById("orc-range");
    if (fr) fr.onchange = () => { const f = new FormData(fr); Portal.go("orcamento", "", { ...params, de: f.get("de"), ate: f.get("ate") }); setTimeout(() => document.getElementById("longo")?.scrollIntoView(), 400); };
  }

  const COFOG = { GF01: "Serviços gerais (inclui juros da dívida)", GF02: "Defesa", GF03: "Segurança e ordem pública", GF04: "Assuntos económicos", GF05: "Proteção do ambiente", GF06: "Habitação e equipamentos coletivos", GF07: "Saúde", GF08: "Cultura, desporto e religião", GF09: "Educação", GF10: "Proteção social" };

  function defChart(def) {
    const s = def.saldo, dv = def.divida;
    if (!s.length) return '<p class="note warn">Sem dados Eurostat.</p>';
    return `${Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Saldo (% PIB)", num: 1, f: (r) => `<span style="color:${r.s < 0 ? "var(--alert)" : "var(--accent)"}">${r.s != null ? r.s.toFixed(1) : "—"}</span>` },
      { h: "Saldo", num: 1, f: (r) => M(r.sm) }, { h: "Dívida (% PIB)", num: 1, f: (r) => (r.d != null ? r.d.toFixed(1) : "—") }, { h: "Dívida", num: 1, f: (r) => M(r.dm) }],
      s.slice(-10).reverse().map((r) => ({ year: r.year, s: r.value, sm: def.saldoMio.find((x) => x.year === r.year)?.value, d: dv.find((x) => x.year === r.year)?.value, dm: def.dividaMio.find((x) => x.year === r.year)?.value })))}`;
  }

  function oeBlock(oe) {
    const prog = oe.programas.filter((p) => p.value != null).sort((a, b) => b.value - a.value);
    const saldoAP = oe.ap.filter((r) => /^cap\./i.test(r.line) && /PIB/i.test(r.col)).map((r) => ({ ...r, line: "Saldo das AP (contas nacionais)" }));
    const debt = oe.divida;
    return `<section class="panel" id="oe-next"><h2>Proposta de Orçamento do Estado para ${oe.oe}</h2>
      <p class="small">${oe.law ? `<a href="${oe.law}">Acompanhar a Proposta de Lei 110/XVII no Parlamento →</a> · ` : ""}${ext(oe.source_url, "quadros oficiais (XLSX)")}</p>
      ${saldoAP.length || debt.length ? `<div class="kpis">        ${saldoAP.length ? saldoAP.filter((r) => /^20\d\d/.test(r.col)).slice(-3).map((r) => `<div class="kpi"><b>${r.value.toFixed(1)}%</b><span>${esc(r.line)} · ${esc(r.col.replace(/\s*\|\s*% do PIB/, ""))}</span></div>`).join("") : ""}
        ${debt.slice(-2).map((r) => `<div class="kpi"><b>${r.value.toFixed(1)}%</b><span>dívida pública · ${esc(r.col)}</span></div>`).join("")}</div>` : ""}
      <div class="cols">
        <div><h3>Receita fiscal do Estado prevista</h3>${Portal.table([{ h: "Imposto", f: (r) => esc(r.line) }, { h: `${oe.oe - 1} (estimativa)`, num: 1, f: (r) => M(r.prev) }, { h: `${oe.oe} (proposta)`, num: 1, f: (r) => `<b>${M(r.value)}</b>` }, { h: "Var.", num: 1, f: (r) => delta(r.value, r.prev) }], oe.taxes)}</div>
        <div><h3>Despesa efetiva da Administração Central</h3>${Portal.table([{ h: "Rubrica", f: (r) => esc(r.line) }, { h: `${oe.oe - 1} (estimativa)`, num: 1, f: (r) => M(r.prev) }, { h: `${oe.oe} (proposta)`, num: 1, f: (r) => `<b>${M(r.value)}</b>` }, { h: "Var.", num: 1, f: (r) => delta(r.value, r.prev) }], oe.eco.filter((r) => !/%|PIB/.test(r.line)))}</div>
      </div>
      <h3>Despesa total consolidada por programa (inclui ativos/passivos financeiros)</h3>
      ${hbars(prog.map((p) => ({ label: p.line.charAt(0) + p.line.slice(1).toLowerCase(), value: p.value, sub: p.ministryName && p.ministryName.toLowerCase() !== p.line.toLowerCase() ? p.ministryName : "", href: p.ministry ? `#/orcamento/${p.ministry}` : null })))}
      <p class="small muted">"Gestão da Dívida Pública" inclui as amortizações e refinanciamento da dívida (não é despesa efetiva); "Finanças" inclui dotações provisionais e transferências para outros subsetores.</p></section>`;
  }

  /* ---------- página de ministério ---------- */
  async function pageMinistry(slug) {
    const d = await Portal.api("orcamento/ministerio?slug=" + encodeURIComponent(slug));
    const head = `<div class="crumbs"><a href="#/">Início</a> / <a href="#/orcamento">Orçamento</a></div>
      <div class="pagehead"><div><div class="kicker">Orçamento por ministério</div><h1>${esc(d.name || slug)}</h1>
      <div class="small"><a href="#/ministerios/${esc(slug)}">Perfil do ministério →</a></div></div></div>`;
    if (d.error && !(d.programs || []).length && !(d.cge || []).length) { $app.innerHTML = css + head + `<p class="note warn">${esc(d.error)}</p>`; return; }
    const blocks = d.programs.map((p) => {
      const ys = Object.keys(p.monthly).map(Number).sort();
      const colors = ["var(--bar)", "var(--accent)", "var(--bar2)"];
      return `<section class="panel"><h2>${esc(p.line)}</h2>
        ${lineChart(ys.map((yy, i) => ({ name: String(yy), color: colors[(i + 3 - ys.length) % 3] || "var(--bar)", dash: yy === ys[ys.length - 1] ? null : "5 4", pts: p.monthly[yy].map((x) => [x.month, x.cum]) })), { height: 200 })}
        ${Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Executado (despesa efetiva)", num: 1, f: (r) => `${M(r.exec)}${r.month && r.month < 12 ? ` <span class="small muted">até ${MES[r.month - 1]}</span>` : ""}` },
          { h: "Proposta OE (despesa total)", num: 1, f: (r) => M(r.proposta) }], p.years.filter((r) => r.exec != null || r.proposta != null).reverse())}</section>`;
    }).join("");
    const conta = (d.oeConta || []).filter((c) => c.oe === Math.max(...d.oeConta.map((x) => x.oe)));
    const contaHtml = conta.map((c) => `<div><h3>${esc(c.program)} — OE${c.oe}</h3>${Portal.table([{ h: "Rubrica", f: (r) => (/^despesa (corrente|de capital|efetiva|total)/i.test(r.line) ? `<b>${esc(r.line)}</b>` : esc(r.line)) },
      { h: `${c.oe - 1} estimativa`, num: 1, f: (r) => M(r.estimate) }, { h: `${c.oe} proposta`, num: 1, f: (r) => M(r.budget) }, { h: "Var.", num: 1, f: (r) => delta(r.budget, r.estimate) }], c.lines.filter((r) => r.budget != null || r.estimate != null))}</div>`).join("");
    $app.innerHTML = css + head + `<p class="small muted">Programas orçamentais associados a este ministério. Execução = despesa efetiva consolidada acumulada (Síntese da Execução Orçamental); proposta = despesa total consolidada na Proposta de OE desse ano (inclui ativos financeiros e transferências para outros programas, por isso não é diretamente comparável).</p>
      ${blocks}
      ${(d.cge || []).length ? `<section class="panel"><h2>Conta Geral do Estado: orçado vs executado</h2>${Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Designação na conta", f: (r) => esc(r.line) },
          { h: "Orçamento inicial", num: 1, f: (r) => M(r.oe_inicial) }, { h: "Orçamento final", num: 1, f: (r) => M(r.oe_final) }, { h: "Executado", num: 1, f: (r) => `<b>${M(r.exec)}</b>` },
          { h: "Exec./final", num: 1, f: (r) => (r.oe_final ? Portal.pct(100 * r.exec / r.oe_final, 1) : "—") }, { h: "Fonte", f: (r) => ext(r.source_url, "CGE") }], d.cge.slice().reverse())}
        <p class="small muted">Despesa efetiva consolidada da Administração Central, classificação orgânica (ministério). Os nomes e o perímetro dos ministérios mudam entre governos.</p></section>` : ""}
      ${(d.oldMinistry || []).length ? `<section class="panel"><h2>Despesa do Estado por ministério, 2009–2013</h2>${Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Ministério (designação da época)", f: (r) => esc(r.line) },
          { h: "Despesa efetiva do Estado", num: 1, f: (r) => `${M(r.value)}${r.month < 12 ? ` <span class="small muted">até ${MES[r.month - 1]}</span>` : ""}` }, { h: "Fonte", f: (r) => ext(r.source_url, "SEO") }], d.oldMinistry.slice().reverse())}
        <p class="small muted">Subsetor Estado apenas (sem serviços e fundos autónomos), dos anexos antigos da Síntese da Execução Orçamental.</p></section>` : ""}
      ${contaHtml ? `<section class="panel"><h2>Em que gasta — classificação económica (proposta mais recente)</h2><div class="cols">${contaHtml}</div></section>` : ""}
      <section class="panel"><h2>Entidades financiadas pelo Orçamento (${d.entities.length})</h2>
        ${d.entities.length ? Portal.table([{ h: "Entidade", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)) }, { h: "NIF", f: (r) => esc(r.nif) }, { h: "Missão de base orgânica", f: (r) => `<span class="small">${esc(r.mbo || "")}</span>` }], d.entities)
          : '<p class="note">Sem lista de entidades para este ministério.</p>'}
        <p class="small muted">Lista oficial de entidades da Administração Central e Segurança Social por Missão de Base Orgânica (Relatório da Proposta de OE${d.entities[0]?.oe || ""}, quadro A4.1). A ligação ao ministério é feita pelo nome da missão.</p></section>`;
    tips($app);
  }

  Portal.page("orcamento", (arg, params) => (arg ? pageMinistry(arg) : pageMain(params || {})));
})();
