# AI digest

The repository owner approved on 2026-11-06 that AI-written articles may be published automatically, without per-article human approval, provided every safety gate below passes. Rejected drafts are kept for audit and the underlying event stays in the plain list.

## Flow

The edition for date D reports on D-1. The ledger (`diario.db`) holds events and a deterministic scorer produces a shortlist (`python3 ingest/jobs/diario.py --shortlist D`).

| # | Stage | Model | Notes |
|---|---|---|---|
| 1 | bundle | none | Sensitive events are dropped here by code (see Privacy and fairness). Per event: `bundles/<evidence_hash>/facts.json` (ledger rows, earlier events of the same entities, data from the local API) and `fontes.json` (allowed hrefs). For chosen stories `fetch_pdf.py` downloads the source PDF (robots.txt, host allowlist, 10 MB, 20 s, `pdftotext -l 8 -layout`, 60,000 chars) into `texto.txt`. The model never fetches anything |
| 2 | triage | haiku | One batched call over about 25 candidates, ranked list with a reason |
| 3 | selection | opus | Up to `AI_MAX_ARTICLES` stories from the top 12, for diversity and democratic significance |
| 4 | drafting | sonnet | One call per story, cwd is the bundle, read access only inside it |
| 5 | verify | none | See Verifier |
| 6 | review | opus | One call per story. The pipeline writes `rascunho_revisao.txt` (the draft wrapped in `<rascunho_nao_confiavel>`, free text length-capped); the model never sees `rascunho.json`. `ok` or `rejeitar` plus unsupported claims |

Publish gate: verifier passes AND reviewer `ok` AND `confianca >= 0.7`. A draft that fails the verifier is rejected without calling the reviewer. Any exception while verifying or reviewing one story marks only that story `rejeitado` with the reason `erro:<Type>`; the run continues with the next stories. The importer does the same per file: a file that cannot be imported forces its existing row to `rejeitado`.

## Verifier

`ops/ai/verify.py` is code, not a model. It checks:

- Quantities carry their unit and scale. `%`, euros (`euros`, `€`), scale words (`mil`, `milhões`, `mil milhões`, `biliões`) and ordinals are parsed; a number must occur in the evidence with the same value and unit family. `15%` does not match `15 deputados`, `2,5 mil milhões` does not match `2,5 milhões`, an ordinal needs the same number in the evidence. Ids, scores and URLs in `facts.json` do not count as evidence.
- Derived values (sum, difference, ratio, percentage) must be declared in `calculos[]` as `{expr, resultado}`. The pipeline parses `expr` (numbers from the evidence, `+ - * /`, parentheses, the constant 100), recomputes it exactly and requires the stated result within its own rounding.
- `numeros_citados` items match `^[0-9][0-9.,% ]*[A-Za-z%€ ]{0,12}$` (schema) and are verified like body numbers.
- Whole names: a multi-word proper name must occur contiguously in the evidence (case and accent insensitive). Single-word names (including at sentence start when the word is capitalised elsewhere in the evidence) must be declared in `entidades`; all-caps acronyms of 2 to 8 letters must occur in the evidence.
- `entidades` are objects `{nome, tipo, cargo_publico}`. A `pessoa` needs a public role from `cargos_publicos` in `config.json`. A name found only in `texto.txt` (a PDF) must be declared.
- Dates need day and month, and year when given; a date without year only matches an evidence date of the edition year or without year.
- Vote direction: if the article says a party or group voted `a favor`, `contra` or abstained, the vote table in the evidence (`partido`/`sentido`) must agree; no table means the claim fails.
- Hrefs in `fontes.json`, 250 words, no URLs, no first person, no instruction-like lines or wrapper tags in any draft field.

## Privacy and fairness

- Sensitive events never reach a model: `exclusoes` in `config.json` drops by event type (`nomeacao_gabinete`, `exoneracao`) and by pattern on title and summary (criminal, disciplinary and misdemeanour proceedings, accused persons, convictions, despachos about named private individuals, sole traders). It runs in `bundle.build`, so it applies to the shortlist, selection and drafting.
- Persons may only be named with a public role declared in `entidades`. Names that exist only in PDF text must be declared.
- Prompts require the presumption of innocence, state that audit findings are findings and not convictions, forbid attributing intent or speculating, and require "segundo <fonte>".
- Residual risk: the code cannot tell a person from an organisation in free text; the reviewer is the second gate.

