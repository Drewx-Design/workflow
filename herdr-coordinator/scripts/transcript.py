"""Discover and interpret main-thread Claude Code JSONL transcripts."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path


NO_CLOSING_RECORD = "no closing record"
INTERRUPTED = "The user interrupted the turn; the worker waits for input"
BACKGROUND_WAIT_TIMEOUT_SECONDS = 60 * 60
# A worker usually takes up a background notice within seconds; one left this long was not taken up.
NOTICE_GRACE_SECONDS = 60


@dataclass(frozen=True)
class Classification:
    state: str
    resets_at: float | None = None
    detail: str = ""


def find_transcript(session_id: str | None, projects_root: str | Path) -> Path | None:
    """Find an exact filename one directory below projects_root, without recursion."""
    if not session_id or "/" in session_id or "\\" in session_id:
        return None
    root = Path(projects_root)
    if not root.is_dir():
        return None
    filename = f"{session_id}.jsonl"
    for folder in root.iterdir():
        if folder.is_dir():
            for candidate in folder.iterdir():
                if candidate.name == filename and candidate.is_file():
                    return candidate
    return None


def read_records(path: str | Path, offset: int = 0) -> tuple[list[dict], int]:
    """Read complete lines from a byte offset; log the count of malformed lines.

    The returned offset includes skipped lines, but excludes an unfinished final
    line. Callers can append the returned records and resume at that offset.
    """
    records = []
    malformed = 0
    with Path(path).open("rb") as handle:
        handle.seek(offset)
        while True:
            start = handle.tell()
            line = handle.readline()
            if not line.endswith(b"\n"):
                offset = start
                break
            offset = handle.tell()
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                malformed += 1
                continue
            if isinstance(record, dict):
                records.append(record)
            else:
                malformed += 1
    if malformed:
        logging.getLogger(__name__).warning(
            "Skipped %d malformed transcript line(s) in %s", malformed, path
        )
    return records, offset


def _main_records(records):
    for index, record in enumerate(records):
        # A compaction (even one while idle, seen live 2026-10-15) writes its summary as a user
        # record after the turn ended; it is nobody's prompt, so it never opens a turn.
        if (isinstance(record, dict) and record.get("isSidechain", False) is False
                and record.get("isCompactSummary") is not True):
            yield index, record


def _message(record: dict) -> dict:
    message = record.get("message")
    return message if isinstance(message, dict) else {}


def _is_role(record, role):
    return record.get("type") == role and _message(record).get("role") == role


def _blocks(message: dict) -> list[dict]:
    content = message.get("content")
    if isinstance(content, list):
        return [block for block in content if isinstance(block, dict)]
    return []


def _prompt_texts(message):
    content = message.get("content")
    return [content] if isinstance(content, str) else [
        block["text"] for block in _blocks(message)
        if block.get("type") == "text" and isinstance(block.get("text"), str)
    ]


def open_background_tasks(records: list[dict]) -> set[str]:
    """Return main-thread launch tool-use ids without a later terminal notice."""
    tool_uses = {}
    opened: set[str] = set()
    agent_ids: dict[str, str] = {}
    for _, record in _main_records(records):
        message = _message(record)
        if _is_role(record, "assistant"):
            for block in _blocks(message):
                tool_id = block.get("id")
                if (block.get("type") == "tool_use" and block.get("name") in {"Bash", "Agent"}
                        and isinstance(tool_id, str) and tool_id):
                    tool_uses[tool_id] = block
        elif _is_role(record, "user"):
            for result in _blocks(message):
                tool_id = result.get("tool_use_id")
                tool = tool_uses.get(tool_id) if isinstance(tool_id, str) else None
                if result.get("type") != "tool_result" or tool is None:
                    continue
                tool_input = tool.get("input")
                background = isinstance(tool_input, dict) and tool_input.get("run_in_background") is True
                for text in _prompt_texts(result):
                    if (
                        tool["name"] == "Bash" and (
                            background and text.startswith("Command running in background with ID: ")
                            or re.match(r"Command did not complete within [^\n]*? moved to the background \(ID: [^)]+\)", text)
                        )
                        or tool["name"] == "Agent" and text.startswith("Async agent launched successfully.")
                    ):
                        opened.add(tool_id)
                        agent = re.search(r"agentId: (\w+)", text)
                        if tool["name"] == "Agent" and agent is not None:
                            agent_ids[agent.group(1)] = tool_id
        # While the worker is busy, Claude Code delivers notices as queued_command attachments.
        attachment = record.get("attachment") if record.get("type") == "attachment" else None
        queued = ([attachment["prompt"]] if isinstance(attachment, dict)
                  and attachment.get("type") == "queued_command"
                  and isinstance(attachment.get("prompt"), str) else [])
        if _is_role(record, "user") or queued:
            for text in queued or _prompt_texts(message):
                for notice in re.finditer(r"<task-notification>(.*?)</task-notification>", text, re.DOTALL):
                    tool_id = re.search(r"<tool-use-id>(.*?)</tool-use-id>", notice.group(1), re.DOTALL)
                    status = re.search(r"<status>(.*?)</status>", notice.group(1), re.DOTALL)
                    if (tool_id is not None and status is not None
                            and status.group(1).strip() in {"completed", "failed", "killed", "stopped"}):
                        opened.discard(tool_id.group(1).strip())
                # A finished subagent's report can arrive only as a hand-back message.
                for handback in re.finditer(r'<agent-message from="(\w+)"', text):
                    if handback.group(1) in agent_ids:
                        opened.discard(agent_ids[handback.group(1)])
    return opened


_NOTICE = re.compile(r"\s*(?:<task-notification>.*?</task-notification>\s*)+", re.DOTALL)


_INTERRUPTS = {"[Request interrupted by user]", "[Request interrupted by user for tool use]"}


def _is_interrupt(record) -> bool:
    """Claude Code's own marker after Esc. It ends the turn; text after it would be a prompt."""
    if not _is_role(record, "user"):
        return False
    texts = _prompt_texts(_message(record))
    return bool(texts) and all(text.strip() in _INTERRUPTS for text in texts)


