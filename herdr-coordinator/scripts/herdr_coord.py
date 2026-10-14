"""Command-line entry point for starting coordinator workers."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import msvcrt
import os
from pathlib import Path
import re
import shutil
import sys
import time

import registry
import repo_root


CLEANABLE_STATES = {"done", "awaiting_merge"}
WATCHER_READY_SECONDS = 15
# Legacy workers in any other state block retire-legacy.
_RETIRABLE_STATES = CLEANABLE_STATES | {"cleaned", "lost"}
_LEGACY_FILES = {"registry.json", "events.jsonl", "heartbeat.json", "watcher.log", "watcher.lock"}


def _issue_number(value):
    try:
        number = int(value.lstrip("#"))
        if number > 0:
            return number
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("issue must be a positive number")


def _utf8_output():
    # Pane text carries characters like "●" that the Windows cp1252 console cannot encode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main(argv=None):
    _utf8_output()
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("start", help="start the assigned CE workers")
    command.add_argument("repo")
    command.add_argument("issues", type=_issue_number, nargs="+")
    command = commands.add_parser("restart", help="restart an interrupted start from its next phase")
    command.add_argument("name", help="agent name or issue number")
    commands.add_parser("launch-watcher", help="launch the detached watcher")
    commands.add_parser("watch-run", help="run the watcher with its lifetime lock")
    command = commands.add_parser("follow", help="follow unacknowledged events")
    command.add_argument("--interval", type=float, default=5)
    command.add_argument("--compact", action="store_true", help="show short event summaries")
    command.add_argument("--quiet", action="store_true", help="hide running and in_tool worker state events")
    command = commands.add_parser("event", help="read a full event without acknowledging it")
    command.add_argument("seq", type=int)
    command = commands.add_parser("ack", help="acknowledge an event after handling it")
    command.add_argument("seq", type=int)
    commands.add_parser("status", help="show registered workers and watcher health")
    for name in ("nudge", "resume", "relay"):
        command = commands.add_parser(name)
        command.add_argument("name")
        if name == "relay":
            command.add_argument("text")
            command.add_argument("--token", required=True, help="state token of the question being answered")
        command.add_argument("--action-id", help="reuse this id when replaying the same action")
    commands.add_parser("go", help="clear all worker holds on the user's go")
    commands.add_parser("revive-watchers",
                        help="at logon: relaunch each repository's watcher behind a hold, if it has live workers")
    command = commands.add_parser("cleanup", help="remove merged, exited workers' worktrees")
    command.add_argument("--abandon", metavar="NAME", help="mark this worker abandoned before cleaning")
    command.add_argument("--merged-pr", nargs=2, metavar=("NAME", "PR"),
                         help="this finished worker's work merged as PR (verified on GitHub) before cleaning")
    command = commands.add_parser("retire-legacy", help="archive the old shared coordinator state")
    command.add_argument("--abandon", metavar="NAME", action="append", default=[],
                         help="acknowledge a lost legacy worker (repeat for each name)")
    command = commands.add_parser("config", help="show or update this repository's configuration")
    config_commands = command.add_subparsers(dest="config_command", required=True)
    config_commands.add_parser("show", help="show configuration as JSON")
    command = config_commands.add_parser("set", help="set a configuration value")
    command.add_argument("key")
    command.add_argument("value")
    for command in [*commands.choices.values(), *config_commands.choices.values()]:
        command.add_argument("--repo", dest="repo_override", default=argparse.SUPPRESS,
                             help="repository path (defaults to the current directory)")
        command.add_argument("--legacy", action="store_true", default=argparse.SUPPRESS,
                             help="drain the old shared coordinator state")
    args = parser.parse_args(argv)
    try:
        if getattr(args, "legacy", False):
            if getattr(args, "repo_override", None) is not None:
                raise ValueError("--legacy cannot be combined with --repo")
            if args.command == "start":
                raise ValueError("start cannot run with --legacy; no new legacy work is allowed")
            if not os.environ.get("HERDR_COORD_HOME"):
                # Draining must never create legacy state that would then lock out every repository.
                if args.command != "retire-legacy" and not (repo_root.base_root() / "registry.json").exists():
                    raise ValueError("--legacy found no legacy coordinator state to drain")
                os.environ["HERDR_COORD_HOME"] = str(repo_root.base_root())
        if args.command == "retire-legacy":
            result = _retire_legacy(args.abandon)
            print(json.dumps(result, ensure_ascii=False))
            return 1 if result["state"] == "refused" else 0
        if args.command == "revive-watchers":
            if getattr(args, "repo_override", None) is not None or getattr(args, "legacy", False):
                raise ValueError("revive-watchers covers every repository; it takes no --repo or --legacy")
            result = _revive_watchers()
            line = json.dumps(result, ensure_ascii=False)
            print(line)
            if result.get("results"):
                # The logon task runs under pythonw, which has no console to read this from.
                with (repo_root.base_root() / "revive.log").open("a", encoding="utf-8") as log:
                    log.write(f"{datetime.now(timezone.utc).isoformat()} {line}\n")
            return 0
        if not os.environ.get("HERDR_COORD_HOME") and (repo_root.base_root() / "registry.json").exists():
            raise ValueError("Legacy coordinator state exists; run retire-legacy before using repository state")
        _select_state_root(args)
    except (OSError, ValueError) as exc:
        result = {"state": "refused", "detail": str(exc)}
        if args.command == "retire-legacy":
            result["drain"] = "Use --legacy on drain commands (ack, cleanup, resume, go, status, follow)."
        print(json.dumps(result, ensure_ascii=False))
        return 1
    if args.command != "start":
        return _coordinator_command(args)
    import start

    # A worker started with no watcher is never nudged, relayed or reported (boon-town #1892, 2026-10-14).
    try:
        watcher = _ensure_watcher(hold=True)
    except (OSError, TimeoutError) as exc:
        watcher = {"state": "launch_failed", "detail": str(exc)}
    if watcher is not None:
        print(json.dumps({"watcher": watcher}, ensure_ascii=False))
        if watcher.get("state") == "launch_failed":
            for issue in args.issues:
                print(json.dumps({"issue": issue, "state": "refused",
                                  "reason": "no watcher is running and none could be launched"}))
            return 1
    try:
        summaries = start.start_issues(args.repo, args.issues)
    except Exception as exc:
        summaries = [
            {"issue": issue, "state": "start_failed", "reason": str(exc)}
            for issue in args.issues
        ]
    for summary in summaries:
        print(json.dumps(summary, ensure_ascii=False))
    return 0


def _permission_retry(operation):
    """Retry like registry.replace_with_retry, for steps it has no helper for."""
    for attempt in range(registry._REPLACE_ATTEMPTS):
        try:
            return operation()
        except PermissionError:
            if attempt + 1 == registry._REPLACE_ATTEMPTS:
                raise
            time.sleep(registry._REPLACE_RETRY_DELAY * 2 ** attempt)


def _needs_watching(doc):
    import watch

    return bool(doc["queue"]) or any(worker.get("state") not in watch.TERMINAL_STATES
                                     for worker in doc["workers"].values())


def _ensure_watcher(*, hold):
    """Launch this repository's watcher when none is running; None when one already is.
    With `hold`, a gap while workers were live first opens the watcher_lost hold, so the new
    watcher reports but sends nothing to any worker until the user says go."""
    import watch

    if watch.watcher_alive():
        return None
    held = bool(hold and _needs_watching(registry.load()))
    if held:
        watch._watcher_lost(time.time())
    outcome = {**watch.launch(), "hold": held}
    if outcome.get("state") in {"launched", "already_running"}:
        # Popen returns before the child holds its lock: until it does, work started now would be
        # unwatched, and a follow would see no watcher and open a hold mid-start. A watcher that
        # holds the lock but has not yet replaced a dead predecessor's heartbeat also reads as
        # not alive (already_running), so wait for it the same way.
        deadline = time.monotonic() + WATCHER_READY_SECONDS
        while not watch.watcher_alive():
            if time.monotonic() >= deadline:
                return {**outcome, "state": "launch_failed",
                        "detail": f"watcher pid {outcome.get('pid')} did not come up within {WATCHER_READY_SECONDS} seconds"}
            time.sleep(0.2)
    return outcome


def _herdr_server_running(ops):
    try:
        result = ops.herdr("status", "server", timeout=15)
    except (OSError, TimeoutError):
        return False
    return result.ok and re.search(r"(?m)^status:\s*running\s*$", result.stdout or "") is not None


def _revive_watchers(ops=None):
    """Relaunch the watcher of every repository that still has live workers, each behind its
    watcher_lost hold. Runs at logon and on a repeat, so it waits for herdr's server and does
    nothing where a watcher is already running."""
    import adapters

    ops = ops or adapters
    if not _herdr_server_running(ops):
        return {"state": "skipped", "reason": "herdr server is not running"}
    results = []
    for path in sorted((repo_root.base_root() / "repos").glob("*/registry.json")):
        home = path.parent
        os.environ["HERDR_COORD_HOME"] = str(home)
        try:
            doc = registry.load()
            if not _needs_watching(doc):
                continue
            repo = next((worker["repo_path"] for worker in doc["workers"].values()
                         if worker.get("repo_path")), None)
            if repo:
                os.environ["HERDR_COORD_REPO"] = repo
            else:
                os.environ.pop("HERDR_COORD_REPO", None)
            outcome = _ensure_watcher(hold=True)
            if outcome is not None:
                results.append({"state_root": str(home), **outcome})
        except Exception as exc:  # One repository's bad state must not stop the others.
            results.append({"state_root": str(home), "state": "failed", "detail": f"{type(exc).__name__}: {exc}"})
    return {"state": "revived", "results": results}


def _worker_blocker(kind, worker):
    return {"kind": kind, "agent_name": worker.get("agent_name"),
            "issue": worker.get("issue"), "state": worker.get("state")}


def _legacy_watcher_running(base):
    """Probe the old watcher's byte lock without creating or changing its file."""
    try:
        handle = (base / "watcher.lock").open("r+b")
    except FileNotFoundError:
        return False
    except PermissionError:
        return True
    with handle:
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    return False


