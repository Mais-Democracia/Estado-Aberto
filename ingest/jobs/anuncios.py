"""Anúncios de concurso (Portal BASE / IMPIC) -> data/anuncios.db

Fonte: dataset dados.gov.pt "Contratos Públicos - Portal Base - IMPIC - Anúncios de 2012 a 2026"
(id 66d72fbc58cd7a63dae28712).  Os URLs dos ficheiros têm carimbo temporal: são sempre lidos da API.
JSON anual em streaming (raw_decode), cache em data/raw/anuncios/.

O que se constrói (tudo explicável; nada é acusação)
  * announcements      um registo por aviso publicado (todos os tipos de ato).  `is_primary`=1 no primeiro
                       "Anúncio de procedimento"/"concurso urgente" de cada (nAnuncio, NIF da entidade); os restantes
                       (prorrogação, alteração, retificação, duplicados) ficam marcados e contados em n_amend.
  * contract_links     ligação anúncio -> contrato por (contracts.announcement = nAnuncio) E contracts.buyer_nif = NIF.
  * contracts_no_ann   contratos por procedimento concorrencial sem anúncio correspondente (sem referência / referência não
                       encontrada / referência anterior a 2012 -> excluída das contagens).
  * announcements.followed / unfollowed  procedimentos anunciados que nunca aparecem num contrato publicado.
  * buyer_stats, flags indicadores por comprador, comparados com pares do mesmo entities.kind.
Lê politica.db só em leitura (uri mode=ro).  Escreve só em data/anuncios.db.
"""
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, ROOT, UA, connect_writer  # noqa: E402

NAME = "anuncios"
DB = DATA_DIR / f"{NAME}.db"
POLITICA = DATA_DIR / "politica.db"
RAW = DATA_DIR / "raw" / NAME
DATASET = "66d72fbc58cd7a63dae28712"
API = f"https://dados.gov.pt/api/1/datasets/{DATASET}/"
DATASET_URL = "https://dados.gov.pt/pt/datasets/contratos-publicos-portal-base-impic-anuncios-de-2012-a-2026/"

PRIMARY_ACTS = {"Anúncio de procedimento", "Anúncio de concurso urgente"}
# modelos de anúncio que dão origem a um contrato publicado no BASE
TENDER = {"Concurso público", "Concurso público urgente", "Concurso limitado por prévia qualificação", "Concurso público simplificado",
          "Concurso limitado por prévia qualificação simplificado", "Procedimento de negociação", "Diálogo concorrencial",
          "Parceria para a inovação"}
# prazos comparáveis: concurso público/limitado (não urgente)
DEADLINE_MODELS = {"Concurso público", "Concurso público simplificado", "Concurso limitado por prévia qualificação",
                   "Concurso limitado por prévia qualificação simplificado"}
COMPETITIVE_CONTRACT = {"Concurso público", "Concurso limitado por prévia qualificação", "Concurso público simplificado",
                        "Concurso limitado por prévia qualificação simplificado", "Procedimento de negociação"}
SNAPSHOT_GRACE_DAYS = 400   # um anúncio só conta como "sem contrato" se tiver pelo menos ~13 meses
MIN_N = 10                  # mínimo de observações por comprador para entrar nos rankings


def log(*a):
    print("[anuncios]", *a, flush=True)


