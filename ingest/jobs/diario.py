import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import diario_score as S  # noqa: E402

ROOT = HERE.parent.parent
FLOOR = dt.date.fromisoformat(os.environ.get("ESTADO_ABERTO_DIARIO_FLOOR") or "2026-11-06")
WINDOW = 14
CONTEXT = 30
LATE_MAX = 90
BIG_CONTRACT = 50000
BIG_DIRECT = 20000
BIG_NOTICE = 1000000
RISK_MIN = 6.0
SECTIONS = S.SECTIONS

SCHEMA = """
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  data_evento TEXT NOT NULL,
  ingerido_em TEXT NOT NULL,
  edicao_data TEXT NOT NULL,
  secao TEXT NOT NULL CHECK (secao IN ('parlamento','governo','fiscalizacao','nomeacoes','poder-local','dinheiro','indicadores')),
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  resumo_curto TEXT,
  fonte_modulo TEXT NOT NULL,
  fonte_ref TEXT,
  rota TEXT,
  source_url TEXT,
  entidades TEXT,
  score REAL NOT NULL,
  revisao INTEGER NOT NULL DEFAULT 1,
  atrasado INTEGER NOT NULL DEFAULT 0,
  ia_artigo_id INTEGER NULL
);
CREATE INDEX IF NOT EXISTS eventos_edicao ON eventos(edicao_data, secao, score);
CREATE INDEX IF NOT EXISTS eventos_fonte ON eventos(fonte_modulo, fonte_ref, tipo);
CREATE TABLE IF NOT EXISTS edicoes (
  numero INTEGER PRIMARY KEY,
  data TEXT UNIQUE NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('preliminar','fechada')),
  fechada_em TEXT
);
CREATE TABLE IF NOT EXISTS cursores (
  fonte TEXT PRIMARY KEY,
  max_rowid INTEGER,
  max_data TEXT,
  atualizado_em TEXT
);
CREATE TABLE IF NOT EXISTS artigos_ia (
  id INTEGER PRIMARY KEY,
  edicao_data TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evento_ids TEXT NOT NULL,
  titulo TEXT, lead TEXT, corpo TEXT, pontos_chave TEXT, fontes TEXT, numeros_citados TEXT, entidades TEXT,
  confianca REAL, modelo TEXT, revisor TEXT, verificacao TEXT,
  estado TEXT NOT NULL CHECK (estado IN ('publicado','rejeitado')),
  criado_em TEXT,
  revisao INTEGER DEFAULT 1,
  UNIQUE(edicao_data, evidence_hash)
);
"""

MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
BOARD_RE = re.compile(r"administra|conselho de administra|regulad|autoridade|banco de portugal|comiss[ãa]o do mercado|supervis", re.I)
LAW_RE = re.compile(r"\bLei\b", re.I)
FINAL_RE = re.compile(r"^Vota[çc][ãa]o (final|global)", re.I)


def last_sunday(y, m):
    d = dt.date(y, m, 31)
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


def lisbon_offset(utc):
    y = utc.year
    start = dt.datetime.combine(last_sunday(y, 3), dt.time(1, 0))
    end = dt.datetime.combine(last_sunday(y, 10), dt.time(1, 0))
    return 1 if start <= utc < end else 0


def to_local(utc):
    return utc + dt.timedelta(hours=lisbon_offset(utc))


def local_to_utc(local):
    for off in (1, 0):
        u = local - dt.timedelta(hours=off)
        if lisbon_offset(u) == off:
            return u
    return local


def close_utc(d):
    return local_to_utc(dt.datetime.combine(d + dt.timedelta(days=1), dt.time(6, 0)))


def iso_utc(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")


def numero(d):
    return (d - FLOOR).days + 1


def pdate(s):
    d = dt.date.fromisoformat(s[:10])
    return f"{d.day} de {MES[d.month - 1]} de {d.year}"


def pshort(s):
    d = dt.date.fromisoformat(s[:10])
    return f"{d.day} de {MES[d.month - 1]}"


def nf(v, d=0):
    v = float(v)
    s = f"{abs(v):.{d}f}"
    ip, _, fp = s.partition(".")
    if len(ip) > 4:
        ip = " ".join([ip[max(i - 3, 0):i] for i in range(len(ip), 0, -3)][::-1])
    fp = fp.rstrip("0")
    return ("-" if v < 0 else "") + ip + ("," + fp if fp else "")


def eur(v):
    v = float(v)
    if v >= 1e9:
        x = round(v / 1e7) / 100
        return "1 mil milhões de euros" if x == 1 else f"{nf(x, 2)} mil milhões de euros"
    if v >= 1e6:
        x = round(v / 1e4) / 100
        return "1 milhão de euros" if x == 1 else f"{nf(x, 2)} milhões de euros"
    return f"{nf(round(v * 100) / 100, 2)} euros"


def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def cut(s, n):
    s = clean(s)
    if len(s) <= n:
        return s
    t = s[:n]
    i = t.rfind(" ")
    return (t[:i] if i > n * 0.6 else t).rstrip(" ,;:-") + "…"


def lower_first(s):
    return s[0].lower() + s[1:] if re.match(r"[A-ZÀ-Ý][a-zà-ÿ]", s or "") else s


def valid_date(s):
    try:
        return dt.date.fromisoformat(str(s)[:10]).isoformat() if re.match(r"^\d{4}-\d{2}-\d{2}", str(s)) else None
    except ValueError:
        return None


def pk(c):
    return re.sub(r"[.\s]", "", str(c)).replace("–", "-").upper()


def ent(nome, tipo, id=None):
    e = {"nome": clean(nome), "tipo": tipo}
    if id:
        e["id"] = str(id)
    return e


def route(base, arg=None, **params):
    out = base + (f"/{quote(str(arg), safe='')}" if arg not in (None, "") else "")
    qs = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items() if v not in (None, ""))
    return out + (f"?{qs}" if qs else "")


def ini_route(bid, tab=None):
    return route("#/votacoes", bid, tab=tab) if bid not in (None, "") else "#/votacoes"


def ro_uri(path):
    return f"file:{quote(str(path))}?mode=ro"


def ro_connect(path):
    if not Path(path).exists():
        return None
    try:
        c = sqlite3.connect(ro_uri(path), uri=True)
        c.row_factory = sqlite3.Row
        return c
    except sqlite3.Error:
        return None


def load_seats(src):
    out = {}
    c = ro_connect(Path(src) / "politica.db")
    if c:
        try:
            for code, seats in c.execute("SELECT code, seats FROM parties"):
                out[pk(code)] = int(seats or 0)
        except sqlite3.Error:
            pass
        c.close()
    return out


