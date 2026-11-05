"""Unit tests for ingest/jobs/deputados.py. Run: python3 ingest/tests/test_deputados.py
Everything here is a SYNTHETIC sample in the documented AR open-data shape (marcelogdomingues/parlamento-pt types.ts);
it is loaded into an in-memory DB and never touches data/deputados.db."""
import sqlite3
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "jobs"))
import deputados as J  # noqa: E402

SYN_DEPUTADOS = [  # synthetic: names are obviously fake
    {"CadId": 900001, "CadNomeCompleto": "Fulano de Tal Sintetico", "CadDeputadoLegis": [
        {"LegDes": "XVI", "DepNomeParlamentar": "Fulano Sintetico", "GpSigla": "PS", "CeDes": "Lisboa", "ParSigla": "PS"},
        {"LegDes": "XVII", "DepNomeParlamentar": "Fulano Sintetico", "GpSigla": "PSD", "CeDes": "Porto", "ParSigla": "PSD"}],
     "CadActividadeOrgaos": [{"OrgDes": "Comissao Teste", "CargoDes": "Vogal", "LegDes": "XVII"}]},
    {"CadId": 900002, "CadNomeCompleto": "Beltrana Ficticia", "CadDeputadoLegis": {"LegDes": "XVII", "DepNomeParlamentar": "Beltrana", "GpSigla": "CH", "CeDes": "Faro", "ParSigla": "CH"}},
]
SYN_INI = [{"IniId": 800001, "IniNr": "1", "IniLeg": "XVII", "IniTipo": "Projeto de Lei", "IniTitulo": "Titulo sintetico",
            "IniAutorDeputados": [{"idCadastro": "900001"}],
            "IniEventos": [{"Fase": "Votação na generalidade", "DataFase": "2026-01-02", "Votacao": [{"resultado": "Aprovado", "data": "2026-01-02"}]}]}]

BIO = """<div id="conteudo">Nome completo
<div>Maria Sintetica Teste</div>Data de nascimento<div>1980-01-02</div>Profissão<div>Jurista</div>
Comissões Parlamentares a que pertence<div>Comissão de Teste  [Vice-CGP]</div><div>Outra Comissão </div>Conteúdo da Página"""
PRES = """<div id="conteudo">2ª Sessão Legislativa - Plenário - Lista de reuniões
<p>Data</p><p>2026-10-27</p><p>Número</p><p>15</p><p>Tipo</p><p>Ordinária</p><p>Presença/Falta</p><p>Presença (P)</p>
<p>Data</p><p>2026-10-21</p><p>Número</p><p>14</p><p>Tipo</p><p>Ordinária</p><p>Presença/Falta</p><p>Falta justificada (FJ)</p>"""
ALT = """<div id="conteudo"><p>2026-10-26</p><p>Substituição de A B, por C D, Deputado(a) por Braga, Grupo Parlamentar do PSD, pelo motivo de: Suspensão</p>"""


class T(unittest.TestCase):
    def test_official_hook(self):
        con = sqlite3.connect(":memory:")
        con.executescript(J.SCHEMA)
        n = J.load_official(con, {"registo_biografico": SYN_DEPUTADOS, "iniciativas": SYN_INI})
        self.assertEqual(n, {"deputados": 2, "iniciativas": 1})
        r = con.execute("SELECT gp_sigla, circulo, legislatura FROM ar_deputado WHERE cad_id=900001").fetchone()
        self.assertEqual(r, ("PSD", "Porto", "XVII"))  # last legislature wins
        self.assertEqual(con.execute("SELECT gp_sigla FROM ar_deputado WHERE cad_id=900002").fetchone()[0], "CH")  # dict (single) form
        self.assertEqual(con.execute("SELECT orgao, cargo FROM ar_orgao").fetchone(), ("Comissao Teste", "Vogal"))
        self.assertEqual(con.execute("SELECT resultado FROM ar_votacao").fetchone()[0], "Aprovado")
        self.assertEqual(con.execute("SELECT COUNT(*) FROM deputados").fetchone()[0], 0)  # scraped tables untouched

    def test_parse_bio(self):
        b = J.parse_bio(BIO)
        self.assertEqual(b["full_name"], "Maria Sintetica Teste")
        self.assertEqual(b["committees"], [("Comissão de Teste", "Vice-CGP"), ("Outra Comissão", None)])

    def test_parse_attendance(self):
        a = J.parse_attendance(PRES)
        self.assertEqual([(x[1], x[2], x[5]) for x in a], [("2026-10-27", 15, "P"), ("2026-10-21", 14, "FJ")])
        self.assertEqual(a[0][0], 2)

    def test_parse_changes(self):
        c = J.parse_changes(ALT)
        self.assertEqual(c[0][:6], ("2026-10-26", "A B", "C D", "Braga", "PSD", "Suspensão"))


if __name__ == "__main__":
    unittest.main()
