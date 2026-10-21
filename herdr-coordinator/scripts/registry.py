"""Versioned coordinator state and serialized, numbered events on Windows.

Use locked() around direct load/save pairs. update(), append_event(), read_events()
and ack() take that lock themselves; they must not be called inside locked().
"""

from __future__ import annotations

import ctypes
import json
import msvcrt
import os
import tempfile
import time
from contextlib import contextmanager
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path


_LOCK_RETRY_DELAY = 0.01
_REPLACE_ATTEMPTS = 6
_REPLACE_RETRY_DELAY = 0.025  # doubled per retry: up to ~0.8 s for a reader holding the file


def _home() -> Path:
    override = os.environ.get("HERDR_COORD_HOME")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) if local else Path.home() / "AppData" / "Local") / "herdr-coordinator"


@contextmanager
def locked(timeout=10):
    """Hold an exclusive lock on byte zero, including while exceptions unwind."""
    home = _home()
    home.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    with (home / "registry.lock").open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        while True:
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as exc:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Timed out acquiring registry lock") from exc
                time.sleep(min(_LOCK_RETRY_DELAY, remaining))
        try:
            _recover_transaction()
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def _lane(ack_seq):
    return {"ack_seq": ack_seq, "follow_lease": None,
            "unattended_since": None, "last_alert_at": None}


def _validate_version(doc):
    if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] not in (1, 2, 3):
        raise ValueError("Unsupported registry version")


def _migrate(doc):
    _validate_version(doc)
    if doc["version"] == 1:
        doc["lanes"] = {"main": _lane(doc.pop("ack_seq"))}
        doc["workspace_bindings"] = {}
        for worker in [*doc["workers"].values(), *doc["queue"]]:
            worker["lane"] = "main"
        doc["version"] = 2
    if doc["version"] == 2:
        for binding in doc.pop("workspace_bindings").values():
            doc["lanes"].setdefault(binding["lane"], _lane(doc["event_seq"]))["bound_before"] = True
        doc["tab_bindings"] = {}
        doc["version"] = 3
    return doc


def _load_document() -> dict:
    try:
        # A flushed transaction is committed intent, even before its registry
        # replacement completes. Readers see that snapshot until recovery drains it.
        transaction = _pending_transaction()
        if transaction is not None:
            doc = transaction["doc"]
        else:
            doc = _read_json(_home() / "registry.json")
    except FileNotFoundError:
        return {
            "version": 3, "workers": {}, "queue": [], "holds": {},
            "actions": {}, "event_seq": 0, "notification_seq": 0, "config": {},
            "lanes": {"main": _lane(0)}, "tab_bindings": {},
        }
    _validate_version(doc)
    return doc


def load() -> dict:
    """Return a v3 view without writing, including before the first locked migration."""
    return _migrate(_load_document())


def _retry_permission(fn):
    """Windows refuses to replace, delete or open a file another process holds open."""
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            return fn()
        except PermissionError:
            if attempt + 1 == _REPLACE_ATTEMPTS:
                raise
            time.sleep(_REPLACE_RETRY_DELAY * 2 ** attempt)


def replace_with_retry(temp, dest):
    _retry_permission(lambda: os.replace(temp, dest))


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.CreateFileW.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
_kernel32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
_GENERIC_READ = 0x80000000
_SHARE_ALL = 0x1 | 0x2 | 0x4  # FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
_OPEN_EXISTING = 3
_INVALID_HANDLE = wintypes.HANDLE(-1).value


def _open_shared(path):
    """Open for reading without blocking a writer's replace or delete of the same file.

    Python's open() omits FILE_SHARE_DELETE, so a lock-free reader made os.replace and the
    journal delete fail with WinError 32; readers looping on load() could starve them outright.
    """
    handle = _kernel32.CreateFileW(str(path), _GENERIC_READ, _SHARE_ALL, None, _OPEN_EXISTING, 0, None)
    if handle == _INVALID_HANDLE:
        error = ctypes.get_last_error()
        raise ctypes.WinError(error) if error not in (2, 3) else FileNotFoundError(2, "No such file", str(path))
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except BaseException:
        _kernel32.CloseHandle(handle)  # ownership never passed to a descriptor
        raise
    return open(descriptor, encoding="utf-8")  # owns the descriptor from here, even on failure


