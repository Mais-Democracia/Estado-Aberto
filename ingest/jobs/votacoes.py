"""Votações e processo legislativo da Assembleia da República -> data/votacoes.db

REAL DATA, scraped from the ordinary public pages of www.parlamento.pt (the open-data JSON files sit behind
opaque rotating URLs on app.parlamento.pt and are unreachable from here):

  * /ActividadeParlamentar/Paginas/IniciativasLegislativas.aspx   search form (ASP.NET postback):
        legislature x initiative type -> paged list (10 per page) of type / number / session / authorship / title / BID
  * /ActividadeParlamentar/Paginas/DetalheIniciativa.aspx?BID=     one initiative: authors (deputy BIDs), every phase
        (date, event, committee, rapporteurs with deputy BID, committee and plenary votes with the party-by-party
        sense "A Favor / Contra / Abstenção / Ausência", DAR/DR publication references, joint discussions)

The AR publishes votes by parliamentary group (GP). Individual deputies only appear when they vote differently
from their group (the detail string then names them, e.g. "Fulano (PS)"); there is no roll-call per deputy.

Env: VOTACOES_LEGS=XVII,XVI,XV  (legislatures, in crawl order)
     VOTACOES_TYPES=P,J,S,R,D,A,I,C,G,U,F  (AR type codes, in crawl order)
     VOTACOES_MAX_REQ=N  (max network requests per run, default 2500; the run is resumable, cache in data/raw/votacoes/)
     VOTACOES_SLEEP=seconds between requests (default 1.1)  VOTACOES_REFRESH_H=hours before open initiatives are refetched (72)
     VOTACOES_OFFLINE=1  (rebuild the DB from the cache only)
"""
import gzip
import html
import http.cookiejar
import json
import os
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import ROOT  # noqa: E402

NAME = "votacoes"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
BASE = "https://www.parlamento.pt"
LIST_URL = BASE + "/ActividadeParlamentar/Paginas/IniciativasLegislativas.aspx"
DET_URL = BASE + "/ActividadeParlamentar/Paginas/DetalheIniciativa.aspx?BID="
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 (politica-pt civic project; contact@example.org)"
SLEEP = float(os.environ.get("VOTACOES_SLEEP", "1.1"))
REFRESH_H = float(os.environ.get("VOTACOES_REFRESH_H", "72"))
MAX_REQ = int(os.environ.get("VOTACOES_MAX_REQ", "2500"))
WORKERS = int(os.environ.get("VOTACOES_WORKERS", "4"))
OFFLINE = os.environ.get("VOTACOES_OFFLINE") == "1"
LEGS = [x for x in os.environ.get("VOTACOES_LEGS", "XVII,XVI,XV").split(",") if x]
TYPES = [x for x in os.environ.get("VOTACOES_TYPES", "P,J,S,R,D,A,I,C,G,U,F").split(",") if x]
CURRENT_LEG = "XVII"
# end dates as listed on the AR initiatives search page (Legislatura XVI [2024-03-26 a 2025-06-02] ...)
LEG_END = {"XVI": "2025-06-02", "XV": "2024-03-25", "XIV": "2022-03-28", "XIII": "2019-10-24", "XII": "2015-10-22", "XI": "2011-06-19", "X": "2009-10-14"}
# seats per parliamentary group at the start of each legislature. XVII: AR composition 2026; XVI/XV: data/eleicoes.db
# (leg-2024 / leg-2022, level 'nacional'); the AD/PSD coalition lists are split into PSD + CDS-PP with the CDS-PP seats below.
LEG_START = [("XVII", "2025-06-03"), ("XVI", "2024-03-26"), ("XV", "2022-03-29"), ("XIV", "2019-10-25")]
SEATS_XVII = {"PSD": 89, "CH": 60, "PS": 58, "IL": 9, "L": 6, "PCP": 3, "CDS-PP": 2, "BE": 1, "PAN": 1, "JPP": 1}
CDS_SEATS = {"XVI": 2, "XV": 0}
LEG_ELECTION = {"XVI": "leg-2024", "XV": "leg-2022"}
_SEATS = {}


def seats_for(leg):
    if leg in _SEATS:
        return _SEATS[leg]
    out = None
    if leg == "XVII":
        out = dict(SEATS_XVII)
    elif leg in LEG_ELECTION and (ROOT / "data" / "eleicoes.db").exists():
        e = sqlite3.connect(f"file:{ROOT / 'data' / 'eleicoes.db'}?mode=ro", uri=True)
        out = {}
        for party, m in e.execute("SELECT party, mandates FROM results WHERE election_id = ? AND level = 'nacional' AND mandates > 0", (LEG_ELECTION[leg],)):
            code = "PSD" if "PSD" in party else {"PCP-PEV": "PCP", "B.E.": "BE"}.get(party, party)
            out[code] = out.get(code, 0) + m
        e.close()
        if out:
            out["PSD"] -= CDS_SEATS.get(leg, 0)
            if CDS_SEATS.get(leg):
                out["CDS-PP"] = CDS_SEATS[leg]
    _SEATS[leg] = out
    return out


