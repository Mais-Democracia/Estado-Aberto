(function () {
"use strict";
const F = () => Story.fmt;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const mesLongo = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric", timeZone: "UTC" });
const mesTxt = (t) => { const m = /^(\d{4})-(\d{2})/.exec(String(t || "")); return m ? mesLongo.format(Date.UTC(+m[1], +m[2] - 1, 1)) : null; };
const eurI = (v) => new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 }).format(v) + " €";
const eurM = (m) => F().eur(m * 1e6);

function derive(ds) {
  const c = {};
  const o = ds.orcamento;
  if (o && o.nodes && o.links) {
    const lab = Object.fromEntries(o.nodes.map((n) => [n.id, n.label]));
    const rec = o.links.filter((l) => l.t === "oe"), min = o.links.filter((l) => l.s === "oe");
    c.orc = { receitaM: sum(rec, (l) => l.v), nReceita: rec.length, despesaM: sum(min, (l) => l.v), nMin: min.length };
    const top = min.slice().sort((a, b) => b.v - a.v)[0];
    if (top) { c.orc.topLabel = lab[top.t]; c.orc.topM = top.v; c.orc.topPct = top.v / c.orc.despesaM * 100; }
    const div = o.links.find((l) => /D[ÍI]VIDA/i.test(lab[l.t] || "") && l.s === (top && top.t));
    if (div) { c.orc.dividaM = div.v; c.orc.dividaPctMin = div.v / top.v * 100; }
    const topRec = rec.slice().sort((a, b) => b.v - a.v)[0];
    if (topRec) { c.orc.recLabel = lab[topRec.s]; c.orc.recM = topRec.v; }
    c.orc.receitaTxt = eurM(c.orc.receitaM); c.orc.despesaTxt = eurM(c.orc.despesaM); c.orc.topTxt = top && eurM(top.v); c.orc.dividaTxt = div && eurM(div.v); c.orc.recTxt = topRec && eurM(topRec.v);
  }
  const k = ds.contratosMes;
  if (k && k.points && k.points.length > 3) {
    const asof = k.asof, last = k.points[k.points.length - 1].t, d = new Date(asof + "T00:00:00Z");
    const eom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const partial = last === asof.slice(0, 7) && d.getUTCDate() < eom;
    const full = partial ? k.points.slice(0, -1) : k.points, cnt = partial ? k.count.slice(0, -1) : k.count;
    const last12 = full.slice(-12), peak = full.slice().sort((a, b) => b.v - a.v)[0];
    c.contr = { full, partial, partialMonth: partial ? mesTxt(last) : null, nMonths: full.length, firstMonth: mesTxt(full[0].t), lastMonth: mesTxt(full[full.length - 1].t), last12M: sum(last12, (p) => p.v), last12N: sum(cnt.slice(-12), (p) => p.v), peakMonth: mesTxt(peak.t), peakM: peak.v };
    c.contr.last12Txt = eurM(c.contr.last12M); c.contr.peakTxt = eurM(peak.v);
  }
  const r = ds.rede;
  if (r && r.nodes && r.links) {
    const grp = Object.fromEntries(r.nodes.map((n) => [n.id, n.group])), by = {};
    r.nodes.forEach((n) => { by[n.group] = (by[n.group] || 0) + 1; });
    const tot = (g) => { const m = {}; r.links.forEach((l) => { if (grp[l.t] === g) m[l.t] = (m[l.t] || 0) + l.v; }); const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; if (!e) return null; const n = r.nodes.find((x) => x.id === e[0]); return { label: n.label, v: e[1] }; };
    const f = tot("fornecedor"), en = tot("entidade");
    c.rede = { n: r.nodes.length, nMin: by.ministerio || 0, nEnt: by.entidade || 0, nForn: by.fornecedor || 0, nLinks: r.links.length, fornLabel: f && f.label, fornTxt: f && F().eur(f.v), entLabel: en && en.label, entTxt: en && F().eur(en.v) };
  }
  const rk = ds.risco;
  if (rk && rk.rows && rk.rows.length) {
    const max = Math.max(...rk.rows.map((x) => +x.value));
    c.risco = { n: rk.rows.length, max, nMax: rk.rows.filter((x) => +x.value === max).length };
  }
  const fu = ds.fundosConcelho;
  if (fu && fu.points && fu.points.length) {
    const top = fu.points.slice().sort((a, b) => b.y - a.y)[0];
    c.fundos = { n: fu.n, shown: fu.shown || fu.points.length, medianY: fu.median && fu.median.y, topLabel: top.label, topY: top.y, medianTxt: fu.median && eurI(fu.median.y), topTxt: eurI(top.y) };
  }
  const dv = ds.divida;
  if (dv && Number.isFinite(+dv.value)) {
    const prev = dv.value - (dv.delta || 0);
    c.divida = { asofTxt: mesTxt(dv.asof), value: dv.value, valueTxt: F().eur(dv.value * 1e6), deltaPct: dv.delta != null && prev ? dv.delta / prev * 100 : null, absDeltaPct: dv.delta != null && prev ? Math.abs(dv.delta / prev * 100) : null, down: dv.delta < 0, prazo: dv.prazoMedioAnos, fixa: dv.pctTaxaFixa };
  }
  return c;
}

