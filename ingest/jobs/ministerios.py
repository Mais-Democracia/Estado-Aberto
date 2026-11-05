"""Ministérios do XXV Governo: liderança, gabinetes, tutela (órgãos tutelados), decisões do Conselho de Ministros, despesa contratada.

Escreve só em data/ministerios.db.  Lê (só leitura) data/politica.db: entities, contracts.

Fontes:
  * portugal.gov.pt/gc25 (Sitecore/Next.js): sitemap.xml -> páginas de ministro, secretários de Estado,
    nomeações (gabinetes, com Despacho DRE) e comunicados do Conselho de Ministros; o conteúdo vem em __NEXT_DATA__.
  * Wikidata (P749/P361/P137 -> item do ministério) para ligações de tutela explícitas.
  * Regras editoriais de tutela (nome do organismo / sector) aplicadas ao registo de entidades -- NÃO extraídas do
    texto das leis orgânicas (o Diário da República é inacessível por HTTP simples); marcadas method='regra'.
Bloqueado: listas de notícias por ministério (carregam via Sitecore Search com uri de página não público).
"""
import html
import json
import re
import sqlite3
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from html.parser import HTMLParser

from common import ROOT, UA

NAME = "ministerios"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
BASE = "https://portugal.gov.pt"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
SLEEP = 0.7

# (slug no portugal.gov.pt, nome, sigla, slug nomeações)
MINISTRIES = [
    ("presidencia", "Presidência do Conselho de Ministros", "PCM", "presidencia"),
    ("negocios-estrangeiros", "Negócios Estrangeiros", "MNE", "negocios-estrangeiros"),
    ("financas", "Finanças", "MF", "financas"),
    ("economia-e-coesao-territorial", "Economia e Coesão Territorial", "MECT", "economia-e-coesao-territorial"),
    ("reforma-do-estado", "Reforma do Estado", "MRE", "adjunto-e-da-reforma-do-estado"),
    ("assuntos-parlamentares", "Assuntos Parlamentares", "MAP", "assuntos-parlamentares"),
    ("defesa-nacional", "Defesa Nacional", "MDN", "ministro-da-defesa-nacional"),
    ("administracao-interna", "Administração Interna", "MAI", "ministro-da-administracao-interna"),
    ("justica", "Justiça", "MJ", "ministra-da-justica"),
    ("educacao-ciencia-e-inovacao", "Educação, Ciência e Inovação", "MECI", "educacao-ciencia-e-inovacao"),
    ("saude", "Saúde", "MS", "ministra-da-saude"),
    ("trabalho-solidariedade-e-seguranca-social", "Trabalho, Solidariedade e Segurança Social", "MTSSS", "trabalho-solidariedade-e-seguranca-social"),
    ("infraestruturas-e-habitacao", "Infraestruturas e Habitação", "MIH", "infraestruturas-e-habitacao"),
    ("ambiente-e-energia", "Ambiente e Energia", "MAA", "ambiente-e-energia"),
    ("cultura-juventude-e-desporto", "Cultura, Juventude e Desporto", "MCJD", "cultura-juventude-e-desporto"),
    ("agricultura-e-mar", "Agricultura e Mar", "MAM", "agricultura-e-mar"),
]

# palavras-chave para atribuir decisões do Conselho de Ministros (heurística, ver página)
KEYWORDS = {
    "presidencia": r"imigra|asilo|\baima\b|comunicacao social|\brtp\b|\blusa\b|nacionalidade|secretaria-geral do governo|presidencia do conselho|\bamnistia",
    "negocios-estrangeiros": r"negocios estrangeiros|diplomat|embaixad|comunidades portuguesas|cooperacao para o desenvolvimento|\bcplp\b|camoes|consular",
    "financas": r"imposto|\birs\b|\birc\b|\biva\b|\biuc\b|fiscal|orcamento|tesouro|divida publica|autoridade tributaria|financas publicas|aduan|\bsns\b.*financ|funcao publica|\badse\b",
    "economia-e-coesao-territorial": r"turismo|comercio|industri|coesao|fundos europeus|portugal 2030|\bpt2030\b|\bpme\b|investimento|desenvolvimento regional|autarqu|administracao local|ordenamento do territorio|\bccdr\b|competitividade|recuperar portugal|\bprr\b|startup",
    "reforma-do-estado": r"reforma do estado|simplific|digitaliz|desburocrat|inteligencia artificial|\bama\b|\bgovtech|interoperabilidade",
    "assuntos-parlamentares": r"assuntos parlamentares|relacoes com a assembleia",
    "defesa-nacional": r"defesa nacional|forcas armadas|militar|exercito|marinha|forca aerea|\bnato\b|ciberdefesa|armamento",
    "administracao-interna": r"seguranca interna|\bgnr\b|\bpsp\b|policia|protecao civil|bombeiros|incendi|fogos rurais|administracao interna|\bsiresp\b|seguranca rodoviaria|fronteira|\bsef\b",
    "justica": r"justica|tribunal|tribunais|magistrad|prisional|prisoes|registos|notariad|codigo penal|codigo civil|processo penal|reinsercao|judiciar|insolvenc|\bmedicina legal",
    "educacao-ciencia-e-inovacao": r"\bescolas?\b|ensino|educacao|professor|docente|universidade|politecnic|ciencia|investigacao cientifica|\bfct\b|inovacao|estudantes|bolsas de estudo|alunos|propinas|ensino superior",
    "saude": r"\bsaude\b|\bsns\b|hospita|medicament|doentes|farmac|infarmed|enfermeir|utentes|medicos|\bulsl?\b|urgencias",
    "trabalho-solidariedade-e-seguranca-social": r"trabalho|seguranca social|pensoes|pensao|salario|emprego|laboral|sindica|solidariedade|desemprego|inclusao|deficiencia|idosos|\bifp\b|\biefp\b|subsidio",
    "infraestruturas-e-habitacao": r"ferrovi|aeroport|rodovia|transportes?\b|mobilidade|habitacao|arrendamento|\brendas?\b|construcao|obras publicas|estradas?\b|\bcasas\b|metro\b|\bimt\b|\bana\b|\bnav\b|alta velocidade|\bcp\b",
    "ambiente-e-energia": r"ambiente|energia|clima|\bagua\b|aguas|residuos|emissoes|renovave|eletric|gas natural|hidrogenio|biodiversidade|seca\b|carbono|\bapa\b|\bdgeg\b",
    "cultura-juventude-e-desporto": r"cultura|patrimonio|museu|juventude|desporto|cinema|teatro|\blivro|bibliotec|arquivo|jovens|olimpic|audiovisual|igualdade",
    "agricultura-e-mar": r"agricultur|agricola|florest|\bpescas?\b|\bmar\b|maritim|agroaliment|rural|aquicultura|oceano|vinho|\bpac\b|\bifap\b|portos? (de|da)",
}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("direccao", "direcao").replace("infra-estruturas", "infraestruturas").replace("protecção", "protecao")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


