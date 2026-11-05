#!/usr/bin/env python3
"""One command for a new contributor: doctor checks, estimates, then build the data. Resumable. Stdlib only."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import doctor  # noqa: E402


def minimal_set(steps):
    cand = {n for n, s in steps.items() if s["schedule"] != "manual" and s["enabled"]
            and s["est_minutes"] <= 10 and s["est_disk_mb"] <= 100 and s["est_peak_mb"] <= 300}
    changed = True
    while changed:
        changed = False
        for n in list(cand):
            if any(d not in cand for d in steps[n]["depends"]):
                cand.discard(n)
                changed = True
    return cand


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--minimal", action="store_true", help="only fast, small steps")
    ap.add_argument("--yes", "-y", action="store_true", help="do not ask for confirmation")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--profile", choices=("dev", "server"), default="dev")
    ap.add_argument("--prune-raw", action=argparse.BooleanOptionalAction, default=None)
    ap.add_argument("--skip-doctor", action="store_true")
    ap.add_argument("--data", help="data dir (default $ESTADO_ABERTO_DATA or ./data)")
    ap.add_argument("--max-mb", type=int)
    ap.add_argument("--min-free-gb", type=float)
    a = ap.parse_args()
    data = Path(a.data or os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()

    if not a.skip_doctor:
        print("== checking this machine")
        rows = doctor.run_checks(data, network=True)
        for name, st, msg, hint in rows:
            print(f"[{st:>4}] {name:<22} {msg}" + (f"\n       fix: {hint}" if hint else ""))
        if any(r[1] == "FAIL" for r in rows):
            print("\nFix the FAIL items above, then run this again.")
            return 1

    steps = {s["name"]: s for s in json.loads((ROOT / "ingest" / "jobs.json").read_text("utf-8"))["steps"]}
    pick = minimal_set(steps) if a.minimal else {n for n, s in steps.items() if s["schedule"] != "manual" and s["enabled"]}
    mins = sum(steps[n]["est_minutes"] for n in pick)
    disk = sum(steps[n]["est_disk_mb"] for n in pick)
    peak = max(steps[n]["est_peak_mb"] for n in pick)
    print(f"\n== plan: {len(pick)} steps ({'minimal' if a.minimal else 'full'})")
    print(f"   time: about {mins // 60} h {mins % 60} min, steps run one at a time (sources are rate-limited, so this is mostly waiting)")
    print(f"   disk: up to ~{disk / 1024:.1f} GB with raw caches kept; final databases are smaller. --prune-raw frees caches as it goes")
    print(f"   RAM : about {peak} MB peak for the heaviest step")
    print("   data stays on this machine; nothing is uploaded. Interrupt with Ctrl-C and rerun to resume.")
    if not a.minimal:
        print("   tip: first try --minimal for a few minutes of data.")
    if a.dry_run:
        return 0
    if not a.yes and sys.stdin.isatty() and input("Continue? [y/N] ").strip().lower() not in ("y", "yes"):
        return 1

    cmd = [sys.executable, str(ROOT / "ingest" / "run_all.py"), "--resume", "--profile", a.profile, "--data", str(data)]
    cmd += ["--only", ",".join(sorted(pick)), "--no-deps"] if a.minimal else ["--schedule", "bootstrap"]
    if a.prune_raw is not None:
        cmd.append("--prune-raw" if a.prune_raw else "--no-prune-raw")
    if a.max_mb:
        cmd += ["--max-mb", str(a.max_mb)]
    if a.min_free_gb is not None:
        cmd += ["--min-free-gb", str(a.min_free_gb)]
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
