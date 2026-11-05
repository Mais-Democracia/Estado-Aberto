# Data sources runbook

This repository carries only the tools that download and build data from public sources. No data is committed, released or uploaded.

## Running

All commands run from the repository root. The data directory is `./data` unless `ESTADO_ABERTO_DATA` is set.

```
python3 tools/doctor.py                     # machine checks and source reachability
python3 tools/bootstrap.py --minimal        # a few minutes of data, small and fast steps only
python3 tools/bootstrap.py                  # everything, resumable
python3 ingest/run_all.py --list
python3 ingest/run_all.py --dry-run --schedule weekly
python3 ingest/run_all.py --only justica    # justica plus the steps it depends on
python3 ingest/run_all.py --only justica --no-deps
./daily.sh                                  # schedule daily
./update.sh                                 # schedule weekly (includes daily)
```

Schedules: `daily` steps are light; `weekly` runs daily and weekly steps; `bootstrap` runs everything except `manual`, including slow-changing sources (elections, education, budget, housing) that need a refresh only when upstream publishes. Run `--schedule bootstrap --resume` monthly to refresh them.

Cron on the server:

```
15 6 * * *  /srv/estado-aberto/daily.sh  >> /srv/estado-aberto/data/daily.log 2>&1
30 3 * * 0  /srv/estado-aberto/update.sh >> /srv/estado-aberto/data/update.log 2>&1
```

## Runner behaviour

- Steps run strictly one at a time in dependency order (`ingest/jobs.json`). A failed step blocks only its dependents; independent steps continue. Exit status is non-zero if any step failed, was refused by the disk guard or was blocked.
- `--resume` skips a step whose state in `data/.ingest_state.json` is `ok`, younger than 80 percent of its `fresh_days`, and whose outputs still exist.
- Per step the state records status, seconds, peak RSS (MB) and free-disk delta (MB). Logs go to `data/logs/<step>-<timestamp>.log`.
- Timeouts: 3 times the estimate plus 10 minutes (scale with `--timeout-scale`).
- A concurrent run on the same data directory is refused (`data/.ingest.lock`).
- `--max-mb` (default 600) warns when a step's `est_peak_mb` or measured RSS exceeds it. `--min-free-gb` (default 5) refuses a step when free disk minus the step's estimated new disk use would fall below it.
- `--profile server`: `nice 10`, sequential, 1 s polite delay per host, raw caches pruned after each successful step (except steps marked `keep_raw`, or listed in `--keep-raw a,b`), unreachable sources tolerated. `--profile dev`: no nice, 0.5 s delay, caches kept.
- A step that fails with a network error is reported as `offline` with a message; for sources flagged flaky, or with `--tolerate-offline`, it does not fail the run. Rerun with `--resume` later.

## Shared HTTP helpers (`ingest/common.py`)

`get`, `get_json` and `download` retry with exponential backoff (429 and 5xx honour `Retry-After`), keep a per-host delay (`ESTADO_ABERTO_DELAY`, seconds) and send one User-Agent: `Estado-Aberto/1.0 (<contact>)`, where the contact comes from `ESTADO_ABERTO_CONTACT` (default the project URL). `get(..., cache=True, max_age_h=N)` caches responses under `data/cache/http/<host>/<sha1>`, falls back to the cache when the source is down, and `--refresh` (or `ESTADO_ABERTO_REFRESH=1`) bypasses it. `download(url, dest)` streams to a `.part` file and renames it. Jobs that keep their own per-job cache under `data/raw/<job>` and their own sleep still do; migrate them to these helpers when you touch them.

## Steps

All top-level scripts write into `data/politica.db`; the `stats` step finishes it. Jobs that read `politica.db` depend on `stats`.

