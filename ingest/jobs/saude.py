"""Saude (SNS) domain -> data/saude.db.

What is ingested (all public, no login, robots.txt respected):
  * sns.gov.pt "Entidades de Saude": every ULS / IPO / hospital / central SNS body with its official page, address,
    website, e-mail, board president and the *composition* (hospitals, ACeS, centros de saude) written on its page.
  * INE (www.ine.pt json_indicador API): hospital and health-centre activity series (beds, admissions, emergency
    attendances, outpatient consultations, staff, surgeries...) for Portugal / NUTS II / NUTS III. Not per institution.
  * dados.gov.pt catalogue: the ~90 SNS indicator datasets published by the Portal da Transparencia do SNS
    (title, publisher, frequency, licence, last update, official links). The DATA of those datasets is NOT
    downloaded: transparencia.sns.gov.pt/robots.txt disallows /api/ and /explore/dataset/*/download for generic
    robots, and that is the only place the files are hosted. The catalogue is stored so the UI can point to them.
  * Link to the entity registry (data/politica.db) by NIF / unambiguous normalised name (never guessed).
Procurement is NOT copied: the server joins live against politica.db contracts via the NIF stored here.

Run: python3 ingest/run_all.py saude      (SAUDE_STEPS=inst,ine,catalog to run a subset)
"""
import html
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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT  # noqa: E402

NAME = "saude"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
POLITICA = DATA_DIR / "politica.db"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 politica-pt/0.1"
SNS_LIST = "https://www.sns.gov.pt/institucional/entidades-de-saude/"
INE_URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
INE_META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"

