"""Idempotent data-quality fixes driven by docs/QA_REPORT.md. Run after entities/localgov, before stats."""
import re
from datetime import datetime

from classify import norm
from common import db, set_meta


def mojibake(s):
    if not s or ("Ã" not in s and "Â" not in s):
        return s
    try:
        fixed = s.encode("latin-1").decode("utf-8")
        return fixed if "Ã" not in fixed else s
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def clean_space(s):
    return re.sub(r"\s+", " ", s).strip() if s else s


def region_of_wd(lat, lon):
    if lon is None:
        return None
    if lon < -24: return "azores"
    if lat is not None and lat < 34 and lon > -18: return "madeira"
    return "continente"


def region_of_base(name):
    n = norm(name)
    if re.search(r"acores|sao jorge|horta", n): return "azores"
    if "calheta" in n or "funchal" in n: return "madeira"
    return "continente"


def key(name):
    return re.sub(r"^(municipio|camara municipal) (d[aeo]s? )?", "", norm(name)).replace(" camara municipal", "").strip()


# Wikidata id -> NIF for homonymous municipalities that name matching cannot separate (verified by coordinates + NIF region prefix)
NIF_OVERRIDES = {
    "Q985519": "506804240",    # Lagoa (Faro, Algarve; lat 37.13 lon -8.45)       <- "Município de Lagoa"
    "Q564759": "512074410",    # Lagoa (Açores, São Miguel; lon -25.58)            <- "Município de Lagoa (Açores)"
    "Q1019047": "512074089",   # Calheta (Açores, São Jorge; lon -28.02)           <- "Município de Calheta - São Jorge"
}


def apply_overrides(con):
    n = 0
    for wid, nif in NIF_OVERRIDES.items():
        target = con.execute("SELECT id FROM entities WHERE wikidata=?", (wid,)).fetchone()
        if not target:
            continue
        holder = con.execute("SELECT id, wikidata FROM entities WHERE nif=?", (nif,)).fetchone()
        if holder and holder[0] != target[0]:
            if holder[1] is None:
                con.execute("DELETE FROM entities WHERE id=?", (holder[0],))      # BASE-only row: absorbed into the Wikidata one
            else:
                con.execute("UPDATE entities SET nif=NULL WHERE id=?", (holder[0],))
        con.execute("UPDATE entities SET nif=? WHERE id=?", (nif, target[0])); n += 1
    return n


def merge_municipalities(con):
    """Resolve Wikidata-only municipalities against BASE rows, including duplicate NIFs and island homonyms."""
    wd = con.execute("SELECT id, name, lat, lon FROM entities WHERE kind='municipio' AND nif IS NULL AND wikidata IS NOT NULL").fetchall()
    base = con.execute("SELECT id, name, nif, buyer_contracts, buyer_value, seller_contracts, seller_value FROM entities WHERE kind='municipio' AND wikidata IS NULL AND nif IS NOT NULL").fetchall()
    merged = removed = 0
    for wid, wname, lat, lon in wd:
        cands = [b for b in base if key(b[1]) == key(wname)]
        reg = region_of_wd(lat, lon)
        regional = [b for b in cands if region_of_base(b[1]) == reg]
        pool = regional or (cands if len({region_of_base(b[1]) for b in cands}) == 1 else [])
        if not pool:
            continue
        pool.sort(key=lambda b: -(b[3] or 0))
        prim, strays = pool[0], pool[1:]
        con.execute("DELETE FROM entities WHERE id=?", (prim[0],))
        con.execute("UPDATE entities SET nif=?, buyer_contracts=?, buyer_value=?, seller_contracts=?, seller_value=? WHERE id=?", (prim[2], prim[3], prim[4], prim[5], prim[6], wid))
        for s in strays:   # stray alternative NIFs of the same authority: keep their contracts reachable, but not as separate municipalities
            con.execute("UPDATE entities SET kind='outra_entidade', description=? WHERE id=?", (f"NIF alternativo associado ao município de {wname}", s[0]))
        base = [b for b in base if b[0] not in {prim[0], *[x[0] for x in strays]}]
        merged += 1
    # historical / non-municipal Wikidata items that were typed as municipality and have no children
    for eid, name in con.execute("SELECT id, name FROM entities e WHERE kind='municipio' AND nif IS NULL AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.parent_id=e.id)").fetchall():
        con.execute("DELETE FROM entities WHERE id=?", (eid,)); removed += 1
    return merged, removed


def main():
    con = db()
    ov = apply_overrides(con)
    m, r = merge_municipalities(con)
    # names: mojibake + whitespace
    fixed = 0
    for tbl, col in (("entities", "name"), ("contracts", "buyer_name"), ("contracts", "seller_name"), ("contract_parties", "name")):
        rows = con.execute(f"SELECT rowid, {col} FROM {tbl} WHERE {col} LIKE '%Ã%' OR {col} LIKE '%Â%' OR {col} LIKE '%  %'").fetchall()
        ups = [(clean_space(mojibake(v)), rid) for rid, v in rows if clean_space(mojibake(v)) != v]
        con.executemany(f"UPDATE {tbl} SET {col}=? WHERE rowid=?", ups); fixed += len(ups)
    # contract text: trim, absurd durations
    con.execute("UPDATE contracts SET object = TRIM(object) WHERE object != TRIM(object)")
    con.execute("UPDATE contracts SET duration_days = NULL WHERE duration_days > 7300")
    # parishes inherit district from parent municipality
    con.execute("UPDATE entities SET district = (SELECT p.district FROM entities p WHERE p.id = entities.parent_id) WHERE kind='freguesia' AND parent_id IS NOT NULL AND district IS NULL")
    set_meta(con, "quality_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print(f"overrides applied: {ov}, municipalities merged: {m}, removed non-municipal items: {r}, names repaired: {fixed}")
    print("municipios now:", con.execute("SELECT COUNT(*) FROM entities WHERE kind='municipio'").fetchone()[0],
          "| with nif:", con.execute("SELECT COUNT(*) FROM entities WHERE kind='municipio' AND nif IS NOT NULL").fetchone()[0])


if __name__ == "__main__":
    main()
