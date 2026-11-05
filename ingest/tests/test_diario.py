import datetime as dt
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "jobs"))
import diario as J  # noqa: E402
import diario_score as S  # noqa: E402


def utc(y, m, d, h=12, mi=0):
    return J.local_to_utc(dt.datetime(y, m, d, h, mi))


def mk(path, ddl, rows):
    con = sqlite3.connect(path)
    for stmt in ddl:
        con.execute(stmt)
    for table, row in rows:
        con.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
    con.commit()
    con.close()


VOTOS = "CREATE TABLE votos (id INTEGER PRIMARY KEY, bid INTEGER, data TEXT, fase TEXT, orgao TEXT, resultado TEXT, unanime INTEGER, favor TEXT, contra TEXT, abstencao TEXT, source_url TEXT)"
INIS = "CREATE TABLE iniciativas (bid INTEGER PRIMARY KEY, tipo TEXT, numero INTEGER, leg TEXT, titulo TEXT, autoria TEXT, data_entrada TEXT, source_url TEXT)"
CONTRACTS = "CREATE TABLE contracts (id INTEGER PRIMARY KEY, published TEXT, signed TEXT, price REAL, procedure TEXT, buyer_name TEXT, seller_name TEXT, buyer_nif TEXT, seller_nif TEXT, object TEXT, n_sellers INTEGER, link TEXT)"
VETOS = "CREATE TABLE vetos (id INTEGER PRIMARY KEY, data TEXT, motivo TEXT, titulo TEXT, desfecho TEXT, decreto_ref TEXT, mensagem_url TEXT, source_url TEXT)"
PARTIES = "CREATE TABLE parties (code TEXT PRIMARY KEY, seats INTEGER)"
RISK = "CREATE TABLE entity_risk (nif TEXT, score REAL)"
BODIES = "CREATE TABLE bodies (slug TEXT PRIMARY KEY, short TEXT, name TEXT, nif TEXT)"
DECISIONS = "CREATE TABLE decisions (id TEXT PRIMARY KEY, body TEXT, kind TEXT, ref TEXT, date TEXT, title TEXT, subject TEXT, amount REAL, amount_note TEXT, url TEXT, source_url TEXT)"
IGF = "CREATE TABLE reports (code TEXT PRIMARY KEY, title TEXT, kind TEXT, entity_name TEXT, entity_nif TEXT, subject TEXT, report_url TEXT, source_url TEXT)"


def contract(i, published, price, proc="Concurso público", buyer="9001", seller="9002"):
    return ("contracts", {"id": i, "published": published, "signed": published, "price": price, "procedure": proc, "buyer_name": "Câmara A", "seller_name": "Empresa B",
                          "buyer_nif": buyer, "seller_nif": seller, "object": "Obra", "n_sellers": 1})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        mk(self.dir / "politica.db", [PARTIES, CONTRACTS], [
            ("parties", {"code": "PS", "seats": 58}), ("parties", {"code": "PSD", "seats": 91}), ("parties", {"code": "CH", "seats": 60}),
            contract(1, "2026-11-08", 120000.0), contract(2, "2026-11-08", 25000.0, "Ajuste Direto Regime Geral"),
            contract(3, "2026-11-08", 900.0), contract(4, "2026-11-08", 1500.0, "Ajuste Direto Regime Geral")])
        mk(self.dir / "votacoes.db", [VOTOS, INIS], [
            ("iniciativas", {"bid": 1, "tipo": "Projeto de Lei", "numero": 10, "leg": "XVII", "titulo": "Altera o regime X", "autoria": "PS", "data_entrada": "2026-11-01"}),
            ("votos", {"id": 1, "bid": 1, "data": "2026-11-08", "fase": "Votação final global", "orgao": "Plenário", "resultado": "Rejeitado", "unanime": 0, "favor": "PS", "contra": "CH", "abstencao": ""}),
            ("votos", {"id": 2, "bid": 1, "data": "2026-11-08", "fase": "Votação na generalidade", "orgao": "Comissão", "resultado": "Aprovado", "unanime": 1, "favor": "PS", "contra": "", "abstencao": ""})])
        mk(self.dir / "presidencia.db", [VETOS], [("vetos", {"id": 1, "data": "2026-11-08", "motivo": "politico", "titulo": "Decreto Y", "desfecho": "reformulado", "decreto_ref": "1/XVII"})])
        mk(self.dir / "risco.db", [RISK], [("entity_risk", {"nif": "9002", "score": 8.0})])
        self.now = utc(2026, 11, 9, 12)

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, now=None, **kw):
        return J.run(self.dir, self.dir, now or self.now, **kw)

    def rows(self, sql="SELECT * FROM eventos ORDER BY id", p=()):
        con = sqlite3.connect(self.dir / "diario.db")
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, p)]
        finally:
            con.close()


