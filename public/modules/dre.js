"use strict";
/* Diário da República — #/dre (search + recent série I) and #/dre/<id> (act lineage: origin -> amendments -> current form). */
(() => {
  const { esc, api, fmtDate, qs } = Portal;
  const DRE_HOME = "https://diariodarepublica.pt/dr/home";
  const REL = {
    altera: ["altera", "#1c3359"], revoga: ["revoga", "#a4122b"], republica: ["republica", "#0b5d46"], retifica: ["retifica", "#8a5a00"],
    regulamenta: ["regulamenta", "#5b6475"], prorroga: ["prorroga", "#5b6475"], suspende: ["suspende", "#a4122b"], aprova: ["aprova", "#5b6475"],
    autoriza: ["autoriza", "#5b6475"], interpreta: ["interpreta", "#5b6475"], executa: ["executa", "#5b6475"],
    declara_inconstitucional: ["declara inconstitucional", "#a4122b"], refere: ["refere", "#8b93a3"],
  };
  const relChip = (r) => { const [l, c] = REL[r] || [r, "#5b6475"]; return `<span class="chip dot" style="--c:${c}">${esc(l)}</span>`; };
  const actLink = (a, label) => `<a href="#/dre/${esc(a.id)}">${esc(label || a.title || `${a.kind || ""} ${a.number || ""}`)}</a>`;
  const ext = (url, label) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "");
  const css = `<style id="dre-css">
    .dre-tl { list-style: none; margin: 1rem 0 0; padding: 0 0 0 22px; border-left: 3px solid var(--line); }
    .dre-tl > li { position: relative; padding: 0 0 22px 16px; }
    .dre-tl > li::before { content: ""; position: absolute; left: -32px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--c, var(--navy2)); border: 3px solid var(--paper); box-shadow: 0 0 0 1px var(--line); }
    .dre-tl > li.origin::before { --c: var(--accent); width: 20px; height: 20px; left: -34px; }
    .dre-tl > li.current::before { --c: var(--card); border-color: var(--accent); width: 20px; height: 20px; left: -34px; }
    .dre-tl > li.pending::before { background: var(--paper); border-color: var(--warn); }
    .dre-tl .when { font: 600 .78rem system-ui; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .dre-tl h3 { margin: .15rem 0 .25rem; font-size: 1.05rem; }
    .dre-tl .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
    .dre-tl details { margin-top: .4rem; } .dre-tl summary { cursor: pointer; color: var(--accent); font-size: .88rem; }
    .dre-tl .arts { margin: .4rem 0 0; padding-left: 1.1rem; font-size: .88rem; } .dre-tl .arts li { margin: .15rem 0; }
    .dre-day h3 { font-size: 1rem; margin: 1.2rem 0 .3rem; border-bottom: 1px solid var(--line); padding-bottom: .3rem; }
    .dre-act { padding: 8px 0; border-bottom: 1px solid var(--line2); } .dre-act > a { font-weight: 700; } .dre-act p { margin: .2rem 0; font-size: .92rem; }
    .dre-act .who { font-size: .8rem; color: var(--muted); }
    .dre-meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: .92rem; margin: 0; } .dre-meta dt { color: var(--muted); } .dre-meta dd { margin: 0; }
    .dre-form { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; } .dre-form input[type=search] { flex: 1 1 260px; } .dre-form select { max-width: 260px; }
    .dre-cols { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) 300px; align-items: start; } @media (max-width: 900px) { .dre-cols { grid-template-columns: 1fr; } }
    .dre-text { white-space: pre-line; font-size: .9rem; max-height: 340px; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  </style>`;
  const addCss = () => { if (!document.getElementById("dre-css")) document.head.insertAdjacentHTML("beforeend", css); };
  const relsLine = (rels) => (rels || []).filter((r) => r.relation !== "refere").slice(0, 4).map((r) => `${relChip(r.relation)}<a href="#/dre/${esc(r.dst_id)}">${esc(r.dst_label)}</a>`).join(" ");
  const actRow = (a) => `<div class="dre-act">${actLink(a)} <span class="tag">${esc(a.kind || "")}</span>
      <p>${esc(a.summary || "")}</p>
      <div class="who">${esc(a.issuer || "")}${a.proponent && a.proponent !== a.issuer ? ` · proposta: ${esc(a.proponent)}` : ""} · ${fmtDate(a.date)}
        ${a.n_amendments > 1 ? ` · <b>${a.n_amendments - 1} alteraç${a.n_amendments - 1 === 1 ? "ão" : "ões"}</b>` : ""} ${a.in_window === 0 ? " · <i>anterior ao período</i>" : ""}</div>
      ${a.relations && a.relations.length ? `<div class="who" style="margin-top:3px">${relsLine(a.relations)}</div>` : ""}</div>`;

  /* ------------------------------------------------------------ list / search page */
  async function listPage(params) {
    addCss();
    const meta = await api("dre/meta");
    if (!meta.available) { $app.innerHTML = `<p class="note warn">${esc(meta.error)}</p>`; return; }
    const m = meta.meta, q = params.q || "", type = params.type || "", year = params.year || "", issuer = params.issuer || "", page = Number(params.page || 1);
    const searching = q || type || year || issuer;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
    $app.innerHTML = `<div class="pagehead"><div><div class="kicker">Diário da República · 1.ª série</div><h1>Leis, decretos e o que lhes acontece depois</h1>
      <p class="lead">Cada ato publicado, quem o emitiu e propôs, que outras leis altera ou revoga — e, para leis consolidadas, todas as alterações artigo a artigo até à versão em vigor.</p></div></div>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(+m.acts_in_window)}</b><span>atos da 1.ª série desde ${fmtDate(m.window_start)}</span></div>
        <div class="kpi"><b>${Portal.int(+m.links)}</b><span>relações (altera, revoga…)</span></div>
        <div class="kpi"><b>${Portal.int(+m.consolidated)}</b><span>leis com versão consolidada</span></div>
        <div class="kpi"><b>${Portal.int(+m.amendments)}</b><span>alterações registadas na consolidação</span></div>
      </div>
      <form class="dre-form" id="dreform">
        <input type="search" name="q" value="${esc(q)}" placeholder="Pesquisar: «arrendamento», «Lei n.º 7/2009», «DL 102-D/2020»…" aria-label="Pesquisar atos">
        <select name="type" aria-label="Tipo"><option value="">Todos os tipos</option>${meta.types.map((t) => opt(t.kind, `${t.kind} (${t.n})`, type)).join("")}</select>
        <select name="year" aria-label="Ano"><option value="">Todos os anos</option>${meta.years.map((y) => opt(String(y.year), String(y.year), year)).join("")}</select>
        <select name="issuer" aria-label="Emissor / ministério"><option value="">Todos os emissores</option>${meta.issuers.map((i) => opt(i.issuer, `${i.issuer} (${i.n})`, issuer)).join("")}</select>
        <button class="btn">Pesquisar</button>${searching ? ` <a class="btn" href="#/dre">Limpar</a>` : ""}
      </form><div id="dreres"><p class="muted">A carregar…</p></div>
      <p class="note small">Fonte: <a href="${DRE_HOME}" target="_blank" rel="noopener">Diário da República Eletrónico</a> (INCM), serviços públicos do próprio site. Relações «altera/revoga» são lidas das hiperligações do sumário oficial (verbo inferido);
      a cronologia artigo a artigo vem da legislação consolidada oficial. Atualizado ${esc((m.updated || "").replace("T", " "))}.</p>
      <p class="note warn small">Indisponível: a «Análise Jurídica» do DRE (listas completas «alterado por / revoga») exige conta registada, e o separador «Parlamento» (votações) devolve erro 504 — por isso as votações só aparecem quando o portal tem os dados do Parlamento.</p>`;
    document.getElementById("dreform").addEventListener("submit", (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      Portal.go("dre", "", { q: f.get("q"), type: f.get("type"), year: f.get("year"), issuer: f.get("issuer") });
    });
    const el = document.getElementById("dreres");
    if (searching) {
      const r = await api("dre/search" + qs({ q, type, year, issuer, page }));
      el.innerHTML = `<p class="muted small">${Portal.int(r.total)} atos</p>${r.rows.map(actRow).join("") || '<p class="empty">Sem resultados.</p>'}
        ${Portal.pager(r.total, r.page, r.limit, (p) => "#/dre" + qs({ q, type, year, issuer, page: p }))}`;
    } else {
      const r = await api("dre/recent?days=6");
      el.innerHTML = `<h2>Publicações recentes</h2>` + r.days.map((d) => `<div class="dre-day"><h3>${fmtDate(d.date)} · ${d.acts.length} atos</h3>${d.acts.map(actRow).join("")}</div>`).join("");
    }
  }

  /* ------------------------------------------------------------ act page */
  const changesList = (changes) => {
    const real = (changes || []).filter((c) => c.fragment || c.heading);
    if (!real.length) return "";
    return `<details><summary>${real.length} disposiç${real.length === 1 ? "ão" : "ões"} alterada${real.length === 1 ? "" : "s"}</summary><ul class="arts">${real.map((c) =>
      `<li><b>${esc(c.type || "")}</b> ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.fragment || "")}</a>` : esc(c.fragment || "")}${c.heading ? ` — ${esc(c.heading)}` : ""}${c.in_force ? ` <span class="muted small">(em vigor ${fmtDate(c.in_force)})</span>` : ""}</li>`).join("")}</ul></details>`;
  };
  const whoLine = (e) => [e.issuer, e.proponent && e.proponent !== e.issuer ? `proposta de ${e.proponent}` : "", e.government, e.legislature ? `${e.legislature} Legislatura` : ""].filter(Boolean).map(esc).join(" · ");

  async function actPage(id) {
    addCss();
    const d = await api("dre/act?id=" + encodeURIComponent(id)).catch(() => null);
    if (!d || !d.act) { $app.innerHTML = `<a class="back" href="#/dre">← Diário da República</a><p class="note warn">Ato não encontrado na base local (só existem atos da 1.ª série desde o início do período recolhido e os que estes referem).</p>`; return; }
    const a = d.act, st = d.status, L = d.links;
    const status = st.revoked_by.length ? `<span class="tag red">Revogado</span>` : st.unconstitutional_by.length ? `<span class="tag red">Norma declarada inconstitucional</span>`
      : a.vigencia ? `<span class="tag">${esc(a.vigencia === "VIGENTE" ? "Em vigor" : a.vigencia)}</span>` : "";
    const origin = `<li class="origin"><div class="when">Origem · ${fmtDate(a.date)}</div><div class="card">
        <h3>${esc(a.title || "")}</h3><p>${esc(a.summary || "")}</p>
        <dl class="dre-meta">
          ${a.issuer ? `<dt>Emissor</dt><dd>${esc(a.issuer)}</dd>` : ""}
          ${a.proponent ? `<dt>Proponente</dt><dd>${esc(a.proponent)}</dd>` : ""}
          ${a.government ? `<dt>Governo</dt><dd>${esc(a.government)}</dd>` : ""}
          ${a.legislature ? `<dt>Origem parlamentar</dt><dd>Assembleia da República, ${esc(a.legislature)} Legislatura</dd>` : ""}
          ${a.approved ? `<dt>Aprovado</dt><dd>${fmtDate(a.approved)}${a.issuer && /Conselho de Ministros/.test(a.issuer) ? " (Conselho de Ministros)" : ""}</dd>` : ""}
          ${a.promulgated ? `<dt>Promulgado</dt><dd>${fmtDate(a.promulgated)}</dd>` : ""}
          ${a.signatories.length ? `<dt>Assinaturas</dt><dd>${a.signatories.map(esc).join(", ")}</dd>` : ""}
          ${a.dr_title ? `<dt>Publicação</dt><dd>${L.diario ? ext(L.diario, a.dr_title) : esc(a.dr_title)}</dd>` : ""}
        </dl></div></li>`;
    const events = d.later.map((e) => `<li class="${e.pending_consolidation ? "pending" : ""}" style="--c:${(REL[e.relations[0]] || [, "#1c3359"])[1]}">
        <div class="when">${fmtDate(e.date)}</div><div class="card">
        <h3>${actLink(e, e.title || `${e.kind} n.º ${e.number}`)} ${e.relations.map(relChip).join("")}</h3>
        ${e.summary ? `<p>${esc(e.summary)}</p>` : ""}
        ${whoLine(e) ? `<div class="muted small">${whoLine(e)}</div>` : ""}
        ${changesList(e.changes)}
        ${e.pending_consolidation ? `<p class="small" style="color:var(--warn)">Ainda não integrado na versão consolidada oficial.</p>` : ""}
        ${!e.official ? `<p class="muted small">Relação lida do sumário oficial do ato.</p>` : ""}
      </div></li>`).join("");
    const current = `<li class="current"><div class="when">Hoje · forma atual</div><div class="card">
        <h3>${status || (st.n_changes ? "Estado de vigência não indicado pelo DRE" : "Texto original, sem alterações conhecidas")}</h3>
        ${st.consolidated ? `<p>Versão consolidada oficial ${st.consolidated.as_of ? `atualizada a <b>${fmtDate(st.consolidated.as_of)}</b>` : ""}: ${ext(st.consolidated.url, "ler texto consolidado")} ${st.consolidated.eli ? ` · ${ext(st.consolidated.eli, "ELI")}` : ""}</p>`
          : `<p class="muted">${a.has_consolidated === 0 ? "O DRE não publica versão consolidada deste ato — o texto em vigor é o original com as alterações acima." : "Sem versão consolidada conhecida."}</p>`}
        <p class="small">${st.n_changes} alteraç${st.n_changes === 1 ? "ão" : "ões"} desde a publicação${st.revoked_by.length ? ` · revogado por ${st.revoked_by.map((r) => actLink(r)).join(", ")}` : ""}</p>
      </div></li>`;
    const affects = d.affects.filter((x) => x.relations.some((r) => r !== "refere") || x.official);
    const refs = d.affects.filter((x) => !affects.includes(x));
    const ini = d.initiatives.map((i) => `<div class="card" style="margin-bottom:8px"><b><a href="#/leis/${encodeURIComponent(i.initiative_key)}">${esc(i.initiative_key.replace(/\|/g, " ").replace(/ (\d+) /, " n.º $1/"))}</a></b>
        ${i.initiative ? `<p>${esc(i.initiative.title || "")}</p>` : ""}<p class="muted small">Ligação por ${esc(i.method)}${i.score < 1 ? ` (semelhança ${Math.round(i.score * 100)}%)` : ""}.</p>
        ${i.votes.length ? `<table><tr><th>Data</th><th>Resultado</th><th>A favor</th><th>Contra</th><th>Abstenção</th></tr>${i.votes.map((v) => `<tr><td>${fmtDate(v.date)}</td><td>${esc(v.result)}</td><td>${esc(v.favor)}</td><td>${esc(v.against)}</td><td>${esc(v.abstention)}</td></tr>`).join("")}</table>`
          : `<p class="note small">Votação nominal ainda não disponível: os dados abertos do Parlamento estão inacessíveis.</p>`}</div>`).join("");
    $app.innerHTML = `<a class="back" href="#/dre">← Diário da República</a>
      <div class="pagehead"><div><div class="kicker">${esc(a.kind || "Ato")} · ${fmtDate(a.date)}</div><h1>${esc(a.title || "")}</h1><p class="lead">${esc(a.summary || "")}</p>
        <p>${status} ${a.in_window === 0 ? `<span class="tag">anterior ao período recolhido</span>` : ""}</p></div>
        <div class="toolbar">${ext(L.dre, "Texto no DRE")} ${ext(L.pdf, "PDF")} ${ext(L.eli, "ELI")} ${ext(L.consolidated, "Consolidado")}</div></div>
      <div class="dre-cols"><div>
        <section class="panel"><h2>Percurso: origem → alterações → forma atual</h2><ol class="dre-tl">${origin}${events}${current}</ol></section>
        ${affects.length ? `<section class="panel"><h2>O que este ato muda noutras leis</h2>${affects.map((x) => `<div class="dre-act">${x.relations.map(relChip).join("")} ${actLink(x, x.title || x.label)}
            ${x.date ? `<span class="muted small">(${fmtDate(x.date)})</span>` : ""}${changesList(x.changes)}</div>`).join("")}</section>` : ""}
        ${a.text_excerpt ? `<section class="panel"><h2>Início do texto</h2><div class="dre-text">${esc(a.text_excerpt)}${a.text_length > a.text_excerpt.length ? "\n…" : ""}</div><p class="small">${ext(L.dre, "Texto integral no Diário da República")}</p></section>` : ""}
      </div><aside>
        ${d.initiatives.length ? `<section class="panel"><h2>Iniciativa parlamentar</h2>${ini}</section>` : a.legislature ? `<section class="panel"><h2>Iniciativa parlamentar</h2><p class="muted small">Sem correspondência automática com as iniciativas conhecidas pelo portal.</p></section>` : ""}
        ${d.rectifications.length ? `<section class="panel"><h2>Retificações</h2>${d.rectifications.map((r) => `<p>${actLink(r, r.label)}</p>`).join("")}</section>` : ""}
        ${refs.length ? `<section class="panel"><h2>Atos referidos no sumário</h2>${refs.map((x) => `<p>${actLink(x, x.title || x.label)}</p>`).join("")}</section>` : ""}
        <section class="panel"><h2>Fontes</h2><ul class="small">
          <li>${ext(L.dre, "Diário da República — ato original")}</li>${L.consolidated ? `<li>${ext(L.consolidated, "Legislação consolidada (DRE)")}</li>` : ""}
          ${L.eli ? `<li>${ext(L.eli, "Identificador ELI")}</li>` : ""}${L.parliament_tab ? `<li>${ext(L.parliament_tab, "Trabalhos parlamentares (DRE)")}</li>` : ""}</ul></section>
      </aside></div>`;
  }

  Portal.page("dre", async (arg, params) => (arg ? actPage(arg) : listPage(params || {})));
  Portal.nav("Diário da República", "#/dre");
})();
