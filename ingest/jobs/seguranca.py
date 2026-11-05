"""Seguranca interna, protecao civil e defesa -> data/seguranca.db.

What is ingested (public, no login; robots.txt respected; >=1 s between requests to the same host):
  * INE json_indicador API (www.ine.pt; its robots.txt is a 404 = no restrictions): crimes registered by the police
    (by category, NUTS/concelho), crime rate, rural fires (number, burned area), road accidents with victims and
    victims by severity, fire brigades (corpos, personnel, services rendered, finances) - Portugal / NUTS / concelhos.
    Sources behind INE: DGPJ/SGSI (crime), ICNF (fires), ANSR (road), ANEPC (brigades).
  * orgaos: curated list of the security / civil-protection / defence bodies, with the official website, linked to the
    portal registry (data/politica.db) by NIF only when the name matches an existing entity.
  * bombeiros: fire brigades (mostly "Associacao Humanitaria de Bombeiros Voluntarios") present in the portal registry
    (entities with "bombeiro" in the name), placed in a concelho only when the name unambiguously gives it
    (concelho name, or a freguesia of the registry that belongs to exactly one concelho). Not the official ANEPC
    list: prociv.pt was unreachable when this job was written.
Procurement is NOT copied: the server joins live against politica.db / ministerios.db.

Run: python3 ingest/run_all.py seguranca      (SEGURANCA_STEPS=ine,orgaos,bombeiros to run a subset)
"""
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
from common import ROOT  # noqa: E402

NAME = "seguranca"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
POLITICA = ROOT / "data" / "politica.db"
AUTARQUIAS = ROOT / "data" / "autarquias.db"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 politica-pt/0.1"
INE_URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={v}&Dim1=T&lang=PT"
INE_META = "https://www.ine.pt/bddXplorer/htdocs/minfo.jsp?var_cd={v}&lingua=PT"

# (varcd, short label, family, upstream source named by INE)
INE_IND = [
    ("0012261", "Crimes registados pelas autoridades policiais (por categoria)", "crime", "DGPJ/SGSI (via INE)"),
    ("0012260", "Taxa de criminalidade (‰, por categoria)", "crime", "DGPJ/SGSI (via INE)"),
    ("0008073", "Crimes registados pelas autoridades policiais (série NUTS 2013, até 2022)", "crime", "DGPJ/SGSI (via INE)"),
    ("0008074", "Taxa de criminalidade (‰, série NUTS 2013, até 2022)", "crime", "DGPJ/SGSI (via INE)"),
    ("0010714", "Crimes de homicídio voluntário consumado", "crime", "DGPJ/SGSI (via INE)"),
    ("0013509", "Incêndios rurais (n.º)", "incendios", "ICNF (via INE)"),
    ("0013510", "Superfície ardida (ha)", "incendios", "ICNF (via INE)"),
    ("0013514", "Incêndios rurais por dimensão do incêndio", "incendios", "ICNF (via INE)"),
    ("0013511", "Incêndios rurais com duração superior a 24 horas", "incendios", "ICNF (via INE)"),
    ("0013538", "Proporção de superfície ardida (% do território)", "incendios", "ICNF (via INE)"),
    ("0012774", "Acidentes de viação com vítimas (n.º)", "rodoviario", "ANSR (via INE)"),
    ("0012775", "Vítimas de acidentes de viação (n.º, por gravidade)", "rodoviario", "ANSR (via INE)"),
    ("0012776", "Índice de gravidade dos acidentes de viação com vítimas", "rodoviario", "ANSR (via INE)"),
    ("0008639", "Acidentes de viação com vítimas (série NUTS 2013)", "rodoviario", "ANSR (via INE)"),
    ("0008640", "Vítimas de acidentes de viação (série NUTS 2013, por gravidade)", "rodoviario", "ANSR (via INE)"),
    ("0007989", "Acidentes de viação com vítimas por natureza (série NUTS 2013, até 2024)", "rodoviario", "ANSR (via INE)"),
    ("0013372", "Corpos de bombeiros (n.º)", "bombeiros", "ANEPC (via INE)"),
    ("0013371", "Bombeiros (n.º)", "bombeiros", "ANEPC (via INE)"),
    ("0013370", "Serviços prestados pelos corpos de bombeiros (n.º)", "bombeiros", "ANEPC (via INE)"),
    ("0013369", "Investimentos, gastos e rendimentos das entidades detentoras de corpos de bombeiros (€)", "bombeiros", "ANEPC (via INE)"),
]

