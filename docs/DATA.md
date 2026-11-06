# Data dictionary (for analysis and AI)

Two SQLite files matter for analysing public spending:

* `data/politica.db` — core registry and public contracts (Portal BASE / IMPIC). ~3 GB, WAL mode. Built by `ingest/*.py`.
* `data/risco.db` — explainable risk signals derived from it. Built by `python3 ingest/run_all.py risco` (~2 min).
  Flat export: `data/exports/risco_contracts.csv.gz` (one row per flagged contract, all flags + evidence JSON).

Other module databases (`dre.db`, `fundos.db`, `autarquias.db`, `orcamento.db`, …) are described in their own job files
(`ingest/jobs/<name>.py`) and in `docs/SOURCES.md`. Join key everywhere: **NIF** (9-digit Portuguese tax number, text).

Conventions: money is in euros **without VAT** as published in BASE; dates are `YYYY-MM-DD` text; NIFs are text (keep
leading zeros); `NULL`/empty means "not published".

---

## politica.db

### `contracts` — one row per public contract (2.28 M, 2012-01 → present)
| column | meaning |
|---|---|
| `id` | BASE contract id (text). Contract page: `https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=<id>`; portal: `#/contrato/<id>` |
| `year` | publication year in BASE (file year), not necessarily the signing year |
| `signed` | contract signing date (`dataCelebracaoContrato`); 42 k rows NULL |
| `published` | publication date in BASE |
| `decision` | award decision date |
| `object` | free-text object of the contract (FTS index: `contracts_fts`) |
| `types` | contract type(s), `; `-separated: *Aquisição de bens móveis*, *Aquisição de serviços*, *Empreitadas de obras públicas*, *Locação de bens móveis*, concessions… |
| `procedure` | award procedure: *Ajuste Direto Regime Geral* (direct award), *Consulta Prévia* (≥3 invited), *Concurso público*, *Concurso limitado por prévia qualificação*, *Ao abrigo de acordo-quadro (art.º 258.º/259.º)* (framework call-off), *Ajuste direto simplificado* (≤5 k€), *Contratação excluída II*, … |
| `price` | contract price (€, no VAT) |
| `base_price` | tender base price, often 0 when not applicable |
| `effective_price` | final executed price when reported (sparse) |
| `cpv` / `cpv_code` | CPV code with label / code only (`79421200-3`). First 2 digits = division, 3 = group, 4 = class |
| `location` | place of execution (country, district, municipality text) |
| `duration_days` | execution period in days |
| `n_bidders` | number of bidders (`concorrentes`) published; NULL = list not published; includes the winner |
| `framework` | framework agreement description, if any |
| `centralised` | whether centralised procurement (*Sim/Não*) |
| `direct_basis` | justification category for direct award (mostly uninformative) |
| `legal_basis` | **legal ground** (e.g. `Artigo 20.º, n.º 1, alínea d) do Código dos Contratos Públicos`). Art. 19.º/20.º/21.º = value criterion (has a ceiling); art. 24.º–27.º = material criteria (urgency, exclusivity; no ceiling) |
| `criterion` | award criterion (price / best value) |
| `announcement` | DR announcement number (same value groups lots of one tender) |
| `link` | source link when available |
| `buyer_nif`, `buyer_name` | contracting authority (first one when several) |
| `seller_nif`, `seller_name` | first awardee; `seller_nif` NULL in ~10% (mostly private individuals whose NIF is withheld, some foreign/omitted companies) |
| `n_sellers` | number of co-awardees (consortia); all are in `contract_parties` |

### `contract_parties` — every party of every contract (8 M)
`contract_id`, `nif`, `name`, `role` = `buyer` \| `seller` \| `bidder`. Bidders exist only where BASE publishes the list
(competitive procedures, ~870 k contracts). The winner normally also appears as a bidder.

### `contract_mods` — contract modifications (88 k)
`contract_id`, `date` (modification date), `published`, `basis` (legal ground: *Trabalhos Complementares (art. 370.º)*,
*Alteração anormal e imprevisível…*, *Interesse público…*, *Revisão de preços…*, *Cessão da posição contratual…*),
`act_type` (*Acordo entre as partes*, *Acto Administrativo*, …), `new_price` (**total** price after the modification),
`new_duration`, `year`. Price creep of a contract = last `new_price` / `contracts.price` − 1.

