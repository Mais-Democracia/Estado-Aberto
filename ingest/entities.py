"""Build the entity registry from the Portal BASE entity register (216k legal entities, with contract totals)."""
import html
import json
from pathlib import Path

from classify import classify
from common import DATA_DIR, db, ROOT, set_meta, UA
import urllib.request

RAW = DATA_DIR / "raw" / "base" / "entidades.json"
URL = "https://dados.gov.pt/s/resources/contratos-publicos-portal-base-impic-entidades/20261025-100656-1ae8ad2c/entidades.json"


def main():
    if not RAW.exists():
        RAW.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as r, open(RAW, "wb") as f:
            f.write(r.read())
    rows = json.load(open(RAW, encoding="utf-8"))
    con = db()
    n = 0
    for r in rows:
        nif = r["nifEntidade"] if len(r["nifEntidade"]) == 9 and r["nifEntidade"].isdigit() else None
        if not nif:
            continue    # foreign / unidentified parties are kept inside contracts only
        buyer = r["totAdjudicante"] > 0
        kind, level = classify(html.unescape(r["desigEntidade"])) if buyer else ("empresa_ou_particular", "privado")
        con.execute("""INSERT INTO entities (nif,name,kind,level,is_public,buyer_contracts,buyer_value,seller_contracts,seller_value,sources)
                       VALUES (?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(nif) DO UPDATE SET buyer_contracts=excluded.buyer_contracts, buyer_value=excluded.buyer_value,
                         seller_contracts=excluded.seller_contracts, seller_value=excluded.seller_value""",
                    (nif, html.unescape(r["desigEntidade"]).strip(), kind, level, 1 if buyer else 0,
                     r["totAdjudicante"], r["totAdjudicanteValorContratIni"], r["totAdjudicatario"], r["totValorContratIni"], "base.gov.pt"))
        n += 1
    from datetime import datetime
    set_meta(con, "entities_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print(f"entities: {n} with NIF; public/contracting authorities: {con.execute('SELECT COUNT(*) FROM entities WHERE is_public=1').fetchone()[0]}")
    for k, c in con.execute("SELECT kind, COUNT(*) FROM entities WHERE is_public=1 GROUP BY kind ORDER BY 2 DESC"):
        print(f"  {k:20} {c}")


if __name__ == "__main__":
    main()
