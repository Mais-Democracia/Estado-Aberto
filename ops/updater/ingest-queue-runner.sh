#!/usr/bin/env bash
set -uo pipefail

OPT_DIR="${OPT_DIR:-/opt/estado-aberto}"
STATE_DIR="${STATE_DIR:-/var/lib/estado-aberto/state}"
DATA_DIR="${DATA_DIR:-/var/lib/estado-aberto/data}"
SETTLE_SECONDS="${SETTLE_SECONDS:-90}"
LOCK_WAIT="${LOCK_WAIT:-7200}"
PY="${ESTADO_ABERTO_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /usr/local/bin/estado-aberto-python ]; then PY=/usr/local/bin/estado-aberto-python; else PY=python3; fi
fi

log() { echo "[$(date -u +%FT%TZ)] $*"; }

exec 9> "$STATE_DIR/update.lock"
flock -w "$LOCK_WAIT" 9 || { log "could not get the lock; jobs stay queued"; exit 0; }

shopt -s nullglob
queue=("$STATE_DIR"/ingest-queue/*.json)
[ "${#queue[@]}" -gt 0 ] || { log "queue empty"; exit 0; }
sleep "$SETTLE_SECONDS"

for q in "${queue[@]}"; do
  tag="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag"])' "$q")"
  jobs="$("$PY" -I -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["jobs"]))' "$q")"
  log "running queued ingest for $tag: $jobs"
  cd "$OPT_DIR/current" || exit 1
  ESTADO_ABERTO_DATA="$DATA_DIR" "$PY" ingest/run_all.py --only "$jobs" --profile server
  rc=$?
  "$PY" -I - "$STATE_DIR/last_update.json" "$tag" "$jobs" "$rc" <<'PY'
import datetime, json, sys
path, tag, jobs, rc = sys.argv[1:5]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d["ingest"] = {"tag": tag, "jobs": jobs.split(","), "exit_code": int(rc), "at": datetime.datetime.utcnow().isoformat() + "Z"}
json.dump(d, open(path, "w"), indent=2)
PY
  rm -f "$q"
done
