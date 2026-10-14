from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import registry


SCRIPTS = str(Path(__file__).resolve().parents[1] / "scripts")
WRITER = '''import json
import sys
import time
sys.path.insert(0, sys.argv[1])
import registry

sys.stdin.readline()
mode = sys.argv[2]
sequences = []
def increment(doc):
    value = doc["config"].get("counter", 0)
    time.sleep(0.001)
    doc["config"]["counter"] = value + 1
for index in range(50):
    if mode == "counter":
        registry.update(increment)
    else:
        sequences.append(registry.append_event("observed", {"index": index}))
print(json.dumps(sequences))
'''


class RegistryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "state"
        patcher = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def two_writers(self, mode):
        processes = []
        try:
            for _ in range(2):
                processes.append(subprocess.Popen(
                    [sys.executable, "-c", WRITER, SCRIPTS, mode],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, cwd=self.home.parent,
                ))
            for process in processes:
                process.stdin.write("go\n")
                process.stdin.flush()
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 0, stderr)
                results.append(json.loads(stdout))
            return results
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate()

    def test_missing_registry_returns_a_fresh_document(self):
        expected = {
            "version": 1, "workers": {}, "queue": [], "holds": {},
            "actions": {}, "event_seq": 0, "ack_seq": 0, "config": {},
        }
        self.assertEqual(registry.load(), expected)
        doc = registry.load()
        doc["workers"]["changed"] = {}
        doc["queue"].append("changed")
        self.assertEqual(registry.load(), expected)
        self.assertEqual(registry.read_events(0), [])

    def test_default_home_is_under_localappdata(self):
        del os.environ["HERDR_COORD_HOME"]
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.home.parent)}):
            registry.save(registry.load())
            self.assertTrue((self.home.parent / "herdr-coordinator" / "registry.json").is_file())

    def test_worker_round_trip_and_update_return_saved_document(self):
        worker = {
            "repo": "C:/repos/example", "issue": 12, "worktree": "C:/repos/example-w12",
            "branch": "issue-12", "workspace_id": "w1", "pane_id": "w1:p1",
            "agent_name": "worker-12", "session_id": "session-12",
            "entry_command": "/ce-work #12", "state": "running",
        }
        doc = registry.update(lambda state: state["workers"].update({"12": worker}))
        self.assertEqual(registry.load(), doc)
        self.assertEqual(registry.load()["workers"]["12"], worker)
        registry.save(doc)
        self.assertEqual(registry.load(), doc)

    def test_unknown_version_is_rejected(self):
        for version in (2, None, True, "1"):
            with self.subTest(version=version):
                registry.save({"version": version})
                with self.assertRaises(ValueError):
                    registry.load()

    def test_process_crash_after_temp_write_keeps_previous_registry(self):
        original = registry.load()
        original["config"]["counter"] = 7
        registry.save(original)
        before = (self.home / "registry.json").read_bytes()
        script = '''import os
import sys
sys.path.insert(0, sys.argv[1])
import registry
doc = registry.load()
doc["config"]["counter"] = 99
registry.os.replace = lambda source, target: os._exit(23)
registry.save(doc)
'''
        result = subprocess.run(
            [sys.executable, "-c", script, SCRIPTS],
            capture_output=True, text=True, timeout=10, cwd=self.home.parent,
        )
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual((self.home / "registry.json").read_bytes(), before)
        self.assertEqual(registry.load(), original)
        temps = list(self.home.glob("registry-*.tmp"))
        self.assertEqual(len(temps), 1)
        self.assertEqual(json.loads(temps[0].read_text(encoding="utf-8"))["config"]["counter"], 99)

    def test_two_process_updates_do_not_lose_increments(self):
        self.two_writers("counter")
        self.assertEqual(registry.load()["config"]["counter"], 100)

    def test_replace_retries_once_and_then_succeeds(self):
        replace = os.replace
        calls = []

        def fail_once(source, target):
            calls.append((source, target))
            if len(calls) == 1:
                raise PermissionError("file is open")
            return replace(source, target)

        doc = registry.load()
        doc["workers"]["12"] = {"workspace_id": "w1"}
        with mock.patch.object(registry.os, "replace", side_effect=fail_once):
            registry.save(doc)
        self.assertEqual(len(calls), 2)
        self.assertEqual(registry.load(), doc)
        self.assertEqual(list(self.home.glob("registry-*.tmp")), [])

    def test_replace_failure_is_bounded_and_preserves_previous_registry(self):
        original = registry.load()
        registry.save(original)
        changed = registry.load()
        changed["config"]["counter"] = 99
        with mock.patch.object(registry.os, "replace", side_effect=PermissionError("file is open")) as replace:
            with self.assertRaises(PermissionError):
                registry.save(changed)
        self.assertEqual(replace.call_count, registry._REPLACE_ATTEMPTS)
        self.assertEqual(registry.load(), original)
        self.assertEqual(list(self.home.glob("registry-*.tmp")), [])

    def test_update_exception_does_not_save_and_releases_lock(self):
        original = registry.load()
        registry.save(original)

        def fail(doc):
            doc["config"]["counter"] = 99
            raise RuntimeError("stop")

        with self.assertRaises(RuntimeError):
            registry.update(fail)
        self.assertEqual(registry.load(), original)
        registry.update(lambda doc: doc["config"].update({"counter": 1}))
        self.assertEqual(registry.load()["config"]["counter"], 1)

    def test_lock_excludes_another_process_until_context_exits(self):
        script = '''import sys
sys.path.insert(0, sys.argv[1])
import registry
try:
    with registry.locked(timeout=0.1):
        print("acquired")
except TimeoutError:
    print("blocked")
'''
        with registry.locked():
            result = subprocess.run(
                [sys.executable, "-c", script, SCRIPTS], capture_output=True,
                text=True, timeout=60, cwd=self.home.parent,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "blocked")
        result = subprocess.run(
            [sys.executable, "-c", script, SCRIPTS], capture_output=True,
            text=True, timeout=60, cwd=self.home.parent,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "acquired")

    def test_events_are_consecutive_across_processes_and_ack_is_monotonic(self):
        assigned = self.two_writers("events")
        self.assertEqual(sorted(assigned[0] + assigned[1]), list(range(1, 101)))
        events = registry.read_events(0)
        self.assertEqual([event["seq"] for event in events], list(range(1, 101)))
        self.assertEqual(registry.load()["event_seq"], 100)
        for event in events:
            self.assertEqual(set(event), {"seq", "ts", "kind", "payload"})
            self.assertEqual(event["kind"], "observed")
            self.assertTrue(event["ts"].endswith("+00:00"))
        self.assertEqual([event["seq"] for event in registry.read_events(60)], list(range(61, 101)))
        self.assertEqual(registry.read_events(100), [])
        registry.ack(75)
        registry.ack(5)
        self.assertEqual(registry.load()["ack_seq"], 75)
        registry.ack(100)
        self.assertEqual(registry.load()["ack_seq"], 100)

    def test_event_sequence_recovers_when_previous_registry_save_failed(self):
        with mock.patch.object(registry, "save", side_effect=RuntimeError("stop after append")):
            with self.assertRaises(RuntimeError):
                registry.append_event("first", {"message": "recorded"})
        self.assertEqual(registry.load()["event_seq"], 1)
        self.assertEqual(registry.append_event("second", {}), 2)
        self.assertEqual([event["seq"] for event in registry.read_events(0)], [1, 2])
        self.assertEqual(registry.load()["event_seq"], 2)

    def test_state_and_event_recover_at_each_process_crash_boundary(self):
        script = '''import os
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import actions
import registry
stage = sys.argv[2]
replace = registry.os.replace
recover = registry._recover_transaction
def crash_replace(source, target):
    if Path(target).name == "registry.json":
        if stage == "after_event":
            os._exit(23)
        replace(source, target)
        os._exit(23)
    replace(source, target)
def crash_before_events():
    if registry._pending_transaction() is not None:
        os._exit(23)
    recover()
if stage == "before_event":
    registry._recover_transaction = crash_before_events
else:
    registry.os.replace = crash_replace
actions.change_worker("worker", "question", question_text="Q1", now=123)
'''
        for stage in ("before_event", "after_event", "after_replace"):
            with self.subTest(stage=stage), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.home / stage)}):
                registry.update(lambda doc: doc["workers"].update({"worker": {
                    "worker_id": "worker", "state": "running", "state_token": "running-1"}}))
                result = subprocess.run([sys.executable, "-c", script, SCRIPTS, stage],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 23, result.stderr)
                persisted = json.loads((registry._home() / "registry.json").read_text(encoding="utf-8"))
                self.assertEqual(persisted["workers"]["worker"]["state"],
                                 "question" if stage == "after_replace" else "running")
                event_path = registry._home() / "events.jsonl"
                if stage == "before_event":
                    self.assertFalse(event_path.exists())
                else:
                    self.assertEqual(len(event_path.read_text(encoding="utf-8").splitlines()), 1)
                # A lock-taking read completes recovery; retrying the observation
                # after restart must neither lose the event nor append it twice.
                events = registry.read_events(0)
                import actions
                current = actions.change_worker("worker", "question", question_text="Q1", now=456)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["seq"], 1)
                self.assertEqual(events[0]["kind"], "worker_state")
                self.assertEqual(events[0]["payload"], current)
                self.assertEqual(current["last_change"], 123)
                self.assertEqual(registry.load()["event_seq"], 1)
                self.assertEqual(registry.read_events(0), events)
                self.assertFalse((registry._home() / "transaction.json").exists())
                self.assertEqual(registry.append_event("next", {}), 2)
                self.assertEqual([e["seq"] for e in registry.read_events(0)], [1, 2])

    def test_atomic_update_recovers_multiple_events_without_replaying_callback(self):
        calls = []

        def change(doc, events):
            calls.append(True)
            doc["config"]["counter"] = doc["config"].get("counter", 0) + 1
            events.extend([("first", {"counter": 1}), ("second", {"counter": 1})])

        with mock.patch.object(registry, "save", side_effect=RuntimeError("after append")):
            with self.assertRaises(RuntimeError):
                registry.update_with_events(change)
        self.assertEqual(registry.append_event("third", {}), 3)
        self.assertEqual(calls, [True])
        self.assertEqual(registry.load()["config"]["counter"], 1)
        self.assertEqual([e["seq"] for e in registry.read_events(0)], [1, 2, 3])

    def test_atomic_update_callback_failure_commits_neither_state_nor_event(self):
        def fail(doc, events):
            doc["config"]["counter"] = 99
            events.append(("uncommitted", {}))
            raise RuntimeError("stop")

        with self.assertRaises(RuntimeError):
            registry.update_with_events(fail)
        self.assertNotIn("counter", registry.load()["config"])
        self.assertEqual(registry.read_events(0), [])

    def test_large_event_tail_is_read_across_chunk_boundaries(self):
        payload = {"message": "x" * 10000}
        self.assertEqual(registry.append_event("large", payload), 1)
        self.assertEqual(registry.append_event("after", {}), 2)
        self.assertEqual(registry.read_events(0)[0]["payload"], payload)

    def test_reconcile_marks_only_registered_missing_workspaces_once(self):
        doc = registry.load()
        doc["workers"] = {
            "12": {"workspace_id": "gone", "state": "running", "session_id": "s12"},
            "13": {"workspace_id": "present", "state": "running"},
            "14": {"state": "queued"},
        }
        workspaces = [{"id": "present"}, {"id": "unregistered"}]
        agents = [{"name": "outsider", "workspace_id": "unregistered"}]
        worktrees = [{"path": "C:/unregistered"}]
        with mock.patch.object(registry, "_home", side_effect=AssertionError("unexpected I/O")):
            events = registry.reconcile(doc, workspaces=workspaces, agents=agents, worktrees=worktrees)
            self.assertEqual(doc["workers"]["12"]["state"], "lost")
            self.assertEqual(events, [{
                "kind": "worker_lost", "payload": {"worker_id": "12", "workspace_id": "gone"},
            }])
            self.assertEqual(registry.reconcile(doc, workspaces=workspaces, agents=agents, worktrees=worktrees), [])
        self.assertEqual(set(doc["workers"]), {"12", "13", "14"})
        self.assertEqual(doc["workers"]["13"]["state"], "running")
        self.assertEqual(doc["workers"]["14"]["state"], "queued")
        self.assertEqual(workspaces, [{"id": "present"}, {"id": "unregistered"}])


if __name__ == "__main__":
    unittest.main()
