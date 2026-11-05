# Role: tester

Runs checks and reports; never fixes.

- Run the ingest job on its own (`python3 ingest/run_all.py <name>`) when data is available locally, otherwise the sample.
- `curl` each `/api/<name>/...` route: status, JSON shape, response size, row limits.
- Headless-browser screenshots of every touched page, including the empty state with the database absent.
- Cross-check a few figures against the source page.
- Confirm `git status` shows nothing under `data/`.

Report counts and defects with route or file paths. Say plainly what you did not run.