def _read_json(path):
    def read():
        with _open_shared(path) as handle:
            return json.load(handle)

    # A file deleted while another reader holds it refuses new opens until that reader closes.
    return _retry_permission(read)


def save(doc):
    """Flush a temp file beside the registry, then replace with bounded retries."""
    _save_json(doc, _home() / "registry.json")


def _save_json(doc, destination):
    home = _home()
    home.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=home,
            prefix="registry-", suffix=".tmp", delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(doc, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        replace_with_retry(temp_path, destination)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def update(fn) -> dict:
    return update_with_events(lambda doc, events: fn(doc))


def _pending_transaction():
    try:
        return _read_json(_home() / "transaction.json")
    except FileNotFoundError:
        return None


def _recover_transaction():
    """Finish committed intent under the caller's lock; never replay its callback."""
    transaction = _pending_transaction()
    if transaction is None:
        return
    _validate_version(transaction["doc"])
    path = _home() / "events.jsonl"
    last_seq = _last_event_seq(path)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for event in transaction["events"]:
            if event["seq"] > last_seq:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    save(transaction["doc"])
    # A lock-free load() may be reading the journal at this moment.
    _retry_permission(lambda: (_home() / "transaction.json").unlink(missing_ok=True))


def update_with_events(fn, *, caller_lane="main") -> dict:
    """Mutate a document and collect (kind, payload) events in one locked commit.

    The callback takes (doc, events). Journal the full commit before appending
    events, then replace the registry. A crash at either boundary is recoverable.
    """
    with locked():
        doc = _load_document()
        before = json.dumps(doc, ensure_ascii=False)
        migrating = doc["version"] < 3
        _migrate(doc)
        pending = []
        fn(doc, pending)
        # Every stored worker and queued item carries a lane; pre-lane callers default to main.
        for worker in [*doc["workers"].values(), *doc["queue"]]:
            worker.setdefault("lane", "main")
        if not pending and not migrating:
            if json.dumps(doc, ensure_ascii=False) != before:
                save(doc)
            return doc
        seq = max(doc["event_seq"], _last_event_seq(_home() / "events.jsonl"))
        events = []
        for kind, payload in pending:
            seq += 1
            events.append({"seq": seq, "ts": datetime.now(timezone.utc).isoformat(),
                           "kind": kind, "payload": payload,
                           **_route(doc, kind, payload, caller_lane)})
        doc["event_seq"] = seq
        _save_json({"doc": doc, "events": events}, _home() / "transaction.json")
        _recover_transaction()
        return doc


def _last_event_seq(path: Path) -> int:
    """Recover the sequence if a prior writer appended but died before save()."""
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            position = handle.tell()
            tail = b""
            while position:
                size = min(position, 4096)
                position -= size
                handle.seek(position)
                tail = handle.read(size) + tail
                content = tail.rstrip(b"\r\n")
                if b"\n" in content or position == 0:
                    return json.loads(content.rsplit(b"\n", 1)[-1])["seq"] if content else 0
    except FileNotFoundError:
        pass
    return 0


def _repo_event(kind, payload):
    return (kind.startswith(("watcher_", "herdr_", "hold_", "holds_"))
            or kind == "lane_unattended"
            or (kind == "technical_problem" and not payload.get("worker_id")))


def _route(doc, kind, payload, caller_lane):
    if _repo_event(kind, payload):
        return {"scope": "repo"}
    if kind == "worker_handoff":
        return {"lanes": list(dict.fromkeys((payload["from_lane"], payload["to_lane"])))}
    if kind == "issue_refused":
        return {"lanes": [caller_lane]}
    worker_id = payload.get("worker_id")
    worker = doc["workers"].get(worker_id) or next(
        (item for item in doc["queue"] if item.get("worker_id") == worker_id), {})
    return {"lanes": [worker.get("lane", "main")]}


def append_event(kind, payload, *, caller_lane="main") -> int:
    doc = update_with_events(lambda doc, events: events.append((kind, payload)), caller_lane=caller_lane)
    return doc["event_seq"]


def event_lanes(event):
    """The lanes an event is routed to, or None for a repository-wide event."""
    if event.get("scope") == "repo":
        return None
    if "lanes" in event:
        return event["lanes"]
    # Pre-upgrade events have no routing envelope, regardless of today's worker lane.
    return None if _repo_event(event.get("kind", ""), event.get("payload", {})) else ["main"]


def _visible(event, lane):
    routed = event_lanes(event)
    return lane is None or routed is None or lane in routed


def read_events(after_seq, *, lane="main") -> list[dict]:
    """Read this lane's events; lane=None is for the shared watcher/notification cursor."""
    with locked():
        load()  # Refuse an unsupported registry before reading its log.
        return _read_events(after_seq, lane)


def _read_events(after_seq, lane):
    events = []
    try:
        with (_home() / "events.jsonl").open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            position = handle.tell()
            tail = b""
            while position:
                size = min(position, 4096)
                position -= size
                handle.seek(position)
                lines = (handle.read(size) + tail).split(b"\n")
                tail = lines.pop(0)
                if position == 0:
                    lines.insert(0, tail)
                for line in reversed(lines):
                    if not line:
                        continue
                    event = json.loads(line)
                    if event["seq"] <= after_seq:
                        return list(reversed(events))
                    if _visible(event, lane):
                        events.append(event)
    except FileNotFoundError:
        return []
    return list(reversed(events))


# Unlike watch.TERMINAL_STATES, "cleaning" is still pending here: it is a mutation in flight.
SETTLED_WORKER_STATES = frozenset({"done", "awaiting_merge", "cleaned", "start_failed"})


def lane_pending_work(doc, lane):
    """A lane's unsettled workers, queued items and routed unacknowledged events; read under the lock."""
    workers = [(key, worker) for key, worker in doc["workers"].items()
               if worker.get("lane", "main") == lane and worker.get("state") not in SETTLED_WORKER_STATES]
    queued = [item for item in doc["queue"] if item.get("lane", "main") == lane]
    events = [event for event in _read_events(doc["lanes"][lane]["ack_seq"], lane)
              if lane in (event_lanes(event) or [])]
    return workers, queued, events


def lane_has_pending_work(doc, lane):
    """Check an already-loaded lane while the caller holds the update lock."""
    return any(lane_pending_work(doc, lane))


def ack(seq, *, lane="main"):
    if type(seq) is not int or seq < 0:
        raise ValueError("sequence must be a nonnegative integer")

    def advance(doc):
        if lane not in doc["lanes"]:
            raise ValueError(f"Unknown lane: {lane}")
        if seq and not any(event["seq"] == seq for event in _read_events(seq - 1, lane)):
            raise ValueError(f"Sequence {seq} is not visible to lane {lane}")
        current = doc["lanes"][lane]
        current["ack_seq"] = max(current["ack_seq"], seq)

    update(advance)


def create_lane(name):
    """Create once under the registry lock, starting at the current end of the log."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("lane name must be nonempty")
    return update(lambda doc: doc["lanes"].setdefault(name, _lane(doc["event_seq"])))


def reconcile(doc, *, workspaces, agents, worktrees) -> list[dict]:
    """Mutate only registered workers; return events ready for append_event().

    Workspace absence is the loss signal for this unit. Agent and worktree lists
    are accepted for consumers' common reconciliation interface.
    """
    workspace_ids = {
        workspace.get("id", workspace.get("workspace_id"))
        if isinstance(workspace, dict) else workspace
        for workspace in workspaces
    }
    events = []
    for worker_id, worker in doc["workers"].items():
        workspace_id = worker.get("workspace_id")
        if not workspace_id or workspace_id in workspace_ids or worker.get("state") == "lost":
            continue
        worker["state"] = "lost"
        events.append({
            "kind": "worker_lost",
            "payload": {"worker_id": worker_id, "workspace_id": workspace_id},
        })
    return events
