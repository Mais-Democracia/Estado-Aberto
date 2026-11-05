import html
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT  # noqa: E402

NAME = "igf"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
BASE = "https://igf.gov.pt"
LIST = BASE + "/relatorios-administracao-local-autarquica"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
GAP = 1.2
_last = [0.0]
_rp = []
QUERIES = ["", "Município", "Auditoria", "Controlo", "Empresa", "EM", "SA", "Lda", "Associação", "Serviços", "Câmara", "Águas", "Fundação", "a", "e", "i", "o", "u", "de", "do", "da", "ao", "à", "-"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS reports (
  code TEXT PRIMARY KEY, year INTEGER, num INTEGER, title TEXT, subject TEXT, kind TEXT,
  report_url TEXT, n_docs INTEGER, match_kind TEXT, entity_nif TEXT, entity_name TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS rep_year ON reports(year);
CREATE INDEX IF NOT EXISTS rep_nif ON reports(entity_nif);
CREATE TABLE IF NOT EXISTS docs (
  code TEXT, label TEXT, filename TEXT, url TEXT, PRIMARY KEY (code, url));
"""


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def robots_ok(url):
    if not _rp:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(BASE + "/robots.txt", headers={"User-Agent": UA})
            rp.parse(urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace").splitlines())
            _rp.append(rp)
        except Exception:
            _rp.append(None)
        time.sleep(GAP)
    return _rp[0] is None or _rp[0].can_fetch("*", url)


def fetch(url, cache):
    f = RAW / cache
    if f.exists() and time.time() - f.stat().st_mtime < 20 * 3600:
        return f.read_text("utf-8")
    if not robots_ok(url):
        print("  robots.txt forbids", url)
        return None
    for attempt in range(3):
        w = _last[0] + GAP - time.time()
        if w > 0:
            time.sleep(w)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read().decode("utf-8", "replace")
            _last[0] = time.time()
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(data, "utf-8")
            return data
        except urllib.error.HTTPError as e:
            _last[0] = time.time()
            if e.code in (403, 404, 410):
                print("  HTTP", e.code, url)
                return None
            time.sleep(3 * (attempt + 1))
        except Exception as e:
            print("  retry", url, e)
            time.sleep(3 * (attempt + 1))
    return None


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def list_page(h):
    out = []
    for m in re.finditer(r'<tr>\s*<td[^>]*views-field-field-acao[^>]*>(.*?)</td>\s*<td[^>]*>\s*<a href="(/processo/[^"]+)"', h, re.S):
        out.append((clean(m.group(1)), m.group(2)))
    return out


def detail(h):
    code = re.search(r"Rel-AL-(\d{4})/(\d+)", h)
    docs = []
    for m in re.finditer(r'<a href="(/system/files/relat-al/[^"]+\.pdf)"[^>]*>([^<]*)</a>', h):
        before = h[max(0, m.start() - 400):m.start()]
        lab = re.findall(r">\s*([A-Za-zÀ-ÿ ]{3,30}?)\s*<", before)
        docs.append((lab[-1].strip() if lab else "", m.group(2).strip(), BASE + m.group(1)))
    return (int(code.group(1)), int(code.group(2))) if code else (None, None), docs


def classify(title):
    t = title.strip()
    m = re.match(r"^(?:Auditoria|Inspe[çc][ãa]o(?:\s+\w+)?)\s+ao\s+Munic[ií]pio\s+d[eao]s?\s+(.+)$", t, re.I)
    if m:
        return "municipio", re.split(r"\s+-\s+", m.group(1).strip())[0]
    m = re.match(r"^Auditoria\s+(?:[àa]s?|ao|aos)\s+(.+)$", t, re.I)
    if m:
        return "entidade", m.group(1).strip()
    return "tematico", None


def load_registry():
    p = ROOT / "data" / "politica.db"
    if not p.exists():
        return {}, {}
    c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    mun, emp = {}, {}
    for nif, name, kind in c.execute("SELECT nif, name, kind FROM entities WHERE kind IN ('municipio','empresa_municipal','cim_am') AND nif IS NOT NULL"):
        if kind == "municipio":
            mun.setdefault(norm(name), []).append((nif, name))
        else:
            emp.setdefault(norm(name), []).append((nif, name))
    return mun, emp


def link(kind, subject, mun, emp):
    if not subject:
        return None, None, None
    if kind == "municipio":
        s = re.sub(r"^(munic[ií]pio|c[âa]mara municipal)\s+d[eao]s?\s+", "", subject, flags=re.I)
        hit = mun.get(norm(s), [])
        if len(hit) == 1:
            return "municipio", hit[0][0], hit[0][1]
        return None, None, None
    hit = emp.get(norm(subject), [])
    if len(hit) == 1:
        return "nome_exato", hit[0][0], hit[0][1]
    return None, None, None


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    mun, emp = load_registry()
    errors = []
    seen = {}
    for qi, term in enumerate(QUERIES):
        before = len(seen)
        for page in range(60):
            params = {"page": page}
            if term:
                params["field_acao_value"] = term
            h = fetch(f"{LIST}?{urllib.parse.urlencode(params)}", f"list_{qi}_{page}.html")
            if h is None:
                errors.append(f"lista «{term}» página {page} indisponível")
                break
            items = list_page(h)
            if not items:
                break
            for title, path in items:
                seen.setdefault(path, title)
        print(f"  query {term!r}: +{len(seen) - before} -> {len(seen)}")
    con.execute("DELETE FROM reports")
    con.execute("DELETE FROM docs")
    for path, title in seen.items():
        h = fetch(BASE + path, "d_" + path.strip("/").replace("/", "_") + ".html")
        if h is None:
            errors.append(f"detalhe indisponível: {path}")
            continue
        (year, num), docs = detail(h)
        if year is None:
            m = re.search(r"rel-al-(\d{4})(\d+)", path)
            year, num = (int(m.group(1)), int(m.group(2))) if m else (None, None)
        kind, subject = classify(title)
        mk, nif, ename = link(kind, subject, mun, emp)
        code = f"{year}/{num}" if year else path
        main_doc = next((d for d in docs if d[0].lower().startswith("relat")), docs[0] if docs else None)
        con.execute("INSERT OR REPLACE INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (code, year, num, title, subject, kind, main_doc[2] if main_doc else None, len(docs), mk, nif, ename, BASE + path))
        con.executemany("INSERT OR REPLACE INTO docs VALUES (?,?,?,?)", [(code, d[0], d[1], d[2]) for d in docs])
        con.commit()
    n = con.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('errors', ?)", (repr(errors),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (LIST,))
    con.commit()
    print("reports", n, "linked", con.execute("SELECT COUNT(*) FROM reports WHERE entity_nif IS NOT NULL").fetchone()[0], "errors", len(errors))


if __name__ == "__main__":
    main()
