#!/usr/bin/env bash
# Light daily refresh (minutes): parliament agenda + law steps, Presidency news, government/party data.
# Heavy rebuilds (contracts, entities, stats, plug-in jobs) are in update.sh — run that weekly.
# Cron:  15 6 * * *  /path/to/politica-pt/daily.sh >> /path/to/politica-pt/data/daily.log 2>&1
#        30 3 * * 0  /path/to/politica-pt/update.sh >> /path/to/politica-pt/data/update.log 2>&1
set -e
cd "$(dirname "$0")/ingest"
echo "== $(date -Is) daily refresh"
python3 agenda.py
python3 news.py
python3 government.py
python3 run_all.py ministerios deputados   # public pages; incremental-friendly jobs
python3 run_all.py responsaveis            # declarations of interests: one 3,000-request batch per run (1 req/s) until all holders are read
echo "== done"
