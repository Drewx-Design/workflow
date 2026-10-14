import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import io
import json
import os
import tempfile
import unittest
from unittest import mock

import adapters
import finish
import herdr_coord
import registry
import start
import watch


def lines(output):
    return [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]


class WatcherGuardTest(unittest.TestCase):
    """2026-10-14: two reboots killed every watcher, and boon-town #1892 was then started with
    none running. Commands that put work in motion now bring a watcher back first."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        env = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.alive = False
        self.launches = []

        def launch():
            self.launches.append(os.environ["HERDR_COORD_HOME"])
            self.alive = self.comes_up
            return {"state": "launched", "pid": 4242}

        self.comes_up = True

        for target, value in (("watcher_alive", lambda **kw: self.alive), ("launch", launch)):
            patcher = mock.patch.object(watch, target, side_effect=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def seed(self, **workers):
        registry.update(lambda doc: doc["workers"].update({
            name: {"worker_id": name, "issue": index + 1, "agent_name": name, "state": state,
                   "repo_path": str(self.home)}
            for index, (name, state) in enumerate(workers.items())}))

    def run_start(self):
        with mock.patch.object(start, "start_issues", return_value=[{"issue": 7, "state": "running"}]) as started, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            code = herdr_coord.main(["start", str(self.home), "7"])
        return code, lines(output), started

    def test_start_with_no_live_workers_launches_a_watcher_without_a_hold(self):
        self.seed(old="cleaned")
        code, output, started = self.run_start()
        self.assertEqual(code, 0)
        self.assertEqual(output[0], {"watcher": {"state": "launched", "pid": 4242, "hold": False}})
        self.assertEqual(self.launches, [str(self.home)])
        self.assertEqual(registry.load()["holds"], {})
        started.assert_called_once()

    def test_start_after_a_gap_with_live_workers_opens_the_hold_first(self):
        self.seed(busy="running")
        code, output, started = self.run_start()
        self.assertEqual(code, 0)
        self.assertTrue(output[0]["watcher"]["hold"])
        self.assertIn("watcher_lost", registry.load()["holds"])
        self.assertIn("watcher_lost", [event["kind"] for event in registry.read_events(0)])
        started.assert_called_once()  # admission queues it under the hold

    def test_start_with_a_running_watcher_changes_nothing(self):
        self.alive = True
        self.seed(busy="running")
        code, output, started = self.run_start()
        self.assertEqual((code, self.launches, registry.load()["holds"]), (0, [], {}))
        self.assertEqual(output, [{"issue": 7, "state": "running"}])

    def test_start_refuses_when_no_watcher_can_be_launched(self):
        watch.launch.side_effect = lambda: {"state": "launch_failed", "detail": "nope"}
        code, output, started = self.run_start()
        self.assertEqual(code, 1)
        self.assertEqual(output[1]["state"], "refused")
        started.assert_not_called()

    def test_start_waits_for_the_watcher_and_refuses_if_it_never_comes_up(self):
        # Codex review 2026-10-14: Popen returning is not a running watcher.
        self.comes_up = False
        with mock.patch.object(herdr_coord, "WATCHER_READY_SECONDS", 0.3):
            code, output, started = self.run_start()
        self.assertEqual(code, 1)
        self.assertEqual(output[0]["watcher"]["state"], "launch_failed")
        self.assertIn("did not come up", output[0]["watcher"]["detail"])
        started.assert_not_called()

    def test_ensure_watcher_decision_table(self):
        # Closes the readiness contract after two review rounds (2026-10-14).
        # (alive before, live workers, hold wanted, launch says, comes up) -> (result state, hold opened)
        table = [
            (True, True, True, None, None, None, False),
            (False, False, True, "launched", True, "launched", False),
            (False, True, True, "launched", True, "launched", True),
            (False, True, False, "launched", True, "launched", False),
            (False, True, True, "launched", False, "launch_failed", True),
            (False, True, True, "already_running", True, "already_running", True),
            (False, True, True, "already_running", False, "launch_failed", True),
            (False, False, True, "launch_failed", False, "launch_failed", False),
        ]
        for alive, live, hold, says, up, expected, held in table:
            with self.subTest(alive=alive, live=live, hold=hold, says=says, up=up):
                registry.update(lambda doc: (doc["workers"].clear(), doc["holds"].clear()))
                if live:
                    self.seed(busy="running")
                self.alive, self.comes_up = alive, up
                launch = (lambda s=says: (setattr(self, "alive", bool(self.comes_up)), {"state": s, "pid": 1})[1])
                with mock.patch.object(watch, "launch", side_effect=launch), \
                        mock.patch.object(herdr_coord, "WATCHER_READY_SECONDS", 0.3):
                    result = herdr_coord._ensure_watcher(hold=hold)
                self.assertEqual(result and result["state"], expected)
                self.assertEqual("watcher_lost" in registry.load()["holds"], held)

    def test_go_whose_watcher_never_comes_up_fails_loudly(self):
        self.seed(busy="running")
        self.comes_up = False
        with mock.patch.object(herdr_coord, "WATCHER_READY_SECONDS", 0.3), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["go"]), 1)
        self.assertEqual(lines(output)[0]["state"], "launch_failed")

    def test_real_start_queues_under_the_new_hold(self):
        # No mock on start_issues: the hold opened by the guard must stop the worker launching.
        self.seed(busy="running")
        ops_calls = []

        def gh(*args, **kwargs):
            ops_calls.append(args)
            return adapters.CommandResult(True, 0, "", "", {
                "number": 7, "title": "t", "labels": [{"name": "ce:work"}], "body": "/ce-work #7"})

        def herdr(*args, **kwargs):
            raise AssertionError(f"herdr must not run under the hold: {args}")

        with mock.patch.object(adapters, "gh", side_effect=gh), mock.patch.object(adapters, "herdr", side_effect=herdr), \
                mock.patch.object(adapters, "git", side_effect=herdr), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            herdr_coord.main(["start", str(self.home), "7"])
        self.assertEqual(lines(output)[-1]["state"], "queued")

    def test_go_brings_back_a_missing_watcher_without_a_new_hold(self):
        self.seed(busy="running")
        registry.update(lambda doc: doc["holds"].update(herdr_lost={"ts": 1}))
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["go"]), 0)
        result = lines(output)[0]
        self.assertEqual(result["watcher"], {"state": "launched", "pid": 4242, "hold": False})
        self.assertEqual(registry.load()["holds"], {})

    def test_restart_with_no_watcher_opens_the_hold_and_refuses(self):
        self.seed(interrupted="start_interrupted")
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["restart", "interrupted"]), 1)
        out = lines(output)
        self.assertTrue(out[0]["watcher"]["hold"])
        self.assertIn("hold", out[1]["detail"])

    def test_status_names_a_healthy_watcher(self):
        self.alive = True
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "heartbeat.json").write_text(json.dumps({"pid": 99, "ts": 9e12, "poll": 15}), encoding="utf-8")
        with mock.patch.object(watch, "watcher_slow", return_value=False), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            herdr_coord.main(["status"])
        self.assertIn("watcher: ok (pid 99)", output.getvalue())


class ReviveWatchersTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        env = mock.patch.dict(os.environ, {"HERDR_COORD_BASE": str(self.base)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("HERDR_COORD_HOME", None)
        os.environ.pop("HERDR_COORD_REPO", None)
        self.alive_roots = set()
        self.launches = []

        def launch():
            self.launches.append((os.environ["HERDR_COORD_HOME"], os.environ.get("HERDR_COORD_REPO")))
            self.alive_roots.add(os.environ["HERDR_COORD_HOME"])
            return {"state": "launched", "pid": 1}

        alive = lambda **kw: os.environ["HERDR_COORD_HOME"] in self.alive_roots
        for target, value in (("watcher_alive", alive), ("launch", launch)):
            patcher = mock.patch.object(watch, target, side_effect=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def root(self, name, *states):
        home = self.base / "repos" / name
        os.environ["HERDR_COORD_HOME"] = str(home)
        registry.update(lambda doc: doc["workers"].update({
            f"{name}#{i}": {"worker_id": f"{name}#{i}", "issue": i, "state": state, "repo_path": f"C:/{name}"}
            for i, state in enumerate(states)}))
        os.environ.pop("HERDR_COORD_HOME")
        return str(home)

    def ops(self, running=True):
        def herdr(*args, **kwargs):
            assert args == ("status", "server"), args
            return adapters.CommandResult(True, 0, "status: running\nversion: 0.9.4\n" if running
                                          else "status: not running\n", "")
        return type("Ops", (), {"herdr": staticmethod(herdr)})

    def test_waits_for_herdr(self):
        self.root("live", "running")
        self.assertEqual(herdr_coord._revive_watchers(self.ops(running=False))["state"], "skipped")
        self.assertEqual(self.launches, [])

    def test_relaunches_only_dead_watchers_of_live_repositories_behind_a_hold(self):
        live = self.root("live", "lost", "done")
        idle = self.root("idle", "cleaned", "done")
        watched = self.root("watched", "running")
        self.alive_roots.add(watched)
        result = herdr_coord._revive_watchers(self.ops())
        self.assertEqual(self.launches, [(live, "C:/live")])
        self.assertEqual(result["results"], [{"state_root": live, "state": "launched", "pid": 1, "hold": True}])
        for home, held in ((live, True), (idle, False), (watched, False)):
            os.environ["HERDR_COORD_HOME"] = home
            self.assertEqual("watcher_lost" in registry.load()["holds"], held, home)

    def test_cli_logs_only_runs_that_did_something_and_takes_no_repo(self):
        for outcome in ({"state": "skipped", "reason": "herdr server is not running"},
                        {"state": "revived", "results": [{"state": "launched"}]}):
            with mock.patch.object(herdr_coord, "_revive_watchers", return_value=outcome), \
                    mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(herdr_coord.main(["revive-watchers"]), 0)
        log = (self.base / "revive.log").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(log), 1)
        self.assertIn('"launched"', log[0])
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(herdr_coord.main(["revive-watchers", "--repo", "x"]), 1)
        self.assertEqual(json.loads(output.getvalue())["state"], "refused")

    def test_one_broken_repository_does_not_stop_the_others(self):
        broken = self.base / "repos" / "broken"
        broken.mkdir(parents=True)
        (broken / "registry.json").write_text("{not json", encoding="utf-8")
        live = self.root("live", "running")
        result = herdr_coord._revive_watchers(self.ops())
        self.assertEqual([r["state"] for r in result["results"]], ["failed", "launched"])
        self.assertEqual(self.launches, [(live, "C:/live")])


class MergedPrLostTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = mock.patch.dict(os.environ, {"HERDR_COORD_HOME": self.temp.name})
        env.start()
        self.addCleanup(env.stop)
        registry.update(lambda doc: doc["workers"].update({"w-lost": {
            "worker_id": "w-lost", "issue": 158, "agent_name": "a-lost", "state": "lost",
            "state_token": "t", "repo_path": self.temp.name}}))

    def test_a_lost_worker_can_be_marked_merged_and_cleaned(self):
        seen = []
        with mock.patch.object(finish, "named_pr_merged", return_value=(True, "")), \
                mock.patch.object(finish, "cleanup", lambda worker, *, ops: seen.append(worker["state"]) or
                                  {"cleaned": True, "reason": "ok"}):
            herdr_coord._cleanup(merged_pr=("a-lost", "315"), ops=object())
        self.assertEqual(seen, ["lost"])
        self.assertEqual(registry.load()["workers"]["w-lost"]["state"], "cleaned")

    def test_a_lost_worker_whose_agent_came_back_is_never_closed(self):
        agent = adapters.CommandResult(True, 0, "", "", {"result": {"agent": {"agent_status": "idle"}}})
        self.assertIn("still alive", finish._close_refusal({"state": "lost"}, agent, ops=object()))

    def test_an_unmerged_lost_worker_is_still_skipped(self):
        with mock.patch.object(finish, "cleanup", side_effect=AssertionError("must not clean")):
            herdr_coord._cleanup(ops=object())
        self.assertEqual(registry.load()["workers"]["w-lost"]["state"], "lost")


if __name__ == "__main__":
    unittest.main()