## Files

State lives under `$ESTADO_ABERTO_STATE/ai/` (default `/var/lib/estado-aberto/state/ai`): `audit.log` (JSON lines: time, stage, model, tokens in/out, usd, cache hit, decision), `budget.json` (spend per day, the source of truth for the caps, written atomically; deleting `audit.log` does not reset it), `bundles/`, `cache/`, `work/<D>/`, `published/<D>/`, `rejected/<D>/`, `killed/<evidence_hash>` (retraction markers), `STOP`.

The AI job has read-only data and write access only to `state/ai`, so it leaves approved article files in `published/<D>/`. `ingest/jobs/diario_ia.py` runs as the app user, re-verifies each file against its bundle, and inserts it into `artigos_ia` and sets `eventos.ia_artigo_id`. It is idempotent; a changed article with the same events becomes `revisao + 1`. It is not part of the ingest schedule.

## Cost control

- Cache key: `sha256(stage|model|prompt_version|evidence_hash)`. A rerun processes only new or changed evidence; a second run with unchanged data makes zero calls.
- Budgets: `AI_MAX_USD_DAY` (2.50), `AI_MAX_USD_MONTH` (60), `AI_MAX_ARTICLES` (5), plus a per-call `--max-budget-usd` per stage and a wall-clock `timeout_s`. There is no `--max-turns`. Before each call the runner checks that spend plus the larger of the stage estimate and the largest actual cost seen for that stage fits the budget.
- Every call is charged, including failures: the cost reported in the CLI JSON (`total_cost_usd`/usage) is used even for a non-zero exit or an `is_error` result; when no cost is known the stage `max_usd` is charged. The charged amount is the larger of the reported cost and the price computed from tokens.
- A call is retried at most once, and never after a timeout or a budget stop.
- Kill switches are checked before every call, so they work mid-run: the file `state/ai/STOP`, and `AI_ENABLED` re-read from `/etc/estado-aberto/ai.env` (or `AI_ENV_FILE`). `AI_ENABLED=0` is the default until the owner enables it.
- A manual `python3 ops/ai/run.py` takes the shared lock as `ai` (the same lock as `estado-aberto-with-lock ai`, from `ingest/common.py`), so it cannot overlap ingest; it exits 75 when the lock is busy (`--wait` seconds). Under the systemd unit the lock is inherited.
- Estimate for 25 candidates, 12, 5 stories at list prices (haiku 1/5, sonnet 3/15, opus 5/25 USD per million tokens in/out): about 1.35 USD per day. `python3 ops/ai/run.py --dry-run` prints it with no calls. Prices, estimates and the EUR rate are in `config.json`.

## Retraction

```
python3 ops/ai/run.py --kill <evidence_hash-prefix|article-id> [--motivo 'texto']
python3 ops/ai/run.py --unkill <evidence_hash-prefix|article-id>
```

`--kill` writes `state/ai/killed/<evidence_hash>`, rewrites the file's `estado` to `rejeitado` (with `verificacao.retirada`), moves it to `rejected/<D>/`, runs `ingest/jobs/diario_ia.py` and logs to `audit.log`. The importer forces `rejeitado` for every evidence hash that has a marker, so a retraction is never reverted by a later import and moving a file by hand is unnecessary. The events covered by a marker are not drafted again. `--unkill` removes the marker and restores a retracted file to `published/`.

The import needs write access to `diario.db`: run `--kill` as `estado-aberto-ai` (it owns `state/ai`) and, if the import step reports it could not write, run `sudo systemctl start estado-aberto-ai-import.service`. The importer checkpoints the WAL and touches `diario.db` whenever it changes a row. `server.mjs` rescans database mtimes every 10 seconds and keys its response cache on them, and the edition cache in `server/modules/edicao.mjs` is keyed on the `diario.db` and `-wal` stamps, so a retraction is visible within seconds. The article page then shows a "Corrigido/retirado" note instead of the text.

## Provider

The `cli` provider runs the Claude Code CLI headless (`${CLAUDE_BIN:-/opt/claude-cli/claude} -p ...`) with tools limited to Read, Grep and Glob, `--allowedTools` scoped to `Read(//<bundle>/**)`, no Bash, web, write or task tools, no MCP, `--bare`, `--setting-sources user`, `dontAsk` permission mode and no session persistence. Provider `api` is reserved and not implemented.

