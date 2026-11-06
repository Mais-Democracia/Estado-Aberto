import datetime as dt
import re
import sys
import urllib.parse
from pathlib import Path

import lei as L

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "ingest"))
import diario_score as S  # noqa: E402

TIPOS = frozenset({"agenda_semana", "leis_em_curso_dia", "governo_cm", "contratos_destaque_dia", "acordao_constitucional", "fundos_dia", "poder_local_dia", "regioes_dia"})
CAP = 40
PRES_BODY = "Presidência da República"
MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
ROTAS = {
    "agenda_semana": ["#/calendario"],
    "leis_em_curso_dia": ["#/leis"],
    "governo_cm": ["#/ministerios"],
    "contratos_destaque_dia": ["#/contratos"],
    "acordao_constitucional": ["#/justica/tc"],
    "fundos_dia": ["#/fundos"],
    "poder_local_dia": ["#/autarquias", "#/empresas-locais"],
    "regioes_dia": ["#/regioes"],
}


def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def cut(s, n):
    s = clean(s)
    if len(s) <= n:
        return s
    t = s[:n]
    i = t.rfind(" ")
    return (t[:i] if i > n * 0.6 else t).rstrip(" ,;:-") + "…"


def nf(v, d=0):
    v = float(v)
    s = f"{abs(v):.{d}f}"
    ip, _, fp = s.partition(".")
    if len(ip) > 4:
        ip = " ".join([ip[max(i - 3, 0):i] for i in range(len(ip), 0, -3)][::-1])
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


def add_days(day, n):
    return (dt.date.fromisoformat(day[:10]) + dt.timedelta(days=n)).isoformat()


def qp(name, sql, args=()):
    return L.q(L.db(name), sql, args)


def masked(nif, name, label="particular (identidade omitida)"):
    return label if S.private_nif(nif) else clean(name)


def pres_noticias(day):
    rows = qp("politica", "SELECT url, title, date FROM news WHERE body = ? AND substr(date, 1, 10) = ? ORDER BY date, url", (PRES_BODY, day))
    return [{k: v for k, v in {"titulo": cut(r["title"], 200), "data": clean(r["date"])[:10], "url": r["url"]}.items() if v} for r in rows]


def agenda_semana(row):
    day = str(row["fonte_ref"])
    a, b = add_days(day, 1), add_days(day, S.AGENDA_DIAS)
    rows = qp("politica", "SELECT title, start, section, theme, local FROM events WHERE substr(start, 1, 10) BETWEEN ? AND ? ORDER BY start, id", (a, b))
    if not rows:
        return None
    cls, dias = {"plenario": 0, "comissoes": 0, "outros": 0}, {}
    for r in rows:
        cls[S.agenda_classe(r["section"])] += 1
        d = str(r["start"])[:10]
        dias[d] = dias.get(d, 0) + 1
    itens = []
    for r in rows[:CAP]:
        it = {"data": str(r["start"])[:10], "hora": str(r["start"])[11:16], "titulo": cut(str(r["title"] or "").split("\n")[0], 140), "tipo_reuniao": clean(r["section"]),
              "tema": cut(r["theme"], 100), "local": cut(r["local"], 80)}
        itens.append({k: v for k, v in it.items() if v})
    return {"tipo": "agenda_semana", "data": day, "janela": {"de": a, "ate": b}, "total": len(rows), "contagens": cls, "por_dia": dias, "itens_listados": len(itens), "itens": itens}, ["#/calendario"]


def leis_em_curso_dia(row):
    day = str(row["fonte_ref"])
    rows = qp("politica", "SELECT s.initiative_key AS k, s.phase, s.body, s.detail, i.kind, i.number, i.legislature, i.title FROM initiative_steps s LEFT JOIN initiatives i ON i.key = s.initiative_key "
              "WHERE substr(s.date, 1, 10) = ? ORDER BY s.initiative_key, s.phase", (day,))
    if not rows:
        return None
    fases, itens, hrefs = {}, [], set()
    for r in rows:
        f = clean(r["phase"]) or "sem fase indicada"
        fases[f] = fases.get(f, 0) + 1
    for r in rows[:CAP]:
        rota = "#/leis/" + urllib.parse.quote(str(r["k"]), safe="")
        hrefs.add(rota)
        ref = f"{r['kind']} n.º {r['number']}/{r['legislature']}" if r["kind"] and r["number"] else clean(r["k"]).replace("|", " ")
        it = {"iniciativa": ref, "titulo": cut(r["title"], 160), "fase": clean(r["phase"]), "orgao": clean(r["body"]), "detalhe": cut(r["detail"], 160), "rota": rota}
        itens.append({k: v for k, v in it.items() if v})
    n_ini = len({r["k"] for r in rows})
    return {"tipo": "leis_em_curso_dia", "data": day, "total": len(rows), "iniciativas": n_ini, "contagens": fases, "itens_listados": len(itens), "itens": itens}, sorted(hrefs) + ["#/leis"]


