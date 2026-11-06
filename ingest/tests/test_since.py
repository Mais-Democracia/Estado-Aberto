"""Tests for the incremental --since mode helpers and contracts_recent. Run: python3 -m unittest discover ingest/tests"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from datetime import date, timedelta
from pathlib import Path

INGEST = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(INGEST))
import since  # noqa: E402


class SinceHelpers(unittest.TestCase):
    def test_absent(self):
        self.assertIsNone(since.since_days(["--refresh"]))

    def test_two_forms(self):
        self.assertEqual(since.since_days(["--since", "7"]), 7)
        self.assertEqual(since.since_days(["x", "--since=3"]), 3)

    def test_rejects_zero(self):
        with self.assertRaises(SystemExit):
            since.since_days(["--since", "0"])

    def test_cutoff(self):
        self.assertEqual(since.cutoff(3), (date.today() - timedelta(days=3)).isoformat())

    def test_report_is_one_json_line(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            since.report("2026-05-04")
        self.assertEqual(json.loads(buf.getvalue()), {"ultima_data": "2026-05-04"})
        self.assertEqual(len(buf.getvalue().splitlines()), 1)


SNIPPET = """
import json, sys, zipfile
sys.argv = ["contracts.py", "--since", "10"]
sys.path.insert(0, %(ingest)r)
import contracts
from common import db
con = db()
n = contracts.load_recent(con, 2026, %(url)r, 10, "mod-1")
m = contracts.load_recent(con, 2026, %(url)r, 10, "mod-1")
rows = con.execute("SELECT id, buyer_name FROM contracts ORDER BY id").fetchall()
parties = con.execute("SELECT contract_id, role FROM contract_parties ORDER BY contract_id, role").fetchall()
print(json.dumps([n, m, rows, parties]))
"""


class ContractsRecent(unittest.TestCase):
    def test_upserts_only_recent_contracts_and_skips_unchanged_source(self):
        today = date.today()
        fmt = lambda d: d.strftime("%d/%m/%Y")
        recs = [
            {"idcontrato": 1, "Ano": today.year, "dataPublicacao": fmt(today - timedelta(days=60)), "adjudicante": ["500000001 - Old Buyer"], "adjudicatarios": ["500000002 - Seller"]},
            {"idcontrato": 2, "Ano": today.year, "dataPublicacao": fmt(today - timedelta(days=1)), "adjudicante": ["500000003 - New Buyer"], "adjudicatarios": ["500000004 - Seller"]},
        ]
        with tempfile.TemporaryDirectory() as t:
            zp = Path(t) / "c.zip"
            with zipfile.ZipFile(zp, "w") as z:
                z.writestr("contratos.json", json.dumps(recs))
            env = {"ESTADO_ABERTO_DATA": str(Path(t) / "data"), "PATH": "/usr/bin:/bin"}
            r = subprocess.run([sys.executable, "-c", SNIPPET % {"ingest": str(INGEST), "url": zp.as_uri()}], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            n, m, rows, parties = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(n, 1)
            self.assertEqual(m, 0)
            self.assertEqual(rows, [["2", "New Buyer"]])
            self.assertEqual(sorted(p[1] for p in parties), ["buyer", "seller"])
            self.assertFalse(list((Path(t) / "data" / "raw" / "contracts").glob("*.recent.zip")))


if __name__ == "__main__":
    unittest.main()