def _finish_retirement(base, receipt):
    blockers = _legacy_safety_blockers(base)
    if blockers:
        return _retirement_refused(blockers)
    hashes = receipt.get("sha256", {})
    if not isinstance(hashes, dict):
        hashes = {}
    for name in receipt["files"]:
        original = base / name
        if original.exists() and hashlib.sha256(original.read_bytes()).hexdigest() != hashes.get(name):
            blockers.append({"kind": "changed_legacy_file", "file": name,
                             "detail": "Original no longer matches its archived sha256"})
    if blockers:
        return _retirement_refused(blockers)
    # Keeping the registry until every other deletion succeeds keeps the CLI guard up.
    for name in sorted(receipt["files"], key=lambda name: (name == "registry.json", name)):
        _permission_retry(lambda: (base / name).unlink(missing_ok=True))
    return receipt


def _pending_retirement(base):
    for path in sorted(base.glob("legacy-*/retirement.json")):
        receipt = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(receipt, dict) or not isinstance(receipt.get("source_base"), str):
            raise ValueError(f"Invalid legacy retirement receipt: {path}")
        if repo_root.normalize(receipt["source_base"]) != repo_root.normalize(base):
            continue
        names = receipt.get("files")
        if not isinstance(names, list) or not all(
            isinstance(name, str) and Path(name).name == name
            and (name in _LEGACY_FILES or name.endswith(".tmp")) for name in names
        ):
            raise ValueError(f"Invalid legacy retirement file list: {path}")
        if any((base / name).exists() for name in names):
            return receipt
    return None


