# AGENTS.md

Canonical, tool-neutral guide for AI coding agents working in this repository. Humans should read `CONTRIBUTING.md`; the rules are the same.

## RULE ONE: DATA POLICY

**No real data is ever committed, attached to a PR or release, or uploaded to any server.** The repo ships only code, schemas, synthetic sample generators and documentation. Anyone who needs data runs the ingest tools (`tools/bootstrap.py`, `ingest/run_all.py`) against the public sources. If you build something that needs new data, contribute the code plus a documented recipe (what to download, from where, how to run, licence and robots status, expected size/time/RAM). The production server updates itself by running the released tools; you never send it data. Full text: `docs/DATA_POLICY.md`. Never stage anything under `data/`.

## Mission

Estado Aberto is a Portuguese open-data "democracy journal": decisions, votes, laws, reports, audits, appointments and speeches, with money as one section. Real, sourced, linked public records, with honest empty states.

## Repo map

| Path | What |
|---|---|
| `server.mjs` | dependency-free Node 22 server, routes, static files |
| `server/modules/*.mjs` | one API module per data domain (`/api/<name>/...`) |
| `ingest/jobs/*.py` | one Python 3 stdlib ingest job per domain, writes `data/<name>.db` |
| `ingest/jobs.json` | job manifest read by `ingest/run_all.py` |
| `ingest/common.py` | shared helpers; do not edit from a module |
| `public/` | vanilla JS client, hash routes (`#/<page>`) |
| `public/modules/*.js` | one page module per domain |
| `public/portal.js` | portal core and `Portal.NAV_GROUPS` (seven sections plus Roadmap) |
| `public/historias/` | scrollytelling stories; engine in `docs/STORY_ENGINE.md` |
| `tools/` | `make_sample.py`, `bootstrap.py`, `new_module.py`, checks |
| `docs/` | architecture, modules, sources, roadmap, backlog |
| `data/` | gitignored runtime SQLite and raw downloads |

Sections: Parlamento, Governo, Dinheiro público, Poder local, Instituições, Leis e justiça, Indicadores.

## Commands

```sh
python3 tools/make_sample.py
npm start
npm run check
python3 ingest/run_all.py <job>
python3 tools/new_module.py <name> --section <section>
python3 -m py_compile ingest/jobs/<name>.py
node --check server/modules/<name>.mjs public/modules/<name>.js
```

Work from the repo root.

## Resource budget

Production is a small cloud box: 1 GB RAM, 2 vCPU, 40 GB SSD. This is a design constraint: lean memory, streaming ingest (never load a multi-GB file into memory), sequential jobs, no heavy dependencies, bounded responses (always `LIMIT`, paginate). Prefer indexed SQLite queries over loading tables into JS.

## Add or extend a module

1. Check `docs/BACKLOG.md` and `docs/SOURCES.md`; verify the source URL with `curl -I` and read its `robots.txt` and terms.
2. `python3 tools/new_module.py <name> --section <section>`.
3. Implement the ingest job: stream, polite (project UA, cache, sleep per host), WAL mode with `timeout>=60`, small commits, `source_url` on every row, NIF links.
4. Implement `/api/<name>/...` routes: indexed, `LIMIT`ed, plain JSON, handle missing database with `{ available: false, note }`.
5. Implement the page with `Portal.page`; escape dynamic text with `Portal.esc`; honest empty state.
6. Document in `docs/SOURCES.md`; update `docs/BACKLOG.md`.
7. Verify (below). Rules in `docs/MODULES.md`. Do not edit `server.mjs`, `public/app.js` or `ingest/common.py` from a module.

## Verify

1. `npm run check`, `py_compile` and `node --check` on touched files.
2. `python3 tools/make_sample.py`, start the server on a free port, `curl` each route you touched and confirm JSON shape and bounded size.
3. Headless-browser screenshot of each touched page (`chromium --headless --screenshot`); look at it.
4. Confirm `git status` shows nothing under `data/`.

Report counts and defects honestly; a check you did not run is not a pass.

## Coding rules

- Standard library only (Node built-ins, Python stdlib). No new dependencies.
- No comments, except a short one for a non-obvious reason (unit, issue number, workaround).
- UI text in Portuguese.
- Honest empty states; say what is missing and why.
- Real data only on real pages; never invent numbers; cite sources (`source_url`).
- Respect the resource budget.
- Follow the style of neighbouring files; small modules such as `igf` are good examples.

## Commits and PRs

- Format `Location: Description.` with Location = module, class or path; add `Closes #N.` when relevant.
- Commit only your own paths.
- No secrets, personal paths, emails or hostnames anywhere.
- Never mention the tooling that produced a change in commits, PRs, code or docs.
- PR body: what the change adds and how to use it, plus the checklist in `.github/PULL_REQUEST_TEMPLATE.md`.

## Roadmap and backlog

`docs/ROADMAP.md` is the public page: "Em curso", "A seguir", "Feito". `docs/BACKLOG.md` is the working list of checkboxes (`[ ]` open, `[~]` in progress, `[x]` done) with notes on gaps and next steps. When you finish an item, tick it and record what shipped, what was verified and the remaining gaps. Process in `docs/ROADMAP_PROCESS.md`.

## Suggesting new things

Use the issue templates (`.github/ISSUE_TEMPLATE/`) or add a backlog line that includes a source URL you verified with `curl` and a `robots.txt` check. Do not add unverified sources.

## Do not touch

- `ops/` unless explicitly asked.
- Release workflow and release files.
- `data/`, anything generated.
- `server.mjs`, `public/app.js`, `ingest/common.py` from within a module task.

## Server and release flow: agents never deploy and never upload data

Agents never deploy, never log in to or send files to any server, never trigger or edit the release flow, and never upload data. Releases are cut by maintainers. The production server updates itself by running the released tools. A future server-side AI workflow area (`ops/ai/`) is described in `docs/ARCHITECTURE.md` as planned and is not implemented; even then it must not be able to ship data or reach deploy credentials.

## Multi-agent workflow

Roles (`.agents/roles/`): scout, architect, implementer, tester, reviewer. Skills (`.agents/skills/`): new-data-module, propose-roadmap-item, verify-change, write-story-scene. Workflow in `docs/AGENT_WORKFLOW.md`.
