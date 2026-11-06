import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "jobs"))
sys.path.insert(0, str(ROOT / "ops" / "ai"))
import diario as J  # noqa: E402
import diario_score as S  # noqa: E402

DAY = "2026-11-08"
TODAY = "2026-11-09"
PRIV = "123456789"


def utc(y, m, d, h=12):
    return J.local_to_utc(dt.datetime(y, m, d, h, 0))


def mk(path, ddl, rows=()):
    con = sqlite3.connect(path)
    for stmt in ddl:
        con.execute(stmt)
    for table, row in rows:
        con.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
    con.commit()
    con.close()


def add(path, table, row):
    mk(path, [], [(table, row)])


DDL_POLITICA = [
    "CREATE TABLE parties (code TEXT PRIMARY KEY, seats INTEGER)",
    "CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT, start TEXT, end TEXT, section TEXT, theme TEXT, subtitle TEXT, local TEXT, text TEXT, source TEXT)",
    "CREATE TABLE initiatives (key TEXT PRIMARY KEY, kind TEXT, number INTEGER, legislature TEXT, session INTEGER, origin TEXT, title TEXT, source TEXT)",
    "CREATE TABLE initiative_steps (initiative_key TEXT, event_id INTEGER, date TEXT, phase TEXT, body TEXT, detail TEXT, relator TEXT, source TEXT, UNIQUE (initiative_key, event_id, phase))",
    "CREATE TABLE news (url TEXT PRIMARY KEY, body TEXT, title TEXT, date TEXT, source TEXT)",
    "CREATE TABLE contracts (id TEXT PRIMARY KEY, signed TEXT, published TEXT, object TEXT, procedure TEXT, price REAL, n_bidders INTEGER, buyer_nif TEXT, buyer_name TEXT, seller_nif TEXT, seller_name TEXT, link TEXT, n_sellers INTEGER)",
    "CREATE TABLE buyer_stats (nif TEXT, n, value, direct_n, direct_value, single_bidder_n, competitive_n, overrun_n, first_signed, last_signed)",
]


