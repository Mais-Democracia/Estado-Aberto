"""Run ingest jobs: `python run_all.py` (all in ingest/jobs/) or `python run_all.py dre educacao`."""
import importlib
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "jobs"))


def main(names):
    names = names or sorted(p.stem for p in (HERE / "jobs").glob("*.py") if not p.stem.startswith("_"))
    for n in names:
        t = time.time()
        try:
            importlib.import_module(n).main()
            print(f"[ok] {n} ({time.time() - t:.0f}s)")
        except Exception:
            print(f"[FAILED] {n}"); traceback.print_exc()


if __name__ == "__main__":
    main(sys.argv[1:])
