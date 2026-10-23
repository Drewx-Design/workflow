import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts"))
for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(key, None)  # a suite run inside herdr must not resolve a real lane

import copy
import io
import itertools
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import actions
import finish
import herdr_coord
import lanes
import registry
import start
import transcript
import watch
import test_actions as fixtures
from test_actions import FakeOps, FIXTURES, PROMPT, END, TOOL, RESULT, ASK, ANSWER, QUOTA
from test_start import FakeOps as StartOps
from test_finish import FakeOps as FinishOps, failure, pr, success
from test_lanes import FakeOps as LaneOps
from test_transcript import background_pair, background_notification


class WatchTests(unittest.TestCase):
    def setUp(self):
        fixtures.ActionTests.setUp(self)
        snapshot = mock.patch.object(lanes, "read_snapshot", return_value={
            "tab_ids": {"w1:t1"}, "controller_counts": {"coordinator-session": 1}})
        self.read_snapshot = lanes.read_snapshot
        self.snapshot = snapshot.start()
        self.addCleanup(snapshot.stop)

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
                                     ("pane", "send-text", fixtures.AGENTS["blocked"]["pane_id"], "A"),
                                         ("agent", "send-keys", name, "enter")])

    def test_worker_problem_notifications_name_registered_repository(self):
        worker = actions.worker_named("worker")
        for kind, title in (("delivery_unknown", "Worker delivery unknown"),
                            ("technical_problem", "Coordinator technical problem")):
            with self.subTest(kind=kind):
                watch._report_problem(worker, kind, kind=kind)
                watch._notify_events(self.ops)
                self.assertEqual(self.ops.notifications[-1][2],
                                 f"main: {Path(worker['repo_path']).name} #{worker['issue']}: {title}")

    def test_worker_state_notifications_name_payload_repository(self):
        for state in ("question", "start_failed", "start_interrupted", "ended_without_proof",
                      "done", "lost", "stalled", "awaiting_checks"):
            with self.subTest(state=state):
                event = {"kind": "checks_overdue" if state == "awaiting_checks" else "worker_state",
                         "payload": {"repo_path": str(Path(self.temp.name) / "taste-swipe"),
                                     "issue": 21, "state": state}}
                title, _ = watch._notification(event)
                self.assertEqual(title, f"main: taste-swipe #21: {state}")

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
        self.assertEqual(title, "main: Issue #21: question")

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
                         f"main: {Path(self.worker['repo_path']).name} #{self.worker['issue']}: question")
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
            registry.ack(registry.load()["event_seq"])
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

    end_ids = itertools.count()

    def end_saying(self, *texts):
        record = copy.deepcopy(END)
        record["message"]["content"] = [{"type": "text", "text": text} for text in texts]
        record["uuid"] = f"end-{next(self.end_ids)}"  # real records each carry their own uuid
        return record

    def background_events(self, since):
        return [event["payload"] for event in registry.read_events(since)
                if event["kind"] == "worker_state" and event["payload"].get("state") == "waiting_background"]

    def test_background_wait_carries_a_question_the_turn_ended_on(self):
        # norm #339: a brainstorm worker asked the user a question in plain text while its own background
        # shell still ran; the wait hid the question for up to six hours.
        question = "Ranking question, re-posed: A or B? The rest of the brainstorm waits on your answer."
        launch, result = background_pair("Bash")
        registry.update(lambda doc: doc["workers"]["worker"].update(final_message="An earlier turn's report."))
        self.seed_records([PROMPT, self.end_saying("Earlier turn."), PROMPT, launch, result,
                           self.end_saying(question)])
        watch.poll_once(ops=self.ops, now=100)
        (event,) = self.background_events(0)
        self.assertEqual(event["final_message"], question)
        self.assertEqual(actions.worker_named("worker")["final_message"], question)
        self.assertNotIn("question_text", event)
        self.assertFalse(self.ops.verify_calls)
        self.assertFalse(self.ops.sends)

        # No growth, same turn: reported once.
        seq = max(event["seq"] for event in registry.read_events(0))
        watch.poll_once(ops=self.ops, now=160)
        self.assertEqual(self.background_events(seq), [])

        # the user's answer is relayed; the next turn ends in the same wait with a new question.
        follow_up = "Thanks. One more: keep the old ranking as a fallback?"
        self.ops.write("session-1", [PROMPT, self.end_saying(follow_up)], append=True)
        watch.poll_once(ops=self.ops, now=220)
        (second,) = self.background_events(seq)
        self.assertEqual(second["final_message"], follow_up)
        self.assertNotEqual(second["state_token"], event["state_token"])
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        with self.assertRaisesRegex(actions.ActionError, "Stale relay"):
            actions.relay("worker", "Yes", state_token=event["state_token"], ops=self.ops)

    def test_background_wait_reads_the_question_behind_an_untaken_notice(self):
        # Two background jobs: one finishes after the question, and the idle worker never takes up
        # its notice. The classifier drops that notice; the final text must come from the same turn.
        question = "Which ranking should the brainstorm keep?"
        first, first_result = background_pair("Bash")
        second, second_result = background_pair("Agent")
        self.ops.statuses["worker"] = "done"
        notice = background_notification(first["message"]["content"][0]["id"])
        self.seed_records([PROMPT, first, first_result, second, second_result, self.end_saying(question), notice])
        watch.poll_once(ops=self.ops, now=100)
        (event,) = self.background_events(0)
        self.assertEqual(event["final_message"], question)

    def test_background_wait_does_not_repeat_an_answered_question(self):
        # A relay moves the worker on before its prompt reaches the transcript; re-reading the old
        # turn must not publish the question the user already answered.
        launch, result = background_pair("Bash")
        self.seed_records([PROMPT, launch, result, self.end_saying("A or B?")])
        watch.poll_once(ops=self.ops, now=100)
        (event,) = self.background_events(0)
        actions.change_worker("worker", "running", now=101, expected="waiting_background")
        seq = max(item["seq"] for item in registry.read_events(0))
        watch.poll_once(ops=self.ops, now=102)
        (again,) = self.background_events(seq)
        self.assertNotIn("final_message", again)
        self.assertNotEqual(again["state_token"], event["state_token"])
        self.assertNotIn("final_message", actions.worker_named("worker"))
        # A stall that follows must not carry the answered question into the user's alert.
        actions.change_worker("worker", "stalled", now=103, expected="waiting_background")
        stalled = [item for item in registry.read_events(seq) if item["payload"].get("state") == "stalled"]
        self.assertNotIn("A or B?", watch._notification(stalled[0])[1])
        self.assertNotIn("final_message", stalled[0]["payload"])

    def test_background_wait_never_reuses_an_earlier_turns_text(self):
        launch, result = background_pair("Bash")
        registry.update(lambda doc: doc["workers"]["worker"].update(final_message="Stale report."))
        self.seed_records([PROMPT, self.end_saying("Earlier turn's question?"), PROMPT, launch, result,
                           self.end_saying()])
        watch.poll_once(ops=self.ops, now=100)
        (event,) = self.background_events(0)
        self.assertNotIn("final_message", event)
        self.assertNotIn("final_message", actions.worker_named("worker"))

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
        registry.ack(registry.load()["event_seq"])
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

    def background_wait(self):
        registry.update(lambda doc: doc["workers"]["worker"].pop("expired_background", None))
        self.set_state("running")
        self.ops.verify_calls.clear()
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash")])
        watch._TRANSCRIPTS.clear()
        watch.poll_once(ops=self.ops, now=120)
        registry.ack(registry.load()["event_seq"])
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")

    def test_background_wait_extends_while_the_pane_footer_counts_live_shells(self):
        # Live 2026-10-19 (taste-swipe #48): an hours-long background build ended the worker every hour.
        self.background_wait()
        self.ops.visible = (FIXTURES / "herdr-agent-read-visible.txt").read_text(encoding="utf-8")
        # Live footer of a working norm worker, 2026-10-19.
        live = "─" * 40 + "\n  ⏵⏵ auto mode on · 2 shells · /tasks to see subagents · ← 1 agent · ↓ to manage"
        self.assertTrue(watch._pane_shows_background_shells(self.worker, mock.Mock(
            herdr=lambda *args, **kwargs: fixtures.adapters.CommandResult(True, 0, live, ""))))
        for now, status in ((3600, "done"), (7200, "idle"), (watch.BACKGROUND_LIVE_MAX_SECONDS - 1, "idle")):
            self.ops.statuses["worker"] = status  # herdr flips a viewed pane to idle
            self.assertEqual(watch.poll_once(ops=self.ops, now=now), [])
        self.assertEqual(actions.worker_named("worker")["state"], "waiting_background")
        self.assertFalse(self.ops.verify_calls)
        # The cap still ends the wait while the footer claims live work.
        events = watch.poll_once(ops=self.ops, now=watch.BACKGROUND_LIVE_MAX_SECONDS)
        self.assertEqual([event["payload"]["state"] for event in events
                          if event["kind"] == "worker_state"], ["ended_without_proof"])
        self.assertFalse(self.ops.sends)

    def test_background_wait_ends_at_timeout_when_the_footer_shows_no_live_shells(self):
        for screen in ("", "  ⏵⏵ auto mode on · esc to interrupt",
                       "  ⏵⏵ auto mode on · 0 shells · ↓ to manage",
                       "● Running 2 shells · 4m\n❯\n  ⏵⏵ auto mode on",
                       # Counts above the footer are earlier output, not the pane's live jobs.
                       "  Earlier: auto mode on · 2 shells · 1 agent\n❯\n  ⏵⏵ auto mode on · esc to interrupt",
                       # Live footers of idle workers, 2026-10-19: "← 1 agent" is on every pane.
                       "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
                       "  ⏵⏵ auto mode on (shift+tab to cycle) · ⧉ 2 · ← 1 agent · 1 feedback draft"):
            with self.subTest(screen=screen):
                self.background_wait()
                self.ops.visible = screen
                events = watch.poll_once(ops=self.ops, now=3600)
                self.assertEqual([event["payload"]["state"] for event in events
                                  if event["kind"] == "worker_state"], ["ended_without_proof"])
                self.assertEqual(len(self.ops.verify_calls), 1)

    def test_background_wait_does_not_read_the_pane_before_its_timeout(self):
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash")])
        watch.poll_once(ops=self.ops, now=120)
        registry.ack(registry.load()["event_seq"])
        with mock.patch.object(watch, "_pane_shows_background_shells") as footer:
            self.assertEqual(watch.poll_once(ops=self.ops, now=3599), [])
        footer.assert_not_called()

    def test_background_wait_survives_herdr_showing_the_pane_idle(self):
        # Live 2026-10-14 (taste-swipe #39): herdr flipped the viewed pane from done to idle, the
        # wait read as a stall, and the refused nudge was reported as delivery_unknown.
        self.ops.statuses["worker"] = "done"
        self.seed_records([PROMPT, *background_pair("Bash")])
        watch.poll_once(ops=self.ops, now=120)
        registry.ack(registry.load()["event_seq"])
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

    def test_brainstorm_that_moved_on_keeps_needing_a_pr_after_a_relay_trims_its_records(self):
        # norm #330, 2026-10-20: the worker went from ce-brainstorm to ce-work, stopped mid-build naming
        # a file it wrote, and was relayed a continue; the records after that relay hold no stage change.
        plan = Path(self.temp.name) / "plans" / "x-plan.md"
        plan.parent.mkdir()
        plan.write_text("---\nartifact_contract: ce-unified-plan/v1\nproduct_contract_source: ce-brainstorm\n---\n",
                        encoding="utf-8")
        stage = {"type": "assistant", "isSidechain": False, "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_stage", "name": "Skill",
             "input": {"skill": "compound-engineering:ce-work", "args": "plans/x-plan.md"}}]}}
        launched = {"type": "user", "isSidechain": False, "message": {"role": "user", "content": [
            {"tool_use_id": "toolu_stage", "type": "tool_result", "content": "Launching skill: ce-work"}]}}
        final = copy.deepcopy(END)
        final["message"]["content"] = "U6 done; the plan is `plans/x-plan.md`. Next: U7."
        self.set_state("running", entry_command="ce-brainstorm", reopen_action_id="relay-1")
        registry.update(lambda doc: doc["actions"].update({"relay-1": {
            "session_id": actions.worker_named("worker")["session_id"], "transcript_position": 3}}))
        self.ops.verify_done = None  # Use the real finish verifier.
        git = FinishOps()
        git.git_status.stdout = "?? plans/x-plan.md"
        git.prs = success([])
        self.ops.git, self.ops.gh = git.git, git.gh
        records = [PROMPT, stage, launched, PROMPT, final]
        # Without the stage the trimmed records alone would prove the brainstorm.
        self.assertEqual(finish.verify_done(actions.worker_named("worker"), ops=self.ops, config={}, now=120,
                                            records=records[3:])["state"], "done")
        watch._verify(actions.worker_named("worker"), records, self.ops, 120)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertEqual(worker["detail"], "no open PR on the worker branch")
        self.assertEqual(worker["advanced_stage"], "ce-work")
        # Remembered: a later check whose records no longer show the stage still needs the PR.
        self.set_state("running")
        watch._verify(actions.worker_named("worker"), [PROMPT, final], self.ops, 130)
        self.assertEqual(actions.worker_named("worker")["state"], "ended_without_proof")

    def test_poll_records_a_move_on_to_build_before_the_session_changes(self):
        # Review 2026-10-20: a stage seen only by the end-of-turn check is lost when the session
        # changes first; the poll records it as soon as the transcript shows it.
        stage = {"type": "assistant", "isSidechain": False, "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_stage", "name": "Skill", "input": {"skill": "lfg", "args": ""}}]}}
        launched = {"type": "user", "isSidechain": False, "message": {"role": "user", "content": [
            {"tool_use_id": "toolu_stage", "type": "tool_result", "content": "Launching skill: lfg"}]}}
        for entry, expected in (("ce-brainstorm", "lfg"), ("/compound-engineering:ce-strategy", "lfg"),
                                ("ce-work", None)):
            with self.subTest(entry=entry):
                self.set_state("running", entry_command=entry)
                registry.update(lambda doc: doc["workers"]["worker"].pop("advanced_stage", None))
                self.seed_records([PROMPT, TOOL, RESULT])
                self.ops.write("session-1", [stage, launched], append=True)
                watch.poll_once(ops=self.ops, now=100)
                self.assertEqual(actions.worker_named("worker").get("advanced_stage"), expected)
        # A watcher that stopped after saving the offset but before the stage still finds it.
        self.set_state("running", entry_command="ce-brainstorm")
        registry.update(lambda doc: doc["workers"]["worker"].pop("advanced_stage", None))
        self.seed_records([PROMPT, stage, launched])  # already read: no growth on this poll
        watch.poll_once(ops=self.ops, now=110)
        self.assertEqual(actions.worker_named("worker").get("advanced_stage"), "lfg")

    def test_plan_poll_ignores_own_entry_then_records_a_build_stage(self):
        entry = copy.deepcopy(PROMPT)
        entry["message"]["content"] = "<command-name>/ce-plan</command-name>"
        self.set_state("running", entry_command="ce-plan")
        self.seed_records([entry, TOOL, RESULT])
        watch.poll_once(ops=self.ops, now=100)
        self.assertNotIn("advanced_stage", actions.worker_named("worker"))
        build = copy.deepcopy(PROMPT)
        build["message"]["content"] = "<command-name>/ce-work</command-name>"
        self.ops.write("session-1", [build, TOOL, RESULT], append=True)
        watch.poll_once(ops=self.ops, now=110)
        self.assertEqual(actions.worker_named("worker")["advanced_stage"], "ce-work")

    def test_plan_verification_ignores_own_entry_and_remembers_a_build_after_trimming(self):
        plan = Path(self.temp.name) / "plans" / "x-plan.md"
        plan.parent.mkdir()
        plan.write_text("---\nartifact_contract: ce-unified-plan/v1\n"
                        "product_contract_source: ce-plan-bootstrap\n---\n", encoding="utf-8")
        entry = copy.deepcopy(PROMPT)
        entry["message"]["content"] = "<command-name>/compound-engineering:ce-plan</command-name>"
        final = copy.deepcopy(END)
        final["message"]["content"] = "Plan ready at `plans/x-plan.md`. What would you like to do next?"
        self.set_state("running", entry_command="/compound-engineering:ce-plan")
        self.ops.verify_done = None
        git = FinishOps()
        git.git_status.stdout = "?? plans/x-plan.md\0"
        git.prs = success([])
        self.ops.git, self.ops.gh = git.git, git.gh
        watch._verify(actions.worker_named("worker"), [entry, final], self.ops, 100)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "done")
        self.assertEqual(worker["detail"], f"plan artifact written: {plan}")
        self.assertNotIn("advanced_stage", worker)
        self.assertFalse([call for call in git.calls if call[0] == "gh"])

        stage = {"type": "assistant", "isSidechain": False, "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_stage", "name": "Skill",
             "input": {"skill": "compound-engineering:ce-work", "args": "plans/x-plan.md"}}]}}
        launched = {"type": "user", "isSidechain": False, "message": {"role": "user", "content": [
            {"tool_use_id": "toolu_stage", "type": "tool_result", "content": "Launching skill: ce-work"}]}}
        self.set_state("running", reopen_action_id="relay-1")
        registry.update(lambda doc: doc["actions"].update({"relay-1": {
            "session_id": worker["session_id"], "transcript_position": 3}}))
        watch._verify(actions.worker_named("worker"), [entry, stage, launched, PROMPT, final], self.ops, 110)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertEqual(worker["detail"], "no open PR on the worker branch")
        self.assertEqual(worker["advanced_stage"], "ce-work")
        self.set_state("running")
        watch._verify(actions.worker_named("worker"), [PROMPT] * 4 + [final], self.ops, 120)
        self.assertEqual(actions.worker_named("worker")["detail"], "no open PR on the worker branch")

    def test_no_closing_record_cannot_finish_from_previous_turn_artifact(self):
        artifact = Path(self.temp.name) / "plans" / "previous.md"
        artifact.parent.mkdir()
        artifact.write_text("---\nartifact_contract: ce-unified-plan/v1\nproduct_contract_source: ce-brainstorm\n---\n",
                            encoding="utf-8")
        earlier = copy.deepcopy(END)
        earlier["message"]["content"] = "Requirements are in `plans/previous.md`."
        sidechain = copy.deepcopy(earlier)
        sidechain["isSidechain"] = True
        self.set_state("running", entry_command="ce-brainstorm")
        self.ops.statuses["worker"] = "done"
        self.ops.verify_done = None  # Use the real finish verifier.
        git = FinishOps()
        git.git_status.stdout = "?? plans/previous.md"  # the worker wrote it, in the earlier turn
        self.ops.git = git.git
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
                self.assertEqual(bool(self.ops.notifications), event in {"question", "done", "fail", "end", "probe-once", "probe-three", "absent", "down", "down-no-session"})
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
        self.assertEqual(self.ops.notifications[0][2], f"main: {Path(self.worker['repo_path']).name} #21: question")
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
                         f"main: {Path(self.worker['repo_path']).name} #{self.worker['issue']}: Worker delivery unknown")
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

    def reopen_typed_turn(self):
        self.set_state("done", state_token="done-token")
        self.seed_records([PROMPT, END])
        self.ops.write("session-1", [PROMPT, TOOL], append=True)
        watch.poll_once(ops=self.ops, now=100)
        worker = actions.worker_named("worker")
        self.assertEqual(worker["state"], "running")
        self.assertIs(worker["typed_turn"], True)
        self.assertFalse(self.ops.notifications)
        self.assertFalse(self.ops.sends)

    def test_typed_reopen_ended_without_proof_emits_actionable_event_without_notification(self):
        self.reopen_typed_turn()
        self.ops.write("session-1", [RESULT, END], append=True)
        events = watch.poll_once(ops=self.ops, now=101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "ended_without_proof")
        self.assertIs(event["payload"]["typed_turn"], True)
        self.assertTrue(registry.event_actionable(event))
        self.assertIsNone(watch._notification(event))
        self.assertFalse(self.ops.notifications)
        self.assertEqual(registry.load()["notification_seq"], event["seq"])

    def test_relay_after_typed_turn_restores_settle_notification(self):
        self.reopen_typed_turn()
        self.ops.write("session-1", [RESULT, END], append=True)
        watch.poll_once(ops=self.ops, now=101)
        worker = actions.worker_named("worker")
        action = actions.relay("worker", "Please continue", state_token=worker["state_token"], ops=self.ops)
        self.assertEqual(action["status"], "delivered")
        self.ops.write("session-1", [END], append=True)
        events = watch.poll_once(ops=self.ops, now=102)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "ended_without_proof")
        self.assertFalse(event["payload"].get("typed_turn"))
        self.assertIsNotNone(watch._notification(event))
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("ended_without_proof", self.ops.notifications[0][2])

    def test_done_after_typed_turn_does_not_notify(self):
        self.reopen_typed_turn()
        self.ops.verdict.update(state="done", pr=42, url="https://example.invalid/pr/42")
        self.ops.write("session-1", [RESULT, END], append=True)
        events = watch.poll_once(ops=self.ops, now=101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "done")
        self.assertIs(event["payload"]["typed_turn"], True)
        self.assertTrue(registry.event_actionable(event))
        self.assertIsNone(watch._notification(event))
        self.assertFalse(self.ops.notifications)

    def test_queued_relay_clears_typed_turn_when_delivered_and_next_settle_notifies(self):
        self.set_state("ended_without_proof", typed_turn=True)
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.add_worker("busy", session="busy-session", issue=2)
        result = actions.relay("worker", "Please continue", state_token="worker-state", ops=self.ops)
        self.assertEqual(result["state"], "relay_pending")
        self.assertTrue(actions.worker_named("worker")["typed_turn"])
        self.assertFalse(self.ops.sends)
        registry.update(lambda doc: doc["workers"]["busy"].update(state="done"))
        watch._drain(self.ops)
        self.assertEqual(actions.worker_named("worker")["state"], "running")
        self.assertFalse(actions.worker_named("worker").get("typed_turn"))
        self.assertEqual(len(self.ops.sends), 1)
        self.ops.write("session-1", [END], append=True)
        events = watch.poll_once(ops=self.ops, now=100)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "ended_without_proof")
        self.assertFalse(event["payload"].get("typed_turn"))
        self.assertEqual(len(self.ops.notifications), 1)

    def test_question_after_typed_turn_stays_actionable_without_notification(self):
        self.reopen_typed_turn()
        self.ops.statuses["worker"] = "blocked"
        self.ops.write("session-1", [RESULT], append=True)
        events = watch.poll_once(ops=self.ops, now=101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "question")
        self.assertIs(event["payload"]["typed_turn"], True)
        self.assertTrue(registry.event_actionable(event))
        self.assertIsNone(watch._notification(event))
        self.assertFalse(self.ops.notifications)

    def test_background_final_message_after_typed_turn_carries_mark(self):
        self.reopen_typed_turn()
        self.ops.write("session-1", [RESULT, *background_pair("Bash"), self.end_saying("Which option?")],
                       append=True)
        events = watch.poll_once(ops=self.ops, now=101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "waiting_background")
        self.assertEqual(event["payload"]["final_message"], "Which option?")
        self.assertIs(event["payload"]["typed_turn"], True)
        self.assertTrue(registry.event_actionable(event))
        self.assertIsNone(watch._notification(event))
        self.assertFalse(self.ops.notifications)

    def test_question_without_typed_turn_still_notifies(self):
        self.ops.statuses["worker"] = "blocked"
        self.seed_records([PROMPT, TOOL, RESULT])
        events = watch.poll_once(ops=self.ops, now=100)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "question")
        self.assertFalse(event["payload"].get("typed_turn"))
        self.assertIsNotNone(watch._notification(event))
        self.assertEqual(len(self.ops.notifications), 1)
        self.assertIn("question", self.ops.notifications[0][2])

    def test_typed_turn_does_not_suppress_other_worker_notifications(self):
        for kind, state in (("worker_state", "lost"), ("worker_state", "stalled"),
                            ("checks_overdue", "awaiting_checks")):
            with self.subTest(kind=kind, state=state):
                event = {"kind": kind, "payload": {"state": state, "typed_turn": True}}
                self.assertIsNotNone(watch._notification(event))

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
        registry.ack(registry.load()["event_seq"])
        watch.poll_once(ops=self.ops, now=1203)  # Observe that the lane has handled its progress.
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

    def dismissed_records(self):
        return [json.loads(line) for line in
                (FIXTURES / "dismissed-multiselect-form.jsonl").read_text(encoding="utf-8").splitlines()]

    def open_multiselect(self):
        ask = self.dismissed_records()[0]
        self.seed_records([PROMPT, ask])
        self.set_state("question", state_token="form-token")
        self.ops.statuses["worker"] = "blocked"
        self.ops.visible = "\n".join([
            "─" * 40, " Which sources should this first version cover?",
            "❯ 1. [ ] Source A", "  2. [ ] Source B", "  3. [ ] Source C", "  4. [ ] Source D", "─" * 40])
        return ask

    def esc_closes_the_form(self, *, closes=True):
        original = self.ops.herdr

        def herdr(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("agent", "send-keys") and args[3] == "esc" and closes:
                self.ops.write("session-1", self.dismissed_records()[1:], append=True)
                self.ops.statuses["worker"] = "idle"
            return result

        self.ops.herdr = herdr

    def test_relay_dismiss_form_closes_a_multiselect_form_then_prompts_the_answer(self):
        # Live 2026-10-19 (norm #330): a multi-select form needed the user to press Esc by hand.
        self.open_multiselect()
        with self.assertRaisesRegex(actions.ActionError, "--dismiss-form"):
            actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops)
        self.assertFalse(self.ops.sends)
        self.esc_closes_the_form()
        action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                               dismiss_form=True)
        self.assertEqual(self.ops.sends, [("agent", "send-keys", "worker", "esc"),
                                          ("agent", "prompt", "worker", "Sources A and C")])
        self.assertEqual(action["status"], "delivered")
        self.assertEqual(action["transport"], "dismiss")
        self.assertEqual(action["steps_sent"], ["esc", "Sources A and C"])
        self.assertEqual(actions.worker_named("worker")["state"], "running")
        # A replay with the same token returns the recorded action and sends nothing more.
        again = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                              dismiss_form=True)
        self.assertEqual(again["id"], action["id"])
        self.assertEqual(len(self.ops.sends), 2)

    def test_relay_dismiss_form_that_stays_open_fails_without_sending_the_answer(self):
        self.open_multiselect()
        self.esc_closes_the_form(closes=False)
        with mock.patch.object(actions, "DISMISS_TIMEOUT", 0.3):
            action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                                   dismiss_form=True)
        self.assertEqual(self.ops.sends, [("agent", "send-keys", "worker", "esc")])
        self.assertEqual(action["status"], "failed")
        self.assertEqual(action["steps_sent"], ["esc"])
        self.assertIn("did not close in time", action["reason"])
        failed = [event["payload"] for event in registry.read_events(0) if event["kind"] == "delivery_failed"]
        self.assertTrue(failed[-1]["partial"])
        self.assertNotIn("pending_action_id", actions.worker_named("worker"))

    def test_relay_dismiss_form_never_types_the_answer_into_a_new_session(self):
        # Review 2026-10-19: a session that changed after Esc must not receive the old question's answer.
        self.open_multiselect()
        original = self.ops.herdr

        def herdr(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:2] == ("agent", "send-keys") and args[3] == "esc":
                self.ops.sessions["worker"] = "session-2"
                self.ops.write("session-2", [PROMPT])
                self.ops.statuses["worker"] = "idle"
            return result

        self.ops.herdr = herdr
        action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                               dismiss_form=True)
        self.assertEqual(self.ops.sends, [("agent", "send-keys", "worker", "esc")])
        self.assertEqual(action["status"], "failed")
        self.assertIn("session changed", action["reason"])

    def test_relay_dismiss_form_bounds_each_read_by_its_deadline(self):
        self.open_multiselect()
        self.esc_closes_the_form()
        original = self.ops.herdr
        timeouts = []

        def slow_get(*args, **kwargs):
            if args[:2] == ("agent", "get") and self.ops.sends:
                timeouts.append(kwargs["timeout"])
                clock[0] += 20  # this read finished after the deadline
            return original(*args, **kwargs)

        clock = [1000.0]
        self.ops.herdr = slow_get
        with mock.patch.object(actions.time, "monotonic", side_effect=lambda: clock[0]):
            action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                                   dismiss_form=True)
        self.assertLessEqual(timeouts[0], actions.DISMISS_TIMEOUT)
        self.assertEqual(self.ops.sends, [("agent", "send-keys", "worker", "esc")])
        self.assertEqual(action["status"], "failed")
        self.assertIn("did not close in time", action["reason"])

    def test_relay_dismiss_form_starts_no_read_after_its_deadline(self):
        self.open_multiselect()
        self.esc_closes_the_form(closes=False)  # the form stays open
        original = self.ops.herdr
        reads = []
        clock = [1000.0]

        def timed(*args, **kwargs):
            if args[:2] == ("agent", "get") and self.ops.sends:
                reads.append((clock[0], kwargs["timeout"]))
            return original(*args, **kwargs)

        def sleep(seconds):
            clock[0] += seconds

        self.ops.herdr = timed
        with mock.patch.object(actions.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(actions.time, "sleep", side_effect=sleep):
            action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                                   dismiss_form=True)
        self.assertEqual(action["status"], "failed")
        deadline = reads[0][0] + actions.DISMISS_TIMEOUT
        self.assertTrue(all(started < deadline and 0 < timeout <= deadline - started
                            for started, timeout in reads), reads[-3:])

    def test_relay_dismiss_form_refusals(self):
        self.open_multiselect()
        # A stale token, a worker that is not on a form, or a pane no longer blocked: nothing is sent.
        with self.assertRaisesRegex(actions.ActionError, "Stale relay"):
            actions.relay("worker", "x", state_token="old", ops=self.ops, dismiss_form=True)
        self.ops.statuses["worker"] = "idle"
        with self.assertRaisesRegex(actions.ActionError, "no longer blocked"):
            actions.relay("worker", "x", state_token="form-token", ops=self.ops, dismiss_form=True)
        for state in ("ended_without_proof", "waiting_background", "done"):
            with self.subTest(state=state):
                self.set_state(state, state_token="form-token")
                with self.assertRaisesRegex(actions.ActionError, "Only an open question form"):
                    actions.relay("worker", "x", state_token="form-token", ops=self.ops, dismiss_form=True)
        self.assertFalse(self.ops.sends)
        self.assertFalse(registry.load()["actions"])

    def test_watcher_leaves_a_dismissing_relay_alone_until_it_settles(self):
        self.open_multiselect()
        self.esc_closes_the_form()
        original = self.ops.herdr
        polled = []

        def herdr(*args, **kwargs):
            # The watcher polls between the Esc and the answer.
            if args[:2] == ("agent", "prompt"):
                polled.extend(watch.poll_once(ops=self.ops, now=time.time()))
            return original(*args, **kwargs)

        self.ops.herdr = herdr
        action = actions.relay("worker", "Sources A and C", state_token="form-token", ops=self.ops,
                               dismiss_form=True)
        self.assertEqual(action["status"], "delivered")
        self.assertFalse([event for event in polled if event["kind"] in {"worker_state", "delivery_unknown"}])
        self.assertFalse(self.ops.verify_calls)

    def test_ended_worker_after_a_dismissed_form_reports_the_form(self):
        # the user pressed Esc on #330's multi-select form; the event said the final message was missing.
        for fixture in ("dismissed-multiselect-form.jsonl", "declined-compound-form-interrupt.jsonl"):
            with self.subTest(fixture=fixture):
                records = [json.loads(line) for line in
                           (FIXTURES / fixture).read_text(encoding="utf-8").splitlines()]
                self.set_state("running")
                self.ops.statuses["worker"] = "idle"
                self.seed_records([PROMPT, *records])
                watch._TRANSCRIPTS.clear()
                watch.poll_once(ops=self.ops, now=100)
                worker = actions.worker_named("worker")
                self.assertEqual(worker["state"], "ended_without_proof")
                message = worker["final_message"]
                self.assertTrue(message.startswith("The worker's form was dismissed without an answer"))
                question = records[0]["message"]["content"][0]["input"]["questions"][0]
                self.assertIn(question["question"], message)
                self.assertIn(f"1. {question['options'][0]['label']}", message)

    def test_dismissed_form_questions_decision_table(self):
        ask, rejected, marker = self.dismissed_records()
        questions = ask["message"]["content"][0]["input"]["questions"]
        answered = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        answer = copy.deepcopy(ANSWER)
        other_tool = copy.deepcopy(rejected)
        other_tool["message"]["content"][0]["tool_use_id"] = "toolu_other"
        sidechain = dict(rejected, isSidechain=True)
        for records, expected in (
            ([PROMPT, ask, rejected, marker], questions),        # dismissed, no reply since
            ([PROMPT, ask, rejected], questions),
            ([PROMPT, ask, rejected, marker, END], []),          # the worker replied afterwards
            ([PROMPT, ask], []),                                 # still open
            ([PROMPT, ASK, answer], []),                         # answered, not dismissed
            ([PROMPT, ask, other_tool, marker], []),             # a different tool was rejected
            ([PROMPT, ask, sidechain, marker], []),              # a subagent's record
            ([PROMPT, answered, rejected], []),                  # rejection of a different form id
        ):
            with self.subTest(records=[r.get("type") for r in records], expected=bool(expected)):
                self.assertEqual(transcript.dismissed_form_questions(records), expected)

    def test_relay_rechecks_the_form_on_the_records_it_sends_against(self):
        form = json.loads((FIXTURES / "multi-question-form-excerpt.jsonl").read_text(encoding="utf-8").splitlines()[0])
        single = json.loads((FIXTURES / "askuserquestion-before-answer.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.seed_records([PROMPT, single])
        self.set_state("question", state_token="form-token")
        self.ops.statuses["worker"] = "blocked"
        original = actions.refresh_session

        def changed(worker, agent, *, now=None, lane=None):
            # The single form is answered in the pane and a compound one appears before the send.
            self.ops.write("session-1", [PROMPT, form])
            return original(worker, agent, now=now, lane=lane)

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
        title = f"main: {Path(self.worker['repo_path']).name} #{self.worker['issue']}: Worker answer superseded"
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
        self.assertEqual(len(self.ops.notifications), 2)
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

    def wake_once(self, *, lane="main", sleeps=0, **options):
        if lane != "main":
            options.setdefault("context", self.seo_context)
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt) as sleep, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            code = watch.follow(wake=True, lane=lane, **options)
        self.assertEqual(sleep.call_count, sleeps)
        self.assertIsNone(registry.load()["lanes"][lane]["follow_lease"])
        return code, output.getvalue()

    def test_follow_wake_acks_only_leading_known_bookkeeping_without_printing(self):
        kinds = ("worker_starting", "worker_phase", "session_discovered", "entry_action_recorded",
                 "action_delivered", "session_changed", "watcher_slow", "holds_cleared",
                 "issue_refused", "worker_cleaned")
        for kind in kinds:
            last = registry.append_event(kind, {})
        for kind, payload in (("worker_state", {"state": "running"}),
                              ("worker_start_failed", {"state": "in_tool"}),
                              ("worker_state", {"state": "quota_wait"}),
                              ("worker_state", {"state": "awaiting_checks"}),
                              ("technical_problem", {"failed_iterations": 1}),
                              ("action_superseded", {"kind": "nudge"})):
            last = registry.append_event(kind, payload)
        with mock.patch.object(registry, "ack", wraps=registry.ack) as ack:
            self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        ack.assert_called_once_with(last, lane="main")
        current = registry.load()["lanes"]["main"]
        self.assertEqual(current["ack_seq"], last)
        self.assertNotIn("woken_through", current)

    def test_follow_wake_prints_actionable_batch_and_intervening_bookkeeping(self):
        for compact in (False, True):
            with self.subTest(compact=compact), mock.patch.dict(os.environ, {
                    "HERDR_COORD_HOME": str(Path(self.temp.name) / f"wake-{compact}")}):
                leading = registry.append_event("worker_phase", {})
                first = registry.append_event("worker_state", {"state": "question", "question_text": "A or B?"})
                registry.append_event("worker_state", {"state": "in_tool"})
                last = registry.append_event("worker_state", {"state": "done", "final_message": "Done"})
                registry.append_event("session_changed", {})
                expected = [event for event in registry.read_events(leading) if event["seq"] <= last]
                with mock.patch.object(registry, "ack", wraps=registry.ack) as ack:
                    code, output = self.wake_once(compact=compact)
                self.assertEqual(code, 0)
                ack.assert_called_once_with(leading, lane="main")
                if compact:
                    self.assertEqual([json.loads(line) for line in output.splitlines()], [
                        {"seq": first, "kind": "worker_state", "lane": "main", "state": "question", "detail": True},
                        {"seq": first + 1, "kind": "worker_state", "lane": "main", "state": "in_tool"},
                        {"seq": last, "kind": "worker_state", "lane": "main", "state": "done", "detail": True},
                    ])
                else:
                    self.assertEqual(output, "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in expected))
                current = registry.load()["lanes"]["main"]
                self.assertEqual(current["ack_seq"], leading)
                self.assertEqual(current["woken_through"], last)

    def test_follow_wake_unknown_is_reported_once_and_blocks_ack(self):
        leading = registry.append_event("worker_phase", {})
        unknown = registry.append_event("future_kind", {"state": "running"})
        registry.append_event("action_delivered", {})
        code, output = self.wake_once(compact=True)
        self.assertEqual(code, 0)
        self.assertEqual(output, json.dumps({"state": "unknown_event", "seq": unknown, "kind": "future_kind"}) + "\n")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], leading)
        self.assertEqual(registry.load()["lanes"]["main"]["woken_through"], unknown)
        with mock.patch.object(registry, "ack") as ack:
            self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        ack.assert_not_called()
        newer = registry.append_event("future_kind", {})
        code, output = self.wake_once()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output), {"state": "unknown_event", "seq": newer, "kind": "future_kind"})
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], leading)

    def test_follow_wake_does_not_rewake_or_ack_past_unhandled_actionable_events(self):
        registry.append_event("worker_state", {"state": "question"})
        previous = registry.append_event("worker_state", {"state": "done"})
        registry.append_event("worker_phase", {})
        registry.update(lambda doc: doc["lanes"]["main"].update(woken_through=previous, woken_at=time.time(),
                                                                 woken_by=None))
        with mock.patch.object(registry, "ack") as ack:
            self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        ack.assert_not_called()
        newer = registry.append_event("worker_state", {"state": "stalled"})
        with mock.patch.object(registry, "ack") as ack:
            code, output = self.wake_once()
        self.assertEqual(code, 0)
        self.assertEqual([json.loads(line)["seq"] for line in output.splitlines()], [newer])
        ack.assert_not_called()
        current = registry.load()["lanes"]["main"]
        self.assertEqual(current["ack_seq"], 0)
        self.assertEqual(current["woken_through"], newer)
        registry.ack(newer)
        trailing = registry.append_event("worker_phase", {})
        self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], trailing)

    def test_follow_wake_rewakes_an_unacked_event_after_a_pause_or_for_another_session(self):
        question = registry.append_event("worker_state", {"state": "question"})
        for woken_at, woken_by in ((time.time() - watch.WAKE_SUPPRESS_SECONDS - 1, None),
                                   (time.time(), "another-session"),
                                   (time.time() + 3600, None)):  # a clock moved back never extends suppression
            with self.subTest(woken_at=woken_at, woken_by=woken_by):
                registry.update(lambda doc: doc["lanes"]["main"].update(
                    woken_through=question, woken_at=woken_at, woken_by=woken_by))
                code, output = self.wake_once()
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(output)["seq"], question)

    def test_follow_wake_waiting_background_requires_final_message(self):
        registry.append_event("worker_state", {"state": "waiting_background"})
        empty = registry.append_event("worker_state", {"state": "waiting_background", "final_message": ""})
        self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], empty)
        asked = registry.append_event("worker_state", {"state": "waiting_background", "final_message": "A or B?"})
        code, output = self.wake_once()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["seq"], asked)
        self.assertEqual(json.loads(output)["payload"]["final_message"], "A or B?")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], empty)

    def test_follow_wake_keeps_polling_until_a_new_actionable_event(self):
        old = registry.append_event("worker_state", {"state": "question"})
        registry.update(lambda doc: doc["lanes"]["main"].update(woken_through=old, woken_at=time.time(), woken_by=None))
        arrivals = iter((("worker_phase", {}), ("worker_state", {"state": "done"})))

        def next_poll(interval):
            kind, payload = next(arrivals)
            registry.append_event(kind, payload)

        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=next_poll) as sleep, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(wake=True, interval=0.25), 0)
        self.assertEqual(sleep.call_args_list, [mock.call(0.25), mock.call(0.25)])
        self.assertEqual([json.loads(line)["seq"] for line in output.getvalue().splitlines()], [old + 2])
        current = registry.load()["lanes"]["main"]
        self.assertEqual(current["ack_seq"], 0)
        self.assertEqual(current["woken_through"], old + 2)
        self.assertIsNone(current["follow_lease"])

    def test_follow_wake_tracks_each_lane_independently(self):
        self.seo_worker()
        leading = registry.append_event("issue_refused", {}, caller_lane="main")
        private = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.assertEqual(self.wake_once(sleeps=1), (0, ""))
        code, output = self.wake_once(lane="seo")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["seq"], private)
        current = registry.load()["lanes"]
        self.assertEqual(current["main"]["ack_seq"], leading)
        self.assertNotIn("woken_through", current["main"])
        self.assertEqual(current["seo"]["ack_seq"], 0)
        self.assertEqual(current["seo"]["woken_through"], private)
        shared = registry.append_event("watcher_exit", {"detail": "stopped"})
        for lane in ("main", "seo"):
            with self.subTest(lane=lane):
                code, output = self.wake_once(lane=lane)
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(output)["seq"], shared)
                self.assertEqual(registry.load()["lanes"][lane]["woken_through"], shared)

    def test_follow_wake_stdout_failure_leaves_action_unacked_and_unwoken(self):
        for kind in ("worker_state", "future_kind"):
            with self.subTest(kind=kind), mock.patch.dict(os.environ, {
                    "HERDR_COORD_HOME": str(Path(self.temp.name) / kind)}):
                seq = registry.append_event(kind, {"state": "question"})
                for error in (BrokenPipeError("closed"), OSError("write failed"), TimeoutError("write timed out")):
                    with self.subTest(error=error), \
                            mock.patch.object(watch, "watcher_alive", return_value=True), \
                            mock.patch.object(watch, "watcher_slow", return_value=False), \
                            mock.patch.object(watch.time, "sleep", side_effect=AssertionError("must exit")), \
                            mock.patch("sys.stdout") as output:
                        output.write.side_effect = error
                        self.assertEqual(watch.follow(wake=True), 1)
                    self.assertEqual(json.loads(output.write.call_args.args[0])["seq"], seq)
                    current = registry.load()["lanes"]["main"]
                    self.assertEqual(current["ack_seq"], 0)
                    self.assertNotIn("woken_through", current)
                    self.assertIsNone(current["follow_lease"])

    def test_follow_wake_retries_wake_record_without_printing_unknown_twice(self):
        seq = registry.append_event("future_kind", {})
        update = registry.update
        attempts = []

        def contend(fn):
            if fn.__name__ == "record_wake":
                attempts.append(True)
                if len(attempts) == 1:
                    raise TimeoutError("registry busy")
            return update(fn)

        with mock.patch.object(registry, "update", side_effect=contend), \
                mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=[None, KeyboardInterrupt]) as sleep, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(wake=True, interval=0.25), 0)
        sleep.assert_called_once_with(0.25)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(registry.load()["lanes"]["main"]["woken_through"], seq)

    def test_cli_follow_wake_flag(self):
        with mock.patch.object(watch, "follow", return_value=0) as follow:
            self.assertEqual(herdr_coord.main(["follow", "--wake", "--compact", "--interval", "0.25"]), 0)
        follow.assert_called_once_with(interval=0.25, lane="main", context=self.outside_context(),
                                       wake=True, compact=True)

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
                         [{"seq": seq, "kind": "worker_state", "lane": "main", **metadata, "detail": True},
                          {"seq": bare, "kind": "session_changed", "lane": "main"}])
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
                         [{"seq": seq, "kind": "technical_problem", "lane": "main", "detail": True} for seq in range(1, 5)])

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
        self.assertEqual(set(summary), (set(payload) - {"question_text"}) | {"seq", "kind", "lane", "detail"})
        self.assertEqual(registry.read_events(0)[0]["payload"], payload)

    def test_compact_line_flags_shortening_and_always_terminates(self):
        shortened = json.loads(watch._compact_line(
            {"seq": 1, "kind": "worker_state", "payload": {"agent_name": "a" * 500, "state": "done"}}))
        self.assertTrue(shortened["detail"])
        # No string can shrink further: fall back to the minimal line instead of looping.
        stuck = watch._compact_line(
            {"seq": 2, "kind": "k" * 500, "payload": {"state_token": "t" * 32}})
        self.assertEqual(json.loads(stuck), {"seq": 2, "kind": "k" * 500, "lane": "main", "detail": True})

    def test_follow_quiet_suppresses_only_busy_states_and_ack_is_cumulative(self):
        registry.append_event("worker_state", {"state": "running"})
        question = registry.append_event("worker_state", {"state": "question", "question_text": "Pick A?"})
        registry.append_event("worker_state", {"state": "in_tool"})
        registry.append_event("worker_state", {"state": "waiting_background"})
        registry.append_event("worker_state", {"state": "waiting_background", "final_message": ""})
        registry.append_event("worker_state", {"state": "running", "final_message": "Still going"})
        asked = registry.append_event("worker_state", {"state": "waiting_background", "final_message": "A or B?"})
        phase = registry.append_event("worker_phase", {"state": "running"})
        done = registry.append_event("worker_state", {"state": "done", "final_message": "Done"})
        for compact in (False, True):
            with self.subTest(compact=compact), mock.patch.object(watch, "watcher_alive", return_value=True), mock.patch.object(watch, "watcher_slow", return_value=False), mock.patch.object(watch.time, "sleep", side_effect=[None, KeyboardInterrupt]), mock.patch.object(registry, "read_events", wraps=registry.read_events) as reader, mock.patch.object(registry, "ack") as ack, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(watch.follow(quiet=True, compact=compact), 0)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([event["seq"] for event in events], [question, asked, phase, done])
            self.assertEqual([call.args for call in reader.call_args_list], [(0,), (done,)])
            ack.assert_not_called()
            self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 0)
        registry.ack(done)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], done)
        self.assertEqual(registry.read_events(registry.load()["lanes"]["main"]["ack_seq"]), [])

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
                follow.assert_called_once_with(interval=0.5, lane="main", context=self.outside_context(),
                                               **{flag[2:]: True for flag in flags})

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
            self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 0)
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
            follow.assert_called_once_with(interval=0.5, lane="main", context=self.outside_context())
        with mock.patch.object(watch, "launch", return_value={"state": "launch_failed"}), mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["launch-watcher"]), 1)

    def follow_once(self, lane, **options):
        if lane != "main" and "context" not in options:
            options["context"] = self.seo_context
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            code = watch.follow(lane=lane, **options)
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def seo_worker(self):
        registry.create_lane("seo")
        registry.update(lambda doc: doc["workers"]["worker"].update(lane="seo", state="question"))
        self.seo_context = {"lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1",
                            "workspace_id": "w1", "controller": {
                                "agent": "claude", "kind": "id", "value": "coordinator-session"},
                            "source": "tab label"}
        self.bind_follow(self.seo_context)

    def bind_follow(self, context):
        registry.update(lambda doc: doc["tab_bindings"].update({context["tab_id"]: {
            "lane": context["lane"], "controller": dict(context["controller"]),
            "pane_id": context["pane_id"], "source": context["source"], "explicit": False}}))

    def outside_context(self):
        return {"lane": "main", "tab_id": None, "pane_id": None, "workspace_id": None,
                "controller": None, "source": "outside herdr"}

    def test_two_lane_follow_and_cli_ack_keep_main_question_48(self):
        self.seo_worker()
        registry.update_with_events(lambda doc, events: events.extend([("observed", {})] * 47))
        main = registry.append_event("worker_state", {"state": "question"})
        registry.update_with_events(lambda doc, events: events.extend([("observed", {})] * 11))
        seo = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        shared = registry.append_event("watcher_lost", {})
        self.assertEqual((main, seo), (48, 60))
        with mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=self.seo_context), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["ack", "60"]), 0)
        self.assertEqual(json.loads(output.getvalue()), {"ack_seq": 60})
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 0)
        self.assertEqual([e["seq"] for e in self.follow_once("seo")[1]], [shared])
        main_events = self.follow_once("main")[1]
        self.assertIn(main, [e["seq"] for e in main_events])
        self.assertNotIn(seo, [e["seq"] for e in main_events])
        self.assertEqual(main_events[-1]["seq"], shared)
        registry.update(lambda doc: doc["lanes"]["seo"].update(ack_seq=0))
        self.assertEqual([e["seq"] for e in self.follow_once("seo")[1]], [seo, shared])

    def test_cli_event_refuses_another_lanes_event(self):
        self.seo_worker()
        seq = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        for lane, code in (("main", 1), ("seo", 0)):
            context = dict(self.seo_context, lane=lane)
            with mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=context), \
                    mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(herdr_coord.main(["event", str(seq)]), code)
            self.assertEqual(json.loads(output.getvalue()).get("seq"), seq if code == 0 else None)

    def test_lane_compact_quiet_preserves_questions_and_repo_events(self):
        self.seo_worker()
        registry.append_event("worker_state", {"worker_id": "worker", "state": "running"})
        question = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        registry.append_event("worker_state", {"state": "question"})
        shared = registry.append_event("watcher_lost", {})
        code, events = self.follow_once("seo", compact=True, quiet=True)
        self.assertEqual(code, 0)
        self.assertEqual([e["seq"] for e in events], [question, shared])
        self.assertEqual([e["lane"] for e in events], ["seo", "seo"])

    def test_compact_handoff_carries_source_and_target_lanes(self):
        self.seo_worker()
        registry.append_event("worker_handoff", {"worker_id": "worker", "from_lane": "main", "to_lane": "seo"})
        for lane in ("main", "seo"):
            with self.subTest(lane=lane):
                code, events = self.follow_once(lane, compact=True)
                self.assertEqual(code, 0)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["lane"], lane)
                self.assertEqual(events[0]["from_lane"], "main")
                self.assertEqual(events[0]["to_lane"], "seo")
                self.assertIs(events[0]["detail"], True)

    def test_compact_unattended_carries_target_lane_separate_from_follower(self):
        self.seo_worker()
        registry.append_event("lane_unattended", {"lane": "seo"})
        code, events = self.follow_once("main", compact=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["lane"], "main")
        self.assertEqual(events[0]["target_lane"], "seo")
        self.assertIs(events[0]["detail"], True)

    def test_follow_releases_lease_when_launching_process_exits_or_is_reused(self):
        parent = {"pid": 42, "created": 1}
        seq = registry.append_event("question", {"issue": 1})
        for identity in (None, {"pid": 42, "created": 2}):
            with self.subTest(identity=identity), \
                    mock.patch.object(os, "getppid", return_value=42) as getppid, \
                    mock.patch.object(start, "_process_identity", side_effect=[parent, parent, identity]) as probe, \
                    mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}), \
                    mock.patch.object(watch.time, "time", return_value=100), \
                    mock.patch.object(watch, "watcher_alive", return_value=True), \
                    mock.patch.object(watch, "watcher_slow", return_value=False), \
                    mock.patch.object(watch.time, "sleep", side_effect=[None, KeyboardInterrupt]) as sleep, \
                    mock.patch.object(registry, "read_events", wraps=registry.read_events) as reader, \
                    mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(watch.follow(), 0)
            getppid.assert_called_once_with()
            self.assertEqual(probe.call_args_list, [mock.call(42)] * 3)
            sleep.assert_called_once_with(5)
            reader.assert_called_once_with(0, lane="main")
            lines = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(lines[0]["seq"], seq)
            self.assertEqual(lines[1:], [{"state": "stopped",
                                         "detail": "follow's launching process exited; lease released"}])
            self.assertIsNone(registry.load()["lanes"]["main"].get("follow_lease"))

    def test_follow_with_an_already_gone_launcher_takes_no_lease(self):
        with mock.patch.object(os, "getppid", return_value=42), \
                mock.patch.object(start, "_process_identity", return_value=None), \
                mock.patch.object(watch, "_claim_follow") as claim, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(), 0)
        claim.assert_not_called()
        self.assertIn("already exited", output.getvalue())
        self.assertIsNone(registry.load()["lanes"]["main"].get("follow_lease"))

    def test_follow_skips_parent_checks_when_initial_identity_is_unreadable(self):
        for identity in (OSError("access denied"),):
            with self.subTest(identity=identity), \
                    mock.patch.object(os, "getppid", return_value=42), \
                    mock.patch.object(start, "_process_identity", side_effect=[identity]) as probe, \
                    mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}), \
                    mock.patch.object(watch.time, "time", return_value=100), \
                    mock.patch.object(watch, "watcher_alive", return_value=True) as alive, \
                    mock.patch.object(watch, "watcher_slow", return_value=False), \
                    mock.patch.object(watch.time, "sleep", side_effect=[None, None, KeyboardInterrupt]) as sleep, \
                    mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(watch.follow(), 0)
            probe.assert_called_once_with(42)
            self.assertEqual(alive.call_count, 3)
            self.assertEqual(sleep.call_count, 3)
            self.assertEqual(output.getvalue(), "")
            self.assertIsNone(registry.load()["lanes"]["main"].get("follow_lease"))

    def test_follow_treats_parent_check_oserror_as_alive_and_checks_again(self):
        parent = {"pid": 42, "created": 1}
        with mock.patch.object(os, "getppid", return_value=42), \
                mock.patch.object(start, "_process_identity", side_effect=[parent, OSError("access denied"), parent, None]) as probe, \
                mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}), \
                mock.patch.object(watch.time, "time", return_value=100), \
                mock.patch.object(watch, "watcher_alive", return_value=True) as alive, \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=[None, None, KeyboardInterrupt]) as sleep, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(), 0)
        self.assertEqual(probe.call_args_list, [mock.call(42)] * 4)
        self.assertEqual(alive.call_count, 2)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(json.loads(output.getvalue())["state"], "stopped")
        self.assertIsNone(registry.load()["lanes"]["main"].get("follow_lease"))

    def test_follow_releases_lease_when_parent_stopped_line_cannot_be_written(self):
        for error in (BrokenPipeError("reader closed"), OSError("write failed")):
            with self.subTest(error=error), \
                    mock.patch.object(os, "getppid", return_value=42), \
                    mock.patch.object(start, "_process_identity", side_effect=[{"pid": 42, "created": 1}, None]), \
                    mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}), \
                    mock.patch.object(watch, "watcher_alive", return_value=True) as alive, \
                    mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt) as sleep, \
                    mock.patch("sys.stdout") as output:
                output.write.side_effect = error
                self.assertEqual(watch.follow(), 0)
            output.write.assert_called_once()
            alive.assert_not_called()
            sleep.assert_not_called()
            self.assertIsNone(registry.load()["lanes"]["main"].get("follow_lease"))

    def test_follow_stdout_failure_returns_one_releases_lease_and_leaves_events_unacked(self):
        seq = registry.append_event("question", {"issue": 1})
        registry.append_event("done", {"issue": 2})
        expected = registry.read_events(0)
        for compact in (False, True):
            for error in (BrokenPipeError("reader closed"), OSError("write failed"), TimeoutError("write timed out")):
                with self.subTest(compact=compact, error=error), \
                        mock.patch.object(os, "getppid", return_value=42), \
                        mock.patch.object(start, "_process_identity", return_value={"pid": 42, "created": 1}), \
                        mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}), \
                        mock.patch.object(watch, "watcher_alive", return_value=True), \
                        mock.patch.object(watch, "watcher_slow", return_value=False), \
                        mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt) as sleep, \
                        mock.patch.object(registry, "ack") as ack, \
                        mock.patch("sys.stdout") as output:
                    output.write.side_effect = error
                    self.assertEqual(watch.follow(compact=compact), 1)
                output.write.assert_called_once()
                self.assertEqual(json.loads(output.write.call_args.args[0])["seq"], seq)
                sleep.assert_not_called()
                ack.assert_not_called()
                current = registry.load()["lanes"]["main"]
                self.assertIsNone(current.get("follow_lease"))
                self.assertEqual(current["ack_seq"], 0)
                self.assertEqual(registry.read_events(current["ack_seq"]), expected)

    def test_follow_lease_refuses_second_then_releases(self):
        self.seo_worker()
        lease = watch._claim_follow("seo", now=100, context=self.seo_context)
        self.assertEqual(lease["pid"], os.getpid())
        self.assertIn("process_created", lease)
        self.assertEqual(lease["tab_id"], self.seo_context["tab_id"])
        self.assertEqual(lease["controller"], self.seo_context["controller"])
        with mock.patch.object(watch.time, "time", return_value=101):
            code, events = self.follow_once("seo")
        self.assertEqual(code, 1)
        self.assertIn(str(lease["pid"]), events[0]["detail"])
        self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], lease)
        self.assertEqual(self.follow_once("main")[0], 0)
        watch._release_follow("seo", lease)
        self.assertEqual(self.follow_once("seo")[0], 0)
        self.assertIsNone(registry.load()["lanes"]["seo"]["follow_lease"])

    def test_cli_follow_passes_resolved_context(self):
        self.seo_worker()
        with mock.patch.object(lanes, "resolve_context", return_value=self.seo_context), \
                mock.patch.object(watch, "follow", return_value=0) as follow:
            self.assertEqual(herdr_coord.main(["follow"]), 0)
        follow.assert_called_once_with(interval=5, lane="seo", context=self.seo_context)

    def test_follow_claim_refuses_a_live_lease_from_another_tab_and_controller(self):
        self.seo_worker()
        owner = start._start_owner()
        lease = {"pid": owner["pid"], "process_created": owner["created"], "tab_id": "w2:t1",
                 "controller": {"agent": "claude", "kind": "id", "value": "other-session"}}
        registry.update(lambda doc: doc["lanes"]["seo"].update(follow_lease=lease))
        watch._follow_heartbeat("seo", lease, now=100)
        with self.assertRaisesRegex(ValueError, "already has follow running"):
            watch._claim_follow("seo", now=101, context=self.seo_context)
        self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], lease)

    def test_follow_claim_requires_its_exact_binding(self):
        self.seo_worker()
        for change in ("tab", "controller", "lane", "missing", "context lane"):
            with self.subTest(change=change):
                self.bind_follow(self.seo_context)
                context = dict(self.seo_context)

                def move(doc):
                    binding = doc["tab_bindings"][context["tab_id"]]
                    if change == "tab":
                        doc["tab_bindings"]["w2:t1"] = doc["tab_bindings"].pop(context["tab_id"])
                    elif change == "controller":
                        binding["controller"]["value"] = "other-session"
                    elif change == "lane":
                        binding["lane"] = "main"
                    elif change == "missing":
                        del doc["tab_bindings"][context["tab_id"]]

                registry.update(move)
                if change == "context lane":
                    context["lane"] = "main"
                before = registry.load()
                with self.assertRaisesRegex(ValueError, "lane binding moved; restart follow from the owning tab"):
                    watch._claim_follow("seo", now=100, context=context)
                self.assertEqual(registry.load(), before)
                self.assertFalse((registry._home() / "follow-seo.json").exists())
                registry.update(lambda doc: doc["tab_bindings"].clear())

    def follow_to_refresh(self, context, change):
        sleeps = []

        def advance(_):
            if sleeps:
                raise KeyboardInterrupt
            sleeps.append(True)
            change()
            clock.return_value = 130

        with mock.patch.object(watch.time, "time", return_value=100) as clock, \
                mock.patch.object(watch.time, "sleep", side_effect=advance), \
                mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            code = watch.follow(lane=context["lane"] if context else "main", context=context)
        return code, output.getvalue()

    def test_follow_refresh_releases_and_reports_a_moved_binding(self):
        self.seo_worker()
        for change in ("lane", "controller", "tab"):
            with self.subTest(change=change):
                self.bind_follow(self.seo_context)

                def move():
                    def update(doc):
                        binding = doc["tab_bindings"][self.seo_context["tab_id"]]
                        if change == "lane":
                            binding["lane"] = "main"
                        elif change == "controller":
                            binding["controller"]["value"] = "other-session"
                        else:
                            doc["tab_bindings"]["w2:t1"] = doc["tab_bindings"].pop(self.seo_context["tab_id"])
                    registry.update(update)

                code, output = self.follow_to_refresh(self.seo_context, move)
                self.assertEqual(code, 1)
                self.assertIn("lane binding moved; restart follow from the owning tab", output)
                self.assertIsNone(registry.load()["lanes"]["seo"]["follow_lease"])
                self.snapshot.assert_called_with()
                registry.update(lambda doc: doc["tab_bindings"].clear())

    def test_follow_refresh_proven_absence_releases_but_unknown_keeps_lease(self):
        self.seo_worker()
        for snapshot, alive in ((None, True),
                                ({"tab_ids": set(), "controller_counts": {"coordinator-session": 1}}, True),
                                ({"tab_ids": {"w1:t1"}, "controller_counts": {}}, False)):
            with self.subTest(snapshot=snapshot):
                lease = watch._claim_follow("seo", now=100, context=self.seo_context)
                with mock.patch.object(registry, "update", wraps=registry.update) as update:
                    def read():
                        update.assert_not_called()
                        return snapshot

                    with mock.patch.object(lanes, "read_snapshot", side_effect=read) as reader:
                        if alive:
                            self.assertTrue(watch._refresh_follow("seo", lease, now=130))
                        else:
                            with self.assertRaisesRegex(ValueError, "controller absent.*restart follow"):
                                watch._refresh_follow("seo", lease, now=130)
                    reader.assert_called_once_with()
                self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], lease if alive else None)
                beat = json.loads((registry._home() / "follow-seo.json").read_text(encoding="utf-8"))
                self.assertEqual(beat, {**lease, "ts": 130 if alive else 100})
                watch._release_follow("seo", lease)

    def test_background_follow_exits_when_its_controller_pane_closes(self):
        self.seo_worker()
        ops = LaneOps()
        ops.caller("w1", "boon-town", tab_label="seo", session="coordinator-session")

        def close_pane():
            ops.panes["result"]["panes"] = [pane for pane in ops.panes["result"]["panes"]
                                               if pane["agent_session"]["value"] != "coordinator-session"]

        with mock.patch.object(lanes, "read_snapshot", wraps=self.read_snapshot) as snapshot, \
                mock.patch.object(watch.adapters, "herdr", side_effect=ops.herdr):
            code, output = self.follow_to_refresh(self.seo_context, close_pane)
        self.assertEqual(code, 1)
        self.assertIn("controller absent", output)
        self.assertIn("lane binding moved; restart follow from the owning tab", output)
        self.assertIsNone(registry.load()["lanes"]["seo"]["follow_lease"])
        snapshot.assert_called_once_with()
        self.assertEqual([args for args, timeout in ops.calls], [("tab", "list"), ("pane", "list")])

    def test_outside_follow_keeps_pid_only_main_and_rejects_other_lanes(self):
        for context in (None, self.outside_context()):
            with self.subTest(context=context):
                self.assertEqual(self.follow_once("main", context=context)[0], 0)
                beat = json.loads((registry._home() / "follow-main.json").read_text(encoding="utf-8"))
                self.assertEqual(set(beat), {"pid", "process_created", "ts"})
                registry.create_lane("seo")
                code, events = self.follow_once("seo", context=context)
                self.assertEqual(code, 1)
                self.assertIn("main", events[0]["detail"])

    def test_outside_follow_without_main_binding_never_reads_herdr(self):
        self.seo_worker()
        ops = LaneOps()
        ops.reader_errors[("tab", "list")] = TimeoutError("herdr unavailable")
        ops.reader_errors[("pane", "list")] = TimeoutError("herdr unavailable")
        for context in (None, self.outside_context()):
            with self.subTest(context=context), \
                    mock.patch.object(lanes, "read_snapshot", wraps=self.read_snapshot) as snapshot, \
                    mock.patch.object(watch.adapters, "herdr", side_effect=ops.herdr) as herdr:
                code, output = self.follow_to_refresh(context, lambda: None)
                self.assertEqual(code, 0)
                self.assertEqual(output, "")
                snapshot.assert_not_called()
                herdr.assert_not_called()
            beat = json.loads((registry._home() / "follow-main.json").read_text(encoding="utf-8"))
            self.assertEqual(beat["ts"], 130)

    def test_outside_follow_shortcut_rechecks_main_binding_under_lock(self):
        self.seo_worker()
        self.bind_follow(dict(self.seo_context, lane="main"))
        binding = registry.load()["tab_bindings"][self.seo_context["tab_id"]]
        original = registry.update
        for operation in ("claim", "refresh"):
            with self.subTest(operation=operation):
                self.snapshot.reset_mock()
                registry.update(lambda doc: doc["tab_bindings"].clear())
                lease = watch._claim_follow("main", now=100) if operation == "refresh" else None

                def acquire_first(change):
                    original(lambda doc: doc["tab_bindings"].update({self.seo_context["tab_id"]: binding}))
                    return original(change)

                with mock.patch.object(registry, "update", side_effect=acquire_first), \
                        self.assertRaisesRegex(ValueError, "Lane main is owned by tab w1:t1"):
                    if operation == "claim":
                        watch._claim_follow("main", now=130)
                    else:
                        watch._refresh_follow("main", lease, now=130)
                self.snapshot.assert_called_once_with()
                self.assertIsNone(registry.load()["lanes"]["main"]["follow_lease"])

    def test_outside_follow_retries_main_binding_added_after_snapshot(self):
        self.seo_worker()
        owner = dict(self.seo_context, lane="main")
        stale = dict(owner, tab_id="old-tab", controller=dict(owner["controller"], value="departed"))
        for operation in ("claim", "refresh"):
            with self.subTest(operation=operation):
                registry.update(lambda doc: doc["tab_bindings"].clear())
                self.bind_follow(stale)
                self.snapshot.return_value = {"tab_ids": set(), "controller_counts": {}}
                lease = watch._claim_follow("main", now=100) if operation == "refresh" else None
                reads = []

                def snapshot():
                    reads.append(True)
                    if len(reads) == 1:
                        self.bind_follow(owner)
                        return {"tab_ids": set(), "controller_counts": {}}
                    return {"tab_ids": {owner["tab_id"]},
                            "controller_counts": {owner["controller"]["value"]: 1}}

                with mock.patch.object(lanes, "read_snapshot", side_effect=snapshot), \
                        mock.patch.object(watch, "_follow_heartbeat", wraps=watch._follow_heartbeat) as beat:
                    with self.assertRaisesRegex(ValueError, "Lane main is owned by tab w1:t1"):
                        if operation == "claim":
                            watch._claim_follow("main", now=130)
                        else:
                            watch._refresh_follow("main", lease, now=130)
                    beat.assert_not_called()
                self.assertEqual(len(reads), 2)
                self.assertIsNone(registry.load()["lanes"]["main"]["follow_lease"])

    def test_outside_follow_stops_after_three_main_binding_changes(self):
        self.seo_worker()
        stale = dict(self.seo_context, lane="main", tab_id="old-tab",
                     controller=dict(self.seo_context["controller"], value="departed"))
        for operation in ("claim", "refresh"):
            with self.subTest(operation=operation):
                registry.update(lambda doc: doc["tab_bindings"].clear())
                self.bind_follow(stale)
                self.snapshot.return_value = {"tab_ids": set(), "controller_counts": {}}
                lease = watch._claim_follow("main", now=100) if operation == "refresh" else None
                reads = []

                def snapshot():
                    reads.append(True)
                    registry.update(lambda doc: doc["tab_bindings"]["old-tab"].update(label_seen=str(len(reads))))
                    return {"tab_ids": set(), "controller_counts": {}}

                with mock.patch.object(lanes, "read_snapshot", side_effect=snapshot), \
                        mock.patch.object(watch, "_follow_heartbeat") as beat:
                    with self.assertRaisesRegex(ValueError, "Main lane bindings changed during herdr snapshot; "
                                                + ("retry follow" if operation == "claim" else "stopping follow")):
                        if operation == "claim":
                            watch._claim_follow("main", now=130)
                        else:
                            watch._refresh_follow("main", lease, now=130)
                    beat.assert_not_called()
                self.assertEqual(len(reads), 3)
                self.assertIsNone(registry.load()["lanes"]["main"]["follow_lease"])

    def test_outside_follow_claim_guard_checks_main_controller_liveness(self):
        self.seo_worker()
        owner = dict(self.seo_context, lane="main")
        self.bind_follow(owner)
        for snapshot, allowed in ((None, False),
                                  ({"tab_ids": set(), "controller_counts": {"coordinator-session": 1}}, False),
                                  ({"tab_ids": {"w1:t1"}, "controller_counts": {}}, True)):
            for context in (None, self.outside_context()):
                with self.subTest(snapshot=snapshot, context=context), \
                        mock.patch.object(lanes, "read_snapshot", return_value=snapshot):
                    code, events = self.follow_once("main", context=context)
                self.assertEqual(code, 0 if allowed else 1)
                if not allowed:
                    self.assertIn("snapshot" if snapshot is None else "w1:t1", events[0]["detail"])
                self.assertIsNone(registry.load()["lanes"]["main"]["follow_lease"])

    def test_outside_follow_exits_when_main_gets_an_owner_or_snapshot_is_unknown(self):
        self.seo_worker()
        for snapshot in (self.snapshot.return_value, None):
            for context in (None, self.outside_context()):
                with self.subTest(snapshot=snapshot, context=context):
                    registry.update(lambda doc: doc["tab_bindings"].clear())

                    def acquire():
                        self.bind_follow(dict(self.seo_context, lane="main"))
                        self.snapshot.return_value = snapshot

                    code, output = self.follow_to_refresh(context, acquire)
                    self.assertEqual(code, 1)
                    self.assertIn("snapshot" if snapshot is None else "w1:t1", output)
                    self.assertIsNone(registry.load()["lanes"]["main"]["follow_lease"])

    def test_follow_lease_dead_reused_and_stale_holders_are_taken_over(self):
        self.seo_worker()
        for identity, now in ((None, 101), ({"pid": 42, "created": 2}, 101),
                              ({"pid": 42, "created": 1}, 220),
                              ({"pid": 42, "created": 1}, 221)):
            with self.subTest(identity=identity, now=now):
                old = {"pid": 42, "process_created": 1, "tab_id": self.seo_context["tab_id"],
                       "controller": self.seo_context["controller"]}
                registry.update(lambda doc: doc["lanes"]["seo"].update(follow_lease=old))
                watch._follow_heartbeat("seo", old, now=100)
                with mock.patch.object(start, "_process_identity", return_value=identity):
                    self.assertFalse(watch.follower_alive("seo", old, now=now))
                    with mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 3}):
                        lease = watch._claim_follow("seo", now=now, context=self.seo_context)
                self.assertEqual(lease, {**old, "pid": 43, "process_created": 3})
                watch._release_follow("seo", old)
                self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], lease)

    def test_fresh_follower_with_inaccessible_process_stays_live_and_refuses_second(self):
        self.seo_worker()
        lease = watch._claim_follow("seo", now=100, context=self.seo_context)
        with mock.patch.object(start, "_process_identity", side_effect=OSError("access denied")), \
                mock.patch.object(start, "_start_owner", return_value={"pid": 43, "created": 2}):
            self.assertTrue(watch.follower_alive("seo", lease, now=101))
            with self.assertRaisesRegex(ValueError, "already has follow running"):
                watch._claim_follow("seo", now=101, context=self.seo_context)
        self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], lease)

    def test_follow_heartbeats_are_atomic_and_do_not_write_registry(self):
        self.seo_worker()
        lease = watch._claim_follow("seo", now=100, context=self.seo_context)
        path = registry._home() / "registry.json"
        before = (path.read_bytes(), path.stat().st_mtime_ns)
        with mock.patch.object(registry, "replace_with_retry", wraps=registry.replace_with_retry) as replace:
            self.assertTrue(watch._refresh_follow("seo", lease, now=130))
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
        self.assertEqual(replace.call_args.args[1], registry._home() / "follow-seo.json")
        self.assertEqual(json.loads((registry._home() / "follow-seo.json").read_text(encoding="utf-8")),
                         {**lease, "ts": 130})
        self.assertEqual(list(registry._home().glob("follow-*.tmp")), [])
        self.assertTrue(watch.follower_alive("seo", lease, now=249))
        self.assertFalse(watch.follower_alive("seo", lease, now=250))

    def test_follow_refreshes_at_30_seconds_and_cannot_clear_a_successor(self):
        self.seo_worker()
        beats = []
        ticks = iter([100, 129, 130, 159])
        with mock.patch.object(watch.time, "time", side_effect=lambda: next(ticks)), \
                mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=[None, None, None, KeyboardInterrupt]), \
                mock.patch.object(watch, "_follow_heartbeat", side_effect=lambda lane, lease, *, now: beats.append(now)):
            self.assertEqual(watch.follow(lane="seo", context=self.seo_context), 0)
        self.assertEqual(beats, [100, 130])
        lease = watch._claim_follow("seo", now=200, context=self.seo_context)
        successor = {**lease, "pid": 43, "process_created": 3}
        registry.update(lambda doc: doc["lanes"]["seo"].update(follow_lease=successor))
        self.assertFalse(watch._refresh_follow("seo", lease, now=230))
        watch._release_follow("seo", lease)
        self.assertEqual(registry.load()["lanes"]["seo"]["follow_lease"], successor)

    def test_status_uses_follow_lease_liveness(self):
        self.seo_worker()
        watch._claim_follow("seo", now=100, context=self.seo_context)
        for now, expected in ((101, "live"), (220, "absent")):
            with mock.patch.object(watch.time, "time", return_value=now), \
                    mock.patch.object(watch, "watcher_alive", return_value=False), \
                    mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(herdr_coord.main(["status"]), 0)
            self.assertIn(f"lane: seo\tfollow={expected}\tunhandled=0", output.getvalue())

    def unattended_poll(self, now):
        with mock.patch.object(watch, "_poll_worker"), mock.patch.object(watch, "_drain"):
            return watch.poll_once(ops=self.ops, now=now)

    def test_unattended_alert_fires_once_per_actionable_backlog_and_ack_clears(self):
        self.seo_worker()
        question = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.unattended_poll(100)
        self.assertEqual(registry.load()["lanes"]["seo"]["unattended_since"], 100)
        self.assertEqual(self.unattended_poll(999), [])
        first = self.unattended_poll(100 + 15 * 60)
        self.assertEqual([e["kind"] for e in first], ["lane_unattended"])
        self.assertEqual(first[0]["scope"], "repo")
        self.assertEqual(first[0]["payload"]["lane"], "seo")
        self.assertEqual(registry.load()["lanes"]["seo"]["unattended_alerted_seq"], question)
        self.assertEqual(self.unattended_poll(100 + 26 * 60), [])
        self.assertEqual(self.unattended_poll(100 + 77 * 60), [])
        registry.ack(question, lane="seo")
        self.assertEqual(self.unattended_poll(100 + 138 * 60), [])
        lane = registry.load()["lanes"]["seo"]
        self.assertIsNone(lane["unattended_since"])
        self.assertIsNone(lane["last_alert_at"])
        self.assertEqual(sum("seo" in n[2] and "unattended" in n[2] for n in self.ops.notifications), 1)

    def test_all_bookkeeping_backlog_never_makes_lane_unattended(self):
        self.seo_worker()
        for kind in sorted(registry.BOOKKEEPING_EVENT_KINDS - {"watcher_slow"}):
            registry.append_event(kind, {"worker_id": "worker"})
        for state in ("running", "in_tool", "starting", "waiting_background", "awaiting_checks"):
            registry.append_event("worker_state", {"worker_id": "worker", "state": state})
        registry.append_event("technical_problem", {"worker_id": "worker", "failed_iterations": 1})
        registry.append_event("action_superseded", {"worker_id": "worker", "kind": "nudge"})
        registry.update(lambda doc: doc["lanes"]["seo"].update(unattended_since=1, last_alert_at=1))
        for now in (100, 1000, 5000):
            self.assertEqual(self.unattended_poll(now), [])
        lane = registry.load()["lanes"]["seo"]
        self.assertIsNone(lane["unattended_since"])
        self.assertIsNone(lane["last_alert_at"])
        self.assertFalse(self.ops.notifications)

    def test_newer_actionable_event_alerts_again_but_bookkeeping_does_not(self):
        self.seo_worker()
        registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.unattended_poll(100)
        self.assertEqual([e["kind"] for e in self.unattended_poll(1000)], ["lane_unattended"])
        registry.append_event("session_changed", {"worker_id": "worker"})
        registry.append_event("worker_state", {"worker_id": "worker", "state": "running"})
        self.assertEqual(self.unattended_poll(5000), [])
        newer = registry.append_event("worker_state", {"worker_id": "worker", "state": "done"})
        self.assertEqual([e["kind"] for e in self.unattended_poll(5001)], ["lane_unattended"])
        self.assertEqual(registry.load()["lanes"]["seo"]["unattended_alerted_seq"], newer)
        self.assertEqual(self.unattended_poll(9000), [])

    def test_unknown_lane_event_without_worker_id_counts_as_actionable_for_unattended(self):
        unknown = registry.append_event("future_action_needed", {})
        self.unattended_poll(100)
        events = self.unattended_poll(1000)
        self.assertEqual([e["kind"] for e in events], ["lane_unattended"])
        self.assertEqual(events[0]["payload"]["lane"], "main")
        self.assertEqual(registry.load()["lanes"]["main"]["unattended_alerted_seq"], unknown)
        self.assertEqual(self.unattended_poll(5000), [])

    def test_live_follow_clears_timer_and_a_later_lapse_alerts_again(self):
        self.seo_worker()
        question = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.unattended_poll(100)
        self.assertEqual([e["kind"] for e in self.unattended_poll(1000)], ["lane_unattended"])
        lease = watch._claim_follow("seo", now=1001, context=self.seo_context)
        # Simulate the live follower arriving after the timer was set by an earlier poll.
        registry.update(lambda doc: doc["lanes"]["seo"].update(unattended_since=100))
        self.assertEqual(self.unattended_poll(1002), [])
        lane = registry.load()["lanes"]["seo"]
        self.assertIsNone(lane["unattended_since"])
        self.assertNotIn("unattended_alerted_seq", lane)  # attended again: a later lapse alerts afresh
        watch._release_follow("seo", lease)
        self.assertEqual(self.unattended_poll(1100), [])
        self.assertEqual([e["kind"] for e in self.unattended_poll(2000)], ["lane_unattended"])
        self.assertEqual(registry.load()["lanes"]["seo"]["unattended_alerted_seq"], question)
        self.assertEqual(self.unattended_poll(5000), [])

    def test_old_question_with_recently_departed_follower_is_not_unattended(self):
        self.seo_worker()
        registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.unattended_poll(100)
        watch._claim_follow("seo", now=1000, context=self.seo_context)
        self.unattended_poll(1001)
        self.assertIsNone(registry.load()["lanes"]["seo"]["unattended_since"])
        lease = registry.load()["lanes"]["seo"]["follow_lease"]
        watch._release_follow("seo", lease)
        self.assertEqual(self.unattended_poll(1060), [])
        self.assertEqual(registry.load()["lanes"]["seo"]["unattended_since"], 1060)

    def test_repo_events_never_make_a_lane_unattended_even_when_herdr_is_down(self):
        self.seo_worker()
        registry.append_event("watcher_slow", {"detail": "slow"})
        registry.append_event("lane_unattended", {"lane": "main"})
        self.ops.reachable = False
        self.unattended_poll(100)
        self.unattended_poll(1060)
        self.assertIsNone(registry.load()["lanes"]["seo"]["unattended_since"])
        self.assertIsNone(registry.load()["lanes"]["seo"]["last_alert_at"])

    def test_unattended_checks_run_when_herdr_is_unreachable(self):
        self.seo_worker()
        registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.ops.reachable = False
        self.unattended_poll(100)
        self.assertEqual([e["kind"] for e in self.unattended_poll(1060)], ["lane_unattended"])

    def test_notification_lane_uses_event_routing_and_shared_notice_is_sent_once(self):
        self.seo_worker()
        registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        registry.update(lambda doc: doc["workers"]["worker"].update(lane="main"))
        registry.append_event("watcher_exit", {"detail": "stopped"})
        watch._notify_events(self.ops)
        watch._notify_events(self.ops)
        self.assertEqual(len(self.ops.notifications), 2)
        self.assertTrue(self.ops.notifications[0][2].startswith("seo: "))
        self.assertIn("watcher stopped", self.ops.notifications[1][2])
        self.assertEqual(registry.load()["notification_seq"], 2)

    def test_pre_upgrade_worker_notification_names_main_after_worker_moves(self):
        self.seo_worker()
        event = {"seq": 1, "kind": "worker_state", "payload": {"worker_id": "worker", "state": "question"}}
        title, _ = watch._notification(event, actions.worker_named("worker"))
        self.assertTrue(title.startswith("main: "))

    def test_follower_liveness_requires_a_matching_readable_heartbeat(self):
        self.seo_worker()
        lease = watch._claim_follow("seo", now=100, context=self.seo_context)
        path = registry._home() / "follow-seo.json"
        for data in ("{}", "null", "[]", "invalid", json.dumps({**lease, "pid": 42, "ts": 100}),
                     json.dumps({**lease, "tab_id": "w2:t1", "ts": 100}),
                     json.dumps({**lease, "controller": {**lease["controller"], "value": "other"}, "ts": 100})):
            with self.subTest(data=data):
                path.write_text(data, encoding="utf-8")
                self.assertFalse(watch.follower_alive("seo", lease, now=101))
        path.unlink()
        self.assertFalse(watch.follower_alive("seo", lease, now=101))

    def test_unattended_rechecks_ack_and_follow_claim_under_the_update_lock(self):
        self.seo_worker()
        question = registry.append_event("worker_state", {"worker_id": "worker", "state": "question"})
        self.unattended_poll(100)
        original = registry.update_with_events

        def racing(change, **kwargs):
            with mock.patch.object(registry, "update_with_events", original):
                registry.ack(question, lane="seo")
            return original(change, **kwargs)

        with mock.patch.object(registry, "update_with_events", side_effect=racing):
            watch._check_unattended(1060)
        self.assertEqual([e["kind"] for e in registry.read_events(question, lane=None)], [])
        registry.update(lambda doc: doc["lanes"]["seo"].update(ack_seq=0, unattended_since=100))

        def claim_first(change, **kwargs):
            with mock.patch.object(registry, "update_with_events", original):
                watch._claim_follow("seo", now=1060, context=self.seo_context)
            return original(change, **kwargs)

        with mock.patch.object(registry, "update_with_events", side_effect=claim_first):
            watch._check_unattended(1060)
        self.assertEqual([e["kind"] for e in registry.read_events(question, lane=None)], [])
        self.assertIsNone(registry.load()["lanes"]["seo"]["unattended_since"])

    def test_refresh_session_updates_workspace_and_pane_with_or_without_session_change(self):
        for session in ("session-1", "session-2", None):
            with self.subTest(session=session):
                worker = actions.worker_named("worker")
                agent = {"workspace_id": "new-workspace", "pane_id": "new-pane"}
                if session:
                    agent["agent_session"] = {"value": session}
                current = actions.refresh_session(worker, agent, now=100)
                self.assertEqual(current["workspace_id"], "new-workspace")
                self.assertEqual(current["pane_id"], "new-pane")
                self.assertEqual(registry.load()["workers"]["worker"], current)
                registry.update(lambda doc: doc["workers"]["worker"].update(workspace_id="old", pane_id="old"))


if __name__ == "__main__":
    unittest.main()
