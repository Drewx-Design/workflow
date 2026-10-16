"""Verify worker completion and remove only eligible, exited worktrees."""

from __future__ import annotations

import os
import re
import stat
import time
from datetime import datetime
from pathlib import Path


COMMAND_TIMEOUT = 60
NO_CI_GRACE = 600
CHECKS_OVERDUE = 3600
PR_FIELDS = "number,state,url,createdAt,mergedAt"
# the user, 2026-10-13: cleanup may close the window of a finished worker that sits idle with a clean
# worktree (closing the workspace ends its agent). A busy agent or a dirty tree is never closed.
CLOSABLE_STATES = frozenset({"done", "awaiting_merge", "ended_without_proof", "quota_wait"})
# A lost worker's agent is gone (a reboot or herdr restart), so --merged-pr may clean it; if herdr
# brought its agent back, _close_refusal still refuses to close it.
MERGE_MARKABLE_STATES = CLOSABLE_STATES | {"lost"}
IDLE_AGENT_STATUSES = frozenset({"idle", "done"})
_QUOTED_ARTIFACT = re.compile(r"[`\"']([^`\"'\r\n]+\.(?:md|html))[`\"']", re.IGNORECASE)
_BARE_ARTIFACT = re.compile(
    r"(?<![\w.:/\\])(?:[A-Za-z]:[/\\]|[/\\]{1,2}|\.{1,2}[/\\])?"
    r"[\w.-]+(?:[/\\][\w .-]+?)*\.(?:md|html)(?!\.[\w])"
    r"(?=$|[\s`'\")\],.;:!?])", re.IGNORECASE,
)


def _decision(state, detail, *, pr=None, no_ci=False, overdue=False, final_message=None):
    return {
        "state": state,
        "pr": pr["number"] if pr else None,
        "url": pr.get("url") if pr else None,
        "no_ci": no_ci,
        "overdue": overdue,
        "detail": detail,
        "final_message": final_message,
    }


def _last_assistant_text(records):
    for record in reversed(records):
        if (
            record.get("type") != "assistant"
            or record.get("isSidechain", False) is not False
            or record.get("isApiErrorMessage")
        ):
            continue
        message = record.get("message") or {}
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        texts = [
            block["text"] for block in content or []
            if isinstance(block, dict) and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ]
        if texts:
            return "\n".join(texts)
    return None


def _artifact(text, worktree_path):
    if not text or not worktree_path:
        return None
    paths = [match.group(1) for match in _QUOTED_ARTIFACT.finditer(text)]
    paths.extend(match.group(0) for match in _BARE_ARTIFACT.finditer(_QUOTED_ARTIFACT.sub(" ", text)))
    try:
        root = Path(worktree_path).resolve()
        for name in paths:
            candidate = (root / name).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return candidate
    except (OSError, ValueError):
        return None
    return None


def _changed_by_worker(artifact, worker, ops):
    """True when git shows the artifact added or changed in the worktree since origin/main."""
    worktree = worker.get("worktree_path")
    if not worktree:
        return False
    try:
        relative = Path(artifact).resolve().relative_to(Path(worktree).resolve()).as_posix()
        status = ops.git("status", "--porcelain", "--", relative, cwd=worktree, timeout=COMMAND_TIMEOUT)
        # Three dots: only what this branch changed since it forked, so a moving main proves nothing.
        diff = ops.git("diff", "--name-only", "origin/main...HEAD", "--", relative,
                       cwd=worktree, timeout=COMMAND_TIMEOUT)
    except (OSError, TimeoutError, ValueError):
        return False
    if not (status.ok and diff.ok):
        return False  # an unreadable answer never proves the artifact changed
    return bool(status.stdout.strip()) or bool(diff.stdout.strip())


def _reason(result):
    return result.error_message or result.stderr.strip() or result.error_code or "command failed"


