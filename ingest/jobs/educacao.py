"""Education domain -> data/educacao.db.

Sources (all public, no login):
  * Infoescolas 2020 (DGEEC via dados.gov.pt): schools + school units (agrupamentos, escolas nao agrupadas,
    private schools) with students per cycle (latest year in the files: 2018/19, Continente only)
  * Arquivo.pt "Agrupamentos de escolas" CSV (dados.gov.pt): DGAE code, municipality, district, website
  * DGES "Acesso ao Ensino Superior" index: higher-education institutions + vagas 2026
  * Wikidata: websites / ids of higher-education institutions
  * AGSE (successor of DGAE + DGEstE, agse.pt): official teacher lists published as PDF
      - Concurso Nacional 2026/27 (interno/externo) and Mobilidade Interna / Contratacao Inicial lists
      - Reservas de Recrutamento 2026/27 (placement lists)
    Personal data minimisation: we store name, list context, graduacao/situacao and the AE of placement.
    We do NOT store the candidate "numero de utilizador" nor birth date, which the PDFs also contain.
  * DGEEC "Indicadores relativos a docentes" (HTML tables, national aggregates)
  * Construcao Publica EPE (ex Parque Escolar): public school portfolio + management documents
Run:  python3 ingest/run_all.py educacao      (EDU_STEPS=units,he,stats,pe,teachers to run a subset)
"""
import csv
import hashlib
import html
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, UA  # noqa: E402

NAME = "educacao"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
POLITICA = ROOT / "data" / "politica.db"
_last = {}

