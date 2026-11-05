"use strict";
(() => {
  const { esc } = Portal;
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const n0 = (v) => (v == null ? "—" : Portal.int(Math.round(v)));
  const n1 = (v) => (v == null ? "—" : nf.format(v));
  const sn = (s) => String(s || "").replace(/ da Grã-Bretanha.*$/, "");
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : esc(t));
  const css = `<style>.im-svg{width:100%;height:auto;max-height:240px}.im-svg text{fill:var(--muted);font:11px system-ui}.im-svg .gr{stroke:var(--line2)}.im-svg .l0{fill:none;stroke:var(--bar);stroke-width:2.4}.im-svg .l1{fill:none;stroke:var(--bar2);stroke-width:2}.im-svg .l2{fill:none;stroke:var(--bar3);stroke-width:2}.im-svg .l3{fill:none;stroke:var(--red);stroke-width:2}.im-svg .l4{fill:none;stroke:var(--gold-ink);stroke-width:2;stroke-dasharray:5 3}.im-svg .l5{fill:none;stroke:var(--green-deep);stroke-width:2;stroke-dasharray:2 3}.im-svg rect.b{fill:var(--bar)}
  .im-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}.im-leg{display:flex;gap:12px;flex-wrap:wrap;font-size:.82rem;margin:4px 0}.im-leg i{display:inline-block;width:18px;height:0;border-top:3px solid;vertical-align:middle;margin-right:4px}
  .im-bar{display:grid;grid-template-columns:130px 1fr 125px;gap:8px;align-items:center;margin:3px 0;font-size:.88rem}.im-bar span.t{background:var(--bar);height:14px;border-radius:2px;display:block}.im-bar .n{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
  .im-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;align-items:center}</style>`;
  const LC = ["l0", "l1", "l2", "l3", "l4", "l5"];
  Portal.nav("Imigração", "#/imigracao");

  function svgLines(series, o = {}) {
    const all = series.flatMap((s) => s.pts);
    if (!all.length) return '<p class="note">Sem dados.</p>';
    const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
    const W = 520, H = 210, L = 58, R = 12, T = 12, B = 26;
    const max = Math.max(...all.map((p) => p.v), 1);
    const X = (x) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) * (W - L - R)) / (xs.length - 1));
    const Y = (v) => T + (H - T - B) * (1 - v / max);
    const grid = [0, 0.5, 1].map((f) => `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(max * f)}" y2="${Y(max * f)}"/><text x="${L - 6}" y="${Y(max * f) + 4}" text-anchor="end">${esc(nf.format(Math.round(max * f)))}</text>`).join("");
    const step = Math.ceil(xs.length / 8);
    const xl = xs.map((x, i) => ((i % step === 0 && xs.length - 1 - i >= step) || i === xs.length - 1 ? `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${x}</text>` : "")).join("");
    const paths = series.map((s, i) => {
      const pp = s.pts.slice().sort((a, b) => a.x - b.x);
      const d = pp.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
      const dots = pp.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.v)}" r="6" fill="transparent"><title>${esc(s.label)} ${p.x}: ${esc(Portal.int(p.v))}</title></circle>`).join("");
      return `<path class="${LC[i % LC.length]}" d="${d}"/>${dots}`;
    }).join("");
    const leg = series.length > 1 ? `<div class="im-leg">${series.map((s, i) => `<span><i class="${LC[i % LC.length]}" style="border-color:currentColor;color:${["var(--bar)", "var(--bar2)", "var(--bar3)", "var(--red)", "var(--gold-ink)", "var(--green-deep)"][i % 6]}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
    return `<svg class="im-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "série")}">${grid}${xl}${paths}</svg>${leg}`;
  }
  const bars = (rows, total) => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return rows.map((r) => `<div class="im-bar"><span>${esc(sn(r.name))}</span><span><span class="t" style="width:${(100 * r.value) / max}%"></span></span><span class="n">${n0(r.value)}${total ? ` · ${n1((100 * r.value) / total)} %` : ""}</span></div>`).join("");
  };
  const panel = (title, body, src, sub) => `<section class="panel"><h3>${esc(title)}</h3>${body}<p class="small muted">${sub || ""}${src ? " " + ext(src, "fonte") : ""}</p></section>`;
  const kpi = (b, s) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`;

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || e.kind !== "municipio") return;
    const d = await Portal.api("imigracao/concelho?" + (e.dico ? "dico=" + encodeURIComponent(e.dico) : "nif=" + encodeURIComponent(e.nif || ""))).catch(() => null);
    if (!d || !d.found || !d.serie.length) return;
    const k = [kpi(n0(d.total), `residentes estrangeiros com título válido em 31/12/${d.ano}`), kpi(n1(d.per100) + "", `por 100 habitantes (população Censos ${esc(d.populacao_ano || "2021")})`), kpi(d.rank ? `${d.rank}.º de ${d.de}` : "—", "município por número de residentes estrangeiros")];
    el.insertAdjacentHTML("beforeend", `${css}<section class="panel"><h2>Residentes estrangeiros</h2><div class="kpis">${k.join("")}</div><div class="im-grid">${panel("Evolução 2014–" + d.ano, svgLines([{ label: "Residentes estrangeiros", pts: d.serie.map((x) => ({ x: x.year, v: x.value })) }], { label: "evolução" }), d.source_url, "INE, população estrangeira com estatuto legal de residente.")}${panel("Nacionalidades (" + d.ano + ")", bars(d.nacionalidades.concat(d.outros ? [{ nat_name: "Outros países", value: d.outros }] : []).map((r) => ({ name: r.nat_name, value: r.value })), d.total), d.source_url, "O INE só publica por município dez nacionalidades (Angola, Brasil, China, Cabo Verde, Reino Unido, Guiné-Bissau, Moldávia, Roménia, São Tomé e Príncipe, Ucrânia) mais «outros países».")}</div><p class="small"><a href="#/imigracao?tab=municipios">Todos os municípios →</a> · <a href="#/imigracao">Imigração em Portugal</a></p></section>`);
  });

  const TABS = [["resumo", "Panorama"], ["municipios", "Municípios e distritos"], ["fontes", "Fontes e lacunas"]];
  const nav = (t) => `<div class="tabs" style="margin:0 0 12px;display:flex;gap:8px;flex-wrap:wrap">${TABS.map(([k, l]) => `<a class="btn${k === t ? " on" : ""}" href="#/imigracao?tab=${k}"${k === t ? ' style="font-weight:700"' : ""}>${l}</a>`).join("")}</div>`;

  function resumo(ov) {
    const tot = ov.residentes.total, last = tot[tot.length - 1], prev = tot[tot.length - 2], y10 = tot.find((x) => x.year === last.year - 10);
    const hm = Object.fromEntries(ov.residentes.sex.filter((s) => s.year === last.year).map((s) => [s.sex, s.value]));
    const nat = ov.nacionalidades, pt = ov.regioes.linhas.filter((r) => r.level === "nuts2").slice(0, 7);
    const k = [
      kpi(n0(last.value), `residentes estrangeiros com título válido em 31/12/${last.year} (INE)`),
      kpi(prev ? (last.value >= prev.value ? "+" : "") + n1(100 * (last.value / prev.value - 1)) + " %" : "—", `face a ${prev ? prev.year : ""}`),
      kpi(y10 ? n1(last.value / y10.value) + "×" : "—", `o valor de ${y10 ? y10.year : ""}`),
      kpi(hm.M && hm.H ? n1((100 * hm.M) / (hm.M + hm.H)) + " %" : "—", "são mulheres"),
      kpi(nat.top[0] ? esc(nat.top[0].nat_name) : "—", nat.top[0] ? `maior nacionalidade: ${n0(nat.top[0].value)} (${n1((100 * nat.top[0].value) / nat.total)} %)` : ""),
    ];
    let h = `<div class="kpis">${k.join("")}</div><p class="note">Este painel conta <b>residentes estrangeiros com título de residência válido</b> (registo administrativo do SEF até 2023 e da AIMA depois, tratado pelo INE), não pedidos nem pessoas em situação irregular, não inclui quem já obteve nacionalidade portuguesa e o último ano publicado é ${last.year}. Os valores de 2023 são os mais recentes disponíveis, não os de hoje.</p>`;
    const sexS = (s) => ov.residentes.sex.filter((x) => x.sex === s).map((x) => ({ x: x.year, v: x.value }));
    const natSeries = [...new Set(ov.nacionalidades.serie.map((r) => r.nat_code))].map((c) => ({ label: sn(ov.nacionalidades.serie.find((r) => r.nat_code === c).nat_name), pts: ov.nacionalidades.serie.filter((r) => r.nat_code === c).map((r) => ({ x: r.year, v: r.value })) }));
    h += `<div class="im-grid">`
      + panel("Residentes estrangeiros por ano", svgLines([{ label: "Total", pts: tot.map((x) => ({ x: x.year, v: x.value })) }, { label: "Homens", pts: sexS("H") }, { label: "Mulheres", pts: sexS("M") }], { label: "residentes estrangeiros" }), ov.residentes.source_url, `${tot[0].year}–${last.year}, valores em 31 de dezembro.`)
      + panel(`Principais nacionalidades (${nat.ano})`, bars(nat.top.map((r) => ({ name: r.nat_name, value: r.value })), nat.total), nat.source_url, `Percentagem do total de ${n0(nat.total)}. Países individuais; não inclui apátridas nem nacionalidade desconhecida.`)
      + panel("Evolução das seis maiores nacionalidades", svgLines(natSeries, { label: "nacionalidades" }), nat.source_url, `${nat.serie.length ? Math.min(...nat.serie.map((r) => r.year)) : ""}–${nat.ano}.`)
      + panel("Por região (NUTS II)", bars(pt.map((r) => ({ name: r.geo_name, value: r.value })), tot.find((x) => x.year === ov.regioes.ano).value), ov.regioes.source_url, `Em 31/12/${ov.regioes.ano}.`)
      + panel("Grupos de países", bars(nat.grupos.map((r) => ({ name: r.nat_name, value: r.value })), nat.total), nat.source_url, "Os grupos sobrepõem-se (por exemplo, a UE e a Europa); não somam o total.")
      + `</div>`;
    return h;
  }

  async function municipios(params) {
    const year = params.year || "";
    const d = await Portal.api("imigracao/municipios" + (year ? "?year=" + encodeURIComponent(year) : ""));
    if (!d.available) return `<p class="note warn">${esc(d.note)}</p>`;
    const sort = params.sort || "total", q = (params.q || "").toLowerCase();
    const rows = d.municipios.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.district || "").toLowerCase().includes(q)).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "pt") : sort === "per100" ? (b.per100 || 0) - (a.per100 || 0) : (b.total || 0) - (a.total || 0));
    const th = (k, l) => `<th><a href="#/imigracao?${new URLSearchParams({ tab: "municipios", year: d.year, sort: k, q }).toString()}">${l}</a></th>`;
    const dist = d.distritos.map((r) => `<tr><td>${esc(r.district)}</td><td class="num">${n0(r.total)}</td><td class="num">${n1(r.per100)}</td><td class="num">${r.municipios}</td></tr>`).join("");
    const tbl = rows.slice(0, 400).map((r) => `<tr><td>${r.eid ? `<a href="#/entidade/${r.eid}">${esc(r.name)}</a>` : esc(r.name)} <span class="small muted">${esc(r.district || "")}</span></td><td class="num">${n0(r.total)}</td><td class="num">${n1(r.per100)}</td><td class="num">${r.antes != null ? (r.total >= r.antes ? "+" : "") + n1(100 * (r.total / r.antes - 1)) + " %" : "—"}</td><td class="small">${r.top.map((t) => esc(sn(t.name)) + " " + n0(t.value)).join(" · ")}</td></tr>`).join("");
    return `<div class="im-filters"><form onsubmit="location.hash='#/imigracao?'+new URLSearchParams({tab:'municipios',year:this.year.value,sort:'${esc(sort)}',q:this.q.value});return false">
      <label>Ano <select name="year">${d.years.map((y) => `<option${y === d.year ? " selected" : ""}>${y}</option>`).join("")}</select></label>
      <input name="q" placeholder="Município ou distrito" value="${esc(params.q || "")}"> <button class="btn" type="submit">Filtrar</button></form></div>
      <div class="im-grid" style="grid-template-columns:minmax(0,1fr)">
      <section class="panel"><h3>Distritos e regiões autónomas, ${d.year}</h3><table class="tbl"><thead><tr><th>Distrito</th><th class="num">Residentes estrangeiros</th><th class="num">Por 100 hab.</th><th class="num">Municípios</th></tr></thead><tbody>${dist}</tbody></table>
      <p class="small muted">Soma dos municípios (${n0(d.total)}). Por 100 habitantes usa a população dos Censos 2021, pelo que é uma aproximação. ${ext(d.source_url, "fonte")}</p></section>
      <section class="panel"><h3>${rows.length} municípios, ${d.year}</h3><table class="tbl"><thead><tr>${th("name", "Município")}${th("total", "Residentes estrangeiros")}${th("per100", "Por 100 hab.")}<th class="num">Variação a 5 anos</th><th>Maiores nacionalidades</th></tr></thead><tbody>${tbl}</tbody></table>
      <p class="small muted">Por município o INE só publica dez nacionalidades (Angola, Brasil, China, Cabo Verde, Reino Unido, Guiné-Bissau, Moldávia, Roménia, São Tomé e Príncipe, Ucrânia) mais «outros países»; a coluna mostra as três maiores entre essas, pelo que nacionalidades como a indiana ou a nepalesa só aparecem em «outros». ${ext(d.source_url, "fonte")}</p></section></div>`;
  }

  function fontes(ov) {
    const ds = ov.datasets.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${x.first_year}–${x.last_year}</td><td>${esc(x.updated || "")}</td><td>${ext(x.source_url, "INE " + x.indicator)}</td></tr>`).join("");
    const ama = ov.ama.linhas.map((x) => `<tr><td>${esc(x.period || "")}</td><td class="num">${n0(x.value)}</td><td>${esc(x.published || "")}</td><td>${ext(x.source_url, "ficheiro JSON")}</td></tr>`).join("");
    return `<section class="panel"><h3>Conjuntos usados</h3><table class="tbl"><thead><tr><th>Conjunto</th><th class="num">Anos</th><th>Atualização</th><th>Fonte</th></tr></thead><tbody>${ds}</tbody></table>
      <p class="small muted">Licença CC-BY (INE, dados.gov.pt). Carregado em ${esc((ov.built || "").slice(0, 10))}.</p></section>
      <section class="panel"><h3>AMA: pedidos de registo de estrangeiros</h3><table class="tbl"><thead><tr><th>Período do ficheiro</th><th class="num">Pedidos</th><th>Publicado</th><th>Fonte</th></tr></thead><tbody>${ama}</tbody></table>
      <p class="small">${esc(ov.ama.nota)} ${ext(ov.ama.pagina, "dados.gov.pt")}</p></section>
      <section class="panel"><h3>O que estes números não são</h3><ul class="small">
      <li><b>Residentes não são pedidos.</b> O gráfico principal conta títulos de residência válidos no fim do ano. Os pedidos da AMA acima medem outra coisa (registo para NIF, Segurança Social e utente) e não se somam aos residentes.</li>
      <li><b>SEF e AIMA.</b> O SEF foi extinto em outubro de 2023 e as suas competências de migração passaram para a AIMA. A série do INE vem do mesmo registo administrativo antes e depois; o salto de 2023 reflete em parte a regularização de processos pendentes.</li>
      <li><b>Cobertura.</b> Não há estatísticas da AIMA sobre títulos de residência acessíveis em dados abertos. Os valores do INE terminam em 2023 e por município só há dez nacionalidades mais «outros países». Os pedidos de estatuto de residente (INE 0001230) não puderam ser descarregados na última atualização, por isso a página não os apresenta.</li>
      <li>Quem adquire nacionalidade portuguesa sai da contagem; não há aqui estimativa de residentes sem título válido.</li></ul></section>`;
  }

  Portal.page("imigracao", async (arg, params) => {
    const tab = (params && params.tab) || "resumo";
    $app.innerHTML = `${css}<h1>Imigração e residentes estrangeiros</h1><p class="lead">Quantos estrangeiros têm título de residência válido em Portugal, por ano, nacionalidade e município. Fontes oficiais, com ligação a cada conjunto de dados.</p>${nav(tab)}<div id="im-body"><p class="note">A carregar…</p></div>`;
    const body = document.getElementById("im-body");
    try {
      if (tab === "municipios") { body.innerHTML = await municipios(params); return; }
      const ov = await Portal.api("imigracao/overview");
      if (!ov.available) { body.innerHTML = `<p class="note warn">${esc(ov.note)}</p>`; return; }
      body.innerHTML = tab === "fontes" ? fontes(ov) : resumo(ov);
    } catch (e) {
      body.innerHTML = `<p class="note warn">Não foi possível carregar os dados: ${esc(e.message || e)}</p>`;
    }
  });
})();
