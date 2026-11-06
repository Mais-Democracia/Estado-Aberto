#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE eventos(id INTEGER PRIMARY KEY, hash TEXT UNIQUE, data_evento TEXT, ingerido_em TEXT, edicao_data TEXT, secao TEXT, tipo TEXT, titulo TEXT, resumo_curto TEXT, fonte_modulo TEXT, fonte_ref TEXT, rota TEXT, source_url TEXT, entidades TEXT, score REAL, revisao INTEGER DEFAULT 1, atrasado INTEGER DEFAULT 0, ia_artigo_id INTEGER);
CREATE INDEX eventos_ed ON eventos(edicao_data, secao);
CREATE TABLE edicoes(numero INTEGER PRIMARY KEY, data TEXT UNIQUE, estado TEXT, fechada_em TEXT);
CREATE TABLE cursores(fonte TEXT PRIMARY KEY, max_rowid INTEGER, max_data TEXT, atualizado_em TEXT);
CREATE TABLE artigos_ia(id INTEGER PRIMARY KEY, edicao_data TEXT, evidence_hash TEXT, evento_ids TEXT, titulo TEXT, lead TEXT, corpo TEXT, pontos_chave TEXT, fontes TEXT, numeros_citados TEXT, entidades TEXT, confianca REAL, modelo TEXT, revisor TEXT, verificacao TEXT, estado TEXT, criado_em TEXT, revisao INTEGER DEFAULT 1, blocos TEXT, explicacao TEXT);
"""

SECS = {
    "parlamento": ("votacoes", "votação", "Plenário vota o projeto de lei sintético n.º {n}", "O plenário sintético aprovou a iniciativa {n} com votos a favor dos grupos A e B.", "#/votacoes"),
    "governo": ("dre", "diploma", "Governo publica o decreto-lei sintético n.º {n}", "Diploma de teste sobre matéria fictícia número {n}, publicado em Diário sintético.", "#/dre"),
    "fiscalizacao": ("justica", "auditoria", "Tribunal de Contas publica a auditoria sintética {n}", "Relatório fictício sobre a entidade de exemplo {n}.", "#/justica"),
    "poder-local": ("politica", "contrato", "Município de Exemplo {n} adjudica obra fictícia", "Contrato sintético de valor reduzido celebrado pelo município de exemplo {n}.", "#/contratos"),
    "dinheiro": ("politica", "contrato", "Entidade Modelo {n} contrata serviços por 120 mil euros", "Ajuste direto fictício com a empresa de teste {n}.", "#/contratos"),
}
COUNTS = {"parlamento": 14, "governo": 4, "fiscalizacao": 3, "poder-local": 2, "dinheiro": 5}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", default="2026-11-06")
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--empty", action="store_true")
    ap.add_argument("--sparse", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "diario.db")
    for suf in ("", "-wal", "-shm"):
        try:
            os.remove(path + suf)
        except OSError:
            pass
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    d0 = dt.date.fromisoformat(a.date)
    eid = 0
    for k in range(a.days):
        D = d0 + dt.timedelta(days=k)
        ds = D.isoformat()
        prev = (D - dt.timedelta(days=1)).isoformat()
        con.execute("INSERT INTO edicoes VALUES(?,?,?,?)", (k + 1, ds, "preliminar" if k == a.days - 1 else "fechada", None if k == a.days - 1 else ds + "T06:00:00Z"))
        if a.empty:
            continue
        if a.sparse:
            ev = prev
            for sec, tipo, tit, res, fonte, rota in (
                ("parlamento", "lei", "Lei n.º 65/2026: Altera o Código do IVA e define novas regras de faturação", "A Assembleia da República aprovou e o Presidente promulgou a lei sintética que altera o Código do IVA.", "votacoes", "#/votacoes/165"),
                ("governo", "diploma", "Decreto-Lei n.º 213/2026: Cria um regime complementar de apoio às famílias", "O Governo publicou o decreto-lei sintético que cria um regime complementar de apoio.", "dre", "#/dre/213"),
            ):
                eid += 1
                con.execute("INSERT INTO eventos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (eid, f"h{eid}", ev, f"{ds}T07:{eid:02d}:00Z", ds, sec, tipo, tit, res, fonte, str(eid), rota, "https://example.org/fonte/%d" % eid, "[]", 1.0, 1, 0, None))
            continue
        ids = {}
        for sec, n in COUNTS.items():
            fonte, tipo, tit, res, rota = SECS[sec]
            for i in range(1, n + 1):
                eid += 1
                ids.setdefault(sec, []).append(eid)
                late = 1 if (sec == "fiscalizacao" and i == 3) else 0
                ev = (D - dt.timedelta(days=3 if late else 1)).isoformat()
                con.execute(
                    "INSERT INTO eventos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (eid, f"h{eid}", ev, f"{ds}T{6 + (i % 14):02d}:{(i * 7) % 60:02d}:00Z", ds, sec, tipo, tit.format(n=eid), res.format(n=eid), fonte, str(eid), rota, "https://example.org/fonte/%d" % eid, json.dumps([{"nome": "Projeto de Lei", "tipo": "iniciativa", "id": str(100 + eid)}] if sec == "parlamento" else []), 1.0 - i / 40.0, 1, late, None),
                )
        longo = "\n\n".join(
            f"Parágrafo {j} do artigo sintético extenso. Este texto de teste serve para verificar a leitura de um corpo longo, com várias frases, números como 1 234 567 euros e datas como 5 de novembro de 2026. Nada aqui descreve factos reais; todas as entidades, valores e referências são inventados para validar a apresentação em colunas estreitas e largas."
            for j in range(1, 13)
        )
        LEI = (
            "Parlamento aprova a lei sintética da transparência nas contas públicas",
            "O plenário de teste aprovou na especialidade uma lei fictícia que obriga as entidades públicas a publicar as contas trimestrais, com votos a favor de cinco partidos.",
            "A lei sintética obriga as entidades de exemplo a publicar as contas todos os trimestres.\n\nA votação final global de teste terminou com 147 votos a favor, 58 contra e 25 abstenções.\n\nAs entidades abrangidas têm 180 dias para se adaptar, segundo o texto fictício.",
            ids["parlamento"][3:6],
            json.dumps({
                "lei": {"titulo": "Projeto de Lei sintético 42/XVII — Transparência nas contas públicas", "tipo": "Projeto de Lei", "numero": "42", "legislatura": "XVII", "autor": "Grupo Parlamentar Exemplo", "rota": "#/votacoes/102", "texto_url": "https://example.org/texto/42"},
                "votacao": {"data": ds, "resultado": "Aprovado", "por_partido": [
                    {"partido": "PS", "voto": "favor", "lugares": 78}, {"partido": "PSD", "voto": "favor", "lugares": 40}, {"partido": "CH", "voto": "contra", "lugares": 50},
                    {"partido": "IL", "voto": "abstencao", "lugares": 9}, {"partido": "BE", "voto": "favor", "lugares": 5}, {"partido": "PCP", "voto": "contra", "lugares": 3}, {"partido": "L", "voto": "ausente", "lugares": None}],
                    "totais": {"favor": 123, "contra": 53, "abstencao": 9}},
                "intervencoes": [
                    {"id": "9001", "deputado": "Deputada Exemplo Um", "partido": "PS", "data": prev, "excerto": "Esta lei sintética devolve aos cidadãos o direito de saber, todos os trimestres, como é gasto o dinheiro de todos.", "rota": "#/votacoes/102"},
                    {"id": "9002", "deputado": "Deputado Exemplo Dois", "partido": "CH", "data": prev, "excerto": "Votamos contra porque o custo administrativo de teste recai sobre as entidades mais pequenas, sem apoio nenhum.", "rota": "#/votacoes/102"},
                    {"id": "9003", "deputado": "Deputado Exemplo Três", "partido": "IL", "data": prev, "excerto": "Abstemo-nos: concordamos com o princípio fictício, mas o prazo de 180 dias parece-nos irrealista.", "rota": "#/votacoes/102"}]}),
            json.dumps({"do_que_trata": "A lei sintética obriga as entidades públicas de exemplo a publicar as suas contas todos os trimestres, num formato aberto e acessível a qualquer pessoa.", "o_que_muda": ["As contas passam a ser publicadas de três em três meses, e não apenas uma vez por ano.", "Os dados ficam disponíveis em formato aberto, sem necessidade de pedido.", "As entidades têm 180 dias para se adaptar."]}),
        )
        CIDADAOS = (
            "Parlamento aprova por unanimidade iniciativa sintética de cidadãos sobre a carreira dos professores",
            "Uma iniciativa legislativa de cidadãos fictícia foi aprovada por unanimidade na votação final global de teste, depois de o PSD ter votado contra na generalidade.",
            "A iniciativa legislativa de cidadãos de teste propõe corrigir o posicionamento dos docentes na carreira.\n\nNa votação na generalidade de teste, o PSD votou contra e dois partidos abstiveram-se; na votação final global todos os grupos parlamentares presentes votaram a favor.\n\nO texto aguarda promulgação, segundo os dados de teste.",
            ids["parlamento"][6:9],
            json.dumps({
                "lei": {"titulo": "Projeto de Lei sintético 285/XVII — Reposicionamento na carreira docente", "tipo": "Projeto de Lei", "numero": "285", "legislatura": "XVII", "autor": "Cidadãos", "origem": "Cidadãos", "rota": "#/votacoes/103", "texto_url": "https://example.org/texto/285"},
                "votacao": {"data": ds, "fase": "Votação final global", "orgao": "Plenário", "unanime": True, "resultado": "Aprovado por unanimidade", "por_partido": [
                    {"partido": "PSD", "voto": "favor", "lugares": 89}, {"partido": "CH", "voto": "favor", "lugares": 60}, {"partido": "PS", "voto": "favor", "lugares": 58},
                    {"partido": "IL", "voto": "favor", "lugares": 9}, {"partido": "L", "voto": "favor", "lugares": 6}, {"partido": "PCP", "voto": "favor", "lugares": 3},
                    {"partido": "CDS-PP", "voto": "favor", "lugares": 2}, {"partido": "BE", "voto": "favor", "lugares": 1}, {"partido": "JPP", "voto": "favor", "lugares": 1}, {"partido": "PAN", "voto": "ausente", "lugares": 1}],
                    "totais": {"favor": 229, "contra": 0, "abstencao": 0}},
                "votacoes_anteriores": [
                    {"data": prev, "fase": "Votação na generalidade", "orgao": "Plenário", "unanime": False, "resultado": "Aprovado", "por_partido": [
                        {"partido": "CH", "voto": "favor", "lugares": 60}, {"partido": "PS", "voto": "favor", "lugares": 58}, {"partido": "L", "voto": "favor", "lugares": 6}, {"partido": "PCP", "voto": "favor", "lugares": 3},
                        {"partido": "BE", "voto": "favor", "lugares": 1}, {"partido": "PAN", "voto": "favor", "lugares": 1}, {"partido": "JPP", "voto": "favor", "lugares": 1}, {"partido": "PSD", "voto": "contra", "lugares": 89},
                        {"partido": "IL", "voto": "abstencao", "lugares": 9}, {"partido": "CDS-PP", "voto": "abstencao", "lugares": 2}],
                        "totais": {"favor": 130, "contra": 89, "abstencao": 11}},
                    {"data": prev, "fase": "Baixa à comissão", "orgao": "Comissão", "unanime": True, "resultado": "Aprovado por unanimidade", "por_partido": [], "totais": {"favor": 0, "contra": 0, "abstencao": 0}}],
                "intervencoes": [
                    {"id": "9011", "deputado": "Deputado Exemplo Quatro", "partido": "PSD", "data": prev, "excerto": "O PSD acompanha o objetivo fictício, mas reserva a sua posição quanto ao custo orçamental de teste.", "rota": "#/votacoes/103"}]}),
            json.dumps({"do_que_trata": "A iniciativa legislativa de cidadãos de teste pede que o tempo de serviço dos professores seja contado de forma justa no posicionamento na carreira.", "o_que_muda": ["O tempo de serviço de teste passaria a contar para o posicionamento na carreira."]}),
        )
        arts = [
            ("Parlamento aprova pacote sintético de medidas", "O plenário de teste aprovou ontem um pacote de medidas fictícias, com votos a favor de dois grupos.", "Primeiro parágrafo curto.\n\nSegundo parágrafo curto com um número: 42 votos.", ids["parlamento"][:3], None, None),
            ("Auditoria sintética aponta falhas em entidade de exemplo", "Uma auditoria fictícia identificou três falhas de controlo numa entidade de exemplo.", "A auditoria sintética descreve as falhas.\n\nAs recomendações constam do relatório de teste.", ids["fiscalizacao"][:2], None, None),
            ("Dossier extenso de teste sobre contratação fictícia", "Um dossier longo, inteiramente sintético, para testar corpos extensos e a quebra de linhas em ecrãs pequenos.", longo, ids["dinheiro"][:3] + ids["poder-local"][:1], None, None),
            LEI,
            CIDADAOS,
        ]
        for n, (tit, lead, corpo, evs, blocos, expl) in enumerate(arts, 1):
            aid = (k * 10) + n
            con.execute(
                "INSERT INTO artigos_ia(id, edicao_data, evidence_hash, evento_ids, titulo, lead, corpo, pontos_chave, fontes, numeros_citados, entidades, confianca, modelo, revisor, verificacao, estado, criado_em, revisao, blocos, explicacao) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid, ds, f"e{aid}", json.dumps(evs), tit, lead, corpo, json.dumps(["Ponto-chave sintético um", "Ponto-chave sintético dois com um valor de 120 mil euros", "Ponto-chave sintético três"]), json.dumps([{"label": "Fonte sintética A", "href": "https://example.org/a"}, {"label": "Fonte sintética B", "href": "https://example.org/b"}]), json.dumps([{"valor": "120 mil euros", "fonte": "A"}]), json.dumps(["Entidade Modelo 1", "Município de Exemplo 2"]), 0.9, "modelo-sintetico-1", "revisor-sintetico", json.dumps({"ok": True, "passos": 3}), "publicado", ds + "T05:30:00Z", 1, blocos, expl),
            )
            con.executemany("UPDATE eventos SET ia_artigo_id = ? WHERE id = ?", [(aid, e) for e in evs])
        con.execute("INSERT INTO artigos_ia(id, edicao_data, evidence_hash, evento_ids, titulo, lead, corpo, pontos_chave, fontes, numeros_citados, entidades, confianca, modelo, revisor, verificacao, estado, criado_em, revisao) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (k * 10 + 9, ds, "rej", "[]", "Rejeitado", "x", "x", "[]", "[]", "[]", "[]", 0.1, "m", "r", "{}", "rejeitado", ds + "T05:31:00Z", 1))
    con.execute("INSERT INTO eventos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (9999, "hold", "2026-10-30", "2026-10-31T08:00:00Z", "2026-10-31", "nomeacoes", "nomeação", "Nomeação sintética antiga", "x", "responsaveis", "1", "#/responsaveis", None, "[]", 0.5, 1, 0, None))
    last = d0 + dt.timedelta(days=a.days - 1)
    for fonte, off in (("votacoes", 1), ("dre", 1), ("tcontas", 1), ("base", 1), ("nomeacoes", 4)):
        con.execute("INSERT INTO cursores VALUES(?,?,?,?)", (fonte, 100, (last - dt.timedelta(days=off)).isoformat(), last.isoformat() + "T07:00:00Z"))
    con.commit()
    con.close()
    st = os.path.join(a.out, "state")
    os.makedirs(st, exist_ok=True)
    with open(os.path.join(st, ".ingest_state.json"), "w") as f:
        json.dump({"nomeacoes": {"last_ok": last.isoformat() + "T07:00:00Z", "last_data_date": (last - dt.timedelta(days=4)).isoformat()}}, f)
    with open(os.path.join(st, "alerts.json"), "w") as f:
        json.dump([], f)
    print("ok", path)


if __name__ == "__main__":
    main()
