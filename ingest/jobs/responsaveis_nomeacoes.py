import gzip
import json
import re
import sqlite3
import subprocess
import tempfile
import time
import unicodedata
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 (politica-pt civic project)"
MESES = {m: i + 1 for i, m in enumerate("janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())}
NAME = r"[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][\w'’.-]+(?: (?:d[aeo]s?|e|do|das|dos|de|van|von)?\s?[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][\w'’.-]+){1,9}"


def norm(s):
    s = unicodedata.normalize("NFD", s or "").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", "".join(c for c in s if unicodedata.category(c) != "Mn"))).strip()


def entity_index(con, root):
    idx = {}
    for name, nif in con.execute("SELECT entity, entity_nif FROM mandates WHERE entity_nif IS NOT NULL GROUP BY entity, entity_nif"):
        idx.setdefault(norm(name), set()).add(nif)
    pol = sqlite3.connect(f"file:{root / 'politica.db'}?mode=ro", uri=True)
    for name, nif in pol.execute("SELECT name, nif FROM entities WHERE nif IS NOT NULL"):
        idx.setdefault(norm(name), set()).add(nif)
    return idx


def link(idx, entity):
    k = norm(entity)
    v = idx.get(k)
    return (next(iter(v)), "nome exato") if v and len(v) == 1 else (None, None)


def phase_dre(con, root, log):
    dre = sqlite3.connect(f"file:{root / 'dre.db'}?mode=ro", uri=True)
    idx = entity_index(con, root)
    con.execute("DELETE FROM nomeacoes WHERE source='dre'")
    n = 0
    rows = dre.execute("""SELECT id, kind, number, year, date, summary, text, url FROM acts WHERE
      (kind='Resolução do Conselho de Ministros' AND (summary LIKE 'Designa%' OR summary LIKE 'Nomeia%' OR summary LIKE 'Exonera%'))
      OR (kind='Decreto do Presidente da República' AND (summary LIKE 'Nomeia%' OR summary LIKE 'Exonera%'))""").fetchall()

    def add(src_row, action, person, role, entity):
        nonlocal n
        if (role or "").startswith("a área"):
            return
        nif, how = link(idx, entity) if entity else (None, None)
        _id, kind, number, year, date, summ, text, url = src_row
        con.execute("INSERT OR IGNORE INTO nomeacoes (source, action, person, role, entity, entity_nif, date, act, act_id, source_url, match_method) VALUES ('dre',?,?,?,?,?,?,?,?,?,?)",
                    (action, person.strip(), (role or "").strip() or None, entity, nif, date, f"{kind} n.º {number}", _id, url, how))
        n += 1

    for r in rows:
        _id, kind, number, year, date, summ, text, url = r
        text = text or ""
        if kind.startswith("Decreto do Presidente"):
            m = re.match(r"(Nomeia|Exonera) (?:o|a) (?:ministro plenipotenciário de \d\.ª classe|embaixador|embaixadora|conselheiro de embaixada|Contra-Almirante|Vice-Almirante|General|Tenente-General|Major-General|Comodoro|Brigadeiro-General) (" + NAME + r") (?:para o cargo de|como|do cargo de) ([^,]+?)\.?$", summ)
            if m:
                add(r, "nomeação" if m.group(1) == "Nomeia" else "exoneração", m.group(2), m.group(3), None)
            continue
        em = re.search(r"(?:conselho (?:de administração|diretivo|de curadores|de gestão)|comissão diretiva|direção|conselho executivo|órgão de gestão)[^.]*? d[aeo]s? ([A-ZÁÉÍÓÚ][^.]*?(?:I\. ?P\.|E\. ?P\. ?E\.|S\. ?A\.|, ?[A-Z]\.?[A-Z]\.?)?)\.?$", summ)
        entity = em.group(1).strip().rstrip(".") if em else None
        action = "exoneração" if summ.startswith("Exonera") and "designa" not in summ.lower() else "designação" if summ.startswith("Designa") or "designa" in summ.lower() else "nomeação"
        found = 0
        for m in re.finditer(r"^[a-z]\) (" + NAME + r"), (?:para o cargo de|como|para) ([^;.,]+)", text, flags=re.M):
            add(r, action, m.group(1), m.group(2), entity); found += 1
        if not found:
            m = re.search(r"(?:Designar|Nomear)[^:]{0,300}?[:,] (?:o|a) [^,]{0,40}? ?(" + NAME + r"), (?:para o cargo de|como|para) ([^;.,]+)", text)
            if m:
                add(r, action, m.group(1), m.group(2), entity)
    con.commit()
    log("dre nomeacoes:", n, "of", len(rows), "acts")


def d10(txt):
    m = re.search(r"Lisboa, (\d{1,2}) de (\w+) de (\d{4})", txt)
    return f"{m.group(3)}-{MESES.get(m.group(2).lower(), 1):02d}-{int(m.group(1)):02d}" if m else None


def phase_cresap_results(con, root, log, sleep=1.0):
    cache = root / "raw" / "responsaveis" / "cresap_pdf"
    cache.mkdir(parents=True, exist_ok=True)
    con.execute("DELETE FROM cresap_results")
    n = 0
    for code, entity, nif, role, url in con.execute("SELECT code, entity, entity_nif, role, proposal_url FROM cresap WHERE status='concluído' AND proposal_url LIKE 'https://www.cresap.pt/%'").fetchall():
        f = cache / (re.sub(r"\W", "_", url.rsplit("/", 1)[-1]) + ".txt")
        if not f.exists():
            try:
                with tempfile.NamedTemporaryFile(suffix=".pdf") as t:
                    t.write(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40).read()); t.flush()
                    f.write_text(subprocess.run(["pdftotext", "-layout", t.name, "-"], capture_output=True, text=True).stdout)
            except Exception as e:
                log("cresap pdf failed", url, e); continue
            time.sleep(sleep)
        txt = f.read_text()
        date = d10(txt)
        if "PROPOSTA DE DESIGNAÇÃO" in txt.upper()[:400] or "apresentar ao membro do Governo competente a proposta" in txt:
            body = re.split(r"\n\s*2\.\s", txt, 1)[0]
            for m in re.finditer(r"•\s+(.+?);?\s*$", body, flags=re.M):
                con.execute("INSERT OR IGNORE INTO cresap_results VALUES (?,?,?,?,?,?,?,?)", (code, role, entity, nif, "proposta de designação (3 candidatos, ordem alfabética)", m.group(1).strip().rstrip(".;"), date, url)); n += 1
        elif "não encontrou" in txt or "deserto" in txt:
            con.execute("INSERT OR IGNORE INTO cresap_results VALUES (?,?,?,?,?,?,?,?)", (code, role, entity, nif, "sem proposta: recrutamento por escolha", "", date, url)); n += 1
    con.commit()
    log("cresap results:", n)
