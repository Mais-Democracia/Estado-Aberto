#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "== $(date -Is) daily refresh"
python3 ingest/run_all.py --schedule daily --resume --profile "${ESTADO_ABERTO_PROFILE:-server}" "$@"
echo "== done"
