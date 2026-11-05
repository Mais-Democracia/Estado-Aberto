import re
import subprocess

AREA_WORDS = {"TEATRO", "MÚSICA", "MUSICA", "DANÇA", "CRUZAMENTOS", "DISCIPLINARES", "ARTES", "PLÁSTICAS", "FOTOGRAFIA", "DESIGN",
              "ARQUITETURA", "ARQUITECTURA", "CIRCO", "CINEMA", "AUDIOVISUAL", "LITERATURA", "ÓPERA", "MULTIDISCIPLINAR", "OUTRAS", "OUTRA", "VISUAIS", "PERFORMATIVAS", "RUA", "DE"}
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
NUM = re.compile(r"^\d{1,3}(?:[.  ]\d{3})*,\d{2}$|^\d{1,3}$|^\d{3}$|^\d+,\d{2}$")
NIF = re.compile(r"^\d{9}$")


def unesc(s):
    return s.replace("&amp;", "&").replace("&apos;", "'").replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">")


def pages(pdf):
    t = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True, timeout=300).stdout
    out = []
    for pg in t.split("<page ")[1:]:
        out.append([(float(a), float(b), float(c), float(d), unesc(s)) for a, b, c, d, s in WORD.findall(pg)])
    return out


def eur(parts):
    s = "".join(parts).replace(".", "").replace(" ", "").replace(" ", "")
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def lines_of(words, tol=1.6):
    ws = sorted(words, key=lambda w: (w[1], w[0]))
    rows = []
    for w in ws:
        if rows and abs(rows[-1]["y"] - w[1]) <= tol:
            rows[-1]["w"].append(w)
        else:
            rows.append({"y": w[1], "w": [w]})
    for r in rows:
        r["w"].sort()
    return rows


