#!/usr/bin/env bash
set -uo pipefail

UPDATER_VERSION=1
CONF_FILE="${CONF_FILE:-/etc/estado-aberto/updater.env}"
OPT_DIR="${OPT_DIR:-/opt/estado-aberto}"
STATE_DIR="${STATE_DIR:-/var/lib/estado-aberto/state}"
DATA_DIR="${DATA_DIR:-/var/lib/estado-aberto/data}"
API_BASE="${API_BASE:-https://api.github.com}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/status}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
RESTART_CMD="${RESTART_CMD:-sudo -n systemctl restart estado-aberto.service}"
QUEUE_START_CMD="${QUEUE_START_CMD:-sudo -n systemctl start --no-block estado-aberto-ingest-queue.service}"
MIN_FREE_GB="${MIN_FREE_GB:-5}"
MIN_AVAIL_MB="${MIN_AVAIL_MB:-200}"
LOCK_WAIT="${UPDATER_LOCK_WAIT:-7200}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_LIB=""
for c in "${EA_LOCK_LIB:-}" "$HERE/estado-aberto-lock.sh" "$HERE/lock.sh"; do
  [ -n "$c" ] && [ -r "$c" ] && { LOCK_LIB="$c"; break; }
done
[ -n "$LOCK_LIB" ] || { echo "lock library not found" >&2; exit 1; }
. "$LOCK_LIB"

REPO="Mais-Democracia/Estado-Aberto"
CHANNEL="stable"
GITHUB_TOKEN=""
[ -r "$CONF_FILE" ] && . "$CONF_FILE"
PY="${ESTADO_ABERTO_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /usr/local/bin/estado-aberto-python ]; then PY=/usr/local/bin/estado-aberto-python; else PY=python3; fi
fi

MODE=update
FORCE_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --rollback) MODE=rollback; shift ;;
    --force-tag) FORCE_TAG="${2:-}"; [ -n "$FORCE_TAG" ] || { echo "--force-tag needs vX.Y.Z" >&2; exit 2; }; shift 2 ;;
    -h|--help) echo "usage: estado-aberto-updater [--check] [--force-tag vX.Y.Z] [--rollback]"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -z "$FORCE_TAG" ] || MODE=force

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "ERROR: $*"; write_state failed "$*"; exit 1; }

mkdir -p "$STATE_DIR" "$OPT_DIR/releases" 2>/dev/null || { echo "cannot create state dirs" >&2; exit 1; }
ea_lock_acquire updater "$LOCK_WAIT"
rc=$?
if [ "$rc" -eq "$EA_LOCK_UNAVAILABLE" ]; then log "update.lock is unusable; fix its ownership or mode"; exit "$EA_LOCK_UNAVAILABLE"; fi
[ "$rc" -eq 0 ] || { log "update.lock still busy after ${LOCK_WAIT}s; try again later"; exit 0; }

write_state() {
  "$PY" -I - "$STATE_DIR/last_update.json" "$1" "${2:-}" "${TARGET_TAG:-}" <<'PY'
import datetime, json, sys
path, status, msg, tag = sys.argv[1:5]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d.update({"status": status, "message": msg, "tag": tag, "at": datetime.datetime.utcnow().isoformat() + "Z"})
json.dump(d, open(path, "w"), indent=2)
PY
}

curl_auth() {
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsSL --retry 3 --retry-delay 2 --max-time 600 -K <(printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN") "$@"
  else
    curl -fsSL --retry 3 --retry-delay 2 --max-time 600 "$@"
  fi
}

jget() {
  "$PY" -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d if not isinstance(d, (dict, list)) else json.dumps(d))
' "$@"
}

current_tag() {
  if [ -r "$OPT_DIR/current/VERSION" ]; then echo "v$(tr -d '[:space:]' < "$OPT_DIR/current/VERSION")"; else echo none; fi
}

free_gb() {
  if [ -n "${EA_FREE_GB:-}" ]; then echo "$EA_FREE_GB"; return; fi
  df -P -BG "$OPT_DIR" | awk 'NR==2 {gsub("G","",$4); print $4}'
}

avail_mb() {
  if [ -n "${EA_AVAIL_MB:-}" ]; then echo "$EA_AVAIL_MB"; return; fi
  awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo
}

