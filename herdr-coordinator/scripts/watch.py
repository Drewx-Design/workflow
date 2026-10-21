"""Detached watcher, durable event follower, and OS-lock liveness checks."""

from __future__ import annotations

import json
import msvcrt
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import NamedTuple

import actions
import adapters
import finish
import lanes
import registry
import repo_root
import start
import transcript


class _TranscriptCache(NamedTuple):
    path: str
    records: list[dict]
    offset: int


# Rebuilt once after watcher restart, then extended from the persisted byte offset.
_TRANSCRIPTS = {}
# `cleaning`: cleanup has claimed the worker and may be closing its window; the watcher leaves it alone.
TERMINAL_STATES = {"done", "awaiting_merge", "cleaned", "start_failed", "cleaning"}
REOPENABLE_STATES = {"done", "awaiting_merge"}  # settled, but the user may keep using the pane
# Past the hour-long background wait, a pane whose footer still counts running background shells
# keeps the wait, up to this long without transcript growth.
BACKGROUND_LIVE_MAX_SECONDS = 6 * 60 * 60
# A dismiss-and-answer relay waits up to actions.DISMISS_TIMEOUT for the form to close, then types.
DISMISS_SETTLE_SECONDS = 120
# Producer captures: tests/fixtures/herdr-agent-read-visible.txt ("· 3 shells · … · ← 1 agent ·") and
# live footers of 2026-10-19. "← 1 agent" is on every pane, idle ones included, so only shells count.
_FOOTER_SHELLS = re.compile(r"(?:^|·\s*)(\d+)\s+shells?(?=\s*(?:·|$))")


@contextmanager
def watcher_lock():
    home = registry._home()
    home.mkdir(parents=True, exist_ok=True)
    with (home / "watcher.lock").open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def lock_held():
    with watcher_lock() as acquired:
        return not acquired


