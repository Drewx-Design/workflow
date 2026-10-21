"""Durable worker sends. An existing action is reconciled, never sent again."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

import adapters
import lanes
import registry
import start
import transcript


NUDGE_TEXT = "Please continue the current task and report any blocker."
RESUME_TEXT = "Please resume the current task."


class ActionError(ValueError):
    """A refused action; no worker message was sent."""


class _CommandRejected(ActionError):
    """herdr explicitly rejected a command; that step was not applied."""


class _NotSent(_CommandRejected):
    """A later step of the action was never attempted; earlier ones may have been applied."""


_AWAIT_DISMISSAL = object()
DISMISS_TIMEOUT = 15.0


def worker_named(name, doc=None):
    doc = registry.load() if doc is None else doc
    matches = [w for key, w in doc["workers"].items()
               if name in (key, w.get("agent_name"))]
    if len(matches) != 1:
        raise ActionError(f"Expected one registered worker named {name!r}")
    return matches[0]


def projects_root(ops):
    return Path(getattr(ops, "projects_root", start.PROJECTS_ROOT))


def records_for(worker, ops):
    path = transcript.find_transcript(worker.get("session_id"), projects_root(ops))
    return transcript.read_records(path)[0] if path else []


def change_worker(worker_id, state, *, now=None, expected=None, expected_token=None, **fields):
    """One state change, one event, with no nested registry locks."""
    timestamp = time.time() if now is None else now

    def change(doc, events):
        worker = doc["workers"][worker_id]
        if expected is not None and worker["state"] != expected:
            return
        if expected_token is not None and worker.get("state_token") != expected_token:
            return
        changed = worker["state"] != state
        if changed:
            worker.update(state=state, last_change=timestamp, state_token=uuid.uuid4().hex)
        worker.update(fields)
        if state != "question":
            worker.pop("question_text", None)
        if changed:
            events.append(("worker_state", dict(worker)))

    doc = registry.update_with_events(change)
    return doc["workers"][worker_id]


def _call(ops, *args, timeout=None):
    result = ops.herdr(*args, timeout=start.COMMAND_TIMEOUT if timeout is None else timeout)
    if not result.ok:
        reason = f"{result.error_code}: {result.error_message or result.stderr}"
        # These codes come from the adapter, rather than a herdr rejection.
        if ((result.error_code and result.error_code not in {"timeout", "command_not_found", "command_failed"})
                or _legacy_rejection(reason)):
            raise _CommandRejected(reason)
        raise ActionError(reason)
    return result


def _legacy_rejection(reason):
    prefix = "command_failed: "
    if not isinstance(reason, str) or not reason.startswith(prefix):
        return False
    try:
        payload = json.loads(reason[len(prefix):])
    except ValueError:
        return False
    error = payload.get("error") if isinstance(payload, dict) else None
    return isinstance(error, dict) and bool(error.get("code"))


def agent_info(worker, ops, *, timeout=None):
    result = _call(ops, "agent", "get", worker["agent_name"], timeout=timeout)
    agent = (result.data or {}).get("result", {}).get("agent")
    if not isinstance(agent, dict):
        raise ActionError("herdr returned no agent object")
    return agent


def agent_status(agent):
    """Read herdr's current state field, with legacy payload compatibility."""
    return agent.get("agent_status", agent.get("status", "unknown"))


def visible_text(worker, ops, default=""):
    result = ops.herdr("agent", "read", worker["agent_name"], "--source", "visible",
                       timeout=start.COMMAND_TIMEOUT)
    if not result.ok:
        return default
    text = result.stdout
    # herdr 0.9.0 prints the pane directly; retain legacy JSON compatibility.
    payload = result.data.get("result") if isinstance(result.data, dict) else None
    if isinstance(payload, dict) and "text" in payload:
        text = payload["text"]
    return (text.rstrip() or default) if isinstance(text, str) else default


def question_text(worker, ops, records, default="Question text unavailable"):
    """The open form from the transcript first, then the pane as herdr shows it.

    The pane often starts with earlier output (such as a message the coordinator sent), which
    reads like the question itself; the form's own wording leads so the coordinator sees it first.
    """
    screen = visible_text(worker, ops, default="")
    form = transcript.open_form_questions(records)
    if not form:
        return screen or default
    lines = form_lines(form, "Form (from the worker's transcript):")
    if screen:
        lines += ["", "Worker screen (lines above the form can be earlier output):", screen]
    return "\n".join(lines)


def form_lines(form, title):
    lines = [title]
    for question in form:
        header = question.get("header")
        lines.append(f"[{header}] {question.get('question')}" if header else str(question.get("question")))
        if question.get("multiSelect"):
            lines.append("(multi-select)")
        options = question.get("options")
        for number, option in enumerate(options if isinstance(options, list) else [], 1):
            if isinstance(option, dict):
                description = option.get("description")
                lines.append(f"  {number}. {option.get('label')}" + (f": {description}" if description else ""))
    return lines


