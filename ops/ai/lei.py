import json
import os
import re
import sqlite3
import sys
from pathlib import Path

from lib import ROOT, data_dir, open_ro, wrap

sys.path.insert(0, str(ROOT / "ingest"))
import linking  # noqa: E402

VOTE_MODS = ("votos", "votacoes", "intervencoes", "iniciativas")
SENSOS = ("favor", "contra", "abstencao")
SPEECH_CAP = 1800
FACT_SPEECHES = 10
FACT_VOTES = 12
LISTA_CAP = 200
BLOCO_SPEECHES = 6
MIN_WORDS = 60
EXCERTO_MAX = 280
MAX_EARLIER = 8
MAX_ANEXOS = 30
SALUDO = re.compile(r"^(?:Sr|Sra|Srs|Sras|Sr\.as|Exm|Ex\.|Caros?|Caras?|Muito\s+(?:bom|boa|obrigad)|Presidente|Ministr|Secret|Deputad|Vice|Boa)", re.I)
ABREV = {"sr", "sra", "srs", "sras", "dr", "dra", "exm", "exma", "prof", "art", "n", "al", "cf", "pp", "p", "ex"}


def pk(c):
    return re.sub(r"[.\s]", "", str(c)).replace("–", "-").upper()


def src_dir():
    return Path(os.environ.get("ESTADO_ABERTO_SOURCE_DATA") or data_dir()).expanduser().resolve()


_OPEN = []


def db(name):
    p = src_dir() / f"{name}.db"
    if not p.exists():
        return None
    try:
        con = open_ro(p)
    except Exception:
        return None
    _OPEN.append(con)
    return con


def close_all():
    while _OPEN:
        try:
            _OPEN.pop().close()
        except sqlite3.Error:
            pass


def q(con, sql, args=()):
    if con is None:
        return []
    try:
        return [dict(r) for r in con.execute(sql, args)]
    except sqlite3.Error:
        return []


def one(con, sql, args=()):
    r = q(con, sql, args)
    return r[0] if r else None


def rota_ini(key, bid):
    return f"#/votacoes/{bid}" if bid else None


def empty_blocos():
    return {"lei": None, "votacao": None, "votacoes_anteriores": [], "intervencoes": []}


def entity_bid(row):
    ents = row.get("entidades")
    if isinstance(ents, str):
        try:
            ents = json.loads(ents)
        except ValueError:
            ents = []
    for e in ents or []:
        if isinstance(e, dict) and e.get("tipo") == "iniciativa" and str(e.get("id") or "").isdigit():
            return int(e["id"])
    return None


def match_bid(act_id):
    act = dre_act(act_id)
    if not act or act.get("kind") not in linking.ACT_KINDS:
        return None
    hit = linking.best(act, db("votacoes"))
    return hit["bid"] if hit else None


def locate(row):
    mod, ref = row.get("fonte_modulo"), str(row.get("fonte_ref") or "")
    vcon = db("votacoes")
    bid, vote_id, act_id = None, None, None
    if mod in ("votos", "votacoes") and row.get("tipo") in ("votacao", "votacao_final") and ref.isdigit():
        v = one(vcon, "SELECT id, bid FROM votos WHERE id=?", (int(ref),))
        if v:
            bid, vote_id = v["bid"], v["id"]
    elif mod in ("intervencoes", "iniciativas", "votacoes") and ref.isdigit():
        bid = int(ref)
    elif mod in ("acts", "dre"):
        act_id = ref
        i = one(vcon, "SELECT bid FROM iniciativas WHERE dre_act_id=?", (ref,))
        if not i:
            link = one(db("dre"), "SELECT initiative_key FROM act_initiatives WHERE act_id=? ORDER BY score DESC", (ref,))
            if link:
                i = one(vcon, "SELECT bid FROM iniciativas WHERE key=?", (link["initiative_key"],))
        bid = i["bid"] if i else None
    elif mod in ("atos", "presidencia"):
        a = one(db("presidencia"), "SELECT iniciativa_key, dre_act_id FROM atos WHERE id=?", (ref,))
        if a:
            act_id = a.get("dre_act_id") or None
            i = one(vcon, "SELECT bid FROM iniciativas WHERE key=?", (a.get("iniciativa_key"),)) if a.get("iniciativa_key") else None
            if not i and act_id:
                i = one(vcon, "SELECT bid FROM iniciativas WHERE dre_act_id=?", (act_id,))
            bid = i["bid"] if i else None
    if bid is None:
        bid = entity_bid(row)
    if bid is None and act_id:
        bid = linked_bid(act_id) or match_bid(act_id)
    return bid, vote_id, act_id


