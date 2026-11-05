"""INE municipal indicators -> data/ine_series.db.

Source: INE json_indicador API (https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=<code>&Dim1=T&lang=PT);
www.ine.pt serves no robots.txt restrictions for it and robots are still checked. Municipalities are joined only on the
INE geographic code (last 4 digits of the 7-digit NUTS-2013/2024 municipality code = DICO) against autarquias.db.
Where INE split a series on the NUTS 2024 revision, both ids are fetched and the newer one overrides repeated years.

Run: python3 ingest/run_all.py ine_series
"""
import json
import re
import sqlite3
import statistics
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT  # noqa: E402

NAME = "ine_series"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
AUTARQUIAS = DATA_DIR / "autarquias.db"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 politica-pt/0.1"
URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"

# key, theme, label, unit, higher is "more" (for neutral ordering), [ids oldest first]
IND = [
    ("pop", "Demografia", "População residente", "hab.", ["0008273"]),
    ("densidade", "Demografia", "Densidade populacional", "hab./km²", ["0008337", "0013189"]),
    ("envelhecimento", "Demografia", "Índice de envelhecimento", "idosos por 100 jovens", ["0008258", "0012909"]),
    ("dep_idosos", "Demografia", "Índice de dependência de idosos", "idosos por 100 em idade ativa", ["0008259", "0012910"]),
    ("natalidade", "Demografia", "Taxa bruta de natalidade", "‰", ["0008264", "0013044"]),
    ("saldo_migratorio", "Demografia", "Saldo migratório", "pessoas", ["0008269", "0013179"]),
    ("ganho_medio", "Rendimento", "Ganho médio mensal", "€", ["0012653"]),
    ("poder_compra", "Rendimento", "Poder de compra per capita (Portugal = 100)", "índice", ["0014580"]),
    ("crime", "Segurança", "Taxa de criminalidade", "‰", ["0008074", "0012260"]),
    ("medicos", "Saúde", "Médicas/os por 1000 habitantes", "por 1000 hab.", ["0012837"]),
    ("enfermeiros", "Saúde", "Enfermeiras/os por 1000 habitantes", "por 1000 hab.", ["0012842"]),
    ("farmacias", "Saúde", "Farmácias e postos farmacêuticos por 1000 habitantes", "por 1000 hab.", ["0013202"]),
    ("fogos_licenciados", "Habitação", "Fogos licenciados em construção nova", "fogos", ["0008309", "0013235"]),
    ("dormidas", "Turismo", "Dormidas em alojamento turístico", "dormidas", ["0009183"]),
    ("energia_hab", "Ambiente", "Consumo de energia elétrica por habitante", "kWh/hab.", ["0014162"]),
    ("residuos_hab", "Ambiente", "Resíduos urbanos recolhidos por habitante", "kg/hab.", ["0012765"]),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS indicador (key TEXT PRIMARY KEY, theme TEXT, label TEXT, unit TEXT, ids TEXT, description TEXT, first_year INTEGER, last_year INTEGER, n_municipios INTEGER, source_url TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS obs (ind TEXT, dico TEXT, year INTEGER, value REAL, varcd TEXT, source_url TEXT, PRIMARY KEY (ind, dico, year));
CREATE INDEX IF NOT EXISTS obs_dico ON obs(dico);
CREATE TABLE IF NOT EXISTS nacional (ind TEXT, year INTEGER, median REAL, mean REAL, n INTEGER, ine_pt REAL, PRIMARY KEY (ind, year));
"""

_last = {}
_robots = {}


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
                ct = r.headers.get("content-type") or ""
                if r.status == 200 and "text/html" not in ct:
                    rp.parse(r.read().decode("utf-8", "replace").splitlines())
                else:
                    rp.parse([])
        except Exception:  # noqa: BLE001
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(UA, url)


def get(url, name, ttl_days=20, wait=1.4):
    RAW.mkdir(parents=True, exist_ok=True)
    cache = RAW / name
    if cache.exists() and cache.stat().st_size > 0 and time.time() - cache.stat().st_mtime < ttl_days * 86400:
        return cache
    if not robots_ok(url):
        raise PermissionError("robots.txt disallows " + url)
    host = urllib.parse.urlparse(url).netloc
    last = None
    for attempt in range(5):
        dt = time.time() - _last.get(host, 0)
        if dt < wait:
            time.sleep(wait - dt)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
            tmp = cache.with_suffix(".part")
            with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 16)
                    if not b:
                        break
                    f.write(b)
            _last[host] = time.time()
            head = tmp.read_bytes()[:600]
            if b'"Falso"' in head or b"n\xc3\xa3o existe" in head:
                raise RuntimeError("INE devolveu erro: " + head[:120].decode("utf-8", "replace"))
            tmp.replace(cache)
            return cache
        except Exception as e:  # noqa: BLE001
            last = e
            _last[host] = time.time()
            time.sleep(4 * 2 ** attempt)
    raise RuntimeError(f"{url}: {last}")


def connect():
    con = sqlite3.connect(DB, timeout=120)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=120000")
    con.executescript(SCHEMA)
    return con


def valid_dicos():
    a = sqlite3.connect(f"file:{AUTARQUIAS}?mode=ro", uri=True, timeout=120)
    s = {r[0] for r in a.execute("SELECT dico FROM municipios")}
    a.close()
    return s


def is_total(d):
    for k, v in d.items():
        if re.fullmatch(r"dim_\d+_t", k) and v and v.strip().lower() not in ("total", "hm"):
            return False
    return True


def fetch(v):
    f = get(URL.format(v=v), f"ine_{v}.json")
    d = json.loads(f.read_text(encoding="utf-8"))
    d = d[0] if isinstance(d, list) else d
    if "Dados" not in d:
        raise RuntimeError(str(d)[:140])
    return d


def main():
    dicos = valid_dicos()
    con = connect()
    failed = 0
    for key, theme, label, unit, ids in IND:
        merged = {}
        pt = {}
        desc = []
        upd = []
        ok_ids = []
        for v in ids:
            try:
                d = fetch(v)
            except Exception as e:  # noqa: BLE001
                log("  FALHOU", key, v, str(e)[:160])
                continue
            ok_ids.append(v)
            desc.append(d.get("IndicadorDsg", ""))
            upd.append(str(d.get("DataUltimoAtualizacao")))
            for period, recs in d["Dados"].items():
                if not re.fullmatch(r"\d{4}", period):
                    continue
                yr = int(period)
                for x in recs:
                    g = x.get("geocod", "")
                    if not is_total(x):
                        continue
                    try:
                        val = float(x.get("valor"))
                    except (TypeError, ValueError):
                        continue
                    if g == "PT":
                        pt[yr] = val
                    elif len(g) == 7 and g[-4:] in dicos:
                        merged[(g[-4:], yr)] = (val, v)
            log("  ", key, v, "ok")
        if not merged:
            log("  SEM DADOS", key)
            failed += 1
            continue
        con.execute("DELETE FROM obs WHERE ind=?", (key,))
        con.execute("DELETE FROM nacional WHERE ind=?", (key,))
        con.executemany("INSERT INTO obs VALUES (?,?,?,?,?,?)", [(key, dico, yr, val, v, META.format(v=v)) for (dico, yr), (val, v) in merged.items()])
        by_year = {}
        for (dico, yr), (val, _) in merged.items():
            by_year.setdefault(yr, []).append(val)
        con.executemany("INSERT INTO nacional VALUES (?,?,?,?,?,?)",
                        [(key, yr, statistics.median(vs), sum(vs) / len(vs), len(vs), pt.get(yr)) for yr, vs in by_year.items()])
        yrs = sorted(by_year)
        con.execute("INSERT OR REPLACE INTO indicador VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (key, theme, label, unit, ",".join(ok_ids), " | ".join(desc), yrs[0], yrs[-1], len({k[0] for k in merged}),
                     META.format(v=ok_ids[-1]), max(upd)))
        con.commit()
        log(key, f"{len(merged)} obs, {yrs[0]}-{yrs[-1]}, {len({k[0] for k in merged})} municipios")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (datetime.now(timezone.utc).isoformat(timespec="seconds"),))
    con.commit()
    con.close()
    log("indicadores sem dados:", failed)
    if failed == len(IND):
        raise SystemExit("INE inacessível")


if __name__ == "__main__":
    main()
