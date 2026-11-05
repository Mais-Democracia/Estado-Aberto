"use strict";
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT");
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>.pv-svg{width:100%;height:auto;max-height:280px}.pv-svg text{fill:var(--muted);font:11px system-ui}.pv-svg rect{fill:var(--bar);cursor:pointer}.pv-svg rect:hover{fill:#c0392b}.pv-svg .gr{stroke:var(--line2)}
  .pv-q{font-size:.82rem;color:var(--muted);font-style:italic;margin:.1rem 0 0}.pv-bar{display:inline-block;height:9px;background:var(--bar);border-radius:2px;vertical-align:middle}</style>`;

  function chart(rows) {
    if (!rows.length) return '<p class="note">Sem série de processos abertos extraída.</p>';
    const W = 720, H = 250, L = 52, R = 10, T = 12, B = 30;
    const max = Math.max(...rows.map((r) => r.value));
    const bw = (W - L - R) / rows.length;
    const grid = [0, 0.5, 1].map((q) => { const y = T + (H - T - B) * (1 - q); return `<line class="gr" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 5}" y="${y + 4}" text-anchor="end">${nf.format(Math.round(max * q))}</text>`; }).join("");
    const bars = rows.map((r, i) => {
      const h = (H - T - B) * (r.value / max), x = L + i * bw;
      return `<a href="#/provedor?ano=${r.year}"><rect x="${x + 1}" y="${T + (H - T - B) - h}" width="${Math.max(bw - 2, 1)}" height="${h}"><title>${r.year}: ${nf.format(r.value)}</title></rect></a>${i % 3 === 0 ? `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${r.year}</text>` : ""}`;
    }).join("");
    return `<svg class="pv-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Processos abertos por ano">${grid}${bars}</svg>`;
  }

  const statTable = (rows, kind, title) => {
    const r = rows.filter((x) => x.metric === kind);
    if (!r.length) return "";
    const max = Math.max(...r.map((x) => x.value));
    return `<h3>${title}</h3>${Portal.table([
      { h: "Rubrica", f: (x) => esc(x.label) },
      { h: "Valor", f: (x) => `${nf.format(x.value)} <span class="pv-bar" style="width:${Math.round((120 * x.value) / max)}px"></span>` },
      { h: "Linha citada (p. " + "PDF)", f: (x) => `<span class="pv-q">«${esc(x.quote)}»</span>${x.page ? ` <span class="muted small">p. ${x.page}</span>` : ""}` }], r)}`;
  };

  Portal.page("provedor", async (arg, params) => {
    const ov = await Portal.api("provedor/overview");
    if (ov.available === false) { $app.innerHTML = `<div class="crumbs"><a href="#/">Início</a> / Provedor de Justiça</div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const ano = params && (params.ano || params.get?.("ano"));
    const series = ov.series.filter((s) => s.metric === "opened");
    const yr = ano ? await Portal.api("provedor/year?year=" + encodeURIComponent(ano)) : null;
    const detail = yr && yr.report ? `<section class="panel"><h2>${esc(yr.report.title)}</h2>
      <p class="small">${yr.report.published ? "Publicado em " + esc(Portal.fmtDate(yr.report.published)) + ". " : ""}${ext(yr.report.pdf_url, "Relatório (PDF)")} · ${ext(yr.report.page_url, "Página no site da Provedoria")}${yr.report.pages ? ` · ${yr.report.pages} páginas` : ""}</p>
      ${yr.stats.length ? `<table class="tbl"><tbody>${yr.stats.filter((s) => ["opened", "written", "verbal"].includes(s.metric)).map((s) => `<tr><td>${esc(s.label)}</td><td><b>${nf.format(s.value)}</b></td><td><span class="pv-q">«${esc(s.quote)}»</span>${s.page ? ` <span class="muted small">p. ${s.page}</span>` : ""}</td></tr>`).join("")}</tbody></table>
      ${statTable(yr.stats, "area", "Assuntos das queixas (tabela do relatório)")}${statTable(yr.stats, "entity", "Entidades mais visadas (do relatório)")}` : `<p class="note">${yr.report.text_ok ? "Nenhum número extraído automaticamente deste relatório (os valores estão em gráficos sem texto legível); consulte o PDF." : "O PDF deste relatório é digitalizado (sem texto pesquisável) ou não foi possível lê-lo; consulte o PDF."}</p>`}</section>` : (ano ? `<p class="note warn">Sem relatório para ${esc(ano)}.</p>` : "");
    $app.innerHTML = `${css}<div class="crumbs"><a href="#/">Início</a> / Provedor de Justiça</div>
      <div class="pagehead"><div><div class="kicker">Provedoria de Justiça</div><h1>Relatórios anuais do Provedor de Justiça</h1>
      <p class="small muted">${ov.counts.n} relatórios à Assembleia da República (${ov.counts.y0}–${ov.counts.y1}), com texto pesquisável em ${ov.counts.with_text}. Os números são extraídos do texto do PDF e acompanhados da linha citada; onde o relatório só tem gráficos, não se extrai nada. Fonte: ${ext(ov.source, "provedor-jus.pt")}.</p></div></div>
      ${detail}
      <section class="panel"><h2>Processos abertos por ano</h2>${chart(series)}
      <p class="small muted">${series.length} de ${ov.counts.n} anos com valor extraído. Os critérios de contagem mudaram ao longo dos anos (processos, procedimentos); clique numa barra para ver a linha citada.</p></section>
      <section class="panel"><h2>Todos os relatórios</h2>${Portal.table([
        { h: "Ano", f: (r) => `<a href="#/provedor?ano=${r.year}">${r.year}</a>` },
        { h: "Relatório", f: (r) => ext(r.pdf_url, r.title) },
        { h: "Publicado", f: (r) => (r.published ? esc(Portal.fmtDate(r.published)) : "—") },
        { h: "Processos abertos", f: (r) => (r.opened != null ? nf.format(r.opened) : `<span class="muted">${r.text_ok ? "não extraído" : "sem texto"}</span>`) },
        { h: "Página", f: (r) => ext(r.page_url, "ver") }], ov.reports)}</section>
      ${ov.errors ? `<p class="small muted">Erros na última recolha: ${esc(ov.errors)}</p>` : ""}
      <p class="small muted">Atualizado em ${esc(ov.built || "—")}.</p>`;
  });
  Portal.nav("Provedor de Justiça", "#/provedor");
})();
