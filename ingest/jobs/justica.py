"""Justiça (module `justica`) -> data/justica.db

Sources (all public, robots.txt checked per host, >=1.1 s between requests to a host, raw cache in data/raw/justica/):
  * INE json_indicador (series from the Direção-Geral da Política de Justiça): tribunais, pessoal, movimento de processos,
    duração média, evolução anual.  The DGPJ bulk open-data API (apiestatisticas.justica.gov.pt/OpenData/...) answers 404
    for every dataset advertised on dados.gov.pt, and estatisticas.justica.gov.pt is a Blazor/PowerBI app -> not scrapable;
    INE republishes the same DGPJ series at national level.
  * tribunalconstitucional.pt: listing of all acórdãos (1983-today) + full text of the abstract-control/referendum ones
    (outcome parsed from the "Decisão" section).
  * tcontas.pt: relatórios (auditoria, acompanhamento, verificação de contas, responsabilidades) and acórdãos (visto) per year.
  * Registry (data/politica.db, read-only): courts/justice bodies and Ministry of Justice bodies (data/ministerios.db).
Env: JUSTICA_ONLY=ine,tc,tcontas,registry   JUSTICA_TC_DETAIL_MAX=n
"""
import html
import json
import os
import re
import sqlite3
import subprocess
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

NAME = "justica"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
MIN_GAP = 1.15
_last = {}
_robots = {}