# INE indicators (id, short label, family). Old (NUTS-2001/2013) and new (NUTS-2024) series are kept separate.
INE_IND = [
    ("0012885", "Hospitais (N.º)", "rede"),
    ("0007570", "Hospitais oficiais públicos (N.º)", "rede"),
    ("0002898", "Camas dos hospitais (N.º) — série até 2012", "rede"),
    ("0012893", "Camas dos hospitais públicos de acesso universal e PPP (N.º)", "rede"),
    ("0010244", "Taxa de ocupação das camas nos hospitais (%)", "rede"),
    ("0008103", "Internamentos nos hospitais (N.º)", "atividade"),
    ("0012895", "Internamentos nos hospitais públicos de acesso universal e PPP (N.º)", "atividade"),
    ("0008108", "Atendimentos em serviço de urgência nos hospitais (N.º)", "atividade"),
    ("0012900", "Atendimentos em urgência nos hospitais públicos de acesso universal e PPP (N.º)", "atividade"),
    ("0008105", "Consultas médicas na consulta externa dos hospitais (N.º)", "atividade"),
    ("0007424", "Consultas médicas na consulta externa — hospitais públicos de acesso universal e PPP (N.º)", "atividade"),
    ("0002906", "Consultas médicas nas consultas externas dos hospitais, por especialidade (N.º) — série até 2012", "atividade"),
    ("0008002", "Intervenções de grande e média cirurgia por dia nos hospitais (N.º)", "atividade"),
    ("0012898", "Cirurgias por dia — hospitais públicos de acesso universal e PPP (N.º)", "atividade"),
    ("0000698", "Pessoal ao serviço nos hospitais (N.º)", "pessoal"),
    ("0012899", "Pessoal ao serviço — hospitais públicos de acesso universal e PPP (N.º)", "pessoal"),
    ("0008203", "Centros de saúde (N.º)", "cuidados primários"),
    ("0008207", "Consultas médicas nos centros de saúde (N.º)", "cuidados primários"),
    ("0008201", "Pessoal ao serviço nos centros de saúde (N.º)", "cuidados primários"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,               -- slug of the sns.gov.pt page, or 'ent-<id>' for registry-only bodies
  name TEXT NOT NULL, kind TEXT,     -- uls | ipo | hospital | ars | regional | central
  region TEXT, region_how TEXT,      -- ARS area (derived from the postal code of the seat) or autonomous region
  address TEXT, postal TEXT, locality TEXT, phone TEXT, email TEXT, website TEXT,
  president TEXT, president_role TEXT, description TEXT,
  n_units INTEGER DEFAULT 0, n_hospitals INTEGER DEFAULT 0, n_aces INTEGER DEFAULT 0, n_cs INTEGER DEFAULT 0,
  nif TEXT, entity_id INTEGER, match_how TEXT, norm TEXT,
  source_url TEXT, period TEXT
);
CREATE INDEX IF NOT EXISTS inst_nif ON institutions(nif);
CREATE INDEX IF NOT EXISTS inst_kind ON institutions(kind);
CREATE INDEX IF NOT EXISTS inst_region ON institutions(region);
CREATE TABLE IF NOT EXISTS units (
  inst_id TEXT, kind TEXT,           -- hospital | aces | centro_saude | outra
  name TEXT, parent TEXT,            -- parent ACeS for centros de saude
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS units_inst ON units(inst_id);
CREATE TABLE IF NOT EXISTS ine_series (
  indicator TEXT, indicator_name TEXT, family TEXT, unit TEXT,
  geo_code TEXT, geo_name TEXT, level TEXT,   -- level: PT | area | nuts2 | nuts3
  dim TEXT, period TEXT, value REAL, flag TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS ine_ind ON ine_series(indicator, geo_code, period);
CREATE TABLE IF NOT EXISTS catalog (
  dataset_id TEXT PRIMARY KEY, title TEXT, publisher TEXT, topic TEXT, frequency TEXT, license TEXT,
  last_update TEXT, dados_url TEXT, portal_url TEXT, formats TEXT, status TEXT, note TEXT
);
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
                if r.status == 200 and "text/html" not in (r.headers.get("content-type") or ""):
                    rp.parse(r.read().decode("utf-8", "replace").splitlines())
                else:
                    rp.parse([])
        except Exception:
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(UA, url)


def get(url, cache, ttl_days=20, timeout=180, wait=1.3, binary=False):
    """Polite cached GET (robots.txt checked, per-host spacing, streamed to disk)."""
    cache = RAW / cache
    if cache.exists() and cache.stat().st_size > 0 and time.time() - cache.stat().st_mtime < ttl_days * 86400:
        return cache
    if not robots_ok(url):
        raise PermissionError("robots.txt disallows " + url)
    host = urllib.parse.urlparse(url).netloc
    dt = time.time() - _last.get(host, 0)
    if dt < wait:
        time.sleep(wait - dt)
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
            tmp = cache.with_suffix(cache.suffix + ".part")
            with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 16)
                    if not b:
                        break
                    f.write(b)
            tmp.replace(cache)
            _last[host] = time.time()
            return cache
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def strip(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"&[a-z#0-9]+;", " ", s)
    s = re.sub(r"[^a-z0-9/ ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


LEGAL = re.compile(r"\b(e ?p ?e ?r?|i ?p|e ?p|s ?a)\b")


def norm(name):
    s = strip(name)
    s = re.sub(r"^(spms|infarmed|ars|acss|dgs|inem|insa|ipst|icad|ers|such|igas)\s+", "", s)
    s = re.sub(r"\b(e p e r|e p e|epe|epe r|eper|i p|ip|e p)\b", " ", s)
    s = re.sub(r"\b(epe|eper|ip)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def text_of(h):
    h = re.sub(r"<br\s*/?>", "\n", h)
    return html.unescape(re.sub(r"<[^>]+>", "", h)).replace("\xa0", " ").strip()


def region_from_postal(cp):
    """ARS area of a continental postal code (4-digit prefix); islands by range. Approximation, flagged in the UI."""
    if not cp:
        return None
    n = int(cp[:4])
    if 9000 <= n <= 9374:
        return "Região Autónoma da Madeira"
    if 9500 <= n <= 9999:
        return "Região Autónoma dos Açores"
    if 8000 <= n <= 8999:
        return "Algarve"
    if 7000 <= n <= 7999:
        return "Alentejo"
    if 4000 <= n <= 5399:
        return "Norte"
    if 1000 <= n <= 2999:
        return "Centro" if 2400 <= n <= 2499 else "Lisboa e Vale do Tejo"
    if 3000 <= n <= 3999 or 6000 <= n <= 6999:
        return "Centro"
    return None


# ------------------------------------------------------------------ institutions
def kind_of(name):
    s = strip(name)
    if s.startswith("unidade local de saude"):
        return "uls"
    if s.startswith("instituto portugues de oncologia"):
        return "ipo"
    if s.startswith("hospital") or s.startswith("centro hospitalar"):
        return "hospital"
    return "central"


def parse_page(path):
    t = Path(path).read_text(encoding="utf-8", errors="replace")
    out = {"units": [], "description": None}
    head = t[: t.find("entitydetails")] if "entitydetails" in t else t
    k = head.rfind('<div id="rs_read_this">')
    body = head[k + len('<div id="rs_read_this">'):] if k >= 0 else ""
    body = body.split("Dirigentes")[0] if re.search(r">\s*Dirigentes\s*<", body) else body
    body = re.split(r"<(?:p|div)[^>]*>\s*<strong>\s*Dirigentes", body)[0]
    h = re.sub(r"</?(?:p|div|li|ul|ol|h\d|tr|td)[^>]*>|<br\s*/?>", "\n", body)
    lines = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", x)).replace("\xa0", " ")).strip(" •-–\t") for x in h.split("\n")]
    desc, cur, started = [], None, False
    for x in lines:
        if not x or re.fullmatch(r"(?i)unidades|\d+ centros? de sa[uú]de.*", x):
            if x and re.match(r"(?i)\d+ centros? de sa", x):
                cur = "Centros de saúde da ULS"
            if x and x.lower() == "unidades":
                started = True
            continue
        name = x
        mm = re.match(r"^(.{4,140}?)\s+[–-]\s+(.*\d{4}\s?-\s?\d{3}.*)$", x)  # "Name – address, CP locality"
        if mm:
            name = mm.group(1).strip()
        if len(name) > 140:
            if not started:
                desc.append(x)
            continue
        if re.match(r"(?i)(ac[eo]?s\b|agrupamento de centros de sa)", name):
            cur = name
            out["units"].append(("aces", name, None))
        elif re.match(r"(?i)(hospital|centro hospitalar|instituto portugu|maternidade|unidade hospitalar)", name):
            cur = None
            out["units"].append(("hospital", name, None))
        elif re.match(r"(?i)centro de sa[uú]de", name):
            out["units"].append(("centro_saude", name, cur))
        elif re.match(r"(?i)(usf\b|ucsp\b|ucc\b|usp\b|unidade de (sa[uú]de|cuidados)|unidade (de )?(vila|saude)|extens[aã]o|sausm|equipa|servi[cç]o)", name):
            out["units"].append(("outra", name, cur))
        elif started:
            out["units"].append(("outra", name, None))
        else:
            desc.append(x)
    out["description"] = " ".join(desc).strip() or None
    if not any(u[0] == "hospital" for u in out["units"]):
        # fallback: hospitals named in the official page's ERS/SINAS quality links (same page, other tab)
        seen_h = set()
        for nm in re.findall(r'<a [^>]*Detalhe(?:Hospital|Estabelecimento)[^>]*>([^<]+)</a>', t, re.I):
            nm = re.sub(r"\s+", " ", html.unescape(nm)).strip()
            if nm and nm.lower() not in seen_h:
                seen_h.add(nm.lower())
                out["units"].append(("hospital", nm, None))
    m = re.search(r'entitydetails.*?<div class="col-xss-12 col-xs-9 col-sm-12">\s*(.*?)<br />\s*<strong>\s*(.*?)</strong>', t, re.S)
    if m:
        out["president"], out["president_role"] = text_of(m.group(1)), text_of(m.group(2))
    m = re.search(r'Contactos</span></div>\s*<p>(.*?)</p>', t, re.S)
    if m:
        addr = text_of(m.group(1))
        out["address"] = re.sub(r"\s*\n\s*", ", ", addr).strip(", ")
        mp = re.search(r"(\d{4})\s?[-–]\s?(\d{3})\s+([^\n,]+)", addr)
        if mp:
            out["postal"], out["locality"] = mp.group(1) + "-" + mp.group(2), mp.group(3).strip()
    m = re.search(r"<strong>Telefone</strong><br />([^<]+)", t)
    out["phone"] = m.group(1).strip() if m else None
    m = re.search(r'mailto:([^"]+)"', t[t.find("entitydetails"):] if "entitydetails" in t else t)
    out["email"] = m.group(1).strip() if m else None
    m = re.search(r"<strong>Website</strong><br /><a href=\"([^\"]+)\"", t)
    out["website"] = m.group(1).strip() if m else None
    return out


def load_entities():
    con = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id,nif,name,kind,buyer_contracts,buyer_value FROM entities WHERE kind IN ('saude','instituto_publico','regional','outra_entidade','empresa_publica')"
    ).fetchall()
    con.close()
    idx = {}
    for r in rows:
        idx.setdefault(norm(r["name"]), []).append(r)
    return rows, idx


# Hand-verified aliases (registry spelling differs from sns.gov.pt; same legal entity, confirmed by name+type).
ALIAS = {"instituto portugues de oncologia de lisboa francisco gentil": "instituto portugues de oncologia de lisboa fg"}


def match(name, idx):
    n = norm(name)
    cands = idx.get(ALIAS.get(n, n), [])
    if not cands:
        return None, None, "sem correspondência"
    if len(cands) == 1:
        c = cands[0]
        return c, "nome normalizado único", None
    with_nif = [c for c in cands if c["nif"]]
    if len(with_nif) == 1:
        return with_nif[0], "nome normalizado (único com NIF)", None
    return None, None, f"ambíguo ({len(cands)} entidades)"


def step_inst(con):
    p = get(SNS_LIST, "sns_entidades.html", ttl_days=10)
    t = p.read_text(encoding="utf-8", errors="replace")
    links, seen = [], set()
    for href, label in re.findall(r'href="(https://www\.sns\.gov\.pt/entidades-de-saude/[^"]+)"[^>]*>([^<]{3,200})<', t):
        label = text_of(label)
        if href in seen or not label:
            continue
        seen.add(href)
        links.append((href, label))
    # the Icad link appears once with an empty label; keep first labelled occurrence only
    log("entidades listadas em sns.gov.pt:", len(links))
    rows, idx = load_entities()
    stats = {"total": 0, "matched": 0, "uls": 0, "uls_matched": 0, "unmatched": [], "ambiguous": []}
    con.execute("DELETE FROM institutions")
    con.execute("DELETE FROM units")
    today = time.strftime("%Y-%m-%d")
    for href, label in links:
        slug = href.rstrip("/").rsplit("/", 1)[-1]
        try:
            f = get(href, f"sns_{slug}.html", ttl_days=10)
            info = parse_page(f)
        except Exception as e:  # noqa: BLE001
            log("  falhou", slug, e)
            info = {"units": []}
        kind = kind_of(label)
        name = label
        c, how, why = match(name, idx)
        units = info.get("units", [])
        region = region_from_postal(info.get("postal"))
        con.execute(
            "INSERT OR REPLACE INTO institutions(id,name,kind,region,region_how,address,postal,locality,phone,email,website,president,president_role,description,"
            "n_units,n_hospitals,n_aces,n_cs,nif,entity_id,match_how,norm,source_url,period) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (slug, name, kind, region, "código postal da sede" if region else None, info.get("address"), info.get("postal"), info.get("locality"),
             info.get("phone"), info.get("email"), info.get("website"), info.get("president"), info.get("president_role"), info.get("description"),
             len(units), sum(1 for u in units if u[0] == "hospital"), sum(1 for u in units if u[0] == "aces"), sum(1 for u in units if u[0] == "centro_saude"),
             c["nif"] if c else None, c["id"] if c else None, how, norm(name), href, today),
        )
        for k, n, par in units:
            con.execute("INSERT INTO units VALUES (?,?,?,?,?)", (slug, k, n, par, href))
        stats["total"] += 1
        if kind == "uls":
            stats["uls"] += 1
        if c:
            stats["matched"] += 1
            if kind == "uls":
                stats["uls_matched"] += 1
        else:
            (stats["ambiguous"] if why and why.startswith("ambíguo") else stats["unmatched"]).append(name)
    # registry-only SNS bodies: ARS and autonomous-region health services / hospitals
    listed_norm = {r[0] for r in con.execute("SELECT norm FROM institutions")}
    extra = []
    for r in rows:
        n = r["name"]
        s = strip(n)
        if r["kind"] not in ("saude", "regional", "instituto_publico", "outra_entidade"):
            continue
        k = None
        reg = None
        if re.match(r"(ars\b|administracao regional de saude)", s):
            k = "ars"
            reg = {"norte": "Norte", "centro": "Centro", "lisboa": "Lisboa e Vale do Tejo", "alentejo": "Alentejo", "algarve": "Algarve"}.get(
                next((w for w in ("norte", "centro", "lisboa", "alentejo", "algarve") if w in s), ""), None)
        elif re.search(r"servico de saude da regiao autonoma da madeira|sesaram", s):
            k, reg = "regional", "Região Autónoma da Madeira"
        elif re.search(r"(eper)\b", s) and "hospital" in s:
            k, reg = "regional", "Região Autónoma dos Açores"
        if not k:
            continue
        extra.append((k, reg, r))
    seen_ids = set()

    def gkey(k, reg, r):
        return ("ars", reg) if k == "ars" else ("sesaram",) if "sesaram" in strip(r["name"]) or "regiao autonoma da madeira" in strip(r["name"]) else (k, norm(r["name"]))

    for k, reg, r in extra:
        if norm(r["name"]) in listed_norm:
            continue
        key = gkey(k, reg, r)
        if key in seen_ids:
            continue
        group = [x for (k2, g2, x) in extra if gkey(k2, g2, x) == key]
        pick = next((x for x in sorted(group, key=lambda y: -(y["buyer_contracts"] or 0)) if x["nif"]), group[0])
        seen_ids.add(key)
        con.execute(
            "INSERT OR REPLACE INTO institutions(id,name,kind,region,region_how,nif,entity_id,match_how,norm,source_url,period) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"ent-{pick['id']}", pick["name"], k, reg, "nome da entidade" if reg else None, pick["nif"], pick["id"], "registo de entidades (política.db)", norm(pick["name"]),
             "https://dados.gov.pt/ (registo BASE / politica.db)", today),
        )
        stats["total"] += 1
        stats["matched"] += 1 if pick["nif"] else 0
    con.execute("INSERT OR REPLACE INTO meta VALUES ('match_stats', ?)", (json.dumps(stats, ensure_ascii=False),))
    log("instituições:", stats["total"], "ligadas:", stats["matched"], "ULS:", stats["uls"], "ULS ligadas:", stats["uls_matched"])
    log("  sem correspondência:", stats["unmatched"])
    log("  ambíguas:", stats["ambiguous"])


# ------------------------------------------------------------------ INE
def step_ine(con):
    con.execute("DELETE FROM ine_series")
    total = 0
    for v, label, fam in INE_IND:
        url = INE_URL.format(v=v)
        try:
            f = get(url, f"ine_{v}.json", ttl_days=25, timeout=240, wait=1.5)
            d = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(d, list):
                d = d[0]
        except Exception as e:  # noqa: BLE001
            try:  # truncated/corrupt cache -> retry once from scratch
                (RAW / f"ine_{v}.json").unlink(missing_ok=True)
                f = get(url, f"ine_{v}.json", ttl_days=25, timeout=240, wait=1.5)
                d = json.loads(f.read_text(encoding="utf-8"))
                d = d[0] if isinstance(d, list) else d
            except Exception as e2:  # noqa: BLE001
                log("  INE falhou", v, e2)
                continue
        dsg = d.get("IndicadorDsg", "")
        m = re.search(r"\(([^)]*)\)", dsg)
        unit = m.group(1) if m else ""
        src = INE_META.format(v=v)
        n = 0
        for period, recs in (d.get("Dados") or {}).items():
            for x in recs:
                g = x.get("geocod", "")
                if not (g == "PT" or len(g) <= 3):
                    continue
                val = x.get("valor")
                try:
                    val = float(val)
                except (TypeError, ValueError):
                    continue
                lvl = "PT" if g == "PT" else {1: "area", 2: "nuts2", 3: "nuts3"}[len(g)]
                dims = " / ".join(x[k] for k in sorted(x) if re.fullmatch(r"dim_\d+_t", k) and x[k])
                con.execute(
                    "INSERT INTO ine_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (v, label, fam, unit, g, x.get("geodsg"), lvl, dims, period[:4] if len(period) >= 4 else period, val, x.get("sinal_conv_desc") or None, src),
                )
                n += 1
        total += n
        log("  INE", v, label[:60], n, "linhas")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('ine_rows', ?)", (str(total),))


# ------------------------------------------------------------------ catalogue
def topic_of(t):
    s = strip(t)
    rules = [
        (r"\blic\b|cirurg|fratura|demora media antes|sigic|ambulatorio", "Cirurgia e LIC"),
        (r"urgenc|manchester|triagem|inem|pre hospitalar|acionamentos|emergencia", "Urgência e emergência"),
        (r"consulta|primeiras consultas|utentes inscritos|inscritos em cuidados|medico de familia|registo nacional de utentes|contactos de enfermagem|saude oral|rastreio", "Consultas e cuidados primários"),
        (r"internamento|morbilidade|mortalidade|obito|cuidados continuados", "Internamento e mortalidade"),
        (r"medicament|infarmed|dispositivo|farmac|prescri|dispensa|receita|custo de tratamento|preco medio", "Medicamentos e dispositivos"),
        (r"divida|pagamento|despesa|conta do|agregados economico|fornecimentos|poupanca|acordos quadro|compras|taxas moderadoras|convencionad|prestadores|termos de responsabilidade|custo", "Finanças e contratação"),
        (r"trabalhadores|medicos especialistas|rhv|recursos humanos", "Recursos humanos"),
        (r"sns 24|telesaude|teleconsulta|registo saude|portal sns|area (pessoal|do cidadao)|nascimento digital|linha sns", "Digital e SNS 24"),
        (r"transportes", "Transporte de doentes"),
    ]
    for rx, name in rules:
        if re.search(rx, s):
            return name
    return "Outros"


def step_catalog(con):
    con.execute("DELETE FROM catalog")
    seen = {}
    qs = ["SNS", "tempos de espera", "urgências", "lista de inscritos para cirurgia", "utentes sem médico de família", "internamentos",
          "produção hospitalar", "recursos humanos SNS", "consultas hospitalares", "SPMS", "INFARMED", "INEM", "Direção-Geral da Saúde",
          "cuidados de saúde primários", "hospital", "medicamentos", "morbilidade hospitalar"]
    for q in qs:
        for pg in (1, 2, 3):
            url = "https://dados.gov.pt/api/1/datasets/?q=%s&page_size=100&page=%d" % (urllib.parse.quote(q), pg)
            try:
                f = get(url, "dg_%s_%d.json" % (re.sub(r"\W+", "_", strip(q)), pg), ttl_days=7, timeout=60, wait=1.0)
                d = json.loads(f.read_text(encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                log("  dados.gov.pt falhou", q, e)
                break
            for x in d.get("data", []):
                res = x.get("resources") or []
                tr = [r for r in res if "transparencia.sns.gov.pt" in (r.get("url") or "")]
                if not tr:
                    continue
                key = strip(x["title"])
                prev = seen.get(key)
                if prev and (prev["last_update"] or "") >= (x.get("last_update") or ""):
                    continue
                m = re.search(r"/explore/dataset/([^/]+)/", tr[0]["url"])
                seen[key] = {
                    "id": x["id"], "title": x["title"], "publisher": (x.get("organization") or {}).get("name"),
                    "freq": x.get("frequency"), "lic": x.get("license"), "last_update": (x.get("last_update") or "")[:10],
                    "dados_url": x.get("page"), "portal_url": f"https://transparencia.sns.gov.pt/explore/dataset/{m.group(1)}/" if m else "https://transparencia.sns.gov.pt/",
                    "formats": ",".join(sorted({r.get("format") for r in tr if r.get("format")})),
                }
            if not d.get("next_page"):
                break
    note = "Dados não descarregados: o robots.txt de transparencia.sns.gov.pt proíbe /api/ e /explore/dataset/*/download a robôs, e é o único anfitrião destes ficheiros."
    for v in seen.values():
        con.execute("INSERT OR REPLACE INTO catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (v["id"], v["title"], v["publisher"], topic_of(v["title"]), v["freq"], v["lic"], v["last_update"], v["dados_url"], v["portal_url"], v["formats"], "bloqueado_robots", note))
    log("catálogo SNS:", len(seen), "conjuntos de dados")


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    steps = (os.environ.get("SAUDE_STEPS") or "inst,ine,catalog").split(",")
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    try:
        # evidence of the robots decision (robots.txt is always allowed to read)
        try:
            req = urllib.request.Request("https://transparencia.sns.gov.pt/robots.txt", headers={"User-Agent": UA})
            txt = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
            (RAW / "transparencia_robots.txt").write_text(txt, encoding="utf-8")
            rp = urllib.robotparser.RobotFileParser()
            rp.parse(txt.splitlines())
            blocked = not rp.can_fetch(UA, "https://transparencia.sns.gov.pt/api/explore/v2.1/catalog/datasets")
            con.execute("INSERT OR REPLACE INTO meta VALUES ('transparencia_blocked', ?)", (json.dumps({"blocked": blocked, "checked": time.strftime("%Y-%m-%d")}),))
        except Exception as e:  # noqa: BLE001
            log("robots transparencia:", e)
        if "inst" in steps:
            step_inst(con)
            con.commit()
        if "ine" in steps:
            step_ine(con)
            con.commit()
        if "catalog" in steps:
            step_catalog(con)
            con.commit()
        con.execute("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
        con.commit()
    finally:
        con.close()


if __name__ == "__main__":
    main()