_last = {}


def fetch(url, cache=True, ua=BROWSER_UA):
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / (re.sub(r"[^A-Za-z0-9._-]+", "_", url)[-180:] + ".html")
    if cache and f.exists() and f.stat().st_size > 0:
        return f.read_text("utf-8")
    host = urllib.parse.urlparse(url).netloc
    wait = SLEEP - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    _last[host] = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "pt-PT,pt;q=0.9"})
    with urllib.request.urlopen(req, timeout=45) as r:
        txt = r.read().decode("utf-8", "replace")
    f.write_text(txt, "utf-8")
    return txt


def next_data(url):
    h = fetch(url)
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', h, re.S)
    return json.loads(m.group(1)) if m else None


def walk(o, fn):
    if isinstance(o, dict):
        fn(o)
        for v in o.values():
            walk(v, fn)
    elif isinstance(o, list):
        for v in o:
            walk(v, fn)


def val(d, k):
    v = d.get(k)
    return v.get("value") if isinstance(v, dict) else v


def official(url):
    """Titular em funções (EndDate vazio) de uma página de ministro/secretário de Estado.
    A página guarda o histórico (OfficialsHistory): escolhe-se a entrada sem data de fim; devolve também o histórico."""
    d = next_data(url)
    route = d["props"]["pageProps"]["layoutData"]["sitecore"]["route"]["fields"]
    hist = []
    for e in route.get("OfficialsHistory") or []:
        f = e.get("fields", {})
        nm = ((f.get("Official") or {}).get("fields") or {}).get("FullName")
        nm = nm.get("value") if isinstance(nm, dict) else nm
        if not nm:
            continue
        hist.append({"name": nm, "role": val(f, "GovernmentRole"), "start": (val(f, "StartDate") or "")[:10],
                     "end": ((val(f, "EndDate") or "")[:10] if not (val(f, "EndDate") or "").startswith("0001") else ""),
                     "title": val(route, "GovernmentTitle"), "email": val(route, "GovernmentEmail")})
    if not hist:
        return None
    cur = [h for h in hist if not h["end"]]
    o = dict(max(cur, key=lambda h: h["start"]) if cur else max(hist, key=lambda h: h["end"]))
    o["ended"] = not cur
    o["history"] = hist
    return o


def content_of(d):
    best = ""
    def f(o):
        nonlocal best
        c = val(o, "Content") if "Content" in o else None
        if isinstance(c, str) and len(c) > len(best):
            best = c
    walk(d, f)
    return best


def title_of(d):
    t = []
    walk(d, lambda o: t.append(val(o, "Title")) if isinstance(val(o, "Title"), str) and val(o, "Title") else None)
    return t[0] if t else ""


