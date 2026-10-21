"""Resolve stable coordinator lanes from herdr tabs and session-owned bindings."""

from pathlib import Path
import json
import math
import os
import re
import unicodedata

import adapters
import registry
import repo_root


WORKSPACE_TIMEOUT = 5


def coordinator_tag(tab_label, lane, repo_path):
    match = re.match(r"^C([0-9]+)(?=\Z|[ _:-])", tab_label or "", re.IGNORECASE)
    if match:
        return f"C{match[1]}"
    return repo_root.display_name(repo_path) if lane == "main" else lane


def short_title(title):
    title = " ".join((title or "").split())
    # Cf too: bidi overrides and zero-width characters would disguise the label in the sidebar.
    title = "".join(char for char in title if unicodedata.category(char) not in {"Cc", "Cf"})
    title = re.sub(
        r"^(?:(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:|\[[^]]+\])\s*",
        "", title, flags=re.IGNORECASE,
    ).strip()
    if len(title) > 32:
        head = title[:33]
        title = head.rpartition(" ")[0] or head[:32]  # one long word is cut, not dropped
    while title and (title[-1].isspace() or unicodedata.category(title[-1]).startswith("P")):
        title = title[:-1]
    return title


def workspace_label(repo_path, lane, issue, title="", *, tag=None):
    """A display label; worker lane ownership comes from the registry."""
    if tag is None:
        tag = coordinator_tag(None, lane, repo_path)
    label = f"{tag} #{issue} {short_title(title)}"
    return "".join(char for char in label if unicodedata.category(char) not in {"Cc", "Cf"}).strip()


def claim_owner_alive(owner):
    """True unless the claiming process is known to be gone (an unreadable answer counts as alive)."""
    import start

    if not isinstance(owner, dict):
        return False
    try:
        return start._process_identity(owner.get("pid")) == owner
    except OSError:
        return True


def check_worker_lane(worker, lane, *, error=ValueError):
    """Guard a user command before mutation; lane-neutral watcher calls skip this check."""
    if lane is None:
        return
    owner_lane = worker.get("lane", "main")
    if owner_lane != lane:
        raise error(f"Worker {worker.get('agent_name') or worker['worker_id']} is owned by lane {owner_lane}")
    claim = worker.get("handoff_claim") or {}
    if claim_owner_alive(claim.get("owner")):
        raise error(f"Worker handoff to lane {claim.get('target')} is in progress")


def read_caller_context(*, ops=None):
    """Return tab_id, pane_id, workspace_id, controller {agent, kind, value} and tab_label.

    No herdr env ids returns None for the legacy path; invalid identity raises ValueError.
    Read before taking the registry lock.
    """
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    tab_id = os.environ.get("HERDR_TAB_ID")
    pane_id = os.environ.get("HERDR_PANE_ID")
    ids = (workspace_id, tab_id, pane_id)
    if all(value is None for value in ids):
        return None
    if any(not isinstance(value, str) or not value.strip() for value in ids):
        raise ValueError("Incomplete herdr identity: HERDR_WORKSPACE_ID, HERDR_TAB_ID and HERDR_PANE_ID are required")
    ops = ops or adapters
    records = {}
    for entity, identity in (("tab", tab_id), ("pane", pane_id)):
        try:
            result = ops.herdr(entity, "get", identity, timeout=WORKSPACE_TIMEOUT)
        except (OSError, TimeoutError) as exc:
            raise ValueError(f"Cannot read herdr {entity} {identity}: {exc}") from exc
        data = result.data.get("result") if isinstance(result.data, dict) else None
        record = data.get(entity) if isinstance(data, dict) else None
        if not result.ok or not isinstance(record, dict):
            raise ValueError(f"Cannot read herdr {entity} {identity}: "
                             f"{result.error_message or 'missing result.' + entity}")
        records[entity] = record
    tab, pane = records["tab"], records["pane"]
    if (tab.get("tab_id") != tab_id or pane.get("pane_id") != pane_id
            or pane.get("tab_id") != tab_id or tab.get("workspace_id") != workspace_id
            or pane.get("workspace_id") != workspace_id):
        raise ValueError("Inconsistent herdr identity: tab, pane and workspace ids do not match")
    if not isinstance(tab.get("label"), str):
        raise ValueError(f"Cannot read herdr tab {tab_id}: missing result.tab.label")
    session = pane.get("agent_session")
    if (not isinstance(session, dict)
            or any(not isinstance(session.get(key), str) or not session[key].strip()
                   for key in ("agent", "kind", "value"))):
        raise ValueError(f"Cannot read herdr pane {pane_id}: missing agent_session.agent, kind or value")
    return {"tab_id": tab_id, "pane_id": pane_id, "workspace_id": workspace_id,
            "controller": {key: session[key] for key in ("agent", "kind", "value")}, "tab_label": tab["label"]}


