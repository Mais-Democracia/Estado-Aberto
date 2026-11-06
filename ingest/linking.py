import re
import sqlite3
import unicodedata
from datetime import date, timedelta

LEI_KINDS = ("Lei", "Lei Orgânica", "Lei Constitucional", "Decreto da Assembleia da República")
RES_KINDS = ("Resolução da Assembleia da República",)
ACT_KINDS = LEI_KINDS + RES_KINDS
LINK_DAYS = 30
MIN_PREFIX = 60
CITE = re.compile(r"(Proposta de Lei|Projeto de Lei|Proposta de Resolução|Projeto de Resolução)\s+n\.?\s*º\s*(\d+)/([XVI]+)", re.I)
ELLIPSIS = re.compile(r"\s*(?:…|\.{3,})\s*$")
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


def match(act, inis):
    cands = [i for i in inis if compatible(act, i)]
    ref = ref_of(act)
    by_ref = [i for i in cands if i.get("lei_ref") and norm_title(i["lei_ref"]) == norm_title(ref)]
    if by_ref:
        return [dict(i, method="lei_ref", score=1.0, evidence=ref) for i in by_ref]
    hits = narrow([h for h in title_hits(act, [i for i in cands if approved(i)])], act)
    if hits:
        return [dict(i, method="título exato", score=sc, evidence=str(act.get("summary") or "")[:200]) for i, sc in hits]
    keys = {}
    for m in CITE.finditer(f"{act.get('summary') or ''}\n{act.get('text') or ''}"):
        kind = m.group(1)[0].upper() + m.group(1)[1:].lower().replace("resolução", "Resolução").replace("lei", "Lei")
        keys[f"{kind}|{int(m.group(2))}|{m.group(3).upper()}"] = m.group(0)
    cited = [i for i in cands if i.get("key") in keys and approved(i)]
    if len(cited) == 1:
        return [dict(cited[0], method="citação no texto", score=0.9, evidence=keys[cited[0]["key"]])]
    return []


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
    n = 0
    for act in recent_acts(dcon, days):
        if act["id"] in linked:
            continue
        for h in match(act, inis):
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
