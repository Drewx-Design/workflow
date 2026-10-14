import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import os
import tempfile
import unittest
from unittest import mock

import actions
import finish
import herdr_coord
import registry
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
        self.assertEqual(sorted(seen), ["w-done", "w-ended"])

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
