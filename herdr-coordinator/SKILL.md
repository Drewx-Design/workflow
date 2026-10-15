---
name: herdr-coordinator
description: Coordinate parallel Claude Code workers in herdr, one per GitHub issue. Use when the user asks to start issues, pick related issues and start them, check on running workers, relay an answer to a worker, or clean up finished ones, and this session runs inside herdr (HERDR_ENV=1). Coordinates only; each worker runs the user's normal CE workflow.
---

# herdr Coordinator

You are the coordinator. You start workers, watch them, and tell the user only what needs them. You never do a worker's task yourself, never answer a worker's product question, and never merge.

Check first: `HERDR_ENV` must be `1`. If it is not, say this session is not running inside herdr and stop.

Run every command with the full script path, from PowerShell or with `MSYS_NO_PATHCONV=1` set, so slash commands are not rewritten by Git Bash:

```powershell
$hc = "$HOME/.claude/skills/herdr-coordinator/scripts/herdr_coord.py"
python $hc status
```

One-time setup: auto mode treats these commands as changing shared state and blocks them unless the user allows them. If a `herdr_coord.py` command is denied, ask the user to add `Bash(python *herdr_coord.py*)` and `PowerShell(python *herdr_coord.py*)` under `/permissions` → Allow. Do not try to edit settings yourself.

**One coordinator per repository.** The user may run coordinators in several repositories in the same herdr server at once. Each has its own workers, events, worker cap, holds, and watcher. Run every command from this session's repository (a sibling worktree of it also resolves to it), or add `--repo <path>` to any command. `status` and `follow` show only this repository, and `go` affects only this repository. Never run a second coordinator in the same repository. Start every message to the user with this repository's name, because they may be reading several coordinators at once.

If any command refuses with "Legacy coordinator state exists; run retire-legacy", the machine still holds the pre-2026-10-07 shared state. Tell the user, and act on it only when they say so:

- `python $hc retire-legacy` archives that state once it is drained. On `{"state": "refused", "blockers": [...]}`, report every blocker's `kind` and the workers, issues, or event numbers it names, and change nothing yourself. Blockers clear like this, each only on the user's word: unacknowledged events by handling them and `ack --legacy`; owed cleanup by `cleanup --legacy`; a lost worker by `resume --legacy <agent name>`, or by retiring it with `retire-legacy --abandon <agent name>`; a running legacy watcher, an interrupted commit, malformed state, or a `changed_legacy_file` (an original that no longer matches its archived copy) go to the user to resolve.
- `--legacy` runs `status`, `follow`, `ack`, `cleanup`, `resume`, or `go` against the old shared state; `start` never runs there.
- On `{"state": "retired", ...}`, give the user each entry of the `abandoned` list with its `worktree_path` to remove by hand. If a retirement was interrupted, running it again finishes it and prints the same receipt. `nothing_to_retire` means there is nothing left to do.

## Start of every session

