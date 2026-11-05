"""Use INE Censos 2021 resident population as the denominator for municipalities (from the autarquias module's database)
and parishes (INE indicator 0011609 at freguesia level, matched to the registry by INE code via Wikidata P6324 only).
Runs after jobs/autarquias.py. Parishes without an INE match keep their Wikidata value, labelled as such."""
import json
import sqlite3
from datetime import datetime

from common import DATA_DIR, db, get, get_json, ROOT, set_meta

INE = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0011609&Dim1=S7A2021&Dim3=T&Dim4=T&lang=PT"
WD = "https://query.wikidata.org/sparql"
WDQ = "SELECT ?e ?c WHERE { ?e wdt:P31 wd:Q1131296; wdt:P17 wd:Q45; wdt:P6324 ?c. FILTER NOT EXISTS { ?e wdt:P576 ?end } }"
SRC = "INE Censos 2021"


def ensure_column(con):
    if "population_source" not in [r[1] for r in con.execute("PRAGMA table_info(entities)")]:
        con.execute("ALTER TABLE entities ADD COLUMN population_source TEXT")


def municipios(con):
    src = DATA_DIR / "autarquias.db"
    if not src.exists():
        print("autarquias.db missing: municipalities skipped"); return
    a = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    rows = a.execute("SELECT entity_nif, population FROM municipios WHERE entity_nif IS NOT NULL AND population IS NOT NULL").fetchall()
    n = 0
    for nif, pop in rows:
        n += con.execute("UPDATE entities SET population=?, population_source=? WHERE nif=? AND kind='municipio'", (pop, SRC, nif)).rowcount
    tot, cnt = con.execute("SELECT SUM(population), COUNT(population) FROM entities WHERE kind='municipio'").fetchone()
    print(f"population set for {n} municipalities; national sum {tot:,} over {cnt}")


def freguesias(con):
    try:
        rows = json.loads(get(INE, timeout=150) or "null")[0]["Dados"]["2021"]
        codes = {}
        for b in get_json(WD, {"query": WDQ}, {"Accept": "application/json"}, timeout=180)["results"]["bindings"]:
            codes.setdefault(b["c"]["value"].zfill(6), set()).add(b["e"]["value"].rsplit("/", 1)[-1])
    except Exception as e:
        print("parishes skipped:", type(e).__name__); return
    ine = {r["geocod"]: int(float(r["valor"])) for r in rows if len(r["geocod"]) == 6 and r.get("valor")}
    con.execute("UPDATE entities SET population_source='Wikidata' WHERE kind='freguesia' AND population IS NOT NULL AND (population_source IS NULL OR population_source='Wikidata')")
    n = amb = 0
    for code, pop in ine.items():
        q = codes.get(code)
        if not q or len(q) != 1:
            amb += bool(q); continue
        n += con.execute("UPDATE entities SET dico=?, population=?, population_source=? WHERE kind='freguesia' AND wikidata=?", (code, pop, SRC, next(iter(q)))).rowcount
    tot = con.execute("SELECT SUM(population) FROM entities WHERE kind='freguesia' AND population_source=?", (SRC,)).fetchone()[0]
    print(f"parishes: {n} of {len(ine)} INE freguesias matched by INE code ({amb} ambiguous skipped); census sum {tot}")


def main():
    con = db()
    ensure_column(con)
    municipios(con)
    freguesias(con)
    set_meta(con, "population_updated", datetime.now().strftime("%Y-%m-%dT%H:%M:%S") + " (Censos 2021, INE)")
    con.commit()


if __name__ == "__main__":
    main()
