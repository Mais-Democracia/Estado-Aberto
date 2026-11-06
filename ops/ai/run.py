#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "ingest"))
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
        try:
            b = B.build(ctx, [r["id"]])
        except Exception as e:
            ctx.audit("bundle", decision="erro", erro=type(e).__name__, evento=r.get("id"))
            continue
        if b:
            items.append({"id": r["id"], "evidence_hash": b["evidence_hash"], "row": r})
    jwrite(ctx.work / "shortlist.json", items)
    ctx.audit("bundle", decision=f"{len(items)} bundles")
    return items


def small_day(ctx, items):
    return len(items) <= ctx.cfg["budgets"]["max_articles"]


def stage_small(ctx, items):
    ids = [i["id"] for i in items]
    jwrite(ctx.work / "triage.json", {"ranking": ids, "top": ids, "modo": "dia_pequeno"})
    jwrite(ctx.work / "selecao.json", {"escolhidas": ids, "modo": "dia_pequeno"})
    ctx.audit("select", decision=f"dia_pequeno:{len(ids)}")
    return ids


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
    chosen, seen = [], set()
    for h in (res["data"]["historias"] if res else []):
        i = h["evento_id"]
        if i in byid and i not in seen:
            seen.add(i)
            chosen.append(i)
    chosen = chosen[:mx]
    floor = min(ctx.cfg["pipeline"]["min_artigos_dia"], mx)
    for i in top:
        if len(chosen) >= floor:
            break
        if i in byid and i not in chosen:
            chosen.append(i)
    jwrite(ctx.work / "selecao.json", {"escolhidas": chosen})
    return chosen


def done(ctx, ev):
    return (ctx.published / f"{ev}.json").exists() or (ctx.rejected / f"{ev}.json").exists() or (ctx.killed / ev).exists()


def killed_events(ctx):
    out = set()
    for f in ctx.killed.glob("*") if ctx.killed.is_dir() else []:
        out |= {int(x) for x in (jread(f, {}) or {}).get("evento_ids", []) if str(x).isdigit()}
    return out


def stored_expl(e):
    if not isinstance(e, dict):
        return None
    items = V.expl_items(e)
    return {"do_que_trata": e.get("do_que_trata", ""), "o_que_muda": [t for t, _ in items], "evidencias": [x for _, x in items]}


