#!/usr/bin/env python3
"""apoios: quem recebe apoios públicos na cultura, desporto, juventude e ciência (listas de beneficiários publicadas pelos próprios organismos).

Fontes (ver docs/SOURCES.md):
  DGARTES  listas anuais "Apoios atribuídos" (PDF, NIF + montante)            dgartes.gov.pt/pt/vnode/3   (Crawl-delay 10 s respeitado)
  ICA      "Candidaturas apoiadas" por concurso (PDF, requerente + montante)   ica-ip.pt  (sem robots.txt)
  IPDJ     PAAJ 2007-2018 (XLS) + "Listagem de subvenções" 2019-2024 (PDF)   ipdj.gov.pt  (robots: Allow /*)
  FCT      Lista de Projetos I&D + Lista de Instituições (CSV)                 fct.pt      (robots: só /wp-admin)
Escreve apenas data/apoios.db (WAL, commits em lotes). Cache bruta em data/raw/apoios/.
Liga a entidades por NIF (politica.db, só leitura) ou por nome normalizado exato (nunca ambíguo).
"""
import os, csv, gzip, html, json, re, sqlite3, subprocess, sys, time, unicodedata, urllib.parse, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, connect_writer  # noqa: E402
from jobs import apoios_pdf  # noqa: E402

NAME = "apoios"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
DELAY = {"www.dgartes.gov.pt": 10.5}
_last = {}
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)


def fetch(url, cache, binary=True, timeout=90):
    """GET com cache em RAW/cache; cortesia por anfitrião (>=1,3 s; DGARTES 10,5 s por Crawl-delay)."""
    p = RAW / cache
    if p.exists() and p.stat().st_size > 0:
        return p.read_bytes() if binary else p.read_text("utf-8", "replace")
    host = urllib.parse.urlsplit(url).netloc
    wait = DELAY.get(host, 1.4) - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    url = urllib.parse.quote(url, safe=":/?&=%+~#@;,")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", "Accept-Language": "pt-PT,pt;q=0.9"})
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            _last[host] = time.time()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return data if binary else data.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            err = e
            _last[host] = time.time()
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{url}: {err}")


def pdftext(path):
    out = Path(str(path) + ".txt")
    if not out.exists() or out.stat().st_mtime < Path(path).stat().st_mtime:
        subprocess.run(["pdftotext", "-layout", str(path), str(out)], check=True, timeout=300)
    return out.read_text("utf-8", "replace")


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().upper()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


SUFFIX = re.compile(r"\b(LDA|LIMITADA|UNIPESSOAL|SA|S A|CRL|C R L|IP|I P|EPE|E P E|SGPS|LTDA)\b")


def norm_org(s):
    s = norm(s)
    s = SUFFIX.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


ALIAS_LEGAL = re.compile(r"\b(LDA|LIMITADA|UNIPESSOAL|UNIP|ANONIMA|SA|S A|SGPS|CRL|LTDA|LD)\b")
ALIAS_STOP = {"DE", "DA", "DO", "DAS", "DOS", "E", "A", "O", "AS", "OS"}


def alias_keys(name):
    s = norm(name)
    s = ALIAS_LEGAL.sub(" ", s)
    toks = s.split()
    keys = []
    if len(" ".join(toks)) >= 8:
        keys.append(" ".join(toks))
    core = [w for w in toks if w not in ALIAS_STOP]
    if len(core) >= 3 and len(" ".join(core)) >= 12:
        keys.append("~" + " ".join(core))
    parts = re.split(r"\s+[-\u2013\u2014]\s+", str(name or ""))
    if len(parts) == 2:
        for x, y in ((parts[0], parts[1]), (parts[1], parts[0])):
            if len(x.split()) == 1:
                ny = [w for w in ALIAS_LEGAL.sub(" ", norm(y)).split() if w not in ALIAS_STOP]
                if len(ny) >= 3 and len(" ".join(ny)) >= 15:
                    keys.append("~" + " ".join(ny))
    return keys


def amount(s):
    """'1 234 567,89 €' / '€ 700.000,00' / '79.380,00 €' -> float"""
    m = re.search(r"(\d{1,3}(?:[ . ]\d{3})*|\d+),(\d{2})", s)
    if not m:
        return None
    return float(re.sub(r"[ . ]", "", m.group(1)) + "." + m.group(2))


AMT = re.compile(r"(?<![\d,.])(\d{1,3}(?:[ . ]\d{3})*|\d+),\d{2}(?!\d)")
NIF9 = re.compile(r"(?<!\d)([1-9]\d{8})(?!\d)")


def valid_nif(n):
    if not re.fullmatch(r"\d{9}", n or ""):
        return False
    d = [int(c) for c in n]
    s = sum(d[i] * (9 - i) for i in range(8))
    c = 11 - s % 11
    c = 0 if c >= 10 else c
    return c == d[8]


TABLES = """
CREATE TABLE IF NOT EXISTS {p}apoios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT,            -- cultura | desporto | juventude | ciencia
  orgao TEXT,           -- DGARTES | ICA | IPDJ | FCT
  programa TEXT,        -- programa / concurso / modalidade (como publicado)
  familia TEXT,         -- agrupamento do programa (para comparar anos)
  detalhe TEXT,         -- título do projeto / filme / finalidade (só obras e projetos, nunca pessoas)
  year INTEGER,
  nif TEXT, nome TEXT, nome_norm TEXT,
  pessoa_singular INTEGER DEFAULT 0,
  amount REAL,
  status TEXT,          -- aprovado | atribuido (ver nota na fonte; 'pago' só se a fonte o disser)
  data_decisao TEXT,
  regiao TEXT,
  source_url TEXT NOT NULL,
  src_key TEXT,
  ent_nif TEXT, match TEXT,   -- ligação ao registo: nif | nome | alias | NULL
  bkey TEXT                   -- chave do beneficiário (N<nif> | M<nome normalizado>)
);
CREATE TABLE IF NOT EXISTS {p}ben (
  bkey TEXT PRIMARY KEY, nif TEXT, ent_nif TEXT, nome TEXT, match TEXT, pessoa_singular INTEGER,
  n INTEGER, total REAL, areas TEXT, orgaos TEXT, primeiro INTEGER, ultimo INTEGER, fundos_overlap REAL
);
CREATE TABLE IF NOT EXISTS {p}sources (orgao TEXT, name TEXT, url TEXT, year INTEGER, rows INTEGER, total REAL, status TEXT, note TEXT);
"""
INDEXES = """
CREATE INDEX IF NOT EXISTS ap_ent ON apoios(ent_nif);
CREATE INDEX IF NOT EXISTS ap_nif ON apoios(nif);
CREATE INDEX IF NOT EXISTS ap_year ON apoios(year);
CREATE INDEX IF NOT EXISTS ap_orgao ON apoios(orgao, familia);
CREATE INDEX IF NOT EXISTS ap_area ON apoios(area, year);
CREATE INDEX IF NOT EXISTS ap_amt ON apoios(amount);
CREATE INDEX IF NOT EXISTS ap_bkey ON apoios(bkey);
CREATE INDEX IF NOT EXISTS ap_norm ON apoios(nome_norm);
CREATE INDEX IF NOT EXISTS ben_total ON ben(total);
CREATE INDEX IF NOT EXISTS ben_ent ON ben(ent_nif);
CREATE INDEX IF NOT EXISTS ben_nif ON ben(nif);
"""