def load_risk(src):
    out = set()
    c = ro_connect(Path(src) / "risco.db")
    if c:
        try:
            for (nif,) in c.execute("SELECT nif FROM entity_risk WHERE score >= ?", (RISK_MIN,)):
                out.add(str(nif))
        except sqlite3.Error:
            pass
        c.close()
    return out


def load_board_nifs(src):
    out = set()
    c = ro_connect(Path(src) / "reguladores.db")
    if c:
        try:
            for (nif,) in c.execute("SELECT nif FROM bodies WHERE nif IS NOT NULL"):
                out.add(str(nif))
        except sqlite3.Error:
            pass
        c.close()
    return out


class Ctx:
    def __init__(self, con, db, lo, today, cursors, rebuild, shared):
        self.con, self.db, self.lo, self.today = con, db, lo, today
        self.cursors, self.rebuild, self.shared = cursors, rebuild, shared
        self.marks = {}
        self._cols = {}
        self.late_floor = (dt.date.fromisoformat(today) - dt.timedelta(days=LATE_MAX)).isoformat()

    def cols(self, table):
        if table not in self._cols:
            try:
                self._cols[table] = {r[1] for r in self.con.execute(f'PRAGMA src.table_info("{table}")')}
            except sqlite3.Error:
                self._cols[table] = set()
        return self._cols[table]

    def cursor(self, table):
        return None if self.rebuild else self.cursors.get(f"{self.db}.{table}")

    def win(self, table, col, ext=False):
        lo = (dt.date.fromisoformat(self.lo) - dt.timedelta(days=CONTEXT)).isoformat() if ext else self.lo
        cur = self.cursor(table)
        if cur is None:
            return f"{col} >= ?", [lo]
        return f"({col} >= ? OR (rowid > ? AND {col} >= ?))", [lo, cur, self.late_floor]

    def win_days(self, table, col):
        cur = self.cursor(table)
        if cur is None:
            return f"{col} >= ?", [self.lo]
        return f"({col} >= ? OR {col} IN (SELECT {col} FROM src.{table} WHERE rowid > ? AND {col} >= ?))", [self.lo, cur, self.late_floor]

    def new_only(self, table):
        cur = self.cursor(table)
        return ("rowid > ?", [cur]) if cur is not None else ("0", [])

    def is_new(self, fonte, rid):
        cur = None if self.rebuild else self.cursors.get(fonte)
        return cur is not None and rid is not None and rid > cur

    def q(self, sql, params=()):
        try:
            return [dict(r) for r in self.con.execute(sql, params)]
        except sqlite3.Error:
            return []

    def rows(self, table, want, need, where="1", params=(), extra=""):
        have = self.cols(table)
        if not have or any(n not in have for n in need):
            return []
        sel = ", ".join(w if w in have else f"NULL AS {w}" for w in want)
        return self.q(f"SELECT rowid AS _rid, {sel} FROM src.{table} WHERE {where} {extra}", params)

    def by_ids(self, table, key, ids, want):
        out = {}
        ids = sorted({i for i in ids if i is not None})
        have = self.cols(table)
        if not have or key not in have:
            return out
        sel = ", ".join(w if w in have else f"NULL AS {w}" for w in want)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for r in self.q(f"SELECT {sel} FROM src.{table} WHERE {key} IN ({','.join('?' * len(chunk))})", chunk):
                out[r[key]] = r
        return out

    def mark(self, table, col):
        have = self.cols(table)
        if not have:
            return
        sel = f"MAX({col})" if col in have else "NULL"
        try:
            r = self.con.execute(f"SELECT MAX(rowid), {sel} FROM src.{table}").fetchone()
        except sqlite3.Error:
            return
        if r and r[0] is not None:
            self.marks[f"{self.db}.{table}"] = (int(r[0]), r[1])

    def ev(self, table, ref, tipo, data, secao, titulo, resumo=None, rota=None, url=None, ents=None, amount=None, rid=None, **kw):
        data = valid_date(data)
        if not data:
            return None
        e = {"fonte": f"{self.db}.{table}", "modulo": self.db, "ref": str(ref), "tipo": tipo, "data": data, "secao": secao,
             "titulo": cut(titulo, 220), "resumo": clean(resumo) or None, "rota": rota, "url": url or None,
             "ents": ents or [], "amount": amount, "rid": rid}
        e.update(kw)
        return e


def vote_texts(r, ini, seats):
    F = [x.strip() for x in str(r["favor"] or "").split(",") if x.strip()]
    C = [x.strip() for x in str(r["contra"] or "").split(",") if x.strip()]
    A = [x.strip() for x in str(r["abstencao"] or "").split(",") if x.strip()]
    fs = sum(seats.get(pk(x), 0) for x in F)
    cs = sum(seats.get(pk(x), 0) for x in C)
    as_ = sum(seats.get(pk(x), 0) for x in A)
    ok = bool(re.match(r"^Aprovad", str(r["resultado"] or ""), re.I))
    rej = bool(re.match(r"^Rejeitad", str(r["resultado"] or ""), re.I))
    tipo_l = str(ini.get("tipo") or "iniciativa").lower() if ini else "iniciativa"
    t = clean(ini.get("titulo")) if ini else ""
    ref = f"{ini['tipo']} n.º {ini['numero']}/{ini['leg']}" if ini and ini.get("tipo") and ini.get("numero") else None
    verb = "aprova" if ok else ("rejeita" if rej else "vota")
    if t:
        titulo = f"Parlamento {verb} {tipo_l} «{cut(t, 150)}»"
    elif ref:
        titulo = f"Parlamento {verb} {ref}"
    else:
        titulo = f"Votação em plenário: {r['resultado'] or 'sem resultado registado'}"
    parts = []
    if F:
        parts.append(f"a favor {', '.join(F)} ({fs} lugares)")
    if C:
        parts.append(f"contra {', '.join(C)} ({cs} lugares)")
    if A:
        parts.append(f"abstenção de {', '.join(A)} ({as_} lugares)")
    resumo = f"Plenário, {pdate(r['data'])}: {str(r['fase'] or 'votação').lower()}" + (f" de {ref}" if ref else "") + f". Resultado: {r['resultado'] or 'não indicado'}."
    if r.get("unanime") in (1, "1", True):
        resumo += " Votação unânime."
    if parts:
        resumo += " Votaram " + "; ".join(parts) + "."
    return titulo, resumo, fs, cs, ok, rej