def _is_queued_prompt(record) -> bool:
    """A prompt typed while the worker was busy, held as a queued_command attachment.

    Notices and subagent hand-backs queue the same way; they carry isMeta or a non-prompt mode.
    """
    attachment = record.get("attachment")
    return (record.get("type") == "attachment" and isinstance(attachment, dict)
            and attachment.get("type") == "queued_command"
            and attachment.get("commandMode") == "prompt" and not attachment.get("isMeta")
            and isinstance(attachment.get("prompt"), str) and bool(attachment["prompt"].strip()))


def _is_notice(record) -> bool:
    """A user record carrying only background notices, not a prompt from a person."""
    if not _is_role(record, "user"):
        return False
    texts = _prompt_texts(_message(record))
    return bool(texts) and all(
        _NOTICE.fullmatch(text)
        or (text.lstrip().startswith("Another Claude session sent a message:")
            and re.search(r'<agent-message from="\w+"', text) is not None)
        for text in texts
    )


def open_form_questions(records: list[dict]) -> list[dict]:
    """Questions of the latest main-thread AskUserQuestion that has no answer recorded yet."""
    forms: dict[str, list] = {}
    for _, record in _main_records(records):
        for block in _blocks(_message(record)):
            if block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                tool_input = block.get("input")
                questions = tool_input.get("questions") if isinstance(tool_input, dict) else None
                forms[block.get("id")] = [q for q in questions if isinstance(q, dict)] if isinstance(questions, list) else []
            elif block.get("type") == "tool_result":
                forms.pop(block.get("tool_use_id"), None)
    return list(forms.values())[-1] if forms else []


