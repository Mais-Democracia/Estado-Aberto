import json
import re
import unicodedata
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path

from lib import INJ

MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
LONG = re.compile(r"\b(\d{1,2})(?:\.?o)?\s+(?:de\s+)?(" + "|".join(MESES) + r")(?:\s+de\s+(\d{4}))?\b", re.I)
SAME_YEAR = re.compile(r"\s+(?:desse|deste|do\s+mesmo)\s+ano\b")
YEAR = re.compile(r"\b((?:19|20)\d{2})\b")
SLASH = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
URL = re.compile(r"https?://|www\.|\b[\w-]+\.(?:pt|com|org|eu|gov|net)\b", re.I)
FIRST = re.compile(r"\b(eu|nós|nos sentimos|meu|minha|meus|minhas|nosso|nossa|nossos|nossas|penso|acho|creio|acredito|acreditamos|parece-me|na minha opinião)\b", re.I)
WORD = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*")
WORDC = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*|,")
LINK = {"de", "da", "do", "das", "dos", "e", "sobre", "para"}
CONNECT = {"de", "da", "do", "das", "dos"}
TAGS = re.compile(r"</?\s*(?:fonte_nao_confiavel|rascunho_nao_confiavel)\s*>", re.I)
STOP = {"o", "a", "os", "as", "um", "uma", "uns", "umas", "em", "no", "na", "nos", "nas", "segundo", "para", "com", "por", "sobre", "ao", "aos", "à", "às", "pelo", "pela", "este", "esta", "estes", "estas", "esse", "essa", "foi", "são", "é", "se", "mas", "como", "quando", "apos", "após", "entre", "durante", "ate", "até", "e", "ou", "que", "dos", "das"}
SKIP_KEYS = {"id", "ids", "score", "revisao", "atrasado", "hash", "fonte_ref", "ia_artigo_id", "evidence_hash", "evento_ids", "bid", "voto_id", "n_ordem", "rid", "palavras", "source_url", "rota", "url", "href", "fonte_modulo"}
NUMTXT = r"\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?"
NUM = re.compile(r"(?<![\w/-])(" + NUMTXT + r")")
TAIL = re.compile(
    r"\s*(?:(?P<pct>%|por\s+cento)|(?P<ord>\.?\s*[ºª°])|(?P<scale>mil\s+milh(?:ões|oes)|milh(?:ões|oes|ão|ao)|bili(?:ões|oes|ão|ao)|mil)\b)?"
    r"(?P<eur>\s*(?:de\s+)?(?:euros?\b|eur\b|€))?", re.I)
SCALES = {"mil": 10 ** 3, "milhao": 10 ** 6, "milhoes": 10 ** 6, "mil milhoes": 10 ** 9, "biliao": 10 ** 12, "bilioes": 10 ** 12}
OPS_TOKEN = re.compile(r"\s*(?:(?P<num>(?:" + NUMTXT + r")\s*(?:%|mil\s+milh(?:ões|oes)|milh(?:ões|oes|ão|ao)|mil)?)|(?P<op>[-+*/()]))")
SENSOS = {"favor": "favor", "contra": "contra", "abstencao": "abstencao", "abstenção": "abstencao"}
PARTIDOS = ["PS", "PSD", "CH", "IL", "BE", "PCP", "PAN", "Livre", "CDS-PP", "CDS", "JPP", "PEV", "Chega", "Iniciativa Liberal", "Bloco de Esquerda"]
VOTE_VERB = re.compile(r"\bvot(?:ou|aram|ando)\b|\babst(?:eve|iveram|endo)[- ]se\b|\babsten[cç][aã]o\b|\babst[eé]m[- ]se\b", re.I)
DIR = re.compile(r"\ba\s+favor\b|\bcontra\b|\babst(?:eve|iveram|endo)[- ]se\b|\babsten[cç][aã]o\b", re.I)


ALLOW_FILE = Path(__file__).resolve().parent / "instituicoes_publicas.json"
LINKW = {"de", "do", "da", "dos", "das", "e", "sobre", "o", "a", "os", "as", "para", "em", "no", "na", "nos", "nas", "ao", "aos", "por", "com"}
VOTE_LIST = re.compile(r"(?P<dir>a\s+favor|contra|absten[cç][aã]o\s+d[aeo]s?|abstiveram-se|absteve-se)\s+(?P<lst>[A-ZÀ-Ý][\w-]*(?:\s*,\s*[A-ZÀ-Ý][\w-]*|\s+e\s+[A-ZÀ-Ý][\w-]*)*)")


