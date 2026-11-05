"use strict";
/* Módulo "seguranca": #/seguranca — segurança interna, proteção civil e defesa.
   API: /api/seguranca/*. Dados: INE (crimes, incêndios rurais, sinistralidade, bombeiros; fontes DGPJ/SGSI, ICNF, ANSR, ANEPC),
   lista de órgãos, corporações de bombeiros do registo do portal e contratação pública (Portal BASE). */
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const num = (v, unit) => (v == null ? "—" : unit === "%" || unit === "‰" ? nf.format(v) + (unit === "%" ? " %" : " ‰") : Portal.int(Math.round(v)));
  const sh = (a, b) => (b ? Math.round(100 * a / b) + "%" : "—");
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const GRP = { forca_seguranca: "Força de segurança", investigacao: "Investigação criminal", imigracao: "Migrações e fronteiras", protecao_civil: "Proteção civil", emergencia: "Emergência", forca_armada: "Forças Armadas", defesa: "Defesa (serviços)", fiscalizacao: "Fiscalização", inspecao: "Inspeção", coordenacao: "Coordenação", outro: "Outro" };
  const css = `<style>.sg-svg{width:100%;height:auto;max-height:230px}.sg-svg text{fill:var(--muted);font:11px system-ui}.sg-svg .ln{fill:none;stroke:var(--bar);stroke-width:2.2}.sg-svg .pt{fill:var(--bar)}.sg-svg .gr{stroke:var(--line2)}
  .sg-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}.sg-grid h3{margin:.2rem 0}.sg-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.sg-filters input[type=search]{flex:1;min-width:220px}
  .sg-bar{display:flex;align-items:center;gap:8px;margin:2px 0;font-size:.85rem}.sg-bar i{display:block;height:10px;background:var(--bar);border-radius:2px}.sg-bar span{min-width:0}.sg-lab{flex:0 0 46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>`;

  Portal.nav("Segurança", "#/seguranca");

  function lineChart(pts, unit, label) {
    if (!pts || pts.length < 1) return '<p class="note">Sem dados.</p>';
    const W = 520, H = 200, L = 52, R = 12, T = 12, B = 26;
    const ys = pts.map((p) => p.value), min = Math.min(0, ...ys), max = Math.max(...ys, 1);
    const X = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const grid = [0, 0.5, 1].map((f) => { const v = min + (max - min) * f; return `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(nf.format(Math.round(v * 10) / 10))}</text>`; }).join("");
    const step = Math.ceil(pts.length / 8);
    const xl = pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${p.year}</text>` : "")).join("");
    const path = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) => `<circle class="pt" cx="${X(i)}" cy="${Y(p.value)}" r="3"><title>${p.year}: ${esc(num(p.value, unit))}${p.flag ? " (" + esc(p.flag) + ")" : ""}</title></circle>`).join("");
    return `<svg class="sg-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xl}<path class="ln" d="${path}"/>${dots}</svg>`;
  }
  const chartPanel = (s, extra) => `<section class="panel"><h3>${esc(s.label)}${s.unit ? ` <small class="muted">(${esc(s.unit)})</small>` : ""}</h3>${lineChart(s.points, s.unit, s.label)}
    <p class="small muted">${s.points.length ? `${s.points[0].year}–${s.points[s.points.length - 1].year}` : ""} · ${esc(s.source || s.src || "")}${extra || ""}</p></section>`;
  const kpiOf = (s, label) => {
    const p = s && s.points && s.points[s.points.length - 1], q = s && s.points && s.points[s.points.length - 2];
    if (!p) return "";
    return `<div class="kpi"><b>${num(p.value, s.unit)}</b><span>${esc(label || s.label)} (${p.year})${q && q.value ? ` · ${p.value >= q.value ? "+" : ""}${nf.format(100 * (p.value / q.value - 1))}% vs ${q.year}` : ""}</span></div>`;
  };
  const supp = (rows) => Portal.table([
    { h: "Fornecedor", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name || r.nif)}</a>` : esc(r.name || r.nif || "—")) },
    { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) },
    { h: "% ajuste direto (n.º)", num: 1, f: (r) => sh(r.direct_n, r.n) }], rows || []);
  const cpvTable = (rows) => `<div class="tblwrap"><table class="tbl"><thead><tr><th>Divisão CPV</th><th class="num">Contratos</th><th class="num">Valor</th><th class="num">% direto (valor)</th></tr></thead><tbody>${(rows || []).map((r) => `<tr><td>${esc(r.div)} · ${esc(r.label)}</td><td class="num">${Portal.int(r.n)}</td><td class="num">${Portal.eur(r.value)}</td><td class="num">${sh(r.direct_value, r.value)}</td></tr>`).join("")}</tbody></table></div>`;
  const procBlock = (k, pr) => {
    if (!pr || !pr.n) return `<section class="panel"><h3>${esc(pr && pr.label || k)}</h3><p class="small muted">Sem contratos associados.</p></section>`;
    return `<section class="panel"><h3>${esc(pr.label)}</h3>
      <div class="kpis"><div class="kpi"><b>${Portal.eur(pr.value)}</b><span>contratado (${Portal.int(pr.n)} contratos, ${Portal.int(pr.n_entities)} entidades)</span></div>
      <div class="kpi"><b>${sh(pr.direct_value, pr.value)}</b><span>do valor por ajuste direto · ${sh(pr.direct_n, pr.n)} dos contratos</span></div>
      ${pr.cpv35 && pr.cpv35.n ? `<div class="kpi"><b>${Portal.eur(pr.cpv35.value)}</b><span>CPV 35 (segurança, defesa, armamento) · ${sh(pr.cpv35.direct_value, pr.cpv35.value)} direto</span></div>` : ""}</div>
      ${pr.years && pr.years.length ? Portal.bars(pr.years) : ""}
      ${pr.cpv ? `<h4>Em que se gasta (divisão CPV)</h4>${cpvTable(pr.cpv)}` : ""}
      <h4>Maiores fornecedores</h4>${supp(pr.topSuppliers)}
      ${pr.defesa35 && pr.defesa35.length ? `<h4>Fornecedores de segurança e defesa (CPV 35)</h4>${supp(pr.defesa35)}` : ""}</section>`;
  };

  const bodyRows = (rows) => Portal.table([
    { h: "Organismo", f: (r) => `<b>${esc(r.sigla)}</b> · ${r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)}<br><small class="muted">${esc(r.description || "")}</small>` },
    { h: "Tipo", f: (r) => `<span class="tag">${esc(GRP[r.grp] || r.grp)}</span>${r.tutela_short ? ` <span class="tag">${esc(r.tutela_short)}</span>` : ""}` },
    { h: "Contratos", num: 1, f: (r) => (r.nif ? Portal.int(r.n) : "—") },
    { h: "Valor", num: 1, f: (r) => (r.nif ? Portal.eur(r.value) : "—") },
    { h: "% ajuste direto", num: 1, f: (r) => (r.value ? sh(r.direct_value, r.value) : "—") },
    { h: "Fonte", f: (r) => ext(r.website, "sítio oficial") }], rows);

  /* -------------------------------------------------------------- overview */
  async function pageOverview(p) {
    const [ov, org, bo, cz] = await Promise.all([
      Portal.api("seguranca/overview"),
      Portal.api("seguranca/orgaos" + Portal.qs({ q: p.q, grp: p.grp, outros: p.q ? 1 : "" })),
      Portal.api("seguranca/bombeiros" + Portal.qs({ q: p.bq, concelho: p.concelho, tipo: p.tipo, sem: p.sem, offset: p.off })),
      p.concelho ? Portal.api("seguranca/concelho?dico=" + encodeURIComponent(p.concelho)).catch(() => null) : null,
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Segurança</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const n = ov.national, c = ov.counts, pr = ov.procurement;
    const link = (o) => `#/seguranca${Portal.qs({ ...p, ...o })}`;
    const off = +p.off || 0, lim = 50;
    const sd = ov.security_entities.total;
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / Segurança</div>
      <div class="pagehead"><div><div class="kicker">Segurança interna, proteção civil e defesa</div><h1>Quem protege, quanto custa e o que acontece</h1>
        <p class="lead">Forças de segurança, Forças Armadas, proteção civil e bombeiros; estatísticas oficiais de criminalidade, incêndios rurais e sinistralidade rodoviária (INE, a partir da DGPJ/SGSI, ICNF e ANSR), por país e concelho; e a contratação pública destes organismos.</p></div></div>
      <div class="kpis">${kpiOf(n.crime, "crimes registados")}${kpiOf(n.crime_taxa, "taxa de criminalidade")}${kpiOf(n.homicidios, "homicídios voluntários consumados")}${kpiOf(n.incendios, "incêndios rurais")}${kpiOf(n.area_ardida, "superfície ardida (ha)")}${kpiOf(n.mortos, "mortos em acidentes de viação")}${kpiOf(n.bombeiros_pessoal, "bombeiros")}${kpiOf(n.bombeiros_corpos, "corpos de bombeiros")}
        ${sd && sd.n ? `<div class="kpi"><b>${Portal.eur(sd.value)}</b><span>contratado por ${Portal.int(ov.security_entities.n)} entidades de segurança e defesa (${sh(sd.direct_value, sd.value)} por ajuste direto)</span></div>` : ""}</div>

      ${cz && cz.found ? `<section class="panel" id="sec-concelho"><h2>Concelho: ${esc(cz.name)} <a class="small" href="${link({ concelho: "" })}">(limpar)</a></h2>${concelhoHtml(cz, false)}</section>` : ""}
      <h2>Tendências nacionais</h2>
      <div class="sg-grid">${["crime", "crime_taxa", "homicidios", "incendios", "area_ardida", "acidentes", "mortos", "feridos_graves"].filter((k) => n[k] && n[k].points.length).map((k) => chartPanel(n[k])).join("")}</div>
      ${(() => { const g = (ov.crimeGap || []).filter((r) => r.gap_conc != null); if (!g.length) return ""; const lo = Math.min(...g.map((r) => r.pct_conc)), hi = Math.max(...g.map((r) => r.pct_conc)); const l = g[g.length - 1];
        return `<div class="note warn"><b>Os totais nacionais são superiores à soma dos concelhos.</b> A soma dos concelhos fica ${nf.format(lo)}–${nf.format(hi)}% abaixo do total nacional (${l.year}: ${Portal.int(l.total)} no total, ${Portal.int(l.concelhos)} nos concelhos, diferença de ${Portal.int(l.gap_conc)} crimes). A diferença decompõe-se em duas partes: (1) o total nacional excede a soma de Continente + Açores + Madeira (${l.year}: ${Portal.int(l.gap_areas)}), isto é, crimes sem região atribuída; (2) a soma das regiões excede a dos concelhos (${l.year}: ${Portal.int(l.areas - l.concelhos)}), isto é, crimes sem concelho atribuído. <b>A causa exata não consta da metainformação do INE</b> (indicadores 0012261 e 0008073, fonte DGPJ); é provável que sejam crimes sem localização territorial registada ou de competência nacional, mas isso não está confirmado. Os valores por concelho devem ser lidos como mínimos.
        <details><summary>Diferença por ano</summary>${Portal.table([{ h: "Ano", f: (r) => r.year }, { h: "Total nacional", num: 1, f: (r) => Portal.int(r.total) }, { h: "Soma dos concelhos", num: 1, f: (r) => Portal.int(r.concelhos) }, { h: "Diferença", num: 1, f: (r) => Portal.int(r.gap_conc) }, { h: "%", num: 1, f: (r) => nf.format(r.pct_conc) + "%" }, { h: "Sem região", num: 1, f: (r) => Portal.int(r.gap_areas) }], g)}</details></div>`; })()}
      <p class="note">Fontes: INE (indicadores publicados no dados.gov.pt, licença CC-BY) com dados da DGPJ/SGSI (crime), ICNF (incêndios rurais) e ANSR (sinistralidade). A série de criminalidade por categoria e concelho na base atual começa em 2021 (anos anteriores só na versão NUTS 2013, quando existe). Anos mais recentes podem ser provisórios. <b>Não incluído:</b> o Relatório Anual de Segurança Interna (RASI) — só é publicado em PDF e os sítios do SGSI/ANEPC não ofereceram dados abertos descarregáveis; os dados da ANEPC (<code>prociv.pt</code>) estavam inacessíveis aos testes automáticos (sem resposta) e o <code>fogos.pt</code> só expõe ocorrências em tempo real, sem histórico aberto verificado. Por isso não há aqui ocorrências de socorro nem a lista oficial ANEPC de corporações.</p>

      <h2>Contratação pública (Portal BASE, 2012 → hoje)</h2>
      <div class="cols">${procBlock("defesa", pr.defesa)}${procBlock("seguranca", pr.seguranca)}</div>
      <div class="cols">${procBlock("protecao_civil", pr.protecao_civil)}${procBlock("bombeiros", pr.bombeiros)}</div>
      ${ov.ministries && ov.ministries.length ? `<section class="panel"><h2>Ministérios da tutela</h2>${ov.ministries.map((m) => { const t = (m.years || []).reduce((a, y) => ({ n: a.n + y.n, v: a.v + y.value, d: a.d + y.direct_value }), { n: 0, v: 0, d: 0 }); return `<p><a href="#/ministerios/${esc(m.slug)}"><b>${esc(m.name || m.slug)}</b></a> — ${Portal.eur(t.v)} em ${Portal.int(t.n)} contratos (${sh(t.d, t.v)} por ajuste direto)</p>`; }).join("")}<p class="small muted">Valores de todo o ministério (módulo Ministérios), não só dos organismos listados nesta página.</p></section>` : ""}

      <h2 id="sec-orgaos">Organismos</h2>
      <div class="sg-filters"><input type="search" id="sg-q" placeholder="Procurar organismo ou entidade de segurança e defesa…" value="${esc(p.q || "")}">
        <select id="sg-grp"><option value="">Todos os tipos</option>${(org.groups || []).map((g) => `<option value="${esc(g.grp)}" ${p.grp === g.grp ? "selected" : ""}>${esc(GRP[g.grp] || g.grp)} (${g.n})</option>`).join("")}</select></div>
      ${bodyRows(org.rows)}
      ${org.others && org.others.length ? `<h3>Outras entidades de segurança e defesa no registo</h3>${Portal.table([{ h: "Entidade", f: (r) => `<a href="#/entidade/${r.id}">${esc(r.name)}</a>` }, { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }], org.others)}` : ""}
      <p class="small muted">Lista curada dos principais organismos; as compras de ramos (Exército, Marinha, Força Aérea) constam dos respetivos Estados-Maiores e as da Polícia Marítima e da Autoridade Marítima Nacional da Marinha. O INEM não aparece no registo de entidades contratantes com este nome, pelo que não tem contratos associados.</p>

      <h2 id="sec-bombeiros">Corporações de bombeiros</h2>
      <p>${Portal.int(c.bombeiros)} entidades com “bombeiros” no nome no registo do portal (${Portal.int(c.bombeiros_assoc)} associações humanitárias), das quais ${Portal.int(c.bombeiros_concelho)} foram localizadas num concelho de forma inequívoca. ${bo.coverage.ine_corpos_pt ? `O INE regista ${Portal.int(bo.coverage.ine_corpos_pt.value)} corpos de bombeiros em ${bo.coverage.ine_corpos_pt.year}.` : ""}
        <b>Não é a lista oficial da ANEPC</b>: só aparecem corporações que celebraram contratos públicos registados no Portal BASE; as restantes não existem no registo.</p>
      <div class="sg-filters"><input type="search" id="sg-bq" placeholder="Procurar corporação ou concelho…" value="${esc(p.bq || "")}">
        <select id="sg-tipo"><option value="">Todos os tipos</option>${[["associacao", "Associações"], ["municipal", "Municipais / sapadores"], ["federacao", "Federações"], ["outro", "Outros"]].map((t) => `<option value="${t[0]}" ${p.tipo === t[0] ? "selected" : ""}>${t[1]}</option>`).join("")}</select>
        <label class="small"><input type="checkbox" id="sg-sem" ${p.sem === "1" ? "checked" : ""}> sem concelho identificado</label></div>
      ${Portal.int(bo.total)} resultado(s)
      ${Portal.table([
        { h: "Corporação", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)) },
        { h: "Concelho", f: (r) => (r.concelho ? `<a href="#/seguranca${Portal.qs({ concelho: r.dico })}#sec-bombeiros">${esc(r.concelho)}</a> <small class="muted">(${esc(r.match_method)})</small>` : '<span class="muted">—</span>') },
        { h: "Tipo", f: (r) => esc(r.tipo) }, { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "% direto", num: 1, f: (r) => (r.value ? sh(r.direct_value, r.value) : "—") }], bo.rows)}
      <div class="pager">${off > 0 ? `<a class="btn" href="${link({ off: Math.max(0, off - lim) })}">← Anteriores</a>` : ""} ${off + lim < bo.total ? `<a class="btn" href="${link({ off: off + lim })}">Seguintes →</a>` : ""}</div>
      ${bo.byConcelho ? `<h3>Corporações por concelho (registo do portal vs. INE)</h3><div class="tblwrap" style="max-height:340px;overflow:auto">${Portal.table([{ h: "Concelho", f: (r) => `<a href="#/seguranca${Portal.qs({ concelho: r.dico })}#sec-bombeiros">${esc(r.concelho)}</a>` }, { h: "No registo do portal", num: 1, f: (r) => r.n }, { h: "Corpos (INE)", num: 1, f: (r) => (r.ine_corpos == null ? "—" : Portal.int(r.ine_corpos)) }], bo.byConcelho)}</div>` : ""}
      <p class="small muted">Fontes: ${ext("https://www.ine.pt/", "INE")} · Portal BASE (registo de entidades) · cobertura: ${esc(ov.meta.built || "")}.</p>`;
    const go = (o) => Portal.go ? Portal.go(`#/seguranca${Portal.qs({ ...p, off: "", ...o })}`) : (location.hash = `#/seguranca${Portal.qs({ ...p, off: "", ...o })}`);
    const deb = (el, fn) => { let t; el.addEventListener("input", () => { clearTimeout(t); t = setTimeout(fn, 450); }); };
    deb($("#sg-q"), () => go({ q: $("#sg-q").value }));
    $("#sg-grp").onchange = () => go({ grp: $("#sg-grp").value });
    deb($("#sg-bq"), () => go({ bq: $("#sg-bq").value }));
    $("#sg-tipo").onchange = () => go({ tipo: $("#sg-tipo").value });
    $("#sg-sem").onchange = () => go({ sem: $("#sg-sem").checked ? "1" : "" });
  }

  /* -------------------------------------------------------------- concelho panel (also used by the entity hook) */
  function concelhoHtml(d, withLink) {
    const s = d.series || {}, r = d.ranks || {};
    const rk = (k, lab) => (r[k] ? `<span class="tag">${esc(lab)}: ${r[k].pos}.º de ${r[k].of} (${r[k].year})</span> ` : "");
    const cats = d.categorias && d.categorias.rows.length ? `<h4>Crimes registados por categoria (${d.categorias.year})</h4>${d.categorias.rows.map((x) => { const mx = d.categorias.rows[0].value || 1; return `<div class="sg-bar"><span class="sg-lab" title="${esc(x.dim)}">${esc(x.dim)}</span><i style="width:${Math.max(1, 40 * x.value / mx)}%"></i><span>${Portal.int(x.value)}</span></div>`; }).join("")}` : "";
    return `${css}<div class="kpis">${kpiOf(s.crime, "crimes registados")}${kpiOf(s.crime_taxa, "taxa de criminalidade")}${kpiOf(s.incendios, "incêndios rurais")}${kpiOf(s.area_ardida, "superfície ardida (ha)")}${kpiOf(s.acidentes, "acidentes com vítimas")}${kpiOf(s.mortos, "mortos em acidentes")}${kpiOf(s.bombeiros_corpos, "corpos de bombeiros (INE)")}${kpiOf(s.bombeiros_pessoal, "bombeiros (INE)")}</div>
      <p>${rk("crime_taxa", "Taxa de criminalidade")}${rk("area_ardida", "Superfície ardida")}${rk("incendios", "Incêndios rurais")}</p>
      <div class="sg-grid">${["crime", "incendios", "area_ardida", "acidentes", "mortos"].filter((k) => s[k]).map((k) => chartPanel(s[k])).join("")}</div>
      ${cats}
      ${d.bombeiros && d.bombeiros.length ? `<h4>Corporações de bombeiros identificadas neste concelho (registo do portal)</h4>${Portal.table([{ h: "Corporação", f: (b) => (b.eid ? `<a href="#/entidade/${b.eid}">${esc(b.name)}</a>` : esc(b.name)) }, { h: "Contratos", num: 1, f: (b) => Portal.int(b.n) }, { h: "Valor", num: 1, f: (b) => Portal.eur(b.value) }], d.bombeiros)}` : '<p class="small muted">Nenhuma corporação do registo do portal foi localizada neste concelho pelo nome (não significa que não exista).</p>'}
      <p class="small muted">${esc(d.note || "")} ${withLink ? `<a href="#/seguranca">Visão nacional →</a>` : ""}</p>`;
  }

  Portal.page("seguranca", async (arg, p) => {
    try {
      p = p || {};
      return await pageOverview(p);
    } catch (e) {
      $app.innerHTML = `<div class="pagehead"><div><h1>Segurança</h1></div></div><p class="note warn">Não foi possível carregar os dados (${esc(String(e.message || e))}).</p>`;
    }
  });

  /* -------------------------------------------------------------- entity hook */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || e.kind !== "municipio") return;
    const d = await Portal.api("seguranca/concelho?" + (e.dico ? "dico=" + encodeURIComponent(e.dico) : "nif=" + encodeURIComponent(e.nif || ""))).catch(() => null);
    if (!d || !d.found) return;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Segurança e proteção civil</h2>${concelhoHtml(d, true)}</section>`);
  });
})();