resource_guard() {
  local need_gb="$1" need_mb="$2" gb mb
  gb="$(free_gb)"; mb="$(avail_mb)"
  [ "$gb" -ge "$MIN_FREE_GB" ] || die "free disk ${gb} GB below the ${MIN_FREE_GB} GB floor"
  [ "$gb" -ge "$need_gb" ] || die "free disk ${gb} GB below release requirement ${need_gb} GB"
  [ "$mb" -ge "$MIN_AVAIL_MB" ] || die "available RAM ${mb} MB below the ${MIN_AVAIL_MB} MB floor"
  [ "$mb" -ge "$need_mb" ] || die "available RAM ${mb} MB below release requirement ${need_mb} MB"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL" 2> /dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

switch_to() {
  ln -sfn "$OPT_DIR/releases/$1" "$OPT_DIR/.current.new" && mv -T "$OPT_DIR/.current.new" "$OPT_DIR/current"
}

previous_release() {
  local cur="$1" t
  for t in $(ls -1t "$OPT_DIR/releases" 2> /dev/null); do
    [ "$t" = "$cur" ] || [ ! -d "$OPT_DIR/releases/$t" ] || { echo "$t"; return; }
  done
}

prune() {
  local cur prev="$1" t
  cur="$(basename "$(readlink -f "$OPT_DIR/current")")"
  [ -n "$prev" ] || prev="$(previous_release "$cur")"
  for t in $(ls -1t "$OPT_DIR/releases"); do
    [ "$t" = "$cur" ] || [ "$t" = "$prev" ] && continue
    log "pruning release $t"
    rm -rf "${OPT_DIR:?}/releases/$t"
  done
}

do_rollback() {
  local cur prev
  cur="$(basename "$(readlink -f "$OPT_DIR/current")")"
  prev="$(previous_release "$cur")"
  [ -n "$prev" ] || die "no previous release to roll back to"
  TARGET_TAG="$prev"
  log "rolling back $cur -> $prev"
  switch_to "$prev" || die "could not switch symlink"
  $RESTART_CMD || log "restart command failed"
  if wait_healthy; then
    write_state rolled_back "rolled back from $cur to $prev"
    log "rollback healthy"
  else
    die "rollback target $prev is not healthy either"
  fi
}

latest_info() {
  local out="$STATE_DIR/latest.json" url
  if [ -n "$FORCE_TAG" ]; then url="$API_BASE/repos/$REPO/releases/tags/$FORCE_TAG"; else url="$API_BASE/repos/$REPO/releases/latest"; fi
  curl_auth -H 'Accept: application/vnd.github+json' -o "$out" "$url" || die "cannot query $url"
  echo "$out"
}

asset_url() {
  "$PY" -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
for a in d.get("assets", []):
    if a["name"] == sys.argv[2]:
        print(a["url"]); break
' "$1" "$2"
}

[ "$MODE" != rollback ] || { do_rollback; exit 0; }

info="$(latest_info)"
TARGET_TAG="$(jget "$info" tag_name)"
[ "$CHANNEL" = stable ] && [ -z "$FORCE_TAG" ] && [ "$(jget "$info" prerelease)" = True ] && { log "latest is a prerelease; ignoring"; exit 0; }
[[ "$TARGET_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected tag name"
CUR_TAG="$(current_tag)"
log "current=$CUR_TAG latest=$TARGET_TAG"

if [ "$MODE" = check ]; then
  [ "$CUR_TAG" = "$TARGET_TAG" ] && echo "up-to-date $CUR_TAG" || echo "update-available $CUR_TAG -> $TARGET_TAG"
  exit 0
fi

if [ "$CUR_TAG" = "$TARGET_TAG" ]; then
  log "already up to date"
  exit 0
fi
if [ -z "$FORCE_TAG" ] && [ "$(cat "$STATE_DIR/failed_tag" 2> /dev/null)" = "$TARGET_TAG" ]; then
  log "$TARGET_TAG previously failed health check; use --force-tag to retry"
  exit 0
fi

resource_guard "$MIN_FREE_GB" "$MIN_AVAIL_MB"

WORK="$(mktemp -d "$OPT_DIR/releases/.tmp-XXXXXX")" || die "cannot create work dir"
trap 'rm -rf "$WORK"' EXIT
TARBALL="estado-aberto-$TARGET_TAG.tar.gz"

for name in "$TARBALL" SHA256SUMS release-manifest.json; do
  u="$(asset_url "$info" "$name")"
  [ -n "$u" ] || die "release $TARGET_TAG has no asset $name"
  curl_auth -H 'Accept: application/octet-stream' -o "$WORK/$name" "$u" || die "download of $name failed"
done

(cd "$WORK" && sha256sum --check --strict SHA256SUMS > /dev/null 2>&1) || die "checksum verification failed for $TARGET_TAG"
log "checksums verified"

MAN="$WORK/release-manifest.json"
[ "$(jget "$MAN" version)" = "${TARGET_TAG#v}" ] || die "manifest version does not match tag"
MIN_UPD="$(jget "$MAN" min_updater_version)"
[ "$UPDATER_VERSION" -ge "$MIN_UPD" ] || die "release needs updater version $MIN_UPD (have $UPDATER_VERSION); reinstall the updater from the release"
resource_guard "$(jget "$MAN" resources.min_free_disk_gb)" "$(jget "$MAN" resources.min_ram_mb)"

if tar -tzf "$WORK/$TARBALL" | grep -qE '^/|(^|/)\.\.(/|$)'; then die "tarball contains unsafe paths"; fi
STAGE="$WORK/stage"
mkdir -p "$STAGE"
tar -xzf "$WORK/$TARBALL" -C "$STAGE" --no-same-owner || die "unpack failed"
[ "$(tr -d '[:space:]' < "$STAGE/VERSION")" = "${TARGET_TAG#v}" ] || die "VERSION inside tarball does not match tag"

rm -rf "$STAGE/data"
ln -s "$DATA_DIR" "$STAGE/data"
rm -rf "${OPT_DIR:?}/releases/$TARGET_TAG"
mv "$STAGE" "$OPT_DIR/releases/$TARGET_TAG" || die "cannot place release"
REL="$OPT_DIR/releases/$TARGET_TAG"

run_post() {
  local n i step cmd id
  n="$("$PY" -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["post_update"]))' "$MAN")"
  for ((i = 0; i < n; i++)); do
    step="$(jget "$MAN" "post_update.$i.step")"
    case "$step" in
      doctor)
        log "post_update: doctor"
        (cd "$REL" && ESTADO_ABERTO_DATA="$DATA_DIR" "$PY" tools/doctor.py --offline) || return 1 ;;
      *) log "post_update: unknown step $step ignored" ;;
    esac
  done
  n="$("$PY" -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["migrations"]))' "$MAN")"
  for ((i = 0; i < n; i++)); do
    id="$(jget "$MAN" "migrations.$i.id")"
    cmd="$(jget "$MAN" "migrations.$i.command")"
    log "migration $id"
    (cd "$REL" && ESTADO_ABERTO_DATA="$DATA_DIR" bash -c "$cmd") || return 1
  done
}
if ! run_post; then
  rm -rf "$REL"
  die "post-update checks failed; $TARGET_TAG not activated"
fi

PREV_TAG="$(basename "$(readlink -f "$OPT_DIR/current" 2> /dev/null || true)")"
log "switching current -> $TARGET_TAG"
switch_to "$TARGET_TAG" || die "could not switch symlink"
$RESTART_CMD || log "restart command returned non-zero"

if wait_healthy; then
  log "healthy after switch"
  rm -f "$STATE_DIR/failed_tag"
else
  log "unhealthy after ${HEALTH_TIMEOUT}s"
  echo "$TARGET_TAG" > "$STATE_DIR/failed_tag"
  if [ -n "$PREV_TAG" ] && [ -d "$OPT_DIR/releases/$PREV_TAG" ]; then
    switch_to "$PREV_TAG"
    rm -rf "${OPT_DIR:?}/releases/$TARGET_TAG"
    $RESTART_CMD || log "restart command returned non-zero"
    if wait_healthy; then
      write_state rolled_back "$TARGET_TAG failed health check; restored $PREV_TAG"
      log "rolled back to $PREV_TAG"
      exit 1
    fi
  fi
  die "$TARGET_TAG unhealthy and rollback did not recover"
fi

JOBS="$("$PY" -I -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["ingest"]["run_on_update"]))' "$MAN")"
if [ -n "$JOBS" ]; then
  mkdir -p "$STATE_DIR/ingest-queue"
  "$PY" -I - "$STATE_DIR/ingest-queue/$TARGET_TAG.json" "$TARGET_TAG" "$JOBS" <<'PY'
import json, sys
json.dump({"tag": sys.argv[2], "jobs": sys.argv[3].split(",")}, open(sys.argv[1], "w"))
PY
  $QUEUE_START_CMD || log "could not start ingest queue runner; jobs stay queued"
  log "queued ingest jobs: $JOBS"
fi

write_state ok "updated ${PREV_TAG:-none} -> $TARGET_TAG"
prune "$PREV_TAG"
log "update complete"
