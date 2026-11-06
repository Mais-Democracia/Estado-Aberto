import gzip
import html
import http.cookiejar
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import DATA_DIR, ROOT, UA  # noqa: E402
from since import report, since_days  # noqa: E402

NAME = "intervencoes"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
PAGE = "https://www.parlamento.pt/DAR/Paginas/DAR1Serie.aspx"
SLEEP = float(os.environ.get("INTERV_SLEEP", "1.5"))
MAX_REQ = int(os.environ.get("INTERV_MAX_REQ", "400"))
OFFLINE = os.environ.get("INTERV_OFFLINE") == "1"
LEGS = [x for x in os.environ.get("INTERV_LEGS", "XVII,XVI").split(",") if x]
SINCE = since_days()
if SINCE:
    LEGS = LEGS[:1]
LEG_VALUE = {"XVII": "XVIILEG", "XVI": "XVILEG", "XV": "XVLEG", "XIV": "XIVLEG", "XIII": "XIIILEG"}
ROMAN = {"XVII": 17, "XVI": 16, "XV": 15, "XIV": 14, "XIII": 13, "XII": 12, "XI": 11, "X": 10}
PARTIES = {"PSD", "PS", "CH", "IL", "L", "PCP", "BE", "CDS-PP", "PAN", "JPP", "PEV", "Ninsc", "N insc", "PPD/PSD", "CDS", "PPD/PSD.CDS-PP", "PSD/CDS-PP"}
TYPES = [("Proposta de Resolução", "Proposta de Resolução"), ("Propostas de Resolução", "Proposta de Resolução"),
         ("Proposta de Lei", "Proposta de Lei"), ("Propostas de Lei", "Proposta de Lei"),
         ("Projeto de Resolução", "Projeto de Resolução"), ("Projetos de Resolução", "Projeto de Resolução"),
         ("Projeto de Lei", "Projeto de Lei"), ("Projetos de Lei", "Projeto de Lei"),
         ("Projeto de Deliberação", "Projeto de Deliberação"), ("Projetos de Deliberação", "Projeto de Deliberação"),
         ("Projeto de Revisão Constitucional", "Projeto de Revisão Constitucional"),
         ("Projeto de Regimento", "Projeto de Regimento"), ("Projetos de Regimento", "Projeto de Regimento"),
         ("Apreciação Parlamentar", "Apreciação Parlamentar"), ("Apreciações Parlamentares", "Apreciação Parlamentar"),
         ("Inquérito Parlamentar", "Inquérito Parlamentar"), ("Inquéritos Parlamentares", "Inquérito Parlamentar")]
