#!/usr/bin/env python3
"""Reguladores independentes e entidades de supervisão -> data/reguladores.db

Fontes (todas públicas, robots.txt verificado, cache em data/raw/reguladores/):
  * lista curada de organismos (missão/lei: dados oficiais conhecidos; cada linha com site oficial)
  * responsaveis.db (mandatos da Entidade para a Transparência) -> administração
  * dre.db (atos do Diário da República sobre o organismo) -> nomeações/estatutos
  * concorrencia.pt  (AdC: notícias/comunicados -> decisões, sanções, concentrações; coimas lidas do texto)
  * cnpd.pt          (CNPD: histórico de decisões: deliberações, pareceres, diretrizes)
  * erc.pt           (ERC: deliberações)
  * amt-autoridade.pt (AMT: decisões de contraordenação; súmulas em PDF)
Bloqueado/excluído: ver tabela `blocked`.
Uso: python3 ingest/run_all.py reguladores   (REGUL_MAX_REQ limita pedidos de rede; retomável pela cache)
"""
import gzip, hashlib, html, json, os, re, sqlite3, subprocess, sys, time, unicodedata
import urllib.error, urllib.parse, urllib.request, urllib.robotparser
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, connect_writer  # noqa: E402
from since import cutoff, report, since_days  # noqa: E402

NAME = "reguladores"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
BUA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
MAX_REQ = int(os.environ.get("REGUL_MAX_REQ", "100000"))
DELAY = 1.2
_last = {}
_robots = {}
_nreq = [0]
SINCE = since_days()


def years_back():
    y = date.today().year
    return [y, y - 1] if SINCE and date.today().month == 1 else [y]

