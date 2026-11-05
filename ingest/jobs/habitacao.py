"""Habitacao (housing) -> data/habitacao.db.

Sources (all public, no login; robots.txt respected; >=1.3 s between requests to the same host; raw cache in data/raw/habitacao/):
  * RNAL - Registo Nacional de Alojamento Local (Turismo de Portugal open data, ArcGIS MapServer
    https://geo.turismodeportugal.pt/server/rest/services/TDP/OpenData_AL/MapServer/6, dataset 'Estabelecimentos de
    Alojamento Local' on dados.gov.pt, CC-BY). One row per ACTIVE registration. Only aggregates are stored: the
    establishment name and address (often a natural person) are never requested nor stored.
  * INE json_indicador API (www.ine.pt; no robots.txt restrictions): median sale price per m2 (last 12 months, quarterly),
    median rent per m2 of new leases (quarterly), dwellings licensed / completed, Census 2021 dwellings (by occupancy form,
    tenure), municipal social housing stock (2009-2015 survey, last available).
  * fundos.db (read-only): PRR component C02 'Habitacao' (programa de apoio ao acesso a habitacao = 1.o Direito financed by PRR,
    Bolsa de alojamento, parque publico a custos acessiveis...) aggregated per municipality; number of dwellings parsed from titles.
  * politica.db (read-only, Portal BASE contracts): housing-related procurement per municipality (CPV 45211 residential
    construction, CPV 70 real estate services, objects that mention housing), IHRU contracts, municipal housing companies.
  * votacoes.db / dre.db (read-only): housing initiatives in Parliament and housing acts in the Diario da Republica.
Blocked / not available as open data: 1.o Direito applications/contracts by municipality (only a Power BI embed on
portaldahabitacao.pt), Estrategias Locais de Habitacao list (descriptive pages only), Inventario do parque habitacional
publico (JavaScript app without open API), Porta de Entrada / Arrendamento Acessivel by municipality.

Run: python3 ingest/run_all.py habitacao     (HAB_STEPS=ine,rnal,prr,contratos,leis,dens to run a subset)
"""
import gzip
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT  # noqa: E402

NAME = "habitacao"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
POLITICA = DATA_DIR / "politica.db"
AUTARQUIAS = DATA_DIR / "autarquias.db"
FUNDOS = DATA_DIR / "fundos.db"
VOTACOES = DATA_DIR / "votacoes.db"
DRE = DATA_DIR / "dre.db"
EMPLOC = DATA_DIR / "empresas_locais.db"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 politica-pt/0.1"
INE_URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
INE_META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"
RNAL_BASE = "https://geo.turismodeportugal.pt/server/rest/services/TDP/OpenData_AL/MapServer/6"
RNAL_PAGE = "https://dados.gov.pt/pt/datasets/estabelecimentos-de-alojamento-local-1/"
IHRU_NIF = "501460888"

