import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402


class JournalLockTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "t.db"
        c = sqlite3.connect(self.db)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("CREATE TABLE t (x)")
        c.execute("INSERT INTO t VALUES (1)")
        c.commit()
        c.close()
        self.reader = sqlite3.connect(self.db)
        self.reader.execute("BEGIN")
        self.reader.execute("SELECT * FROM t").fetchall()

    def tearDown(self):
        self.reader.close()
        self.dir.cleanup()

    def test_open_with_reader_does_not_raise_and_writes(self):
        con = common.connect_writer(self.db, timeout=1)
        con.execute("INSERT INTO t VALUES (2)")
        con.commit()
        self.reader.rollback()
        con.execute("INSERT INTO t VALUES (3)")
        con.commit()
        self.assertEqual(con.execute("SELECT COUNT(*) FROM t").fetchone()[0], 3)
        self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        con.close()

    def test_delete_mode_db_with_reader_keeps_working(self):
        self.reader.rollback()
        self.reader.close()
        c = sqlite3.connect(self.db)
        c.execute("PRAGMA journal_mode=DELETE")
        c.close()
        self.reader = sqlite3.connect(self.db)
        self.reader.execute("BEGIN")
        self.reader.execute("SELECT * FROM t").fetchall()
        con = common.connect_writer(self.db, timeout=1)
        con.execute("INSERT INTO t VALUES (9)")
        self.reader.rollback()
        con.commit()
        con.close()

    def test_retry_gives_up_after_bounded_tries(self):
        calls = []

        def boom():
            calls.append(1)
            raise sqlite3.OperationalError("database is locked")

        orig = common.time.sleep
        common.time.sleep = lambda s: None
        try:
            with self.assertRaises(sqlite3.OperationalError):
                common._retry_locked(boom)
        finally:
            common.time.sleep = orig
        self.assertEqual(len(calls), common.LOCK_TRIES)


if __name__ == "__main__":
    unittest.main()
