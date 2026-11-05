"""Autarquias: who governs each municipality / parish and how it spends.

Sources (all public, fetched with common.UA, cached in data/raw/autarquias/):
  * MAI / SGMAI election results site (static JSON behind the Angular apps)
      - 2025: https://www.eleicoes.mai.gov.pt/autarquicas2025/assets/static/...  (CM, AM per município; AF per freguesia;
              each file also carries the 2021 result as `previousResults`; heads of every list + elected mayor)
      - 2021: https://www.eleicoes.mai.gov.pt/autarquicas2021/assets/static/...  (territory keys LOCAL-DDMM00 = DICO code;
              `previousResults` = 2017; heads of list 2021)
  * DGAL Portal Autárquico, "Contas de Gerência": Demonstração de Execução Orçamental da Despesa / Receita (xlsx, one
    row per município with NIF, columns = economic classification), 2020-2025.
  * DGAL "Evolução do endividamento total, por município" PDFs 2014-2025 (needs `pdftotext`, poppler; skipped if absent).
  * Wikidata (P6324 INE code -> QID, P1082 population) and INE population (optional, flaky API).

Linking to data/politica.db (read-only): DGAL NIF == entities.nif (exact) ; fallback normalised name (+ district for
the homonyms Calheta/Lagoa); freguesias by (normalised name, municipality) then unique name.
Outputs: data/autarquias.db, data/exports/autarquias.csv
"""
import concurrent.futures as cf
import csv
import hashlib
import html
import json
import re
import shutil
import sqlite3
import subprocess
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from common import ROOT, UA

NAME = "autarquias"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
EXPORT = ROOT / "data" / "exports" / f"{NAME}.csv"
POLITICA = ROOT / "data" / "politica.db"

MAI25 = "https://www.eleicoes.mai.gov.pt/autarquicas2025/assets/static"
MAI21 = "https://www.eleicoes.mai.gov.pt/autarquicas2021/assets/static"
DGAL = "https://portalautarquico.dgal.gov.pt"
DGAL_CG = DGAL + "/pt-PT/financas-locais/dados-financeiros/contas-de-gerencia/"
DGAL_DEBT = DGAL + "/pt-PT/financas-locais/endividamento/municipios/evolucao/"
WD = "https://query.wikidata.org/sparql"

