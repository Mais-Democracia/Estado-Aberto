"""Deputados da Assembleia da República (XVII Legislatura) -> data/deputados.db

REAL DATA (scraped from the public parlamento.pt pages, which work even though the open-data dataset
pages DAxxx.aspx time out / return empty):
  * /DeputadoGP/Paginas/Deputados.aspx            list of the deputies in office today (ASP.NET paged postback)
  * /DeputadoGP/Paginas/Biografia.aspx?BID=       full name, birth date, profession, committees (+ role)
  * /DeputadoGP/Paginas/ActividadeDeputado.aspx   initiatives authored (after the "[mais...]" postback)
  * /DeputadoGP/Paginas/PresencasReunioesPlenarias.aspx?BID=   plenary attendance meeting by meeting
  * /DeputadoGP/Paginas/AlteracoesComposicaoPlenario.aspx      substitutions / suspensions
Per-deputy individual votes are NOT published by the AR (only group-level votes) -> table `votes` stays empty.

OFFICIAL FILE HOOK (separate tables, prefix ar_): if data/ar_urls.json holds
  {"registo_biografico": "...", "iniciativas": "...", "atividades": "..."}
the job downloads those official JSON files and loads them with the documented schema
(Deputado{CadId,CadNomeCompleto,CadDeputadoLegis[...]}, Iniciativa{IniId,IniNr,IniLeg,IniTipo,IniTitulo,IniEventos[...]}).
Never mixed with the scraped tables.

Env: DEPUTADOS_LIMIT=N (only N deputies, for testing), DEPUTADOS_SLEEP=seconds (default 1.2),
     DEPUTADOS_REFRESH_H=hours before cached pages are refetched (default 20).
"""
import gzip
import html
import http.cookiejar
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from since import since_days  # noqa: E402
from common import DATA_DIR, ROOT, UA  # noqa: E402