def read_snapshot(*, caller_pane_id=None, ops=None):
    """Return {tab_ids: set, controller_counts: {session_value: pane_count}}, or None if unknown.

    A missing controller in a trusted snapshot is absent. Pass caller_pane_id for a
    herdr command; omit it outside herdr or for a follower checking a closed pane.
    Read before taking the registry lock.
    """
    ops = ops or adapters
    records = {}
    for entity, key in (("tab", "tabs"), ("pane", "panes")):
        try:
            result = ops.herdr(entity, "list", timeout=WORKSPACE_TIMEOUT)
        except (OSError, TimeoutError):
            return None
        data = result.data.get("result") if isinstance(result.data, dict) else None
        listing = data.get(key) if isinstance(data, dict) else None
        if (not result.ok or not isinstance(listing, list)
                or any(not isinstance(item, dict) or not isinstance(item.get(f"{entity}_id"), str)
                       or not item[f"{entity}_id"].strip() for item in listing)):
            return None
        records[entity] = listing
    panes = records["pane"]
    if not panes or (caller_pane_id is not None and caller_pane_id not in {pane["pane_id"] for pane in panes}):
        return None
    controllers = {}
    for pane in panes:
        session = pane.get("agent_session")
        if session is None:
            continue
        if (not isinstance(session, dict)
                or any(not isinstance(session.get(key), str) or not session[key].strip() for key in ("kind", "value"))):
            return None
        value = session["value"]
        controllers[value] = controllers.get(value, 0) + 1
    return {"tab_ids": {tab["tab_id"] for tab in records["tab"]}, "controller_counts": controllers}


def _workspace(ops, workspace_id):
    try:
        result = ops.herdr("workspace", "get", workspace_id, timeout=WORKSPACE_TIMEOUT)
    except (OSError, TimeoutError) as exc:
        raise ValueError(f"Cannot read workspace label for {workspace_id}: {exc}") from exc
    data = result.data.get("result") if isinstance(result.data, dict) else None
    workspace = data.get("workspace") if isinstance(data, dict) else None
    if not result.ok or not isinstance(workspace, dict) or not isinstance(workspace.get("label"), str):
        raise ValueError(f"Cannot read workspace label for {workspace_id}: "
                         f"{result.error_message or 'missing result.workspace.label'}")
    return workspace


def _derived_lane(repo, workspace):
    if repo is None:
        repo = workspace.get("worktree", {}).get("repo_name")
    if not repo:
        raise ValueError("Cannot determine repository name for workspace lane; use --repo")
    name = Path(repo).name
    label = workspace["label"]
    if label.casefold() == name.casefold():
        return "main"
    if not label.casefold().startswith(name.casefold()) or label[len(name):len(name) + 1] not in (" ", "-"):
        return "main"
    return _slug(label[len(name):])


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "main"


def _record_binding(doc, caller, name, source, explicit, stale=()):
    previous = doc["tab_bindings"].get(caller["tab_id"])
    contact = None
    for tab_id in (caller["tab_id"], *stale):
        binding = doc["tab_bindings"].get(tab_id)
        if binding and binding["controller"] == caller["controller"] and binding.get("contact"):
            contact = binding["contact"]
            break
    if previous:
        doc["lanes"][previous["lane"]]["bound_before"] = True
    lane = doc["lanes"].setdefault(name, registry._lane(doc["event_seq"]))
    lane["bound_before"] = True
    for old_id in stale:
        if old_id != caller["tab_id"]:  # overwritten in place below, keeping its key order
            doc["tab_bindings"].pop(old_id, None)
    doc["tab_bindings"][caller["tab_id"]] = {
        "lane": name, "label_seen": caller["tab_label"], "source": source, "explicit": explicit,
        "controller": caller["controller"], "pane_id": caller["pane_id"],
    }
    if contact is not None:
        doc["tab_bindings"][caller["tab_id"]]["contact"] = contact


def _unbound_context(source):
    return {"lane": "main", "tab_id": None, "pane_id": None, "workspace_id": None,
            "controller": None, "source": source}


def owner_live(controller, snapshot):
    return snapshot["controller_counts"].get(controller["value"], 0) > 0