def c_votacoes(c):
    out = []
    w, p = c.win("votos", "data")
    rows = c.rows("votos", ["id", "bid", "data", "fase", "resultado", "unanime", "favor", "contra", "abstencao", "source_url"], ["id", "data"],
                  f"orgao = 'Plenário' AND fase LIKE 'Votação%' AND {w}", p)
    inis = c.by_ids("iniciativas", "bid", [r["bid"] for r in rows], ["bid", "tipo", "numero", "leg", "titulo"])
    for r in rows:
        ini = inis.get(r["bid"])
        titulo, resumo, fs, cs, ok, rej = vote_texts(r, ini, c.shared["seats"])
        final = bool(FINAL_RE.match(str(r["fase"] or ""))) and bool(ini and LAW_RE.search(str(ini.get("tipo") or "")))
        e = c.ev("votos", r["id"], "votacao_final" if final else "votacao", r["data"], "parlamento", titulo, resumo, ini_route(r["bid"]), r["source_url"],
                 [ent(ini["tipo"] + f" n.º {ini['numero']}/{ini['leg']}", "iniciativa", r["bid"])] if ini and ini.get("tipo") and ini.get("numero")
                 else ([ent("Iniciativa", "iniciativa", r["bid"])] if r["bid"] else []),
                 rid=r["_rid"], narrow=cs > 0 and S.is_narrow(abs(fs - cs)), rejected=rej)
        out.append(e)
    c.mark("votos", "data")
    w, p = c.win("iniciativas", "data_entrada")
    for r in c.rows("iniciativas", ["bid", "tipo", "numero", "leg", "titulo", "autoria", "data_entrada", "source_url"], ["bid", "data_entrada"], w, p):
        ref = f"{r['tipo']} n.º {r['numero']}/{r['leg']}"
        t = clean(r["titulo"])
        out.append(c.ev("iniciativas", r["bid"], "iniciativa_entrada", r["data_entrada"], "parlamento",
                        f"Dá entrada no Parlamento: {ref}" + (f" «{cut(t, 140)}»" if t else ""),
                        f"{ref} deu entrada a {pdate(r['data_entrada'])}" + (f", da autoria de {clean(r['autoria'])}." if r["autoria"] else "."),
                        ini_route(r["bid"]), r["source_url"], [ent(ref, "iniciativa", r["bid"])], rid=r["_rid"]))
    c.mark("iniciativas", "data_entrada")
    return out


def c_intervencoes(c):
    out = []
    cur = c.cursor("intervencoes")
    if cur is None:
        w, p = "i.data >= ?", [c.lo]
    else:
        w, p = "(i.data >= ? OR i.data IN (SELECT data FROM src.intervencoes WHERE rowid > ? AND data >= ?))", [c.lo, cur, c.late_floor]
    sql = ("SELECT i.data AS d, v.bid AS bid, v.ref AS ref, COUNT(*) AS n, COUNT(DISTINCT i.orador) AS o, GROUP_CONCAT(DISTINCT i.partido) AS ps "
           f"FROM src.intervencoes i JOIN src.iv_ini v ON v.iv_id = i.id WHERE {w} GROUP BY i.data, v.bid HAVING COUNT(*) >= 2")
    rows = c.q(sql, p)
    urls = {k: v.get("source_url") for k, v in c.by_ids("iniciativas", "bid", [r["bid"] for r in rows], ["bid", "source_url"]).items()}
    for r in rows:
        ps = sorted({x.strip() for x in str(r["ps"] or "").split(",") if x.strip()})
        out.append(c.ev("intervencoes", f"{r['bid']}", "debate", r["d"], "parlamento", f"Debate no Plenário: {clean(r['ref'])}",
                        f"{r['n']} intervenções de {r['o']} {'orador' if r['o'] == 1 else 'oradores'} a {pdate(r['d'])}" + (f" ({', '.join(ps)})." if ps else "."),
                        ini_route(r["bid"], "iv"), urls.get(r["bid"]), [ent(r["ref"], "iniciativa", r["bid"])]))
    c.mark("intervencoes", "data")
    return out


def c_posicoes(c):
    out = []
    w, p = c.win("decl", "data_voto")
    for r in c.rows("decl", ["id", "orador", "partido", "titulo", "data_voto", "declarado", "voto", "coincide", "voto_url", "bid"], ["id", "data_voto"], w, p):
        resumo = f"Em plenário a {pdate(r['data_voto'])}, {clean(r['orador'])} ({clean(r['partido'])}) votou {r['voto']}; no discurso tinha declarado posição {r['declarado']}."
        resumo += " Voto e declaração coincidem." if str(r["coincide"]) == "1" else " Voto e declaração não coincidem." if str(r["coincide"]) == "0" else ""
        out.append(c.ev("decl", r["id"], "declaracao_voto", r["data_voto"], "parlamento",
                        f"{clean(r['orador'])} ({clean(r['partido'])}) vota {r['voto']} após declarar-se {r['declarado']}: «{cut(r['titulo'], 110)}»",
                        resumo, ini_route(r["bid"]), r["voto_url"], [ent(r["orador"], "deputado"), ent(r["partido"], "partido")] + ([ent("Iniciativa", "iniciativa", r["bid"])] if r["bid"] else []), rid=r["_rid"]))
    c.mark("decl", "data_voto")
    return out


ATO_SKIP = {"condecoracao", "homologacao", "nomeacao", "exoneracao", "veto"}


ATO_PLURAL = {"promulgacao": ("promulgação", "promulgações"), "veto": ("veto", "vetos"), "nomeacao": ("nomeação", "nomeações"), "exoneracao": ("exoneração", "exonerações"),
              "condecoracao": ("condecoração", "condecorações"), "homologacao": ("homologação", "homologações"), "envio_tc": ("pedido ao Tribunal Constitucional", "pedidos ao Tribunal Constitucional"),
              "ratificacao": ("ratificação", "ratificações"), "indulto": ("indulto", "indultos"), "outro": ("outro ato", "outros atos")}


def presidencia_dia(c, days):
    if not days or "tipo" not in c.cols("atos") or "data" not in c.cols("atos"):
        return []
    canon = " AND (canon IS NULL OR canon = 1)" if "canon" in c.cols("atos") else ""
    rows = c.q(f"SELECT data, tipo, COUNT(*) AS n, MAX(rowid) AS rid FROM src.atos WHERE data IN ({','.join('?' * len(days))}){canon} GROUP BY data, tipo", days)
    by = defaultdict(dict)
    rid = {}
    for r in rows:
        by[r["data"]][r["tipo"] or "outro"] = r["n"]
        rid[r["data"]] = max(rid.get(r["data"], 0), r["rid"] or 0)
    out = []
    for d in sorted(by):
        counts = by[d]
        total = sum(counts.values())
        if total < 2:
            continue
        parts = [f"{n} {ATO_PLURAL.get(t, (t, t))[0 if n == 1 else 1]}" for t, n in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]
        out.append(c.ev("atos", d, "presidencia_dia", d, "governo", f"Presidente da República: {total} atos em {pdate(d)}", "Atos do dia: " + ", ".join(parts) + ".",
                        "#/presidencia", None, [ent("Presidente da República", "orgao")], rid=rid.get(d)))
    return out


