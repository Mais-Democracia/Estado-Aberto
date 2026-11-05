"""Empresas municipais e intermunicipais (Sector Empresarial Local).

Escreve só em data/empresas_locais.db.  Lê (só leitura): data/politica.db (entities, contracts),
data/autarquias.db (municipios/DICO), data/responsaveis.db (mandatos ET).

Fontes:
  * Registo do portal (Portal BASE): entidades kind 'empresa_municipal' + 'sociedade_adjudicante' cujo nome é de empresa
    local (E.M., E.E.M., EIM, SRU, 'municipal').  Lista = o que aparece em contratos públicos; NÃO é a lista oficial da DGAL.
  * DGAL / dados.gov.pt 'Setor Empresarial Local 2015-2017' (AVSEL*.json): só agregados por município
    (n.º de entidades, trabalhadores, resultados financeiros, dívida total) — não lista empresas.
  * contratos (politica.db): por NIF comprador/vendedor; município -> empresa = relação de contratação com o dono provável.
  * responsaveis.db: titulares de mandatos (nomes tal como publicados pela ET).
Heurísticas (rotuladas): dono por nome, dono por cliente principal, setor por palavras do nome, forma jurídica por sufixo.
"""
import json
import re
import sqlite3
import time
import unicodedata
import urllib.request

from common import ROOT

NAME = "empresas_locais"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
POL = ROOT / "data" / "politica.db"
AUT = ROOT / "data" / "autarquias.db"
RESP = ROOT / "data" / "responsaveis.db"
BUA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
SEL = {  # ano -> URL do JSON em dados.gov.pt (datasets DGAL 'Setor Empresarial Local <ano>')
    2015: "https://dados.gov.pt/s/resources/setor-empresarial-local-2015/20180514-160257/AVSEL2015.json",
    2016: "https://dados.gov.pt/s/resources/setor-empresarial-local-2016/20180514-160145/AVSEL2016.json",
    2017: "https://dados.gov.pt/s/resources/setor-empresarial-local-2017/20180514-155932/AVSEL2017.json",
}
SEL_PAGE = "https://dados.gov.pt/pt/datasets/?q=setor+empresarial+local"
BASE_URL = "https://www.base.gov.pt/"


def log(*a):
    print(f"[{NAME}]", *a, flush=True)


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY, nif TEXT UNIQUE, name TEXT, entity_id INTEGER, registry_kind TEXT,
  legal_form TEXT, scope TEXT,           -- scope: municipal | intermunicipal | indeterminado (heurística pelo nome)
  sector TEXT, status TEXT, status_note TEXT,
  buyer_contracts INTEGER, buyer_value REAL, seller_contracts INTEGER, seller_value REAL,
  first_signed TEXT, last_signed TEXT,
  seller_to_owner_contracts INTEGER, seller_to_owner_value REAL,   -- contratos com os municípios dono(s)
  excluded_to_owner_contracts INTEGER, excluded_to_owner_value REAL, -- dos quais 'Contratação excluída' (inclui in-house)
  n_admins INTEGER, owner_method TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS c_name ON company(name);
CREATE INDEX IF NOT EXISTS c_sector ON company(sector);
CREATE TABLE IF NOT EXISTS owner (
  company_id INTEGER, dico TEXT, municipality TEXT, pct REAL, method TEXT, confidence TEXT, evidence TEXT,
  PRIMARY KEY (company_id, dico));
