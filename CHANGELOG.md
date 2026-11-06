# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- AI volume and spend caps removed (daily and monthly budget, article count, shortlist, triage and selection sizes); the verifier, the reviewer and the per-call guards stay.

## [0.3.12] - 2026-11-06

### Added
- Daily President of the Republic summary story covering all of the day's acts, with its own writing prompt.

### Fixed
- Presidency stories no longer pull unrelated events by the generic office name and carry the act's own facts.
- The AI verifier now fails loudly if its public institutions list is missing.

## [0.3.11] - 2026-11-06

### Fixed
- "Ver a lei" on AI articles about decrees without an initiative now opens the act page.
- Failures while building the law evidence are logged instead of silently dropping votes and debate.

### Changed
- AI articles open with what the law does before the vote and debate, and "O que muda" no longer repeats "segundo o texto da lei" in every item.

## [0.3.10] - 2026-11-06

### Changed
- "A minha lista" asks for consent before storing a random visitor id in the browser (local storage, no tracking cookies), explains what it is for, and works only if accepted.

## [0.3.9] - 2026-11-06

### Fixed
- "A minha lista" is now per visitor (random id kept in the browser) instead of shared by everyone; existing shared entries are dropped.

## [0.3.8] - 2026-11-06

### Changed
- AI bundles are built only from the site data; no external pages or documents are fetched while drafting.

## [0.3.7] - 2026-11-06

### Added
- Unanimous plenary votes are expanded to all parliamentary groups in favour (absentees kept), with totals computed from seats and a unanimity flag; the article page shows it.
- Earlier votes of an initiative (committee, generalidade, avocacao) are shown as a timeline and given to the AI, so articles explain how positions evolved.
- Initiative texts are fetched from the parliament annexes (`Texto Final`, `Texto de Substituicao`, `Texto Inicial`); annex links are stored in `iniciativa_anexos` and backfilled with `ingest/jobs/votacoes.py --anexos`.
- The article page shows the author type (citizens, Government, deputies).

### Changed
- Articles never claim missing data when it is present: the AI prompts require using votes, speeches and phases, and the verifier rejects "no data" phrasing when they exist.

## [0.3.6] - 2026-11-06

### Fixed
- Laws whose title changed in Parliament are linked to their initiative by guarded fuzzy matching (similarity, shared legal citations, unambiguous best candidate), so the AI bundle carries the vote and debate.
- The AI verifier no longer requires declaring place names that appear verbatim in the evidence; only person names must be declared.

## [0.3.5] - 2026-11-06

### Added
- AI articles for every parliament event (votes, debates, initiatives, resolutions and recommendations) now carry the vote and debate blocks: the initiative, the party-by-party vote and up to six verbatim speech excerpts, with a dedicated vote-and-debate prompt.
- `ops/ai/run.py --refresh-changed` update path (also run by the normal pipeline): published articles whose evidence gained votes or debate are redrafted outside triage and selection, within `AI_MAX_UPDATES` and the daily budget, and supersede the old article.

## [0.3.4] - 2026-11-06

### Changed
- AI verifier checks names in tiers: person names stay strict, while institutions, acronyms (also by their expansion in the evidence), legal acts and tax names are accepted when found in the evidence or in the maintainable list `ops/ai/instituicoes_publicas.json`.
- Vote claims fall back to the votes written in the evidence text when no vote table exists.
- The AI importer retries a locked ledger, tolerates a missing revision number and names the files it could not import.

## [0.3.3] - 2026-11-06

### Changed
- Laws published in the DRE are linked to their parliamentary initiative by incremental steps (`dre_recent`, `votacoes_recent`), by law number, exact title or citation.
- AI articles for laws include the final vote by party and the plenary debate, also when the link pass has not run yet.
- Superseded AI articles are hidden and kept for audit.

## [0.3.2] - 2026-11-06

### Changed
- AI confidence gate 0.6 with `AI_CONFIANCA_MIN` override.
- AI publish decisions log their reason.

## [0.3.1] - 2026-11-06

### Changed
- AI verifier no longer rejects legitimate legal references.
- `--reverify` republishes cached drafts without regenerating.
- Lock helper fails fast and creates group-writable lock files.
- Votacoes incremental step has deadlines and reports partial results.
- Refresh no longer fails when optional steps are partial.
- Front page layout for sparse days.

## [0.3.0] - 2026-11-06

