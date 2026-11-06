"""Shared helpers: database schema + HTTP fetching (stdlib only)."""
import fcntl
import hashlib
import html
import http.client
import json
import os
import re
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()
DB_PATH = DATA_DIR / "politica.db"
CONTACT = os.environ.get("ESTADO_ABERTO_CONTACT") or "+https://github.com/Mais-Democracia/Estado-Aberto"
UA = f"Estado-Aberto/1.0 ({CONTACT})"
DELAY = float(os.environ.get("ESTADO_ABERTO_DELAY", "0.5"))
TRIES = int(os.environ.get("ESTADO_ABERTO_TRIES", "4"))
REFRESH = os.environ.get("ESTADO_ABERTO_REFRESH") == "1" or "--refresh" in sys.argv
CACHE_DIR = DATA_DIR / "cache" / "http"
RETRY_CODES = {408, 425, 429, 500, 502, 503, 504}
_last_hit = {}
LOCK_PRIORITY = {"updater": 0, "ingest": 1, "ai": 2}
LOCK_WAIT = float(os.environ.get("EA_LOCK_WAIT", "7200"))
LOCK_POLL = float(os.environ.get("EA_LOCK_POLL", "2"))
LOCK_UNAVAILABLE = 77
CONNECT_TIMEOUT = float(os.environ.get("ESTADO_ABERTO_CONNECT_TIMEOUT", "10"))
READ_TIMEOUT = float(os.environ.get("ESTADO_ABERTO_READ_TIMEOUT", "30"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, title TEXT, start TEXT, end TEXT, section TEXT,
  theme TEXT, subtitle TEXT, local TEXT, text TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
CREATE TABLE IF NOT EXISTS initiatives (
  key TEXT PRIMARY KEY, kind TEXT, number INTEGER, legislature TEXT, session INTEGER,
  origin TEXT, title TEXT, source TEXT
);
-- Timeline of an initiative. Derived from agenda mentions; the parliament open-data adapter
-- (ingest/ar_opendata.py) adds official steps/votes when that feed is reachable.
CREATE TABLE IF NOT EXISTS initiative_steps (
  initiative_key TEXT, event_id INTEGER, date TEXT, phase TEXT, body TEXT, detail TEXT,
  relator TEXT, source TEXT, UNIQUE (initiative_key, event_id, phase)
);
CREATE TABLE IF NOT EXISTS laws (
  id TEXT PRIMARY KEY, number TEXT, title TEXT, kind TEXT, published TEXT, url TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS law_versions (
  law_id TEXT, version_date TEXT, amended_by TEXT, description TEXT, url TEXT
);
CREATE TABLE IF NOT EXISTS votes (
  initiative_key TEXT, date TEXT, result TEXT, favor TEXT, against TEXT, abstention TEXT,
  detail_json TEXT
);
CREATE TABLE IF NOT EXISTS parties (
  code TEXT PRIMARY KEY, name TEXT, seats INTEGER, bloc TEXT, color TEXT, ideology TEXT, website TEXT
);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT, body TEXT, party TEXT,
  since TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY, name TEXT, category TEXT, branch TEXT, description TEXT, url TEXT, reachable INTEGER
);
CREATE TABLE IF NOT EXISTS news (
  url TEXT PRIMARY KEY, body TEXT, title TEXT, date TEXT, source TEXT
);
-- ===== v2: entity-centred registry + public contracts (Portal BASE / IMPIC) =====
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nif TEXT UNIQUE,                 -- NIF/NIPC (9 digits) when known
  name TEXT NOT NULL,
  kind TEXT,                       -- municipio, freguesia, cim_am, escola, saude, universidade, instituto, empresa_municipal, ministerio, ...
  level TEXT,                      -- central | regional | local | empresa_publica | privado | outro
  is_public INTEGER DEFAULT 0,     -- 1 = contracting authority / public body
  parent_id INTEGER,               -- e.g. freguesia -> municipio, body -> ministry
  ministry TEXT,
  wikidata TEXT, website TEXT, description TEXT,
  region TEXT, district TEXT, municipality TEXT,
  dico TEXT,                       -- INE/DICO code for municipios (4 digits) and freguesias (6 digits)
  population INTEGER, lat REAL, lon REAL,
  buyer_contracts INTEGER DEFAULT 0, buyer_value REAL DEFAULT 0,
  seller_contracts INTEGER DEFAULT 0, seller_value REAL DEFAULT 0,
  sources TEXT
);
CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS entities_parent ON entities(parent_id);
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, year INTEGER, signed TEXT, published TEXT, decision TEXT,
  object TEXT, types TEXT, procedure TEXT, price REAL, base_price REAL, effective_price REAL,
  cpv TEXT, cpv_code TEXT, location TEXT, duration_days INTEGER, n_bidders INTEGER,
  framework TEXT, centralised TEXT, direct_basis TEXT, legal_basis TEXT, criterion TEXT,
  announcement TEXT, link TEXT, buyer_nif TEXT, buyer_name TEXT, seller_nif TEXT, seller_name TEXT, n_sellers INTEGER
);
CREATE INDEX IF NOT EXISTS contracts_buyer ON contracts(buyer_nif, signed);
CREATE INDEX IF NOT EXISTS contracts_seller ON contracts(seller_nif, signed);
CREATE INDEX IF NOT EXISTS contracts_year ON contracts(year);
CREATE INDEX IF NOT EXISTS contracts_proc ON contracts(procedure);
CREATE INDEX IF NOT EXISTS contracts_year_cov ON contracts(year, procedure, price);
CREATE INDEX IF NOT EXISTS contracts_proc_cov ON contracts(procedure, price);
CREATE INDEX IF NOT EXISTS contracts_signed_cov ON contracts(signed DESC, price DESC);
CREATE INDEX IF NOT EXISTS contracts_published_cov ON contracts(published, price);
CREATE INDEX IF NOT EXISTS contracts_buyer_cov ON contracts(buyer_nif, year, procedure, price, seller_nif, seller_name, cpv_code, signed);
CREATE TABLE IF NOT EXISTS contract_parties (
  contract_id TEXT, nif TEXT, name TEXT, role TEXT   -- buyer | seller | bidder
);
CREATE INDEX IF NOT EXISTS cp_nif ON contract_parties(nif, role);
CREATE INDEX IF NOT EXISTS cp_contract ON contract_parties(contract_id);
CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, label TEXT, created TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=600)
    con.executescript(SCHEMA)
    return con


