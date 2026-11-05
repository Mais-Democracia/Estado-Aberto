(function () {
"use strict";
const F = () => Story.fmt;
const API = "/api/historias/poder-local";
const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, n) => (Number.isFinite(+v) ? new Intl.NumberFormat("pt-PT", { maximumFractionDigits: n == null ? 1 : n, useGrouping: "always" }).format(+v) : null);
const eurI = (v) => (Number.isFinite(+v) ? (Math.abs(+v) >= 1e6 ? F().eur(v) : nf(v, 0) + " €") : null);
const dateTxt = (iso) => F().date(iso);
const state = { idx: null, sel: null, obs: null };

const argFromHash = () => { const m = /^#\/historia\/poder-local\/concelho\/([^?]+)/.exec(location.hash); if (!m) return ""; try { return decodeURIComponent(m[1]); } catch { return m[1]; } };
const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });

function derive(ds) {
  const c = {};
  const m = ds.mapa;
  if (m && m.tiles) c.n = m.tiles.length;
  const p = ds.partidos;
  if (p && p.rows && p.rows.length) {
    const row = (l) => p.rows.find((r) => r.label === l), lead = p.rows.slice().sort((a, b) => b.value - a.value)[0];
    c.lead = { label: lead.label, n: lead.value };
    c.ps = row("PS") && row("PS").value; c.psd = row("PSD") && row("PSD").value; c.psdMais = row("PSD+") && row("PSD+").value; c.ind = row("Independentes") && row("Independentes").value; c.cdu = row("CDU") && row("CDU").value;
  }
  const s = ds.indicadores;
  if (s && s.points && s.points.length) {
    const by = (k) => s.points.slice().sort((a, b) => b[k] - a[k])[0], d = by("x"), e = by("y");
    c.ind2 = { shown: s.shown || s.points.length, n: s.n, debtMed: s.median && eurI(s.median.x), expMed: s.median && eurI(s.median.y), debtTop: d.label, debtTopTxt: eurI(d.x), expTop: e.label, expTopTxt: eurI(e.y) };
  }
  const a = ds.igfAno;
  if (a && a.rows && a.rows.length) {
    const peak = a.rows.slice().sort((x, y) => y.value - x.value)[0], last = a.rows[a.rows.length - 1];
    c.igf = { total: a.total, peakYear: peak.label, peakN: peak.value, firstYear: a.rows[0].label, lastYear: last.label, lastN: last.value, ongoing: String(a.asof || "").slice(0, 4) === String(last.label) ? last.label : null };
  }
  const g = ds.igfMunicipio;
  if (g && g.rows && g.rows.length) {
    const max = Math.max(...g.rows.map((r) => +r.value)), top = g.rows.filter((r) => +r.value === max);
    c.igfm = { max, nTop: top.length, names: top.slice(0, 6).map((r) => r.label).join(", "), shown: g.rows.length };
  }
  const e = ds.empresasLocais;
  if (e && e.rows && e.rows.length) {
    const cls = e.rows.filter((r) => r.label !== "Não classificado"), top = cls.slice().sort((x, y) => y.value - x.value)[0], nc = e.rows.find((r) => r.label === "Não classificado");
    c.emp = { total: e.total, topLabel: top && top.label, topN: top && top.value, nc: nc && nc.value };
  }
  const r = ds.regioes;
  if (r && r.detalhe && r.rows) {
    const txt = (x) => { const row = r.rows.find((q) => q.label === x.regiao); return { regiao: x.regiao, gov: x.governo, desde: dateTxt(x.desde), lugares: x.lugares, contratos: x.contratos, val: row && F().eur(row.value * 1e6) }; };
    c.reg = r.detalhe.map(txt);
  }
  return c;
}

function findRow(name) {
  if (!state.idx) return null;
  const q = norm(name); if (!q) return null;
  const rows = state.idx.rows, ex = rows.find((r) => norm(r[0]) === q); if (ex) return ex;
  const pre = rows.filter((r) => norm(r[0]).startsWith(q)); return pre.length === 1 ? pre[0] : null;
}