### `entities` — registry of public bodies and suppliers (117 k)
| column | meaning |
|---|---|
| `id` | portal id (`#/entidade/<id>`); changes when rebuilt — join on `nif` |
| `nif` | NIF/NIPC (unique when known). First digit: 1–3 individuals, 5 companies/associations, 6 public bodies, 9 irregular entities |
| `name` | name |
| `kind` | `municipio`, `freguesia`, `cim_am`, `empresa_municipal`, `escola`, `saude`, `universidade`, `instituto_publico`, `seguranca_defesa`, `tribunal_justica`, `regional`, `empresa_publica`, `ministerio`, `outra_entidade`, `empresa_ou_particular` |
| `level` | `central`, `regional`, `local`, `empresa_publica`, `privado`, `outro` |
| `is_public` | 1 = contracting authority / public body |
| `parent_id` | parent entity (freguesia → município, body → ministry) |
| `ministry`, `wikidata`, `website`, `description`, `sources` | descriptive |
| `region`, `district`, `municipality`, `dico` | geography; `dico` = INE code (4 digits município, 6 freguesia) |
| `population`, `lat`, `lon` | for municipalities/parishes |
| `buyer_contracts`, `buyer_value`, `seller_contracts`, `seller_value` | totals copied from the stats tables |

### Precomputed statistics (from `ingest/stats.py`, `ingest/modifications.py`)
* `buyer_stats(nif, n, value, direct_n, direct_value, single_bidder_n, competitive_n, overrun_n, first_signed, last_signed)` — per buyer; `overrun_n` = effective_price > 1.2 × price.
* `seller_stats(nif, n, value, n_buyers, direct_n, first_signed, last_signed)` — per supplier (co-sellers share the price).
* `pair_stats(buyer_nif, seller_nif, n, value, direct_n)` — per buyer–supplier pair.
* `year_stats(nif, year, n, value, direct_n, direct_value)` — per buyer and year.
* `buyer_mod_stats(nif, modified_n, mods_n, increase_value, big_increase_n)` — modifications per buyer; `big_increase_n` = last new_price > 1.25 × price.

### Non-procurement tables
* `events(id, title, start, end, section, theme, subtitle, local, text, source)` — parliament agenda items.
* `initiatives(key, kind, number, legislature, session, origin, title, source)` and `initiative_steps(initiative_key, event_id, date, phase, body, detail, relator, source)` — legislative initiatives seen in the agenda and their steps.
* `laws`, `law_versions`, `votes` — reserved for the parliament open-data adapter (currently empty).
* `parties(code, name, seats, bloc, color, ideology, website)`, `people(id, name, role, body, party, since, source)` — parliament parties and government members.
* `institutions(id, name, category, branch, description, url, reachable)` — sovereign institutions.
* `news(url, body, title, date, source)` — Presidency news.
* `follows(id, kind, ref, label, created)` — user watch-list (local UI state).
* `meta(key, value)` — last update timestamps per ingest step.
* `contracts_fts` — FTS5 index over `contracts.object` (`rowid` = `contracts.rowid`).

---

## risco.db

All indicators are **statistical signals, not accusations**. Every row keeps the evidence needed to verify it.

**Version 3 (`meta.version` = 3).** Unit of analysis = **procedure**: all contracts sharing the Portal BASE
`idprocedimento` (lots of one tender, or several contracts of one direct award) and the same buyer form one procedure.
`idprocedimento` is not in `politica.db`; it is read from the raw yearly JSON (`data/raw/contracts/*.zip`) and cached
in `data/raw/risco/procmap.tsv.gz`. Procedure value = sum of its lots; splitting needs ≥ 2 *distinct* procedures;
bunching, single-bidder and December/pre-election rates count procedures. Entity flags compare each buyer with a
**peer group** = same `entities.kind` + size band (municipalities: population quartile, Censos 2021 from
`entities.population`; other kinds: quartile of total contracted value), excluding the entity itself (groups with < 10
members fall back to the whole kind). Extra read-only inputs: `data/anuncios.db` (contracts without announcement,
announcement deadlines ≤ p10 per type and regime pre/post-2018), `contract_mods`/`buyer_mod_stats` (politica.db) and
`data/autarquias.db` (`pmp`, `budget` — context only, never flags).

