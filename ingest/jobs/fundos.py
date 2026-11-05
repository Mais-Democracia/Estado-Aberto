"""Fundos europeus e PRR: para onde vai o dinheiro europeu e de recuperação (por beneficiário, ligado ao registo por NIF).

Escreve só em data/fundos.db.  Lê (só leitura) data/politica.db: entities.

Fontes (todas dados abertos em dados.gov.pt, ficheiros .xlsx lidos em streaming, sem dependências):
  * PRR  - Estrutura de Missão Recuperar Portugal: Projetos, Entidades (NIF, papel), Localizações, Investimentos,
           Contratualização (atualização diária).
  * Portugal 2020 - AD&C: Lista de operações, Beneficiários, Operações regionalizadas; MAR2020 (FEAMP).
  * Portugal 2030 - AD&C: Lista de operações, Lista de entidades, Operações regionalizadas.
  * FEADER (GPP): PDR2020 / PRORURAL+ / PRODERAM2020 - lista de projetos (beneficiário principal).
Bloqueado / não incluído: ver tabela meta('blocked').  Nomes de pessoas singulares NÃO são guardados (o Reg. UE 1303/2013
Anexo XII e o RGPD não os publicam): ficam como "Pessoa singular" sem NIF.
"""
import json
import re
import sqlite3
import time
import unicodedata
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

from common import DATA_DIR, ROOT, UA

NAME = "fundos"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
POLITICA = DATA_DIR / "politica.db"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
API = "https://dados.gov.pt/api/1/datasets/"
SLEEP = 1.0

# chave -> (dataset id em dados.gov.pt, filtro do nome/título do recurso)
SOURCES = {
    "prr_projetos": ("6717dcff1b0eaad60ac50090", ""),
    "prr_entidades": ("6717dca11b0eaad60ac5008f", ""),
    "prr_localizacoes": ("6717dc1f1b0eaad60ac5008e", ""),
    "prr_investimentos": ("6718cb20d7c1ce7589c5008c", ""),
    "prr_contrat": ("6718c25bbbf3654d2bc5008b", ""),
    "pt2020_ops": ("60255885454ae3372d0acac7", "01-lista-de-operacoes"),
    "pt2020_benef": ("60255885454ae3372d0acac7", "14-lista-de-beneficiarios"),
    "pt2020_regio": ("60255885454ae3372d0acac7", "02-operacoes-regionalizadas"),
    "mar2020_ops": ("60255885454ae3372d0acac7", "06-lista-operacoes-mar2020"),
    "pt2030_ops": ("672265cd9e435b9467b89ded", ""),
    "pt2030_ent": ("672266469e435b9467b89dee", ""),
    "pt2030_regio": ("6776b1f30b2fe06be472fcd4", ""),
    "feader_pdr2020": ("6148911b0781900f479320f7", "lista-de-proj-pdr2020"),
    "feader_prorural": ("6148911b0781900f479320f7", "lista-de-proj-prorural-dez"),
    "feader_proderam": ("6148911b0781900f479320f7", "lista-de-proj-proderam2020"),
}
FW_LABEL = {"PRR": "PRR", "PT2020": "Portugal 2020", "MAR2020": "MAR 2020 (FEAMP)", "PT2030": "Portugal 2030", "FEADER": "FEADER (desenvolvimento rural)"}
DSET_URL = "https://dados.gov.pt/pt/datasets/"

# ------------------------------------------------------------------ xlsx em streaming (stdlib)
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + ord(ch) - 64
        else:
            break
    return n - 1


