"""Adoption and its downstream paths use only temporary files and fake external ops."""

import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import actions
import adapters
import finish
import herdr_coord
import lanes
import registry
import start
import transcript
import watch
from test_actions import FakeOps as ActionOps, PROMPT, END, TOOL, RESULT, QUOTA
from test_start import failure, success
from test_transcript import background_pair


class AdoptOps(ActionOps):
    def __init__(self, root):
        super().__init__(root / "projects")
        self.repo = root / "repo"
        self.tree = root / "linked tree"
        self.repo.mkdir()
        self.tree.mkdir()
        self.agent = {
            "agent": "claude", "name": "research", "agent_session": {"kind": "id", "value": "session-1"},
            "agent_status": "idle", "cwd": str(self.tree), "pane_id": "w2:p1",
            "workspace_id": "w2", "terminal_title_stripped": "Automation ideation brief",
        }
        self.sessions["research"] = "session-1"
        self.listed = [self.repo, self.tree]
        self.agent_missing = False
        self.status_output = ""
        self.write("session-1", [PROMPT, END])

    def herdr(self, *args, **kwargs):
        if args[:2] == ("agent", "get"):
            self.calls.append((args, kwargs))
            if self.agent_missing or args[2] != self.agent["name"]:
                return failure("agent_not_found")
            return success({"result": {"agent": copy.deepcopy(self.agent)}})
        if args[:2] == ("agent", "list"):
            self.calls.append((args, kwargs))
            return success({"result": {"agents": [copy.deepcopy(self.agent)]}})
        if args[:2] == ("workspace", "close"):
            self.calls.append((args, kwargs))
            return success()
        return super().herdr(*args, **kwargs)

    def git(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args == ("worktree", "list", "--porcelain"):
            return adapters.CommandResult(True, 0, "".join(
                f"worktree {path}\nHEAD abc\nbranch refs/heads/test\n\n" for path in self.listed), "")
        if args == ("status", "--porcelain"):
            return adapters.CommandResult(True, 0, self.status_output, "")
        raise AssertionError(f"unexpected git operation: {args}")


class AdoptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = dict(os.environ, HERDR_COORD_HOME=str(self.root / "home"),
                           HERDR_COORD_BASE=str(self.root / "base"), LOCALAPPDATA=str(self.root / "local"))
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_COORD_REPO"):
            environment.pop(key, None)
        self.enterContext(mock.patch.dict(os.environ, environment, clear=True))
        self.ops = AdoptOps(self.root)
        self.enterContext(mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None))
        self.enterContext(mock.patch.object(adapters, "herdr", side_effect=self.ops.herdr))
        self.enterContext(mock.patch.object(adapters, "git", side_effect=self.ops.git))
        self.enterContext(mock.patch.object(start, "PROJECTS_ROOT", self.ops.projects_root))
        self.enterContext(mock.patch.object(lanes, "read_snapshot", return_value=None))
        self.enterContext(mock.patch.object(lanes, "claude_session_names", return_value={}))
        watch._TRANSCRIPTS.clear()
        watch._SETTLED_PROBES.clear()
        registry.create_lane("research-lane")
        self.context = {"lane": "research-lane", "tab_id": "w1:t1", "pane_id": "w1:p1",
                        "controller": {"agent": "claude", "kind": "id", "value": "coordinator"}}
        registry.update(lambda doc: doc["tab_bindings"].update({"w1:t1": {
            "lane": "research-lane", "pane_id": "w1:p1", "controller": self.context["controller"]}}))

    def adopt(self, **kwargs):
        return start.adopt(self.ops.repo, kwargs.pop("name", "research"), lane="research-lane",
                           ops=self.ops, **kwargs)

    def worker(self):
        return next(iter(registry.load()["workers"].values()))

    def update_worker(self, **fields):
        worker_id = self.worker()["worker_id"]
        registry.update(lambda doc: doc["workers"][worker_id].update(fields))

    def poll(self, now=100):
        return watch.poll_once(ops=self.ops, now=now)

    def test_records_fields_offset_and_bookkeeping_event(self):
        worker = self.adopt(tag="C2 - coordinator")
        expected = {
            "worker_id": f"{os.path.normcase(str(self.ops.repo))}@research", "adhoc": True, "issue": None,
            "repo_path": str(self.ops.repo), "lane": "research-lane", "label_tag": "C2",
            "title": "Automation ideation brief", "agent_name": "research", "pane_id": "w2:p1",
            "workspace_id": "w2", "session_id": "session-1", "worktree_path": str(self.ops.tree),
            "transcript_path": str(self.ops.path("session-1")),
            "transcript_offset": self.ops.path("session-1").stat().st_size,
            "state": "awaiting_merge", "phase": "mode_checked",
        }
        self.assertEqual({key: worker[key] for key in expected}, expected)
        self.assertEqual(self.worker(), worker)
        (event,) = registry.read_events(0, lane="research-lane")
        self.assertEqual(event["kind"], "worker_adopted")
        self.assertEqual(event["lanes"], ["research-lane"])
        self.assertIn("worker_adopted", registry.BOOKKEEPING_EVENT_KINDS)
        self.assertFalse(registry.event_actionable(event))
        self.assertFalse(registry.read_events(0, lane="main"))
        self.assertFalse(self.ops.sends)

    def test_offset_stops_before_a_record_still_being_written(self):
        complete = self.ops.path("session-1").stat().st_size
        with self.ops.path("session-1").open("ab") as handle:
            handle.write(b'{"type": "assistant", "partial')
        worker = self.adopt()
        self.assertEqual((worker["transcript_offset"], worker["adopted_offset"]), (complete, complete))

    def test_title_label_then_agent_name_fallback_and_working_state(self):
        self.ops.agent.update(agent_status="working", terminal_title_stripped="")
        worker = self.adopt()
        self.assertEqual(worker["title"], "research")
        self.assertEqual(worker["state"], "running")
        self.update_worker(state="cleaned")
        self.assertEqual(self.adopt(label="Research choices")["title"], "Research choices")

    def test_pane_id_resolves_to_agent_name(self):
        self.assertEqual(self.adopt(name="w2:p1")["agent_name"], "research")
        self.assertIn(("agent", "list"), [args for args, _ in self.ops.calls])

    def test_adopting_mid_turn_settles_without_replaying_its_old_prompt(self):
        self.ops.agent["agent_status"] = "working"
        self.adopt()
        self.assertFalse(self.poll())
        self.ops.write("session-1", [END], append=True)
        events = self.poll(101)
        self.assertEqual(self.worker()["state"], "ended_without_proof")
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "ended_without_proof")
        self.assertEqual(actions.records_for(self.worker(), self.ops), [END])
        self.assertFalse(self.ops.sends)

    def test_accepts_repository_and_registered_worktree_subdirectories(self):
        for root in (self.ops.repo, self.ops.tree):
            with self.subTest(root=root):
                cwd = root / "src"
                cwd.mkdir()
                self.ops.agent["cwd"] = str(cwd)
                worker = self.adopt()
                # The containing checkout, so cleanup can recognise a linked tree.
                self.assertEqual(worker["worktree_path"], str(root))
                self.update_worker(state="cleaned")

    def test_refusals_change_no_workers_or_events(self):
        cases = (
            ({"agent": "codex"}, {}, "claude"),
            ({"agent_session": None}, {}, "session id"),
            ({"cwd": str(self.root / "repo-lookalike")}, {}, "outside"),
            ({}, {"caller_pane_id": "w2:p1"}, "own pane"),
            ({"agent_session": {"value": "missing-transcript"}}, {}, "transcript"),
        )
        original = copy.deepcopy(self.ops.agent)
        for changes, kwargs, message in cases:
            with self.subTest(message=message):
                self.ops.agent = {**copy.deepcopy(original), **changes}
                before = registry.load()
                events = registry.read_events(0, lane=None)
                with self.assertRaisesRegex(start.StartError, message):
                    self.adopt(**kwargs)
                self.assertEqual(registry.load(), before)
                self.assertEqual(registry.read_events(0, lane=None), events)
                self.assertFalse(self.ops.sends)

    def test_refuses_every_lanes_bound_controller(self):
        for controller in ({"pane_id": "w2:p1", "controller": {"value": "other"}},
                           {"pane_id": "different-pane", "controller": {"value": "session-1"}}):
            with self.subTest(controller=controller):
                registry.update(lambda doc: doc["tab_bindings"].update({
                    "w2:t1": {"lane": "main", **controller}}))
                before = registry.load()
                with self.assertRaisesRegex(start.StartError, "controller pane"):
                    self.adopt()
                self.assertEqual(registry.load(), before)
                self.assertFalse(registry.read_events(0, lane=None))

    def test_refuses_duplicate_name_pane_or_session_in_any_lane(self):
        for field, value in (("agent_name", "research"), ("pane_id", "w2:p1"), ("session_id", "session-1")):
            with self.subTest(field=field):
                registry.update(lambda doc: doc["workers"].update({"existing": {
                    "worker_id": "existing", "issue": 42, "state": "done", "lane": "main", field: value}}))
                before = registry.load()
                with self.assertRaisesRegex(start.StartError, "already tracks"):
                    self.adopt()
                self.assertEqual(registry.load(), before)
                self.assertFalse(registry.read_events(0, lane=None))

    def test_cli_resolves_repo_lane_and_label(self):
        context = {"lane": "research-lane", "tab_label": "C3 - coordinator", "pane_id": "controller"}
        with mock.patch.object(lanes, "resolve_context", return_value=context) as resolve, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            result = herdr_coord.main(["adopt", "research", "--label", "Research", "--repo", str(self.ops.repo)])
        self.assertEqual(result, 0)
        resolve.assert_called_once_with(str(self.ops.repo), legacy=False)
        worker = json.loads(output.getvalue())
        self.assertEqual((worker["title"], worker["lane"], worker["label_tag"]), ("Research", "research-lane", "C3"))

    def test_cli_reports_watcher_failure_after_successful_adoption(self):
        with mock.patch.object(herdr_coord, "_ensure_watcher", side_effect=TimeoutError("not ready")), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            result = herdr_coord.main(["adopt", "research", "--repo", str(self.ops.repo)])
        self.assertEqual(result, 1)
        self.assertTrue(self.worker()["adhoc"])
        self.assertEqual(json.loads(output.getvalue())["watcher"]["state"], "launch_failed")

    def test_old_turns_are_not_replayed_even_after_watcher_restart(self):
        self.adopt()
        for now in (100, 101):
            self.assertFalse(self.poll(now))
            watch._TRANSCRIPTS.clear()
        self.assertEqual(self.worker()["state"], "awaiting_merge")
        self.assertEqual(actions.records_for(self.worker(), self.ops), [])
        self.assertFalse(self.ops.sends)

    def test_typed_question_routes_to_owner_with_typed_turn_and_follow_wakes(self):
        self.adopt()
        self.ops.write("session-1", [PROMPT, TOOL], append=True)
        self.poll()
        self.assertEqual(self.worker()["state"], "running")
        self.assertTrue(self.worker()["typed_turn"])
        self.ops.agent["agent_status"] = "blocked"
        self.ops.write("session-1", [RESULT], append=True)
        events = self.poll(101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "question")
        self.assertTrue(event["payload"]["typed_turn"])
        self.assertEqual(event["lanes"], ["research-lane"])
        self.assertEqual(registry.read_events(0, lane="main"), [])
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(wake=True, lane="research-lane", context=self.context), 0)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([line["kind"] for line in lines], ["worker_state"])
        self.assertEqual(lines[0]["payload"]["state"], "question")
        self.assertFalse(self.ops.sends)

    def test_adoption_alone_never_wakes_follow(self):
        self.adopt()
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watch.follow(wake=True, lane="research-lane", context=self.context), 0)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(registry.load()["lanes"]["research-lane"]["ack_seq"], 1)

    def test_done_is_ended_without_proof_and_later_typed_turn_is_marked_again(self):
        self.adopt()
        self.ops.verdict["state"] = "done"
        self.ops.write("session-1", [PROMPT, END], append=True)
        self.poll()
        events = self.poll(101)
        (event,) = [event for event in events if event["kind"] == "worker_state"]
        self.assertEqual(event["payload"]["state"], "ended_without_proof")
        self.assertTrue(event["payload"]["typed_turn"])
        self.assertFalse(self.ops.verify_calls)
        watch._TRANSCRIPTS.clear()
        self.assertFalse(self.poll(102))
        self.ops.write("session-1", [PROMPT, TOOL], append=True)
        self.poll(103)
        self.assertEqual(self.worker()["state"], "running")
        self.assertTrue(self.worker()["typed_turn"])

    def test_verify_done_and_named_pr_do_not_use_external_proof_for_adhoc(self):
        worker = self.adopt()
        worker["entry_command"] = "ce-work"
        result = finish.verify_done(worker, ops=object(), config={}, now=100, records=[END])
        self.assertEqual(result["state"], "ended_without_proof")
        self.assertIn("--abandon", finish.named_pr_merged(worker, 42, object())[1])

    def test_stalls_and_quota_resets_never_send_automatic_prompts(self):
        self.ops.agent["agent_status"] = "working"
        self.adopt()
        self.ops.agent["agent_status"] = "idle"
        self.ops.write("session-1", [PROMPT], append=True)
        self.poll(100)
        self.update_worker(last_growth_at=0)
        with mock.patch.object(actions, "nudge") as nudge, mock.patch.object(actions, "resume") as resume:
            self.poll(1300)
            self.assertEqual(self.worker()["state"], "stalled")
            self.poll(1301)
            quota = copy.deepcopy(QUOTA)
            quota["quotaLimits"]["resetsAt"] = 1
            self.ops.write("session-1", [PROMPT, quota], append=True)
            self.poll(1400)
            self.assertEqual(self.worker()["state"], "quota_wait")
            self.poll(1401)
        nudge.assert_not_called()
        resume.assert_not_called()
        self.assertFalse(self.ops.sends)

    def test_background_work_keeps_existing_waiting_classification(self):
        self.adopt()
        self.ops.write("session-1", [PROMPT, TOOL], append=True)
        self.poll()
        self.ops.write("session-1", [RESULT, *background_pair("Bash"), END], append=True)
        self.poll(101)
        self.assertEqual(self.worker()["state"], "waiting_background")
        self.assertFalse(self.ops.sends)

    def test_explicit_relay_works_even_when_issue_capacity_is_full(self):
        self.adopt()
        registry.update(lambda doc: doc["config"].update(cap=0))
        result = actions.relay("research", "Continue the research", state_token=self.worker()["state_token"],
                               ops=self.ops, lane="research-lane")
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(self.worker()["state"], "running")
        self.assertEqual(self.ops.sends, [("agent", "prompt", "research", "Continue the research")])

    def test_slots_restart_admission_and_queue_exclude_adhoc(self):
        worker = self.adopt()
        for state in (*start.SLOT_STATES, "cleaning"):
            with self.subTest(state=state):
                self.update_worker(state=state, cleanup_from={"state": "running"})
                self.assertEqual(start._slots(registry.load()), 0)
        self.update_worker(state="start_interrupted")
        before = registry.load()
        with self.assertRaisesRegex(ValueError, "found 0"):
            start.restart("research", lane="research-lane", ops=self.ops)
        self.assertEqual(registry.load(), before)
        with self.assertRaisesRegex(start.StartError, "issue worker"):
            start._admit(worker)
        registry.update(lambda doc: doc["queue"].append({**worker, "state": "queued"}))
        self.assertIsNone(start.start_next_queued(ops=self.ops))
        issue = {"worker_id": "issue-1", "issue": 1, "state": "queued", "lane": "main"}
        registry.update(lambda doc: doc["queue"].append(issue))
        with mock.patch.object(start, "_run_worker", return_value=issue) as run:
            self.assertEqual(start.start_next_queued(ops=self.ops), issue)
        self.assertEqual(run.call_args.args[0]["worker_id"], "issue-1")
        self.assertEqual(len(registry.load()["queue"]), 1)
        self.assertFalse(self.ops.sends)

    def test_status_prints_name_adhoc_title_state_and_lane(self):
        self.adopt()
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["status"]), 0)
        line = next(line for line in output.getvalue().splitlines() if line.startswith("adhoc\t"))
        for value in ("research", "Automation ideation brief", "idle", "lane=research-lane"):
            self.assertIn(value, line)
        self.assertNotIn("#None", line)

    def test_abandon_finishes_idle_worker_and_retains_linked_tree(self):
        self.adopt()
        result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertTrue(result["results"][0]["cleaned"])
        self.assertEqual(self.worker()["state"], "cleaned")
        self.assertTrue(self.worker()["abandoned"])
        calls = [args for args, _ in self.ops.calls]
        self.assertIn(("workspace", "close", "w2"), calls)
        self.assertNotIn(("worktree", "remove", str(self.ops.tree)), calls)
        self.assertNotIn(("worktree", "remove", "--workspace", "w2"), calls)

    def test_adopt_and_cleanup_ignore_cleaned_issue_worker_with_same_agent_name(self):
        registry.update(lambda doc: doc["workers"].update({"old-issue": {
            "worker_id": "old-issue", "issue": 42, "agent_name": "research", "pane_id": "w2:p1",
            "session_id": "session-1", "state": "cleaned", "lane": "main"}}))
        worker = self.adopt()
        relay = actions.relay("research", "Continue research", state_token=worker["state_token"],
                              lane="research-lane", ops=self.ops)
        self.assertEqual(relay["status"], "delivered")
        result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertTrue(result["results"][0]["cleaned"])
        self.assertEqual(registry.load()["workers"]["old-issue"]["state"], "cleaned")
        self.assertEqual(self.worker()["session_id"], "session-1")
        self.assertEqual(registry.load()["workers"][worker["worker_id"]]["state"], "cleaned")

    def test_unreadable_linked_registration_retains_worktree(self):
        self.adopt()
        original = self.ops.git

        def git(*args, **kwargs):
            if args == ("worktree", "list", "--porcelain"):
                return failure("cannot list worktrees")
            return original(*args, **kwargs)

        with mock.patch.object(self.ops, "git", side_effect=git):
            result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertTrue(result["results"][0]["cleaned"])
        self.assertIn("worktree left for the nightly sweep", result["results"][0]["reason"])
        self.assertFalse(any(args[:2] == ("worktree", "remove") for args, _ in self.ops.calls))

    def test_abandon_leaves_primary_subdirectories_and_unregistered_tree(self):
        for path in (self.ops.repo, self.ops.tree / "src", self.root / "unregistered"):
            with self.subTest(path=path):
                self.ops.agent["cwd"] = str(self.ops.repo)
                self.adopt()
                self.update_worker(worktree_path=str(path))
                self.ops.calls.clear()
                result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
                self.assertTrue(result["results"][0]["cleaned"])
                self.assertIn("worktree left for the nightly sweep", result["results"][0]["reason"])
                self.assertEqual(self.worker()["state"], "cleaned")
                self.assertFalse(any(args[:2] == ("worktree", "remove") for args, _ in self.ops.calls))

    def test_cleanup_refuses_busy_worker_but_finishes_dirty_idle_worker(self):
        self.adopt()
        self.ops.agent["agent_status"] = "working"
        result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertFalse(result["results"][0]["cleaned"])
        self.ops.agent["agent_status"] = "idle"
        self.ops.status_output = " M research.md\n"
        result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertTrue(result["results"][0]["cleaned"])
        self.assertTrue(any(args[:2] == ("workspace", "close") for args, _ in self.ops.calls))

    def test_abandon_retains_dirty_tree_after_agent_exits(self):
        self.adopt()
        self.ops.agent_missing = True
        self.ops.status_output = " M research.md\n"
        result = herdr_coord._cleanup("research", lane="research-lane", ops=self.ops)
        self.assertTrue(result["results"][0]["cleaned"])
        self.assertFalse(any(args[:2] == ("worktree", "remove") for args, _ in self.ops.calls))

    def test_cleanup_lane_merged_pr_and_bare_sweep_guards(self):
        self.adopt()
        before = registry.load()
        self.ops.calls.clear()
        with self.assertRaisesRegex(ValueError, "lane research-lane"):
            herdr_coord._cleanup("research", lane="main", ops=self.ops)
        with self.assertRaisesRegex(ValueError, "--abandon"):
            herdr_coord._cleanup(merged_pr=("research", "42"), lane="research-lane", ops=self.ops)
        with self.assertRaisesRegex(ValueError, "no worker"):
            herdr_coord._cleanup("None", lane="research-lane", ops=self.ops)
        self.update_worker(abandoned=True)
        self.assertEqual(herdr_coord._cleanup(lane="research-lane", ops=self.ops)["results"], [])
        self.update_worker(abandoned=False)
        self.assertFalse(self.ops.calls)
        # Only our explicit test marks changed, and no cleanup claim was acquired.
        self.assertEqual(registry.load()["workers"], {key: {**value, "abandoned": False}
                                                     for key, value in before["workers"].items()})

    def test_handoff_uses_adhoc_label_and_keeps_issue_none(self):
        self.adopt(tag="C1")
        registry.create_lane("other")
        self.ops.workspace_labels["w2"] = "C1 adhoc Automation ideation brief"
        result = actions.handoff("research", "other", lane="research-lane", ops=self.ops)
        self.assertEqual(result["state"], "handed_off")
        self.assertEqual(result["workspace_label"], "other adhoc Automation ideation brief")
        self.assertEqual(self.worker()["lane"], "other")
        self.assertIsNone(self.worker()["issue"])


if __name__ == "__main__":
    unittest.main()
