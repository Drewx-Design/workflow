from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
# A suite run inside herdr must not resolve a real lane.
for name in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
    __import__("os").environ.pop(name, None)

from contextlib import contextmanager, redirect_stdout
import io
import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import actions
import adapters
import herdr_coord
import lanes
import registry
import start
import watch


FIXTURES = Path(__file__).with_name("fixtures")


class WorkspaceLabelTests(unittest.TestCase):
    def test_coordinator_tag_uses_only_a_leading_delimited_c_number(self):
        for label, expected in (
            ("C3-data quality", "C3"), ("c3 issues", "C3"), ("C12", "C12"),
            ("c12:issues", "C12"), ("C3_issues", "C3"), ("C-issues", "seo"),
            ("Colloborator", "seo"), ("C3issues", "seo"), (" C3 issues", "seo"),
            ("C3\tissues", "seo"), ("C3\n", "seo"), (None, "seo"),
        ):
            with self.subTest(label=label):
                self.assertEqual(lanes.coordinator_tag(label, "seo", "boon-town"), expected)
        self.assertEqual(lanes.coordinator_tag(None, "main", "boon-town"), "boon-town")
        self.assertEqual(lanes.coordinator_tag("C-issues", "main", "boon-town"), "boon-town")
        self.assertEqual(lanes.coordinator_tag("C12", "main", "boon-town"), "C12")

    def test_short_title_collapses_whitespace_and_strips_prefixes_and_punctuation(self):
        for title in ("fix: faster issue filing.", "feat(scope): faster issue filing!",
                      "[tag] faster issue filing...", "fix!: faster issue filing\u2026",
                      "  faster\tissue\nfiling  "):
            with self.subTest(title=title):
                self.assertEqual(lanes.short_title(title), "faster issue filing")

    def test_short_title_cuts_at_a_word_boundary_within_32_characters(self):
        self.assertEqual(lanes.short_title("faster issue filing with clearer coordinator labels"),
                         "faster issue filing with clearer")
        title = "a" * 32
        self.assertEqual(lanes.short_title(title + " more"), title)
        self.assertEqual(lanes.short_title("a" * 33), "a" * 32)  # one long word is cut, not dropped
        self.assertEqual(lanes.short_title(None), "")
        self.assertEqual(lanes.short_title("fix\u202e the \u200bgate"), "fix the gate")
        self.assertEqual(lanes.workspace_label("C:/repos/boon-town", "seo", 7, "x\u2066y", tag="C3"), "C3 #7 xy")
        self.assertEqual(lanes.workspace_label("C:/repos/boon-town", "seo", 7, "title", tag="\u2066"), "#7 title")

    def test_empty_title_omits_the_title_and_trailing_space(self):
        for title in ("", " \t\n ", "fix:"):
            with self.subTest(title=title):
                self.assertEqual(lanes.short_title(title), "")
                self.assertEqual(lanes.workspace_label("boon-town", "seo", 12, title, tag="C3"),
                                 "C3 #12")

    def test_workspace_label_removes_tabs_and_control_characters(self):
        self.assertEqual(lanes.workspace_label("boon-town", "seo", 12,
                                               "fix: faster\tissue\nfiling\x01", tag="C3\t\x00\x7f\x85"),
                         "C3 #12 faster issue filing")
        self.assertEqual(lanes.workspace_label("boon-town", "seo", 12, "Issue 12"), "seo #12 Issue 12")


class FakeOps:
    def __init__(self):
        self.workspace = json.loads((FIXTURES / "herdr-workspace-get-main.json").read_text(encoding="utf-8"))
        self.listing = json.loads((FIXTURES / "herdr-workspace-list.json").read_text(encoding="utf-8"))
        self.tab = json.loads((FIXTURES / "herdr-tab-get.json").read_text(encoding="utf-8"))
        self.pane = json.loads((FIXTURES / "herdr-pane-get.json").read_text(encoding="utf-8"))
        self.tabs = json.loads((FIXTURES / "herdr-tab-list-global.json").read_text(encoding="utf-8"))
        self.panes = json.loads((FIXTURES / "herdr-pane-list-global.json").read_text(encoding="utf-8"))
        self.calls = []
        self.get_error = None
        self.list_error = None
        self.reader_errors = {}

    def caller(self, workspace_id, label, *, tab_id=None, tab_label="1", session=None):
        self.workspace["result"]["workspace"].update(workspace_id=workspace_id, label=label)
        tab_id = tab_id or workspace_id + ":t1"
        pane_id = tab_id + ":p1"
        self.tab["result"]["tab"].update(workspace_id=workspace_id, tab_id=tab_id, label=tab_label)
        self.pane["result"]["pane"].update(workspace_id=workspace_id, tab_id=tab_id, pane_id=pane_id,
                                          agent_session={"agent": "claude", "kind": "id",
                                                         "value": session or tab_id + "-session"})
        os.environ.update(HERDR_WORKSPACE_ID=workspace_id, HERDR_TAB_ID=tab_id, HERDR_PANE_ID=pane_id)
        self.live("w1", "w2", workspace_id)

    def live(self, *workspace_ids):
        template = self.listing["result"]["workspaces"][0]
        self.listing["result"]["workspaces"] = [dict(template, workspace_id=value) for value in workspace_ids]
        tab = self.tab["result"]["tab"]
        pane = self.pane["result"]["pane"]
        self.tabs["result"]["tabs"] = [dict(tab, workspace_id=value, tab_id=value + ":t1")
                                        for value in dict.fromkeys(workspace_ids)]
        self.panes["result"]["panes"] = [dict(pane, workspace_id=value, tab_id=value + ":t1",
            pane_id=value + ":t1:p1", agent_session={"agent": "claude", "kind": "id",
                                                   "value": value + ":t1-session"})
            for value in dict.fromkeys(workspace_ids) if value != pane["workspace_id"]]
        self.panes["result"]["panes"].append(dict(pane))
        self.tabs["result"]["tabs"] = [item for item in self.tabs["result"]["tabs"]
                                        if item["workspace_id"] != tab["workspace_id"]] + [dict(tab)]

    def herdr(self, *args, timeout=None):
        self.calls.append((args, timeout))
        assert timeout is not None and 0 < timeout <= 5
        if args[:2] in self.reader_errors:
            error = self.reader_errors[args[:2]]
            if isinstance(error, Exception):
                raise error
            return error
        if args[:2] in (("tab", "get"), ("pane", "get")):
            assert len(args) == 3
            assert args[2] == os.environ[f"HERDR_{args[0].upper()}_ID"]
            data = self.tab if args[0] == "tab" else self.pane
        elif args == ("tab", "list"):
            data = self.tabs
        elif args == ("pane", "list"):
            data = self.panes
        elif args[:2] == ("workspace", "get"):
            assert args[2] == os.environ["HERDR_WORKSPACE_ID"]
            if self.get_error is not None:
                if isinstance(self.get_error, Exception):
                    raise self.get_error
                return self.get_error
            data = self.workspace
        elif args == ("workspace", "list"):
            if self.list_error is not None:
                return self.list_error
            data = self.listing
        else:
            raise AssertionError(f"unexpected herdr command: {args}")
        return adapters.CommandResult(True, 0, json.dumps(data), "", data)


class LaneReaderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "state"
        self.sessions = Path(temp.name) / ".claude" / "sessions"
        environment = dict(os.environ)
        for name in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            environment.pop(name, None)
        environment.update(HERDR_COORD_HOME=str(self.home),
                           HERDR_COORD_REPO=str(Path(temp.name) / "boon-town"),
                           CLAUDE_CONFIG_DIR=str(self.sessions.parent))
        patch = mock.patch.dict(os.environ, environment, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.ops = FakeOps()

    def tearDown(self):
        self.assertFalse(self.home.exists(), "readers must not create coordinator state")

    def test_session_names_skips_incomplete_and_malformed_files(self):
        self.sessions.mkdir(parents=True)
        files = ("", '{"sessionId":', "[]", "null", '{"sessionId": "missing-name"}',
                 '{"name": "missing-id"}', '{"sessionId": 1, "name": "wrong-id-type"}',
                 '{"sessionId": "wrong-name-type", "name": null}',
                 '{"sessionId": "valid", "name": "boon-town-a3"}')
        for index, content in enumerate(files):
            (self.sessions / f"{index}.json").write_text(content, encoding="utf-8")
        (self.sessions / "invalid-encoding.json").write_bytes(b"\xff")
        (self.sessions / "directory.json").mkdir()
        self.assertEqual(lanes.claude_session_names(), {"valid": "boon-town-a3"})

    def test_session_names_picks_greatest_numeric_updated_at(self):
        self.sessions.mkdir(parents=True)
        files = (
            {"sessionId": "duplicate", "name": "old", "updatedAt": 20},
            {"sessionId": "duplicate", "name": "new", "updatedAt": 20.5},
            {"sessionId": "duplicate", "name": "older", "updatedAt": 10},
            {"sessionId": "duplicate", "name": "missing"},
            {"sessionId": "duplicate", "name": "invalid", "updatedAt": "100"},
            {"sessionId": "default", "name": "negative", "updatedAt": -1},
            {"sessionId": "default", "name": "zero"},
            {"sessionId": "tied", "name": "first", "updatedAt": 5},
            {"sessionId": "tied", "name": "second", "updatedAt": 5},
            {"sessionId": "agreed", "name": "same", "updatedAt": 5},
            {"sessionId": "agreed", "name": "same", "updatedAt": 5},
        )
        for index, session in enumerate(files):
            (self.sessions / f"{index}.json").write_text(json.dumps(session), encoding="utf-8")
        self.assertEqual(lanes.claude_session_names(), {"duplicate": "new", "default": "zero", "agreed": "same"})

    def test_session_names_returns_empty_for_missing_folder(self):
        self.assertEqual(lanes.claude_session_names(), {})

    def test_session_names_skips_unreadable_files(self):
        self.sessions.mkdir(parents=True)
        (self.sessions / "session.json").write_text("{}", encoding="utf-8")
        with mock.patch.object(Path, "read_text", side_effect=PermissionError("unreadable")):
            self.assertEqual(lanes.claude_session_names(), {})

    def test_session_names_returns_empty_on_listing_error(self):
        with mock.patch.object(Path, "glob", side_effect=OSError("unreadable folder")):
            self.assertEqual(lanes.claude_session_names(), {})

    def test_session_names_defaults_to_claude_home(self):
        self.sessions.mkdir(parents=True)
        (self.sessions / "session.json").write_text(
            '{"sessionId": "session", "name": "current"}', encoding="utf-8")
        os.environ.pop("CLAUDE_CONFIG_DIR")
        with mock.patch.object(Path, "home", return_value=self.sessions.parent.parent):
            self.assertEqual(lanes.claude_session_names(), {"session": "current"})

    def test_contact_stale_compares_the_name_before_the_final_ref(self):
        binding = {"controller": {"value": "session"}, "contact": "herdr [setup] [21ec30]"}
        before = dict(binding)
        self.assertIsNone(lanes.contact_stale(binding, {"session": "herdr [setup]"}))
        self.assertIsNone(lanes.contact_stale(binding, {"other": "renamed"}))
        self.assertEqual(lanes.contact_stale(binding, {"session": "renamed"}), "renamed")
        self.assertEqual(binding, before)
        binding.pop("contact")
        self.assertIsNone(lanes.contact_stale(binding, {"session": "renamed"}))

    def test_contact_stale_ignores_names_that_would_break_a_status_line(self):
        binding = {"controller": {"value": "session"}, "contact": "norm-98 [bcefc3]"}
        for name in ("a\tb", "a\nhold: x", "a b", "a\x85b", "", "x" * 101):
            with self.subTest(name=name):
                self.assertIsNone(lanes.contact_stale(binding, {"session": name}))

    def caller(self):
        pane = self.ops.pane["result"]["pane"]
        os.environ.update(HERDR_WORKSPACE_ID=pane["workspace_id"],
                          HERDR_TAB_ID=pane["tab_id"], HERDR_PANE_ID=pane["pane_id"])

    def context(self):
        return lanes.read_caller_context(ops=self.ops)

    def snapshot(self, caller_pane_id=None):
        return lanes.read_snapshot(caller_pane_id=caller_pane_id, ops=self.ops)

    def add_caller_to_listing(self):
        self.ops.tabs["result"]["tabs"].append(self.ops.tab["result"]["tab"])
        self.ops.panes["result"]["panes"].append(self.ops.pane["result"]["pane"])

    def test_context_uses_captured_tab_and_pane(self):
        self.caller()
        pane = self.ops.pane["result"]["pane"]
        self.assertEqual(self.context(), {
            "tab_id": "w2:t2S", "pane_id": "w2:p2V", "workspace_id": "w2",
            "controller": {"agent": "claude", "kind": "id", "value": pane["agent_session"]["value"]},
            "tab_label": "herdr",
        })
        self.assertEqual(self.ops.calls, [(("tab", "get", "w2:t2S"), 5),
                                         (("pane", "get", "w2:p2V"), 5)])

    def test_context_without_any_env_ids_is_legacy(self):
        self.assertIsNone(self.context())
        self.assertEqual(self.ops.calls, [])

    def test_context_refuses_every_partial_env_identity_before_herdr(self):
        names = ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID")
        for mask in range(1, 7):
            with self.subTest(mask=mask), mock.patch.dict(os.environ):
                for name in names:
                    os.environ.pop(name, None)
                os.environ.update({name: "id" for bit, name in enumerate(names) if mask & (1 << bit)})
                with self.assertRaisesRegex(ValueError, "identity"):
                    self.context()
        self.assertEqual(self.ops.calls, [])

    def test_context_refuses_blank_env_ids(self):
        self.caller()
        for name in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            for blank in ("", " "):
                with self.subTest(name=name, blank=blank), mock.patch.dict(os.environ, {name: blank}):
                    with self.assertRaisesRegex(ValueError, "identity"):
                        self.context()
        self.assertEqual(self.ops.calls, [])

    def test_context_refuses_mismatching_identities(self):
        self.caller()
        fields = (("pane", "tab_id"), ("pane", "workspace_id"), ("tab", "workspace_id"),
                  ("tab", "tab_id"), ("pane", "pane_id"))
        for entity, field in fields:
            with self.subTest(entity=entity, field=field):
                record = getattr(self.ops, entity)["result"][entity]
                with mock.patch.dict(record, {field: "different"}):
                    with self.assertRaisesRegex(ValueError, "identity"):
                        self.context()
        with mock.patch.dict(os.environ, {"HERDR_WORKSPACE_ID": "different"}):
            with self.assertRaisesRegex(ValueError, "identity"):
                self.context()

    def test_context_requires_session_agent_kind_and_value(self):
        self.caller()
        pane = self.ops.pane["result"]["pane"]
        for session in (None, {}, "bad", {"kind": "id"}, {"value": "session"},
                        {"kind": "", "value": "session"}, {"kind": "id", "value": ""},
                        {"kind": " ", "value": "session"}, {"kind": "id", "value": 12},
                        {"kind": "id", "value": "session"},
                        {"agent": " ", "kind": "id", "value": "session"}):
            with self.subTest(session=session), mock.patch.dict(pane, {"agent_session": session}):
                with self.assertRaisesRegex(ValueError, "agent_session"):
                    self.context()
        with mock.patch.dict(pane):
            del pane["agent_session"]
            with self.assertRaisesRegex(ValueError, "agent_session"):
                self.context()

    def test_context_requires_a_tab_label(self):
        self.caller()
        with mock.patch.dict(self.ops.tab["result"]["tab"], {"label": None}):
            with self.assertRaisesRegex(ValueError, "label"):
                self.context()

    def test_context_refuses_captured_missing_tab_and_pane(self):
        self.caller()
        for entity in ("tab", "pane"):
            missing = json.loads((FIXTURES / f"herdr-{entity}-get-missing.json").read_text(encoding="utf-8"))
            error = adapters.CommandResult(False, 1, "", json.dumps(missing), missing,
                                           missing["error"]["code"], missing["error"]["message"])
            with self.subTest(entity=entity):
                self.ops.reader_errors = {(entity, "get"): error}
                with self.assertRaisesRegex(ValueError, f"Cannot read herdr {entity}"):
                    self.context()

    def test_context_refuses_malformed_json_shapes_and_timeouts(self):
        self.caller()
        for entity in ("tab", "pane"):
            for error in (TimeoutError("slow herdr"), OSError("herdr unavailable"),
                          adapters.CommandResult(False, None, "", "", None, "timeout", "slow"),
                          adapters.CommandResult(True, 0, "{broken", "", None),
                          adapters.CommandResult(True, 0, "null", "", None),
                          adapters.CommandResult(True, 0, "{}", "", {"result": None}),
                          adapters.CommandResult(True, 0, "{}", "", {"result": {entity: []}})):
                with self.subTest(entity=entity, error=error):
                    self.ops.reader_errors = {(entity, "get"): error}
                    with self.assertRaisesRegex(ValueError, f"Cannot read herdr {entity}"):
                        self.context()

    def test_snapshot_reads_global_fixtures_and_counts_sessions_across_workspaces(self):
        self.caller()
        self.add_caller_to_listing()
        panes = self.ops.panes["result"]["panes"]
        tabs = self.ops.tabs["result"]["tabs"]
        caller = panes[-1]
        remote = panes[0]
        self.assertNotEqual(remote["workspace_id"], caller["workspace_id"])
        snapshot = self.snapshot(caller["pane_id"])
        self.assertEqual(snapshot["tab_ids"], {tab["tab_id"] for tab in tabs})
        self.assertEqual(snapshot["controller_counts"], {pane["agent_session"]["value"]: 1 for pane in panes})
        self.assertIn(remote["agent_session"]["value"], snapshot["controller_counts"])
        self.assertEqual(self.ops.calls, [(("tab", "list"), 5), (("pane", "list"), 5)])

    def test_snapshot_counts_a_controller_on_multiple_panes(self):
        panes = self.ops.panes["result"]["panes"]
        panes.append(dict(panes[0], pane_id="w8:other"))
        self.assertEqual(self.snapshot()["controller_counts"][panes[0]["agent_session"]["value"]], 2)

    def test_snapshot_allows_panes_without_an_agent_session(self):
        panes = self.ops.panes["result"]["panes"]
        for session in (None, "missing"):
            with self.subTest(session=session), mock.patch.dict(panes[0]):
                if session is None:
                    panes[0]["agent_session"] = None
                else:
                    del panes[0]["agent_session"]
                self.assertEqual(len(self.snapshot()["controller_counts"]), len(panes) - 1)

    def test_snapshot_is_unknown_on_either_command_error_or_timeout(self):
        for entity in ("tab", "pane"):
            for error in (TimeoutError("slow herdr"), OSError("herdr unavailable"),
                          adapters.CommandResult(False, None, "", "", None, "timeout", "slow"),
                          adapters.CommandResult(False, 1, "", "unavailable", None, "unavailable", "offline")):
                with self.subTest(entity=entity, error=error):
                    self.ops.reader_errors = {(entity, "list"): error}
                    self.assertIsNone(self.snapshot())

    def test_snapshot_is_unknown_on_malformed_json_or_list_shapes(self):
        for entity, key in (("tab", "tabs"), ("pane", "panes")):
            for data in (None, [], {}, {"result": None}, {"result": {key: None}},
                         {"result": {key: {}}}, {"result": {key: [None]}},
                         {"result": {key: [{}]}}, {"result": {key: [{f"{entity}_id": " "}]}}):
                with self.subTest(entity=entity, data=data):
                    self.ops.reader_errors = {(entity, "list"): adapters.CommandResult(True, 0, "{broken", "", data)}
                    self.assertIsNone(self.snapshot())

    def test_snapshot_is_unknown_on_malformed_session(self):
        pane = self.ops.panes["result"]["panes"][0]
        for session in ({}, "bad", {"kind": "id"}, {"kind": "", "value": "session"},
                        {"kind": "id", "value": ""}, {"kind": "id", "value": 12}):
            with self.subTest(session=session), mock.patch.dict(pane, {"agent_session": session}):
                self.assertIsNone(self.snapshot())

    def test_snapshot_is_unknown_on_empty_pane_listing(self):
        self.ops.panes["result"]["panes"] = []
        self.assertIsNone(self.snapshot())

    def test_snapshot_is_unknown_when_it_omits_the_herdr_callers_pane(self):
        self.caller()
        self.assertIsNone(self.snapshot(os.environ["HERDR_PANE_ID"]))

    def test_snapshot_without_caller_is_trusted_outside_herdr(self):
        self.assertIsNotNone(self.snapshot())

    def test_follower_without_caller_guard_sees_closed_controllers_absence(self):
        self.caller()
        context = self.context()
        snapshot = self.snapshot()
        self.assertIsNotNone(snapshot)
        self.assertNotIn(context["controller"]["value"], snapshot["controller_counts"])
        self.assertNotIn(context["tab_id"], snapshot["tab_ids"])

    def test_snapshot_keeps_controller_live_even_when_tab_is_gone(self):
        self.ops.tabs["result"]["tabs"] = []
        controller = self.ops.panes["result"]["panes"][0]["agent_session"]["value"]
        snapshot = self.snapshot()
        self.assertEqual(snapshot["tab_ids"], set())
        self.assertEqual(snapshot["controller_counts"][controller], 1)

    def test_readers_default_to_adapter_without_using_registry(self):
        self.caller()
        self.add_caller_to_listing()
        with mock.patch.object(adapters, "herdr", side_effect=self.ops.herdr), \
                mock.patch.object(registry, "load", side_effect=AssertionError("reader loaded registry")), \
                mock.patch.object(registry, "update", side_effect=AssertionError("reader locked registry")):
            self.assertIsNotNone(lanes.read_caller_context())
            self.assertIsNotNone(lanes.read_snapshot(caller_pane_id=os.environ["HERDR_PANE_ID"]))


class LaneTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "state"
        self.sessions = Path(temp.name) / ".claude" / "sessions"
        values = dict(os.environ)
        for name in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            values.pop(name, None)
        values.update({
            "HERDR_COORD_HOME": str(self.home), "HERDR_COORD_REPO": str(Path(temp.name) / "boon-town"),
            "CLAUDE_CONFIG_DIR": str(self.sessions.parent),
        })
        environment = mock.patch.dict(os.environ, values, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.ops = FakeOps()
        self.ops.caller("w1", "boon-town")

    def resolve(self):
        return self.context()["lane"]

    def seed_binding(self, workspace_id, lane, label, *, session=None, explicit=False, source="tab label"):
        tab_id = workspace_id if ":" in workspace_id else workspace_id + ":t1"
        registry.create_lane(lane)
        registry.update(lambda doc: (doc["lanes"][lane].update(bound_before=True),
            doc["tab_bindings"].update({tab_id: {"lane": lane, "label_seen": label,
                "controller": {"agent": "claude", "kind": "id", "value": session or tab_id + "-session"},
                "pane_id": tab_id + ":p1", "source": source, "explicit": explicit}})))

    def pending(self, lane):
        registry.update(lambda doc: doc["workers"].update({lane: {
            "worker_id": lane, "agent_name": lane + "-worker", "issue": 7,
            "lane": lane, "state": "question"}}))

    def cli(self, *argv):
        with mock.patch.object(adapters, "herdr", side_effect=self.ops.herdr), \
                mock.patch.object(watch, "watcher_alive", return_value=False), \
                redirect_stdout(io.StringIO()) as output:
            code = herdr_coord.main(list(argv))
        return code, output.getvalue()

    def context(self):
        return lanes.resolve_context("boon-town", ops=self.ops)

    def test_row_1_same_controller_refreshes_locators_and_keeps_lane(self):
        self.seed_binding("w1", "seo", "old")
        self.ops.caller("w1", "boon-town", tab_label="SEO work")
        self.ops.pane["result"]["pane"]["pane_id"] = "new-pane"
        os.environ["HERDR_PANE_ID"] = "new-pane"
        self.ops.live("w1")
        context = self.context()
        self.assertEqual(context, {"lane": "seo", "tab_id": "w1:t1", "pane_id": "new-pane",
            "workspace_id": "w1", "controller": {"agent": "claude", "kind": "id", "value": "w1:t1-session"},
            "source": "tab label", "tab_label": "SEO work"})
        binding = registry.load()["tab_bindings"]["w1:t1"]
        self.assertEqual(binding["label_seen"], "SEO work")
        self.assertEqual(binding["pane_id"], "new-pane")

    def test_row_2_duplicate_session_refuses_even_exact_binding(self):
        self.seed_binding("w1", "seo", "old")
        self.ops.panes["result"]["panes"].append(dict(self.ops.pane["result"]["pane"], pane_id="duplicate"))
        before = registry.load()
        for command in (self.resolve, lambda: lanes.bind("perf", ops=self.ops)):
            with self.assertRaisesRegex(ValueError, "duplicate session"):
                command()
        self.assertEqual(registry.load(), before)

    def test_row_3_other_live_controller_in_same_tab_refuses(self):
        self.seed_binding("w1", "seo", "old", session="w2:t1-session")
        for command in (self.resolve, lambda: lanes.bind("perf", ops=self.ops)):
            with self.assertRaises(ValueError) as refusal:
                command()
            for text in ("w1:t1", "w2:t1-se", "rename this tab", "lane bind <another lane>", "close tab w1:t1"):
                self.assertIn(text, str(refusal.exception))

    def test_row_4_controller_bound_to_other_live_tab_refuses(self):
        self.seed_binding("w2", "seo", "old", session="w1:t1-session")
        for command in (self.resolve, lambda: lanes.bind("perf", ops=self.ops)):
            with self.assertRaisesRegex(ValueError, "w2:t1"):
                command()

    def test_row_5_session_recovery_precedes_stale_exact_tab(self):
        self.seed_binding("old", "seo", "old", session="w1:t1-session", explicit=True)
        self.seed_binding("w1", "perf", "1", session="dead")
        self.assertEqual(self.context()["source"], "recovered by session")
        bindings = registry.load()["tab_bindings"]
        self.assertEqual(list(bindings), ["w1:t1"])
        self.assertEqual(bindings["w1:t1"]["lane"], "seo")
        self.assertTrue(bindings["w1:t1"]["explicit"])

    def test_row_6_new_session_in_same_numeric_tab_keeps_explicit_lane(self):
        self.seed_binding("w1", "perf", "1", session="dead", explicit=True)
        self.assertEqual(self.context()["source"], "recovered by tab")
        binding = registry.load()["tab_bindings"]["w1:t1"]
        self.assertEqual(binding["lane"], "perf")
        self.assertTrue(binding["explicit"])

    def test_row_7_unique_nonexplicit_label_recovers(self):
        self.seed_binding("old", "seo", "renamed")
        self.ops.caller("w1", "boon-town", tab_label="renamed")
        self.assertEqual(self.context()["source"], "recovered by label")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["lane"], "seo")
        self.assertNotIn("old:t1", registry.load()["tab_bindings"])

    def test_row_7_numeric_label_never_inherits_history(self):
        self.seed_binding("old", "perf", "1")
        self.assertEqual(self.resolve(), "main")

    def test_steady_state_resolution_does_not_rewrite_the_registry(self):
        self.assertEqual(self.resolve(), "main")
        self.seed_binding("w2", "seo", "seo")  # the caller's binding is no longer the last key
        before = (self.home / "registry.json").read_bytes()
        self.assertEqual(self.resolve(), "main")
        self.assertEqual((self.home / "registry.json").read_bytes(), before)

    def test_row_7_explicit_label_never_inherits_history_after_recovery(self):
        self.ops.caller("w1", "boon-town", tab_label="SEO")
        lanes.bind("perf", ops=self.ops)
        self.ops.caller("w1", "boon-town", tab_label="SEO", session="replacement")
        self.assertEqual(self.context()["source"], "recovered by tab")
        self.ops.caller("w3", "boon-town", tab_label="SEO")
        self.ops.live("w3")
        self.assertEqual(self.resolve(), "seo")

    def test_row_8_multiple_matching_stale_labels_refuse(self):
        self.seed_binding("old", "seo", "shared")
        self.seed_binding("older", "perf", "shared")
        self.ops.caller("w1", "boon-town", tab_label="shared")
        with self.assertRaisesRegex(ValueError, "perf.*seo.*lane bind"):
            self.resolve()

    def test_row_9_tab_slug_and_numeric_workspace_fallback(self):
        for label, expected in (("SEO", "seo"), ("action minutes", "action-minutes"),
                                ("issue 2186", "issue-2186"), ("3", "seo")):
            with self.subTest(label=label), mock.patch.dict(os.environ, {"HERDR_COORD_HOME": str(self.home / expected / label)}):
                self.ops.caller("w1", "boon-town seo", tab_label=label)
                context = self.context()
                self.assertEqual(context["lane"], expected)
                self.assertEqual(context["source"], "workspace fallback" if label.isdigit() else "tab label")

    def test_row_10_owner_is_live_even_with_closed_tab(self):
        self.seed_binding("closed", "main", "1", session="w2:t1-session")
        with self.assertRaisesRegex(ValueError, "closed:t1"):
            self.resolve()

    def test_row_11_pending_orphans_refuse_and_name_work(self):
        self.seed_binding("old", "seo", "SEO")
        self.pending("seo")
        self.ops.caller("w1", "boon-town", tab_label="perf")
        with self.assertRaisesRegex(ValueError, "seo.*seo-worker.*question.*lane bind seo"):
            self.resolve()
        self.assertEqual(lanes.bind("seo", ops=self.ops)["lane"], "seo")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["source"], "explicit")
        registry.update(lambda doc: doc["workers"].clear())
        self.assertEqual(lanes.bind("perf", ops=self.ops)["lane"], "perf")

    def test_row_11_never_bound_main_with_work_does_not_block(self):
        self.pending("main")
        self.ops.caller("w1", "boon-town", tab_label="seo")
        self.assertEqual(self.resolve(), "seo")

    def test_row_11_bound_empty_orphan_does_not_block(self):
        self.seed_binding("old", "perf", "old")
        self.ops.caller("w1", "boon-town", tab_label="seo")
        self.assertEqual(self.resolve(), "seo")

    def test_row_12_derivation_drops_stale_lane_bindings(self):
        self.seed_binding("old", "seo", "old", explicit=True)
        self.ops.caller("w1", "boon-town", tab_label="SEO")
        self.assertEqual(self.resolve(), "seo")
        bindings = registry.load()["tab_bindings"]
        self.assertEqual(list(bindings), ["w1:t1"])
        self.assertFalse(bindings["w1:t1"]["explicit"])

    def test_snapshot_race_retries_before_removing_new_owner(self):
        original = lanes.read_snapshot
        calls = []

        def snapshot(**kwargs):
            result = original(**kwargs)
            calls.append(True)
            if len(calls) == 1:
                self.seed_binding("w2", "main", "1", session="arrived")
                self.ops.panes["result"]["panes"][0]["agent_session"]["value"] = "arrived"
            return result

        with mock.patch.object(lanes, "read_snapshot", side_effect=snapshot):
            with self.assertRaisesRegex(ValueError, "w2:t1"):
                self.resolve()
        self.assertEqual(len(calls), 2)
        self.assertEqual(list(registry.load()["tab_bindings"]), ["w2:t1"])

    def test_unknown_snapshot_preserves_owner_and_refuses(self):
        self.seed_binding("w1", "seo", "old")
        self.ops.reader_errors[("pane", "list")] = TimeoutError("unknown")
        before = registry.load()
        for command in (self.resolve, lambda: lanes.bind("perf", ops=self.ops)):
            with self.assertRaisesRegex(ValueError, "snapshot"):
                command()
        self.assertEqual(registry.load(), before)

    def test_snapshot_race_exhausts_three_attempts_without_writing_binding(self):
        original = lanes.read_snapshot
        observed = []

        def snapshot(**kwargs):
            result = original(**kwargs)
            self.seed_binding("racer", "other", str(len(observed)))
            observed.append(registry.load())
            return result

        with mock.patch.object(lanes, "read_snapshot", side_effect=snapshot):
            code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 1, output)
        self.assertIn("Lane bindings changed during herdr snapshot; retry the command", output)
        self.assertEqual(len(observed), 3)
        self.assertEqual(registry.load(), observed[-1])
        self.assertNotIn("w1:t1", registry.load()["tab_bindings"])
        self.assertNotIn("seo", registry.load()["lanes"])

    def test_bind_refuses_move_off_lane_with_live_follower(self):
        self.seed_binding("w1", "seo", "old")
        lease = {"pid": 123, "process_created": 456}
        registry.update(lambda doc: doc["lanes"]["seo"].update(follow_lease=lease))
        before = registry.load()
        with mock.patch.object(watch, "follower_alive", side_effect=lambda name, value: name == "seo" and value == lease):
            with self.assertRaisesRegex(ValueError, "follow"):
                lanes.bind("perf", ops=self.ops)
            self.assertEqual(registry.load(), before)
            self.assertEqual(lanes.bind("seo", ops=self.ops)["lane"], "seo")

    def test_bind_target_lease_checks_controller_liveness(self):
        registry.create_lane("perf")
        controller = {"agent": "claude", "kind": "id", "value": "w2:t1-session"}
        registry.update(lambda doc: doc["lanes"]["perf"].update(follow_lease={
            "pid": 123, "process_created": 456, "controller": controller}))
        with mock.patch.object(watch, "follower_alive", return_value=True):
            with self.assertRaisesRegex(ValueError, "follow"):
                lanes.bind("perf", ops=self.ops)
            self.ops.live("w1")
            self.assertEqual(lanes.bind("perf", ops=self.ops)["lane"], "perf")
        bindings = registry.load()["tab_bindings"]
        self.assertEqual(list(bindings), ["w1:t1"])
        self.assertTrue(bindings["w1:t1"]["explicit"])

    def test_bind_refuses_live_outside_follower_without_a_binding(self):
        registry.update(lambda doc: doc["lanes"]["main"].update(
            follow_lease={"pid": 123, "process_created": 456}))
        before = registry.load()
        with mock.patch.object(watch, "follower_alive", return_value=True):
            with self.assertRaisesRegex(ValueError,
                    "Lane main has a live follow outside herdr; stop it before running lane bind main"):
                lanes.bind("main", ops=self.ops)
        self.assertEqual(registry.load(), before)

    def test_bind_infers_pid_only_follow_owner_from_existing_binding(self):
        for session, allowed in (("w1:t1-session", True), ("w2:t1-session", False)):
            with self.subTest(session=session):
                registry.update(lambda doc: doc["tab_bindings"].clear())
                self.seed_binding("closed", "seo", "old", session=session)
                registry.update(lambda doc: doc["lanes"]["seo"].update(
                    follow_lease={"pid": 123, "process_created": 456}))
                before = registry.load()
                with mock.patch.object(watch, "follower_alive", return_value=True), \
                        mock.patch.object(lanes, "_check_target"):
                    # Isolate the follower guard: a live binding normally refuses even earlier.
                    if allowed:
                        self.assertEqual(lanes.bind("seo", ops=self.ops)["lane"], "seo")
                    else:
                        with self.assertRaisesRegex(ValueError, "live follower for another session w2:t1-se"):
                            lanes.bind("seo", ops=self.ops)
                        self.assertEqual(registry.load(), before)

    def test_outside_herdr_main_owner_guard_and_context(self):
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            os.environ.pop(key)
        context = self.context()
        self.assertEqual(context["lane"], "main")
        for key in ("tab_id", "pane_id", "controller", "workspace_id"):
            self.assertIsNone(context[key])
        # With no tab binding naming main there is no owner to find, so herdr is not needed.
        self.ops.reader_errors[("pane", "list")] = TimeoutError("unknown")
        self.assertEqual(self.resolve(), "main")
        del self.ops.reader_errors[("pane", "list")]
        self.seed_binding("w2", "main", "1")
        with self.assertRaisesRegex(ValueError, "w2:t1"):
            self.resolve()
        self.ops.reader_errors[("pane", "list")] = TimeoutError("unknown")
        with self.assertRaisesRegex(ValueError, "snapshot"):
            self.resolve()

    def test_migrated_bound_main_blocks_until_claimed_preserving_events(self):
        seqs = [registry.append_event("issue_refused", {}) for _ in range(3)]
        doc = registry.load()
        doc.update(version=2, workspace_bindings={"w1": {"lane": "main", "label_seen": "boon-town"}})
        doc.pop("tab_bindings")
        registry.save(doc)
        self.ops.caller("w1", "boon-town", tab_id="w1:conveo", tab_label="conveo")
        with self.assertRaisesRegex(ValueError, "main.*lane bind main"):
            self.resolve()
        self.ops.caller("w1", "boon-town")
        self.assertEqual(self.resolve(), "main")
        self.assertEqual([event["seq"] for event in registry.read_events(0)], seqs)
        self.ops.caller("w1", "boon-town", tab_id="w1:conveo", tab_label="conveo")
        self.ops.panes["result"]["panes"].append({"pane_id": "w1:t1:p1", "agent_session": {
            "agent": "claude", "kind": "id", "value": "w1:t1-session"}})
        self.assertEqual(self.resolve(), "conveo")

    def test_two_tabs_claiming_main_concurrently_have_one_winner(self):
        contexts = []
        for tab in ("w1:tA", "w1:tB"):
            self.ops.caller("w1", "boon-town", tab_id=tab)
            contexts.append(lanes.read_caller_context(ops=self.ops))
        snapshot = {"tab_ids": {item["tab_id"] for item in contexts},
                    "controller_counts": {item["controller"]["value"]: 1 for item in contexts}}
        barrier = threading.Barrier(2, timeout=5)
        local = threading.local()
        results = []

        def read(**kwargs):
            if not getattr(local, "read", False):
                local.read = True
                barrier.wait()
            return snapshot

        def claim(context):
            local.context = context
            try:
                results.append(self.resolve())
            except ValueError as exc:
                results.append(str(exc))

        with mock.patch.object(lanes, "read_caller_context", side_effect=lambda **kwargs: local.context), \
                mock.patch.object(lanes, "read_snapshot", side_effect=read):
            threads = [threading.Thread(target=claim, args=(context,), daemon=True) for context in contexts]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
                self.assertFalse(thread.is_alive())
        self.assertEqual(results.count("main"), 1, results)
        self.assertIn("owned by tab", next(value for value in results if value != "main"))
        self.assertEqual(len(registry.load()["tab_bindings"]), 1)

    def test_repository_label_binds_main_without_orphans(self):
        self.assertEqual(self.resolve(), "main")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["lane"], "main")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["source"], "workspace fallback")

    def test_label_derivation(self):
        for label, expected in (("boon-town seo", "seo"), ("boon-town-ca", "ca"),
                                ("boon-town  SEO Work", "seo-work"), ("action minutes", "main"),
                                ("boon-town -  ", "main"), ("boon-township seo", "main")):
            with self.subTest(label=label), mock.patch.dict(os.environ, {
                "HERDR_COORD_HOME": str(self.home / expected / label.replace(" ", "_"))
            }):
                self.ops.caller("w1", label)
                self.assertEqual(self.resolve(), expected)

    def test_short_worker_labels_without_a_repository_prefix_derive_main(self):
        for label in ("C3 #12 faster issue filing", "seo #12 faster issue filing"):
            with self.subTest(label=label):
                self.assertEqual(lanes._derived_lane("boon-town", {"label": label}), "main")

    def test_worker_fixture_uses_workspace_label(self):
        self.ops.workspace = json.loads((FIXTURES / "herdr-workspace-get-worker.json").read_text(encoding="utf-8"))
        self.ops.caller("w23", "norm #339")
        self.assertEqual(self.resolve(), "main")
        self.assertEqual(registry.load()["tab_bindings"]["w23:t1"]["label_seen"], "1")

    def test_workspace_repository_metadata_is_fallback_for_explicit_state_root(self):
        self.ops.caller("w1", "boon-town seo")
        self.assertEqual(lanes.resolve_context(ops=self.ops)["lane"], "seo")

    def test_derived_lane_starts_at_current_event_sequence(self):
        registry.append_event("watcher_started", {})
        self.ops.caller("w1", "boon-town seo")
        self.assertEqual(self.resolve(), "seo")
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], 1)

    def test_ambiguous_saved_labels_refuse_without_choosing_a_lane(self):
        self.seed_binding("old", "seo", "shared label")
        self.seed_binding("older", "app", "shared label")
        self.ops.caller("w1", "boon-town", tab_label="shared label")
        before = registry.load()
        with self.assertRaisesRegex(ValueError, "several lanes: app, seo"):
            self.resolve()
        self.assertEqual(registry.load(), before)

    def test_bound_workspace_rename_refreshes_label_without_changing_lane(self):
        self.seed_binding("w1", "seo", "boon-town seo")
        self.ops.caller("w1", "boon-town", tab_label="boon-town app")
        self.assertEqual(self.resolve(), "seo")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["label_seen"], "boon-town app")

    def test_refreshed_label_reattaches_after_workspace_id_changes(self):
        self.seed_binding("old", "seo", "boon-town seo")
        self.ops.caller("old", "boon-town", tab_label="boon-town app")
        self.assertEqual(self.resolve(), "seo")
        self.ops.caller("w1", "boon-town", tab_label="boon-town app")
        self.assertEqual(self.resolve(), "seo")
        self.assertNotIn("old:t1", registry.load()["tab_bindings"])
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["lane"], "seo")

    def test_unknown_label_refuses_other_orphaned_lanes(self):
        self.seed_binding("old", "seo", "boon-town seo")
        self.seed_binding("older", "docs", "boon-town docs")
        self.pending("seo")
        self.pending("docs")
        self.ops.caller("w1", "boon-town app")
        self.ops.live("w1")
        before = registry.load()
        with self.assertRaisesRegex(ValueError, r"docs.*seo.*lane bind"):
            self.resolve()
        self.assertEqual(registry.load(), before)

    def test_derived_orphan_recovers_even_with_other_orphans(self):
        self.seed_binding("old", "seo", "old label")
        self.seed_binding("older", "docs", "other old label")
        self.pending("seo")
        self.pending("docs")
        self.ops.caller("w1", "boon-town seo")
        self.ops.live("w1")
        self.assertEqual(self.resolve(), "seo")

    def test_live_binding_is_not_an_orphan(self):
        self.seed_binding("w2", "seo", "boon-town seo")
        self.pending("seo")
        self.ops.caller("w1", "boon-town app")
        self.assertEqual(self.resolve(), "app")

    def test_duplicate_live_label_cannot_take_another_workspaces_lane(self):
        self.seed_binding("w2", "seo", "boon-town seo")
        self.ops.caller("w1", "boon-town seo")
        self.ops.live("w1", "w2")
        before = registry.load()
        with self.assertRaises(ValueError) as refused:
            self.resolve()
        for text in ("w2:t1", "rename this tab", "lane bind <another lane>", "close tab w2:t1"):
            self.assertIn(text, str(refused.exception))
        self.assertEqual(registry.load(), before)

    def test_unrelated_label_cannot_take_live_main(self):
        self.seed_binding("w2", "main", "boon-town")
        self.ops.caller("w1", "action minutes")
        self.ops.live("w1", "w2")
        before = registry.load()
        with self.assertRaises(ValueError) as refused:
            self.resolve()
        for text in ("w2:t1", "rename this tab", "lane bind <another lane>", "close tab w2:t1"):
            self.assertIn(text, str(refused.exception))
        self.assertEqual(registry.load(), before)

    def test_matching_stale_label_does_not_remove_another_live_binding(self):
        self.seed_binding("old", "seo", "boon-town seo")
        self.seed_binding("w2", "seo", "renamed coordinator")
        self.ops.caller("w1", "boon-town", tab_label="boon-town seo")
        self.ops.live("w1", "w2")
        before = registry.load()
        with self.assertRaisesRegex(ValueError, "w2"):
            self.resolve()
        self.assertEqual(registry.load(), before)

    def test_resolution_reads_snapshot_outside_lock_after_binding_disappears(self):
        self.seed_binding("w1", "seo", "boon-town seo")
        self.ops.caller("w1", "boon-town seo")
        update = registry.update
        inside_update = []
        original = self.ops.herdr

        def race(change):
            if "w1:t1" in registry.load()["tab_bindings"]:
                update(lambda doc: doc["tab_bindings"].pop("w1:t1"))

            def checked(doc):
                inside_update.append(True)
                try:
                    return change(doc)
                finally:
                    inside_update.pop()

            return update(checked)

        def herdr(*args, **kwargs):
            self.assertFalse(inside_update, "herdr fetched inside registry update")
            return original(*args, **kwargs)

        with mock.patch.object(registry, "update", side_effect=race), \
                mock.patch.object(self.ops, "herdr", side_effect=herdr):
            self.assertEqual(self.resolve(), "seo")
        self.assertEqual([call[0] for call in self.ops.calls].count(("pane", "list")), 2)

    def test_unrefreshed_unrelated_label_does_not_adopt_live_main(self):
        self.seed_binding("old", "seo", "boon-town seo")
        self.seed_binding("w2", "main", "boon-town")
        self.ops.caller("w1", "action minutes")
        self.ops.live("w1", "w2")
        with self.assertRaisesRegex(ValueError, "main"):
            self.resolve()
        self.assertNotIn("w1:t1", registry.load()["tab_bindings"])

    def test_only_main_workspace_recovers_after_unrefreshed_rename(self):
        self.seed_binding("old", "main", "boon-town")
        self.ops.caller("w1", "action minutes")
        self.ops.live("w1")
        self.assertEqual(self.resolve(), "main")

    def test_never_bound_main_after_migration_is_not_orphaned(self):
        registry.update(lambda doc: None)
        self.assertEqual(self.resolve(), "main")

    def test_explicit_bind_bypasses_orphan_refusal(self):
        self.seed_binding("old", "seo", "boon-town seo")
        self.pending("seo")
        self.ops.caller("w1", "unknown")
        self.ops.live("w1")
        code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output)["lane"], "seo")
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["lane"], "seo")

    def test_bind_creates_lane_at_current_event_sequence(self):
        registry.append_event("watcher_started", {})
        code, output = self.cli("lane", "bind", "app")
        self.assertEqual(code, 0, output)
        self.assertEqual(registry.load()["lanes"]["app"]["ack_seq"], 1)

    def test_bind_returns_the_bound_context(self):
        self.assertEqual(lanes.bind("seo", ops=self.ops), {
            "lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
            "controller": {"agent": "claude", "kind": "id", "value": "w1:t1-session"},
            "source": "explicit", "tab_label": "1"})

    def test_contact_records_valid_addresses_and_strips_outer_whitespace(self):
        for address in ("norm-98 [bcefc3]", "herdr setup [21ec30]", "  norm-98 [bcefc3]  ",
                        "x [aB12]", "x" * 100 + " [0123456789ABCDEF]"):
            with self.subTest(address=address):
                code, output = self.cli("lane", "contact", address)
                self.assertEqual(code, 0, output)
                self.assertEqual(json.loads(output), {
                    "state": "contact_recorded", "lane": "main", "tab_id": "w1:t1",
                    "contact": address.strip()})
                self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["contact"], address.strip())

    def test_contact_rejects_invalid_addresses_without_replacing_contact(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        before = registry.load()
        for address in ("norm-98", "norm\t98 [bcefc3]", "norm\n98 [bcefc3]", " [bcefc3]",
                        "", "norm\x00 [bcefc3]", "norm\x1f [bcefc3]", "norm\x7f [bcefc3]",
                        "norm [abc]", "norm [0123456789abcdef0]", "norm [abc-]",
                        "x" * 101 + " [abcd]", "norm\x85 [bcefc3]", "norm hold: x [bcefc3]",
                        "norm  [bcefc3]"):
            with self.subTest(address=address):
                code, output = self.cli("lane", "contact", "--", address)
                self.assertEqual(code, 1, output)
                self.assertEqual(json.loads(output), {
                    "state": "refused",
                    "detail": 'contact must be the session\'s messaging name and ref, for example "norm-98 [bcefc3]"'})
                self.assertEqual(registry.load(), before)

    def test_contact_survives_ordinary_commands_and_status_preserves_other_lane_lines(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        self.seed_binding("w2", "app", "app")
        before = (self.home / "registry.json").read_bytes()
        self.assertEqual(self.cli("config", "show")[0], 0)
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: main\tfollow=absent\tunhandled=0\towner=w1:t1\tcontact=norm-98 [bcefc3]",
                      output.splitlines())
        self.assertIn("lane: app\tfollow=absent\tunhandled=0\towner=w2:t1", output.splitlines())
        self.assertEqual((self.home / "registry.json").read_bytes(), before)
        self.assertEqual(list(registry.load()["tab_bindings"]), ["w1:t1", "w2:t1"])

    def test_status_flags_only_known_renamed_contacts_and_preserves_lane_lines(self):
        contact = "boon-town-30 [4a7118]"
        self.assertEqual(self.cli("lane", "contact", contact)[0], 0)
        self.seed_binding("w2", "app", "app")
        before = (self.home / "registry.json").read_bytes()
        self.sessions.mkdir(parents=True)
        (self.sessions / "contactless.json").write_text(
            '{"sessionId": "w2:t1-session", "name": "app-renamed"}', encoding="utf-8")
        for name, session_id, suffix in (
            ("boon-town-a3", "w1:t1-session", "\tcontact_stale=boon-town-a3"),
            ("boon-town-30", "w1:t1-session", ""),
            ("unrelated", "unknown-session", ""),
        ):
            with self.subTest(name=name, session_id=session_id):
                (self.sessions / "owner.json").write_text(
                    json.dumps({"sessionId": session_id, "name": name}), encoding="utf-8")
                code, output = self.cli("status")
                self.assertEqual(code, 0, output)
                self.assertIn("lane: main\tfollow=absent\tunhandled=0\towner=w1:t1"
                              f"\tcontact={contact}{suffix}", output.splitlines())
                self.assertIn("lane: app\tfollow=absent\tunhandled=0\towner=w2:t1", output.splitlines())
                self.assertEqual((self.home / "registry.json").read_bytes(), before)

    def test_status_places_contact_before_follower_mismatch(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        registry.update(lambda doc: doc["lanes"]["main"].update(follow_lease={}))
        with mock.patch.object(watch, "follower_alive", return_value=True):
            code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: main\tfollow=live\tunhandled=0\towner=w1:t1\tcontact=norm-98 [bcefc3]"
                      "\tmismatch=tab_id differs from binding; controller differs from binding", output.splitlines())

    def test_status_shows_only_the_chosen_owners_contact(self):
        self.context()
        self.seed_binding("stale", "seo", "old")
        self.seed_binding("w2", "seo", "seo")
        registry.update(lambda doc: doc["tab_bindings"]["stale:t1"].update(contact="old [abcd]"))
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: seo\tfollow=absent\tunhandled=0\towner=w2:t1", output.splitlines())
        self.ops.live("w1")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: seo\tfollow=absent\tunhandled=0\towner=none", output.splitlines())

    def test_contact_survives_session_recovery_over_a_stale_tab_binding(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        self.ops.caller("w3", "boon-town", tab_id="w3:t2", tab_label="new tab", session="w1:t1-session")
        self.ops.live("w3")
        self.seed_binding("w3:t2", "perf", "old", session="dead")
        registry.update(lambda doc: doc["tab_bindings"]["w3:t2"].update(contact="other [abcd]"))
        context = self.context()
        self.assertEqual(context["source"], "recovered by session")
        bindings = registry.load()["tab_bindings"]
        self.assertEqual(list(bindings), ["w3:t2"])
        self.assertEqual(bindings["w3:t2"]["lane"], "main")
        self.assertEqual(bindings["w3:t2"]["contact"], "norm-98 [bcefc3]")

    def test_contact_is_dropped_when_claude_restarts_in_the_tab(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        self.ops.caller("w1", "boon-town", session="replacement")
        self.assertEqual(self.context()["source"], "recovered by tab")
        self.assertNotIn("contact", registry.load()["tab_bindings"]["w1:t1"])
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: main\tfollow=absent\tunhandled=0\towner=w1:t1", output.splitlines())

    def test_contact_is_dropped_when_another_session_takes_a_stale_lane(self):
        for label, source in (("SEO", "recovered by label"), ("seo", "tab label")):
            with self.subTest(source=source), mock.patch.dict(os.environ, {
                    "HERDR_COORD_HOME": str(self.home / source)}):
                self.ops.caller("w1", "boon-town", tab_label="SEO")
                self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
                self.ops.caller("w3", "boon-town", tab_label=label)
                self.ops.live("w3")
                self.assertEqual(self.context()["source"], source)
                bindings = registry.load()["tab_bindings"]
                self.assertEqual(list(bindings), ["w3:t1"])
                self.assertNotIn("contact", bindings["w3:t1"])

    def test_contact_refuses_outside_herdr_and_legacy_without_calling_herdr(self):
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            os.environ.pop(key)
        for address, options in (("norm-98 [bcefc3]", ()), ("norm-98 [bcefc3]", ("--legacy",)), ("norm-98", ())):
            with self.subTest(address=address, options=options):
                code, output = self.cli("lane", "contact", address, *options)
                self.assertEqual(code, 1, output)
                self.assertEqual(json.loads(output), {
                    "state": "refused", "detail": "lane contact requires a herdr tab"})
                self.assertEqual(registry.load()["tab_bindings"], {})
        self.assertEqual(self.ops.calls, [])

    def test_contact_propagates_ordinary_lane_resolution_refusals(self):
        self.ops.reader_errors[("pane", "list")] = TimeoutError("unknown")
        code, output = self.cli("lane", "contact", "norm-98 [bcefc3]")
        self.assertEqual(code, 1, output)
        self.assertEqual(json.loads(output), {
            "state": "refused", "detail": "Cannot read herdr ownership snapshot; existing owners count as live"})
        self.assertFalse((self.home / "registry.json").exists())

    def test_contact_refuses_if_binding_moves_after_resolution(self):
        self.assertEqual(self.cli("lane", "contact", "norm-98 [bcefc3]")[0], 0)
        registry.create_lane("seo")
        original_binding = registry.load()["tab_bindings"]["w1:t1"]
        resolve = lanes.resolve_context
        for change in ("removed", "lane", "agent", "kind", "value"):
            with self.subTest(change=change):
                registry.update(lambda doc: doc["tab_bindings"].update({"w1:t1": dict(original_binding)}))
                moved = []

                def move_after_resolution(*args, **kwargs):
                    context = resolve(*args, **kwargs)

                    def move(doc):
                        binding = doc["tab_bindings"][context["tab_id"]]
                        if change == "removed":
                            doc["tab_bindings"].pop(context["tab_id"])
                        elif change == "lane":
                            binding["lane"] = "seo"
                        else:
                            binding["controller"][change] = "different"

                    registry.update(move)
                    moved.append(registry.load())
                    return context

                with mock.patch.object(lanes, "resolve_context", side_effect=move_after_resolution):
                    code, output = self.cli("lane", "contact", "herdr setup [21ec30]")
                self.assertEqual(code, 1, output)
                self.assertEqual(json.loads(output), {
                    "state": "refused", "detail": "lane binding moved; run status"})
                self.assertEqual(registry.load(), moved[0])

    def test_bind_receipt_uses_the_bound_context(self):
        context = lanes.bind("seo", ops=self.ops)
        os.environ.update(HERDR_TAB_ID="different-tab", HERDR_PANE_ID="different-pane")
        with mock.patch.object(lanes, "bind", return_value=context):
            code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output), {
            "state": "bound", "lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1",
            "session": "w1:t1-se", "source": "explicit"})

    def test_string_only_resolver_is_removed(self):
        self.assertFalse(hasattr(lanes, "resolve"))

    def test_bind_refuses_lane_owned_by_existing_workspace(self):
        self.seed_binding("w2", "seo", "boon-town seo")
        before = registry.load()
        code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 1, output)
        self.assertIn("w2", json.loads(output)["detail"])
        self.assertEqual(registry.load(), before)

    def test_bind_same_workspace_is_repeatable(self):
        self.seed_binding("w1", "seo", "boon-town seo")
        code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 0, output)
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["label_seen"], "1")

    def test_lane_detached_by_explicit_bind_is_still_previously_bound(self):
        self.ops.caller("w1", "boon-town seo")
        self.assertEqual(self.resolve(), "seo")
        self.pending("seo")
        self.assertEqual(self.cli("lane", "bind", "app")[0], 0)
        self.ops.caller("w3", "unknown")
        self.ops.live("w1", "w3")
        with self.assertRaisesRegex(ValueError, "seo"):
            self.resolve()

    def test_invalid_bind_names_refuse_without_writes(self):
        for name in ("", "SEO", "two words", "../app", "-app"):
            with self.subTest(name=name):
                code, output = self.cli("lane", "bind", "--", name)
                self.assertEqual(code, 1, output)
                self.assertIn("slug", json.loads(output)["detail"])
        self.assertFalse((self.home / "registry.json").exists())

    def test_unreadable_label_refuses_relay_but_status_prints(self):
        missing = json.loads((FIXTURES / "herdr-workspace-get-missing.json").read_text(encoding="utf-8"))
        errors = [adapters.CommandResult(False, 1, json.dumps(missing), "", missing,
                                        missing["error"]["code"], missing["error"]["message"]),
                  TimeoutError("slow herdr"), adapters.CommandResult(True, 0, "{}", "", {}),
                  adapters.CommandResult(True, 0, "null", "", {"result": None}),
                  adapters.CommandResult(True, 0, "{}", "", {"result": {"workspace": {"label": None}}})]
        for error in errors:
            with self.subTest(error=error), mock.patch.object(actions, "relay") as relay:
                self.ops.get_error = error
                code, output = self.cli("relay", "worker", "answer", "--token", "token")
                self.assertEqual(code, 1, output)
                self.assertIn("workspace label", json.loads(output)["detail"])
                relay.assert_not_called()
                code, output = self.cli("status")
                self.assertEqual(code, 0, output)
                self.assertIn("lane resolution:", output)
                self.assertIn("lane: main", output)

    def test_repo_wide_commands_run_despite_lane_resolution_failure(self):
        for failure in ("timeout", "orphan"):
            if failure == "timeout":
                self.ops.get_error = TimeoutError("slow herdr")
            else:
                self.ops.get_error = None
                self.seed_binding("old", "seo", "boon-town seo")
                self.pending("seo")
                self.ops.caller("w1", "boon-town app")
                self.ops.live("w1")
            for command in ("go", "launch-watcher", "config", "watch-run"):
                with self.subTest(failure=failure, command=command), \
                        mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None), \
                        mock.patch.object(watch, "launch", return_value={"state": "launched"}) as launch, \
                        mock.patch.object(watch, "run", return_value=0) as run, \
                        mock.patch.object(actions, "go", wraps=actions.go) as go:
                    code, output = self.cli(command, *(["show"] if command == "config" else []))
                    self.assertEqual(code, 0, output)
                    if command == "go":
                        go.assert_called_once_with()
                    elif command == "launch-watcher":
                        launch.assert_called_once_with()
                    elif command == "watch-run":
                        run.assert_called_once_with()
                    else:
                        self.assertEqual(json.loads(output), registry.load()["config"])

    def test_status_marks_callers_lane_immediately_after_repo(self):
        self.ops.caller("w1", "boon-town seo")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertTrue(output.splitlines()[0].startswith("repo: "))
        self.assertEqual(output.splitlines()[1],
                         "this lane: seo (tab w1:t1, session w1:t1-se, source workspace fallback)")

    def test_status_shows_each_binding_source(self):
        self.ops.caller("w1", "boon-town", tab_label="seo")
        for source in ("tab label", "workspace fallback", "explicit", "recovered by session",
                       "recovered by tab", "recovered by label"):
            with self.subTest(source=source):
                self.seed_binding("w1", "seo", "old label", source=source,
                                  explicit=source == "explicit")
                code, output = self.cli("status")
                self.assertEqual(code, 0, output)
                self.assertEqual(output.splitlines()[1],
                                 f"this lane: seo (tab w1:t1, session w1:t1-se, source {source})")

    def test_status_shows_current_label_after_bound_tab_is_renamed(self):
        self.ops.caller("w1", "boon-town", tab_label="seo")
        self.assertEqual(self.resolve(), "seo")
        self.ops.caller("w1", "boon-town", tab_label="SEO work")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("this lane: seo (tab w1:t1, session w1:t1-se, "
                      "source tab label (seen as SEO work))", output)
        self.assertEqual(registry.load()["tab_bindings"]["w1:t1"]["lane"], "seo")

    def test_status_shows_seen_as_for_label_recovery(self):
        self.seed_binding("old", "seo", "SEO work")
        self.ops.caller("w1", "boon-town", tab_label="SEO work")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("source recovered by label (seen as SEO work)", output)
        binding = registry.load()["tab_bindings"]["w1:t1"]
        self.assertEqual(binding["lane"], "seo")
        self.assertEqual(binding["source"], "recovered by label")

    def test_pending_description_summarizes_a_long_event_backlog(self):
        registry.create_lane("seo")
        registry.update(lambda doc: doc["lanes"]["seo"].update(bound_before=True))
        for _ in range(40):
            registry.append_event("issue_refused", {}, caller_lane="seo")
        text = lanes.pending_description(registry.load(), "seo")
        self.assertIn("40 unacknowledged events (1-40)", text)
        self.assertNotIn("1, 2, 3", text)

    def test_status_waits_for_locked_append_before_reading_ownerless_pending_work(self):
        context = self.context()
        self.seed_binding("old", "seo", "seo")
        begin, torn, finish = (threading.Event() for _ in range(3))
        errors = []
        locked, read_events, internal = registry.locked, registry.read_events, registry._read_events

        def append():
            try:
                if not begin.wait(timeout=5):
                    raise TimeoutError("status never reached the ownerless lane")
                with locked(timeout=5):
                    doc = registry.load()
                    event = json.dumps({"seq": doc["event_seq"] + 1, "kind": "issue_refused",
                                        "payload": {}, "lanes": ["seo"]}) + "\n"
                    with (self.home / "events.jsonl").open("a", encoding="utf-8") as handle:
                        middle = len(event) // 2
                        handle.write(event[:middle])
                        handle.flush()
                        torn.set()
                        if not finish.wait(timeout=5):
                            raise TimeoutError("status neither took the lock nor read the torn event")
                        handle.write(event[middle:])
                        handle.flush()
                    doc["event_seq"] += 1
                    doc["queue"].append({"issue": 8, "state": "queued", "lane": "seo"})
                    registry.save(doc)
            except BaseException as exc:
                errors.append(exc)

        def read(after_seq, *, lane="main"):
            result = read_events(after_seq, lane=lane)
            if lane == "seo":
                begin.set()
                self.assertTrue(torn.wait(timeout=5), "writer did not publish a torn event")
            return result

        @contextmanager
        def status_lock(*args, **kwargs):
            if torn.is_set():
                finish.set()
            with locked(*args, **kwargs):
                yield

        def read_internal(*args, **kwargs):
            try:
                return internal(*args, **kwargs)
            finally:
                if torn.is_set():
                    finish.set()

        writer = threading.Thread(target=append, daemon=True)
        writer.start()
        try:
            with mock.patch.object(lanes, "resolve_context", return_value=context), \
                    mock.patch.object(registry, "locked", side_effect=status_lock), \
                    mock.patch.object(registry, "read_events", side_effect=read), \
                    mock.patch.object(registry, "_read_events", side_effect=read_internal), \
                    mock.patch.object(registry, "lane_pending_work", wraps=registry.lane_pending_work) as pending:
                code, output = self.cli("status")
            self.assertEqual(code, 0, output)
            self.assertIn("ownerless: seo\tseo: queued #8, unacknowledged events 1;", output)
            self.assertEqual(pending.call_count, 1)
        finally:
            begin.set()
            finish.set()
            writer.join(timeout=10)
        self.assertFalse(writer.is_alive(), "append did not finish")
        self.assertEqual(errors, [])

    def test_status_outside_herdr_names_main(self):
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            os.environ.pop(key)
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertEqual(output.splitlines()[1], "this lane: main (outside herdr)")

    def test_status_uses_one_ownership_snapshot_before_loading_registry(self):
        context = self.context()
        load = registry.load
        locked = registry.locked
        snapshot = lanes.read_snapshot
        snapshots = []
        names_read = []

        def read_snapshot(**kwargs):
            snapshots.append(True)
            return snapshot(**kwargs)

        def read_names():
            names_read.append(True)
            return {}

        def read_registry():
            self.assertEqual(snapshots, [True], "status must snapshot before any registry read")
            self.assertEqual(names_read, [True], "status must read names before any registry read")
            return load()

        def registry_lock(*args, **kwargs):
            self.assertEqual(names_read, [True], "status must read names before any registry lock")
            return locked(*args, **kwargs)

        with mock.patch.object(lanes, "resolve_context", return_value=context), \
                mock.patch.object(lanes, "read_snapshot", side_effect=read_snapshot) as read, \
                mock.patch.object(lanes, "claude_session_names", side_effect=read_names) as names, \
                mock.patch.object(registry, "load", side_effect=read_registry), \
                mock.patch.object(registry, "locked", side_effect=registry_lock):
            code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        read.assert_called_once_with(caller_pane_id="w1:t1:p1")
        names.assert_called_once_with()

    def test_status_flags_only_live_lease_mismatches(self):
        context = self.context()
        matching = {"tab_id": context["tab_id"], "controller": context["controller"]}
        cases = ((matching, True, ()),
                 ({**matching, "tab_id": "old-tab"}, True, ("tab_id",)),
                 ({**matching, "controller": {**context["controller"], "kind": "other"}},
                  True, ("controller",)),
                 ({"tab_id": "old-tab", "controller": None}, True, ("tab_id", "controller")),
                 ({}, True, ("tab_id", "controller")),
                 ({"tab_id": "old-tab", "controller": None}, False, ()))
        for lease, live, reasons in cases:
            with self.subTest(lease=lease, live=live):
                registry.update(lambda doc: doc["lanes"]["main"].update(follow_lease=lease))
                with mock.patch.object(watch, "follower_alive", return_value=live):
                    code, output = self.cli("status")
                self.assertEqual(code, 0, output)
                line = next(line for line in output.splitlines() if line.startswith("lane: main\t"))
                self.assertIn("\towner=w1:t1", line)
                self.assertEqual("\tmismatch=" in line, bool(reasons))
                for reason in reasons:
                    self.assertIn(reason, line.split("\tmismatch=", 1)[1])

    def test_status_live_follower_without_a_binding_is_a_mismatch(self):
        self.context()
        registry.create_lane("seo")
        registry.update(lambda doc: doc["lanes"]["seo"].update(follow_lease={"tab_id": "old-tab"}))
        with mock.patch.object(watch, "follower_alive", side_effect=lambda name, lease: name == "seo"):
            code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: seo\tfollow=live\tunhandled=0\towner=none\tmismatch=no tab binding", output)

    def test_status_outside_herdr_follower_needs_no_tab_binding(self):
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            os.environ.pop(key)
        registry.update(lambda doc: doc["lanes"]["main"].update(
            follow_lease={"tab_id": None, "controller": None}))
        with mock.patch.object(watch, "follower_alive", return_value=True):
            code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: main\tfollow=live\tunhandled=0\towner=none", output.splitlines())

    def test_status_lists_only_previously_bound_ownerless_lanes_with_pending_work(self):
        self.context()
        for lane in ("seo", "queued", "events", "empty", "settled", "live"):
            self.seed_binding("old-" + lane, lane, "old " + lane,
                              session="w2:t1-session" if lane == "live" else None)
        for lane in ("seo", "live", "main"):
            self.pending(lane)
        registry.create_lane("never-bound")
        self.pending("never-bound")
        registry.update(lambda doc: (
            doc["tab_bindings"].pop("old-queued:t1"),
            doc["queue"].append({"issue": 8, "state": "queued", "lane": "queued"}),
            doc["workers"].update(settled={"issue": 9, "lane": "settled", "state": "done"})))
        registry.append_event("issue_refused", {}, caller_lane="events")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        ownerless = [line for line in output.splitlines() if line.startswith("ownerless: ")]
        self.assertEqual([line.split("\t", 1)[0] for line in ownerless],
                         ["ownerless: events", "ownerless: queued", "ownerless: seo"])
        for text in ("seo-worker (question)", "queued #8", "unacknowledged events", "lane bind seo"):
            self.assertTrue(any(text in line for line in ownerless), text)
        self.assertIn("lane: seo\tfollow=absent\tunhandled=0\towner=none", output)
        # A controller remains live in another pane even after its bound tab disappears.
        self.assertIn("lane: live\tfollow=absent\tunhandled=0\towner=old-live:t1", output)

    def test_status_unknown_snapshot_reports_uncertainty_without_ownerless_lines(self):
        self.seed_binding("old", "seo", "old label")
        self.pending("seo")
        self.ops.reader_errors[("pane", "list")] = TimeoutError("unreachable")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("this lane: unresolved (Cannot read herdr ownership snapshot", output)
        self.assertIn("ownership: unknown (herdr snapshot unavailable)", output)
        self.assertNotIn("ownerless:", output)

    def test_status_marks_unresolved_lane_with_reason_immediately_after_repo(self):
        self.ops.get_error = TimeoutError("slow herdr")
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertTrue(output.splitlines()[0].startswith("repo: "))
        self.assertEqual(output.splitlines()[1],
                         "this lane: unresolved (Cannot read workspace label for w1: slow herdr)")

    def test_unreadable_snapshot_refuses_without_binding(self):
        for result in (adapters.CommandResult(False, None, "", "", None, "timeout", "slow"),
                       adapters.CommandResult(True, 0, "{}", "", {}),
                       adapters.CommandResult(True, 0, "{}", "", {"result": None}),
                       adapters.CommandResult(True, 0, "{}", "", {"result": {"workspaces": [{}]}})):
            with self.subTest(result=result):
                self.ops.reader_errors[("tab", "list")] = result
                with self.assertRaisesRegex(ValueError, "snapshot"):
                    self.resolve()
                self.assertFalse((self.home / "registry.json").exists())

    def test_existing_binding_still_checks_session_snapshot(self):
        self.seed_binding("w1", "seo", "boon-town seo")
        self.ops.get_error = TimeoutError("workspace fallback is not needed for a bound tab")
        self.assertEqual(self.resolve(), "seo")
        self.assertIn(("pane", "list"), [call[0][:2] for call in self.ops.calls])
        self.assertNotIn(("workspace", "get"), [call[0][:2] for call in self.ops.calls])

    def test_no_herdr_ids_resolves_main_with_snapshot_guard(self):
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            del os.environ[key]
        self.assertEqual(self.resolve(), "main")
        # No tab binding names main, so there is no owner to look up in herdr.
        self.assertEqual([call[0] for call in self.ops.calls], [])
        self.assertFalse((self.home / "registry.json").exists())
        code, output = self.cli("lane", "bind", "seo")
        self.assertEqual(code, 1, output)
        self.assertIn("HERDR_WORKSPACE_ID", output)

    def test_legacy_resolves_main_without_herdr(self):
        with mock.patch.object(herdr_coord, "_coordinator_command", return_value=0) as dispatch:
            code, output = self.cli("relay", "worker", "answer", "--token", "token", "--legacy")
        self.assertEqual(code, 0, output)
        self.assertEqual(dispatch.call_args.args[0].lane, "main")
        self.assertEqual(self.ops.calls, [])
        code, output = self.cli("lane", "bind", "seo", "--legacy")
        self.assertEqual(code, 1, output)
        self.assertIn("main", output)
        self.assertEqual(self.ops.calls, [])

    def test_resolved_lane_is_exposed_to_dispatch(self):
        self.ops.caller("w1", "boon-town seo")
        with mock.patch.object(herdr_coord, "_coordinator_command", return_value=0) as dispatch:
            code, output = self.cli("cleanup")
        self.assertEqual(code, 0, output)
        self.assertEqual(dispatch.call_args.args[0].lane, "seo")

    def test_start_follow_event_and_ack_use_resolved_lane(self):
        self.ops.caller("w1", "boon-town seo")
        with mock.patch.object(herdr_coord, "_ensure_watcher", return_value=None), \
                mock.patch.object(start, "start_issues", return_value=[]) as run:
            self.assertEqual(self.cli("start", "boon-town", "12")[0], 0)
        run.assert_called_once_with("boon-town", [12], lane="seo", tag="1")
        with mock.patch.object(watch, "follow", return_value=0) as follow:
            self.assertEqual(self.cli("follow")[0], 0)
        follow.assert_called_once_with(interval=5, lane="seo", context={
            "lane": "seo", "tab_id": "w1:t1", "pane_id": "w1:t1:p1", "workspace_id": "w1",
            "controller": {"agent": "claude", "kind": "id", "value": "w1:t1-session"},
            "source": "workspace fallback", "tab_label": "1"})
        seq = registry.append_event("issue_refused", {}, caller_lane="seo")
        self.assertEqual(self.cli("event", str(seq))[0], 0)
        self.assertEqual(self.cli("ack", str(seq))[0], 0)
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], 0)
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], seq)

    def test_status_shows_worker_queue_lanes_and_visible_unhandled_counts(self):
        registry.create_lane("seo")
        registry.update(lambda doc: (doc["workers"].update({
            "one": {"issue": 1, "agent_name": "one", "state": "running", "lane": "main"},
            "two": {"issue": 2, "agent_name": "two", "state": "question", "lane": "seo"}}),
            doc["queue"].append({"issue": 3, "state": "queued", "lane": "seo"})))
        registry.append_event("worker_state", {"worker_id": "one"})
        seq = registry.append_event("worker_state", {"worker_id": "two"})
        registry.ack(seq, lane="seo")
        registry.append_event("hold_opened", {})
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        lines = output.splitlines()
        for issue, lane in ((1, "main"), (2, "seo"), (3, "seo")):
            self.assertIn(f"lane={lane}", next(line for line in lines if line.startswith(f"#{issue}\t")))
        self.assertIn("lane: main\tfollow=absent\tunhandled=2\towner=w1:t1", lines)
        self.assertIn("lane: seo\tfollow=absent\tunhandled=1\towner=none", lines)

    def test_status_does_not_claim_an_uninterpreted_lease_is_live(self):
        registry.update(lambda doc: doc["lanes"]["main"].update(follow_lease={"token": "pending-u5"}))
        code, output = self.cli("status")
        self.assertEqual(code, 0, output)
        self.assertIn("lane: main\tfollow=absent\tunhandled=0", output)


if __name__ == "__main__":
    unittest.main()
