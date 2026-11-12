"""Start issue workers with durable phases and transcript-confirmed delivery."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import re
import time
import uuid
from pathlib import Path

import adapters
import lanes
import registry
import repo_root
import transcript


PROJECTS_ROOT = Path.home() / ".claude" / "projects"
WORKTREE_TIMEOUT = 30.0
AGENT_START_TIMEOUT = 30.0
SESSION_TIMEOUT = 30.0
DELIVERY_TIMEOUT = 60.0
MODE_TIMEOUT = 5.0
POLL_INTERVAL = 0.25
COMMAND_TIMEOUT = 60.0
AGENT_TIMEOUT_MS = 60_000
DEFAULT_PERMISSION_MODE = "auto"
AGENT_MODEL = "claude-opus-5-5"
SLOT_STATES = frozenset({
    "starting", "running", "in_tool", "question", "quota_wait", "stalled",
    "awaiting_checks", "waiting_background",
})
PHASES = ("worktree", "agent_started", "command_sent", "delivered", "mode_checked")


class StartError(Exception):
    """An operational failure that should be recorded for this issue."""


def _process_identity(pid) -> dict | None:
    """Identify a live Windows process without sending a console control event."""
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        if ctypes.get_last_error() == 87:  # ERROR_INVALID_PARAMETER: no such pid
            return None
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        code = wintypes.DWORD()
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        if code.value != 259:
            return None  # STILL_ACTIVE
        return {"pid": pid, "created": (created.dwHighDateTime << 32) | created.dwLowDateTime}
    finally:
        kernel.CloseHandle(handle)


def _start_owner() -> dict:
    try:
        owner = _process_identity(os.getpid())
    except OSError as exc:
        raise StartError(f"cannot identify the start owner process: {exc}") from exc
    if owner is None:
        raise StartError("cannot identify the start owner process")
    return owner


def _owns_start(worker) -> bool:
    return worker.get("start_owner") == _start_owner()


def _can_start(worker) -> bool:
    return (not worker.get("adhoc") and worker.get("issue") is not None
            and worker.get("state") == "starting" and _owns_start(worker))


def parse_entry_command(labels: list[str], body: str) -> tuple[str, str] | None:
    """Parse the sole supported entry format; empty args use the issue number.

    The caller supplies that default because this parser has no issue-number
    parameter. Explicit body arguments are preserved, including '/' and '#'.
    """
    commands = {
        "ce:work": "ce-work", "ce:debug": "ce-debug", "ce:lfg": "lfg",
        "ce:brainstorm": "ce-brainstorm", "ce:strategy": "ce-strategy", "ce:plan": "ce-plan",
    }
    match = re.search(
        r"^[ \t]*CE entry:[ \t]*/(ce-work|ce-debug|lfg|ce-brainstorm|ce-strategy|ce-plan)"
        r"(?:[ \t]+([^\r\n]*))?[ \t]*\r?$", body, re.MULTILINE,
    )
    if match:
        return match.group(1), (match.group(2) or "").strip()
    for label in labels:
        if label in commands:
            return commands[label], ""
    return None


def _run(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except (OSError, TimeoutError) as exc:
        raise StartError(str(exc)) from exc


def _failure(result):
    reason = result.error_message or result.stderr or "command failed"
    return f"{result.error_code or 'command_failed'}: {reason}"


def _call(operation, *args, **kwargs):
    result = _run(operation, *args, **kwargs)
    if not result.ok:
        raise StartError(_failure(result))
    return result


def _envelope(result) -> dict:
    data = result.data
    envelope = data.get("result") if isinstance(data, dict) else None
    if not isinstance(envelope, dict):
        raise StartError("herdr returned no result object")
    return envelope


def _record(worker_id, kind, *, action_changes=None, **changes) -> dict:
    recorded = False

    def change(doc):
        nonlocal recorded
        worker = doc["workers"][worker_id]
        # Only the owner may advance a start that is still in progress.
        if not _can_start(worker):
            return
        worker.update(changes)
        if changes.get("state") == "running":
            worker.pop("reason", None)
        if action_changes:
            doc["actions"][worker["action_id"]].update(action_changes)
        recorded = True

    doc = registry.update(change)
    if recorded:
        registry.append_event(kind, {"worker_id": worker_id, **changes})
    return doc["workers"][worker_id]


def _slots(doc) -> int:
    # A worker claimed by cleanup keeps the slot it held until cleanup succeeds.
    return sum(worker.get("state") in SLOT_STATES
               or (worker.get("state") == "storage_pending" and bool(worker.get("agent_name")))
               or (worker.get("state") == "cleaning"
                   and (worker.get("cleanup_from") or {}).get("state") in SLOT_STATES)
               for worker in doc["workers"].values() if not worker.get("adhoc"))


def _has_slot(doc) -> bool:
    return _slots(doc) < doc["config"].get("cap", 3)


def _claim(doc, worker, owner):
    worker["state"] = "starting"
    worker["start_owner"] = owner
    worker["permission_mode"] = doc["config"].get("permission_mode", DEFAULT_PERMISSION_MODE)
    doc["workers"][worker["worker_id"]] = worker


def _admit(candidate) -> tuple[dict, bool]:
    """Reserve a slot or enqueue under one update, without calling external tools."""
    if candidate.get("adhoc") or candidate.get("issue") is None:
        raise StartError("start requires an issue worker; use adopt for an existing session")
    worker_id = candidate["worker_id"]
    owner = _start_owner()
    outcome = {}

    def admit(doc, events):
        existing = doc["workers"].get(worker_id)
        queued = next((item for item in doc["queue"] if item["worker_id"] == worker_id), None)
        owned = existing if existing and existing.get("state") != "cleaned" else queued
        if owned and owned.get("lane", "main") != candidate.get("lane", "main"):
            raise StartError(f"issue #{candidate['issue']} is already owned by lane {owned.get('lane', 'main')}")
        if existing and existing.get("state") != "cleaned":
            outcome.update(worker=existing, run=False)
            return
        if existing:
            # A new candidate inherits none of the cleaned run's receipts or phases.
            doc["workers"].pop(worker_id)
        worker = dict(queued or candidate)
        if doc["holds"] or not _has_slot(doc):
            worker["state"] = "queued"
            if queued is None:
                doc["queue"].append(worker)
                events.append(("issue_queued", worker))
            outcome.update(worker=worker, run=False)
        else:
            if queued is not None:
                doc["queue"].remove(queued)
            _claim(doc, worker, owner)
            outcome.update(worker=worker, run=True)
            events.append(("worker_starting", worker))

    registry.update_with_events(admit, caller_lane=candidate.get("lane", "main"))
    return outcome["worker"], outcome["run"]


def _wait_for_path(path):
    deadline = time.monotonic() + WORKTREE_TIMEOUT
    while not Path(path).is_dir():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StartError(f"worktree path did not appear: {path}")
        time.sleep(min(POLL_INTERVAL, remaining))


def _create_worktree(worker, ops):
    worker_id = worker["worker_id"]
    lane = worker.get("lane", "main")
    label = lanes.workspace_label(worker["repo_path"], lane, worker["issue"],
                                  worker.get("title", ""), tag=worker.get("label_tag"))
    if not worker.get("worktree_created"):
        _call(ops.git, "worktree", "add", "-b", worker["branch"], worker["worktree_path"],
              cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT)
        def remember_creation(doc):
            current = doc["workers"][worker_id]
            if not _can_start(current):
                raise StartError("worker changed during worktree creation")
            current["worktree_created"] = True

        worker = registry.update(remember_creation)["workers"][worker_id]
    _wait_for_path(worker["worktree_path"])
    result = _call(
        ops.herdr, "worktree", "open", "--cwd", worker["repo_path"], "--path", worker["worktree_path"],
        "--label", label, "--no-focus", timeout=COMMAND_TIMEOUT,
    )
    envelope = _envelope(result)
    workspace, pane, tab = envelope.get("workspace", {}), envelope.get("root_pane", {}), envelope.get("tab", {})
    checkout = workspace.get("worktree", {}).get("checkout_path")
    if not checkout or os.path.normcase(os.path.realpath(checkout)) != os.path.normcase(os.path.realpath(worker["worktree_path"])):
        raise StartError("herdr did not open the requested worktree path")
    if not workspace.get("workspace_id") or not pane.get("pane_id") or not tab.get("tab_id"):
        raise StartError("herdr returned no workspace, tab or root pane identity")
    return _record(
        worker_id, "worker_phase", phase="worktree", worktree_created=True,
        workspace_id=workspace["workspace_id"], pane_id=pane["pane_id"], tab_id=tab["tab_id"],
    )


def _start_agent(worker, ops):
    _wait_for_path(worker["worktree_path"])
    if not worker.get("workspace_id") or not worker.get("pane_id"):
        raise StartError("worktree creation returned no workspace or pane id")
    if worker.get("agent_name"):
        result = _call(ops.herdr, "agent", "get", worker["agent_name"], timeout=COMMAND_TIMEOUT)
        agent = _envelope(result).get("agent", {})
        if (agent.get("name") != worker["agent_name"] or agent.get("pane_id") != worker["pane_id"]
                or agent.get("workspace_id") != worker["workspace_id"]
                or not isinstance(agent.get("cwd"), str) or not agent["cwd"]
                or not Path(os.path.normcase(os.path.realpath(agent["cwd"]))).is_relative_to(
                    os.path.normcase(os.path.realpath(worker["worktree_path"])))):
            raise StartError("recorded worker identity could not be confirmed")
        return _record(worker["worker_id"], "worker_phase", phase="agent_started")
    prefix = repo_root.slug(worker["repo_path"])
    if not prefix or not ("a" <= prefix[0] <= "z"):
        prefix = "r" + prefix
    suffix = f"-{worker['issue']}-{uuid.uuid4().hex[:6]}"
    if len(suffix) >= 32:
        raise StartError("issue number is too long for a herdr agent name")
    name = prefix[:32 - len(suffix)].rstrip("-") + suffix
    worker = _record(worker["worker_id"], "worker_launch_intent", agent_name=name)
    deadline = time.monotonic() + AGENT_START_TIMEOUT
    error = None
    while True:
        worker = registry.load()["workers"][worker["worker_id"]]
        if not _can_start(worker) or worker.get("phase") != "worktree":
            return worker
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise error or StartError("agent start deadline expired")
        result = _run(
            ops.herdr, "agent", "start", name, "--kind", "claude", "--pane", worker["pane_id"],
            "--timeout", str(AGENT_TIMEOUT_MS), "--", "--model", AGENT_MODEL,
            "--permission-mode", worker["permission_mode"],
            "--append-system-prompt", lanes.worker_note(
                worker.get("lane", "main"), worker.get("label_tag"), worker.get("coordinator_contact")),
            timeout=min(COMMAND_TIMEOUT, remaining),
        )
        if result.ok:
            break
        error = StartError(_failure(result))
        remaining = deadline - time.monotonic()
        if result.error_code != "agent_pane_busy":
            raise error
        if remaining > 0:
            time.sleep(min(POLL_INTERVAL, remaining))
    worker = _record(worker["worker_id"], "worker_phase", phase="agent_started", agent_name=name)
    return worker


def _send_entry(worker, ops):
    if not _can_start(worker) or worker.get("action_id"):
        return worker  # A persisted send intent is reconciled, never resent.
    action_id = uuid.uuid4().hex
    command_args = worker["entry_args"]
    if len(command_args) > 200 or "\n" in command_args or "\r" in command_args:
        command_args = f"#{worker['issue']}"
    action = {
        "id": action_id, "worker_id": worker["worker_id"], "kind": "entry",
        "transcript_position": 0, "status": "delivery_unknown",
        "command_name": f"compound-engineering:{worker['entry_command']}",
        "command_args": command_args,
    }

    prepared = False

    def prepare(doc):
        nonlocal prepared
        current = doc["workers"][worker["worker_id"]]
        if not _can_start(current) or current.get("action_id"):
            return
        doc["actions"][action_id] = action
        current.update(action_id=action_id, transcript_position=0)
        prepared = True

    doc = registry.update(prepare)
    worker = doc["workers"][worker["worker_id"]]
    if not prepared:
        return worker
    registry.append_event("entry_action_recorded", action)
    _prompt_entry(worker, action, ops)
    return _record(worker["worker_id"], "worker_phase", phase="command_sent")


def _prompt_entry(worker, action, ops):
    _call(
        ops.herdr, "agent", "prompt", worker["agent_name"],
        f"/{worker['entry_command']} {action['command_args']}", timeout=COMMAND_TIMEOUT,
    )


def _entry_unreceived(worker) -> bool:
    """True only while the agent's session has no transcript at all.

    Claude Code creates the transcript with the first prompt it takes, so a missing file means the
    entry keystrokes were dropped (live 2026-10-15: typed about 0.6 s after
    `agent start` reported ready, on a loaded box). KTD7 still never resends on its own; only an
    explicit `restart` types it again, and it cannot run twice.
    """
    return (bool(worker.get("session_id"))
            and transcript.find_transcript(worker["session_id"], PROJECTS_ROOT) is None)


def _resend_entry(worker, ops):
    """Type the recorded entry once more; its action and delivery proof stay the same."""
    counted = False

    def count(doc):
        nonlocal counted
        current = doc["workers"][worker["worker_id"]]
        action = doc["actions"].get(current.get("action_id"), {})
        if not _can_start(current) or action.get("kind") != "entry" or action.get("status") != "delivery_unknown":
            return
        action["resends"] = action.get("resends", 0) + 1
        counted = True

    doc = registry.update(count)
    worker = doc["workers"][worker["worker_id"]]
    if not counted:
        return worker
    action = doc["actions"][worker["action_id"]]
    registry.append_event("entry_resent", {"worker_id": worker["worker_id"], "action_id": action["id"],
                                           "resends": action["resends"]})
    _prompt_entry(worker, action, ops)
    return worker


def _confirm_delivery(worker, ops):
    action = registry.load()["actions"][worker["action_id"]]
    deadline = time.monotonic() + SESSION_TIMEOUT
    while not worker.get("session_id"):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StartError("entry delivery unknown: session id did not appear")
        result = _call(
            ops.herdr, "agent", "get", worker["agent_name"],
            timeout=min(COMMAND_TIMEOUT, remaining),
        )
        agent = _envelope(result).get("agent", {})
        session_id = (agent.get("agent_session") or {}).get("value")
        if isinstance(session_id, str) and session_id:
            worker = _record(worker["worker_id"], "session_discovered", session_id=session_id)
        else:
            time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))

    deadline = time.monotonic() + DELIVERY_TIMEOUT
    while True:
        path = transcript.find_transcript(worker["session_id"], PROJECTS_ROOT)
        if path:
            try:
                records, offset = transcript.read_records(path)
            except OSError as exc:
                raise StartError(f"cannot read entry transcript: {exc}") from exc
            # Position is the number of pre-send records; zero includes index 0.
            if transcript.delivered(
                records, after_index=action["transcript_position"] - 1,
                command_name=action["command_name"], command_args=action["command_args"],
            ):
                return _record(
                    worker["worker_id"], "worker_phase", phase="delivered",
                    transcript_path=str(path), transcript_offset=offset,
                    action_changes={"status": "delivered", "transcript_offset": offset},
                )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StartError("entry delivery unknown: command was not confirmed in the transcript")
        time.sleep(min(POLL_INTERVAL, remaining))


def _check_mode(worker, ops):
    deadline = time.monotonic() + MODE_TIMEOUT
    while True:
        try:
            records, offset = transcript.read_records(worker["transcript_path"])
        except OSError as exc:
            raise StartError(f"cannot read permission mode: {exc}") from exc
        mode = transcript.permission_mode(records)
        remaining = deadline - time.monotonic()
        if mode is not None or remaining <= 0:
            break
        time.sleep(min(POLL_INTERVAL, remaining))
    if mode != worker["permission_mode"]:
        reason = f"permission mode mismatch: expected {worker['permission_mode']}, recorded {mode!r}"
        try:
            _call(ops.herdr, "agent", "send-keys", worker["agent_name"], "esc", timeout=COMMAND_TIMEOUT)
        except StartError as exc:
            reason += f"; Escape failed: {exc}"
        raise StartError(reason)
    return _record(
        worker["worker_id"], "worker_phase", phase="mode_checked", state="running",
        transcript_offset=offset, recorded_permission_mode=mode,
    )


def _run_worker(worker, ops, *, keepalive=None, resend_entry=False):
    try:
        if resend_entry:
            worker = _resend_entry(worker, ops)
        for phases, operation in (
            ({None}, _create_worktree),
            ({"worktree"}, _start_agent),
            ({"agent_started"}, _send_entry),
            ({"agent_started", "command_sent"}, _confirm_delivery),
            ({"delivered"}, _check_mode),
        ):
            worker = registry.load()["workers"][worker["worker_id"]]
            if not _can_start(worker):
                return worker
            if worker.get("phase") in phases:
                if keepalive:
                    keepalive()
                worker = operation(worker, ops)
                if keepalive:
                    keepalive()
        return worker
    except StartError as exc:
        # Reload because an action may have been persisted just before a failed send.
        worker = registry.load()["workers"][worker["worker_id"]]
        action_changes = None
        if worker.get("action_id") and worker.get("phase") not in {"delivered", "mode_checked"}:
            action_changes = {"status": "delivery_unknown", "reason": str(exc)}
        return _record(
            worker["worker_id"], "worker_start_failed", state="start_failed", reason=str(exc),
            action_changes=action_changes,
        )


def start_issues(repo_path, issues, *, lane="main", tag=None, contact=None, ops=adapters) -> list[dict]:
    repo = str(Path(repo_path).resolve())
    tag = lanes.coordinator_tag(tag, lane, repo)
    summaries = []
    for position, issue in enumerate(issues):
        try:
            _start_issue(repo, issue, summaries, ops, lane=lane, tag=tag, contact=contact)
        except Exception as exc:
            # Earlier issues may have started: the caller reports what the registry holds for each,
            # never a blanket failure.
            exc.start_summaries = [
                *summaries, _interrupted_summary(repo, issue, exc),
                *({"issue": rest, "repo_path": repo, "state": "not_attempted",
                   "reason": f"start stopped at issue {issue}"} for rest in issues[position + 1:]),
            ]
            raise
    return summaries


def adopt(repo_path, name, *, lane="main", tag=None, label=None, caller_pane_id=None, ops=adapters):
    """Register an existing Claude session without sending it any input."""
    repo = str(Path(repo_path).resolve())
    result = _run(ops.herdr, "agent", "get", name, timeout=COMMAND_TIMEOUT)
    if not result.ok:
        # Pane ids are not agent names on every herdr version.
        listing = _envelope(_call(ops.herdr, "agent", "list", timeout=COMMAND_TIMEOUT)).get("agents")
        matches = [agent for agent in listing if isinstance(agent, dict) and agent.get("pane_id") == name
                   and agent.get("name")] if isinstance(listing, list) else []
        if len(matches) != 1:
            raise StartError(f"cannot resolve agent or pane {name!r}: {_failure(result)}")
        result = _call(ops.herdr, "agent", "get", matches[0]["name"], timeout=COMMAND_TIMEOUT)
    agent = _envelope(result).get("agent")
    if not isinstance(agent, dict) or agent.get("agent") != "claude":
        raise StartError("adopt requires a claude agent")
    session_info = agent.get("agent_session")
    session = session_info.get("value") if isinstance(session_info, dict) else None
    if not isinstance(session, str) or not session.strip():
        raise StartError("agent has no session id")
    for key in ("name", "pane_id", "workspace_id", "cwd"):
        if not isinstance(agent.get(key), str) or not agent[key].strip():
            raise StartError(f"agent has no {key}")
    if agent["pane_id"] == (caller_pane_id or os.environ.get("HERDR_PANE_ID")):
        raise StartError("cannot adopt the caller's own pane")
    listed = _call(ops.git, "worktree", "list", "--porcelain", cwd=repo, timeout=COMMAND_TIMEOUT)
    roots = [line[len("worktree "):] for line in listed.stdout.splitlines() if line.startswith("worktree ")]
    cwd = os.path.normcase(os.path.realpath(agent["cwd"]))
    # The worktree is the innermost registered checkout holding the cwd, so a session working in a
    # subfolder still records the tree cleanup may remove.
    containing = [root for root in roots if Path(cwd).is_relative_to(os.path.normcase(os.path.realpath(root)))]
    if not containing:
        raise StartError("agent cwd is outside this repository and its registered worktrees")
    worktree = max(containing, key=lambda root: len(os.path.realpath(root)))
    path = transcript.find_transcript(session, Path(getattr(ops, "projects_root", PROJECTS_ROOT)))
    if path is None:
        raise StartError("agent transcript cannot be found")
    try:
        # The parser's boundary, not the file size: a record still being written is read whole later.
        _, offset = transcript.read_records(path)
    except OSError as exc:
        raise StartError(f"cannot read agent transcript: {exc}") from exc
    now = time.time()
    worker_id = f"{os.path.normcase(repo)}@{agent['name']}"
    worker = {
        "worker_id": worker_id, "adhoc": True, "issue": None, "repo_path": repo, "lane": lane,
        "label_tag": lanes.coordinator_tag(tag, lane, repo),
        "title": label if label is not None else agent.get("terminal_title_stripped") or agent["name"],
        "agent_name": agent["name"], "pane_id": agent["pane_id"], "workspace_id": agent["workspace_id"],
        "session_id": session, "transcript_path": str(path), "transcript_offset": offset,
        "adopted_session_id": session, "adopted_offset": offset,
        "adopted_working": agent.get("agent_status") == "working",
        "worktree_path": worktree, "phase": "mode_checked",
        "state": "running" if agent.get("agent_status") == "working" else "awaiting_merge",
        "state_token": uuid.uuid4().hex, "last_change": now, "last_growth_at": now,
    }

    def register(doc, events):
        if any(binding.get("pane_id") == worker["pane_id"]
               or (binding.get("controller") or {}).get("value") == session
               for binding in doc["tab_bindings"].values()):
            raise StartError("cannot adopt a lane's bound controller pane")
        for current in [*doc["workers"].values(), *doc["queue"]]:
            if current.get("state") != "cleaned" and any(
                    current.get(key) == worker[key] for key in ("agent_name", "pane_id", "session_id")):
                raise StartError("a non-cleaned worker already tracks this agent, pane or session")
        doc["workers"][worker_id] = worker
        events.append(("worker_adopted", dict(worker)))

    registry.update_with_events(register, caller_lane=lane)
    return worker


def _interrupted_summary(repo, issue, exc):
    summary = {"issue": issue, "repo_path": repo, "state": "start_error", "reason": str(exc)}
    try:
        number = int(str(issue).lstrip("#"))
        worker = registry.load()["workers"].get(f"{os.path.normcase(repo)}#{number}")
    except Exception:
        return summary
    if worker is not None:
        summary.update(issue=number, state=worker.get("state"), worker_state_recorded=True)
    return summary


def _start_issue(repo, issue, summaries, ops, *, lane="main", tag=None, contact=None):
    try:
        number = int(str(issue).lstrip("#"))
        if number <= 0:
            raise ValueError("issue numbers must be positive")
    except ValueError as exc:
        summaries.append({"issue": issue, "state": "refused", "reason": str(exc)})
        return
    try:
        result = _call(
            ops.gh, "issue", "view", str(number), "--json", "number,title,labels,body",
            cwd=repo, timeout=COMMAND_TIMEOUT,
        )
        data = result.data
        if not isinstance(data, dict) or data.get("number") != number:
            raise StartError("gh returned no matching issue")
        labels = [label.get("name", "") if isinstance(label, dict) else label for label in data.get("labels", [])]
        entry = parse_entry_command(labels, data.get("body") or "")
        worker_id = f"{os.path.normcase(repo)}#{number}"
        existing = registry.load()["workers"].get(worker_id)
        if entry is None and (existing is None or existing.get("state") == "cleaned"):
            raise StartError("issue has no assigned CE entry command")
        command, args = entry or ("", "")
        candidate = {
            "worker_id": worker_id, "issue": number, "repo_path": repo, "lane": lane,
            "title": data.get("title", ""), "label_tag": tag, "entry_command": command,
            "coordinator_contact": contact,
            "entry_args": args or f"#{number}", "phase": None,
            "branch": f"issue/{number}",
            "worktree_path": str(Path(repo).with_name(f"{Path(repo).name}-wt-issue-{number}")),
            "permission_mode": registry.load()["config"].get("permission_mode", DEFAULT_PERMISSION_MODE),
        }
        worker, admitted = _admit(candidate)
    except StartError as exc:
        summary = {"issue": number, "repo_path": repo, "state": "refused", "reason": str(exc)}
        registry.append_event("issue_refused", summary, caller_lane=lane)
        summaries.append(summary)
        return
    summaries.append(_run_worker(worker, ops) if admitted else worker)


def start_next_queued(*, ops=adapters, keepalive=None) -> dict | None:
    """Atomically take the oldest issue and reserve its slot for the watcher."""
    admitted = []
    owner = _start_owner()

    def take(doc, events):
        if doc["holds"] or not _has_slot(doc) or not doc["queue"]:
            return
        worker = next((item for item in doc["queue"]
                       if not item.get("adhoc") and item.get("issue") is not None), None)
        if worker is None:
            return
        doc["queue"].remove(worker)
        _claim(doc, worker, owner)
        admitted.append(worker)
        events.append(("worker_starting", worker))

    registry.update_with_events(take)
    if not admitted:
        return None
    worker = admitted[0]
    return _run_worker(worker, ops, **({"keepalive": keepalive} if keepalive else {}))


def restart(name, *, lane="main", ops=adapters) -> dict:
    """Explicitly claim an interrupted start, or a failed one whose entry never arrived, and reuse its completed phases."""

    owner = _start_owner()
    admitted = []
    resend = []

    def claim(doc):
        matches = [worker for worker in doc["workers"].values()
                   if not worker.get("adhoc") and worker.get("issue") is not None
                   and (worker.get("agent_name") == str(name)
                        or str(worker["issue"]) == str(name).lstrip("#"))]
        if len(matches) != 1:
            raise ValueError(f"expected one worker matching {name}, found {len(matches)}")
        worker = matches[0]
        lanes.check_worker_lane(worker, lane)
        if doc["holds"]:
            raise ValueError("cannot restart while a hold is open; run go first")
        if (worker.get("state") == "start_failed" and not worker.get("agent_name")
                and worker.get("phase") is None):
            # It failed before reaching agent start, so no agent can exist. A failed agent start
            # (phase "worktree") may have timed out with its agent running, and stays refused.
            pass
        elif worker.get("state") == "start_failed" and _entry_retryable(doc, worker):
            resend.append(True)
        elif worker.get("state") not in {"start_interrupted", "storage_pending"}:
            raise ValueError("restart requires a start_interrupted worker, or a start_failed one "
                             "before agent start or whose entry never reached its session")
        if not _has_slot(doc):
            raise ValueError("no slot available for restart")
        worker.update(state="starting", start_owner=owner)
        worker.pop("reason", None)
        admitted.append(worker)

    registry.update(claim)
    worker = admitted[0]
    registry.append_event("worker_starting", worker)
    if resend:
        return _run_worker(worker, ops, resend_entry=True)
    return _run_worker(worker, ops)


def _entry_retryable(doc, worker) -> bool:
    """A failed start whose recorded entry provably never reached its live session."""
    action = doc["actions"].get(worker.get("action_id"), {})
    # One retry per start: a retry whose send timed out may still arrive, so it is never repeated.
    return (action.get("kind") == "entry" and action.get("status") == "delivery_unknown"
            and not action.get("resends")
            and worker.get("phase") in {"agent_started", "command_sent"}
            and bool(worker.get("agent_name")) and not worker.get("entry_recovery_pending")
            and _entry_unreceived(worker))
