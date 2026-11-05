#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 ingest/run_all.py --schedule weekly --resume --profile "${ESTADO_ABERTO_PROFILE:-server}" "$@"