def contract(i, price, proc="Concurso público", bidders=3, seller="509999999", day=DAY, buyer="600000001"):
    return ("contracts", {"id": i, "signed": day, "published": day, "object": f"Objeto {i}", "procedure": proc, "price": price, "n_bidders": bidders, "buyer_nif": buyer,
                          "buyer_name": "Câmara Exemplo", "seller_nif": seller, "seller_name": "Fornecedor " + i, "link": f"https://base.gov.pt/c/{i}", "n_sellers": 1})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        d = self.dir

        def ev(i, start, sec):
            return ("events", {"id": i, "title": f"Reunião {i}\nlinha extra", "start": start, "end": start, "section": sec, "theme": "Tema", "local": "Sala 1"})

        def step(k, ph, n, date="2026-11-08"):
            return ("initiative_steps", {"initiative_key": k, "event_id": n, "date": date, "phase": ph, "body": "Plenário", "detail": "detalhe do passo"})
        mk(d / "politica.db", DDL_POLITICA, [
            ("parties", {"code": "PS", "seats": 58}),
            ev(1, "2026-11-10T10:00:00", "Plenário"), ev(2, "2026-11-10T15:00:00", "Comissões"), ev(3, "2026-11-12T10:00:00", "Comissões"),
            ev(4, "2026-11-09T10:00:00", "Plenário"), ev(5, "2026-11-20T10:00:00", "Plenário"),
            ("initiatives", {"key": "XVII/PL/11", "kind": "Projeto de Lei", "number": 11, "legislature": "XVII", "title": "Altera o regime das rendas"}),
            ("initiatives", {"key": "XVII/PL/12", "kind": "Projeto de Lei", "number": 12, "legislature": "XVII", "title": "Cria o estatuto X"}),
            step("XVII/PL/11", "Discussão", 1), step("XVII/PL/11", "Votação", 2), step("XVII/PL/12", "Discussão", 3), step("XVII/PL/12", "Admissão", 4, "2026-11-07"), step("XVII/PL/12", "Votação", 5, "2026-11-20"),
            ("news", {"url": "https://presidencia.pt/n/1", "body": "Presidência da República", "title": "Presidente recebe associações", "date": DAY}),
            ("news", {"url": "https://presidencia.pt/n/2", "body": "Presidência da República", "title": "Presidente visita escola", "date": DAY}),
            ("news", {"url": "https://presidencia.pt/n/3", "body": "Presidência da República", "title": "Mensagem sobre a economia", "date": "2026-11-07"}),
            ("news", {"url": "https://outro.pt/n/9", "body": "Outro organismo", "title": "Outra notícia", "date": DAY}),
            contract("c1", 80000.0), contract("c2", 150000.0, "Ajuste Direto Regime Geral", None, PRIV), contract("c3", 60000.0, "Concurso público", 1), contract("c4", 900.0),
            ("buyer_stats", {"nif": "600000001", "n": 10, "value": 100000.0, "direct_n": 1, "direct_value": 1000.0, "single_bidder_n": 0, "competitive_n": 9, "overrun_n": 0}),
        ])
        mk(d / "presidencia.db", ["CREATE TABLE atos (id TEXT PRIMARY KEY, data TEXT, tipo TEXT, titulo TEXT, texto TEXT, mensagem_url TEXT, source_url TEXT, canon INTEGER DEFAULT 1)"],
           [("atos", {"id": "a1", "data": DAY, "tipo": "promulgacao", "titulo": "Promulga o diploma sobre taxas", "texto": "Promulgou.\nDetalhe.\nTexto."})])
        mk(d / "ministerios.db", ["CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, cm_date TEXT, cm_title TEXT, n INTEGER, text TEXT, matched TEXT, source_url TEXT)"], [
            ("decisions", {"ministry": "financas", "cm_date": DAY, "cm_title": "Aprova o decreto-lei das taxas", "n": 1, "text": "O Conselho de Ministros aprovou o decreto-lei das taxas.", "source_url": "https://portugal.gov.pt/cm/1"}),
            ("decisions", {"ministry": "economia", "cm_date": DAY, "cm_title": "Aprova o decreto-lei das taxas", "n": 1, "text": "O Conselho de Ministros aprovou o decreto-lei das taxas.", "source_url": "https://portugal.gov.pt/cm/1"}),
            ("decisions", {"ministry": "saude", "cm_date": DAY, "cm_title": "Aprova a resolução sobre urgências", "n": 2, "text": "Resolução sobre urgências.", "source_url": "https://portugal.gov.pt/cm/1"}),
            ("decisions", {"ministry": "saude", "cm_date": "2026-10-01", "cm_title": "Decisão antiga", "n": 3, "text": "Antiga.", "source_url": "https://portugal.gov.pt/cm/0"})])
        mk(d / "justica.db", ["CREATE TABLE tc_acordaos (id TEXT PRIMARY KEY, year INTEGER, num INTEGER, processo TEXT, formacao TEXT, especie TEXT, tipo TEXT, data TEXT, relator TEXT, norma TEXT, resultado TEXT, sumario TEXT, dre_act_id TEXT, url TEXT, source_url TEXT)"],
           [("tc_acordaos", {"id": "tc1", "year": 2026, "num": 500, "processo": "123/2026", "formacao": "Plenário", "especie": "Fiscalização sucessiva", "tipo": "Fiscalização sucessiva abstrata", "data": DAY,
                             "relator": "Conselheira Exemplo", "norma": "artigo 5.º da Lei das Rendas", "resultado": "Declarada inconstitucionalidade", "sumario": "Decisão sobre a norma.", "url": "https://tribunalconstitucional.pt/ac/tc1"})])
        mk(d / "fundos.db", ["CREATE TABLE awards (id INTEGER PRIMARY KEY, fw TEXT, nif TEXT, name TEXT, fundo TEXT, programa TEXT, titulo TEXT, ano INTEGER, estado TEXT, concelho TEXT, aprovado REAL, pago REAL)"],
           [("awards", {"id": 1, "fw": "PT2030", "nif": "501111111", "name": "Entidade Antiga", "fundo": "FEDER", "aprovado": 100.0, "pago": 0.0})])
        mk(d / "autarquias.db", ["CREATE TABLE municipios (dico TEXT PRIMARY KEY, name TEXT)", "CREATE TABLE pmp (dico TEXT, date TEXT, days INTEGER, partial INTEGER, source_url TEXT, PRIMARY KEY (dico, date))",
                                 "CREATE TABLE finance (dico TEXT, nif TEXT, year INTEGER, kind TEXT, code TEXT, label TEXT, value REAL, source_url TEXT, PRIMARY KEY (dico, year, kind, code))"],
           [("municipios", {"dico": "0101", "name": "Município A"}), ("municipios", {"dico": "0102", "name": "Município B"}), ("pmp", {"dico": "0101", "date": "2026-06-30", "days": 10, "partial": 0}),
            ("finance", {"dico": "0102", "year": 2024, "kind": "despesa", "code": "9", "label": "Outras", "value": 1.0})])
        mk(d / "empresas_locais.db", ["CREATE TABLE company (id INTEGER PRIMARY KEY, nif TEXT, name TEXT, sector TEXT, status TEXT, seller_contracts INTEGER, seller_value REAL, last_signed TEXT)"],
           [("company", {"id": 1, "nif": "505000000", "name": "Águas Municipais", "sector": "Água", "status": "ativo", "seller_contracts": 4, "seller_value": 120000.0, "last_signed": DAY})])
        mk(d / "regioes.db", ["CREATE TABLE acts (region TEXT, id TEXT, kind TEXT, number TEXT, date TEXT, title TEXT, summary TEXT, url TEXT)"],
           [("acts", {"region": "acores", "id": "r1", "kind": "Decreto Legislativo Regional", "number": "1/2026", "date": DAY, "title": "Regime das pescas", "summary": "Resumo", "url": "https://jo.azores.gov.pt/r1"}),
            ("acts", {"region": "acores", "id": "r2", "kind": "Portaria", "number": "2/2026", "date": DAY, "title": "Portaria dos transportes", "summary": "Resumo", "url": "https://jo.azores.gov.pt/r2"})])
        self.now = utc(2026, 11, 9, 12)

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, now=None, **kw):
        return J.run(self.dir, self.dir, now or self.now, **kw)

    def rows(self, where="1", p=()):
        con = sqlite3.connect(self.dir / "diario.db")
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(f"SELECT * FROM eventos WHERE {where} ORDER BY id", p)]
        finally:
            con.close()

    def of(self, tipo):
        return self.rows("tipo = ?", (tipo,))


