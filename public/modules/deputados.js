"use strict";
/* Deputados — #/deputados (lista, filtro por partido, pesquisa, banner de cobertura) e #/deputados/<id> (perfil).
   Dados: data/deputados.db (ingest/jobs/deputados.py). Fonte: páginas públicas de parlamento.pt. */
(() => {
  const { esc, api, int, fmtDate, qs, table } = Portal;
  const PCOL = { PSD: "#f48a1f", "B.E.": "#a00000", "CDS–PP": "#0073c2", CH: "#202056", PS: "#e8537a", IL: "#00a7e6", L: "#8bc34a", PCP: "#c8102e", "CDS-PP": "#0073c2", BE: "#a00000", PAN: "#00778b", JPP: "#7a5195" };
  const dot = (p) => `<span class="chip dot" style="--c:${PCOL[p] || "#5b6475"}">${esc(p || "—")}</span>`;
  const ext = (u, l) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
  const pct = (a, b, d = 1) => (b ? (100 * a / b).toFixed(d).replace(".", ",") + "%" : "—");
  const css = `<style id="dep-css">
    .dep-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; align-items: center; }
    .dep-filters input[type=search] { min-width: 220px; }
    .dep-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
    .dep-pills a { text-decoration: none; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: .84rem; color: var(--ink); background: var(--card); }
    .dep-pills a.on { background: var(--ink); color: var(--card); }
    .dep-bar { height: 8px; background: var(--chip); border-radius: 4px; overflow: hidden; min-width: 70px; } .dep-bar i { display: block; height: 100%; background: var(--accent); }
    .dep-att { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 8px; } .dep-att i { width: 9px; height: 14px; border-radius: 2px; background: var(--ok, #2e8b57); }
    .dep-att i.amp { background: #8b93a3; } .dep-att i.f { background: var(--alert, #a4122b); }
  </style>`;

  function banner(c) {
    const missing = [];
    if (c.listed < c.seats) missing.push(`<b>${c.seats - c.listed}</b> lugares não identificados`);
    if (c.detailed < c.listed) missing.push(`biografia/comissões em falta para <b>${c.listed - c.detailed}</b> deputados`);
    if (c.with_attendance < c.listed) missing.push(`presenças em falta para <b>${c.listed - c.with_attendance}</b>`);
    const full = c.listed >= c.seats && !missing.length;
    return `<p class="note ${full ? "" : "warn"}"><b>Cobertura:</b> ${int(c.listed)} de ${int(c.seats)} deputados listados (${c.declared_by_source ? `a fonte declara ${int(c.declared_by_source)} em funções` : "fonte sem total declarado"});
      presenças em plenário para ${int(c.with_attendance)}${c.last_meeting ? `, até à reunião de ${fmtDate(c.last_meeting)}` : ""}; iniciativas apresentadas para ${int(c.with_initiatives)} deputados com pelo menos uma.
      ${missing.length ? "<br><b>Em falta:</b> " + missing.join("; ") + "." : ""}
      <br><b>Votos individuais:</b> não existem na fonte — a Assembleia só publica o sentido de voto de cada grupo parlamentar, por isso não são mostrados.
      ${c.initiatives_truncated ? `<br>Para ${int(c.initiatives_truncated)} deputados a lista de iniciativas pode estar truncada pela fonte.` : ""}
      ${c.official_files.deputados ? `<br>Ficheiros oficiais de dados abertos carregados: ${int(c.official_files.deputados)} deputados, ${int(c.official_files.iniciativas)} iniciativas.` : "<br>Os ficheiros oficiais de dados abertos da Assembleia não estão acessíveis neste momento; os dados vêm das páginas públicas de cada deputado em parlamento.pt."}
      ${c.ingest_complete ? "" : "<br><b>Recolha ainda em curso</b> — os números sobem à medida que as páginas de cada deputado são lidas."}${c.updated_at ? `<br>Atualizado em ${esc(c.updated_at.replace("T", " ").replace("Z", " UTC"))}.` : ""}
      Fonte: ${ext(c.source_list, "parlamento.pt — Deputados em funções")}${c.list_fetched_at ? `, recolhida em ${esc(c.list_fetched_at.slice(0, 10))}` : ""}.</p>`;
  }

  async function listPage(params) {
    $app.innerHTML = css + `<p class="muted">A carregar…</p>`;
    const r = await api("deputados/list" + qs({ party: params.party, q: params.q, circle: params.circle, order: params.order }));
    if (!r.available) { $app.innerHTML = `<p class="note warn">${esc(r.error)}</p>`; return; }
    const pill = (code, n, label) => `<a href="#/deputados${qs({ ...params, party: code })}" class="${(params.party || "") === code ? "on" : ""}">${esc(label)}${n != null ? ` · ${n}` : ""}</a>`;
    const total = r.parties.reduce((a, p) => a + p.n, 0);
    const sortLink = (o) => `#/deputados${qs({ ...params, order: o })}`;
    $app.innerHTML = css + `
      <div class="pagehead"><div><div class="kicker">Assembleia da República · XVII Legislatura</div><h1>Deputados</h1>
        <p class="lead">Quem são os deputados, por que partido e círculo foram eleitos, em que comissões trabalham, o que propõem e se vão às votações.</p></div></div>
      ${banner(r.coverage)}<p class="muted small">Regra de faltas: ${esc(r.attendance_rule)}</p>
      <div class="dep-pills">${pill("", total, "Todos")}${r.parties.map((p) => pill(p.code, p.n, p.code)).join("")}</div>
      <form class="dep-filters" id="depf"><input type="search" name="q" placeholder="Pesquisar nome…" value="${esc(params.q || "")}" aria-label="Pesquisar deputado">
        <select name="circle" aria-label="Círculo"><option value="">Todos os círculos</option>${r.circles.map((c) => `<option ${params.circle === c.circle ? "selected" : ""}>${esc(c.circle)}</option>`).join("")}</select>
        <button class="btn" type="submit">Filtrar</button>${params.party ? ` <a href="#/deputados${qs({ ...params, party: "" })}">limpar partido</a>` : ""}
        ${params.party ? `<a href="#/deputados/partido/${encodeURIComponent(params.party)}">Resumo do ${esc(params.party)} →</a>` : ""}</form>
      <p class="muted small">${int(r.n)} deputado(s).</p>
      ${table([
        { h: "Nome", sort: "name", f: (d) => `<a href="#/deputados/${d.bid}">${esc(d.name)}</a>${d.full_name && d.full_name !== d.name ? `<br><small class="muted">${esc(d.full_name)}</small>` : ""}` },
        { h: "Partido / GP", sort: "party", f: (d) => dot(d.party) },
        { h: "Círculo", sort: "circle", f: (d) => esc(d.circle || "—") },
        { h: "Reuniões", num: true, f: (d) => (d.meetings ? int(d.meetings) : "—") },
        { h: "Faltas", num: true, sort: "absent", f: (d) => (d.meetings ? `${d.absent} <span class="muted small">${d.meetings >= 10 ? "(" + pct(d.absent, d.meetings) + ")" : "(em " + d.meetings + " reuniões)"}</span>` : "—") },
        { h: "Iniciativas", num: true, sort: "init", f: (d) => (d.meetings || d.full_name ? int(d.n_init) : "—") },
      ], r.deputados, { sort: params.order || "name", sortLink })}`;
    $("#depf").onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); Portal.go("deputados", "", { ...params, q: f.get("q").trim(), circle: f.get("circle") }); };
  }

  async function profilePage(id) {
    $app.innerHTML = css + `<p class="muted">A carregar…</p>`;
    const r = await api("deputados/deputado?id=" + encodeURIComponent(id));
    if (!r.available) { $app.innerHTML = `<p class="note warn">${esc(r.error)}</p>`; return; }
    if (r.error) { $app.innerHTML = `<a class="back" href="#/deputados">← Deputados</a><p class="note warn">${esc(r.error)}</p>`; return; }
    const d = r.deputado, a = r.attendance, u = r.source_urls;
    const timeline = a.recent.slice().reverse().map((x) => `<i class="${x.code === "P" ? "" : ["AMP", "PNO"].includes(x.code) ? "amp" : ["FJ", "FI", "FALTA"].includes(x.ecode) ? "f" : "amp"}" title="${esc(x.date)} · reunião ${x.meeting_no} · ${esc(x.status)}"></i>`).join("");
    $app.innerHTML = css + `
      <a class="back" href="#/deputados">← Deputados</a>
      <div class="pagehead"><div><div class="kicker">Deputado(a) · XVII Legislatura</div><h1>${esc(d.name)}</h1>
        <p class="lead">${dot(d.party)} círculo de ${esc(d.circle || "—")}${d.profession ? ` · ${esc(d.profession)}` : ""}${d.full_name ? `<br><small>${esc(d.full_name)}${d.birth_date ? ` · nascido(a) em ${esc(String(d.birth_date).slice(0, 4))}` : ""}</small>` : ""}</p></div></div>
      ${d.full_name ? "" : `<p class="note warn">Biografia, comissões, iniciativas e presenças deste deputado ainda não foram recolhidas (só o nome, partido e círculo).</p>`}
      <div class="kpis">
        <div class="kpi"><b>${a.has_data ? int(a.meetings) : "—"}</b><span>reuniões plenárias registadas</span></div>
        <div class="kpi"><b>${a.has_data ? int(a.absent) : "—"}</b><span>faltas${a.has_data ? ` · ${pct(a.absent, a.meetings)}` : ""}</span></div>
        <div class="kpi"><b>${a.has_data ? int(a.amp) : "—"}</b><span>missão parlamentar (AMP)</span></div>
        <div class="kpi"><b>${a.has_data ? int(a.pno) : "—"}</b><span>presença noutro órgão (PNO)</span></div>
        <div class="kpi"><b>${a.party_absent_pct != null ? String(a.party_absent_pct).replace(".", ",") + "%" : "—"}</b><span>faltas médias do ${esc(d.party)}</span></div>
        <div class="kpi"><b>${int(r.initiatives.length)}${r.initiatives_truncated ? "+" : ""}</b><span>iniciativas apresentadas</span></div>
      </div>
      <div class="cols">
        <section class="panel"><h2>Comissões</h2>${r.committees.length ? `<ul>${r.committees.map((c) => `<li>${esc(c.committee)}${c.role ? ` <span class="tag blue">${esc(c.role)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="muted">Sem comissões recolhidas.</p>`}
          ${d.positions ? `<h3>Cargos exercidos</h3><p class="small">${esc(d.positions)}</p>` : ""}${d.qualifications ? `<h3>Habilitações</h3><p class="small">${esc(d.qualifications)}</p>` : ""}</section>
        <section class="panel"><h2>Presenças em plenário</h2>
          ${a.has_data ? `<p class="small">${a.by_session.map((s) => `${s.session}.ª sessão legislativa: <b>${s.absent}</b> faltas em ${s.meetings} reuniões (${pct(s.absent, s.meetings)})`).join("<br>")}</p>
            <div class="dep-att" role="img" aria-label="Últimas ${a.recent.length} reuniões">${timeline}</div><p class="muted small">Últimas ${a.recent.length} reuniões (verde presente, cinzento missão parlamentar/noutro órgão, vermelho falta).</p>
            ${a.absences.length ? `<details><summary>Faltas (${a.absences.length}${a.absent > a.absences.length ? " mais recentes" : ""})</summary><ul class="small">${a.absences.map((x) => `<li>${fmtDate(x.date)} · reunião ${x.meeting_no} (${esc(x.session)}.ª sessão, ${esc(x.kind)}) — ${esc(x.status)}</li>`).join("")}</ul></details>` : `<p class="small">Sem faltas registadas.</p>`}`
            : `<p class="note warn">Presenças ainda não recolhidas para este deputado.</p>`}
          <p class="muted small">${esc(r.attendance_rule)}${a.other ? ` (${a.other} registos com código desconhecido).` : ""}<br>Só reuniões plenárias; as presenças em comissões não são publicadas por deputado. ${ext(u.presencas, "fonte")}</p></section>
      </div>
      <section class="panel"><h2>Iniciativas apresentadas (${int(r.initiatives.length)}${r.initiatives_truncated ? "+" : ""})</h2>
        ${r.initiatives.length ? table([
          { h: "Tipo", f: (i) => esc(i.tipo) }, { h: "N.º", f: (i) => esc(i.numero) }, { h: "Sessão", num: true, f: (i) => esc(i.sessao || "") }, { h: "Título", f: (i) => esc(i.titulo || "") },
        ], r.initiatives) : `<p class="muted">Nenhuma iniciativa recolhida.</p>`}
        ${r.initiatives_truncated ? `<p class="note warn">A fonte limita a lista; pode haver mais iniciativas — ver ${ext(u.atividade, "atividade completa no parlamento.pt")}.</p>` : ""}</section>
      <section class="panel"><h2>Votos</h2><p class="muted">${esc(r.votes.note)}</p></section>
      ${r.mandate_changes.length ? `<section class="panel"><h2>Alterações ao mandato</h2><ul class="small">${r.mandate_changes.map((c) => `<li>${fmtDate(c.date)} — substituição de ${esc(c.leaves)} por ${esc(c.enters)} (${esc(c.circle)}, ${esc(c.party)}): ${esc(c.reason)}</li>`).join("")}</ul></section>` : ""}
      <p class="muted small">Fontes: ${ext(u.biografia, "biografia")} · ${ext(u.atividade, "atividade")} · ${ext(u.presencas, "presenças")}</p>
      <div id="dep-relatorias"></div>`;
    // rapporteur work from the votes module (optional: only if that module is loaded)
    if (Portal.pages.votacoes) {
      try {
        const v = await Portal.api("votacoes/deputado?bid=" + encodeURIComponent(d.bid || id));
        const el = document.getElementById("dep-relatorias");
        if (el && v.available && v.relator && v.relator.length) {
          const rows = v.relator.slice(0, 25);
          el.innerHTML = `<section class="panel"><h2>Relator(a) de ${v.relator.length} iniciativa(s)</h2>${table([
            { h: "Data", f: (x) => (x.data ? fmtDate(x.data) : "") },
            { h: "Iniciativa", f: (x) => `<a href="#/votacoes/${encodeURIComponent(x.key)}"><b>${esc(x.tipo)} ${esc(x.numero)}/${esc(x.leg)}</b></a><div class="small muted">${esc((x.titulo || "").slice(0, 110))}</div>` },
            { h: "Comissão", f: (x) => esc(x.comissao || "") }, { h: "Estado", f: (x) => esc(x.estado || "") },
          ], rows)}${v.relator.length > rows.length ? `<p class="small muted">A mostrar as ${rows.length} mais recentes.</p>` : ""}<p class="small muted">Fonte: páginas de iniciativas em parlamento.pt.</p></section>`;
        }
      } catch (e) { console.warn("relatorias", e); }
    }
  }

  async function partyPage(code) {
    $app.innerHTML = css + `<p class="muted">A carregar…</p>`;
    const r = await api("deputados/party?code=" + encodeURIComponent(code));
    if (!r.available || r.error) { $app.innerHTML = `<a class="back" href="#/deputados">← Deputados</a><p class="note warn">${esc(r.error || "Sem dados.")}</p>`; return; }
    const a = r.attendance;
    $app.innerHTML = css + `
      <a class="back" href="#/deputados">← Deputados</a>
      <div class="pagehead"><div><div class="kicker">Grupo parlamentar / partido</div><h1>${dot(code)} ${r.n} deputados</h1></div></div>
      <div class="kpis"><div class="kpi"><b>${r.n}</b><span>deputados em funções</span></div>
        <div class="kpi"><b>${a.meetings ? pct(a.absent, a.meetings) : "—"}</b><span>faltas / presenças registadas</span></div>
        <div class="kpi"><b>${int(r.initiatives)}</b><span>iniciativas apresentadas (pelos membros)</span></div></div>
      <div class="cols">
        <section class="panel"><h2>Círculos</h2><p>${r.circles.map((c) => `<span class="chip">${esc(c.circle)} · ${c.n}</span>`).join("")}</p>
          <h2>Mais iniciativas</h2><ol>${r.top_authors.map((x) => `<li><a href="#/deputados/${x.bid}">${esc(x.name)}</a> · ${x.n}</li>`).join("") || "<li class='muted'>—</li>"}</ol></section>
        <section class="panel"><h2>Mais faltas em plenário</h2><ol>${r.most_absent.map((x) => `<li><a href="#/deputados/${x.bid}">${esc(x.name)}</a> · ${x.absent} em ${x.meetings}</li>`).join("") || "<li class='muted'>—</li>"}</ol>
          <h2>Comissões</h2><p class="small">${r.committees.map((c) => `${esc(c.committee)} (${c.n})`).join("; ")}</p></section></div>
      <p><a href="#/deputados${qs({ party: code })}">Ver os ${r.n} deputados →</a></p>`;
  }

  Portal.page("deputados", async (arg, params) => {
    if (arg.startsWith("partido/")) return partyPage(arg.slice(8));
    return arg ? profilePage(arg) : listPage(params || {});
  });
  Portal.nav("Deputados", "#/deputados");
})();
