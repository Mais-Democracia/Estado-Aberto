"use strict";
/* Módulo "regioes": #/regioes/<acores|madeira>?tab=...  (API: /api/regioes/*) */
(() => {
  const { esc } = Portal;
  const REGS = [["acores", "Açores"], ["madeira", "Madeira"]];
  const TABS = [["governo", "Governo Regional"], ["assembleia", "Assembleia Legislativa"], ["eleicoes", "Eleições"], ["orcamento", "Orçamento"], ["contratos", "Contratação pública"]];
  const COL = { PSD: "#f08a24", "PSD/CDS/PPM": "#f08a24", "PSD/CDS-PP": "#f08a24", PS: "#d6336c", CH: "#2b3a67", "CDS-PP": "#2a7fc1", IL: "#27a7c7", BE: "#8b1e2d", PAN: "#2f9e8f", CDU: "#c92a2a", JPP: "#3f9d4d", L: "#8cb63c", PPM: "#8a6d3b", DNI: "#868e96" };
  const colOf = (a) => COL[a] || "#9aa3b2";
  const M = Portal.eur;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const KIND = { direcao_regional: "Direção regional", instituto: "Instituto / serviço / fundo", empresa: "Empresa pública regional", inspecao: "Inspeção", outro: "Outro" };
  const GRP = { governo_regional: "Governo Regional (secretarias e serviços)", empresa: "Empresas e entidades empresariais (SA, EPE, EIM…)", municipio: "Municípios", saude: "Saúde (hospitais, centros)", escola: "Escolas", setor_regional: "Outro setor regional", administracao_central: "Administração central na região", freguesia: "Freguesias", outros: "Outros" };
  const css = `<style>
    .rg-bar{display:flex;height:34px;border-radius:5px;overflow:hidden;border:1px solid var(--line)}
    .rg-bar i{display:block;min-width:2px;border-right:2px solid var(--card)}
    .rg-leg{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.85rem;margin-top:8px}
    .rg-leg b{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
    .rg-hb{display:grid;grid-template-columns:minmax(130px,34%) 1fr auto;gap:5px 10px;align-items:center;font-size:.88rem}
    .rg-hb .t{height:13px;background:var(--line2);border-radius:0 4px 4px 0;position:relative}.rg-hb .t b{position:absolute;inset:0 auto 0 0;background:var(--bar);border-radius:0 4px 4px 0}
    .rg-hb .t u{position:absolute;inset:0 auto 0 0;background:var(--bar2);border-radius:0 4px 4px 0;opacity:.9}
    .rg-hb .v{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .rg-sec{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--card)}
    .rg-sec h3{margin:.1rem 0 .2rem}.rg-sec summary{cursor:pointer}
    .rg-chips{display:flex;flex-wrap:wrap;gap:6px;margin:.4rem 0}
    .rg-yr{display:flex;align-items:flex-end;gap:3px;height:96px}.rg-yr div{flex:1;background:var(--bar);min-width:6px;position:relative;border-radius:2px 2px 0 0}.rg-yr div u{position:absolute;left:0;right:0;bottom:0;background:var(--bar2);text-decoration:none;border-radius:0 0 0 0}
    .rg-yrl{display:flex;gap:3px;font-size:.7rem;color:var(--muted)}.rg-yrl span{flex:1;text-align:center}
    .rg-ok{color:var(--accent)}.rg-dv{color:var(--alert);font-weight:600}
  </style>`;
  Portal.nav("Regiões autónomas", "#/regioes");

  const cache = {};
  const get = (ep, r, extra = "") => (cache[ep + r + extra] ||= Portal.api(`regioes/${ep}?regiao=${r}${extra}`));
  const num = (v) => Portal.int(v);
  const stat = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;
  const note = (b) => (b || []).length ? `<details class="panel"><summary><b>Limites de cobertura e o que está bloqueado</b></summary><ul>${b.map((x) => `<li><b>${esc(x.topic)}</b> (${esc(x.source)}): ${esc(x.reason)}</li>`).join("")}</ul></details>` : "";
  const dt = (s) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "—");

  function hbars(rows, { fmt = M, second } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.v));
    return `<div class="rg-hb">${rows.map((r) => `<div>${r.label}</div><div class="t"><b style="width:${(100 * r.v / max).toFixed(1)}%"></b>${r.v2 ? `<u style="width:${(100 * r.v2 / max).toFixed(1)}%"></u>` : ""}</div><div class="v">${fmt(r.v)}${r.extra ? ` <span class="muted small">${r.extra}</span>` : ""}</div>`).join("")}</div>`;
  }

  function seatBar(items, total) {
    const tt = total || items.reduce((a, g) => a + g.seats, 0);
    return `<div class="rg-bar" role="img" aria-label="Composição">${items.filter((g) => g.seats > 0).map((g) => `<i title="${esc(g.abbr)}: ${g.seats}" style="width:${100 * g.seats / tt}%;background:${colOf(g.abbr)}"></i>`).join("")}</div>
      <div class="rg-leg">${items.filter((g) => g.seats > 0).map((g) => `<span><b style="background:${colOf(g.abbr)}"></b>${esc(g.abbr)} <b style="all:unset;font-weight:700">${g.seats}</b></span>`).join("")}</div>`;
  }

  /* ---------- Governo ---------- */
  async function tabGoverno(r) {
    const [ov, d] = await Promise.all([get("overview", r), get("governo", r)]);
    const spend = (s) => s.spend ? `<div class="small"><b>${M(s.spend.value)}</b> contratados em ${num(s.spend.n)} contratos · ${Portal.pct(100 * s.spend.direct_value / (s.spend.value || 1))} do valor por ajuste direto</div>` : "";
    const budget = (s) => s.budget && s.budget.length ? `<div class="small">Despesa orçamentada (ORAM): ${s.budget.map((b) => `${b.year}: <b>${M(b.amount)}</b>`).join(" · ")}</div>` : "";
    const cc = d.crosscheck || [];
    const dv = cc.filter((c) => c.status !== "ok");
    const ccBlock = r === "madeira"
      ? `<div class="panel"><h3>Verificação cruzada de titulares</h3>
         <p class="small">Fonte A: <b>madeira.gov.pt</b> (oficial, página «Secretarias»). Fonte B: <b>Wikipedia</b> (XVI Governo Regional). ${cc.length - dv.length} de ${cc.length} cargos coincidem${dv.length ? "" : " (nenhuma divergência)"}.</p>
         ${dv.length ? `<table class="tbl"><tr><th>Pasta</th><th>madeira.gov.pt</th><th>Wikipedia</th><th>Nota</th></tr>${dv.map((c) => `<tr><td>${esc(c.portfolio)}</td><td>${esc(c.name_a || "—")}</td><td class="rg-dv">${esc(c.name_b || "—")}</td><td>${esc(c.note || "")}</td></tr>`).join("")}</table>` : ""}
         <p class="note small">O partido de cada titular só consta da Wikipedia (o site oficial não o indica); campos em branco = sem partido indicado na fonte.</p></div>`
      : `<p class="note warn"><b>Só uma fonte para os titulares.</b> O portal oficial do Governo dos Açores (portal.azores.gov.pt) está protegido por verificação anti-bot e não pôde ser lido; os nomes vêm da Wikipedia (XIV Governo Regional dos Açores), que cita os Decretos do Representante da República n.º 1/2024 e 2/2024. Não há por isso reconciliação entre duas fontes — consulte o <a href="https://portal.azores.gov.pt" target="_blank" rel="noopener">portal oficial</a> para confirmar.</p>`;
    const mem = ov.members;
    return `
      <div class="panel"><h3>${esc(d.region?.gov_label || "Governo Regional")}</h3>
        <p class="small muted">Em funções desde ${esc(String(d.region?.gov_since || ""))} · ${mem.length} membros · ${ext(d.region?.gov_url, "fonte")}</p>
        <table class="tbl"><tr><th>Cargo / pasta</th><th>Titular</th><th>Partido</th><th>Desde</th></tr>
        ${mem.map((m) => `<tr><td>${esc(m.role)}</td><td><b>${esc(m.name)}</b></td><td>${m.party ? `<span class="tag">${esc(m.party)}</span>` : '<span class="muted">—</span>'}</td><td>${esc(m.since || "—")}</td></tr>`).join("")}</table>
        ${d.members.filter((m) => !m.current).length ? `<p class="small muted">Saíram nesta legislatura: ${d.members.filter((m) => !m.current).map((m) => `${esc(m.name)} (${esc(m.role.replace(/Secretári[oa] Regional d[aeo]s? /, ""))})`).join("; ")}.</p>` : ""}
      </div>${ccBlock}
      <h2>Secretarias regionais e organismos</h2>
      <p class="small muted">Para cada pasta: titular, organismos tutelados (direções regionais, institutos, empresas) e a contratação pública dos organismos que conseguimos associar por nome. A atribuição é por correspondência de nomes — pode estar incompleta.</p>
      ${d.secretarias.map((s) => {
        const bs = s.bodies.filter((b) => b.current !== 0);
        const byKind = {};
        for (const b of bs) (byKind[b.kind] ||= []).push(b);
        return `<div class="rg-sec"><h3>${esc(s.name)}</h3>
          <div>${s.holder ? `Titular: <b>${esc(s.holder)}</b>` : '<span class="muted">sem titular na fonte</span>'} ${s.url ? `· ${ext(s.url, "página")}` : ""}</div>
          ${budget(s)}${spend(s)}
          ${bs.length ? `<details><summary class="small">${bs.length} organismos</summary>
            <table class="tbl"><tr><th>Organismo</th><th>Tipo</th><th>Dirigente</th><th>Desde</th></tr>${["direcao_regional", "instituto", "empresa", "inspecao", "outro"].flatMap((k) => byKind[k] || []).map((b) => `<tr><td>${esc(b.name)}</td><td class="small">${esc(KIND[b.kind] || b.kind)}</td><td>${b.holder ? esc(b.holder) + (b.holder_role && b.holder_role !== b.name ? ` <span class="muted small">(${esc(b.holder_role)})</span>` : "") : '<span class="muted">—</span>'}</td><td class="small">${esc(b.since || "")}</td></tr>`).join("")}</table>
            <p class="small muted">Fonte: ${esc([...new Set(bs.map((b) => b.source))].join("; "))}</p></details>` : '<p class="small muted">Sem organismos listados nas fontes obtidas.</p>'}
        </div>`;
      }).join("")}
      ${note(d.blocked)}`;
  }

  /* ---------- Assembleia ---------- */
  async function tabAssembleia(r) {
    const d = await get("assembleia", r, "&limit=60");
    const inFn = d.deputies.filter((x) => x.status === "em funções");
    const others = d.deputies.filter((x) => x.status !== "em funções");
    const g = d.groups.map((x) => ({ abbr: x.abbr, seats: x.seats }));
    const roles = inFn.filter((x) => x.role);
    const el = d.elections[0];
    const compNote = el && r === "acores" ? `<p class="note small">Composição atual (deputados em funções, por partido) vs. eleição ${el.year}: a coligação PSD/CDS/PPM concorreu em conjunto, pelo que os seus ${(el.rows[0] || {}).seats ?? "—"} mandatos aparecem aqui repartidos por partido; substituições alteram os totais.</p>` : "";
    return `
      <div class="panel"><h3>${esc(d.region?.assembly_name || "Assembleia Legislativa")} — ${esc(d.region?.legislature || "")} Legislatura</h3>
        ${seatBar(g)}${compNote}
        ${roles.length ? `<p class="small"><b>Mesa e lideranças:</b> ${roles.map((x) => `${esc(x.name)} (${esc(x.role)})`).join("; ")}</p>` : ""}
        <p class="small muted">${inFn.length} deputados em funções${others.length ? ` · ${others.length} que exerceram funções na legislatura e foram substituídos` : ""} · ${ext(d.region?.assembly_url, "site da assembleia")}</p>
      </div>
      ${d.circles.length && r === "acores" ? `<div class="panel"><h3>Deputados por círculo eleitoral</h3>${hbars(d.circles.map((c) => ({ label: esc(c.circle), v: c.n })), { fmt: (v) => v })}</div>` : r === "madeira" ? '<p class="note small">A Madeira elege num círculo único regional.</p>' : ""}
      <div class="panel"><h3>Deputados em funções</h3>
        <details open><summary class="small">Mostrar / ocultar lista (${inFn.length})</summary>
        <table class="tbl"><tr><th>Nome</th><th>Partido / grupo</th>${r === "acores" ? "<th>Círculo</th>" : "<th>Cargo</th>"}</tr>
        ${inFn.map((x) => `<tr><td>${x.source_url && r === "acores" ? ext(x.source_url, x.name) : esc(x.full_name || x.name)}</td><td><span class="tag" style="border-left:4px solid ${colOf(x.party)}">${esc(x.party)}</span></td><td>${esc(r === "acores" ? x.circle : (x.role || ""))}</td></tr>`).join("")}</table></details>
      </div>
      ${d.committees.length ? `<div class="panel"><h3>Comissões permanentes</h3><table class="tbl"><tr><th>Comissão</th><th class="num">Iniciativas em apreciação</th></tr>${d.committees.map((c) => `<tr><td>${ext(c.url, c.name)} <span class="muted small">(${esc(c.abbr)})</span></td><td class="num">${c.n_pending ?? "—"}</td></tr>`).join("")}</table>
        ${d.agenda.length ? `<h4>Agenda das comissões</h4><ul class="small">${d.agenda.map((a) => `<li>${esc(a.when_txt.replace(" - Hora - ", " às "))} — ${esc(a.title)} <span class="muted">(${esc(a.committee)})</span></li>`).join("")}</ul>` : ""}</div>` : '<p class="note small">Comissões e agenda não disponíveis em formato estruturado para esta assembleia.</p>'}
      <div class="panel"><h3>Iniciativas legislativas (projetos e propostas de decreto legislativo regional)</h3>
        <p class="small muted">${num(d.initiatives_total)} iniciativas na base ${r === "madeira" ? "(a pesquisa da ALRAM só devolve as 1 800 mais recentes de todos os tipos; legislaturas XII a XV)" : "(XIII Legislatura)"}. Mostram-se as 60 mais recentes.</p>
        <table class="tbl"><tr><th>Data</th><th>N.º</th><th>Tipo</th><th>Assunto</th><th>Autor</th><th>Estado</th></tr>
        ${d.initiatives.map((i) => `<tr><td class="small">${dt(i.date)}</td><td class="small">${esc(i.number || "")}</td><td class="small">${esc(i.kind.startsWith("Proposta") ? "Proposta (Governo)" : "Projeto")}</td><td>${ext(i.url, (i.title || "(sem título)").slice(0, 200))}</td><td class="small">${esc(i.author || "")}</td><td class="small">${esc(i.phase_label || (i.result || "Em curso"))}</td></tr>`).join("")}</table>
        ${r === "madeira" ? '<p class="small muted">Estado derivado do código de fase da ALRAM (ex.: «Encerrada: publicada» = GAPR_PublicadoEncerr); a interpretação dos códigos é nossa.</p>' : ""}
      </div>
      <div class="panel"><h3>Legislação regional publicada (Decretos Legislativos Regionais, Diário da República)</h3>
        ${hbarsYears(d.dlr_per_year)}
        <table class="tbl"><tr><th>Data</th><th>Diploma</th><th>Sumário</th></tr>${d.acts.map((a) => `<tr><td class="small">${dt(a.date)}</td><td>${ext(a.url, "DLR " + a.number)}</td><td class="small">${esc((a.summary || a.title || "").slice(0, 220))}</td></tr>`).join("")}</table>
        <p class="small muted">Fonte: módulo DRE do portal (data/dre.db). Cobertura: ver página DRE.</p></div>
      ${note(d.blocked)}`;
  }

  function hbarsYears(rows) {
    const ys = rows.filter((x) => +x.y >= 2000);
    if (!ys.length) return "";
    const mx = Math.max(...ys.map((x) => x.n));
    return `<div class="rg-yr">${ys.map((y) => `<div style="height:${100 * y.n / mx}%" title="${y.y}: ${y.n} decretos"></div>`).join("")}</div><div class="rg-yrl">${ys.map((y, i) => `<span>${i % 2 ? "" : String(y.y).slice(2)}</span>`).join("")}</div>
      <p class="small muted">Decretos legislativos regionais por ano (${ys[0].y}–${ys[ys.length - 1].y}).</p>`;
  }

  /* ---------- Eleições ---------- */
  async function tabEleicoes(r) {
    const d = await get("assembleia", r, "&limit=1");
    if (!d.elections.length) return '<p class="note warn">Sem resultados eleitorais obtidos.</p>';
    const fmt = (v) => (v != null ? v.toFixed(2).replace(".", ",") + "%" : "—");
    const ck = d.election_check || [], cn = d.election_check_n || {};
    return `<p class="small muted">Eleições legislativas regionais. Fonte principal: <b>resultados oficiais da MAI</b> (mesma base do módulo Eleições). A percentagem principal é sobre os <b>votos válidos</b>; indica-se também a % sobre os votantes. Açores 2016 não existe na MAI: vem da Wikipedia (base da percentagem não verificada).</p>
      ${d.elections.map((e) => {
        const seats = e.rows.filter((x) => x.seats > 0).map((x) => ({ abbr: x.abbr, seats: x.seats }));
        const tot = e.rows[0]?.total_seats, m = e.meta || {};
        const mai = e.source === "MAI";
        return `<div class="panel"><h3>Eleições ${e.year} ${m.date ? `<span class="muted small">(${dt(m.date)})</span>` : ""} ${ext(e.source_url, mai ? "MAI" : "Wikipedia")}</h3>
          ${m.registered ? `<p class="small muted">Inscritos ${num(m.registered)} · votantes ${num(m.voters)} · participação ${fmt(m.turnout)} · brancos ${num(m.blank)} · nulos ${num(m.null_votes)}</p>` : ""}
          ${seats.length ? seatBar(seats, tot) : ""}
          <table class="tbl" style="margin-top:10px"><tr><th>Lista</th><th class="num">Votos</th><th class="num">% votos válidos</th>${mai ? '<th class="num">% votantes</th>' : ""}<th class="num">Mandatos</th></tr>
          ${e.rows.map((x) => `<tr><td><span class="tag" style="border-left:4px solid ${colOf(x.abbr)}">${esc(x.abbr.length > 14 ? "" : x.abbr)}</span> ${esc(x.party)}</td><td class="num">${num(x.votes)}</td><td class="num">${fmt(x.pct)}${mai ? "" : "*"}</td>${mai ? `<td class="num">${fmt(x.pct_voters)}</td>` : ""}<td class="num">${x.seats ?? "—"}</td></tr>`).join("")}</table>
          ${mai ? "" : '<p class="small muted">* percentagem tal como na Wikipedia; a base (votos válidos ou votantes) não foi verificada.</p>'}</div>`;
      }).join("")}
      <details class="panel"><summary><b>Reconciliação com a Wikipedia</b></summary>
        <p class="small">Comparámos ${cn.n ?? 0} listas com a Wikipedia. A Wikipedia mistura bases de percentagem entre eleições (votos válidos nuns casos, votantes noutros): ${cn.base_diff ?? 0} listas diferem em mais de 0,1 p.p. da % de votos válidos da MAI por esse motivo. Diferenças de votos (a MAI prevalece):</p>
        ${ck.length ? `<table class="tbl"><tr><th>Eleição</th><th>Lista</th><th class="num">Votos Wikipedia</th><th class="num">Votos MAI</th><th class="num">Dif.</th></tr>${ck.map((c) => `<tr><td>${c.year}</td><td>${esc(c.party)}</td><td class="num">${num(c.votes_wp)}</td><td class="num">${num(c.votes_mai)}</td><td class="num rg-dv">${c.dvotes > 0 ? "+" : ""}${c.dvotes}</td></tr>`).join("")}</table>` : '<p class="small muted">Sem diferenças de votos.</p>'}</details>
      ${note(d.blocked)}`;
  }

  /* ---------- Orçamento ---------- */
  async function tabOrcamento(r) {
    const d = await get("governo", r);
    const tot = d.budget_totals || [];
    const yrs = [...new Set(d.budget.map((b) => b.year))].sort((a, b) => b - a);
    const acts = d.budget_acts || [];
    let body = "";
    if (r === "madeira" && tot.length) {
      const y0 = yrs[0];
      const t = (y, s) => tot.find((x) => x.year === y && x.scope === s);
      body += `<div class="kpis">${yrs.map((y) => stat(M(t(y, "despesa_total")?.amount), `despesa orçamentada ${y}`)).join("")}${yrs.map((y) => stat(M(t(y, "receita_corrente_capital")?.amount), `receitas correntes + capital ${y}`)).join("")}${stat(M(t(y0, "sfa_total")?.amount), `receita dos serviços e fundos autónomos ${y0}`)}</div>`;
      for (const y of yrs) {
        const rows = d.budget.filter((b) => b.year === y);
        body += `<div class="panel"><h3>Despesa por departamento regional — ORAM ${y}</h3>
          ${hbars(rows.map((b) => ({ label: esc(b.name.replace("Secretaria Regional de ", "SR ").replace("Secretaria Regional das ", "SR ")), v: b.amount })))}
          <p class="small muted">Fonte: ${ext(rows[0]?.source_url, "Proposta de Orçamento da RAM " + y + " (Mapa II)")}. Texto obtido por OCR de PDF digitalizado: confira no original antes de citar. Inclui despesa do Plano (investimentos).</p></div>`;
      }
      const sfa = d.sfa.filter((x) => x.year === y0).slice(0, 15);
      body += `<div class="panel"><h3>Maiores serviços, institutos e empresas — receita global ${y0} (Mapa V)</h3>${hbars(sfa.map((b) => ({ label: esc(b.name), v: b.amount })))}</div>`;
    } else {
      body += '<p class="note warn"><b>Sem totais orçamentais.</b> O portal do Governo dos Açores (DROT/SRFPAP) bloqueia robôs e os mapas orçamentais não constam do texto publicado no Diário da República; só se listam os decretos que aprovam o Orçamento.</p>';
    }
    body += `<div class="panel"><h3>Decretos Legislativos Regionais que aprovam o Orçamento da Região</h3>${acts.length ? `<table class="tbl"><tr><th>Ano orçamental</th><th>Diploma</th><th>Data</th></tr>${acts.map((a) => `<tr><td>${a.year}</td><td>${ext(a.url, "DLR " + a.number)}</td><td>${dt(a.date)}</td></tr>`).join("")}</table>` : '<p class="small muted">Nenhum identificado.</p>'}
      <p class="small muted">Execução orçamental e dívida pública regional: não obtidas (ver limites abaixo).</p></div>${note(d.blocked)}`;
    return body;
  }

  /* ---------- Contratos ---------- */
  async function tabContratos(r, grp) {
    const d = await get("contratos", r, grp ? "&grupo=" + encodeURIComponent(grp) : "");
    const t = d.total;
    const dshare = t.value ? 100 * t.dv / t.value : 0;
    const link = (b) => `${b.eid ? `<a href="#/entidade/${b.eid}">${esc(b.name)}</a>` : esc(b.name)} <a class="small" href="#/contratos?buyer=${esc(b.nif)}" title="ver contratos">contratos →</a>`;
    const ys = d.years.filter((y) => y.year >= 2012);
    const mx = Math.max(1, ...ys.map((y) => y.value));
    return `<div class="kpis">${stat(num(d.n_buyers), "entidades adjudicantes identificadas")}${stat(num(t.n), "contratos (2012–hoje)")}${stat(M(t.value), "valor contratual")}${stat(Portal.pct(dshare, 1), "do valor por ajuste direto")}${stat(Portal.pct(t.n ? 100 * t.dn / t.n : 0, 1), "dos contratos por ajuste direto")}</div>
      <p class="note small">${esc(d.method || "")} Heurística: pode incluir entidades de outras regiões com maioria de contratos na Região e excluir as sem local registado.</p>
      <div class="panel"><h3>Valor contratado por ano <span class="muted small">(a vermelho: ajuste direto)</span></h3>
        <div class="rg-yr" style="height:120px">${ys.map((y) => `<div style="height:${100 * y.value / mx}%" title="${y.year}: ${M(y.value)} · ${num(y.n)} contratos"><u style="height:${y.value ? 100 * y.direct_value / y.value : 0}%"></u></div>`).join("")}</div>
        <div class="rg-yrl">${ys.map((y, i) => `<span>${i % 2 ? "" : String(y.year).slice(2)}</span>`).join("")}</div></div>
      <div class="cols">
        <div class="panel"><h3>Por tipo de entidade</h3>
          <table class="tbl"><tr><th>Grupo</th><th class="num">Entid.</th><th class="num">Valor</th><th class="num">% ajuste direto (valor)</th></tr>
          ${d.groups.map((g) => `<tr><td><a href="#/regioes/${r}?tab=contratos&grupo=${g.grp}">${esc(GRP[g.grp] || g.grp)}</a></td><td class="num">${num(g.n_buyers)}</td><td class="num">${M(g.value)}</td><td class="num">${Portal.pct(g.value ? 100 * g.direct_value / g.value : 0, 1)}</td></tr>`).join("")}</table></div>
        <div class="panel"><h3>Por secretaria regional (organismos associados)</h3>
          <table class="tbl"><tr><th>Secretaria</th><th class="num">Valor</th><th class="num">% aj. direto</th></tr>
          ${d.secretarias.map((s) => `<tr><td>${esc(s.name || (s.secretaria_key === "pres" ? "Presidência" : s.secretaria_key === "vice" ? "Vice-Presidência" : s.secretaria_key))}</td><td class="num">${M(s.value)}</td><td class="num">${Portal.pct(s.value ? 100 * s.direct_value / s.value : 0, 1)}</td></tr>`).join("")}</table>
          <p class="small muted">Só organismos cujo nome corresponde a um organismo tutelado listado na aba Governo.</p></div>
      </div>
      <div class="panel"><h3>Maiores entidades adjudicantes${grp ? ` — ${esc(GRP[grp] || grp)} <a class="small" href="#/regioes/${r}?tab=contratos">(ver todas)</a>` : ""}</h3>
        <table class="tbl"><tr><th>Entidade</th><th>Tipo</th><th class="num">Contratos</th><th class="num">Valor</th><th class="num">% aj. direto</th></tr>
        ${d.buyers.map((b) => `<tr><td>${link(b)}</td><td class="small">${esc(GRP[b.grp] || b.grp)}</td><td class="num">${num(b.n)}</td><td class="num">${M(b.value)}</td><td class="num">${Portal.pct(b.value ? 100 * b.direct_value / b.value : 0, 0)}</td></tr>`).join("")}</table></div>
      <div class="cols">
        <div class="panel"><h3>Maiores fornecedores</h3>
          <table class="tbl"><tr><th>Fornecedor</th><th class="num">Contratos</th><th class="num">Valor</th></tr>
          ${d.suppliers.map((s) => `<tr><td>${s.eid ? `<a href="#/entidade/${s.eid}">${esc(s.name)}</a>` : esc(s.name)}</td><td class="num">${num(s.n)}</td><td class="num">${M(s.value)}</td></tr>`).join("")}</table></div>
        <div class="panel"><h3>Procedimentos (por valor)</h3>${hbars(d.procedures.map((p) => ({ label: esc(p.procedure), v: p.value, extra: num(p.n) })))}</div>
      </div>
      <p class="small muted">Fonte: Portal BASE / IMPIC via base de dados do portal (contracts, entities). Valores = preço contratual, sem IVA.</p>`;
  }

  Portal.page("regioes", async (arg, params) => {
    params = params || {};
    const r = arg === "madeira" ? "madeira" : "acores";
    const tab = TABS.some((t) => t[0] === params.tab) ? params.tab : "governo";
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Poder regional</div><h1>Regiões autónomas</h1>
      <div class="small muted">Governos regionais, assembleias legislativas, eleições, orçamento e contratação pública dos Açores e da Madeira.</div></div></div>
      <div class="tabs">${REGS.map(([k, n]) => `<a class="${k === r ? "on" : ""}" href="#/regioes/${k}${tab !== "governo" ? "?tab=" + tab : ""}">${n}</a>`).join("")}</div>
      <div id="rg-kpi"></div>
      <div class="tabs">${TABS.map(([k, n]) => `<a class="${k === tab ? "on" : ""}" href="#/regioes/${r}?tab=${k}">${n}</a>`).join("")}</div>
      <div id="rg-body"><p class="muted">A carregar…</p></div>`;
    try {
      const ov = await get("overview", r);
      if (ov.error) { document.getElementById("rg-body").innerHTML = `<p class="note warn">${esc(ov.error)}</p>`; return; }
      const pres = ov.members.find((m) => /Presidente do Governo/.test(m.role));
      const bud = ov.budget.find((b) => b.scope === "despesa_total");
      document.getElementById("rg-kpi").innerHTML = `<div class="kpis">
        ${stat(esc(pres ? pres.name : "—"), "Presidente do Governo Regional" + (pres?.party ? " · " + esc(pres.party) : ""))}
        ${stat(num(ov.members.length), "membros do Governo Regional")}
        ${stat(`${num(ov.seats)} deputados`, esc(ov.region.assembly_name.replace("Assembleia Legislativa da Região Autónoma d", "ALR d").replace(/\s*\(.*\)/, "")))}
        ${stat(ov.winner ? esc(ov.winner.abbr) + " " + ov.winner.pct.toFixed(1).replace(".", ",") + "%" : "—", `mais votado em ${ov.last_election || "—"}`)}
        ${stat(bud ? M(bud.amount) : "n/d", bud ? `despesa orçamentada ${bud.year}` : "orçamento: sem totais")}
        ${stat(M(ov.contracts.value), `contratação pública (${Portal.pct(ov.contracts.value ? 100 * ov.contracts.direct_value / ov.contracts.value : 0, 0)} ajuste direto)`)}</div>`;
      const fn = { governo: tabGoverno, assembleia: tabAssembleia, eleicoes: tabEleicoes, orcamento: tabOrcamento, contratos: (x) => tabContratos(x, params.grupo) }[tab];
      document.getElementById("rg-body").innerHTML = await fn(r);
    } catch (e) {
      document.getElementById("rg-body").innerHTML = `<p class="note warn">Erro ao carregar: ${esc(String(e.message || e))}</p>`;
    }
  });
})();
