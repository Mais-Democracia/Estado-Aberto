# Multi-agent workflow

How work moves when several coding agents (and humans) share the repository. Role prompts are in `.agents/roles/`, task recipes in `.agents/skills/`, the rules in `AGENTS.md`.

## Pipeline

scout -> architect -> implementer -> tester -> reviewer

1. **Scout** (cheap, read-only): checks recent commits, backlog state and the running sample server; smoke-tests routes and takes screenshots. Reports only what is wrong, empty, slow, misleading or ugly, under 150 words.
2. **Architect** (strong): picks the highest-value open `docs/BACKLOG.md` item (data coverage first). Plans before code if the item spans several modules, changes an API shape or needs source discovery.
3. **Implementer** (mid): at most three in parallel, one module or ingest job each, disjoint files. The brief states objective, owned files, source URLs, output format and "real data only".
4. **Tester** (mid): runs the module's ingest check, curls its routes, takes headless screenshots. Reports counts and defects; never fixes.
5. **Reviewer** (strong, separate, read-only): looks for wrong figures, duplicates, cumulative-versus-annual mix-ups, unit errors, broken empty states and budget problems. Findings are applied and re-reviewed at most once.

## Working rules

- Each run is short and never leaves the tree uncommitted or the sample server down.
- Commit only your own paths, as `Location: Description.`, with no secrets and no mention of tooling.
- Tick the `docs/BACKLOG.md` checkbox and add newly found gaps.
- Agents never deploy, never upload data, never touch `ops/` or the release flow unless explicitly asked.
- Finish with three lines: what shipped, what is running, what is next.

## Model routing

Cheap models for scouting and sweeps, mid-size for building and testing, strongest for architecture, source discovery and review.
