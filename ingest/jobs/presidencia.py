"""Presidência da República — atos formais do Presidente (module `presidencia`) -> data/presidencia.db

Sources (robots.txt checked per host; >=1.2 s between requests to a host; raw cache in data/raw/presidencia/):
  * presidencia.pt  /atualidade/atividade-legislativa  (the site's own "Ver mais" endpoint
    /umbraco/Surface/PartialViewSurface/RequestFilterList) + each article page. The site only keeps the current
    mandate (2026-03-09 ->). presidencia.pt has no robots.txt (404) and no sitemap.xml.
  * data/votacoes.db (read-only): phases Envio para promulgação / Promulgação / Veto (Receção) / Reapreciação /
    Confirmação do decreto per initiative (XV-XVII legislatures, 2022-04 ->).
  * data/dre.db (read-only): Lei / Lei Orgânica / Decreto-Lei / Decreto Regulamentar with promulgation + approval
    dates (complete 2024 ->, partial before) and "Decreto do Presidente da República" (nomeações, ratificações...).
  * data/justica.db (read-only) + tribunalconstitucional.pt acórdão pages: fiscalização preventiva (1983 ->) and
    pedidos of the President in fiscalização sucessiva (requester parsed from the acórdão's Relatório).
No data is invented: where a source does not reach (Cavaco 2006-2016, Marcelo before 2022 vetoes, ...) the gap is
recorded in table `cobertura`.   Env: PRESID_NO_FETCH=1 (use cache only)
"""
import html
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA, connect_writer  # noqa: E402
from since import cutoff, report, since_days  # noqa: E402

NAME = "presidencia"
DB = DATA_DIR / f"{NAME}.db"
RAW = DATA_DIR / "raw" / NAME
BASE = "https://www.presidencia.pt"
LIST_URL = BASE + "/umbraco/Surface/PartialViewSurface/RequestFilterList"
MIN_GAP = 1.2
NO_FETCH = bool(os.environ.get("PRESID_NO_FETCH"))
_last = {}
SINCE = since_days()

