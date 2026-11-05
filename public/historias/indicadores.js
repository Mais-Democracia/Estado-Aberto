(function () {
"use strict";
const ds = (d, k) => (d && d.datasets && d.datasets[k]) || null;
const sum = (rows) => rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
const by = (rows, f) => rows.reduce((a, r) => (a == null || f(r, a) ? r : a), null);
const hashArg = () => { const m = location.hash.match(/^#\/historia\/indicadores\/concelho\/([^?]+)/); if (!m) return ""; try { return decodeURIComponent(m[1]); } catch { return m[1]; } };
const getJson = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const SHOW = ["ganho_medio", "poder_compra", "envelhecimento", "natalidade", "saldo_migratorio", "densidade", "dep_idosos", "pop"];
const num = (v, u) => (v == null ? "sem dado" : Story.fmt.dec1(v).replace(/,0$/, "") + (u ? " " + u : ""));

function load() {
  const name = hashArg();
  const main = getJson("/api/historias/indicadores");
  const conc = name ? getJson("/api/historias/indicadores?concelho=" + encodeURIComponent(name)).catch(() => null) : Promise.resolve(null);
  const lista = getJson("/api/historias/poder-local?index=1").catch(() => null);
  return Promise.all([main, conc, lista]).then(([p, c, l]) => {
    const d = { datasets: p.datasets || {}, pedido: name, lista: l && l.rows ? l.rows.map((r) => r[0]) : [] };
    const ine = ds(d, "ine"), rk = ds(d, "ranking"), hab = ds(d, "habitacao"), imi = ds(d, "imigracao"), dg = ds(d, "dgeec");
    if (ine) d.ine = { n: ine.value, municipios: ine.municipios, asof: ine.asof };
    if (rk) d.rk = { asof: rk.asof, n: rk.n, shown: rk.shown, mx: rk.median && rk.median.x, my: rk.median && rk.median.y, acima: rk.points.filter((q) => q.x > rk.median.x).length, abaixoY: rk.points.filter((q) => q.y > rk.median.y).length };
    if (hab && hab.tiles.length) { const hi = by(hab.tiles, (r, a) => r.value > a.value), lo = by(hab.tiles, (r, a) => r.value < a.value); d.hab = { asof: hab.asof, n: hab.tiles.length, hi, lo, ratio: hi.value / lo.value }; }
    if (imi && imi.rows.length) { const t = by(imi.rows, (r, a) => r.value > a.value); d.imi = { asof: imi.asof, n: imi.rows.length, total: sum(imi.rows), top: t, share: t.value / sum(imi.rows) * 100 }; }
    if (dg && dg.points.length > 1) { const a = dg.points[0], b = dg.points[dg.points.length - 1]; d.dg = { asof: dg.asof, y0: a.t, v0: a.v, y1: b.t, v1: b.v, change: (b.v / a.v - 1) * 100 }; }
    if (c && c.found && c.municipio) {
      const ix = {}; (c.indicadores || []).forEach((i) => { ix[i.key] = i; });
      d.conc = { name: c.municipio.name, district: c.municipio.district, asof: c.asof, href: c.municipio.href, ind: SHOW.map((k) => ix[k]).filter((i) => i && i.value != null), hab: c.habitacao, imi: c.imigracao, edu: c.educacao };
      d.conc.n = d.conc.ind.length;
      if (c.municipio.population) d.conc.pop = c.municipio.population;
      if (c.habitacao && c.habitacao.venda) { d.conc.venda = c.habitacao.venda; }
      if (c.imigracao) { d.conc.imiTotal = c.imigracao.total; d.conc.imiPer100 = c.imigracao.per100; d.conc.imiYear = c.imigracao.year; }
    } else if (name) d.naoEncontrado = name;
    return d;
  });
}

function setupSearch(d) {
  if (!document.querySelector("link[data-hi]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/historias/historias-inst.css"; l.dataset.hi = "1"; document.head.appendChild(l); }
  let tries = 0;
  const iv = setInterval(() => {
    const sec = document.getElementById("st-concelho"), cap = sec && sec.querySelector(".st-cap");
    if (++tries > 60) clearInterval(iv);
    if (!cap) return;
    clearInterval(iv);
    if (cap.querySelector(".hi-search")) return;
    const f = document.createElement("form");
    f.className = "hi-search";
    f.innerHTML = '<label>Procure um concelho<input type="search" list="hi-conc" autocomplete="off" placeholder="Escreva o nome do concelho"></label><button type="submit">Ver</button><datalist id="hi-conc"></datalist><p class="hi-msg" role="status"></p>';
    const dl = f.querySelector("datalist");
    d.lista.forEach((n) => { const o = document.createElement("option"); o.value = n; dl.appendChild(o); });
    const msg = f.querySelector(".hi-msg"), inp = f.querySelector("input");
    if (d.naoEncontrado) msg.textContent = "Não encontrámos «" + d.naoEncontrado + "». Verifique o nome.";
    f.addEventListener("keydown", (e) => e.stopPropagation());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = inp.value.trim(); if (!q) return;
      msg.textContent = "A procurar…";
      getJson("/api/historias/indicadores?concelho=" + encodeURIComponent(q)).then((r) => {
        if (!r.found) { msg.textContent = "Não encontrámos «" + q + "». Verifique o nome."; return; }
        const P = window.Portal, next = "#/historia/indicadores/concelho/" + encodeURIComponent(r.municipio.name);
        if (P && P.storyUnmount) P.storyUnmount();
        if (location.hash === next) location.hash = "#/historia/indicadores"; 
        location.hash = next;
      }).catch(() => { msg.textContent = "Não foi possível consultar os dados agora."; });
    });
    const src = cap.querySelector("p.st-src");
    cap.insertBefore(f, src || null);
  }, 150);
}

const scenes = [
  { id: "ine", label: "Indicadores", kicker: "O retrato",
    morph: { type: "counter", items: (d) => ({ value: d.ine.n, label: "Indicadores INE por município", unit: "indicadores" }) },
    headline: (d) => `*${d.ine.n} indicadores* para ${d.ine.municipios} municípios`,
    copy: "O INE fornece {{ine.n|int}} indicadores por município, de população a poder de compra, para {{ine.municipios|int}} concelhos.\n\nAs próximas cenas comparam concelhos entre si e com a mediana nacional dos municípios.",
    source: { label: "Indicadores INE", href: "#/indicadores", asof: (d) => d.ine.asof }, when: (d) => !!d.ine },
  { id: "ranking", label: "Poder de compra", kicker: "Concelhos lado a lado",
    morph: { type: "scatter", items: (d) => { const r = ds(d, "ranking"); return { points: r.points, xLabel: r.xLabel, yLabel: r.yLabel, median: r.median }; } },
    headline: (d) => `Poder de compra e envelhecimento nos *${d.rk.shown} maiores concelhos*`,
    copy: "Cada ponto é um concelho. A mediana dos {{rk.n|int}} municípios é {{rk.mx|dec1}} no poder de compra (Portugal = 100) e {{rk.my|dec1}} no índice de envelhecimento.\n\nDos {{rk.shown|int}} concelhos representados, {{rk.acima|int}} estão acima da mediana do poder de compra e {{rk.abaixoY|int}} acima da mediana do envelhecimento.",
    source: { label: "Indicadores INE", href: "#/indicadores", asof: (d) => d.rk.asof }, when: (d) => !!d.rk },
  { id: "habitacao", label: "Habitação", kicker: "Quanto custa morar",
    morph: { type: "tiles", items: (d) => ({ tiles: ds(d, "habitacao").tiles }) },
    headline: (d) => `Preço de venda: de *${Story.fmt.int(d.hab.lo.value)}* a *${Story.fmt.int(d.hab.hi.value)}* €/m²`,
    copy: "Nos {{hab.n|int}} concelhos com dados, o preço mediano de venda varia entre {{hab.lo.value|int}} €/m² em {{hab.lo.label|str}} e {{hab.hi.value|int}} €/m² em {{hab.hi.label|str}}.\n\nOs restantes concelhos não têm este indicador no trimestre em causa.",
    source: { label: "Habitação", href: "#/habitacao", asof: (d) => d.hab.asof }, when: (d) => !!d.hab },
  { id: "imigracao", label: "Imigração", kicker: "Quem vive aqui",
    morph: { type: "bars", items: (d) => ({ rows: ds(d, "imigracao").rows, unit: "residentes" }) },
    headline: (d) => `*${d.imi.top.label}* tem o maior número de residentes estrangeiros`,
    copy: "{{imi.top.label|str}} tem {{imi.top.value|int}} residentes estrangeiros, {{imi.share|pct}} dos {{imi.total|int}} dos {{imi.n|int}} concelhos apresentados.\n\nSão valores absolutos: concelhos maiores aparecem à frente por terem mais habitantes.",
    source: { label: "Imigração", href: "#/imigracao", asof: (d) => d.imi.asof }, when: (d) => !!d.imi },
  { id: "educacao", label: "Educação", kicker: "Quem aprende",
    morph: { type: "timeline", items: (d) => ({ points: ds(d, "dgeec").points.map((p) => ({ t: p.t.slice(0, 4) + "-09-01", v: p.v })), events: [] }) },
    headline: (d) => `Alunos matriculados: *${Story.fmt.pct(d.dg.change)}* desde ${d.dg.y0}`,
    copy: "Em {{dg.y0|str}} havia {{dg.v0|int}} crianças e alunos matriculados em todos os níveis de ensino. Em {{dg.y1|str}}, {{dg.v1|int}}.\n\nA série da DGEEC termina em {{dg.y1|str}}: não há aqui dados posteriores a 2020.",
    source: { label: "DGEEC", href: "#/dgeec", asof: (d) => d.dg.asof }, when: (d) => !!d.dg },
  { id: "concelho", label: "O seu concelho", kicker: "Procure o seu",
    morph: { type: "list", items: (d) => {
      if (!d.conc) return { rows: [{ title: "Escolha um concelho", sub: "Escreva o nome no campo ao lado para ver os indicadores", tag: "Procurar", href: "#/indicadores" }] };
      return { rows: d.conc.ind.map((i) => ({ title: i.label, sub: num(i.value, i.unit) + " · mediana " + num(i.median) + (i.year ? " · " + i.year : ""), tag: i.value > i.median ? "Acima da mediana" : i.value < i.median ? "Abaixo da mediana" : "Na mediana", href: d.conc.href })) };
    } },
    headline: (d) => (d.conc ? `*${d.conc.name}* em números` : "Como está *o seu concelho*?"),
    copy: "{{conc.name|str}} pertence ao distrito de {{conc.district|str}} (dados municipais do INE).\n\nA mediana é a dos {{ine.municipios|int}} municípios. Os valores são do ano indicado em cada linha.\n\nIndique o nome de um concelho para ver estes indicadores. O endereço da página guarda a sua escolha.",
    source: { label: "Indicadores INE", href: "#/indicadores", asof: (d) => (d.conc ? d.conc.asof : d.ine && d.ine.asof) } },
];

const directory = [
  { label: "Indicadores", href: "#/indicadores", desc: "Indicadores INE por município." },
  { label: "Habitação", href: "#/habitacao", desc: "Preços de venda e renda." },
  { label: "Imigração", href: "#/imigracao", desc: "Residentes estrangeiros por concelho." },
  { label: "DGEEC", href: "#/dgeec", desc: "Estatísticas da educação." },
  { label: "Autarquias", href: "#/autarquias", desc: "Municípios e finanças locais." },
];

const def = { title: "Como está o país que *estas decisões* mudam", question: "Como está o país que estas decisões mudam?", load: () => load().then((d) => { setupSearch(d); return d; }), scenes, directory };
Story.register("indicadores", def);
})();