def _retirement_refused(blockers):
    return {"state": "refused", "blockers": blockers,
            "drain": "Use --legacy on drain commands (ack, cleanup, resume, go, status, follow)."}


def _legacy_safety_blockers(base):
    blockers = []
    if _legacy_watcher_running(base):
        blocker = {"kind": "watcher_running", "detail": "Legacy watcher is running"}
        try:
            heartbeat = json.loads((base / "heartbeat.json").read_text(encoding="utf-8"))
            if isinstance(heartbeat, dict) and "pid" in heartbeat:
                blocker["pid"] = heartbeat["pid"]
        except (OSError, ValueError):
            pass
        blockers.append(blocker)
    if (base / "transaction.json").exists():
        blockers.append({"kind": "interrupted_commit", "detail": "Legacy transaction.json is present"})
    return blockers


def _retire_legacy(abandon):
    """Check evidence without registry recovery, then archive before deleting."""
    base = repo_root.base_root().resolve()
    receipt = _pending_retirement(base)
    if receipt is not None:
        return _finish_retirement(base, receipt)
    path = base / "registry.json"
    if not path.exists():
        return {"state": "nothing_to_retire"}

    blockers = _legacy_safety_blockers(base)
    unacknowledged = []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] != 1
                or type(doc.get("ack_seq")) is not int or doc["ack_seq"] < 0
                or not isinstance(doc.get("queue"), list) or not isinstance(doc.get("workers"), dict)
                or any(not isinstance(worker, dict) or "issue" not in worker for worker in doc["queue"])
                or any(not isinstance(worker, dict) or not isinstance(worker.get("state"), str)
                       or not isinstance(worker.get("agent_name", ""), str)
                       for worker in doc["workers"].values())):
            raise ValueError("Invalid legacy registry shape or version")
        try:
            with (base / "events.jsonl").open(encoding="utf-8") as events:
                for line in events:
                    if line.strip():
                        event = json.loads(line)
                        if not isinstance(event, dict) or type(event.get("seq")) is not int:
                            raise ValueError("Invalid legacy event sequence")
                        if event["seq"] > doc["ack_seq"]:
                            unacknowledged.append(event["seq"])
        except FileNotFoundError:
            pass
    except (ValueError, UnicodeError) as exc:
        return _retirement_refused([*blockers, {"kind": "malformed_legacy_state", "detail": str(exc)}])
    if unacknowledged:
        blockers.append({"kind": "unacknowledged_events", "seqs": unacknowledged})
    if doc["queue"]:
        blockers.append({"kind": "queued_issues", "issues": [worker["issue"] for worker in doc["queue"]]})

    workers = list(doc["workers"].values())
    for worker in workers:
        if worker.get("state") in CLEANABLE_STATES:
            blockers.append(_worker_blocker("owes_cleanup", worker))
    for worker in workers:
        if worker.get("state") not in _RETIRABLE_STATES:
            blockers.append(_worker_blocker("active_worker", worker))
    abandoned = []
    lost_names = set()
    for worker in workers:
        if worker.get("state") != "lost":
            continue
        name = worker.get("agent_name")
        lost_names.add(name)
        if name not in abandon:
            blockers.append({"kind": "lost_worker", "agent_name": name, "issue": worker.get("issue"),
                             "detail": "Resume this lost worker or name it with --abandon"})
        else:
            abandoned.append({key: worker.get(key) for key in
                              ("agent_name", "issue", "repo_path", "worktree_path")})
    for name in dict.fromkeys(abandon):
        if name not in lost_names:
            blockers.append({"kind": "unknown_abandon", "agent_name": name,
                             "detail": "--abandon matches no lost legacy worker"})
    if blockers:
        return _retirement_refused(blockers)

    names = sorted({name for name in _LEGACY_FILES if (base / name).is_file()}
                   | {path.name for path in base.glob("*.tmp") if path.is_file()})
    archive = base / ("legacy-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ"))
    _permission_retry(lambda: archive.mkdir())
    for name in names:
        def copy():
            shutil.copyfile(base / name, archive / name)
            with (archive / name).open("r+b") as handle:
                os.fsync(handle.fileno())
        _permission_retry(copy)
    receipt = {"state": "retired", "archive": str(archive), "source_base": str(base),
               "files": names, "abandoned": abandoned,
               "sha256": {name: hashlib.sha256((archive / name).read_bytes()).hexdigest() for name in names}}
    temporary = archive / "retirement.tmp"
    def write_receipt():
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(receipt, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    _permission_retry(write_receipt)
    registry.replace_with_retry(temporary, archive / "retirement.json")
    return _finish_retirement(base, receipt)


def _select_state_root(args):
    if os.environ.get("HERDR_COORD_HOME"):
        return
    override = getattr(args, "repo_override", None)
    positional = args.repo if args.command == "start" else None
    repo = repo_root.resolve_repo(override or positional or Path.cwd())
    if positional is not None:
        if override is not None and repo_root.normalize(repo_root.resolve_repo(positional)) != repo_root.normalize(repo):
            raise ValueError("start's positional repo and --repo must resolve to the same repository")
        args.repo = str(repo)
    args.resolved_repo = repo
    os.environ["HERDR_COORD_REPO"] = str(repo)
    os.environ["HERDR_COORD_HOME"] = str(repo_root.state_root(repo))


def _config_value(key, value):
    if key == "permission_mode":
        return value
    if key == "cap":
        try:
            parsed = int(value)
            if parsed >= 1:
                return parsed
        except ValueError:
            pass
        raise ValueError("cap must be an integer >= 1")
    if key == "stall_after_seconds":
        try:
            parsed = float(value)
            if math.isfinite(parsed) and parsed > 0:
                return parsed
        except ValueError:
            pass
        raise ValueError("stall_after_seconds must be a finite number > 0")
    if key == "no_ci_repos":
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list) and all(
                isinstance(path, str) and Path(path).is_absolute() for path in parsed
            ):
                return parsed
        except ValueError:
            paths = [path.strip() for path in value.split(";")]
            if all(path and Path(path).is_absolute() for path in paths):
                return paths
        raise ValueError("no_ci_repos must be a JSON list of absolute paths or absolute paths separated by ;")
    raise ValueError(f"unknown configuration key: {key}")


