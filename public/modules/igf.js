"use strict";
(() => {
  const { esc } = Portal;
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const KIND = { municipio: "Município", entidade: "Empresa / entidade", tematico: "Temático" };
  const cols = (withEnt) => [
    { h: "Ano", f: (r) => esc(r.year || "") },
    { h: "Relatório", f: (r) => esc(r.code) },
    { h: "Auditoria", f: (r) => esc(r.title) },
    { h: "Tipo", f: (r) => `<span class="tag">${esc(KIND[r.kind] || r.kind)}</span>` },
    ...(withEnt ? [{ h: "Entidade no portal", f: (r) => (r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.ename)}</a>` : `<span class="muted">—</span>`) }] : []),
    { h: "Documentos", f: (r) => `${r.report_url ? ext(r.report_url, "Relatório PDF") + " · " : ""}${ext(r.source_url, "IGF")}` },
  ];

  Portal.nav("IGF", "#/igf");
  Portal.page("igf", async (arg, p) => {
    p = p || {};
    try {
      const [ov, list] = await Promise.all([Portal.api("igf/overview"), Portal.api("igf/relatorios" + Portal.qs({ q: p.q, year: p.year, kind: p.kind, page: p.page }))]);
      if (ov.available === false) { $app.innerHTML = `<div class="pagehead"><div><h1>IGF</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
      const maxN = Math.max(...ov.years.map((y) => y.n), 1);
      const bars = ov.years.map((y) => `<tr><td><a href="#/igf${Portal.qs({ year: y.year })}">${y.year}</a></td><td style="width:60%"><div style="background:var(--bar);height:12px;width:${Math.round((100 * y.n) / maxN)}%"></div></td><td>${y.n}</td><td class="small muted">${y.municipios} municípios · ${y.entidades} entidades · ${y.tematicos} temáticos</td></tr>`).join("");
      const errs = (() => { try { return JSON.parse(ov.errors || "[]"); } catch { return []; } })();
      $app.innerHTML = `<div class="crumbs"><a href="#/">Início</a> / IGF</div>
        <div class="pagehead"><div><div class="kicker">Inspeção-Geral de Finanças</div><h1>Auditorias à administração local</h1>
        <p class="small muted">Relatórios publicados pelo IGF sobre municípios e entidades da administração local autárquica. Fonte: ${ext(ov.source, "igf.gov.pt")} (recolha de ${esc(ov.built || "—")}).</p></div></div>
        <div class="kpis"><div class="kpi"><b>${ov.total.n}</b><span>relatórios na base</span></div><div class="kpi"><b>${ov.total.y0}–${ov.total.y1}</b><span>anos cobertos</span></div>
        <div class="kpi"><b>${ov.total.linked}</b><span>ligados a entidades do portal</span></div></div>
        <p class="note">${esc(ov.note)}</p>${errs.length ? `<p class="note warn">${errs.length} página(s) do IGF não foram obtidas na última recolha.</p>` : ""}
        <section class="panel"><h2>Relatórios por ano</h2><table class="tbl"><tbody>${bars}</tbody></table></section>
        <section class="panel"><h2>Relatórios${p.year ? " de " + esc(p.year) : ""}</h2>
        <form class="ju-filters" onsubmit="event.preventDefault();var f=this;Portal.go('igf','',{q:f.q.value,year:f.year.value,kind:f.kind.value})" style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px">
        <input type="search" name="q" value="${esc(p.q || "")}" placeholder="Pesquisar no título" style="flex:1;min-width:220px">
        <select name="year"><option value="">Todos os anos</option>${ov.years.map((y) => `<option value="${y.year}" ${String(p.year) === String(y.year) ? "selected" : ""}>${y.year}</option>`).join("")}</select>
        <select name="kind"><option value="">Todos os tipos</option>${ov.kinds.map((k) => `<option value="${esc(k.kind)}" ${p.kind === k.kind ? "selected" : ""}>${esc(KIND[k.kind] || k.kind)} (${k.n})</option>`).join("")}</select>
        <button type="submit">Filtrar</button></form>
        <p class="small muted">${list.total} resultado(s).</p>
        ${list.rows.length ? Portal.table(cols(true), list.rows) : '<p class="note">Sem relatórios para esta seleção.</p>'}
        ${Portal.pager ? Portal.pager(list.total, list.page, list.limit, (n) => "#/igf" + Portal.qs({ q: p.q, year: p.year, kind: p.kind, page: n })) : ""}</section>`;
    } catch (e) {
      $app.innerHTML = `<div class="pagehead"><div><h1>IGF</h1></div></div><p class="note warn">Não foi possível carregar os dados (${esc(String(e.message || e))}).</p>`;
    }
  });

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || !e.id) return;
    const d = await Portal.api("igf/entidade?id=" + e.id).catch(() => null);
    if (!d || !d.rows || !d.rows.length) return;
    el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Auditorias do IGF</h2>
      <p class="small muted">${d.rows.length} relatório(s) do IGF. ${esc(d.method)}.</p>
      ${Portal.table([{ h: "Ano", f: (r) => esc(r.year || "") }, { h: "Auditoria", f: (r) => esc(r.title) },
        { h: "Documentos", f: (r) => `${r.report_url ? ext(r.report_url, "Relatório PDF") + " · " : ""}${ext(r.source_url, "IGF")}` }], d.rows)}
      <p class="small"><a href="#/igf">Ver todos os relatórios →</a></p></section>`);
  });
})();
