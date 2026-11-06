import json
import sys
from datetime import date, timedelta


def since_days(argv=None):
    a = sys.argv[1:] if argv is None else list(argv)
    for i, x in enumerate(a):
        if x == "--since" and i + 1 < len(a):
            v = a[i + 1]
        elif x.startswith("--since="):
            v = x.split("=", 1)[1]
        else:
            continue
        n = int(v)
        if n < 1:
            raise SystemExit("--since needs a positive number of days")
        return n
    return None


def cutoff(days):
    return (date.today() - timedelta(days=days)).isoformat()


def report(ultima_data):
    print(json.dumps({"ultima_data": ultima_data}), flush=True)
