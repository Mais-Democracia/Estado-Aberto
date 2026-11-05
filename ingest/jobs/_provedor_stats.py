import re

NUM = r"(\d{1,3}(?:[ . ]\d{3})+|\d{3,6})"
OPEN_PATS = [
    (re.compile(r"número total de (?:processos|procedimentos) abertos (?:no ano de|em) (\d{4}) foi de " + NUM, re.I), 1, 2),
    (re.compile(r"Foram abertos " + NUM + r" (?:processos|procedimentos)(?=[,.])", re.I), None, 1),
    (re.compile(r"Total de (?:processos|procedimentos) abertos\s+" + NUM, re.I), None, 1),
    (re.compile(r"(?:Procedimentos|Processos) abertos em (\d{4})\s+" + NUM, re.I), 1, 2),
    (re.compile(NUM + r" [«\"]procedimentos abertos[»\"] em (\d{4})", re.I), 2, 1),
    (re.compile(r"abertos " + NUM + r" processos de queixas novas", re.I), None, 1),
    (re.compile(r"Dos " + NUM + r" (?:processos|procedimentos) abertos(?: em (\d{4}))?", re.I), 2, 1),
    (re.compile(r"Em (\d{4}) foram abertos " + NUM + r" (?:processos|procedimentos)", re.I), 1, 2),
    (re.compile(r"foram abertos " + NUM + r" (?:processos|procedimentos)(?=[,.])", re.I), None, 1),
]
WRITTEN = re.compile(r"queixas apresentadas por escrito foram " + NUM + r", (?:as )?verbais (?:foram )?" + NUM, re.I)
LABEL_ROW = re.compile(r"^\s{0,40}([A-ZÀ-Ý][^\d%]{3,90}?)\s{2,}(\d{1,3}(?:[ .]\d{3})*|\d+)\s*$")
BLOCK_HEAD = re.compile(r"(Assuntos das queixas|Entidades visadas nas queixas|Queixas por assunto|Entidades visadas)", re.I)
TOPENT = re.compile(r"entidades mais visadas (?:foram|forem)(.{20,900}?)\.\s+[A-ZÁ-Ú]", re.S)
ENTREC = re.compile(r"([A-ZÁ-Úa-zá-ú][^()\d]{3,90}?) \((\d{1,4})\)")


def toint(s):
    return int(re.sub(r"\D", "", s))


def squash(t):
    t = t.replace("\f", "\n\f")
    t = re.sub(r"-\n\s*", "", t)
    return re.sub(r"\s+", " ", t)


def page_of(text, pos_text, needle):
    i = text.find(needle[:40])
    return text[:i].count("\f") + 1 if i >= 0 else None


def extract(year, text, url):
    rows = []
    flat = squash(text)
    for pat, yg, vg in OPEN_PATS:
        found = None
        for m in pat.finditer(flat):
            if yg and m.group(yg) and int(m.group(yg)) != year:
                continue
            if not yg and any(int(y) != year for y in re.findall(r"\b(?:em|de|ano de) ((?:19|20)\d\d)\b", flat[max(0, m.start() - 45):m.end()], re.I)):
                continue
            if re.match(r",\s*(?:menos|mais)\s+\d+ do que", flat[m.end():m.end() + 30]):
                continue
            v = toint(m.group(vg))
            if 1500 <= v <= 30000 and v % 1000:
                found = (m, v)
                break
        if found:
            m, v = found
            q = flat[max(0, m.start() - 25):m.end() + 30].strip()
            rows.append((year, "opened", "total", "Processos/procedimentos abertos", v, "processos", q, page_of(text, 0, m.group(0)), url))
            break
    m = WRITTEN.search(flat)
    if m:
        rows.append((year, "written", "total", "Queixas apresentadas por escrito", toint(m.group(1)), "queixas", m.group(0), page_of(text, 0, m.group(0)), url))
        rows.append((year, "verbal", "total", "Queixas verbais", toint(m.group(2)), "queixas", m.group(0), page_of(text, 0, m.group(0)), url))
    seen = set()
    tm = TOPENT.search(flat)
    if tm:
        pg = page_of(text, 0, tm.group(0))
        for em in ENTREC.finditer(tm.group(1)):
            lab = re.sub(r"^(?:e|a|o|as|os|s|,)\s+", "", em.group(1).strip(" ,;"))
            lab = re.sub(r"^(?:e |, e |ainda |em relação à |em relação ao )", "", lab).strip()
            if len(lab) >= 4 and ("entity", lab) not in seen:
                seen.add(("entity", lab))
                rows.append((year, "entity", "text", lab, int(em.group(2)), "queixas", em.group(0).strip(), pg, url))
    return rows