def outcome(ctx, b, art, ver, rev, estado, models):
    doc = {"edicao_data": ctx.date, "evidence_hash": b["evidence_hash"], "evento_ids": [r["id"] for r in b["rows"]],
           "titulo": art["titulo"], "lead": art["lead"], "corpo": art["corpo"], "pontos_chave": art["pontos_chave"],
           "fontes": art["fontes"], "numeros_citados": art["numeros_citados"], "calculos": art.get("calculos", []), "entidades": art["entidades"],
           "blocos": jread(b["dir"] / "blocos.json"), "explicacao": stored_expl(art.get("explicacao")),
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
    out = []
    for eid in chosen:
        try:
            b = B.build(ctx, [eid])
            if not b or done(ctx, b["evidence_hash"]):
                continue
            B.add_text(ctx, b)
            t = b["dir"] / "texto.txt"
            ev = sha(b["evidence_hash"], hashed(t), hashed(b["dir"] / "facts.json"))
            (b["dir"] / "rascunho.json").unlink(missing_ok=True)
            res = call_model(ctx, "redacao_lei" if b.get("lei") else "redacao", b["dir"], "Redige o artigo sobre o evento descrito nos ficheiros desta pasta.", ev)
            if not res:
                continue
            jwrite(ctx.work / "drafts" / f"{b['evidence_hash']}.json", res["data"])
            out.append((b, res["data"], ev))
        except Halt:
            raise
        except Exception as e:
            ctx.audit("draft", decision="erro", erro=type(e).__name__, evento=eid)
    return out


def hashed(p):
    return sha(p.read_bytes()) if p.exists() else "-"


CAPS = {"titulo": 160, "lead": 400, "corpo": 2400}
TAGRX = re.compile(r"</?\s*(?:fonte_nao_confiavel|rascunho_nao_confiavel)\s*>", re.I)


def cap(v, n):
    return TAGRX.sub("", str(v))[:n]


def review_input(art):
    d = {k: cap(art.get(k, ""), n) for k, n in CAPS.items()}
    d["pontos_chave"] = [cap(x, 240) for x in art.get("pontos_chave", [])[:5]]
    d["fontes"] = [{"label": cap(f.get("label", ""), 120), "href": cap(f.get("href", ""), 600)} for f in art.get("fontes", [])[:8]]
    d["numeros_citados"] = [cap(x, 40) for x in art.get("numeros_citados", [])[:30]]
    d["entidades"] = [{"nome": cap(e.get("nome", ""), 120), "tipo": cap(e.get("tipo", ""), 20), "cargo_publico": cap(e.get("cargo_publico", ""), 80)} if isinstance(e, dict) else cap(e, 120) for e in art.get("entidades", [])[:30]]
    d["calculos"] = [{"expr": cap(c.get("expr", ""), 120), "resultado": cap(c.get("resultado", ""), 40)} for c in art.get("calculos", [])[:10]]
    if isinstance(art.get("explicacao"), dict):
        e = art["explicacao"]
        d["explicacao"] = {"do_que_trata": cap(e.get("do_que_trata", ""), 900),
                           "o_que_muda": [{"texto": cap(t, 300), "evidencia": cap(x, 400)} for t, x in V.expl_items(e)[:6]]}
    return "<rascunho_nao_confiavel>\n" + json.dumps(d, ensure_ascii=False, indent=1) + "\n</rascunho_nao_confiavel>\n"


def stage_verify_review(ctx, drafts, do_review=True):
    models = (ctx.cfg["models"][ctx.cfg["stages"]["redacao"]["tier"]], ctx.cfg["models"][ctx.cfg["stages"]["revisao"]["tier"]])
    conf_min = ctx.cfg["confianca_min"]
    n = {"publicado": 0, "rejeitado": 0}
    for b, art, _ in drafts:
        try:
            ver = V.verify(art, b["dir"], ctx.cfg)
            jwrite(b["dir"] / "verificacao.json", ver)
            ctx.audit("verify", decision="ok" if ver["ok"] else "falha", evidence=b["evidence_hash"][:12], problemas=ver["problemas"][:5])
            if not ver["ok"]:
                outcome(ctx, b, art, ver, {"veredicto": "nao_executado", "alegacoes_sem_suporte": []}, "rejeitado", models)
                n["rejeitado"] += 1
                continue
            if not do_review:
                continue
            (b["dir"] / "rascunho.json").unlink(missing_ok=True)
            (b["dir"] / "rascunho_revisao.txt").write_text(review_input(art), encoding="utf-8")
            ev = sha(b["evidence_hash"], canon(art))
            res = call_model(ctx, "revisao", b["dir"], "Avalia o artigo em rascunho_revisao.txt contra os ficheiros desta pasta.", ev)
            if not res:
                continue
            rev = res["data"]
            jwrite(b["dir"] / "revisao.json", rev)
            ok = rev["veredicto"] == "ok" and art["confianca"] >= conf_min
            ctx.audit("publish", decision="publicado" if ok else "rejeitado", evidence=b["evidence_hash"][:12])
            outcome(ctx, b, art, ver, rev, "publicado" if ok else "rejeitado", models)
            n["publicado" if ok else "rejeitado"] += 1
        except Halt:
            raise
        except Exception as e:
            reason = f"erro:{type(e).__name__}"
            ctx.audit("publish", decision="rejeitado", evidence=b["evidence_hash"][:12], erro=reason)
            try:
                outcome(ctx, b, art, {"ok": False, "problemas": [reason]}, {"veredicto": "nao_executado", "alegacoes_sem_suporte": []}, "rejeitado", models)
            except Exception:
                pass
            n["rejeitado"] += 1
    return n


def law_report(ctx, rows, fetch=True):
    import tempfile
    ctx.bundles = Path(tempfile.mkdtemp(prefix="ea-dry-"))
    ctx.work = ctx.bundles / "work"
    found = []
    for r in rows:
        try:
            b = B.build(ctx, [r["id"]])
        except Exception:
            continue
        if not b or not b.get("lei"):
            continue
        txt = B.add_text(ctx, b) if fetch else False
        facts = jread(b["dir"] / "facts.json", {}).get("lei", {})
        blocos = jread(b["dir"] / "blocos.json", {})
        found.append((r, facts, blocos, txt, b))
    return found


def print_law(r, facts, blocos, txt, b):
    ini = facts.get("iniciativa") or {}
    print(f"LEI evento {r['id']} ({r.get('tipo')}): {str(ini.get('tipo') or '')} n.o {ini.get('numero')}/{ini.get('legislatura')} | {lib.sanitize(str(blocos.get('lei', {}).get('titulo') or ''))[:90]}")
    print(f"  rota {blocos.get('lei', {}).get('rota')} | lei_em_vigor={facts.get('lei_em_vigor')} | bundle {b['dir'].name[:12]}")
    v = blocos.get("votacao")
    if v:
        parts = ", ".join(f"{p['partido']} {p['voto']}" + (f" ({p['lugares']})" if p.get("lugares") is not None else "") for p in v["por_partido"])
        print(f"  votacao {v['data']} {v['resultado']}: {parts} | totais {v['totais']}")
    else:
        print("  votacao: sem dados")
    iv = facts.get("intervencoes") or []
    by = {}
    for x in iv:
        by[x.get("partido") or "gov"] = by.get(x.get("partido") or "gov", 0) + 1
    print(f"  intervencoes: {facts.get('intervencoes_total', 0)} no total, {len(iv)} no bundle {by}, {len(blocos.get('intervencoes', []))} excertos")
    for x in blocos.get("intervencoes", [])[:2]:
        print(f"    [{x['partido']}] {x['deputado']}: {x['excerto'][:110]}")
    t = b["dir"] / "texto.txt"
    print(f"  texto_disponivel={facts.get('texto_disponivel')} origem={facts.get('texto_origem')} chars={t.stat().st_size if t.exists() else 0} url={blocos.get('lei', {}).get('texto_url')}")


def dry_run(ctx):
    c = ctx.cfg
    mx = c["budgets"]["max_articles"]
    laws = []
    try:
        rows = [r for r in B.shortlist(ctx) if not B.excluded(c, r)]
        src = f"diario.db ({len(rows)} candidatos)"
        n = len(rows)
    except Exception:
        rows = None
        n = c["pipeline"]["shortlist_size"]
        src = f"sem diario.db: {n} candidatos assumidos"
    small = rows is not None and n <= mx
    top = min(n, c["pipeline"]["select_from"])
    k = n if small else min(top, mx)
    k = max(k, min(n, c["pipeline"]["min_artigos_dia"], mx))
    if rows:
        laws = law_report(ctx, rows[:k], fetch=os.environ.get("AI_DRY_NO_FETCH") != "1")
    nl = len(laws)
    eur = c["eur_per_usd"]
    total = 0.0
    modo = "dia pequeno: sem triagem nem selecao" if small else "triagem + selecao"
    print(f"dry-run edicao {ctx.date} | {src} | modo={modo} | max_artigos={k} leis={nl} | sem chamadas ao modelo")
    plan = [("bundle", "-", 0, 0, 0.0, f"{n} bundles (sem modelo)"),
            ("verify", "-", 0, 0, 0.0, f"{k} verificacoes (sem modelo)")]
    steps = [] if small else [("triage", 1, n), ("selecao", 1, top)]
    steps += [("redacao", k - nl, 1), ("redacao_lei", nl, 1), ("revisao", k, 1)]
    for st, cnt, m in steps:
        if cnt <= 0:
            continue
        e = c["estimates"][st]
        tin = e["in_per_candidate"] * m if "in_per_candidate" in e else e["in"]
        tout = e["out"]
        tier = c["stages"][st]["tier"]
        usd = ctx.price(tier, tin, tout) * cnt
        plan.append((st, tier, tin * cnt, tout * cnt, usd, f"{cnt} chamada(s)"))
        total += usd
    print(f"{'etapa':<12}{'modelo':<8}{'tokens_in':>10}{'tokens_out':>11}{'usd':>8}{'eur':>8}  nota")
    for st, tier, ti, to, usd, note in plan:
        print(f"{st:<12}{tier:<8}{ti:>10}{to:>11}{usd:>8.3f}{usd * eur:>8.3f}  {note}")
    print(f"TOTAL estimado: ${total:.2f} / EUR {total * eur:.2f} por dia (limite diario ${c['budgets']['max_usd_day']:.2f})")
    for law in laws:
        print_law(*law)
    return 0


def find_files(ctx, h):
    out = []
    for sub in ("published", "rejected"):
        out += [(sub, p) for p in sorted((ctx.ai / sub).glob(f"*/{h}.json"))]
    return out


def resolve(ctx, ref):
    if ref.isdigit():
        try:
            row = lib.open_ro(lib.data_dir() / "diario.db").execute("SELECT evidence_hash FROM artigos_ia WHERE id=?", (int(ref),)).fetchone()
        except Exception:
            row = None
        return row[0] if row else None
    if len(ref) < 8 or not re.fullmatch(r"[0-9a-f]+", ref):
        return None
    hashes = {p.stem for sub in ("published", "rejected") for p in (ctx.ai / sub).glob(f"*/{ref}*.json")}
    return hashes.pop() if len(hashes) == 1 else None


def write_file(path, obj):
    jwrite(path, obj)
    try:
        os.chmod(path, 0o664)
    except OSError:
        pass


def run_import(dates):
    rc = 0
    for d in sorted(dates) or [None]:
        cmd = [sys.executable, str(lib.ROOT / "ingest" / "jobs" / "diario_ia.py")] + (["--date", d] if d else [])
        p = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ))
        if p.returncode != 0:
            rc = p.returncode
            print(f"importacao falhou para {d or 'todas'}: execute como utilizador da aplicacao ou 'systemctl start estado-aberto-ai-import.service'")
    return rc


