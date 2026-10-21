from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(key, None)  # a suite run inside herdr must not resolve a real lane

from contextlib import contextmanager, redirect_stdout
import io
import json
import os
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock

import adapters
import herdr_coord
import registry
import repo_root
import start
import watch
from test_repo_root import RepoFixture
from test_start import FakeOps, herdr_identity, herdr_identity_command


CLI = Path(herdr_coord.__file__)


class MultiRepoTests(RepoFixture):
    def setUp(self):
        super().setUp()
        environment = dict(os.environ, HERDR_COORD_HERDR=json.dumps(herdr_identity_command()))
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            environment.pop(key, None)
        patcher = mock.patch.dict(os.environ, environment, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        identity = mock.patch.object(adapters, "herdr", side_effect=herdr_identity)
        identity.start()
        self.addCleanup(identity.stop)
        # Never spawn a real detached watcher from a test (test_watcher_guard covers this path).
        no_watcher = mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None)
        no_watcher.start()
        self.addCleanup(no_watcher.stop)
        self.a = self.make_repo("A")
        self.b = self.make_repo("B")

    @contextmanager
    def state(self, repo):
        with mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(repo_root.state_root(repo))}):
            yield

    def cli(self, *args, repo=None):
        # Each invocation models a fresh CLI process; a prior invocation's derived
        # HOME must not masquerade as an explicit override on the next one.
        with mock.patch.dict(os.environ), redirect_stdout(io.StringIO()) as output:
            os.environ.pop("HERDR_COORD_HOME", None)
            argv = list(args)
            if repo is not None:
                argv.extend(["--repo", str(repo)])
            code = herdr_coord.main(argv)
        return code, output.getvalue()

    def cli_process(self, *args, cwd=None, home=None):
        env = dict(os.environ)
        env.pop("HERDR_COORD_HOME", None)
        if home is not None:
            env["HERDR_COORD_HOME"] = str(home)
        return subprocess.run(
            [sys.executable, str(CLI), *map(str, args)], cwd=cwd or self.root,
            env=env, capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def load(self, repo):
        with self.state(repo):
            return registry.load()

    @contextmanager
    def fake_workers(self):
        projects = self.root / "projects"
        ops = FakeOps(projects)
        for issue in (12, 13, 14, 15):
            ops.issue(issue)
        # Exercise real start/admission/persistence with the existing external-op
        # fakes. Both repositories share this one fake herdr server.
        with mock.patch.object(start, "PROJECTS_ROOT", projects), \
                mock.patch.object(adapters, "git", side_effect=ops.git), \
                mock.patch.object(adapters, "gh", side_effect=ops.gh), \
                mock.patch.object(adapters, "herdr", side_effect=ops.herdr):
            yield ops

    def test_both_repositories_start_issue_12_and_status_is_isolated(self):
        with self.fake_workers():
            for repo in (self.a, self.b):
                code, output = self.cli("start", str(repo), "12")
                self.assertEqual(code, 0, output)
                self.assertEqual(json.loads(output)["state"], "running", output)
        a = next(iter(self.load(self.a)["workers"].values()))
        b = next(iter(self.load(self.b)["workers"].values()))
        self.assertNotEqual(a["worker_id"], b["worker_id"])
        self.assertNotEqual(a["agent_name"], b["agent_name"])
        for repo, worker in ((self.a, a), (self.b, b)):
            self.assertRegex(worker["agent_name"], rf"^{repo_root.slug(repo)}-12-[0-9a-f]{{6}}$")
            self.assertTrue((repo_root.state_root(repo) / "registry.json").is_file())
            self.assertEqual(len(self.load(repo)["workers"]), 1)
        result = self.cli_process("status", cwd=self.a)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], f"repo: A ({self.a})")
        self.assertIn(a["agent_name"], result.stdout)
        self.assertNotIn(b["agent_name"], result.stdout)
        self.assertFalse((self.base / "registry.json").exists())

    def test_status_uses_explicit_repository_even_without_workers(self):
        code, output = self.cli("status", repo=self.b)
        self.assertEqual(code, 0, output)
        self.assertEqual(output.splitlines()[0], f"repo: B ({self.b})")

    def test_status_with_caller_home_names_state_root_without_resolving_repo(self):
        home = self.root / "explicit home"
        with mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(home)}), \
                mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("must skip resolution")), \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(herdr_coord.main(["status", "--repo", str(self.a)]), 0)
        self.assertEqual(output.getvalue().splitlines()[0], f"repo: (state root {home})")

    def test_two_consumers_do_not_share_ack_cursor(self):
        with self.state(self.b):
            registry.append_event("question", {"worker_id": "b", "question": "Choose B?"})
            b_ack = registry.load()["lanes"]["main"]["ack_seq"]
        with self.state(self.a):
            for number in range(30):
                registry.append_event("progress", {"step": number})
            high_seq = registry.read_events(0)[-1]["seq"]
        code, output = self.cli("ack", str(high_seq), repo=self.a)
        self.assertEqual(code, 0, output)
        self.assertEqual(self.load(self.a)["lanes"]["main"]["ack_seq"], high_seq)
        self.assertEqual(self.load(self.b)["lanes"]["main"]["ack_seq"], b_ack)
        with mock.patch.object(watch, "watcher_alive", return_value=True), \
                mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt):
            code, output = self.cli("follow", repo=self.b)
        self.assertEqual(code, 0, output)
        events = [json.loads(line) for line in output.splitlines()]
        self.assertEqual([event["kind"] for event in events], ["question"])
        self.assertEqual(events[0]["payload"]["question"], "Choose B?")
        self.assertEqual(self.load(self.b)["lanes"]["main"]["ack_seq"], b_ack)

    def test_handoff_splits_follow_history_without_touching_another_repository(self):
        from test_actions import AGENTS, FakeOps as ActionOps

        ops = ActionOps(self.root / "handoff-projects")
        ops.sessions["worker"] = "session-1"
        workspace_id = AGENTS["idle"]["workspace_id"]
        ops.workspace_labels[workspace_id] = "A #7"
        for repo in (self.a, self.b):
            with self.state(repo):
                registry.create_lane("seo")
                registry.update(lambda doc: doc["workers"].update(worker={
                    "worker_id": "worker", "agent_name": "worker", "issue": 7,
                    "repo_path": str(repo), "workspace_id": "stale", "pane_id": "stale",
                    "session_id": "session-1", "state": "question", "state_token": "q1",
                    "question_text": "Choose A?", "lane": "main"}))
                registry.append_event("worker_state", {"worker_id": "worker", "question_text": "Before move"})
        b_before = self.load(self.b)
        with mock.patch.object(adapters, "herdr", side_effect=ops.herdr):
            code, output = self.cli("handoff", "worker", "seo", repo=self.a)
        self.assertEqual(code, 0, output)
        self.assertEqual(ops.renames, [("workspace", "rename", workspace_id, "A seo #7")])
        self.assertEqual(self.load(self.b), b_before)
        contexts = {lane: {"lane": lane, "tab_id": f"w1:{lane}", "pane_id": f"w1:{lane}:p1",
                           "workspace_id": "w1", "controller": {
                               "agent": "claude", "kind": "id", "value": f"{lane}-coordinator-session"},
                           "source": "tab label"} for lane in ("main", "seo")}
        with self.state(self.a):
            registry.append_event("worker_state", {"worker_id": "worker", "question_text": "After move"})
            registry.update(lambda doc: doc["tab_bindings"].update({context["tab_id"]: {
                "lane": context["lane"], "controller": context["controller"], "pane_id": context["pane_id"],
                "label_seen": context["lane"], "source": context["source"], "explicit": False}
                for context in contexts.values()}))
        for lane, expected in (("main", ["Before move", None]), ("seo", [None, "After move"])):
            with self.subTest(lane=lane), \
                    mock.patch.object(herdr_coord.lanes, "resolve_context", return_value=contexts[lane]), \
                    mock.patch.object(watch, "watcher_alive", return_value=True), \
                    mock.patch.object(watch, "watcher_slow", return_value=False), \
                    mock.patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt):
                code, output = self.cli("follow", repo=self.a)
            self.assertEqual(code, 0, output)
            events = [json.loads(line) for line in output.splitlines()]
            self.assertEqual([e["payload"].get("question_text") if e["kind"] != "worker_handoff" else None
                              for e in events], expected)
            self.assertEqual(len([e for e in events if e["kind"] == "worker_handoff"]), 1)
        self.assertEqual(self.load(self.a)["lanes"]["main"]["ack_seq"], 0)
        self.assertEqual(self.load(self.a)["lanes"]["seo"]["ack_seq"], 0)

    def test_cap_is_per_repository(self):
        with self.fake_workers():
            for repo in (self.a, self.b):
                code, output = self.cli("start", str(repo), "12", "13", "14")
                self.assertEqual(code, 0, output)
                self.assertEqual([json.loads(line)["state"] for line in output.splitlines()],
                                 ["running"] * 3)
            b_before = self.load(self.b)
            code, output = self.cli("start", str(self.a), "15")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output)["state"], "queued")
        self.assertEqual([worker["issue"] for worker in self.load(self.a)["queue"]], [15])
        self.assertEqual(self.load(self.b), b_before)
        self.assertEqual(len(b_before["workers"]), 3)
        self.assertEqual(b_before["queue"], [])

    def test_go_clears_only_selected_repository_hold(self):
        for repo in (self.a, self.b):
            with self.state(repo):
                registry.update(lambda doc: doc["holds"].update(watcher_lost={"ts": 1}))
        code, output = self.cli("go", repo=self.a)
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output)["cleared"], {"watcher_lost": {"ts": 1}})
        self.assertEqual(self.load(self.a)["holds"], {})
        self.assertEqual(self.load(self.b)["holds"], {"watcher_lost": {"ts": 1}})

    def test_worktree_cwd_uses_main_checkout_root(self):
        worktree = self.make_worktree(self.a)
        result = self.cli_process("config", "set", "cap", "2", cwd=worktree)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.load(self.a)["config"]["cap"], 2)
        self.assertFalse(repo_root.state_root(worktree).exists())
        with mock.patch.object(start, "start_issues", return_value=[]) as run:
            code, output = self.cli("start", str(worktree), "12", repo=self.a)
        self.assertEqual(code, 0, output)
        run.assert_called_once_with(str(self.a), [12], lane="main")

    def test_outside_repository_refuses_and_names_repo_option(self):
        result = self.cli_process("status")
        self.assertEqual(result.returncode, 1, result.stderr)
        refusal = json.loads(result.stdout)
        self.assertEqual(refusal["state"], "refused")
        self.assertIn("--repo", refusal["detail"])
        self.assertFalse(self.base.exists())

    def test_start_conflicting_repository_refuses_before_start(self):
        with mock.patch.object(start, "start_issues") as run:
            code, output = self.cli("start", str(self.a), "12", repo=self.b)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["state"], "refused")
        self.assertIn("--repo", json.loads(output)["detail"])
        run.assert_not_called()
        self.assertFalse(self.base.exists())

    def test_launch_inherits_each_root_and_lock_is_per_repository(self):
        real_popen = subprocess.Popen
        spawns = []

        def fake_popen(argv, **kwargs):
            if len(argv) > 1 and argv[1] == str(Path(watch.__file__).resolve()):
                env = kwargs.get("env", os.environ)
                spawns.append((list(argv), dict(env), kwargs))
                return SimpleNamespace(pid=100 + len(spawns))
            return real_popen(argv, **kwargs)

        with mock.patch.object(watch.subprocess, "Popen", side_effect=fake_popen):
            code, output = self.cli("launch-watcher", repo=self.a)
            self.assertEqual(code, 0, output)
            self.assertEqual(json.loads(output)["state"], "launched")
            with self.state(self.a), watch.watcher_lock() as acquired:
                self.assertTrue(acquired)
                code, output = self.cli("launch-watcher", repo=self.a)
                self.assertEqual(code, 0, output)
                self.assertEqual(json.loads(output)["state"], "already_running")
                code, output = self.cli("launch-watcher", repo=self.b)
                self.assertEqual(code, 0, output)
                self.assertEqual(json.loads(output)["state"], "launched")
        self.assertEqual(len(spawns), 2)
        for spawn, repo in zip(spawns, (self.a, self.b)):
            self.assertEqual(spawn[0][2:], ["run"])
            self.assertEqual(spawn[1]["HERDR_COORD_HOME"], str(repo_root.state_root(repo)))
            self.assertEqual(spawn[1]["HERDR_COORD_REPO"], str(repo))
            self.assertEqual(Path(spawn[2]["stdout"].name).parent, repo_root.state_root(repo))

    def test_existing_home_is_preserved_inside_repository(self):
        home = self.root / "explicit home"
        result = self.cli_process("config", "set", "cap", "2", cwd=self.a, home=home)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((home / "registry.json").is_file())
        self.assertFalse(self.base.exists())
        with mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(home)}), \
                mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("must skip resolution")), \
                mock.patch.object(start, "start_issues", return_value=[]) as run, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(herdr_coord.main(["start", str(self.a), "12", "--repo", str(self.b)]), 0)
            self.assertEqual(os.environ["HERDR_COORD_HOME"], str(home))
            run.assert_called_once_with(str(self.a), [12], lane="main")

    def test_config_set_and_show_are_repository_local(self):
        b_before = self.load(self.b)
        code, output = self.cli("config", "set", "cap", "2", repo=self.a)
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output)["cap"], 2)
        code, output = self.cli("config", "--repo", str(self.a), "show")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output), self.load(self.a)["config"])
        self.assertEqual(self.load(self.b), b_before)
        self.assertFalse((self.base / "registry.json").exists())

    def test_config_valid_values(self):
        for key, value, expected in (
            ("cap", "1", 1),
            ("permission_mode", "auto", "auto"),
            ("stall_after_seconds", "0.25", 0.25),
            ("no_ci_repos", json.dumps([str(self.a), str(self.b)]), [str(self.a), str(self.b)]),
            ("no_ci_repos", str(self.a), [str(self.a)]),
            ("no_ci_repos", f" {self.a} ; {self.b} ", [str(self.a), str(self.b)]),
            ("no_ci_repos", "[]", []),
        ):
            with self.subTest(key=key, value=value):
                code, output = self.cli("config", "set", key, value, repo=self.a)
                self.assertEqual(code, 0, output)
                self.assertEqual(self.load(self.a)["config"][key], expected)

    def test_config_invalid_values_refuse_without_mutating_config(self):
        before = self.load(self.a)
        for key, value in (
            ("nope", "1"), ("cap", "0"), ("cap", "-1"), ("cap", "1.5"),
            ("cap", "true"), ("stall_after_seconds", "0"), ("stall_after_seconds", "-1"),
            ("stall_after_seconds", "nan"), ("stall_after_seconds", "inf"),
            ("stall_after_seconds", "1e999"), ("stall_after_seconds", "abc"),
            ("no_ci_repos", "{}"), ("no_ci_repos", "null"), ("no_ci_repos", "[1]"),
            ("no_ci_repos", '["relative"]'), ("no_ci_repos", "invalid JSON"),
            ("no_ci_repos", ""), ("no_ci_repos", " ; "),
            ("no_ci_repos", f"{self.a};"), ("no_ci_repos", f";{self.a}"),
            ("no_ci_repos", f"{self.a};;{self.b}"), ("no_ci_repos", f"{self.a};relative"),
        ):
            with self.subTest(key=key, value=value):
                code, output = self.cli("config", "set", key, value, repo=self.a)
                self.assertEqual(code, 1, output)
                self.assertEqual(json.loads(output)["state"], "refused")
                self.assertEqual(self.load(self.a), before)
        self.assertFalse((repo_root.state_root(self.a) / "registry.json").exists())

    def test_every_coordinator_subcommand_accepts_repo(self):
        commands = (
            ["restart", "12"], ["launch-watcher"], ["watch-run"], ["follow"],
            ["event", "1"], ["ack", "1"], ["status"], ["nudge", "worker"], ["resume", "worker"],
            ["relay", "worker", "answer", "--token", "token"], ["go"], ["cleanup"],
            ["handoff", "worker", "seo"],
            ["config", "show"], ["config", "set", "cap", "2"],
        )
        for argv in commands:
            with self.subTest(argv=argv), mock.patch.object(herdr_coord, "_coordinator_command") as dispatch:
                def check_root(args):
                    self.assertEqual(os.environ["HERDR_COORD_HOME"], str(repo_root.state_root(self.a)))
                    self.assertEqual(args.lane, "main")
                    return 0
                dispatch.side_effect = check_root
                code, output = self.cli(*argv, repo=self.a)
                self.assertEqual(code, 0, output)
                dispatch.assert_called_once()

    def test_lane_bind_accepts_repo_at_both_parser_levels(self):
        fixture = Path(__file__).with_name("fixtures")
        pane = json.loads((fixture / "herdr-pane-get.json").read_text(encoding="utf-8"))["result"]["pane"]
        identity = {f"HERDR_{key.upper()}": pane[key] for key in ("workspace_id", "tab_id", "pane_id")}

        commands = (["lane", "--repo", str(self.a), "bind", "seo"],
                    ["lane", "bind", "seo", "--repo", str(self.a)])
        for argv in commands:
            with self.subTest(argv=argv), mock.patch.dict(os.environ, identity):
                code, output = self.cli(*argv)
                self.assertEqual(code, 0, output)
                self.assertEqual(json.loads(output)["lane"], "seo")
                binding = self.load(self.a)["tab_bindings"][pane["tab_id"]]
                self.assertEqual(binding["lane"], "seo")
                self.assertEqual(binding["controller"], {key: pane["agent_session"][key]
                                                       for key in ("agent", "kind", "value")})
        self.assertFalse((repo_root.state_root(self.b) / "registry.json").exists())

    def test_lane_bind_refuses_partial_identity_before_external_reads(self):
        with mock.patch.dict(os.environ, {"HERDR_WORKSPACE_ID": "w1"}), \
                mock.patch.object(adapters, "herdr", side_effect=AssertionError("partial identity must refuse")) as herdr:
            code, output = self.cli("lane", "bind", "seo", repo=self.a)
        self.assertEqual(code, 1, output)
        self.assertIn("Incomplete herdr identity", json.loads(output)["detail"])
        herdr.assert_not_called()
        self.assertFalse((repo_root.state_root(self.a) / "registry.json").exists())
        self.assertFalse((repo_root.state_root(self.b) / "registry.json").exists())


if __name__ == "__main__":
    unittest.main()
