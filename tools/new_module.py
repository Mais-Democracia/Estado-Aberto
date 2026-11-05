#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SECTIONS = {
    "parlamento": "Parlamento",
    "governo": "Governo",
    "dinheiro": "Dinheiro público",
    "poder-local": "Poder local",
    "instituicoes": "Instituições",
    "leis-justica": "Leis e justiça",
    "indicadores": "Indicadores",
}

INGEST = '''import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, UA, get_json  # noqa: E402

NAME = "__NAME__"
DB = ROOT / "data" / f"{NAME}.db"
RAW = ROOT / "data" / "raw" / NAME
SOURCE_URL = "https://example.invalid/"
GAP = 1.2

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, year INTEGER, title TEXT, entity_nif TEXT, source_url TEXT);
CREATE INDEX IF NOT EXISTS items_year ON items(year);
CREATE INDEX IF NOT EXISTS items_nif ON items(entity_nif);
"""


def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


def fetch():
    time.sleep(GAP)
    return get_json(SOURCE_URL)


def main():
    con = connect()
    rows = fetch()
    for r in rows:
        con.execute(
            "INSERT OR REPLACE INTO items (id, year, title, entity_nif, source_url) VALUES (?,?,?,?,?)",
            (r["id"], r.get("year"), r.get("title"), r.get("nif"), SOURCE_URL),
        )
    con.execute("INSERT OR REPLACE INTO meta VALUES ('built', datetime('now'))")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (SOURCE_URL,))
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
'''

SERVER = '''export default function register({ num, routes, openData }) {
  const mine = openData("__NAME__");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const meta = (k) => q1("SELECT value FROM meta WHERE key=?", k)?.value ?? null;
  const missing = () => ({ available: false, note: "A base data/__NAME__.db ainda não foi gerada (python3 ingest/run_all.py __NAME__)." });

  routes["/api/__NAME__/overview"] = () => {
    if (!mine) return missing();
    return {
      available: true,
      total: q1("SELECT COUNT(*) n, MIN(year) y0, MAX(year) y1 FROM items"),
      built: meta("built"),
      source: meta("source"),
    };
  };

  routes["/api/__NAME__/items"] = (q) => {
    if (!mine) return missing();
    const year = num(q.get("year"), 0, 0);
    const limit = Math.min(num(q.get("limit"), 50, 1), 200);
    const where = year ? "WHERE year = ?" : "";
    const params = year ? [year] : [];
    return { available: true, rows: qa(`SELECT id, year, title, entity_nif, source_url FROM items ${where} ORDER BY year DESC, id LIMIT ${limit}`, ...params) };
  };
}
'''

CLIENT = '''"use strict";
(() => {
  const { esc } = Portal;

  Portal.page("__NAME__", async () => {
    try {
      const [ov, list] = await Promise.all([Portal.api("__NAME__/overview"), Portal.api("__NAME__/items")]);
      if (ov.available === false) {
        $app.innerHTML = `<div class="pagehead"><div><h1>__TITLE__</h1></div></div><p class="note warn">${esc(ov.note)}</p>`;
        return;
      }
      const rows = list.rows.map((r) => `<tr><td>${esc(r.year || "")}</td><td>${esc(r.title)}</td><td><a href="${esc(r.source_url)}" target="_blank" rel="noopener">Fonte ↗</a></td></tr>`).join("");
      $app.innerHTML = `<div class="crumbs"><a href="#/">Início</a> / __TITLE__</div>
        <div class="pagehead"><div><h1>__TITLE__</h1>
        <p class="small muted">Fonte: ${esc(ov.source || "—")} (recolha de ${esc(ov.built || "—")}).</p></div>
        <div class="kpis"><div class="kpi"><b>${ov.total.n}</b><span>registos na base</span></div></div></div>
        <section class="panel">${rows ? `<table class="tbl"><thead><tr><th>Ano</th><th>Título</th><th>Fonte</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="note">Sem registos na base.</p>`}</section>`;
    } catch (e) {
      $app.innerHTML = `<p class="note warn">Não foi possível carregar os dados: ${esc(String(e.message || e))}</p>`;
    }
  });
})();
'''


