"""Regressions for defects reported by live coordinators on 2026-10-07."""

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import actions  # noqa: E402
import finish  # noqa: E402
import registry  # noqa: E402
import start  # noqa: E402
import watch  # noqa: E402
import test_actions as action_fixtures  # noqa: E402
import test_finish as finish_fixtures  # noqa: E402
import test_transcript as transcript_fixtures  # noqa: E402


LONG = ("Confirmed, write the requirements-only plan, with these changes. "
        "(1) Eval: three strata reported separately. (2) Keep the keyword slices.")


def user(content):
    return {"type": "user", "isSidechain": False, "message": {"role": "user", "content": content}}


def pasted(text, paste_id="bc16"):
    # Shape copied from norm-290's transcript record 213 (2026-10-07).
    return f'\n\n<pasted_content id="{paste_id}">\n{text}\n</pasted_content id="{paste_id}">\n'


class PromptRelayConfirmationTests(unittest.TestCase):
    def action(self, text=LONG, position=1):
        return {"text": text, "transport": "prompt", "transcript_position": position}

    def test_pasted_long_relay_is_confirmed(self):
        records = [user("earlier"), user(pasted(LONG))]
        self.assertTrue(actions._confirmed(self.action(), records))

    def test_pasted_relay_in_text_block_is_confirmed(self):
        records = [user("earlier"), user([{"type": "text", "text": pasted(LONG)}])]
        self.assertTrue(actions._confirmed(self.action(), records))

    def test_short_relay_still_matches_exactly(self):
        records = [user("earlier"), user("yes")]
        self.assertTrue(actions._confirmed(self.action("yes"), records))
        self.assertFalse(actions._confirmed(self.action("no"), records))

    def test_different_pasted_text_or_earlier_record_is_not_confirmed(self):
        self.assertFalse(actions._confirmed(self.action(), [user("x"), user(pasted(LONG + " extra"))]))
        self.assertFalse(actions._confirmed(self.action(position=1), [user(pasted(LONG)), user("later")]))

    def test_paste_quoted_inside_a_longer_prompt_is_not_a_relay(self):
        records = [user("x"), user("Earlier I tried to send this:" + pasted(LONG) + "and it failed.")]
        self.assertFalse(actions._confirmed(self.action(), records))

    def test_paste_after_drews_unsent_draft_is_confirmed(self):
        # Producer capture from norm-308 (2026-10-09): "ok, go with your recommendations." was
        # in the pane's input when the relay pasted, and both went out as one prompt.
        path = Path(__file__).parent / "fixtures" / "draft-plus-paste-prompt.jsonl"
        record = json.loads(path.read_text(encoding="utf-8"))
        content = record["message"]["content"]
        self.assertTrue(content.startswith("ok, go with your recommendations."))
        text = actions._PASTED_BLOCK.search(content).group(1).strip()
        self.assertTrue(actions._confirmed(self.action(text), [user("x"), record]))
        self.assertFalse(actions._confirmed(self.action(text + " extra"), [user("x"), record]))

    def test_trailing_paste_must_close_the_prompt_and_be_the_last_paste(self):
        draft = "ok, go ahead."
        self.assertTrue(actions._confirmed(self.action(), [user("x"), user(draft + pasted(LONG))]))
        # Text after the paste makes it a quote.
        self.assertFalse(actions._confirmed(self.action(), [user("x"), user(draft + pasted(LONG) + "thoughts?")]))
        # Only the last paste can be the relay.
        two = draft + pasted(LONG, "aa11") + pasted("something else", "bb22")
        self.assertFalse(actions._confirmed(self.action(), [user("x"), user(two)]))
        two = draft + pasted("something else", "aa11") + pasted(LONG, "bb22")
        self.assertTrue(actions._confirmed(self.action(), [user("x"), user(two)]))
        # The relay text may itself mention the tag.
        literal = "mention <pasted_content> literally"
        self.assertTrue(actions._confirmed(self.action(literal), [user("x"), user(draft + pasted(literal))]))

    def test_tool_result_is_never_a_relay(self):
        record = user([{"type": "tool_result", "tool_use_id": "t", "content": pasted(LONG)}])
        self.assertFalse(actions._confirmed(self.action(), [user("x"), record]))


class DeclinedFormTests(unittest.TestCase):
    def test_declined_form_string_result_does_not_crash(self):
        # Producer capture from norm-291 (2026-10-07): toolUseResult "User rejected tool use".
        path = Path(__file__).parent / "fixtures" / "declined-form-excerpt.jsonl"
        records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertIsInstance(records[-1]["toolUseResult"], str)
        for text in ("1", "free text"):
            self.assertFalse(actions._form_answered({"text": text}, records))


