"use strict";
/* Votações — #/votacoes (votações recentes com o sentido de voto de cada grupo, pesquisa de iniciativas, concordância entre partidos)
   e #/votacoes/<chave> (percurso completo da iniciativa: entrada → comissão → plenário → promulgação → Diário da República).
   Dados: data/votacoes.db (ingest/jobs/votacoes.py). Fonte: parlamento.pt, páginas públicas "Detalhe da iniciativa". */
(() => {
  const { esc, api, int, fmtDate, qs, table, pager } = Portal;
  const PCOL = { PSD: "#f68a21", "CDS-PP": "#0a6ebd", CH: "#1f2a6e", PS: "#e2478a", IL: "#00a4e4", L: "#8bc34a", PCP: "#c8102e", BE: "#870909", PAN: "#1b8a6b", JPP: "#2e7d32", PEV: "#4caf50" };
  const SLAB = { favor: "A favor", contra: "Contra", abstencao: "Abstenção", ausencia: "Ausente" };
  const PORDER = ["BE", "PCP", "PEV", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS-PP", "CH", "Ninsc"];
  const pidx = (p) => { const i = PORDER.indexOf(p); return i < 0 ? 99 : i; };
  const ext = (u, l) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
  const pc = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  const iniHref = (key) => `#/votacoes/${encodeURIComponent(key)}`;
  const iniLabel = (r) => `${esc(r.tipo)} ${r.numero}/${esc(r.leg)}`;
  const css = `<style id="vot-css">
    .vt-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 14px; } .vt-tabs a { padding:5px 12px; border:1px solid var(--line); border-radius:999px; text-decoration:none; color:var(--ink); background:var(--card); font-size:.9rem }
    .vt-tabs a.on { background:var(--ink); color:var(--card); }
    .vt-filters { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; align-items:center; } .vt-filters input[type=search]{min-width:220px}
    .vt-chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px }
    .vt-chip { display:inline-flex; align-items:center; gap:4px; padding:1px 7px 1px 5px; border-radius:6px; font-size:.78rem; font-weight:600; border:1px solid transparent; line-height:1.5 }
    .vt-chip::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--pc,#5b6475) }
    .vt-favor { background:#dff3e4; color:#14532d; border-color:#9fd5ae } .vt-contra { background:#fde2e2; color:#7f1d1d; border-color:#f3a5a5 }
    .vt-abstencao { background:#fdf1d6; color:#713f12; border-color:#ecc97a } .vt-ausencia { background:transparent; color:var(--muted,#667); border-color:var(--line); border-style:dashed; font-weight:400 }
    .vt-dividido { background:repeating-linear-gradient(135deg,#dff3e4 0 6px,#fde2e2 6px 12px); color:#3b2a00; border-color:#c9b27a }
    .vt-legend { display:flex; gap:8px; flex-wrap:wrap; font-size:.8rem; margin:4px 0 10px }
    .vt-vote { border-top:1px solid var(--line); padding:9px 0 } .vt-vote:first-child { border-top:0 }
    .vt-res { font-weight:700 } .vt-res.ok { color:#15803d } .vt-res.ko { color:#b91c1c } .vt-res.warn { color:#92400e } .vt-warn { color:#92400e }
    .vt-tl { list-style:none; margin:0; padding:0 0 0 18px; border-left:3px solid var(--line) }
    .vt-tl > li { position:relative; margin:0 0 14px; padding-left:10px }
    .vt-tl > li::before { content:""; position:absolute; left:-27px; top:4px; width:13px; height:13px; border-radius:50%; background:var(--card); border:3px solid var(--sc,#8b93a3) }
    .vt-tl time { font-size:.82rem; color:var(--muted,#667); margin-right:6px } .vt-tl .vt-box { margin-top:5px; padding:8px 10px; background:var(--chip,#f3f4f6); border-radius:8px; font-size:.88rem }
    .vt-stages { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:6px; margin:0 0 14px }
    .vt-stages div { padding:8px; border:1px solid var(--line); border-radius:8px; font-size:.82rem; background:var(--card) } .vt-stages div.done { border-color:#9fd5ae; background:#effaf2 } .vt-stages div.ko { border-color:#f3a5a5; background:#fff1f1 }
    .vt-stages div.na { opacity:.5 } .vt-stages b { display:block; font-size:.86rem }
    .vt-matrix td, .vt-matrix th { text-align:center; padding:4px 6px; font-size:.82rem } .vt-matrix td { color:#111 }
    .vt-bar { display:flex; height:12px; border-radius:4px; overflow:hidden; min-width:160px; background:var(--chip) } .vt-bar i { display:block; height:100% }
    @media (prefers-color-scheme: dark) { .vt-favor{background:#123d24;color:#c9f2d6;border-color:#2c6b44} .vt-contra{background:#4a1616;color:#ffd6d6;border-color:#8a3434} .vt-abstencao{background:#463410;color:#fde7b0;border-color:#8a6a23} .vt-stages div.done{background:#123d24} .vt-stages div.ko{background:#4a1616} }
  </style>`;

  const ORD = ["favor", "contra", "abstencao", "ausencia", "dividido"];
  const chip = (p) => p.kind === "dividido"
    ? `<span class="vt-chip vt-dividido" style="--pc:${PCOL[p.partido] || "#5b6475"}" title="${esc(p.partido + ": o grupo aparece em mais do que um sentido de voto na fonte (" + p.senses.map((x) => SLAB[x]).join(" / ") + "); a AR não indica quantos deputados votaram em cada sentido")}">${esc(p.partido)} · dividido: ${esc(p.senses.map((x) => SLAB[x].toLowerCase()).join("/"))}</span>`
    : `<span class="vt-chip vt-${p.sentido}" style="--pc:${PCOL[p.partido] || "#5b6475"}" title="${esc((p.nome ? p.nome + " " : "") + (p.partido || "") + ": " + SLAB[p.sentido])}">${p.kind === "dep" ? esc(p.nome) + " (" + esc(p.partido) + ")" : p.kind === "parcial" ? esc(p.n + " " + p.partido) : esc(p.partido || p.nome)}</span>`;
  const chips = (list) => {
    const out = [], split = new Map();
    for (const p of list || []) {
      if (p.kind !== "dividido") { out.push(p); continue; }
      if (!split.has(p.partido)) { const x = { kind: "dividido", partido: p.partido, sentido: "dividido", senses: [] }; split.set(p.partido, x); out.push(x); }
      const x = split.get(p.partido); if (!x.senses.includes(p.sentido)) x.senses.push(p.sentido);
    }
    for (const x of split.values()) x.senses.sort((a, b) => ORD.indexOf(a) - ORD.indexOf(b));
    const s = out.sort((a, b) => ORD.indexOf(a.sentido) - ORD.indexOf(b.sentido) || (a.kind === "gp" ? 0 : 1) - (b.kind === "gp" ? 0 : 1) || pidx(a.partido) - pidx(b.partido));
    return s.length ? `<div class="vt-chips">${s.map(chip).join("")}</div>` : "";
  };
  const legend = `<div class="vt-legend">${["favor", "contra", "abstencao", "ausencia"].map((s) => `<span class="vt-chip vt-${s}">${SLAB[s]}</span>`).join("")}<span class="muted">· cor do ponto = partido</span></div>`;
  const resCls = (r) => (/^aprovad/i.test(r || "") ? "ok" : /^rejeitad/i.test(r || "") ? "ko" : "");
  const INCONS = "Resultado registado pela Assembleia não coincide com as posições dos partidos — confirmar na fonte";
  // result of one vote; flagged votes (seat arithmetic contradicts the recorded result) never show a plain green/red result
  const resHtml = (v, src) => v.inconsistente === 1
    ? `<span class="vt-res warn" title="${esc(INCONS)}">⚠ ${esc(v.resultado || "—")} (registado)</span> <span class="small vt-warn">${esc(INCONS)}${src ? ` — ${ext(src, "parlamento.pt")}` : ""}.</span>`
    : `<span class="vt-res ${resCls(v.resultado)}">${esc(v.resultado || "—")}</span>`;
  const reqNote = (fase) => (/^(requerimento|processo de urg)/i.test(fase || "") ? ` <span class="tag" title="Votação de um requerimento processual (ex.: dispensa de redação final, baixa sem votação, urgência): o resultado é o do requerimento, não o da iniciativa">requerimento</span>` : "");
  const legEnd = (x) => (x.leg_fim ? ` <span class="tag">Legislatura terminada (${fmtDate(x.leg_fim)})</span>${x.transitou ? ` <span class="tag">transitou para a legislatura seguinte</span>` : ""}` : "");

  function coverageNote(c) {
    if (!c) return "";
    const byLeg = {};
    for (const r of c.by_leg || []) { const x = (byLeg[r.leg] ||= { listed: 0, stored: 0 }); x.listed += r.listed; x.stored += r.stored; }
    const legs = Object.entries(byLeg).map(([l, x]) => `${esc(l)}: ${int(x.stored)} de ${int(x.listed)} iniciativas`).join(" · ");
    const incomplete = Object.values(byLeg).some((x) => x.stored < x.listed);
    return `<p class="note ${incomplete ? "warn" : ""}"><b>Cobertura:</b> ${legs || "—"}; ${int(c.plenary_votes)} votações em plenário e ${int(c.votes - c.plenary_votes)} em comissão, ${int(c.phases)} fases.
      ${c.last_vote ? `Última votação em plenário registada: ${fmtDate(c.last_vote)}.` : ""} ${incomplete ? "<b>Recolha ainda em curso</b> (a fonte limita o ritmo; os números sobem a cada execução)." : ""}
      ${c.checked ? `<br><b>Verificação aritmética:</b> ${int(c.checked)} votações em plenário comparadas com os lugares de cada grupo; ${(c.inconsistent || []).reduce((a, x) => a + x.n, 0)} com resultado registado que não coincide com as posições (${(c.inconsistent || []).map((x) => esc(x.leg) + ": " + x.n).join(", ") || "—"}), assinaladas com ⚠; ${int(c.split_votes || 0)} votações com um grupo “dividido”.` : ""}
      ${(c.closed || []).length ? `<br><b>Legislaturas terminadas:</b> ${c.closed.map((x) => `${esc(x.leg)} (até ${fmtDate(x.leg_fim)}): ${int(x.unfinished)} iniciativas não concluídas${x.carried ? `, ${int(x.carried)} transitaram` : ""}`).join("; ")}.` : ""}
      <br><b>Votos individuais:</b> a Assembleia publica o sentido de voto de cada <i>grupo parlamentar</i>; deputados só são nomeados quando votam de forma diferente do seu grupo (${int(c.individual_votes)} casos registados). Não há votação nominal deputado a deputado.
      <br>Fonte: ${ext(c.source || "https://www.parlamento.pt/ActividadeParlamentar/Paginas/IniciativasLegislativas.aspx", "parlamento.pt — Iniciativas")} e páginas “Detalhe da iniciativa”; os ficheiros oficiais de dados abertos (JSON) da AR estão inacessíveis.${c.updated_at ? ` Atualizado em ${esc(c.updated_at.replace("T", " ").replace("Z", " UTC"))}.` : ""}</p>`;
  }

  const tabs = (cur) => `<div class="vt-tabs">${[["", "Votações recentes"], ["iniciativas", "Iniciativas"], ["partidos", "Como votam os partidos"]].map(([t, l]) => `<a href="#/votacoes${qs({ tab: t })}" class="${(cur || "") === t ? "on" : ""}">${l}</a>`).join("")}</div>`;
  const head = `<div class="pagehead"><div><div class="kicker">Assembleia da República</div><h1>Votações e processo legislativo</h1>
    <p class="lead">Como uma lei é aprovada: da entrada no Parlamento à comissão, ao plenário, à promulgação e ao Diário da República — e como votou cada partido.</p></div></div>`;

  async function votesTab(params, stats) {
    const r = await api("votacoes/votacoes" + qs({ date: params.date, orgao: params.orgao, fase: params.fase, resultado: params.resultado, tipo: params.tipo, leg: params.leg, party: params.party, sense: params.sense, page: params.page }));
    const opt = (name, list, cur) => `<select name="${name}">${list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur || "") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const parties = PORDER.filter((p) => p !== "Ninsc" && p !== "PEV");
    const groups = new Map();
    for (const v of r.rows) { if (!groups.has(v.data)) groups.set(v.data, []); groups.get(v.data).push(v); }
    return `<form class="vt-filters" id="vtf">
        ${opt("orgao", [["", "Plenário"], ["comissao", "Comissões"], ["todos", "Plenário e comissões"]], params.orgao)}
        ${opt("fase", [["", "Todas as fases"], ["generalidade", "Generalidade"], ["especialidade", "Especialidade"], ["final", "Votação final global"]], params.fase)}
        ${opt("resultado", [["", "Qualquer resultado"], ["aprovado", "Aprovado"], ["rejeitado", "Rejeitado"]], params.resultado)}
        ${opt("tipo", [["", "Todos os tipos"], ...stats.tipos.map((t) => [t.tipo, t.tipo])], params.tipo)}
        ${opt("leg", [["", "Todas as legislaturas"], ...stats.legs.map((t) => [t.leg, "Legislatura " + t.leg])], params.leg)}
        ${opt("party", [["", "Partido…"], ...parties.map((p) => [p, p])], params.party)}
        ${opt("sense", [["", "votou…"], ["favor", "a favor"], ["contra", "contra"], ["abstencao", "absteve-se"]], params.sense)}
        <input type="date" name="date" value="${esc(params.date || "")}" aria-label="Data">
        <button class="btn" type="submit">Filtrar</button> <a href="#/votacoes">limpar</a></form>
      ${legend}<p class="muted small">${int(r.total)} votação(ões).</p>
      ${[...groups.entries()].map(([d, vs]) => `<section class="panel"><h3 style="margin:0 0 4px">${fmtDate(d)} <a class="small" href="#/votacoes${qs({ ...params, date: d, page: "" })}">só este dia</a></h3>
        ${vs.map((v) => `<div class="vt-vote"><a href="${iniHref(v.key)}"><b>${iniLabel(v)}</b></a> <span class="muted small">· ${esc(v.fase)}${reqNote(v.fase)}${v.orgao !== "Plenário" ? " · " + esc(v.comissao || v.orgao) : ""}</span>
          · ${resHtml(v, v.source_url)}
          <div class="small">${esc(v.titulo || "")}${v.autoria ? ` <span class="muted">— ${esc(v.autoria)}</span>` : ""}</div>${chips(v.partidos)}</div>`).join("")}</section>`).join("") || `<p class="muted">Sem votações para estes filtros.</p>`}
      ${pager(r.total, r.page, r.limit, (p) => "#/votacoes" + qs({ ...params, page: p }))}`;
  }

  async function iniTab(params) {
    const r = await api("votacoes/search" + qs({ q: params.q, tipo: params.tipo, leg: params.leg, estado: params.estado, origem: params.origem, page: params.page }));
    const opt = (name, list, cur, all) => `<select name="${name}"><option value="">${all}</option>${list.filter((x) => x[name === "leg" ? "leg" : name]).map((x) => { const v = x[name === "leg" ? "leg" : name]; return `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(v)} (${int(x.n)})</option>`; }).join("")}</select>`;
    return `<form class="vt-filters" id="vtf"><input type="hidden" name="tab" value="iniciativas"><input type="search" name="q" placeholder="Título, autor ou número (ex.: 110/XVII)…" value="${esc(params.q || "")}">
        ${opt("tipo", r.facets.tipos, params.tipo, "Todos os tipos")}${opt("leg", r.facets.legs, params.leg, "Todas as legislaturas")}
        ${opt("estado", r.facets.estados, params.estado, "Qualquer estado")}${opt("origem", r.facets.origens, params.origem, "Qualquer origem")}
        <button class="btn" type="submit">Pesquisar</button></form>
      <p class="muted small">${int(r.total)} iniciativa(s).</p>
      ${table([
        { h: "Iniciativa", f: (x) => `<a href="${iniHref(x.key)}"><b>${iniLabel(x)}</b></a><br><span class="small">${esc(x.titulo || "")}</span>` },
        { h: "Autoria", f: (x) => esc(x.autoria || x.origem || "—") },
        { h: "Estado", f: (x) => `${esc(x.estado || "—")}${legEnd(x)}${x.resultado_final ? `<br><span class="small vt-res ${resCls(x.resultado_final)}">VFG: ${esc(x.resultado_final)}</span>` : x.resultado_generalidade ? `<br><span class="small vt-res ${resCls(x.resultado_generalidade)}">Gen.: ${esc(x.resultado_generalidade)}</span>` : ""}` },
        { h: "Última fase", f: (x) => `${esc(x.ultima_fase || "—")}<br><span class="muted small">${x.data_ultima ? fmtDate(x.data_ultima) : ""}</span>` },
        { h: "Votações", num: true, f: (x) => int(x.n_votos) },
      ], r.rows)}
      ${pager(r.total, r.page, r.limit, (p) => "#/votacoes" + qs({ ...params, page: p }))}`;
  }

  function heat(v) { // 0..1 agreement -> red..green
    const h = Math.round(120 * v);
    return `hsl(${h} 65% ${78 - 8 * Math.abs(v - 0.5)}%)`;
  }

  async function partyTab(params, stats) {
    const r = await api("votacoes/partido" + qs({ code: params.code, leg: params.leg, fase: params.fase }));
    const sel = (name, list, cur) => `<select name="${name}">${list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur || "") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const bar = (t) => `<div class="vt-bar" title="${["favor", "contra", "abstencao", "ausencia"].map((s) => `${SLAB[s]} ${t[s]}`).join(" · ")}">${[["favor", "#22a34a"], ["abstencao", "#e0a526"], ["contra", "#d13b3b"], ["ausencia", "#b8bec9"]].map(([s, c]) => `<i style="width:${(100 * t[s]) / t.votes}%;background:${c}"></i>`).join("")}</div>`;
    const P = r.parties;
    let html = `<form class="vt-filters" id="vtf"><input type="hidden" name="tab" value="partidos">
        ${sel("leg", [["", "Todas as legislaturas"], ...stats.legs.map((t) => [t.leg, "Legislatura " + t.leg])], params.leg)}
        ${sel("fase", [["", "Todas as votações em plenário"], ["generalidade", "Só generalidade"], ["final", "Só votação final global"]], params.fase)}
        ${sel("code", [["", "Partido (detalhe)…"], ...P.map((p) => [p, p])], params.code)}
        <button class="btn" type="submit">Ver</button></form>
      <p class="muted small">${esc(r.note)} Base: ${int(r.n_votes)} votações em plenário.</p>
      <h2>Sentido de voto de cada partido</h2>
      ${table([
        { h: "Partido", f: (t) => `<a href="#/votacoes${qs({ ...params, tab: "partidos", code: t.partido })}"><span class="vt-chip vt-ausencia" style="--pc:${PCOL[t.partido] || "#5b6475"}">${esc(t.partido)}</span></a>` },
        { h: "Votações", num: true, f: (t) => int(t.votes) },
        { h: "A favor", num: true, f: (t) => pc(t.favor, t.votes) }, { h: "Contra", num: true, f: (t) => pc(t.contra, t.votes) },
        { h: "Abstenção", num: true, f: (t) => pc(t.abstencao, t.votes) }, { h: "Ausente", num: true, f: (t) => pc(t.ausencia, t.votes) }, { h: "Dividido", num: true, f: (t) => (t.dividido ? pc(t.dividido, t.votes) : "—") },
        { h: "", f: bar },
      ], r.totals)}
      <h2>Concordância entre partidos</h2>
      <p class="muted small">Percentagem das votações em plenário em que os dois grupos votaram no mesmo sentido (só votações em que ambos tinham sentido de voto registado).</p>
      <div class="tblwrap"><table class="tbl vt-matrix"><thead><tr><th></th>${P.map((p) => `<th>${esc(p)}</th>`).join("")}</tr></thead><tbody>
      ${P.map((a) => `<tr><th>${esc(a)}</th>${P.map((b) => { const c = r.matrix[a][b]; if (a === b || !c.both) return `<td class="muted">${a === b ? "—" : "·"}</td>`; const v = c.same / c.both; return `<td style="background:${heat(v)}" title="${esc(a)} e ${esc(b)}: mesmo sentido em ${c.same} de ${c.both} votações">${Math.round(100 * v)}%</td>`; }).join("")}</tr>`).join("")}
      </tbody></table></div>`;
    if (r.party && r.summary) {
      html += `<h2>${esc(r.party)} — últimas votações</h2>${legend}
        ${table([{ h: "Data", f: (x) => fmtDate(x.data) }, { h: "Iniciativa", f: (x) => `<a href="${iniHref(x.key)}">${iniLabel(x)}</a><br><span class="small">${esc(x.titulo || "")}</span>` },
          { h: "Fase", f: (x) => esc(x.fase) }, { h: "Resultado", f: (x) => `<span class="vt-res ${resCls(x.resultado)}">${esc(x.resultado || "")}</span>` },
          { h: r.party, f: (x) => chip({ partido: r.party, sentido: x.sentido, kind: "gp" }) }], r.recent)}
        <h3>Deputados do ${esc(r.party)} que votaram diferente do grupo</h3>
        ${r.dissent.length ? table([{ h: "Data", f: (x) => fmtDate(x.data) }, { h: "Deputado(s)", f: (x) => esc(x.nome || "") }, { h: "Sentido", f: (x) => SLAB[x.sentido] },
          { h: "Iniciativa", f: (x) => `<a href="${iniHref(x.key)}">${iniLabel(x)}</a> <span class="small">${esc(x.fase)}</span>` }], r.dissent) : `<p class="muted">Nenhum caso nos dados recolhidos.</p>`}`;
    }
    return html;
  }

  async function mainPage(params) {
    $app.innerHTML = css + head + `<p class="muted">A carregar…</p>`;
    const stats = await api("votacoes/stats");
    if (!stats.available) { $app.innerHTML = css + head + `<p class="note warn">${esc(stats.error)}</p>`; return; }
    const tab = params.tab || "";
    const body = tab === "iniciativas" ? await iniTab(params) : tab === "partidos" ? await partyTab(params, stats) : await votesTab(params, stats);
    $app.innerHTML = css + head + coverageNote(stats.coverage) + tabs(tab) + body;
    const f = document.getElementById("vtf");
    if (f) f.onsubmit = (e) => { e.preventDefault(); const o = { tab }; for (const [k, v] of new FormData(f)) if (v) o[k] = String(v).trim(); Portal.go("votacoes", "", o); };
  }

  /* ---------- one initiative ---------- */
  const STAGES = [
    ["Entrada", (f) => /entrada|admiss/i.test(f.fase)],
    ["Comissão", (f) => /baixa comiss|parecer|relat|nova apreciação/i.test(f.fase) || !!f.comissao],
    ["Generalidade", (f) => /generalidade/i.test(f.fase) && f.votos.some((v) => v.orgao === "Plenário")],
    ["Especialidade", (f) => /especialidade/i.test(f.fase)],
    ["Votação final global", (f) => /final global|vota[çc][ãa]o delibera/i.test(f.fase)],
    ["Redação final / Decreto", (f) => /reda[çc][ãa]o final|decreto da assembleia|publicação dar/i.test(f.fase)],
    ["Presidente (promulgação/veto)", (f) => /promulga|veto|presidente da rep|tribunal constitucional/i.test(f.fase)],
    ["Diário da República", (f) => /publicação dr|\(publicação dr\)/i.test(f.fase) || (f.publicacoes || []).some((p) => p.startsWith("[DR"))],
  ];
  const stageColor = (f) => (f.votos.some((v) => /rejeitad/i.test(v.resultado || "")) && f.votos.some((v) => v.orgao === "Plenário") ? "#d13b3b" : f.votos.length ? "#22a34a" : /publicação dr/i.test(f.fase) ? "#0a6ebd" : /veto|rejei|caduc|retira/i.test(f.fase) ? "#d13b3b" : "#8b93a3");

  const seatBar = (v, seats) => {
    if (!seats || !v.partidos) return "";
    const tot = {}; let known = 0, split = 0;
    for (const p of v.partidos) {
      if (p.kind !== "gp") continue;
      const n = seats[p.partido]; if (!n) continue;
      if (tot[p.partido] && tot[p.partido] !== p.sentido) { split++; continue; }
      tot[p.partido] = p.sentido;
    }
    const by = { favor: 0, contra: 0, abstencao: 0, ausencia: 0 };
    for (const [pt, s] of Object.entries(tot)) { by[s] += seats[pt]; known += seats[pt]; }
    const all = Object.values(seats).reduce((a, b) => a + b, 0);
    if (!known || split) return "";
    const col = { favor: "#22a34a", abstencao: "#e0a526", contra: "#d13b3b", ausencia: "#8b93a3" };
    const rest = all - known;
    return `<div class="small" style="margin:.3rem 0"><div class="vt-bar" style="min-width:260px" title="${SENSES_L.map((s) => SLAB[s] + " " + by[s]).join(" · ")}">${["favor", "abstencao", "contra", "ausencia"].map((s) => by[s] ? `<i style="width:${by[s] / all * 100}%;background:${col[s]}"></i>` : "").join("")}${rest ? `<i style="width:${rest / all * 100}%;background:transparent"></i>` : ""}</div>
      <span class="muted">Lugares na legislatura: ${["favor", "contra", "abstencao"].map((s) => `${SLAB[s]} ${by[s]}`).join(" · ")}${by.ausencia ? ` · ${SLAB.ausencia} ${by.ausencia}` : ""} (de ${all}; votos individuais dentro de cada grupo não contados)</span></div>`;
  };
  const SENSES_L = ["favor", "contra", "abstencao", "ausencia"];
  const presNote = (pr) => {
    if (!pr) return "";
    const li = [];
    for (const a of pr.atos.filter((x) => !(x.tipo === "veto" && pr.vetos.length))) li.push(`<li><b>${a.tipo === "promulgacao" ? "Promulgação" : esc(a.tipo || "Ato do Presidente")}</b> · ${fmtDate(a.data)} · ${esc(a.presidente || "")}${a.diploma_ref ? " · " + esc(a.diploma_ref) : ""} ${a.source_url ? ext(a.source_url, "fonte") : ""}</li>`);
    for (const v of pr.vetos) li.push(`<li><b>Veto</b> · ${fmtDate(v.data)} · ${esc(v.presidente || "")}${v.desfecho ? " · desfecho: " + esc(v.desfecho) + (v.desfecho_data ? " (" + fmtDate(v.desfecho_data) + ")" : "") : ""} ${v.mensagem_url ? ext(v.mensagem_url, "mensagem") : v.source_url ? ext(v.source_url, "fonte") : ""}</li>`);
    return li.length ? `<h2>Presidente da República</h2><ul>${li.join("")}</ul>` : "";
  };

  async function iniPage(arg) {
    $app.innerHTML = css + `<p class="muted">A carregar…</p>`;
    const r = await api("votacoes/iniciativa" + (/^\d+$/.test(arg) ? "?bid=" + arg : "?key=" + encodeURIComponent(arg)));
    const back = `<a class="back" href="#/votacoes">← Votações</a>`;
    if (!r.available) { $app.innerHTML = css + back + `<p class="note warn">${esc(r.error)}</p>`; return; }
    if (r.error) { $app.innerHTML = css + back + `<h1>${esc(arg.replace(/\|/g, " "))}</h1><p class="note warn">${esc(r.error)}</p>${coverageNote(r.coverage)}<p><a href="#/leis/${encodeURIComponent(arg)}">Ver na página “Leis em curso” →</a></p>`; return; }
    const i = r.iniciativa, F = r.fases;
    const stage = STAGES.map(([name, test]) => {
      const hits = F.filter(test);
      const ko = hits.some((f) => f.votos.some((v) => v.orgao === "Plenário" && /rejeitad/i.test(v.resultado || "")));
      const last = hits[hits.length - 1];
      return `<div class="${hits.length ? (ko ? "ko" : "done") : "na"}"><b>${esc(name)}</b>${hits.length ? `${ko ? "✗" : "✓"} ${last && last.data ? fmtDate(last.data) : ""}` : "—"}</div>`;
    }).join("");
    const plen = F.flatMap((f) => f.votos.filter((v) => v.orgao === "Plenário"));
    const autores = i.autores.length ? i.autores.map((a) => `<a href="#/deputados/${a.bid}">${esc(a.nome)}</a>${a.partido ? ` <span class="muted small">(${esc(a.partido)})</span>` : ""}`).join(", ") : esc(i.autoria || "—");
    const vote = (v) => `<div class="vt-box"><b>${v.orgao === "Plenário" ? "Votação em plenário" : "Votação em comissão"}</b> · ${esc(v.reuniao || "")}
        · ${resHtml(v, i.source_url)}${chips(v.partidos)}${v.detalhe ? `<div class="small muted">Texto da fonte: ${esc(v.detalhe)}</div>` : ""}</div>`;
    $app.innerHTML = css + back + `
      <div class="pagehead"><div><div class="kicker">${esc(i.tipo)} · Legislatura ${esc(i.leg)}${i.sessao ? ` · ${i.sessao}.ª sessão` : ""} · ${esc(i.origem || "")}</div>
        <h1>${esc(i.tipo)} n.º ${i.numero}/${esc(i.leg)}</h1><p class="lead">${esc(i.titulo || "")}</p></div></div>
      <div class="kpis"><div class="kpi"><b>${plen.some((v) => v.inconsistente === 1 && v.resultado === i.resultado_final && v.data === i.data_votacao_final) ? "⚠ " + esc(i.estado || "—") + " (a confirmar)" : esc(i.estado || "—")}</b><span>estado (derivado das fases publicadas)</span></div>
        <div class="kpi"><b>${int(plen.length)}</b><span>votações em plenário</span></div>
        <div class="kpi"><b>${i.data_entrada ? fmtDate(i.data_entrada) : "—"}</b><span>entrada</span></div>
        <div class="kpi"><b>${r.dre ? fmtDate(r.dre.date) : i.dr_date ? fmtDate(i.dr_date) : "—"}</b><span>publicação no Diário da República${r.dre || !i.dr_date ? "" : " (data da fase na AR)"}</span></div></div>
      <p><b>Autoria:</b> ${autores}</p>
      <p class="small">${ext(i.source_url, "Página oficial da iniciativa (parlamento.pt)")}${r.portal ? ` · <a href="#/leis/${encodeURIComponent(i.key)}">Agenda do Parlamento para esta iniciativa (Leis em curso)</a>` : ""}
        ${r.dre ? ` · Publicado como <a href="#/dre/${encodeURIComponent(r.dre.id)}">${esc(r.dre.kind)} n.º ${esc(r.dre.number)}</a> ${ext(r.dre.url, "DRE")}` : i.dr_ref ? ` · ${esc(i.dr_ref)}${i.lei_ref ? " · " + esc(i.lei_ref) : ""} <span class="muted">(sem ligação ao ato no DRE: ${/\d+\/\d{4}/.test(i.lei_ref || "") ? "ato não encontrado na base DRE local" : "a fonte não indica o número do ato"})</span>` : ""}</p>
      ${i.leg_fim ? `<p class="note">${legEnd(i)} ${i.transitou ? "Iniciativa das assembleias legislativas regionais ou de cidadãos: não caduca com o fim da legislatura e continuou a ser tramitada." : "Fases e estado referem-se apenas ao período da legislatura."}</p>` : ""}
      <h2>Em que fase está</h2><div class="vt-stages">${stage}</div>
      ${plen.length ? `<h2>Como votaram os partidos (plenário)</h2>${legend}${plen.map((v) => `<div class="vt-vote"><b>${esc(v.fase)}</b>${reqNote(v.fase)} · ${fmtDate(v.data)} · ${resHtml(v, i.source_url)}${seatBar(v, r.seats)}${chips(v.partidos)}</div>`).join("")}` : `<p class="note">Ainda sem votação em plenário registada pela Assembleia para esta iniciativa.</p>`}
      ${presNote(r.presidencia)}
      <h2>Percurso completo</h2>
      <ol class="vt-tl">${F.map((f) => `<li style="--sc:${stageColor(f)}"><time>${f.data ? fmtDate(f.data) : "s/ data"}</time><b>${esc(f.fase)}</b>
        ${f.comissao ? `<div class="small">${esc(f.comissao)}${f.competente ? " <span class='muted'>(comissão competente)</span>" : ""}</div>` : ""}
        ${f.relatores.length ? `<div class="small">Relator(a): ${f.relatores.map((x) => `<a href="#/deputados/${x.dep_bid}">${esc(x.nome)}</a>${x.partido ? ` (${esc(x.partido)})` : ""}${x.motivo ? ` <span class="muted">${esc(x.motivo)}</span>` : ""}`).join(", ")}</div>` : ""}
        ${f.obs ? `<div class="small muted">${esc(f.obs)}</div>` : ""}
        ${f.texto_tipo || f.texto_titulo ? `<div class="small">${esc(f.texto_tipo || "")}${f.texto_titulo ? ": " + esc(f.texto_titulo) : ""}</div>` : ""}
        ${f.conjuntas.length ? `<div class="small muted">Discussão conjunta com: ${f.conjuntas.map((c) => c.key ? `<a href="${iniHref(c.key)}">${esc(c.numero)}</a>` : esc(c.numero)).join(", ")}</div>` : ""}
        ${f.publicacoes.length ? `<div class="small muted">${f.publicacoes.map(esc).join("<br>")}</div>` : ""}
        ${f.votos.map(vote).join("")}</li>`).join("")}</ol>
      <p class="muted small">${esc(r.note)} Estado derivado automaticamente das fases publicadas; em caso de dúvida prevalece a página oficial.</p>`;
  }

  Portal.page("votacoes", async (arg, params) => (arg ? iniPage(arg) : mainPage(params || {})));
  Portal.nav("Votações", "#/votacoes");

  /* #/leis/<chave> is a core page: add a link to the full process once it has rendered (no core file is edited). */
  async function decorateLaw() {
    const m = location.hash.match(/^#\/leis\/([^?]+)/);
    if (!m) return;
    const key = decodeURIComponent(m[1]);
    let r;
    try { r = await api("votacoes/iniciativa?key=" + encodeURIComponent(key)); } catch { return; }
    if (!r || !r.iniciativa) return;
    for (let k = 0; k < 40; k++) { // wait for the core page to render
      const h1 = $app.querySelector("h1");
      if (h1 && !$app.querySelector("#vt-law-link") && location.hash.startsWith("#/leis/")) {
        const i = r.iniciativa, plen = r.fases.flatMap((f) => f.votos.filter((v) => v.orgao === "Plenário"));
        const lastV = plen[plen.length - 1];
        h1.insertAdjacentHTML("afterend", `${css}<p class="note" id="vt-law-link"><b>Processo legislativo oficial:</b> ${esc(i.estado || "")} · ${int(r.fases.length)} fases, ${int(plen.length)} votações em plenário.
          ${lastV ? `Última: ${esc(lastV.fase)} (${fmtDate(lastV.data)}) — ${resHtml(lastV, i.source_url)}${chips(lastV.partidos)}` : ""}
          <a href="${iniHref(i.key)}">Ver percurso completo e votos por partido →</a></p>`);
        return;
      }
      if (h1 && $app.querySelector("#vt-law-link")) return;
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  window.addEventListener("hashchange", decorateLaw);
  decorateLaw();
})();