def _coordinator_command(args):
    import actions
    import registry
    import start
    import watch

    legacy = getattr(args, "legacy", False)
    try:
        if args.command == "watch-run":
            return watch.run()
        if args.command == "follow":
            options = {key: True for key in ("compact", "quiet") if getattr(args, key)}
            return watch.follow(interval=args.interval, **options)
        if args.command == "status":
            doc = registry.load()
            repo = getattr(args, "resolved_repo", None)
            if repo is not None:
                print(f"repo: {repo_root.display_name(repo)} ({repo})")
            else:
                print(f"repo: (state root {registry._home()})")
            for worker in [*doc["workers"].values(), *doc["queue"]]:
                print(f"#{worker['issue']}\t{worker.get('agent_name') or '-'}\t{worker['state']}\tPR={worker.get('pr') or '-'}\tlast_change={worker.get('last_change', '-')}")
            for name, hold in doc["holds"].items():
                print(f"hold: {name} since {hold.get('ts', '-') if isinstance(hold, dict) else '-'}")
            if not watch.watcher_alive():
                print("watcher: stale or absent")
            elif watch.watcher_slow():
                print("watcher: slow")
            else:
                print(f"watcher: ok (pid {watch.heartbeat_pid() or 'unknown'})")
            return 0
        if args.command == "config":
            if args.config_command == "set":
                value = _config_value(args.key, args.value)
                registry.update(lambda doc: doc["config"].update({args.key: value}))
            result = registry.load()["config"]
        elif args.command == "event":
            result = next((event for event in registry.read_events(args.seq - 1)
                           if event["seq"] == args.seq), None) if args.seq > 0 else None
            if result is None:
                raise ValueError(f"No event exists with sequence {args.seq}")
        elif args.command == "ack":
            if args.seq < 0:
                raise ValueError("sequence must be nonnegative")
            registry.ack(args.seq)
            result = {"ack_seq": registry.load()["ack_seq"]}
        elif args.command == "launch-watcher":
            result = watch.launch()
        elif args.command == "go":
            result = actions.go()
            # the user's go covers the gap: a missing watcher comes back with no new hold. Legacy
            # state is only drained, and retire-legacy refuses while its watcher runs.
            watcher = None if legacy else _ensure_watcher(hold=False)
            if watcher is not None:
                result["watcher"] = watcher
                if watcher.get("state") == "launch_failed":
                    # The holds are cleared but nothing watches the workers: say so, and fail.
                    result["state"] = "launch_failed"
        elif args.command == "restart":
            # A missing watcher opens its hold first, which makes restart refuse until go.
            watcher = None if legacy else _ensure_watcher(hold=True)
            if watcher is not None:
                print(json.dumps({"watcher": watcher}, ensure_ascii=False))
            result = start.restart(args.name)
        elif args.command == "cleanup":
            result = _cleanup(args.abandon, merged_pr=args.merged_pr)
        elif args.command == "relay":
            result = actions.relay(args.name, args.text, state_token=args.token, action_id=args.action_id)
        else:
            result = getattr(actions, args.command)(args.name, action_id=args.action_id)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get("state") == "launch_failed" else 0
    except (actions.ActionError, start.StartError, ValueError) as exc:
        print(json.dumps({"state": "refused", "detail": str(exc)}, ensure_ascii=False))
        return 1