def _drop_untaken_notices(records):
    """Drop trailing notice records the worker never took up (no assistant record after them)."""
    end = len(records)
    for index in range(len(records) - 1, -1, -1):
        record = records[index]
        if record.get("isSidechain", False) is not False or record.get("isCompactSummary") is True:
            continue
        if _is_role(record, "assistant"):
            break
        if _is_role(record, "user"):
            if not _is_notice(record):
                break
            end = index
    return records[:end] + [r for r in records[end:] if not _is_role(r, "user") and not _is_role(r, "assistant")]


def classify(
    records: list[dict],
    *,
    herdr_status: str,
    now: float,
    last_growth_at: float,
    stall_after_seconds: float = 1200,
    expired_background: frozenset = frozenset(),
) -> Classification:
    """Classify accumulated records in file order, using epoch seconds for time.

    Tool results are user-role records, but do not begin a new prompt. A pending
    question is an open main-thread AskUserQuestion, or herdr's blocked status
    during an unfinished turn.
    """
    all_records = records
    if herdr_status in ("idle", "done") and now - last_growth_at >= NOTICE_GRACE_SECONDS:
        # The pane is at rest and quiet, so a trailing background notice was not taken up as a turn.
        records = _drop_untaken_notices(records)
    latest = None
    latest_prompt = -1
    latest_end_turn = -1
    pending_tools: set[str] = set()
    # Claude Code 2.1.293 writes AskUserQuestion when it is asked, before the answer.
    open_asks: set[str] = set()
    quota_record = None

    for index, record in _main_records(records):
        message = _message(record)
        blocks = _blocks(message)
        if _is_role(record, "assistant"):
            latest = ("assistant", record)
            pending_tools.clear()
            open_asks.update(
                block["id"] for block in blocks
                if block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion"
                and isinstance(block.get("id"), str) and block["id"]
            )
            if record.get("isApiErrorMessage"):
                if record.get("apiErrorStatus") == 429:
                    quota_record = record
            else:
                quota_record = None
                if message.get("stop_reason") == "end_turn":
                    latest_end_turn = index
                if message.get("stop_reason") == "tool_use":
                    pending_tools.update(
                        block["id"]
                        for block in blocks
                        if block.get("type") == "tool_use"
                        and isinstance(block.get("id"), str)
                        and block["id"]
                    )
        elif _is_interrupt(record):
            # the user pressed Esc (norm-308, 2026-10-09): the turn is over and the pane waits for them.
            latest = ("interrupt", record)
            quota_record = None
            pending_tools.clear()
            open_asks.clear()
        elif _is_queued_prompt(record) and latest is not None and latest[0] == "interrupt":
            # A prompt queued right after Esc starts the next turn. Elsewhere a queued prompt waits
            # behind the live turn, which keeps its tool, question or background state.
            latest = ("user", record)
            latest_prompt = index
        elif _is_role(record, "user"):
            is_prompt = bool(_prompt_texts(message))
            results = [block for block in blocks if block.get("type") == "tool_result"]
            if not is_prompt and not results:
                continue
            latest = ("user" if is_prompt else "tool_result", record)
            quota_record = None
            if is_prompt:
                latest_prompt = index
                pending_tools.clear()
                # A background notice does not answer or dismiss an open form.
                if not _is_notice(record):
                    open_asks.clear()
            for result in results:
                tool_id = result.get("tool_use_id")
                if isinstance(tool_id, str):
                    pending_tools.discard(tool_id)
                    open_asks.discard(tool_id)

    if latest is None:
        return Classification("unknown", detail="no main-thread state records")
    if quota_record is not None:
        quota = quota_record.get("quotaLimits")
        resets_at = quota.get("resetsAt") if isinstance(quota, dict) else None
        if isinstance(resets_at, bool) or not isinstance(resets_at, (int, float)):
            resets_at = None
        return Classification("quota_wait", resets_at, "API quota or rate limit (429)")
    if open_asks:
        return Classification("question", detail="AskUserQuestion has no answer yet")
    if herdr_status == "blocked" and latest_prompt > latest_end_turn:
        return Classification("question", detail="herdr blocked during an unfinished turn")
    if pending_tools:
        return Classification("in_tool", detail="tool use has no matching result")

    kind, record = latest
    message = _message(record)
    finished_detail = None
    if (
        kind == "assistant"
        and not record.get("isApiErrorMessage")
        and message.get("stop_reason") == "end_turn"
        and latest_prompt >= 0
    ):
        finished_detail = "assistant ended the latest prompt"
    elif kind == "interrupt" and latest_prompt >= 0:
        finished_detail = INTERRUPTED
    elif (
        kind in ("user", "tool_result")
        and latest_prompt >= 0
        and herdr_status == "done"
        and now - last_growth_at >= 120
    ):
        finished_detail = NO_CLOSING_RECORD
    if finished_detail is not None:
        # Launches whose notice never came stay expired, so they cannot re-arm the wait every turn.
        # Dropped notices still close the tasks they report.
        open_tasks = open_background_tasks(all_records) - set(expired_background)
        if now - last_growth_at < BACKGROUND_WAIT_TIMEOUT_SECONDS and open_tasks:
            return Classification("waiting_background", detail="turn ended with open background work")
        return Classification("turn_finished", detail=finished_detail)
    if (
        kind in ("user", "tool_result")
        # Only a positively idle agent can be stalled; "unknown" (e.g. a long
        # hook) must never trigger a nudge into a working session.
        and herdr_status in ("idle", "done")
        and now - last_growth_at >= stall_after_seconds
    ):
        return Classification("stalled", detail="no assistant follow-up or transcript growth")
    return Classification("running", detail=f"latest state record: {kind}")


