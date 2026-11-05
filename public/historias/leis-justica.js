(function () {
"use strict";
const tl = (p) => (p || []).map((x) => (/^\d{4}-\d{2}$/.test(x.t) ? Object.assign({}, x, { t: x.t + "-01" }) : x));
const link = (d, s, t) => { const l = ((d.funil || {}).links || []).find((x) => x.s === s && x.t === t); return l ? l.v : null; };
const sum = (p) => (p || []).reduce((a, x) => a + x.v, 0);
const last = (a, n) => (a || []).slice(-n);

function prep(j) {
  const d = j.datasets || {};
  if (!d.funil && !d.dreLeis && !d.tcAno) throw new Error("sem dados");
  const k = (d.k = {});
  k.leis = sum((d.dreLeis || {}).points); k.dl = sum((d.dreDecretosLei || {}).points);
  k.port = sum((d.drePortarias || {}).points); k.rcm = sum((d.dreResolucoes || {}).points);
  k.desde = d.dreLeis && d.dreLeis.points[0] ? d.dreLeis.points[0].t.slice(0, 4) : null;
  k.entrada = d.funil ? d.funil.links.filter((l) => l.s === "entrada").reduce((a, l) => a + l.v, 0) : null;
  k.fg = link(d, "gok", "fg"); k.prom = link(d, "fg", "prom"); k.veto = link(d, "fg", "veto"); k.aguarda = link(d, "fg", "aguarda");
  const v = (d.vetos && d.vetos.items) || [];
  k.vetos = (v[0] || {}).value; k.vReform = (v[1] || {}).value; k.vConf = (v[2] || {}).value; k.vCad = (v[3] || {}).value;
  const tc = last((d.tcAno || {}).rows, 14);
  d.tcRows = tc; k.tcFirst = tc[0] && tc[0].label; k.tcLast = tc.length ? tc[tc.length - 1].label : null; k.tcLastN = tc.length ? tc[tc.length - 1].value : null;
  const pr = (d.justicaProcessos || {}).rows || [];
  k.pFirst = pr[0] && pr[0].label; k.pFirstN = pr[0] && pr[0].value; k.pLast = pr.length ? pr[pr.length - 1].label : null; k.pLastN = pr.length ? pr[pr.length - 1].value : null;
  const mn = pr.reduce((m, x) => (!m || x.value < m.value ? x : m), null);
  k.pMinY = mn && mn.label; k.pMin = mn && mn.value;
  const pv = last((d.provedor || {}).rows, 14);
  d.provRows = pv; k.pvFirst = pv[0] && pv[0].label; k.pvFirstN = pv[0] && pv[0].value; k.pvLast = pv.length ? pv[pv.length - 1].label : null; k.pvLastN = pv.length ? pv[pv.length - 1].value : null;
  const au = (d.auditorias && d.auditorias.rows) || [];
  k.audN = au.length; k.audFirst = au[0] && au[0].tag;
  d.asof = d.funil && d.funil.asof;
  return d;
}

const ds = (k) => (d) => (d[k] || {}).asof;
const scenes = [
  { id: "funil", label: "Da proposta à lei", kicker: "Como nasce uma lei",
    morph: { type: "sankey", items: (d) => ({ nodes: d.funil.nodes, links: d.funil.links }) },
    headline: (d) => `Dos *${Story.fmt.int(d.k.entrada)} textos* entrados, ${Story.fmt.int(d.k.prom)} foram promulgados`,
    copy: "Uma lei começa num projeto ou proposta de lei, é votada na generalidade, passa à especialidade e termina na votação final global. Depois, o Presidente promulga ou veta.\n\nNa XVII Legislatura, {{k.fg|int}} textos chegaram à votação final global: {{k.prom|int}} foram promulgados, {{k.veto|int}} vetados e {{k.aguarda|int}} aguardam decisão.",
    source: { label: "Iniciativas e fases do processo legislativo", href: "#/leis", asof: ds("funil") },
    when: (d) => d.funil && d.funil.links && d.funil.links.length > 0 && d.k.entrada != null },
  { id: "dre", label: "Publicadas", kicker: "Diário da República",
    morph: { type: "timeline", items: (d) => ({ points: tl(d.dreLeis.points), events: tl(d.dreLeis.events) }) },
    headline: (d) => `*${Story.fmt.int(d.k.leis)} leis* publicadas desde ${d.k.desde}`,
    copy: "Só entra em vigor o que é publicado. Desde {{k.desde|str}}, o Diário da República regista {{k.leis|int}} leis, {{k.dl|int}} decretos-lei, {{k.rcm|int}} resoluções do Conselho de Ministros e {{k.port|int}} portarias.\n\nO gráfico mostra as leis por mês.",
    source: { label: "Diário da República", href: "#/dre", asof: ds("dreLeis") },
    when: (d) => d.dreLeis && d.dreLeis.points && d.dreLeis.points.length > 1 },
  { id: "vetos", label: "Vetos", kicker: "Quem trava",
    morph: { type: "counter", items: (d) => ({ value: d.k.vetos, label: d.vetos.items[0].label, unit: "vetos" }) },
    headline: (d) => `*${d.k.vetos} vetos* do Presidente desde 2022`,
    copy: "O Presidente pode devolver um diploma sem o promulgar. Dos {{k.vetos|int}} vetos, {{k.vReform|int}} levaram a reformulação, {{k.vConf|int}} foram confirmados pelo Parlamento e {{k.vCad|int}} caducaram.",
    source: { label: "Atos do Presidente", href: "#/atos-presidente", asof: ds("vetos") },
    when: (d) => d.vetos && d.k.vetos != null },
  { id: "tc", label: "Tribunal Constitucional", kicker: "Quem contesta",
    morph: { type: "bars", items: (d) => ({ rows: d.tcRows, unit: d.tcAno.unit }) },
    headline: (d) => `Acórdãos do Tribunal Constitucional: *${Story.fmt.int(d.k.tcLastN)}* em ${d.k.tcLast}`,
    copy: "O Tribunal Constitucional aprecia se as leis respeitam a Constituição. O gráfico mostra os acórdãos por ano, de {{k.tcFirst|str}} a {{k.tcLast|str}}.\n\nO valor de {{k.tcLast|str}} cobre apenas o ano em curso até à data dos dados.",
    source: { label: "Justiça", href: "#/justica", asof: ds("tcAno") },
    when: (d) => d.tcRows && d.tcRows.length > 0 },
  { id: "processos", label: "Tribunais", kicker: "A justiça no dia a dia",
    morph: { type: "bars", items: (d) => ({ rows: d.justicaProcessos.rows, unit: d.justicaProcessos.unit }) },
    headline: (d) => `Processos pendentes: de ${Story.fmt.int(d.k.pFirstN)} para *${Story.fmt.int(d.k.pLastN)}*`,
    copy: "Processos pendentes nos tribunais judiciais, de {{k.pFirst|str}} a {{k.pLast|str}}. O mínimo da série foi em {{k.pMinY|str}}, com {{k.pMin|int}}.",
    source: { label: "Justiça", href: "#/justica", asof: ds("justicaProcessos") },
    when: (d) => d.justicaProcessos && d.justicaProcessos.rows && d.justicaProcessos.rows.length > 0 },
  { id: "provedor", label: "Provedor de Justiça", kicker: "Quem recebe queixas",
    morph: { type: "bars", items: (d) => ({ rows: d.provRows, unit: d.provedor.unit }) },
    headline: (d) => `Queixas ao Provedor: *${Story.fmt.int(d.k.pvLastN)}* em ${d.k.pvLast}`,
    copy: "Os cidadãos podem queixar-se ao Provedor de Justiça da administração pública. O gráfico mostra os processos abertos por ano, de {{k.pvFirst|str}} a {{k.pvLast|str}}, o último ano com dados nos relatórios anuais.",
    source: { label: "Provedor de Justiça", href: "#/provedor", asof: ds("provedor") },
    when: (d) => d.provRows && d.provRows.length > 0 },
  { id: "auditorias", label: "Fiscalização", kicker: "Contas e controlo",
    morph: { type: "list", items: (d) => ({ rows: d.auditorias.rows }) },
    headline: () => "Os *relatórios* mais recentes de fiscalização",
    copy: "Relatórios mais recentes do Tribunal de Contas e da Inspeção-Geral de Finanças, por ordem de data. O mais recente é de {{k.audFirst|date}}.",
    source: { label: "Tribunal de Contas e IGF", href: "#/justica", asof: ds("auditorias") },
    when: (d) => d.auditorias && d.auditorias.rows && d.auditorias.rows.length > 0 },
];

Story.register("leis-justica", {
  title: "Como uma decisão se torna *lei*",
  question: "Como uma decisão se torna lei, e quem a contesta?",
  load: () => fetch("/api/historias/leis-justica").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(prep),
  scenes,
  directory: [
    { label: "Diário da República", href: "#/dre", desc: "Tudo o que é publicado." },
    { label: "Justiça", href: "#/justica", desc: "Tribunais, Tribunal Constitucional e auditorias." },
    { label: "Leis em curso", href: "#/leis", desc: "O percurso de cada iniciativa." },
    { label: "Atos do Presidente", href: "#/atos-presidente", desc: "Promulgações e vetos." },
  ],
  fallback: [{ label: "Diário da República", href: "#/dre" }, { label: "Justiça", href: "#/justica" }],
});
})();
