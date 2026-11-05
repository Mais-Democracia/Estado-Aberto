"""Imigracao -> data/imigracao.db.

Sources (public, no login; robots.txt respected; cached in data/raw/imigracao/):
  * INE json_indicador API (www.ine.pt), indicators derived from the administrative register of foreign nationals with a
    legal residence status (SEF until 2023, AIMA afterwards): stock of foreign population with legal resident status,
    by municipality and nationality (0010247, 2014-2023, top nationalities only), by nationality at NUTS I (0001236,
    2000-2023), by sex (0001274, 1980-2023) and residence requests (0001230, 1992-2023).
  * AMA - dados.gov.pt dataset 'Registo Estrangeiros - Estatisticas PMC': requests to the portal service that issues tax,
    social security and health numbers for foreigners; one JSON snapshot per publication.
Run: python3 ingest/run_all.py imigracao
"""
import json
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA  # noqa: E402

NAME = "imigracao"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
INE = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
INE_META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"
AMA_API = "https://dados.gov.pt/api/1/datasets/registo-estrangeiros-estatisticas-pmc-1/"
AMA_PAGE = "https://dados.gov.pt/datasets/registo-estrangeiros-estatisticas-pmc-1"
INDICATORS = [
    ("0010247", "resid_conc", "Residentes estrangeiros por município e nacionalidade", 7),
    ("0001236", "resid_nat", "Residentes estrangeiros por nacionalidade (NUTS I)", 0),
    ("0001274", "resid_sex", "Residentes estrangeiros por sexo", 0),
    ("0001230", "pedidos_sex", "Pedidos de estatuto de residente por sexo", 0),
]
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS series (
  ds TEXT, year INTEGER, level TEXT, geo_code TEXT, geo_name TEXT, dico TEXT, nat_code TEXT, nat_name TEXT, sex TEXT,
  value INTEGER, indicator TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS s_ds ON series(ds, year, level);
CREATE INDEX IF NOT EXISTS s_dico ON series(dico, ds, year);
CREATE TABLE IF NOT EXISTS datasets (ds TEXT PRIMARY KEY, indicator TEXT, label TEXT, title TEXT, first_year INTEGER, last_year INTEGER,
  updated TEXT, rows INTEGER, source_url TEXT, api_url TEXT);
CREATE TABLE IF NOT EXISTS ama_pedidos (resource TEXT PRIMARY KEY, period TEXT, scope TEXT, value INTEGER, published TEXT, source_url TEXT);
"""
_robots = {}
_last = {}


def log(*a):
    print(*a, flush=True)


def robots_ok(url):
    p = urllib.parse.urlparse(url)
    host = p.scheme + "://" + p.netloc
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(host + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                if r.status == 200 and "text/html" not in (r.headers.get("content-type") or ""):
                    rp.parse(r.read().decode("utf-8", "replace").splitlines())
                else:
                    rp.parse([])
        except Exception:  # noqa: BLE001
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(UA, url)


def fetch(url, cache, ttl_days=7):
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / cache
    if f.exists() and f.stat().st_size > 0 and time.time() - f.stat().st_mtime < ttl_days * 86400:
        return json.loads(f.read_text("utf-8"))
    if not robots_ok(url):
        raise PermissionError("robots.txt disallows " + url)
    host = urllib.parse.urlparse(url).netloc
    last = None
    for attempt in range(2):
        time.sleep(max(0, 1.4 - (time.time() - _last.get(host, 0))))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                raw = r.read()
            _last[host] = time.time()
            d = json.loads(raw.decode("utf-8"))
            if isinstance(d, list) and d and isinstance(d[0], dict) and "Sucesso" in d[0]:
                raise RuntimeError("INE devolveu erro")
            f.write_bytes(raw)
            return d
        except Exception as e:  # noqa: BLE001
            last = e
            _last[host] = time.time()
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def level_of(g, clen):
    if g == "PT":
        return "PT", None
    if clen and len(g) == clen and g.isalnum():
        return "concelho", g[-4:]
    if len(g) == 1:
        return "nuts1", None
    if len(g) == 2 and g.isdigit():
        return "nuts2", None
    if len(g) == 3 and g.isalnum():
        return "nuts3", None
    return None, None


def load_ine(con):
    for v, ds, label, clen in INDICATORS:
        url = INE.format(v=v)
        try:
            d = fetch(url, f"ine_{v}.json")[0]
        except Exception as e:  # noqa: BLE001
            log("  INE falhou", v, str(e)[:120])
            continue
        rows = []
        for period, recs in d["Dados"].items():
            m = re.search(r"(\d{4})", period)
            if not m:
                continue
            yr = int(m.group(1))
            for x in recs:
                lvl, dico = level_of(x.get("geocod", ""), clen)
                if not lvl:
                    continue
                try:
                    val = int(round(float(x.get("valor"))))
                except (TypeError, ValueError):
                    continue
                nat = x.get("dim_3") if ds in ("resid_conc", "resid_nat") else None
                natn = x.get("dim_3_t") if nat else None
                sex = x.get("dim_3_t") if ds.endswith("_sex") else None
                rows.append((ds, yr, lvl, x["geocod"], x.get("geodsg"), dico, nat, natn, sex, val, v, INE_META.format(v=v)))
        con.execute("DELETE FROM series WHERE ds=?", (ds,))
        con.executemany("INSERT INTO series VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        ys = [r[1] for r in rows]
        con.execute("INSERT OR REPLACE INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (ds, v, label, d.get("IndicadorDsg"), min(ys) if ys else None, max(ys) if ys else None,
                     d.get("DataUltimoAtualizacao"), len(rows), INE_META.format(v=v), url))
        con.commit()
        log("  ", ds, len(rows), "linhas", min(ys) if ys else "", max(ys) if ys else "")


def load_ama(con):
    try:
        meta = fetch(AMA_API, "ama_dataset.json")
    except Exception as e:  # noqa: BLE001
        log("  AMA falhou", str(e)[:120])
        return
    con.execute("DELETE FROM ama_pedidos")
    n = 0
    for r in meta.get("resources", []):
        title = r.get("title") or ""
        m = re.search(r"-(\d{2})-(\d{4})-", title)
        try:
            d = fetch(r["url"], "ama_" + re.sub(r"[^A-Za-z0-9._-]", "_", title))
        except Exception as e:  # noqa: BLE001
            log("  AMA recurso falhou", title, str(e)[:80])
            continue
        period = f"{m.group(2)}-{m.group(1)}" if m else None
        for scope, val in (d.items() if isinstance(d, dict) else []):
            con.execute("INSERT OR REPLACE INTO ama_pedidos VALUES (?,?,?,?,?,?)",
                        (title, period, scope, int(val), (r.get("published") or r.get("created_at") or "")[:10], r["url"]))
            n += 1
    con.commit()
    log("   AMA", n, "valores")


def main():
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    load_ine(con)
    load_ama(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (datetime.now(timezone.utc).isoformat(timespec="seconds"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('ama_page', ?)", (AMA_PAGE,))
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
