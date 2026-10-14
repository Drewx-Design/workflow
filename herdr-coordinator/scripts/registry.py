"""Versioned coordinator state and serialized, numbered events on Windows.

Use locked() around direct load/save pairs. update(), append_event(), read_events()
and ack() take that lock themselves; they must not be called inside locked().
"""

from __future__ import annotations

import json
import msvcrt
import os
import tempfile
import time
from contextlib import contextmanager
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


def load() -> dict:
    try:
        # A flushed transaction is committed intent, even before its registry
        # replacement completes. Readers see that snapshot until recovery drains it.
        transaction = _pending_transaction()
        if transaction is not None:
            doc = transaction["doc"]
        else:
            with (_home() / "registry.json").open(encoding="utf-8") as handle:
                doc = json.load(handle)
    except FileNotFoundError:
        return {
            "version": 1, "workers": {}, "queue": [], "holds": {},
            "actions": {}, "event_seq": 0, "ack_seq": 0, "config": {},
        }
    if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] != 1:
        raise ValueError("Unsupported registry version")
    return doc


def replace_with_retry(temp, dest):
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(temp, dest)
            return
        except PermissionError:
            if attempt + 1 == _REPLACE_ATTEMPTS:
                raise
            time.sleep(_REPLACE_RETRY_DELAY * 2 ** attempt)


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
    with locked():
        doc = load()
        before = json.dumps(doc, ensure_ascii=False)
        fn(doc)
        if json.dumps(doc, ensure_ascii=False) != before:
            save(doc)
        return doc


def _pending_transaction():
    try:
        with (_home() / "transaction.json").open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def _recover_transaction():
    """Finish committed intent under the caller's lock; never replay its callback."""
    transaction = _pending_transaction()
    if transaction is None:
        return
    path = _home() / "events.jsonl"
    last_seq = _last_event_seq(path)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for event in transaction["events"]:
            if event["seq"] > last_seq:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    save(transaction["doc"])
    (_home() / "transaction.json").unlink()


def update_with_events(fn) -> dict:
    """Mutate a document and collect (kind, payload) events in one locked commit.

    The callback takes (doc, events). Journal the full commit before appending
    events, then replace the registry. A crash at either boundary is recoverable.
    """
    with locked():
        doc = load()
        before = json.dumps(doc, ensure_ascii=False)
        pending = []
        fn(doc, pending)
        if not pending:
            if json.dumps(doc, ensure_ascii=False) != before:
                save(doc)
            return doc
        seq = max(doc["event_seq"], _last_event_seq(_home() / "events.jsonl"))
        events = []
        for kind, payload in pending:
            seq += 1
            events.append({"seq": seq, "ts": datetime.now(timezone.utc).isoformat(),
                           "kind": kind, "payload": payload})
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


def append_event(kind, payload) -> int:
    doc = update_with_events(lambda doc, events: events.append((kind, payload)))
    return doc["event_seq"]


def read_events(after_seq) -> list[dict]:
    with locked():
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
                        events.append(event)
        except FileNotFoundError:
            return []
        return list(reversed(events))


def ack(seq):
    def advance(doc):
        doc["ack_seq"] = max(doc["ack_seq"], seq)

    update(advance)


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
