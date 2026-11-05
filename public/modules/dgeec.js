"use strict";
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const n0 = (v) => (v == null ? "—" : Portal.int(Math.round(v)));
  const COLORS = ["var(--bar)", "var(--bar2)", "var(--accent, #b45309)", "var(--muted)", "var(--line2)"];
  const css = `<style>.dg-svg{width:100%;height:auto;max-height:240px}.dg-svg text{fill:var(--muted);font:11px system-ui}.dg-svg .gr{stroke:var(--line2)}.dg-svg path{fill:none;stroke-width:2.2}
  .dg-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}.dg-grid h3{margin:.2rem 0}.dg-bar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px;align-items:center}
  .dg-leg{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.dg-leg i{display:inline-block;width:10px;height:10px;margin-right:4px;border-radius:2px}</style>`;
  Portal.nav("Educação (DGEEC)", "#/dgeec");

  function lines(series) {
    const pts = series.flatMap((s) => s.pts);
    if (!pts.length) return '<p class="note">Sem dados.</p>';
    const xs = [...new Set(pts.map((p) => p.x))].sort();
    const W = 520, H = 210, L = 56, R = 12, T = 12, B = 26;
    const min = Math.min(0, ...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v), 1);
    const X = (x) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) * (W - L - R)) / (xs.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const grid = [0, 0.5, 1].map((f) => { const v = min + (max - min) * f; return `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(nf.format(Math.round(v)))}</text>`; }).join("");
    const step = Math.ceil(xs.length / 6);
    const xl = xs.map((x, i) => (i % step === 0 || i === xs.length - 1 ? `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${esc(x)}</text>` : "")).join("");
    const paths = series.map((s, i) => `<path stroke="${COLORS[i % COLORS.length]}" d="${s.pts.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ")}"><title>${esc(s.label)}</title></path>`).join("");
    const leg = series.length > 1 ? `<div class="dg-leg">${series.map((s, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
    return `<svg class="dg-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="série temporal">${grid}${xl}${paths}</svg>${leg}`;
  }
  const group = (rows, skip) => {
    const m = new Map();
    for (const r of rows) { if (skip && skip.test(r.series)) continue; const k = r.grp ? `${r.grp} · ${r.series}` : r.series; if (!m.has(k)) m.set(k, []); m.get(k).push({ x: r.year, v: r.value }); }
    return [...m].map(([label, pts]) => ({ label, pts }));
  };
  const panel = (t, body, note) => `<section class="panel"><h3>${esc(t)}</h3>${body}${note ? `<p class="small muted">${note}</p>` : ""}</section>`;
  const kpi = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;
  const last = (rows, series) => rows.filter((r) => r.series === series).pop();

  Portal.page("dgeec", async (arg, params) => {
    $app.innerHTML = css + '<p class="note">A carregar…</p>';
    const o = await Portal.api("dgeec/overview");
    if (!o.available) { $app.innerHTML = css + `<section class="panel"><h2>Educação — DGEEC</h2><p class="note warn">${esc(o.note)}</p></section>`; return; }
    const year = params.year || "", level = params.level || "", dico = params.dico || "", ind = params.ind || "";
    const [mu, mn, ix] = await Promise.all([
      Portal.api("dgeec/municipios" + Portal.qs({ year, level })),
      dico ? Portal.api("dgeec/municipio" + Portal.qs({ dico })) : Promise.resolve(null),
      ind ? Portal.api("dgeec/indicator" + Portal.qs({ id: ind })) : Promise.resolve(null),
    ]);
    const tot = last(o.alunos, "Total"), doc = o.docentes.filter((r) => r.year === (o.docentes.at(-1) || {}).year).reduce((a, r) => a + r.value, 0);
    const kp = [];
    if (tot) kp.push(kpi(n0(tot.value), `crianças e alunos matriculados/inscritos, todos os níveis (${esc(tot.year)})`));
    const sup = last(o.alunos, "Ensino superior");
    if (sup) kp.push(kpi(n0(sup.value), `inscritos no ensino superior (${esc(sup.year)})`));
    const dn = o.docentes.length ? o.docentes.at(-1).year : null;
    if (dn) kp.push(kpi(n0(doc), `docentes em exercício (${esc(dn)}, soma dos níveis)`));
    const nd = o.naoDocentes.at(-1);
    if (nd) kp.push(kpi(n0(nd.value), `pessoal não docente em escolas (${esc(nd.year)})`));
    kp.push(kpi(Portal.int(mu.rows.length), "municípios com alunos no Infoescolas (Continente)"));

    const sel = (name, opts, cur, all) => `<select name="${name}">${all ? `<option value="">${all}</option>` : ""}${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    const rowsHtml = mu.rows.slice(0, 60).map((r) => `<tr><td><a href="#/dgeec${Portal.qs({ year: mu.year, level, dico: r.dico })}">${esc(r.municipality)}</a></td><td>${esc(r.district || "")}</td><td class="num">${n0(r.students)}</td><td class="num">${n0(r.schools)}</td><td class="num">${r.per1000 == null ? "—" : nf.format(r.per1000)}</td><td><code>${esc(r.dico)}</code></td></tr>`).join("");
    let mp = "";
    if (mn && mn.found) {
      const byLevel = new Map();
      for (const r of mn.rows) { if (!byLevel.has(r.level)) byLevel.set(r.level, []); byLevel.get(r.level).push({ x: r.year, v: r.students }); }
      const l = mn.totals.at(-1), f = mn.totals[0];
      mp = panel(`${mn.municipio.name} (${mn.municipio.dico})`,
        `<div class="kpis">${kpi(n0(l.students), `alunos matriculados ${esc(l.year)}${f && f.students ? ` · ${l.students >= f.students ? "+" : ""}${nf.format(100 * (l.students / f.students - 1))} % vs ${esc(f.year)}` : ""}`)}${kpi(n0(l.schools), "estabelecimentos com alunos (soma por nível)")}${mn.municipio.population ? kpi(n0(mn.municipio.population), "habitantes (Censos 2021)") : ""}</div>` +
        lines([...byLevel].map(([label, pts]) => ({ label, pts }))),
        'Fonte: DGEEC, Infoescolas 2020 (<a href="https://dados.gov.pt/pt/datasets/infoescolas/" target="_blank" rel="noopener">dados.gov.pt ↗</a>). Ligação ao município pelo código DICO oficial. <a href="#/autarquias">Perfil do município</a>');
    } else if (mn) mp = '<p class="note warn">Município não encontrado.</p>';
    let ip = "";
    if (ix && ix.rows.length) ip = panel(ix.title || ix.id, lines(group(ix.rows).slice(0, 8)), `<a href="${esc(ix.source_url)}" target="_blank" rel="noopener">fonte DGEEC ↗</a>`);

    $app.innerHTML = css + `<h2>Educação — estatísticas da DGEEC</h2>
      <p class="note">Séries nacionais dos Indicadores da DGEEC (2009/10–2020/21) e alunos por município (Infoescolas, 2015/16–2018/19). Complementa <a href="#/educacao">Educação</a> (escolas, agrupamentos, listas de professores).</p>
      <div class="kpis">${kp.join("")}</div>
      <div class="dg-grid">
        ${panel("Crianças e alunos por nível de ensino", lines(group(o.alunos, /^Total$/)), "Fonte: DGEEC, indicador 1.1.")}
        ${panel("Docentes em exercício por nível", lines(group(o.docentes)), "Fonte: DGEEC, indicador 1.8.")}
        ${panel("Vagas no ensino superior (formação inicial)", lines(group(o.vagasSuperior, /^(Total|Público|Privado)$/)), "Fonte: DGEEC, indicador 5.1.")}
        ${panel("Inscritos no ensino superior por nível de formação", lines(group(o.inscritosSuperior, /^Total$/).slice(0, 5)), "Fonte: DGEEC, indicador 5.3.")}
      </div>
      <section class="panel"><h3>Alunos por município</h3>
        <form class="dg-bar" onsubmit="return false">${sel("year", mu.years.map((y) => [y, y]), mu.year)}${sel("level", mu.levels.map((v) => [v, v]), level, "Todos os níveis")}
        <button type="button" id="dg-go">Atualizar</button></form>
        <table class="tbl"><thead><tr><th>Município</th><th>Distrito</th><th>Alunos</th><th>Estabelecimentos</th><th>Alunos / 1000 hab.</th><th>DICO</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        <p class="small muted">${esc(mu.note)} Mostrados os 60 maiores de ${mu.rows.length}.</p></section>
      ${mp}
      <section class="panel"><h3>Todos os indicadores (${o.indicators.length})</h3>
        <div class="dg-bar">${sel("ind", o.indicators.map((i) => [i.id, `${i.id} — ${i.title.replace(/^\d+\.\d+\.?\s*/, "").slice(0, 110)}`]), ind, "Escolher indicador…")}</div>${ip}</section>
      <p class="small muted">Dados: DGEEC (Direção-Geral de Estatísticas da Educação e Ciência), publicados em dados.gov.pt. Atualizado em ${esc((o.meta.updated || "").slice(0, 10))}.</p>`;
    const go = () => { const p = new URLSearchParams(); for (const n of ["year", "level", "ind"]) { const v = document.querySelector(`#app [name=${n}], [name=${n}]`)?.value; if (v) p.set(n, v); } if (dico) p.set("dico", dico); location.hash = "#/dgeec?" + p; };
    document.getElementById("dg-go")?.addEventListener("click", go);
    document.querySelector("[name=ind]")?.addEventListener("change", go);
  });
})();
