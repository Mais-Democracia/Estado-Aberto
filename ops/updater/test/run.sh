#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER="$HERE/../estado-aberto-updater.sh"
T="$(mktemp -d /tmp/ea-updater-test.XXXXXX)"
export OPT_DIR="$T/opt" STATE_DIR="$T/state" DATA_DIR="$T/data" CONF_FILE="$T/updater.env"
export API_BASE="http://127.0.0.1:3170" HEALTH_URL="http://127.0.0.1:3170/api/status" HEALTH_TIMEOUT=4
export RESTART_CMD=true QUEUE_START_CMD=true EA_FREE_GB=50 EA_AVAIL_MB=800
FIX="$T/fixtures"
mkdir -p "$OPT_DIR" "$STATE_DIR" "$DATA_DIR" "$FIX/assets"
echo 'REPO=test/repo' > "$CONF_FILE"
echo canary-content > "$DATA_DIR/canary.db"
CANARY_SUM="$(sha256sum "$DATA_DIR/canary.db" | cut -d' ' -f1)"

node "$HERE/stub.mjs" "$FIX" "$OPT_DIR" &
STUB=$!
cleanup() { kill "$STUB" 2> /dev/null; rm -rf "$T"; }
trap cleanup EXIT
for _ in $(seq 20); do curl -s -o /dev/null "http://127.0.0.1:3170/x" && break; sleep 0.2; done

pass=0; failn=0
check() {
  if [ "$2" = 0 ]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1"; failn=$((failn + 1)); fi
}
cur() { cat "$OPT_DIR/current/VERSION" 2> /dev/null || echo none; }

