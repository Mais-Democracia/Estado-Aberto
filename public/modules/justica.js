"use strict";
/* Módulo "justica": #/justica (tabs: Tribunais e estatísticas | Tribunal Constitucional | Tribunal de Contas | Contratação).
   API: /api/justica/*. Fontes: INE (séries da DGPJ), tribunalconstitucional.pt, tcontas.pt, registo de entidades e contratos do Portal BASE.
   Hook de entidade: «Auditorias do Tribunal de Contas». */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const sh = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  const css = `<style>.ju-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.ju-tabs a{padding:7px 14px;border:1px solid var(--line2);border-radius:999px;text-decoration:none;color:inherit}
  .ju-tabs a.on{background:var(--bar);color:#fff;border-color:var(--bar)}.ju-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.ju-filters input[type=search]{flex:1;min-width:220px}
  .ju-svg{width:100%;height:auto;max-height:260px}.ju-svg text{fill:var(--muted);font:11px system-ui}.ju-svg .ln{fill:none;stroke-width:2.2}.ju-svg .gr{stroke:var(--line2)}
  .ju-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:.85rem;color:var(--muted);margin:.2rem 0}.ju-leg i{display:inline-block;width:14px;height:3px;margin-right:5px;vertical-align:middle}
  .ju-cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.ju-cards .card{border:1px solid var(--line2);border-radius:8px;padding:10px 12px}
  .ju-cards .card h4{margin:.1rem 0 .3rem}.ju-sum{font-size:.88rem;color:var(--muted);margin:.25rem 0 0}.tag.red{background:#f3d1cf;color:#7a1d17}.tag.green{background:#d8ecd9;color:#1d5b22}</style>`;
  const COLORS = ["#046A38", "#DA291C", "#2e8b57", "#b8860b", "#7d3c98", "#16a085"];
  const sel = (id, opts, cur, all) => `<select id="${id}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const TABS = [["tribunais", "Tribunais e estatísticas"], ["tc", "Tribunal Constitucional"], ["contas", "Tribunal de Contas"], ["contratacao", "Contratação"]];
  const tabs = (cur) => `<nav class="ju-tabs" aria-label="Secções">${TABS.map(([k, l]) => `<a href="#/justica${k === "tribunais" ? "" : "/" + k}" class="${k === cur ? "on" : ""}">${l}</a>`).join("")}</nav>`;
  const head = (cur, sub) => `${css}<div class="crumbs"><a href="#/">Início</a> / <a href="#/justica">Justiça</a></div>
    <div class="pagehead"><div><div class="kicker">Poder judicial e fiscalização</div><h1>Justiça</h1><p class="small muted">${sub}</p></div></div>${tabs(cur)}`;
  const kpi = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;
  const warn = (blocked) => (blocked && blocked.length ? `<details class="note warn"><summary><b>Dados que não foi possível obter (${blocked.length})</b></summary><ul>${blocked.map((b) => `<li><b>${esc(b.source)}</b> — ${esc(b.reason)}</li>`).join("")}</ul></details>` : "");

  /* multi-line SVG chart: series = [{name, pts:[{x,y}]}] */
  function lines(series, label, fmtY) {
    const all = series.flatMap((s) => s.pts);
    if (!all.length) return '<p class="note">Sem dados para esta seleção.</p>';
    const xs = [...new Set(all.map((p) => p.x))].sort();
    const W = 680, H = 240, L = 62, R = 14, T = 12, B = 28;
    const max = Math.max(...all.map((p) => p.y), 1), min = Math.min(0, ...all.map((p) => p.y));
    const X = (x) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) * (W - L - R)) / (xs.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const f = fmtY || ((v) => nf.format(Math.round(v)));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((q) => { const v = min + (max - min) * q; return `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(f(v))}</text>`; }).join("");
    const step = Math.ceil(xs.length / 10);
    const xl = xs.map((x, i) => (i % step === 0 || (i === xs.length - 1 && i % step >= 2) ? `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${esc(x)}</text>` : "")).join("");
    const paths = series.map((s, k) => {
      const c = COLORS[k % COLORS.length];
      const pts = s.pts.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
      return `<path class="ln" stroke="${c}" d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}"/>` + pts.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.8" fill="${c}"><title>${esc(s.name)} · ${esc(p.x)}: ${esc(f(p.y))}</title></circle>`).join("");
    }).join("");
    const leg = series.length > 1 ? `<div class="ju-leg">${series.map((s, k) => `<span><i style="background:${COLORS[k % COLORS.length]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
    return `<svg class="ju-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xl}${paths}</svg>${leg}`;
  }

  /* ------------------------------------------------------------------ tab 1: tribunais e estatísticas */
  async function tabTribunais(p) {
    const [ov, tr] = await Promise.all([Portal.api("justica/overview"), Portal.api("justica/tribunais" + Portal.qs({ q: p.q, cat: p.cat, page: p.page }))]);
    if (ov.available === false) { $app.innerHTML = head("tribunais", "") + `<p class="note warn">${esc(ov.note)}</p>`; return; }
    const s = ov.series, last = (a) => a[a.length - 1] || {};
    const link = (o) => `#/justica${Portal.qs({ ...p, ...o })}`;
    const inds = (await Portal.api("justica/estatisticas")).indicators;
    const defInd = p.ind || "0000853";
    $app.innerHTML = head("tribunais", `Mapa institucional dos tribunais, conselhos superiores e Ministério Público, com as estatísticas oficiais da Direção-Geral da Política de Justiça (via INE). Atualizado: ${esc(ov.built || "—")}.`) + `
      <div class="kpis">${kpi(Portal.int(ov.counts.tribunais), "tribunais e organismos no registo de entidades")}${kpi(Portal.int(last(s.entrados).value || 0), "processos entrados nos tribunais judiciais de 1.ª instância em " + esc(last(s.entrados).period || "—"))}
        ${kpi(Portal.int(last(s.findos).value || 0), "processos findos em " + esc(last(s.findos).period || "—"))}${kpi(Portal.int(last(s.pendentes).value || 0), "processos pendentes no fim de " + esc(last(s.pendentes).period || "—"))}</div>
      ${warn(ov.blocked)}
      <section class="panel"><h2>Movimento de processos nos tribunais judiciais de 1.ª instância</h2>
        ${lines([{ name: "Entrados", pts: s.entrados.map((r) => ({ x: r.period, y: r.value })) }, { name: "Findos", pts: s.findos.map((r) => ({ x: r.period, y: r.value })) }, { name: "Pendentes", pts: s.pendentes.map((r) => ({ x: r.period, y: r.value })) }], "Processos entrados, findos e pendentes")}
        <p class="small muted">Todos os tipos de processo (cíveis, penais, tutelares), Portugal. O pico de 2014 (cerca de 2,1 milhões de processos) está na série oficial e pode refletir alterações de contagem ou de classificação; consulte a metainformação do INE antes de o interpretar como aumento real da litigância. Fonte: DGPJ, publicado pelo INE (indicador 0000853).</p></section>
      <section class="panel" id="sec-est"><h2>Estatísticas da Justiça (DGPJ/INE)</h2>
        <div class="ju-filters">${sel("ji", inds.map((i) => [i.indicator, i.name.replace(/;.*$/, "")]), defInd, "Indicador").replace('<option value="">Indicador</option>', "")}<select id="jg" style="display:none" aria-label="Comarca / região"></select><select id="jd" style="display:none"></select></div>
        <div id="ju-chart"><p class="small muted">A carregar…</p></div></section>
      <section class="panel"><h2>Órgãos superiores da justiça</h2>
        <div class="ju-cards">${tr.orgaos.map((o) => `<div class="card"><span class="tag">${esc(o.categoria)}</span><h4>${o.eid ? `<a href="#/entidade/${o.eid}">${esc(o.name)}</a>` : esc(o.name)}</h4>
          <div class="small muted">${esc(o.jurisdicao || "")}</div><p class="small">${esc(o.description || "")}</p>
          <div class="small">${ext(o.website, "sítio oficial")}${o.reachable === 0 ? ' <span class="muted">(não respondeu no último teste)</span>' : ""}</div></div>`).join("")}</div></section>
      <section class="panel"><h2>Tribunais e organismos no registo de entidades (${Portal.int(tr.total)})</h2>
        <p class="small muted">Comarcas, juízos, tribunais administrativos e fiscais, Relações, Ministério Público e conselhos, tal como constam do Portal BASE (entidades adjudicantes). O mapa oficial «Justiça no mapa» da DGPJ não está disponível em dados abertos (a API devolve 404).</p>
        <div class="ju-filters"><input type="search" id="jq" placeholder="Pesquisar tribunal ou comarca…" value="${esc(p.q || "")}">${sel("jc", tr.cats.map((c) => [c.category, `${c.label} (${c.n})`]), p.cat, "Todas as categorias")}</div>
        ${Portal.table([
          { h: "Entidade", f: (r) => `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` },
          { h: "Categoria", f: (r) => `<span class="tag">${esc(r.categoria)}</span>` },
          { h: "Comarca", f: (r) => esc(r.comarca || "") },
          { h: "Contratos", num: 1, f: (r) => Portal.int(r.buyer_contracts || 0) },
          { h: "Valor contratado", num: 1, f: (r) => Portal.eur(r.buyer_value || 0) },
        ], tr.rows)}
        ${Portal.pager(tr.total, tr.page, 60, (n) => link({ page: n }))}</section>
      <p class="small muted">Fontes: ${ext("https://www.ine.pt/", "INE (séries DGPJ)")}, ${ext("https://dados.gov.pt/pt/organizations/direcao-geral-da-politica-de-justica/", "DGPJ no dados.gov.pt")}, Portal BASE/IMPIC. Só dados institucionais e agregados; sem dados pessoais.</p>`;
    const rer = (o) => { location.hash = link({ ...o, page: 1 }); };
    const q = $("#jq"); if (q) q.onkeydown = (e) => { if (e.key === "Enter") rer({ q: e.target.value }); };
    const c = $("#jc"); if (c) c.onchange = (e) => rer({ cat: e.target.value });
    await drawStat(defInd);
    $("#ji").onchange = (e) => drawStat(e.target.value);
    $("#jg").onchange = (e) => drawStat($("#ji").value, "", e.target.value);
    $("#jd").onchange = (e) => drawStat($("#ji").value, e.target.value, $("#jg").value);
  }

  async function drawStat(ind, dimSel, geo) {
    const box = $("#ju-chart"); if (!box) return;
    const d = await Portal.api("justica/estatisticas" + Portal.qs({ indicador: ind, tribunal: geo })).catch(() => null);
    if (!d || !d.rows) { box.innerHTML = '<p class="note warn">Série indisponível.</p>'; return; }
    const unit = d.indicator.unit || "";
    const fmtY = (v) => (unit.includes("%") || unit === "Mês" ? nf.format(v) : nf.format(Math.round(v)));
    // series = one line per combination of dims (limit to 6); pick a default dim2 filter when many
    const key = (r) => [r.dim1, r.dim2].filter(Boolean).join(" · ") || "Total";
    const names = [...new Set(d.rows.map(key))];
    const sg = $("#jg");
    if (sg) { sg.style.display = d.geos.length > 1 ? "" : "none"; sg.innerHTML = d.geos.map((g) => `<option ${g === d.geo ? "selected" : ""}>${esc(g)}</option>`).join(""); }
    const sd = $("#jd");
    let chosen = dimSel && names.includes(dimSel) ? dimSel : "";
    if (sd) { sd.style.display = names.length > 1 ? "" : "none"; sd.innerHTML = `<option value="">Principais (até 6)</option>` + names.map((x) => `<option ${x === chosen ? "selected" : ""}>${esc(x)}</option>`).join(""); }
    let use = chosen ? [chosen] : names;
    if (!chosen && names.length > 6) {
      const lastP = d.rows.reduce((m, r) => (r.period > m ? r.period : m), "");
      use = names.map((n) => ({ n, v: d.rows.filter((r) => key(r) === n && r.period === lastP).reduce((a, r) => a + r.value, 0) })).sort((a, b) => b.v - a.v).slice(0, 6).map((x) => x.n);
    }
    const series = use.map((n) => ({ name: n, pts: d.rows.filter((r) => key(r) === n).map((r) => ({ x: r.period, y: r.value })) }));
    box.innerHTML = `<h3 style="margin:.2rem 0">${esc(d.indicator.name.replace(/;.*$/, ""))}</h3>${lines(series, d.indicator.name, fmtY)}
      ${d.ranking && d.ranking.length ? `<details><summary>Comparação entre ${d.ranking.length} comarcas/distritos em ${esc(d.ranking[0].period)} (${esc(d.dims1.find((x) => /^Total|Cíveis/.test(x)) || d.dims1[0] || "")})</summary>${Portal.table([{ h: "Território", f: (r) => esc(r.geo) }, { h: "Valor", num: 1, f: (r) => esc(fmtY(r.value)) }], d.ranking)}</details>` : ""}
      <p class="small muted">${esc(d.geo)}${unit ? " · unidade: " + esc(unit) : ""} · atualizado em ${esc(d.indicator.updated || "—")} · ${ext(d.indicator.source_url, "Metainformação INE")}</p>`;
  }

  /* ------------------------------------------------------------------ tab 2: Tribunal Constitucional */
  async function tabTC(p) {
    const d = await Portal.api("justica/acordaos" + Portal.qs({ q: p.q, tipo: p.tipo, ano: p.ano, page: p.page, resultado: p.resultado }));
    if (d.available === false) { $app.innerHTML = head("tc", "") + `<p class="note warn">${esc(d.note)}</p>`; return; }
    const link = (o) => `#/justica/tc${Portal.qs({ ...p, ...o })}`;
    const byYear = {};
    for (const r of d.porAno || []) (byYear[r.tipo] = byYear[r.tipo] || []).push({ x: String(r.year), y: r.n });
    const main = ["Fiscalização concreta (recurso)", "Reclamação", "Contencioso eleitoral"].filter((t) => byYear[t]);
    const abs = ["Fiscalização preventiva", "Fiscalização sucessiva abstrata", "Inconstitucionalidade por omissão"].filter((t) => byYear[t]);
    const chart = (d.porAno || []).length ? lines(main.map((t) => ({ name: t, pts: byYear[t] })), "Acórdãos por ano e tipo") : "";
    const chart2 = abs.length ? lines(abs.map((t) => ({ name: t, pts: byYear[t] })), "Fiscalização abstrata e preventiva por ano") : "";
    const SHORT = { "Pronúncia pela inconstitucionalidade (preventiva)": "Pronúncia (preventiva)", "Declarada inconstitucionalidade/ilegalidade com força obrigatória geral": "Declarada c/ força obrig. geral", "Julgada inconstitucional": "Julgada inconst. (concreta)", "Sem pronúncia de inconstitucionalidade": "Sem pronúncia", "Não declarada a inconstitucionalidade": "Não declarada", "Não tomou conhecimento": "Não tomou conhecimento", "Decisão mista (várias normas/pedidos)": "Decisão mista" };
    const resYear = (d.resultadosAno || []).filter((r) => /força obrigatória|Pronúncia|Sem pronúncia|Julgada|Não declarada|mista|conhecimento/.test(r.resultado));
    const resTbl = {};
    for (const r of resYear) { (resTbl[r.year] = resTbl[r.year] || {})[r.resultado] = r.n; }
    const resCols = [...new Set(resYear.map((r) => r.resultado))];
    const years = Object.keys(resTbl).sort().reverse().slice(0, 15);
    $app.innerHTML = head("tc", `Acórdãos do Tribunal Constitucional (1983–hoje) a partir da lista oficial em tribunalconstitucional.pt. ${Portal.int(d.detailed || 0)} foram lidos na íntegra para extrair o resultado (fiscalização preventiva, sucessiva abstrata, omissão, referendo); ${Portal.int(d.dreLinked || 0)} ligam ao Diário da República.`) + `
      <div class="kpis">${kpi(Portal.int(d.total), "acórdãos na seleção")}${kpi(Portal.int((d.tipos || []).reduce((a, t) => a + t.n, 0)), "acórdãos no total (1983–hoje)")}${kpi(Portal.int((d.anos || [])[0] || 0), "ano mais recente")}</div>
      ${chart ? `<section class="panel"><h2>Acórdãos por ano e tipo de processo</h2>${chart}<p class="small muted">«Fiscalização concreta» = recursos de decisões de outros tribunais (a grande maioria). 2026 é um ano parcial.</p></section>` : ""}
      ${chart2 ? `<section class="panel"><h2>Fiscalização preventiva e abstrata por ano</h2>${chart2}<p class="small muted">Muito menos frequente, mas é onde o Tribunal trava ou anula leis. «Sucessiva» inclui pedidos de declaração com força obrigatória geral.</p></section>` : ""}
      ${years.length ? `<section class="panel"><h2>Decisões de constitucionalidade, por ano e resultado</h2><p class="small muted">Fiscalização preventiva, sucessiva abstrata, omissão e referendo (últimos 15 anos).</p><div class="tblwrap"><table class="tbl"><thead><tr><th>Ano</th>${resCols.map((c) => `<th class="num">${esc(SHORT[c] || c)}</th>`).join("")}</tr></thead><tbody>${years.map((y) => `<tr><td>${y}</td>${resCols.map((c) => `<td class="num">${resTbl[y][c] || ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <p class="small muted">Resultado extraído da parte decisória do acórdão ou do sumário publicado no Diário da República; classificação automática por palavras-chave — confirmar sempre no texto oficial.</p></section>` : ""}
      <section class="panel"><h2>Pesquisar acórdãos</h2>
        <div class="ju-filters"><input type="search" id="tq" placeholder="N.º (ex. 409/2026), processo, relator, norma…" value="${esc(p.q || "")}">
          ${sel("tt", (d.tipos || []).map((t) => [t.tipo, `${t.tipo} (${t.n})`]), p.tipo, "Todos os tipos")}${sel("ta", (d.anos || []).map((y) => [y, y]), p.ano, "Todos os anos")}</div>
        ${Portal.table([
          { h: "Acórdão", f: (r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${r.num}/${r.year} ↗</a>${r.dre_act_id ? ` <a class="small" href="#/dre/${esc(r.dre_act_id)}" title="Publicado no Diário da República">DR</a>` : ""}` },
          { h: "Data", f: (r) => Portal.fmtDate(r.data) },
          { h: "Tipo", f: (r) => `<span class="tag">${esc(r.tipo)}</span>` },
          { h: "Processo", f: (r) => esc(r.processo || "") },
          { h: "Formação", f: (r) => esc(r.formacao || "") },
          { h: "Resultado / sumário", f: (r) => `${r.resultado ? `<b>${esc(r.resultado)}</b>` : ""}${r.sumario ? `<div class="ju-sum">${esc(r.sumario.slice(0, 280))}${r.sumario.length > 280 ? "…" : ""}</div>` : ""}` },
          { h: "Relator", f: (r) => `<span class="small">${esc(r.relator || "")}</span>` },
        ], d.rows)}
        ${Portal.pager(d.total, d.page, 40, (n) => link({ page: n }))}</section>
      <p class="small muted">Fonte: ${ext("https://www.tribunalconstitucional.pt/tc/acordaos/", "tribunalconstitucional.pt — Acórdãos")}. Relator = metadado oficial do acórdão. Não se guardam nomes de partes nem textos de acórdãos além de um excerto da parte decisória.</p>`;
    const rer = (o) => { location.hash = link({ ...o, page: 1 }); };
    const q = $("#tq"); if (q) q.onkeydown = (e) => { if (e.key === "Enter") rer({ q: e.target.value }); };
    for (const [id, k] of [["tt", "tipo"], ["ta", "ano"]]) { const el = $("#" + id); if (el) el.onchange = (e) => rer({ [k]: e.target.value }); }
  }

  /* ------------------------------------------------------------------ tab 3: Tribunal de Contas */
  async function tabContas(p) {
    const d = await Portal.api("justica/auditorias" + Portal.qs({ q: p.q, cat: p.cat, grupo: p.grupo, ano: p.ano, resultado: p.resultado, entity: p.entity, page: p.page }));
    if (d.available === false) { $app.innerHTML = head("contas", "") + `<p class="note warn">${esc(d.note)}</p>`; return; }
    const link = (o) => `#/justica/contas${Portal.qs({ ...p, ...o })}`;
    const byCat = {};
    for (const r of d.porAno || []) (byCat[r.categoria] = byCat[r.categoria] || []).push({ x: String(r.year), y: r.n });
    const chart = lines([{ name: "Relatórios", pts: byCat.relatorio || [] }, { name: "Acórdãos publicados", pts: byCat.acordao || [] }].filter((s) => s.pts.length), "Documentos do Tribunal de Contas por ano");
    $app.innerHTML = head("contas", "Relatórios de auditoria, acompanhamento e verificação de contas, e acórdãos (fiscalização prévia/visto e responsabilidades financeiras) publicados em tcontas.pt, ligados às entidades auditadas quando o nome coincide com o registo (apenas uma parte: ~1 000 de ~4 100 documentos; os restantes não foram associados a nenhuma entidade).") + `
      <div class="kpis">${kpi(Portal.int(d.total), "documentos na seleção")}${kpi(Portal.int(d.ligados || 0), "ligados a uma entidade do registo")}${(d.vistos || []).map((v) => kpi(Portal.int(v.n), esc(v.resultado))).join("")}</div>
      <section class="panel"><h2>Publicações por ano</h2>${chart}</section>
      ${(d.topEntidades || []).length ? `<section class="panel"><h2>Entidades mais referidas</h2><p>${d.topEntidades.map((e) => `<a class="tag" href="#/entidade/${e.entity_id}">${esc(e.name || e.entity_id)} · ${e.n}</a>`).join(" ")}</p></section>` : ""}
      <section class="panel"><h2>Auditorias, relatórios e acórdãos</h2>
        <div class="ju-filters"><input type="search" id="cq" placeholder="Pesquisar por entidade ou assunto…" value="${esc(p.q || "")}">
          ${sel("cg", (d.grupos || []).map((g) => [g.grupo, `${g.grupo} (${g.n})`]), p.grupo, "Todos os tipos")}${sel("ca", (d.anos || []).map((y) => [y, y]), p.ano, "Todos os anos")}
          ${sel("cr", [["Recusa de visto", "Recusa de visto"], ["Concessão de visto", "Concessão de visto"]], p.resultado, "Qualquer decisão de visto")}</div>
        ${p.entity ? `<p class="small">A filtrar por entidade #${esc(p.entity)} · <a href="${link({ entity: "", page: 1 })}">limpar</a></p>` : ""}
        ${Portal.table([
          { h: "Documento", f: (r) => `${ext(r.pdf_url, r.titulo_ref.replace(/ - /g, " · "))}` },
          { h: "Assunto / entidade", f: (r) => `${esc(r.descricao || "")}${r.entity_id ? `<div class="small"><a href="#/entidade/${r.entity_id}">→ ${esc(r.entity_name || "entidade")}</a></div>` : ""}` },
          { h: "Tipo", f: (r) => `<span class="tag">${esc(r.grupo)}</span>${r.resultado ? ` <span class="tag ${/Recusa/.test(r.resultado) ? "red" : "green"}">${esc(r.resultado)}</span>` : ""}` },
          { h: "Data", f: (r) => Portal.fmtDate(r.data || r.publicado) },
        ], d.rows)}
        ${Portal.pager(d.total, d.page, 40, (n) => link({ page: n }))}</section>
      <p class="small muted">Fonte: ${ext("https://www.tcontas.pt/pt-pt/ProdutosTC/Relatorios/Pages/Relatorios-do-Tribunal-de-Contas.aspx", "tcontas.pt — Relatórios")} e ${ext("https://www.tcontas.pt/pt-pt/ProdutosTC/acordaos/Pages/Acordaos-do-Tribunal-de-Contas.aspx", "Acórdãos")}. O tcontas.pt não tem robots.txt nem condições que proíbam a consulta automática. A ligação à entidade é feita por nome (aproximada); «visto» = decisão lida no PDF do acórdão por palavras-chave. Só se publicam entidades públicas.</p>`;
    const rer = (o) => { location.hash = link({ ...o, page: 1 }); };
    const q = $("#cq"); if (q) q.onkeydown = (e) => { if (e.key === "Enter") rer({ q: e.target.value }); };
    for (const [id, k] of [["cg", "grupo"], ["ca", "ano"], ["cr", "resultado"]]) { const el = $("#" + id); if (el) el.onchange = (e) => rer({ [k]: e.target.value }); }
  }

  /* ------------------------------------------------------------------ tab 4: contratação */
  const supp = (rows) => Portal.table([
    { h: "Fornecedor", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name || r.nif)}</a>` : esc(r.name || r.nif || "—")) },
    { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) },
    { h: "% ajuste direto (n.º)", num: 1, f: (r) => sh(r.direct_n, r.n) }], rows || []);
  const buyers = (rows) => Portal.table([
    { h: "Entidade", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name || r.nif)) },
    { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) },
    { h: "% direto (valor)", num: 1, f: (r) => sh(r.direct_value, r.value) }], rows || []);
  const procBlock = (pr, title, extra = "") => {
    if (!pr || !pr.n) return `<section class="panel"><h2>${title}</h2><p class="small muted">Sem contratos associados.</p></section>`;
    return `<section class="panel"><h2>${title}</h2>
      <div class="kpis">${kpi(Portal.eur(pr.value), "contratado (2012–hoje)")}${kpi(Portal.int(pr.n), "contratos")}${kpi(sh(pr.direct_value, pr.value), "do valor por ajuste direto")}${kpi(sh(pr.direct_n, pr.n), "dos contratos por ajuste direto")}</div>
      ${pr.years && pr.years.length ? Portal.bars(pr.years) : ""}
      <div class="cols"><div><h3>Entidades que mais contratam</h3>${buyers(pr.buyers)}</div><div><h3>Maiores fornecedores</h3>${supp(pr.topSuppliers)}</div></div>${extra}</section>`;
  };
  async function tabContratacao() {
    const d = await Portal.api("justica/contratacao");
    if (d.available === false) { $app.innerHTML = head("contratacao", "") + `<p class="note warn">${esc(d.note || "Sem dados de contratos.")}</p>`; return; }
    const rec = (d.tribunais.recent || []);
    const rs = d.resumo;
    const row = (r, b) => `<tr${b ? ' style="font-weight:700"' : ""}><td>${esc(r.label)}</td><td class="num">${Portal.int(r.nbuyers)}</td><td class="num">${Portal.int(r.n)}</td><td class="num">${Portal.eur(r.value)}</td><td class="num">${sh(r.direct_value, r.value)}</td></tr>`;
    const resumoHtml = rs ? `<section class="panel"><h2>Resumo: de onde vêm os valores</h2><div class="tblwrap"><table class="tbl"><thead><tr><th>Grupo</th><th class="num">Entidades</th><th class="num">Contratos</th><th class="num">Valor</th><th class="num">% direto (valor)</th></tr></thead><tbody>${row(rs.tribunais)}${row(rs.mj)}${row(rs.total, 1)}</tbody></table></div>
      <p class="small muted">Mesma definição nos quadros abaixo. Tribunais: ${esc(rs.tribunaisNames.slice(0, 5).join(", "))}… (Supremos, Relações, comarcas, Tribunal de Contas, Tribunal Constitucional, PGR, CSM). Ministério da Justiça: ${esc(rs.mjNames.join("; "))}.</p>
      <p class="small muted">${esc(rs.kind.label)}: ${Portal.eur(rs.kind.value)} (${Portal.int(rs.kind.n)} contratos) — é o valor que aparece no diretório de entidades por tipo; os ${Portal.eur(rs.kind.value - rs.tribunais.value)} a mais do que na linha «Tribunais» correspondem ao IRN, à Polícia Judiciária e à PJ Militar (que o diretório classifica nesse tipo), que aqui contam no Ministério da Justiça.</p></section>` : "";
    $app.innerHTML = head("contratacao", "Contratos públicos (Portal BASE/IMPIC) celebrados pelos tribunais e conselhos superiores, e pelos organismos tutelados pelo Ministério da Justiça.") + `
      ${resumoHtml}
      ${procBlock({ ...d.tribunais }, `Tribunais e órgãos judiciais (${Portal.int(d.tribunais.nbuyers)} entidades, sem organismos do MJ)`, rec.length ? `<h3>Contratos recentes</h3>${Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.signed) }, { h: "Entidade", f: (r) => `<span class="small">${esc(r.buyer_name || "")}</span>` }, { h: "Objeto", f: (r) => `<a href="#/contrato/${esc(r.id)}">${esc((r.object || "").slice(0, 110))}</a>` }, { h: "Fornecedor", f: (r) => `<span class="small">${esc(r.seller_name || "")}</span>` }, { h: "Preço", num: 1, f: (r) => Portal.eurFull(r.price) }], rec)}` : "")}
      ${procBlock({ ...d.mj }, `Organismos do Ministério da Justiça (${Portal.int(d.mj.nbuyers)} entidades: registos e notariado, PJ, prisões, medicina legal…)`)}
      <p class="small muted">${esc(d.note)} Ajuste direto = procedimento com «direto» no nome. Os valores são preços contratuais, não pagamentos.</p>`;
  }

  Portal.nav("Justiça", "#/justica");
  Portal.page("justica", async (arg, p) => {
    p = p || {};
    try {
      if (arg === "tc") return await tabTC(p);
      if (arg === "contas") return await tabContas(p);
      if (arg === "contratacao") return await tabContratacao();
      return await tabTribunais(p);
    } catch (e) {
      $app.innerHTML = `${css}<div class="pagehead"><div><h1>Justiça</h1></div></div><p class="note warn">Não foi possível carregar os dados (${esc(String(e.message || e))}).</p>`;
    }
  });

  /* ------------------------------------------------------------------ entity hook */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.id) return;
    const d = await Portal.api("justica/entidade?id=" + e.id).catch(() => null);
    if (!d || !d.rows || !d.rows.length) return;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Auditorias do Tribunal de Contas</h2>
      <p class="small muted">${d.rows.length} documento(s) do Tribunal de Contas cujo título refere esta entidade (associação por nome, aproximada).</p>
      ${Portal.table([
        { h: "Documento", f: (r) => ext(r.pdf_url, r.numero || r.grupo) },
        { h: "Assunto", f: (r) => (r.descricao || r.titulo_ref) ? esc((r.descricao || r.titulo_ref).slice(0, 200)) : `<span class="muted">sem título</span>` },
        { h: "Tipo", f: (r) => `<span class="tag">${esc(r.grupo)}</span>${r.resultado ? ` <span class="tag ${/Recusa/.test(r.resultado) ? "red" : "green"}">${esc(r.resultado)}</span>` : ""}` },
        { h: "Data", f: (r) => Portal.fmtDate(r.data || r.publicado || "") }], d.rows)}
      <p class="small"><a href="#/justica/contas?entity=${e.id}">Ver no módulo Justiça →</a></p></section>`);
  });
})();
