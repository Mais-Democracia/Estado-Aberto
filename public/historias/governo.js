(function () {
"use strict";
const tl = (p) => (p || []).map((x) => (/^\d{4}-\d{2}$/.test(x.t) ? Object.assign({}, x, { t: x.t + "-01" }) : x));
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const mes = (t) => (t ? MESES[+t.slice(5, 7) - 1] + " de " + t.slice(0, 4) : null);
const sum = (p, n) => p.slice(-n).reduce((a, x) => a + x.v, 0);
const peak = (p) => p.reduce((m, x) => (x.v > m.v ? x : m), p[0]);

function prep(j) {
  const d = j.datasets || {};
  if (!d.rede && !d.decretosLei && !d.nomeacoes) throw new Error("sem dados");
  const k = (d.k = {});
  const nodes = (d.rede && d.rede.nodes) || [];
  const mins = nodes.filter((n) => n.group === "ministerio");
  k.ministerios = mins.length || null;
  k.secretarios = nodes.filter((n) => n.group === "secretario").length || null;
  k.entidades = nodes.filter((n) => n.group === "entidade").length || null;
  const topMin = mins.slice().sort((a, b) => b.size - a.size)[0];
  k.topMin = topMin && topMin.label; k.topMinEur = topMin && topMin.size;
  const nm = (d.nomeacoes && d.nomeacoes.points) || [];
  if (nm.length) { k.nom24 = sum(nm, nm.length); const p = peak(nm); k.nomPeak = p.v; k.nomPeakMes = mes(p.t); k.nomFirst = mes(nm[0].t); }
  const dl = (d.decretosLei && d.decretosLei.points) || [];
  if (dl.length) { k.dlTotal = sum(dl, dl.length); const p = peak(dl); k.dlPeak = p.v; k.dlPeakMes = mes(p.t); k.dlFirst = mes(dl[0].t); k.dlLast = dl[dl.length - 1].v; k.dlLastMes = mes(dl[dl.length - 1].t); }
  const ev = (d.decretosLei && d.decretosLei.events) || [];
  k.dlEvento = ev[0] && ev[0].label;
  const pv = (d.promulgacoesVetos && d.promulgacoesVetos.items) || [];
  k.prom = (pv[0] || {}).value; k.vetos = (pv[1] || {}).value; k.tc = (pv[2] || {}).value;
  k.presidente = d.promulgacoesVetos && d.promulgacoesVetos.presidente;
  const ep = ((d.empregoPublico || {}).rows) || [];
  k.epTop = ep[0] && ep[0].label; k.epTopN = ep[0] && ep[0].value;
  k.epTopPct = ep[0] && d.empregoPublico.total ? (100 * ep[0].value / d.empregoPublico.total) : null;
  const es = (d.empregoSerie && d.empregoSerie.points) || [];
  if (es.length) { k.esFirst = es[0].v; k.esLast = es[es.length - 1].v; k.esFirstYear = es[0].t.slice(0, 4); }
  const ec = (d.empregoContrato && d.empregoContrato.rows) || [];
  k.ecTop = ec[0] && ec[0].label; k.ecTopN = ec[0] && ec[0].value;
  d.asof = d.rede && d.rede.asof;
  return d;
}

const ds = (k) => (d) => (d[k] || {}).asof;
const scenes = [
  { id: "rede", label: "Quem governa", kicker: "Governo",
    morph: { type: "network", items: (d) => ({ nodes: d.rede.nodes, links: d.rede.links }) },
    headline: (d) => `Um Governo, *${d.k.ministerios} ministérios*`,
    copy: "O Governo está organizado em {{k.ministerios|int}} ministérios, com {{k.secretarios|int}} secretários de Estado listados. Cada ministério liga-se às três entidades que mais contrataram a seguir a si.\n\nO tamanho de cada ministério reflete o valor contratado pelas suas entidades. O maior é {{k.topMin|str}}, com {{k.topMinEur|eur}} contratados.",
    source: { label: "Ministérios e contratos públicos", href: "#/ministerios", asof: ds("rede") },
    when: (d) => d.rede && d.rede.nodes && d.rede.nodes.length > 1 },
  { id: "nomeacoes", label: "Quem nomeia", kicker: "Nomeações",
    morph: { type: "timeline", items: (d) => ({ points: tl(d.nomeacoes.points), events: tl(d.nomeacoes.events) }) },
    headline: (d) => `*${d.k.nom24} nomeações*, designações e exonerações no Diário da República`,
    copy: "Desde {{k.nomFirst|str}}, o Diário da República publicou {{k.nom24|int}} nomeações, designações e exonerações nos registos acompanhados.\n\nO mês com mais atos foi {{k.nomPeakMes|str}}, com {{k.nomPeak|int}}. Os meses sem pontos não têm atos registados.",
    source: { label: "Quem decide: responsáveis", href: "#/responsaveis", asof: ds("nomeacoes") },
    when: (d) => d.nomeacoes && d.nomeacoes.points && d.nomeacoes.points.length > 1 },
  { id: "decretos", label: "O que decidiu", kicker: "Decretos-Lei",
    morph: { type: "timeline", items: (d) => ({ points: tl(d.decretosLei.points), events: tl(d.decretosLei.events) }) },
    headline: (d) => `*${Story.fmt.int(d.k.dlTotal)} decretos-lei* publicados desde ${d.k.dlFirst}`,
    copy: "Os decretos-lei são os diplomas com que o Governo legisla. Por mês, o máximo foi {{k.dlPeakMes|str}}, com {{k.dlPeak|int}}.\n\nEm {{k.dlLastMes|str}}, último mês nos dados e possivelmente incompleto, há {{k.dlLast|int}}.\n\n{{k.dlEvento|str}}.",
    source: { label: "Diário da República", href: "#/dre", asof: ds("decretosLei") },
    when: (d) => d.decretosLei && d.decretosLei.points && d.decretosLei.points.length > 1 },
  { id: "presidente", label: "O Presidente", kicker: "Promulgar ou vetar",
    morph: { type: "counter", items: (d) => ({ value: d.k.prom, label: "Diplomas promulgados", unit: "diplomas" }) },
    headline: (d) => `*${d.k.prom} promulgações* e ${d.k.vetos} vetos`,
    copy: "Nos atos de {{k.presidente|str}}, contam-se {{k.prom|int}} promulgações, {{k.vetos|int}} vetos e {{k.tc|int}} pedido ao Tribunal Constitucional.\n\nÉ o Presidente da República que decide se um diploma do Governo ou do Parlamento entra em vigor.",
    source: { label: "Atos do Presidente", href: "#/atos-presidente", asof: ds("promulgacoesVetos") },
    when: (d) => d.promulgacoesVetos && d.k.prom != null },
  { id: "emprego", label: "O Estado empregador", kicker: "Emprego público",
    morph: { type: "bars", items: (d) => ({ rows: d.empregoPublico.rows, unit: d.empregoPublico.unit }) },
    headline: (d) => `*${Story.fmt.int(d.empregoPublico.total)} trabalhadores* nas administrações públicas`,
    copy: "O emprego público soma {{empregoPublico.total|int}} trabalhadores. A administração central tem {{k.epTopN|int}}, ou {{k.epTopPct|pct}} do total.\n\nCom contrato por tempo indeterminado estão {{k.ecTopN|int}}.\n\nFace ao ano anterior, a variação é de {{empregoPublico.delta|int}} trabalhadores.",
    source: { label: "Estado: emprego público", href: "#/estado", asof: ds("empregoPublico") },
    when: (d) => d.empregoPublico && d.empregoPublico.rows && d.empregoPublico.rows.length > 0 },
  { id: "serie", label: "Ao longo do tempo", kicker: "Emprego público",
    morph: { type: "timeline", items: (d) => ({ points: tl(d.empregoSerie.points), events: tl(d.empregoSerie.events) }) },
    headline: (d) => `De ${Story.fmt.int(d.k.esFirst)} para *${Story.fmt.int(d.k.esLast)}* trabalhadores`,
    copy: "Número de trabalhadores das administrações públicas em cada data de referência trimestral, de {{k.esFirstYear|str}} até {{empregoSerie.asof|date}}.",
    source: { label: "Estado: emprego público", href: "#/estado", asof: ds("empregoSerie") },
    when: (d) => d.empregoSerie && d.empregoSerie.points && d.empregoSerie.points.length > 1 },
];

Story.register("governo", {
  title: "Quem governa, quem *nomeia*",
  question: "Quem governa, quem nomeia, o que decidiu?",
  load: () => fetch("/api/historias/governo").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(prep),
  scenes,
  directory: [
    { label: "Governo", href: "#/governo", desc: "Primeiro-ministro e Conselho de Ministros." },
    { label: "Ministérios", href: "#/ministerios", desc: "Cada ministério, os seus responsáveis e contratos." },
    { label: "Presidência", href: "#/presidencia", desc: "O Presidente da República." },
    { label: "Atos do Presidente", href: "#/atos-presidente", desc: "Promulgações e vetos." },
    { label: "Quem decide", href: "#/responsaveis", desc: "Nomeações e responsáveis." },
    { label: "Estado e empresas", href: "#/estado", desc: "Emprego público e setor empresarial." },
    { label: "Os poderes", href: "#/poderes", desc: "O que cada órgão pode fazer." },
  ],
  fallback: [{ label: "Governo", href: "#/governo" }, { label: "Ministérios", href: "#/ministerios" }],
});
})();