def refresh_session(worker, agent, *, now=None, lane=None):
    session = (agent.get("agent_session") or {}).get("value")
    ids = {key: agent[key] for key in ("workspace_id", "pane_id")
           if isinstance(agent.get(key), str) and agent[key]}
    if (not isinstance(session, str) or not session or session == worker.get("session_id")) and all(
            worker.get(key) == value for key, value in ids.items()):
        return worker
    def refresh(doc, events):
        current = doc["workers"][worker["worker_id"]]
        lanes.check_worker_lane(current, lane, error=ActionError)
        current.update(ids)
        if not isinstance(session, str) or not session or current.get("session_id") == session:
            return
        history = current.setdefault("session_history", [])
        for value in (current.get("session_id"), session):
            if value and (not history or history[-1] != value):
                history.append(value)
        current.update(session_id=session, transcript_offset=0, transcript_path=None,
                       last_growth_at=time.time() if now is None else now)
        pending_id = current.get("pending_action_id")
        pending = doc["actions"].get(pending_id, {})
        if pending.get("status") == "delivery_unknown" and pending.get("session_id") != session:
            pending.update(status="superseded", reason="Worker session rotated before delivery confirmation")
            current.pop("pending_action_id")
            if current.get("relay_request", {}).get("action_id") == pending_id:
                current.pop("relay_request")
            events.append(("action_superseded", {"action_id": pending_id,
                           "worker_id": worker["worker_id"], "agent_name": current.get("agent_name"),
                           # Entry and resume actions carry no text; never fail the rotation over it.
                           "kind": pending.get("kind"), "text": pending.get("text"), "session_id": session,
                           "previous_session_id": pending.get("session_id"), "reason": pending["reason"]}))
        events.append(("session_changed", {"worker_id": worker["worker_id"], "session_id": session,
                                          "session_history": list(history)}))

    doc = registry.update_with_events(refresh)
    if not isinstance(session, str) or not session or session == worker.get("session_id"):
        # Refreshing ids must not adopt a concurrent question's state token during preflight.
        return {**worker, **ids}
    return doc["workers"][worker["worker_id"]]


_PASTED = re.compile(r"<pasted_content\b[^>]*>\s*(.*?)(?:</pasted_content\b[^>]*>|$)", re.DOTALL)


_PASTED_BLOCK = re.compile(r"<pasted_content\b[^>]*>\s*(.*?)</pasted_content\b[^>]*>", re.DOTALL)


def _prompt_matches(content, text):
    """A typed prompt matches exactly; a long one arrives wrapped in <pasted_content>."""
    if content == text:
        return True
    # The paste must be the whole prompt, not text quoted inside a longer one.
    pasted = _PASTED.fullmatch(content.strip())
    if pasted is not None and pasted.group(1).strip() == text.strip():
        return True
    # the user's unsent draft in the pane goes out ahead of the paste (norm-308, 2026-10-09);
    # the paste lands at the cursor, so it closes the prompt. Text after it is a quote.
    # Try each opening tag, since the relay text itself may mention one.
    tail = content.rstrip()
    start = tail.rfind("<pasted_content")
    while start != -1:
        trailing = _PASTED_BLOCK.fullmatch(tail[start:])
        if trailing is not None and trailing.group(1).strip() == text.strip():
            return True
        start = tail.rfind("<pasted_content", 0, start)
    return False


# A typed relay behind an unsent draft is recognised by its ending. A short ending ("yes", "1")
# also ends unrelated prompts ("...eyes"), so a short relay counts only when the prompt was written
# within seconds of the send; the live #2458 prompt landed 0.6 s after it.
DRAFT_SUFFIX_MIN = 12
DRAFT_SEND_WINDOW = 30


def _typed_behind_draft(texts, text, *, record, sent_at):
    """The user's unsent draft went out ahead of a typed relay (live, 2026-10-20), so the
    prompt is draft + relay with no separator. Typed text lands at the cursor, closing the prompt."""
    wanted = text.strip()
    if not wanted or not any(candidate.rstrip().endswith(wanted) and not candidate.lstrip().startswith("<")
                             for candidate in texts):
        return False
    if len(wanted) >= DRAFT_SUFFIX_MIN:
        return True
    written = _record_time(record)
    return (written is not None and isinstance(sent_at, (int, float))
            and 0 <= written - sent_at <= DRAFT_SEND_WINDOW)


