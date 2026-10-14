"""Resolve checkout ownership and derive stable per-repository state paths."""

import hashlib
import os
from pathlib import Path
import re
import subprocess


def resolve_repo(path):
    """Return the main checkout owning a directory or file, including worktrees."""
    directory = Path(path)
    if directory.is_file():
        directory = directory.parent
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=directory, capture_output=True, text=True, encoding="utf-8", check=False,
            timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Cannot resolve repository at {path}: {exc}; use --repo <path>") from exc
    if result.returncode != 0 or not result.stdout.strip():
        raise ValueError(f"Not a git repository: {path}; use --repo <path>")
    return Path(os.path.realpath(result.stdout.strip())).parent


def normalize(path):
    """Resolve links and Windows short names before normalizing path case."""
    return os.path.normcase(os.path.realpath(path))


def display_name(repo):
    return Path(repo).name


def slug(repo):
    return re.sub(r"[^a-z0-9]+", "-", display_name(repo).lower()).strip("-")


def base_root(base=None):
    """Return the shared parent of repository state and legacy files."""
    if base is None:
        base = os.environ.get("HERDR_COORD_BASE")
    if base is None:
        local = os.environ.get("LOCALAPPDATA")
        base = (Path(local) if local else Path.home() / "AppData" / "Local") / "herdr-coordinator"
    return Path(base)


def state_root(repo, base=None):
    digest = hashlib.sha256(normalize(repo).encode("utf-8")).hexdigest()[:8]
    # Normalize the name too: differently cased paths must produce one root.
    return base_root(base) / "repos" / f"{slug(normalize(repo))}-{digest}"
