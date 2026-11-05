# Server-side AI workflow (reserved, not implemented)

This document describes a possible future design. No code, unit or credential for it exists. Nothing in `ops/` runs it.

## Goals

Produce draft news items and summaries from the data already on the server, for a human to approve.

## Architecture

- Dedicated unprivileged user `estado-aberto-ai`, no login shell, no sudo, no membership of the `estado-aberto` group beyond read access to the data directory through an ACL.
- Runs only inside a scheduled window (for example 03:30 to 04:20, before the daily ingest) as a systemd oneshot with `MemoryMax` well under the 1 GB box budget (target 300M), `Nice=15`, `IOSchedulingClass=idle`, and a hard `RuntimeMaxSec`. It never runs while an update or ingest holds `/var/lib/estado-aberto/state/update.lock`.
- Prompts and skills are read from `.agents/` inside the current release; the runner treats them as read-only input.
- Reads: the SQLite databases opened read-only (`mode=ro`). Writes: only `/var/lib/estado-aberto/state/ai/`.
- Outputs are drafts, one file per item, under `/var/lib/estado-aberto/state/ai/drafts/` with front matter (sources, query, model, token counts, timestamp).

## Approval

Drafts are never served. A maintainer runs a documented approve step (`ai-approve <draft-id>`) that copies the draft into `/var/lib/estado-aberto/state/ai/published/`, which the app may then read. Rejected drafts are moved to `rejected/`. Publishing requires an explicit human action.

## Limits and safety

- No deploy credentials, no GitHub token, no write access to `/opt/estado-aberto`, cannot modify releases, units or timers.
- Outbound network restricted to the single model API endpoint (firewall or per-user egress rule); no path for sending the databases anywhere.
- Daily and monthly token budgets in `/etc/estado-aberto/ai.env`; the runner stops at the budget and logs it.
- Audit log: append-only `/var/lib/estado-aberto/state/ai/audit.log` (timestamp, prompt id, inputs by hash, token counts, output file, approver).
- API key stored only in `/etc/estado-aberto/ai.env` (0640 root:estado-aberto-ai), never in the repository or in releases.

## Before implementing

Agree the approval roles, the retention of drafts, and the budget with the maintainers, and extend the CI guard so prompts stay free of personal data.
