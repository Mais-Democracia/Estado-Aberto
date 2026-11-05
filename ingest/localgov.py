"""All Portuguese municipalities and parishes (Wikidata) with hierarchy, population, website, coordinates;
linked to the contract register (NIF) where the name is unambiguous."""
import re
from datetime import datetime

from classify import norm
from common import db, get_json, set_meta

WD = "https://query.wikidata.org/sparql"
Q = """SELECT ?e ?eLabel ?parent ?parentLabel ?pop ?popdate ?web ?coord WHERE {
  ?e wdt:P31 wd:%s; wdt:P17 wd:Q45. FILTER NOT EXISTS { ?e wdt:P576 ?end }
  OPTIONAL { ?e wdt:P131 ?parent } OPTIONAL { ?e wdt:P856 ?web } OPTIONAL { ?e wdt:P625 ?coord }
  OPTIONAL { ?e p:P1082 ?ps. ?ps ps:P1082 ?pop. OPTIONAL { ?ps pq:P585 ?popdate } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en". } }"""


def fetch(qid):
    return get_json(WD, {"query": Q % qid}, {"Accept": "application/json"}, timeout=180)["results"]["bindings"]


def qid(b, k):
    return b[k]["value"].rsplit("/", 1)[-1] if k in b else None


def main():
    con = db()
    munis, freg = fetch("Q13217644"), fetch("Q1131296")
    print("wikidata municipios:", len({qid(b, 'e') for b in munis}), "freguesias:", len({qid(b, 'e') for b in freg}))
    ids = {}
    def upsert(b, kind, parent_wd=None):
        wid, name = qid(b, "e"), b["eLabel"]["value"]
        lat = lon = None
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", b.get("coord", {}).get("value", ""))
        if m: lon, lat = float(m.group(1)), float(m.group(2))
        pop = int(float(b["pop"]["value"])) if "pop" in b else None
        row = con.execute("SELECT id FROM entities WHERE wikidata=?", (wid,)).fetchone()
        vals = (name, kind, "local", 1, wid, b.get("web", {}).get("value"), pop, lat, lon, "wikidata")
        if row:
            con.execute("UPDATE entities SET name=?,kind=?,level=?,is_public=?,website=?,population=?,lat=?,lon=? WHERE id=?",
                        (name, kind, "local", 1, b.get("web", {}).get("value"), pop, lat, lon, row[0]))
            ids[wid] = row[0]
        else:
            cur = con.execute("INSERT INTO entities (name,kind,level,is_public,wikidata,website,population,lat,lon,sources) VALUES (?,?,?,?,?,?,?,?,?,?)", vals)
            ids[wid] = cur.lastrowid
    def latest_pop(rows):
        best = {}
        for b in rows:
            k = qid(b, "e"); d = b.get("popdate", {}).get("value", "")
            if "pop" in b and (k not in best or d > best[k][0]):
                best[k] = (d, b["pop"]["value"])
        return best
    pops = {**latest_pop(munis), **latest_pop(freg)}
    for b in munis + freg:
        k = qid(b, "e")
        if k in pops: b["pop"] = {"value": pops[k][1]}
        else: b.pop("pop", None)
    seen = set()
    for b in munis:
        if qid(b, "e") in seen: continue
        seen.add(qid(b, "e")); upsert(b, "municipio")
        if "parentLabel" in b:
            con.execute("UPDATE entities SET district=? WHERE wikidata=?", (b["parentLabel"]["value"], qid(b, "e")))
    seen = set()
    for b in freg:
        if qid(b, "e") in seen: continue
        seen.add(qid(b, "e")); upsert(b, "freguesia")
        p = qid(b, "parent")
        if p in ids:
            con.execute("UPDATE entities SET parent_id=?, municipality=? WHERE wikidata=?", (ids[p], con.execute("SELECT name FROM entities WHERE id=?", (ids[p],)).fetchone()[0], qid(b, "e")))
    # link to BASE contracting authorities (buyer NIF) by unambiguous normalised name
    base = {}
    for _id, nif, name, kind in con.execute("SELECT id,nif,name,kind FROM entities WHERE nif IS NOT NULL AND kind IN ('municipio','freguesia')"):
        key = re.sub(r"^(municipio|camara municipal) (d[aeo]s? )?", "", norm(name))
        key = re.sub(r"^(uniao das? freguesias? (d[aeo]s? )?|freguesia (d[aeo]s? )?|junta de freguesia (d[aeo]s? )?)", "", key)
        base.setdefault((kind, key), []).append((_id, nif, name))
    linked = 0
    wd_count = {}
    for wid, eid in ids.items():
        nm, kd = con.execute("SELECT name, kind FROM entities WHERE id=?", (eid,)).fetchone()
        k = re.sub(r"^(municipio|camara municipal) (d[aeo]s? )?", "", norm(nm))
        wd_count[(kd, k)] = wd_count.get((kd, k), 0) + 1
    for wid, eid in ids.items():
        name, kind = con.execute("SELECT name, kind FROM entities WHERE id=?", (eid,)).fetchone()
        key = norm(name)
        key = re.sub(r"^(municipio|camara municipal) (d[aeo]s? )?", "", key)
        cands = [c for c in base.get((kind, key), []) if c[0] != eid]
        if len(cands) == 1 and wd_count.get((kind, key)) == 1:      # unique on BOTH sides, otherwise we would guess
            bid, nif, bname = cands[0]
            vals = con.execute("SELECT buyer_contracts, buyer_value, seller_contracts, seller_value FROM entities WHERE id=?", (bid,)).fetchone()
            con.execute("DELETE FROM entities WHERE id=?", (bid,))      # free the NIF (unique) before re-assigning it
            con.execute("UPDATE entities SET nif=?, buyer_contracts=?, buyer_value=?, seller_contracts=?, seller_value=? WHERE id=?", (nif, *vals, eid))
            linked += 1
    set_meta(con, "localgov_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    nm = con.execute("SELECT COUNT(*) FROM entities WHERE kind='municipio' AND wikidata IS NOT NULL").fetchone()[0]
    nf = con.execute("SELECT COUNT(*) FROM entities WHERE kind='freguesia' AND wikidata IS NOT NULL").fetchone()[0]
    print(f"municipios: {nm}, freguesias: {nf}, linked to contracts via name: {linked}")


if __name__ == "__main__":
    main()