def seat_check(leg, resultado, rows):
    """1 = the recorded result contradicts the recorded group positions (favour seats <= against seats but 'Aprovado', or the reverse);
    0 = consistent; None = not checkable (unknown seats, split group, no positions)."""
    seats = seats_for(leg)
    res = norm(resultado or "")
    if not seats or not (res.startswith("aprovad") or res.startswith("rejeitad")):
        return None
    if any(k == "dividido" for _, _, k, _, _ in rows):
        return None
    tot = {"favor": 0, "contra": 0, "abstencao": 0}
    counted = {r[0] for r in rows if r[2] == "parcial"}  # "21-PSD": a count is given for (part of) that group
    taken = {}  # deputies of a group recorded apart from the group's own position (counts, or named deputies)
    for p, sense, kind, nome, n in rows:
        if sense not in tot and sense != "ausencia":
            continue
        if kind == "parcial":
            if sense in tot:
                tot[sense] += n or 0
            taken[p] = taken.get(p, 0) + (n or 0)
        elif kind == "dep" and p not in counted:  # named deputies are listed in addition to the counts when counts exist
            if sense in tot:
                tot[sense] += 1
            taken[p] = taken.get(p, 0) + 1
    for p, sense, kind, nome, n in rows:
        if kind == "gp" and sense in tot:
            if p not in seats:
                return None
            tot[sense] += max(seats[p] - taken.get(p, 0), 0)
    if not any(tot.values()):  # only absences recorded (typically "Aprovado por unanimidade")
        return None if "unanim" in res else None
    if "unanim" in res:
        return 1 if tot["contra"] or (tot["favor"] == 0) else 0
    if res.startswith("aprovad"):
        return 1 if tot["favor"] <= tot["contra"] else 0
    return 1 if tot["favor"] > tot["contra"] else 0
