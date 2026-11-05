# Migrating the AWS box to the release layout

Plan only. Nothing here has been executed. Steps marked **[GO]** need the maintainer's explicit go-ahead before running.

Current state: `<SSH_USER>@<SERVER_HOST>`, unversioned `/home/<SSH_USER>/politica-pt` (code plus `data/`, 12 GB), `politica.service` running as `<SSH_USER>`, Node v26 `server.mjs` on :3000, nothing on 80/443, 1 GB RAM, 40 GB disk (about 28 GB free). The 12 GB is never copied: the same filesystem lets us move or link it.

## 0. Preconditions

- A release (for example `v0.1.0`) is published from this repository on GitHub.
- Free disk at least 5 GB; check `df -h /` and `free -m`.
- A maintenance window of a few minutes for the service switch.

## 1. Back up code (not data) **[GO]**

```
cd /home/<SSH_USER>
tar --exclude=politica-pt/data -czf politica-pt-code-$(date +%F).tar.gz politica-pt
sudo cp /etc/systemd/system/politica.service /home/<SSH_USER>/politica.service.bak
```

Record `systemctl status politica`, the Node path (`readlink -f $(command -v node)`), and `ls -la politica-pt/data | head`.

## 2. Install **[GO]**

Copy the `ops/` directory of the release to the box (from the GitHub tarball, not from a developer machine's data), then:

```
sudo ./ops/install.sh --dry-run
sudo ./ops/install.sh --node "$(readlink -f $(command -v node))"
```

The installer creates `/var/lib/estado-aberto/data` empty. Node under `/home/<SSH_USER>` must be readable by user `estado-aberto`; if it is not, install a system Node 22 and pass that path.

## 3. Adopt the existing data without copying **[GO]**

Stop writers first, then keep the old path working through a symlink so rollback stays trivial:

```
sudo systemctl stop politica.service
sudo rmdir /var/lib/estado-aberto/data
sudo mv /home/<SSH_USER>/politica-pt/data /var/lib/estado-aberto/data
sudo ln -s /var/lib/estado-aberto/data /home/<SSH_USER>/politica-pt/data
sudo chown -R estado-aberto:estado-aberto /var/lib/estado-aberto/data
sudo chmod -R g+rX /var/lib/estado-aberto/data
```

`mv` on the same filesystem is a rename, so it is instant and uses no extra disk. If `/home` is a different filesystem, skip the `mv` and instead `sudo ln -s /home/<SSH_USER>/politica-pt/data /var/lib/estado-aberto/data` (after `rmdir`), and grant `estado-aberto` traversal on `/home/<SSH_USER>`.

## 4. First release through the updater **[GO]**

```
sudo -u estado-aberto /usr/local/sbin/estado-aberto-updater --force-tag v0.1.0
```

This downloads the tarball, verifies it, runs `tools/doctor.py`, switches `current`, restarts `estado-aberto.service` and waits up to 90 s for `/api/status`. Because `politica.service` still binds :3000, stop it before this step (step 3 already did) so the new service can bind.

## 5. Switch services **[GO]**

```
sudo systemctl disable politica.service
systemctl is-enabled estado-aberto.service estado-aberto-updater.timer estado-aberto-daily.timer
```

Leave `politica.service` and `/home/<SSH_USER>/politica-pt` untouched and stopped. Do not delete them until the new setup has run for at least a week.

## 6. Verification checklist

- [ ] `curl -fsS http://127.0.0.1:3000/api/status` returns OK from the box
- [ ] The public URL used today still serves the site and a module page shows real data
- [ ] `systemctl status estado-aberto` active, `systemctl show estado-aberto -p MemoryCurrent` under 450M
- [ ] `readlink -f /opt/estado-aberto/current` is `releases/v0.1.0`
- [ ] `ls /opt/estado-aberto/current/data` resolves to `/var/lib/estado-aberto/data`; data size unchanged (`du -sh`)
- [ ] `systemctl list-timers | grep estado-aberto` shows updater and daily timers
- [ ] `estado-aberto-updater --check` prints `up-to-date v0.1.0`
- [ ] `free -m` shows swap present; `df -h /` still above 5 GB free
- [ ] After the first 04:30 run, `journalctl -u estado-aberto-daily` shows a clean run

## 7. Rollback **[GO]**

If anything fails before step 5 completes:

```
sudo systemctl stop estado-aberto.service
sudo rm /home/<SSH_USER>/politica-pt/data
sudo mv /var/lib/estado-aberto/data /home/<SSH_USER>/politica-pt/data
sudo systemctl start politica.service
```

(If step 3 used the symlink variant, only stop the new service and start `politica.service`.) The old code backup from step 1 restores the code tree if it was changed. Later release problems are handled by `estado-aberto-updater --rollback`.

## 8. Afterwards

After a week of healthy operation and with the maintainer's agreement: remove `politica.service`, archive the code backup off-box, and delete the old `politica-pt` code tree (keeping nothing that duplicates data).
