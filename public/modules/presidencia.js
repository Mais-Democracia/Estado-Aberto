"use strict";
/* Módulo "presidencia": #/atos-presidente (e #/atos-presidente/<id> para a ficha de um ato).
   Estende a página central #/presidencia (que fica como está) com os atos formais do Presidente da República:
   promulgações, vetos (com desfecho), pedidos ao Tribunal Constitucional, nomeações… API: /api/presidencia/*. */
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>.pr-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.pr-filters input[type=search]{flex:1;min-width:200px}
  .pr-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.pr-stack{display:flex;flex-direction:column-reverse;justify-content:flex-start;height:130px;width:100%}
  .pr-stack i{display:block;width:100%}.pr-bar{display:flex;flex-direction:column;justify-content:flex-end;height:130px}.pr-bar i{display:block;width:100%;min-height:1px}
  .pr-cols{display:flex;gap:3px;align-items:flex-end;overflow-x:auto;padding-bottom:2px}.pr-cols .c{flex:1;min-width:20px;text-align:center}.pr-cols .l{font-size:.7rem;color:var(--muted)}
  .pr-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:.85rem;color:var(--muted);margin:.4rem 0}.pr-leg i{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:2px}
  .tag.v{background:#f3d1cf;color:#7a1d17}.tag.p{background:#d8ecd9;color:#1d5b22}.tag.t{background:#e3dcf3;color:#43297a}.tag.n{background:#e2e6ea;color:#333}
  .pr-msg{white-space:pre-wrap;border-left:3px solid var(--line2);padding:.2rem .8rem;margin:.6rem 0;font-size:.92rem}</style>`;
  const C = { promulgacao: "#2e8b57", veto: "#c0392b", envio_tc: "#7d3c98" };
  const TAGC = { promulgacao: "p", veto: "v", envio_tc: "t" };
  const DES = { confirmado: ["Confirmado pela Assembleia", "v"], reformulado: ["Reformulado e reapreciado", "p"], caducou: ["Caducou (fim da legislatura)", "n"], em_reapreciacao: ["Em reapreciação", "n"], sem_desfecho: ["Sem desfecho nos dados", "n"] };
  const tipoLabel = (t, s) => ({ promulgacao: "Promulgação", veto: s === "tc" ? "Veto (após pronúncia do TC)" : "Veto", envio_tc: s === "sucessiva" ? "Pedido ao TC (sucessiva)" : s === "preventiva" ? "Pedido ao TC (preventiva)" : "Pedido ao TC", nomeacao: "Nomeação", exoneracao: "Exoneração", ratificacao: "Ratificação", homologacao: "Homologação", dissolucao: "Dissolução", indulto: "Indulto", condecoracao: "Condecoração", eleicoes: "Marcação de eleições", outro: "Outro" }[t] || t);
  const tag = (t, s) => `<span class="tag ${TAGC[t] || "n"}">${esc(tipoLabel(t, s))}</span>`;
  const kpi = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;
  const med = (v, n) => (v == null ? "—" : `${nf.format(v)} <span class="muted small">(n=${Portal.int(n)})</span>`);
  const head = (sub) => `${css}<div class="crumbs"><a href="#/">Início</a> / <a href="#/presidencia">Presidente da República</a> / Atos do Presidente</div>
    <div class="pagehead"><div><div class="kicker">Fim do ciclo da lei</div><h1>Atos do Presidente</h1><p class="small muted">${sub}</p></div></div>`;
  const link = (p) => "#/atos-presidente" + Portal.qs(p);

  function yearChart(rows) {
    if (!rows.length) return "<p class='muted'>Sem dados.</p>";
    const max = Math.max(1, ...rows.map((r) => r.ar + r.dl));
    const FL = { dre_parcial: "decretos da AR: só DRE, parcial (subcontagem)", misto: "decretos da AR: DRE até 26 abr + votações depois", votacoes: "decretos da AR: votações (uma fonte)", dre: "decretos da AR: DRE completo" };
    const mark = (a) => (a === 2022 ? "border-left:2px dashed var(--muted)" : a === 2024 ? "border-left:2px dashed var(--muted)" : "");
    return `<div class="pr-cols" role="img" aria-label="Promulgações por ano">${rows.map((r) => `<div class="c" style="${mark(r.ano)}" title="${r.ano}: ${r.ar} decretos da AR (${FL[r.fonte_ar]}) · ${r.dl} Decretos-Lei (DRE${r.dl_parcial ? ", parcial antes de 2024" : ""}) · vetos ${r.veto == null ? "n/d" : r.veto} · pedidos ao TC ${r.envio_tc}">
      <div class="pr-bar" style="height:130px"><i style="height:${r.dl ? Math.max(1, 130 * r.dl / max) : 0}px;background:${C.promulgacao};opacity:${r.dl_parcial ? .45 : .75}"></i><i style="height:${r.ar ? Math.max(1, 130 * r.ar / max) : 0}px;background:${C.promulgacao};${r.fonte_ar === "dre_parcial" ? "opacity:.55" : ""}"></i></div><div class="l">${String(r.ano).slice(2)}</div>
      <div class="l" style="color:${C.veto}" title="${r.veto == null ? "vetos: sem dados antes de 2022-04" : ""}">${r.veto == null ? "n/d" : r.veto || ""}</div><div class="l" style="color:${C.envio_tc}">${r.envio_tc || ""}</div></div>`).join("")}</div>
      <div class="pr-leg"><span><i style="background:${C.promulgacao}"></i>decretos da AR (em baixo)</span><span><i style="background:${C.promulgacao};opacity:.45"></i>Decretos-Lei (em cima; parcial antes de 2024)</span><span><i style="background:${C.veto}"></i>vetos (n.º por baixo; n/d antes de 2022-04, sem fonte)</span><span><i style="background:${C.envio_tc}"></i>pedidos do Presidente ao TC</span></div>
      <p class="small muted">Tracejado = mudança de fonte. Antes de 2022-04: só DRE (parcial, os anos anteriores estão subcontados). 2022-04 a 2023: decretos da AR só pelas votações. Desde 2024: DRE completo. Não comparar a altura das barras entre períodos.</p>`;
  }

  function daysChart(rows) {
    const mx = Math.max(1, ...rows.map((r) => Math.max(r.lei || 0, r.dl || 0)));
    return `<div class="pr-cols" role="img" aria-label="Mediana de dias entre aprovação e promulgação">${rows.map((r) => `<div class="c" title="${r.ano}: Leis ${r.lei == null ? "—" : nf.format(r.lei)} dias (n=${r.n_lei}) · Decretos-Lei ${r.dl == null ? "—" : nf.format(r.dl)} dias (n=${r.n_dl})">
      <div style="display:flex;gap:2px;align-items:flex-end;height:130px"><div class="pr-bar" style="flex:1"><i style="height:${r.lei ? Math.max(2, 130 * r.lei / mx) : 0}px;background:var(--bar)"></i></div><div class="pr-bar" style="flex:1"><i style="height:${r.dl ? Math.max(2, 130 * r.dl / mx) : 0}px;background:var(--bar2)"></i></div></div>
      <div class="l">${String(r.ano).slice(2)}</div><div class="l">${r.n_lei + r.n_dl}</div></div>`).join("")}</div>
      <div class="pr-leg"><span><i style="background:var(--bar)"></i>Leis (AR)</span><span><i style="background:var(--bar2)"></i>Decretos-Lei (Governo)</span><span>n.º de diplomas por baixo; máximo da escala ${nf.format(mx)} dias</span></div>`;
  }

  function vetoTable(rows) {
    return Portal.table([
      { h: "Data", f: (r) => esc(Portal.fmtDate(r.data)) },
      { h: "Presidente", f: (r) => esc(r.presidente || "") },
      { h: "Diploma", f: (r) => `<a href="#/atos-presidente/${encodeURIComponent(r.id)}">${esc(r.titulo || "")}</a>${r.decreto_ref ? ` <span class="muted small">Decreto AR n.º ${esc(r.decreto_ref)}</span>` : ""}` },
      { h: "Motivo", f: (r) => (r.motivo === "tc" ? '<span class="tag t">Após pronúncia do TC</span>' : '<span class="tag v">Político</span>') },
      { h: "Desfecho", f: (r) => { const d = DES[r.desfecho] || DES.sem_desfecho; return `<span class="tag ${d[1]}" title="${esc(r.desfecho_detalhe || "")}">${esc(d[0])}</span>${r.desfecho_data ? ` <span class="muted small">${esc(Portal.fmtDate(r.desfecho_data))}</span>` : ""}`; } },
      { h: "Mensagem", f: (r) => (r.mensagem_url ? ext(r.mensagem_url, "texto") : '<span class="muted small">não disponível</span>') },
    ], rows);
  }

  async function detail(id) {
    const d = await Portal.api("presidencia/ato?id=" + encodeURIComponent(id));
    if (!d || d.error) { $app.innerHTML = head("") + `<p class="note warn">${esc((d && d.error) || "Ato não encontrado.")}</p>`; return; }
    const a = d.ato, v = d.veto;
    const row = (k, val) => (val ? `<tr><th>${esc(k)}</th><td>${val}</td></tr>` : "");
    $app.innerHTML = head(esc(tipoLabel(a.tipo, a.subtipo)) + " · " + esc(Portal.fmtDate(a.data))) + `
      <section class="panel"><h2>${esc((a.titulo || a.diploma_ref || a.id).slice(0, 300))}</h2>
      <div>${tag(a.tipo, a.subtipo)} ${a.presidente ? `<span class="tag n">${esc(a.presidente)}</span>` : ""}</div>
      <table class="tbl"><tbody>
        ${row("Data", esc(Portal.fmtDate(a.data)))}${row("Diploma", esc([a.diploma_tipo, a.diploma_ref].filter(Boolean).join(" · ")))}
        ${row("Decreto da AR n.º", esc(a.decreto_ref || ""))}
        ${row("Iniciativa", a.iniciativa_key ? `<a href="#/votacoes?q=${encodeURIComponent(a.iniciativa_key.split("|")[1] + "/" + a.iniciativa_key.split("|")[2])}">${esc(a.iniciativa_key.replace(/\|/g, " "))}</a> <span class="muted small">(ligação: ${esc(a.link_metodo || "")})</span>` : "")}
        ${row("Diário da República", a.dre_act_id ? `<a href="#/dre/${encodeURIComponent(a.dre_act_id)}">ato ${esc(a.dre_act_id)}</a>` : "")}
        ${row("Aprovação", a.data_aprovacao ? esc(Portal.fmtDate(a.data_aprovacao)) + ` (${a.dias_aprovacao} dias até à promulgação)` : "")}
        ${row("Envio para promulgação", a.data_envio ? esc(Portal.fmtDate(a.data_envio)) + ` (${a.dias_envio} dias até à promulgação)` : "")}
        ${row("Acórdão do TC", esc(a.acordao_tc || ""))}${row("Fonte", ext(a.source_url, a.fonte))}${row("Texto do Presidente", a.mensagem_url ? ext(a.mensagem_url, "presidencia.pt") : "")}
      </tbody></table>
      ${v ? `<h3>Desfecho do veto</h3><p>${esc((DES[v.desfecho] || DES.sem_desfecho)[0])}${v.desfecho_data ? " em " + esc(Portal.fmtDate(v.desfecho_data)) : ""}. <span class="muted">${esc(v.desfecho_detalhe || "")}</span></p>
        ${v.iniciativas.length ? `<p class="small">Iniciativas: ${v.iniciativas.map((k) => esc(k.replace(/\|/g, " "))).join("; ")}</p>` : ""}` : ""}
      ${a.texto ? `<div class="pr-msg">${esc(a.texto)}</div>` : ""}
      ${(d.tc || []).length ? `<h3>Tribunal Constitucional</h3>${Portal.table([{ h: "Acórdão", f: (r) => esc(r.acordao_id) }, { h: "Data", f: (r) => esc(Portal.fmtDate(r.data)) }, { h: "Requerente", f: (r) => esc(r.requerente || "—") }, { h: "Resultado", f: (r) => esc(r.resultado || "") }, { h: "Fonte", f: (r) => ext(r.source_url, "TC") }], d.tc)}` : ""}
      ${(d.comunicados || []).length ? `<h3>Comunicados ligados</h3><ul>${d.comunicados.map((c) => `<li>${ext(c.url, c.titulo)} <span class="muted small">(${esc(Portal.fmtDate(c.data))}; ligação: ${esc(c.link_metodo || "")})</span></li>`).join("")}</ul>` : ""}
      </section><p><a href="#/atos-presidente">← Atos do Presidente</a></p>`;
  }

  async function main(p) {
    const [ov, vt, at] = await Promise.all([
      Portal.api("presidencia/overview"), Portal.api("presidencia/vetos"),
      Portal.api("presidencia/atos" + Portal.qs({ tipo: p.tipo, ano: p.ano, q: p.q, page: p.page, presidente: p.presidente })),
    ]);
    if (!ov || ov.available === false) { $app.innerHTML = head("") + `<p class="note warn">${esc((ov && ov.error) || "Dados indisponíveis.")}</p>`; return; }
    const L = ov.ligacoes, cob = ov.cobertura;
    const nVetos = ov.presidentes.reduce((s, x) => s + (x.vetos || 0), 0), nTc = ov.presidentes.reduce((s, x) => s + x.pedidos_tc, 0), nProm = ov.presidentes.reduce((s, x) => s + x.promulgacoes, 0);
    $app.innerHTML = head("Promulgações, vetos, pedidos de fiscalização ao Tribunal Constitucional, nomeações e outros atos do Presidente da República, ligados às votações da Assembleia e ao Diário da República por referência explícita (n.º do decreto, do acórdão ou do ato).") + `
      <div class="kpis">${kpi(Portal.int(ov.total.n), "atos registados (" + esc(ov.total.a.slice(0, 4)) + "–" + esc(ov.total.b.slice(0, 4)) + ")")}${kpi(Portal.int(nProm), "promulgações nas fontes")}${kpi(Portal.int(nVetos), "vetos desde 2022-04")}${kpi(Portal.int(nTc), "pedidos do Presidente ao TC (desde 1983)")}
        ${kpi(L.leis_ligadas.n ? Math.round(100 * L.leis_ligadas.l / L.leis_ligadas.n) + "%" : "—", "das leis promulgadas desde 2022-04 ligadas à iniciativa (" + L.leis_ligadas.l + " de " + L.leis_ligadas.n + ")")}</div>
      <details class="note warn" open><summary><b>Limites de cobertura</b> — a comparação entre Presidentes só vale onde a fonte cobre o período</summary><ul>${Object.entries(cob).filter(([k]) => k !== "wikipedia").map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join("")}</ul></details>
      <section class="panel"><h2>Atos por ano</h2>${yearChart(ov.anos.filter((r) => r.ano >= 1983))}
        <p class="small muted">Pedidos ao TC: pela data da decisão do TC. Vetos: só a partir de 2022-04 (votações).</p></section>
      <section class="panel"><h2>Vetos e desfecho (${vt.total})</h2>${vetoTable(vt.rows)}
        <p class="small muted">Data = receção do veto na Assembleia (a data do ato do Presidente é a da comunicação em presidencia.pt, só desde 2026-03-09). «Após pronúncia do TC» = devolução obrigatória (art. 279.º CRP). Os vetos a decretos do Governo são absolutos e não passam pela Assembleia: não existe fonte estruturada ${vt.rows.some((r) => r.origem === "Governo") ? "" : "e nenhum foi encontrado nas fontes lidas"}.
        Desfecho: ${Object.entries(vt.desfechos).map(([k, n]) => `${esc((DES[k] || [k])[0])}: ${n}`).join(" · ")}. Um veto ao mesmo decreto de várias iniciativas conta uma vez.</p></section>
      <section class="panel"><h2>Tempo até à promulgação</h2>${daysChart(ov.dias_ano)}
        <p class="small muted">Mediana de dias entre a aprovação (votação final da AR / Conselho de Ministros) e a promulgação, por ano de promulgação. Inclui o tempo de redação final e envio, não só o do Presidente. Anos anteriores a 2024 só com os diplomas que o DRE tem datados (n pequeno). O tempo só do Presidente (envio → promulgação) existe para decretos da AR desde 2022 (coluna «envio» abaixo).</p></section>
      <section class="panel"><h2>Comparação entre Presidentes</h2>${Portal.table([
        { h: "Presidente", f: (r) => esc(r.presidente) }, { h: "Promulgações*", num: 1, f: (r) => Portal.int(r.promulgacoes) },
        { h: "Vetos (políticos / após TC)", num: 1, f: (r) => (r.cobertura_votacoes ? `${r.vetos} (${r.vetos_politicos} / ${r.vetos_tc})${r.vetos_desde ? ' <span class="muted small">desde 2022-04</span>' : ""}` : '<span class="muted" title="Sem fonte estruturada">n/d</span>') },
        { h: "Confirmados / reformulados / caducados", num: 1, f: (r) => (r.cobertura_votacoes ? `${r.confirmados} / ${r.reformulados} / ${r.caducados}` : "—") },
        { h: "Pedidos ao TC", num: 1, f: (r) => Portal.int(r.pedidos_tc) },
        { h: "Dias aprov.→promulg. Leis", num: 1, f: (r) => med(r.dias_mediana_lei, r.n_lei) }, { h: "Decretos-Lei", num: 1, f: (r) => med(r.dias_mediana_dl, r.n_dl) },
        { h: "Dias envio→promulg. (AR)", num: 1, f: (r) => med(r.dias_envio_mediana, r.n_envio) },
      ], ov.presidentes)}
        <p class="small muted">* Contagens das fontes carregadas, não o total de diplomas promulgados: Seguro e Marcelo (2024–26) estão completos no DRE; Marcelo antes de 2024 e os anteriores só têm os diplomas datados no DRE. «n/d» = sem fonte de vetos. Medianas com n indicado; n pequeno não permite comparar.</p></section>
      <section class="panel"><h2>Pedidos do Presidente ao Tribunal Constitucional</h2>${Portal.table([
        { h: "Data da decisão", f: (r) => esc(Portal.fmtDate(r.data)) }, { h: "Presidente", f: (r) => esc(r.presidente || "") }, { h: "Tipo", f: (r) => esc(r.tipo) },
        { h: "Decreto", f: (r) => esc(r.decreto_ref || "—") }, { h: "Resultado", f: (r) => esc(r.resultado || "") },
        { h: "Acórdão", f: (r) => ext(r.source_url, r.acordao_id) }], vt.tc_pedidos_pr)}
        <p class="small muted">Requerente identificado no relatório do acórdão (justica.db). Os pedidos de deputados, do Governo ou dos Representantes da República não entram aqui.</p></section>
      <section class="panel" id="sec-atos"><h2>Todos os atos (${Portal.int(at.total)})</h2>
        <form class="pr-filters" id="pr-f"><input type="search" name="q" placeholder="Pesquisar título, diploma, decreto…" value="${esc(p.q || "")}">
          <select name="tipo"><option value="">Todos os tipos</option>${at.tipos.map((t) => `<option value="${t.tipo}" ${p.tipo === t.tipo ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
          <select name="ano"><option value="">Todos os anos</option>${at.anos.map((y) => `<option ${String(p.ano) === String(y) ? "selected" : ""}>${y}</option>`).join("")}</select>
          <select name="presidente"><option value="">Todos os Presidentes</option>${ov.presidentes.map((x) => `<option ${p.presidente === x.presidente ? "selected" : ""}>${esc(x.presidente)}</option>`).join("")}</select><button class="btn">Filtrar</button></form>
        ${Portal.table([
          { h: "Data", f: (r) => esc(Portal.fmtDate(r.data)) }, { h: "Tipo", f: (r) => tag(r.tipo, r.subtipo) },
          { h: "Ato", f: (r) => `<a href="#/atos-presidente/${encodeURIComponent(r.id)}">${esc((r.diploma_ref ? r.diploma_ref + " — " : "") + (r.titulo || "").slice(0, 150))}</a>` },
          { h: "Presidente", f: (r) => esc(r.presidente || "") }, { h: "Dias", num: 1, f: (r) => (r.dias_aprovacao != null ? r.dias_aprovacao : "") },
          { h: "Iniciativa", f: (r) => (r.iniciativa_key ? `<span class="small">${esc(r.iniciativa_key.replace(/\|/g, " "))}</span>` : "") },
          { h: "Fonte", f: (r) => ext(r.source_url, r.fonte) }], at.rows)}
        ${Portal.pager(at.total, at.page, at.limit, (n) => link({ ...p, page: n }))}</section>
      <section class="panel"><h2>Comunicados do Presidente (presidencia.pt)</h2><p class="small">${L.comunicados_promulgacao.n} comunicados de promulgação desde 2026-03-09 anunciam ${L.comunicados_promulgacao.nd} diplomas; o DRE regista ${L.promulgacoes_dre_desde_mandato} promulgações no mesmo período (Leis, Decretos-Lei e regulamentares; o comunicado pode agrupar diplomas ou incluir resoluções). Os comunicados são guardados como fonte primária mas não contam em duplicado.</p></section>
      <p class="small muted">Fontes: ${ext("https://www.presidencia.pt/atualidade/atividade-legislativa", "presidencia.pt")}, ${ext("https://parlamento.pt/", "parlamento.pt (via módulo votações)")}, ${ext("https://diariodarepublica.pt/", "Diário da República")}, ${ext("https://www.tribunalconstitucional.pt/", "Tribunal Constitucional")}. Atualizado em ${esc(ov.built_at || "—")}.</p>`;
    const f = document.getElementById("pr-f");
    if (f) f.addEventListener("submit", (e) => { e.preventDefault(); const o = Object.fromEntries(new FormData(f)); Portal.go("atos-presidente", "", o); });
  }

  Portal.nav("Atos do Presidente", "#/atos-presidente");
  Portal.page("atos-presidente", async (arg, p) => {
    p = p || {};
    try { if (arg) return await detail(arg); return await main(p); }
    catch (e) { $app.innerHTML = `${css}<div class="pagehead"><div><h1>Atos do Presidente</h1></div></div><p class="note warn">Não foi possível carregar os dados (${esc(String(e.message || e))}).</p>`; }
  });
})();
