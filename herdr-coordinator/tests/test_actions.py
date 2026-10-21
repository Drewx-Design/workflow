import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts"))
for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(key, None)  # a suite run inside herdr must not resolve a real lane

import copy
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import actions
import adapters
import herdr_coord
import registry
import start
from test_start import herdr_identity


FIXTURES = Path(__file__).parent / "fixtures"
RECORDS = [json.loads(line) for line in (FIXTURES / "session-probe-full.jsonl").read_text(encoding="utf-8").splitlines()]
PROMPT = next(r for r in RECORDS if r.get("type") == "user" and isinstance(r.get("message", {}).get("content"), str))
END = next(r for r in RECORDS if r.get("type") == "assistant" and r.get("message", {}).get("stop_reason") == "end_turn")
TOOL = next(r for r in RECORDS if r.get("message", {}).get("stop_reason") == "tool_use" and any(
    b.get("type") == "tool_use" for b in r["message"]["content"]))
TOOL_ID = next(b["id"] for b in TOOL["message"]["content"] if b.get("type") == "tool_use")
RESULT = next(r for r in RECORDS if isinstance(r.get("message", {}).get("content"), list) and any(
    b.get("tool_use_id") == TOOL_ID for b in r["message"]["content"]))
ASK = next(r for r in RECORDS if isinstance(r.get("message", {}).get("content"), list) and any(
    b.get("name") == "AskUserQuestion" for b in r["message"]["content"]))
ASK_ID = next(b["id"] for b in ASK["message"]["content"] if b.get("name") == "AskUserQuestion")
ANSWER = next(r for r in RECORDS if isinstance(r.get("message", {}).get("content"), list) and any(
    b.get("tool_use_id") == ASK_ID for b in r["message"]["content"]))
QUOTA = next(json.loads(line) for line in (FIXTURES / "api-error-429-sequence.jsonl").read_text(encoding="utf-8").splitlines()
             if json.loads(line).get("apiErrorStatus") == 429)
AGENTS = {
    state: json.loads((FIXTURES / f"herdr-agent-get-{name}.json").read_bytes())["result"]["agent"]
    for state, name in (("idle", "idle"), ("done", "after-prompt-done"), ("blocked", "blocked-question"))
}


def success(data=None):
    return adapters.CommandResult(True, 0, "", "", data)