# ---------------------------------------------------------------- organismos
# (slug, short, nome, grupo, site, lei de criação/estatutos, missão, padrões de nome para mandatos/DRE, nome no registo)
B = [
 ("adc", "AdC", "Autoridade da Concorrência", "regulador", "https://www.concorrencia.pt/",
  "Lei-quadro das entidades reguladoras: Lei n.º 67/2013, de 28 de agosto; estatutos: Decreto-Lei n.º 125/2014, de 18 de agosto",
  "Garantir a aplicação das regras da concorrência: práticas restritivas, abusos de posição dominante e controlo de operações de concentração de empresas.",
  ["Autoridade da Concorrência"], "Autoridade da Concorrência"),
 ("anacom", "ANACOM", "Autoridade Nacional de Comunicações", "regulador", "https://www.anacom.pt/",
  "Estatutos: Decreto-Lei n.º 39/2015, de 16 de março",
  "Regulação e supervisão das comunicações eletrónicas e postais.",
  ["Autoridade Nacional de Comunicações", "ANACOM"], "Autoridade Nacional de Comunicações"),
 ("erse", "ERSE", "Entidade Reguladora dos Serviços Energéticos", "regulador", "https://www.erse.pt/",
  "Estatutos: Decreto-Lei n.º 97/2002, de 12 de abril, na redação em vigor; regime sancionatório: Lei n.º 9/2013, de 28 de janeiro",
  "Regulação dos setores da eletricidade, gás natural, combustíveis e mobilidade elétrica.",
  ["Entidade Reguladora dos Serviços Energéticos"], "Entidade Reguladora dos Serviços Energéticos"),
 ("erc", "ERC", "Entidade Reguladora para a Comunicação Social", "regulador", "https://www.erc.pt/",
  "Lei n.º 53/2005, de 8 de novembro (início de funções do Conselho Regulador em 17 de fevereiro de 2006)",
  "Regular e supervisionar as entidades que prosseguem atividades de comunicação social em Portugal.",
  ["Entidade Reguladora para a Comunicação Social"], "Entidade Reguladora para a Comunicação Social"),
 ("ers", "ERS", "Entidade Reguladora da Saúde", "regulador", "https://www.ers.pt/",
  "Estatutos: Decreto-Lei n.º 126/2014, de 22 de agosto",
  "Regulação e supervisão da atividade dos estabelecimentos prestadores de cuidados de saúde (públicos, privados e sociais).",
  ["Entidade Reguladora da Saúde"], "Entidade Reguladora da Saúde"),
 ("amt", "AMT", "Autoridade da Mobilidade e dos Transportes", "regulador", "https://www.amt-autoridade.pt/",
  "Estatutos: Decreto-Lei n.º 78/2014, de 14 de maio",
  "Regulação económica e supervisão dos setores da mobilidade e dos transportes e das infraestruturas de transporte.",
  ["Autoridade da Mobilidade e dos Transportes"], "Autoridade da Mobilidade e dos Transportes"),
 ("impic", "IMPIC", "Instituto dos Mercados Públicos, do Imobiliário e da Construção, I.P.", "regulador", "https://www.impic.pt/",
  "Orgânica: Decreto-Lei n.º 232/2015, de 9 de outubro",
  "Regulação e fiscalização dos setores da construção, do imobiliário e dos contratos públicos (Portal BASE).",
  ["Instituto dos Mercados Públicos, do Imobiliário e da Construção"], "Instituto dos Mercados Públicos, do Imobiliário e da Construção, IP"),
 ("anac", "ANAC", "Autoridade Nacional da Aviação Civil", "regulador", "https://www.anac.pt/",
  "Estatutos: Decreto-Lei n.º 40/2015, de 16 de março",
  "Regulação, supervisão e fiscalização do setor da aviação civil.",
  ["Autoridade Nacional da Aviação Civil", "Autoridade Nacional de Aviação Civil"], "Autoridade Nacional da Aviação Civil"),
 ("asf", "ASF", "Autoridade de Supervisão de Seguros e Fundos de Pensões", "regulador", "https://www.asf.com.pt/",
  "Estatutos: Decreto-Lei n.º 1/2015, de 6 de janeiro",
  "Supervisão prudencial e comportamental das atividades seguradora, resseguradora, de mediação de seguros e de fundos de pensões.",
  ["Autoridade de Supervisão de Seguros e Fundos de Pensões"], "Autoridade de Supervisão de Seguros e Fundos de Pensões"),
 ("cmvm", "CMVM", "Comissão do Mercado de Valores Mobiliários", "regulador", "https://www.cmvm.pt/",
  "Estatutos: Decreto-Lei n.º 5/2015, de 8 de janeiro",
  "Supervisão e regulação dos mercados de valores mobiliários e dos agentes que neles atuam.",
  ["Comissão do Mercado de Valores Mobiliários"], "Comissão do Mercado de Valores Mobiliários"),
 ("bdp", "BdP", "Banco de Portugal", "regulador", "https://www.bportugal.pt/",
  "Lei Orgânica: Lei n.º 5/98, de 31 de janeiro",
  "Banco central nacional e autoridade de supervisão prudencial e comportamental das instituições de crédito e financeiras.",
  ["Banco de Portugal"], "Banco de Portugal"),
 ("cnpd", "CNPD", "Comissão Nacional de Proteção de Dados", "regulador", "https://www.cnpd.pt/",
  "Lei n.º 43/2004, de 18 de agosto (organização e funcionamento); Lei n.º 58/2019 (execução do RGPD)",
  "Autoridade nacional de controlo de dados pessoais: fiscaliza, emite pareceres, autoriza e aplica coimas.",
  ["Comissão Nacional de Proteção de Dados", "Comissão Nacional de Protecção de Dados"], "Comissão Nacional de Proteção de Dados"),
 ("cne", "CNE", "Comissão Nacional de Eleições", "supervisao", "https://www.cne.pt/",
  "Lei n.º 71/78, de 27 de dezembro",
  "Órgão independente que assegura a regularidade e a igualdade dos atos eleitorais e referendários.",
  ["Comissão Nacional de Eleições"], "Comissão Nacional de Eleições"),
 ("provedor", "Provedor", "Provedor de Justiça", "supervisao", "https://www.provedor-jus.pt/",
  "Estatuto: Lei n.º 9/91, de 9 de abril",
  "Órgão independente que defende os direitos, liberdades, garantias e interesses legítimos dos cidadãos perante os poderes públicos.",
  ["Provedor de Justiça", "Provedoria de Justiça"], "Provedoria de Justiça"),
 ("et", "ET", "Entidade para a Transparência", "supervisao", "https://www.entidadetransparencia.pt/",
  "Lei Orgânica: Lei n.º 4/2019, de 10 de janeiro",
  "Apreciar e fiscalizar a declaração única de rendimentos, património, interesses, incompatibilidades e impedimentos dos titulares de cargos públicos.",
  ["Entidade para a Transparência"], None),
 ("menac", "MENAC", "Mecanismo Nacional Anticorrupção", "supervisao", "https://www.mec-anticorrupcao.gov.pt/",
  "Decreto-Lei n.º 109-E/2021, de 9 de dezembro",
  "Promover a transparência e a integridade na ação pública e prevenir a corrupção; supervisiona o regime geral de prevenção da corrupção (RGPC).",
  ["Mecanismo Nacional Anticorrupção", "MENAC"], "Mecanismo Nacional Anticorrupção"),
 ("igai", "IGAI", "Inspeção-Geral da Administração Interna", "inspecao", "https://www.igai.pt/",
  None, "Auditoria, inspeção e fiscalização das forças e serviços de segurança e demais serviços da administração interna.",
  ["Inspeção-Geral da Administração Interna"], "Inspeção-Geral da Administração Interna"),
 ("igf", "IGF", "Inspeção-Geral de Finanças", "inspecao", "https://igf.gov.pt/",
  None, "Órgão de controlo estratégico da administração financeira do Estado: auditoria, inspeção e controlo das finanças públicas.",
  ["Inspeção-Geral de Finanças"], "Inspeção-Geral de Finanças"),
 ("iges", "IGEC", "Inspeção-Geral da Educação e Ciência", "inspecao", "https://www.igec.mec.pt/",
  None, "Auditoria, controlo e inspeção do sistema educativo, da ciência e do ensino superior.",
  ["Inspeção-Geral da Educação e Ciência"], "Inspeção-Geral da Educação e Ciência"),
 ("igfej", "IGFEJ", "Instituto de Gestão Financeira e Equipamentos da Justiça", "inspecao", "https://www.igfej.justica.gov.pt/",
  None, "Nota: o IGFEJ é um instituto de gestão (finanças, equipamentos e sistemas da Justiça), não um serviço de inspeção; incluído por pedido, apenas como organismo público.",
  ["Instituto de Gestão Financeira e Equipamentos da Justiça"], "Instituto de Gestão Financeira e Equipamentos da Justiça, IP"),
 ("act", "ACT", "Autoridade para as Condições do Trabalho", "inspecao", "https://portal.act.gov.pt/",
  None, "Promoção da melhoria das condições de trabalho e fiscalização do cumprimento da legislação laboral.",
  ["Autoridade para as Condições do Trabalho"], "Autoridade para as Condições do Trabalho"),
 ("asae", "ASAE", "Autoridade de Segurança Alimentar e Económica", "inspecao", "https://www.asae.gov.pt/",
  None, "Fiscalização da segurança alimentar e da atividade económica e avaliação e comunicação de riscos na cadeia alimentar.",
  ["Autoridade de Segurança Alimentar e Económica"], "Autoridade de Segurança Alimentar e Económica - ASAE"),
]
# IGEC: slug canónico
B = [(("igec" if b[0] == "iges" else b[0],) + tuple(b[1:])) for b in B]

