(function () {
"use strict";
const tl = (p) => (p || []).map((x) => (/^\d{4}-\d{2}$/.test(x.t) ? Object.assign({}, x, { t: x.t + "-01" }) : x));
const link = (d, s, t) => { const l = ((d.funil || {}).links || []).find((x) => x.s === s && x.t === t); return l ? l.v : null; };
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function prep(j) {
  const d = j.datasets || {};
  if (!d.votos && !d.hemiciclo && !d.funil) throw new Error("sem dados");
  const it = (d.votos && d.votos.items) || [];
  const find = (re) => it.find((c) => re.test(c.label));
  const hem = d.hemiciclo || {};
  d.k = {
    plenario: (find(/plen/i) || {}).value,
    ultimas4: (find(/4 semanas/i) || {}).value,
    iniciativas: (find(/Iniciativas acomp/i) || {}).value,
    divergentes: (find(/divergentes/i) || {}).value,
    ligadasDre: (find(/Di[aá]rio/i) || {}).value,
    favor: hem.seatsBySense && hem.seatsBySense.favor,
    contra: hem.seatsBySense && hem.seatsBySense.contra,
    abst: hem.seatsBySense && hem.seatsBySense.abstencao,
    semana: d.votosSemana && d.votosSemana.rows ? d.votosSemana.rows.length : null,
    entrada: link(d, "entrada", "semvot") != null ? (d.funil.links.filter((l) => l.s === "entrada").reduce((a, l) => a + l.v, 0)) : null,
    gok: link(d, "entrada", "gok"), rej: link(d, "entrada", "rej"), semvot: link(d, "entrada", "semvot"),
    fg: link(d, "gok", "fg"), prom: link(d, "fg", "prom"), veto: link(d, "fg", "veto"), aguarda: link(d, "fg", "aguarda"), pub: link(d, "prom", "pub"),
  };
  const top = ((d.intervencoes || {}).rows || [])[0];
  d.k.topParty = top && top.label; d.k.topN = top && top.value;
  d.k.hemTitle = short(hem.title, 140); d.k.hemShort = short(hem.title, 48);
  d.k.agendaN = d.agenda && d.agenda.rows ? d.agenda.rows.length : null;
  d.k.agendaFirst = d.agenda && d.agenda.rows && d.agenda.rows[0] ? d.agenda.rows[0].tag : null;
  d.asof = d.votos && d.votos.asof;
  return d;
}

const ds = (k) => (d) => (d[k] || {}).asof;
const scenes = [
  { id: "votos", label: "Votações", kicker: "Parlamento",
    morph: { type: "counter", items: (d) => ({ value: d.votos.items[0].value, label: "Votações em plenário registadas", unit: "votações" }) },
    headline: (d) => `*${Story.fmt.int(d.k.plenario)} votações* em plenário`,
    copy: "A base de dados acompanha {{k.plenario|int}} votações em plenário e {{k.iniciativas|int}} iniciativas.\n\nNas últimas quatro semanas houve {{k.ultimas4|int}} votações.\n\nEm {{k.divergentes|int}} votos individuais, o deputado votou de forma diferente da sua bancada. {{k.ligadasDre|int}} iniciativas já foram ligadas a um diploma publicado em Diário da República.",
    source: { label: "Votações da Assembleia da República", href: "#/votacoes", asof: ds("votos") },
    when: (d) => d.votos && d.k.plenario != null },
  { id: "semana", label: "Esta semana", kicker: "Votações finais",
    morph: { type: "list", items: (d) => ({ rows: d.votosSemana.rows }) },
    headline: (d) => `*${d.k.semana} votações finais* na última semana com votos`,
    copy: "Lista das votações finais globais nos sete dias até à última votação registada, em {{votosSemana.asof|date}}. A etiqueta indica o resultado.",
    source: { label: "Votações da Assembleia da República", href: "#/votacoes", asof: ds("votosSemana") },
    when: (d) => d.votosSemana && d.votosSemana.rows && d.votosSemana.rows.length > 0 },
  { id: "hemiciclo", label: "Hemiciclo", kicker: "Como votou cada bancada",
    morph: { type: "hemicycle", items: (d) => ({ title: d.k.hemShort, seats: d.hemiciclo.seats }) },
    headline: (d) => `${d.hemiciclo.result || "Votação"}: *${d.k.favor} a favor*, ${d.k.contra} contra`,
    copy: "Última votação final global com pelo menos cinco bancadas registadas: {{hemiciclo.fase|str}}, a {{hemiciclo.asof|date}}.\n\n{{k.hemTitle|str}}\n\nOs lugares somam {{k.favor|int}} a favor, {{k.contra|int}} contra e {{k.abst|int}} abstenções, tomando o voto da bancada como voto de todos os seus deputados.",
    source: { label: "Votações da Assembleia da República", href: "#/votacoes", asof: ds("hemiciclo") },
    when: (d) => d.hemiciclo && d.hemiciclo.seats && d.hemiciclo.seats.length > 0 },
  { id: "funil", label: "Da proposta à lei", kicker: "Legislatura XVII",
    morph: { type: "sankey", items: (d) => ({ nodes: d.funil.nodes, links: d.funil.links }) },
    headline: (d) => `Dos *${Story.fmt.int(d.k.entrada)} textos* entrados, ${Story.fmt.int(d.k.prom)} foram promulgados`,
    copy: "Projetos e propostas de lei da XVII Legislatura: {{k.semvot|int}} ainda sem votação na generalidade, {{k.rej|int}} rejeitados e {{k.gok|int}} aprovados na generalidade.\n\nDestes, {{k.fg|int}} chegaram à votação final global. Foram promulgados {{k.prom|int}}, {{k.veto|int}} vetados e {{k.aguarda|int}} aguardam decisão do Presidente. {{k.pub|int}} promulgados constam já como publicados em Diário da República.",
    source: { label: "Iniciativas e fases do processo legislativo", href: "#/votacoes", asof: ds("funil") },
    when: (d) => d.funil && d.funil.links && d.funil.links.length > 0 && d.k.entrada != null },
  { id: "posicoes", label: "Disseram e votaram", kicker: "Declarado e votado",
    morph: { type: "scatter", items: (d) => ({ points: d.posicoes.points, xLabel: d.posicoes.xLabel, yLabel: d.posicoes.yLabel, median: d.posicoes.median }) },
    headline: () => "Cada partido votou como *falou*?",
    copy: "Das {{posicoes.total.comparaveis|int}} declarações comparáveis com um voto, {{posicoes.total.coincidem|int}} coincidiram com a votação e {{posicoes.total.divergem|int}} divergiu.\n\nA amostra é muito pequena: cada partido tem poucas declarações comparáveis, por isso 0 % ou 100 % de coincidência diz pouco sobre o partido. Só declarações explícitas, ligadas a uma votação concreta, entram na conta.",
    source: { label: "Posições e declarações", href: "#/partidos", asof: ds("posicoes") },
    when: (d) => d.posicoes && d.posicoes.points && d.posicoes.points.length > 0 },
  { id: "intervencoes", label: "Quem fala", kicker: "Intervenções em plenário",
    morph: { type: "bars", items: (d) => ({ rows: d.intervencoes.rows, unit: d.intervencoes.unit }) },
    headline: (d) => `Intervenções por partido: ${d.k.topParty} regista *${Story.fmt.int(d.k.topN)}*`,
    copy: "Número de intervenções de deputados em plenário, por partido, desde o início da base de dados. Falar mais não significa votar de forma diferente: este gráfico mede presença na palavra, não influência.",
    source: { label: "Intervenções parlamentares", href: "#/partidos", asof: ds("intervencoes") },
    when: (d) => d.intervencoes && d.intervencoes.rows && d.intervencoes.rows.length > 0 },
  { id: "agenda", label: "Agenda", kicker: "A seguir",
    morph: { type: "list", items: (d) => ({ rows: d.agenda.rows }) },
    headline: () => "O que vem *a seguir* em São Bento",
    copy: "Os próximos {{k.agendaN|int}} eventos parlamentares na agenda, a começar em {{k.agendaFirst|date}}. A agenda completa está no calendário.",
    source: { label: "Agenda parlamentar", href: "#/calendario", asof: ds("agenda") },
    when: (d) => d.agenda && d.agenda.rows && d.agenda.rows.length > 0 },
];

Story.register("parlamento", {
  title: "Quem decidiu esta *semana*",
  question: "Quem decidiu esta semana, e cada partido votou como falou?",
  load: () => fetch("/api/historias/parlamento").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(prep),
  scenes,
  directory: [
    { label: "Calendário", href: "#/calendario", desc: "Agenda do Parlamento e da Presidência." },
    { label: "Leis em curso", href: "#/leis", desc: "Do projeto à votação." },
    { label: "Deputados", href: "#/deputados", desc: "Quem são e onde se sentam." },
    { label: "Partidos", href: "#/partidos", desc: "Bancadas e posições." },
    { label: "Votações", href: "#/votacoes", desc: "Todas as votações em plenário." },
    { label: "Eleições", href: "#/eleicoes", desc: "Resultados eleitorais." },
    { label: "Visão geral", href: "#/parlamento", desc: "A Assembleia da República em síntese." },
  ],
  fallback: [{ label: "Parlamento", href: "#/parlamento" }, { label: "Votações", href: "#/votacoes" }],
});
})();