def c_presidencia(c):
    out = []
    w, p = c.win("vetos", "data", ext=True)
    for r in c.rows("vetos", ["id", "data", "motivo", "titulo", "desfecho", "decreto_ref", "mensagem_url", "source_url"], ["id", "data"], w, p):
        resumo = f"Veto {r['motivo'] or ''} ao decreto {r['decreto_ref'] or 'sem referência'}.".replace("  ", " ")
        if r["desfecho"]:
            resumo += f" Desfecho: {r['desfecho']}."
        out.append(c.ev("vetos", r["id"], "veto", r["data"], "governo", f"Presidente da República veta: {cut(r['titulo'], 170)}", resumo,
                        route("#/atos-presidente", r["id"]), r["mensagem_url"] or r["source_url"], [ent("Presidente da República", "orgao")], rid=r["_rid"]))
    c.mark("vetos", "data")
    w, p = c.win("atos", "data", ext=True)
    days = set()
    for r in c.rows("atos", ["id", "data", "tipo", "titulo", "texto", "mensagem_url", "source_url"], ["id", "data", "tipo"], w, p):
        days.add(valid_date(r["data"]))
        if r["tipo"] in ATO_SKIP:
            continue
        body = [x.strip() for x in str(r["texto"] or "").split("\n") if x.strip()][2:]
        tipo = "promulgacao" if r["tipo"] == "promulgacao" else "ato_presidente"
        out.append(c.ev("atos", r["id"], tipo, r["data"], "governo", clean(r["titulo"]).rstrip("."), cut(" ".join(body), 260) or None,
                        route("#/atos-presidente", r["id"]), r["mensagem_url"] or r["source_url"], [ent("Presidente da República", "orgao")], rid=r["_rid"], sub=r["tipo"]))
    out += presidencia_dia(c, sorted(d for d in days if d))
    c.mark("atos", "data")
    w, p = c.win("comunicados", "data")
    for r in c.rows("comunicados", ["url", "data", "titulo", "tipo", "ato_id"], ["url", "data"], f"ato_id IS NULL AND {w}", p):
        out.append(c.ev("comunicados", r["url"], "comunicado", r["data"], "governo", clean(r["titulo"]), None, route("#/atos-presidente", r["ato_id"]) if r["ato_id"] else "#/presidencia", r["url"],
                        [ent("Presidente da República", "orgao")], rid=r["_rid"]))
    c.mark("comunicados", "data")
    return out


DRE_KINDS = {
    "Decreto-Lei": ("governo", "decreto_lei"),
    "Resolução do Conselho de Ministros": ("governo", "resolucao_cm"),
    "Decreto Regulamentar": ("governo", "decreto_regulamentar"),
    "Lei": ("parlamento", "lei_publicada"),
    "Resolução da Assembleia da República": ("parlamento", "resolucao_ar"),
}


def c_dre(c):
    out = []
    w, p = c.win("acts", "date")
    ks = list(DRE_KINDS)
    for r in c.rows("acts", ["id", "kind", "title", "summary", "issuer", "url", "source_url", "date"], ["id", "date", "kind"], f"kind IN ({','.join('?' * len(ks))}) AND {w}", ks + p):
        sec, tipo = DRE_KINDS[r["kind"]]
        t = clean(r["title"])
        s = clean(r["summary"])
        out.append(c.ev("acts", r["id"], tipo, r["date"], sec, f"{t}: {cut(s, 150)}" if s else t, cut(s, 300) or None, route("#/dre", r["id"]), r["url"] or r["source_url"],
                        [ent(r["issuer"], "orgao")] if r["issuer"] else [], rid=r["_rid"]))
    c.mark("acts", "date")
    return out


def c_justica(c):
    out = []
    w, p = c.win("tcontas_docs", "publicado", ext=True)
    for r in c.rows("tcontas_docs", ["id", "categoria", "grupo", "tipo", "titulo_ref", "data", "publicado", "descricao", "entity_name", "entity_nif", "pdf_url", "source_url"], ["id", "publicado"], w, p):
        aud = r["categoria"] == "relatorio" and r["tipo"] == "Auditoria"
        base = cut(clean(r["descricao"]) or clean(r["titulo_ref"]), 120)
        if aud:
            titulo, tipo = f"Auditoria do Tribunal de Contas: {base}", "auditoria_tc"
        elif r["categoria"] == "acordao":
            titulo, tipo = f"Tribunal de Contas decide: {base}", "acordao_tc"
        else:
            titulo, tipo = f"Tribunal de Contas publica: {base}", "relatorio_tc"
        resumo = f"O Tribunal de Contas publicou a {pdate(r['publicado'])} {clean(r['titulo_ref'])}" + (f", de {pdate(r['data'])}" if valid_date(r["data"]) else "") + "."
        if r["descricao"]:
            resumo += f" Assunto: {cut(r['descricao'], 240)}"
        out.append(c.ev("tcontas_docs", r["id"], tipo, r["publicado"], "fiscalizacao", titulo, resumo, route("#/justica/contas", q=r["titulo_ref"] or r["descricao"]), r["pdf_url"] or r["source_url"],
                        [ent(r["entity_name"], "entidade", r["entity_nif"])] if r["entity_name"] else [], rid=r["_rid"]))
    c.mark("tcontas_docs", "publicado")
    return out


def c_igf(c):
    out = []
    w, p = c.new_only("reports")
    for r in c.rows("reports", ["code", "title", "kind", "entity_name", "entity_nif", "subject", "source_url", "report_url"], ["code"], w, p):
        muni = r["kind"] == "municipio"
        out.append(c.ev("reports", r["code"], "relatorio_igf_municipal" if muni else "relatorio_igf", c.today, "poder-local" if muni else "fiscalizacao",
                        f"IGF publica relatório: {cut(r['title'], 160)}",
                        f"Relatório {r['code']} da Inspeção-Geral de Finanças" + (f" sobre {clean(r['entity_name'] or r['subject'])}." if (r["entity_name"] or r["subject"]) else "."),
                        route("#/igf", q=r["code"]), r["report_url"] or r["source_url"], [ent(r["entity_name"], "entidade", r["entity_nif"])] if r["entity_name"] else [], rid=r["_rid"], once=True))
    c.mark("reports", None)
    return out