NAME = "deputados"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
BASE = "https://www.parlamento.pt"
LIST_URL = BASE + "/DeputadoGP/Paginas/Deputados.aspx"
LEG = "XVII"
SEATS = 230
SLEEP = float(os.environ.get("DEPUTADOS_SLEEP", "1.2"))
REFRESH_H = float(os.environ.get("DEPUTADOS_REFRESH_H", "20"))
SINCE = since_days()
if SINCE:
    REFRESH_H = 1.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS deputados (
  bid INTEGER PRIMARY KEY, name TEXT, full_name TEXT, party TEXT, circle TEXT, birth_date TEXT,
  profession TEXT, qualifications TEXT, positions TEXT, legislature TEXT, in_office INTEGER DEFAULT 1,
  source_url TEXT, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS dep_party ON deputados(party);
CREATE TABLE IF NOT EXISTS committees (bid INTEGER, committee TEXT, role TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS com_bid ON committees(bid);
CREATE TABLE IF NOT EXISTS authored (
  bid INTEGER, tipo TEXT, numero TEXT, sessao TEXT, titulo TEXT, truncated INTEGER DEFAULT 0, source_url TEXT,
  UNIQUE (bid, tipo, numero)
);
CREATE INDEX IF NOT EXISTS aut_bid ON authored(bid);
CREATE TABLE IF NOT EXISTS attendance (
  bid INTEGER, date TEXT, meeting_no INTEGER, session INTEGER, kind TEXT, status TEXT, code TEXT, source_url TEXT,
  UNIQUE (bid, date, meeting_no, session)
);
CREATE INDEX IF NOT EXISTS att_bid ON attendance(bid);
CREATE TABLE IF NOT EXISTS mandate_changes (
  date TEXT, leaves TEXT, enters TEXT, circle TEXT, party TEXT, reason TEXT, raw TEXT, source_url TEXT,
  UNIQUE (date, leaves, enters, reason)
);
CREATE TABLE IF NOT EXISTS votes (bid INTEGER, initiative TEXT, date TEXT, vote TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- ===== official AR open-data files (only filled when data/ar_urls.json is supplied) =====
CREATE TABLE IF NOT EXISTS ar_deputado (
  cad_id INTEGER PRIMARY KEY, nome_completo TEXT, nome_parlamentar TEXT, gp_sigla TEXT, circulo TEXT,
  partido TEXT, legislatura TEXT, mandatos_json TEXT, source_url TEXT
);
CREATE TABLE IF NOT EXISTS ar_iniciativa (
  ini_id INTEGER PRIMARY KEY, nr TEXT, leg TEXT, tipo TEXT, titulo TEXT, autores_json TEXT, eventos_json TEXT, source_url TEXT
);
CREATE TABLE IF NOT EXISTS ar_votacao (
  ini_id INTEGER, fase TEXT, data TEXT, resultado TEXT, detalhe TEXT, source_url TEXT
);
CREATE TABLE IF NOT EXISTS ar_orgao (cad_id INTEGER, orgao TEXT, cargo TEXT, legislatura TEXT, source_url TEXT);
"""


# ---------------------------------------------------------------- HTTP (cookies, retries, gzip cache)
class Client:
    def __init__(self):
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.last = 0.0

    def fetch(self, url, data=None, tries=4, timeout=90):
        err = None
        for i in range(tries):
            wait = SLEEP - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
                with self.op.open(req, timeout=timeout) as r:
                    body = r.read().decode("utf8", "replace")
                self.last = time.time()
                return body
            except Exception as e:  # tarpit-like timeouts happen
                err = e
                self.last = time.time()
                time.sleep(3 * (i + 1))
        raise RuntimeError(f"fetch failed {url}: {err}")


def cached(client, key, url, force=False):
    """GET with a gzip cache in data/raw/deputados/."""
    f = RAW / (key + ".html.gz")
    if f.exists() and not force and (time.time() - f.stat().st_mtime) < REFRESH_H * 3600:
        return gzip.decompress(f.read_bytes()).decode("utf8")
    t = client.fetch(url)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(gzip.compress(t.encode("utf8")))
    return t


def hidden_fields(t):
    return {m.group(1): html.unescape(m.group(2))
            for m in re.finditer(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', t)}


def postback(client, url, page_html, target):
    d = hidden_fields(page_html)
    d["__EVENTTARGET"] = target
    d["__EVENTARGUMENT"] = ""
    return client.fetch(url, data=urllib.parse.urlencode(d).encode())


# ---------------------------------------------------------------- parsers (pure functions; unit tested)
def text_lines(t, start_marker='id="conteudo"'):
    i = t.find(start_marker) if start_marker else -1
    s = t[t.find('>', i) + 1:] if i >= 0 else t
    s = re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "\n", s)
    s = html.unescape(s).replace("\xa0", " ")
    out = [re.sub(r"\s+", " ", x).strip() for x in s.split("\n")]
    out = [x for x in out if x]
    # cut at the left-hand site menu that follows the content
    for n, x in enumerate(out):
        if x == "Parlamento" and n + 1 < len(out) and out[n + 1] == "Estatuto e competência":
            return out[:n]
    return out


def parse_list_page(t):
    """-> [(bid, name, circle, party)] for one page of the 'Deputados em funções' list, + total declared."""
    total = None
    m = re.search(r"\[\s*(\d+)\s*registo", t)
    if m:
        total = int(m.group(1))
    rows = []
    for blk in re.split(r'lvResultsByDate_ctrl\d+_hplNome', t)[1:]:
        m = re.search(r'BID=(\d+)">([^<]+)</a>', blk)
        c = re.search(r'_lblCE"[^>]*>([^<]*)<', blk)
        g = re.search(r'_lblGP"[^>]*>([^<]*)<', blk)
        if m:
            rows.append((int(m.group(1)), html.unescape(m.group(2)).strip(),
                         html.unescape(c.group(1)).strip() if c else None,
                         html.unescape(g.group(1)).strip() if g else None))
    return rows, total


BIO_LABELS = ["Nome completo", "Data de nascimento", "Habilitações literárias", "Profissão", "Cargos exercidos",
              "Comissões Parlamentares a que pertence", "Conteúdo da Página"]


def parse_bio(t):
    L = text_lines(t)
    sec = {}
    cur = None
    started = False
    for x in L:
        if x == "Nome completo":
            started = True
        if not started:
            continue
        if x in BIO_LABELS:
            if x == "Conteúdo da Página":
                break
            cur = x
            sec[cur] = []
            continue
        if cur:
            sec[cur].append(x)
    com = []
    for x in sec.get("Comissões Parlamentares a que pertence", []):
        m = re.match(r"^(.*?)\s*(?:\[([^\]]+)\])?\s*$", x)
        com.append((m.group(1).strip(), m.group(2)))
    first = lambda k: (sec.get(k) or [None])[0]  # noqa: E731
    return {
        "full_name": first("Nome completo"), "birth_date": first("Data de nascimento"),
        "profession": first("Profissão"), "qualifications": "; ".join(sec.get("Habilitações literárias", [])) or None,
        "positions": "; ".join(sec.get("Cargos exercidos", [])) or None, "committees": com,
    }


def _sections(t):
    """split an activity page on its section titles -> {title: html chunk}"""
    parts = re.split(r'<span class="Titulo-Cinzento bold font20">([^<]+)</span>', t)
    return {html.unescape(parts[i]).strip(): parts[i + 1] for i in range(1, len(parts) - 1, 2)}


def parse_authored(t):
    """-> (list of (tipo, numero, sessao, titulo), has_more_link)"""
    chunk = _sections(t).get("Iniciativas apresentadas", "")
    more = bool(re.search(r"btnMIniciativas[^>]*>\s*\[mais", chunk))
    L = text_lines(chunk, start_marker="")
    items, cur = [], {}
    keys = {"Tipo": "tipo", "Número": "numero", "Sessão": "sessao", "Título": "titulo"}
    i = 0
    while i < len(L):
        if L[i] in keys and i + 1 < len(L):
            cur[keys[L[i]]] = L[i + 1]
            i += 2
            if L[i - 2] == "Título":
                if cur.get("tipo") and cur.get("numero"):
                    items.append((cur["tipo"], cur["numero"], cur.get("sessao"), cur.get("titulo")))
                cur = {}
        else:
            i += 1
    return items, more


def parse_attendance(t):
    """-> [(session, date, meeting_no, kind, status, code)]"""
    L = text_lines(t)
    out, sess = [], None
    i = 0
    while i < len(L):
        m = re.match(r"^(\d+)ª Sessão Legislativa", L[i])
        if m:
            sess = int(m.group(1))
        if L[i] == "Data" and i + 7 < len(L) and L[i + 2] == "Número" and L[i + 4] == "Tipo" and L[i + 6] == "Presença/Falta":
            st = L[i + 7]
            code = re.search(r"\(([^)]+)\)\s*$", st)
            out.append((sess, L[i + 1], int(L[i + 3]) if L[i + 3].isdigit() else None, L[i + 5], st, code.group(1) if code else None))
            i += 8
        else:
            i += 1
    return out


SUB_RE = re.compile(r"^Substituição de (.+?), por (.+?), Deputado\(a\) por (.+?), Grupo Parlamentar d[oa] (.+?), pelo motivo de: (.+)$")


def parse_changes(t):
    L = text_lines(t)
    out, date = [], None
    for x in L:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", x):
            date = x
            continue
        m = SUB_RE.match(x)
        if m:
            out.append((date, m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), x))
        elif x.startswith("Substituição") or x.startswith("Alteração"):
            out.append((date, None, None, None, None, None, x))
    return out


# ---------------------------------------------------------------- official AR file hook (documented schema)
def _dl_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def load_official(con, urls):
    """Load the official AR JSON files into the ar_* tables. `urls` = {registo_biografico, iniciativas, atividades}.
    Each value may also be a local path or a ready Python object (used by the unit test)."""
    def get(v):
        if isinstance(v, (list, dict)):
            return v
        if str(v).startswith("http"):
            return _dl_json(v)
        with open(v, encoding="utf-8-sig") as f:
            return json.load(f)

    n = {"deputados": 0, "iniciativas": 0}
    rb = urls.get("registo_biografico")
    if rb:
        src = rb if isinstance(rb, str) else "inline"
        data = get(rb)
        if isinstance(data, dict):  # some exports wrap the list
            for k in ("ArrayOfDeputado", "Deputados", "Deputado"):
                if k in data:
                    data = data[k]
                    break
        for d in data if isinstance(data, list) else []:
            legis = d.get("CadDeputadoLegis") or []
            if isinstance(legis, dict):
                legis = [legis]
            last = legis[-1] if legis else {}
            con.execute("INSERT OR REPLACE INTO ar_deputado VALUES (?,?,?,?,?,?,?,?,?)",
                        (d.get("CadId"), d.get("CadNomeCompleto"), last.get("DepNomeParlamentar"), last.get("GpSigla"),
                         last.get("CeDes"), last.get("ParSigla"), last.get("LegDes"), json.dumps(legis, ensure_ascii=False), src))
            orgs = d.get("CadActividadeOrgaos") or {}
            for o in (orgs if isinstance(orgs, list) else orgs.get("Orgaos", []) if isinstance(orgs, dict) else []):
                con.execute("INSERT INTO ar_orgao VALUES (?,?,?,?,?)",
                            (d.get("CadId"), o.get("OrgDes") or o.get("Orgao"), o.get("CargoDes") or o.get("Cargo"), o.get("LegDes"), src))
            n["deputados"] += 1
    ini = urls.get("iniciativas")
    if ini:
        src = ini if isinstance(ini, str) else "inline"
        for it in get(ini):
            autores = it.get("IniAutorDeputados") or []
            con.execute("INSERT OR REPLACE INTO ar_iniciativa VALUES (?,?,?,?,?,?,?,?)",
                        (it.get("IniId"), it.get("IniNr"), it.get("IniLeg"), it.get("IniTipo"), it.get("IniTitulo"),
                         json.dumps(autores, ensure_ascii=False), json.dumps(it.get("IniEventos") or [], ensure_ascii=False), src))
            for ev in it.get("IniEventos") or []:
                for v in ev.get("Votacao") or []:
                    con.execute("INSERT INTO ar_votacao VALUES (?,?,?,?,?,?)",
                                (it.get("IniId"), ev.get("Fase"), v.get("data") or ev.get("DataFase"), v.get("resultado"),
                                 json.dumps(v, ensure_ascii=False), src))
            n["iniciativas"] += 1
    return n


# ---------------------------------------------------------------- scraping job
def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_list(client):
    t = cached(client, "list_p1", LIST_URL)
    rows, total = parse_list_page(t)
    allrows = {r[0]: r for r in rows}
    page = 2
    while True:
        m = re.search(r"__doPostBack\(&#39;([^&]*dpgResultsByDate[^&]*)&#39;,&#39;&#39;\)\">%d</a>" % page, t)
        if not m:  # past the 10th page the pager only offers ">" (next block)
            m = re.search(r"__doPostBack\(&#39;([^&]*dpgResultsByDate[^&]*)&#39;,&#39;&#39;\)\">(?:&gt;|>)</a>", t)
        if not m or page > 60:
            break
        f = RAW / f"list_p{page}.html.gz"
        if f.exists() and time.time() - f.stat().st_mtime < REFRESH_H * 3600:
            t = gzip.decompress(f.read_bytes()).decode("utf8")
        else:
            t = postback(client, LIST_URL, t, m.group(1))
            f.write_bytes(gzip.compress(t.encode("utf8")))
        r, _ = parse_list_page(t)
        for x in r:
            allrows[x[0]] = x
        page += 1
    return list(allrows.values()), total


def fetch_pages(client, bid):
    """Network part of one deputy (runs in a worker thread): returns (bio_html, act_html, pres_html), cached on disk."""
    bio_url = f"{BASE}/DeputadoGP/Paginas/Biografia.aspx?BID={bid}"
    act_url = f"{BASE}/DeputadoGP/Paginas/ActividadeDeputado.aspx?BID={bid}&lg={LEG}"
    pres_url = f"{BASE}/DeputadoGP/Paginas/PresencasReunioesPlenarias.aspx?BID={bid}"
    bio = cached(client, f"bio_{bid}", bio_url)
    f = RAW / f"act_{bid}.html.gz"
    if f.exists() and time.time() - f.stat().st_mtime < REFRESH_H * 3600:
        at = gzip.decompress(f.read_bytes()).decode("utf8")
    else:
        at = client.fetch(act_url)
        _, more = parse_authored(at)
        if more:  # the "[mais...]" postback expands the list of authored initiatives
            m = re.search(r"PostBackOptions\(&quot;([^&]*btnMIniciativas)&quot;", at)
            if m:
                at = postback(client, act_url, at, m.group(1))
        f.write_bytes(gzip.compress(at.encode("utf8")))
    pres = cached(client, f"pres_{bid}", pres_url)
    return bio, at, pres


def store_deputy(con, bid, name, circle, party, pages):
    bio_url = f"{BASE}/DeputadoGP/Paginas/Biografia.aspx?BID={bid}"
    act_url = f"{BASE}/DeputadoGP/Paginas/ActividadeDeputado.aspx?BID={bid}&lg={LEG}"
    pres_url = f"{BASE}/DeputadoGP/Paginas/PresencasReunioesPlenarias.aspx?BID={bid}"
    bio_h, at, pres_h = pages
    bio = parse_bio(bio_h)
    con.execute("INSERT OR REPLACE INTO deputados VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
                (bid, name, bio["full_name"], party, circle, bio["birth_date"], bio["profession"], bio["qualifications"],
                 bio["positions"], LEG, bio_url, now()))
    con.execute("DELETE FROM committees WHERE bid=?", (bid,))
    for c, role in bio["committees"]:
        con.execute("INSERT INTO committees VALUES (?,?,?,?)", (bid, c, role, bio_url))
    items, more = parse_authored(at)
    con.execute("DELETE FROM authored WHERE bid=?", (bid,))
    for tipo, num, sess, tit in items:
        # `more` after the postback = the source still offers a further expansion -> list may be truncated
        con.execute("INSERT OR IGNORE INTO authored VALUES (?,?,?,?,?,?,?)", (bid, tipo, num, sess, tit, 1 if more and len(items) >= 10 and not _expanded(at) else 0, act_url))
    rows = parse_attendance(pres_h)
    con.execute("DELETE FROM attendance WHERE bid=?", (bid,))
    for sess, date, no, kind, st, code in rows:
        con.execute("INSERT OR IGNORE INTO attendance VALUES (?,?,?,?,?,?,?,?)", (bid, date, no, sess, kind, st, code, pres_url))
    con.commit()
    return len(rows), len(items)


def _expanded(at):
    """after expansion the link reads [menos...] (collapse) instead of [mais...]"""
    return bool(re.search(r"btnMIniciativas[^>]*>\s*\[menos", at))


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    client = Client()

    # 0. official files hook
    uf = DATA_DIR / "ar_urls.json"
    if uf.exists():
        try:
            urls = json.loads(uf.read_text())
            urls = {k: v for k, v in urls.items() if v}
            if urls:
                print("official AR files:", load_official(con, urls))
                con.commit()
        except Exception as e:
            print("official AR files FAILED:", e)

    # 1. list of deputies in office
    rows, total = fetch_list(client)
    print(f"list: {len(rows)} deputies (page says {total})")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('list_total_declared', ?)", (str(total),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('list_url', ?)", (LIST_URL,))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('list_fetched_at', ?)", (now(),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('seats', ?)", (str(SEATS),))
    con.execute("UPDATE deputados SET in_office=0")
    for bid, name, circle, party in rows:  # names/party/circle first so the UI has something immediately
        con.execute("""INSERT INTO deputados(bid,name,party,circle,legislature,in_office,source_url,fetched_at)
                       VALUES (?,?,?,?,?,1,?,?)
                       ON CONFLICT(bid) DO UPDATE SET name=excluded.name,party=excluded.party,circle=excluded.circle,in_office=1""",
                    (bid, name, party, circle, LEG, f"{BASE}/DeputadoGP/Paginas/Biografia.aspx?BID={bid}", now()))
    con.commit()

    # 2. substitutions
    url = BASE + "/DeputadoGP/Paginas/AlteracoesComposicaoPlenario.aspx"
    for r in parse_changes(cached(client, "alteracoes", url)):
        con.execute("INSERT OR IGNORE INTO mandate_changes VALUES (?,?,?,?,?,?,?,?)", (*r, url))
    con.commit()

    # 3. per-deputy detail: pages fetched by a few polite workers (each with its own cookie jar and pacing)
    from concurrent.futures import ThreadPoolExecutor
    limit = int(os.environ.get("DEPUTADOS_LIMIT", "0")) or len(rows)
    workers = int(os.environ.get("DEPUTADOS_WORKERS", "4"))
    clients = [Client() for _ in range(workers)]
    done = 0
    todo = rows[:limit]
    if SINCE:
        slot = time.localtime().tm_yday % SINCE
        todo = [r for r in todo if r[0] % SINCE == slot or not (RAW / f"bio_{r[0]}.html.gz").exists()]

    def work(i_row):
        i, row = i_row
        return row, fetch_pages(clients[i % workers], row[0])

    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(work, (i, r)) for i, r in enumerate(todo)]
        for fu in futs:
            try:
                (bid, name, circle, party), pages = fu.result()
                na, ni = store_deputy(con, bid, name, circle, party, pages)
                done += 1
                if done % 10 == 0:
                    print(f"  {done}/{len(todo)} deputies detailed (last: {name}: {na} meetings, {ni} initiatives)", flush=True)
            except Exception as e:
                print(f"  ! detail failed: {e}", flush=True)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('detail_done', ?)", (str(done),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('detail_at', ?)", (now(),))
    con.commit()
    con.close()
    print("deputados.db written")


if __name__ == "__main__":
    main()