function indicatorRows(sel) {
  const u = (i, v) => nf(v, 1) + (i.unit ? " " + i.unit : "");
  return (sel.indicadores || []).filter((i) => Number.isFinite(+i.value) && Number.isFinite(+i.median) && i.key !== "pop").slice(0, 8).map((i) => ({ title: String(i.label).replace(/\s*\(.*$/, ""), sub: "Concelho: " + u(i, i.value) + " · mediana dos municípios: " + nf(i.median, 1) + (Number.isFinite(+i.pt) ? " · Portugal: " + nf(i.pt, 1) : "") + (i.year ? " (" + i.year + ")" : ""), tag: +i.value > +i.median ? "acima da mediana" : +i.value < +i.median ? "abaixo da mediana" : "na mediana" }));
}

function cardHtml(sel) {
  const m = sel.municipio, f = sel.financas, g = sel.igf, fu = sel.fundos, ct = sel.contratos, el = sel.empresasLocais, L = [];
  L.push('<h3 class="pl-name">' + esc(m.name) + "</h3>");
  const pop = nf(m.population, 0), meta = [m.district && "distrito de " + m.district, pop && pop + " habitantes" + (m.populationYear ? " (" + esc(m.populationYear) + ")" : "")].filter(Boolean);
  if (meta.length) L.push('<p class="pl-meta">' + meta.join(" · ") + "</p>");
  const gov = [];
  if (m.partyGroup || m.party) gov.push("Governado por <b>" + esc(m.party || m.partyGroup) + "</b>" + (m.party && m.partyGroup && m.party !== m.partyGroup ? " (grupo " + esc(m.partyGroup) + ")" : "") + (m.mayor ? ", presidente " + esc(m.mayor) : "") + ".");
  if (Number.isFinite(+m.winnerPct)) gov.push("Venceu com " + nf(m.winnerPct) + "% dos votos" + (Number.isFinite(+m.turnout2025) ? ", com participação de " + nf(m.turnout2025) + "%" : "") + ".");
  if (gov.length) L.push("<p>" + gov.join(" ") + "</p>");
  if (g) L.push("<p>" + (g.n > 0 ? "A IGF publicou <b>" + g.n + "</b> " + (g.n === 1 ? "relatório" : "relatórios") + " sobre o município." : "Não há relatórios da IGF associados a este município.") + "</p>" + (g.reports && g.reports.length ? '<ul class="pl-igf">' + g.reports.slice(0, 3).map((r) => "<li>" + (r.href ? '<a href="' + esc(r.href) + '">' + esc(r.title) + "</a>" : esc(r.title)) + (r.year ? " <span>" + esc(r.year) + "</span>" : "") + "</li>").join("") + "</ul>" : ""));
  if (fu && Number.isFinite(+fu.aprovado)) L.push("<p>Fundos europeus aprovados: <b>" + F().eur(fu.aprovado) + "</b>" + (Number.isFinite(+fu.aprovadoPc) ? " (" + eurI(fu.aprovadoPc) + " por habitante)" : "") + (Number.isFinite(+fu.pago) ? ", dos quais " + F().eur(fu.pago) + " pagos" : "") + ".</p>");
  if (ct && Number.isFinite(+ct.n)) L.push("<p>Contratos públicos: <b>" + nf(ct.n, 0) + "</b>, no valor de " + F().eur(ct.value) + (Number.isFinite(+ct.directShare) ? "; " + nf(ct.directShare * 100, 0) + "% por ajuste direto" : "") + (Number.isFinite(+ct.singleBidderShare) ? " e " + nf(ct.singleBidderShare * 100, 0) + "% com um só concorrente" : "") + ".</p>");
  if (f && Number.isFinite(+f.expensePc)) L.push("<p>Despesa por habitante em " + esc(f.year) + ": <b>" + eurI(f.expensePc) + "</b> (mediana nacional " + eurI(f.medianExpensePc) + "); dívida por habitante: <b>" + eurI(f.debtPc) + "</b> (mediana " + eurI(f.medianDebtPc) + ").</p>");
  if (el && Number.isFinite(+el.n) && el.n > 0) L.push("<p>Empresas locais associadas: " + el.n + ".</p>");
  if (m.href) L.push('<p><a class="pl-more" href="' + esc(m.href) + '">Abrir a página do município →</a></p>');
  if (indicatorRows(sel).length) L.push('<p class="pl-note">Os indicadores do concelho, comparados com a mediana dos municípios, estão no painel ao lado.</p>');
  return L.join("");
}

const STYLE = ".pl-find{margin-top:.9rem;padding-top:.8rem;border-top:1px solid var(--st-line)}.pl-find label{display:block;font:700 .68rem var(--st-sans);letter-spacing:.12em;text-transform:uppercase;color:var(--st-mute);margin-bottom:.35rem}.pl-find input{width:100%;box-sizing:border-box;padding:.55rem .7rem;font:600 1rem var(--st-sans);color:var(--st-ink);background:var(--st-paper);border:1.5px solid var(--st-ink);border-radius:2px}.pl-find input:focus{outline:2px solid var(--st-red);outline-offset:1px}.pl-msg{font:600 .8rem var(--st-sans);color:var(--st-redink);margin:.4rem 0 0}.pl-res{margin-top:.7rem;max-height:34vh;overflow:auto;font-size:.92rem;line-height:1.45}.pl-res p{margin:.35rem 0}.pl-name{font:800 1.5rem var(--st-serif);margin:0 0 .1rem}.pl-meta{font:600 .78rem var(--st-sans);color:var(--st-mute)}.pl-igf{margin:.2rem 0 .4rem;padding-left:1.1rem;font-size:.85rem}.pl-igf span{color:var(--st-mute)}.pl-more{font:700 .78rem var(--st-sans)}.pl-note{font:italic .8rem var(--st-text);color:var(--st-mute)}@media(max-width:720px){.pl-res{max-height:none}}";

function ensureStyle() { if (!document.getElementById("pl-style")) { const s = document.createElement("style"); s.id = "pl-style"; s.textContent = STYLE; document.head.appendChild(s); } }

function show(box, sel) {
  const res = box.querySelector(".pl-res"), msg = box.querySelector(".pl-msg");
  msg.textContent = ""; state.sel = sel;
  res.innerHTML = sel ? cardHtml(sel) : "";
}

async function choose(box, row) {
  const msg = box.querySelector(".pl-msg"); msg.textContent = "A carregar…";
  try {
    const j = await getJSON(API + "?concelho=" + encodeURIComponent(row[0]));
    if (!j || !j.found) { msg.textContent = "Sem dados para este concelho."; return; }
    show(box, j);
    const h = "#/historia/poder-local/concelho/" + encodeURIComponent(j.municipio.name);
    if (location.hash.split("?")[0] !== h) location.hash = h;
  } catch (e) { msg.textContent = "Não foi possível obter os dados deste concelho."; }
}

function mountWidget(cap) {
  ensureStyle();
  const box = document.createElement("div"); box.className = "pl-find";
  const names = state.idx ? state.idx.rows.map((r) => r[0]) : [];
  box.innerHTML = '<label for="pl-in">O seu concelho</label><input id="pl-in" type="search" list="pl-list" autocomplete="off" placeholder="Escreva o nome, por exemplo Porto" aria-label="Procurar concelho"' + (state.idx ? "" : " disabled") + '><datalist id="pl-list">' + names.map((n) => '<option value="' + esc(n) + '">').join("") + '</datalist><p class="pl-msg" role="status">' + (state.idx ? "" : "A pesquisa não está disponível de momento.") + '</p><div class="pl-res"></div>';
  const src = cap.querySelector(".st-src"); cap.insertBefore(box, src || null);
  const input = box.querySelector("input"), go = () => { const row = findRow(input.value); if (row) choose(box, row); else if (input.value.trim()) box.querySelector(".pl-msg").textContent = "Concelho não encontrado: escolha um nome da lista."; };
  input.addEventListener("change", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } e.stopPropagation(); });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  if (state.sel) { input.value = state.sel.municipio.name; show(box, state.sel); }
}

