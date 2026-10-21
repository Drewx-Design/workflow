# Fixtures (U1 producer capture, 2026-10-06)

The U1 fixtures were captured from real producers on the user's machine (herdr 0.9.0, Claude Code 2.1.292, Opus 5.5 worker in auto mode, Windows 11). None are hand-written. U1 transcript fixtures were sanitized with an allowlist: structural fields (types, ids, stop reasons, model, permission mode, quota fields, AskUserQuestion text) keep their values; every other string became `<redacted>` and `cwd` became `<cwd>`.

| File | Source | What it shows |
|---|---|---|
| `session-probe-full.jsonl` | Probe worker session `5efe44ac…` in a sibling norm worktree | Slash-command user record (`<command-name>/compound-engineering:ce-explain</command-name>` plus `<command-args>`), `permission-mode` records (`auto`), tool_use then tool_result pairs, a 75 s and a 60 s tool call, an AskUserQuestion tool_use and its answered result, `end_turn` turns, a `/clear` at the end |
| `session-after-clear-and-resume.jsonl` | Same worker after `/clear` (new session `ef950f8b…`), then `/exit` and `claude --resume ef950f8b…` | Session id change on `/clear`; the resumed session keeps the same id and file |
| `api-error-429-sequence.jsonl` | Boon-town transcript `1acf441e…`, lines 471-474 | A real 429: `type: assistant`, `isApiErrorMessage: true`, `apiErrorStatus: 429`, `stop_reason: stop_sequence`, `model: <synthetic>`, `quotaLimits.resetsAt` in epoch seconds; followed by system, snapshot, and a new user record |
| `herdr-agent-get-idle.json` | `herdr agent get` right after `agent start` | Idle worker with **no** `agent_session` yet |
| `herdr-agent-get-after-prompt-done.json` | After the first prompt finished | `agent_session.value` present (`source: herdr:claude`), status `done` |
| `herdr-agent-get-blocked-question.json` | While the AskUserQuestion form was on screen | Status `blocked` |
| `herdr-workspace-get-main.json` | Read-only `herdr workspace get w1`, captured 2026-10-20 | Main workspace label at `result.workspace.label` |
| `herdr-workspace-get-worker.json` | Read-only `herdr workspace get w23`, captured 2026-10-20 | Worker workspace label and linked worktree metadata |
| `herdr-workspace-get-missing.json` | Read-only lookup of an unknown workspace, captured 2026-10-20 | Exit 1 with `error.code` `workspace_not_found` |
| `herdr-workspace-list.json` | Read-only `herdr workspace list`, captured 2026-10-20, trimmed to three workspaces | Live ids at `result.workspaces[].workspace_id` |
| `herdr-tab-get.json` | Read-only `herdr tab get w2:t2S` (herdr 0.9.4), captured 2026-10-20 | `result.tab` with `tab_id`, `workspace_id`, `label` (`herdr`) and the separate `number` (`89`) |
| `herdr-pane-get.json` | Read-only `herdr pane get w2:p2V`, captured 2026-10-20 | `result.pane` with `tab_id`, `workspace_id`, `agent: claude` and `agent_session {agent, kind: id, source: herdr:claude, value}` |
| `herdr-tab-list-global.json` | Read-only `herdr tab list` with no `--workspace`, captured 2026-10-20, trimmed to workspaces w1, w2, w8 | Global listing at `result.tabs[]` spanning several workspaces |
| `herdr-pane-list-global.json` | Read-only `herdr pane list` with no `--workspace`, same capture, trimmed to the panes of those tabs | Global listing at `result.panes[]`; every Claude pane carries a distinct `agent_session.value` |
| `herdr-tab-get-missing.json` | Read-only `herdr tab get w2:tZZZ`, captured 2026-10-20 | Exit 1, written to stderr, with `error.code` `tab_not_found` |
| `herdr-pane-get-missing.json` | Read-only `herdr pane get w2:pZZZ`, captured 2026-10-20 | Exit 1, written to stderr, with `error.code` `pane_not_found` |
| `herdr-agent-read-visible.txt` | Exact stdout of `herdr agent read <agent> --source visible`, herdr 0.9.0, captured 2026-10-07 | Plain pane text with internal newlines, not a JSON envelope; this capture is not a pending AskUserQuestion form |
| `background-tasks-excerpt.jsonl` | Live Claude Code worker `taste-swipe-37`, captured 2026-10-07; tool commands, prompts, and requested model redacted | Bash `run_in_background: true` with a string tool result, Agent launch with a text-block tool result, and a main-thread `<task-notification>` with a terminal status and launching tool-use id |

