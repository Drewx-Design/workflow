from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import json
import os
import tempfile
import unittest
from unittest import mock

import adapters


FAKE = '''import json
import os
import sys
import time

mode = sys.argv[1]
args = sys.argv[2:]
if mode == "error":
    print(json.dumps({"error": {"code": args[0], "message": "x"}, "id": "fake"}))
elif mode == "timeout":
    print('{"before": true}', flush=True)
    print("waiting", file=sys.stderr, flush=True)
    time.sleep(30)
elif mode == "failure":
    print("not JSON")
    print("failed", file=sys.stderr)
    sys.exit(7)
elif mode == "non_json":
    print("not JSON")
elif mode == "fixture":
    with open(args[0], encoding="utf-8") as handle:
        print(handle.read())
else:
    print(json.dumps({"argv": args, "cwd": os.getcwd(), "env": {
        key: os.environ.get(key) for key in ("GITHUB_TOKEN", "GH_TOKEN", "REMOVE_ME", "KEEP_ME")
    }}))
'''


class AdapterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.fake = self.home / "fake command.py"
        self.fake.write_text(FAKE, encoding="utf-8")
        prefix = json.dumps([sys.executable, str(self.fake), "capture"])
        patcher = mock.patch.dict(os.environ, {
            "HERDR_COORD_HOME": str(self.home / "state"),
            "HERDR_COORD_HERDR": prefix,
            "HERDR_COORD_GIT": prefix,
            "HERDR_COORD_GH": prefix,
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def mode(self, mode):
        os.environ["HERDR_COORD_HERDR"] = json.dumps([sys.executable, str(self.fake), mode])

    def test_children_never_open_a_console_window(self):
        # The detached watcher has no console; a child without CREATE_NO_WINDOW
        # flashes a terminal window on the user's screen for every call.
        with mock.patch("adapters.subprocess.run", wraps=adapters.subprocess.run) as spy:
            adapters.herdr("workspace", "list")
        self.assertEqual(spy.call_args.kwargs.get("creationflags"), adapters.subprocess.CREATE_NO_WINDOW)

    def test_real_success_envelopes_are_preserved(self):
        self.mode("fixture")
        fixtures = Path(__file__).with_name("fixtures")
        for name in (
            "herdr-agent-get-idle.json",
            "herdr-agent-get-after-prompt-done.json",
            "herdr-agent-get-blocked-question.json",
        ):
            with self.subTest(name=name):
                path = fixtures / name
                result = adapters.herdr(str(path))
                self.assertTrue(result.ok)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.data, json.loads(path.read_text(encoding="utf-8")))
                self.assertIsNone(result.error_code)
                self.assertIsNone(result.error_message)

    def test_herdr_error_envelopes_are_typed_even_on_zero_exit(self):
        self.mode("error")
        for code in ("agent_blocked", "agent_not_ready", "agent_name_taken", "timeout", "agent_prompt_stalled"):
            with self.subTest(code=code):
                result = adapters.herdr(code)
                self.assertFalse(result.ok)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.error_code, code)
                self.assertEqual(result.error_message, "x")
                self.assertEqual(result.data["error"]["code"], code)

    def test_timeout_retains_partial_output_and_does_not_raise(self):
        self.mode("timeout")
        result = adapters.herdr(timeout=0.3)
        self.assertFalse(result.ok)
        self.assertIsNone(result.returncode)
        self.assertEqual(result.error_code, "timeout")
        self.assertIn("before", result.stdout)
        self.assertIn("waiting", result.stderr)
        self.assertEqual(result.data, {"before": True})

    def test_nonzero_exit_retains_stdout_and_stderr(self):
        self.mode("failure")
        result = adapters.herdr()
        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout.strip(), "not JSON")
        self.assertEqual(result.stderr.strip(), "failed")
        self.assertIsNone(result.data)
        self.assertEqual(result.error_code, "command_failed")

    def test_arguments_reach_executable_unchanged_without_a_shell(self):
        args = ["agent", "prompt", "w1", "/ce-work #12", "/exit", "a b", '"quoted"', "$HOME; echo x", ""]
        with mock.patch.object(adapters.subprocess, "run", wraps=adapters.subprocess.run) as called:
            result = adapters.herdr(*args)
        self.assertTrue(result.ok)
        self.assertEqual(result.data["argv"], args)
        self.assertIs(called.call_args.kwargs["shell"], False)
        self.assertIsInstance(called.call_args.args[0], list)

    def test_git_and_gh_use_the_requested_cwd_and_prefix(self):
        for command in (adapters.git, adapters.gh):
            with self.subTest(command=command.__name__):
                result = command("status", cwd=self.home)
                self.assertTrue(result.ok)
                self.assertEqual(result.data["argv"], ["status"])
                self.assertEqual(Path(result.data["cwd"]), self.home)

    def test_gh_removes_both_tokens_and_preserves_other_environment(self):
        with mock.patch.dict(os.environ, {
            "GITHUB_TOKEN": "parent-one", "GH_TOKEN": "parent-two",
            "REMOVE_ME": "remove", "KEEP_ME": "keep",
        }):
            result = adapters.gh("auth", "status", env_remove=("REMOVE_ME",))
            self.assertTrue(result.ok)
            self.assertEqual(result.data["env"], {
                "GITHUB_TOKEN": None, "GH_TOKEN": None, "REMOVE_ME": None, "KEEP_ME": "keep",
            })
            self.assertEqual(os.environ["GITHUB_TOKEN"], "parent-one")
            self.assertEqual(os.environ["GH_TOKEN"], "parent-two")

    def test_reachable_requires_successful_json(self):
        self.assertTrue(adapters.herdr_reachable())
        self.assertEqual(adapters.herdr("workspace", "list").data["argv"], ["workspace", "list"])
        for mode in ("failure", "non_json"):
            with self.subTest(mode=mode):
                self.mode(mode)
                self.assertFalse(adapters.herdr_reachable())

    def test_path_resolution_uses_which_when_no_override_is_present(self):
        for name in ("herdr", "git", "gh"):
            with self.subTest(name=name):
                del os.environ[f"HERDR_COORD_{name.upper()}"]
                with mock.patch.object(adapters.shutil, "which", return_value=sys.executable) as which:
                    result = getattr(adapters, name)(str(self.fake), "capture", "arg", cwd=self.home)
                which.assert_called_once_with(name)
                self.assertTrue(result.ok)
                self.assertEqual(result.data["argv"], ["arg"])

    def test_missing_executable_returns_an_error(self):
        result = adapters.run([str(self.home / "missing.exe")])
        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "command_not_found")

    def test_run_requires_a_nonempty_list(self):
        with self.assertRaises(TypeError):
            adapters.run("herdr workspace list")
        with self.assertRaises(TypeError):
            adapters.run((sys.executable, "-V"))
        with self.assertRaises(ValueError):
            adapters.run([])

    def test_invalid_prefix_cannot_be_interpreted_as_a_shell_command(self):
        for override in ("not json", '"herdr && echo x"', "[]", '[42]'):
            with self.subTest(override=override):
                os.environ["HERDR_COORD_HERDR"] = override
                with self.assertRaises(ValueError):
                    adapters.herdr("workspace", "list")


if __name__ == "__main__":
    unittest.main()
