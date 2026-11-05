import json
import re
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT  # noqa: E402

NAME = "posicoes"
DB = ROOT / "data" / f"{NAME}.db"
CONFIG = ROOT / "seed" / "posicoes_topicos.json"
WINDOW_DAYS = 45
SENSE = {"favor": "favor", "contra": "contra", "abstencao": "abstenção"}

F = r"[,\s]+(?:[\w-]+[,\s]+){0,2}?"
V1 = r"(?:votaremos|votamos|votemos|vou\s+votar|vamos\s+votar|iremos\s+votar|irei\s+votar|o\s+nosso\s+voto\s+(?:ser[aá]|é))"
MARKERS = [
    ("favor", V1 + F + r"a\s+favor"),
    ("favor", V1 + F + r"favoravelmente"),
    ("favor", r"o\s+nosso\s+voto\s+(?:ser[aá]|é)\s+favor[aá]vel"),
    ("contra", V1 + F + r"contra"),
    ("contra", V1 + F + r"desfavoravelmente"),
    ("contra", r"o\s+nosso\s+voto\s+(?:ser[aá]|é)\s+desfavor[aá]vel"),
    ("abstenção", r"(?:vamos|iremos|vou|irei)" + F + r"abster(?:-nos|-me)?"),
    ("abstenção", r"abster-?nos-?emos|abstermo-nos|abstemo-nos"),
    ("abstenção", V1 + F + r"(?:a\s+)?absten[cç][aã]o"),
]
MARKERS = [(s, re.compile(p, re.I)) for s, p in MARKERS]
NEG = re.compile(r"(?:\bn[aã]o|\bnunca|\bjamais)\s+(?:\w+\s+){0,3}$", re.I)
PARTIAL = re.compile(r"\brecurso\b|\brequerimento|\bavoca|\bpropostas?\s+de\s+altera|\bartigo|\bal[ií]nea|\bnorma\b|\bem\s+parte\b|\bparcialmente|\bna\s+especialidade|,\s*tamb[eé]m\s*,|\bcada\s+uma\b|\bpor\s+partes\b", re.I)
COND = re.compile(r"\b(?:se|caso|desde\s+que|a\s+menos\s+que|salvo\s+se|quando|enquanto|se\s+n[aã]o)\b[^.?!;]*$", re.I)


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def load_topics():
    cfg = json.loads(CONFIG.read_text(encoding="utf8"))["temas"]
    out = {}
    for tema, kws in cfg.items():
        pats = []
        for k in kws:
            k = norm(k)
            end = r"\b" if k.endswith(" ") else ""
            pats.append(r"\b" + re.escape(k.rstrip()) + end)
        out[tema] = re.compile("|".join(pats))
    return out


def topics_for(title, topics):
    t = norm(title)
    return [tema for tema, rx in topics.items() if rx.search(t)]


def declarations(text):
    found = []
    for sense, rx in MARKERS:
        for m in rx.finditer(text):
            before = text[max(0, m.start() - 70):m.start()]
            if NEG.search(before):
                found.append(("neg", sense, m))
                continue
            sent_start = max(before.rfind(". "), before.rfind("? "), before.rfind("! "))
            clause = before[sent_start + 2:] if sent_start >= 0 else before
            if COND.search(clause):
                found.append(("cond", sense, m))
                continue
            tail = re.split(r"(?<=[.?!])\s", text[m.end():m.end() + 260], 1)[0]
            if re.search(r"\b(?:mas|embora|exceto|exce[cç][aã]o|salvo)\b|\bcontra\b|\ba\s+favor\b|\babst", tail, re.I):
                found.append(("mixed", sense, m))
                continue
            around = text[max(0, m.start() - 120):m.end() + 140]
            if PARTIAL.search(around):
                found.append(("partial", sense, m))
                continue
            found.append(("ok", sense, m))
    return found


def quote(text, m, pad=170):
    a = max(0, m.start() - pad)
    b = min(len(text), m.end() + pad)
    s = " ".join(text[a:b].split())
    return ("… " if a > 0 else "") + s + (" …" if b < len(text) else "")


SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE ini_tema (bid INTEGER, tema TEXT, PRIMARY KEY (bid, tema));
CREATE TABLE iv_tema (iv_id INTEGER, tema TEXT, PRIMARY KEY (iv_id, tema));
CREATE INDEX ivt_tema ON iv_tema(tema);
CREATE TABLE decl (
  id INTEGER PRIMARY KEY, iv_id INTEGER, dep_bid INTEGER, orador TEXT, partido TEXT, bid INTEGER, ref TEXT, titulo TEXT,
  data_discurso TEXT, declarado TEXT, citacao TEXT, voto_id INTEGER, fase TEXT, data_voto TEXT, voto TEXT, voto_origem TEXT,
  estado TEXT, coincide INTEGER, n_inic_discurso INTEGER, source_url TEXT, voto_url TEXT
);
CREATE INDEX decl_p ON decl(partido);
CREATE INDEX decl_d ON decl(dep_bid);
CREATE TABLE fala (id INTEGER PRIMARY KEY, leg TEXT, data TEXT, partido TEXT, dep_bid INTEGER, orador TEXT, kind TEXT, palavras INTEGER, ligada INTEGER);
CREATE INDEX fala_p ON fala(partido);
CREATE INDEX fala_d ON fala(dep_bid);
CREATE TABLE ini_partido (
  partido TEXT, bid INTEGER, ref TEXT, titulo TEXT, n_falas INTEGER, palavras INTEGER, primeira_fala TEXT,
  voto TEXT, data_voto TEXT, fase TEXT, voto_id INTEGER, voto_url TEXT, decl_id INTEGER
);
CREATE INDEX ip_p ON ini_partido(partido);
CREATE INDEX ip_b ON ini_partido(bid);
CREATE TABLE excl (motivo TEXT PRIMARY KEY, n INTEGER);
"""


def main():
    topics = load_topics()
    if DB.exists():
        DB.unlink()
    out = sqlite3.connect(DB, timeout=60)
    out.execute("PRAGMA journal_mode=WAL")
    out.executescript(SCHEMA)
    iv = sqlite3.connect(f"file:{ROOT / 'data' / 'intervencoes.db'}?mode=ro", uri=True, timeout=60)
    vt = sqlite3.connect(f"file:{ROOT / 'data' / 'votacoes.db'}?mode=ro", uri=True, timeout=60)
    titles = {b: (t, k) for b, t, k in vt.execute("SELECT bid, titulo, key FROM iniciativas")}
    ini_t = {}
    for bid, (t, _) in titles.items():
        ts = topics_for(t, topics)
        ini_t[bid] = ts
        out.executemany("INSERT INTO ini_tema VALUES (?,?)", [(bid, x) for x in ts])
    links = defaultdict(list)
    for ivid, bid, ref in iv.execute("SELECT iv_id, bid, ref FROM iv_ini WHERE bid IS NOT NULL"):
        links[ivid].append((bid, ref))
    rows = []
    for ivid, ls in links.items():
        ts = sorted({x for b, _ in ls for x in ini_t.get(b, [])})
        rows += [(ivid, x) for x in ts]
    out.executemany("INSERT INTO iv_tema VALUES (?,?)", rows)

    votes = defaultdict(list)
    for vid, bid, fase, data, src in vt.execute(
            "SELECT id, bid, fase, data, source_url FROM votos WHERE orgao = 'Plenário' AND fase LIKE 'Vota%' AND fase NOT LIKE '%especialidade%' ORDER BY data, id"):
        votes[bid].append((vid, fase, data, src))
    pv = defaultdict(dict)
    for vid, p, s, k, nome in vt.execute("SELECT voto_id, partido, sentido, kind, nome FROM voto_partido"):
        pv[(vid, p)].setdefault(k, []).append((s, nome))

    sib = defaultdict(set)
    for a, b in vt.execute("SELECT bid, outro_bid FROM conjuntas WHERE outro_bid IS NOT NULL"):
        sib[a].add(b)
        sib[b].add(a)
    excl = defaultdict(int)
    n = 0
    sql = """SELECT id, dep_bid, orador, partido, data, texto, source_url FROM intervencoes
             WHERE kind = 'dep' AND partido IN ('BE','CDS-PP','CH','IL','JPP','L','PAN','PCP','PS','PSD') AND id IN (SELECT iv_id FROM iv_ini WHERE bid IS NOT NULL)"""
    from datetime import date
    for ivid, dep, orador, partido, data, texto, src in iv.execute(sql):
        found = declarations(texto or "")
        if not found:
            continue
        ok = [f for f in found if f[0] == "ok"]
        if not ok:
            excl["marcador negado, condicional, com ressalva ou de objeto parcial"] += 1
            continue
        senses = {f[1] for f in ok}
        if len(senses) > 1:
            excl["discurso com declarações contraditórias"] += 1
            continue
        sense = senses.pop()
        m = next(f[2] for f in ok if f[1] == sense)
        cite = quote(texto, m)
        ls = links[ivid]
        d0 = date.fromisoformat(data)
        linked = {b for b, _ in ls}
        cand = list(ls) + [(b, None) for l in list(linked) for b in sorted(sib.get(l, ())) if b not in linked]
        per_ini = []
        for bid, ref in cand:
            win = [(vid, fase, dv, vsrc) for vid, fase, dv, vsrc in votes.get(bid, [])
                   if dv >= data and (date.fromisoformat(dv) - d0).days <= WINDOW_DAYS and (vid, partido) in pv]
            per_ini.append((bid, ref, win))

        def party_vote(vid):
            d = pv[(vid, partido)]
            if "gp" in d:
                return d["gp"][0][0], "grupo parlamentar"
            for s, nome in d.get("dep", []):
                if nome and norm(nome) == norm(orador):
                    return s, "voto individual"
            return "dividido", "voto dividido"

        if any(not w for _, _, w in per_ini):
            excl["sem votação em plenário registada para todas as iniciativas em debate (45 dias)"] += 1
            continue
        senses_v = {party_vote(v[0])[0] for _, _, w in per_ini for v in w}
        if len(senses_v) > 1:
            excl["votações distintas ou iniciativas do debate com sentidos de voto diferentes"] += 1
            continue
        mine = [(bid, ref, w[0]) for bid, ref, w in per_ini if bid in linked][:1]
        for bid, ref, ch in mine:
            vid, fase, dv, vsrc = ch
            sv, origem = party_vote(vid)
            sentido = SENSE.get(sv, sv)
            estado = "dividido" if sv == "dividido" else ("ausente" if sv == "ausencia" else "comparavel")
            coincide = None if estado != "comparavel" else int(sentido == sense)
            out.execute(
                "INSERT INTO decl (iv_id, dep_bid, orador, partido, bid, ref, titulo, data_discurso, declarado, citacao, voto_id, fase, data_voto, voto, voto_origem, estado, coincide, n_inic_discurso, source_url, voto_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (ivid, dep, orador, partido, bid, ref, titles.get(bid, ("", ""))[0], data, sense, cite, vid, fase, dv, sentido, origem, estado, coincide, len(cand), src, vsrc))
            n += 1
    out.executemany("INSERT INTO fala VALUES (?,?,?,?,?,?,?,?,?)", [
        (i, leg, d, p or None, dep, o, k, w, 1 if i in links else 0)
        for i, leg, d, p, dep, o, k, w in iv.execute("SELECT id, leg, data, partido, dep_bid, orador, kind, palavras FROM intervencoes")])
    refs = {}
    spoke = defaultdict(list)
    for ivid, bid, ref in iv.execute("SELECT iv_id, bid, ref FROM iv_ini WHERE bid IS NOT NULL"):
        refs[bid] = ref
    for ivid, p, d, w in iv.execute("SELECT id, partido, data, palavras FROM intervencoes WHERE kind = 'dep' AND partido IN ('BE','CDS-PP','CH','IL','JPP','L','PAN','PCP','PS','PSD')"):
        for bid, _ in links.get(ivid, []):
            spoke[(p, bid)].append((d, w))
    declid = {(r[0], r[1]): r[2] for r in out.execute("SELECT partido, bid, MIN(id) FROM decl GROUP BY partido, bid")}
    for (p, bid), fs in spoke.items():
        d0 = min(d for d, _ in fs)
        t0 = date.fromisoformat(d0)
        win = [v for v in votes.get(bid, []) if v[2] >= d0 and (date.fromisoformat(v[2]) - t0).days <= WINDOW_DAYS and (v[0], p) in pv]
        if not win:
            continue
        sv = set()
        for v in win:
            g = pv[(v[0], p)].get("gp")
            sv.add(g[0][0] if g else "dividido")
        sense = SENSE.get(next(iter(sv)), next(iter(sv))) if len(sv) == 1 else "varia"
        out.execute("INSERT INTO ini_partido VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (p, bid, refs.get(bid), titles.get(bid, ("", ""))[0], len(fs), sum(w or 0 for _, w in fs), d0, sense, win[0][2], win[0][1], win[0][0], win[0][3], declid.get((p, bid))))
    out.executemany("INSERT INTO excl VALUES (?,?)", list(excl.items()))
    out.executemany("INSERT INTO meta VALUES (?,?)", [
        ("updated_at", __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("declaracoes", str(n)), ("janela_dias", str(WINDOW_DAYS))])
    out.commit()
    print(f"posicoes: {n} declarações; excluídas {dict(excl)}")


if __name__ == "__main__":
    main()
