import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import migrations


class MigrateDiario(unittest.TestCase):
    def test_creates_empty_ledger(self):
        with tempfile.TemporaryDirectory() as d:
            migrations.migrate_all(Path(d), log=lambda *_: None)
            con = sqlite3.connect(Path(d) / "diario.db")
            names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"eventos", "edicoes", "cursores", "artigos_ia"} <= names)
            self.assertFalse((Path(d) / "politica.db").exists())
            migrations.migrate_all(Path(d), log=lambda *_: None)


if __name__ == "__main__":
    unittest.main()
