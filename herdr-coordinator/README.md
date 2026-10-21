# herdr-coordinator

A Claude Code skill that runs parallel Claude Code workers in [herdr](https://herdr.dev), one per GitHub issue. One Claude session per repository is the coordinator. You tell it "start #12 #15 #18", and it does the rest:

- It opens a herdr workspace, branch and sibling worktree for each issue, starts a worker Claude there in auto mode, and hands it the issue's entry command.
- A small detached watcher follows every worker's transcript and tells you only what needs you: a product question, a finished PR, a stall, a quota wait.
- Answers you give go back to the right worker, bound to the exact question they answer.
- On request, it cleans up merged work.
- Several coordinators can work in one repository at once, each as its own herdr tab. A tab is that coordinator's lane: it has its own workers (labelled `<repo> <lane> #N`), its own events and its own `follow`, and only the Claude session that claimed it may act in it.

The coordinator coordinates only. It never does a worker's task, never answers a worker's product question for you, and never merges.

## Why it is built this way

- **State comes from transcripts, not the screen.** herdr's pane status can mislabel: quota shows as `idle`, and a viewed pane goes from `done` to `idle`. The Claude Code `.jsonl` transcript is the authority, and herdr is used to spawn panes and show them.
- **Gates are mechanical.** In one community demo, an orchestrator was told "approvals are the user's call" and approved them anyway. Here a relay carries a state token for the question it answers. Forms the code cannot answer safely are refused, and nothing is sent to a worker while a hold is open.
- **Sends are recorded before they happen.** A send that cannot be confirmed is `delivery_unknown` and is never retried automatically, so a worker never gets a prompt twice.
- **Never unwatched.** `start`, `restart` and `go` bring up a missing watcher first. If workers ran unwatched (for example after a reboot), a `watcher_lost` hold stays open until you say go.
- **Every herdr and transcript shape was captured from the real producer.** See `tests/fixtures/README.md`. Most bugs found in live use were shapes that had been assumed instead.

## Requirements

- Windows 11. This is the only platform it has run on, and some parts (detached watcher, logon task) are Windows-specific.
- herdr 0.9.4 or later, with Claude Code sessions running inside it (`HERDR_ENV=1`).
- Claude Code with auto mode, on a model that supports it (Haiku does not).
- Python 3.10 or later (developed on 3.14), `git`, and an authenticated `gh`.
- Issues name their entry command, either as a label (`ce:work`, `ce:debug`, `ce:lfg`, `ce:brainstorm`, `ce:strategy`) or as a `CE entry: /<command> <args>` line in the body. These map to the [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin's commands, which is what the workers run. Without that plugin, adapt the label map in `parse_entry_command` (`scripts/start.py`).

## Install

This folder is one tool in the `workflow` repository. Clone the repository anywhere, then link this folder into your Claude skills so `SKILL.md` finds its scripts at `~/.claude/skills/herdr-coordinator`:

```powershell
git clone <this repo> "$HOME/CodeProjects/workflow"
New-Item -ItemType Junction -Path "$HOME/.claude/skills/herdr-coordinator" -Target "$HOME/CodeProjects/workflow/herdr-coordinator"
```

A `git pull` in the clone then updates the skill in place.

1. In Claude Code, open `/permissions` → Allow and add `Bash(python *herdr_coord.py*)` and `PowerShell(python *herdr_coord.py*)`. Auto mode otherwise blocks the coordinator's commands. Check the saved rule: the UI has been seen to strip the `*`.
2. Optional: to have watchers come back after a reboot, run `powershell -File scripts/install_logon_task.ps1`. It registers a "herdr coordinator watchers" task that relaunches them, each behind a hold, once herdr's server is up. Remove it with `-Remove`.
3. Run the tests: `python -m unittest discover -s tests -p "test_*.py"` from this folder. They use temp directories and never start a real watcher.

Then open a Claude Code session inside herdr in your repository and say "start #N". The skill loads from its description. Ask "what's the status?" at any time.

## Layout

| Path | Role |
|---|---|
| `scripts/herdr_coord.py` | Command line: `start`, `restart`, `launch-watcher`, `watch-run`, `follow`, `event`, `ack`, `status`, `nudge`, `relay`, `resume`, `handoff`, `lane bind`, `lane contact`, `go`, `cleanup`, `config`, `retire-legacy`; every command takes `--repo` |
| `scripts/lanes.py` | Caller lane resolution from the herdr tab (`HERDR_TAB_ID`, `HERDR_PANE_ID`), session-owned tab bindings, and the herdr ownership snapshot |
| `scripts/repo_root.py` | Repository resolution (git common dir) and per-repository state roots |
| `scripts/start.py` | Start flow: entry-command parsing, cap and queue, recorded start phases, delivery and mode checks |
| `scripts/watch.py` | Detached single-instance watcher, heartbeat, event follower, the worker state decision table |
| `scripts/actions.py` | Recorded sends to workers: nudge, relay, resume, go |
| `scripts/finish.py` | Done verification (PR and checks, "no CI", brainstorm artifact) and safe cleanup |
| `scripts/transcript.py` | Transcript discovery by session id and state classification |
| `scripts/adapters.py` | herdr, git, and gh calls through argument lists (no shell) |
| `scripts/registry.py` | Locked registry (version 3, migrated from 1 or 2 on first write), event log with sequence numbers and per-event lane routing, per-lane acknowledgement cursors |
| `tests/` | `python -m unittest discover -s tests -p "test_*.py"` from this folder |
| `tests/fixtures/` | Producer-captured records and probe findings (see its README) |

## State

Each repository has its own state root, `%LOCALAPPDATA%\herdr-coordinator\repos\<slug>-<hash>\` (base overridable with `HERDR_COORD_BASE`), holding `registry.json` (with its per-repository `config`, lanes and tab bindings), `registry.lock`, `events.jsonl`, `watcher.lock`, `heartbeat.json`, one `follow-<lane>.json` heartbeat per running `follow`, and the watcher log. Coordinators in one repository share this root; each lane has its own acknowledgement cursor. The CLI resolves the repository from `--repo`, `start`'s argument, or the current directory, and exports the root as `HERDR_COORD_HOME`. A `HERDR_COORD_HOME` already set (tests) wins.

State from before 2026-10-07 lived directly under the base. While it exists, every command refuses except `retire-legacy`, which archives it to `legacy-<timestamp>` once it is drained.

## Recovery

- Watcher gone: `herdr_coord.py status` says so; `launch-watcher` starts a new one, and a hold stays open until `go`.
- herdr restarted: workers show `lost`; `go`, then `resume <agent_name>` for each one to bring back.
- A send that could not be confirmed is recorded as `delivery_unknown` and is never resent automatically.
