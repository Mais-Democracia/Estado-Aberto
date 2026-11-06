#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ops" / "ai"))
import lib  # noqa: E402
import verify as V  # noqa: E402

FIELDS = ("titulo", "lead", "corpo", "pontos_chave", "fontes", "numeros_citados", "entidades", "confianca", "modelo", "revisor", "verificacao", "estado", "evento_ids", "blocos", "explicacao")
JSON_FIELDS = {"pontos_chave", "fontes", "numeros_citados", "entidades", "verificacao", "evento_ids", "blocos", "explicacao"}
NULLABLE = {"blocos", "explicacao"}


def j(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True)


def enc(k, v):
    if k in JSON_FIELDS:
        return None if (v is None and k in NULLABLE) else j(v)
    return v


def dec(k, v):
    if k in JSON_FIELDS:
        if v is None:
            return None
        try:
            return j(json.loads(v))
        except ValueError:
            return v
    return v


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


def same_events(raw, ids_key):
    try:
        return j(sorted(json.loads(raw))) == ids_key
    except (TypeError, ValueError):
        return False


def newer_published(con, doc, ids_key, own_id):
    mine = str(doc.get("criado_em") or "")
    for r in con.execute("SELECT id, evento_ids, criado_em FROM artigos_ia WHERE estado='publicado'"):
        if r[0] != own_id and str(r[2] or "") > mine > "" and same_events(r[1], ids_key):
            return True
    return False


def supersede(con, aid, ids_key):
    inherited = 0
    for r in con.execute("SELECT id, revisao, evento_ids FROM artigos_ia WHERE estado='publicado' AND id<>?", (aid,)).fetchall():
        if same_events(r[2], ids_key):
            con.execute("UPDATE artigos_ia SET estado='substituido', revisao=COALESCE(revisao, 0)+1 WHERE id=?", (r[0],))
            inherited = max(inherited, (r[1] or 0) + 1)
    if inherited:
        con.execute("UPDATE artigos_ia SET revisao=MAX(COALESCE(revisao, 0), ?) WHERE id=?", (inherited, aid))


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
    ids_key = j(sorted(doc["evento_ids"]))
    if state == "publicado" and newer_published(con, doc, ids_key, row[0] if row else None):
        state = "substituido"
    cols = [d[0] for d in con.execute("SELECT * FROM artigos_ia LIMIT 0").description]
    old = None
    if row:
        old = dict(zip(cols, con.execute("SELECT * FROM artigos_ia WHERE id=?", (row[0],)).fetchone()))
        if state == "publicado" and old["estado"] == "substituido" and old["evidence_hash"] == ev:
            state = "substituido"
    doc = dict(doc, estado=state)
    vals = {k: enc(k, doc.get(k)) for k in FIELDS}
    if row:
        same = old["evidence_hash"] == ev and all(dec(k, old[k]) == dec(k, vals[k]) for k in FIELDS)
        aid = row[0]
        if same:
            return aid, state, False
        sets = ", ".join(f"{k}=?" for k in FIELDS) + ", evidence_hash=?, revisao=COALESCE(revisao, 0)+1"
        con.execute(f"UPDATE artigos_ia SET {sets} WHERE id=?", [vals[k] for k in FIELDS] + [ev, aid])
        changed = True
    else:
        icols = ["edicao_data", "evidence_hash", "criado_em", "revisao"] + list(FIELDS)
        con.execute(f"INSERT INTO artigos_ia ({','.join(icols)}) VALUES ({','.join('?' * len(icols))})",
                    [ed, ev, doc.get("criado_em"), 0] + [vals[k] for k in FIELDS])
        aid = con.execute("SELECT id FROM artigos_ia WHERE edicao_data=? AND evidence_hash=?", (ed, ev)).fetchone()[0]
        changed = True
    if state == "publicado":
        supersede(con, aid, ids_key)
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
                con.execute("UPDATE artigos_ia SET estado='rejeitado', revisao=COALESCE(revisao, 0)+1 WHERE id=?", (i,))
                con.execute("UPDATE eventos SET ia_artigo_id=NULL WHERE ia_artigo_id=?", (i,))
        return bool(ids)
    except sqlite3.Error:
        return False


def fail(con, f, doc, sub, n, failed, e):
    print(f"ignorado {f.name}: {type(e).__name__}: {str(e)[:120]}")
    n["falhas"] += 1
    failed.append(f"{sub}/{f.parent.name}/{f.name}")
    if isinstance(doc, dict) and sub == "published" and fail_closed(con, doc, type(e).__name__):
        n["novos_ou_alterados"] += 1
    return None


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
    sys.path.insert(0, str(ROOT / "ingest"))
    import migrations  # noqa: E402
    with con:
        migrations.ensure_artigos_ia(con)
    n = {"novos_ou_alterados": 0, "inalterados": 0, "falhas": 0}
    failed = []
    killed = ai / "killed"
    for d in dates:
        for sub in ("published", "rejected"):
            for f in sorted((ai / sub / d).glob("*.json")):
                doc = None
                for attempt in range(3):
                    try:
                        doc = json.loads(f.read_text(encoding="utf-8"))
                        with con:
                            _, _, changed = import_doc(con, doc, cfg, ai / "bundles", killed)
                        break
                    except sqlite3.OperationalError as e:
                        if attempt < 2 and "locked" in str(e):
                            time.sleep(3)
                            continue
                        changed = fail(con, f, doc, sub, n, failed, e)
                        break
                    except Exception as e:
                        changed = fail(con, f, doc, sub, n, failed, e)
                        break
                if changed is None:
                    continue
                n["novos_ou_alterados" if changed else "inalterados"] += 1
    if n["novos_ou_alterados"]:
        touch(db, con)
    if failed:
        n["ficheiros_falhados"] = failed
    print(json.dumps(n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
