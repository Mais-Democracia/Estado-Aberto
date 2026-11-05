"""Latest news from the Presidency (presidencia.pt)."""
import re
from datetime import datetime

from common import db, get, plain, set_meta

MONTHS = {m: i + 1 for i, m in enumerate(
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())}


def pt_date(s):
    m = re.match(r"(\d{1,2}) de (\w+) de (\d{4})", s.strip())
    return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m else None


def main():
    h = get("https://www.presidencia.pt/")
    con = db()
    n = 0
    for m in re.finditer(r'<a class="article-title" href="([^"]+)"[^>]*>(.*?)</a>\s*<p class="date[^"]*"[^>]*>([^<]+)</p>', h, re.S):
        url, title, date = m.group(1), plain(m.group(2)), pt_date(plain(m.group(3)))
        con.execute("INSERT OR REPLACE INTO news VALUES (?,?,?,?,?)",
                    ("https://www.presidencia.pt" + url, "Presidência da República", title, date, "presidencia.pt"))
        n += 1
    set_meta(con, "news_updated", datetime.now().isoformat(timespec="seconds"))
    con.commit()
    print("news:", n)


if __name__ == "__main__":
    main()