TYPE_NAMES = {"P": "Proposta de Lei", "J": "Projeto de Lei", "C": "Projeto de Revisão Constitucional",
              "A": "Apreciação Parlamentar", "I": "Inquérito Parlamentar", "S": "Proposta de Resolução",
              "R": "Projeto de Resolução", "U": "Iniciativa Popular de Referendo", "G": "Projeto de Regimento",
              "D": "Projeto de Deliberação", "F": "Ratificação"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS iniciativas (
  bid INTEGER PRIMARY KEY, key TEXT, tipo TEXT, numero INTEGER, leg TEXT, sessao INTEGER, titulo TEXT,
  autoria TEXT, origem TEXT, autores_json TEXT, n_fases INTEGER, n_votos INTEGER,
  data_entrada TEXT, data_ultima TEXT, ultima_fase TEXT, estado TEXT, resultado_generalidade TEXT,
  resultado_final TEXT, data_votacao_final TEXT, lei_ref TEXT, dr_ref TEXT, dr_date TEXT, dre_act_id TEXT,
  final INTEGER DEFAULT 0, fetched_at TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS ini_key ON iniciativas(key);
CREATE INDEX IF NOT EXISTS ini_leg ON iniciativas(leg, tipo, numero);
CREATE TABLE IF NOT EXISTS fases (
  bid INTEGER, ord INTEGER, data TEXT, fase TEXT, comissao TEXT, competente INTEGER, obs TEXT,
  publicacoes TEXT, texto_titulo TEXT, texto_tipo TEXT, source_url TEXT, diploma_bid INTEGER, PRIMARY KEY (bid, ord)
);
CREATE INDEX IF NOT EXISTS fases_data ON fases(data);
CREATE TABLE IF NOT EXISTS votos (
  id INTEGER PRIMARY KEY, bid INTEGER, ord INTEGER, data TEXT, fase TEXT, orgao TEXT, reuniao TEXT,
  resultado TEXT, unanime INTEGER, favor TEXT, contra TEXT, abstencao TEXT, ausencia TEXT,
  detalhe TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS votos_bid ON votos(bid);
CREATE INDEX IF NOT EXISTS votos_data ON votos(data);
-- one row per (vote, group or named deputy). kind: gp = parliamentary group, dep = named deputy, parcial = "n-PARTY"
CREATE TABLE IF NOT EXISTS voto_partido (
  voto_id INTEGER, partido TEXT, sentido TEXT, kind TEXT, nome TEXT, n INTEGER
);
CREATE INDEX IF NOT EXISTS vp_voto ON voto_partido(voto_id);
CREATE INDEX IF NOT EXISTS vp_partido ON voto_partido(partido, sentido);
CREATE TABLE IF NOT EXISTS relatores (bid INTEGER, ord INTEGER, comissao TEXT, dep_bid INTEGER, nome TEXT, partido TEXT, motivo TEXT);
CREATE INDEX IF NOT EXISTS rel_dep ON relatores(dep_bid);
CREATE TABLE IF NOT EXISTS autores (bid INTEGER, dep_bid INTEGER, nome TEXT, partido TEXT);
CREATE INDEX IF NOT EXISTS aut_dep ON autores(dep_bid);
CREATE TABLE IF NOT EXISTS conjuntas (bid INTEGER, ord INTEGER, outro_bid INTEGER, numero TEXT, autor TEXT, titulo TEXT);
CREATE TABLE IF NOT EXISTS listagem (
  leg TEXT, tipo_code TEXT, bid INTEGER, tipo TEXT, numero TEXT, sessao INTEGER, autoria TEXT, titulo TEXT,
  PRIMARY KEY (leg, tipo_code, bid)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- HTTP
class Budget(Exception):
    pass


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.last = 0.0
        self.n = 0
        self.lock = threading.Lock()

    def _space(self):
        """>= SLEEP seconds between the START of two requests to the host, across all worker threads"""
        with self.lock:
            wait = SLEEP - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.n += 1

    def fetch(self, url, data=None, tries=4, timeout=90):
        if OFFLINE:
            raise Budget("offline")
        if self.n >= MAX_REQ:
            raise Budget("request budget reached")
        err = None
        for i in range(tries):
            self._space()
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9",
                                                                      "Accept-Encoding": "gzip"})
                with self.op.open(req, timeout=timeout) as r:
                    b = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        b = gzip.decompress(b)
                t = b.decode("utf8", "replace")
                if len(t) < 2000:
                    raise RuntimeError("short page")
                return t
            except Exception as e:  # the site tarpits some requests; retry with backoff
                err = e
                time.sleep(4 * (i + 1))
        raise RuntimeError(f"fetch failed {url}: {err}")


def cache_get(name, max_age_h=None):
    f = RAW / (name + ".html.gz")
    if f.exists() and (max_age_h is None or time.time() - f.stat().st_mtime < max_age_h * 3600):
        return gzip.decompress(f.read_bytes()).decode("utf8")
    return None


def cache_put(name, t):
    f = RAW / (name + ".html.gz")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(gzip.compress(t.encode("utf8")))


def hidden_fields(t):
    return {m.group(1): html.unescape(m.group(2))
            for m in re.finditer(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', t)}


def clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"[ \t\r\xa0]+", " ", s).strip()


# ---------------------------------------------------------------- listing
def form_prefix(t):
    m = re.search(r'name="([^"]*\$ctl00\$)ddlLeg"', t)
    return m.group(1) if m else None


def parse_listing(t):
    """-> (total, [ (bid, tipo, numero, sessao, autoria, titulo) ])"""
    m = re.search(r"Resultados de consulta a iniciativas - (\d+) registos", t)
    total = int(m.group(1)) if m else 0
    rows, cur = [], {}
    for m in re.finditer(r'<span class="TextoRegular-Titulo">([^<]+)</span><br />\s*<span class="TextoRegular">(.*?)</span>', t, re.S):
        label = html.unescape(m.group(1)).strip()
        val = m.group(2)
        if label == "Tipo":
            cur = {"tipo": clean(val)}
        elif label == "Número":
            cur["numero"] = clean(val)
        elif label == "Sessão":
            cur["sessao"] = clean(val)
        elif label == "Autoria":
            cur["autoria"] = clean(val)
        elif label == "Título":
            b = re.search(r"DetalheIniciativa\.aspx\?BID=(\d+)", val)
            if b and cur.get("tipo"):
                rows.append((int(b.group(1)), cur.get("tipo"), cur.get("numero"), int(cur["sessao"]) if (cur.get("sessao") or "").isdigit() else None,
                             cur.get("autoria"), clean(val)))
            cur = {}
    return total, rows


def crawl_listing(client, con, leg, code):
    """All pages of one legislature x type. Cached per page; current legislature refreshed every REFRESH_H/3 hours."""
    max_age = None if leg != CURRENT_LEG else max(REFRESH_H / 3, 6)
    base = f"list_{leg}_{code}"
    t = cache_get(base + "_p1", max_age)
    fresh = t is None
    if fresh:
        t0 = client.fetch(LIST_URL)
        P = form_prefix(t0)
        d = hidden_fields(t0)
        d.update({P + "ddlLeg": leg, P + "ddlSL": "", P + "ddlTipoIniciativa": code, P + "txtNumIniciativa": "",
                  P + "txtAssunto": "", P + "btnPesquisar": "Pesquisar", "__EVENTTARGET": "", "__EVENTARGUMENT": ""})
        t = client.fetch(LIST_URL, data=urllib.parse.urlencode(d).encode())
        cache_put(base + "_p1", t)
    total, rows = parse_listing(t)
    allrows = {r[0]: r for r in rows}
    page = 2
    while len(allrows) < total and page <= 400:
        tp = cache_get(f"{base}_p{page}", max_age) if not fresh else None
        if tp is None:
            m = re.search(r"__doPostBack\(&#39;([^&]*dpgResults[^&]*)&#39;,&#39;&#39;\)\">%d</a>" % page, t)
            if not m:
                m = re.search(r"__doPostBack\(&#39;([^&]*dpgResults[^&]*)&#39;,&#39;&#39;\)\">(?:&gt;|>)</a>", t)
            if not m:
                break
            P = form_prefix(t)
            d = hidden_fields(t)
            d.update({P + "ddlLeg": leg, P + "ddlSL": "", P + "ddlTipoIniciativa": code, P + "txtNumIniciativa": "",
                      P + "txtAssunto": "", "__EVENTTARGET": m.group(1), "__EVENTARGUMENT": ""})
            tp = client.fetch(LIST_URL, data=urllib.parse.urlencode(d).encode())
            cache_put(f"{base}_p{page}", tp)
            fresh = True  # later cached pages may belong to an older listing: refetch the chain
        t = tp
        _, r = parse_listing(t)
        if not r:
            break
        for x in r:
            allrows[x[0]] = x
        page += 1
    for bid, tipo, numero, sessao, autoria, titulo in allrows.values():
        con.execute("INSERT OR REPLACE INTO listagem VALUES (?,?,?,?,?,?,?,?)", (leg, code, bid, tipo, numero, sessao, autoria, titulo))
    con.commit()
    return total, len(allrows)


# ---------------------------------------------------------------- detail parser (pure)
PARTY_RE = re.compile(r"^(?:PSD|PS|CH|IL|L|PCP|BE|B\.E\.|CDS-PP|CDS–PP|PAN|JPP|PEV|Livre|LIVRE|Ninsc|N insc|CDS|PPD/PSD|PRD|UDP|MDP/CDE|PSN|ID|UEDS|ASDI|PPM|PSR|CH)$")
SENSES = {"a favor": "favor", "contra": "contra", "abstenção": "abstencao", "abstencao": "abstencao", "ausência": "ausencia", "ausencia": "ausencia"}
PARTY_NORM = {"B.E.": "BE", "CDS–PP": "CDS-PP", "Livre": "L", "LIVRE": "L", "PPD/PSD": "PSD", "N insc": "Ninsc"}


def parse_vote_detail(det):
    """'Contra:<I>L</I>, <I> PCP</I><BR>A Favor: <I>PSD</I>' -> [(sense, token)]"""
    out = []
    txt = re.sub(r"<br\s*/?>", "\n", det or "", flags=re.I)
    for m in re.finditer(r"(A Favor|Contra|Absten[çc][ãa]o|Aus[êe]ncia)\s*:\s*(.*?)(?=(?:A Favor|Contra|Absten[çc][ãa]o|Aus[êe]ncia)\s*:|$)", txt, re.S):
        sense = SENSES[m.group(1).lower()]
        body = m.group(2)
        toks = re.findall(r"<i>(.*?)</i>", body, re.I | re.S) or body.split(",")
        for tok in toks:
            tok = clean(tok).strip(" ,.")
            if tok:
                out.append((sense, tok))
    return out


def classify_token(tok):
    """-> (kind, partido, nome, n)"""
    t = tok.strip()
    if PARTY_RE.match(t):
        return "gp", PARTY_NORM.get(t, t), None, None
    m = re.match(r"^(\d+)\s*-\s*(.+)$", t)
    if m and PARTY_RE.match(m.group(2).strip()):
        p = m.group(2).strip()
        return "parcial", PARTY_NORM.get(p, p), None, int(m.group(1))
    m = re.match(r"^(.+?)\s*\(([^()]+)\)$", t)
    if m:
        p = m.group(2).strip()
        return "dep", PARTY_NORM.get(p, p), m.group(1).strip(), 1
    return "outro", None, t, None


def _span(chunk, suffix):
    m = re.search(r'<span id="[^"]*%s"[^>]*>(.*?)</span>' % suffix, chunk, re.S)
    return clean(m.group(1)) if m else ""


def parse_detail(t):
    a = t.find('id="ctl00_ctl51_g_')
    body = t[a:] if a >= 0 else t
    d = {"titulo": "", "tipo_numero": "", "autores": [], "autor_txt": "", "fases": []}
    m = re.search(r'<span id="[^"]*_ctl00_ucLinkDocumento_lblDocumentoTitulo"[^>]*>(.*?)</span>', body, re.S)
    d["titulo"] = clean(m.group(1)) if m else ""
    m = re.search(r'<span id="[^"]*_ctl00_lblTitulo"[^>]*>(.*?)</span>', body, re.S)
    d["tipo_numero"] = clean(m.group(1)) if m else ""
    for m in re.finditer(r'rptAutores_ctl\d+_hplAutor"[^>]*href="[^"]*BID=(\d+)"[^>]*>(.*?)</a>', body, re.S):
        nm = clean(m.group(2))
        pm = re.match(r"^(.*?)\s*\(([^()]+)\)$", nm)
        d["autores"].append((int(m.group(1)), pm.group(1) if pm else nm, PARTY_NORM.get(pm.group(2), pm.group(2)) if pm else None))
    d["autor_txt"] = _span(body, r"_ctl00_lblAutor")
    starts = [(mm.start(), mm.group(1)) for mm in re.finditer(r'<span id="[^"]*_rptFases_(ctl\d+)_lblData"', body)]
    for i, (pos, ctl) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(body)
        c = body[pos:end]
        f = {"data": _span(c, ctl + "_lblData"), "fase": _span(c, ctl + "_lblEvento"), "obs": _span(c, ctl + "_lblObs"),
             "comissao": _span(c, "ucActividadeComissao_lblNome"),
             "competente": 1 if _span(c, "ucActividadeComissao_lblComissaoCompetente") else 0,
             "texto_titulo": _span(c, "ucTexto_lblTitulo"), "texto_tipo": _span(c, "ucTexto_hplTipoNumero"),
             "publicacoes": [], "votos": [], "relatores": [], "conjuntas": []}
        if not f["texto_tipo"]:
            m = re.search(r'ucTexto_hplTipoNumero"[^>]*>(.*?)</a>', c, re.S)
            f["texto_tipo"] = clean(m.group(1)) if m else ""
        m = re.search(r'ucTexto_hplTipoNumero"[^>]*href="[^"]*DetalheDiplomaAprovado\.aspx\?BID=(\d+)"', c)
        f["diploma_bid"] = int(m.group(1)) if m else None
        for pm in re.finditer(r">\s*(\[(?:DAR|DR|Separata)[^\]<]*\])\s*<", c):
            p = re.sub(r"\s+", " ", html.unescape(pm.group(1)))
            if p not in f["publicacoes"]:
                f["publicacoes"].append(p)
        for vm in re.finditer(r'<span id="[^"]*(rptVotacoes_ctl\d+)(_ucVotacao)?_lblReuniao"[^>]*>(.*?)</span>(.*?)(?=<span id="[^"]*rptVotacoes_ctl\d+(?:_ucVotacao)?_lblReuniao"|$)', c, re.S):
            reu = clean(vm.group(3))
            rest = vm.group(4)
            res = _span(rest, r"_lblResultado")
            dm = re.search(r'<span id="[^"]*_lblDetalhes"[^>]*>(.*?)</span>', rest, re.S)
            det = dm.group(1) if dm else ""
            orgao = "Comissão" if "ucActividadeComissao" in vm.group(0)[:300] or re.search(r"reuni[ãa]o da Comiss", reu, re.I) else "Plenário"
            dt = re.search(r"(\d{4}-\d{2}-\d{2})", reu)
            f["votos"].append({"reuniao": reu, "data": dt.group(1) if dt else f["data"], "resultado": res, "orgao": orgao,
                               "unanime": 1 if re.search(r"unanimidade", res + " " + clean(det), re.I) else 0,
                               "detalhe": clean(det), "tokens": parse_vote_detail(det)})
        for rm in re.finditer(r'dtrptrRelatores_(ctl\d+)_hplRelatores"[^>]*href="[^"]*BID=(\d+)"[^>]*>(.*?)</a>', c, re.S):
            nm = clean(rm.group(3))
            pm = re.match(r"^(.*?)\s*\(([^()]+)\)$", nm)
            mot = _span(c, "dtrptrRelatores_%s_lblMotivo" % rm.group(1))
            f["relatores"].append((int(rm.group(2)), pm.group(1) if pm else nm, PARTY_NORM.get(pm.group(2), pm.group(2)) if pm else None, mot))
        for cm in re.finditer(r'rptDiscussoesConjuntas_(ctl\d+)_lblNumero"[^>]*>(.*?)</span>', c, re.S):
            k = cm.group(1)
            hm = re.search(r'rptDiscussoesConjuntas_%s_hplTitulo"[^>]*href="[^"]*BID=(\d+)"[^>]*>(.*?)</a>' % k, c, re.S)
            f["conjuntas"].append((int(hm.group(1)) if hm else None, clean(cm.group(2)), _span(c, "rptDiscussoesConjuntas_%s_lblAutor" % k),
                                   clean(hm.group(2)) if hm else ""))
        d["fases"].append(f)
    return d


# ---------------------------------------------------------------- derived status
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s).strip()


def derive(d):
    """estado, results, publication reference from the phases (only facts present in the page)."""
    fases = d["fases"]
    out = {"estado": None, "res_gen": None, "res_final": None, "data_final": None, "lei_ref": None, "dr_ref": None, "dr_date": None}
    for f in fases:
        fn = norm(f["fase"])
        pv = [v for v in f["votos"] if v["orgao"] == "Plenário"]
        if "generalidade" in fn and "votacao" in fn and pv:
            out["res_gen"] = pv[-1]["resultado"]
        if "votacao final global" in fn and pv:
            out["res_final"], out["data_final"] = pv[-1]["resultado"], pv[-1]["data"]
        if "votacao deliberacao" in fn and pv:  # single plenary vote on a resolution discussed in committee
            delib = (pv[-1]["resultado"], pv[-1]["data"])
            out.setdefault("_delib", delib)
            out["_delib"] = delib
        if "publicacao dr" in fn or "(publicacao dr)" in fn or re.search(r"\bdr\)$", fn):
            for p in f["publicacoes"]:
                if p.startswith("[DR"):
                    out["dr_ref"] = p
                    out["dr_date"] = f["data"]
            out["lei_ref"] = f["texto_tipo"] or out["lei_ref"]
    delib = out.pop("_delib", None)
    if delib and not out["res_final"]:
        out["res_final"], out["data_final"] = delib
    names = [norm(f["fase"]) for f in fases]
    last = names[-1] if names else ""
    allv = " ".join(names)
    if out["dr_ref"]:
        out["estado"] = "Publicado"
    elif re.search(r"\bveto\b", allv):
        out["estado"] = "Vetado"
    elif any(x in allv for x in ("promulgacao", "envio para promulgacao", "decreto da assembleia")):
        out["estado"] = "Aprovado (aguarda publicação)" if out["res_final"] and "aprovad" in norm(out["res_final"]) else "Em promulgação"
    elif out["res_final"]:
        out["estado"] = "Aprovado" if "aprovad" in norm(out["res_final"]) else ("Rejeitado" if "rejeitad" in norm(out["res_final"]) else out["res_final"])
    elif out["res_gen"] and "rejeitad" in norm(out["res_gen"]):
        out["estado"] = "Rejeitado na generalidade"
    elif "retirad" in allv:
        out["estado"] = "Retirado"
    elif "caducad" in allv or "caducidade" in allv:
        out["estado"] = "Caducado"
    elif out["res_gen"]:
        out["estado"] = "Em especialidade" if "aprovad" in norm(out["res_gen"]) else out["res_gen"]
    elif "baixa comissao" in allv:
        out["estado"] = "Em comissão"
    elif fases:
        out["estado"] = "Em apreciação"
    if "rejeitad" in last or "rejeicao" in last:
        out["estado"] = "Rejeitado"
    return out


def is_final(leg, der):
    return leg != CURRENT_LEG or (der["estado"] in ("Publicado", "Rejeitado", "Rejeitado na generalidade", "Retirado", "Caducado"))


# ---------------------------------------------------------------- store
def store(con, bid, lst, d, leg, code, fetched_at):
    src = DET_URL + str(bid)
    tipo = lst[1] if lst else TYPE_NAMES.get(code)
    num = (lst[2] if lst else "") or ""
    m = re.match(r"(\d+)", num)
    numero = int(m.group(1)) if m else None
    key = f"{tipo}|{numero}|{leg}" if numero is not None else None
    der = derive(d)
    for tbl in ("fases", "relatores", "autores", "conjuntas"):
        con.execute(f"DELETE FROM {tbl} WHERE bid=?", (bid,))
    con.execute("DELETE FROM voto_partido WHERE voto_id IN (SELECT id FROM votos WHERE bid=?)", (bid,))
    con.execute("DELETE FROM votos WHERE bid=?", (bid,))
    nv = 0
    for i, f in enumerate(d["fases"]):
        con.execute("INSERT INTO fases (bid, ord, data, fase, comissao, competente, obs, publicacoes, texto_titulo, texto_tipo, source_url, diploma_bid) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (bid, i, f["data"] or None, f["fase"], f["comissao"] or None, f["competente"],
                    f["obs"] or None, json.dumps(f["publicacoes"], ensure_ascii=False) if f["publicacoes"] else None,
                    f["texto_titulo"] or None, f["texto_tipo"] or None, src, f.get("diploma_bid")))
        for r in f["relatores"]:
            con.execute("INSERT INTO relatores VALUES (?,?,?,?,?,?,?)", (bid, i, f["comissao"] or None, r[0], r[1], r[2], r[3] or None))
        for cj in f["conjuntas"]:
            con.execute("INSERT INTO conjuntas VALUES (?,?,?,?,?,?)", (bid, i, cj[0], cj[1], cj[2], cj[3]))
        seen = set()
        for v in f["votos"]:
            sig = (v["reuniao"], v["resultado"], v["detalhe"])
            if sig in seen:  # the source sometimes repeats the same vote block inside one phase
                continue
            seen.add(sig)
            groups = {"favor": [], "contra": [], "abstencao": [], "ausencia": []}
            rows = []
            for sense, tok in v["tokens"]:
                kind, p, nome, n = classify_token(tok)
                groups[sense].append(tok)
                rows.append((p, sense, kind, nome, n))
            # a group listed (without a count) under two senses = split group: kind 'dividido' (the source does not say who)
            gp_senses = {}
            for p, sense, kind, nome, n in rows:
                if kind == "gp":
                    gp_senses.setdefault(p, set()).add(sense)
            split = {p for p, ss in gp_senses.items() if len(ss - {"ausencia"}) > 1}
            rows = [(p, sense, "dividido" if kind == "gp" and p in split else kind, nome, n) for p, sense, kind, nome, n in rows]
            cur = con.execute("INSERT INTO votos (bid, ord, data, fase, orgao, reuniao, resultado, unanime, favor, contra, abstencao, ausencia, detalhe, source_url) "
                              "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (bid, i, v["data"], f["fase"], v["orgao"], v["reuniao"], v["resultado"] or None, v["unanime"],
                               ", ".join(groups["favor"]) or None, ", ".join(groups["contra"]) or None,
                               ", ".join(groups["abstencao"]) or None, ", ".join(groups["ausencia"]) or None, v["detalhe"] or None, src))
            for r in rows:
                con.execute("INSERT INTO voto_partido VALUES (?,?,?,?,?,?)", (cur.lastrowid,) + r)
            if v["orgao"] == "Plenário":  # seats of the legislature in office on the vote date (carried-over initiatives)
                vleg = next((lg for lg, st in LEG_START if (v["data"] or "") >= st), leg)
                con.execute("UPDATE votos SET inconsistente = ? WHERE id = ?", (seat_check(vleg, v["resultado"], rows), cur.lastrowid))
            nv += 1
    for a in d["autores"]:
        con.execute("INSERT INTO autores VALUES (?,?,?,?)", (bid, a[0], a[1], a[2]))
    autoria = (lst[4] if lst else None) or d["autor_txt"].replace("Autor:", "").strip() or None
    if d["autores"]:
        origem = "Deputados"
    elif autoria and re.search(r"governo", autoria, re.I):
        origem = "Governo"
    elif autoria and re.search(r"cidad", autoria, re.I):
        origem = "Cidadãos"
    elif autoria and re.search(r"ALR|Assembleia Legislativa", autoria):
        origem = "Assembleia Legislativa Regional"
    else:
        origem = autoria
    fases = d["fases"]
    fim = LEG_END.get(leg)
    transitou = 0
    if fim and leg != CURRENT_LEG:
        # regional-assembly and citizens' initiatives do not lapse at the end of the legislature: they carry over
        transitou = 1 if any((f["data"] or "") > fim for f in fases) and origem in ("Assembleia Legislativa Regional", "Cidadãos") else 0
        if not transitou:
            if any((f["data"] or "") > fim for f in fases):  # never derive a status from phases after the end
                d = dict(d, fases=[f for f in fases if (f["data"] or "") <= fim])
                der = derive(d)
                fases = d["fases"]
            if der["estado"] not in ("Publicado", "Rejeitado", "Rejeitado na generalidade", "Retirado", "Caducado", "Vetado"):
                der["estado"] = ("Aprovado, sem publicação registada" if (der["estado"] or "").startswith("Aprovado") else "Não concluído") + " — legislatura terminada"
    con.execute("INSERT OR REPLACE INTO iniciativas (bid, key, tipo, numero, leg, sessao, titulo, autoria, origem, autores_json, n_fases, n_votos, data_entrada, data_ultima, ultima_fase, estado, resultado_generalidade, resultado_final, data_votacao_final, lei_ref, dr_ref, dr_date, dre_act_id, final, fetched_at, source_url) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (bid, key, tipo, numero, leg, lst[3] if lst else None, (lst[5] if lst and lst[5] else None) or d["titulo"] or None, autoria, origem,
                 json.dumps([{"bid": a[0], "nome": a[1], "partido": a[2]} for a in d["autores"]], ensure_ascii=False),
                 len(fases), nv, fases[0]["data"] if fases else None, max((f["data"] for f in fases if f["data"]), default=None),
                 fases[-1]["fase"] if fases else None, der["estado"], der["res_gen"], der["res_final"], der["data_final"],
                 der["lei_ref"], der["dr_ref"], der["dr_date"], None, 1 if is_final(leg, der) else 0, fetched_at, src))
    con.execute("UPDATE iniciativas SET leg_fim = ?, transitou = ? WHERE bid = ?", (fim if leg != CURRENT_LEG else None, transitou, bid))