class Tables(HTMLParser):
    """Extrai (cabeçalho precedente, linhas) de cada <table>."""

    def __init__(self):
        super().__init__()
        self.tables, self.cur, self.row, self.cell, self.last_text = [], None, None, None, ""
        self.buf = []

    def handle_starttag(self, tag, a):
        if tag == "table":
            self.cur = {"heading": self.last_text.strip(), "rows": []}
        elif tag == "tr" and self.cur is not None:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip()); self.cell = None
        elif tag == "tr" and self.row is not None and self.cur is not None:
            if any(self.row): self.cur["rows"].append(self.row)
            self.row = None
        elif tag == "table" and self.cur is not None:
            self.tables.append(self.cur); self.cur = None
        elif tag in ("p", "h1", "h2", "h3", "h4", "div", "strong") and self.cur is None:
            t = "".join(self.buf).strip()
            if t: self.last_text = t
            self.buf = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)
        elif self.cur is None:
            self.buf.append(data)


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ministries (
  slug TEXT PRIMARY KEY, name TEXT, short TEXT, ord INTEGER, url TEXT, minister TEXT, minister_since TEXT,
  minister_role TEXT, address TEXT, keywords TEXT, source_url TEXT,
  alt_name TEXT, alt_since TEXT, alt_source TEXT, divergence TEXT);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, kind TEXT, name TEXT, role TEXT, portfolio TEXT,
  start TEXT, email TEXT, gross TEXT, despacho TEXT, unit TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS people_m ON people(ministry);
CREATE TABLE IF NOT EXISTS bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, entity_id INTEGER, nif TEXT, name TEXT, ekind TEXT,
  method TEXT, basis TEXT, wikidata TEXT, source_url TEXT, UNIQUE(ministry, name));
CREATE INDEX IF NOT EXISTS bodies_m ON bodies(ministry);
CREATE INDEX IF NOT EXISTS bodies_nif ON bodies(nif);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, cm_date TEXT, cm_title TEXT, n INTEGER, text TEXT,
  matched TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS dec_m ON decisions(ministry, cm_date);
