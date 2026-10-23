from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(key, None)  # a suite run inside herdr must not resolve a real lane

import json
import io
import os
import subprocess
import tempfile
import threading
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
        environment = dict(os.environ, HERDR_COORD_HOME=str(self.home))
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            environment.pop(key, None)
        patcher = mock.patch.dict(os.environ, environment, clear=True)
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
            "version": 3, "workers": {}, "queue": [], "holds": {},
            "actions": {}, "event_seq": 0, "notification_seq": 0, "config": {},
            "lanes": {"main": {"ack_seq": 0, "follow_lease": None,
                               "unattended_since": None, "last_alert_at": None}},
            "tab_bindings": {},
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
        for version in (0, 4, None, True, "1"):
            with self.subTest(version=version):
                registry.save({"version": version})
                with self.assertRaises(ValueError):
                    registry.load()

    def test_event_actionable_worker_states_and_payload_conditions(self):
        for kind in ("worker_state", "worker_start_failed"):
            for state in ("question", "ended_without_proof", "done", "start_failed",
                          "start_interrupted", "lost", "stalled"):
                with self.subTest(kind=kind, state=state):
                    self.assertIs(registry.event_actionable({"kind": kind, "payload": {"state": state}}), True)
            for state in ("running", "in_tool", "quota_wait", "queued", "starting", "awaiting_merge",
                          "cleaned", "relay_pending", "future_state", None):
                with self.subTest(kind=kind, state=state):
                    self.assertIs(registry.event_actionable({
                        "kind": kind, "payload": {"state": state, "final_message": "text", "overdue": True}}), False)
            for final_message, expected in ((None, False), ("", False), ("A or B?", True)):
                with self.subTest(kind=kind, final_message=final_message):
                    payload = {"state": "waiting_background", "final_message": final_message}
                    self.assertIs(registry.event_actionable({"kind": kind, "payload": payload}), expected)
            for overdue, expected in ((None, False), (False, False), (True, True)):
                with self.subTest(kind=kind, overdue=overdue):
                    payload = {"state": "awaiting_checks", "overdue": overdue}
                    self.assertIs(registry.event_actionable({"kind": kind, "payload": payload}), expected)
            for state in ("waiting_background", "awaiting_checks"):
                self.assertIs(registry.event_actionable({"kind": kind, "payload": {"state": state}}), False)
        # A lost worker remains actionable even when the repository loss also named it.
        self.assertIs(registry.event_actionable({"kind": "worker_state", "payload": {
            "state": "lost", "reason": "herdr_lost"}}), True)

    def test_event_actionable_known_kinds_and_unknowns(self):
        for kind in ("checks_overdue", "worker_handoff", "lane_unattended", "herdr_lost",
                     "watcher_lost", "watcher_exit", "watcher_hung", "delivery_unknown",
                     "send_refused", "delivery_failed"):
            with self.subTest(kind=kind):
                self.assertIs(registry.event_actionable({"kind": kind, "payload": {}}), True)
        for kind in ("worker_starting", "worker_phase", "session_discovered", "entry_action_recorded",
                     "action_delivered", "session_changed", "watcher_slow", "holds_cleared",
                     "issue_refused", "worker_cleaned", "future_kind"):
            with self.subTest(kind=kind):
                self.assertIs(registry.event_actionable({"kind": kind, "payload": {
                    "state": "question", "overdue": True, "kind": "relay"}}), False)
        self.assertIs(registry.event_actionable({}), False)
        for failed_iterations, expected in ((None, True), (0, True), (1, False), (5, False)):
            with self.subTest(failed_iterations=failed_iterations):
                self.assertIs(registry.event_actionable({"kind": "technical_problem", "payload": {
                    "failed_iterations": failed_iterations}}), expected)
        self.assertIs(registry.event_actionable({"kind": "technical_problem", "payload": {}}), True)
        for kind, expected in (("relay", True), ("nudge", False), ("resume", False), (None, False)):
            with self.subTest(superseded_kind=kind):
                self.assertIs(registry.event_actionable({"kind": "action_superseded", "payload": {
                    "kind": kind}}), expected)
        self.assertIs(registry.event_actionable({"kind": "action_superseded", "payload": {}}), False)
        self.assertFalse(registry.ACTIONABLE_EVENT_KINDS & registry.BOOKKEEPING_EVENT_KINDS)

    def test_woken_through_is_optional_and_round_trips_per_lane_without_version_change(self):
        registry.create_lane("seo")
        before = registry.load()
        self.assertTrue(all("woken_through" not in lane for lane in before["lanes"].values()))

        def record(doc):
            doc["lanes"]["main"]["woken_through"] = 7
            doc["lanes"]["seo"]["woken_through"] = 3

        registry.update(record)
        expected = json.loads(json.dumps(before))
        record(expected)
        self.assertEqual(registry.load(), expected)
        self.assertEqual(registry.update(lambda doc: None), expected)
        self.assertEqual(registry.load()["version"], 3)

    def test_migration_preserves_optional_woken_through(self):
        old, _ = self.v2_state()
        old["lanes"]["main"]["woken_through"] = 42
        old["lanes"]["seo"]["woken_through"] = 43
        registry.save(old)
        doc = registry.update(lambda doc: None)
        self.assertEqual(doc["version"], 3)
        self.assertEqual(doc["lanes"]["main"]["woken_through"], 42)
        self.assertEqual(doc["lanes"]["seo"]["woken_through"], 43)
        self.assertEqual(registry.load(), doc)

    def legacy_state(self):
        doc = {
            "version": 1, "workers": {
                "331": {"worker_id": "331", "issue": 331, "state": "question"},
                "332": {"worker_id": "332", "issue": 332, "state": "running"},
                "333": {"worker_id": "333", "issue": 333, "state": "done"},
            },
            "queue": [{"issue": 334, "state": "queued"}],
            "holds": {"watcher_lost": {"ts": 1}}, "actions": {},
            "event_seq": 44, "ack_seq": 41, "notification_seq": 42,
            "config": {"cap": 3},
        }
        registry.save(doc)
        events = [
            {"seq": 41, "kind": "worker_state", "payload": {"worker_id": "332"}},
            {"seq": 42, "kind": "worker_state", "payload": {"worker_id": "331"}},
            {"seq": 43, "kind": "watcher_lost", "payload": {}},
            {"seq": 44, "kind": "worker_state", "payload": {"worker_id": "333"}},
        ]
        (self.home / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        return doc, events

    def test_v1_lock_free_view_preserves_bytes_and_unhandled_events(self):
        old, events = self.legacy_state()
        before = {path.name: path.read_bytes() for path in self.home.iterdir()}
        doc = registry.load()
        self.assertEqual(doc["version"], 3)
        self.assertEqual(doc["tab_bindings"], {})
        self.assertNotIn("workspace_bindings", doc)
        self.assertNotIn("ack_seq", doc)
        self.assertEqual(doc["lanes"]["main"]["ack_seq"], old["ack_seq"])
        self.assertEqual(doc["notification_seq"], 42)
        self.assertEqual([w["lane"] for w in [*doc["workers"].values(), *doc["queue"]]], ["main"] * 4)
        self.assertEqual({path.name: path.read_bytes() for path in self.home.iterdir()}, before)
        expected = [event for event in events if event["seq"] > old["ack_seq"]]
        self.assertEqual(registry.read_events(41, lane="main"), expected)
        self.assertEqual(registry.read_events(41, lane="seo"), [events[2]])
        registry.update(lambda doc: None)
        self.assertEqual(registry.read_events(41, lane="main"), expected)
        self.assertEqual((self.home / "events.jsonl").read_bytes(), before["events.jsonl"])

    def test_v1_migration_is_persisted_once_even_without_callback_changes(self):
        for with_events in (False, True):
            with self.subTest(with_events=with_events):
                self.legacy_state()
                mutate = (lambda: registry.update_with_events(lambda doc, events: None)) if with_events else (
                    lambda: registry.update(lambda doc: None))
                doc = mutate()
                path = self.home / "registry.json"
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), doc)
                self.assertEqual(doc["version"], 3)
                before = path.read_bytes()
                with mock.patch.object(registry, "save", side_effect=AssertionError("already migrated")):
                    self.assertEqual(mutate(), doc)
                self.assertEqual(path.read_bytes(), before)

    def test_migration_crash_recovers_journal_without_replaying_callback(self):
        for version, with_events in ((1, False), (1, True), (2, False), (2, True)):
            with self.subTest(version=version, with_events=with_events):
                old, _ = self.legacy_state() if version == 1 else self.v2_state()
                calls = []

                def change(doc, events):
                    calls.append(True)
                    doc["config"]["cap"] = 4
                    if with_events:
                        events.append(("worker_state", {"worker_id": "331"}))

                with mock.patch.object(registry, "save", side_effect=RuntimeError("migration crash")):
                    with self.assertRaisesRegex(RuntimeError, "migration crash"):
                        if with_events:
                            registry.update_with_events(change)
                        else:
                            registry.update(lambda doc: change(doc, []))
                path = self.home / "registry.json"
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), old)
                self.assertTrue((self.home / "transaction.json").is_file())
                self.assertEqual(registry.load()["version"], 3)
                self.assertEqual(registry.load()["tab_bindings"], {})
                events = registry.read_events(41, lane="main")
                self.assertEqual([e["seq"] for e in events], [42, 43, 44, 45] if with_events else [42, 43, 44])
                self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 41)
                self.assertEqual(registry.load()["config"]["cap"], 4)
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 3)
                self.assertEqual(calls, [True])
                self.assertFalse((self.home / "transaction.json").exists())

    def test_old_style_update_refuses_migrated_state_under_lock(self):
        self.legacy_state()
        registry.update(lambda doc: None)
        before = {name: (self.home / name).read_bytes() for name in ("registry.json", "events.jsonl")}
        # The old loader's strict v1 check, inside its update lock, precedes the callback/save.
        with self.assertRaisesRegex(ValueError, "Unsupported registry version"):
            with registry.locked():
                doc = registry._read_json(self.home / "registry.json")
                if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] != 1:
                    raise ValueError("Unsupported registry version")
                doc["config"]["cap"] = 99
                registry.save(doc)
        self.assertEqual({name: (self.home / name).read_bytes() for name in before}, before)

    def v2_state(self):
        doc = {
            "version": 2, "workers": {
                "331": {"worker_id": "331", "issue": 331, "state": "question", "lane": "main"},
                "332": {"worker_id": "332", "issue": 332, "state": "running", "lane": "seo"},
            },
            "queue": [{"issue": 334, "state": "queued", "lane": "seo"}],
            "holds": {"watcher_lost": {"ts": 1}}, "actions": {"relay": {"state": "sent"}},
            "event_seq": 44, "notification_seq": 42, "config": {"cap": 3},
            "lanes": {
                "main": {"ack_seq": 41, "follow_lease": {"token": "old-main"},
                         "unattended_since": 123, "last_alert_at": 456},
                "seo": {"ack_seq": 7, "follow_lease": None,
                        "unattended_since": None, "last_alert_at": None, "bound_before": False},
                "past": {"ack_seq": 0, "follow_lease": None,
                         "unattended_since": None, "last_alert_at": None, "bound_before": True},
            },
            "workspace_bindings": {
                "w1": {"lane": "main", "label": "boon-town", "explicit": False},
                "w2": {"lane": "seo", "label": "boon-town seo", "explicit": True},
            },
        }
        registry.save(doc)
        events = [
            {"seq": 7, "kind": "worker_state", "payload": {"worker_id": "332"}, "lanes": ["seo"]},
            {"seq": 8, "kind": "worker_state", "payload": {"worker_id": "332"}, "lanes": ["seo"]},
            {"seq": 41, "kind": "worker_state", "payload": {"worker_id": "331"}},
            {"seq": 42, "kind": "worker_state", "payload": {"worker_id": "331"}},
            {"seq": 43, "kind": "watcher_slow", "payload": {}, "scope": "repo"},
            {"seq": 44, "kind": "worker_handoff", "payload": {"worker_id": "331"},
             "lanes": ["main", "seo"]},
        ]
        (self.home / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        return doc, events

    def test_v2_migration_preserves_state_history_and_each_lanes_events(self):
        old, events = self.v2_state()
        before = {path.name: path.read_bytes() for path in self.home.iterdir()}
        expected = json.loads(json.dumps(old))
        expected["version"] = 3
        expected["tab_bindings"] = {}
        expected.pop("workspace_bindings")
        for lane in ("main", "seo"):
            expected["lanes"][lane]["bound_before"] = True
        self.assertEqual(registry.load(), expected)
        self.assertEqual({path.name: path.read_bytes() for path in self.home.iterdir()}, before)
        visible = {"main": events[3:], "seo": [events[1], *events[4:]], "past": [events[4]]}
        for lane, lane_events in visible.items():
            self.assertEqual(registry.read_events(old["lanes"][lane]["ack_seq"], lane=lane), lane_events)
        self.assertEqual(registry.update(lambda doc: None), expected)
        self.assertEqual(json.loads((self.home / "registry.json").read_text(encoding="utf-8")), expected)
        self.assertEqual((self.home / "events.jsonl").read_bytes(), before["events.jsonl"])
        for lane, lane_events in visible.items():
            self.assertEqual(registry.read_events(old["lanes"][lane]["ack_seq"], lane=lane), lane_events)
        self.assertEqual(registry._migrate(json.loads(json.dumps(expected))), expected)
        persisted = (self.home / "registry.json").read_bytes()
        with mock.patch.object(registry, "save", side_effect=AssertionError("already migrated")):
            self.assertEqual(registry.update(lambda doc: None), expected)
        self.assertEqual((self.home / "registry.json").read_bytes(), persisted)

    def test_v2_migration_recreates_a_missing_bound_lane_at_event_sequence(self):
        old, _ = self.v2_state()
        del old["lanes"]["seo"]
        registry.save(old)
        before = (self.home / "registry.json").read_bytes()
        doc = registry.load()
        self.assertEqual(doc["lanes"]["seo"], dict(registry._lane(44), bound_before=True))
        self.assertEqual(doc["version"], 3)
        self.assertEqual(doc["tab_bindings"], {})
        self.assertEqual((self.home / "registry.json").read_bytes(), before)
        self.assertEqual(registry.update(lambda doc: None), doc)
        self.assertEqual(registry.load(), doc)

    def test_v2_only_writer_refuses_v3_registry_and_journal_without_writing(self):
        self.v2_state()
        registry.update(lambda doc: None)

        def v2_validate(doc):
            if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] not in (1, 2):
                raise ValueError("Unsupported registry version")

        for journal in (False, True):
            with self.subTest(journal=journal):
                if journal:
                    registry._save_json({"doc": registry.load(), "events": [
                        {"seq": 45, "kind": "observed", "payload": {}, "lanes": ["main"]},
                    ]}, self.home / "transaction.json")
                before = {path.name: path.read_bytes() for path in self.home.iterdir()}
                callback = mock.Mock()
                with mock.patch.object(registry, "_validate_version", v2_validate):
                    with self.assertRaisesRegex(ValueError, "Unsupported registry version"):
                        registry.update(callback)
                callback.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in self.home.iterdir()}, before)

    def pending_work(self, lane):
        result = []

        def check(doc):
            with mock.patch.object(registry, "locked", side_effect=AssertionError("already locked")), \
                    mock.patch.object(registry, "read_events", side_effect=AssertionError("public reader locks")), \
                    mock.patch.object(registry, "load", side_effect=AssertionError("use supplied document")):
                result.append(registry.lane_has_pending_work(doc, lane))

        registry.update(check)
        return result[0]

    def test_pending_work_requires_unacked_routed_events(self):
        registry.create_lane("seo")
        self.assertFalse(self.pending_work("main"))
        self.assertFalse(self.pending_work("seo"))
        for kind in ("watcher_slow", "hold_opened", "lane_unattended"):
            registry.append_event(kind, {})
            self.assertFalse(self.pending_work("main"))
            self.assertFalse(self.pending_work("seo"))
        seq = registry.append_event("issue_refused", {}, caller_lane="seo")
        self.assertFalse(self.pending_work("main"))
        self.assertTrue(self.pending_work("seo"))
        registry.ack(seq, lane="seo")
        self.assertFalse(self.pending_work("seo"))
        seq = registry.append_event("worker_handoff", {"from_lane": "main", "to_lane": "seo"})
        self.assertTrue(self.pending_work("main"))
        self.assertTrue(self.pending_work("seo"))
        registry.ack(seq, lane="main")
        self.assertFalse(self.pending_work("main"))
        self.assertTrue(self.pending_work("seo"))

    def test_pending_work_uses_legacy_event_routing(self):
        self.legacy_state()
        registry.update(lambda doc: (doc["workers"].clear(), doc["queue"].clear()))
        registry.create_lane("seo")
        self.assertTrue(self.pending_work("main"))
        self.assertFalse(self.pending_work("seo"))
        registry.ack(44)
        self.assertFalse(self.pending_work("main"))

    def test_settled_worker_states_match_watcher_except_cleaning(self):
        import watch

        self.assertEqual(registry.SETTLED_WORKER_STATES, watch.TERMINAL_STATES - {"cleaning"})

    def test_pending_work_counts_unsettled_workers_only_in_their_lane(self):
        registry.create_lane("seo")
        for state in ("cleaning", "lost", "question", "running", "starting",
                      "done", "awaiting_merge", "cleaned", "start_failed"):
            with self.subTest(state=state):
                registry.update(lambda doc: doc["workers"].update({"worker": {"state": state, "lane": "seo"}}))
                self.assertEqual(self.pending_work("seo"), state in {"cleaning", "lost", "question", "running", "starting"})
                self.assertFalse(self.pending_work("main"))

    def test_pending_work_counts_queue_only_in_its_lane(self):
        registry.create_lane("seo")
        registry.update(lambda doc: doc["queue"].append({"issue": 334, "lane": "seo"}))
        self.assertTrue(self.pending_work("seo"))
        self.assertFalse(self.pending_work("main"))
        registry.update(lambda doc: doc["queue"].clear())
        self.assertFalse(self.pending_work("seo"))

    def test_existing_admission_callbacks_default_workers_and_queue_to_main(self):
        doc = registry.update(lambda doc: (doc["workers"].update({"worker": {"state": "running"}}),
                                           doc["queue"].append({"issue": 12})))
        self.assertEqual(doc["workers"]["worker"]["lane"], "main")
        self.assertEqual(doc["queue"][0]["lane"], "main")

    def test_routes_use_committed_worker_lane_and_remain_immutable(self):
        registry.create_lane("seo")
        registry.update(lambda doc: doc["workers"].update({"worker": {"lane": "main"}}))
        registry.append_event("worker_state", {"worker_id": "worker"})

        def move(doc, events):
            events.append(("worker_state", {"worker_id": "worker", "lane": "main"}))
            doc["workers"]["worker"]["lane"] = "seo"

        registry.update_with_events(move)
        registry.append_event("technical_problem", {"worker_id": "worker"})
        registry.append_event("technical_problem", {})
        registry.append_event("watcher_lost", {"worker_id": "worker"})
        registry.append_event("issue_refused", {"worker_id": "worker"}, caller_lane="main")
        registry.update_with_events(lambda doc, events: events.append(("issue_refused", {"issue": 12})),
                                    caller_lane="seo")
        registry.append_event("worker_handoff", {"worker_id": "worker", "from_lane": "main", "to_lane": "seo"})
        registry.update(lambda doc: doc["workers"]["worker"].update(lane="main"))
        events = registry.read_events(0, lane=None)
        self.assertEqual([e.get("lanes") for e in events],
                         [["main"], ["seo"], ["seo"], None, None, ["main"], ["seo"], ["main", "seo"]])
        self.assertEqual([e["scope"] for e in events if "scope" in e], ["repo", "repo"])
        self.assertEqual([e["seq"] for e in registry.read_events(1, lane="seo")], [2, 3, 4, 5, 7, 8])
        self.assertEqual([e["seq"] for e in registry.read_events(0)], [1, 4, 5, 6, 8])

    def test_repo_kinds_and_pre_upgrade_technical_problem_routing(self):
        kinds = ["watcher_lost", "watcher_exit", "watcher_slow", "watcher_hung", "herdr_lost",
                 "hold_cleared", "holds_cleared", "lane_unattended", "technical_problem"]
        for kind in kinds:
            registry.append_event(kind, {})
        routed = registry.read_events(0, lane="seo")
        self.assertEqual([e["kind"] for e in routed], kinds)
        self.assertTrue(all(e.get("scope") == "repo" and "lanes" not in e for e in routed))
        old = [{key: value for key, value in e.items() if key != "scope"} for e in routed]
        old.append({"seq": 10, "kind": "technical_problem", "payload": {"worker_id": "worker"}})
        (self.home / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in old), encoding="utf-8")
        self.assertEqual(registry.read_events(0, lane="seo"), old[:-1])
        self.assertEqual(registry.read_events(0, lane="main"), old)

    def test_ack_is_lane_scoped_and_rejects_invisible_or_missing_sequences(self):
        registry.create_lane("seo")
        registry.update_with_events(lambda doc, events: events.extend([("observed", {})] * 50))
        private = registry.append_event("issue_refused", {}, caller_lane="seo")
        registry.ack(50, lane="main")
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], 0)
        for seq in (private, private + 1, -1, True):
            with self.subTest(seq=seq), self.assertRaises(ValueError):
                registry.ack(seq, lane="main")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 50)
        registry.ack(private, lane="seo")
        registry.ack(10, lane="main")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 50)
        repo = registry.append_event("watcher_lost", {})
        registry.ack(repo, lane="seo")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 50)
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], repo)

    def test_new_lane_starts_at_log_end_and_recreation_keeps_cursor(self):
        registry.update_with_events(lambda doc, events: events.extend([("watcher_lost", {})] * 40))
        registry.create_lane("seo")
        lane = registry.load()["lanes"]["seo"]
        self.assertEqual(lane["ack_seq"], 40)
        self.assertEqual(registry.read_events(lane["ack_seq"], lane="seo"), [])
        registry.append_event("watcher_lost", {})
        registry.create_lane("seo")
        registry.create_lane("main")
        self.assertEqual(registry.load()["lanes"]["seo"], lane)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 0)

    def test_existing_cli_and_follow_use_main_cursor_and_filter(self):
        import herdr_coord
        import watch

        registry.create_lane("seo")
        main = registry.append_event("observed", {})
        private = registry.append_event("issue_refused", {}, caller_lane="seo")
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(), 0)
        self.assertEqual([json.loads(line)["seq"] for line in output.getvalue().splitlines()], [main])
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["event", str(private)]), 1)
            self.assertEqual(herdr_coord.main(["ack", str(private)]), 1)
            self.assertEqual(herdr_coord.main(["ack", str(main)]), 0)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], main)
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], 0)

    def test_shared_notification_reader_does_not_skip_named_lane_events(self):
        import watch

        registry.create_lane("seo")
        registry.update(lambda doc: doc["workers"].update({"worker": {"lane": "seo"}}))
        private = registry.append_event("technical_problem", {"worker_id": "worker", "detail": "failed"})
        ops = mock.Mock()
        ops.herdr.return_value.ok = True
        watch._notify_events(ops)
        watch._notify_events(ops)
        self.assertEqual(ops.herdr.call_count, 1)
        self.assertEqual(registry.load()["notification_seq"], private)

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

    def test_journal_delete_waits_for_a_reader_holding_it_open(self):
        # Live 2026-10-19 (norm start of #331): a lock-free load() held transaction.json open, the
        # delete raised WinError 32, and start reported every issue as start_failed.
        registry.append_event("first", {})
        transaction = self.home / "transaction.json"
        registry._save_json({"doc": registry.load(), "events": []}, transaction)
        # A reader without delete sharing (an older watcher's plain open) delays the delete briefly.
        reader = transaction.open(encoding="utf-8")
        threading.Timer(0.1, reader.close).start()
        registry.append_event("second", {})  # recovers the journal under the lock first
        reader.close()
        self.assertFalse(transaction.exists())
        # This module's own readers share delete access, so they never delay it.
        registry._save_json({"doc": registry.load(), "events": []}, transaction)
        with registry._open_shared(transaction) as shared:
            with mock.patch.object(registry.time, "sleep", side_effect=AssertionError("no retry needed")):
                registry.append_event("third", {})
            self.assertFalse(transaction.exists())
            self.assertIn('"events"', shared.read())  # the open reader still sees its snapshot
        self.assertEqual([event["kind"] for event in registry.read_events(0)], ["first", "second", "third"])

    def test_journal_read_retries_while_the_file_is_held(self):
        registry.append_event("first", {})
        reads = []
        original = registry._open_shared

        def held_twice(path):
            if len(reads) < 2:
                reads.append(path.name)
                raise PermissionError(13, "The process cannot access the file", str(path))
            return original(path)

        with mock.patch.object(registry, "_open_shared", held_twice):
            doc = registry.load()
        self.assertEqual(doc["event_seq"], 1)
        self.assertEqual(len(reads), 2)
        # A missing journal is no error: the registry itself is read.
        self.assertFalse((self.home / "transaction.json").exists())
        with self.assertRaises(FileNotFoundError):
            registry._open_shared(self.home / "transaction.json")

    def test_shared_open_closes_its_handle_when_no_descriptor_takes_it(self):
        registry.append_event("first", {})
        closed = []
        with mock.patch.object(registry.msvcrt, "open_osfhandle", side_effect=OSError(24, "Too many open files")), \
                mock.patch.object(registry._kernel32, "CloseHandle", side_effect=closed.append):
            with self.assertRaises(OSError):
                registry._open_shared(self.home / "registry.json")
        self.assertEqual(len(closed), 1)

    def test_lock_free_readers_never_break_concurrent_writers(self):
        stop = threading.Event()
        errors = []

        def read():
            while not stop.is_set():
                try:
                    registry.load()
                except Exception as exc:  # the reader must not fail either
                    errors.append(exc)

        readers = [threading.Thread(target=read) for _ in range(3)]
        for thread in readers:
            thread.start()
        try:
            for index in range(60):
                registry.append_event("observed", {"index": index})
        finally:
            stop.set()
            for thread in readers:
                thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(registry.read_events(0)), 60)

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
            self.assertEqual(set(event), {"seq", "ts", "kind", "payload", "lanes"})
            self.assertEqual(event["lanes"], ["main"])
            self.assertEqual(event["kind"], "observed")
            self.assertTrue(event["ts"].endswith("+00:00"))
        self.assertEqual([event["seq"] for event in registry.read_events(60)], list(range(61, 101)))
        self.assertEqual(registry.read_events(100), [])
        registry.ack(75)
        registry.ack(5)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 75)
        registry.ack(100)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 100)

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
