import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import copy
import shutil
import tempfile
import unittest
from datetime import datetime, timezone

import adapters
import finish
import transcript


NOW = datetime(2026, 10, 6, 22, 0, tzinfo=timezone.utc).timestamp()
FIXTURE = Path(__file__).parent / "fixtures" / "session-probe-full.jsonl"


def success(data=None):
    return adapters.CommandResult(True, 0, "", "", data)


def failure(message, code="command_failed", data=None):
    return adapters.CommandResult(False, 1, "", message, data, code, message)


def pr(*, age=120, state="OPEN", number=42):
    created = datetime.fromtimestamp(NOW - age, timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "number": number, "state": state, "url": f"https://example.test/pull/{number}",
        "createdAt": created, "mergedAt": created if state == "MERGED" else None,
    }


def check(name="tests", bucket="pass"):
    return {"name": name, "state": "SUCCESS" if bucket == "pass" else "PENDING", "bucket": bucket}


def records_with_final(text):
    records, _ = transcript.read_records(FIXTURE)
    records = copy.deepcopy(records)
    for record in reversed(records):
        if record.get("type") != "assistant" or record.get("isSidechain", False) is not False:
            continue
        for block in record.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "text":
                block["text"] = text
                return records
    raise AssertionError("real fixture has no final assistant text")


class FakeOps:
    """Reject unexpected calls instead of invoking any external command."""

    def __init__(self):
        self.calls = []
        self.prs = success([pr()])
        self.checks = success([check()])
        self.agent = failure("No agent occupies the pane", "agent_not_found")
        self.close = success({"result": {}})
        self.remove = success({"result": {}})
        self.git_remove = success()
        self.git_list = None  # set by FinishTest: lists the worker's tree as registered
        self.git_status = success()
        self.git_diff = success()
        self.pr_view = success(pr(state="MERGED", number=309))

    def _reply(self, command, args, kwargs, result):
        self.calls.append((command, args, kwargs))
        if isinstance(result, Exception):
            raise result
        return result

    def gh(self, *args, **kwargs):
        if args[:2] == ("pr", "list"):
            return self._reply("gh", args, kwargs, self.prs)
        if args[:2] == ("pr", "checks"):
            return self._reply("gh", args, kwargs, self.checks)
        if args[:2] == ("pr", "view"):
            return self._reply("gh", args, kwargs, self.pr_view)
        raise AssertionError(f"unexpected gh command: {args}")

    def herdr(self, *args, **kwargs):
        replies = {
            ("agent", "get"): self.agent,
            ("workspace", "close"): self.close,
            ("worktree", "remove"): self.remove,
        }
        if args[:2] not in replies:
            raise AssertionError(f"unexpected herdr command: {args}")
        return self._reply("herdr", args, kwargs, replies[args[:2]])

    def git(self, *args, **kwargs):
        replies = {("worktree", "remove"): self.git_remove, ("status", "--porcelain"): self.git_status,
                   ("diff", "--name-only"): self.git_diff, ("worktree", "list"): self.git_list}
        if args[:2] not in replies:
            raise AssertionError(f"unexpected git command: {args}")
        return self._reply("git", args, kwargs, replies[args[:2]])


class FinishTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.worktree = self.root / "worker tree"
        self.repo.mkdir()
        self.worktree.mkdir()
        self.worker = {
            "worker_id": "repo#7", "issue": 7, "entry_command": "ce-work",
            "repo_path": str(self.repo), "worktree_path": str(self.worktree),
            "branch": "issue/7", "agent_name": "issue-7-probe", "workspace_id": "workspace-7",
        }
        self.ops = FakeOps()
        self.ops.git_list = self.listing(self.worktree)
        self.config = {}
        self.final = "Please tell me which product behavior you want."
        self.records = records_with_final(self.final)

    def verify(self):
        before = copy.deepcopy((self.worker, self.config, self.records))
        decision = finish.verify_done(self.worker, ops=self.ops, config=self.config, now=NOW, records=self.records)
        self.assertEqual((self.worker, self.config, self.records), before)
        self.assertEqual(set(decision), {"state", "pr", "url", "no_ci", "overdue", "detail", "final_message"})
        return decision

    def artifact(self, path="docs/brainstorms/x-requirements.md"):
        artifact = self.worktree / path
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("# Requirements\n", encoding="utf-8")
        return artifact

    def test_passing_checks_for_each_pr_entry_command(self):
        for command in ("ce-work", "/ce-debug", "lfg", "/compound-engineering:ce-work"):
            with self.subTest(command=command):
                self.worker["entry_command"] = command
                self.ops.calls.clear()
                result = self.verify()
                self.assertEqual(result["state"], "done")
                self.assertEqual(result["pr"], 42)
                self.assertEqual(result["url"], "https://example.test/pull/42")
                self.assertFalse(result["no_ci"])
                self.assertFalse(result["overdue"])
                self.assertIsNone(result["final_message"])
                self.assertEqual(self.ops.calls[0][1], (
                    "pr", "list", "--head", "issue/7", "--state", "all", "--json",
                    "number,state,url,createdAt,mergedAt",
                ))
                self.assertEqual(self.ops.calls[1][1], ("pr", "checks", "42", "--json", "name,state,bucket"))
                self.assertTrue(all(call[2]["cwd"] == str(self.repo) for call in self.ops.calls))

    def test_pending_checks_never_overdue_and_can_become_done(self):
        for age in (120, 3600, 7200):
            with self.subTest(age=age):
                self.ops.prs = success([pr(age=age)])
                self.ops.checks = success([check("build", "pass"), check("tests", "pending")])
                result = self.verify()
                self.assertEqual(result["state"], "awaiting_checks")
                self.assertFalse(result["overdue"])
                self.assertIsNone(result["final_message"])
        self.ops.checks = success([check()])
        self.assertEqual(self.verify()["state"], "done")

    def test_failing_checks_are_named_even_when_another_check_is_pending(self):
        self.ops.checks = success([check("unit tests", "fail"), check("lint", "fail"), check("deploy", "pending")])
        result = self.verify()
        self.assertEqual(result["state"], "ended_without_proof")
        self.assertIn("unit tests", result["detail"])
        self.assertIn("lint", result["detail"])
        self.assertEqual(result["final_message"], self.final)

    def test_cancelled_and_skipped_checks_do_not_prove_all_checks_passed(self):
        for bucket in ("cancel", "skipping"):
            with self.subTest(bucket=bucket):
                self.ops.checks = success([check("tests", bucket)])
                self.assertEqual(self.verify()["state"], "ended_without_proof")

    def test_declared_no_ci_requires_ten_minute_grace(self):
        self.config["no_ci_repos"] = [str(self.repo)]
        for response in (success([]), failure("no checks reported on branch"), failure("No checks were reported")):
            for age, state in ((540, "awaiting_checks"), (600, "done"), (660, "done")):
                with self.subTest(response=response, age=age):
                    self.ops.prs = success([pr(age=age)])
                    self.ops.checks = response
                    result = self.verify()
                    self.assertEqual(result["state"], state)
                    self.assertEqual(result["no_ci"], state == "done")
                    if state == "done":
                        self.assertIn("no CI", result["detail"])

    def test_undeclared_repo_with_empty_checks_waits_and_only_then_is_overdue(self):
        for age in (120, 3599, 3600, 7200):
            for response in (success([]), failure("no checks reported")):
                with self.subTest(age=age, response=response):
                    self.ops.prs = success([pr(age=age)])
                    self.ops.checks = response
                    result = self.verify()
                    self.assertEqual(result["state"], "awaiting_checks")
                    self.assertFalse(result["no_ci"])
                    self.assertEqual(result["overdue"], age >= 3600)

    def test_failed_check_lookup_never_counts_as_no_ci(self):
        for declared in (False, True):
            for age in (660, 3600):
                for response in (failure("HTTP 401"), failure("HTTP 503", data=[check()]), TimeoutError("timed out")):
                    with self.subTest(declared=declared, age=age, response=response):
                        self.config["no_ci_repos"] = [str(self.repo)] if declared else []
                        self.ops.prs = success([pr(age=age)])
                        self.ops.checks = response
                        result = self.verify()
                        self.assertEqual(result["state"], "awaiting_checks")
                        self.assertFalse(result["no_ci"])
                        self.assertEqual(result["overdue"], age >= 3600)
                        self.assertIn("lookup failed", result["detail"])

    def test_no_checks_text_must_be_in_stderr_not_stdout(self):
        self.config["no_ci_repos"] = [str(self.repo)]
        self.ops.prs = success([pr(age=660)])
        self.ops.checks = adapters.CommandResult(False, 1, "no checks reported", "HTTP 401")
        self.assertEqual(self.verify()["state"], "awaiting_checks")

    def test_malformed_check_response_and_missing_creation_time_cannot_prove_no_ci(self):
        self.config["no_ci_repos"] = [str(self.repo)]
        for data in (None, {}, [check(bucket="unknown")]):
            with self.subTest(data=data):
                self.ops.prs = success([pr(age=3600)])
                self.ops.checks = success(data)
                result = self.verify()
                self.assertEqual(result["state"], "awaiting_checks")
                self.assertTrue(result["overdue"])
        self.ops.prs.data[0]["createdAt"] = "invalid"
        self.ops.checks = success([])
        result = self.verify()
        self.assertEqual(result["state"], "awaiting_checks")
        self.assertFalse(result["overdue"])

    def test_no_ci_declaration_must_name_this_absolute_repository(self):
        self.ops.prs = success([pr(age=660)])
        self.ops.checks = success([])
        for declaration in ([str(self.worktree)], ["repo"], str(self.repo)):
            with self.subTest(declaration=declaration):
                self.config["no_ci_repos"] = declaration
                self.assertEqual(self.verify()["state"], "awaiting_checks")

    def test_brainstorm_existing_relative_and_absolute_artifacts(self):
        self.worker["entry_command"] = "ce-brainstorm"
        artifact = self.artifact()
        for named in ("docs/brainstorms/x-requirements.md", str(artifact), artifact.as_posix()):
            for wrap in ("{}", "`{}`"):
                with self.subTest(named=named, wrap=wrap):
                    self.records = records_with_final("Requirements saved to " + wrap.format(named) + ".")
                    result = self.verify()
                    self.assertEqual(result["state"], "done")
                    self.assertIsNone(result["pr"])
                    self.assertIsNone(result["url"])
                    self.assertEqual(self.ops.calls, [])

    def test_strategy_artifact_is_done_and_without_one_uses_the_pr(self):
        self.worker["entry_command"] = "ce-strategy"
        self.artifact("STRATEGY.md")
        self.records = records_with_final("Strategy written to STRATEGY.md.")
        # Changed in the worktree (uncommitted): done without a PR lookup.
        self.ops.git_status = success()
        self.ops.git_status.stdout = " M STRATEGY.md\n"
        result = self.verify()
        self.assertEqual(result["state"], "done")
        self.assertFalse([call for call in self.ops.calls if call[0] == "gh"])
        # Committed on the branch: diff against origin/main shows it.
        self.ops.calls.clear()
        self.ops.git_status = success()
        self.ops.git_diff = success()
        self.ops.git_diff.stdout = "STRATEGY.md\n"
        self.assertEqual(self.verify()["state"], "done")
        # A failed status with a non-empty diff is not proof.
        self.ops.calls.clear()
        self.ops.git_status = failure("not a git repository")
        self.assertTrue(self.verify()["state"] != "done" or
                        [call for call in self.ops.calls if call[0] == "gh"])
        self.assertTrue([call for call in self.ops.calls if call[0] == "gh"])
        diff_calls = [call for call in self.ops.calls if call[0] == "git" and call[1][0] == "diff"]
        self.assertEqual(diff_calls[0][1][2], "origin/main...HEAD")
        self.ops.git_status = success()
        # Pre-existing and untouched: not proof; falls through to the PR route.
        self.ops.calls.clear()
        self.ops.git_diff = success()
        result = self.verify()
        self.assertTrue([call for call in self.ops.calls if call[0] == "gh"])
        self.records = records_with_final("Strategy discussion finished; nothing saved yet.")
        self.ops.calls.clear()
        result = self.verify()
        self.assertNotEqual(result.get("reason"), "unsupported entry command")
        self.assertTrue([call for call in self.ops.calls if call[0] == "gh"])

    def test_brainstorm_html_and_paths_with_spaces(self):
        self.worker["entry_command"] = "ce-brainstorm"
        artifact = self.artifact("docs/my brainstorms/x requirements.html")
        for text in (f"Saved `{artifact}`", "Saved docs/my brainstorms/x requirements.html"):
            with self.subTest(text=text):
                self.records = records_with_final(text)
                self.assertEqual(self.verify()["state"], "done")

    def test_brainstorm_missing_outside_and_non_artifact_paths(self):
        self.worker["entry_command"] = "ce-brainstorm"
        outside = self.root / "outside-requirements.md"
        outside.write_text("# Outside", encoding="utf-8")
        other = self.artifact("docs/requirements.txt")
        directory = self.worktree / "directory.md"
        directory.mkdir()
        for named in ("docs/brainstorms/missing-requirements.md", str(outside), "../outside-requirements.md", str(other), str(directory)):
            with self.subTest(named=named):
                text = f"Saved `{named}`."
                self.records = records_with_final(text)
                result = self.verify()
                self.assertEqual(result["state"], "ended_without_proof")
                self.assertEqual(result["final_message"], text)
                self.assertEqual(self.ops.calls, [])

    def test_artifact_url_is_not_a_worktree_path(self):
        self.worker["entry_command"] = "ce-brainstorm"
        self.artifact()
        self.records = records_with_final("See https://example.test/docs/brainstorms/x-requirements.md")
        self.assertEqual(self.verify()["state"], "ended_without_proof")

    def test_artifact_extension_must_be_the_filename_extension(self):
        self.worker["entry_command"] = "ce-brainstorm"
        self.artifact()
        self.records = records_with_final("Saved docs/brainstorms/x-requirements.md.bak")
        self.assertEqual(self.verify()["state"], "ended_without_proof")

    def test_no_pr_returns_last_main_thread_assistant_text(self):
        self.ops.prs = success([])
        result = self.verify()
        self.assertEqual(result["state"], "ended_without_proof")
        self.assertEqual(result["final_message"], self.final)
        self.assertIsNone(result["pr"])
        self.assertEqual(len(self.ops.calls), 1)

    def test_closed_pr_is_not_done_proof(self):
        self.ops.prs = success([pr(state="CLOSED")])
        self.assertEqual(self.verify()["state"], "ended_without_proof")

    def test_merged_pr_is_done_and_records_proof_for_cleanup(self):
        self.ops.prs = success([pr(state="MERGED", number=40, age=200), pr(state="MERGED")])
        self.ops.checks = AssertionError("merged proof does not need check lookup")
        result = self.verify()
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["pr"], 42)
        self.assertEqual(result["url"], "https://example.test/pull/42")
        self.assertIn("merged", result["detail"])
        self.assertEqual(len(self.ops.calls), 1)
        self.worker.update(result)
        self.assertTrue(finish.cleanup(self.worker, ops=self.ops)["cleaned"])

    def test_selects_latest_open_pr_on_branch(self):
        self.ops.prs = success([pr(age=200, number=40), pr(age=120, number=42), pr(age=60, state="MERGED", number=43)])
        self.assertEqual(self.verify()["pr"], 42)

    def test_pr_lookup_failure_is_retried_without_claiming_proof(self):
        self.ops.prs = failure("HTTP 503")
        result = self.verify()
        self.assertEqual(result["state"], "awaiting_checks")
        self.assertIn("HTTP 503", result["detail"])
        self.assertEqual(len(self.ops.calls), 1)

    def test_cleanup_open_or_closed_pr_does_not_touch_workspace(self):
        for state in ("OPEN", "CLOSED"):
            with self.subTest(state=state):
                self.ops.prs = success([pr(state=state)])
                self.ops.calls.clear()
                result = finish.cleanup(self.worker, ops=self.ops)
                self.assertFalse(result["cleaned"])
                self.assertIn("not merged", result["reason"])
                self.assertEqual([call[0] for call in self.ops.calls], ["gh"])

    def test_cleanup_successful_agent_get_means_process_still_alive(self):
        self.ops.prs = success([pr(state="MERGED")])
        for status in ("working", "idle", "done"):
            with self.subTest(status=status):
                self.ops.calls.clear()
                self.ops.agent = success({"result": {"agent": {"status": status}}})
                result = finish.cleanup(self.worker, ops=self.ops)
                self.assertFalse(result["cleaned"])
                self.assertIn("still alive", result["reason"])
                self.assertEqual(len(self.ops.calls), 2)

    def test_cleanup_merged_exited_worker_closes_then_removes_without_force(self):
        self.ops.prs = success([pr(state="MERGED")])
        before = copy.deepcopy(self.worker)
        result = finish.cleanup(self.worker, ops=self.ops)
        self.assertTrue(result["cleaned"])
        self.assertEqual(self.worker, before)
        self.assertEqual([(call[0], call[1]) for call in self.ops.calls[1:]], [
            ("herdr", ("agent", "get", "issue-7-probe")),
            ("herdr", ("workspace", "close", "workspace-7")),
            ("herdr", ("worktree", "remove", "--workspace", "workspace-7")),
        ])
        self.assertTrue(self.worktree.exists())
        self.assertTrue(all("--force" not in call[1] and "branch" not in call[1] for call in self.ops.calls))

    def test_cleanup_abandoned_worker_needs_no_pr_but_still_requires_exit(self):
        self.worker["abandoned"] = True
        self.ops.prs = AssertionError("abandoned worker must not query GitHub")
        self.ops.agent = success({"result": {"agent": {}}})
        self.assertFalse(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
        self.ops.agent = failure("No agent occupies the pane", "agent_not_found")
        self.assertTrue(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
        self.assertTrue(all(call[0] != "gh" for call in self.ops.calls))

    def listing(self, *trees):
        return adapters.CommandResult(True, 0, "".join(f"worktree {Path(tree).as_posix()}\nHEAD abc\nbranch refs/heads/x\n\n"
                                                       for tree in (self.repo, *trees)), "", None)

    def test_cleanup_returns_worktree_remove_refusal_without_fallback(self):
        self.ops.prs = success([pr(state="MERGED")])
        self.ops.remove = failure("worktree is dirty", "dirty_worktree")
        result = finish.cleanup(self.worker, ops=self.ops)
        self.assertEqual(result, {"cleaned": False, "reason": "worktree is dirty"})
        self.assertEqual(len(self.ops.calls), 5)
        self.assertEqual([call[1][:2] for call in self.ops.calls if call[0] == "git"], [("worktree", "list")])
        self.assertTrue(self.worktree.exists())

    def test_cleanup_settles_a_removal_git_already_made(self):
        # Live 2026-10-14 (taste-swipe #37/#39): git unregistered the tree, then stopped at
        # "Directory not empty"; every later cleanup failed with "is not a working tree".
        self.ops.prs = success([pr(state="MERGED")])
        self.ops.close = failure("Workspace not found", "workspace_not_found")
        self.ops.git_remove = failure(f"fatal: '{self.worktree}' is not a working tree")
        self.ops.git_list = self.listing()
        (self.worktree / "node_modules" / "deep").mkdir(parents=True)
        result = finish.cleanup(self.worker, ops=self.ops)
        self.assertFalse(result["cleaned"])
        self.assertIn(f"the user deletes {self.worktree}", result["reason"])
        self.assertTrue((self.worktree / "node_modules" / "deep").exists())  # cleanup never deletes it
        shutil.rmtree(self.worktree)  # the user deletes the folder by hand
        result = finish.cleanup(self.worker, ops=self.ops)
        self.assertEqual(result, {"cleaned": True, "reason": "worktree was already removed; branch retained"})

    def test_cleanup_keeps_a_refusal_unless_git_says_the_tree_is_gone(self):
        self.ops.prs = success([pr(state="MERGED")])
        self.ops.close = failure("Workspace not found", "workspace_not_found")
        self.ops.git_remove = failure("Directory not empty")
        shutil.rmtree(self.worktree)
        moved = adapters.CommandResult(True, 0, f"worktree {self.repo.as_posix()}\nHEAD abc\nbranch refs/heads/main\n\n"
                                                f"worktree {(self.root / 'moved').as_posix()}\nHEAD abc\n"
                                                "branch refs/heads/issue/7\n\n", "", None)
        for label, listing in (("still registered", self.listing(self.worktree)),
                               ("moved, branch still checked out", moved),
                               ("git cannot list", failure("not a git repository"))):
            with self.subTest(label):
                self.ops.git_list = listing
                self.assertEqual(finish.cleanup(self.worker, ops=self.ops),
                                 {"cleaned": False, "reason": "Directory not empty"})

    def test_cleanup_workspace_already_gone_uses_git_from_repository(self):
        self.ops.prs = success([pr(state="MERGED")])
        self.ops.close = failure("Workspace not found", "workspace_not_found")
        self.assertTrue(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
        self.assertEqual(self.ops.calls[-1][0:2], ("git", ("worktree", "remove", str(self.worktree))))
        self.assertEqual(self.ops.calls[-1][2]["cwd"], str(self.repo))
        self.assertTrue(all("--force" not in call[1] for call in self.ops.calls))

    def test_cleanup_git_fallback_refusal_is_returned(self):
        self.ops.prs = success([pr(state="MERGED")])
        self.ops.close = failure("Workspace not found", "workspace_not_found")
        self.ops.git_remove = failure("contains modified files")
        self.assertEqual(finish.cleanup(self.worker, ops=self.ops), {"cleaned": False, "reason": "contains modified files"})

    def test_cleanup_uncertain_agent_exit_and_close_failure_are_refusals(self):
        self.ops.prs = success([pr(state="MERGED")])
        for response in (failure("herdr unavailable", "connection_error"), TimeoutError("agent lookup timed out")):
            with self.subTest(response=response):
                self.ops.calls.clear()
                self.ops.agent = response
                result = finish.cleanup(self.worker, ops=self.ops)
                self.assertFalse(result["cleaned"])
                self.assertEqual(len(self.ops.calls), 2)
        self.ops.agent = failure("No agent occupies the pane", "agent_not_found")
        self.ops.close = failure("workspace close refused", "close_refused")
        self.ops.calls.clear()
        self.assertEqual(finish.cleanup(self.worker, ops=self.ops), {"cleaned": False, "reason": "workspace close refused"})
        self.assertEqual(len(self.ops.calls), 3)

    def test_cleanup_checks_recorded_pr_instead_of_an_older_merged_pr(self):
        self.worker["pr"] = 42
        self.ops.prs = success([pr(state="MERGED", number=41), pr(number=42)])
        self.assertFalse(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
        self.assertEqual(len(self.ops.calls), 1)

    def alive(self, status):
        return success({"result": {"agent": {"agent_status": status}}})

    def test_cleanup_closes_an_idle_finished_worker_with_a_clean_worktree(self):
        # the user, 2026-10-13: cleanup may close a finished worker's window itself.
        self.ops.prs = success([pr(state="MERGED")])
        for state in ("done", "awaiting_merge", "ended_without_proof", "quota_wait"):
            for status in ("idle", "done"):
                with self.subTest(state=state, status=status):
                    self.worker["state"] = state
                    self.ops.agent = self.alive(status)
                    self.ops.calls.clear()
                    self.assertTrue(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
                    self.assertEqual([(call[0], call[1][:2]) for call in self.ops.calls[1:]], [
                        ("herdr", ("agent", "get")), ("git", ("status", "--porcelain")),
                        ("herdr", ("workspace", "close")), ("herdr", ("worktree", "remove")),
                    ])
                    self.assertEqual(self.ops.calls[2][2]["cwd"], str(self.worktree))

    def test_cleanup_never_closes_a_busy_agent_dirty_tree_or_unfinished_worker(self):
        self.ops.prs = success([pr(state="MERGED")])
        dirty = adapters.CommandResult(True, 0, " M notes.md\n", "")
        cases = (
            ("done", "working", success(), "agent is working"),
            ("done", "blocked", success(), "agent is blocked"),
            ("done", None, success(), "unknown state"),
            ("done", "idle", dirty, "uncommitted changes"),
            ("done", "idle", failure("not a git repository"), "cannot confirm the worktree is clean"),
            ("running", "idle", success(), "still alive"),
            ("lost", "idle", success(), "still alive"),
        )
        for state, status, git_status, reason in cases:
            with self.subTest(state=state, status=status, reason=reason):
                self.worker["state"] = state
                self.ops.agent = self.alive(status)
                self.ops.git_status = git_status
                self.ops.calls.clear()
                result = finish.cleanup(self.worker, ops=self.ops)
                self.assertFalse(result["cleaned"])
                self.assertIn(reason, result["reason"])
                self.assertFalse([c for c in self.ops.calls
                                  if c[1][:2] in {("workspace", "close"), ("worktree", "remove")}])
        self.ops.git_status = success()
        self.worker.update(state="done", workspace_id=None)
        self.ops.agent = self.alive("idle")
        self.assertIn("no workspace", finish.cleanup(self.worker, ops=self.ops)["reason"])

    def test_cleanup_with_a_named_merged_pr_skips_the_branch_lookup(self):
        self.worker.update(state="ended_without_proof", pr=309, merged_pr_named=True)
        self.ops.prs = AssertionError("a named PR replaces the branch lookup")
        self.assertTrue(finish.cleanup(self.worker, ops=self.ops)["cleaned"])
        self.assertEqual(self.ops.calls[0][1][:3], ("pr", "view", "309"))
        for reply, reason in ((success(pr(state="OPEN", number=309)), "not merged"),
                              (success(pr(state="MERGED", number=310)), "invalid PR data"),
                              (failure("HTTP 503"), "HTTP 503")):
            with self.subTest(reason=reason):
                self.ops.pr_view = reply
                self.ops.calls.clear()
                result = finish.cleanup(self.worker, ops=self.ops)
                self.assertFalse(result["cleaned"])
                self.assertIn(reason, result["reason"])
                self.assertEqual(len(self.ops.calls), 1)

    def test_cleanup_failed_pr_lookup_does_not_touch_workspace(self):
        self.ops.prs = failure("HTTP 503")
        result = finish.cleanup(self.worker, ops=self.ops)
        self.assertFalse(result["cleaned"])
        self.assertIn("HTTP 503", result["reason"])
        self.assertEqual(len(self.ops.calls), 1)


if __name__ == "__main__":
    unittest.main()
