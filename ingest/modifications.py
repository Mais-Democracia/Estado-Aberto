"""Portal BASE contract modifications (price/duration changes after signing) -> contract_mods + buyer_mod_stats."""
import json
import re
import urllib.request

from common import DATA_DIR, db, ROOT, set_meta, UA

RAW = DATA_DIR / "raw" / "mods"
DS = "668d65dbcb1b953e80198435"


def iso(d):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", d or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    ds = json.load(urllib.request.urlopen(urllib.request.Request(f"https://dados.gov.pt/api/1/datasets/{DS}/", headers={"User-Agent": UA}), timeout=60))
    files = {}
    for r in ds["resources"]:
        m = re.fullmatch(r"modcontrats(\d{4})\.json", r["title"])
        if m:
            files[int(m.group(1))] = r["url"]
    con = db()
    con.executescript("""DROP TABLE IF EXISTS contract_mods;
      CREATE TABLE contract_mods (contract_id TEXT, date TEXT, published TEXT, basis TEXT, act_type TEXT, new_price REAL, new_duration TEXT, year INTEGER);
      CREATE INDEX cm_contract ON contract_mods(contract_id);""")
    n = 0
    for year, url in sorted(files.items()):
        p = RAW / f"mod{year}.json"
        if not p.exists() or p.stat().st_size < 100:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120) as r:
                p.write_bytes(r.read())
        for d in json.load(open(p, encoding="utf-8")):
            con.execute("INSERT INTO contract_mods VALUES (?,?,?,?,?,?,?,?)", (
                str(d.get("idcontrato")), iso(d.get("modifContratoData")), iso(d.get("modifDataPublicacao")), d.get("modifContratoFundamento"),
                d.get("modifContratoTipoAto"), d.get("modifContratoPrecoAlterado"), d.get("modifPrazoExecucao"), d.get("Ano")))
            n += 1
    con.executescript("""
      DROP TABLE IF EXISTS buyer_mod_stats;
      CREATE TABLE buyer_mod_stats AS
      WITH last AS (   -- each modification states the full new price, so only the latest one per contract counts
        SELECT contract_id, new_price, mods FROM (
          SELECT contract_id, new_price, COUNT(*) OVER (PARTITION BY contract_id) AS mods,
                 ROW_NUMBER() OVER (PARTITION BY contract_id ORDER BY date DESC, rowid DESC) AS rn FROM contract_mods WHERE new_price > 0) WHERE rn = 1)
      SELECT c.buyer_nif AS nif, COUNT(*) AS modified_n, SUM(l.mods) AS mods_n,
             SUM(CASE WHEN l.new_price > c.price AND c.price > 0 THEN l.new_price - c.price ELSE 0 END) AS increase_value,
             SUM(CASE WHEN l.new_price > c.price * 1.25 AND c.price > 0 THEN 1 ELSE 0 END) AS big_increase_n
      FROM last l JOIN contracts c ON c.id = l.contract_id WHERE c.buyer_nif IS NOT NULL GROUP BY c.buyer_nif;
      CREATE UNIQUE INDEX bms_nif ON buyer_mod_stats(nif);""")
    from datetime import datetime
    set_meta(con, "mods_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print("modifications:", n, "| matched to contracts:", con.execute("SELECT COUNT(*) FROM contract_mods m JOIN contracts c ON c.id=m.contract_id").fetchone()[0])
    r = con.execute("""SELECT ROUND(AVG(m.new_price*1.0/c.price),3), COUNT(*) FROM contract_mods m JOIN contracts c ON c.id=m.contract_id WHERE c.price>0 AND m.new_price>0""").fetchone()
    print("avg new_price/price ratio:", r)


if __name__ == "__main__":
    main()
