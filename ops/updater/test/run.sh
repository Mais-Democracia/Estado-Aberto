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

echo "passed=$pass failed=$failn"
[ "$failn" -eq 0 ]