| Step | Schedule | Needs | Network | Time (min) | RAM (MB) | Disk (MB) | Notes |
|---|---|---|---|---|---|---|---|
| `agenda` | daily | - | yes | 1 | 80 | 10 | Parliament calendar JSON and law steps. |
| `government` | daily | - | yes | 1 | 80 | 5 | President, ministers, parties from Wikipedia and Wikidata. |
| `news` | daily | - | yes | 2 | 80 | 15 | Presidency news items. |
| `contracts` | weekly | - | yes | 20 | 300 | 500 | Streams one JSON per year from dados.gov.pt (about 470 MB of raw cache). Pass years as args for a partial run. |
| `entities` | weekly | contracts | yes | 4 | 500 | 80 | Loads entidades.json (about 50 MB, roughly 400 MB in memory). |
| `localgov` | weekly | entities | yes | 3 | 150 | 5 | Wikidata SPARQL for municipalities and parishes. |
| `wd_institutions` | weekly | localgov | yes | 3 | 150 | 5 | Public bodies from Wikidata. |
| `reclassify` | weekly | wd_institutions | no | 2 | 200 | 5 | Rule-based classification of remaining unsorted bodies. |
| `aliases` | weekly | reclassify | no | 1 | 150 | 5 | Former names of renamed bodies. |
| `modifications` | weekly | contracts | yes | 6 | 250 | 60 | Contract modifications from dados.gov.pt. |
| `stats` | weekly | entities, localgov, wd_institutions, reclassify, aliases, modifications | no | 10 | 400 | 400 | Per-entity statistics and the FTS index; needs scratch space about the size of the index. |
| `anuncios` | weekly | stats | yes | 15 | 300 | 450 | Annual JSON streamed with raw_decode. |
| `ministerios` | daily | stats | yes | 8 | 250 | 40 | portugal.gov.pt sitemap and __NEXT_DATA__ pages. |
| `deputados` | daily | - | yes | 25 | 300 | 70 | parlamento.pt pages; incremental, refreshes entries older than DEPUTADOS_REFRESH_H. Flaky source. |
| `dre` | weekly | stats | yes | 70 | 250 | 150 | About 4000 detail requests per run at 1 req/s (DRE_DETAIL_MAX). |
| `autarquias` | weekly | stats | yes | 20 | 350 | 150 | MAI/SGMAI results site, many small requests. |
| `responsaveis` | daily | dre, ministerios, stats | yes | 55 | 300 | 40 | One 3000-request batch per run (RESP_MAX_REQ) until every holder is read; also runs the nomeacoes phases of responsaveis_nomeacoes.py. Flaky source. |
| `fundos` | weekly | stats | yes | 12 | 500 | 300 | Official xlsx files from dados.gov.pt. |
| `apoios` | weekly | stats, fundos | yes | 8 | 300 | 150 | PDF tables parsed with pdftotext via apoios_pdf.py; APOIOS_SKIP_ICA skips the slow part. |
| `votacoes` | weekly | dre, eleicoes | yes | 40 | 400 | 450 | parlamento.pt public pages. Flaky source. |
| `eleicoes` | bootstrap | autarquias, stats | yes | 25 | 250 | 100 | MAI/SGMAI results; ELEICOES_ONLY narrows the run. |
| `intervencoes` | weekly | deputados, votacoes | yes | 40 | 400 | 200 | Plenary transcript PDFs from parlamento.pt, cache-first and resumable; falls back to the cached index when the site is down. INTERV_MAX_REQ caps requests per run. Flaky source. |
| `posicoes` | weekly | intervencoes, votacoes | no | 1 | 200 | 5 | Derived from intervencoes and votacoes; topics in seed/posicoes_topicos.json. |
| `orcamento` | bootstrap | ministerios | yes | 30 | 700 | 1200 | Reads legacy .xls through the pure-Python BIFF reader in _xls.py, one workbook in memory at a time. |
| `presidencia` | weekly | dre, justica, votacoes | yes | 15 | 200 | 20 | PRESID_NO_FETCH=1 rebuilds from cache. |
| `justica` | weekly | dre, ministerios, stats | yes | 60 | 500 | 1000 | INE indicators, courts registry, Tribunal Constitucional and Tribunal de Contas documents. Visto 'resultado' is preserved across re-ingests. JUSTICA_ONLY selects phases. Flaky source. |
| `provedor` | weekly | - | yes | 8 | 150 | 50 | Honours robots.txt. |
| `reguladores` | weekly | dre, responsaveis, stats | yes | 40 | 250 | 25 | Runs dedupe_board (duplicate mandates) and dedupe_cases on every run. Flaky source. |
| `empresas_locais` | weekly | autarquias, responsaveis, stats | yes | 15 | 250 | 30 | DGAL Sector Empresarial Local. |
| `estado_empresas` | bootstrap | stats | yes | 10 | 300 | 30 | Argument 'docs' only rebuilds the document index. |
| `saude` | bootstrap | stats | yes | 20 | 250 | 60 | Honours robots.txt. |
| `seguranca` | bootstrap | autarquias, ministerios, stats | yes | 20 | 250 | 100 | INE indicators and ministry pages. |
| `regioes` | bootstrap | dre, eleicoes, stats | yes | 15 | 250 | 60 | Acores and Madeira official sites. |
| `educacao` | bootstrap | stats | yes | 40 | 600 | 1200 | Large zip/xlsx inputs (about 1.1 GB cache); EDU_STEPS selects phases. Use --prune-raw on small servers. |
| `dgeec` | bootstrap | autarquias | yes | 5 | 150 | 10 | Education statistics keyed by municipality. |
| `habitacao` | bootstrap | autarquias, dre, empresas_locais, fundos, votacoes, stats | yes | 45 | 500 | 1200 | INE, RNAL, PRR, contracts and housing laws; HAB_STEPS selects phases. Roughly 1.1 GB cache. |
| `ine_series` | weekly | autarquias | yes | 25 | 300 | 300 | INE indicator JSON, honours robots.txt. |
| `imigracao` | bootstrap | - | yes | 5 | 150 | 15 | INE indicators and AIMA registry. |
| `igf` | weekly | stats | yes | 15 | 150 | 60 | Honours robots.txt. |
| `divida` | weekly | - | yes | 1 | 100 | 5 | Downloads the IGCP xlsx files itself. |
| `population` | weekly | autarquias, stats | yes | 1 | 150 | 5 | Censos 2021 population; needs autarquias. |
| `ar_opendata` | weekly | agenda | yes | 5 | 150 | 20 | Official initiative steps and votes; the feed is often unreachable and the step then reports offline. Flaky source. |
| `risco` | weekly | anuncios, autarquias, stats | no | 10 | 600 | 400 | Derived from contracts and announcements; no downloads. |
| `risco_eval` | manual | risco | no | 1 | 200 | 5 | Precision report against docs/risco_labels.csv; --template creates the labelling sheet. |