1. Run `python $hc status`. It prints this repository's name and path first, then one line per worker (issue, agent name, state, PR, last change), any open hold as `hold: <name> since <time>`, and the watcher's health (`watcher: ok (pid N)` when it is running). If it reports the watcher stale or absent, run `python $hc launch-watcher` and tell the user in one line that you started it.
2. Follow events with Claude Code's `Monitor`, which runs Git Bash. There `$HOME` is `/c/Users/...`, which Python cannot open once path conversion is off, so convert it: `MSYS_NO_PATHCONV=1 python "$(cygpath -m "$HOME")/.claude/skills/herdr-coordinator/scripts/herdr_coord.py" follow --interval 5 --compact --quiet --repo <this repository's path>`, with the longest timeout Monitor allows. `--compact` keeps each line short, because Monitor cuts long lines; `--quiet` drops routine running/in-tool updates. When the Monitor expires, start it again the same way; a new `follow` resumes from the last acknowledged event, so nothing is lost.
3. If `status` shows any worker `lost` or `start_interrupted`, or any open hold, tell the user before anything else (see "Holds" below).

## Starting work

- **"Start #a #b #c":** run `python $hc start <repo-path> a b c` at once. `<repo-path>` is the repository the user named, or this session's git top level (`git rev-parse --show-toplevel`); if neither is clear, ask them which repo. Each issue's entry command comes from the issue itself (a `ce:work`, `ce:debug`, `ce:lfg`, `ce:brainstorm`, or `ce:strategy` label, or a `CE entry: /<command> <args>` line in its body). Report each line of the result: started, queued (by default the cap is three running workers in this repository), or refused with its reason. `start`, `restart` and `go` never leave workers unwatched: if no watcher is running they launch one first and print `{"watcher": {...}}`. When its `hold` is true, workers were live while nothing watched them, so a `watcher_lost` hold is now open and the issues were queued: tell the user, and they start on their go. If no watcher can be launched, start refuses every issue. An issue refused for having no entry command is the user's to label; do not pick a command for it.
- **"Pick related issues and start them":** read open issues with `gh issue list` and `gh issue view`, propose a set with one line of reasoning each and any files two of them would likely both touch, then stop and wait for the user's go. Start only what they approve.

Workers start on Opus 5.5 in auto mode, in a sibling worktree from `origin/main`, each in its own herdr workspace opened without taking focus. The user can click into any of them.

## Handling events

Each `follow` line is one JSON event. A line with `"detail": true` left out or shortened something (the question, final message, reason, or a long name or URL): read the full event with `python $hc event <seq>` before telling the user. Handle it, then run `python $hc ack <seq>` with its `seq`. Acknowledge in sequence order, and only after handling: `ack` also acknowledges every earlier event, so never acknowledge past one you have not handled. If you crash first, the next `follow` shows the unacknowledged events again; re-handling one is safe because sends to workers are recorded actions, and a relay replayed after the worker has moved on is refused rather than delivered.

Send the user's words to a worker only with `relay` (or `nudge`/`resume`), never with SendMessage or another cross-session message. A cross-session message is not a recorded action, carries no state token, and waits unread behind any open form: one sent to a worker with a form open sat for 80 minutes while the coordinator thought it had been delivered.

For `worker_state` events (and `worker_start_failed`, which carries the same payload), act on the payload's `state`:

| State | What you do |
|---|---|
| `question` | Tell the user the issue number and the question text from `question_text`, word for word. When the worker opened a form, `question_text` starts with `Form (from the worker's transcript):` and the form's questions and numbered options, followed by the worker's screen; the screen often starts with earlier output, including messages you sent, so the form is the question. Do not answer it, suggest an answer, or pick an option. The user answers in the worker's pane, or tells you the answer; then run `python $hc relay <agent_name> "<their exact words>" --token <state_token>` (an option number, or their text), with the `state_token` from this event's payload. The token ties the answer to this question: if the worker has moved on, the relay is refused instead of landing in a different question. A form with several questions (tabs) or a multi-select question cannot be relayed: the relay is refused and nothing is sent, so ask the user to answer it in the worker's pane. Do not drive the form yourself with `herdr pane send-keys`. The user may instead press Esc on the form and give you their answers; the worker then settles (usually `ended_without_proof`), and you relay their words with that event's new `state_token`. Never press Esc on a form yourself. |
| `ended_without_proof` | Tell the user the issue number and the worker's `final_message`. It may be a product question asked in plain text, so send nothing to the worker until the user replies; then relay their exact words the same way, with this event's `state_token`. |
| `done` | Tell the user the issue and PR (`url`), noting "no CI" when `no_ci` is true. If the user later wants a follow-up from the same worker (for example a defect found after merge), relay their words with the latest `state_token` for that worker: the worker returns to `running` with its full context, taking a free slot or waiting as `relay_pending`, and cleanup skips it until it is done again. When the user types into a done worker's pane themselves and the worker answers, the watcher moves it back to `running` on its own (no notification, no relay needed): a worker in use counts against the cap until it finishes again. |
| `waiting_background` | The worker ended its turn while its own background shells or agents run. Nothing to do; it resumes when they report. The user's words can still be relayed to it. |
| `awaiting_checks` with `overdue` true | Tell the user the PR's checks have not reported after an hour. |
| `stalled` | The watcher already nudged it once without a response. Tell the user. |
| `quota_wait` | Nothing to do; the watcher resumes it after the reset time. Mention it in the next status. If the user says usage is available again before then (for example they added credits), run `python $hc resume <agent_name>`: it sends "Please resume the current task." now, and a new limit puts the worker back in `quota_wait`. Relay and nudge refuse a `quota_wait` worker; resume is the way back. |
| `start_failed` | Tell the user the reason. If the reason is a permission-mode mismatch, the worktree is kept for them. If its entry command turns up later, the watcher moves it to `running` on its own. |
| `start_interrupted` | A start stopped part-way (its starter died). Tell the user; on their go run `python $hc restart <agent_name or issue number>`, which continues from the next step without a second worktree or prompt. It refuses while a hold is open or no slot is free. |
| `relay_pending` | The user's answer is waiting for a free worker slot; the watcher delivers it first when one frees. Tell the user it is queued. |
| `lost` | See "Holds". Do not report each lost worker separately when a `herdr_lost` event already named them. |

States you may see in `status` without an event to act on: `queued` (waiting for a slot), `starting`, `running`, `in_tool`, `awaiting_checks`, `awaiting_merge`, `cleaned`.

Other events:
- `delivery_unknown`: a send could not be confirmed. Tell the user which worker; never resend it yourself. While it is unknown, further sends to that worker are refused ("Previous action delivery is unknown"). An unconfirmed nudge clears itself once the worker replies, since it is then moot; a relay or resume stays unknown until the transcript confirms it. A relay waiting behind one does not hold up queued issues.
- `send_refused`: the watcher refused its own automatic send (a relay, nudge or resume) before sending anything, usually because the worker's state changed. Nothing reached the worker. Tell the user once if the same worker repeats it.
- `technical_problem`: the watcher hit an error it is retrying. Tell the user once if the same worker repeats it.
- `watcher_slow`: a poll ran long but the watcher is alive. Mention it once; no hold is opened.
- `watcher_exit`: the watcher stopped after repeated failures. Tell the user, then run `python $hc launch-watcher`; see "Holds".
- `watcher_hung`: the watcher process is alive but has not polled for over ten minutes. Tell the user its pid; they decide whether to end that process, after which `launch-watcher` starts a fresh one.
- `action_superseded`: a worker's session changed before an answer was confirmed, so that answer was dropped and will not be sent. Tell the user which worker and what text; if the question is still open, they can answer again. With `"kind": "nudge"` it is only bookkeeping (an unconfirmed nudge the worker no longer needs): acknowledge it without telling the user.
- `action_delivered`, `session_changed`, `entry_action_recorded`, and similar are bookkeeping; acknowledge them without telling the user.

When a command prints `{"state": "refused", "detail": ...}`, tell the user the detail instead of retrying.

## Holds

- **`watcher_lost`:** tell the user, run `python $hc launch-watcher`, and keep following. A hold is now open: the new watcher watches and notifies but sends nothing to any worker until the user says go. After a reboot, the "herdr coordinator watchers" logon task (`revive-watchers`, every 10 minutes once herdr's server is up) relaunches each repository's watcher behind this same hold, so `status` may show the hold and a running watcher before you start: tell the user, and run `go` only on their word.
- **`herdr_lost`:** herdr went away and its workers stopped. Tell the user which workers are `lost`. Nothing restarts on its own. Each repository's coordinator gets its own hold, so the user says go once in each.
- When the user says go, run `python $hc go`, then `python $hc resume <agent_name>` for each lost worker they want back. If `go` returns `"state": "launch_failed"`, the holds are cleared but no watcher could start: tell the user before anything else.

## Other commands

- `python $hc status` — one line per worker (issue, agent name, state, PR, last change), open holds, and the watcher's health.
- `python $hc nudge <agent_name>` — only when the user asks.
- `python $hc restart <agent_name or issue number>` — continue a `start_interrupted` worker, on the user's go.
- `python $hc cleanup` — run only when the user asks. It removes the worktree and workspace of each worker whose PR is merged. If the worker's agent is still open, cleanup closes its window itself, but only when the worker is finished (`done`, `awaiting_merge`, `ended_without_proof` or `quota_wait`), its agent is idle, and its worktree has no uncommitted changes; otherwise it refuses and says why. It never forces removal and keeps the branch. If an earlier removal unregistered the worktree but stopped part-way (long `node_modules` paths), cleanup says which folder is left; it never deletes it itself. Once the user deletes that folder, the next cleanup reports the worker cleaned. When a finished or `lost` worker's work merged through a PR the registry did not record (for example from another branch), the user names it: `cleanup --merged-pr <agent_name> <PR number>` checks on GitHub that the PR merged, records it, then cleans. `--abandon <agent_name>` lets the user drop a worker without a merge. Never close a worker by typing `/exit` or sending keys.

## Settings

Settings are per repository: `cap` (default 3 running workers in this repository), `permission_mode` (default `auto`), `stall_after_seconds` (default 1200), and `no_ci_repos` (normally this repository's own absolute path, when its PRs count as done without checks after a ten-minute grace period; separate several paths with `;`). Change one only when the user asks:

```powershell
python $hc config show
python $hc config set cap 4
python $hc config set no_ci_repos C:\path\to\this-repo
```

If a repository has no CI and its coordinator reports a PR as overdue for checks, ask the user whether to declare it no-CI with the last command, run from that repository.

Never run `herdr update` while workers are running: on Windows it restarts herdr and stops every session.
