#!/usr/bin/env bash
ea_prio() {
  case "$1" in
    updater) echo 0 ;;
    ingest) echo 1 ;;
    ai) echo 2 ;;
    *) echo 9 ;;
  esac
}

ea_higher_waiting() {
  local mine f base rest role pid
  mine="$(ea_prio "$1")"
  for f in "$STATE_DIR"/lock.want.*.*; do
    [ -e "$f" ] || continue
    base="${f##*/}"
    rest="${base#lock.want.}"
    pid="${rest##*.}"
    role="${rest%.*}"
    [ "$(ea_prio "$role")" -lt "$mine" ] || continue
    [ "$pid" = "$$" ] && continue
    if kill -0 "$pid" 2> /dev/null; then
      echo "$role"
      return 0
    fi
    rm -f "$f"
  done
  return 1
}

ea_lock_holder() {
  tr -d '\n' < "$STATE_DIR/update.lock" 2> /dev/null || true
}

ea_lock_acquire() {
  local role="${1:?role}" wait="${2:-7200}" poll="${3:-${EA_LOCK_POLL:-2}}" want deadline blocker announced=0
  [ "${EA_LOCK_HELD:-}" = 1 ] && return 0
  mkdir -p "$STATE_DIR" || return 1
  want="$STATE_DIR/lock.want.$role.$$"
  echo "$$" > "$want"
  exec 9>> "$STATE_DIR/update.lock"
  deadline=$((SECONDS + wait))
  while :; do
    blocker="$(ea_higher_waiting "$role" || true)"
    if [ -z "$blocker" ] && flock -n 9; then
      printf '%s %s\n' "$role" "$$" > "$STATE_DIR/update.lock"
      rm -f "$want"
      [ "$announced" -eq 0 ] || echo "[$(date -u +%FT%TZ)] lock: acquired update.lock as $role"
      return 0
    fi
    if [ "$announced" -eq 0 ]; then
      echo "[$(date -u +%FT%TZ)] lock: waiting for update.lock (${blocker:+a pending $blocker run}${blocker:-held by $(ea_lock_holder)}); giving up after ${wait}s"
      announced=1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "[$(date -u +%FT%TZ)] lock: gave up after ${wait}s waiting for update.lock held by $(ea_lock_holder); this $role run did not start"
      rm -f "$want"
      exec 9>&-
      return 1
    fi
    sleep "$poll"
  done
}

ea_lock_release() {
  exec 9>&-
}