The background excerpt preserves launch metadata and notification text. Its notification belongs to a different launch from the two captured pairs; tests substitute matching tool-use ids to exercise completion, duplicate notices, and other terminal statuses. The foreground Bash case moved to the background is derived from the Bash pair using the host-verified result text shape `moved to the background (ID: <id>)`.

## Probe results that the implementation must follow

1. **Session id appears only after the first prompt.** `agent_session` is absent at idle after `agent start`; it appears once the entry command is sent. Discovery runs after delivery.
2. **Transcript location:** `~/.claude/projects/<folder>/<session-id>.jsonl`; subagent (sidechain) transcripts live under `<folder>/<session-id>/subagents/`, so match only top-level `*/<id>.jsonl`.
3. **Slash commands are recorded by their resolved name**, not the typed text: `/ce-explain …` became `<command-name>/compound-engineering:ce-explain</command-name>` with the arguments in `<command-args>`. Delivery confirmation matches the command name and arguments, not the raw string.
4. **Permission mode lives in separate `permission-mode` records** (`permissionMode: auto`), written around each turn, not on the user record. Assistant records carry `message.model` (`claude-opus-5-5`).
5. **A pending AskUserQuestion is not in the transcript.** While the form is on screen the transcript ends at the previous tool result; the tool_use and its result are written together after the answer. Product-question detection therefore uses herdr's `blocked` status (`agent explain` rule `live_blocked_form`) plus the visible screen for the question text, with the transcript confirming the worker is mid-turn (no `end_turn` since the last user prompt).
6. **A long tool call is written before it finishes**: the tool_use record appears while the tool runs and herdr reports `working`, so "in a tool" is detectable from the transcript.
7. **`/clear` changes the session id; `claude --resume <id>` keeps it.**
8. **No permission prompt in auto mode** for `gh auth status`, `gh pr list`, `git push --dry-run`, or long shell commands; `gh` is authenticated inside the worker. Workers run in auto mode.
9. **`herdr worktree create`** honors a sibling `--path`, `--base origin/main`, and `--branch`, opens the workspace, and returns before the folder exists on disk (wait for the path). `herdr worktree remove --workspace` removes the checkout and keeps the branch.
10. **Detached watcher recipe works:** `subprocess.Popen` with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`, `python.exe`, stdin from DEVNULL, stdout and stderr to a log file. Launched from a herdr pane shell, the process kept heartbeating under the same PID after that workspace was closed, and `gh auth status` succeeded inside it.
11. **The 429 record's stop reason is `stop_sequence`**, not `end_turn`, and its model is `<synthetic>`.

## multi-question-form-excerpt.jsonl (2026-10-08)

Two records copied verbatim from norm-290's transcript (Claude Code 2.1.293): an AskUserQuestion with a single-select "Label fix" tab and a multi-select "Gate" tab (written when asked, at 13:30 UTC), and its answer (13:42 UTC). The answer was entered by hand: toggle each multi-select option with enter, move right to Submit, then "Submit answers". A multi-select answer is recorded as comma-joined labels in `toolUseResult.answers`. This also supersedes probe 5 above for this version: the pending form IS in the transcript before the answer.

## herdr-agent-read-tabbed-form.txt (2026-10-09)

`herdr agent read norm-308-39de6b` output, captured while a two-question form was open: the "Third arm" and "Proposed" tabs, with "Proposed" multi-select. The tab bar line is `←  ☒ Third arm  ☒ Proposed  ✔ Submit  →`, and the multi-select options read `1. [✔] …` / `2. [ ] …`. That worker ran Claude Code 2.1.295, which wrote no AskUserQuestion to the transcript while the form was open, so the screen is the only view of an open form there. The single-question capture `herdr-agent-read-visible.txt` shows neither marker.

## declined-compound-form-interrupt.jsonl (2026-10-09)

The last four records of norm-308's transcript (Claude Code 2.1.295) after the user pressed Esc on a four-tab form: the AskUserQuestion tool_use, its rejected tool_result (`toolUseResult` "User rejected tool use"), the user record `[Request interrupted by user for tool use]`, and a `turn_duration` system record. The pane was then idle at an empty prompt.