def open_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = connect_writer(DB)
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(TABLES.format(p=""))
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    db.executescript(INDEXES)
    for t in ("apoios_n", "ben_n", "sources_n"):
        db.execute(f"DROP TABLE IF EXISTS {t}")
    db.executescript(TABLES.format(p="").replace("IF NOT EXISTS ", "IF NOT EXISTS ").replace("apoios (", "apoios_n (").replace("ben (", "ben_n (").replace("sources (", "sources_n ("))
    db.commit()
    return db


def familia(r):
    o, p = r["orgao"], (r.get("programa") or "")
    pl = p.lower()
    if o == "DGARTES":
        if re.search(r"emerg|pees|linha de", pl):
            return "Apoios excecionais (emergência / COVID)"
        if re.search(r"sustentado|quadrienal|bienal", pl):
            return "Apoio sustentado (quadrienal / bienal)"
        if re.search(r"rtcp|rede de teatros", pl):
            return "Rede de Teatros e Cineteatros (RTCP)"
        if re.search(r"parceria", pl):
            return "Apoio em parceria"
        if re.search(r"projeto|simplificado|criação|programação|internacionaliza|música|edição", pl):
            return "Apoio a projetos"
        return "Outros apoios às artes"
    if o == "ICA":
        return re.sub(r"\s+", " ", re.sub(r"\b20\d\d\b|\b(1|2)\.?[ºª]?\s*(Concurso|Chamada|Decisão)\b|\(.*?\)", "", p.replace("ICA · ", ""))).strip(" -–·") or "ICA"
    if o == "IPDJ":
        return "Juventude: associativismo (PAJ, PAE, PAI…)" if r["area"] == "juventude" else "Desporto: contratos-programa e apoios"
    if o == "FCT":
        return "Projetos de I&D" if "Projetos I&D" in p else "Unidades, laboratórios e infraestruturas"
    return p[:60]



