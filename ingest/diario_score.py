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
    return round(max(0.0, s), 4)


def select_shortlist(rows, n=25, per_section=6):
    ordered = sorted(rows, key=lambda r: (-float(r["score"]), int(r["id"])))
    taken, count = [], {}
    for r in ordered:
        sec = r["secao"]
        if count.get(sec, 0) >= per_section:
            continue
        count[sec] = count.get(sec, 0) + 1
        taken.append(r)
        if len(taken) >= n:
            break
    return [int(r["id"]) for r in taken]


def _default_db():
    data = Path(os.environ.get("ESTADO_ABERTO_DATA") or Path(__file__).resolve().parent.parent / "data")
    return data.expanduser().resolve() / "diario.db"


def shortlist(edicao_data, n=25, per_section=6, con=None):
    own = con is None
    if own:
        path = _default_db()
        if not path.exists():
            return []
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = [{"id": i, "secao": s, "score": sc} for i, s, sc in con.execute(
            "SELECT id, secao, score FROM eventos WHERE edicao_data = ?", (edicao_data,))]
    except sqlite3.Error:
        rows = []
    finally:
        if own:
            con.close()
    return select_shortlist(rows, n, per_section)


def shortlist_json(edicao_data, n=25, per_section=6, con=None):
    return json.dumps(shortlist(edicao_data, n, per_section, con))
