# Contributing to Estado Aberto

Thank you for helping. Read `docs/DATA_POLICY.md` first: no real data is ever committed, attached to a PR or release, or uploaded to any server. You contribute code and a documented recipe; whoever needs data runs the ingest tools.

## Setup

Requires Node 22.5 or newer and Python 3.10 or newer. No dependencies to install.

```sh
git clone https://github.com/Mais-Democracia/Estado-Aberto.git
cd Estado-Aberto
python3 tools/make_sample.py
npm start
```

This gives a synthetic demo at http://localhost:3000. For real data run `python3 tools/bootstrap.py` and `python3 ingest/run_all.py`; see the README for time and disk.

## Branch and PR flow

1. Fork or branch from `main`. One topic per branch.
2. Keep commits small and focused.
3. Run the checks below.
4. Open a PR against `main` using the template. Link the issue with `Closes #N.` in the commit or PR.
5. A maintainer or the module owner (see `.github/CODEOWNERS`) reviews. Address comments with new commits; the maintainer squashes or rebases on merge.

## Commit format

`Location: Description.`

Location is the module, class or path that changed (`igf`, `Portal.nav`, `server/modules/dre`, `docs/SOURCES.md`). The description is a short sentence ending in a full stop. Add `Closes #N.` when it resolves an issue.

```
igf: Add municipality filter to the report list. Closes #42.
```

Never put secrets, personal paths, personal emails or tool names in commit messages.

## Checks to run

```sh
npm run check
python3 tools/make_sample.py && npm start
python3 -m py_compile ingest/jobs/<name>.py
node --check server/modules/<name>.mjs
node --check public/modules/<name>.js
```

Smoke-test the sample server: open the page you touched, and `curl` your `/api/<name>/...` routes. UI changes need a screenshot (below).

## Add a data source or module end to end

1. Open a "New data source" issue and wait for a go-ahead, or check that the source is already in `docs/BACKLOG.md`.
2. Verify the source: `curl -I` the URL, read `robots.txt` and the terms, note the licence.
3. `python3 tools/new_module.py <name> --section <section>`. It creates `ingest/jobs/<name>.py`, `server/modules/<name>.mjs`, `public/modules/<name>.js`, a manifest entry in `ingest/jobs.json` and a menu entry.
4. Fill in the ingest job. Stream downloads, write only `data/<name>.db` in WAL mode, store `source_url` on every row, link entities by NIF.
5. Fill in the server routes: prefix `/api/<name>/`, indexed queries, `LIMIT`ed, plain JSON.
6. Fill in the page: escape dynamic text, show an honest empty state when the database is missing.
7. Add the source to `docs/SOURCES.md` (URL, publisher, licence, update frequency, coverage, known gaps, size/time/RAM) and update `docs/BACKLOG.md`.
8. Run the checks and attach screenshots made from the synthetic sample or from your local run, never data files.

Rules for modules are in `docs/MODULES.md`.

## Propose a roadmap item

Open a "Roadmap suggestion" issue, or add a line to `docs/BACKLOG.md` with a source URL you checked. The process is in `docs/ROADMAP_PROCESS.md`.

## Review expectations

- Reviewers check figures against the source, units, cumulative versus annual mix-ups, empty states, escaping and the resource budget.
- Expect a response within about a week. Small PRs are reviewed faster.
- A PR that adds a source without a recipe, licence status or source citation is sent back.

## Screenshots for UI changes

Attach before/after screenshots to the PR. Use a headless browser against the sample server, for example `chromium --headless --screenshot=out.png --window-size=1280,900 http://localhost:3000/#/<page>`. Screenshots of real data are fine as images of a page; never attach the data itself.

## Honesty rules

- Real data only on real pages. Synthetic data only in the sample, and labelled.
- No invented numbers. If a source is unreachable or has a gap, say so on the page (`<p class="note warn">`).
- Cite sources: every figure and row links to its `source_url`.
- Honest empty states: say what is missing and why.
- Write UI text in Portuguese.

## Code style

Standard library only: no new npm or pip dependencies. No explanatory comments in code; a short comment is fine only for a non-obvious reason such as a unit, an issue number or the bug a workaround dodges. Respect the resource budget in `docs/ARCHITECTURE.md`.

By contributing you agree your code is released under the MIT licence. Be kind: see `CODE_OF_CONDUCT.md`.
