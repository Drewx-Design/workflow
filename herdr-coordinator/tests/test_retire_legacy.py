from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from contextlib import contextmanager, redirect_stdout
import io
import hashlib
import json
import msvcrt
import os
import shutil
import unittest
from unittest import mock

import herdr_coord
import registry
import repo_root
from test_repo_root import RepoFixture


class RetireLegacyTests(RepoFixture):
    def cli(self, *argv, home=None):
        with mock.patch.dict(os.environ), redirect_stdout(io.StringIO()) as output:
            os.environ.pop("HERDR_COORD_HOME", None)
            if home is not None:
                os.environ["HERDR_COORD_HOME"] = str(home)
            code = herdr_coord.main(list(argv))
        return code, output.getvalue()

    def retire(self, *argv):
        code, output = self.cli("retire-legacy", *argv)
        return code, json.loads(output)

    def worker(self, state, issue=21, name="taste-swipe-21"):
        return {"state": state, "issue": issue, "agent_name": name,
                "repo_path": r"c:\users\user\codeprojects\taste-swipe",
                "worktree_path": r"c:\users\user\codeprojects\taste-swipe-worktrees\issue-21"}

    def layout(self, *, workers=None, queue=None, events=()):
        self.base.mkdir(parents=True, exist_ok=True)
        doc = {"version": 1, "workers": workers or {}, "queue": queue or [],
               "holds": {}, "event_seq": 71, "ack_seq": 71}
        (self.base / "registry.json").write_text(json.dumps(doc), encoding="utf-8")
        (self.base / "events.jsonl").write_text(
            "".join(json.dumps({"seq": seq}) + "\n" for seq in events), encoding="utf-8")
        (self.base / "heartbeat.json").write_text('{"pid": 12345}', encoding="utf-8")
        (self.base / "watcher.lock").write_bytes(b"\0")
        (self.base / "watcher.log").write_bytes(b"legacy watcher log\r\n")
        (self.base / "registry.lock").write_bytes(b"registry lock stays")
        (self.base / "registry-old.tmp").write_bytes(b"temporary registry evidence")
        return doc

    @contextmanager
    def held_watcher(self):
        with (self.base / "watcher.lock").open("r+b") as handle:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

    def transaction(self):
        # Valid committed intent would overwrite the registry if recovery ran.
        data = b'{ "doc": {"version": 1, "workers": {}, "queue": [], "ack_seq": 99}, "events": [{"seq": 99}] }\n'
        (self.base / "transaction.json").write_bytes(data)
        return data

    def pending_receipt(self, *, source=None):
        archive = self.base / "legacy-20261007T120000.000000Z"
        archive.mkdir()
        files = ["registry.json", "events.jsonl"]
        for name in files:
            shutil.copyfile(self.base / name, archive / name)
        receipt = {"state": "retired", "archive": str(archive),
                   "source_base": str(source or self.base.resolve()),
                   "files": files, "abandoned": [self.worker("lost")],
                   "sha256": {name: hashlib.sha256((archive / name).read_bytes()).hexdigest() for name in files}}
        (archive / "retirement.json").write_text(json.dumps(receipt), encoding="utf-8")
        (self.base / "events.jsonl").unlink()
        return receipt

    def snapshot(self):
        return {path.name: path.read_bytes() for path in self.base.iterdir() if path.is_file()}

    def test_decision_table(self):
        # Each decision row has its own isolated source, plus unmatched abandon
        # and a case covering all blockers together in decision-table order.
        cases = (
            ("nothing", "nothing_to_retire", []),
            ("finish_receipt", "refused", ["interrupted_commit"]),
            ("watcher", "refused", ["watcher_running"]),
            ("transaction", "refused", ["interrupted_commit"]),
            ("events", "refused", ["unacknowledged_events"]),
            ("queue", "refused", ["queued_issues"]),
            ("done", "refused", ["owes_cleanup"]),
            ("awaiting_merge", "refused", ["owes_cleanup"]),
            ("active", "refused", ["active_worker"]),
            ("lost", "refused", ["lost_worker"]),
            ("archive", "retired", []),
            ("unknown_abandon", "refused", ["unknown_abandon"]),
            ("all_blockers", "refused", ["watcher_running", "interrupted_commit",
                "unacknowledged_events", "queued_issues", "owes_cleanup",
                "active_worker", "lost_worker", "unknown_abandon"]),
        )
        for case, state, kinds in cases:
            with self.subTest(row=case), mock.patch.dict(os.environ):
                self.base = self.root / case
                os.environ["HERDR_COORD_BASE"] = str(self.base)
                workers = {}
                if case in {"done", "awaiting_merge", "lost"}:
                    workers["worker"] = self.worker(case)
                elif case == "active":
                    workers["worker"] = self.worker("start_failed")
                elif case == "all_blockers":
                    workers = {state: self.worker(state, issue, state)
                               for state, issue in (("done", 1), ("running", 2), ("lost", 3))}
                elif case == "archive":
                    workers["worker"] = self.worker("cleaned")
                if case != "nothing":
                    self.layout(workers=workers,
                                queue=[{"issue": 42}] if case in {"queue", "all_blockers"} else [],
                                events=[70, 71, 72, 74] if case in {"events", "all_blockers"} else [71])
                if case in {"transaction", "all_blockers"}:
                    self.transaction()
                receipt = None
                if case == "finish_receipt":
                    receipt = self.pending_receipt()
                    # Receipt resumption must still refuse a new transaction.
                    self.transaction()
                before = self.snapshot() if self.base.exists() else {}
                argv = ["--abandon", "unknown"] if case in {
                    "unknown_abandon", "all_blockers", "finish_receipt"} else []
                with mock.patch.object(registry, "locked", side_effect=AssertionError("legacy lock forbidden")), \
                        mock.patch.object(registry, "load", side_effect=AssertionError("legacy load forbidden")), \
                        mock.patch.object(registry, "_recover_transaction", side_effect=AssertionError("recovery forbidden")), \
                        mock.patch.object(registry, "update", side_effect=AssertionError("legacy update forbidden")), \
                        mock.patch.object(registry, "read_events", side_effect=AssertionError("legacy events forbidden")):
                    if case in {"watcher", "all_blockers"}:
                        with self.held_watcher():
                            code, result = self.retire(*argv)
                    else:
                        code, result = self.retire(*argv)
                self.assertEqual(result["state"], state, result)
                self.assertEqual(code, 1 if kinds else 0, result)
                self.assertEqual([b["kind"] for b in result.get("blockers", [])], kinds)
                if kinds:
                    self.assertEqual(self.snapshot(), before)
                    self.assertEqual(len(list(self.base.glob("legacy-*"))), 1 if receipt else 0)
                    self.assertIn("--legacy", result["drain"])
                    for blocker in result["blockers"]:
                        if blocker["kind"] == "watcher_running":
                            self.assertEqual(blocker["pid"], 12345)
                        elif blocker["kind"] == "unacknowledged_events":
                            self.assertEqual(blocker["seqs"], [72, 74])
                        elif blocker["kind"] == "queued_issues":
                            self.assertEqual(blocker["issues"], [42])
                elif case == "archive":
                    archive = Path(result["archive"])
                    self.assertEqual(archive.parent, self.base)
                    self.assertTrue(archive.name.startswith("legacy-"))
                    self.assertEqual(result["abandoned"], [])
                    self.assertEqual(set(result["files"]), set(before) - {"registry.lock"})
                    for name in result["files"]:
                        self.assertEqual((archive / name).read_bytes(), before[name])
                        self.assertEqual(result["sha256"][name], hashlib.sha256(before[name]).hexdigest())
                        self.assertFalse((self.base / name).exists())
                    self.assertEqual(json.loads((archive / "retirement.json").read_text(encoding="utf-8")), result)
                    self.assertEqual(self.snapshot(), {"registry.lock": before["registry.lock"]})
                else:
                    self.assertFalse(self.base.exists())

    def test_every_command_is_guarded_before_resolution_or_dispatch(self):
        self.layout()
        before = self.snapshot()
        commands = (
            ["start", "missing-repo", "12"], ["restart", "12"], ["launch-watcher"],
            ["watch-run"], ["follow"], ["ack", "1"], ["status"], ["nudge", "worker"],
            ["resume", "worker"], ["relay", "worker", "answer", "--token", "token"],
            ["go"], ["cleanup"], ["config", "show"], ["config", "set", "cap", "2"],
        )
        for argv in commands:
            with self.subTest(argv=argv), \
                    mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("guard first")), \
                    mock.patch.object(herdr_coord, "_coordinator_command") as dispatch:
                code, output = self.cli(*argv)
                self.assertEqual(code, 1, output)
                result = json.loads(output)
                self.assertEqual(result["state"], "refused")
                self.assertIn("retire-legacy", result["detail"])
                dispatch.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_explicit_home_bypasses_guard(self):
        self.layout()
        home = self.root / "explicit"
        with mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("explicit HOME")):
            code, output = self.cli("status", home=home)
        self.assertEqual(code, 0, output)
        self.assertIn("watcher: stale or absent", output)
        self.assertTrue((self.base / "registry.json").exists())

    def test_transaction_is_byte_identical_and_never_recovered(self):
        self.layout(events=[71])
        transaction = self.transaction()
        before = self.snapshot()
        with mock.patch.object(registry, "_recover_transaction", side_effect=AssertionError("must not recover")):
            code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual(result["blockers"][0]["kind"], "interrupted_commit")
        self.assertEqual((self.base / "transaction.json").read_bytes(), transaction)
        self.assertEqual(self.snapshot(), before)

    def test_live_shape_requires_abandon_then_repository_status_works(self):
        lost = self.worker("lost")
        workers = {r"c:\users\user\codeprojects\norm#148": self.worker("cleaned", 148, "norm-148"),
                   r"c:\users\user\codeprojects\norm#143": self.worker("cleaned", 143, "norm-143"),
                   r"c:\users\user\codeprojects\taste-swipe#21": lost}
        self.layout(workers=workers, events=range(1, 72))
        before = self.snapshot()
        code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual([b["kind"] for b in result["blockers"]], ["lost_worker"])
        self.assertEqual(self.snapshot(), before)
        code, result = self.retire("--abandon", lost["agent_name"])
        self.assertEqual(code, 0, result)
        self.assertEqual(result["state"], "retired")
        self.assertEqual(result["abandoned"], [{key: lost[key] for key in
                                               ("agent_name", "issue", "repo_path", "worktree_path")}])
        repo = self.make_repo("after-retirement")
        code, output = self.cli("status", "--repo", str(repo))
        self.assertEqual(code, 0, output)
        self.assertIn("watcher: stale or absent", output)
        self.assertTrue(repo_root.state_root(repo).is_dir())
        self.assertEqual((self.base / "registry.lock").read_bytes(), before["registry.lock"])
        self.assertEqual(self.retire(), (0, {"state": "nothing_to_retire"}))

    def test_receipt_resumes_interrupted_deletion_and_guard_stays_up(self):
        self.layout()
        before = self.snapshot()
        real_unlink = Path.unlink
        def interrupt(path, *args, **kwargs):
            if path == self.base / "heartbeat.json":
                raise PermissionError("simulated interruption after events were removed")
            return real_unlink(path, *args, **kwargs)
        with mock.patch.object(Path, "unlink", autospec=True, side_effect=interrupt), \
                mock.patch.object(herdr_coord.time, "sleep"):
            code, output = self.cli("retire-legacy")
        self.assertEqual(code, 1, output)
        archive = next(self.base.glob("legacy-*"))
        receipt_bytes = (archive / "retirement.json").read_bytes()
        receipt = json.loads(receipt_bytes)
        self.assertFalse((self.base / "events.jsonl").exists())
        self.assertTrue((self.base / "registry.json").exists())
        for name in receipt["files"]:
            self.assertEqual((archive / name).read_bytes(), before[name])
        code, output = self.cli("status")
        self.assertEqual(code, 1, output)
        self.assertIn("retire-legacy", json.loads(output)["detail"])
        code, result = self.retire("--abandon", "unknown")
        self.assertEqual(code, 0, result)
        self.assertEqual(result, receipt)
        self.assertEqual((archive / "retirement.json").read_bytes(), receipt_bytes)
        self.assertEqual(self.snapshot(), {"registry.lock": before["registry.lock"]})
        self.assertEqual(self.retire(), (0, {"state": "nothing_to_retire"}))

    def test_pending_retirement_refuses_changed_original_before_any_deletion(self):
        self.layout()
        receipt = self.pending_receipt()
        # A deleted source may be recreated by drain work after the archive.
        (self.base / "events.jsonl").write_bytes((Path(receipt["archive"]) / "events.jsonl").read_bytes())
        (self.base / "registry.json").write_text('{"changed": true}', encoding="utf-8")
        before = self.snapshot()
        code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual(result["state"], "refused")
        self.assertEqual([b["kind"] for b in result["blockers"]], ["changed_legacy_file"])
        self.assertEqual(result["blockers"][0]["file"], "registry.json")
        self.assertEqual(self.snapshot(), before)

    def test_pending_retirement_refuses_live_watcher(self):
        self.layout()
        receipt = self.pending_receipt()
        archive = Path(receipt["archive"])
        shutil.copyfile(self.base / "watcher.lock", archive / "watcher.lock")
        receipt["files"].append("watcher.lock")
        receipt["sha256"]["watcher.lock"] = hashlib.sha256((archive / "watcher.lock").read_bytes()).hexdigest()
        (archive / "retirement.json").write_text(json.dumps(receipt), encoding="utf-8")
        before = self.snapshot()
        with self.held_watcher():
            code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual([b["kind"] for b in result["blockers"]], ["watcher_running"])
        self.assertEqual(self.snapshot(), before)

    def test_pending_receipt_file_list_guard_deletes_nothing(self):
        for files in (["registry.lock"], [r"..\evil"], "registry.json"):
            with self.subTest(files=files), mock.patch.dict(os.environ):
                self.base = self.root / f"invalid-{len(list(self.root.iterdir()))}"
                os.environ["HERDR_COORD_BASE"] = str(self.base)
                self.layout()
                receipt = self.pending_receipt()
                receipt["files"] = files
                (Path(receipt["archive"]) / "retirement.json").write_text(json.dumps(receipt), encoding="utf-8")
                before = {str(path.relative_to(self.base)): path.read_bytes()
                          for path in self.base.rglob("*") if path.is_file()}
                code, result = self.retire()
                self.assertEqual(code, 1, result)
                self.assertEqual(result["state"], "refused")
                self.assertEqual({str(path.relative_to(self.base)): path.read_bytes()
                                  for path in self.base.rglob("*") if path.is_file()}, before)

    def test_pending_receipt_without_hashes_cannot_delete_originals(self):
        self.layout()
        receipt = self.pending_receipt()
        receipt.pop("sha256")
        (Path(receipt["archive"]) / "retirement.json").write_text(json.dumps(receipt), encoding="utf-8")
        before = self.snapshot()
        code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual(result["state"], "refused")
        self.assertEqual([b["kind"] for b in result["blockers"]], ["changed_legacy_file"])
        self.assertEqual(self.snapshot(), before)

    def test_malformed_legacy_state_refuses_without_deleting(self):
        for fault in ("ack_seq", "queue", "workers", "invalid_registry_json",
                      "non_dict_event", "missing_seq", "invalid_event_json", "invalid_worker_state"):
            with self.subTest(fault=fault), mock.patch.dict(os.environ):
                self.base = self.root / fault
                os.environ["HERDR_COORD_BASE"] = str(self.base)
                doc = self.layout()
                if fault in doc:
                    doc.pop(fault)
                    (self.base / "registry.json").write_text(json.dumps(doc), encoding="utf-8")
                elif fault == "invalid_registry_json":
                    (self.base / "registry.json").write_text("{", encoding="utf-8")
                elif fault == "invalid_worker_state":
                    doc["workers"] = {"worker": {"state": []}}
                    (self.base / "registry.json").write_text(json.dumps(doc), encoding="utf-8")
                else:
                    line = {"non_dict_event": "[]", "missing_seq": "{}", "invalid_event_json": "{"}[fault]
                    (self.base / "events.jsonl").write_text(line + "\n", encoding="utf-8")
                before = self.snapshot()
                code, result = self.retire()
                self.assertEqual(code, 1, result)
                self.assertEqual(result["state"], "refused")
                self.assertEqual([b["kind"] for b in result["blockers"]], ["malformed_legacy_state"])
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(list(self.base.glob("legacy-*")), [])

    def test_legacy_flag_dispatches_drain_commands_without_resolution(self):
        self.layout()
        commands = (["ack", "71"], ["cleanup"], ["resume", "worker"], ["go"],
                    ["status"], ["follow"], ["restart", "12"], ["launch-watcher"],
                    ["watch-run"], ["nudge", "worker"],
                    ["relay", "worker", "answer", "--token", "token"],
                    ["config", "show"], ["config", "set", "cap", "2"],
                    ["config", "--legacy", "show"])
        for argv in commands:
            with self.subTest(argv=argv), \
                    mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("legacy bypass")), \
                    mock.patch.object(herdr_coord, "_coordinator_command") as dispatch:
                def check_root(args):
                    self.assertEqual(os.environ["HERDR_COORD_HOME"], str(self.base))
                    return 0
                dispatch.side_effect = check_root
                code, output = self.cli(*argv, "--legacy")
                self.assertEqual(code, 0, output)
                dispatch.assert_called_once()

    def test_legacy_flag_actually_drains_events_and_holds(self):
        self.layout(events=[72])
        doc = json.loads((self.base / "registry.json").read_text(encoding="utf-8"))
        doc["holds"] = {"watcher_lost": {"ts": 1}}
        (self.base / "registry.json").write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(self.cli("ack", "72", "--legacy")[0], 0)
        import watch
        # Draining legacy state never starts a legacy watcher (retire-legacy refuses while one runs).
        with mock.patch.object(watch, "launch", side_effect=AssertionError("legacy go launched a watcher")):
            self.assertEqual(self.cli("go", "--legacy")[0], 0)
        doc = json.loads((self.base / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["ack_seq"], 72)
        self.assertEqual(doc["holds"], {})

    def test_legacy_flag_refuses_repo_and_new_work(self):
        self.layout()
        before = self.snapshot()
        for argv in (["status", "--legacy", "--repo", "anything"],
                     ["config", "--repo", "anything", "show", "--legacy"],
                     ["start", "anything", "1", "--legacy"]):
            with self.subTest(argv=argv), mock.patch.object(herdr_coord, "_coordinator_command") as dispatch:
                code, output = self.cli(*argv)
                self.assertEqual(code, 1, output)
                self.assertEqual(json.loads(output)["state"], "refused")
                self.assertIn("--legacy", json.loads(output)["detail"])
                dispatch.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_legacy_flag_without_legacy_state_refuses_and_creates_nothing(self):
        with mock.patch.object(herdr_coord, "_coordinator_command") as dispatch:
            code, output = self.cli("status", "--legacy")
        self.assertEqual(code, 1, output)
        self.assertIn("no legacy coordinator state", json.loads(output)["detail"])
        dispatch.assert_not_called()
        self.assertFalse((self.base / "registry.json").exists())

    def test_explicit_home_wins_over_legacy_flag(self):
        self.layout()
        home = self.root / "explicit"
        with mock.patch.object(repo_root, "resolve_repo", side_effect=AssertionError("explicit HOME")):
            code, output = self.cli("status", "--legacy", home=home)
        self.assertEqual(code, 0, output)
        self.assertIn(str(home), output)
        self.assertTrue((self.base / "registry.json").exists())

    def test_other_source_receipt_does_not_skip_checks(self):
        self.layout(workers={"lost": self.worker("lost")})
        self.pending_receipt(source=self.root / "different-source")
        code, result = self.retire()
        self.assertEqual(code, 1, result)
        self.assertEqual(result["blockers"][0]["kind"], "lost_worker")
        self.assertTrue((self.base / "registry.json").exists())

    def test_repeatable_abandon_names(self):
        workers = {"one": self.worker("lost", 1, "one"), "two": self.worker("lost", 2, "two")}
        self.layout(workers=workers)
        code, result = self.retire("--abandon", "one", "--abandon", "two")
        self.assertEqual(code, 0, result)
        self.assertEqual([w["agent_name"] for w in result["abandoned"]], ["one", "two"])

    def test_permission_retries_are_bounded(self):
        operation = mock.Mock(side_effect=[PermissionError("busy"), PermissionError("busy"), "ok"])
        with mock.patch.object(herdr_coord.time, "sleep") as sleep:
            self.assertEqual(herdr_coord._permission_retry(operation), "ok")
        self.assertEqual(operation.call_count, 3)
        self.assertEqual(sleep.call_args_list, [mock.call(0.025), mock.call(0.05)])
        operation = mock.Mock(side_effect=PermissionError("still busy"))
        with mock.patch.object(herdr_coord.time, "sleep") as sleep, self.assertRaises(PermissionError):
            herdr_coord._permission_retry(operation)
        self.assertEqual(operation.call_count, registry._REPLACE_ATTEMPTS)
        self.assertEqual(sleep.call_count, registry._REPLACE_ATTEMPTS - 1)


if __name__ == "__main__":
    unittest.main()
