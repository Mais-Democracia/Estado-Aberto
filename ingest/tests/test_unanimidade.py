import gzip
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path[:0] = [str(ROOT / "ops" / "ai"), str(ROOT / "ingest"), str(ROOT / "ingest" / "jobs")]

PAGE = """
<a id="x_ctl00_ucLinkDocumento_hplDocumentoPDF" class="a" href="https://app.parlamento.pt/webutils/docs/doc.pdf?path=AAA&amp;fich=ini.pdf&amp;Inline=true">pdf</a>
<span id="x_ctl00_ucLinkDocumento_lblDocumentoTitulo">Titulo da iniciativa</span>
<a id="y_rptAnexos_ctl00_ucLinkAnexo_hplDocumentoDOC" href="https://app.parlamento.pt/webutils/docs/doc.docx?path=BBB&amp;fich=n.docx">doc</a>
<span id="y_rptAnexos_ctl00_ucLinkAnexo_lblDocumentoTitulo" class="t">Nota de Admissibilidade</span>
<a id="y_rptAnexos_ctl00_ucLinkAnexo_hplDocumentoPDF" href="https://app.parlamento.pt/webutils/docs/doc.pdf?path=BBB&amp;fich=n.pdf">pdf</a>
<a id="z_ucActividadeComissao_rptDocumentos_ctl01_hlDocumentos" class="TextoRegular" href="https://app.parlamento.pt/webutils/docs/doc.pdf?path=CCC&amp;fich=t.pdf">&nbsp;&nbsp;Texto Final</a>
<a id="z_ucActividadeComissao_rptDocumentos_ctl03_hlDocumentos" class="TextoRegular" href="https://app.parlamento.pt/webutils/docs/doc.pdf?path=DDD&amp;fich=r.pdf">&nbsp;&nbsp;Requerimento CH (versão substituída)</a>
"""