class TestScore(unittest.TestCase):
    def test_base_values(self):
        self.assertEqual(S.score("veto"), 90)
        self.assertEqual(S.score("promulgacao"), 60)
        self.assertEqual(S.score("auditoria_tc"), 55)
        self.assertEqual(S.score("nomeacao_conselho"), 40)
        self.assertEqual(S.score("debate"), 25)
        self.assertEqual(S.score("qualquer_outro"), 10)

    def test_final_vote_bonuses(self):
        self.assertEqual(S.score("votacao_final"), 80)
        self.assertEqual(S.score("votacao_final", narrow=True), 95)
        self.assertEqual(S.score("votacao_final", rejected=True), 90)
        self.assertEqual(S.score("votacao_final", narrow=True, rejected=True), 105)
        self.assertEqual(S.score("votacao", narrow=True, rejected=True), 10)

    def test_amount_log(self):
        self.assertAlmostEqual(S.score("sancao_regulador", amount=1000000), 56.0)
        self.assertAlmostEqual(S.score("contrato_grande", amount=100000), 25.0)
        self.assertEqual(S.score("sancao_regulador", amount=None), 50)

    def test_bonuses_and_lag(self):
        self.assertEqual(S.score("veto", risk=True), 100)
        self.assertEqual(S.score("veto", first=True), 100)
        self.assertEqual(S.score("veto", lag_days=2), 90)
        self.assertEqual(S.score("veto", lag_days=5), 75)
        self.assertEqual(S.score("outro", lag_days=40), 0)

    def test_narrow(self):
        self.assertTrue(S.is_narrow(10))
        self.assertFalse(S.is_narrow(11))
        self.assertFalse(S.is_narrow(None))

    def test_select_shortlist(self):
        rows = [{"id": i, "secao": "dinheiro" if i < 10 else "governo", "score": 50 - i} for i in range(20)]
        ids = S.select_shortlist(rows, n=25, per_section=6)
        self.assertEqual(len(ids), 12)
        self.assertEqual(ids[0], 0)
        self.assertEqual(len([i for i in ids if i < 10]), 6)
        self.assertEqual(len(S.select_shortlist(rows, n=5, per_section=6)), 5)
        tie = [{"id": 3, "secao": "a", "score": 1}, {"id": 2, "secao": "a", "score": 1}]
        self.assertEqual(S.select_shortlist(tie), [2, 3])


class TestClock(unittest.TestCase):
    def test_lisbon_offset(self):
        self.assertEqual(J.lisbon_offset(dt.datetime(2026, 11, 6, 12)), 0)
        self.assertEqual(J.lisbon_offset(dt.datetime(2026, 7, 1, 12)), 1)
        self.assertEqual(J.close_utc(dt.date(2026, 7, 1)), dt.datetime(2026, 7, 2, 5, 0))
        self.assertEqual(J.close_utc(dt.date(2026, 11, 6)), dt.datetime(2026, 11, 7, 6, 0))

    def test_numero(self):
        self.assertEqual(J.numero(dt.date(2026, 11, 6)), 1)
        self.assertEqual(J.numero(dt.date(2026, 11, 16)), 11)