publish() {
  local ver="$1" healthy="$2" corrupt="${3:-0}" src="$T/src-$1" tag="v$1"
  rm -rf "$src"; mkdir -p "$src/tools" "$src/data"
  echo "$ver" > "$src/VERSION"
  echo 'import sys; sys.exit(0)' > "$src/tools/doctor.py"
  touch "$src/data/.gitkeep"
  [ "$healthy" = 1 ] && touch "$src/HEALTHY"
  python3 -I - "$src/release-manifest.json" "$ver" <<'PY'
import json, sys
json.dump({"version": sys.argv[2], "git_sha": "0" * 40, "min_updater_version": 1, "node_version": "22",
           "python_min": "3.12", "resources": {"min_ram_mb": 200, "min_free_disk_gb": 5},
           "post_update": [{"step": "doctor"}],
           "ingest": {"run_on_update": ["agenda"], "schedule_changes": []},
           "migrations": [], "notes": ""}, open(sys.argv[1], "w"))
PY
  rm -f "$FIX"/assets/*
  tar -czf "$FIX/assets/estado-aberto-$tag.tar.gz" -C "$src" VERSION tools data $([ "$healthy" = 1 ] && echo HEALTHY)
  cp "$src/release-manifest.json" "$FIX/assets/release-manifest.json"
  (cd "$FIX/assets" && sha256sum "estado-aberto-$tag.tar.gz" release-manifest.json > SHA256SUMS)
  [ "$corrupt" = 1 ] && echo tampered >> "$FIX/assets/estado-aberto-$tag.tar.gz"
  python3 -I - "$FIX/latest.json" "$tag" <<'PY'
import json, sys
base = "http://127.0.0.1:3170/assets/"
tag = sys.argv[2]
names = ["estado-aberto-%s.tar.gz" % tag, "SHA256SUMS", "release-manifest.json"]
json.dump({"tag_name": tag, "prerelease": False,
           "assets": [{"name": n, "url": base + n} for n in names]}, open(sys.argv[1], "w"))
PY
}

canary_ok() { [ "$(sha256sum "$DATA_DIR/canary.db" | cut -d' ' -f1)" = "$CANARY_SUM" ]; }

publish 0.1.0 1
bash "$UPDATER" > "$T/o1.log" 2>&1
[ "$(cur)" = 0.1.0 ] && [ "$(readlink -f "$OPT_DIR/current/data")" = "$DATA_DIR" ]
check "update installs v0.1.0 and links shared data" $?
ls "$STATE_DIR/ingest-queue/v0.1.0.json" > /dev/null 2>&1
check "ingest jobs queued after switch" $?

bash "$UPDATER" > "$T/o2.log" 2>&1
grep -q "already up to date" "$T/o2.log"
check "no-op when current" $?

publish 0.2.0 1 1
bash "$UPDATER" > "$T/o3.log" 2>&1
[ "$(cur)" = 0.1.0 ] && [ ! -d "$OPT_DIR/releases/v0.2.0" ] && grep -q "checksum verification failed" "$T/o3.log"
check "bad checksum refused" $?

publish 0.3.0 0
bash "$UPDATER" > "$T/o4.log" 2>&1
[ "$(cur)" = 0.1.0 ] && grep -q "rolled back to v0.1.0" "$T/o4.log"
check "health failure rolls back" $?

publish 0.2.0 1
EA_FREE_GB=1 bash "$UPDATER" > "$T/o5.log" 2>&1
[ "$(cur)" = 0.1.0 ] && grep -q "free disk 1 GB below" "$T/o5.log"
check "low disk refused" $?

bash "$UPDATER" > "$T/o6.log" 2>&1
[ "$(cur)" = 0.2.0 ]
check "good update after failures" $?

bash "$UPDATER" --rollback > "$T/o7.log" 2>&1
[ "$(cur)" = 0.1.0 ]
check "manual rollback" $?

canary_ok
check "data canary untouched" $?
[ "$(ls "$OPT_DIR/releases" | wc -l)" -le 2 ]
check "at most 2 releases kept" $?

PYLOG="$T/py.log"
printf '#!/usr/bin/env bash\necho "$*" >> "%s"\nexec python3 "$@"\n' "$PYLOG" > "$T/mypy"
chmod +x "$T/mypy"
ESTADO_ABERTO_PYTHON="$T/mypy" bash "$UPDATER" --check > "$T/o8.log" 2>&1
[ -s "$PYLOG" ]
check "updater honours ESTADO_ABERTO_PYTHON" $?

NODE_PATH_T="$(command -v node)"
bash "$HERE/../../install.sh" --dry-run --no-swap --node "$NODE_PATH_T" --python "$(command -v python3)" > "$T/i1.log" 2>&1
grep -q "estado-aberto-python" "$T/i1.log"
check "installer links estado-aberto-python" $?
printf '#!/bin/sh\necho "Python 3.9.0"\nexit 1\n' > "$T/oldpy"
chmod +x "$T/oldpy"
bash "$HERE/../../install.sh" --dry-run --no-swap --node "$NODE_PATH_T" --python "$T/oldpy" > "$T/i2.log" 2>&1
[ $? -ne 0 ] && grep -q "older than Python 3.12" "$T/i2.log"
check "installer refuses Python older than 3.12" $?

OPS="$(cd "$HERE/../.." && pwd)"
LIB="$OPS/updater/lock.sh"
LK="$T/lk"; mkdir -p "$LK"

hold() {
  STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire "$2" 10 0.1 && sleep "$3"' _ "$LIB" "$1" "$2" &
  HOLDER=$!
  for _ in $(seq 50); do grep -q "^$1 " "$LK/update.lock" 2> /dev/null && break; sleep 0.1; done
}

hold ingest 3
STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire updater 1 0.1' _ "$LIB" > "$T/l1.log" 2>&1
rc=$?
[ "$rc" -ne 0 ] && grep -q "gave up after 1s waiting for update.lock held by ingest" "$T/l1.log"
check "lock waits then gives up with a clear log" $?
wait "$HOLDER"

hold ai 2
( STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire ingest 20 0.1 && echo ingest >> "$2" && sleep 0.3' _ "$LIB" "$LK/order" ) &
ING=$!
sleep 0.5
( STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire updater 20 0.1 && echo updater >> "$2" && sleep 0.3' _ "$LIB" "$LK/order" ) &
UPD=$!
wait "$HOLDER" "$ING" "$UPD"
[ "$(tr '\n' ' ' < "$LK/order")" = "updater ingest " ]
check "pending updater is served before an earlier-waiting ingest run" $?

hold ingest 2
( STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire ai 20 0.1 && echo ai >> "$2"' _ "$LIB" "$LK/order2" ) &
AI=$!
sleep 0.4
( STATE_DIR="$LK" bash -c '. "$1"; ea_lock_acquire ingest 20 0.1 && echo ingest >> "$2" && sleep 0.3' _ "$LIB" "$LK/order2" ) &
ING2=$!
wait "$HOLDER" "$AI" "$ING2"
[ "$(tr '\n' ' ' < "$LK/order2")" = "ingest ai " ]
check "ingest is served before an earlier-waiting ai run" $?

hold ingest 3
STATE_DIR="$LK" UPDATER_LOCK_WAIT=1 EA_LOCK_POLL=0.1 EA_LOCK_LIB="$LIB" bash "$UPDATER" --check > "$T/l2.log" 2>&1
rc=$?
[ "$rc" -eq 0 ] && grep -q "gave up after 1s" "$T/l2.log" && grep -q "try again later" "$T/l2.log"
check "updater gives up on a busy lock without failing the unit" $?
wait "$HOLDER"

STATE_DIR="$LK" EA_LOCK_POLL=0.1 bash "$OPS/updater/with-lock.sh" ai --wait 5 -- bash -c 'echo "held=$EA_LOCK_HELD" > "$1"' _ "$LK/wl" > /dev/null 2>&1
[ "$(cat "$LK/wl" 2> /dev/null)" = "held=1" ]
check "with-lock runs the command and marks the lock held" $?

hold updater 3
STATE_DIR="$LK" EA_LOCK_POLL=0.1 bash "$OPS/updater/with-lock.sh" ai --wait 1 -- true > "$T/l3.log" 2>&1
rc=$?
[ "$rc" -eq 75 ] && grep -q "gave up" "$T/l3.log"
check "with-lock exits 75 on timeout" $?
wait "$HOLDER"

AS="$T/alert-state"; mkdir -p "$AS"
STATE_DIR="$AS" JOURNAL_CMD="seq 1 40" ESTADO_ABERTO_PYTHON=python3 bash "$OPS/updater/alert.sh" estado-aberto-refresh.service
STATE_DIR="$AS" JOURNAL_CMD="echo second" ESTADO_ABERTO_PYTHON=python3 bash "$OPS/updater/alert.sh" estado-aberto-daily.service
python3 -I - "$AS/alerts.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))["alerts"]
ok = len(a) == 2 and a[0]["unit"] == "estado-aberto-refresh.service" and len(a[0]["lines"]) == 20 and a[0]["lines"][-1] == "40" \
    and a[1]["lines"] == ["second"] and a[1]["time"].endswith("+00:00")
sys.exit(0 if ok else 1)
PY
check "alert writes unit, time and the last 20 lines, and appends" $?

syn=0
for f in "$OPS"/install.sh "$OPS"/updater/*.sh "$HERE"/run.sh "$OPS"/../update.sh "$OPS"/../daily.sh; do
  bash -n "$f" || { echo "syntax error in $f"; syn=1; }
done
check "bash -n on every script" $syn

bash "$OPS/install.sh" --dry-run --no-swap --node "$NODE_PATH_T" --python "$(command -v python3)" > "$T/i3.log" 2>&1
bash "$OPS/install.sh" --dry-run --no-swap --node "$NODE_PATH_T" --python "$(command -v python3)" > "$T/i3b.log" 2>&1
n=0
for u in refresh.service refresh.timer daily.service daily.timer weekly.service weekly.timer "alert@.service"; do
  grep -q "estado-aberto-$u" "$T/i3.log" && n=$((n + 1))
done
grep -q "estado-aberto-lock.sh" "$T/i3.log" && grep -q "estado-aberto-alert" "$T/i3.log" && grep -q "estado-aberto-with-lock" "$T/i3.log"
r=$?
[ "$n" -eq 7 ] && [ "$r" -eq 0 ] && cmp -s "$T/i3.log" "$T/i3b.log"
check "installer installs the refresh, daily, weekly and alert units idempotently" $?
! grep -q "enable.*refresh.timer" "$T/i3.log"
check "installer enables no timer by default" $?
bash "$OPS/install.sh" --dry-run --no-swap --enable-timers --node "$NODE_PATH_T" --python "$(command -v python3)" > "$T/i4.log" 2>&1
grep -q "systemctl enable --now estado-aberto-updater.timer estado-aberto-refresh.timer estado-aberto-daily.timer estado-aberto-weekly.timer" "$T/i4.log"
check "--enable-timers enables updater, refresh, daily and weekly" $?

grep -q "estado-aberto-ai.service" "$T/i3.log" && grep -q "estado-aberto-ai-import.service" "$T/i3.log" && grep -q "estado-aberto-ai.timer" "$T/i3.log" && grep -q "useradd.*estado-aberto-ai" "$T/i3.log" && grep -q "/etc/estado-aberto/ai.env (0640 root:estado-aberto-ai)" "$T/i3.log"
check "installer installs the AI units, user and ai.env" $?
! grep -q "systemctl enable.*ai.timer" "$T/i3.log" "$T/i4.log"
check "installer never enables the AI timer unless asked" $?
bash "$OPS/install.sh" --dry-run --no-swap --enable-ai-timer --node "$NODE_PATH_T" --python "$(command -v python3)" > "$T/i5.log" 2>&1
grep -q "systemctl enable --now estado-aberto-ai.timer" "$T/i5.log" && ! grep -q "enable --now estado-aberto-updater.timer" "$T/i5.log"
check "--enable-ai-timer enables only the AI timer" $?
n=0
for u in estado-aberto-ai.service estado-aberto-ai-import.service; do
  grep -q "^ExecStart=/usr/local/sbin/estado-aberto-with-lock ai --wait 1500 -- " "$OPS/systemd/$u" && ! grep -q "flock" "$OPS/systemd/$u" && n=$((n + 1))
done
[ "$n" -eq 2 ]
check "AI units take the shared ordered lock instead of plain flock" $?

if command -v systemd-analyze > /dev/null 2>&1; then
  UV="$T/units"; mkdir -p "$UV"
  for u in "$OPS"/systemd/*.service "$OPS"/systemd/*.timer; do
    sed -E 's#^(Exec[A-Za-z]*=)[^ ]+#\1/bin/true#; /^(User|Group)=/d; /^EnvironmentFile=/d; /^WorkingDirectory=/d' "$u" > "$UV/$(basename "$u")"
  done
  systemd-analyze verify "$UV"/estado-aberto-refresh.* "$UV"/estado-aberto-daily.* "$UV"/estado-aberto-weekly.* "$UV/estado-aberto-alert@.service" "$UV"/estado-aberto-updater.* "$UV/estado-aberto-ingest-queue.service" > "$T/sd.out" 2>&1
  sdrc=$?
  cat "$T/sd.out"
  check "systemd-analyze verify accepts the units" $sdrc
fi

echo "passed=$pass failed=$failn"
[ "$failn" -eq 0 ]