def governo_cm(row):
    first = L.one(L.db("ministerios"), "SELECT * FROM decisions WHERE id = ?", (row["fonte_ref"],))
    if not first:
        return None
    t = first.get("cm_title")
    same = L.q(L.db("ministerios"), "SELECT ministry, source_url FROM decisions WHERE cm_date = ? AND " + ("cm_title = ?" if t else "text = ?"), (first["cm_date"], t or first.get("text")))
    mins = sorted({clean(r["ministry"]) for r in same if r["ministry"]})
    itens = [{"ministerio": m.replace("-", " "), "rota": "#/ministerios/" + urllib.parse.quote(m, safe="")} for m in mins[:CAP]]
    dados = {"tipo": "governo_cm", "data": str(first["cm_date"])[:10], "titulo": cut(t, 220), "detalhe": cut(first.get("text"), 1500), "total": len(mins), "itens_listados": len(itens), "itens": itens}
    return {k: v for k, v in dados.items() if v not in (None, "")}, [i["rota"] for i in itens] + ["#/ministerios"]


def contratos_destaque_dia(row):
    day = str(row["fonte_ref"])
    dest = S.destaques(lambda sql, a=(): qp("politica", sql, a), day)
    if not dest["itens"]:
        return None
    itens, hrefs = [], set()
    for x in dest["itens"][:CAP]:
        r = x["r"]
        rota = f"#/contrato/{urllib.parse.quote(str(r['id']), safe='')}"
        hrefs.add(rota)
        if r.get("link"):
            hrefs.add(r["link"])
        it = {"comprador": clean(r.get("buyer_name")), "fornecedor": masked(r.get("seller_nif"), r.get("seller_name"), "fornecedor particular (identidade omitida)"),
              "valor": round(float(r["price"]), 2), "valor_texto": eur(r["price"]), "procedimento": clean(r.get("procedure")), "objeto": cut(r.get("object"), 140),
              "motivos": x["motivos"], "rota": rota}
        if x["ratio"] is not None:
            it["vezes_a_media_do_comprador"] = round(x["ratio"], 1)
        if r.get("n_bidders") is not None:
            it["concorrentes"] = int(r["n_bidders"])
        itens.append({k: v for k, v in it.items() if v not in (None, "")})
    dados = {"tipo": "contratos_destaque_dia", "data": day, "total_contratos_dia": dest["total_dia"], "valor_total_dia_texto": eur(dest["valor_dia"]),
             "contagens": dest["contagens"], "criterios": {"valor_atipico": f"valor pelo menos {S.DESTAQUE_RATIO} vezes a média do comprador (mínimo {S.DESTAQUE_MIN} euros)",
                                                            "ajuste_direto": f"ajuste direto de pelo menos {S.DESTAQUE_DIRECT} euros", "proposta_unica": f"concurso com um só concorrente e pelo menos {S.DESTAQUE_SINGLE} euros"},
             "itens_listados": len(itens), "itens": itens}
    return dados, sorted(hrefs) + ["#/contratos"]


def acordao_constitucional(row):
    r = L.one(L.db("justica"), "SELECT * FROM tc_acordaos WHERE id = ?", (row["fonte_ref"],))
    if not r:
        return None
    hrefs = [h for h in (r.get("url"), r.get("source_url")) if h]
    dados = {"tipo": "acordao_constitucional", "data": str(r["data"])[:10], "processo": clean(r.get("processo")), "especie": clean(r.get("especie")), "tipo_processo": clean(r.get("tipo")),
             "formacao": clean(r.get("formacao")), "norma": cut(r.get("norma"), 300), "resultado": clean(r.get("resultado")), "relator": clean(r.get("relator")),
             "detalhe": cut(r.get("sumario"), 1500), "total": 1}
    return {k: v for k, v in dados.items() if v not in (None, "")}, hrefs + ["#/justica/tc?q=" + urllib.parse.quote(str(r.get("processo") or ""), safe="")]


def range_of(ref):
    m = re.search(r"(\d+)-(\d+)$", str(ref))
    return (int(m.group(1)), int(m.group(2))) if m else None


def fundos_dia(row):
    rg = range_of(row["fonte_ref"])
    if not rg:
        return None
    rows = qp("fundos", "SELECT * FROM awards WHERE rowid BETWEEN ? AND ? ORDER BY aprovado DESC, id", rg)
    if not rows:
        return None
    por_fundo = {}
    for r in rows:
        k = clean(r.get("fundo") or r.get("fw")) or "sem fundo indicado"
        por_fundo[k] = por_fundo.get(k, 0) + 1
    itens = []
    for r in rows[:15]:
        it = {"beneficiario": masked(r.get("nif"), r.get("name"), "beneficiário particular (identidade omitida)"), "fundo": clean(r.get("fundo")), "quadro": clean(r.get("fw")),
              "programa": cut(r.get("programa"), 100), "titulo": cut(r.get("titulo"), 140), "concelho": clean(r.get("concelho")), "ano": r.get("ano"), "estado": clean(r.get("estado")),
              "aprovado": round(float(r.get("aprovado") or 0), 2), "aprovado_texto": eur(r.get("aprovado") or 0), "pago_texto": eur(r.get("pago") or 0)}
        itens.append({k: v for k, v in it.items() if v not in (None, "")})
    dados = {"tipo": "fundos_dia", "data": row["data_evento"], "total": len(rows), "aprovado_total_texto": eur(sum(float(r.get("aprovado") or 0) for r in rows)),
             "pago_total_texto": eur(sum(float(r.get("pago") or 0) for r in rows)), "contagens": por_fundo, "itens_listados": len(itens), "itens": itens}
    return dados, ["#/fundos"]


