"""Shared helpers: database schema + HTTP fetching (stdlib only)."""
import html
import json
import re
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "politica.db"
UA = "politica-pt/0.1 (personal civic project; contact: contact@example.org)"

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
    DB_PATH.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=600)
    con.executescript(SCHEMA)
    return con


def set_meta(con, key, value):
    con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))


def get(url, params=None, headers=None, timeout=60):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def get_json(url, params=None, headers=None, timeout=60):
    return json.loads(get(url, params, headers, timeout))


def plain(s):
    s = re.sub(r"<(br|/p|/li|/div)[^>]*>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", s)).strip()