# ---------------------------------------------------------------- util
def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def txt(s):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", s, flags=re.S)
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()

def host_of(u):
    return urllib.parse.urlsplit(u).netloc.lower()

def robots_ok(url):
    """True se o robots.txt do anfitrião permite UA genérico. 403/bloqueio no robots = não recolher."""
    h = urllib.parse.urlsplit(url)
    key = h.scheme + "://" + h.netloc
    if key not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        verdict = "ok"
        try:
            req = urllib.request.Request(key + "/robots.txt", headers={"User-Agent": BUA})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read().decode("utf-8", "replace")
                if "<html" in body[:600].lower() or "disallow" not in body.lower() and "user-agent" not in body.lower():
                    rp.parse([])  # resposta não é um robots.txt: sem restrições
                else:
                    rp.parse(body.splitlines())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                verdict = "forbidden"
            else:
                rp.parse([])
        except Exception:
            verdict = "unreachable"
        time.sleep(DELAY)
        _robots[key] = (rp, verdict)
    rp, verdict = _robots[key]
    if verdict != "ok":
        return False
    return rp.can_fetch("*", url)

def get(url, binary=False, ctype=None, retries=2, fresh=False):
    """Pedido cortês com cache gzip. Devolve texto (ou bytes) ou None."""
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / (hashlib.sha1(url.encode()).hexdigest()[:20] + (".bin.gz" if binary else ".html.gz"))
    if f.exists() and not fresh:
        d = gzip.open(f).read()
        return d if binary else d.decode("utf-8", "replace")
    if _nreq[0] >= MAX_REQ:
        return None
    if not robots_ok(url):
        return None
    h = host_of(url)
    wait = DELAY - (time.time() - _last.get(h, 0))
    if wait > 0:
        time.sleep(wait)
    for k in range(retries + 1):
        try:
            _nreq[0] += 1
            req = urllib.request.Request(url, headers={"User-Agent": BUA, "Accept-Language": "pt-PT,pt;q=0.9"})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
            _last[h] = time.time()
            gzip.open(f, "wb").write(data)
            return data if binary else data.decode(r.headers.get_content_charset() or "utf-8", "replace")
        except urllib.error.HTTPError as e:
            _last[h] = time.time()
            if e.code in (404, 410):
                return None
            time.sleep(3 * (k + 1))
        except Exception:
            time.sleep(3 * (k + 1))
    return None

CUMUL = re.compile(r"emitidas entre|decis[oõ]es condenat[oó]rias|desde 20\d\d|acumulad|cumulativ|volume de neg|que se eleva a mais", re.I)
# valores verificados à mão no texto integral (ver docs): url -> (valor, nota)
VERIFIED = {  # valores >250 M€ conferidos no texto integral (soma das coimas por empresa = total)
  "adc:/pt/artigos/adc-condena-grandes-cadeias-de-supermercados-e-dois-fornecedores-por-concertarem-precos-em":
    "soma das coimas individuais listadas no comunicado = 303,798 M€",
}
AMOUNT_OVERRIDE = {
  "https://www.concorrencia.pt/pt/artigos/autoridade-da-concorrencia-condena-empresas-do-grupo-pt-e-do-grupo-zon-por-abuso-de-posicao":
    (53062000.0, "total das coimas aplicadas aos grupos PT (45,016 M€) e ZON (8,046 M€), segundo o comunicado"),
}

def _num(raw):
    raw = raw.replace(" ", "")
    if "," in raw:
        return float(raw.replace(".", "").replace(",", "."))
    return float(raw.replace(".", "")) if re.search(r"\.\d{3}", raw) else float(raw)