def _branch_prs(worker, ops):
    if not worker.get("branch") or not worker.get("repo_path"):
        return None, "worker has no branch or repository path"
    try:
        result = ops.gh(
            "pr", "list", "--head", worker["branch"], "--state", "all",
            "--json", PR_FIELDS, cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT,
        )
    except (OSError, TimeoutError) as exc:
        return None, str(exc)
    if not result.ok:
        return None, _reason(result)
    if not isinstance(result.data, list) or any(
        not isinstance(pr, dict) or type(pr.get("number")) is not int
        or pr["number"] <= 0 or not isinstance(pr.get("state"), str)
        for pr in result.data
    ):
        return None, "gh returned invalid PR data"
    return result.data, ""


def _created_at(pr):
    try:
        created = datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00"))
        return created.timestamp() if created.tzinfo is not None else None
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError, OSError):
        return None


def _latest(prs):
    return max(prs, key=lambda pr: (_created_at(pr) or float("-inf"), pr["number"]))


def _declared_no_ci(repo, config):
    declared = config.get("no_ci_repos", [])
    if not isinstance(declared, list):
        return False
    target = os.path.normcase(os.path.normpath(repo))
    return any(
        isinstance(path, str) and os.path.isabs(path)
        and os.path.normcase(os.path.normpath(path)) == target
        for path in declared
    )


def verify_done(worker: dict, *, ops, config: dict, now: float, records: list[dict]) -> dict:
    """Return a decision using transcript/artifact evidence and GitHub reads only."""
    final = _last_assistant_text(records)
    command = worker.get("entry_command", "").lstrip("/").rsplit(":", 1)[-1]
    if command == "ce-brainstorm":
        artifact = _artifact(final, worker.get("worktree_path"))
        if artifact:
            return _decision("done", f"requirements artifact exists: {artifact}")
        return _decision(
            "ended_without_proof", "final message names no existing requirements artifact inside the worktree",
            final_message=final,
        )
    if command == "ce-strategy":
        # A strategy run ends with a document such as STRATEGY.md, and sometimes a PR instead.
        artifact = _artifact(final, worker.get("worktree_path"))
        # STRATEGY.md often already exists; only an artifact this worker added or changed proves the run.
        if artifact and _changed_by_worker(artifact, worker, ops):
            return _decision("done", f"strategy artifact written: {artifact}")
    if command not in {"ce-work", "ce-debug", "lfg", "ce-strategy"}:
        return _decision("ended_without_proof", "unsupported entry command", final_message=final)

    prs, reason = _branch_prs(worker, ops)
    if prs is None:
        return _decision("awaiting_checks", f"PR lookup failed: {reason}")
    if worker.get("reopened_at") is not None:
        prs = [pr for pr in prs if (created := _created_at(pr)) is not None
               and created >= worker["reopened_at"]]
        if not prs:
            return _decision(
                "ended_without_proof", "no new PR was opened since the follow-up",
                final_message=final,
            )
    open_prs = [pr for pr in prs if pr["state"].upper() == "OPEN"]
    if not open_prs:
        merged_prs = [pr for pr in prs if pr["state"].upper() == "MERGED"]
        if merged_prs:
            return _decision("done", "PR on the worker branch is merged", pr=_latest(merged_prs))
        return _decision("ended_without_proof", "no open PR on the worker branch", final_message=final)
    pr = _latest(open_prs)
    created = _created_at(pr)
    age = now - created if created is not None else None
    overdue = age is not None and age >= CHECKS_OVERDUE
    try:
        result = ops.gh(
            "pr", "checks", str(pr["number"]), "--json", "name,state,bucket",
            cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT,
        )
    except (OSError, TimeoutError) as exc:
        return _decision("awaiting_checks", f"check lookup failed: {exc}", pr=pr, overdue=overdue)
    no_checks = (
        not result.ok and result.returncode not in (None, 0)
        and re.search(r"\bno checks (?:were )?reported\b", result.stderr, re.IGNORECASE) is not None
    )
    if not result.ok and not no_checks:
        return _decision("awaiting_checks", f"check lookup failed: {_reason(result)}", pr=pr, overdue=overdue)
    checks = [] if no_checks else result.data
    if not isinstance(checks, list) or any(
        not isinstance(check, dict)
        or check.get("bucket") not in {"pass", "fail", "pending", "skipping", "cancel"}
        for check in checks
    ):
        return _decision("awaiting_checks", "check lookup returned invalid data", pr=pr, overdue=overdue)
    if not checks:
        if _declared_no_ci(worker["repo_path"], config) and age is not None and age >= NO_CI_GRACE:
            return _decision("done", "no CI: declared repository reports no checks after the grace period", pr=pr, no_ci=True)
        return _decision("awaiting_checks", "no checks reported; awaiting CI evidence", pr=pr, overdue=overdue)
    failed = [check for check in checks if check["bucket"] in {"fail", "cancel"}]
    if failed:
        names = ", ".join(f"{check.get('name') or 'unnamed check'} ({check['bucket']})" for check in failed)
        return _decision("ended_without_proof", f"checks failed: {names}", pr=pr, final_message=final)
    if any(check["bucket"] == "pending" for check in checks):
        return _decision("awaiting_checks", "checks pending", pr=pr)
    if all(check["bucket"] == "pass" for check in checks):
        return _decision("done", "all PR checks passing", pr=pr)
    return _decision("ended_without_proof", "checks were skipped; not all checks passed", pr=pr, final_message=final)