# (indicator id(s) in chronological order, label, family, concelho geocod length, dim filter)
#  dim filter: "all" keep every dim combination; "tot" keep rows whose dims after the first are all 'Total'
INE_IND = [
    (["0012241", "0014759"], "Valor mediano das vendas de alojamentos familiares, últimos 12 meses (€/m²)", "venda", 7, "all"),
    (["0012234", "0014763"], "Valor mediano das vendas, últimos 12 meses, por categoria (novos/existentes) (€/m²)", "venda_cat", 7, "all"),
    (["0014696", "0014771"], "Valor mediano das rendas de novos contratos de arrendamento, últimos 12 meses (€/m²)", "renda", 7, "all"),
    (["0014706"], "Valor mediano das rendas de novos contratos de arrendamento por tipologia, trimestre (€/m²)", "renda_tip", 7, "all"),
    (["0013235"], "Fogos licenciados em construções novas para habitação familiar (n.º)", "licenciados", 7, "all"),
    (["0013248"], "Fogos concluídos em construções novas para habitação familiar (n.º)", "concluidos", 7, "all"),
    (["0013234"], "Edifícios licenciados por tipo e destino da obra (n.º)", "edificios", 7, "all"),
    (["0012502"], "Alojamentos familiares clássicos por forma de ocupação, Censos 2021 (n.º)", "censos_ocup", 4, "tot"),
    (["0012531"], "Alojamentos familiares clássicos de residência habitual por regime de ocupação, Censos 2021 (n.º)", "censos_regime", 4, "tot"),
    (["0009016"], "Fogos de habitação social (n.º, Inquérito à caracterização da habitação social, até 2015)", "social", 7, "all"),
    (["0009003"], "Fogos de habitação social por destino (vagos, ocupados ilegalmente) (n.º, até 2015)", "social_destino", 7, "all"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ine_series (
  indicator TEXT, label TEXT, family TEXT, unit TEXT, geo_code TEXT, geo_name TEXT, level TEXT, dico TEXT,
  dim TEXT, period TEXT, year INTEGER, q INTEGER, value REAL, flag TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS hs_fam ON ine_series(family, level, dim, period);
CREATE INDEX IF NOT EXISTS hs_dico ON ine_series(dico, family, dim, period);
CREATE TABLE IF NOT EXISTS al_conc (dico TEXT PRIMARY KEY, concelho TEXT, n INTEGER, utentes INTEGER, first_reg TEXT, last_reg TEXT,
  snapshot TEXT, period TEXT, unit TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS al_freg (dicofre TEXT PRIMARY KEY, dico TEXT, freguesia TEXT, n INTEGER, utentes INTEGER, snapshot TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS af_dico ON al_freg(dico, n);
CREATE TABLE IF NOT EXISTS al_ano (dico TEXT, year INTEGER, n INTEGER, utentes INTEGER, cum_n INTEGER, cum_utentes INTEGER, period TEXT, unit TEXT, source_url TEXT,
  PRIMARY KEY (dico, year));
CREATE TABLE IF NOT EXISTS al_mes (month TEXT PRIMARY KEY, n INTEGER, source_url TEXT);
CREATE TABLE IF NOT EXISTS al_modal (dico TEXT, modalidade TEXT, n INTEGER, utentes INTEGER, source_url TEXT, PRIMARY KEY (dico, modalidade));
CREATE TABLE IF NOT EXISTS al_dens (dico TEXT PRIMARY KEY, name TEXT, n INTEGER, utentes INTEGER, alojamentos INTEGER, residencia_habitual INTEGER,
  per100_alojamentos REAL, per100_residencia_habitual REAL, population INTEGER, utentes_per100_hab REAL, period TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS prr_hab (dico TEXT, code TEXT, label TEXT, n INTEGER, fogos INTEGER, fogos_titles INTEGER, aprovado REAL, pago REAL,
  period TEXT, unit TEXT, source_url TEXT, PRIMARY KEY (dico, code));
CREATE TABLE IF NOT EXISTS prr_hab_nat (code TEXT PRIMARY KEY, label TEXT, n INTEGER, fogos INTEGER, aprovado REAL, pago REAL, n_sem_concelho INTEGER,
  aprovado_sem_concelho REAL, source_url TEXT);
CREATE TABLE IF NOT EXISTS hab_empresas (nif TEXT PRIMARY KEY, name TEXT, dico TEXT, method TEXT, entity_id INTEGER, n INTEGER, value REAL, source_url TEXT);
CREATE TABLE IF NOT EXISTS contr_agg (dico TEXT, lens TEXT, buyer_type TEXT, grp TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL,
  unit TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS ca_dico ON contr_agg(dico, lens, grp, year);
CREATE TABLE IF NOT EXISTS contr_top (dico TEXT, lens TEXT, id TEXT, signed TEXT, object TEXT, price REAL, buyer_type TEXT, buyer_nif TEXT, buyer_name TEXT,
  seller_nif TEXT, seller_name TEXT, grp TEXT, procedure TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS ct_dico ON contr_top(dico, lens, price);
CREATE TABLE IF NOT EXISTS ihru_year (year INTEGER PRIMARY KEY, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL, source_url TEXT);
CREATE TABLE IF NOT EXISTS ihru_top (seller_nif TEXT, seller_name TEXT, entity_id INTEGER, n INTEGER, value REAL, source_url TEXT);
CREATE TABLE IF NOT EXISTS leis (ref TEXT PRIMARY KEY, src TEXT, kind TEXT, number TEXT, title TEXT, date TEXT, leg TEXT, autoria TEXT, estado TEXT,
  resultado TEXT, lei_ref TEXT, dre_id TEXT, tema TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS leis_date ON leis(date);
CREATE TABLE IF NOT EXISTS leis_votos (ref TEXT, data TEXT, fase TEXT, orgao TEXT, resultado TEXT, favor TEXT, contra TEXT, abstencao TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS lv_ref ON leis_votos(ref);
CREATE TABLE IF NOT EXISTS fontes (id TEXT PRIMARY KEY, name TEXT, url TEXT, licence TEXT, period TEXT, status TEXT, note TEXT);
"""

_last = {}
_robots = {}


def log(*a):
    print(*a, flush=True)


def strip(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


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


def get(url, cache, ttl_days=20, timeout=240, wait=1.4, transient=True):
    """Download with cache + politeness. Returns the cached Path."""
    cache = RAW / cache
    if cache.exists() and cache.stat().st_size > 0 and time.time() - cache.stat().st_mtime < ttl_days * 86400:
        return cache
    if not robots_ok(url):
        raise PermissionError("robots.txt disallows " + url)
    host = urllib.parse.urlparse(url).netloc
    last = None
    for attempt in range(4):
        dt = time.time() - _last.get(host, 0)
        if dt < wait:
            time.sleep(wait - dt)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
            tmp = cache.with_suffix(cache.suffix + ".part")
            with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 16)
                    if not b:
                        break
                    f.write(b)
            _last[host] = time.time()
            if transient and b'"Sucesso"' in tmp.read_bytes()[:400] and b"Falso" in tmp.read_bytes()[:600]:
                raise RuntimeError("INE devolveu erro")
            tmp.replace(cache)
            return cache
        except Exception as e:  # noqa: BLE001
            last = e
            _last[host] = time.time()
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def connect():
    con = sqlite3.connect(DB, timeout=120)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=120000")
    con.executescript(SCHEMA)
    return con


def ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=120)
    c.row_factory = sqlite3.Row
    return c


def municipios():
    a = ro(AUTARQUIAS)
    rows = a.execute("SELECT dico, name, district, nif, population, population_year FROM municipios").fetchall()
    a.close()
    return rows


# ------------------------------------------------------------------ INE
def parse_period(p):
    m = re.match(r"^(\d)\.º Trimestre de (\d{4})$", p)
    if m:
        return f"{m.group(2)}Q{m.group(1)}", int(m.group(2)), int(m.group(1))
    if re.fullmatch(r"\d{4}", p):
        return p, int(p), None
    return None, None, None


def step_ine(con):
    total = 0
    for ids, label, fam, clen, dimf in INE_IND:
        con.execute("DELETE FROM ine_series WHERE family=?", (fam,))
        con.commit()
        rows_all = 0
        for v in ids:
            url = INE_URL.format(v=v)
            try:
                f = get(url, f"ine_{v}.json", ttl_days=25, timeout=600)
                d = json.loads(f.read_text(encoding="utf-8"))
                d = d[0] if isinstance(d, list) else d
                if "Dados" not in d:
                    raise RuntimeError(str(d)[:120])
            except Exception as e:  # noqa: BLE001
                log("  INE falhou", v, str(e)[:140])
                continue
            dsg = d.get("IndicadorDsg", "")
            m = re.search(r"\(([^)]*)\)", dsg)
            unit = m.group(1) if m else ""
            src = INE_META.format(v=v)
            rows = []
            for period, recs in d["Dados"].items():
                pp, yr, q = parse_period(period)
                if not pp:
                    continue
                for x in recs:
                    g = x.get("geocod", "")
                    if g == "PT":
                        lvl, dico = "PT", None
                    elif len(g) == clen:
                        lvl, dico = "concelho", g[-4:]
                    elif len(g) == 1:
                        lvl, dico = "area", None
                    elif len(g) == 2 and g.isdigit():
                        lvl, dico = "nuts2", None
                    elif len(g) == 3 and g.isdigit():
                        lvl, dico = "nuts3", None
                    else:
                        continue
                    try:
                        val = float(x.get("valor"))
                    except (TypeError, ValueError):
                        continue
                    dims = [x[k] for k in sorted(x) if re.fullmatch(r"dim_\d+_t", k) and x[k]]
                    if dimf == "tot" and any(not t.startswith("Total") for t in dims[1:]):
                        continue
                    if dimf == "tot":
                        dims = dims[:1]
                    rows.append((v, label, fam, unit, g, x.get("geodsg"), lvl, dico, " / ".join(dims), pp, yr, q, val,
                                 x.get("sinal_conv_desc") or None, src))
            for i in range(0, len(rows), 5000):
                con.executemany("INSERT INTO ine_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows[i:i + 5000])
                con.commit()
            con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", ("ine_desc_" + v, dsg + " | atualizado " + str(d.get("DataUltimoAtualizacao"))))
            con.commit()
            rows_all += len(rows)
            log("  INE", v, fam, len(rows), "linhas")
            del d, rows
        total += rows_all
    con.execute("INSERT OR REPLACE INTO meta VALUES ('ine_rows', ?)", (str(total),))
    con.commit()


# ------------------------------------------------------------------ RNAL
def step_rnal(con):
    fields = "NrRNAL,DataRegisto,Modalidade,NrUtentes,DTMNFR,Freguesia,Concelho,Distrito"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cache = RAW / "rnal_agg_fields.jsonl.gz"
    if not (cache.exists() and time.time() - cache.stat().st_mtime < 7 * 86400):
        if not robots_ok(RNAL_BASE + "/query"):
            raise PermissionError("robots.txt")
        n_total = None
        recs = []
        offset = 0
        page = 5000
        while True:
            qs = urllib.parse.urlencode({"where": "1=1", "outFields": fields, "returnGeometry": "false", "orderByFields": "OBJECTID",
                                         "resultOffset": offset, "resultRecordCount": page, "f": "json"})
            f = get(RNAL_BASE + f"/query?{qs}", f"rnal_page_{offset}.json", ttl_days=0, transient=False)
            d = json.loads(f.read_text(encoding="utf-8"))
            feats = d.get("features") or []
            recs.extend(x["attributes"] for x in feats)
            f.unlink()
            log("  RNAL", offset, len(feats))
            if not feats:
                break
            offset += len(feats)
            if not d.get("exceededTransferLimit") and len(feats) < page:
                break
        with gzip.open(cache, "wt", encoding="utf-8") as g:
            for r in recs:
                g.write(json.dumps(r, ensure_ascii=False) + "\n")
    recs = []
    with gzip.open(cache, "rt", encoding="utf-8") as g:
        for ln in g:
            recs.append(json.loads(ln))
    log("  RNAL registos ativos", len(recs))
    src = RNAL_PAGE
    muni = {m["dico"]: m for m in municipios()}
    conc = defaultdict(lambda: [0, 0, None, None, ""])
    freg = {}
    ano = defaultdict(lambda: [0, 0])
    mes = defaultdict(int)
    modal = defaultdict(lambda: [0, 0])
    bad = 0
    for r in recs:
        dtm = (r.get("DTMNFR") or "").strip()
        if len(dtm) != 6 or dtm[:4] not in muni:
            bad += 1
            continue
        dico = dtm[:4]
        u = int(r.get("NrUtentes") or 0)
        ts = r.get("DataRegisto")
        dt = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d") if ts else None
        c = conc[dico]
        c[0] += 1
        c[1] += u
        c[4] = r.get("Concelho") or c[4]
        if dt:
            c[2] = dt if c[2] is None or dt < c[2] else c[2]
            c[3] = dt if c[3] is None or dt > c[3] else c[3]
            y = int(dt[:4])
            for k in (dico, ""):
                a = ano[(k, y)]
                a[0] += 1
                a[1] += u
            mes[dt[:7]] += 1
        fr = freg.setdefault(dtm, [dico, r.get("Freguesia"), 0, 0])
        fr[2] += 1
        fr[3] += u
        mo = r.get("Modalidade") or "n/d"
        for k in (dico, ""):
            mm = modal[(k, mo)]
            mm[0] += 1
            mm[1] += u
    log("  RNAL sem DICO válido:", bad)
    for t in ("al_conc", "al_freg", "al_ano", "al_mes", "al_modal"):
        con.execute(f"DELETE FROM {t}")
    per = "registos ativos em " + today
    con.executemany("INSERT INTO al_conc VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [(k, v[4], v[0], v[1], v[2], v[3], today, per, "estabelecimentos / utentes", src) for k, v in conc.items()])
    con.executemany("INSERT INTO al_freg VALUES (?,?,?,?,?,?,?)", [(k, v[0], v[1], v[2], v[3], today, src) for k, v in freg.items()])
    by = defaultdict(list)
    for (k, y), v in ano.items():
        by[k].append((y, v[0], v[1]))
    rows = []
    for k, lst in by.items():
        cn = cu = 0
        for y, n, u in sorted(lst):
            cn += n
            cu += u
            rows.append((k, y, n, u, cn, cu, "ano de registo (só registos ainda ativos)", "estabelecimentos / utentes", src))
    con.executemany("INSERT INTO al_ano VALUES (?,?,?,?,?,?,?,?,?)", rows)
    con.executemany("INSERT INTO al_mes VALUES (?,?,?)", [(k, v, src) for k, v in mes.items()])
    con.executemany("INSERT INTO al_modal VALUES (?,?,?,?,?)", [(k[0], k[1], v[0], v[1], src) for k, v in modal.items()])
    con.execute("INSERT OR REPLACE INTO meta VALUES ('rnal_snapshot', ?)", (today,))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('rnal_records', ?)", (str(len(recs)),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('rnal_bad_dico', ?)", (str(bad),))
    con.commit()


# ------------------------------------------------------------------ densities (RNAL x Census 2021)
def step_dens(con):
    cen = {}
    for dico, dim, v in con.execute("SELECT dico, dim, value FROM ine_series WHERE family='censos_ocup' AND level='concelho'"):
        cen.setdefault(dico, {})[dim] = v
    ms = {m["dico"]: m for m in municipios()}
    con.execute("DELETE FROM al_dens")
    rows = []
    for r in con.execute("SELECT dico, n, utentes FROM al_conc").fetchall():
        dico, n, u = r
        c = cen.get(dico) or {}
        tot, hab = c.get("Total"), c.get("Residência habitual")
        m = ms.get(dico)
        pop = m["population"] if m else None
        rows.append((dico, m["name"] if m else None, n, u, tot, hab, (100.0 * n / tot) if tot else None,
                     (100.0 * n / hab) if hab else None, pop, (100.0 * u / pop) if pop else None,
                     "AL: registos ativos (snapshot RNAL); alojamentos: Censos 2021", "https://www.ine.pt/xportal/xmain?xpid=INE&xpgid=ine_indicadores&indOcorrCod=0012502&contexto=bd&selTab=tab2",))
    con.executemany("INSERT INTO al_dens VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    log("  densidades AL", len(rows), "com censos:", sum(1 for r in rows if r[4]))


# ------------------------------------------------------------------ PRR C02 habitacao (fundos.db)
def step_prr(con):
    f = ro(FUNDOS)
    ms = {strip(m["name"]): m["dico"] for m in municipios()}
    labels = {}
    for r in f.execute("SELECT investimento, title FROM prr_contracts WHERE investimento LIKE 'C02%'"):
        labels[r["investimento"][:7]] = r["title"]
    acc = defaultdict(lambda: [0, 0, 0, 0.0, 0.0])
    nat = defaultdict(lambda: [0, 0, 0.0, 0.0, 0, 0.0])
    unmatched = defaultdict(int)
    pat = re.compile(r"(?:Reabilita[cç][aã]o|Constru[cç][aã]o|Aquisi[cç][aã]o|Reconvers[aã]o)\s+de\s+(\d+)\s+", re.I)
    for r in f.execute("SELECT code, titulo, concelho, aprovado, pago FROM awards WHERE programa LIKE 'PRR · C02%' AND counts=1"):
        m = re.search(r"C02-i\d+", r["code"] or "")
        if not m:
            continue
        code = m.group(0)
        mm = pat.match(r["titulo"] or "")
        fg = int(mm.group(1)) if mm else None
        nt = nat[code]
        nt[0] += 1
        nt[1] += fg or 0
        nt[2] += r["aprovado"] or 0
        nt[3] += r["pago"] or 0
        dico = ms.get(strip(r["concelho"] or ""))
        if not dico:
            nt[4] += 1
            nt[5] += r["aprovado"] or 0
            unmatched[r["concelho"]] += 1
            continue
        a = acc[(dico, code)]
        a[0] += 1
        a[1] += fg or 0
        a[2] += 1 if fg else 0
        a[3] += r["aprovado"] or 0
        a[4] += r["pago"] or 0
    f.close()
    src = "https://dados.gov.pt/pt/datasets/6717dc1f1b0eaad60ac5008e"
    con.execute("DELETE FROM prr_hab")
    con.execute("DELETE FROM prr_hab_nat")
    con.executemany("INSERT INTO prr_hab VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    [(k[0], k[1], labels.get(k[1], k[1]), v[0], v[1], v[2], v[3], v[4], "estado do PRR em " + datetime.now().strftime("%Y-%m-%d"), "projetos / fogos / €", src) for k, v in acc.items()])
    con.executemany("INSERT INTO prr_hab_nat VALUES (?,?,?,?,?,?,?,?,?)",
                    [(k, labels.get(k, k), v[0], v[1], v[2], v[3], v[4], v[5], src) for k, v in nat.items()])
    con.execute("INSERT OR REPLACE INTO meta VALUES ('prr_unmatched', ?)", (json.dumps(dict(unmatched), ensure_ascii=False),))
    con.commit()
    log("  PRR C02:", len(acc), "pares concelho×investimento; sem concelho:", dict(list(unmatched.items())[:5]))


# ------------------------------------------------------------------ procurement
MANUAL_OWNER = {"506064433": "1317", "506546365": "0116"}
HAB_NAME = re.compile(r"habit|habita|domus|gebalis|habevora|casfig|sociohab|alojamento social", re.I)
OBJ_HAB = re.compile(r"habita[cç]|\bfogos?\b|realojamento|arrendamento acess|arrendamento apoiado|bairro social|casas? de renda", re.I)


def step_contratos(con):
    ms = municipios()
    nif2dico = {m["nif"]: m["dico"] for m in ms if m["nif"]}
    a = ro(AUTARQUIAS)
    for r in a.execute("SELECT entity_nif, dico FROM freguesias WHERE entity_nif IS NOT NULL"):
        d = (r["dico"] or "")[:4]
        if d:
            nif2dico.setdefault(r["entity_nif"], d)
    fnifs = {r["entity_nif"] for r in a.execute("SELECT entity_nif FROM freguesias WHERE entity_nif IS NOT NULL")}
    a.close()
    mnifs = {m["nif"] for m in ms if m["nif"]}
    # municipal housing companies and their owner municipality
    p = ro(POLITICA)
    ents = p.execute("SELECT id, nif, name, kind FROM entities WHERE nif IS NOT NULL AND kind IN ('empresa_municipal','outra_entidade','sociedade_adjudicante','instituto_publico','regional')").fetchall()
    owners = {}
    if EMPLOC.exists():
        e = ro(EMPLOC)
        for r in e.execute("SELECT c.nif, o.dico, o.method, o.confidence FROM company c JOIN owner o ON o.company_id=c.id WHERE c.nif IS NOT NULL ORDER BY o.pct DESC"):
            owners.setdefault(r["nif"], (r["dico"], "empresas_locais: " + str(r["method"])))
        e.close()
    names = sorted(((strip(m["name"]), m["dico"]) for m in ms), key=lambda t: -len(t[0]))
    companies = {}
    for r in ents:
        if r["kind"] in ("instituto_publico", "regional"):
            continue
        if not HAB_NAME.search(r["name"] or ""):
            continue
        dico, meth = owners.get(r["nif"], (None, None))
        if not dico:
            sn = " " + strip(r["name"]) + " "
            for nm, dc in names:
                if len(nm) >= 5 and " " + nm + " " in sn:
                    dico, meth = dc, "nome contém o município"
                    break
        if not dico and r["nif"] in MANUAL_OWNER:
            dico, meth = MANUAL_OWNER[r["nif"]], "atribuição manual pelo nome (Gaiurb = V. N. Gaia; Habitar S. João = S. João da Madeira)"
        companies[r["nif"]] = (r["id"], r["name"], dico, meth)
    dico_by_name = defaultdict(set)
    for m in ms:
        dico_by_name[strip(m["name"])].add(m["dico"])
    dist = {m["dico"]: strip(m["district"]) for m in ms}

    def loc2dico(loc):
        parts = [x.strip() for x in (loc or "").split(",")]
        if len(parts) != 3 or parts[0] != "Portugal":
            return None
        c = dico_by_name.get(strip(parts[2]))
        if not c:
            return None
        if len(c) == 1:
            return next(iter(c))
        for d in c:
            if dist.get(d) == strip(parts[1]):
                return d
        return None

    agg = defaultdict(lambda: [0, 0.0, 0, 0.0])
    tops = defaultdict(list)
    ihru_y = defaultdict(lambda: [0, 0.0, 0, 0.0])
    ihru_s = defaultdict(lambda: [0, 0.0, ""])
    comp_tot = defaultdict(lambda: [0, 0.0])
    sql = ("SELECT id, year, signed, object, procedure, price, cpv_code, location, buyer_nif, buyer_name, seller_nif, seller_name, link "
           "FROM contracts WHERE cpv_code LIKE '45211%' OR cpv_code LIKE '70%' OR buyer_nif=? OR object LIKE '%abitaç%' OR object LIKE '%abitacional%' "
           "OR object LIKE '%fogos%' OR object LIKE '%ealojamento%' OR object LIKE '%rrendamento acess%'")
    n = 0
    for r in p.execute(sql, (IHRU_NIF,)):
        n += 1
        cpv = r["cpv_code"] or ""
        price = r["price"] or 0.0
        if cpv.startswith("45211"):
            grp = "construcao_residencial"
        elif cpv.startswith("70"):
            grp = "imobiliario"
        elif OBJ_HAB.search(r["object"] or ""):
            grp = "objeto_habitacao"
        else:
            grp = None
        direct = 1 if "diret" in (r["procedure"] or "").lower() else 0
        yr = r["year"]
        bnif = r["buyer_nif"]
        if bnif == IHRU_NIF:
            y = ihru_y[yr]
            y[0] += 1
            y[1] += price
            y[2] += direct
            y[3] += price * direct
            s = ihru_s[r["seller_nif"]]
            s[0] += 1
            s[1] += price
            s[2] = r["seller_name"] or s[2]
        if bnif in companies:
            ct = comp_tot[bnif]
            ct[0] += 1
            ct[1] += price
        if not grp and not (bnif == IHRU_NIF or bnif in companies):
            continue
        g = grp or "habitacao_entidade"  # contracts of IHRU / housing companies without housing CPV/keywords
        # buyer lens
        bd, bt = None, None
        if bnif in mnifs:
            bd, bt = nif2dico[bnif], "municipio"
        elif bnif in fnifs and bnif in nif2dico:
            bd, bt = nif2dico[bnif], "freguesia"
        elif bnif in companies and companies[bnif][2]:
            bd, bt = companies[bnif][2], "empresa_municipal"
        if bd:
            k = (bd, "comprador", bt, g, yr)
            a_ = agg[k]
            a_[0] += 1
            a_[1] += price
            a_[2] += direct
            a_[3] += price * direct
            tops[(bd, "comprador")].append((price, r["id"], r["signed"], r["object"], bt, bnif, r["buyer_name"], r["seller_nif"], r["seller_name"], g, r["procedure"], r["link"]))
        ld = loc2dico(r["location"])
        if ld and grp:
            k = (ld, "local", bt or "outro", g, yr)
            a_ = agg[k]
            a_[0] += 1
            a_[1] += price
            a_[2] += direct
            a_[3] += price * direct
    p.close()
    log("  contratos lidos", n, "| empresas habitação", len(companies), "| com município", sum(1 for c in companies.values() if c[2]))
    for t in ("contr_agg", "contr_top", "ihru_year", "ihru_top", "hab_empresas"):
        con.execute(f"DELETE FROM {t}")
    base = "https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id="
    rows = [(k[0], k[1], k[2], k[3], k[4], v[0], v[1], v[2], v[3], "contratos / €", "Portal BASE (politica.db)") for k, v in agg.items()]
    con.executemany("INSERT INTO contr_agg VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    trows = []
    for (d, lens), lst in tops.items():
        lst.sort(key=lambda t: -t[0])
        seen = set()
        c = 0
        for t in lst:
            if t[1] in seen:
                continue
            seen.add(t[1])
            trows.append((d, lens, t[1], t[2], (t[3] or "")[:300], t[0], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11] or base + str(t[1])))
            c += 1
            if c >= 12:
                break
    con.executemany("INSERT INTO contr_top VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", trows)
    con.executemany("INSERT INTO ihru_year VALUES (?,?,?,?,?,?)", [(y, v[0], v[1], v[2], v[3], "Portal BASE (NIF IHRU " + IHRU_NIF + ")") for y, v in ihru_y.items() if y])
    top = sorted(ihru_s.items(), key=lambda kv: -kv[1][1])[:30]
    pp = ro(POLITICA)
    eid = {r["nif"]: r["id"] for r in pp.execute("SELECT id, nif FROM entities WHERE nif IN (%s)" % ",".join("?" * len(top)), [k for k, _ in top])} if top else {}
    pp.close()
    con.executemany("INSERT INTO ihru_top VALUES (?,?,?,?,?,?)", [(k, v[2], eid.get(k), v[0], v[1], "Portal BASE") for k, v in top])
    con.executemany("INSERT INTO hab_empresas VALUES (?,?,?,?,?,?,?,?)",
                    [(nif, c[1], c[2], c[3], c[0], comp_tot[nif][0], comp_tot[nif][1], "Portal BASE / registo do portal") for nif, c in companies.items()])
    con.commit()


# ------------------------------------------------------------------ legislation
LAW_Q = ("habitaç", "habitacion", "arrendament", "alojamento local", "inquilin", "senhori", "imobiliári", "rendas", "renda ", "alojamento")
LAW_CLEAN = re.compile(r"alojamento (?:local|estudantil|de emerg)|habitaç|arrendament|inquilin|senhori|rendas? (?:acess|antiga|habita)|renda\b|imobili", re.I)


def tema_of(t):
    s = (t or "").lower()
    if "alojamento local" in s:
        return "Alojamento local"
    if "arrendament" in s or "renda" in s or "inquilin" in s or "senhori" in s:
        return "Arrendamento e rendas"
    if "imobili" in s or "solo" in s or "urbanis" in s:
        return "Imobiliário e solo"
    if "habita" in s:
        return "Habitação (geral)"
    return "Outros"


def step_leis(con):
    v = ro(VOTACOES)
    where = " OR ".join("titulo LIKE ?" for _ in LAW_Q)
    rows = v.execute(f"SELECT bid, key, tipo, numero, leg, titulo, autoria, estado, resultado_final, data_entrada, data_votacao_final, lei_ref, dre_act_id, source_url FROM iniciativas WHERE {where}",
                     ["%" + q + "%" for q in LAW_Q]).fetchall()
    con.execute("DELETE FROM leis")
    con.execute("DELETE FROM leis_votos")
    out = []
    refs = []
    for r in rows:
        if not LAW_CLEAN.search(r["titulo"] or ""):
            continue
        ref = f"ini:{r['bid']}"
        refs.append((ref, r["bid"]))
        out.append((ref, "parlamento", r["tipo"], f"{r['numero']}/{r['leg']}", r["titulo"], r["data_votacao_final"] or r["data_entrada"], r["leg"], r["autoria"],
                    r["estado"], r["resultado_final"], r["lei_ref"], r["dre_act_id"], tema_of(r["titulo"]), r["source_url"]))
    con.executemany("INSERT OR REPLACE INTO leis VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", out)
    nv = 0
    for ref, bid in refs:
        for x in v.execute("SELECT data, fase, orgao, resultado, favor, contra, abstencao, source_url FROM votos WHERE bid=? ORDER BY data", (bid,)):
            con.execute("INSERT INTO leis_votos VALUES (?,?,?,?,?,?,?,?,?)", (ref, x["data"], x["fase"], x["orgao"], x["resultado"], x["favor"], x["contra"], x["abstencao"], x["source_url"]))
            nv += 1
    v.close()
    d = ro(DRE)
    like = ("%habitaç%", "%arrendament%", "%alojamento local%", "%inquilin%", "%senhori%", "%rendas%", "%renda %")
    cond = " OR ".join("(title LIKE ? OR summary LIKE ?)" for _ in like)
    args = [x for q in like for x in (q, q)]
    n_dre = 0
    for r in d.execute(f"SELECT id, kind, number, date, title, summary, source_url, url, issuer FROM acts WHERE kind IN ('Lei','Decreto-Lei','Portaria','Resolução do Conselho de Ministros','Resolução da Assembleia da República','Decreto Legislativo Regional','Decreto Regulamentar') AND ({cond})", args):
        text = (r["summary"] or "") + " " + (r["title"] or "")
        if not LAW_CLEAN.search(text):
            continue
        con.execute("INSERT OR REPLACE INTO leis VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("dre:" + str(r["id"]), "dre", r["kind"], r["number"], (r["summary"] or r["title"] or "")[:400], r["date"], None, r["issuer"], "Publicado", None,
                     f"{r['kind']} {r['number']}", str(r["id"]), tema_of(text), r["url"] or r["source_url"]))
        n_dre += 1
    d.close()
    con.commit()
    log("  leis: iniciativas", len(out), "votos", nv, "| atos DRE", n_dre)


# ------------------------------------------------------------------ sources / coverage
def step_fontes(con):
    con.execute("DELETE FROM fontes")
    rows = [
        ("rnal", "RNAL — Estabelecimentos de Alojamento Local (Turismo de Portugal)", RNAL_PAGE, "CC-BY", "registos ativos, snapshot " + datetime.now().strftime("%Y-%m-%d"), "ok",
         "Só registos ativos (cancelados não aparecem); a série por ano de registo é a dos registos ainda ativos, não o stock histórico. Nome e morada não são recolhidos."),
        ("ine_venda", "INE — Valor mediano das vendas de alojamentos familiares (€/m², últimos 12 meses)", INE_META.format(v="0012241"), "CC-BY (INE)", "1.º T 2020 – 2.º T 2026", "ok",
         "Metodologia 2022. Só mediana: municípios com poucas transações podem não ter valor (sinal convencional)."),
        ("ine_renda", "INE — Valor mediano das rendas de novos contratos (€/m², últimos 12 meses)", INE_META.format(v="0014696"), "CC-BY (INE)", "1.º T 2020 – 2.º T 2026", "ok",
         "Metodologia 2026; só novos contratos registados na AT."),
        ("ine_licenc", "INE — Fogos licenciados / concluídos; edifícios licenciados", INE_META.format(v="0013235"), "CC-BY (INE)", "anual até 2025", "ok", "Construções novas para habitação familiar."),
        ("ine_censos", "INE — Censos 2021: alojamentos por forma de ocupação e regime", INE_META.format(v="0012502"), "CC-BY (INE)", "2021", "ok", "Base do denominador do indicador de alojamento local por 100 alojamentos."),
        ("ine_social", "INE — Fogos de habitação social (inquérito às câmaras)", INE_META.format(v="0009016"), "CC-BY (INE)", "2009–2015", "desatualizado",
         "Última edição disponível; não inclui o parque do IHRU após 2015."),
        ("prr_c02", "PRR C02 Habitação (Estrutura de Missão Recuperar Portugal, via fundos.db)", "https://dados.gov.pt/pt/datasets/6717dc1f1b0eaad60ac5008e", "variável", "estado atual do PRR", "ok",
         "C02-i01 'Programa de apoio ao acesso à habitação' é o instrumento que financia o 1.º Direito. Nº de fogos lido do título do projeto quando indicado."),
        ("contratos", "Portal BASE (contratos públicos, via politica.db)", "https://www.base.gov.pt/", "dados abertos", "2012 – 2026", "ok",
         "Grupos: CPV 45211 (construção residencial), CPV 70 (serviços imobiliários), objeto menciona habitação/fogos, e contratos do IHRU e empresas municipais de habitação. Localização por 'Portugal, Distrito, Concelho'."),
        ("leis", "Assembleia da República (votacoes.db) e Diário da República (dre.db)", "https://www.parlamento.pt/", "dados abertos", "iniciativas desde 2022 (XV–XVII legislaturas)", "parcial",
         "Pesquisa por palavras no título/sumário; iniciativas anteriores a 2022 não existem na base do portal."),
        ("ihru_1direito", "IHRU / Portal da Habitação — 1.º Direito, Porta de Entrada, Arrendamento Acessível, ELH", "https://www.portaldahabitacao.pt/", "—", "—", "bloqueado",
         "Sem dados abertos por município: os números do 1.º Direito estão num painel Power BI embebido (não recolhido), as ELH em páginas descritivas, o Inventário Público é uma aplicação JavaScript sem API aberta. robots.txt permite o acesso, mas não há ficheiro estruturado."),
    ]
    con.executemany("INSERT INTO fontes VALUES (?,?,?,?,?,?,?)", rows)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (datetime.now().strftime("%Y-%m-%d %H:%M"),))
    con.commit()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    steps = os.environ.get("HAB_STEPS", "ine,rnal,dens,prr,contratos,leis").split(",")
    con = connect()
    for s in steps:
        s = s.strip()
        t = time.time()
        log("== passo", s)
        {"ine": step_ine, "rnal": step_rnal, "dens": step_dens, "prr": step_prr, "contratos": step_contratos, "leis": step_leis}[s](con)
        log("   %.0f s" % (time.time() - t))
    step_fontes(con)
    for t in ("ine_series", "al_conc", "al_freg", "al_ano", "prr_hab", "contr_agg", "contr_top", "leis", "leis_votos", "hab_empresas"):
        log("  ", t, con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
