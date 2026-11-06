# Operations

Target host: AWS Lightsail, 1 GB RAM, 2 vCPU, 40 GB SSD (about 12 GB of data already). Everything is sized for that.

## Layout

| Path | Content |
|---|---|
| `/opt/estado-aberto/releases/<tag>/` | One unpacked code release; its `data` is a symlink |
| `/opt/estado-aberto/current` | Symlink to the active release |
| `/var/lib/estado-aberto/data` | Shared data directory, never inside a release, never overwritten by the updater |
| `/var/lib/estado-aberto/state` | `last_update.json`, `failed_tag`, `update.lock`, `lock.want.*`, `alerts.json`, `ingest-queue/` |
| `/etc/estado-aberto/{updater,app,ingest}.env` | Configuration, mode 0640 root:estado-aberto |

## Services

- `estado-aberto.service`: Node with `--max-old-space-size=256`, `MemoryHigh=350M`, `MemoryMax=450M`, user `estado-aberto`.
- `estado-aberto-updater.timer` (every 10 minutes) runs the updater, which pulls the latest stable release.
- `estado-aberto-refresh.timer` (00:10, 06:10, 12:10, 18:10 Europe/Lisbon, up to 5 minutes of random delay, `Persistent=true`) runs `run_all.py --schedule 6h --profile server`: the light steps that keep the daily edition current.
- `estado-aberto-daily.timer` (02:30 Europe/Lisbon) runs `--schedule daily` (includes the 6h steps; steps refreshed less than their `fresh_hours` ago are skipped).
- `estado-aberto-weekly.timer` (Sunday 01:00 Europe/Lisbon) runs `--schedule weekly`: the statistics chain and the full rebuilds.
- `estado-aberto-ingest-queue.service` runs ingest jobs queued by an update, after the switch and a settle delay.
- The refresh and daily units use `MemoryHigh=350M`, `MemoryMax=450M` and pass `--max-mb 450`, so `run_all` warns for any step estimated above the cap. The weekly unit uses `MemoryHigh=500M`, `MemoryMax=600M` and `--max-mb 600` because `entities` loads a 50 MB JSON (about 500 MB peak); the 2 GB swapfile from the installer is the safety margin for it. Every ingest unit also uses `Nice=10`, idle I/O class, `CPUWeight=20` and `OnFailure=estado-aberto-alert@%n.service`. The run-time cap is `TimeoutStartSec` (systemd ignores `RuntimeMaxSec` for oneshot units): refresh 1 h, daily 3 h, weekly 8 h.

## Locking

Updater, ingest and the AI job share one advisory lock, `$STATE_DIR/update.lock` (`/var/lib/estado-aberto/state/update.lock`), taken with `flock`; the AI units go through `estado-aberto-with-lock ai --wait 1500 -- ...` (installed from `ops/updater/with-lock.sh`), which applies the same ordering. The AI user is in the `estado-aberto` group and the state directory is `2770`, so it can create `lock.want.ai.<pid>` and take the lock. Only one holds it at a time, so two heavy steps never run together. Waiters are ordered **updater, then ingest, then AI**: a waiter announces itself with `state/lock.want.<role>.<pid>`, and a lower-priority waiter does not take a free lock while a higher-priority waiter is alive. A running ingest releases the lock between steps when an updater is waiting and takes it back afterwards.

- Python: `ingest/common.py` `SharedLock(role, wait=7200)`. `run_all.py` uses it (`--lock-role`, `--lock-wait SECONDS`, default 2 h).
- Shell: `ops/updater/lock.sh` (installed as `/usr/local/sbin/estado-aberto-lock.sh`) `ea_lock_acquire <role> <wait>`. The updater and the queue runner use it.
- Any other command, e.g. the AI job: `estado-aberto-with-lock ai --wait 1500 -- <command>`; the command sees `EA_LOCK_HELD=1` and must not lock again.
- A run that waits the full time logs `lock: gave up after Ns waiting for update.lock held by <role> <pid>; this <role> run did not start`. `run_all.py` then exits 75. The refresh and daily units treat 75 as success (the next run catches up); the weekly unit reports it as a failure. Refresh waits at most 25 minutes, daily 1 h, weekly 2 h, so the wait stays inside the unit's time cap.
- The updater waits `UPDATER_LOCK_WAIT` seconds (default 7200) and then exits 0 with `try again later`; its unit allows 9000 s.

## Failure alerts

When a unit with `OnFailure=` fails, `estado-aberto-alert@<unit>.service` runs `/usr/local/sbin/estado-aberto-alert <unit>`, which appends an entry to

`/var/lib/estado-aberto/state/alerts.json`

(`$STATE_DIR/alerts.json`, written atomically under `alerts.lock`, newest last, at most 50 entries). The service user is in the `systemd-journal` group so it can read the unit log.

```
{
  "version": 1,
  "alerts": [
    {
      "unit": "estado-aberto-refresh.service",
      "time": "2026-11-06T06:41:12+00:00",
      "lines": ["last 20 journal lines of the unit, oldest first"]
    }
  ]
}
```

`/api/status` is expected to expose `alerts` from this file. To clear: delete the file.

## Data freshness

