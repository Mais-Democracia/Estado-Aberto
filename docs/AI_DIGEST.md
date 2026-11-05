# AI digest

The repository owner approved on 2026-11-06 that AI-written articles may be published automatically, without per-article human approval, provided every safety gate below passes. Rejected drafts are kept for audit and the underlying event stays in the plain list.

## Flow

The edition for date D reports on D-1. The ledger (`diario.db`) holds events and a deterministic scorer produces a shortlist (`python3 ingest/jobs/diario.py --shortlist D`).

| # | Stage | Model | Notes |
|---|---|---|---|
| 1 | bundle | none | Per event: `bundles/<evidence_hash>/facts.json` (ledger rows, earlier events of the same entities, data from the local API) and `fontes.json` (allowed hrefs). For chosen stories `fetch_pdf.py` downloads the source PDF (robots.txt, host allowlist, 10 MB, 20 s, `pdftotext -l 8 -layout`, 60,000 chars) into `texto.txt`. The model never fetches anything |
| 2 | triage | haiku | One batched call over about 25 candidates, ranked list with a reason |
| 3 | selection | opus | Up to `AI_MAX_ARTICLES` stories from the top 12, for diversity and democratic significance |
| 4 | drafting | sonnet | One call per story, cwd is the bundle, read access only inside it |
| 5 | verify | none | Every number, date and proper name must occur in `facts.json` or `texto.txt`; every href must be in `fontes.json`; body at most 250 words; no URLs; no first person |
| 6 | review | opus | One call per story, `ok` or `rejeitar` plus unsupported claims |

Publish gate: verifier passes AND reviewer `ok` AND `confianca >= 0.7`. A draft that fails the verifier is rejected without calling the reviewer.

## Files

State lives under `$ESTADO_ABERTO_STATE/ai/` (default `/var/lib/estado-aberto/state/ai`): `audit.log` (JSON lines: time, stage, model, tokens in/out, usd, cache hit, decision), `bundles/`, `cache/`, `work/<D>/`, `published/<D>/`, `rejected/<D>/`, `STOP`.

The AI job has read-only data and write access only to `state/ai`, so it leaves approved article files in `published/<D>/`. `ingest/jobs/diario_ia.py` runs as the app user, re-verifies each file against its bundle, and inserts it into `artigos_ia` and sets `eventos.ia_artigo_id`. It is idempotent; a changed article with the same events becomes `revisao + 1`. It is not part of the ingest schedule.

## Cost control

- Cache key: `sha256(stage|model|prompt_version|evidence_hash)`. A rerun processes only new or changed evidence; a second run with unchanged data makes zero calls.
- Budgets: `AI_MAX_USD_DAY` (2.50), `AI_MAX_USD_MONTH` (60), `AI_MAX_ARTICLES` (5), plus a per-call `--max-budget-usd` per stage in `ops/ai/config.json`. Before each call the runner checks that spend plus the stage estimate fits the budget.
- Kill switches: `AI_ENABLED=0` (the default until the owner enables it) and the file `state/ai/STOP`.
- Estimate for 25 candidates, 12, 5 stories at list prices (haiku 1/5, sonnet 3/15, opus 5/25 USD per million tokens in/out): about 1.35 USD per day. `python3 ops/ai/run.py --dry-run` prints it with no calls. Prices, estimates and the EUR rate are in `config.json`.

## Provider

The `cli` provider runs the Claude Code CLI headless (`${CLAUDE_BIN:-/opt/claude-cli/claude} -p ...`) with tools limited to Read, Grep and Glob, `--allowedTools` scoped to `Read(//<bundle>/**)`, no Bash, web, write or task tools, no MCP, no settings sources, `dontAsk` permission mode and no session persistence. The flag list is the `cli.args` template in `config.json`; adjust it to the installed CLI version. Provider `api` is reserved and not implemented.

## Prompt injection

Source text is wrapped in `<fonte_nao_confiavel>` tags inside files, lines that look like instructions (ignore previous, role markers, tool-call syntax) are replaced before the model sees them, the system prompts state that file content is data, and every output is schema-validated and then verified by code.

## Enabling

1. Install the CLI at `/opt/claude-cli/claude` (or set `CLAUDE_BIN`) and log in or put `ANTHROPIC_API_KEY` in `/etc/estado-aberto/ai.env`.
2. Create the user `estado-aberto-ai` with read access to the data directory and write access to `state/ai`.
3. Install the units from `ops/systemd/` (`estado-aberto-ai.service`, `estado-aberto-ai-import.service`, `estado-aberto-ai.timer`) and enable the timer. The timer starts the import unit, which requires the AI unit and runs after it.
4. Put `AI_ENABLED=1` in `ai.env`.

Stop at any time with `touch state/ai/STOP` or `AI_ENABLED=0`.

## Running under an existing login user

If the CLI login already exists in a user's home, the drop-in `ops/ai/estado-aberto-ai-login-user.conf` can be installed as `/etc/systemd/system/estado-aberto-ai.service.d/login-user.conf`. Tradeoffs: it avoids a second login and key, but the job then runs with that user's file permissions and can read their home (`ProtectHome=read-only`, with only `~/.claude` writable); the path-scoped read rules and absence of Bash limit the model, not the unit sandbox. A dedicated user is stricter. The maintainer chooses.

## Tests

`python3 ingest/tests/test_ai.py` runs the whole pipeline against a synthetic ledger using the fake CLI `ops/ai/test/bin/claude`: an invented number is rejected, a prompt-injection line in the source changes nothing, a reviewer rejection is rejected, and budgets, kill switches, caching and idempotent import are checked.