class Sink:
    """Acumula linhas por fonte e grava em lotes pequenos."""

    def __init__(self, db):
        self.db, self.buf = db, []

    def add(self, **r):
        r.setdefault("pessoa_singular", 0)
        r["nome_norm"] = norm_org(r.get("nome"))
        r["familia"] = familia(r)
        self.buf.append(r)
        if len(self.buf) >= 400:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        cols = ["area", "orgao", "programa", "familia", "detalhe", "year", "nif", "nome", "nome_norm", "pessoa_singular", "amount", "status", "data_decisao", "regiao", "source_url", "src_key"]
        self.db.executemany(f"INSERT INTO apoios_n({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [[r.get(c) for c in cols] for r in self.buf])
        self.db.commit()
        self.buf = []


# ----------------------------------------------------------------------------- DGARTES
DG_BASE = "https://www.dgartes.gov.pt"
DG_LISTS = {  # ano -> ficheiro publicado em /pt/vnode/3 ("Benefícios e subvenções concedidos")
    2025: "apoios_2025.pdf",
    2023: "Lista_Apoios_2023.pdf",
    2022: "listaapoios2022.pdf",
    2021: "listaapoios2021.pdf",
    2020: "listadeapoios2020.pdf",
    2019: "pagamentos_apoios_2019.pdf",
    2018: "listaapoios2018_v070620191851.pdf",
}
DG_OLD = {2010: "2010_apoios_por_modalidade.pdf", 2011: "2011_apoios_por_modalidade_0.pdf", 2012: "2012_apoios_por_modalidade.pdf", 2013: "2013_apoios_por_modalidade.pdf", 2014: "2014_apoios_por_modalidade.pdf", 2015: "apoios2015_modalidade.pdf", 2016: "2016_apoios_por_modalidade.pdf", 2017: "lista_apoios2017.pdf"}
DG_SUBV_2024 = "subvencoes_publicas_submetidas_20252026_114154.pdf"  # relatório "Subvenções Públicas Submetidas" (listado como 2024)
REGIOES = ["Área Metropolitana de Lisboa", "Região Autónoma da Madeira", "Região Autónoma dos Açores", "Alentejo", "Algarve", "Centro", "Norte"]
HDR_RE = re.compile(r"^\s*(Decreto|Portaria|Data[s]? de homolog|Autorizado|Decisão final|Entidade\b|ENTIDADE\b|Despacho)", re.I)
FOOT_RE = re.compile(r"(Page \d+ of|P[áa]gina ?\d+ de|^\s*LISTA\s*$|^\s*APOIOS\s*$|^\s*LISTAGEM\s*$|^\s*20\d\d\s*$|^\s*_\s*$)", re.I)
NOT_PERSON = re.compile(r"\b(ASSOCIA|FUNDA|COOPERATIVA|CRL|LDA|LIMITADA|UNIPESSOAL|S\.?A\.?|COMPANHIA|TEATRO|CLUBE|CENTRO|INSTITUTO|UNIVERSIDADE|MUNIC|C[AÂ]MARA|FREGUESIA|ORQUESTRA|ACADEMIA|GRUPO|ESCOLA|SOCIEDADE|ASSOCIATIVA|FESTIVAL|FILMES|PRODU|EDI[CÇ]|CULTURAL|COLETIVO|COLECTIVO|COMISS|FEDERA|LIGA|COMIT|MISERIC|ENSEMBLE|FILARM|BANDA|ASSOC|CINEMA|REVISTA|MUSEU|BIBLIOTECA|RANCHO|CORAL|COROS?|ESTRUTURA|PLATAFORMA|FUNDO)\b", re.I)


def looks_person(nif, name):
    """Pessoa singular pelo NIF: 1, 2, 3 e 45 = pessoas singulares (5/6/8/9 = coletivas). Privacidade primeiro: nunca se enriquece."""
    return 1 if nif and (nif[0] in "123" or nif[:2] == "45") else 0


AREA_RE = re.compile(r"(Artes plásticas|Cruzamento disciplinar|Teatro|Música|Dança|Fotografia|Arquitetura|Design|Circo|Artes de Rua|Artes visuais|Ópera|Outras?|Multidisciplinar|Cinema|Artes performativas)", re.I)


def parse_lista(text, year, src, sink, orgao="DGARTES", area="cultura", status="atribuido"):
    ctx = []          # contexto: [programa, modalidade, sub]
    pending = []
    n = tot = invalid = 0
    prog = mod = sub = ""
    held = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            pending = []
            continue
        if FOOT_RE.search(line):
            continue
        am = list(AMT.finditer(line))
        nifs = [m for m in NIF9.finditer(line)]
        if am and nifs and ("€" in line):
            nm = nifs[0]
            a = amount(am[-1].group(0))
            if nm.start() > am[-1].start():           # formato 2019: montante antes do NIF
                name = line[:am[-1].start()].strip()
                rest = ""
            else:
                name = line[:nm.start()].strip()
                rest = line[nm.end():am[-1].start()]
            if not name and pending:
                name = " ".join(pending)
            name = re.sub(r"\s+", " ", name).strip(" ,-")
            nif = nm.group(1)
            if not valid_nif(nif):
                invalid += 1
            reg = next((r for r in REGIOES if r.lower() in rest.lower()), None)
            programa = " · ".join(x for x in (prog, mod, sub) if x) or "Apoio às Artes"
            sink.add(area=area, orgao=orgao, programa=programa[:200], detalhe=None, year=year, nif=nif if valid_nif(nif) else None, nome=name, pessoa_singular=looks_person(nif, name),
                     amount=a, status=status, data_decisao=None, regiao=reg, source_url=src, src_key=f"{orgao}:{year}")
            n += 1
            tot += a or 0
            pending = []
            continue
        if am and not nifs and "€" in line and held is not None and not re.match(r"^\s*(TOTAL|Total|Subtotal)", line):
            # célula de nome em várias linhas: NIF numa linha anterior, montante aqui
            left = line[:am[-1].start()]
            for r_ in REGIOES:
                left = re.sub(re.escape(r_), "  ", left, flags=re.I)
            toks = [t_.strip() for t_ in re.split(r"\s{2,}", left) if t_.strip() and not AREA_RE.fullmatch(t_.strip())]
            parts = held["lines"] + toks
            name = re.sub(r"\s+", " ", " ".join(parts)).strip(" ,-")
            a = amount(am[-1].group(0))
            nif = held["nif"]
            reg = next((r for r in REGIOES if r.lower() in line.lower()), None)
            programa = " · ".join(x for x in (prog, mod, sub) if x) or "Apoio às Artes"
            sink.add(area=area, orgao=orgao, programa=programa[:200], detalhe=None, year=year, nif=nif if valid_nif(nif) else None, nome=name, pessoa_singular=looks_person(nif, name),
                     amount=a, status=status, data_decisao=None, regiao=reg, source_url=src, src_key=f"{orgao}:{year}")
            n += 1
            tot += a or 0
            held = None
            pending = []
            continue
        if nifs and not am and held is None and re.fullmatch(r"\s*[1-9]\d{8}\s*", line.strip() if len(line.strip()) < 12 else "x"):
            held = {"nif": nifs[0].group(1), "lines": list(pending[-3:])}
            pending = []
            continue
        if held is not None:
            t_ = re.sub(r"\s+", " ", line).strip()
            if t_ and not AREA_RE.fullmatch(t_) and not AMT.search(t_):
                held["lines"].append(t_)
            held["k"] = held.get("k", 0) + 1
            if held["k"] > 5:
                held = None
            continue
        if HDR_RE.search(line):
            if pending:
                titles = pending[-3:]
                prog = mod = sub = ""
                for t in titles:
                    if re.match(r"^Programa", t, re.I):
                        prog, mod, sub = t, "", ""
                    elif re.match(r"^Modalidade", t, re.I):
                        mod, sub = t, ""
                    else:
                        sub = t
                if not prog and titles and len(titles) >= 2 and not re.match(r"^(Programa|Modalidade)", titles[0], re.I):
                    # dois títulos sem 'Programa': usa o primeiro como programa (ex. "APOIO SUSTENTADO" + modalidade)
                    prog, sub = titles[-2], titles[-1]
                pending = []
            continue
        t = re.sub(r"\s+", " ", line).strip()
        if len(t) > 3 and not AMT.search(t):
            pending.append(t)
    return n, tot, invalid


def parse_subv_report(text, src, sink, orgao, area_fn, program_fn=None, default_status="atribuido", year_override=None, only_year=None):
    """Relatório 'Subvenções públicas submetidas' (Lei da transparência): NIF(EO) EO NIF(B) Beneficiário [montante] data [montante] finalidade ...
    Âncora: linha com dois NIF de 9 dígitos, uma data dd/mm/aaaa e um montante. O nome do beneficiário ocupa a coluna entre NIF(B) e a
    data/montante e pode continuar nas linhas vizinhas (atribuídas à âncora mais próxima). O NIF(B) é a chave; o nome é só de apresentação."""
    lines = text.splitlines()
    anchors = []
    for i, ln in enumerate(lines):
        dm = re.search(r"(?<!\d)(\d{2}/\d{2}/\d{4})(?!\d)", ln)
        nifs = list(NIF9.finditer(ln))
        if not dm or len(nifs) < 2:
            continue
        b = nifs[1]
        if b.start() > dm.start():
            continue
        ams = [m for m in AMT.finditer(ln) if m.start() >= b.end()]
        ams = [m for m in ams if not re.match(r"\d{2}/", ln[m.start():m.start() + 3])]
        if not ams:
            continue
        am = ams[0]
        c1 = min(dm.start(), am.start())
        anchors.append(dict(i=i, nif=b.group(1), c0=b.end(), c1=c1, date=dm.group(1), amt=amount(am.group(0)), fin_c0=max(am.end(), dm.end()), ln=ln))
    if not anchors:
        return 0, 0.0
    SKIP = re.compile(r"Montante|Data da|Transferido|Benefici|Entidade|Finalidade|Programa|Arribar|protocolos|Decreto|^\(?€\)?$|Desporto Federado|Atividade|Lei \d|Resolu|Portaria|Despacho", re.I)
    anchor_idx = {a["i"]: k for k, a in enumerate(anchors)}
    names = {k: [] for k in range(len(anchors))}
    for k, a in enumerate(anchors):
        prev_i = anchors[k - 1]["i"] if k else a["i"] - 4
        next_i = anchors[k + 1]["i"] if k + 1 < len(anchors) else a["i"] + 4
        for j in range(max(prev_i + 1, a["i"] - 4), a["i"]):
            if j in anchor_idx or (a["i"] - j) > (j - prev_i):
                continue
            seg = lines[j][max(0, a["c0"] - 2):a["c1"]] if len(lines[j]) > a["c0"] else ""
            if seg.strip() and not SKIP.search(seg) and not AMT.search(seg):
                names[k].append((j, seg.strip()))
        for j in range(a["i"] + 1, min(next_i, a["i"] + 5)):
            if j in anchor_idx or (j - a["i"]) > (next_i - j):
                continue
            seg = lines[j][max(0, a["c0"] - 2):a["c1"]] if len(lines[j]) > a["c0"] else ""
            if seg.strip() and not SKIP.search(seg) and not AMT.search(seg):
                names[k].append((j, seg.strip()))
    n = 0
    tot = 0.0
    for k, a in enumerate(anchors):
        main = a["ln"][a["c0"]:a["c1"]].strip()
        parts = sorted(names[k] + [(a["i"], main)])
        name = re.sub(r"\s+", " ", " ".join(p[1] for p in parts)).strip()
        fin = re.sub(r"\s+", " ", a["ln"][a["fin_c0"]:]).strip()
        nxt = anchors[k + 1]["i"] if k + 1 < len(anchors) else len(lines)
        for j in range(a["i"] + 1, min(nxt, a["i"] + 6)):
            if j in anchor_idx:
                break
            seg = re.sub(r"\s+", " ", lines[j][max(0, a["fin_c0"] - 4):] if len(lines[j]) > a["fin_c0"] else "").strip()
            if seg and len(fin) < 160:
                fin += " " + seg
        d, mth, y = a["date"].split("/")
        yr = year_override or int(y)
        if only_year and int(y) != only_year:
            continue
        programa, ar = program_fn(fin, name)
        sink.add(area=ar, orgao=orgao, programa=programa[:200], detalhe=fin[:300] or None, year=yr, nif=a["nif"] if valid_nif(a["nif"]) else None, nome=name,
                 pessoa_singular=looks_person(a["nif"], name), amount=a["amt"], status=default_status, data_decisao=f"{y}-{mth}-{d}",
                 source_url=src, src_key=f"{orgao}:subv{yr}")
        n += 1
        tot += a["amt"] or 0
    return n, tot


# ----------------------------------------------------------------------------- ICA
ICA = "https://www.ica-ip.pt"
ICA_CATS = [299, 307, 694, 304, 308, 300, 834, 301, 314, 306, 312, 310, 559, 561, 597, 315, 557, 558, 311, 317, 447, 594, 316, 305, 313, 833, 508, 727, 510, 303, 302, 600, 760, 867, 297, 509, 595, 593, 560]


def ica_index():
    """Lista (url, titulo) dos PDF 'Apoiadas' do ICA, por categoria (paginado). Respeita 1,4 s por pedido."""
    out, seen = [], set()
    for cat in ICA_CATS:
        for page in range(1, 12):
            u = f"{ICA}/pt/downloads/candidaturas-admitidas-e-apoiadas/?search=1&cat={cat}&id_ano=0" + (f"&p={page}" if page > 1 else "")
            try:
                h = fetch(u, f"ica/idx/c{cat}_p{page}.html", binary=False)
            except Exception as e:  # noqa: BLE001
                log("ICA idx", cat, page, e)
                break
            links = re.findall(r'<h2>\s*<a href="(/fotos/downloads/[^"]+\.pdf)"[^>]*>\s*([^<]+?)\s*</a>', h)
            new = [(u_, html.unescape(t)) for u_, t in links if u_ not in seen]
            if not links or not new:
                break
            for u_, t in new:
                seen.add(u_)
                out.append((ICA + u_, t))
            if f"p={page + 1}" not in h:
                break
    return out


# ----------------------------------------------------------------------------- IPDJ
IPDJ = "https://ipdj.gov.pt"
IPDJ_XLS = ("/documents/20123/0/PAAJ_Publicacao_2007_2018.xls/472543f5-0bbd-4b99-9666-fea0568f3439?t=1613742616677", "paaj_2007_2018.xls")
IPDJ_SUBV = {  # ano -> (caminho no site, ficheiro) — "Documentos Financeiros": Listagem de subvenções
    2019: ("/documents/20123/52988/Listagem-Subvencoes-2019.pdf/be08ed95-39df-9c9a-04b2-bc6a2e0e4309?t=1654163685396", "sub2019.pdf"),
    2020: ("/documents/20123/3047780/Listagem-Subvencoes-2020.pdf/210ab46a-6620-6ae3-f7a6-099aa9757318?t=1654163960528", "sub2020.pdf"),
    2021: ("/documents/20123/14793981/Listagem-subvencoes-2021.pdf/1106df83-e7fa-2d6e-85a9-4c92f0391e3f?t=1654164160367", "sub2021.pdf"),
    2022: ("/documents/20123/22536202/Listagem+Subven%C3%A7%C3%B5es_2022.pdf/d3f06998-186a-4525-4301-8293d40d55ce?t=1716829710865", "sub2022.pdf"),
    2023: ("/documents/20123/28378101/Listagem+Subven%C3%A7%C3%B5es_2023.pdf/f1ee6547-f526-618e-112f-d0abfea98251?t=1716829666924", "sub2023.pdf"),
    2024: ("/documents/20123/28781830/Subven%C3%A7%C3%B5es+2024.pdf/ede6fea5-7654-3491-69fe-2e521cae0265?t=1740768204595", "sub2024.pdf"),
}
YOUTH_RE = re.compile(r"\bPA[JEI]\b|PAACJ|Gera[cç][aã]o Z|\bIDA\b|Arribar|\bCTI\b|Formar|Ferias em Movimento|\bFM\b|VJNF|Associativismo Jovem|Juvenil|Estudantil|Infra", re.I)


def ipdj_program(fin, name):
    f = fin
    f = re.sub(r"\s*(Decreto-?\s*Lei|Lei|Resolu[cç][aã]o do Conselho|Portaria|Protocolo|Despacho|N[aã]o existe)\b.*$", "", f).strip(" ;,")
    f = re.sub(r"\s*(\d{2}/\d{2}/\d{4}|Decreto\S*|Resolu\S*|Conselho de).*$", "", f).strip(" ;,")
    first = re.split(r";|,\s(?=[A-Z])", f)[0].strip() or fin[:60] or "Subvenção IPDJ"
    ar = "juventude" if YOUTH_RE.search(fin[:120]) else "desporto"
    return ("IPDJ · " + first)[:120], ar


def parse_ipdj_xls(path, src, sink):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import _xls
    book = _xls.XlsBook(str(path))
    n = tot = 0
    per_year = {}
    for sheet, _ in book.sheets:
        m = re.search(r"(20\d\d)", sheet)
        if not m:
            continue
        year = int(m.group(1))
        rows = book.rows(sheet)
        prog = "Associativismo juvenil"
        cnt = 0
        for k in sorted(rows):
            r = rows[k]
            vals = [v for v in r.values() if isinstance(v, str) and v.strip()]
            if len(r) <= 2 and vals and not isinstance(r.get(3), (int, float)):
                t = re.sub(r"\s+", " ", vals[0]).strip()
                if re.match(r"^(PA[JEI]|PAACJ|Programa|PRID|IDA|Medida|Apoio)", t):
                    prog = t
                continue
            nif, nm, ap = r.get(1), r.get(2), r.get(3)
            if isinstance(ap, (int, float)) and isinstance(nm, str) and isinstance(nif, (int, float)) and ap > 0:
                ns = str(int(nif)).zfill(9)
                if not valid_nif(ns):
                    ns = None
                name = re.sub(r"\s+", " ", nm).strip()
                sink.add(area="juventude", orgao="IPDJ", programa=("IPDJ · " + prog)[:200], detalhe=None, year=year, nif=ns, nome=name,
                         pessoa_singular=looks_person(ns, name), amount=round(float(ap), 2), status="atribuido",
                         data_decisao=str(r.get(4) or "") or None, source_url=src, src_key=f"IPDJ:paaj{year}")
                n += 1
                cnt += 1
                tot += ap
        per_year[year] = cnt
    return n, tot, per_year


# ----------------------------------------------------------------------------- FCT
FCT = "https://www.fct.pt"
FCT_PROJ = (FCT + "/wp-content/uploads/2022/03/Lista-Projetos-ID.csv", "fct/projetos.csv", FCT + "/sobre/a-fct-em-numeros/projetos-de-id/")
FCT_INST = (FCT + "/wp-content/uploads/2023/04/Lista-das-Instituicoes.csv", "fct/instituicoes.csv", FCT + "/sobre/a-fct-em-numeros/instituicoes/")


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def parse_fct(sink):
    n1 = t1 = n2 = t2 = 0
    for r in read_csv(RAW / FCT_PROJ[1]):
        a = amount(r["Financiamento Concedido"])
        m = re.search(r"/(20\d\d)\s*$", r["Data aprovação"].strip())
        if a is None or not m:
            continue
        conc = re.sub(r"\s+", " ", r["Concurso"]).strip()
        sink.add(area="ciencia", orgao="FCT", programa=("FCT · Projetos I&D · " + conc)[:200], detalhe=re.sub(r"\s+", " ", r["Titulo"]).strip()[:300], year=int(m.group(1)),
                 nif=None, nome=re.sub(r"\s+", " ", r["Instituição Proponente"]).strip(), amount=a, status="aprovado", data_decisao="-".join(r["Data aprovação"].strip().split("/")[::-1]),
                 regiao=None, source_url=FCT_PROJ[2], src_key="FCT:proj")
        n1 += 1
        t1 += a
    for r in read_csv(RAW / FCT_INST[1]):
        a = amount(r["Financiamento concedido"])
        m = re.search(r"/(20\d\d)\s*$", (r["Data inicio"] or "").strip())
        if a is None or not m or not r["Instituição de Gestão Principal"].strip():
            continue
        sink.add(area="ciencia", orgao="FCT", programa=("FCT · " + re.sub(r"\s+", " ", r["Instrumento"]).strip())[:200], detalhe=re.sub(r"\s+", " ", r["Designação"]).strip()[:300], year=int(m.group(1)),
                 nif=None, nome=re.sub(r"\s+", " ", r["Instituição de Gestão Principal"]).strip(), amount=a, status="aprovado",
                 data_decisao=None, source_url=FCT_INST[2], src_key="FCT:inst")
        n2 += 1
        t2 += a
    return n1, t1, n2, t2


def _cells(line):
    """tokens (texto, centro_x) separados por 2+ espaços."""
    return [(m.group(0).strip(), (m.start() + m.end()) / 2) for m in re.finditer(r"\S+(?: \S+)*", line.replace("\t", " ")) if m.group(0).strip()]


def _cells2(line):
    out = []
    for m in re.finditer(r"(?:\S+(?: ?\S+)*?)(?=\s{2,}|$)", line):
        t = m.group(0).strip()
        if t:
            out.append((t, (m.start() + m.end()) / 2))
    return out


ROLE = [("CANDIDATURA", "titulo"), ("PROJETO", "titulo"), ("PROJECTO", "titulo"), ("OBRA", "titulo"), ("REQUERENTE", "req"), ("PRODUTOR", "req"), ("BENEFICI", "ben"), ("ENTIDADE", "ben"), ("PROPONENTE", "req"), ("REALIZADOR", "-"),
        ("POSI", "-"), ("AVALIA", "-"), ("PONTUA", "-"), ("CLASSIF", "-"), ("MONTANTE", "val"), ("VALOR", "val"), ("APOIO", "val"), ("IDENTIFICADOR", "id"), ("N.º", "id"), ("Nº", "id")]


def parse_ica_pdf(text):
    """Devolve [{titulo, req, ben, amount}] de um PDF 'Apoiadas' do ICA (tabelas com células centradas e multi-linha)."""
    lines = text.splitlines()
    # cabeçalho(s): linhas antes da 1.ª linha de dados que contenham palavras-chave
    hdr_idx = [i for i, l in enumerate(lines) if re.search(r"REQUERENTE|CANDIDATURA|BENEFICI|Produtor|PRODUTOR", l) and not re.search(r"[0-9]{2,}", l)]
    if re.search(r"ENTRADAS A CONCURSO|LISTA DEFINITIVA|Admitida", text):
        return []
    if not hdr_idx:
        return []
    out = []
    # processa por "tabela": grupos de linhas de cabeçalho consecutivas (≤3 linhas de distância)
    groups = []
    for i in hdr_idx:
        if groups and i - groups[-1][-1] <= 3:
            groups[-1].append(i)
        else:
            groups.append([i])
    for gi, g in enumerate(groups):
        start = g[-1] + 1
        while start < len(lines) and (not lines[start].strip() or re.fullmatch(r"\W*(MONTANTE|ATRIBU\S*|ENTIDADE|BENEFICI\S*|POSI\S*|VALOR|AVALIA\S*|FINAL|REALIZADOR\S*|[\d1-9][ªº]? Decis\S+)(\s+\W*(MONTANTE|ATRIBU\S*|ENTIDADE|BENEFICI\S*|POSI\S*|VALOR|AVALIA\S*|FINAL|ATRIBUIR))*\W*", lines[start].strip(), re.I) or re.search(r"Decis[ãa]o\s*$", lines[start])) and start - g[-1] < 5:
            start += 1
        end = groups[gi + 1][0] if gi + 1 < len(groups) else len(lines)
        cols = []   # [centro, texto]
        for i in range(max(0, g[0] - 1), g[-1] + 1):
            for t, c in _cells2(lines[i]):
                for col in cols:
                    if abs(col[0] - c) <= 9:
                        col[1] += " " + t
                        col[0] = (col[0] + c) / 2
                        break
                else:
                    cols.append([c, t])
        roles = []
        for c, t in cols:
            r = next((rl for kw, rl in ROLE if kw in t.upper()), "-")
            roles.append((c, r))
        if not any(r == "val" for _, r in roles):
            continue
        body = lines[start:end]
        # âncoras = linhas com montante
        anchors = [k for k, l in enumerate(body) if AMT.search(l) and "€" in l]
        if not anchors:
            continue
        blocks = []
        for k, ak in enumerate(anchors):
            lo = anchors[k - 1] + 1 if k else 0
            hi = anchors[k + 1] if k + 1 < len(anchors) else len(body)
            blocks.append((lo, ak, hi))
        for k, (lo, ak, hi) in enumerate(blocks):
            # linhas sem montante: as mais próximas desta âncora (limite: sem linhas em branco >1 entre) 
            mine = []
            for j in range(lo, hi):
                if j == ak:
                    mine.append(j)
                    continue
                if not body[j].strip():
                    continue
                dprev = j - (anchors[k - 1] if k else -99)
                dnext = (anchors[k + 1] if k + 1 < len(anchors) else 10**6) - j
                d_me = abs(j - ak)
                other = dprev if j < ak else dnext
                if d_me < other or (d_me == other and j > ak) or (k == 0 and j < ak) or (k == len(blocks) - 1 and j > ak and d_me <= 4):
                    # corta rodapé
                    if re.search(r"T \+351|Pra[çc]a|Rua Lu|www\.ica|NIPC|Mod\. |\d+/\d+\s*$|Lisboa$|TOBIS", body[j]):
                        continue
                    mine.append(j)
            texts = defaultdict(list)
            amt = None
            for j in sorted(mine):
                for t, c in _cells2(body[j]):
                    if AMT.fullmatch(t.replace("€", "").strip()) or (AMT.search(t) and "€" in t):
                        amt = amt if amt is not None else amount(t)
                        continue
                    if re.fullmatch(r"€|C\d{8}-\d{3}|\d{1,2}|\d,\d{2}|\d{1,2}[ºª.]?", t):
                        continue
                    ci = min(range(len(roles)), key=lambda x: abs(roles[x][0] - c))
                    texts[roles[ci][1]].append(t)
            if amt is None:
                continue
            row = {r: re.sub(r"\s+", " ", " ".join(v)).strip() for r, v in texts.items()}
            row["amount"] = amt
            out.append(row)
    return out


# ----------------------------------------------------------------------------- ICA (parse + ingest)
def ica_year(title, text):
    m = re.findall(r"\b(20[12]\d)\b", title) or re.findall(r"\b(20[12]\d)\b", text[:600])
    return int(m[-1]) if m else None


def ingest_ica(sink, sources):
    idx = json.load(open(RAW / "ica/index.json")) if (RAW / "ica/index.json").exists() else ica_index()
    if not (RAW / "ica/index.json").exists():
        (RAW / "ica").mkdir(parents=True, exist_ok=True)
        json.dump(idx, open(RAW / "ica/index.json", "w"), ensure_ascii=False)
    sel = [(u, t) for u, t in idx if not re.search(r"dmitida|Proposta de classifica|Projeto de classifica", t)]
    tot_rows = 0
    for u, t in sel:
        try:
            data = fetch(u, "ica/pdf/" + u.rsplit("/", 1)[1])
            pth = RAW / "ica/pdf" / u.rsplit("/", 1)[1]
            txt = pdftext(pth)
        except Exception as e:  # noqa: BLE001
            sources.append(("ICA", t, u, None, 0, 0, "erro", str(e)[:160]))
            continue
        rows = parse_ica_pdf(txt)
        if not rows or not any(r.get("ben") or r.get("req") for r in rows):
            alt = apoios_pdf.ica_simple(txt)
            gl = apoios_pdf.ica_global(txt)
            if alt and gl and abs(sum(x["amount"] for x in alt) - gl) < 0.01:
                rows = alt
        yr = ica_year(t, txt)
        prog = re.sub(r"\s*[-–]?\s*Apoiadas?.*$", "", t).strip(" -–")
        prog = re.sub(r"\s*\b20[12]\d\b\s*", " ", prog).strip(" -–")
        n = tot = 0
        for r in rows:
            name = (r.get("ben") or r.get("req") or "").strip(" -–,")
            name = re.sub(r"\s*\d[ªº]\s*Decis\S+.*$", "", name).strip(" -–,")
            name = re.sub(r"\b(ENTIDADE|BENEFICI[ÁA]RIA|REQUERENTE|MONTANTE|ATRIBU\S+)\b\s*$", "", name, flags=re.I).strip(" -–,")
            name = re.sub(r"^(ENTIDADE|BENEFICI[ÁA]RIA)\s+", "", name, flags=re.I)
            if not name or len(name) < 3 or not yr or r["amount"] < 100:
                continue
            sink.add(area="cultura", orgao="ICA", programa=("ICA · " + prog)[:200], detalhe=(r.get("titulo") or None) and r["titulo"][:200], year=yr, nif=None, nome=name,
                     amount=r["amount"], status="atribuido", source_url=u, src_key=f"ICA:{u.rsplit('/', 1)[1]}")
            n += 1
            tot += r["amount"]
        tot_rows += n
        sources.append(("ICA", t, u, yr, n, tot, "ok" if n else "sem tabela legível", None if n else "PDF sem tabela em texto (imagem) ou formato não reconhecido"))
    return tot_rows


# ----------------------------------------------------------------------------- ligação ao registo, consolidação, troca atómica
def load_entities():
    p = DATA_DIR / "politica.db"
    if not p.exists():
        return {}, {}, {}
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=60)
    by_nif, by_name, by_alias = {}, defaultdict(list), defaultdict(set)
    for nif, name, kind in con.execute("SELECT nif, name, kind FROM entities WHERE nif IS NOT NULL AND nif != ''"):
        by_nif[nif] = (name, kind)
    for nif, name in con.execute("SELECT nif, name FROM entities WHERE name IS NOT NULL"):
        k = norm_org(name)
        if len(k) >= 6:
            by_name[k].append(nif)
        if nif:
            for ak in alias_keys(name):
                by_alias[ak].add(nif)
    con.close()
    return by_nif, by_name, by_alias


