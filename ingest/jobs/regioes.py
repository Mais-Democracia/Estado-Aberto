"""Regiões autónomas (Açores e Madeira): governos regionais, assembleias legislativas, eleições,
orçamento e contratação pública.  -> data/regioes.db

Fontes (ver docs/SOURCES.md):
  * Wikipedia pt (API parse/wikitext): composição e direções regionais do XIV Governo dos Açores,
    XVI Governo da Madeira, resultados das eleições regionais.
  * madeira.gov.pt (oficial): secretarias, titulares e organismos; Orçamento da Região (PDF, pdftotext).
  * base.alra.pt / alra.pt (ALRAA, HTTP/TLS sem cadeia completa): deputados, iniciativas, comissões.
  * alram.pt (ALRAM): deputados/grupos (JSON embebido) e iniciativas (POST JSON da pesquisa).
  * data/dre.db: Decretos Legislativos Regionais; data/politica.db: contratos (BASE) e entidades.
Tudo o que não foi possível obter fica registado em `blocked`.
"""
import hashlib
import html
import json
import re
import sqlite3
import ssl
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT  # noqa: E402

DB = ROOT / "data" / "regioes.db"
RAW = ROOT / "data" / "raw" / "regioes"
RAW.mkdir(parents=True, exist_ok=True)
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
_last = {}
NOW = time.strftime("%Y-%m-%d")

REGIONS = {
    "acores": "Região Autónoma dos Açores",
    "madeira": "Região Autónoma da Madeira",
}


# ----------------------------------------------------------------------------- http
def fetch(url, post=None, binary=False, insecure=False, delay=1.1, force=False, name=None):
    key = hashlib.sha1((url + repr(post)).encode()).hexdigest()[:16]
    p = RAW / (name or f"c_{key}")
    if p.exists() and not force:
        return p.read_bytes() if binary else p.read_text(encoding="utf8", errors="replace")
    host = urllib.parse.urlparse(url).netloc
    w = delay - (time.time() - _last.get(host, 0))
    if w > 0:
        time.sleep(w)
    data = None
    if post is not None:
        boundary = "----pt" + key
        body = b""
        for k, v in post.items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        body += f"--{boundary}--\r\n".encode()
        data = body
    req = urllib.request.Request(url, data=data, headers={"User-Agent": BROWSER_UA})
    if post is not None:
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    ctx = alra_ctx(host) if insecure else None
    try:
        with urllib.request.urlopen(req, timeout=90, context=ctx) as r:
            raw = r.read()
    finally:
        _last[host] = time.time()
    p.write_bytes(raw)
    return raw if binary else raw.decode("utf8", errors="replace")


def alra_ctx(host):
    """alra.pt serve a cadeia incompleta: obtém-se o certificado intermédio do campo AIA «CA Issuers»
    do certificado do servidor e verifica-se a cadeia normalmente (sem desativar a verificação)."""
    bundle = RAW / "alra_bundle.pem"
    if not bundle.exists():
        leaf = ssl.get_server_certificate((host.split(":")[0], 443))
        out = subprocess.run(["openssl", "x509", "-noout", "-ext", "authorityInfoAccess"], input=leaf, capture_output=True, text=True).stdout
        m = re.search(r"CA Issuers - URI:(\S+)", out)
        if not m:
            raise RuntimeError("AIA CA Issuers não encontrado")
        der = fetch(m.group(1), binary=True, name="alra_ca.der")
        pem = subprocess.run(["openssl", "x509", "-inform", "der"], input=der, capture_output=True).stdout.decode()
        sysca = ssl.get_default_verify_paths().cafile or "/etc/ssl/certs/ca-certificates.crt"
        bundle.write_text(pem + Path(sysca).read_text())
    return ssl.create_default_context(cafile=str(bundle))


def try_fetch(*a, **k):
    try:
        return fetch(*a, **k)
    except Exception as e:  # noqa: BLE001
        print("  FAIL", a[0][:90], type(e).__name__, str(e)[:80])
        return None


def wiki(title):
    u = "https://pt.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&redirects=1&page=" + urllib.parse.quote(title)
    t = try_fetch(u, name="wp_" + hashlib.sha1(title.encode()).hexdigest()[:10] + ".json")
    if not t:
        return None
    try:
        return json.loads(t)["parse"]["wikitext"]["*"]
    except Exception:  # noqa: BLE001
        return None


def wurl(title):
    return "https://pt.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


# ----------------------------------------------------------------------------- text utils
def norm(s):
    s = str(s or "").replace("–", " ").replace("—", " ")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def clean_wiki(s):
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<small>.*?</small>", lambda m: " (" + re.sub(r"<[^>]+>", "", m.group(0)).strip(" ()") + ")", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def wikitable_rows(text):
    """Devolve lista de (header_text|None, [células]) por tabela; cabeçalhos de secção (colspan) como linhas especiais."""
    out = []
    for tbl in re.findall(r"\{\|.*?\n\|\}", text, flags=re.S):
        rows = re.split(r"\n\|-[^\n]*", tbl)
        for row in rows:
            cells = []
            for line in row.split("\n"):
                line = line.strip()
                if line.startswith("!"):
                    cells.append(("H", line[1:]))
                elif line.startswith("|") and not line.startswith("|}") and not line.startswith("{|"):
                    c = line[1:].strip()
                    if re.match(r'^(?:width="[^"]*"\s*)?(?:rowspan="\d+"\s*)?(?:width="[^"]*"\s*)?bgcolor=', c):
                        continue
                    # remove atributos "attr=x | texto"
                    m = re.match(r"^((?:[a-z]+=\"?[^|\"]*\"?\s*)+)\|(?!\|)(.*)$", c)
                    if m and "[[" not in m.group(1):
                        c = m.group(2)
                    cells.append(("D", c))
            if cells:
                out.append(cells)
    return out


def party_abbrev(s):
    s = clean_wiki(s)
    m = {"PPD/PSD": "PSD", "PPD/PSD.CDS-PP.PPM": "PSD/CDS/PPM"}
    return m.get(s, s)


