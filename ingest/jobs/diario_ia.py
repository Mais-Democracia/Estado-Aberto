#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ops" / "ai"))
import lib  # noqa: E402
import verify as V  # noqa: E402

FIELDS = ("titulo", "lead", "corpo", "pontos_chave", "fontes", "numeros_citados", "entidades", "confianca", "modelo", "revisor", "verificacao", "estado", "evento_ids")
JSON_FIELDS = {"pontos_chave", "fontes", "numeros_citados", "entidades", "verificacao", "evento_ids"}


def j(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True)


def reverify(doc, bdir, cfg):
    try:
        if not (bdir / "facts.json").exists():
            return {"ok": False, "problemas": ["bundle_em_falta"]}
        return V.verify(doc, bdir, cfg)
    except Exception as e:
        return {"ok": False, "problemas": [f"erro_verificador:{type(e).__name__}"]}


def read_marker(killed, ev):
    if killed is None or not (killed / ev).exists():
        return None
    try:
        m = json.loads((killed / ev).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        m = {}
    return m if isinstance(m, dict) else {}


def import_doc(con, doc, cfg, bundles, killed=None):
    state = doc["estado"]
    ver = reverify(doc, bundles / doc["evidence_hash"], cfg)
    mark = read_marker(killed, doc["evidence_hash"])
    if mark is not None:
        state = "rejeitado"
        doc = dict(doc, estado=state, verificacao=dict(doc.get("verificacao") or {}, retirada={"motivo": str(mark.get("motivo", ""))[:300], "em": str(mark.get("em", ""))}))
    elif state == "publicado" and (not ver["ok"] or doc.get("confianca", 0) < cfg["confianca_min"] or doc["verificacao"]["revisor"].get("veredicto") != "ok"):
        state = "rejeitado"
        doc = dict(doc, estado=state, verificacao=dict(doc["verificacao"], reverificacao=ver))
    ed, ev = doc["edicao_data"], doc["evidence_hash"]
    row = con.execute("SELECT id, revisao FROM artigos_ia WHERE edicao_data=? AND evidence_hash=?", (ed, ev)).fetchone()
    if not row:
        ids = j(sorted(doc["evento_ids"]))
        for r in con.execute("SELECT id, revisao, evento_ids FROM artigos_ia WHERE edicao_data=?", (ed,)):
            try:
                if j(sorted(json.loads(r[2]))) == ids:
                    row = r
                    break
            except ValueError:
                continue
    vals = {k: (j(doc[k]) if k in JSON_FIELDS else doc[k]) for k in FIELDS}
    if row:
        cur = con.execute("SELECT * FROM artigos_ia WHERE id=?", (row[0],)).fetchone()
        cols = [d[0] for d in con.execute("SELECT * FROM artigos_ia LIMIT 0").description]
        old = dict(zip(cols, cur))
        same = old["evidence_hash"] == ev and all(
            (j(json.loads(old[k])) if k in JSON_FIELDS else old[k]) == (j(json.loads(vals[k])) if k in JSON_FIELDS else vals[k]) for k in FIELDS)
        aid = row[0]
        if same:
            return aid, state, False
        sets = ", ".join(f"{k}=?" for k in FIELDS) + ", evidence_hash=?, revisao=revisao+1"
        con.execute(f"UPDATE artigos_ia SET {sets} WHERE id=?", [vals[k] for k in FIELDS] + [ev, aid])
        changed = True
    else:
        cols = ["edicao_data", "evidence_hash", "criado_em", "revisao"] + list(FIELDS)
        con.execute(f"INSERT INTO artigos_ia ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                    [ed, ev, doc.get("criado_em"), 0] + [vals[k] for k in FIELDS])
        aid = con.execute("SELECT id FROM artigos_ia WHERE edicao_data=? AND evidence_hash=?", (ed, ev)).fetchone()[0]
        changed = True
    for eid in doc["evento_ids"]:
        if state == "publicado":
            con.execute("UPDATE eventos SET ia_artigo_id=? WHERE id=? AND COALESCE(ia_artigo_id,0)<>?", (aid, eid, aid))
        else:
            con.execute("UPDATE eventos SET ia_artigo_id=NULL WHERE id=? AND ia_artigo_id=?", (eid, aid))
    return aid, state, changed


def fail_closed(con, doc, reason):
    try:
        with con:
            ids = [r[0] for r in con.execute("SELECT id FROM artigos_ia WHERE evidence_hash=? AND estado<>'rejeitado'", (doc.get("evidence_hash"),))]
            for i in ids:
                con.execute("UPDATE artigos_ia SET estado='rejeitado', revisao=revisao+1 WHERE id=?", (i,))
                con.execute("UPDATE eventos SET ia_artigo_id=NULL WHERE ia_artigo_id=?", (i,))
        return bool(ids)
    except sqlite3.Error:
        return False


def touch(db, con):
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    except sqlite3.Error:
        pass
    try:
        os.utime(db, None)
    except OSError:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    a = ap.parse_args(argv)
    cfg = lib.load_config()
    ai = lib.state_root() / "ai"
    dates = [a.date] if a.date else sorted(p.name for p in (ai / "published").glob("*") if p.is_dir())
    dates = sorted(set(dates) | {p.name for p in (ai / "rejected").glob("*") if p.is_dir()}) if not a.date else dates
    db = lib.data_dir() / "diario.db"
    if not db.exists():
        print("diario.db inexistente")
        return 1
    con = sqlite3.connect(db, timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='artigos_ia'").fetchone():
        print("tabela artigos_ia inexistente")
        return 1
    n = {"novos_ou_alterados": 0, "inalterados": 0, "falhas": 0}
    killed = ai / "killed"
    for d in dates:
        for sub in ("published", "rejected"):
            for f in sorted((ai / sub / d).glob("*.json")):
                doc = None
                try:
                    doc = json.loads(f.read_text(encoding="utf-8"))
                    with con:
                        _, _, changed = import_doc(con, doc, cfg, ai / "bundles", killed)
                except Exception as e:
                    print(f"ignorado {f.name}: {type(e).__name__}")
                    n["falhas"] += 1
                    if isinstance(doc, dict) and sub == "published":
                        if fail_closed(con, doc, type(e).__name__):
                            n["novos_ou_alterados"] += 1
                    continue
                n["novos_ou_alterados" if changed else "inalterados"] += 1
    if n["novos_ou_alterados"]:
        touch(db, con)
    print(json.dumps(n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