TC_BASE = "https://www.tribunalconstitucional.pt/tc/acordaos/"
TCONTAS = "https://www.tcontas.pt"
INE_URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
INE_META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"
INE_VARS = ["0000843", "0008040", "0000844", "0008041", "0008042", "0000853", "0007461", "0000845", "0001980", "0009062",
            "0007348", "0007349", "0000846", "0001981", "0008890"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS orgaos (            -- curated institutions (courts, councils, MP) with official sites
  id TEXT PRIMARY KEY, name TEXT, category TEXT, jurisdicao TEXT, description TEXT, website TEXT, nif TEXT,
  reachable INTEGER, source_url TEXT, entity_id INTEGER);
CREATE TABLE IF NOT EXISTS tribunais (          -- courts and justice bodies from the portal registry (Portal BASE + Wikidata)
  entity_id INTEGER PRIMARY KEY, nif TEXT, name TEXT, category TEXT, comarca TEXT, buyer_contracts INTEGER, buyer_value REAL, source_url TEXT);
CREATE TABLE IF NOT EXISTS mj_bodies (nif TEXT PRIMARY KEY, entity_id INTEGER, name TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS stats_series (       -- INE/DGPJ series, long format
  indicator TEXT, ind_name TEXT, unit TEXT, period TEXT, geo TEXT, dim1 TEXT, dim2 TEXT, value REAL, source_url TEXT);
CREATE INDEX IF NOT EXISTS stats_i ON stats_series(indicator, period);
CREATE TABLE IF NOT EXISTS stats_meta (indicator TEXT PRIMARY KEY, name TEXT, updated TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS tc_acordaos (
  id TEXT PRIMARY KEY,           -- e.g. 2025/1
  year INTEGER, num INTEGER, processo TEXT, formacao TEXT, especie TEXT, tipo TEXT, data TEXT, relator TEXT,
  norma TEXT, resultado TEXT, sumario TEXT, dre_act_id TEXT, url TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS tca_year ON tc_acordaos(year);
CREATE INDEX IF NOT EXISTS tca_tipo ON tc_acordaos(tipo);
CREATE TABLE IF NOT EXISTS tcontas_docs (
  id TEXT PRIMARY KEY, categoria TEXT, grupo TEXT, year INTEGER, titulo_ref TEXT, numero TEXT, data TEXT, publicado TEXT,
  descricao TEXT, tipo TEXT, resultado TEXT, entity_name TEXT, entity_id INTEGER, entity_nif TEXT, match_method TEXT,
  pdf_url TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS tcd_entity ON tcontas_docs(entity_id);
CREATE INDEX IF NOT EXISTS tcd_cat ON tcontas_docs(categoria, year);
CREATE TABLE IF NOT EXISTS blocked (source TEXT, reason TEXT);
"""


# --------------------------------------------------------------------------- http
def robots_ok(url):
    p = urllib.parse.urlsplit(url)
    host = p.scheme + "://" + p.netloc
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(host + "/robots.txt", headers={"User-Agent": BROWSER_UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8", "replace")
            if body.lstrip().lower().startswith(("<!doctype", "<html")):
                rp = None            # HTML error page instead of robots.txt => no rules
            else:
                rp.parse(body.splitlines())
        except urllib.error.HTTPError:
            rp = None                # 404 etc.: no restrictions
        except Exception:
            rp = None
        _robots[host] = rp
        time.sleep(MIN_GAP)
    rp = _robots[host]
    return True if rp is None else rp.can_fetch("*", url)


def fetch(url, cache=None, binary=False, max_age=None):
    """GET with cache, robots check and per-host throttling. Returns text (or bytes) or None."""
    f = RAW / cache if cache else None
    if f and f.exists() and (max_age is None or time.time() - f.stat().st_mtime < max_age):
        return f.read_bytes() if binary else f.read_text("utf-8", "replace")
    if not robots_ok(url):
        print("  robots.txt forbids", url)
        return None
    host = urllib.parse.urlsplit(url).netloc
    wait = _last.get(host, 0) + MIN_GAP - time.time()
    if wait > 0:
        time.sleep(wait)
    data = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept-Language": "pt-PT,pt;q=0.9"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            break
        except urllib.error.HTTPError as e:
            _last[host] = time.time()
            if e.code in (404, 403, 410):
                print("  HTTP", e.code, url)
                return None
            time.sleep(3 * (attempt + 1))
        except Exception as e:
            print("  retry", url, e)
            time.sleep(3 * (attempt + 1))
    _last[host] = time.time()
    if data is None:
        return None
    if f:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return data if binary else data.decode("utf-8", "replace")


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def strip_tags(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    c.row_factory = sqlite3.Row
    return c


# --------------------------------------------------------------------------- registry
ORGAOS = [
    # id, name, category, jurisdição, description, website, nif (looked up by name in the registry)
    ("tc", "Tribunal Constitucional", "tribunal_superior", "Constitucional", "Fiscalização da constitucionalidade e da legalidade; contencioso eleitoral e partidário.", "https://www.tribunalconstitucional.pt/", "Tribunal Constitucional"),
    ("stj", "Supremo Tribunal de Justiça", "tribunal_superior", "Judicial", "Topo da ordem judicial: recursos de revista e de decisões das Relações.", "https://www.stj.pt/", "Supremo Tribunal de Justiça"),
    ("sta", "Supremo Tribunal Administrativo", "tribunal_superior", "Administrativa e fiscal", "Topo da ordem administrativa e fiscal.", "https://www.sta.pt/", "Supremo Tribunal Administrativo"),
    ("tdc", "Tribunal de Contas", "tribunal_superior", "Financeira", "Fiscalização prévia (visto), auditorias e julgamento de responsabilidades financeiras.", "https://www.tcontas.pt/", "Direção-Geral do Tribunal de Contas"),
    ("trl", "Tribunal da Relação de Lisboa", "tribunal_relacao", "Judicial", "Tribunal de 2.ª instância.", "https://www.trlisboa.pt/", "Tribunal da Relação de Lisboa"),
    ("trp", "Tribunal da Relação do Porto", "tribunal_relacao", "Judicial", "Tribunal de 2.ª instância.", "https://www.trp.pt/", "Tribunal da Relação do Porto"),
    ("trc", "Tribunal da Relação de Coimbra", "tribunal_relacao", "Judicial", "Tribunal de 2.ª instância.", "https://www.trc.pt/", "Tribunal da Relação de Coimbra"),
    ("tre", "Tribunal da Relação de Évora", "tribunal_relacao", "Judicial", "Tribunal de 2.ª instância.", "https://www.trevora.pt/", "Tribunal da Relação de Évora"),
    ("trg", "Tribunal da Relação de Guimarães", "tribunal_relacao", "Judicial", "Tribunal de 2.ª instância.", "https://www.trg.pt/", "Tribunal da Relação de Guimarães"),
    ("tcan", "Tribunal Central Administrativo Norte", "tribunal_superior", "Administrativa e fiscal", "2.ª instância administrativa e fiscal.", "https://www.tcan.pt/", "Tribunal Central Administrativo Norte"),
    ("tcas", "Tribunal Central Administrativo Sul", "tribunal_superior", "Administrativa e fiscal", "2.ª instância administrativa e fiscal.", "https://www.tcas.pt/", "Tribunal Central Administrativo Sul"),
    ("csm", "Conselho Superior da Magistratura", "conselho", "Judicial", "Órgão de gestão e disciplina dos juízes dos tribunais judiciais.", "https://www.csm.org.pt/", "Conselho Superior da Magistratura"),
    ("cstaf", "Conselho Superior dos Tribunais Administrativos e Fiscais", "conselho", "Administrativa e fiscal", "Órgão de gestão e disciplina dos juízes administrativos e fiscais.", "https://www.cstaf.org.pt/", "Conselho Superior dos Tribunais Administrativos e Fiscais"),
    ("csmp", "Conselho Superior do Ministério Público", "conselho", "Ministério Público", "Gestão e disciplina dos magistrados do Ministério Público.", "https://www.ministeriopublico.pt/", None),
    ("pgr", "Procuradoria-Geral da República", "ministerio_publico", "Ministério Público", "Órgão superior do Ministério Público.", "https://www.ministeriopublico.pt/", "Procuradoria-Geral da República"),
    ("dciap", "Departamento Central de Investigação e Ação Penal (DCIAP)", "ministerio_publico", "Ministério Público", "Investigação da criminalidade violenta, organizada e económico-financeira de maior complexidade.", "https://dciap.ministeriopublico.pt/", None),
]


def classify_court(name):
    n = norm(name)
    if "supremo tribunal de justica" in n or "supremo tribunal administrativo" in n or "tribunal constitucional" in n or "tribunal de contas" in n:
        return "tribunal_superior"
    if "tribunal da relacao" in n:
        return "tribunal_relacao"
    if "tribunal central administrativo" in n:
        return "tribunal_superior"
    if "tribunal administrativo" in n or "tribunal tributario" in n:
        return "tribunal_administrativo"
    if "estabelecimento prisional" in n or "cantina" in n or "prisional" in n:
        return "prisional"
    if "policia judiciaria" in n or "registos e do notariado" in n:
        return "organismo_mj"
    if "comarca" in n or "tribunal" in n or "juizo" in n or "secretaria judicial" in n or "varas" in n:
        return "tribunal_1_instancia"
    if "ministerio publico" in n or "procuradoria" in n or "diap" in n:
        return "ministerio_publico"
    if "conselho superior" in n:
        return "conselho"
    return "outro"


def comarca_of(name):
    m = re.search(r"[Cc]omarca (?:de |do |da |dos |das )?([^,(-]+)", name)
    return m.group(1).strip() if m else None


def build_registry(con):
    pol = ro(ROOT / "data" / "politica.db")
    rows = pol.execute("SELECT id, nif, name, buyer_contracts, buyer_value FROM entities WHERE kind='tribunal_justica'").fetchall()
    con.execute("DELETE FROM tribunais")
    for r in rows:
        con.execute("INSERT OR REPLACE INTO tribunais VALUES (?,?,?,?,?,?,?,?)",
                    (r["id"], r["nif"], r["name"], classify_court(r["name"]), comarca_of(r["name"]), r["buyer_contracts"], r["buyer_value"],
                     f"https://www.base.gov.pt/ (NIF {r['nif']})" if r["nif"] else "https://www.wikidata.org/ (registo de entidades do portal)"))
    print("  tribunais (registry):", len(rows))
    con.execute("DELETE FROM orgaos")
    for oid, name, cat, jur, desc, web, regname in ORGAOS:
        nif = eid = None
        if regname:
            e = pol.execute("SELECT id, nif FROM entities WHERE name=? ORDER BY nif IS NULL, buyer_value DESC LIMIT 1", (regname,)).fetchone()
            if not e:
                e = pol.execute("SELECT id, nif FROM entities WHERE name LIKE ? AND kind='tribunal_justica' ORDER BY nif IS NULL, buyer_value DESC LIMIT 1", (regname + "%",)).fetchone()
            nif, eid = (e["nif"], e["id"]) if e else (None, None)
        reach = None
        try:
            if robots_ok(web):
                time.sleep(MIN_GAP)
                req = urllib.request.Request(web, headers={"User-Agent": BROWSER_UA})
                with urllib.request.urlopen(req, timeout=25) as r:
                    reach = 1 if r.status < 400 else 0
            else:
                reach = None
        except Exception:
            reach = 0
        con.execute("INSERT OR REPLACE INTO orgaos VALUES (?,?,?,?,?,?,?,?,?,?)", (oid, name, cat, jur, desc, web, nif, reach, web, eid))
    # Ministry of Justice bodies (data/ministerios.db built by the `ministerios` module from the portal registry + Governo pages)
    con.execute("DELETE FROM mj_bodies")
    try:
        mj = ro(ROOT / "data" / "ministerios.db")
        for r in mj.execute("SELECT nif, entity_id, name, source_url FROM bodies WHERE ministry='justica' AND nif IS NOT NULL").fetchall():
            con.execute("INSERT OR REPLACE INTO mj_bodies VALUES (?,?,?,?)", (r["nif"], r["entity_id"], r["name"], r["source_url"]))
    except Exception as e:
        print("  ministerios.db not available:", e)
    print("  mj_bodies:", con.execute("SELECT COUNT(*) FROM mj_bodies").fetchone()[0])
    con.commit()


# --------------------------------------------------------------------------- INE / DGPJ
def ingest_ine(con):
    con.execute("DELETE FROM stats_series")
    con.execute("DELETE FROM stats_meta")
    for v in INE_VARS:
        url = INE_URL.format(v=v)
        txt = fetch(url, f"ine/{v}.json", max_age=7 * 86400)
        if not txt:
            print("  INE", v, "unavailable")
            continue
        try:
            d = json.loads(txt)[0]
        except Exception as e:
            print("  INE", v, "bad json", e)
            continue
        if d.get("Sucesso") and not d.get("Dados"):
            print("  INE", v, "no data")
            continue
        name = d["IndicadorDsg"]
        unit_m = re.search(r"\((N\.º|%|Mês|[^)]{1,10})\)", name)
        unit = unit_m.group(1) if unit_m else ""
        n = 0
        for period, recs in d["Dados"].items():
            for r in recs:
                val = r.get("valor")
                try:
                    val = float(val)
                except (TypeError, ValueError):
                    continue
                dims = [r[k] for k in sorted(r) if re.fullmatch(r"dim_\d+_t", k)]
                con.execute("INSERT INTO stats_series VALUES (?,?,?,?,?,?,?,?,?)",
                            (v, name, unit, period, r.get("geodsg") or r.get("geocod"), dims[0] if dims else None, dims[1] if len(dims) > 1 else None, val,
                             INE_META.format(v=v)))
                n += 1
        con.execute("INSERT OR REPLACE INTO stats_meta VALUES (?,?,?,?)", (v, name, d.get("DataUltimoAtualizacao"), INE_META.format(v=v)))
        print(f"  INE {v}: {n} points - {name[:70]}")
    con.commit()


# --------------------------------------------------------------------------- Tribunal Constitucional
TC_ROW = re.compile(r'<a href="(\d{8})\.html"[^>]*>([^<]+)</a></td>\s*<td[^>]*processo">([^<]*)</td>\s*<td[^>]*seccao">([^<]*)</td>\s*<td[^>]*especie">([^<]*)</td>\s*<td[^>]*data">([^<]*)</td>\s*<td[^>]*relator">([^<]*)</td>', re.S)


def tc_tipo(especie):
    e = norm(especie)
    table = [("preventiv", "Fiscalização preventiva"), ("sucessiv", "Fiscalização sucessiva abstrata"), ("omissao", "Inconstitucionalidade por omissão"),
             ("referendo", "Referendo"), ("eleitoral", "Contencioso eleitoral"), ("partido", "Partidos políticos"),
             ("ppce", "Financiamento partidário e campanhas"), ("financiamento", "Financiamento partidário e campanhas"),
             ("reclamacao", "Reclamação"), ("recurso", "Fiscalização concreta (recurso)"), ("incompatib", "Incompatibilidades de titulares de cargos"),
             ("dpr", "Declarações de titulares de cargos políticos"), ("presidente da republica", "Presidente da República")]
    for key, label in table:
        if e == key or key in e:
            return label
    return especie.strip() or "Outro"


def tc_listing_urls():
    idx = fetch(TC_BASE, "tc/index.html", max_age=3 * 86400)
    if not idx:
        return []
    urls = sorted(set(re.findall(r'href="(https://www\.tribunalconstitucional\.pt/tc/acordaos/\d{8}-\d{4}\.html)"', idx)))
    cur = sorted(set(re.findall(r'href="(\d{8}-\d{4}\.html)"', idx)))
    return [TC_BASE] + urls + [TC_BASE + c for c in cur if TC_BASE + c not in urls]


def clean_decision(text):
    t = re.sub(r"\s+", " ", text)
    i = max(t.rfind("III - Decisão"), t.rfind("III – Decisão"), t.rfind("Decisão"), t.rfind("DECISÃO"))
    return t[i:i + 2500] if i >= 0 else t[-2500:]


def tc_outcome(dec):
    d = norm(dec)
    outs = []
    neg_pron = re.findall(r"nao se pronunci\w*.{0,30}pela inconstitucionalidade", d)
    d_pos = re.sub(r"nao se pronunci\w*.{0,30}pela inconstitucionalidade", " ", d)
    if re.search(r"declara.{0,40}(inconstitucionalidade|ilegalidade).{0,80}forca obrigatoria geral", d_pos):
        outs.append("Declarada inconstitucionalidade/ilegalidade com força obrigatória geral")
    if re.search(r"pronunci\w*.{0,30}pela inconstitucionalidade", d_pos):
        outs.append("Pronúncia pela inconstitucionalidade (preventiva)")
    if neg_pron:
        outs.append("Sem pronúncia de inconstitucionalidade")
    if re.search(r"nao declara.{0,30}(inconstitucionalidade|ilegalidade)", d):
        outs.append("Não declarada a inconstitucionalidade")
    if re.search(r"(?<!nao )julga.{0,30}inconstitucional", d):
        outs.append("Julgada inconstitucional")
    if re.search(r"nao tom\w+ conhecimento", d):
        outs.append("Não tomou conhecimento")
    outs = list(dict.fromkeys(outs))
    if len(outs) > 1:
        return "Decisão mista (várias normas/pedidos)"
    return outs[0] if outs else None


def tc_detail(url_html, especie_tipo):
    num = url_html.rsplit("/", 1)[-1]
    h = fetch(url_html, f"tc/d/{num}", max_age=None)
    if not h:
        return None, None, None
    body = h[h.find("ACÓRDÃO"):] if "ACÓRDÃO" in h else h
    text = strip_tags(re.sub(r"<script.*?</script>|<style.*?</style>", "", body, flags=re.S))
    text = text.split("Mapa do site |")[0]
    dec = clean_decision(text)
    # norms under review: first sentence mentioning "norma(s)" in the decision
    m = re.search(r"((?:a )?norma[s]?[^.]{20,400}\.)", dec)
    norma = m.group(1).strip() if m else None
    return tc_outcome(dec), (norma[:400] if norma else None), dec[:900]


def ingest_tc(con):
    urls = tc_listing_urls()
    print("  TC listing pages:", len(urls))
    n = 0
    for u in urls:
        name = u.rsplit("/", 1)[-1] or "index.html"
        h = fetch(u, f"tc/l/{name}", max_age=(2 * 86400 if name.startswith(("2025", "2026")) or name == "index.html" else None))
        if not h:
            continue
        for m in TC_ROW.finditer(h):
            code, label, proc, form, esp, dt, rel = [html.unescape(x).strip() for x in m.groups()]
            year, num = int(code[:4]), int(code[4:])
            d = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", dt)
            iso = f"{d.group(3)}-{d.group(2)}-{d.group(1)}" if d else None
            rel = re.sub(r"^Cons\.\s*", "", rel)
            con.execute("""INSERT OR REPLACE INTO tc_acordaos(id, year, num, processo, formacao, especie, tipo, data, relator, url, source_url)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?) """,
                        (f"{year}/{num}", year, num, proc, form, esp, tc_tipo(esp), iso, rel or None, f"{TC_BASE}{code}.html", u))
            n += 1
    con.commit()
    print("  TC acórdãos listed:", n)
    # full text only for abstract control, referendum, omission, conflicts (few per year); concrete appeals / reclamações are bulk
    deep = ("Fiscalização preventiva", "Fiscalização sucessiva abstrata", "Inconstitucionalidade por omissão", "Referendo", "Conflito")
    cap = int(os.environ.get("JUSTICA_TC_DETAIL_MAX", "2500"))
    rows = con.execute(f"SELECT id, url, tipo FROM tc_acordaos WHERE tipo IN ({','.join('?' * len(deep))}) AND resultado IS NULL ORDER BY year DESC, num DESC LIMIT ?", (*deep, cap)).fetchall()
    print("  TC details to read:", len(rows))
    for i, (aid, url, tipo) in enumerate(rows):
        res, norma, sumario = tc_detail(url, tipo)
        if sumario is not None:
            con.execute("UPDATE tc_acordaos SET resultado=?, norma=?, sumario=? WHERE id=?", (res or "(não classificado)", norma, sumario, aid))
        if i % 50 == 0:
            con.commit()
            print("   ..", i, aid)
    con.commit()
    link_tc_dre(con)


def dre_outcome(summary):
    d = norm(summary)
    if re.search(r"declara.{0,30}(inconstitucionalidade|ilegalidade).{0,80}forca obrigatoria geral", d):
        return "Declarada inconstitucionalidade/ilegalidade com força obrigatória geral"
    if re.search(r"nao declara.{0,30}(inconstitucionalidade|ilegalidade)", d):
        return "Não declarada a inconstitucionalidade"
    if d.startswith("nao se pronuncia") or " nao se pronuncia pela inconstitucionalidade" in d:
        return "Sem pronúncia de inconstitucionalidade"
    if re.match(r"(pronuncia|pronunciar)", d):
        return "Pronúncia pela inconstitucionalidade (preventiva)"
    if re.search(r"julga.{0,30}inconstitucional", d):
        return "Julgada inconstitucional"
    return None


def link_tc_dre(con):
    """Link TC acórdãos to the Diário da República acts already loaded in data/dre.db (acts.kind 'Acórdão do Tribunal Constitucional';
    acts.number = 'N/YYYY' equals the TC number). The official DR summary supplies the dispositive part when the full text was not read."""
    try:
        dre = ro(ROOT / "data" / "dre.db")
        rows = dre.execute("SELECT id, number, summary FROM acts WHERE kind LIKE 'Acórdão do Tribunal Constitucional%'").fetchall()
    except Exception as e:
        print("  dre.db unavailable:", e)
        return
    linked = 0
    for r in rows:
        m = re.match(r"\s*(\d+)\s*/\s*(\d{4})", r["number"] or "")
        if not m:
            continue
        aid = f"{int(m.group(2))}/{int(m.group(1))}"
        summ = strip_tags(r["summary"] or "")[:600]
        cur = con.execute("UPDATE tc_acordaos SET dre_act_id=?, sumario=COALESCE(sumario, ?) WHERE id=?", (str(r["id"]), summ or None, aid))
        linked += cur.rowcount
        if cur.rowcount:
            o = dre_outcome(summ)
            if o:
                con.execute("UPDATE tc_acordaos SET resultado=? WHERE id=? AND (resultado IS NULL OR resultado LIKE '(%')", (o, aid))
    con.commit()
    print("  DRE TC acts:", len(rows), "linked:", linked)


# --------------------------------------------------------------------------- Tribunal de Contas
TC_REPORTS = [  # (index page, category, group label)
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosAuditoria/Pages/Anos.aspx", "relatorio", "Auditoria"),
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosAcompanhamento/Pages/Anos.aspx", "relatorio", "Acompanhamento"),
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosAcompanhamentoExecucaoOrcamental/Pages/Anos.aspx", "relatorio", "Execução orçamental"),
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosApuramentoResponsabilidades/Pages/Anos.aspx", "relatorio", "Apuramento de responsabilidades"),
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosVerificacaoExternaContas/Pages/Anos.aspx", "relatorio", "Verificação externa de contas"),
    ("/pt-pt/ProdutosTC/Relatorios/RelatoriosVerificacaoInternaContas/Pages/Anos.aspx", "relatorio", "Verificação interna de contas"),
    ("/pt-pt/ProdutosTC/acordaos/1spl/Paginas/acordaos-1spl.aspx", "acordao", "1.ª Secção em Plenário (recursos de visto)"),
    ("/pt-pt/ProdutosTC/acordaos/1sss/Paginas/acordaos-1ss.aspx", "acordao", "1.ª Secção em Subsecção (visto)"),
    ("/pt-pt/ProdutosTC/acordaos/2s/Pages/acordaos-2s.aspx", "acordao", "2.ª Secção"),
    ("/pt-pt/ProdutosTC/acordaos/3s/Paginas/acordaos-3s.aspx", "acordao", "3.ª Secção (responsabilidades financeiras)"),
    ("/pt-pt/ProdutosTC/acordaos/pg/Pages/acordaos-pg.aspx", "acordao", "Plenário Geral"),
    ("/pt-pt/ProdutosTC/acordaos/pg-rcj/Pages/acordaos-pg-rcj.aspx", "acordao", "Plenário Geral (recursos)"),
]
ITEM = re.compile(r"<div class=\"tc-item\">\s*<article>(.*?)</article>", re.S)


class EntityMatcher:
    """Match free-text titles/entity strings to the registry (data/politica.db `entities`) by normalised name."""

    def __init__(self):
        pol = ro(ROOT / "data" / "politica.db")
        self.by = {}
        for r in pol.execute("SELECT id, nif, name, kind, buyer_value FROM entities WHERE nif IS NOT NULL AND is_public=1"):
            if r["kind"] == "freguesia":
                continue                      # bare place names are ambiguous (e.g. Santo Espírito, Ponta Delgada)
            k = self.key(r["name"])
            if r["kind"] == "municipio" and not k.startswith("municipio de"):
                k = "municipio de " + k       # municipalities only match with an explicit prefix
                self.by["camara municipal de " + k[len("municipio de "):]] = (r["id"], r["nif"], r["name"], r["buyer_value"] or 0)
            if len(k) >= 8 and (k not in self.by or (r["buyer_value"] or 0) > self.by[k][3]):
                self.by[k] = (r["id"], r["nif"], r["name"], r["buyer_value"] or 0)
        for k in list(self.by):
            if k.startswith("municipio de "):
                self.by.setdefault("camara municipal de " + k[len("municipio de "):], self.by[k])
        for bad in [k for k in self.by if re.match(r"(seccao regional|regiao autonoma|tribunal de contas|direcao geral do tribunal de contas)", k)]:
            del self.by[bad]
        self.maxw = 9
        self.regional = {"da madeira", "dos acores", "ram", "raa", "da ram", "da raa", "regiao autonoma"}

    @staticmethod
    def key(name):
        k = norm(name)
        k = re.sub(r"\b(e p e|epe|s a|sa|i p|ip|e m|em|lda|crl|c r l)\b", " ", k)
        return re.sub(r"\s+", " ", k).strip()

    def match(self, text):
        """Return (entity tuple, method) using the longest registry name found as a whole-word substring of the text."""
        if not text:
            return None, None
        k = self.key(text)
        if k in self.by:
            return self.by[k], "nome exato"
        words = k.split()
        best = None
        for i in range(len(words)):
            for j in range(min(len(words), i + self.maxw), i + 1, -1):
                cand = " ".join(words[i:j])
                e = self.by.get(cand)
                if e and (best is None or len(cand) > len(best[0])):
                    nxt = " ".join(words[j:j + 2])
                    if any(nxt == r or nxt.startswith(r + " ") for r in self.regional):
                        continue             # e.g. "Instituto da Segurança Social da Madeira" is not the national institute
                    best = (cand, e)
        return (best[1], "nome no título") if best else (None, None)


def tcontas_years(index_path):
    h = fetch(TCONTAS + index_path, "tcontas/idx_" + norm(index_path).replace(" ", "_")[:80] + ".html", max_age=3 * 86400)
    if not h:
        return []
    pairs = re.findall(r"href=['\"]([^'\"]*detalhe\.aspx\?dset=(\d{4}))['\"]", h)
    seen = {}
    for href, y in pairs:
        seen[y] = href
    return sorted(seen.items(), reverse=True)


def result_from_title(titulo, desc):
    t = norm(desc)
    return None


def ingest_tcontas(con):
    matcher = EntityMatcher()
    kept = dict(con.execute("SELECT id, resultado FROM tcontas_docs WHERE resultado IS NOT NULL").fetchall())
    con.execute("DELETE FROM tcontas_docs")
    total = 0
    for index_path, cat, group in TC_REPORTS:
        years = tcontas_years(index_path)
        print(f"  TdC {group}: {len(years)} years")
        for y, href in years:
            url = href if href.startswith("http") else TCONTAS + href
            h = fetch(url, f"tcontas/{norm(group).replace(' ', '_')}_{y}.html", max_age=(3 * 86400 if int(y) >= 2025 else None))
            if not h:
                continue
            for m in ITEM.finditer(h):
                art = m.group(1)
                a = re.search(r"<h4><a [^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a></h4>", art, re.S)
                if not a:
                    continue
                pdf = urllib.parse.urljoin(TCONTAS, html.unescape(a.group(1)))
                head = [strip_tags(x) for x in re.split(r"<br\s*/?>", a.group(2))]
                desc = strip_tags(re.search(r"</header>\s*<p>(.*?)</p>", art, re.S).group(1)) if re.search(r"</header>\s*<p>(.*?)</p>", art, re.S) else ""
                pub = re.search(r'tc-date">\s*<span>([^<]+)</span>', art)
                tipo = re.search(r'tc-info">\s*([^<]+?)\s*</span>', art)
                numero = next((x for x in head if re.search(r"n\s*[º°o]\s*\d", x, re.I)), head[0] if head else "")
                dm = re.search(r"de (\d{4}-\d{2}-\d{2})", " ".join(head))
                titulo_ref = " - ".join(x for x in head if x)
                ent = None
                method = None
                # acórdãos: description is the entity; reports: entity is named in the title
                for part in [desc] + re.split(r"\s+[–—-]\s+|\s*[:“”\"]\s*", desc)[::-1]:
                    ent, method = matcher.match(part) if part and len(part) > 6 else (None, None)
                    if ent:
                        break
                did = re.sub(r"\W+", "_", pdf.split("/ProdutosTC/")[-1])[:160]
                con.execute("INSERT OR REPLACE INTO tcontas_docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (did, cat, group, int(y), titulo_ref, numero, dm.group(1) if dm else None,
                             pub.group(1).replace(".", "-") if pub else None, desc, tipo.group(1).strip() if tipo else None, None,
                             desc if cat == "acordao" else None, ent[0] if ent else None, ent[1] if ent else None, method, pdf, url))
                total += 1
        con.commit()
    con.executemany("UPDATE tcontas_docs SET resultado=? WHERE id=?", [(v, k) for k, v in kept.items()])
    print("  TdC docs:", total, "with entity:", con.execute("SELECT COUNT(*) FROM tcontas_docs WHERE entity_id IS NOT NULL").fetchone()[0])
    visto_outcomes(con)


def visto_outcomes(con):
    """Read the (short) 1.ª Secção acórdãos de visto PDFs and classify the decision (concessão / recusa). Only the decision keyword is kept."""
    if not Path("/usr/bin/pdftotext").exists():
        return
    rows = con.execute("SELECT id, pdf_url FROM tcontas_docs WHERE categoria='acordao' AND grupo LIKE '1.%' AND resultado IS NULL ORDER BY year DESC LIMIT ?",
                       (int(os.environ.get("JUSTICA_TDC_PDF_MAX", "400")),)).fetchall()
    print("  TdC visto PDFs to classify:", len(rows))
    for i, (did, url) in enumerate(rows):
        data = fetch(url, "tcontas/pdf/" + did[-120:] + ".pdf", binary=True)
        if not data or not data.startswith(b"%PDF"):
            continue
        p = RAW / "tcontas" / "pdf" / (did[-120:] + ".pdf")
        try:
            txt = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, timeout=60).stdout.decode("utf-8", "replace")
        except Exception:
            continue
        t = norm(re.sub(r"\s+", " ", txt))
        tail = t[-3500:]
        res = None
        if re.search(r"recusa(r)? o visto|recusar o visto|recusa de visto|recusam o visto|recusa-se o visto", tail):
            res = "Recusa de visto"
        elif re.search(r"conceder o visto|concede o visto|concedem o visto|concessao do visto|conceder visto|concedendo o visto|conceder-se o visto", tail):
            res = "Concessão de visto"
        elif re.search(r"negar provimento|nega provimento|negam provimento|nao provimento", tail):
            res = "Recurso sem provimento"
        elif re.search(r"conceder provimento|concede provimento|concedem provimento|dar provimento", tail):
            res = "Recurso provido"
        if res:
            con.execute("UPDATE tcontas_docs SET resultado=? WHERE id=?", (res, did))
        if i % 50 == 0:
            con.commit()
    con.commit()


# --------------------------------------------------------------------------- main
def main():
    RAW.mkdir(parents=True, exist_ok=True)
    only = set((os.environ.get("JUSTICA_ONLY") or "registry,ine,tc,tcontas").split(","))
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    if "registry" in only:
        print("registry")
        build_registry(con)
    if "ine" in only:
        print("ine")
        ingest_ine(con)
    if "tc" in only:
        print("tc")
        ingest_tc(con)
    if "tcontas" in only:
        print("tcontas")
        ingest_tcontas(con)
    con.execute("DELETE FROM blocked")
    empty = [g for g in ("2.ª Secção", "Plenário Geral") if not con.execute("SELECT 1 FROM tcontas_docs WHERE grupo=? LIMIT 1", (g,)).fetchone()]
    con.executemany("INSERT INTO blocked VALUES (?,?)", [
        (f"tcontas.pt — acórdãos {g}", "A listagem anual devolve 0 documentos; não há acórdãos desta secção na base.") for g in empty])
    con.executemany("INSERT INTO blocked VALUES (?,?)", [
        ("DGPJ — Estatísticas da Justiça (estatisticas.justica.gov.pt / apiestatisticas.justica.gov.pt)",
         "O portal é uma aplicação Blazor/Power BI sem dados em HTML, e a API de dados abertos anunciada no dados.gov.pt (apiestatisticas.justica.gov.pt/OpenData/…) responde 404 em todos os conjuntos testados. "
         "Usam-se as séries que o INE republica a partir da DGPJ: movimento de processos só a nível nacional; duração média e evolução anual dos processos por comarca (2015–2025). Não há entrados/findos/pendentes por comarca nem por tribunal."),
        ("Tribunal Constitucional — estatísticas oficiais", "A página de estatísticas do TC não tem dados no HTML; contagens são calculadas a partir da lista de acórdãos."),
        ("csm.org.pt / ministeriopublico.pt — decisões e mapas", "Sem dados estruturados descarregáveis encontrados; só se listam os órgãos e as ligações oficiais."),
    ])
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    for t in ("orgaos", "tribunais", "mj_bodies", "stats_series", "tc_acordaos", "tcontas_docs"):
        print(" ", t, con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