SCHEMA = """
CREATE TABLE IF NOT EXISTS units (
  code TEXT PRIMARY KEY,            -- DGEEC/DGAE code (6 digits) or 'DGES:xxxx' for higher education
  name TEXT NOT NULL, kind TEXT,    -- agrupamento | escola_nao_agrupada | escola_privada | ensino_superior | outra
  nature TEXT,                      -- Publica | Privada
  subsystem TEXT,                   -- ensino superior: universitario | politecnico | militar_policial
  municipality TEXT, district TEXT, website TEXT, wikidata TEXT,
  students INTEGER, students_year TEXT, students_json TEXT,   -- basic/secondary students per level (latest year)
  vagas_2026 INTEGER, n_courses INTEGER,                          -- higher ed (DGES)
  nif TEXT, entity_id INTEGER, match_how TEXT,                    -- link to politica.db
  norm TEXT, sources TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS units_norm ON units(norm);
CREATE INDEX IF NOT EXISTS units_nif ON units(nif);
CREATE INDEX IF NOT EXISTS units_ent ON units(entity_id);
CREATE INDEX IF NOT EXISTS units_mun ON units(municipality);
CREATE TABLE IF NOT EXISTS schools (
  code TEXT PRIMARY KEY, name TEXT, municipality TEXT, levels TEXT,
  students INTEGER, students_year TEXT, students_json TEXT, unit_code TEXT, source_url TEXT, norm TEXT
);
CREATE INDEX IF NOT EXISTS schools_mun ON schools(municipality);
CREATE TABLE IF NOT EXISTS teacher_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, page_url TEXT, page_title TEXT, pub_date TEXT, family TEXT,
  school_year TEXT, group_code TEXT, group_name TEXT, pdf_url TEXT UNIQUE, pdf_label TEXT, kind TEXT, n_rows INTEGER, parsed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS teacher_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER, sublist TEXT, ordem INTEGER, name TEXT, name_norm TEXT,
  tipo TEXT, graduacao REAL, situacao TEXT, provimento TEXT, placed_code TEXT, placed_name TEXT
);
CREATE INDEX IF NOT EXISTS te_list ON teacher_entries(list_id);
CREATE INDEX IF NOT EXISTS te_name ON teacher_entries(name_norm);
CREATE INDEX IF NOT EXISTS te_placed ON teacher_entries(placed_code);
CREATE TABLE IF NOT EXISTS teacher_stats (
  indicator TEXT, title TEXT, grp TEXT, series TEXT, year TEXT, value REAL, source_url TEXT
);
CREATE INDEX IF NOT EXISTS ts_ind ON teacher_stats(indicator);
CREATE TABLE IF NOT EXISTS pe_schools (
  id TEXT PRIMARY KEY, name TEXT, phase TEXT, district TEXT, architect TEXT, address TEXT, postcode TEXT,
  lat REAL, lon REAL, summary TEXT, completed TEXT, indicators_json TEXT, unit_code TEXT, source_url TEXT
);
CREATE TABLE IF NOT EXISTS pe_docs (title TEXT, category TEXT, year TEXT, url TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS pe_totals (label TEXT, value INTEGER, source_url TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


# ---------------------------------------------------------------- helpers
def log(*a):
    print("[educacao]", *a, flush=True)


def fetch(url, cache=None, delay=0.8, binary=False, data=None, timeout=90):
    """Cached, rate-limited GET (or POST when data given). Returns bytes (binary) or str."""
    p = None
    if cache:
        p = RAW / cache
        if p.exists() and p.stat().st_size > 0:
            b = p.read_bytes()
            return b if binary else b.decode("utf-8", "replace")
    host = urllib.parse.urlparse(url).netloc
    wait = _last.get(host, 0) + delay - time.time()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA}, data=data)
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
            _last[host] = time.time()
            if p:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b)
            return b if binary else b.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + attempt * 3)
    raise last


def strip_acc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn")


STOP = {"de", "do", "da", "dos", "das", "e", "a", "o", "em", "no", "na", "d", "s", "ep"}
PREFIX = re.compile(r"^(agrupamento (vertical )?de escolas|agrupamento de escola|agrupamento|escolas|escola)\b")


def norm(s, drop_muni=False):
    s = strip_acc((s or "").lower())
    s = html.unescape(s)
    if drop_muni and "," in s:
        s = s.rsplit(",", 1)[0]
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = PREFIX.sub("", s.strip()).strip()
    return " ".join(w for w in s.split() if w not in STOP)


def pname(s):
    return re.sub(r"\s+", " ", strip_acc((s or "").upper())).strip()


# ---------------------------------------------------------------- minimal xlsx reader (stdlib)
def read_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        x = z.read("xl/sharedStrings.xml").decode("utf8")
        for si in re.findall(r"<si>(.*?)</si>", x, re.S):
            ss.append(html.unescape("".join(re.findall(r"<t[^>]*>([^<]*)</t>", si))))
    wb = z.read("xl/workbook.xml").decode()
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    rmap = {}
    for rel in re.findall(r"<Relationship [^>]*/?>", rels):
        i = re.search(r'Id="([^"]+)"', rel)
        t = re.search(r'Target="([^"]+)"', rel)
        if i and t:
            rmap[i.group(1)] = t.group(1)
    out = {}
    for name, rid in re.findall(r'<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"', wb):
        t = rmap[rid].lstrip("/")
        t = t if t.startswith("xl/") else "xl/" + t
        x = z.read(t).decode("utf8")
        rows = []
        for r in re.findall(r"<row [^>]*>(.*?)</row>", x, re.S):
            row = {}
            for m in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', r, re.S):
                col, attrs, body = m.groups()
                if not body:
                    continue
                v = re.search(r"<v>(.*?)</v>", body, re.S)
                if 't="s"' in attrs and v:
                    val = ss[int(v.group(1))]
                elif 't="inlineStr"' in attrs:
                    val = html.unescape("".join(re.findall(r"<t[^>]*>([^<]*)</t>", body)))
                elif v:
                    val = html.unescape(v.group(1))
                else:
                    continue
                row[col] = val
            rows.append(row)
        out[html.unescape(name)] = rows
    return out


def col_idx(c):
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def latest_year_cols(rows, hdr_idx):
    """Return (year, [col letters]) of the latest 'YYYY/YYYY' block in the header row."""
    hdr = rows[hdr_idx]
    yrs = {}
    for c, v in hdr.items():
        m = re.search(r"(20\d\d/20\d\d)", v or "")
        if m:
            yrs[c] = m.group(1)
    if not yrs:
        return None, []
    year = max(yrs.values())
    starts = sorted(yrs, key=col_idx)
    cols = []
    allcols = sorted(hdr, key=col_idx)
    for i, c in enumerate(starts):
        if yrs[c] != year:
            continue
        nxt = [x for x in allcols if col_idx(x) > col_idx(c)]
        end = col_idx(nxt[0]) - 1 if nxt else col_idx(c)
        # blocks without sub-headers (single column per year)
        sub = rows[hdr_idx + 1] if hdr_idx + 1 < len(rows) else {}
        if not any(col_idx(k) >= col_idx(c) and col_idx(k) <= end for k in sub) and not nxt:
            end = col_idx(c)
        cols += [k for k in range(col_idx(c), end + 1)]
    letters = []
    for n in cols:
        s = ""
        while n:
            n, r = divmod(n - 1, 26)
            s = chr(65 + r) + s
        letters.append(s)
    return year, letters


def to_int(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- 1. schools + units (Infoescolas, Arquivo.pt CSV)
LEVELS = {"1ciclo": "1.º ciclo", "2ciclo": "2.º ciclo", "3ciclo": "3.º ciclo", "secundario-ch": "Secundário (cursos científico-humanísticos)",
          "secundario-profissional": "Secundário profissional"}
INFO_DS = "https://dados.gov.pt/api/1/datasets/619d1c86078190caa6492d7a/"
INFO_PAGE = "https://dados.gov.pt/pt/datasets/infoescolas/"


def step_units(con):
    ds = json.loads(fetch(INFO_DS, "infoescolas_dataset.json"))
    urls = {}
    for r in ds["resources"]:
        m = re.search(r"infoescolas\d+-(.+?)-dadospor(escola|uo)\.xlsx", r["url"])
        if m:
            urls[(m.group(1), m.group(2))] = r["url"]
    log("infoescolas files:", len(urls))
    schools, units = {}, {}
    for (lvl, kind), url in sorted(urls.items()):
        if lvl not in LEVELS:
            continue
        fn = f"info_{lvl}_{kind}.xlsx"
        data = fetch(url, fn, binary=True, delay=1.5)
        (RAW / fn).write_bytes(data) if not (RAW / fn).exists() else None
        sheets = read_xlsx(RAW / fn)
        rows = sheets.get("Populacao")
        if not rows:
            continue
        hi = next(i for i, r in enumerate(rows) if (r.get("A") or "").startswith("Código"))
        year, cols = latest_year_cols(rows, hi)
        data_rows = rows[hi + 1:]
        for r in data_rows:
            if kind == "escola":
                code = (r.get("A") or "").strip()
                if not re.fullmatch(r"\d{6,7}", code):
                    continue
                n = sum(to_int(r.get(c)) or 0 for c in cols)
                s = schools.setdefault(code, {"code": code, "name": r.get("B"), "mun": r.get("C"), "lv": {}, "year": year})
                s["lv"][LEVELS[lvl]] = n
            else:
                a, b = (r.get("A") or "").strip(), (r.get("B") or "").strip()
                code = a if re.fullmatch(r"\d{6,7}", a) else b if re.fullmatch(r"\d{6,7}", b) else None
                if not code:
                    continue
                typ = (r.get("D") or "").strip()
                nature = (r.get("C") or "").strip()
                k = "agrupamento" if typ == "Agrupamento" else "escola_nao_agrupada" if typ == "Escola não agrupada" else "escola_privada" if nature == "Privada" else "outra"
                u = units.setdefault(code, {"code": code, "name": r.get("E"), "kind": k, "nature": "Privada" if nature == "Privada" else "Pública",
                                            "district": r.get("F"), "lv": {}, "year": year})
                u["lv"][LEVELS[lvl]] = sum(to_int(r.get(c)) or 0 for c in cols)
        log(" ", lvl, kind, "year", year, "cols", len(cols))
    # schools table
    for s in schools.values():
        tot = sum(s["lv"].values())
        con.execute("INSERT OR REPLACE INTO schools(code,name,municipality,levels,students,students_year,students_json,source_url,norm) VALUES(?,?,?,?,?,?,?,?,?)",
                    (s["code"], s["name"], s["mun"], ", ".join(k for k, v in s["lv"].items()), tot, s["year"], json.dumps(s["lv"], ensure_ascii=False), INFO_PAGE, norm(s["name"])))
    # Arquivo.pt CSV: DGAE code + municipality + website of agrupamentos / escolas nao agrupadas
    arq = {}
    try:
        d = json.loads(fetch("https://dados.gov.pt/api/1/datasets/6123eca1078190f85a660ea9/", "arquivo_dataset.json"))
        for r in d["resources"]:
            if r["format"] == "csv" and "agrupamentos" in r["url"]:
                txt = fetch(r["url"], "arquivo_agrupamentos.csv")
                for row in csv.reader(io.StringIO(txt)):
                    if len(row) < 12 or row[0].startswith("Tema"):
                        continue
                    m = re.search(r"C[óo]digo \(DGAE\)\s*-\s*(\d{6})", " ".join(row[10:13]))
                    if m:
                        arq[m.group(1)] = {"name": row[1].strip(), "web": row[3].strip(), "mun": row[8].strip(), "dist": row[9].strip()}
                log("arquivo.pt agrupamentos with DGAE code:", len(arq))
    except Exception as e:  # noqa: BLE001
        log("arquivo.pt CSV failed:", e)
    # merge
    for code, u in units.items():
        a = arq.get(code)
        sch = schools.get(code)
        name = (a or {}).get("name") or u["name"]
        mun = (a or {}).get("mun") or (sch or {}).get("mun")
        dist = (a or {}).get("dist") or u.get("district")
        tot = sum(u["lv"].values())
        srcs = ["Infoescolas 2020 (DGEEC)"] + (["Arquivo.pt/dados.gov.pt (código DGAE, concelho, sítio)"] if a else [])
        con.execute("INSERT OR REPLACE INTO units(code,name,kind,nature,municipality,district,website,students,students_year,students_json,norm,sources,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (code, name, u["kind"], u["nature"], mun, dist, (a or {}).get("web") or None, tot, u["year"], json.dumps(u["lv"], ensure_ascii=False),
                     norm(name, True), "; ".join(srcs), INFO_PAGE))
    # Arquivo-only codes (units absent from Infoescolas, e.g. newer mergers)
    added = 0
    for code, a in arq.items():
        if code not in units:
            k = "agrupamento" if a["name"].lower().startswith("agrupamento") else "escola_nao_agrupada"
            con.execute("INSERT OR IGNORE INTO units(code,name,kind,nature,municipality,district,website,norm,sources,source_url) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (code, a["name"], k, "Pública", a["mun"], a["dist"], a["web"] or None, norm(a["name"], True), "Arquivo.pt/dados.gov.pt", "https://dados.gov.pt/pt/datasets/6123eca1078190f85a660ea9/"))
            added += 1
    # attach schools -> unit (school code equals unit code for the sede)
    con.execute("UPDATE schools SET unit_code = code WHERE code IN (SELECT code FROM units)")
    con.commit()
    log(f"units={len(units)} (+{added} from Arquivo) schools={len(schools)}")


# ---------------------------------------------------------------- 2. higher education (DGES + Wikidata)
DGES_TYPES = {"11": ("Pública", "universitario"), "12": ("Pública", "politecnico"), "13": ("Pública", "militar_policial"),
              "21": ("Privada", "universitario"), "22": ("Privada", "politecnico")}


def step_he(con):
    n = 0
    for reg, (nature, sub) in DGES_TYPES.items():
        url = "https://www.dges.gov.pt/guias/indest.asp" + ("" if reg == "11" else f"?reg={reg}")
        try:
            raw = fetch(url, f"dges_{reg}.html", binary=True, delay=1.5).decode("latin1")
        except Exception as e:  # noqa: BLE001
            log("DGES failed", reg, e)
            continue
        cur = None
        for m in re.finditer(r"<div class='box9'><div class='lin-area-c1'>(\d+)</div><div class='lin-area-d2'>(.*?)</div></div>|<div class='lin-ce-c5'[^>]*>(\d+)</div>", raw, re.S):
            if m.group(1):
                if cur:
                    n += _he_save(con, cur, nature, sub, url)
                cur = {"code": m.group(1), "name": html.unescape(m.group(2)).strip(), "vagas": 0, "n": 0}
            elif cur:
                cur["vagas"] += int(m.group(3))
                cur["n"] += 1
        if cur:
            n += _he_save(con, cur, nature, sub, url)
    log("DGES institutions:", n)
    # Wikidata: websites / ids
    q = ('SELECT DISTINCT ?i ?iLabel ?web ?munLabel WHERE { ?i wdt:P17 wd:Q45; wdt:P31 ?cls. ?cls wdt:P279* wd:Q38723. '
         'FILTER NOT EXISTS {?i wdt:P576 ?d} OPTIONAL{?i wdt:P856 ?web} OPTIONAL{?i wdt:P131 ?mun} '
         'SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en". } }')
    try:
        req = urllib.request.Request("https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"}),
                                     headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
        cache = RAW / "wikidata_he.json"
        if cache.exists():
            wd = json.loads(cache.read_text())
        else:
            with urllib.request.urlopen(req, timeout=120) as r:
                wd = json.loads(r.read())
            cache.write_text(json.dumps(wd))
    except Exception as e:  # noqa: BLE001
        log("Wikidata HE failed:", e)
        wd = {"results": {"bindings": []}}
    bykey = {}
    for b in wd["results"]["bindings"]:
        bykey.setdefault(norm(b["iLabel"]["value"]), []).append(b)
    hit = 0
    for code, nm in con.execute("SELECT code, name FROM units WHERE kind='ensino_superior'").fetchall():
        k = norm(nm)
        bs = bykey.get(k)
        if bs:
            b = bs[0]
            con.execute("UPDATE units SET wikidata=?, website=COALESCE(website,?), municipality=COALESCE(municipality,?) WHERE code=?",
                        (b["i"]["value"].rsplit("/", 1)[-1], b.get("web", {}).get("value"), b.get("munLabel", {}).get("value"), code))
            hit += 1
    log(f"Wikidata matched {hit} HE institutions")
    con.commit()


def _he_save(con, cur, nature, sub, url):
    con.execute("INSERT OR REPLACE INTO units(code,name,kind,nature,subsystem,vagas_2026,n_courses,norm,sources,source_url) VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("DGES:" + cur["code"], cur["name"], "ensino_superior", nature, sub, cur["vagas"], cur["n"], norm(cur["name"], False),
                 "DGES Acesso ao Ensino Superior 2026", url))
    return 1


# ---------------------------------------------------------------- 3. DGEEC teacher statistics (HTML tables)
def step_stats(con):
    ds = json.loads(fetch("https://dados.gov.pt/api/1/datasets/5d39ccb5454ae3e5136214f6/", "dgeec_docentes_dataset.json"))
    con.execute("DELETE FROM teacher_stats")
    n = 0
    for r in ds["resources"]:
        url = r["url"]
        m = re.search(r"Indicador_(\d+_\d+)", url)
        if not m:
            continue
        try:
            raw = fetch(url, f"dgeec_ind_{m.group(1)}.html", binary=True, delay=1.0)
        except Exception as e:  # noqa: BLE001
            log("indicator failed", url, e)
            continue
        h = raw.decode("cp1252", "replace")
        t = re.search(r"<title>(.*?)</title>", h, re.S)
        title = html.unescape(re.sub(r"\s+", " ", t.group(1))).strip() if t else m.group(1)
        for tb in re.findall(r"<table.*?</table>", h, re.S):
            years, grp = None, None
            for row in re.findall(r"<tr.*?</tr>", tb, re.S):
                cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
                if not cells:
                    continue
                if years is None:
                    ys = [c for c in cells if re.fullmatch(r"\d{4}/\d{2}", c)]
                    if ys:
                        years = ys
                    continue
                nums = cells[-len(years):]
                labels = cells[:-len(years)]
                if len(nums) != len(years) or not labels:
                    continue
                vals = [c.replace(" ", "").replace(",", ".") for c in nums]
                if not any(re.fullmatch(r"-?\d+(\.\d+)?", v) for v in vals):
                    continue
                if len(labels) >= 2:
                    grp, series = labels[0], labels[1]
                else:
                    series = labels[0]
                for y, v in zip(years, vals):
                    if re.fullmatch(r"-?\d+(\.\d+)?", v):
                        con.execute("INSERT INTO teacher_stats VALUES(?,?,?,?,?,?,?)", (m.group(1).replace("_", "."), title, grp, series, y, float(v), url))
                        n += 1
    con.commit()
    log("teacher_stats rows:", n)


# ---------------------------------------------------------------- 4. Construcao Publica (ex Parque Escolar)
CP = "https://www.construcaopublica.gov.pt"


def step_pe(con):
    lst = fetch(CP + "/tabela.ashx", "cp_tabela.html", data=b"fase=&distrito=&escola=", delay=1.0)
    items = re.findall(r"<tr e-id='(\d+)'><td><a [^>]*>(.*?)</a></td><td[^>]*>(.*?)</td><td[^>]*>(.*?)</td></tr>", lst, re.S)
    log("Parque Escolar portfolio rows:", len(items))
    con.execute("DELETE FROM pe_schools")
    for eid, nm, phase, dist in items:
        url = f"{CP}/pt/escolas/{eid}"
        try:
            h = fetch(url, f"cp_escola_{eid}.html", delay=0.7)
        except Exception as e:  # noqa: BLE001
            log("PE school failed", eid, e)
            h = ""

        def g(i):
            m = re.search(rf'id="{i}"[^>]*>(.*?)</(?:span|div|h2)>', h, re.S)
            return html.unescape(re.sub(r"<[^>]+>", " ", m.group(1))).strip() if m else None
        arch = g("m_arquitetura_text")
        addr, post = g("m_morada"), g("m_aux_morada")
        gps = re.search(r"GPS:</b>\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)", h)
        summ = re.search(r'id="m_apresentacao"[^>]*>(.*?)</div>', h, re.S)
        summ = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", summ.group(1)))).strip() if summ else None
        comp = re.search(r"conclu[ií]da em (\d{4})", summ or "", re.I)
        ind = {}
        for main, sec in re.findall(r"detalhe-div-main'>(.*?)</span><span class='detalhe-div-sec'>(.*?)</span>", h, re.S):
            ind[html.unescape(re.sub(r"<[^>]+>", "", sec)).strip()] = html.unescape(main).strip()
        name = html.unescape(re.sub(r"\s+", " ", nm)).strip()
        con.execute("INSERT OR REPLACE INTO pe_schools VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (eid, name, html.unescape(phase).strip(), html.unescape(dist).strip().title(), arch, addr, post,
                     float(gps.group(1)) if gps else None, float(gps.group(2)) if gps else None, summ, comp.group(1) if comp else None,
                     json.dumps(ind, ensure_ascii=False), None, url))
    # counters + management documents
    edu = fetch(CP + "/pt/educacao.aspx", "cp_educacao.html", delay=1.0)
    con.execute("DELETE FROM pe_totals")
    for lim, lab in re.findall(r"class='count' limit='(\d+)'>0</span><span aria-hidden='true' class='counter-descr'>(.*?)</span>", edu):
        con.execute("INSERT INTO pe_totals VALUES(?,?,?)", (html.unescape(lab).strip(), int(lim), CP + "/pt/educacao.aspx"))
    con.execute("DELETE FROM pe_docs")
    ig = fetch(CP + "/pt/informacao_gestao", "cp_informacao_gestao.html", delay=1.0)
    for href, txt in re.findall(r"<a [^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>", ig, re.S):
        t = html.unescape(re.sub(r"<[^>]+>", "", txt)).strip()
        if ("download.ashx" in href or href.lower().endswith(".pdf")) and t:
            cat = ("Relatório e Contas" if t.startswith("Relatório e Contas") else "Governo societário" if "Governo Societário" in t or "Governo societário" in t
                   else "Execução orçamental trimestral" if "Execução Orçamental" in t else "Plano de atividades e orçamento" if t.startswith("Plano de Atividades") else "Outros")
            ym = re.search(r"(20\d\d)", t)
            con.execute("INSERT OR IGNORE INTO pe_docs VALUES(?,?,?,?)", (t, cat, ym.group(1) if ym else None, urllib.parse.urljoin(CP, href)))
    con.commit()
    log("pe_docs:", con.execute("SELECT COUNT(*) FROM pe_docs").fetchone()[0])


# ---------------------------------------------------------------- 5. AGSE teacher lists
AGSE = "https://agse.pt"
GROUP_RE = re.compile(r"Grupo[- _](\d{3})", re.I)
ROW = re.compile(r"^\s*(\d+)\s+(\d{10})\s+(.+?)(?=\s{2,})(.*)$")
UNIT_IN_ROW = re.compile(r"(?<!\d)(\d{6}) - (.+?)(?=\s{3,}|$)")
SIT = re.compile(r"(Não Colocad\w+|Colocad\w+|Renova\w+|Exclu[ií]d\w+|Retirad\w+|Desist\w+|Não Admitid\w+|Admitid\w+)")
GRAD = re.compile(r"(?<![\d.])(\d{1,3}\.\d{3})(?![\d.])")


def parse_pdf_text(txt, family):
    """Yield dict rows from pdftotext -layout output. Birth date and user number are used for anchoring only."""
    sub = None
    for ln in txt.splitlines():
        if "Lista Definitiva" in ln or "Lista Provis" in ln:
            m = re.search(r"Lista (?:Definitiva|Provis\w+)\s*-\s*(.+?)\s*$", ln.strip())
            if m:
                sub = m.group(1).strip()
            continue
        m = ROW.match(ln)
        if not m:
            continue
        ordem, _uid, name, rest = int(m.group(1)), m.group(2), m.group(3).strip(), m.group(4)
        if len(name) < 3 or any(ch.isdigit() for ch in name):
            continue
        tipo = (rest.split() or [None])[0]
        g = GRAD.search(rest)
        bd = re.search(r"\d{2}/\d{2}/\d{4}", rest)
        sit = None
        if bd:
            sm = SIT.match(rest[bd.end():].strip())
            sit = sm.group(1) if sm else None
        um = UNIT_IN_ROW.search(rest[bd.end():] if bd else rest)
        prov = None
        pm = re.search(r"(QZP\.\d+|\b\d{6}\b)", rest)
        if pm and (not um or pm.start() < rest.find(um.group(0))):
            prov = pm.group(1)
        if not sit and (um or family == "reserva"):
            sit = "Colocado"
        yield {"sublist": sub, "ordem": ordem, "name": name, "tipo": tipo if tipo and not tipo[0].isdigit() else None,
               "grad": float(g.group(1)) if g and family != "reserva" else None, "sit": sit,
               "prov": prov, "placed_code": um.group(1) if um else None, "placed_name": um.group(2).strip() if um else None}


def pdf_text(path):
    try:
        return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, timeout=300).stdout.decode("utf-8", "replace")
    except FileNotFoundError:
        raise SystemExit("pdftotext (poppler) is required for the teacher lists")


def scan_page(url):
    h = fetch(url, "agse_pages/" + hashlib.md5(url.encode()).hexdigest() + ".html", delay=1.0)
    t = re.search(r"<title>(.*?)</title>", h, re.S)
    title = html.unescape(t.group(1)).replace(" - AGSE", "").strip() if t else url
    d = re.search(r'article:published_time" content="([^"]+)"', h)
    pubd = d.group(1)[:10] if d else None
    main = re.search(r"<main.*?</main>", h, re.S)
    body = main.group(0) if main else h
    pdfs = []
    for href, txt in re.findall(r'<a [^>]*href="([^"]+\.pdf)"[^>]*>(.*?)</a>', body, re.S):
        pdfs.append((href, html.unescape(re.sub(r"<[^>]+>", "", txt)).strip()))
    return title, pubd, pdfs, h


def step_teachers(con, max_reserves=40):
    pages = []
    seen = set()
    # (a) national concurso pages: discover 'listas definitivas' posts for the current school year
    conc = fetch(AGSE + "/concurso-nacional/", "agse_concurso_nacional.html", delay=1.0)
    for u in sorted(set(re.findall(r'href="(https://agse\.pt/[^"#]*listas-definitivas[^"#]*)"', conc))):
        pages.append((u, "concurso"))
    # (b) reserves of recrutamento 2026/27
    res = []
    for pg in range(1, 12):
        u = AGSE + "/category/reservas-de-recrutamento/" + (f"page/{pg}/" if pg > 1 else "")
        try:
            h = fetch(u, f"agse_cat_rr_{pg}.html", delay=1.0)
        except Exception:  # noqa: BLE001
            break
        found = re.findall(r'href="(https://agse\.pt/[^"#]*reserva[^"#]*2026-2027[^"#]*)"', h)
        if not found and pg > 3:
            break
        res += found
    for u in sorted(set(res), key=lambda s: int(re.search(r"recrutamento-(\d+)", s).group(1)) if re.search(r"recrutamento-(\d+)", s) else 0, reverse=True)[:max_reserves]:
        pages.append((u, "reserva"))
    log("AGSE pages to scan:", len(pages))
    con.execute("PRAGMA foreign_keys=OFF")
    for url, family in pages:
        if url in seen:
            continue
        seen.add(url)
        try:
            title, pubd, pdfs, _ = scan_page(url)
        except Exception as e:  # noqa: BLE001
            log("page failed", url, e)
            continue
        sy = "2026/2027" if "2026" in url else "2025/2026"
        # only keep PDFs under the 'colocacao'-type headings for reserves (classified from the PDF text itself)
        for href, label in pdfs:
            gm = GROUP_RE.search(href) or GROUP_RE.search(label.replace("–", " "))
            if not gm and family == "concurso":
                continue
            gcode = gm.group(1) if gm else None
            gname = re.sub(r"^Grupo\s+\d{3}\s*[–-]\s*", "", label).strip() if gm else label
            if con.execute("SELECT 1 FROM teacher_lists WHERE pdf_url=? AND parsed=1", (href,)).fetchone():
                continue
            fn = "agse_pdf/" + hashlib.md5(href.encode()).hexdigest() + ".pdf"
            try:
                data = fetch(href, fn, binary=True, delay=0.7, timeout=180)
            except Exception as e:  # noqa: BLE001
                log("pdf failed", href, e)
                continue
            if not (RAW / fn).exists():
                (RAW / fn).write_bytes(data)
            txt = pdf_text(RAW / fn)
            head = re.sub(r"\s+", " ", txt[:1500]).upper()
            if family == "reserva":
                if "NÃO COLOCAÇÃO" in head or "NAO COLOCAÇÃO" in head or "RETIRADOS" in head or "RETIRADO" in head:
                    kind = "skip"
                elif "COLOCAÇÃO ADMINISTRATIVA" in head:
                    kind = "colocacao_administrativa"
                elif "COLOCAÇÃO" in head:
                    kind = "colocacao"
                else:
                    kind = "skip"
            else:
                kind = "mobilidade_contratacao" if "MOBILIDADE" in head else "concurso_nacional"
            lid = con.execute("INSERT OR REPLACE INTO teacher_lists(page_url,page_title,pub_date,family,school_year,group_code,group_name,pdf_url,pdf_label,kind,n_rows,parsed) VALUES(?,?,?,?,?,?,?,?,?,?,0,0)",
                              (url, title, pubd, family, sy, gcode, gname, href, label, kind)).lastrowid
            if kind == "skip":
                con.execute("UPDATE teacher_lists SET parsed=1 WHERE id=?", (lid,))
                con.commit()
                continue
            if not gcode:
                gm2 = re.search(r"Grupo de Recrutamento (\d{3})\s*-\s*(.+)", txt[:2000]) or re.search(r"Grupo (\d{3}) - (.+)", txt[:3000])
                if gm2:
                    gcode, gname = gm2.group(1), gm2.group(2).strip()
                    con.execute("UPDATE teacher_lists SET group_code=?, group_name=? WHERE id=?", (gcode, gname, lid))
            con.execute("DELETE FROM teacher_entries WHERE list_id=?", (lid,))
            n = 0
            for r in parse_pdf_text(txt, family):
                con.execute("INSERT INTO teacher_entries(list_id,sublist,ordem,name,name_norm,tipo,graduacao,situacao,provimento,placed_code,placed_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (lid, r["sublist"], r["ordem"], r["name"], pname(r["name"]), r["tipo"], r["grad"], r["sit"], r["prov"], r["placed_code"], r["placed_name"]))
                n += 1
            con.execute("UPDATE teacher_lists SET n_rows=?, parsed=1 WHERE id=?", (n, lid))
            con.commit()
            log(f"  {title[:50]} | {label[:40]} | {kind} | {n} rows")
    con.commit()


# ---------------------------------------------------------------- 6. linking to politica.db + finishing
def step_link(con):
    if not POLITICA.exists():
        log("politica.db missing; skipping link")
        return
    p = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True)
    ents = p.execute("SELECT id, nif, name, kind FROM entities WHERE kind IN ('escola','universidade') OR name LIKE 'Agrupamento de Escolas%'").fetchall()
    ekey = {}
    for eid, nif, nm, kind in ents:
        for k in {norm(nm, False), norm(nm, True)}:
            if k:
                ekey.setdefault(k, set()).add((eid, nif))
    ukey = {}
    units = con.execute("SELECT code, name, kind FROM units").fetchall()
    for code, nm, kind in units:
        for k in {norm(nm, False), norm(nm, True)}:
            if k:
                ukey.setdefault(k, set()).add(code)
    # names of units from teacher lists (AGSE spelling) for codes not named by Infoescolas
    known = {c for c, _, _ in units}
    for code, nm in con.execute("SELECT placed_code, MAX(placed_name) FROM teacher_entries WHERE placed_code IS NOT NULL GROUP BY placed_code"):
        if code not in known and nm and not nm.startswith("QZP"):
            kind = "agrupamento" if nm.lower().startswith("agrupamento") else "escola_nao_agrupada"
            con.execute("INSERT OR IGNORE INTO units(code,name,kind,nature,norm,sources,source_url) VALUES(?,?,?,?,?,?,?)",
                        (code, re.sub(r"\s+", " ", nm), kind, "Pública", norm(nm, True), "AGSE listas de docentes", AGSE))
            ukey.setdefault(norm(nm, True), set()).add(code)
    # (the AGSE name can be wrapped on a following line; treat as display-only)
    con.execute("UPDATE units SET nif=NULL, entity_id=NULL, match_how=NULL")
    matched = 0
    for code, nm, kind in con.execute("SELECT code, name, kind FROM units").fetchall():
        cands = set()
        for k in {norm(nm, False), norm(nm, True)}:
            if k in ekey and len(ukey.get(k, ())) == 1:
                cands |= ekey[k]
        if len(cands) == 1:
            eid, nif = next(iter(cands))
            con.execute("UPDATE units SET nif=?, entity_id=?, match_how='nome normalizado (único)' WHERE code=?", (nif, eid, code))
            matched += 1
    # Parque Escolar schools -> units by name (+district)
    for pid, nm in con.execute("SELECT id, name FROM pe_schools").fetchall():
        k = norm(nm, True)
        cands = {c for c in ukey.get(k, ())} | {c for c in ukey.get(norm(nm, False), ())}
        if len(cands) == 1:
            con.execute("UPDATE pe_schools SET unit_code=? WHERE id=?", (next(iter(cands)), pid))
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM units WHERE kind IN ('agrupamento','escola_nao_agrupada','ensino_superior') OR (kind='escola_privada')").fetchone()[0]
    pub = con.execute("SELECT COUNT(*) FROM units WHERE nature='Pública' AND kind IN ('agrupamento','escola_nao_agrupada')").fetchone()[0]
    pub_m = con.execute("SELECT COUNT(*) FROM units WHERE nature='Pública' AND kind IN ('agrupamento','escola_nao_agrupada') AND nif IS NOT NULL").fetchone()[0]
    he = con.execute("SELECT COUNT(*) FROM units WHERE kind='ensino_superior'").fetchone()[0]
    he_m = con.execute("SELECT COUNT(*) FROM units WHERE kind='ensino_superior' AND nif IS NOT NULL").fetchone()[0]
    priv = con.execute("SELECT COUNT(*) FROM units WHERE kind='escola_privada'").fetchone()[0]
    priv_m = con.execute("SELECT COUNT(*) FROM units WHERE kind='escola_privada' AND nif IS NOT NULL").fetchone()[0]
    ent_total = len([1 for e in ents if e[3] == "escola"])
    ent_hit = con.execute("SELECT COUNT(DISTINCT entity_id) FROM units WHERE entity_id IS NOT NULL").fetchone()[0]
    stats = {"units_total": total, "public_units": pub, "public_matched": pub_m, "he": he, "he_matched": he_m, "private": priv, "private_matched": priv_m,
             "entities_escola": ent_total, "entities_linked": ent_hit}
    con.execute("INSERT OR REPLACE INTO meta VALUES('match_stats', ?)", (json.dumps(stats),))
    con.commit()
    log("match stats:", stats)
    p.close()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    steps = (os.environ.get("EDU_STEPS") or "units,he,stats,pe,teachers,link").split(",")
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    for s in steps:
        t = time.time()
        try:
            {"units": step_units, "he": step_he, "stats": step_stats, "pe": step_pe, "teachers": step_teachers, "link": step_link}[s](con)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            log(f"step {s} FAILED: {e}")
        log(f"step {s} done in {time.time() - t:.0f}s")
    con.execute("INSERT OR REPLACE INTO meta VALUES('built_at', datetime('now'))")
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
