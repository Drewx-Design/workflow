import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(key, None)  # a suite run inside herdr must not resolve a real lane

import io
import os
import tempfile
import unittest
from unittest import mock

import actions
import finish
import herdr_coord
import registry
import start
import watch


class CleanupCommandTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": self.home.name})
        self.env.start()

        def seed(doc):
            doc["workers"] = {
                "w-done": {"worker_id": "w-done", "issue": 1, "agent_name": "a-done", "state": "done"},
                "w-running": {"worker_id": "w-running", "issue": 2, "agent_name": "a-run", "state": "running"},
                "w-cleaned": {"worker_id": "w-cleaned", "issue": 3, "agent_name": "a-old", "state": "cleaned"},
            }
        registry.update(seed)

    def tearDown(self):
        self.env.stop()
        self.home.cleanup()

    def test_cleans_only_eligible_workers_and_records_the_result(self):
        calls = []

        def fake_cleanup(worker, *, ops):
            calls.append(worker["worker_id"])
            return {"cleaned": True, "reason": "merged and exited"}

        with mock.patch.object(finish, "cleanup", fake_cleanup):
            result = herdr_coord._cleanup(ops=object())
        self.assertEqual(calls, ["w-done"])
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "cleaned")
        self.assertEqual(registry.load()["workers"]["w-running"]["state"], "running")
        self.assertEqual([e["kind"] for e in registry.read_events(0)], ["worker_cleaned"])
        self.assertEqual(result["results"][0]["issue"], 1)

    def test_named_cleanup_refuses_another_lane_without_marks(self):
        for options in ({"abandon": "a-done"}, {"merged_pr": ("a-done", "9")}):
            with self.subTest(options=options):
                registry.update(lambda doc: doc["workers"]["w-done"].update(lane="seo"))
                before = registry.load()
                with mock.patch.object(finish, "cleanup") as cleanup, \
                        mock.patch.object(finish, "named_pr_merged", return_value=(True, "")):
                    with self.assertRaisesRegex(ValueError, "lane seo"):
                        herdr_coord._cleanup(ops=object(), **options)
                cleanup.assert_not_called()
                self.assertEqual(registry.load(), before)

    def test_named_cleanup_checks_lane_at_claim_after_racing_handoff(self):
        for options in ({"abandon": "a-done"}, {"merged_pr": ("a-done", "9")}):
            with self.subTest(options=options):
                registry.update(lambda doc: doc["workers"]["w-done"].update(lane="main"))
                claim = herdr_coord._claim_for_cleanup

                def move_then_claim(worker, **kwargs):
                    registry.update(lambda doc: doc["workers"]["w-done"].update(lane="seo"))
                    return claim(worker, **kwargs)

                with mock.patch.object(herdr_coord, "_claim_for_cleanup", side_effect=move_then_claim), \
                        mock.patch.object(finish, "named_pr_merged", return_value=(True, "")), \
                        mock.patch.object(finish, "cleanup") as cleanup:
                    with self.assertRaisesRegex(ValueError, "lane seo"):
                        herdr_coord._cleanup(ops=object(), **options)
                cleanup.assert_not_called()
                worker = registry.load()["workers"]["w-done"]
                self.assertEqual(worker["state"], "done")
                for key in ("abandoned", "merged_pr_named", "cleanup_from", "pr"):
                    self.assertNotIn(key, worker)

    def test_named_marks_are_saved_only_together_with_cleanup_claim(self):
        save = registry.save
        snapshots = []

        def inspect_save(doc):
            current = doc["workers"]["w-done"]
            if current.get("abandoned") or current.get("merged_pr_named"):
                snapshots.append(dict(current))
                self.assertEqual(current["state"], "cleaning")
                self.assertIn("cleanup_from", current)
            save(doc)

        for options in ({"abandon": "a-done"}, {"merged_pr": ("a-done", "9")}):
            with self.subTest(options=options):
                registry.update(lambda doc: doc["workers"]["w-done"].update(
                    state="done", abandoned=False, merged_pr_named=False))
                # Crash after the claim, before any release: only claim-time snapshots are inspected.
                with mock.patch.object(registry, "save", side_effect=inspect_save), \
                        mock.patch.object(finish, "named_pr_merged", return_value=(True, "")), \
                        mock.patch.object(finish, "cleanup", side_effect=RuntimeError("after claim")):
                    with self.assertRaisesRegex(RuntimeError, "after claim"):
                        herdr_coord._cleanup(ops=object(), **options)
                worker = registry.load()["workers"]["w-done"]
                self.assertEqual(worker["lane"], "main")
                self.assertEqual(worker["state"], "cleaning")
                self.assertTrue(worker.get("abandoned") or worker.get("merged_pr_named"))
        self.assertEqual(len(snapshots), 2)

    def test_stale_cleanup_cannot_leave_authorization_marks(self):
        worker = registry.load()["workers"]["w-done"]
        registry.update(lambda doc: doc["workers"]["w-done"].update(state_token="new"))
        for options in ({"abandon": True}, {"merged_pr": 9}):
            with self.subTest(options=options):
                self.assertIsNone(herdr_coord._claim_for_cleanup(worker, lane="main", **options))
                current = registry.load()["workers"]["w-done"]
                self.assertNotIn("abandoned", current)
                self.assertNotIn("merged_pr_named", current)

    def test_live_handoff_claim_refuses_cleanup_without_marks(self):
        registry.update(lambda doc: doc["workers"]["w-done"].update(
            handoff_claim={"owner": start._start_owner(), "target": "seo"}))
        before = registry.load()
        for options in ({"abandon": "a-done"}, {"merged_pr": ("a-done", "9")}, {}):
            with self.subTest(options=options), \
                    mock.patch.object(finish, "named_pr_merged", return_value=(True, "")), \
                    mock.patch.object(finish, "cleanup") as cleanup:
                with self.assertRaisesRegex(ValueError, "handoff"):
                    herdr_coord._cleanup(ops=object(), **options)
                cleanup.assert_not_called()
                self.assertEqual(registry.load(), before)

    def test_bare_cleanup_sweeps_only_the_caller_lane(self):
        registry.update(lambda doc: doc["workers"].update({"w-seo": {
            "worker_id": "w-seo", "issue": 4, "agent_name": "a-seo", "state": "done", "lane": "seo"}}))
        seen = []
        with mock.patch.object(finish, "cleanup", side_effect=lambda worker, *, ops:
                               seen.append(worker["worker_id"]) or {"cleaned": True}):
            herdr_coord._cleanup(lane="seo", ops=object())
        self.assertEqual(seen, ["w-seo"])
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "done")
        self.assertEqual(registry.load()["workers"]["w-seo"]["state"], "cleaned")

    def test_cleanup_cli_passes_the_resolved_lane(self):
        context = {"lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
                   "controller": {"agent": "claude", "kind": "id", "value": "coordinator-session"},
                   "source": "tab label"}
        with mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=context), \
                mock.patch.object(herdr_coord, "_cleanup", return_value={}) as cleanup, \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(herdr_coord.main(["cleanup", "--abandon", "a-run"]), 0)
        cleanup.assert_called_once_with("a-run", merged_pr=None, lane="seo")

    def test_refusal_leaves_state_unchanged(self):
        with mock.patch.object(finish, "cleanup", lambda worker, *, ops: {"cleaned": False, "reason": "PR open"}):
            result = herdr_coord._cleanup(ops=object())
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "done")
        self.assertEqual(result["results"], [{"issue": 1, "cleaned": False, "reason": "PR open"}])
        self.assertEqual(registry.read_events(0), [])

    def test_abandon_marks_a_running_worker_eligible(self):
        seen = []

        def fake_cleanup(worker, *, ops):
            seen.append((worker["worker_id"], worker.get("abandoned")))
            return {"cleaned": False, "reason": "agent alive"}

        with mock.patch.object(finish, "cleanup", fake_cleanup):
            herdr_coord._cleanup("a-run", ops=object())
        self.assertIn(("w-running", True), seen)

    def test_merged_pr_marks_a_finished_worker_eligible_after_verifying_it(self):
        registry.update(lambda doc: doc["workers"].update({"w-ended": {
            "worker_id": "w-ended", "issue": 308, "agent_name": "a-ended", "state": "ended_without_proof",
            "repo_path": self.home.name}}))

        def fake_merged(worker, number, ops):
            return (number == 309, "" if number == 309 else f"PR #{number} is not merged")

        seen = []

        def fake_cleanup(worker, *, ops):
            seen.append(worker["worker_id"])
            return {"cleaned": True, "reason": "ok"}

        with mock.patch.object(finish, "named_pr_merged", fake_merged), \
                mock.patch.object(finish, "cleanup", fake_cleanup):
            with self.assertRaisesRegex(ValueError, "not merged"):
                herdr_coord._cleanup(merged_pr=("a-ended", "310"), ops=object())
            self.assertNotIn("merged_pr_named", registry.load()["workers"]["w-ended"])
            self.assertEqual(seen, [])
            with self.assertRaisesRegex(ValueError, "only a finished or lost worker"):
                herdr_coord._cleanup(merged_pr=("a-run", "309"), ops=object())
            with self.assertRaisesRegex(ValueError, "must be a number"):
                herdr_coord._cleanup(merged_pr=("a-ended", "abc"), ops=object())
            herdr_coord._cleanup(merged_pr=("a-ended", "#309"), ops=object())
        worker = registry.load()["workers"]["w-ended"]
        self.assertEqual((worker["pr"], worker["merged_pr_named"], worker["state"]), (309, True, "cleaned"))
        self.assertEqual(seen, ["w-ended"])  # the named worker only; w-done waits for a bare cleanup
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "done")

    def test_a_named_cleanup_never_sweeps_another_worker(self):
        # boon-town, 2026-10-20: `cleanup --merged-pr boon-town-2458-4e760b 2467` also cleaned #2394,
        # parked on purpose in ended_without_proof with measurements still to run.
        registry.update(lambda doc: doc["workers"].update({
            "w-parked": {"worker_id": "w-parked", "issue": 2394, "agent_name": "a-parked",
                         "state": "ended_without_proof", "abandoned": True},
            "w-named": {"worker_id": "w-named", "issue": 2458, "agent_name": "a-named", "state": "done"}}))
        seen = []

        def fake_cleanup(worker, *, ops):
            seen.append(worker["worker_id"])
            return {"cleaned": True, "reason": "ok"}

        with mock.patch.object(finish, "cleanup", fake_cleanup), \
                mock.patch.object(finish, "named_pr_merged", lambda worker, number, ops: (True, "")):
            for options, expected in (({"merged_pr": ("a-named", "2467")}, ["w-named"]),
                                      ({"abandon": "a-run"}, ["w-running"])):
                with self.subTest(options=options):
                    seen.clear()
                    result = herdr_coord._cleanup(ops=object(), **options)
                    self.assertEqual(seen, expected)
                    self.assertEqual(len(result["results"]), 1)
            with self.assertRaisesRegex(ValueError, "not both"):
                herdr_coord._cleanup("a-run", merged_pr=("a-named", "2467"), ops=object())
            self.assertEqual(registry.load()["workers"]["w-parked"]["state"], "ended_without_proof")
            self.assertEqual(registry.load()["workers"]["w-done"]["state"], "done")
            seen.clear()
            herdr_coord._cleanup(ops=object())  # the bare form still sweeps
            self.assertEqual(sorted(seen), ["w-done", "w-parked"])

    def test_status_says_when_a_failed_start_left_its_session_open(self):
        # boon-town #2422: a failed start's session sat idle for four days; status read "start_failed PR=-".
        worker = {"worker_id": "w", "issue": 2422, "agent_name": "a-2422", "state": "start_failed"}

        class Ops:
            def __init__(self, result):
                self.result = result

            def herdr(self, *args, timeout=None):
                if isinstance(self.result, Exception):
                    raise self.result
                return self.result

        from test_finish import failure, success
        self.assertIn("budget spent", herdr_coord._start_failed_session(
            worker, Ops(AssertionError("no probe once the budget is spent")), deadline=0))
        for result, expected in ((success({"result": {"agent": {"agent_status": "idle"}}}), "session=OPEN"),
                                 (failure("No agent occupies the pane", "agent_not_found"), "session=closed"),
                                 (failure("HTTP 503"), "session=unknown"),
                                 (TimeoutError("slow"), "session=unknown")):
            with self.subTest(expected=expected):
                self.assertTrue(herdr_coord._start_failed_session(worker, Ops(result)).startswith(expected))

    def test_cleanup_claims_the_worker_so_a_watcher_transition_cannot_revive_it(self):
        # Codex review, 2026-10-13: a watcher reopen or quota resume between cleanup's checks and
        # the window close would have been closed anyway, then overwritten with `cleaned`.
        registry.update(lambda doc: doc["workers"]["w-done"].update(state_token="done-token"))
        states = []

        def racing_cleanup(worker, *, ops):
            states.append(registry.load()["workers"]["w-done"]["state"])
            # The watcher's reopen and quota resume both require the state they saw.
            actions.change_worker("w-done", "running", expected="done")
            states.append(registry.load()["workers"]["w-done"]["state"])
            self.assertIn("cleaning", watch.TERMINAL_STATES)
            return {"cleaned": True, "reason": "ok"}

        with mock.patch.object(finish, "cleanup", racing_cleanup):
            herdr_coord._cleanup(ops=object())
        self.assertEqual(states, ["cleaning", "cleaning"])
        worker = registry.load()["workers"]["w-done"]
        self.assertEqual(worker["state"], "cleaned")
        self.assertNotIn("cleanup_from", worker)

    def test_a_refused_cleanup_restores_the_claimed_state_and_token(self):
        registry.update(lambda doc: doc["workers"]["w-done"].update(state_token="done-token"))
        with mock.patch.object(finish, "cleanup", lambda worker, *, ops: {"cleaned": False, "reason": "busy"}):
            herdr_coord._cleanup(ops=object())
        worker = registry.load()["workers"]["w-done"]
        self.assertEqual((worker["state"], worker["state_token"]), ("done", "done-token"))
        self.assertNotIn("cleanup_from", worker)

    def test_a_worker_that_changed_before_the_claim_is_not_cleaned(self):
        stale = dict(registry.load()["workers"]["w-done"], state_token="old-token")
        registry.update(lambda doc: doc["workers"]["w-done"].update(state_token="new-token"))
        self.assertFalse(herdr_coord._claim_for_cleanup(stale))
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "done")

    def test_an_interrupted_cleanup_resumes_from_the_claimed_state(self):
        registry.update(lambda doc: doc["workers"]["w-done"].update(
            state="cleaning", state_token="claim", cleanup_from={"state": "done", "state_token": "done-token"}))
        seen = []

        def fake_cleanup(worker, *, ops):
            seen.append(worker["state"])
            return {"cleaned": True, "reason": "ok"}

        with mock.patch.object(finish, "cleanup", fake_cleanup):
            herdr_coord._cleanup(ops=object())
        self.assertEqual(seen, ["done"])
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "cleaned")

    def test_claim_owners_slots_and_merged_pr_tokens(self):
        # Decision table from the delta review of the claim (2026-10-13), closed by test.
        import start

        def cleaning(owner, claimed_state="done"):
            registry.update(lambda doc: doc["workers"]["w-done"].update(
                state="cleaning", state_token="claim-a",
                cleanup_from={"state": claimed_state, "state_token": "done-token", "owner": owner}))

        seen = []

        def fake_cleanup(worker, *, ops):
            seen.append(worker["state"])
            return {"cleaned": True, "reason": "ok"}

        # 1. A live owner's claim is left alone; a dead owner's claim is taken over.
        cleaning(start._process_identity(os.getpid()))
        with mock.patch.object(finish, "cleanup", fake_cleanup):
            result = herdr_coord._cleanup(ops=object())
        self.assertEqual(seen, [])
        self.assertIn("in progress", result["results"][0]["reason"])
        self.assertEqual(registry.load()["workers"]["w-done"]["state_token"], "claim-a")
        cleaning({"pid": os.getpid(), "created": 0})
        with mock.patch.object(finish, "cleanup", fake_cleanup):
            herdr_coord._cleanup(ops=object())
        self.assertEqual((seen, registry.load()["workers"]["w-done"]["state"]), (["done"], "cleaned"))
        # A release by a claim that no longer holds the worker changes nothing.
        cleaning(None)
        herdr_coord._release_cleanup_claim("w-done", "someone-else", cleaned=False)
        self.assertEqual(registry.load()["workers"]["w-done"]["state"], "cleaning")
        # 2. A claimed worker keeps the slot it held.
        cleaning(None, claimed_state="quota_wait")
        self.assertEqual(start._slots(registry.load()), 2)  # w-running plus the claimed quota_wait
        cleaning(None, claimed_state="done")
        self.assertEqual(start._slots(registry.load()), 1)
        # 3. A merged-PR mark covers only the settle it was named for.
        worker = {"merged_pr_named": True, "merged_pr_token": "t1", "state_token": "t1"}
        self.assertTrue(finish.merged_pr_applies(worker))
        self.assertFalse(finish.merged_pr_applies({**worker, "state_token": "t2"}))
        registry.update(lambda doc: doc["workers"].update({"w-marked": {
            "worker_id": "w-marked", "issue": 9, "agent_name": "a-marked", "state": "ended_without_proof",
            "state_token": "t2", "merged_pr_named": True, "merged_pr_token": "t1", "pr": 9}}))
        seen.clear()
        with mock.patch.object(finish, "cleanup", fake_cleanup):
            herdr_coord._cleanup(ops=object())
        self.assertEqual(registry.load()["workers"]["w-marked"]["state"], "ended_without_proof")

    def test_abandon_unknown_name_is_refused(self):
        with self.assertRaises(ValueError):
            herdr_coord._cleanup("nobody", ops=object())


if __name__ == "__main__":
    unittest.main()