def linked_bid(act_id):
    link = one(db("dre"), "SELECT initiative_key FROM act_initiatives WHERE act_id=? ORDER BY score DESC", (act_id,))
    i = one(db("votacoes"), "SELECT bid FROM iniciativas WHERE key=?", (link["initiative_key"],)) if link else None
    return i["bid"] if i else None


def variante(row):
    return "votacao" if row.get("fonte_modulo") in VOTE_MODS else "lei"


def seats(vcon, leg):
    out = {}
    for r in q(db("politica"), "SELECT code, seats FROM parties"):
        out[pk(r["code"])] = int(r["seats"] or 0)
    if not out and leg:
        m = one(vcon, "SELECT value FROM meta WHERE key=?", ("seats_" + str(leg),))
        try:
            out = {pk(k): int(v) for k, v in json.loads(m["value"]).items()} if m else {}
        except (ValueError, TypeError, AttributeError):
            out = {}
    return out


def vote_bloco(v):
    return {"data": v["data"], "fase": v["fase"], "orgao": v["orgao"], "resultado": v["resultado"], "unanime": bool(v["unanime"]),
            "por_partido": [{"partido": r["partido"], "voto": r["sentido"], "lugares": r["lugares"]} for r in v["por_partido"]],
            "totais": {"favor": v["totais"]["favor"], "contra": v["totais"]["contra"], "abstencao": v["totais"]["abstencao"]}}


def plenary_votes(vcon, bid, seat_map, main_id):
    out = []
    for v in q(vcon, "SELECT * FROM votos WHERE bid=? ORDER BY data, id", (bid,)):
        plen = v.get("orgao") == "Plenário"
        gp = q(vcon, "SELECT partido, sentido FROM voto_partido WHERE voto_id=? AND kind=?", (v["id"], "gp"))
        split = sorted({r["partido"] for r in q(vcon, "SELECT partido FROM voto_partido WHERE voto_id=? AND kind IN (?,?)", (v["id"], "dividido", "parcial"))} - {r["partido"] for r in gp})
        rows = [{"partido": r["partido"], "sentido": r["sentido"], "lugares": seat_map.get(pk(r["partido"]))} for r in gp]
        expandido = False
        if plen and v["unanime"] and seat_map and not any(r["sentido"] in ("contra", "abstencao") for r in rows):
            have = {pk(r["partido"]) for r in rows} | {pk(p) for p in split}
            for code, n in sorted(seat_map.items(), key=lambda kv: -kv[1]):
                if n > 0 and code not in have:
                    rows.append({"partido": code, "sentido": "favor", "lugares": n})
                    expandido = True
        rows.sort(key=lambda r: (-(r["lugares"] or 0), r["partido"]))
        known = plen and bool(rows) and all(r["lugares"] is not None for r in rows)
        tot = {s: (sum(r["lugares"] for r in rows if r["sentido"] == s) if known else None) for s in SENSOS}
        listas = {s: str(v[s])[:LISTA_CAP] for s in SENSOS if v.get(s)}
        out.append({"id": v["id"], "data": v["data"], "fase": v["fase"], "orgao": v.get("orgao"), "resultado": v["resultado"], "unanime": bool(v["unanime"]), "unanimidade_expandida": expandido,
                    "por_partido": rows, "partidos_divididos": split, "totais": tot, "listas": listas})
    plenary = [v for v in out if v["orgao"] == "Plenário"]
    main = next((v for v in plenary if v["id"] == main_id), None)
    if main is None:
        final = [v for v in plenary if str(v["fase"] or "").lower().startswith("votação final")]
        main = (final or plenary or [None])[-1]
    return out, main


def ordered_speeches(rows):
    good = [r for r in rows if (r.get("palavras") or 0) >= MIN_WORDS and r.get("texto")] or [r for r in rows if r.get("texto")]
    groups = {}
    for r in sorted(good, key=lambda r: (-(r.get("palavras") or 0), r["id"])):
        groups.setdefault(r.get("partido") or "", []).append(r)
    order = sorted(groups, key=lambda k: -(groups[k][0].get("palavras") or 0))
    out = []
    i = 0
    while any(i < len(groups[k]) for k in order):
        out += [groups[k][i] for k in order if i < len(groups[k])]
        i += 1
    return out