def _cleanup(abandon=None, *, merged_pr=None, ops=None):
    """Clean every eligible worker; finish.cleanup refuses unless merged (or abandoned) and either
    exited or idle with a clean worktree."""
    import adapters
    import finish
    import registry

    ops = ops or adapters
    if merged_pr:
        name, number = merged_pr
        if not number.lstrip("#").isdigit():
            raise ValueError(f"PR must be a number, not {number!r}")
        number = int(number.lstrip("#"))
        worker = next((w for w in registry.load()["workers"].values() if w.get("agent_name") == name), None)
        if worker is None:
            raise ValueError(f"no worker named {name}")
        if worker.get("state") not in finish.MERGE_MARKABLE_STATES:
            raise ValueError(f"{name} is {worker.get('state')}; only a finished or lost worker can be marked merged")
        merged, reason = finish.named_pr_merged(worker, number, ops)
        if not merged:
            raise ValueError(reason)

        def mark_merged(doc):
            current = doc["workers"][worker["worker_id"]]
            if (current.get("state"), current.get("state_token")) != (worker.get("state"), worker.get("state_token")):
                raise ValueError(f"{name} changed state; nothing was marked")
            # Tied to this settle: if the worker reopens and finishes again, the mark no longer applies.
            current.update(pr=number, merged_pr_named=True, merged_pr_token=current.get("state_token"))
        registry.update(mark_merged)
    if abandon:
        def mark(doc):
            matches = [w for w in doc["workers"].values() if w.get("agent_name") == abandon]
            if not matches:
                raise ValueError(f"no worker named {abandon}")
            matches[0]["abandoned"] = True
        registry.update(mark)
    results = []
    for worker in registry.load()["workers"].values():
        if worker.get("state") == "cleaned":
            continue
        if worker.get("state") == "cleaning":
            claimed_from = worker.get("cleanup_from") or {}
            if _claim_owner_alive(claimed_from.get("owner")):
                results.append({"issue": worker.get("issue"), "cleaned": False,
                                "reason": "another cleanup is in progress for this worker"})
                continue
            # An interrupted cleanup (its process is gone): take the claim over, then carry on as
            # the state it was claimed from.
            claim = _claim_for_cleanup(worker, takeover=True)
            worker = {**worker, "state": claimed_from.get("state"), "state_token": claimed_from.get("state_token")}
        elif (worker.get("state") not in CLEANABLE_STATES and worker.get("abandoned") is not True
                and not (finish.merged_pr_applies(worker) and worker.get("state") in finish.MERGE_MARKABLE_STATES)):
            continue
        else:
            claim = _claim_for_cleanup(worker)
        if claim is None:
            results.append({"issue": worker.get("issue"), "cleaned": False,
                            "reason": "worker changed state during cleanup; nothing was closed"})
            continue
        outcome = finish.cleanup(worker, ops=ops)
        _release_cleanup_claim(worker["worker_id"], claim, cleaned=bool(outcome.get("cleaned")))
        if outcome.get("cleaned"):
            registry.append_event("worker_cleaned", {"worker_id": worker["worker_id"], "issue": worker.get("issue")})
        results.append({"issue": worker.get("issue"), **outcome})
    return {"state": "cleanup", "results": results}


