# Client performance

How the browser side loads and why it feels instant. Server side (compression, ETag, boot payload, Link hints) is in `docs/PERFORMANCE.md`.

## What the client does

- Five deferred scripts on first load (`routes.js`, `app.js`, `portal.js`, `edicao.js`, `boot.js`) and two stylesheets (`style.css`, `edicao.css`). Before: 14 scripts, `story.css`, and a sequential fetch of all 30 `modules/*.js`.
- `routes.js` is the route manifest: route -> module file, modules that register entity-page hooks, modules that decorate another page (`intervencoes.js` on `#/votacoes` and `#/deputados`), story slugs, and the API calls each route makes first (`data`). `Portal.page(...)` still registers pages; the manifest only says which file to load. A module missing from the manifest is picked up after idle through `/api/modules` (the old behaviour), so `tools/new_module.py` keeps working; add the route to `routes.js` to get lazy loading and prefetch for it.
- Lazy per route: modules load on first visit. `story-morphs.js`, `story-engine.js`, `story.css` and `historias/<slug>.js` load only on `#/historia/...`. `novidades.js` loads only on `#/painel-classico`. The 20 hook modules load on `#/entidade/...`.
- The menu is built synchronously from `NAV_GROUPS` and the manifest, with no network wait.
- Home from `window.__EA_BOOT["/api/edicao/dia"]` when the server fills the `<!--EA-BOOT-->` marker. Without it a head script starts the `/api/edicao/dia` fetch before the scripts arrive. Both paths feed the same cache in `api()`.
- `api()` caches GET responses in memory and `sessionStorage` (45 s fresh, then stale-while-revalidate; a changed response re-renders the current route once, not while a form field has focus). `follows`, `feed`, `search` and `modules` are never cached.
- Prefetch: hover, focus and `touchstart` on any `#/` link load the route's code and its seed API calls; links entering the viewport prefetch code only, on idle, skipped on save-data and 2g. `?prefetch=0` turns it off (used by the benchmark).
- Skeletons: `index.html` ships a fixed-size skeleton and a plate placeholder (no layout shift); navigation shows a skeleton immediately when code or data are not in memory, and renders straight away when they are. Footer stays hidden while a skeleton shows.
- Navigation uses the View Transitions API when present and the route is ready (`prefers-reduced-motion` off); the masthead has its own transition name so it never fades. No fallback needed.
- Fonts: `fraunces-latin-600-normal.woff2` and `Lora-Regular.woff2` are preloaded; `font-display: swap`. `Lora-SemiBold.woff2` is not referenced by any CSS.
- `content-visibility: auto` on the below-the-fold blocks of the Edição (`.band`, `.band2`, `.colophon`).
- Version: `<meta name="ea-version">` (server fills it later; fallback `version` in `routes.js`, now `0.1.1`) is appended as `?v=` to every script and stylesheet the client injects. Static tags in `index.html` carry no `?v=`.

## Service worker (`public/sw.js`)

