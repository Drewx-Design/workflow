"""Worker lifecycle with real git checkouts and simulated Herdr sessions."""

import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import pytest

import adapters
import herdr_coord
import registry
import start
from test_start import FakeOps, success


class WorkerOps(FakeOps):
    def __init__(self, projects):
        super().__init__(projects)
        self.session_ended = False

    def storage(self, *args, **kwargs):
        raise AssertionError("the retired storage manager must never be called")

    def git(self, *args, **kwargs):
        self.calls.append(("git", args, kwargs))
        assert args[:2] != ("worktree", "remove")
        return adapters.git(*args, **kwargs)

    def gh(self, *args, **kwargs):
        if args[:2] == ("pr", "list"):
            self.calls.append(("gh", args, kwargs))
            return success([{"number": 42, "state": "MERGED"}])
        return super().gh(*args, **kwargs)

    def herdr(self, *args, **kwargs):
        assert args[:2] != ("worktree", "remove")
        if args[:2] == ("workspace", "close"):
            self.calls.append(("herdr", args, kwargs))
            self.session_ended = True
            return success()
        result = super().herdr(*args, **kwargs)
        if args[:2] == ("agent", "get") and result.ok:
            result.data["result"]["agent"]["agent_status"] = "idle"
        return result


@pytest.fixture
def lifecycle(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test",
                    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"],
                   cwd=repo, check=True, capture_output=True)
    monkeypatch.setenv("HERDR_COORD_HOME", str(tmp_path / "state"))
    for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
        monkeypatch.delenv(key, raising=False)
    projects = tmp_path / "projects"
    monkeypatch.setattr(start, "PROJECTS_ROOT", projects)
    return repo, WorkerOps(projects)


def test_start_1234_creates_and_records_plain_git_worktree(lifecycle):
    repo, ops = lifecycle
    ops.issue(1234)
    worker = start.start_issues(repo, [1234], ops=ops)[0]
    path = repo.with_name("repo-wt-issue-1234")
    assert worker["state"] == "running", worker
    assert path.is_dir()
    assert adapters.git("branch", "--show-current", cwd=path).stdout.strip() == "issue/1234"
    assert [(args, kwargs["cwd"]) for kind, args, kwargs in ops.calls
            if kind == "git" and args[:2] == ("worktree", "add")] == [
                (("worktree", "add", "-b", "issue/1234", str(path)), str(repo))]
    saved = registry.load()["workers"][worker["worker_id"]]
    assert saved["worktree_path"] == str(path)
    assert saved["branch"] == "issue/1234"
    assert all(saved[key] for key in ("workspace_id", "tab_id", "pane_id", "session_id"))
    assert "storage" not in saved


def finished_worker(lifecycle, *, dirty=False, legacy=False):
    repo, ops = lifecycle
    path = repo.with_name("repo-wt-issue-1234")
    assert adapters.git("worktree", "add", "-b", "issue/1234", str(path), cwd=repo).ok
    worker = {"worker_id": "repo#1234", "issue": 1234, "state": "done", "state_token": "finished-turn",
              "repo_path": str(repo), "worktree_path": str(path), "branch": "issue/1234",
              "agent_name": "worker", "workspace_id": "workspace-1", "pane_id": "pane-1",
              "session_id": "session-1", "lane": "main"}
    ops.agents["worker"] = "session-1"
    doc = registry.load()
    if legacy:
        worker["storage"] = {"taskId": "task", "checkoutId": "checkout", "claimId": "claim",
                             "leaseId": "lease", "nativeId": "native", "opId": "operation"}
    doc["workers"][worker["worker_id"]] = worker
    # Write the old shape directly, without a new writer normalizing it first.
    registry.save(doc)
    if dirty:
        (path / "keep.txt").write_text("uncommitted work", encoding="utf-8")
    loaded = registry.load()["workers"][worker["worker_id"]]
    assert all(loaded[key] == worker[key] for key in
               ("worktree_path", "branch", "session_id", "pane_id"))
    outcome = herdr_coord._cleanup(ops=ops)
    return worker, ops, outcome


def assert_retained_finish(worker, ops, outcome):
    assert outcome["results"][0]["cleaned"], outcome
    assert ops.session_ended
    assert Path(worker["worktree_path"]).is_dir()
    assert adapters.git("show-ref", "--verify", "refs/heads/issue/1234", cwd=worker["repo_path"]).ok
    saved = registry.load()["workers"][worker["worker_id"]]
    assert saved["state"] == "cleaned"
    assert all(saved[key] == worker[key] for key in ("worktree_path", "branch", "session_id", "pane_id"))
    assert registry.read_events(0)[-1]["kind"] == "worker_cleaned"
    assert not any(args[:2] == ("worktree", "remove") for _, args, _ in ops.calls)


def test_finish_merged_clean_worker_leaves_tree_and_branch(lifecycle):
    assert_retained_finish(*finished_worker(lifecycle))


def test_finish_merged_dirty_worker_leaves_tree_and_branch(lifecycle):
    worker, ops, outcome = finished_worker(lifecycle, dirty=True)
    assert_retained_finish(worker, ops, outcome)
    assert (Path(worker["worktree_path"]) / "keep.txt").read_text(encoding="utf-8") == "uncommitted work"


def test_old_registry_storage_bindings_load_and_finish(lifecycle):
    worker, ops, outcome = finished_worker(lifecycle, legacy=True)
    assert_retained_finish(worker, ops, outcome)
    saved = registry.load()["workers"][worker["worker_id"]]
    assert "storage" not in saved
    assert "storage_release" not in saved


def test_finish_output_reports_finished_and_nightly_sweep(lifecycle):
    _, _, outcome = finished_worker(lifecycle)
    message = json.dumps(outcome)
    assert "worker finished" in message
    assert "worktree left for the nightly sweep" in message


def test_storage_client_is_removed():
    assert not (Path(start.__file__).parent / "storage_client.py").exists()
