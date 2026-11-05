"""President, Prime Minister (Wikidata), ministers (pt.wikipedia XXV Governo), parties+seats (pt.wikipedia XVII Legislatura)."""
import json
import re
from datetime import datetime

from common import db, get, get_json, set_meta

WD = "https://query.wikidata.org/sparql"


def wikitext(page):
    d = get_json("https://pt.wikipedia.org/w/api.php", {
        "action": "parse", "page": page, "prop": "wikitext", "format": "json"})
    return d["parse"]["wikitext"]["*"]


def office_holder(prop):
    q = ("SELECT ?hLabel ?start ?partyLabel WHERE { wd:Q45 p:%s ?s. ?s ps:%s ?h. OPTIONAL{?s pq:P580 ?start} "
         "OPTIONAL{?h wdt:P102 ?party} FILTER NOT EXISTS{?s pq:P582 ?e} "
         'SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en". } }' % (prop, prop))
    b = get_json(WD, {"query": q}, {"Accept": "application/json"})["results"]["bindings"][0]
    return (b["hLabel"]["value"], b.get("start", {}).get("value", "")[:10], b.get("partyLabel", {}).get("value"))


def link_text(s):
    """[[A|B]] -> B ; [[A]] -> A"""
    m = re.search(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", s)
    return m.group(1).strip() if m else None


def ministers():
    w = wikitext("XXV Governo Constitucional de Portugal")
    sec = w[w.index("=== Ministérios ==="):]
    sec = sec[: sec.index("\n|}")]
    out = []
    role = None
    for row in sec.split("\n|-")[1:]:
        cells = [c for c in re.split(r"\n\|(?!\|)", row) if c.strip()]
        found = re.findall(r"<center>(.*?)</center>", row, re.S)
        if found and "Ficheiro" in cells[0]:
            role = link_text(found[-1])
        if len(cells) < 4 or "presente" not in row or not role:
            continue
        name = link_text(next((c for c in cells if "<br>" in c and "Ficheiro" not in c.split("<br>")[0]), ""))
        party = link_text(cells[-2])
        party = {"PPD/PSD": "PSD"}.get(party, party)
        since = re.search(r"(\d{1,2} de \w+ de \d{4})\s*[–-]\s*presente", row)
        if name:
            out.append((name, role, party, since.group(1) if since else None))
    return out


def parties():
    w = wikitext("XVII Legislatura da Terceira República Portuguesa")
    comp = w[w.index("|Comp="): w.index("|sessionnumber1")]
    bloc = None
    out = []
    for line in comp.splitlines():
        if "Governo" in line:
            bloc = "Governo"
        elif "Oposição" in line:
            bloc = "Oposição"
        m = re.search(r"\[\[[^\]|]*\|([^\]]+)\]\]\s*\((\d+)\)", line)
        if m and "color box" in line:
            out.append((m.group(1).replace("PPD/PSD", "PSD"), int(m.group(2)), bloc))
    return out


# Static presentation data (not time-sensitive): full names, colours, ideology
PARTY_INFO = {
    "PSD": ("Partido Social Democrata", "#f68a21", "Centro-direita", "https://www.psd.pt"),
    "CDS–PP": ("CDS – Partido Popular", "#0a6ebd", "Centro-direita / democracia-cristã", "https://www.cds.pt"),
    "CH": ("Chega", "#1f2a6e", "Direita radical / populista", "https://partidochega.pt"),
    "PS": ("Partido Socialista", "#e2478a", "Centro-esquerda / social-democracia", "https://ps.pt"),
    "IL": ("Iniciativa Liberal", "#00a4e4", "Liberalismo", "https://iniciativaliberal.pt"),
    "L": ("Livre", "#8bc34a", "Esquerda verde / ecossocialismo", "https://partidolivre.pt"),
    "PCP": ("Partido Comunista Português", "#c8102e", "Marxismo-leninismo", "https://www.pcp.pt"),
    "B.E.": ("Bloco de Esquerda", "#870909", "Esquerda democrática / socialismo", "https://www.bloco.org"),
    "PAN": ("Pessoas–Animais–Natureza", "#1b8a6b", "Ecologismo / direitos dos animais", "https://pan.com.pt"),
    "JPP": ("Juntos pelo Povo", "#2e7d32", "Regionalismo (Madeira)", "https://www.jpp.pt"),
}


def main():
    con = db()
    pr = office_holder("P35")
    pm = office_holder("P6")
    con.execute("DELETE FROM people WHERE body IN ('Presidência da República','Governo')")
    con.execute("INSERT INTO people (name,role,body,party,since,source) VALUES (?,?,?,?,?,?)",
                (pr[0], "Presidente da República", "Presidência da República", None, pr[1], "Wikidata"))
    con.execute("INSERT INTO people (name,role,body,party,since,source) VALUES (?,?,?,?,?,?)",
                (pm[0], "Primeiro-Ministro", "Governo", pm[2], pm[1], "Wikidata"))
    ms = ministers()
    for name, role, party, since in ms:
        con.execute("INSERT INTO people (name,role,body,party,since,source) VALUES (?,?,?,?,?,?)",
                    (name, role, "Governo", party, since, "pt.wikipedia.org (XXV Governo Constitucional)"))
    con.execute("DELETE FROM parties")
    ps = parties()
    for code, seats, bloc in ps:
        full, color, ideo, site = PARTY_INFO.get(code, (code, "#888888", None, None))
        con.execute("INSERT INTO parties VALUES (?,?,?,?,?,?,?)", (code, full, seats, bloc, color, ideo, site))
    set_meta(con, "government_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print("president:", pr, "| PM:", pm, "| ministers:", len(ms), "| parties:", [(p[0], p[1]) for p in ps])


if __name__ == "__main__":
    main()
