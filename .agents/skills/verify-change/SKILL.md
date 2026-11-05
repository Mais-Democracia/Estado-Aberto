---
name: verify-change
description: Run the full verification set for a change and report honestly.
---

# verify-change

## When to use
Before every commit or PR.

## Steps
1. `npm run check`.
2. `python3 -m py_compile` on touched Python; `node --check` on touched `.mjs` and `.js`.
3. `python3 tools/make_sample.py`, start the server on a free port, `curl` touched routes: status, JSON shape, size.
4. Headless screenshot of touched pages, including the empty state; look at them.
5. `git status`: nothing under `data/`, no secrets, no personal paths, no personal paths or emails.
6. Check the commit message follows `Location: Description.`.

## Checks
Report each step as run or not run, with counts. A step not run is not a pass.
