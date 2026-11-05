# Story payloads: `/api/historias/<slug>`

Module `server/modules/historias.mjs`. Read-only; reuses the in-process routes of the other modules (`routes[...]`) and opens the same SQLite files read-only. Cached in memory 10 min (stale-while-revalidate, invalidated on restart), pre-warmed 4 s after start. Warm response under 5 ms. Real captured payloads: `the synthetic sample data (tools/make_sample.py)`.

Slugs: `parlamento`, `governo`, `dinheiro`, `poder-local`, `instituicoes`, `leis-justica`, `indicadores`. `GET /api/historias` lists them with the guiding question.

## Envelope

```
{ slug, question, built (ISO), datasets: { <name>: <dataset> }, skipped: [names], errors?: {name: msg}, fontes: [{label, href}] }
```

A dataset whose source is missing or throws is left out of `datasets` and named in `skipped` (never invented). Currently nothing is skipped.

Every dataset carries `type` and `asof` (date of the underlying data, `YYYY-MM-DD`, or period such as `2026Q2`, `2018/19`, `2027`). Optional `unit`, `label`, `href`, `note`. Shapes:

| type | fields |
|---|---|
| counter | `value, label, unit, delta (null if unknown), asof, href?` |
| counters | `items: [counter]` (a group; also `presidente?`) |
| bars | `rows: [{label, value, color, href}]` |
| hemicycle | `seats: [{party, color, vote, n}]` plus `title, result, fase, href, legislatura, seatsBySense, senseColors` |
| sankey | `nodes: [{id, label}], links: [{s, t, v}]` |
| scatter | `points: [{x, y, label, color, href}], xLabel, yLabel, median: {x, y}` |
| timeline | `points: [{t, v}], events: [{t, label, href}]` (`t` is `YYYY-MM`, `YYYY-MM-DD`, year or school year) |
| network | `nodes: [{id, label, size, group, href}], links: [{s, t, v}]` |
| tiles | `tiles: [{label, value, href, group}]` |
| list | `rows: [{title, sub, tag, href}]` |

`vote` in hemicycle: `favor|contra|abstencao|ausencia|dividido|null` (null = group did not vote / not recorded). Hrefs are hash routes of existing pages (`#/votacoes`, `#/igf`, `#/entidade/<id>`, `#/ministerios/<slug>`, `#/posicoes/<partido>`).

Sizes below are measured on the live data (bytes of JSON). Totals: parlamento 7.4 KB, governo 26.9 KB, dinheiro 52.9 KB, poder-local 38.0 KB, instituicoes 23.5 KB, leis-justica 11.1 KB, indicadores 16.8 KB. Cold build 0.001-2.5 s (parlamento is the slowest: it triggers the first cold queries on votacoes.db).

## parlamento (7.4 KB)

Question: Quem decidiu esta semana, e cada partido votou como falou?

| dataset | type | size | source |
|---|---|---|---|
| `votos` | counters (5: plenary votes, votes last 28 days with delta vs previous 28, initiatives, individual divergent votes, initiatives linked to DRE) | 0.7 KB | `/api/votacoes/stats`, `votacoes.db` `votos` |
| `hemiciclo` | hemicycle: latest plenary "Votação final global" with at least 5 group votes; seats from `votacoes.db` `meta` key `seats_<leg>` (XVII), vote per group from `voto_partido` (kind `gp`/`dividido`) | 1.0 KB | `votacoes.db` |
| `votosSemana` | list: final-global votes in the 7 days up to the last vote (title, `tipo numero · data`, result, `#/votacoes/<key>`) | 1.2 KB | `votacoes.db` |
| `funil` | sankey bill to law (XVII, Projeto/Proposta de Lei): entrada, sem votação, rejeitados, aprovados na generalidade, especialidade, votação final global, aguardam promulgação, promulgados, vetados, publicados em DR; counts per distinct initiative from `fases` (`Votação na generalidade`, `Votação final global`, `Promulgação%`, `Veto (Rece%`, `Lei (Publicação DR)`) | 0.8 KB | `votacoes.db` `iniciativas`, `fases` |
| `posicoes` | scatter per party: x declared-and-comparable statements, y % where the vote matched (`coincidem`), median over parties; `total` = {declaracoes, comparaveis, coincidem, divergem} | 0.8 KB | `/api/posicoes/declaracoes`, `/api/posicoes/stats` |
| `intervencoes` | bars: speeches by party (deputy speeches) | 0.8 KB | `/api/posicoes/matriz` totals; asof from `/api/intervencoes/stats` |
| `alteracoesBancada` | bars: deputy substitutions by party | 0.5 KB | `/api/deputados/changes` |
| `agenda` | list: next 8 parliament events | 0.8 KB | `politica.db` `events` (start >= today) |

## governo (26.9 KB)

