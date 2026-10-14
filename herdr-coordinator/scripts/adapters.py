"""Argument-list adapters for the coordinator's external commands."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any


@dataclass
class CommandResult:
    ok: bool
    returncode: int | None
    stdout: str
    stderr: str
    data: Any = None
    error_code: str | None = None
    error_message: str | None = None


def _text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def _json(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return None


def run(argv, *, cwd=None, timeout=60, env_remove=()) -> CommandResult:
    """Run a list of arguments without a shell; retain the full JSON envelope."""
    if not isinstance(argv, list):
        raise TypeError("argv must be a list")
    if not argv:
        raise ValueError("argv must contain an executable")

    child_env = os.environ.copy()
    for name in env_remove:
        child_env.pop(name, None)
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            timeout=timeout,
            env=child_env,
            shell=False,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            # The detached watcher has no console; without this flag every
            # console child (herdr, git, gh) opens and closes its own window.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _text(exc.stdout)
        return CommandResult(
            False, None, stdout, _text(exc.stderr), _json(stdout),
            "timeout", f"Command timed out after {timeout} seconds",
        )
    except OSError as exc:
        code = "command_not_found" if isinstance(exc, FileNotFoundError) else "execution_error"
        return CommandResult(False, None, "", str(exc), None, code, str(exc))

    data = _json(completed.stdout)
    result = CommandResult(
        completed.returncode == 0, completed.returncode,
        completed.stdout, completed.stderr, data,
    )
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        result.ok = False
        result.error_code = data["error"].get("code", "command_failed")
        result.error_message = data["error"].get("message", "Command returned an error")
    elif not result.ok:
        result.error_code = "command_failed"
        result.error_message = completed.stderr.strip() or f"Command exited with {completed.returncode}"
    return result


def _prefix(name: str) -> list[str]:
    override = os.environ.get(f"HERDR_COORD_{name.upper()}")
    if override is not None:
        try:
            prefix = json.loads(override)
        except json.JSONDecodeError as exc:
            raise ValueError(f"HERDR_COORD_{name.upper()} must be a JSON argv list") from exc
        if not isinstance(prefix, list) or not prefix or not all(isinstance(arg, str) for arg in prefix):
            raise ValueError(f"HERDR_COORD_{name.upper()} must be a nonempty JSON argv list")
        return prefix
    return [shutil.which(name) or name]


def herdr(*args, **kw) -> CommandResult:
    return run(_prefix("herdr") + list(args), **kw)


def git(*args, cwd, **kw) -> CommandResult:
    return run(_prefix("git") + list(args), cwd=cwd, **kw)


def gh(*args, cwd=None, **kw) -> CommandResult:
    removed = tuple(kw.pop("env_remove", ())) + ("GITHUB_TOKEN", "GH_TOKEN")
    return run(_prefix("gh") + list(args), cwd=cwd, env_remove=removed, **kw)


def herdr_reachable() -> bool:
    result = herdr("workspace", "list")
    return result.ok and result.data is not None