def _record_time(record):
    try:
        return datetime.fromisoformat(str(record["timestamp"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def _confirmed(action, records):
    position = action["transcript_position"]
    if action.get("transport") != "form":
        first_prompt = True
        for record in records[position:]:
            message = record.get("message", {})
            if transcript._is_queued_prompt(record):
                # A prompt typed while the worker was busy is held as an attachment.
                texts = [record["attachment"]["prompt"]]
                if any(_prompt_matches(candidate, action["text"]) for candidate in texts):
                    return True
                if first_prompt and _typed_behind_draft(texts, action["text"], record=record,
                                                        sent_at=action.get("created_at")):
                    return True
                first_prompt = False
                continue
            # A compaction summary can quote an earlier relay; it never delivers one.
            if record.get("isSidechain") or record.get("isCompactSummary") or message.get("role") != "user":
                continue
            content = message.get("content")
            if isinstance(content, str):
                texts = [content]
            elif isinstance(content, list) and not any(b.get("type") == "tool_result" for b in content):
                texts = [b["text"] for b in content if b.get("type") == "text" and isinstance(b.get("text"), str)]
            else:
                continue
            if any(_prompt_matches(candidate, action["text"]) for candidate in texts):
                return True
            if record.get("isMeta") or transcript._is_notice(record) or not texts:
                continue  # a command expansion or background notice is nobody's typed prompt
            # Only the prompt the send produced can carry the draft; a later one is the user's own.
            if first_prompt and _typed_behind_draft(texts, action["text"], record=record,
                                                    sent_at=action.get("created_at")):
                return True
            first_prompt = False
        return False
    return _form_answered(action, records, start=position)


def _form_answered(action, records, start=0):
    # Claude Code 2.1.293 writes the AskUserQuestion when it is asked, which is
    # usually before the relay's recorded position, so collect questions from the
    # whole transcript but accept only answers recorded after the send.
    questions = {}
    for record_index, record in enumerate(records):
        if record.get("isSidechain"):
            continue
        message = record.get("message", {})
        content = message.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("name") == "AskUserQuestion":
                tool_input = block.get("input")
                questions[block.get("id")] = tool_input.get("questions", []) if isinstance(tool_input, dict) else []
            if message.get("role") != "user" or block.get("type") != "tool_result" or record_index < start:
                continue
            # A declined form records toolUseResult as a plain string, not a dict.
            result = record.get("toolUseResult")
            answers = result.get("answers") if isinstance(result, dict) else None
            answers = answers if isinstance(answers, dict) else {}
            for question in questions.get(block.get("tool_use_id"), []):
                if not isinstance(question, dict):
                    continue
                answer = action["text"]
                if answer.isdigit():
                    options = question.get("options", [])
                    index = int(answer) - 1
                    if not 0 <= index < len(options) or not isinstance(options[index], dict):
                        continue
                    answer = options[index].get("label")
                title = question.get("question")
                if answers.get(title) == answer or f'"{title}"="{answer}"' in str(block.get("content", "")):
                    return True
    return False


def reconcile_action(action_id, *, ops=adapters, records=None, lane=None):
    action = registry.load()["actions"][action_id]
    if action["status"] in {"superseded", "not_sent", "failed"}:
        return action
    if action["status"] == "delivery_unknown" and _legacy_rejection(action.get("reason")):
        return _failed(action_id, action["reason"], legacy=True, lane=lane)
    worker = registry.load()["workers"][action["worker_id"]]
    if action["status"] not in {"delivered", "confirmed"}:
        if action.get("session_id") != worker.get("session_id"):
            return action
        records = records_for(worker, ops) if records is None else records
    if action["status"] in {"delivered", "confirmed"} or _confirmed(action, records):
        def confirm(doc, events):
            current = doc["actions"][action_id]
            current_worker = doc["workers"][action["worker_id"]]
            lanes.check_worker_lane(current_worker, lane, error=ActionError)
            if current["status"] in {"superseded", "not_sent", "failed"}:
                return
            if current["status"] not in {"delivered", "confirmed"}:
                current.update(status="delivered", reason=None)
                events.append(("action_delivered", {"action_id": action_id, "worker_id": worker["worker_id"]}))
            if current_worker.get("pending_action_id") == action_id:
                current_worker.pop("pending_action_id")

        registry.update_with_events(confirm)
    return registry.load()["actions"][action_id]


def settle_moot_nudge(action_id, records):
    """Drop an unconfirmed nudge once the worker has carried on without it.

    A nudge only asks a quiet worker to continue. When the worker has written a main-thread
    reply since the send, the nudge is moot whether or not it landed, and keeping it pending
    blocks every later send to that worker (and, behind a pending relay, the repository's queue).
    A late arrival of the generic nudge text is harmless, except into an open form, where it
    could become an answer: while a form is open the nudge stays unknown. Other kinds stay
    unknown: a relay carries the user's words and must never be sent twice.
    """
    action = registry.load()["actions"][action_id]
    if action["status"] != "delivery_unknown" or action.get("kind") != "nudge":
        return action
    position = action.get("transcript_position", len(records))
    replied = any(index >= position and transcript._is_role(record, "assistant")
                  and not record.get("isApiErrorMessage")  # a synthetic API error is not a reply
                  for index, record in transcript._main_records(records))
    if not replied or transcript.open_form_questions(records):
        return action

    def settle(doc, events):
        current = doc["actions"][action_id]
        worker = doc["workers"][current["worker_id"]]
        if current["status"] != "delivery_unknown" or current.get("session_id") != worker.get("session_id"):
            return
        current.update(status="superseded", reason="Worker continued without it; the nudge is no longer needed")
        if worker.get("pending_action_id") == action_id:
            worker.pop("pending_action_id")
        # Non-alerting: notifications go out only for a superseded relay.
        events.append(("action_superseded", {"action_id": action_id, "worker_id": worker["worker_id"],
                                             "agent_name": worker.get("agent_name"), "kind": "nudge",
                                             "text": current.get("text"), "session_id": current.get("session_id"),
                                             "reason": current["reason"]}))

    registry.update_with_events(settle)
    return registry.load()["actions"][action_id]


def _existing(action_id, worker, kind, text, ops, *, lane=None):
    action = registry.load()["actions"].get(action_id)
    if action is None:
        return None
    if (action["worker_id"], action["kind"], action["text"]) != (worker["worker_id"], kind, text):
        raise ActionError("Action id already belongs to a different request")
    if (kind == "relay" and worker["state"] in {"question", "ended_without_proof", "relay_pending"}
            and (action.get("state_token") != worker.get("state_token")
                 or action.get("session_id") != worker.get("session_id"))):
        raise ActionError("Stale relay replay: the worker's question or state has changed")
    return reconcile_action(action_id, ops=ops, lane=lane)


def _raise_if_held(doc):
    if doc["holds"]:
        raise ActionError("Workers are held; the user must run go first")


def _assert_no_hold():
    _raise_if_held(registry.load())


def _prepare(worker, kind, text, action_id, records, *, transport="prompt", reserve=False, lane=None):
    action = {"id": action_id, "worker_id": worker["worker_id"], "kind": kind,
              "text": text, "session_id": worker.get("session_id"),
              "state_token": worker.get("state_token"),
              "transcript_position": len(records), "transport": transport,
              "status": "delivery_unknown", "steps_sent": [], "created_at": time.time()}
    claimed = []
    def prepare(doc, events):
        current = doc["workers"][worker["worker_id"]]
        lanes.check_worker_lane(current, lane, error=ActionError)
        if action_id in doc["actions"]:
            return
        _raise_if_held(doc)
        if (current["state"] != worker["state"]
                or current.get("state_token") != worker.get("state_token")
                or current.get("session_id") != worker.get("session_id")):
            raise ActionError("Worker state changed before the action was recorded")
        if reserve and not start._has_slot(doc):
            if kind == "relay":
                if current["state"] != "relay_pending":
                    current.update(state="relay_pending", last_change=time.time())
                    events.append(("worker_state", dict(current)))
                return
            raise ActionError("No worker slot is free")
        if current.get("pending_action_id"):
            pending = doc["actions"].get(current["pending_action_id"], {})
            if pending.get("status") == "delivery_unknown":
                raise ActionError("Previous action delivery is unknown; it will not be retried")
        doc["actions"][action_id] = action
        current["pending_action_id"] = action_id
        events.append(("action_recorded", action))
        if reserve:
            current.update(state="starting", last_change=time.time(), state_token=uuid.uuid4().hex)
            events.append(("worker_state", dict(current)))
        claimed.append(True)

    registry.update_with_events(prepare)
    return bool(claimed)


def _step(action_id, ops, *args):
    # Persist even intermediate key presses before attempting them. A crash or
    # timeout leaves the whole action unknown, never an automatically retryable send.
    def record_send(doc):
        _raise_if_held(doc)
        if doc["actions"][action_id]["status"] != "delivery_unknown":
            raise ActionError("Action is no longer pending; it will not be sent")
        doc["actions"][action_id].update(last_send=list(args))

    registry.update(record_send)
    result = _call(ops, *args)
    registry.update(lambda doc: doc["actions"][action_id].setdefault("steps_sent", []).append(args[-1]))
    return result


def report_delivery_unknown(action_id):
    def report(doc, events):
        action = doc["actions"][action_id]
        if action["status"] != "delivery_unknown" or action.get("delivery_unknown_reported"):
            return
        worker = doc["workers"][action["worker_id"]]
        detail = (f"Worker {worker.get('agent_name') or action['worker_id']}: "
                  f"{action['kind']} delivery unknown. "
                  f"{action.get('reason') or 'Awaiting transcript confirmation (no automatic retry)'}")
        action["delivery_unknown_reported"] = True
        events.append(("delivery_unknown", {"action_id": action_id, "worker_id": action["worker_id"],
                                           "kind": action["kind"], "detail": detail}))

    registry.update_with_events(report)


def _failed(action_id, reason, *, legacy=False, lane=None):
    def fail(doc, events):
        action = doc["actions"][action_id]
        worker = doc["workers"][action["worker_id"]]
        lanes.check_worker_lane(worker, lane, error=ActionError)
        if action["status"] != "delivery_unknown":
            return
        steps_sent = None if legacy else action.get("steps_sent", [])
        partial = None if steps_sent is None else bool(steps_sent)
        action.update(status="failed", reason=str(reason), steps_sent=steps_sent)
        if worker.get("pending_action_id") == action_id:
            worker.pop("pending_action_id")
        detail = (f"Worker {worker.get('agent_name') or action['worker_id']}: "
                  f"{action['kind']} action {action_id} delivery failed. {reason}")
        if partial is None:
            detail += " Earlier steps may already have been applied; check the pane before relaying again."
        elif partial:
            detail += " Earlier steps were already applied; check the pane before relaying again."
        else:
            detail += " No earlier steps were applied."
        events.append(("delivery_failed", {"action_id": action_id, "worker_id": action["worker_id"],
                                          "agent_name": worker.get("agent_name"), "kind": action["kind"],
                                          "reason": str(reason), "steps_sent": steps_sent,
                                          "partial": partial, "detail": detail}))

    registry.update_with_events(fail)
    return registry.load()["actions"][action_id]


def _unknown(action_id, exc):
    if isinstance(exc, _CommandRejected):
        return _failed(action_id, exc)
    def record(doc):
        action = doc["actions"][action_id]
        if action["status"] == "delivery_unknown":
            action["reason"] = str(exc)

    registry.update(record)
    report_delivery_unknown(action_id)
    return registry.load()["actions"][action_id]


def _await_dismissal(worker, ops):
    """After Esc, wait for herdr to stop showing the worker as blocked on its form."""
    deadline = time.monotonic() + DISMISS_TIMEOUT
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _NotSent("Esc was sent, but the form did not close in time; the answer was not sent")
        try:
            agent = agent_info(worker, ops, timeout=remaining)
        except (ActionError, OSError, TimeoutError) as exc:
            raise _NotSent(f"Esc was sent, but the worker could not be read afterwards ({exc}); "
                           "the answer was not sent") from exc
        session = (agent.get("agent_session") or {}).get("value")
        if session != worker.get("session_id"):
            # The answer belongs to the question in the old session; never type it into another.
            raise _NotSent("Esc was sent, but the worker's session changed or could not be read; "
                           "the answer was not sent")
        if time.monotonic() > deadline:
            raise _NotSent("Esc was sent, but the form did not close in time; the answer was not sent")
        if agent_status(agent) != "blocked":
            return
        time.sleep(min(start.POLL_INTERVAL, max(deadline - time.monotonic(), 0)))


def _send(worker, kind, text, *, ops, action_id=None, reserve=False, form=False, dismiss=False, lane=None):
    action_id = action_id or uuid.uuid4().hex
    existing = _existing(action_id, worker, kind, text, ops, lane=lane)
    if existing is not None:
        return existing
    _assert_no_hold()
    agent = agent_info(worker, ops)
    if not form and agent_status(agent) == "blocked":
        raise ActionError("A blocked worker needs a question relay")
    steps = [("agent", "prompt", worker["agent_name"], text)]
    if form and dismiss:
        if agent_status(agent) != "blocked":
            raise ActionError("Question form is no longer blocked; refresh worker state")
        # One recorded action: Esc closes the form, then the answer goes in as a prompt.
        steps = [("agent", "send-keys", worker["agent_name"], "esc"), _AWAIT_DISMISSAL,
                 ("agent", "prompt", worker["agent_name"], text)]
    elif form:
        if agent_status(agent) != "blocked":
            raise ActionError("Question form is no longer blocked; refresh worker state")
        steps = [("agent", "send-keys", worker["agent_name"], text),
                 ("agent", "send-keys", worker["agent_name"], "enter")]
        # Claude Code 2.1.295 writes the form to the transcript only once answered, so the
        # screen is the only view of an open form. Unreadable means unknown: send nothing.
        try:
            screen = visible_text(worker, ops)
        except (OSError, TimeoutError):
            screen = ""
        if not screen:
            raise ActionError("Cannot read the form from the worker's pane, so nothing was sent; try again")
        _refuse_compound_screen(screen)
        if not text.isdigit():
            if not worker.get("pane_id"):
                raise ActionError("Question form free-text relay requires a worker pane_id")
            # The live form is at the bottom of the pane; an older menu can sit above it.
            options = list(re.finditer(r"(?im)^\s*[>❯]?\s*(\d+)[.)]\s*(?:Type something|Other|Type your answer|Free.text)\b", screen))
            option = options[-1] if options else None
            if option is None:
                raise ActionError("Cannot identify the form's free-text option")
            steps[0] = ("agent", "send-keys", worker["agent_name"], option.group(1))
    worker = refresh_session(worker, agent, lane=lane)
    if form and not dismiss and not text.isdigit():
        steps.insert(1, ("pane", "send-text", worker["pane_id"], text))
    records = records_for(worker, ops)
    pending = registry.load()["actions"].get(worker.get("pending_action_id"), {})
    if isinstance(pending.get("text"), str):
        # Confirm a delivered-but-unconfirmed prompt now, rather than refusing on a stale status.
        # Textless actions (entry, legacy resume) are left to the watcher.
        reconcile_action(worker["pending_action_id"], ops=ops, records=records, lane=lane)
    if form and not dismiss:
        _refuse_compound_form(records)  # re-check on the records this send is recorded against
    transport = "dismiss" if dismiss else "form" if form else "prompt"
    if not _prepare(worker, kind, text, action_id, records, transport=transport, reserve=reserve, lane=lane):
        if action_id not in registry.load()["actions"]:
            return {"id": action_id, "state": "relay_pending", "text": text}
        return reconcile_action(action_id, ops=ops, lane=lane)
    try:
        for step in steps:
            if step is _AWAIT_DISMISSAL:
                _await_dismissal(worker, ops)
            else:
                _step(action_id, ops, *step)
        change_worker(worker["worker_id"], "running", last_growth_at=time.time(), reason=None)
        action = reconcile_action(action_id, ops=ops, lane=lane)
        if action["status"] == "delivery_unknown":
            return _unknown(action_id, "Send returned; awaiting transcript confirmation (no automatic retry)")
        return action
    except (ActionError, OSError, TimeoutError) as exc:
        return _unknown(action_id, exc)


def nudge(name, *, ops=adapters, action_id=None, lane=None):
    worker = worker_named(name)
    lanes.check_worker_lane(worker, lane, error=ActionError)
    existing = _existing(action_id, worker, "nudge", NUDGE_TEXT, ops, lane=lane)
    if existing is not None:
        return existing
    if worker["state"] not in {"running", "stalled"}:
        raise ActionError(f"Cannot nudge a {worker['state']} worker")
    return _send(worker, "nudge", NUDGE_TEXT, ops=ops, action_id=action_id, lane=lane)


def resume(name, *, ops=adapters, action_id=None, lane=None):
    worker = worker_named(name)
    lanes.check_worker_lane(worker, lane, error=ActionError)
    existing = _existing(action_id, worker, "resume", RESUME_TEXT, ops, lane=lane)
    if existing is not None:
        return existing
    if worker["state"] == "quota_wait":
        return _send(worker, "resume", RESUME_TEXT, ops=ops, action_id=action_id, lane=lane)
    if worker["state"] != "lost" or not worker.get("session_id"):
        raise ActionError("Resume requires a lost worker with a session, or a quota wait")
    action_id = action_id or uuid.uuid4().hex
    if not _prepare(worker, "resume", RESUME_TEXT, action_id, records_for(worker, ops), reserve=True, lane=lane):
        return reconcile_action(action_id, ops=ops, lane=lane)
    try:
        config = registry.load()["config"]
        _step(action_id, ops, "agent", "start", worker["agent_name"], "--kind", "claude",
              "--pane", worker["pane_id"], "--", "--resume", worker["session_id"],
              "--model", start.AGENT_MODEL, "--permission-mode", config.get("permission_mode", start.DEFAULT_PERMISSION_MODE))
        deadline = time.monotonic() + start.SESSION_TIMEOUT
        while True:
            agent = agent_info(worker, ops)
            session = (agent.get("agent_session") or {}).get("value")
            if session and transcript.find_transcript(session, projects_root(ops)):
                # This in-flight resume owns the new session; bind it before the
                # rotation releases unknown actions belonging to the old session.
                registry.update(lambda doc: doc["actions"][action_id].update(session_id=session))
                worker = refresh_session(worker, agent, lane=lane)
                break
            if time.monotonic() >= deadline:
                raise ActionError("Resume session could not be confirmed")
            time.sleep(start.POLL_INTERVAL)
        baseline = len(records_for(worker, ops))
        registry.update(lambda doc: doc["actions"][action_id].update(
            session_id=worker["session_id"], transcript_position=baseline))
        if agent_status(agent) == "blocked":
            def not_sent(doc):
                doc["actions"][action_id].update(
                    status="not_sent", reason="Resumed worker is asking a question; no prompt sent")
                current = doc["workers"][worker["worker_id"]]
                if current.get("pending_action_id") == action_id:
                    current.pop("pending_action_id")

            registry.update(not_sent)
            try:
                text = question_text(worker, ops, records_for(worker, ops))
            except (ActionError, OSError, TimeoutError):
                text = "Question text unavailable"
            change_worker(worker["worker_id"], "question", question_text=text)
            return {**registry.load()["actions"][action_id], "state": "question"}
        _step(action_id, ops, "agent", "prompt", worker["agent_name"], RESUME_TEXT)
        change_worker(worker["worker_id"], "running", last_growth_at=time.time(), reason=None)
        action = reconcile_action(action_id, ops=ops, lane=lane)
        return action if action["status"] == "delivered" else _unknown(action_id, "Resume delivery awaits transcript confirmation")
    except (ActionError, OSError, TimeoutError) as exc:
        # Keep the reserved slot: the relaunch may have succeeded despite timeout.
        return _unknown(action_id, exc)


# Producer capture: tests/fixtures/herdr-agent-read-tabbed-form.txt (norm-308, 2026-10-09).
_TAB_BAR = re.compile(r"(?m)^\s*←.*\bSubmit\b.*→\s*$")
_CHECKBOX = re.compile(r"(?m)^\s*[>❯]?\s*\d+[.)]\s*\[[ ✔xX]\]")


def _live_form(screen):
    """The open form is drawn between the pane's last two full-width rules; older output sits above."""
    lines = screen.splitlines()
    rules = [index for index, line in enumerate(lines) if len(line.strip()) >= 20 and set(line.strip()) == {"─"}]
    # Without two rules the form's extent is unknown, so check the whole pane (refusing errs safe).
    return "\n".join(lines[rules[-2]:]) if len(rules) >= 2 else screen


def _refuse_compound_screen(screen):
    """The pane shows a tab bar (several questions) or checkboxes (multi-select)."""
    form = _live_form(screen)
    kinds = [name for name, pattern in (("several question tabs", _TAB_BAR),
                                        ("multi-select checkboxes", _CHECKBOX)) if pattern.search(form)]
    if kinds:
        raise ActionError(
            f"The worker's form shows {' and '.join(kinds)}. A relay sends one key and would answer "
            "only the focused tab, so nothing was sent. Relay again with --dismiss-form to close the "
            "form and send the answer as a prompt."
        )


def _refuse_compound_form(records):
    """A relay sends one option key, which answers only the focused tab of a form."""
    questions = transcript.open_form_questions(records)
    multi = [q.get("header") or q.get("question") for q in questions if q.get("multiSelect")]
    if len(questions) > 1 or multi:
        headers = ", ".join(str(q.get("header") or q.get("question")) for q in questions)
        detail = f"; multi-select: {', '.join(map(str, multi))}" if multi else ""
        raise ActionError(
            f"This form has {len(questions)} question(s) ({headers}){detail}. A relay sends one key and "
            "would answer only the focused tab, so nothing was sent. Relay again with --dismiss-form to "
            "close the form and send the answer as a prompt."
        )


def relay(name, text, *, state_token, ops=adapters, action_id=None, dismiss_form=False, lane=None):
    doc = registry.load()
    worker = worker_named(name, doc)
    lanes.check_worker_lane(worker, lane, error=ActionError)
    if not text:
        raise ActionError("Relay text must not be empty")
    if not isinstance(state_token, str) or not state_token:
        raise ActionError("Relay state token must not be empty")
    if (worker["state"] in {"question", "ended_without_proof", "relay_pending", "waiting_background", "done", "awaiting_merge"}
            and state_token != worker.get("state_token")):
        raise ActionError("Stale relay replay: the worker's question or state has changed")
    recorded = doc["actions"].get(action_id)
    if recorded is not None:
        if recorded.get("state_token") != state_token:
            raise ActionError("Action id already belongs to a different request")
    else:
        # The token identifies the question even after delivery changes worker state.
        for action in doc["actions"].values():
            if (action.get("kind") == "relay"
                    and (action["worker_id"], action["text"], action.get("state_token")) == (
                        worker["worker_id"], text, state_token)):
                action_id = action["id"]
                break
        else:
            request = worker.get("relay_request", {})
            if (request.get("state_token"), request.get("text")) == (state_token, text):
                action_id = request["action_id"]
    existing = _existing(action_id, worker, "relay", text, ops, lane=lane)
    if existing is not None:
        return existing
    if dismiss_form and worker["state"] != "question":
        raise ActionError(f"Only an open question form can be dismissed; the worker is {worker['state']}")
    if worker["state"] == "question" and not dismiss_form:
        _refuse_compound_form(records_for(worker, ops))
    # A waiting_background worker is idle at its prompt while its own background work runs.
    # A done or awaiting_merge worker can be reopened with a follow-up; like ended_without_proof
    # it needs a free slot (or waits as relay_pending) and returns to running, so cleanup skips it.
    if worker["state"] not in {"question", "ended_without_proof", "relay_pending", "waiting_background", "done", "awaiting_merge"}:
        raise ActionError(f"Cannot relay to a {worker['state']} worker")
    _assert_no_hold()
    action_id = action_id or uuid.uuid4().hex
    def remember(doc, events):
        nonlocal action_id
        current = doc["workers"][worker["worker_id"]]
        lanes.check_worker_lane(current, lane, error=ActionError)
        if (doc["holds"] or current["state"] != worker["state"]
                or current.get("state_token") != worker.get("state_token")):
            raise ActionError("Worker state or holds changed before relay")
        previous = current.get("relay_request")
        if previous and (previous["state_token"], previous["text"]) == (state_token, text):
            action_id = previous["action_id"]
        if (previous and previous["action_id"] == action_id
                and previous["state_token"] != current.get("state_token")):
            raise ActionError("Stale relay replay: the worker's question or state has changed")
        if current["state"] == "relay_pending" and previous and previous["action_id"] != action_id:
            raise ActionError("A relay is already waiting for a slot")
        if current["state"] in {"done", "awaiting_merge"}:
            # GitHub reports createdAt in whole seconds; floor and allow one second of slack.
            current.update(reopened_at=float(int(time.time()) - 1), reopen_action_id=action_id)
        current["relay_request"] = {"action_id": action_id, "text": text, "state_token": current.get("state_token")}
        # question and waiting_background workers already hold their slot.
        if current["state"] not in {"question", "waiting_background"} and not start._has_slot(doc):
            if current["state"] != "relay_pending":
                current.update(state="relay_pending", last_change=time.time())
                events.append(("worker_state", dict(current)))

    doc = registry.update_with_events(remember)
    worker = doc["workers"][worker["worker_id"]]
    if worker["state"] == "relay_pending" and not start._has_slot(doc):
        return {"id": action_id, "state": "relay_pending", "text": text}
    return _send(worker, "relay", text, ops=ops, action_id=action_id,
                 reserve=worker["state"] not in {"question", "waiting_background"},
                 form=worker["state"] == "question", dismiss=dismiss_form, lane=lane)


def _handoff_ready(doc, worker):
    if worker.get("state") in {"cleaning", "cleaned"} or worker.get("cleanup_from"):
        raise ActionError("Worker has a cleanup claim or is already cleaned")
    # Only a start in progress acts on the worker; a failed or interrupted start's owner (often
    # the long-lived watcher) stays alive but no longer runs its phases.
    if worker.get("state") == "starting" and lanes.claim_owner_alive(worker.get("start_owner")):
        raise ActionError("Worker start is still in progress; handoff refused")
    for key in ("action_id", "pending_action_id"):
        pending = doc["actions"].get(worker.get(key), {})
        if pending.get("status") == "delivery_unknown":
            raise ActionError("Previous action delivery is unknown; handoff refused")
    request = worker.get("relay_request")
    if request and doc["actions"].get(request.get("action_id"), {}).get("status") not in {
            "delivered", "confirmed", "failed", "superseded"}:
        raise ActionError("Worker has a relay_request; handoff refused")


def handoff(name, target, *, lane="main", ops=adapters):
    """Claim a worker across its idempotent workspace rename and locked lane commit."""
    snapshot = lanes.read_snapshot(caller_pane_id=os.environ.get("HERDR_PANE_ID"), ops=ops)
    session_names = lanes.claude_session_names()
    claim = {"owner": start._start_owner(), "target": target}
    claimed = []
    warnings = []
    target_details = {}

    def claim_handoff(doc):
        current = worker_named(name, doc)
        lanes.check_worker_lane(current, lane, error=ActionError)
        if target not in doc["lanes"]:
            raise ActionError(f"Unknown lane: {target}")
        if target == lane:
            raise ActionError(f"Worker is already in the same lane: {lane}")
        _handoff_ready(doc, current)
        if snapshot is not None:
            owner = next((binding for binding in doc["tab_bindings"].values()
                          if binding["lane"] == target and lanes.owner_live(binding["controller"], snapshot)), None)
            if owner is None:
                warnings.append(f"target lane {target} has no live coordinator; its unattended alert will fire")
            elif owner.get("contact"):
                target_details["target_contact"] = owner["contact"]
                current_name = lanes.contact_stale(owner, session_names)
                if current_name is not None:
                    target_details["target_contact_stale"] = current_name
        current["handoff_claim"] = claim
        claimed.append(dict(current))

    registry.update(claim_handoff)
    worker = claimed[0]
    worker_id = worker["worker_id"]

    def release_handoff(doc):
        current = doc["workers"][worker_id]
        if current.get("handoff_claim") == claim:
            current.pop("handoff_claim")

    def commit_handoff(doc, events):
        current = doc["workers"][worker_id]
        if current.get("lane", "main") != lane:
            raise ActionError(f"Worker {name} is owned by lane {current.get('lane', 'main')}")
        if current.get("handoff_claim") != claim:
            raise ActionError("Worker handoff claim changed before commit")
        if target not in doc["lanes"]:
            raise ActionError(f"Unknown lane: {target}")
        _handoff_ready(doc, current)
        current["lane"] = target
        current.pop("handoff_claim")
        events.append(("worker_handoff", {**current, "from_lane": lane, "to_lane": target}))

    restore_label = False
    try:
        # Our live claim excludes other user mutations while KTD9 refreshes herdr ids.
        agent = agent_info(worker, ops)
        workspace_id = agent.get("workspace_id")
        if not isinstance(workspace_id, str) or not workspace_id.strip():
            raise ActionError("herdr returned no current workspace id to rename")
        worker = refresh_session(worker, agent)
        source_label = lanes.workspace_label(worker["repo_path"], lane, worker["issue"])
        target_label = lanes.workspace_label(worker["repo_path"], target, worker["issue"])
        workspace = lanes._workspace(ops, workspace_id)
        # A failed rename reply can still mean herdr applied it. An already-renamed workspace
        # from an earlier crash also needs restoring if this attempt cannot commit.
        restore_label = True
        if workspace["label"] != target_label:
            _call(ops, "workspace", "rename", workspace_id, target_label)
        registry.update_with_events(commit_handoff)
    except Exception as exc:
        # The commit is journaled before the registry replace, so a failure after that point is
        # still a committed handoff: keep the target label rather than undo half of it.
        try:
            committed = registry.load()["workers"][worker_id].get("lane") == target
        except (OSError, ValueError):
            committed = False
        if committed:
            registry.update(release_handoff)
            return {"state": "handed_off", "worker_id": worker_id, "from_lane": lane,
                    "to_lane": target, "workspace_label": target_label, **target_details,
                    "warning": "; ".join([str(exc), *warnings])}
        rollback_error = None
        try:
            if restore_label:
                _call(ops, "workspace", "rename", workspace_id, source_label)
        except Exception as rollback:
            rollback_error = str(rollback)
        finally:
            registry.update(release_handoff)
        detail = str(exc)
        if rollback_error:
            detail += (f"; could not restore source label {source_label!r} from target label "
                       f"{target_label!r}: {rollback_error}")
        raise ActionError(detail) from exc
    result = {"state": "handed_off", "worker_id": worker_id, "from_lane": lane,
              "to_lane": target, "workspace_label": target_label, **target_details}
    if warnings:
        result["warning"] = "; ".join(warnings)
    return result


def go(*, ops=adapters):
    cleared = {}

    def clear(doc, events):
        cleared.update(doc["holds"])
        doc["holds"].clear()
        if cleared:
            events.append(("holds_cleared", {"cleared": cleared}))

    registry.update_with_events(clear)
    return {"cleared": cleared}