LOCK_TRIES = 5


def _retry_locked(fn, *a):
    delay = 1.0
    for i in range(LOCK_TRIES):
        try:
            return fn(*a)
        except sqlite3.OperationalError as e:
            if "locked" not in str(e) or i == LOCK_TRIES - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 3, 30)


class WriterConnection(sqlite3.Connection):
    def execute(self, *a):
        return _retry_locked(super().execute, *a)

    def executemany(self, *a):
        return _retry_locked(super().executemany, *a)

    def executescript(self, *a):
        return _retry_locked(super().executescript, *a)

    def commit(self):
        return _retry_locked(super().commit)


def connect_writer(path, timeout=60):
    con = sqlite3.connect(path, timeout=timeout, factory=WriterConnection)
    con.execute("PRAGMA busy_timeout=2000")
    try:
        sqlite3.Connection.execute(con, "PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass  # another process holds the DB; WAL or rollback mode both work for the writer
    con.execute("PRAGMA busy_timeout=60000")
    return con


def set_meta(con, key, value):
    con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))


def polite(url):
    host = urllib.parse.urlsplit(url).netloc
    wait = DELAY - (time.time() - _last_hit.get(host, 0.0))
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.time()


def _timed_connect(conn, base):
    read = conn.timeout
    conn.timeout = min(CONNECT_TIMEOUT, read) if read else CONNECT_TIMEOUT
    try:
        base.connect(conn)
    finally:
        conn.timeout = read
    if read:
        conn.sock.settimeout(read)


class _TimedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        _timed_connect(self, http.client.HTTPSConnection)


class _TimedHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        _timed_connect(self, http.client.HTTPConnection)


class _TimedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_TimedHTTPSConnection, req, context=self._context)


class _TimedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_TimedHTTPConnection, req)


