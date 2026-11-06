#!/usr/bin/env python3
"""Manifest-driven runner for every Estado Aberto ingest step (ingest/jobs.json). Stdlib only."""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
MANIFEST = HERE / "jobs.json"
SCHEDULES = {"6h": {"6h"}, "daily": {"6h", "daily"}, "weekly": {"6h", "daily", "weekly"}, "bootstrap": {"6h", "daily", "weekly", "bootstrap"}}
DATA_LINE = re.compile(r'^\{"ultima_data":\s*(null|"[^"]*")(?:,\s*"parcial":\s*(true|false))?\s*\}\s*$')
FINAL_STEP = "diario"
LOCK_UNAVAILABLE = 77
ALERT_UNITS = {"6h": "estado-aberto-refresh.service", "daily": "estado-aberto-daily.service", "weekly": "estado-aberto-weekly.service"}
FAILED = ("failed", "timeout", "offline_fail", "refused", "blocked")
PROFILES = {
    "server": {"nice": 10, "max_mb": 600, "min_free_gb": 5.0, "prune_raw": True, "delay": "1.0", "tolerate_offline": True},
    "dev": {"nice": 0, "max_mb": 600, "min_free_gb": 5.0, "prune_raw": False, "delay": "0.5", "tolerate_offline": False},
}
OFFLINE_RE = re.compile(r"Name or service not known|Temporary failure in name resolution|Network is unreachable|"
                        r"Connection refused|timed out|URLError|RemoteDisconnected|offline or request budget|unreachable", re.I)


def load_manifest(path=None):
    path = Path(path) if path else MANIFEST
    d = json.loads(path.read_text("utf-8"))
    steps = {s["name"]: s for s in d["steps"]}
    for i, s in enumerate(d["steps"]):
        s["_idx"] = i
        s.setdefault("args", [])
        s.setdefault("after", [])
        s.setdefault("needs", [])
        s.setdefault("fresh_hours", 0)
        for dep in s["depends"] + s["after"]:
            if dep not in steps:
                sys.exit(f"manifest: {s['name']} depends on unknown step {dep}")
        s["_dir"] = path.resolve().parent
        if not (s["_dir"] / s["script"]).exists():
            sys.exit(f"manifest: missing script {s['script']}")
    for name, lst in (d.get("after") or {}).items():
        if name in steps:
            steps[name]["after"] = sorted(set(steps[name]["after"]) | {x for x in lst if x in steps and x != name})
    return steps


def closure(steps, names):
    out, stack = set(), list(names)
    while stack:
        n = stack.pop()
        if n in out:
            continue
        out.add(n)
        stack.extend(steps[n]["depends"])
    return out


def toposort(steps, names):
    names = set(names)
    done, order = set(), []
    while len(order) < len(names):
        ready = sorted((n for n in names - done if all(d in done or d not in names for d in steps[n]["depends"] + steps[n]["after"])),
                       key=lambda n: steps[n]["_idx"])
        if not ready:
            sys.exit("dependency cycle among: " + ", ".join(sorted(names - done)))
        done.add(ready[0])
        order.append(ready[0])
    return order


def dir_mb(p):
    total = 0
    for dp, _, fs in os.walk(p):
        for f in fs:
            try:
                total += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
    return total / 1048576


def free_mb(path):
    p = Path(path)
    while not p.exists():
        p = p.parent
    return shutil.disk_usage(p).free / 1048576


def load_state(f):
    try:
        return json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return {"steps": {}}


