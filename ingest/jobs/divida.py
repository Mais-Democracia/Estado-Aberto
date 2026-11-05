import datetime
import re
import sqlite3
import sys
import urllib.parse
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, download, get  # noqa: E402

NAME = "divida"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
FILES = {
    "stock": "Stock_divida_valores_mensais_Debt_stock_monthly_figures.xlsx",
    "ind": "Indicadores_divida_slonga_Debt_indicators_historical_series.xlsx",
}
SOURCE = "https://www.igcp.pt/pt/menu/divida-publica/estatisticas"
STOCK_ROWS = {6: ("total", "Dívida total"), 8: ("ot", "Obrigações do Tesouro"), 9: ("aforro", "Certificados de Aforro"), 10: ("ct", "Certificados do Tesouro"), 15: ("margem", "Contas margem")}
IND_ROWS = {7: ("pct_euro", "Dívida em euros (%)"), 8: ("pct_fixa", "Taxa fixa (%)"), 9: ("prazo_medio", "Prazo médio residual (anos)"), 10: ("duracao", "Duração modificada")}
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS series (code TEXT, label TEXT, date TEXT, value REAL, PRIMARY KEY (code, date));
CREATE TABLE IF NOT EXISTS series_meta (code TEXT PRIMARY KEY, label TEXT, unit TEXT, grp TEXT);
"""
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


def read_sheet(path):
    z = zipfile.ZipFile(path)
    ss = [re.sub(r"<[^>]+>", "", s) for s in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode(), re.S)]
    s = z.read("xl/worksheets/sheet1.xml").decode()
    out = {}
    for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', s, re.S):
        col, row, attr, body = m.groups()
        v = re.search(r"<v>([^<]*)</v>", body or "")
        if not v:
            continue
        v = v.group(1)
        if 't="s"' in attr:
            v = ss[int(v)]
        else:
            try:
                v = float(v)
            except ValueError:
                pass
        out.setdefault(int(row), {})[col] = v
    return out


def to_date(v):
    if isinstance(v, float):
        d = datetime.date(1899, 12, 30) + datetime.timedelta(days=int(v))
        return d.strftime("%Y-%m")
    m = re.match(r"([A-Za-z]{3})/(\d{2})$", str(v))
    if m and m.group(1) in MONTHS:
        return f"20{m.group(2)}-{MONTHS[m.group(1)]:02d}"
    return None


def fetch(name):
    p = RAW / name
    if p.exists():
        return p
    page = get(SOURCE, cache=True, max_age_h=24)
    m = re.search(r'href="([^"]*' + re.escape(name) + r')"', page)
    if not m:
        raise RuntimeError("ficheiro não encontrado: " + name)
    return download(urllib.parse.urljoin(SOURCE, m.group(1)), p)


def load(rows, date_row, spec, unit, grp, db):
    dates = {c: to_date(v) for c, v in rows[date_row].items() if c != "A"}
    n = 0
    for r, (code, label) in spec.items():
        db.execute("INSERT OR REPLACE INTO series_meta VALUES (?,?,?,?)", (code, label, unit, grp))
        for c, v in rows.get(r, {}).items():
            if c == "A" or not isinstance(v, float) or not dates.get(c):
                continue
            db.execute("INSERT OR REPLACE INTO series VALUES (?,?,?,?)", (code, label, dates[c], v))
            n += 1
    return n


def run():
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    db.execute("DELETE FROM series")
    n = load(read_sheet(fetch(FILES["stock"])), 4, STOCK_ROWS, "milhões de euros", "stock", db)
    n += load(read_sheet(fetch(FILES["ind"])), 6, IND_ROWS, "", "indicadores", db)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (datetime.date.today().isoformat(),))
    db.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (SOURCE,))
    db.commit()
    print(f"{NAME}: {n} pontos")
    db.close()


if __name__ == "__main__":
    run()
