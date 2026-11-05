"""Parliament agenda -> events + initiatives. Source: agenda.parlamento.pt (public calendar JSON)."""
import re
import sys
from datetime import date, timedelta
from http.cookiejar import CookieJar
import urllib.request

from common import UA, db, plain, set_meta

BASE = "https://agenda.parlamento.pt/"
DAYS_BACK, DAYS_AHEAD, CHUNK = 60, 150, 30

KINDS = {
    "projeto de lei": "Projeto de Lei", "projetos de lei": "Projeto de Lei",
    "proposta de lei": "Proposta de Lei", "propostas de lei": "Proposta de Lei",
    "projeto de resolução": "Projeto de Resolução", "projetos de resolução": "Projeto de Resolução",
    "proposta de resolução": "Proposta de Resolução", "projeto de deliberação": "Projeto de Deliberação",
    "projeto de lei constitucional": "Projeto de Lei Constitucional",
}
# e.g. "Proposta de Lei n.º 110/XVII/2.ª (GOV) – Orçamento do Estado para 2027"
INIT_RE = re.compile(
    r"(Projetos? de Lei Constitucional|Projetos? de Lei|Propostas? de Lei|Projetos? de Resolução|"
    r"Propostas? de Resolução|Projetos? de Deliberação)\s*n\.?\s*[ºo°]s?\s*(\d+)\s*/\s*(X{0,3}V?I{0,3}|XV?I*)\s*(?:/\s*(\d)\s*\.?\s*[ªa])?"
    r"\s*(?:\(([^)]{1,40})\))?(?:\s*[-–—:]\s*([^\n]{3,200}))?", re.I)


def opener():
    jar = CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", UA)]
    op.open(BASE, timeout=60).read()  # prime cookies
    return op


def fetch_range(op, start, end):
    import json, urllib.parse
    q = urllib.parse.urlencode({
        "handler": "Calendar", "Start": f"{start}T00:00:00+00:00", "End": f"{end}T00:00:00+00:00",
        "SectionId": "", "Text": ""})
    req = urllib.request.Request(BASE + "Index?" + q, headers={"X-Requested-With": "XMLHttpRequest"})
    return json.loads(op.open(req, timeout=90).read().decode("utf-8"))


RELATOR_RE = re.compile(r"^Relator[a]?\s*:\s*(?:Deputad[oa]\s+)?([^\n(;:]{3,60}\s\([^)\n]{1,14}\))", re.I)


def phase_for(section, heading, line):
    h = f"{heading} {line}".lower()
    if section.startswith("Plen"):
        return "Debate em Plenário"
    if "apreciação e votação" in h or "votação dos relatórios" in h or "votação na especialidade" in h:
        return "Relatório/votação em comissão"
    if "distribuição" in h or "nomeação de relator" in h or "relator" in h:
        return "Distribuição e nomeação de relator"
    if "audiência" in h or "audição" in h:
        return "Audição em comissão"
    if "especialidade" in h:
        return "Apreciação na especialidade"
    return "Mencionada na agenda"


def extract_initiatives(con, event_id, start, section, title, text):
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if title not in lines:
        lines.insert(0, title)
    heading = ""
    for i, line in enumerate(lines):
        ms = list(INIT_RE.finditer(line))
        if not ms:
            if re.match(r"^\d+\s*[.\-)]", line):
                heading = line
            continue
        for m in ms:
            kind = KINDS.get(re.sub(r"\s+", " ", m.group(1).lower()), m.group(1))
            number, leg, sess = int(m.group(2)), m.group(3).upper(), m.group(4)
            origin, desc = (m.group(5) or "").strip(), (m.group(6) or "").strip()
            if not leg:
                continue
            if not desc and len(ms) == 1 and i + 1 < len(lines):
                nxt = lines[i + 1]
                if not INIT_RE.search(nxt) and not re.match(r"^(Relator|[a-z]\)|\d+\s*[.\-)])", nxt, re.I) and len(nxt) > 15:
                    desc = nxt[:300]
            key = f"{kind}|{number}|{leg}"
            cur = con.execute("SELECT title FROM initiatives WHERE key=?", (key,)).fetchone()
            if cur is None:
                con.execute("INSERT INTO initiatives VALUES (?,?,?,?,?,?,?,?)", (
                    key, kind, number, leg, int(sess) if sess else None, origin, desc or None, "agenda.parlamento.pt"))
            elif desc and not cur[0]:
                con.execute("UPDATE initiatives SET title=? WHERE key=?", (desc, key))
            relator = None
            for look in lines[i + 1:i + 4]:
                r = RELATOR_RE.match(look)
                if r:
                    relator = r.group(1).strip(" .")
                    break
            con.execute("INSERT OR IGNORE INTO initiative_steps VALUES (?,?,?,?,?,?,?,?)", (
                key, event_id, start, phase_for(section, heading, line), title if section.startswith("Plen") is False else "Plenário",
                (heading or None), relator, "agenda.parlamento.pt"))


def main():
    op = opener()
    today = date.today()
    d = today - timedelta(days=DAYS_BACK)
    final = today + timedelta(days=DAYS_AHEAD)
    events = {}
    while d < final:
        e = min(d + timedelta(days=CHUNK), final)
        for ev in fetch_range(op, d, e):
            events[ev["id"]] = ev
        d = e
    con = db()
    con.execute("DELETE FROM events"); con.execute("DELETE FROM initiative_steps WHERE source='agenda.parlamento.pt'")
    for ev in events.values():
        x = ev.get("extendedProps") or {}
        text = plain(x.get("text"))
        title = plain(ev["title"])
        con.execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?,?,?)", (
            ev["id"], title, ev["start"], ev.get("end"), x.get("sectionName"), x.get("themeName"),
            x.get("subtitle"), x.get("local"), text, "agenda.parlamento.pt"))
        extract_initiatives(con, ev["id"], ev["start"], x.get("sectionName") or "", title, text)
    n_init = con.execute("SELECT COUNT(*) FROM initiatives").fetchone()[0]
    from datetime import datetime
    set_meta(con, "agenda_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print(f"agenda: {len(events)} events, {n_init} new initiatives")


if __name__ == "__main__":
    sys.exit(main())
