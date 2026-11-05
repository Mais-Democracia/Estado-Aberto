"""Portal BASE (IMPIC) public contracts 2012-present -> contracts / contract_parties.
Streams each yearly JSON from its zip (files are hundreds of MB); never loads a whole year in memory.
Usage: python contracts.py [year ...]   (default: all years in data/raw/manifest.json)"""
import codecs
import html
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from common import DATA_DIR, db, ROOT, set_meta, UA

RAW = DATA_DIR / "raw" / "contracts"
DS = "66d72d488ca4b7cb2de28712"   # dados.gov.pt dataset: Contratos Públicos - Portal Base - Contratos de 2012 a 2026


def iter_json_array(fh, chunk=1 << 20):
    """Yield objects of a top-level JSON array read from a binary stream."""
    dec, buf = json.JSONDecoder(), ""
    utf8 = codecs.getincrementaldecoder("utf-8")("replace")
    started = False
    while True:
        data = fh.read(chunk)
        buf += utf8.decode(data, final=not data)
        pos = 0
        if not started:
            i = buf.find("[")
            if i < 0:
                if not data:
                    return
                continue
            pos, started = i + 1, True
        while True:
            while pos < len(buf) and buf[pos] in " \r\n\t,":
                pos += 1
            if pos >= len(buf) or buf[pos] == "]":
                break
            try:
                obj, end = dec.raw_decode(buf, pos)
            except json.JSONDecodeError:
                break                      # object continues in next chunk
            yield obj
            pos = end
        buf = buf[pos:]
        if not data:
            return


def iso(d):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", d or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def split_party(s):
    """'600052737 - Name' / '504615947 - 1 - MEO ...' / '504615947-GROWSKILLS' -> (nif, name)"""
    m = re.match(r"\s*(\d{5,9})\s*(?:-\s*\d+\s*)?-\s*(.*)", s or "", re.S)
    if m:
        return m.group(1), html.unescape(re.sub(r"^[-\s]+", "", m.group(2))).strip()
    return None, html.unescape(s or "").strip()


def first(v):
    return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else None)


def load_year(con, year, url):
    RAW.mkdir(parents=True, exist_ok=True)
    zp = RAW / f"contratos{year}.zip"
    if not zp.exists() or zp.stat().st_size < 1000:
        print(f"[{year}] downloading", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as r, open(zp, "wb") as out:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                out.write(b)
    con.execute("DELETE FROM contract_parties WHERE contract_id IN (SELECT id FROM contracts WHERE year=?)", (year,))
    con.execute("DELETE FROM contracts WHERE year=?", (year,))
    n = 0
    seen = set()
    with zipfile.ZipFile(zp) as z, z.open(z.namelist()[0]) as fh:
        for c in iter_json_array(fh):
            cid = str(c.get("idcontrato"))
            if cid in seen:   # repeated ids exist in the source: last record wins
                con.execute("DELETE FROM contract_parties WHERE contract_id=?", (cid,))
            seen.add(cid)
            buyers = [split_party(x) for x in (c.get("adjudicante") or [])]
            sellers = [split_party(x) for x in (c.get("adjudicatarios") or [])]
            bidders = [split_party(x) for x in (c.get("concorrentes") or [])]
            cpv = first(c.get("cpv")) or ""
            con.execute("INSERT OR REPLACE INTO contracts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                cid, c.get("Ano") or year, iso(c.get("dataCelebracaoContrato")), iso(c.get("dataPublicacao")), iso(c.get("dataDecisaoAdjudicacao")),
                html.unescape(c.get("objectoContrato") or ""), "; ".join(c.get("tipoContrato") or []), c.get("tipoprocedimento"),
                c.get("precoContratual"), c.get("precoBaseProcedimento"), c.get("PrecoTotalEfetivo"),
                cpv, cpv.split(" - ")[0] if cpv else None, "; ".join(c.get("localExecucao") or []), c.get("prazoExecucao"),
                len(bidders) if c.get("concorrentes") else None,
                c.get("DescrAcordoQuadro") or c.get("numAcordoQuadro") or None, c.get("ProcedimentoCentralizado"),
                c.get("fundamentAjusteDireto") or None, c.get("fundamentacao"), c.get("TipoCriterioAdjudicacao"),
                c.get("nAnuncio") or None, c.get("linkPecasProc") or None,
                buyers[0][0] if buyers else None, buyers[0][1] if buyers else None,
                sellers[0][0] if sellers else None, sellers[0][1] if sellers else None, len(sellers)))
            for role, lst in (("buyer", buyers), ("seller", sellers), ("bidder", bidders)):
                for nif, name in lst:
                    con.execute("INSERT INTO contract_parties VALUES (?,?,?,?)", (cid, nif, name, role))
            n += 1
            if n % 50000 == 0:
                con.commit(); print(f"[{year}] {n}", flush=True)
    con.commit()
    print(f"[{year}] done: {n} contracts", flush=True)
    return n


def main():
    manifest = {}
    d = json.load(urllib.request.urlopen(urllib.request.Request(f"https://dados.gov.pt/api/1/datasets/{DS}/", headers={"User-Agent": UA}), timeout=60))
    for r in d["resources"]:
        m = re.fullmatch(r"contratos(\d{4})\.zip", r["title"])
        if m:
            manifest[int(m.group(1))] = r["url"]
    years = [int(y) for y in sys.argv[1:]] or sorted(manifest)
    con = db()
    for y in years:
        load_year(con, y, manifest[y])
    from datetime import datetime
    set_meta(con, "contracts_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print("total contracts:", con.execute("SELECT COUNT(*) FROM contracts").fetchone()[0])


if __name__ == "__main__":
    main()
