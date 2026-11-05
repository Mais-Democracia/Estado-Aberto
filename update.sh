#!/usr/bin/env bash
# Refresh all data. Cron example: 0 6 * * * /path/to/update.sh >> data/update.log 2>&1
set -e
cd "$(dirname "$0")/ingest"
python3 agenda.py            # parliament calendar + law steps
python3 government.py        # President, ministers, parties
python3 news.py              # Presidency news
python3 contracts.py         # Portal BASE contracts (streams every year; ~15 min)
python3 entities.py          # entity registry (BASE)
python3 localgov.py          # municipalities + parishes (Wikidata) linked to NIF
python3 wd_institutions.py   # public bodies from Wikidata
python3 reclassify.py        # classify remaining unsorted public bodies
python3 aliases.py           # former names of renamed bodies
python3 modifications.py     # contract modifications
python3 stats.py             # per-entity statistics + FTS index
python3 run_all.py           # plug-in jobs in ingest/jobs/ (dre, autarquias, educacao, ...)
python3 population.py        # Censos 2021 population (needs jobs/autarquias)
python3 ar_opendata.py || true
