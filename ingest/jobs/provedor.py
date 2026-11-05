import html
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.robotparser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA  # noqa: E402

NAME = "provedor"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
BASE = "https://www.provedor-jus.pt"
LIST = BASE + "/atividade/relatorios-anuais-de-atividade/"
GAP = 1.5
_last = [0.0]
_rp = []

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS reports (
  year INTEGER PRIMARY KEY, title TEXT, published TEXT, page_url TEXT, pdf_url TEXT, pages INTEGER, text_ok INTEGER, n_stats INTEGER);
CREATE TABLE IF NOT EXISTS stats (
  year INTEGER, metric TEXT, scope TEXT, label TEXT, value REAL, unit TEXT, quote TEXT, page INTEGER, source_url TEXT);
CREATE INDEX IF NOT EXISTS st_year ON stats(year);
CREATE INDEX IF NOT EXISTS st_metric ON stats(metric, year);
"""


def robots_ok(url):
    if not _rp:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(BASE + "/robots.txt", headers={"User-Agent": UA})
            rp.parse(urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace").splitlines())
            _rp.append(rp)
        except Exception:
            _rp.append(None)
    return _rp[0] is None or _rp[0].can_fetch(UA, url)


def get(url):
    if not robots_ok(url):
        raise RuntimeError("robots: " + url)
    wait = GAP - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    p = urllib.parse.urlsplit(url)
    url = urllib.parse.urlunsplit((p.scheme, p.netloc, urllib.parse.quote(p.path, safe="/%"), p.query, ""))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for i in range(3):
        try:
            data = urllib.request.urlopen(req, timeout=120).read()
            _last[0] = time.time()
            return data
        except Exception as e:
            _last[0] = time.time()
            if i == 2:
                raise
            time.sleep(4)


def cached(url, name, binary=False):
    f = RAW / name
    if f.exists() and f.stat().st_size > 0 and time.time() - f.stat().st_mtime < 20 * 3600:
        return f.read_bytes() if binary else f.read_text("utf-8")
    data = get(url)
    f.write_bytes(data)
    return data if binary else data.decode("utf-8", "replace")


def discover():
    out = {}
    page = 1
    while page <= 12:
        url = LIST if page == 1 else f"{LIST}page/{page}/"
        try:
            h = cached(url, f"list{page}.html")
        except Exception:
            break
        slugs = re.findall(r'href="(https://www\.provedor-jus\.pt/documentos/(relatorio-a-assembleia-da-republica-(\d{4})(?:-provedor-de-justica)?)/)"', h)
        for u, s, y in slugs:
            out.setdefault(int(y), u)
        if f"/page/{page + 1}/" not in h:
            break
        page += 1
    return out


def detail(url, year):
    h = cached(url, f"d{year}.html")
    t = re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", t.group(1))).strip() if t else f"Relatório à Assembleia da República {year}"
    d = re.search(r"Data:\s*(\d{4}-\d{2}-\d{2})", h)
    pdfs = [html.unescape(x) for x in re.findall(r'href="([^"]*documentos/[^"]*\.pdf)"', h)]
    pdfs = [x for x in pdfs if not re.search(r"organograma|Mapa_Pessoal|Regulamento_Interno|secretariado", x, re.I)]
    pdf = pdfs[0] if pdfs else None
    if pdf and pdf.startswith("/"):
        pdf = BASE + pdf
    return title, d.group(1) if d else None, pdf


def to_text(pdf_url, year):
    txt = RAW / f"{year}.txt"
    if txt.exists():
        return txt.read_text("utf-8", "replace")
    pdf = RAW / f"{year}.pdf"
    pdf.write_bytes(cached_bin(pdf_url))
    subprocess.run(["pdftotext", "-layout", str(pdf), str(txt)], stderr=subprocess.DEVNULL, timeout=600)
    pdf.unlink(missing_ok=True)
    return txt.read_text("utf-8", "replace") if txt.exists() else ""


def cached_bin(url):
    return get(url)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    reports = discover()
    print("reports found:", len(reports))
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    con.execute("DELETE FROM reports")
    con.execute("DELETE FROM stats")
    from _provedor_stats import extract
    errors = []
    for year in sorted(reports):
        page_url = reports[year]
        try:
            title, pub, pdf = detail(page_url, year)
        except Exception as e:
            errors.append(f"{year}: {e}")
            continue
        text, pages, ok = "", None, 0
        if pdf:
            try:
                text = to_text(pdf, year)
                ok = 1 if len(text) > 5000 else 0
                pages = text.count("\f") or None
            except Exception as e:
                errors.append(f"{year} pdf: {e}")
        rows = extract(year, text, pdf or page_url) if ok else []
        con.execute("INSERT INTO reports VALUES (?,?,?,?,?,?,?,?)", (year, title, pub, page_url, pdf, pages, ok, len(rows)))
        con.executemany("INSERT INTO stats VALUES (?,?,?,?,?,?,?,?,?)", rows)
        con.commit()
        print(year, pdf is not None, ok, len(rows))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('errors', ?)", ("; ".join(errors),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (LIST,))
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