### `flag_defs` — the catalogue (read this first)
`flag` (code), `level` (`contrato` \| `par` \| `entidade`), `weight` (score points), `label` (PT), `description` (exact
rule, PT), `caveat` (known legitimate explanations / limitations, PT), `n_flagged` (rows flagged), `value_flagged` (€).

### `contract_flags` — one row per (contract, flag)
`contract_id` → `politica.contracts.id`; `flag`; `weight` (may differ from the default, e.g. single bidder in a
consulta prévia = 0.5; price creep > 50% = 2.5); `evidence_json` (rule inputs: ceiling, price, related contract ids
`[[id, date, procedure_value, n_lots], …]`, sums, national baseline…); denormalised `year`, `signed`, `price`,
`buyer_nif`, `seller_nif`, `procedure_id` (BASE `idprocedimento`), `buyer_kind`, `seller_kind` (`entities.kind` at build time,
so kind filters run in SQL). Flags with weight 0 are never stored.

Contract flags: `FRACIONAMENTO` (possible splitting), `ART113` (3-year cumulative direct-award limit, art. 113.º/2 CCP),
`JUNTO_AO_TETO` (95–100 % of the procedure ceiling), `ACIMA_DO_TETO` (≥ ceiling under a value-criterion ground),
`CONCORRENTE_UNICO` (single bidder), `FORNECEDOR_NOVO` (first-year supplier with a large contract), `DERRAPAGEM`
(> 25 % price increase via modifications), `SEM_NIF_FORNECEDOR` (company awardee without NIF), `NIF_INVALIDO`,
`SEM_LISTA_CONCORRENTES` (competitive procedure without bidder list); v3: `LOTES_ACIMA_DO_TETO` (value-criterion
procedure whose lots are each below the ceiling but sum above it), `MODIF_ACIMA_DO_TETO` (value-criterion procedure that
reaches the ceiling after a substantive modification), `SEM_ANUNCIO` (concurso without matching announcement, weight 0.25,
mostly a registry gap), `PRAZO_CURTO` (proposal deadline exactly at the p10 = de-facto legal minimum, weight 0.25),
`PRAZO_MUITO_CURTO` (deadline strictly below the p10 of its type/regime).

### `contract_score` — one row per flagged contract
`contract_id`, `score` (sum of the weights of its distinct flags), `flags` (comma list), `year`, `signed`, `price`,
`procedure`, `buyer_nif`, `seller_nif`, `buyer_kind` (`entities.kind`), `procedure_id`, `seller_kind`.

### `pair_flags` — buyer–supplier patterns
`buyer_nif`, `seller_nif` (for cover/rotation: the winner), `flag`, `weight`, `n_contracts` (cases), `value` (€ when
meaningful), `evidence_json` (e.g. losing bidder NIF and its national win rate, the bidder set and wins per member,
procedure ids), `buyer_kind`, `seller_kind`. Flags: `FORNECEDOR_DOMINANTE`, `VENCEDOR_POUCA_CONCORRENCIA`, `CONCORRENTE_DE_COBERTURA`, `ROTACAO`.