def c_provedor(c):
    out = []
    w, p = c.win("reports", "published", ext=True)
    for r in c.rows("reports", ["year", "title", "published", "page_url", "pdf_url"], ["published", "title"], w, p):
        out.append(c.ev("reports", r["year"] or r["title"], "relatorio_provedor", r["published"], "fiscalizacao", f"Provedor de Justiça publica: {cut(r['title'], 160)}",
                        f"Relatório do Provedor de Justiça publicado a {pdate(r['published'])}.", route("#/provedor", ano=r["year"] or str(r["published"])[:4]), r["page_url"] or r["pdf_url"],
                        [ent("Provedor de Justiça", "orgao")], rid=r["_rid"]))
    c.mark("reports", "published")
    return out


def c_reguladores(c):
    out = []
    w, p = c.win("decisions", "date", ext=True)
    rows = c.rows("decisions", ["id", "body", "kind", "ref", "date", "title", "subject", "amount", "amount_note", "url", "source_url"], ["id", "date"], w, p)
    bodies = c.by_ids("bodies", "slug", [r["body"] for r in rows], ["slug", "short", "name"])
    for r in rows:
        b = bodies.get(r["body"]) or {}
        name = b.get("short") or r["body"]
        amount = float(r["amount"]) if r["amount"] not in (None, "") else None
        sanc = r["kind"] in ("sancao", "contraordenacao") and amount and amount > 0
        resumo = f"Decisão de {name} a {pdate(r['date'])}" + (f" ({r['kind'].replace('_', ' ')})" if r["kind"] else "") + "."
        if sanc:
            resumo += f" Valor: {eur(amount)}" + (f" ({clean(r['amount_note'])})." if r["amount_note"] else ".")
        elif r["subject"]:
            resumo += f" Assunto: {cut(r['subject'], 200)}"
        out.append(c.ev("decisions", r["id"], "sancao_regulador" if sanc else "decisao_regulador", r["date"], "fiscalizacao", cut(r["title"], 200) or f"Decisão de {name}",
                        resumo, route(f"#/reguladores/{quote(str(r['body']), safe='')}", q=r["ref"]) if r["body"] else "#/reguladores", r["url"] or r["source_url"], [ent(b.get("name") or name, "regulador", r["body"])], amount=amount if sanc else None,
                        rid=r["_rid"], sub=r["body"]))
    c.mark("decisions", "date")
    return out


def c_responsaveis(c):
    out = []
    w, p = c.win("nomeacoes", "date")
    for r in c.rows("nomeacoes", ["id", "action", "person", "role", "entity", "entity_nif", "date", "act", "source_url"], ["id", "date"], w, p):
        action = clean(r["action"]) or "nomeação"
        board = bool(r["entity_nif"] and str(r["entity_nif"]) in c.shared["board_nifs"]) or bool(BOARD_RE.search(f"{r['role'] or ''} {r['entity'] or ''}"))
        tipo = "exoneracao" if action.startswith("exoner") else ("nomeacao_conselho" if board else "nomeacao")
        titulo = f"{action.capitalize()}: {clean(r['person'])}, {cut(r['role'], 110)}" + (f" ({cut(r['entity'], 80)})" if r["entity"] else "")
        out.append(c.ev("nomeacoes", r["id"], tipo, r["date"], "nomeacoes", titulo, f"Publicado em {clean(r['act'])}." if r["act"] else None, route("#/responsaveis/nomeacoes", q=r["person"], year=str(r["date"])[:4]), r["source_url"],
                        [ent(r["person"], "pessoa")] + ([ent(r["entity"], "entidade", r["entity_nif"])] if r["entity"] else []), rid=r["_rid"]))
    c.mark("nomeacoes", "date")
    w, p = c.win("appointments", "start")
    for r in c.rows("appointments", ["id", "person", "role", "organ", "ministry", "start", "act", "source_url"], ["id", "start"], w, p):
        out.append(c.ev("appointments", r["id"], "nomeacao_gabinete", r["start"], "nomeacoes",
                        f"Gabinete: {clean(r['person'])}, {cut(r['role'], 80)}" + (f" ({cut(r['organ'], 90)})" if r["organ"] else ""),
                        f"Início de funções a {pdate(r['start'])}." + (f" Ato: {clean(r['act'])}." if r["act"] else ""), f"#/responsaveis/a{r['id']}", r["source_url"],
                        [ent(r["person"], "pessoa")] + ([ent(r["organ"], "entidade")] if r["organ"] else []), rid=r["_rid"]))
    c.mark("appointments", "start")
    return out


def summary_event(c, table, tipo, day, n, total, secao, label, extra, rota):
    t = f"{label}: {nf(n)} {'registo' if n == 1 else 'registos'} a {pshort(day)}"
    r = f"{nf(n)} {label.lower()} publicados a {pdate(day)}, no valor total de {eur(total or 0)}.{extra}"
    return c.ev(table, day, tipo, day, secao, t, r, rota)