def title_of(name):
    return name.replace("_", " ").replace("-", " ").strip().capitalize()


def write(path, text, force):
    if path.exists() and not force:
        sys.exit(f"exists: {path.relative_to(ROOT)} (use --force)")
    path.write_text(text, encoding="utf-8")
    print(f"created {path.relative_to(ROOT)}")


def add_manifest(name):
    path = ROOT / "ingest" / "jobs.json"
    entry = {
        "name": name,
        "script": f"jobs/{name}.py",
        "depends": [],
        "produces": [f"{name}.db"],
        "network": True,
        "est_minutes": 5,
        "est_peak_mb": 100,
        "est_disk_mb": 50,
        "schedule": "weekly",
        "enabled": True,
        "fresh_days": 7,
        "raw": [name],
        "keep_raw": False,
        "flaky": False,
        "licence": "docs/SOURCES.md: " + name,
        "notes": "",
    }
    if not path.exists():
        print("ingest/jobs.json not found; add this entry to the steps list:")
        print(json.dumps(entry, indent=1, ensure_ascii=False))
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    if any(s.get("name") == name for s in data["steps"]):
        print(f"manifest already has {name}")
        return
    data["steps"].append(entry)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("updated ingest/jobs.json (fill in estimates, schedule, licence and notes)")


def add_nav(name, section):
    path = ROOT / "public" / "portal.js"
    label = SECTIONS[section]
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(r'^(\s*\["' + re.escape(label) + r'", "' + re.escape(section) + r'", \[.*)\]\]\],?$', re.M)
    m = pattern.search(text)
    if not m:
        print(f'could not find the "{label}" group in Portal.NAV_GROUPS; add ["{name}", "{title_of(name)}"] by hand')
        return
    line = m.group(0)
    if f'["{name}",' in line:
        print("menu entry already present")
        return
    new = line[: line.rindex("]]]")] + f', ["{name}", "{title_of(name)}"]]]]' + line[line.rindex("]]]") + 3:]
    path.write_text(text.replace(line, new, 1), encoding="utf-8")
    print(f'added "{title_of(name)}" to the {label} menu in public/portal.js')


def main():
    ap = argparse.ArgumentParser(description="Scaffold a data module")
    ap.add_argument("name")
    ap.add_argument("--section", required=True, choices=sorted(SECTIONS))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9_]*", a.name):
        sys.exit("name must be lowercase letters, digits and underscores")
    title = title_of(a.name)
    subs = {"__NAME__": a.name, "__TITLE__": title}

    def fill(t):
        for k, v in subs.items():
            t = t.replace(k, v)
        return t

    write(ROOT / "ingest" / "jobs" / f"{a.name}.py", fill(INGEST), a.force)
    write(ROOT / "server" / "modules" / f"{a.name}.mjs", fill(SERVER), a.force)
    write(ROOT / "public" / "modules" / f"{a.name}.js", fill(CLIENT), a.force)
    add_manifest(a.name)
    add_nav(a.name, a.section)
    print(f"""
TODO
  [ ] verify the source: curl -I, robots.txt, terms, licence
  [ ] set SOURCE_URL and write fetch()/main() in ingest/jobs/{a.name}.py (stream, WAL, source_url per row)
  [ ] adapt the schema and routes in server/modules/{a.name}.mjs (indexed, LIMIT)
  [ ] adapt the page in public/modules/{a.name}.js (escape text, Portuguese, honest empty state)
  [ ] check the manifest entry and the menu entry
  [ ] document the source and recipe in docs/SOURCES.md; update docs/BACKLOG.md
  [ ] run: python3 -m py_compile ingest/jobs/{a.name}.py; node --check server/modules/{a.name}.mjs public/modules/{a.name}.js
  [ ] no data committed""")


if __name__ == "__main__":
    main()
