"""Tests for ingest/run_all.py scheduling, freshness, ordering, locking and the alert writer.
Run: python3 -m unittest discover ingest/tests"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INGEST = HERE.parent
ROOT = INGEST.parent
sys.path.insert(0, str(INGEST))
from common import LockTimeout, LockUnavailable, SharedLock  # noqa: E402

RUN_ALL = INGEST / "run_all.py"
ALERT = ROOT / "ops" / "updater" / "alert.sh"

STUB = """import json, os, sys
open(os.environ["ORDER_FILE"], "a").write(os.path.basename(sys.argv[0])[:-3] + " " + " ".join(sys.argv[1:]) + "\\n")
if os.path.basename(sys.argv[0]) == "boom.py":
    sys.exit(3)
if os.path.basename(sys.argv[0]) == "dated.py":
    print(json.dumps({"ultima_data": "2026-05-04"}))
if os.path.basename(sys.argv[0]) == "part.py":
    print(json.dumps({"ultima_data": "2026-05-04", "parcial": True}))
if os.path.basename(sys.argv[0]) == "slow.py":
    import time
    time.sleep(60)
"""


def step(name, schedule, **kw):
    s = {"name": name, "script": kw.pop("script", name + ".py"), "depends": [], "produces": [], "network": False, "est_minutes": 1,
         "est_peak_mb": 10, "est_disk_mb": 1, "schedule": schedule, "enabled": True, "fresh_days": 0, "raw": [], "keep_raw": False,
         "flaky": False, "licence": "none", "notes": ""}
    s.update(kw)
    return s


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.jobs = self.t / "jobs"
        self.data = self.t / "data"
        self.state = self.t / "state"
        for d in (self.jobs, self.data, self.state):
            d.mkdir()
        self.order = self.t / "order.txt"
        self.env = dict(os.environ, ORDER_FILE=str(self.order), STATE_DIR=str(self.state), EA_LOCK_POLL="0.1", ESTADO_ABERTO_DATA=str(self.data))

    def tearDown(self):
        self.tmp.cleanup()

    def manifest(self, steps, after=None):
        for s in steps:
            (self.jobs / s["script"]).write_text(STUB)
        d = {"version": 1, "helpers": [], "steps": steps}
        if after:
            d["after"] = after
        (self.jobs / "jobs.json").write_text(json.dumps(d))

    def run_all(self, *args, timeout=60):
        return subprocess.run([sys.executable, str(RUN_ALL), "--manifest", str(self.jobs / "jobs.json"), "--data", str(self.data), *args],
                              env=self.env, capture_output=True, text=True, timeout=timeout)

    def ran(self):
        return [ln.split()[0] for ln in self.order.read_text().splitlines()] if self.order.exists() else []

    def selected(self, *args):
        r = self.run_all("--dry-run", *args)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        rows = r.stdout.split("step ", 1)[1].splitlines()[1:]
        return [ln.split()[0] for ln in rows if ln.strip()]


class ScheduleSelection(Env):
    def setUp(self):
        super().setUp()
        self.manifest([step("a6", "6h"), step("b6", "6h"), step("d1", "daily"), step("w1", "weekly"), step("boot", "bootstrap"), step("man", "manual")])

    def test_6h(self):
        self.assertEqual(self.selected("--schedule", "6h"), ["a6", "b6"])

    def test_daily_includes_6h(self):
        self.assertEqual(self.selected("--schedule", "daily"), ["a6", "b6", "d1"])

    def test_weekly_includes_both(self):
        self.assertEqual(self.selected("--schedule", "weekly"), ["a6", "b6", "d1", "w1"])

    def test_bootstrap_everything_but_manual(self):
        self.assertEqual(self.selected("--schedule", "bootstrap"), ["a6", "b6", "d1", "w1", "boot"])

    def test_disabled_step_left_out(self):
        self.manifest([step("a6", "6h"), step("off", "6h", enabled=False)])
        self.assertEqual(self.selected("--schedule", "6h"), ["a6"])

    def test_step_args_reach_the_script(self):
        self.manifest([step("rec", "6h", script="dated.py", args=["--since", "5"])])
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 0)
        self.assertEqual(self.order.read_text().strip(), "dated --since 5")


class Freshness(Env):
    def setUp(self):
        super().setUp()
        self.manifest([step("a6", "6h", fresh_hours=5, produces=["x.db"]), step("d1", "daily", fresh_days=1)])
        (self.data / "x.db").write_text("x")

    def state_file(self):
        return self.data / ".ingest_state.json"

    def test_second_schedule_run_skips_fresh_steps(self):
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 0)
        self.assertEqual(self.ran(), ["a6"])
        r = self.run_all("--schedule", "6h")
        self.assertIn("[fresh] a6", r.stdout)
        self.assertEqual(self.ran(), ["a6"])

    def test_step_older_than_fresh_hours_runs_again(self):
        self.run_all("--schedule", "6h")
        st = json.loads(self.state_file().read_text())
        st["steps"]["a6"]["finished_ts"] = time.time() - 6 * 3600
        self.state_file().write_text(json.dumps(st))
        self.run_all("--schedule", "6h")
        self.assertEqual(self.ran(), ["a6", "a6"])

    def test_step_inside_fresh_hours_still_skipped(self):
        self.run_all("--schedule", "6h")
        st = json.loads(self.state_file().read_text())
        st["steps"]["a6"]["finished_ts"] = time.time() - 4 * 3600
        self.state_file().write_text(json.dumps(st))
        self.run_all("--schedule", "6h")
        self.assertEqual(self.ran(), ["a6"])

    def test_force_ignores_freshness(self):
        self.run_all("--schedule", "6h")
        self.run_all("--schedule", "6h", "--force")
        self.assertEqual(self.ran(), ["a6", "a6"])

    def test_missing_output_means_not_fresh(self):
        self.run_all("--schedule", "6h")
        (self.data / "x.db").unlink()
        self.run_all("--schedule", "6h")
        self.assertEqual(self.ran(), ["a6", "a6"])

    def test_daily_run_skips_6h_steps_refreshed_recently(self):
        self.run_all("--schedule", "6h")
        self.run_all("--schedule", "daily")
        self.assertEqual(self.ran(), ["a6", "d1"])


class Ordering(Env):
    def test_after_orders_without_pulling_in(self):
        self.manifest([step("last", "6h", after=["a", "b"]), step("a", "6h"), step("b", "6h")])
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 0)
        self.assertEqual(self.ran(), ["a", "b", "last"])

    def test_after_does_not_select_unselected_steps(self):
        self.manifest([step("x", "6h", after=["w"]), step("w", "weekly")])
        self.assertEqual(self.selected("--schedule", "6h"), ["x"])

    def test_top_level_after_map_places_a_step_last(self):
        self.manifest([step("diario", "6h"), step("m", "6h"), step("rec", "6h")], after={"diario": ["m", "rec", "absent"]})
        self.run_all("--schedule", "6h")
        self.assertEqual(self.ran()[-1], "diario")
        self.assertEqual(sorted(self.ran()), ["diario", "m", "rec"])

    def test_after_map_for_missing_step_is_ignored(self):
        self.manifest([step("m", "6h")], after={"diario": ["m"]})
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 0)

    def test_failed_after_step_does_not_block_the_last_one(self):
        self.manifest([step("boom", "6h"), step("diario", "6h")], after={"diario": ["boom"]})
        r = self.run_all("--schedule", "6h")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(self.ran(), ["boom", "diario"])

    def test_after_ordering_does_not_block_when_the_earlier_step_fails(self):
        self.manifest([step("boom", "6h"), step("later", "6h", after=["boom"])])
        r = self.run_all("--schedule", "6h")
        self.assertIn("[ok] later", r.stdout)
        self.assertEqual(self.ran(), ["boom", "later"])

    def test_failed_dependency_blocks(self):
        self.manifest([step("boom", "6h"), step("child", "6h", depends=["boom"])])
        r = self.run_all("--schedule", "6h")
        self.assertIn("[blocked] child", r.stdout)
        self.assertEqual(self.ran(), ["boom"])

    def test_needs_missing_output_skips_without_failing(self):
        self.manifest([step("rec", "6h", needs=["dre.db"])])
        r = self.run_all("--schedule", "6h")
        self.assertEqual(r.returncode, 0)
        self.assertIn("[skipped] rec", r.stdout)
        self.assertEqual(self.ran(), [])

    def test_dependency_cycle_through_after_is_rejected(self):
        self.manifest([step("a", "6h", after=["b"]), step("b", "6h", after=["a"])])
        self.assertNotEqual(self.run_all("--schedule", "6h").returncode, 0)


class IngestState(Env):
    def steps_state(self):
        return json.loads((self.data / ".ingest_state.json").read_text())["steps"]

    def test_last_ok_and_last_data_date_recorded(self):
        self.manifest([step("rec", "6h", script="dated.py"), step("plain", "6h")])
        self.run_all("--schedule", "6h")
        st = self.steps_state()
        self.assertEqual(st["rec"]["last_data_date"], "2026-05-04")
        self.assertTrue(st["rec"]["last_ok"].endswith("+00:00"))
        self.assertNotIn("last_data_date", st["plain"])

    def test_last_ok_survives_a_later_failure(self):
        self.manifest([step("s", "6h", script="dated.py")])
        self.run_all("--schedule", "6h")
        first = self.steps_state()["s"]["last_ok"]
        (self.jobs / "dated.py").write_text("import sys\nsys.exit(2)\n")
        r = self.run_all("--schedule", "6h", "--force")
        self.assertEqual(r.returncode, 1)
        st = self.steps_state()["s"]
        self.assertEqual(st["status"], "failed")
        self.assertEqual(st["last_ok"], first)
        self.assertEqual(st["last_data_date"], "2026-05-04")


class Partial(Env):
    def alerts(self):
        return json.loads((self.state / "alerts.json").read_text())["alerts"]

    def test_partial_step_is_reported_and_does_not_block_dependents(self):
        self.manifest([step("part", "6h", produces=["p.db"]), step("child", "6h", depends=["part"])])
        r = self.run_all("--schedule", "6h")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("[partial] part", r.stdout)
        self.assertIn("[ok] child", r.stdout)
        self.assertIn("PARTIAL: part", r.stdout)
        self.assertEqual(self.ran(), ["part", "child"])

    def test_partial_records_data_date_but_not_last_ok_and_is_not_fresh(self):
        self.manifest([step("part", "6h", fresh_hours=5, produces=["p.db"])])
        (self.data / "p.db").write_text("x")
        self.run_all("--schedule", "6h")
        st = json.loads((self.data / ".ingest_state.json").read_text())["steps"]["part"]
        self.assertEqual(st["status"], "partial")
        self.assertEqual(st["last_data_date"], "2026-05-04")
        self.assertNotIn("last_ok", st)
        self.run_all("--schedule", "6h")
        self.assertEqual(self.ran(), ["part", "part"])

    def test_optional_failure_with_diario_ok_exits_zero_and_writes_alert(self):
        self.manifest([step("boom", "6h"), step("part", "6h"), step("diario", "6h")], after={"diario": ["boom", "part"]})
        r = self.run_all("--schedule", "6h")
        self.assertEqual(r.returncode, 0, r.stdout)
        a = self.alerts()
        self.assertEqual(len(a), 1)
        self.assertEqual(a[0]["unit"], "estado-aberto-refresh.service")
        text = "\n".join(a[0]["lines"])
        self.assertIn("boom: failed", text)
        self.assertIn("part: partial", text)

    def test_clean_run_writes_no_alert(self):
        self.manifest([step("a", "6h"), step("diario", "6h")], after={"diario": ["a"]})
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 0)
        self.assertFalse((self.state / "alerts.json").exists())

    def test_diario_failure_exits_nonzero(self):
        self.manifest([step("a", "6h"), step("diario", "6h", script="boom.py")], after={"diario": ["a"]})
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 1)

    def test_diario_blocked_by_failed_dependency_exits_nonzero(self):
        self.manifest([step("boom", "6h"), step("diario", "6h", depends=["boom"])])
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 1)

    def test_failure_without_diario_still_exits_nonzero(self):
        self.manifest([step("boom", "6h"), step("a", "6h")])
        self.assertEqual(self.run_all("--schedule", "6h").returncode, 1)

    def test_hung_step_is_killed_at_its_manifest_timeout(self):
        self.manifest([step("slow", "6h", script="slow.py", timeout_minutes=1), step("diario", "6h")], after={"diario": ["slow"]})
        t0 = time.time()
        r = self.run_all("--schedule", "6h", "--timeout-scale", "0.03", timeout=60)
        self.assertLess(time.time() - t0, 30)
        self.assertIn("[timeout] slow", r.stdout)
        self.assertEqual(r.returncode, 0)


VOTACOES_SNIPPET = """
import os, socket, sys, threading, time, json
sys.path.insert(0, os.path.join(sys.argv[1], "jobs"))
sys.path.insert(0, sys.argv[1])
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(16)
conns = []
threading.Thread(target=lambda: [conns.append(srv.accept()) for _ in iter(int, 1)], daemon=True).start()
sys.argv = ["votacoes.py"] + sys.argv[2:]
import votacoes
votacoes.LIST_URL = "http://127.0.0.1:%d/x" % srv.getsockname()[1]
t0 = time.time()
votacoes.main()
print("elapsed", round(time.time() - t0, 1))
"""


class VotacoesDeadline(Env):
    def run_snippet(self, *args, **env):
        e = dict(self.env, VOTACOES_SLEEP="0", ESTADO_ABERTO_READ_TIMEOUT="0.5", ESTADO_ABERTO_CONNECT_TIMEOUT="0.5", **env)
        return subprocess.run([sys.executable, "-c", VOTACOES_SNIPPET, str(INGEST), *args], env=e, capture_output=True, text=True, timeout=60, cwd=self.t)

    def test_stalling_server_ends_in_partial_success_at_the_deadline(self):
        t0 = time.time()
        r = self.run_snippet("--since", "14", "--deadline", "3")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertLess(time.time() - t0, 30)
        last = [ln for ln in r.stdout.splitlines() if ln.startswith('{"ultima_data"')][-1]
        self.assertEqual(json.loads(last), {"ultima_data": None, "parcial": True})
        self.assertIn("votacoes: {", r.stdout)

    def test_deadline_defaults_to_eight_minutes_for_since_and_is_configurable(self):
        base = ("import os,sys; sys.path.insert(0, %r); sys.path.insert(0, %r); sys.argv=['votacoes.py']+%%r; import votacoes; print(votacoes.DEADLINE_S)"
                % (str(INGEST / "jobs"), str(INGEST)))

        def deadline(argv, **env):
            e = {k: v for k, v in self.env.items() if k != "VOTACOES_DEADLINE_S"}
            e.update(env)
            return subprocess.run([sys.executable, "-c", base % argv], env=e, capture_output=True, text=True, cwd=self.t).stdout.strip()
        self.assertEqual(deadline(["--since", "14"]), "480.0")
        self.assertEqual(deadline(["--since", "14", "--deadline", "90"]), "90.0")
        self.assertEqual(deadline(["--since", "14"], VOTACOES_DEADLINE_S="120"), "120.0")
        self.assertEqual(deadline([]), "0.0")


class Locking(Env):
    def test_unopenable_lock_file_fails_fast_with_distinct_exit(self):
        self.manifest([step("a", "6h")])
        (self.state / "update.lock").mkdir()
        t0 = time.time()
        r = self.run_all("--schedule", "6h", "--lock-wait", "1500")
        self.assertEqual(r.returncode, 77, r.stdout + r.stderr)
        self.assertLess(time.time() - t0, 10)
        self.assertIn("cannot open", r.stdout)
        self.assertNotIn("waiting for", r.stdout)
        self.assertEqual(self.ran(), [])

    def test_unopenable_lock_raises_without_waiting(self):
        (self.state / "update.lock").mkdir()
        t0 = time.time()
        with self.assertRaises(LockUnavailable):
            SharedLock("ai", wait=1500, state=self.state, log=lambda m: None).acquire()
        self.assertLess(time.time() - t0, 5)

    @unittest.skipIf(os.getuid() == 0, "root ignores directory permissions")
    def test_read_only_state_dir_raises_without_waiting(self):
        ro = self.t / "ro"
        ro.mkdir()
        ro.chmod(0o555)
        t0 = time.time()
        with self.assertRaises(LockUnavailable):
            SharedLock("ai", wait=1500, state=ro, log=lambda m: None).acquire()
        self.assertLess(time.time() - t0, 5)
        ro.chmod(0o755)

    def test_new_state_dir_and_lock_file_are_group_writable(self):
        st = self.t / "fresh" / "state"
        SharedLock("ingest", wait=1, state=st, log=lambda m: None).acquire().release()
        self.assertEqual(oct((st / "update.lock").stat().st_mode & 0o7777), "0o660")
        self.assertEqual(oct(st.stat().st_mode & 0o7777), "0o2770")

    def test_existing_owned_lock_file_without_group_write_is_repaired(self):
        f = self.state / "update.lock"
        f.write_text("ingest 1\n")
        f.chmod(0o644)
        SharedLock("ai", wait=1, state=self.state, log=lambda m: None).acquire().release()
        self.assertEqual(oct(f.stat().st_mode & 0o7777), "0o660")

    def test_holder_of_a_free_lock_is_never_named(self):
        (self.state / "update.lock").write_text("ingest 999999\n")
        self.assertIn("nobody", SharedLock("ai", state=self.state, log=lambda m: None).holder())

    def test_holder_of_a_held_lock_is_its_recorded_owner(self):
        a = SharedLock("ingest", wait=1, state=self.state, log=lambda m: None).acquire()
        self.assertEqual(SharedLock("ai", state=self.state, log=lambda m: None).holder(), f"ingest {os.getpid()}")
        a.release()

    def test_stale_owner_record_on_a_held_lock_is_ignored(self):
        a = SharedLock("ingest", wait=1, state=self.state, log=lambda m: None).acquire()
        os.pwrite(a.fd, b"ingest 999999\n", 0)
        os.ftruncate(a.fd, len(b"ingest 999999\n"))
        self.assertIn("stale", SharedLock("ai", state=self.state, log=lambda m: None).holder())
        a.release()

    def test_contention_times_out_with_clear_log(self):
        self.manifest([step("a", "6h")])
        with SharedLock("ingest", wait=1, state=self.state, log=lambda m: None):
            t0 = time.time()
            r = self.run_all("--schedule", "6h", "--lock-wait", "1")
        self.assertEqual(r.returncode, 75, r.stdout + r.stderr)
        self.assertIn("gave up after 1s waiting for update.lock held by ingest", r.stdout)
        self.assertLess(time.time() - t0, 20)
        self.assertEqual(self.ran(), [])

    def test_waiter_proceeds_once_lock_is_released(self):
        self.manifest([step("a", "6h")])
        lock = SharedLock("updater", wait=1, state=self.state, log=lambda m: None).acquire()
        p = subprocess.Popen([sys.executable, str(RUN_ALL), "--manifest", str(self.jobs / "jobs.json"), "--data", str(self.data),
                              "--schedule", "6h", "--lock-wait", "30"], env=self.env, stdout=subprocess.PIPE, text=True)
        time.sleep(1.0)
        self.assertIsNone(p.poll())
        lock.release()
        out, _ = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 0, out)
        self.assertIn("waiting for update.lock", out)
        self.assertEqual(self.ran(), ["a"])

    def test_lock_file_lives_in_state_dir(self):
        with SharedLock("ingest", state=self.state, log=lambda m: None):
            self.assertTrue((self.state / "update.lock").exists())
            self.assertTrue((self.state / "update.lock").read_text().startswith("ingest "))

    def test_released_lock_can_be_taken_again(self):
        SharedLock("ingest", state=self.state, log=lambda m: None).acquire().release()
        with SharedLock("ai", wait=1, state=self.state, log=lambda m: None):
            pass

    def test_two_holders_never_overlap(self):
        a = SharedLock("ingest", wait=1, state=self.state, log=lambda m: None).acquire()
        with self.assertRaises(LockTimeout):
            SharedLock("ai", wait=0.5, poll=0.1, state=self.state, log=lambda m: None).acquire()
        a.release()

    def waiting_peer(self, role):
        peer = subprocess.Popen(["sleep", "30"])
        self.addCleanup(peer.kill)
        (self.state / f"lock.want.{role}.{peer.pid}").write_text(str(peer.pid))
        return peer

    def test_pending_updater_goes_before_ingest_on_a_free_lock(self):
        self.waiting_peer("updater")
        with self.assertRaises(LockTimeout):
            SharedLock("ingest", wait=0.5, poll=0.1, state=self.state, log=lambda m: None).acquire()

    def test_pending_ingest_goes_before_ai(self):
        self.waiting_peer("ingest")
        with self.assertRaises(LockTimeout):
            SharedLock("ai", wait=0.5, poll=0.1, state=self.state, log=lambda m: None).acquire()

    def test_pending_ai_does_not_hold_back_ingest(self):
        self.waiting_peer("ai")
        SharedLock("ingest", wait=1, poll=0.1, state=self.state, log=lambda m: None).acquire().release()

    def test_dead_waiter_is_ignored_and_cleaned(self):
        dead = subprocess.Popen(["true"])
        dead.wait()
        f = self.state / f"lock.want.updater.{dead.pid}"
        f.write_text(str(dead.pid))
        SharedLock("ingest", wait=1, poll=0.1, state=self.state, log=lambda m: None).acquire().release()
        self.assertFalse(f.exists())

    def test_holder_yields_between_steps_to_a_pending_updater(self):
        holder = SharedLock("ingest", wait=3, poll=0.1, state=self.state, log=lambda m: None).acquire()
        self.assertFalse(holder.checkpoint())
        self.waiting_peer("updater")
        self.assertTrue(holder.fd is not None)
        got = []
        import threading
        t = threading.Thread(target=lambda: got.append(holder.checkpoint()))
        t.start()
        time.sleep(0.5)
        self.assertIsNone(holder.fd)
        t.join(0)
        for f in self.state.glob("lock.want.updater.*"):
            f.unlink()
        t.join(5)
        self.assertEqual(got, [True])
        holder.release()

    def test_inherited_lock_is_not_retaken(self):
        outer = SharedLock("ingest", wait=1, state=self.state, log=lambda m: None).acquire()
        os.environ["EA_LOCK_HELD"] = "1"
        try:
            SharedLock("ingest", wait=0.2, state=self.state, log=lambda m: None).acquire()
        finally:
            del os.environ["EA_LOCK_HELD"]
            outer.release()


class AlertWriter(Env):
    def alert(self, unit, journal):
        env = dict(self.env, JOURNAL_CMD=journal, ESTADO_ABERTO_PYTHON=sys.executable)
        return subprocess.run(["bash", str(ALERT), unit], env=env, capture_output=True, text=True, timeout=60)

    def test_entry_has_unit_time_and_last_20_lines(self):
        r = self.alert("estado-aberto-refresh.service", "seq 1 50")
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads((self.state / "alerts.json").read_text())
        self.assertEqual(d["version"], 1)
        e = d["alerts"][0]
        self.assertEqual(e["unit"], "estado-aberto-refresh.service")
        self.assertRegex(e["time"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$")
        self.assertEqual(e["lines"], [str(i) for i in range(31, 51)])

    def test_entries_append_and_cap(self):
        for i in range(3):
            self.alert(f"u{i}.service", "echo hi")
        d = json.loads((self.state / "alerts.json").read_text())
        self.assertEqual([a["unit"] for a in d["alerts"]], ["u0.service", "u1.service", "u2.service"])
        env = dict(self.env, JOURNAL_CMD="echo hi", ALERT_MAX="2", ESTADO_ABERTO_PYTHON=sys.executable)
        subprocess.run(["bash", str(ALERT), "u3.service"], env=env, check=True, timeout=60)
        d = json.loads((self.state / "alerts.json").read_text())
        self.assertEqual([a["unit"] for a in d["alerts"]], ["u2.service", "u3.service"])

    def test_corrupt_file_is_replaced(self):
        (self.state / "alerts.json").write_text("{not json")
        self.assertEqual(self.alert("u.service", "echo x").returncode, 0)
        self.assertEqual(len(json.loads((self.state / "alerts.json").read_text())["alerts"]), 1)

    def test_journal_failure_still_records_the_alert(self):
        self.assertEqual(self.alert("u.service", "false").returncode, 0)
        self.assertEqual(json.loads((self.state / "alerts.json").read_text())["alerts"][0]["lines"], [])


class RealManifest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(INGEST))
        import run_all
        self.steps = run_all.load_manifest()

    def test_manifest_loads_and_has_no_cycle(self):
        import run_all
        order = run_all.toposort(self.steps, set(self.steps))
        self.assertEqual(len(order), len(self.steps))

    def test_6h_set(self):
        got = {n for n, s in self.steps.items() if s["schedule"] == "6h"}
        self.assertTrue({"migrate", "agenda", "government", "news", "dre_recent", "votacoes_recent", "presidencia_recent", "contracts_recent"} <= got)

    def test_recent_steps_are_incremental_and_light(self):
        for n in ("dre_recent", "votacoes_recent", "presidencia_recent", "contracts_recent", "intervencoes_recent", "justica_tc_recent", "reguladores_recent"):
            s = self.steps[n]
            self.assertIn("--since", s["args"], n)
            self.assertLess(s["est_peak_mb"], 300, n)
            self.assertEqual(s["raw"], [], n)

    def test_6h_steps_have_fresh_hours(self):
        for n, s in self.steps.items():
            if s["schedule"] == "6h" and n != "diario":
                self.assertGreater(s["fresh_hours"], 0, n)

    def test_diario_last_in_6h_set_when_present(self):
        import run_all
        steps = dict(self.steps)
        if "diario" not in steps:
            extra = dict(steps["news"], name="diario", depends=[], after=sorted(self.steps_with_after()), _idx=len(steps))
            steps["diario"] = extra
        sel = {n for n, s in steps.items() if s["schedule"] == "6h"}
        self.assertEqual(run_all.toposort(steps, sel)[-1], "diario")

    def steps_with_after(self):
        import json as j
        return {x for x in j.loads((INGEST / "jobs.json").read_text())["after"]["diario"]}


if __name__ == "__main__":
    unittest.main()
