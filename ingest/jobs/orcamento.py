"""Orçamento do Estado: planeado vs executado, por ministério/programa, por classificação económica, receitas fiscais,
saldo e dívida.  Escreve só em data/orcamento.db (cache em data/raw/orcamento/).

Fontes (todas testadas a 2026-10-29):
  * Entidade Orçamental (ex-DGO; www.dgo.gov.pt redireciona para www.eo.gov.pt):
      - Síntese da Execução Orçamental mensal — "Anexo Estatístico" XLSX (2022-…; 2021 e anteriores só em .xls BIFF,
        não lidos). Cada edição traz o acumulado jan-mês do ano corrente e do anterior (revisto), o Orçamento inicial
        e a CGE do ano anterior. Quadros usados: Receita/despesa/saldo por subsetor; Execução orçamental do Estado
        (classificação económica); Receita do Estado (IRS, IRC, IVA…); Despesa efetiva consolidada por Programa.
      - Proposta de Orçamento do Estado (OE2023…OE2027): "Quadros e Gráficos do Relatório" XLSX — receita fiscal,
        despesa por Programa, conta da Administração Central, conta das AP (contas nacionais), dívida, conta de cada
        Programa (classificação económica) e lista de entidades da Administração Central com NIF por Missão de Base
        Orgânica (só OE2027).
  * Eurostat (API JSON): gov_10a_exp (despesa das AP por função COFOG) e gov_10dd_edpt1 (défice e dívida, PDE).
Bloqueado/fora: utao.pt (sem resposta), dados.gov.pt EO datasets são .xls BIFF (duplicam a SEO), transparencia.gov.pt
é SPA (mesmos dados EO).
"""
import json
import re
import sqlite3
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date

from common import ROOT
from _xls import XlsBook

NAME = "orcamento"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
EO = "https://www.eo.gov.pt"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
SLEEP = 1.0
SEO_FIRST_YEAR = 2010          # 2010-2021 em .xls (BIFF, lido por _xls.py); 2022+ em .xlsx; antes de 2010 só PDF
OE_YEARS = range(2023, 2028)
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS blocked (source TEXT, url TEXT, reason TEXT);
-- edições da Síntese da Execução Orçamental (SEO)
CREATE TABLE IF NOT EXISTS seo_editions (year INTEGER, month INTEGER, pub TEXT, url TEXT, PRIMARY KEY (year, month));
-- execução acumulada jan..month (M€). tbl: subsetores|estado|receita_estado|programas ; measure: exec|receita|despesa|saldo
-- lkey = rótulo normalizado + nº de ocorrência na tabela (o mesmo rótulo aparece na receita e na despesa); ord = posição
CREATE TABLE IF NOT EXISTS exec_cum (year INTEGER, month INTEGER, tbl TEXT, lkey TEXT, line TEXT, ord INTEGER, measure TEXT, value REAL,
  edition TEXT, source_url TEXT, PRIMARY KEY (year, month, tbl, lkey, measure));
CREATE INDEX IF NOT EXISTS exec_cum_line ON exec_cum(tbl, line);
-- valores anuais (M€): kind = oe_inicial | cge (conta final) | oe_proposta | estimativa | execucao_final ...
CREATE TABLE IF NOT EXISTS annual (year INTEGER, tbl TEXT, lkey TEXT, line TEXT, ord INTEGER, kind TEXT, value REAL, unit TEXT,
  source TEXT, source_url TEXT, PRIMARY KEY (year, tbl, lkey, kind, source));
-- tabelas genéricas dos relatórios OE (uma linha por célula numérica)
CREATE TABLE IF NOT EXISTS oe_cells (oe INTEGER, tbl TEXT, sheet TEXT, title TEXT, unit TEXT, line TEXT, ord INTEGER, col TEXT,
  colord INTEGER, value REAL, source_url TEXT);