### Added
- AI explainers for laws: party votes, deputies' speeches and a plain-language explanation checked against the text.
- Small-day mode: days with few candidates skip triage and selection.
- Ledger object routes: items link to the law and object pages.
- Login runtime mode for the AI service (`AI_AUTH_MODE=login`) with a systemd drop-in and installer option.

### Changed
- The front page no longer shows data-freshness notices.

## [0.2.2] - 2026-11-06

### Fixed
- Refresh steps failing with 'database is locked' on the live server.

## [0.2.1] - 2026-11-06

### Changed
- AI pipeline hardening: retraction command, stricter verifier, cost accounting, privacy rules, CLI flag validation.

## [0.2.0] - 2026-11-06

### Added
- Daily edition ledger (`diario.db`) built from the local databases, with numbered editions from 2026-11-06.
- 6-hourly refresh timers, plus daily and weekly timers, with an ordered shared lock and failure alerts.
- AI digest pipeline (disabled by default, timer never enabled by the installer unless `--enable-ai-timer` is given).
- New front page with an AI column and a full-list view.

## [0.1.6] - 2026-11-05

### Added
- `migrate` ingest step (`ingest/migrations.py`) that upgrades existing databases in place, offline and idempotently, and runs first on every update.
- `tools/check_schema_compat.mjs`, which builds empty databases from a production schema dump and sweeps every route for missing tables or columns.

### Fixed
- Routes breaking on databases built before `entities.population_source` and the responsaveis `nomeacoes` and `cresap_results` tables existed: the Instituições directory and the responsaveis pages now answer with partial data and a "dados em atualização" note.
- Empty tables no longer produce a 500 on the budget overview and the housing ranking.
- The Estado em números ingest job could not import the shared helpers when run by the manifest.

## [0.1.5] - 2026-11-05

### Added
- Site-wide dark mode toggle, following the system preference on the first visit and remembering the choice.

### Removed
- The edition box in the Edição Diária masthead and the print button.

## [0.1.4] - 2026-11-05

### Removed
- The "Última recolha" box in the Edição Diária masthead.

### Added
- GitHub link in the site footer, the edition utility row, the offline page and the no-data state.
- CI guard that fails when tracked files mention server or developer host details.

### Changed
- Docs use placeholders (<SERVER_HOST>, <SSH_USER>, <SSH_KEY>) for server host details.

## [0.1.3] - 2026-11-05

### Fixed
- Edition page never finishing on small servers: the two local-government contract queries read 6.4 GB per computation and are now bounded by the week through the published-date index (84 MB), with a bounded fallback when the index is missing.
- Background jobs get a generous watchdog (ESTADO_ABERTO_WORKER_TIMEOUT_MS, default 10 minutes) and are retried with exponential backoff (30 s, 2 min, 10 min, 30 min cap); every kill and worker crash is logged with route, elapsed time and stack.
- The edition returns a partial result marked partial when the time budget is exceeded.
- Worker connections use temp_store file and the worker thread runs at low priority.

## [0.1.2] - 2026-11-05

### Changed
- Server never blocks the event loop: API routes run in a worker thread with a disk cache, and a first request on a slow route answers 202 carregando instead of hanging.
- Cheap /api/status, gzip/brotli compression, ETag and caching headers.
- Client loads routes lazily, prefetches on hover, renders the home from boot data and registers a service worker with an offline page.
- Client retries API GETs answered with 202 carregando with backoff and never caches them.
- Release helper keeps VERSION, package.json, the manifest, the service worker version and the page version tag in step, and `npm run check` fails if they disagree.

### Added
- Continuous integration, release workflow and release helper.
- Pull-model updater, systemd units and first-time installer for the production server.
- Operations, releasing and AWS migration documentation.

## [0.1.1]

### Changed
- Installer accepts `--python` (default: first Python 3.12 or newer found), links `/usr/local/bin/estado-aberto-python` and no longer enables the timers unless `--enable-timers` is given.
- Updater, ingest queue runner and the daily service use `estado-aberto-python`; shell scripts honour `ESTADO_ABERTO_PYTHON`.
- Operations and AWS migration docs describe Amazon Linux 2023 (Python 3.12, system Node, poppler-utils, existing swap, timer enablement order).

### Fixed
- The post-update doctor step no longer fails on hosts whose `python3` is older than 3.12.

## [0.1.0]

### Added
- Initial public code base: web server, ingest tools, sample data generator and smoke test.