DIP_URL = BASE + "/ActividadeParlamentar/Paginas/DetalheDiplomaAprovado.aspx?BID="
NUM_RE = re.compile(r"^(Lei Orgânica|Lei Constitucional|Lei|Resolução da Assembleia da República|Deliberação da Assembleia da República)\s*(?:n\.?\s*º\s*)?(\d+(?:-[A-Z]+)?/\d{4})\s*$")


def resolve_diplomas(client, con):
    """Published initiatives whose AR page names the act without its number (e.g. 'Resolução da Assembleia da República'):
    read the AR 'texto aprovado' page (DetalheDiplomaAprovado.aspx), whose heading is 'Resolução da Assembleia da República 155/2026'."""
    rows = con.execute("""SELECT i.bid, (SELECT f.diploma_bid FROM fases f WHERE f.bid = i.bid AND f.diploma_bid IS NOT NULL
                          AND f.publicacoes LIKE '%[DR%' ORDER BY f.ord DESC LIMIT 1) dip FROM iniciativas i WHERE i.dr_date IS NOT NULL""").fetchall()
    rows = [r for r in rows if r[1]]
    n = 0
    for bid, dip in rows:
        ref = con.execute("SELECT lei_ref FROM iniciativas WHERE bid = ?", (bid,)).fetchone()[0]
        if ref and NUM_RE.match(ref):
            continue
        t = cache_get(f"dip_{dip}")
        if t is None:
            try:
                t = client.fetch(DIP_URL + str(dip))
                cache_put(f"dip_{dip}", t)
            except Budget:
                if OFFLINE:
                    continue
                break
            except Exception as e:
                print(f"diploma {dip} failed: {e}", flush=True)
                continue
        m = re.search(r'_ctl00_lblNumero"[^>]*>(.*?)</span>', t, re.S)
        head = clean(m.group(1)) if m else ""
        if NUM_RE.match(head):
            con.execute("UPDATE iniciativas SET lei_ref = ? WHERE bid = ?", (head, bid))
            n += 1
    con.commit()
    return n