class Eventos(Base):
    def test_agenda_semana(self):
        self.run_job()
        ev = {e["data_evento"]: e for e in self.of("agenda_semana")}
        self.assertEqual(set(ev), {TODAY, DAY})
        e = ev[TODAY]
        self.assertEqual((e["secao"], e["rota"], e["edicao_data"], e["fonte_ref"]), ("parlamento", "#/calendario", "2026-11-10", TODAY))
        self.assertIn("3 eventos agendados", e["titulo"])
        self.assertIn("1 sessão de plenário", e["resumo_curto"])
        self.assertIn("2 reuniões de comissões e audições", e["resumo_curto"])
        self.assertIn("4 eventos agendados", ev[DAY]["titulo"])
        self.assertEqual(e["score"], S.BASE["agenda_semana"])

    def test_agenda_absent_without_rows(self):
        self.run_job(utc(2026, 12, 20, 12))
        self.assertEqual(self.of("agenda_semana"), [])

    def test_leis_em_curso(self):
        self.run_job()
        rows = self.of("leis_em_curso_dia")
        self.assertEqual([r["data_evento"] for r in rows], ["2026-11-07", DAY])
        e = rows[1]
        self.assertEqual((e["secao"], e["rota"]), ("parlamento", "#/leis"))
        self.assertIn("3 novos passos em 2 iniciativas", e["titulo"])

    def test_presidencia_dia_with_news(self):
        self.run_job()
        rows = {r["data_evento"]: r for r in self.of("presidencia_dia")}
        self.assertEqual(rows[DAY]["titulo"], "Presidente da República: 1 ato e 2 notícias em 8 de novembro de 2026")
        self.assertTrue(rows["2026-11-07"]["titulo"].startswith("Presidente da República: 1 notícia em 7 de novembro de 2026"))
        self.assertEqual(rows[DAY]["rota"], "#/presidencia")

    def test_presidencia_dia_news_only_without_atos(self):
        os.remove(self.dir / "presidencia.db")
        mk(self.dir / "presidencia.db", ["CREATE TABLE atos (id TEXT PRIMARY KEY, data TEXT, tipo TEXT, titulo TEXT, texto TEXT, mensagem_url TEXT, source_url TEXT, canon INTEGER DEFAULT 1)"])
        self.run_job()
        self.assertEqual({r["data_evento"]: r["titulo"] for r in self.of("presidencia_dia")}[DAY], "Presidente da República: 2 notícias em 8 de novembro de 2026")

    def test_governo_cm_groups_ministries_and_respects_window(self):
        self.run_job()
        rows = self.of("governo_cm")
        self.assertEqual(len(rows), 2)
        taxas = next(r for r in rows if "taxas" in r["titulo"])
        self.assertEqual((taxas["secao"], taxas["rota"], taxas["data_evento"]), ("governo", "#/ministerios/economia", DAY))
        self.assertIn("economia, financas", taxas["resumo_curto"])
        self.assertFalse(any("antiga" in r["titulo"] for r in rows))

    def test_acordao_constitucional(self):
        self.run_job()
        e = self.of("acordao_constitucional")[0]
        self.assertEqual((e["secao"], e["rota"]), ("fiscalizacao", "#/justica/tc?q=123%2F2026"))
        self.assertIn("declarada inconstitucionalidade", e["titulo"])
        self.assertEqual(e["score"], S.BASE["acordao_constitucional"])

    def test_contratos_destaque(self):
        self.run_job()
        e = self.of("contratos_destaque_dia")[0]
        self.assertEqual((e["secao"], e["rota"], e["data_evento"]), ("dinheiro", "#/contratos", DAY))
        self.assertIn("3 contratos muito acima da média do adjudicante", e["resumo_curto"])
        self.assertIn("1 ajuste direto de valor elevado", e["resumo_curto"])
        self.assertIn("1 concurso com um só concorrente", e["resumo_curto"])

    def test_regioes_and_empresas_locais(self):
        self.run_job()
        r = self.of("regioes_dia")[0]
        self.assertEqual((r["secao"], r["rota"], r["fonte_ref"]), ("governo", "#/regioes/acores", f"acores:{DAY}"))
        self.assertIn("2 atos publicados", r["titulo"])
        p = [x for x in self.of("poder_local_dia") if x["fonte_modulo"] == "empresas_locais"][0]
        self.assertEqual((p["secao"], p["rota"]), ("poder-local", "#/empresas-locais"))

    def test_new_rows_make_fundos_and_autarquias_events(self):
        self.run_job()
        self.assertEqual(self.of("fundos_dia"), [])
        add(self.dir / "fundos.db", "awards", {"id": 2, "fw": "PT2030", "nif": "501111112", "name": "Entidade Nova", "fundo": "FSE", "aprovado": 5000.0, "pago": 0.0})
        add(self.dir / "fundos.db", "awards", {"id": 3, "fw": "PT2030", "nif": PRIV, "name": "Pessoa Singular", "fundo": "FSE", "aprovado": 7000.0, "pago": 0.0})
        add(self.dir / "autarquias.db", "pmp", {"dico": "0102", "date": "2026-09-30", "days": 40, "partial": 0})
        self.run_job(self.now + dt.timedelta(hours=1))
        f = self.of("fundos_dia")[0]
        self.assertEqual((f["secao"], f["rota"], f["fonte_ref"]), ("dinheiro", "#/fundos", "2-3"))
        self.assertIn("2 novas operações registadas", f["titulo"])
        a = [x for x in self.of("poder_local_dia") if x["fonte_ref"].startswith("pmp:")][0]
        self.assertEqual(a["secao"], "poder-local")
        self.assertEqual(len(self.of("fundos_dia")), 1)
        self.run_job(self.now + dt.timedelta(hours=2))
        self.assertEqual(len(self.of("fundos_dia")), 1)

    def test_staleness_in_scoring_and_shortlist(self):
        self.assertEqual(S.score("veto", lag_days=5), 75)
        self.assertEqual(S.score("veto", lag_days=6), 90 - 20 - S.STALE_PENALTY)
        self.assertFalse(S.stale_event("2026-11-04", "2026-11-10"))
        self.assertTrue(S.stale_event("2026-11-03", "2026-11-10"))
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE eventos (id INTEGER, secao TEXT, score REAL, data_evento TEXT, edicao_data TEXT)")
        con.executemany("INSERT INTO eventos VALUES (?,?,?,?,?)", [(1, "governo", 95, "2026-10-01", "2026-11-10"), (2, "governo", 50, "2026-11-09", "2026-11-10"), (3, "governo", 40, "2026-11-04", "2026-11-10")])
        self.assertEqual(S.shortlist("2026-11-10", con=con), [2, 3])

    def test_old_events_remain_in_ledger_but_not_in_shortlist(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "diario.db")
        con.execute("UPDATE eventos SET data_evento = '2026-10-20' WHERE tipo = 'acordao_constitucional'")
        con.commit()
        con.close()
        self.assertEqual(len(self.of("acordao_constitucional")), 1)
        ids = S.shortlist("2026-11-10", con=sqlite3.connect(self.dir / "diario.db"))
        self.assertNotIn(self.of("acordao_constitucional")[0]["id"], ids)
        self.assertIn(self.rows("tipo = ? AND data_evento = ?", ("agenda_semana", TODAY))[0]["id"], ids)


