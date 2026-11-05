"""Quem decide — dirigentes, administradores e declarações de interesses -> data/responsaveis.db

REAL SOURCES (all public, anonymous):
  1. Entidade para a Transparência (ET), "acesso público": https://entidadetransparencia.pt (Vue SPA) whose public JSON API
     https://api.entidadetransparencia.pt/publicquery/* is exactly what the site's "Consultar declarações" screens call:
       POST /publicquery                 paged list of mandates (entidade, cargo, titular, início, fim) — ~17k mandates
       POST /publicquery/search          declarations of one titular (HolderId)
       POST /publicquery/getdeclaration  declaration content; only the "Registo de interesses" tab (separador 4) is stored
     Holders: administradores/gestores públicos, dirigentes superiores, membros do Governo, deputados, autarcas, etc.
  2. CReSAP (www.cresap.pt): public lists of concursos para dirigentes superiores (status, entity, cargo, links to
     the 'proposta de designação' PDF and the despacho in DR).
  3. data/ministerios.db (read-only): cabinet nominations of the XXV Governo with their DRE despacho.
  4. data/politica.db (read-only): entities + public contracts (BASE) for the 'ligações declaradas' cross-view.

PRIVACY: we store only what the official body publishes as public in the Registo de Interesses: role, entity, activity
dates, shareholdings (company, % and declared value) — NEVER the declaration's personal-data tab (birth date, address,
nationality, personal NIF), never the assets/income tab, and never the holder's personal NIF (the API echoes it: ignored).
Company NIFs are kept only when they are valid collective-person NIFs (first digit 5,6,7,8,9, mod-11 check digit).

Env: RESP_MAX_REQ (ET detail/search request budget per run, default 3000), RESP_SLEEP (s, default 1.0),
     RESP_LIST_REFRESH_H (hours before the mandate list is re-crawled, default 48), RESP_HOLDER_REFRESH_D (default 14),
     RESP_SKIP_ET=1 / RESP_SKIP_CRESAP=1 (skip a source).
"""
import gzip
import html
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone, date
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA_DIR, ROOT, UA  # noqa: E402
import migrations  # noqa: E402