def timed_opener(*handlers):
    return urllib.request.build_opener(_TimedHTTPHandler, _TimedHTTPSHandler, *handlers)


_OPENER = timed_opener()


def request(url, headers=None, timeout=None, data=None, tries=None):
    tries = tries or TRIES
    timeout = READ_TIMEOUT if timeout is None else timeout
    err = None
    for i in range(tries):
        polite(url)
        req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
        try:
            return _OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            err = e
            if e.code not in RETRY_CODES:
                raise
            ra = e.headers.get("Retry-After") if e.headers else None
            pause = float(ra) if ra and ra.isdigit() else 0
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            err = e
            pause = 0
        if i + 1 < tries:
            time.sleep(min(60, max(pause, 2 ** (i + 1))))
    raise err


def cache_file(url, params=None):
    key = url + "?" + urllib.parse.urlencode(sorted((params or {}).items()))
    host = urllib.parse.urlsplit(url).netloc or "local"
    return CACHE_DIR / host / hashlib.sha1(key.encode()).hexdigest()


def get(url, params=None, headers=None, timeout=60, cache=False, max_age_h=None):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    f = cache_file(url) if cache else None
    if f and not REFRESH and f.exists() and (max_age_h is None or time.time() - f.stat().st_mtime < max_age_h * 3600):
        return f.read_text("utf-8", "replace")
    try:
        with request(url, headers, timeout) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception:
        if f and f.exists():
            return f.read_text("utf-8", "replace")
        raise
    if f:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + ".part")
        tmp.write_text(body, "utf-8")
        tmp.replace(f)
    return body


def get_json(url, params=None, headers=None, timeout=60, cache=False, max_age_h=None):
    return json.loads(get(url, params, headers, timeout, cache, max_age_h))


def download(url, dest, headers=None, timeout=120, force=False):
    dest = Path(dest)
    if dest.exists() and not force and not REFRESH:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with request(url, headers, timeout) as r, open(tmp, "wb") as out:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    tmp.replace(dest)
    return dest


def plain(s):
    s = re.sub(r"<(br|/p|/li|/div)[^>]*>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", s)).strip()


def state_dir():
    v = os.environ.get("STATE_DIR")
    if v:
        return Path(v)
    prod = Path("/var/lib/estado-aberto/state")
    return prod if prod.is_dir() else DATA_DIR / ".state"


def append_alert(unit, lines, state=None, cap=50):
    state = Path(state) if state else state_dir()
    try:
        state.mkdir(parents=True, exist_ok=True)
        with open(state / "alerts.lock", "a") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            path = state / "alerts.json"
            try:
                d = json.loads(path.read_text("utf-8"))
                alerts = d["alerts"] if isinstance(d, dict) else []
            except (OSError, ValueError, KeyError):
                alerts = []
            alerts.append({"unit": unit, "time": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), "lines": lines})
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps({"version": 1, "alerts": alerts[-cap:]}, indent=2, ensure_ascii=False), "utf-8")
            tmp.replace(path)
    except OSError as e:
        print(f"alert: could not write alerts.json ({e})", flush=True)


class LockTimeout(Exception):
    pass