def parse_amount(text):
    """Valor de coima (EUR) a partir de texto; devolve (valor, nota) ou (None, None).
    Ignora totais cumulativos de várias decisões, volumes de negócios e limites legais."""
    t = text.replace("\xa0", " ")
    cands = []
    pat = re.compile(r"(coimas?|multas?)([^.;]{0,90}?)(\d{1,3}(?:[. ]\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(milh(?:ões|ão)|mil)?\s*(?:de\s+)?(euros|€|M€)", re.I)
    pat2 = re.compile(r"(coimas?\s+(?:total|única|global|aplicada)[^€.\d]{0,25})€\s*(\d{1,3}(?:\.\d{3})+(?:,\d+)?)", re.I)
    for m in pat.finditer(t):
        try:
            v = _num(m.group(3))
        except ValueError:
            continue
        mult = (m.group(4) or "").lower()
        v *= 1e6 if mult.startswith("milh") else 1e3 if mult == "mil" else 1
        if m.group(5) == "M€":
            v *= 1e6
        cands.append((m.start(), v, m.group(0)))
    for m in pat2.finditer(t):
        try:
            cands.append((m.start(), _num(m.group(2)), m.group(0)))
        except ValueError:
            pass
    best = None
    for pos, v, frag in cands:
        wide = t[max(t.rfind(". ", 0, pos) + 1, pos - 160):pos + len(frag) + 5]  # só a própria frase
        if re.search(r"inferior|superior|até|m[ií]nim|m[aá]xim|limite|moldura|exced|ultrapass", t[max(0, pos - 40):pos + len(frag) + 5], re.I):
            continue
        if CUMUL.search(wide):
            continue
        ctx = wide.lower()
        score = (3 if re.search(r"total|global|única|unica", ctx) else 0, v)
        if best is None or score > best[0]:
            best = (score, v, re.sub(r"\s+", " ", frag)[:160])
    if best and 100 <= best[1] <= 5e9:
        return best[1], "valor lido do texto publicado: «" + best[2] + "»"
    return None, None

ORG = re.compile(r"\b(lda|s\.?\s?a\.?|unipessoal|e\.?\s?p\.?\s?e\.?|i\.?\s?p\.?|cooperativa|associa[cç][aã]o|sindicato|partido|grupo|c[aâ]mara|munic[ií]pio|junta|governo|minist[eé]rio|assembleia|comiss[aã]o|sociedade|funda[cç][aã]o|instituto|empresa|r[aá]dio|televis[aã]o|jornal|ordem|federa[cç][aã]o|clube|universidade|banco|rtp|sic|tvi|presidente|secret[aá]rio|provedor|conselho|direç[aã]o|dire[cç][aã]o|centro|hospital|agrupamento|escola|autoridade|entidade)\b", re.I)

def mask_person(title):
    """Esconde nomes de pessoas singulares em títulos do tipo 'Recurso de X contra Y'."""
    def rep(m):
        who = m.group(3)
        return m.group(0) if ORG.search(who) or who.isupper() else f"{m.group(1)}{m.group(2)}[pessoa singular] contra"
    return re.sub(r"^((?:Recurso|Queixa|Participa[cç][oõa][eõs]*|Reclama[cç][aã]o|Pedido)(?: [a-zçãõé]+)?)( d[eao]s? )(.+?) contra", rep, title)

