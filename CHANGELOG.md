# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