def _missing(result, resource):
    """Only an explicit absence error proves an agent/workspace is gone."""
    if result.ok or result.returncode is None:
        return False
    code = (result.error_code or "").lower().replace("-", "_")
    if code in {f"{resource}_not_found", f"no_{resource}"}:
        return True
    if resource == "agent" and code in {"no_agent_in_pane", "agent_exited"}:
        return True
    reason = _reason(result).lower()
    return re.search(
        rf"\b{resource}\b[^\r\n]*\b(?:not found|does not exist|has exited)\b"
        rf"|\bno {resource}(?: is| was)? (?:found|in|occupies|occupying|running)\b", reason,
    ) is not None


def merged_pr_applies(worker):
    """The user's named PR covers the settle it was named for, not a later reopen and finish."""
    return bool(worker.get("merged_pr_named")) and worker.get("merged_pr_token") == worker.get("state_token")


def named_pr_merged(worker, number, ops):
    """(True, "") when GitHub shows PR `number` merged in the worker's repository."""
    if type(number) is not int or number <= 0 or not worker.get("repo_path"):
        return False, "no valid PR number or repository for the named PR"
    try:
        result = ops.gh("pr", "view", str(number), "--json", PR_FIELDS,
                        cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT)
    except (OSError, TimeoutError) as exc:
        return False, f"PR lookup failed: {exc}"
    if not result.ok:
        return False, f"PR lookup failed: {_reason(result)}"
    data = result.data
    if not isinstance(data, dict) or data.get("number") != number or not isinstance(data.get("state"), str):
        return False, "gh returned invalid PR data"
    if data["state"].upper() != "MERGED":
        return False, f"PR #{number} is not merged"
    return True, ""


def _close_refusal(worker, agent, ops):
    """Why a live agent may not be closed by cleanup, or None when it may."""
    if worker.get("state") not in CLOSABLE_STATES:
        return "agent is still alive; its process must exit before cleanup"
    data = (agent.data or {}).get("result", {}).get("agent") if isinstance(agent.data, dict) else None
    status = (data.get("agent_status") or data.get("status")) if isinstance(data, dict) else None
    if status not in IDLE_AGENT_STATUSES:
        return f"agent is {status or 'in an unknown state'}; cleanup closes only an idle finished worker"
    if not worker.get("workspace_id"):
        return "agent is still alive and the worker has no workspace to close"
    try:
        status_result = ops.git("status", "--porcelain", cwd=worker["worktree_path"], timeout=COMMAND_TIMEOUT)
    except (OSError, TimeoutError) as exc:
        return f"cannot confirm the worktree is clean: {exc}"
    if not status_result.ok:
        return f"cannot confirm the worktree is clean: {_reason(status_result)}"
    if status_result.stdout.strip():
        return "worktree has uncommitted changes; nothing was closed"
    return None