def claude_session_names():
    """Best-effort names from Claude's optional, concurrently written session files."""
    latest = {}
    try:
        config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
        for path in (Path(config_dir) / "sessions").glob("*.json"):
            try:
                session = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, RecursionError):
                continue
            if not isinstance(session, dict):
                continue
            session_id, name = session.get("sessionId"), session.get("name")
            if not isinstance(session_id, str) or not isinstance(name, str):
                continue
            updated_at = session.get("updatedAt", 0)
            if (not isinstance(updated_at, (int, float)) or isinstance(updated_at, bool)
                    or (isinstance(updated_at, float) and not math.isfinite(updated_at))):
                updated_at = 0
            if session_id not in latest or updated_at > latest[session_id][0]:
                latest[session_id] = (updated_at, {name})
            elif updated_at == latest[session_id][0]:
                latest[session_id][1].add(name)
    except (OSError, ValueError, RuntimeError):
        return {}
    # Newest files that disagree leave the current name unknown, and unknown is never stale.
    return {session_id: next(iter(names)) for session_id, (_, names) in latest.items() if len(names) == 1}


def contact_stale(binding, names):
    """Return a known renamed session's current name without changing its contact."""
    contact = binding.get("contact")
    if contact:
        name = names.get(binding["controller"]["value"])
        # Claude's file is untrusted input printed into tab-separated status lines.
        if name and len(name) <= 100 and name.isprintable() and name != contact.rsplit(" [", 1)[0]:
            return name
    return None


def _refuse_owner(tab_id, binding):
    raise ValueError(f"Lane {binding['lane']} is owned by tab {tab_id} "
                     f"(session {binding['controller']['value'][:8]}); rename this tab to name a new lane, "
                     f"run lane bind <another lane>, or close tab {tab_id}")


def _owned_binding(bindings, caller, snapshot):
    """KTD4 rows 1-6, shared by resolution and explicit bind; do not mutate yet."""
    tab_id, controller = caller["tab_id"], caller["controller"]
    count = snapshot["controller_counts"].get(controller["value"], 0)
    if count > 1:
        raise ValueError(f"Cannot resolve duplicate session {controller['value'][:8]} on {count} live panes")
    if count != 1:
        raise ValueError("Cannot trust herdr snapshot: caller session is absent")
    exact = bindings.get(tab_id)
    if exact and exact["controller"] == controller:
        return tab_id, exact, exact["source"]
    if exact and owner_live(exact["controller"], snapshot):
        _refuse_owner(tab_id, exact)
    owned = [(key, value) for key, value in bindings.items() if value["controller"] == controller]
    for key, value in owned:
        if key in snapshot["tab_ids"]:
            _refuse_owner(key, value)
    if owned:
        key, value = owned[0]
        return key, value, "recovered by session"
    if exact:
        return tab_id, exact, "recovered by tab"
    return None


def _check_target(bindings, name, controller, snapshot):
    for key, value in bindings.items():
        if value["lane"] == name and value["controller"] != controller and owner_live(value["controller"], snapshot):
            _refuse_owner(key, value)


def _events_summary(seqs):
    # A long backlog lists as a count and range; a short one names each event to read.
    if len(seqs) <= 5:
        return "unacknowledged events " + ", ".join(map(str, seqs))
    return f"{len(seqs)} unacknowledged events ({seqs[0]}-{seqs[-1]})"


def pending_description(doc, name, *, pending=None):
    workers, queued, events = registry.lane_pending_work(doc, name) if pending is None else pending
    work = ([f"{worker.get('agent_name') or key} ({worker.get('state')})" for key, worker in workers]
            + [f"queued #{item.get('issue')}" for item in queued]
            + ([_events_summary([event["seq"] for event in events])] if events else []))
    return f"{name}: {', '.join(work)}; run lane bind {name} to drain it"


def _check_followers(doc, bindings, current, name, controller, snapshot):
    import watch

    if current and current[1]["lane"] != name:
        old = current[1]["lane"]
        if watch.follower_alive(old, doc["lanes"][old].get("follow_lease")):
            raise ValueError(f"Stop follow for lane {old} before running lane bind {name}")
    lease = doc["lanes"].get(name, {}).get("follow_lease")
    if lease and watch.follower_alive(name, lease):
        owner = lease.get("controller")
        if owner is None:
            owner = next((value["controller"] for value in bindings.values() if value["lane"] == name), None)
        if owner is None:
            raise ValueError(f"Lane {name} has a live follow outside herdr; stop it before running lane bind {name}")
        if owner and owner != controller and owner_live(owner, snapshot):
            raise ValueError(f"Lane {name} has a live follower for another session {owner['value'][:8]}; stop follow first")