### `entity_risk` — one row per (nif, role)
`nif`, `role` (`comprador` \| `fornecedor`), `name`, `kind`, `score` (sum of entity-flag weights), `flags_json`
(`[{flag, weight, label, evidence}]`; evidence compares the entity with the national or same-kind baseline),
`n_contracts`, `value` (from `buyer_stats` / `seller_stats`), `n_flagged_contracts`, `peer_group` (label, e.g.
"municipio · população 4.º quartil (maiores)"), `n_peers`, `context_json` (same as `entity_context`). Evidence of
peer-normalised flags carries `taxa_pct`, `taxa_pares_pct`, `razao`, `z`, `n_pares`, `grupo_pares`.
Entity flags (buyers): `E_CONCENTRACAO_TETO`, `E_FRACIONAMENTO`, `E_ART113`, `E_CONCORRENTE_UNICO`, `E_DERRAPAGEM`,
`E_DEZEMBRO`, `E_PRE_ELEITORAL`, `E_DADOS_EM_FALTA`, `E_PARES_SUSPEITOS`, and v3 `E_PRAZOS_CURTOS`, `E_SEM_ANUNCIO`,
`E_MODIF_ACIMA_TETO`. Suppliers: `F_FORNECEDOR_NOVO`,
`F_DERRAPAGEM`, `F_NUNCA_GANHA`, `F_FRACIONAMENTO`, `F_DOMINANTE`.

### `entity_context` — one row per buyer (flagged or not) — CONTEXT, not flags
`nif`, `kind`, `peer_group`, `n_peers`, `context_json`: `procedimentos`, `contratos`, `modificacoes`
(`buyer_mod_stats`: modified contracts, increases > 25 %, total increase €), and for municipalities
`populacao_censos2021`, `dico`, `prazo_medio_pagamento` {dias, data} (DGAL, latest quarter) and `execucao_despesa`
{ano, orcamento_eur, executado_eur, taxa_execucao_pct} (latest year with both budget and execution, ≤ 2019).

### Labelled sample and precision
`docs/risco_labels.csv` — 100 flagged contracts stratified by contract flag (seed fixed), with evidence, BASE URL and an
empty `true_positive` column (1/0). `python3 ingest/jobs/risco_eval.py` computes precision per flag with Wilson 95 %
intervals → `data/exports/risco_precision.json`. `--template` regenerates the sample (refuses to overwrite labels).

### `meta`
`built`, `params` (all thresholds), `thresholds` (each legal ceiling with its empirical validation: counts in the
95–100 %, 85–90 % and 100–105 % bands and the spike ratio), `national` (baselines: splitting and art. 113 rates, December
share by entity kind, single-bidder rate by kind, pre-election ratio for local governments, splitting sensitivity for
14/30/60-day windows, peer-group sizes, national rates per procedure), `anuncios` (deadline p10 thresholds and counts),
`version`, `counts` (flags per code).

### Ceilings used (validated on the data)
| rule | legal ground | ceiling |
|---|---|---|
| AD_BS_20K | AD art. 20.º/1 d) CCP (goods/services, 2018+) | 20 000 € |
| AD_OB_30K | AD art. 19.º d) CCP (works, 2018+) | 30 000 € |
| AD_OUT_20K | AD art. 21.º/1 c) CCP (other contracts) | 20 000 € |
| CP_BS_75K | Consulta prévia art. 20.º/1 c) | 75 000 € |
| CP_OB_150K | Consulta prévia art. 19.º c) | 150 000 € |
| AD_BS_75K_PRE18 | AD art. 20.º/1 a) (pre-2018 regime) | 75 000 € |
| AD_OB_150K_PRE18 | AD art. 19.º a) (pre-2018 regime) | 150 000 € |
| AZ_AD_75K | Azores DLR 27/2015/A art. 20.º/21.º a) | 75 000 € |

Madeira grounds (`… e artigo 4.º … DLR`) are excluded: no clean spike. Material-criterion awards (art. 24.º–27.º) have
no value ceiling and are never tested for splitting/bunching.

### Example queries
```sql
-- top flagged contracts of a municipality, with evidence
ATTACH 'data/politica.db' AS p;
SELECT s.score, s.flags, c.signed, c.price, c.object, c.seller_name
FROM contract_score s JOIN p.contracts c ON c.id = s.contract_id
WHERE s.buyer_nif = '506656128' ORDER BY s.score DESC, s.price DESC LIMIT 20;
-- all members of a splitting group
SELECT evidence_json FROM contract_flags WHERE contract_id = '1585049' AND flag = 'FRACIONAMENTO';
```

Databases stay in WAL mode while the web app is running. The app opens them read-only, which still needs the `-shm` file: the data directory must be writable by the app user.