def _registered(worker, ops):
    """Whether git still lists the worker's worktree, or None when git cannot say."""
    listed = ops.git("worktree", "list", "--porcelain", cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT)
    if not listed.ok:
        return None
    target = os.path.normcase(os.path.realpath(worker["worktree_path"]))
    lines = listed.stdout.splitlines()
    # A moved or re-spelled tree still has the worker's branch checked out somewhere.
    if worker.get("branch") and f"branch refs/heads/{worker['branch']}" in lines:
        return True
    return any(os.path.normcase(os.path.realpath(line[len("worktree "):])) == target
               for line in lines if line.startswith("worktree "))


def _finish_unregistered(worker, ops):
    """Settle a removal git already made: it unregistered the tree, then stopped part-way.

    A failed remove that left the tree registered is a real refusal (say, a dirty tree) and stays one.
    Cleanup never deletes a leftover folder itself: a path alias, junction or reused folder could make
    that delete someone else's work, so the user deletes it and the next cleanup settles the worker.
    """
    if _registered(worker, ops) is not False:
        return None
    path = worker["worktree_path"]
    if os.path.lexists(path):
        return {"cleaned": False, "reason": f"git unregistered the worktree but left its folder (often long "
                                            f"node_modules paths); the user deletes {path}, then cleanup again"}
    return {"cleaned": True, "reason": "worktree was already removed; branch retained"}


# Directory reparse points git may delete through: junctions and mount points, and symlinks.
# The IO_REPARSE_TAG_* names exist in `stat` only on Windows.
_LINK_TAGS = frozenset({getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003),
                        getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C)})
LINK_SCAN_SECONDS = 300


def _directory_reparse(info) -> str | None:
    """'link' for a directory junction or symlink (even a broken one), 'other' for any other
    directory reparse point, None for an ordinary entry. `info` is an lstat result."""
    attributes = getattr(info, "st_file_attributes", 0)
    if not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return "link" if stat.S_ISLNK(info.st_mode) else None
    if not attributes & stat.FILE_ATTRIBUTE_DIRECTORY:
        return None  # a file symlink: git removes the link itself
    return "link" if getattr(info, "st_reparse_tag", 0) in _LINK_TAGS else "other"


def _unlink_directory_links(worker, ops):
    """Unlink every directory junction or symlink inside a worktree, never following one.

    Git for Windows before 2.54 (2.50.1 here, reproduced) deletes through a junction in
    `git worktree remove`: a live run (2026-10-15) linked the main checkout's node_modules into
    its worktree, and removing the worktree emptied the main checkout's. Removing a link itself
    (os.rmdir) never touches its target. Returns (refusal reason or None, links unlinked).
    """
    tree = worker["worktree_path"]
    try:
        if _directory_reparse(os.lstat(tree)):
            return f"the worktree path {tree} is itself a link; the worktree was not removed", []
    except FileNotFoundError:
        return None, []
    except OSError as exc:
        return f"cannot check {tree} for linked folders: {exc}; the worktree was not removed", []
    deadline = time.monotonic() + LINK_SCAN_SECONDS
    links, folders = [], [tree]
    while folders:
        folder = folders.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if time.monotonic() > deadline:
                        return (f"checking {tree} for linked folders took over {LINK_SCAN_SECONDS} s; "
                                "the worktree was not removed"), []
                    kind = _directory_reparse(entry.stat(follow_symlinks=False))
                    if kind == "other":
                        return (f"{entry.path} is a reparse point cleanup does not know; "
                                "the worktree was not removed"), []
                    if kind == "link":
                        links.append(entry.path)
                    elif entry.is_dir(follow_symlinks=False):
                        folders.append(entry.path)
        except FileNotFoundError:
            continue
        except OSError as exc:
            return f"cannot check {folder} for linked folders: {exc}; the worktree was not removed", []
    if not links:
        return None, []
    # git refuses to remove a dirty tree; do not take links out of a tree that stays.
    try:
        status = ops.git("status", "--porcelain", cwd=tree, timeout=COMMAND_TIMEOUT)
    except (OSError, TimeoutError) as exc:
        return f"cannot confirm the worktree is clean: {exc}; the worktree was not removed", []
    if not status.ok:
        return f"cannot confirm the worktree is clean: {_reason(status)}; the worktree was not removed", []
    if status.stdout.strip():
        return "worktree has uncommitted changes; the worktree was not removed", []
    unlinked = []
    for link in links:
        try:
            # Either removes the link, not the folder it points to; POSIX symlinks need unlink.
            (os.rmdir if os.name == "nt" else os.unlink)(link)
        except OSError as exc:
            return f"cannot unlink the linked folder {link}: {exc}; the worktree was not removed", unlinked
        if os.path.lexists(link):
            return f"the linked folder {link} is still there; the worktree was not removed", unlinked
        unlinked.append(link)
    return None, unlinked