class Bundles(Base):
    def setUp(self):
        super().setUp()
        import bundle
        import lei
        import lib
        import run
        self.bundle, self.lei, self.run = bundle, lei, run
        self.run_job()
        add(self.dir / "fundos.db", "awards", {"id": 2, "fw": "PT2030", "nif": PRIV, "name": "Pessoa Singular", "fundo": "FSE", "aprovado": 7000.0, "pago": 0.0})
        add(self.dir / "fundos.db", "awards", {"id": 3, "fw": "PT2030", "nif": "501111112", "name": "Entidade Nova", "fundo": "FEDER", "aprovado": 5000.0, "pago": 100.0})
        add(self.dir / "autarquias.db", "pmp", {"dico": "0102", "date": "2026-09-30", "days": 40, "partial": 1})
        add(self.dir / "autarquias.db", "finance", {"dico": "0101", "year": 2025, "kind": "despesa", "code": "1", "label": "Pessoal", "value": 10.0})
        self.run_job(self.now + dt.timedelta(hours=1))
        self.env = mock.patch.dict(os.environ, {"ESTADO_ABERTO_DATA": str(self.dir), "ESTADO_ABERTO_SOURCE_DATA": str(self.dir)})
        self.env.start()
        (self.dir / "bundles").mkdir()
        self.ctx = SimpleNamespace(cfg=lib.load_config(), date="2026-11-10", bundles=self.dir / "bundles", api="http://127.0.0.1:1")

    def tearDown(self):
        self.lei.close_all()
        self.env.stop()
        super().tearDown()

    def build(self, tipo, where="1", p=()):
        row = self.rows("tipo = ? AND " + where, (tipo, *p))[0]
        b = self.bundle.build(self.ctx, [row["id"]])
        facts = json.loads((b["dir"] / "facts.json").read_text(encoding="utf-8"))
        hrefs = json.loads((b["dir"] / "fontes.json").read_text(encoding="utf-8"))["hrefs_permitidos"]
        self.assertEqual(self.run.stage_for(b), "redacao_agregado")
        self.assertFalse(b["lei"])
        return b, facts, hrefs

    def test_agenda(self):
        b, facts, hrefs = self.build("agenda_semana", "data_evento = ?", (TODAY,))
        ag = facts["agregado"]
        self.assertEqual((ag["total"], ag["contagens"]), (3, {"plenario": 1, "comissoes": 2, "outros": 0}))
        self.assertEqual(ag["janela"], {"de": "2026-11-10", "ate": "2026-11-16"})
        self.assertEqual(ag["por_dia"], {"2026-11-10": 2, "2026-11-12": 1})
        self.assertIn("#/calendario", hrefs)
        art = {"titulo": "Três eventos agendados no Parlamento", "lead": "O Parlamento tem 3 eventos agendados.", "corpo": "Há 1 sessão de plenário e 2 reuniões de comissões entre 10 e 16 de novembro de 2026.",
               "pontos_chave": ["3 eventos", "1 plenário", "2 comissões"], "fontes": [{"label": "Calendário", "href": "#/calendario"}], "numeros_citados": ["3", "1", "2"], "calculos": [], "entidades": [], "confianca": 0.9}
        import verify
        self.assertTrue(verify.verify(art, b["dir"], self.ctx.cfg)["ok"])

    def test_leis_em_curso(self):
        b, facts, hrefs = self.build("leis_em_curso_dia", "data_evento = ?", (DAY,))
        ag = facts["agregado"]
        self.assertEqual((ag["total"], ag["iniciativas"], ag["contagens"]), (3, 2, {"Discussão": 2, "Votação": 1}))
        self.assertIn("#/leis/XVII%2FPL%2F11", hrefs)
        self.assertEqual({i["iniciativa"] for i in ag["itens"]}, {"Projeto de Lei n.º 11/XVII", "Projeto de Lei n.º 12/XVII"})

    def test_presidencia_dia_with_news(self):
        b, facts, hrefs = self.build("presidencia_dia", "data_evento = ?", (DAY,))
        dia = facts["dia"]
        self.assertEqual((dia["total"], dia["contagens"], dia["noticias_total"]), (1, {"promulgacao": 1}, 2))
        self.assertIn("https://presidencia.pt/n/1", hrefs)
        self.assertNotIn("https://outro.pt/n/9", hrefs)
        b2, facts2, _ = self.build("presidencia_dia", "data_evento = ?", ("2026-11-07",))
        self.assertEqual((facts2["dia"]["total"], facts2["dia"]["noticias_total"], facts2["dia"]["atos"]), (0, 1, []))

    def test_governo_cm(self):
        b, facts, hrefs = self.build("governo_cm", "titulo LIKE '%taxas%'")
        ag = facts["agregado"]
        self.assertEqual(ag["total"], 2)
        self.assertEqual({i["ministerio"] for i in ag["itens"]}, {"economia", "financas"})
        self.assertIn("#/ministerios/financas", hrefs)

    def test_contratos_destaque_masks_private_sellers(self):
        b, facts, hrefs = self.build("contratos_destaque_dia")
        ag = facts["agregado"]
        self.assertEqual((ag["total_contratos_dia"], ag["contagens"]), (4, {"valor_atipico": 3, "ajuste_direto": 1, "proposta_unica": 1}))
        by = {i["rota"]: i for i in ag["itens"]}
        self.assertEqual(by["#/contrato/c1"]["vezes_a_media_do_comprador"], 8.0)
        self.assertEqual(by["#/contrato/c1"]["motivos"], ["valor_atipico"])
        self.assertEqual(by["#/contrato/c2"]["motivos"], ["valor_atipico", "ajuste_direto"])
        self.assertIn("identidade omitida", by["#/contrato/c2"]["fornecedor"])
        self.assertNotIn("Fornecedor c2", json.dumps(facts, ensure_ascii=False))
        self.assertNotIn(PRIV, json.dumps(facts, ensure_ascii=False))
        self.assertEqual(by["#/contrato/c3"]["concorrentes"], 1)
        self.assertIn("#/contrato/c1", hrefs)

    def test_acordao(self):
        b, facts, hrefs = self.build("acordao_constitucional")
        ag = facts["agregado"]
        self.assertEqual((ag["processo"], ag["resultado"], ag["relator"]), ("123/2026", "Declarada inconstitucionalidade", "Conselheira Exemplo"))
        self.assertIn("https://tribunalconstitucional.pt/ac/tc1", hrefs)

    def test_fundos_masks_private_beneficiaries(self):
        b, facts, hrefs = self.build("fundos_dia")
        ag = facts["agregado"]
        self.assertEqual((ag["total"], ag["aprovado_total_texto"], ag["contagens"]), (2, "12 000 euros", {"FSE": 1, "FEDER": 1}))
        txt = json.dumps(facts, ensure_ascii=False)
        self.assertNotIn("Pessoa Singular", txt)
        self.assertIn("Entidade Nova", txt)

    def test_poder_local_variants(self):
        b, facts, _ = self.build("poder_local_dia", "fonte_ref LIKE 'pmp:%'")
        ag = facts["agregado"]
        self.assertEqual((ag["subtipo"], ag["total"], ag["media_dias"], ag["itens"][0]["municipio"]), ("prazo_medio_pagamento", 1, 40, "Município B"))
        b, facts, _ = self.build("poder_local_dia", "fonte_ref LIKE 'fin:%'")
        self.assertEqual((facts["agregado"]["subtipo"], facts["agregado"]["municipios_listados"]), ("contas_municipais", ["Município A"]))
        b, facts, _ = self.build("poder_local_dia", "fonte_modulo = 'empresas_locais'")
        self.assertEqual(facts["agregado"]["itens"][0]["empresa"], "Águas Municipais")

    def test_regioes(self):
        b, facts, hrefs = self.build("regioes_dia")
        ag = facts["agregado"]
        self.assertEqual((ag["regiao"], ag["total"], ag["contagens"]), ("acores", 2, {"Decreto Legislativo Regional": 1, "Portaria": 1}))
        self.assertIn("#/regioes/acores", hrefs)

    def test_stale_events_excluded_from_fallback_shortlist(self):
        con = sqlite3.connect(self.dir / "diario.db")
        con.execute("UPDATE eventos SET data_evento = '2026-10-01', edicao_data = '2026-11-10' WHERE tipo = 'regioes_dia'")
        con.commit()
        con.close()
        with mock.patch.dict(os.environ, {"AI_NO_LEDGER_SCRIPT": "1"}):
            tipos = {r["tipo"] for r in self.bundle.shortlist(self.ctx)}
        self.assertNotIn("regioes_dia", tipos)
        self.assertIn("agenda_semana", tipos)


if __name__ == "__main__":
    unittest.main()
