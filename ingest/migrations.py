"""Idempotent in-place schema upgrades for databases built by older releases (stdlib only)."""
import sqlite3
import sys
from pathlib import Path

POLITICA_COLUMNS = {"entities": [("population_source", "TEXT")]}
VOTACOES_COLUMNS = {
    "fases": [("diploma_bid", "INTEGER")],
    "votos": [("inconsistente", "INTEGER")],
    "iniciativas": [("leg_fim", "TEXT"), ("transitou", "INTEGER DEFAULT 0"), ("anexos_at", "TEXT")],
}
ANEXOS_DDL = """
CREATE TABLE IF NOT EXISTS iniciativa_anexos (
  bid INTEGER NOT NULL, nome TEXT, tipo TEXT, url TEXT NOT NULL, UNIQUE (bid, nome, url)
);
CREATE INDEX IF NOT EXISTS ia_bid ON iniciativa_anexos(bid);
"""
RESPONSAVEIS_COLUMNS = {"links": [("is_public", "INTEGER DEFAULT 0")]}
RESPONSAVEIS_DDL = """
CREATE TABLE IF NOT EXISTS nomeacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, action TEXT, person TEXT, role TEXT, entity TEXT, entity_nif TEXT,
  date TEXT, act TEXT, act_id TEXT, source_url TEXT, match_method TEXT, UNIQUE (act_id, action, person, role)
);
CREATE INDEX IF NOT EXISTS n_nif ON nomeacoes(entity_nif);
CREATE INDEX IF NOT EXISTS n_date ON nomeacoes(date);
CREATE TABLE IF NOT EXISTS cresap_results (
  code TEXT, role TEXT, entity TEXT, entity_nif TEXT, outcome TEXT, candidate TEXT, date TEXT, pdf_url TEXT,
  UNIQUE (code, candidate, outcome)
);
"""
SEE_DOCS_DDL = "CREATE TABLE IF NOT EXISTS see_docs (kind TEXT, year INTEGER, quarter INTEGER, title TEXT, url TEXT, per_company INTEGER DEFAULT 0)"


def add_columns(con, wanted):
    n = 0
    for table, cols in wanted.items():
        have = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
        if not have:
            continue
        for name, decl in cols:
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                n += 1
    return n


def ensure_politica(con):
    return add_columns(con, POLITICA_COLUMNS)


def ensure_votacoes(con):
    con.executescript(ANEXOS_DDL)
    return add_columns(con, VOTACOES_COLUMNS)


def ensure_responsaveis(con):
    con.executescript(RESPONSAVEIS_DDL)
    return add_columns(con, RESPONSAVEIS_COLUMNS)


def ensure_estado_empresas(con):
    con.execute(SEE_DOCS_DDL)
    return 0


ARTIGOS_IA_COLUMNS = {"artigos_ia": [("blocos", "TEXT"), ("explicacao", "TEXT")]}


def ensure_artigos_ia(con):
    return add_columns(con, ARTIGOS_IA_COLUMNS)


def ensure_diario(con):
    sys.path.insert(0, str(Path(__file__).resolve().parent / "jobs"))
    from diario import SCHEMA
    con.executescript(SCHEMA)
    return ensure_artigos_ia(con)


CREATE_IF_MISSING = {"diario"}
DATABASES = {
    "politica": ensure_politica,
    "votacoes": ensure_votacoes,
    "responsaveis": ensure_responsaveis,
    "estado_empresas": ensure_estado_empresas,
    "diario": ensure_diario,
}


def migrate_all(data_dir, log=print):
    done = 0
    for name, fn in DATABASES.items():
        f = data_dir / f"{name}.db"
        if not f.exists() and name not in CREATE_IF_MISSING:
            log(f"migrate: {name}.db absent, skipped")
            continue
        con = sqlite3.connect(f, timeout=60)
        try:
            n = fn(con)
            con.commit()
        finally:
            con.close()
        done += 1
        log(f"migrate: {name}.db ok ({n} columns added)")
    return done


if __name__ == "__main__":
    from common import DATA_DIR
    migrate_all(DATA_DIR)
    sys.exit(0)
