from __future__ import annotations

import copy
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import actions
import transcript


FIXTURES = Path(__file__).with_name("fixtures")
NOW = 1791319800


def load_records(name: str) -> list[dict]:
    return [json.loads(line) for line in (FIXTURES / name).read_bytes().splitlines()]


def content_blocks(record: dict) -> list[dict]:
    content = record.get("message", {}).get("content", [])
    return content if isinstance(content, list) else []


def background_pair(name: str) -> list[dict]:
    records = load_records("background-tasks-excerpt.jsonl")
    launch = next(record for record in records if record.get("type") == "assistant"
                  and any(block.get("name") == name for block in content_blocks(record)))
    tool_id = content_blocks(launch)[0]["id"]
    result = next(record for record in records if record.get("type") == "user"
                  and any(block.get("tool_use_id") == tool_id for block in content_blocks(record)))
    return copy.deepcopy([launch, result])


def background_notification(tool_id: str, status: str = "completed") -> dict:
    notification = load_records("background-tasks-excerpt.jsonl")[-1]
    text = re.sub(r"<tool-use-id>.*?</tool-use-id>", f"<tool-use-id>{tool_id}</tool-use-id>",
                  notification["message"]["content"])
    notification["message"]["content"] = text.replace("<status>completed</status>", f"<status>{status}</status>")
    return notification


class TranscriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.probe = load_records("session-probe-full.jsonl")
        cls.resumed = load_records("session-after-clear-and-resume.jsonl")
        cls.quota = load_records("api-error-429-sequence.jsonl")
        cls.background = load_records("background-tasks-excerpt.jsonl")
        cls.agents = {
            name: json.loads((FIXTURES / f"herdr-agent-get-{name}.json").read_bytes())[
                "result"
            ]["agent"]
            for name in ("idle", "after-prompt-done", "blocked-question")
        }
        cls.command_index = next(
            i for i, record in enumerate(cls.probe)
            if isinstance(record.get("message", {}).get("content"), str)
            and "<command-name>/compound-engineering:ce-explain</command-name>"
            in record["message"]["content"]
        )
        cls.ask_index = next(
            i for i, record in enumerate(cls.probe)
            if any(block.get("name") == "AskUserQuestion" for block in content_blocks(record))
        )
        cls.long_tool_index = next(
            i for i, record in enumerate(cls.probe[:cls.ask_index])
            if any(block.get("input", {}).get("timeout") == 120000
                   for block in content_blocks(record))
        )
        cls.long_tool_id = content_blocks(cls.probe[cls.long_tool_index])[0]["id"]
        cls.long_result_index = next(
            i for i, record in enumerate(cls.probe)
            if any(block.get("tool_use_id") == cls.long_tool_id
                   for block in content_blocks(record))
        )
        cls.final_index = max(
            i for i, record in enumerate(cls.probe)
            if record.get("type") == "assistant"
            and record["message"].get("stop_reason") == "end_turn"
        )
        cls.final_prompt_index = max(
            i for i, record in enumerate(cls.probe[:cls.final_index])
            if record.get("type") == "user"
            and isinstance(record["message"]["content"], str)
        )

    def assess(self, records, *, status="working", agent=None, age=0, stall_after_seconds=1200):
        return transcript.classify(
            records,
            herdr_status=actions.agent_status(agent) if agent is not None else status,
            now=NOW,
            last_growth_at=NOW - age,
            stall_after_seconds=stall_after_seconds,
        )

    def test_every_state_has_a_fixture_counterexample(self):
        pending = self.probe[:self.long_tool_index + 1]
        result = self.probe[:self.long_result_index + 1]
        prompt = self.probe[:self.command_index + 1]
        finished = self.probe[:self.final_index + 1]
        background = [self.probe[self.command_index], *background_pair("Bash"), self.probe[self.final_index]]
        blocked = actions.agent_status(self.agents["blocked-question"])
        idle = actions.agent_status(self.agents["idle"])
        cases = [
            ("unknown", self.probe[:self.command_index], "working", 0,
             prompt, "working", 0, "running"),
            ("running", self.probe[:self.final_index], "working", 0,
             finished, "working", 0, "turn_finished"),
            ("in_tool", pending, "working", 3600,
             result, "working", 3600, "running"),
            ("question", self.probe[:self.ask_index], blocked, 0,
             self.probe[:self.ask_index], "working", 0, "running"),
            ("quota_wait", self.quota[:-1], "working", 0,
             self.quota[1:-1], "working", 0, "unknown"),
            ("stalled", result, idle, 1200,
             result, idle, 1140, "running"),
            ("turn_finished", finished, "working", 0,
             self.probe[:self.final_index], "working", 0, "running"),
            ("waiting_background", background, "done", 0,
             background, "done", 3600, "turn_finished"),
        ]
        for state, records, status, age, other, other_status, other_age, other_state in cases:
            with self.subTest(state=state):
                classification = self.assess(records, status=status, age=age)
                self.assertIsInstance(classification, transcript.Classification)
                self.assertEqual(classification.state, state)
                self.assertTrue(classification.detail)
                counterexample = self.assess(other, status=other_status, age=other_age)
                self.assertEqual(counterexample.state, other_state)
                self.assertNotEqual(counterexample.state, state)

    def test_finished_turn_survives_trailing_non_state_records(self):
        self.assertEqual(self.assess(self.probe, status="done").state, "turn_finished")
        noise = [record for record in self.probe
                 if record.get("type") not in ("user", "assistant")]
        self.assertEqual(self.assess(self.probe + noise).state, "turn_finished")
        self.assertEqual(self.assess(noise).state, "unknown")

    def test_idle_compaction_does_not_reopen_an_ended_turn(self):
        # Live 2026-10-15 (Claude Code 2.1.300): "Compacted while idle" wrote these
        # two records after end_turn, and the summary read as an unanswered prompt, then stalled.
        finished = self.probe[:self.final_index + 1]
        boundary = {"type": "system", "subtype": "compact_boundary", "isSidechain": False,
                    "content": "Conversation compacted", "isMeta": False}
        summary = {"type": "user", "isSidechain": False, "isVisibleInTranscriptOnly": True,
                   "isCompactSummary": True, "message": {"role": "user", "content": (
                       "This session is being continued from a previous conversation that ran out "
                       "of context.\n\n<command-name>/compound-engineering:ce-explain</command-name>"
                       "\n<command-args></command-args>")}}
        compacted = finished + [boundary, summary]
        for status, age in (("idle", 7200), ("done", 7200), ("idle", 0)):
            with self.subTest(status=status, age=age):
                self.assertEqual(self.assess(compacted, status=status, age=age).state, "turn_finished")
        self.assertEqual(self.assess(finished + [boundary, dict(summary, isCompactSummary=False)],
                                     status="idle", age=7200).state, "stalled")
        # The summary quotes the entry command, but it never delivers one.
        self.assertFalse(transcript.delivered([summary], after_index=-1,
                                              command_name="compound-engineering:ce-explain", command_args=""))
        self.assertTrue(transcript.delivered([dict(summary, isCompactSummary=False)], after_index=-1,
                                             command_name="compound-engineering:ce-explain", command_args=""))
        later_prompt = self.probe[self.final_prompt_index]
        self.assertEqual(self.assess(compacted + [later_prompt]).state, "running")
        # An untaken background notice before the compaction is still dropped.
        notice = background_notification("toolu_untaken")
        self.assertEqual(self.assess(finished + [notice, boundary, summary], status="idle", age=7200).state,
                         "turn_finished")

    def test_later_prompt_supersedes_an_ended_turn(self):
        finished = self.probe[:self.final_index + 1]
        later_prompt = self.probe[self.final_prompt_index]
        self.assertEqual(self.assess(finished + [later_prompt]).state, "running")
        self.assertEqual(
            self.assess(finished + [later_prompt], status="blocked").state, "question"
        )

    def test_end_turn_requires_a_user_prompt(self):
        self.assertEqual(self.assess([self.probe[self.final_index]]).state, "running")
        self.assertEqual(self.assess([]).state, "unknown")

    def test_end_turn_with_open_bash_background_waits(self):
        launch, result = background_pair("Bash")
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        self.assertEqual(transcript.open_background_tasks(records), {content_blocks(launch)[0]["id"]})
        self.assertEqual(self.assess(records, status="done").state, "waiting_background")

    def test_terminal_background_notification_allows_finished_turn(self):
        launch, result = background_pair("Bash")
        tool_id = content_blocks(launch)[0]["id"]
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        for status in ("completed", "failed", "killed", "stopped"):
            with self.subTest(status=status):
                notification = background_notification(tool_id, status)
                resumed = records + [notification]
                self.assertEqual(transcript.open_background_tasks(resumed), set())
                self.assertEqual(self.assess(resumed).state, "running")
                self.assertEqual(self.assess(resumed + [notification, self.probe[self.final_index]]).state,
                                 "turn_finished")

    def test_end_turn_with_open_agent_background_waits(self):
        launch, result = background_pair("Agent")
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        self.assertEqual(transcript.open_background_tasks(records), {content_blocks(launch)[0]["id"]})
        self.assertEqual(self.assess(records).state, "waiting_background")

    def test_foreground_bash_moved_to_background_waits(self):
        launch, result = background_pair("Bash")
        content_blocks(launch)[0]["input"].pop("run_in_background")
        content_blocks(result)[0]["content"] = ("Command did not complete within its 600s timeout and was moved to the background "
                                              "(ID: ba7aqdfdc). Output is being written to: C:/x.output.")
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        self.assertEqual(self.assess(records).state, "waiting_background")

    def test_output_quoting_the_background_phrase_is_not_a_launch(self):
        launch, result = background_pair("Bash")
        content_blocks(launch)[0]["input"].pop("run_in_background")
        content_blocks(result)[0]["content"] = (
            "match: ... and was moved to the background (ID: bg_01). Output is being written to ...")
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        self.assertEqual(transcript.open_background_tasks(records), set())
        self.assertEqual(self.assess(records).state, "turn_finished")

    def test_expired_background_launch_does_not_rearm_the_wait(self):
        launch, result = background_pair("Bash")
        records = [self.probe[self.command_index], launch, result, self.probe[self.final_index]]
        expired = frozenset({content_blocks(launch)[0]["id"]})
        observed = transcript.classify(records, herdr_status="idle", now=1000.0, last_growth_at=999.0,
                                       expired_background=expired)
        self.assertEqual(observed.state, "turn_finished")

    def test_unmatched_background_notification_leaves_task_open(self):
        launch, result = background_pair("Bash")
        records = [self.probe[self.command_index], launch, result, self.background[-1], self.probe[self.final_index]]
        self.assertEqual(transcript.open_background_tasks(records), {content_blocks(launch)[0]["id"]})
        self.assertEqual(self.assess(records).state, "waiting_background")

    def test_background_wait_expires_after_sixty_minutes_without_growth(self):
        records = [self.probe[self.command_index], *background_pair("Bash")]
        for tail, detail in (([], transcript.NO_CLOSING_RECORD),
                             ([self.probe[self.final_index]], "assistant ended the latest prompt")):
            for age, expected in ((120, "waiting_background"), (3599, "waiting_background"),
                                  (3600, "turn_finished"), (3660, "turn_finished")):
                with self.subTest(closing_record=bool(tail), age=age):
                    observed = self.assess(records + tail, status="done", age=age)
                    self.assertEqual(observed.state, expected)
                    if expected == "turn_finished":
                        self.assertEqual(observed.detail, detail)
        self.assertEqual(self.assess(records, status="done", age=119).state, "running")

    def test_question_quota_and_pending_tool_precede_background_wait(self):
        records = [self.probe[self.command_index], *background_pair("Agent")]
        self.assertEqual(self.assess(records, status="blocked", age=1200).state, "question")
        later_prompt = records + [self.probe[self.final_index], self.probe[self.command_index]]
        self.assertEqual(self.assess(later_prompt, status="blocked", age=1200).state, "question")
        self.assertEqual(self.assess(records + [self.quota[0]], status="blocked").state, "quota_wait")
        self.assertEqual(self.assess(records + [self.probe[self.long_tool_index]], status="done",
                                    age=3600).state, "in_tool")

    def test_background_tasks_require_individual_terminal_notifications(self):
        bash_id = content_blocks(self.background[0])[0]["id"]
        agent_id = content_blocks(self.background[2])[0]["id"]
        self.assertEqual(transcript.open_background_tasks(self.background), {bash_id, agent_id})
        records = self.background + [background_notification(bash_id)]
        self.assertEqual(transcript.open_background_tasks(records), {agent_id})
        records += [background_notification(bash_id), background_notification(agent_id)]
        self.assertEqual(transcript.open_background_tasks(records), set())

    def test_background_launch_requires_matching_main_thread_tool_result(self):
        launch, result = background_pair("Bash")
        tool_id = content_blocks(launch)[0]["id"]
        unrelated = copy.deepcopy(result)
        content_blocks(unrelated)[0]["tool_use_id"] = "toolu_unrelated"
        foreground = copy.deepcopy(result)
        content_blocks(foreground)[0]["content"] = "Command completed successfully."
        for records in ([result], [launch], [result, launch], [launch, unrelated], [launch, foreground],
                        [dict(launch, isSidechain=True), result], [launch, dict(result, isSidechain=True)]):
            with self.subTest(records=records):
                self.assertEqual(transcript.open_background_tasks(records), set())
        self.assertEqual(transcript.open_background_tasks([background_notification(tool_id), launch, result]),
                         {tool_id})

    def test_only_main_thread_user_terminal_notice_closes_background_task(self):
        launch, result = background_pair("Agent")
        tool_id = content_blocks(launch)[0]["id"]
        notification = background_notification(tool_id)
        assistant = copy.deepcopy(notification)
        assistant.update(type="assistant")
        assistant["message"]["role"] = "assistant"
        quoted_result = copy.deepcopy(result)
        content_blocks(quoted_result)[0]["content"] = notification["message"]["content"]
        for notice in (dict(notification, isSidechain=True), assistant, quoted_result,
                       background_notification(tool_id, "running")):
            with self.subTest(notice=notice):
                self.assertEqual(transcript.open_background_tasks([launch, result, notice]), {tool_id})
        notification["message"]["content"] = [{"type": "text", "text": notification["message"]["content"]}]
        self.assertEqual(transcript.open_background_tasks([launch, result, notification]), set())

    def test_done_without_closing_record_threshold_and_idle_stall(self):
        result = self.probe[:self.long_result_index + 1]
        prompt = self.probe[:self.command_index + 1]
        for records in (prompt, result):
            for fixture, age, expected in (
                ("after-prompt-done", 119, "running"),
                ("after-prompt-done", 120, "turn_finished"),
                ("after-prompt-done", 1200, "turn_finished"),
                ("idle", 120, "running"),
                ("idle", 1199, "running"),
                ("idle", 1200, "stalled"),
                ("blocked-question", 1200, "question"),
            ):
                with self.subTest(last_type=records[-1]["type"], fixture=fixture, age=age):
                    observed = self.assess(records, agent=self.agents[fixture], age=age)
                    self.assertEqual(observed.state, expected)
                    if expected == "turn_finished":
                        self.assertEqual(observed.detail, "no closing record")

    def test_done_without_closing_record_requires_prompt_and_no_assistant_followup(self):
        done = self.agents["after-prompt-done"]
        without_prompt = self.probe[self.long_tool_index:self.long_result_index + 1]
        self.assertEqual(self.assess(without_prompt, agent=done, age=120).state, "running")
        self.assertEqual(self.assess([], agent=done, age=120).state, "unknown")
        thinking = next(record for record in self.probe
                        if record.get("type") == "assistant"
                        and any(block.get("type") == "thinking" for block in content_blocks(record)))
        followup = self.probe[:self.long_result_index + 1] + [thinking]
        self.assertEqual(self.assess(followup, agent=done, age=1200).state, "running")

    def test_done_without_closing_record_ignores_noise_and_sidechain_closing_record(self):
        result = self.probe[:self.long_result_index + 1]
        noise = [record for record in self.probe if record.get("type") not in ("user", "assistant")]
        sidechain_end = dict(self.probe[self.final_index], isSidechain=True)
        observed = self.assess(result + noise + [sidechain_end],
                               agent=self.agents["after-prompt-done"], age=120)
        self.assertEqual(observed, transcript.Classification("turn_finished", detail="no closing record"))

    def test_done_pending_tool_and_quota_precede_missing_closing_record(self):
        done = self.agents["after-prompt-done"]
        pending = self.probe[:self.long_tool_index + 1]
        self.assertEqual(self.assess(pending, agent=done, age=1200).state, "in_tool")
        waiting = self.probe[:self.command_index + 1] + self.quota[:-1]
        self.assertEqual(self.assess(waiting, agent=done, age=1200).state, "quota_wait")

    def test_question_requires_blocked_status_and_an_unfinished_prompt(self):
        before_answer = self.probe[:self.ask_index]
        self.assertEqual(self.assess(before_answer, status="blocked").state, "question")
        self.assertEqual(self.assess(before_answer, status="working").state, "running")
        without_prompt = self.probe[self.long_tool_index:self.ask_index]
        self.assertEqual(self.assess(without_prompt, status="blocked").state, "running")
        self.assertEqual(self.assess(self.probe, status="blocked").state, "turn_finished")

    def test_answered_question_and_later_assistant_work_are_not_question(self):
        answered = self.probe[:self.ask_index + 2]
        self.assertEqual(self.assess(answered).state, "running")
        after_work = self.probe[:self.ask_index + 4]
        self.assertEqual(self.assess(after_work, status="blocked").state, "turn_finished")

    def test_429_returns_reset_time_and_precedes_question_or_stall(self):
        waiting = self.probe[:self.command_index + 1] + self.quota[:-1]
        classification = self.assess(waiting, status="blocked", age=3600)
        self.assertEqual(classification.state, "quota_wait")
        self.assertEqual(classification.resets_at, 1791175200)

    def test_later_user_or_successful_assistant_clears_quota_wait(self):
        self.assertEqual(self.assess(self.quota).state, "running")
        thinking = next(record for record in self.probe
                        if record.get("type") == "assistant"
                        and content_blocks(record)[0]["type"] == "thinking")
        running = self.assess(self.quota[:-1] + [thinking])
        self.assertEqual(running.state, "running")
        self.assertIsNone(running.resets_at)
        finished = self.assess(self.quota + [self.probe[self.final_index]])
        self.assertEqual(finished.state, "turn_finished")
        self.assertIsNone(finished.resets_at)

    def test_moving_429_after_success_makes_it_current_again(self):
        records = self.quota + [self.probe[self.final_index], self.quota[0]]
        self.assertEqual(self.assess(records).state, "quota_wait")

    def test_long_pending_tool_never_stalls(self):
        pending = self.probe[:self.long_tool_index + 1]
        for status in ("working", "idle"):
            with self.subTest(status=status):
                self.assertEqual(self.assess(pending, status=status, age=3600).state, "in_tool")
        result = self.probe[self.long_result_index]
        self.assertEqual(self.assess(pending + [result]).state, "running")

    def test_only_a_later_matching_result_resolves_a_pending_tool(self):
        pending = self.probe[:self.long_tool_index + 1]
        unrelated = next(record for record in self.probe
                         if any(block.get("type") == "tool_result"
                                and block.get("tool_use_id") != self.long_tool_id
                                for block in content_blocks(record)))
        self.assertEqual(self.assess(pending + [unrelated], status="idle", age=3600).state,
                         "in_tool")
        result = self.probe[self.long_result_index]
        reordered = self.probe[:self.long_tool_index] + [result, pending[-1]]
        self.assertEqual(self.assess(reordered).state, "in_tool")

    def test_new_prompt_supersedes_an_old_pending_tool(self):
        pending = self.probe[:self.long_tool_index + 1]
        prompt = self.probe[self.final_prompt_index]
        self.assertEqual(self.assess(pending + [prompt]).state, "running")

    def test_stall_threshold_and_working_status(self):
        result = self.probe[:self.long_result_index + 1]
        for age, status, expected in (
            (1200, "idle", "stalled"),
            (1140, "idle", "running"),
            (1200, "working", "running"),
            (1200, "done", "turn_finished"),
            # Live smoke 2026-10-06: herdr reported a worker in a long PreToolUse
            # hook as not-working; it was busy. Unknown must never mean idle.
            (1200, "unknown", "running"),
        ):
            with self.subTest(age=age, status=status):
                self.assertEqual(self.assess(result, status=status, age=age).state, expected)

    def test_user_prompt_can_stall_but_assistant_followup_cannot(self):
        prompt = self.probe[:self.command_index + 1]
        self.assertEqual(self.assess(prompt, status="idle", age=1200).state, "stalled")
        thinking_index = next(
            i for i, record in enumerate(self.probe)
            if record.get("type") == "assistant"
            and content_blocks(record)[0]["type"] == "thinking"
        )
        followup = self.probe[:thinking_index + 1]
        self.assertEqual(self.assess(followup, status="idle", age=3600).state, "running")

    def test_stall_threshold_is_configurable(self):
        result = self.probe[:self.long_result_index + 1]
        self.assertEqual(self.assess(result, status="idle", age=1200,
                                     stall_after_seconds=1201).state, "running")

    def test_clear_changes_session_and_resume_keeps_the_new_transcript(self):
        old_id = self.agents["after-prompt-done"]["agent_session"]["value"]
        new_id = self.resumed[-1]["sessionId"]
        self.assertNotEqual(old_id, new_id)
        resume_prompt_index = next(
            i for i, record in enumerate(self.resumed)
            if record.get("message", {}).get("content") == "Reply with exactly: AFTER-RESUME"
        )
        self.assertEqual(self.resumed[resume_prompt_index]["sessionId"], new_id)
        self.assertEqual(self.assess(self.resumed[:resume_prompt_index + 1]).state, "running")
        self.assertEqual(self.assess(self.resumed).state, "turn_finished")

    def test_delivered_matches_resolved_command_and_exact_arguments(self):
        match = {"command_name": "/compound-engineering:ce-explain",
                 "command_args": "<redacted>"}
        self.assertTrue(transcript.delivered(self.probe, after_index=self.command_index - 1,
                                             **match))
        for index in (self.command_index, self.command_index + 1):
            with self.subTest(after_index=index):
                self.assertFalse(transcript.delivered(self.probe, after_index=index, **match))
        self.assertTrue(transcript.delivered(
            self.probe, after_index=-1,
            command_name="compound-engineering:ce-explain", command_args="<redacted>"
        ))
        self.assertFalse(transcript.delivered(
            self.probe, after_index=-1, command_name="/ce-explain", command_args="<redacted>"
        ))
        self.assertFalse(transcript.delivered(
            self.probe, after_index=-1,
            command_name=match["command_name"], command_args="<redacted"
        ))
        self.assertFalse(transcript.delivered(
            self.probe, after_index=-1, command_name=match["command_name"]
        ))

    def test_repeated_command_only_confirms_a_later_record(self):
        command = self.probe[self.command_index]
        self.assertTrue(transcript.delivered(
            self.probe + [command], after_index=self.command_index,
            command_name="/compound-engineering:ce-explain", command_args="<redacted>"
        ))

    def test_delivered_matches_pasted_command_after_position(self):
        for args in ("#21", "a" * 1300):
            # The live producer repeats the id in the closing tag (2026-10-07).
            for closing in ("\n</pasted_content>", '\n</pasted_content id="x">\n', ""):
                with self.subTest(args_length=len(args), closing=closing):
                    prompt = dict(self.probe[self.command_index], message={
                        "role": "user",
                        "content": f'\n\n<pasted_content id="x">\n/ce-brainstorm {args}{closing}',
                    })
                    match = {"command_name": "compound-engineering:ce-brainstorm", "command_args": args}
                    records = [self.probe[0], prompt]
                    self.assertTrue(transcript.delivered(records, after_index=0, **match))
                    self.assertFalse(transcript.delivered(records, after_index=1, **match))
                    self.assertFalse(transcript.delivered(records, after_index=2, **match))
                    self.assertTrue(transcript.delivered(records + [prompt], after_index=1, **match))

    def test_pasted_delivery_rejects_assistant_tool_result_and_sidechain(self):
        text = '\n\n<pasted_content id="x">\n/ce-brainstorm #21\n</pasted_content>'
        records = [
            {"type": "assistant", "message": {"role": "assistant", "content": text}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "content": text},
            ]}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "text", "text": text}, {"type": "tool_result", "content": "result"},
            ]}},
            {"type": "user", "isSidechain": True, "message": {"role": "user", "content": text}},
        ]
        for record in records:
            with self.subTest(record=record):
                self.assertFalse(transcript.delivered(
                    [record], after_index=-1,
                    command_name="compound-engineering:ce-brainstorm", command_args="#21",
                ))

    def test_pasted_delivery_requires_exact_command_and_args_at_block_start(self):
        for content in (
            "/ce-brainstorm #21",
            '<pasted_content_extra id="x">\n/ce-brainstorm #21\n</pasted_content>',
            '<pasted_content id="x">\nQuoted: /ce-brainstorm #21\n</pasted_content>',
            '<pasted_content id="x">\n/ce-work #21\n</pasted_content>',
            '<pasted_content id="x">\n/ce-brainstorm #210\n</pasted_content>',
            '<pasted_content id="x">\n/ce-brainstorm #21 extra\n</pasted_content>',
        ):
            with self.subTest(content=content):
                prompt = {"type": "user", "message": {"role": "user", "content": content}}
                self.assertFalse(transcript.delivered(
                    [prompt], after_index=-1,
                    command_name="compound-engineering:ce-brainstorm", command_args="#21",
                ))

    def test_pasted_delivery_matches_text_block_and_leading_slash_name(self):
        prompt = {"type": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": '\n\n<pasted_content id="x">\n/ce-brainstorm #21\n</pasted_content>'},
        ]}}
        for name in ("ce-brainstorm", "/compound-engineering:ce-brainstorm"):
            with self.subTest(name=name):
                self.assertTrue(transcript.delivered(
                    [prompt], after_index=-1, command_name=name, command_args="#21",
                ))

    def test_delivery_marker_ignores_same_text_in_assistant_and_tool_result(self):
        command = self.probe[self.command_index]
        marker = "<redacted>"
        self.assertIn(marker, command["message"]["content"])
        assistant = next(record for record in self.probe
                         if record.get("type") == "assistant"
                         and any(block.get("text") == marker for block in content_blocks(record)))
        result = next(record for record in self.probe
                      if any(block.get("type") == "tool_result"
                             and block.get("content") == marker for block in content_blocks(record)))
        self.assertTrue(transcript.delivered([command], after_index=-1, marker=marker))
        for record in (assistant, result):
            with self.subTest(record_type=record["type"]):
                self.assertFalse(transcript.delivered([record], after_index=-1, marker=marker))
                self.assertFalse(transcript.delivered(
                    [record], after_index=-1,
                    command_name="/compound-engineering:ce-explain", command_args=marker
                ))

    def test_delivery_marker_matches_string_and_text_block_prompts(self):
        self.assertTrue(transcript.delivered(self.resumed, after_index=-1, marker="AFTER-RESUME"))
        resume_prompt_index = next(
            i for i, record in enumerate(self.resumed)
            if record.get("message", {}).get("content") == "Reply with exactly: AFTER-RESUME"
        )
        self.assertFalse(transcript.delivered(
            self.resumed, after_index=resume_prompt_index, marker="AFTER-RESUME"
        ))
        companion = self.probe[self.command_index + 1]
        self.assertTrue(transcript.delivered([companion], after_index=-1, marker="<redacted>"))
        self.assertFalse(transcript.delivered(self.probe, after_index=-1))
        self.assertFalse(transcript.delivered(self.probe, after_index=-1, marker=""))

    def test_discovery_finds_exact_filename_regardless_of_folder_encoding(self):
        session_id = self.agents["after-prompt-done"]["agent_session"]["value"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "c--users-user-codeprojects-NORM_worker.v2"
            folder.mkdir()
            expected = folder / f"{session_id}.jsonl"
            expected.write_bytes((FIXTURES / "session-probe-full.jsonl").read_bytes())
            self.assertEqual(transcript.find_transcript(session_id, root), expected)
            self.assertIsNone(transcript.find_transcript(session_id.upper(), root))
            self.assertIsNone(transcript.find_transcript(self.resumed[-1]["sessionId"], root))

    def test_discovery_ignores_subagent_files_and_root_level_files(self):
        session_id = self.agents["after-prompt-done"]["agent_session"]["value"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subagents = root / "project" / session_id / "subagents"
            subagents.mkdir(parents=True)
            raw = (FIXTURES / "session-probe-full.jsonl").read_bytes()
            (subagents / f"{session_id}.jsonl").write_bytes(raw)
            (root / f"{session_id}.jsonl").write_bytes(raw)
            self.assertIsNone(transcript.find_transcript(session_id, root))
            top_level = root / "project" / f"{session_id}.jsonl"
            top_level.write_bytes(raw)
            self.assertEqual(transcript.find_transcript(session_id, root), top_level)

    def test_discovery_handles_missing_session_or_projects_root(self):
        session_id = self.agents["idle"].get("agent_session", {}).get("value")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertIsNone(transcript.find_transcript(session_id, root))
            self.assertIsNone(transcript.find_transcript("", root))
            self.assertIsNone(transcript.find_transcript(self.resumed[-1]["sessionId"], root / "missing"))

    def test_read_records_resumes_from_a_byte_offset_and_defers_partial_line(self):
        raw_lines = (FIXTURES / "session-probe-full.jsonl").read_bytes().splitlines(keepends=True)
        first = raw_lines[self.command_index]
        second = raw_lines[self.long_tool_index]
        split_at = len(second) // 2
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transcript.jsonl"
            path.write_bytes(first + second[:split_at])
            records, offset = transcript.read_records(path)
            self.assertEqual(records, [self.probe[self.command_index]])
            self.assertEqual(offset, len(first))
            self.assertEqual(transcript.read_records(path, offset), ([], offset))
            with path.open("ab") as handle:
                handle.write(second[split_at:])
            records, new_offset = transcript.read_records(path, offset)
            self.assertEqual(records, [self.probe[self.long_tool_index]])
            self.assertEqual(new_offset, len(first + second))
            self.assertEqual(transcript.read_records(path, new_offset), ([], new_offset))

    def test_read_records_offsets_are_bytes_including_crlf_and_split_utf8(self):
        raw = (FIXTURES / "api-error-429-sequence.jsonl").read_bytes().splitlines()[0]
        split_at = raw.index("\u00b7".encode("utf-8")) + 1
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transcript.jsonl"
            path.write_bytes(raw[:split_at])
            self.assertEqual(transcript.read_records(path), ([], 0))
            with path.open("ab") as handle:
                handle.write(raw[split_at:] + b"\r\n")
            records, offset = transcript.read_records(path)
            self.assertEqual(records, [self.quota[0]])
            self.assertEqual(offset, len(raw) + 2)
            self.assertEqual(transcript.read_records(path, offset), ([], offset))

    def test_malformed_lines_are_skipped_counted_and_consumed(self):
        raw_lines = (FIXTURES / "api-error-429-sequence.jsonl").read_bytes().splitlines(keepends=True)
        malformed = raw_lines[0][:20] + b"\n"
        non_object = json.dumps(self.quota[0]["message"]["content"]).encode("utf-8") + b"\n"
        data = malformed + non_object + raw_lines[-1]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transcript.jsonl"
            path.write_bytes(data)
            with self.assertLogs("transcript", level="WARNING") as logs:
                records, offset = transcript.read_records(path)
            self.assertEqual(records, [self.quota[-1]])
            self.assertEqual(offset, len(data))
            self.assertEqual(len(logs.output), 1)
            self.assertIn("Skipped 2 malformed transcript line(s)", logs.output[0])
            self.assertEqual(transcript.read_records(path, offset), ([], offset))
            path.write_bytes(malformed)
            with self.assertLogs("transcript", level="WARNING"):
                records, _ = transcript.read_records(path)
            self.assertEqual(self.assess(records).state, "unknown")

    def test_permission_mode_uses_separate_records_and_respects_position(self):
        self.assertEqual(transcript.permission_mode(self.probe), "auto")
        mode_index = max(i for i, record in enumerate(self.probe)
                         if record.get("type") == "permission-mode")
        self.assertEqual(transcript.permission_mode(self.probe, mode_index), "auto")
        self.assertIsNone(transcript.permission_mode(self.probe, mode_index + 1))
        self.assertEqual(transcript.permission_mode([self.probe[mode_index]]), "auto")
        user_with_mode = next(record for record in self.quota if record.get("type") == "user")
        self.assertEqual(user_with_mode["permissionMode"], "auto")
        self.assertIsNone(transcript.permission_mode([user_with_mode]))

    def test_assistant_model_ignores_synthetic_api_error_records(self):
        self.assertEqual(transcript.assistant_model(self.probe), "claude-opus-5-5")
        self.assertEqual(transcript.assistant_model(self.resumed), "claude-opus-5-5")
        self.assertEqual(transcript.assistant_model(self.probe + self.quota), "claude-opus-5-5")
        self.assertIsNone(transcript.assistant_model(self.quota))
        self.assertIsNone(transcript.assistant_model(self.probe[:self.command_index + 1]))
        self.assertIsNone(transcript.permission_mode([]))
        self.assertIsNone(transcript.assistant_model([]))


if __name__ == "__main__":
    unittest.main()