TYPE_RE = re.compile("(" + "|".join(sorted((re.escape(a) for a, _ in TYPES), key=len, reverse=True)) + ")")
TYPE_MAP = dict(TYPES)
REF_RE = re.compile(r"(\d{1,5})\s*/\s*(XVII|XVI|XV|XIV|XIII|XII|XI|X)\s*/\s*(\d)\s*\.?\s*ª")
MONTHS = {m: i + 1 for i, m in enumerate("janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())}
SCHEMA = """
CREATE TABLE IF NOT EXISTS reunioes (
  key TEXT PRIMARY KEY, leg TEXT, sessao INTEGER, numero INTEGER, data TEXT, pdf_url TEXT, page_url TEXT,
  n_speeches INTEGER, parsed_at TEXT
);
CREATE TABLE IF NOT EXISTS intervencoes (
  id INTEGER PRIMARY KEY, reuniao TEXT, leg TEXT, sessao INTEGER, numero INTEGER, data TEXT, pagina INTEGER,
  orador TEXT, partido TEXT, dep_bid INTEGER, kind TEXT, cargo TEXT, palavras INTEGER, texto TEXT,
  agenda TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS iv_dep ON intervencoes(dep_bid);
CREATE INDEX IF NOT EXISTS iv_data ON intervencoes(data);
CREATE INDEX IF NOT EXISTS iv_reuniao ON intervencoes(reuniao);
CREATE TABLE IF NOT EXISTS iv_ini (
  iv_id INTEGER, bid INTEGER, key TEXT, tipo TEXT, numero INTEGER, leg TEXT, ref TEXT
);
CREATE INDEX IF NOT EXISTS ivi_bid ON iv_ini(bid);
CREATE INDEX IF NOT EXISTS ivi_iv ON iv_ini(iv_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.last = 0.0
        self.n = 0

    def fetch(self, url, data=None, tries=3, timeout=120, binary=False):
        if OFFLINE or self.n >= MAX_REQ:
            raise RuntimeError("offline or request budget reached")
        err = None
        for i in range(tries):
            wait = SLEEP - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.n += 1
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9", "Accept-Encoding": "gzip"})
                with self.op.open(req, timeout=timeout) as r:
                    b = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        b = gzip.decompress(b)
                if binary:
                    if not b.startswith(b"%PDF"):
                        raise RuntimeError("not a pdf")
                    return b
                return b.decode("utf8", "replace")
            except Exception as e:
                err = e
                time.sleep(4 * (i + 1))
        raise RuntimeError(f"fetch failed {url[:90]}: {err}")


def hidden_fields(t):
    return {m.group(1): html.unescape(m.group(2)) for m in re.finditer(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', t)}


def select_options(t, suffix):
    m = re.search(r'<select[^>]*name="([^"]*%s)"[^>]*>(.*?)</select>' % suffix, t, re.S)
    if not m:
        return None, []
    return m.group(1), [(html.unescape(v), html.unescape(l)) for v, l in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', m.group(2))]


def selected(t, suffix):
    m = re.search(r'<select[^>]*name="[^"]*%s"[^>]*>(.*?)</select>' % suffix, t, re.S)
    s = re.search(r'selected="selected"[^>]*value="([^"]*)"', m.group(1)) if m else None
    return html.unescape(s.group(1)) if s else None


def pdf_links(t):
    out = []
    for m in re.finditer(r'href="(https://app\.parlamento\.pt/webutils/docs/doc\.pdf\?path=[^"]*?fich=(DAR-I-(\d+)(?:-[^"&]*)?\.pdf)[^"]*)"', t):
        out.append((int(m.group(3)), html.unescape(m.group(1))))
    return sorted(set(out))


def cache_path(name):
    RAW.mkdir(parents=True, exist_ok=True)
    return RAW / name


def postback(client, t, target, values):
    d = hidden_fields(t)
    d.update(values)
    d["__EVENTTARGET"] = target
    d["__EVENTARGUMENT"] = ""
    return client.fetch(PAGE, data=urllib.parse.urlencode(d).encode())


def discover(client, leg):
    out = []
    f = cache_path(f"index_{leg}.json")
    if OFFLINE and f.exists():
        return [tuple(x) for x in json.loads(f.read_text())]
    try:
        t = client.fetch(PAGE)
    except RuntimeError:
        if f.exists():
            print("parlamento.pt unreachable; using cached index", f.name)
            return [tuple(x) for x in json.loads(f.read_text())]
        raise
    lname, lopts = select_options(t, "ddlLegislatura")
    sname, _ = select_options(t, "ddlSessaoLegislativa")
    want = LEG_VALUE[leg]
    lval = next((v for v, _ in lopts if f"/{want}/".lower() in v.lower() or v.lower().endswith(f"/sites/{want}/dari/dariarquivo".lower())), None)
    if lval and selected(t, "ddlLegislatura") != lval:
        t = postback(client, t, lname, {lname: lval, sname: selected(t, "ddlSessaoLegislativa") or ""})
        lname, lopts = select_options(t, "ddlLegislatura")
        sname, _ = select_options(t, "ddlSessaoLegislativa")
    sname, sopts = select_options(t, "ddlSessaoLegislativa")
    cur = selected(t, "ddlSessaoLegislativa")
    for sv, sl in sopts:
        sm = re.match(r"(\d)", html.unescape(sl))
        sess = int(sm.group(1)) if sm else 0
        tt = t
        if sv != cur:
            tt = postback(client, t, sname, {lname: lval or selected(t, "ddlLegislatura"), sname: sv})
        for num, url in pdf_links(tt):
            out.append((leg, sess, num, url))
    f.write_text(json.dumps(out))
    return out


def fetch_pdf(client, leg, sess, num, url):
    p = cache_path(f"{leg}_{sess}_{num:03d}.pdf")
    if not p.exists():
        p.write_bytes(client.fetch(url, binary=True, timeout=180))
    return p


def pdf_pages(p):
    r = subprocess.run(["pdftotext", str(p), "-"], capture_output=True, check=True, timeout=300)
    return r.stdout.decode("utf8", "replace").split("\f")


NOISE = re.compile(r"^(\d{1,3}|I S[ÉE]RIE\s*[—-]\s*N[ÚU]MERO \d+|\d{1,2} DE [A-ZÇÃÉÍÓÚ]+ DE \d{4}|(Segunda|Terça|Quarta|Quinta|Sexta)-feira, .*|S[áa]bado, .*|Domingo, .*)$")
STAGE = re.compile(r"^(Vozes d[aeo]s? |Aplausos|Protestos|Risos|Palmas|Murmúrios|Apupos|Pausa|Sinal|Entretanto|Nesta altura)")
TURN = re.compile(r"^(?:O|A) Sr\.(?:ª|\.ª)?\s+(.+?)\s*:\s*[—–-]\s*(.*)$")
TURN_OPEN = re.compile(r"^(?:O|A) Sr\.(?:ª)?\s+[^:—]{2,160}$")
APPEND = re.compile(r"(?i)^\W*(para (apresentar|fazer a apresenta)|tem a palavra)")
POINT_RE = re.compile(r"\b(?:primeiro|segundo|terceiro|quarto|quinto|sexto|s[ée]timo|oitavo|nono|d[ée]cimo|[úu]ltimo|seguinte|pr[óo]ximo)\s+ponto\b", re.I)
POINT_END = re.compile(r"(?i)(?:termina|terminad[oa]|conclu[íi]d[oa]|encerr\w+)\W+(?:\w+\W+){0,6}?ponto")
NEXT_DAY = re.compile(r"(?i)amanh[ãa]|pr[óo]xima (?:reuni[ãa]o|sess[ãa]o)|ordem (?:do dia|de trabalhos) de (?:amanh|\d)")
EXPEDIENTE = re.compile(r"(?i)deram entrada|foram? admitid|expediente|baixa(?:ram|do|da)? (?:à|às|ao|aos) comiss")
OBJECT_PREFIX = re.compile(r"(?i)urg[êe]ncia\s*(?:[àa]|[–—-])?\s*$")
RESET = re.compile(r"(?i)encerr|declara[çc][õo]es de voto|votações regimentais|ponto seguinte|passamos às votações|vamos passar às votações|per[ií]odo de|sessão solene")


def clean_lines(pages):
    out = []
    for pi, pg in enumerate(pages, 1):
        for ln in pg.split("\n"):
            s = ln.strip()
            if not s or NOISE.match(s):
                continue
            out.append((pi, s))
    return out


def body_range(lines):
    start = next((i for i, (_, s) in enumerate(lines) if re.match(r"^O Sr\.(?:ª)? Presidente(?: \([^)]*\))?:\s*[—–-]", s)), None)
    if start is None:
        return []
    end = next((i for i, (_, s) in enumerate(lines) if i > start and re.match(r"^Declarações de voto enviadas à Mesa|^Presenças e faltas|^A DIVISÃO DE REDAÇÃO", s)), len(lines))
    return lines[start:end]


def split_turns(lines):
    turns = []
    cur = None
    cont = 0
    i = 0
    while i < len(lines):
        pg, s = lines[i]
        m = TURN.match(s)
        if not m and TURN_OPEN.match(s) and i + 1 < len(lines) and ":" not in s and not s.endswith((".", "?", "!")) and not re.match(r"^(?:O|A) Sr\.", lines[i + 1][1]):
            m = TURN.match(s + " " + lines[i + 1][1])
            if m:
                i += 1
        if m:
            if cur:
                turns.append(cur)
            cur = {"pagina": pg, "who": m.group(1).strip(), "text": [m.group(2)]}
        elif cur is not None:
            if STAGE.match(s):
                cont = 0 if s.endswith((".", "!", "?")) else 2
            elif cont > 0:
                cont = 0 if s.endswith((".", "!", "?")) else cont - 1
            elif re.search(r"[a-zà-ú]-$", cur["text"][-1]) and s[:1].islower():
                cur["text"][-1] = cur["text"][-1][:-1] + s
            else:
                cur["text"].append(s)
        i += 1
    if cur:
        turns.append(cur)
    for t in turns:
        txt = " ".join(t["text"])
        t["text"] = re.sub(r"\s+", " ", txt).strip()
    return turns


def classify(who):
    m = re.match(r"^(.*?)\s*\(([^()]+)\)$", who)
    if m:
        pre, inner = m.group(1).strip(), m.group(2).strip()
        if inner in PARTIES:
            return "dep", pre, inner, None
        return ("pres" if pre.endswith("Presidente") or pre in ("Secretário", "Secretária") else "gov"), inner, None, pre
    if who.startswith("Presidente") or who.startswith("Vice-Presidente"):
        return "pres", None, None, who
    return "office", who, None, who


def refs_in(text):
    out = []
    for tm in TYPE_RE.finditer(text):
        if OBJECT_PREFIX.search(text[max(0, tm.start() - 25):tm.start()]):
            continue
        rest = text[tm.end():]
        nxt = TYPE_RE.search(rest)
        seg = rest[: nxt.start()] if nxt else rest[:600]
        seg = seg[:600]
        for r in REF_RE.finditer(seg):
            item = (TYPE_MAP[tm.group(1)], int(r.group(1)), r.group(2))
            if item not in out:
                out.append(item)
    return out


def header_info(pages):
    head = " ".join(pages[0].split())
    dm = re.search(r"REUNI[ÃA]O(?: PLEN[ÁA]RIA)? DE (\d{1,2}) DE ([A-ZÇÃÉÍÓÚ]+) DE (\d{4})", head)
    data = None
    if dm and dm.group(2).lower() in MONTHS:
        data = "%s-%02d-%02d" % (dm.group(3), MONTHS[dm.group(2).lower()], int(dm.group(1)))
    nm = re.search(r"I S[ée]rie\s*[—-]\s*N[úu]mero (\d+)", head, re.I)
    return data, int(nm.group(1)) if nm else None


def build_speeches(pages):
    lines = body_range(clean_lines(pages))
    turns = split_turns(lines)
    ctx, ctx_text = [], ""
    speeches = []
    open_by = {}
    for t in turns:
        kind, name, party, cargo = classify(t["who"])
        words = len(t["text"].split())
        if kind == "pres":
            if len(t["text"]) < 8000:
                txt = t["text"]
                r = refs_in(txt)
                if NEXT_DAY.search(txt) or EXPEDIENTE.search(txt):
                    ctx, ctx_text = [], ""
                    open_by.clear()
                    continue
                if POINT_END.search(txt) and not POINT_RE.search(txt):
                    ctx, ctx_text = [], ""
                    open_by.clear()
                    continue
                pm = list(POINT_RE.finditer(txt))
                if pm:
                    bounds = [m.start() for m in pm] + [len(txt)]
                    segs = [txt[bounds[i]:bounds[i + 1]] for i in range(len(pm))]
                    sr = [(s, refs_in(s)) for s in segs]
                    sr = [x for x in sr if x[1]]
                    open_by.clear()
                    if len(sr) == 1:
                        ctx, ctx_text = sr[0][1], sr[0][0][:400]
                    else:
                        ctx, ctx_text = [], ""
                    continue
                if r and APPEND.match(txt) and ctx:
                    ctx = ctx + [x for x in r if x not in ctx]
                elif r:
                    ctx, ctx_text = r, t["text"][:400]
                    open_by.clear()
                elif RESET.search(t["text"]):
                    ctx, ctx_text = [], ""
                    open_by.clear()
            continue
        if kind == "office" and not t["who"].strip():
            continue
        speaker = (kind, name, party)
        prev = open_by.get(speaker)
        if prev is not None and prev["ctx"] == ctx and prev["since_long"] == 0 and speeches[prev["idx"]]["kind"] == kind:
            sp = speeches[prev["idx"]]
            sp["texto"] += " " + t["text"]
            sp["palavras"] += words
            for k, v in open_by.items():
                if k != speaker and words >= 40:
                    v["since_long"] += 1
            continue
        for k, v in open_by.items():
            if words >= 40:
                v["since_long"] += 1
        speeches.append({"pagina": t["pagina"], "orador": name, "partido": party, "kind": kind, "cargo": cargo, "palavras": words,
                         "texto": t["text"], "agenda": ctx_text, "refs": list(ctx)})
        open_by[speaker] = {"idx": len(speeches) - 1, "ctx": list(ctx), "since_long": 0}
    return speeches


def norm_name(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def deputy_map(con_main):
    m = {}
    base = DATA_DIR
    if (base / "deputados.db").exists():
        d = sqlite3.connect(f"file:{base / 'deputados.db'}?mode=ro", uri=True)
        for bid, name, party in d.execute("SELECT bid, name, party FROM deputados"):
            m.setdefault((norm_name(name), party), set()).add(bid)
        d.close()
    if (base / "votacoes.db").exists():
        v = sqlite3.connect(f"file:{base / 'votacoes.db'}?mode=ro", uri=True)
        for tbl in ("autores", "relatores"):
            for nome, partido, bid in v.execute(f"SELECT nome, partido, dep_bid FROM {tbl} WHERE dep_bid IS NOT NULL"):
                m.setdefault((norm_name(nome), partido), set()).add(bid)
        v.close()
    names = {}
    for (nm, _), bids in m.items():
        names.setdefault(nm, set()).update(bids)
    m[None] = names
    return m


def ini_map():
    base = DATA_DIR / "votacoes.db"
    m = {}
    if base.exists():
        v = sqlite3.connect(f"file:{base}?mode=ro", uri=True)
        for bid, tipo, numero, leg in v.execute("SELECT bid, tipo, numero, leg FROM iniciativas"):
            m[(tipo, int(numero), leg)] = bid
        v.close()
    return m


def store(con, leg, sess, num, url, pages, dmap, imap):
    data, numero = header_info(pages)
    key = f"{leg}-{sess}-{num:03d}"
    con.execute("DELETE FROM iv_ini WHERE iv_id IN (SELECT id FROM intervencoes WHERE reuniao = ?)", (key,))
    con.execute("DELETE FROM intervencoes WHERE reuniao = ?", (key,))
    sps = build_speeches(pages)
    n = 0
    for s in sps:
        if s["kind"] == "gov" and s["palavras"] < 40 or s["kind"] == "office":
            continue
        if s["kind"] == "dep" and s["palavras"] < 40:
            continue
        bid = None
        if s["kind"] == "dep":
            c = dmap.get((norm_name(s["orador"]), s["partido"]))
            if c and len(c) == 1:
                bid = next(iter(c))
            else:
                c = dmap[None].get(norm_name(s["orador"]))
                if c and len(c) == 1:
                    bid = next(iter(c))
        src = f"{url}#page={s['pagina']}"
        cur = con.execute("INSERT INTO intervencoes (reuniao, leg, sessao, numero, data, pagina, orador, partido, dep_bid, kind, cargo, palavras, texto, agenda, source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (key, leg, sess, numero or num, data, s["pagina"], s["orador"], s["partido"], bid, s["kind"], s["cargo"], s["palavras"], s["texto"], s["agenda"], src))
        for tipo, nr, rl in s["refs"]:
            ibid = imap.get((tipo, nr, rl))
            con.execute("INSERT INTO iv_ini VALUES (?,?,?,?,?,?,?)", (cur.lastrowid, ibid, f"{tipo}|{nr}|{rl}", tipo, nr, rl, f"{tipo} n.º {nr}/{rl}"))
        n += 1
    con.execute("INSERT OR REPLACE INTO reunioes VALUES (?,?,?,?,?,?,?,?,?)", (key, leg, sess, numero or num, data, url, PAGE, n, now()))
    return n


def main():
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    client = Client()
    dmap, imap = deputy_map(con), ini_map()
    stopped = None
    total = 0
    for leg in LEGS:
        try:
            docs = discover(client, leg)
        except Exception as e:
            stopped = f"{leg}: {e}"
            print("discover failed", stopped)
            continue
        print(leg, len(docs), "plenary transcripts listed")
        if SINCE:
            docs = sorted(docs, key=lambda d: (d[1], d[2]), reverse=True)[:SINCE * 3 // 7 + 2]
        for _, sess, num, url in docs:
            key = f"{leg}-{sess}-{num:03d}"
            if con.execute("SELECT 1 FROM reunioes WHERE key = ?", (key,)).fetchone() and not os.environ.get("INTERV_REPARSE"):
                continue
            try:
                p = fetch_pdf(client, leg, sess, num, url)
                pages = pdf_pages(p)
                n = store(con, leg, sess, num, url, pages, dmap, imap)
                con.commit()
                total += n
                print(key, n, "speeches")
            except Exception as e:
                stopped = f"{key}: {e}"
                con.rollback()
                print("failed", stopped)
                if "budget" in str(e):
                    break
    con.execute("INSERT OR REPLACE INTO meta VALUES ('updated_at', ?)", (now(),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('stopped', ?)", (stopped or "",))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (PAGE,))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('legs', ?)", (",".join(LEGS),))
    con.commit()
    print("new speeches", total)
    if SINCE:
        report(con.execute("SELECT MAX(data) FROM reunioes").fetchone()[0])


if __name__ == "__main__":
    main()