def sentences(text):
    out, start = [], 0
    for m in re.finditer(r"[.!?]+\s+", text):
        prev = text[start:m.start()].split()
        last = prev[-1].lower() if prev else ""
        if text[m.start()] == "." and last in ABREV:
            continue
        out.append((start, m.start() + 1))
        start = m.end()
    if start < len(text):
        out.append((start, len(text)))
    return out


def lead_end(text):
    pos = 0
    while True:
        m = re.match(r"[^,:]*?[,:]\s*", text[pos:])
        if not m or not SALUDO.match(text[pos:pos + m.end()].strip()):
            return pos
        pos += m.end()


def excerto(text):
    text = text or ""
    start = lead_end(text)
    spans = [(a, b) for a, b in sentences(text) if b > start]
    spans = [(max(a, start), b) for a, b in spans]
    spans = [(a, b) for a, b in spans if b - a >= 30] or spans
    if not spans:
        return ""
    a, b = spans[0]
    for _, nb in spans[1:]:
        if nb - a <= EXCERTO_MAX:
            b = nb
        else:
            break
    seg = text[a:b]
    if len(seg) > EXCERTO_MAX:
        seg = seg[:EXCERTO_MAX]
        cut = seg.rfind(" ")
        seg = seg[:cut] if cut > 100 else seg
    return seg.strip()


def load_speeches(bid):
    icon = db("intervencoes")
    rows = q(icon, "SELECT i.* FROM intervencoes i "
                   "WHERE i.id IN (SELECT iv_id FROM iv_ini WHERE bid=?)", (bid,))
    return ordered_speeches(rows), len(rows)


def dre_act(act_id):
    if not act_id:
        return None
    return one(db("dre"), "SELECT * FROM acts WHERE id=?", (act_id,))


def build_lei(row):
    try:
        return _build_lei(row)
    finally:
        close_all()


def _build_lei(row):
    bid, vote_id, act_id = locate(row)
    vcon = db("votacoes")
    ini = one(vcon, "SELECT * FROM iniciativas WHERE bid=?", (bid,)) if bid else None
    if not act_id and ini:
        act_id = ini.get("dre_act_id") or None
    act = dre_act(act_id)
    if act and act.get("kind") not in ("Lei", "Decreto-Lei", "Lei Orgânica", "Lei Constitucional") and not ini:
        return None, empty_blocos()
    if not ini and not act:
        return None, empty_blocos()
    blocos = empty_blocos()
    facts = {"texto_disponivel": False, "texto_origem": None}
    key = ini.get("key") if ini else None
    rota = rota_ini(key, bid) if ini else None
    if ini:
        autores = [{"nome": a["nome"], "partido": a["partido"]} for a in q(vcon, "SELECT nome, partido FROM autores WHERE bid=?", (bid,))][:20]
        fases = [{"data": f["data"], "fase": f["fase"], "comissao": f["comissao"]} for f in q(vcon, "SELECT data, fase, comissao FROM fases WHERE bid=? ORDER BY ord", (bid,))][-40:]
        facts["iniciativa"] = {"bid": bid, "key": key, "tipo": ini.get("tipo"), "numero": ini.get("numero"), "legislatura": ini.get("leg"),
                               "titulo": ini.get("titulo"), "autoria": ini.get("autoria"), "autores": autores, "origem": ini.get("origem"),
                               "data_entrada": ini.get("data_entrada"), "estado": ini.get("estado"), "ultima_fase": ini.get("ultima_fase"),
                               "resultado_final": ini.get("resultado_final"), "data_votacao_final": ini.get("data_votacao_final"),
                               "lei_ref": ini.get("lei_ref"), "dr_ref": ini.get("dr_ref"), "dr_date": ini.get("dr_date"), "rota": rota, "url": ini.get("source_url")}
        facts["fases"] = fases
        facts["anexos"] = [{"nome": a["nome"], "tipo": a["tipo"]} for a in q(vcon, "SELECT nome, tipo FROM iniciativa_anexos WHERE bid=? ORDER BY rowid", (bid,))][:MAX_ANEXOS]
        votes, main = plenary_votes(vcon, bid, seats(vcon, ini.get("leg")), vote_id)
        facts["votacoes"] = votes[-FACT_VOTES:]
        facts["votacao_principal"] = main["id"] if main else None
        speeches, total = load_speeches(bid)
        facts["intervencoes_total"] = total
        deps = [s for s in speeches if s.get("kind") == "dep"] or speeches
        picked = []
        for s in deps[:BLOCO_SPEECHES]:
            ex = excerto(s["texto"] or "")
            if ex and ex in s["texto"]:
                picked.append((s, ex))
        shown = [s for s, _ in picked]
        shown += [s for s in speeches if s not in shown][:max(0, FACT_SPEECHES - len(shown))]
        facts["intervencoes"] = [{"id": s["id"], "orador": s["orador"], "partido": s["partido"], "cargo": s["cargo"], "tipo": s.get("kind"), "data": s["data"],
                                  "rota": rota, "source_url": s.get("source_url"), "detalhe": (s["texto"] or "")[:SPEECH_CAP]} for s in shown]
        blocos["lei"] = {"titulo": ini.get("titulo"), "tipo": ini.get("tipo"), "numero": ini.get("numero"), "legislatura": ini.get("leg"),
                         "autor": ini.get("autoria"), "origem": ini.get("origem"), "rota": rota, "texto_url": None}
        if main:
            blocos["votacao"] = vote_bloco(main)
            mi = votes.index(main)
            earlier = [v for v in votes[:mi] if v["por_partido"] or v["resultado"]]
            blocos["votacoes_anteriores"] = [vote_bloco(v) for v in earlier[-MAX_EARLIER:]]
        for s, ex in picked:
            blocos["intervencoes"].append({"id": s["id"], "deputado": s["orador"], "partido": s["partido"] or "", "data": s["data"], "excerto": ex, "rota": rota})
    if act:
        facts["dre"] = {"id": act["id"], "tipo": act.get("kind"), "numero": act.get("number"), "data": act.get("date"), "titulo": act.get("title"),
                        "sumario": act.get("summary"), "url": act.get("url") or act.get("source_url"), "pdf_url": act.get("pdf_url"),
                        "texto_local": bool(act.get("text"))}
        if not blocos["lei"]:
            blocos["lei"] = {"titulo": act.get("title"), "tipo": act.get("kind"), "numero": act.get("number"), "legislatura": None,
                             "autor": None, "rota": "#/dre/" + str(act["id"]), "texto_url": None}
    if act and not ini:
        facts["iniciativa_parlamentar"] = False
        if act.get("kind") in linking.ACT_KINDS:
            facts["aviso_votacao"] = "não foi possível associar este diploma a uma iniciativa parlamentar: não afirmes nada sobre votação ou debate"
        else:
            facts["aviso_votacao"] = "este diploma não passou por votação em plenário da Assembleia da República"
    facts["lei_em_vigor"] = bool(act or (ini and (ini.get("lei_ref") or ini.get("dr_ref"))))
    return facts, blocos