def kill(ctx, ref, motivo):
    h = resolve(ctx, ref)
    if not h:
        print("referencia desconhecida")
        return 2
    ctx.killed.mkdir(parents=True, exist_ok=True)
    files = find_files(ctx, h)
    dates, ids = set(), []
    stamp = lib.now().isoformat(timespec="seconds")
    for sub, p in files:
        doc = jread(p, {})
        dates.add(p.parent.name)
        ids = doc.get("evento_ids", ids)
        doc["estado"] = "rejeitado"
        doc["verificacao"] = dict(doc.get("verificacao") or {}, retirada={"motivo": motivo, "em": stamp})
        target = ctx.ai / "rejected" / p.parent.name / p.name
        write_file(target, doc)
        if p != target:
            p.unlink()
    write_file(ctx.killed / h, {"evidence_hash": h, "motivo": motivo, "em": stamp, "evento_ids": ids, "datas": sorted(dates)})
    ctx.audit("kill", decision="retirado", evidence=h[:12], motivo=motivo[:200])
    rc = run_import(dates)
    print(f"retirado {h[:12]} (ficheiros: {len(files)})")
    return rc


def unkill(ctx, ref):
    h = resolve(ctx, ref) or (ref if (ctx.killed / ref).exists() else None)
    if not h:
        print("referencia desconhecida")
        return 2
    dates = set()
    for sub, p in find_files(ctx, h):
        doc = jread(p, {})
        ver = doc.get("verificacao") or {}
        if sub == "rejected" and "retirada" in ver:
            ver.pop("retirada")
            doc["estado"] = "publicado"
            doc["verificacao"] = ver
            write_file(ctx.ai / "published" / p.parent.name / p.name, doc)
            p.unlink()
            dates.add(p.parent.name)
    (ctx.killed / h).unlink(missing_ok=True)
    ctx.audit("kill", decision="reposto", evidence=h[:12])
    rc = run_import(dates)
    print(f"reposto {h[:12]}")
    return rc