def c_contracts(c):
    out = []
    risk = c.shared["risk"]
    big = f"(price >= {BIG_CONTRACT} OR (procedure LIKE 'Ajuste%' AND price >= {BIG_DIRECT}))"
    w, p = c.win("contracts", "published")
    for r in c.rows("contracts", ["id", "published", "price", "procedure", "buyer_name", "seller_name", "buyer_nif", "seller_nif", "object", "n_sellers", "link"], ["id", "published", "price"], f"{big} AND {w}", p):
        direct = str(r["procedure"] or "").lower().startswith("ajuste")
        b, s, v = clean(r["buyer_name"]), clean(r["seller_name"]), eur(r["price"])
        titulo = f"Ajuste direto: {b} paga {v} a {s}" if direct else f"{b} contrata {s} por {v}"
        resumo = f"Contrato publicado a {pdate(r['published'])}. Procedimento: {clean(r['procedure']) or 'não indicado'}. Objeto: «{cut(r['object'], 160)}»."
        flagged = str(r["buyer_nif"]) in risk or str(r["seller_nif"]) in risk
        out.append(c.ev("contracts", r["id"], "contrato_grande" if r["price"] >= BIG_CONTRACT else "contrato_ajuste_direto", r["published"], "dinheiro", titulo, resumo,
                        f"#/contrato/{r['id']}", r["link"], [ent(r["buyer_name"], "entidade_publica", r["buyer_nif"]), ent(r["seller_name"], "empresa", r["seller_nif"])],
                        amount=r["price"], rid=r["_rid"], risk=flagged))
    w, p = c.win_days("contracts", "published")
    sql = (f"SELECT published AS d, COUNT(*) AS n, SUM(price) AS v, SUM(CASE WHEN procedure LIKE 'Ajuste%' THEN 1 ELSE 0 END) AS dn FROM src.contracts "
           f"WHERE NOT {big} AND {w} GROUP BY published")
    if {"published", "price", "procedure"} <= c.cols("contracts"):
        for r in c.q(sql, p):
            if valid_date(r["d"]):
                out.append(summary_event(c, "contracts", "contratos_resumo", r["d"], r["n"], r["v"], "dinheiro", "Contratos públicos abaixo dos limiares",
                                         f" Ajustes diretos: {nf(r['dn'])}.", "#/contratos"))
    c.mark("contracts", "published")
    w, p = c.win("contract_mods", "published")
    mods = c.rows("contract_mods", ["contract_id", "date", "published", "new_price", "act_type"], ["contract_id", "published"], w, p)
    cons = c.by_ids("contracts", "id", [m["contract_id"] for m in mods], ["id", "buyer_name", "seller_name", "buyer_nif", "seller_nif", "procedure", "object"])
    daily = defaultdict(lambda: [0, 0.0])
    for m in mods:
        k = cons.get(m["contract_id"]) or {}
        price = float(m["new_price"] or 0)
        direct = str(k.get("procedure") or "").lower().startswith("ajuste")
        if price >= BIG_CONTRACT or (direct and price >= BIG_DIRECT):
            b, s = clean(k.get("buyer_name")) or "Entidade adjudicante", clean(k.get("seller_name")) or "fornecedor"
            flagged = str(k.get("buyer_nif")) in risk or str(k.get("seller_nif")) in risk
            out.append(c.ev("contract_mods", f"{m['contract_id']}:{m['date']}:{m['new_price']}", "alteracao_contrato", m["published"], "dinheiro",
                            f"{b} altera contrato com {s}: novo valor de {eur(price)}",
                            f"Modificação registada a {pdate(m['published'])}" + (f" ({clean(m['act_type'])})" if m["act_type"] else "") + f" ao contrato n.º {m['contract_id']}.",
                            f"#/contrato/{m['contract_id']}", None, [ent(b, "entidade_publica", k.get("buyer_nif")), ent(s, "empresa", k.get("seller_nif"))],
                            amount=price, rid=m["_rid"], risk=flagged))
        else:
            d = valid_date(m["published"])
            if d:
                daily[d][0] += 1
                daily[d][1] += price
    for d, (n, v) in sorted(daily.items()):
        out.append(summary_event(c, "contract_mods", "alteracoes_resumo", d, n, v, "dinheiro", "Alterações a contratos abaixo dos limiares", "", "#/contratos"))
    c.mark("contract_mods", "published")
    return out


def c_anuncios(c):
    out = []
    w, p = c.win("announcements", "published")
    daily = defaultdict(lambda: [0, 0.0])
    for r in c.rows("announcements", ["id", "n_anuncio", "published", "buyer_name", "buyer_nif", "tipo_acto", "base_price", "description", "url", "source_url"], ["id", "published"], w, p):
        price = float(r["base_price"] or 0)
        if price >= BIG_NOTICE:
            out.append(c.ev("announcements", r["id"], "anuncio_grande", r["published"], "dinheiro",
                            f"{clean(r['buyer_name'])} anuncia procedimento de {eur(price)}: {cut(r['description'], 120)}",
                            f"{clean(r['tipo_acto'])} publicado a {pdate(r['published'])}. Preço base: {eur(price)}.", route("#/anuncios", r["buyer_nif"]) if r["buyer_nif"] else "#/anuncios", r["url"] or r["source_url"],
                            [ent(r["buyer_name"], "entidade_publica", r["buyer_nif"])], rid=r["_rid"]))
        elif valid_date(r["published"]):
            d = valid_date(r["published"])
            daily[d][0] += 1
            daily[d][1] += price
    for d, (n, v) in sorted(daily.items()):
        out.append(summary_event(c, "announcements", "anuncios_resumo", d, n, v, "dinheiro", "Anúncios de contratação pública", " Valor: soma dos preços base.", "#/anuncios"))
    c.mark("announcements", "published")
    return out


def c_apoios(c):
    out = []
    iso = "data_decisao GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'"
    w, p = c.win("apoios", "data_decisao")
    daily = defaultdict(lambda: [0, 0.0])
    for r in c.rows("apoios", ["id", "data_decisao", "nome", "nif", "amount", "orgao", "programa", "source_url"], ["id", "data_decisao"], f"{iso} AND {w}", p):
        amount = float(r["amount"] or 0)
        d = valid_date(r["data_decisao"])
        if not d:
            continue
        if amount >= BIG_CONTRACT:
            out.append(c.ev("apoios", r["id"], "apoio", d, "dinheiro", f"{clean(r['orgao'])} atribui {eur(amount)} a {clean(r['nome'])}",
                            f"Apoio decidido a {pdate(d)}. Programa: {cut(r['programa'], 160)}.", "#/apoios", r["source_url"],
                            [ent(r["nome"], "beneficiario", r["nif"])], amount=amount, rid=r["_rid"]))
        else:
            daily[d][0] += 1
            daily[d][1] += amount
    for d, (n, v) in sorted(daily.items()):
        out.append(summary_event(c, "apoios", "apoios_resumo", d, n, v, "dinheiro", "Apoios públicos abaixo do limiar", "", "#/apoios"))
    c.mark("apoios", "data_decisao")
    return out


def c_divida(c):
    out = []
    w, p = c.new_only("series")
    groups = defaultdict(list)
    for r in c.rows("series", ["code", "label", "date", "value"], ["date"], w, p):
        groups[r["date"]].append(r)
    for period, rs in sorted(groups.items()):
        out.append(c.ev("series", period, "divida_serie", c.today, "dinheiro", f"Dívida pública: novos dados para {period}",
                        f"Atualizadas {len(rs)} séries com observação de {period}.", "#/divida", None, [], once=True))
    c.mark("series", "date")
    return out


def c_ine(c):
    out = []
    for r in c.rows("indicador", ["key", "label", "unit", "last_year", "updated", "source_url"], ["key", "updated"], "updated >= ?", [c.lo]):
        out.append(c.ev("indicador", r["key"], "indicador_ine", r["updated"], "indicadores", f"INE atualiza o indicador: {clean(r['label'])}",
                        f"Último ano disponível: {r['last_year']}." + (f" Unidade: {clean(r['unit'])}." if r["unit"] else ""), "#/indicadores", r["source_url"], [ent("INE", "orgao")], rid=r["_rid"]))
    return out


