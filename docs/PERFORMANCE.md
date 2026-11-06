# Performance

## Architecture

- The main thread only serves static files and cached API results. Every `/api/*` route (including the plug-in modules) is executed by one `worker_threads` worker with its own lazily opened read-only SQLite connections (`resourceLimits.maxOldGenerationSizeMb: 120`). `ESTADO_ABERTO_NO_WORKER=1`, or a missing `worker_threads`, runs the same code in-thread.
- Protocol: main posts `{id, kind, method, path, query, body, fresh}`, the worker answers `{id, code, user, ms, body}` with the JSON as a transferred `Uint8Array`. One job is in flight at a time (the worker is synchronous), so at most one request per route family reaches it; the rest wait in a bounded priority queue (128 interactive, 32 background, overflow answers `503` with `Retry-After`). Identical concurrent requests are coalesced onto one job; an interactive request promotes a queued background job.
- A request that cannot be answered from cache waits up to 6 s for the worker, then gets `202 {"status":"carregando","retry_after":2}` with `Retry-After: 2` and the job keeps running and fills the cache. A running job is terminated by the watchdog only after `ESTADO_ABERTO_WORKER_TIMEOUT_MS` (default 600000 ms); every kill logs the route and elapsed ms, and a crashing worker logs its stack. A failed or killed job for a route is not resubmitted for 30 s, 2 min, 10 min, then 30 min (cap), and requests during that time get `202` with `Retry-After: 15`. The worker thread runs at nice 10 (`ESTADO_ABERTO_WORKER_NICE`) with `cache_size` 1 MB, `mmap_size` 0 and `temp_store` file.
- Results are cached in memory (LRU, 24 MB) and, when the computation took 300 ms or more (or the route is a warm seed), in `$ESTADO_ABERTO_DATA/cache/<sha1(route?query)>.json` (override with `ESTADO_ABERTO_CACHE`). Each file records the source database `size:mtime` signature and a code stamp (VERSION and mtime of `server.mjs` and `server/modules/*`). A restart serves the previous result at once; if the signature changed, or it is older than 10 min, it is served stale and refreshed in the worker in the background (`fresh` bypasses the in-worker memos of 1 h or less). Light results older than 30 s are refreshed the same way; older than 5 min they are recomputed.
- Background refresh: one job every 5 s at most, only when the worker is idle, seeds first (`/api/overview`, `/api/changes`, `/api/contracts`, `/api/edicao/dia`, every `*/overview`), then stale hot entries used in the last 6 h, then the status counts.
- `/api/status` never touches a database on the main thread: presence, size and mtime come from an `fs.stat` scan every 10 s; row counts come from the worker at most every 30 min (`COUNT(*)` below 64 MB, `MAX(rowid)` above, flagged `approx`) and are persisted in `cache/_status.json`. Until the first counts arrive modules report `pending: true` and `available` reflects file presence. Answers in a few ms.
- Responses that touched `user.db` (`/api/follows`, `/api/feed`, `/api/entity`, `/api/initiative`) and all writes are `Cache-Control: no-store` and never cached.

## HTTP

- gzip, and brotli when accepted, for html, js, css, json and svg over 860 bytes, compressed asynchronously (libuv pool, never on the loop). Static: brotli quality 5, API JSON: quality 4. Compressed variants are cached with the body (static 20 MB LRU, API 24 MB LRU). `Vary: Accept-Encoding`.
- Strong ETag (content hash, `-br`/`-gz` suffix per encoding) and `304`.
- Static: `public, max-age=3600, stale-while-revalidate=86400`; URLs with `?v=` get `public, max-age=31536000, immutable`; HTML `no-cache`. API GET: `public, max-age=30, stale-while-revalidate=300`; `/api/status`: `max-age=10`; errors, `202`, user-specific and writes: `no-store`. The `Date` header is the standard Node one on every response.
- `Link: rel=preload` for the first stylesheet and first three scripts of `index.html`, plus a `103 Early Hints` (disable with `ESTADO_ABERTO_EARLY_HINTS=0`).
- Boot payload: if `index.html` contains `<!--EA-BOOT-->` it is replaced by `<script>window.__EA_BOOT={"/api/edicao/dia":<json>}</script>` when `/api/edicao/dia` (no query) is already cached, else by nothing. `</script`, `<!--`, U+2028 and U+2029 are escaped.
- `keepAliveTimeout` 65 s, `headersTimeout` 66 s, `requestTimeout` 70 s, socket idle timeout 120 s. `Server-Timing: app;dur=…, db;dur=…, cache;desc=…`. Requests over 500 ms are logged: `slow GET /route 987ms status=200 cache=miss db=984ms`.
- `ESTADO_ABERTO_DEBUG=1` exposes `/api/_perf` (event-loop delay histogram, memory of main and worker, queue and cache sizes; `?reset=1`, `?warm=1` queues a refresh of every hot route).

