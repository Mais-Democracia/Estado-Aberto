"use strict";
/* Módulo "habitacao": #/habitacao — habitação por município: alojamento local (RNAL), preços e rendas (INE), licenciamento,
   Censos 2021, PRR C02 (1.º Direito), contratação pública e legislação. API: /api/habitacao/*. */
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const n0 = (v) => (v == null ? "—" : Portal.int(Math.round(v)));
  const n1 = (v) => (v == null ? "—" : nf.format(v));
  const fmt = (v, unit) => (v == null ? "—" : unit === "€" ? Portal.eur(v) : unit === "%" ? n1(v) + " %" : /€\/m²/.test(unit) ? n0(v) + " €/m²" : /^(AL\/|utentes\/|€\/hab|fogos\/)/.test(unit) ? n1(v) : n0(v));
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>.hb-svg{width:100%;height:auto;max-height:220px}.hb-svg text{fill:var(--muted);font:11px system-ui}.hb-svg .ln{fill:none;stroke:var(--bar);stroke-width:2.2}.hb-svg .ln2{fill:none;stroke:var(--bar2);stroke-width:2}.hb-svg .pt{fill:var(--bar)}.hb-svg .gr{stroke:var(--line2)}.hb-svg rect.b{fill:var(--bar)}
  .hb-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}.hb-grid h3{margin:.2rem 0}.hb-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;align-items:center}.hb-filters select,.hb-filters input{max-width:100%}
  .hb-tl{border-left:3px solid var(--line2);margin:8px 0 8px 6px;padding-left:12px}.hb-tl .it{margin:0 0 10px}.hb-tl small{color:var(--muted)}</style>`;
  Portal.nav("Habitação", "#/habitacao");

  function svgLine(series, o = {}) {
    // series: [{label, pts:[{x(label), v}], cls}]
    const all = series.flatMap((s) => s.pts);
    if (!all.length) return '<p class="note">Sem dados.</p>';
    const xs = [...new Set(all.map((p) => p.x))].sort();
    const W = 520, H = 200, L = 54, R = 12, T = 12, B = 26;
    const ys = all.map((p) => p.v), min = o.zero === false ? Math.min(...ys) * 0.95 : Math.min(0, ...ys), max = Math.max(...ys, 1);
    const X = (x) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) * (W - L - R)) / (xs.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const grid = [0, 0.5, 1].map((f) => { const v = min + (max - min) * f; return `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(nf.format(Math.round(v)))}</text>`; }).join("");
    const step = Math.ceil(xs.length / 7);
    const xl = xs.map((x, i) => (i % step === 0 || i === xs.length - 1 ? `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${esc(String(x).replace(/^(\d{4})Q(\d)$/, "$1 T$2"))}</text>` : "")).join("");
    const paths = series.map((s) => {
      const pp = s.pts.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
      const d = pp.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
      const dots = pp.length < 40 ? pp.map((p) => `<circle class="pt" cx="${X(p.x)}" cy="${Y(p.v)}" r="2.6"><title>${esc(s.label || "")} ${esc(p.x)}: ${esc(nf.format(p.v))}</title></circle>`).join("") : "";
      return `<path class="${s.cls || "ln"}" d="${d}"/>${dots}`;
    }).join("");
    return `<svg class="hb-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "série")}">${grid}${xl}${paths}</svg>`;
  }
  function svgBars(rows, o = {}) {
    if (!rows.length) return '<p class="note">Sem dados.</p>';
    const W = 520, H = 190, L = 44, R = 8, T = 10, B = 24;
    const max = Math.max(1, ...rows.map((r) => r.v));
    const bw = (W - L - R) / rows.length;
    const step = Math.ceil(rows.length / 12);
    return `<svg class="hb-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "barras")}">
      <text x="${L - 6}" y="${T + 8}" text-anchor="end">${esc(nf.format(Math.round(max)))}</text><text x="${L - 6}" y="${H - B}" text-anchor="end">0</text><line class="gr" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      ${rows.map((r, i) => { const h = (H - T - B) * r.v / max; return `<rect class="b" x="${L + i * bw + 1}" y="${H - B - h}" width="${Math.max(1, bw - 2)}" height="${h}"><title>${esc(r.x)}: ${esc(nf.format(r.v))}</title></rect>${i % step === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(String(r.x).slice(o.cut || 0))}</text>` : ""}`; }).join("")}</svg>`;
  }
  const lineOf = (points, label) => ({ label, pts: (points || []).map((p) => ({ x: p.period || String(p.year), v: p.value })) });
  const panel = (title, body, src, sub) => `<section class="panel"><h3>${esc(title)}</h3>${body}<p class="small muted">${sub || ""}${src ? " " + ext(src, "fonte") : ""}</p></section>`;
  const kpi = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;
  const lastPt = (a) => (a && a.length ? a[a.length - 1] : null);
  const delta = (a, back) => { const l = lastPt(a); if (!l) return ""; const q = a[a.length - 1 - back]; return q && q.value ? ` · ${l.value >= q.value ? "+" : ""}${n1(100 * (l.value / q.value - 1))} % vs ${esc(q.period || q.year)}` : ""; };

  /* ------------------------------------------------------------------ município */
  function concelhoHtml(d, compact) {
    const al = d.al || {}, ce = d.censos || {}, mk = d.mercado || {}, ct = d.contratacao || {};
    const k = [];
    if (al.n) k.push(kpi(Portal.int(al.n), `estabelecimentos de alojamento local ativos${al.rank_per100 ? ` · ${n1(al.per100_alojamentos)} por 100 alojamentos (${al.rank_per100}.º de ${al.n_municipios_al})` : ""}`));
    else k.push(kpi("0", "estabelecimentos de AL registados (RNAL)"));
    const v = lastPt(mk.venda.points), r = lastPt(mk.renda.points);
    k.push(kpi(v ? n0(v.value) + " €/m²" : "—", v ? `preço mediano de venda (${esc(v.period)})${mk.venda.rank ? ` · ${mk.venda.rank}.º de ${mk.venda.de}` : ""}${delta(mk.venda.points, 4)}` : "preço de venda: INE não publica para este município"));
    k.push(kpi(r ? n1(r.value) + " €/m²" : "—", r ? `renda mediana novos contratos (${esc(r.period)})${mk.renda.rank ? ` · ${mk.renda.rank}.º de ${mk.renda.de}` : ""}${delta(mk.renda.points, 4)}` : "renda: INE não publica para este município"));
    if (ce.alojamentos) k.push(kpi(n1(ce.arrendados_pct) + " %", `da residência habitual é arrendada (Censos 2021) · ${n1(ce.secundaria_pct)} % dos alojamentos são residência secundária`));
    const prrT = (d.prr.rows || []).reduce((a, x) => ({ fogos: a.fogos + (x.fogos || 0), apr: a.apr + (x.aprovado || 0), n: a.n + x.n }), { fogos: 0, apr: 0, n: 0 });
    if (prrT.n) k.push(kpi(Portal.eur(prrT.apr), `PRR habitação aprovado · ${Portal.int(prrT.n)} projetos${prrT.fogos ? ` · ${Portal.int(prrT.fogos)} fogos (nos títulos)` : ""}`));
    let h = `<div class="kpis">${k.join("")}</div>`;
    const ch = [];
    if (mk.venda.points.length) ch.push(panel("Preço mediano de venda (€/m²)", svgLine([lineOf(mk.venda.points, "Venda")], { zero: false, label: "venda" }), mk.venda.source_url, `Últimos 12 meses, ${esc(mk.venda.points[0].period)}–${esc(lastPt(mk.venda.points).period)}, INE.`));
    else ch.push(`<section class="panel"><p class="note warn">${esc(mk.nota || "Sem série de preço de venda.")}</p></section>`);
    if (mk.renda.points.length) ch.push(panel("Renda mediana de novos contratos (€/m²)", svgLine([{ ...lineOf(mk.renda.points, "Renda"), cls: "ln2" }], { zero: false, label: "renda" }), mk.renda.source_url, `Últimos 12 meses, ${esc(mk.renda.points[0].period)}–${esc(lastPt(mk.renda.points).period)}, INE.`));
    else ch.push(`<section class="panel"><p class="note warn">Renda: o INE não publica valor para este município.</p></section>`);
    {
    }
    if (al.serie_ano && al.serie_ano.length) {
      const ys = al.serie_ano.filter((x) => x.year >= 2008);
      ch.push(panel("Alojamento local: registos ativos acumulados", svgLine([{ label: "AL", pts: ys.map((x) => ({ x: String(x.year), v: x.cum_n })) }], { label: "AL acumulado" }), al.source_url,
        `Por ano de registo, só estabelecimentos ainda ativos em ${esc(al.snapshot)} (os cancelados não constam).`));
    }
    if ((mk.licenciados || []).length) ch.push(panel("Fogos licenciados em construção nova", svgBars(mk.licenciados.map((x) => ({ x: x.year, v: x.value })), { cut: 2, label: "fogos licenciados" }), "https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0013235&lang=PT",
      `${mk.licenciados[0].year}–${lastPt(mk.licenciados).year}` + ((mk.concluidos || []).length ? ` · concluídos em ${lastPt(mk.concluidos).year}: ${n0(lastPt(mk.concluidos).value)}` : "")));
    h += `<div class="hb-grid">${ch.join("")}</div>`;
    if (ce.alojamentos) {
      h += `<h3>Parque habitacional (Censos 2021)</h3>` + Portal.table([{ h: "Forma de ocupação", f: (x) => esc(x[0]) }, { h: "Alojamentos", num: 1, f: (x) => n0(x[1]) }, { h: "% do total", num: 1, f: (x) => n1(100 * x[1] / ce.alojamentos) + " %" }],
        [["Residência habitual", ce.residencia_habitual], ["Residência secundária", ce.secundaria], ["Vago para venda ou arrendamento", ce.vagos_venda_arrend], ["Vago por outros motivos", ce.vagos_outros], ["Total", ce.alojamentos]]) +
        `<p class="small muted">${ext(ce.source_url, "INE, Censos 2021")}${ce.arrendados != null ? ` · Residência habitual arrendada: ${n0(ce.arrendados)} de ${n0(ce.regime_total)}` : ""}</p>`;
    }
    const soc = d.social || {};
    if ((soc.points || []).length) h += `<h3>Habitação social municipal</h3><p class="small">Fogos de habitação social (inquérito do INE às câmaras): ${soc.points.map((p) => `${esc(p.period)}: <b>${n0(p.value)}</b>`).join(" · ")}. ${esc(soc.nota)} ${ext(soc.source_url, "fonte")}</p>`;
    if ((d.prr.rows || []).length) h += `<h3>PRR · Habitação (C02)</h3>` + Portal.table([{ h: "Investimento", f: (x) => `<b>${esc(x.code)}</b> · ${esc(x.label)}` }, { h: "Projetos", num: 1, f: (x) => n0(x.n) }, { h: "Fogos", num: 1, f: (x) => (x.fogos ? n0(x.fogos) : "—") }, { h: "Aprovado", num: 1, f: (x) => Portal.eur(x.aprovado) }, { h: "Pago", num: 1, f: (x) => Portal.eur(x.pago) }], d.prr.rows) +
      `<p class="small muted">${esc(d.prr.nota)}</p>`;
    else h += `<p class="small muted">Sem projetos PRR de habitação localizados neste município. ${esc(d.prr.nota)}</p>`;
    // contratação
    const sum = (lens, g) => (ct.agg || []).filter((x) => x.lens === lens && (!g || x.grp === g)).reduce((a, x) => ({ n: a.n + x.n, v: a.v + x.value }), { n: 0, v: 0 });
    const GL = { construcao_residencial: "Construção residencial (CPV 45211)", imobiliario: "Serviços imobiliários (CPV 70)", objeto_habitacao: "Objeto menciona habitação/fogos", habitacao_entidade: "Outros contratos de entidades de habitação" };
    const gr = Object.keys(GL).map((g) => ({ g, ...sum("comprador", g) })).filter((x) => x.n);
    if (gr.length || (ct.empresas || []).length) {
      h += `<h3>Contratação pública de habitação</h3>` + (gr.length ? Portal.table([{ h: "Tipo (comprador: município, freguesias, empresa municipal)", f: (x) => esc(GL[x.g]) }, { h: "Contratos", num: 1, f: (x) => n0(x.n) }, { h: "Valor", num: 1, f: (x) => Portal.eur(x.v) }], gr) : "");
      if ((ct.empresas || []).length) h += `<p class="small">Empresas municipais de habitação: ${ct.empresas.map((e) => (e.entity_id ? `<a href="#/entidade/${e.entity_id}">${esc(e.name)}</a>` : esc(e.name)) + ` (${n0(e.n)} contratos, ${Portal.eur(e.value)})`).join("; ")}.</p>`;
      const tp = (ct.top || []).filter((x) => x.lens === "comprador").slice(0, compact ? 5 : 10);
      if (tp.length) h += Portal.table([{ h: "Maiores contratos", f: (x) => `${ext(x.source_url, x.object || "contrato")}<br><small class="muted">${esc(x.buyer_name || "")} → ${esc(x.seller_name || "—")}</small>` }, { h: "Data", f: (x) => esc((x.signed || "").slice(0, 10)) }, { h: "Valor", num: 1, f: (x) => Portal.eur(x.price) }], tp);
      h += `<p class="small muted">${esc(ct.nota)}</p>`;
    }
    return h;
  }

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || e.kind !== "municipio") return;
    const d = await Portal.api("habitacao/concelho?" + (e.dico ? "dico=" + encodeURIComponent(e.dico) : "nif=" + encodeURIComponent(e.nif || ""))).catch(() => null);
    if (!d || !d.found) return;
    el.insertAdjacentHTML("beforeend", `${css}<section class="panel"><h2>Habitação</h2>${concelhoHtml(d, true)}<p class="small"><a href="#/habitacao/${esc(d.municipio.dico)}">Página completa de habitação deste município →</a> · <a href="#/habitacao">Habitação em Portugal</a></p></section>`);
  });

  /* ------------------------------------------------------------------ página */
  const TABS = [["resumo", "Panorama"], ["ranking", "Rankings por município"], ["leis", "Leis e votações"], ["fontes", "Fontes e lacunas"]];
  const nav = (t) => `<div class="tabs" style="margin:0 0 12px;display:flex;gap:8px;flex-wrap:wrap">${TABS.map(([k, l]) => `<a class="btn${k === t ? " on" : ""}" href="#/habitacao?tab=${k}"${k === t ? ' style="font-weight:700"' : ""}>${l}</a>`).join("")}</div>`;

  async function resumo(ov) {
    const al = ov.al, mk = ov.mercado, ce = ov.censos, po = ov.politica;
    const v = lastPt(mk.venda.points), r = lastPt(mk.renda.points), lic = lastPt(mk.licenciados.points);
    let h = `<div class="kpis">
      ${kpi(Portal.int(al.n), `alojamentos locais ativos no RNAL (${esc(al.snapshot)}) · ${n1(al.per100)} por 100 alojamentos · ${Portal.int(al.utentes)} utentes`)}
      ${kpi(v ? n0(v.value) + " €/m²" : "—", `mediana nacional de venda (${v ? esc(v.period) : ""})${delta(mk.venda.points, 4)}`)}
      ${kpi(r ? n1(r.value) + " €/m²" : "—", `renda mediana nacional, novos contratos (${r ? esc(r.period) : ""})${delta(mk.renda.points, 4)}`)}
      ${kpi(lic ? n0(lic.value) : "—", `fogos licenciados em construção nova (${lic ? lic.year : ""})${delta(mk.licenciados.points, 1)}`)}
      ${kpi(n1(ce.arrendados_pct) + " %", "da residência habitual é arrendada (Censos 2021)")}
      ${kpi(n1(ce.vagos_pct) + " %", `dos alojamentos estão vagos · ${n1(ce.secundaria_pct)} % residência secundária (Censos 2021)`)}</div>`;
    h += `<div class="hb-grid">` +
      panel("Preço mediano de venda (€/m², Portugal)", svgLine([lineOf(mk.venda.points, "Venda")], { zero: false, label: "venda" }), mk.venda.source_url, `Últimos 12 meses, INE; ${mk.venda.n_concelhos} municípios têm valor publicado.`) +
      panel("Renda mediana de novos contratos (€/m², Portugal)", svgLine([{ ...lineOf(mk.renda.points, "Renda"), cls: "ln2" }], { zero: false, label: "renda" }), mk.renda.source_url, `Últimos 12 meses, INE; ${mk.renda.n_concelhos} municípios têm valor publicado.`) +
      panel("Alojamento local: registos ativos acumulados por ano de registo", svgLine([{ label: "AL", pts: al.serie_ano.filter((x) => x.year >= 2008).map((x) => ({ x: String(x.year), v: x.cum_n })) }], { label: "AL" }), al.source_url, esc(al.nota)) +
      panel("Alojamento local: novos registos por mês (últimos 36 meses, ativos)", svgBars(al.serie_mes.map((x) => ({ x: x.month, v: x.n })), { label: "registos por mês", cut: 2 }), al.source_url, "Registos feitos em cada mês e ainda ativos hoje; os últimos meses refletem também os cancelamentos.") +
      panel("Fogos licenciados e concluídos (construção nova)", svgLine([{ ...lineOf(mk.licenciados.points, "Licenciados"), cls: "ln" }, { ...lineOf(mk.concluidos.points, "Concluídos"), cls: "ln2" }], { label: "licenciados e concluídos" }), mk.licenciados.source_url, "Linha 1: licenciados (desde 2002); linha 2: concluídos (desde 2011). INE.") +
      `</div>`;
    h += `<section class="panel"><h3>Alojamento local por modalidade</h3>${Portal.table([{ h: "Modalidade", f: (x) => esc(x.modalidade) }, { h: "Estabelecimentos", num: 1, f: (x) => n0(x.n) }, { h: "Utentes", num: 1, f: (x) => n0(x.utentes) }], al.modalidades)}</section>`;
    h += `<section class="panel"><h2>Política pública de habitação</h2><p class="note warn">${esc(po.bloqueado)}</p>
      <h3>PRR · Componente 02 Habitação (aprovado / pago)</h3>${Portal.table([{ h: "Investimento", f: (x) => `<b>${esc(x.code)}</b> · ${esc(x.label)}` }, { h: "Projetos", num: 1, f: (x) => n0(x.n) }, { h: "Fogos (nos títulos)", num: 1, f: (x) => (x.fogos ? n0(x.fogos) : "—") }, { h: "Aprovado", num: 1, f: (x) => Portal.eur(x.aprovado) }, { h: "Pago", num: 1, f: (x) => Portal.eur(x.pago) }], po.prr)}
      <p class="small muted">${ext("https://dados.gov.pt/pt/datasets/6717dc1f1b0eaad60ac5008e", "Estrutura de Missão Recuperar Portugal")}. Projetos sem município (“Nacional”) ficam fora dos rankings municipais.</p>
      <h3>Contratação do IHRU (Portal BASE)</h3><div class="grid2" style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div>${svgBars(po.ihru.map((y) => ({ x: y.year, v: y.value })), { cut: 2, label: "IHRU contratos por ano" })}<p class="small muted">Valor contratado por ano (€; ${po.ihru[0] ? po.ihru[0].year : ""}–${po.ihru.length ? po.ihru[po.ihru.length - 1].year : ""}). Contratos do Instituto da Habitação e da Reabilitação Urbana como comprador.</p></div>
      <div>${Portal.table([{ h: "Maiores fornecedores do IHRU", f: (x) => (x.entity_id ? `<a href="#/entidade/${x.entity_id}">${esc(x.seller_name || x.seller_nif)}</a>` : esc(x.seller_name || x.seller_nif || "—")) }, { h: "Contratos", num: 1, f: (x) => n0(x.n) }, { h: "Valor", num: 1, f: (x) => Portal.eur(x.value) }], po.ihruTop)}</div></div>
      <h3>Empresas municipais de habitação</h3>${Portal.table([{ h: "Empresa", f: (x) => (x.entity_id ? `<a href="#/entidade/${x.entity_id}">${esc(x.name)}</a>` : esc(x.name)) }, { h: "Município", f: (x) => (x.dico ? `<a href="#/habitacao/${esc(x.dico)}">${esc(x.municipio || x.dico)}</a>` : "—") }, { h: "Contratos (comprador)", num: 1, f: (x) => n0(x.n) }, { h: "Valor", num: 1, f: (x) => Portal.eur(x.value) }], po.empresas)}
      <p class="small muted">Município atribuído pelo nome ou por empresas_locais (heurística); sem município = região autónoma, associação ou nome ambíguo.</p></section>`;
    return h;
  }

  async function ranking(p) {
    const ind = p.ind || "venda_m2";
    const IND = [["venda_m2", "Preço de venda (€/m²)"], ["renda_m2", "Renda mediana (€/m²)"], ["al_per100", "AL por 100 alojamentos"], ["al_per100_hab", "AL por 100 res. habituais"], ["al_n", "AL: n.º de estabelecimentos"], ["al_utentes_hab", "AL: utentes por 100 hab."], ["arrendados_pct", "% residência arrendada"], ["secundaria_pct", "% residência secundária"], ["vagos_pct", "% alojamentos vagos"], ["licenciados", "Fogos licenciados"], ["licenciados_1000", "Fogos licenciados / 1000 aloj."], ["concluidos", "Fogos concluídos"], ["social_fogos", "Fogos de habitação social (2015)"], ["prr_fogos", "PRR habitação: fogos"], ["prr_aprovado", "PRR habitação: aprovado (€)"], ["prr_aprovado_pc", "PRR habitação: € por habitante"], ["contratos_valor", "Contratação de habitação (€)"]];
    const qs = new URLSearchParams({ indicador: ind, limit: p.all ? 400 : 60 });
    if (p.per) qs.set("periodo", p.per);
    if (p.ord) qs.set("ordem", p.ord);
    const d = await Portal.api("habitacao/ranking?" + qs.toString());
    const sel = `<div class="hb-filters"><label>Indicador <select id="hb-ind">${IND.map(([k, l]) => `<option value="${k}" ${k === ind ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${d.periodos ? `<label>Período <select id="hb-per">${d.periodos.map((x) => `<option ${x === d.periodo ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>` : `<span class="muted small">${esc(d.periodo || "")}</span>`}
      <label>Ordem <select id="hb-ord"><option value="desc" ${p.ord !== "asc" ? "selected" : ""}>Maior primeiro</option><option value="asc" ${p.ord === "asc" ? "selected" : ""}>Menor primeiro</option></select></label>
      <label><input type="checkbox" id="hb-all" ${p.all ? "checked" : ""}> todos (até 400)</label></div>`;
    const maxv = Math.max(1, ...d.rows.map((r) => Math.abs(r.value)));
    const tbl = Portal.table([{ h: "#", num: 1, f: (r) => r.rank }, { h: "Município", f: (r) => `<a href="#/habitacao/${esc(r.dico)}">${esc(r.name)}</a>${r.eid ? ` <a class="small muted" href="#/entidade/${r.eid}" title="Perfil da câmara">câmara</a>` : ""}<br><small class="muted">${esc(r.district || "")}</small>` },
      { h: d.label + " · " + (d.periodo || ""), num: 1, f: (r) => `<b>${fmt(r.value, d.unit)}</b><div style="height:5px;background:var(--bar);width:${Math.max(2, 100 * Math.abs(r.value) / maxv)}%;margin-left:auto;border-radius:2px"></div>` },
      { h: "Habitantes", num: 1, f: (r) => n0(r.population) }], d.rows);
    return `${sel}<section class="panel" style="padding:0">${tbl}</section><p class="small muted">${esc(d.source)}. ${esc(d.nota || "")} ${d.n} municípios com valor.</p>`;
  }

  async function leis(p) {
    const qs = new URLSearchParams({ limit: 250 });
    if (p.tema) qs.set("tema", p.tema);
    if (p.src) qs.set("src", p.src);
    if (p.q) qs.set("q", p.q);
    const d = await Portal.api("habitacao/leis?" + qs.toString());
    const byYear = {};
    for (const r of d.porAno) (byYear[r.y] ||= { parlamento: 0, dre: 0 })[r.src] = r.n;
    const years = Object.keys(byYear).sort();
    let h = `<div class="hb-filters"><select id="hb-tema"><option value="">Todos os temas</option>${d.temas.map((t) => `<option value="${esc(t.tema)}" ${p.tema === t.tema ? "selected" : ""}>${esc(t.tema)} (${t.n})</option>`).join("")}</select>
      <select id="hb-src"><option value="">Parlamento e Diário da República</option><option value="parlamento" ${p.src === "parlamento" ? "selected" : ""}>Iniciativas na AR</option><option value="dre" ${p.src === "dre" ? "selected" : ""}>Atos publicados (DRE)</option></select>
      <input type="search" id="hb-q" placeholder="Pesquisar no título…" value="${esc(p.q || "")}"><button class="btn" id="hb-go">Filtrar</button></div>`;
    h += `<section class="panel"><h3>Produção legislativa sobre habitação por ano</h3>${svgBars(years.map((y) => ({ x: y, v: byYear[y].parlamento + byYear[y].dre })), { cut: 2, label: "diplomas e iniciativas por ano" })}<p class="small muted">Iniciativas na AR (desde 2022) + atos do DRE. ${d.resultados.length ? "Resultados: " + d.resultados.map((x) => `${esc(x.resultado)} ${x.n}`).join(" · ") : ""}</p></section>`;
    h += `<div class="hb-tl">${d.rows.map((r) => {
      const vs = (r.votos || []).filter((v) => v.resultado).slice(-2);
      return `<div class="it"><small>${esc((r.date || "").slice(0, 10))} · ${esc(r.kind)} ${esc(r.number || "")} · <span class="tag">${esc(r.tema)}</span>${r.autoria ? " · " + esc(r.autoria) : ""}${r.estado ? " · " + esc(r.estado) : ""}</small><br>
        ${ext(r.source_url, r.title)}${r.resultado ? ` <span class="tag">${esc(r.resultado)}</span>` : ""}${r.lei_ref ? ` <small>→ ${esc(r.lei_ref)}</small>` : ""}${r.src === "parlamento" && r.dre_id ? ` <a class="small" href="#/dre/${esc(r.dre_id)}">DRE</a>` : ""}
        ${vs.length ? `<br><small class="muted">${vs.map((v) => `${esc((v.data || "").slice(0, 10))} ${esc(v.fase || "")}: ${esc(v.resultado)}${v.favor ? " · a favor " + esc(v.favor) : ""}${v.contra ? " · contra " + esc(v.contra) : ""}`).join(" | ")}</small>` : ""}</div>`;
    }).join("") || '<p class="note">Sem resultados.</p>'}</div><p class="small muted">${esc(d.nota)}</p>`;
    return h;
  }

  function fontes(ov) {
    return `<section class="panel"><h2>Fontes, períodos e lacunas</h2>${Portal.table([{ h: "Fonte", f: (f) => ext(f.url, f.name) }, { h: "Licença", f: (f) => esc(f.licence) }, { h: "Período", f: (f) => esc(f.period) }, { h: "Estado", f: (f) => `<span class="tag">${esc(f.status)}</span>` }, { h: "Notas", f: (f) => esc(f.note) }], ov.fontes)}</section>`;
  }

  async function concelhoPage(dico) {
    const d = await Portal.api("habitacao/concelho?dico=" + encodeURIComponent(dico));
    if (!d.found) { $app.innerHTML = `<p class="note warn">Município não encontrado.</p>`; return; }
    const m = d.municipio;
    $app.innerHTML = `${css}<h1>Habitação · ${esc(m.name)}</h1><p class="muted"><a href="#/habitacao">← Habitação em Portugal</a>${m.eid ? ` · <a href="#/entidade/${m.eid}">Perfil da câmara</a>` : ""} · ${esc(m.district || "")} · ${n0(m.population)} habitantes (${esc(m.population_year || "")})</p>${concelhoHtml(d, false)}`;
  }

  Portal.page("habitacao", async (arg, p) => {
    if (arg && /^\d{4}$/.test(arg)) return concelhoPage(arg);
    const tab = (p && p.tab) || "resumo";
    $app.innerHTML = `${css}<h1>Habitação</h1><p class="muted">Alojamento local, preços e rendas, licenciamento, parque habitacional, PRR, contratação e legislação — por município. Todos os valores citam a fonte e o período; onde não há dados abertos, a página diz-o.</p>${nav(tab)}<div id="hb-body"><p class="muted">A carregar…</p></div>`;
    const body = document.getElementById("hb-body");
    const ov = await Portal.api("habitacao/overview").catch(() => null);
    if (!ov || !ov.available) { body.innerHTML = `<p class="note warn">${esc((ov && ov.note) || "Dados de habitação indisponíveis.")}</p>`; return; }
    const go = (o) => { location.hash = "#/habitacao?" + new URLSearchParams({ tab, ...o }).toString(); };
    try {
      if (tab === "resumo") body.innerHTML = await resumo(ov);
      else if (tab === "fontes") body.innerHTML = fontes(ov);
      else if (tab === "ranking") {
        body.innerHTML = await ranking(p);
        const cur = () => ({ ind: document.getElementById("hb-ind").value, per: (document.getElementById("hb-per") || {}).value || "", ord: document.getElementById("hb-ord").value, all: document.getElementById("hb-all").checked ? "1" : "" });
        document.getElementById("hb-ind").onchange = () => go({ ...cur(), per: "" });
        for (const id of ["hb-per", "hb-ord", "hb-all"]) { const e = document.getElementById(id); if (e) e.onchange = () => go(cur()); }
      } else if (tab === "leis") {
        body.innerHTML = await leis(p);
        const f = () => go({ tema: document.getElementById("hb-tema").value, src: document.getElementById("hb-src").value, q: document.getElementById("hb-q").value });
        document.getElementById("hb-go").onclick = f;
        document.getElementById("hb-tema").onchange = f;
        document.getElementById("hb-src").onchange = f;
      }
    } catch (e) { body.innerHTML = `<p class="note warn">Erro ao carregar: ${esc(String(e.message || e))}</p>`; }
  });
})();