# ---------------------------------------------------------------- DB
SCHEMA = """
CREATE TABLE IF NOT EXISTS bodies (
  slug TEXT PRIMARY KEY, short TEXT, name TEXT, grp TEXT, site TEXT, law TEXT, mission TEXT,
  nif TEXT, entity_name TEXT, match_method TEXT, robots TEXT, ord INTEGER, source_url TEXT
);
CREATE TABLE IF NOT EXISTS board (
  id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, holder TEXT, role TEXT, begin_date TEXT, end_date TEXT,
  active INTEGER, origin TEXT, source_url TEXT, UNIQUE(body, holder, role, begin_date)
);
CREATE INDEX IF NOT EXISTS board_b ON board(body, active);
CREATE TABLE IF NOT EXISTS dre_acts (
  id TEXT, body TEXT, date TEXT, kind TEXT, number TEXT, title TEXT, source_url TEXT, UNIQUE(id, body)
);
CREATE INDEX IF NOT EXISTS dre_b ON dre_acts(body, date);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, body TEXT, kind TEXT, ref TEXT, date TEXT, year INTEGER, title TEXT, subject TEXT,
  amount REAL, amount_note TEXT, url TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS dec_b ON decisions(body, year);
CREATE INDEX IF NOT EXISTS dec_k ON decisions(kind);
CREATE INDEX IF NOT EXISTS dec_a ON decisions(amount);
CREATE TABLE IF NOT EXISTS blocked (body TEXT, what TEXT, url TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

def open_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = connect_writer(DB)
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript(SCHEMA)
    return c

def ro(name):
    p = DATA_DIR / name
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=60) if p.exists() else None

# ---------------------------------------------------------------- bodies, board, DRE
def load_bodies(c):
    pol = ro("politica.db")
    n_match = 0
    for i, (slug, short, name, grp, site, law, mission, pats, regname) in enumerate(B):
        nif = ename = method = None
        if pol:
            r = None
            if regname:
                r = pol.execute("SELECT nif,name FROM entities WHERE name=? AND nif IS NOT NULL ORDER BY id LIMIT 1", (regname,)).fetchone()
                method = "nome exato" if r else None
            if not r:
                for p in pats:
                    r = pol.execute("SELECT nif,name FROM entities WHERE name LIKE ? AND nif IS NOT NULL ORDER BY id LIMIT 1", (p + "%",)).fetchone()
                    if r:
                        method = "nome (prefixo)"
                        break
            if r:
                nif, ename = r
                n_match += 1
        c.execute("INSERT OR REPLACE INTO bodies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (slug, short, name, grp, site, law, mission, nif, ename, method, None, i, site))
    c.commit()
    return n_match

def dedupe_board(c):
    groups = {}
    for id_, body, holder, role, b in c.execute("SELECT id,body,holder,role,begin_date FROM board WHERE active=1 ORDER BY COALESCE(begin_date,'9999'), id"):
        groups.setdefault((body, norm(holder), norm(role)), []).append(id_)
    drop = [i for ids in groups.values() for i in ids[1:]]
    c.executemany("DELETE FROM board WHERE id=?", [(i,) for i in drop])
    c.commit()
    return len(drop)

def load_board(c):
    resp = ro("responsaveis.db")
    dre = ro("dre.db")
    today = date.today().isoformat()
    nb = nd = 0
    for slug, short, name, grp, site, law, mission, pats, regname in B:
        nif = (c.execute("SELECT nif FROM bodies WHERE slug=?", (slug,)).fetchone() or [None])[0]
        if resp:
            conds, args = [], []
            if nif:
                conds.append("entity_nif=?"); args.append(nif)
            for p in pats:
                conds.append("entity LIKE ?"); args.append(p + "%")
            rows = resp.execute(f"SELECT holder,role,begin_date,end_date,source_url,entity FROM mandates WHERE {' OR '.join(conds)}", args).fetchall()
            for holder, role, b, e, src, ent in rows:
                if not holder:
                    continue
                active = 1 if (not e or e >= today) else 0
                c.execute("INSERT OR IGNORE INTO board(body,holder,role,begin_date,end_date,active,origin,source_url) VALUES (?,?,?,?,?,?,?,?)",
                          (slug, holder, role, b, e or None, active, "Entidade para a Transparência (mandatos)", src))
                nb += 1
        if dre:
            like = " OR ".join(["summary LIKE ?" for _ in pats] + ["title LIKE ?" for _ in pats])
            args = ["%" + p + "%" for p in pats] * 2
            kw = "(summary LIKE '%design%' OR summary LIKE '%nomea%' OR summary LIKE '%exonera%' OR summary LIKE '%cessa%' OR summary LIKE '%conselho de administra%' OR summary LIKE '%estatutos%' OR summary LIKE '%conselho regulador%' OR summary LIKE '%mandato%' OR summary LIKE '%orgânica%')"
            rows = dre.execute(f"SELECT id,date,kind,number,summary,title,COALESCE(url,source_url,dr_url) FROM acts WHERE ({like}) AND {kw} ORDER BY date DESC LIMIT 60", args).fetchall()
            for id_, d, k, n, s, t, u in rows:
                c.execute("INSERT OR IGNORE INTO dre_acts VALUES (?,?,?,?,?,?,?)", (id_, slug, d, k, n, (s or t or "")[:400], u))
                nd += 1
        c.commit()
    return nb, nd

# ---------------------------------------------------------------- AdC
ADC = "https://www.concorrencia.pt"

def adc_kind(title):
    t = title.lower()
    if re.search(r"decis[aã]o de n[aã]o oposi", t): return "concentracao_nao_oposicao"
    if re.search(r"proíbe|proibe|decis[aã]o de oposi", t): return "concentracao_oposicao"
    if re.search(r"consulta p[uú]blica|linhas de orienta", t): return None
    if re.search(r"tribunal|tr[aâ]nsito em julgado|\bstj\b|tjue|supremo", t): return "decisao_judicial"
    if re.search(r"\b(sanciona|condena|coimas?|multa)\b|aplica.{0,30}coima|imp[oõ]e.{0,30}coima", t): return "sancao"
    if re.search(r"acusa|nota de ilicitude", t): return "acusacao"
    if re.search(r"compromisso|medidas corretivas|condi[cç][oõ]es", t): return "decisao_condicionada"
    if re.search(r"arquiva", t): return "arquivamento"
    if re.search(r"notifica.{0,40}aquisi|notificação prévia", t): return "concentracao_notificada"
    return None

def crawl_adc(c):
    if not SINCE:
        c.execute("DELETE FROM decisions WHERE body='adc'")
    n = 0
    p = 0
    empty = 0
    while p < 400 and _nreq[0] < MAX_REQ:
        h = get(f"{ADC}/pt/noticias-comunicados-e-intervencoes?page={p}", fresh=bool(SINCE))
        if h is None:
            break
        items = re.findall(r'<a href="(/pt/artigos/[^"]+|/pt/[^"]+)">\s*<div class="content-wrapper">.*?<time datetime="([^"]*)".*?class="title">\s*(.*?)\s*</div>', h, re.S)
        if not items:
            empty += 1
            if empty >= 2:
                break
            p += 1
            continue
        for href, dt, title in items:
            title = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title))).strip()
            kind = adc_kind(title)
            if not kind:
                continue
            d = dt[:10]
            url = ADC + href
            if SINCE and d < cutoff(SINCE):
                continue
            ref = None
            m = re.search(r"(Ccent/\d{4}/\d+)", title)
            if m: ref = m.group(1)
            subject = None
            if m:
                subject = title.split(m.group(1), 1)[1].lstrip(" -–").strip(" *")
            amount = note = None
            if kind in ("sancao", "decisao_judicial", "acusacao"):
                art = get(url)
                if art:
                    body = re.search(r"<main.*?</main>", art, re.S)
                    tx = txt(body.group(0) if body else art)
                    amount, note = parse_amount(tx)
                    if url in AMOUNT_OVERRIDE and kind == "sancao":
                        amount, note = AMOUNT_OVERRIDE[url]
                    if kind == "acusacao":
                        amount = note = None  # acusação não é sanção
                    elif kind == "decisao_judicial" and amount:
                        # confirmação/redução judicial de uma coima já contada na decisão da AdC: não somar
                        note = "referida (não somada, repete a decisão original): " + (note or "")
                        amount = None
            c.execute("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                      ("adc:" + href, "adc", kind, ref, d, int(d[:4]), title, subject, amount, note, url, url))
            n += 1
        c.commit()
        if SINCE and items and max(x[1][:10] for x in items) < cutoff(SINCE):
            break
        p += 1
    return n

# ---------------------------------------------------------------- CNPD
CNPD = "https://www.cnpd.pt"

def crawl_cnpd(c):
    n = 0
    for year in (years_back() if SINCE else range(2026, 2005, -1)):
        pg = 1
        while pg < (3 if SINCE else 30) and _nreq[0] < MAX_REQ:
            u = f"{CNPD}/decisoes/historico-de-decisoes/?year={year}" + (f"&pgd={pg}" if pg > 1 else "")
            h = get(u, fresh=bool(SINCE))
            if h is None:
                break
            cards = re.findall(r'<a href="(/umbraco/surface/cnpdDecision/download/\d+)"[^>]*>\s*<div class="c-card-header-medium">(.*?)</div>\s*<div class="c-card-header">(.*?)</div>\s*(?:<div class="c-card-text">(.*?)</div>)?', h, re.S)
            if not cards:
                break
            for href, head, ent, subj in cards:
                head = html.unescape(re.sub(r"<[^>]+>", "", head)).strip()
                ent = html.unescape(re.sub(r"<[^>]+>", "", ent)).strip()
                subj = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", subj or ""))).strip()
                m = re.match(r"([A-Za-zÀ-ÿ ]+?)\s+(\d+(?:-[A-Z])?/(\d{4}))", head)
                if not m:
                    continue
                kind0 = norm(m.group(1))
                kind = {"deliberacao": "deliberacao", "parecer": "parecer", "diretriz": "diretriz", "regulamento": "regulamento"}.get(kind0)
                if not kind:
                    continue
                subject = ent if (ORG.search(ent) or kind == "parecer") and ent != "Comissão Nacional de Proteção de Dados" else None
                if kind == "deliberacao" and ent and not ORG.search(ent):
                    subject = None
                amount, note = parse_amount(subj)
                title = f"{head} — {subj}" if subj else head
                c.execute("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          ("cnpd:" + href.rsplit("/", 1)[1], "cnpd", kind, m.group(2), None, int(m.group(3)), title[:600], subject, amount, note, CNPD + href, u))
                n += 1
            c.commit()
            if f"pgd={pg + 1}" not in h:
                break
            pg += 1
    return n

# ---------------------------------------------------------------- ERC
ERC = "https://www.erc.pt/pt/deliberacoes/deliberacoes-erc/"

def crawl_erc(c, y0=2014):
    n = 0
    for year in (years_back() if SINCE else range(date.today().year, y0 - 1, -1)):
        for pg in range(1, 4 if SINCE else 80):
            if _nreq[0] >= MAX_REQ:
                return n
            q = f"?pg={pg}&s=1&date_from=01/01/{year}&date_to=31/12/{year}&palavrasChave=" if pg > 1 else f"?s=1&date_from=01/01/{year}&date_to=31/12/{year}&palavrasChave="
            u = ERC + q
            h = get(u, fresh=bool(SINCE))
            if not h:
                break
            items = re.findall(r'<h1 class="item__title">\s*(ERC/(\d{4})/(\d+))\s*\(([^)]*)\)\s*</h1>(.*?)(?=<h1 class="item__title">|<!-- Pagination -->)', h, re.S)
            if not items:
                break
            for ref, yr, num, code, blk in items:
                m = re.search(r'item__desc">\s*(.*?)\s*(?:<div class="tags">|</div>)', blk, re.S)
                title = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1)))).strip() if m else ""
                dm = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", blk)
                d = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}" if dm else None
                dl = re.search(r'href="(https://www\.erc\.pt/document\.php\?id=[^"]+)"', blk)
                tags = re.findall(r'<a href="[^"]*palavrasChave=[^"]*" title="([^"]*)"', blk)
                kind = "contraordenacao" if re.search(r"contraordena|coima", title + " " + " ".join(tags), re.I) else "deliberacao"
                amount, note = parse_amount(title)
                c.execute("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          ("erc:" + ref, "erc", kind, f"{ref} ({code})", d, int(yr), mask_person(title)[:600], None, amount, note,
                           dl.group(1) if dl else u, u))
                n += 1
            c.commit()
            if f"pg={pg + 1}&" not in h:
                break
    return n

# ---------------------------------------------------------------- AMT
def crawl_amt(c):
    u = "https://www.amt-autoridade.pt/decis%C3%B5es/"
    h = get(u, fresh=bool(SINCE))
    if not h:
        return 0
    n = 0
    for yr, href, title, dd in re.findall(r'<td>(\d{4})</td>\s*<td><a[^>]*href="(/media/[^"]+\.pdf)"[^>]*>(.*?)</a></td>\s*<td>\s*(\d{2}/\d{2}/\d{4})', h, re.S):
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        dm = re.match(r"(\d{2})/(\d{2})/(\d{4})", dd)
        d = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}"
        if SINCE and c.execute("SELECT 1 FROM decisions WHERE id = ?", ("amt:" + href,)).fetchone():
            continue
        pdf = get("https://www.amt-autoridade.pt" + href, binary=True)
        amount = note = None
        if pdf:
            tmp = RAW / "amt_tmp.pdf"
            tmp.write_bytes(pdf)
            try:
                tx = subprocess.run(["pdftotext", "-layout", str(tmp), "-"], capture_output=True, timeout=60).stdout.decode("utf-8", "replace")
                amount, note = parse_amount(re.sub(r"\s+", " ", tx))
            except Exception:
                pass
        ent = re.search(r"contra a empresa (.+?)(?:, por alegada|$)", title)
        subject = None
        if ent and ORG.search(ent.group(1)):
            subject = ent.group(1).strip()
        shown = title if subject or not ent else title.replace(ent.group(1), "[pessoa singular/entidade sem forma societária]")
        c.execute("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                  ("amt:" + href, "amt", "contraordenacao", href.rsplit("/", 1)[1], d, int(d[:4]) if d else None, shown[:600], subject, amount, note,
                   "https://www.amt-autoridade.pt" + href, u))
        n += 1
    c.commit()
    return n

# ---------------------------------------------------------------- bloqueios e robots
# pares revistos à mão: infrações distintas (cada comunicado indica «pela presente infração, coima total de …»)
DISTINCT_CASES = {("adc:/pt/artigos/adc-sanciona-auchan-e-leclerc-modelo-continente-pingo-doce-e-fornecedor-comum-por",
                   "adc:/pt/artigos/adc-sanciona-auchan-modelo-continente-pingo-doce-e-beiersdorf-por-concertacao-de-precos")}

def dedupe_cases(c):
    """Mesmo valor, mesmo regulador, <400 dias: é o mesmo caso noutra fase (clemência, publicação). Fica só o primeiro."""
    rows = c.execute("SELECT id, body, date, amount FROM decisions WHERE amount > 0 AND date IS NOT NULL AND body = 'adc' ORDER BY body, date").fetchall()
    seen = {}
    n = 0
    for id_, body, d, a in rows:
        k = (body, round(a))
        if k in seen and (date.fromisoformat(d) - date.fromisoformat(seen[k][1])).days < 400:
            c.execute("UPDATE decisions SET amount=NULL, amount_note=? WHERE id=?",
                      (f"mesmo valor/caso já contado em {seen[k][0]}; não somado", id_))
            n += 1
        else:
            seen[k] = (id_, d)
    c.commit()
    return n

def regression_check(c):
    """Avisos: valores suspeitos (um valor > 250 M€; dois valores do mesmo regulador a <60 dias com >=2 partes comuns)."""
    warns = []
    for id_, body, d, t, a in c.execute("SELECT id, body, date, title, amount FROM decisions WHERE amount > 250000000"):
        if id_ not in VERIFIED:
            warns.append(f"valor > 250 M€: {id_} {a:,.0f} — {t[:80]}")
    rows = c.execute("SELECT id, body, date, title, amount FROM decisions WHERE amount > 0 AND date IS NOT NULL AND kind IN ('sancao','decisao_judicial') ORDER BY body, date").fetchall()
    cap = re.compile(r"\b[A-ZÀ-Ý][\wÀ-ÿ.&-]{2,}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ.&-]+)?")
    stop = {"AdC", "Autoridade", "Concorrência", "Tribunal", "Condena", "Sanciona", "Coima", "Processo"}
    names = lambda t: {n.strip() for n in cap.findall(t) if n.strip().split()[0] not in stop}
    for i, r in enumerate(rows):
        for r2 in rows[i + 1:]:
            if r2[1] != r[1]:
                break
            if (date.fromisoformat(r2[2]) - date.fromisoformat(r[2])).days > 60:
                break
            common = names(r[3]) & names(r2[3])
            if len(common) >= 2 and (r[0], r2[0]) not in DISTINCT_CASES:
                warns.append(f"possível mesmo caso, 2 valores em <60 dias: {r[0]} ({r[4]:,.0f}) / {r2[0]} ({r2[4]:,.0f}) partes comuns {sorted(common)[:4]}")
    for w in warns:
        print("  AVISO regressão:", w)
    c.execute("INSERT OR REPLACE INTO meta VALUES ('warnings', ?)", (json.dumps(warns, ensure_ascii=False),))
    c.commit()
    return warns

def record_blocked(c):
    c.execute("DELETE FROM blocked")
    rows = []
    for slug, short, name, grp, site, *_ in B:
        key = site.rstrip("/")
        rob = None
        try:
            ok = robots_ok(site)
            rp, verdict = _robots.get(urllib.parse.urlsplit(site).scheme + "://" + urllib.parse.urlsplit(site).netloc, (None, "?"))
            rob = "ok" if ok else verdict if verdict != "ok" else "disallow"
        except Exception:
            rob = "?"
        c.execute("UPDATE bodies SET robots=? WHERE slug=?", (rob, slug))
        if rob == "forbidden":
            rows.append((slug, "todo o sítio", site, "robots.txt/servidor respondeu com bloqueio (403) a pedidos automáticos: não recolhido, para respeitar a restrição de acesso"))
    rows += [
        ("anacom", "decisões, sanções, orçamento", "https://www.anacom.pt/", "O servidor devolve 403 a acessos automáticos (incluindo /robots.txt). Não contornado; só administração (mandatos ET) e contratação pública."),
        ("asf", "contraordenações/decisões judiciais", "https://www.asf.com.pt/robots.txt", "robots.txt do ASF proíbe /mercado/infrações-e-sanções/contraordenações e /decisões-judiciais: não recolhido; consulte a página oficial."),
        ("bdp", "sanções/processos de contraordenação", "https://www.bportugal.pt/page/sancoes", "O sítio responde com um desafio anti-robô («A verificar se a ligação é segura»): acesso automatizado não é suportado e não foi contornado."),
        ("cmvm", "sanções e contraordenações", "https://www.cmvm.pt/", "O novo portal é uma aplicação JavaScript (OutSystems) sem HTML de listas; o robots.txt só abre o acesso a motores de pesquisa identificados (Crawl-delay 5). Não recolhido."),
        ("ers", "decisões sancionatórias por ano", "https://www.ers.pt/pt/atividade/intervencao-sancionatoria/", "As listas por ano (coimas, admoestações, pagamento voluntário) são carregadas por JavaScript; o HTML devolvido não contém as decisões."),
        ("anac", "decisões", "https://www.anac.pt/vPT/Generico/decisoes/Paginas/Decisoes_gabjur.aspx", "A página «Decisões» é um índice de áreas (taxas, slots, drones…), sem lista de coimas em HTML."),
        ("erse", "decisões sancionatórias", "https://www.erse.pt/atividade/sancionatoria/sancionatoria/", "A página descreve o regime sancionatório (Lei 9/2013) mas não publica lista de decisões/coimas em HTML."),
        ("*", "orçamento, relatório e contas, pessoal", "", "Relatórios e contas dos reguladores são PDFs heterogéneos; não há CSV/XLSX/HTML comparável. Receitas, despesas e efetivos NÃO foram recolhidos (nada inventado)."),
        ("cnpd", "coimas", "https://www.cnpd.pt/decisoes/historico-de-decisoes/", "O histórico lista deliberações/pareceres/diretrizes (PDF), mas não publica uma lista própria de coimas; só são anotadas coimas quando o texto do sumário a indica."),
        ("provedor", "decisões", "https://www.provedor-jus.pt/", "Sem lista de decisões estruturada recolhida nesta versão."),
    ]
    for r in rows:
        c.execute("INSERT INTO blocked VALUES (?,?,?,?)", r)
    c.commit()

# ---------------------------------------------------------------- main
def main():
    c = open_db()
    print("[reguladores] organismos e registo...")
    nm = load_bodies(c)
    print(f"  {nm}/{len(B)} ligados ao registo por NIF")
    nb, nd = load_board(c)
    print(f"  mandatos duplicados removidos: {dedupe_board(c)}")
    print(f"  administração: {nb} mandatos; DRE: {nd} atos")
    steps = [("adc", crawl_adc), ("amt", crawl_amt), ("cnpd", crawl_cnpd), ("erc", crawl_erc)]
    only = os.environ.get("REGUL_ONLY")
    for k, fn in steps:
        if only and k not in only.split(","):
            continue
        print(f"[reguladores] {k}...", flush=True)
        try:
            print(f"  {k}: {fn(c)} decisões")
        except Exception as e:
            print(f"  {k}: ERRO {e!r}")
    record_blocked(c)
    print(f"  deduplicados: {dedupe_cases(c)}")
    regression_check(c)
    c.execute("INSERT OR REPLACE INTO meta VALUES ('updated', ?)", (date.today().isoformat(),))
    c.execute("INSERT OR REPLACE INTO meta VALUES ('matched', ?)", (f"{nm}/{len(B)}",))
    c.commit()
    ultima = c.execute("SELECT MAX(date) FROM decisions WHERE date <= date('now')").fetchone()[0]
    c.close()
    if SINCE:
        report(ultima)

if __name__ == "__main__":
    main()