NAME = "responsaveis"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
SLEEP = float(os.environ.get("RESP_SLEEP", "1.0"))
MAX_REQ = int(os.environ.get("RESP_MAX_REQ", "3000"))
LIST_REFRESH_H = float(os.environ.get("RESP_LIST_REFRESH_H", "48"))
HOLDER_REFRESH_D = float(os.environ.get("RESP_HOLDER_REFRESH_D", "14"))
ET_API = "https://api.entidadetransparencia.pt/publicquery"
ET_SITE = "https://entidadetransparencia.pt"
ET_URL = ET_SITE + "/consultardeclaracaopublica"
LISBON = ZoneInfo("Europe/Lisbon")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- ET public register of mandates (cargos): who sits where, from when to when
CREATE TABLE IF NOT EXISTS mandates (
  id INTEGER PRIMARY KEY, entity_id INTEGER, entity TEXT, role_id INTEGER, role TEXT, holder_id INTEGER, holder TEXT,
  begin_date TEXT, end_date TEXT, board TEXT, entity_nif TEXT, match_method TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS m_holder ON mandates(holder_id);
CREATE INDEX IF NOT EXISTS m_entity ON mandates(entity_id);
CREATE INDEX IF NOT EXISTS m_nif ON mandates(entity_nif);
CREATE INDEX IF NOT EXISTS m_end ON mandates(end_date);
CREATE TABLE IF NOT EXISTS holders (holder_id INTEGER PRIMARY KEY, name TEXT, checked_at TEXT, n_decl INTEGER);
CREATE TABLE IF NOT EXISTS declarations (
  id INTEGER PRIMARY KEY, holder_id INTEGER, entity TEXT, board TEXT, role TEXT, nature TEXT, state TEXT, state_id INTEGER,
  year INTEGER, start_date TEXT, end_date TEXT, delivery_date TEXT, detail_at TEXT, n_interests INTEGER, source_url TEXT
);
CREATE INDEX IF NOT EXISTS d_holder ON declarations(holder_id);
-- Registo de interesses: one row per line of the 6 public tables
CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, declaration_id INTEGER, holder_id INTEGER,
  section TEXT,            -- atividade | associativa | apoio | servico | sociedade | outra
  role TEXT,               -- cargo/função (atividade, associativa) ou descrição (serviço, apoio, outra situação)
  company TEXT, company_nif TEXT, nature TEXT, start_date TEXT, end_date TEXT,
  percent REAL, amount REAL, held_by TEXT,   -- sociedades: % (0-100), valor declarado (EUR), quem detém
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS i_holder ON interests(holder_id);
CREATE INDEX IF NOT EXISTS i_nif ON interests(company_nif);
CREATE INDEX IF NOT EXISTS i_decl ON interests(declaration_id);
-- CReSAP: concursos para dirigentes superiores
CREATE TABLE IF NOT EXISTS cresap (
  code TEXT, status TEXT, entity TEXT, role TEXT, entity_nif TEXT, proposal_url TEXT, despacho_url TEXT,
  item_url TEXT, source_url TEXT, seen_at TEXT, UNIQUE (code, status, entity, role)
);
-- Nomeações para gabinetes (from ministerios.db) — copied so the module is self-contained
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, person TEXT, role TEXT, organ TEXT, ministry TEXT, start TEXT,
  act TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS a_person ON appointments(person);
-- Cross-view: declared company (valid NIF) x contracts won (BASE)
CREATE TABLE IF NOT EXISTS links (
  interest_id INTEGER PRIMARY KEY, holder_id INTEGER, company_nif TEXT, n_contracts INTEGER, total REAL,
  first_signed TEXT, last_signed TEXT, n_in_period INTEGER, total_in_period REAL,
  n_with_own_entity INTEGER, total_with_own_entity REAL, is_public INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS l_holder ON links(holder_id);
CREATE INDEX IF NOT EXISTS l_nif ON links(company_nif);
CREATE TABLE IF NOT EXISTS blocked (source TEXT, reason TEXT);
"""


def log(*a):
    print("[responsaveis]", *a, flush=True)


# ----------------------------------------------------------------------------- http
_last = {}
_nreq = [0]


def _wait(host):
    w = SLEEP - (time.time() - _last.get(host, 0))
    if w > 0:
        time.sleep(w)
    _last[host] = time.time()


def http(url, data=None, headers=None, timeout=60, tries=4):
    host = url.split("/")[2]
    h = {"User-Agent": UA, "Accept": "application/json, text/html, */*", "Accept-Language": "pt-PT,pt;q=0.9"}
    h.update(headers or {})
    for attempt in range(tries):
        _wait(host)
        _nreq[0] += 1
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(5 * (attempt + 1)); continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < tries - 1:
                time.sleep(5 * (attempt + 1)); continue
            raise


def et_post(path, body):
    raw = http(ET_API + path, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "Origin": ET_SITE, "Referer": ET_SITE + "/"})
    return json.loads(raw)


def cache_write(rel, obj):
    p = RAW / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


# ----------------------------------------------------------------------------- helpers
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def valid_company_nif(v):
    """9 digits, first digit 5/6/7/8/9 (collective persons), mod-11 check digit. Personal NIFs (1/2/3) are NEVER kept."""
    v = re.sub(r"\D", "", str(v or ""))
    if len(v) != 9 or v[0] not in "56789":
        return None
    s = sum(int(v[i]) * (9 - i) for i in range(8))
    c = 11 - s % 11
    c = 0 if c >= 10 else c
    return v if c == int(v[8]) else None


def d10(v):
    """ISO instant from the declaration -> local (Lisbon) date."""
    if not v or not isinstance(v, str) or len(v) < 10:
        return None
    try:
        if v.endswith("Z"):
            dt = datetime.fromisoformat(v[:-1]).replace(tzinfo=timezone.utc).astimezone(LISBON)
            return dt.date().isoformat()
    except ValueError:
        pass
    return v[:10]


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------- ET: mandates
def phase_mandates(con):
    m = dict(con.execute("SELECT key, value FROM meta").fetchall())
    last = m.get("mandates_at")
    if last and (datetime.now() - datetime.fromisoformat(last)).total_seconds() / 3600 < LIST_REFRESH_H and int(m.get("mandates_total", 0)) <= con.execute("SELECT COUNT(*) FROM mandates").fetchone()[0] + 50:
        log("mandate list fresh, skipping crawl"); return
    page, pages, n = 1, 1, 0
    while page <= pages:
        try:
            d = et_post("", {"pageNumber": page})
        except Exception as e:
            log("mandate page failed", page, e); page += 1; continue
        data = d.get("data") or {}
        pages = data.get("pageCount", pages)
        if page == 1:
            con.execute("INSERT OR REPLACE INTO meta VALUES ('mandates_total', ?)", (str(data.get("total")),))
            log(f"mandates: total {data.get('total')} in {pages} pages")
        for it in data.get("items", []):
            con.execute("""INSERT INTO mandates (id, entity_id, entity, role_id, role, holder_id, holder, begin_date, end_date, source_url)
              VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entity=excluded.entity, role=excluded.role, holder=excluded.holder,
              begin_date=excluded.begin_date, end_date=excluded.end_date""",
                        (it["id"], it["entityId"], it["entity"], it["roleId"], it["role"], it["holderId"], (it["holder"] or "").strip(),
                         (it.get("beginDate") or "")[:10] or None, (it.get("endDate") or "")[:10] or None, ET_URL))
            n += 1
        if page % 25 == 0:
            con.commit(); log(f"  mandates page {page}/{pages}")
        page += 1
    con.execute("INSERT OR REPLACE INTO meta VALUES ('mandates_at', ?)", (datetime.now().isoformat(timespec="seconds"),))
    con.commit()
    log("mandates stored:", con.execute("SELECT COUNT(*) FROM mandates").fetchone()[0])


# ----------------------------------------------------------------------------- ET: declarations -> Registo de interesses
TABLES = {  # table GUID prefix -> (section, {field: col})
    "2c6d9562": ("atividade", dict(role="col1", company="col2", nature="col3", start="col6", end="col7", nif="col9")),
    "cd0e811a": ("associativa", dict(role="col1", company="col2", nature="col3", start="col6", end="col7", nif="col8")),
    "62fb0107": ("apoio", dict(role="col1", company="col2", nature="col3", start="col5", end="col7", nif="col6", held="col8")),
    "b1f8c095": ("servico", dict(role="col1", company="col2", nature="col3", start="col5", end="col7", nif="col6")),
    "9b58c917": ("sociedade", dict(company="col1", role="col2", nif="col7", pct="col5", amount="col4", held="col8", nature="col6")),
    "fd85f91f": ("outra", dict(role="col4", nature="col5", start="col2", amount="col3")),
}
HELD_SOC = {1: "declarante (titular único)", 2: "declarante (cotitular)", 3: "cônjuge", 4: "pessoa em união de facto"}
HELD_APOIO = {0: "declarante", 1: "cônjuge", 2: "pessoa em união de facto", 3: "sociedade participada"}
SOC_NATURE = {1: "Sociedade civil", 2: "Sociedade comercial"}


def parse_interests(decl):
    """Walk the declaration tree; keep ONLY the six public Registo-de-Interesses tables (separador 4)."""
    out = []

    def walk(n):
        if not (isinstance(n, dict) and "key" in n):
            return
        v = n.get("value")
        if not isinstance(v, list):
            return
        k = n["key"][:8]
        if k in TABLES and v and all(isinstance(c, dict) and "-col" in c.get("key", "") for c in v):
            cells = {c["key"].rsplit("-", 1)[-1]: c["value"] for c in v if c.get("isVisible") and c.get("value") not in (None, "")}
            sec, cm = TABLES[k]
            g = lambda f: cells.get(cm[f]) if f in cm else None
            if sec == "outra" and g("role") in (None, ""):
                return
            if sec != "outra" and not (g("company") or g("role")):
                return
            held = g("held")
            # items held by a spouse / partner are NOT attributed to the holder and not stored
            if (sec == "sociedade" and str(held) in ("3", "4")) or (sec == "apoio" and str(held) in ("1", "2")):
                return
            if sec == "sociedade":
                held = None
                nat = SOC_NATURE.get(int(g("nature"))) if str(g("nature")).isdigit() else None
            elif sec == "apoio":
                held = None
                nat = g("nature")
            else:
                nat = g("nature")
            out.append(dict(section=sec, role=(str(g("role")).strip() if g("role") is not None else None),
                            company=(str(g("company")).strip() if g("company") else None), company_nif=valid_company_nif(g("nif")),
                            nature=(str(nat).strip() if nat else None), start=d10(g("start")), end=d10(g("end")),
                            percent=None, amount=None, held_by=None))  # privacy: no stake values, no family relation
            return
        for c in v:
            walk(c)

    walk(decl.get("data"))
    return out


def holder_order(con):
    today = date.today().isoformat()
    rows = con.execute("""SELECT holder_id,
        MAX(CASE WHEN end_date IS NULL OR end_date >= ? THEN 1 ELSE 0 END) active, MAX(COALESCE(end_date,'9999')) last_end
      FROM mandates GROUP BY holder_id ORDER BY active DESC, last_end DESC""", (today,)).fetchall()
    return [r[0] for r in rows]


def phase_declarations(con):
    cutoff = (datetime.now().timestamp() - HOLDER_REFRESH_D * 86400)
    checked = {r[0]: r[1] for r in con.execute("SELECT holder_id, checked_at FROM holders")}
    todo = []
    for h in holder_order(con):
        t = checked.get(h)
        if t and datetime.fromisoformat(t).timestamp() > cutoff:
            # holder listed recently; still fetch missing declaration details
            if not con.execute("SELECT 1 FROM declarations WHERE holder_id=? AND state_id=8 AND detail_at IS NULL LIMIT 1", (h,)).fetchone():
                continue
        todo.append(h)
    log(f"holders to process: {len(todo)} (budget {MAX_REQ} requests)")
    start_req = _nreq[0]
    names = dict(con.execute("SELECT holder_id, MAX(holder) FROM mandates GROUP BY holder_id").fetchall())
    for i, h in enumerate(todo):
        if _nreq[0] - start_req >= MAX_REQ:
            log("request budget reached"); break
        t = checked.get(h)
        fresh = t and datetime.fromisoformat(t).timestamp() > cutoff
        if not fresh:
            items, page, pages = [], 1, 1
            ok = True
            while page <= pages:
                try:
                    d = et_post("/search", {"pageNumber": page, "HolderId": h})
                except Exception as e:
                    log("search failed", h, e); ok = False; break
                data = d.get("data") or {}
                pages = data.get("pageCount", 1)
                items += data.get("items", [])
                page += 1
            if not ok:
                continue
            for it in items:
                con.execute("""INSERT INTO declarations (id, holder_id, entity, board, role, nature, state, state_id, year, start_date, end_date, delivery_date, source_url)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, state_id=excluded.state_id,
                  nature=excluded.nature, delivery_date=excluded.delivery_date, end_date=excluded.end_date""",
                            (it["id"], h, it.get("entity"), it.get("board"), it.get("role"), it.get("natureType"), it.get("stateType"),
                             it.get("stateTypeId"), it.get("year"), (it.get("startDate") or "")[:10] or None, (it.get("endDate") or "")[:10] or None,
                             (it.get("deliveryDate") or "")[:10] or None, ET_URL))
            con.execute("INSERT OR REPLACE INTO holders VALUES (?,?,?,?)", (h, names.get(h), datetime.now().isoformat(timespec="seconds"), len(items)))
        for (did,) in con.execute("SELECT id FROM declarations WHERE holder_id=? AND state_id=8 AND detail_at IS NULL ORDER BY delivery_date DESC", (h,)).fetchall():
            try:
                d = et_post("/getdeclaration", {"Id": did, "isDraft": False})
            except Exception as e:
                log("declaration failed", did, e); continue
            dd = d.get("data")
            if d.get("code") != 0 or not dd:
                con.execute("UPDATE declarations SET detail_at=?, n_interests=0 WHERE id=?", (datetime.now().isoformat(timespec="seconds"), did)); continue
            ints = parse_interests(dd)
            con.execute("DELETE FROM interests WHERE declaration_id=?", (did,))
            for x in ints:
                con.execute("""INSERT INTO interests (declaration_id, holder_id, section, role, company, company_nif, nature, start_date, end_date, percent, amount, held_by, source_url)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (did, h, x["section"], x["role"], x["company"], x["company_nif"], x["nature"], x["start"],
                                                          x["end"], x["percent"], x["amount"], x["held_by"], ET_URL))
            con.execute("UPDATE declarations SET detail_at=?, n_interests=? WHERE id=?", (datetime.now().isoformat(timespec="seconds"), len(ints), did))
            # raw cache of ONLY the public interest rows (not the full declaration, which carries personal data)
            cache_write(f"et/interests_{did}.json.gz", ints)
        if i % 10 == 0:
            con.commit()
        if i % 100 == 0:
            log(f"  holder {i + 1}/{len(todo)} (requests {_nreq[0] - start_req})")
    con.commit()


# ----------------------------------------------------------------------------- CReSAP
CRESAP_PAGES = {
    "aberto": "/concursos-dirigente-superior/procedimentos-concursais-abertos",
    "a abrir": "/concursos-dirigente-superior/procedimentos-concursais-a-abrir-em-breve",
    "em avaliação": "/concursos-dirigente-superior/procedimentos-concursais-em-avaliacao",
    "enviado à tutela": "/concursos-dirigente-superior/procedimentos-concursais-com-envio-a-tutela-para-nomeacao",
    "concluído": "/concursos-dirigente-superior/procedimentos-concursais-concluidos",
}


def strip(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or ""))).strip()