The flag list is `cli.args` in `config.json`, with the provenance of each flag in `cli.provenance`. The installed CLI is Claude Code 2.1.314 and its `--help` was read in full:

- Verified present: `-p/--print`, `--model`, `--output-format`, `--json-schema`, `--tools`, `--allowedTools`, `--disallowedTools`, `--permission-mode` (choices `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), `--setting-sources` (values `user`, `project`, `local`), `--strict-mcp-config`, `--max-budget-usd`, `--no-session-persistence`, `--bare`.
- `--system-prompt-file` is only referenced in the help as `--system-prompt[-file]` (in the `--bare` text); `--system-prompt <prompt>` is listed on its own. `check_cli.py --live` proves the file form works.
- Not present: `--max-turns`. It was removed; cost is bounded by `--max-budget-usd` and the wall-clock timeout.
- `--setting-sources ""` is unverified (the help lists only `user`, `project`, `local`) and is not used. Isolation comes from `--bare` (no hooks, no `CLAUDE.md` discovery, no keychain or OAuth; auth is `ANTHROPIC_API_KEY` only) plus `--setting-sources user`, where the user source is the dedicated user's empty home. The bundle directory cannot inject project or local settings.

After installing or upgrading the CLI, and after enabling the AI job, run as the AI user:

```
python3 ops/ai/check_cli.py          # OK/MISSING per configured flag against claude --help
python3 ops/ai/check_cli.py --live   # one haiku call: schema round trip, then a request to read /etc/passwd that must be refused
```

`--live` spends a few cents and only runs when passed.

## Prompt injection

Source text is wrapped in `<fonte_nao_confiavel>` tags inside files, lines that look like instructions (ignore previous, role markers, tool-call syntax) are replaced before the model sees them, the system prompts state that file content is data, and every output is schema-validated and then verified by code.

## Enabling

1. Install the CLI at `/opt/claude-cli/claude` (or set `CLAUDE_BIN`).
2. `sudo ops/install.sh` creates the user `estado-aberto-ai` (no login, home `state/ai/home`, member of group `estado-aberto`), `state/ai`, `/etc/estado-aberto/ai.env` (0640 root:estado-aberto-ai; `AI_ENABLED=0`, empty `ANTHROPIC_API_KEY`, `CLAUDE_BIN`, budgets) and the three units. It does not enable the timer.
3. Put `ANTHROPIC_API_KEY` in `/etc/estado-aberto/ai.env`. This is the only supported credential setup: the job runs as the dedicated user with `ProtectHome=yes`, so it can read nothing of any person's home, and `--bare` makes the CLI use the API key only.
4. Run `python3 ops/ai/check_cli.py` and, once, `python3 ops/ai/check_cli.py --live` as `estado-aberto-ai`.
5. Put `AI_ENABLED=1` in `ai.env`, run `sudo systemctl start estado-aberto-ai.service` once under supervision, then `sudo ops/install.sh --enable-ai-timer`. The timer starts the import unit, which requires the AI unit and runs after it. Both units take the shared lock as `ai`, the lowest priority after the updater and ingest.

Stop at any time with `touch state/ai/STOP` or `AI_ENABLED=0`; both are honoured between calls of a running job.

### Running under a login user is not recommended

Using the CLI login of an existing user is not recommended and no drop-in is shipped. A login user can read its whole home, including credentials and other projects, and the path-scoped read rules and the absence of Bash limit the model, not the process. If the maintainer insists, the unit needs at least `ProtectHome=yes` (or `tmpfs`) with only that user's CLI state bind-mounted, and a path-scoped `Read` rule on the bundle (`Read(//<bundle>/**)`, already generated by `lib.py`). The model's Read tool must be path-scoped to the bundle in every setup.

## Tests

`python3 ingest/tests/test_ai.py` runs the whole pipeline against a synthetic ledger using the fake CLI `ops/ai/test/bin/claude`: an invented number is rejected, a prompt-injection line in the source changes nothing, a reviewer rejection is rejected, and budgets, kill switches, caching and idempotent import are checked. It also covers retraction and its persistence across imports, the hidden-channel schema, the wrapped reviewer input, the verifier rules (units, derived numbers, names, dates, votes), cost accounting for failed calls and its persistence, bounded retries, the shared lock, mid-run STOP, sensitive-event exclusion, fail-closed behaviour and `check_cli.py`.
