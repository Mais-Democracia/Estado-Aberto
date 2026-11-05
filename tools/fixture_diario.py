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
CREATE TABLE artigos_ia(id INTEGER PRIMARY KEY, edicao_data TEXT, evidence_hash TEXT, evento_ids TEXT, titulo TEXT, lead TEXT, corpo TEXT, pontos_chave TEXT, fontes TEXT, numeros_citados TEXT, entidades TEXT, confianca REAL, modelo TEXT, revisor TEXT, verificacao TEXT, estado TEXT, criado_em TEXT, revisao INTEGER DEFAULT 1);
"""

SECS = {
    "parlamento": ("votacoes", "votação", "Plenário vota o projeto de lei sintético n.º {n}", "O plenário sintético aprovou a iniciativa {n} com votos a favor dos grupos A e B.", "voto/{n}"),
    "governo": ("dre", "diploma", "Governo publica o decreto-lei sintético n.º {n}", "Diploma de teste sobre matéria fictícia número {n}, publicado em Diário sintético.", "ato/{n}"),
    "fiscalizacao": ("tcontas", "auditoria", "Tribunal de Contas publica a auditoria sintética {n}", "Relatório fictício sobre a entidade de exemplo {n}.", "relatorio/{n}"),
    "poder-local": ("base", "contrato", "Município de Exemplo {n} adjudica obra fictícia", "Contrato sintético de valor reduzido celebrado pelo município de exemplo {n}.", "contrato/{n}"),
    "dinheiro": ("base", "contrato", "Entidade Modelo {n} contrata serviços por 120 mil euros", "Ajuste direto fictício com a empresa de teste {n}.", "contrato/{n}"),
}
COUNTS = {"parlamento": 14, "governo": 4, "fiscalizacao": 3, "poder-local": 2, "dinheiro": 5}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", default="2026-11-06")
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--empty", action="store_true")
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
                    (eid, f"h{eid}", ev, f"{ds}T{6 + (i % 14):02d}:{(i * 7) % 60:02d}:00Z", ds, sec, tipo, tit.format(n=eid), res.format(n=eid), fonte, str(eid), rota.format(n=eid), "https://example.org/fonte/%d" % eid, "[]", 1.0 - i / 40.0, 1, late, None),
                )
        longo = "\n\n".join(
            f"Parágrafo {j} do artigo sintético extenso. Este texto de teste serve para verificar a leitura de um corpo longo, com várias frases, números como 1 234 567 euros e datas como 5 de novembro de 2026. Nada aqui descreve factos reais; todas as entidades, valores e referências são inventados para validar a apresentação em colunas estreitas e largas."
            for j in range(1, 13)
        )
        arts = [
            ("Parlamento aprova pacote sintético de medidas", "O plenário de teste aprovou ontem um pacote de medidas fictícias, com votos a favor de dois grupos.", "Primeiro parágrafo curto.\n\nSegundo parágrafo curto com um número: 42 votos.", ids["parlamento"][:3]),
            ("Auditoria sintética aponta falhas em entidade de exemplo", "Uma auditoria fictícia identificou três falhas de controlo numa entidade de exemplo.", "A auditoria sintética descreve as falhas.\n\nAs recomendações constam do relatório de teste.", ids["fiscalizacao"][:2]),
            ("Dossier extenso de teste sobre contratação fictícia", "Um dossier longo, inteiramente sintético, para testar corpos extensos e a quebra de linhas em ecrãs pequenos.", longo, ids["dinheiro"][:3] + ids["poder-local"][:1]),
        ]
        for n, (tit, lead, corpo, evs) in enumerate(arts, 1):
            aid = (k * 10) + n
            con.execute(
                "INSERT INTO artigos_ia VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid, ds, f"e{aid}", json.dumps(evs), tit, lead, corpo, json.dumps(["Ponto-chave sintético um", "Ponto-chave sintético dois com um valor de 120 mil euros", "Ponto-chave sintético três"]), json.dumps([{"label": "Fonte sintética A", "href": "https://example.org/a"}, {"label": "Fonte sintética B", "href": "https://example.org/b"}]), json.dumps([{"valor": "120 mil euros", "fonte": "A"}]), json.dumps(["Entidade Modelo 1", "Município de Exemplo 2"]), 0.9, "modelo-sintetico-1", "revisor-sintetico", json.dumps({"ok": True, "passos": 3}), "publicado", ds + "T05:30:00Z", 1),
            )
            con.executemany("UPDATE eventos SET ia_artigo_id = ? WHERE id = ?", [(aid, e) for e in evs])
        con.execute("INSERT INTO artigos_ia VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (k * 10 + 9, ds, "rej", "[]", "Rejeitado", "x", "x", "[]", "[]", "[]", "[]", 0.1, "m", "r", "{}", "rejeitado", ds + "T05:31:00Z", 1))
    con.execute("INSERT INTO eventos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (9999, "hold", "2026-10-30", "2026-10-31T08:00:00Z", "2026-10-31", "nomeacoes", "nomeação", "Nomeação sintética antiga", "x", "nomeacoes", "1", "ato/1", None, "[]", 0.5, 1, 0, None))
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
