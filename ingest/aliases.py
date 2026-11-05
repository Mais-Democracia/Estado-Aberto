"""Former names / successor relationships for renamed or merged public bodies, so old names resolve in search.
Only entries verified against sources; add more with a source note."""
from common import db

# (match, note) — match is a NIF (9 digits) or a case-insensitive name prefix
ALIASES = [
    ("508069645", "Anteriormente Parque Escolar, EPE (renomeada Construção Pública, EPE em junho de 2023; mesmo NIF). Fonte: agente educacao / site da entidade."),
    ("Agência para a Integração, Migrações e Asilo", "Sucedeu em 2023 às competências administrativas do extinto SEF (Serviço de Estrangeiros e Fronteiras)."),
]


def main():
    con = db()
    n = 0
    for key, note in ALIASES:
        if key.isdigit():
            cur = con.execute("UPDATE entities SET description = CASE WHEN description IS NULL OR description = '' THEN ? ELSE description || ' · ' || ? END WHERE nif = ? AND COALESCE(description,'') NOT LIKE ?", (note, note, key, "%" + note[:30] + "%"))
        else:
            cur = con.execute("UPDATE entities SET description = CASE WHEN description IS NULL OR description = '' THEN ? ELSE description || ' · ' || ? END WHERE name LIKE ? AND COALESCE(description,'') NOT LIKE ?", (note, note, key + "%", "%" + note[:30] + "%"))
        n += cur.rowcount
    con.commit()
    print("aliases applied:", n)


if __name__ == "__main__":
    main()
