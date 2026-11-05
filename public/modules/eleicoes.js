"use strict";
/* Módulo "eleicoes": como Portugal votou — legislativas, presidenciais, europeias e regionais (MAI/SGMAI), por distrito e concelho.
   Página #/eleicoes[/<id>] e #/eleicoes/municipio?dico=; secção "Como votou" nas páginas de município. API: /api/eleicoes/* */
(() => {
  const { esc } = Portal;
  const int = Portal.int;
  const pc = (v, d = 1) => (v == null ? "—" : `${Number(v).toFixed(d).replace(".", ",")}%`);
  const TYPE = { legislativas: "Legislativas", presidenciais: "Presidenciais", europeias: "Europeias", regionais: "Regionais", referendos: "Referendos" };
  const TCOL = { legislativas: "#1F4E9C", presidenciais: "#b5651d", europeias: "#2e8b57", regionais: "#8a4fb0", referendos: "#777" };
  const ext = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : "");

  function partyColor(p) {
    const a = String(p || "").toUpperCase();
    if (/PPD\/PSD|^PSD|^AD|CDS-PP.*PPM/.test(a) || /Cavaco|Marcelo|Mendes|Gouveia/i.test(p)) return "#e8862a";
    if (/^PS$|^PS[.\/]|Seguro|Alegre|Sampaio|Soares/i.test(a) || /Seguro|Alegre|Ferro Rodrigues/i.test(p || "")) return "#d6337a";
    if (/PCP|CDU/.test(a) || /Jer[oó]nimo|Filipe|Lopes/i.test(p || "")) return "#c62828";
    if (/^CH$|CHEGA|Ventura/i.test(a) || /Ventura/.test(p || "")) return "#1a237e";
    if (/CDS/.test(a)) return "#1f6fb5";
    if (/^IL$|Cotrim/i.test(a) || /Cotrim/.test(p || "")) return "#00a3d9";
    if (/B\.E\.|^BE$|Catarina|Mortágua/i.test(a) || /Catarina Martins/.test(p || "")) return "#7b1f1f";
    if (/^L$|LIVRE/.test(a)) return "#5a9e3a";
    if (/PAN/.test(a)) return "#00897b";
    if (/JPP/.test(a)) return "#2e7d32";
    return "#7a8090";
  }
  const chip = (p) => `<span class="el-chip"><i style="background:${partyColor(p)}"></i>${esc(p || "—")}</span>`;
  const css = `<style id="el-css">
    .el-chip{display:inline-flex;align-items:center;gap:6px}.el-chip i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
    .el-hbar{display:grid;grid-template-columns:minmax(110px,230px) 1fr 150px;gap:8px;align-items:center;margin:4px 0;font-size:.9rem}
    .el-hbar .t{background:var(--line2);border-radius:4px;height:15px;overflow:hidden}.el-hbar .t i{display:block;height:100%;border-radius:0 4px 4px 0}
    .el-hbar .v{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .el-seats{display:flex;flex-wrap:wrap;gap:3px;margin:8px 0}.el-seats i{width:16px;height:16px;border-radius:50%;display:inline-block}
    .el-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
    .el-card{display:block;border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:inherit;text-decoration:none}
    .el-card:hover{border-color:var(--accent,#1F4E9C)}.el-card b{font-size:1.05rem}
    .el-trend text{font-size:11px;fill:var(--muted)} .el-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:.85rem;margin:6px 0}
    .el-tbl td,.el-tbl th{white-space:nowrap}.el-tbl td:first-child{white-space:normal}
    .el-dh td.win{background:color-mix(in srgb,var(--accent,#1F4E9C) 22%,transparent);font-weight:600}
    .el-tabs a{margin-right:12px}.el-tabs a.on{font-weight:700;text-decoration:underline}
  </style>`;
  const addCss = () => { if (!document.getElementById("el-css")) document.head.insertAdjacentHTML("beforeend", css); };

  const bars = (rows, opts = {}) => {
    const max = Math.max(1, ...rows.map((r) => r.pct || 0));
    return rows.map((r) => `<div class="el-hbar"><span>${chip(r.party)}</span><span class="t"><i style="width:${100 * (r.pct || 0) / max}%;background:${partyColor(r.party)}"></i></span>
      <span class="v">${pc(r.pct, 2)} · ${int(r.votes)}${r.mandates != null && opts.seats !== false ? ` · <b>${r.mandates}</b> ${opts.seatLabel || "mand."}` : ""}</span></div>`).join("");
  };
  const seatDots = (rows) => {
    const dots = [];
    for (const r of rows) for (let i = 0; i < (r.mandates || 0); i++) dots.push(`<i style="background:${partyColor(r.party)}" title="${esc(r.party)}"></i>`);
    return dots.length ? `<div class="el-seats">${dots.join("")}</div>` : "";
  };

  /* SVG line chart. series: [{name,color,pts:[{x:year-fraction,y,label}]}] */
  function lineChart(series, { ymax, w = 760, h = 260, ytitle = "%" } = {}) {
    const pts = series.flatMap((s) => s.pts);
    if (!pts.length) return "";
    const xs = pts.map((p) => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs);
    const ym = ymax || Math.ceil(Math.max(...pts.map((p) => p.y)) / 10) * 10 || 100;
    const L = 40, R = 12, T = 12, B = 26, X = (x) => L + ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - L - R), Y = (y) => T + (1 - y / ym) * (h - T - B);
    let g = "";
    for (let v = 0; v <= ym; v += ym / 5) g += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line2)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    const years = [...new Set(pts.map((p) => Math.floor(p.x)))].sort();
    for (const y of years) g += `<text x="${X(y + 0.5 > x1 ? x1 : Math.max(x0, y + 0.4))}" y="${h - 8}" text-anchor="middle">${y}</text>`;
    for (const s of series) {
      const d = s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2"/>` + s.pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.6" fill="${s.color}"><title>${esc(s.name)} · ${esc(p.label)}: ${p.y.toFixed(1).replace(".", ",")}${ytitle}</title></circle>`).join("");
    }
    return `<svg class="el-trend" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Gráfico de evolução">${g}</svg>`;
  }
  const xOf = (e) => { const d = new Date(e.date); return d.getFullYear() + (d.getMonth() + d.getDate() / 31) / 12; };

  /* D'Hondt: quotient table for one círculo; returns html + whether published seats match */
  function hondtHtml(rows, seats) {
    const parts = rows.filter((r) => r.votes > 0).slice(0, 12);
    if (!seats || !parts.length) return "";
    const all = [];
    for (const p of parts) for (let d = 1; d <= seats; d++) all.push({ party: p.party, d, q: p.votes / d });
    all.sort((a, b) => b.q - a.q);
    const win = new Set(all.slice(0, seats).map((x) => x.party + "|" + x.d));
    const got = {}; all.slice(0, seats).forEach((x) => (got[x.party] = (got[x.party] || 0) + 1));
    const mism = parts.filter((p) => p.mandates != null && (got[p.party] || 0) !== p.mandates).length;
    const cols = Math.min(seats, 12);
    return `<div class="tblwrap"><table class="tbl el-dh"><thead><tr><th>Lista</th><th class="num">Votos</th>${Array.from({ length: cols }, (_, i) => `<th class="num">÷${i + 1}</th>`).join("")}<th class="num">Mand.</th></tr></thead><tbody>
      ${parts.map((p) => `<tr><td>${chip(p.party)}</td><td class="num">${int(p.votes)}</td>${Array.from({ length: cols }, (_, i) => `<td class="num ${win.has(p.party + "|" + (i + 1)) ? "win" : ""}">${int(Math.round(p.votes / (i + 1)))}</td>`).join("")}<td class="num"><b>${got[p.party] || 0}</b>${p.mandates != null && p.mandates !== (got[p.party] || 0) ? ` <span class="tag" title="Publicado: ${p.mandates}">≠ ${p.mandates}</span>` : ""}</td></tr>`).join("")}
      </tbody></table></div><p class="small muted">${seats} mandatos atribuídos pelo método de Hondt (os ${seats} maiores quocientes a verde). ${mism ? "Diferenças face aos mandatos publicados: coligações pré-eleitorais repartem os mandatos entre partidos, ou a lista tem menos de 12 forças." : "Coincide com os mandatos publicados."}</p>`;
  }

  /* -------------------------------------------------------------- index */
  Portal.nav("Eleições", "#/eleicoes");
  Portal.page("eleicoes", async (arg, p) => {
    addCss();
    if (arg === "municipio") return municipioPage(p);
    if (arg) return electionPage(arg, p);
    const [d, sr] = await Promise.all([Portal.api("eleicoes/list"), Portal.api("eleicoes/series" + Portal.qs({ party: p.party }))]);
    if (!d.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Eleições</h1></div></div><p class="note warn">${esc(d.note)}</p>`; return; }
    const els = d.elections.filter((e) => e.has_data);
    const byType = {};
    for (const e of els) (byType[e.type] ||= []).push(e);
    const types = ["legislativas", "presidenciais", "europeias", "regionais", "referendos"].filter((t) => byType[t]);
    const turnoutSeries = types.map((t) => ({ name: TYPE[t], color: TCOL[t], pts: byType[t].slice().reverse().filter((e) => e.type !== "regionais" || /Madeira/.test(e.name)).map((e) => ({ x: xOf(e), y: e.turnout, label: e.name })) })).filter((s) => s.pts.length && s.name !== "Referendos");
    const fam = sr.families || [];
    const party = p.party || "";
    const partySeries = party ? [{ name: party, color: partyColor(party), pts: (sr.series || []).filter((e) => e.party && e.party.valid_pct != null && e.type === (p.ptype || "legislativas")).map((e) => ({ x: xOf(e), y: e.party.valid_pct, label: e.name })) }] : [];
    $app.innerHTML = `
      <div class="crumbs"><a href="#/">Início</a> / Eleições</div>
      <div class="pagehead"><div><div class="kicker">Poder eleito · resultados oficiais MAI/SGMAI</div><h1>Como Portugal votou</h1>
        <p class="lead">Legislativas, presidenciais, europeias e regionais: resultados nacionais, por distrito e por concelho, participação, abstenção, votos em branco e nulos, e mandatos. As autárquicas (2017, 2021, 2025) estão em <a href="#/autarquias-mapa">Câmaras: poder e contas</a>.</p></div>
        <div><a class="btn" href="/api/eleicoes/list" target="_blank">JSON</a></div></div>
      <p class="note"><b>Cobertura.</b> ${esc(d.coverage.have)}<br><b>Não disponível:</b> ${esc(d.coverage.missing)}</p>
      <div class="cols"><section class="panel"><h2>Participação nas eleições</h2>${lineChart(turnoutSeries, { ymax: 100 })}
        <div class="el-legend">${turnoutSeries.map((s) => `<span class="el-chip"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>
        <p class="small muted">Percentagem de votantes sobre inscritos (as regionais mostradas são só as da Madeira). Passe o rato sobre os pontos.</p></section>
      <section class="panel"><h2>Evolução de uma força política</h2>
        <div class="el-filters"><select id="elp"><option value="">Escolha…</option>${fam.map((f) => `<option ${f === party ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>
        <select id="elt">${["legislativas", "europeias"].map((t) => `<option value="${t}" ${(p.ptype || "legislativas") === t ? "selected" : ""}>${TYPE[t]}</option>`).join("")}</select></div>
        ${party ? (partySeries[0].pts.length ? lineChart(partySeries, { ymax: 60 }) + `<p class="small muted">% dos votos válidos a nível nacional (agrupa ${esc(party)} e as suas coligações habituais, p.ex. PSD/AD = PPD/PSD isolado ou em coligação com CDS-PP).</p>` : `<p class="note">Sem dados para esta combinação.</p>`) : `<p class="small muted">Escolha um partido para ver a sua evolução nas legislativas ou europeias.</p>`}</section></div>
      ${types.map((t) => `<section class="panel"><h2>${TYPE[t]}</h2><div class="el-list">${byType[t].map((e) => `<a class="el-card" href="#/eleicoes/${esc(e.id)}"><b>${esc(e.name)}</b><div class="small muted">${esc(Portal.fmtDate(e.date))}</div>
        <div style="margin-top:6px">${e.winner ? `1.º: ${chip(e.winner.party)} ${pc(e.winner.pct)}` : ""}</div><div class="small muted">Participação ${pc(e.turnout)} · abstenção ${pc(e.abstention_pct)} · ${int(e.registered)} inscritos</div>
        <div class="small muted">${e.counts.distrito} distritos/círculos · ${e.counts.concelho} concelhos${e.note ? (e.counts.concelho ? " · via resultados anteriores" : " · só total nacional") : ""}</div></a>`).join("")}</div></section>`).join("")}
      <p class="small muted">Fonte: Ministério da Administração Interna / SGMAI, <a href="https://www.eleicoes.mai.gov.pt/" target="_blank" rel="noopener">eleicoes.mai.gov.pt</a> (resultados definitivos publicados). Atualizado: ${esc(d.built || "—")}. Eleições sem site próprio em JSON (legislativas 2005, presidenciais 2006, europeias 2009, regionais Madeira 2019 e Açores 2020) foram obtidas do campo “resultados anteriores” do site da eleição seguinte.</p>`;
    const go = () => Portal.go("eleicoes", "", { party: document.getElementById("elp").value, ptype: document.getElementById("elt").value });
    document.getElementById("elp").onchange = go; document.getElementById("elt").onchange = go;
  });

  /* -------------------------------------------------------------- one election */
  async function electionPage(id, p) {
    const d = await Portal.api("eleicoes/eleicao" + Portal.qs({ id }));
    if (!d.available) { $app.innerHTML = `<p class="note warn">${esc(d.note)}</p>`; return; }
    if (!d.found) { $app.innerHTML = `<div class="crumbs"><a href="#/eleicoes">Eleições</a></div><p class="note warn">Eleição não encontrada.</p>`; return; }
    const e = d.election, n = d.national || {};
    const leg = e.type === "legislativas";
    const sel = p.code;
    let drill = "", freRows = null;
    if (sel) {
      const t = await Portal.api("eleicoes/territorio" + Portal.qs({ id, nivel: p.nivel || "distrito", code: sel }));
      const isConc = p.nivel === "concelho";
      const kids = isConc ? await Portal.api("eleicoes/territorio" + Portal.qs({ id, nivel: "freguesia", parent: sel })) : (p.nivel === "distrito" || !p.nivel ? await Portal.api("eleicoes/territorio" + Portal.qs({ id, nivel: "concelho", parent: sel })) : null);
      if (isConc && kids && kids.rows) freRows = kids.rows;
      if (t.found) {
        drill = `<section class="panel"><h2>${esc(t.territory.name)}</h2>
          <p class="small muted">Inscritos ${int(t.summary.registered)} · votantes ${int(t.summary.voters)} · participação ${pc(t.summary.turnout)} · abstenção ${pc(t.summary.abstention_pct)} · brancos ${pc(t.summary.blank_pct)} · nulos ${pc(t.summary.null_pct)}${t.summary.mandates ? ` · ${t.summary.mandates} mandatos` : ""}</p>
          ${bars(t.results.slice(0, 12), { seats: leg || e.type === "regionais" })}${leg && t.summary.mandates ? `<h3>Atribuição de mandatos (Hondt)</h3>${hondtHtml(t.results, t.summary.mandates)}` : ""}
          ${isConc ? `<p><a href="#/eleicoes/municipio${Portal.qs({ dico: sel })}">Histórico de voto deste concelho ›</a></p>` : ""}
          ${kids && kids.rows && kids.rows.length ? `<h3>${isConc ? "Freguesias" : "Concelhos"} (${kids.rows.length})</h3>${isConc ? `<div id="el-fr"></div><p class="small muted">Só freguesias do território nacional; o voto no estrangeiro (consulados) não está desagregado por freguesia.${e.type === "presidenciais" ? " Em algumas uniões de freguesias o MAI publicou em 2026 os resultados das freguesias originais (anteriores a 2013): essas não aparecem aqui." : ""} Participação e inscritos conforme o MAI.</p>` : rowsTable(kids.rows, id)}` : (isConc ? `<p class="note">Sem resultados por freguesia nesta eleição (disponíveis: legislativas 2024–2025 e presidenciais 2026).</p>` : "")}
          <p class="small muted">${ext(t.source_url, "Fonte MAI")}</p></section>`;
      }
    }
    $app.innerHTML = `
      <div class="crumbs"><a href="#/">Início</a> / <a href="#/eleicoes">Eleições</a> / ${esc(e.name)}</div>
      <div class="pagehead"><div><div class="kicker">${esc(TYPE[e.type] || e.type)} · ${esc(Portal.fmtDate(e.date))}</div><h1>${esc(e.name)}</h1></div>
        <div><a class="btn" href="/api/eleicoes/eleicao?id=${esc(id)}" target="_blank">JSON</a></div></div>
      ${e.note ? `<p class="note">${esc(e.note)}</p>` : ""}
      <div class="kpis"><div class="kpi"><div class="v">${int(n.registered)}</div><div class="l">Inscritos</div></div><div class="kpi"><div class="v">${pc(n.turnout)}</div><div class="l">Participação${d.previous_summary ? ` (antes ${pc(d.previous_summary.turnout)})` : ""}</div></div>
        <div class="kpi"><div class="v">${pc(n.abstention_pct)}</div><div class="l">Abstenção</div></div><div class="kpi"><div class="v">${pc(n.blank_pct)}</div><div class="l">Brancos (${int(n.blank)})</div></div>
        <div class="kpi"><div class="v">${pc(n.null_pct)}</div><div class="l">Nulos (${int(n.null_votes)})</div></div></div>
      <section class="panel"><h2>Resultado nacional</h2>${(leg || e.type === "regionais") ? seatDots(d.results) : ""}${bars(d.results.slice(0, 20), { seats: leg || e.type === "regionais" })}
        <p class="small muted">${d.results.length > 20 ? `+ ${d.results.length - 20} outras listas. ` : ""}Percentagens sobre os votantes (incl. brancos e nulos), como publicado pelo MAI.${d.previous ? ` Eleição anterior: <a href="#/eleicoes/${esc(d.previous.id)}">${esc(d.previous.name)}</a>.` : ""} ${ext(d.source_url, "Fonte MAI")}</p></section>
      ${d.previous_results.length && d.previous ? `<section class="panel"><h2>Variação face a ${esc(d.previous.name)}</h2>${changeTable(d.results, d.previous_results, leg || e.type === "europeias")}</section>` : ""}
      ${drill}
      <section class="panel"><h2>${leg ? "Círculos eleitorais" : "Distritos / regiões"}</h2>${d.districts.length ? `<div class="tblwrap"><table class="tbl el-tbl"><thead><tr><th>${leg ? "Círculo" : "Território"}</th><th class="num">Inscritos</th><th class="num">Participação</th>${leg ? '<th class="num">Mandatos</th>' : ""}<th></th></tr></thead><tbody>
        ${d.districts.map((r) => `<tr><td><a href="#/eleicoes/${esc(id)}${Portal.qs({ nivel: "distrito", code: r.code })}">${esc(r.name)}</a></td><td class="num">${int(r.registered)}</td><td class="num">${pc(r.turnout)}</td>${leg ? `<td class="num">${r.mandates || "—"}</td>` : ""}<td><a href="#/eleicoes/${esc(id)}${Portal.qs({ nivel: "distrito", code: r.code })}">ver ›</a></td></tr>`).join("")}</tbody></table></div>` :
        `<p class="note">${e.scope !== "LOCAL-500000" ? "Eleição regional: ver concelhos abaixo." : "Sem dados por distrito."}</p>`}</section>
      ${e.scope !== "LOCAL-500000" || !sel ? await allConcelhos(id, e) : ""}
      <p class="small muted">Círculos da emigração (Europa, Fora da Europa) estão incluídos no total nacional mas não detalhados por consulado. Resultados por freguesia: legislativas 2024–2025 e presidenciais 2026 (escolha um concelho).</p>`;
    if (freRows) freTable(freRows, id);
  }
  function freTable(rows, id) {
    const box = document.getElementById("el-fr");
    if (!box) return;
    let key = "name", dir = 1;
    const val = { name: (r) => r.name, registered: (r) => r.registered || 0, turnout: (r) => r.turnout || 0, winner: (r) => r.winner || "", winner_pct: (r) => r.winner_pct || 0 };
    const draw = () => {
      const sorted = rows.slice().sort((a, b) => { const x = val[key](a), y = val[key](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      const th = (k, l, n) => `<th class="${n ? "num" : ""}"><a href="#" data-k="${k}" class="${key === k ? "on" : ""}">${l}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</a></th>`;
      box.innerHTML = `<div class="tblwrap"><table class="tbl el-tbl"><thead><tr>${th("name", "Freguesia")}${th("registered", "Inscritos", 1)}${th("turnout", "Participação", 1)}${th("winner", "Partido mais votado")}${th("winner_pct", "% voto", 1)}</tr></thead><tbody>
        ${sorted.map((r) => `<tr><td>${r.entity_id ? `<a href="#/entidade/${r.entity_id}">${esc(r.name)}</a>` : esc(r.name)}</td><td class="num">${int(r.registered)}</td><td class="num">${pc(r.turnout)}</td><td>${r.winner ? chip(r.winner) : "—"}</td><td class="num">${pc(r.winner_pct)}</td></tr>`).join("")}</tbody></table></div>`;
      box.querySelectorAll("th a").forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); const k = a.dataset.k; if (k === key) dir = -dir; else { key = k; dir = k === "name" || k === "winner" ? 1 : -1; } draw(); }));
    };
    draw();
  }
  async function allConcelhos(id, e) {
    const k = await Portal.api("eleicoes/territorio" + Portal.qs({ id, nivel: "concelho" }));
    if (!k.found || !k.rows.length) return "";
    return `<section class="panel"><h2>Concelhos (${k.rows.length})</h2>${/^(leg|eur|pres)-/.test(id) ? `<p class="small muted">Os concelhos são os de Portugal: não incluem os círculos da emigração (Europa e Fora da Europa), por isso a soma dos concelhos fica abaixo do total nacional (que inclui o estrangeiro).</p>` : ""}${rowsTable(k.rows, id)}</section>`;
  }
  function rowsTable(rows, id) {
    return `<div class="tblwrap"><table class="tbl el-tbl"><thead><tr><th>Concelho</th><th>1.º lugar</th><th class="num">% voto</th><th class="num">Participação</th><th class="num">Inscritos</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><a href="#/eleicoes/${esc(id)}${Portal.qs({ nivel: "concelho", code: r.code })}">${esc(r.name)}</a></td><td>${r.winner ? chip(r.winner) : "—"}</td><td class="num">${pc(r.winner_pct)}</td><td class="num">${pc(r.turnout)}</td><td class="num">${int(r.registered)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function byFamily(rows) {
    const m = new Map();
    for (const r of rows) {
      const k = r.family || r.party;
      const f = m.get(k) || { key: k, votes: 0, pct: 0, mandates: null, lists: [] };
      f.votes += r.votes || 0; f.pct += r.pct || 0;
      if (r.mandates != null) f.mandates = (f.mandates || 0) + r.mandates;
      f.lists.push(r.party); m.set(k, f);
    }
    return m;
  }
  function changeTable(cur, prev, showSeats) {
    const cm = byFamily(cur), pm = byFamily(prev);
    const rows = [...cm.values()].sort((a, b) => b.votes - a.votes).slice(0, 9).map((f) => { const o = pm.get(f.key); return { f, o, d: o ? f.pct - o.pct : null }; });
    const merged = [...cm.values(), ...pm.values()].filter((f) => new Set(f.lists).size > 1 || f.lists[0] !== f.key);
    const notes = [...new Set([...cm.values(), ...pm.values()].filter((f) => f.lists.some((l) => l !== f.key) || new Set(f.lists).size > 1).map((f) => `${f.key} = ${[...new Set([...(cm.get(f.key)?.lists || []), ...(pm.get(f.key)?.lists || [])])].join(" + ")}`))];
    const sd = (a, b) => (a == null || b == null ? "—" : (a - b > 0 ? "+" : "") + (a - b));
    return `<div class="tblwrap"><table class="tbl"><thead><tr><th>Família / lista</th><th class="num">%</th><th class="num">% anterior</th><th class="num">Variação (p.p.)</th>${showSeats ? '<th class="num">Mand.</th><th class="num">Mand. ant.</th><th class="num">Δ</th>' : ""}</tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${chip(x.f.lists.length === 1 ? x.f.lists[0] : x.f.key)}</td><td class="num">${pc(x.f.pct, 2)}</td><td class="num">${x.o ? pc(x.o.pct, 2) : "—"}</td><td class="num">${x.d == null ? "—" : (x.d > 0 ? "+" : "") + x.d.toFixed(2).replace(".", ",")}</td>${showSeats ? `<td class="num">${x.f.mandates ?? "—"}</td><td class="num">${x.o?.mandates ?? "—"}</td><td class="num">${sd(x.f.mandates, x.o?.mandates)}</td>` : ""}</tr>`).join("")}</tbody></table></div>
      <p class="small muted">Comparação por família política: soma de todas as listas da mesma família em cada eleição. Listas agrupadas: ${esc(notes.join("; ") || "nenhuma")}. As famílias reúnem a mesma força sob siglas diferentes (PSD/AD = PPD/PSD isolado ou coligado com CDS-PP e PPM, incl. as listas das ilhas; CDU = PCP-PEV/APU); quando o CDS-PP vai coligado deixa de aparecer sozinho. Candidatos presidenciais só se comparam se o nome coincidir.</p>`;
  }

  /* -------------------------------------------------------------- municipality history */
  function historyHtml(d, heading) {
    const els = d.elections;
    const byType = {};
    for (const e of els) (byType[e.type] ||= []).push(e);
    const chart = lineChart(Object.keys(byType).map((t) => ({ name: TYPE[t] || t, color: TCOL[t] || "#777", pts: byType[t].slice().reverse().map((e) => ({ x: xOf(e), y: e.turnout, label: e.name })) })).filter((s) => s.pts.length), { ymax: 100 });
    return `<section class="panel"><h2>${heading}</h2>
      ${chart}<div class="el-legend">${Object.keys(byType).map((t) => `<span class="el-chip"><i style="background:${TCOL[t] || "#777"}"></i>${esc(TYPE[t] || t)}</span>`).join("")}</div>
      <p class="small muted">Participação neste concelho (linha) por tipo de eleição.</p>
      <div class="tblwrap"><table class="tbl el-tbl"><thead><tr><th>Eleição</th><th>1.º</th><th>2.º</th><th>3.º</th><th class="num">Participação</th><th class="num">Média nacional</th><th class="num">Brancos+nulos</th></tr></thead><tbody>
      ${els.map((e) => `<tr><td><a href="#/eleicoes/${esc(e.id)}">${esc(e.name)}</a></td>${[0, 1, 2].map((i) => `<td>${e.results[i] ? `${chip(e.results[i].party)} ${pc(e.results[i].pct)}` : "—"}</td>`).join("")}
        <td class="num">${pc(e.turnout)}</td><td class="num">${pc(e.national_turnout)}</td><td class="num">${pc((e.blank_pct || 0) + (e.null_pct || 0))}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted">Autárquicas (2017, 2021, 2025): <a href="#/autarquias-mapa">Câmaras: poder e contas</a>. Fonte: MAI/SGMAI. ${ext(els[0] && els[0].source_url, "ficheiro mais recente")}</p></section>`;
  }
  async function municipioPage(p) {
    const d = await Portal.api("eleicoes/municipio" + Portal.qs({ dico: p.dico, entity_id: p.entity_id }));
    if (!d.available) { $app.innerHTML = `<p class="note warn">${esc(d.note)}</p>`; return; }
    if (!d.found) { $app.innerHTML = `<div class="crumbs"><a href="#/eleicoes">Eleições</a></div><p class="note warn">Sem resultados para este município.</p>`; return; }
    const m = d.municipio;
    $app.innerHTML = `<div class="crumbs"><a href="#/">Início</a> / <a href="#/eleicoes">Eleições</a> / ${esc(m.name || m.dico)}</div>
      <div class="pagehead"><div><div class="kicker">${esc(m.district || "")}</div><h1>Como votou ${esc(m.name || m.dico)}</h1></div>
      <div>${m.entity_id ? `<a class="btn" href="#/entidade/${m.entity_id}">Página da entidade</a>` : ""}</div></div>${historyHtml(d, "Histórico de voto")}`;
  }

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (e && e.kind === "freguesia") {
      let f;
      try { f = await Portal.api("eleicoes/freguesia?entity_id=" + encodeURIComponent(e.id)); } catch { return; }
      if (!f || !f.available || !f.found) return;
      addCss();
      const els = f.elections;
      el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Como votou</h2>
        <div class="tblwrap"><table class="tbl el-tbl"><thead><tr><th>Eleição</th><th>1.º</th><th>2.º</th><th>3.º</th><th class="num">Participação</th><th class="num">Concelho</th><th class="num">Nacional</th><th class="num">Inscritos</th></tr></thead><tbody>
        ${els.map((x) => `<tr><td><a href="#/eleicoes/${esc(x.id)}${Portal.qs({ nivel: "concelho", code: f.freguesia.dico })}">${esc(x.name)}</a></td>${[0, 1, 2].map((i) => `<td>${x.results[i] ? `${chip(x.results[i].party)} ${pc(x.results[i].pct)}` : "—"}</td>`).join("")}<td class="num">${pc(x.turnout)}</td><td class="num">${pc(x.concelho_turnout)}</td><td class="num">${pc(x.national_turnout)}</td><td class="num">${int(x.registered)}</td></tr>`).join("")}</tbody></table></div>
        <p class="small muted">Resultados por freguesia (MAI/SGMAI): legislativas 2024–2025 e presidenciais 2026. Freguesia ${esc(f.freguesia.name)} (código ${esc(f.freguesia.code)})${f.municipio ? ` · <a href="#/eleicoes/municipio${Portal.qs({ dico: f.freguesia.dico })}">histórico do concelho de ${esc(f.municipio.name)}</a>` : ""}. ${ext(els[0].source_url, "Fonte MAI")}</p></section>`);
      return;
    }
    if (!e || e.kind !== "municipio") return;
    let d;
    try { d = await Portal.api("eleicoes/municipio?entity_id=" + encodeURIComponent(e.id)); } catch { return; }
    if (!d || !d.available || !d.found) return;
    addCss();
    el.insertAdjacentHTML("beforeend", historyHtml(d, "Como votou"));
  });
})();
