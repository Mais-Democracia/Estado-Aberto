---
name: new-data-module
description: Add a new public data source end to end as an ingest job, API module and page.
---

# new-data-module

## When to use
A new public source should become a page in one of the seven sections.

## Steps
1. Verify the source: `curl -I <url>`, read `robots.txt` and the terms, note licence, format, frequency, reachability.
2. Estimate size, time and peak RAM. The production box has 1 GB RAM; the job must stream.
3. `python3 tools/new_module.py <name> --section <parlamento|governo|dinheiro|poder-local|instituicoes|leis-justica|indicadores>`.
4. Fill `ingest/jobs/<name>.py`: polite requests, cache in `data/raw/<name>/`, WAL, small commits, `source_url` on every row.
5. Fill `server/modules/<name>.mjs`: `/api/<name>/...`, indexed, `LIMIT`ed, `{ available: false, note }` when the database is missing.
6. Fill `public/modules/<name>.js`: escape dynamic text, Portuguese text, honest empty state, cite the source.
7. Add the source and its recipe to `docs/SOURCES.md`; update `docs/BACKLOG.md`.

## Checks
`py_compile`, `node --check` on all three files, `npm run check`, smoke test on the synthetic sample, screenshot. Nothing under `data/` is staged.
