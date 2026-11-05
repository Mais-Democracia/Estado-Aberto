#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle as B  # noqa: E402
import lib  # noqa: E402
import verify as V  # noqa: E402
from lib import Ctx, Halt, call_model, canon, sha, wrap  # noqa: E402

ORDER = ["bundle", "triage", "select", "draft", "verify", "review", "publish"]


def jwrite(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def jread(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def cand_view(rows, limit=None):
    return [{"id": r["id"], "secao": r.get("secao"), "tipo": r.get("tipo"), "titulo": wrap(r.get("titulo") or ""),
             "resumo": wrap(r.get("resumo_curto") or ""), "entidades": B._json(r.get("entidades")), "score": r.get("score")}
            for r in (rows[:limit] if limit else rows)]


def stage_bundle(ctx):
    rows = B.shortlist(ctx)
    items = []
    for r in rows:
        b = B.build(ctx, [r["id"]])
        if b:
            items.append({"id": r["id"], "evidence_hash": b["evidence_hash"], "row": r})
    jwrite(ctx.work / "shortlist.json", items)
    ctx.audit("bundle", decision=f"{len(items)} bundles")
    return items


def stage_triage(ctx, items):
    top_n = ctx.cfg["pipeline"]["select_from"]
    ids = [i["id"] for i in items]
    ev = sha("triage", canon([i["evidence_hash"] for i in items]))
    d = ctx.work / "triage"
    jwrite(d / "candidates.json", cand_view([i["row"] for i in items]))
    res = call_model(ctx, "triage", d, "Le candidates.json e devolve o ranking.", ev, ctx.estimate_stage("triage", len(items)))
    ranked = []
    if res:
        ranked = [r["id"] for r in res["data"]["ranking"] if r["id"] in ids]
    ranked += [i for i in ids if i not in ranked]
    seen, out = set(), []
    for i in ranked:
        if i not in seen:
            seen.add(i)
            out.append(i)
    jwrite(ctx.work / "triage.json", {"ranking": out, "top": out[:top_n]})
    return out[:top_n]


def stage_select(ctx, items, top):
    byid = {i["id"]: i for i in items}
    rows = [byid[i]["row"] for i in top if i in byid]
    ev = sha("selecao", canon([byid[i]["evidence_hash"] for i in top if i in byid]))
    d = ctx.work / "selecao"
    mx = ctx.cfg["budgets"]["max_articles"]
    jwrite(d / "candidates.json", cand_view(rows))
    jwrite(d / "limite.json", {"max_historias": mx})
    res = call_model(ctx, "selecao", d, "Le candidates.json e limite.json e escolhe as historias.", ev, ctx.estimate_stage("selecao", len(rows)))
    if not res:
        return []
    chosen, seen = [], set()
    for h in res["data"]["historias"]:
        i = h["evento_id"]
        if i in byid and i not in seen:
            seen.add(i)
            chosen.append(i)
    chosen = chosen[:mx]
    jwrite(ctx.work / "selecao.json", {"escolhidas": chosen})
    return chosen


def done(ctx, ev):
    return (ctx.published / f"{ev}.json").exists() or (ctx.rejected / f"{ev}.json").exists()


def outcome(ctx, b, art, ver, rev, estado, models):
    doc = {"edicao_data": ctx.date, "evidence_hash": b["evidence_hash"], "evento_ids": [r["id"] for r in b["rows"]],
           "titulo": art["titulo"], "lead": art["lead"], "corpo": art["corpo"], "pontos_chave": art["pontos_chave"],
           "fontes": art["fontes"], "numeros_citados": art["numeros_citados"], "entidades": art["entidades"],
           "confianca": art["confianca"], "modelo": models[0], "revisor": models[1],
           "verificacao": {"verificador": ver, "revisor": rev}, "estado": estado}
    target = (ctx.published if estado == "publicado" else ctx.rejected) / f"{b['evidence_hash']}.json"
    old = jread(target)
    if old and {k: v for k, v in old.items() if k != "criado_em"} == doc:
        return
    doc["criado_em"] = lib.now().isoformat(timespec="seconds")
    other = (ctx.rejected if estado == "publicado" else ctx.published) / f"{b['evidence_hash']}.json"
    other.unlink(missing_ok=True)
    jwrite(target, doc)


def stage_draft(ctx, items, chosen):
    byid = {i["id"]: i for i in items}
    out = []
    for eid in chosen:
        b = B.build(ctx, [eid])
        if not b or done(ctx, b["evidence_hash"]):
            continue
        B.add_text(ctx, b)
        t = b["dir"] / "texto.txt"
        ev = sha(b["evidence_hash"], hashed(t))
        res = call_model(ctx, "redacao", b["dir"], "Redige o artigo sobre o evento descrito nos ficheiros desta pasta.", ev)
        if not res:
            continue
        jwrite(b["dir"] / "rascunho.json", res["data"])
        out.append((b, res["data"], ev))
    return out


def hashed(p):
    return sha(p.read_bytes()) if p.exists() else "-"


def stage_verify_review(ctx, drafts, do_review=True):
    models = (ctx.cfg["models"][ctx.cfg["stages"]["redacao"]["tier"]], ctx.cfg["models"][ctx.cfg["stages"]["revisao"]["tier"]])
    conf_min = ctx.cfg["confianca_min"]
    n = {"publicado": 0, "rejeitado": 0}
    for b, art, _ in drafts:
        ver = V.verify(art, b["dir"], ctx.cfg)
        jwrite(b["dir"] / "verificacao.json", ver)
        ctx.audit("verify", decision="ok" if ver["ok"] else "falha", evidence=b["evidence_hash"][:12], problemas=ver["problemas"][:5])
        if not ver["ok"]:
            outcome(ctx, b, art, ver, {"veredicto": "nao_executado", "alegacoes_sem_suporte": []}, "rejeitado", models)
            n["rejeitado"] += 1
            continue
        if not do_review:
            continue
        ev = sha(b["evidence_hash"], canon(art))
        res = call_model(ctx, "revisao", b["dir"], "Avalia o artigo em rascunho.json contra os ficheiros desta pasta.", ev)
        if not res:
            continue
        rev = res["data"]
        jwrite(b["dir"] / "revisao.json", rev)
        ok = rev["veredicto"] == "ok" and art["confianca"] >= conf_min
        ctx.audit("publish", decision="publicado" if ok else "rejeitado", evidence=b["evidence_hash"][:12])
        outcome(ctx, b, art, ver, rev, "publicado" if ok else "rejeitado", models)
        n["publicado" if ok else "rejeitado"] += 1
    return n


def dry_run(ctx):
    c = ctx.cfg
    try:
        rows = B.shortlist(ctx)
        src = f"diario.db ({len(rows)} candidatos)"
        n = len(rows)
    except Exception:
        n = c["pipeline"]["shortlist_size"]
        src = f"sem diario.db: {n} candidatos assumidos"
    top = min(n, c["pipeline"]["select_from"])
    k = min(top, c["budgets"]["max_articles"])
    eur = c["eur_per_usd"]
    total = 0.0
    print(f"dry-run edicao {ctx.date} | {src} | max_artigos={k} | sem chamadas ao modelo")
    plan = [("bundle", "-", 0, 0, 0.0, f"{n} bundles (sem modelo)"),
            ("verify", "-", 0, 0, 0.0, f"{k} verificacoes (sem modelo)")]
    for st, cnt, m in (("triage", 1, n), ("selecao", 1, top), ("redacao", k, 1), ("revisao", k, 1)):
        e = c["estimates"][st]
        tin = e["in_per_candidate"] * m if "in_per_candidate" in e else e["in"]
        tout = e["out"]
        tier = c["stages"][st]["tier"]
        usd = ctx.price(tier, tin, tout) * cnt
        plan.append((st, tier, tin * cnt, tout * cnt, usd, f"{cnt} chamada(s)"))
        total += usd
    print(f"{'etapa':<9}{'modelo':<8}{'tokens_in':>10}{'tokens_out':>11}{'usd':>8}{'eur':>8}  nota")
    for st, tier, ti, to, usd, note in plan:
        print(f"{st:<9}{tier:<8}{ti:>10}{to:>11}{usd:>8.3f}{usd * eur:>8.3f}  {note}")
    print(f"TOTAL estimado: ${total:.2f} / EUR {total * eur:.2f} por dia (limite diario ${c['budgets']['max_usd_day']:.2f})")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--stage", choices=ORDER + ["all"], default="all")
    a = ap.parse_args(argv)
    ctx = Ctx(a.date, a.dry_run)
    if a.dry_run:
        return dry_run(ctx)
    if not ctx.enabled():
        print("IA desativada (AI_ENABLED=0)")
        return 0
    if ctx.stopped():
        print("IA parada (ficheiro STOP)")
        return 0
    ctx.mkdirs()
    want = ORDER if a.stage == "all" else [a.stage]
    try:
        items = jread(ctx.work / "shortlist.json", []) if "bundle" not in want else stage_bundle(ctx)
        if not items:
            ctx.audit("run", decision="sem candidatos")
            return 0
        top = jread(ctx.work / "triage.json", {}).get("top", []) if "triage" not in want else stage_triage(ctx, items)
        chosen = jread(ctx.work / "selecao.json", {}).get("escolhidas", []) if "select" not in want else stage_select(ctx, items, top)
        if {"draft", "verify", "review", "publish"} & set(want):
            have = len(list(ctx.published.glob("*.json")))
            room = max(0, ctx.cfg["budgets"]["max_articles"] - have)
            todo = [e for e in chosen]
            fresh = []
            for e in todo:
                b = B.build(ctx, [e])
                if b and not done(ctx, b["evidence_hash"]):
                    fresh.append(e)
            drafts = stage_draft(ctx, items, fresh[:room]) if "draft" in want else []
            if "verify" in want or "review" in want or "publish" in want:
                n = stage_verify_review(ctx, drafts, do_review="review" in want or "publish" in want)
                ctx.audit("run", decision=f"publicados={n['publicado']} rejeitados={n['rejeitado']}")
    except Halt as h:
        ctx.audit("run", decision=h.reason)
        print(f"parado: {h.reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