def _unlinked_note(unlinked):
    return f" (these linked folders were already unlinked: {', '.join(unlinked)})" if unlinked else ""


def cleanup(worker: dict, *, ops) -> dict:
    """Close and remove an eligible checkout without force or branch deletion."""
    if merged_pr_applies(worker):
        # the user named the PR that merged this work (it may come from another branch); re-check it.
        merged, reason = named_pr_merged(worker, worker.get("pr"), ops)
        if not merged:
            return {"cleaned": False, "reason": reason}
    elif worker.get("abandoned") is not True:
        prs, reason = _branch_prs(worker, ops)
        if prs is None:
            return {"cleaned": False, "reason": f"PR lookup failed: {reason}"}
        if worker.get("pr") is not None:
            prs = [pr for pr in prs if pr["number"] == worker["pr"]]
        if not prs or _latest(prs)["state"].upper() != "MERGED":
            return {"cleaned": False, "reason": "worker PR is not merged"}
    if not worker.get("agent_name") or not worker.get("repo_path") or not worker.get("worktree_path"):
        return {"cleaned": False, "reason": "worker lacks agent, repository, or worktree identity"}
    unlinked = []
    try:
        agent = ops.herdr("agent", "get", worker["agent_name"], timeout=COMMAND_TIMEOUT)
        if agent.ok:
            refusal = _close_refusal(worker, agent, ops)
            if refusal:
                return {"cleaned": False, "reason": refusal}
            # Closing the workspace below ends the idle agent.
        elif not _missing(agent, "agent"):
            return {"cleaned": False, "reason": f"cannot confirm agent exit: {_reason(agent)}"}
        workspace = worker.get("workspace_id")
        if workspace:
            closed = ops.herdr("workspace", "close", workspace, timeout=COMMAND_TIMEOUT)
            if not closed.ok and not _missing(closed, "workspace"):
                return {"cleaned": False, "reason": _reason(closed)}
        # After the close, so no agent is left to recreate a link; before any removal.
        refusal, unlinked = _unlink_directory_links(worker, ops)
        if refusal:
            return {"cleaned": False, "reason": refusal + _unlinked_note(unlinked)}
        removed = None
        if workspace and closed.ok:
            removed = ops.herdr("worktree", "remove", "--workspace", workspace, timeout=COMMAND_TIMEOUT)
        # Live herdr (2026-10-15) drops the closed workspace, so removing by it fails with
        # workspace_not_found; the checkout is then removed through git, as on a later pass.
        if removed is None or _missing(removed, "workspace"):
            removed = ops.git("worktree", "remove", worker["worktree_path"], cwd=worker["repo_path"], timeout=COMMAND_TIMEOUT)
        if removed.ok:
            return {"cleaned": True, "reason": "workspace and worktree removed; branch retained"}
        result = _finish_unregistered(worker, ops) or {"cleaned": False, "reason": _reason(removed)}
        if not result["cleaned"]:
            result["reason"] += _unlinked_note(unlinked)
        return result
    except (OSError, TimeoutError) as exc:
        return {"cleaned": False, "reason": str(exc) + _unlinked_note(unlinked)}
