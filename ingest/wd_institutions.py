"""Portuguese government bodies from Wikidata that may never appear in procurement (e.g. Parque Escolar EPE).
Merged into the entity registry; matched to BASE entities by exact normalised name (unique on both sides)."""
from datetime import datetime

from classify import classify, norm
from common import db, get_json, set_meta

WD = "https://query.wikidata.org/sparql"
Q = """SELECT ?e ?eLabel ?web ?parentLabel ?classLabel WHERE {
  ?e wdt:P17 wd:Q45; wdt:P31/wdt:P279* wd:Q327333. FILTER NOT EXISTS { ?e wdt:P576 ?end }
  OPTIONAL { ?e wdt:P856 ?web } OPTIONAL { ?e wdt:P749 ?parent } OPTIONAL { ?e wdt:P31 ?class }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en". } }"""


def main():
    rows = get_json(WD, {"query": Q}, {"Accept": "application/json"}, timeout=240)["results"]["bindings"]
    merged = {}
    for b in rows:
        wid = b["e"]["value"].rsplit("/", 1)[-1]
        m = merged.setdefault(wid, {"name": b["eLabel"]["value"], "web": None, "parent": None, "cls": set()})
        if "web" in b: m["web"] = m["web"] or b["web"]["value"]
        if "parentLabel" in b: m["parent"] = m["parent"] or b["parentLabel"]["value"]
        if "classLabel" in b: m["cls"].add(b["classLabel"]["value"])
    con = db()
    by_name = {}
    for _id, name, w in con.execute("SELECT id, name, wikidata FROM entities WHERE is_public=1"):
        by_name.setdefault(norm(name), []).append((_id, w))
    wd_names = {}
    for wid, m in merged.items():
        wd_names[norm(m["name"])] = wd_names.get(norm(m["name"]), 0) + 1
    new = linked = skipped = 0
    for wid, m in merged.items():
        if m["name"].startswith("Q") and m["name"][1:].isdigit():
            skipped += 1; continue                      # unlabeled item
        kind, level = classify(m["name"])
        if kind in ("municipio", "freguesia"):
            skipped += 1; continue                      # handled by localgov.py
        desc = "; ".join(sorted(m["cls"]))[:200] + (f" · Organização-mãe (Wikidata): {m['parent']}" if m["parent"] else "")
        if con.execute("SELECT 1 FROM entities WHERE wikidata=?", (wid,)).fetchone():
            continue
        cands = by_name.get(norm(m["name"]), [])
        if len(cands) == 1 and wd_names[norm(m["name"])] == 1 and cands[0][1] is None:
            con.execute("UPDATE entities SET wikidata=?, website=COALESCE(website,?), description=COALESCE(description,?) WHERE id=?", (wid, m["web"], desc, cands[0][0]))
            linked += 1
        else:
            con.execute("INSERT INTO entities (name,kind,level,is_public,wikidata,website,description,sources) VALUES (?,?,?,?,?,?,?,?)",
                        (m["name"], kind, level if level != "outro" else "central", 1, wid, m["web"], desc, "wikidata"))
            new += 1
    set_meta(con, "wd_institutions_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print(f"wikidata bodies: {len(merged)} | linked to BASE: {linked} | new: {new} | skipped: {skipped}")


if __name__ == "__main__":
    main()