function watch() {
  if (state.obs) state.obs.disconnect();
  const tryMount = () => { const cap = document.querySelector("#st-concelho .st-cap"); if (cap && !cap.querySelector(".pl-find")) { mountWidget(cap); return true; } return !!(cap && cap.querySelector(".pl-find")); };
  state.obs = new MutationObserver(() => { if (tryMount()) { state.obs.disconnect(); state.obs = null; } });
  state.obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { if (state.obs) { state.obs.disconnect(); state.obs = null; } }, 30000);
}

function load() {
  state.sel = null; state.idx = null;
  const arg = argFromHash();
  watch();
  return Promise.all([
    getJSON(API),
    getJSON(API + "?index=1").catch(() => null),
  ]).then(async ([j, idx]) => {
    if (!j || !j.datasets) throw new Error("sem dados");
    state.idx = idx && idx.rows ? idx : null;
    if (arg) { try { const s = await getJSON(API + "?concelho=" + encodeURIComponent(arg)); if (s && s.found) state.sel = s; } catch {} }
    return { ds: j.datasets, c: derive(j.datasets), built: j.built };
  });
}

Story.register("poder-local", {
  title: "Quem governa o seu *concelho*",
  question: "Quem governa o seu concelho e o que dizem as auditorias?",
  load,
  scenes: [
    { id: "mapa", label: "Mapa", kicker: "Quem governa",
      morph: { type: "tiles", items: (d) => ({ tiles: d.ds.mapa.tiles }) },
      headline: (d) => `*${d.c.n} municípios*, cada um com a sua maioria`,
      copy: "Cada azulejo é um município, agrupado pelo partido que o governa desde as eleições autárquicas; quanto mais escuro, mais população.\n\n{{c.lead.label|str}} é o partido com mais municípios: {{c.lead.n|int}}. O PS governa {{c.ps|int}}, o PSD {{c.psd|int}} sozinho e {{c.psdMais|int}} em coligação, e {{c.ind|int}} são governados por independentes.",
      source: { label: "Eleições autárquicas 2025", href: "#/autarquias-mapa", asof: (d) => d.ds.mapa.asof }, when: (d) => d.c.n > 0 },
    { id: "indicadores", label: "Finanças", kicker: "Quanto gastam e devem",
      morph: { type: "scatter", items: (d) => ({ points: d.ds.indicadores.points, xLabel: d.ds.indicadores.xLabel, yLabel: d.ds.indicadores.yLabel, median: d.ds.indicadores.median }) },
      headline: () => "A despesa e a dívida *não crescem* ao mesmo ritmo",
      copy: "Cada ponto é um dos {{c.ind2.shown|int}} maiores municípios, entre {{c.ind2.n|int}}. As linhas a tracejado são as medianas nacionais: {{c.ind2.expMed|str}} de despesa e {{c.ind2.debtMed|str}} de dívida por habitante.\n\nNeste grupo, a despesa por habitante mais alta é a de {{c.ind2.expTop|str}} ({{c.ind2.expTopTxt|str}}) e a dívida por habitante mais alta é a de {{c.ind2.debtTop|str}} ({{c.ind2.debtTopTxt|str}}).",
      source: { label: "Autarquias, indicadores financeiros", href: "#/autarquias", asof: (d) => d.ds.indicadores.asof }, when: (d) => d.c.ind2 },
    { id: "igf-ano", label: "Auditorias", kicker: "O que dizem as auditorias",
      morph: { type: "bars", items: (d) => ({ rows: d.ds.igfAno.rows.slice(-14), unit: "relatórios" }) },
      headline: (d) => `A IGF publicou *${d.c.igf.total} relatórios*`,
      copy: "A Inspeção-Geral de Finanças tem {{c.igf.total|int}} relatórios publicados. Desde {{c.igf.firstYear|str}}, o ano com mais relatórios é {{c.igf.peakYear|str}}, com {{c.igf.peakN|int}}.\n\nEm {{c.igf.ongoing|str}}, ano ainda em curso, há {{c.igf.lastN|int}}.",
      source: { label: "Inspeção-Geral de Finanças", href: "#/igf", asof: (d) => d.ds.igfAno.asof }, when: (d) => d.c.igf },
    { id: "igf-municipios", label: "Por município", kicker: "O que dizem as auditorias",
      morph: { type: "bars", items: (d) => ({ rows: d.ds.igfMunicipio.rows, unit: "relatórios" }) },
      headline: (d) => `O máximo é de *${d.c.igfm.max} relatórios* por município`,
      copy: "Entre os municípios com relatórios da IGF, o máximo é de {{c.igfm.max|int}} por município. Atingem esse número {{c.igfm.nTop|int}} municípios: {{c.igfm.names|str}}.\n\nUm relatório não é sinónimo de irregularidade: as auditorias têm âmbitos diferentes. Clique numa barra para abrir a página do município.",
      source: { label: "Inspeção-Geral de Finanças", href: "#/igf", asof: (d) => d.ds.igfMunicipio.asof }, when: (d) => d.c.igfm },
    { id: "empresas", label: "Empresas", kicker: "O braço económico",
      morph: { type: "bars", items: (d) => ({ rows: d.ds.empresasLocais.rows, unit: "empresas" }) },
      headline: (d) => `*${d.c.emp.total} empresas locais* ao serviço dos municípios`,
      copy: "Há {{c.emp.total|int}} empresas locais registadas. Entre as que têm setor definido, a categoria mais numerosa é {{c.emp.topLabel|str}}, com {{c.emp.topN|int}}. Outras {{c.emp.nc|int}} não estão classificadas.",
      source: { label: "Empresas locais", href: "#/empresas-locais", asof: (d) => d.ds.empresasLocais.asof }, when: (d) => d.c.emp },
    { id: "regioes", label: "Regiões", kicker: "Fora do continente",
      morph: { type: "bars", items: (d) => ({ rows: d.ds.regioes.rows, unit: "M€" }) },
      headline: () => "Açores e Madeira têm *governos próprios*",
      copy: "{{c.reg.0.regiao|str}}: {{c.reg.0.gov|str}}, em funções desde {{c.reg.0.desde|str}}, com {{c.reg.0.lugares|int}} lugares no parlamento regional. Contratou {{c.reg.0.val|str}} em {{c.reg.0.contratos|int}} contratos.\n\n{{c.reg.1.regiao|str}}: {{c.reg.1.gov|str}}, em funções desde {{c.reg.1.desde|str}}, com {{c.reg.1.lugares|int}} lugares. Contratou {{c.reg.1.val|str}} em {{c.reg.1.contratos|int}} contratos.",
      source: { label: "Regiões autónomas", href: "#/regioes", asof: (d) => d.ds.regioes.asof }, when: (d) => d.c.reg && d.c.reg.length > 1 },
    { id: "concelho", label: "O seu concelho", kicker: "Procure o seu",
      morph: { get type() { return state.sel ? "list" : "tiles"; }, items: (d) => (state.sel ? { rows: indicatorRows(state.sel) } : { tiles: d.ds.mapa.tiles }) },
      headline: () => "O seu *concelho* em números",
      copy: "Escreva o nome de um dos {{c.n|int}} municípios para ver quem o governa, o que a IGF publicou, os fundos e contratos associados e como os indicadores se comparam com a mediana nacional.",
      source: { label: "Autarquias", href: "#/autarquias", asof: (d) => d.ds.mapa.asof } },
  ],
  directory: [
    { label: "Mapa das autarquias", href: "#/autarquias-mapa", desc: "Os 308 municípios e o partido que os governa." },
    { label: "Autarquias", href: "#/autarquias", desc: "Indicadores financeiros e sociais por município." },
    { label: "IGF", href: "#/igf", desc: "Relatórios da Inspeção-Geral de Finanças." },
    { label: "Fundos europeus", href: "#/fundos", desc: "Fundos aprovados e pagos por concelho." },
    { label: "Empresas locais", href: "#/empresas-locais", desc: "Empresas detidas por municípios." },
    { label: "Regiões autónomas", href: "#/regioes", desc: "Açores e Madeira." },
    { label: "Eleições", href: "#/eleicoes", desc: "Resultados eleitorais." },
  ],
  fallback: [{ label: "Autarquias", href: "#/autarquias" }, { label: "IGF", href: "#/igf" }, { label: "Mapa", href: "#/autarquias-mapa" }],
});
})();