def heartbeat(*, now, poll):
    home = registry._home()
    home.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=home,
                                         prefix="heartbeat-", suffix=".tmp", delete=False) as handle:
            temp = Path(handle.name)
            json.dump({"pid": os.getpid(), "ts": now, "poll": poll}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            registry.replace_with_retry(temp, home / "heartbeat.json")
        except PermissionError as exc:
            # A reader (status, PowerShell, AV) still holds the file. The next poll rewrites it,
            # so a missed beat must not abort this poll or count toward the watcher's exit.
            try:
                with (home / "watcher.log").open("a", encoding="utf-8") as log:
                    log.write(f"{now}: heartbeat write skipped: {exc}\n")
            except OSError:
                pass
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def heartbeat_pid():
    try:
        pid = json.loads((registry._home() / "heartbeat.json").read_text(encoding="utf-8")).get("pid")
    except (OSError, ValueError, AttributeError):
        return None
    return pid if type(pid) is int and pid > 0 else None


def watcher_alive(*, now=None):
    if not lock_held():
        return False
    try:
        data = json.loads((registry._home() / "heartbeat.json").read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return True
        pid = data.get("pid")
        if type(pid) is int and pid > 0 and start._process_identity(pid) is None:
            return False
    except (OSError, ValueError, TypeError, KeyError):
        pass  # An inaccessible process or heartbeat does not prove death.
    return True


def watcher_slow(*, now=None):
    try:
        data = json.loads((registry._home() / "heartbeat.json").read_text(encoding="utf-8"))
        age = (time.time() if now is None else now) - float(data["ts"])
        poll = float(data["poll"])
        return poll <= 0 or age > 3 * poll
    except (OSError, ValueError, TypeError, KeyError):
        return True


def follower_alive(lane, lease, *, now=None):
    if not isinstance(lease, dict) or type(lease.get("pid")) is not int or lease["pid"] <= 0:
        return False
    if type(lease.get("process_created")) is not int:
        return False
    try:
        data = json.loads((registry._home() / f"follow-{lane}.json").read_text(encoding="utf-8"))
        if any(data.get(key) != lease.get(key) for key in ("pid", "process_created", "tab_id", "controller")):
            return False
        age = (time.time() if now is None else now) - float(data["ts"])
        if not 0 <= age < 120:
            return False
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False
    try:
        identity = start._process_identity(lease["pid"])
    except OSError:
        return True  # A fresh heartbeat and inaccessible process do not prove death.
    return identity == {"pid": lease["pid"], "created": lease["process_created"]}


def _follow_heartbeat(lane, lease, *, now):
    registry._save_json({**lease, "ts": now}, registry._home() / f"follow-{lane}.json")


def _main_bindings(doc):
    return {tab_id: binding for tab_id, binding in doc["tab_bindings"].items() if binding["lane"] == "main"}


def _follow_snapshot(lease):
    known = _main_bindings(registry.load()) if lease.get("tab_id") is None else None
    if known == {}:
        return None, known  # No main owner to look up; recheck these bindings under the lock.
    return lanes.read_snapshot(), known


def _check_follow_binding(doc, lane, lease, snapshot, known):
    if lease.get("tab_id") is not None:
        binding = doc["tab_bindings"].get(lease["tab_id"])
        if (binding is None or binding["lane"] != lane
                or binding["controller"] != lease["controller"]):
            raise ValueError("lane binding moved; restart follow from the owning tab")
        return True
    if lane != "main":
        raise ValueError("Outside herdr, follow can only serve lane main")
    if _main_bindings(doc) != known:
        return False  # A new owner needs a fresh snapshot, taken after releasing the lock.
    for tab_id, binding in doc["tab_bindings"].items():
        if binding["lane"] != "main":
            continue
        if snapshot is None:
            raise ValueError("Cannot verify main ownership: herdr snapshot is unknown")
        if lanes.owner_live(binding["controller"], snapshot):
            raise ValueError(f"Lane main is owned by tab {tab_id}; restart follow from the owning tab")
    return True


def _claim_follow(lane, *, now, context=None):
    owner = start._start_owner()
    lease = {"pid": owner["pid"], "process_created": owner["created"]}
    if context is not None and context["tab_id"] is not None:
        if context["lane"] != lane:
            raise ValueError("lane binding moved; restart follow from the owning tab")
        lease.update(tab_id=context["tab_id"], controller=dict(context["controller"]))
    for _ in range(3):
        snapshot, known = _follow_snapshot(lease) if lease.get("tab_id") is None else (None, None)
        claimed = False

        def claim(doc):
            nonlocal claimed
            current = doc["lanes"][lane]
            holder = current.get("follow_lease")
            if follower_alive(lane, holder, now=now):
                raise ValueError(f"Lane {lane} already has follow running with pid {holder['pid']}")
            if not _check_follow_binding(doc, lane, lease, snapshot, known):
                return
            # Publish the first beat inside the claim lock, before another follower can inspect it.
            _follow_heartbeat(lane, lease, now=now)
            current.update(follow_lease=lease, unattended_since=None, last_alert_at=None)
            claimed = True

        registry.update(claim)
        if claimed:
            return lease
    raise ValueError("Main lane bindings changed during herdr snapshot; retry follow")


def _refresh_follow(lane, lease, *, now):
    for _ in range(3):
        snapshot, known = _follow_snapshot(lease)
        error = None
        retry = False

        def refresh(doc):
            nonlocal error, retry
            current = doc["lanes"][lane]
            if current.get("follow_lease") != lease:
                return
            try:
                if not _check_follow_binding(doc, lane, lease, snapshot, known):
                    retry = True
                    return
                if (lease.get("controller") is not None and snapshot is not None
                        and not lanes.owner_live(lease["controller"], snapshot)):
                    raise ValueError("controller absent; lane binding moved; restart follow from the owning tab")
            except ValueError as exc:
                current["follow_lease"] = None
                error = exc
                return
            _follow_heartbeat(lane, lease, now=now)

        # Serialize the heartbeat and any release with takeover and binding changes.
        doc = registry.update(refresh)
        if retry:
            continue
        if error is not None:
            raise error
        return doc["lanes"][lane].get("follow_lease") == lease
    _release_follow(lane, lease)
    raise ValueError("Main lane bindings changed during herdr snapshot; stopping follow")


def _release_follow(lane, lease):
    def release(doc):
        if doc["lanes"][lane].get("follow_lease") == lease:
            doc["lanes"][lane]["follow_lease"] = None

    registry.update(release)


def launch():
    if lock_held():
        return {"state": "already_running"}
    home = registry._home()
    home.mkdir(parents=True, exist_ok=True)
    executable = Path(sys.executable)
    if executable.name.lower() == "pythonw.exe":
        executable = executable.with_name("python.exe")
    flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
             | subprocess.CREATE_BREAKAWAY_FROM_JOB)
    try:
        with (home / "watcher.log").open("ab") as log:
            process = subprocess.Popen(
                [str(executable), str(Path(__file__).resolve()), "run"],
                creationflags=flags, stdin=subprocess.DEVNULL, stdout=log,
                stderr=log, close_fds=True,
            )
    except OSError as exc:
        return {"state": "launch_failed", "detail": f"Detached/breakaway launch failed: {exc}"}
    return {"state": "launched", "pid": process.pid}


def _read(worker, ops, now):
    session_id = worker.get("session_id")
    path = Path(worker["transcript_path"]) if worker.get("transcript_path") else None
    if not session_id or path is None or path.name != f"{session_id}.jsonl" or not path.is_file():
        path = transcript.find_transcript(session_id, actions.projects_root(ops))
    if path is None:
        return [], False
    key = (str(registry._home()), worker["worker_id"])
    cached = _TRANSCRIPTS.get(key)
    offset = worker.get("transcript_offset", 0)
    if cached is None or cached.path != str(path) or cached.offset != offset:
        records, new_offset = transcript.read_records(path)
    else:
        size = path.stat().st_size
        if size < offset:
            records, new_offset = transcript.read_records(path)
        else:
            records, new_offset = cached.records, offset
            if size != offset:
                new_records, new_offset = transcript.read_records(path, offset)
                records.extend(new_records)
    growth = new_offset != offset
    _TRANSCRIPTS[key] = _TranscriptCache(str(path), records, new_offset)
    # Record a move on to build as soon as it is seen, with the offset that covers it: a later session
    # change drops these records. The scan is cheap (about 2 ms for 3,000 records).
    entry = _entry(worker)
    stage = (finish.later_stage(records, exclude={"ce-plan"} if entry == "ce-plan" else ())
             if not worker.get("advanced_stage")
             and entry in {"ce-brainstorm", "ce-strategy", "ce-plan"} else None)

    def remember(doc):
        current = doc["workers"][worker["worker_id"]]
        if current.get("session_id") != worker.get("session_id"):
            return
        current.update(transcript_path=str(path), transcript_offset=new_offset)
        if stage and not current.get("advanced_stage"):
            current["advanced_stage"] = stage
        if growth or "last_growth_at" not in current:
            current["last_growth_at"] = now

    registry.update(remember)
    return records, growth


def _herdr_lost(now):
    def lose(doc, events):
        if "herdr_lost" not in doc["holds"]:
            hold = {"ts": now, "workers": [w.get("agent_name", key) for key, w in doc["workers"].items()
                                           if w["state"] not in TERMINAL_STATES]}
            doc["holds"]["herdr_lost"] = hold
            events.append(("herdr_lost", hold))
        for worker in doc["workers"].values():
            if worker["state"] in TERMINAL_STATES:
                continue
            state = "lost" if worker.get("session_id") else (
                "start_interrupted" if worker["state"] == "starting" else worker["state"])
            if worker["state"] != state:
                worker.update(state=state, last_change=now, reason="herdr_lost")
                worker.pop("question_text", None)
                events.append(("worker_state", dict(worker)))

    registry.update_with_events(lose)


def _notification(event, worker=None) -> tuple[str, str] | None:
    payload = event["payload"]
    title = body = None
    if event["kind"] == "herdr_lost":
        title = "herdr recovered; workers held"
        body = "Run go before resuming: " + ", ".join(payload["workers"])
    elif event["kind"] == "watcher_lost":
        title, body = "Coordinator watcher lost", "Workers are held until the user runs go."
    elif event["kind"] == "lane_unattended":
        title = f"Lane {payload['lane']} unattended"
        body = f"Lane {payload['lane']} has unhandled worker events and no live follow."
    elif event["kind"] in {"watcher_exit", "watcher_slow", "watcher_hung", "technical_problem"}:
        if event["kind"] == "technical_problem" and payload.get("failed_iterations"):
            return None  # Iteration failures are logged; repeated failure has one exit notification.
        title = {"watcher_exit": "Coordinator watcher stopped",
                 "watcher_slow": "Coordinator watcher slow",
                 "watcher_hung": "Coordinator watcher hung",
                 "technical_problem": "Coordinator technical problem"}[event["kind"]]
        body = payload["detail"]
    elif event["kind"] == "delivery_unknown":
        title, body = "Worker delivery unknown", payload["detail"]
    elif event["kind"] == "send_refused":
        title, body = "Worker send refused (nothing sent)", payload["detail"]
    elif event["kind"] == "delivery_failed":
        title, body = "Worker delivery failed", payload["detail"]
    elif event["kind"] == "action_superseded" and payload.get("kind") == "relay":
        title = "Worker answer superseded"
        body = (f"Worker {payload.get('agent_name') or payload['worker_id']}: answer {payload['text']!r} "
                f"was superseded. {payload['reason']}. Check the current question before relaying again.")
    elif event["kind"] in {"worker_state", "worker_start_failed", "checks_overdue"}:
        state = payload.get("state")
        if (state in {"question", "start_failed", "start_interrupted", "ended_without_proof", "done", "lost", "stalled"}
                or event["kind"] == "checks_overdue") and not (
                    state == "lost" and payload.get("reason") == "herdr_lost"):
            title = str(state)
            body = str(payload.get("question_text") or "Question text unavailable") if state == "question" else "\n".join(
                str(value) for value in (payload.get("detail"), payload.get("final_message"), payload.get("reason")) if value)
            body = body or str(state)
            if state == "start_interrupted":
                body += f"\nRun restart {payload.get('agent_name') or payload.get('issue', '?')} after clearing any holds with go."
            if payload.get("url") or payload.get("pr"):
                body += f" — {payload.get('url') or payload['pr']}"
            if payload.get("no_ci"):
                body += " (no CI)"
    if not title:
        return None
    # The CLI exports the resolved repository, so watcher-level notices name it too.
    repo = payload.get("repo_path") or (worker or {}).get("repo_path") or os.environ.get("HERDR_COORD_REPO")
    issue = payload.get("issue", (worker or {}).get("issue"))
    prefix = repo_root.display_name(repo) if repo else ("Issue" if issue is not None else None)
    if prefix and issue is not None:
        title = f"{prefix} #{issue}: {title}"
    elif prefix:
        title = f"{prefix}: {title}"
    routed = registry.event_lanes(event)
    if routed:
        title = f"{', '.join(routed)}: {title}"
    return title, body


def _notify_events(ops):
    """Replay unnotified events after recovery, including across watcher restarts."""
    doc = registry.load()
    cursor = doc.get("notification_seq", 0)
    for event in registry.read_events(cursor, lane=None):
        worker = doc["workers"].get(event["payload"].get("worker_id"))
        notification = _notification(event, worker)
        if notification:
            title, body = notification
            try:
                result = ops.herdr("notification", "show", title, "--body", body, "--sound", "request")
                if not result.ok:
                    return
            except (OSError, TimeoutError):
                return
        registry.update(lambda doc: doc.update(notification_seq=event["seq"]))


def _reopen_records(worker, records):
    action_id = worker.get("reopen_action_id")
    if not action_id:
        return records
    action = registry.load()["actions"].get(action_id, {})
    if action.get("session_id") and action["session_id"] != worker.get("session_id"):
        # The session changed after the reopen, so the whole new transcript postdates it.
        return records
    # A queued reopen has no recorded send yet, so none of its old records count.
    position = action.get("transcript_position", len(records))
    return records[position:]


def _pane_shows_background_shells(worker, ops):
    """The pane's footer line counts background shells that are still running."""
    try:
        screen = actions.visible_text(worker, ops)
    except (OSError, TimeoutError):
        return False  # unreadable is not evidence of live work
    lines = [line.strip() for line in screen.splitlines() if line.strip()]
    if not lines:
        return False
    return any(int(match.group(1)) > 0 for match in _FOOTER_SHELLS.finditer(lines[-1]))


def _entry(worker):
    return (worker.get("entry_command") or "").lstrip("/").rsplit(":", 1)[-1]


def _latest_turn(records):
    """Main-thread records after the latest prompt."""
    main_records = [record for _, record in transcript._main_records(records)]
    # The Esc marker is not a prompt; a prompt queued after it is.
    latest_prompt = max((index for index, record in enumerate(main_records)
                         if (transcript._is_role(record, "user")
                             and transcript._prompt_texts(transcript._message(record))
                             and not transcript._is_interrupt(record))
                         or transcript._is_queued_prompt(record)), default=-1)
    return main_records[latest_prompt + 1:]


def _wait_background(worker, observed, now, state):
    """Mark the worker waiting on its own background work, carrying the turn's final text.

    A worker can end its turn on a question while a background shell still runs. Its final text
    rides on the event so the coordinator can read it now rather than when the wait ends. Each new
    turn gets a fresh state token, so an answer to an earlier question cannot be relayed into a
    later one. A turn already published is not published again: after a relay the transcript can
    lag the send, and re-reading the old turn must not repeat a question the user already answered.
    """
    turn = f"{worker.get('session_id')}:{observed.turn_id}"

    def change(doc, events):
        current = doc["workers"][worker["worker_id"]]
        if current["state"] != state:
            return
        changed = current["state"] != "waiting_background"
        if current.get("background_turn") == turn:
            if changed:
                current.update(state="waiting_background", last_change=now, state_token=uuid.uuid4().hex)
                current.pop("question_text", None)
                current.pop("final_message", None)  # answered; a later stall alert must not repeat it
                events.append(("worker_state", dict(current)))
            return
        current.update(state="waiting_background", last_change=now, state_token=uuid.uuid4().hex,
                       background_turn=turn)
        if observed.final_text:
            current["final_message"] = observed.final_text
        else:
            current.pop("final_message", None)  # an earlier turn's message is not this turn's
        current.pop("question_text", None)
        events.append(("worker_state", dict(current)))

    registry.update_with_events(change)


def _verify(worker, records, ops, now, *, no_closing_record=False):
    # Read the stage from the whole session before trimming: a relay after the worker moved on to
    # ce-work would otherwise hide that it left its document. Once seen, the registry keeps it.
    advanced_stage = worker.get("advanced_stage") or finish.later_stage(
        records, exclude={"ce-plan"} if _entry(worker) == "ce-plan" else (),
    )
    if advanced_stage:
        worker = {**worker, "advanced_stage": advanced_stage}
    records = _reopen_records(worker, records)
    no_closing_record = no_closing_record or (
        worker["state"] == "awaiting_checks" and worker.get("no_closing_record", False)
    )
    if no_closing_record:
        records = _latest_turn(records)
    verify = getattr(ops, "verify_done", finish.verify_done)
    if verify is None:
        verify = finish.verify_done
    result = verify(worker, ops=ops, config=registry.load()["config"], now=now, records=records)
    state = result["state"]
    if state not in {"done", "awaiting_checks", "ended_without_proof"}:
        raise ValueError(f"Unexpected completion state: {state}")
    fields = {key: value for key, value in result.items() if key != "state"}
    fields["no_closing_record"] = no_closing_record
    if advanced_stage:
        fields["advanced_stage"] = advanced_stage
    if state == "ended_without_proof" and no_closing_record:
        dismissed = transcript.dismissed_form_questions(records)
        fields["final_message"] = "\n".join(actions.form_lines(
            dismissed, "The worker's form was dismissed without an answer; the worker waits for input. "
                       "It asked:")) if dismissed else (
            "Final message is missing from the transcript; read it in the worker's pane."
        )

    def record(doc, events):
        current = doc["workers"][worker["worker_id"]]
        if current["state"] != worker["state"]:
            return
        previous_overdue = current.get("overdue", False)
        changed = current["state"] != state
        if changed:
            current.update(state=state, last_change=now, state_token=uuid.uuid4().hex)
        current.update(fields)
        current.pop("question_text", None)
        if changed:
            events.append(("worker_state", dict(current)))
        if state == "awaiting_checks" and result.get("overdue") and not previous_overdue:
            events.append(("checks_overdue", dict(current)))

    registry.update_with_events(record)


def _continue_start(worker, ops, now, keepalive=None):
    worker = registry.load()["workers"][worker["worker_id"]]
    if worker.get("state") != "starting":
        return
    if start._owns_start(worker):
        if not registry.load()["holds"]:
            start._run_worker(worker, ops, **({"keepalive": keepalive} if keepalive else {}))
        return
    owner = worker.get("start_owner")
    if isinstance(owner, dict):
        try:
            if owner == start._process_identity(owner.get("pid")):
                return
        except OSError:
            return  # An inaccessible process is not evidence of a dead owner.

    def interrupt(doc, events):
        current = doc["workers"][worker["worker_id"]]
        if current.get("state") == "starting" and current.get("start_owner") == owner:
            current.update(state="start_interrupted", last_change=now,
                           reason="start owner exited or its recorded process identity is missing or changed")
            events.append(("worker_state", dict(current)))

    registry.update_with_events(interrupt)


def _reconcile_entry(worker, ops, now):
    """Observe a failed entry send without probing terminal agent presence."""
    action_id = worker.get("action_id")
    action = registry.load()["actions"].get(action_id, {})
    if action.get("kind") != "entry" or not (
        action.get("status") == "delivery_unknown" or worker.get("entry_recovery_pending")
    ):
        return worker
    if not worker.get("session_id"):
        # A late session is needed to locate proof, never to declare this worker lost.
        if not worker.get("agent_name"):
            return worker
        try:
            worker = actions.refresh_session(worker, actions.agent_info(worker, ops), now=now)
        except (actions.ActionError, OSError, TimeoutError) as exc:
            _report_problem(worker, exc, kind="technical_problem")
            return worker
    records, _ = _read(worker, ops, now)
    if not transcript.delivered(
        records, after_index=action.get("transcript_position", 0) - 1,
        command_name=action["command_name"], command_args=action["command_args"],
    ):
        return worker
    mode = transcript.permission_mode(records)
    expected_mode = worker.get("permission_mode", start.DEFAULT_PERMISSION_MODE)
    changed = []
    crowded = []

    def recover(doc, events):
        current = doc["workers"][worker["worker_id"]]
        if current["state"] != "start_failed" or current.get("action_id") != action_id:
            return
        entry = doc["actions"][action_id]
        if entry["status"] == "delivery_unknown":
            entry.update(status="delivered", reason=None)
            events.append(("action_delivered", {"action_id": action_id, "worker_id": worker["worker_id"]}))
        current.update(phase="delivered", entry_recovery_pending=True)
        if mode != expected_mode:
            return
        crowded.append(not start._has_slot(doc))
        current.update(state="running", phase="mode_checked", last_change=now,
                       state_token=uuid.uuid4().hex, reason=None,
                       recorded_permission_mode=mode, entry_recovery_pending=False)
        changed.append(dict(current))
        events.append(("worker_state", dict(current)))

    doc = registry.update_with_events(recover)
    current = doc["workers"][worker["worker_id"]]
    if changed:
        if crowded[0]:
            _report_problem(current, "Late entry delivered; no worker slot was free. Worker is running and observed.",
                            kind="technical_problem")
    elif current.get("entry_recovery_pending"):
        _report_problem(current, f"Late entry delivered; permission mode expected {expected_mode}, recorded {mode!r}",
                        kind="technical_problem")
    return current


def _settled_offset(worker):
    """Where the transcript ended when the worker settled; done workers are not read after that.

    The anchor is tied to the state token, so a later settle (after a relay reopen) re-anchors,
    and to the session: a session started after the settle (/clear) postdates it entirely.
    """
    anchor = worker.get("settled_anchor") or {}
    if anchor.get("state_token") != worker.get("state_token"):
        anchor = {"state_token": worker.get("state_token"), "session_id": worker.get("session_id"),
                  "offset": worker.get("transcript_offset", 0)}

        def remember(doc):
            current = doc["workers"][worker["worker_id"]]
            if current.get("state_token") == worker.get("state_token"):
                current["settled_anchor"] = anchor

        registry.update(remember)
    return anchor["offset"] if anchor["session_id"] == worker.get("session_id") else 0


SETTLED_PROBE_SECONDS = 60
_SETTLED_PROBES: dict[tuple[str, str], float] = {}


def _refresh_settled_session(worker, ops, now):
    """Follow a session the pane started after settling; a failed lookup changes nothing here.

    Settled agents may have exited, so the lookup is rare and never marks the worker lost.
    """
    key = (str(registry._home()), worker["worker_id"])
    if now - _SETTLED_PROBES.get(key, float("-inf")) < SETTLED_PROBE_SECONDS:
        return worker
    _SETTLED_PROBES[key] = now
    try:
        result = ops.herdr("agent", "get", worker["agent_name"], timeout=start.COMMAND_TIMEOUT)
    except (OSError, TimeoutError):
        return worker
    agent = (result.data or {}).get("result", {}).get("agent") if result.ok else None
    return actions.refresh_session(worker, agent, now=now) if isinstance(agent, dict) else worker


def _answered_prompt(records):
    """True when a person's prompt is followed by an assistant record before any notice."""
    prompted = False
    for _, record in transcript._main_records(records):
        if transcript._is_role(record, "user") and transcript._prompt_texts(transcript._message(record)):
            # A notice, or a meta record, supersedes an unanswered prompt (e.g. a local /command).
            prompted = (not record.get("isMeta") and not transcript._is_notice(record)
                        and not transcript._is_interrupt(record))
        elif transcript._is_queued_prompt(record):
            prompted = True
        elif prompted and transcript._is_role(record, "assistant"):
            return True
    return False


def _reopen_if_in_use(worker, ops, now):
    """A settled worker that took up a new prompt from its pane is in use again: back to running."""
    # The guard is the state this poll started from; a refreshed record may already carry a
    # concurrent cleanup or relay transition, which must win.
    settled_state, settled_token = worker["state"], worker.get("state_token")
    if worker.get("agent_name"):
        worker = _refresh_settled_session(worker, ops, now)
    if (worker["state"], worker.get("state_token")) != (settled_state, settled_token):
        return
    offset = _settled_offset(worker)
    _read(worker, ops, now)
    current = registry.load()["workers"][worker["worker_id"]]
    if ((current["state"], current.get("state_token")) != (settled_state, settled_token)
            or not current.get("transcript_path") or current.get("transcript_offset", 0) <= offset):
        return
    try:
        records, _ = transcript.read_records(Path(current["transcript_path"]), offset)
    except OSError:
        return
    if _answered_prompt(records):
        actions.change_worker(worker["worker_id"], "running", now=now, expected=settled_state,
                              expected_token=settled_token,
                              reason="new prompt typed in the pane")


def _poll_worker(worker, ops, now, keepalive=None):
    if worker["state"] == "start_failed":
        worker = _reconcile_entry(worker, ops, now)
    if worker["state"] in TERMINAL_STATES:
        # Other action receipts can still reconcile from the recorded transcript.
        if worker.get("pending_action_id"):
            if worker["state"] in REOPENABLE_STATES and worker.get("session_id"):
                _settled_offset(worker)  # anchor before this read moves the offset
            records, _ = _read(worker, ops, now)
            pending = actions.reconcile_action(worker["pending_action_id"], ops=ops, records=records)
            if pending["status"] == "delivery_unknown":
                actions.settle_moot_nudge(worker["pending_action_id"], records)
        if worker["state"] in REOPENABLE_STATES and worker.get("session_id"):
            _reopen_if_in_use(registry.load()["workers"][worker["worker_id"]], ops, now)
        return
    if worker["state"] == "start_interrupted":
        return  # Only an explicit restart may claim this start.
    if worker["state"] == "starting" and not worker.get("pending_action_id"):
        _continue_start(worker, ops, now, keepalive)
        return
    if worker.get("agent_name"):
        absent = False
        try:
            result = ops.herdr("agent", "get", worker["agent_name"], timeout=start.COMMAND_TIMEOUT)
            if not result.ok:
                absent = finish._missing(result, "agent")
                raise actions.ActionError(f"{result.error_code}: {result.error_message or result.stderr}")
            agent = (result.data or {}).get("result", {}).get("agent")
            if not isinstance(agent, dict):
                raise actions.ActionError("herdr returned no agent object")
        except (actions.ActionError, OSError, TimeoutError) as exc:
            failures = []

            def fail(doc):
                current = doc["workers"][worker["worker_id"]]
                if current["state"] == worker["state"]:
                    current["agent_get_failures"] = current.get("agent_get_failures", 0) + 1
                    failures.append(current["agent_get_failures"])

            registry.update(fail)
            if failures:
                if (absent and worker["state"] != "starting") or failures[0] >= 3:
                    actions.change_worker(worker["worker_id"], "lost", now=now,
                                          expected=worker["state"], reason=str(exc))
                else:
                    _report_problem(worker, exc, kind="technical_problem")
            return
        if worker.get("agent_get_failures"):
            def reset(doc):
                current = doc["workers"][worker["worker_id"]]
                if current["state"] == worker["state"]:
                    current.pop("agent_get_failures", None)
                    current.pop("watch_problem", None)
            registry.update(reset)
        worker = actions.refresh_session(worker, agent, now=now)
    else:
        agent = {}
    state = worker["state"]
    inactive = state in {"lost", "done", "awaiting_merge", "start_failed", "relay_pending", "queued"}
    if inactive and not worker.get("pending_action_id"):
        return
    records, growth = _read(worker, ops, now)
    worker = registry.load()["workers"][worker["worker_id"]]
    pending_id = worker.get("pending_action_id")
    delivery_unknown = False
    if pending_id:
        pending = actions.reconcile_action(pending_id, ops=ops, records=records)
        if pending["status"] == "delivery_unknown":
            pending = actions.settle_moot_nudge(pending_id, records)
        if (pending["status"] == "delivery_unknown" and pending.get("transport") == "dismiss"
                and now - pending.get("created_at", now) < DISMISS_SETTLE_SECONDS):
            # Between its Esc and its prompt the turn reads as interrupted; judging it now would
            # report the worker ended while the relay is still typing the answer.
            return
        delivery_unknown = pending["status"] == "delivery_unknown"
        if delivery_unknown:
            actions.report_delivery_unknown(pending_id)
        elif state == "starting" and pending["status"] in {"delivered", "confirmed"}:
            actions.change_worker(worker["worker_id"], "running", now=now, expected=state, reason=None)
    if state == "starting" or inactive:
        return
    # An ended worker is observed for new pane input, but never followed up automatically.
    if state == "ended_without_proof" and not growth:
        return
    if state == "awaiting_checks":
        _verify(worker, records, ops, now)
        return
    observed = transcript.classify(
        records, herdr_status=actions.agent_status(agent), now=now,
        last_growth_at=worker.get("last_growth_at", now),
        stall_after_seconds=registry.load()["config"].get("stall_after_seconds", 1200),
        expired_background=frozenset(worker.get("expired_background", ())),
    )
    if observed.state == "unknown":
        return
    if (observed.state in {"turn_finished", "waiting_background"}
            and worker.get("reopen_action_id") and not any(
                transcript._is_role(record, "user")
                and transcript._prompt_texts(transcript._message(record))
                and not transcript._is_notice(record)
                for _, record in transcript._main_records(_reopen_records(worker, records)))):
        actions.change_worker(worker["worker_id"], "running", now=now, expected=state)
        return
    if (state == "waiting_background" and not growth
            and observed.state in {"running", "stalled", "turn_finished"}
            and now - worker.get("last_growth_at", now) >= transcript.BACKGROUND_WAIT_TIMEOUT_SECONDS
            and now - worker.get("last_growth_at", now) < BACKGROUND_LIVE_MAX_SECONDS
            and _pane_shows_background_shells(worker, ops)):
        return  # a long background job (a build, a test run) is still running in the pane
    if state == "waiting_background" and not growth and observed.state in {"running", "stalled"}:
        # herdr shows a finished pane as idle once it has been viewed, which reads as running, then
        # stalled. Without growth the turn is still over: keep the background wait, then verify at
        # its timeout; never treat it as a stall to nudge.
        if now - worker.get("last_growth_at", now) < transcript.BACKGROUND_WAIT_TIMEOUT_SECONDS:
            return
        if observed.state == "stalled":
            observed = transcript.Classification("turn_finished", detail=transcript.NO_CLOSING_RECORD)
    if observed.state == "turn_finished":
        stale = transcript.open_background_tasks(records) - set(worker.get("expired_background", ()))
        if stale:
            # The wait timed out: remember these launches so later turns are not held by them.
            expired = sorted(set(worker.get("expired_background", ())) | stale)
            registry.update(lambda doc: doc["workers"][worker["worker_id"]].update(expired_background=expired))
        # After an interrupt the turn has no final message of its own; judge only records after the
        # latest prompt, or an earlier turn's final (say, naming an artifact) would be reused.
        _verify(worker, records, ops, now,
                no_closing_record=observed.detail in (transcript.NO_CLOSING_RECORD, transcript.INTERRUPTED))
    elif observed.state == "waiting_background":
        _wait_background(worker, observed, now, state)
    elif observed.state == "question":
        if state != "question":
            text = actions.question_text(worker, ops, records)
            actions.change_worker(worker["worker_id"], "question", now=now, expected=state, question_text=text)
    elif observed.state == "quota_wait":
        # The index distinguishes separate 429s even when their wording/reset is identical.
        index = max(i for i, r in enumerate(records)
                    if not r.get("isSidechain") and r.get("isApiErrorMessage") and r.get("apiErrorStatus") == 429)
        action_id = f"quota:{worker['worker_id']}:{worker.get('session_id')}:{index}"
        actions.change_worker(worker["worker_id"], "quota_wait", now=now, expected=state,
                              resets_at=observed.resets_at, quota_action_id=action_id)
        if (not delivery_unknown and observed.resets_at is not None
                and now >= observed.resets_at and not registry.load()["holds"]):
            actions.resume(worker["worker_id"], ops=ops, action_id=action_id)
    elif observed.state == "stalled":
        if registry.load()["holds"] or state == "ended_without_proof":
            return
        if state == "question":
            # The form is no longer open (classify would say question); leave the question
            # state first. A nudge can only follow on a later poll, never into a form.
            actions.change_worker(worker["worker_id"], "running", now=now, expected=state)
            return
        if delivery_unknown:
            actions.change_worker(worker["worker_id"], "stalled", now=now, expected=state,
                                  detail="Pending action delivery is unknown; automatic nudge blocked")
        else:
            recorded = registry.load()["actions"]
            action_id = f"stall:{worker['worker_id']}:{worker.get('session_id')}"
            previous = worker.get("stall_nudge_action")
            if previous in recorded or action_id in recorded:
                registry.update(lambda doc: doc["workers"][worker["worker_id"]].update(
                    stall_nudge_action=previous if previous in recorded else action_id))
                actions.change_worker(worker["worker_id"], "stalled", now=now, expected=state,
                                      detail="Second stall after the recorded nudge")
            else:
                actions.nudge(worker["worker_id"], ops=ops, action_id=action_id)
                if action_id in registry.load()["actions"]:
                    registry.update(lambda doc: doc["workers"][worker["worker_id"]].update(
                        stall_nudge_action=action_id, last_growth_at=now))
    else:
        # Leaving a question is an ordinary running transition, without notification.
        next_state = "running" if state == "question" else observed.state
        actions.change_worker(worker["worker_id"], next_state, now=now, expected=state)


def _drain(ops, keepalive=None):
    if registry.load()["holds"]:
        return
    for worker in list(registry.load()["workers"].values()):
        if worker["state"] != "relay_pending":
            continue
        if registry.load()["holds"] or not start._has_slot(registry.load()):
            return
        pending = registry.load()["actions"].get(worker.get("pending_action_id"), {})
        if pending.get("status") == "delivery_unknown":
            # This relay waits on the user (delivery_unknown was reported); queued issues must not
            # wait behind it indefinitely, so skip it rather than stop draining.
            continue
        request = worker["relay_request"]
        if keepalive:
            keepalive()
        try:
            result = actions.relay(worker["worker_id"], request["text"], state_token=request["state_token"],
                                   ops=ops, action_id=request["action_id"])
        except actions.ActionError as exc:
            _report_problem(worker, exc, kind="send_refused")
            return  # Preserve relay priority; a queued issue cannot take its slot.
        if result.get("state") == "relay_pending":
            return
    while True:
        doc = registry.load()
        if doc["holds"] or not start._has_slot(doc):
            break
        if keepalive:
            keepalive()
        if start.start_next_queued(ops=ops, **({"keepalive": keepalive} if keepalive else {})) is None:
            break


_QUIET_UNDER_HOLD = {"delivery_unknown", "send_refused"}


def _report_problem(worker, exc, *, kind="delivery_unknown"):
    if kind in _QUIET_UNDER_HOLD and registry.load()["holds"]:
        return

    def report(doc, events):
        current = doc["workers"][worker["worker_id"]]
        if kind in _QUIET_UNDER_HOLD and doc["holds"]:
            return
        if current.get("watch_problem") != str(exc):
            current["watch_problem"] = str(exc)
            events.append((kind, {"worker_id": worker["worker_id"], "detail": str(exc)}))

    registry.update_with_events(report)


def _check_unattended(now):
    doc = registry.load()
    cursor = min(lane["ack_seq"] for lane in doc["lanes"].values())
    pending = registry.read_events(cursor, lane=None)

    def check(doc, events):
        for name, lane in doc["lanes"].items():
            unhandled = any(event["seq"] > lane["ack_seq"] and name in (registry.event_lanes(event) or ())
                            and event["payload"].get("worker_id") for event in pending)
            if not unhandled or follower_alive(name, lane.get("follow_lease"), now=now):
                lane.update(unattended_since=None, last_alert_at=None)
                continue
            if lane.get("unattended_since") is None:
                lane["unattended_since"] = now
            if now - lane["unattended_since"] >= 15 * 60 and (
                    lane.get("last_alert_at") is None or now - lane["last_alert_at"] >= 60 * 60):
                lane["last_alert_at"] = now
                events.append(("lane_unattended", {"lane": name, "ts": now}))

    registry.update_with_events(check)


def poll_once(*, ops=adapters, now, keepalive=None):
    before = registry.load()["event_seq"]
    try:
        reachable = ops.herdr_reachable()
    except (OSError, TimeoutError):
        reachable = False
    if not reachable:
        doc = registry.update(lambda doc: doc.update(herdr_failures=doc.get("herdr_failures", 0) + 1))
        if doc["herdr_failures"] >= 3:
            _herdr_lost(now)
        _check_unattended(now)
        _notify_events(ops)
        return registry.read_events(before, lane=None)
    if registry.load().get("herdr_failures"):
        registry.update(lambda doc: doc.pop("herdr_failures", None))
    for worker in list(registry.load()["workers"].values()):
        if keepalive:
            keepalive()
        try:
            _poll_worker(worker, ops, now, keepalive)
        except actions.ActionError as exc:
            # A hold or state change racing a poll is a refusal, not watcher death. Nothing was sent:
            # a send that fails part-way records its own delivery_unknown action instead.
            _report_problem(worker, exc, kind="send_refused")
        except (AttributeError, KeyError, TypeError, ValueError, IndexError) as exc:
            # One worker's unexpected transcript data must not stop watching every other worker.
            # Other failures still end the iteration, as before.
            _report_problem(worker, f"{type(exc).__name__}: {exc}", kind="technical_problem")
    _drain(ops, keepalive)
    if keepalive:
        keepalive()
    _check_unattended(now)
    _notify_events(ops)
    return registry.read_events(before, lane=None)


def run(*, ops=adapters, poll_seconds=15):
    if poll_seconds <= 0:
        raise ValueError("poll_seconds must be positive")
    with watcher_lock() as acquired:
        if not acquired:
            return 0
        failures = 0
        keepalive = lambda: heartbeat(now=time.time(), poll=poll_seconds)
        try:
            while True:
                try:
                    now = time.time()
                    heartbeat(now=now, poll=poll_seconds)
                    poll_once(ops=ops, now=now, keepalive=keepalive)
                    failures = 0
                except Exception as exc:
                    failures += 1
                    try:
                        with (registry._home() / "watcher.log").open("a", encoding="utf-8") as log:
                            traceback.print_exc(file=log)
                    except OSError:
                        traceback.print_exc()
                    try:
                        registry.append_event("technical_problem", {
                            "pid": os.getpid(), "detail": str(exc), "failed_iterations": failures,
                        })
                    except Exception:
                        traceback.print_exc()
                    if failures >= 5:
                        try:
                            registry.append_event("watcher_exit", {"pid": os.getpid(), "detail": str(exc)})
                            _notify_events(ops)
                        except Exception:
                            traceback.print_exc()
                        return 1
                time.sleep(poll_seconds)
        except KeyboardInterrupt:
            return 0


def _watcher_lost(now):
    def hold(doc, events):
        if "watcher_lost" not in doc["holds"]:
            doc["holds"]["watcher_lost"] = {"ts": now}
            events.append(("watcher_lost", {"detail": "Watcher heartbeat stale or OS lock free", "ts": now}))

    registry.update_with_events(hold)


def _compact_line(event, *, lane="main"):
    payload = event["payload"]
    summary = {"seq": event["seq"], "kind": event["kind"], "lane": lane}
    for key in ("issue", "state", "agent_name", "worker_id", "state_token", "url", "pr", "no_ci", "overdue"):
        if key in payload:
            summary[key] = payload[key]
    if event["kind"] == "worker_handoff":
        summary.update(from_lane=payload["from_lane"], to_lane=payload["to_lane"], detail=True)
    elif event["kind"] == "lane_unattended":
        summary.update(target_lane=payload["lane"], detail=True)
    if any(key in payload for key in ("question_text", "final_message", "detail", "reason")):
        summary["detail"] = True
    line = json.dumps(summary, ensure_ascii=False, separators=(",", ":"))
    # Long names/URLs can exceed the monitor budget even without prose. The
    # event command retains the complete values; shorten only this display.
    while len(line) >= 399:
        # A shortened state_token would make the coordinator's relay fail.
        candidates = [key for key, value in summary.items()
                      if isinstance(value, str) and len(value) > 1 and key not in {"kind", "state_token", "lane"}]
        if not candidates:
            # Always terminate: fall back to the minimum the coordinator needs.
            minimal = {"seq": event["seq"], "kind": event["kind"], "lane": lane, "detail": True}
            return json.dumps(minimal, ensure_ascii=False, separators=(",", ":"))
        key = max(candidates, key=lambda key: len(summary[key]))
        value = summary[key]
        summary[key] = value[:max(0, len(value) - (len(line) - 398) - 1)] + "…"
        # A shortened value must be read in full with `event <seq>`.
        summary["detail"] = True
        line = json.dumps(summary, ensure_ascii=False, separators=(",", ":"))
    return line


def follow(*, interval=5, compact=False, quiet=False, lane="main", context=None):
    if interval <= 0:
        raise ValueError("interval must be positive")
    parent_pid = os.getppid()
    try:
        parent = start._process_identity(parent_pid)
    except OSError:
        parent = None  # unreadable: run without the check rather than refuse
    else:
        if parent is None:
            # Already gone (Windows never reparents), so nobody reads this: take no lease.
            print(json.dumps({"state": "stopped",
                              "detail": "follow's launching process already exited; lease not taken"}), flush=True)
            return 0
    cursor = registry.load()["lanes"][lane]["ack_seq"]
    lease = None
    last_beat = None
    reported_loss = False
    reported_slow = False
    reported_hung = False
    try:
        while True:
            now = time.time()
            try:
                if lease is None:
                    try:
                        lease = _claim_follow(lane, now=now, context=context)
                    except ValueError as exc:
                        print(json.dumps({"state": "refused", "detail": str(exc)}), flush=True)
                        return 1
                    last_beat = now
                elif registry.load()["lanes"][lane].get("follow_lease") != lease:
                    return 1
                if now - last_beat >= 30:
                    try:
                        refreshed = _refresh_follow(lane, lease, now=now)
                    except ValueError as exc:
                        print(json.dumps({"state": "stopped", "detail": str(exc)}), flush=True)
                        return 1
                    if not refreshed:
                        return 1
                    last_beat = now
                if parent is not None and not lanes.claim_owner_alive(parent):
                    try:
                        print(json.dumps({"state": "stopped",
                                          "detail": "follow's launching process exited; lease released"}), flush=True)
                    except OSError:
                        pass
                    return 0
                if watcher_alive(now=now):
                    reported_loss = False
                    if watcher_slow(now=now):
                        if not reported_slow:
                            registry.append_event("watcher_slow", {"ts": now, "detail": "Heartbeat stale while watcher OS lock is held; poll is slow."})
                            reported_slow = True
                        try:
                            data = json.loads((registry._home() / "heartbeat.json").read_text(encoding="utf-8"))
                            hung = now - float(data["ts"]) > 600
                        except (OSError, ValueError, TypeError, KeyError):
                            hung = False
                        if hung and not reported_hung:
                            pid = data.get("pid") or "unknown"
                            registry.append_event("watcher_hung", {"ts": now, "pid": pid,
                                "detail": f"Watcher pid {pid} has held its OS lock with no heartbeat for more than 10 minutes."})
                            reported_hung = True
                    else:
                        reported_slow = False
                        reported_hung = False
                elif not reported_loss:
                    _watcher_lost(now)
                    reported_loss = True
                    reported_slow = False
                    reported_hung = False
                cursor = max(cursor, registry.load()["lanes"][lane]["ack_seq"])
                for event in registry.read_events(cursor, lane=lane):
                    # A background wait is routine unless the turn ended with text, which may be a question.
                    if not (quiet and event["kind"] == "worker_state"
                            and event["payload"].get("state") in {"running", "in_tool", "waiting_background"}
                            and not (event["payload"].get("state") == "waiting_background"
                                     and event["payload"].get("final_message"))):
                        try:
                            print(_compact_line(event, lane=lane) if compact else json.dumps(event, ensure_ascii=False), flush=True)
                        except OSError:
                            return 1
                    cursor = event["seq"]
            except TimeoutError:
                pass  # Contention delays the event or its replay until the next interval.
            time.sleep(min(interval, 30))
    except KeyboardInterrupt:
        return 0
    finally:
        if lease is not None:
            _release_follow(lane, lease)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if sys.argv[1:] != ["run"]:
        raise SystemExit("Usage: watch.py run")
    raise SystemExit(run())