## Benchmark

`node tools/bench.mjs --port 3160 --data <dir> [--duration 40] [--clients 20] [--server <server.mjs>]` starts the server, hammers `/`, `/app.js` and ten API routes with 20 clients while a warm cycle runs (cold start plus `?warm=1` after 3 s), and checks event-loop lag max < 100 ms, p95 of `/` and `/api/status` < 50 ms and no 5xx. Event-loop lag is measured inside the main thread by a preloaded `monitorEventLoopDelay` (resolution 5 ms, so the reported lag is max minus 5 ms), so it is comparable with older servers. For real data it uses a throw-away cache dir, so the data directory is only read.

Measured on the development PC (12 cores), v0.1.1 against this change, cold start, 20 clients:

| data | server | duration | event-loop lag max | p95 `/` | p95 `/api/status` | worst request | RSS process |
|---|---|---|---|---|---|---|---|
| synthetic sample | v0.1.1 | 15 s | 64.6 ms | 5.2 ms | 5.1 ms | 108 ms | 140 MB |
| synthetic sample | worker | 15 s | 3.4 ms | 7.1 ms | 6.0 ms | 88 ms | 120 MB |
| real (17 GB) | v0.1.1 | 60 s | 8052 ms | 266.7 ms | 91.7 ms | 19.3 s | 139 MB |
| real (17 GB) | worker | 90 s | 3.8 ms | 7.2 ms | 5.6 ms | 6.0 s (first `202`) | 155 MB peak at ~4800 req/s |

On real data, restarting with the persisted cache answers `/api/seguranca/overview` and `/api/edicao/dia` in 1 to 5 ms; cold, `/api/seguranca/overview` computes in 0.99 s in the worker while `/` and `/api/status` stay at 2 to 5 ms.

Memory, real data, idle after a warm cycle: process RSS 134 MB, of which the main-thread JS heap is 7 MB (+4 MB external) and the worker heap 16 MB (peak 22 MB, limit 120 MB). The remainder is native (Node runtime, SQLite page caches, threads share one RSS). The production unit runs with `--max-old-space-size=256`.

## Edition bytes read

`/api/edicao/dia` for the latest date on the production-size data (politica.db 3.5 GB), counted as `rchar` from `/proc/self/io` (includes cached reads, so it is a proxy for cold-disk cost), 1 MB page cache per connection.

| Query | Before | After |
|---|---|---|
| Local-government contracts of the week (`contracts` joined to `entities`) | 3547 MB | 21 MB |
| Most active municipality of the week | 2815 MB | 21 MB |
| All other queries | 41 MB | 42 MB |
| Total | 6404 MB, 3.7 s warm | 84 MB, 0.1 s warm |

The planner drove the join from `entities(kind)` and then walked every buyer's contracts; `CROSS JOIN` fixes the order so the week is selected through `contracts_published_cov` first. When that index is missing (databases built before it existed) contract queries are bounded to `signed` within 90 days of the window (103 MB total). If the computation exceeds `ESTADO_ABERTO_EDITION_BUDGET_MS` (default 45000) the optional blocks (local government, biggest direct award, sparklines, a year ago) are skipped and the edition carries `"partial": true`; it is cached for 60 s instead of 10 min.

## Daily edition (ledger)

`/api/edicao/dia?data=D&vista=resumo|tudo` reads `diario.db` (ledger) when it holds an edition for D, else falls back to the data-derived generator flagged `fonte: "legado"`. Both views are ordinary cached API entries (disk-persisted, invalidated by the `diario.db` size and mtime through the database signature). `/api/edicao/dia` (the boot payload, resumo view) and `/api/edicao/dia?vista=tudo` are seeded and refreshed by the background warmer, so switching to the full list is served from cache. The client prefetches the `vista=tudo` payload on idle, which makes the view switch instant. Measured warm on the synthetic ledger: `/`, `/api/edicao/dia`, `/api/edicao/dia?vista=tudo` and `/api/edicao/artigo?id=` all answer in under 1 ms. Dates before 2026-11-06 return `{sem_edicao: true}`; `ESTADO_ABERTO_TODAY` overrides the edition clock for tests. The article payload (`blocos`, `explicacao`) is parsed and validated in the handler and cached like any other entry; the ledger `ia` cards add two small objects per article. Item routes are resolved in the handler (`rotaObjeto`) from columns already selected, so the edition adds no queries; the `PRAGMA table_info(artigos_ia)` lookup runs once per process.