def c_imigracao(c):
    out = []
    for r in c.rows("datasets", ["ds", "label", "updated", "last_year", "source_url"], ["ds", "updated"], "updated >= ?", [c.lo]):
        out.append(c.ev("datasets", r["ds"], "indicador_imigracao", r["updated"], "indicadores", f"Imigração: atualizado o conjunto «{cut(r['label'], 120)}»",
                        f"Último ano disponível: {r['last_year']}.", "#/imigracao", r["source_url"], [], rid=r["_rid"]))
    for r in c.rows("ama_pedidos", ["resource", "period", "scope", "value", "published", "source_url"], ["resource", "published"], "published >= ?", [c.lo]):
        out.append(c.ev("ama_pedidos", r["resource"], "indicador_ama", r["published"], "indicadores", f"AMA publica pedidos de {r['period']}: {r['value']}",
                        f"{clean(r['scope'])}: {r['value']} pedidos em {r['period']}.", "#/imigracao", r["source_url"], [ent("AMA", "orgao")], rid=r["_rid"]))
    return out


COLLECTORS = [
    ("votacoes", c_votacoes), ("intervencoes", c_intervencoes), ("posicoes", c_posicoes), ("presidencia", c_presidencia), ("dre", c_dre),
    ("justica", c_justica), ("igf", c_igf), ("provedor", c_provedor), ("reguladores", c_reguladores), ("responsaveis", c_responsaveis),
    ("politica", c_contracts), ("anuncios", c_anuncios), ("apoios", c_apoios), ("divida", c_divida), ("ine_series", c_ine), ("imigracao", c_imigracao),
]


def event_hash(e):
    return hashlib.sha1(f"{e['modulo']}|{e['ref']}|{e['tipo']}|{e['data']}".encode()).hexdigest()


def mark_first(events):
    seen = defaultdict(list)
    for e in events:
        if e["tipo"] in S.FIRST_TYPES:
            seen[(e["modulo"], e["tipo"], e.get("sub"))].append(e["data"])
    for e in events:
        e["first"] = False
        if e["tipo"] in S.FIRST_TYPES:
            d = dt.date.fromisoformat(e["data"])
            lo = (d - dt.timedelta(days=CONTEXT)).isoformat()
            e["first"] = not any(lo <= x < e["data"] for x in seen[(e["modulo"], e["tipo"], e.get("sub"))])


def gather(con, src, lo, today, cursors, rebuild):
    shared = {"seats": load_seats(src), "risk": load_risk(src), "board_nifs": load_board_nifs(src)}
    events, marks, skipped = [], {}, []
    for db, fn in COLLECTORS:
        path = Path(src) / ("politica.db" if db == "politica" else f"{db}.db")
        if not path.exists():
            skipped.append(db)
            continue
        try:
            con.execute("ATTACH DATABASE ? AS src", (ro_uri(path),))
        except sqlite3.Error:
            skipped.append(db)
            continue
        try:
            c = Ctx(con, db, lo, today, cursors, rebuild, shared)
            got = [e for e in fn(c) if e]
            mark_first(got)
            for e in got:
                e["_new"] = c.is_new(e["fonte"], e.get("rid"))
            events.extend(got)
            marks.update(c.marks)
        except Exception as ex:
            skipped.append(f"{db}({type(ex).__name__})")
        finally:
            try:
                con.execute("DETACH DATABASE src")
            except sqlite3.Error:
                pass
    late_floor = (dt.date.fromisoformat(today) - dt.timedelta(days=LATE_MAX)).isoformat()
    keep = [e for e in events if e["data"] <= today and e["data"] >= late_floor and (e["data"] >= lo or e["_new"] or e.get("once"))]
    keep.sort(key=lambda e: (e["data"], e["modulo"], e["tipo"], e["ref"]))
    uniq, seen = [], set()
    for e in keep:
        h = event_hash(e)
        if h not in seen:
            seen.add(h)
            uniq.append(e)
    return uniq, marks, skipped


def texts(e, atrasado):
    titulo, resumo = e["titulo"], e["resumo"]
    if atrasado:
        titulo = cut(titulo, 200) + f" (ocorreu a {pshort(e['data'])})"
        resumo = ((resumo + " ") if resumo else "") + f"Ocorreu a {pdate(e['data'])}."
    return titulo, resumo


def compute_score(e, edicao):
    d = dt.date.fromisoformat(e["data"])
    lag = (dt.date.fromisoformat(edicao) - (d + dt.timedelta(days=1))).days
    return S.score(e["tipo"], e.get("amount"), e.get("narrow", False), e.get("rejected", False), e.get("risk", False), e.get("first", False), lag)


def apply_events(con, events, now, only=None, prune_from=None):
    stats = {"inseridos": Counter(), "atualizados": 0, "ignorados_antes_do_limiar": 0}
    ing = iso_utc(now)
    ing_local = to_local(now).date()
    produced = set()
    for e in events:
        h = event_hash(e)
        row = con.execute("SELECT * FROM eventos WHERE hash = ?", (h,)).fetchone()
        if row is None and e.get("once"):
            row = con.execute("SELECT * FROM eventos WHERE fonte_modulo = ? AND fonte_ref = ? AND tipo = ?", (e["modulo"], e["ref"], e["tipo"])).fetchone()
        if row is not None:
            produced.add(row["hash"])
            ed = dt.date.fromisoformat(row["edicao_data"])
            if close_utc(ed) <= now or (only and ed != only):
                continue
            ee = dict(e, data=row["data_evento"])
            titulo, resumo = texts(ee, row["atrasado"])
            sc = compute_score(ee, row["edicao_data"])
            if (titulo, resumo, sc) != (row["titulo"], row["resumo_curto"], row["score"]):
                con.execute("UPDATE eventos SET titulo=?, resumo_curto=?, score=?, rota=?, source_url=?, entidades=?, revisao=revisao+1 WHERE id=?",
                            (titulo, resumo, sc, e["rota"], e["url"], json.dumps(e["ents"], ensure_ascii=False), row["id"]))
                stats["atualizados"] += 1
            continue
        d = dt.date.fromisoformat(e["data"])
        nxt = d + dt.timedelta(days=1)
        if nxt < FLOOR and (ing_local < FLOOR or not e.get("_new")):
            stats["ignorados_antes_do_limiar"] += 1
            continue
        ed = max(nxt, ing_local, FLOOR)
        while close_utc(ed) <= now:
            ed += dt.timedelta(days=1)
        if only and ed != only:
            continue
        atrasado = 1 if ing_local > nxt else 0
        titulo, resumo = texts(e, atrasado)
        sc = compute_score(e, ed.isoformat())
        con.execute("INSERT INTO eventos (hash, data_evento, ingerido_em, edicao_data, secao, tipo, titulo, resumo_curto, fonte_modulo, fonte_ref, rota, source_url, entidades, score, revisao, atrasado) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
                    (h, e["data"], ing, ed.isoformat(), e["secao"], e["tipo"], titulo, resumo, e["modulo"], e["ref"], e["rota"], e["url"],
                     json.dumps(e["ents"], ensure_ascii=False), sc, atrasado))
        produced.add(h)
        stats["inseridos"][e["secao"]] += 1
    if only and prune_from:
        for r in con.execute("SELECT id, hash FROM eventos WHERE edicao_data = ? AND ia_artigo_id IS NULL AND data_evento >= ?", (only.isoformat(), prune_from)).fetchall():
            if r["hash"] not in produced:
                con.execute("DELETE FROM eventos WHERE id = ?", (r["id"],))
                stats["removidos"] = stats.get("removidos", 0) + 1
    return stats


