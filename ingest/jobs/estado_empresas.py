"""O Estado em números: emprego público (DGAEP/SIOE) e Sector Empresarial do Estado (ETF/ex-DGTF).

Escreve só em data/estado_empresas.db.  Lê (só leitura) data/politica.db: entities.

Fontes (todas públicas):
  * DGAEP (dados.gov.pt, .xlsx, lidos em streaming com a stdlib): evolução do emprego, remunerações base e ganho médio
    (global e por carreira), modalidades de vínculo, subsetor/área governativa, atividade económica, carreiras x idade x sexo,
    habilitações, trabalhadores com deficiência, entradas e saídas, n.º de entidades; BOEP cap. 2 (emprego em empresas públicas).
  * ETF - Entidade do Tesouro e Finanças (ex-DGTF): "Carteira de Participações do Estado" (dados.gov.pt, .xlsx trimestral:
    empresas, % do Estado, valor nominal, capital), lista de empresas do SISEE e quadros agregados trimestrais
    "Situação económico-financeira" (PDF, pdftotext), garantias concedidas (csv).
Bloqueado / não incluído: ver meta('blocked').  Só agregados: nenhum trabalhador individual é guardado.
"""
import csv
import difflib
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import unicodedata
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import migrations  # noqa: E402
from common import DATA_DIR, ROOT  # noqa: E402

NAME = "estado_empresas"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
POLITICA = DATA_DIR / "politica.db"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
API = "https://dados.gov.pt/api/1/datasets/"
DSET_URL = "https://dados.gov.pt/pt/datasets/"
ETF = "https://www.etf.gov.pt"
SLEEP = 1.0

DGAEP = {  # chave -> (dataset id em dados.gov.pt, filtro do título do recurso)
    "evol_trab": ("675341d341f43cc6f4608b27", ""),
    "remun_evol": ("69c15eb60e12c5c13d3496e4", ""),
    "remun_carr": ("69c1602a2c9906ce4942cfb8", ""),
    "vinculo": ("695e6ca2dd4e669e0b5584f5", ""),
    "subsetor": ("68d687f4e291bff96dea7ce4", ""),
    "atividade": ("68cb11f77bc949ad79e74d41", ""),
    "carreiras": ("69320c5041ebe5b26e7631f5", ""),
    "hab": ("69320e0741ebe5b26e7631f6", ""),
    "deficiencia": ("693194362332f7fc6d7631f5", ""),
    "entradas": ("695e79e211912cf672d073c6", ""),
    "entidades": ("68d688e1318a838982ea7ce4", ""),
    "boep_cap2": ("65254da07b2bcf2b01c5efc1", "cap2"),
}
CARTEIRA_DS = "687a7128a3adf5748e24d91c"
APOIOS_DS = "697c98bfe0f3804148ac46e8"


def log(*a):
    print(f"[{NAME}]", *a, flush=True)


# ------------------------------------------------------------------ download com cache
_last = [0.0]


def http(url, binary=True, timeout=120):
    wait = SLEEP - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    finally:
        _last[0] = time.time()
    return data if binary else data.decode("utf-8", "replace")


def cached(url, fname):
    """Descarrega para data/raw/estado_empresas/<fname>; o nome inclui o carimbo do URL (muda quando a fonte atualiza)."""
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / fname
    if p.exists() and p.stat().st_size > 0:
        return p
    data = http(url)
    if data[:1] in (b"{", b"<") and not fname.endswith((".html", ".json")):
        raise RuntimeError(f"resposta inesperada para {url}: {data[:80]!r}")
    p.write_bytes(data)
    return p


def resources(ds_id):
    p = RAW / f"api_{ds_id}.json"
    RAW.mkdir(parents=True, exist_ok=True)
    try:
        d = json.loads(http(API + ds_id + "/", binary=False))
        p.write_text(json.dumps(d))
    except Exception as e:
        if not p.exists():
            raise
        log("  ! API dados.gov.pt indisponível, a usar cópia local:", e)
        d = json.loads(p.read_text())
    return d, d.get("resources", [])


def stamp(url):
    m = re.search(r"/(\d{8}-\d{6}[^/]*)/", url)
    return m.group(1) if m else re.sub(r"\W+", "_", url)[-24:]


def fetch_resource(key, ds_id, flt="", fmt="xlsx"):
    d, rs = resources(ds_id)
    rs = [r for r in rs if (r.get("format") or "").lower() == fmt and flt.lower() in (r.get("title", "") + r.get("url", "")).lower()]
    if not rs:
        raise RuntimeError(f"sem recurso {fmt} em {ds_id} ({flt})")
    r = rs[0]
    path = cached(r["url"], f"{key}_{stamp(r['url'])}.{fmt}")
    return path, r["url"], d