def _claim_owner_alive(owner):
    """True unless the claiming process is known to be gone (an unreadable answer counts as alive)."""
    import start

    if not isinstance(owner, dict):
        return False
    try:
        return start._process_identity(owner.get("pid")) == owner
    except OSError:
        return True


def _claim_for_cleanup(worker, *, takeover=False):
    """Move the worker to `cleaning` only if it is unchanged, so the watcher, a relay or a reopen
    cannot revive it while cleanup closes its window (they all require the old state token).
    Returns the claim's token, or None. A takeover re-claims a `cleaning` worker whose owner died."""
    import start
    import uuid

    token = uuid.uuid4().hex
    owner = start._process_identity(os.getpid())
    claimed = []

    def claim(doc):
        current = doc["workers"][worker["worker_id"]]
        if (current.get("state"), current.get("state_token")) != (worker.get("state"), worker.get("state_token")):
            return
        if takeover:
            current["cleanup_from"] = {**current.get("cleanup_from", {}), "owner": owner}
        else:
            current["cleanup_from"] = {"state": current["state"], "state_token": current.get("state_token"),
                                       "owner": owner}
        current.update(state="cleaning", state_token=token, last_change=time.time())
        claimed.append(token)

    registry.update(claim)
    return claimed[0] if claimed else None


def _release_cleanup_claim(worker_id, claim, *, cleaned):
    """Finish this claim: `cleaned`, or back to the claimed-from state when cleanup refused."""
    def release(doc):
        current = doc["workers"][worker_id]
        if current.get("state") != "cleaning" or current.get("state_token") != claim:
            return  # someone else holds the worker now
        claimed_from = current.pop("cleanup_from", {})
        if cleaned:
            current.update(state="cleaned", last_change=time.time())
        else:
            current.update(state=claimed_from.get("state"), state_token=claimed_from.get("state_token"))

    registry.update(release)


if __name__ == "__main__":
    raise SystemExit(main())