# ----------------------------------------------------------------------------- db
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS blocked(region TEXT, topic TEXT, source TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS regions(id TEXT PRIMARY KEY, name TEXT, short TEXT, gov_label TEXT, gov_since TEXT, gov_url TEXT, assembly_name TEXT, assembly_url TEXT, legislature TEXT);
CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, ord INTEGER, role TEXT, secretaria_key TEXT, name TEXT, party TEXT, since TEXT, until TEXT, current INTEGER, source TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS crosscheck(region TEXT, portfolio TEXT, name_a TEXT, source_a TEXT, name_b TEXT, source_b TEXT, status TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS secretarias(region TEXT, key TEXT, ord INTEGER, name TEXT, holder TEXT, url TEXT, PRIMARY KEY(region,key));
CREATE TABLE IF NOT EXISTS bodies(id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, secretaria_key TEXT, name TEXT, kind TEXT, holder TEXT, holder_role TEXT, since TEXT, source TEXT, source_url TEXT, current INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS budget(region TEXT, year INTEGER, scope TEXT, code TEXT, name TEXT, amount REAL, secretaria_key TEXT, source_url TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS budget_acts(region TEXT, year INTEGER, number TEXT, date TEXT, title TEXT, url TEXT, kind TEXT);
CREATE TABLE IF NOT EXISTS deputies(id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, legislature TEXT, name TEXT, full_name TEXT, party TEXT, circle TEXT, role TEXT, status TEXT, email TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS groups(region TEXT, legislature TEXT, abbr TEXT, name TEXT, seats INTEGER, color TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS committees(region TEXT, abbr TEXT, name TEXT, url TEXT, n_pending INTEGER, source_url TEXT);
CREATE TABLE IF NOT EXISTS agenda(region TEXT, committee TEXT, when_txt TEXT, title TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS initiatives(region TEXT, id TEXT, legislature TEXT, kind TEXT, number TEXT, title TEXT, author TEXT, date TEXT, state TEXT, phase TEXT, result TEXT, plenary TEXT, url TEXT, session TEXT);
CREATE INDEX IF NOT EXISTS ini_r ON initiatives(region, kind, date);
CREATE TABLE IF NOT EXISTS ini_stats(region TEXT, legislature TEXT, kind TEXT, n INTEGER);
CREATE TABLE IF NOT EXISTS acts(region TEXT, id TEXT, kind TEXT, number TEXT, date TEXT, title TEXT, summary TEXT, url TEXT);
CREATE INDEX IF NOT EXISTS acts_r ON acts(region, date);
CREATE TABLE IF NOT EXISTS elections(region TEXT, year INTEGER, party TEXT, abbr TEXT, votes INTEGER, pct REAL, pct_voters REAL, seats INTEGER, total_seats INTEGER, source_url TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS elections_wp(region TEXT, year INTEGER, party TEXT, abbr TEXT, votes INTEGER, pct REAL, seats INTEGER, total_seats INTEGER, source_url TEXT);
CREATE TABLE IF NOT EXISTS elections_meta(region TEXT, year INTEGER, date TEXT, turnout REAL, source_url TEXT, registered INTEGER, voters INTEGER, blank INTEGER, null_votes INTEGER);
CREATE TABLE IF NOT EXISTS election_check(region TEXT, year INTEGER, party TEXT, votes_wp INTEGER, votes_mai INTEGER, pct_wp REAL, pct_valid_mai REAL, pct_voters_mai REAL, dpp REAL, dvotes INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS c_year(region TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL);
CREATE TABLE IF NOT EXISTS c_group(region TEXT, grp TEXT, n_buyers INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL);
CREATE TABLE IF NOT EXISTS c_buyer(region TEXT, nif TEXT, name TEXT, grp TEXT, secretaria_key TEXT, share REAL, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL, first_year INTEGER, last_year INTEGER);
CREATE INDEX IF NOT EXISTS cb_r ON c_buyer(region, value);
CREATE TABLE IF NOT EXISTS c_secretaria(region TEXT, secretaria_key TEXT, n_buyers INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL);
CREATE TABLE IF NOT EXISTS c_supplier(region TEXT, nif TEXT, name TEXT, n INTEGER, value REAL, direct_value REAL);
CREATE TABLE IF NOT EXISTS c_proc(region TEXT, procedure TEXT, n INTEGER, value REAL);
"""


def reset(db):
    for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
        if not t.startswith("sqlite_"):
            db.execute(f"DROP TABLE {t}")
    db.executescript(SCHEMA)


# ----------------------------------------------------------------------------- governos
def kind_of(name):
    n = norm(name)
    if re.search(r"\b(direcao regional|diretor regional|diretora regional)\b", n):
        return "direcao_regional"
    if re.search(r"\binspe", n):
        return "inspecao"
    if re.search(r"\b(s a|sa|e p e|epe|eperam|e p r a m|epram|sociedade|empresa|sdm|apram|eem|sesaram)\b", n) or "s a" in n.split("  "):
        return "empresa"
    if re.search(r"\b(instituto|i p|ip|ip ram|ipra|fundo|fundacao|agencia|servico|laboratorio|centro|conservatorio|escola|observatorio|gabinete|polo|autoridade|conselho)\b", n):
        return "instituto"
    return "outro"


def sec_key(name):
    n = norm(name)
    n = re.sub(r"^(secretari[ao] regional|vice presidencia|presidencia)\s*(do governo regional)?\s*(d[aeo]s?)?\s*", lambda m: ("vice " if "vice" in m.group(0) else "pres " if m.group(0).startswith("presid") else ""), n)
    return n.strip()


def parse_az_government(db):
    title = "XIV Governo Regional dos Açores"
    wt = wiki(title)
    if not wt:
        db.execute("INSERT INTO blocked VALUES('acores','governo','pt.wikipedia.org','API inacessível')")
        return
    url = wurl(title)
    db.execute("INSERT OR REPLACE INTO regions(id,name,short,gov_label,gov_since,gov_url,assembly_name,assembly_url,legislature) VALUES('acores',?,?,?,?,?,?,?,?)",
               (REGIONS["acores"], "Açores", "XIV Governo Regional dos Açores (PSD/CDS-PP/PPM)", "2024-03-04", url,
                "Assembleia Legislativa da Região Autónoma dos Açores (ALRAA)", "https://www.alra.pt/", "XIII"))
    comp = wt.split("==Composição", 1)[1].split("== Direções Regionais", 1)[0] if "==Composição" in wt else ""
    dirs = wt.split("== Direções Regionais", 1)[1].split("== Outras entidades", 1)[0] if "== Direções Regionais" in wt else ""
    outs = wt.split("== Outras entidades", 1)[1] if "== Outras entidades" in wt else ""
    # --- membros
    order = 0
    for cells in wikitable_rows(comp):
        d = [clean_wiki(c) for k, c in cells if k == "D" and not re.search(r"bgcolor", c)]
        d = [x for x in d]
        # [cargo, detentor, partido, periodo]
        d = [x for i, x in enumerate(d)]
        if len(d) < 4:
            continue
        role, name, party, per = d[0], d[1], d[2], d[3]
        # coluna da cor vazia já removida; se partido vazio por cor, tenta juntar
        since = (re.findall(r"\d{1,2} de \w+ de \d{4}", per) or [""])[0]
        order += 1
        sk = sec_key(role) if "Secret" in role else ("vice" if "Vice" in role else "pres")
        db.execute("INSERT INTO members(region,ord,role,secretaria_key,name,party,since,current,source,source_url) VALUES('acores',?,?,?,?,?,?,1,'Wikipedia (Decreto do Representante da República 1 e 2/2024)',?)",
                   (order, role, sk, name, party_abbrev(party), since, url))
    # secretarias (a partir dos cabeçalhos da tabela de direções)
    secs = {}
    ordn = 0
    sec_names = [("pres", "Presidência do Governo Regional"), ("vice", "Vice-Presidência do Governo Regional")]
    for line in re.findall(r"colspan=\"3\" \|(.*)", dirs):
        nm = clean_wiki(line)
        if nm:
            sec_names.append((None, nm))
    seen = set()
    for k, nm in sec_names:
        if nm in seen:
            continue
        seen.add(nm)
        key = k or sec_key(nm)
        if nm.startswith("Presidência") and k is None:
            continue
        ordn += 1
        secs[nm] = key
    # associar titular a cada secretaria
    members = db.execute("SELECT role,name,secretaria_key FROM members WHERE region='acores'").fetchall()
    for nm, key in list(secs.items()):
        holder = None
        for role, mname, mk in members:
            if mk == key or (key in ("pres", "vice") and mk == key):
                holder = mname
        if key not in ("pres", "vice"):
            for role, mname, mk in members:
                if norm(role.replace("Secretário Regional", "").replace("Secretária Regional", "")) .replace(" e ", " ").split()[:2] == norm(nm.replace("Secretaria Regional", "")).replace(" e ", " ").split()[:2] and "Secret" in role:
                    holder = mname
        db.execute("INSERT OR REPLACE INTO secretarias VALUES('acores',?,?,?,?,?)", (key, len(secs), nm, holder, url))
    # --- direções regionais + outras entidades
    def bodies_from(section, source_label):
        cur = None
        last_role = None
        rows = wikitable_rows(section)
        for cells in rows:
            hs = [clean_wiki(c) for k, c in cells if k == "H"]
            ds = [clean_wiki(c) for k, c in cells if k == "D"]
            if hs and any("Presidência" in h or "Secretaria" in h for h in hs) and not ds:
                nm = hs[-1].strip(" |")
                nm = re.sub(r"^.*\|", "", nm).strip()
                cur = nm
                continue
            if not cur or not ds:
                continue
            if len(ds) >= 3:
                role, holder, per = ds[0], ds[1], ds[2]
                last_role = role
            elif len(ds) == 2:
                role, holder, per = last_role, ds[0], ds[1]
            else:
                continue
            if not role:
                continue
            cur_flag = 1 if "presente" in per else 0
            since = (re.findall(r"\d{1,2} de \w+ de \d{4}", per) or [""])[0]
            hrole = re.search(r"\(([^)]*)\)", holder)
            holder_clean = re.sub(r"\s*\(.*?\)", "", holder).strip()
            body = role
            body = re.sub(r"^Diretor(?:a)? Regional ", "Direção Regional ", body)
            body = re.sub(r"^Inspetor(?:a)? Regional ", "Inspeção Regional ", body)
            body = re.sub(r"^Diretor(?:a)? do ", "", body)
            body = re.sub(r"^Presidente d[oa] ", "", body)
            sk = None
            for nm, key in secs.items():
                if nm == cur or norm(nm) == norm(cur):
                    sk = key
            if sk is None:
                sk = "pres" if "Presidência" in cur and "Vice" not in cur else ("vice" if "Vice" in cur else sec_key(cur))
            db.execute("INSERT INTO bodies(region,secretaria_key,name,kind,holder,holder_role,since,source,source_url,current) VALUES('acores',?,?,?,?,?,?,?,?,?)",
                       (sk, body, kind_of(body), holder_clean, (hrole.group(1) if hrole else role), since, source_label, url, cur_flag))
    bodies_from(dirs, "Wikipedia: XIV Governo Regional dos Açores (direções regionais)")
    bodies_from(outs, "Wikipedia: XIV Governo Regional dos Açores (outras entidades)")
    db.execute("INSERT INTO blocked VALUES('acores','governo (fonte oficial)','portal.azores.gov.pt','Atrás de verificação anti-bot (Cloudflare, HTTP 403): não foi possível ler a página oficial do Governo dos Açores; os titulares vêm só da Wikipedia (com remissão para os Decretos do Representante da República n.º 1 e 2/2024).')")


def parse_mad_government(db):
    # --- fonte oficial: secretarias e titulares
    url_sec = "https://www.madeira.gov.pt/Governo-Regional-Madeira/Governo/OGoverno/Secretarias"
    t = try_fetch(url_sec, name="mad_sec.html") or ""
    off = []
    body = t
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S)
    txt = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    lines = [re.sub(r"\s+", " ", l).strip() for l in txt.split("\n") if l.strip()]
    for i in [k for k, l in enumerate(lines) if l == "Secretarias"]:
        seg = lines[i + 1:]
        j = seg.index("Contactos") if "Contactos" in seg else len(seg)
        seg = seg[:j]
        if 6 <= len(seg) <= 40 and len(seg) % 2 == 0 and "Entrar" not in seg and "Menu" not in seg:
            for a in range(0, len(seg) - 1, 2):
                off.append((seg[a], seg[a + 1]))  # (titular, pasta)
            break
    pages = {"Turismo, Ambiente e Cultura": "srtac", "Educação, Ciência e Tecnologia": "sre", "Economia": "srec",
             "Saúde e Proteção Civil": "srs", "Finanças": "srfinancas", "Agricultura e Pescas": "srap",
             "Inclusão, Trabalho e Juventude": "sritj", "Equipamentos e Infraestruturas": "srei"}
    wt = wiki("XVI Governo Regional da Madeira")
    url_w = wurl("XVI Governo Regional da Madeira")
    db.execute("INSERT OR REPLACE INTO regions(id,name,short,gov_label,gov_since,gov_url,assembly_name,assembly_url,legislature) VALUES('madeira',?,?,?,?,?,?,?,?)",
               (REGIONS["madeira"], "Madeira", "XVI Governo Regional da Madeira (PSD/CDS-PP)", "2025-04-15", "https://www.madeira.gov.pt/",
                "Assembleia Legislativa da Região Autónoma da Madeira (ALRAM)", "https://www.alram.pt/", "XV"))
    # secretarias oficiais
    db.execute("INSERT OR REPLACE INTO secretarias VALUES('madeira','pres',0,'Presidência do Governo Regional',NULL,'https://www.madeira.gov.pt/presidencia')")
    order = 0
    for holder, pasta in off:
        order += 1
        key = norm(pasta)
        slug = pages.get(pasta)
        db.execute("INSERT OR REPLACE INTO secretarias VALUES('madeira',?,?,?,?,?)",
                   (key, order, "Secretaria Regional de " + pasta if not pasta.startswith("Economia") else "Secretaria Regional de Economia",
                    re.sub(r"\s+", " ", holder), f"https://www.madeira.gov.pt/{slug}" if slug else url_sec))
        db.execute("INSERT INTO members(region,ord,role,secretaria_key,name,party,since,current,source,source_url) VALUES('madeira',?,?,?,?,?,?,1,'madeira.gov.pt (oficial)',?)",
                   (order + 1, "Secretário(a) Regional — " + pasta, key, re.sub(r"\s+", " ", holder), None, None, url_sec))
    # presidente (oficial: página da Presidência cita o Presidente?) -> só Wikipedia; confirmação por texto da página
    pres_page = try_fetch("https://www.madeira.gov.pt/presidencia", name="mad_s_presidencia.html") or ""
    # --- Wikipedia: composição com partidos e datas
    wiki_members = []
    if wt:
        comp = wt.split("== Composição", 1)[1].split("{{Referências", 1)[0]
        last = last_party = None
        for cells in wikitable_rows(comp):
            ds = [c for k, c in cells if k == "D" and "Ficheiro" not in c and "bgcolor" not in c]
            ds = [clean_wiki(c) for c in ds]
            ds = [x for x in ds if x != ""] if len(ds) > 4 else ds
            if len(ds) >= 3 and re.search(r"Presidente|Secret", ds[0]):
                role, name = ds[0], ds[1]
                party = ds[2] if len(ds) >= 4 else ""
                per = ds[-1]
                last, last_party = role, party
            elif len(ds) == 2 and last and re.search(r"\d{4}", ds[1]):
                role, name, party, per = last, ds[0], last_party, ds[1]
            else:
                continue
            if "Carvalho" in name and False:
                pass
            wiki_members.append((role, name, party, per))
        # resolve: último titular por cargo
        for role, name, party, per in wiki_members:
            cur = 1 if "presente" in per else 0
            since = (re.findall(r"\d{1,2} de \w+ de \d{4}", per) or [""])[0]
            until = ""
            m = re.findall(r"\d{1,2} de \w+ de \d{4}", per)
            if len(m) > 1:
                until = m[-1]
            if "Presidente do Governo" in role:
                db.execute("INSERT INTO members(region,ord,role,secretaria_key,name,party,since,until,current,source,source_url) VALUES('madeira',1,?,?,?,?,?,?,?,'Wikipedia (XVI Governo; DRR 3/2025)',?)",
                           ("Presidente do Governo Regional", "pres", name, party_abbrev(party) or None, since, until or None, cur, url_w))
                db.execute("UPDATE secretarias SET holder=? WHERE region='madeira' AND key='pres'", (name,))
            elif not cur:
                db.execute("INSERT INTO members(region,ord,role,secretaria_key,name,party,since,until,current,source,source_url) VALUES('madeira',99,?,?,?,?,?,?,0,'Wikipedia (XVI Governo)',?)",
                           (role, None, name, party_abbrev(party) or None, since, until or None, url_w))
        # partidos/datas dos titulares atuais: juntar à linha oficial pelo nome
        for role, name, party, per in wiki_members:
            if "presente" in per:
                nn = norm(name)
                since = (re.findall(r"\d{1,2} de \w+ de \d{4}", per) or [""])[0]
                db.execute("UPDATE members SET party=COALESCE(NULLIF(?,''),party), since=? WHERE region='madeira' AND current=1 AND source LIKE 'madeira.gov.pt%' AND replace(lower(name),'  ',' ')=?",
                           (party_abbrev(party), since, " ".join(name.lower().split())))
        # cross-check
        offs = {norm(n): (n, p) for n, p in off}
        wk = {norm(n): (n, r) for r, n, p, per in wiki_members if "presente" in per}
        pr = [n for r, n, p, per in wiki_members if "Presidente" in r and "presente" in per]
        if pr:
            ok = norm(pr[0]).split()[-1] in norm(pres_page)
            db.execute("INSERT INTO crosscheck VALUES('madeira','Presidente do Governo Regional',?,?,?,?,?,?)",
                       (pr[0], "Wikipedia", pr[0] if ok else None, "madeira.gov.pt/presidencia", "ok" if ok else "unconfirmed",
                        None if ok else "Apelido não encontrado na página oficial da Presidência"))
        for nn, (n, p) in offs.items():
            if nn in wk:
                rw = wk[nn][1]
                db.execute("INSERT INTO crosscheck VALUES('madeira',?,?,?,?,?,?,?)",
                           (p, n, "madeira.gov.pt", wk[nn][0], "Wikipedia", "ok", f"Wikipedia: «{rw}»"))
            else:
                cand = [w for w in wk.values() if set(norm(p).split()) & set(norm(w[1]).split()) - {"de", "e", "regional", "secretario", "secretaria"}]
                db.execute("INSERT INTO crosscheck VALUES('madeira',?,?,?,?,?,?,?)",
                           (p, n, "madeira.gov.pt", cand[0][0] if cand else None, "Wikipedia", "diverge",
                            "A Wikipedia indica outro titular para a pasta" if cand else "Titular não consta da Wikipedia"))
        for nn, (n, r) in wk.items():
            if nn not in offs and "Presidente" not in r:
                db.execute("INSERT INTO crosscheck VALUES('madeira',?,?,?,?,?,?,?)", (r, None, "madeira.gov.pt", n, "Wikipedia", "diverge", "Consta da Wikipedia mas não do site oficial"))
    else:
        db.execute("INSERT INTO blocked VALUES('madeira','governo (Wikipedia)','pt.wikipedia.org','Inacessível; só fonte oficial.')")
    # --- organismos oficiais por secretaria (página da secretaria) + mapa V do ORAM
    for pasta, slug in pages.items():
        key = norm(pasta)
        u = f"https://www.madeira.gov.pt/{slug}"
        h = try_fetch(u, name=f"mad_s_{slug}.html") or ""
        h = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", h, flags=re.S)
        tx = html.unescape(re.sub(r"<[^>]+>", "\n", h))
        ls = [re.sub(r"\s+", " ", l).strip() for l in tx.split("\n") if l.strip()]
        if "Organismos" in ls:
            i = ls.index("Organismos")
            stop = {"RH e Recrutamento", "Instrumentos de Gestão", "Proteção e Transparência", "Documentos Oficiais", "Orgânica", "Notas de imprensa", "Mobilidade Áerea", "Estudante Insular", "Setor Empresarial da RAM"}
            for l in ls[i + 1:i + 25]:
                if l in stop or len(l) > 140:
                    break
                db.execute("INSERT INTO bodies(region,secretaria_key,name,kind,holder,holder_role,since,source,source_url) VALUES('madeira',?,?,?,NULL,NULL,NULL,?,?)",
                           (key, l, kind_of(l), "madeira.gov.pt (lista «Organismos» da secretaria)", u))


# ----------------------------------------------------------------------------- orçamento madeira
def pdf_text(url, name):
    p = RAW / name
    if not p.exists():
        raw = try_fetch(url, binary=True, name=name)
        if not raw:
            return None
    txt = RAW / (name + ".txt")
    if not txt.exists():
        subprocess.run(["pdftotext", "-layout", str(p), str(txt)], check=False)
    return txt.read_text(errors="replace") if txt.exists() else None


def num(s):
    return int(re.sub(r"\D", "", s))


def parse_mad_budget(db):
    srcs = {2026: "https://www.madeira.gov.pt//Portals/11/Documentos/OrcamentoRAM/PROPOSTA%20DE%20ORAM%202026.pdf",
            2025: "https://www.madeira.gov.pt//Portals/11/Documentos/OrcamentoRAM/PROPOSTA_ORAM%202025.pdf"}
    keymap = {}
    for k, name in db.execute("SELECT key,name FROM secretarias WHERE region='madeira'"):
        keymap[k] = name
    for year, u in srcs.items():
        txt = pdf_text(u, f"oram{year}_proposta.pdf")
        if not txt:
            db.execute("INSERT INTO blocked VALUES('madeira',?,?,?)", (f"orçamento {year}", u, "PDF inacessível"))
            continue
        lines = txt.split("\n")
        # Mapa II: despesas por departamento
        try:
            a = next(i for i, l in enumerate(lines) if "DESPESAS POR DEPARTAMENTOS REGIONAIS E CAPÍTULOS" in l)
        except StopIteration:
            a = None
        if a is not None:
            seg = lines[a:a + 90]
            cur = None
            total = None
            for l in seg:
                m = re.match(r"^\s*(\d{2})\s*[—–-]\s*(.+?)\s*$", l)
                if m and not re.search(r"\d{3}", l):
                    cur = (m.group(1), re.sub(r"\s+", " ", m.group(2)))
                    continue
                nums = re.findall(r"\d{1,3}(?: \d{3})+|\d{4,}", l)
                if cur and nums and re.search(r"Investimentos do Plano|Gabinete|serviços|Assembleia|Presid", l):
                    last = num(nums[-1]) if len(nums) >= 2 else None
                    # a última coluna (por departamento) só existe na linha de fecho do departamento
                    if len(nums) >= 2:
                        sk = None
                        nm = cur[1].title().replace(" De ", " de ").replace(" Do ", " do ").replace(" Da ", " da ").replace(" E ", " e ").replace(" Das ", " das ")
                        for k, n in keymap.items():
                            if k != "pres" and norm(n.replace("Secretaria Regional de", "").replace("Secretaria Regional das", "").replace("Secretaria Regional da", "")) == norm(cur[1].replace("SECRETARIA REGIONAL DE", "").replace("SECRETARIA REGIONAL DAS", "").replace("SECRETARIA REGIONAL DA", "")):
                                sk = k
                        if cur[0] == "42":
                            sk = "pres"
                        db.execute("INSERT INTO budget VALUES('madeira',?,?,?,?,?,?,?,?)",
                                   (year, "despesa_departamento", cur[0], nm, last, sk, u, "Mapa II – despesas por departamentos regionais (OCR do PDF)"))
                m2 = re.match(r"^\s*TOTAL\s+(\d{1,3}(?: \d{3})+)", l)
                if m2:
                    total = num(m2.group(1))
                    db.execute("INSERT INTO budget VALUES('madeira',?,'despesa_total','', 'Despesa total da Região (Mapa II)',?,NULL,?,?)", (year, total, u, "Mapa II"))
                    break
        # Mapa I: receita total
        for i, l in enumerate(lines):
            if "Total das receitas correntes e de capital" in l:
                m = re.search(r"(\d{1,3}(?: \d{3})+)\s*$", l)
                if m:
                    db.execute("INSERT INTO budget VALUES('madeira',?,'receita_corrente_capital','','Total das receitas correntes e de capital (Mapa I)',?,NULL,?,?)", (year, num(m.group(1)), u, "Mapa I (sem saldo transitado, passivos)"))
                break
        # Mapa V: SFA por departamento
        try:
            b = next(i for i, l in enumerate(lines) if "RECEITA GLOBAL DOS SERVIÇOS, INSTITUTOS E FUNDOS AUTÓNOMOS" in l)
        except StopIteration:
            b = None
        if b is not None:
            cur = None
            for l in lines[b:b + 70]:
                m = re.match(r"^\s*(\d{2})\s*[—–-]\s*(.+?)\s*$", l)
                if m and not re.search(r"\d{3}", l):
                    cur = (m.group(1), re.sub(r"\s+", " ", m.group(2)))
                    continue
                if re.match(r"^\s*TOTAL\s", l):
                    mt = re.search(r"(\d{1,3}(?: \d{3})+)", l)
                    if mt:
                        db.execute("INSERT INTO budget VALUES('madeira',?,'sfa_total','','Receita global dos serviços e fundos autónomos (Mapa V)',?,NULL,?,?)", (year, num(mt.group(1)), u, "Mapa V"))
                    break
                m3 = re.match(r"^(\S.*?\S)\s{2,}(\d{1,3}(?: \d{3})*)\s*$", l.strip("\n"))
                if cur and m3:
                    nm = m3.group(1).strip()
                    sk = None
                    for k, n in keymap.items():
                        pass
                    db.execute("INSERT INTO budget VALUES('madeira',?,'sfa',?,?,?,?,?,?)", (year, cur[0], nm, num(m3.group(2)), cur[1], u, "Mapa V – receita global do serviço/instituto/fundo autónomo"))
    # associar SFA/empresas do Mapa V aos organismos da secretaria (por número do departamento -> nome)
    dep2key = {}
    for code, name, sk in db.execute("SELECT code,name,secretaria_key FROM budget WHERE scope='despesa_departamento' AND year=2026"):
        if sk:
            dep2key[code] = sk
    for code, name, amt in db.execute("SELECT code,name,amount FROM budget WHERE scope='sfa' AND year=2026").fetchall():
        sk = dep2key.get(code)
        if sk is None:
            continue
        db.execute("UPDATE budget SET secretaria_key=? WHERE scope='sfa' AND code=? AND year=2026", (sk, code))
        if not db.execute("SELECT 1 FROM bodies WHERE region='madeira' AND secretaria_key=? AND lower(name) LIKE ?", (sk, name[:25].lower() + "%")).fetchone():
            db.execute("INSERT INTO bodies(region,secretaria_key,name,kind,source,source_url) VALUES('madeira',?,?,?,?,?)",
                       (sk, name, kind_of(name), "ORAM 2026, Mapa V (serviços, institutos e fundos autónomos)", "https://www.madeira.gov.pt//Portals/11/Documentos/OrcamentoRAM/PROPOSTA%20DE%20ORAM%202026.pdf"))
    for code, name, amt in db.execute("SELECT code,name,amount FROM budget WHERE scope='sfa' AND year=2025").fetchall():
        sk = db.execute("SELECT secretaria_key FROM budget WHERE scope='despesa_departamento' AND year=2025 AND code=?", (code,)).fetchone()
        if sk and sk[0]:
            db.execute("UPDATE budget SET secretaria_key=? WHERE scope='sfa' AND code=? AND year=2025", (sk[0], code))
    db.execute("INSERT INTO blocked VALUES('acores','orçamento','portal.azores.gov.pt (DROT/SRFPAP)','Sem totais do Orçamento dos Açores: o portal do Governo está atrás de verificação anti-bot (HTTP 403) e os mapas orçamentais não constam do texto do DLR no Diário da República. Só se listam os decretos que aprovam o orçamento.')")
    db.execute("INSERT INTO blocked VALUES('madeira','execução orçamental e dívida','madeira.gov.pt','Orçamento aprovado lido dos mapas da proposta (PDF digitalizado por OCR); execução orçamental e stock de dívida pública não extraídos.')")
    db.execute("INSERT INTO blocked VALUES('acores','execução orçamental e dívida','portal.azores.gov.pt','Execução e dívida não obtidas (portal bloqueado a robôs).')")


# ----------------------------------------------------------------------------- DRE
def load_dre(db):
    p = ROOT / "data" / "dre.db"
    if not p.exists():
        db.execute("INSERT INTO blocked VALUES(NULL,'legislação regional','data/dre.db','módulo dre não corrido')")
        return
    d = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    n = 0
    for id_, kind, number, date, title, summary, url in d.execute(
            "SELECT id,kind,number,date,title,summary,url FROM acts WHERE kind IN ('Decreto Legislativo Regional') ORDER BY date"):
        reg = "acores" if str(number).endswith("/A") else "madeira" if str(number).endswith("/M") else None
        if not reg:
            continue
        db.execute("INSERT INTO acts VALUES(?,?,?,?,?,?,?,?)", (reg, id_, kind, number, date, title, summary, url))
        n += 1
        if re.search(r"Aprova o Orçamento da Região|^Orçamento da Região Aut", summary or "") and not re.search(r"altera|rectific|retific", (summary or "").lower()):
            m = re.search(r"(?:ano de |para |ano )(\d{4})\s*\.?\s*$", summary or "")
            yr = int(m.group(1)) if m else None
            if yr:
                db.execute("INSERT INTO budget_acts VALUES(?,?,?,?,?,?,?)", (reg, yr, number, date, title, url, "orçamento"))
    print("  DLR:", n)


# ----------------------------------------------------------------------------- ALRAA
def alraa(db):
    base = "http://base.alra.pt:82"
    h = try_fetch(base + "/4DACTION/w_deputados", name="alra_dep.html")
    src = base + "/4DACTION/w_deputados"
    if h:
        # a página vem em latin-1
        raw = (RAW / "alra_dep.html").read_bytes().decode("latin-1")
        n = 0
        cut = raw.find("Deputados que exerceram")
        segs = [(raw[:cut] if cut >= 0 else raw, False)] + ([(raw[cut:], True)] if cut >= 0 else [])
        n = 0
        for seg, former in segs:
          for part in re.split(r"<tr valign=\"top\">", seg):
            m = re.search(r"w_dep_historico/(\d+)\"><font[^>]*>([^<]+)</font>.*?<font[^>]*>\s*([^<\s][^<]*?)\s*</font>.*?<font[^>]*>\s*([^<]+?)\s*</font>", part, re.S)
            if m:
                db.execute("INSERT INTO deputies(region,legislature,name,party,circle,status,source_url) VALUES('acores','XIII',?,?,?,?,?)",
                           (html.unescape(m.group(2)).strip(), m.group(3).strip(), m.group(4).strip(), "exerceu funções na legislatura (substituído)" if former else "em funções", f"{base}/4DACTION/w_dep_historico/{m.group(1)}"))
                n += 1
        print("  ALRAA deputados:", n)
        db.execute("INSERT INTO blocked VALUES('acores','deputados','base.alra.pt:82','Transporte: a base de dados da ALRAA (base.alra.pt, deputados e iniciativas) só é servida por HTTP sem cifra (sem TLS), logo não é possível verificar a autenticidade do servidor; confirme os dados em alra.pt. O site www.alra.pt (comissões, agenda) é lido com a cadeia de certificados verificada.')")
        # contagem por partido -> grupos (aprox.: partido do deputado)
        for party, c in db.execute("SELECT party,count(*) FROM deputies WHERE region='acores' AND status='em funções' GROUP BY party").fetchall():
            db.execute("INSERT INTO groups VALUES('acores','XIII',?,?,?,NULL,?)", (party, party, c, src))
    else:
        db.execute("INSERT INTO blocked VALUES('acores','deputados','base.alra.pt','inacessível')")
    # iniciativas legislativas: projetos e propostas de DLR
    for kind, slug in (("Projeto de Decreto Legislativo Regional", "pjdlr"), ("Proposta de Decreto Legislativo Regional", "PpDLR")):
        u = f"{base}/4DACTION/w_iniciativa/{slug}"
        h = try_fetch(u, name=f"alra_{slug}.html")
        if not h:
            continue
        raw = (RAW / f"alra_{slug}.html").read_bytes().decode("latin-1")
        rows = re.findall(r"w_pesquisa_registo/(\d+)/(\d+)\"[^>]*>(.*?)</tr>", raw, re.S)
        if not rows:
            rows = [(a, b, c) for a, b, c in re.findall(r"w_pesquisa_registo/(\d+)/(\d+)(.*?)(?=w_pesquisa_registo|$)", raw, re.S)]
        k = 0
        for typ, rid, chunk in rows:
            cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", chunk, re.S)]
            cells = [re.sub(r"\s+", " ", c) for c in cells if c.strip()]
            if len(cells) < 4 or not re.fullmatch(r"[IVXL]+", cells[0]):
                continue
            number = html.unescape(re.sub(r"<[^>]+>", "", chunk.split("</a>", 1)[0])).strip()
            leg, tit = cells[0], cells[1]
            subj, author = cells[2], cells[3]
            d = try_fetch(f"{base}/4DACTION/w_pesquisa_registo/{typ}/{rid}", name=f"alra_reg_{typ}_{rid}.html")
            date = state = plen = result = session = ""
            if d:
                dd = (RAW / f"alra_reg_{typ}_{rid}.html").read_bytes().decode("latin-1")
                t = html.unescape(re.sub(r"<[^>]+>", "|", dd))
                t = re.sub(r"(\|\s*)+", "|", re.sub(r"\s+", " ", t))
                m = re.search(r"Data de entrada\|(\d\d/\d\d/\d{4})", t)
                date = m.group(1) if m else ""
                rs = [x.strip() for x in re.findall(r"\|Resultado\|([^|]+)", t) if ";" not in x and "Partidos" not in x]
                result = rs[-1] if rs else ""
                m = re.search(r"Data de Plen[áa]rio\|(\d\d/\d\d/\d{4})", t) or re.search(r"An[úu]ncio em Plen[áa]rio\|(\d\d/\d\d/\d{4})", t)
                plen = m.group(1) if m else ""
                m = re.search(r"Sess[ãa]o Legislativa\|([^|]+)", t)
                session = m.group(1).strip() if m else ""
            iso = "-".join(reversed(date.split("/"))) if date else ""
            db.execute("INSERT INTO initiatives VALUES('acores',?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (f"{typ}/{rid}", leg, kind, f"{number}/{leg}", subj if subj and len(subj) > 3 else tit, author, iso, "", "", result, plen and "-".join(reversed(plen.split("/"))), f"{base}/4DACTION/w_pesquisa_registo/{typ}/{rid}", session))
            k += 1
        print(f"  ALRAA {kind}: {k}")
    # comissões permanentes
    for ab in ("cp", "capads", "cpg", "cas", "ce"):
        u = f"https://www.alra.pt/index.php/{ab}"
        h = try_fetch(u, insecure=True, name=f"alra_{ab}.html")
        if not h:
            continue
        h2 = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", h, flags=re.S)
        t = html.unescape(re.sub(r"<[^>]+>", "|", h2))
        t = re.sub(r"(\|\s*)+", "|", re.sub(r"\s+", " ", t))
        m = re.search(r"\|(Comissão de [^|]{5,120})\|Agenda", t)
        name = m.group(1).strip() if m else ab.upper()
        pend = re.search(r"Iniciativas em Apreciação [A-Z]+\|(.*?)\|Petições Pendentes", t)
        npend = len(re.findall(r"\d{4} - [A-Za-zçãõ ]+ - XIII", pend.group(1))) if pend else None
        db.execute("INSERT INTO committees VALUES('acores',?,?,?,?,?)", (ab.upper(), name, u, npend, u))
        ag = re.search(r"Agenda / Eventos [A-Z]+\|(.*?)\|Iniciativas em Apreciação", t)
        if ag:
            for dt, tt in re.findall(r"(\d\d/\d\d/\d{4} - Hora - \d\d:\d\d)\s*\|([^|]+)", ag.group(1)):
                db.execute("INSERT INTO agenda VALUES('acores',?,?,?,?)", (ab.upper(), dt, tt.strip(), u))


# ----------------------------------------------------------------------------- ALRAM
def alram(db):
    u = "https://www.alram.pt/pt/artigos/atividade-parlamentar/deputados/"
    h = try_fetch(u, name="alram_dep.html")
    if h:
        m = re.search(r"EC\.Set\('ParliamentInfo_[^']+', ", h)
        if m:
            o, _ = json.JSONDecoder().raw_decode(h[m.end():])
            pi = o["ParliamentInfo"]
            cnt = {}
            for d in pi["DetalheDeputados"]:
                if d["D_EstadoDeputado"] != 0:
                    continue
                party = d["GP_NomeAbrevGrupoParlamentar"]
                cnt[party] = cnt.get(party, 0) + 1
                db.execute("INSERT INTO deputies(region,legislature,name,full_name,party,circle,role,status,email,source_url) VALUES('madeira','XV',?,?,?,?,?,?,?,?)",
                           (d["E1_NomeAbrevPolitico"], d["E1_NomeCompletoPolitico"], party, "Círculo único regional",
                            d["Cg2_NomeCargo"] or None, "suspenso/substituído" if d["E1_EstadoPolitico"] == 1 else "em funções", d["E1_EmailPolitico"] or None, u))
            for g in pi["GruposParlamentares"]:
                a = g["GP_NomeAbrevGrupoParlamentar"]
                db.execute("INSERT INTO groups VALUES('madeira','XV',?,?,?,?,?)", (a, g["GP_NomeGrupoParlamentar"], cnt.get(a, 0), g.get("GP_Cor"), u))
            print("  ALRAM deputados:", sum(cnt.values()))
    else:
        db.execute("INSERT INTO blocked VALUES('madeira','deputados','alram.pt','inacessível')")
    # iniciativas
    page, seen = 1, 0
    total = None
    while True:
        r = try_fetch("https://www.alram.pt/pt/pesquisa-iniciativas/?t=1", post={"op": "1", "n": "100", "p": str(page)}, name=f"alram_ini_p{page}.json")
        if not r:
            break
        try:
            d = json.loads(r)["Data"]
        except Exception:  # noqa: BLE001
            break
        total = total or d["TotalResults"]
        for it in d["Results"]:
            v = it["Value"]
            i = v["InformacaoIniciativa"]
            kind = i["TipoIniciativa"]
            db.execute("INSERT INTO initiatives VALUES('madeira',?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (i["Id"], i["Legistatura"], kind, i["Numero"], i["Assunto"], i["Autor"], (i["Data"] or "")[:10], i["Estado"], i["FaseAtual"], None, None, v.get("InitiativeURL"), i["SessaoLegislativa"]))
            seen += 1
        if not d["Results"] or seen >= total:
            break
        page += 1
    print("  ALRAM iniciativas:", seen, "de", total)
    db.execute("INSERT INTO blocked VALUES('madeira','comissões e agenda','alram.pt','As comissões permanentes e a agenda da ALRAM não foram localizadas em dados estruturados (páginas renderizadas por JavaScript); não extraídas.')")
    db.execute("INSERT INTO blocked VALUES('madeira','círculos','alram.pt','A Madeira elege num círculo único regional; a página não indica os círculos de origem dos deputados.')")


# ----------------------------------------------------------------------------- eleições
def abbr_of(n):
    x = norm(n)
    for pat, ab in (("psd cds ppm|alianca democratica", "PSD/CDS/PPM"), ("somos madeira|psd cds", "PSD/CDS-PP"), ("social democrata", "PSD"),
                    ("socialista", "PS"), ("chega", "CH"), ("bloco", "BE"), ("liberal", "IL"), ("pessoas animais", "PAN"),
                    ("democratica unitaria|cdu", "CDU"), ("livre", "L"), ("juntos pelo povo|jpp", "JPP"), ("cds", "CDS-PP"),
                    ("monarquico|ppm", "PPM"), ("alternativa democratica|adn", "ADN"), ("nova direita", "ND"), ("trabalhista", "PTP"), ("reformados", "PURP"), ("reagir", "R.I.R."), ("alianca", "A"), ("partido da terra", "MPT"), ("forca madeira", "Força Madeira")):
        if re.search(ab and pat, x):
            return ab
    return n


def elections(db):
    pages = [("acores", 2024), ("acores", 2020), ("acores", 2016), ("madeira", 2025), ("madeira", 2024), ("madeira", 2023), ("madeira", 2019)]
    for reg, yr in pages:
        title = f"Eleições legislativas regionais {'nos Açores' if reg == 'acores' else 'na Madeira'} em {yr}"
        wt = wiki(title)
        if not wt:
            db.execute("INSERT INTO blocked VALUES(?,?,?,?)", (reg, f"eleições {yr}", wurl(title), "não obtido"))
            continue
        sec = wt.split("== Resultados", 1)
        if len(sec) < 2:
            continue
        sec = sec[1]
        n = 0
        tot_seats = None
        for cells in wikitable_rows(sec.split("\n==", 1)[0][:20000]):
            raw = [c for k, c in cells if k == "D"]
            if len(raw) < 5:
                continue
            raw = [c for c in raw if "bgcolor" not in c or "[[" in c]
            txt = [clean_wiki(c) for c in raw]
            name = next((t for t in txt if t and not re.fullmatch(r"[\d\s.,%+-]+", t)), None)
            if not name or re.match(r"(?i)^(total|votos|brancos|nulos|abstenção|inscritos)", name):
                continue
            joined = "\n".join(raw)
            nums = re.findall(r"^\s*(\d{1,3}(?:[  ]\d{3})+|\d{3,})\s*$", joined, flags=re.M)
            votes = int(re.sub(r"\D", "", nums[0])) if nums else None
            tpl = re.findall(r"lugares\|([\d.,]+)\|([\d.,]+)\|", joined)
            pcts = float(tpl[0][0].replace(",", ".")) if tpl else None
            seats = int(float(tpl[1][0])) if len(tpl) > 1 else None
            ts = int(float(tpl[1][1])) if len(tpl) > 1 else None
            if votes is None:
                continue
            nm = re.sub(r"\s*\(\w\)\s*$", "", name).strip()
            db.execute("INSERT INTO elections_wp VALUES(?,?,?,?,?,?,?,?,?)", (reg, yr, nm, abbr_of(nm), votes, pcts, seats, ts, wurl(title)))
            n += 1
        print(f"  eleições {reg} {yr}: {n} listas")
        # total de lugares
        row = db.execute("SELECT max(total_seats) FROM elections_wp WHERE region=? AND year=?", (reg, yr)).fetchone()
        sm = db.execute("SELECT sum(seats) FROM elections_wp WHERE region=? AND year=?", (reg, yr)).fetchone()[0]
        if row and row[0] and sm == row[0]:
            db.execute("UPDATE elections_wp SET seats=0 WHERE region=? AND year=? AND seats IS NULL", (reg, yr))
        if row and row[0]:
            db.execute("UPDATE elections_wp SET total_seats=? WHERE region=? AND year=?", (row[0], reg, yr))
        db.execute("INSERT INTO elections_meta(region,year,source_url) VALUES(?,?,?)", (reg, yr, wurl(title)))
    merge_mai(db)


MAI_ABBR = {"PSD/AD": "PSD", "PCTP/MRPP": "MRPP"}


def merge_mai(db):
    """Resultados oficiais da MAI (data/eleicoes.db, só leitura) como fonte única; a Wikipedia só onde a MAI não tem (Açores 2016)
    e para o quadro de reconciliação."""
    p = ROOT / "data" / "eleicoes.db"
    ids = {("acores", 2024): "reg-ac-2024", ("acores", 2020): "reg-ac-2020", ("madeira", 2025): "reg-ma-2025",
           ("madeira", 2024): "reg-ma-2024", ("madeira", 2023): "reg-ma-2023", ("madeira", 2019): "reg-ma-2019"}
    have = set()

    def ab_of(party, fam, reg=None):
        if fam == "PSD/AD" and "." in party:
            return "PSD/CDS-PP" if reg == "madeira" else "PSD/CDS/PPM"
        return MAI_ABBR.get(fam, fam)

    if p.exists():
        m = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        for (reg, yr), eid in ids.items():
            rows = m.execute("SELECT party,family,votes,pct,valid_pct,mandates,source_url FROM results WHERE election_id=? AND level='nacional' ORDER BY votes DESC", (eid,)).fetchall()
            if not rows:
                continue
            code = "LOCAL-300000" if reg == "madeira" else "LOCAL-400000"
            sm = m.execute("SELECT registered,voters,turnout,blank,null_votes,mandates FROM summary WHERE election_id=? AND level='nacional' AND code=?", (eid, code)).fetchone()
            el = m.execute("SELECT date,source_url FROM elections WHERE id=?", (eid,)).fetchone()
            url = rows[0][6] or (el and el[1]) or "https://www.eleicoes.mai.gov.pt/"
            for party, fam, votes, pct, vpct, mand, _u in rows:
                if votes is None or votes < 10:
                    continue
                db.execute("INSERT INTO elections VALUES(?,?,?,?,?,?,?,?,?,?,'MAI')", (reg, yr, party, ab_of(party, fam, reg), votes, vpct, pct, mand, sm[5] if sm else None, url))
            db.execute("DELETE FROM elections_meta WHERE region=? AND year=?", (reg, yr))
            db.execute("INSERT INTO elections_meta VALUES(?,?,?,?,?,?,?,?,?)", (reg, yr, el[0] if el else None, sm[2] if sm else None, url, sm[0] if sm else None, sm[1] if sm else None, sm[3] if sm else None, sm[4] if sm else None))
            have.add((reg, yr))
            for wn, wab, wv, wp in db.execute("SELECT party,abbr,votes,pct FROM elections_wp WHERE region=? AND year=?", (reg, yr)).fetchall():
                mm = next((r for r in rows if ab_of(r[0], r[1], reg) == wab), None)
                if not mm:
                    db.execute("INSERT INTO election_check VALUES(?,?,?,?,NULL,?,NULL,NULL,NULL,NULL,'lista só na Wikipedia')", (reg, yr, wn, wv, wp))
                    continue
                dv = (wv or 0) - mm[2]
                dval, dvot = abs((wp or 0) - (mm[4] or 0)), abs((wp or 0) - (mm[3] or 0))
                db.execute("INSERT INTO election_check VALUES(?,?,?,?,?,?,?,?,?,?,?)", (reg, yr, wn, wv, mm[2], wp, mm[4], mm[3], min(dval, dvot), dv,
                           "Wikipedia usa % dos votos válidos" if dval <= dvot else "Wikipedia usa % dos votantes"))
    for reg, yr, wn, wab, wv, wp, ws, ts, u in db.execute("SELECT region,year,party,abbr,votes,pct,seats,total_seats,source_url FROM elections_wp").fetchall():
        if (reg, yr) not in have:
            db.execute("INSERT INTO elections VALUES(?,?,?,?,?,?,NULL,?,?,?,'Wikipedia')", (reg, yr, wn, wab, wv, wp, ws, ts, u))
    db.execute("INSERT INTO blocked VALUES(NULL,'eleições (fonte oficial)','eleicoes.mai.gov.pt (via data/eleicoes.db)','Resultados oficiais da MAI usados para Açores 2020/2024 e Madeira 2019/2023/2024/2025. Açores 2016 só existe na Wikipedia (base da percentagem não verificada).')")

# ----------------------------------------------------------------------------- contratos
def contracts(db):
    c = sqlite3.connect(f"file:{ROOT / 'data' / 'politica.db'}?mode=ro", uri=True)
    cand = c.execute("""SELECT buyer_nif,
        sum(location LIKE '%Região Autónoma dos Açores%') az, sum(location LIKE '%Região Autónoma da Madeira%') ma
        FROM contracts WHERE location LIKE '%Região Autónoma%' AND buyer_nif IS NOT NULL GROUP BY buyer_nif""").fetchall()
    nifs = [r[0] for r in cand]
    tot = {}
    for i in range(0, len(nifs), 500):
        ch = nifs[i:i + 500]
        for nif, n in c.execute(f"SELECT buyer_nif,count(*) FROM contracts WHERE buyer_nif IN ({','.join('?' * len(ch))}) GROUP BY buyer_nif", ch):
            tot[nif] = n
    region_of = {}
    for nif, az, ma in cand:
        n = tot.get(nif, 0)
        if n < 3:
            continue
        sh_a, sh_m = az / n, ma / n
        if max(sh_a, sh_m) >= 0.6:
            region_of[nif] = ("acores", sh_a) if sh_a >= sh_m else ("madeira", sh_m)
    ent = {}
    for i in range(0, len(region_of), 500):
        ch = list(region_of)[i:i + 500]
        for nif, name, kind, level in c.execute(f"SELECT nif,name,kind,level FROM entities WHERE nif IN ({','.join('?' * len(ch))})", ch):
            ent[nif] = (name, kind, level)
    # corresponder a secretarias / organismos
    bodies = {}
    for r, sk, name in db.execute("SELECT region,secretaria_key,name FROM bodies"):
        bodies.setdefault(r, []).append((norm(name), sk))
    secs = {}
    for r, k, name in db.execute("SELECT region,key,name FROM secretarias"):
        secs.setdefault(r, []).append((k, norm(name)))

    def classify(reg, name, kind, level):
        n = norm(name)
        if kind == "municipio" or n.startswith("municipio") or "camara municipal" in n:
            return "municipio", None
        if kind == "freguesia" or n.startswith("freguesia") or "junta de freguesia" in n:
            return "freguesia", None
        sk = None
        for bn, k in bodies.get(reg, []):
            if bn and len(bn) > 8 and (bn == n or bn in n or n in bn):
                sk = k
                break
        if sk is None:
            for k, sn in secs.get(reg, []):
                core = re.sub(r"^(de|da|do|das|dos)\s+", "", sn.replace("secretaria regional", "").strip())
                if "secretaria regional" in n and core and core.replace(" de ", " ") in n.replace(" de ", " "):
                    sk = k
                    break
        if sk is None and ("vice presidencia" in n):
            sk = "vice"
        if sk is None and re.search(r"presidencia do governo|governo regional", n):
            sk = "pres"
        if sk:
            return "governo_regional", sk
        if re.match(r"(secretaria regional|direcao regional|inspecao regional|vice presidencia|presidencia do governo|gabinete do (secretario|vice|presidente))", n):
            return "governo_regional", None  # serviços do governo regional sem atribuição a uma secretaria atual (ex.: pastas de governos anteriores)
        if "hospital" in n or "centro de saude" in n or re.search(r"\bsaude\b", n) and "empresa" not in n:
            return "saude", None
        if re.search(r"(\bs a\b|\bsa\b|\be p e\b|\bepe\b|\beper\b|\beperam\b|\bepram\b|\beim\b|\bsociedade\b|\blda\b)", n):
            return "empresa", None
        if re.search(r"\bregiao\b|regional|\bram\b", n) or level == "regional":
            return "setor_regional", None
        if kind in ("escola", "agrupamento") or "escola" in n or "agrupamento" in n:
            return "escola", None
        if kind == "saude" or "hospital" in n or "saude" in n or "centro de saude" in n:
            return "saude", None
        if level == "central" or level == "empresa_publica" or kind == "ministerio":
            return "administracao_central", None
        return "outros", None

    for reg in REGIONS:
        nf = [n for n, (r, s) in region_of.items() if r == reg]
        agg_year, agg_grp, agg_sec, agg_proc, sup = {}, {}, {}, {}, {}
        for i in range(0, len(nf), 400):
            ch = nf[i:i + 400]
            q = f"""SELECT buyer_nif,year,lower(procedure) LIKE 'ajuste direto%' d,procedure,count(*),sum(price)
                    FROM contracts WHERE buyer_nif IN ({','.join('?' * len(ch))}) GROUP BY buyer_nif,year,d,procedure"""
            per = {}
            for nif, yr, d, proc, n, v in c.execute(q, ch):
                p = per.setdefault(nif, {"n": 0, "v": 0.0, "dn": 0, "dv": 0.0, "y0": 9999, "y1": 0})
                v = v or 0
                p["n"] += n
                p["v"] += v
                if d:
                    p["dn"] += n
                    p["dv"] += v
                if yr:
                    p["y0"] = min(p["y0"], yr)
                    p["y1"] = max(p["y1"], yr)
                    a = agg_year.setdefault(yr, [0, 0.0, 0, 0.0])
                    a[0] += n
                    a[1] += v
                    if d:
                        a[2] += n
                        a[3] += v
                pr = agg_proc.setdefault(proc or "(sem procedimento)", [0, 0.0])
                pr[0] += n
                pr[1] += v
            for nif, p in per.items():
                name, kind, level = ent.get(nif, (None, None, None))
                if not name:
                    r = c.execute("SELECT buyer_name FROM contracts WHERE buyer_nif=? LIMIT 1", (nif,)).fetchone()
                    name = r[0] if r else nif
                grp, sk = classify(reg, name, kind, level)
                db.execute("INSERT INTO c_buyer VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                           (reg, nif, name, grp, sk, region_of[nif][1], p["n"], p["v"], p["dn"], p["dv"], p["y0"] if p["y0"] < 9999 else None, p["y1"] or None))
        for r in db.execute("SELECT grp,count(*),sum(n),sum(value),sum(direct_n),sum(direct_value) FROM c_buyer WHERE region=? GROUP BY grp", (reg,)).fetchall():
            db.execute("INSERT INTO c_group VALUES(?,?,?,?,?,?,?)", (reg,) + tuple(r))
        for r in db.execute("SELECT secretaria_key,count(*),sum(n),sum(value),sum(direct_n),sum(direct_value) FROM c_buyer WHERE region=? AND secretaria_key IS NOT NULL GROUP BY secretaria_key", (reg,)).fetchall():
            db.execute("INSERT INTO c_secretaria VALUES(?,?,?,?,?,?,?)", (reg,) + tuple(r))
        for yr, (n, v, dn, dv) in sorted(agg_year.items()):
            db.execute("INSERT INTO c_year VALUES(?,?,?,?,?,?)", (reg, yr, n, v, dn, dv))
        for proc, (n, v) in agg_proc.items():
            db.execute("INSERT INTO c_proc VALUES(?,?,?,?)", (reg, proc, n, v))
        # fornecedores (top 300 por valor, via contratos dos compradores da região)
        sups = {}
        for i in range(0, len(nf), 400):
            ch = nf[i:i + 400]
            for sn, nm, n, v, dv in c.execute(f"""SELECT seller_nif,max(seller_name),count(*),sum(price),sum(CASE WHEN lower(procedure) LIKE 'ajuste direto%' THEN price ELSE 0 END)
                FROM contracts WHERE buyer_nif IN ({','.join('?' * len(ch))}) AND seller_nif IS NOT NULL GROUP BY seller_nif""", ch):
                a = sups.setdefault(sn, [nm, 0, 0.0, 0.0])
                a[1] += n
                a[2] += v or 0
                a[3] += dv or 0
        for sn, (nm, n, v, dv) in sorted(sups.items(), key=lambda x: -x[1][2])[:400]:
            db.execute("INSERT INTO c_supplier VALUES(?,?,?,?,?,?)", (reg, sn, nm, n, v, dv))
        print(f"  contratos {reg}: {len(nf)} compradores")
    db.execute("INSERT INTO meta VALUES('contracts_method','Compradores (buyer_nif) com ≥3 contratos e ≥60% deles com local de execução na Região (contracts.location); contam-se TODOS os seus contratos. Ajuste direto = procedimento «Ajuste direto…». Valor = preço contratual.')")


# ----------------------------------------------------------------------------- main
def main():
    if DB.exists():
        DB.unlink()
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    steps = [("governo Açores", parse_az_government), ("governo Madeira", parse_mad_government), ("orçamento Madeira", parse_mad_budget),
             ("DRE", load_dre), ("ALRAA", alraa), ("ALRAM", alram), ("eleições", elections), ("contratos", contracts)]
    for name, fn in steps:
        print("==", name)
        try:
            fn(db)
            db.commit()
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            db.execute("INSERT INTO blocked VALUES(NULL,?,?,?)", (name, "ingest", f"erro: {type(e).__name__}: {str(e)[:150]}"))
            db.commit()
    db.execute("INSERT INTO meta VALUES('built_at',?)", (NOW,))
    db.commit()
    for t in ("members", "bodies", "budget", "deputies", "initiatives", "committees", "agenda", "acts", "elections", "c_buyer", "crosscheck"):
        print(t, db.execute(f"SELECT count(*) FROM {t}").fetchone()[0])
    db.close()


if __name__ == "__main__":
    main()
