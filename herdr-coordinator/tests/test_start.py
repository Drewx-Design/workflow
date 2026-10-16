from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import copy
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from unittest import mock

import adapters
import herdr_coord
import registry
import start


FIXTURE = Path(__file__).parent / "fixtures" / "session-probe-full.jsonl"


def success(data=None):
    return adapters.CommandResult(True, 0, "", "", data)


def failure(code):
    return adapters.CommandResult(False, 1, "", "", None, code, code)


class FakeOps:
    def __init__(self, projects):
        self.projects = projects
        self.issues = {}
        self.calls = []
        self.agents = {}
        self.worktrees = []
        self.prompts = []
        self.escapes = []
        self.start_error = None
        self.start_errors = []
        self.prompt_error = None
        self.confirm = True
        self.drop_prompts = 0  # prompts typed before Claude takes input: no transcript at all
        self.pasted_entry = False
        self.recorded_mode = "auto"
        self.session_polls = 0
        self.worktree_error = None
        self.pending_path = None
        self.delay_path = False
        records = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]
        self.command_record = next(
            record for record in records
            if record.get("type") == "user"
            and isinstance(record.get("message", {}).get("content"), str)
            and "<command-name>" in record["message"]["content"]
        )
        self.mode_record = next(record for record in records if record.get("type") == "permission-mode")

    def issue(self, number, labels=None, body=""):
        self.issues[number] = {
            "number": number, "title": f"Issue {number}",
            "labels": [{"name": label} for label in (labels if labels is not None else ["ce:work"])],
            "body": body,
        }

    def gh(self, *args, **kwargs):
        self.calls.append(("gh", args, kwargs))
        return success(self.issues[int(args[2])])

    def git(self, *args, **kwargs):
        self.calls.append(("git", args, kwargs))
        if args[:2] == ("worktree", "add"):
            Path(args[4]).mkdir()
        return success()

    def herdr(self, *args, **kwargs):
        self.calls.append(("herdr", args, kwargs))
        if args[:2] == ("worktree", "create"):
            if self.worktree_error:
                return failure(self.worktree_error)
            path = Path(args[args.index("--path") + 1])
            self.worktrees.append(path)
            if self.delay_path:
                self.pending_path = path
            else:
                path.mkdir()
            index = len(self.worktrees)
            return success({"result": {
                "workspace": {"workspace_id": f"workspace-{index}", "worktree": {"checkout_path": str(path)}},
                "root_pane": {"pane_id": f"pane-{index}"},
            }})
        if args[:2] == ("workspace", "create"):
            return success({"result": {
                "workspace": {"workspace_id": "fallback-workspace"},
                "root_pane": {"pane_id": "fallback-pane"},
            }})
        if args[:2] == ("agent", "start"):
            if re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", args[2]) is None:
                return failure("invalid_agent_name")
            self.assert_path_exists(args)
            error = self.start_errors.pop(0) if self.start_errors else self.start_error
            if error:
                return failure(error)
            self.agents[args[2]] = f"session-{len(self.agents) + 1}"
            return success({"result": {"agent": {"name": args[2]}}})
        if args[:2] == ("agent", "prompt"):
            self.prompts.append(args)
            worker = next(worker for worker in registry.load()["workers"].values() if worker.get("agent_name") == args[2])
            action = registry.load()["actions"][worker["action_id"]]
            assert action["kind"] == "entry" and action["transcript_position"] == 0
            assert action["status"] == "delivery_unknown"
            assert args[3] == f"/{worker['entry_command']} {action['command_args']}"
            assert "--wait" not in args
            if self.prompt_error:
                error = self.prompt_error
                self.prompt_error = None
                return failure(error)
            if self.drop_prompts:
                self.drop_prompts -= 1
                return success()
            self.write_transcript(args[2], args[3])
            return success()
        if args[:2] == ("agent", "get"):
            if self.session_polls:
                self.session_polls -= 1
                return success({"result": {"agent": {}}})
            return success({"result": {"agent": {"agent_session": {"value": self.agents[args[2]]}}}})
        if args[:2] == ("agent", "send-keys"):
            self.escapes.append(args)
            return success()
        raise AssertionError(f"unexpected herdr command: {args}")

    def assert_path_exists(self, args):
        worker = next(
            worker for worker in registry.load()["workers"].values()
            if worker.get("pane_id") == args[args.index("--pane") + 1]
        )
        assert Path(worker["worktree_path"]).is_dir()

    def write_transcript(self, name, prompt):
        folder = self.projects / "fixture-project"
        folder.mkdir(parents=True, exist_ok=True)
        mode = copy.deepcopy(self.mode_record)
        mode["permissionMode"] = self.recorded_mode
        command = copy.deepcopy(self.command_record)
        command_name, _, command_args = prompt[1:].partition(" ")
        command["message"]["content"] = re.sub(
            r"<command-name>.*?</command-name>",
            lambda _: f"<command-name>/compound-engineering:{command_name}</command-name>",
            command["message"]["content"], flags=re.DOTALL,
        )
        command["message"]["content"] = re.sub(
            r"<command-args>.*?</command-args>",
            lambda _: f"<command-args>{command_args}</command-args>",
            command["message"]["content"], flags=re.DOTALL,
        )
        if self.pasted_entry:
            command["message"]["content"] = f'\n\n<pasted_content id="x">\n{prompt}\n</pasted_content>'
        records = [mode, command] if self.confirm else [mode]
        (folder / f"{self.agents[name]}.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
        )


class StartTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Never spawn a real detached watcher from a test (test_watcher_guard covers this path).
        no_watcher = mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None)
        no_watcher.start()
        self.addCleanup(no_watcher.stop)
        self.root = Path(temp.name)
        self.repo = self.root / "repo with spaces"
        self.repo.mkdir()
        self.projects = self.root / "projects"
        patcher = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.root / "state")})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in {
            "PROJECTS_ROOT": self.projects, "WORKTREE_TIMEOUT": 0.03,
            "AGENT_START_TIMEOUT": 0.03,
            "SESSION_TIMEOUT": 0.03, "DELIVERY_TIMEOUT": 0.03,
            "MODE_TIMEOUT": 0.03, "POLL_INTERVAL": 0.001,
        }.items():
            patcher = mock.patch.object(start, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.ops = FakeOps(self.projects)

    def workers(self):
        return list(registry.load()["workers"].values())

    def test_windows_process_identity_checks_liveness_and_creation_time(self):
        with mock.patch.object(os, "kill", side_effect=AssertionError("not a Windows liveness probe")):
            owner = start._start_owner()
            self.assertEqual(owner["pid"], os.getpid())
            self.assertGreater(owner["created"], 0)
            self.assertEqual(start._process_identity(os.getpid()), owner)
            with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL) as child:
                try:
                    identity = start._process_identity(child.pid)
                    self.assertEqual(identity["pid"], child.pid)
                    self.assertGreater(identity["created"], 0)
                finally:
                    child.communicate(timeout=10)
                self.assertIsNone(start._process_identity(child.pid))

    def test_agent_names_are_valid_for_repository_folder_names(self):
        for index, name in enumerate(("ordinary-repository-with-a-long-name", "2026-project",
                                     "!!!", "repo with spaces", "abcdefghijklmnopqrstuv-wxy"), 1):
            with self.subTest(name=name), mock.patch.dict(os.environ, {
                    "HERDR_COORD_HOME": str(self.root / f"state-{index}")}):
                repo = self.root / name
                repo.mkdir(exist_ok=True)
                self.ops.issue(index)
                worker = start.start_issues(repo, [index], ops=self.ops)[0]
                self.assertEqual(worker["state"], "running", worker)
                self.assertRegex(worker["agent_name"], r"^[a-z][a-z0-9_-]{0,31}$")
                prefix, issue, entropy = worker["agent_name"].rsplit("-", 2)
                self.assertFalse(prefix.endswith("-"))
                self.assertEqual(issue, str(index))
                self.assertRegex(entropy, r"^[0-9a-f]{6}$")

    def test_non_owner_phase_and_entry_updates_have_no_effect(self):
        self.ops.issue(1)
        with mock.patch.object(start, "_run_worker", side_effect=lambda worker, ops: worker):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        registry.update(lambda doc: doc["workers"][worker["worker_id"]].update(
            phase="agent_started", agent_name="owned-agent"))
        worker = self.workers()[0]
        before = registry.load()
        events = registry.read_events(0)
        calls = list(self.ops.calls)
        with mock.patch.object(start, "_start_owner", return_value={"pid": 123, "created": 456}):
            self.assertEqual(start._record(worker["worker_id"], "worker_phase", phase="command_sent"), worker)
            self.assertEqual(start._record(worker["worker_id"], "worker_start_failed", state="start_failed"), worker)
            self.assertEqual(start._send_entry(worker, self.ops), worker)
            self.assertEqual(start._run_worker(worker, self.ops), worker)
        self.assertEqual(registry.load(), before)
        self.assertEqual(registry.read_events(0), events)
        self.assertEqual(self.ops.calls, calls)

    def test_restart_refuses_holds_running_workers_and_full_capacity(self):
        self.ops.issue(1)
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        for state, hold, cap, reason in (
            ("running", False, 3, "start_interrupted"),
            ("starting", False, 3, "start_interrupted"),
            ("start_interrupted", True, 3, "hold is open"),
            ("start_interrupted", False, 0, "no slot"),
        ):
            with self.subTest(state=state, hold=hold, cap=cap):
                def setup(doc):
                    doc["workers"][worker["worker_id"]]["state"] = state
                    doc["holds"] = {"watcher_lost": True} if hold else {}
                    doc["config"]["cap"] = cap
                registry.update(setup)
                before, events, calls = registry.load(), registry.read_events(0), list(self.ops.calls)
                with self.assertRaisesRegex(ValueError, reason):
                    start.restart(worker["agent_name"], ops=self.ops)
                self.assertEqual(registry.load(), before)
                self.assertEqual(registry.read_events(0), events)
                self.assertEqual(self.ops.calls, calls)

    def test_cli_restart_dispatches_and_reports_refusal(self):
        with mock.patch.object(start, "restart", return_value={"state": "running"}) as restart, mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["restart", "#1"]), 0)
            restart.assert_called_once_with("#1")
            self.assertEqual(json.loads(output.getvalue()), {"state": "running"})
        with mock.patch.object(start, "restart", side_effect=ValueError("hold is open")), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["restart", "issue-1-agent"]), 1)
            self.assertEqual(json.loads(output.getvalue())["state"], "refused")

    def test_three_labelled_issues_start_with_resources_and_explicit_options(self):
        for number, label in enumerate(["ce:work", "ce:debug", "ce:lfg"], 1):
            self.ops.issue(number, [label])
        self.ops.session_polls = 2
        summaries = start.start_issues(self.repo, [1, 2, 3], ops=self.ops)
        self.assertEqual([item["state"] for item in summaries], ["running"] * 3)
        workers = self.workers()
        self.assertEqual(len(workers), 3)
        self.assertEqual(len({worker["agent_name"] for worker in workers}), 3)
        for worker in workers:
            self.assertEqual(worker["start_owner"], start._start_owner())
            self.assertEqual(worker["phase"], "mode_checked")
            self.assertTrue(worker["session_id"])
            self.assertTrue(worker["workspace_id"])
            self.assertTrue(worker["pane_id"])
            self.assertRegex(worker["agent_name"], r"^[a-z][a-z0-9_-]{0,31}$")
            self.assertRegex(worker["agent_name"], rf"^repo-with-spaces-{worker['issue']}-[0-9a-f]{{6}}$")
            self.assertEqual(worker["worker_id"], f"{os.path.normcase(str(self.repo.resolve()))}#{worker['issue']}")
            self.assertEqual(worker["branch"], f"issue/{worker['issue']}")
            self.assertEqual(Path(worker["worktree_path"]), self.root / f"{self.repo.name}-wt-issue-{worker['issue']}")
            self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivered")
        for kind, args, _ in self.ops.calls:
            if kind == "herdr" and args[:2] == ("agent", "start"):
                self.assertEqual(args[-5:], ("--", "--model", "claude-opus-5-5", "--permission-mode", "auto"))
            if kind == "herdr" and args[:2] == ("worktree", "create"):
                self.assertEqual(args[args.index("--base") + 1], "origin/main")
                issue = args[args.index("--branch") + 1].split("/")[-1]
                self.assertEqual(args[args.index("--label") + 1], f"repo with spaces #{issue}")
                self.assertIn("--no-focus", args)
        events = registry.read_events(0)
        self.assertEqual(len([event for event in events if event["kind"] == "worker_phase"]), 15)

    def test_queue_drains_exactly_once_after_slot_frees(self):
        for number in range(1, 5):
            self.ops.issue(number)
        summaries = start.start_issues(self.repo, range(1, 5), ops=self.ops)
        self.assertEqual([item["state"] for item in summaries], ["running"] * 3 + ["queued"])
        self.assertEqual(len(self.workers()), 3)
        self.assertEqual(len(registry.load()["queue"]), 1)
        self.assertIsNone(start.start_next_queued(ops=self.ops))
        worker_id = self.workers()[0]["worker_id"]
        registry.update(lambda doc: doc["workers"][worker_id].update(state="done"))
        result = start.start_next_queued(ops=self.ops)
        self.assertEqual(result["issue"], 4)
        self.assertEqual(result["phase"], "mode_checked")
        self.assertIsNone(start.start_next_queued(ops=self.ops))
        self.assertEqual(len(self.ops.prompts), 4)
        self.assertEqual(registry.load()["queue"], [])

    def test_unlabelled_issue_is_refused_and_batch_continues(self):
        self.ops.issue(1)
        self.ops.issue(2, [])
        self.ops.issue(3, ["ce:brainstorm"])
        summaries = start.start_issues(self.repo, [1, 2, 3], ops=self.ops)
        self.assertEqual([item["state"] for item in summaries], ["running", "refused", "running"])
        self.assertIn("no assigned CE entry command", summaries[1]["reason"])
        self.assertEqual(len(self.workers()), 2)

    def test_body_entry_beats_label_and_preserves_arguments(self):
        self.ops.issue(9, ["ce:work"], "Details\r\nCE entry: /ce-debug #9 flaky login /auth/callback\r\nMore")
        result = start.start_issues(self.repo, [9], ops=self.ops)[0]
        self.assertEqual(result["entry_command"], "ce-debug")
        self.assertEqual(result["entry_args"], "#9 flaky login /auth/callback")
        self.assertEqual(self.ops.prompts[0][3], "/ce-debug #9 flaky login /auth/callback")

    def test_ce_strategy_entry_from_label_or_body(self):
        # Requested live: taste-swipe #40 had "CE entry: /ce-strategy" and was refused.
        self.assertEqual(start.parse_entry_command(["ce:strategy"], ""), ("ce-strategy", ""))
        self.assertEqual(start.parse_entry_command([], "CE entry: /ce-strategy\n"), ("ce-strategy", ""))
        self.assertEqual(start.parse_entry_command([], "CE entry: /ce-strategy #40 taste\n"),
                         ("ce-strategy", "#40 taste"))

    def test_long_entry_sends_issue_reference_once_and_records_sent_args(self):
        args = "a" * 1300
        self.ops.issue(21, [], f"CE entry: /ce-brainstorm {args}")
        worker = start.start_issues(self.repo, [21, 21], ops=self.ops)[0]
        self.assertEqual([prompt[3] for prompt in self.ops.prompts], ["/ce-brainstorm #21"])
        self.assertEqual(worker["entry_args"], args)
        action = registry.load()["actions"][worker["action_id"]]
        self.assertEqual(action["command_args"], "#21")
        self.assertEqual(action["status"], "delivered")
        self.assertEqual(worker["state"], "running")

    def test_short_entry_keeps_thirty_character_args(self):
        args = "a" * 30
        self.ops.issue(21, [], f"CE entry: /ce-brainstorm {args}")
        worker = start.start_issues(self.repo, [21], ops=self.ops)[0]
        self.assertEqual([prompt[3] for prompt in self.ops.prompts], [f"/ce-brainstorm {args}"])
        self.assertEqual(worker["entry_args"], args)
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["command_args"], args)
        self.assertEqual(worker["state"], "running")

    def test_entry_args_length_boundary(self):
        for number, length in ((20, 200), (21, 201)):
            with self.subTest(length=length):
                args = "a" * length
                self.ops.issue(number, [], f"CE entry: /ce-brainstorm {args}")
                worker = start.start_issues(self.repo, [number], ops=self.ops)[0]
                sent_args = args if length == 200 else "#21"
                self.assertEqual(self.ops.prompts[-1][3], f"/ce-brainstorm {sent_args}")
                self.assertEqual(worker["entry_args"], args)
                self.assertEqual(registry.load()["actions"][worker["action_id"]]["command_args"], sent_args)
                self.assertEqual(worker["state"], "running")

    def test_entry_args_with_newline_send_issue_reference(self):
        for number, newline in ((21, "\n"), (22, "\r")):
            with self.subTest(newline=newline):
                args = f"first{newline}second"
                self.ops.issue(number)
                with mock.patch.object(start, "parse_entry_command", return_value=("ce-brainstorm", args)):
                    worker = start.start_issues(self.repo, [number], ops=self.ops)[0]
                self.assertEqual(self.ops.prompts[-1][3], f"/ce-brainstorm #{number}")
                self.assertEqual(worker["entry_args"], args)
                self.assertEqual(registry.load()["actions"][worker["action_id"]]["command_args"], f"#{number}")
                self.assertEqual(worker["state"], "running")

    def test_shortened_pasted_entry_is_confirmed(self):
        self.ops.pasted_entry = True
        self.ops.issue(21, [], f"CE entry: /ce-brainstorm {'a' * 1300}")
        worker = start.start_issues(self.repo, [21], ops=self.ops)[0]
        self.assertEqual([prompt[3] for prompt in self.ops.prompts], ["/ce-brainstorm #21"])
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivered")

    def test_parser_all_labels_body_and_default_args(self):
        for label, command in {
            "ce:work": "ce-work", "ce:debug": "ce-debug", "ce:lfg": "lfg", "ce:brainstorm": "ce-brainstorm",
        }.items():
            with self.subTest(label=label):
                self.assertEqual(start.parse_entry_command([label], ""), (command, ""))
        self.assertEqual(start.parse_entry_command(["ce:work"], "CE entry: /ce-debug #9 flaky login"), ("ce-debug", "#9 flaky login"))
        self.assertIsNone(start.parse_entry_command([], "CE entry: /other #1"))
        self.ops.issue(7, [], "CE entry: /ce-brainstorm")
        self.assertEqual(start.start_issues(self.repo, [7], ops=self.ops)[0]["entry_args"], "#7")

    def test_agent_not_ready_keeps_resources_without_recording_an_agent(self):
        self.ops.issue(1)
        self.ops.start_error = "agent_not_ready"
        with mock.patch.object(start.time, "sleep") as sleep:
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        sleep.assert_not_called()
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("agent_not_ready", worker["reason"])
        self.assertNotIn("agent_name", worker)
        self.assertTrue(worker["workspace_id"])
        self.assertTrue(Path(worker["worktree_path"]).exists())
        self.assertEqual(self.ops.agents, {})
        self.assertEqual(self.ops.prompts, [])
        attempts = [args for kind, args, _ in self.ops.calls if kind == "herdr" and args[:2] == ("agent", "start")]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(sum(event["kind"] == "worker_start_failed" for event in registry.read_events(0)), 1)

    def test_busy_pane_retries_silently_then_sends_one_prompt(self):
        self.ops.issue(1)
        self.ops.start_errors = ["agent_pane_busy", "agent_pane_busy"]

        def check_retry(_):
            worker = self.workers()[0]
            self.assertEqual(worker["state"], "starting")
            self.assertNotIn("reason", worker)
            self.assertFalse(any(event["kind"] == "worker_start_failed" for event in registry.read_events(0)))
            self.assertEqual(self.ops.prompts, [])

        with mock.patch.object(start.time, "monotonic", return_value=0), mock.patch.object(start.time, "sleep", side_effect=check_retry) as sleep:
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertNotIn("reason", worker)
        self.assertNotIn("reason", self.workers()[0])
        self.assertEqual(len(self.ops.prompts), 1)
        attempts = [args for kind, args, _ in self.ops.calls if kind == "herdr" and args[:2] == ("agent", "start")]
        self.assertEqual(len(attempts), 3)
        self.assertEqual(attempts, [attempts[0]] * 3)
        self.assertFalse(any(event["kind"] == "worker_start_failed" for event in registry.read_events(0)))

    def test_busy_pane_retry_deadline_fails_once_without_a_prompt(self):
        self.ops.issue(1)
        self.ops.start_error = "agent_pane_busy"
        elapsed = 0.0

        def advance(seconds):
            nonlocal elapsed
            self.assertEqual(self.workers()[0]["state"], "starting")
            self.assertFalse(any(event["kind"] == "worker_start_failed" for event in registry.read_events(0)))
            elapsed += seconds

        with mock.patch.object(start, "AGENT_START_TIMEOUT", 30.0), mock.patch.object(start, "POLL_INTERVAL", 0.25), mock.patch.object(start.time, "monotonic", side_effect=lambda: elapsed), mock.patch.object(start.time, "sleep", side_effect=advance):
            worker = start.start_issues(self.repo, [1, 1], ops=self.ops)[0]
        self.assertEqual(elapsed, 30.0)
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("agent_pane_busy", worker["reason"])
        self.assertEqual(worker["phase"], "worktree")
        self.assertNotIn("agent_name", worker)
        self.assertEqual(self.ops.prompts, [])
        attempts = [args for kind, args, _ in self.ops.calls if kind == "herdr" and args[:2] == ("agent", "start")]
        self.assertEqual(len(attempts), 120)
        failures = [event for event in registry.read_events(0) if event["kind"] == "worker_start_failed"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(self.workers()[0], worker)
        self.ops.start_error = None
        self.assertEqual(start.start_issues(self.repo, [1], ops=self.ops)[0], worker)
        self.assertEqual(self.ops.prompts, [])

    def test_busy_retry_refuses_another_starter(self):
        self.ops.issue(1)
        self.ops.start_errors = ["agent_pane_busy"]

        def continue_elsewhere(_):
            before = registry.load()
            calls = list(self.ops.calls)
            with mock.patch.object(start, "_start_owner", return_value={"pid": 123, "created": 456}):
                worker, admitted = start._admit(self.workers()[0])
                self.assertFalse(admitted)
                self.assertEqual(start._run_worker(worker, self.ops), worker)
            self.assertEqual(registry.load(), before)
            self.assertEqual(self.ops.calls, calls)

        with mock.patch.object(start.time, "monotonic", return_value=0), mock.patch.object(start.time, "sleep", side_effect=continue_elsewhere):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertEqual(len(self.ops.prompts), 1)
        self.assertFalse(any(event["kind"] == "worker_start_failed" for event in registry.read_events(0)))

    def test_mode_checked_clears_a_stale_reason(self):
        self.ops.issue(1)
        check_mode = start._check_mode

        def seed_reason(worker, ops):
            registry.update(lambda doc: doc["workers"][worker["worker_id"]].update(reason="old startup failure"))
            worker = registry.load()["workers"][worker["worker_id"]]
            self.assertIn("reason", worker)
            return check_mode(worker, ops)

        with mock.patch.object(start, "_check_mode", side_effect=seed_reason):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertNotIn("reason", worker)
        self.assertNotIn("reason", self.workers()[0])

    def test_overlapping_starter_cannot_revive_a_failed_worker(self):
        self.ops.issue(1)
        herdr = self.ops.herdr
        interrupted = False

        def fail_during_start(*args, **kwargs):
            nonlocal interrupted
            if args[:2] == ("agent", "start") and not interrupted:
                interrupted = True
                worker = self.workers()[0]
                # A watcher can enter the start flow with this same snapshot.
                stale = dict(worker)
                with mock.patch.object(self.ops, "start_error", "agent_not_ready"):
                    self.assertEqual(start._run_worker(stale, self.ops)["state"], "start_failed")
                self.assertEqual(start._run_worker(stale, self.ops)["state"], "start_failed")
            return herdr(*args, **kwargs)

        with mock.patch.object(self.ops, "herdr", side_effect=fail_during_start):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "start_failed")
        self.assertEqual(worker["phase"], "worktree")
        self.assertIn("agent_not_ready", worker["reason"])
        self.assertNotIn("agent_name", worker)
        self.assertEqual(self.ops.prompts, [])
        self.assertEqual(registry.load()["actions"], {})
        events = registry.read_events(0)
        self.assertEqual(sum(event["kind"] == "worker_start_failed" for event in events), 1)
        self.assertEqual(events[-1]["kind"], "worker_start_failed")

    def test_failure_before_entry_intent_prevents_a_prompt(self):
        self.ops.issue(1)
        send_entry = start._send_entry

        def fail_before_send(worker, ops):
            start._record(worker["worker_id"], "worker_start_failed", state="start_failed", reason="another starter failed")
            return send_entry(worker, ops)

        with mock.patch.object(start, "_send_entry", side_effect=fail_before_send):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "start_failed")
        self.assertEqual(worker["phase"], "agent_started")
        self.assertEqual(self.ops.prompts, [])
        self.assertEqual(registry.load()["actions"], {})
        self.assertEqual(registry.read_events(0)[-1]["kind"], "worker_start_failed")

    def test_unconfirmed_send_is_unknown_and_is_never_resent(self):
        self.ops.issue(1)
        self.ops.confirm = False
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("not confirmed", worker["reason"])
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivery_unknown")
        start.start_issues(self.repo, [1], ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 1)

    def test_restart_retypes_an_entry_its_session_never_received(self):
        # Live 2026-10-15: the entry was typed before Claude took input, so
        # the session never wrote a transcript; restart, on the user's word, types the same entry again.
        self.ops.issue(1)
        self.ops.drop_prompts = 1
        failed = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(failed["state"], "start_failed")
        self.assertIn("not confirmed", failed["reason"])
        start.start_issues(self.repo, [1], ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 1)  # never resent on its own (KTD7)
        worker = start.restart("1", ops=self.ops)
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertEqual(worker["action_id"], failed["action_id"])
        self.assertEqual([prompt[3] for prompt in self.ops.prompts], ["/ce-work #1", "/ce-work #1"])
        action = registry.load()["actions"][worker["action_id"]]
        self.assertEqual((action["status"], action["resends"]), ("delivered", 1))
        self.assertEqual(len(self.ops.worktrees), 1)
        self.assertEqual(len(self.ops.agents), 1)
        self.assertEqual(sum(event["kind"] == "entry_resent" for event in registry.read_events(0)), 1)

    def test_restart_refuses_a_failed_start_unless_its_entry_provably_never_arrived(self):
        def received(doc, worker):  # the session wrote a transcript, so the entry may still run
            self.ops.write_transcript(worker["agent_name"], "/ce-work #1")
        cases = (
            ("transcript exists", received),
            ("no session", lambda doc, worker: worker.pop("session_id")),
            ("recovery pending", lambda doc, worker: worker.update(entry_recovery_pending=True)),
            ("entry delivered", lambda doc, worker: doc["actions"][worker["action_id"]].update(status="delivered")),
            ("not an entry", lambda doc, worker: doc["actions"][worker["action_id"]].update(kind="nudge")),
            ("already retried", lambda doc, worker: doc["actions"][worker["action_id"]].update(resends=1)),
            ("mode mismatch", lambda doc, worker: worker.update(phase="delivered")),
            ("hold open", lambda doc, worker: doc["holds"].update(watcher_lost={"ts": 1})),
            ("no slot", lambda doc, worker: doc["config"].update(cap=0)),
        )
        for index, (label, change) in enumerate(cases, 1):
            with self.subTest(label), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.root / f"refuse-{index}")}):
                repo = self.root / f"repo-{index}"
                repo.mkdir()
                self.ops.issue(1)
                self.ops.drop_prompts = 1
                worker = start.start_issues(repo, [1], ops=self.ops)[0]
                self.assertEqual(worker["state"], "start_failed", worker)
                registry.update(lambda doc: change(doc, doc["workers"][worker["worker_id"]]))
                prompts = len(self.ops.prompts)
                with self.assertRaises(ValueError):
                    start.restart("1", ops=self.ops)
                self.assertEqual(len(self.ops.prompts), prompts)
                self.assertEqual(self.workers()[0]["state"], "start_failed")

    def test_restart_retype_that_fails_stays_unknown(self):
        self.ops.issue(1)
        self.ops.drop_prompts = 1
        start.start_issues(self.repo, [1], ops=self.ops)
        self.ops.prompt_error = "agent_not_found"
        worker = start.restart("1", ops=self.ops)
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("agent_not_found", worker["reason"])
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivery_unknown")
        # The failed retry may still arrive, so it is never typed a third time.
        with self.assertRaisesRegex(ValueError, "never reached its session"):
            start.restart("1", ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 2)

    def test_send_error_is_unknown_and_batch_continues(self):
        self.ops.issue(1)
        self.ops.issue(2)
        self.ops.prompt_error = "timeout"
        worker, next_worker = start.start_issues(self.repo, [1, 2], ops=self.ops)
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("timeout", worker["reason"])
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivery_unknown")
        self.assertEqual(next_worker["state"], "running")
        start.start_issues(self.repo, [1], ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 2)

    def test_permission_mismatch_escapes_once_and_keeps_worktree(self):
        self.ops.issue(1)
        self.ops.recorded_mode = "bypassPermissions"
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("expected auto", worker["reason"])
        self.assertEqual(self.ops.escapes, [("agent", "send-keys", worker["agent_name"], "esc")])
        self.assertTrue(Path(worker["worktree_path"]).is_dir())
        start.start_issues(self.repo, [1], ops=self.ops)
        self.assertEqual(len(self.ops.escapes), 1)

    def test_configured_bypass_permission_mode_passes(self):
        registry.update(lambda doc: doc["config"].update(permission_mode="bypassPermissions"))
        self.ops.issue(1)
        self.ops.recorded_mode = "bypassPermissions"
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertEqual(self.ops.escapes, [])
        args = next(args for kind, args, _ in self.ops.calls if kind == "herdr" and args[:2] == ("agent", "start"))
        self.assertEqual(args[-1], "bypassPermissions")

    def test_restart_after_every_phase_reuses_resources_and_prompt(self):
        for phase in start.PHASES:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                repo = root / "repo"
                repo.mkdir()
                ops = FakeOps(root / "projects")
                ops.issue(1)
                original_update = registry.update
                interrupted = False

                def crash_after_write(fn):
                    nonlocal interrupted
                    before = registry.load()
                    doc = original_update(fn)
                    if not interrupted and any(
                        worker.get("phase") == phase
                        and before["workers"].get(worker_id, {}).get("phase") != phase
                        for worker_id, worker in doc["workers"].items()
                    ):
                        interrupted = True
                        raise RuntimeError("simulated interruption after phase write")
                    return doc

                with mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(root / "state")}), mock.patch.object(start, "PROJECTS_ROOT", ops.projects):
                    with mock.patch.object(registry, "update", side_effect=crash_after_write):
                        with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                            start.start_issues(repo, [1], ops=ops)
                    before = self.workers()[0]
                    if before["state"] == "running":
                        with self.assertRaisesRegex(ValueError, "start_interrupted"):
                            start.restart("1", ops=ops)
                        result = before
                    else:
                        registry.update(lambda doc: doc["workers"][before["worker_id"]].update(
                            state="start_interrupted", start_owner={"pid": 123, "created": 456}))
                        interrupted_worker = self.workers()[0]
                        self.assertEqual(start.start_issues(repo, [1], ops=ops)[0], interrupted_worker)
                        run_worker = start._run_worker

                        def check_claim(worker, current_ops):
                            self.assertEqual(worker["start_owner"], start._start_owner())
                            self.assertEqual(worker["state"], "starting")
                            self.assertEqual(worker["phase"], phase)
                            self.assertEqual(self.workers()[0], worker)
                            return run_worker(worker, current_ops)

                        with mock.patch.object(start, "_run_worker", side_effect=check_claim):
                            result = start.restart(before.get("agent_name", "#1"), ops=ops)
                    self.assertEqual(result["phase"], "mode_checked")
                    self.assertEqual(result["state"], "running")
                    self.assertEqual(result["worktree_path"], before["worktree_path"])
                    self.assertEqual(result["workspace_id"], before["workspace_id"])
                    self.assertEqual(len(self.workers()), 1)
                    self.assertEqual(len(ops.worktrees), 1)
                    self.assertEqual(len(ops.agents), 1)
                    self.assertEqual(len(ops.prompts), 1)

    def test_open_hold_prevents_queue_drain(self):
        registry.update(lambda doc: doc["config"].update(cap=0))
        self.ops.issue(1)
        start.start_issues(self.repo, [1], ops=self.ops)
        registry.update(lambda doc: (doc["config"].update(cap=1), doc["holds"].update(watcher_lost=True)))
        self.assertIsNone(start.start_next_queued(ops=self.ops))
        self.assertEqual(len(registry.load()["queue"]), 1)
        self.assertEqual(self.ops.prompts, [])

    def test_slot_states_follow_ktd12(self):
        states = {
            "starting": True, "running": True, "in_tool": True, "question": True,
            "quota_wait": True, "stalled": True, "awaiting_checks": True,
            "done": False, "awaiting_merge": False, "ended_without_proof": False,
            "start_failed": False, "lost": False, "start_interrupted": False,
            "relay_pending": False,
        }
        for number, (state, holds_slot) in enumerate(states.items(), 1):
            with self.subTest(state=state):
                def occupy(doc):
                    doc["workers"] = {"occupied": {"state": state}}
                    doc["queue"] = []
                    doc["actions"] = {}
                    doc["config"]["cap"] = 1

                registry.update(occupy)
                self.ops.issue(number)
                worker = start.start_issues(self.repo, [number], ops=self.ops)[0]
                self.assertEqual(worker["state"], "queued" if holds_slot else "running")

    def test_interruption_after_action_write_does_not_send_on_restart(self):
        self.ops.issue(1)
        original_update = registry.update

        def crash_after_intent(fn):
            before = registry.load()
            doc = original_update(fn)
            if not before["actions"] and doc["actions"]:
                raise RuntimeError("interrupted after intent")
            return doc

        with mock.patch.object(registry, "update", side_effect=crash_after_intent):
            with self.assertRaisesRegex(RuntimeError, "interrupted after intent"):
                start.start_issues(self.repo, [1], ops=self.ops)
        registry.update(lambda doc: doc["workers"][self.workers()[0]["worker_id"]].update(state="start_interrupted"))
        worker = start.restart("1", ops=self.ops)
        self.assertEqual(worker["state"], "start_failed")
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivery_unknown")
        self.assertEqual(self.ops.prompts, [])
        self.assertEqual(len(self.ops.worktrees), 1)
        self.assertEqual(len(self.ops.agents), 1)

    def test_interruption_after_prompt_before_phase_write_reconciles_delivery(self):
        self.ops.issue(1)
        original_record = start._record

        def crash_before_sent_phase(worker_id, kind, **changes):
            if changes.get("phase") == "command_sent":
                raise RuntimeError("interrupted after prompt")
            return original_record(worker_id, kind, **changes)

        with mock.patch.object(start, "_record", side_effect=crash_before_sent_phase):
            with self.assertRaisesRegex(RuntimeError, "interrupted after prompt"):
                start.start_issues(self.repo, [1], ops=self.ops)
        registry.update(lambda doc: doc["workers"][self.workers()[0]["worker_id"]].update(state="start_interrupted"))
        worker = start.restart("1", ops=self.ops)
        self.assertEqual(worker["phase"], "mode_checked")
        self.assertEqual(len(self.ops.prompts), 1)

    def test_missing_session_times_out_without_another_prompt(self):
        self.ops.issue(1)
        self.ops.session_polls = 100_000
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "start_failed")
        self.assertIn("session id did not appear", worker["reason"])
        self.assertEqual(registry.load()["actions"][worker["action_id"]]["status"], "delivery_unknown")
        start.start_issues(self.repo, [1], ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 1)

    def test_queue_uses_permission_mode_configured_at_admission(self):
        registry.update(lambda doc: doc["config"].update(cap=0))
        self.ops.issue(1)
        start.start_issues(self.repo, [1], ops=self.ops)
        registry.update(lambda doc: doc["config"].update(cap=1, permission_mode="bypassPermissions"))
        self.ops.recorded_mode = "bypassPermissions"
        worker = start.start_next_queued(ops=self.ops)
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["permission_mode"], "bypassPermissions")

    def test_waits_for_path_after_herdr_returns(self):
        self.ops.issue(1)
        self.ops.delay_path = True

        def materialize(_):
            self.ops.pending_path.mkdir()
            self.ops.pending_path = None

        with mock.patch.object(start.time, "sleep", side_effect=materialize):
            self.assertEqual(start.start_issues(self.repo, [1], ops=self.ops)[0]["state"], "running")

    def test_fallback_only_for_unsupported_worktree_command(self):
        self.ops.issue(1)
        self.ops.worktree_error = "unknown_command"
        worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        self.assertEqual(worker["state"], "running")
        self.assertEqual(worker["workspace_id"], "fallback-workspace")
        self.assertTrue(any(kind == "git" and args[:2] == ("worktree", "add") for kind, args, _ in self.ops.calls))
        workspace = next(args for kind, args, _ in self.ops.calls
                         if kind == "herdr" and args[:2] == ("workspace", "create"))
        self.assertEqual(workspace[workspace.index("--label") + 1], "repo with spaces #1")

    def test_duplicate_issue_and_queued_retry_are_idempotent(self):
        registry.update(lambda doc: doc["config"].update(cap=0))
        self.ops.issue(1)
        start.start_issues(self.repo, [1, 1], ops=self.ops)
        self.assertEqual(len(registry.load()["queue"]), 1)
        registry.update(lambda doc: doc["config"].update(cap=1))
        start.start_issues(self.repo, [1, 1], ops=self.ops)
        self.assertEqual(len(self.ops.prompts), 1)
        self.assertEqual(len(self.workers()), 1)
        self.assertEqual(registry.load()["queue"], [])

    def test_cleaned_issue_starts_fresh_without_old_worker_history(self):
        self.ops.issue(1)
        old = start.start_issues(self.repo, [1], ops=self.ops)[0]
        registry.update(lambda doc: doc["workers"][old["worker_id"]].update(
            state="cleaned", abandoned=True, pending_action_id="old-pending",
            stall_nudge_action="old-stall", session_history=["old-session"],
            pr=42, transcript_offset=999, reason="old reason"))
        Path(old["worktree_path"]).rmdir()  # Simulate the completed cleanup in this fixture.
        self.ops.issue(1, ["ce:debug"], "CE entry: /ce-debug #1 new task")
        fresh = start.start_issues(self.repo, [1, 1], ops=self.ops)[0]
        self.assertEqual(fresh["state"], "running")
        self.assertEqual(fresh["entry_command"], "ce-debug")
        self.assertNotEqual(fresh["action_id"], old["action_id"])
        self.assertNotEqual(fresh["session_id"], old["session_id"])
        self.assertEqual(len(self.workers()), 1)
        self.assertEqual(len(self.ops.prompts), 2)
        self.assertEqual(len(self.ops.worktrees), 2)
        for field in ("abandoned", "pending_action_id", "stall_nudge_action", "session_history", "pr", "reason"):
            self.assertNotIn(field, fresh)
        self.assertIn(old["action_id"], registry.load()["actions"])

    def test_cleaned_issue_queues_a_fresh_candidate_and_requires_entry(self):
        self.ops.issue(1)
        old = start.start_issues(self.repo, [1], ops=self.ops)[0]
        registry.update(lambda doc: (doc["workers"][old["worker_id"]].update(state="cleaned"),
                                    doc["config"].update(cap=0)))
        self.ops.issue(1, [])
        self.assertEqual(start.start_issues(self.repo, [1], ops=self.ops)[0]["state"], "refused")
        self.ops.issue(1)
        queued = start.start_issues(self.repo, [1, 1], ops=self.ops)[0]
        self.assertEqual(queued["state"], "queued")
        self.assertNotIn("action_id", queued)
        self.assertNotIn(old["worker_id"], registry.load()["workers"])
        self.assertEqual(len(registry.load()["queue"]), 1)
        Path(old["worktree_path"]).rmdir()
        registry.update(lambda doc: doc["config"].update(cap=1))
        self.assertEqual(start.start_next_queued(ops=self.ops)["state"], "running")
        self.assertEqual(len(self.ops.prompts), 2)

    def test_start_refreshes_heartbeat_between_each_phase(self):
        self.ops.issue(1)
        with mock.patch.object(start, "_run_worker", side_effect=lambda worker, ops: worker):
            worker = start.start_issues(self.repo, [1], ops=self.ops)[0]
        phases = []

        def keepalive():
            phases.append(self.workers()[0].get("phase"))

        self.assertEqual(start._run_worker(worker, self.ops, keepalive=keepalive)["state"], "running")
        self.assertEqual(phases, [None, "worktree", "worktree", "agent_started", "agent_started",
                                 "command_sent", "command_sent", "delivered", "delivered", "mode_checked"])

    def test_cli_prints_json_per_issue_and_only_usage_errors_are_nonzero(self):
        self.ops.issue(1)
        self.ops.issue(2, [])
        output = io.StringIO()
        real_start = start.start_issues
        with mock.patch.object(start, "start_issues", side_effect=lambda repo, issues: real_start(repo, issues, ops=self.ops)), mock.patch("sys.stdout", output):
            self.assertEqual(herdr_coord.main(["start", str(self.repo), "1", "#2"]), 0)
        summaries = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["state"] for item in summaries], ["running", "refused"])
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as caught:
            herdr_coord.main(["start", str(self.repo), "bad"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