class FakeOps:
    """Real producer shapes, with all external effects kept in a temp directory."""

    def __init__(self, projects):
        self.projects_root = projects
        (projects / "project").mkdir(parents=True)
        self.reachable = True
        self.calls = []
        self.sessions = {}
        self.statuses = {}
        # Hand-written form: no pending AskUserQuestion screen was captured.
        self.visible = "Probe question: pick A or B?\n1. A\n2. B\n3. Type something."
        self.confirm = True
        self.error = None
        self.send_results = {}
        self.form_text = "1"
        self.sends = []
        self.start_calls = []
        self.notifications = []
        self.verify_calls = []
        self.workspace_labels = {}
        self.renames = []
        self.rename_results = {}
        self.verdict = {"state": "ended_without_proof", "pr": None, "url": None,
                        "no_ci": False, "overdue": False, "detail": "no proof", "final_message": "Please advise"}

    def path(self, session):
        return self.projects_root / "project" / f"{session}.jsonl"

    def write(self, session, records, *, append=False):
        with self.path(session).open("a" if append else "w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(copy.deepcopy(record)) + "\n")

    def herdr_reachable(self):
        return self.reachable

    def herdr(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] in {("tab", "get"), ("pane", "get"), ("tab", "list"), ("pane", "list")}:
            return herdr_identity(*args, **kwargs)
        if args[:2] in {("workspace", "get"), ("workspace", "rename")}:
            assert 0 < kwargs["timeout"] <= start.COMMAND_TIMEOUT
            if args[1] == "get":
                data = json.loads((FIXTURES / "herdr-workspace-get-main.json").read_text(encoding="utf-8"))
                data["result"]["workspace"]["label"] = self.workspace_labels[args[2]]
                return success(data)
            self.renames.append(args)
            result = self.rename_results.get(args[3], success())
            if result.ok:
                self.workspace_labels[args[2]] = args[3]
            return result
        if args[:2] == ("notification", "show"):
            self.notifications.append(args)
            return success()
        name = args[2]
        session = self.sessions.get(name)
        if args[:2] == ("agent", "get"):
            state = self.statuses.get(name, "idle")
            agent = copy.deepcopy(AGENTS[state])
            if session:
                agent["agent_session"] = {"value": session}
            else:
                agent.pop("agent_session", None)
            return success({"result": {"agent": agent}})
        if args[:2] == ("agent", "read"):
            return adapters.CommandResult(True, 0, self.visible, "")
        if args[:2] == ("agent", "start"):
            self.start_calls.append(args)
            if self.error:
                return adapters.CommandResult(False, None, "", "", error_code=self.error, error_message=self.error)
            return success()
        if args[:2] in {("agent", "prompt"), ("agent", "send-keys"), ("pane", "send-text")}:
            self.sends.append(args)
            # Assert the ordering at the actual send boundary, not after the fact.
            assert any(a.get("last_send") == list(args) and a["status"] == "delivery_unknown"
                       for a in registry.load()["actions"].values())
            if args[:2] in self.send_results:
                result = self.send_results[args[:2]]
                if isinstance(result, Exception):
                    raise result
                return result
            if self.error:
                return adapters.CommandResult(False, None, "", "", error_code=self.error, error_message=self.error)
            if self.confirm and args[1] == "prompt":
                record = copy.deepcopy(PROMPT)
                record["message"]["content"] = args[3]
                self.write(session, [record], append=True)
                self.statuses[name] = "idle"
            if self.confirm and args[1] == "send-keys" and args[3] == "enter":
                answer = copy.deepcopy(ANSWER)
                value = "A" if self.form_text == "1" else self.form_text
                title = ASK["message"]["content"][0]["input"]["questions"][0]["question"]
                answer["toolUseResult"]["answers"] = {title: value}
                self.write(session, [ASK, answer], append=True)
                self.statuses[name] = "idle"
            return success()
        raise AssertionError(f"Unexpected external operation: {args!r}")

    def verify_done(self, worker, **kwargs):
        self.verify_calls.append((worker, kwargs))
        return dict(self.verdict)


class ActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sessions = Path(self.temp.name) / ".claude" / "sessions"
        environment = dict(os.environ, HERDR_COORD_HOME=str(Path(self.temp.name) / "home"),
                           CLAUDE_CONFIG_DIR=str(self.sessions.parent))
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            environment.pop(key, None)
        self.env = mock.patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        # Never spawn a real detached watcher from a test (test_watcher_guard covers this path).
        no_watcher = mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None)
        no_watcher.start()
        self.addCleanup(no_watcher.stop)
        self.ops = FakeOps(Path(self.temp.name) / "projects")
        identity = mock.patch.object(adapters, "herdr", side_effect=herdr_identity)
        identity.start()
        self.addCleanup(identity.stop)
        self.worker = self.add_worker()

    def add_worker(self, name="worker", state="running", session="session-1", issue=1):
        worker = {"worker_id": name, "agent_name": name, "issue": issue, "state": state,
                  "state_token": f"{name}-state",
                  "session_id": session, "pane_id": "pane-1", "workspace_id": "workspace-1",
                  "worktree_path": self.temp.name, "repo_path": self.temp.name, "branch": "issue/1",
                  "entry_command": "ce-work", "entry_args": "#1", "phase": "mode_checked",
                  "last_growth_at": 100, "transcript_offset": 0}
        registry.update(lambda doc: doc["workers"].update({name: worker}))
        self.ops.sessions[name] = session
        if session:
            self.ops.write(session, [PROMPT])
        return worker

    def set_state(self, state, **fields):
        registry.update(lambda doc: doc["workers"]["worker"].update(state=state, **fields))

    def test_cli_worker_commands_refuse_another_lane_without_effects(self):
        for state, argv in (
            ("ended_without_proof", ["relay", "worker", "answer", "--token", "worker-state"]),
            ("running", ["nudge", "worker"]),
            ("quota_wait", ["resume", "worker"]),
            ("start_interrupted", ["restart", "worker"]),
        ):
            with self.subTest(command=argv[0]):
                self.set_state(state, lane="seo")
                before = registry.load()
                with mock.patch.object(adapters, "herdr", side_effect=self.ops.herdr), \
                        mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    self.assertEqual(herdr_coord.main(argv), 1)
                self.assertIn("lane seo", json.loads(output.getvalue())["detail"])
                self.assertEqual(registry.load(), before)
                self.assertFalse(self.ops.sends)
                self.assertFalse(self.ops.start_calls)

    def test_relay_checks_lane_inside_remember_even_when_no_slot_is_free(self):
        self.set_state("ended_without_proof")
        registry.update(lambda doc: doc["config"].update(cap=0))
        update = registry.update_with_events

        def handoff_before_remember(fn, **kwargs):
            if fn.__name__ == "remember":
                update(lambda doc, events: doc["workers"]["worker"].update(lane="seo"))
            return update(fn, **kwargs)

        with mock.patch.object(registry, "update_with_events", side_effect=handoff_before_remember):
            with self.assertRaisesRegex(actions.ActionError, "lane seo"):
                actions.relay("worker", "answer", state_token="worker-state", lane="main", ops=self.ops)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertNotIn("relay_request", worker)
        self.assertNotIn("pending_action_id", worker)
        self.assertFalse(registry.load()["actions"])
        self.assertFalse(self.ops.sends)

    def test_preflight_rotation_cannot_persist_after_a_handoff(self):
        original = self.ops.herdr
        self.ops.write("session-2", [PROMPT])

        def preflight(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                registry.update(lambda doc: doc["workers"]["worker"].update(lane="seo"))
                self.ops.sessions["worker"] = "session-2"
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=preflight):
            with self.assertRaisesRegex(actions.ActionError, "lane seo"):
                actions.nudge("worker", lane="main", ops=self.ops)
        self.assertEqual(registry.load()["workers"]["worker"]["session_id"], "session-1")
        self.assertFalse(self.ops.sends)

    def test_receipt_replay_cannot_persist_after_a_handoff(self):
        self.ops.confirm = False
        actions.nudge("worker", lane="main", ops=self.ops, action_id="n1")
        prompt = copy.deepcopy(PROMPT)
        prompt["message"]["content"] = actions.NUDGE_TEXT
        self.ops.write("session-1", [prompt], append=True)
        records_for = actions.records_for

        def handoff_before_confirmation(worker, ops):
            registry.update(lambda doc: doc["workers"]["worker"].update(lane="seo"))
            return records_for(worker, ops)

        with mock.patch.object(actions, "records_for", side_effect=handoff_before_confirmation):
            with self.assertRaisesRegex(actions.ActionError, "lane seo"):
                actions.nudge("worker", lane="main", ops=self.ops, action_id="n1")
        self.assertEqual(registry.load()["actions"]["n1"]["status"], "delivery_unknown")
        self.assertEqual(registry.load()["workers"]["worker"]["pending_action_id"], "n1")
        self.assertEqual(len(self.ops.sends), 1)

    def test_action_prepare_checks_current_lane_and_handoff_claim(self):
        for changes, reason in (({"lane": "seo"}, "lane seo"),
                                ({"lane": "main", "handoff_claim": {
                                    "owner": start._start_owner(), "target": "seo"}}, "handoff")):
            with self.subTest(changes=changes):
                registry.update(lambda doc: doc["workers"]["worker"].update(changes))
                with self.assertRaisesRegex(actions.ActionError, reason):
                    actions._prepare(self.worker, "nudge", actions.NUDGE_TEXT, "n1", [], lane="main")
                self.assertFalse(registry.load()["actions"])
                self.assertNotIn("pending_action_id", registry.load()["workers"]["worker"])

    def test_live_handoff_refuses_user_commands_but_dead_owner_does_not(self):
        for state, command in (("ended_without_proof", "relay"), ("running", "nudge"),
                               ("quota_wait", "resume"), ("start_interrupted", "restart")):
            with self.subTest(command=command):
                self.set_state(state, handoff_claim={"owner": start._start_owner(), "target": "seo"})
                before = registry.load()
                argv = [command, "worker"] + (["answer", "--token", "worker-state"] if command == "relay" else [])
                with mock.patch.object(adapters, "herdr", side_effect=self.ops.herdr), \
                        mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    self.assertEqual(herdr_coord.main(argv), 1)
                self.assertIn("handoff", json.loads(output.getvalue())["detail"])
                self.assertEqual(registry.load(), before)
        self.set_state("running", handoff_claim={"owner": {"pid": os.getpid(), "created": 0}, "target": "seo"})
        self.assertEqual(actions.nudge("worker", lane="main", ops=self.ops)["status"], "delivered")

    def test_named_lane_commands_and_lane_neutral_watcher_sends(self):
        import watch

        self.set_state("ended_without_proof", lane="seo")
        self.assertEqual(actions.relay("worker", "answer", state_token="worker-state",
                                       lane="seo", ops=self.ops)["status"], "delivered")
        quota = copy.deepcopy(QUOTA)
        quota["quotaLimits"]["resetsAt"] = 200
        self.ops.write("session-1", [PROMPT, quota])
        self.set_state("running", last_growth_at=0, transcript_offset=self.ops.path("session-1").stat().st_size)
        watch.poll_once(ops=self.ops, now=100)
        watch.poll_once(ops=self.ops, now=201)
        self.assertEqual(self.ops.sends[-1], ("agent", "prompt", "worker", actions.RESUME_TEXT))
        self.ops.write("session-1", [PROMPT, TOOL, RESULT])
        self.set_state("running", last_growth_at=0, transcript_offset=self.ops.path("session-1").stat().st_size)
        watch.poll_once(ops=self.ops, now=1201)
        self.assertEqual(self.ops.sends[-1], ("agent", "prompt", "worker", actions.NUDGE_TEXT))

    def test_go_and_config_from_named_lane_are_repository_wide(self):
        registry.create_lane("seo")
        registry.update(lambda doc: doc["holds"].update(watcher_lost={"ts": 1}))
        context = {"lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
                   "controller": {"agent": "claude", "kind": "id", "value": "coordinator-session"},
                   "source": "tab label"}
        with mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=context), \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["go"]), 0)
            self.assertEqual(herdr_coord.main(["config", "set", "cap", "4"]), 0)
        self.assertEqual(registry.load()["holds"], {})
        self.assertEqual(registry.load()["config"]["cap"], 4)
        for lane in ("main", "seo"):
            self.assertEqual([event["kind"] for event in registry.read_events(0, lane=lane)], ["holds_cleared"])

    def test_cli_action_dispatch_passes_the_resolved_lane(self):
        context = {"lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
                   "controller": {"agent": "claude", "kind": "id", "value": "coordinator-session"},
                   "source": "tab label"}
        for command, argv, expected in (
            ("nudge", ["nudge", "worker"], {"action_id": None}),
            ("resume", ["resume", "worker"], {"action_id": None}),
            ("relay", ["relay", "worker", "answer", "--token", "q1"],
             {"state_token": "q1", "action_id": None, "dismiss_form": False}),
        ):
            with self.subTest(command=command), \
                    mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=context), \
                    mock.patch.object(actions, command, return_value={}) as run, \
                    mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(herdr_coord.main(argv), 0)
                run.assert_called_once_with(*(["worker", "answer"] if command == "relay" else ["worker"]),
                                            lane="seo", **expected)

    def prepare_handoff(self, state="running", **fields):
        for lane in ("seo", "app"):
            registry.create_lane(lane)
        self.set_state(state, issue=7, repo_path=str(Path(self.temp.name) / "boon-town"), **fields)
        self.workspace_id = AGENTS["idle"]["workspace_id"]
        self.ops.workspace_labels[self.workspace_id] = "boon-town #7"

    def test_handoff_renames_refreshed_workspace_and_routes_one_event(self):
        self.prepare_handoff()
        result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["lane"], "seo")
        self.assertEqual(worker["workspace_id"], self.workspace_id)
        self.assertEqual(worker["pane_id"], AGENTS["idle"]["pane_id"])
        self.assertNotIn("handoff_claim", worker)
        self.assertEqual(self.ops.renames, [("workspace", "rename", self.workspace_id, "seo #7")])
        self.assertEqual(result["to_lane"], "seo")
        events = [e for e in registry.read_events(0, lane=None) if e["kind"] == "worker_handoff"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["lanes"], ["main", "seo"])
        self.assertEqual(events[0]["payload"]["from_lane"], "main")
        self.assertEqual(events[0]["payload"]["to_lane"], "seo")
        for lane in ("main", "seo"):
            self.assertIn(events[0], registry.read_events(0, lane=lane))
        self.assertNotIn(events[0], registry.read_events(0, lane="app"))
        actions.handoff("worker", "main", lane="seo", ops=self.ops)
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], "boon-town #7")

    def test_handoff_uses_the_live_target_tag_and_stores_it_on_commit(self):
        binding = {"lane": "seo", "label_seen": "c12:issues", "source": "tab label", "explicit": False,
                   "controller": {"agent": "claude", "kind": "id", "value": "target-session"},
                   "pane_id": "target-pane"}
        for snapshot, bindings, tag in (
            ({"tab_ids": {"target-tab"}, "controller_counts": {"target-session": 1}},
             {"target-tab": binding}, "C12"),
            ({"tab_ids": set(), "controller_counts": {}}, {"target-tab": binding}, "seo"),
            ({"tab_ids": set(), "controller_counts": {}}, {}, "seo"),
            (None, {"target-tab": binding}, "seo"),
        ):
            with self.subTest(snapshot=snapshot, bindings=bindings):
                self.prepare_handoff(lane="main", label_tag="C3", title="fix: faster issue filing")
                registry.update(lambda doc: (doc["tab_bindings"].clear(), doc["tab_bindings"].update(bindings)))
                self.ops.workspace_labels[self.workspace_id] = "C3 #7 faster issue filing"
                with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot):
                    result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
                expected = f"{tag} #7 faster issue filing"
                self.assertEqual(result["workspace_label"], expected)
                self.assertEqual(self.ops.workspace_labels[self.workspace_id], expected)
                self.assertEqual(actions.worker_named("worker")["label_tag"], tag)
                event = [e for e in registry.read_events(0, lane="seo") if e["kind"] == "worker_handoff"][-1]
                self.assertEqual(event["payload"]["label_tag"], tag)

    def test_handoff_failure_restores_the_stored_source_tag_and_title(self):
        self.prepare_handoff(lane="main", label_tag="C3", title="feat(scope): faster issue filing")
        binding = {"lane": "seo", "label_seen": "C12-issues", "source": "tab label", "explicit": False,
                   "controller": {"agent": "claude", "kind": "id", "value": "target-session"},
                   "pane_id": "target-pane"}
        registry.update(lambda doc: doc["tab_bindings"].update({"target-tab": binding}))
        source_label = "C3 #7 faster issue filing"
        target_label = "C12 #7 faster issue filing"
        self.ops.workspace_labels[self.workspace_id] = source_label
        original = self.ops.herdr

        def rename(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("workspace", "rename") and args[3] == target_label:
                self.set_state("running", relay_request={"text": "late relay"})
            return result

        snapshot = {"tab_ids": {"target-tab"}, "controller_counts": {"target-session": 1}}
        with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot), \
                mock.patch.object(self.ops, "herdr", side_effect=rename):
            with self.assertRaisesRegex(actions.ActionError, "relay"):
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertEqual(self.ops.renames, [("workspace", "rename", self.workspace_id, target_label),
                                           ("workspace", "rename", self.workspace_id, source_label)])
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], source_label)
        self.assertEqual(actions.worker_named("worker")["label_tag"], "C3")
        self.assertEqual(actions.worker_named("worker")["lane"], "main")
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))

    def test_handoff_warns_only_when_target_has_no_live_owner(self):
        controller = {"agent": "claude", "kind": "id", "value": "target-session"}
        binding = {"lane": "seo", "label_seen": "SEO", "source": "tab label", "explicit": False,
                   "controller": controller, "pane_id": "target-pane"}
        cases = ((None, {}, False),
                 ({"tab_ids": set(), "controller_counts": {}}, {}, True),
                 ({"tab_ids": {"target-tab"}, "controller_counts": {}}, {"target-tab": binding}, True),
                 ({"tab_ids": set(), "controller_counts": {"target-session": 1}},
                  {"target-tab": binding}, False))
        for snapshot, bindings, warning in cases:
            with self.subTest(snapshot=snapshot, bindings=bindings):
                self.prepare_handoff(lane="main")
                registry.update(lambda doc: (doc["tab_bindings"].clear(), doc["tab_bindings"].update(bindings)))
                with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot) as read:
                    result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
                read.assert_called_once_with(caller_pane_id=None, ops=self.ops)
                self.assertEqual(result["state"], "handed_off")
                self.assertEqual(actions.worker_named("worker")["lane"], "seo")
                self.assertEqual("warning" in result, warning)
                if warning:
                    self.assertEqual(result["warning"],
                                     "target lane seo has no live coordinator; its unattended alert will fire")

    def test_handoff_returns_only_a_known_live_target_owners_contact(self):
        binding = {"lane": "seo", "label_seen": "SEO", "source": "tab label", "explicit": False,
                   "controller": {"agent": "claude", "kind": "id", "value": "target-session"},
                   "pane_id": "target-pane", "contact": "norm-98 [bcefc3]"}
        live = {"tab_ids": set(), "controller_counts": {"target-session": 1}}
        cases = ((None, {"target-tab": binding}, None),
                 ({"tab_ids": {"target-tab"}, "controller_counts": {}}, {"target-tab": binding}, None),
                 (live, {}, None),
                 (live, {"target-tab": binding}, "norm-98 [bcefc3]"),
                 (live, {"stale-tab": {**binding, "controller": {**binding["controller"], "value": "dead"}},
                         "target-tab": {key: value for key, value in binding.items() if key != "contact"}}, None),
                 (live, {"other-tab": {**binding, "lane": "app"}}, None))
        for snapshot, bindings, contact in cases:
            with self.subTest(snapshot=snapshot, bindings=bindings):
                self.prepare_handoff(lane="main")
                registry.update(lambda doc: (doc["tab_bindings"].clear(), doc["tab_bindings"].update(bindings)))
                with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot):
                    result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(result["state"], "handed_off")
                if contact is None:
                    self.assertNotIn("target_contact", result)
                else:
                    self.assertEqual(result["target_contact"], contact)
                self.assertNotIn("target_contact_stale", result)

    def test_handoff_flags_only_known_renamed_target_contacts(self):
        binding = {"lane": "seo", "label_seen": "SEO", "source": "tab label", "explicit": False,
                   "controller": {"agent": "claude", "kind": "id", "value": "target-session"},
                   "pane_id": "target-pane", "contact": "boon-town-30 [4a7118]"}
        snapshot = {"tab_ids": set(), "controller_counts": {"target-session": 1}}
        self.sessions.mkdir(parents=True)
        for name, session_id, stale in (
            ("boon-town-a3", "target-session", True),
            ("boon-town-30", "target-session", False),
            ("unrelated", "unknown-session", False),
        ):
            with self.subTest(name=name, session_id=session_id):
                self.prepare_handoff(lane="main")
                registry.update(lambda doc: doc["tab_bindings"].update({"target-tab": binding}))
                (self.sessions / "owner.json").write_text(
                    json.dumps({"sessionId": session_id, "name": name}), encoding="utf-8")
                with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot):
                    result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(result["state"], "handed_off")
                self.assertEqual(result["target_contact"], binding["contact"])
                if stale:
                    self.assertEqual(result["target_contact_stale"], name)
                else:
                    self.assertNotIn("target_contact_stale", result)
                self.assertEqual(registry.load()["tab_bindings"]["target-tab"], binding)

    def test_handoff_captures_contact_at_claim_even_when_commit_reports_an_error(self):
        original_herdr = self.ops.herdr
        save = registry.save
        for fail_after_commit in (False, True):
            with self.subTest(fail_after_commit=fail_after_commit):
                self.prepare_handoff(lane="main")
                binding = {"lane": "seo", "label_seen": "SEO", "source": "tab label", "explicit": False,
                           "controller": {"agent": "claude", "kind": "id", "value": "target-session"},
                           "pane_id": "target-pane", "contact": "norm-98 [bcefc3]"}
                registry.update(lambda doc: doc["tab_bindings"].update({"target-tab": binding}))
                failed = []

                def rename(*args, **kwargs):
                    if args[:2] == ("workspace", "rename"):
                        registry.update(lambda doc: doc["tab_bindings"]["target-tab"].update(
                            contact="herdr setup [21ec30]"))
                    return original_herdr(*args, **kwargs)

                def flaky_save(doc):
                    if fail_after_commit and not failed and doc["workers"]["worker"].get("lane") == "seo":
                        failed.append(True)
                        raise PermissionError(5, "Access is denied")
                    return save(doc)

                snapshot = {"tab_ids": {"target-tab"}, "controller_counts": {"target-session": 1}}
                with mock.patch.object(actions.lanes, "read_snapshot", return_value=snapshot), \
                        mock.patch.object(actions.lanes, "claude_session_names",
                                          return_value={"target-session": "renamed"}), \
                        mock.patch.object(self.ops, "herdr", side_effect=rename), \
                        mock.patch.object(registry, "save", side_effect=flaky_save):
                    result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(result["state"], "handed_off")
                self.assertEqual(result["target_contact"], "norm-98 [bcefc3]")
                self.assertEqual(result["target_contact_stale"], "renamed")
                self.assertEqual(bool(failed), fail_after_commit)
                self.assertEqual("warning" in result, fail_after_commit)
                self.assertEqual(registry.load()["tab_bindings"]["target-tab"]["contact"], "herdr setup [21ec30]")

    def test_handoff_reads_one_snapshot_before_any_registry_lock(self):
        self.prepare_handoff()
        load = registry.load
        locked = registry.locked
        snapshots = []
        names_read = []

        def read_snapshot(**kwargs):
            snapshots.append(True)
            return {"tab_ids": set(), "controller_counts": {}}

        def read_names():
            names_read.append(True)
            return {}

        def read_registry():
            self.assertEqual(snapshots, [True], "handoff must snapshot before any registry read")
            self.assertEqual(names_read, [True], "handoff must read names before any registry read")
            return load()

        def registry_lock(*args, **kwargs):
            self.assertEqual(names_read, [True], "handoff must read names before any registry lock")
            return locked(*args, **kwargs)

        with mock.patch.dict(os.environ, {"HERDR_PANE_ID": "caller-pane"}), \
                mock.patch.object(actions.lanes, "read_snapshot", side_effect=read_snapshot) as read, \
                mock.patch.object(actions.lanes, "claude_session_names", side_effect=read_names) as names, \
                mock.patch.object(registry, "load", side_effect=read_registry), \
                mock.patch.object(registry, "locked", side_effect=registry_lock):
            result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
        read.assert_called_once_with(caller_pane_id="caller-pane", ops=self.ops)
        names.assert_called_once_with()
        self.assertEqual(result["state"], "handed_off")

    def test_handoff_carries_open_question_and_relayable_token(self):
        self.prepare_handoff("question", question_text="Pick A or B?")
        self.ops.statuses["worker"] = "blocked"
        actions.handoff("worker", "seo", lane="main", ops=self.ops)
        event = next(e for e in registry.read_events(0, lane="seo") if e["kind"] == "worker_handoff")
        self.assertEqual(event["payload"]["question_text"], "Pick A or B?")
        self.assertEqual(event["payload"]["state_token"], "worker-state")
        reply = actions.relay("worker", "1", state_token=event["payload"]["state_token"],
                              lane="seo", ops=self.ops)
        self.assertEqual(reply["status"], "delivered")

    def test_handoff_requires_a_current_workspace_id_before_renaming(self):
        self.prepare_handoff()
        self.ops.workspace_labels["workspace-1"] = "Unrelated workspace using the stale id"
        original = self.ops.herdr

        def herdr(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("agent", "get"):
                result.data["result"]["agent"].pop("workspace_id", None)
            return result

        with mock.patch.object(self.ops, "herdr", side_effect=herdr):
            with self.assertRaisesRegex(actions.ActionError, "workspace id"):
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertFalse(self.ops.renames)
        self.assertEqual(actions.worker_named("worker")["lane"], "main")
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))
        self.assertEqual(self.ops.workspace_labels["workspace-1"], "Unrelated workspace using the stale id")

    def test_handoff_carries_current_final_message_and_token(self):
        self.prepare_handoff("ended_without_proof", final_message="Please advise")
        original = self.ops.herdr

        def rename(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("workspace", "rename"):
                self.set_state("ended_without_proof", final_message="New final message", state_token="latest")
            return result

        with mock.patch.object(self.ops, "herdr", side_effect=rename):
            actions.handoff("worker", "seo", lane="main", ops=self.ops)
        event = next(e for e in registry.read_events(0, lane="seo") if e["kind"] == "worker_handoff")
        self.assertEqual(event["payload"]["final_message"], "New final message")
        self.assertEqual(event["payload"]["state_token"], "latest")

    def test_handoff_crash_after_rename_is_repaired_without_another_rename(self):
        self.prepare_handoff()
        update = registry.update_with_events

        def crash(fn, **kwargs):
            if fn.__name__ == "commit_handoff":
                raise KeyboardInterrupt("process died before commit")
            return update(fn, **kwargs)

        dead_owner = {"pid": os.getpid(), "created": 0}
        with mock.patch.object(start, "_start_owner", return_value=dead_owner), \
                mock.patch.object(registry, "update_with_events", side_effect=crash):
            with self.assertRaisesRegex(KeyboardInterrupt, "process died"):
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["lane"], "main")
        self.assertEqual(worker["handoff_claim"]["owner"], dead_owner)
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], "seo #7")
        actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertEqual(len(self.ops.renames), 1)
        self.assertEqual(actions.worker_named("worker")["lane"], "seo")
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))
        self.assertEqual(len([e for e in registry.read_events(0) if e["kind"] == "worker_handoff"]), 1)

    def test_handoff_live_claim_serializes_concurrent_targets(self):
        self.prepare_handoff()
        original = self.ops.herdr
        renaming = threading.Event()
        release = threading.Event()
        errors = []

        def herdr(*args, **kwargs):
            if args[:2] == ("workspace", "rename"):
                renaming.set()
                if not release.wait(10):
                    raise TimeoutError("test did not release rename")
            return original(*args, **kwargs)

        def first():
            try:
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
            except BaseException as exc:
                errors.append(exc)

        with mock.patch.object(self.ops, "herdr", side_effect=herdr):
            thread = threading.Thread(target=first, daemon=True)
            thread.start()
            try:
                self.assertTrue(renaming.wait(10))
                with self.assertRaisesRegex(actions.ActionError, "handoff.*seo.*progress"):
                    actions.handoff("worker", "app", lane="main", ops=self.ops)
            finally:
                release.set()
                thread.join(10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(actions.worker_named("worker")["lane"], "seo")
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], "seo #7")
        self.assertEqual(len(self.ops.renames), 1)

    def test_handoff_commit_rechecks_guards_and_rolls_label_back(self):
        for changes, reason in (({"pending_action_id": "late"}, "delivery.*unknown"),
                                ({"action_id": "late"}, "delivery.*unknown"),
                                ({"state": "starting", "start_owner": start._start_owner()}, "start"),
                                ({"state": "starting", "phase": "command_sent", "start_owner": start._start_owner()}, "start"),
                                ({"relay_request": {"text": "late relay"}}, "relay"),
                                ({"state": "cleaning"}, "clean"),
                                ({"state": "cleaned"}, "clean"),
                                ({"lane": "app"}, "lane app")):
            with self.subTest(changes=changes):
                self.prepare_handoff(lane="main", pending_action_id=None, action_id=None,
                                     relay_request=None, start_owner=None, phase="mode_checked")
                registry.update(lambda doc: doc["actions"].update(late={"status": "delivery_unknown"}))
                original = self.ops.herdr

                def rename(*args, **kwargs):
                    result = original(*args, **kwargs)
                    if args[:2] == ("workspace", "rename") and args[3] == "seo #7":
                        registry.update(lambda doc: doc["workers"]["worker"].update(changes))
                    return result

                with mock.patch.object(self.ops, "herdr", side_effect=rename):
                    with self.assertRaisesRegex(actions.ActionError, reason):
                        actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(self.ops.workspace_labels[self.workspace_id], "boon-town #7")
                self.assertNotIn("handoff_claim", actions.worker_named("worker"))
                self.assertFalse([e for e in registry.read_events(0, lane=None) if e["kind"] == "worker_handoff"])

    def test_handoff_rollback_failure_reports_both_labels_and_clears_claim(self):
        self.prepare_handoff()
        original = self.ops.herdr

        def rename(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("workspace", "rename") and args[3] == "seo #7":
                self.set_state("running", relay_request={"text": "late relay"})
            return result

        self.ops.rename_results["boon-town #7"] = adapters.CommandResult(
            False, 1, "", "", error_code="rename_failed", error_message="workspace busy")
        with mock.patch.object(self.ops, "herdr", side_effect=rename):
            with self.assertRaises(actions.ActionError) as refused:
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
        for text in ("relay", "boon-town #7", "seo #7", "workspace busy"):
            self.assertIn(text, str(refused.exception))
        self.assertEqual(actions.worker_named("worker")["lane"], "main")
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))

    def test_handoff_rename_failure_leaves_source_lane_and_names_reason(self):
        self.prepare_handoff()
        self.ops.rename_results["seo #7"] = adapters.CommandResult(
            False, 1, "", "", error_code="rename_failed", error_message="workspace busy")
        with self.assertRaisesRegex(actions.ActionError, "workspace busy"):
            actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertEqual(actions.worker_named("worker")["lane"], "main")
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], "boon-town #7")
        self.assertFalse([e for e in registry.read_events(0) if e["kind"] == "worker_handoff"])

    def test_handoff_rename_action_error_restores_label_and_releases_claim(self):
        self.prepare_handoff()
        original = self.ops.herdr

        def rename(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("workspace", "rename") and args[3] == "seo #7":
                raise actions.ActionError("rename reply lost after applying")
            return result

        with mock.patch.object(self.ops, "herdr", side_effect=rename):
            with self.assertRaisesRegex(actions.ActionError, "rename reply lost"):
                actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertNotIn("handoff_claim", actions.worker_named("worker"))
        self.assertEqual(actions.worker_named("worker")["lane"], "main")
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], "boon-town #7")
        self.assertFalse([e for e in registry.read_events(0) if e["kind"] == "worker_handoff"])

    def test_handoff_during_prepared_entry_refuses_without_cross_lane_send(self):
        self.prepare_handoff("starting", phase="agent_started", start_owner=start._start_owner())
        append = registry.append_event
        attempted = []
        sends = []

        def interleave(kind, payload, **kwargs):
            result = append(kind, payload, **kwargs)
            if kind == "entry_action_recorded":
                attempted.append(True)
                with self.assertRaisesRegex(actions.ActionError, "start|delivery.*unknown"):
                    actions.handoff("worker", "seo", lane="main", ops=self.ops)
            return result

        def send(worker, action, ops):
            sends.append(actions.worker_named("worker")["lane"])

        with mock.patch.object(registry, "append_event", side_effect=interleave), \
                mock.patch.object(start, "_prompt_entry", side_effect=send):
            start._send_entry(actions.worker_named("worker"), self.ops)
        self.assertEqual(attempted, [True])
        self.assertEqual(sends, ["main"])
        self.assertFalse(self.ops.renames)

    def test_handoff_refuses_live_unfinished_start_and_unknown_entry(self):
        owner = start._start_owner()
        for fields, reason in (({"state": "starting", "start_owner": owner}, "start"),
                               ({"state": "starting", "phase": "command_sent", "start_owner": owner}, "start"),
                               ({"action_id": "entry"}, "delivery.*unknown")):
            with self.subTest(fields=fields):
                self.prepare_handoff(lane="main", start_owner=None, action_id=None, phase="mode_checked")
                self.ops.calls.clear()
                registry.update(lambda doc: doc["actions"].update(entry={"status": "delivery_unknown"}))
                registry.update(lambda doc: doc["workers"]["worker"].update(fields))
                before = registry.load()
                with self.assertRaisesRegex(actions.ActionError, reason):
                    actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(registry.load(), before)
                self.assertTrue(all(call[0][:2] in {("tab", "list"), ("pane", "list")}
                                    for call in self.ops.calls))

    def test_handoff_allows_an_unfinished_start_with_a_dead_owner(self):
        self.prepare_handoff("start_interrupted", phase="worktree", start_owner={"pid": 42, "created": 1})
        with mock.patch.object(start, "_process_identity", return_value=None), \
                mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 2}):
            self.assertEqual(actions.handoff("worker", "seo", lane="main", ops=self.ops)["state"], "handed_off")

    def test_handoff_allows_a_failed_start_owned_by_the_live_watcher(self):
        # Delta review, 2026-10-20: the watcher runs queued starts and stays alive, so a failed
        # start's start_owner stays live; only a start still in progress blocks a handoff.
        watcher = start._process_identity(os.getpid())
        self.prepare_handoff("start_failed", phase="worktree", start_owner=watcher, action_id=None)
        self.assertEqual(actions.handoff("worker", "seo", lane="main", ops=self.ops)["state"], "handed_off")

    def test_handoff_committed_before_a_registry_error_keeps_the_target_label(self):
        # Delta review, 2026-10-20: the commit is journaled before the registry replace, so a
        # failure after that point is still a committed handoff; renaming back would leave the
        # workspace labelled for the lane it no longer belongs to.
        self.prepare_handoff()
        save = registry.save
        failed = []

        def flaky(doc):
            if not failed and doc["workers"]["worker"].get("lane") == "seo":
                failed.append(True)
                raise PermissionError(5, "Access is denied")
            return save(doc)

        with mock.patch.object(registry, "save", side_effect=flaky):
            result = actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertTrue(failed)
        self.assertEqual(result["state"], "handed_off")
        worker = actions.worker_named("worker")
        self.assertEqual((worker["lane"], worker.get("handoff_claim")), ("seo", None))
        self.assertEqual(self.ops.workspace_labels[self.workspace_id], result["workspace_label"])
        self.assertEqual(result["warning"],
                         f"{PermissionError(5, 'Access is denied')}; "
                         "target lane seo has no live coordinator; its unattended alert will fire")

    def test_delivered_question_relay_keeps_receipt_and_allows_handoff(self):
        self.prepare_handoff("question")
        self.ops.statuses["worker"] = "blocked"
        result = actions.relay("worker", "1", state_token="worker-state", lane="main", ops=self.ops)
        self.assertEqual(result["status"], "delivered")
        receipt = actions.worker_named("worker")["relay_request"]
        actions.handoff("worker", "seo", lane="main", ops=self.ops)
        self.assertEqual(actions.worker_named("worker")["relay_request"], receipt)
        self.assertEqual(actions.relay("worker", "1", state_token="worker-state", lane="seo", ops=self.ops), result)
        self.assertEqual(len(self.ops.sends), 2)

    def test_handoff_refuses_only_unsettled_relay_receipts(self):
        for status in ("delivery_unknown", "pending", "delivered", "confirmed", "failed", "superseded"):
            with self.subTest(status=status):
                self.prepare_handoff(lane="main", relay_request={"action_id": "relay"})
                registry.update(lambda doc: doc["actions"].update(relay={"status": status}))
                if status in {"delivery_unknown", "pending"}:
                    before = registry.load()
                    with self.assertRaisesRegex(actions.ActionError, "relay"):
                        actions.handoff("worker", "seo", lane="main", ops=self.ops)
                    self.assertEqual(registry.load(), before)
                else:
                    actions.handoff("worker", "seo", lane="main", ops=self.ops)
                    self.assertEqual(actions.worker_named("worker")["relay_request"], {"action_id": "relay"})

    def test_handoff_running_to_in_tool_does_not_require_old_token(self):
        self.prepare_handoff()
        original = self.ops.herdr

        def rename(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("workspace", "rename"):
                actions.change_worker("worker", "in_tool")
            return result

        with mock.patch.object(self.ops, "herdr", side_effect=rename):
            actions.handoff("worker", "seo", lane="main", ops=self.ops)
        worker = actions.worker_named("worker")
        self.assertEqual((worker["state"], worker["lane"]), ("in_tool", "seo"))
        self.assertNotEqual(worker["state_token"], "worker-state")
        event = next(e for e in registry.read_events(0, lane="seo") if e["kind"] == "worker_handoff")
        self.assertEqual(event["payload"]["state_token"], worker["state_token"])

    def test_handoff_refuses_cleanup_pending_action_or_relay_before_external_ops(self):
        for fields, reason in (({"state": "cleaning"}, "clean"),
                               ({"state": "cleaned"}, "clean"),
                               ({"cleanup_from": {"owner": start._start_owner()}}, "clean"),
                               ({"pending_action_id": "pending"}, "delivery.*unknown"),
                               ({"relay_request": {"text": "queued answer"}}, "relay")):
            with self.subTest(fields=fields):
                self.prepare_handoff()
                registry.update(lambda doc: doc["actions"].update(pending={"status": "delivery_unknown"}))
                registry.update(lambda doc: doc["workers"]["worker"].update(fields))
                before = registry.load()
                with self.assertRaisesRegex(actions.ActionError, reason):
                    actions.handoff("worker", "seo", lane="main", ops=self.ops)
                self.assertEqual(registry.load(), before)
                self.assertTrue(all(call[0][:2] in {("tab", "list"), ("pane", "list")}
                                    for call in self.ops.calls))

                def clear(doc):
                    for key in fields:
                        if key != "state":
                            doc["workers"]["worker"].pop(key, None)

                registry.update(clear)

    def test_handoff_refuses_foreign_unknown_and_same_lane_without_mutation(self):
        self.prepare_handoff(lane="seo")
        for lane, target, reason in (("main", "app", "lane seo"), ("seo", "unknown", "Unknown lane"),
                                     ("seo", "seo", "same lane")):
            with self.subTest(lane=lane, target=target):
                before = registry.load()
                with self.assertRaisesRegex(actions.ActionError, reason):
                    actions.handoff("worker", target, lane=lane, ops=self.ops)
                self.assertEqual(registry.load(), before)
                self.assertTrue(all(call[0][:2] in {("tab", "list"), ("pane", "list")}
                                    for call in self.ops.calls))

    def test_cli_handoff_passes_resolved_lane_and_refuses_legacy(self):
        context = {"lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
                   "controller": {"agent": "claude", "kind": "id", "value": "coordinator-session"},
                   "source": "tab label"}
        with mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=context), \
                mock.patch.object(actions, "handoff", return_value={}) as run, \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["handoff", "worker", "app"]), 0)
            run.assert_called_once_with("worker", "app", lane="seo")
        before = registry.load()
        with mock.patch.object(adapters, "herdr", side_effect=AssertionError("no external operations")), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["handoff", "worker", "app", "--legacy"]), 1)
        self.assertIn("--legacy", json.loads(output.getvalue())["detail"])
        self.assertEqual(registry.load(), before)

    def test_agent_status_reads_producer_field_and_defaults_to_unknown(self):
        for state, agent in AGENTS.items():
            with self.subTest(state=state):
                self.assertEqual(actions.agent_status(agent), state)
                self.assertEqual(actions.agent_status(dict(agent, status="legacy")), state)
        self.assertEqual(actions.agent_status({}), "unknown")

    def test_visible_text_reads_plain_stdout_fixture(self):
        self.ops.visible = (FIXTURES / "herdr-agent-read-visible.txt").read_text(encoding="utf-8")
        self.assertEqual(actions.visible_text(self.worker, self.ops, default="unavailable"),
                         self.ops.visible.rstrip())
        self.assertEqual(self.ops.calls[-1],
                         (("agent", "read", "worker", "--source", "visible"),
                          {"timeout": start.COMMAND_TIMEOUT}))

    def test_visible_text_legacy_json_empty_and_failed_reads(self):
        legacy = {"result": {"text": "  Question\n1. A\n \t"}}
        for result, expected in (
            (adapters.CommandResult(True, 0, json.dumps(legacy), "", legacy), "  Question\n1. A"),
            (success(legacy), "  Question\n1. A"),
            (adapters.CommandResult(True, 0, "  Question\n1. A\n \t", ""), "  Question\n1. A"),
            (adapters.CommandResult(True, 0, " \n\t", ""), "unavailable"),
            (success({"result": {"text": " \n\t"}}), "unavailable"),
            (success({"result": {"text": None}}), "unavailable"),
            (adapters.CommandResult(False, 1, "partial output", "read failed"), "unavailable"),
        ):
            with self.subTest(result=result), mock.patch.object(self.ops, "herdr", return_value=result):
                self.assertEqual(actions.visible_text(self.worker, self.ops, default="unavailable"), expected)

    def test_nudge_retry_is_not_new_action_but_same_wording_can_be_new(self):
        first = actions.nudge("worker", ops=self.ops, action_id="n1")
        self.assertEqual(first["status"], "delivered")
        self.assertEqual(actions.nudge("worker", ops=self.ops, action_id="n1")["id"], "n1")
        self.assertEqual(len(self.ops.sends), 1)
        second = actions.nudge("worker", ops=self.ops)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(len(self.ops.sends), 2)
        self.assertEqual(self.ops.sends[0][3], self.ops.sends[1][3])

    def test_timeout_is_durable_unknown_and_never_retried(self):
        self.ops.error = "timeout"
        action = actions.nudge("worker", ops=self.ops, action_id="unknown")
        self.assertEqual(action["status"], "delivery_unknown")
        self.ops.error = None
        actions.nudge("worker", ops=self.ops, action_id="unknown")
        self.assertEqual(len(self.ops.sends), 1)
        with self.assertRaises(actions.ActionError):
            actions.nudge("worker", ops=self.ops)

    def test_delayed_delivery_reconciles_without_resend_and_binds_position(self):
        old = copy.deepcopy(PROMPT)
        old["message"]["content"] = actions.NUDGE_TEXT
        self.ops.write("session-1", [old])
        self.ops.confirm = False
        action = actions.nudge("worker", ops=self.ops, action_id="late")
        self.assertEqual(action["status"], "delivery_unknown")
        self.ops.write("session-1", [old], append=True)
        self.assertEqual(actions.nudge("worker", ops=self.ops, action_id="late")["status"], "delivered")
        self.assertEqual(len(self.ops.sends), 1)

    def test_question_numeric_and_exact_free_text_use_form(self):
        for text, expected in [
            ("1", [("agent", "send-keys", "worker", "1"),
                   ("agent", "send-keys", "worker", "enter")]),
            ("The user's exact words", [("agent", "send-keys", "worker", "3"),
                                    ("pane", "send-text", AGENTS["blocked"]["pane_id"], "The user's exact words"),
                                    ("agent", "send-keys", "worker", "enter")]),
        ]:
            with self.subTest(text=text):
                self.set_state("question", state_token=text, pending_action_id=None)
                self.ops.statuses["worker"] = "blocked"
                self.ops.form_text = text
                before = len(self.ops.sends)
                result = actions.relay("worker", text, state_token=text, ops=self.ops)
                self.assertEqual(result["status"], "delivered")
                self.assertEqual(self.ops.sends[before:], expected)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")

    def test_first_free_text_relay_uses_refreshed_pane(self):
        self.set_state("question")
        self.ops.statuses["worker"] = "blocked"
        self.ops.form_text = "The user's first answer"
        pane = AGENTS["blocked"]["pane_id"]
        self.assertNotEqual(actions.worker_named("worker")["pane_id"], pane)
        original = self.ops.herdr

        def herdr(*args, **kwargs):
            if args[:2] == ("pane", "send-text"):
                self.assertEqual(args[2], pane, "send targeted a stale pane")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=herdr):
            result = actions.relay("worker", self.ops.form_text, state_token="worker-state", ops=self.ops)
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(self.ops.sends[1], ("pane", "send-text", pane, self.ops.form_text))
        self.assertEqual(actions.worker_named("worker")["pane_id"], pane)

    def test_free_text_uses_the_live_form_below_an_older_menu(self):
        # Hand-written screen: an earlier answered menu above the live form.
        self.ops.visible = ("Earlier question?\n1. Yes\n2. Type something.\n\n"
                            "Current question?\n1. A\n2. B\n3. C\n4. Type something.")
        self.set_state("question", state_token="tok", pending_action_id=None)
        self.ops.statuses["worker"] = "blocked"
        self.ops.form_text = "my words"
        actions.relay("worker", "my words", state_token="tok", ops=self.ops)
        self.assertEqual([call[3] for call in self.ops.sends], ["4", "my words", "enter"])

    def test_missing_free_text_option_refuses_without_sending(self):
        self.set_state("question")
        self.ops.statuses["worker"] = "blocked"
        self.ops.visible = "No recognizable free-text option"
        with self.assertRaisesRegex(actions.ActionError, "Cannot identify the form's free-text option"):
            actions.relay("worker", "words", state_token="worker-state", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])

    def test_missing_pane_id_refuses_typed_form_without_sending(self):
        self.set_state("question")
        self.ops.statuses["worker"] = "blocked"
        for pane_id in (None, ""):
            with self.subTest(pane_id=pane_id):
                registry.update(lambda doc: doc["workers"]["worker"].update(pane_id=pane_id))
                with self.assertRaisesRegex(actions.ActionError, "requires a worker pane_id"):
                    actions.relay("worker", "words", state_token="worker-state", ops=self.ops)
                self.assertFalse(self.ops.sends)
                self.assertFalse(registry.load()["actions"])
        registry.update(lambda doc: doc["workers"]["worker"].pop("pane_id"))
        with self.assertRaisesRegex(actions.ActionError, "requires a worker pane_id"):
            actions.relay("worker", "words", state_token="worker-state", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])
        # A numeric answer uses only key names and needs no pane id.
        self.assertEqual(actions.relay("worker", "1", state_token="worker-state", ops=self.ops)["status"],
                         "delivered")

    def test_text_step_rejection_fails_once_and_fresh_relay_is_accepted(self):
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        rejection = {"error": {"code": "invalid_key", "message": "unsupported key words"},
                     "id": "cli:pane:send-text"}
        self.ops.send_results[("pane", "send-text")] = adapters.CommandResult(
            False, 1, json.dumps(rejection), "", rejection,
            error_code="invalid_key", error_message="unsupported key words")
        first = actions.relay("worker", "words", state_token="q1", ops=self.ops, action_id="rejected")
        self.assertEqual(first["status"], "failed")
        self.assertEqual(first["reason"], "invalid_key: unsupported key words")
        self.assertEqual(first["steps_sent"], ["3"])
        self.assertEqual(first["last_send"], ["pane", "send-text", AGENTS["blocked"]["pane_id"], "words"])
        self.assertNotIn("pending_action_id", registry.load()["workers"]["worker"])
        events = [e for e in registry.read_events(0) if e["kind"] == "delivery_failed"]
        self.assertEqual(len(events), 1)
        payload = events[0]["payload"]
        self.assertEqual(payload["worker_id"], "worker")
        self.assertEqual(payload["agent_name"], "worker")
        self.assertEqual(payload["action_id"], "rejected")
        self.assertEqual(payload["reason"], first["reason"])
        self.assertEqual(payload["steps_sent"], ["3"])
        self.assertTrue(payload["partial"])
        self.assertIn("check the pane", payload["detail"])
        self.assertFalse(any(e["kind"] == "delivery_unknown" for e in registry.read_events(0)))
        self.assertEqual(self.ops.sends, [("agent", "send-keys", "worker", "3"),
                                         ("pane", "send-text", AGENTS["blocked"]["pane_id"], "words")])
        self.ops.send_results.clear()
        # Neither replay nor reconciliation retries the failed action.
        self.assertEqual(actions.relay("worker", "words", state_token="q1", ops=self.ops)["status"], "failed")
        self.assertEqual(actions.reconcile_action("rejected", ops=self.ops)["status"], "failed")
        self.assertEqual(len(self.ops.sends), 2)
        self.set_state("question", state_token="q2")
        self.ops.form_text = "words"
        fresh = actions.relay("worker", "words", state_token="q2", ops=self.ops)
        self.assertEqual(fresh["status"], "delivered")
        self.assertNotEqual(fresh["id"], first["id"])
        self.assertEqual(len(self.ops.sends), 5)
        # Matching later transcript content cannot change the failed receipt.
        self.assertEqual(actions.reconcile_action("rejected", ops=self.ops)["status"], "failed")
        self.assertEqual(sum(e["kind"] == "delivery_failed" for e in registry.read_events(0)), 1)

    def test_rejection_before_any_step_reports_no_partial_delivery(self):
        self.set_state("question")
        self.ops.statuses["worker"] = "blocked"
        self.ops.send_results[("agent", "send-keys")] = adapters.CommandResult(
            False, 1, "", "", error_code="invalid_key", error_message="unsupported key 1")
        action = actions.relay("worker", "1", state_token="worker-state", ops=self.ops)
        self.assertEqual(action["status"], "failed")
        self.assertEqual(action["steps_sent"], [])
        event = next(e for e in registry.read_events(0) if e["kind"] == "delivery_failed")
        self.assertFalse(event["payload"]["partial"])
        self.assertIn("No earlier steps were applied", event["payload"]["detail"])
        self.assertEqual(len(self.ops.sends), 1)

    def test_uncertain_text_step_stays_unknown_and_blocks_later_sends(self):
        for failure in (
            adapters.CommandResult(False, None, "", "", error_code="timeout", error_message="timeout"),
            adapters.CommandResult(False, None, "", "", error_code="command_not_found", error_message="OS error"),
            adapters.CommandResult(False, 1, "", "", error_code="command_failed", error_message="no output"),
            adapters.CommandResult(False, 1, "", ""),
            adapters.CommandResult(False, 1, "", "", error_code=""),
            OSError("broken pipe"),
            TimeoutError("timed out"),
        ):
            with self.subTest(failure=failure):
                registry.update(lambda doc: doc["actions"].clear())
                self.set_state("question", state_token="q1", pending_action_id=None)
                self.ops.statuses["worker"] = "blocked"
                self.ops.sends.clear()
                self.ops.send_results[("pane", "send-text")] = failure
                action = actions.relay("worker", "words", state_token="q1", ops=self.ops)
                self.assertEqual(action["status"], "delivery_unknown")
                self.assertEqual(action["steps_sent"], ["3"])
                self.assertEqual(len(self.ops.sends), 2)
                self.assertEqual(actions.reconcile_action(action["id"], ops=self.ops)["status"], "delivery_unknown")
                self.set_state("question", state_token="q2")
                with self.assertRaisesRegex(actions.ActionError, "Previous action delivery is unknown"):
                    actions.relay("worker", "new words", state_token="q2", ops=self.ops)
                self.assertEqual(len(self.ops.sends), 2)
        self.assertFalse(any(e["kind"] == "delivery_failed" for e in registry.read_events(0)))

    def test_a_compaction_summary_never_confirms_a_send(self):
        action = {"transcript_position": 0, "text": "Yes on all of those"}
        summary = {"type": "user", "isSidechain": False, "isCompactSummary": True,
                   "message": {"role": "user", "content": "Yes on all of those"}}
        self.assertFalse(actions._confirmed(action, [summary]))
        self.assertTrue(actions._confirmed(action, [dict(summary, isCompactSummary=False)]))

    def test_relay_confirms_a_delivered_unknown_action_instead_of_refusing(self):
        # Live: norm-308's relay arrived but stayed delivery_unknown, so every later relay was
        # refused until the watcher reconciled it.
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        self.ops.write("session-1", [PROMPT])
        first = {"id": "earlier", "worker_id": "worker", "kind": "relay", "text": "go ahead",
                 "session_id": "session-1", "state_token": "q1", "transcript_position": 1,
                 "transport": "prompt", "status": "delivery_unknown", "reason": "Send timed out"}
        registry.update(lambda doc: (doc["actions"].update({"earlier": first}),
                                     doc["workers"]["worker"].update(pending_action_id="earlier")))
        with self.assertRaisesRegex(actions.ActionError, "Previous action delivery is unknown"):
            actions.relay("worker", "1", state_token="q1", ops=self.ops)
        delivered = copy.deepcopy(PROMPT)
        delivered["message"]["content"] = "go ahead"
        self.ops.write("session-1", [delivered], append=True)
        actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertEqual(registry.load()["actions"]["earlier"]["status"], "delivered")
        self.assertTrue(self.ops.sends)

    def test_a_relay_typed_behind_an_unsent_draft_is_confirmed(self):
        # boon-town #2458, 2026-10-20: The user's unsent draft went out ahead of the typed relay, so the
        # prompt was draft + relay and the relay stayed delivery_unknown, refusing every later one.
        text = "yes add the policy change label and all the worker to commit those 2 files"
        action = {"transcript_position": 0, "text": text, "transport": "prompt"}

        def prompt(content):
            record = copy.deepcopy(PROMPT)
            record["message"]["content"] = content
            return record

        cases = (
            ("draft then relay (live #2458)", "add the policy label and allow the commit" + text, True),
            ("relay alone", text, True),
            ("trailing newline", text + "\n", True),
            ("relay quoted mid-prompt", f"Earlier you said '{text}', but wait", False),
            ("a different prompt", "something else entirely", False),
            ("a tool result ending with it", [{"type": "tool_result", "tool_use_id": "t", "content": text}], False),
            ("a system-written record ending with it", "<local-command-stdout>" + text, False),
        )
        for name, content, expected in cases:
            with self.subTest(name):
                self.assertEqual(actions._confirmed(action, [prompt(content)]), expected)
        # relay() refuses only empty text, so a blank relay must not match every prompt's end.
        self.assertFalse(actions._confirmed(dict(action, text="  "), [prompt("anything at all")]))
        # A short answer's ending identifies nothing: "yes" ends "...my eyes", "1" ends "issue 241".
        for short, content in (("yes", "rest my eyes"), ("1", "Investigate issue 241"), ("go", "long ago")):
            with self.subTest(short=short):
                self.assertFalse(actions._confirmed(dict(action, text=short), [prompt(content)]))
                self.assertTrue(actions._confirmed(dict(action, text=short), [prompt(short)]))
        # ...unless the prompt was written within seconds of the send (live #2458: 0.6 s).
        sent = datetime(2026, 10, 20, 13, 19, 5, tzinfo=timezone.utc).timestamp()
        short = dict(action, text="go ahead", created_at=sent)
        for delay, expected in ((0.6, True), (29, True), (31, False), (-5, False)):
            with self.subTest(delay=delay):
                record = prompt("draft textgo ahead")
                record["timestamp"] = datetime.fromtimestamp(sent + delay, timezone.utc).isoformat().replace("+00:00", "Z")
                self.assertEqual(actions._confirmed(short, [record]), expected)
        self.assertFalse(actions._confirmed(dict(short, created_at=None), [prompt("draftgo ahead")]))
        # A prompt queued while the worker was busy is an attachment; it is the send's own prompt.
        def queued(text):
            return {"type": "attachment", "isSidechain": False,
                    "attachment": {"type": "queued_command", "commandMode": "prompt", "prompt": text}}
        self.assertTrue(actions._confirmed(action, [queued("draft" + text)]))
        self.assertTrue(actions._confirmed(action, [queued(text)]))
        self.assertFalse(actions._confirmed(action, [queued("something else"), prompt("Never mind; " + text)]))
        # Only the prompt the send produced carries the draft; the user's later prompt is their own.
        own = prompt("Never mind; " + text)
        self.assertFalse(actions._confirmed(action, [prompt("something else first"), own]))
        # A command expansion or background notice before it does not use up the first prompt.
        meta = dict(prompt("Base directory for this skill: ..."), isMeta=True)
        self.assertTrue(actions._confirmed(action, [meta, prompt("draft" + text)]))

    def test_textless_unknown_action_is_refused_without_a_crash(self):
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        self.ops.write("session-1", [PROMPT, PROMPT])
        legacy = {"id": "legacy", "worker_id": "worker", "kind": "resume", "session_id": "session-1",
                  "transcript_position": 1, "transport": "prompt", "status": "delivery_unknown",
                  "reason": "Send timed out"}
        registry.update(lambda doc: (doc["actions"].update({"legacy": legacy}),
                                     doc["workers"]["worker"].update(pending_action_id="legacy")))
        with self.assertRaisesRegex(actions.ActionError, "Previous action delivery is unknown"):
            actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertFalse(self.ops.sends)

    def test_raw_command_failed_json_is_a_known_rejection(self):
        self.set_state("question")
        self.ops.statuses["worker"] = "blocked"
        rejection = json.dumps({"error": {"code": "invalid_key", "message": "unsupported key words"}})
        self.ops.send_results[("pane", "send-text")] = adapters.CommandResult(
            False, 1, rejection, "", error_code="command_failed", error_message=rejection)
        action = actions.relay("worker", "words", state_token="worker-state", ops=self.ops)
        self.assertEqual(action["status"], "failed")
        self.assertEqual(action["steps_sent"], ["3"])
        self.assertEqual(action["reason"], "command_failed: " + rejection)
        self.assertEqual(sum(e["kind"] == "delivery_failed" for e in registry.read_events(0)), 1)
        self.assertFalse(any(e["kind"] == "delivery_unknown" for e in registry.read_events(0)))

    def store_legacy_unknown(self, reason):
        self.set_state("question", pending_action_id="legacy", state_token="q1")
        action = {"id": "legacy", "worker_id": "worker", "kind": "relay", "text": "words",
                  "session_id": "session-1", "state_token": "q1", "transport": "form",
                  "transcript_position": 1, "status": "delivery_unknown", "reason": reason}
        registry.update(lambda doc: doc["actions"].update(legacy=action))
        return action

    def test_old_explicit_rejection_reconciles_to_failed_with_unknown_steps(self):
        reason = 'command_failed: {"error":{"code":"invalid_key","message":"unsupported key words"}}'
        self.store_legacy_unknown(reason)
        action = actions.reconcile_action("legacy", ops=self.ops)
        self.assertEqual(action["status"], "failed")
        self.assertEqual(action["reason"], reason)
        self.assertIsNone(action["steps_sent"])
        self.assertNotIn("pending_action_id", registry.load()["workers"]["worker"])
        self.assertEqual(actions.reconcile_action("legacy", ops=self.ops), action)
        events = [e for e in registry.read_events(0) if e["kind"] == "delivery_failed"]
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["payload"]["steps_sent"])
        self.assertIsNone(events[0]["payload"]["partial"])
        self.assertIn("check the pane", events[0]["payload"]["detail"])
        self.assertFalse(self.ops.sends)

    def test_old_uncertain_or_malformed_reason_stays_unknown(self):
        for reason in ("timeout: timed out", "command_failed: no output", "command_failed: {",
                       "command_failed: []", 'command_failed: {"error":"invalid_key"}',
                       'command_failed: {"error":{"message":"failed"}}',
                       'command_failed: {"error":{"code":null}}'):
            with self.subTest(reason=reason):
                self.store_legacy_unknown(reason)
                self.assertEqual(actions.reconcile_action("legacy", ops=self.ops, records=[])["status"],
                                 "delivery_unknown")
                self.assertEqual(registry.load()["workers"]["worker"]["pending_action_id"], "legacy")
        self.assertFalse(self.ops.sends)
        self.assertFalse(any(e["kind"] == "delivery_failed" for e in registry.read_events(0)))

    def test_watch_poll_recovers_old_rejection_and_notifies_with_repository_prefix(self):
        import watch

        reason = 'command_failed: {"error":{"code":"invalid_key","message":"unsupported key words"}}'
        self.store_legacy_unknown(reason)
        self.ops.statuses["worker"] = "blocked"
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["actions"]["legacy"]["status"], "failed")
        self.assertEqual(len(self.ops.notifications), 1)
        notification = self.ops.notifications[0]
        self.assertEqual(notification[2], f"main: {watch.repo_root.display_name(self.temp.name)} #1: Worker delivery failed")
        self.assertIn(reason, notification[4])
        self.assertIn("check the pane", notification[4])
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)

    def test_running_relay_refused_and_ended_relay_waits_for_slot(self):
        with self.assertRaises(actions.ActionError):
            actions.relay("worker", "words", state_token="worker-state", ops=self.ops)
        self.set_state("ended_without_proof")
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.add_worker("busy", session="busy-session", issue=2)
        result = actions.relay("worker", "exact words", state_token="worker-state", ops=self.ops)
        self.assertEqual(result["state"], "relay_pending")
        self.assertFalse(self.ops.sends)
        with self.assertRaises(actions.ActionError):
            actions.relay("worker", "replacement", state_token="worker-state", ops=self.ops)

    def test_relay_reopens_a_done_worker_in_a_free_slot_or_queues(self):
        # Live: norm-289 was done (PR merged) when commissioning found a defect in its work.
        for state in ("done", "awaiting_merge"):
            with self.subTest(state=state):
                self.set_state(state, state_token="worker-state", pending_action_id=None)
                self.ops.sends.clear()
                result = actions.relay("worker", f"follow-up {state}", state_token="worker-state", ops=self.ops)
                self.assertNotEqual(result.get("state"), "relay_pending")
                self.assertEqual([call[1] for call in self.ops.sends], ["prompt"])
                self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.set_state("done", state_token="worker-state", pending_action_id=None)
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.add_worker("busy", session="busy-session", issue=2)
        self.ops.sends.clear()
        result = actions.relay("worker", "follow-up at cap", state_token="worker-state", ops=self.ops)
        self.assertEqual(result["state"], "relay_pending")
        self.assertFalse(self.ops.sends)

    def test_relay_to_waiting_background_worker_sends_a_prompt_using_its_own_slot(self):
        # Live: taste-swipe #37 sat idle at its prompt with a long-lived Postgres shell open.
        self.set_state("waiting_background")
        registry.update(lambda doc: doc["config"].update(cap=1))
        with self.assertRaisesRegex(actions.ActionError, "Stale relay"):
            actions.relay("worker", "new report", state_token="old-token", ops=self.ops)
        result = actions.relay("worker", "new report", state_token="worker-state", ops=self.ops)
        self.assertNotEqual(result.get("state"), "relay_pending")
        self.assertEqual([call[1] for call in self.ops.sends], ["prompt"])
        self.assertEqual(self.ops.sends[0][3], "new report")

    def test_relay_queues_when_slot_is_taken_during_preflight(self):
        self.set_state("ended_without_proof")
        registry.update(lambda doc: doc["config"].update(cap=1))
        original = self.ops.herdr

        def preflight(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                self.add_worker("busy", session="busy-session", issue=2)
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=preflight):
            result = actions.relay("worker", "The user's words", state_token="worker-state", ops=self.ops)
        self.assertEqual(result["state"], "relay_pending")
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "relay_pending")
        self.assertFalse(self.ops.sends)

    def test_ended_relay_replay_after_crash_before_ack_does_not_resend(self):
        self.set_state("ended_without_proof", state_token="turn-1")
        seq = registry.append_event("worker_state", {"state": "ended_without_proof"})
        first = actions.relay("worker", "Please use A", state_token="turn-1", ops=self.ops)
        self.assertEqual(first["status"], "delivered")
        self.assertIn(seq, [event["seq"] for event in registry.read_events(registry.load()["lanes"]["main"]["ack_seq"])])
        replay = actions.relay("worker", "Please use A", state_token="turn-1", ops=self.ops, action_id=first["id"])
        self.assertEqual(replay["id"], first["id"])
        self.assertEqual(len(self.ops.sends), 1)
        registry.ack(seq)
        self.assertNotIn(seq, [event["seq"] for event in registry.read_events(registry.load()["lanes"]["main"]["ack_seq"])])

    def test_relay_replay_after_next_question_is_stale_without_sending(self):
        first_question = actions.change_worker("worker", "question", question_text="Q1")
        question_seq = registry.load()["event_seq"]
        self.ops.statuses["worker"] = "blocked"
        first = actions.relay("worker", "1", state_token=first_question["state_token"], ops=self.ops)
        self.assertEqual(first["status"], "delivered")
        self.assertEqual(first["state_token"], first_question["state_token"])
        # Crash-before-ack: Q1 is still replayable after the worker reaches Q2.
        second_question = actions.change_worker("worker", "question", question_text="Q2")
        self.ops.statuses["worker"] = "blocked"
        before = list(self.ops.sends)
        self.assertIn(question_seq, [e["seq"] for e in registry.read_events(registry.load()["lanes"]["main"]["ack_seq"])])
        for text in ("1", "different answer"):
            for action_id in (None, first["id"], "fresh-id"):
                with self.subTest(text=text, action_id=action_id), self.assertRaisesRegex(actions.ActionError, "Stale relay replay"):
                    actions.relay("worker", text, state_token=first_question["state_token"], ops=self.ops, action_id=action_id)
        self.assertEqual(self.ops.sends, before)
        self.assertEqual(len(registry.load()["actions"]), 1)
        with self.assertRaisesRegex(actions.ActionError, "different request"):
            actions.relay("worker", "1", state_token=second_question["state_token"], ops=self.ops, action_id=first["id"])
        # Q2's token binds a new answer even when the text is unchanged.
        result = actions.relay("worker", "1", state_token=second_question["state_token"], ops=self.ops)
        self.assertEqual(result["status"], "delivered")
        self.assertNotEqual(result["id"], first["id"])
        self.assertEqual(result["state_token"], second_question["state_token"])
        sends = list(self.ops.sends)
        for action_id in (None, result["id"], "another-id"):
            replay = actions.relay("worker", "1", state_token=second_question["state_token"], ops=self.ops, action_id=action_id)
            self.assertEqual(replay["id"], result["id"])
        self.assertEqual(self.ops.sends, sends)
        self.assertEqual(len(sends), len(before) + 2)
        self.assertEqual(len(registry.load()["actions"]), 2)

    def test_deliberate_identical_relay_to_running_worker_is_refused(self):
        self.set_state("ended_without_proof", state_token="turn-1")
        first = actions.relay("worker", "Please use A", state_token="turn-1", ops=self.ops)
        self.assertEqual(first["status"], "delivered")
        with self.assertRaisesRegex(actions.ActionError, "Cannot relay to a running worker"):
            actions.relay("worker", "Please use A", state_token=registry.load()["workers"]["worker"]["state_token"], ops=self.ops)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(len(registry.load()["actions"]), 1)

    def test_unknown_relay_replay_with_same_token_is_deduplicated(self):
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        self.ops.error = "timeout"
        first = actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertEqual(first["status"], "delivery_unknown")
        self.assertEqual(registry.load()["workers"]["worker"]["state_token"], "q1")
        self.ops.error = None
        replay = actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertEqual(replay["id"], first["id"])
        self.assertEqual(replay["status"], "delivery_unknown")
        self.assertEqual(len(self.ops.sends), 1)
        actions.change_worker("worker", "running")
        self.assertEqual(actions.relay("worker", "1", state_token="q1", ops=self.ops)["id"], first["id"])
        actions.change_worker("worker", "question", question_text="Q2")
        with self.assertRaisesRegex(actions.ActionError, "Stale relay replay"):
            actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertEqual(len(self.ops.sends), 1)

    def test_question_changes_during_preflight_refuses_send(self):
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        original = self.ops.herdr

        def preflight(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                self.set_state("question", state_token="q2")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=preflight):
            with self.assertRaisesRegex(actions.ActionError, "Worker state changed"):
                actions.relay("worker", "1", state_token="q1", ops=self.ops)
        self.assertFalse(self.ops.sends)

    def test_relay_lookup_ignores_entry_receipts_without_text(self):
        self.set_state("ended_without_proof", state_token="q1")
        registry.update(lambda doc: doc["actions"].update(entry={
            "id": "entry", "worker_id": "worker", "kind": "entry", "status": "delivered"}))
        result = actions.relay("worker", "continue", state_token="q1", ops=self.ops)
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(len(self.ops.sends), 1)

    def test_rotation_preserves_a_relay_request_for_another_action(self):
        self.ops.error = "timeout"
        actions.nudge("worker", ops=self.ops, action_id="old")
        request = {"action_id": "new-relay", "text": "Continue", "state_token": "worker-state"}
        self.set_state("relay_pending", relay_request=request)
        current = actions.refresh_session(actions.worker_named("worker"), {"agent_session": {"value": "session-2"}})
        self.assertEqual(current["relay_request"], request)
        self.assertEqual(registry.load()["actions"]["old"]["status"], "superseded")

    def test_rotation_supersedes_unknown_once_and_allows_new_nudge(self):
        self.ops.error = "timeout"
        first = actions.nudge("worker", ops=self.ops, action_id="old")
        self.assertEqual(first["status"], "delivery_unknown")
        self.ops.sessions["worker"] = "session-2"
        self.ops.write("session-2", [PROMPT])
        self.ops.error = None
        worker = actions.worker_named("worker")
        agent = actions.agent_info(worker, self.ops)
        rotated = actions.refresh_session(worker, agent)
        actions.refresh_session(worker, agent)  # stale caller snapshot is harmless
        self.assertNotIn("pending_action_id", rotated)
        self.assertEqual(registry.load()["actions"]["old"]["status"], "superseded")
        events = [e for e in registry.read_events(0) if e["kind"] == "action_superseded"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["action_id"], "old")
        self.assertEqual(events[0]["payload"]["previous_session_id"], "session-1")
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(actions.nudge("worker", ops=self.ops, action_id="old")["status"], "superseded")
        self.assertEqual(actions._unknown("old", "late failure")["status"], "superseded")
        self.assertEqual(len(self.ops.sends), 1)
        second = actions.nudge("worker", ops=self.ops, action_id="new")
        self.assertEqual(second["status"], "delivered")
        self.assertEqual(second["session_id"], "session-2")
        self.assertEqual(len(self.ops.sends), 2)

    def test_rotation_supersedes_a_textless_unknown_action_without_failing(self):
        # Entry and resume actions have no "text"; superseding one must not raise.
        self.ops.error = "timeout"
        actions.nudge("worker", ops=self.ops, action_id="old")
        registry.update(lambda doc: doc["actions"]["old"].pop("text", None))
        self.ops.sessions["worker"] = "session-2"
        self.ops.write("session-2", [PROMPT])
        self.ops.error = None
        worker = actions.worker_named("worker")
        rotated = actions.refresh_session(worker, actions.agent_info(worker, self.ops))
        self.assertNotIn("pending_action_id", rotated)
        events = [e for e in registry.read_events(0) if e["kind"] == "action_superseded"]
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["payload"]["text"])

    def test_change_worker_recovers_event_after_registry_replace_failure(self):
        with mock.patch.object(registry, "save", side_effect=RuntimeError("crash before replace")):
            with self.assertRaisesRegex(RuntimeError, "crash before replace"):
                actions.change_worker("worker", "question", now=123, expected="running", question_text="Q1")
        current = actions.change_worker("worker", "question", now=456, expected="running", question_text="Q1")
        events = [e for e in registry.read_events(0) if e["kind"] == "worker_state"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"], current)
        self.assertEqual(current["last_change"], 123)
        self.assertEqual(current["question_text"], "Q1")

    def test_change_worker_appends_event_before_replacing_state(self):
        replace = registry.os.replace
        checked = []

        def inspect_replace(source, target):
            if Path(target).name == "registry.json":
                doc = json.loads(Path(source).read_text(encoding="utf-8"))
                if doc["workers"]["worker"]["state"] == "question":
                    event_path = registry._home() / "events.jsonl"
                    self.assertTrue(event_path.exists(), "State replacement preceded its event")
                    events = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines()]
                    self.assertEqual(events[-1]["payload"], doc["workers"]["worker"])
                    self.assertEqual(events[-1]["seq"], doc["event_seq"])
                    checked.append(True)
            replace(source, target)

        with mock.patch.object(registry.os, "replace", side_effect=inspect_replace):
            actions.change_worker("worker", "question", question_text="Q1")
        self.assertEqual(checked, [True])

    def test_unknown_report_flag_and_event_recover_together(self):
        self.ops.confirm = False
        with mock.patch.object(actions, "report_delivery_unknown"):
            actions.nudge("worker", ops=self.ops, action_id="unknown")
        with mock.patch.object(registry, "save", side_effect=RuntimeError("crash before replace")):
            with self.assertRaises(RuntimeError):
                actions.report_delivery_unknown("unknown")
        actions.report_delivery_unknown("unknown")
        events = [e for e in registry.read_events(0) if e["kind"] == "delivery_unknown"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["action_id"], "unknown")
        self.assertTrue(registry.load()["actions"]["unknown"]["delivery_unknown_reported"])

    def test_resume_lost_uses_explicit_model_mode_and_confirms_session_before_prompt(self):
        self.set_state("lost")
        registry.update(lambda doc: doc["config"].update(permission_mode="bypassPermissions"))
        self.ops.sessions["worker"] = "new-session"
        self.ops.write("new-session", [PROMPT])
        result = actions.resume("worker", ops=self.ops, action_id="resume-1")
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(self.ops.start_calls[0], (
            "agent", "start", "worker", "--kind", "claude", "--pane", "pane-1", "--",
            "--resume", "session-1", "--model", "claude-opus-5-5", "--permission-mode", "bypassPermissions"))
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["session_id"], "new-session")
        self.assertEqual(worker["session_history"], ["session-1", "new-session"])
        self.assertLess(next(i for i, (args, _) in enumerate(self.ops.calls) if args[1] == "get"),
                        next(i for i, (args, _) in enumerate(self.ops.calls) if args[1] == "prompt"))
        actions.resume("worker", ops=self.ops, action_id="resume-1")
        self.assertEqual(len(self.ops.start_calls), 1)
        self.assertEqual(len(self.ops.sends), 1)

    def test_resume_unconfirmed_session_and_start_timeout_send_no_prompt(self):
        for error in (None, "timeout"):
            with self.subTest(error=error):
                self.set_state("lost", pending_action_id=None)
                self.ops.sessions["worker"] = None
                self.ops.error = error
                with mock.patch.object(start, "SESSION_TIMEOUT", 0):
                    result = actions.resume("worker", ops=self.ops)
                self.assertEqual(result["status"], "delivery_unknown")
                self.assertFalse(self.ops.sends)

    def test_blocked_resume_is_not_sent_and_exposes_a_relayable_question(self):
        import watch

        self.set_state("lost")
        self.ops.statuses["worker"] = "blocked"
        old_token = actions.worker_named("worker")["state_token"]
        result = actions.resume("worker", ops=self.ops, action_id="blocked-resume")
        self.assertEqual(result["status"], "not_sent")
        self.assertEqual(result["state"], "question")
        self.assertIn("asking a question", result["reason"])
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "question")
        self.assertNotIn("pending_action_id", worker)
        self.assertNotEqual(worker["state_token"], old_token)
        self.assertEqual(worker["question_text"], self.ops.visible)
        questions = [event for event in registry.read_events(0)
                     if event["kind"] == "worker_state" and event["payload"]["state"] == "question"]
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["payload"]["state_token"], worker["state_token"])
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn(self.ops.visible, self.ops.notifications[0][4])
        self.assertFalse(self.ops.sends)
        # Identical later input cannot turn a known-unsent prompt into delivery proof.
        prompt = copy.deepcopy(PROMPT)
        prompt["message"]["content"] = actions.RESUME_TEXT
        self.ops.write("session-1", [prompt], append=True)
        self.assertEqual(actions.reconcile_action(result["id"], ops=self.ops)["status"], "not_sent")
        self.assertEqual(actions.resume("worker", ops=self.ops, action_id=result["id"])["status"], "not_sent")
        self.assertEqual(len(self.ops.start_calls), 1)
        self.assertFalse(self.ops.sends)
        relay = actions.relay("worker", "1", state_token=worker["state_token"], ops=self.ops)
        self.assertEqual(relay["status"], "delivered")
        self.assertEqual([send[1] for send in self.ops.sends], ["send-keys", "send-keys"])

    def test_resume_blocked_producer_fixture_sends_no_prompt_or_retry(self):
        self.set_state("lost")
        self.ops.statuses["worker"] = "blocked"
        result = actions.resume("worker", ops=self.ops, action_id="blocked-resume")
        self.assertEqual(result["status"], "not_sent")
        self.assertIn("asking a question", result["reason"])
        self.assertEqual(len(self.ops.start_calls), 1)
        self.assertFalse(self.ops.sends)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "question")
        actions.resume("worker", ops=self.ops, action_id="blocked-resume")
        self.assertEqual(len(self.ops.start_calls), 1)
        self.assertFalse(self.ops.sends)

    def test_ended_relay_blocked_producer_fixture_refuses_normal_prompt(self):
        self.set_state("ended_without_proof")
        self.ops.statuses["worker"] = "blocked"
        with self.assertRaisesRegex(actions.ActionError, "blocked worker needs a question relay"):
            actions.relay("worker", "Continue", state_token="worker-state", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])

    def test_all_sends_obey_holds_and_go_returns_every_hold(self):
        holds = {"herdr_lost": {"ts": 1}, "watcher_lost": {"ts": 2}}
        registry.update(lambda doc: doc["holds"].update(holds))
        for state, function in [("running", lambda: actions.nudge("worker", ops=self.ops)),
                                ("lost", lambda: actions.resume("worker", ops=self.ops)),
                                ("question", lambda: actions.relay("worker", "1", state_token="worker-state", ops=self.ops))]:
            self.set_state(state)
            with self.subTest(state=state), self.assertRaises(actions.ActionError):
                function()
        self.assertFalse(self.ops.sends)
        self.assertFalse(self.ops.start_calls)
        self.assertEqual(actions.go(ops=self.ops), {"cleared": holds})
        self.assertEqual(registry.load()["holds"], {})
        self.assertEqual(actions.go(ops=self.ops), {"cleared": {}})

    def test_blocked_agent_never_receives_normal_prompt(self):
        self.ops.statuses["worker"] = "blocked"
        with self.assertRaises(actions.ActionError):
            actions.nudge("worker", ops=self.ops)
        self.assertFalse(self.ops.sends)

    def test_action_id_cannot_be_rebound(self):
        actions.nudge("worker", ops=self.ops, action_id="shared")
        self.set_state("ended_without_proof")
        with self.assertRaises(actions.ActionError):
            actions.relay("worker", "other", state_token="worker-state", ops=self.ops, action_id="shared")

    def test_cli_ack_go_status_and_action_dispatch(self):
        registry.update(lambda doc: doc["holds"].update(herdr_lost={"ts": 123}, watcher_lost={"ts": 456}))
        with mock.patch("watch.watcher_alive", return_value=False), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["status"]), 0)
            self.assertIn("#1\tworker\trunning\tPR=-\tlast_change=", output.getvalue())
            self.assertIn("watcher: stale", output.getvalue())
            self.assertIn("hold: herdr_lost since 123\n", output.getvalue())
            self.assertIn("hold: watcher_lost since 456\n", output.getvalue())
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            for _ in range(3):
                registry.append_event("observed", {})
            self.assertEqual(herdr_coord.main(["ack", "3"]), 0)
            self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 3)
            self.assertEqual(herdr_coord.main(["ack", "-1"]), 1)
            self.assertEqual(herdr_coord.main(["go"]), 0)
            with mock.patch.object(actions, "relay", return_value={"status": "delivered"}) as relay:
                self.assertEqual(herdr_coord.main(["relay", "worker", "exact words", "--token", "q1", "--action-id", "r1"]), 0)
                relay.assert_called_once_with("worker", "exact words", state_token="q1", action_id="r1",
                                              dismiss_form=False, lane="main")

    def test_cli_relay_requires_token(self):
        with mock.patch.object(actions, "relay", return_value={"status": "delivered"}) as relay, mock.patch("sys.stderr", new_callable=io.StringIO) as error:
            with self.assertRaises(SystemExit) as refused:
                herdr_coord.main(["relay", "worker", "answer"])
        self.assertEqual(refused.exception.code, 2)
        self.assertIn("--token", error.getvalue())
        relay.assert_not_called()


if __name__ == "__main__":
    unittest.main()