CREATE INDEX IF NOT EXISTS oe_cells_t ON oe_cells(oe, tbl);
CREATE TABLE IF NOT EXISTS edition_vals (year INTEGER, month INTEGER, lkey TEXT, edition TEXT, fmt TEXT, value REAL, PRIMARY KEY (year, month, lkey, edition));
CREATE TABLE IF NOT EXISTS checks (kind TEXT, what TEXT, year INTEGER, month INTEGER, value REAL, expected REAL, diff_pct REAL);
CREATE TABLE IF NOT EXISTS programs (name TEXT PRIMARY KEY, code TEXT, ministry TEXT);
CREATE TABLE IF NOT EXISTS mbo_entities (oe INTEGER, mbo TEXT, ministry TEXT, name TEXT, nif TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS mbo_entities_m ON mbo_entities(ministry);
CREATE INDEX IF NOT EXISTS mbo_entities_n ON mbo_entities(nif);
CREATE TABLE IF NOT EXISTS eurostat (dataset TEXT, code TEXT, label TEXT, year INTEGER, unit TEXT, value REAL, source_url TEXT,
  PRIMARY KEY (dataset, code, year, unit));
"""

# Programa orçamental / Missão de Base Orgânica -> slug do ministério (data/ministerios.db)
MINISTRY_RULES = [
    (r"orgaos de soberania|encargos gerais", None),
    (r"governacao|presidencia do conselho", "presidencia"),
    (r"representacao externa|negocios estrangeiros", "negocios-estrangeiros"),
    (r"gestao da divida|financas", "financas"),
    (r"economia|coesao territorial|planeamento|mar\b.*economia", "economia-e-coesao-territorial"),
    (r"reforma do estado|modernizacao", "reforma-do-estado"),
    (r"assuntos parlamentares", "assuntos-parlamentares"),
    (r"defesa", "defesa-nacional"),
    (r"seguranca interna|administracao interna", "administracao-interna"),
    (r"justica", "justica"),
    (r"ensino|ciencia|educacao", "educacao-ciencia-e-inovacao"),
    (r"saude", "saude"),
    (r"trabalho|solidariedade|seguranca social", "trabalho-solidariedade-e-seguranca-social"),
    (r"infraestruturas|habitacao", "infraestruturas-e-habitacao"),
    (r"ambiente|energia|acao climatica", "ambiente-e-energia"),
    (r"agricultura|alimentacao|pescas|\bmar\b", "agricultura-e-mar"),
    (r"\bcultura\b|juventude|desporto", "cultura-juventude-e-desporto"),
]


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


def ministry_of(name):
    n = norm(re.sub(r"^\s*\d{3}\s*-\s*", "", name or ""))
    for rx, slug in MINISTRY_RULES:
        if re.search(rx, n):
            return slug
    return None


# ---------------------------------------------------------------- HTTP
_last = {}


def fetch(url, dest=None, max_age_days=None, timeout=90):
    """GET com cache em RAW; devolve bytes (ou None em erro)."""
    if dest is not None and dest.exists() and dest.stat().st_size > 0:
        if max_age_days is None or (time.time() - dest.stat().st_mtime) < max_age_days * 86400:
            return dest.read_bytes()
    host = urllib.parse.urlsplit(url).netloc
    wait = SLEEP - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept-Language": "pt-PT,pt;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        print("  ! fetch failed", url, e)
        _last[host] = time.time()
        return None
    _last[host] = time.time()
    if dest is not None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    return data


def quote_url(u):
    p = urllib.parse.urlsplit(u)
    return urllib.parse.urlunsplit((p.scheme, p.netloc, urllib.parse.quote(p.path), p.query, ""))


# ---------------------------------------------------------------- XLSX (stdlib)
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def _col(c):
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n - 1


class Book:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.ss = []
        if "xl/sharedStrings.xml" in self.z.namelist():
            for si in ET.fromstring(self.z.read("xl/sharedStrings.xml")).findall(M + "si"):
                self.ss.append("".join(t.text or "" for t in si.iter(M + "t")))
        wb = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        rmap = {r.get("Id"): r.get("Target") for r in rels}
        self.sheets = []
        for s in wb.find(M + "sheets"):
            t = rmap[s.get(RID)].lstrip("/")
            self.sheets.append((s.get("name"), t if t.startswith("xl/") else "xl/" + t))

    def rows(self, name):
        path = dict(self.sheets)[name]
        out = {}
        for _, el in ET.iterparse(self.z.open(path)):
            if el.tag == M + "c":
                m = re.match(r"([A-Z]+)(\d+)", el.get("r") or "")
                if m:
                    v = el.find(M + "v")
                    t = el.get("t")
                    val = None
                    if t == "s" and v is not None:
                        val = self.ss[int(v.text)]
                    elif t == "inlineStr":
                        val = "".join(x.text or "" for x in el.iter(M + "t"))
                    elif v is not None and v.text is not None:
                        try:
                            val = float(v.text)
                        except ValueError:
                            val = v.text
                    if isinstance(val, str):
                        val = re.sub(r"\s+", " ", val).strip()
                    if val not in (None, ""):
                        out.setdefault(int(m.group(2)), {})[_col(m.group(1))] = val
                el.clear()
        return out


def isnum(v):
    return isinstance(v, float)


def parse_block(rows, start):
    """A partir da linha do título, devolve (unit, headers{col: label}, [(r, label, {col: val})])."""
    keys = sorted(k for k in rows if k > start)
    unit = ""
    hdr_rows, data = [], []
    for r in keys:
        row = rows[r]
        txt = [v for v in row.values() if isinstance(v, str)]
        if any(re.search(r"milh[õo]es|€|euros|percentagem", t, re.I) for t in txt) and not data and not hdr_rows and len(row) <= 2:
            unit = next(t for t in txt if re.search(r"milh|€|euro|percent", t, re.I))
            continue
        nums = {c: v for c, v in row.items() if isnum(v) and not (1990 <= v <= 2035 and float(v).is_integer() and not data and c > 0)}
        strs = {c: v for c, v in row.items() if isinstance(v, str)}
        lbl_c = min(strs) if strs else None
        if data and (not row or (lbl_c is not None and re.match(r"^(notas?|fonte|nota)\b", strs[lbl_c], re.I))):
            break
        if data and lbl_c is not None and re.match(r"^Quadro \d", strs[lbl_c]):
            break
        is_data = lbl_c is not None and nums and lbl_c < min(nums)
        if is_data and not data and sum(1 for c, v in strs.items() if c != lbl_c and len(v.strip()) > 2) >= 2:
            is_data = False                       # linha de cabeçalho com zeros perdidos
        if not data and not is_data:
            only = row[min(row)] if len(row) == 1 else None
            if re.match(r"^\(?per[íi]odo", str(row.get(min(row), "")), re.I) or (len(row) == 1 and (min(row) <= 1 or (
                    isinstance(only, str) and (len(only) > 40 or re.search(r"\((janeiro|per[íi]odo)", only, re.I))))):
                continue
            hdr_rows.append(row)
            continue
        if is_data:
            data.append((r, strs[lbl_c], {c: v for c, v in row.items() if c > lbl_c and isnum(v)}))
        if len(data) > 400:
            break
    # cabeçalhos: propaga etiquetas para a direita (células fundidas) em cada linha
    maxc = max([c for _, _, d in data for c in d] + [0])
    headers = {}
    for row in hdr_rows:
        if all(re.search(r"milh|€", str(v), re.I) for v in row.values()):
            continue
        cur = None
        for c in range(1, maxc + 1):
            if c in row and not (isinstance(row[c], str) and re.search(r"milh[õo]es|€ Milh", row[c], re.I)):
                cur = row[c]
            elif c in row:
                continue
            if cur is not None:
                lab = str(int(cur)) if isnum(cur) and float(cur).is_integer() else str(cur)
                headers.setdefault(c, [])
                if lab not in headers[c]:
                    headers[c].append(lab)
    return unit, {c: " | ".join(v) for c, v in headers.items()}, data


def find_title(rows, rx):
    for r in sorted(rows):
        for v in rows[r].values():
            if isinstance(v, str) and re.search(rx, v, re.I):
                return r, v
    return None, None


# ---------------------------------------------------------------- SEO (execução mensal)
# Títulos dos quadros em três gerações de formato: 2010 ("Quadro 1. Execução orçamental do subsector Estado"),
# 2011-2012 ("Execução Orçamental do Estado"), 2013+ ("5 - Execução Orçamental do Estado").
_Q = r"^(?:Quadro\s*)?(?:\d+\s*[.\-]\s*(?:-\s*)?)?"
SEO_TABLES = [
    ("subsetores", _Q + r"Receita, despesa e saldo das Administra"),
    ("estado", _Q + r"Execução Orçamental do (?:subsector |subsetor )?Estado\s*(?:\((?:janeiro|per[íi]odo)[^)]*\))?\s*$"),
    ("receita_estado", _Q + r"Receita do (?:subsector |subsetor )?Estado\s*(?:\((?:janeiro|per[íi]odo)[^)]*\))?\s*$"),
    ("programas", _Q + r"Despesa Efetiva Consolidada (da Administração Central )?por Programa"),
    ("ministerios", _Q + r"Despesa (?:integral )?do (?:subsector |subsetor )?Estado,? por Minist[ée]rios? e"),
]
# grafia antiga / plurais -> forma atual (para as chaves das linhas)
CANON = {
    "receitas correntes": "receita corrente", "receitas de capital": "receita de capital", "receitas fiscais": "receita fiscal",
    "receitas nao fiscais": "receita nao fiscal", "despesas correntes": "despesa corrente", "despesas de capital": "despesa de capital",
    "aquisicao de bens e servicos correntes": "aquisicao de bens e servicos", "despesa": "despesa efetiva", "receita": "receita efetiva",
    "despesa total": "despesa efetiva", "receita total": "receita efetiva",
}


def canon(nl):
    for a, b in (("directos", "diretos"), ("indirectos", "indiretos"), ("activos", "ativos"), ("subsector", "subsetor"),
                 ("colectivas", "coletivas"), ("efectiva", "efetiva"), ("objectivo", "objetivo"), ("aquisicao de bens e servicos correntes", "aquisicao de bens e servicos")):
        nl = re.sub(r"\b" + a + r"\b", b, nl)
    return CANON.get(nl, nl)


def colkind(h):
    """Classifica uma coluna de cabeçalho -> (kind, year) ou None."""
    hn = norm(h)
    ym = re.findall(r"\b((?:19|20)\d\d)\b", h)
    yr = int(ym[-1]) if ym else None
    if not yr or re.search(r"grau|variac|\bvh\b|tvha|contrib|estrutura|implicit|dezembro|mensal|provisori|\bpp\b|%", hn + " " + h.lower()):
        return None
    if hn.startswith("cge"):
        return ("cge", yr)
    if hn.startswith("orcamento"):
        return ("oe_inicial", yr)
    if hn.startswith("objetivo"):
        return ("oe_objetivo", yr)
    if hn.startswith("estimativa"):
        return ("estimativa", yr)
    if hn.startswith("execucao") or re.fullmatch(r"(19|20)\d\d", hn):
        return ("exec", yr)
    return None


MES_RX = r"(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)"


def mes_idx(s):
    return MESES.index(s.lower().replace("marco", "março")) + 1


def seo_discover(con):
    eds = []
    today = date.today()
    for y in range(SEO_FIRST_YEAR, today.year + 1):
        for i, mes in enumerate(MESES):
            if (y, i + 1) > (today.year, today.month):
                break
            q = urllib.parse.urlencode({"Ano": y, "Mes": mes.capitalize()})
            url = f"{EO}/execucaoorcamental/Paginas/Sintese-da-Execucao-Orcamental-Mensal.aspx?{q}"
            recent = (today.year - y) * 12 + today.month - (i + 1) <= 2
            html = fetch(url, RAW / "seo_pages" / f"{y}-{i + 1:02d}.html", max_age_days=1 if recent else None)
            if not html:
                continue
            links = sorted(set(re.findall(r'"(/execucaoorcamental/SintesedaExecucaoOrcamentalMensal/[^"]+\.xlsx?)"', html.decode("utf-8", "replace"))))
            links = [l for l in links if re.search(r"anexo", l, re.I) and not re.search(r"complementar", l, re.I)
                     and not (re.search(r"_v?uk\.xlsx?$", l, re.I) and "vpt" not in l.lower())]
            links.sort(key=lambda l: (not l.lower().endswith(".xlsx"), "vpt" not in l.lower()))
            if links:
                eds.append((y, i + 1, EO + links[0]))
    return eds


def seo_parse(con, pub_y, pub_m, url):
    fname = urllib.parse.unquote(url.rsplit("/", 1)[1])
    is_xls = fname.lower().endswith(".xls")
    fn = RAW / ("seo_xls" if is_xls else "seo") / fname
    if not fetch(quote_url(url), fn):
        return 0
    try:
        b = XlsBook(fn) if is_xls else Book(fn)
    except Exception as e:  # noqa: BLE001
        print("  ! bad workbook", fn, e)
        return 0
    edition = f"{pub_y}-{pub_m:02d}"
    n = 0
    data_year = data_month = None
    cache = {}
    for tbl, rx in SEO_TABLES:
        for sheet, _ in b.sheets:
            if re.match(r"^(capa|ind|gloss)", sheet, re.I):
                continue
            rows = cache.get(sheet)
            if rows is None:
                rows = cache[sheet] = b.rows(sheet)
            if not rows:
                continue
            r0, title = find_title(rows, rx)
            if r0 is None or r0 > min(rows) + 8:
                continue
            # mês dos dados: "Período: janeiro a agosto", "(Janeiro a Março)", "Agosto de 2026"
            if data_month is None:
                for r in sorted(rows)[:12]:
                    for v in rows[r].values():
                        if not isinstance(v, str):
                            continue
                        m = re.search(MES_RX + r" de (20\d\d)", v, re.I)
                        if m and not re.search(r"janeiro a " + MES_RX + " de", v, re.I) and data_month is None and len(v) < 30:
                            data_month, data_year = mes_idx(m.group(1)), int(m.group(2))
                        m = (re.search(r"janeiro\s+a\s+" + MES_RX + r"(?:\s+de\s+(20\d\d))?", v, re.I) or re.search(r"\(\s*(?:per[íi]odo:?\s*)?" + MES_RX + r"(?:\s+de\s+(20\d\d))?\s*\)", v, re.I)
                             or re.search(r"per[íi]odo:?\s*" + MES_RX + r"(?:\s+de\s+(20\d\d))?\s*$", v, re.I))
                        if m and data_month is None:
                            data_month = mes_idx(m.group(1))
                            if m.lastindex and m.lastindex > 1 and m.group(2):
                                data_year = int(m.group(2))
                if data_month and not data_year:
                    data_year = pub_y if data_month <= pub_m else pub_y - 1
            if data_month is None:
                continue
            unit, headers, data = parse_block(rows, r0)
            if tbl == "ministerios":
                n += seo_ministries(con, headers, data, data_year, data_month, edition, url)
                break
            colmeta = {}
            for c, h in headers.items():
                if tbl == "subsetores":
                    hn = norm(h)
                    ym = re.findall(r"\b(20\d\d)\b", h)
                    g = next((k for k in ("saldo", "receita", "despesa") if hn.startswith(k)), None)
                    if g and ym and "variacao" not in hn:
                        colmeta[c] = ("exec", g, int(ym[-1]))
                else:
                    k = colkind(h)
                    if k:
                        colmeta[c] = (k[0], "exec", k[1])
            if not colmeta:
                continue
            seen, sec = {}, "r"
            for r, line, vals in data:
                nl = canon(norm(re.sub(r"^\s*\d{3}\s*-\s*", "", line)))
                if tbl == "estado":
                    if re.match(r"^(receita|receitas)\b", nl):
                        sec = "r"
                    elif re.match(r"^despesa(s)? (corrente|de capital|efetiva|primaria)|^despesa efetiva$", nl):
                        sec = "d"
                    elif nl.startswith("saldo") or nl.startswith("ativos financeiros") or nl.startswith("passivos"):
                        sec = "s"
                    k = nl + "#" + sec
                else:
                    k = nl + "#"
                seen[k] = seen.get(k, 0) + 1
                lkey = k + (str(seen[k]) if (tbl != "estado" or seen[k] > 1) else "")
                for c, v in vals.items():
                    if c not in colmeta:
                        continue
                    kind, measure, yr = colmeta[c]
                    if kind == "exec":
                        con.execute("""INSERT INTO exec_cum VALUES (?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(year, month, tbl, lkey, measure) DO UPDATE SET value=excluded.value, line=excluded.line, ord=excluded.ord,
                            edition=excluded.edition, source_url=excluded.source_url WHERE excluded.edition >= exec_cum.edition""",
                                    (yr, data_month, tbl, lkey, line, r, measure, v, edition, url))
                        if tbl == "estado" and lkey in ("receita efetiva#r", "despesa efetiva#d", "saldo global#s"):
                            con.execute("INSERT OR REPLACE INTO edition_vals VALUES (?,?,?,?,?,?)", (yr, data_month, lkey, edition, "xls" if is_xls else "xlsx", v))
                    else:
                        con.execute("""INSERT INTO annual VALUES (?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(year, tbl, lkey, kind, source) DO UPDATE SET value=excluded.value, line=excluded.line, ord=excluded.ord,
                            source_url=excluded.source_url""", (yr, tbl, lkey, line, r, kind, v, "M€", "SEO", url))
                    n += 1
            break
    if data_month:
        con.execute("INSERT OR REPLACE INTO seo_editions VALUES (?,?,?,?)", (data_year, data_month, edition, url))
        derive_totals(con, edition, url)
    return n


def seo_ministries(con, headers, data, year, month, edition, url):
    """Quadro 'Despesa do Estado por Ministérios e classificação económica' (2010-2013): uma coluna por ministério."""
    n = 0
    for c, h in headers.items():
        name = h.split(" | ")[-1].strip()
        if re.search(r"total|vh|%|^20\d\d$", name, re.I) or len(name) < 4:
            continue
        for r, line, vals in data:
            nl = canon(norm(line))
            if nl not in ("despesa efetiva", "despesa corrente", "despesa de capital", "despesas com o pessoal", "despesa efetiva consolidada", "total"):
                continue
            if c in vals:
                con.execute("""INSERT INTO exec_cum VALUES (?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(year, month, tbl, lkey, measure) DO UPDATE SET value=excluded.value, edition=excluded.edition, source_url=excluded.source_url
                  WHERE excluded.edition >= exec_cum.edition""",
                            (year, month, "ministerios", norm(name) + "#", name, c, nl, vals[c], edition, url))
                n += 1
    return n


def derive_totals(con, edition, url):
    """Edições antigas não trazem 'receita/despesa efetiva': deriva = corrente + capital (marcado com edition '~derivado')."""
    for tot, a, b2, sec in (("receita efetiva", "receita corrente", "receita de capital", "r"), ("despesa efetiva", "despesa corrente", "despesa de capital", "d")):
        con.execute(f"""INSERT OR IGNORE INTO exec_cum (year, month, tbl, lkey, line, ord, measure, value, edition, source_url)
          SELECT x.year, x.month, 'estado', '{tot}#{sec}', '{tot.capitalize()} (corrente + capital)', 0, 'exec', x.value + y.value, x.edition, x.source_url
          FROM exec_cum x JOIN exec_cum y ON y.year=x.year AND y.month=x.month AND y.tbl='estado' AND y.lkey='{b2}#{sec}' AND y.measure='exec'
          WHERE x.tbl='estado' AND x.lkey='{a}#{sec}' AND x.measure='exec'""")
    con.execute("""INSERT OR IGNORE INTO exec_cum (year, month, tbl, lkey, line, ord, measure, value, edition, source_url)
      SELECT r.year, r.month, 'estado', 'saldo global#s', 'Saldo global (receita - despesa efetiva)', 0, 'exec', r.value - d.value, r.edition, r.source_url
      FROM exec_cum r JOIN exec_cum d ON d.year=r.year AND d.month=r.month AND d.tbl='estado' AND d.lkey='despesa efetiva#d' AND d.measure='exec'
      WHERE r.tbl='estado' AND r.lkey='receita efetiva#r' AND r.measure='exec'""")


def cross_checks(con):
    """1) totais = soma das componentes (±0,5%); 2) sobreposição xls vs xlsx (mesmo mês, edições diferentes)."""
    con.execute("DELETE FROM checks")
    rules = [("estado", "receita efetiva#r", ["receita corrente#r", "receita de capital#r"]),
             ("estado", "despesa efetiva#d", ["despesa corrente#d", "despesa de capital#d"]),
             ("estado", "saldo global#s", ["receita efetiva#r", "-despesa efetiva#d"]),
             ("receita_estado", "receita fiscal#1", ["impostos diretos#1", "impostos indiretos#1"])]
    for tbl, tot, parts in rules:
        for y, m, v in con.execute("SELECT year, month, value FROM exec_cum WHERE tbl=? AND lkey=? AND measure='exec'", (tbl, tot)).fetchall():
            s, ok = 0.0, True
            for p in parts:
                sign = -1 if p.startswith("-") else 1
                r = con.execute("SELECT value FROM exec_cum WHERE tbl=? AND lkey=? AND year=? AND month=? AND measure='exec'", (tbl, p.lstrip("-"), y, m)).fetchone()
                if not r:
                    ok = False
                    break
                s += sign * r[0]
            if ok:
                diff = (v - s) / abs(v) * 100 if v else 0
                con.execute("INSERT INTO checks VALUES (?,?,?,?,?,?,?)", ("soma", tbl + ":" + tot, y, m, v, s, round(diff, 4)))
    for y, in con.execute("SELECT DISTINCT year FROM annual WHERE tbl='cge_organica'").fetchall():
        rows = con.execute("SELECT line, value FROM annual WHERE tbl='cge_organica' AND year=? AND kind='exec' ORDER BY ord", (y,)).fetchall()
        tot = next((v for l, v in rows if re.match(r"^1\.\s*despesa efetiva", l, re.I)), None)
        parts = 0.0
        for l, v in rows:
            if re.match(r"^1\.", l):
                break
            if not re.match(r"^\s*(dos|das|do|da) qua", l, re.I):
                parts += v
        if tot:
            con.execute("INSERT INTO checks VALUES (?,?,?,?,?,?,?)", ("soma", "cge_organica: ministérios = despesa efetiva consolidada", y, 12, tot, parts, round((tot - parts) / tot * 100, 4)))
    for y, m, lk, ex, vx, ey, vy in con.execute("""SELECT a.year, a.month, a.lkey, a.edition, a.value, b.edition, b.value FROM edition_vals a
          JOIN edition_vals b ON b.year=a.year AND b.month=a.month AND b.lkey=a.lkey AND b.fmt='xlsx' WHERE a.fmt='xls'""").fetchall():
        con.execute("INSERT INTO checks VALUES (?,?,?,?,?,?,?)", ("xls_vs_xlsx", f"{lk} {ex} vs {ey}", y, m, vx, vy, round((vx - vy) / abs(vy) * 100, 4) if vy else None))


# ---------------------------------------------------------------- CGE (Conta Geral do Estado)
CGE_FIRST = 2014     # quadros em folha de cálculo a partir da CGE 2014 (antes só PDF)
CGE_TABLES = [
    ("cge_organica", r"Despesa (efetiva )?consolidada da Administração Central,? por classificação orgânica"),
    ("cge_programas", r"Despesa (efetiva )?consolidada da Administração Central,? (-\s*)?por Programa Orçamental\s*$"),
]


def cge_kind(h):
    hn = norm(h)
    if re.search(r"\bvs\b|valor|estrutura|grau|variac|%|\bpp\b", hn + " " + h.lower()) or re.search(r"projetos|atividades", hn):
        return None
    if "orcamento inicial" in hn:
        return "oe_inicial"
    if re.search(r"orcamento (final|corrigido)", hn):
        return "oe_final"
    if re.search(r"cativos|reserva", hn) and "execucao" not in hn:
        return None
    if re.search(r"execucao( orcamental| de (19|20)\d\d|$)", hn) or hn.startswith("execucao"):
        return "exec"
    return None


def cge_parse(con, y):
    page = f"{EO}/politicaorcamental/Paginas/Conta-Geral-do-Estado.aspx?Ano={y}"
    html = fetch(page, RAW / "cge_pages" / f"{y}.html", max_age_days=30 if y >= date.today().year - 2 else None)
    if not html:
        return 0
    links = sorted(set(re.findall(r'"(/politicaorcamental/[^"]+\.xlsx?)"', html.decode("utf-8", "replace"))))
    links = [l for l in links if re.search(r"quadros", l, re.I)]
    n = 0
    for l in links:
        url = EO + l
        fname = urllib.parse.unquote(l.rsplit("/", 1)[1])
        fn = RAW / "cge" / fname
        if not fetch(quote_url(url), fn, timeout=240):
            continue
        try:
            b = XlsBook(fn) if fname.lower().endswith(".xls") else Book(fn)
        except Exception as e:  # noqa: BLE001
            print("  ! CGE bad workbook", fname, e)
            continue
        for sheet, _ in b.sheets:
            if not re.match(r"^\s*(q|quadro)", sheet, re.I):
                continue
            rows = b.rows(sheet)
            if not rows:
                continue
            for tbl, rx in CGE_TABLES:
                r0, title = find_title(rows, rx)
                if r0 is None or r0 > min(rows) + 6:
                    continue
                if con.execute("SELECT 1 FROM annual WHERE year=? AND tbl=? LIMIT 1", (y, tbl)).fetchone():
                    break
                unit, headers, data = parse_block(rows, r0)
                kinds = {c: cge_kind(h) for c, h in headers.items()}
                kinds = {c: k for c, k in kinds.items() if k}
                seen = set()
                for r, line, vals in data:
                    nl = norm(line)
                    for c, k in kinds.items():
                        if c in vals and (nl, k) not in seen:
                            seen.add((nl, k))
                            con.execute("INSERT OR REPLACE INTO annual VALUES (?,?,?,?,?,?,?,?,?,?)",
                                        (y, tbl, nl + "#", line, r, k, vals[c], "M€", f"CGE{y}", url))
                            n += 1
                break
        con.commit()
    return n


# ---------------------------------------------------------------- OE (propostas)
OE_TABLES = [
    ("receita_fiscal", r"^Quadro [\d.]+\.?\s*Receita fiscal do Estado\s*$"),
    ("programas", r"^Quadro [\d.]+\.?\s*Despesa total consolidada (de cada|por) Programa"),
    ("conta_ac", r"^Quadro [\d.]+\.?\s*Conta consolidada da Administração Central"),
    ("despesa_ac", r"^Quadro [\d.]+\.?\s*Evolução da despesa efetiva consolidada da Administração Central"),
    ("conta_ap_nac", r"^Quadro [\d.]+\.?\s*Conta das Administrações Públicas:?\s*\d{4}"),
    ("divida", r"^Quadro [\d.]+\.?\s*Dívida pública\s*$"),
    ("estado_oe", r"^Quadro [\d.]+\.?\s*Orçamento da Entidade Contabilística Estado"),
    ("pl_conta", r"^Quadro [\d.]+\.?\s*.*\((PL|P)\s?\d+\)\s*[—–-]\s*Conta do Programa"),
]


def oe_page(y):
    url = f"{EO}/politicaorcamental/Paginas/OrcamentosEstado.aspx?Ano={y}"
    html = fetch(url, RAW / "oe_pages" / f"{y}.html", max_age_days=7)
    if not html:
        return None, url
    links = re.findall(r'"(/politicaorcamental/[^"]+\.xlsx)"', html.decode("utf-8", "replace"))
    links = [l for l in links if re.search(r"quadros", l, re.I)]
    return (EO + links[0] if links else None), url


def oe_parse(con, y):
    url, page = oe_page(y)
    if not url:
        con.execute("INSERT INTO blocked VALUES (?,?,?)", (f"OE{y} quadros XLSX", page, "ficheiro não encontrado na página"))
        return 0
    fn = RAW / "oe" / urllib.parse.unquote(url.rsplit("/", 1)[1])
    if not fetch(quote_url(url), fn):
        con.execute("INSERT INTO blocked VALUES (?,?,?)", (f"OE{y} quadros XLSX", url, "download falhou"))
        return 0
    b = Book(fn)
    n = 0
    for sheet, _ in b.sheets:
        if not re.match(r"^(Q|EIC-Q)", sheet):
            continue
        rows = b.rows(sheet)
        for tbl, rx in OE_TABLES + [("entidades", r"^Quadro [\w.]+\.?\s*Lista de entidades da Administração Central")]:
            r0, title = find_title(rows, rx)
            if r0 is None or r0 > min(rows) + 6:
                continue
            if tbl == "entidades":
                n += oe_entities(con, y, rows, r0, url)
                break
            unit, headers, data = parse_block(rows, r0)
            for r, line, vals in data:
                for c, v in vals.items():
                    con.execute("INSERT INTO oe_cells VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (y, tbl, sheet, title, unit, line, r, headers.get(c, ""), c, v, url))
                    n += 1
            break
    return n


def oe_entities(con, y, rows, r0, url):
    mbo, n = None, 0
    for r in sorted(k for k in rows if k > r0):
        row = rows[r]
        lab = row.get(1)
        nif = row.get(2)
        if isinstance(lab, str) and re.match(r"^MBO\s*\d+", lab):
            mbo = lab
            continue
        if isinstance(lab, str) and nif is not None:
            nif = str(int(nif)) if isnum(nif) else re.sub(r"\D", "", str(nif))
            if len(nif) == 9:
                con.execute("INSERT INTO mbo_entities VALUES (?,?,?,?,?,?)",
                            (y, mbo, ministry_of(re.sub(r"^MBO\s*\d+\s*-\s*", "", mbo or "")), lab, nif, url))
                n += 1
    return n


# ---------------------------------------------------------------- Eurostat
ES = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"


def eurostat(con):
    jobs = [
        ("gov_10a_exp", "geo=PT&sector=S13&na_item=TE&unit=MIO_EUR&unit=PC_GDP&sinceTimePeriod=2000", "cofog99"),
        ("gov_10dd_edpt1", "geo=PT&sector=S13&na_item=B9&na_item=GD&unit=PC_GDP&unit=MIO_EUR&sinceTimePeriod=2000", "na_item"),
    ]
    n = 0
    for ds, q, dim in jobs:
        url = ES + ds + "?" + q
        raw = fetch(url, RAW / "eurostat" / f"{ds}.json", max_age_days=7)
        if not raw:
            con.execute("INSERT INTO blocked VALUES (?,?,?)", ("Eurostat " + ds, url, "pedido falhou"))
            continue
        d = json.loads(raw)
        ids, size = d["id"], d["size"]
        cats = {k: d["dimension"][k]["category"] for k in ids}
        inv = {k: {v: c for c, v in cats[k]["index"].items()} for k in ids}
        for flat, val in d["value"].items():
            flat = int(flat)
            pos = {}
            for k, s in zip(reversed(ids), reversed(size)):
                pos[k] = flat % s
                flat //= s
            code = inv[dim][pos[dim]]
            if dim == "cofog99" and not (code == "TOTAL" or re.fullmatch(r"GF\d\d", code)):
                continue
            unit = inv["unit"][pos["unit"]]
            yr = int(inv["time"][pos["time"]])
            con.execute("INSERT OR REPLACE INTO eurostat VALUES (?,?,?,?,?,?,?)",
                        (ds, code, cats[dim]["label"][code], yr, unit, val, url))
            n += 1
    return n


# ---------------------------------------------------------------- main
def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    con.execute("DELETE FROM blocked")
    # SEO
    eds = seo_discover(con)
    print(f"orcamento: {len(eds)} edições SEO com anexo XLSX")
    tot = 0
    for y, m, url in eds:
        k = seo_parse(con, y, m, url)
        tot += k
        print(f"  SEO {y}-{m:02d}: {k} valores")
        con.commit()
    # OE
    con.execute("DELETE FROM oe_cells")
    con.execute("DELETE FROM mbo_entities")
    con.execute("DELETE FROM annual WHERE source LIKE 'OE%'")
    for y in OE_YEARS:
        k = oe_parse(con, y)
        print(f"  OE{y}: {k} células")
        con.commit()
    derive_annual(con)
    for y in range(CGE_FIRST, date.today().year):
        k = cge_parse(con, y)
        print(f"  CGE{y}: {k} valores por ministério/programa")
    cross_checks(con)
    con.commit()
    # programas -> ministérios
    con.execute("DELETE FROM programs")
    names = {r[0] for r in con.execute("SELECT DISTINCT line FROM exec_cum WHERE tbl='programas'")}
    names |= {r[0] for r in con.execute("SELECT DISTINCT line FROM oe_cells WHERE tbl='programas'")}
    names |= {r[0] for r in con.execute("SELECT DISTINCT line FROM exec_cum WHERE tbl='ministerios'")}
    names |= {r[0] for r in con.execute("SELECT DISTINCT line FROM annual WHERE tbl LIKE 'cge_%'")}
    for nm in names:
        code = (re.match(r"^\s*(\d{3})\s*-", nm) or [None, None])[1]
        if re.search(r"total|subtotal|fluxos|diferen|dota|por mem|despesa|^\s*(dos|das|do|da) qua|ativos|passivos|transfer|^\d\.", nm, re.I):
            continue
        con.execute("INSERT OR REPLACE INTO programs VALUES (?,?,?)", (nm, code, ministry_of(nm)))
    k = eurostat(con)
    print(f"  Eurostat: {k} valores")
    con.execute("INSERT INTO blocked VALUES (?,?,?)", ("UTAO (utao.pt)", "https://utao.pt", "sem resposta (timeout) a 2026-10-29"))
    con.execute("INSERT INTO blocked VALUES (?,?,?)", ("SEO antes de 2010", EO + "/execucaoorcamental/Paginas/Sintese-da-Execucao-Orcamental-Mensal.aspx",
                                                       "edições de 2008-2009 só em PDF (boletim); a série começa com os anexos .xls de 2010 (que incluem o ano anterior)"))
    con.execute("INSERT INTO blocked VALUES (?,?,?)", ("Despesa por programa 2009-2021", EO, "os anexos .xls antigos têm 'Programas Orçamentais' em formato diferente (dotação corrigida) e não foram lidos; 2010-2013 tem despesa do Estado por ministério"))
    con.execute("INSERT INTO blocked VALUES (?,?,?)", ("dados.gov.pt — Entidade Orçamental", "https://dados.gov.pt/pt/organizations/entidade-orcamental/",
                                                       "conjuntos mensais em .xls (BIFF); mesmos números da SEO, não usados"))
    con.execute("INSERT INTO blocked VALUES (?,?,?)", ("Portal Mais Transparência", "https://transparencia.gov.pt/pt/financas-publicas/",
                                                       "aplicação SPA sem API documentada; mostra os mesmos dados da Entidade Orçamental"))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('updated', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    last = con.execute("SELECT year, month, url FROM seo_editions ORDER BY year DESC, month DESC LIMIT 1").fetchone()
    if last:
        con.execute("INSERT OR REPLACE INTO meta VALUES ('last_seo', ?)", (json.dumps(last),))
    con.commit()
    print(f"orcamento: {tot} valores SEO; {con.execute('SELECT COUNT(*) FROM oe_cells').fetchone()[0]} células OE; "
          f"{con.execute('SELECT COUNT(*) FROM mbo_entities').fetchone()[0]} entidades MBO")
    con.close()


def derive_annual(con):
    """Valores anuais por Programa a partir das propostas OE (orçamento proposto e estimativa do ano corrente)."""
    for oe, line, ord_, col, v, url in con.execute(
            "SELECT oe, line, ord, col, value, source_url FROM oe_cells WHERE tbl='programas' ORDER BY oe, ord, colord").fetchall():
        c = norm(col)
        if re.search(r"prr|variac|estrutura|%", c):
            continue
        ym = re.findall(r"\b(20\d\d)\b", col)
        yr = int(ym[0]) if ym else oe
        kind = "oe_proposta" if ("orcamento" in c or not c) and yr == oe else ("estimativa" if "estimativa" in c else None)
        if kind:
            con.execute("INSERT OR IGNORE INTO annual VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (yr, "programas", norm(re.sub(r"^\s*\d{3}\s*-\s*", "", line)) + "#1", line, ord_, kind, v, "M€", f"OE{oe}", url))


if __name__ == "__main__":
    main()