# Curated bodies: (sigla, name, group, tutela slug in ministerios.db, website, description, [registry name patterns])
ORGAOS = [
    ("PSP", "Polícia de Segurança Pública", "forca_seguranca", "administracao-interna", "https://www.psp.pt/", "Força de segurança, de natureza civil e uniformizada, com competência sobretudo em meio urbano.", ["Polícia de Segurança Pública"]),
    ("GNR", "Guarda Nacional Republicana", "forca_seguranca", "administracao-interna", "https://www.gnr.pt/", "Força de segurança de natureza militar, com competência sobretudo em meio rural e na rede viária.", ["Guarda Nacional Republicana"]),
    ("PJ", "Polícia Judiciária", "investigacao", "justica", "https://www.policiajudiciaria.pt/", "Órgão de polícia criminal auxiliar da administração da justiça, sob a tutela do Ministério da Justiça.", ["Polícia Judiciária"]),
    ("AIMA", "Agência para a Integração, Migrações e Asilo", "imigracao", "administracao-interna", "https://aima.gov.pt/", "Sucedeu em 2023 às funções administrativas do SEF (Serviço de Estrangeiros e Fronteiras).", ["Agência para a Integração, Migrações e Asilo"]),
    ("ANEPC", "Autoridade Nacional de Emergência e Proteção Civil", "protecao_civil", "administracao-interna", "https://prociv.gov.pt/", "Coordena a proteção civil, a Força Especial de Proteção Civil e o dispositivo de socorro dos bombeiros.", ["AUTORIDADE NACIONAL DE EMERGÊNCIA E PROTEÇÃO CIVIL"]),
    ("INEM", "Instituto Nacional de Emergência Médica", "emergencia", "saude", "https://www.inem.pt/", "Coordena o Sistema Integrado de Emergência Médica (112, ambulâncias, VMER, helicópteros).", ["Instituto Nacional de Emergência Médica"]),
    ("EMGFA", "Estado-Maior-General das Forças Armadas", "forca_armada", "defesa-nacional", "https://www.emgfa.pt/", "Órgão superior de comando das Forças Armadas sob o Chefe do Estado-Maior-General.", ["Estado-Maior-General das Forças Armadas"]),
    ("Exército", "Exército Português", "forca_armada", "defesa-nacional", "https://www.exercito.pt/", "Ramo terrestre das Forças Armadas (contratação via Estado-Maior do Exército).", ["Estado-Maior do Exército"]),
    ("Marinha", "Marinha Portuguesa", "forca_armada", "defesa-nacional", "https://www.marinha.pt/", "Ramo naval das Forças Armadas; integra a Autoridade Marítima Nacional e a Polícia Marítima.", ["Ministério da Defesa Nacional - Marinha"]),
    ("Força Aérea", "Força Aérea Portuguesa", "forca_armada", "defesa-nacional", "https://www.emfa.pt/", "Ramo aéreo das Forças Armadas (contratação via Estado-Maior da Força Aérea).", ["Estado Maior da Força Aérea"]),
    ("Polícia Marítima", "Polícia Marítima (Autoridade Marítima Nacional)", "forca_seguranca", "defesa-nacional", "https://www.amn.pt/", "Força policial da Autoridade Marítima Nacional, integrada na Marinha; as compras constam da Marinha.", []),
    ("ASAE", "Autoridade de Segurança Alimentar e Económica", "fiscalizacao", "economia-e-coesao-territorial", "https://www.asae.gov.pt/", "Fiscalização da segurança alimentar e da atividade económica; órgão de polícia criminal.", ["Autoridade de Segurança Alimentar e Económica"]),
    ("ANSR", "Autoridade Nacional de Segurança Rodoviária", "fiscalizacao", "administracao-interna", "https://www.ansr.pt/", "Planeamento e coordenação da segurança rodoviária e processamento das contraordenações rodoviárias.", ["Autoridade Nacional de Segurança Rodoviária"]),
    ("IGAI", "Inspeção-Geral da Administração Interna", "inspecao", "administracao-interna", "https://www.igai.pt/", "Inspeção e auditoria das forças e serviços de segurança e proteção civil.", ["Inspeção-Geral da Administração Interna"]),
    ("SGSI", "Secretário-Geral do Sistema de Segurança Interna", "coordenacao", "administracao-interna", "https://www.sg.mai.gov.pt/", "Coordenação do Sistema de Segurança Interna; publica o Relatório Anual de Segurança Interna (RASI).", ["Sistema de Segurança Interna"]),
    ("SG-MAI", "Secretaria-Geral do Ministério da Administração Interna", "coordenacao", "administracao-interna", "https://www.sg.mai.gov.pt/", "Serviço central de apoio do MAI; faz compras partilhadas para as forças de segurança.", ["Secretaria-Geral do Ministério da Administração Interna"]),
    ("AGIF", "Agência para a Gestão Integrada de Fogos Rurais", "protecao_civil", "administracao-interna", "https://www.agif.pt/", "Coordena o Sistema de Gestão Integrada de Fogos Rurais (SGIFR).", ["Agência para a Gestão Integrada de Fogos Rurais"]),
    ("ICNF", "Instituto da Conservação da Natureza e das Florestas", "outro", "agricultura-e-mar", "https://www.icnf.pt/", "Fonte oficial das estatísticas de incêndios rurais e da cartografia de áreas ardidas. A contratação é sobretudo de gestão florestal e conservação da natureza, por isso não entra nos totais de proteção civil.", ["Instituto da Conservação da Natureza e das Florestas"]),
    ("SIRESP", "SIRESP - Gestão de Redes Digitais de Segurança e Emergência", "emergencia", "administracao-interna", "https://www.siresp.com/", "Rede nacional de comunicações de emergência e segurança (sociedade com capitais públicos e privados).", ["SIRESP"]),
    ("DGRSP", "Direção-Geral de Reinserção e Serviços Prisionais", "outro", "justica", "https://dgrsp.justica.gov.pt/", "Estabelecimentos prisionais e reinserção social (apenas contratação aqui; ver módulo Justiça).", ["Direção-Geral de Reinserção e Serviços Prisionais"]),
    ("DGRDN", "Direção-Geral de Recursos da Defesa Nacional", "defesa", "defesa-nacional", "https://www.dgrdn.gov.pt/", "Serviço central do MDN responsável por aquisições e infraestruturas da defesa.", ["Direção-Geral de Recursos da Defesa Nacional"]),
    ("IDN", "Instituto da Defesa Nacional", "defesa", "defesa-nacional", "https://www.idn.gov.pt/", "Formação e investigação em segurança e defesa.", ["Instituto da Defesa Nacional"]),
    ("IH", "Instituto Hidrográfico", "defesa", "defesa-nacional", "https://www.hidrografico.pt/", "Laboratório do Estado na tutela da Marinha (hidrografia, cartografia náutica, oceanografia).", ["Instituto Hidrográfico"]),
    ("ENB", "Escola Nacional de Bombeiros", "protecao_civil", "administracao-interna", "https://www.enb.pt/", "Formação de bombeiros e agentes de proteção civil.", ["Escola Nacional de Bombeiros"]),
    ("SRPC-RAM", "Serviço Regional de Proteção Civil, IP-RAM", "protecao_civil", None, "https://www.procivmadeira.pt/", "Proteção civil da Região Autónoma da Madeira.", ["Serviço Regional de Proteção Civil, IP-RAM"]),
    ("SRPCBA", "Serviço Regional de Proteção Civil e Bombeiros dos Açores", "protecao_civil", None, "https://www.azores.gov.pt/", "Proteção civil e bombeiros da Região Autónoma dos Açores.", ["Serviço Regional de Protecção Civil e de Bombeiros dos Açores"]),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ine_series (
  indicator TEXT, label TEXT, family TEXT, unit TEXT, geo_code TEXT, geo_name TEXT, level TEXT, dico TEXT,
  dim TEXT, year INTEGER, value REAL, flag TEXT, upstream TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS ise_ind ON ine_series(indicator, level, year);
CREATE INDEX IF NOT EXISTS ise_dico ON ine_series(dico, indicator, year);
CREATE INDEX IF NOT EXISTS ise_fam ON ine_series(family, level);
CREATE TABLE IF NOT EXISTS orgaos (
  sigla TEXT PRIMARY KEY, name TEXT, grp TEXT, tutela TEXT, website TEXT, description TEXT,
  entity_id INTEGER, nif TEXT, match_method TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS bombeiros (
  entity_id INTEGER PRIMARY KEY, nif TEXT, name TEXT, tipo TEXT, dico TEXT, concelho TEXT, match_method TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS bomb_dico ON bombeiros(dico);
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


def get(url, cache, ttl_days=20, timeout=240, wait=1.3):
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
            if b'"Sucesso"' in tmp.read_bytes()[:400]:  # INE transient DB error -> retry
                raise RuntimeError("INE devolveu erro transitório")
            tmp.replace(cache)
            return cache
        except Exception as e:  # noqa: BLE001
            last = e
            _last[host] = time.time()
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def strip(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# ------------------------------------------------------------------ INE
def step_ine(con):
    total = 0
    for v, label, fam, upstream in INE_IND:
        url = INE_URL.format(v=v)
        try:
            f = get(url, f"ine_all_{v}.json", ttl_days=25)
            d = json.loads(f.read_text(encoding="utf-8"))
            d = d[0] if isinstance(d, list) else d
        except Exception as e:  # noqa: BLE001
            log("  INE falhou", v, str(e)[:120])
            continue
        dsg = d.get("IndicadorDsg", "")
        m = re.search(r"\(([^)]*)\)", dsg)
        unit = m.group(1) if m else ""
        src = INE_META.format(v=v)
        rows = []
        for period, recs in (d.get("Dados") or {}).items():
            if not re.match(r"^\d{4}", period):
                continue
            for x in recs:
                g = x.get("geocod", "")
                if g == "PT":
                    lvl, dico = "PT", None
                elif len(g) == 7:
                    lvl, dico = "concelho", g[-4:]
                elif len(g) in (1, 2, 3):
                    lvl, dico = {1: "area", 2: "nuts2", 3: "nuts3"}[len(g)], None
                else:
                    continue
                try:
                    val = float(x.get("valor"))
                except (TypeError, ValueError):
                    continue
                dims = " / ".join(x[k] for k in sorted(x) if re.fullmatch(r"dim_\d+_t", k) and x[k])
                rows.append((v, label, fam, unit, g, x.get("geodsg"), lvl, dico, dims, int(period[:4]), val,
                             x.get("sinal_conv_desc") or None, upstream, src))
        con.execute("DELETE FROM ine_series WHERE indicator=?", (v,))
        for i in range(0, len(rows), 5000):
            con.executemany("INSERT INTO ine_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows[i:i + 5000])
            con.commit()
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", ("ine_desc_" + v, dsg + " | atualizado " + str(d.get("DataUltimoAtualizacao"))))
        con.commit()
        total += len(rows)
        log("  INE", v, label[:60], len(rows), "linhas", dsg[:80])
    con.execute("INSERT OR REPLACE INTO meta VALUES ('ine_rows', ?)", (str(total),))
    con.commit()


# ------------------------------------------------------------------ registry helpers
def registry():
    p = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True, timeout=60)
    p.row_factory = sqlite3.Row
    return p


def step_orgaos(con):
    p = registry()
    for sigla, name, grp, tutela, site, desc, pats in ORGAOS:
        eid = nif = meth = None
        for pat in pats:
            r = p.execute("SELECT id, nif, name FROM entities WHERE name LIKE ? ORDER BY buyer_value DESC LIMIT 1", ("%" + pat + "%",)).fetchone()
            if r:
                eid, nif, meth = r["id"], r["nif"], "nome: " + r["name"]
                break
        con.execute("INSERT OR REPLACE INTO orgaos VALUES (?,?,?,?,?,?,?,?,?,?)", (sigla, name, grp, tutela, site, desc, eid, nif, meth, site))
        log("  orgao", sigla, nif or "sem NIF no registo")
    con.commit()
    p.close()


def step_bombeiros(con):
    p = registry()
    mun = []
    if AUTARQUIAS.exists():
        a = sqlite3.connect(f"file:{AUTARQUIAS}?mode=ro", uri=True, timeout=60)
        mun = a.execute("SELECT dico, name FROM municipios").fetchall()
        a.close()
    else:
        log("  autarquias.db em falta")
    by_name = {}
    for dico, nm in mun:
        by_name.setdefault(strip(nm), []).append((dico, nm))
    # freguesia name -> set of concelhos (via parent municipio entity -> dico)
    fmap = {}
    for r in p.execute("""SELECT f.name fn, m.name mn, m.dico md FROM entities f JOIN entities m ON m.id=f.parent_id
                          WHERE f.kind='freguesia' AND m.kind='municipio'"""):
        mm = by_name.get(strip(re.sub(r"^(municipio|camara municipal) (de|da|do)\s+", "", strip(r["mn"]))))
        if not mm or len(mm) != 1:
            continue
        n = strip(re.sub(r"^(uniao das freguesias de|uniao de freguesias de|freguesia de|freguesia da|freguesia do|freguesia)\s+", "", strip(r["fn"])))
        if len(n) >= 5:
            fmap.setdefault(n, set()).add(mm[0])

    def locate(nm):
        s = strip(nm)
        s = re.sub(r"\b(a ?h|associacao humanitaria|associacao|humanitaria|bombeiros|bombeiro|voluntarios|voluntario|mistos|misto|sapadores|dos|das|do|da|de|corpo|concelho|federacao|distrito)\b", " ", s)
        s = re.sub(r"\s+", " ", s).strip()
        if not s:
            return None
        if s in by_name and len(by_name[s]) == 1:
            return by_name[s][0], "nome=concelho"
        if s in fmap and len(fmap[s]) == 1:
            d, n = next(iter(fmap[s]))
            return (d, n), "nome=freguesia do concelho"
        return None

    rows = p.execute("""SELECT id, nif, name, kind FROM entities WHERE name LIKE '%ombeiro%' AND kind IN ('seguranca_defesa','terceiro_setor','empresa_ou_particular','outra_entidade')""").fetchall()
    n = hit = 0
    con.execute("DELETE FROM bombeiros")
    have = {strip(r["name"]) for r in rows if r["nif"]}
    for r in rows:
        if not r["nif"] and strip(r["name"]) in have:
            continue  # duplicate record of an entity already present with a NIF
        low = strip(r["name"])
        if re.search(r"\b(servicos sociais|escola nacional|liga dos bombeiros|cofre)\b", low) and "voluntarios" not in low:
            continue
        if not re.search(r"\bbombeiros?\b", low):
            continue
        if re.search(r"\b(federacao|liga)\b", low):
            tipo = "federacao"
        elif re.search(r"\b(sapadores|municipal|municipais)\b", low):
            tipo = "municipal"
        elif re.search(r"\b(a ?h|humanitaria|voluntarios|voluntario|mistos|misto)\b", low):
            tipo = "associacao"
        else:
            tipo = "outro"
        loc = locate(r["name"]) if tipo != "federacao" else None
        dico = nm = meth = None
        if loc:
            (dico, nm), meth = loc
            hit += 1
        con.execute("INSERT OR REPLACE INTO bombeiros VALUES (?,?,?,?,?,?,?,?)",
                    (r["id"], r["nif"], r["name"], tipo, dico, nm, meth, "https://www.base.gov.pt/ (registo de entidades do portal)"))
        n += 1
    # records without NIF are mostly alternative spellings of an entity that already has one: drop them when the
    # same concelho already has a brigade association with NIF (conservative; may hide a second real corporation)
    cur = con.execute("""DELETE FROM bombeiros WHERE nif IS NULL AND dico IS NOT NULL AND tipo = 'associacao'
                         AND dico IN (SELECT dico FROM bombeiros WHERE nif IS NOT NULL AND dico IS NOT NULL AND tipo = 'associacao')""")
    n -= cur.rowcount
    hit -= cur.rowcount
    con.commit()
    con.execute("INSERT OR REPLACE INTO meta VALUES ('bombeiros_total', ?)", (str(n),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('bombeiros_com_concelho', ?)", (str(hit),))
    con.commit()
    log("  bombeiros", n, "com concelho", hit)
    p.close()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    steps = os.environ.get("SEGURANCA_STEPS", "orgaos,bombeiros,ine").split(",")
    if "orgaos" in steps:
        log("== orgaos"); step_orgaos(con)
    if "bombeiros" in steps:
        log("== bombeiros"); step_bombeiros(con)
    if "ine" in steps:
        log("== ine"); step_ine(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d"),))
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
