# ops/ai

Cost-optimised pipeline that drafts, verifies and reviews daily articles from the ledger. Full documentation: `docs/AI_DIGEST.md`.

| Path | Purpose |
|---|---|
| `run.py` | Orchestrator (`--date`, `--dry-run`, `--stage`, `--kill`, `--unkill`, `--motivo`, `--wait`); takes the shared lock as `ai` |
| `check_cli.py` | Verifies every configured CLI flag against `claude --help`; `--live` makes one tiny haiku call and tests Read confinement |
| `bundle.py`, `fetch_pdf.py` | Stage 1, no model: evidence bundles and source text |
| `verify.py` | Stage 5, no model: quantities with unit, derived calculations, whole names, dates, vote direction, hrefs, length, URLs, first person |
| `lib.py` | Config, audit log, persistent budget (`state/ai/budget.json`), kill switches, CLI adapter, cache |
| `config.json` | Models, prices, caps, CLI flags, allowed hosts |
| `prompts/`, `schemas/` | Stage prompts and output schemas |
| `test/bin/claude` | Fake CLI used by `ingest/tests/test_ai.py` |