def pipeline(ctx, a):
    ctx.mkdirs()
    want = ORDER if a.stage == "all" else [a.stage]
    try:
        items = jread(ctx.work / "shortlist.json", []) if "bundle" not in want else stage_bundle(ctx)
        if not items:
            ctx.audit("run", decision="sem candidatos")
            return 0
        small = small_day(ctx, items)
        if small and ("triage" in want or "select" in want):
            ids = stage_small(ctx, items)
            top, chosen = ids, ids
        else:
            top = jread(ctx.work / "triage.json", {}).get("top", []) if "triage" not in want else stage_triage(ctx, items)
            chosen = jread(ctx.work / "selecao.json", {}).get("escolhidas", []) if "select" not in want else stage_select(ctx, items, top)
        if {"draft", "verify", "review", "publish"} & set(want):
            have = len(list(ctx.published.glob("*.json")))
            room = max(0, ctx.cfg["budgets"]["max_articles"] - have)
            bad = killed_events(ctx)
            fresh = []
            for e in chosen:
                if e in bad:
                    continue
                try:
                    b = B.build(ctx, [e])
                except Exception as ex:
                    ctx.audit("bundle", decision="erro", erro=type(ex).__name__, evento=e)
                    continue
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


def reverify(ctx):
    ctx.mkdirs()
    bad = killed_events(ctx)
    killed = {p.name for p in ctx.killed.glob("*")} if ctx.killed.is_dir() else set()
    todo = []
    for p in sorted(ctx.rejected.glob("*.json")):
        doc = jread(p)
        if not isinstance(doc, dict) or p.stem in killed or "retirada" in (doc.get("verificacao") or {}):
            continue
        if bad & {int(x) for x in doc.get("evento_ids", []) if str(x).isdigit()}:
            continue
        bdir = ctx.bundles / p.stem
        if not (bdir / "facts.json").exists():
            continue
        art = {k: doc.get(k) for k in ("titulo", "lead", "corpo", "pontos_chave", "fontes", "numeros_citados", "calculos", "entidades", "confianca", "explicacao", "blocos")}
        art["calculos"] = art["calculos"] or []
        if art["explicacao"] is None:
            art.pop("explicacao")
        if art["blocos"] is None:
            art.pop("blocos")
        todo.append(({"dir": bdir, "evidence_hash": p.stem, "rows": [{"id": i} for i in doc.get("evento_ids", [])]}, art, None))
    n = {"publicado": 0, "rejeitado": 0}
    try:
        for item in todo:
            room = ctx.cfg["budgets"]["max_articles"] - len(list(ctx.published.glob("*.json")))
            r = stage_verify_review(ctx, [item], do_review=room > 0)
            n["publicado"] += r["publicado"]
            n["rejeitado"] += r["rejeitado"]
    except Halt as h:
        ctx.audit("run", decision=h.reason)
        print(f"parado: {h.reason}")
    ctx.audit("run", decision=f"reverificacao publicados={n['publicado']} rejeitados={n['rejeitado']}")
    print(f"reverificados={len(todo)} publicados={n['publicado']} rejeitados={n['rejeitado']}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(epilog="Publish cached rejected drafts of a date: run.py --reverify DATE, then start estado-aberto-ai-import.service (systemctl start estado-aberto-ai-import.service) to import the result into the ledger. Exit 75: lock busy; 77: lock unusable.")
    ap.add_argument("--date")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--stage", choices=ORDER + ["all"], default="all")
    ap.add_argument("--reverify", metavar="DATE")
    ap.add_argument("--kill", metavar="HASH_OR_ARTICLE_ID")
    ap.add_argument("--unkill", metavar="HASH_OR_ARTICLE_ID")
    ap.add_argument("--motivo", default="retirado pelo editor")
    ap.add_argument("--wait", type=float, default=1500)
    a = ap.parse_args(argv)
    ctx = Ctx(a.reverify or a.date, a.dry_run)
    if a.dry_run:
        return dry_run(ctx)
    if not (a.kill or a.unkill):
        if not ctx.enabled():
            print("IA desativada (AI_ENABLED=0)")
            return 0
        if ctx.stopped():
            print("IA parada (ficheiro STOP)")
            return 0
    from common import LockTimeout, LockUnavailable, SharedLock
    try:
        with SharedLock("ai", wait=a.wait, state=lib.state_root()):
            if a.kill:
                return kill(ctx, a.kill, a.motivo[:300])
            if a.unkill:
                return unkill(ctx, a.unkill)
            if a.reverify:
                return reverify(ctx)
            return pipeline(ctx, a)
    except LockTimeout:
        print("bloqueio ocupado")
        return 75
    except LockUnavailable as e:
        print(f"{e}", file=sys.stderr, flush=True)
        return 77


if __name__ == "__main__":
    sys.exit(main())
