"""Eleições: results of every national-scale election in Portugal found on the MAI/SGMAI results sites.

Sources (all public, static JSON behind the Angular / legacy apps, fetched with a browser UA, >=1.1 s between requests,
cached in data/raw/eleicoes/):
  * www.eleicoes.mai.gov.pt/<site>/static-data/territory-results/TERRITORY-RESULTS-<KEY>-<ORG>.json   (legacy engine, 2009-2019)
  * www.eleicoes.mai.gov.pt/<site>/assets/static/territory-results/territory-results-<KEY>-<ORG>.json (2020-2025 engine)
  * www.eleicoes.mai.gov.pt/presidenciais2026_{1S,2S}/assets/static/{election,territory,result}/...    (2026 platform, electionId)
  Each file also carries `previousResults` (the previous election of the same type for the same territory): used to add the
  elections that have no site of their own in JSON (legislativas 2005, presidenciais 2006, europeias 2009, regionais).
  Territory keys: LOCAL-500000 national, LOCAL-DD0000 distrito/região, LOCAL-DDMM00 concelho (DDMM == DICO of
  data/autarquias.db `municipios`). Freguesia level is NOT fetched (3,000 files per election) unless ELEICOES_FREGUESIAS=1
  (then only the latest legislativas).
Elections before 2005 and the foreign constituencies (Europa / Fora da Europa) are not available at territory level in JSON.
Outputs: data/eleicoes.db
Env: ELEICOES_ONLY=<id,id>  restrict to some elections; ELEICOES_NOCONC=1 skip concelho level.
"""
import json
import os
import re
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

from common import ROOT

NAME = "eleicoes"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
AUT = ROOT / "data" / "autarquias.db"
MAI = "https://www.eleicoes.mai.gov.pt"
BUA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
GAP = 1.1

# (id, type, year, round, date, name, site, org, fmt, scope)
EL = [
    ("leg-2025", "legislativas", 2025, 1, "2025-05-18", "Legislativas 2025", "legislativas2025", "AR", "mid", "LOCAL-500000"),
    ("leg-2024", "legislativas", 2024, 1, "2024-03-10", "Legislativas 2024", "legislativas2024", "AR", "mid", "LOCAL-500000"),
    ("leg-2022", "legislativas", 2022, 1, "2022-01-30", "Legislativas 2022", "legislativas2022", "AR", "mid", "LOCAL-500000"),
    ("leg-2019", "legislativas", 2019, 1, "2019-10-06", "Legislativas 2019", "legislativas2019", "AR", "legacy", "LOCAL-500000"),
    ("leg-2015", "legislativas", 2015, 1, "2015-10-04", "Legislativas 2015", "legislativas2015", "AR", "legacy", "LOCAL-500000"),
    ("leg-2011", "legislativas", 2011, 1, "2011-06-05", "Legislativas 2011", "legislativas2011", "AR", "legacy", "LOCAL-500000"),
    ("leg-2009", "legislativas", 2009, 1, "2009-09-27", "Legislativas 2009", "legislativas2009", "AR", "legacy", "LOCAL-500000"),
    ("pres-2026-2", "presidenciais", 2026, 2, "2026-02-08", "Presidenciais 2026 (2.ª volta)", "presidenciais2026_2S", "PR", "new", None),
    ("pres-2026-1", "presidenciais", 2026, 1, "2026-01-18", "Presidenciais 2026 (1.ª volta)", "presidenciais2026_1S", "PR", "new", None),
    ("pres-2021", "presidenciais", 2021, 1, "2021-01-24", "Presidenciais 2021", "presidenciais2021", "PR", "mid", "LOCAL-500000"),
    ("pres-2016", "presidenciais", 2016, 1, "2016-01-24", "Presidenciais 2016", "presidenciais2016", "PR", "legacy", "LOCAL-500000"),
    ("pres-2011", "presidenciais", 2011, 1, "2011-01-23", "Presidenciais 2011", "presidenciais2011", "PR", "legacy", "LOCAL-500000"),
    ("eur-2024", "europeias", 2024, 1, "2024-06-09", "Europeias 2024", "europeias2024", "PE", "mid", "LOCAL-500000"),
    ("eur-2019", "europeias", 2019, 1, "2019-05-26", "Europeias 2019", "europeias2019", "EUR", "legacy", "LOCAL-500000"),
    ("eur-2014", "europeias", 2014, 1, "2014-05-25", "Europeias 2014", "europeias2014", "EUR", "legacy", "LOCAL-500000"),
    ("reg-ma-2025", "regionais", 2025, 1, "2025-05-18", "Regionais Madeira 2025", "regionais2025", "RM", "mid", "LOCAL-300000"),
    ("reg-ma-2024", "regionais", 2024, 1, "2024-03-24", "Regionais Madeira 2024", "regionais-madeira2024", "RM", "mid", "LOCAL-300000"),
    ("reg-ma-2023", "regionais", 2023, 1, "2023-09-24", "Regionais Madeira 2023", "regionais2023", "RM", "mid", "LOCAL-300000"),
    ("reg-ac-2024", "regionais", 2024, 1, "2024-02-04", "Regionais Açores 2024", "regionais2024", "RA", "mid", "LOCAL-400000"),
]
# elections that only exist as `previousResults` of another: (id, type, year, round, date, name, derived-from election id)
PREV = {
    "leg-2009": ("leg-2005", "legislativas", 2005, 1, "2005-02-20", "Legislativas 2005"),
    "pres-2011": ("pres-2006", "presidenciais", 2006, 1, "2006-01-22", "Presidenciais 2006"),
    "eur-2014": ("eur-2009", "europeias", 2009, 1, "2009-06-07", "Europeias 2009"),
    "reg-ma-2023": ("reg-ma-2019", "regionais", 2019, 1, "2019-09-22", "Regionais Madeira 2019"),
    "reg-ac-2024": ("reg-ac-2020", "regionais", 2020, 1, "2020-10-25", "Regionais Açores 2020"),
}

