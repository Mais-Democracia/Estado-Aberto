import json
import re
import unicodedata
from pathlib import Path

MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
NUM = re.compile(r"(?<![\w/-])\d{1,3}(?:[  .]\d{3})+(?:,\d+)?%?|(?<![\w/-])\d+(?:[.,]\d+)?%?")
ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
LONG = re.compile(r"\b(\d{1,2})\s+de\s+(" + "|".join(MESES) + r")(?:\s+de\s+(\d{4}))?\b", re.I)
SLASH = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
URL = re.compile(r"https?://|www\.|\b[\w-]+\.(?:pt|com|org|eu|gov|net)\b", re.I)
FIRST = re.compile(r"\b(eu|nós|nos sentimos|meu|minha|meus|minhas|nosso|nossa|nossos|nossas|penso|acho|creio|acredito|acreditamos|parece-me|na minha opinião)\b", re.I)
WORD = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*")
CONNECT = {"de", "da", "do", "das", "dos", "e"}
TAGS = re.compile(r"</?\s*fonte_nao_confiavel\s*>")


def fold(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def norm_num(s):
    s = s.replace("%", "").replace(" ", "").replace(" ", "").replace(" ", "")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        s = s.replace(".", "")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    ip, _, fp = s.partition(".")
    ip = ip.lstrip("0") or "0"
    return ip + ("." + fp if fp else "")


def numbers(text):
    return {norm_num(m.group(0)) for m in NUM.finditer(text)}


def dates(text):
    out = set()
    for m in ISO.finditer(text):
        out.add((int(m[1]), int(m[2]), int(m[3])))
    for m in LONG.finditer(fold(text)):
        out.add((int(m[3]) if m[3] else None, MESES.index(m[2].lower()) + 1, int(m[1])))
    for m in SLASH.finditer(text):
        out.add((int(m[3]), int(m[2]), int(m[1])))
    return out


def strip_dates(text):
    for rx in (ISO, LONG, SLASH):
        text = rx.sub(" ", text)
    return text


def date_ok(d, facts_dates):
    y, m, dd = d
    return any(fm == m and fd == dd and (y is None or fy is None or fy == y) for fy, fm, fd in facts_dates)


STOP = {"o", "a", "os", "as", "um", "uma", "uns", "umas", "em", "no", "na", "nos", "nas", "segundo", "para", "com", "por", "sobre", "ao", "aos", "à", "às", "pelo", "pela", "este", "esta", "estes", "estas", "esse", "essa", "foi", "são", "é", "se", "mas", "como", "quando", "apos", "após", "entre", "durante", "ate", "até"}


def names(text, commons):
    out = set()
    for sent in re.split(r"(?<=[.!?:;])\s+|\n", text):
        toks = [t.group(0) for t in WORD.finditer(sent)]
        runs, run = [], []
        for i, w in enumerate(toks):
            lw = w.lower()
            if w[0].isupper() and not (i == 0 and lw in STOP) and lw not in STOP:
                run.append(w)
            elif lw in CONNECT and run:
                run.append(w)
            else:
                runs.append((run, runs == [] and toks[:len(run)] == run))
                run = []
        runs.append((run, False))
        for r, _ in runs:
            while r and r[-1].lower() in CONNECT:
                r = r[:-1]
            core = [p for p in r if p.lower() not in CONNECT and p not in commons]
            if not core:
                continue
            if len(r) == 1 and sent.lstrip().startswith(r[0]):
                continue
            out.add(" ".join(core))
    return out


def load_facts(bdir):
    facts = (bdir / "facts.json").read_text(encoding="utf-8")
    texto = (bdir / "texto.txt").read_text(encoding="utf-8") if (bdir / "texto.txt").exists() else ""
    src = TAGS.sub(" ", facts + "\n" + texto)
    try:
        flat = json.dumps(json.loads(facts), ensure_ascii=False)
    except ValueError:
        flat = facts
    src += "\n" + TAGS.sub(" ", flat)
    return src


def verify(art, bdir, cfg):
    bdir = Path(bdir)
    problems = []
    src = load_facts(bdir)
    fsrc = fold(src)
    fwords = set(re.findall(r"[a-z0-9']+", fsrc))
    fnums = numbers(src)
    fdates = dates(src)
    allowed = set(json.loads((bdir / "fontes.json").read_text(encoding="utf-8")).get("hrefs_permitidos", []))
    textos = [art.get("titulo", ""), art.get("lead", ""), art.get("corpo", "")] + list(art.get("pontos_chave", []))
    blob = "\n".join(textos)
    if len(art.get("corpo", "").split()) > cfg["max_words"]:
        problems.append("corpo_excede_palavras")
    if URL.search(blob):
        problems.append("url_no_texto")
    if FIRST.search(blob):
        problems.append("primeira_pessoa")
    for d in dates(blob):
        if not date_ok(d, fdates):
            problems.append(f"data_sem_suporte:{d}")
    rest = strip_dates(blob)
    ords = re.findall(r"(\d+)\s*\.?\s*[ºª°]", rest)
    for n in numbers(rest):
        if n in fnums or n in {norm_num(o) for o in ords}:
            continue
        problems.append(f"numero_sem_suporte:{n}")
    for s in art.get("numeros_citados", []):
        for n in numbers(strip_dates(str(s))):
            if n not in fnums:
                problems.append(f"numero_citado_sem_suporte:{n}")
    commons = set(cfg.get("nomes_comuns", []))
    for nm in sorted(names(blob, commons) | {e for e in art.get("entidades", []) if isinstance(e, str)}):
        ws = re.findall(r"[a-z0-9']+", fold(nm))
        if any(w not in fwords and w not in {x.lower() for x in commons} and w not in {fold(x) for x in commons} for w in ws if w not in CONNECT):
            problems.append(f"nome_sem_suporte:{nm}")
    for f in art.get("fontes", []):
        if f.get("href") not in allowed:
            problems.append(f"href_nao_permitido:{f.get('href')}")
    return {"ok": not problems, "problemas": problems[:30]}
