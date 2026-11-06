#!/usr/bin/env bash
set -uo pipefail
STATE_DIR="${STATE_DIR:-/var/lib/estado-aberto/state}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=""
for c in "${EA_LOCK_LIB:-}" "$HERE/estado-aberto-lock.sh" "$HERE/lock.sh"; do
  [ -n "$c" ] && [ -r "$c" ] && { LIB="$c"; break; }
done
[ -n "$LIB" ] || { echo "with-lock: lock library not found" >&2; exit 2; }
. "$LIB"

ROLE="${1:-}"
[ -n "$ROLE" ] || { echo "usage: estado-aberto-with-lock <updater|ingest|ai> [--wait SECONDS] -- command [args...]" >&2; exit 2; }
shift
WAIT="${EA_LOCK_WAIT:-7200}"
if [ "${1:-}" = "--wait" ]; then WAIT="${2:?--wait needs seconds}"; shift 2; fi
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "with-lock: no command" >&2; exit 2; }

ea_lock_acquire "$ROLE" "$WAIT"
rc=$?
if [ "$rc" -ne 0 ]; then
  [ "$rc" -eq "$EA_LOCK_UNAVAILABLE" ] && exit "$EA_LOCK_UNAVAILABLE"
  exit 75
fi
export EA_LOCK_HELD=1
"$@"
