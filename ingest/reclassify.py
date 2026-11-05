"""Re-run the name classifier on entities still typed 'outra_entidade' (idempotent; never touches other kinds)."""
from classify import classify
from common import db, set_meta
from datetime import datetime


def main():
    con = db()
    rows = con.execute("SELECT id, name FROM entities WHERE kind='outra_entidade' AND COALESCE(description,'') NOT LIKE 'NIF alternativo%'").fetchall()   # parked duplicates stay parked
    ups = []
    for eid, name in rows:
        kind, level = classify(name)
        if kind != "outra_entidade":
            ups.append((kind, level, eid))
    con.executemany("UPDATE entities SET kind=?, level=? WHERE id=?", ups)
    set_meta(con, "reclassify_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print(f"reclassified {len(ups)} of {len(rows)} 'outra_entidade'")
    for k, n in con.execute("SELECT kind, COUNT(*) FROM entities WHERE is_public=1 GROUP BY kind ORDER BY 2 DESC"):
        print(f"  {k:24} {n}")


if __name__ == "__main__":
    main()