MATCH_RANK = {"nif": 3, "nome": 2, "alias": 1}


def link_and_consolidate(db):
    by_nif, by_name, by_alias = load_entities()
    rows = db.execute("SELECT id, nif, nome, nome_norm, pessoa_singular FROM apoios_n").fetchall()
    st = Counter()
    upd = []
    for id_, nif, nome, nn, pers in rows:
        ent, mt = None, None
        if pers:
            st["pessoa"] += 1
        elif nif and nif in by_nif:
            ent, mt = nif, "nif"
        elif nif:
            st["nif_sem_registo"] += 1
        else:
            c = set(x for x in by_name.get(nn, []) if x)
            if len(c) == 1:
                ent, mt = next(iter(c)), "nome"
            elif len(c) > 1:
                st["nome_ambiguo"] += 1
            else:
                cand = set()
                for ak in alias_keys(nome):
                    cand |= by_alias.get(ak, set())
                if len(cand) == 1:
                    ent, mt = next(iter(cand)), "alias"
                else:
                    st["alias_ambiguo" if cand else "nome_sem_registo"] += 1
        bkey = ("N" + (ent or nif)) if (ent or nif) else ("M" + nn)
        if pers:
            bkey = "P" + (nif or nn)   # pessoa singular: chave própria, nunca ligada
        upd.append((ent, mt, bkey, id_))
        st[mt or "nao"] += 1
    db.executemany("UPDATE apoios_n SET ent_nif=?, match=?, bkey=? WHERE id=?", upd)
    db.commit()
    # beneficiários
    ben = {}
    for r in db.execute("SELECT bkey, nif, ent_nif, nome, match, pessoa_singular, amount, area, orgao, year FROM apoios_n"):
        b = ben.setdefault(r[0], dict(nif=r[1], ent=r[2], names=Counter(), match=r[4], pers=r[5], n=0, total=0.0, areas=set(), orgaos=set(), ys=[]))
        b["names"][r[3]] += 1
        if MATCH_RANK.get(r[4], 0) > MATCH_RANK.get(b["match"], 0):
            b["match"] = r[4]
        b["n"] += 1
        b["total"] += r[6] or 0
        b["areas"].add(r[7])
        b["orgaos"].add(r[8])
        if r[9]:
            b["ys"].append(r[9])
    out = []
    for k, b in ben.items():
        name = b["names"].most_common(1)[0][0]
        if b["ent"] and b["ent"] in by_nif:
            name = by_nif[b["ent"]][0]
        out.append((k, b["nif"], b["ent"], name, b["match"], b["pers"], b["n"], round(b["total"], 2), ",".join(sorted(b["areas"])), ",".join(sorted(b["orgaos"])), min(b["ys"] or [None]), max(b["ys"] or [None]), None))
    for i in range(0, len(out), 2000):
        db.executemany("INSERT INTO ben_n VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", out[i:i + 2000])
        db.commit()
    # nomes consolidados também nas linhas (apresentação coerente por NIF)
    best = {k: o[3] for k, o in zip(ben.keys(), out)}
    db.executemany("UPDATE apoios_n SET nome=? WHERE bkey=? AND pessoa_singular=0", [(v, k) for k, v in best.items() if not k.startswith("P")])
    db.commit()
    # sobreposição com fundos europeus (COMPETE/FCT: operações POCI-01-0145-FEDER*), apenas indicativa
    fp = DATA_DIR / "fundos.db"
    ov = 0
    if fp.exists():
        try:
            fc = sqlite3.connect(f"file:{fp}?mode=ro", uri=True, timeout=60)
            m = dict(fc.execute("SELECT nif, ROUND(SUM(aprovado),2) FROM awards WHERE counts=1 AND code LIKE 'POCI-01-0145-FEDER%' AND nif IS NOT NULL GROUP BY nif").fetchall())
            fc.close()
            upd2 = [(m[nif], "N" + nif) for nif in m]
            db.executemany("UPDATE ben_n SET fundos_overlap=? WHERE bkey=? AND areas LIKE '%ciencia%'", upd2)
            ov = sum(m.get(r[0], 0) for r in db.execute("SELECT ent_nif FROM ben_n WHERE ent_nif IS NOT NULL AND areas LIKE '%ciencia%'"))
            db.commit()
        except Exception as e:  # noqa: BLE001
            log("fundos overlap:", e)
    return st, len(out), ov


