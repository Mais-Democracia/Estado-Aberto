"""Avaliação humana/IA dos sinais de risco: amostra rotulada -> precisão por bandeira.

  python3 ingest/jobs/risco_eval.py --template   cria docs/risco_labels.csv (100 contratos assinalados, estratificados por
                                                 bandeira, coluna `true_positive` vazia).  Nunca sobrescreve um ficheiro
                                                 com rótulos preenchidos.
  python3 ingest/jobs/risco_eval.py              lê docs/risco_labels.csv e calcula a precisão por bandeira (IC de Wilson
                                                 95%) -> imprime + data/exports/risco_precision.json.

Rótulo `true_positive`: 1/sim/yes/s/y/true = o padrão descrito pela bandeira existe mesmo e merece escrutínio;
0/não/nao/no/n/false = falso positivo (explicação legítima evidente ou erro de dados); vazio ou "?" = por rotular.
Precisão = verdadeiros / rotulados.  Não mede revocação (casos não assinalados não estão na amostra).
Lê só data/risco.db e data/politica.db (modo só-leitura).
"""
import csv
import json
import math
import random
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RISCO = ROOT / "data" / "risco.db"
POLITICA = ROOT / "data" / "politica.db"
LABELS = ROOT / "docs" / "risco_labels.csv"
OUT = ROOT / "data" / "exports" / "risco_precision.json"
N = 100
SEED = 20261030
COLS = ["sample_id", "stratum_flag", "contract_id", "procedure_id", "signed", "procedure", "price", "score", "all_flags",
        "buyer_nif", "buyer_name", "seller_nif", "seller_name", "object", "evidence_json", "base_url", "portal_url",
        "true_positive", "labeller", "notes"]
YES = {"1", "sim", "s", "yes", "y", "true", "v", "verdadeiro"}
NO = {"0", "não", "nao", "n", "no", "false", "f", "falso"}


def template(force=False):
    if LABELS.exists() and not force:
        with open(LABELS, encoding="utf-8") as fh:
            if any((r.get("true_positive") or "").strip() not in ("", "?") for r in csv.DictReader(fh)):
                sys.exit(f"{LABELS} já tem rótulos; não sobrescrevo.")
    con = sqlite3.connect(f"file:{RISCO}?mode=ro", uri=True)
    con.execute(f"ATTACH 'file:{POLITICA}?mode=ro' AS p")
    flags = [r[0] for r in con.execute("SELECT flag FROM flag_defs WHERE level='contrato' AND n_flagged > 0 AND weight > 0 ORDER BY weight DESC, flag")]
    per = N // len(flags)
    extra = N - per * len(flags)
    rnd = random.Random(SEED)
    rows, seen = [], set()
    pools = {}
    for f in flags:
        ids = [r[0] for r in con.execute("SELECT rowid FROM contract_flags WHERE flag = ?", (f,))]
        rnd.shuffle(ids)
        pools[f] = ids
    quota = {f: per + (1 if i < extra else 0) for i, f in enumerate(flags)}
    # bandeiras com poucos casos (ex.: NIF_INVALIDO) cedem a quota às bandeiras de maior peso, por ordem
    short = sum(max(0, q - len(pools[f])) for f, q in quota.items())
    for f in flags:
        if short <= 0:
            break
        if len(pools[f]) > quota[f] + 1:
            quota[f] += 1
            short -= 1
    for f in flags:
        k, ids, got = quota[f], pools[f], 0
        for rid in ids:
            if got >= k:
                break
            cid, ev = con.execute("SELECT contract_id, evidence_json FROM contract_flags WHERE rowid = ?", (rid,)).fetchone()
            if cid in seen:
                continue
            seen.add(cid)
            s = con.execute("SELECT procedure_id, score, flags FROM contract_score WHERE contract_id = ?", (cid,)).fetchone() or (None, None, None)
            c = con.execute("SELECT signed, procedure, price, buyer_nif, buyer_name, seller_nif, seller_name, object FROM p.contracts WHERE id = ?", (cid,)).fetchone()
            rows.append({"sample_id": len(rows) + 1, "stratum_flag": f, "contract_id": cid, "procedure_id": s[0], "signed": c[0], "procedure": c[1],
                         "price": c[2], "score": s[1], "all_flags": s[2], "buyer_nif": c[3], "buyer_name": c[4], "seller_nif": c[5], "seller_name": c[6],
                         "object": (c[7] or "").replace("\n", " ")[:300], "evidence_json": ev,
                         "base_url": f"https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id={cid}", "portal_url": f"#/contrato/{cid}",
                         "true_positive": "", "labeller": "", "notes": ""})
            got += 1
    LABELS.parent.mkdir(parents=True, exist_ok=True)
    with open(LABELS, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"{LABELS}: {len(rows)} contratos, {len(flags)} bandeiras (~{per} por bandeira, seed {SEED})")


def wilson(k, n, z=1.96):
    if not n:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(max(0, c - h), 3), round(min(1, c + h), 3)


def evaluate():
    if not LABELS.exists():
        print(f"{LABELS} não existe: a criar o modelo.")
        return template()
    strat, anyf = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    total = unl = 0
    with open(LABELS, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            total += 1
            v = (r.get("true_positive") or "").strip().lower()
            if v in YES:
                tp = 1
            elif v in NO:
                tp = 0
            else:
                unl += 1
                continue
            strat[r["stratum_flag"]][0] += tp
            strat[r["stratum_flag"]][1] += 1
            for f in filter(None, (r.get("all_flags") or "").split(",")):
                anyf[f][0] += tp
                anyf[f][1] += 1
    res = {"built": datetime.now().isoformat(timespec="seconds"), "labels_file": str(LABELS.relative_to(ROOT)), "rows": total, "unlabelled": unl,
           "by_stratum_flag": {f: {"true": k, "labelled": n, "precision": round(k / n, 3), "wilson95": wilson(k, n)} for f, (k, n) in sorted(strat.items())},
           "by_any_flag_present": {f: {"true": k, "labelled": n, "precision": round(k / n, 3), "wilson95": wilson(k, n)} for f, (k, n) in sorted(anyf.items())}}
    print(f"{total} linhas, {total - unl} rotuladas")
    print(f"{'bandeira':<28}{'rotul.':>7}{'verd.':>7}{'precisão':>10}  IC95%")
    for f, d in res["by_stratum_flag"].items():
        print(f"{f:<28}{d['labelled']:>7}{d['true']:>7}{d['precision']:>10.2f}  {d['wilson95']}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("->", OUT)
    return res


def main():
    if "--template" in sys.argv:
        template(force="--force" in sys.argv)
    else:
        evaluate()


if __name__ == "__main__":
    main()