CREATE TABLE IF NOT EXISTS news (url TEXT, ministry TEXT, title TEXT, date TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS spend_year (ministry TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL);
CREATE TABLE IF NOT EXISTS spend_proc (ministry TEXT, procedure TEXT, n INTEGER, value REAL);
CREATE TABLE IF NOT EXISTS spend_sup (ministry TEXT, seller_nif TEXT, seller_name TEXT, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL);
CREATE TABLE IF NOT EXISTS spend_body (ministry TEXT, nif TEXT, name TEXT, n INTEGER, value REAL, direct_value REAL);
CREATE TABLE IF NOT EXISTS blocked (source TEXT, reason TEXT);
"""


# ---------------------------------------------------------------- regras de tutela
# (ministério, regex sobre nome normalizado, base)  -- primeira que casar ganha
R = []


def rule(slug, pattern, basis):
    R.append((slug, re.compile(pattern), basis))


rule("negocios-estrangeiros", r"secretaria geral do ministerio dos negocios estrangeiros|^camoes|instituto camoes|ministerio dos negocios estrangeiros", "Nome: serviço do MNE")
rule("financas", r"secretaria geral do ministerio das financas|autoridade tributaria e aduaneira|direcao geral de informatica e apoio aos servicos tributarios|igcp|gestao da tesouraria e da divida publica|entidade de servicos partilhados da administracao publica|gestao partilhada|direcao geral do tesouro|direcao geral do orcamento|inspecao geral de financas|direcao geral da administracao e do emprego publico|imprensa nacional casa da moeda|instituto de protecao e assistencia na doenca|direcao geral do patrimonio|gabinete de planeamento estrategia avaliacao e relacoes internacionais.*financ|unidade tecnica de acompanhamento de projetos", "Nome: organismo do Ministério das Finanças")
rule("presidencia", r"secretaria geral da presidencia do conselho de ministros|secretaria geral do governo|agencia para a integracao migracoes e asilo|estrutura de missao.*(presidencia|conselho de ministros)|centro juridico do estado|gabinete nacional de seguranca|^instituto nacional de estatistica|^lusa", "Nome: organismo da PCM")
rule("reforma-do-estado", r"agencia para a modernizacao administrativa|agencia para a reforma tecnologica do estado|instituto nacional de administracao|^ama ", "Nome: organismo de modernização/reforma administrativa")
rule("defesa-nacional", r"estado maior|ministerio da defesa nacional|secretaria geral do ministerio da defesa|direcao geral de recursos da defesa|direcao geral de armamento|instituto de acao social das forcas armadas|instituto hidrografico|instituto universitario militar|arsenal do alfeite|forcas armadas|\bidd\b|^exercito|^marinha|forca aerea", "Nome: ramo/serviço da Defesa Nacional")
rule("administracao-interna", r"guarda nacional republicana|policia de seguranca publica|autoridade nacional de emergencia e protecao civil|secretaria geral do ministerio da administracao interna|inspecao geral da administracao interna|autoridade nacional de seguranca rodoviaria|servicos sociais da (guarda|policia)|cofre de previdencia da policia|escola nacional de bombeiros|sistema de seguranca interna|servico de estrangeiros e fronteiras", "Nome: força/serviço do MAI")
rule("justica", r"reinsercao e servicos prisionais|servicos prisionais|gestao financeira e equipamentos da justica|administracao da justica|secretaria geral do ministerio da justica|medicina legal|registos e do notariado|policia judiciaria|tecnologias de informacao na justica|igfpj|politica de justica|centro de estudos judiciarios|ministerio da justica|inspecao geral dos servicos de justica", "Nome: serviço do Ministério da Justiça")
rule("saude", r"servicos partilhados do ministerio da saude|direcao geral da saude|infarmed|ricardo jorge|portugues do sangue|administracao central do sistema de saude|inspecao geral das atividades em saude|instituto portugues de oncologia|gama pinto|laboratorio nacional do medicamento|emergencia medica|direcao executiva do sns|secretaria geral do ministerio da saude|sicad|intervencao nos comportamentos aditivos|unidade local de saude|centro hospitalar|^hospital|hospitais|agrupamento de centros de saude|centro de medicina de reabilitacao|^centro de reabilitacao", "Nome: organismo/unidade do SNS (tutela do Ministério da Saúde)")
rule("educacao-ciencia-e-inovacao", r"^universidade (?!catolica)|instituto politecnico|instituto superior tecnico|instituto superior de (engenharia|contabilidade)|iscte|escola superior|agrupamento de escolas|escola (basica|secundaria|artistica)|^escolas? |direcao geral dos estabelecimentos escolares|secretaria geral da educacao|gestao financeira da educacao|direcao geral da educacao|estatisticas da educacao|fundacao para a ciencia e a tecnologia|computacao cientifica nacional|parque escolar|avaliacao e investigacao educacional|inspecao geral da educacao|laboratorio nacional de engenharia civil|agencia nacional para a gestao do programa erasmus|ciencia viva|direcao geral do ensino superior|direcao geral da administracao escolar", "Nome: estabelecimento/organismo de Educação, Ciência e Ensino Superior")
rule("trabalho-solidariedade-e-seguranca-social", r"instituto da seguranca social|gestao financeira da seguranca social|instituto do emprego e da formacao profissional|instituto de informatica|autoridade para as condicoes do trabalho|secretaria geral do ministerio do trabalho|^fundacao inatel|casa pia de lisboa|instituto nacional para a reabilitacao|gabinete de estrategia e planeamento|conselho economico e social|autoridade para as condicoes", "Nome: organismo do Ministério do Trabalho/Segurança Social")
rule("cultura-juventude-e-desporto", r"patrimonio cultural|livro dos arquivos e das bibliotecas|livro arquivos e bibliotecas|museus e monumentos|opart|teatro nacional|cinema e do audiovisual|portugues do desporto e juventude|cinemateca|centro cultural de belem|direcao geral das artes|biblioteca nacional|torre do tombo|palacio nacional|museu nacional|orquestra", "Nome: organismo da Cultura/Juventude/Desporto")
rule("agricultura-e-mar", r"financiamento da agricultura e pescas|alimentacao e veterinaria|agricultura e desenvolvimento rural|investigacao agraria e veterinaria|portugues do mar e da atmosfera|recursos naturais seguranca e servicos maritimos|docapesca|vinhos do douro e do porto|desenvolvimento do alqueva|edia|alimentacao e mercados agricolas|conservacao da natureza e das florestas|instituto da vinha e do vinho|casa do douro|autoridade de seguranca alimentar|gestao de fundos agricolas", "Nome: organismo da Agricultura/Mar")
rule("infraestruturas-e-habitacao", r"infraestruturas de portugal|construcao publica|^cp |comboios de portugal|metropolitano de lisboa|metro do porto|metro mondego|transtejo|soflusa|mobilidade e dos transportes|autoridade nacional da aviacao civil|autoridade da mobilidade e dos transportes|habitacao e da reabilitacao urbana|navegacao aerea|nav portugal|administracao (do|dos) porto|portos de|^apdl|^apl |^aps |^apss|aeroportos de portugal|secretaria geral do ministerio das infraestruturas|gabinete do secretario de estado das infraestruturas|ep estradas de portugal|transportes metropolitanos|ccdr.*mobilidade|autoridade nacional de comunicacoes|anacom|instituto nacional de aviacao civil|fundo nacional de reabilitacao do edificado", "Nome: organismo/empresa do sector das infraestruturas, transportes e habitação")
rule("ambiente-e-energia", r"agencia portuguesa do ambiente|energia e geologia|entidade nacional para o setor energetico|^agua|aguas do|aguas de |aguas e residuos|aguas publicas|epal|simarsul|simtejo|sanest|simria|simdouro|amarsul|valorsul|resinorte|valnor|algar valorizacao|ersuc|suldouro|valorlis|resulima|resiestrela|adp |agua de portugal|secretaria geral do ministerio do ambiente|fundo ambiental|agencia para o clima|parques de sintra|empresa de desenvolvimento mineiro|laboratorio nacional de energia e geologia|direcao geral de energia", "Nome: organismo/empresa do sector do ambiente, águas e energia")
rule("economia-e-coesao-territorial", r"secretaria geral do ministerio da economia|turismo de portugal|desenvolvimento e coesao|comissao de coordenacao e desenvolvimento regional|^ccdr|autoridade de seguranca alimentar e economica|asae|portugues da qualidade|propriedade industrial|iapmei|investimento e comercio externo|direcao geral do territorio|direcao geral das autarquias locais|direcao geral das atividades economicas|gabinete de estrategia e estudos|estrutura de missao recuperar portugal|aicep|turismo do|agencia nacional de inovacao|direcao geral do consumidor|instituto de gestao financeira e equipamentos", "Nome: organismo da Economia/Coesão Territorial")

EXCLUDE = re.compile(r"regiao autonoma|ram$|ip ram|\bram\b|acores|madeira|municipal|municipio|camara|freguesia|misericordia|bombeiros|associacao|federacao|sindicato|casa do povo|cooperativa|santa casa|centro de bem estar|serviços|servicos municipalizados|intermunicipal|secretaria regional|governo regional")
KIND_OK = {"instituto_publico", "outra_entidade", "saude", "seguranca_defesa", "empresa_publica", "universidade", "escola", "regional", "tribunal_justica"}


def classify_entity(name, kind):
    n = norm(name)
    if kind == "regional" and not re.search(r"comissao de coordenacao e desenvolvimento regional|^ccdr", n):
        return None
    if EXCLUDE.search(n) and not re.search(r"guarda nacional|estrada|simarsul|simtejo|simria|sanest|amarsul|aguas do", n):
        # exceções acima: nomes públicos nacionais que contêm termos excluídos
        if not re.search(r"servicos partilhados do ministerio|servicos prisionais|servicos sociais da (guarda|policia)", n):
            return None
    if kind in ("saude",) and re.search(r"misericordia|bombeiros", n):
        return None
    for slug, rx, basis in R:
        if rx.search(n):
            return slug, basis
    return None


# --------------------------------------------------------------------------------
def log(*a):
    print("[ministerios]", *a, flush=True)


def main():
    DB.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("DROP TABLE IF EXISTS ministries")
    con.executescript(SCHEMA)
    for t in ("ministries", "people", "bodies", "decisions", "news", "spend_year", "spend_proc", "spend_sup", "spend_body", "blocked"):
        con.execute(f"DELETE FROM {t}")
    blocked = []

    # --- 1. lista de ministérios verificada contra o sitemap
    sm = fetch(BASE + "/sitemap.xml")
    locs = re.findall(r"<loc>([^<]*)</loc>", sm)
    gc = [u for u in locs if "/gc25/" in u and "/en/" not in u]
    found_slugs = {m.group(1) for u in gc if (m := re.match(r".*/gc25/area-de-governo/([^/]+)$", u))}
    log("ministérios no sitemap:", len(found_slugs), "esperados:", len(MINISTRIES), "em falta:", [m[0] for m in MINISTRIES if m[0] not in found_slugs], "extra:", sorted(found_slugs - {m[0] for m in MINISTRIES}))

    # --- 2. liderança
    for i, (slug, name, short, nslug) in enumerate(MINISTRIES):
        base = f"{BASE}/gc25/area-de-governo/{slug}"
        mi = None
        try:
            mi = official(base + "/ministro")
        except Exception as e:
            log("ministro falhou", slug, e)
        address = ""
        try:
            d = next_data(base + "/contactos")
            c = html.unescape(re.sub(r"<[^>]+>", " ", content_of(d)))
            address = re.sub(r"\s+", " ", c).strip()
        except Exception as e:
            log("contactos falhou", slug, e)
        con.execute("INSERT INTO ministries VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)", (
            slug, name, short, i, base, mi and mi["name"], mi and mi["start"], mi and mi["role"], address,
            KEYWORDS.get(slug, ""), base + "/ministro"))
        if mi:
            con.execute("INSERT INTO people (ministry,kind,name,role,portfolio,start,email,source_url) VALUES (?,?,?,?,?,?,?,?)",
                        (slug, "ministro", mi["name"], mi["role"], name, mi["start"], mi["email"], base + "/ministro"))
        se_urls = sorted(u for u in gc if re.match(rf".*/gc25/area-de-governo/{re.escape(slug)}/secretarios-de-estado/[^/]+$", u))
        for u in se_urls:
            try:
                o = official(u)
            except Exception as e:
                log("SE falhou", u, e); continue
            if o and o["name"] and not o["ended"]:
                con.execute("INSERT INTO people (ministry,kind,name,role,portfolio,start,email,source_url) VALUES (?,?,?,?,?,?,?,?)",
                            (slug, "secretario_estado", o["name"], o["role"], o["title"], o["start"], o["email"], u))
        log("liderança", slug, mi and mi["name"], len(se_urls), "SE")
    con.commit()

    # --- 2b. verificação cruzada do ministro com politica.db (people, body='Governo': Wikidata/pt.wikipedia)
    pm = {"01": 1, "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12}

    def iso_pt(sv):
        m_ = re.search(r"(\d{1,2}) de ([a-zç]+) de (\d{4})", norm(sv or ""))
        m_ = re.search(r"(\d{1,2}) (?:de )?([a-z]+) (?:de )?(\d{4})", norm(sv or ""))
        return f"{m_.group(3)}-{pm.get(m_.group(2), 0):02d}-{int(m_.group(1)):02d}" if m_ and m_.group(2) in pm else ""
    ppl = sqlite3.connect(f"file:{ROOT / 'data' / 'politica.db'}?mode=ro", uri=True)
    wiki = ppl.execute("SELECT name, role, since, source FROM people WHERE body='Governo' AND role LIKE 'Ministr%'").fetchall()
    ppl.close()
    for slug, name, short, nslug in MINISTRIES:
        core = norm(name).split()[0]
        cand = [w for w in wiki if core in norm(w[1]).split()]
        gov = con.execute("SELECT minister, minister_since FROM ministries WHERE slug=?", (slug,)).fetchone()
        if not cand:
            if slug != "assuntos-parlamentares" or True:
                blocked.append((f"verificação do ministro {slug}", f"sem entrada correspondente em politica.db/people (portugal.gov.pt: {gov[0]})"))
            continue
        w = cand[0]
        a_, b_ = set(norm(w[0]).split()), set(norm(gov[0] or "").split())
        if a_ <= b_ or b_ <= a_:  # mesma pessoa (nome abreviado vs completo)
            continue
        w_iso, g_iso = iso_pt(w[2]), (gov[1] or "")
        # portugal.gov.pt só lista titulares em funções; quando diverge, vence a evidência mais recente
        div = f"fontes divergem: portugal.gov.pt indica {gov[0]}, Wikipédia indica {w[0]}"
        use_wiki = bool(w_iso) and w_iso >= g_iso
        if use_wiki:
            con.execute("UPDATE ministries SET minister=?, minister_since=?, minister_role=?, alt_name=?, alt_since=?, alt_source=?, divergence=? WHERE slug=?",
                        (w[0], w_iso, "Ministro(a)", gov[0], g_iso, "portugal.gov.pt", div, slug))
            con.execute("UPDATE people SET name=?, start=?, source_url=? WHERE ministry=? AND kind='ministro'", (w[0], w_iso, "https://pt.wikipedia.org/wiki/XXV_Governo_Constitucional_de_Portugal", slug))
        else:
            con.execute("UPDATE ministries SET alt_name=?, alt_since=?, alt_source=?, divergence=? WHERE slug=?", (w[0], w_iso, "pt.wikipedia.org", div, slug))
        blocked.append((f"ministro {slug}", div + f" (usado: {'Wikipédia, mais recente' if use_wiki else 'portugal.gov.pt'})"))
        log("DIVERGÊNCIA", slug, div)
    con.commit()

    # --- 3. gabinetes (nomeações com despacho DRE)
    nom = {u.rsplit("/", 1)[1]: u for u in gc if re.match(r".*/gc25/governo/nomeacoes/[^/]+$", u)}
    for slug, name, short, nslug in MINISTRIES:
        u = nom.get(nslug)
        if not u:
            blocked.append((f"nomeações {slug}", "sem página de nomeações no sitemap")); continue
        try:
            d = next_data(u)
            p = Tables(); p.feed(content_of(d))
        except Exception as e:
            log("nomeações falhou", u, e); continue
        n = 0
        for t in p.tables:
            hdr = [h.lower() for h in t["rows"][0]] if t["rows"] else []
            if not hdr or "nome" not in hdr:
                continue
            ix = {h: hdr.index(h) for h in hdr}
            for r in t["rows"][1:]:
                if len(r) < len(hdr): continue
                con.execute("INSERT INTO people (ministry,kind,name,role,start,gross,despacho,unit,source_url) VALUES (?,?,?,?,?,?,?,?,?)", (
                    slug, "gabinete", r[ix["nome"]], r[ix.get("função", 0)], r[ix["data de nomeação"]] if "data de nomeação" in ix else None,
                    r[ix["rendimento bruto"]] if "rendimento bruto" in ix else None,
                    r[ix["publicação em dre"]] if "publicação em dre" in ix else None, t["heading"][:140], u))
                n += 1
        log("gabinete", slug, n)
    con.commit()

    # --- 4. tutela: regras sobre o registo de entidades
    pol = sqlite3.connect(f"file:{ROOT / 'data' / 'politica.db'}?mode=ro", uri=True)
    ents = pol.execute("SELECT id, nif, name, kind FROM entities WHERE is_public=1 AND kind IN (%s)" % ",".join("?" * len(KIND_OK)), tuple(KIND_OK)).fetchall()
    log("entidades públicas candidatas:", len(ents))
    by_name = {}
    nb = 0
    for eid, nif, name, kind in ents:
        by_name.setdefault(norm(name), (eid, nif, name, kind))
        c = classify_entity(name, kind)
        if c:
            slug, basis = c
            con.execute("INSERT OR IGNORE INTO bodies (ministry,entity_id,nif,name,ekind,method,basis,source_url) VALUES (?,?,?,?,?,?,?,?)",
                        (slug, eid, nif, name, kind, "regra", basis, f"{BASE}/gc25/area-de-governo/{slug}"))
            nb += 1
    log("organismos atribuídos por regra:", nb)

    # --- 4b. Wikidata (P749 parent organization / P361 / P137 -> item do ministério)
    wd_map = {"Q4294357": "saude", "Q4294480": "defesa-nacional", "Q4294790": "financas", "Q1283287": "negocios-estrangeiros",
              "Q4294438": "cultura-juventude-e-desporto", "Q3302210": "educacao-ciencia-e-inovacao", "Q4294767": "trabalho-solidariedade-e-seguranca-social",
              "Q10330422": "agricultura-e-mar", "Q16489649": "ambiente-e-energia", "Q25421830": "infraestruturas-e-habitacao",
              "Q4294291": "administracao-interna", "Q10353665": "presidencia", "Q21625222": "economia-e-coesao-territorial",
              "Q25422181": "trabalho-solidariedade-e-seguranca-social", "Q25422179": "agricultura-e-mar", "Q86734622": "infraestruturas-e-habitacao",
              "Q86734105": "ambiente-e-energia", "Q86734606": "economia-e-coesao-territorial", "Q10330343": "assuntos-parlamentares"}
    n_wd = n_wd_match = 0
    try:
        q = "SELECT ?c ?cl ?p WHERE { VALUES ?p { %s } ?c wdt:P749|wdt:P361|wdt:P137 ?p. ?c rdfs:label ?cl FILTER(LANG(?cl)=\"pt\") }" % " ".join("wd:" + k for k in wd_map)
        url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
        rows = json.load(urllib.request.urlopen(req, timeout=90))["results"]["bindings"]
        for b in rows:
            qid = b["c"]["value"].rsplit("/", 1)[1]; slug = wd_map[b["p"]["value"].rsplit("/", 1)[1]]; nm = b["cl"]["value"]
            n_wd += 1
            hit = by_name.get(norm(nm))
            if hit:
                n_wd_match += 1
                con.execute("INSERT OR IGNORE INTO bodies (ministry,entity_id,nif,name,ekind,method,basis,wikidata,source_url) VALUES (?,?,?,?,?,?,?,?,?)",
                            (slug, hit[0], hit[1], hit[2], hit[3], "wikidata", "Wikidata P749/P361/P137 -> ministério", qid, f"https://www.wikidata.org/wiki/{qid}"))
                con.execute("UPDATE bodies SET wikidata=? WHERE ministry=? AND name=?", (qid, slug, hit[2]))
        log("Wikidata:", n_wd, "itens com ligação a ministério;", n_wd_match, "casados com o registo")
    except Exception as e:
        log("Wikidata falhou:", e); blocked.append(("Wikidata P749", str(e)))
    con.commit()

    # --- 5. Conselho de Ministros: comunicados -> decisões
    cm_urls = sorted({u for u in gc if "/governo/comunicados-do-conselho-de-ministros/" in u and not re.search(r"/\d+$", u)})
    cm_urls_num = sorted({u for u in gc if re.search(r"comunicados-do-conselho-de-ministros/\d+$", u)})
    log("comunicados CM:", len(cm_urls), "slugs +", len(cm_urls_num), "numéricos")
    body_pats = defaultdict(list)
    for r in con.execute("SELECT ministry, name FROM bodies"):
        nm = norm(re.sub(r",?\s*(i\.?p\.?|e\.?p\.?e\.?|s\.?a\.?)\.?$", "", r[1], flags=re.I))
        if len(nm.split()) >= 3 and len(nm) >= 18 and not nm.startswith(("agrupamento", "escola", "universidade", "unidade local", "centro hospitalar", "hospital")):
            body_pats[r[0]].append(nm)
    months = {m: i + 1 for i, m in enumerate("janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro".split())}
    seen_titles = set()
    kw = {s: re.compile(p) for s, p in KEYWORDS.items()}
    ndec = 0
    for u in cm_urls + cm_urls_num:
        try:
            d = next_data(u)
        except Exception as e:
            log("CM falhou", u, e); continue
        if not d: continue
        title = title_of(d)
        c = content_of(d)
        if not title or "Conselho de Ministros" not in title or not c or title in seen_titles:
            continue
        seen_titles.add(title)
        m = re.search(r"(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})", norm(title).replace("marco", "marco"))
        nt = norm(title)
        m = re.search(r"(\d{1,2}) (?:de )?([a-z]+) (?:de )?(\d{4})", nt)
        iso = f"{m.group(3)}-{months.get(m.group(2), 0):02d}-{int(m.group(1)):02d}" if m and m.group(2) in months else None
        text = html.unescape(re.sub(r"<[^>]+>", " ", c.replace("<br />", "\n").replace("</p>", "\n")))
        text = text.replace("\xa0", " ")
        items = [x.strip() for x in re.split(r"\n\s*(?=\d{1,2}\.\s)", text) if re.match(r"\d{1,2}\.\s", x.strip())]
        for it in items:
            num = int(re.match(r"(\d{1,2})\.", it).group(1))
            body = re.sub(r"\s+", " ", it[it.index(".") + 1:]).strip()
            if len(body) < 40: continue
            nb_ = norm(body)
            hits = []
            for slug, rx in kw.items():
                k = len(rx.findall(nb_)); k += 3 * sum(1 for p in body_pats.get(slug, []) if p in nb_)
                if k: hits.append((k, slug))
            hits.sort(reverse=True)
            top = [s for k, s in hits[:2] if k >= max(1, hits[0][0] // 2)] if hits else []
            for s in top:
                con.execute("INSERT INTO decisions (ministry,cm_date,cm_title,n,text,matched,source_url) VALUES (?,?,?,?,?,?,?)",
                            (s, iso, title, num, body[:1500], "palavras-chave/organismos", u))
                ndec += 1
    log("decisões CM atribuídas:", ndec, "em", len(seen_titles), "comunicados")
    con.commit()

    # --- 6. notícias (só o que o servidor entrega sem JS: destaques da página inicial)
    try:
        h = fetch(BASE + "/pt/gc25", cache=False)
        for m in re.finditer(r'href="(https://portugal\.gov\.pt/gc25/comunicacao/noticias/([^"]+))"', h):
            u, slug_ = m.group(1), m.group(2)
            con.execute("INSERT INTO news VALUES (?,?,?,?,?)", (u, None, slug_.replace("-", " ").capitalize(), None, "portugal.gov.pt (destaques da página inicial)"))
    except Exception as e:
        log("notícias home falhou", e)
    blocked.append(("Notícias por ministério (portugal.gov.pt/…/<ministério>/noticias)",
                    "A lista carrega no browser via Sitecore Search (Discover); o endpoint responde 'page not found for uri' para qualquer uri público. Só estão disponíveis comunicados do Conselho de Ministros, nomeações e destaques da página inicial."))
    blocked.append(("Leis orgânicas (Diário da República)", "diariodarepublica.pt é uma SPA sem texto no HTML e dre.tretas.org devolve 403; a tutela por regra de nome NÃO foi extraída das leis orgânicas."))
    blocked.append(("Wikidata tutela", "Só ~poucos itens têm P749/P361/P137 para um ministério; Wikidata não cobre o XXV Governo."))

    # --- 7. despesa por ministério
    pol.close()
    pol = sqlite3.connect(":memory:", uri=True)
    pol.execute("ATTACH DATABASE ? AS p", (f"file:{ROOT / 'data' / 'politica.db'}?mode=ro",))
    con.execute("DROP TABLE IF EXISTS tn"); con.execute("CREATE TABLE tn (ministry TEXT, nif TEXT)")
    seen = set()
    rows = [(r[0], r[1]) for r in con.execute("SELECT ministry, nif FROM bodies WHERE nif IS NOT NULL")]
    # um NIF só conta num ministério (o primeiro, por ordem de inserção)
    for m_, n_ in rows:
        if n_ in seen: continue
        seen.add(n_); con.execute("INSERT INTO tn VALUES (?,?)", (m_, n_))
    con.commit()
    nifs = defaultdict(list)
    for m_, n_ in con.execute("SELECT ministry, nif FROM tn"): nifs[m_].append(n_)
    DIRECT = "procedure LIKE 'Ajuste Direto%'"
    for slug, lst in nifs.items():
        pol.execute("DROP TABLE IF EXISTS t"); pol.execute("CREATE TABLE t (nif TEXT PRIMARY KEY)")
        pol.executemany("INSERT OR IGNORE INTO t VALUES (?)", [(x,) for x in lst])
        j = "FROM p.contracts c JOIN t ON t.nif=c.buyer_nif"
        con.executemany("INSERT INTO spend_year VALUES (?,?,?,?,?,?)", [(slug, *r) for r in pol.execute(
            f"SELECT year, COUNT(*), SUM(COALESCE(price,0)), SUM({DIRECT}), SUM(CASE WHEN {DIRECT} THEN COALESCE(price,0) ELSE 0 END) {j} WHERE year IS NOT NULL GROUP BY year ORDER BY year")])
        con.executemany("INSERT INTO spend_proc VALUES (?,?,?,?)", [(slug, *r) for r in pol.execute(
            f"SELECT procedure, COUNT(*), SUM(COALESCE(price,0)) {j} GROUP BY procedure ORDER BY 3 DESC")])
        con.executemany("INSERT INTO spend_sup VALUES (?,?,?,?,?,?,?)", [(slug, *r) for r in pol.execute(
            f"SELECT seller_nif, MAX(seller_name), COUNT(*), SUM(COALESCE(price,0)) v, SUM({DIRECT}), SUM(CASE WHEN {DIRECT} THEN COALESCE(price,0) ELSE 0 END) {j} WHERE seller_nif IS NOT NULL GROUP BY seller_nif ORDER BY v DESC LIMIT 25")])
        con.executemany("INSERT INTO spend_body VALUES (?,?,?,?,?,?)", [(slug, *r) for r in pol.execute(
            f"SELECT c.buyer_nif, MAX(c.buyer_name), COUNT(*), SUM(COALESCE(price,0)) v, SUM(CASE WHEN {DIRECT} THEN COALESCE(price,0) ELSE 0 END) {j} GROUP BY c.buyer_nif ORDER BY v DESC LIMIT 40")])
        con.commit()
        log("despesa", slug, len(lst), "NIFs")

    con.executemany("INSERT INTO blocked VALUES (?,?)", blocked)
    ne = len(ents)
    nd = con.execute("SELECT COUNT(*) FROM ministries WHERE divergence IS NOT NULL").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO meta VALUES ('ministers_crosschecked', ?)", (f"16 ministros comparados com politica.db/people (Wikipédia); {nd} divergências reais",))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('updated', datetime('now'))")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('public_entities_considered', ?)", (str(ne),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('wikidata_items', ?)", (str(n_wd),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('wikidata_matched', ?)", (str(n_wd_match),))
    con.commit()
    tot = con.execute("SELECT COUNT(DISTINCT name) FROM bodies").fetchone()[0]
    log(f"organismos tutelados: {tot}/{ne} entidades públicas candidatas ({100 * tot / max(ne, 1):.1f}%)")
    con.close()


if __name__ == "__main__":
    main()