# ------------------------------------------------------------------ xlsx em streaming (stdlib)
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _col(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + ord(ch) - 64
        else:
            break
    return n - 1


def xlsx_sheets(path):
    """Gera (nome, iterador de linhas) para cada folha."""
    z = zipfile.ZipFile(path)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, el in ET.iterparse(z.open("xl/sharedStrings.xml")):
            if el.tag == NS + "si":
                ss.append("".join(x.text or "" for x in el.iter(NS + "t")))
                el.clear()
    for s in wb.iter(NS + "sheet"):
        t = rels[s.get(RNS + "id")].lstrip("/")
        if not t.startswith("xl/"):
            t = "xl/" + t
        yield s.get("name"), _rows(z, t, ss)


def _rows(z, t, ss):
    for _, el in ET.iterparse(z.open(t)):
        if el.tag == NS + "row":
            r = []
            for c in el.iter(NS + "c"):
                i = _col(c.get("r"))
                while len(r) <= i:
                    r.append(None)
                v = c.find(NS + "v")
                ty = c.get("t")
                if ty == "inlineStr":
                    r[i] = "".join(x.text or "" for x in c.iter(NS + "t"))
                elif v is None:
                    continue
                elif ty == "s":
                    r[i] = ss[int(v.text)]
                else:
                    r[i] = v.text
            yield r
            el.clear()


def first_sheet(path):
    return next(iter(xlsx_sheets(path)))[1]


def norm_key(h):
    h = unicodedata.normalize("NFKD", str(h or "")).encode("ascii", "ignore").decode().lower().replace("\xa0", " ")
    return re.sub(r"\s+", " ", h).strip()


def records(path):
    it = first_sheet(path)
    head = [norm_key(h) for h in next(it)]
    for r in it:
        if not any(x not in (None, "") for x in r):
            continue
        yield {head[i]: (r[i] if i < len(r) else None) for i in range(len(head)) if head[i]}


def num(x):
    if x in (None, "", "None", "-"):
        return None
    try:
        return float(str(x).replace(" ", ""))
    except ValueError:
        return None


def txt(x):
    if x is None:
        return None
    x = str(x).replace("\xa0", " ").strip()
    return None if x in ("", "None", "-") else re.sub(r"\s+", " ", x)


def iso(x):
    """Data Excel (n.º de série) ou ISO -> 'YYYY-MM-DD'."""
    x = txt(x)
    if not x:
        return None
    if re.fullmatch(r"\d{4,6}(\.0+)?", x):
        return (date(1899, 12, 30) + timedelta(days=int(float(x)))).isoformat()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", x)
    return m.group(0) if m else None


def getk(r, *cands):
    for c in cands:
        for k in r:
            if k.startswith(c):
                return r[k]
    return None


# ------------------------------------------------------------------ esquema
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE wf_total (ref_date TEXT, year INTEGER, employed_total INTEGER, public_workers INTEGER, note TEXT, unit TEXT, source_url TEXT);
CREATE TABLE wf_pay (ref_date TEXT, year INTEGER, base_monthly REAL, gain_monthly REAL, unit TEXT, source_url TEXT);
CREATE TABLE wf_pay_career (ref_date TEXT, year INTEGER, area TEXT, career_code TEXT, career TEXT, detail_code TEXT, detail TEXT,
  base_monthly REAL, gain_monthly REAL, unit TEXT, source_url TEXT);
CREATE TABLE wf_contract (ref_date TEXT, year INTEGER, code TEXT, label TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_subsector (ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, area TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_activity (ref_date TEXT, year INTEGER, cae TEXT, label TEXT, grp TEXT, subgroup TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_career (ref_date TEXT, year INTEGER, area TEXT, career_code TEXT, career TEXT, detail_code TEXT, detail TEXT,
  age_code TEXT, age TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_education (ref_date TEXT, year INTEGER, grp TEXT, level_code TEXT, level TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_disability (ref_date TEXT, year INTEGER, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_flows (ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, area TEXT, flow TEXT, motive TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE wf_entities (ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, n_entities INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE sector_emp (ref_date TEXT, year INTEGER, holder TEXT, sub TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT);
CREATE TABLE see_docs (kind TEXT, year INTEGER, quarter INTEGER, title TEXT, url TEXT, per_company INTEGER DEFAULT 0);
CREATE TABLE see_agg (year INTEGER, quarter INTEGER, grp TEXT, indicator TEXT, value REAL, restated REAL, unit TEXT, n_companies INTEGER, source_url TEXT);
CREATE TABLE misc_series (indicator TEXT, year INTEGER, value REAL, unit TEXT, source_url TEXT);
CREATE TABLE companies (
  id INTEGER PRIMARY KEY, key TEXT, name TEXT, nif TEXT, entity_id INTEGER, entity_name TEXT, match_method TEXT, match_score REAL,
  grp TEXT, section TEXT, epr INTEGER, portfolio TEXT, pct REAL, nominal REAL, capital REAL, ref_date TEXT, year INTEGER,
  in_siee INTEGER DEFAULT 0, status TEXT, unit TEXT, source_url TEXT);
CREATE TABLE company_hist (company_id INTEGER, ref_date TEXT, year INTEGER, pct REAL, nominal REAL, capital REAL, unit TEXT, source_url TEXT);
CREATE INDEX companies_nif ON companies(nif);
CREATE INDEX companies_key ON companies(key);
CREATE INDEX hist_c ON company_hist(company_id);
CREATE INDEX wf_career_d ON wf_career(ref_date);
CREATE INDEX wf_flows_d ON wf_flows(ref_date);
CREATE INDEX wf_paycareer_d ON wf_pay_career(ref_date);
"""


def yr(d):
    return int(d[:4]) if d else None


# ------------------------------------------------------------------ DGAEP
def load_dgaep(con, meta):
    src = {}
    for key, (ds, flt) in DGAEP.items():
        if key == "boep_cap2":
            continue
        try:
            path, url, dsd = fetch_resource(key, ds, flt)
            src[key] = {"dataset": DSET_URL + ds, "title": dsd.get("title"), "url": url, "license": dsd.get("license")}
        except Exception as e:
            meta["errors"][key] = str(e)
            log("  ! ", key, e)
            continue
        n = 0
        ins = lambda t, *v: con.execute(f"INSERT INTO {t} VALUES ({','.join('?' * len(v))})", v)
        for r in records(path):
            d = iso(getk(r, "data de referencia"))
            if not d:
                continue
            y = yr(d)
            if key == "evol_trab":
                ins("wf_total", d, y, num(getk(r, "populacao empregada")), num(getk(r, "trabalhadores na ap")), txt(getk(r, "observ")), "pessoas", url)
            elif key == "remun_evol":
                ins("wf_pay", d, y, num(getk(r, "remuneracao base")), num(getk(r, "ganho medio")), "EUR/mês", url)
            elif key == "remun_carr":
                ins("wf_pay_career", d, y, txt(getk(r, "distribuicao")), txt(r.get("codigo carreira")), txt(r.get("carreira")), txt(r.get("codigo detalhe carreira")),
                    txt(r.get("detalhe carreira")), num(getk(r, "remuneracao base")), num(getk(r, "ganho medio")), "EUR/mês", url)
            elif key == "vinculo":
                ins("wf_contract", d, y, txt(r.get("codigo modalidade de vinculo")), txt(r.get("modalidade de vinculo")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "subsetor":
                ins("wf_subsector", d, y, txt(r.get("codigo do subsetor")), txt(r.get("subsetor")), txt(r.get("area governativa")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "atividade":
                ins("wf_activity", d, y, txt(getk(r, "cae rev.4 (sec")), txt(getk(r, "cae rev.4 (desig")), txt(r.get("nome do grupo")), txt(r.get("nome do sub-grupo")),
                    num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "carreiras":
                ins("wf_career", d, y, txt(getk(r, "distribuicao")), txt(r.get("codigo carreira")), txt(r.get("carreira")), txt(r.get("codigo detalhe carreira")),
                    txt(r.get("detalhe carreira")), txt(r.get("codigo escaloes etarios")), txt(r.get("escaloes etarios")), txt(r.get("sexo")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "hab":
                ins("wf_education", d, y, txt(r.get("grupo de ensino completo")), txt(r.get("codigo habilitacoes literarias")), txt(r.get("habilitacoes literarias")),
                    txt(r.get("sexo")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "deficiencia":
                ins("wf_disability", d, y, txt(r.get("sexo")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "entradas":
                ins("wf_flows", d, y, txt(r.get("codigo subsetor")), txt(r.get("subsetor")), txt(r.get("area governativa")), txt(r.get("entradas/saidas")),
                    txt(r.get("grande motivo")), num(getk(r, "numero de trab")), "pessoas", url)
            elif key == "entidades":
                ins("wf_entities", d, y, txt(r.get("codigo do subsetor")), txt(r.get("subsetor")), num(getk(r, "numero de entidades")), "entidades", url)
            n += 1
        log("  DGAEP", key, n, "linhas")
    meta["sources"].update({"dgaep_" + k: v for k, v in src.items()})


def load_boep(con, meta):
    ds, flt = DGAEP["boep_cap2"]
    try:
        path, url, dsd = fetch_resource("boep_cap2", ds, flt)
    except Exception as e:
        meta["errors"]["boep_cap2"] = str(e)
        log("  ! boep", e)
        return
    meta["sources"]["dgaep_boep_cap2"] = {"dataset": DSET_URL + ds, "title": dsd.get("title"), "url": url, "license": dsd.get("license")}
    MON = {"dez": "12-31", "jun": "06-30", "mar": "03-31", "set": "09-30"}
    for name, it in xlsx_sheets(path):
        if name != "Q.2.1.1":
            continue
        dates, sexes, holder, n = {}, {}, None, 0
        for r in it:
            r = r + [None] * 200
            if not dates:
                got = [(i, re.match(r"(\d{1,2}) (\w{3}) (\d{4})", str(v))) for i, v in enumerate(r) if v]
                got = [(i, m) for i, m in got if m]
                if got:
                    for i, m in got:
                        if m.group(2) in MON:
                            dates[i] = f"{m.group(3)}-{MON[m.group(2)]}"
                continue
            sx = [str(v) for v in r[4:]]
            if all(v in ("H", "M", "T") for v in sx[:3]) and not sexes:
                sexes = {4 + i: v for i, v in enumerate(sx) if v in ("H", "M", "T")}
                continue
            if not sexes:
                continue
            c2, c3 = txt(r[2]), txt(r[3])
            if c2 and not c3:
                holder = c2
                sub = "Total"
            elif c3:
                sub = c3
                if c2 == "das quais:":
                    pass
            else:
                continue
            for i, sx_ in sexes.items():
                base = i - (i - 4) % 3
                d = dates.get(base)
                v = num(r[i])
                if d and v is not None:
                    con.execute("INSERT INTO sector_emp VALUES (?,?,?,?,?,?,?,?)", (d, yr(d), holder, sub, {"H": "Homens", "M": "Mulheres", "T": "Total"}[sx_], int(v), "postos de trabalho", url))
                    n += 1
            if holder and not c3 and c2 and c2.startswith("Total"):
                holder = None
        log("  BOEP Q.2.1.1", n, "linhas")


# ------------------------------------------------------------------ nomes e ligação ao registo
STOP = {"de", "da", "do", "dos", "das", "e", "em", "liquidacao", "sa", "epe", "sgps", "sarl", "lda", "ace", "sgoic", "unipessoal", "sicar", "sociedade", "empresa", "the"}


def cname(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(em liquida[a-z]*\)", " ", s).replace("&", " e ").replace("*", " ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    toks = [t for t in s.split() if len(t) > 1 and t not in STOP]
    return " ".join(toks)


KIND_PRI = {"empresa_publica": 0, "sociedade_adjudicante": 1, "empresa_municipal": 2, "saude": 3, "instituto_publico": 4, "regional": 5, "universidade": 6, "outra_entidade": 7}


def build_match(names):
    """names: {key: nome} -> {key: (entity row, method, score)}  (por NIF no registo, via nome normalizado)."""
    if not POLITICA.exists():
        return {}
    pc = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True, timeout=30)
    ents = pc.execute("SELECT id, nif, name, kind, buyer_contracts, seller_contracts FROM entities WHERE nif IS NOT NULL").fetchall()
    pc.close()
    bykey, tokidx = {}, {}
    for e in ents:
        k = cname(e[2])
        if len(k) < 4:
            continue
        bykey.setdefault(k, []).append(e)
        for t in set(k.split()):
            tokidx.setdefault(t, set()).add(k)

    def best(cands):
        return sorted(cands, key=lambda e: (KIND_PRI.get(e[3], 9), -((e[4] or 0) + (e[5] or 0))))[0]

    out = {}
    df = {t: len(v) for t, v in tokidx.items()}
    for key, nm in names.items():
        if key in bykey:
            c = bykey[key]
            out[key] = (best(c), "nome exato" if len(c) == 1 else "nome exato (várias)", 1.0)
            continue
        toks = key.split()
        if len(toks) < 2:
            continue
        rare = sorted(toks, key=lambda t: df.get(t, 10 ** 9))[:2]
        pool = set()
        for t in rare:
            pool |= tokidx.get(t, set())
        scored = []
        for k in pool:
            kt = k.split()
            a, b = set(toks), set(kt)
            sc = difflib.SequenceMatcher(None, key, k).ratio()
            # um nome é o outro com acrescentos (ex.: "...Francisco Gentil"): só se partilham >=3 palavras e o curto está contido
            mn = min(len(a), len(b))
            if (a <= b or b <= a) and (mn >= 3 or (mn >= 2 and abs(len(a) - len(b)) <= 1)):
                sc = max(sc, 0.9)
            if mn < 3 and sc < 0.93 and best(bykey[k])[3] == "empresa_ou_particular":
                continue
            if sc >= 0.93 or (sc >= 0.9 and (a <= b or b <= a)):
                scored.append((sc, k))
        if scored:
            scored.sort(reverse=True)
            top = scored[0]
            if len(scored) > 1 and scored[1][0] >= top[0] - 0.02 and len({e[1] for e in bykey[scored[1][1]]}) and bykey[scored[1][1]][0][1] != bykey[top[1]][0][1]:
                continue  # ambíguo
            out[key] = (best(bykey[top[1]]), "nome aproximado", round(top[0], 3))
    return out


# ------------------------------------------------------------------ Carteira de participações (ETF)
def parse_carteira(path, url, ref_hint=None):
    """Devolve (ref_date, [empresa dict])."""
    rows_out, ref = [], None
    for sheet, it in xlsx_sheets(path):
        sh = norm_key(sheet)
        if "global" in sh:
            kind = "global"
        elif "acess" in sh:
            kind = "acessoria"
        elif "liquid" in sh:
            kind = "liquidacao"
        else:
            continue
        top = sec = None
        for r in it:
            r = list(r) + [None] * 10
            a = txt(r[1])
            if not a:
                continue
            m = re.search(r"em (\d{2})-(\d{2})-(\d{4})", a)
            if m and not ref:
                ref = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
            mh = re.match(r"^(\d+(?:\.\d+)*)\.\s+(.*)$", a)
            if mh and kind == "global":
                if "." not in mh.group(1):
                    top, sec = mh.group(2), None
                    if norm_key(mh.group(2)).startswith("total"):
                        top = None
                else:
                    sec = mh.group(2)
                continue
            if re.match(r"^(total|obs|nota|empresa$|\*)", norm_key(a)) or a.lower().startswith("participa") or a.startswith("Carteira"):
                continue
            nums = [num(x) for x in r[3:10] if num(x) is not None]
            raw_pct = txt(r[7]) if kind != "liquidacao" else txt(r[4])
            if kind == "global" and len(r) and raw_pct is None:
                raw_pct = txt(r[5]) if len(nums) <= 3 else raw_pct
            if not nums:
                continue
            if kind == "liquidacao":
                capital, nominal, pct = None, num(r[3]), num(r[4])
            else:
                capital = num(r[3])
                pct = nums[-1] if len(nums) >= 2 else None
                nominal = nums[-2] if len(nums) >= 3 else (nums[1] if len(nums) == 2 else None)
                if len(nums) == 1:
                    pct = None
            if pct is not None and not (0 <= pct <= 100.0001):
                pct = None
            rows_out.append({"name": re.sub(r"\s+", " ", a.replace("**", "").strip().rstrip("*").strip()), "epr": 1 if txt(r[2]) == "EPR" else 0, "kind": kind,
                             "grp": top, "section": sec, "capital": capital, "nominal": nominal, "pct": pct, "liq_flag": "**" in a})
    return ref, rows_out


def load_carteira(con, meta):
    try:
        d, rs = resources(CARTEIRA_DS)
    except Exception as e:
        meta["errors"]["carteira"] = str(e)
        return
    meta["sources"]["carteira"] = {"dataset": DSET_URL + CARTEIRA_DS, "title": d.get("title"), "license": d.get("license")}
    sel = []
    for r in rs:
        t = r.get("title", "")
        if (r.get("format") or "").lower() == "xlsx" and (t.startswith("Carteira de Participações") or t.startswith("Carteira Global")):
            sel.append(r)
    snaps = []
    for r in sel:
        try:
            p = cached(r["url"], f"carteira_{stamp(r['url'])}.xlsx")
            ref, rows = parse_carteira(p, r["url"])
        except Exception as e:
            log("  ! carteira", r.get("title"), e)
            meta["errors"]["carteira " + r.get("title", "")] = str(e)
            continue
        if ref and rows:
            snaps.append((ref, rows, r["url"]))
            log("  carteira", ref, len(rows), "linhas")
    snaps.sort()
    return snaps


# ------------------------------------------------------------------ PDFs agregados SEE (ETF)
IND = [("volume de negocios", "volume_negocios"), ("outras receitas", "outros_rendimentos"), ("outros rendimentos", "outros_rendimentos"),
       ("receita total", "rendimentos_totais"), ("rendimentos totais", "rendimentos_totais"), ("gastos operacionais", "gastos_operacionais"),
       ("outros gastos", "outros_gastos"), ("gastos totais", "gastos_totais"), ("ebitda", "ebitda"), ("ebit", "ebit"),
       ("resultado financeiro", "resultado_financeiro"), ("resultado liquido", "resultado_liquido"), ("cash flow", "cash_flow"),
       ("endividamento", "endividamento"), ("rentabilidade do ativo", "roa"), ("rentabilidade do capital", "roe"), ("n.o total de empresas", "n_empresas")]


def pnum(tok):
    t = tok.replace("\xa0", "").replace(" ", "").replace("%", "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def parse_see_pdf(text):
    """Devolve {(grp, ano, trimestre, indicador): (valor, unidade, n_empresas_total)}."""
    out, grp, quarters, years, ntot = {}, None, [], None, None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        ns = norm_key(s)
        if re.match(r"^empresas (em |nao|financeiras|publicas)", ns) and not re.search(r"\d{3}", s):
            if "nao-reclassificadas" in ns or "nao reclassificadas" in ns:
                grp = "EPNR"
            elif "reclassificadas" in ns:
                grp = "EPR"
            elif "nao-financeiras" in ns or "nao financeiras" in ns:
                grp = "nao_financeiras"
            elif "financeiras" in ns:
                grp = "financeiras"
            else:
                grp = "total"
            qs = re.findall(r"\bT[1-4]\b", s)
            quarters = [int(q[1]) for q in qs]
            years, ntot = None, None
            continue
        if grp and "(total:" in ns:
            ys = re.findall(r"\b(20\d\d)\b", s)
            if len(ys) >= 2:
                years = (int(ys[0]), int(ys[1]))
            m = re.search(r"total: (\d+)", ns)
            ntot = int(m.group(1)) if m else None
            if not quarters:
                quarters = [1]
            continue
        if not (grp and years):
            continue
        parts = re.split(r"\s{2,}", s)
        if len(parts) < 2:
            continue
        lab = norm_key(parts[0]).replace("(roa)", "").replace("(roe)", "").strip()
        ind = next((v for k, v in IND if lab.startswith(k)), None)
        if not ind:
            continue
        toks = parts[1:]
        unit = "%" if ind in ("roa", "roe") else ("n.º" if ind == "n_empresas" else "milhares de euros")
        if ind == "n_empresas":
            for qi, q in enumerate(quarters[: len(toks)]):
                v = pnum(toks[qi])
                if v is not None:
                    out[(grp, years[1], q, ind)] = (v, unit, ntot)
            continue
        if len(toks) < 3 * len(quarters) - 0:
            toks = toks + [""] * (3 * len(quarters) - len(toks))
        for qi, q in enumerate(quarters):
            a, b = pnum(toks[3 * qi]), pnum(toks[3 * qi + 1]) if 3 * qi + 1 < len(toks) else None
            for yy, v in ((years[0], a), (years[1], b)):
                if v is not None:
                    key = (grp, yy, q, ind)
                    # o ano "corrente" do ficheiro tem prioridade (aplicado pela ordem de chamada)
                    out[key] = (v, unit, ntot)
    return out


def pdf_text(path):
    if not shutil.which("pdftotext"):
        raise RuntimeError("pdftotext não instalado")
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, timeout=120).stdout


def load_see_pdfs(con, meta):
    cur_, prev_, srcs = {}, {}, {}
    for y in range(2019, 2027):
        fn = f"situacao-economico-financeira-{y}-{y - 1}"
        url = f"{ETF}/media/doc/{fn}.pdf"
        try:
            p = cached(url, fn + ".pdf")
            res = parse_see_pdf(pdf_text(p))
        except Exception as e:
            log("  ! SEE pdf", y, e)
            meta["errors"]["see_pdf_" + str(y)] = str(e)
            continue
        for k, v in res.items():
            if k[1] == y:
                cur_[k] = v
                srcs[k] = url
            else:  # o mesmo período, reapresentado no ficheiro do ano seguinte (universo de empresas pode mudar)
                prev_[k] = v
                srcs.setdefault(k, url)
        log("  SEE agregados", y, len(res))
    for k in sorted(set(cur_) | set(prev_)):
        grp, yy, q, ind = k
        v, unit, nt = cur_.get(k) or prev_[k]
        rest = prev_[k][0] if k in prev_ and k in cur_ else None
        con.execute("INSERT INTO see_agg VALUES (?,?,?,?,?,?,?,?,?)", (yy, q, grp, ind, v, rest, unit, int(nt) if nt else None, srcs[k]))
    meta["sources"]["see_agregados"] = {"dataset": ETF + "/relatorios-see", "title": "ETF - Situação económico-financeira das empresas do SEE (trimestral, PDF)"}


DOC_KINDS = [
    (r"situacao-economico-financeira-(\d{4})-\d{4}-empresas", "lista", "Empresas utilizadas na análise"),
    (r"situacao-economico-financeira-(\d{4})-\d{4}$", "situacao", "Situação económico-financeira"),
    (r"boletim-informativo-SEE-T([1-4])-(\d{4})", "boletim", "Boletim informativo do SEE"),
    (r"relatorio-SEE-(\d{4})", "relatorio", "Relatório do SEE"),
    (r"relatorio-cumprimento-politicas-bom-governo-(\d{4})", "bom_governo", "Relatório de cumprimento das políticas de bom governo"),
]


def parse_see_docs(html):
    out, seen = [], set()
    for m in re.finditer(r'<a [^>]*href="(/media/doc/+[^"]+\.pdf)"', html):
        href = re.sub(r"/+", "/", m.group(1))
        if href in seen:
            continue
        seen.add(href)
        stem = href.rsplit("/", 1)[-1][:-4]
        for rx, kind, label in DOC_KINDS:
            mm = re.fullmatch(rx, stem)
            if not mm:
                continue
            g = mm.groups()
            if kind == "boletim":
                q, y = int(g[0]), int(g[1])
                title = f"{label}, {q}.º trimestre de {y}"
            else:
                q, y = None, int(g[0])
                title = f"{label}, {y}" if kind != "situacao" and kind != "lista" else f"{label}, {y} vs. {y - 1}"
            out.append((kind, y, q, title, ETF + href, 0))
            break
    return out


def load_see_docs(con, meta):
    html = http(ETF + "/relatorios-see", binary=False)
    docs = parse_see_docs(html)
    docs.sort(key=lambda r: (-r[1], r[0], -(r[2] or 0)))
    con.executemany("INSERT INTO see_docs VALUES (?,?,?,?,?,?)", docs)
    meta["sources"]["see_docs"] = {"dataset": ETF + "/relatorios-see", "title": "ETF - Relatórios e boletins do SEE (PDF, só agregados)"}
    return len(docs)


def load_siee_list():
    """Lista de empresas em SISEE (PDF '...-empresas'): só nomes."""
    for y in (2026, 2025, 2024):
        fn = f"situacao-economico-financeira-{y}-{y - 1}-empresas"
        url = f"{ETF}/media/doc/{fn}.pdf"
        try:
            p = cached(url, fn + ".pdf")
            names = []
            for ln in pdf_text(p).splitlines():
                s = ln.strip()
                if not s or "trimestres em" in s or s.startswith("Empresas em") or re.fullmatch(r"\d+/\d+", s):
                    continue
                s = re.split(r"\s{3,}", s)[0].strip()
                if len(s) > 4 and not re.fullmatch(r"[\d\s]+", s) and not re.match(r"(?i)(informa|legenda)", s):
                    names.append(s)
            if len(names) > 50:
                return names, url, y
        except Exception as e:
            log("  ! lista SISEE", y, e)
    return [], None, None


def load_misc(con, meta):
    d, rs = resources(APOIOS_DS)
    for r in rs:
        if (r.get("format") or "").lower() == "csv" and "garantias" in r.get("url", ""):
            try:
                data = http(r["url"])
                txt_ = data.decode("latin-1")
                rows = list(csv.reader(io.StringIO(txt_), delimiter=";"))
                years = [int(x) for x in rows[0][1:] if x.strip().isdigit()]
                for row in rows[1:]:
                    lab = row[0].strip()
                    for yy, v in zip(years, row[1:]):
                        f = pnum(v.replace(".", "")) if v.strip() else None
                        if f is not None:
                            con.execute("INSERT INTO misc_series VALUES (?,?,?,?,?)", ("Garantias do Estado - " + lab, yy, f, "milhões de euros", r["url"]))
                meta["sources"]["garantias"] = {"dataset": DSET_URL + APOIOS_DS, "title": d.get("title"), "license": d.get("license"), "url": r["url"]}
            except Exception as e:
                meta["errors"]["garantias"] = str(e)


# ------------------------------------------------------------------ montagem das empresas
def build_companies(con, snaps, siee_names, siee_url, siee_year, meta):
    latest_ref = snaps[-1][0] if snaps else None
    comps = {}  # key -> dict
    keymap = {}  # nome-chave alternativo -> key

    def canon(k):
        if k in comps:
            return k
        if k in keymap:
            return keymap[k]
        for c in comps:  # nomes quase iguais entre trimestres (gralhas da fonte)
            if difflib.SequenceMatcher(None, k, c).ratio() >= 0.93:
                keymap[k] = c
                return c
        return k

    for ref, rows, url in snaps:
        for r in rows:
            k = cname(r["name"])
            if not k:
                continue
            k = canon(k)
            c = comps.setdefault(k, {"hist": {}, "name": r["name"], "portfolio": None})
            c["hist"][ref] = (r["pct"], r["nominal"], r["capital"], url)
            if ref >= (c.get("ref") or ""):
                c.update(ref=ref, name=r["name"], epr=r["epr"], grp=r["grp"], section=r["section"], pct=r["pct"], nominal=r["nominal"], capital=r["capital"], url=url)
                c["portfolio"] = "acessoria" if r["kind"] == "acessoria" else "liquidacao" if r["kind"] == "liquidacao" else (c["portfolio"] if c["portfolio"] == "acessoria" and ref != latest_ref else "principal")
                if r["kind"] == "acessoria":
                    c["grp"], c["section"] = "Carteira acessória", None
                if r["kind"] == "liquidacao":
                    c["grp"], c["section"] = "Em liquidação", None
    # carteira acessória só existe nas folhas de 2026: marca por nome nas empresas que só aparecem na global dos trimestres antigos
    # lista SISEE
    for nm in siee_names:
        k = cname(nm)
        hit = k if k in comps else None
        if not hit:
            kt = set(k.split())
            for c in comps:
                ct = set(c.split())
                if min(len(kt), len(ct)) >= 3 and (kt <= ct or ct <= kt):
                    hit = c
                    break
                if difflib.SequenceMatcher(None, k, c).ratio() >= 0.9:
                    hit = c
                    break
        if hit:
            comps[hit]["siee"] = 1
        else:
            comps.setdefault(k, {"hist": {}, "name": nm, "portfolio": "siee", "grp": "Sem participação direta na carteira (subsidiárias/outras entidades do SEE)", "section": None, "epr": None,
                                 "pct": None, "nominal": None, "capital": None, "ref": None, "url": siee_url, "siee": 1})
    mt = build_match({k: c["name"] for k, c in comps.items()})
    stats = {"total": len(comps), "matched": 0, "by_method": {}}
    cur = con.cursor()
    for k, c in sorted(comps.items(), key=lambda kv: kv[1]["name"].lower()):
        m = mt.get(k)
        nif = ent_id = ent_name = method = score = None
        if m:
            e, method, score = m
            ent_id, nif, ent_name = e[0], e[1], e[2]
            stats["matched"] += 1
            stats["by_method"][method] = stats["by_method"].get(method, 0) + 1
        status = "em liquidação" if c["portfolio"] == "liquidacao" else "ativa"
        cur.execute("INSERT INTO companies (key,name,nif,entity_id,entity_name,match_method,match_score,grp,section,epr,portfolio,pct,nominal,capital,ref_date,year,in_siee,status,unit,source_url)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (k, c["name"], nif, ent_id, ent_name, method, score, c.get("grp"), c.get("section"), c.get("epr"), c["portfolio"], c.get("pct"), c.get("nominal"), c.get("capital"),
                     c.get("ref"), yr(c.get("ref")), c.get("siee", 0), status, "EUR (valor nominal); % do capital", c.get("url")))
        cid = cur.lastrowid
        for ref, (pct, nom, cap, url) in sorted(c["hist"].items()):
            cur.execute("INSERT INTO company_hist VALUES (?,?,?,?,?,?,?,?)", (cid, ref, yr(ref), pct, nom, cap, "EUR", url))
    meta["match_stats"] = stats
    log("  empresas", stats)


# ------------------------------------------------------------------ main
def main():
    RAW.mkdir(parents=True, exist_ok=True)
    tmp = DB.with_suffix(".db.tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    meta = {"errors": {}, "sources": {}, "blocked": []}
    log("DGAEP...")
    load_dgaep(con, meta)
    log("BOEP...")
    load_boep(con, meta)
    log("Carteira de participações...")
    snaps = load_carteira(con, meta) or []
    log("PDFs SEE...")
    load_see_pdfs(con, meta)
    log("  documentos SEE:", load_see_docs(con, meta))
    siee_names, siee_url, siee_year = load_siee_list()
    meta["siee_list"] = {"n": len(siee_names), "url": siee_url, "year": siee_year}
    log("garantias...")
    load_misc(con, meta)
    log("empresas + ligação ao registo...")
    build_companies(con, snaps, siee_names, siee_url, siee_year, meta)
    meta["blocked"] = [
        {"source": "SIOE - número de trabalhadores por entidade", "reason": "A DGAEP só publica agregados em dados abertos (subsetor, área governativa, carreira, atividade). O SIOE por entidade (sioe.dgaep.gov.pt) é uma aplicação com autenticação para as entidades, sem API pública; por isso não há efetivos por organismo."},
        {"source": "Dirigentes (n.º)", "reason": "Só existem os agregados por carreira dirigente (dirigente superior/intermédio, por grau) nas tabelas de carreiras e remunerações por carreira. Os titulares estão no módulo 'Quem decide' (CReSAP, Entidade para a Transparência)."},
        {"source": "Financeiras por empresa do SEE (volume de negócios, EBITDA, resultado líquido, dívida, capital próprio, trabalhadores)", "reason": "A ETF (ex-DGTF, etf.gov.pt) publica o Relatório do SEE, os boletins trimestrais e a 'Situação económico-financeira' apenas em PDF e só com agregados (total, financeiras/não financeiras, EPR/EPNR, por CAE); os valores por empresa só existem em gráficos. Os dados abertos da ETF no dados.gov.pt são a Carteira de Participações (sem financeiras), prazos de pagamento e empresas liquidadas (páginas HTML/PDF). Por isso as páginas de empresa mostram participação, capital e contratos, e não demonstrações financeiras."},
        {"source": "Documentos por empresa", "reason": "A página de relatórios da ETF (etf.gov.pt/relatorios-see) só lista documentos do conjunto do SEE (boletins trimestrais, relatórios anuais, bom governo, situação económico-financeira); nenhum é por empresa, por isso a lista de documentos é a mesma para todas e não há ligação documento-empresa. Os PDFs «Empresas utilizadas» dão apenas nomes."},
        {"source": "Indemnizações compensatórias e transferências do Estado por empresa", "reason": "Não existem em formato aberto/tabular na ETF; aparecem apenas nos PDFs do Relatório do SEE e na Conta Geral do Estado."},
        {"source": "Sector Empresarial Local (empresas municipais)", "reason": "O dataset da DGAL 'Setor Empresarial Local' (2015-2018) em dados.gov.pt contém só a lista de municípios (códigos INE), sem empresas nem contas. As empresas municipais ficam apenas as do registo de entidades do portal (contratação pública)."},
    ]
    con.executemany("INSERT INTO meta VALUES (?,?)", [(k, json.dumps(v, ensure_ascii=False)) for k, v in {
        "built": time.strftime("%Y-%m-%d %H:%M"), "errors": meta["errors"], "sources": meta["sources"], "blocked": meta["blocked"],
        "match_stats": meta.get("match_stats"), "siee_list": meta.get("siee_list")}.items()])
    con.commit()
    con.close()
    for ext in ("", "-wal", "-shm"):
        pth = DB.with_name(DB.name + ext)
        if pth.exists():
            pth.unlink()
    tmp.replace(DB)
    log("OK ->", DB)


def docs_only():
    con = sqlite3.connect(DB)
    migrations.ensure_estado_empresas(con)
    con.execute("DELETE FROM see_docs")
    meta = {"sources": {}}
    n = load_see_docs(con, meta)
    for key in ("sources", "blocked"):
        r = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        cur = json.loads(r[0]) if r else ({} if key == "sources" else [])
        if key == "sources":
            cur.update(meta["sources"])
        elif not any(b["source"] == "Documentos por empresa" for b in cur):
            cur.insert(-1, {"source": "Documentos por empresa", "reason": "A página de relatórios da ETF (etf.gov.pt/relatorios-see) só lista documentos do conjunto do SEE (boletins trimestrais, relatórios anuais, bom governo, situação económico-financeira); nenhum é por empresa, por isso a lista de documentos é a mesma para todas e não há ligação documento-empresa. Os PDFs «Empresas utilizadas» dão apenas nomes."})
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(cur, ensure_ascii=False)))
    con.commit()
    con.close()
    log("docs OK", n)


if __name__ == "__main__":
    import sys
    docs_only() if sys.argv[1:] == ["docs"] else main()