Licence and terms of every source are in `docs/SOURCES.md`; the `licence` field of each manifest entry points at its row.

## Known flaky or restrictive sources

- `parlamento.pt` (deputados, votacoes, intervencoes): slow, intermittently times out, rate sensitive. `intervencoes` is cache-first: cached PDFs are never refetched, the discovered index is reused when the site is down, and rerunning continues where it stopped (`INTERV_MAX_REQ` caps requests per run).
- `ine.pt`: answers 403 to some clients; indicator JSON endpoints are rate limited. `ine_series`, `justica`, `seguranca` and `imigracao` honour robots.txt and sleep between calls.
- `dados.gov.pt`: occasional 5xx on large resources; retries handle most of it. Dataset file URLs carry timestamps, so they are always resolved through the API.
- `diariodarepublica.pt`: needs a CSRF token session; `dre` caps detail requests per run (`DRE_DETAIL_MAX`).
- `www.igcp.pt`: the statistics page URL has moved before; `divida` falls back to the home page links.
- `ar_opendata` (parlamento open data feed): frequently unreachable.
- Wikidata SPARQL: throttles heavy queries; rerun later.

## Resuming and recovering

- Rerun the same command with `--resume`; finished fresh steps are skipped.
- `python3 ingest/run_all.py --only <step> --no-deps` reruns one step. Individual jobs also run directly from `ingest/`: `python3 jobs/divida.py`.
- A killed run leaves `.part` files and a stale lock only while the process lives; the lock is released by the OS.
- Reingest never discards manual review state: `justica` preserves the Tribunal de Contas visto `resultado` across re-ingests, and `reguladores` runs `dedupe_board` on every run.

## Production sizing (1 GB RAM, 2 vCPU, 40 GB SSD)

Use `--profile server`. Only `orcamento` (700 MB), `educacao` (600 MB) and `risco` (600 MB) approach the 600 MB default; run those with the web server stopped or lower `--max-mb` after measuring on the box. Peak RSS and disk delta of every run are in `data/.ingest_state.json`. The `stats` step needs scratch space of the order of the FTS index.

## Adding a step

1. Write `ingest/jobs/<name>.py` with a `NAME`, `DB = DATA_DIR / f"{NAME}.db"` and `RAW = DATA_DIR / "raw" / NAME` (import `DATA_DIR`, `UA`, `get`, `download` from `common`), a `main()` and an `if __name__ == "__main__"` guard. Exit non-zero on failure. Stream large downloads and commit in bounded batches.
2. Add an entry to `ingest/jobs.json`: `name`, `script`, `depends` (including `stats` when it reads `politica.db`), `produces`, `network`, `est_minutes`, `est_peak_mb`, `est_disk_mb`, `schedule`, `enabled`, `fresh_days`, `raw`, `keep_raw`, `flaky`, `licence`, `notes`. Measure estimates from `data/.ingest_state.json` after a run into a temporary data dir.
3. Add the source row to `docs/SOURCES.md` with its licence.
4. Check: `python3 ingest/run_all.py --list`, `--dry-run --only <name>`, then a small real run with `ESTADO_ABERTO_DATA=$(mktemp -d)`.
