#!/usr/bin/env bash
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
RANGE="${1:-}"
ALLOW=ops/guard-allowlist.txt
fail=0
bad() { echo "GUARD: $*"; fail=1; }

allowed() {
  [ -f "$ALLOW" ] || return 1
  local f="$1" pat
  while IFS= read -r pat; do
    case "$pat" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2254
    case "$f" in $pat) return 0 ;; esac
  done < "$ALLOW"
  return 1
}

while IFS= read -r -d '' f; do
  [ -e "$f" ] || continue
  case "$f" in
    data/.gitkeep) ;;
    data/*) bad "tracked file under data/: $f" ;;
  esac
  case "$f" in
    docs/historias-fixtures/SYNTHETIC) ;;
    docs/historias-fixtures/*) bad "docs/historias-fixtures must hold only the SYNTHETIC marker: $f" ;;
  esac
  case "${f,,}" in
    *.db|*.sqlite|*.db-wal|*.zip|*.whl|*.xlsx|*.xls|*.pdf|*.csv)
      allowed "$f" || bad "forbidden file type: $f" ;;
  esac
  size=$(stat -c %s "$f")
  if [ "$size" -gt 1048576 ]; then
    allowed "$f" || bad "file over 1 MB ($size bytes): $f"
  fi
done < <(git ls-files -z)

EXCL=(':!tools/ci_guard.sh' ':!ops/guard-allowlist.txt')
scan() {
  local label="$1" pat="$2" out
  out=$(git grep -IniE -e "$pat" -- . "${EXCL[@]}" 2>/dev/null | cut -c1-160)
  if [ -n "$out" ]; then
    bad "$label"
    echo "$out" | sed 's/^/    /'
  fi
}
scan "private key material" '-----BEGIN ([A-Z]+ )?PRIVATE KEY'
scan "token pattern" 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{32,}'
scan "hardcoded credential" "(password|passwd|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[\"'][^\"' ]{8,}[\"']"
scan "personal email" '[A-Za-z0-9._%+-]+@(gmail|hotmail|outlook|yahoo|icloud|proton|protonmail|live)\.[a-z.]+|[A-Za-z0-9._%+-]+@plugwise\.com'
scan "LAN address" '(^|[^0-9.])(192\.168\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)([^0-9]|$)'

if [ -n "$RANGE" ]; then
  msgs=$(git log --format=%B "$RANGE" 2>/dev/null || true)
  if printf '%s\n' "$msgs" | grep -iEq 'co-authored-by:.*(cl[a]ude|anthr[o]pic|openai|chatgpt|copilot|gemini|codex)|generated with .*(cl[a]ude|copilot|codex)'; then
    bad "AI-vendor attribution in commit messages of $RANGE"
  fi
else
  echo "GUARD: no commit range given, skipping commit message check"
fi

if [ "$fail" -ne 0 ]; then
  echo "GUARD: FAILED"
  exit 1
fi
echo "GUARD: ok"
