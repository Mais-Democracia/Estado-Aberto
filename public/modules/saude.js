"use strict";
/* Módulo "saude": #/saude (visão geral SNS) e #/saude/inst/<id> (instituição).
   API: /api/saude/*  — dados: sns.gov.pt (entidades), INE (inquérito aos hospitais), catálogo dados.gov.pt do Portal da Transparência do SNS,
   contratação pública (politica.db). Os indicadores por instituição do Portal da Transparência NÃO são descarregados (robots.txt). */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const fmt = (v, unit) => (v == null ? "—" : (unit && unit.includes("%") ? nf.format(v) + " %" : Portal.int(Math.round(v))));
  const sh = (a, b) => (b ? Math.round(100 * a / b) + "%" : "—");
  const css = `<style>.sa-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.sa-filters input[type=search]{flex:1;min-width:220px}
  .sa-svg{width:100%;height:auto;max-height:260px}.sa-svg text{fill:var(--muted);font:11px system-ui}.sa-svg .ln{fill:none;stroke:var(--bar);stroke-width:2.2}.sa-svg .pt{fill:var(--bar)}.sa-svg .gr{stroke:var(--line2)}
  .sa-units{columns:2 280px;margin:0;padding-left:1.1rem}.sa-units li{break-inside:avoid;margin-bottom:2px}.sa-cat{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
  .sa-cat .tag{margin-right:4px}.sa-sec a.btn{margin-right:6px}</style>`;
  const sel = (id, opts, cur, all) => `<select id="${id}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;

  Portal.nav("Saúde", "#/saude");

  /* ---- inline SVG line/point chart: pts = [{x:'2019', y:123}] */
  function lineChart(pts, unit, label) {
    if (!pts.length) return '<p class="note">Sem dados para esta seleção.</p>';
    const W = 640, H = 230, L = 58, R = 14, T = 14, B = 28;
    const ys = pts.map((p) => p.y), min = Math.min(0, ...ys), max = Math.max(...ys, 1);
    const X = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + (max - min) * f; return `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(unit && unit.includes("%") ? nf.format(v) : nf.format(Math.round(v)))}</text>`; }).join("");
    const step = Math.ceil(pts.length / 9);
    const xl = pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>` : "")).join("");
    const path = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) => `<circle class="pt" cx="${X(i)}" cy="${Y(p.y)}" r="3.2"><title>${esc(p.x)}: ${esc(fmt(p.y, unit))}</title></circle>`).join("");
    return `<svg class="sa-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xl}<path class="ln" d="${path}"/>${dots}</svg>`;
  }

  const procPanel = (pr, opts = {}) => {
    if (!pr || !pr.n) return '<p class="small muted">Sem contratos públicos (Portal BASE) associados.</p>';
    const c = pr.categories || {};
    const catRow = (k) => c[k] && c[k].n ? `<tr><td>${esc(c[k].label)}</td><td class="num">${Portal.int(c[k].n)}</td><td class="num">${Portal.eur(c[k].value)}</td><td class="num">${sh(c[k].direct_value, c[k].value)}</td></tr>` : "";
    const supp = (rows) => Portal.table([
      { h: "Fornecedor", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name || r.nif)}</a>` : esc(r.name || r.nif || "—")) },
      { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) },
      { h: "% ajuste direto (n.º)", num: 1, f: (r) => sh(r.direct_n, r.n) }], rows || []);
    return `<div class="kpis"><div class="kpi"><b>${Portal.eur(pr.value)}</b><span>contratado (2012–hoje)</span></div><div class="kpi"><b>${Portal.int(pr.n)}</b><span>contratos</span></div>
      <div class="kpi"><b>${sh(pr.direct_value, pr.value)}</b><span>do valor por ajuste direto</span></div><div class="kpi"><b>${sh(pr.direct_n, pr.n)}</b><span>dos contratos por ajuste direto</span></div></div>
      ${pr.years && pr.years.length ? Portal.bars(pr.years) : ""}
      <h3>Por tipo de bem/serviço (CPV)</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>Categoria</th><th class="num">Contratos</th><th class="num">Valor</th><th class="num">% direto (valor)</th></tr></thead><tbody>${catRow("pharma_equipment")}${catRow("health_services")}</tbody></table></div>
      <div class="cols"><div><h3>Maiores fornecedores</h3>${supp(pr.topSuppliers)}</div>
      <div><h3>Medicamentos e equipamento médico (CPV 33)</h3>${supp(pr.topSuppliers33)}</div></div>
      ${opts.showServices ? `<h3>Serviços de saúde (CPV 85)</h3>${supp(pr.topSuppliers85)}` : ""}
      ${pr.recent && pr.recent.length ? `<h3>Contratos recentes</h3>${Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.signed) }, { h: "Objeto", f: (r) => `<a href="#/contrato/${esc(r.id)}">${esc((r.object || "").slice(0, 110))}</a>` }, { h: "Fornecedor", f: (r) => `<span class="small">${esc(r.seller_name || "")}</span>` }, { h: "Preço", num: 1, f: (r) => Portal.eurFull(r.price) }], pr.recent)}` : ""}`;
  };

  const blockedNote = (tr) => `<p class="note warn"><b>Indicadores de desempenho por instituição (tempos de espera, LIC, urgências, utentes sem médico de família) — indisponíveis aqui.</b>
    Estes dados existem no <a href="https://transparencia.sns.gov.pt/" target="_blank" rel="noopener">Portal da Transparência do SNS</a> (dados abertos, também listados no dados.gov.pt), mas esse portal é o único
    anfitrião dos ficheiros e o seu <code>robots.txt</code> proíbe a robôs o acesso à API (<code>/api/</code>) e às descargas (<code>/explore/dataset/*/download</code>)${tr && tr.checked ? ` (verificado em ${esc(tr.checked)})` : ""}.
    Em vez de contornar essa regra, listamos abaixo o catálogo de indicadores com ligação direta ao portal oficial. Nada foi inventado nem estimado.</p>`;

  /* ------------------------------------------------------------------ overview */
  async function pageOverview(p) {
    const link = (o) => `#/saude${Portal.qs({ ...p, ...o })}`;
    const [ov, li, cat] = await Promise.all([
      Portal.api("saude/overview"),
      Portal.api("saude/instituicoes" + Portal.qs({ q: p.q, regiao: p.regiao, kind: p.kind, page: p.page })),
      Portal.api("saude/catalogo" + Portal.qs({ topic: p.topic })),
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Saúde</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const c = ov.counts, n = ov.national || {}, ms = ov.matchStats || {}, pr = ov.procurement;
    const kpi = (o, label, unit) => (o ? `<div class="kpi"><b>${fmt(o.value, unit)}</b><span>${esc(label)} (${esc(o.period)})${o.prev && o.prev.value ? ` · ${o.value >= o.prev.value ? "+" : ""}${nf.format(100 * (o.value / o.prev.value - 1))}% vs ${esc(o.prev.period)}` : ""}</span></div>` : "");
    const ind = ov.ineIndicators || [];
    const defInd = p.ind || "0008103";
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / Saúde</div>
      <div class="pagehead"><div><div class="kicker">Serviço Nacional de Saúde</div><h1>Hospitais, ULS e organismos do SNS</h1>
        <p class="lead">Rede de unidades locais de saúde (reforma de 2024), hospitais, ARS e organismos centrais; atividade hospitalar agregada (INE); catálogo dos indicadores do Portal da Transparência; e a contratação pública de cada instituição.</p></div></div>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(c.institutions)}</b><span>instituições e organismos do SNS</span></div>
        <div class="kpi"><b>${Portal.int(c.uls)}</b><span>unidades locais de saúde (ULS)</span></div>
        <div class="kpi"><b>${Portal.int(c.hospitals_in_uls)}</b><span>hospitais identificados nas páginas oficiais (pode estar incompleto)</span></div>
        <div class="kpi"><b>${Portal.int(c.aces)}</b><span>ACeS · ${Portal.int(c.centros_saude)} centros de saúde listados</span></div>
        ${kpi(n.admissions, "internamentos nos hospitais", "N.º")}${kpi(n.emergency, "atendimentos em urgência", "N.º")}${kpi(n.consultations, "consultas externas hospitalares", "N.º")}${kpi(n.beds, "camas (hosp. públicos+PPP)", "N.º")}
        ${pr && pr.n ? `<div class="kpi"><b>${Portal.eur(pr.value)}</b><span>contratado pelas instituições (BASE, 2012–hoje)</span></div>` : ""}</div>
      ${blockedNote(ov.transparencia)}
      <p class="note">Ligação ao registo de entidades (NIF): ${Portal.int(c.matched)} de ${Portal.int(c.institutions)} instituições (${Math.round(100 * c.matched / (c.institutions || 1))}%), por nome normalizado inequívoco; ${ms.uls_matched != null ? `${Portal.int(ms.uls_matched)} de ${Portal.int(ms.uls)} ULS. ` : ""}${ms.ambiguous && ms.ambiguous.length ? `Ambíguas (não ligadas): ${ms.ambiguous.map(esc).join("; ")}. ` : ""}${ms.unmatched && ms.unmatched.length ? `Sem correspondência: ${ms.unmatched.map(esc).join("; ")}.` : ""}
        Região = ARS da sede, derivada do código postal (aproximação).</p>

      <section class="panel" id="sec-inst"><h2>Instituições</h2>
        <div class="sa-filters"><input type="search" id="sq" placeholder="Nome, localidade ou unidade (ex.: Santa Maria, Faro, centro de saúde)" value="${esc(p.q || "")}">
          ${sel("sr", (li.facets.regions || []).map((r) => [r, r]), p.regiao, "Todas as regiões")}
          ${sel("sk", (li.facets.kinds || []).map((k) => [k.kind, `${li.kindLabels[k.kind] || k.kind} (${k.n})`]), p.kind, "Todos os tipos")}</div>
        ${Portal.table([
          { h: "Instituição", f: (r) => `<a href="#/saude/inst/${encodeURIComponent(r.id)}"><b>${esc(r.name)}</b></a><div class="small muted">${esc(li.kindLabels[r.kind] || r.kind)}</div>` },
          { h: "Região", f: (r) => esc(r.region || "—") },
          { h: "Composição", f: (r) => (r.n_hospitals || r.n_aces || r.n_cs ? `<span class="small">${r.n_hospitals ? r.n_hospitals + " hosp. " : "hosp. n/d "}${r.n_aces ? r.n_aces + " ACeS " : ""}${r.n_cs ? r.n_cs + " CS" : ""}</span>` : ["uls", "ipo", "hospital"].includes(r.kind) ? '<span class="small muted">composição não disponível</span>' : "—") },
          { h: "Contratos BASE", num: 1, f: (r) => (r.contracts ? Portal.int(r.contracts.n) : "—") },
          { h: "Valor contratado", num: 1, f: (r) => (r.contracts ? Portal.eur(r.contracts.value) : "—") },
          { h: "% direto", num: 1, f: (r) => (r.contracts && r.contracts.direct_share != null ? Math.round(100 * r.contracts.direct_share) + "%" : "—") },
          { h: "", f: (r) => (r.website ? ext(r.website, "sítio") : "") },
        ], li.rows)}
        ${Portal.pager(li.total, li.page || 1, li.limit || 40, (k) => link({ page: k }))}
      </section>

      <section class="panel" id="sec-ine"><h2>Atividade hospitalar e cuidados primários (INE, agregados)</h2>
        <p class="small muted">Inquérito aos hospitais do INE: valores nacionais e regionais — o INE não os publica por instituição. As séries antigas (NUTS 2001/2013) e as novas (hospitais públicos de acesso universal e PPP, NUTS 2024) são indicadores distintos.</p>
        <div class="sa-filters">${sel("si", ind.map((i) => [i.indicator, `${i.name} · ${i.first}–${i.last}`]), defInd, "Indicador").replace('<option value="">Indicador</option>', "")}<select id="sg"></select><select id="sd" style="display:none"></select></div>
        <div id="sa-chart"><p class="small muted">A carregar…</p></div></section>

      <section class="panel" id="sec-proc"><h2>Contratação pública das instituições do SNS</h2>
        <p class="small muted">Contratos do Portal BASE/IMPIC em que as ${Portal.int(c.matched)} instituições ligadas são entidade adjudicante (inclui SPMS, INFARMED, INEM, ACSS, DE-SNS quando ligados). Ajuste direto = procedimento com "direto" no nome.</p>
        ${procPanel(pr)}
        ${ov.topInstitutions && ov.topInstitutions.length ? `<h3>Instituições que mais contratam</h3>${Portal.table([
          { h: "Instituição", f: (r) => (r.id ? `<a href="#/saude/inst/${encodeURIComponent(r.id)}">${esc(r.name)}</a>` : esc(r.nif)) },
          { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "% direto", num: 1, f: (r) => sh(r.direct_value, r.value) }], ov.topInstitutions)}` : ""}
      </section>

      <section class="panel" id="sec-cat"><h2>Indicadores do Portal da Transparência do SNS (catálogo)</h2>
        <p class="small muted">${Portal.int(c.catalog)} conjuntos de dados publicados no dados.gov.pt. Mostramos título, publicador, frequência e ligação oficial; os valores não foram descarregados (ver aviso acima).</p>
        <div class="sa-filters">${sel("st", (ov.catalogTopics || []).map((t) => [t.topic, `${t.topic} (${t.n})`]), p.topic, "Todos os temas")}</div>
        ${Portal.table([
          { h: "Indicador", f: (r) => `${esc(r.title)}<div class="small muted">${esc(r.publisher || "")}</div>` },
          { h: "Tema", f: (r) => `<span class="tag">${esc(r.topic)}</span>` },
          { h: "Frequência", f: (r) => esc({ monthly: "mensal", annual: "anual", daily: "diária", quarterly: "trimestral", weekly: "semanal", unknown: "n/d", irregular: "irregular", semiannual: "semestral" }[r.frequency] || r.frequency || "n/d") },
          { h: "Atualizado", f: (r) => esc(r.last_update || "") },
          { h: "Fonte oficial", f: (r) => `${ext(r.portal_url, "Portal SNS")} · ${ext(r.dados_url, "dados.gov.pt")}` },
        ], cat.rows || [])}</section>

      <p class="small muted">Fontes: ${ext("https://www.sns.gov.pt/institucional/entidades-de-saude/", "sns.gov.pt — Entidades de Saúde")}, ${ext("https://www.ine.pt/", "INE")}, ${ext("https://dados.gov.pt/", "dados.gov.pt")}, Portal BASE (contratos). Atualizado em ${esc(ov.builtAt || "—")}.</p>`;

    const rerender = (o) => { location.hash = link({ ...o, page: 1 }); };
    const t0 = $("#sq"); if (t0) t0.onkeydown = (e) => { if (e.key === "Enter") rerender({ q: e.target.value }); };
    for (const [id, key] of [["sr", "regiao"], ["sk", "kind"], ["st", "topic"]]) { const el = $("#" + id); if (el) el.onchange = (e) => rerender({ [key]: e.target.value }); }
    await drawSeries(defInd, p.geo || "PT");
    const si = $("#si"); if (si) si.onchange = (e) => drawSeries(e.target.value, "PT");
    const sg = $("#sg"); if (sg) sg.onchange = (e) => drawSeries($("#si").value, e.target.value);
    const sd = $("#sd"); if (sd) sd.onchange = (e) => drawSeries($("#si").value, $("#sg").value, e.target.value);
  }

  async function drawSeries(ind, geo, dimSel) {
    const box = $("#sa-chart"); if (!box) return;
    const d = await Portal.api("saude/series" + Portal.qs({ indicator: ind, geo })).catch(() => null);
    if (!d || !d.rows) { box.innerHTML = '<p class="note warn">Série indisponível.</p>'; return; }
    const sg = $("#sg");
    if (sg) sg.innerHTML = (d.geos || []).map((g) => `<option value="${esc(g.geo_code)}" ${g.geo_code === d.geo ? "selected" : ""}>${esc(g.geo_name)}</option>`).join("");
    const dims = d.dims || [];
    const dim = dimSel && dims.includes(dimSel) ? dimSel : dims.find((x) => /^Total/.test(x)) || dims[0] || "";
    const sd = $("#sd");
    if (sd) { sd.style.display = dims.length > 1 ? "" : "none"; sd.innerHTML = dims.map((x) => `<option ${x === dim ? "selected" : ""}>${esc(x)}</option>`).join(""); }
    const pts = d.rows.filter((r) => r.dim === dim).map((r) => ({ x: r.period, y: r.value }));
    const geoName = ((d.geos || []).find((g) => g.geo_code === d.geo) || {}).geo_name || d.geo;
    box.innerHTML = `<h3 style="margin:.2rem 0">${esc(d.name || "")}</h3><div class="small muted">${esc(geoName)}${dim && !/^Total/.test(dim) ? " · " + esc(dim) : ""}</div>
      ${lineChart(pts, d.unit, d.name || "")}
      <p class="small muted">${esc(d.scope || "")} ${ext(d.source_url, "Metainformação INE")}${pts.length ? ` · último ano: ${esc(pts[pts.length - 1].x)}` : ""}</p>`;
  }

  /* ------------------------------------------------------------------ institution */
  async function pageInst(id) {
    const d = await Portal.api("saude/instituicao?id=" + encodeURIComponent(id));
    if (!d || !d.institution) { $app.innerHTML = `${css}<div class="crumbs"><a href="#/">Início</a> / <a href="#/saude">Saúde</a></div><p class="note warn">Instituição não encontrada.</p>`; return; }
    const i = d.institution, units = d.units || [];
    const hosp = units.filter((u) => u.kind === "hospital"), other = units.filter((u) => u.kind === "outra" && !u.parent);
    const acesNames = [...new Set(units.filter((u) => u.kind === "aces" || (u.kind === "centro_saude" && u.parent)).map((u) => u.kind === "aces" ? u.name : u.parent))];
    const csBy = (a) => units.filter((u) => u.kind === "centro_saude" && u.parent === a);
    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/saude">Saúde</a> / ${esc(i.name)}</div>
      <div class="pagehead"><div><div class="kicker">${esc(i.kindLabel)}${i.region ? " · " + esc(i.region) : ""}</div><h1>${esc(i.name)}</h1>
        <div class="small muted">${i.nif ? `NIF ${esc(i.nif)} · ` : ""}${i.address ? esc(i.address) + " · " : ""}${i.phone ? "tel. " + esc(i.phone) + " · " : ""}${i.website ? ext(i.website, "sítio oficial") + " · " : ""}${ext(i.source_url, "página no sns.gov.pt")}${d.entity ? ` · <a href="#/entidade/${d.entity.id}">ficha de entidade e contratos</a>` : ""}</div></div></div>
      ${i.description ? `<section class="panel"><p>${esc(i.description)}</p>${i.president ? `<p class="small muted">${esc(i.president_role || "Presidente")}: <b>${esc(i.president)}</b> (segundo a página oficial no sns.gov.pt).</p>` : ""}</section>` : ""}
      ${!units.length && ["uls", "ipo", "hospital"].includes(i.kind) ? `<section class="panel"><h2>Composição</h2><p class="small muted">Composição não disponível: a página oficial no sns.gov.pt não lista as unidades desta instituição.</p></section>` : ""}
      ${units.length ? `<section class="panel"><h2>Composição (${Portal.int(units.length)} unidades listadas na página oficial)</h2>
        ${hosp.length ? `<h3>Hospitais</h3><ul class="sa-units">${hosp.map((u) => `<li>${esc(u.name)}</li>`).join("")}</ul>` : ""}
        ${acesNames.length ? `<h3>Agrupamentos de centros de saúde (ACeS) e centros de saúde</h3>${acesNames.map((a) => `<details><summary><b>${esc(a)}</b> · ${csBy(a).length} unidades</summary><ul class="sa-units">${csBy(a).map((u) => `<li>${esc(u.name)}</li>`).join("")}</ul></details>`).join("")}` : ""}
        ${other.length ? `<h3>Outras unidades</h3><ul class="sa-units">${other.map((u) => `<li>${esc(u.name)}</li>`).join("")}</ul>` : ""}
        <p class="small muted">Número de camas por instituição: não publicado nas fontes abertas utilizadas (o INE só agrega por região).</p></section>` : ""}
      <section class="panel"><h2>Indicadores de desempenho do SNS</h2>${blockedNote(d.indicatorsNote)}
        <p class="small"><a href="#/saude#sec-cat">Ver o catálogo de indicadores →</a></p></section>
      <section class="panel"><h2>Contratação pública</h2>${d.institution.nif ? procPanel(d.procurement, { showServices: true }) : '<p class="small muted">Instituição sem NIF ligado de forma inequívoca ao registo de entidades; sem contratos associados.</p>'}</section>`;
  }

  Portal.page("saude", async (arg, p) => {
    try {
      const m = /^inst\/(.+)$/.exec(arg || "");
      if (m) return await pageInst(decodeURIComponent(m[1]));
      return await pageOverview(p || {});
    } catch (e) {
      $app.innerHTML = `<div class="pagehead"><div><h1>Saúde</h1></div></div><p class="note warn">Não foi possível carregar os dados de saúde (${esc(String(e.message || e))}).</p>`;
    }
  });

  /* ------------------------------------------------------------------ entity hook */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e) return;
    const d = await Portal.api("saude/instituicao?nif=" + encodeURIComponent(e.nif || "") + (e.id ? "&entity=" + e.id : "")).catch(() => null);
    if (!d || !d.institution) {
      if (e.kind === "saude") el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Indicadores SNS</h2><p class="small muted">Esta entidade de saúde não consta (ou não foi ligada de forma inequívoca) à lista oficial de entidades do SNS. <a href="#/saude${Portal.qs({ q: e.name })}">Procurar no módulo Saúde →</a></p></section>`);
      return;
    }
    const i = d.institution;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Indicadores SNS</h2>
      <p><b>${esc(i.kindLabel)}</b>${i.region ? " · " + esc(i.region) : ""}${i.n_hospitals ? ` · ${i.n_hospitals} hospital(is) identificado(s) na página oficial (pode estar incompleto)` : ""}${i.n_aces ? ` · ${i.n_aces} ACeS` : ""}${i.n_cs ? ` · ${i.n_cs} centros de saúde` : ""}${i.president ? ` · ${esc(i.president_role || "Presidente")}: ${esc(i.president)}` : ""}.</p>
      <p class="small muted">Tempos de espera, LIC, urgências e utentes sem médico de família por instituição estão no <a href="https://transparencia.sns.gov.pt/" target="_blank" rel="noopener">Portal da Transparência do SNS</a>; não são reproduzidos aqui porque o <code>robots.txt</code> desse portal proíbe o acesso automático à API e às descargas.</p>
      <p class="small"><a href="#/saude/inst/${encodeURIComponent(i.id)}">Página da instituição no módulo Saúde →</a> · ${ext(i.source_url, "sns.gov.pt")}${i.website ? " · " + ext(i.website, "sítio oficial") : ""}</p></section>`);
  });
})();
