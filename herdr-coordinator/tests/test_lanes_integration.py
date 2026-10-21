from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import copy
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid

import registry
import watch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
CLI = SCRIPTS / "herdr_coord.py"
FIXTURES = Path(__file__).with_name("fixtures")
FAKE = '''import copy
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
sys.path.insert(0, sys.argv[2])
import registry

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(data["root"])
kind, *args = sys.argv[3:]
(root / f"call-{uuid.uuid4().hex}.json").write_text(json.dumps([kind, *args]), encoding="utf-8")
barrier = json.loads(os.environ.get("TEST_HERDR_BARRIER", "null"))
if barrier and [kind, *args][:len(barrier["command"])] == barrier["command"]:
    marker = root / (barrier["id"] + "-" + os.environ["HERDR_PANE_ID"].replace(":", "-"))
    if not marker.exists():
        marker.touch()
        deadline = time.monotonic() + 5
        while not all((root / (barrier["id"] + "-" + name.replace(":", "-"))).exists()
                      for name in barrier["participants"]):
            if time.monotonic() >= deadline:
                raise TimeoutError("fake command barrier timed out")
            time.sleep(0.01)

def reply(value):
    print(json.dumps(value))
    sys.exit(0)

def error(code):
    reply({"error": {"code": code, "message": code}})

def label_path(workspace_id):
    return root / f"label-{workspace_id}.json"

def worker_named(name):
    return next(worker for worker in registry.load()["workers"].values() if worker.get("agent_name") == name)

def session_path(worker):
    projects = Path(data["projects"])
    assert projects.is_relative_to(root)
    folder = projects / "fixture"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"session-{worker['issue']}.jsonl"

if kind == "gh" and args[:2] == ["issue", "view"]:
    issue = int(args[2])
    reply({"number": issue, "title": f"Issue {issue}", "labels": [{"name": "ce:work"}], "body": ""})
if kind == "git" and args == ["fetch", "origin"]:
    reply({})
if kind != "herdr":
    raise AssertionError(f"unexpected fake command: {kind} {args}")
if args[:2] in (["tab", "get"], ["pane", "get"], ["tab", "list"], ["pane", "list"]):
    entity, operation = args[:2]
    callers = data.get("coordinators")
    if callers is None:
        callers = [{"workspace_id": workspace_id, "tab_id": workspace_id + ":t1",
                    "pane_id": workspace_id + ":p1", "label": "1", "agent_session": {
                        "agent": "claude", "kind": "id", "value": workspace_id + "-session"}}
                   for workspace_id in data["workspaces"]]
    records = {}
    for caller in callers:
        record = copy.deepcopy(data[entity]["result"][entity])
        record.update(workspace_id=caller["workspace_id"], tab_id=caller["tab_id"])
        if entity == "tab":
            record["label"] = caller["label"]
        else:
            record.update(pane_id=caller["pane_id"], agent_session=caller["agent_session"])
        records[record[entity + "_id"]] = record
    if operation == "list":
        response = copy.deepcopy(data[entity + "s"])
        response["result"][entity + "s"] = list(records.values())
    else:
        response = copy.deepcopy(data[entity])
        response["result"][entity] = records[args[2]]
    reply(response)
if args[:2] == ["workspace", "get"]:
    workspace_id = args[2]
    response = copy.deepcopy(data["workspace"])
    workspace = response["result"]["workspace"]
    path = label_path(workspace_id)
    label = json.loads(path.read_text(encoding="utf-8")) if path.exists() else data["workspaces"].get(workspace_id)
    if label is None:
        worker = next(worker for worker in registry.load()["workers"].values()
                      if worker.get("workspace_id") == workspace_id)
        lane = worker.get("lane", "main")
        label = "boon-town" + (" " + lane if lane != "main" else "") + f" #{worker['issue']}"
    workspace.update(workspace_id=workspace_id, label=label)
    workspace["worktree"].update(repo_root=os.environ["HERDR_COORD_REPO"], checkout_path=os.environ["HERDR_COORD_REPO"])
    reply(response)
if args == ["workspace", "list"]:
    response = copy.deepcopy(data["listing"])
    template = response["result"]["workspaces"][0]
    response["result"]["workspaces"] = [dict(template, workspace_id=key, label=value)
                                          for key, value in data["workspaces"].items()]
    reply(response)
if args[:2] == ["workspace", "rename"]:
    label_path(args[2]).write_text(json.dumps(args[3]), encoding="utf-8")
    reply({"result": {}})
if args[:2] == ["worktree", "create"]:
    doc = registry.load()
    assert sum(worker["state"] in {"starting", "running"} for worker in doc["workers"].values()) <= doc["config"]["cap"]
    path = Path(args[args.index("--path") + 1])
    assert path.is_relative_to(root), path
    path.mkdir()
    worker = next(worker for worker in doc["workers"].values() if worker.get("worktree_path") == str(path))
    workspace_id = f"workspace-{worker['issue']}"
    label_path(workspace_id).write_text(json.dumps(args[args.index("--label") + 1]), encoding="utf-8")
    reply({"result": {"workspace": {"workspace_id": workspace_id, "worktree": {"checkout_path": str(path)}},
                      "root_pane": {"pane_id": f"pane-{worker['issue']}"}}})
if args[:2] in (["workspace", "close"], ["worktree", "remove"], ["agent", "start"]):
    reply({"result": {}})
if args[:2] == ["agent", "get"]:
    worker = worker_named(args[2])
    if worker.get("abandoned") and worker["state"] == "cleaning":
        error("agent_not_found")
    response = copy.deepcopy(data["agent"])
    response["result"]["agent"].update(workspace_id=worker["workspace_id"], pane_id=worker["pane_id"],
                                       agent_session={"value": f"session-{worker['issue']}"})
    reply(response)
if args[:2] == ["agent", "prompt"]:
    worker = worker_named(args[2])
    record = copy.deepcopy(data["command"])
    prompt = args[3]
    if prompt.startswith("/ce-work "):
        command, _, command_args = prompt[1:].partition(" ")
        content = record["message"]["content"]
        content = re.sub(r"<command-name>.*?</command-name>",
                         lambda _: f"<command-name>/compound-engineering:{command}</command-name>", content, flags=re.DOTALL)
        record["message"]["content"] = re.sub(r"<command-args>.*?</command-args>",
                         lambda _: f"<command-args>{command_args}</command-args>", content, flags=re.DOTALL)
    else:
        record["message"]["content"] = prompt
    mode = dict(data["mode"], permissionMode="auto")
    with session_path(worker).open("a", encoding="utf-8") as handle:
        for entry in (mode, record):
            handle.write(json.dumps(entry) + "\\n")
    reply({"result": {}})
raise AssertionError(f"unexpected fake herdr command: {args}")
'''
OLD_UPDATE = '''import json
import os
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
import registry

def update(change):
    with registry.locked(timeout=5):
        path = Path(os.environ["HERDR_COORD_HOME"]) / "registry.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] != 1:
            raise ValueError("Unsupported registry version")
        change(doc)
        path.write_text(json.dumps(doc), encoding="utf-8")

update(lambda doc: doc["config"].update(cap=99))
'''


class LanesIntegrationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "state"
        self.repo = self.root / "boon-town"
        self.repo.mkdir()
        self.profile = self.root / "profile"
        self.profile.mkdir()
        self.fake = self.root / "fake herdr.py"
        self.fake.write_text(FAKE, encoding="utf-8")
        self.responses = self.root / "responses.json"
        records = [json.loads(line) for line in
                   (FIXTURES / "session-probe-full.jsonl").read_text(encoding="utf-8").splitlines()]
        self.data = {
            "root": str(self.root), "projects": str(self.profile / ".claude" / "projects"),
            "workspace": json.loads((FIXTURES / "herdr-workspace-get-main.json").read_text(encoding="utf-8")),
            "listing": json.loads((FIXTURES / "herdr-workspace-list.json").read_text(encoding="utf-8")),
            **{entity: json.loads((FIXTURES / f"herdr-{entity}-get.json").read_text(encoding="utf-8"))
               for entity in ("tab", "pane")},
            **{entity + "s": json.loads((FIXTURES / f"herdr-{entity}-list-global.json").read_text(encoding="utf-8"))
               for entity in ("tab", "pane")},
            "agent": json.loads((FIXTURES / "herdr-agent-get-idle.json").read_text(encoding="utf-8")),
            "workspaces": {"w-main": "boon-town", "w-seo": "boon-town seo"},
            "mode": next(record for record in records if record.get("type") == "permission-mode"),
            "command": next(record for record in records if record.get("type") == "user"
                            and isinstance(record.get("message", {}).get("content"), str)
                            and "<command-name>" in record["message"]["content"]),
        }
        self.responses.write_text(json.dumps(self.data), encoding="utf-8")
        prefix = [sys.executable, str(self.fake), str(self.responses), str(SCRIPTS)]
        self.env = os.environ.copy()
        self.env.update({
            "HERDR_COORD_HOME": str(self.home), "HERDR_COORD_REPO": str(self.repo),
            "USERPROFILE": str(self.profile), "PYTHONUNBUFFERED": "1",
            **{f"HERDR_COORD_{name.upper()}": json.dumps(prefix + [name]) for name in ("herdr", "git", "gh")},
        })
        for key in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
            self.env.pop(key, None)
        environment = mock.patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        # Supply watcher health without launching a detached watcher or polling workers.
        self.watcher = watch.watcher_lock()
        self.watcher.__enter__()
        self.addCleanup(self.watcher.__exit__, None, None, None)
        watch.heartbeat(now=time.time(), poll=15)

    def coordinator(self, tab_id, label, *, pane_id=None, session=None):
        workspace_id = tab_id.split(":")[0]
        pane_id = pane_id or tab_id + ":p1"
        caller = {"workspace_id": workspace_id, "tab_id": tab_id, "pane_id": pane_id,
                  "label": label, "agent_session": {"agent": "claude", "kind": "id",
                                                       "value": session or pane_id + "-session"}}
        if "coordinators" not in self.data:
            self.data.update(coordinators=[], workspaces={})
        self.data["coordinators"].append(caller)
        self.data["workspaces"][workspace_id] = "boon-town"
        self.responses.write_text(json.dumps(self.data), encoding="utf-8")
        return caller

    def spawn(self, argv, *, lane=None, caller=None, barrier=None, timeout=25):
        env = self.env.copy()
        if lane is not None:
            env["HERDR_WORKSPACE_ID"] = f"w-{lane}"
            env["HERDR_TAB_ID"] = f"w-{lane}:t1"
            env["HERDR_PANE_ID"] = f"w-{lane}:p1"
        if caller is not None:
            env.update({f"HERDR_{entity.upper()}_ID": caller[entity + "_id"]
                        for entity in ("workspace", "tab", "pane")})
        if barrier is not None:
            env["TEST_HERDR_BARRIER"] = json.dumps(barrier)
        output = self.root / f"output-{uuid.uuid4().hex}.txt"
        handle = output.open("wb")
        try:
            process = subprocess.Popen(argv, cwd=self.repo, env=env, stdout=handle, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        finally:
            handle.close()
        # Even a failed assertion must not leave a follow running or filling a pipe/file.
        timer = threading.Timer(timeout, process.kill)
        timer.daemon = True
        timer.start()
        self.addCleanup(self.stop, (process, output, timer))
        return process, output, timer

    def stop(self, child):
        process, _, timer = child
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)

    def finish(self, child, code=0):
        process, output, _ = child
        try:
            process.wait(timeout=20)
        finally:
            self.stop(child)
        text = output.read_text(encoding="utf-8")
        self.assertEqual(process.returncode, code, text)
        return text

    def cli(self, *args, lane=None, caller=None, code=0):
        return self.finish(self.spawn([sys.executable, str(CLI), *map(str, args)], lane=lane, caller=caller), code)

    def pair(self, calls, *, command=("herdr", "pane", "list")):
        barrier = {"id": uuid.uuid4().hex, "command": command, "participants": ["w-main:p1", "w-seo:p1"]}
        children = [self.spawn([sys.executable, str(CLI), *map(str, args)], lane=lane, barrier=barrier)
                    for lane, args in calls]
        return [self.finish(child) for child in children]

    def bind_lanes(self):
        for lane in ("main", "seo"):
            self.assertEqual(json.loads(self.cli("config", "show", lane=lane)), {})
        self.assertEqual({key: value["lane"] for key, value in registry.load()["tab_bindings"].items()},
                         {"w-main:t1": "main", "w-seo:t1": "seo"})

    def worker(self, issue, lane="main", state="running", **fields):
        name = f"worker-{issue}"
        worker = {
            "worker_id": name, "agent_name": name, "issue": issue, "lane": lane, "state": state,
            "state_token": f"token-{issue}", "session_id": f"session-{issue}",
            "workspace_id": f"workspace-{issue}", "pane_id": f"pane-{issue}",
            "repo_path": str(self.repo), "worktree_path": str(self.root / f"tree-{issue}"),
            "branch": f"issue/{issue}", "entry_command": "ce-work", "entry_args": f"#{issue}",
            "phase": "mode_checked", "transcript_offset": 0, **fields,
        }
        registry.update(lambda doc: doc["workers"].update({name: worker}))
        return worker

    def wait_for(self, condition, detail):
        deadline = time.monotonic() + 10
        while not condition():
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for {detail}")
            time.sleep(0.01)

    def events(self, child):
        process, output, _ = child
        self.assertIsNone(process.poll(), output.read_text(encoding="utf-8"))
        self.assertLess(output.stat().st_size, 1024 * 1024, "follow output exceeded 1 MiB")
        lines = output.read_text(encoding="utf-8").splitlines()
        # A live writer may not yet have finished its last JSON line.
        if lines and not lines[-1].endswith("}"):
            lines.pop()
        return [json.loads(line) for line in lines]

    def test_two_tabs_in_one_workspace_have_separate_lanes_follows_and_labels(self):
        callers = {"main": self.coordinator("w1:tA", "1", session="main-session"),
                   "seo": self.coordinator("w1:tB", "SEO", session="seo-session")}
        for lane, caller in callers.items():
            status = self.cli("status", caller=caller)
            source = "workspace fallback" if lane == "main" else "tab label"
            self.assertIn(f"this lane: {lane} (tab {caller['tab_id']}, "
                          f"session {caller['agent_session']['value'][:8]}, source {source})", status)
        self.cli("config", "set", "cap", "2", caller=callers["main"])
        for issue, (lane, caller) in enumerate(callers.items(), 201):
            result = json.loads(self.cli("start", self.repo, issue, caller=caller))
            self.assertEqual(result["state"], "running", result)
            label = ("boon-town" if lane == "main" else lane) + f" #{issue} Issue {issue}"
            self.assertEqual(json.loads((self.root / f"label-workspace-{issue}.json").read_text(encoding="utf-8")),
                             label)
        workers = {worker["lane"]: worker for worker in registry.load()["workers"].values()}
        self.assertEqual({lane: worker["issue"] for lane, worker in workers.items()}, {"main": 201, "seo": 202})
        followers = {lane: self.spawn([sys.executable, str(CLI), "follow", "--interval", "0.01"],
                                      caller=caller, timeout=60) for lane, caller in callers.items()}
        self.wait_for(lambda: all(watch.follower_alive(lane, registry.load()["lanes"][lane]["follow_lease"])
                                 for lane in callers), "both tab follow leases")
        for lane, caller in callers.items():
            lease = registry.load()["lanes"][lane]["follow_lease"]
            self.assertEqual(lease["pid"], followers[lane][0].pid)
            self.assertEqual(lease["tab_id"], caller["tab_id"])
            self.assertEqual(lease["controller"], caller["agent_session"])
            beat = json.loads((self.home / f"follow-{lane}.json").read_text(encoding="utf-8"))
            self.assertEqual({key: beat[key] for key in lease}, lease)
        seqs = {lane: registry.append_event("worker_state", {"worker_id": worker["worker_id"], "state": "question"})
                for lane, worker in workers.items()}
        shared = registry.append_event("hold_opened", {"reason": "both private events written"})
        self.wait_for(lambda: all(any(event["seq"] == shared for event in self.events(child))
                                 for child in followers.values()), "both followers past the private events")
        for lane, child in followers.items():
            other = "seo" if lane == "main" else "main"
            delivered = [event["seq"] for event in self.events(child)]
            self.assertIn(seqs[lane], delivered)
            self.assertNotIn(seqs[other], delivered)

    def test_second_process_in_same_tab_refuses_another_session(self):
        owner = self.coordinator("w1:tA", "SEO", pane_id="w1:pA", session="owner-session")
        other = self.coordinator("w1:tA", "SEO", pane_id="w1:pB", session="other-session")
        self.assertIn("this lane: seo", self.cli("status", caller=owner))
        before = registry.load()
        for args in (("start", self.repo, "203"), ("lane", "bind", "perf")):
            refused = json.loads(self.cli(*args, caller=other, code=1))
            self.assertEqual(refused["state"], "refused")
            for text in ("owned by tab w1:tA", "session owner-se", "rename this tab",
                         "lane bind <another lane>", "close tab w1:tA"):
                self.assertIn(text, refused["detail"])
            self.assertEqual(registry.load(), before)

    def test_concurrent_first_claims_from_two_tabs_have_one_main_owner(self):
        callers = [self.coordinator("w1:tA", "1", session="first-session"),
                   self.coordinator("w1:tB", "2", session="second-session")]
        seq = registry.append_event("hold_opened", {"reason": "concurrent claim"})
        barrier = {"id": uuid.uuid4().hex, "command": ["herdr", "pane", "list"],
                   "participants": [caller["pane_id"] for caller in callers]}
        children = [self.spawn([sys.executable, str(CLI), "ack", str(seq)], caller=caller, barrier=barrier)
                    for caller in callers]
        for child in children:
            try:
                child[0].wait(timeout=20)
            finally:
                self.stop(child)
        self.assertEqual(sorted(child[0].returncode for child in children), [0, 1],
                         [child[1].read_text(encoding="utf-8") for child in children])
        winner = next(index for index, child in enumerate(children) if child[0].returncode == 0)
        loser = 1 - winner
        self.assertEqual(json.loads(children[winner][1].read_text(encoding="utf-8"))["ack_seq"], seq)
        refused = json.loads(children[loser][1].read_text(encoding="utf-8"))
        self.assertEqual(refused["state"], "refused")
        owner = callers[winner]
        for text in (f"Lane main is owned by tab {owner['tab_id']}",
                     f"session {owner['agent_session']['value'][:8]}", "rename this tab",
                     "lane bind <another lane>", f"close tab {owner['tab_id']}"):
            self.assertIn(text, refused["detail"])
        bindings = registry.load()["tab_bindings"]
        self.assertEqual(list(bindings), [owner["tab_id"]])
        self.assertEqual(bindings[owner["tab_id"]]["lane"], "main")
        self.assertEqual(bindings[owner["tab_id"]]["controller"], owner["agent_session"])

    def test_rebind_refuses_live_follow_then_new_lane_follow_starts(self):
        caller = self.coordinator("w1:tA", "SEO", session="follow-session")
        self.assertIn("this lane: seo", self.cli("status", caller=caller))
        follower = self.spawn([sys.executable, str(CLI), "follow", "--interval", "0.01"],
                              caller=caller, timeout=60)
        self.wait_for(lambda: watch.follower_alive("seo", registry.load()["lanes"]["seo"]["follow_lease"]),
                      "seo follow lease")
        before = registry.load()
        refused = json.loads(self.cli("lane", "bind", "perf", caller=caller, code=1))
        self.assertEqual(refused["state"], "refused")
        self.assertIn("follow", refused["detail"])
        self.assertEqual(registry.load(), before)
        self.assertIsNone(follower[0].poll())
        self.stop(follower)
        rebound = json.loads(self.cli("lane", "bind", "perf", caller=caller))
        self.assertEqual(rebound["lane"], "perf")
        self.assertEqual(rebound["tab_id"], caller["tab_id"])
        self.assertEqual(rebound["source"], "explicit")
        self.assertEqual(registry.load()["tab_bindings"][caller["tab_id"]]["lane"], "perf")
        successor = self.spawn([sys.executable, str(CLI), "follow", "--interval", "0.01"],
                               caller=caller, timeout=60)
        self.wait_for(lambda: watch.follower_alive("perf", registry.load()["lanes"]["perf"]["follow_lease"]),
                      "perf follow lease")
        lease = registry.load()["lanes"]["perf"]["follow_lease"]
        self.assertEqual(lease["pid"], successor[0].pid)
        self.assertEqual(lease["tab_id"], caller["tab_id"])
        self.assertEqual(lease["controller"], caller["agent_session"])
        self.assertFalse(watch.follower_alive("seo", registry.load()["lanes"]["seo"]["follow_lease"]))
        seq = registry.append_event("issue_refused", {"reason": "new lane"}, caller_lane="perf")
        self.wait_for(lambda: any(event["seq"] == seq for event in self.events(successor)), "perf event delivery")

    def test_v2_upgrade_numeric_tab_claims_main_and_reads_pending_events(self):
        numeric = self.coordinator("w1:tA", "1", session="numeric-session")
        named = self.coordinator("w1:tB", "conveo", session="named-session")
        worker = self.worker(301, state="question", question_text="Which policy?")
        seqs = [registry.append_event("worker_state", {"worker_id": worker["worker_id"], "index": index})
                for index in range(3)]
        old = registry.load()
        old.update(version=2, workspace_bindings={"w1": {"lane": "main", "label_seen": "boon-town"}})
        old.pop("tab_bindings")
        old["lanes"]["main"]["bound_before"] = True
        registry.save(old)
        before = (self.home / "events.jsonl").read_bytes()
        expected_events = registry.read_events(old["lanes"]["main"]["ack_seq"], lane="main")
        refused = json.loads(self.cli("event", seqs[0], caller=named, code=1))
        self.assertIn("main", refused["detail"])
        self.assertIn("lane bind main", refused["detail"])
        raw = json.loads((self.home / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual(raw, old)
        status = self.cli("status", caller=numeric)
        self.assertIn("this lane: main (tab w1:tA, session numeric-, source workspace fallback)", status)
        self.assertIn("lane: main\tfollow=absent\tunhandled=3\towner=w1:tA", status)
        doc = json.loads((self.home / "registry.json").read_text(encoding="utf-8"))
        expected = copy.deepcopy(old)
        expected.update(version=3, tab_bindings=doc["tab_bindings"])
        expected.pop("workspace_bindings")
        self.assertEqual(doc, expected)
        self.assertEqual(list(doc["tab_bindings"]), [numeric["tab_id"]])
        self.assertEqual(doc["tab_bindings"][numeric["tab_id"]]["controller"], numeric["agent_session"])
        self.assertEqual([json.loads(self.cli("event", seq, caller=numeric)) for seq in seqs], expected_events)
        self.assertIn("this lane: conveo", self.cli("status", caller=named))
        self.assertEqual(registry.load()["lanes"]["conveo"]["ack_seq"], seqs[-1])
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], old["lanes"]["main"]["ack_seq"])
        self.assertEqual((self.home / "events.jsonl").read_bytes(), before)

    def test_two_followers_receive_50_interleaved_events_with_concurrent_acks(self):
        self.bind_lanes()
        workers = {lane: self.worker(index, lane) for index, lane in enumerate(("main", "seo"), 1)}
        followers = {lane: self.spawn([sys.executable, str(CLI), "follow", "--interval", "0.01"], lane=lane, timeout=120)
                     for lane in workers}
        self.wait_for(lambda: all(watch.follower_alive(lane, registry.load()["lanes"][lane]["follow_lease"])
                                 for lane in workers), "both follow leases")
        refused = json.loads(self.cli("follow", "--interval", "0.01", lane="main", code=1))
        self.assertIn(str(followers["main"][0].pid), refused["detail"])
        expected = {lane: [] for lane in workers}
        for batch in range(5):
            for index in range(10):
                lane = "main" if index % 2 == 0 else "seo"
                expected[lane].append(registry.append_event("worker_state", {
                    "worker_id": workers[lane]["worker_id"], "state": "question", "index": batch * 10 + index}))
            self.wait_for(lambda: all([event["seq"] for event in self.events(followers[lane])] == expected[lane]
                                     for lane in workers), f"batch {batch} delivery")
            results = self.pair([(lane, ["ack", expected[lane][-1]]) for lane in workers])
            self.assertEqual([json.loads(result)["ack_seq"] for result in results],
                             [expected[lane][-1] for lane in workers])
            self.assertEqual({lane: state["ack_seq"] for lane, state in registry.load()["lanes"].items()},
                             {lane: expected[lane][-1] for lane in workers})
        for lane in workers:
            self.assertEqual([event["seq"] for event in self.events(followers[lane])], expected[lane])
            self.assertEqual(registry.read_events(expected[lane][-1], lane=lane), [])
        private = expected["seo"][-1]
        for command in ("event", "ack"):
            self.assertEqual(json.loads(self.cli(command, private, lane="main", code=1))["state"], "refused")
        self.assertEqual(json.loads(self.cli("event", private, lane="seo"))["seq"], private)
        shared = registry.append_event("hold_opened", {"reason": "integration"})
        self.wait_for(lambda: all(self.events(child)[-1]["seq"] == shared for child in followers.values()),
                      "repository event in both followers")
        self.cli("ack", shared, lane="seo")
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], expected["main"][-1])
        self.assertEqual([event["seq"] for event in registry.read_events(expected["main"][-1], lane="main")], [shared])

    def test_concurrent_starts_share_cap_and_preserve_queue_ownership(self):
        self.bind_lanes()
        self.cli("config", "set", "cap", "1", lane="main")
        results = self.pair([("main", ["start", self.repo, "101", "103"]),
                             ("seo", ["start", self.repo, "102", "104"])], command=("gh", "issue", "view"))
        summaries = [json.loads(line) for result in results for line in result.splitlines()]
        self.assertEqual(sorted(item["state"] for item in summaries), ["queued"] * 3 + ["running"], summaries)
        doc = registry.load()
        self.assertEqual(len(doc["workers"]), 1)
        self.assertEqual(len(doc["queue"]), 3)
        entries = [*doc["workers"].values(), *doc["queue"]]
        self.assertEqual({worker["issue"]: worker["lane"] for worker in entries},
                         {101: "main", 103: "main", 102: "seo", 104: "seo"})
        worker = next(iter(doc["workers"].values()))
        other = "seo" if worker["lane"] == "main" else "main"
        refusal = json.loads(self.cli("start", self.repo, worker["issue"], lane=other))
        self.assertEqual(refusal["state"], "refused")
        self.assertIn(worker["lane"], refusal["reason"])
        self.assertEqual(len(registry.load()["workers"]), 1)
        calls = [json.loads(path.read_text(encoding="utf-8")) for path in self.root.glob("call-*.json")]
        self.assertEqual(sum(call[:3] == ["herdr", "worktree", "create"] for call in calls), 1)

    def test_relays_handoff_and_bare_cleanup_follow_lane_ownership(self):
        self.bind_lanes()
        workers = [self.worker(11, "main", "ended_without_proof", final_message="Please choose A"),
                   self.worker(12, "seo", "ended_without_proof", final_message="Please choose B")]
        for worker in workers:
            folder = Path(self.data["projects"]) / "fixture"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{worker['session_id']}.jsonl").write_text("", encoding="utf-8")
        results = self.pair([(worker["lane"], ["relay", worker["agent_name"], f"answer {worker['issue']}",
                                               "--token", worker["state_token"]]) for worker in workers])
        self.assertEqual([json.loads(result)["status"] for result in results], ["delivered", "delivered"])
        def settle(doc):
            worker = doc["workers"]["worker-11"]
            worker.update(state="ended_without_proof", state_token="handoff-token", final_message="Which next step?")
            for field in ("relay_request", "pending_action_id"):
                worker.pop(field, None)

        registry.update(settle)
        before = registry.append_event("worker_state", dict(registry.load()["workers"]["worker-11"]))
        self.assertEqual(json.loads(self.cli("handoff", "worker-11", "seo", lane="main"))["to_lane"], "seo")
        after = registry.append_event("worker_state", dict(registry.load()["workers"]["worker-11"]))
        events = registry.read_events(0, lane=None)
        handoff = next(event for event in events if event["kind"] == "worker_handoff")
        self.assertEqual(handoff["lanes"], ["main", "seo"])
        self.assertEqual(handoff["payload"]["final_message"], "Which next step?")
        self.assertEqual(handoff["payload"]["state_token"], "handoff-token")
        self.assertEqual(next(event for event in events if event["seq"] == before)["lanes"], ["main"])
        self.assertEqual(next(event for event in events if event["seq"] == after)["lanes"], ["seo"])
        self.assertEqual(json.loads((self.root / "label-workspace-11.json").read_text(encoding="utf-8")), "seo #11")
        refused = json.loads(self.cli("relay", "worker-11", "old owner", "--token", "handoff-token", lane="main", code=1))
        self.assertIn("lane seo", refused["detail"])
        reply = json.loads(self.cli("relay", "worker-11", "new owner", "--token", "handoff-token", lane="seo"))
        self.assertEqual(reply["status"], "delivered")
        self.worker(13, "main", "done", abandoned=True)
        def finished(doc):
            for worker in doc["workers"].values():
                worker.update(state="done", abandoned=True)

        registry.update(finished)
        cleaned = json.loads(self.cli("cleanup", lane="main"))
        self.assertEqual([(item["issue"], item["cleaned"]) for item in cleaned["results"]], [(13, True)])
        self.assertEqual({key: worker["state"] for key, worker in registry.load()["workers"].items()},
                         {"worker-11": "done", "worker-12": "done", "worker-13": "cleaned"})
        cleaned = json.loads(self.cli("cleanup", lane="seo"))
        self.assertEqual({item["issue"] for item in cleaned["results"] if item["cleaned"]}, {11, 12})

    def legacy_state(self):
        # Synthetic pre-lanes boon-town shape; no live coordinator state is read.
        workers = [self.worker(2458, state="question", question_text="Pick a policy"),
                   self.worker(2394, state="done", final_message="Work complete")]
        doc = registry.load()
        doc.update(version=1, event_seq=48, ack_seq=43, notification_seq=44,
                   holds={"watcher_lost": {"ts": 100}}, config={"cap": 3},
                   actions={"relay-2458": {"worker_id": "worker-2458", "kind": "relay", "status": "delivered"}},
                   queue=[{"issue": 2460, "repo_path": str(self.repo), "state": "queued", "entry_command": "ce-work"}])
        doc.pop("lanes")
        doc.pop("tab_bindings")
        for worker in doc["workers"].values():
            worker.pop("lane")
        registry.save(doc)
        workers = list(doc["workers"].values())
        events = [{"seq": seq, "kind": kind, "payload": payload} for seq, kind, payload in (
            (41, "worker_state", workers[0]), (42, "watcher_lost", {}), (43, "worker_state", workers[1]),
            (44, "worker_state", workers[0]), (45, "herdr_lost", {}), (46, "hold_opened", {}),
            (47, "worker_state", workers[1]), (48, "technical_problem", {"worker_id": "worker-2458"}))]
        path = self.home / "events.jsonl"
        path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        return copy.deepcopy(doc), events

    def test_v1_migration_preserves_unhandled_sets_and_main_needs_no_setup(self):
        old, events = self.legacy_state()
        before = (self.home / "events.jsonl").read_bytes()
        expected = [event for event in events if event["seq"] > old["ack_seq"]]
        status = self.cli("status")
        self.assertIn(f"lane: main\tfollow=absent\tunhandled={len(expected)}", status)
        self.assertEqual(json.loads((self.home / "registry.json").read_text(encoding="utf-8"))["version"], 1)
        # A normal mutating CLI command persists the upgrade, with the old cursor intact.
        self.cli("config", "set", "cap", "3")
        doc = registry.load()
        self.assertEqual(json.loads((self.home / "registry.json").read_text(encoding="utf-8"))["version"], 3)
        self.assertEqual(doc["lanes"]["main"]["ack_seq"], old["ack_seq"])
        self.assertEqual(doc["notification_seq"], old["notification_seq"])
        self.assertEqual(doc["holds"], old["holds"])
        self.assertEqual(doc["actions"], old["actions"])
        self.assertTrue(all(worker["lane"] == "main" for worker in [*doc["workers"].values(), *doc["queue"]]))
        self.assertEqual(registry.read_events(doc["lanes"]["main"]["ack_seq"], lane="main"), expected)
        self.assertEqual((self.home / "events.jsonl").read_bytes(), before)
        self.cli("config", "show", lane="seo")
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], 48)
        self.assertEqual(registry.read_events(48, lane="seo"), [])
        self.assertEqual([event["seq"] for event in registry.read_events(0, lane="seo")], [42, 45, 46])
        self.cli("ack", expected[0]["seq"])
        self.assertEqual(registry.load()["lanes"]["main"]["ack_seq"], expected[0]["seq"])
        self.assertEqual(registry.load()["lanes"]["seo"]["ack_seq"], 48)

    def test_v1_only_update_refuses_migrated_registry_without_changing_bytes(self):
        self.legacy_state()
        self.cli("config", "set", "cap", "3")
        before = {name: (self.home / name).read_bytes() for name in ("registry.json", "events.jsonl")}
        old = self.root / "v1 only update.py"
        old.write_text(OLD_UPDATE, encoding="utf-8")
        output = self.finish(self.spawn([sys.executable, str(old), str(SCRIPTS)]), code=1)
        self.assertIn("Unsupported registry version", output)
        self.assertEqual({name: (self.home / name).read_bytes() for name in before}, before)


if __name__ == "__main__":
    unittest.main()
