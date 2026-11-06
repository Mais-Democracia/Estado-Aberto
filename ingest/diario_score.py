import datetime as dt
import json
import math
import os
import sqlite3
from pathlib import Path

BASE = {
    "veto": 90,
    "votacao_final": 80,
    "promulgacao": 60,
    "presidencia_dia": 85,
    "acordao_constitucional": 75,
    "agenda_semana": 70,
    "governo_cm": 70,
    "leis_em_curso_dia": 65,
    "contratos_destaque_dia": 45,
    "fundos_dia": 35,
    "poder_local_dia": 35,
    "regioes_dia": 30,
    "auditoria_tc": 55,
    "sancao_regulador": 50,
    "nomeacao_conselho": 40,
    "contrato_grande": 20,
    "debate": 25,
}
DEFAULT_BASE = 10
NARROW_SEATS = 10
BONUS_NARROW = 15
BONUS_REJECTED = 10
BONUS_RISK = 10
BONUS_FIRST = 10
LAG_FREE_DAYS = 2
LAG_PENALTY = 5
STALE_DAYS = 5
AGENDA_DIAS = 7
STALE_PENALTY = 40
FIRST_TYPES = frozenset({"veto", "sancao_regulador", "auditoria_tc", "relatorio_igf", "relatorio_igf_municipal", "relatorio_provedor", "promulgacao"})
SECTIONS = ("parlamento", "governo", "fiscalizacao", "nomeacoes", "poder-local", "dinheiro", "indicadores")


def log_amount(amount):
    try:
        v = float(amount)
    except (TypeError, ValueError):
        return 0.0
    return math.log10(v) if v > 1 else 0.0


def base_score(tipo, amount=None):
    b = BASE.get(tipo, DEFAULT_BASE)
    if tipo in ("sancao_regulador", "contrato_grande"):
        b += log_amount(amount)
    return float(b)


def is_narrow(margin, limit=NARROW_SEATS):
    return margin is not None and margin >= 0 and margin <= limit


def is_stale(lag_days):
    return int(lag_days or 0) > STALE_DAYS


def stale_event(data_evento, edicao_data):
    try:
        d = (dt.date.fromisoformat(str(edicao_data)[:10]) - dt.date.fromisoformat(str(data_evento)[:10])).days - 1
    except (TypeError, ValueError):
        return False
    return is_stale(d)


def lag_penalty(lag_days):
    return LAG_PENALTY * max(0, int(lag_days or 0) - LAG_FREE_DAYS)


def score(tipo, amount=None, narrow=False, rejected=False, risk=False, first=False, lag_days=0):
    s = base_score(tipo, amount)
    if tipo == "votacao_final":
        if narrow:
            s += BONUS_NARROW
        if rejected:
            s += BONUS_REJECTED
    if risk:
        s += BONUS_RISK
    if first:
        s += BONUS_FIRST
    s -= lag_penalty(lag_days)
    if is_stale(lag_days):
        s -= STALE_PENALTY
    return round(max(0.0, s), 4)


def select_shortlist(rows, n=200, per_section=None):
    ordered = sorted((r for r in rows if not stale_event(r.get("data_evento"), r.get("edicao_data"))), key=lambda r: (-float(r["score"]), int(r["id"])))
    taken, count = [], {}
    for r in ordered:
        sec = r["secao"]
        if per_section is not None and count.get(sec, 0) >= per_section:
            continue
        count[sec] = count.get(sec, 0) + 1
        taken.append(r)
        if len(taken) >= n:
            break
    return [int(r["id"]) for r in taken]


def private_nif(nif):
    n = str(nif or "").strip()
    return not n or n[0] in "1234"


def agenda_classe(section):
    t = str(section or "").lower()
    if "plen" in t:
        return "plenario"
    if "comiss" in t or "audi" in t or "grupo de trabalho" in t:
        return "comissoes"
    return "outros"


DESTAQUE_RATIO = 5
DESTAQUE_MIN = 10000
DESTAQUE_MIN_N = 5
DESTAQUE_DIRECT = 100000
DESTAQUE_SINGLE = 50000
DESTAQUE_CAP = 5
DESTAQUE_KINDS = ("valor_atipico", "ajuste_direto", "proposta_unica")


def destaques(q, day, cap=DESTAQUE_CAP):
    rows = q("SELECT * FROM contracts WHERE published = ? AND price > 0", (day,))
    out = {"total_dia": len(rows), "valor_dia": round(sum(float(r["price"] or 0) for r in rows), 2), "contagens": {k: 0 for k in DESTAQUE_KINDS}, "itens": []}
    if not rows:
        return out
    nifs = sorted({str(r["buyer_nif"]) for r in rows if r["buyer_nif"]})
    stats = {}
    for i in range(0, len(nifs), 400):
        chunk = nifs[i:i + 400]
        for r in q(f"SELECT nif, n, value FROM buyer_stats WHERE nif IN ({','.join('?' * len(chunk))})", chunk):
            if r["n"] and r["value"]:
                stats[str(r["nif"])] = (int(r["n"]), float(r["value"]))
    found = {}
    cats = {k: [] for k in DESTAQUE_KINDS}
    for r in rows:
        price = float(r["price"])
        direct = str(r.get("procedure") or "").lower().startswith("ajuste")
        st = stats.get(str(r["buyer_nif"]))
        ratio = None
        if st and st[0] >= DESTAQUE_MIN_N and st[1] > 0:
            ratio = price / (st[1] / st[0])
        if ratio is not None and ratio >= DESTAQUE_RATIO and price >= DESTAQUE_MIN:
            cats["valor_atipico"].append((ratio, r, ratio))
        if direct and price >= DESTAQUE_DIRECT:
            cats["ajuste_direto"].append((price, r, ratio))
        if not direct and r.get("n_bidders") is not None and int(r["n_bidders"]) == 1 and price >= DESTAQUE_SINGLE:
            cats["proposta_unica"].append((price, r, ratio))
    for k in DESTAQUE_KINDS:
        out["contagens"][k] = len(cats[k])
        for _, r, ratio in sorted(cats[k], key=lambda x: (-x[0], str(x[1]["id"])))[:cap]:
            it = found.setdefault(str(r["id"]), {"r": r, "ratio": ratio, "motivos": []})
            it["motivos"].append(k)
    out["itens"] = sorted(found.values(), key=lambda x: (-float(x["r"]["price"]), str(x["r"]["id"])))
    return out


def _default_db():
    data = Path(os.environ.get("ESTADO_ABERTO_DATA") or Path(__file__).resolve().parent.parent / "data")
    return data.expanduser().resolve() / "diario.db"


def shortlist(edicao_data, n=200, per_section=None, con=None):
    own = con is None
    if own:
        path = _default_db()
        if not path.exists():
            return []
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = [{"id": i, "secao": s, "score": sc, "data_evento": d, "edicao_data": edicao_data} for i, s, sc, d in con.execute(
            "SELECT id, secao, score, data_evento FROM eventos WHERE edicao_data = ?", (edicao_data,))]
    except sqlite3.Error:
        rows = []
    finally:
        if own:
            con.close()
    return select_shortlist(rows, n, per_section)


def shortlist_json(edicao_data, n=200, per_section=None, con=None):
    return json.dumps(shortlist(edicao_data, n, per_section, con))