def _resolve_context(repo, caller, ops, target=None):
    workspace = None
    # A binding committed after our read needs a new herdr snapshot, never a stale-owner deletion.
    for _ in range(3):
        known = registry.load()["tab_bindings"]
        if caller is None and not any(value["lane"] == "main" for value in known.values()):
            # No tab binding names main, so it has no owner to look for in herdr.
            with registry.locked():
                if not any(value["lane"] == "main" for value in registry.load()["tab_bindings"].values()):
                    return _unbound_context("outside herdr")
            continue
        snapshot = read_snapshot(caller_pane_id=caller["pane_id"] if caller else None, ops=ops)
        if snapshot is None:
            raise ValueError("Cannot read herdr ownership snapshot; existing owners count as live")
        if (caller and target is None and caller["tab_label"].isdigit()
                and caller["tab_id"] not in known
                and not any(value["controller"] == caller["controller"] for value in known.values())):
            workspace = _workspace(ops, caller["workspace_id"])
        resolved = []

        def select(doc):
            bindings = doc["tab_bindings"]
            if bindings != known:
                return
            if caller is None:
                _check_target(bindings, "main", None, snapshot)
                resolved.append(_unbound_context("outside herdr"))
                return
            current = _owned_binding(bindings, caller, snapshot)
            chosen = current
            label = caller["tab_label"]
            if target is None and chosen is None and not label.isdigit():
                matches = [(key, value) for key, value in bindings.items()
                           if value["label_seen"] == label and not value.get("explicit")
                           and not owner_live(value["controller"], snapshot)]
                if len(matches) > 1:
                    names = ", ".join(sorted(value["lane"] for _, value in matches))
                    tabs = ", ".join(sorted(key for key, _ in matches))
                    raise ValueError(f"Tab label matches several lanes: {names} (tabs {tabs}); use lane bind <name>")
                if matches:
                    chosen = (*matches[0], "recovered by label")
            if target is not None:
                name, source, explicit = target, "explicit", True
            elif chosen:
                name, source, explicit = chosen[1]["lane"], chosen[2], chosen[1].get("explicit", False)
            else:
                if label.isdigit():
                    name, source = _derived_lane(repo, workspace), "workspace fallback"
                else:
                    name, source = _slug(label), "tab label"
                explicit = False
            _check_target(bindings, name, caller["controller"], snapshot)
            if target is not None:
                _check_followers(doc, bindings, current, name, caller["controller"], snapshot)
            elif chosen is None:
                orphaned = [lane for lane, state in doc["lanes"].items() if state.get("bound_before")
                            and not any(value["lane"] == lane and owner_live(value["controller"], snapshot)
                                        for value in bindings.values())
                            and registry.lane_has_pending_work(doc, lane)]
                if orphaned and name not in orphaned:
                    raise ValueError("Orphaned lanes: " + "; ".join(pending_description(doc, lane) for lane in sorted(orphaned)))
            stale = [key for key, value in bindings.items()
                     if (value["lane"] == name and not owner_live(value["controller"], snapshot))
                     or value["controller"] == caller["controller"]]
            if chosen:
                stale.append(chosen[0])
            _record_binding(doc, caller, name, source, explicit, stale)
            resolved.append({key: caller[key] for key in ("tab_id", "pane_id", "workspace_id", "controller", "tab_label")}
                            | {"lane": name, "source": source})

        if caller is None:
            with registry.locked():
                select(registry.load())
        else:
            registry.update(select)
        if resolved:
            return resolved[0]
    raise ValueError("Lane bindings changed during herdr snapshot; retry the command")


def resolve_context(repo=None, *, legacy=False, ops=None):
    """Return the effective lane and ownership context, refreshing its binding under lock."""
    if legacy:
        return _unbound_context("legacy")
    ops = ops or adapters
    return _resolve_context(repo, read_caller_context(ops=ops), ops)


def record_contact(context, address):
    """Record a messaging address only while the resolved binding still belongs to the caller."""
    if context["controller"] is None:
        raise ValueError("lane contact requires a herdr tab")
    address = address.strip()
    # isprintable also rejects \x85,   and  , which splitlines() reads as line breaks in status.
    if not (address.isprintable() and re.fullmatch(r".{1,100} \[[0-9A-Za-z]{4,16}\]", address)):
        raise ValueError('contact must be the session\'s messaging name and ref, for example "norm-98 [bcefc3]"')

    def record(doc):
        binding = doc["tab_bindings"].get(context["tab_id"])
        if (binding is None or binding["lane"] != context["lane"]
                or binding["controller"] != context["controller"]):
            raise ValueError("lane binding moved; run status")
        binding["contact"] = address

    registry.update(record)
    return {"state": "contact_recorded", "lane": context["lane"],
            "tab_id": context["tab_id"], "contact": address}


def bind(name, *, legacy=False, ops=None):
    """Explicitly move this tab's binding and return its ownership context."""
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("lane name must be a lowercase slug (letters, digits and single hyphens)")
    if legacy:
        if name != "main":
            raise ValueError("--legacy supports only the main lane")
        return resolve_context(legacy=True)
    ops = ops or adapters
    caller = read_caller_context(ops=ops)
    if caller is None:
        raise ValueError("lane bind requires HERDR_WORKSPACE_ID, HERDR_TAB_ID and HERDR_PANE_ID inside herdr")
    return _resolve_context(None, caller, ops, target=name)