class Anexos(unittest.TestCase):
    def setUp(self):
        import migrations
        import votacoes
        self.m, self.v = migrations, votacoes

    def test_parse_anexos_types_and_pdf_preference(self):
        rows = {n: (t, u) for n, t, u in self.v.parse_anexos(PAGE)}
        self.assertEqual(rows["Texto Inicial"][0], "texto_inicial")
        self.assertEqual(rows["Texto Final"][0], "texto_final")
        self.assertEqual(rows["Nota de Admissibilidade"][0], "outro")
        self.assertIn("doc.pdf", rows["Nota de Admissibilidade"][1])
        self.assertIn("fich=n.pdf", rows["Nota de Admissibilidade"][1])
        self.assertEqual(rows["Requerimento CH (versão substituída)"][0], "outro")

    def test_migration_is_idempotent_and_store_replaces(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE iniciativas (bid INTEGER, leg_fim TEXT, transitou INTEGER, data_ultima TEXT)")
        con.execute("CREATE TABLE fases (bid INTEGER, diploma_bid INTEGER)")
        con.execute("CREATE TABLE votos (bid INTEGER, inconsistente INTEGER)")
        self.m.ensure_votacoes(con)
        self.m.ensure_votacoes(con)
        con.execute("INSERT INTO iniciativas (bid) VALUES (7)")
        self.assertEqual(self.v.store_anexos(con, 7, PAGE), 4)
        self.assertEqual(self.v.store_anexos(con, 7, PAGE), 4)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM iniciativa_anexos WHERE bid=7").fetchone()[0], 4)
        self.assertIsNotNone(con.execute("SELECT anexos_at FROM iniciativas WHERE bid=7").fetchone()[0])


def votacoes_db(path):
    v = sqlite3.connect(path)
    v.executescript("""
CREATE TABLE iniciativas(bid INTEGER PRIMARY KEY, key TEXT, tipo TEXT, numero INTEGER, leg TEXT, titulo TEXT, autoria TEXT, origem TEXT, data_entrada TEXT, estado TEXT, ultima_fase TEXT,
 resultado_final TEXT, data_votacao_final TEXT, lei_ref TEXT, dr_ref TEXT, dr_date TEXT, dre_act_id TEXT, source_url TEXT);
CREATE TABLE autores(bid INTEGER, dep_bid INTEGER, nome TEXT, partido TEXT);
CREATE TABLE fases(bid INTEGER, ord INTEGER, data TEXT, fase TEXT, comissao TEXT);
CREATE TABLE votos(id INTEGER PRIMARY KEY, bid INTEGER, data TEXT, fase TEXT, orgao TEXT, resultado TEXT, unanime INTEGER, favor TEXT, contra TEXT, abstencao TEXT);
CREATE TABLE voto_partido(voto_id INTEGER, partido TEXT, sentido TEXT, kind TEXT, nome TEXT, n INTEGER);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE iniciativa_anexos(bid INTEGER, nome TEXT, tipo TEXT, url TEXT);
INSERT INTO iniciativas VALUES(1,'Projeto de Lei|285|XVII','Projeto de Lei',285,'XVII','Reposicionamento','Cidadãos','Cidadãos','2025-10-20','Aprovado','Votação final global','Aprovado por unanimidade','2026-10-09',NULL,NULL,NULL,NULL,NULL);
INSERT INTO fases VALUES(1,0,'2025-10-20','Entrada',NULL);
INSERT INTO votos VALUES(10,1,'2026-06-12','Votação na generalidade','Plenário','Aprovado',0,'CH, PS','PSD','IL');
INSERT INTO votos VALUES(11,1,'2026-10-09','Votação final global','Plenário','Aprovado por unanimidade',1,NULL,NULL,NULL);
INSERT INTO voto_partido VALUES(10,'CH','favor','gp',NULL,NULL),(10,'PS','favor','gp',NULL,NULL),(10,'PSD','contra','gp',NULL,NULL),(10,'IL','abstencao','gp',NULL,NULL),(11,'PAN','ausencia','gp',NULL,NULL);
INSERT INTO iniciativa_anexos VALUES(1,'Texto Inicial','texto_inicial','file:///nonexistent/doc.pdf');
""")
    v.commit()
    v.close()
    p = sqlite3.connect(Path(path).parent / "politica.db")
    p.executescript("CREATE TABLE parties(code TEXT, name TEXT, seats INTEGER); INSERT INTO parties VALUES('PSD','x',89),('CH','x',60),('PS','x',58),('IL','x',9),('L','x',6),('PCP','x',3),('CDS–PP','x',2),('B.E.','x',1),('PAN','x',1),('JPP','x',1);")
    p.commit()
    p.close()


class Lei(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name)
        votacoes_db(self.src / "votacoes.db")
        os.environ["ESTADO_ABERTO_SOURCE_DATA"] = str(self.src)
        import lei
        self.lei = lei

    def tearDown(self):
        self.lei.close_all()
        os.environ.pop("ESTADO_ABERTO_SOURCE_DATA", None)
        self.tmp.cleanup()

    def build(self):
        return self.lei.build_lei({"fonte_modulo": "votacoes", "fonte_ref": "11", "tipo": "votacao_final"})

    def test_unanimous_final_vote_expands_to_all_groups_except_absent(self):
        facts, blocos = self.build()
        v = blocos["votacao"]
        self.assertTrue(v["unanime"])
        senses = {p["partido"]: p["voto"] for p in v["por_partido"]}
        self.assertEqual(senses["PAN"], "ausencia")
        self.assertEqual({k for k, s in senses.items() if s == "favor"}, {"PSD", "CH", "PS", "IL", "L", "PCP", "CDS-PP", "BE", "JPP"})
        self.assertEqual(v["totais"], {"favor": 229, "contra": 0, "abstencao": 0})
        main = [x for x in facts["votacoes"] if x["id"] == 11][0]
        self.assertTrue(main["unanimidade_expandida"])

    def test_earlier_votes_are_kept(self):
        _, blocos = self.build()
        ant = blocos["votacoes_anteriores"]
        self.assertEqual(len(ant), 1)
        self.assertEqual(ant[0]["fase"], "Votação na generalidade")
        self.assertEqual({(p["partido"], p["voto"]) for p in ant[0]["por_partido"]}, {("CH", "favor"), ("PS", "favor"), ("PSD", "contra"), ("IL", "abstencao")})
        self.assertEqual(blocos["lei"]["origem"], "Cidadãos")

    def test_non_unanimous_vote_is_not_expanded(self):
        facts, _ = self.build()
        gen = [x for x in facts["votacoes"] if x["id"] == 10][0]
        self.assertFalse(gen["unanimidade_expandida"])
        self.assertEqual(len(gen["por_partido"]), 4)

    def test_annex_text_preferred_and_named(self):
        doc = self.src / "annex" / "doc.pdf"
        doc.parent.mkdir()
        doc.write_text("Artigo primeiro do texto final aprovado.", encoding="utf-8")
        con = sqlite3.connect(self.src / "votacoes.db")
        con.execute("INSERT INTO iniciativa_anexos VALUES(1,'Texto Final','texto_final',?)", (doc.as_uri(),))
        con.commit()
        con.close()
        facts, _ = self.build()
        self.assertEqual([a["tipo"] for a in facts["anexos"]], ["texto_inicial", "texto_final"])
        import lib
        os.environ["AI_ALLOW_FILE"] = "1"
        try:
            txt, origem, url = self.lei.fetch_law_text(facts, lib.load_config(), self.src)
        finally:
            os.environ.pop("AI_ALLOW_FILE", None)
        self.assertIn("texto final aprovado", txt)
        self.assertIn("Texto Final", origem)
        self.assertEqual(url, doc.as_uri())


class Honestidade(unittest.TestCase):
    def setUp(self):
        import lib
        import verify
        self.verify, self.cfg = verify, lib.load_config()
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def bundle(self, com_dados):
        d = Path(self.tmp.name)
        lei = {"texto_disponivel": False, "iniciativa": {"titulo": "Altera a lei de teste"}, "fases": [{"data": "2026-05-01", "fase": "Entrada"}] if com_dados else [],
               "votacoes": [{"por_partido": [{"partido": "PS", "sentido": "favor"}]}] if com_dados else [], "intervencoes": []}
        (d / "facts.json").write_text(json.dumps({"edicao_data": "2026-11-06", "eventos": [{"id": 1, "titulo": "Votação", "resumo_curto": "", "score": 9}], "relacionados": {"eventos_anteriores": [], "api": []}, "lei": lei}))
        (d / "fontes.json").write_text(json.dumps({"hrefs_permitidos": ["#/leis"]}))
        blocos = {"lei": None, "votacao": {"data": "2026-11-05", "resultado": "Aprovado", "totais": {"favor": 58, "contra": 0, "abstencao": 0}, "por_partido": [{"partido": "PS", "voto": "favor", "lugares": 58}]} if com_dados else None,
                  "votacoes_anteriores": [], "intervencoes": []}
        (d / "blocos.json").write_text(json.dumps(blocos))
        return d

    def art(self, corpo):
        return {"titulo": "Titulo de teste", "lead": "Lead de teste.", "corpo": corpo, "pontos_chave": ["a", "b", "c"], "fontes": [{"label": "x", "href": "#/leis"}],
                "numeros_citados": [], "calculos": [], "entidades": [], "confianca": 0.9,
                "explicacao": {"do_que_trata": "O texto da iniciativa não estava disponível.", "o_que_muda": []}}

    def problems(self, corpo, com_dados):
        return self.verify.verify(self.art(corpo), self.bundle(com_dados), self.cfg)["problemas"]

    def test_rejects_claims_of_missing_data_when_present(self):
        for frase in ("Não há dados sobre a votação.", "Sem dados de votação.", "Não existem votações registadas.", "Não há registo de votação.",
                      "Os dados disponíveis não incluem a votação.", "Não foi possível apurar o sentido de voto."):
            self.assertTrue(any(p.startswith("alega_falta_de_dados_existentes") for p in self.problems(frase, True)), frase)

    def test_accepts_when_truly_absent_and_plain_statements(self):
        self.assertFalse(any(p.startswith("alega_falta") for p in self.problems("Não há dados sobre a votação.", False)))
        self.assertFalse(any(p.startswith("alega_falta") for p in self.problems("O texto da iniciativa não estava disponível.", True)))

    def test_earlier_vote_claims_need_their_context(self):
        d = self.bundle(True)
        blocos = {"lei": None, "votacao": {"data": "2026-11-05", "resultado": "Aprovado por unanimidade", "unanime": True, "totais": {"favor": 58, "contra": 0, "abstencao": 0},
                                           "por_partido": [{"partido": "PSD", "voto": "favor", "lugares": 89}]},
                  "votacoes_anteriores": [{"data": "2026-06-12", "fase": "Votação na generalidade", "orgao": "Plenário", "resultado": "Aprovado",
                                           "por_partido": [{"partido": "PSD", "voto": "contra", "lugares": 89}], "totais": {"favor": 0, "contra": 89, "abstencao": 0}}], "intervencoes": []}
        (d / "blocos.json").write_text(json.dumps(blocos))
        ok = self.verify.verify(self.art("Na generalidade, o PSD votou contra."), d, self.cfg)["problemas"]
        self.assertFalse(any(p.startswith("voto_incoerente") for p in ok), ok)
        bad = self.verify.verify(self.art("O PSD votou contra."), d, self.cfg)["problemas"]
        self.assertTrue(any(p.startswith("voto_incoerente:PSD:contra") for p in bad), bad)


if __name__ == "__main__":
    unittest.main()