GLOBAL = "GLOBAL-990000"

SCHEMA = """
CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY, type TEXT, year INTEGER, round INTEGER, date TEXT, name TEXT, scope TEXT,
  levels TEXT, note TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS territories (
  election_id TEXT, level TEXT, code TEXT, name TEXT, parent TEXT, PRIMARY KEY (election_id, level, code));
-- level: nacional | distrito (círculo/região) | concelho ; code: LOCAL key for nacional/distrito, DICO (4 digits) for concelho
CREATE TABLE IF NOT EXISTS summary (
  election_id TEXT, level TEXT, code TEXT, registered INTEGER, voters INTEGER, turnout REAL, abstention_pct REAL,
  blank INTEGER, blank_pct REAL, null_votes INTEGER, null_pct REAL, mandates INTEGER, source_url TEXT,
  PRIMARY KEY (election_id, level, code));
CREATE TABLE IF NOT EXISTS results (
  election_id TEXT, level TEXT, code TEXT, party TEXT, family TEXT, votes INTEGER, pct REAL, valid_pct REAL,
  mandates INTEGER, source_url TEXT);
CREATE INDEX IF NOT EXISTS r_key ON results(election_id, level, code);
CREATE INDEX IF NOT EXISTS r_fam ON results(family, election_id, level);
-- freguesias (post-2013 DICOFRE 6-digit code from the MAI territory key LOCAL-<code>); entity_id = politica.db entity (kind=freguesia)
CREATE TABLE IF NOT EXISTS freguesias (code TEXT PRIMARY KEY, dico TEXT, name TEXT, name_key TEXT, entity_id INTEGER, match_method TEXT);
CREATE INDEX IF NOT EXISTS fr_dico ON freguesias(dico, name_key); CREATE INDEX IF NOT EXISTS fr_ent ON freguesias(entity_id);
CREATE TABLE IF NOT EXISTS municipios (dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_id INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


_last = [0.0]


def fetch(url, cache):
    """GET json with cache (404 cached as empty file). Returns parsed JSON or None."""
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        t = cache.read_text()
        return json.loads(t) if t else None
    for attempt in range(3):
        w = GAP - (time.time() - _last[0])
        if w > 0:
            time.sleep(w)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": BUA}), timeout=40) as r:
                b = r.read()
            cache.write_bytes(b)
            return json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (404, 412):
                cache.write_text("")
                return None
            time.sleep(3)
        except Exception:
            time.sleep(3)
    return None


# party families: conservative, only unambiguous renamings of the same political space
def family(a):
    u = a.upper().replace(" ", "")
    if u == "FRS":
        return "PS"  # Frente Republicana e Socialista 1980 (PS + UEDS + ASDI), led by PS
    if u in ("PPD", "AD"):
        return "PSD/AD"
    if re.match(r"^(PPD/PSD|PSD)(\.CDS-PP)?(\.PPM)?(\.MPT)?(\.PPM)?$", u) or u in ("AD", "PPD/PSD.CDS-PP.PPM"):
        return "PSD/AD"
    if re.match(r"^PSD", u) or u.startswith("PPD/PSD"):
        return "PSD/AD"
    if u == "PS" or u == "PS/PSD":
        return "PS"
    if u in ("APU", "PCP", "FEPU", "COMMUNISTPARTYOFPORTUGAL"):
        return "CDU"  # PCP alone (1975-76), FEPU, APU, CDU/PCP-PEV = same political space
    if u in ("CDU", "PCP-PEV", "PCP-PEV/CDU") or u.startswith("PCP-PEV") or u.startswith("CDU"):
        return "CDU"
    if u in ("B.E.", "BE"):
        return "BE"
    if u in ("CH", "CHEGA"):
        return "CH"
    if u in ("CDS-PP", "CDS/PP", "CDS"):
        return "CDS-PP"
    if u == "IL":
        return "IL"
    if u in ("L", "LIVRE", "L/TDA"):
        return "L"
    if u == "PAN":
        return "PAN"
    return a


def parse(cur, scale_votes=True):
    """Return (summary dict, results list) from a currentResults / previousResults object."""
    reg = cur.get("subscribedVoters")
    vot = cur.get("totalVoters") if cur.get("totalVoters") is not None else cur.get("numberVoters")
    turn = cur.get("percentageVoters")
    s = dict(registered=reg, voters=vot, turnout=turn, abstention_pct=(round(100 - turn, 2) if turn is not None else None),
             blank=cur.get("blankVotes"), blank_pct=cur.get("blankVotesPercentage"), null_votes=cur.get("nullVotes"),
             null_pct=cur.get("nullVotesPercentage"), mandates=cur.get("totalMandates"))
    res = []
    for p in cur.get("resultsParty") or []:
        a = p.get("acronym")
        if not a:
            continue
        res.append(dict(party=a, family=family(a), votes=p.get("votes"), pct=p.get("percentage"),
                        valid_pct=p.get("validVotesPercentage"), mandates=p.get("mandates")))
    # valid_pct missing (2026 platform): votes / (votes of listed parties)
    tot = sum((r["votes"] or 0) for r in res)
    for r in res:
        if r["valid_pct"] is None and tot and r["votes"] is not None:
            r["valid_pct"] = round(100.0 * r["votes"] / tot, 2)
    return s, res


def store(con, eid, level, code, cur, url):
    if not cur or not cur.get("resultsParty") and cur.get("totalVoters") in (None, 0):
        return False
    s, res = parse(cur)
    con.execute("DELETE FROM summary WHERE election_id=? AND level=? AND code=?", (eid, level, code))
    con.execute("DELETE FROM results WHERE election_id=? AND level=? AND code=?", (eid, level, code))
    con.execute("INSERT INTO summary VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (eid, level, code, s["registered"], s["voters"], s["turnout"], s["abstention_pct"], s["blank"], s["blank_pct"],
                 s["null_votes"], s["null_pct"], s["mandates"], url))
    con.executemany("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [(eid, level, code, r["party"], r["family"], r["votes"], r["pct"], r["valid_pct"], r["mandates"], url) for r in res])
    return True


def ensure_election(con, eid, typ, year, rnd, date, name, scope, note, url):
    con.execute("INSERT OR REPLACE INTO elections (id,type,year,round,date,name,scope,levels,note,source_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (eid, typ, year, rnd, date, name, scope, None, note, url))


def load_municipios(con):
    rows = []
    if AUT.exists():
        a = sqlite3.connect(f"file:{AUT}?mode=ro", uri=True)
        rows = a.execute("SELECT dico, name, district, nif FROM municipios").fetchall()
        a.close()
    ent = {}
    pol = ROOT / "data" / "politica.db"
    if pol.exists():
        p = sqlite3.connect(f"file:{pol}?mode=ro", uri=True, timeout=30)
        for i, nif in p.execute("SELECT id, nif FROM entities WHERE kind='municipio'"):
            ent[nif] = i
        p.close()
    con.execute("DELETE FROM municipios")
    con.executemany("INSERT INTO municipios VALUES (?,?,?,?,?)", [(d, n, di, nif, ent.get(nif)) for d, n, di, nif in rows])
    return rows


def urls(el):
    eid, typ, year, rnd, date, name, site, org, fmt, scope = el

    def res(key):
        if fmt == "legacy":
            return f"{MAI}/{site}/static-data/territory-results/TERRITORY-RESULTS-{key}-{org}.json"
        return f"{MAI}/{site}/assets/static/territory-results/territory-results-{key}-{org}.json"

    def kids(key):
        if fmt == "legacy":
            return f"{MAI}/{site}/static-data/territory-children/TERRITORY-CHILDREN-{key}.json"
        return f"{MAI}/{site}/assets/static/territory-children/territory-children-{key}.json"
    return res, kids


def do_classic(con, el, municipios, dists_cache, noconc):
    eid, typ, year, rnd, date, name, site, org, fmt, scope = el
    res, kids = urls(el)
    rawd = RAW / site
    prev = PREV.get(eid)
    prev_id = prev[0] if prev else None
    if prev:
        ensure_election(con, prev_id, prev[1], prev[2], prev[3], prev[4], prev[5], scope,
                        f"Resultados obtidos do campo previousResults do site {site} (MAI); sem site próprio em JSON.", f"{MAI}/{site}/")
    ensure_election(con, eid, typ, year, rnd, date, name, scope, None, f"{MAI}/{site}/")
    n = 0
    levels = set()

    def put(level, code, key, label, parent):
        nonlocal n
        url = res(key)
        d = fetch(url, rawd / f"{key}-{org}.json")
        if not d:
            return None
        if store(con, eid, level, code, d.get("currentResults"), url):
            levels.add(level)
            n += 1
            con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, level, code, label, parent))
        if prev_id and d.get("previousResults") and store(con, prev_id, level, code, d["previousResults"], url):
            con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (prev_id, level, code, label, parent))
            levels.add("prev:" + level)
        return d
    for t in (eid, prev_id):  # full rebuild of this election
        if t:
            for tb in ("summary", "results", "territories"):
                con.execute(f"DELETE FROM {tb} WHERE election_id=? AND level<>'freguesia'" if tb != "territories" else "DELETE FROM territories WHERE election_id=? AND level<>'freguesia'", (t,))
    root = fetch(kids(scope), rawd / f"children-{scope}.json") or []
    if scope == "LOCAL-500000":
        # GLOBAL-990000 = whole electorate (incl. emigração); LOCAL-500000 = Território Nacional only (no emigrant circles)
        g = put("nacional", GLOBAL, GLOBAL, "Portugal (total, incl. emigração)", None)
        if not g:
            put("nacional", scope, scope, "Território nacional", None)
        put("territorio", scope, scope, "Território nacional (sem emigração)", GLOBAL)
        put("estrangeiro", "FOREIGN-600000", "FOREIGN-600000", "Estrangeiro", GLOBAL)
        for fk, fn in (("FOREIGN-800000", "Europa"), ("FOREIGN-900000", "Fora da Europa")):
            put("distrito", fk, fk, fn, GLOBAL)
    else:
        put("nacional", scope, scope, d_name(scope, name), None)
    # national elections: children of the root are distritos; regional: children are concelhos directly
    if scope == "LOCAL-500000":
        for ch in root:
            put("distrito", ch["territoryKey"], ch["territoryKey"], ch["name"], scope)
        if not noconc:
            for dico, nm, dist, nif in municipios:
                put("concelho", dico, f"LOCAL-{dico}00", nm, f"LOCAL-{dico[:2]}0000")
    else:
        for ch in root:
            dico = ch["territoryKey"].split("-")[1][:4]
            put("concelho", dico, ch["territoryKey"], ch["name"], scope)
    for tbl in (eid, prev_id):
        if tbl:
            lv = sorted({r[0] for r in con.execute("SELECT DISTINCT level FROM summary WHERE election_id=?", (tbl,))})
            con.execute("UPDATE elections SET levels=? WHERE id=?", (",".join(lv), tbl))
    con.commit()
    return n


def d_name(scope, name):
    return {"LOCAL-500000": "Portugal", "LOCAL-300000": "Madeira", "LOCAL-400000": "Açores"}.get(scope, scope)


# ---- 2026 presidential platform -------------------------------------------------------------------------------
def do_new(con, el, municipios, noconc):
    eid, typ, year, rnd, date, name, site, org, fmt, scope = el
    base = f"{MAI}/{site}/assets/static"
    rawd = RAW / site
    es = fetch(f"{MAI}/{site}/app-settings.json", rawd / "app-settings.json")
    electionId = es["electionId"]
    ensure_election(con, eid, typ, year, rnd, date, name, "LOCAL-500000", None, f"{MAI}/{site}/")
    for tb in ("summary", "results", "territories"):
        con.execute(f"DELETE FROM {tb} WHERE election_id=? AND level<>'freguesia'", (eid,))

    def result(tid):
        url = f"{base}/result/territory-electionId={electionId}-territoryId={tid}-organId=3.json"
        d = fetch(url, rawd / f"result-{tid}.json")
        return url, (d or {}).get("data")

    def children(tid):
        d = fetch(f"{base}/territory/children-electionId={electionId}-territoryId={tid}.json", rawd / f"children-{tid}.json")
        return (d or {}).get("data") or []
    n = 0
    # root territory = 'Universo Global' (typeId 10) from election/data
    ed = fetch(f"{base}/election/data-electionId={electionId}.json", rawd / "election-data.json")["data"]
    mt = {t["typeId"]: t for t in ed["mainTerritories"]}
    root, portugal, ext = mt[10]["id"], mt[201]["id"], mt[200]["id"]
    url, d = result(root)
    if d and store(con, eid, "nacional", GLOBAL, d["currentResults"], url):
        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, "nacional", GLOBAL, "Portugal (total)", None))
        n += 1
    url, d = result(ext)
    if d and store(con, eid, "estrangeiro", "ESTRANGEIRO", d["currentResults"], url):
        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, "estrangeiro", "ESTRANGEIRO", "Estrangeiro", GLOBAL))
    byname = {}
    for dico, nm, dist, nif in municipios:
        byname.setdefault(norm(nm), []).append((dico, dist))
    dmap = {"Açores": "Açores", "Madeira": "Madeira"}
    dist_key = {}
    for dnode in children(portugal):
        dn = dnode["descriptionShort"]
        # district LOCAL key by name from legacy children (same 20 keys across all elections)
        key = DISTRICT_KEYS.get(norm(dn))
        if not key:
            print("   ! unknown district", dn)
            continue
        url, d = result(dnode["id"])
        if d and store(con, eid, "distrito", key, d["currentResults"], url):
            con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, "distrito", key, dn, "LOCAL-500000"))
            n += 1
        if noconc:
            continue
        for c in children(dnode["id"]):
            cands = byname.get(norm(c["descriptionShort"]), [])
            if len(cands) > 1:
                cands = [x for x in cands if norm(x[1]) == norm(dn)] or cands
            if len(cands) != 1:
                print("   ! municipio not matched", dn, c["descriptionShort"])
                continue
            dico = cands[0][0]
            url, d = result(c["id"])
            if d and store(con, eid, "concelho", dico, d["currentResults"], url):
                con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, "concelho", dico, c["descriptionShort"], key))
                n += 1
    lv = sorted({r[0] for r in con.execute("SELECT DISTINCT level FROM summary WHERE election_id=?", (eid,))})
    con.execute("UPDATE elections SET levels=? WHERE id=?", (",".join(lv), eid))
    con.commit()
    return n


DISTRICT_KEYS = {}


def reconcile_mandates(con):
    """If a party's national mandates differ from the sum of its district mandates, trust the districts (they sum to the
    assembly size) and record the correction in the election note. Found in QA-3: legislativas 2005 PSD 74 vs 75."""
    fixed = []
    rows = con.execute("""SELECT n.election_id, n.party, n.mandates, d.sm FROM results n
        JOIN (SELECT election_id, party, SUM(mandates) sm FROM results WHERE level='distrito' GROUP BY 1,2) d
          ON d.election_id = n.election_id AND d.party = n.party
        WHERE n.level='nacional' AND n.mandates IS NOT NULL AND d.sm > 0 AND n.mandates != d.sm""").fetchall()
    for eid, party, nat, dist in rows:
        con.execute("UPDATE results SET mandates=? WHERE election_id=? AND level='nacional' AND party=?", (dist, eid, party))
        tot = con.execute("SELECT SUM(mandates) FROM results WHERE election_id=? AND level='nacional'", (eid,)).fetchone()[0]
        con.execute("UPDATE summary SET mandates=? WHERE election_id=? AND level='nacional'", (tot, eid))
        note = f"Mandatos nacionais recalculados a partir da soma dos círculos: {party} {nat} → {dist} (a fonte nacional dava {tot - dist + nat} no total)."
        con.execute("UPDATE elections SET note = COALESCE(note || ' ', '') || ? WHERE id=?", (note, eid))
        fixed.append((eid, party, nat, dist))
    con.commit()
    return fixed


def fkey(name):
    k = norm(name)
    k = re.sub(r"^(uniao das freguesias|uniao de freguesias|junta de freguesia|freguesia)( (de|da|do|das|dos))? ", "", k)
    return re.sub(r"^uf ", "", k)


PARISH_ELECTIONS = [("leg-2025", "leg-2024"), ("pres-2026-2", "pres-2026-1")]


def link_entities(con, municipios):
    """Link parishes to politica.db entities (kind=freguesia): (1) parent municipio + normalised name; (2) unique normalised
    name among entities without parent (older BASE-sourced entities such as 'União das Freguesias de X')."""
    nfr = con.execute("SELECT COUNT(*) FROM freguesias").fetchone()[0]
    pol = ROOT / "data" / "politica.db"
    ent, orphan = {}, {}
    if pol.exists():
        p = sqlite3.connect(f"file:{pol}?mode=ro", uri=True, timeout=30)
        nif2dico = {n: d for d, nm, di, n in municipios}
        for eid, name, mun_nif in p.execute("SELECT f.id, f.name, m.nif FROM entities f JOIN entities m ON m.id=f.parent_id WHERE f.kind='freguesia' AND m.kind='municipio'"):
            d = nif2dico.get(mun_nif)
            if d:
                ent.setdefault((d, fkey(name)), []).append(eid)
        for eid, name in p.execute("SELECT id, name FROM entities WHERE kind='freguesia' AND parent_id IS NULL"):
            orphan.setdefault(fkey(name), []).append(eid)
        p.close()
    con.execute("UPDATE freguesias SET entity_id=NULL, match_method=NULL")
    stat = {"name+municipio": 0, "unique_name": 0, "none": 0}
    rest = []
    for code, dico, name, key in con.execute("SELECT code, dico, name, name_key FROM freguesias").fetchall():
        hit = ent.get((dico, key))
        if hit and len(hit) == 1:
            con.execute("UPDATE freguesias SET entity_id=?, match_method='name+municipio' WHERE code=?", (hit[0], code)); stat["name+municipio"] += 1
        else:
            rest.append((code, key))
    used = {r[0] for r in con.execute("SELECT entity_id FROM freguesias WHERE entity_id IS NOT NULL")}
    keycount = {}
    for code, key in rest:
        keycount[key] = keycount.get(key, 0) + 1
    for code, key in rest:
        cand = [e for e in orphan.get(key, []) if e not in used]
        if len(cand) == 1 and keycount[key] == 1:
            con.execute("UPDATE freguesias SET entity_id=?, match_method='unique_name' WHERE code=?", (cand[0], code)); used.add(cand[0]); stat["unique_name"] += 1
        else:
            stat["none"] += 1
    con.commit()
    print("  freguesia -> entities:", stat, f"of {nfr}")
    return stat


def do_freguesias(con, municipios):
    """Parish-level results: legislativas 2025 (+2024 via previousResults) and presidenciais 2026 round 2 (+round 1)."""
    only = os.environ.get("ELEICOES_ONLY", "")
    if "freguesias" in only:
        only = ""
    # ---- parish list (MAI LOCAL keys) from legislativas2025 children of each concelho
    site = "legislativas2025"
    kids = lambda dico: fetch(f"{MAI}/{site}/assets/static/territory-children/territory-children-LOCAL-{dico}00.json", RAW / site / f"children-LOCAL-{dico}00.json") or []
    con.execute("DELETE FROM freguesias")
    nfr = 0
    for dico, nm, dist, nif in municipios:
        for ch in kids(dico):
            code = ch["territoryKey"].split("-")[1]
            con.execute("INSERT OR REPLACE INTO freguesias (code, dico, name, name_key) VALUES (?,?,?,?)", (code, dico, ch["name"], fkey(ch["name"])))
            nfr += 1
    con.commit()
    print(f"  freguesias listed: {nfr}")
    link_entities(con, municipios)
    # ---- legislativas 2025
    for eid, prev in PARISH_ELECTIONS:
        if only and eid not in only:
            continue
        for t in (eid, prev):
            for tb in ("summary", "results", "territories"):
                con.execute(f"DELETE FROM {tb} WHERE election_id=? AND level='freguesia'", (t,))
    n = 0
    if not only or "leg-2025" in only:
        res, _ = urls(EL[0])
        for code, dico, name, key in con.execute("SELECT code, dico, name, name_key FROM freguesias").fetchall():
            k = f"LOCAL-{code}"
            url = res(k)
            d = fetch(url, RAW / site / f"{k}-AR.json")
            if not d:
                continue
            if store(con, "leg-2025", "freguesia", code, d.get("currentResults"), url):
                con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", ("leg-2025", "freguesia", code, name, dico)); n += 1
            if d.get("previousResults") and store(con, "leg-2024", "freguesia", code, d["previousResults"], url):
                con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", ("leg-2024", "freguesia", code, name, dico))
            if n % 25 == 0:
                con.commit()
        con.commit()
        print(f"  leg-2025 freguesias: {n}")
    # ---- presidenciais 2026 (2.ª volta + 1.ª via previousResults)
    if not only or "pres-2026-2" in only:
        site2 = "presidenciais2026_2S"
        base = f"{MAI}/{site2}/assets/static"
        rawd = RAW / site2
        electionId = fetch(f"{MAI}/{site2}/app-settings.json", rawd / "app-settings.json")["electionId"]
        ed = fetch(f"{base}/election/data-electionId={electionId}.json", rawd / "election-data.json")["data"]
        portugal = {t["typeId"]: t for t in ed["mainTerritories"]}[201]["id"]
        children = lambda tid: (fetch(f"{base}/territory/children-electionId={electionId}-territoryId={tid}.json", rawd / f"children-{tid}.json") or {}).get("data") or []
        byname = {}
        for code, dico, name, key in con.execute("SELECT code, dico, name, name_key FROM freguesias").fetchall():
            byname.setdefault((dico, key), []).append((code, name))
        mun_by = {}
        for dico, nm, dist, nif in municipios:
            mun_by.setdefault(norm(nm), []).append((dico, dist))
        m = miss = 0
        for dnode in children(portugal):
            for c in children(dnode["id"]):
                cands = mun_by.get(norm(c["descriptionShort"]), [])
                if len(cands) > 1:
                    cands = [x for x in cands if norm(x[1]) == norm(dnode["descriptionShort"])] or cands
                if len(cands) != 1:
                    continue
                dico = cands[0][0]
                fl = children(c["id"])
                free = {code: name for (dk, key), lst in byname.items() if dk == dico for code, name in lst}
                pair = {}
                for f in fl:  # 1) exact normalised name
                    h = byname.get((dico, fkey(f["descriptionShort"])))
                    if h and len(h) == 1 and h[0][0] in free:
                        pair[f["id"]] = h[0]; free.pop(h[0][0])
                left = [f for f in fl if f["id"] not in pair]
                import difflib
                for f in left:  # 2) closest remaining name of the same concelho (UF names written differently, e.g. S.João)
                    fk_ = re.sub(r"\bs\b", "sao", fkey(f["descriptionShort"]).replace("s ", "sao ", 1) if fkey(f["descriptionShort"]).startswith("s ") else fkey(f["descriptionShort"]))
                    best = max(free.items(), key=lambda kv: difflib.SequenceMatcher(None, fk_, fkey(kv[1])).ratio(), default=None)
                    if best and (difflib.SequenceMatcher(None, fk_, fkey(best[1])).ratio() >= 0.92):
                        pair[f["id"]] = (best[0], best[1]); free.pop(best[0])
                for f in fl:
                    hit = [pair[f["id"]]] if f["id"] in pair else None
                    if not hit:
                        miss += 1
                        continue
                    code, name = hit[0]
                    url = f"{base}/result/territory-electionId={electionId}-territoryId={f['id']}-organId=3.json"
                    d = fetch(url, rawd / f"result-{f['id']}.json")
                    d = (d or {}).get("data")
                    if not d:
                        continue
                    if store(con, "pres-2026-2", "freguesia", code, d["currentResults"], url):
                        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", ("pres-2026-2", "freguesia", code, name, dico)); m += 1
                    if d.get("previousResults") and store(con, "pres-2026-1", "freguesia", code, d["previousResults"], url):
                        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", ("pres-2026-1", "freguesia", code, name, dico))
                    if m % 25 == 0:
                        con.commit()
        con.commit()
        print(f"  pres-2026 freguesias: {m} (name not matched: {miss})")
    for t in ("leg-2025", "leg-2024", "pres-2026-2", "pres-2026-1"):
        lv = sorted({r[0] for r in con.execute("SELECT DISTINCT level FROM summary WHERE election_id=?", (t,))})
        con.execute("UPDATE elections SET levels=? WHERE id=?", (",".join(lv), t))
    con.commit()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")  # readers (the portal server) must not be blocked by the long ingest
    con.executescript(SCHEMA)
    mun = load_municipios(con)
    print(f"  municipios from autarquias.db: {len(mun)}")
    root = fetch(f"{MAI}/legislativas2025/assets/static/territory-children/territory-children-LOCAL-500000.json",
                 RAW / "legislativas2025" / "children-LOCAL-500000.json") or []
    for ch in root:
        DISTRICT_KEYS[norm(ch["name"])] = ch["territoryKey"]
        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", ("*", "distrito", ch["territoryKey"], ch["name"], "LOCAL-500000"))
    only = set(filter(None, os.environ.get("ELEICOES_ONLY", "").split(",")))
    noconc = bool(os.environ.get("ELEICOES_NOCONC"))
    for el in EL:
        if only and el[0] not in only:
            continue
        t0 = time.time()
        try:
            n = do_new(con, el, mun, noconc) if el[8] == "new" else do_classic(con, el, mun, None, noconc)
        except Exception as e:
            print(f"  ! {el[0]} failed: {e!r}")
            continue
        print(f"  {el[0]}: {n} territories ({time.time()-t0:.0f}s)")
    if "linkfreg" in only:
        link_entities(con, mun)
        return
    if not os.environ.get("ELEICOES_NOFREG") and (not only or "freguesias" in only or {"leg-2025", "pres-2026-2"} & only):
        do_freguesias(con, mun)
    if not only:
        wiki_fetch()
        print(f"  wiki (1975-2004, referendos): {do_wiki(con)} elections")
    for fx in reconcile_mandates(con):
        print("  reconciled national mandates:", fx)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', datetime('now'))")
    con.commit()
    for t in ("elections", "summary", "results", "municipios"):
        print(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    con.close()


if __name__ == "__main__":
    main()


# ---- Older elections (1975-2004, referendums): national totals transcribed from English Wikipedia (last resort) ----------
WIKI = [  # (id, type, year, round, date, name, wikipedia page)
    ("leg-1975", "legislativas", 1975, 1, "1975-04-25", "Assembleia Constituinte 1975", "1975 Portuguese Constituent Assembly election"),
    ("leg-1976", "legislativas", 1976, 1, "1976-04-25", "Legislativas 1976", "1976 Portuguese legislative election"),
    ("leg-1979", "legislativas", 1979, 1, "1979-12-02", "Legislativas 1979", "1979 Portuguese legislative election"),
    ("leg-1980", "legislativas", 1980, 1, "1980-10-05", "Legislativas 1980", "1980 Portuguese legislative election"),
    ("leg-1983", "legislativas", 1983, 1, "1983-04-25", "Legislativas 1983", "1983 Portuguese legislative election"),
    ("leg-1985", "legislativas", 1985, 1, "1985-10-06", "Legislativas 1985", "1985 Portuguese legislative election"),
    ("leg-1987", "legislativas", 1987, 1, "1987-07-19", "Legislativas 1987", "1987 Portuguese legislative election"),
    ("leg-1991", "legislativas", 1991, 1, "1991-10-06", "Legislativas 1991", "1991 Portuguese legislative election"),
    ("leg-1995", "legislativas", 1995, 1, "1995-10-01", "Legislativas 1995", "1995 Portuguese legislative election"),
    ("leg-1999", "legislativas", 1999, 1, "1999-10-10", "Legislativas 1999", "1999 Portuguese legislative election"),
    ("leg-2002", "legislativas", 2002, 1, "2002-03-17", "Legislativas 2002", "2002 Portuguese legislative election"),
    ("pres-1976", "presidenciais", 1976, 1, "1976-06-27", "Presidenciais 1976", "1976 Portuguese presidential election"),
    ("pres-1980", "presidenciais", 1980, 1, "1980-12-07", "Presidenciais 1980", "1980 Portuguese presidential election"),
    ("pres-1986-1", "presidenciais", 1986, 1, "1986-01-26", "Presidenciais 1986 (1.ª volta)", "1986 Portuguese presidential election"),
    ("pres-1986-2", "presidenciais", 1986, 2, "1986-02-16", "Presidenciais 1986 (2.ª volta)", "1986 Portuguese presidential election"),
    ("pres-1991", "presidenciais", 1991, 1, "1991-01-13", "Presidenciais 1991", "1991 Portuguese presidential election"),
    ("pres-1996", "presidenciais", 1996, 1, "1996-01-14", "Presidenciais 1996", "1996 Portuguese presidential election"),
    ("pres-2001", "presidenciais", 2001, 1, "2001-01-14", "Presidenciais 2001", "2001 Portuguese presidential election"),
    ("eur-1987", "europeias", 1987, 1, "1987-07-19", "Europeias 1987", "1987 European Parliament election in Portugal"),
    ("eur-1989", "europeias", 1989, 1, "1989-06-18", "Europeias 1989", "1989 European Parliament election in Portugal"),
    ("eur-1994", "europeias", 1994, 1, "1994-06-12", "Europeias 1994", "1994 European Parliament election in Portugal"),
    ("eur-1999", "europeias", 1999, 1, "1999-06-13", "Europeias 1999", "1999 European Parliament election in Portugal"),
    ("eur-2004", "europeias", 2004, 1, "2004-06-13", "Europeias 2004", "2004 European Parliament election in Portugal"),
    ("ref-1998-ivg", "referendos", 1998, 1, "1998-06-28", "Referendo da interrupção voluntária da gravidez 1998", "1998 Portuguese abortion referendum"),
    ("ref-1998-reg", "referendos", 1998, 1, "1998-11-08", "Referendo da regionalização 1998", "1998 Portuguese regionalisation referendum"),
    ("ref-2007-ivg", "referendos", 2007, 1, "2007-02-11", "Referendo da interrupção voluntária da gravidez 2007", "2007 Portuguese abortion referendum"),
]
PT_NAMES = {  # English Wikipedia name -> acronym used by MAI; anything else is stored as published
    "Social Democratic Party": "PPD/PSD", "Socialist Party": "PS", "Communist Party of Portugal": "PCP", "Unitary Democratic Coalition": "CDU", "Democratic Unity Coalition": "CDU",
    "Portuguese Communist Party": "PCP", "Democratic and Social Centre": "CDS", "Democratic and Social Centre – People's Party": "CDS-PP",
    "CDS – People's Party": "CDS-PP", "People's Party": "CDS-PP", "Left Bloc": "B.E.", "Democratic Renewal Party": "PRD",
    "Democratic Alliance": "AD", "Democratic Alliance (PPD/PSD–CDS–PPM)": "AD", "Popular Democratic Union": "UDP", "Portuguese Democratic Movement": "MDP/CDE",
    "People's Monarchist Party": "PPM", "Democratic Party of the Atlantic": "PDA", "Ecologist Party \"The Greens\"": "PEV", "Ecologist Party The Greens": "PEV",
    "Socialist Party (PS)": "PS", "Social Democratic Centre Party": "CDS", "Union of the Left for Democratic Socialism": "FSP/UEDS/ASDI",
    "Democratic Alliance (PSD–CDS–PPM)": "AD", "Republican and Socialist Front": "FRS", "Popular Unity Front": "FUP", "Workers' Party of Socialist Unity": "POUS",
    "Party of Democratic Renewal": "PRD", "National Solidarity Party": "PSN", "Portuguese Workers' Communist Party": "PCTP/MRPP",
    "Workers' Communist Party": "PCTP/MRPP", "Revolutionary Socialist Party": "PSR", "Christian Democratic Party": "PDC",
    "Democratic People's Party": "PPD", "United People Alliance": "APU", "Forward Portugal": "PPD/PSD.CDS-PP", "Democratic Unity Coalition (PCP-PEV)": "CDU",
}


def _num(s):
    s = (s or "").replace(" ", "").replace("\xa0", "").replace(",", "").replace("%", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _wiki_tables(h):
    import html as _h
    for m in re.finditer(r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>(.*?)</table>', h, re.S):
        rows = []
        for r in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S):
            cells = []
            for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S):
                c = re.sub(r"<sup[^>]*>.*?</sup>", "", c, flags=re.S)
                c = re.sub(r"<[^>]+>", " ", c)
                cells.append(re.sub(r"\s+", " ", _h.unescape(c)).strip())
            rows.append([c for c in cells if c != ""])
        yield rows


def parse_wiki(h, kind, rnd):
    """Return (summary, results) for the national results table of a Wikipedia election page, or None."""
    for rows in _wiki_tables(h):
        flat = " ".join(" ".join(r) for r in rows)
        if "Registered voters" not in flat:
            continue
        res, summ = [], {}
        col = 0 if rnd == 1 else 1  # presidential 2nd round = second pair of columns
        for r in rows:
            if not r:
                continue
            lab = r[0]
            nums = [_num(x) for x in r[1:]]
            if lab in ("Total",):
                continue
            if lab in ("Valid votes", "Invalid votes", "Blank votes", "Invalid or blank votes", "Invalid/blank votes", "Total votes", "Registered voters/turnout", "Registered voters / turnout"):
                n = [x for x in nums if x is not None]
                if kind == "presidenciais" and len(n) >= 4:
                    n = n[2 * col: 2 * col + 2]
                summ[lab] = n
                continue
            # party / candidate row
            texts = [x for x in r if _num(x) is None and x not in ("–", "-", "New", "—")]
            ns = [_num(x) for x in r if _num(x) is not None and not re.match(r"^[+–-]", x) and True]
            if not texts or len(ns) < 2:
                continue
            if kind == "presidenciais":
                name = re.sub(r"\s*\[ ?\w+ ?\]", "", texts[0]).strip()
                v = ns[2 * col: 2 * col + 2]
                if len(v) < 2:
                    continue
                res.append(dict(party=name, votes=int(v[0]), pct=v[1], mandates=None, extra=texts[1] if len(texts) > 1 else None))
            elif kind == "referendos":
                res.append(dict(party={"Yes": "Sim", "No": "Não", "For": "Sim", "Against": "Não"}.get(texts[0], texts[0]), votes=int(ns[0]), pct=ns[1], mandates=None))
            else:
                # Party | Votes | % | +/- | Seats | +/- ; "+/-" cells may be dropped when they start with sign -> ns = votes, %, seats?, ...
                seats = None
                signed = [x for x in r[1:] if _num(x) is not None and re.match(r"^[+–-]", x)]
                plain = [_num(x) for x in r[1:] if _num(x) is not None and not re.match(r"^[+–-]", x)]
                votes, pct = int(plain[0]), plain[1]
                if len(plain) >= 3:
                    seats = int(plain[2])
                res.append(dict(party=PT_NAMES.get(texts[0], texts[0]), votes=votes, pct=pct, mandates=seats, extra=texts[0]))
        if not res or "Total votes" not in summ and "Registered voters/turnout" not in summ:
            continue
        def g(k, i):
            v = summ.get(k)
            return v[i] if v and len(v) > i else None
        reg = g("Registered voters/turnout", 0) or g("Registered voters / turnout", 0)
        turn = g("Registered voters/turnout", 1) or g("Registered voters / turnout", 1)
        s = dict(registered=int(reg) if reg else None, voters=int(g("Total votes", 0)) if g("Total votes", 0) else None, turnout=turn,
                 blank=int(g("Blank votes", 0)) if g("Blank votes", 0) else None, blank_pct=g("Blank votes", 1),
                 null_votes=int(g("Invalid votes", 0)) if g("Invalid votes", 0) else None, null_pct=g("Invalid votes", 1))
        if s["null_votes"] is None and g("Invalid or blank votes", 0):
            s["null_votes"] = None  # combined invalid+blank is not split
        return s, res
    return None


def do_wiki(con):
    import urllib.parse
    out = 0
    for eid, typ, year, rnd, date, name, page in WIKI:
        cache = RAW / "wiki" / (page.replace(" ", "_") + ".html")
        if not cache.exists():
            continue  # fetched by wiki_fetch()
        h = cache.read_text()
        r = parse_wiki(h, typ, rnd)
        if not r:
            print(f"  ! wiki {eid}: table not parsed")
            continue
        s, res = r
        url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(page.replace(" ", "_"))
        seats = sum(x["mandates"] or 0 for x in res)
        tv = sum(x["votes"] for x in res)
        # integrity checks: parties' votes should be <= voters and, for legislativas, seats plausible
        ok = (s["voters"] is None or tv <= s["voters"] * 1.001) and (typ != "legislativas" or 225 <= seats <= 265)
        if not ok:
            print(f"  ! wiki {eid}: sanity check failed (votes {tv}, voters {s['voters']}, seats {seats}) - skipped")
            continue
        s["abstention_pct"] = round(100 - s["turnout"], 2) if s["turnout"] is not None else None
        s["mandates"] = seats or None
        ensure_election(con, eid, typ, year, rnd, date, name, "LOCAL-500000",
                        "Só totais nacionais, transcritos da Wikipedia (fonte original: CNE/STAPE) — sem resultados por território.", url)
        con.execute("DELETE FROM summary WHERE election_id=?", (eid,))
        con.execute("DELETE FROM results WHERE election_id=?", (eid,))
        con.execute("INSERT INTO summary VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (eid, "nacional", GLOBAL, s["registered"], s["voters"], s["turnout"], s["abstention_pct"], s["blank"], s["blank_pct"],
                     s["null_votes"], s["null_pct"], s["mandates"], url))
        con.executemany("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?)",
                        [(eid, "nacional", GLOBAL, x["party"], family(x["party"]), x["votes"], x["pct"],
                          round(100.0 * x["votes"] / tv, 2) if tv else None, x["mandates"], url) for x in res])
        con.execute("INSERT OR REPLACE INTO territories VALUES (?,?,?,?,?)", (eid, "nacional", GLOBAL, "Portugal", None))
        con.execute("UPDATE elections SET levels='nacional' WHERE id=?", (eid,))
        out += 1
    con.commit()
    return out


def wiki_fetch():
    import urllib.parse
    (RAW / "wiki").mkdir(parents=True, exist_ok=True)
    for eid, typ, year, rnd, date, name, page in WIKI:
        fn = RAW / "wiki" / (page.replace(" ", "_") + ".html")
        if fn.exists():
            continue
        u = "https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=text&redirects=1&page=" + urllib.parse.quote(page)
        w = 1.2 - (time.time() - _last[0])
        if w > 0:
            time.sleep(w)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "politica-pt/0.1 (personal civic project; contact@example.org)"})
            fn.write_text(json.loads(urllib.request.urlopen(req, timeout=40).read())["parse"]["text"]["*"])
        except Exception as e:
            print("  ! wiki fetch", page, e)