# ---------------------------------------------------------------- download + streaming parse
def http(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            log("retry", url, e)
            time.sleep(3 * (i + 1))
    raise RuntimeError("download falhou: " + url)


def resources():
    RAW.mkdir(parents=True, exist_ok=True)
    meta = RAW / "dataset.json"
    try:
        d = json.loads(http(API))
        meta.write_text(json.dumps(d))
    except Exception:  # noqa: BLE001
        d = json.loads(meta.read_text())
        log("API indisponível; a usar metadados em cache")
    out = {}
    for r in d["resources"]:
        m = re.fullmatch(r"anuncios(\d{4})\.json", r["title"])
        if m:
            out[int(m.group(1))] = r
    return out, d


def fetch_all():
    res, ds = resources()
    files = {}
    for y, r in sorted(res.items()):
        p = RAW / f"anuncios{y}.json"
        stamp = RAW / f"anuncios{y}.json.url"
        # o ano corrente muda: volta a descarregar se o URL (com carimbo) mudou
        if not p.exists() or p.stat().st_size == 0 or (stamp.exists() and stamp.read_text() != r["url"] and y >= date.today().year - 1):
            log("a descarregar", r["title"])
            p.write_bytes(http(r["url"]))
            stamp.write_text(r["url"])
            time.sleep(1.0)
        files[y] = p
    return files, ds


def stream_records(path):
    """Gera os objetos do array JSON sem carregar o ficheiro inteiro."""
    dec = json.JSONDecoder()
    with open(path, "r", encoding="utf-8") as f:
        buf = f.read(1 << 20)
        i = buf.index("[") + 1
        while True:
            while True:
                while i < len(buf) and buf[i] in " \r\n\t,":
                    i += 1
                if i < len(buf):
                    break
                more = f.read(1 << 20)
                if not more:
                    return
                buf = buf[i:] + more
                i = 0
            if buf[i] == "]":
                return
            try:
                obj, j = dec.raw_decode(buf, i)
            except json.JSONDecodeError:
                more = f.read(1 << 20)
                if not more:
                    return
                buf = buf[i:] + more
                i = 0
                continue
            yield obj
            i = j
            if i > (1 << 22):
                buf = buf[i:]
                i = 0


# ---------------------------------------------------------------- helpers
def d_iso(s):
    if not s:
        return None
    try:
        return datetime.strptime(s.strip(), "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def num(s):
    try:
        v = float(str(s).replace(",", "."))
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


BASE_MAX = 5e9          # preços base acima disto (erros de digitação no BASE) são ignorados
IMPLAUSIBLE = [0]


def base_num(s):
    v = num(s)
    if v is not None and v > BASE_MAX:
        IMPLAUSIBLE[0] += 1
        return None
    return v


def nifc(s):
    s = re.sub(r"\D", "", str(s or ""))
    return s if len(s) == 9 else (s or None)


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    f = math.floor(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def median(v):
    return percentile(sorted(v), 0.5)


SCHEMA = """
DROP TABLE IF EXISTS announcements; DROP TABLE IF EXISTS contract_links; DROP TABLE IF EXISTS contracts_no_ann;
DROP TABLE IF EXISTS buyer_stats; DROP TABLE IF EXISTS flags; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS source_files;
DROP TABLE IF EXISTS cpv_stats;
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY, n_anuncio TEXT, id_incm TEXT, year INTEGER, published TEXT,
  buyer_nif TEXT, buyer_name TEXT, buyer_kind TEXT, buyer_entity_id INTEGER, location TEXT,
  tipo_acto TEXT, procedure TEXT, contract_types TEXT, base_price REAL, prazo_dias INTEGER, deadline TEXT,
  cpv_code TEXT, cpv_desc TEXT, description TEXT, n_lotes INTEGER, url TEXT, source_url TEXT,
  is_primary INTEGER, is_tender INTEGER, n_amend INTEGER DEFAULT 0, n_contracts INTEGER DEFAULT 0, contract_value REAL,
  first_contract_id TEXT, unfollowed INTEGER DEFAULT 0, ok_deadline INTEGER DEFAULT 0, obras INTEGER DEFAULT 0,
  post2018 INTEGER DEFAULT 0, short INTEGER DEFAULT 0
);
CREATE INDEX ann_key ON announcements(n_anuncio, buyer_nif);
CREATE INDEX ann_buyer ON announcements(buyer_nif, published);
CREATE INDEX ann_year ON announcements(year);
CREATE INDEX ann_cpv ON announcements(cpv_code);
CREATE INDEX ann_pub ON announcements(published);
CREATE INDEX ann_unf ON announcements(unfollowed, published);
CREATE TABLE contract_links (
  contract_id TEXT PRIMARY KEY, announcement_id INTEGER, buyer_nif TEXT, procedure TEXT, signed TEXT, price REAL, base_price REAL,
  n_bidders INTEGER, seller_nif TEXT, seller_name TEXT, at_base INTEGER, discount REAL
);
CREATE INDEX cl_ann ON contract_links(announcement_id);
CREATE INDEX cl_buyer ON contract_links(buyer_nif);
CREATE INDEX cl_seller ON contract_links(seller_nif);
CREATE TABLE contracts_no_ann (
  contract_id TEXT PRIMARY KEY, buyer_nif TEXT, buyer_name TEXT, buyer_kind TEXT, procedure TEXT, signed TEXT, price REAL,
  n_bidders INTEGER, announcement_ref TEXT, reason TEXT, seller_nif TEXT, seller_name TEXT, object TEXT
);
CREATE INDEX cna_buyer ON contracts_no_ann(buyer_nif);
CREATE INDEX cna_reason ON contracts_no_ann(reason, signed);
CREATE TABLE buyer_stats (
  nif TEXT PRIMARY KEY, name TEXT, entity_id INTEGER, kind TEXT, n_ann INTEGER, n_tender INTEGER, n_followed INTEGER, n_unfollowed INTEGER,
  n_eligible_unf INTEGER, base_total REAL, n_dl INTEGER, dl_median REAL, dl_short INTEGER,
  n_comp INTEGER, n_noann INTEGER, n_at_base INTEGER, n_base_cmp INTEGER, first_pub TEXT, last_pub TEXT
);
CREATE TABLE flags (
  kind TEXT, nif TEXT, name TEXT, ekind TEXT, n INTEGER, k INTEGER, rate REAL, peer_rate REAL, peer_p90 REAL, nat_rate REAL,
  z REAL, rank INTEGER, evidence TEXT
);
CREATE INDEX flags_k ON flags(kind, rank);
CREATE INDEX flags_nif ON flags(nif);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE source_files (year INTEGER, title TEXT, url TEXT, filesize INTEGER, n_records INTEGER);
"""


def main():
    files, ds = fetch_all()
    DB.parent.mkdir(exist_ok=True)
    out = connect_writer(DB)
    out.executescript(SCHEMA)
    pol = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True)
    pol.row_factory = sqlite3.Row

    ents = {r["nif"]: r for r in pol.execute("SELECT id, nif, name, kind, district, municipality FROM entities WHERE nif IS NOT NULL")}

    # ---------------- 1. announcements
    log("a ler anúncios")
    res, _ = resources()
    rows = []
    perfile = {}
    for y, p in files.items():
        n = 0
        for r in stream_records(p):
            n += 1
            nif = nifc(r.get("nifEntidade"))
            e = ents.get(nif)
            cpvs = r.get("CPVs") or []
            cpv_code, cpv_desc = (None, None)
            if cpvs:
                m = re.match(r"\s*(\d{8}(?:-\d)?)\s*-?\s*(.*)", cpvs[0])
                if m:
                    cpv_code, cpv_desc = m.group(1), m.group(2)
            types = r.get("tiposContrato") or []
            pub = d_iso(r.get("dataPublicacao"))
            dl = d_iso(r.get("DataLimitePropostas"))
            prazo = r.get("PrazoPropostas")
            if pub and dl:
                prazo = (date.fromisoformat(dl) - date.fromisoformat(pub)).days   # igual a PrazoPropostas em todos os registos conferidos
            elif not dl:
                prazo = None if not prazo else prazo
            loc = None
            if e:
                loc = ", ".join(x for x in (e["municipality"], e["district"]) if x) or None
            rows.append((
                (r.get("nAnuncio") or "").strip(), r.get("IdIncm"), r.get("Ano"), pub, nif, (r.get("designacaoEntidade") or "").strip(),
                e["kind"] if e else None, e["id"] if e else None, loc, r.get("tipoActo"), r.get("modeloAnuncio"), "; ".join(types) or None,
                base_num(r.get("PrecoBase")), prazo if (dl and prazo is not None and prazo >= 0) else None, dl, cpv_code, cpv_desc,
                (r.get("descricaoAnuncio") or "").replace("\r", " ").strip()[:500], len(r.get("Lotes") or []), r.get("url"),
                DATASET_URL, 1 if any("mpreitada" in t for t in types) else 0,
            ))
        perfile[y] = n
        log(y, n)
    # chave de ordenação para eleger o primário: primeiro anúncio de procedimento/urgente por (n, nif)
    rows.sort(key=lambda t: (t[0], t[4] or "", t[3] or ""))
    out.executemany("""INSERT INTO announcements (n_anuncio,id_incm,year,published,buyer_nif,buyer_name,buyer_kind,buyer_entity_id,location,
        tipo_acto,procedure,contract_types,base_price,prazo_dias,deadline,cpv_code,cpv_desc,description,n_lotes,url,source_url,obras)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    out.commit()
    for y, p in files.items():
        r = res.get(y, {})
        out.execute("INSERT INTO source_files VALUES (?,?,?,?,?)", (y, r.get("title"), r.get("url"), r.get("filesize"), perfile[y]))

    # primário: o primeiro "Anúncio de procedimento/urgente" de cada (n_anuncio, nif)
    out.execute("""UPDATE announcements SET is_primary=0, is_tender=0""")
    out.execute("""UPDATE announcements SET is_primary=1 WHERE id IN (
        SELECT MIN(id) FROM announcements WHERE tipo_acto IN ('Anúncio de procedimento','Anúncio de concurso urgente')
        GROUP BY n_anuncio, buyer_nif)""")
    # só os anúncios originais (procedimento / concurso urgente) contam como procedimentos; prorrogações, alterações e retificações ficam à parte
    out.execute("UPDATE announcements SET post2018=1 WHERE published>='2018-01-01'")
    out.execute("""UPDATE announcements SET n_amend=(SELECT COUNT(*) FROM announcements b WHERE b.n_anuncio=announcements.n_anuncio AND
        b.buyer_nif=announcements.buyer_nif AND b.id<>announcements.id) WHERE is_primary=1""")
    out.execute("UPDATE announcements SET is_tender=1 WHERE is_primary=1 AND procedure IN (%s)" % ",".join("?" * len(TENDER)), tuple(TENDER))
    out.execute("UPDATE announcements SET ok_deadline=1 WHERE is_primary=1 AND tipo_acto='Anúncio de procedimento' AND procedure IN (%s) AND prazo_dias IS NOT NULL AND deadline IS NOT NULL" % ",".join("?" * len(DEADLINE_MODELS)), tuple(DEADLINE_MODELS))
    out.commit()
    n_primary = out.execute("SELECT COUNT(*) FROM announcements WHERE is_primary=1").fetchone()[0]
    log("anúncios (registos)", len(rows), "primários", n_primary)

    # ---------------- 2. ligação anúncio <-> contrato
    log("a ligar contratos")
    key2id = {}
    # a ligação aceita também avisos de alteração/prorrogação quando o original não consta (o original tem prioridade)
    for r in out.execute("SELECT id, n_anuncio, buyer_nif FROM announcements ORDER BY is_primary ASC, id DESC"):
        key2id[(r[1], r[2])] = r[0]
    # número -> existe com outro NIF (para distinguir "referência encontrada com outro comprador")
    num_any = {r[0] for r in out.execute("SELECT DISTINCT n_anuncio FROM announcements")}
    links = []
    noann = []
    comp_ph = ",".join("?" * len(COMPETITIVE_CONTRACT))
    q = f"""SELECT id, announcement, procedure, buyer_nif, buyer_name, seller_nif, seller_name, signed, price, base_price, n_bidders, object
            FROM contracts WHERE (announcement IS NOT NULL AND announcement<>'') OR procedure IN ({comp_ph})"""
    stats = Counter()
    unmatched_refs = set()
    for c in pol.execute(q, tuple(COMPETITIVE_CONTRACT)):
        ref = (c["announcement"] or "").strip().replace("\xa0", "")
        bn = nifc(c["buyer_nif"])
        aid = key2id.get((ref, bn)) if ref else None
        if aid:
            links.append((c["id"], aid, bn, c["procedure"], c["signed"], c["price"], None, c["n_bidders"], nifc(c["seller_nif"]),
                          c["seller_name"], None, None))
            stats["linked"] += 1
        elif c["procedure"] in COMPETITIVE_CONTRACT:
            if (c["signed"] or "") < "2013-01-01":
                stats["comp_before_2013"] += 1
                continue
            m = re.search(r"/(\d{4})\s*$", ref)
            if not ref:
                reason = "sem_referencia"
            elif m and int(m.group(1)) < 2012:
                reason = "anterior_2012"       # o conjunto de dados só começa em 2012
            elif ref in num_any:
                reason = "outro_comprador"     # existe um anúncio com esse número, mas de outro NIF
            else:
                reason = "nao_encontrada"
            stats["noann_" + reason] += 1
            if ref:
                unmatched_refs.add(ref)
            e = ents.get(bn)
            noann.append((c["id"], bn, c["buyer_name"], e["kind"] if e else None, c["procedure"], c["signed"], c["price"], c["n_bidders"], ref or None, reason,
                          nifc(c["seller_nif"]), c["seller_name"], (c["object"] or "")[:200]))
        else:
            stats["announced_not_competitive_unmatched"] += 1
            if ref:
                unmatched_refs.add(ref)
    out.executemany("INSERT OR REPLACE INTO contract_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", links)
    out.executemany("INSERT OR REPLACE INTO contracts_no_ann VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", noann)
    out.execute("""UPDATE announcements SET n_contracts=(SELECT COUNT(*) FROM contract_links l WHERE l.announcement_id=announcements.id),
        contract_value=(SELECT SUM(price) FROM contract_links l WHERE l.announcement_id=announcements.id),
        first_contract_id=(SELECT contract_id FROM contract_links l WHERE l.announcement_id=announcements.id ORDER BY signed LIMIT 1)""")
    # preço contratado vs preço base: só quando a comparação é limpa (anúncio com UM contrato, sem lotes, procedimento concorrencial,
    # preço base do anúncio plausível).  O campo "preço base" dos contratos mistura lotes/acordos-quadro (mediana de "desconto" 41%) e não se usa.
    out.execute(f"""UPDATE contract_links SET base_price=(SELECT a.base_price FROM announcements a WHERE a.id=announcement_id)
        WHERE price>0 AND procedure IN ({comp_ph}) AND announcement_id IN (SELECT id FROM announcements WHERE n_contracts=1 AND n_lotes=0 AND base_price>0)""", tuple(COMPETITIVE_CONTRACT))
    out.execute("UPDATE contract_links SET discount=1-price/base_price, at_base=CASE WHEN ABS(price-base_price)<0.005 THEN 1 ELSE 0 END WHERE base_price>0")
    # procedimentos anunciados sem contrato (só se já passou tempo suficiente e o modelo origina contrato)
    cutoff = date.fromordinal(date.today().toordinal() - SNAPSHOT_GRACE_DAYS).isoformat()
    out.execute(f"""UPDATE announcements SET unfollowed=1 WHERE is_primary=1 AND is_tender=1 AND n_contracts=0 AND published<=? AND buyer_nif IS NOT NULL AND buyer_nif<>''""", (cutoff,))
    # conservador: se algum contrato com outro NIF de comprador cita o mesmo número, não se afirma que ficou sem contrato
    # (os números repetem-se entre entidades e os NIF mudam em reorganizações, por isso fica ambíguo)
    amb = 0
    for (n,) in out.execute("SELECT DISTINCT n_anuncio FROM announcements WHERE unfollowed=1").fetchall():
        if n in unmatched_refs:
            amb += out.execute("UPDATE announcements SET unfollowed=0, ok_deadline=ok_deadline WHERE unfollowed=1 AND n_anuncio=?", (n,)).rowcount
    stats["unfollowed_excluded_ambiguous_ref"] = amb
    out.commit()
    log(dict(stats))

    # ---------------- 3. estatísticas por comprador
    log("indicadores")
    # limiar "prazo curto": percentil 10 nacional por tipo (empreitada / outros) em concursos públicos não urgentes
    # o limiar é calculado por regime (anúncios até 2017 / desde 2018-01-01): a distribuição dos prazos muda de forma em 2018
    dls = defaultdict(list)
    for r in out.execute("SELECT obras, post2018, prazo_dias FROM announcements WHERE ok_deadline=1 AND prazo_dias>0"):
        dls[(r[0], r[1])].append(r[2])
    short_thr = {k: percentile(sorted(v), 0.10) for k, v in dls.items()}
    log("limiar prazo curto (p10 por tipo e regime)", short_thr)
    for (ob, rg), thr in short_thr.items():
        out.execute("UPDATE announcements SET short=1 WHERE ok_deadline=1 AND prazo_dias>0 AND obras=? AND post2018=? AND prazo_dias<=?", (ob, rg, thr))
    out.commit()

    B = defaultdict(lambda: dict(n_ann=0, n_tender=0, n_followed=0, n_unf=0, base_total=0.0, dl=[], dl_short=0, n_comp=0, n_noann=0,
                                 n_at_base=0, n_base_cmp=0, first=None, last=None))
    for r in out.execute("""SELECT buyer_nif, buyer_name, published, is_tender, n_contracts, unfollowed, base_price, ok_deadline, prazo_dias, short
                            FROM announcements WHERE is_primary=1 AND buyer_nif IS NOT NULL"""):
        b = B[r[0]]
        b["name"] = r[1]
        b["n_ann"] += 1
        if r[2]:
            b["first"] = min(b["first"] or r[2], r[2])
            b["last"] = max(b["last"] or r[2], r[2])
        if r[3]:
            b["n_tender"] += 1
            if r[4]:
                b["n_followed"] += 1
            if r[5]:
                b["n_unf"] += 1
            if r[6]:
                b["base_total"] += r[6]
        if r[7] and r[8] and r[8] > 0:
            b["dl"].append(r[8])
            if r[9]:
                b["dl_short"] += 1
    # contratos concorrenciais por comprador (denominador do "sem anúncio")
    for r in pol.execute(f"""SELECT buyer_nif, COUNT(*) FROM contracts WHERE procedure IN ({comp_ph}) AND signed>='2013-01-01'
                             AND buyer_nif IS NOT NULL GROUP BY buyer_nif""", tuple(COMPETITIVE_CONTRACT)):
        B[nifc(r[0])]["n_comp"] += r[1]
    for r in out.execute("SELECT buyer_nif, COUNT(*) FROM contracts_no_ann WHERE reason IN ('sem_referencia','nao_encontrada') GROUP BY buyer_nif"):
        B[r[0]]["n_noann"] += r[1]
    for r in out.execute("SELECT buyer_nif, SUM(at_base), COUNT(at_base) FROM contract_links WHERE at_base IS NOT NULL GROUP BY buyer_nif"):
        B[r[0]]["n_at_base"] += r[1]
        B[r[0]]["n_base_cmp"] += r[2]
    out_rows = []
    for nif, b in B.items():
        if not nif:
            continue
        e = ents.get(nif)
        out_rows.append((nif, (e["name"] if e else b.get("name")), e["id"] if e else None, e["kind"] if e else None, b["n_ann"], b["n_tender"],
                         b["n_followed"], b["n_unf"], b["n_tender"], b["base_total"], len(b["dl"]), median(b["dl"]), b["dl_short"], b["n_comp"],
                         b["n_noann"], b["n_at_base"], b["n_base_cmp"], b["first"], b["last"]))
    out.executemany("INSERT INTO buyer_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", out_rows)
    out.commit()

    # ---------------- 4. flags (comparação com pares do mesmo entities.kind)
    S = {r[0]: r for r in out.execute("SELECT * FROM buyer_stats")}
    flags = []

    def binom_flags(kind, num_key, den_key, minn, mink, evid):
        by_kind = defaultdict(lambda: [0, 0])
        for nif, s in S.items():
            ek = s[3] or "?"
            by_kind[ek][0] += num_key(s)
            by_kind[ek][1] += den_key(s)
        tot_k = sum(v[0] for v in by_kind.values())
        tot_n = sum(v[1] for v in by_kind.values())
        nat = tot_k / tot_n if tot_n else 0
        # taxas por comprador (n >= minn) por tipo, para mediana/p90 dos pares
        rates = defaultdict(list)
        for nif, s in S.items():
            if den_key(s) >= minn:
                rates[s[3] or "?"].append(num_key(s) / den_key(s))
        cand = []
        for nif, s in S.items():
            n, k = den_key(s), num_key(s)
            if n < minn or k < mink:
                continue
            ek = s[3] or "?"
            peers = sorted(rates[ek])
            if len(peers) < 5:
                peer_rate, p90, pool = median(sorted(rates[ek] + [x for v in rates.values() for x in v])) if False else nat, None, nat
            else:
                peer_rate, p90 = median(peers), percentile(peers, 0.9)
                pool = by_kind[ek][0] / by_kind[ek][1] if by_kind[ek][1] else nat   # taxa agregada dos pares (denominador do z)
            p = min(max(pool, 1e-6), 1 - 1e-6)
            z = (k - n * p) / math.sqrt(n * p * (1 - p))
            if k / n <= pool:
                continue
            cand.append((z, nif, s, n, k, peer_rate, p90, nat, len(peers)))
        cand.sort(key=lambda t: -t[0])
        for i, (z, nif, s, n, k, pr, p90, nat_, npeers) in enumerate(cand, 1):
            flags.append((kind, nif, s[1], s[3], n, k, k / n, pr, p90, nat_, z, i, json.dumps(evid(nif, s, npeers), ensure_ascii=False)))
        log(kind, "compradores:", len(cand), "taxa nacional %.4f" % nat)

    # 4a. prazos curtos
    def ev_short(nif, s, npeers):
        rows = out.execute("""SELECT id, n_anuncio, published, prazo_dias, base_price, description FROM announcements WHERE buyer_nif=? AND short=1
                              ORDER BY prazo_dias, published DESC LIMIT 12""", (nif,)).fetchall()
        return {"limiares_p10": {f"{'empreitadas' if k[0] else 'bens_servicos'}_{'desde_2018' if k[1] else 'ate_2017'}": v for k, v in short_thr.items()}, "mediana_dias": s[11], "n_pares": npeers,
                "anuncios": [list(r) for r in rows]}
    binom_flags("prazo_curto", lambda s: s[12], lambda s: s[10], MIN_N, 3, ev_short)

    # 4b. concursos sem anúncio
    def ev_noann(nif, s, npeers):
        rows = out.execute("""SELECT contract_id, signed, price, reason, announcement_ref, seller_name, object FROM contracts_no_ann
                              WHERE buyer_nif=? AND reason IN ('sem_referencia','nao_encontrada') ORDER BY signed DESC LIMIT 12""", (nif,)).fetchall()
        rs = dict(out.execute("SELECT reason, COUNT(*) FROM contracts_no_ann WHERE buyer_nif=? GROUP BY reason", (nif,)).fetchall())
        return {"motivos": rs, "n_pares": npeers, "contratos": [list(r) for r in rows]}
    binom_flags("sem_anuncio", lambda s: s[14], lambda s: s[13], MIN_N, 3, ev_noann)

    # 4c. anunciados sem contrato
    def ev_unf(nif, s, npeers):
        rows = out.execute("""SELECT id, n_anuncio, published, base_price, description FROM announcements WHERE buyer_nif=? AND unfollowed=1
                              ORDER BY published DESC LIMIT 12""", (nif,)).fetchall()
        return {"corte_publicacao": cutoff, "n_pares": npeers, "anuncios": [list(r) for r in rows]}
    # denominador: concursos anunciados com tempo suficiente para terem contrato
    elig = {r[0]: r[1] for r in out.execute("SELECT buyer_nif, COUNT(*) FROM announcements WHERE is_primary=1 AND is_tender=1 AND published<=? GROUP BY buyer_nif", (cutoff,))}
    # reutiliza buyer_stats.n_eligible_unf
    for nif, v in elig.items():
        out.execute("UPDATE buyer_stats SET n_eligible_unf=? WHERE nif=?", (v, nif))
    out.execute("UPDATE buyer_stats SET n_eligible_unf=0 WHERE nif NOT IN (SELECT buyer_nif FROM announcements WHERE is_primary=1 AND is_tender=1 AND published<=?)", (cutoff,))
    out.commit()
    S = {r[0]: r for r in out.execute("SELECT * FROM buyer_stats")}
    binom_flags("sem_contrato", lambda s: s[7], lambda s: s[8], MIN_N, 3, ev_unf)

    # 4d. adjudicação exatamente ao preço base
    def ev_base(nif, s, npeers):
        rows = out.execute("""SELECT l.contract_id, l.signed, l.price, l.n_bidders, l.seller_name FROM contract_links l WHERE l.buyer_nif=? AND l.at_base=1
                              ORDER BY l.signed DESC LIMIT 12""", (nif,)).fetchall()
        one = out.execute("SELECT COUNT(*) FROM contract_links WHERE buyer_nif=? AND at_base=1 AND n_bidders<=1", (nif,)).fetchone()[0]
        return {"ao_preco_base_com_1_concorrente": one, "n_pares": npeers, "contratos": [list(r) for r in rows]}
    binom_flags("preco_base", lambda s: s[15], lambda s: s[16], MIN_N, 3, ev_base)

    # 4e. vencedor repetido entre procedimentos anunciados
    # quota do vencedor mais frequente entre procedimentos anunciados (contratos distintos por anúncio contados uma vez por vendedor)
    wins = defaultdict(lambda: defaultdict(set))
    for r in out.execute("SELECT buyer_nif, seller_nif, announcement_id FROM contract_links WHERE seller_nif IS NOT NULL"):
        wins[r[0]][r[1]].add(r[2])
    tot_ann = defaultdict(set)
    for r in out.execute("SELECT buyer_nif, announcement_id FROM contract_links"):
        tot_ann[r[0]].add(r[1])
    rw = []
    for nif, d in wins.items():
        n = len(tot_ann[nif])
        if n < MIN_N or nif not in S:
            continue
        top, anns = max(d.items(), key=lambda kv: len(kv[1]))
        rw.append((nif, n, top, len(anns), len(anns) / n, len(d)))
    def nbucket(n):
        return 0 if n < 20 else (1 if n < 50 else 2)
    groups = defaultdict(list)
    for t in rw:
        groups[(S[t[0]][3] or "?", nbucket(t[1]))].append(t[4])
    allr = sorted(t[4] for t in rw)
    cand = []
    for nif, n, top, k, share, nsel in rw:
        g = sorted(groups[(S[nif][3] or "?", nbucket(n))])
        if len(g) >= 5:
            pr, p90 = percentile(g, 0.5), percentile(g, 0.9)
        else:
            pr, p90 = percentile(allr, 0.5), percentile(allr, 0.9)
        if k < 4 or share <= pr:
            continue
        # z aproximado vs mediana dos pares (binomial), só para ordenar
        p = min(max(pr, 1e-6), 1 - 1e-6)
        z = (k - n * p) / math.sqrt(n * p * (1 - p))
        cand.append((z, nif, n, top, k, share, pr, p90, nsel, len(g)))
    cand.sort(key=lambda t: -t[0])
    for i, (z, nif, n, top, k, share, pr, p90, nsel, ng) in enumerate(cand, 1):
        sname = out.execute("SELECT seller_name FROM contract_links WHERE seller_nif=? LIMIT 1", (top,)).fetchone()
        ex = out.execute("""SELECT a.id, a.n_anuncio, a.published, l.price, l.n_bidders, a.description FROM contract_links l JOIN announcements a ON a.id=l.announcement_id
                            WHERE l.buyer_nif=? AND l.seller_nif=? ORDER BY a.published DESC LIMIT 12""", (nif, top)).fetchall()
        one = out.execute("SELECT COUNT(DISTINCT announcement_id) FROM contract_links WHERE buyer_nif=? AND seller_nif=? AND n_bidders<=1", (nif, top)).fetchone()[0]
        flags.append(("vencedor_repetido", nif, S[nif][1], S[nif][3], n, k, share, pr, p90, len(allr) and percentile(allr, 0.5), z, i,
                      json.dumps({"vencedor_nif": top, "vencedor": sname[0] if sname else None, "procedimentos_ganhos": k, "procedimentos_com_1_concorrente": one,
                                  "vencedores_distintos": nsel, "n_pares": ng, "anuncios": [list(r) for r in ex]}, ensure_ascii=False)))
    log("vencedor_repetido compradores:", len(cand))
    out.executemany("INSERT INTO flags VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", flags)
    out.commit()

    # ---------------- 5. agregados globais (overview)
    log("agregados")
    def rows_(sql, *p):
        return [list(r) for r in out.execute(sql, p).fetchall()]
    nprim = out.execute("SELECT COUNT(*) FROM announcements WHERE is_primary=1").fetchone()[0]
    bins = [(0, 6, "0–6 dias"), (7, 14, "7–14 dias"), (15, 29, "15–29 dias"), (30, 44, "30–44 dias"), (45, 59, "45–59 dias"), (60, 10**6, "60+ dias")]
    deadline_dist = {}
    for lbl, cond in (("Bens e serviços · até 2017", "obras=0 AND post2018=0"), ("Bens e serviços · desde 2018", "obras=0 AND post2018=1"),
                      ("Empreitadas · até 2017", "obras=1 AND post2018=0"), ("Empreitadas · desde 2018", "obras=1 AND post2018=1")):
        vals = [r[0] for r in out.execute(f"SELECT prazo_dias FROM announcements WHERE ok_deadline=1 AND prazo_dias>0 AND {cond}")]
        sv = sorted(vals)
        deadline_dist[lbl] = {"n": len(vals), "p10": percentile(sv, .1), "p25": percentile(sv, .25), "median": percentile(sv, .5), "p75": percentile(sv, .75),
                              "bins": [[b[2], sum(1 for v in vals if b[0] <= v <= b[1])] for b in bins]}
    # quota de prazos curtos por ano com limiares ABSOLUTOS (não dependem do regime): bens/serviços <= 6 dias, empreitadas <= 14 dias
    short_year = rows_("""SELECT year, SUM(obras=0), SUM(obras=0 AND prazo_dias<=6), SUM(obras=1), SUM(obras=1 AND prazo_dias<=14), SUM(short), COUNT(*)
                          FROM announcements WHERE ok_deadline=1 AND prazo_dias>0 GROUP BY year ORDER BY year""")
    amend = {"by_tipo": rows_("SELECT tipo_acto, COUNT(*) FROM announcements WHERE tipo_acto NOT IN ('Anúncio de procedimento','Anúncio de concurso urgente') GROUP BY 1 ORDER BY 2 DESC"),
             "total": out.execute("SELECT COUNT(*) FROM announcements WHERE tipo_acto NOT IN ('Anúncio de procedimento','Anúncio de concurso urgente')").fetchone()[0],
             "with_original": out.execute("""SELECT COUNT(*) FROM announcements a WHERE a.tipo_acto NOT IN ('Anúncio de procedimento','Anúncio de concurso urgente')
                 AND EXISTS (SELECT 1 FROM announcements o WHERE o.n_anuncio=a.n_anuncio AND o.buyer_nif=a.buyer_nif AND o.is_primary=1)""").fetchone()[0],
             "linked_to_contract": out.execute("""SELECT COUNT(*) FROM announcements WHERE is_primary=0 AND n_contracts>0 AND tipo_acto NOT IN ('Anúncio de procedimento','Anúncio de concurso urgente')""").fetchone()[0]}
    by_year = rows_("""SELECT year, COUNT(*), SUM(is_tender), SUM(n_contracts>0 AND is_tender=1), SUM(unfollowed), SUM(base_price) FROM announcements
                       WHERE is_primary=1 GROUP BY year ORDER BY year""")
    model = rows_("SELECT procedure, COUNT(*), SUM(base_price) FROM announcements WHERE is_primary=1 GROUP BY 1 ORDER BY 2 DESC")
    # desconto: preço do contrato vs preço base do contrato, procedimentos concorrenciais ligados
    disc = [r[0] for r in out.execute("SELECT discount FROM contract_links WHERE discount IS NOT NULL")]
    dbins = [(-10**9, -0.0001, "acima do preço base"), (-0.0001, 0.0001, "exatamente ao preço base"), (0.0001, 0.05, "até 5% abaixo"),
             (0.05, 0.10, "5–10% abaixo"), (0.10, 0.20, "10–20% abaixo"), (0.20, 0.40, "20–40% abaixo"), (0.40, 1.01, "mais de 40% abaixo")]
    disc_hist = []
    for lo, hi, lbl in dbins:
        if lbl == "exatamente ao preço base":
            n = sum(1 for d in disc if -0.0001 <= d <= 0.0001)
        elif lbl == "acima do preço base":
            n = sum(1 for d in disc if d < -0.0001)
        else:
            n = sum(1 for d in disc if lo < d <= hi)
        disc_hist.append([lbl, n])
    atb = rows_("""SELECT CASE WHEN n_bidders IS NULL THEN 'n/d' WHEN n_bidders<=1 THEN '1' WHEN n_bidders=2 THEN '2' WHEN n_bidders<=4 THEN '3-4' ELSE '5+' END b,
                          COUNT(*), SUM(at_base) FROM contract_links WHERE at_base IS NOT NULL GROUP BY 1""")
    prazo_by_year = rows_("""SELECT year, COUNT(*), AVG(prazo_dias), SUM(prazo_dias<=7) FROM announcements WHERE ok_deadline=1 AND prazo_dias>0 AND obras=0 GROUP BY year ORDER BY year""")
    noann_reason = rows_("SELECT reason, COUNT(*) FROM contracts_no_ann GROUP BY 1 ORDER BY 2 DESC")
    noann_year = rows_("""SELECT substr(signed,1,4), COUNT(*) FROM contracts_no_ann WHERE reason<>'anterior_2012' GROUP BY 1 ORDER BY 1""")
    comp_year = {r[0]: r[1] for r in pol.execute(f"SELECT substr(signed,1,4), COUNT(*) FROM contracts WHERE procedure IN ({comp_ph}) AND signed>='2013-01-01' GROUP BY 1", tuple(COMPETITIVE_CONTRACT))}
    n_comp = sum(comp_year.values())
    n_ann_contracts = pol.execute("SELECT COUNT(*) FROM contracts WHERE announcement IS NOT NULL AND announcement<>''").fetchone()[0]
    n_linked = out.execute("SELECT COUNT(*) FROM contract_links").fetchone()[0]
    n_linked_ref = pol.execute("SELECT COUNT(*) FROM contracts WHERE announcement IS NOT NULL AND announcement<>'' AND substr(signed,1,4)>='2013'").fetchone()[0]
    n_linked_ref_ok = out.execute("SELECT COUNT(*) FROM contract_links WHERE signed>='2013-01-01'").fetchone()[0]
    unf_total = out.execute("SELECT COUNT(*), SUM(base_price) FROM announcements WHERE unfollowed=1").fetchone()
    unf_year = rows_("SELECT year, COUNT(*), SUM(base_price) FROM announcements WHERE unfollowed=1 GROUP BY 1 ORDER BY 1")
    tender_elig = out.execute("SELECT COUNT(*) FROM announcements WHERE is_primary=1 AND is_tender=1 AND published<=?", (cutoff,)).fetchone()[0]
    ov = {
        "built": datetime.now().isoformat(timespec="seconds"),
        "snapshot": max((r[0] or "" for r in out.execute("SELECT MAX(published) FROM announcements")), default=None),
        "records": len(rows), "primary": nprim, "tenders": out.execute("SELECT COUNT(*) FROM announcements WHERE is_tender=1").fetchone()[0],
        "buyers": out.execute("SELECT COUNT(DISTINCT buyer_nif) FROM announcements WHERE is_primary=1").fetchone()[0],
        "buyers_in_registry": out.execute("SELECT COUNT(DISTINCT buyer_nif) FROM announcements WHERE is_primary=1 AND buyer_entity_id IS NOT NULL").fetchone()[0],
        "base_total": out.execute("SELECT SUM(base_price) FROM announcements WHERE is_tender=1").fetchone()[0],
        "no_base_price": out.execute("SELECT COUNT(*) FROM announcements WHERE is_tender=1 AND base_price IS NULL").fetchone()[0],
        "by_year": by_year, "model": model, "deadline": deadline_dist, "deadline_thresholds": {f"{k[0]}_{k[1]}": v for k, v in short_thr.items()}, "short_year": short_year, "amend": amend,
        "prazo_by_year": prazo_by_year, "discount_hist": disc_hist, "discount_n": len(disc), "discount_median": median(disc),
        "at_base_by_bidders": atb,
        "link": {"contracts_with_ref": n_ann_contracts, "linked": n_linked, "match_rate": n_linked / n_ann_contracts if n_ann_contracts else None,
                 "with_ref_2013plus": n_linked_ref, "linked_2013plus": n_linked_ref_ok,
                 "match_rate_2013plus": n_linked_ref_ok / n_linked_ref if n_linked_ref else None,
                 "tenders_followed": out.execute("SELECT COUNT(*) FROM announcements WHERE is_tender=1 AND n_contracts>0 AND published<=?", (cutoff,)).fetchone()[0], "tenders_eligible": tender_elig},
        "competitive_contracts_2013plus": n_comp, "noann": rows_("SELECT reason, COUNT(*) FROM contracts_no_ann WHERE reason<>'anterior_2012' GROUP BY 1 ORDER BY 2 DESC"),
        "noann_before_2012_ref": out.execute("SELECT COUNT(*) FROM contracts_no_ann WHERE reason='anterior_2012'").fetchone()[0],
        "noann_by_year": [[y, n, comp_year.get(y, 0)] for y, n in noann_year],
        "unfollowed": {"n": unf_total[0], "base": unf_total[1], "by_year": unf_year, "cutoff": cutoff, "eligible": tender_elig},
        "min_n": MIN_N, "base_implausible": IMPLAUSIBLE[0], "base_max": BASE_MAX, "amend_by_tipo": rows_("SELECT tipo_acto, COUNT(*) FROM announcements GROUP BY 1 ORDER BY 2 DESC"),
    }
    out.execute("INSERT INTO meta VALUES ('overview', ?)", (json.dumps(ov, ensure_ascii=False),))
    out.execute("INSERT INTO meta VALUES ('built', ?)", (ov["built"],))
    out.execute("INSERT INTO meta VALUES ('dataset', ?)", (json.dumps({"id": DATASET, "title": ds.get("title"), "url": DATASET_URL, "modified": ds.get("last_modified")}, ensure_ascii=False),))
    out.commit()
    out.execute("VACUUM")
    out.close()
    log("feito", DB, DB.stat().st_size // 1_000_000, "MB")


if __name__ == "__main__":
    main()
