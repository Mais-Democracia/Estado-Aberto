# Backlog

> **Rule:** whenever work starts, ships or is re-prioritised, update `docs/ROADMAP.md` (Portuguese, public page at `#/roadmap`: Em curso / A seguir / Feito) in the same commit as the change.
 (the review loop picks the top open item, ships it, commits, then re-ranks)

Legend: [ ] open · [~] agent working · [x] done

## Data coverage (what is still missing)
- [x] Diário da República: origin -> amendments (article counts) -> consolidated link; 5,208 acts since 2024, 768 consolidated laws (agent: dre) — gaps: DRR (regional decrees) missing from detail fetch, only 3 links to parliament initiatives, no votes, full 'alterado por' lists need an account; next: daily incremental run, citations by number in text, lineage on ministry/entity pages, shrink 459 MB db
- [x] Local government: mayors, 2017-2025 election results, DGAL execution & debt, comparison page (agent: autarquias) — gaps: councillor names/pelouros, budget vs execution (2015-19 files), CIM/AM, empresas municipais
- [x] Education: 1,931 units, 5,088 establishments, 515k teacher-list rows, Parque Escolar/Construção Pública (agent: educacao) — next: raise NIF match for higher-ed (4/274), school->agrupamento hierarchy
- [x] Parliament: 230 deputies, committees, 19,953 attendance rows, 31k initiatives (agent: deputados) — next: group-level votes per initiative, link relator->deputy, hook into #/partidos; AR open-data JSON still unreachable
- [x] Ministries: 16 ministries, leadership, 1,554 tutelled bodies (rule-based), CM decisions, spend (agent: ministerios) — next: parse orgânica decree-laws via DRE for official tutelage
- [ ] Freguesias <-> NIF: ~1,350 parishes ambiguous by name (need municipality context; try DGAL/INE codes)
- [~] Population: municipalities done (Censos 2021); parishes done in d3bee84 (2,960 of 3,092 from INE Censos 2021); 132 parishes still unmatched (no reliable name/code match)
- [ ] Reclassify the ~5,400 'outra_entidade' contracting authorities (misc public bodies)
- [x] Contract modifications (88,740 mods, 100% matched; contract page + buyer indicator) — shipped by loop
- [x] Contract announcements (agent: anuncios): 266k notices 2012-2026, 95% of contracts link to a notice, 2,241 competitive contracts without any notice (0.8%), proposal-deadline distribution, price vs base price (median 7.5% below) — NEXT: verify CCP minimum deadlines then flag, link amendment/extension notices, lots vs contracts, CPV peer baseline, monthly refresh
- [ ] Detect contract 'splitting' (many direct awards to one supplier just under thresholds)
- [ ] Companies behind suppliers: owners/administrators (Registo Comercial / Publicações; check public sources), link to political office holders (conflict-of-interest screens)
- [x] Who is responsible (agent: responsaveis): 17,136 mandates / 12,503 people (ET), 1,110 cabinet nominations, 268 CReSAP procedures; declared interests only 1% read (10 company links) — NEXT: re-run `python3 ingest/run_all.py responsaveis` until holders_checked = 12,503 (weekly cron), extract CReSAP designated names from PDFs, DRE série II despachos (blocked), 'possible' name matches
- [x] Public workforce (DGAEP, 768k in 2026 Q2, series from 2011) + 197 state companies (ETF, 131 linked to NIF) (agent: estado_empresas) — gaps: per-company financials are PDF aggregates only, municipal companies list, per-entity headcount (no SIOE API); next: parse ETF boletim appendices, link administrators from responsaveis, alias file for unmatched
- [x] Budget history (agent: orcamento, 64f7442): pure-Python BIFF8 .xls reader, execution back to 2009 (168 editions), CGE by ministry/programme 2014-2025, 868 internal cross-checks (max gap 0.11%), long-run chart; VERIFIED vs known history (AP balance %GDP 2009 -9.9, 2014 -7.4, 2019 +0.1, 2020 -5.8, debt 134.1% 2020). Caveat: 2009-2012 totals are computed (current+capital); CGE by agency (Mapa VII) empty in sources; utao.pt down. Earlier: SEO monthly execution 2021-2026, OE2023-2027 proposals, Eurostat COFOG (agent: orcamento) — next: older Excel (to 2010), corrected budget, Conta Geral do Estado by entity, IGCP debt, UTAO (unreachable)
- [x] PRR + EU funds: 672k beneficiary rows, EUR 70bn approved, 83% value linked by NIF (agent: fundos) — next: EU FTS, IFAP/FEAGA, grant<->contract cross-view
- [x] QA auditor report triaged (see 'From QA_REPORT.md'); re-run QA agent after each wave of modules
- [x] Justice: court statistics, Ministério Público, TC decisions (agent: justica; DGPJ open data blocked, see SOURCES)
- [x] Tribunal de Contas: standalone tcontas module removed (duplicate of justica); all of it now lives in justica (`tcontas_docs`, 4,143 documents 1999-2026, 982 linked to entities, outcome of 1,288 visto acórdãos, #/justica/contas + entity-profile panel). Gaps: 2.ª Secção and Plenário Geral lists are empty on the site (listed in justica's blocked list); acórdãos have no decision date in the listing, so the publication date is shown; no PDF text/findings/recommendations; links are by name only (nome no título is fuzzy).
- [x] Health (agent: saude): 70 institutions, 39 ULS composition, 19 INE series, procurement per institution (EUR 36.6bn) — BLOCKED (needs owner decision): SNS Portal da Transparência per-institution data (waiting lists, LIC, urgências, GP coverage) is hosted only on an Opendatasoft site whose robots.txt disallows API/downloads; module respects it. Options: ask SPMS/DE-SNS for a bulk file or written permission; or the owner accepts the risk of fetching the files
- [x] Security & civil protection (agent: seguranca): 402k INE rows for all 308 concelhos (crime 2011-25, fires/area burned 2001-25, road accidents 2014-24, fire brigades 1998-24), 26 bodies linked by NIF, defence procurement EUR 3.96bn; VERIFIED vs known figures (2017 burned area 541,491 ha; 2020 crime dip). Gaps: RASI PDF-only, prociv.pt/ANSR/ICNF unreachable, brigade list unofficial (40% without concelho), INEM/Polícia Marítima not matched to entities
- [x] Regional governments (agent: regioes): Açores 11 members (single source: Wikipedia, portal blocked), Madeira 9 reconciled; ALRAA 57 + ALRAM 47 deputies; 7 regional elections (Wikipedia, not checked vs CNE); Madeira budget 2025-26 (OCR); procurement per region — gaps: Açores budget/execution/debt, Madeira execution/debt, official gazettes unreachable; www.alra.pt TLS now verified via AIA intermediate; base.alra.pt (ALRAA deputies/initiatives) is plain HTTP only = unauthenticated, disclosed on page; spot-check: 10/10 deputy names match Wikipedia, only 5/10 initiatives matched DRE decrees by title (unconfirmed) — NEXT: confirm ALRAA initiatives against DRE/gazette, check party/circle not just names
- [ ] Public companies (SEE) financials (DGTF)
- [x] Elections (agent: eleicoes): 50 elections, 74,555 result rows, MAI 2005+ by concelho/district (308/308 municipalities joined), earlier national totals from Wikipedia (validated by sums); family comparison bug FIXED and verified (AD 31.79% vs 28.84%, 91 vs 80 seats; PS 58 vs 78) — NEXT: freguesia-level (3k files/election), pre-2005 territory from CNE PDFs, older regional elections, choropleth map
- [ ] Lobbying/audiences: AR agenda has "Audiências do Grupo Parlamentar" with named organisations -> build a lobbying register
- [~] Party-level votes + full law lifecycle via parlamento.pt initiative pages (agent: votacoes, opus): deputy pages now show 'Relator(a) de N iniciativas' (core wiring); LIVE and COMPLETE for XVII: 950/950 initiatives, 7,517 phases, 1,364 votes (1,027 plenary), 151 laws linked to their DRE act, rapporteurs linked to deputies; verified end-to-end on PL 37/XVII (OE2026 -> Lei 73-A/2025). DONE 78d89b7: party vote bars + law lifecycle on the portal. NEXT (earlier legislatures before XV still open): group repeated 'Baixa comissão' phases in the timeline, individual votes only when a deputy votes against own group (77 so far)
- [ ] Petitions, parliamentary questions & requerimentos (AR data, when reachable)

- [~] Extend ingest/aliases.py (apoios alias match done, +28 beneficiaries) with more verified renamings/mergers (SEF->AIMA done, Parque Escolar->Construção Pública done; DGAE/DGEstE->AGSE, others)
- [x] HTML entities in source names decoded (450k rows) and decoded at ingest

## From QA_REPORT.md (triaged 2026-10-29)
- [x] Municipalities exactly 308 (dupes merged, island homonyms overridden); entity totals reconcile with contracts (158.49 bn)
- [x] Negative prices excluded from spend; multi-seller price split; mojibake/whitespace names repaired; partial-year chart label; mobile overflow CSS
- [ ] Parishes: 4,625 rows vs ~3,049 real (WD-only and BASE-only rows never merge; needs INE/DICO codes + municipality context)
- [x] Population: all 308 municipalities from INE Censos 2021 (sum 10,343,066 = official census total) in core + autarquias; parishes still Wikidata
- [x] 'outra_entidade' 6,221 -> 1,295: new kinds terceiro_setor (3,235), diplomacia, sociedade_adjudicante, plus courts/regional/escola/freguesia via ingest/reclassify.py
- [ ] Remaining 1,295 'outra_entidade' (sample and extend classify.py); 'Junta de Freguesia' bodies (171) are now kind=freguesia alongside 'Freguesia de X' entities - dedupe parish identity vs its junta still OPEN
- [ ] 242k contracts with no seller NIF (10.6%): show as 'sem NIF' and consider foreign suppliers
- [ ] initiatives.origin/title junk (origin '1.ª'; titles like 'Deputado Relator'): tighten agenda.py parser
- [ ] Deputies: absence rule (PNO is not absent), coverage numbers consistent (sent to deputados agent)
- [ ] Education: link 1,931 units to entities by NIF (educacao agent's link step)
- [ ] contracts.signed NULL for 42k rows; published<signed for 698 rows; duplicate events
- [ ] Ministers: names differ in form between sources (Rita Júdice / Rita Alarcão Júdice) - normalise

- [ ] Budget page: decimal separator in KPIs ('0.7% / 89.2%' uses '.' vs pt comma); chart axis unit 'mM€' vs 'mil M€'
- [x] educacao page verified (counts, coverage notice, teacher API requires a filter by design)

## From QA_REPORT_2.md (triaged 2026-10-29)
- [x] autarquias population fixed: Censos 2021 (INE 0011609); admin-based 2023 estimates kept as reference only
- [x] responsaveis privacy fixes verified (no stake/relationship/amount fields in DB or API)
- [x] risco score histogram fixed and verified
- [x] 'por habitante' labels now say cumulative since 2012 (core)
- [x] Polish done directly: deputados (no % when meetings<10, birth year only, no internal path), ministerios grammar, wide tables scroll
- [ ] Remaining polish for module owners: ministerios (0-body ministry empty state, normalise supplier names), educacao (Parque Escolar 'concluída' null on 113/176; hide stale KPI wording), fundos (years to 2033 label as planned end; Lisboa concelho vs awards counts note; Lisboa population), dre (vigencia NULL on 1,754 acts), responsaveis (51 mandates with begin>end), autarquias (party-code legend)
- [ ] Teacher lists show names + graduação + situação: confirm with owner that name search of public placement lists is wanted; consider aggregated views by default

## Decisions needed from the owner
1. Teacher placement lists: keep name search (official public lists) or show aggregates only?
2. SNS transparency portal data blocked by robots.txt: request permission/bulk file from SPMS, or fetch anyway (policy call)?

- [x] QA #3 done (docs/QA_REPORT_3.md: 0 high, 6 medium, 23 low). Triage:
  - [x] votacoes QA-3 fixes committed (97c23b5): list collapse of same-day votes VERIFIED live (PL 241 one row, home feed); DRE links now only by explicit publication ref + act kind/number (PL 506 unlinked); 'dividido' chip + dedupe apply when the restarted crawl (PID 483427, several hours, covers XVII/XVI/XV all types) re-stores rows. RE-VERIFIED after crawl: 6,072 initiatives (XV 2,166, XVI 1,548, XVII 2,358), 7,628 votes, dre_linked 322, OE2026 -> Lei 73-A/2025, PL 506 unlinked, 'dividido' (PSD on PL 283) present. All DB journals now WAL
  - [x] regioes FIXED: regional elections read from official MAI results (eleicoes.db); % base = valid votes with voter share alongside; Wikipedia only for Açores 2016 (marked *). Note: the agent flagged Madeira 2024 date (2024-03-24) as wrong — it is CORRECT (snap election 24 Mar 2024; 26 May 2024 was the European election)
  - [x] saude FIXED and verified: 0 ULS with zero hospitals (Coimbra 5), KPI says 'pode estar incompleto' (83 hospitals identified); 15 ULS show exactly 1 hospital and may still be incomplete
  - [x] eleicoes: concelho totals note added (emigration circles excluded)
  - [x] eleicoes 2005 FIXED: reconcile_mandates() derives national seats from districts when they disagree (only mismatch across all 50 elections: PSD 74->75, now 230); recorded in the election note; runs on every ingest
  - [ ] 23 low items: see report (formatting, labels, small gaps)

- [x] Justice (agent: justica): 15 DGPJ/INE series 1990-2025, 665 courts + 16 higher bodies, 29,309 TC acórdãos 1983-2026 (outcome parsed for only 889; 129 'decisão mista'), 4,142 Tribunal de Contas docs (982 linked; 1,102 of 1,408 visto decisions were refusals), courts procurement EUR 522M, MoJ bodies EUR 1.9bn; 2014 spike now carries a cautious note. BLOCKED: DGPJ open-data API 404 / Power BI app (no per-court or per-comarca data, no official court map). NEXT: TC recurso outcomes from full text, TdC by NIF, geocode courts, ask DGPJ for data, TdC PDF amounts/recommendations
- [x] Parish elections (agent: eleicoes): leg-2024/2025 3,092 parishes, pres-2026 both rounds 2,956; 96.8-98% joined to parish entities; VERIFIED: parish votes sum exactly to concelho totals (AD 1,951,977 etc.), 'Como votou' renders on parish pages. Gaps: 136 parish unions (2026 MAI published pre-2013 parishes), 98 parishes without entity link, consulates not by parish

## From QA_REPORT_4.md (triaged; 3 high, 11 medium, 10 low)
- [x] votacoes QA-4 FIXED and verified live (e5e4803): seat-arithmetic flag on 5,280 checkable plenary votes -> 10 flagged (XVII 7, XVI 2, XV 1), visible warning '⚠ Aprovado (registado) ... confirmar na fonte' + status '(a confirmar)'; closed legislatures show 'Legislatura terminada' (regional/citizen initiatives carry over); DRE links 1,042/1,351 (XV only 111/420: local DRE db starts 2024); PR 617 cause unconfirmed (debates.parlamento.pt needs JS) — NEXT: confirm the 10 flagged votes against the DAR when reachable
- [x] anuncios QA-4 FIXED and verified live (3c0f952): 36,433 extension/amendment/rectification notices excluded (tenders 240,424 -> 225,427), deadlines split <=2017 / >=2018 with p10 per type+regime, DL 111-B/2017 cited as a HYPOTHESIS for the 2018 break (short-deadline share 0.8% in 2017 -> 15.5% in 2018, real in the data). NEXT: verify actual CCP minimum days per article, link the 1,057 extensions that have an original
- [x] seguranca FIXED and verified: gap note + per-year table (2025: 365,802 total vs 338,750 concelhos = 27,052 = 17,492 no region + 9,560 no concelho); INE does not explain the cause, note says so; concelho values are minimums
- [x] justica FIXED and verified: explicit table (courts 92 entities/EUR 93.2M; MJ bodies 15/EUR 1,871.7M; total EUR 1,965M) + memo of the whole kind (6,573 contracts, EUR 522.0M, matches independent query)
- [x] roadmap duplicate 'Concursos e anúncios' removed; TdC linking claim corrected (982/4,142); home KPI relabelled 'freguesias e juntas no registo' (registry count 4,796 includes parish councils and duplicate identities; real parishes ~3,092)
- [ ] remaining medium/low items: see docs/QA_REPORT_4.md

- [x] Municipal budget vs execution 2015-2019 (agent: autarquias, committed 939caf0): 77,616 budget rows, 308/308 municipalities; sums verified plausible (spending EUR 7.23bn 2015 -> 8.70bn 2019; revenue 8.12 -> 10.63bn); PMP (days to pay) 6,251 rows end-2019..2025; CIM/AM membership + state transfers (no own accounts published); comparison by governing party (n per party shown, descriptive only). TO CONFIRM with owner: executed/budgeted ratio is ~76.9% in 2015, 2016 and 2017 (nearly identical) — real or an artefact of the 'amended budget' series?

- [x] Municipal companies (agent: empresas_locais): 201 companies, owner heuristic for 127 (63%, labelled 'heur.'), 209 ET administrator mandates over 48 companies, EUR 249.6M of contracts from 82 municipalities to their own companies (EUR 244M 'Contratação excluída'); VERIFIED independently for Cascais (15.0%). No ownership %/status published anywhere open. NEXT: ownership from gazette/annual reports, TdC SEL reports, owners for the other 71, liquidation status

- [x] Presidency acts (agent: presidencia, 8a833b5): 1,898 acts (promulgations 1971-2026, 15 vetoes 2023-26: 5 confirmed/6 reformulated/2 caducou/2 no outcome, 157 TC acórdãos, 487 presidential decrees); 97% of Leis since 2022-04 linked to votacoes; VERIFIED vs known record (Mais Habitação veto 2023-08-21 confirmed; euthanasia vetoes 2023). Gaps: no structured vetoes before 2022 (Marcelo 2016-22, Cavaco), none of Governo decrees found, presidencia.pt keeps only current mandate; Block on the page shipped (earlier acts' coverage still open). NEXT: Wayback of old presidencia.pt, President's agenda, Council of State
- [x] Risk layer v3 (agent: risco, dbe571d): lots of one tender = one procedure (1.96M procedures, idprocedimento from raw files), size-band peers, new flags (deadline at/below minimum, no announcement, over ceiling after modification, lots over ceiling), municipal context columns (not flags); VERIFIED live: 432,383 flagged, 8,201 with score>=3, buckets sum to 2,279,894. Manual precision on only 15 examples: over-ceiling-after-modification 4/4, lots 1-2/4, 'no announcement' 0/4 (weight cut to 0.25), deadline below minimum 5/6. docs/risco_labels.csv (100 stratified contracts, empty true_positive) + ingest/jobs/risco_eval.py (precision per flag with Wilson CI) ready for the owner/AI to label. NEXT: label the CSV, art.113 justifications, company age

## From QA_REPORT_5.md (triaged; 3 high, 12 medium, 10 low)
- [x] empresas_locais FIXED and verified live (4465044): 2015 SEL omitted (identical to 2016: 151/151, 4/4 fields), owner KPI 106 name-based + 21 low-confidence, 29 idle companies noted
- [x] presidencia FIXED and verified live (af0bf5f): pre-2022 vetoes null/'n/d'; decree 173094 was 3 separate vetoes of different decree sets (Dec 2023, all confirmed 2024-01-08) -> outcomes now confirmed 7/reformulated 6/caducou 2 (total 15). QA item 16 FIXED and verified (2f6d87b): one source per period for AR promulgations (<2022-04 DRE partial; 2022-04..2023 votacoes; 2024+ DRE), chart marks source transitions, per-year counts 2022=34, 2023=108, 2024=190, Lei n/ano linking, no diploma counted twice
- [x] risco FIXED and verified (b94d108): filters in SQL (denormalised buyer_kind/seller_kind), exact totals + pagination; FRACIONAMENTO x municipio = 1,825 (independent count matches); agent tested 136/136 combinations; year filter noted as N/A for pair/entity flags
- [x] PMP outliers checked: only 4 of 6,251 values > 365 days; persistent series (Tabuaço 418/410/330, Vila Real de Santo António 396/354/345) look real; Gouveia 727 (Q1 2021) decays smoothly (15 -> 727 -> 132 -> 64 -> 42 -> 31) so likely real but NOT verified against the PDF — suggest an 'outlier (>365 dias)' note on the page
- [ ] remaining medium/low: docs/QA_REPORT_5.md

- [x] Regulators (duplicate board rows deduped, 2fe0d9e) (agent: reguladores, c138d16 + 185cd2e; AdC fine-total bug FIXED and verified: EUR 664M/645M were cumulative totals -> real fines EUR 19.5M/132M; PT/ZON 53.06M; 3 duplicates nulled; grand totals removed from the page, 'largest fines' table with source quotes; ingest warns on >EUR 250M and near-duplicate cases; AdC 53 decisions with amount, ~EUR 1.38bn in DB but not displayed; amounts outside the top 10 not hand-checked; ERC/CNPD not rerun). Original delivery: 22 bodies (21 matched), 74 board members, decisions AdC 1,023 / ERC 3,744 / CNPD 668 / AMT 26; ANACOM 403, ASF robots disallow, BdP anti-bot, CMVM/ERS JS-only (respected; no budgets/headcount collected). REVIEW FINDING sent to agent: AdC fines total EUR 2.29bn implausible — rows 2022-06-20 (EUR 664M) and 2022-06-08 (EUR 645M) look like the same case/figure; verify top 10 against full text, dedupe by case, hide totals until verified, add >EUR 250M regression warning. Verified-looking: 2019 banks EUR 225M, 2020 MEO EUR 84M, 2019 EDP EUR 48M

- [x] Public grants (agent: apoios, 8c020d3): 31,948 grants ~EUR 3.3bn, 5,347 beneficiaries (FCT 8,928 / IPDJ 15,393 / DGARTES 4,155 / ICA 2,474); linked by value 59% overall (DGARTES 93%, IPDJ 69%, FCT 54% by exact name); natural persons stored but never shown/searchable (555 grants); overlap with `fundos` warned (FCT-COMPETE). Partial-year caveat FIXED and verified (b592231): 12 flags in API (DGARTES 2024 '89 decisões', ICA PDFs por ler, FCT 2025/26, IPDJ 2019/2024 series breaks), hatched bars + captions. GAPS: DGARTES 2010-17 PDFs misaligned, 39 ICA PDFs without table, IPDJ SIEC needs login. Alias match DONE (match='alias': normalised name without accents/legal forms/articles, unique registry hit only, no NIF in source, never natural persons): +28 linked beneficiaries (1,789 -> 1,817), +EUR 247M linked (1.94bn -> 2.19bn); 1 ambiguous left unlinked. DONE a86667b: DGARTES 2010 and 2017 parsed, ICA PDFs parsed (partial). STILL OPEN: DGARTES 2011-2016 and 44 ICA text PDFs. NEXT: OCR ICA, resolve duplicate registry NIFs (e.g. Universidade de Aveiro 501461108/600042707) to unlock ~745 ambiguous names

- [x] Housing (agent: habitacao, b33dfcc): RNAL 111,942 active AL registrations (278/308 municipalities, 2,574 freguesias; aggregates only), INE series 193,043 rows (sale price m2 for 58 municipalities, rent m2 for 262, Censos 2021 for 308, licences, social housing to 2015), PRR C02 3,919 projects, housing contracts by municipality, 244 initiatives + 104 DRE acts; spot-checked: Lisbon 11,854 AL (3.7/100 dwellings), Porto 9,936 (7.5/100). BLOCKED: IHRU 1.º Direito/Porta de Entrada/Arrendamento Acessível (Power BI panel, no file), public housing inventory (JS app). NEXT: ask IHRU for file/annual report, monthly RNAL snapshots for history, INE quarterly series, affordability ratios
- [x] QA #6 done (docs/QA_REPORT_6.md: 1 high, 6 medium, 10 low). Fixed: #1 reguladores duplicate board rows (2fe0d9e), #4 veto titles; apoios alias pass follow-ups (stronger match label, ambiguous-alias count, SOCIEDADE removed). Grants alias match: done. Open:
  - [ ] #2 (medium) Apoios públicos, `#/apoios` ("3,3 mil M€ em 31 948 apoios"), `/api/apo: Confirmar no PDF de origem (FCT e IPDJ primeiro).
  - [ ] #3 (medium) Home (`#/`), secção "O que mudou": Calcular a janela até à data de atualização (ou até hoje) e mostrar o intervalo real no título.
  - [ ] #5 (medium) Roadmap, `#/roadmap`, card "Feito" (Atos do Presidente): Atualizar o texto para 1 190 ou ligar o número ao overview.
  - [ ] #6 (medium) Habitação, `#/habitacao` (tab Panorama, "Alojamento local por modalida: Mapear os códigos para rótulos em português, por exemplo "Estabelecimento de hospedagem" e "Hostel", no módulo ou na API.
  - [ ] #7 (medium) Reguladores, `/api/reguladores/overview` (5 461 decisões), CNPD (668 d: Mostrar "sem data" nas listagens e explicar no contador que parte das decisões não tem data.
  - [ ] #8 (low) Reguladores, decisões da ERC (`decisions.year`): Documentar no ingest o significado de `year`, ou usar o ano de `date` nas séries.
  - [ ] #9 (low) Roadmap, card "Em curso", item "Habitação": Retirar as crases do texto do roadmap ou renderizar o markdown.
  - [ ] #10 (low) Roadmap, "Última atualização: 30 out 2026 06:33": Atualizar a data quando o roadmap for regenerado, ou mostrar a data do último build.
  - [ ] #11 (low) Presidencia, `/api/presidencia/overview` e `/api/presidencia/atos` ("1: Acrescentar à nota "Limites de cobertura" que os duplicados (canon=0) são excluídos.
  - [ ] #12 (low) Presidencia, texto "Cobertura" (`cobertura.presidencia.pt`): Reescrever: "Atos de presidencia.pt só desde 2026-03-09; restantes atos de DRE, votações e TC".
  - [ ] #13 (low) Presidencia, gráfico "Atos por ano": Mostrar o "n/d" só na legenda ou com cor e texto próprios; aumentar a largura das colunas.
  - [ ] #14 (low) Habitação, gráficos "Preço mediano de venda" e "Renda mediana": Reduzir o número de etiquetas ou rodar o texto.
  - [ ] #15 (low) Apoios, listas de beneficiários (`#/apoios`, "Por programa"): Normalizar a capitalização na apresentação, sem alterar a chave `nome_norm`.
  - [ ] #16 (low) Apoios, programa "FCT · Unidades I&D (2015-2019)": Mostrar o período do programa e não atribuir o montante a um único ano, ou explicar a regra na nota do gráfico.
  - [ ] #17 (low) Home, "Votações recentes" e roadmap: Corrigir na origem (texto dos títulos e do roadmap).

## Infra notes
- Caches (core memo + generic module /overview cache) are now stale-while-revalidate: an expired entry is served at once and refreshed right after the response; warm-up every 3 min. Visitors never pay the 3 s cold query after the first one
- Rule added to docs/MODULES.md: module ingests must use WAL + small commits (anuncios ingest locked its DB for minutes; server now answers 'Dados em atualização' instead of an error). 15 finished module/core DBs converted to WAL (2026-10-29); TODO: convert anuncios.db and justica.db once their agents finish (they were mid-ingest), and make each finished ingest set WAL itself

- Intermittent `database is locked` seen from /api/eleicoes/list while its ingest wrote: every module must open DBs read-only (`openData`) and retry on SQLITE_BUSY; add a generic retry wrapper in server.mjs

- daily.sh (light) + update.sh (weekly full) exist; install as cron on the host. DRE and fundos jobs need an incremental mode (currently full rebuild)
- QA auditor #2 (haiku) running over the new modules -> docs/QA_REPORT_2.md
- politica.db is in WAL mode (2026-10-29) so readers (server, agent test servers) no longer block ingest writes.
- Ministry minister names must be reconciled across sources (portugal.gov.pt page was stale for MAI: sent to ministerios agent).

## Analysis / AI-ready
- [x] Risk layer v2: thresholds measured from data (20k/30k/75k/150k), splitting 6.3k contracts, 1,094 buyers flagged, docs/DATA.md dictionary (agent: risco) — validation 8/15 true positives; next: treat lots as one procedure, art.113 justifications, peer-normalise by population/budget, company ages, labelling loop
- [~] Who is responsible (f82a576 ingest, c49bc9a UI appointments list + board history): DRE appointments and CReSAP ingested. Gaps: DRE série II despachos BLOCKED (no usable access); CReSAP results are shortlists, not final appointments; interest declarations read in batches; contract cross-view open
- [ ] Risk-indicator v2: threshold clustering just below direct-award limits, contract splitting, repeated winner, new-company winners, bidder collusion patterns
- [ ] Export layer: parquet/CSV snapshots + data dictionary (docs/DATA.md) for later AI analysis
- [ ] Per-entity "investigation" view: network graph buyer<->seller, timelines, notes
- [ ] Alerts: follow -> daily digest (email/RSS/webhook)
- [ ] Anomaly scoring job writing `data/risk.db` + UI explanations

## Product / UX
- [x] Main nav grouped into 6 dropdowns (NAV_GROUPS in portal.js; unlisted modules fall into 'Mais'); risco/responsaveis slots already configured
- [x] Overview endpoints cached 10 min + warmed at startup (core 3s, saude 9.5s -> ms); generic for every module's /overview
- [ ] Add indexes/pagination review for remaining slow endpoints (risco/overview 0.3s, fundos 0.4s ok)
- [ ] Mobile pass on every page; dark-mode pass; print styles
- [ ] Accessibility audit (keyboard, contrast, aria)
- [ ] Charts: sparkline per entity, map of municipalities (choropleth), treemap of spend by CPV
- [ ] Glossary/explainers (what is ajuste direto, CPV, acordo-quadro…)
- [ ] Share links / permalinks / OpenGraph; sitemap
- [x] Home: tile grid for every section (auto-lists modules present)
- [x] Portal rebranded 'Estado Aberto' with Portuguese palette (548127f) and visual redesign (7a3302f); 'Novidades' panel on the home page (903c612)
- [x] Home 'O que mudou' feed (/api/changes: new contracts, plenary votes, DRE acts, agenda, Presidency) — next: add appointments (responsaveis), risk flags on newly published contracts, per-section landing pages
- [ ] Tests: API smoke tests + data-quality checks run by update.sh
- [ ] ECFP party accounts and state subsidies: BLOCKED, no machine-readable source (tribunalconstitucional.pt generic page, transparencia.tcontas.pt unreachable, nothing on dados.gov.pt); revisit PDFs behind ECFP search pages
- [ ] State real-estate inventory (SIPIE/DGTF), URL unverified
- [ ] Public job offers (Bolsa de Emprego Público, bep.gov.pt, unverified), link hiring to entities
- [x] IGF local-government audit reports (c2447f9, `#/igf`): 282 reports 2010-2026 linked to municipalities (https://igf.gov.pt/relatorios-administracao-local-autarquica; robots allow). Gap: no PDF text/findings
- [x] Provedor de Justiça annual reports (f73a64c, `#/provedor`): 45 reports 1976-2025. Gap: complaint totals per year only partly extracted
- [x] Parish population from INE Censos 2021 (d3bee84): 2,960 of 3,092 parishes; 132 unmatched stay empty

## New public-data gaps (2026-11-04; each URL fetched from the home PC with HTTP 200 and robots.txt checked; never bypass robots or logins)
- [ ] INE indicators by municipality beyond what is ingested (employment, income, education, demography, tourism): `https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=<code>&Dim1=T&lang=PT` (JSON, 200, no robots.txt); pick codes per theme and join on the 308 concelhos
- [ ] APA environment: groundwater quality stations network (shapefile ZIP, 200): https://sniambgeoviewer.apambiente.pt/GeoDocs/shpzips/snirh_qualsub_vw.zip (listed on dados.gov.pt; apambiente.pt robots allow `/`); measurements themselves still to locate (snirh.apambiente.pt returns 403)
- [ ] IGCP public debt statistics: https://www.igcp.pt/pt/investidores/estatisticas (HTML page 200, robots disallow only technical paths; dataset 'Estatisticas da Divida Publica' on dados.gov.pt); locate the XLS/CSV links on the page
- [ ] AMA 'Registo Estrangeiros - Estatisticas PMC' (foreigner registration requests by scope): https://dados.gov.pt/datasets/registo-estrangeiros-estatisticas-pmc-1 (JSON resources, monthly, 200); not AIMA residence-permit statistics, which are unreachable
- [ ] DGEEC education statistics (pupils, results, teachers by school/municipality): https://www.dgeec.mec.pt/np4/EstatisticasEducacao (HTML with XLS/PDF downloads, 200; robots `Disallow:` empty = all allowed); would add the recent pupils data missing from `educacao`
- [ ] Portal da Transparencia (transparencia.gov.pt: public finance and workforce indicators; robots allow all except `/contratacao-publica/`): https://transparencia.gov.pt/pt/ (200; assets served under gateway2.digital.gov.pt/thcms/api/assets, format to confirm: CSV/XLSX); avoid the contracts section, already covered by BASE
- [ ] ERSE energy (tariffs, prices, market statistics): https://www.erse.pt/ (200, robots allow all); exact data URL (XLSX/PDF) still to be located before ingest
- [ ] Municipal open budgets published by the câmaras themselves on dados.gov.pt (PDF, plus some CSV): `https://dados.gov.pt/api/1/datasets/?q=orçamento municipal` (API 200, e.g. Mangualde 2025, Benavente 2022-23, Moura 2026-30); complements DGAL execution, heterogeneous PDFs
- Blocked/unreachable (do not retry): base.gov.pt and opendata.aima.gov.pt (no connection from home PC, HTTP 000); snirh.apambiente.pt (403); PORDATA (robots disallow `*Export*.aspx` and popups, no bulk file; HTML only); DGS dgs.pt (robots crawl-delay 120 s, Googlebot/Bingbot disallowed); ANSR road-accident statistics (page 200 but no data file located, robots not fully read; RASI stays PDF-only); CMVM (JS-only, already noted); SEF (merged into AIMA, no data)

## Wave 7 (2026-11-04)
- [x] Parliamentary speeches (agent: intervencoes, a7f2c84, d965921): 12,914 plenary speeches (XVII and XVI), 48.6% linked to initiatives, avg 4.2 initiatives per linked speech because of joint debates; parlamento.pt open data unreachable so DAR PDFs are used — NEXT: stance evaluation per deputy/party; earlier legislatures still open
- [x] Immigration (agent: imigracao, 11c0240): foreign residents by nationality and region (#/imigracao) — gap: AMA only 3 snapshots
- [x] Education statistics DGEEC (agent: dgeec, 8ad717f): 48 indicators, 2,135 rows (#/dgeec) — gaps: no post-2020 pupil files (old XLS URLs redirect to a SPA), municipal teachers and higher education missing
- [x] Public debt IGCP (f8f0088): monthly direct State debt since 2001, composition, maturity and fixed-rate share (#/divida) — gap: maturity profile only published as a chart image
- [ ] ine_series (#/indicadores): pending, not yet shipped
- [ ] ERSE energy prices: erse.pt answers 200 and robots.txt allows all; exact data file URL still to be located under /atividade/regulacao/tarifas-e-precos-eletricidade/
- [ ] Portal da Transparencia: dados.gov.pt hosts only 3 related datasets; confirm format before building (the SNS site is blocked, see health)
- [ ] Municipal budgets on dados.gov.pt: API answers 200, datasets 'Orcamentos Municipais aprovados' and per-municipality budgets exist (robots.txt returns 500: respect the API only, throttled)
- [ ] DGAL local finance: DGAL organisation on dados.gov.pt lists 63 datasets (API 200); www.dgal.gov.pt itself redirects, use the dados.gov.pt copies
- [ ] Eurostat / INE comparisons: Eurostat dissemination API (gov_10dd_edpt1 etc.) and INE json_indicador both answer 200; use for debt/deficit and per-capita comparisons
- BLOCKED (unchanged): SNS Portal da Transparencia (robots disallows downloads), ECFP party financing, per-company state accounts, AR open-data JSON, DGPJ open data, prociv.pt/ANSR/ICNF