def link_dre(con):
    """DRE act id ONLY for initiatives whose AR page has a Diário da República publication phase, matched by act kind + NUMBER/YEAR
    stated by the AR (on the initiative page or its 'texto aprovado' page). No title/summary matching: several bills can amend the same law."""
    f = ROOT / "data" / "dre.db"
    if not f.exists():
        return 0
    con.execute("UPDATE iniciativas SET dre_act_id = NULL")
    con.execute(f"ATTACH DATABASE 'file:{f}?mode=ro' AS dre")
    n = 0
    for bid, ref in con.execute("SELECT bid, lei_ref FROM iniciativas WHERE dr_date IS NOT NULL AND lei_ref IS NOT NULL").fetchall():
        mn = NUM_RE.match(ref)
        if not mn:
            continue
        r = con.execute("SELECT id FROM dre.acts WHERE kind = ? AND number = ?", (mn.group(1), mn.group(2))).fetchone()
        if r:
            con.execute("UPDATE iniciativas SET dre_act_id = ? WHERE bid = ?", (r[0], bid))
            n += 1
    con.commit()
    con.execute("DETACH DATABASE dre")
    return n


# ---------------------------------------------------------------- main
def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(f"file:{DB}", uri=True, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    if "diploma_bid" not in [r[1] for r in con.execute("PRAGMA table_info(fases)")]:
        con.execute("ALTER TABLE fases ADD COLUMN diploma_bid INTEGER")
    if "inconsistente" not in [r[1] for r in con.execute("PRAGMA table_info(votos)")]:
        con.execute("ALTER TABLE votos ADD COLUMN inconsistente INTEGER")
    cols = [r[1] for r in con.execute("PRAGMA table_info(iniciativas)")]
    if "leg_fim" not in cols:
        con.execute("ALTER TABLE iniciativas ADD COLUMN leg_fim TEXT")
    if "transitou" not in cols:
        con.execute("ALTER TABLE iniciativas ADD COLUMN transitou INTEGER DEFAULT 0")
    client = Client()
    stopped = None
    # 1. listings
    for leg in LEGS:
        for code in TYPES:
            try:
                total, got = crawl_listing(client, con, leg, code)
                print(f"listing {leg} {code}: {got}/{total}", flush=True)
            except Budget as e:
                stopped = str(e)
                break
            except Exception as e:
                print(f"listing {leg} {code} failed: {e}", flush=True)
        if stopped:
            break
    # 2. details, in crawl order (legislature, type order), newest first
    order = {c: i for i, c in enumerate(TYPES)}
    lorder = {l: i for i, l in enumerate(LEGS)}
    lst = con.execute("SELECT bid, tipo, numero, sessao, autoria, titulo, leg, tipo_code FROM listagem").fetchall()
    lst.sort(key=lambda r: (lorder.get(r[6], 99), order.get(r[7], 99), -r[0]))
    done = {r[0]: (r[1], r[2]) for r in con.execute("SELECT bid, final, fetched_at FROM iniciativas")}
    n_ok = n_fail = 0
    todo = []

    def put(row, t, fetched):
        nonlocal n_ok, n_fail
        bid, tipo, numero, sessao, autoria, titulo, leg, code = row
        try:
            store(con, bid, (bid, tipo, numero, sessao, autoria, titulo), parse_detail(t), leg, code, fetched)
            n_ok += 1
        except Exception as e:
            n_fail += 1
            print(f"parse {bid} failed: {e}", flush=True)
        if n_ok % 50 == 0:
            con.commit()
            print(f"  {n_ok} stored ({client.n} requests)", flush=True)

    for row in lst:
        bid = row[0]
        f = RAW / f"ini_{bid}.html.gz"
        final = done.get(bid, (0, None))[0]
        if f.exists() and (final or time.time() - f.stat().st_mtime < REFRESH_H * 3600 or OFFLINE or stopped):
            put(row, gzip.decompress(f.read_bytes()).decode("utf8"),
                datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        elif not stopped and not OFFLINE:
            todo.append(row)
        elif f.exists():
            put(row, gzip.decompress(f.read_bytes()).decode("utf8"), None)
    con.commit()

    def get(row):
        t = client.fetch(DET_URL + str(row[0]))
        if "rptFases" not in t and "lblTitulo" not in t:
            raise RuntimeError("no initiative content")
        cache_put(f"ini_{row[0]}", t)
        return t

    print(f"details to fetch: {len(todo)} ({WORKERS} workers)", flush=True)
    for i in range(0, len(todo), 200):  # chunks keep the crawl order and bound the pending futures
        if stopped:
            break
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(get, row): row for row in todo[i:i + 200]}
            for fu in as_completed(futs):
                row = futs[fu]
                try:
                    put(row, fu.result(), now())
                except Budget as e:
                    stopped = str(e)
                except Exception as e:
                    n_fail += 1
                    print(f"detail {row[0]} failed: {e}", flush=True)
    con.commit()
    nr = resolve_diplomas(client, con)
    print(f"act numbers from AR texto-aprovado pages: {nr}", flush=True)
    nd = link_dre(con)
    meta = {"updated_at": now(), "requests": client.n, "stopped": stopped or "", "legs": ",".join(LEGS),
            "listed": con.execute("SELECT COUNT(*) FROM listagem").fetchone()[0],
            "stored": con.execute("SELECT COUNT(*) FROM iniciativas").fetchone()[0], "dre_linked": nd,
            "source": LIST_URL}
    for lg in LEGS:
        st = seats_for(lg)
        if st:
            meta["seats_" + lg] = json.dumps(st)
    for k, v in meta.items():
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, str(v)))
    con.commit()
    print(f"votacoes: {meta}", flush=True)


if __name__ == "__main__":
    main()
