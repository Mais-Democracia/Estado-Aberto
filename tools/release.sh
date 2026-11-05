#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage() {
  echo "usage: tools/release.sh <patch|minor|major|X.Y.Z> [--run-on-update job1,job2] [--dry-run]"
  exit 2
}

[ $# -ge 1 ] || usage
BUMP="$1"; shift
RUN_ON_UPDATE=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-on-update) RUN_ON_UPDATE="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) usage ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "must be on main"
[ -z "$(git status --porcelain)" ] || die "working tree not clean"
CUR="$(tr -d '[:space:]' < VERSION)"
IFS=. read -r MA MI PA <<< "$CUR"
case "$BUMP" in
  patch) NEW="$MA.$MI.$((PA + 1))" ;;
  minor) NEW="$MA.$((MI + 1)).0" ;;
  major) NEW="$((MA + 1)).0.0" ;;
  *) [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage; NEW="$BUMP" ;;
esac
TAG="v$NEW"
git rev-parse -q --verify "refs/tags/$TAG" > /dev/null && die "tag $TAG exists"
grep -qE '^## \[Unreleased\]' CHANGELOG.md || die "CHANGELOG has no Unreleased section"
python3 -I - <<'PY' || die "CHANGELOG Unreleased section is empty"
import re, sys
t = open("CHANGELOG.md").read()
m = re.search(r"^## \[Unreleased\]\n(.*?)(?=^## \[|\Z)", t, re.S | re.M)
sys.exit(0 if m and m.group(1).strip() else 1)
PY

bash tools/ci_guard.sh
npm run --silent check
git ls-files -z '*.py' | xargs -0 python3 -m py_compile
python3 ingest/run_all.py --list > /dev/null
python3 tools/make_sample.py > /dev/null && node tools/smoke.mjs > /dev/null
git status --porcelain | grep -q . && die "checks left the tree dirty"

echo "release: $CUR -> $NEW"
[ "$DRY" -eq 0 ] || { echo "release: dry run, nothing changed"; exit 0; }

PARENT_SHA="$(git rev-parse HEAD)"
export NEW PARENT_SHA RUN_ON_UPDATE
python3 -I - <<'PY'
import datetime, json, os, re
new = os.environ["NEW"]
today = datetime.date.today().isoformat()
open("VERSION", "w").write(new + "\n")

t = open("CHANGELOG.md").read()
t = t.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [%s] - %s\n" % (new, today), 1)
open("CHANGELOG.md", "w").write(t)
m = re.search(r"^## \[%s\][^\n]*\n(.*?)(?=^## \[|\Z)" % re.escape(new), t, re.S | re.M)
notes = m.group(1).strip() if m else ""

p = json.load(open("package.json"))
p["version"] = new
open("package.json", "w").write(json.dumps(p, indent=2) + "\n")

jobs = [j for j in os.environ.get("RUN_ON_UPDATE", "").split(",") if j]
migrations = []
if os.path.exists("ops/migrations.json"):
    migrations = json.load(open("ops/migrations.json"))
manifest = {
    "version": new,
    "git_sha": os.environ["PARENT_SHA"],
    "min_updater_version": 1,
    "node_version": open(".nvmrc").read().strip(),
    "python_min": "3.12",
    "resources": {"min_ram_mb": 200, "min_free_disk_gb": 5},
    "post_update": [{"step": "doctor"}],
    "ingest": {"run_on_update": jobs, "schedule_changes": []},
    "migrations": migrations,
    "notes": notes,
}
open("ops/release-manifest.json", "w").write(json.dumps(manifest, indent=2) + "\n")
PY

git add VERSION CHANGELOG.md package.json ops/release-manifest.json
git commit -q -m "Release $TAG." VERSION CHANGELOG.md package.json ops/release-manifest.json
git tag -a "$TAG" -m "Release $TAG"

echo "release: created commit and tag $TAG (not pushed)"
echo "publish with:"
echo "  git push origin main --follow-tags"
