"""Precompute per-entity contract statistics and transparent risk indicators (indicators, not accusations)."""
from datetime import datetime

from common import db, set_meta

SQL = """
DROP TABLE IF EXISTS buyer_stats;
CREATE TABLE buyer_stats AS
SELECT buyer_nif AS nif,
       COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price END),0) AS value,
       SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n,
       COALESCE(SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' AND price > 0 THEN price END),0) AS direct_value,
       SUM(CASE WHEN n_bidders = 1 AND procedure NOT LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS single_bidder_n,
       SUM(CASE WHEN n_bidders IS NOT NULL AND procedure NOT LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS competitive_n,
       SUM(CASE WHEN effective_price > price * 1.2 AND price > 0 THEN 1 ELSE 0 END) AS overrun_n,
       MIN(signed) AS first_signed, MAX(signed) AS last_signed
FROM contracts WHERE buyer_nif IS NOT NULL GROUP BY buyer_nif;
CREATE UNIQUE INDEX buyer_stats_nif ON buyer_stats(nif);

DROP TABLE IF EXISTS seller_stats;
CREATE TABLE seller_stats AS
SELECT nif, COUNT(DISTINCT contract_id) AS n,
       COALESCE(SUM(CASE WHEN c.price > 0 THEN c.price * 1.0 / MAX(c.n_sellers, 1) END),0) AS value,   -- co-sellers share the price
       COUNT(DISTINCT c.buyer_nif) AS n_buyers,
       SUM(CASE WHEN c.procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n,
       MIN(c.signed) AS first_signed, MAX(c.signed) AS last_signed
FROM contract_parties p JOIN contracts c ON c.id = p.contract_id
WHERE p.role='seller' AND nif IS NOT NULL GROUP BY nif;
CREATE UNIQUE INDEX seller_stats_nif ON seller_stats(nif);

DROP TABLE IF EXISTS pair_stats;
CREATE TABLE pair_stats AS
SELECT buyer_nif, seller_nif, COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price * 1.0 / MAX(n_sellers, 1) END),0) AS value,
       SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n
FROM contracts WHERE buyer_nif IS NOT NULL AND seller_nif IS NOT NULL GROUP BY buyer_nif, seller_nif;
CREATE INDEX pair_buyer ON pair_stats(buyer_nif, value DESC);
CREATE INDEX pair_seller ON pair_stats(seller_nif, value DESC);

DROP TABLE IF EXISTS year_stats;
CREATE TABLE year_stats AS
SELECT buyer_nif AS nif, year, COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price END),0) AS value,
       SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n,
       COALESCE(SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' AND price > 0 THEN price END),0) AS direct_value
FROM contracts WHERE buyer_nif IS NOT NULL GROUP BY buyer_nif, year;
CREATE INDEX year_nif ON year_stats(nif, year);
"""


def main():
    con = db()
    con.executescript(SQL)
    try:   # full-text index over contract descriptions (SQLite FTS5)
        con.executescript("""DROP TABLE IF EXISTS contracts_fts;
            CREATE VIRTUAL TABLE contracts_fts USING fts5(object, content='contracts', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
            INSERT INTO contracts_fts(rowid, object) SELECT rowid, object FROM contracts;""")
    except Exception as e:
        print("FTS5 unavailable:", e)
    con.executescript("""   -- keep the registry's own totals consistent with the contract table
        UPDATE entities SET buyer_contracts = COALESCE((SELECT n FROM buyer_stats b WHERE b.nif = entities.nif), 0),
                            buyer_value = COALESCE((SELECT value FROM buyer_stats b WHERE b.nif = entities.nif), 0),
                            seller_contracts = COALESCE((SELECT n FROM seller_stats s WHERE s.nif = entities.nif), 0),
                            seller_value = COALESCE((SELECT value FROM seller_stats s WHERE s.nif = entities.nif), 0)
        WHERE nif IS NOT NULL;""")
    set_meta(con, "stats_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print("buyers:", con.execute("SELECT COUNT(*) FROM buyer_stats").fetchone()[0],
          "sellers:", con.execute("SELECT COUNT(*) FROM seller_stats").fetchone()[0],
          "pairs:", con.execute("SELECT COUNT(*) FROM pair_stats").fetchone()[0])


if __name__ == "__main__":
    main()
