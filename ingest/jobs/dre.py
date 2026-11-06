"""Diário da República (série I) — acts, issuers, amendment lineage and consolidated-law timelines.

Source: diariodarepublica.pt (INCM). The site is an OutSystems SPA; plain GETs only return a 2 KB shell.
Its data comes from public "screen service" endpoints (POST JSON, anonymous CSRF token shipped in the
public runtime /dr/scripts/OutSystems.js). We discover the module version + each action's apiVersion
from the public JS bundles at run time, so a DRE redeploy does not silently break the job.

Endpoints used (all anonymous, the same calls the public website makes):
  * Home/WB_Serie1_List/DataActionGetDataAndApplicationSettings      -> série I acts published on a day
  * Legislacao_Conteudos/Conteudo_Detalhe/DataActionGetAllConteudoDetalheData -> act detail (text, ELI, PDF, proposer)
  * Common/WB_LeftMenuForGeneralDetailScreens/DataActionGetAllLeftMenuData   -> consolidated id, rectifications, flags
  * LegislacaoConsolidada/LegCons_Detalhe/DataActionGetDiplomaFragByIdAndApplicationSetting -> consolidated version (ELI date)
  * LegislacaoConsolidada/AlteracoesTimelineByDiplomaLegisId/DataActionGetConsolidacaoByDiplomaFrag
        -> every amending act of a consolidated law, with the articles each one changed
Blocked for anonymous users: "Análise Jurídica" associations (altera / alterado por / revoga lists; only the
"Atos de Aplicação" type is returned) and the "Parlamento" tab (DRE->parlamento.pt web service, HTTP 504).

Env knobs: DRE_START (default 2024-01-01), DRE_DETAIL_MAX, DRE_TARGET_MAX (request budgets), DRE_SLEEP (s).
"""
import html
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from difflib import SequenceMatcher

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA, connect_writer  # noqa: E402
from since import cutoff, report, since_days  # noqa: E402
import linking  # noqa: E402

NAME = "dre"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
BASE = "https://diariodarepublica.pt"
CSRF = "T6C+9iB49TLra4jEsMeSckDMNhQ="  # OutSystems AnonymousCSRFToken (public constant in /dr/scripts/OutSystems.js)
SLEEP = float(os.environ.get("DRE_SLEEP", "1.0"))
START = os.environ.get("DRE_START", "2024-01-01")
DETAIL_MAX = int(os.environ.get("DRE_DETAIL_MAX", "4000"))
TARGET_MAX = int(os.environ.get("DRE_TARGET_MAX", "800"))
SINCE = since_days()
if SINCE:
    DETAIL_MAX = min(DETAIL_MAX, 300)
    TARGET_MAX = min(TARGET_MAX, 150)

# screen -> (bundle, [(action, viewName)])  — viewName must be a *screen* (blocks fail "No role validation found")
ACTIONS = {
    "day": ("dr.Home.WB_Serie1_List", "DataActionGetDataAndApplicationSettings", "screenservices/dr/Home/WB_Serie1_List/", "Home.home"),
    "detail": ("dr.Legislacao_Conteudos.Conteudo_Detalhe", "DataActionGetAllConteudoDetalheData", "screenservices/dr/Legislacao_Conteudos/Conteudo_Detalhe/", "Legislacao_Conteudos.Conteudo_Detalhe"),
    "menu": ("dr.Common.WB_LeftMenuForGeneralDetailScreens", "DataActionGetAllLeftMenuData", "screenservices/dr/Common/WB_LeftMenuForGeneralDetailScreens/", "Legislacao_Conteudos.Conteudo_Detalhe"),
    "cons": ("dr.LegislacaoConsolidada.LegCons_Detalhe", "DataActionGetDiplomaFragByIdAndApplicationSetting", "screenservices/dr/LegislacaoConsolidada/LegCons_Detalhe/", "LegislacaoConsolidada.LegCons_Detalhe"),
    "timeline": ("dr.LegislacaoConsolidada.AlteracoesTimelineByDiplomaLegisId", "DataActionGetConsolidacaoByDiplomaFrag", "screenservices/dr/LegislacaoConsolidada/AlteracoesTimelineByDiplomaLegisId/", "LegislacaoConsolidada.LegCons_Detalhe"),
}
# acts whose detail (text, proposer, ELI, signatories) we fetch, in priority order
DETAIL_TYPES = ["Lei Constitucional", "Lei Orgânica", "Lei", "Decreto-Lei", "Decreto Regulamentar", "Decreto Legislativo Regional",
                "Resolução do Conselho de Ministros", "Decreto do Presidente da República", "Decreto", "Portaria", "Declaração de Retificação"]