def poder_local_dia(row):
    ref = str(row["fonte_ref"])
    mod = row.get("fonte_modulo")
    if mod == "empresas_locais":
        rows = qp("empresas_locais", "SELECT name, sector, status, seller_contracts, seller_value FROM company WHERE last_signed = ? ORDER BY seller_value DESC, id", (ref,))
        if not rows:
            return None
        itens = []
        for r in rows[:CAP]:
            it = {"empresa": clean(r["name"]), "setor": clean(r["sector"]), "estado": clean(r["status"]), "contratos_como_fornecedora": r["seller_contracts"],
                  "valor_como_fornecedora_texto": eur(r["seller_value"]) if r["seller_value"] else None}
            itens.append({k: v for k, v in it.items() if v not in (None, "")})
        return {"tipo": "poder_local_dia", "subtipo": "empresas_locais", "data": ref, "total": len(rows), "itens_listados": len(itens), "itens": itens}, ["#/empresas-locais"]
    rg = range_of(ref)
    if not rg:
        return None
    if ref.startswith("pmp:"):
        rows = qp("autarquias", "SELECT p.dico, p.date, p.days, p.partial, m.name FROM pmp p LEFT JOIN municipios m ON m.dico = p.dico WHERE p.rowid BETWEEN ? AND ? ORDER BY p.days DESC, p.dico", rg)
        if not rows:
            return None
        dias = [int(r["days"]) for r in rows if r["days"] is not None]
        itens = [{k: v for k, v in {"municipio": clean(r["name"]) or f"município {r['dico']}", "data_referencia": str(r["date"])[:10], "dias": r["days"], "parcial": bool(r["partial"])}.items() if v not in (None, "")} for r in rows[:CAP]]
        dados = {"tipo": "poder_local_dia", "subtipo": "prazo_medio_pagamento", "data": row["data_evento"], "total": len(rows), "media_dias": round(sum(dias) / len(dias)) if dias else None,
                 "maximo_dias": max(dias) if dias else None, "minimo_dias": min(dias) if dias else None, "itens_listados": len(itens), "itens": itens}
        return {k: v for k, v in dados.items() if v is not None}, ["#/autarquias"]
    rows = qp("autarquias", "SELECT f.dico, f.year, f.kind, f.label, f.value, m.name FROM finance f LEFT JOIN municipios m ON m.dico = f.dico WHERE f.rowid BETWEEN ? AND ? ORDER BY f.dico, f.year", rg)
    if not rows:
        return None
    munis = sorted({clean(r["name"]) or f"município {r['dico']}" for r in rows})
    anos = sorted({r["year"] for r in rows if r["year"] is not None})
    kinds = {}
    for r in rows:
        k = clean(r["kind"]) or "sem tipo"
        kinds[k] = kinds.get(k, 0) + 1
    return {"tipo": "poder_local_dia", "subtipo": "contas_municipais", "data": row["data_evento"], "total": len(rows), "municipios": len(munis), "anos": anos, "contagens": kinds,
            "municipios_listados": munis[:CAP]}, ["#/autarquias"]


def regioes_dia(row):
    region, _, day = str(row["fonte_ref"]).partition(":")
    rows = qp("regioes", "SELECT id, kind, number, title, summary, url FROM acts WHERE region = ? AND date = ? ORDER BY kind, number, id", (region, day))
    if not rows:
        return None
    kinds, hrefs, itens = {}, set(), []
    for r in rows:
        k = clean(r["kind"]) or "ato"
        kinds[k] = kinds.get(k, 0) + 1
    for r in rows[:CAP]:
        if r["url"]:
            hrefs.add(r["url"])
        it = {"tipo_ato": clean(r["kind"]), "numero": clean(r["number"]), "titulo": cut(r["title"], 180), "resumo": cut(r["summary"], 200), "url": r["url"]}
        itens.append({k: v for k, v in it.items() if v})
    rota = "#/regioes/" + urllib.parse.quote(region, safe="")
    return {"tipo": "regioes_dia", "data": day, "regiao": region, "total": len(rows), "contagens": kinds, "itens_listados": len(itens), "itens": itens}, sorted(hrefs) + [rota, "#/regioes"]


BUILDERS = {"agenda_semana": agenda_semana, "leis_em_curso_dia": leis_em_curso_dia, "governo_cm": governo_cm, "contratos_destaque_dia": contratos_destaque_dia,
            "acordao_constitucional": acordao_constitucional, "fundos_dia": fundos_dia, "poder_local_dia": poder_local_dia, "regioes_dia": regioes_dia}


def block(row):
    fn = BUILDERS.get(row.get("tipo"))
    if not fn or not row.get("fonte_ref"):
        return None
    return fn(row)
