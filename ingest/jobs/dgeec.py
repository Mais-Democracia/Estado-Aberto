"""DGEEC education statistics -> data/dgeec.db.

Sources (public, no login; robots.txt of both hosts allows all; >=1 s between requests; raw cache data/raw/dgeec/):
  * DGEEC "Indicadores gerais da educacao", "Indicadores relativos a docentes", "Pessoal nao docente"
    (estatisticas-educacao.dgeec.medu.pt HTML tables, listed by the DGEEC datasets on dados.gov.pt): national and NUTS series.
  * Infoescolas 2020 (DGEEC via dados.gov.pt, XLSX per school): students per curricular year 2015/16-2018/19, Continente,
    aggregated per municipality and linked to the official DICO code of autarquias.db by exact municipality name.
Run: python3 ingest/run_all.py dgeec
"""
import html
import io
import json
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from orcamento import Book  # noqa: E402

NAME = "dgeec"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
AUT = DATA_DIR / "autarquias.db"
IND_DATASETS = ["5d385f4e454ae3079533be59", "5d39ccb5454ae3e5136214f6", "5d388cca454ae36a2dbdc82c"]
INFO_DATASET = "619d1c86078190caa6492d7a"
LEVELS = {"1ciclo": "1.º ciclo", "2ciclo": "2.º ciclo", "3ciclo": "3.º ciclo", "secundario-ch": "Secundário científico-humanístico", "secundario-profissional": "Secundário profissional"}
GROUPS = {"Total", "Público", "Privado", "Pública", "Privada", "Ensino público", "Ensino privado"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS indicators(indicator TEXT, title TEXT, grp TEXT, series TEXT, year TEXT, value REAL, source_url TEXT);
CREATE INDEX IF NOT EXISTS ind_i ON indicators(indicator);
CREATE TABLE IF NOT EXISTS mun_students(dico TEXT, municipality TEXT, level TEXT, year TEXT, students INTEGER, schools INTEGER, source_url TEXT);
CREATE INDEX IF NOT EXISTS ms_d ON mun_students(dico);
CREATE INDEX IF NOT EXISTS ms_l ON mun_students(level, year);
CREATE TABLE IF NOT EXISTS national_check(level TEXT, year TEXT, students INTEGER, source_url TEXT);
CREATE TABLE IF NOT EXISTS unmatched(municipality TEXT, level TEXT, students INTEGER);
"""


def log(*a):
    print("[dgeec]", *a, flush=True)


def fetch(url, name, binary=False, delay=1.0):
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    if not p.exists() or p.stat().st_size < 600:
        time.sleep(delay)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            p.write_bytes(r.read())
    return p.read_bytes() if binary else p


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def num(s):
    s = str(s).replace("\xa0", "").replace(" ", "").replace(",", ".")
    return float(s) if re.fullmatch(r"-?\d+(\.\d+)?", s) else None


def cells_of(row):
    return [html.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]


def step_indicators(con):
    con.execute("DELETE FROM indicators")
    seen, n = set(), 0
    for ds in IND_DATASETS:
        d = json.loads(fetch(f"https://dados.gov.pt/api/1/datasets/{ds}/", f"ds_{ds}.json", binary=True))
        log("dataset", ds, len(d["resources"]))
        for r in d["resources"]:
            m = re.search(r"Indicador_(\d+)_(\d+)", r["url"])
            if not m or m.group(0) in seen:
                continue
            seen.add(m.group(0))
            url = re.sub(r"^https?://(estatisticas-educacao|w3)\.dgeec\.mec\.pt(/dse/eef)?", "https://estatisticas-educacao.dgeec.medu.pt", r["url"])
            try:
                h = fetch(url, f"ind_{m.group(1)}_{m.group(2)}.html", binary=True).decode("cp1252", "replace")
            except Exception as e:  # noqa: BLE001
                log("indicator failed", url, e)
                continue
            t = re.search(r"<title>(.*?)</title>", h, re.S)
            title = html.unescape(re.sub(r"\s+", " ", t.group(1))).strip() if t else m.group(0)
            ind = f"{m.group(1)}.{m.group(2)}"
            for tb in re.findall(r"<table.*?</table>", h, re.S):
                rows = [c for c in (cells_of(x) for x in re.findall(r"<tr.*?</tr>", tb, re.S)) if c]
                if not rows:
                    continue
                head = rows[0]
                years = [c for c in head if re.fullmatch(r"\d{4}/\d{2}", c)]
                sub, labels = None, None
                if not years and len(rows) > 1 and all(re.fullmatch(r"\d{4}/\d{2}", c) for c in rows[1]):
                    sub, labels, body = rows[1], [c for c in head[1:] if c], rows[2:]
                    years = sub
                else:
                    body = rows[1:]
                if not years:
                    continue
                grp = None
                for cs in body:
                    if len(cs) < 2:
                        continue
                    lab, vals = cs[0], cs[1:]
                    if len(vals) != len(years) or not any(num(v) is not None for v in vals):
                        continue
                    if lab in GROUPS:
                        grp = lab
                    per = len(years) // len(labels) if labels else 0
                    for i, (y, v) in enumerate(zip(years, vals)):
                        x = num(v)
                        if x is None:
                            continue
                        ser = f"{lab} · {labels[min(i // per, len(labels) - 1)]}" if per else lab
                        con.execute("INSERT INTO indicators VALUES(?,?,?,?,?,?,?)", (ind, title, grp if lab not in GROUPS else None, ser, y, x, url))
                        n += 1
    con.commit()
    log("indicator rows:", n, "pages:", len(seen))


def step_municipal(con):
    muni = {}
    if AUT.exists():
        a = sqlite3.connect(AUT)
        for dico, name in a.execute("SELECT dico, name FROM municipios"):
            muni[norm(name)] = (dico, name)
        a.close()
    ds = json.loads(fetch(f"https://dados.gov.pt/api/1/datasets/{INFO_DATASET}/", "ds_infoescolas.json", binary=True))
    res = {}
    for r in ds["resources"]:
        m = re.search(r"infoescolas2020-(.+?)-dadosporescola\.xlsx", r["url"])
        if m and m.group(1) in LEVELS:
            res[m.group(1)] = r["url"]
    con.execute("DELETE FROM mun_students")
    con.execute("DELETE FROM national_check")
    con.execute("DELETE FROM unmatched")
    for key, url in res.items():
        level = LEVELS[key]
        b = Book(str(fetch(url, f"info_{key}_escola.xlsx", delay=1.5)))
        rows = b.rows("Populacao")
        hdr = rows[6]
        blocks = sorted((c, v) for c, v in hdr.items() if re.fullmatch(r"(Alunos em )?\d{4}/\d{4}", str(v)))
        ends = [c for c, v in hdr.items() if v == "Observações"]
        stop = min(ends) if ends else max(hdr) + 1
        spans = []
        for i, (c, v) in enumerate(blocks):
            e = blocks[i + 1][0] if i + 1 < len(blocks) else stop
            ys = re.search(r"(\d{4})/(\d{4})", v)
            spans.append((c, e, f"{ys.group(1)}/{ys.group(2)[2:]}"))
        agg, unm = {}, {}
        for rn in sorted(k for k in rows if k > 6):
            r = rows[rn]
            code = str(r.get(0, ""))
            if code == "TOTALPT":
                for c, e, y in spans:
                    con.execute("INSERT INTO national_check VALUES(?,?,?,?)", (level, y, int(sum(v for k, v in r.items() if c <= k < e and isinstance(v, float))), url))
                continue
            if not re.fullmatch(r"\d{6,7}", code.split(".")[0]):
                continue
            mun = r.get(2)
            hit = muni.get(norm(mun))
            for c, e, y in spans:
                s = sum(v for k, v in r.items() if c <= k < e and isinstance(v, float))
                if s <= 0:
                    continue
                if hit:
                    a = agg.setdefault((hit, y), [0, 0])
                    a[0] += s
                    a[1] += 1
                else:
                    unm[mun] = unm.get(mun, 0) + int(s)
        for ((dico, name), y), (s, sc) in agg.items():
            con.execute("INSERT INTO mun_students VALUES(?,?,?,?,?,?,?)", (dico, name, level, y, int(s), sc, url))
        for mun, s in unm.items():
            con.execute("INSERT INTO unmatched VALUES(?,?,?)", (mun, level, s))
        log(key, "municipalities:", len({d for (d, _y) in agg}), "unmatched names:", len(unm))
    con.commit()


def main():
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    step_indicators(con)
    step_municipal(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES('updated', datetime('now'))")
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