`run_all.py` writes `$DATA/.ingest_state.json` (`/var/lib/estado-aberto/data/.ingest_state.json`). Per step: `status`, `last_ok` (UTC ISO time of the last successful run, kept across later failures), `finished_ts`, `seconds`, `peak_rss_mb`, `log` and, for jobs that report it, `last_data_date`: the newest source date the step saw (`dre_recent`, `votacoes_recent`, `presidencia_recent`, `contracts_recent`, `intervencoes_recent`, `justica_tc_recent`, `reguladores_recent`). Jobs report it by printing one line, `{"ultima_data":"YYYY-MM-DD"}`, last on stdout. The edition uses it to print «Dados de X só até <data>».

## Guards

The updater refuses to run when free disk is below 5 GB or available RAM below 200 MB, keeps the last two releases, downloads only the code tarball, verifies SHA256, tolerates a cold start of up to 90 s in the health check, and rolls back automatically if `http://127.0.0.1:3000/api/status` does not answer.

## First-time setup

```
sudo ops/install.sh --dry-run
sudo ops/install.sh [--node /path/to/node] [--python /path/to/python3.12] [--enable-timers]
sudo -u estado-aberto /usr/local/sbin/estado-aberto-updater --force-tag vX.Y.Z
```

The installer creates the user, directories, env templates, units, timers, a sudoers rule limited to restarting the app and starting the ingest queue, and a 2 GB swapfile with `vm.swappiness=10` when `swapon --show` lists no swap. It links `/usr/local/bin/estado-aberto-node` and `/usr/local/bin/estado-aberto-python`; `--python` defaults to the first of `python3.13`, `python3.12`, `python3` that is 3.12 or newer, and the installer fails otherwise. The system `python3` is never replaced. Timers are installed but only enabled with `--enable-timers`. The AI digest units (`estado-aberto-ai.service`, `estado-aberto-ai-import.service`, `estado-aberto-ai.timer`) are installed too, together with the user `estado-aberto-ai` (no login, home `state/ai/home`), `state/ai` and `/etc/estado-aberto/ai.env` (0640 root:estado-aberto-ai, `AI_ENABLED=0`, empty `ANTHROPIC_API_KEY`). The AI timer is never enabled unless `--enable-ai-timer` is given, and the job does nothing while `AI_ENABLED=0`.

The maintainer chooses how the AI job authenticates: either keep the dedicated user and put `ANTHROPIC_API_KEY` in `ai.env` (strictest, the default), or install the drop-in `ops/ai/estado-aberto-ai-login-user.conf` as `/etc/systemd/system/estado-aberto-ai.service.d/login-user.conf` to run under an existing login user that already has the CLI logged in. See [AI_DIGEST.md](AI_DIGEST.md#running-under-an-existing-login-user).

### Amazon Linux 2023

```
sudo dnf install -y python3.12 poppler-utils nodejs22
sudo ops/install.sh --node "$(readlink -f $(command -v node))" --python /usr/bin/python3.12
```

`nodejs22` gives a system Node readable by every user; if it is unavailable, install Node 22 or newer under `/usr/local` and pass that path. A Node under `/home/<SSH_USER>/.nvm` is not readable by the service user. `python3` is 3.9 on this image and stays that way. An existing swapfile is detected and left alone.

Enable the timers only after the first manual `estado-aberto-updater --check` and one supervised `estado-aberto-ingest-queue` run (or `run_all --dry-run`), then rerun `sudo ops/install.sh --enable-timers` (and `--enable-ai-timer` once `AI_ENABLED=1` is set) (it enables the updater, refresh, daily and weekly timers and restarts them to pick up schedule changes; running it again changes nothing).

## Daily use

| Task | Command |
|---|---|
| Is an update available | `sudo -u estado-aberto estado-aberto-updater --check` |
| Install a specific tag | `sudo -u estado-aberto estado-aberto-updater --force-tag v0.2.0` |
| Roll back to the previous release | `sudo -u estado-aberto estado-aberto-updater --rollback` |
| Last update result | `cat /var/lib/estado-aberto/state/last_update.json` |
| Updater logs | `journalctl -u estado-aberto-updater -n 100` |
| App logs | `journalctl -u estado-aberto -f` |
| Ingest logs | `journalctl -u estado-aberto-refresh -u estado-aberto-daily -u estado-aberto-weekly -u estado-aberto-ingest-queue` |
| Run a refresh now | `sudo systemctl start estado-aberto-refresh.service` |
| Last failure alerts | `cat /var/lib/estado-aberto/state/alerts.json` |
| Who holds the lock | `cat /var/lib/estado-aberto/state/update.lock` |
| Step freshness | `cat /var/lib/estado-aberto/data/.ingest_state.json` |
| Environment check | `cd /opt/estado-aberto/current && ESTADO_ABERTO_DATA=/var/lib/estado-aberto/data estado-aberto-python tools/doctor.py` |

A private repository needs a read-only `GITHUB_TOKEN` in `updater.env`. No credential that can log in to the server exists anywhere in CI.

## Testing the updater

`bash ops/updater/test/run.sh` simulates update, no-op, bad checksum, health-failure rollback, low-disk refusal and data integrity against a local stub on port 3170, using temporary directories only. It also covers lock waiting, timeout and updater > ingest > AI ordering, the alert writer, `bash -n` on every script, installer dry-runs (idempotent, timers only with `--enable-timers`) and `systemd-analyze verify` of the units when available.

`python3 -m unittest discover ingest/tests` covers schedule selection, `fresh_hours`, `after` ordering, lock contention and the alert file.