Question: Quem governa, quem nomeia, o que decidiu?

| dataset | type | size | source |
|---|---|---|---|
| `rede` | network: node `gov` (group `governo`) -> 16 ministries (group `ministerio`, size = contracted EUR) -> secretaries of state (group `secretario`, size 1, link v 1) and top 3 bodies by spend per ministry (group `entidade`, link v = EUR); `unitLinks` explains v | 22.0 KB | `ministerios.db` `ministries`, `people`, `spend_body`, `bodies` |
| `nomeacoes` | timeline: DRE appointments/designations/dismissals per month | 0.8 KB | `responsaveis.db` `nomeacoes` |
| `decretosLei` | timeline: Decretos-Lei per month since 2024-01, event = ministers in office since | 1.0 KB | `dre.db` `acts` (kind `Decreto-Lei`); `ministerios.db` |
| `empregoPublico` | bars: public workers by subsector; `total`, `delta` vs previous year | 0.5 KB | `/api/estado/overview` `workforce.subsector` |
| `empregoContrato` | bars: public workers by contract type | 0.4 KB | `/api/estado/overview` `workforce.contract` |
| `empregoSerie` | timeline: public workers per reference date | 1.0 KB | `/api/estado/emprego` |
| `promulgacoesVetos` | counters: promulgations, vetoes, TC requests of the current President (`presidente`) | 0.5 KB | `/api/presidencia/overview` |

## dinheiro (52.9 KB)

Question: Quem decidiu gastar, em quê, e quem fiscalizou?

| dataset | type | size | source |
|---|---|---|---|
| `orcamento` | sankey (M€): 7 largest tax lines -> `oe` -> top 12 ministries (->programs for ministries with more than one); aggregates (Impostos Diretos/Indiretos, Receita Fiscal) and "Outros" excluded to avoid double counting; revenue and expenditure do not balance (see `note`) | 3.0 KB | `/api/orcamento/oe` |
| `contratosMes` | timeline: contracted value per month, M€, last 36 months; `count` = parallel `[{t, v}]` of contract counts | 2.0 KB | `politica.db` `contracts` (signed <= today) |
| `rede` | network capped at 200 nodes: 16 ministries (group `ministerio`) linked to top 90 buyers (`entidade`) and top 110 suppliers (`fornecedor`) by contracted EUR | 35.9 KB | `ministerios.db` `spend_body`, `spend_sup`, `bodies` |
| `risco` | bars: top 12 entities by risk score (0-10; indicators, not accusations) | 1.4 KB | `/api/risco/entities`, `/api/risco/overview` |
| `fundosConcelho` | scatter, 110 largest municipalities: x population, y EU funds approved per inhabitant (EUR), colour = governing party group, median over all 307 | 9.7 KB | `fundos.db` `conc_totals` x `autarquias.db` `metrics` |
| `divida` | counter: direct State debt in M€, delta = year-on-year; `prazoMedioAnos`, `pctTaxaFixa` | 0.2 KB | `/api/divida/overview` |

Not provided: apoios per municipality (`apoios.db` has region only, no concelho); only `fundos` is municipality-level.

## poder-local (38.0 KB)

Question: Quem governa o seu concelho e o que dizem as auditorias?

| dataset | type | size | source |
|---|---|---|---|
| `mapa` | tiles: 308 municipalities, value = population, group = party group (`PS, PSD, PSD+, CDU, CDS-PP, CH, JPP, IL, L, BE, PAN, Independentes`; `PSD+` = coalitions including PSD), `colors` map in the payload | 24.6 KB | `/api/autarquias/list` (`autarquias.db` `metrics`) |
| `partidos` | bars: municipalities per party group | 0.7 KB | same |
| `indicadores` | scatter, 100 largest: x debt per inhabitant, y expenditure per inhabitant, median over all 308 | 8.6 KB | same |
| `igfAno` | bars: IGF reports per year | 1.1 KB | `/api/igf/overview` |
| `igfMunicipio` | bars: municipalities with most IGF reports | 1.0 KB | `igf.db` `reports` |
| `empresasLocais` | bars: local companies by sector | 0.9 KB | `/api/empresas_locais/overview` |
| `regioes` | bars: contracted M€ in Açores and Madeira; `detalhe` has government, since, seats, contracts | 0.5 KB | `/api/regioes/overview?regiao=` |

Extra endpoints:

- `/api/historias/poder-local?index=1` -> `{asof, fields: ["name","id","party"], rows: [[name, entityId, partyGroup]...]}` (9 KB, 308 rows) for search; link `#/entidade/<id>`.
- `/api/historias/poder-local?concelho=<name or dico>` (accent/case-insensitive, prefix allowed) -> `{found, asof, municipio{name,dico,district,population,populationYear,mayor,party,partyGroup,changed2025,winnerPct,majority,turnout2025,href}, financas{year,expensePc,debtPc,personnelPct,investPct,ownRevenuePct,pmpDays,rankExpensePc,rankDebtPc,nRanked,medianExpensePc,medianDebtPc}, igf{n,reports[{title,year,href}],href}, fundos{n,aprovado,pago,aprovadoPc,href}|null, contratos{n,value,directShare,singleBidderShare,href}|null, empresasLocais|null, indicadores[{key,label,unit,value,median,pt,year}]}` (about 3 KB). `found:false` if unknown. IGF reports match by NIF or by "Município d_ <name>" in the title.

## instituicoes (23.5 KB)

Question: Quem regula, quem serve, com que resultados?

| dataset | type | size | source |
|---|---|---|---|
| `rede` | network: `estado` -> 12 entity kinds (group `tipo`, size = count) -> top 8 per kind by contracted EUR (group = kind) | 19.2 KB | `politica.db` `entities` (is_public = 1) |
| `reguladoresDecisoes` | bars: published decisions per regulator | 0.4 KB | `/api/reguladores/lista` |
| `reguladoresCoimas` | bars: fines/sanctions per regulator | 0.2 KB | same |
| `saudeConsultas` | timeline: hospital outpatient consultations (INE 0007424, "Total de consultas") 2010-2022 | 0.5 KB | `/api/saude/series?indicator=0007424` |
| `segurancaCrimes` | bars: registered crimes by category, latest year | 1.1 KB | `/api/seguranca/series?indicador=crime` |
| `educacaoDistritos` | tiles: students per district (2018/19) | 1.5 KB | `/api/educacao/overview` `districts` |

## leis-justica (11.1 KB)

Question: Como uma decisão se torna lei, e quem a contesta?

| dataset | type | size | source |
|---|---|---|---|
| `dreLeis`, `dreDecretosLei`, `drePortarias`, `dreResolucoes` | timeline each: DRE acts per month by type since 2024-01 (Lei, Decreto-Lei, Portaria, Resolução do Conselho de Ministros) | 0.7-0.9 KB each | `dre.db` `acts` |
| `funil` | sankey: same as parlamento `funil` | 0.8 KB | `votacoes.db` |
| `vetos` | counters: total vetoes and outcomes (reformulado, confirmado, caducou) | 0.5 KB | `/api/presidencia/vetos` |
| `tcAno` | bars: Constitutional Court decisions, last 20 years | 1.4 KB | `/api/justica/overview` `tcByYear` |
| `justicaProcessos` | bars: pending cases in judicial courts, last 12 periods | 0.9 KB | `/api/justica/overview` `series.pendentes` |
| `provedor` | bars: complaints opened per year (Provedor de Justiça annual reports, last 14 with data) | 1.0 KB | `/api/provedor/overview` `series` |
| `auditorias` | list: 8 latest Tribunal de Contas reports + 6 latest IGF reports, newest first | 2.3 KB | `/api/justica/auditorias`, `/api/igf/relatorios` |

## indicadores (16.8 KB)

Question: Como está o país que estas decisões mudam?

| dataset | type | size | source |
|---|---|---|---|
| `ine` | counter: INE indicators loaded (16); `municipios` = 308 | 0.2 KB | `/api/ine_series/overview` |
| `ranking` | scatter, 110 largest municipalities: x purchasing power index (PT = 100), y ageing index, median = national median of the municipalities | 9.7 KB | `/api/ine_series/ranking` |
| `habitacao` | tiles: median sale price (EUR/m2, latest quarter) for the 58 municipalities with data, group = district | 4.7 KB | `/api/habitacao/ranking?limit=100` |
| `imigracao` | bars: foreign residents, top 15 municipalities | 1.3 KB | `/api/imigracao/municipios` |
| `dgeec` | timeline: children and students enrolled, all levels (DGEEC table 1.1, 2009/10-2019/20) | 0.5 KB | `/api/dgeec/indicator?id=1.1` |

Per-municipality panel: `/api/historias/indicadores?concelho=<name or dico>` -> `{found, asof, municipio{name,dico,district,population,href}, indicadores[{key,label,unit,value,median,pt,year}] (16, value for the municipality, national median of municipalities, INE national value), habitacao{venda,renda}: {indicator,unit,period,value,rank,of}|null, imigracao{total,per100,year}|null, educacao{students,schools,per1000,year}|null}` (about 2.7 KB).

## Notes for story writers

- `delta` is null unless a comparable earlier value exists in the data.
- `asof` is data date, not build time (`built` is build time).
- Counter groups use `type: "counters"`; each item is a plain counter.
- Party colours follow the portal palette; `PSD+` (PSD coalitions) uses a lighter orange.
- Cached per municipality (`?concelho=`) for 10 min under the same TTL.
