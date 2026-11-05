import os
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from pathlib import Path


def host_allowed(host, allowed):
    host = (host or "").lower()
    return any(host == h or host.endswith("." + h) for h in allowed)


def robots_ok(url, ua, timeout):
    u = urllib.parse.urlparse(url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        req = urllib.request.Request(f"{u.scheme}://{u.netloc}/robots.txt", headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rp.parse(r.read(200000).decode("utf-8", "replace").splitlines())
    except urllib.error.HTTPError as e:
        return e.code < 500 and e.code not in (401, 403)
    except Exception:
        return False
    return rp.can_fetch(ua, url)


def download(url, cfg, dest):
    pc = cfg["pdf"]
    ua = "Estado-Aberto-IA/1.0 (" + (os.environ.get("ESTADO_ABERTO_CONTACT") or "+https://github.com/Mais-Democracia/Estado-Aberto") + ")"
    u = urllib.parse.urlparse(url)
    if u.scheme == "file" and os.environ.get("AI_ALLOW_FILE") == "1":
        data = Path(urllib.request.url2pathname(u.path)).read_bytes()[: pc["max_bytes"]]
        dest.write_bytes(data)
        return True
    if u.scheme not in ("http", "https") or not host_allowed(u.hostname, cfg["allowed_hosts"]):
        return False
    if not robots_ok(url, ua, pc["timeout_s"]):
        return False
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=pc["timeout_s"]) as r:
            if not host_allowed(urllib.parse.urlparse(r.geturl()).hostname, cfg["allowed_hosts"]):
                return False
            data = r.read(pc["max_bytes"] + 1)
    except Exception:
        return False
    if len(data) > pc["max_bytes"]:
        return False
    dest.write_bytes(data)
    return True


def to_text(path, cfg):
    pc = cfg["pdf"]
    raw = path.read_bytes()
    if raw[:5] != b"%PDF-":
        return raw.decode("utf-8", "replace")[: pc["max_chars"]]
    if not shutil.which("pdftotext"):
        return ""
    try:
        p = subprocess.run(["pdftotext", "-l", str(pc["max_pages"]), "-layout", str(path), "-"], capture_output=True, timeout=pc["timeout_s"] * 3)
    except Exception:
        return ""
    return p.stdout.decode("utf-8", "replace")[: pc["max_chars"]]


def fetch_text(url, cfg, workdir):
    tmp = workdir / "fonte.tmp"
    try:
        if not download(url, cfg, tmp):
            return ""
        return re.sub(r"\n{3,}", "\n\n", to_text(tmp, cfg))
    finally:
        tmp.unlink(missing_ok=True)