# date -> government / legislature (pt.wikipedia.org "Governos constitucionais" / "Legislaturas")
GOVERNMENTS = [("2019-10-26", "XXII Governo Constitucional (António Costa)"), ("2022-03-30", "XXIII Governo Constitucional (António Costa)"),
               ("2024-04-02", "XXIV Governo Constitucional (Luís Montenegro)"), ("2025-06-05", "XXV Governo Constitucional (Luís Montenegro)")]
LEGISLATURES = [("2019-10-25", "XIV"), ("2022-03-29", "XV"), ("2024-03-26", "XVI"), ("2025-06-03", "XVII")]
GOV_ISSUERS_EXCLUDE = re.compile(r"Assembleia|Região Autónoma|Tribunal|Presidência da República|Supremo|Provedor|Comissão Nacional de Eleições|Banco de Portugal", re.I)

SCHEMA = """
CREATE TABLE IF NOT EXISTS acts (
  id TEXT PRIMARY KEY,            -- DRE content id (DiplomaLegisId)
  kind TEXT, number TEXT, year INTEGER, date TEXT, title TEXT, issuer TEXT, proponent TEXT,
  summary TEXT, summary_html TEXT, vigencia TEXT, eli TEXT, pdf_url TEXT, dr_title TEXT, dr_url TEXT,
  url TEXT, in_window INTEGER DEFAULT 1, detail_at TEXT, text TEXT,
  approved TEXT, promulgated TEXT, signatories TEXT, government TEXT, legislature TEXT,
  frag_id TEXT, has_consolidated INTEGER, has_parliament INTEGER, menu_at TEXT,
  cons_eli TEXT, cons_title TEXT, cons_url TEXT, cons_at TEXT, n_amendments INTEGER,
  republishes INTEGER DEFAULT 0, source_url TEXT
);
CREATE INDEX IF NOT EXISTS acts_date ON acts(date);
CREATE INDEX IF NOT EXISTS acts_kind ON acts(kind, date);
CREATE INDEX IF NOT EXISTS acts_issuer ON acts(issuer, date);
CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, n INTEGER, diarios TEXT, fetched_at TEXT, source_url TEXT);
-- directed relations between acts: src <relation> dst (e.g. DL 202/2026 altera DL 40-A/2026)
CREATE TABLE IF NOT EXISTS links (
  src_id TEXT, dst_id TEXT, relation TEXT, dst_label TEXT, origin TEXT, source_url TEXT,
  UNIQUE(src_id, dst_id, relation, origin)
);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_id);
-- official consolidated-law timeline: target act amended by amending act (articles in changes_json)
CREATE TABLE IF NOT EXISTS amendments (
  target_id TEXT, amending_id TEXT, amending_kind TEXT, amending_number TEXT, amending_title TEXT, date TEXT,
  summary TEXT, n_changes INTEGER, changes_json TEXT, url TEXT, source_url TEXT,
  UNIQUE(target_id, amending_id)
);
CREATE INDEX IF NOT EXISTS amend_amending ON amendments(amending_id);
CREATE TABLE IF NOT EXISTS rectifications (act_id TEXT, rect_id TEXT, label TEXT, url TEXT, source_url TEXT, UNIQUE(act_id, rect_id));
CREATE TABLE IF NOT EXISTS act_initiatives (act_id TEXT, initiative_key TEXT, method TEXT, score REAL, evidence TEXT, UNIQUE(act_id, initiative_key));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

_last = [0.0]
_ver = {}


def log(*a):
    print("[dre]", *a, flush=True)


def _http(url, data=None, headers=None, timeout=90):
    wait = SLEEP - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    h = {"User-Agent": UA, "Accept": "application/json, text/javascript, */*"}
    h.update(headers or {})
    for attempt in range(4):
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1)); continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < 3:
                time.sleep(5 * (attempt + 1)); continue
            raise


def discover():
    """moduleVersion + apiVersion per action, read from the public JS bundles (same as the browser)."""
    mi = json.loads(_http(BASE + "/dr/moduleservices/moduleinfo"))["manifest"]
    _ver["module"] = mi["versionToken"]
    for key, (bundle, action, prefix, view) in ACTIONS.items():
        path = f"/dr/scripts/{bundle}.mvc.js"
        js = _http(BASE + path + mi["urlVersions"].get(path, "")).decode("utf-8", "replace")
        m = re.search(r'callDataAction\("%s", "[^"]+", "([^"]+)", "([^"]+)"' % action, js)
        if not m:
            raise RuntimeError(f"DRE: action {action} not found in {bundle} (site redesigned?)")
        _ver[key] = (m.group(1), m.group(2), view)
    log("module version", _ver["module"])


def call(key, variables):
    url_path, api, view = _ver[key]
    body = {"versionInfo": {"moduleVersion": _ver["module"], "apiVersion": api}, "viewName": view, "screenData": {"variables": variables}}
    raw = _http(f"{BASE}/dr/{url_path}", data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json; charset=UTF-8", "X-CSRFToken": CSRF, "Origin": BASE, "Referer": BASE + "/dr/home"})
    d = json.loads(raw)
    if d.get("exception"):
        raise RuntimeError(f"{key}: {d['exception'].get('message')}")
    if d.get("versionInfo", {}).get("hasApiVersionChanged"):
        log("warning: apiVersion changed for", key)
    return d.get("data") or {}


# ---------------------------------------------------------------- parsing helpers
def strip_html(s):
    s = re.sub(r"<br\s*/?>|</p>", "\n", s or "")
    return re.sub(r"[ \t]+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def period(d, table):
    out = None
    for start, label in table:
        if d and d >= start:
            out = label
    return out


HREF = re.compile(r"""<a\b[^>]*href=["']([^"']*/dr/detalhe/([a-z0-9-]+)/([a-z0-9-]+?)-(\d+))["'][^>]*>(.*?)</a>""", re.I | re.S)
VERBS = [  # nearest preceding verb wins (searched backwards in the sumário text)
    ("revoga", r"revog"), ("republica", r"republica"), ("retifica", r"retific|rectific"), ("regulamenta", r"regulament"),
    ("prorroga", r"prorrog"), ("suspende", r"suspend"), ("altera", r"\baltera|alteração|\badita|aditamento|modifica"),
    ("declara_inconstitucional", r"inconstitucional|ilegalidade"), ("aprova", r"\baprova\b"), ("autoriza", r"autoriz"), ("interpreta", r"interpreta"), ("executa", r"\bexecu"),
]


def relations_from_summary(sh):
    out = []
    for m in HREF.finditer(sh or ""):
        before = norm(strip_html(sh[: m.start()]))[-400:]
        rel, best = "refere", -1
        for name, rx in VERBS:
            for vm in re.finditer(rx, before):
                if vm.start() > best:
                    rel, best = name, vm.start()
        out.append({"dst": m.group(4), "slug": m.group(2), "label": strip_html(m.group(5)), "href": m.group(1), "rel": rel})
    return out


SIGN_GOV = re.compile(r"Visto e aprovado em Conselho de Ministros,? (?:de|em) (\d{1,2}\.?º? de \w+ de \d{4})\.?\s*-?\s*(.+?)(?:\n|Promulgado|$)", re.S)
APPROVED_AR = re.compile(r"Aprovad[ao] em (\d{1,2}\.?º? de \w+ de \d{4})")
PROMUL = re.compile(r"Promulgad[ao] em (\d{1,2}\.?º? de \w+ de \d{4})")
MONTHS = {m: i for i, m in enumerate(["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"], 1)}


def pt_date(s):
    m = re.match(r"(\d{1,2})\.?º? de (\w+) de (\d{4})", s or "")
    if not m:
        return None
    mo = MONTHS.get(norm(m.group(2)))
    return f"{m.group(3)}-{mo:02d}-{int(m.group(1)):02d}" if mo else None


def signatures(text):
    t = text or ""
    approved = promulgated = None
    signers = []
    m = SIGN_GOV.search(t)
    if m:
        approved = pt_date(m.group(1))
        signers = [s.strip(" .") for s in re.split(r"\s+-\s+", m.group(2)) if 3 < len(s.strip(" .")) < 80]
    else:
        m = APPROVED_AR.search(t)
        if m:
            approved = pt_date(m.group(1))
            pm = re.search(r"O Presidente da Assembleia da República,\s*([^.\n]+)", t[m.end(): m.end() + 300])
            if pm:
                signers = [pm.group(1).strip()]
    m = PROMUL.search(t)
    if m:
        promulgated = pt_date(m.group(1))
        pr = re.search(r"O Presidente da República,\s*([^.\n]+)", t[m.end(): m.end() + 300])
        if pr:
            signers.append(pr.group(1).strip() + " (Presidente da República)")
    return approved, promulgated, signers


# ---------------------------------------------------------------- phases
def phase_days(con):
    today = date.today()
    d0 = today - timedelta(days=SINCE) if SINCE else date.fromisoformat(START)
    have = {r[0]: r[1] for r in con.execute("SELECT date, fetched_at FROM days")}
    todo = []
    d = today
    while d >= d0:
        k = d.isoformat()
        # re-fetch the last 10 days (supplements appear late); older days once
        if SINCE or k not in have or (today - d).days <= 10 and (have[k] or "") < (d + timedelta(days=11)).isoformat():
            todo.append(k)
        d -= timedelta(days=1)
    log(f"days to fetch: {len(todo)} (window {START}..{today})")
    for i, k in enumerate(todo):
        src = f"{BASE}/dr/home?date={k}"
        try:
            data = call("day", {"DataSelecionada": k, "IsSumarioCompleto": False, "IsPageTracked": True})
        except Exception as e:
            log("day failed", k, e); continue
        diarios, n = [], 0
        for dr in (data.get("DiarioByDiaList") or {}).get("List", []):
            diarios.append(dr.get("Title"))
            dr_url = f"{BASE}/dr/detalhe/diario-republica/{dr.get('Numero')}-{k[:4]}-{dr.get('DiarioRepublicaId')}"
            for a in (dr.get("DiplomaLegiList") or {}).get("List", []):
                aid = a.get("DbId")
                if not aid or aid == "0":
                    continue
                n += 1
                num = (a.get("Numero") or "").strip()
                url = BASE + a["LinkSitemap"] if a.get("LinkSitemap") else None
                sh = a.get("Sumario") or ""
                con.execute("""INSERT INTO acts (id, kind, number, year, date, title, issuer, summary, summary_html, dr_title, dr_url, url, in_window, source_url)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
                  ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, number=excluded.number, year=excluded.year, date=excluded.date, title=excluded.title,
                    issuer=excluded.issuer, summary=excluded.summary, summary_html=excluded.summary_html, dr_title=excluded.dr_title,
                    dr_url=excluded.dr_url, url=excluded.url, in_window=1, source_url=excluded.source_url""",
                            (aid, a.get("Tipo"), num, int(k[:4]), a.get("DataPublicacao") or k, (a.get("ConteudoTitle") or "").strip(),
                             a.get("Emissor"), strip_html(sh), sh, dr.get("Title"), dr_url, url, url or src))
                con.execute("UPDATE acts SET republishes = ? WHERE id = ?", (1 if re.search(r"republica", norm(strip_html(sh))) else 0, aid))
                con.execute("DELETE FROM links WHERE src_id = ? AND origin = 'sumario'", (aid,))
                for r in relations_from_summary(sh):
                    if r["dst"] == aid:
                        continue
                    con.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?, 'sumario', ?)", (aid, r["dst"], r["rel"], r["label"], url))
                    con.execute("""INSERT OR IGNORE INTO acts (id, kind, number, title, url, in_window, source_url)
                                   VALUES (?,?,?,?,?,0,?)""", (r["dst"], None, None, r["label"], BASE + r["href"] if r["href"].startswith("/") else r["href"], url))
        con.execute("INSERT OR REPLACE INTO days VALUES (?,?,?,?,?)", (k, n, json.dumps(diarios, ensure_ascii=False), today.isoformat(), src))
        if i % 20 == 0:
            con.commit(); log(f"  {k}: {n} acts ({i + 1}/{len(todo)})")
    con.commit()


def fetch_detail(con, row):
    aid, url = row["id"], row["url"] or ""
    m = re.search(r"/dr/detalhe/([a-z0-9-]+)/([a-z0-9-]+)$", url)
    if not m:
        return False
    tipo, key = m.group(1), m.group(2)
    d = call("detail", {"Tipo": tipo, "Key": key, "ParteId": ""})
    dc = d.get("DetalheConteudo") or {}
    if not dc.get("Id"):
        return False
    text = dc.get("Texto") or ""
    approved, promulgated, signers = signatures(text)
    dpub = dc.get("DataPublicacao") or row["date"]
    kind = dc.get("TipoDiploma") or row["kind"]
    issuer = dc.get("Emissor") or row["issuer"]
    gov_date = approved or dpub
    government = period(gov_date, GOVERNMENTS) if issuer and not GOV_ISSUERS_EXCLUDE.search(issuer) else None
    legislature = period(approved or dpub, LEGISLATURES) if issuer and "Assembleia da República" in issuer else None
    con.execute("""UPDATE acts SET kind=?, number=COALESCE(NULLIF(?, ''), number), year=?, date=?, title=COALESCE(NULLIF(?, ''), title), issuer=?,
                   proponent=?, summary=COALESCE(NULLIF(?, ''), summary), vigencia=?, eli=?, pdf_url=?, dr_title=COALESCE(dr_title, ?),
                   dr_url=COALESCE(dr_url, ?), text=?, approved=?, promulgated=?, signatories=?, government=?, legislature=?, detail_at=?, url=?
                   WHERE id=?""",
                (kind, (dc.get("Numero") or "").strip(), int(dpub[:4]) if dpub else None, dpub, (dc.get("Titulo") or "").strip(), issuer,
                 ((dc.get("DiplomaLegis") or {}).get("EntidadeProponente") or None), (dc.get("Sumario") or "").strip(),
                 dc.get("Vigencia") or None, dc.get("ELI") or None, dc.get("URL_PDF") or None, dc.get("Publicacao"),
                 d.get("DiarioRepublicaLinkSitemap"), text, approved, promulgated, json.dumps(signers, ensure_ascii=False) if signers else None,
                 government, legislature, datetime.now().isoformat(timespec="seconds"), BASE + dc["LinkSitemap"] if dc.get("LinkSitemap") else url, aid))
    return True


def fetch_menu(con, row):
    m = re.search(r"/dr/detalhe/([a-z0-9-]+)/([a-z0-9-]+)$", row["url"] or "")
    if not m:
        return
    d = call("menu", {"Tipo": m.group(1), "Key": m.group(2), "ConteudoId": row["id"], "IsAtoOriginal": True})
    frag = d.get("DiplomaFragIdAux")
    con.execute("UPDATE acts SET frag_id=?, has_consolidated=?, has_parliament=?, menu_at=? WHERE id=?",
                (frag if frag and frag != "0" else None, 1 if d.get("HasLegConsPublished") else 0, 1 if d.get("HasParlamento") else 0,
                 datetime.now().isoformat(timespec="seconds"), row["id"]))
    for r in (d.get("RetificadoPorList") or {}).get("List", []):
        link = r.get("LinkSitemap") or ""
        rid = link.rsplit("-", 1)[-1]
        con.execute("INSERT OR IGNORE INTO rectifications VALUES (?,?,?,?,?)", (row["id"], rid, r.get("Diploma"), BASE + link, row["url"]))
        con.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?, 'menu', ?)", (rid, row["id"], "retifica", row["title"], row["url"]))


def fetch_consolidated(con, row):
    frag, slug = row["frag_id"], re.search(r"/dr/detalhe/([a-z0-9-]+)/", row["url"] or "")
    if not frag or not slug:
        return
    tipo = slug.group(1)
    year = row["year"] or (row["date"] or "0000")[:4]
    today = date.today().isoformat()
    cons_url = f"{BASE}/dr/legislacao-consolidada/{tipo}/{year}-{frag}"
    c = call("cons", {"Tipo": tipo, "Key": f"{year}-{frag}", "DiplomaFragId": frag, "Ano": int(year), "DataSelecionada": today})
    df = (c.get("ConsolidadaConteudoDetalhe") or {}).get("DiplomaFrag") or {}
    t = call("timeline", {"DiplomaLegisId": row["id"], "DiplomaFragId": frag, "Data": today, "ModificanteFragId": "0"})
    mods = (t.get("ModificacoesList") or {}).get("List", [])
    con.execute("DELETE FROM amendments WHERE target_id = ?", (row["id"],))
    for mo in mods:
        changes = [{"type": x.get("TipoModificacao"), "fragment": x.get("FragmentoDestinoModificacao") or x.get("IdentificacaoFragmento"),
                    "heading": x.get("Epigrafe"), "path": x.get("PathDestinoModificacao"), "in_force": x.get("DataEntradaVigor"),
                    "url": BASE + x["FragmentoVersaoLink"] if x.get("FragmentoVersaoLink") else None}
                   for x in (mo.get("ModificacaoList") or {}).get("List", [])]
        link = mo.get("LinkSitemap") or ""
        con.execute("INSERT OR REPLACE INTO amendments VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (row["id"], mo.get("DiplomaLegisId"), mo.get("TipoDiploma"), mo.get("Numero"), mo.get("Title"), mo.get("DataPublicacao"),
                     mo.get("SumarioDiplomaLegis"), len(changes), json.dumps(changes, ensure_ascii=False), BASE + link if link else None, cons_url))
        if mo.get("DiplomaLegisId"):
            con.execute("""INSERT OR IGNORE INTO acts (id, kind, number, date, year, title, summary, url, in_window, source_url)
                           VALUES (?,?,?,?,?,?,?,?,0,?)""", (mo["DiplomaLegisId"], mo.get("TipoDiploma"), mo.get("Numero"), mo.get("DataPublicacao"),
                                                             int(mo["DataPublicacao"][:4]) if mo.get("DataPublicacao") else None,
                                                             re.sub(r"\s*-\s*\d\.ª Série$", "", mo.get("Title") or ""), mo.get("SumarioDiplomaLegis"),
                                                             BASE + link if link else None, cons_url))
    con.execute("UPDATE acts SET cons_eli=?, cons_title=?, cons_url=?, cons_at=?, n_amendments=? WHERE id=?",
                (df.get("ELI") or None, df.get("Designacao") or None, cons_url, datetime.now().isoformat(timespec="seconds"), len(mods), row["id"]))


def phase_details(con):
    order = " ".join(f"WHEN '{t}' THEN {i}" for i, t in enumerate(DETAIL_TYPES))
    recent = " AND date >= ?" if SINCE else ""
    rows = con.execute(f"""SELECT * FROM acts WHERE in_window = 1 AND detail_at IS NULL AND kind IN ({",".join("?" * len(DETAIL_TYPES))}){recent}
                           ORDER BY CASE kind {order} END, date DESC LIMIT ?""",
                       (*DETAIL_TYPES, *([cutoff(SINCE)] if SINCE else []), DETAIL_MAX)).fetchall()
    log(f"details to fetch: {len(rows)}")
    for i, r in enumerate(rows):
        try:
            fetch_detail(con, r)
            if r["kind"] in DETAIL_TYPES[:7]:
                fetch_menu(con, r)
        except Exception as e:
            log("detail failed", r["id"], r["title"], e)
        if i % 25 == 0:
            con.commit(); log(f"  detail {i + 1}/{len(rows)} {r['title']}")
    con.commit()


def phase_targets(con):
    """Acts that are amended/revoked/republished by something in the window (often older laws): fetch detail,
    consolidated id and the official amendment timeline. Also refresh in-window acts that have a consolidated version."""
    recent = " AND s.date >= ?" if SINCE else ""
    rows = con.execute(f"""
      SELECT a.*, COUNT(l.src_id) refs, MAX(s.date) last_ref FROM acts a
      JOIN links l ON l.dst_id = a.id AND l.relation IN ('altera','republica','revoga','regulamenta','prorroga','suspende','retifica','refere','declara_inconstitucional')
      JOIN acts s ON s.id = l.src_id
      WHERE a.url LIKE '%/dr/detalhe/%' AND (a.cons_at IS NULL OR a.cons_at < s.date OR a.detail_at IS NULL){recent}
      GROUP BY a.id ORDER BY (a.kind IN ('Lei','Decreto-Lei','Lei Orgânica') OR a.kind IS NULL) DESC, refs DESC, last_ref DESC LIMIT ?""",
                       ([cutoff(SINCE)] if SINCE else []) + [TARGET_MAX]).fetchall()
    log(f"amended targets to resolve: {len(rows)}")
    for i, r in enumerate(rows):
        try:
            if not r["detail_at"]:
                fetch_detail(con, r)
            fetch_menu(con, con.execute("SELECT * FROM acts WHERE id=?", (r["id"],)).fetchone())
            r2 = con.execute("SELECT * FROM acts WHERE id=?", (r["id"],)).fetchone()
            if r2["frag_id"] and r2["has_consolidated"]:
                fetch_consolidated(con, r2)
            else:
                con.execute("UPDATE acts SET cons_at=? WHERE id=?", (datetime.now().isoformat(timespec="seconds"), r["id"]))
        except Exception as e:
            log("target failed", r["id"], r["title"], e)
        if i % 20 == 0:
            con.commit(); log(f"  target {i + 1}/{len(rows)} {r['title']}")
    # in-window primary acts that have a consolidated version but no timeline yet
    recent = " AND date >= ?" if SINCE else ""
    rows = con.execute(f"""SELECT * FROM acts WHERE in_window = 1 AND frag_id IS NOT NULL AND has_consolidated = 1 AND cons_at IS NULL{recent}
                          ORDER BY date DESC LIMIT ?""", ([cutoff(SINCE)] if SINCE else []) + [TARGET_MAX]).fetchall()
    log(f"in-window consolidated acts: {len(rows)}")
    for i, r in enumerate(rows):
        try:
            fetch_consolidated(con, r)
        except Exception as e:
            log("cons failed", r["id"], e)
        if i % 20 == 0:
            con.commit()
    con.commit()


GENERIC = set("altera alteracao alteracoes primeira segunda terceira quarta quinta sexta setima oitava nona decima aprova aprovacao procede "
               "lei decreto regime juridico estabelece cria criacao relativa relativo que pela pelo para com dos das nos nas sobre".split())


def same_subject(a, b):
    """Guard against near-identical templated titles ("Elevação da povoação de X à categoria de vila", "Grandes Opções 2025-2029")."""
    n = min(len(a), len(b))
    if n >= 150 and len(a) != len(b):  # one title truncated (AR agenda titles stop at ~200 chars): compare the common part
        a, b = a[:n].rsplit(" ", 2)[0], b[:n].rsplit(" ", 2)[0]
        n = min(len(a), len(b))
        a, b = a[:n].rsplit(" ", 1)[0], b[:n].rsplit(" ", 1)[0]
    if set(re.findall(r"\d+", a)) != set(re.findall(r"\d+", b)):
        return False
    ta = {w for w in a.split() if len(w) > 3 and not w.isdigit()} - GENERIC
    tb = {w for w in b.split() if len(w) > 3 and not w.isdigit()} - GENERIC
    if (ta - tb) and (tb - ta):  # a word swapped for another = different subject (e.g. another village)
        return False
    return len(ta ^ tb) <= 3


def phase_initiatives(con):
    """Link acts to parliament initiatives in data/politica.db (read-only): explicit citation in the act text,
    or near-identical title for AR laws."""
    pdb = DATA_DIR / "politica.db"
    if SINCE or not pdb.exists():
        return
    try:
        p = sqlite3.connect(f"file:{pdb}?mode=ro", uri=True)
        inits = p.execute("SELECT key, kind, number, legislature, title FROM initiatives").fetchall()
        p.close()
    except sqlite3.Error as e:
        log("initiatives unavailable:", e); return
    con.execute("DELETE FROM act_initiatives")
    keys = {k for k, *_ in inits}
    cite = re.compile(r"(Proposta de Lei|Projeto de Lei|Proposta de Resolução|Projeto de Resolução)\s+n\.?\s*º\s*(\d+)/([XVI]+)", re.I)
    for aid, text, summary in con.execute("SELECT id, text, summary FROM acts WHERE in_window=1 AND (text LIKE '%Proposta de%' OR text LIKE '%Projeto de%')"):
        for m in cite.finditer(text or ""):
            kind = m.group(1)[0].upper() + m.group(1)[1:].lower().replace("resolução", "Resolução").replace("lei", "Lei")
            k = f"{kind}|{int(m.group(2))}|{m.group(3).upper()}"
            if k in keys:
                con.execute("INSERT OR IGNORE INTO act_initiatives VALUES (?,?,?,?,?)", (aid, k, "citação no texto", 1.0, m.group(0)))
    by_leg = {}
    for k, kind, num, leg, title in inits:
        if kind in ("Proposta de Lei", "Projeto de Lei") and title:
            by_leg.setdefault(leg, []).append((k, norm(title)))
    cands = []
    for aid, summary, leg in con.execute("SELECT id, summary, legislature FROM acts WHERE in_window=1 AND kind IN ('Lei','Lei Orgânica') AND legislature IS NOT NULL"):
        s = norm(summary)
        if len(s) < 25:
            continue
        best = (0, None)
        for k, t in by_leg.get(leg, []):
            sc = SequenceMatcher(None, s, t).ratio()
            if sc > best[0]:
                best = (sc, k)
        if best[0] >= 0.86 and same_subject(s, dict(by_leg[leg])[best[1]]):
            cands.append((best[0], aid, best[1], summary))
    # one act per initiative (the most similar), never several acts for the same bill
    seen = set()
    for sc, aid, k, summary in sorted(cands, reverse=True):
        if k not in seen:
            seen.add(k)
            con.execute("INSERT OR IGNORE INTO act_initiatives VALUES (?,?,?,?,?)", (aid, k, "título equivalente", round(sc, 3), summary[:200]))
    con.commit()
    log("initiative links:", con.execute("SELECT COUNT(*) FROM act_initiatives").fetchone()[0])


def phase_link(con):
    vdb = DATA_DIR / "votacoes.db"
    if not vdb.exists():
        return
    try:
        v = sqlite3.connect(f"file:{vdb}?mode=ro", uri=True)
        n = linking.link_acts(con, v, linking.LINK_DAYS if SINCE else None)
        v.close()
        log("acts linked to initiatives:", n)
    except sqlite3.Error as e:
        log("initiative link pass failed:", e)


def build_fts(con):
    con.executescript("""
      DROP TABLE IF EXISTS acts_fts;
      CREATE VIRTUAL TABLE acts_fts USING fts5(title, summary, issuer, kind, content='acts', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      INSERT INTO acts_fts(rowid, title, summary, issuer, kind) SELECT rowid, title, summary, issuer, kind FROM acts;
    """)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = connect_writer(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    discover()
    phase_days(con)
    phase_details(con)
    phase_targets(con)
    phase_initiatives(con)
    phase_link(con)
    build_fts(con)
    stats = {k: con.execute(q).fetchone()[0] for k, q in {
        "acts_in_window": "SELECT COUNT(*) FROM acts WHERE in_window=1", "acts_total": "SELECT COUNT(*) FROM acts",
        "with_detail": "SELECT COUNT(*) FROM acts WHERE detail_at IS NOT NULL", "links": "SELECT COUNT(*) FROM links",
        "amendments": "SELECT COUNT(*) FROM amendments", "consolidated": "SELECT COUNT(*) FROM acts WHERE cons_url IS NOT NULL",
        "initiative_links": "SELECT COUNT(*) FROM act_initiatives"}.items()}
    for k, v in {**stats, "updated": datetime.now().isoformat(timespec="seconds"), "window_start": START, "module_version": _ver.get("module")}.items():
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, str(v)))
    con.commit()
    ultima = con.execute("SELECT MAX(date) FROM acts WHERE in_window = 1").fetchone()[0]
    con.close()
    log("done", stats)
    if SINCE:
        report(ultima)


if __name__ == "__main__":
    main()