class PollIsolationTests(unittest.TestCase):
    def test_one_worker_error_does_not_stop_polling_the_others(self):
        from unittest import mock
        import watch
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HERDR_COORD_HOME": home}):
            registry.update(lambda doc: doc["workers"].update({
                "bad": {"worker_id": "bad", "issue": 1, "state": "running"},
                "good": {"worker_id": "good", "issue": 2, "state": "running"}}))
            polled = []

            def poll(worker, *args):
                polled.append(worker["worker_id"])
                if worker["worker_id"] == "bad":
                    raise AttributeError("'str' object has no attribute 'get'")

            ops = mock.Mock()
            ops.herdr_reachable.return_value = True
            with mock.patch.object(watch, "_poll_worker", side_effect=poll), \
                    mock.patch.object(watch, "_drain"), mock.patch.object(watch, "_notify_events"):
                events = watch.poll_once(ops=ops, now=100.0)
            self.assertEqual(polled, ["bad", "good"])
            problems = [e for e in events if e["kind"] == "technical_problem"]
            self.assertEqual(len(problems), 1)
            self.assertIn("AttributeError", problems[0]["payload"]["detail"])


class AskWrittenBeforeAnswerTests(unittest.TestCase):
    """Producer capture from taste-swipe #39 (Claude Code 2.1.293): the AskUserQuestion
    record is written when asked, before the relay's position and before the answer."""

    def setUp(self):
        path = Path(__file__).parent / "fixtures" / "askuserquestion-before-answer.jsonl"
        self.ask, self.noise, self.answer = [
            json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.text = list(self.answer["toolUseResult"]["answers"].values())[0]

    def test_typed_answer_confirms_when_the_question_predates_the_send(self):
        records = [self.ask, self.noise, self.answer]
        action = {"text": self.text, "transport": "form", "transcript_position": 2}
        self.assertTrue(actions._confirmed(action, records))

    def test_answer_recorded_before_the_send_does_not_confirm(self):
        records = [self.ask, self.answer, self.noise]
        action = {"text": self.text, "transport": "form", "transcript_position": 2}
        self.assertFalse(actions._confirmed(action, records))

    def test_open_form_is_a_question_whatever_herdr_reports(self):
        import transcript
        records = [self.ask, self.noise]
        for status in ("idle", "done", "working", "unknown"):
            observed = transcript.classify(records, herdr_status=status, now=10_000.0, last_growth_at=0.0)
            self.assertEqual(observed.state, "question", status)
        answered = transcript.classify(records + [self.answer], herdr_status="idle", now=10.0, last_growth_at=0.0)
        self.assertNotEqual(answered.state, "question")


class TrailingNoticeTests(unittest.TestCase):
    """Producer capture from taste-swipe #39: the worker ended its turn with a
    plain-text question, then a <task-notification> arrived that it never took up."""

    def setUp(self):
        path = Path(__file__).parent / "fixtures" / "trailing-notice-excerpt.jsonl"
        self.records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def classify(self, records, status):
        import transcript
        return transcript.classify(records, herdr_status=status, now=10_000.0, last_growth_at=9_000.0).state

    def test_idle_pane_with_untaken_notice_is_finished_not_running(self):
        for status in ("idle", "done"):
            self.assertEqual(self.classify(self.records, status), "turn_finished", status)

    def test_working_pane_keeps_the_notice_as_a_new_turn(self):
        self.assertEqual(self.classify(self.records, "working"), "running")

    def test_a_typed_prompt_after_the_turn_is_still_a_new_turn(self):
        records = self.records + [user("confirm")]
        self.assertEqual(self.classify(records, "idle"), "running")

    def test_prompt_that_only_starts_with_the_handback_phrase_is_a_real_turn(self):
        records = self.records[:-1] + [user("Another Claude session sent a message: please check this")]
        self.assertEqual(self.classify(records, "idle"), "running")

    def test_notice_does_not_dismiss_an_open_form(self):
        ask_path = Path(__file__).parent / "fixtures" / "askuserquestion-before-answer.jsonl"
        ask = json.loads(ask_path.read_text(encoding="utf-8").splitlines()[0])
        records = [user("start"), ask, self.records[-1]]
        for status in ("idle", "working", "unknown"):
            self.assertEqual(self.classify(records, status), "question", status)

    def test_handback_message_closes_its_agent_launch(self):
        import transcript
        launch = {"type": "assistant", "isSidechain": False, "message": {
            "role": "assistant", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {}}]}}
        result = user([{"type": "tool_result", "tool_use_id": "toolu_A",
                        "content": "Async agent launched successfully.\nagentId: a9481b22bf19dc06b (internal ID)"}])
        handback = user('Another Claude session sent a message:\n<agent-message from="a9481b22bf19dc06b">\nreport')
        self.assertEqual(transcript.open_background_tasks([launch, result]), {"toolu_A"})
        self.assertEqual(transcript.open_background_tasks([launch, result, handback]), set())


