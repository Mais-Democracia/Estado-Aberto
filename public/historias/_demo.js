(function () {
"use strict";
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const NAMES = ["Alvito", "Barcelos", "Cascais", "Dão", "Évora", "Faro", "Guarda", "Horta", "Ílhavo", "Jarmela", "Lagos", "Mértola", "Nazaré", "Odemira", "Porto", "Quarteira", "Resende", "Sintra", "Tavira", "Viseu", "Aveiro", "Braga", "Coimbra", "Elvas", "Fundão", "Gouveia", "Loulé", "Moura", "Ourém", "Peniche"];

function makeData() {
  seed = 42;
  const parties = [["PS", 78, "#e0457b"], ["PSD", 89, "#f08a24"], ["CH", 40, "#202056"], ["IL", 9, "#00aeef"], ["BE", 5, "#b11226"], ["PCP", 3, "#d6001c"], ["L", 4, "#7bbf3a"], ["PAN", 1, "#2a8f8f"], ["CDS", 1, "#0066b3"]];
  const votes = ["favor", "contra", "abstencao", "contra", "favor", null, "favor", "abstencao", "favor"];
  const flows = { nodes: [{ id: "imp", label: "Impostos", color: "green" }, { id: "ss", label: "Contribuições", color: "blue" }, { id: "ue", label: "Fundos UE", color: "gold" }, { id: "est", label: "Estado", color: "ink" }, { id: "saude", label: "Saúde", color: "red" }, { id: "edu", label: "Educação", color: "blue" }, { id: "pens", label: "Pensões", color: "green" }, { id: "div", label: "Dívida", color: "na" }, { id: "inv", label: "Investimento", color: "gold" }], links: [{ s: "imp", t: "est", v: 52 }, { s: "ss", t: "est", v: 31 }, { s: "ue", t: "est", v: 9 }, { s: "est", t: "saude", v: 15 }, { s: "est", t: "edu", v: 11 }, { s: "est", t: "pens", v: 30 }, { s: "est", t: "div", v: 8 }, { s: "est", t: "inv", v: 6 }, { s: "est", t: "imp", v: 0 }] };
  const scatter = Array.from({ length: 90 }, (_, i) => { const pop = Math.exp(7 + rnd() * 6), x = pop; return { label: NAMES[i % NAMES.length] + (i >= NAMES.length ? " " + (1 + Math.floor(i / NAMES.length)) : ""), x, y: 800 + Math.log(pop) * 120 * (0.6 + rnd() * 0.8) + (rnd() - 0.5) * 300, href: "#/autarquias" }; });
  const tl = Array.from({ length: 84 }, (_, i) => ({ t: new Date(Date.UTC(2019, i, 1)).toISOString().slice(0, 10), v: 100 + i * 0.9 + Math.sin(i / 5) * 8 + (i > 14 && i < 30 ? -10 : 0) + (i > 50 ? 12 : 0) }));
  const groupsN = ["Norte", "Centro", "Sul", "Ilhas"];
  const nodes = Array.from({ length: 110 }, (_, i) => ({ id: "n" + i, label: "Entidade " + (i + 1), size: Math.pow(rnd(), 3) * 100 + 2, group: groupsN[i % 4], href: "#/entidades" }));
  nodes[0].label = "Ministério central"; nodes[0].size = 130;
  const nlinks = []; for (let i = 1; i < nodes.length; i++) { nlinks.push({ s: "n" + (i % 9 === 0 ? 0 : Math.floor(rnd() * i)), t: "n" + i, v: 1 + Math.floor(rnd() * 5) }); if (rnd() < 0.2) nlinks.push({ s: "n" + Math.floor(rnd() * nodes.length), t: "n" + i }); }
  const tiles = Array.from({ length: 150 }, (_, i) => ({ label: NAMES[i % NAMES.length] + (i >= NAMES.length ? " " + (1 + Math.floor(i / NAMES.length)) : ""), value: rnd() < 0.05 ? null : rnd() * 100, group: groupsN[i % 4], href: "#/autarquias" }));
  return {
    asof: "2026-10-01", total: { value: 98600000000, delta: 3.4, label: "Despesa pública anual" }, missing: null, partial: { n: 12, rate: 4.25 },
    bars: ["Saúde", "Educação", "Segurança social", "Defesa", "Justiça", "Cultura", "Ambiente", "Agricultura"].map((l, i) => ({ label: l, value: 1e9 * (12 - i * 1.3 + rnd()), href: "#/orcamento" })),
    seats: parties.map(([p, n, c], i) => ({ party: p, n, color: c, vote: votes[i] })),
    flows, scatter, tl, events: [{ t: "2020-03-18", label: "Estado de emergência" }, { t: "2022-02-01", label: "Novas eleições" }, { t: "2024-03-10", label: "Eleições legislativas", href: "#/eleicoes" }],
    nodes, nlinks, tiles,
    list: [["Lei da habitação", "Aprovada em votação final global", "Lei", "#/leis"], ["Orçamento retificativo", "Em discussão na especialidade", "Orçamento", "#/orcamento"], ["Reforma da justiça", "Proposta do Governo entregue ao Parlamento", "Justiça", "#/justica"], ["Estatuto do SNS", "Publicada em Diário da República", "Saúde", "#/saude"], ["Lei das autarquias", "Debate em plenário", "Poder local", "#/autarquias"]].map(([title, sub, tag, href]) => ({ title, sub, tag, href })),
  };
}

const scenes = [
  { id: "contador", label: "Contador", kicker: "Um número", morph: { type: "counter", items: (d) => ({ value: d.total.value / 1e9, label: d.total.label, unit: "mil milhões de euros", delta: d.total.delta }) },
    headline: (d) => "O Estado gasta *quase cem mil milhões* por ano", copy: "A despesa pública atingiu {{total.value|eur}}. Subiu {{total.delta|pct}} face ao ano anterior. Esta frase usa um campo em falta {{missing|int}} e deve desaparecer. Dados de {{asof|date}}.",
    source: { label: "Dados fictícios de demonstração", href: "#/historia/demo", asof: (d) => d.asof } },
  { id: "barras", label: "Barras", kicker: "Quem recebe", morph: { type: "bars", items: (d) => ({ rows: d.bars, unit: "€" }) }, headline: () => "Saúde e educação lideram a despesa", copy: "Oito rubricas cobrem a maior parte do orçamento. Passe o rato sobre uma barra para ver o valor exacto, ou clique para abrir a página.", source: { label: "Orçamento do Estado (demo)", href: "#/orcamento", asof: (d) => d.asof } },
  { id: "hemiciclo", label: "Hemiciclo", kicker: "Parlamento", morph: { type: "hemicycle", items: (d) => ({ title: "Assembleia da República", seats: d.seats.map((s) => ({ party: s.party, n: s.n, color: s.color })) }) }, headline: () => "230 lugares, nove forças políticas", copy: "Cada ponto de cor é um deputado. Os grupos parlamentares ocupam fatias do hemiciclo da esquerda para a direita.", source: { label: "Assembleia da República (demo)", href: "#/partidos", asof: (d) => d.asof } },
  { id: "votacao", label: "Votação", kicker: "Parlamento", morph: { type: "hemicycle", items: (d) => ({ title: "Lei da habitação", seats: d.seats }) }, headline: () => "Como votou cada bancada", copy: "Verde a favor, vermelho contra, dourado abstenção, cinzento sem voto registado.", source: { label: "Votações (demo)", href: "#/votacoes", asof: (d) => d.asof } },
  { id: "fluxos", label: "Fluxos", kicker: "Dinheiro público", morph: { type: "sankey", items: (d) => d.flows }, headline: () => "De onde vem e para onde vai", copy: "As ribas largas mostram os maiores fluxos entre receitas e despesas.", source: { label: "Ministério das Finanças (demo)", href: "#/orcamento", asof: (d) => d.asof } },
  { id: "dispersao", label: "Dispersão", kicker: "Poder local", morph: { type: "scatter", items: (d) => ({ points: d.scatter, xLabel: "População", yLabel: "Despesa por habitante (€)", median: { x: 20000, y: 1500 } }) }, headline: () => "Concelhos grandes gastam mais por pessoa?", copy: "Cada ponto é um município. A linha a tracejado é a mediana nacional.", source: { label: "INE (demo)", href: "#/autarquias", asof: (d) => d.asof } },
  { id: "tempo", label: "Tempo", kicker: "Indicadores", morph: { type: "timeline", items: (d) => ({ points: d.tl, events: d.events }) }, headline: () => "Sete anos numa linha", copy: "O índice sobe devagar, com um recuo claro em 2020 e uma recuperação depois das eleições.", source: { label: "Indicadores (demo)", href: "#/divida", asof: (d) => d.asof } },
  { id: "rede", label: "Rede", kicker: "Instituições", morph: { type: "network", items: (d) => ({ nodes: d.nodes, links: d.nlinks }) }, headline: () => "Uma rede de entidades públicas", copy: "{{partial.n|int}} entidades concentram a maior parte das ligações, cerca de {{partial.rate|dec1}} por cento do total.", source: { label: "Diretório de entidades (demo)", href: "#/entidades", asof: (d) => d.asof } },
  { id: "mosaico", label: "Mosaico", kicker: "Poder local", morph: { type: "tiles", items: (d) => ({ tiles: d.tiles }) }, headline: () => "Um mosaico de municípios", copy: "A cor de cada azulejo traduz o valor do indicador; os cinzentos não têm dados.", source: { label: "Autarquias (demo)", href: "#/autarquias", asof: (d) => d.asof } },
  { id: "lista", label: "Lista", kicker: "Leis e justiça", morph: { type: "list", items: (d) => ({ rows: d.list }) }, headline: () => "O que está em cima da mesa", copy: "Cinco diplomas em curso. Clique numa linha para abrir a página.", source: { label: "Diário da República (demo)", href: "#/dre", asof: (d) => d.asof } },
  { id: "oculta", label: "Oculta", kicker: "Nunca visível", morph: { type: "counter", items: () => ({ value: 1 }) }, when: (d) => d.nonexistent === true, headline: () => "Esta cena deve ser ignorada", copy: "Não deve aparecer." },
];

const directory = [{ label: "Parlamento", href: "#/parlamento", desc: "Deputados, partidos e votações." }, { label: "Governo", href: "#/governo", desc: "Ministérios e decisões do Executivo." }, { label: "Dinheiro público", href: "#/contratos", desc: "Contratos, apoios e orçamento." }, { label: "Poder local", href: "#/autarquias", desc: "Municípios e freguesias." }, { label: "Instituições", href: "#/entidades", desc: "Diretório de entidades públicas." }, { label: "Leis e justiça", href: "#/dre", desc: "Diário da República e tribunais." }];

Story.register("demo", { title: "Demonstração do *motor* de histórias", question: "Como se vêem nove formas de contar o mesmo dado, num só ecrã?", load: () => (/[?&]fail=1/.test(location.hash) ? Promise.reject(new Error("falha simulada")) : Promise.resolve(makeData())), scenes, directory });
})();