SCHEMA = """
CREATE TABLE municipios (
  dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_nif TEXT, wikidata TEXT,
  population INTEGER, population_year TEXT, population_source TEXT, population_est_2023 INTEGER,
  mai25_id INTEGER, match_method TEXT, source_url TEXT, nuts3 TEXT);
CREATE INDEX m_nif ON municipios(nif); CREATE INDEX m_enif ON municipios(entity_nif); CREATE INDEX m_wd ON municipios(wikidata);
CREATE TABLE freguesias (
  mai25_id INTEGER PRIMARY KEY, dico TEXT, name TEXT, entity_nif TEXT, match_method TEXT, source_url TEXT,
  name_key TEXT);  -- normalised '<freguesia>|<municipio>' (same rule as server/modules/autarquias.mjs fregKey)
CREATE INDEX f_dico ON freguesias(dico); CREATE INDEX f_enif ON freguesias(entity_nif); CREATE INDEX f_key ON freguesias(name_key);
-- one row per (territory, election year, organ); level = municipio | freguesia; code = dico or mai25 freguesia id
CREATE TABLE election_summary (
  level TEXT, code TEXT, year INTEGER, organ TEXT, registered INTEGER, voters INTEGER, turnout REAL,
  blank INTEGER, null_votes INTEGER, total_mandates INTEGER, source_url TEXT, PRIMARY KEY (level, code, year, organ));
CREATE TABLE election_results (
  level TEXT, code TEXT, year INTEGER, organ TEXT, party TEXT, party_type TEXT, list_name TEXT,
  votes INTEGER, pct REAL, mandates INTEGER, president INTEGER, source_url TEXT);
CREATE INDEX er_code ON election_results(level, code, year, organ);
-- people: elected mayor + head of every list (cabeça de lista). Councillors' full lists are not published by MAI.
CREATE TABLE mandates (
  dico TEXT, year INTEGER, organ TEXT, role TEXT, name TEXT, party TEXT, list_name TEXT, party_type TEXT,
  list_mandates INTEGER, elected INTEGER, source_url TEXT);
CREATE INDEX md_dico ON mandates(dico, year);
-- executed budget (cash basis) by economic chapter; kind = despesa | receita; value in EUR
CREATE TABLE finance (
  dico TEXT, nif TEXT, year INTEGER, kind TEXT, code TEXT, label TEXT, value REAL, source_url TEXT,
  PRIMARY KEY (dico, year, kind, code));
CREATE TABLE debt (
  dico TEXT, year INTEGER, debt_limit REAL, debt_total REAL, debt_excluded REAL, fam REAL, debt_for_limit REAL,
  source_url TEXT, PRIMARY KEY (dico, year));
CREATE TABLE metrics (
  dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_nif TEXT, wikidata TEXT, population INTEGER,
  population_year TEXT, population_source TEXT,
  mayor TEXT, party TEXT, party_family TEXT, party_type TEXT, list_name TEXT, party_2021 TEXT, party_2017 TEXT, changed_2025 INTEGER,
  winner_pct REAL, majority INTEGER, cm_mandates INTEGER, turnout_2025 REAL,
  fin_year INTEGER, expense REAL, revenue REAL, personnel REAL, goods_services REAL, capital_invest REAL,
  transfers_out REAL, interest REAL, taxes REAL, transfers_in REAL, balance REAL,
  expense_pc REAL, personnel_pct REAL, invest_pct REAL, own_revenue_pct REAL,
  debt_year INTEGER, debt REAL, debt_limit REAL, debt_pct_limit REAL, debt_pc REAL,
  rank_expense_pc INTEGER, rank_debt_pc INTEGER, rank_personnel_pct INTEGER, rank_invest_pct INTEGER, n_ranked INTEGER,
  pmp_date TEXT, pmp_days INTEGER, budget_year INTEGER, budget_exec_pct REAL, nuts3 TEXT);
-- revised budget (orçamento corrigido: previsões/dotações corrigidas) vs execution, DGAL 2015-2019 (stage = orcamento | executado)
CREATE TABLE budget (
  dico TEXT, year INTEGER, kind TEXT, stage TEXT, code TEXT, label TEXT, value REAL, source_url TEXT,
  PRIMARY KEY (dico, year, kind, stage, code));
-- prazo médio de pagamentos (days) at quarter end; partial=1 -> from a quarterly list that only names municípios > 60 days
CREATE TABLE pmp (dico TEXT, date TEXT, days INTEGER, partial INTEGER, source_url TEXT, PRIMARY KEY (dico, date));
-- CIM / áreas metropolitanas: NUTS III 2024 (= CIM/AM territory); member aggregates computed from municipal rows
CREATE TABLE cim (
  nuts3 TEXT PRIMARY KEY, name TEXT, entity_nif TEXT, transfer_oe2026 REAL, n_municipios INTEGER, population INTEGER,
  expense REAL, debt REAL, fin_year INTEGER, debt_year INTEGER, source_url TEXT, nuts_source_url TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""

EXP_CH = {"01": "Despesas com o pessoal", "02": "Aquisição de bens e serviços", "03": "Juros e outros encargos",
          "04": "Transferências correntes", "05": "Subsídios", "06": "Outras despesas correntes",
          "07": "Aquisição de bens de capital", "08": "Transferências de capital", "09": "Ativos financeiros",
          "10": "Passivos financeiros", "11": "Outras despesas de capital"}
REV_CH = {"01": "Impostos diretos", "02": "Impostos indiretos", "03": "Contribuições SS/CGA/ADSE",
          "04": "Taxas, multas e outras penalidades", "05": "Rendimentos da propriedade", "06": "Transferências correntes",
          "07": "Venda de bens e serviços correntes", "08": "Outras receitas correntes", "09": "Venda de bens de investimento",
          "10": "Transferências de capital", "11": "Ativos financeiros", "12": "Passivos financeiros",
          "13": "Outras receitas de capital", "14": "Recursos próprios comunitários", "15": "Reposições não abatidas",
          "16": "Saldo da gerência anterior"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


def muni_key(name):
    """'Município da Ribeira Grande' / 'RIBEIRA GRANDE' / 'Camara Municipal de X' -> 'ribeira grande'."""
    n = norm(name)
    n = re.sub(r"^(municipio|camara municipal|c m)( (de|da|do|das|dos))? ", "", n)
    return n


# ---------------------------------------------------------------- HTTP with on-disk cache
_last = {}


def fetch(url, binary=False, timeout=60, retries=2, refresh=False):
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / hashlib.sha1(url.encode()).hexdigest()[:20]
    if f.exists() and not refresh:
        b = f.read_bytes()
        return b if binary else b.decode("utf-8", "replace")
    host = urllib.parse.urlsplit(url).netloc
    for attempt in range(retries + 1):
        with _lock:                     # serialise the per-host clock across threads
            wait = 1.0 - (time.time() - _last.get(host, 0))
            if wait > 0: time.sleep(wait)
            _last[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
            f.write_bytes(b)
            return b if binary else b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if attempt == retries: raise
        except Exception:
            if attempt == retries: raise
        time.sleep(1.5 * (attempt + 1))


def fjson(url, **kw):
    t = fetch(url, **kw)
    try:
        return json.loads(t) if t else None
    except ValueError:
        return None


_lock = __import__("threading").Lock()


def pmap(fn, items, workers=4):
    """Parallel map; network politeness is enforced in fetch() (>=1 s between requests to the same host)."""
    with cf.ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


# ---------------------------------------------------------------- tiny xlsx reader (stdlib)
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def xlsx_rows(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si"):
            ss.append("".join(t.text or "" for t in si.iter(NS + "t")))
    rows = []
    for r in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(NS + "row"):
        row = {}
        for c in r.iter(NS + "c"):
            ref = re.match(r"[A-Z]+", c.get("r")).group(0)
            col = 0
            for ch in ref: col = col * 26 + ord(ch) - 64
            v, t = c.find(NS + "v"), c.get("t")
            if t == "inlineStr": val = "".join(x.text or "" for x in c.iter(NS + "t"))
            elif v is None: continue
            elif t == "s": val = ss[int(v.text)]
            else: val = v.text
            row[col - 1] = val
        if row: rows.append([row.get(j, "") for j in range(max(row) + 1)])
    return rows


# ---------------------------------------------------------------- elections
def mai_party_type(t):
    return {1: "partido", 2: "coligacao", 3: "grupo_cidadaos"}.get(t, str(t) if t is not None else None)


def guess_type(acr):
    if not acr: return None
    if re.match(r"^[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9./ -]+$", acr) and ("." in acr and "/" in acr or acr.count(".") >= 1 and len(acr) > 6): return "coligacao"
    return None


def store_result(con, level, code, year, organ, res, url, list_names=None):
    if not res or not res.get("resultsParty"): return 0
    reg, vot = res.get("subscribedVoters"), res.get("totalVoters") or res.get("numberVoters")
    con.execute("INSERT OR REPLACE INTO election_summary VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (level, str(code), year, organ, reg, vot, res.get("percentageVoters"), res.get("blankVotes"),
                 res.get("nullVotes"), res.get("totalMandates"), url))
    con.execute("DELETE FROM election_results WHERE level=? AND code=? AND year=? AND organ=?", (level, str(code), year, organ))
    for p in res["resultsParty"]:
        acr = p.get("acronym")
        con.execute("INSERT INTO election_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (level, str(code), year, organ, acr, mai_party_type(p.get("typeId")) if "typeId" in p else None,
                     (list_names or {}).get(acr), p.get("votes"), p.get("percentage"), p.get("mandates"),
                     p.get("presidents"), url))
    return 1


def elections_2021(con):
    """Canonical list of 308 municipalities (DICO from territory keys) + 2021 and 2017 CM/AM results + 2021 heads of list."""
    munis = []
    root = fjson(f"{MAI21}/territory-children/territory-children-LOCAL-500000.json") or []
    for d in root:
        for m in fjson(f"{MAI21}/territory-children/territory-children-{d['territoryKey']}.json") or []:
            dico = m["territoryKey"].split("-")[1][:4]
            munis.append((dico, m["name"], d["name"]))
    print("  MAI 2021 municipalities:", len(munis))

    def get(m):
        dico = m[0]; key = f"LOCAL-{dico}00"; out = {}
        for organ in ("CM", "AM"):
            url = f"{MAI21}/territory-results/territory-results-{key}-{organ}.json"
            out[organ] = (url, fjson(url))
        url = f"{MAI21}/candidates/parties-candidates-CM-{key}-1-false.json"
        out["cand"] = (url, fjson(url))
        return out
    data = pmap(get, munis)
    for (dico, name, district), d in zip(munis, data):
        con.execute("INSERT OR IGNORE INTO municipios (dico, name, district, source_url) VALUES (?,?,?,?)",
                    (dico, name, district, f"{MAI21}/territory-children/territory-children-LOCAL-{dico[:2]}0000.json"))
        for organ in ("CM", "AM"):
            url, r = d[organ]
            if not r: continue
            store_result(con, "municipio", dico, 2021, organ, r.get("currentResults"), url)
            store_result(con, "municipio", dico, 2017, organ, r.get("previousResults"), url)
        url, c = d["cand"]
        for t in (c or {}).get("electionCandidates", []):
            for p in t.get("candidates", []):
                for nm in p.get("effectiveCandidates") or []:
                    con.execute("INSERT INTO mandates VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (dico, 2021, "CM", "presidente" if p.get("presidents") else "cabeca_lista", nm.title(),
                                 p.get("party"), None, None, p.get("mandates"), 1 if (p.get("mandates") or 0) > 0 else 0, url))
    return munis


def elections_2025(con, munis):
    by_key = {(norm(d), norm(n)): dico for dico, n, d in munis}
    by_name = {}
    for dico, n, d in munis: by_name.setdefault(norm(n), []).append(dico)
    tree = []
    for d in (fjson(f"{MAI25}/territory/children-electionId=1-territoryId=1.json") or {}).get("data", []):
        for m in (fjson(f"{MAI25}/territory/children-electionId=1-territoryId={d['id']}.json") or {}).get("data", []):
            tree.append((d["descriptionShort"], m["id"], m["descriptionShort"]))
    print("  MAI 2025 municipalities:", len(tree))
    mapping = {}
    for dist, mid, mname in tree:
        dico = by_key.get((norm(dist), norm(mname)))
        if not dico and len(by_name.get(norm(mname), [])) == 1: dico = by_name[norm(mname)][0]
        if dico: mapping[mid] = dico
        else: print("   ! 2025 territory not matched:", dist, mname)
    for mid, dico in mapping.items():
        con.execute("UPDATE municipios SET mai25_id=? WHERE dico=?", (mid, dico))

    def get(mid):
        out = {}
        for organ, oid in (("CM", 4), ("AM", 5)):
            url = f"{MAI25}/result/territory-electionId=1-territoryId={mid}-organId={oid}.json"
            out[organ] = (url, fjson(url))
        url = f"{MAI25}/candidate/candidates-electionId=1-territoryId={mid}-votingOptionName=null-candidatesElected=false-page=1.json"
        out["cand"] = (url, fjson(url))
        url2 = f"{MAI25}/territory/children-electionId=1-territoryId={mid}.json"
        out["fregs"] = (url2, fjson(url2))
        return out
    mids = list(mapping)
    data = dict(zip(mids, pmap(get, mids)))
    fregs = []
    for mid, d in data.items():
        dico = mapping[mid]
        cand = (d["cand"][1] or {}).get("data") or {}
        names, heads = {}, []
        for t in cand.get("territories", []):
            for m in t.get("territories", []):
                for vo in m.get("votingOptions", []):
                    o = vo["votingOption"]; names[o["name"]] = o.get("description")
                    for c in vo.get("candidates", []):
                        heads.append((o, c))
        r = None
        for organ in ("CM", "AM"):
            url, r0 = d[organ]
            res = (r0 or {}).get("data") or {}
            store_result(con, "municipio", dico, 2025, organ, res.get("currentResults"), url, names if organ == "CM" else None)
            if organ == "CM": r = res
        mand = {p["acronym"]: p for p in ((r or {}).get("currentResults") or {}).get("resultsParty", [])}
        for o, c in heads:
            p = mand.get(o["name"], {})
            pres = c.get("state") == "President" or (p.get("presidents") or 0) > 0
            con.execute("INSERT INTO mandates VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (dico, 2025, "CM", "presidente" if pres else "cabeca_lista", c["name"], o["name"], o.get("description"),
                         mai_party_type(o.get("typeId")), p.get("mandates"), 1 if pres or (p.get("mandates") or 0) > 0 else 0, d["cand"][0]))
        # list names of 2021 lists are only acronyms; keep coalition long names from 2025 where acronym matches
        for f in ((d["fregs"][1] or {}).get("data") or []):
            fregs.append((f["id"], dico, f["descriptionShort"], d["fregs"][0]))
    print("  freguesias (2025 territories):", len(fregs))
    con.executemany("INSERT OR REPLACE INTO freguesias (mai25_id, dico, name, source_url) VALUES (?,?,?,?)", fregs)

    def getf(f):
        url = f"{MAI25}/result/territory-electionId=1-territoryId={f[0]}-organId=6.json"
        return url, fjson(url)
    n = 0
    for f, (url, r) in zip(fregs, pmap(getf, fregs, workers=6)):
        res = (r or {}).get("data") or {}
        n += store_result(con, "freguesia", f[0], 2025, "AF", res.get("currentResults"), url)
        store_result(con, "freguesia", f[0], 2021, "AF", res.get("previousResults"), url)
    print("  freguesia AF results stored:", n)
    return mapping


# ---------------------------------------------------------------- DGAL finance (execution) 2020+
def dgal_links(page_url):
    s = html.unescape(fetch(page_url, refresh=True) or "")
    return s


def dgal_finance(con, name_to_dico):
    s = dgal_links(DGAL_CG)
    marks = list(re.finditer(r"Contas de Gerência\s+(\d{4})", s))
    files = []
    for k, m in enumerate(marks):
        year = int(m.group(1))
        seg = s[m.start(): marks[k + 1].start() if k + 1 < len(marks) else m.start() + 30000]
        links = re.findall(r'<a[^>]+href="(/ficheiros/[^"]+)"[^>]*>(.*?)</a>', seg, re.S)
        seen = set()
        for u, t in links:
            t = re.sub(r"<[^>]+>", "", t).strip()
            kind = "despesa" if "Execução Orçamental da Despesa" in t else "receita" if "Execução Orçamental da Receita" in t else None
            if kind and (year, kind) not in seen:      # first link of each pair = xlsx ("ou em código aberto" = ods)
                seen.add((year, kind)); files.append((year, kind, DGAL + u))
    print("  DGAL execution files:", len(files))
    n = 0
    unmatched = set()
    for year, kind, url in files:
        b = fetch(url, binary=True, timeout=180)
        if not b or b[:2] != b"PK": print("   ! not xlsx:", year, kind); continue
        p = RAW / f"deo_{year}_{kind}.xlsx"; p.write_bytes(b)
        try:
            rows = xlsx_rows(p)
        except Exception as e:
            print("   ! xlsx parse", year, kind, e); continue
        hdr = next((r for r in rows if any(re.fullmatch(r"\d{10}", c or "") for c in r)), None)
        if not hdr: continue
        cols = {j: c[:2] for j, c in enumerate(hdr) if re.fullmatch(r"\d\d00000000", c or "")}
        for r in rows:
            nifj = next((j for j, c in enumerate(r[:8]) if re.fullmatch(r"[5-6]\d{8}", c or "")), None)
            if nifj is None: continue
            nif, name = r[nifj], next((c for c in reversed(r[:nifj]) if c and not c.isdigit()), "")
            dico = name_to_dico(name, nif)
            if not dico: unmatched.add(name); continue
            con.execute("UPDATE municipios SET nif=COALESCE(nif, ?) WHERE dico=?", (nif, dico))
            labels = EXP_CH if kind == "despesa" else REV_CH
            for j, code in cols.items():
                try: v = float(r[j]) if j < len(r) and r[j] not in ("", None) else 0.0
                except ValueError: continue
                con.execute("INSERT OR REPLACE INTO finance VALUES (?,?,?,?,?,?,?,?)",
                            (dico, nif, year, kind, code, labels.get(code, code), v, url)); n += 1
    if unmatched: print("   ! DGAL names not matched:", sorted(unmatched)[:20])
    print("  finance rows:", n)


def dgal_debt(con, name_to_dico):
    if not shutil.which("pdftotext"):
        print("  ! pdftotext not installed — debt PDFs skipped"); return
    s = dgal_links(DGAL_DEBT)
    n = 0
    for u, t in re.findall(r'<a[^>]+href="(/ficheiros/[^"]+)"[^>]*>(.*?)</a>', s, re.S):
        m = re.search(r"endividamento total (\d{4})$", re.sub(r"<[^>]+>", "", t).strip())
        if not m: continue
        year, url = int(m.group(1)), DGAL + u
        b = fetch(url, binary=True, timeout=180)
        if not b or not b.startswith(b"%PDF"): continue
        p = RAW / f"debt_{year}.pdf"; p.write_bytes(b)
        txt = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout
        for line in txt.splitlines():
            line = re.sub(r"\s*(\b[a-z]\)|\*+)", "", line)   # footnote markers "a)", "b)", "*"
            parts = re.split(r"\s{2,}", line.strip())
            if len(parts) < 7: continue
            nums = []
            for x in parts[2:]:
                x = x.replace(".", "").replace(" ", "")
                if not re.fullmatch(r"-?\d+", x): nums = None; break
                nums.append(float(x))
            if not nums or len(nums) != 5: continue
            lim, tot, exc, fam, rel = nums
            if abs((tot - exc - fam) - rel) > 2: continue          # sanity: (5)=(2)-(3)-(4)
            dico = name_to_dico(parts[1], None, parts[0])
            if not dico: continue
            con.execute("INSERT OR REPLACE INTO debt VALUES (?,?,?,?,?,?,?,?)", (dico, year, lim, tot, exc, fam, rel, url)); n += 1
    print("  debt rows:", n)



def dgal_budget(con, name_to_dico):
    """2015-2019 ODS: Previsões/Dotações corrigidas (revised budget) and Receita cobrada líquida / Despesa paga (execution)."""
    s = dgal_links(DGAL_CG)
    i = s.find("Contas de Gerência 2019"); j = s.find("Anos Anteriores", i)
    seg = s[i: j if j > 0 else None]
    year, files = 2019, {}
    for m in re.finditer(r'Contas de ger[êe]ncia\s+(\d{4})|<a[^>]+href="(/ficheiros/[^"]+)"[^>]*>(.*?)</a>', seg, re.S | re.I):
        if m.group(1): year = int(m.group(1)); continue
        u, t = m.group(2), re.sub(r"<[^>]+>", "", m.group(3)).strip()
        if "filetype=ods" not in u: continue
        y = int(re.search(r"(20\d\d)", t).group(1)) if re.search(r"(20\d\d)", t) else year
        tn = norm(t)
        key = ("receita", "orcamento") if "previs" in tn else ("despesa", "orcamento") if "dotac" in tn and "corrig" in tn else \
              ("receita", "executado") if "cobrada" in tn else ("despesa", "executado") if "despesa paga" in tn else None
        if key and (y, *key) not in files: files[(y, *key)] = DGAL + u
    print("  DGAL budget/execution ODS files:", len(files), sorted({k[0] for k in files}))
    T, X, O = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}", "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}", "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
    n, unmatched = 0, set()
    for (y, kind, stage), url in sorted(files.items()):
        b = fetch(url, binary=True, timeout=180)
        if not b or b[:2] != b"PK": print("   ! not ods", y, kind, stage); continue
        p = RAW / f"cg_{y}_{kind}_{stage}.ods"; p.write_bytes(b)
        root = ET.fromstring(zipfile.ZipFile(p).read("content.xml"))
        rows = []
        for r in next(root.iter(T + "table")).iter(T + "table-row"):
            row = []
            for c in r:
                if c.tag not in (T + "table-cell", T + "covered-table-cell"): continue
                v = c.get(O + "value")
                if v is None: v = " ".join("".join(x.itertext()) for x in c.iter(X + "p"))
                row.extend([v] * min(int(c.get(T + "number-columns-repeated", "1")), 60))
            rows.append(row)
        hdr = next((r for r in rows if sum(1 for c in r if re.fullmatch(r"\d\d", (c or "").strip())) >= 5), None)
        if not hdr: print("   ! no header", y, kind, stage); continue
        cols = {k: c.strip() for k, c in enumerate(hdr) if re.fullmatch(r"\d\d", (c or "").strip())}
        labels = EXP_CH if kind == "despesa" else REV_CH
        for r in rows:
            name = (r[0] if r else "").strip()
            if not name or not any(re.fullmatch(r"-?[\d.]+(E-?\d+)?", (r[k] if k < len(r) else "") or "") for k in cols): continue
            dico = name_to_dico(name)
            if not dico:
                if not re.search(r"total|portugal|continente", norm(name)): unmatched.add(name)
                continue
            for k, code in cols.items():
                try: v = float(r[k]) if k < len(r) and r[k] not in ("", None) else 0.0
                except ValueError: continue
                con.execute("INSERT OR REPLACE INTO budget VALUES (?,?,?,?,?,?,?,?)", (dico, y, kind, stage, code, labels.get(code, code), v, url)); n += 1
                if stage == "executado":
                    con.execute("INSERT OR IGNORE INTO finance VALUES (?,?,?,?,?,?,?,?)", (dico, None, y, kind, code, labels.get(code, code), v, url))
    if unmatched: print("   ! budget names not matched:", sorted(unmatched)[:15])
    print("  budget rows:", n)


DGAL_PMP = DGAL + "/pt-PT/financas-locais/endividamento/municipios/prazo-medio-de-pagamentos/"


def dgal_pmp(con, name_to_dico):
    if not shutil.which("pdftotext"):
        print("  ! pdftotext not installed — PMP skipped"); return
    s = dgal_links(DGAL_PMP)
    links = [(re.sub(r"<[^>]+>", "", t).strip(), DGAL + u) for u, t in re.findall(r'<a[^>]+href="(/ficheiros/[^"]+)"[^>]*>(.*?)</a>', s, re.S)]
    annual = [(t, u) for t, u in links if re.fullmatch(r"20\d\d", t)]
    quarterly = [(t, u) for t, u in links if re.fullmatch(r"\dT20\d\d", t)]
    latest_q = max(quarterly, key=lambda x: (x[0][2:], x[0][0]))[1:] if quarterly else None
    jobs = [(u, 0) for _, u in annual] + ([(latest_q[0], 1)] if latest_q else [])
    n, unmatched = 0, set()
    for url, partial in jobs:
        b = fetch(url, binary=True, timeout=180)
        if not b or not b.startswith(b"%PDF"): continue
        p = RAW / ("pmp_" + hashlib.sha1(url.encode()).hexdigest()[:10] + ".pdf"); p.write_bytes(b)
        txt = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout
        dates = []
        for line in txt.splitlines():
            ds = re.findall(r"(\d\d)/(\d\d)/(\d{4})", line)
            if len(ds) >= 3: dates = [f"{y}-{m}-{d}" for d, m, y in ds]; continue
            m = re.match(r"^\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇÀ][A-ZÁÉÍÓÚÂÊÔÃÕÇÀ .'()-]+?)\s{2,}((?:-?\d+|-)(?:\s+(?:-?\d+|-))*)\s*$", line)
            if not m or not dates: continue
            vals = m.group(2).split()
            if len(vals) != len(dates): continue
            dico = name_to_dico(m.group(1).strip())
            if not dico: unmatched.add(m.group(1).strip()); continue
            for d, v in zip(dates, vals):
                if v == "-": continue
                if partial and con.execute("SELECT 1 FROM pmp WHERE dico=? AND date=? AND partial=0", (dico, d)).fetchone(): continue
                con.execute("INSERT OR REPLACE INTO pmp VALUES (?,?,?,?,?)", (dico, d, int(v), partial, url)); n += 1
    if unmatched: print("   ! PMP names not matched:", sorted(unmatched)[:15])
    print("  pmp rows:", n)


DGAL_CIM = DGAL + "/pt-PT/financas-locais/transferencias/areas-metropolitanas-e-comunidades-intermunicipais/"


def cim_core(name):
    n = norm(name)
    n = re.sub(r"^(cim|am|comunidade intermunicipal|area metropolitana)( (de|da|do|das|dos))? ", "", n)
    n = re.sub(r"^(regiao|regiao de|terrras|terras)( (de|da|do|das|dos))? ", lambda m: "" if m.group(1).startswith("regiao") else "terras ", n)
    return n.replace("terrras", "terras").strip()


def cim(con):
    """NUTS III 2024 membership (from INE 0013902 geocodes: NUTS3 = first 3 chars, DICO = last 4) + OE2026 transfers (DGAL PDF)."""
    import difflib
    nurl = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0013902&Dim1=S7A2023&lang=PT"
    try:
        rows = json.loads(fetch(nurl, timeout=150) or "null")[0]["Dados"]["2023"]
    except Exception as e:
        print("  ! INE NUTS membership unavailable:", type(e).__name__); return
    names = {r["geocod"]: r["geodsg"] for r in rows if len(r["geocod"]) == 3}
    for r in rows:
        if len(r["geocod"]) == 7: con.execute("UPDATE municipios SET nuts3=? WHERE dico=?", (r["geocod"][:3], r["geocod"][-4:]))
    # NUTS 2024 splits the Área Metropolitana de Lisboa into Grande Lisboa (1A0) + Península de Setúbal (1B0);
    # the AML (an autarquia) still covers both, so it gets its own synthetic row "AML"; 1B0 stays as the CIM da Península de Setúbal.
    if "1A0" in names:
        names.pop("1A0"); names["AML"] = "Área Metropolitana de Lisboa"
    for code, name in names.items():
        con.execute("INSERT OR REPLACE INTO cim (nuts3, name, nuts_source_url) VALUES (?,?,?)", (code, name, nurl))
    # OE 2026 transfers
    trans = {}
    if shutil.which("pdftotext"):
        s = dgal_links(DGAL_CIM)
        for u, t in re.findall(r'<a[^>]+href="(/ficheiros/[^"]+)"[^>]*>(.*?)</a>', s, re.S):
            t = re.sub(r"<[^>]+>", "", t).strip()
            if not re.search(r"AM CIM", t): continue
            b = fetch(DGAL + u, binary=True, timeout=120)
            if not b or not b.startswith(b"%PDF"): continue
            p = RAW / "cim_transfers.pdf"; p.write_bytes(b)
            for line in subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout.splitlines():
                m = re.match(r"^\s*((?:AM|CIM) .+?)\s{2,}([\d ]+?)\s{2,}", line)
                if m: trans[m.group(1).strip()] = (float(m.group(2).replace(" ", "")), DGAL + u, re.search(r"OE\s*(\d{4})", t))
    cores = {code: cim_core(n) for code, n in names.items()}
    for tname, (v, url, _) in trans.items():
        c = cim_core(tname)
        best = max(cores, key=lambda k: difflib.SequenceMatcher(None, c, cores[k]).ratio() + (0.5 if c in cores[k] or cores[k] in c else 0))
        if difflib.SequenceMatcher(None, c, cores[best]).ratio() > 0.6 or c in cores[best] or cores[best] in c:
            con.execute("UPDATE cim SET transfer_oe2026=?, source_url=? WHERE nuts3=?", (v, url, best))
        else:
            print("   ! CIM transfer not matched:", tname)
    print("  CIM/AM (NUTS III):", len(names), "with OE2026 transfer:", con.execute("SELECT COUNT(transfer_oe2026) FROM cim").fetchone()[0])


def cim_aggregate(con):
    fy = con.execute("SELECT MAX(year) FROM finance WHERE kind='despesa'").fetchone()[0]
    dy = con.execute("SELECT MAX(year) FROM debt").fetchone()[0]
    for (code,) in con.execute("SELECT nuts3 FROM cim").fetchall():
        codes = ("1A0", "1B0") if code == "AML" else (code, code)
        n, pop = con.execute("SELECT COUNT(*), SUM(population) FROM municipios WHERE nuts3 IN (?,?)", codes).fetchone()
        exp = con.execute("SELECT SUM(value) FROM finance f JOIN municipios m ON m.dico=f.dico WHERE m.nuts3 IN (?,?) AND f.year=? AND f.kind='despesa'", (*codes, fy)).fetchone()[0]
        debt = con.execute("SELECT SUM(debt_total) FROM debt d JOIN municipios m ON m.dico=d.dico WHERE m.nuts3 IN (?,?) AND d.year=?", (*codes, dy)).fetchone()[0]
        con.execute("UPDATE cim SET n_municipios=?, population=?, expense=?, debt=?, fin_year=?, debt_year=? WHERE nuts3=?", (n, pop, exp, debt, fy, dy, code))


def link_cim(con):
    """CIM/AM -> politica.db entities (kind cim_am) by name core; prefer names starting with Comunidade/Área/CIM."""
    import difflib
    if not POLITICA.exists(): return
    p = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True, timeout=30)
    ents = [(nif, name) for nif, name in p.execute("SELECT nif, name FROM entities WHERE kind='cim_am' AND nif IS NOT NULL")
            if re.search(r"comunidade intermunicipal|area metropolitana|^cim", norm(name))]
    p.close()
    n = 0
    for code, name in con.execute("SELECT nuts3, name FROM cim").fetchall():
        c = cim_core(name)
        def score(e):
            core = cim_core(re.sub(r"^.*? - ", "", e[1]) if " - " in e[1] and not norm(e[1]).startswith(("comunidade", "area")) else e[1])
            return difflib.SequenceMatcher(None, c, core).ratio(), e[0]
        best = max(ents, key=score) if ents else None
        if best and score(best)[0] >= 0.85:
            con.execute("UPDATE cim SET entity_nif=? WHERE nuts3=?", (best[0], code)); n += 1
    print("  CIM -> entities:", n, "of", con.execute("SELECT COUNT(*) FROM cim").fetchone()[0])


# ---------------------------------------------------------------- Wikidata + INE population
def wikidata(con):
    q = """SELECT ?m ?ine ?pop ?t WHERE { ?m wdt:P31 wd:Q13217644; wdt:P6324 ?ine .
           OPTIONAL { ?m p:P1082 ?ps . ?ps ps:P1082 ?pop . OPTIONAL { ?ps pq:P585 ?t } } }"""
    try:
        t = fetch(WD + "?" + urllib.parse.urlencode({"query": q, "format": "json"}), timeout=120, refresh=True)
        rows = json.loads(t)["results"]["bindings"]
    except Exception as e:
        print("  ! wikidata failed:", e); return
    best = {}
    for b in rows:
        ine = b["ine"]["value"].strip()
        if re.fullmatch(r"\d{3}", ine): ine = ine.zfill(4)
        if not re.fullmatch(r"\d{4}", ine): continue
        qid = b["m"]["value"].rsplit("/", 1)[-1]
        pop, when = b.get("pop", {}).get("value"), b.get("t", {}).get("value", "")
        cur = best.get(ine)
        if cur is None or (pop and when > (cur[2] or "")): best[ine] = (qid, pop, when)
    n = 0
    for ine, (qid, pop, when) in best.items():
        n += con.execute("UPDATE municipios SET wikidata=?, population=COALESCE(population, ?), population_year=COALESCE(population_year, ?),"
                         " population_source=COALESCE(population_source, ?) WHERE dico=?",
                         (qid, int(float(pop)) if pop else None, when[:4] or None, "Wikidata P1082" if pop else None, ine)).rowcount
    print("  wikidata matched:", n)


def ine_population(con):
    """Per-capita denominator = INE Censos 2021 resident population (indicator 0011609, geocod = 4-digit DICO).
    INE's annual estimates (0008273) switched in 2021 to an administrative-records base and sum to 11.2M for 2023
    (vs 10.34M in the 2021 census), so they are stored only as a reference column, never used as denominator."""
    url = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0011609&Dim1=S7A2021&Dim3=T&Dim4=T&lang=PT"
    try:
        d = json.loads(fetch(url, timeout=150, retries=2) or "null")
        rows = (d or [{}])[0].get("Dados", {}).get("2021") or []
    except Exception as e:
        print("  ! INE Censos 2021 unavailable:", type(e).__name__); rows = []
    n = 0
    for r in rows:
        g = r.get("geocod", "")
        if len(g) == 4 and r.get("valor"):
            n += con.execute("UPDATE municipios SET population=?, population_year='2021', population_source='INE, Censos 2021 (indicador 0011609)', source_url=source_url WHERE dico=?",
                             (int(float(r["valor"])), g)).rowcount
    tot = con.execute("SELECT SUM(population) FROM municipios WHERE population_source LIKE 'INE, Censos 2021%'").fetchone()[0]
    print(f"  INE Censos 2021 population: {n} municipios, sum {tot}")
    if n and not (10_200_000 <= (tot or 0) <= 10_800_000):
        print("  ! census sum outside sanity band — check indicator")
    # reference only: INE administrative-base estimate 2023
    url2 = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0008273&Dim1=S7A2023&Dim3=T&Dim4=T&lang=PT"
    try:
        d = json.loads(fetch(url2, timeout=150, retries=1) or "null")
        for r in (d or [{}])[0].get("Dados", {}).get("2023") or []:
            if len(r.get("geocod", "")) == 7 and r.get("valor"):
                con.execute("UPDATE municipios SET population_est_2023=? WHERE dico=?", (int(float(r["valor"])), r["geocod"][-4:]))
    except Exception as e:
        print("  ! INE estimate 2023 unavailable:", type(e).__name__)


# ---------------------------------------------------------------- link to politica.db entities
def link_entities(con):
    if not POLITICA.exists(): print("  ! politica.db missing"); return
    p = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True, timeout=30)
    ents = p.execute("SELECT nif, name, district, wikidata, buyer_contracts, population FROM entities WHERE kind='municipio'").fetchall()
    by_nif = {e[0]: e for e in ents if e[0]}
    by_wd = {e[3]: e for e in ents if e[3]}
    by_name = {}
    for e in ents: by_name.setdefault(muni_key(e[1]), []).append(e)
    stats = {}
    for dico, name, district, nif, wd in con.execute("SELECT dico, name, district, nif, wikidata FROM municipios").fetchall():
        e, how = None, None
        if nif and nif in by_nif: e, how = by_nif[nif], "nif"
        elif wd and wd in by_wd: e, how = by_wd[wd], "wikidata"
        else:
            cands = by_name.get(muni_key(name), [])
            if district in ("Açores", "Madeira") or len(cands) > 1:
                qual = [c for c in cands if re.search(r"a[cç]ores|s[aã]o jorge|s[aã]o miguel", c[1], re.I)] if district == "Açores" else \
                       [c for c in cands if not re.search(r"a[cç]ores|s[aã]o jorge|s[aã]o miguel", c[1], re.I)]
                cands = qual or cands
            if cands: e, how = max(cands, key=lambda c: c[4] or 0), "name"
        stats[how or "none"] = stats.get(how or "none", 0) + 1
        if e:
            con.execute("UPDATE municipios SET entity_nif=?, match_method=?, population=COALESCE(population, ?),"
                        " population_source=COALESCE(population_source, CASE WHEN ? IS NOT NULL THEN 'politica.db entities' END) WHERE dico=?",
                        (e[0], how, e[5], e[5], dico))
        else:
            con.execute("UPDATE municipios SET match_method='none' WHERE dico=?", (dico,))
    print("  municipio -> entities:", stats)
    # freguesias: (name, municipality) then unique name
    fe = p.execute("SELECT nif, name, municipality FROM entities WHERE kind='freguesia'").fetchall()
    def fk(n):
        n = norm(n); n = re.sub(r"^(junta de freguesia|freguesia)( (de|da|do|das|dos))? ", "", n)
        return re.sub(r"^uniao das freguesias (de|da|do|das|dos) ", "uf ", n)
    by_pair, by_fn = {}, {}
    for nif, name, mun in fe:
        by_pair.setdefault((fk(name), muni_key(mun or "")), []).append(nif or "")
        by_fn.setdefault(fk(name), []).append(nif or "")
    mname = dict(con.execute("SELECT dico, name FROM municipios").fetchall())
    fst = {}
    for fid, dico, name in con.execute("SELECT mai25_id, dico, name FROM freguesias").fetchall():
        k = fk(name); k2 = re.sub(r"^uniao das freguesias (de|da|do|das|dos) ", "uf ", k)
        con.execute("UPDATE freguesias SET name_key=? WHERE mai25_id=?", (k + "|" + muni_key(mname.get(dico, "")), fid))
        hit, how = by_pair.get((k, muni_key(mname.get(dico, "")))) or by_pair.get((k2, muni_key(mname.get(dico, "")))), "name+municipio"
        if not hit or len(hit) != 1:
            u = by_fn.get(k) or by_fn.get(k2)
            hit, how = (u, "unique_name") if u and len(u) == 1 else (None, None)
        if hit:
            con.execute("UPDATE freguesias SET entity_nif=?, match_method=? WHERE mai25_id=?", (hit[0] or None, how if hit[0] else how + " (entity without NIF)", fid))
        fst[(how if not hit or hit[0] else how + "_no_nif") if hit else "none"] = fst.get((how if not hit or hit[0] else how + "_no_nif") if hit else "none", 0) + 1
    print("  freguesia -> entities:", fst)
    p.close()
    return stats, fst


# ---------------------------------------------------------------- metrics, ranks, export
FAMILIES = ["PPD/PSD", "PS", "PCP-PEV", "CDS-PP", "CH", "IL", "B.E.", "L", "PAN", "JPP", "PPM", "MPT"]


def family(acr):
    """Main party of a list ('PPD/PSD.CDS-PP.IL' -> 'PPD/PSD'); citizen groups keep their own acronym."""
    toks = (acr or "").upper().split(".")
    if "B" in toks and "E" in toks: toks.append("B.E.")
    for f in FAMILIES:
        if f in toks: return f
    return acr
def build_metrics(con):
    con.execute("DELETE FROM metrics")
    fin_year = con.execute("SELECT MAX(year) FROM finance WHERE kind='despesa'").fetchone()[0]
    debt_year = con.execute("SELECT MAX(year) FROM debt").fetchone()[0]
    for dico, name, district, nif, enif, wd, pop, popy, pops in con.execute(
            "SELECT dico, name, district, nif, entity_nif, wikidata, population, population_year, population_source FROM municipios").fetchall():
        f = lambda kind, codes=None, y=None: con.execute(
            f"SELECT SUM(value) FROM finance WHERE dico=? AND year=? AND kind=? {'AND code IN (%s)' % ','.join('?' * len(codes)) if codes else ''}",
            (dico, y or fin_year, kind, *(codes or []))).fetchone()[0]
        fy = fin_year if f("despesa") else con.execute("SELECT MAX(year) FROM finance WHERE dico=? AND kind='despesa'", (dico,)).fetchone()[0]
        exp = f("despesa", y=fy) if fy else None
        rev = f("receita", [c for c in REV_CH if c != "16"], y=fy) if fy else None
        g = lambda kind, codes: f(kind, codes, fy) if fy else None
        pers, bs, inv, tr = g("despesa", ["01"]), g("despesa", ["02"]), g("despesa", ["07"]), g("despesa", ["04", "08"])
        intr, tax, trin = g("despesa", ["03"]), g("receita", ["01", "02"]), g("receita", ["06", "10"])
        own = g("receita", ["01", "02", "04", "05", "07", "08", "09"])
        d = con.execute("SELECT year, debt_total, debt_limit FROM debt WHERE dico=? ORDER BY year DESC LIMIT 1", (dico,)).fetchone()
        mayor = con.execute("SELECT name, party, party_type, list_name FROM mandates WHERE dico=? AND year=2025 AND role='presidente'", (dico,)).fetchone()
        win = lambda y: con.execute("SELECT party, pct, mandates FROM election_results WHERE level='municipio' AND code=? AND year=? AND organ='CM' ORDER BY president DESC, votes DESC LIMIT 1", (dico, y)).fetchone()
        w25, w21, w17 = win(2025), win(2021), win(2017)
        s25 = con.execute("SELECT turnout, total_mandates FROM election_summary WHERE level='municipio' AND code=? AND year=2025 AND organ='CM'", (dico,)).fetchone()
        pm = con.execute("SELECT date, days FROM pmp WHERE dico=? AND partial=0 ORDER BY date DESC LIMIT 1", (dico,)).fetchone()
        by = con.execute("""SELECT year, SUM(CASE WHEN stage='orcamento' THEN value END), SUM(CASE WHEN stage='executado' THEN value END)
                            FROM budget WHERE dico=? AND kind='despesa' GROUP BY year ORDER BY year DESC LIMIT 1""", (dico,)).fetchone()
        nuts = con.execute("SELECT nuts3 FROM municipios WHERE dico=?", (dico,)).fetchone()[0]
        pc = lambda v: round(v / pop, 2) if v is not None and pop else None
        share = lambda v: round(100 * v / exp, 2) if v is not None and exp else None
        con.execute("INSERT INTO metrics VALUES (" + ",".join("?" * 51) + ")", (
            dico, name, district, nif, enif, wd, pop, popy, pops,
            mayor[0] if mayor else None, (mayor[1] if mayor else (w25[0] if w25 else None)), family(mayor[1] if mayor else (w25[0] if w25 else None)), mayor[2] if mayor else None, mayor[3] if mayor else None,
            w21[0] if w21 else None, w17[0] if w17 else None,
            (1 if family(w25[0]) != family(w21[0]) else 0) if w25 and w21 else None,
            w25[1] if w25 else None, (1 if w25 and s25 and s25[1] and w25[2] * 2 > s25[1] else 0) if w25 and s25 else None,
            s25[1] if s25 else None, s25[0] if s25 else None,
            fy, exp, rev, pers, bs, inv, tr, intr, tax, trin, (rev - exp) if rev is not None and exp is not None else None,
            pc(exp), share(pers), share(inv), round(100 * own / rev, 2) if own is not None and rev else None,
            d[0] if d else None, d[1] if d else None, d[2] if d else None,
            round(100 * d[1] / d[2], 2) if d and d[2] else None, pc(d[1]) if d else None,
            None, None, None, None, None,
            pm[0] if pm else None, pm[1] if pm else None, by[0] if by else None,
            round(100 * by[2] / by[1], 1) if by and by[1] else None, nuts))
    for col, rcol in (("expense_pc", "rank_expense_pc"), ("debt_pc", "rank_debt_pc"), ("personnel_pct", "rank_personnel_pct"), ("invest_pct", "rank_invest_pct")):
        rows = con.execute(f"SELECT dico FROM metrics WHERE {col} IS NOT NULL ORDER BY {col} DESC").fetchall()
        for i, (dico,) in enumerate(rows, 1):
            con.execute(f"UPDATE metrics SET {rcol}=? WHERE dico=?", (i, dico))
    con.execute("UPDATE metrics SET n_ranked=(SELECT COUNT(*) FROM metrics WHERE expense_pc IS NOT NULL)")


def export_csv(con):
    EXPORT.parent.mkdir(parents=True, exist_ok=True)
    cur = con.execute("SELECT * FROM metrics ORDER BY dico")
    cols = [c[0] for c in cur.description]
    with open(EXPORT, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh); w.writerow(cols); w.writerows(cur.fetchall())
    print("  export:", EXPORT)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    tmp = DB.with_suffix(".db.tmp")
    if tmp.exists(): tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    munis = elections_2021(con)
    elections_2025(con, munis)
    con.commit()

    names = {}
    for dico, name, district in con.execute("SELECT dico, name, district FROM municipios"):
        names.setdefault(muni_key(name), []).append((dico, norm(district)))
    nif_map = {}

    def name_to_dico(name, nif=None, district=None):
        if nif and nif in nif_map: return nif_map[nif]
        n = muni_key(name)
        m = re.match(r"^(.*) (madeira|sao jorge|algarve|sao miguel|acores)$", n) if "(" in (name or "") else None
        if n in ("praia da vitoria", "vila praia da vitoria"): n = "vila da praia da vitoria"
        qual = None
        if m: n, qual = muni_key(m.group(1)), m.group(2)
        c = names.get(n, [])
        if len(c) > 1:
            isl = qual in ("sao jorge", "sao miguel", "acores") or (district and "acores" in norm(district))
            mad = qual == "madeira" or (district and "madeira" in norm(district))
            c2 = [x for x in c if (isl and x[1] == "acores") or (mad and x[1] == "madeira") or (not isl and not mad and x[1] not in ("acores", "madeira"))]
            # unqualified homonym in DGAL 2015-2019 files: the Açores one carries "(AÇORES)", so the plain name is the other one
            c = c2 if c2 or qual or district else [x for x in c if x[1] != "acores"]
        if len(c) == 1:
            if nif: nif_map[nif] = c[0][0]
            return c[0][0]
        return None

    for step in (lambda: dgal_finance(con, name_to_dico), lambda: dgal_budget(con, name_to_dico), lambda: dgal_debt(con, name_to_dico),
                 lambda: dgal_pmp(con, name_to_dico), lambda: wikidata(con), lambda: ine_population(con), lambda: cim(con)):
        try:
            step(); con.commit()
        except Exception as e:
            print("  ! step failed:", type(e).__name__, e)
    link = link_entities(con)
    build_metrics(con)
    try:
        cim_aggregate(con); link_cim(con)
    except Exception as e:
        print("  ! CIM aggregate failed:", e)
    for k, v in {"updated": time.strftime("%Y-%m-%dT%H:%M:%S"), "entity_match": json.dumps(link[0] if link else {}),
                 "freguesia_match": json.dumps(link[1] if link else {})}.items():
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))
    con.commit()
    export_csv(con)
    con.close()
    tmp.replace(DB)
    c = sqlite3.connect(DB)
    c.execute("PRAGMA journal_mode=WAL")
    for t in ("municipios", "freguesias", "election_results", "mandates", "finance", "debt", "budget", "pmp", "cim", "metrics"):
        print(f"  {t}: {c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    c.close()


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
