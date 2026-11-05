#!/usr/bin/env python3
"""Check that this machine can run the Estado Aberto ingest tools. Stdlib only."""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [
    ("dados.gov.pt", "https://dados.gov.pt/api/1/datasets/?page_size=1"),
    ("parlamento.pt", "https://www.parlamento.pt/"),
    ("ine.pt", "https://www.ine.pt/"),
    ("diariodarepublica.pt", "https://diariodarepublica.pt/"),
    ("igcp.pt", "https://www.igcp.pt/pt"),
    ("wikidata.org", "https://www.wikidata.org/w/api.php?action=query&meta=siteinfo&format=json"),
]
MIN_PY = (3, 12)


def contact_ua():
    return "Estado-Aberto/1.0 (" + (os.environ.get("ESTADO_ABERTO_CONTACT") or "+https://github.com/Mais-Democracia/Estado-Aberto") + ")"


def meminfo():
    out = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            out[k] = int(v.split()[0]) / 1024
    except OSError:
        pass
    return out


def check_python():
    v = sys.version_info
    ok = (v.major, v.minor) >= MIN_PY
    msg = f"Python {v.major}.{v.minor}.{v.micro}" + ("" if (v.major, v.minor) >= (3, 14) else " (3.14 recommended)")
    return ("ok" if ok else "FAIL"), msg, "" if ok else "Install Python 3.12+ (pyenv, deadsnakes PPA or python.org)."


def check_node():
    want = (ROOT / ".nvmrc").read_text().strip() if (ROOT / ".nvmrc").exists() else "22"
    node = shutil.which("node")
    if not node:
        return "warn", "node not found (only needed for the web server and UI)", f"Install Node {want}: nvm install {want}"
    v = subprocess.run([node, "-v"], capture_output=True, text=True).stdout.strip()
    ok = v.lstrip("v").split(".")[0] == want.split(".")[0]
    return ("ok" if ok else "warn"), f"node {v}", "" if ok else f"Run: nvm install {want} && nvm use {want}"


def check_pdftotext():
    p = shutil.which("pdftotext")
    if p:
        return "ok", "pdftotext found", ""
    return "FAIL", "pdftotext not found (needed by intervencoes, apoios, responsaveis)", "sudo apt install poppler-utils"


def check_sqlite():
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        return "ok", f"sqlite {sqlite3.sqlite_version} with FTS5", ""
    except sqlite3.Error:
        return "FAIL", f"sqlite {sqlite3.sqlite_version} lacks FTS5", "Use a Python build linked against a recent SQLite."


def check_disk(data):
    p = data
    while not p.exists():
        p = p.parent
    free = shutil.disk_usage(p).free / 2 ** 30
    st = "ok" if free >= 15 else ("warn" if free >= 5 else "FAIL")
    return st, f"{free:.1f} GB free at {p}", "" if st == "ok" else "Free disk space or point ESTADO_ABERTO_DATA at a larger volume. A full bootstrap needs roughly 9 GB of raw cache unless --prune-raw is used."


def check_ram():
    m = meminfo()
    if not m:
        return "warn", "cannot read /proc/meminfo", ""
    avail, total = m.get("MemAvailable", 0), m.get("MemTotal", 0)
    st = "ok" if avail >= 700 else ("warn" if avail >= 400 else "FAIL")
    return st, f"{avail:.0f} MB available of {total:.0f} MB", "" if st == "ok" else "Close other programs or add swap; run with --profile server --max-mb 400."


def check_writable(data):
    try:
        data.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=data, prefix=".doctor"):
            pass
        return "ok", f"data dir writable: {data}", ""
    except OSError as e:
        return "FAIL", f"data dir not writable: {data} ({e})", "Set ESTADO_ABERTO_DATA to a writable directory."


def probe(url):
    req = urllib.request.Request(url, headers={"User-Agent": contact_ua()})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return True, str(r.status)
    except urllib.error.HTTPError as e:
        return e.code < 500, f"HTTP {e.code}"
    except Exception as e:
        return False, type(e).__name__


def run_checks(data, network=True):
    rows = [("python", *check_python()), ("node", *check_node()), ("pdftotext", *check_pdftotext()), ("sqlite", *check_sqlite()),
            ("disk", *check_disk(data)), ("ram", *check_ram()), ("data dir", *check_writable(data))]
    if network:
        for name, url in SOURCES:
            ok, info = probe(url)
            rows.append((name, "ok" if ok else "warn", f"reachable ({info})" if ok else f"unreachable ({info})",
                         "" if ok else "Check your network; the source may be temporarily down. Steps tolerate this and can be resumed."))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", help="data dir (default $ESTADO_ABERTO_DATA or ./data)")
    ap.add_argument("--offline", action="store_true", help="skip source reachability checks")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    data = Path(a.data or os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()
    rows = run_checks(data, not a.offline)
    if a.json:
        print(json.dumps([dict(zip(("check", "status", "detail", "hint"), r)) for r in rows], indent=1))
    else:
        for name, st, msg, hint in rows:
            print(f"[{st:>4}] {name:<22} {msg}")
            if hint:
                print(f"       fix: {hint}")
    return 1 if any(r[1] == "FAIL" for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