def swap(db):
    db.execute("BEGIN IMMEDIATE")
    for t in ("apoios", "ben", "sources"):
        db.execute(f"DROP TABLE IF EXISTS {t}")
        db.execute(f"ALTER TABLE {t}_n RENAME TO {t}")
    for stmt in INDEXES.strip().split("\n"):
        if stmt.strip():
            db.execute(stmt)
    db.commit()


def write_partial(db):
    """Anos incompletos ou com quebra de série, por (área, organismo, ano): o cliente marca-os nos gráficos (não codificar no cliente)."""
    P = []
    yrs = db.execute("SELECT area, orgao, year, COUNT(*) FROM apoios GROUP BY area, orgao, year").fetchall()
    have = {(a, o, y): n for a, o, y, n in yrs}
    cur = int(time.strftime("%Y"))
    if ("cultura", "DGARTES", 2024) in have:
        P.append(("cultura", "DGARTES", 2024, "parcial", f"DGARTES 2024: apenas {have[('cultura', 'DGARTES', 2024)]} decisões lidas (o relatório de 2024 só inclui decisões de 2024); não interpretar como queda do apoio"))
    miss = defaultdict(int)
    for o, y, st in db.execute("SELECT orgao, year, status FROM sources"):
        if o == "ICA" and y and st != "ok":
            miss[y] += 1
    for (a, o, y), n in have.items():
        if o == "ICA" and (miss.get(y, 0) >= 3 or y >= cur - 1):
            ok = db.execute("SELECT COUNT(*) FROM sources WHERE orgao='ICA' AND year=? AND status='ok'", (y,)).fetchone()[0]
            m = miss.get(y, 0)
            P.append((a, o, y, "parcial", f"ICA {y}: {n} apoios lidos de {ok} PDFs; {m} PDF(s) sem tabela legível (por ler)" + ("; ano em curso" if y >= cur else ""), f"{m} PDF por ler" + (" (em curso)" if y >= cur else "")))
    for y in sorted({y for (a, o, y) in have if o == "FCT" and y >= cur - 1}):
        P.append(("ciencia", "FCT", y, "parcial", f"FCT {y}: ano em curso, só concursos já homologados ({have[('ciencia', 'FCT', y)]} registos)" if y >= cur else f"FCT {y}: pode estar incompleto (resultados provisórios ainda a ser publicados)"))
    if ("juventude", "IPDJ", 2024) in have:
        P.append(("juventude", "IPDJ", 2024, "quebra", "IPDJ 2024: valor quase o dobro de 2023 por novos programas na listagem (ex. «ANDA Conhecer Portugal», «Inclusão e Integração Social»); possível quebra de série, não confirmada pela fonte"))
    if ("juventude", "IPDJ", 2019) in have:
        P.append(("juventude", "IPDJ", 2019, "quebra", "IPDJ 2007–2018 = PAAJ (só associativismo juvenil, XLS); 2019+ = listagem de subvenções (outro formato): não comparar entre 2018 e 2019"))
    db.execute("BEGIN IMMEDIATE")
    db.execute("DROP TABLE IF EXISTS partial")
    db.execute("CREATE TABLE partial (area TEXT, orgao TEXT, year INTEGER, kind TEXT, note TEXT, short TEXT)")
    db.executemany("INSERT INTO partial VALUES (?,?,?,?,?,?)", [t + (None,) * (6 - len(t)) for t in P])
    db.commit()


