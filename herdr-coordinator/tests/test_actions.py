import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts"))

import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import actions
import adapters
import herdr_coord
import registry
import start


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
        self.env = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(Path(self.temp.name) / "home")})
        self.env.start()
        self.addCleanup(self.env.stop)
        # Never spawn a real detached watcher from a test (test_watcher_guard covers this path).
        no_watcher = mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None)
        no_watcher.start()
        self.addCleanup(no_watcher.stop)
        self.ops = FakeOps(Path(self.temp.name) / "projects")
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
                                    ("pane", "send-text", "pane-1", "The user's exact words"),
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
        self.assertEqual(first["last_send"], ["pane", "send-text", "pane-1", "words"])
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
                                          ("pane", "send-text", "pane-1", "words")])
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
        self.assertEqual(notification[2], f"{watch.repo_root.display_name(self.temp.name)} #1: Worker delivery failed")
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
        self.assertIn(seq, [event["seq"] for event in registry.read_events(registry.load()["ack_seq"])])
        replay = actions.relay("worker", "Please use A", state_token="turn-1", ops=self.ops, action_id=first["id"])
        self.assertEqual(replay["id"], first["id"])
        self.assertEqual(len(self.ops.sends), 1)
        registry.ack(seq)
        self.assertNotIn(seq, [event["seq"] for event in registry.read_events(registry.load()["ack_seq"])])

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
        self.assertIn(question_seq, [e["seq"] for e in registry.read_events(registry.load()["ack_seq"])])
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
            self.assertEqual(herdr_coord.main(["ack", "3"]), 0)
            self.assertEqual(registry.load()["ack_seq"], 3)
            self.assertEqual(herdr_coord.main(["ack", "-1"]), 1)
            self.assertEqual(herdr_coord.main(["go"]), 0)
            with mock.patch.object(actions, "relay", return_value={"status": "delivered"}) as relay:
                self.assertEqual(herdr_coord.main(["relay", "worker", "exact words", "--token", "q1", "--action-id", "r1"]), 0)
                relay.assert_called_once_with("worker", "exact words", state_token="q1", action_id="r1")

    def test_cli_relay_requires_token(self):
        with mock.patch.object(actions, "relay", return_value={"status": "delivered"}) as relay, mock.patch("sys.stderr", new_callable=io.StringIO) as error:
            with self.assertRaises(SystemExit) as refused:
                herdr_coord.main(["relay", "worker", "answer"])
        self.assertEqual(refused.exception.code, 2)
        self.assertIn("--token", error.getvalue())
        relay.assert_not_called()


if __name__ == "__main__":
    unittest.main()