def xlsx_rows(path):
    """Gera as linhas (listas) da primeira folha de um .xlsx sem carregar o ficheiro em memória."""
    z = zipfile.ZipFile(path)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rm = {r.get("Id"): r.get("Target") for r in rels}
    s = next(wb.iter(NS + "sheet"))
    t = rm[s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")].lstrip("/")
    if not t.startswith("xl/"):
        t = "xl/" + t
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, el in ET.iterparse(z.open("xl/sharedStrings.xml")):
            if el.tag == NS + "si":
                ss.append("".join(x.text or "" for x in el.iter(NS + "t")))
                el.clear()
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


def records(path):
    """Linhas como dicts (cabeçalho normalizado: minúsculas, sem acentos, sem espaços extra)."""
    it = xlsx_rows(path)
    head = [norm_key(h) for h in next(it)]
    for r in it:
        if not any(x not in (None, "") for x in r):
            continue
        yield {head[i]: (r[i] if i < len(r) else None) for i in range(len(head)) if head[i]}


def norm_key(h):
    h = unicodedata.normalize("NFKD", str(h or "")).encode("ascii", "ignore").decode().lower().replace("\xa0", " ")
    return re.sub(r"\s+", " ", h).strip()


# ------------------------------------------------------------------ utilitários
def log(*a):
    print("[fundos]", *a, flush=True)


def num(x):
    if x in (None, "", "None", "-"):
        return None
    try:
        return float(x)
    except ValueError:
        return None


def txt(x):
    if x is None:
        return None
    x = str(x).replace("\xa0", " ").strip()
    return None if x in ("", "None", "-") else re.sub(r"\s+", " ", x)


def year_of(x):
    """Ano de uma data ISO ('2024-09-25') ou de um número de série Excel ('45587')."""
    x = txt(x)
    if not x:
        return None
    if re.match(r"^\d{4}-\d{2}", x):
        y = int(x[:4])
    else:
        d = iso_date(x)
        if not d:
            return None
        y = int(d[:4])
    return y if 1990 <= y <= 2045 else None


def iso_date(x):
    x = txt(x)
    if not x:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", x):
        return x[:10]
    try:
        from datetime import date, timedelta
        return (date(1899, 12, 30) + timedelta(days=int(float(x)))).isoformat()
    except (ValueError, OverflowError):
        return None


def nname(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().upper()
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = re.sub(r"\b(LDA|SA|S A|UNIPESSOAL|EPE|IP|CRL|CIPRL|SGPS)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_nif(x):
    x = txt(x)
    if not x:
        return None
    x = x.replace(" ", "")
    return x if re.fullmatch(r"\d{9}", x) else None


def is_person_nif(nif):
    """NIF de pessoa singular: começa por 1, 2 ou 3 (e 45 = herança indivisa)."""
    return bool(nif) and (nif[0] in "123" or nif.startswith("45"))


def fetch(key, force=False):
    """Descobre o recurso mais recente no dataset do dados.gov.pt e guarda em cache (re-descarrega se o URL mudou)."""
    RAW.mkdir(parents=True, exist_ok=True)
    manifest_p = RAW / "manifest.json"
    manifest = json.loads(manifest_p.read_text()) if manifest_p.exists() else {}
    dsid, pat = SOURCES[key]
    req = urllib.request.Request(API + dsid + "/", headers={"User-Agent": BROWSER_UA})
    meta = json.load(urllib.request.urlopen(req, timeout=60))
    time.sleep(SLEEP)
    res = [r for r in meta["resources"] if pat in r["url"].lower() or pat in (r.get("title") or "").lower()]
    res = [r for r in res if (r.get("format") or "").lower() == "xlsx"]
    if not res:
        raise RuntimeError(f"{key}: recurso xlsx não encontrado em {dsid}")
    r = res[0]
    path = RAW / f"{key}.xlsx"
    if force or not path.exists() or manifest.get(key, {}).get("url") != r["url"]:
        log("a descarregar", key, r["url"])
        req = urllib.request.Request(r["url"], headers={"User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=300) as resp, open(path.with_suffix(".part"), "wb") as f:
            while True:
                b = resp.read(1 << 20)
                if not b:
                    break
                f.write(b)
        path.with_suffix(".part").replace(path)
        time.sleep(SLEEP)
    manifest[key] = {"url": r["url"], "dataset": DSET_URL + dsid, "title": meta["title"], "modified": r.get("last_modified"), "license": meta.get("license")}
    manifest_p.write_text(json.dumps(manifest, indent=1))
    return path, manifest[key]


# ------------------------------------------------------------------ registo de entidades
class Registry:
    def __init__(self):
        self.by_nif, self.by_name = {}, defaultdict(set)
        if not POLITICA.exists():
            return
        con = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True)
        for id_, nif, name, kind in con.execute("SELECT id, nif, name, kind FROM entities"):
            if nif:
                self.by_nif[nif] = (id_, kind, name)
            self.by_name[nname(name)].add((id_, kind, name))
        con.close()

    def match(self, nif, name):
        """-> (entity_id, kind, método).  Por NIF; por nome normalizado só se o NIF falta e o nome é inequívoco."""
        if nif and nif in self.by_nif:
            e = self.by_nif[nif]
            return e[0], e[1], "nif"
        if not nif:
            c = self.by_name.get(nname(name)) or ()
            if len(c) == 1:
                e = next(iter(c))
                return e[0], e[1], "nome"
        return None, None, None


TIPOS = ["Município", "Freguesia", "Comunidade intermunicipal / área metropolitana", "Universidade / politécnico", "Escola", "Saúde",
         "Administração central e institutos", "Administração regional", "Empresa pública / municipal",
         "Associação, fundação, IPSS, cooperativa", "Empresa privada", "Pessoa singular", "Agregado (não identificado)", "Outro"]
KIND_TIPO = {"municipio": "Município", "freguesia": "Freguesia", "cim_am": "Comunidade intermunicipal / área metropolitana",
             "universidade": "Universidade / politécnico", "escola": "Escola", "saude": "Saúde", "instituto_publico": "Administração central e institutos",
             "ministerio": "Administração central e institutos", "tribunal_justica": "Administração central e institutos",
             "seguranca_defesa": "Administração central e institutos", "regional": "Administração regional",
             "empresa_municipal": "Empresa pública / municipal", "empresa_publica": "Empresa pública / municipal"}
RX_ASSOC = re.compile(r"\b(associa[cç][aã]o|funda[cç][aã]o|cooperativa|coop\.|santa casa|miseric[oó]rdia|ipss|centro social|comiss[aã]o|cercig|apae|clube|grupo desportivo|sociedade filarm|bombeiros)", re.I)
RX_UNIV = re.compile(r"(universidade|instituto polit[eé]cnico|polit[eé]cnico|instituto superior|escola superior|faculdade)", re.I)
RX_PUB = re.compile(r"(^|\W)(munic[ií]pio|c[aâ]mara municipal)", re.I)
RX_PUBADM = re.compile(r"(dire[cç][aã]o[- ]geral|dire[cç][aã]o regional|secretaria[- ]geral|instituto d[eo]|ag[eê]ncia|autoridade|comiss[aã]o de coordena|gabinete|minist[eé]rio|governo|inspe[cç])", re.I)
RX_EMP = re.compile(r"(\bs\.?\s?a\.?$|\blda\.?$|, s\.?a|unipessoal|sociedade|\blimitada)", re.I)


def tipo_of(nif, name, ekind, aggregated=False):
    if aggregated:
        return "Agregado (não identificado)"
    if ekind in KIND_TIPO:
        return KIND_TIPO[ekind]
    if is_person_nif(nif):
        return "Pessoa singular"
    n = name or ""
    if RX_UNIV.search(n):
        return "Universidade / politécnico"
    if RX_PUB.search(n):
        return "Município"
    if re.search(r"freguesia", n, re.I):
        return "Freguesia"
    if RX_ASSOC.search(n):
        return "Associação, fundação, IPSS, cooperativa"
    if nif and nif[0] in "6" or RX_PUBADM.search(n):
        return "Administração central e institutos"
    if nif and nif[0] in "5" or RX_EMP.search(n):
        return "Empresa privada"
    return "Outro"


# ------------------------------------------------------------------ esquema
SCHEMA = """
DROP TABLE IF EXISTS awards; DROP TABLE IF EXISTS locs; DROP TABLE IF EXISTS prr_contracts; DROP TABLE IF EXISTS prr_interm;
DROP TABLE IF EXISTS awards_fts; DROP TABLE IF EXISTS agg; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS ent_totals; DROP TABLE IF EXISTS conc_totals;
CREATE TABLE awards (
  id INTEGER PRIMARY KEY,
  fw TEXT,            -- PRR | PT2020 | MAR2020 | PT2030 | FEADER
  code TEXT,          -- código da operação / projeto
  role TEXT,          -- Beneficiário final / principal / ...
  counts INTEGER,     -- 1 = conta para os totais; 0 = papel auxiliar (ex.: fornecedor)
  nif TEXT, name TEXT, entity_id INTEGER, match TEXT,
  tipo TEXT,
  programa TEXT, fundo TEXT, ano INTEGER, titulo TEXT, estado TEXT,
  concelho TEXT, regiao TEXT,
  aprovado REAL, pago REAL, custo REAL,
  source_url TEXT
);
CREATE TABLE locs (fw TEXT, code TEXT, regiao TEXT, distrito TEXT, concelho TEXT, pct REAL, aprovado REAL, pago REAL);
CREATE TABLE prr_contracts (code TEXT, title TEXT, signed TEXT, contratado REAL, subvencao REAL, emprestimo REAL, transferido REAL, pago REAL,
  investimento TEXT, nif TEXT, name TEXT, entity_id INTEGER, estado TEXT, source_url TEXT);
CREATE TABLE prr_interm (nif TEXT, name TEXT, entity_id INTEGER, n INTEGER, contratado REAL, pago REAL);
CREATE TABLE agg (dim TEXT, key TEXT, key2 TEXT, n INTEGER, aprovado REAL, pago REAL);
CREATE TABLE ent_totals (nif TEXT PRIMARY KEY, entity_id INTEGER, name TEXT, tipo TEXT, n INTEGER, aprovado REAL, pago REAL);
CREATE TABLE conc_totals (concelho TEXT, tipo TEXT, n INTEGER, aprovado REAL, pago REAL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""
INDEXES = """
CREATE INDEX awards_nif ON awards(nif); CREATE INDEX awards_ent ON awards(entity_id); CREATE INDEX awards_fw ON awards(fw, counts);
CREATE INDEX awards_ano ON awards(ano); CREATE INDEX awards_prog ON awards(programa); CREATE INDEX awards_apr ON awards(aprovado);
CREATE INDEX awards_name ON awards(name); CREATE INDEX awards_code ON awards(code);
CREATE INDEX locs_code ON locs(fw, code); CREATE INDEX locs_conc ON locs(concelho);
CREATE INDEX contr_nif ON prr_contracts(nif); CREATE INDEX interm_nif ON prr_interm(nif);
CREATE INDEX agg_dim ON agg(dim);
CREATE VIRTUAL TABLE awards_fts USING fts5(name, titulo, content='awards', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
INSERT INTO awards_fts(rowid, name, titulo) SELECT id, name, titulo FROM awards WHERE counts=1;
"""
INS = "INSERT INTO awards(fw,code,role,counts,nif,name,entity_id,match,tipo,programa,fundo,ano,titulo,estado,concelho,regiao,aprovado,pago,custo,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"


class Out:
    def __init__(self, con, reg):
        self.con, self.reg, self.buf = con, reg, []
        self.stats = defaultdict(lambda: defaultdict(int))

    def add(self, fw, code, role, counts, nif_raw, name, programa, fundo, ano, titulo, estado, concelho, regiao, aprovado, pago, custo, url, aggregated=False):
        nif = clean_nif(nif_raw)
        name = txt(name)
        raw = txt(nif_raw) or ""
        pseudo = re.fullmatch(r"[A-Z]{2}\d+", raw) is not None  # pseudónimo de pessoa singular (MAR2020 / PRODERAM)
        agg = aggregated or re.search(r"n[aã]o dispon", raw, re.I) is not None
        ent = (None, None, None)
        masked = (name or "").strip().upper() == "RGPD"  # a fonte mascara pessoas singulares com "RGPD"
        if pseudo or masked or is_person_nif(nif):
            nif, name, tipo = None, "Pessoa singular (nome omitido)", "Pessoa singular"
            person = True
        else:
            person = False
            ent = self.reg.match(nif, name) if not agg else ent
            tipo = tipo_of(nif, name, ent[1], aggregated=agg)
            if tipo == "Pessoa singular":
                nif, name, person = None, "Pessoa singular (nome omitido)", True
            if agg:
                nif = None
        s = self.stats[fw]
        if counts:
            s["rows"] += 1
            s["val"] += aprovado or 0
            if nif:
                s["rows_nif"] += 1
                s["val_nif"] += aprovado or 0
                if ent[2] == "nif":
                    s["m_rows"] += 1
                    s["m_val"] += aprovado or 0
                elif ent[2] == "nome":
                    s["n_rows"] += 1
            if person:
                s["rows_person"] += 1
                s["val_person"] += aprovado or 0
        self.buf.append((fw, code, role, counts, nif, name, ent[0], ent[2], tipo, programa, fundo, ano, titulo, estado, concelho, regiao, aprovado, pago, custo, url))
        if len(self.buf) >= 20000:
            self.flush()

    def flush(self):
        self.con.executemany(INS, self.buf)
        self.buf = []


def locs_insert(con, fw, rows):
    con.executemany("INSERT INTO locs VALUES (?,?,?,?,?,?,?,?)", [(fw,) + r for r in rows])


# ------------------------------------------------------------------ PRR
def load_prr(con, out, srcs):
    log("PRR: investimentos")
    comp, inv = {}, {}
    for r in records(srcs["prr_investimentos"][0]):
        c = txt(r.get("codigo da componente"))
        if c:
            comp[c] = txt(r.get("designacao da componente"))
        inv[txt(r.get("codigo do investimento"))] = txt(r.get("designacao do investimento"))
    log("PRR: projetos")
    proj = {}
    for r in records(srcs["prr_projetos"][0]):
        code = txt(r.get("cd_projeto"))
        proj[code] = (txt(r.get("ds_projeto")), num(r.get("valor_aprovado")), num(r.get("valor_pago")),
                      year_of(r.get("dt_inicio")) or year_of(r.get("dt_efetiva_conclusao")), txt(r.get("cd_investimento")),
                      "Concluído" if txt(r.get("dt_efetiva_conclusao")) else "Em execução")
    log("  projetos:", len(proj))
    log("PRR: localizações")
    mainloc, rows, best = {}, [], {}
    for r in records(srcs["prr_localizacoes"][0]):
        code = txt(r.get("cd_projeto"))
        pct = num(r.get("perc_valor_aprovado"))
        pp = proj.get(code)
        ap = (pp[1] or 0) * (pct or 0) / 100 if pp else None
        pg = (pp[2] or 0) * (pct or 0) / 100 if pp else None  # a fonte repete 100% em perc_valor_pago por local: repartimos o pago pela % do aprovado
        reg, dist, conc = txt(r.get("ds_nutsii")), txt(r.get("ds_distrito")), txt(r.get("ds_concelho"))
        rows.append((code, reg, dist, conc, pct, ap, pg))
        if code not in best or (pct or 0) > best[code]:
            best[code] = pct or 0
            mainloc[code] = (conc, reg)
        if len(rows) >= 50000:
            locs_insert(con, "PRR", rows)
            rows = []
    locs_insert(con, "PRR", rows)
    log("PRR: entidades")
    interm = defaultdict(lambda: [None, 0, 0.0, 0.0])
    url = srcs["prr_entidades"][1]["dataset"]
    n_skipped = 0
    for r in records(srcs["prr_entidades"][0]):
        role = txt(r.get("papel_entidade"))
        code = txt(r.get("cd_projeto"))
        nif, name = r.get("nif_entidade"), r.get("ds_entidade")
        v, p = num(r.get("valor_contratado")), num(r.get("valor_pago"))
        if role == "Beneficiário Intermediário":
            k = clean_nif(nif)
            d = interm[k or txt(name)]
            d[0] = (k, txt(name)); d[1] += 1; d[2] += v or 0; d[3] += p or 0
            continue
        if role == "Parceiro":
            n_skipped += 1
            continue
        pp = proj.get(code) or (None, None, None, None, None, None)
        invc = pp[4] or ""
        m = re.match(r"(C\d\d)", invc)
        programa = "PRR · " + (m.group(1) + " " + (comp.get(m.group(1)) or "")).strip() if m else "PRR"
        loc = mainloc.get(code, (txt(r.get("localizacao_sede")), None))
        counts = 1 if role in ("Beneficiário Final", "Beneficiário Direto") else 0
        out.add("PRR", code, role, counts, nif, name, programa, "MRR", pp[3], pp[0], pp[5], loc[0] or txt(r.get("localizacao_sede")), loc[1], v, p, None, url)
    out.flush()
    for (k, (nif, name)) in [(k, d[0]) for k, d in interm.items()]:
        d = interm[k]
        e = out.reg.match(nif, name)
        con.execute("INSERT INTO prr_interm VALUES (?,?,?,?,?,?)", (nif, name, e[0], d[1], d[2], d[3]))
    log("PRR: contratualização")
    url = srcs["prr_contrat"][1]["dataset"]
    for r in records(srcs["prr_contrat"][0]):
        nif = clean_nif(r.get("codigo da entidade"))
        e = out.reg.match(nif, r.get("designacao da entidade"))
        con.execute("INSERT INTO prr_contracts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            txt(r.get("codigo do contrato")), txt(r.get("designacao do contrato")), iso_date(r.get("data da assinatura do contrato")),
            num(r.get("montante contratualizado")), num(r.get("montante subvencao")), num(r.get("montante emprestimos")),
            num(r.get("valor transferido")), num(r.get("valor pago")), txt(r.get("codigo do investimento")), nif,
            txt(r.get("designacao da entidade")), e[0], txt(r.get("estado contratualizacao")), url))
    con.commit()
    log("  PRR ignorados (parceiros):", n_skipped)


# ------------------------------------------------------------------ Portugal 2020 (+ MAR2020)
def load_regio_pt2020(con, fw, path, amount_cols):
    best, rows, out_main = {}, [], {}
    for r in records(path):
        code = txt(r.get("codigo da operacao"))
        pct = num(r.get("percentagem localizacao da operacao"))
        reg, dist, conc = txt(r.get("designacao da nuts ii da operacao")), txt(r.get("designacao do distrito da operacao")), txt(r.get("designacao do concelho da operacao"))
        ap = num(r.get(amount_cols[0]))
        pg = num(r.get(amount_cols[1]))
        rows.append((code, reg, dist, conc, pct, (ap or 0) * (pct or 0) / 100, (pg or 0) * (pct or 0) / 100))
        if code not in best or (pct or 0) > best[code]:
            best[code] = pct or 0
            out_main[code] = (conc, reg)
        if len(rows) >= 50000:
            locs_insert(con, fw, rows)
            rows = []
    locs_insert(con, fw, rows)
    return out_main


def load_pt2020(con, out, srcs):
    log("PT2020: regionalizadas")
    main = load_regio_pt2020(con, "PT2020", srcs["pt2020_regio"][0], ("apoio total aprovado - em vigor", "apoio executado"))
    log("PT2020: operações")
    ops = {}
    for r in records(srcs["pt2020_ops"][0]):
        ops[txt(r.get("codigo da operacao"))] = r
    log("  operações:", len(ops))
    log("PT2020: beneficiários")
    benef = defaultdict(list)
    for r in records(srcs["pt2020_benef"][0]):
        benef[txt(r.get("codigo da operacao"))].append(r)
    url = srcs["pt2020_ops"][1]["dataset"]
    for code, o in ops.items():
        ap, pg = num(o.get("apoio total aprovado - em vigor")), num(o.get("apoio executado"))
        ano = year_of(o.get("data efetiva conclusao da operacao")) or year_of(o.get("data prevista conclusao"))
        loc = main.get(code, (None, None))
        base = (txt(o.get("designacao do programa operacional da operacao")), txt(o.get("sigla do fundo da operacao")))
        bl = benef.get(code) or [{"nif das entidades beneficiarias": o.get("nif beneficiario principal da operacao"),
                                   "designacao da entidade": o.get("beneficiario principal da operacao"), "percentagem beneficiario da operacao": "100", "principal": "SIM"}]
        for b in bl:
            pct = num(b.get("percentagem beneficiario da operacao"))
            pct = 100 if pct is None else pct
            princ = (txt(b.get("principal")) or "").upper().startswith("S")
            out.add("PT2020", code, "Beneficiário principal" if princ else "Co-beneficiário", 1, b.get("nif das entidades beneficiarias"),
                    b.get("designacao da entidade"), base[0], base[1], ano, txt(o.get("designacao da operacao")), txt(o.get("estado da operacao")),
                    loc[0], loc[1], None if ap is None else ap * pct / 100, None if pg is None else pg * pct / 100, None, url)
    out.flush()
    con.commit()


def load_mar2020(con, out, srcs):
    log("MAR2020 (FEAMP)")
    url = srcs["mar2020_ops"][1]["dataset"]
    for r in records(srcs["mar2020_ops"][0]):
        ano = year_of(r.get("data efetiva conclusao da operacao")) or year_of(r.get("data prevista conclusao"))
        out.add("MAR2020", txt(r.get("codigo da operacao")), "Beneficiário principal", 1, r.get("nif beneficiario principal da operacao"),
                r.get("beneficiario principal da operacao"), txt(r.get("designacao do programa operacional da operacao")), "FEAMP", ano,
                txt(r.get("designacao da operacao")), txt(r.get("estado da operacao")), None, None,
                num(r.get("apoio total aprovado - em vigor")), num(r.get("apoio executado")), None, url)
    out.flush()
    con.commit()


# ------------------------------------------------------------------ Portugal 2030
def load_pt2030(con, out, srcs):
    log("PT2030: regionalizadas")
    main = load_regio_pt2020(con, "PT2030", srcs["pt2030_regio"][0], ("fundo aprovado", "fundo pago"))
    log("PT2030: operações")
    ops = {}
    for r in records(srcs["pt2030_ops"][0]):
        ops[txt(r.get("codigo da operacao"))] = r
    log("  operações:", len(ops))
    ents = defaultdict(list)
    for r in records(srcs["pt2030_ent"][0]):
        ents[txt(r.get("codigo da operacao"))].append(r)
    url = srcs["pt2030_ops"][1]["dataset"]
    for code, o in ops.items():
        ano = year_of(o.get("data de inicio efetiva")) or year_of(o.get("data de inicio prevista")) or year_of(o.get("data de conclusao prevista"))
        loc = main.get(code, (None, None))
        prog, fundo = txt(o.get("designacao do programa")), txt(o.get("sigla do fundo"))
        titulo, estado = txt(o.get("nome da operacao")), txt(o.get("designacao do estado da operacao"))
        el = ents.get(code)
        if not el:
            el = [{"nif entidade": o.get("nif beneficiario"), "designacao da entidade": o.get("nome do beneficiario"), "papel da entidade": "Beneficiário Principal",
                   "valor contratualizado": o.get("custo total elegivel aprovado"), "fundo aprovado": o.get("fundo aprovado"), "fundo pago": o.get("fundo pago")}]
        for e in el:
            papel = txt(e.get("papel da entidade")) or "Beneficiário"
            out.add("PT2030", code, papel, 1, e.get("nif entidade"), e.get("designacao da entidade"), prog, fundo, ano, titulo, estado,
                    loc[0], loc[1], num(e.get("fundo aprovado")), num(e.get("fundo pago")), num(e.get("valor contratualizado")), url)
    out.flush()
    con.commit()


# ------------------------------------------------------------------ FEADER
def load_feader(con, out, srcs):
    for key, label in (("feader_pdr2020", "PDR2020"), ("feader_prorural", "PRORURAL+"), ("feader_proderam", "PRODERAM2020")):
        log("FEADER", label)
        url = srcs[key][1]["dataset"]
        for r in records(srcs[key][0]):
            nraw = txt(r.get("nif beneficiario principal da operacao"))
            ano = year_of(r.get("data efetiva conclusao da operacao")) or year_of(r.get("data prevista conclusao"))
            out.add("FEADER", txt(r.get("codigo da operacao")), "Beneficiário principal", 1, nraw, r.get("beneficiario principal da operacao"),
                    txt(r.get("designacao do programa operacional da operacao")) or label, "FEADER", ano, txt(r.get("designacao da operacao")),
                    txt(r.get("estado da operacao")), None, None, num(r.get("apoio total aprovado - em vigor")), num(r.get("apoio executado")), None, url,
                    aggregated=bool(nraw and re.search(r"n[aã]o dispon", nraw, re.I)))
    out.flush()
    con.commit()


# ------------------------------------------------------------------ agregados
def build_aggregates(con):
    log("agregados")
    q = lambda sql: con.execute(sql)
    con.execute("DELETE FROM agg")
    c = "counts=1"
    for dim, expr in (("fw", "fw"), ("programa", "fw||'|'||COALESCE(programa,'(sem programa)')"), ("ano", "COALESCE(ano,0)"),
                      ("regiao", "COALESCE(regiao,'(sem região)')"), ("tipo", "tipo")):
        con.execute(f"INSERT INTO agg SELECT '{dim}', {expr}, NULL, COUNT(*), COALESCE(SUM(aprovado),0), COALESCE(SUM(pago),0) FROM awards WHERE {c} GROUP BY {expr}")
    con.execute("INSERT INTO agg SELECT 'fw_ano', fw, COALESCE(ano,0), COUNT(*), COALESCE(SUM(aprovado),0), COALESCE(SUM(pago),0) FROM awards WHERE counts=1 GROUP BY fw, ano")
    con.execute("INSERT INTO agg SELECT 'fw_tipo', fw, tipo, COUNT(*), COALESCE(SUM(aprovado),0), COALESCE(SUM(pago),0) FROM awards WHERE counts=1 GROUP BY fw, tipo")
    con.execute("DELETE FROM ent_totals")
    con.execute("""INSERT INTO ent_totals SELECT nif, MAX(entity_id), MAX(name), MAX(tipo), COUNT(*), COALESCE(SUM(aprovado),0), COALESCE(SUM(pago),0)
                   FROM awards WHERE counts=1 AND nif IS NOT NULL GROUP BY nif""")
    # Totais por concelho do projeto (localização, ponderados) e tipo do beneficiário
    con.execute("""INSERT INTO conc_totals SELECT l.concelho, 'x', COUNT(DISTINCT l.fw||l.code), SUM(l.aprovado), SUM(l.pago)
                   FROM locs l WHERE l.concelho IS NOT NULL GROUP BY l.concelho""")
    con.commit()


def main():
    t0 = time.time()
    reg = Registry()
    log("registo:", len(reg.by_nif), "NIFs")
    srcs, errors = {}, {}
    for k in SOURCES:
        try:
            srcs[k] = fetch(k)
        except Exception as e:  # noqa: BLE001
            errors[k] = str(e)
            log("FALHOU", k, e)
    tmp = DB.with_suffix(".db.new")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    out = Out(con, reg)
    jobs = [(load_prr, ["prr_projetos", "prr_entidades", "prr_localizacoes", "prr_investimentos", "prr_contrat"]),
            (load_pt2020, ["pt2020_ops", "pt2020_benef", "pt2020_regio"]), (load_mar2020, ["mar2020_ops"]),
            (load_pt2030, ["pt2030_ops", "pt2030_ent", "pt2030_regio"]), (load_feader, ["feader_pdr2020", "feader_prorural", "feader_proderam"])]
    for fn, need in jobs:
        if all(k in srcs for k in need):
            try:
                fn(con, out, srcs)
            except Exception as e:  # noqa: BLE001
                import traceback; traceback.print_exc()
                errors[fn.__name__] = str(e)
        else:
            errors.setdefault(fn.__name__, "fonte(s) indisponível(is)")
    out.flush()
    con.executescript(INDEXES)
    build_aggregates(con)
    blocked = [
        {"source": "Kohesio / cohesiondata.ec.europa.eu (projetos cofinanciados, UE)", "reason": "Não usado de propósito: os projetos portugueses de FEDER/FSE/Coesão já vêm dos ficheiros nacionais da AD&C (com NIF, valores pagos e localização); a base da Comissão duplicaria valores e não traz NIF."},
        {"source": "EU Financial Transparency System (pagamentos diretos da Comissão: Horizonte Europa, Erasmus+, LIFE…)", "reason": "Ainda não integrado: a página de descarga pública do FTS devolve 404 e não foi encontrada exportação em bloco estável; sem NIF, a ligação seria só por nome (ambígua). Próximo passo."},
        {"source": "IFAP: FEAGA / pagamentos diretos do PEPAC (pilar 1)", "reason": "Não incluído: não foi encontrada lista de beneficiários descarregável (os recursos do IFAP no dados.gov.pt são serviços geográficos WMS/WFS e a página 'pagamentos diretos' não tem ficheiros de beneficiários). O FEADER (desenvolvimento rural) está incluído via GPP; a maioria dos beneficiários agrícolas são pessoas singulares, cujo nome não é guardado."},
        {"source": "recuperarportugal.gov.pt", "reason": "O certificado TLS do site não valida a partir do servidor (cadeia intermédia em falta) e não é ignorado; usam-se os conjuntos oficiais da Estrutura de Missão publicados em dados.gov.pt (atualização diária), que são a mesma informação em formato aberto."},
    ]
    for k, v in {
        "built": time.strftime("%Y-%m-%d %H:%M"),
        "sources": {k: v[1] for k, v in srcs.items()},
        "errors": errors,
        "blocked": blocked,
        "match_stats": {fw: dict(s) for fw, s in out.stats.items()},
        "fw_label": FW_LABEL,
    }.items():
        con.execute("INSERT INTO meta VALUES (?,?)", (k, json.dumps(v, ensure_ascii=False)))
    con.commit()
    con.execute("PRAGMA optimize")
    con.close()
    tmp.replace(DB)
    log(f"pronto em {time.time() - t0:.0f}s ->", DB)


if __name__ == "__main__":
    main()