class TestLedger(Base):
    def test_first_run_builds_events(self):
        res = self.run_job()
        self.assertEqual(res["fontes_ignoradas"].count("justica"), 1)
        ev = {r["tipo"]: r for r in self.rows()}
        self.assertEqual(set(ev), {"votacao_final", "veto", "contrato_grande", "contrato_ajuste_direto", "contratos_resumo"})
        self.assertEqual(ev["veto"]["edicao_data"], "2026-11-09")
        self.assertEqual(ev["veto"]["atrasado"], 0)
        self.assertEqual(ev["veto"]["secao"], "governo")
        self.assertIn("rejeita", ev["votacao_final"]["titulo"])
        self.assertEqual(ev["contrato_grande"]["score"], round(20 + 5.0791812 + 10, 4))
        self.assertEqual(ev["contratos_resumo"]["secao"], "dinheiro")
        self.assertIn("2", ev["contratos_resumo"]["titulo"])
        self.assertEqual(len(self.rows()), 5)
        for r in self.rows():
            self.assertIn(r["secao"], S.SECTIONS)
            json.loads(r["entidades"])

    def test_final_vote_score(self):
        self.run_job()
        r = [x for x in self.rows() if x["tipo"] == "votacao_final"][0]
        self.assertEqual(r["score"], 80 + 15 + 10)

    def test_idempotent(self):
        self.run_job()
        before = self.rows()
        eds = self.rows("SELECT * FROM edicoes")
        cur = self.rows("SELECT * FROM cursores")
        res = self.run_job()
        self.assertEqual(res["inseridos"], {})
        self.assertEqual(res["atualizados"], 0)
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.rows("SELECT * FROM edicoes"), eds)
        self.assertEqual(self.rows("SELECT * FROM cursores"), cur)

    def test_hash_is_sha1_of_key(self):
        self.run_job()
        r = [x for x in self.rows() if x["tipo"] == "veto"][0]
        import hashlib
        self.assertEqual(r["hash"], hashlib.sha1(b"presidencia|1|veto|2026-11-08").hexdigest())

    def test_revision_bumps_only_on_change_while_open(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("UPDATE vetos SET titulo = 'Decreto Y revisto'")
        con.commit()
        con.close()
        res = self.run_job(self.now + dt.timedelta(hours=1))
        self.assertEqual(res["atualizados"], 1)
        r = [x for x in self.rows() if x["tipo"] == "veto"][0]
        self.assertEqual(r["revisao"], 2)
        self.assertIn("revisto", r["titulo"])
        self.run_job(self.now + dt.timedelta(hours=2))
        self.assertEqual([x for x in self.rows() if x["tipo"] == "veto"][0]["revisao"], 2)

    def test_closed_edition_is_frozen_and_late_rows_move_on(self):
        self.run_job()
        late = utc(2026, 11, 10, 7, 30)
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("UPDATE vetos SET titulo = 'Alterado depois do fecho'")
        con.execute("INSERT INTO vetos (id, data, motivo, titulo, decreto_ref) VALUES (2, '2026-11-08', 'tc', 'Decreto Z', '2/XVII')")
        con.commit()
        con.close()
        self.run_job(late)
        vetos = [x for x in self.rows() if x["tipo"] == "veto"]
        old = [v for v in vetos if v["fonte_ref"] == "1"][0]
        new = [v for v in vetos if v["fonte_ref"] == "2"][0]
        self.assertEqual(old["titulo"], "Presidente da República veta: Decreto Y")
        self.assertEqual(old["revisao"], 1)
        self.assertEqual(new["edicao_data"], "2026-11-10")
        self.assertEqual(new["atrasado"], 1)
        self.assertIn("ocorreu a 8 de novembro", new["titulo"])
        self.assertIn("Ocorreu a 8 de novembro de 2026", new["resumo_curto"])
        self.assertEqual(new["ingerido_em"], "2026-11-10T07:30:00Z")
        self.assertEqual(new["score"], 100)

    def test_lag_penalty_in_score(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("INSERT INTO vetos (id, data, motivo, titulo, decreto_ref) VALUES (3, '2026-11-07', 'tc', 'Antigo', '3/XVII')")
        con.commit()
        con.close()
        self.run_job(utc(2026, 11, 12, 12))
        r = [x for x in self.rows() if x["fonte_ref"] == "3"][0]
        self.assertEqual(r["edicao_data"], "2026-11-12")
        self.assertEqual(r["atrasado"], 1)
        self.assertEqual(r["score"], 100 - 5 * 2)

    def test_edicoes_numbering_and_closing(self):
        self.run_job(utc(2026, 11, 8, 12))
        self.run_job()
        eds = {r["data"]: r for r in self.rows("SELECT * FROM edicoes")}
        self.assertEqual(eds["2026-11-06"]["numero"], 1)
        self.assertEqual(eds["2026-11-09"]["numero"], 4)
        self.assertEqual(eds["2026-11-07"]["estado"], "fechada")
        self.assertEqual(eds["2026-11-07"]["fechada_em"], "2026-11-08T06:00:00Z")
        self.assertEqual(eds["2026-11-08"]["estado"], "fechada" if utc(2026, 11, 9, 6) <= self.now else "preliminar")
        self.assertEqual(eds["2026-11-09"]["estado"], "preliminar")
        self.assertIsNone(eds["2026-11-09"]["fechada_em"])
        self.assertNotIn("2026-11-05", eds)

    def test_not_closed_before_0600(self):
        self.run_job(utc(2026, 11, 10, 5, 59))
        eds = {r["data"]: r["estado"] for r in self.rows("SELECT * FROM edicoes")}
        self.assertEqual(eds["2026-11-09"], "preliminar")
        self.run_job(utc(2026, 11, 10, 6, 0))
        eds = {r["data"]: r["estado"] for r in self.rows("SELECT * FROM edicoes")}
        self.assertEqual(eds["2026-11-09"], "fechada")

    def test_floor_rules(self):
        res = self.run_job(utc(2026, 11, 5, 12))
        self.assertEqual(self.rows(), [])
        self.assertGreaterEqual(res["ignorados"], 1)
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("INSERT INTO vetos (id, data, motivo, titulo, decreto_ref) VALUES (9, '2026-11-03', 'tc', 'Anterior ao limiar', '9/XVII')")
        con.commit()
        con.close()
        self.run_job(utc(2026, 11, 6, 12))
        r = [x for x in self.rows() if x["fonte_ref"] == "9"]
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["edicao_data"], "2026-11-06")
        self.assertEqual(r[0]["atrasado"], 1)
        self.assertIn("ocorreu a 3 de novembro", r[0]["titulo"])
        self.assertEqual([x for x in self.rows() if x["fonte_ref"] == "1" and x["tipo"] == "veto"], [])

    def test_backfilled_old_row_uses_cursor(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("INSERT INTO vetos (id, data, motivo, titulo, decreto_ref) VALUES (5, '2026-10-20', 'tc', 'Muito antigo', '5/XVII')")
        con.commit()
        con.close()
        self.run_job(self.now + dt.timedelta(hours=1))
        r = [x for x in self.rows() if x["fonte_ref"] == "5"]
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["atrasado"], 1)
        self.assertEqual(r[0]["edicao_data"], "2026-11-09")

    def test_first_run_ignores_old_history(self):
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("INSERT INTO vetos (id, data, motivo, titulo, decreto_ref) VALUES (6, '2026-06-01', 'tc', 'Historico', '6/XVII')")
        con.commit()
        con.close()
        self.run_job()
        self.assertEqual([x for x in self.rows() if x["fonte_ref"] == "6"], [])

    def test_risk_bonus_and_first_of_kind(self):
        self.run_job()
        r = [x for x in self.rows() if x["tipo"] == "contrato_grande"][0]
        self.assertAlmostEqual(r["score"], round(20 + 5.0791812 + 10, 4))
        v = [x for x in self.rows() if x["tipo"] == "veto"][0]
        self.assertEqual(v["score"], 100)

    def test_direct_award_threshold(self):
        self.run_job()
        refs = {r["fonte_ref"] for r in self.rows() if r["fonte_modulo"] == "politica" and r["tipo"] != "contratos_resumo"}
        self.assertEqual(refs, {"1", "2"})
        s = [r for r in self.rows() if r["tipo"] == "contratos_resumo"][0]
        self.assertEqual(s["fonte_ref"], "2026-11-08")
        self.assertIn("2", s["resumo_curto"])

    def test_summary_row_updates_when_open(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "politica.db")
        con.execute("INSERT INTO contracts (id, published, signed, price, procedure, buyer_name, seller_name, buyer_nif, seller_nif, object, n_sellers) VALUES (50, '2026-11-08', '2026-11-08', 100, 'Concurso', 'A', 'B', '1', '2', 'x', 1)")
        con.commit()
        con.close()
        res = self.run_job(self.now + dt.timedelta(hours=1))
        self.assertEqual(res["atualizados"], 1)
        s = [r for r in self.rows() if r["tipo"] == "contratos_resumo"][0]
        self.assertEqual(s["revisao"], 2)

    def test_igf_undated_new_rows_only(self):
        mk(self.dir / "igf.db", [IGF], [("reports", {"code": "2026/1", "title": "Auditoria X", "kind": "municipio", "entity_name": "Município Y"})])
        self.run_job()
        self.assertEqual([r for r in self.rows() if r["fonte_modulo"] == "igf"], [])
        con = sqlite3.connect(self.dir / "igf.db")
        con.execute("INSERT INTO reports (code, title, kind, entity_name) VALUES ('2026/2', 'Auditoria Z', 'municipio', 'Município W')")
        con.commit()
        con.close()
        self.run_job(self.now + dt.timedelta(hours=1))
        self.run_job(self.now + dt.timedelta(hours=2))
        r = [x for x in self.rows() if x["fonte_modulo"] == "igf"]
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["secao"], "poder-local")
        self.assertEqual(r[0]["edicao_data"], "2026-11-10")

    def test_regulator_sanction_and_board_nomination(self):
        mk(self.dir / "reguladores.db", [BODIES, DECISIONS], [
            ("bodies", {"slug": "adc", "short": "AdC", "name": "Autoridade da Concorrência", "nif": "5065"}),
            ("decisions", {"id": "a1", "body": "adc", "kind": "sancao", "date": "2026-11-08", "title": "AdC sanciona empresa", "amount": 1000000.0}),
            ("decisions", {"id": "a2", "body": "adc", "kind": "deliberacao", "date": "2026-11-08", "title": "Deliberação"})])
        mk(self.dir / "responsaveis.db", ["CREATE TABLE nomeacoes (id INTEGER PRIMARY KEY, action TEXT, person TEXT, role TEXT, entity TEXT, entity_nif TEXT, date TEXT, act TEXT, source_url TEXT)"], [
            ("nomeacoes", {"id": 1, "action": "nomeação", "person": "Fulano", "role": "Vogal do Conselho de Administração", "entity": "CP, E.P.E.", "date": "2026-11-08"}),
            ("nomeacoes", {"id": 2, "action": "nomeação", "person": "Beltrano", "role": "Adjunto", "entity": None, "date": "2026-11-08"})])
        self.run_job()
        by = {(r["tipo"], r["fonte_ref"]): r for r in self.rows()}
        self.assertEqual(by[("sancao_regulador", "a1")]["score"], round(50 + 6 + 10, 4))
        self.assertEqual(by[("decisao_regulador", "a2")]["score"], 10)
        self.assertEqual(by[("nomeacao_conselho", "1")]["score"], 40)
        self.assertEqual(by[("nomeacao", "2")]["score"], 10)
        self.assertEqual(by[("nomeacao", "2")]["secao"], "nomeacoes")

    def test_tolerates_missing_dbs_and_columns(self):
        (self.dir / "presidencia.db").unlink()
        (self.dir / "risco.db").unlink()
        con = sqlite3.connect(self.dir / "votacoes.db")
        con.execute("DROP TABLE iniciativas")
        con.execute("ALTER TABLE votos DROP COLUMN unanime")
        con.commit()
        con.close()
        mk(self.dir / "justica.db", ["CREATE TABLE tcontas_docs (id INTEGER PRIMARY KEY, publicado TEXT)"], [("tcontas_docs", {"id": 1, "publicado": "2026-11-08"})])
        mk(self.dir / "dre.db", ["CREATE TABLE outra (x)"], [])
        res = self.run_job()
        self.assertIn("presidencia", res["fontes_ignoradas"])
        tipos = {r["tipo"] for r in self.rows()}
        self.assertIn("votacao", tipos)
        self.assertIn("contrato_grande", tipos)
        self.assertNotIn("veto", tipos)

    def test_empty_data_dir(self):
        with tempfile.TemporaryDirectory() as d:
            res = J.run(d, d, self.now)
            self.assertEqual(res["inseridos"], {})
            self.assertTrue((Path(d) / "diario.db").exists())

    def test_schema_matches_contract(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "diario.db")
        cols = [r[1] for r in con.execute("PRAGMA table_info(eventos)")]
        self.assertEqual(cols, ["id", "hash", "data_evento", "ingerido_em", "edicao_data", "secao", "tipo", "titulo", "resumo_curto", "fonte_modulo", "fonte_ref",
                                "rota", "source_url", "entidades", "score", "revisao", "atrasado", "ia_artigo_id"])
        self.assertEqual([r[1] for r in con.execute("PRAGMA table_info(artigos_ia)")][:4], ["id", "edicao_data", "evidence_hash", "evento_ids"])
        self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        con.close()

    def test_rebuild_edition(self):
        self.run_job()
        con = sqlite3.connect(self.dir / "presidencia.db")
        con.execute("UPDATE vetos SET titulo = 'Reconstruído'")
        con.commit()
        con.close()
        res = self.run_job(self.now + dt.timedelta(hours=1), rebuild="2026-11-09")
        self.assertEqual(res["atualizados"], 1)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM eventos")[0]["n"], 5)
        closed = self.run_job(utc(2026, 11, 11, 12), rebuild="2026-11-09")
        self.assertEqual(closed["codigo"], 2)

    def test_shortlist_from_db(self):
        self.run_job()
        ids = S.shortlist("2026-11-09", n=3, per_section=6, con=sqlite3.connect(self.dir / "diario.db"))
        self.assertEqual(len(ids), 3)
        top = self.rows("SELECT id FROM eventos ORDER BY score DESC, id LIMIT 1")[0]["id"]
        self.assertEqual(ids[0], top)
        self.assertEqual(S.shortlist("2030-01-01", con=sqlite3.connect(self.dir / "diario.db")), [])


if __name__ == "__main__":
    unittest.main()
