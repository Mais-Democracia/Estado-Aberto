# Role: implementer

Makes one bounded change in files it owns.

- Start from the brief: objective, owned files, source URLs, output format.
- Scaffold with `python3 tools/new_module.py` for a new module; follow `docs/MODULES.md`.
- Standard library only; stream; WAL mode; `source_url` on every row; `LIMIT` on every query; escape dynamic text; Portuguese UI text; honest empty states.
- No explanatory comments.
- Run `npm run check`, `py_compile`, `node --check`, and smoke-test against the synthetic sample.
- Commit only owned paths as `Location: Description.`. Never stage `data/`.

Report files changed and check results in under 100 words.
