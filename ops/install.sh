#!/usr/bin/env bash
set -euo pipefail

DRY=0
NODE_BIN=""
PYTHON_BIN=""
SWAP=1
TIMERS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --node) NODE_BIN="${2:?--node needs a path}"; shift 2 ;;
    --python) PYTHON_BIN="${2:?--python needs a path}"; shift 2 ;;
    --enable-timers) TIMERS=1; shift ;;
    --no-swap) SWAP=0; shift ;;
    -h|--help) echo "usage: sudo ops/install.sh [--dry-run] [--node /path/to/node] [--python /path/to/python3.12] [--enable-timers] [--no-swap]"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC=estado-aberto

say() { echo "install: $*"; }
run() {
  if [ "$DRY" -eq 1 ]; then echo "  would run: $*"; else "$@"; fi
}
put() {
  local mode="$1" src="$2" dst="$3"
  if [ "$DRY" -eq 1 ]; then echo "  would install $src -> $dst ($mode)"; else install -m "$mode" "$src" "$dst"; fi
}

if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "install: run as root (or use --dry-run)" >&2
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] || { echo "install: node not found; pass --node /path/to/node" >&2; exit 1; }
NODE_BIN="$(readlink -f "$NODE_BIN")"
say "node: $NODE_BIN ($("$NODE_BIN" --version))"
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' > /dev/null 2>&1; }
if [ -z "$PYTHON_BIN" ]; then
  for c in python3.13 python3.12 python3; do
    p="$(command -v "$c" || true)"
    if [ -n "$p" ] && py_ok "$p"; then PYTHON_BIN="$p"; break; fi
  done
  [ -n "$PYTHON_BIN" ] || { echo "install: no Python >= 3.12 found; install python3.12 or pass --python /path/to/python3.12" >&2; exit 1; }
fi
[ -x "$PYTHON_BIN" ] || { echo "install: $PYTHON_BIN is not executable" >&2; exit 1; }
py_ok "$PYTHON_BIN" || { echo "install: $PYTHON_BIN is older than Python 3.12" >&2; exit 1; }
PYTHON_BIN="$(readlink -f "$PYTHON_BIN")"
say "python: $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"
command -v flock > /dev/null || { echo "install: flock missing" >&2; exit 1; }
command -v curl > /dev/null || { echo "install: curl missing" >&2; exit 1; }

say "system user"
if ! id "$SVC" > /dev/null 2>&1; then
  run useradd --system --home-dir /var/lib/$SVC --shell /usr/sbin/nologin "$SVC"
fi
if getent group systemd-journal > /dev/null 2>&1 && ! id -nG "$SVC" 2> /dev/null | tr ' ' '\n' | grep -qx systemd-journal; then
  run usermod -aG systemd-journal "$SVC"
fi

say "directories"
run install -d -m 0755 -o "$SVC" -g "$SVC" /opt/$SVC /opt/$SVC/releases
run install -d -m 0755 -o "$SVC" -g "$SVC" /var/lib/$SVC
run install -d -m 0755 -o "$SVC" -g "$SVC" /var/lib/$SVC/data
run install -d -m 0750 -o "$SVC" -g "$SVC" /var/lib/$SVC/state
run install -d -m 0755 -o root -g "$SVC" /etc/$SVC

say "environment files (kept if present)"
write_env() {
  local name="$1" body="$2" dst="/etc/$SVC/$1"
  if [ -e "$dst" ]; then say "keeping $dst"; return; fi
  if [ "$DRY" -eq 1 ]; then echo "  would create $dst (0640 root:$SVC)"; return; fi
  printf '%s\n' "$body" > "$dst"
  chown root:"$SVC" "$dst"
  chmod 0640 "$dst"
}
write_env updater.env "REPO=Mais-Democracia/Estado-Aberto
CHANNEL=stable
GITHUB_TOKEN="
write_env app.env "PORT=3000
HOST=0.0.0.0"
write_env ingest.env "ESTADO_ABERTO_CONTACT="

say "node and python symlinks and helper scripts"
run ln -sfn "$NODE_BIN" /usr/local/bin/estado-aberto-node
run ln -sfn "$PYTHON_BIN" /usr/local/bin/estado-aberto-python
put 0755 "$HERE/updater/estado-aberto-updater.sh" /usr/local/sbin/estado-aberto-updater
put 0755 "$HERE/updater/ingest-queue-runner.sh" /usr/local/sbin/estado-aberto-ingest-queue
put 0644 "$HERE/updater/lock.sh" /usr/local/sbin/estado-aberto-lock.sh
put 0755 "$HERE/updater/with-lock.sh" /usr/local/sbin/estado-aberto-with-lock
put 0755 "$HERE/updater/alert.sh" /usr/local/sbin/estado-aberto-alert

say "sudoers rule for the updater"
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<SUDO
$SVC ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SVC.service, /usr/bin/systemctl start --no-block $SVC-ingest-queue.service
SUDO
if [ "$DRY" -eq 1 ]; then
  echo "  would validate and install sudoers rule /etc/sudoers.d/$SVC"
elif visudo -cf "$SUDOERS_TMP" > /dev/null; then
  install -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/$SVC
else
  echo "install: sudoers validation failed" >&2
  rm -f "$SUDOERS_TMP"
  exit 1
fi
rm -f "$SUDOERS_TMP"

say "systemd units"
for u in "$HERE"/systemd/*.service "$HERE"/systemd/*.timer; do
  put 0644 "$u" "/etc/systemd/system/$(basename "$u")"
done
run systemctl daemon-reload
run systemctl enable $SVC.service
if [ "$TIMERS" -eq 1 ]; then
  run systemctl enable --now $SVC-updater.timer $SVC-refresh.timer $SVC-daily.timer $SVC-weekly.timer
  run systemctl try-restart $SVC-updater.timer $SVC-refresh.timer $SVC-daily.timer $SVC-weekly.timer
else
  say "timers installed but not enabled; rerun with --enable-timers when ready"
fi

if [ "$SWAP" -eq 1 ]; then
  say "swap"
  if [ -n "$(swapon --show --noheadings 2> /dev/null)" ]; then
    say "swap already active, leaving it"
  else
    if [ ! -e /swapfile ]; then
      run fallocate -l 2G /swapfile
      run chmod 600 /swapfile
      run mkswap /swapfile
    fi
    run swapon /swapfile
    if ! grep -q '^/swapfile ' /etc/fstab 2> /dev/null; then
      if [ "$DRY" -eq 1 ]; then echo "  would append /swapfile to /etc/fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
    fi
  fi
  if [ "$DRY" -eq 1 ]; then
    echo "  would write /etc/sysctl.d/99-$SVC.conf (vm.swappiness=10)"
  else
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-$SVC.conf
    sysctl -q -p /etc/sysctl.d/99-$SVC.conf
  fi
fi

say "done. Next: sudo -u $SVC /usr/local/sbin/estado-aberto-updater --force-tag vX.Y.Z"