def delivered(
    records: list[dict],
    *,
    after_index: int,
    command_name: str | None = None,
    command_args: str | None = None,
    marker: str | None = None,
) -> bool:
    """Match a main-thread prompt strictly after the given zero-based index.

    Command names may include their leading slash. Arguments match exactly;
    omitted arguments mean an empty argument string. Pasted commands match their
    short name and arguments at the start of the pasted block. Markers match prompt text
    only, including text blocks, and never match tool-result content.
    """
    for index, record in _main_records(records):
        message = _message(record)
        if index <= after_index or not _is_role(record, "user"):
            continue
        blocks = _blocks(message)
        if any(block.get("type") == "tool_result" for block in blocks):
            continue
        for text in _prompt_texts(message):
            if marker and marker in text:
                return True
            if command_name:
                name = re.search(r"<command-name>(.*?)</command-name>", text, re.DOTALL)
                args = re.search(r"<command-args>(.*?)</command-args>", text, re.DOTALL)
                if (
                    name is not None
                    and args is not None
                    and name.group(1) == "/" + command_name.lstrip("/")
                    and args.group(1) == (command_args if command_args is not None else "")
                ):
                    return True
                short_name = command_name.lstrip("/").rsplit(":", 1)[-1]
                typed_text = f"/{short_name}" + (f" {command_args}" if command_args else "")
                for pasted in re.finditer(
                    # Claude Code repeats the id in the closing tag: </pasted_content id="31b8">.
                    r"<pasted_content\b[^>]*>\s*(.*?)(?:</pasted_content\b[^>]*>|$)", text, re.DOTALL,
                ):
                    if pasted.group(1).rstrip("\r\n") == typed_text:
                        return True
    return False


def permission_mode(records: list[dict], after_index: int = 0) -> str | None:
    """Return the latest separate permission-mode record at or after the index."""
    mode = None
    for index, record in _main_records(records):
        value = record.get("permissionMode")
        if (
            index >= after_index
            and record.get("type") == "permission-mode"
            and isinstance(value, str)
            and value
        ):
            mode = value
    return mode


def assistant_model(records: list[dict]) -> str | None:
    """Return the latest non-error main-thread assistant's model."""
    for _, record in _main_records(reversed(records)):
        message = _message(record)
        model = message.get("model")
        if (
            _is_role(record, "assistant")
            and not record.get("isApiErrorMessage")
            and isinstance(model, str)
            and model
        ):
            return model
    return None