def fetch_law_text(facts, cfg, workdir):
    try:
        return _fetch_law_text(facts, cfg, workdir)
    finally:
        close_all()


def _fetch_law_text(facts, cfg, workdir):
    cap = cfg["pdf"]["max_chars"]
    dre = facts.get("dre") or {}
    if dre.get("id") and dre.get("texto_local"):
        t = (one(db("dre"), "SELECT text FROM acts WHERE id=?", (dre["id"],)) or {}).get("text") or ""
        if t.strip():
            return re.sub(r"\n{3,}", "\n\n", t)[:cap], "dre.db", dre.get("url") or dre.get("pdf_url")
    return "", None, None


def apply_text(bdir, ctx_cfg):
    facts_p, blocos_p = bdir / "facts.json", bdir / "blocos.json"
    facts = json.loads(facts_p.read_text(encoding="utf-8"))
    lei = facts.get("lei")
    if not lei:
        return False
    txt, origem, url = fetch_law_text(lei, ctx_cfg, bdir)
    if txt.strip():
        (bdir / "texto.txt").write_text(wrap(txt), encoding="utf-8")
    lei["texto_disponivel"] = bool(txt.strip())
    lei["texto_origem"] = origem
    if not txt.strip():
        lei["aviso_texto"] = "o texto da iniciativa não estava disponível"
    facts_p.write_text(json.dumps(facts, ensure_ascii=False, indent=1), encoding="utf-8")
    blocos = json.loads(blocos_p.read_text(encoding="utf-8"))
    if blocos.get("lei"):
        blocos["lei"]["texto_url"] = url if txt.strip() else None
        blocos_p.write_text(json.dumps(blocos, ensure_ascii=False, indent=1), encoding="utf-8")
    if txt.strip() and url:
        fp = bdir / "fontes.json"
        fo = json.loads(fp.read_text(encoding="utf-8"))
        fo["hrefs_permitidos"] = sorted(set(fo.get("hrefs_permitidos", [])) | {url})
        fp.write_text(json.dumps(fo, ensure_ascii=False, indent=1), encoding="utf-8")
    return bool(txt.strip())