def phase_cresap(con):
    now = datetime.now().isoformat(timespec="seconds")
    n = 0
    for status, path in CRESAP_PAGES.items():
        url = "https://www.cresap.pt" + path
        try:
            t = http(url).decode("utf-8", "replace")
        except Exception as e:
            log("cresap failed", status, e)
            con.execute("INSERT INTO blocked VALUES (?,?)", ("cresap " + status, str(e))); continue
        cache_write(f"cresap_{status.replace(' ', '_')}.html.gz", t[:2_000_000])
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", t, flags=re.S):
            tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S)
            if len(tds) < 3:
                continue
            links = re.findall(r'href="([^"]+)"', tr)
            cells = [strip(x) for x in tds]
            code, entity, role = cells[0], cells[1], cells[2]
            if not entity:
                continue
            dl = [l for l in links if "/item/download/" in l]
            item = [l if l.startswith("http") else "https://www.cresap.pt" + l for l in links if "/procedimentos-concursais/item/" in l and "/download/" not in l]
            prop = dl[0] if dl else None
            desp = dl[1] if len(dl) > 1 else None
            con.execute("""INSERT OR REPLACE INTO cresap (code, status, entity, role, entity_nif, proposal_url, despacho_url, item_url, source_url, seen_at)
              VALUES (?,?,?,?,NULL,?,?,?,?,?)""", (code, status, entity, role, prop, desp, item[0] if item else None, url, now))
            n += 1
    con.commit()
    log("cresap procedures:", n)