def ws(s):
    return re.sub(r"[\s\u00a0]+", " ", str(s)).strip()


def expl_items(e):
    evs = list(e.get("evidencias") or [])
    out = []
    for i, x in enumerate(e.get("o_que_muda") or []):
        if isinstance(x, dict):
            out.append((str(x.get("texto", "")), str(x.get("evidencia", ""))))
        else:
            out.append((str(x), str(evs[i]) if i < len(evs) else ""))
    return out


QUOTE = re.compile(r"«([^»]{3,})»|“([^”]{3,})”|\"([^\"]{3,})\"")
NOTEXT = "o texto da iniciativa nao estava disponivel"


def fold(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def toks(s):
    return " ".join(re.findall(r"[a-z0-9]+", fold(s)))


def stem_n(w):
    if len(w) > 5 and w.endswith("oes"):
        return w[:-3] + "ao"
    if len(w) > 5 and w.endswith("ais"):
        return w[:-3] + "al"
    if len(w) > 3 and w.endswith("s"):
        return w[:-1]
    return w


def stem_g(w):
    w = stem_n(w)
    return w[:-1] if len(w) > 4 and w[-1] in "ao" else w


def skey(s, gender=False):
    f = stem_g if gender else stem_n
    return " ".join(f(w) for w in toks(s).split())


def load_allow(cfg):
    p = Path(cfg.get("lista_instituicoes") or ALLOW_FILE)
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    rx = []
    for x in raw.get("padroes", []):
        try:
            rx.append(re.compile(fold(str(x)), re.I))
        except re.error:
            continue
    names = list(raw.get("instituicoes", [])) + list(cfg.get("instituicoes_publicas", []))
    termos = {stem_n(w) for t in raw.get("termos_juridicos", []) for w in toks(t).split()}
    pref = {stem_n(w) for t in cfg.get("prefixos_instituicao", []) for w in toks(t).split()}
    return {"exact": {skey(x) for x in names}, "rx": rx, "termos": termos, "inst_words": termos | pref,
            "siglas": {fold(x) for x in raw.get("siglas", [])}, "comuns": {fold(x) for x in raw.get("palavras_comuns", [])}}


def subseq(a, b):
    it = iter(b)
    return all(c in it for c in a)


def acronym_in(acr, words):
    acr = acr.lower()
    for i, w in enumerate(words):
        if w in LINKW or w[0] != acr[0]:
            continue
        ini = ""
        for x in words[i:i + 2 * len(acr) + 4]:
            if x in LINKW:
                continue
            ini += x[0]
            if len(ini) > len(acr) + 1:
                break
            if ini[-1] == acr[-1] and subseq(acr, ini):
                return True
    return False


def is_acronym(name):
    t = name.replace("-", "").replace(" ", "")
    return t.isalpha() and t.isupper() and 2 <= len(t) <= 8


def inst_ok(name, ev, al):
    t = toks(name)
    if not t:
        return False
    words = t.split()
    inst = any(stem_n(w) in al["inst_words"] for w in words)
    if (inst or is_acronym(name)) and f" {skey(name, inst)} " in (ev["skg"] if inst else ev["sk"]):
        return True
    if skey(name) in al["exact"] or any(p.fullmatch(t) for p in al["rx"]):
        return True
    if is_acronym(name):
        a = re.sub(r"[^a-z]", "", fold(name))
        return a in al["siglas"] or acronym_in(a, ev["words"])
    core = [w for w in words if w not in LINKW]
    if core and all(stem_n(w) in al["termos"] or w in al["comuns"] for w in core):
        return True
    if len(core) >= 2:
        ini = "".join(w[0] for w in core).upper()
        if re.search(r"(?<![\w-])" + ini + r"(?![\w-])", ev["struct"] + "\n" + ev["texto"]):
            return True
    return False


def text_votes(text):
    out = set()
    for m in VOTE_LIST.finditer(text):
        d = fold(m.group("dir"))
        sense = "favor" if "favor" in d else "contra" if "contra" in d else "abstencao"
        for p in re.split(r"\s*,\s*|\s+e\s+", m.group("lst")):
            out.add((party_key(p), sense))
    return out


def norm_num(s):
    s = s.replace("%", "")
    s = re.sub(r"[\s  ]", "", s)
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        s = s.replace(".", "")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    ip, _, fp = s.partition(".")
    ip = ip.lstrip("0") or "0"
    return ip + ("." + fp if fp else "")


def dec(s):
    return Decimal(norm_num(s))


def dnorm(d):
    d = d.normalize()
    t = format(d, "f")
    return t.rstrip("0").rstrip(".") if "." in t else t


def quantities(text):
    out = []
    for m in NUM.finditer(text):
        raw = m.group(1)
        t = TAIL.match(text, m.end())
        fam, scale = "n", 1
        if t:
            if t.group("pct"):
                fam = "pct"
            elif t.group("ord"):
                fam = "ord"
            elif t.group("scale"):
                scale = SCALES[re.sub(r"\s+", " ", fold(t.group("scale")))]
            if t.group("eur") and fam == "n":
                fam = "eur"
        if fam == "n" and text[max(0, m.start() - 2):m.start()].strip().endswith("€"):
            fam = "eur"
        try:
            v = dec(raw) * scale
        except InvalidOperation:
            continue
        out.append((dnorm(v), fam))
    return out


def fam_ok(draft, ev):
    if draft == ev:
        return True
    return draft == "ord" and ev == "n"


def supported(q, evset):
    v, f = q
    return any(v == ev and fam_ok(f, ef) for ev, ef in evset)


def dates(text):
    out = set()
    for m in ISO.finditer(text):
        out.add((int(m[1]), int(m[2]), int(m[3])))
    f = fold(text)
    for m in LONG.finditer(f):
        y = int(m[3]) if m[3] else None
        if not m[3] and SAME_YEAR.match(f, m.end()):
            prev = YEAR.findall(f[max(0, m.start() - 400):m.start()].rpartition("\n")[2])
            if prev:
                y = int(prev[-1])
        out.add((y, MESES.index(m[2].lower()) + 1, int(m[1])))
    for m in SLASH.finditer(text):
        out.add((int(m[3]), int(m[2]), int(m[1])))
    return out


def strip_dates(text):
    f = fold(text)
    if len(f) == len(text):
        chars = list(text)
        for m in LONG.finditer(f):
            chars[m.start():m.end()] = " " * (m.end() - m.start())
        text = "".join(chars)
    for rx in (ISO, LONG, SLASH):
        text = rx.sub(" ", text)
    return text


def date_ok(d, fdates, ref_year):
    y, m, dd = d
    for fy, fm, fd in fdates:
        if fm != m or fd != dd:
            continue
        if y is not None:
            if fy == y or (fy is None and y == ref_year):
                return True
        elif fy is None or fy == ref_year:
            return True
    return False


class Expr:
    def __init__(self, text):
        self.t = []
        pos = 0
        text = text.strip()
        while pos < len(text):
            m = OPS_TOKEN.match(text, pos)
            if not m or m.end() == pos:
                raise ValueError("expr")
            if m.group("op"):
                self.t.append(m.group("op"))
            else:
                q = quantities(m.group("num"))
                if len(q) != 1:
                    raise ValueError("expr")
                self.t.append(("num", q[0], m.group("num")))
            pos = m.end()
        self.i = 0
        self.operands = [x for x in self.t if isinstance(x, tuple)]
        if len(self.operands) < 2 or len(self.operands) > 6:
            raise ValueError("expr")
        self.v = self.expr()
        if self.i != len(self.t):
            raise ValueError("expr")

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def expr(self):
        v = self.term()
        while self.peek() in ("+", "-"):
            op = self.t[self.i]
            self.i += 1
            r = self.term()
            v = v + r if op == "+" else v - r
        return v

    def term(self):
        v = self.atom()
        while self.peek() in ("*", "/"):
            op = self.t[self.i]
            self.i += 1
            r = self.atom()
            if op == "/" and r == 0:
                raise ValueError("div0")
            v = v * r if op == "*" else v / r
        return v

    def atom(self):
        x = self.peek()
        if x == "(":
            self.i += 1
            v = self.expr()
            if self.peek() != ")":
                raise ValueError("expr")
            self.i += 1
            return v
        if isinstance(x, tuple):
            self.i += 1
            return Fraction(x[1][0])
        raise ValueError("expr")


def stated(res):
    m = NUM.search(res)
    q = quantities(res)
    if not m or len(q) != 1:
        raise ValueError("resultado")
    raw = m.group(1)
    t = TAIL.match(res, m.end())
    scale = 1
    if t and t.group("scale"):
        scale = SCALES[re.sub(r"\s+", " ", fold(t.group("scale")))]
    norm = norm_num(raw)
    decs = len(norm.partition(".")[2])
    return q[0], Fraction(5, 10 ** (decs + 1)) * scale


def derived(calculos, evset):
    ok, problems, out = [], [], set()
    for c in calculos:
        try:
            e = Expr(str(c.get("expr", "")))
            for _, (v, f), _raw in e.operands:
                if v == "100" and f == "n":
                    continue
                if f in ("pct", "eur"):
                    if not any(v == ev and f == ef for ev, ef in evset):
                        raise ValueError("operando")
                elif not any(v == ev for ev, _ in evset):
                    raise ValueError("operando")
            (rv, rf), tol = stated(str(c.get("resultado", "")))
            r = Fraction(rv)
            cands = [e.v] + ([e.v * 100] if rf == "pct" else [])
            if not any(abs(x - r) <= tol for x in cands):
                raise ValueError("resultado")
            out.add((rv, rf))
            ok.append(c)
        except (ValueError, ZeroDivisionError, InvalidOperation):
            problems.append(f"calculo_invalido:{str(c.get('expr', ''))[:40]}")
    return out, problems


def walk(o, nums, strs, votes, key=None):
    if isinstance(o, dict):
        if "partido" in o and "sentido" in o and isinstance(o.get("partido"), str):
            votes.add((fold(o["partido"]), SENSOS.get(fold(str(o["sentido"])), fold(str(o["sentido"])))))
        for k, v in o.items():
            walk(v, nums, strs, votes, k)
    elif isinstance(o, list):
        for x in o:
            walk(x, nums, strs, votes, key)
    elif isinstance(o, str):
        strs.append(o)
        if key not in SKIP_KEYS:
            nums.append(o)
    elif isinstance(o, (int, float)) and not isinstance(o, bool):
        if key not in SKIP_KEYS:
            nums.append(str(o).replace(".", ",") if isinstance(o, float) else str(o))


def load_evidence(bdir):
    facts = (bdir / "facts.json").read_text(encoding="utf-8")
    texto = TAGS.sub(" ", (bdir / "texto.txt").read_text(encoding="utf-8")) if (bdir / "texto.txt").exists() else ""
    nums, strs, votes = [], [], set()
    try:
        obj = json.loads(facts)
    except ValueError:
        obj = None
    if obj is None:
        strs.append(facts)
        nums.append(facts)
        ref = ""
    else:
        walk(obj, nums, strs, votes)
        ref = str(obj.get("edicao_data", "")) if isinstance(obj, dict) else ""
    struct = TAGS.sub(" ", "\n".join(strs))
    allnum = TAGS.sub(" ", "\n".join(nums)) + "\n" + texto
    lei = obj.get("lei") if isinstance(obj, dict) and isinstance(obj.get("lei"), dict) else None
    both = struct + "\n" + texto
    return {"struct": struct, "texto": texto, "numtext": allnum, "votes": votes, "ref_year": int(ref[:4]) if ref[:4].isdigit() else None,
            "lei": lei, "coll": ws(both), "sk": " " + skey(both) + " ", "skg": " " + skey(both, True) + " ", "words": toks(both).split()}


def name_runs(text, commons):
    out = []
    for sent in re.split(r"(?<=[.!?:;])\s+|\n|«", text):
        toks_ = [t.group(0) for t in WORDC.finditer(sent)]
        run = []
        runs = []
        for i, w in enumerate(toks_):
            lw = w.lower()
            if w[0].isupper() and lw not in STOP:
                run.append((i, w))
            elif lw in CONNECT and run and i + 1 < len(toks_) and toks_[i + 1][0].isupper() and toks_[i + 1].lower() not in STOP:
                run.append((i, w))
            else:
                if run:
                    runs.append(run)
                run = []
        if run:
            runs.append(run)
        for r in runs:
            words = [w for _, w in r]
            core = [w for w in words if w.lower() not in CONNECT and w not in commons]
            if not core:
                continue
            out.append({"words": words, "start": r[0][0] == 0})
    return out


def evidence_phrases(text, prefixes):
    out = set()
    pre = set(prefixes)
    for sent in re.split(r"(?<=[.!?:;])\s+|\n|«", text):
        t = [m.group(0) for m in WORDC.finditer(sent)]
        for i, w in enumerate(t):
            if w not in pre:
                continue
            j = i + 1
            while j < len(t):
                if t[j][0].isupper() and t[j].lower() not in STOP:
                    j += 1
                elif t[j].lower() in LINK and j + 1 < len(t) and t[j + 1][0].isupper() and t[j + 1].lower() not in STOP:
                    j += 2
                else:
                    break
            out.add(" " + toks(" ".join(t[i:j])) + " ")
    return out


def office_near(tokens_text, key, cargo_key):
    ws_ = tokens_text.split()
    k = key.split()
    before, after = len(cargo_key.split()) + 3, len(cargo_key.split()) + 1
    for i in range(len(ws_) - len(k) + 1):
        if ws_[i:i + len(k)] == k:
            win = " " + " ".join(ws_[max(0, i - before):i + len(k) + after]) + " "
            if f" {cargo_key} " in win:
                return True
    return False


def mentions(tokens_text, key):
    return f" {key} " in " " + tokens_text + " "


def cap_mid(struct):
    out = set()
    for sent in re.split(r"(?<=[.!?:;])\s+|\n|«", struct):
        ws = [t.group(0) for t in WORD.finditer(sent)]
        for i, w in enumerate(ws):
            if i > 0 and w[0].isupper():
                out.add(fold(w))
    return out


def ent_list(art):
    out = []
    for e in art.get("entidades", []) or []:
        if isinstance(e, str):
            out.append({"nome": e, "tipo": "organizacao", "cargo_publico": ""})
        elif isinstance(e, dict):
            out.append({"nome": str(e.get("nome", "")), "tipo": str(e.get("tipo", "")), "cargo_publico": str(e.get("cargo_publico", "") or "")})
    return out


def vote_claims(blob):
    claims = []
    for sent in re.split(r"(?<=[.!?])\s+|\n", blob):
        if not VOTE_VERB.search(sent):
            continue
        ev = []
        for m in DIR.finditer(sent):
            d = fold(m.group(0))
            ev.append((m.start(), "dir", "favor" if "favor" in d else "contra" if "contra" in d else "abstencao"))
        for p in PARTIDOS:
            for m in re.finditer(r"(?<![\w-])" + re.escape(p) + r"(?![\w-])", sent):
                ev.append((m.start(), "par", p))
        ev.sort()
        for i, (pos, kind, val) in enumerate(ev):
            if kind != "par":
                continue
            after = next((v for _, k, v in ev[i + 1:] if k == "dir"), None)
            before = next((v for _, k, v in reversed(ev[:i]) if k == "dir"), None)
            d = after or before
            if d:
                claims.append((val, d, sent.strip()[:80]))
    return claims


PARTY_ALIAS = {"chega": "ch", "iniciativa liberal": "il", "bloco de esquerda": "be", "cds": "cds-pp"}


def party_key(p):
    f = fold(p)
    return PARTY_ALIAS.get(f, f)


def verify(art, bdir, cfg):
    try:
        return _verify(art, Path(bdir), cfg)
    except Exception as e:
        return {"ok": False, "problemas": [f"erro_verificador:{type(e).__name__}"]}


def _verify(art, bdir, cfg):
    problems = []
    ev = load_evidence(bdir)
    allowed = set(json.loads((bdir / "fontes.json").read_text(encoding="utf-8")).get("hrefs_permitidos", []))
    textos = [art.get("titulo", ""), art.get("lead", ""), art.get("corpo", "")] + list(art.get("pontos_chave", []))
    expl = art.get("explicacao") if isinstance(art.get("explicacao"), dict) else None
    items = expl_items(expl) if expl else []
    if expl:
        textos += [str(expl.get("do_que_trata", ""))] + [t for t, _ in items]
    bp = Path(bdir) / "blocos.json"
    blocos = json.loads(bp.read_text(encoding="utf-8")) if bp.exists() else None
    blob = "\n".join(str(t) for t in textos)
    if len(art.get("corpo", "").split()) > cfg["max_words"]:
        problems.append("corpo_excede_palavras")
    lei = ev["lei"]
    if expl and len(str(expl.get("do_que_trata", "")).split()) > 120:
        problems.append("explicacao_excede_palavras")
    if lei and not expl:
        problems.append("explicacao_em_falta")
    if expl and not lei:
        problems.append("explicacao_sem_lei")
    if lei and expl:
        if lei.get("texto_disponivel"):
            if not 3 <= len(items) <= 6:
                problems.append("o_que_muda_itens")
        elif NOTEXT not in fold(" ".join([str(expl.get("do_que_trata", "")), str(art.get("corpo", "")), str(art.get("lead", ""))])).replace("  ", " "):
            problems.append("falta_aviso_sem_texto")
        for t, e in items:
            if len(ws(e)) < 15 or ws(e) not in ev["coll"]:
                problems.append(f"evidencia_nao_literal:{t[:40]}")
            if "segundo" not in fold(t):
                problems.append(f"o_que_muda_sem_atribuicao:{t[:40]}")
    if blocos is not None and "blocos" in art and art.get("blocos") != blocos:
        problems.append("blocos_alterados")
    if blocos and blocos.get("intervencoes"):
        fp = Path(bdir) / "facts.json"
        try:
            sp = {s.get("id"): str(s.get("detalhe") or "") for s in (json.loads(fp.read_text(encoding="utf-8")).get("lei") or {}).get("intervencoes", [])}
        except (OSError, ValueError):
            sp = {}
        for x in blocos["intervencoes"]:
            if not x.get("excerto") or x["excerto"] not in sp.get(x.get("id"), ""):
                problems.append(f"excerto_nao_literal:{x.get('id')}")
    if URL.search(blob):
        problems.append("url_no_texto")
    if FIRST.search(blob):
        problems.append("primeira_pessoa")
    allstrings = blob + "\n" + "\n".join(str(x) for x in art.get("numeros_citados", [])) + "\n" + json.dumps(art.get("fontes", []), ensure_ascii=False) + json.dumps(art.get("entidades", []), ensure_ascii=False) + json.dumps(art.get("calculos", []), ensure_ascii=False) + json.dumps(expl or {}, ensure_ascii=False)
    if INJ.search(allstrings) or TAGS.search(allstrings):
        problems.append("injecao_no_rascunho")
    fdates = dates(ev["numtext"])
    for d in dates(blob):
        if not date_ok(d, fdates, ev["ref_year"]):
            problems.append(f"data_sem_suporte:{d}")
    evq = set(quantities(strip_dates(ev["numtext"])))
    dset, dprob = derived(art.get("calculos", []) or [], evq)
    problems += dprob
    for q in quantities(strip_dates(blob)):
        if not supported(q, evq | dset):
            problems.append(f"numero_sem_suporte:{q[0]}:{q[1]}")
    for s in art.get("numeros_citados", []):
        ds = dates(str(s))
        if ds and not quantities(strip_dates(str(s))):
            for d in sorted(ds, key=str):
                if not date_ok(d, fdates, ev["ref_year"]):
                    problems.append(f"data_sem_suporte:{d}")
            continue
        qs = quantities(strip_dates(str(s)))
        if len(qs) != 1:
            problems.append(f"numero_citado_invalido:{str(s)[:30]}")
            continue
        if qs[0][1] == "n" and qs[0][0].isdigit() and any(fd == int(qs[0][0]) for _, _, fd in fdates):
            continue
        if not supported(qs[0], evq | dset):
            problems.append(f"numero_citado_sem_suporte:{qs[0][0]}:{qs[0][1]}")
    for m in QUOTE.finditer(blob):
        span = ws(next(g for g in m.groups() if g))
        if span not in ev["coll"]:
            problems.append(f"citacao_nao_literal:{span[:40]}")
    blob0 = blob
    commons = set(cfg.get("nomes_comuns", []))
    al = load_allow(cfg)
    publicas = {toks(x) for x in cfg.get("instituicoes_publicas", [])}
    for c in sorted(cfg.get("instituicoes_publicas", []), key=len, reverse=True):
        blob = re.sub(r"(?<!\w)" + re.escape(c) + r"(?!\w)", " ", blob, flags=re.I)
    for c in sorted((c for c in commons if " " in c), key=len, reverse=True):
        blob = re.sub(re.escape(c), " ", blob, flags=re.I)
    ents = ent_list(art)
    declared = {toks(e["nome"]): e for e in ents if e["nome"].strip()}
    st, tx = " " + toks(ev["struct"]) + " ", " " + toks(ev["texto"]) + " "
    cargos = [fold(c) for c in cfg.get("cargos_publicos", [])]
    for key, e in declared.items():
        if f" {key} " not in st and f" {key} " not in tx and (e["tipo"] == "pessoa" or (key not in publicas and not inst_ok(e["nome"], ev, al))):
            problems.append(f"entidade_sem_suporte:{e['nome']}")
        if e["tipo"] == "pessoa":
            cargo = fold(e["cargo_publico"])
            if not cargo or not any(c in cargo for c in cargos):
                problems.append(f"pessoa_sem_cargo_publico:{e['nome']}")
            elif f" {key} " not in st and f" {key} " in tx:
                ck = toks(e["cargo_publico"])
                if not office_near(tx.strip(), key, ck):
                    problems.append(f"pessoa_sem_cargo_no_texto_legal:{e['nome']}")
                if mentions(toks(blob0), key) and not office_near(toks(blob0), key, ck):
                    problems.append(f"pessoa_sem_cargo_no_artigo:{e['nome']}")
    midcaps = cap_mid(ev["struct"])
    phrases = evidence_phrases(ev["struct"] + "\n" + ev["texto"], cfg.get("prefixos_instituicao", []))
    dkeys = [" " + k + " " for k in declared]
    for r in name_runs(blob, commons):
        words = list(r["words"])
        lead = 0
        while len(words) > 1 and words[0] in commons and len([w for w in words if w not in commons and w.lower() not in CONNECT]) >= 2:
            words.pop(0)
            lead += 1
        while len(words) > 1 and words[0].lower() in CONNECT:
            words.pop(0)
        core = [w for w in words if w.lower() not in CONNECT and w not in commons]
        key = toks(" ".join(words))
        pk = f" {key} "
        if any(pk in d for d in dkeys) or any(pk in p for p in phrases):
            continue
        if inst_ok(" ".join(words), ev, al):
            continue
        if len(core) == 1 and len(words) == 1:
            w = core[0]
            if key in declared:
                continue
            if w.isupper() and 2 <= len(w) <= 8:
                if re.search(r"(?<![\w])" + re.escape(w) + r"(?![\w])", ev["struct"] + ev["texto"]):
                    continue
                problems.append(f"nome_sem_suporte:{w}")
                continue
            if r["start"] and fold(w) not in midcaps:
                continue
            problems.append(f"nome_isolado_nao_declarado:{w}")
            continue
        if key in declared:
            continue
        if f" {key} " in st:
            continue
        if f" {key} " in tx:
            problems.append(f"nome_so_no_texto_nao_declarado:{' '.join(words)}")
            continue
        if r["start"] and len(words) > 2:
            alt = toks(" ".join(words[1:]))
            if f" {alt} " in st or alt in declared:
                continue
        problems.append(f"nome_sem_suporte:{' '.join(words)}")
    claims = vote_claims(blob)
    if claims:
        table = {(party_key(p), s) for p, s in ev["votes"]}
        if blocos and blocos.get("votacao"):
            table = {(party_key(r["partido"]), r["voto"]) for r in blocos["votacao"].get("por_partido", [])}
        if not table:
            table = text_votes(ev["struct"] + "\n" + ev["texto"])
        for p, d, s in claims:
            if not table:
                problems.append(f"voto_sem_tabela:{p}")
            elif (party_key(p), d) not in table:
                problems.append(f"voto_incoerente:{p}:{d}")
    for f in art.get("fontes", []):
        if f.get("href") not in allowed:
            problems.append(f"href_nao_permitido:{f.get('href')}")
    problems = list(dict.fromkeys(problems))
    return {"ok": not problems, "problemas": problems[:30]}
