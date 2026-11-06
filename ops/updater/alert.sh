#!/usr/bin/env bash
set -uo pipefail
UNIT="${1:?usage: estado-aberto-alert <unit>}"
STATE_DIR="${STATE_DIR:-/var/lib/estado-aberto/state}"
LINES="${ALERT_LINES:-20}"
MAX_ALERTS="${ALERT_MAX:-50}"
JOURNAL_CMD="${JOURNAL_CMD:-journalctl -u $UNIT -n $LINES --no-pager -o cat}"
PY="${ESTADO_ABERTO_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /usr/local/bin/estado-aberto-python ]; then PY=/usr/local/bin/estado-aberto-python; else PY=python3; fi
fi
mkdir -p "$STATE_DIR" || exit 1
TAIL="$($JOURNAL_CMD 2> /dev/null | tail -n "$LINES")"
exec 8> "$STATE_DIR/alerts.lock"
flock -w 30 8 || exit 1
printf '%s\n' "$TAIL" | "$PY" -I -c '
import datetime, json, os, sys
path, unit, cap, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
lines = sys.stdin.read().rstrip("\n").splitlines()[-n:]
try:
    d = json.load(open(path))
    alerts = d["alerts"] if isinstance(d, dict) else []
except Exception:
    alerts = []
alerts.append({"unit": unit, "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "lines": lines})
tmp = path + ".tmp"
json.dump({"version": 1, "alerts": alerts[-cap:]}, open(tmp, "w"), indent=2, ensure_ascii=False)
os.replace(tmp, path)
' "$STATE_DIR/alerts.json" "$UNIT" "$MAX_ALERTS" "$LINES"
