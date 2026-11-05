# ops/ai

Cost-optimised pipeline that drafts, verifies and reviews daily articles from the ledger. Full documentation: `docs/AI_DIGEST.md`.

| Path | Purpose |
|---|---|
| `run.py` | Orchestrator (`--date`, `--dry-run`, `--stage`) |
| `bundle.py`, `fetch_pdf.py` | Stage 1, no model: evidence bundles and source text |
| `verify.py` | Stage 5, no model: numbers, dates, names, hrefs, length, URLs, first person |
| `lib.py` | Config, audit log, budgets, kill switches, CLI adapter, cache |
| `config.json` | Models, prices, caps, CLI flags, allowed hosts |
| `prompts/`, `schemas/` | Stage prompts and output schemas |
| `estado-aberto-ai-login-user.conf` | systemd drop-in example for running under an existing login user |
| `test/bin/claude` | Fake CLI used by `ingest/tests/test_ai.py` |