PRESIDENTES = [  # (start, end, name)
    ("1958-08-09", "1974-04-25", "Américo Thomaz"), ("1974-04-25", "1974-09-30", "António de Spínola"),
    ("1974-09-30", "1976-07-14", "Francisco da Costa Gomes"), ("1976-07-14", "1986-03-09", "António Ramalho Eanes"),
    ("1986-03-09", "1996-03-09", "Mário Soares"), ("1996-03-09", "2006-03-09", "Jorge Sampaio"),
    ("2006-03-09", "2016-03-09", "Aníbal Cavaco Silva"), ("2016-03-09", "2026-03-09", "Marcelo Rebelo de Sousa"),
    ("2026-03-09", "2031-03-09", "António José Seguro"),
]
MESES = {m: i + 1 for i, m in enumerate("janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())}

SCHEMA = """
CREATE TABLE IF NOT EXISTS atos (
  id TEXT PRIMARY KEY, data TEXT, ano INTEGER, presidente TEXT, tipo TEXT, subtipo TEXT,
  diploma_tipo TEXT, diploma_ref TEXT, decreto_ref TEXT, iniciativa_key TEXT, dre_act_id TEXT, link_metodo TEXT,
  titulo TEXT, texto TEXT, mensagem_url TEXT, acordao_tc TEXT,
  data_aprovacao TEXT, dias_aprovacao INTEGER, data_envio TEXT, dias_envio INTEGER,
  canon INTEGER DEFAULT 1, fonte TEXT, source_url TEXT, extra TEXT
);
CREATE INDEX IF NOT EXISTS atos_data ON atos(data);
CREATE INDEX IF NOT EXISTS atos_tipo ON atos(tipo, data);
CREATE INDEX IF NOT EXISTS atos_ini ON atos(iniciativa_key);
CREATE INDEX IF NOT EXISTS atos_dre ON atos(dre_act_id);
CREATE TABLE IF NOT EXISTS vetos (
  id TEXT PRIMARY KEY, data TEXT, data_ato TEXT, presidente TEXT, origem TEXT, motivo TEXT,
  decreto_ref TEXT, iniciativas TEXT, titulo TEXT, acordao_tc TEXT,
  desfecho TEXT, desfecho_data TEXT, desfecho_detalhe TEXT, promulgacao_data TEXT, dre_act_id TEXT,
  mensagem_url TEXT, mensagem_texto TEXT, fonte TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS vetos_data ON vetos(data);
CREATE TABLE IF NOT EXISTS tc_pedidos (
  acordao_id TEXT PRIMARY KEY, data TEXT, tipo TEXT, requerente TEXT, presidente TEXT, decreto_ref TEXT,
  processo TEXT, resultado TEXT, iniciativa_key TEXT, link_metodo TEXT, veto_id TEXT, source_url TEXT
);
CREATE INDEX IF NOT EXISTS tcp_data ON tc_pedidos(data);
CREATE TABLE IF NOT EXISTS comunicados (
  url TEXT PRIMARY KEY, data TEXT, titulo TEXT, tipo TEXT, n_diplomas INTEGER, texto TEXT,
  ato_id TEXT, link_metodo TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS cobertura (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


# ----------------------------------------------------------------------------- http
def throttle(host):
    w = _last.get(host, 0) + MIN_GAP - time.time()
    if w > 0:
        time.sleep(w)


def http(url, data=None, cache=None):
    f = RAW / cache if cache else None
    if f and f.exists():
        return f.read_text("utf-8", "replace")
    if NO_FETCH:
        return None
    host = urllib.parse.urlsplit(url).netloc
    for attempt in range(3):
        throttle(host)
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read().decode("utf-8", "replace")
            _last[host] = time.time()
            if f:
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(body, "utf-8")
            return body
        except urllib.error.HTTPError as e:
            _last[host] = time.time()
            if e.code in (403, 404, 410):
                return None
            time.sleep(3 * (attempt + 1))
        except Exception:
            _last[host] = time.time()
            time.sleep(3 * (attempt + 1))
    return None


def text_of(h):
    h = re.sub(r"<(script|style)\b.*?</\1>", " ", h, flags=re.S)
    h = re.sub(r"</(p|div|li|h\d)>|<br\s*/?>", "\n", h)
    t = html.unescape(re.sub(r"<[^>]+>", " ", h))
    t = re.sub(r"[ \t\xa0]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n", t).strip()


def pt_date(s):
    m = re.search(r"(\d{1,2}) de (\w+) de (\d{4})", s or "")
    if not m or m.group(2).lower() not in MESES:
        return None
    return f"{int(m.group(3)):04d}-{MESES[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"


def presidente_em(d):
    for a, b, n in PRESIDENTES:
        if a <= (d or "") < b:
            return n
    return None


def days(a, b):
    try:
        from datetime import date
        x = date.fromisoformat(a[:10]); y = date.fromisoformat(b[:10])
        n = (y - x).days
        return n if n >= 0 else None
    except Exception:
        return None


# ----------------------------------------------------------------------------- presidencia.pt
NUM = {"um": 1, "uma": 1, "dois": 2, "duas": 2, "três": 3, "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8, "nove": 9, "dez": 10}


def classify_news(title, body):
    t = title.lower()
    n = 1
    m = re.search(r"\b(um|uma|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez)\b", t)
    if m:
        n = NUM[m.group(1)]
    gov = "governo" in t
    if "devolve" in t or "veta" in t:
        return "veto", "AR" if "assembleia" in (t + body[:300].lower()) else "Governo", n
    if "tribunal constitucional" in t or "fiscalização" in t and "submete" in t:
        return "envio_tc", None, n
    if "promulga" in t:
        return "promulgacao", "Governo" if gov else "AR", n
    if "assina" in t:
        return "promulgacao", "Governo", n
    if "ratifica" in t:
        return "ratificacao", None, n
    if "dissol" in t:
        return "dissolucao", None, n
    if "nomeia" in t or "empossa" in t or "indigita" in t:
        return "nomeacao", None, n
    return "outro", None, n


def fetch_presidencia(cur):
    pages = []
    for p in range(0, 40):
        payload = urllib.parse.urlencode({"culture": "pt-PT", "mode": "213213", "data": json.dumps(
            {"type": "filter-news", "filter": "3", "page": p, "other": 1, "dateFilters": [], "theme": "", "MaxPerPage": 9, "tag": ""})}).encode()
        h = http(LIST_URL, data=payload, cache=None if SINCE else f"list/p{p}.html")
        if not h or "article-title" not in h:
            break
        pages.append(h)
        if SINCE:
            ds = [pt_date(m.group(1)) for m in re.finditer(r'class="date">([^<]*)', h)]
            if ds and all(d and d < cutoff(SINCE) for d in ds):
                break
    items = []
    for h in pages:
        for m in re.finditer(r'<a href="([^"]+)" class="article-title"\s*>\s*(.*?)\s*</a>.*?class="date">([^<]*)', h, re.S):
            title = html.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))
            items.append((BASE + m.group(1), re.sub(r"\s+", " ", title).strip(), pt_date(m.group(3))))
    n = 0
    if SINCE:
        items = [x for x in items if not x[2] or x[2] >= cutoff(SINCE)]
    for url, title, d in items:
        slug = urllib.parse.urlsplit(url).path.strip("/").replace("/", "_")
        h = http(url, cache=f"art/{slug}.html")
        body = ""
        if h:
            i = h.find("<h1")
            t = text_of(h[i:] if i >= 0 else h)
            body = t.split("Partilhar")[0]
            body = re.sub(r"^.*?\n(?=\d{1,2} de \w+ de \d{4})", "", body, flags=re.S)
            body = re.sub(r"^\d{1,2} de \w+ de \d{4}\s*", "", body).strip()
            d = pt_date(t[:400]) or d
        tipo, origem, nd = classify_news(title, body)
        cur.execute("INSERT OR REPLACE INTO comunicados(url,data,titulo,tipo,n_diplomas,texto,fetched_at) VALUES(?,?,?,?,?,?,date('now'))",
                    (url, d, title, tipo + (":" + origem if origem else ""), nd, body))
        n += 1
        if n % 20 == 0:
            cur.connection.commit()
    cur.connection.commit()
    return len(items)


# ----------------------------------------------------------------------------- votacoes
DEC_RE = re.compile(r"D\s?ecreto(?: da Assembleia da República)?(?: n\.º|\s+n\.º)\s*(\d+(?:-[A-Z])?)/(XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII)\b")


LIST_RE = re.compile(r"Decretos?\s+n\.[ºo]s?\s*((?:\d+(?:-[A-Z])?(?:/(?:XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII))?\s*(?:,|e)?\s*)+)")


def decs_of(obs):
    """Decree numbers ('103/XV') in an obs like 'Decretos n.ºs 97, 102 e 103/XV' (leg given once at the end)."""
    out = set()
    for m in LIST_RE.finditer(obs or ""):
        seg = m.group(1)
        leg = re.findall(r"/([IVX]+)", seg)
        if not leg:
            continue
        for n in re.findall(r"(\d+(?:-[A-Z])?)(?:/[IVX]+)?", seg):
            out.add(f"{n}/{leg[-1]}")
    return out


def ini_key(r):
    return f"{r['tipo']}|{r['numero']}|{r['leg']}"


def build_votacoes(con, cur):
    v = sqlite3.connect(f"file:{DATA_DIR/'votacoes.db'}?mode=ro", uri=True, timeout=60)
    v.row_factory = sqlite3.Row
    ini = {r["bid"]: r for r in v.execute("SELECT * FROM iniciativas")}
    fases = {}
    for r in v.execute("SELECT bid,ord,data,fase,obs,publicacoes,source_url FROM fases ORDER BY bid,ord"):
        fases.setdefault(r["bid"], []).append(r)
    dec_to_bid = {}
    for bid, fs in fases.items():
        for f in fs:
            for m in DEC_RE.finditer(f["obs"] or ""):
                dec_to_bid.setdefault(f"{m.group(1)}/{m.group(2)}", set()).add(bid)

    def pub0(f):
        try:
            return (json.loads(f["publicacoes"] or "[]") or [""])[0][:80]
        except Exception:
            return ""

    # one "decree event" per (initiative bid); then cluster co-initiatives sharing the same published decree
    veto_events = {}   # cluster key -> dict
    prom_events = {}   # cluster key -> dict
    for bid, fs in fases.items():
        i = ini.get(bid)
        if not i:
            continue
        last_dec_pub = ""
        last_final = None
        sent = None
        vetos = [f for f in fs if f["fase"] == "Veto (Receção)"]
        veto_dates = sorted({f["data"] for f in vetos})
        for f in fs:
            fa = f["fase"]
            if fa in ("Decreto (Publicação)", "Decreto (2ª versão) (Publicação)", "Decreto (Republicação)"):
                last_dec_pub = pub0(f)
            elif fa == "Votação final global":
                last_final = f["data"]
            elif fa == "Votação novo decreto":
                last_final = f["data"]
            elif fa.startswith("Envio para promulgação"):
                sent = f["data"]
            elif fa in ("Promulgação", "Promulgação (2ª versão)"):
                key = (f["data"], last_dec_pub or f"bid{bid}")
                e = prom_events.setdefault(key, {"data": f["data"], "bids": [], "final": last_final, "sent": sent, "fase": fa,
                                                  "src": f["source_url"]})
                e["bids"].append(bid)
        for k, vd in enumerate(veto_dates):
            nxt = veto_dates[k + 1] if k + 1 < len(veto_dates) else "9999"
            vf = [f for f in vetos if f["data"] == vd]
            dec_pub = ""
            for f in fs:
                if f["fase"] in ("Decreto (Publicação)", "Decreto (2ª versão) (Publicação)", "Decreto (Republicação)") and f["data"] <= vd:
                    dec_pub = pub0(f)
            key = (vd, dec_pub or f"bid{bid}")
            e = veto_events.setdefault(key, {"data": vd, "bids": [], "obs": "", "src": vf[0]["source_url"], "outs": {}})
            e["bids"].append(bid)
            e["obs"] += " " + " ".join(f["obs"] or "" for f in vf)
            # outcome of THIS veto for this initiative: events between vd and next veto date
            vdecs = decs_of(" ".join(f["obs"] or "" for f in vf))
            if vdecs:   # package of decrees: follow only the phases that name these decrees (or have no decree list)
                window = [f for f in fs if f["data"] >= vd and f["ord"] > vf[0]["ord"]
                          and ((decs_of(f["obs"]) & vdecs) or (not decs_of(f["obs"]) and f["data"] < nxt))]
            else:
                window = [f for f in fs if vd <= f["data"] < nxt and f["ord"] > vf[0]["ord"]]
            ph = [f["fase"] for f in window]
            out = None
            if vdecs and any(f["fase"].startswith("Envio para promulgação novo decreto") and "confirmado" in f["fase"] for f in window):
                out = ("confirmado", next(f["data"] for f in window if "confirmado" in f["fase"]))
            elif "Confirmação do decreto" in ph:
                out = ("confirmado", next(f["data"] for f in window if f["fase"] == "Confirmação do decreto"))
            elif "Votação novo decreto" in ph:
                out = ("reformulado", next(f["data"] for f in window if f["fase"] == "Votação novo decreto"))
            elif any(p.startswith("Iniciativa Caducada") or p == "Iniciativa Caducada" for p in ph):
                out = ("caducou", next(f["data"] for f in window if f["fase"].startswith("Iniciativa Caducada")))
            elif "Reapreciação do decreto" in ph:
                out = ("em_reapreciacao", next(f["data"] for f in window if f["fase"] == "Reapreciação do decreto"))
            prom = [f for f in window if f["fase"] in ("Promulgação", "Promulgação (2ª versão)") and f["data"] > vd]
            e["outs"][bid] = (out, prom[0]["data"] if prom else None)

    # ---------- vetos
    n_veto = 0
    tcmap = {}
    for key, e in sorted(veto_events.items()):
        bids = sorted(set(e["bids"]))
        decs = sorted(decs_of(e["obs"]) | {f"{m.group(1)}/{m.group(2)}" for m in DEC_RE.finditer(e["obs"])})
        if not decs:   # decree number from any phase of the cluster
            for bid in bids:
                for f in fases[bid]:
                    for m in DEC_RE.finditer(f["obs"] or ""):
                        if f["data"] <= e["data"]:
                            decs.append(f"{m.group(1)}/{m.group(2)}")
            decs = sorted(set(decs))
        ac = re.findall(r"Acórdão do Tribunal Constitucional n\.º (\d+/\d{4})", e["obs"])
        ac = sorted(set(ac))
        outs = [o for o in e["outs"].values()]
        kinds = {o[0][0] for o in outs if o[0]}
        if "confirmado" in kinds:
            des = "confirmado"
        elif "reformulado" in kinds:
            des = "reformulado"
        elif kinds == {"caducou"}:
            des = "caducou"
        elif "em_reapreciacao" in kinds:
            des = "em_reapreciacao"
        else:
            des = "sem_desfecho"
        dd = min((o[0][1] for o in outs if o[0] and o[0][0] == des), default=None)
        pr = [o[1] for o in outs if o[1]]
        i0 = ini[bids[0]]
        dre = [ini[b]["dre_act_id"] for b in bids if ini[b]["dre_act_id"]]
        keys = [ini_key(ini[b]) for b in bids]
        vid = f"veto:{e['data']}:{bids[0]}"
        motivo = "tc" if ac else "politico"
        pres = presidente_em(e["data"])
        cur.execute("INSERT OR REPLACE INTO vetos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (vid, e["data"], None, pres, "AR", motivo, ", ".join(decs) or None, json.dumps(keys, ensure_ascii=False),
                     i0["titulo"], ", ".join(ac) or None, des, dd, None, min(pr) if pr else None, dre[0] if dre else None,
                     None, None, "votacoes", e["src"]))
        for a in ac:
            tcmap[a] = vid
        cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,subtipo,diploma_tipo,decreto_ref,iniciativa_key,dre_act_id,link_metodo,titulo,acordao_tc,canon,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,'votacoes',?)",
                    (vid, e["data"], int(e["data"][:4]), pres, "veto", motivo, "Decreto da Assembleia da República", ", ".join(decs) or None,
                     keys[0], dre[0] if dre else None, "votacoes:fase", i0["titulo"], ", ".join(ac) or None, e["src"]))
        n_veto += 1
    con.commit()

    # ---------- promulgations of AR decrees (votacoes), merged into DRE rows when dre_act_id is known
    n_prom = 0
    dre_dates = {}
    d = sqlite3.connect(f"file:{DATA_DIR/'dre.db'}?mode=ro", uri=True, timeout=60)
    for r in d.execute("SELECT promulgated FROM acts WHERE kind IN ('Lei','Lei Orgânica','Decreto Regulamentar') AND promulgated!=''"):
        dre_dates[r[0]] = dre_dates.get(r[0], 0) + 1
    # explicit link by "Lei n/ano" (iniciativas.lei_ref) when the initiative has no dre_act_id
    by_num = {f"{r[0]} {r[1]}": r[2] for r in d.execute("SELECT kind, number, id FROM acts WHERE kind IN ('Lei','Lei Orgânica')")}
    for b, i in ini.items():
        if not i["dre_act_id"] and (i["lei_ref"] or "") in by_num:
            i2 = dict(i); i2["dre_act_id"] = by_num[i["lei_ref"]]
            ini[b] = i2
    for key, e in sorted(prom_events.items()):
        bids = sorted(set(e["bids"]))
        i0 = ini[bids[0]]
        dre = [ini[b]["dre_act_id"] for b in bids if ini[b]["dre_act_id"]]
        keys = [ini_key(ini[b]) for b in bids]
        decs = sorted({f"{m.group(1)}/{m.group(2)}" for b in bids for f in fases[b] for m in DEC_RE.finditer(f["obs"] or "")
                       if f["fase"].startswith("Envio para promulgação")})
        if dre:
            cur.execute("UPDATE atos SET iniciativa_key=?, link_metodo=?, data_envio=?, dias_envio=?, decreto_ref=COALESCE(?,decreto_ref) WHERE id=?",
                        (keys[0], "votacoes:dre_act_id", e["sent"], days(e["sent"], e["data"]) if e["sent"] else None, ", ".join(decs) or None, "dre:" + dre[0]))
            if cur.rowcount and "2022-04-27" <= e["data"] <= "2023-12-31" and e["final"]:   # period A: days from the votações dates only
                cur.execute("UPDATE atos SET data_aprovacao=?, dias_aprovacao=? WHERE id=?", (e["final"], days(e["final"], e["data"]), "dre:" + dre[0]))
            if cur.rowcount:
                continue
        dup = False
        pid = f"prom:{e['data']}:{bids[0]}"
        cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,diploma_tipo,decreto_ref,iniciativa_key,dre_act_id,link_metodo,titulo,data_aprovacao,dias_aprovacao,data_envio,dias_envio,canon,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'votacoes',?)",
                    (pid, e["data"], int(e["data"][:4]), presidente_em(e["data"]), "promulgacao", "Decreto da Assembleia da República",
                     ", ".join(decs) or None, keys[0], dre[0] if dre else None, "votacoes:fase", i0["titulo"], e["final"],
                     days(e["final"], e["data"]) if e["final"] else None, e["sent"], days(e["sent"], e["data"]) if e["sent"] else None, e["src"]))
        if dup:
            cur.execute("UPDATE atos SET extra=? WHERE id=?", (json.dumps({"possivel_duplicado_dre": True}), pid))
        n_prom += 1
    # post-pass: votações-only promulgation on a date where an UNLINKED DRE Lei was also promulgated -> possible duplicate
    cur.execute("""UPDATE atos SET extra='{"possivel_duplicado_dre": true}' WHERE fonte='votacoes' AND tipo='promulgacao' AND id LIKE 'prom:%'
                   AND EXISTS (SELECT 1 FROM atos d WHERE d.fonte='dre' AND d.tipo='promulgacao' AND d.data=atos.data
                               AND d.diploma_tipo IN ('Lei','Lei Orgânica') AND d.iniciativa_key IS NULL)""")
    con.commit()
    return dec_to_bid, ini, n_veto, n_prom, tcmap


# ----------------------------------------------------------------------------- DRE
def build_dre(con, cur):
    d = sqlite3.connect(f"file:{DATA_DIR/'dre.db'}?mode=ro", uri=True, timeout=60)
    d.row_factory = sqlite3.Row
    n = 0
    for r in d.execute("SELECT * FROM acts WHERE kind IN ('Lei','Lei Orgânica','Decreto-Lei','Decreto Regulamentar','Decreto') AND promulgated!=''"):
        try:
            sig = json.loads(r["signatories"] or "[]")
        except Exception:
            sig = []
        pres = next((re.sub(r"\s*\(Presidente.*", "", s).title().replace(" De ", " de ").replace(" Da ", " da ").replace(" Do ", " do ") for s in sig if "Presidente da República" in s), None)
        known = presidente_em(r["promulgated"])
        pres = known or pres
        orig = {"Lei": "Assembleia da República", "Lei Orgânica": "Assembleia da República", "Decreto-Lei": "Governo"}.get(r["kind"], "Governo")
        ref = f"{r['kind']} {r['number']}"
        cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,diploma_tipo,diploma_ref,dre_act_id,link_metodo,titulo,texto,data_aprovacao,dias_aprovacao,canon,fonte,source_url,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,'dre',?,?)",
                    ("dre:" + r["id"], r["promulgated"], int(r["promulgated"][:4]), pres, "promulgacao", ref.split(" ")[0] if r["kind"] != "Lei Orgânica" else "Lei Orgânica",
                     ref, r["id"], "dre:id", (r["summary"] or r["title"] or "")[:600], None, r["approved"] or None,
                     days(r["approved"], r["promulgated"]) if r["approved"] else None, r["url"] or r["source_url"],
                     json.dumps({"origem": orig, "dr_date": r["date"]}, ensure_ascii=False)))
        n += 1
    con.commit()
    # decretos do PR
    PR = [("nomeacao", r"^(Nomeia|É nomeado|São nomeados|É nomeada|Nomeia,)"), ("exoneracao", r"^(Exonera|É exonerad|São exonerad)"),
          ("ratificacao", r"^(Ratifica|É ratificad)"), ("homologacao", r"^(Homologa|É homologad|Confirma a promoção|Confirma)"),
          ("dissolucao", r"[Dd]issolve"), ("indulto", r"[Ii]ndult"), ("condecoracao", r"^(Concessão|Concede o|Agracia|Grande-Colar)|Grande-Colar|Grã-Cruz"), ("eleicoes", r"^Fixa o dia|^Marca|referendo")]
    m = 0
    for r in d.execute("SELECT * FROM acts WHERE kind='Decreto do Presidente da República'"):
        s = r["summary"] or ""
        tipo = next((t for t, rx in PR if re.search(rx, s)), "outro")
        cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,diploma_tipo,diploma_ref,dre_act_id,link_metodo,titulo,canon,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,1,'dre',?)",
                    ("dre:" + r["id"], r["date"], int(r["date"][:4]), presidente_em(r["date"]), tipo, "Decreto do Presidente da República",
                     f"Decreto do PR {r['number']}", r["id"], "dre:id", s[:600], r["url"] or r["source_url"]))
        m += 1
    con.commit()
    return n, m


# ----------------------------------------------------------------------------- Tribunal Constitucional
def parse_tc(h):
    t = text_of(h)
    i = t.find("Acordam")
    if i < 0:
        m0 = re.search(r"(?i)relat[óo]rio", t[600:])
        i = 600 + m0.start() if m0 else 0
    rel = re.sub(r"\s+", " ", t[i:i + 7000])
    first = rel[:900]
    if re.search(r"Representante da República", first):
        req = "Representante da República"
    elif re.search(r"(?:O|Pelo) Presidente da República|Presidente da República (?:veio|requer)", first):
        req = "Presidente da República"
    elif re.search(r"Primeiro-Ministro", first):
        req = "Primeiro-Ministro"
    elif re.search(r"Provedor(?:a)? de Justiça", first):
        req = "Provedor de Justiça"
    elif re.search(r"Procurador(?:a)?-Geral", first):
        req = "Procurador-Geral da República"
    elif re.search(r"deputados|Grupo Parlamentar|Deputados", first):
        req = "Deputados"
    elif re.search(r"Ministro|Governo", first):
        req = "Governo"
    else:
        req = None
    dec = None
    m = DEC_RE.search(rel)
    if m:
        dec = f"{m.group(1)}/{m.group(2)}"
    else:
        m = re.search(r"Decreto(?: [A-Za-zçãõéêáíóú ]{0,40})? n\.º\s*(\d+(?:-[A-Z])?/\d{4})", rel)
        if m:
            dec = m.group(1)
    return req, dec


def build_tc(con, cur, dec_to_bid, ini, tcmap):
    j = sqlite3.connect(f"file:{DATA_DIR/'justica.db'}?mode=ro", uri=True, timeout=60)
    j.row_factory = sqlite3.Row
    cache_j = DATA_DIR / "raw" / "justica" / "tc" / "d"
    n = 0
    rows = list(j.execute("SELECT * FROM tc_acordaos WHERE tipo IN ('Fiscalização preventiva','Fiscalização sucessiva abstrata') ORDER BY data"))
    for r in rows:
        url = r["url"] or ""
        base = url.rsplit("/", 1)[-1]
        h = None
        for p in (cache_j / base, RAW / "tc" / base):
            if p.exists():
                h = p.read_text("utf-8", "replace"); break
        if h is None and r["tipo"] == "Fiscalização preventiva" and url:
            h = http(url, cache=f"tc/{base}")
        if h is None:
            continue
        req, dec = parse_tc(h)
        if r["tipo"] == "Fiscalização sucessiva abstrata" and req != "Presidente da República":
            continue
        ini_k = None; meth = None
        if dec and dec in dec_to_bid and len(dec_to_bid[dec]) >= 1 and re.search(r"/(XV|XVI|XVII)$", dec):
            ini_k = ini_key(ini[sorted(dec_to_bid[dec])[0]]); meth = "votacoes:decreto_n"
        acid = r["id"]
        vid = None
        key_short = f"{r['num']}/{r['year']}"
        if key_short in tcmap:
            vid = tcmap[key_short]
        pres = presidente_em(r["data"])
        cur.execute("INSERT OR REPLACE INTO tc_pedidos VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (acid, r["data"], "preventiva" if r["tipo"] == "Fiscalização preventiva" else "sucessiva", req, pres, dec, r["processo"],
                     r["resultado"], ini_k, meth, vid, r["source_url"] or url))
        if req == "Presidente da República":
            cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,subtipo,diploma_tipo,diploma_ref,decreto_ref,iniciativa_key,link_metodo,titulo,acordao_tc,canon,fonte,source_url,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,'tc',?,?)",
                        ("tc:" + acid, r["data"], int(r["data"][:4]), pres, "envio_tc", "preventiva" if r["tipo"] == "Fiscalização preventiva" else "sucessiva",
                         "Decreto" , f"Acórdão TC {key_short}", dec, ini_k, meth, (r["norma"] or "")[:300] or f"Acórdão {key_short}",
                         key_short, r["source_url"] or url, json.dumps({"resultado": r["resultado"], "processo": r["processo"], "data_e_da_decisao": True}, ensure_ascii=False)))
            n += 1
        if n % 20 == 0:
            con.commit()
    con.commit()
    return n


def days_after(d, n):
    from datetime import date, timedelta
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


# ----------------------------------------------------------------------------- news -> atos / vetos
def build_news(con, cur, dec_to_bid):
    rows = cur.execute("SELECT * FROM comunicados").fetchall()
    cols = [c[0] for c in cur.description]
    vet = {r[0]: r for r in cur.execute("SELECT id,decreto_ref,data FROM vetos").fetchall()}
    for row in rows:
        r = dict(zip(cols, row))
        tipo = r["tipo"].split(":")[0]
        body = r["texto"] or ""
        m = DEC_RE.search(body)
        dec = f"{m.group(1)}/{m.group(2)}" if m else None
        if tipo == "veto":
            vid = None
            for k, (_id, dr, d) in vet.items():
                if dec and dr and dec in dr.split(", "):
                    vid = k; break
            meth = "decreto_n"
            if not vid:
                cand = [k for k, (_id, dr, d) in vet.items() if d and r["data"] <= d <= days_after(r["data"], 10) and k.startswith("veto:2")
                        and not cur.execute("SELECT 1 FROM vetos WHERE id=? AND mensagem_url IS NOT NULL", (k,)).fetchone()]
                if len(cand) == 1 and "Assembleia" in (r["titulo"] + body[:300]):
                    vid = cand[0]; meth = "data_proxima_unica"
            if vid:
                if "Tribunal Constitucional" in body[:600]:
                    cur.execute("UPDATE vetos SET motivo='tc' WHERE id=?", (vid,))
                    cur.execute("UPDATE atos SET subtipo='tc' WHERE id=?", (vid,))
                if dec:
                    cur.execute("UPDATE vetos SET decreto_ref=COALESCE(decreto_ref,?) WHERE id=?", (dec, vid))
                    cur.execute("UPDATE atos SET decreto_ref=COALESCE(decreto_ref,?) WHERE id=?", (dec, vid))
                msg = body
                cur.execute("UPDATE vetos SET mensagem_url=?, mensagem_texto=?, data_ato=? WHERE id=?", (r["url"], msg, r["data"], vid))
                cur.execute("UPDATE atos SET mensagem_url=?, texto=? WHERE id=?", (r["url"], msg[:2000], vid))
                cur.execute("UPDATE comunicados SET ato_id=?, link_metodo=? WHERE url=?", (vid, meth, r["url"]))
                continue
            vid = "veto:pr:" + r["data"]
            orig = "AR" if "Assembleia" in r["titulo"] or "Assembleia" in body[:300] else "Governo"
            motivo = "tc" if "Tribunal Constitucional" in body[:600] else "politico"
            cur.execute("INSERT OR REPLACE INTO vetos(id,data,data_ato,presidente,origem,motivo,decreto_ref,titulo,desfecho,mensagem_url,mensagem_texto,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,'presidencia.pt',?)",
                        (vid, r["data"], r["data"], presidente_em(r["data"]), orig, motivo, dec, r["titulo"], "sem_desfecho", r["url"], body, r["url"]))
            cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,subtipo,diploma_tipo,decreto_ref,link_metodo,titulo,texto,mensagem_url,canon,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'presidencia.pt',?)",
                        (vid, r["data"], int(r["data"][:4]), presidente_em(r["data"]), "veto", motivo, "Decreto da Assembleia da República" if orig == "AR" else "Decreto do Governo", dec,
                         "decreto_n" if dec else None, r["titulo"], body[:2000], r["url"], r["url"]))
            cur.execute("UPDATE comunicados SET ato_id=? WHERE url=?", (vid, r["url"]))
        elif tipo in ("promulgacao", "ratificacao"):
            # structured sources count these; the news item is kept as the President's own communiqué (canon=0)
            aid = "pr:" + urllib.parse.urlsplit(r["url"]).path.strip("/").split("/")[-1] + ":" + r["data"]
            cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,subtipo,diploma_tipo,titulo,texto,mensagem_url,canon,fonte,source_url,extra) VALUES(?,?,?,?,?,?,?,?,?,?,0,'presidencia.pt',?,?)",
                        (aid, r["data"], int(r["data"][:4]), presidente_em(r["data"]), tipo, None, r["tipo"].split(":")[-1] if ":" in r["tipo"] else None,
                         r["titulo"], body[:2000], r["url"], r["url"], json.dumps({"n_diplomas": r["n_diplomas"]})))
            cur.execute("UPDATE comunicados SET ato_id=? WHERE url=?", (aid, r["url"]))
        else:
            aid = "pr:" + urllib.parse.urlsplit(r["url"]).path.strip("/").split("/")[-1] + ":" + r["data"]
            canon = 0 if tipo == "envio_tc" else 1     # TC referrals are counted from the acórdãos
            cur.execute("INSERT OR REPLACE INTO atos(id,data,ano,presidente,tipo,titulo,texto,mensagem_url,canon,fonte,source_url) VALUES(?,?,?,?,?,?,?,?,?,'presidencia.pt',?)",
                        (aid, r["data"], int(r["data"][:4]), presidente_em(r["data"]), tipo, r["titulo"], body[:2000], r["url"], canon, r["url"]))
            cur.execute("UPDATE comunicados SET ato_id=? WHERE url=?", (aid, r["url"]))
    con.commit()


# ----------------------------------------------------------------------------- derived
def finish(con, cur):
    # outcome / promulgation date of vetoes -> enrich with DRE publication of the final law when known
    cur.execute("""UPDATE vetos SET desfecho_detalhe = CASE desfecho
        WHEN 'confirmado' THEN 'A Assembleia confirmou o decreto por maioria absoluta (art. 136.º, n.º 3 CRP); o Presidente teve de promulgar.'
        WHEN 'reformulado' THEN 'A Assembleia reapreciou e aprovou um novo texto.'
        WHEN 'caducou' THEN 'A iniciativa caducou com o fim da legislatura sem reapreciação.'
        WHEN 'em_reapreciacao' THEN 'Reapreciação iniciada; sem votação final nos dados.'
        ELSE 'Sem desfecho determinável nos dados da votação.' END WHERE desfecho_detalhe IS NULL""")
    # link TC acórdão -> veto/atos by explicit acórdão number
    con.commit()
    L = []
    c = cur.execute
    c("DELETE FROM cobertura")
    L.append(("presidencia.pt", "Só guarda o mandato atual (desde 2026-03-09). Sem sitemap nem robots.txt; listagem 'Atividade Legislativa' lida pelo endpoint do próprio site."))
    L.append(("votacoes", "Fases de promulgação/veto por iniciativa: legislaturas XV–XVII (2022-04 em diante). Vetos anteriores a 2022 (Marcelo 2016–2022, Cavaco 2006–2016) não têm fonte estruturada acessível."))
    L.append(("dre", "Datas de promulgação de Leis/Decretos-Lei completas só de 2024 em diante (parcial antes). Decretos do Presidente da República (nomeações, ratificações, homologações) só desde 2024-01."))
    L.append(("tc", "Pedidos de fiscalização do Presidente (preventiva) identificados no texto do acórdão; a data mostrada é a da decisão do TC, não a do pedido. Sucessiva: só acórdãos em cache local."))
    L.append(("wikipedia", "Não existe lista de vetos em pt.wikipedia; não usada."))
    L.append(("promulgacoes_periodos", "Promulgações de decretos da AR por ano, uma fonte por período: antes de 2022-04-27 só DRE (parcial, subcontagem); 2022-04-27 a 2023-12-31 só votações (fases «Promulgação», datas e dias da votação final), com o ato do DRE usado apenas para ligar; desde 2024-01-01 DRE completo + decretos ainda sem lei publicada. Decretos-Lei: sempre DRE (parcial antes de 2024). 2022 mistura DRE (até 26 abr) e votações (depois)."))
    L.append(("ligacoes", "Ligação a iniciativas só por referência explícita (n.º do Decreto da AR/legislatura, n.º do acórdão do TC, dre_act_id das votações); sem comparação de títulos."))
    c("INSERT OR REPLACE INTO meta VALUES('built_at', datetime('now'))")
    for k, v in L:
        c("INSERT OR REPLACE INTO cobertura VALUES(?,?)", (k, v))
    # TC-related: link tc rows' veto_id to atos acordao_tc already stored; nothing else
    con.commit()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    con = connect_writer(DB)
    con.executescript(SCHEMA)
    cur = con.cursor()
    for t in ("atos", "vetos", "tc_pedidos") + (() if SINCE else ("comunicados",)):
        cur.execute(f"DELETE FROM {t}")
    con.commit()
    n_news = fetch_presidencia(cur)
    print("presidencia.pt comunicados:", n_news)
    n_dre, n_pr = build_dre(con, cur)
    print("DRE promulgações:", n_dre, "decretos PR:", n_pr)
    dec_to_bid, ini, n_veto, n_prom, tcmap = build_votacoes(con, cur)
    print("votacoes vetos:", n_veto, "promulgações extra:", n_prom)
    n_tc = build_tc(con, cur, dec_to_bid, ini, tcmap)
    print("TC pedidos do PR:", n_tc)
    build_news(con, cur, dec_to_bid)
    finish(con, cur)
    for t in ("atos", "vetos", "tc_pedidos", "comunicados"):
        print(t, cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])
    ultima = cur.execute("SELECT MAX(data) FROM comunicados").fetchone()[0]
    con.close()
    if SINCE:
        report(ultima)


if __name__ == "__main__":
    main()
