import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts"))

import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import actions
import finish
import herdr_coord
import registry
import start
import transcript
import watch
import test_actions as fixtures
from test_actions import FakeOps, FIXTURES, PROMPT, END, TOOL, RESULT, ASK, ANSWER, QUOTA
from test_start import FakeOps as StartOps
from test_finish import FakeOps as FinishOps, failure, pr, success
from test_transcript import background_pair, background_notification


class WatchTests(unittest.TestCase):
    setUp = fixtures.ActionTests.setUp
    add_worker = fixtures.ActionTests.add_worker
    set_state = fixtures.ActionTests.set_state

    def quota(self, reset):
        record = copy.deepcopy(QUOTA)
        record["quotaLimits"]["resetsAt"] = reset
        return record

    def queue(self, issue=2):
        worker = dict(self.worker, worker_id=f"queued-{issue}", issue=issue, state="queued",
                      agent_name=None, session_id=None, phase=None)
        registry.update(lambda doc: doc["queue"].append(worker))
        return worker

    def finish_start(self, worker, ops):
        return actions.change_worker(worker["worker_id"], "running")

    def seed_records(self, records, *, grown=False):
        self.ops.write("session-1", records)
        if not grown:
            registry.update(lambda doc: doc["workers"]["worker"].update(
                transcript_offset=self.ops.path("session-1").stat().st_size, last_growth_at=0))

    def test_nudge_accepts_pre_amendment_agent_name(self):
        name = "issue-1-1a2b3c4d5e"
        self.set_state("running", agent_name=name)
        self.ops.sessions[name] = "session-1"
        self.ops.statuses[name] = "idle"
        self.seed_records([PROMPT])
        action = actions.nudge(name, ops=self.ops)
        self.assertEqual(action["worker_id"], "worker")
        self.assertEqual(action["status"], "delivered")
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(self.ops.sends[0][2], name)

    def test_relay_accepts_pre_amendment_agent_name(self):
        name = "issue-1-1a2b3c4d5e"
        self.set_state("question", agent_name=name, state_token="legacy-question")
        self.ops.sessions[name] = "session-1"
        self.ops.statuses[name] = "blocked"
        self.seed_records([PROMPT])
        action = actions.relay(name, "A", state_token="legacy-question", ops=self.ops)
        self.assertEqual(action["worker_id"], "worker")
        self.assertEqual(action["status"], "delivered")
        self.assertEqual(self.ops.sends, [("agent", "send-keys", name, "3"),
                                         ("pane", "send-text", "pane-1", "A"),
                                         ("agent", "send-keys", name, "enter")])

    def test_worker_problem_notifications_name_registered_repository(self):
        worker = actions.worker_named("worker")
        for kind, title in (("delivery_unknown", "Worker delivery unknown"),
                            ("technical_problem", "Coordinator technical problem")):
            with self.subTest(kind=kind):
                watch._report_problem(worker, kind, kind=kind)
                watch._notify_events(self.ops)
                self.assertEqual(self.ops.notifications[-1][2],
                                 f"{Path(worker['repo_path']).name} #{worker['issue']}: {title}")

    def test_worker_state_notifications_name_payload_repository(self):
        for state in ("question", "start_failed", "start_interrupted", "ended_without_proof",
                      "done", "lost", "stalled", "awaiting_checks"):
            with self.subTest(state=state):
                event = {"kind": "checks_overdue" if state == "awaiting_checks" else "worker_state",
                         "payload": {"repo_path": str(Path(self.temp.name) / "taste-swipe"),
                                     "issue": 21, "state": state}}
                title, _ = watch._notification(event)
                self.assertEqual(title, f"taste-swipe #21: {state}")

    def test_watcher_level_notifications_name_resolved_repository(self):
        repo = str(Path(self.temp.name) / "boon-town")
        events = [
            {"kind": "watcher_lost", "payload": {}},
            {"kind": "herdr_lost", "payload": {"workers": ["boon-town-7-abc"]}},
        ]
        with mock.patch.dict(os.environ, {"HERDR_COORD_REPO": repo}):
            titles = [watch._notification(event)[0] for event in events]
        self.assertEqual(titles, ["boon-town: Coordinator watcher lost",
                                  "boon-town: herdr recovered; workers held"])
        with mock.patch.dict(os.environ):
            os.environ.pop("HERDR_COORD_REPO", None)
            self.assertEqual(watch._notification(events[0])[0], "Coordinator watcher lost")
            title, _ = watch._notification({"kind": "worker_state",
                                            "payload": {"issue": 21, "state": "question"}})
        self.assertEqual(title, "Issue #21: question")

    def test_blocked_producer_fixture_reports_question(self):
        payload = json.loads((FIXTURES / "herdr-agent-get-blocked-question.json").read_bytes())
        payload["result"]["agent"]["agent_session"]["value"] = "session-1"
        self.seed_records([PROMPT, TOOL, RESULT])
        original = self.ops.herdr

        def producer(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                return success(payload)
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=producer):
            events = watch.poll_once(ops=self.ops, now=100)
        questions = [event for event in events
                     if event["kind"] == "worker_state" and event["payload"]["state"] == "question"]
        self.assertEqual(len(questions), 1)
        self.assertIn("Probe question", questions[0]["payload"]["question_text"])
        self.assertEqual(self.ops.notifications[0][2],
                         f"{Path(self.worker['repo_path']).name} #{self.worker['issue']}: question")
        self.assertIn("Probe question", self.ops.notifications[0][4])
        self.assertFalse(self.ops.sends)

    def test_question_event_contains_plain_visible_stdout_fixture(self):
        self.ops.visible = (FIXTURES / "herdr-agent-read-visible.txt").read_text(encoding="utf-8")
        self.ops.statuses["worker"] = "blocked"
        self.seed_records([PROMPT, TOOL, RESULT])
        events = watch.poll_once(ops=self.ops, now=100)
        questions = [event for event in events
                     if event["kind"] == "worker_state" and event["payload"]["state"] == "question"]
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["payload"]["question_text"], self.ops.visible.rstrip())
        self.assertNotIn("Question text unavailable", questions[0]["payload"]["question_text"])
        self.assertEqual(self.ops.notifications[0][4], self.ops.visible.rstrip())
        self.assertFalse(self.ops.sends)

    def test_question_text_leads_with_the_open_form_not_earlier_pane_output(self):
        # Live use: the pane began with the coordinator's own earlier message, so the
        # form at the bottom read as an echo and the worker waited 80 minutes on an unseen question.
        ask = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        form = ask["message"]["content"][0]["input"]["questions"][0]
        self.ops.visible = "› Message from @coordinator: hold the filing\n\n" + form["question"]
        self.seed_records([PROMPT, ask])
        events = watch.poll_once(ops=self.ops, now=100)
        questions = [event for event in events
                     if event["kind"] == "worker_state" and event["payload"]["state"] == "question"]
        self.assertEqual(len(questions), 1)
        text = questions[0]["payload"]["question_text"]
        first_lines = text.split("\n\n")[0]
        self.assertTrue(text.startswith("Form (from the worker's transcript):"))
        self.assertIn(f"[{form['header']}] {form['question']}", first_lines)
        for number, option in enumerate(form["options"], 1):
            self.assertIn(f"  {number}. {option['label']}: {option['description']}", first_lines)
        self.assertNotIn("Message from @coordinator", first_lines)
        # The screen still follows, for anything the transcript does not carry.
        self.assertTrue(text.endswith(self.ops.visible))
        self.assertFalse(self.ops.sends)
        # An answered form no longer leads: only the screen is shown.
        answered = {"type": "user", "isSidechain": False, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": ask["message"]["content"][0]["id"], "content": "answered"}]}}
        self.assertEqual(actions.question_text(self.worker, self.ops, [PROMPT, ask, answered]), self.ops.visible)
        # A malformed form falls back to the screen instead of failing.
        broken = copy.deepcopy(ask)
        broken["message"]["content"][0]["input"]["questions"] = 1
        self.assertEqual(actions.question_text(self.worker, self.ops, [PROMPT, broken]), self.ops.visible)

    def test_legacy_status_only_reports_question(self):
        original = self.ops.herdr

        def legacy(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                return success({"result": {"agent": {"status": "blocked"}}})
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=legacy):
            events = watch.poll_once(ops=self.ops, now=100)
        self.assertEqual([event["payload"]["state"] for event in events
                          if event["kind"] == "worker_state"], ["question"])
        self.assertFalse(self.ops.sends)

    def test_done_without_closing_record_reports_missing_final_message(self):
        self.ops.statuses["worker"] = "done"
        for earlier_message in ("", "Stale message from the previous turn"):
            with self.subTest(earlier_message=earlier_message):
                self.set_state("running")
                self.seed_records([PROMPT, END, PROMPT, TOOL, RESULT])
                self.ops.verdict["final_message"] = earlier_message
                self.ops.notifications.clear()
                before = len(self.ops.verify_calls)
                self.assertEqual(watch.poll_once(ops=self.ops, now=119), [])
                self.assertEqual(len(self.ops.verify_calls), before)
                events = watch.poll_once(ops=self.ops, now=120)
                ended = [event["payload"] for event in events if event["kind"] == "worker_state"]
                self.assertEqual(len(ended), 1)
                self.assertEqual(ended[0]["state"], "ended_without_proof")
                self.assertIsNone(ended[0]["pr"])
                message = "Final message is missing from the transcript; read it in the worker's pane."
                self.assertEqual(ended[0]["final_message"], message)
                self.assertEqual(registry.load()["workers"]["worker"]["final_message"], message)
                self.assertIn(message, self.ops.notifications[0][4])
                self.assertEqual(watch.poll_once(ops=self.ops, now=121), [])
                self.assertEqual(len(self.ops.notifications), 1)
                self.assertFalse(self.ops.sends)

    def test_done_with_closing_record_keeps_final_message(self):
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, END])
        watch.poll_once(ops=self.ops, now=120)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertEqual(worker["final_message"], self.ops.verdict["final_message"])

    def test_background_wait_keeps_slot_without_sends_notifications_or_verification(self):
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash"), END])
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.queue()
        with mock.patch.object(start, "start_next_queued", return_value=None) as starter:
            events = watch.poll_once(ops=self.ops, now=100)
            self.assertEqual([event["payload"]["state"] for event in events
                              if event["kind"] == "worker_state"], ["waiting_background"])
            for now in (1200, 3599):
                watch._TRANSCRIPTS.clear()  # A restart must preserve the open launch and growth age.
                self.assertEqual(watch.poll_once(ops=self.ops, now=now), [])
            starter.assert_not_called()
        doc = registry.load()
        self.assertEqual(doc["workers"]["worker"]["state"], "waiting_background")
        self.assertEqual(start._slots(doc), 1)
        self.assertEqual(len(doc["queue"]), 1)
        self.assertEqual(doc["actions"], {})
        self.assertFalse(self.ops.verify_calls)
        self.assertFalse(self.ops.notifications)
        self.assertFalse(self.ops.sends)
        self.assertFalse(any(event["payload"].get("state") == "ended_without_proof"
                             for event in registry.read_events(0)))

    def test_background_notification_and_assistant_activity_resume_normal_polling(self):
        launch, result = background_pair("Agent")
        tool_id = launch["message"]["content"][0]["id"]
        self.seed_records([PROMPT, launch, result, END])
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        self.ops.write("session-1", [background_notification(tool_id)], append=True)
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(actions.worker_named("worker")["state"], "running")
        self.ops.write("session-1", [TOOL], append=True)
        watch.poll_once(ops=self.ops, now=102)
        self.assertEqual(actions.worker_named("worker")["state"], "in_tool")
        self.assertFalse(self.ops.verify_calls)
        self.assertFalse(self.ops.notifications)
        self.ops.write("session-1", [RESULT, END], append=True)
        watch.poll_once(ops=self.ops, now=103)
        self.assertEqual(actions.worker_named("worker")["state"], "ended_without_proof")
        self.assertEqual(len(self.ops.verify_calls), 1)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)

    def test_background_wait_without_closing_record_and_timeout(self):
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash")])
        watch.poll_once(ops=self.ops, now=120)
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        self.assertEqual(watch.poll_once(ops=self.ops, now=3599), [])
        self.assertFalse(self.ops.verify_calls)
        events = watch.poll_once(ops=self.ops, now=3600)
        ended = [event["payload"] for event in events if event["kind"] == "worker_state"]
        self.assertEqual([worker["state"] for worker in ended], ["ended_without_proof"])
        self.assertTrue(ended[0]["no_closing_record"])
        self.assertEqual(len(self.ops.verify_calls), 1)
        self.assertEqual(watch.poll_once(ops=self.ops, now=3601), [])
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)

    def test_background_wait_survives_herdr_showing_the_pane_idle(self):
        # Live 2026-10-14 (taste-swipe #39): herdr flipped the viewed pane from done to idle, the
        # wait read as a stall, and the refused nudge was reported as delivery_unknown.
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash")])
        watch.poll_once(ops=self.ops, now=120)
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        self.ops.statuses["worker"] = "idle"
        for now in (200, 1500, 3599):  # idle reads as running before the stall age, stalled after it
            self.assertEqual(watch.poll_once(ops=self.ops, now=now), [])
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        self.assertFalse(self.ops.verify_calls)
        events = watch.poll_once(ops=self.ops, now=3600)
        ended = [event["payload"] for event in events if event["kind"] == "worker_state"]
        self.assertEqual([worker["state"] for worker in ended], ["ended_without_proof"])
        self.assertTrue(ended[0]["no_closing_record"])
        self.assertEqual(len(self.ops.verify_calls), 1)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])
        self.assertFalse([event for event in registry.read_events(0)
                          if event["kind"] in {"delivery_unknown", "send_refused"}])

    def test_refused_automatic_send_is_reported_as_nothing_sent(self):
        self.ops.statuses["worker"] = "idle"
        self.seed_records([PROMPT])
        with mock.patch.object(actions, "nudge", side_effect=actions.ActionError("Cannot nudge a done worker")):
            events = watch.poll_once(ops=self.ops, now=5000)
        kinds = [event["kind"] for event in events]
        self.assertIn("send_refused", kinds)
        self.assertNotIn("delivery_unknown", kinds)
        self.assertFalse(self.ops.sends)
        self.assertIn("send refused", self.ops.notifications[-1][2])
        registry.update(lambda doc: doc["holds"].update(watcher_lost={"ts": 0}))
        watch._report_problem(actions.worker_named("worker"), "another refusal", kind="send_refused")
        self.assertEqual(registry.read_events(events[-1]["seq"]), [])

    def test_question_text_is_absent_from_later_ended_without_proof_event(self):
        self.set_state("question", question_text="Question text unavailable")
        self.seed_records([PROMPT, END])
        events = watch.poll_once(ops=self.ops, now=100)
        ended = [event["payload"] for event in events
                 if event["kind"] == "worker_state" and event["payload"]["state"] == "ended_without_proof"]
        self.assertEqual(len(ended), 1)
        self.assertNotIn("question_text", ended[0])
        self.assertNotIn("question_text", actions.worker_named("worker"))

    def test_state_changes_clear_question_text_and_preserve_current_question(self):
        question = actions.change_worker("worker", "question", question_text="Pick A?")
        self.assertEqual(question["question_text"], "Pick A?")
        for state in ("running", "in_tool", "waiting_background", "quota_wait", "lost"):
            with self.subTest(state=state):
                self.set_state("question", question_text="Pick A?")
                changed = actions.change_worker("worker", state, expected="question")
                self.assertNotIn("question_text", changed)
                self.assertNotIn("question_text", registry.read_events(0)[-1]["payload"])

    def test_herdr_loss_clears_question_text(self):
        self.set_state("question", question_text="Pick A?")
        watch._herdr_lost(100)
        self.assertEqual(actions.worker_named("worker")["state"], "lost")
        self.assertNotIn("question_text", actions.worker_named("worker"))
        self.assertNotIn("question_text", registry.read_events(0)[-1]["payload"])

    def test_no_closing_record_cannot_finish_from_previous_turn_artifact(self):
        artifact = Path(self.temp.name) / "previous.md"
        artifact.write_text("Old requirements", encoding="utf-8")
        earlier = copy.deepcopy(END)
        earlier["message"]["content"] = f"Requirements are in `{artifact.name}`."
        sidechain = copy.deepcopy(earlier)
        sidechain["isSidechain"] = True
        self.set_state("running", entry_command="ce-brainstorm")
        self.ops.statuses["worker"] = "done"
        self.ops.verify_done = None  # Use the real finish verifier.
        self.seed_records([PROMPT, earlier, PROMPT, TOOL, RESULT, sidechain])
        self.assertEqual(finish.verify_done(self.worker | {"entry_command": "ce-brainstorm"},
                                           ops=self.ops, config={}, now=120,
                                           records=[PROMPT, earlier])["state"], "done")
        events = watch.poll_once(ops=self.ops, now=120)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertTrue(worker["no_closing_record"])
        note = "Final message is missing from the transcript; read it in the worker's pane."
        self.assertEqual(worker["final_message"], note)
        self.assertEqual([event["payload"]["state"] for event in events
                          if event["kind"] == "worker_state"], ["ended_without_proof"])
        self.assertIn(note, self.ops.notifications[-1][4])
        self.assertFalse(self.ops.verify_calls)

    def test_no_closing_record_preserves_note_after_awaiting_checks(self):
        self.ops.statuses["worker"] = "done"
        self.ops.verify_done = None
        gh = FinishOps()
        gh.checks = success([{"name": "tests", "bucket": "pending"}])
        self.ops.gh = gh.gh
        self.seed_records([PROMPT, END, PROMPT, TOOL, RESULT])
        watch.poll_once(ops=self.ops, now=120)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "awaiting_checks")
        self.assertTrue(worker["no_closing_record"])
        self.assertFalse(self.ops.notifications)
        # Rehydrate state after a watcher restart, then use real PR/check proof.
        watch._TRANSCRIPTS.clear()
        gh.checks = success([{"name": "tests", "bucket": "fail"}])
        watch.poll_once(ops=self.ops, now=121)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertIn("checks failed", worker["detail"])
        note = "Final message is missing from the transcript; read it in the worker's pane."
        self.assertEqual(worker["final_message"], note)
        self.assertIn(note, self.ops.notifications[-1][4])
        self.assertFalse(self.ops.verify_calls)

    def test_no_closing_record_keeps_pr_proof_and_new_turn_clears_flag(self):
        self.ops.statuses["worker"] = "done"
        self.ops.verify_done = None
        gh = FinishOps()
        self.ops.gh = gh.gh
        self.seed_records([PROMPT, END, PROMPT])
        watch.poll_once(ops=self.ops, now=120)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "done")
        self.assertTrue(worker["no_closing_record"])
        self.assertEqual(worker["pr"], 42)
        self.set_state("running")
        gh.prs = success([])
        self.seed_records([PROMPT, END, PROMPT, END])
        watch.poll_once(ops=self.ops, now=121)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertFalse(worker["no_closing_record"])
        self.assertEqual(worker["final_message"], finish._last_assistant_text([END]))

    def seed_unknown_nudge(self):
        action = {"id": "unknown-nudge", "worker_id": "worker", "kind": "nudge",
                  "text": actions.NUDGE_TEXT, "session_id": "session-1",
                  "transcript_position": len(actions.records_for(self.worker, self.ops)),
                  "transport": "prompt", "status": "delivery_unknown", "reason": "Send timed out"}
        registry.update(lambda doc: (doc["actions"].update({action["id"]: action}),
                                    doc["workers"]["worker"].update(pending_action_id=action["id"])))
        return action

    def seed_unknown_entry(self):
        command = copy.deepcopy(PROMPT)
        command["message"]["content"] = "<command-name>/compound-engineering:ce-work</command-name>\n<command-args>#1</command-args>"
        mode = copy.deepcopy(StartOps(Path(self.temp.name) / "entry-projects").mode_record)
        mode["permissionMode"] = "auto"
        self.seed_records([mode, command])
        action = {"id": "late-entry", "worker_id": "worker", "kind": "entry",
                  "status": "delivery_unknown", "transcript_position": 0,
                  "command_name": "compound-engineering:ce-work", "command_args": "#1"}
        registry.update(lambda doc: (doc["actions"].update({action["id"]: action}),
                                    doc["workers"]["worker"].update(action_id=action["id"],
                                        phase="command_sent", permission_mode="auto")))
        return action

    def test_live_other_start_owner_poll_is_noop(self):
        with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL) as child:
            try:
                owner = start._process_identity(child.pid)
                self.assertIsNotNone(owner)
                self.set_state("starting", start_owner=owner, phase="agent_started")
                before, events = registry.load(), registry.read_events(0)
                with mock.patch.object(self.ops, "herdr", wraps=self.ops.herdr) as herdr, mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as runner:
                    self.assertEqual(watch.poll_once(ops=self.ops, now=100), [])
                    runner.assert_not_called()
                    herdr.assert_not_called()
                self.assertEqual(registry.load(), before)
                self.assertEqual(registry.read_events(0), events)
            finally:
                child.communicate(timeout=10)

    def test_dead_start_owner_is_interrupted_once(self):
        with subprocess.Popen([sys.executable, "-c", "pass"], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL) as child:
            child.wait(timeout=10)
            self.set_state("starting", start_owner={"pid": child.pid, "created": 1})
            with mock.patch.object(self.ops, "herdr", wraps=self.ops.herdr) as herdr, mock.patch.object(start, "_run_worker") as runner:
                events = watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["payload"]["state"], "start_interrupted")
                self.assertIn("start owner", events[0]["payload"]["reason"])
                before = registry.load()
                self.assertEqual(watch.poll_once(ops=self.ops, now=101), [])
                self.assertEqual(registry.load(), before)
                runner.assert_not_called()
                self.assertEqual([call.args[:2] for call in herdr.call_args_list], [("notification", "show")])
                self.assertEqual(len(self.ops.notifications), 1)
                self.assertIn("restart worker", self.ops.notifications[0][4])

    def test_reused_pid_and_missing_owner_are_interrupted(self):
        owner = start._start_owner()
        for recorded in (dict(owner, created=owner["created"] + 1), None):
            with self.subTest(owner=recorded):
                self.set_state("starting", start_owner=recorded)
                with mock.patch.object(start, "_run_worker") as runner:
                    events = watch.poll_once(ops=self.ops, now=100)
                    self.assertEqual(len(events), 1)
                    self.assertEqual(events[0]["payload"]["state"], "start_interrupted")
                    runner.assert_not_called()

    def test_stale_dead_owner_poll_cannot_interrupt_a_new_claim(self):
        stale = {"pid": 123, "created": 456}
        self.set_state("starting", start_owner=stale)
        probe = start._process_identity

        def change_owner(pid):
            if pid == stale["pid"]:
                registry.update(lambda doc: doc["workers"]["worker"].update(start_owner=start._start_owner()))
                return None
            return probe(pid)

        with mock.patch.object(start, "_process_identity", side_effect=change_owner):
            self.assertEqual(watch.poll_once(ops=self.ops, now=100), [])
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "starting")

    def test_inaccessible_owner_is_not_assumed_dead(self):
        self.set_state("starting", start_owner={"pid": 123, "created": 456})
        before = registry.load()
        probe = start._process_identity

        def inaccessible(pid):
            if pid == 123:
                raise PermissionError("process access denied")
            return probe(pid)

        with mock.patch.object(start, "_process_identity", side_effect=inaccessible), mock.patch.object(self.ops, "herdr", wraps=self.ops.herdr) as herdr:
            self.assertEqual(watch.poll_once(ops=self.ops, now=100), [])
            herdr.assert_not_called()
        self.assertEqual(registry.load(), before)

    def test_watcher_queue_drain_owns_and_completes_all_start_phases(self):
        repo = Path(self.temp.name) / "queued-repo"
        repo.mkdir()
        ops = StartOps(Path(self.temp.name) / "queued-projects")
        ops.issue(2)
        registry.update(lambda doc: (doc["workers"].clear(), doc["config"].update(cap=0)))
        start.start_issues(repo, [2], ops=ops)
        registry.update(lambda doc: doc["config"].update(cap=1))
        record = start._record

        def owned_record(worker_id, kind, **changes):
            self.assertEqual(registry.load()["workers"][worker_id]["start_owner"], start._start_owner())
            return record(worker_id, kind, **changes)

        keepalive = mock.Mock()
        with mock.patch.object(ops, "herdr_reachable", return_value=True, create=True), mock.patch.object(start, "PROJECTS_ROOT", ops.projects), mock.patch.object(start, "_record", side_effect=owned_record):
            events = watch.poll_once(ops=ops, now=100, keepalive=keepalive)
        worker = next(iter(registry.load()["workers"].values()))
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["start_owner"], start._start_owner())
        self.assertEqual([event["payload"]["phase"] for event in events if event["kind"] == "worker_phase"], list(start.PHASES))
        self.assertEqual(len(ops.worktrees), 1)
        self.assertEqual(len(ops.agents), 1)
        self.assertEqual(len(ops.prompts), 1)
        self.assertEqual(registry.load()["queue"], [])
        self.assertGreaterEqual(keepalive.call_count, 11)

    def test_decision_table(self):
        # One case per authoritative row. U4 owns start phases; U6 owns cleanup.
        rows = [
            ("queued: slot free", "queued", "queue", "running"),
            ("starting: phase done", "starting", "start", "running"),
            ("starting: herdr lost", "starting", "down-no-session", "start_interrupted"),
            ("start interrupted: go then restart", "start_interrupted", "go-start", "running"),
            ("running / in tool: unchanged", "in_tool", "tool", "in_tool"),
            # running | turn ended with open background work | mark waiting_background | none | no | yes
            ("running: turn ended with open background work", "running", "background", "waiting_background"),
            ("running: stall", "running", "stall", "running"),
            ("running: 429", "running", "quota-future", "quota_wait"),
            ("quota wait: reset passed", "quota_wait", "quota-past", "running"),
            ("running: pending question", "running", "question", "question"),
            ("question: pane answer", "question", "answer", "running"),
            ("question: relay with current token", "question", "relay-question", "running"),
            ("question: relay with stale token", "question", "relay-stale", "question"),
            ("running: end turn checks pending", "running", "checks", "awaiting_checks"),
            ("awaiting checks: pass", "awaiting_checks", "done", "done"),
            ("awaiting checks: fail", "awaiting_checks", "fail", "ended_without_proof"),
            ("running: end turn no proof", "running", "end", "ended_without_proof"),
            ("ended without proof: relay", "ended_without_proof", "relay", "running"),
            ("any with session: herdr lost", "running", "down", "lost"),
            ("lost: go then resume", "lost", "resume", "running"),
            ("any: watcher lost", "running", "watcher-loss", "running"),
            ("any: watcher hung", "running", "watcher-hang", "running"),
            ("done: merged and exited (U6 cleanup)", "done", "cleanup", "done"),
            ("running: one probe failure", "running", "probe-once", "running"),
            ("running: three probe failures", "running", "probe-three", "lost"),
            ("running: agent absent", "running", "absent", "lost"),
            ("running: transient herdr failure", "running", "down-once", "running"),
            ("done: herdr lost", "done", "down", "done"),
            ("awaiting merge: herdr lost", "awaiting_merge", "down", "awaiting_merge"),
            ("cleaned: herdr lost", "cleaned", "down", "cleaned"),
            ("start failed: herdr lost", "start_failed", "down", "start_failed"),
            ("start failed: late entry", "start_failed", "entry-late", "running"),
        ]
        for index, (label, state, event, expected) in enumerate(rows):
            with self.subTest(row=label), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(Path(self.temp.name) / f"row-{index}")}):
                self.ops = FakeOps(Path(self.temp.name) / f"projects-{index}")
                self.worker = self.add_worker(state=state)
                self.seed_records([PROMPT])
                if event == "queue":
                    registry.update(lambda doc: (doc["workers"].clear(), doc["queue"].append(dict(self.worker))))
                if event in {"down", "down-no-session", "down-once"}:
                    self.ops.reachable = False
                    if event == "down-no-session":
                        self.set_state("starting", session_id=None)
                if event == "go-start":
                    registry.update(lambda doc: doc["holds"].update(watcher_lost={"ts": 0}))
                    actions.go(ops=self.ops)
                if event == "start":
                    self.set_state("starting", start_owner=start._start_owner())
                if event == "tool":
                    self.seed_records([PROMPT, TOOL])
                if event == "background":
                    self.seed_records([PROMPT, *background_pair("Bash"), END])
                if event == "question":
                    self.ops.statuses["worker"] = "blocked"
                if event == "answer":
                    self.seed_records([PROMPT, ASK, ANSWER])
                if event == "entry-late":
                    self.seed_unknown_entry()
                if event.startswith("quota-"):
                    self.seed_records([PROMPT, self.quota(3000 if event == "quota-future" else 100)])
                if event in {"checks", "done", "fail", "end"}:
                    self.seed_records([PROMPT, END])
                    self.ops.verdict["state"] = {"checks": "awaiting_checks", "done": "done"}.get(event, "ended_without_proof")
                    self.ops.verdict["pr"] = 10 if event != "end" else None
                if event == "resume":
                    registry.update(lambda doc: doc["holds"].update(herdr_lost={"ts": 0}))
                    actions.go(ops=self.ops)
                    actions.resume("worker", ops=self.ops)
                elif event in {"relay", "relay-question"}:
                    if event == "relay-question":
                        self.ops.statuses["worker"] = "blocked"
                    actions.relay("worker", "Please choose A", state_token=self.worker["state_token"], ops=self.ops)
                elif event == "relay-stale":
                    with self.assertRaisesRegex(actions.ActionError, "Stale relay replay"):
                        actions.relay("worker", "Please choose A", state_token="old-question", ops=self.ops)
                elif event == "watcher-loss":
                    watch._watcher_lost(2000)
                elif event == "watcher-hang":
                    watch.heartbeat(now=100, poll=15)
                    with watch.watcher_lock(), mock.patch.object(watch.time, "time", return_value=761), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO):
                        watch.follow()
                    self.assertEqual(sum(e["kind"] == "watcher_hung" for e in registry.read_events(0)), 1)
                    self.assertEqual(registry.load()["holds"], {})
                else:
                    original = self.ops.herdr

                    def probe(*args, **kwargs):
                        if args[:2] == ("agent", "get"):
                            if event in {"absent", "cleanup"}:
                                return failure("No agent occupies the pane", "no_agent_in_pane")
                            if event in {"probe-once", "probe-three"}:
                                raise TimeoutError("agent lookup timeout")
                        return original(*args, **kwargs)

                    with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter, mock.patch.object(self.ops, "herdr", side_effect=probe):
                        if event == "go-start":
                            watch.poll_once(ops=self.ops, now=999)
                            starter.assert_not_called()
                            self.assertEqual(registry.load()["workers"]["worker"]["state"], "start_interrupted")
                            start.restart(self.worker["agent_name"], ops=self.ops)
                        for poll in range(3 if event in {"down", "down-no-session", "probe-three"} else 1):
                            watch.poll_once(ops=self.ops, now=(2000 if event == "stall" else 1000) + poll)
                        self.assertEqual(starter.call_count, int(event in {"queue", "start", "go-start"}))
                self.assertEqual(registry.load()["workers"]["worker"]["state"], expected)
                self.assertEqual(bool(self.ops.sends), event in {"stall", "quota-past", "relay", "relay-question", "resume"})
                self.assertEqual(bool(self.ops.notifications), event in {"question", "done", "fail", "end", "probe-once", "probe-three", "absent"})
                if event == "background":
                    self.assertEqual(start._slots(registry.load()), 1)
                    self.assertFalse(self.ops.verify_calls)
                if event == "watcher-loss":
                    self.assertIn("watcher_lost", registry.load()["holds"])
                if event == "cleanup":
                    self.assertFalse(self.ops.verify_calls)
                    cleanup_ops = FinishOps()
                    cleanup_ops.prs = success([pr(state="MERGED")])
                    self.assertTrue(herdr_coord._cleanup(ops=cleanup_ops)["results"][0]["cleaned"])
                    self.assertEqual(registry.load()["workers"]["worker"]["state"], "cleaned")

    def test_terminal_workers_do_not_probe_exited_agents(self):
        for state in watch.TERMINAL_STATES - watch.REOPENABLE_STATES:
            with self.subTest(state=state):
                self.set_state(state)
                with mock.patch.object(self.ops, "herdr", side_effect=AssertionError("terminal presence probe")):
                    for now in (100, 101, 102):
                        watch.poll_once(ops=self.ops, now=now)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)

    def test_settled_workers_probe_rarely_and_never_turn_lost(self):
        for state in watch.REOPENABLE_STATES:
            with self.subTest(state=state):
                self.set_state(state)
                watch._SETTLED_PROBES.clear()
                with mock.patch.object(self.ops, "herdr", side_effect=TimeoutError("agent exited")) as herdr:
                    for now in (100, 115, 130, 145, 160):
                        watch.poll_once(ops=self.ops, now=now)
                self.assertEqual(herdr.call_count, 2)  # at 100 and 160
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)
                self.assertFalse(registry.load()["workers"]["worker"].get("agent_get_failures"))

    def test_agent_probe_failures_reset_on_success_and_absence_is_immediate(self):
        original = self.ops.herdr

        def timeout(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                raise TimeoutError("agent lookup timed out")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=timeout):
            events = watch.poll_once(ops=self.ops, now=100)
            self.assertEqual([e["kind"] for e in events], ["technical_problem"])
            self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
            watch.poll_once(ops=self.ops, now=101)
        watch.poll_once(ops=self.ops, now=102)
        self.assertNotIn("agent_get_failures", registry.load()["workers"]["worker"])
        with mock.patch.object(self.ops, "herdr", side_effect=timeout):
            for now in (103, 104):
                watch.poll_once(ops=self.ops, now=now)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
            watch.poll_once(ops=self.ops, now=105)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "lost")

    def test_failed_probe_cannot_overwrite_a_new_terminal_state(self):
        def completed(*args, **kwargs):
            self.set_state("done")
            return failure("No agent occupies the pane", "no_agent_in_pane")

        with mock.patch.object(self.ops, "herdr", side_effect=completed):
            self.assertEqual(watch.poll_once(ops=self.ops, now=100), [])
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "done")

    def test_pending_resume_absence_is_debounced_until_delivery(self):
        action = self.seed_unknown_nudge()
        registry.update(lambda doc: doc["actions"][action["id"]].update(kind="resume", text=actions.RESUME_TEXT))
        self.set_state("starting")
        original = self.ops.herdr

        def absent(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                return failure("No agent occupies the pane", "no_agent_in_pane")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=absent):
            watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "starting")
        delivered = copy.deepcopy(PROMPT)
        delivered["message"]["content"] = actions.RESUME_TEXT
        self.ops.write("session-1", [delivered], append=True)
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.assertNotIn("agent_get_failures", registry.load()["workers"]["worker"])
        self.assertFalse(self.ops.sends)

    def test_unreachable_probe_requires_three_consecutive_polls(self):
        self.ops.reachable = False
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["holds"], {})
        self.ops.reachable = True
        watch.poll_once(ops=self.ops, now=101)
        self.ops.reachable = False
        for now in (102, 103):
            watch.poll_once(ops=self.ops, now=now)
            self.assertEqual(registry.load()["holds"], {})
        watch.poll_once(ops=self.ops, now=104)
        self.assertIn("herdr_lost", registry.load()["holds"])

    def test_late_entry_delivery_restores_observation_without_resend(self):
        self.set_state("start_failed", session_id=None)
        action = self.seed_unknown_entry()
        watch.poll_once(ops=self.ops, now=100)
        doc = registry.load()
        self.assertEqual(doc["actions"][action["id"]]["status"], "delivered")
        self.assertEqual(doc["workers"]["worker"]["state"], "running")
        self.assertEqual(start._slots(doc), 1)
        self.ops.statuses["worker"] = "blocked"
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "question")
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)

    def test_failed_pasted_entry_recovers_and_notifies_pending_question(self):
        prefix = "Redesign the chandelier taste profile page "
        args = prefix + "a" * (1300 - len(prefix))
        self.set_state("start_failed", issue=21, entry_command="ce-brainstorm", entry_args=args,
                       reason="entry delivery unknown: command was not confirmed in the transcript")
        action = self.seed_unknown_entry()
        command = copy.deepcopy(PROMPT)
        command["message"]["content"] = f'\n\n<pasted_content id="x">\n/ce-brainstorm {args}\n</pasted_content>'
        mode = StartOps(Path(self.temp.name) / "entry-projects").mode_record
        self.seed_records([mode, command])
        registry.update(lambda doc: doc["actions"][action["id"]].update(
            command_name="compound-engineering:ce-brainstorm", command_args=args))

        events = watch.poll_once(ops=self.ops, now=100)
        doc = registry.load()
        self.assertEqual(doc["actions"][action["id"]]["status"], "delivered")
        self.assertEqual(doc["actions"][action["id"]]["command_args"], args)
        self.assertEqual(doc["workers"]["worker"]["state"], "running")
        self.assertEqual(doc["workers"]["worker"]["phase"], "mode_checked")
        self.assertIsNone(doc["workers"]["worker"]["reason"])
        self.assertEqual([e["payload"]["state"] for e in events if e["kind"] == "worker_state"], ["running"])
        self.assertFalse(self.ops.notifications)

        self.ops.statuses["worker"] = "blocked"
        events = watch.poll_once(ops=self.ops, now=101)
        self.assertEqual([e["payload"]["state"] for e in events if e["kind"] == "worker_state"], ["question"])
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "question")
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertEqual(self.ops.notifications[0][2], f"{Path(self.worker['repo_path']).name} #21: question")
        self.assertIn("Probe question", self.ops.notifications[0][4])
        self.assertEqual(watch.poll_once(ops=self.ops, now=102), [])
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)
        self.assertFalse(self.ops.start_calls)

    def test_late_entry_with_full_cap_is_observed_and_reported(self):
        self.set_state("start_failed")
        self.seed_unknown_entry()
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.add_worker("busy", session="busy-session", issue=2)
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(start._slots(registry.load()), 2)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("no worker slot", self.ops.notifications[0][4])
        self.assertFalse(self.ops.sends)

    def test_late_entry_waits_for_permission_mode_evidence(self):
        self.set_state("start_failed")
        self.seed_unknown_entry()
        records = actions.records_for(self.worker, self.ops)
        self.seed_records(records[1:])
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "start_failed")
        self.assertEqual(registry.load()["actions"]["late-entry"]["status"], "delivered")
        self.ops.write("session-1", [records[0]], append=True)
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.assertFalse(self.ops.sends)

    def test_poll_keepalive_refreshes_between_workers(self):
        self.add_worker("second", session="second-session", issue=2)
        checked = []
        keepalive = mock.Mock()
        original = self.ops.herdr

        def probe(*args, **kwargs):
            if args[:2] == ("agent", "get"):
                checked.append(keepalive.call_count)
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=probe):
            watch.poll_once(ops=self.ops, now=100, keepalive=keepalive)
        self.assertEqual(checked, [1, 2])
        self.assertEqual(keepalive.call_count, 4)

    def test_state_change_one_event_and_unchanged_poll_none(self):
        self.seed_records([PROMPT, TOOL])
        events = watch.poll_once(ops=self.ops, now=100)
        self.assertEqual([e["kind"] for e in events], ["worker_state"])
        self.assertEqual(events[0]["payload"]["state"], "in_tool")
        self.assertEqual(watch.poll_once(ops=self.ops, now=200), [])

    def test_question_notifies_once_and_pane_answer_returns_running(self):
        self.ops.statuses["worker"] = "blocked"
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("Probe question", self.ops.notifications[0][4])
        self.assertEqual(watch.poll_once(ops=self.ops, now=101), [])
        self.ops.write("session-1", [ASK, ANSWER], append=True)
        self.ops.statuses["worker"] = "idle"
        events = watch.poll_once(ops=self.ops, now=102)
        self.assertEqual(events[-1]["payload"]["state"], "running")
        self.assertNotIn("question_text", events[-1]["payload"])
        self.assertNotIn("question_text", actions.worker_named("worker"))
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertFalse(self.ops.sends)

    def test_quota_reset_each_episode_resumes_once(self):
        self.seed_records([PROMPT, self.quota(200)])
        watch.poll_once(ops=self.ops, now=100)
        self.assertFalse(self.ops.sends)
        watch.poll_once(ops=self.ops, now=201)
        watch.poll_once(ops=self.ops, now=202)
        self.assertEqual(len(self.ops.sends), 1)
        self.ops.write("session-1", [self.quota(300)], append=True)
        watch.poll_once(ops=self.ops, now=250)
        self.assertEqual(len(self.ops.sends), 1)
        watch.poll_once(ops=self.ops, now=301)
        watch.poll_once(ops=self.ops, now=302)
        self.assertEqual(len(self.ops.sends), 2)
        ids = [a["id"] for a in registry.load()["actions"].values()]
        self.assertEqual(len(set(ids)), 2)

    def test_coordinator_resume_ends_a_quota_wait_before_its_reset(self):
        # Live: norm-291 waited on a weekly limit days away after the user had usage again.
        self.seed_records([PROMPT, self.quota(10_000)])
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "quota_wait")
        action = actions.resume("worker", ops=self.ops)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertIn(actions.RESUME_TEXT, self.ops.sends[0])
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        # The worker takes the prompt up; the old 429 no longer holds it in quota_wait.
        record = copy.deepcopy(PROMPT)
        record["message"]["content"] = actions.RESUME_TEXT
        self.ops.write("session-1", [record, END], append=True)
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(registry.load()["actions"][action["id"]]["status"], "delivered")
        self.assertNotEqual(registry.load()["workers"]["worker"]["state"], "quota_wait")
        # A fresh limit enters quota_wait again normally.
        self.ops.write("session-1", [self.quota(20_000)], append=True)
        registry.update(lambda doc: doc["workers"]["worker"].update(state="running"))
        watch.poll_once(ops=self.ops, now=102)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "quota_wait")

    def test_quota_timeout_does_not_repeat_after_restart(self):
        self.ops.error = "timeout"
        self.seed_records([PROMPT, self.quota(10)])
        watch.poll_once(ops=self.ops, now=100)
        watch._TRANSCRIPTS.clear()
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(len(self.ops.notifications), 1)

    def test_unknown_nudge_does_not_block_done_verification(self):
        self.seed_records([PROMPT])
        action = self.seed_unknown_nudge()
        self.ops.write("session-1", [END], append=True)
        self.ops.verdict.update(state="done", pr=286, url="https://example.invalid/pr/286")
        events = watch.poll_once(ops=self.ops, now=100)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["state"], "done")
        self.assertEqual(worker["pr"], 286)
        # The worker replied after the nudge, so the nudge is moot and no longer blocks sends.
        self.assertNotIn("pending_action_id", worker)
        self.assertEqual(registry.load()["actions"][action["id"]]["status"], "superseded")
        self.assertEqual([(e["payload"]["state"], e["payload"]["pr"])
                          for e in events if e["kind"] == "worker_state"], [("done", 286)])
        self.assertEqual(len(self.ops.verify_calls), 1)
        self.assertFalse(self.ops.sends)

    def test_unknown_action_blocks_automatic_nudge_and_quota_resume(self):
        for state, records, now in (("stalled", [PROMPT, TOOL, RESULT], 1201),
                                    ("quota_wait", [PROMPT, self.quota(10)], 100)):
            with self.subTest(state=state):
                self.set_state("running")
                self.seed_records(records)
                self.seed_unknown_nudge()
                with mock.patch.object(actions, "nudge") as nudge, mock.patch.object(actions, "resume") as resume:
                    events = watch.poll_once(ops=self.ops, now=now)
                    watch.poll_once(ops=self.ops, now=now + 1)
                    nudge.assert_not_called()
                    resume.assert_not_called()
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)
                self.assertEqual([e["payload"]["state"] for e in events if e["kind"] == "worker_state"], [state])
                self.assertEqual(len(registry.load()["actions"]), 1)
                self.assertFalse(self.ops.sends)

    def test_unknown_action_notifies_once_across_polls_and_restart(self):
        self.seed_records([PROMPT, TOOL])
        self.seed_unknown_nudge()
        for now in (100, 101, 102, 103):
            watch._TRANSCRIPTS.clear()
            watch.poll_once(ops=self.ops, now=now)
        self.ops.write("new-session", [PROMPT, TOOL])
        self.ops.sessions["worker"] = "new-session"
        events = watch.poll_once(ops=self.ops, now=104)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["session_id"], "new-session")
        self.assertEqual(worker["transcript_path"], str(self.ops.path("new-session")))
        self.assertEqual(sum(e["kind"] == "session_changed" for e in events), 1)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertEqual(self.ops.notifications[0][2],
                         f"{Path(self.worker['repo_path']).name} #{self.worker['issue']}: Worker delivery unknown")
        self.assertIn("worker", self.ops.notifications[0][4])
        self.assertIn("nudge", self.ops.notifications[0][4])
        self.assertEqual(sum(e["kind"] == "delivery_unknown" for e in registry.read_events(0)), 1)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "in_tool")
        self.assertFalse(self.ops.sends)

    def test_send_failure_and_watcher_share_one_unknown_notification(self):
        self.seed_records([PROMPT])
        self.ops.error = "timeout"
        action = actions.nudge("worker", ops=self.ops, action_id="unknown-send")
        self.assertEqual(action["status"], "delivery_unknown")
        for now in (100, 101, 102):
            watch.poll_once(ops=self.ops, now=now)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("worker", self.ops.notifications[0][4])
        self.assertIn("nudge", self.ops.notifications[0][4])
        self.assertEqual(len(self.ops.sends), 1)

    def test_settled_worker_returns_to_running_when_a_typed_prompt_is_answered(self):
        notice = copy.deepcopy(PROMPT)
        notice["message"]["content"] = background_notification("bg-1")["message"]["content"]
        for state in ("done", "awaiting_merge"):
            with self.subTest(state=state):
                self.set_state(state, state_token=f"{state}-token")
                self.seed_records([PROMPT, END])
                states = lambda: registry.load()["workers"]["worker"]["state"]
                # A reconnect notice, even one the worker answers, is not the user using the pane.
                self.ops.write("session-1", [notice, END], append=True)
                watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(states(), state)
                # A typed prompt with no reply yet (or a local /command) is not use either.
                filler = next(r for r in fixtures.RECORDS if r.get("type") not in {"user", "assistant"})
                self.ops.write("session-1", [PROMPT, filler], append=True)
                watch.poll_once(ops=self.ops, now=101)
                self.assertEqual(states(), state)
                # The reply can land on a later poll; the anchor still covers the prompt.
                self.ops.write("session-1", [TOOL], append=True)
                events = watch.poll_once(ops=self.ops, now=102)
                self.assertEqual(states(), "running")
                self.assertEqual([e["payload"]["state"] for e in events if e["kind"] == "worker_state"],
                                 ["running"])
                self.assertFalse(self.ops.notifications)
                self.assertFalse(self.ops.sends)
                # Settling again re-anchors: the answered prompt does not reopen it a second time.
                self.ops.write("session-1", [RESULT, END], append=True)
                self.ops.verdict.update(state="done", pr=None)
                watch.poll_once(ops=self.ops, now=103)
                self.assertEqual(states(), "done")
                watch.poll_once(ops=self.ops, now=104)
                self.ops.write("session-1", [notice], append=True)
                watch.poll_once(ops=self.ops, now=105)
                self.assertEqual(states(), "done")
                self.ops.notifications.clear()
                self.ops.verdict.update(state="ended_without_proof")

    def test_unanswered_prompt_then_answered_notice_keeps_worker_settled(self):
        notice = copy.deepcopy(PROMPT)
        notice["message"]["content"] = background_notification("bg-1")["message"]["content"]
        self.set_state("done", state_token="done-token")
        self.seed_records([PROMPT, END])
        self.ops.write("session-1", [PROMPT, notice, END], append=True)
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "done")

    def test_settled_worker_follows_a_new_session_to_running(self):
        self.set_state("done", state_token="done-token")
        self.seed_records([PROMPT, END])
        watch.poll_once(ops=self.ops, now=100)
        # /clear in the pane: herdr reports a new session, whose transcript postdates the settle.
        self.ops.sessions["worker"] = "session-2"
        self.ops.write("session-2", [PROMPT, END])
        watch.poll_once(ops=self.ops, now=101)  # within the probe interval: not seen yet
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "done")
        watch.poll_once(ops=self.ops, now=100 + watch.SETTLED_PROBE_SECONDS)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual((worker["session_id"], worker["state"]), ("session-2", "running"))

    def test_reopen_never_overwrites_a_concurrent_transition(self):
        original = watch._read
        # "done" here means reopened and settled again mid-poll: same state, new token.
        for state in ("cleaned", "relay_pending", "done"):
            with self.subTest(state=state):
                self.set_state("done", state_token="done-token")
                self.seed_records([PROMPT, END])
                self.ops.write("session-1", [PROMPT, END], append=True)

                def racing(worker, ops, now):
                    result = original(worker, ops, now)
                    if state == "done":
                        actions.change_worker("worker", "running")
                    actions.change_worker("worker", state)
                    return result

                # Only the reopen is under test; leave the queued relay where the race put it.
                with mock.patch.object(watch, "_read", side_effect=racing), mock.patch.object(watch, "_drain"):
                    watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)
                self.assertNotEqual(registry.load()["workers"]["worker"]["state_token"], "done-token")

    def test_session_refresh_never_rebases_the_reopen_guard(self):
        original = actions.refresh_session
        for state in ("cleaned", "relay_pending"):
            with self.subTest(state=state):
                watch._SETTLED_PROBES.clear()
                self.set_state("done", state_token="done-token")
                self.seed_records([PROMPT, END])
                self.ops.sessions["worker"] = f"session-{state}"
                self.ops.write(f"session-{state}", [PROMPT, END])

                def racing(worker, agent, *, now=None):
                    # Cleanup and relay change the state without a new token.
                    registry.update(lambda doc: doc["workers"]["worker"].update(state=state))
                    return original(worker, agent, now=now)

                with mock.patch.object(actions, "refresh_session", side_effect=racing),                         mock.patch.object(watch, "_drain"):
                    watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)

    def test_late_confirmation_clears_pending_action_even_after_done(self):
        for state in ("running", "done"):
            with self.subTest(state=state):
                self.set_state(state)
                self.seed_records([PROMPT])
                action = self.seed_unknown_nudge()
                watch.poll_once(ops=self.ops, now=100)
                record = copy.deepcopy(PROMPT)
                record["message"]["content"] = action["text"]
                self.ops.write("session-1", [record], append=True)
                events = watch.poll_once(ops=self.ops, now=101)
                self.assertEqual(registry.load()["actions"][action["id"]]["status"], "delivered")
                self.assertIsNone(registry.load()["workers"]["worker"].get("pending_action_id"))
                self.assertEqual(sum(e["kind"] == "action_delivered" for e in events), 1)
                self.assertFalse(watch.poll_once(ops=self.ops, now=102))
                self.assertFalse(self.ops.sends)

    def test_unknown_action_does_not_block_checks_or_released_slots(self):
        for state in ("done", "ended_without_proof"):
            with self.subTest(state=state):
                self.set_state("awaiting_checks")
                self.seed_records([PROMPT, END])
                self.seed_unknown_nudge()
                registry.update(lambda doc: doc["config"].update(cap=1))
                self.queue()
                self.ops.verdict["state"] = "awaiting_checks"
                watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(len(registry.load()["queue"]), 1)
                self.ops.verdict.update(state=state, pr=286)
                with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
                    watch.poll_once(ops=self.ops, now=101)
                    watch.poll_once(ops=self.ops, now=102)
                self.assertEqual(registry.load()["workers"]["worker"]["state"], state)
                self.assertEqual(starter.call_count, 1)
                self.assertEqual(registry.load()["queue"], [])
                self.assertFalse(self.ops.sends)
                registry.update(lambda doc: doc["workers"].pop("queued-2"))

    def test_unknown_action_holds_its_relay_but_not_the_queue(self):
        # Live use: a relay waiting behind an unconfirmed send kept three queued
        # issues from starting for over an hour. The relay waits; the queue does not.
        self.seed_records([PROMPT])
        action = self.seed_unknown_nudge()
        self.set_state("relay_pending", relay_request={"action_id": "relay-1", "text": "Continue", "state_token": "worker-state"})
        registry.update(lambda doc: doc["config"].update(cap=2))
        self.queue()
        with mock.patch.object(actions, "relay", wraps=actions.relay) as relay, mock.patch.object(start, "_run_worker") as starter:
            watch.poll_once(ops=self.ops, now=100)
            watch.poll_once(ops=self.ops, now=101)
            relay.assert_not_called()
            # The queued issue started (the mocked start is continued on each poll).
            self.assertEqual({call.args[0]["worker_id"] for call in starter.call_args_list}, {"queued-2"})
            self.assertEqual(registry.load()["queue"], [])
            self.assertFalse(self.ops.sends)
            record = copy.deepcopy(PROMPT)
            record["message"]["content"] = action["text"]
            self.ops.write("session-1", [record], append=True)
            watch.poll_once(ops=self.ops, now=102)
            relay.assert_called_once()
        self.assertEqual(self.ops.sends[0][2:], ("worker", "Continue"))
        self.assertEqual(len(self.ops.notifications), 1)

    def test_moot_nudge_frees_the_worker_for_relays(self):
        # Live use: a stall nudge never reached the transcript, the workers
        # carried on, and every later relay was refused as "Previous action delivery is unknown".
        self.seed_records([PROMPT])
        nudge = self.seed_unknown_nudge()
        self.set_state("relay_pending", relay_request={"action_id": "relay-1", "text": "Yes", "state_token": "worker-state"})
        self.ops.write("session-1", [END], append=True)
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["actions"][nudge["id"]]["status"], "superseded")
        self.assertEqual(self.ops.sends[0][2:], ("worker", "Yes"))

    def test_only_a_nudge_is_settled_by_a_later_reply(self):
        # Decision table: kind x what followed the send -> settled. Producer fixtures supply
        # the API-error record and the form-opening record.
        api_error = next(json.loads(line) for line in
                         (FIXTURES / "api-error-429-sequence.jsonl").read_text(encoding="utf-8").splitlines()
                         if json.loads(line).get("isApiErrorMessage"))
        form = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        cases = (("nudge", [END], "superseded"), ("nudge", [], "delivery_unknown"),
                 ("nudge", [api_error], "delivery_unknown"), ("nudge", [form], "delivery_unknown"),
                 ("relay", [END], "delivery_unknown"), ("resume", [END], "delivery_unknown"))
        for kind, after, expected in cases:
            with self.subTest(kind=kind, after=[r.get("type") for r in after]):
                self.seed_records([PROMPT])
                action = self.seed_unknown_nudge()
                registry.update(lambda doc: doc["actions"][action["id"]].update(kind=kind, status="delivery_unknown"))
                before = registry.load()["event_seq"]
                result = actions.settle_moot_nudge(action["id"], [PROMPT, *after])
                self.assertEqual(result["status"], expected)
                worker = registry.load()["workers"]["worker"]
                self.assertEqual("pending_action_id" in worker, expected == "delivery_unknown")
                superseded = [e for e in registry.read_events(before) if e["kind"] == "action_superseded"]
                self.assertEqual(len(superseded), int(expected == "superseded"))

    def test_finished_worker_settles_a_moot_nudge(self):
        self.seed_records([PROMPT])
        nudge = self.seed_unknown_nudge()
        self.set_state("done")
        self.ops.write("session-1", [END], append=True)
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["actions"][nudge["id"]]["status"], "superseded")
        self.assertNotIn("pending_action_id", registry.load()["workers"]["worker"])
        self.assertFalse(self.ops.notifications)

    def test_first_stall_nudges_second_stall_notifies_without_send(self):
        self.seed_records([PROMPT, TOOL, RESULT])
        watch.poll_once(ops=self.ops, now=1201)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertFalse(self.ops.notifications)
        watch.poll_once(ops=self.ops, now=1202)  # Observe the newly recorded nudge.
        watch.poll_once(ops=self.ops, now=2403)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "stalled")
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(len(self.ops.notifications), 1)
        watch.poll_once(ops=self.ops, now=2404)
        self.assertEqual(len(self.ops.notifications), 1)

    def test_relay_refuses_a_multi_question_or_multi_select_form(self):
        # Live: norm-290's form had a "Label fix" tab and a multi-select "Gate" tab; one key
        # would have answered only the focused tab.
        form, answer = [json.loads(line) for line in
                        (FIXTURES / "multi-question-form-excerpt.jsonl").read_text(encoding="utf-8").splitlines()]
        single = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.seed_records([PROMPT, form])
        self.set_state("question", state_token="form-token")
        self.ops.statuses["worker"] = "blocked"
        with self.assertRaisesRegex(actions.ActionError, r"2 question\(s\) \(Label fix, Gate\); multi-select: Gate"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])
        # One multi-select question alone is refused too.
        lone = copy.deepcopy(form)
        questions = lone["message"]["content"][0]["input"]["questions"]
        questions[:] = questions[1:]
        self.seed_records([PROMPT, lone], grown=True)
        with self.assertRaisesRegex(actions.ActionError, r"1 question\(s\) \(Gate\); multi-select: Gate"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        # Once that form is answered, a later single-question form relays as before.
        self.seed_records([PROMPT, form, answer, single], grown=True)
        self.assertEqual(transcript.open_form_questions(actions.records_for(self.worker, self.ops)),
                         single["message"]["content"][0]["input"]["questions"])
        action = actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        self.assertTrue(self.ops.sends)
        self.assertNotEqual(action.get("status"), "failed")

    def test_declined_form_interrupt_ends_the_turn_so_relay_can_deliver(self):
        # Live: norm-308, 2026-10-09. The user pressed Esc on a four-tab form; the transcript ended with
        # the rejected tool_result and "[Request interrupted by user for tool use]", and the worker
        # stayed running, so relay refused it.
        declined = [json.loads(line) for line in
                    (FIXTURES / "declined-compound-form-interrupt.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertTrue(transcript._is_interrupt(declined[2]))
        self.seed_records([PROMPT, *declined])
        self.ops.statuses["worker"] = "idle"
        watch.poll_once(ops=self.ops, now=100)
        worker = registry.load()["workers"]["worker"]
        self.assertEqual(worker["state"], "ended_without_proof")
        self.ops.visible = "❯ "
        action = actions.relay("worker", "The user's answers", state_token=worker["state_token"], ops=self.ops)
        self.assertNotEqual(action.get("status"), "failed")
        self.assertTrue(self.ops.sends)
        # A prompt after the interrupt is a new turn again.
        self.assertEqual(transcript.classify([PROMPT, *declined, PROMPT], herdr_status="working", now=100,
                                             last_growth_at=100).state, "running")

    def test_interrupt_edge_cases(self):
        declined = [json.loads(line) for line in
                    (FIXTURES / "declined-compound-form-interrupt.jsonl").read_text(encoding="utf-8").splitlines()]
        classify = lambda records: transcript.classify(records, herdr_status="idle", now=100, last_growth_at=100)
        # Only the exact marker ends a turn; a prompt that starts with it is a prompt.
        typed = copy.deepcopy(declined[2])
        typed["message"]["content"][0]["text"] = "[Request interrupted by user] now do this"
        self.assertEqual(classify([PROMPT, declined[0], declined[1], typed]).state, "running")
        # A prompt queued right after Esc (shape of the producer's queued_command) starts a turn.
        queued = next(json.loads(line) for line in
                      (FIXTURES / "queued-notice-excerpt.jsonl").read_text(encoding="utf-8").splitlines()
                      if json.loads(line).get("attachment", {}).get("commandMode") == "prompt")
        queued["attachment"].pop("isMeta", None)
        queued["attachment"]["prompt"] = "do this instead"
        self.assertTrue(transcript._is_queued_prompt(queued))
        ask = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        live = lambda records: transcript.classify(records, herdr_status="idle", now=10_000, last_growth_at=0)
        # Decision table: a queued prompt starts a turn only right after Esc; elsewhere it waits
        # behind the live turn, which keeps its state (and is never made stall-eligible by it).
        for records, expected in (
            ([PROMPT, *declined, queued], "running"),
            ([PROMPT, TOOL, queued], "in_tool"),
            ([PROMPT, ask, queued], "question"),
            ([PROMPT, *background_pair("Agent"), END, queued], "waiting_background"),
        ):
            with self.subTest(expected=expected):
                state = (classify(records).state if expected in ("running", "waiting_background")
                         else live(records).state)
                self.assertEqual(state, expected)
        self.assertTrue(watch._answered_prompt([queued, END]))
        self.assertFalse(watch._answered_prompt([declined[2], END]))
        # A compaction summary is nobody's prompt, so it never reopens a settled worker.
        self.assertTrue(watch._answered_prompt([PROMPT, END]))
        self.assertFalse(watch._answered_prompt([dict(PROMPT, isCompactSummary=True), END]))
        # Verification after an interrupt never sees an earlier turn's final message.
        seen = []
        self.ops.verify_done = lambda worker, **kwargs: (seen.append(kwargs["records"]), dict(self.ops.verdict))[1]
        self.seed_records([PROMPT, END, PROMPT, *declined])
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "ended_without_proof")
        # It sees the interrupted turn's own records (the form), not the earlier final.
        self.assertIn(declined[0], seen[-1])
        self.assertNotIn(END, seen[-1])
        # The verify boundary counts a prompt queued after Esc, and not the marker itself.
        self.set_state("running")
        self.seed_records([PROMPT, END, PROMPT, *declined, queued, END], grown=True)
        seen.clear()
        watch._verify(registry.load()["workers"]["worker"], [PROMPT, END, PROMPT, *declined, queued, END],
                      self.ops, 101, no_closing_record=True)
        self.assertEqual(seen[-1], [END])

    def test_relay_refuses_a_compound_form_seen_only_on_screen(self):
        # Live: norm-308 on Claude Code 2.1.295 had no AskUserQuestion in its transcript while
        # its two-tab form was open; "1" plus enter answered tab 1 and ticked tab 2.
        tabbed = (FIXTURES / "herdr-agent-read-tabbed-form.txt").read_text(encoding="utf-8")
        self.seed_records([PROMPT, TOOL])
        self.set_state("question", state_token="form-token")
        self.ops.statuses["worker"] = "blocked"
        self.ops.visible = tabbed
        with self.assertRaisesRegex(actions.ActionError, "several question tabs and multi-select checkboxes"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        # A lone multi-select question shows checkboxes without a tab bar.
        self.ops.visible = "\n".join(line for line in tabbed.splitlines() if "Submit  →" not in line)
        with self.assertRaisesRegex(actions.ActionError, "shows multi-select checkboxes"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        # An unreadable pane is unknown, so nothing is sent.
        self.ops.visible = ""
        with self.assertRaisesRegex(actions.ActionError, "Cannot read the form"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        original = self.ops.herdr

        def timeout(*args, **kwargs):
            if args[:2] == ("agent", "read"):
                raise TimeoutError("pane read timed out")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=timeout), \
                self.assertRaisesRegex(actions.ActionError, "Cannot read the form"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])
        # An old compound form above the live single-question form does not count.
        rule = "─" * 94
        single = f"{rule}\n Pick one?\n\n❯ 1. Yes\n  2. No\n  3. Type something\n{rule}\n  4. Chat about this\n"
        self.ops.visible = tabbed + "\n" + single
        actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        self.assertTrue(self.ops.sends)

    def test_relay_rechecks_the_form_on_the_records_it_sends_against(self):
        form = json.loads((FIXTURES / "multi-question-form-excerpt.jsonl").read_text(encoding="utf-8").splitlines()[0])
        single = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.seed_records([PROMPT, single])
        self.set_state("question", state_token="form-token")
        self.ops.statuses["worker"] = "blocked"
        original = actions.refresh_session

        def changed(worker, agent, *, now=None):
            # The single form is answered in the pane and a compound one appears before the send.
            self.ops.write("session-1", [PROMPT, form])
            return original(worker, agent, now=now)

        with mock.patch.object(actions, "refresh_session", side_effect=changed),                 self.assertRaisesRegex(actions.ActionError, "multi-select: Gate"):
            actions.relay("worker", "1", state_token="form-token", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])

    def test_question_worker_is_never_stalled_or_nudged(self):
        # Live: taste-swipe #39 went question -> stalled while its form waited on the user,
        # with herdr not reporting the pane as blocked. The open form is in the transcript.
        ask = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.seed_records([PROMPT, ask])
        registry.update(lambda doc: doc["workers"]["worker"].update(state="question"))
        self.ops.statuses["worker"] = "idle"
        for now in (5000, 10000):
            watch.poll_once(ops=self.ops, now=now)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "question")
        self.assertFalse(self.ops.sends)

    def test_stalled_question_worker_moves_to_running_before_any_nudge(self):
        # The form was answered while herdr still showed blocked; later the pane went idle.
        self.seed_records([PROMPT, TOOL, RESULT])
        registry.update(lambda doc: doc["workers"]["worker"].update(state="question"))
        self.ops.statuses["worker"] = "idle"
        watch.poll_once(ops=self.ops, now=5000)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.assertFalse(self.ops.sends)

    def test_done_drains_queue_once_and_relay_pending_gets_first_slot(self):
        self.seed_records([PROMPT, END])
        self.ops.verdict.update(state="done", pr=42, url="https://example.invalid/pr/42", no_ci=True)
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.queue()
        self.add_worker("relay", state="ended_without_proof", session="relay-session", issue=3)
        actions.relay("relay", "The user says continue", state_token="relay-state", ops=self.ops)
        self.assertEqual(registry.load()["workers"]["relay"]["state"], "relay_pending")
        with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
            watch.poll_once(ops=self.ops, now=100)
            self.assertEqual(self.ops.sends[0][2:], ("relay", "The user says continue"))
            self.assertEqual(starter.call_count, 0)
            self.assertEqual(len(registry.load()["queue"]), 1)
            actions.change_worker("relay", "done")
            watch.poll_once(ops=self.ops, now=101)
            watch.poll_once(ops=self.ops, now=102)
            self.assertEqual(starter.call_count, 1)
            self.assertEqual(registry.load()["queue"], [])
        self.assertIn("https://example.invalid/pr/42", self.ops.notifications[0][4])
        self.assertIn("no CI", self.ops.notifications[0][4])

    def test_done_starts_one_queued_issue_without_coordinator(self):
        self.seed_records([PROMPT, END])
        self.ops.verdict["state"] = "done"
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.queue()
        with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
            watch.poll_once(ops=self.ops, now=100)
            watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(starter.call_count, 1)

    def test_pending_relay_refusal_is_reported_once_and_preserves_priority(self):
        self.set_state("relay_pending", relay_request={"action_id": "relay-1", "text": "Continue", "state_token": "worker-state"})
        self.ops.statuses["worker"] = "blocked"
        self.queue()
        with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
            watch.poll_once(ops=self.ops, now=100)
            watch.poll_once(ops=self.ops, now=101)
        self.assertFalse(self.ops.sends)
        self.assertEqual(starter.call_count, 0)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertEqual(len(registry.load()["queue"]), 1)

    def test_session_change_switches_transcript_and_emits_once(self):
        watch.poll_once(ops=self.ops, now=100)
        records = [json.loads(line) for line in (FIXTURES / "session-after-clear-and-resume.jsonl").read_text(encoding="utf-8").splitlines()]
        self.ops.write("new-session", records)
        self.ops.sessions["worker"] = "new-session"
        events = watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(sum(e["kind"] == "session_changed" for e in events), 1)
        current = registry.load()["workers"]["worker"]
        self.assertEqual(current["session_history"], ["session-1", "new-session"])
        self.assertEqual(current["transcript_path"], str(self.ops.path("new-session")))
        self.assertEqual(current["transcript_offset"], self.ops.path("new-session").stat().st_size)
        self.assertFalse(any(e["kind"] == "session_changed" for e in watch.poll_once(ops=self.ops, now=102)))

    def test_session_rotation_supersedes_relay_clears_request_and_notifies_once(self):
        self.set_state("question", state_token="q1")
        self.ops.statuses["worker"] = "blocked"
        self.ops.error = "timeout"
        answer = "The user's exact answer"
        action = actions.relay("worker", answer, state_token="q1", ops=self.ops)
        self.assertEqual(action["status"], "delivery_unknown")
        watch._notify_events(self.ops)
        self.ops.error = None
        self.ops.statuses["worker"] = "idle"
        self.ops.sessions["worker"] = "session-2"
        self.ops.write("session-2", [PROMPT, TOOL])
        old_worker = actions.worker_named("worker")
        events = watch.poll_once(ops=self.ops, now=100)
        superseded = [e for e in events if e["kind"] == "action_superseded"]
        self.assertEqual(len(superseded), 1)
        payload = superseded[0]["payload"]
        self.assertEqual(payload["action_id"], action["id"])
        self.assertEqual(payload["worker_id"], "worker")
        self.assertEqual(payload["agent_name"], "worker")
        self.assertEqual(payload["kind"], "relay")
        self.assertEqual(payload["text"], answer)
        current = actions.worker_named("worker")
        self.assertNotIn("relay_request", current)
        self.assertNotIn("pending_action_id", current)
        self.assertEqual(registry.load()["actions"][action["id"]]["status"], "superseded")
        actions.refresh_session(old_worker, actions.agent_info(current, self.ops))
        watch.poll_once(ops=self.ops, now=101)
        watch._notify_events(self.ops)
        title = f"{Path(self.worker['repo_path']).name} #{self.worker['issue']}: Worker answer superseded"
        notifications = [n for n in self.ops.notifications if n[2] == title]
        self.assertEqual(len(notifications), 1)
        self.assertIn(answer, notifications[0][4])
        self.assertIn("worker", notifications[0][4])
        self.assertEqual(sum(e["kind"] == "action_superseded" for e in registry.read_events(0)), 1)
        self.assertEqual(len(self.ops.sends), 1)

    def assert_atomic_recovery(self, operation, kinds, check, is_committed):
        initial = registry.load()
        for boundary in ("journal", "registry-replace"):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory(dir=self.temp.name) as home, mock.patch.dict(os.environ, {"HERDR_COORD_HOME": home}):
                registry.save(copy.deepcopy(initial))
                original = registry._recover_transaction if boundary == "journal" else registry.save

                def crash(*args):
                    if boundary == "journal" and (registry._home() / "transaction.json").exists():
                        raise RuntimeError("crash after commit")
                    result = original(*args)
                    if boundary == "registry-replace" and is_committed(args[0]):
                        raise RuntimeError("crash after commit")
                    return result

                target = "_recover_transaction" if boundary == "journal" else "save"
                with mock.patch.object(registry, target, side_effect=crash):
                    with self.assertRaisesRegex(RuntimeError, "crash after commit"):
                        operation()
                committed = registry.load()
                events = registry.read_events(initial["event_seq"])
                self.assertEqual([e["kind"] for e in events], kinds)
                check(committed, events)
                self.assertEqual(registry.load(), committed)
                operation()  # Recovery and a retry cannot repeat the committed change.
                self.assertEqual(registry.read_events(initial["event_seq"]), events)
                self.assertFalse((registry._home() / "transaction.json").exists())
                self.assertEqual([e["seq"] for e in events], list(range(initial["event_seq"] + 1, committed["event_seq"] + 1)))
                self.assertEqual(registry.append_event("after_recovery", {}), committed["event_seq"] + 1)
                sequences = [e["seq"] for e in registry.read_events(0)]
                self.assertEqual(len(sequences), len(set(sequences)))

    def test_herdr_loss_state_and_events_recover_atomically(self):
        def check(doc, events):
            self.assertEqual(doc["workers"]["worker"]["state"], "lost")
            self.assertEqual(events[0]["payload"], doc["holds"]["herdr_lost"])
            self.assertEqual(events[1]["payload"], doc["workers"]["worker"])

        self.assert_atomic_recovery(lambda: watch._herdr_lost(123), ["herdr_lost", "worker_state"], check,
                                    lambda doc: "herdr_lost" in doc["holds"])

    def test_interrupted_start_state_and_event_recover_atomically(self):
        self.set_state("starting", start_owner=None)

        def check(doc, events):
            self.assertEqual(doc["workers"]["worker"]["state"], "start_interrupted")
            self.assertEqual(events[0]["payload"], doc["workers"]["worker"])

        self.assert_atomic_recovery(lambda: watch._continue_start(actions.worker_named("worker"), self.ops, 123), ["worker_state"], check,
                                    lambda doc: doc["workers"]["worker"]["state"] == "start_interrupted")

    def test_late_entry_receipt_state_and_events_recover_atomically(self):
        self.set_state("start_failed")
        self.seed_unknown_entry()

        def check(doc, events):
            self.assertEqual(doc["actions"]["late-entry"]["status"], "delivered")
            self.assertEqual(events[0]["payload"], {"action_id": "late-entry", "worker_id": "worker"})
            self.assertEqual(doc["workers"]["worker"]["state"], "running")
            self.assertEqual(events[1]["payload"], doc["workers"]["worker"])

        self.assert_atomic_recovery(lambda: watch._reconcile_entry(actions.worker_named("worker"), self.ops, 123), ["action_delivered", "worker_state"], check,
                                    lambda doc: doc["actions"]["late-entry"]["status"] == "delivered")

    def test_watcher_loss_hold_and_event_recover_atomically(self):
        def check(doc, events):
            self.assertEqual(doc["holds"]["watcher_lost"], {"ts": 123})
            self.assertEqual(events[0]["payload"]["ts"], doc["holds"]["watcher_lost"]["ts"])

        self.assert_atomic_recovery(lambda: watch._watcher_lost(123), ["watcher_lost"], check,
                                    lambda doc: "watcher_lost" in doc["holds"])

    def test_problem_marker_and_event_recover_atomically(self):
        def check(doc, events):
            self.assertEqual(doc["workers"]["worker"]["watch_problem"], "probe failed")
            self.assertEqual(events[0]["payload"], {"worker_id": "worker", "detail": "probe failed"})

        self.assert_atomic_recovery(lambda: watch._report_problem(actions.worker_named("worker"), "probe failed", kind="technical_problem"), ["technical_problem"], check,
                                    lambda doc: doc["workers"]["worker"].get("watch_problem") == "probe failed")

    def test_overdue_marker_and_event_recover_atomically(self):
        self.set_state("awaiting_checks")
        self.ops.verdict.update(state="awaiting_checks", overdue=True)

        def check(doc, events):
            self.assertTrue(doc["workers"]["worker"]["overdue"])
            self.assertEqual(events[0]["payload"], doc["workers"]["worker"])

        self.assert_atomic_recovery(lambda: watch._verify(actions.worker_named("worker"), [PROMPT, END], self.ops, 123), ["checks_overdue"], check,
                                    lambda doc: doc["workers"]["worker"].get("overdue") is True)

    def test_herdr_down_up_holds_sessions_and_partial_start_and_notifies_once(self):
        self.queue()
        self.add_worker("partial", state="starting", session=None, issue=3)
        registry.update(lambda doc: doc["workers"]["partial"].update(phase="worktree"))
        self.ops.reachable = False
        watch.poll_once(ops=self.ops, now=100)
        watch.poll_once(ops=self.ops, now=101)
        self.assertEqual(registry.load()["holds"], {})
        watch.poll_once(ops=self.ops, now=102)
        self.assertFalse(self.ops.notifications)
        doc = registry.load()
        self.assertEqual(doc["workers"]["worker"]["state"], "lost")
        self.assertEqual(doc["workers"]["partial"]["state"], "start_interrupted")
        self.assertEqual(len(doc["queue"]), 1)
        self.assertEqual(sum(e["kind"] == "herdr_lost" for e in registry.read_events(0)), 1)
        self.ops.reachable = True
        with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
            watch.poll_once(ops=self.ops, now=103)
            watch.poll_once(ops=self.ops, now=104)
            self.assertEqual(len(self.ops.notifications), 2)
            self.assertIn("partial", self.ops.notifications[0][4])
            self.assertFalse(self.ops.sends)
            self.assertEqual(starter.call_count, 0)
            self.assertFalse(self.ops.verify_calls)
            actions.go(ops=self.ops)
            watch.poll_once(ops=self.ops, now=104)
            self.assertEqual(starter.call_count, 1)
            self.assertEqual(registry.load()["workers"]["partial"]["state"], "start_interrupted")
            start.restart("3", ops=self.ops)
            self.assertEqual(starter.call_count, 2)
            self.assertEqual(registry.load()["workers"]["worker"]["state"], "lost")

    def test_watcher_loss_blocks_expired_quota_and_queue_until_go(self):
        self.seed_records([PROMPT, self.quota(10)])
        registry.update(lambda doc: doc["config"].update(cap=2))
        self.queue()
        watch._watcher_lost(100)
        with mock.patch.object(start, "_run_worker", side_effect=self.finish_start) as starter:
            watch.poll_once(ops=self.ops, now=101)
            self.assertFalse(self.ops.sends)
            self.assertEqual(starter.call_count, 0)
            actions.go(ops=self.ops)
            watch.poll_once(ops=self.ops, now=102)
            watch.poll_once(ops=self.ops, now=103)
            self.assertEqual(len(self.ops.sends), 1)
            self.assertEqual(starter.call_count, 1)

    def test_awaiting_checks_polls_verifier_and_notifies_only_final_or_overdue(self):
        self.set_state("awaiting_checks")
        self.seed_records([PROMPT, END])
        self.ops.verdict["state"] = "awaiting_checks"
        watch.poll_once(ops=self.ops, now=100)
        self.assertFalse(self.ops.notifications)
        self.ops.verdict["overdue"] = True
        watch.poll_once(ops=self.ops, now=101)
        watch.poll_once(ops=self.ops, now=102)
        self.assertEqual(len(self.ops.notifications), 1)
        self.ops.verdict.update(state="ended_without_proof", detail="failing check: unit tests")
        watch.poll_once(ops=self.ops, now=103)
        self.assertEqual(len(self.ops.notifications), 2)
        self.assertIn("failing check: unit tests", self.ops.notifications[-1][4])
        self.assertEqual(len(self.ops.verify_calls), 4)

    def test_resume_timeout_later_confirmed_releases_starting_state_without_resend(self):
        self.set_state("lost")
        self.ops.error = "timeout"
        action = actions.resume("worker", ops=self.ops)
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "starting")
        record = copy.deepcopy(PROMPT)
        record["message"]["content"] = actions.RESUME_TEXT
        self.ops.write("session-1", [record], append=True)
        self.ops.error = None
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(registry.load()["actions"][action["id"]]["status"], "delivered")
        self.assertEqual(registry.load()["workers"]["worker"]["state"], "running")
        self.assertEqual(len(self.ops.start_calls), 1)
        self.assertFalse(self.ops.sends)

    def test_notification_after_recovered_worker_returns_with_question(self):
        self.set_state("running", reason="herdr_lost")
        self.ops.statuses["worker"] = "blocked"
        watch.poll_once(ops=self.ops, now=100)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("question", self.ops.notifications[0][2])

    def test_stall_intent_without_recorded_send_can_finish_after_restart(self):
        self.seed_records([PROMPT])
        self.set_state("running", stall_nudge_action="reserved-nudge")
        watch.poll_once(ops=self.ops, now=1201)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(registry.load()["actions"]["stall:worker:session-1"]["status"], "delivered")

    def test_stall_marker_is_written_after_action_and_id_survives_crash(self):
        self.seed_records([PROMPT])

        def crash_before_action(name, **kwargs):
            self.assertNotIn("stall_nudge_action", registry.load()["workers"]["worker"])
            self.assertEqual(kwargs["action_id"], "stall:worker:session-1")
            raise RuntimeError("crash before action")

        with mock.patch.object(actions, "nudge", side_effect=crash_before_action):
            with self.assertRaisesRegex(RuntimeError, "crash before action"):
                watch.poll_once(ops=self.ops, now=1201)
        self.assertFalse(registry.load()["actions"])
        watch.poll_once(ops=self.ops, now=1202)
        self.assertEqual(len(self.ops.sends), 1)
        marker = registry.load()["workers"]["worker"]["stall_nudge_action"]
        self.assertEqual(marker, "stall:worker:session-1")
        self.assertIn(marker, registry.load()["actions"])

    def test_crash_after_nudge_before_marker_never_creates_second_send(self):
        self.seed_records([PROMPT])
        real_nudge = actions.nudge

        def crash_after_action(name, **kwargs):
            real_nudge(name, **kwargs)
            self.assertNotIn("stall_nudge_action", registry.load()["workers"]["worker"])
            raise RuntimeError("crash after action")

        with mock.patch.object(actions, "nudge", side_effect=crash_after_action):
            with self.assertRaisesRegex(RuntimeError, "crash after action"):
                watch.poll_once(ops=self.ops, now=1201)
        watch.poll_once(ops=self.ops, now=1202)
        watch.poll_once(ops=self.ops, now=2403)
        self.assertEqual(len(self.ops.sends), 1)
        self.assertEqual(registry.load()["workers"]["worker"]["stall_nudge_action"], "stall:worker:session-1")

    def test_follow_reports_new_loss_after_recovery_and_go(self):
        iteration = []

        def next_poll(_):
            iteration.append(True)
            if len(iteration) == 1:
                actions.go(ops=self.ops)
            if len(iteration) == 3:
                raise KeyboardInterrupt

        with mock.patch.object(watch, "watcher_alive", side_effect=[False, True, False]), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=next_poll), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            watch.follow()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(sum(e["kind"] == "watcher_lost" for e in events), 2)

    def test_incremental_reads_restart_hydrates_and_in_tool_never_stalls(self):
        self.seed_records([PROMPT, TOOL])
        with mock.patch.object(watch.transcript, "read_records", wraps=watch.transcript.read_records) as reader:
            watch.poll_once(ops=self.ops, now=100)
            offset = registry.load()["workers"]["worker"]["transcript_offset"]
            watch.poll_once(ops=self.ops, now=99999)
            reader.assert_called_once_with(self.ops.path("session-1"))
            self.ops.write("session-1", [TOOL], append=True)
            watch.poll_once(ops=self.ops, now=100000)
            self.assertEqual(reader.call_count, 2)
            self.assertEqual(reader.call_args.args[1], offset)
        self.assertFalse(self.ops.sends)
        watch._TRANSCRIPTS.clear()
        self.assertEqual(watch.poll_once(ops=self.ops, now=100001), [])

    def test_lifetime_lock_rejects_second_watcher_but_ignores_pid_text(self):
        with watch.watcher_lock() as acquired:
            self.assertTrue(acquired)
            with mock.patch.object(watch, "poll_once") as poll:
                self.assertEqual(watch.run(ops=self.ops), 0)
                poll.assert_not_called()
        (registry._home() / "watcher.lock").write_text(str(os.getpid()), encoding="utf-8")
        with mock.patch.object(watch, "poll_once", side_effect=KeyboardInterrupt) as poll:
            self.assertEqual(watch.run(ops=self.ops), 0)
            poll.assert_called_once()
        self.assertFalse(watch.lock_held())

    def test_heartbeat_updates_each_poll_and_transient_failure_continues(self):
        seen = []

        def observe(**kwargs):
            seen.append(json.loads((registry._home() / "heartbeat.json").read_text(encoding="utf-8")))
            if len(seen) == 2:
                raise TimeoutError("transient test")
            if len(seen) == 3:
                raise KeyboardInterrupt

        with mock.patch.object(watch, "poll_once", side_effect=observe), mock.patch.object(watch.time, "time", side_effect=[100, 200, 300]), mock.patch.object(watch.time, "sleep"):
            self.assertEqual(watch.run(ops=self.ops, poll_seconds=15), 0)
        self.assertEqual([item["ts"] for item in seen], [100, 200, 300])
        self.assertTrue(all(item["pid"] == os.getpid() and item["poll"] == 15 for item in seen))
        self.assertEqual([e["kind"] for e in registry.read_events(0)], ["technical_problem"])
        self.assertIn("transient test", (registry._home() / "watcher.log").read_text(encoding="utf-8"))
        self.assertFalse(watch.lock_held())

    def test_locked_heartbeat_is_skipped_without_counting_as_a_failure(self):
        # Live: norm watcher, 2026-10-08, WinError 5 renaming onto heartbeat.json while a
        # PowerShell reader held it. Six locked polls in a row must not stop the watcher.
        polls = []

        def poll(**kwargs):
            polls.append(kwargs["now"])
            if len(polls) == 6:
                raise KeyboardInterrupt

        locked = PermissionError(5, "Access is denied")
        # registry.time and watch.time are the same module: one sleep mock sees both kinds.
        with mock.patch.object(registry.os, "replace", side_effect=locked),                 mock.patch.object(watch, "poll_once", side_effect=poll),                 mock.patch.object(watch.time, "sleep") as sleep:
            self.assertEqual(watch.run(ops=self.ops, poll_seconds=15), 0)
        self.assertEqual(len(polls), 6)
        self.assertFalse([e for e in registry.read_events(0) if e["kind"] in {"technical_problem", "watcher_exit"}])
        self.assertIn("heartbeat write skipped", (registry._home() / "watcher.log").read_text(encoding="utf-8"))
        self.assertEqual(list(registry._home().glob("heartbeat-*.tmp")), [])
        delays = [call.args[0] for call in sleep.call_args_list if call.args[0] != 15]
        delays = delays[:registry._REPLACE_ATTEMPTS - 1]
        self.assertEqual(delays, [registry._REPLACE_RETRY_DELAY * 2 ** n for n in range(registry._REPLACE_ATTEMPTS - 1)])

    def test_five_consecutive_poll_failures_emit_exit_and_notify_once(self):
        with mock.patch.object(watch, "poll_once", side_effect=TimeoutError("poll timeout")) as poll, mock.patch.object(watch.time, "sleep"):
            self.assertEqual(watch.run(ops=self.ops), 1)
        self.assertEqual(poll.call_count, 5)
        events = registry.read_events(0)
        self.assertEqual(sum(e["kind"] == "watcher_exit" for e in events), 1)
        self.assertEqual(sum(e["kind"] == "technical_problem" for e in events), 5)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertEqual(sum(n[2] == "Coordinator watcher stopped" for n in self.ops.notifications), 1)
        watch._notify_events(self.ops)
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertEqual(sum(n[2] == "Coordinator watcher stopped" for n in self.ops.notifications), 1)
        self.assertFalse(watch.lock_held())

    def test_successful_poll_resets_consecutive_iteration_failures(self):
        failures = [TimeoutError("poll timeout")] * 4
        with mock.patch.object(watch, "poll_once", side_effect=[*failures, None, *failures, KeyboardInterrupt]) as poll, mock.patch.object(watch.time, "sleep"):
            self.assertEqual(watch.run(ops=self.ops), 0)
        self.assertEqual(poll.call_count, 10)
        self.assertFalse(any(e["kind"] == "watcher_exit" for e in registry.read_events(0)))

    def test_launch_flags_executable_log_handles_and_breakaway_failure(self):
        with mock.patch.object(watch.subprocess, "Popen", return_value=mock.Mock(pid=123)) as popen:
            result = watch.launch()
            self.assertEqual(result, {"state": "launched", "pid": 123})
            argv = popen.call_args.args[0]
            self.assertEqual(argv, [sys.executable, str(Path(watch.__file__).resolve()), "run"])
            kw = popen.call_args.kwargs
            self.assertEqual(kw["creationflags"], subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB)
            self.assertEqual(kw["stdin"], subprocess.DEVNULL)
            self.assertIs(kw["stdout"], kw["stderr"])
            self.assertTrue(kw["close_fds"])
        with mock.patch.object(watch.subprocess, "Popen", side_effect=OSError("breakaway refused")) as popen:
            self.assertEqual(watch.launch()["state"], "launch_failed")
            popen.assert_called_once()
        with watch.watcher_lock(), mock.patch.object(watch.subprocess, "Popen") as popen:
            self.assertEqual(watch.launch()["state"], "already_running")
            popen.assert_not_called()

    def test_follow_compact_projects_metadata_and_omits_prose(self):
        metadata = {"issue": 21, "state": "question", "agent_name": "repo-21-abcd",
                    "worker_id": "worker", "state_token": "a" * 32,
                    "url": "https://github.com/owner/repo/pull/12", "pr": 12,
                    "no_ci": False, "overdue": True}
        seq = registry.append_event("worker_state", {**metadata, "question_text": "Question\n" * 1000,
                                                      "session_id": "omit", "repo_path": "omit"})
        bare = registry.append_event("session_changed", {})
        before = registry.load()
        with mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(compact=True), 0)
        lines = output.getvalue().splitlines()
        self.assertEqual([json.loads(line) for line in lines],
                         [{"seq": seq, "kind": "worker_state", **metadata, "detail": True},
                          {"seq": bare, "kind": "session_changed"}])
        self.assertTrue(all(len(line) < 400 for line in lines))
        ack.assert_not_called()
        self.assertEqual(registry.load(), before)

    def test_follow_compact_marks_each_detail_field_even_when_empty(self):
        for key, value in (("question_text", ""), ("final_message", None),
                           ("detail", "long detail\n" * 1000), ("reason", "reason")):
            registry.append_event("technical_problem", {key: value})
        with mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            watch.follow(compact=True)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()],
                         [{"seq": seq, "kind": "technical_problem", "detail": True} for seq in range(1, 5)])

    def test_follow_compact_bounds_long_metadata_without_changing_event(self):
        payload = {"agent_name": 'name"\\\n' * 100, "worker_id": "w" * 1000,
                   "url": "https://example.com/" + "u" * 1000, "state_token": "a" * 32,
                   "state": "question", "issue": 21, "pr": None, "no_ci": False,
                   "overdue": False, "question_text": "full question"}
        seq = registry.append_event("worker_state", payload)
        with mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            watch.follow(compact=True)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertLess(len(lines[0]) + 1, 400)
        summary = json.loads(lines[0])
        self.assertEqual(summary["seq"], seq)
        self.assertEqual(summary["kind"], "worker_state")
        self.assertEqual(summary["state_token"], payload["state_token"])
        self.assertEqual(set(summary), (set(payload) - {"question_text"}) | {"seq", "kind", "detail"})
        self.assertEqual(registry.read_events(0)[0]["payload"], payload)

    def test_compact_line_flags_shortening_and_always_terminates(self):
        shortened = json.loads(watch._compact_line(
            {"seq": 1, "kind": "worker_state", "payload": {"agent_name": "a" * 500, "state": "done"}}))
        self.assertTrue(shortened["detail"])
        # No string can shrink further: fall back to the minimal line instead of looping.
        stuck = watch._compact_line(
            {"seq": 2, "kind": "k" * 500, "payload": {"state_token": "t" * 32}})
        self.assertEqual(json.loads(stuck), {"seq": 2, "kind": "k" * 500, "detail": True})

    def test_follow_quiet_suppresses_only_busy_states_and_ack_is_cumulative(self):
        registry.append_event("worker_state", {"state": "running"})
        question = registry.append_event("worker_state", {"state": "question", "question_text": "Pick A?"})
        registry.append_event("worker_state", {"state": "in_tool"})
        registry.append_event("worker_state", {"state": "waiting_background"})
        phase = registry.append_event("worker_phase", {"state": "running"})
        done = registry.append_event("worker_state", {"state": "done", "final_message": "Done"})
        for compact in (False, True):
            with self.subTest(compact=compact), mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=[None, KeyboardInterrupt]), mock.patch.object(registry, "read_events", wraps=registry.read_events) as reader, mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(watch.follow(quiet=True, compact=compact), 0)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([event["seq"] for event in events], [question, phase, done])
            self.assertEqual([call.args for call in reader.call_args_list], [(0,), (done,)])
            ack.assert_not_called()
            self.assertEqual(registry.load()["ack_seq"], 0)
        registry.ack(done)
        self.assertEqual(registry.load()["ack_seq"], done)
        self.assertEqual(registry.read_events(registry.load()["ack_seq"]), [])

    def test_follow_default_keeps_full_json_and_busy_states(self):
        registry.append_event("worker_state", {"state": "running", "final_message": "Full\nmessage" * 100})
        registry.append_event("worker_state", {"state": "in_tool"})
        expected = registry.read_events(0)
        with mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            watch.follow()
        self.assertEqual(output.getvalue(), "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in expected))

    def test_cli_follow_compact_and_quiet_flags(self):
        for flags in (("--compact",), ("--quiet",), ("--quiet", "--compact")):
            with self.subTest(flags=flags), mock.patch.object(watch, "follow", return_value=0) as follow:
                self.assertEqual(herdr_coord.main(["follow", "--interval", "0.5", *flags]), 0)
                follow.assert_called_once_with(interval=0.5, **{flag[2:]: True for flag in flags})

    def test_cli_event_reads_full_acknowledged_event_without_acknowledging(self):
        seq = registry.append_event("worker_state", {"issue": 21, "state": "question",
                                                    "question_text": self.ops.visible,
                                                    "final_message": "full final\n" * 100})
        registry.ack(seq)
        expected = registry.read_events(0)[0]
        before = registry.load()
        home = os.environ["HERDR_COORD_HOME"]
        with mock.patch.object(herdr_coord.repo_root, "resolve_repo") as resolve, mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["event", str(seq)]), 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertEqual(registry.load(), before)
        self.assertEqual(os.environ["HERDR_COORD_HOME"], home)
        resolve.assert_not_called()
        ack.assert_not_called()

    def test_cli_event_refuses_missing_sequence_without_acknowledging(self):
        registry.append_event("question", {"question_text": "full text"})
        before = registry.load()
        for seq in (-1, 0, 2):
            with self.subTest(seq=seq), mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(herdr_coord.main(["event", str(seq)]), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result["state"], "refused")
            self.assertIn(f"sequence {seq}", result["detail"])
            ack.assert_not_called()
            self.assertEqual(registry.load(), before)

    def test_cli_event_selects_current_repository_state(self):
        registry.append_event("question", {"question_text": "other repository"})
        repo = Path(self.temp.name) / "repo"
        home = Path(self.temp.name) / "repo-state"
        with mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(home)}):
            seq = registry.append_event("question", {"question_text": "current repository"})
            expected = registry.read_events(0)[0]
        with mock.patch.dict(os.environ), mock.patch.object(herdr_coord.repo_root, "base_root", return_value=Path(self.temp.name) / "unused-base"), mock.patch.object(herdr_coord.repo_root, "resolve_repo", return_value=repo) as resolve, mock.patch.object(herdr_coord.repo_root, "state_root", return_value=home) as state_root, mock.patch.object(herdr_coord.Path, "cwd", return_value=repo), mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            os.environ.pop("HERDR_COORD_HOME", None)
            self.assertEqual(herdr_coord.main(["event", str(seq)]), 0)
            self.assertEqual(registry.load()["ack_seq"], 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        resolve.assert_called_once_with(repo)
        state_root.assert_called_once_with(repo)
        ack.assert_not_called()

    def test_follow_stale_heartbeat_once_replays_offline_events_and_ack_hides_them(self):
        first = registry.append_event("question", {"issue": 1})
        second = registry.append_event("done", {"issue": 2})
        registry.ack(first)
        watch.heartbeat(now=100, poll=15)
        with watch.watcher_lock(), mock.patch.object(watch.time, "time", return_value=146), mock.patch.object(watch.time, "sleep", side_effect=[None, None, KeyboardInterrupt]), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(interval=5), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertNotIn(first, [e["seq"] for e in events])
        self.assertIn(second, [e["seq"] for e in events])
        self.assertEqual(sum(e["kind"] == "watcher_slow" for e in events), 1)
        self.assertFalse(any(e["kind"] == "watcher_lost" for e in events))
        self.assertEqual(registry.load()["holds"], {})
        with mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as replay:
            watch.follow()
        self.assertIn(second, [json.loads(line)["seq"] for line in replay.getvalue().splitlines()])
        registry.ack(registry.load()["event_seq"])
        with mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as after_ack:
            watch.follow()
        self.assertEqual(after_ack.getvalue(), "")

    def test_follow_hung_threshold_emits_and_notifies_once_without_hold(self):
        for age, expected in ((9 * 60, 0), (10 * 60, 0), (11 * 60, 1)):
            with self.subTest(age=age), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(Path(self.temp.name) / f"hung-{age}")}):
                watch.heartbeat(now=100, poll=15)
                with watch.watcher_lock(), mock.patch.object(watch.time, "time", return_value=100 + age), mock.patch.object(watch.time, "sleep", side_effect=[None, None, KeyboardInterrupt]), mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(watch.follow(), 0)
                events = [e for e in registry.read_events(0) if e["kind"] == "watcher_hung"]
                self.assertEqual(len(events), expected)
                self.assertEqual(registry.load()["holds"], {})
                if expected:
                    self.assertEqual(events[0]["payload"]["pid"], os.getpid())
                    self.assertIn(str(os.getpid()), events[0]["payload"]["detail"])
                self.ops.notifications.clear()
                watch._notify_events(self.ops)
                watch._notify_events(self.ops)
                notifications = [n for n in self.ops.notifications if n[2] == "Coordinator watcher hung"]
                self.assertEqual(len(notifications), expected)
                if expected:
                    self.assertIn(str(os.getpid()), notifications[0][4])
                self.assertFalse(self.ops.sends)
                self.assertFalse(self.ops.start_calls)

    def test_follow_hung_resets_after_heartbeat_recovers(self):
        watch.heartbeat(now=100, poll=15)
        observations = []

        def next_interval(_):
            observations.append(True)
            if len(observations) == 1:
                watch.heartbeat(now=800, poll=15)
            elif len(observations) == 3:
                raise KeyboardInterrupt

        with watch.watcher_lock(), mock.patch.object(watch.time, "time", side_effect=[761, 801, 1461]), mock.patch.object(watch.time, "sleep", side_effect=next_interval), mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(watch.follow(), 0)
        self.assertEqual(sum(e["kind"] == "watcher_hung" for e in registry.read_events(0)), 2)
        self.assertEqual(registry.load()["holds"], {})

    def test_follow_retries_each_event_after_registry_lock_timeout(self):
        for kind, fail_at in (("watcher_slow", 1), ("watcher_hung", 2), ("watcher_lost", 1)):
            with self.subTest(kind=kind), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(Path(self.temp.name) / kind)}):
                watch.heartbeat(now=100, poll=15)
                locks = []
                original = registry.locked

                def contend(*args, **kwargs):
                    locks.append(True)
                    if len(locks) == fail_at:
                        raise TimeoutError("registry lock busy")
                    return original(*args, **kwargs)

                with mock.patch.object(watch, "watcher_alive", return_value=kind != "watcher_lost"), mock.patch.object(watch.time, "time", return_value=761 if kind == "watcher_hung" else 146), mock.patch.object(watch.time, "sleep", side_effect=[None, None, KeyboardInterrupt]) as sleep, mock.patch.object(registry, "locked", side_effect=contend), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    self.assertEqual(watch.follow(), 0)
                self.assertEqual(sleep.call_count, 3)
                events = registry.read_events(0)
                self.assertEqual(sum(e["kind"] == kind for e in events), 1)
                self.assertEqual(sum(json.loads(line)["kind"] == kind for line in output.getvalue().splitlines()), 1)
                self.assertEqual(bool(registry.load()["holds"]), kind == "watcher_lost")

    def test_follow_lock_free_means_lost_even_with_fresh_heartbeat(self):
        watch.heartbeat(now=100, poll=15)
        with mock.patch.object(watch.time, "time", return_value=101), mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            watch.follow()
        self.assertEqual(json.loads(output.getvalue())["kind"], "watcher_lost")

    def test_dead_heartbeat_process_is_lost_even_if_lock_is_held(self):
        watch.heartbeat(now=100, poll=15)
        with watch.watcher_lock(), mock.patch.object(start, "_process_identity", return_value=None):
            self.assertFalse(watch.watcher_alive(now=101))

    def test_cli_watcher_commands(self):
        with mock.patch.object(watch, "run", return_value=0) as run:
            self.assertEqual(herdr_coord.main(["watch-run"]), 0)
            run.assert_called_once_with()
        with mock.patch.object(watch, "follow", return_value=0) as follow:
            self.assertEqual(herdr_coord.main(["follow", "--interval", "0.5"]), 0)
            follow.assert_called_once_with(interval=0.5)
        with mock.patch.object(watch, "launch", return_value={"state": "launch_failed"}), mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["launch-watcher"]), 1)


if __name__ == "__main__":
    unittest.main()
