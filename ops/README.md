# ops

Production operations for the Estado Aberto server. Nothing here is executed by CI; the server pulls releases itself.

| Path | Purpose |
|---|---|
| `install.sh` | First-time, idempotent server setup (`--dry-run` supported) |
| `updater/estado-aberto-updater.sh` | Pull-model updater run by a systemd timer |
| `updater/ingest-queue-runner.sh` | Low-priority runner for ingest jobs queued by an update |
| `updater/test/run.sh` | Local simulation of the updater against a stub GitHub API on port 3170 |
| `systemd/` | App, updater, daily ingest, ingest-queue and AI digest (`estado-aberto-ai*`) units and timers |
| `guard-allowlist.txt` | Paths the CI content guard may accept despite their file type or size |
| `release-manifest.json` | Instructions for the updater, written by `tools/release.sh` |
| `ai/` | Automated AI digest pipeline (run.py, prompts, schemas, verifier); see `docs/AI_DIGEST.md` |

Rule: releases carry code and instructions only. Data is never committed, attached or pushed; the server fetches public sources itself.

See `docs/OPERATIONS.md`, `docs/RELEASING.md` and `docs/MIGRATION_AWS.md`.