# ----------------------------------------------------------------------------- ministerios cabinet nominations
def phase_appointments(con):
    p = DATA_DIR / "ministerios.db"
    if not p.exists():
        con.execute("INSERT INTO blocked VALUES ('ministerios.db', 'ficheiro inexistente')"); return
    mc = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    con.execute("DELETE FROM appointments WHERE source='gabinete'")
    rows = mc.execute("SELECT name, role, unit, ministry, start, despacho, source_url FROM people WHERE name IS NOT NULL AND name != ''").fetchall()
    for name, role, unit, ministry, start, desp, src in rows:
        con.execute("INSERT INTO appointments (source, person, role, organ, ministry, start, act, source_url) VALUES ('gabinete',?,?,?,?,?,?,?)",
                    (name.strip(), role, unit, ministry, start, desp, src))
    con.commit()
    log("cabinet appointments:", len(rows))


# ----------------------------------------------------------------------------- entity matching + contracts cross-view
def phase_match_and_links(con):
    pol = sqlite3.connect(f"file:{DATA_DIR / 'politica.db'}?mode=ro", uri=True)
    pol.execute("PRAGMA query_only=ON")
    # 1. ET entity (organisation) -> entities.nif by EXACT normalised name, only when unique (method recorded)
    byname, muni = {}, {}
    nm = lambda x: norm((x or "").replace(".", ""))
    for nif, name, kind in pol.execute("SELECT nif, name, kind FROM entities WHERE nif IS NOT NULL"):
        byname.setdefault(nm(name), set()).add(nif)
        if kind == "municipio":
            muni.setdefault(nm(name), set()).add(nif)

    def lookup(name):
        c = byname.get(nm(name))
        if c and len(c) == 1:
            return next(iter(c)), "nome exato (único)"
        m = re.match(r"^(?:c[aâ]mara municipal|munic[ií]pio)\s+(?:d[aeo]s?\s+)?(.+)$", (name or "").strip(), re.I)
        if m:
            c = muni.get(nm(m.group(1)))
            if c and len(c) == 1:
                return next(iter(c)), "município pelo nome (Câmara Municipal de X)"
        return None, None
    upd = 0
    for eid, name in con.execute("SELECT DISTINCT entity_id, entity FROM mandates").fetchall():
        nif, how = lookup(name)
        if nif:
            con.execute("UPDATE mandates SET entity_nif=?, match_method=? WHERE entity_id=?", (nif, how, eid)); upd += 1
    for rid, ent in con.execute("SELECT rowid, entity FROM cresap").fetchall():
        nif, _ = lookup(ent)
        if nif:
            con.execute("UPDATE cresap SET entity_nif=? WHERE rowid=?", (nif, rid))
    log("ET entities matched to NIF by exact name:", upd)
    con.commit()
    # 2. interests with a valid company NIF -> contracts as seller
    migrations.ensure_responsaveis(con)
    con.execute("DELETE FROM links")
    nifs = [r[0] for r in con.execute("SELECT DISTINCT company_nif FROM interests WHERE company_nif IS NOT NULL")]
    agg = {}
    for i in range(0, len(nifs), 400):
        ch = nifs[i:i + 400]
        q = ",".join("?" * len(ch))
        for r in pol.execute(f"SELECT seller_nif, COUNT(*), SUM(COALESCE(price,0)), MIN(COALESCE(NULLIF(signed,''),published)), MAX(COALESCE(NULLIF(signed,''),published)) FROM contracts WHERE seller_nif IN ({q}) GROUP BY seller_nif", ch):
            agg[r[0]] = r
    pub = set()
    for i in range(0, len(nifs), 400):
        ch = nifs[i:i + 400]
        pub |= {r[0] for r in pol.execute(f"SELECT nif FROM entities WHERE is_public = 1 AND nif IN ({','.join('?' * len(ch))})", ch)}
    pub |= {n for n in nifs if n.startswith("6")}  # NIPC 6xx = administração pública
    log(f"declared company NIFs: {len(nifs)}; with contracts as seller: {len(agg)}")
    today = date.today().isoformat()
    ints = con.execute("""SELECT i.id, i.holder_id, i.company_nif, i.start_date, i.end_date, i.section FROM interests i
                          WHERE i.company_nif IS NOT NULL""").fetchall()
    # organisations where each holder sits (to flag 'same entity' relations)
    own = {}
    for h, nif in con.execute("SELECT holder_id, entity_nif FROM mandates WHERE entity_nif IS NOT NULL"):
        own.setdefault(h, set()).add(nif)
    n = 0
    for iid, h, nif, s, e, sec in ints:
        if nif not in agg:
            continue
        a = agg[nif]
        lo = s or "0000"
        hi = e or today
        r = pol.execute("SELECT COUNT(*), SUM(COALESCE(price,0)) FROM contracts WHERE seller_nif=? AND COALESCE(NULLIF(signed,''),published) >= ? AND COALESCE(NULLIF(signed,''),published) <= ?", (nif, lo, hi + "~")).fetchone()
        ob = list(own.get(h, ()))
        ro = (0, 0)
        if ob:
            q = ",".join("?" * len(ob))
            ro = pol.execute(f"SELECT COUNT(*), SUM(COALESCE(price,0)) FROM contracts WHERE seller_nif=? AND buyer_nif IN ({q})", [nif] + ob).fetchone()
        con.execute("INSERT OR REPLACE INTO links VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (iid, h, nif, a[1], a[2], a[3], a[4], r[0] or 0, r[1] or 0, ro[0] or 0, ro[1] or 0, 1 if nif in pub else 0)); n += 1
    con.commit()
    log("declared-link rows:", n)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    con.execute("DELETE FROM blocked")
    # privacy: never keep relatives' items, stake values or family relations
    con.execute("DELETE FROM interests WHERE held_by LIKE 'cônjuge%' OR held_by LIKE 'pessoa em união%'")
    con.execute("UPDATE interests SET percent=NULL, amount=NULL, held_by=NULL")
    con.execute("UPDATE declarations SET n_interests=(SELECT COUNT(*) FROM interests WHERE declaration_id=declarations.id) WHERE detail_at IS NOT NULL")
    for f in (RAW / "et").glob("interests_*.json.gz"):  # old caches carried stake values / relations
        try:
            with gzip.open(f, "rt", encoding="utf-8") as fh:
                rows = json.load(fh)
            clean = [{**r, "percent": None, "amount": None, "held_by": None} for r in rows]
            cache_write(f"et/{f.name}", clean)
        except Exception:
            f.unlink()
    con.commit()
    con.execute("INSERT INTO blocked VALUES ('DRE série II (despachos de nomeação)', 'Não recolhida: a pesquisa exige sessão de cliente. Usados apenas atos da série I já em dre.db (resoluções do Conselho de Ministros e decretos do Presidente da República); despachos da série II ficam de fora.')")
    con.execute("INSERT INTO blocked VALUES ('Declarações: separadores de rendimentos e património', 'Não recolhidos de propósito: o portal só publica o Registo de interesses; rendimentos/património têm acesso restrito e dados pessoais.')")
    con.execute("INSERT INTO blocked VALUES ('Parlamento: Registo de Interesses dos deputados (XVII)', 'parlamento.pt/DeputadoGP/Paginas/RegistoInteresses.aspx?BID= só mostra a identificação do declarante (nome, atividade principal); o registo de interesses atual está na plataforma da Entidade para a Transparência, usada aqui.')")
    con.commit()
    if not os.environ.get("RESP_SKIP_ET"):
        phase_mandates(con)
        phase_declarations(con)
    if not os.environ.get("RESP_SKIP_CRESAP"):
        phase_cresap(con)
    phase_appointments(con)
    phase_match_and_links(con)
    import responsaveis_nomeacoes as rn
    migrations.ensure_responsaveis(con)
    rn.phase_dre(con, DATA_DIR, log)
    if not os.environ.get("RESP_SKIP_CRESAP"):
        rn.phase_cresap_results(con, DATA_DIR, log, SLEEP)
    stats = {k: con.execute(q).fetchone()[0] for k, q in {
        "mandates": "SELECT COUNT(*) FROM mandates", "holders_total": "SELECT COUNT(DISTINCT holder_id) FROM mandates",
        "holders_checked": "SELECT COUNT(*) FROM holders", "declarations": "SELECT COUNT(*) FROM declarations",
        "declarations_detailed": "SELECT COUNT(*) FROM declarations WHERE detail_at IS NOT NULL", "interests": "SELECT COUNT(*) FROM interests",
        "interests_with_nif": "SELECT COUNT(*) FROM interests WHERE company_nif IS NOT NULL", "links": "SELECT COUNT(*) FROM links",
        "cresap": "SELECT COUNT(*) FROM cresap", "appointments": "SELECT COUNT(*) FROM appointments"}.items()}
    for k, v in {**stats, "updated": datetime.now().isoformat(timespec="seconds")}.items():
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, str(v)))
    con.commit()
    con.close()
    log("done", stats)


if __name__ == "__main__":
    main()
