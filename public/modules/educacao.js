"use strict";
/* Módulo "educacao": #/educacao (visão geral, escolas, ensino superior, docentes, Parque Escolar) e #/educacao/escola/<código>
   API: /api/educacao/*  — dados: Infoescolas/DGEEC, DGES, AGSE (ex-DGAE), Construção Pública (ex-Parque Escolar). */
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const KIND = { agrupamento: "Agrupamento de escolas", escola_nao_agrupada: "Escola não agrupada", escola_privada: "Escola privada", ensino_superior: "Ensino superior", outra: "Outra" };
  const LISTKIND = { concurso_nacional: "Concurso nacional (interno e externo)", mobilidade_contratacao: "Mobilidade interna / contratação inicial", colocacao: "Reserva de recrutamento — colocação", colocacao_administrativa: "Colocação administrativa" };
  const PHASE = { "Fase 0": "Fase 0", "Fase 1": "Fase 1", "Fase 2": "Fase 2", "Fase 3": "Fase 3", "n/a": "n/d" };
  const sel = (id, opts, cur, all) => `<select id="${id}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const yearBars = (years) => (years && years.length ? Portal.bars(years.map((y) => ({ year: y.year, value: y.value, n: y.n, direct_value: y.direct_value }))) : "");
  const gw = (cls = "") => `<style>.edu-tag{font-variant-numeric:tabular-nums}.edu-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}.edu-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.edu-filters input[type=search]{flex:1;min-width:220px}.edu-sub{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.edu-sub a{padding:.3rem .7rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:.88rem}.edu-ind{display:flex;gap:10px;flex-wrap:wrap}.edu-ind span{white-space:nowrap}</style>`;
  const sub = `<nav class="edu-sub" aria-label="Secções de educação"><a href="#/educacao" data-sec="sec-escolas">Escolas e agrupamentos</a><a href="#/educacao" data-sec="sec-superior">Ensino superior</a><a href="#/educacao" data-sec="sec-docentes">Docentes</a><a href="#/educacao" data-sec="sec-pe">Parque Escolar</a></nav>`;

  Portal.nav("Educação", "#/educacao");

  /* ------------------------------------------------------------- overview */
  async function pageOverview(p) {
    const link = (o) => `#/educacao${Portal.qs({ ...p, ...o })}`;
    const [ov, es, hs, dc, pe] = await Promise.all([
      Portal.api("educacao/overview"),
      Portal.api("educacao/escolas" + Portal.qs({ q: p.q, distrito: p.distrito, nature: p.nature, kind: p.kind || "", page: p.page })),
      Portal.api("educacao/escolas" + Portal.qs({ kind: "ensino_superior", q: p.hq, nature: p.hnature, page: p.hpage })),
      Portal.api("educacao/docentes" + Portal.qs({ q: p.dq, school: p.dschool, group: p.dgroup, kind: p.dkind, sit: p.dsit, page: p.dpage })),
      Portal.api("educacao/parque-escolar" + Portal.qs({ q: p.pq, distrito: p.pdist, phase: p.pphase })),
    ]);
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Educação</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const c = ov.counts, ms = ov.matchStats || {};
    const kindsNo = (es.rows || []);
    $app.innerHTML = `${gw()}
      <div class="crumbs"><a href="#/">Início</a> / Educação</div>
      <div class="pagehead"><div><div class="kicker">Educação pública</div><h1>Escolas, docentes e edifícios escolares</h1>
        <p class="lead">Registo de escolas e agrupamentos, ensino superior, listas oficiais de docentes e o programa de requalificação das escolas secundárias (Parque Escolar), ligados à contratação pública.</p></div></div>
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(c.agrupamentos)}</b><span>agrupamentos de escolas</span></div>
        <div class="kpi"><b>${Portal.int(c.ena)}</b><span>escolas não agrupadas (públicas)</span></div>
        <div class="kpi"><b>${Portal.int(c.privadas)}</b><span>escolas privadas</span></div>
        <div class="kpi"><b>${Portal.int(c.superior)}</b><span>instituições / unidades de ensino superior</span></div>
        <div class="kpi"><b>${Portal.int(c.schools)}</b><span>estabelecimentos (escolas) listados</span></div>
        <div class="kpi"><b>${Portal.int(c.students)}</b><span>alunos (ensino básico e secundário, ${esc(c.students_year || "")})</span></div>
        <div class="kpi"><b>${Portal.int(c.teacher_rows)}</b><span>linhas em listas oficiais de docentes</span></div>
        <div class="kpi"><b>${Portal.int(c.pe_schools)}</b><span>escolas no portefólio Parque Escolar</span></div></div>
      <p class="note">Cobertura dos dados de alunos: Portugal continental (Infoescolas/DGEEC, ano letivo ${esc(c.students_year || "")}; ficheiros de 2021 — a DGEEC não publicou versão mais recente no dados.gov.pt). Pré-escolar e regiões autónomas não constam desta fonte.
        ${ms.public_units ? ` Ligação ao registo de entidades (NIF) por nome normalizado inequívoco: ${Portal.int(ms.public_matched)} de ${Portal.int(ms.public_units)} agrupamentos/escolas públicas (${Math.round(100 * ms.public_matched / ms.public_units)}%), ${Portal.int(ms.he_matched)} de ${Portal.int(ms.he)} unidades de ensino superior.` : ""}</p>
      ${sub}

      <section class="panel" id="sec-escolas"><h2>Escolas e agrupamentos</h2>
        <div class="edu-filters">
          <input type="search" id="eq" placeholder="Nome ou código (ex.: 152160)" value="${esc(p.q || "")}">
          ${sel("ed", (es.facets?.districts || []).map((d) => [d, d]), p.distrito, "Todos os distritos")}
          ${sel("en", [["Pública", "Pública"], ["Privada", "Privada"]], p.nature, "Pública e privada")}
          ${sel("ek", [["agrupamento", "Agrupamentos"], ["escola_nao_agrupada", "Escolas não agrupadas"], ["escola_privada", "Escolas privadas"]], p.kind, "Todos os tipos")}
          <input type="search" id="em" placeholder="Município…" value="${esc(p.municipio || "")}" style="max-width:180px">
        </div>
        <p class="small muted">${Portal.int(es.total)} resultados.</p>
        ${Portal.table([
          { h: "Unidade", f: (r) => `<a href="#/educacao/escola/${esc(r.code)}"><b>${esc(r.name)}</b></a><div class="small muted">${esc(KIND[r.kind] || r.kind)} · ${esc(r.nature || "")} · código ${esc(r.code)}</div>` },
          { h: "Município / distrito", f: (r) => `${esc(r.municipality || "—")}<div class="small muted">${esc(r.district || "")}</div>` },
          { h: "Níveis", f: (r) => (r.students_json ? Object.keys(r.students_json).filter((k) => r.students_json[k] > 0).map((k) => `<span class="tag">${esc(k.replace("Secundário (cursos científico-humanísticos)", "Sec. CH").replace("Secundário profissional", "Sec. prof."))}</span>`).join("") : "") },
          { h: "Alunos", num: 1, f: (r) => Portal.int(r.students) },
          { h: "Contratos", f: (r) => (r.nif ? `<a href="#/entidade/${r.entity_id}">ver →</a>` : '<span class="muted small">sem NIF ligado</span>') },
        ], es.rows)}
        ${Portal.pager(es.total, es.page || 1, es.limit || 40, (n) => link({ page: n }))}
        ${es.schoolsMatch && es.schoolsMatch.length ? `<h3>Estabelecimentos (escolas individuais) correspondentes</h3>${Portal.table([{ h: "Escola", f: (s) => esc(s.name) + ` <span class="small muted">código ${esc(s.code)}</span>` }, { h: "Concelho", f: (s) => esc(s.municipality || "") }, { h: "Níveis", f: (s) => esc(s.levels || "") }, { h: "Alunos", num: 1, f: (s) => Portal.int(s.students) }], es.schoolsMatch)}<p class="small muted">Estabelecimentos do Infoescolas (continente). Os dados abertos não indicam a que agrupamento pertence cada escola.</p>` : ""}
      </section>

      <section class="panel" id="sec-superior"><h2>Ensino superior</h2>
        <p class="small muted">Instituições e unidades orgânicas constantes do Acesso ao Ensino Superior 2026 (DGES): ${Portal.int(c.superior)} unidades, ${Portal.int(c.vagas)} vagas no total (todas as fases/ciclos listados).</p>
        <div class="edu-filters"><input type="search" id="hq" placeholder="Universidade, instituto politécnico, faculdade…" value="${esc(p.hq || "")}">
          ${sel("hn", [["Pública", "Pública"], ["Privada", "Privada"]], p.hnature, "Pública e privada")}</div>
        ${Portal.table([
          { h: "Instituição / unidade", f: (r) => `<a href="#/educacao/escola/${encodeURIComponent(r.code)}"><b>${esc(r.name)}</b></a>${r.website ? ` <a href="${esc(r.website)}" target="_blank" rel="noopener" class="small">sítio ↗</a>` : ""}` },
          { h: "Natureza", f: (r) => `${esc(r.nature || "")} <span class="small muted">${esc({ universitario: "universitário", politecnico: "politécnico", militar_policial: "militar/policial" }[r.subsystem] || "")}</span>` },
          { h: "Vagas 2026", num: 1, f: (r) => Portal.int(r.vagas_2026) },
          { h: "Contratos", f: (r) => (r.nif ? `<a href="#/entidade/${r.entity_id}">ver →</a>` : '<span class="muted small">—</span>') },
        ], hs.rows)}
        ${Portal.pager(hs.total, hs.page || 1, hs.limit || 40, (n) => link({ hpage: n }))}
        <p class="small muted">Fonte: ${ext("https://www.dges.gov.pt/guias/indest.asp", "DGES — Acesso ao Ensino Superior")}. Contratos só aparecem quando o nome da unidade se liga de forma inequívoca a uma entidade adjudicante; faculdades de uma universidade contratam, em geral, através da universidade.</p>
      </section>

      ${teachersSection(p, ov, dc)}
      ${peSection(p, pe)}
      <p class="small muted">Construído em ${esc(ov.builtAt || "—")}. Fontes e lacunas em <code>docs/SOURCES.md</code>.</p>`;
    document.querySelectorAll(".edu-sub a").forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); const t = document.getElementById(a.dataset.sec); if (t) t.scrollIntoView({ behavior: "smooth" }); }; });
    if (p.dq || p.dschool || p.dgroup || p.dkind) setTimeout(() => document.getElementById("sec-docentes")?.scrollIntoView(), 50);
    const rerender = (o) => Portal.go("educacao", "", { ...p, ...o });
    const bind = (id, key, extra = {}) => { const el = $("#" + id); if (el) el.onchange = (e) => rerender({ [key]: e.target.value, ...extra }); };
    bind("eq", "q", { page: 1 }); bind("ed", "distrito", { page: 1 }); bind("en", "nature", { page: 1 }); bind("ek", "kind", { page: 1 }); bind("em", "municipio", { page: 1 });
    bind("hq", "hq", { hpage: 1 }); bind("hn", "hnature", { hpage: 1 });
    bind("dq", "dq", { dpage: 1 }); bind("dk", "dkind", { dpage: 1 }); bind("dg", "dgroup", { dpage: 1 }); bind("ds", "dschool", { dpage: 1 });
    bind("pq", "pq"); bind("pd", "pdist"); bind("pp", "pphase");
  }

  /* ------------------------------------------------------------- teachers */
  function statsTable(ov, ind, title) {
    const rows = (ov.stats || []).filter((s) => s.indicator === ind);
    if (!rows.length) return "";
    const years = [...new Set(rows.map((r) => r.year))].sort();
    const keys = [...new Map(rows.map((r) => [(r.grp || "") + "|" + r.series, { g: r.grp, s: r.series }])).values()];
    const v = (k, y) => { const r = rows.find((x) => x.grp === k.g && x.series === k.s && x.year === y); return r ? Portal.int(r.value) : "—"; };
    const last = years.slice(-6);
    return `<h3>${esc(title)}</h3>${Portal.table([{ h: "Série", f: (k) => `${k.g ? `<span class="muted small">${esc(k.g)} · </span>` : ""}${esc(k.s)}` }, ...last.map((y) => ({ h: y, num: 1, f: (k) => v(k, y) }))], keys)}
      <p class="small muted">${ext(rows[0].source_url, "DGEEC — indicador " + ind)} (dados até ${esc(years[years.length - 1])}; página de 2021).</p>`;
  }
  function teachersSection(p, ov, dc) {
    const f = dc.facets || {};
    const hasF = !dc.needFilter;
    const groups = (f.groups || []).map((g) => [g.c, `${g.c} — ${g.n}`]);
    const kinds = [...new Set((f.kinds || []).map((k) => k.kind))].map((k) => [k, LISTKIND[k] || k]);
    return `<section class="panel" id="sec-docentes"><h2>Docentes</h2>
      <div class="note">Os concursos e colocações de docentes são publicados em PDF pela <b>AGSE</b> (Agência para a Gestão do Sistema Educativo, que integra a antiga DGAE). Aqui só aparecem listas que o próprio organismo divulga publicamente. Guardamos nome, grupo de recrutamento, graduação, situação e agrupamento de colocação, sempre com ligação ao PDF oficial; <b>não</b> guardamos o número de utilizador nem a data de nascimento que os PDFs também contêm. Nada vem de áreas com autenticação (SIGRHE).</div>
      ${statsTable(ov, "1.8", "Docentes em exercício, por nível de ensino (Portugal)")}
      ${statsTable(ov, "3.9", "Docentes dos ensinos básico e secundário, por ciclo e natureza do estabelecimento")}
      ${statsTable(ov, "5.9", "Docentes do ensino superior, por natureza e tipo de estabelecimento")}
      <p class="note warn">A DGEEC publica por escola apenas indicadores agregados em ficheiros de pedido/portal sem ficheiro aberto atual; contagens de docentes <i>por escola</i>, idades e tipos de vínculo por escola não estão disponíveis como dados abertos descarregáveis (o portal novo da DGEEC usa uma API cifrada). Mostram-se por isso os agregados nacionais acima e, por escola, apenas o que consta das listas de colocação da AGSE.</p>
      <h3 id="listas">Listas oficiais (concursos e colocações)</h3>
      <div class="edu-filters"><input type="search" id="dq" placeholder="Nome do docente (mín. 3 letras)" value="${esc(p.dq || "")}">
        ${sel("dk", kinds, p.dkind, "Todas as listas")}
        ${sel("dg", groups, p.dgroup, "Todos os grupos de recrutamento")}
        <input type="search" id="ds" placeholder="Código do agrupamento (colocação)" value="${esc(p.dschool || "")}" style="max-width:230px"></div>
      ${!hasF ? `<p class="small muted">Escolha um filtro (nome, lista, grupo ou agrupamento) para consultar. ${Portal.int((f.kinds || []).reduce((a, b) => a + b.n, 0))} linhas em ${Portal.int((f.kinds || []).reduce((a, b) => a + b.pdfs, 0))} PDFs.</p>
        ${Portal.table([{ h: "Lista", f: (r) => `<b>${esc(LISTKIND[r.kind] || r.kind)}</b> <span class="small muted">${esc(r.school_year)}</span>` }, { h: "PDFs", num: 1, f: (r) => Portal.int(r.pdfs) }, { h: "Linhas", num: 1, f: (r) => Portal.int(r.n) }], f.kinds || [])}
        ${Portal.table([{ h: "Publicação AGSE", f: (r) => ext(r.page_url, r.page_title) }, { h: "Data", f: (r) => Portal.fmtDate(r.pub_date) }, { h: "PDFs", num: 1, f: (r) => Portal.int(r.pdfs) }, { h: "Linhas", num: 1, f: (r) => Portal.int(r.n) }], (f.lists || []).slice(0, 25))}`
      : `<p class="small muted">${Portal.int(dc.total)} linhas.</p>${Portal.table([
        { h: "Nome", f: (r) => `<b>${esc(r.name)}</b>` },
        { h: "Lista", f: (r) => `${ext(r.pdf_url, LISTKIND[r.kind] || r.kind)}<div class="small muted">${esc(r.sublist || "")} · ${esc(r.school_year)} · grupo ${esc(r.group_code || "?")} ${esc(r.group_name || "")}</div>` },
        { h: "Ordem", num: 1, f: (r) => Portal.int(r.ordem) },
        { h: "Graduação", num: 1, f: (r) => (r.graduacao == null ? "—" : r.graduacao.toLocaleString("pt-PT", { minimumFractionDigits: 3 })) },
        { h: "Situação / colocação", f: (r) => `${esc(r.situacao || "—")}${r.placed_code ? `<div class="small"><a href="#/educacao/escola/${esc(r.placed_code)}">${esc(r.placed_name || r.placed_code)}</a></div>` : ""}` },
      ], dc.rows)}${Portal.pager(dc.total, dc.page || 1, dc.limit || 50, (n) => `#/educacao${Portal.qs({ ...p, dpage: n })}`)}`}
    </section>`;
  }

  /* ------------------------------------------------------------- Parque Escolar */
  function peSection(p, pe) {
    if (!pe.available) return "";
    const b = pe.body, pr = pe.procurement;
    const tot = (l) => (pe.totals.find((t) => t.label.toUpperCase().includes(l)) || {}).value;
    return `<section class="panel" id="sec-pe"><h2>Parque Escolar (hoje Construção Pública, E.P.E.)</h2>
      <p>${esc(b.programme)}. A empresa pública <b>${esc(b.name_old)}</b> foi criada em ${esc(b.created)}; em ${esc(b.restructured)}, passando a chamar-se <b>${esc(b.name_now)}</b> (mesmo NIF ${esc(b.nif)}${b.entity ? ` — <a href="#/entidade/${b.entity.id}">ver entidade e todos os contratos</a>` : ""}). Sítio oficial: ${ext(b.website + "/pt/educacao.aspx", "Construção Pública — Educação")} · ${ext("https://www.wikidata.org/wiki/" + b.wikidata, "Wikidata " + b.wikidata)}.</p>
      <div class="kpis">
        ${[["REQUALIFICADAS", "escolas requalificadas"], ["EM REQUALIFICA", "escolas em requalificação"], ["SALAS", "salas de aula"], ["BIBLIOTECAS", "bibliotecas"], ["OFICINAS", "oficinas"], ["ESPAÇOS DESPORTIVOS", "espaços desportivos"]].map(([k, l]) => `<div class="kpi"><b>${Portal.int(tot(k))}</b><span>${l}</span></div>`).join("")}
        ${pr ? `<div class="kpi"><b>${Portal.eur(pr.total.value)}</b><span>contratado em ${Portal.int(pr.total.n)} contratos (BASE, 2012+; inclui habitação)</span></div>` : ""}</div>
      ${pr && pr.years.length ? `<h3>Contratação pública por ano (NIF ${esc(b.nif)})</h3>${yearBars(pr.years)}
        <p class="small muted">Valor contratual publicado no portal BASE. O orçamento do programa em si (investimento acumulado, dívida) consta dos relatórios e contas — listados abaixo; os PDFs não foram interpretados automaticamente.</p>` : ""}
      ${pr && pr.topSuppliers.length ? `<div class="cols"><div>${Portal.table([{ h: "Principais fornecedores", f: (r) => `<a href="#/contratos?seller=${esc(r.nif)}">${esc(r.name || r.nif)}</a>` }, { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }], pr.topSuppliers)}</div>
        <div>${Portal.table([{ h: "Maiores contratos", f: (r) => `<a href="#/contrato/${esc(r.id)}">${esc((r.object || "").slice(0, 80))}</a><div class="small muted">${esc(r.seller_name || "")}</div>` }, { h: "Preço", num: 1, f: (r) => Portal.eur(r.price) }], pr.biggest)}</div></div>` : ""}
      <h3>Escolas do portefólio (${Portal.int(pe.schools.length)})</h3>
      <div class="edu-filters"><input type="search" id="pq" placeholder="Escola, morada ou arquiteto…" value="${esc(p.pq || "")}">
        ${sel("pd", (pe.districts || []).map((d) => [d, d]), p.pdist, "Todos os distritos")}
        ${sel("pp", (pe.phases || []).map((x) => [x.p, `${PHASE[x.p] || x.p} (${x.n})`]), p.pphase, "Todas as fases")}</div>
      ${Portal.table([
        { h: "Escola", f: (r) => `${r.unit_code ? `<a href="#/educacao/escola/${esc(r.unit_code)}"><b>${esc(r.name)}</b></a>` : `<b>${esc(r.name)}</b>`} ${ext(r.source_url, "ficha")}<div class="small muted">${esc(r.address || "")} ${esc(r.postcode || "")}</div>` },
        { h: "Distrito", f: (r) => esc(r.district || "") }, { h: "Fase", f: (r) => esc(PHASE[r.phase] || r.phase || "") },
        { h: "Arquiteto", f: (r) => esc(r.architect || "—") }, { h: "Concluída", f: (r) => esc(r.completed || "—") },
        { h: "Intervenção", f: (r) => `<span class="small">${Object.entries(r.indicators || {}).slice(0, 3).map(([k, v]) => `${esc(v)} ${esc(k.toLowerCase().replace("² de área intervencionada (requalificada+nova)", "m²"))}`).join(" · ")}</span>` },
      ], pe.schools)}
      <details style="margin-top:12px"><summary><b>Documentos de gestão</b> (relatórios e contas, execução orçamental, orçamentos)</summary>
        ${Portal.table([{ h: "Documento", f: (d) => ext(d.url, d.title) }, { h: "Tipo", f: (d) => esc(d.category) }], pe.docs.slice(0, 250))}</details>
    </section>`;
  }

  /* ------------------------------------------------------------- school page */
  async function pageSchool(code) {
    const d = await Portal.api("educacao/escola?id=" + encodeURIComponent(code));
    if (!d || d.error || !d.unit) { $app.innerHTML = `<div class="crumbs"><a href="#/educacao">Educação</a></div><p class="note warn">Unidade não encontrada.</p>`; return; }
    const u = d.unit, pr = d.procurement;
    const lv = u.students_json ? Object.entries(u.students_json).filter(([, v]) => v > 0) : [];
    $app.innerHTML = `${gw()}
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/educacao">Educação</a> / ${esc(u.kindLabel || "")}</div>
      <div class="pagehead"><div><div class="kicker">${esc(u.kindLabel || "")} · ${esc(u.nature || "")}</div><h1>${esc(u.name)}</h1>
        <div class="small muted">Código ${esc(u.code)}${u.municipality ? " · " + esc(u.municipality) : ""}${u.district ? " · distrito de " + esc(u.district) : ""}${u.nif ? " · NIF " + esc(u.nif) : ""}${u.website ? ` · <a href="${esc(u.website)}" target="_blank" rel="noopener">sítio oficial ↗</a>` : ""}${u.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(u.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ""}${d.entity ? ` · <a href="#/entidade/${d.entity.id}">ficha de entidade e contratos</a>` : ""}</div></div></div>
      <div class="kpis">
        ${u.students != null ? `<div class="kpi"><b>${Portal.int(u.students)}</b><span>alunos (${esc(u.students_year || "")}, ensino básico e secundário)</span></div>` : ""}
        ${u.vagas_2026 != null ? `<div class="kpi"><b>${Portal.int(u.vagas_2026)}</b><span>vagas 2026 em ${Portal.int(u.n_courses)} cursos</span></div>` : ""}
        ${d.schools.length ? `<div class="kpi"><b>${Portal.int(d.schools.length)}</b><span>estabelecimentos ligados pelo código</span></div>` : ""}
        ${d.nPlaced ? `<div class="kpi"><b>${Portal.int(d.nPlaced)}</b><span>colocações de docentes em listas AGSE</span></div>` : ""}
        ${pr && pr.n ? `<div class="kpi"><b>${Portal.eur(pr.value)}</b><span>contratado (${Portal.int(pr.n)} contratos)</span></div><div class="kpi"><b>${Portal.pct(100 * pr.direct_value / (pr.value || 1))}</b><span>do valor por ajuste direto</span></div>` : ""}</div>
      ${lv.length ? `<section class="panel"><h2>Alunos por nível</h2><div class="edu-ind">${lv.map(([k, v]) => `<span class="tag">${esc(k)}: <b>${Portal.int(v)}</b></span>`).join("")}</div>
        <p class="small muted">Fonte: ${ext(u.source_url, "Infoescolas / DGEEC")} — só continente, ${esc(u.students_year || "")}.</p></section>` : ""}
      ${d.schools.length ? `<section class="panel"><h2>Estabelecimentos</h2>${Portal.table([{ h: "Escola", f: (s) => esc(s.name) }, { h: "Concelho", f: (s) => esc(s.municipality || "") }, { h: "Níveis", f: (s) => esc(s.levels || "") }, { h: "Alunos", num: 1, f: (s) => Portal.int(s.students) }], d.schools)}</section>` : ""}
      ${d.munSchools && d.munSchools.length ? `<section class="panel"><h2>Escolas do município de ${esc(u.municipality)}</h2><p class="small muted">Os dados abertos não publicam a pertença de cada escola a um agrupamento; mostram-se as escolas do mesmo município (Infoescolas).</p>${Portal.table([{ h: "Escola", f: (s) => esc(s.name) }, { h: "Níveis", f: (s) => esc(s.levels || "") }, { h: "Alunos", num: 1, f: (s) => Portal.int(s.students) }], d.munSchools)}</section>` : ""}
      ${d.parqueEscolar.length ? `<section class="panel"><h2>Requalificação Parque Escolar</h2>${d.parqueEscolar.map((x) => `<p><b>${esc(x.name)}</b> — ${esc(PHASE[x.phase] || x.phase)}${x.completed ? `, obra concluída em ${esc(x.completed)}` : ""}${x.architect ? `, arquiteto ${esc(x.architect)}` : ""}. ${ext(x.source_url, "ficha oficial")}</p>`).join("")}</section>` : ""}
      ${procPanel(pr, u)}
      ${placedPanel(d)}
      <p class="small muted">Fontes: ${esc(u.sources || "")}. Ligação ao registo de entidades: ${esc(u.match_how || "não ligada (sem correspondência inequívoca por nome)")}.</p>`;
  }
  function procPanel(pr, u) {
    if (!pr) return u.nif ? "" : `<p class="note">Sem NIF associado a esta unidade no registo de entidades, pelo que não é possível mostrar a sua contratação. ${u.kind === "ensino_superior" ? "As faculdades contratam em regra através da universidade." : ""}</p>`;
    if (!pr.n) return `<p class="note">Sem contratos públicos publicados no portal BASE para o NIF ${esc(u.nif)}.</p>`;
    return `<section class="panel"><h2>Contratação pública</h2>${yearBars(pr.years)}
      <div class="cols"><div>${Portal.table([{ h: "Principais fornecedores", f: (r) => `<a href="#/contratos?seller=${esc(r.nif)}">${esc(r.name || r.nif)}</a>` }, { h: "Contratos", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }], pr.topSuppliers)}</div>
      <div>${Portal.table([{ h: "Data", f: (r) => Portal.fmtDate(r.signed) }, { h: "Objeto", f: (r) => `<a href="#/contrato/${esc(r.id)}">${esc((r.object || "").slice(0, 90))}</a>` }, { h: "Preço", num: 1, f: (r) => Portal.eur(r.price) }], pr.recent)}</div></div>
      <p class="small"><a href="#/contratos?buyer=${esc(u.nif)}">Ver todos os contratos →</a></p></section>`;
  }
  function placedPanel(d) {
    if (!d.placedSummary.length) return d.unit.kind === "ensino_superior" ? "" : `<section class="panel"><h2>Docentes colocados</h2><p class="small muted">Nenhuma colocação deste agrupamento nas listas AGSE 2026/27 processadas.</p></section>`;
    return `<section class="panel"><h2>Docentes colocados (listas oficiais AGSE)</h2>
      ${Portal.table([{ h: "Lista", f: (r) => `${ext(r.pdf_url, LISTKIND[r.kind] || r.kind)}<div class="small muted">${esc(r.page_title)}</div>` }, { h: "Grupo", f: (r) => esc(`${r.group_code || ""} ${r.group_name || ""}`) }, { h: "Data", f: (r) => Portal.fmtDate(r.pub_date) }, { h: "Colocações", num: 1, f: (r) => Portal.int(r.n) }], d.placedSummary.slice(0, 80))}
      <p class="small"><a href="#/educacao${Portal.qs({ dschool: d.unit.code })}">Ver nomes e graduações das colocações →</a></p></section>`;
  }

  Portal.page("educacao", async (arg, p) => {
    try {
      const m = /^escola\/(.+)$/.exec(arg || "");
      if (m) return await pageSchool(decodeURIComponent(m[1]));
      return await pageOverview(p);
    } catch (e) {
      $app.innerHTML = `<div class="pagehead"><div><h1>Educação</h1></div></div><p class="note warn">Não foi possível carregar os dados de educação (${esc(String(e.message || e))}).</p>`;
    }
  });

  /* ------------------------------------------------------------- entity hook */
  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !["escola", "universidade"].includes(e.kind)) return;
    const d = await Portal.api("educacao/escola?entity=" + e.id).catch(() => null);
    if (!d || !d.unit) {
      el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Educação</h2><p class="small muted">Esta entidade não foi ligada, de forma inequívoca, a um agrupamento/escola do registo de educação. <a href="#/educacao${Portal.qs({ q: e.name.replace(/^Agrupamento de Escolas( de| do| da)?/i, "").trim() })}">Procurar no registo →</a></p></section>`);
      return;
    }
    const u = d.unit;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Educação — registo de escolas</h2>
      <p><b>${esc(u.kindLabel)}</b> · ${esc(u.nature || "")} · código ${esc(u.code)}${u.municipality ? " · " + esc(u.municipality) : ""}${u.district ? ", " + esc(u.district) : ""}${u.students ? ` · ${Portal.int(u.students)} alunos (${esc(u.students_year)})` : ""}${u.vagas_2026 ? ` · ${Portal.int(u.vagas_2026)} vagas 2026` : ""}.</p>
      ${d.nPlaced ? `<p>${Portal.int(d.nPlaced)} colocações de docentes em listas AGSE 2026/27 · <a href="#/educacao${Portal.qs({ dschool: u.code })}">ver lista</a></p>` : ""}
      ${d.parqueEscolar.length ? `<p>Escola requalificada pelo Parque Escolar (${esc(d.parqueEscolar[0].phase || "")}${d.parqueEscolar[0].completed ? ", concluída em " + esc(d.parqueEscolar[0].completed) : ""}).</p>` : ""}
      <p class="small"><a href="#/educacao/escola/${encodeURIComponent(u.code)}">Página da escola no módulo Educação →</a></p></section>`);
  });
})();
