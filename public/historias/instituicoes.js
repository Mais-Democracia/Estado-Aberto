(function () {
"use strict";
const KIND = { freguesia: "Freguesias", municipio: "Municípios", saude: "Saúde", instituto_publico: "Institutos públicos", tribunal_justica: "Tribunais", empresa_municipal: "Empresas municipais", sociedade_adjudicante: "Sociedades adjudicantes", outra_entidade: "Outras entidades", seguranca_defesa: "Segurança e defesa", terceiro_setor: "Terceiro setor", universidade: "Universidades", escola: "Escolas" };
const ds = (d, k) => (d && d.datasets && d.datasets[k]) || null;
const sum = (rows) => rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
const top = (rows) => rows.reduce((a, r) => (a == null || r.value > a.value ? r : a), null);

function load() {
  return fetch("/api/historias/instituicoes").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((p) => {
    const d = { datasets: p.datasets || {} }, rede = ds(d, "rede"), dec = ds(d, "reguladoresDecisoes"), coi = ds(d, "reguladoresCoimas"), sau = ds(d, "saudeConsultas"), cri = ds(d, "segurancaCrimes"), edu = ds(d, "educacaoDistritos");
    if (rede) {
      const est = rede.nodes.find((n) => n.id === "estado"), ks = rede.nodes.filter((n) => /^k:/.test(n.id));
      d.rede = { asof: rede.asof, total: est && est.size, tipos: ks.length, maior: top(ks.map((n) => ({ label: KIND[n.id.slice(2)] || n.label, value: n.size }))) };
    }
    if (dec) { d.dec = { asof: dec.asof, n: dec.rows.length, total: sum(dec.rows), top: top(dec.rows) }; }
    if (coi) { d.coi = { asof: coi.asof, n: coi.rows.length, total: sum(coi.rows), top: top(coi.rows) }; }
    if (sau && sau.points.length > 1) {
      const p0 = sau.points, a = p0[0], b = p0[p0.length - 1], y20 = p0.find((x) => x.t === "2020"), y19 = p0.find((x) => x.t === "2019");
      d.sau = { asof: sau.asof, y0: a.t, v0: a.v, y1: b.t, v1: b.v, growth: (b.v / a.v - 1) * 100, dip: y20 && y19 ? (y20.v / y19.v - 1) * 100 : null, v20: y20 && y20.v };
    }
    if (cri) { d.cri = { asof: cri.asof, total: sum(cri.rows), top: top(cri.rows) }; if (d.cri.top) d.cri.topShare = d.cri.top.value / d.cri.total * 100; }
    if (edu) { const t = top(edu.tiles); d.edu = { asof: edu.asof, total: sum(edu.tiles), n: edu.tiles.length, top: t, share: t ? t.value / sum(edu.tiles) * 100 : null }; }
    d.asof = p.built ? p.built.slice(0, 10) : null;
    return d;
  });
}

const scenes = [
  { id: "rede", label: "Rede", kicker: "O Estado em entidades",
    morph: { type: "network", items: (d) => { const r = ds(d, "rede"); return { nodes: r.nodes.map((n) => (/^k:/.test(n.id) ? Object.assign({}, n, { label: KIND[n.id.slice(2)] || n.label }) : n)), links: r.links }; } },
    headline: (d) => `*${Story.fmt.int(d.rede.total)} entidades públicas* em ${d.rede.tipos} famílias`,
    copy: "O diretório conta {{rede.total|int}} entidades públicas, agrupadas em {{rede.tipos|int}} tipos. A família maior é a das {{rede.maior.label|str}}, com {{rede.maior.value|int}}.\n\nCada família mostra as entidades com mais valor contratado. O tamanho dos pontos reflete o número de entidades de cada tipo e, nas entidades, o valor em euros contratado.",
    source: { label: "Entidades públicas", href: "#/entidades", asof: (d) => d.rede.asof }, when: (d) => !!ds(d, "rede") && d.rede.total },
  { id: "decisoes", label: "Decisões", kicker: "Quem regula",
    morph: { type: "bars", items: (d) => ({ rows: ds(d, "reguladoresDecisoes").rows, unit: "decisões" }) },
    headline: (d) => `Só *${d.dec.n} reguladores* têm decisões contabilizadas`,
    copy: "Os dados abertos incluem {{dec.total|int}} decisões publicadas por {{dec.n|int}} reguladores. A maior fatia é da {{dec.top.label|str}}, com {{dec.top.value|int}}.\n\nOs restantes reguladores não têm esta contagem disponível. A ausência de números nesta cena não significa ausência de decisões.",
    source: { label: "Reguladores", href: "#/reguladores", asof: (d) => d.dec.asof }, when: (d) => !!ds(d, "reguladoresDecisoes") && d.dec.n > 0 },
  { id: "coimas", label: "Coimas", kicker: "Quem sanciona",
    morph: { type: "bars", items: (d) => ({ rows: ds(d, "reguladoresCoimas").rows, unit: "coimas" }) },
    headline: (d) => `Coimas e sanções: *${d.coi.n} reguladores* com registo`,
    copy: "Há {{coi.total|int}} coimas e sanções registadas, de {{coi.n|int}} reguladores. A {{coi.top.label|str}} tem o maior número, {{coi.top.value|int}}.\n\nContar sanções não mede a eficácia da fiscalização: só mostra o que está publicado. Quem não aparece pode não ter dados recolhidos.",
    source: { label: "Reguladores", href: "#/reguladores", asof: (d) => d.coi.asof }, when: (d) => !!ds(d, "reguladoresCoimas") && d.coi.n > 0 },
  { id: "saude", label: "Saúde", kicker: "Quem serve · Saúde",
    morph: { type: "timeline", items: (d) => ({ points: ds(d, "saudeConsultas").points, events: [] }) },
    headline: (d) => `Consultas hospitalares: *${Story.fmt.dec1(d.sau.v1 / 1e6)} milhões* em ${d.sau.y1}`,
    copy: "Os hospitais públicos fizeram {{sau.v1|int}} consultas externas em {{sau.y1|str}}, contra {{sau.v0|int}} em {{sau.y0|str}}. A variação no período é de {{sau.growth|pct}}.\n\nEm 2020 o total foi {{sau.v20|int}}, {{sau.dip|pct}} face a 2019.",
    source: { label: "Saúde (INE)", href: "#/saude", asof: (d) => d.sau.asof }, when: (d) => !!ds(d, "saudeConsultas") && d.sau },
  { id: "seguranca", label: "Segurança", kicker: "Quem serve · Segurança",
    morph: { type: "bars", items: (d) => ({ rows: ds(d, "segurancaCrimes").rows, unit: "crimes" }) },
    headline: (d) => `*${Story.fmt.int(d.cri.total)}* crimes registados nas categorias principais`,
    copy: "As categorias apresentadas somam {{cri.total|int}} crimes registados. A maior é «{{cri.top.label|str}}», com {{cri.top.value|int}}, ou {{cri.topShare|pct}} do conjunto.\n\nO registo mede crimes comunicados e registados, não a criminalidade real.",
    source: { label: "Segurança", href: "#/seguranca", asof: (d) => d.cri.asof }, when: (d) => !!ds(d, "segurancaCrimes") && d.cri },
  { id: "educacao", label: "Educação", kicker: "Quem serve · Educação",
    morph: { type: "tiles", items: (d) => ({ tiles: ds(d, "educacaoDistritos").tiles }) },
    headline: (d) => `Alunos por distrito: *${d.edu.top.label}* à frente`,
    copy: "Nos {{edu.n|int}} distritos e regiões apresentados há {{edu.total|int}} alunos. {{edu.top.label|str}} tem {{edu.top.value|int}}, {{edu.share|pct}} do total.\n\nOs dados são do ano letivo {{edu.asof|str}}: não há aqui um retrato mais recente.",
    source: { label: "Educação", href: "#/educacao", asof: (d) => d.edu.asof }, when: (d) => !!ds(d, "educacaoDistritos") && d.edu },
];

const directory = [
  { label: "Entidades", href: "#/entidades", desc: "Diretório de entidades públicas." },
  { label: "Reguladores", href: "#/reguladores", desc: "Decisões e coimas dos reguladores." },
  { label: "Saúde", href: "#/saude", desc: "Consultas e indicadores hospitalares." },
  { label: "Segurança", href: "#/seguranca", desc: "Criminalidade registada." },
  { label: "Educação", href: "#/educacao", desc: "Alunos e escolas por distrito." },
];

Story.register("instituicoes", { title: "Quem regula, quem serve, com *que resultados*", question: "Quem regula, quem serve, com que resultados?", load, scenes, directory });
})();