def save_state(f, st):
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(st, indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(f)


def is_fresh(step, st, data):
    r = st["steps"].get(step["name"])
    if not r or r.get("status") != "ok":
        return False
    age_h = (time.time() - r.get("finished_ts", 0)) / 3600
    limit_h = step["fresh_hours"] if step.get("fresh_hours") else step["fresh_days"] * 24 * 0.8
    if age_h > limit_h:
        return False
    return all((data / p).exists() for p in step["produces"])


def run_step(step, data, env, timeout_s, logdir):
    logdir.mkdir(parents=True, exist_ok=True)
    log = logdir / f"{step['name']}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
    t0 = time.time()
    with open(log, "wb") as fh:
        p = subprocess.Popen([sys.executable, "-u", str(step.get("_dir", HERE) / step["script"]), *step.get("args", [])], cwd=step.get("_dir", HERE), env=env,
                             stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        status, rss = None, 0
        while True:
            pid, code, ru = os.wait4(p.pid, os.WNOHANG)
            if pid:
                rss = ru.ru_maxrss / 1024
                rc = os.waitstatus_to_exitcode(code)
                break
            if time.time() - t0 > timeout_s:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                    time.sleep(5)
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                _, code, ru = os.wait4(p.pid, 0)
                rss = ru.ru_maxrss / 1024
                rc = -1
                status = "timeout"
                break
            time.sleep(0.5)
    return rc, status, rss, time.time() - t0, log


def data_report(log):
    try:
        lines = log.read_text("utf-8", "replace").splitlines()
    except OSError:
        return None, False
    for line in reversed(lines):
        m = DATA_LINE.match(line.strip())
        if m:
            return (None if m.group(1) == "null" else m.group(1).strip('"')), m.group(2) == "true"
    return None, False


def last_data_date(log):
    return data_report(log)[0]


def tail(log, n=6):
    try:
        lines = log.read_text("utf-8", "replace").splitlines()
    except OSError:
        return []
    return lines[-n:]


def fmt_s(s):
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def print_table(rows, header):
    w = [max(len(str(r[i])) for r in rows + [header]) for i in range(len(header))]
    for r in [header] + rows:
        print("  ".join(str(c).ljust(w[i]) for i, c in enumerate(r)).rstrip())


def parse():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("names", nargs="*", help="same as --only")
    ap.add_argument("--list", action="store_true", help="list manifest steps and exit")
    ap.add_argument("--only", help="comma-separated steps; their dependencies are added")
    ap.add_argument("--skip", help="comma-separated steps to leave out")
    ap.add_argument("--no-deps", action="store_true", help="do not add dependencies of --only")
    ap.add_argument("--schedule", choices=sorted(SCHEDULES), help="6h | daily (includes 6h) | weekly (includes daily) | bootstrap (everything but manual)")
    ap.add_argument("--manifest", help="manifest file (default ingest/jobs.json)")
    ap.add_argument("--force", action="store_true", help="never skip a step as fresh")
    ap.add_argument("--lock-wait", type=float, default=None, help="seconds to wait for $STATE_DIR/update.lock (default 7200)")
    ap.add_argument("--lock-role", choices=["updater", "ingest", "ai"], default="ingest")
    ap.add_argument("--profile", choices=sorted(PROFILES), default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--resume", action="store_true", help="skip steps whose outputs are fresh in .ingest_state.json")
    ap.add_argument("--refresh", action="store_true", help="ignore HTTP cache entries")
    ap.add_argument("--prune-raw", action=argparse.BooleanOptionalAction, default=None, help="delete data/raw/<step> after success")
    ap.add_argument("--keep-raw", default="", help="comma-separated steps whose raw cache is never pruned")
    ap.add_argument("--max-mb", type=int, default=None, help="warn when a step's est_peak_mb exceeds this (default 600)")
    ap.add_argument("--min-free-gb", type=float, default=None, help="refuse a step that would leave less free disk (default 5)")
    ap.add_argument("--timeout-scale", type=float, default=1.0)
    ap.add_argument("--tolerate-offline", action=argparse.BooleanOptionalAction, default=None)
    ap.add_argument("--data", help="data dir (default $ESTADO_ABERTO_DATA or ./data)")
    return ap.parse_args()


def main():
    a = parse()
    steps = load_manifest(a.manifest)
    prof = PROFILES[a.profile or "dev"]
    max_mb = a.max_mb if a.max_mb is not None else prof["max_mb"]
    min_free = a.min_free_gb if a.min_free_gb is not None else prof["min_free_gb"]
    prune = prof["prune_raw"] if a.prune_raw is None else a.prune_raw
    tol_off = prof["tolerate_offline"] if a.tolerate_offline is None else a.tolerate_offline
    data = Path(a.data or os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()

    if a.list:
        rows = [[s["name"], s["schedule"], "yes" if s["network"] else "no", ",".join(s["depends"]) or "-", ",".join(s["produces"]),
                 s["est_minutes"], s["est_peak_mb"], s["est_disk_mb"], "" if s["enabled"] else "disabled"] for s in sorted(steps.values(), key=lambda s: s["_idx"])]
        print_table(rows, ["step", "schedule", "net", "depends", "produces", "min", "peakMB", "diskMB", ""])
        return 0

    only = [n for x in (a.names + ([a.only] if a.only else [])) for n in x.split(",") if n]
    for n in only + [x for x in (a.skip or "").split(",") if x]:
        if n not in steps:
            sys.exit(f"unknown step: {n} (see --list)")
    if only:
        sel = set(only) if a.no_deps else closure(steps, only)
    elif a.schedule:
        sel = {n for n, s in steps.items() if s["schedule"] in SCHEDULES[a.schedule]}
    else:
        sel = {n for n, s in steps.items() if s["schedule"] != "manual"}
    sel = {n for n in sel if steps[n]["enabled"] or n in only}
    sel -= {x for x in (a.skip or "").split(",") if x}
    order = toposort(steps, sel)
    keep_raw = {x for x in a.keep_raw.split(",") if x}

    env = dict(os.environ)
    env.update({"ESTADO_ABERTO_DATA": str(data), "ESTADO_ABERTO_PROFILE": a.profile or "dev",
                "PYTHONDONTWRITEBYTECODE": "1"})
    env.setdefault("ESTADO_ABERTO_DELAY", prof["delay"])
    if a.refresh:
        env["ESTADO_ABERTO_REFRESH"] = "1"

    tot_min = sum(steps[n]["est_minutes"] for n in order)
    print(f"data dir: {data}   profile: {a.profile or 'dev'}   steps: {len(order)}   est. {fmt_s(tot_min * 60)}   "
          f"free disk: {free_mb(data) / 1024:.1f} GB   limits: {max_mb} MB RAM, {min_free} GB free")
    warns = []
    for n in order:
        s = steps[n]
        if s["est_peak_mb"] > max_mb:
            warns.append(f"{n}: est_peak_mb {s['est_peak_mb']} exceeds --max-mb {max_mb}")
    if not prune:
        raw_mb = sum(steps[n]["est_disk_mb"] for n in order if steps[n]["raw"])
        if raw_mb / 1024 > free_mb(data) / 1024 - min_free:
            warns.append(f"raw caches of the selected steps (~{raw_mb / 1024:.1f} GB) may breach the disk guard; consider --prune-raw")
    for w in warns:
        print("WARN", w)

    statef = data / ".ingest_state.json"
    st = load_state(statef) if statef.exists() else {"steps": {}}
    st.setdefault("steps", {})
    use_fresh = not a.force and (a.resume or bool(a.schedule and not only))

    if a.dry_run:
        rows = []
        for n in order:
            s = steps[n]
            fresh = use_fresh and is_fresh(s, st, data)
            missing = [d for d in s["depends"] if d not in sel and not all((data / p).exists() for p in steps[d]["produces"])]
            note = "fresh, would skip" if fresh else ("missing prerequisite: " + ",".join(missing) if missing else "")
            rows.append([n, s["schedule"], ",".join(s["depends"]) or "-", s["est_minutes"], s["est_peak_mb"], s["est_disk_mb"], note])
        print_table(rows, ["step", "schedule", "depends", "min", "peakMB", "diskMB", "note"])
        return 0

    data.mkdir(parents=True, exist_ok=True)
    os.environ["ESTADO_ABERTO_DATA"] = str(data)
    from common import LockTimeout, LockUnavailable, SharedLock, append_alert
    lock = SharedLock(a.lock_role, wait=a.lock_wait)
    try:
        lock.acquire()
    except LockTimeout:
        return 75
    except LockUnavailable as e:
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {e}", flush=True)
        return LOCK_UNAVAILABLE
    if prof["nice"]:
        os.nice(prof["nice"])

    results = {}
    for pos, n in enumerate(order, 1):
        s = steps[n]
        res = results[n] = {"status": None}
        bad_dep = [d for d in s["depends"] if results.get(d, {}).get("status") in FAILED]
        missing = [d for d in s["depends"] if d not in sel and not all((data / p).exists() for p in steps[d]["produces"])]
        lacking = [p for p in s["needs"] if not (data / p).exists()]
        if lock.checkpoint():
            print("lock: resumed after yielding", flush=True)
        if bad_dep:
            res["status"], res["msg"] = "blocked", "dependency failed: " + ",".join(bad_dep)
        elif missing:
            res["status"], res["msg"] = "blocked", "missing prerequisite (run --only " + ",".join(missing) + ")"
        elif lacking:
            res["status"], res["msg"] = "skipped", "missing " + ",".join(lacking) + " (bootstrap first)"
        elif use_fresh and is_fresh(s, st, data):
            res["status"], res["msg"] = "fresh", "outputs fresh, skipped"
        if res["status"]:
            print(f"[{res['status']}] {n}: {res['msg']}", flush=True)
            continue
        existing = sum(dir_mb(data / "raw" / r) for r in s["raw"] if (data / "raw" / r).exists())
        need_gb = max(0, s["est_disk_mb"] - existing) / 1024
        free_gb = free_mb(data) / 1024
        if free_gb - need_gb < min_free and (s["network"] or s["raw"] or s["est_disk_mb"] > 1):
            res["status"] = "refused"
            res["msg"] = f"disk guard: {free_gb:.1f} GB free, step needs ~{need_gb:.1f} GB, minimum free {min_free} GB"
            print(f"[refused] {n}: {res['msg']}", flush=True)
            continue
        if s["est_peak_mb"] > max_mb:
            print(f"WARN {n}: est_peak_mb {s['est_peak_mb']} > {max_mb}", flush=True)
        base_s = s["timeout_minutes"] * 60 if s.get("timeout_minutes") else max(600, s["est_minutes"] * 3 * 60 + 600)
        timeout_s = base_s * a.timeout_scale
        print(f"[run {pos}/{len(order)}] {n} (est {s['est_minutes']} min, {s['est_peak_mb']} MB)", flush=True)
        before = free_mb(data)
        started = time.time()
        rc, tstat, rss, secs, log = run_step(s, data, env, timeout_s, data / "logs")
        res.update(rc=rc, seconds=round(secs, 1), peak_rss_mb=round(rss, 1), disk_delta_mb=round(before - free_mb(data), 1),
                   log=str(log), started_ts=started, finished_ts=time.time(),
                   started=datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds"))
        if tstat == "timeout":
            res["status"], res["msg"] = "timeout", f"killed after {fmt_s(timeout_s)}"
        elif rc == 0:
            res["status"], res["msg"] = "ok", ""
            if data_report(log)[1]:
                res["status"], res["msg"] = "partial", "deadline or source trouble; what was fetched is saved"
            if rss > max_mb:
                print(f"WARN {n}: peak RSS {rss:.0f} MB exceeded --max-mb {max_mb}", flush=True)
        else:
            t = "\n".join(tail(log, 40))
            if s["network"] and OFFLINE_RE.search(t):
                tolerated = tol_off or s["flaky"]
                res["status"] = "offline" if tolerated else "offline_fail"
                res["msg"] = f"source unreachable (rc={rc}); rerun later with --resume. Log: {log}"
            else:
                res["status"], res["msg"] = "failed", f"rc={rc}"
            for line in tail(log, 5):
                print("    |", line[:200])
        if res["status"] in ("ok", "partial") and prune and not s["keep_raw"] and n not in keep_raw:
            for r in s["raw"]:
                shutil.rmtree(data / "raw" / r, ignore_errors=True)
            res["pruned"] = True
        print(f"[{res['status']}] {n} {fmt_s(secs)} rss {rss:.0f} MB disk {res['disk_delta_mb']:+.0f} MB {res.get('msg', '')}", flush=True)
        prev = st["steps"].get(n, {})
        rec = {k: v for k, v in res.items() if k != "msg"} | {"status": res["status"]}
        for k in ("last_ok", "last_data_date"):
            if prev.get(k):
                rec[k] = prev[k]
        if res["status"] in ("ok", "partial"):
            if res["status"] == "ok":
                rec["last_ok"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            ud = last_data_date(log)
            if ud:
                rec["last_data_date"] = ud
        st["steps"][n] = rec
        st["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        save_state(statef, st)

    rows = []
    for n in order:
        r = results[n]
        rows.append([n, r["status"], fmt_s(r["seconds"]) if "seconds" in r else "-", f"{r['peak_rss_mb']:.0f}" if "peak_rss_mb" in r else "-",
                     f"{r['disk_delta_mb']:+.0f}" if "disk_delta_mb" in r else "-", r.get("msg", "")[:90]])
    print()
    print_table(rows, ["step", "status", "time", "rssMB", "diskMB", "message"])
    lock.release()
    bad = [n for n in order if results[n]["status"] in FAILED]
    part = [n for n in order if results[n]["status"] == "partial"]
    off = [n for n in order if results[n]["status"] == "offline"]
    if off:
        print("\noffline (tolerated): " + ", ".join(off) + " - rerun with --resume when the source is back")
    if part:
        print("\nPARTIAL: " + ", ".join(part))
    if bad:
        print("\nFAILED: " + ", ".join(bad))
    if FINAL_STEP in results:
        landed = results[FINAL_STEP]["status"] in ("ok", "partial", "fresh")
        worked = any(results[n]["status"] in ("ok", "partial", "fresh") for n in order)
        if not (landed and worked):
            return 1
        if bad or part:
            lines = [f"{FINAL_STEP} ran; steps needing attention:"]
            lines += [f"{n}: {results[n]['status']} {results[n].get('msg', '')}".rstrip() for n in bad + part]
            append_alert(ALERT_UNITS.get(a.schedule, "estado-aberto-ingest.service"), lines)
        return 0
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
