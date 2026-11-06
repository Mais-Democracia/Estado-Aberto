import logging
import re
import sqlite3
from difflib import SequenceMatcher
import unicodedata
from datetime import date, timedelta

LEI_KINDS = ("Lei", "Lei Orgânica", "Lei Constitucional", "Decreto da Assembleia da República")
RES_KINDS = ("Resolução da Assembleia da República",)
ACT_KINDS = LEI_KINDS + RES_KINDS
LINK_DAYS = 30
MIN_PREFIX = 60
CITE = re.compile(r"(Proposta de Lei|Projeto de Lei|Proposta de Resolução|Projeto de Resolução)\s+n\.?\s*º\s*(\d+)/([XVI]+)", re.I)
ELLIPSIS = re.compile(r"\s*(?:…|\.{3,})\s*$")
FUZZY_MIN = 0.80
FUZZY_SURE = 0.92
FUZZY_GAP = 0.05
FUZZY_MONTHS = 14
AWAIT_DAYS = 120
STOPW = frozenset("a o as os um uma uns umas de do da dos das e em no na nos nas ao aos por para com sobre que se ou pelo pela pelos pelas entre".split())
LAW_CITE = re.compile(r"(Decreto[- ]Lei|Lei Orgânica|Lei|Decreto Legislativo Regional|Decreto Regulamentar|Portaria)\s+n\.?\s*º\s*(\d+(?:-[A-Z])?)/(\d{4})", re.I)
log = logging.getLogger("linking")
TABLE = "CREATE TABLE IF NOT EXISTS act_initiatives (act_id TEXT, initiative_key TEXT, method TEXT, score REAL, evidence TEXT, UNIQUE(act_id, initiative_key))"


def norm_title(s):
    s = unicodedata.normalize("NFKD", ELLIPSIS.sub("", str(s or "").strip()))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def truncated(s):
    return bool(ELLIPSIS.search(str(s or "").strip()))


def ref_of(act):
    return f"{act.get('kind')} {str(act.get('number') or '').strip()}"


def compatible(act, ini):
    tipo = str(ini.get("tipo") or "")
    if act.get("kind") in RES_KINDS:
        ok = "Resolução" in tipo
    else:
        ok = "Lei" in tipo and "Resolução" not in tipo
    leg = act.get("legislature")
    return ok and (not leg or not ini.get("leg") or leg == ini["leg"])


def approved(ini):
    return bool(ini.get("lei_ref")) or str(ini.get("resultado_final") or "").startswith("Aprovado") or str(ini.get("estado") or "") == "Publicado"


def load_initiatives(vcon):
    if vcon is None:
        return []
    try:
        cur = vcon.execute("SELECT bid, key, tipo, numero, leg, titulo, lei_ref, estado, resultado_final, data_votacao_final FROM iniciativas WHERE titulo IS NOT NULL")
    except sqlite3.Error:
        return []
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur]


def title_hits(act, cands):
    t = norm_title(act.get("summary") or act.get("title"))
    if len(t) < 25:
        return []
    out = []
    for i in cands:
        raw = i.get("titulo")
        n = norm_title(raw)
        if n == t:
            out.append((i, 0.98))
        elif truncated(raw) and len(n) >= MIN_PREFIX and t.startswith(n):
            out.append((i, 0.95))
        elif truncated(act.get("summary")) and len(t) >= MIN_PREFIX and n.startswith(t):
            out.append((i, 0.95))
    return out


def narrow(hits, act):
    if len(hits) <= 1:
        return hits
    done = [h for h in hits if str(h[0].get("data_votacao_final") or "") <= str(act.get("date") or "9999")]
    return done if len(done) == 1 else []


def match(act, inis, taken=None):
    cands = [i for i in inis if compatible(act, i)]
    ref = ref_of(act)
    by_ref = [i for i in cands if i.get("lei_ref") and norm_title(i["lei_ref"]) == norm_title(ref)]
    if by_ref:
        return [dict(i, method="lei_ref", score=1.0, evidence=ref) for i in by_ref]
    raw_hits = title_hits(act, [i for i in cands if approved(i)])
    hits = narrow(raw_hits, act)
    if raw_hits and not hits:
        log.warning("título exato ambíguo: %s", ref_of(act))
        return []
    if hits:
        return [dict(i, method="título exato", score=sc, evidence=str(act.get("summary") or "")[:200]) for i, sc in hits]
    keys = {}
    for m in CITE.finditer(f"{act.get('summary') or ''}\n{act.get('text') or ''}"):
        kind = m.group(1)[0].upper() + m.group(1)[1:].lower().replace("resolução", "Resolução").replace("lei", "Lei")
        keys[f"{kind}|{int(m.group(2))}|{m.group(3).upper()}"] = m.group(0)
    cited = [i for i in cands if i.get("key") in keys and approved(i)]
    if len(cited) == 1:
        return [dict(cited[0], method="citação no texto", score=0.9, evidence=keys[cited[0]["key"]])]
    return fuzzy(act, cands, taken)


def tokens(s):
    return [w for w in norm_title(s).split() if w not in STOPW]


def citations(*texts):
    out = set()
    for t in texts:
        for m in LAW_CITE.finditer(str(t or "")):
            kind = re.sub(r"[- ]", "", norm_title(m.group(1)))
            out.add(f"{kind} {m.group(2).upper()}/{m.group(3)}")
    return out