def assign(lines, anchors):
    n, m = len(lines), len(anchors)
    if m == 0 or n < m or n > 3 * m:
        return None
    INF = 1e18
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    bk = [[0] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0
    for j in range(1, m + 1):
        for i in range(j, n + 1):
            for k in (1, 2, 3):
                if i - k < j - 1 or dp[i - k][j - 1] >= INF:
                    continue
                ys = [l["y"] for l in lines[i - k:i]]
                c = sum(abs(y - anchors[j - 1]) for y in ys) + (0 if k == 1 else 0.5 * (k - 1))
                if dp[i - k][j - 1] + c < dp[i][j]:
                    dp[i][j] = dp[i - k][j - 1] + c
                    bk[i][j] = k
    if dp[n][m] >= INF:
        return None
    groups, i = [], n
    for j in range(m, 0, -1):
        k = bk[i][j]
        groups.append(lines[i - k:i])
        i -= k
    return groups[::-1]


def parse(pdf):
    pgs = pages(pdf)
    allw = [w for p in pgs for w in p]
    areax = [w[0] for w in allw if w[4].upper() in {"TEATRO", "MÚSICA", "DANÇA", "CRUZAMENTOS", "FOTOGRAFIA", "DESIGN"} and w[0] > 400]
    if not areax:
        return [], [], ["sem colunas de área"]
    ax = min(areax) - 12
    eurx = sorted(w[0] for w in allw if w[4] == "€")
    ex = eurx[len(eurx) // 2] if eurx else 700
    rows, totals, notes = [], [], []
    prog_prev = ""
    for pn, words in enumerate(pgs, 1):
        body = [w for w in words if w[1] > 100 and w[4] not in ("PÁGINA",)]
        cand = [w[0] for w in body if 100 <= w[0] < ax and not re.match(r"^(PÁGINA|LISTAGEM|MENSAL:|DIREÇÃO)", w[4])]
        if not cand:
            continue
        nx = min(cand)
        ls = lines_of(body)
        marks = []
        drop = set()
        for idx, l in enumerate(ls):
            for w in l["w"]:
                if w[4] == "TOTAL" and w[0] > nx + 150:
                    marks.append(idx)
                    drop.add(idx)
                    for k in (idx, idx + 1):
                        if k < len(ls) and any(x[4] == "€" for x in ls[k]["w"]) and abs(ls[k]["y"] - l["y"]) < 5:
                            drop.add(k)
                    break
        tot_info = []
        for idx in marks:
            for k in (idx, idx + 1):
                if k < len(ls) and any(x[4] == "€" for x in ls[k]["w"]) and abs(ls[k]["y"] - ls[idx]["y"]) < 5:
                    e = next(x for x in ls[k]["w"] if x[4] == "€")
                    parts = [x[4] for x in ls[k]["w"] if x[0] < e[0] and x[0] > ex - 90 and NUM.match(x[4])]
                    tot_info.append((ls[idx]["y"], eur(parts), " ".join(x[4] for x in ls[idx]["w"])))
                    break
        keep = [l for i2, l in enumerate(ls) if i2 not in drop]
        cuts = [t[0] for t in tot_info]
        blocks = []
        lo = -1
        for t in cuts + [1e9]:
            blocks.append([l for l in keep if lo < l["y"] <= t - 0.5] if t < 1e9 else [l for l in keep if l["y"] > lo])
            lo = t
        for bi, blk in enumerate(blocks):
            anc = []
            for l in blk:
                ws = l["w"]
                es = [w for w in ws if w[4] == "€"]
                if es:
                    e = es[0]
                    parts = [w[4] for w in ws if w[0] < e[0] and w[0] > ex - 90 and NUM.match(w[4])]
                    anc.append({"y": l["y"], "v": eur(parts), "nif": next((w[4] for w in ws if w[0] > e[0] and NIF.match(w[4])), None), "ws": ws})
            if not anc:
                continue
            first = anc[0]["y"]
            name_lines = []
            for l in blk:
                nw = [w for w in l["w"] if nx - 3 <= w[0] < ax]
                if nw:
                    name_lines.append({"y": l["y"], "w": nw})
            heading = [l for l in name_lines if l["y"] < first - 10]
            names = [l for l in name_lines if l["y"] >= first - 10]
            prog = re.sub(r"\s+", " ", " ".join(" ".join(w[4] for w in l["w"]) for l in heading)).strip() or prog_prev
            prog_prev = prog
            grp = assign(names, [a["y"] for a in anc])
            if grp is None:
                notes.append(f"p{pn}: {len(names)} linhas de nome para {len(anc)} montantes")
                continue
            tv = tot_info[bi][1] if bi < len(tot_info) else None
            for a, g in zip(anc, grp):
                ws = a["ws"]
                area = " ".join(w[4] for w in ws if ax <= w[0] < ex - 90 and w[4].upper() in AREA_WORDS)
                reg = " ".join(w[4] for w in ws if ax <= w[0] < ex - 90 and w[4].upper() not in AREA_WORDS)
                nm = re.sub(r"\s+", " ", " ".join(w[4] for l in g for w in l["w"])).strip()
                rows.append({"page": pn, "prog": prog, "nome": nm, "area": area, "regiao": reg, "amount": a["v"], "nif": a["nif"], "blk": (pn, bi), "blktotal": tv})
        for t in tot_info:
            totals.append({"page": pn, "y": t[0], "total": t[1], "label": t[2]})
    return rows, totals, notes


GLOBAL_RE = re.compile(r"montante\s+(?:global|total)[^€\d]{0,60}€?\s*([\d.\s]+,\d{2})", re.I | re.S)
LINE_AMT = re.compile(r"^(?P<l>.*?\S)\s{2,}€?\s*(?P<a>\d{1,3}(?:[. ]\d{3})*(?:,\d{2})?)\s*€?\s*$")


def ica_global(text):
    m = GLOBAL_RE.search(text)
    return eur([m.group(1)]) if m else None


def ica_simple(text):
    rows = []
    for ln in text.splitlines():
        if re.search(r"T \+351|Praça|Rua Lu|www\.ica|NIPC|Mod\. ", ln):
            continue
        m = LINE_AMT.match(ln.rstrip())
        if not m or "€" not in ln:
            continue
        cells = [c.strip() for c in re.split(r"\s{2,}", m.group("l").replace("€", " ").strip()) if c.strip()]
        if len(cells) != 2:
            return None
        a = eur([m.group("a")])
        if a is None or a <= 0:
            return None
        rows.append({"titulo": cells[0], "ben": cells[1], "amount": a})
    return rows