const asof = (k) => (d) => d.ds[k] && d.ds[k].asof;
const has = (k) => (d) => !!(d.ds[k]);

Story.register("dinheiro", {
  title: "Quem decidiu gastar o *dinheiro público*",
  question: "Quem decidiu gastar, em quê, e quem fiscalizou?",
  load: () => fetch("/api/historias/dinheiro").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then((j) => { if (!j || !j.datasets) throw new Error("sem dados"); return { ds: j.datasets, c: derive(j.datasets), built: j.built }; }),
  scenes: [
    { id: "orcamento", label: "Orçamento", kicker: "Quem decidiu",
      morph: { type: "sankey", items: (d) => ({ nodes: d.ds.orcamento.nodes, links: d.ds.orcamento.links }) },
      headline: (d) => `O Orçamento do Estado reparte *${d.c.orc.despesaTxt}* por ${d.c.orc.nMin} ministérios`,
      copy: "A despesa programada para {{ds.orcamento.asof|str}} soma {{c.orc.despesaTxt|str}} nos {{c.orc.nMin|int}} maiores ministérios. {{c.orc.topLabel|str}} concentra {{c.orc.topTxt|str}}, ou {{c.orc.topPct|pct}} desse total.\n\nDesse valor, {{c.orc.dividaTxt|str}} são gestão da dívida pública. Do lado da receita, os impostos listados somam {{c.orc.receitaTxt|str}}; o maior é {{c.orc.recLabel|str}}, com {{c.orc.recTxt|str}}.\n\nReceita e despesa não se equilibram neste desenho: a diferença é coberta por outras receitas e por dívida.",
      source: { label: "Orçamento do Estado", href: "#/orcamento", asof: asof("orcamento") }, when: (d) => d.c.orc && d.c.orc.nMin > 0 },
    { id: "contratos", label: "Contratos", kicker: "Em quê",
      morph: { type: "timeline", items: (d) => { const f = d.c.contr.full; return { points: f.map((p) => ({ t: p.t + "-01", v: p.v })), events: d.c.contr.partial ? [{ t: f[f.length - 1].t + "-01", label: "Último mês completo", href: "#/contratos" }] : [] }; } },
      headline: (d) => `*${d.c.contr.last12Txt}* contratados em doze meses`,
      copy: "Nos 12 meses completos até {{c.contr.lastMonth|str}}, as entidades públicas contrataram {{c.contr.last12Txt|str}} em {{c.contr.last12N|int}} contratos. O mês mais forte da série, desde {{c.contr.firstMonth|str}}, foi {{c.contr.peakMonth|str}}, com {{c.contr.peakTxt|str}}. O eixo vertical mostra milhões de euros por mês.\n\nCuidado com o fim da série: os dados vão apenas até {{ds.contratosMes.asof|date}}, por isso {{c.contr.partialMonth|str}}, ainda incompleto, não é mostrado. Os meses mais recentes podem ainda não incluir todos os contratos.",
      source: { label: "Contratos públicos", href: "#/contratos", asof: asof("contratosMes") }, when: (d) => d.c.contr },
    { id: "constelacao", label: "Constelação", kicker: "Quem recebeu",
      morph: { type: "network", items: (d) => ({ nodes: d.ds.rede.nodes, links: d.ds.rede.links }) },
      headline: (d) => `Uma constelação de *${d.c.rede.n} nós* em torno de ${d.c.rede.nMin} ministérios`,
      copy: "Cada ponto é um ministério, uma entidade compradora ou um fornecedor; cada fio, dinheiro contratado. A vista reúne {{c.rede.nMin|int}} ministérios, {{c.rede.nEnt|int}} entidades compradoras e {{c.rede.nForn|int}} fornecedores, os de maior valor contratado.\n\nEntre os fornecedores representados, {{c.rede.fornLabel|str}} lidera, com {{c.rede.fornTxt|str}} contratados. Entre as entidades compradoras, a maior é {{c.rede.entLabel|str}}, com {{c.rede.entTxt|str}}. Passe o rato sobre um ponto para ver o nome e clique num ministério para abrir a sua página.",
      source: { label: "Ministérios e contratos", href: "#/ministerios", asof: asof("rede") }, when: (d) => d.c.rede && d.c.rede.n > 20 },
    { id: "fiscalizacao", label: "Fiscalização", kicker: "Quem fiscalizou",
      morph: { type: "bars", items: (d) => ({ rows: d.ds.risco.rows, max: 10, unit: "pontos de risco" }) },
      headline: (d) => `*${d.c.risco.n} entidades* têm as pontuações de risco mais altas`,
      copy: "O sistema de risco pontua de 0 a 10 cada entidade, com base em padrões nos seus contratos. Entre as {{c.risco.n|int}} mais pontuadas, {{c.risco.nMax|int}} chegam à pontuação máxima observada, {{c.risco.max|int}}.\n\nSão sinais estatísticos para orientar quem fiscaliza, não acusações nem prova de irregularidade. Clique numa barra para ver os pormenores da entidade.",
      source: { label: "Indicadores de risco", href: "#/risco", asof: asof("risco") }, when: (d) => d.c.risco },
    { id: "fundos", label: "Fundos", kicker: "Fundos europeus",
      morph: { type: "scatter", items: (d) => ({ points: d.ds.fundosConcelho.points, xLabel: d.ds.fundosConcelho.xLabel, yLabel: d.ds.fundosConcelho.yLabel, median: d.ds.fundosConcelho.median }) },
      headline: () => "O dinheiro europeu chega *de forma desigual* aos concelhos",
      copy: "Em {{c.fundos.n|int}} municípios, a mediana dos fundos europeus aprovados é de {{c.fundos.medianTxt|str}} por habitante. Entre os {{c.fundos.shown|int}} maiores representados, {{c.fundos.topLabel|str}} tem o valor mais alto: {{c.fundos.topTxt|str}} por habitante.\n\nCada ponto é um concelho e a cor indica o partido que o governa. A linha a tracejado é a mediana nacional.",
      source: { label: "Fundos europeus", href: "#/fundos", asof: asof("fundosConcelho") }, when: (d) => d.c.fundos },
    { id: "divida", label: "Dívida", kicker: "A conta",
      morph: { type: "counter", items: (d) => ({ value: d.ds.divida.value / 1000, label: d.ds.divida.label, unit: "mil milhões de euros", delta: d.c.divida.deltaPct }) },
      headline: (d) => `A dívida direta do Estado soma *${d.c.divida.valueTxt}*`,
      copy: "A dívida direta do Estado está em {{c.divida.valueTxt|str}} em {{c.divida.asofTxt|str}}. A variação homóloga é de {{c.divida.deltaPct|pct}}.\n\nO prazo médio é de {{c.divida.prazo|dec1}} anos e {{c.divida.fixa|pct}} da dívida tem taxa fixa.",
      source: { label: "Dívida pública", href: "#/divida", asof: asof("divida") }, when: (d) => d.c.divida },
  ],
  directory: [
    { label: "Orçamento do Estado", href: "#/orcamento", desc: "Receita e despesa por ministério e programa." },
    { label: "Contratos públicos", href: "#/contratos", desc: "Quem contratou, a quem e por quanto." },
    { label: "Indicadores de risco", href: "#/risco", desc: "Pontuações por entidade, com a metodologia." },
    { label: "Fundos europeus", href: "#/fundos", desc: "Fundos aprovados e pagos por concelho." },
    { label: "Dívida pública", href: "#/divida", desc: "Stock, prazo médio e composição." },
    { label: "Ministérios", href: "#/ministerios", desc: "Cada ministério, os seus organismos e contratos." },
  ],
  fallback: [{ label: "Orçamento", href: "#/orcamento" }, { label: "Contratos", href: "#/contratos" }, { label: "Dívida", href: "#/divida" }],
});
})();