class QueuedNoticeTests(unittest.TestCase):
    """Producer capture from norm-291: while the worker is busy, completion notices
    arrive as queued_command attachments, not user records."""

    def test_queued_command_attachment_closes_the_launch(self):
        import transcript
        path = Path(__file__).parent / "fixtures" / "queued-notice-excerpt.jsonl"
        launch, result, handback, notice = [
            json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        tool_id = launch["message"]["content"][0]["id"]
        self.assertEqual(transcript.open_background_tasks([launch, result]), {tool_id})
        self.assertEqual(transcript.open_background_tasks([launch, result, notice]), set())
        self.assertEqual(transcript.open_background_tasks([launch, result, handback]), set())


class WaitingBackgroundSlotTests(unittest.TestCase):
    def test_waiting_background_holds_a_slot(self):
        doc = {"workers": {"a": {"state": "waiting_background"}, "b": {"state": "done"}}}
        self.assertEqual(start._slots(doc), 1)


class ReopenedWorkerTests(unittest.TestCase):
    setUp = action_fixtures.ActionTests.setUp
    add_worker = action_fixtures.ActionTests.add_worker
    set_state = action_fixtures.ActionTests.set_state

    def reopen(self, *, records=None, confirm=False, state="done",
               action_id="follow-up", reopened_at=finish_fixtures.NOW - 60):
        if records is not None:
            self.ops.write("session-1", records)
        self.set_state(state, pending_action_id=None)
        self.ops.confirm = confirm
        worker = actions.worker_named("worker")
        with mock.patch.object(actions.time, "time", return_value=reopened_at):
            return actions.relay("worker", "Follow-up", state_token=worker["state_token"],
                                 ops=self.ops, action_id=action_id)

    def real_verifier(self):
        self.ops.verify_done = None
        self.github = finish_fixtures.FakeOps()
        self.ops.gh = self.github.gh

    def poll(self, now=finish_fixtures.NOW):
        watch._poll_worker(actions.worker_named("worker"), self.ops, now)
        return actions.worker_named("worker")

    def final_record(self, text):
        record = copy.deepcopy(action_fixtures.END)
        record["message"]["content"] = text
        return record

    def test_reopen_baseline_is_admitted_before_send_and_replaced_on_next_reopen(self):
        records = [action_fixtures.PROMPT, action_fixtures.END]
        original = actions._send
        for index, state in enumerate(("done", "awaiting_merge")):
            action_id = f"follow-up-{index}"
            reopened_at = finish_fixtures.NOW - 60 + index * 30

            def admitted(worker, *args, **kwargs):
                doc = registry.load()
                current = doc["workers"]["worker"]
                self.assertEqual(current["reopened_at"], float(int(reopened_at) - 1))
                self.assertEqual(current["reopen_action_id"], action_id)
                self.assertEqual(current["relay_request"]["action_id"], action_id)
                self.assertNotIn(action_id, doc["actions"])
                return original(worker, *args, **kwargs)

            with self.subTest(state=state), mock.patch.object(actions, "_send", side_effect=admitted):
                action = self.reopen(records=records, confirm=True, state=state,
                                     action_id=action_id, reopened_at=reopened_at)
                self.assertEqual(action["transcript_position"], len(records))
                self.assertEqual(action["status"], "delivered")
                self.assertEqual(actions.worker_named("worker")["state"], "running")
            records = actions.records_for(actions.worker_named("worker"), self.ops) + [action_fixtures.END]

    def test_queued_reopen_keeps_admission_time_when_a_slot_opens(self):
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.add_worker("busy", session="busy-session", issue=2)
        result = self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END])
        worker = actions.worker_named("worker")
        self.assertEqual(result["state"], "relay_pending")
        self.assertEqual(worker["reopened_at"], float(int(finish_fixtures.NOW - 60) - 1))
        self.assertEqual(worker["reopen_action_id"], result["id"])
        self.assertNotIn(result["id"], registry.load()["actions"])
        self.assertFalse(self.ops.sends)
        actions.change_worker("busy", "done")
        self.ops.confirm = True
        with mock.patch.object(actions.time, "time", return_value=finish_fixtures.NOW):
            action = actions.relay("worker", "Follow-up", state_token=worker["state_token"],
                                   ops=self.ops, action_id=result["id"])
        self.assertEqual(action["transcript_position"], 2)
        self.assertEqual(actions.worker_named("worker")["reopened_at"], float(int(finish_fixtures.NOW - 60) - 1))
        self.assertEqual(len(self.ops.sends), 1)

    def test_reopened_worker_without_followup_prompt_stays_running(self):
        action = self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END])
        self.ops.verdict.update(state="done", pr=42)
        self.assertEqual(action["status"], "delivery_unknown")
        with mock.patch.object(watch, "_verify", wraps=watch._verify) as verify:
            worker = self.poll()
        self.assertEqual(worker["state"], "running")
        verify.assert_not_called()
        self.assertFalse(self.ops.verify_calls)
        self.assertEqual(len(self.ops.sends), 1)

    def test_notices_sidechains_and_tool_results_do_not_count_as_followup_prompts(self):
        old = [action_fixtures.PROMPT, action_fixtures.END]
        self.reopen(records=old)
        self.ops.verdict.update(state="done", pr=42)
        notice = "<task-notification><status>completed</status></task-notification>"
        sidechain = dict(user("Follow-up"), isSidechain=True)
        nonprompts = [user(notice), user([{"type": "text", "text": notice}]),
                      user('Another Claude session sent a message: <agent-message from="abc">report'),
                      sidechain, action_fixtures.RESULT]
        for record in nonprompts:
            with self.subTest(record=record), mock.patch.object(watch, "_verify") as verify:
                self.ops.write("session-1", old + [record, action_fixtures.END])
                watch._TRANSCRIPTS.clear()
                self.assertEqual(self.poll()["state"], "running")
                verify.assert_not_called()

    def test_old_background_wait_requires_a_followup_prompt(self):
        records = [action_fixtures.PROMPT, *transcript_fixtures.background_pair("Bash"),
                   action_fixtures.END]
        self.reopen(records=records)
        with mock.patch.object(watch, "_verify") as verify:
            self.assertEqual(self.poll()["state"], "running")
            verify.assert_not_called()
        self.ops.write("session-1", [user("Follow-up"), action_fixtures.END], append=True)
        self.assertEqual(self.poll(now=finish_fixtures.NOW + 1)["state"], "waiting_background")

    def test_followup_with_only_old_prs_ends_without_proof(self):
        self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END], confirm=True)
        self.ops.write("session-1", [self.final_record("Follow-up finished.")], append=True)
        self.real_verifier()
        for state in ("MERGED", "OPEN"):
            with self.subTest(state=state):
                self.set_state("running")
                old_pr = finish_fixtures.pr(state=state)
                old_pr["mergedAt"] = finish_fixtures.pr(age=0)["createdAt"]
                self.github.prs = finish_fixtures.success([old_pr])
                self.github.calls.clear()
                worker = self.poll()
                self.assertEqual(worker["state"], "ended_without_proof")
                self.assertIn("no new PR was opened since the follow-up", worker["detail"])
                self.assertEqual(worker["final_message"], "Follow-up finished.")
                self.assertIsNone(worker["pr"])
                self.assertEqual(len(self.github.calls), 1)

    def test_missing_or_invalid_pr_creation_time_never_proves_a_followup(self):
        self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END], confirm=True)
        self.real_verifier()
        for state in ("MERGED", "OPEN"):
            for created in (None, "invalid", "2026-10-06T22:00:00", "missing"):
                with self.subTest(state=state, created=created):
                    candidate = finish_fixtures.pr(state=state, age=0)
                    if created == "missing":
                        candidate.pop("createdAt")
                    else:
                        candidate["createdAt"] = created
                    self.github.prs = finish_fixtures.success([candidate])
                    decision = finish.verify_done(actions.worker_named("worker"), ops=self.ops,
                                                  config={}, now=finish_fixtures.NOW, records=[])
                    self.assertEqual(decision["state"], "ended_without_proof")
                    self.assertIn("no new PR was opened since the follow-up", decision["detail"])

    def test_new_prs_at_or_after_reopen_use_the_usual_completion_checks(self):
        self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END], confirm=True)
        self.ops.write("session-1", [action_fixtures.END], append=True)
        self.real_verifier()
        for state, bucket, expected in (("MERGED", "pass", "done"), ("OPEN", "pass", "done"),
                                        ("OPEN", "pending", "awaiting_checks")):
            for age in (30, 60):
                with self.subTest(state=state, bucket=bucket, age=age):
                    self.set_state("running")
                    self.github.prs = finish_fixtures.success([
                        finish_fixtures.pr(state="MERGED", number=40),
                        finish_fixtures.pr(state="OPEN", number=41),
                        finish_fixtures.pr(state=state, age=age, number=43)])
                    self.github.checks = finish_fixtures.success([finish_fixtures.check(bucket=bucket)])
                    worker = self.poll()
                    self.assertEqual(worker["state"], expected)
                    self.assertEqual(worker["pr"], 43)

    def test_pr_in_the_same_second_as_a_fractional_reopen_counts(self):
        # GitHub createdAt has whole seconds; reopen at X.9 must accept a PR stamped X.
        self.reopen(records=[action_fixtures.PROMPT, action_fixtures.END], confirm=True,
                    reopened_at=finish_fixtures.NOW - 60 + 0.9)
        self.ops.write("session-1", [action_fixtures.END], append=True)
        self.real_verifier()
        self.set_state("running")
        self.github.prs = finish_fixtures.success([finish_fixtures.pr(state="MERGED", age=60, number=44)])
        self.github.checks = finish_fixtures.success([finish_fixtures.check(bucket="pass")])
        self.assertEqual(self.poll()["state"], "done")

    def test_session_change_after_reopen_uses_the_whole_new_transcript(self):
        old = [action_fixtures.PROMPT, action_fixtures.END, action_fixtures.PROMPT, action_fixtures.END]
        self.reopen(records=old, confirm=True)
        registry.update(lambda doc: doc["workers"]["worker"].update(session_id="session-2"))
        new = [action_fixtures.PROMPT, action_fixtures.END]
        self.assertEqual(len(watch._reopen_records(actions.worker_named("worker"), new)), 2)

    def test_brainstorm_artifact_mentioned_only_before_reopen_does_not_count(self):
        artifact = Path(self.temp.name) / "plans" / "requirements.md"
        artifact.parent.mkdir()
        artifact.write_text(finish_fixtures.PLAN_TEXT, encoding="utf-8")
        self.set_state("done", entry_command="ce-brainstorm")
        old = [action_fixtures.PROMPT, self.final_record(f"Saved `plans/{artifact.name}`.")]
        self.reopen(records=old, confirm=True)
        self.real_verifier()
        self.github.git_status.stdout = "?? plans/requirements.md"  # the worker wrote it
        self.ops.git = self.github.git
        sidechain = dict(self.final_record(f"Saved `plans/{artifact.name}`."), isSidechain=True)
        # A textless follow-up end_turn otherwise lets the verifier fall back to the old text.
        self.ops.write("session-1", [sidechain, self.final_record([])], append=True)
        worker = self.poll()
        self.assertEqual(worker["state"], "ended_without_proof")
        self.assertIsNone(worker["final_message"])
        self.assertFalse(self.github.calls)
        # Main-thread evidence after the baseline still counts.
        self.ops.write("session-1", [self.final_record(f"Updated `plans/{artifact.name}`.")], append=True)
        self.assertEqual(self.poll(now=finish_fixtures.NOW + 1)["state"], "done")

    def test_never_reopened_worker_still_accepts_an_old_merged_pr(self):
        self.ops.write("session-1", [action_fixtures.PROMPT, action_fixtures.END])
        self.real_verifier()
        self.github.prs = finish_fixtures.success([finish_fixtures.pr(state="MERGED")])
        worker = self.poll()
        self.assertEqual(worker["state"], "done")
        self.assertEqual(worker["pr"], 42)
        self.assertNotIn("reopened_at", worker)
        self.assertNotIn("reopen_action_id", worker)


class Utf8OutputTests(unittest.TestCase):
    def test_event_with_non_cp1252_text_prints_under_cp1252_console(self):
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HERDR_COORD_HOME=home, PYTHONIOENCODING="cp1252")
            env.pop("PYTHONUTF8", None)
            old = os.environ.get("HERDR_COORD_HOME")
            os.environ["HERDR_COORD_HOME"] = home
            try:
                seq = registry.append_event("worker_state", {"state": "question", "question_text": "● Pick one"})
            finally:
                if old is None:
                    os.environ.pop("HERDR_COORD_HOME", None)
                else:
                    os.environ["HERDR_COORD_HOME"] = old
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "herdr_coord.py"), "event", str(seq)],
                env=env, capture_output=True, timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
            event = json.loads(result.stdout.decode("utf-8"))
            self.assertEqual(event["payload"]["question_text"], "● Pick one")


if __name__ == "__main__":
    unittest.main()