def main():
    t0 = time.time()
    RAW.mkdir(parents=True, exist_ok=True)
    db = open_db()
    sink = Sink(db)
    sources, notes = [], []
    tools_ok = subprocess.run(["which", "pdftotext"], capture_output=True).returncode == 0
    if not tools_ok:
        raise SystemExit("pdftotext (poppler-utils) em falta")

    # --- DGARTES
    for y, f in DG_LISTS.items():
        url = f"{DG_BASE}/sites/default/files/apoios/{f}"
        try:
            fetch(url, f"dgartes/{f}")
            txt = pdftext(RAW / "dgartes" / f)
            n, tot, inv = parse_lista(txt, y, url, sink)
            sources.append(("DGARTES", f"Lista de apoios atribuídos em {y}", url, y, n, tot, "ok", f"NIF inválidos descartados: {inv}" if inv else None))
            log("DGARTES", y, n, round(tot))
        except Exception as e:  # noqa: BLE001
            sources.append(("DGARTES", f"Lista de apoios atribuídos em {y}", url, y, 0, 0, "erro", str(e)[:160]))
            log("DGARTES", y, "ERRO", e)
    for y, f in DG_OLD.items():
        url = f"{DG_BASE}/sites/default/files/apoios/{f}"
        try:
            fetch(url, f"dgartes/{f}")
            rows, tots, notes = apoios_pdf.parse(RAW / "dgartes" / f)
            grand = [t["total"] for t in tots if re.search(r"TODAS|GERAL", t["label"])]
            s = sum(r["amount"] or 0 for r in rows)
            if not rows or notes or not grand or abs(s - grand[0]) > 0.01:
                sources.append(("DGARTES", f"Lista de apoios {y} (por modalidade)", url, y, 0, 0, "não reconciliado", f"soma das linhas {s:.2f} vs total impresso {grand[0] if grand else 'n/d'}; não ingerido"))
                log("DGARTES", y, "NAO RECONCILIA", round(s), grand)
                continue
            n = 0
            for r in rows:
                nif = r["nif"] if r["nif"] and valid_nif(r["nif"]) else None
                sink.add(area="cultura", orgao="DGARTES", programa=re.sub(r"\s+", " ", r["prog"]).strip().capitalize()[:200], detalhe=None, year=y, nif=nif, nome=r["nome"],
                         pessoa_singular=looks_person(nif, r["nome"]), amount=r["amount"], status="atribuido", regiao=r["regiao"] or None, source_url=url, src_key=f"DGARTES:{f}")
                n += 1
            sources.append(("DGARTES", f"Lista de apoios {y} (por modalidade)", url, y, n, s, "ok", f"geometria do PDF; soma das linhas = total impresso ({grand[0]:.2f})"))
            log("DGARTES", y, n, round(s))
        except Exception as e:  # noqa: BLE001
            sources.append(("DGARTES", f"Lista de apoios {y} (por modalidade)", url, y, 0, 0, "erro", str(e)[:160]))
            log("DGARTES", y, "ERRO", e)
    url = f"{DG_BASE}/sites/default/files/apoios/{DG_SUBV_2024}"
    try:
        fetch(url, f"dgartes/{DG_SUBV_2024}")
        txt = pdftext(RAW / "dgartes" / DG_SUBV_2024)
        n, tot = parse_subv_report(txt, url, sink, "DGARTES", None, lambda fin, name: ("Apoio às Artes · subvenções públicas 2024", "cultura"), only_year=2024)
        sources.append(("DGARTES", "Subvenções Públicas Submetidas (relatório publicado como «apoios 2024»; só decisões de 2024)", url, 2024, n, tot, "ok", "decisões de 2022–2023 do mesmo relatório omitidas para não duplicar as listas anuais"))
        log("DGARTES 2024", n, round(tot))
    except Exception as e:  # noqa: BLE001
        sources.append(("DGARTES", "Subvenções Públicas Submetidas 2024", url, 2024, 0, 0, "erro", str(e)[:160]))

    # --- IPDJ
    try:
        u = IPDJ + IPDJ_XLS[0]
        fetch(u, "ipdj/" + IPDJ_XLS[1])
        n, tot, per = parse_ipdj_xls(RAW / "ipdj" / IPDJ_XLS[1], u, sink)
        for y, c in sorted(per.items()):
            sources.append(("IPDJ", f"Publicação de apoios ao associativismo jovem (PAAJ) {y}", u, y, c, None, "ok", "XLS 2007–2018"))
        log("IPDJ PAAJ", n, round(tot))
    except Exception as e:  # noqa: BLE001
        log("IPDJ xls ERRO", e)
        sources.append(("IPDJ", "PAAJ 2007–2018", IPDJ + IPDJ_XLS[0], None, 0, 0, "erro", str(e)[:160]))
    for y, (path, f) in IPDJ_SUBV.items():
        u = IPDJ + path
        try:
            fetch(u, "ipdj/" + f)
            txt = pdftext(RAW / "ipdj" / f)
            n, tot = parse_subv_report(txt, u, sink, "IPDJ", None, ipdj_program, year_override=y)
            sources.append(("IPDJ", f"Listagem de subvenções {y}", u, y, n, tot, "ok", None))
            log("IPDJ", y, n, round(tot))
        except Exception as e:  # noqa: BLE001
            sources.append(("IPDJ", f"Listagem de subvenções {y}", u, y, 0, 0, "erro", str(e)[:160]))
            log("IPDJ", y, "ERRO", e)

    # --- FCT
    try:
        fetch(FCT_PROJ[0], FCT_PROJ[1])
        fetch(FCT_INST[0], FCT_INST[1])
        n1, t1, n2, t2 = parse_fct(sink)
        sources.append(("FCT", "Lista de Projetos de I&D financiados (CSV)", FCT_PROJ[2], None, n1, t1, "ok", "financiamento concedido por projeto; ano = data de aprovação; investigadores responsáveis NÃO guardados"))
        sources.append(("FCT", "Lista de financiamento a Instituições de I&D (CSV)", FCT_INST[2], None, n2, t2, "ok", "financiamento plurianual por unidade/laboratório; ano = início"))
        log("FCT", n1, round(t1), n2, round(t2))
    except Exception as e:  # noqa: BLE001
        log("FCT ERRO", e)
        sources.append(("FCT", "Projetos e Instituições", FCT_PROJ[2], None, 0, 0, "erro", str(e)[:160]))

    # --- ICA
    try:
        if os.environ.get("APOIOS_SKIP_ICA"):
            raise RuntimeError("ICA ignorado (APOIOS_SKIP_ICA)")
        n = ingest_ica(sink, sources)
        log("ICA", n)
    except Exception as e:  # noqa: BLE001
        log("ICA ERRO", e)
        sources.append(("ICA", "Candidaturas apoiadas", ICA + "/pt/downloads/candidaturas-admitidas-e-apoiadas/", None, 0, 0, "erro", str(e)[:160]))
    sink.flush()

    st, nben, ov = link_and_consolidate(db)
    db.executemany("INSERT INTO sources_n VALUES (?,?,?,?,?,?,?,?)", sources)
    db.commit()
    n_rows = db.execute("SELECT COUNT(*) FROM apoios_n").fetchone()[0]
    swap(db)
    write_partial(db)
    meta = {
        "built": time.strftime("%Y-%m-%d %H:%M"), "rows": n_rows, "beneficiarios": nben, "match": dict(st), "fundos_overlap_ciencia": ov,
        "blocked": [
            "DGARTES: listas 2010–2017 lidas por geometria do PDF: só 2010 e 2017 reconciliam com o total impresso (2011–2016 por ler; 2012 difere 0,23 %); 2024 só decisões de 2024 (relatório de subvenções); sem lista de candidaturas não apoiadas.",
            "ICA: PDFs sem tabela em texto (imagem) e listas de 2026 em curso não lidas; só requerente/beneficiária e montante por concurso, sem NIF — ligação por nome exato.",
            "IPDJ: contratos-programa desportivos (SIEC) exigem autenticação; publicações em Diário da República (2019–2023 PAAJ) não lidas (usada a Listagem de subvenções, a mesma obrigação legal).",
            "FCT: bolsas individuais (pessoas singulares) e investigadores responsáveis deliberadamente excluídos; instituições sem NIF — ligação por nome exato; resultados provisórios de 2025/26 ainda em publicação.",
            "Comité Olímpico, Fundação do Desporto, Ciência Viva, ANI e Compete: sem lista de beneficiários própria nos dados abertos (Compete/PT2020/PT2030 estão no módulo Fundos).",
        ],
    }
    for k, v in meta.items():
        db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, json.dumps(v, ensure_ascii=False)))
    db.commit()
    db.execute("PRAGMA wal_checkpoint(PASSIVE)")
    log("apoios:", n_rows, "linhas", nben, "beneficiários", dict(st), f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
