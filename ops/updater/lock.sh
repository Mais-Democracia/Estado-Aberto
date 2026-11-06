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

EA_LOCK_UNAVAILABLE=77

ea_lock_holder() {
  local f="$STATE_DIR/update.lock" rec pid
  [ -r "$f" ] || { echo unknown; return; }
  if (flock -n 8) 8< "$f" 2> /dev/null; then
    echo "nobody (lock is free)"
    return
  fi
  rec="$(tr -d '\n' < "$f" 2> /dev/null || true)"
  pid="${rec##* }"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2> /dev/null; then
    echo "$rec"
  else
    echo "unknown (stale owner record)"
  fi
}

ea_lock_prepare() {
  local role="$1" f="$STATE_DIR/update.lock" mode
  if [ ! -d "$STATE_DIR" ]; then
    (umask 007; mkdir -p "$STATE_DIR") 2> /dev/null
    [ -O "$STATE_DIR" ] && chmod 2770 "$STATE_DIR" 2> /dev/null
  elif [ -O "$STATE_DIR" ]; then
    mode="$(stat -c %a "$STATE_DIR")"
    if [ $((0$mode & 020)) -eq 0 ] || [ $((0$mode & 02000)) -eq 0 ]; then chmod g+ws "$STATE_DIR" 2> /dev/null; fi
  fi
  if [ ! -d "$STATE_DIR" ]; then
    echo "lock: state directory $STATE_DIR is missing and cannot be created; this $role run did not start"
    return 1
  fi
  if [ -e "$f" ]; then
    if [ -O "$f" ]; then
      mode="$(stat -c %a "$f")"
      [ $((0$mode & 020)) -ne 0 ] || chmod 0660 "$f" 2> /dev/null
    fi
  else
    (umask 007; : >> "$f") 2> /dev/null
    [ -O "$f" ] && chmod 0660 "$f" 2> /dev/null
  fi
  return 0
}

ea_lock_acquire() {
  local role="${1:?role}" wait="${2:-7200}" poll="${3:-${EA_LOCK_POLL:-2}}" want deadline blocker announced=0 who
  [ "${EA_LOCK_HELD:-}" = 1 ] && return 0
  ea_lock_prepare "$role" || return "$EA_LOCK_UNAVAILABLE"
  if ! { exec 9>> "$STATE_DIR/update.lock"; } 2> /dev/null; then
    echo "[$(date -u +%FT%TZ)] lock: cannot open $STATE_DIR/update.lock for writing ($(stat -c 'owner %U:%G mode %a' "$STATE_DIR/update.lock" 2> /dev/null || echo 'no such file'), this process is $(id -un):$(id -gn)); this $role run did not start"
    return "$EA_LOCK_UNAVAILABLE"
  fi
  want="$STATE_DIR/lock.want.$role.$$"
  if ! { echo "$$" > "$want"; } 2> /dev/null; then
    echo "[$(date -u +%FT%TZ)] lock: cannot write $want; this $role run did not start"
    exec 9>&-
    return "$EA_LOCK_UNAVAILABLE"
  fi
  deadline=$((SECONDS + wait))
  while :; do
    blocker="$(ea_higher_waiting "$role" || true)"
    if [ -z "$blocker" ] && flock -n 9; then
      printf '%s %s
' "$role" "$$" > "$STATE_DIR/update.lock"
      rm -f "$want"
      [ "$announced" -eq 0 ] || echo "[$(date -u +%FT%TZ)] lock: acquired update.lock as $role"
      return 0
    fi
    if [ "$announced" -eq 0 ]; then
      echo "[$(date -u +%FT%TZ)] lock: waiting for update.lock (${blocker:+a pending $blocker run}${blocker:-held by $(ea_lock_holder)}); giving up after ${wait}s"
      announced=1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      who="${blocker:+a pending $blocker run}"
      [ -n "$who" ] || who="$(ea_lock_holder)"
      echo "[$(date -u +%FT%TZ)] lock: gave up after ${wait}s waiting for update.lock held by $who; this $role run did not start"
      rm -f "$want"
      exec 9>&-
      return 1
    fi
    sleep "$poll"
  done
}

ea_lock_release() {
  : > "$STATE_DIR/update.lock" 2> /dev/null || true
  exec 9>&-
}