CREATE INDEX IF NOT EXISTS o_dico ON owner(dico);
CREATE TABLE IF NOT EXISTS admin (
  company_id INTEGER, holder TEXT, role TEXT, board TEXT, begin_date TEXT, end_date TEXT, match_method TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS a_c ON admin(company_id);
CREATE TABLE IF NOT EXISTS company_year (
  company_id INTEGER, year INTEGER, role TEXT, n INTEGER, value REAL, PRIMARY KEY (company_id, year, role));
CREATE TABLE IF NOT EXISTS muni (
  dico TEXT PRIMARY KEY, name TEXT, nif TEXT, n_companies INTEGER, n_companies_certain INTEGER,
  companies_seller_value REAL, companies_seller_contracts INTEGER,
  muni_buyer_contracts INTEGER, muni_buyer_value REAL,
  muni_to_companies_contracts INTEGER, muni_to_companies_value REAL, share_pct REAL,
  excluded_contracts INTEGER, excluded_value REAL);
CREATE TABLE IF NOT EXISTS sel_muni (
  dico TEXT, year INTEGER, n_entities INTEGER, employees INTEGER, financial_result REAL, total_debt REAL, source_url TEXT,
  PRIMARY KEY (dico, year));
"""

# ---- classificação por palavras do nome (heurística) ----
SECTORS = [
    ("Água e saneamento", r"\bagua|\bsaneamento|abastecimento|\bsmas\b|hidr|\bsimar|\bsimtejo"),
    ("Resíduos e ambiente", r"residuo|\blixo|ambiente|\bambi|ecolog|\bresiduos"),
    ("Reabilitação urbana", r"\bsru\b|reabilitacao urbana|requalificacao|urbanizacao|renovada|\bviva\b|vivo"),
    ("Habitação", r"habita|\bhabit|residencia|\bhab\b"),
    ("Mobilidade, transportes e estacionamento", r"mobilidade|transporte|estacionamento|parque.* auto|parking|\bbus\b|\bmove|\btml\b|autocarro|\bmetro|\bemel\b"),
    ("Cultura", r"cultur|teatro|museu|\bartes\b|\bcine"),
    ("Desporto e lazer", r"desport|\bsport|piscina|estadio|lazer|tempos livres|\bludus"),
    ("Turismo e termas", r"turism|termas|\bturis|expo\b|\bexpo|feira"),
    ("Educação e formação", r"educa|formacao|ensino|escola"),
    ("Energia", r"energia|energet|energ"),
    ("Mercados e equipamentos", r"mercado|equipamentos|gestao de equipamento"),
    ("Desenvolvimento local e regional", r"desenvolvimento|\bdesenvolv|inova|agencia|parque tecnologico|\bparque|investimento"),
    ("Saúde e ação social", r"saude|social|residencias assistidas|\blar\b|idosos|cuidados"),
]


def classify_sector(name):
    n = norm(name)
    for lab, rx in SECTORS:
        if re.search(rx, n):
            return lab
    return "Não classificado"


def legal_form(name):
    n = " " + name.upper().replace(" ", "") + " "
    s = name.upper()
    if re.search(r"\bSRU\b|SOCIEDADE DE REABILITA", s):
        base = "SRU"
    elif re.search(r"\bE\.?\s?I\.?\s?M\.?\b|EMPRESA INTERMUNICIPAL", s):
        base = "EIM"
    elif re.search(r"\bE\.?\s?E\.?\s?M\.?\b", s):
        base = "EEM"
    elif re.search(r"\bE\.?\s?M\.?\b|EMPRESA MUNICIPAL", s):
        base = "EM"
    else:
        base = "Outra"
    t = "S.A." if re.search(r"\bS\.?\s?A\.?\b", s) else ("Lda" if re.search(r"L\.?DA|LIMITADA", s) else "")
    return (base + (" · " + t if t else "")).strip()


def scope_of(name):
    s = name.upper()
    if re.search(r"INTERMUNICIPAL|\bEIM\b|E\.\s?I\.\s?M|COMUNIDADE INTERMUNICIPAL", s):
        return "intermunicipal"
    return "municipal"


STRONG = re.compile(r"(\bE\.?\s?E\.?\s?M\.?(?=\W|$)|\bE\.?\s?I\.?\s?M\.?(?=\W|$)|\bE\.?\s?M\.?(?=\W|$)|\bSRU\b|(?i:municipal))")
EXCL = re.compile(r"Empresa de Electricidade da Madeira|ECOSA.DE|Instituto Empresarial|multimunicipal|\bCRL\b|simarsul|meimoacoop|ENEREEM", re.I)


FRAG_STOP = {"desporto", "desportos", "animacao", "formacao", "informacao", "comunicacao", "transporte", "transportes", "passaporte", "aeroporto", "reporto"}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def get_json(url, tag):
    RAW.mkdir(parents=True, exist_ok=True)
    f = RAW / tag
    if not f.exists() or f.stat().st_size < 1000:
        req = urllib.request.Request(url, headers={"User-Agent": BUA})
        with urllib.request.urlopen(req, timeout=90) as r:
            f.write_bytes(r.read())
        time.sleep(1.2)
    return json.loads(f.read_text(encoding="utf8"))


def main():
    t0 = time.time()
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=60000")
    con.executescript(SCHEMA)
    pol = sqlite3.connect(f"file:{POL}?mode=ro", uri=True, timeout=60)
    aut = sqlite3.connect(f"file:{AUT}?mode=ro", uri=True, timeout=60)
    errors = []

    # ---- municípios ----
    munis = aut.execute("SELECT dico, name, nif FROM municipios").fetchall()
    byname = {}
    for d, n, nif in munis:
        byname.setdefault(norm(n), []).append((d, n, nif))
    nif2dico = {nif: d for d, n, nif in munis if nif}
    keys = sorted(byname, key=lambda k: -len(k))
    aliases = {"gaia": "vila nova de gaia", "v n gaia": "vila nova de gaia", "vrsa": "vila real de santo antonio",
               "v r s antonio": "vila real de santo antonio", "vfx": "vila franca de xira", "vnf": "vila nova de famalicao"}

    def name_owners(nm):
        s = " " + norm(nm) + " "
        found = []
        for k in keys:
            if f" {k} " in s:
                s = s.replace(f" {k} ", "  # ")
                found.append(k)
        for a, k in aliases.items():
            if f" {a} " in s and k in byname and k not in found:
                found.append(k)
        method = "nome (heurística)"
        if not found and scope_of(nm) != "intermunicipal":
            # fragmento: nome de município dentro de uma palavra composta (Taviraverde, Futurlagos, Ourémviva)
            toks = norm(nm).split()
            fr = [k for k in keys if " " not in k and len(k) >= 5 and any(len(t) > len(k) and t not in FRAG_STOP and (t.startswith(k) or t.endswith(k)) for t in toks)]
            if fr:
                found = [fr[0]]
                method = "nome — fragmento de palavra (heurística fraca)"
        out = []
        for k in found:
            lst = byname[k]
            out.append(lst[0] if len(lst) == 1 else None)  # nomes duplicados (Lagoa, Calheta): ambíguo
        return [o for o in out if o], any(o is None for o in out), method

    # ---- empresas candidatas ----
    ents = pol.execute("SELECT id, nif, name, kind FROM entities WHERE kind='empresa_municipal' AND nif IS NOT NULL").fetchall()
    extra = [r for r in pol.execute("SELECT id, nif, name, kind FROM entities WHERE kind='sociedade_adjudicante' AND nif IS NOT NULL").fetchall()
             if STRONG.search(r[2]) and not EXCL.search(r[2])]
    ents = [r for r in ents if not EXCL.search(r[2])]
    cands = ents + extra
    log(f"registo: {len(ents)} empresa_municipal + {len(extra)} sociedade_adjudicante com nome de empresa local")

    nifs = [c[1] for c in cands]
    con.execute("DELETE FROM company"); con.execute("DELETE FROM owner"); con.execute("DELETE FROM admin")
    con.execute("DELETE FROM company_year"); con.execute("DELETE FROM muni"); con.execute("DELETE FROM sel_muni")
    con.commit()

    muni_nifs = set(nif2dico)
    stats = {"owner_name": 0, "owner_client": 0, "owner_none": 0, "ambiguous": 0}
    cid_by_nif = {}
    for i, (eid, nif, nm, kind) in enumerate(cands, 1):
        cid_by_nif[nif] = i
        b = pol.execute("SELECT COUNT(*), COALESCE(SUM(price),0), MIN(signed), MAX(signed) FROM contracts WHERE buyer_nif=?", (nif,)).fetchone()
        s = pol.execute("SELECT COUNT(*), COALESCE(SUM(price),0), MIN(signed), MAX(signed) FROM contracts WHERE seller_nif=?", (nif,)).fetchone()
        first = min([x for x in (b[2], s[2]) if x] or [None]) if (b[2] or s[2]) else None
        last = max([x for x in (b[3], s[3]) if x] or [None]) if (b[3] or s[3]) else None
        for role, col in (("comprador", "buyer_nif"), ("vendedor", "seller_nif")):
            for y, n, v in pol.execute(f"SELECT year, COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE {col}=? AND year IS NOT NULL GROUP BY year", (nif,)):
                con.execute("INSERT INTO company_year VALUES (?,?,?,?,?)", (i, y, role, n, v))
        # donos
        owners, amb, omethod = name_owners(nm)
        method = None
        if owners:
            method = "nome"
            for d, mn, mnif in owners:
                con.execute("INSERT OR IGNORE INTO owner VALUES (?,?,?,?,?,?,?)",
                            (i, d, mn, None, omethod, "média" if omethod.startswith("nome (") else "baixa", f"nome da empresa contém «{mn}»"))
            stats["owner_name"] += 1
        else:
            # cliente principal: município que mais contratou à empresa (heurística fraca)
            rows = pol.execute("SELECT buyer_nif, COUNT(*), SUM(price) FROM contracts WHERE seller_nif=? AND buyer_nif IN (%s) GROUP BY 1 ORDER BY 3 DESC" %
                               ",".join("?" * len(muni_nifs)), (nif, *muni_nifs)).fetchall() if s[0] else []
            tot_all = s[1] or 0
            if rows and rows[0][1] >= 3 and tot_all > 0 and (rows[0][2] or 0) >= 0.5 * tot_all and not scope_of(nm) == "intermunicipal":
                bn, bc, bv = rows[0]
                d = nif2dico[bn]
                mn = next(x[1] for x in munis if x[0] == d)
                con.execute("INSERT OR IGNORE INTO owner VALUES (?,?,?,?,?,?,?)",
                            (i, d, mn, None, "cliente principal (heurística fraca)", "baixa",
                             f"{bc} contratos de {mn} = {100*(bv or 0)/tot_all:.0f}% do valor vendido"))
                method = "cliente"
                stats["owner_client"] += 1
            else:
                stats["owner_none"] += 1
        if amb:
            stats["ambiguous"] += 1
        # contratos com donos
        od = [r[0] for r in con.execute("SELECT dico FROM owner WHERE company_id=?", (i,))]
        onif = [x[2] for x in munis if x[0] in od and x[2]]
        so = (0, 0.0); eo = (0, 0.0)
        if onif and s[0]:
            ph = ",".join("?" * len(onif))
            so = pol.execute(f"SELECT COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE seller_nif=? AND buyer_nif IN ({ph})", (nif, *onif)).fetchone()
            eo = pol.execute(f"SELECT COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE seller_nif=? AND buyer_nif IN ({ph}) AND procedure LIKE 'Contrata%exclu%'", (nif, *onif)).fetchone()
        low = nm.lower()
        liq = "em liquida" in low or "liquidação" in low
        con.execute("INSERT INTO company VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (i, nif, nm, eid, kind, legal_form(nm), scope_of(nm), classify_sector(nm),
                     "em liquidação" if liq else "não indicado", "nome da entidade indica liquidação" if liq else "sem fonte de estado; ver último contrato",
                     b[0], b[1], s[0], s[1], first, last, so[0], so[1], eo[0], eo[1], 0, method,
                     BASE_URL))
        if i % 40 == 0:
            con.commit()
    con.commit()
    log("donos:", stats)

    # ---- administradores (responsaveis.db) ----
    try:
        rs = sqlite3.connect(f"file:{RESP}?mode=ro", uri=True, timeout=60)
        rows = rs.execute("SELECT entity_nif, entity, role, holder, begin_date, end_date, board, match_method, source_url FROM mandates").fetchall()
        byn = {}
        for r in rows:
            if r[0]:
                byn.setdefault(r[0], []).append(r)
        nm2cid = {norm(n): c for c, n in con.execute("SELECT id, name FROM company")}
        added = set()
        for nif, c in cid_by_nif.items():
            for r in byn.get(nif, []):
                con.execute("INSERT INTO admin VALUES (?,?,?,?,?,?,?,?)", (c, r[3], r[2], r[6], r[4], r[5], f"NIF ({r[7] or 'ET'})", r[8]))
                added.add(c)
        for r in rows:
            if not r[0]:
                c = nm2cid.get(norm(r[1]))
                if c:
                    con.execute("INSERT INTO admin VALUES (?,?,?,?,?,?,?,?)", (c, r[3], r[2], r[6], r[4], r[5], "nome exato", r[8]))
                    added.add(c)
        con.execute("UPDATE company SET n_admins=(SELECT COUNT(*) FROM admin WHERE company_id=company.id)")
        con.commit()
        log(f"administradores: {con.execute('SELECT COUNT(*) FROM admin').fetchone()[0]} mandatos em {len(added)} empresas")
    except Exception as e:
        errors.append(f"responsaveis: {e}")

    # ---- roll-up por município ----
    cstat = {}
    for d, n, nif in munis:
        cs = con.execute("SELECT c.id, c.nif, c.seller_value, c.seller_contracts, o.confidence FROM owner o JOIN company c ON c.id=o.company_id WHERE o.dico=?", (d,)).fetchall()
        cnifs = [c[1] for c in cs]
        bb = pol.execute("SELECT COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE buyer_nif=?", (nif,)).fetchone() if nif else (0, 0)
        mc = (0, 0.0); ex = (0, 0.0)
        if cnifs and nif:
            ph = ",".join("?" * len(cnifs))
            mc = pol.execute(f"SELECT COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE buyer_nif=? AND seller_nif IN ({ph})", (nif, *cnifs)).fetchone()
            ex = pol.execute(f"SELECT COUNT(*), COALESCE(SUM(price),0) FROM contracts WHERE buyer_nif=? AND seller_nif IN ({ph}) AND procedure LIKE 'Contrata%exclu%'", (nif, *cnifs)).fetchone()
        con.execute("INSERT INTO muni VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (d, n, nif, len(cs), sum(1 for c in cs if c[4] == "média"), sum(c[2] or 0 for c in cs), sum(c[3] or 0 for c in cs),
                     bb[0], bb[1], mc[0], mc[1], (100 * mc[1] / bb[1]) if bb[1] else None, ex[0], ex[1]))
    con.commit()

    # ---- DGAL SEL 2015-2017 (agregados por município) ----
    nsel = 0
    series = {}
    sel_note = []
    for y, url in SEL.items():
        try:
            d = get_json(url, f"AVSEL{y}.json")["d"]
            rows = {}
            for r in d:
                if r.get("codigoperiodo") != "A" or "totalentidades" not in r:
                    continue
                rows[r["codigoine"]] = (int(num(r["totalentidades"])), int(num(r["totalfuncionarios"])),
                                        num(r["resultadosfinanceiros"]), num(r["dividatotal"]), url)
            series[y] = rows
            if not rows:
                sel_note.append(f"{y}: ficheiro só com períodos trimestrais (T1–T4), sem totais anuais — não usado")
        except Exception as e:
            errors.append(f"SEL {y}: {e}")
    for y in sorted(series):
        rows = series[y]
        if not rows:
            continue
        nxt = series.get(y + 1) or {}
        prv = series.get(y - 1) or {}
        dup = [o for o in (nxt, prv) if o and o.keys() == rows.keys() and all(o[k][:4] == rows[k][:4] for k in rows)]
        if dup and y == min(k for k in series if series[k]):
            sel_note.append(f"{y}: idêntico ao ano seguinte em todos os {len(rows)} municípios e 4 campos — duplicado na fonte, não fiável, não usado")
            continue
        for dico, v in rows.items():
            con.execute("INSERT OR REPLACE INTO sel_muni VALUES (?,?,?,?,?,?,?)", (dico, y, *v))
            nsel += 1
        con.commit()
    con.execute("INSERT OR REPLACE INTO meta VALUES ('sel_note', ?)", (json.dumps(sel_note, ensure_ascii=False),))
    con.commit()
    log("SEL municipio-ano:", nsel)

    n = con.execute("SELECT COUNT(*) FROM company").fetchone()[0]
    w_owner = con.execute("SELECT COUNT(DISTINCT company_id) FROM owner").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('stats', ?)", (json.dumps({"companies": n, "with_owner": w_owner, **stats, "registry": len(ents), "extra": len(extra)}),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('errors', ?)", (json.dumps(errors),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('blocked', ?)", (json.dumps([
        "DGAL (portalautarquico.dgal.gov.pt): a página 'Atividade Empresarial Local' é só descritiva; não há lista de empresas, participações (%), nem contas descarregáveis (robots.txt devolve 404; www.dgal.gov.pt redireciona para o portal).",
        "dados.gov.pt 'Setor Empresarial Local' (DGAL): só agregados por município (n.º de entidades, trabalhadores, resultados, dívida) e só 2016 utilizável (2015 é cópia idêntica de 2016 na fonte; 2017: apenas trimestres sem totais; 2018: sem ficheiros).",
        "Wikidata: sem registo útil de empresas municipais com proprietário município (resultados são sobretudo estádios).",
        "Percentagens de participação e estado (ativa/liquidação) não existem em fontes abertas estruturadas encontradas; 'pct' fica vazio.",
        "Lista de empresas = entidades do Portal BASE com nome de empresa local: empresas que nunca contrataram publicamente ou sem NIF registado não aparecem.",
    ], ensure_ascii=False),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('sources', ?)", (json.dumps({"registo": "base.gov.pt via politica.db", "sel": list(SEL.values()), "page": SEL_PAGE}),))
    con.commit()
    log(f"{n} empresas, {w_owner} com dono provável; erros: {errors}; {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
