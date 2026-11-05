# Operations

Target host: AWS Lightsail, 1 GB RAM, 2 vCPU, 40 GB SSD (about 12 GB of data already). Everything is sized for that.

## Layout

| Path | Content |
|---|---|
| `/opt/estado-aberto/releases/<tag>/` | One unpacked code release; its `data` is a symlink |
| `/opt/estado-aberto/current` | Symlink to the active release |
| `/var/lib/estado-aberto/data` | Shared data directory, never inside a release, never overwritten by the updater |
| `/var/lib/estado-aberto/state` | `last_update.json`, `failed_tag`, `update.lock`, `ingest-queue/` |
| `/etc/estado-aberto/{updater,app,ingest}.env` | Configuration, mode 0640 root:estado-aberto |

## Services

- `estado-aberto.service`: Node with `--max-old-space-size=256`, `MemoryHigh=350M`, `MemoryMax=450M`, user `estado-aberto`.
- `estado-aberto-updater.timer` (every 10 minutes) runs the updater, which pulls the latest stable release.
- `estado-aberto-daily.timer` (04:30) runs `estado-aberto-python ingest/run_all.py --schedule daily --profile server`.
- `estado-aberto-ingest-queue.service` runs ingest jobs queued by an update, after the switch and a settle delay.
- Daily, queue and updater share `state/update.lock`, so ingest and update never overlap and ingest jobs run strictly one at a time. Ingest units use `MemoryMax=400M`, `Nice=10`, idle I/O class and low CPU weight.

## Guards

The updater refuses to run when free disk is below 5 GB or available RAM below 200 MB, keeps the last two releases, downloads only the code tarball, verifies SHA256, tolerates a cold start of up to 90 s in the health check, and rolls back automatically if `http://127.0.0.1:3000/api/status` does not answer.

## First-time setup

```
sudo ops/install.sh --dry-run
sudo ops/install.sh [--node /path/to/node] [--python /path/to/python3.12] [--enable-timers]
sudo -u estado-aberto /usr/local/sbin/estado-aberto-updater --force-tag vX.Y.Z
```

The installer creates the user, directories, env templates, units, timers, a sudoers rule limited to restarting the app and starting the ingest queue, and a 2 GB swapfile with `vm.swappiness=10` when `swapon --show` lists no swap. It links `/usr/local/bin/estado-aberto-node` and `/usr/local/bin/estado-aberto-python`; `--python` defaults to the first of `python3.13`, `python3.12`, `python3` that is 3.12 or newer, and the installer fails otherwise. The system `python3` is never replaced. Timers are installed but only enabled with `--enable-timers`.

### Amazon Linux 2023

```
sudo dnf install -y python3.12 poppler-utils nodejs22
sudo ops/install.sh --node "$(readlink -f $(command -v node))" --python /usr/bin/python3.12
```

`nodejs22` gives a system Node readable by every user; if it is unavailable, install Node 22 or newer under `/usr/local` and pass that path. A Node under `/home/<SSH_USER>/.nvm` is not readable by the service user. `python3` is 3.9 on this image and stays that way. An existing swapfile is detected and left alone.

Enable the timers only after the first manual `estado-aberto-updater --check` and one supervised `estado-aberto-ingest-queue` run (or `run_all --dry-run`), then run `sudo systemctl enable --now estado-aberto-updater.timer estado-aberto-daily.timer`.

## Daily use

| Task | Command |
|---|---|
| Is an update available | `sudo -u estado-aberto estado-aberto-updater --check` |
| Install a specific tag | `sudo -u estado-aberto estado-aberto-updater --force-tag v0.2.0` |
| Roll back to the previous release | `sudo -u estado-aberto estado-aberto-updater --rollback` |
| Last update result | `cat /var/lib/estado-aberto/state/last_update.json` |
| Updater logs | `journalctl -u estado-aberto-updater -n 100` |
| App logs | `journalctl -u estado-aberto -f` |
| Ingest logs | `journalctl -u estado-aberto-daily -u estado-aberto-ingest-queue` |
| Environment check | `cd /opt/estado-aberto/current && ESTADO_ABERTO_DATA=/var/lib/estado-aberto/data estado-aberto-python tools/doctor.py` |

A private repository needs a read-only `GITHUB_TOKEN` in `updater.env`. No credential that can log in to the server exists anywhere in CI.

## Testing the updater

`bash ops/updater/test/run.sh` simulates update, no-op, bad checksum, health-failure rollback, low-disk refusal and data integrity against a local stub on port 3170, using temporary directories only.