ROTA_KEY = "_migracao.rota"
ROTA_VERSION = 2


def reroute_pending(con):
    row = con.execute("SELECT max_rowid FROM cursores WHERE fonte = ?", (ROTA_KEY,)).fetchone()
    return not (row and (row["max_rowid"] or 0) >= ROTA_VERSION)


def reroute_gather(con, src, today):
    lo = con.execute("SELECT MIN(data_evento) FROM eventos").fetchone()[0]
    if not lo:
        return [], []
    events, _, skipped = gather(con, src, lo, today, {}, True)
    return events, skipped


def reroute_apply(con, events, skipped, now):
    changed = 0
    for e in events:
        row = con.execute("SELECT id, rota, source_url, entidades FROM eventos WHERE hash = ?", (event_hash(e),)).fetchone()
        if row is None and e.get("once"):
            row = con.execute("SELECT id, rota, source_url, entidades FROM eventos WHERE fonte_modulo = ? AND fonte_ref = ? AND tipo = ?", (e["modulo"], e["ref"], e["tipo"])).fetchone()
        if row is None:
            continue
        ents = json.dumps(e["ents"], ensure_ascii=False)
        if (row["rota"], row["source_url"], row["entidades"]) != (e["rota"], e["url"], ents):
            con.execute("UPDATE eventos SET rota=?, source_url=?, entidades=?, revisao=revisao+1 WHERE id=?", (e["rota"], e["url"], ents, row["id"]))
            changed += 1
    used = {r[0] for r in con.execute("SELECT DISTINCT fonte_modulo FROM eventos")}
    if not any(x.split("(")[0] in used for x in skipped):
        con.execute("INSERT INTO cursores (fonte, max_rowid, max_data, atualizado_em) VALUES (?,?,NULL,?) "
                    "ON CONFLICT(fonte) DO UPDATE SET max_rowid = excluded.max_rowid, atualizado_em = excluded.atualizado_em", (ROTA_KEY, ROTA_VERSION, iso_utc(now)))
    return changed


def sync_editions(con, now):
    last = to_local(now).date()
    r = con.execute("SELECT MAX(edicao_data) FROM eventos").fetchone()[0]
    if r:
        last = max(last, dt.date.fromisoformat(r))
    d = FLOOR
    while d <= last:
        con.execute("INSERT OR IGNORE INTO edicoes (numero, data, estado) VALUES (?, ?, 'preliminar')", (numero(d), d.isoformat()))
        d += dt.timedelta(days=1)
    for row in con.execute("SELECT numero, data FROM edicoes WHERE estado = 'preliminar'").fetchall():
        c = close_utc(dt.date.fromisoformat(row["data"]))
        if c <= now:
            con.execute("UPDATE edicoes SET estado = 'fechada', fechada_em = ? WHERE numero = ?", (iso_utc(c), row["numero"]))


def open_ledger(data):
    Path(data).mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(f"file:{quote(str(Path(data) / 'diario.db'))}", uri=True, timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    return con


def run(data, src=None, now=None, rebuild=None):
    t0 = time.time()
    src = Path(src or data)
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0)
    today = to_local(now).date().isoformat()
    lo_date = dt.date.fromisoformat(today) - dt.timedelta(days=WINDOW)
    only = None
    if rebuild:
        only = dt.date.fromisoformat(rebuild)
        lo_date = min(lo_date, only - dt.timedelta(days=1 + WINDOW))
    con = open_ledger(data)
    try:
        if only:
            row = con.execute("SELECT estado FROM edicoes WHERE data = ?", (only.isoformat(),)).fetchone()
            if only < FLOOR or close_utc(only) <= now or (row and row["estado"] == "fechada"):
                return {"erro": f"edicao {only.isoformat()} fechada ou inexistente", "codigo": 2}
        cursors = {r["fonte"]: r["max_rowid"] for r in con.execute("SELECT fonte, max_rowid FROM cursores")}
        events, marks, skipped = gather(con, src, lo_date.isoformat(), today, cursors, bool(only))
        pend = [] if only or not reroute_pending(con) else reroute_gather(con, src, today)
        con.execute("BEGIN IMMEDIATE")
        moved = reroute_apply(con, pend[0], pend[1], now) if pend else 0
        stats = apply_events(con, events, now, only, lo_date.isoformat() if only else None)
        sync_editions(con, now)
        if not only:
            for k, (rid, mx) in marks.items():
                con.execute("INSERT INTO cursores (fonte, max_rowid, max_data, atualizado_em) VALUES (?,?,?,?) "
                            "ON CONFLICT(fonte) DO UPDATE SET max_rowid = excluded.max_rowid, max_data = excluded.max_data, "
                            "atualizado_em = CASE WHEN cursores.max_rowid IS NOT excluded.max_rowid OR cursores.max_data IS NOT excluded.max_data THEN excluded.atualizado_em ELSE cursores.atualizado_em END",
                            (k, rid, None if mx is None else str(mx), iso_utc(now)))
        con.execute("COMMIT")
    except Exception:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        con.close()
    return {"inseridos": dict(stats["inseridos"]), "atualizados": stats["atualizados"], "removidos": stats.get("removidos", 0),
            "ignorados": stats["ignorados_antes_do_limiar"], "reencaminhados": moved, "fontes_ignoradas": skipped, "segundos": round(time.time() - t0, 2)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Livro-razão diário (diario.db) a partir das bases locais, sem rede.")
    ap.add_argument("--date")
    ap.add_argument("--rebuild-edition")
    ap.add_argument("--shortlist")
    a = ap.parse_args(argv)
    data = Path(os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()
    src = Path(os.environ.get("ESTADO_ABERTO_SOURCE_DATA") or data).expanduser().resolve()
    if a.shortlist:
        print(S.shortlist_json(a.shortlist))
        return 0
    now = None
    if a.date:
        now = local_to_utc(dt.datetime.combine(dt.date.fromisoformat(a.date), dt.time(12, 0)))
    res = run(data, src, now, a.rebuild_edition)
    print(json.dumps(res, ensure_ascii=False))
    return res.get("codigo", 0)


if __name__ == "__main__":
    sys.exit(main())