def ngram_bonus(a, b, n=4):
    grams = {tuple(a[i:i + n]) for i in range(len(a) - n + 1)}
    shared = sum(1 for i in range(len(b) - n + 1) if tuple(b[i:i + n]) in grams)
    return min(0.04, 0.01 * shared)


def similarity(ta, tb):
    if not ta or not tb:
        return 0.0
    sa, sb = set(ta), set(tb)
    jac = len(sa & sb) / len(sa | sb)
    seq = SequenceMatcher(None, ta, tb, autojunk=False).ratio()
    return 0.5 * jac + 0.5 * seq


def months_before(iso, months):
    y, m, d = int(iso[:4]), int(iso[5:7]), int(iso[8:10])
    m -= months
    while m < 1:
        m += 12
        y -= 1
    return f"{y:04d}-{m:02d}-{min(d, 28):02d}"


def fresh_approved(ini):
    return str(ini.get("estado") or "").startswith("Aprovado") or str(ini.get("resultado_final") or "").startswith("Aprovado")


def fuzzy(act, cands, taken=None):
    if act.get("kind") not in LEI_KINDS:
        return []
    adate = str(act.get("date") or date.today().isoformat())[:10]
    floor = months_before(adate, FUZZY_MONTHS)
    ref = norm_title(ref_of(act))
    ta = tokens(act.get("summary") or act.get("title"))
    if len(ta) < 6:
        return []
    own = citations(ref_of(act))
    acits = citations(act.get("summary"), act.get("title")) - own
    scored = []
    for i in cands:
        vd = str(i.get("data_votacao_final") or "")[:10]
        if not fresh_approved(i) or not vd or not floor <= vd <= adate:
            continue
        if i.get("lei_ref") and norm_title(i["lei_ref"]) != ref:
            continue
        if taken and taken.get(i.get("key")) not in (None, act.get("id")):
            continue
        tb = tokens(i.get("titulo"))
        sim = similarity(ta, tb) + ngram_bonus(ta, tb)
        shared = sorted(acits & citations(i.get("titulo")))
        wait = str(i.get("estado") or "").startswith("Aprovado (aguarda")
        if wait and (date.fromisoformat(adate) - date.fromisoformat(vd)).days <= AWAIT_DAYS:
            sim += 0.03
        scored.append((min(sim, 1.0), i, shared))
    scored.sort(key=lambda x: -x[0])
    if not scored or scored[0][0] < FUZZY_MIN:
        return []
    top, ini, shared = scored[0]
    if not shared and top < FUZZY_SURE:
        log.info("título aproximado sem citação em comum: %s -> %s (%.2f)", ref_of(act), ini.get("key"), top)
        return []
    if len(scored) > 1 and top - scored[1][0] < FUZZY_GAP:
        log.warning("título aproximado ambíguo: %s -> %s (%.2f) / %s (%.2f)", ref_of(act), ini.get("key"), top, scored[1][1].get("key"), scored[1][0])
        return []
    ev = f"similaridade {top:.2f}; citações em comum: {', '.join(shared) or 'nenhuma'}; votação final {ini.get('data_votacao_final')}"
    return [dict(ini, method="título aproximado", score=round(top, 3), evidence=ev)]


def best(act, vcon):
    hits = match(act, load_initiatives(vcon))
    return max(hits, key=lambda h: h["score"]) if hits else None


def recent_acts(dcon, days):
    q = "SELECT * FROM acts WHERE kind IN (%s)" % ",".join("?" * len(ACT_KINDS))
    args = list(ACT_KINDS)
    if days:
        q += " AND date >= ?"
        args.append((date.today() - timedelta(days=days)).isoformat())
    cur = dcon.execute(q, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur]


def link_acts(dcon, vcon, days=LINK_DAYS):
    dcon.execute(TABLE)
    linked = {r[0] for r in dcon.execute("SELECT act_id FROM act_initiatives")}
    inis = load_initiatives(vcon)
    taken = {k: a for a, k in dcon.execute("SELECT act_id, initiative_key FROM act_initiatives")}
    n = 0
    for act in recent_acts(dcon, days):
        if act["id"] in linked:
            continue
        for h in match(act, inis, taken):
            taken[h["key"]] = act["id"]
            dcon.execute("INSERT OR IGNORE INTO act_initiatives VALUES (?,?,?,?,?)", (act["id"], h["key"], h["method"], h["score"], h["evidence"]))
            n += 1
    dcon.commit()
    return n


def sync_initiatives(vcon, dcon, days=LINK_DAYS):
    n = 0
    for act in recent_acts(dcon, days):
        for key, in dcon.execute("SELECT initiative_key FROM act_initiatives WHERE act_id=?", (act["id"],)).fetchall():
            cur = vcon.execute("UPDATE iniciativas SET lei_ref=?, dr_date=COALESCE(dr_date, ?), "
                               "estado=CASE WHEN estado LIKE 'Aprovado%' THEN 'Publicado' ELSE estado END WHERE key=? AND lei_ref IS NULL",
                               (ref_of(act), act.get("date"), key))
            n += cur.rowcount
    vcon.commit()
    return n
