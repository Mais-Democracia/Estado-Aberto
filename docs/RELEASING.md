# Releasing

Releases carry code and instructions only. Real data is never committed, attached to a release or pushed to the server. A person who builds something locally that includes new data only tells the server what to do and how, through the release manifest. The server pulls the release and runs the released ingest tools itself against public sources.

## Cutting a release

1. Add entries under `## [Unreleased]` in `CHANGELOG.md`.
2. On a clean `main`: `tools/release.sh patch|minor|major|X.Y.Z [--run-on-update agenda,government] [--dry-run]`.
3. The script runs the guard and checks, bumps `VERSION` and `package.json`, dates the changelog section, writes `ops/release-manifest.json`, commits `Release vX.Y.Z.` and creates an annotated tag. It does not push.
4. Review, then `git push origin main --follow-tags`.
5. The `release` workflow re-runs guard and checks, verifies tag, `VERSION`, manifest and changelog agree, builds the tarball with `git archive`, writes `SHA256SUMS` and publishes tarball, `SHA256SUMS` and `release-manifest.json` with the changelog notes. It has `contents: write` only and no server credentials.
6. Within 10 minutes every server timer picks it up (see `docs/OPERATIONS.md`).

`git_sha` in the manifest is the commit the release commit was made on (the manifest cannot contain the hash of the commit that contains it). The tag points at the release commit.

## Manifest schema (`ops/release-manifest.json`)

```json
{
  "version": "0.2.0",
  "git_sha": "<40 hex>",
  "min_updater_version": 1,
  "node_version": "22",
  "python_min": "3.12",
  "resources": { "min_ram_mb": 200, "min_free_disk_gb": 5 },
  "post_update": [{ "step": "doctor" }],
  "ingest": { "run_on_update": ["agenda"], "schedule_changes": [] },
  "migrations": [{ "id": "001-example", "description": "text", "command": "python3 tools/migrate_001.py" }],
  "notes": "changelog text"
}
```

- `min_updater_version`: the updater refuses a release that needs a newer updater than the installed one.
- `resources`: the updater refuses when free disk or available RAM is below these numbers (and below its own floors of 5 GB and 200 MB).
- `post_update`: steps run before the switch; `doctor` runs `python3 tools/doctor.py --offline`. A failure aborts the update.
- `migrations`: shell commands run inside the new release, with `ESTADO_ABERTO_DATA` set, before the switch. Keep them idempotent. A failure aborts the update. Optional `ops/migrations.json` (a JSON list) feeds this field.
- `ingest.run_on_update`: job names from `ingest/run_all.py --list`. They are queued and run after the switch by the low-priority runner; failures are recorded in `/var/lib/estado-aberto/state/last_update.json` and never roll back code. Put `migrate` first whenever a release adds a column or table to an existing database (`"run_on_update": ["migrate"]`, or `tools/release.sh --run-on-update migrate`): it runs `ingest/migrations.py`, which upgrades the installed databases in place, offline and idempotently, and the daily run repeats it.
- `ingest.schedule_changes`: informational list of changes to the daily/weekly schedule.

## Rules

- Never attach databases, spreadsheets, archives of data or fixtures.
- `tools/ci_guard.sh` enforces this in CI and before each release.
- Prereleases are ignored by the updater (stable channel).
- To withdraw a bad release, publish a fixed higher version; servers that failed the health check on a tag skip it until forced.