class LockUnavailable(Exception):
    pass


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class SharedLock:
    def __init__(self, role="ingest", wait=None, poll=None, state=None, log=None):
        if role not in LOCK_PRIORITY:
            raise ValueError("unknown lock role " + role)
        self.role = role
        self.wait = LOCK_WAIT if wait is None else wait
        self.poll = LOCK_POLL if poll is None else poll
        self.state = Path(state) if state else state_dir()
        self.log = log or (lambda m: print(m, flush=True))
        self.path = self.state / "update.lock"
        self.fd = None
        self.inherited = os.environ.get("EA_LOCK_HELD") == "1"
        self.want = self.state / f"lock.want.{role}.{os.getpid()}"

    def _higher_waiting(self):
        mine = LOCK_PRIORITY[self.role]
        for f in self.state.glob("lock.want.*.*"):
            parts = f.name.split(".")
            try:
                role, pid = parts[2], int(parts[3])
            except (IndexError, ValueError):
                continue
            if LOCK_PRIORITY.get(role, 9) >= mine or pid == os.getpid():
                continue
            if _alive(pid):
                return role
            f.unlink(missing_ok=True)
        return None

    def _prepare(self):
        try:
            existed = self.state.is_dir()
            self.state.mkdir(parents=True, exist_ok=True)
            st = self.state.stat()
            if st.st_uid == os.getuid() and (not existed or not st.st_mode & stat.S_IWGRP or not st.st_mode & stat.S_ISGID):
                os.chmod(self.state, (st.st_mode & 0o7777) | 0o2070 if existed else 0o2770)
        except OSError as e:
            raise LockUnavailable(f"lock: state directory {self.state} is unusable ({e.strerror}); this {self.role} run did not start")
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return
        except OSError:
            return
        if st.st_uid == os.getuid() and not st.st_mode & stat.S_IWGRP:
            try:
                os.chmod(self.path, 0o660)
            except OSError:
                pass

    def _open(self):
        self._prepare()
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o660)
        except OSError as e:
            raise LockUnavailable(f"lock: cannot open {self.path} for writing ({e.strerror}); {self._describe()}this {self.role} run did not start")
        try:
            st = os.fstat(fd)
            if st.st_uid == os.getuid() and st.st_mode & 0o660 != 0o660:
                os.fchmod(fd, 0o660)
        except OSError:
            pass
        return fd

    def _describe(self):
        try:
            st = self.path.stat()
            return f"file is owned by uid {st.st_uid} gid {st.st_gid} mode {st.st_mode & 0o7777:04o}, this process is uid {os.getuid()}; "
        except OSError:
            return ""

    def holder(self):
        try:
            fd = os.open(self.path, os.O_RDONLY)
        except OSError:
            return "unknown"
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except OSError:
                pass
            else:
                return "nobody (lock is free)"
            try:
                rec = self.path.read_text("utf-8").strip()
            except OSError:
                return "unknown"
            pid = rec.rsplit(" ", 1)[-1]
            if pid.isdigit() and _alive(int(pid)):
                return rec
            return "unknown (stale owner record)"
        finally:
            os.close(fd)

    def acquire(self, wait=None):
        if self.inherited or self.fd is not None:
            return self
        wait = self.wait if wait is None else wait
        fd = self._open()
        try:
            self.want.write_text(str(os.getpid()))
        except OSError as e:
            os.close(fd)
            raise LockUnavailable(f"lock: cannot write {self.want} ({e.strerror}); this {self.role} run did not start")
        deadline = time.monotonic() + wait
        announced = False
        try:
            while True:
                blocker = self._higher_waiting()
                if blocker is None:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pass
                    except OSError as e:
                        raise LockUnavailable(f"lock: flock on {self.path} failed ({e.strerror}); this {self.role} run did not start")
                    else:
                        os.ftruncate(fd, 0)
                        os.write(fd, f"{self.role} {os.getpid()}\n".encode())
                        self.fd = fd
                        fd = None
                        if announced:
                            self.log(f"lock: acquired update.lock as {self.role}")
                        return self
                if not announced:
                    why = f"a pending {blocker} run" if blocker else f"held by {self.holder()}"
                    self.log(f"lock: waiting for update.lock ({why}); giving up after {int(wait)}s")
                    announced = True
                if time.monotonic() >= deadline:
                    who = f"a pending {blocker} run" if blocker else self.holder()
                    self.log(f"lock: gave up after {int(wait)}s waiting for update.lock held by {who}; this {self.role} run did not start")
                    raise LockTimeout(who)
                time.sleep(self.poll)
        finally:
            self.want.unlink(missing_ok=True)
            if fd is not None:
                os.close(fd)

    def release(self):
        if self.fd is not None:
            try:
                os.ftruncate(self.fd, 0)
            except OSError:
                pass
            os.close(self.fd)
            self.fd = None

    def checkpoint(self):
        if self.inherited or self.fd is None:
            return False
        blocker = self._higher_waiting()
        if blocker is None:
            return False
        self.log(f"lock: yielding update.lock to a pending {blocker} run")
        self.release()
        self.acquire()
        return True

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