- `VERSION` constant -> cache `ea-<VERSION>`; bump it together with `VERSION`/`package.json` on release. Old caches are deleted on activate; `skipWaiting` + `clients.claim`.
- Precache: `/`, `/offline.html`, both stylesheets, `routes.js`, `app.js`, `portal.js`, `edicao.js`, `boot.js` and the two fonts.
- `?v=` URLs and fonts: cache-first. Other static files: stale-while-revalidate.
- GET `/api/*`: stale-while-revalidate; requests with `x-ea-revalidate` (the client's background refresh) go network-first. `/api/follows`, `/api/feed`, `/api/search` and every non-GET are not intercepted.
- Navigation: cache-first with background update, so a repeat visit paints at once whatever the network. The worker adds `window.__EA_AGE` (milliseconds since that HTML was cached) so the client treats the inlined boot data as stale after 45 s and refreshes it. With nothing cached: network, then `offline.html` (Portuguese).
- Registered after `load` and idle; `?sw=0` disables registration.

## Measuring

`node tools/perf_client.mjs --base http://127.0.0.1:3170 --label after --out after.json` drives `/usr/bin/chromium` over a raw CDP WebSocket (Node 22 built-in `WebSocket`, no dependencies). For `/`, `#/igf`, `#/historia/parlamento` and `#/votacoes`, under slow 4G (1.6 Mbit/s, 150 ms RTT) and fast 3G (1.6 Mbit/s, 562 ms RTT), cold (empty profile) and warm (same profile after the worker installed, service worker active and throttled too), it reports transferred bytes, requests, TTFB, FCP, LCP, content time (first non-skeleton render of `#app`), total blocking time and long tasks, CLS, and JS executed/parsed bytes from precise coverage. JS+CSS gz is computed with zlib level 9 over the decoded bodies, so it does not depend on server compression. A navigation test clicks five menu entries (`igf`, `votacoes`, `deputados`, `orcamento`, `ministerios`) with real mouse events on slow 4G, with and without hover prefetch, and measures click to first render of the destination page. Flags: `--only home,igf`, `--no-load`, `--no-nav`, `--cpu 4` (CPU throttle), `--verbose` (resource timeline).

Notes: the page-level throttle does not reach the service worker, so the tool attaches to the worker target and throttles it too. Click-to-render is the first render of the destination (its `h1` differs from the previous page and `#app` holds text), not the last async decoration. "Before" is `v0.1.1` (worktree) on a server without compression, so its transferred bytes equal raw bytes; "after" runs on the current server with brotli/gzip.

## Results (sample data, headless Chromium 155, no CPU throttle)

### Before: v0.1.1

| page | net | cache | transferred KB | JS+CSS gz KB | requests | TTFB | FCP | LCP | content | TBT ms (long tasks) | CLS | JS exec/parsed KB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| home | slow4g | cold | 983.7 | 286.9 | 55 | 2 | 1280 | 10292 | 10260 | 0 (0) | 0.379 | 134.7/801.3 |
| home | slow4g | warm | 47.6 | 286.9 | 55 | 2 | 396 | 6104 | 6073 | 0 (0) | 0.379 | 134.7/801.3 |
| igf | slow4g | cold | 977.3 | 286.9 | 55 | 2 | 1288 | 10244 | 10223 | 0 (0) | 0.106 | 127.3/801.3 |
| igf | slow4g | warm | 41.3 | 286.9 | 55 | 2 | 396 | 6052 | 6031 | 0 (0) | 0.106 | 127.3/801.3 |
| historia | slow4g | cold | 962 | 286.9 | 54 | 2 | 1292 | 10172 | 0 | 0 (0) | 0.008 | 152.2/801.3 |
| historia | slow4g | warm | 25.9 | 286.9 | 54 | 2 | 400 | 5984 | 0 | 0 (0) | 0.008 | 152.2/801.3 |
| votacoes | slow4g | cold | 1006.6 | 286.9 | 55 | 2 | 1320 | 10508 | 9912 | 0 (0) | 0.127 | 130.8/801.3 |
| votacoes | slow4g | warm | 70.5 | 286.9 | 55 | 2 | 396 | 6312 | 5713 | 0 (0) | 0.127 | 130.8/801.3 |
| home | fast3g | cold | 983.7 | 286.9 | 55 | 2 | 1912 | 25204 | 25173 | 0 (0) | 0.379 | 134.7/801.3 |
| home | fast3g | warm | 47.6 | 286.9 | 55 | 2 | 1212 | 21412 | 21381 | 0 (0) | 0.379 | 134.7/801.3 |
| igf | fast3g | cold | 977.3 | 286.9 | 55 | 2 | 1908 | 25140 | 25120 | 0 (0) | 0.106 | 127.3/801.3 |
| igf | fast3g | warm | 41.3 | 286.9 | 55 | 2 | 1212 | 21376 | 21358 | 0 (0) | 0.106 | 127.3/801.3 |
| historia | fast3g | cold | 962 | 286.9 | 54 | 2 | 1912 | 25076 | 0 | 0 (0) | 0.008 | 152.2/801.3 |
| historia | fast3g | warm | 25.9 | 286.9 | 54 | 2 | 1224 | 21304 | 0 | 0 (0) | 0.008 | 152.2/801.3 |
| votacoes | fast3g | cold | 1006.6 | 286.9 | 55 | 2 | 1904 | 25824 | 24397 | 0 (0) | 0.127 | 130.8/801.3 |
| votacoes | fast3g | warm | 70.5 | 286.9 | 55 | 2 | 1216 | 22056 | 20625 | 0 (0) | 0.127 | 130.8/801.3 |


Menu click to first render, slow 4G, median of 5: **232 ms** without prefetch, **226 ms** with (v0.1.1 has no prefetch; every module is already loaded, only data is fetched).

### After

| page | net | cache | transferred KB | JS+CSS gz KB | requests | TTFB | FCP | LCP | content | TBT ms (long tasks) | CLS | JS exec/parsed KB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| home | slow4g | cold | 107.5 | 47.8 | 15 | 2 | 804 | 876 | 940 | 0 (1) | 0 | 62.9/126.8 |
| home | slow4g | warm | 0.3 | 47.8 | 14 | 3 | 64 | 120 | 0 | 0 (0) | 0 | 62.8/126.8 |
| igf | slow4g | cold | 112.4 | 49.8 | 17 | 2 | 792 | 1192 | 1171 | 0 (0) | 0 | 55.9/131.7 |
| igf | slow4g | warm | 0.3 | 49.8 | 14 | 3 | 80 | 116 | 94 | 0 (0) | 0 | 55.6/131.7 |
| historia | slow4g | cold | 137.2 | 75.9 | 19 | 2 | 812 | 1340 | 0 | 0 (0) | 0 | 88.5/202.1 |
| historia | slow4g | warm | 0.3 | 75.9 | 18 | 4 | 84 | 140 | 0 | 0 (0) | 0 | 88.2/202.1 |
| votacoes | slow4g | cold | 124.4 | 60.7 | 18 | 2 | 792 | 1400 | 1013 | 0 (0) | 0.114 | 70.6/164.2 |
| votacoes | slow4g | warm | 0.3 | 60.7 | 15 | 4 | 64 | 128 | 72 | 0 (0) | 0 | 70.2/164.3 |
| home | fast3g | cold | 107.5 | 47.8 | 15 | 2 | 1776 | 2028 | 2514 | 0 (0) | 0 | 62.9/126.8 |
| home | fast3g | warm | 0.3 | 47.8 | 14 | 4 | 64 | 124 | 0 | 0 (0) | 0 | 62.8/126.8 |
| igf | fast3g | cold | 112.4 | 49.8 | 17 | 2 | 1752 | 3160 | 3137 | 0 (0) | 0 | 55.9/131.7 |
| igf | fast3g | warm | 0.3 | 49.8 | 14 | 3 | 80 | 112 | 92 | 0 (0) | 0 | 55.6/131.7 |
| historia | fast3g | cold | 137.1 | 75.9 | 19 | 2 | 1772 | 3320 | 0 | 0 (0) | 0 | 88.5/202.1 |
| historia | fast3g | warm | 0.3 | 75.9 | 18 | 3 | 64 | 136 | 0 | 0 (0) | 0 | 88.2/202.1 |
| votacoes | fast3g | cold | 124.4 | 60.7 | 18 | 2 | 1784 | 3792 | 2588 | 0 (0) | 0.114 | 70.6/164.2 |
| votacoes | fast3g | warm | 0.3 | 60.7 | 15 | 3 | 76 | 132 | 76 | 0 (0) | 0 | 70.2/164.3 |


Menu click to first render, slow 4G, median of 5: **376 ms** without prefetch (code and data fetched on click), **60 ms** with hover prefetch.

## Targets

| Target | Result |
|---|---|
| Home first load JS+CSS < 150 KB compressed | 47.8 KB gz (v0.1.1: 286.9 KB) |
| FCP < 1.2 s on slow 4G | 0.80 s (v0.1.1: 1.28 s) |
| Repeat visit < 0.3 s | FCP 64 ms slow 4G, 64 ms fast 3G (v0.1.1: 396 ms / 1212 ms) |
| Prefetched menu transition < 100 ms | 60 ms median, 91 ms worst |

Other changes: requests on first load 55 -> 15, JS parsed 801 KB -> 127 KB, home LCP 10.3 s -> 0.88 s on slow 4G, CLS 0.379 -> 0. The remaining CLS on `#/votacoes` (0.114) is the page growing under a visible footer.

