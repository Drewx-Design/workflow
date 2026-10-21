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

**Repositories and lanes.** the user may run coordinators in several repositories in the same herdr server at once. Each repository has its own workers, events, worker cap, holds, and watcher. Run every command from this session's repository (a sibling worktree of it also resolves to it), or add `--repo <path>` to any command; `go` affects only this repository.

Inside one repository, the user may run more than one coordinator, usually as tabs in one herdr workspace. Your herdr **tab** is your coordinator's **lane**, and your Claude session owns it:
- A tab with a name is the lane of that name, lowercased with spaces as hyphens: a tab "SEO" is lane `seo`, "action minutes" is `action-minutes`.
- A tab still showing herdr's default number uses the workspace's name instead: a workspace named exactly after the repository ("my-app") is `main`, and "my-app seo" is `seo`.
- Your lane is fixed the first time you run a command (even `status`). Renaming the tab later changes nothing; only `lane bind` moves you.
- Only your session may act in your lane. Another session in your tab, or a tab that would take a lane whose owner is still running, is refused with a message naming the owning tab and the ways out: rename the tab to name a new lane, `lane bind <another lane>` on the user's word, or close the owner.
- Your lane survives a restart of Claude in the same tab, and a herdr restart that brings your session back in another tab. A new tab reusing an old number never inherits an old lane.
  Observed 2026-10-21 (herdr 0.9.4): after a herdr restart, every tab id, pane id and Claude session id came back unchanged, so each coordinator kept its lane with no action. A tab where Claude itself was restarted got a new session id; its next command takes over the tab's lane.
- A lane whose coordinator is gone but that still has unanswered questions, unacknowledged events, running workers, or queued issues blocks every new tab from starting a different lane. The refusal names it and its work. On the user's word, drain it: `lane bind <that lane>`, handle or `handoff` its workers, acknowledge its events, then `lane bind` your own lane.

What lanes change:
- Workers belong to the lane that started them. Their workspaces, nested under the repository in herdr's sidebar, are labelled `<tag> #<issue> <short title>`, for example "C3 #2502 faster issue filing". The tag is the leading C-number of the tab that started the worker ("C3-data quality" gives C3); a tab without one uses its lane name, and `main` uses the repository name. So the user names coordinator tabs C1, C2, C3... to tell owners apart at a glance. The label is display only: a worker's lane lives in the registry, and a `handoff` relabels it with the receiving lane's tag.
- `follow`, `event` and `ack` show only your lane's events, plus repository-wide ones (watcher, herdr, holds, and alerts about other lanes).
- `relay`, `nudge`, `resume`, `restart` and `cleanup` act only on your lane's workers, and refuse another lane's worker, naming its lane.
- `status` shows every worker with its lane, and every lane with whether a `follow` is running and how many events are unhandled.
- The worker cap, the queue, holds and the watcher are shared by every lane in the repository.

To start a second coordinator, the user opens a new tab in the repository's workspace and names it after the lane (for example "seo") before its first command. If you were opened in a numbered tab that another coordinator already owns, your first command is refused; ask the user to rename your tab.

Start every message to the user with this repository's name, and your lane when it is not `main`, because they may be reading several coordinators at once.

If any command refuses with "Legacy coordinator state exists; run retire-legacy", the machine still holds the pre-2026-10-07 shared state. Tell the user, and act on it only when they say so:

- `python $hc retire-legacy` archives that state once it is drained. On `{"state": "refused", "blockers": [...]}`, report every blocker's `kind` and the workers, issues, or event numbers it names, and change nothing yourself. Blockers clear like this, each only on the user's word: unacknowledged events by handling them and `ack --legacy`; owed cleanup by `cleanup --legacy`; a lost worker by `resume --legacy <agent name>`, or by retiring it with `retire-legacy --abandon <agent name>`; a running legacy watcher, an interrupted commit, malformed state, or a `changed_legacy_file` (an original that no longer matches its archived copy) go to the user to resolve.
- `--legacy` runs `status`, `follow`, `ack`, `cleanup`, `resume`, or `go` against the old shared state; `start` never runs there. Legacy state is the `main` lane only, so `handoff` and `lane bind` refuse it.
- On `{"state": "retired", ...}`, give the user each entry of the `abandoned` list with its `worktree_path` to remove by hand. If a retirement was interrupted, running it again finishes it and prints the same receipt. `nothing_to_retire` means there is nothing left to do.

## Start of every session

1. Run `python $hc status`. It prints this repository's name and path first, then:
   - `this lane: <name> (tab <id>, session <id>, source <how it was bound>)`, the lane you are in. It shows `unresolved (<reason>)` when the lane could not be read, and then every lane-scoped command refuses;
   - one line per worker (issue, agent name, state, PR, last change, lane);
   - one `lane:` line per lane (whether a `follow` is running, how many events are unhandled, the tab that owns it, `contact=` with its coordinator's Claude messaging address once recorded, `contact_stale=<current name>` when Claude's session list shows that session under a different name (best effort: a missing flag proves nothing, and a change of ref alone is never flagged), and a `mismatch=` note if its `follow` belongs to a different tab or session);
   - an `ownerless:` line for each lane whose coordinator is gone but that still has work, naming the work;
   - any open hold as `hold: <name> since <time>`;
   - the watcher's health (`watcher: ok (pid N)` when it is running).

   If it reports the watcher stale or absent, run `python $hc launch-watcher` and tell the user in one line that you started it.

   If it prints `lane resolution:` with a refusal, tell the user and run nothing that needs a lane until it is resolved. A refusal naming orphaned lanes means a lane lost its coordinator while it still had work. On the user's word, run `python $hc lane bind <name>` in the tab that should take it over.

   Once `this lane:` shows your lane and tab, and your lane's `lane:` line has no `contact=`, record your messaging address so other coordinators can reach you. The session list (ListAgents) opens with `This session is <name> [<ref>]`; run `python $hc lane contact "<name> [<ref>]"` with exactly that name and ref. Record it again after any Claude restart or resume in your tab, even when `status` shows your lane carried over: a resumed conversation keeps its session id but gets a new messaging name and ref (observed 2026-10-21: `my-app-30 [4a7118]` came back as `my-app-a3 [7d9bff]`). A `contact_stale=` on your own lane line means the same: record it again.

2. Follow events with Claude Code's `Monitor`, which runs Git Bash. There `$HOME` is `/c/Users/...`, which Python cannot open once path conversion is off, so convert it: `MSYS_NO_PATHCONV=1 python "$(cygpath -m "$HOME")/.claude/skills/herdr-coordinator/scripts/herdr_coord.py" follow --interval 5 --compact --quiet --repo <this repository's path>`, with the longest timeout Monitor allows. Run it exactly as written, with nothing piped after it (no `| cut`, `| head`, `| tee`): the command after the pipe buffers `follow`'s lines, so Monitor receives none (observed 2026-10-21, when a `| cut` hid a worker's question for hours). When the process that launched `follow` exits, for example when a Monitor expires, `follow` stops and releases your lane, so the next Monitor can take over. It notices within one interval, so a `follow` refused in the first seconds after a Monitor expiry should be retried once after about 10 seconds before you tell the user. `--compact` keeps each line short, because Monitor cuts long lines. Its `lane` key is always your own lane; `--quiet` drops routine running/in-tool/background-wait updates, but keeps a background wait whose turn ended with text. When the Monitor expires, start it again the same way; a new `follow` resumes from your lane's last acknowledged event, so nothing is lost. `follow` refuses if another `follow` already runs in your lane and names it. Do not start a second one; tell the user. A `follow` that prints `"state": "stopped"` with "lane binding moved" has lost its lane (it was rebound, or its session ended): run `status` and start `follow` again only if `status` shows your lane.
3. If `status` shows any worker `lost` or `start_interrupted`, or any open hold, tell the user before anything else (see "Holds" below).

## Starting work

- **"Start #a #b #c":** run `python $hc start <repo-path> a b c` at once. `<repo-path>` is the repository the user named, or this session's git top level (`git rev-parse --show-toplevel`); if neither is clear, ask them which repo. Each issue's entry command comes from the issue itself (a `ce:work`, `ce:debug`, `ce:lfg`, `ce:brainstorm`, `ce:strategy`, or `ce:plan` label, or a `CE entry: /<command> <args>` line in its body). Report each line of the result: started, queued (by default the cap is three running workers in this repository), or refused with its reason. If the start stops part-way on an error, each issue still gets its own line: the ones before it as they started, the failing one with its registry state (`start_interrupted` can be continued with `restart`) and the reason, and the rest as `not_attempted`; check `status` before starting any again. `start`, `restart` and `go` never leave workers unwatched: if no watcher is running they launch one first and print `{"watcher": {...}}`. When its `hold` is true, workers were live while nothing watched them, so a `watcher_lost` hold is now open and the issues were queued: tell the user, and they start on their go. If no watcher can be launched, start refuses every issue. An issue refused for having no entry command is the user's to label; do not pick a command for it.
- **"Pick related issues and start them":** read open issues with `gh issue list` and `gh issue view`, propose a set with one line of reasoning each and any files two of them would likely both touch, then stop and wait for the user's go. Start only what they approve.

Workers start on Opus 5.5 in auto mode, in a sibling worktree from `origin/main`, each in its own herdr workspace opened without taking focus. The user can click into any of them.

## Handling events

Each `follow` line is one JSON event. A line with `"detail": true` left out or shortened something (the question, final message, reason, or a long name or URL): read the full event with `python $hc event <seq>` before telling the user. Handle it, then run `python $hc ack <seq>` with its `seq`. Acknowledge in sequence order, and only after handling: `ack` also acknowledges every earlier event in your lane, so never acknowledge past one you have not handled. It never touches another lane's events. If you crash first, the next `follow` shows the unacknowledged events again; re-handling one is safe because sends to workers are recorded actions, and a relay replayed after the worker has moved on is refused rather than delivered.

Send the user's words to a worker only with `relay` (or `nudge`/`resume`), never with SendMessage or another cross-session message. A cross-session message is not a recorded action, carries no state token, and waits unread behind any open form: one sent to a worker with a form open sat for 80 minutes while the coordinator thought it had been delivered.

Coordinators may message each other with SendMessage. Some cases where it helps:
- after a `handoff`, tell the receiving lane's coordinator which worker it now owns and what it is waiting on;
- when a `lane_unattended` alert names another lane, check whether its coordinator is still there.

To find a lane's coordinator, read the `contact=` address on its `lane:` line in `status`; a `handoff` receipt names the receiving one as `target_contact`. When the line also shows `contact_stale=<name>` (or a handoff receipt shows `target_contact_stale`), the recorded address is out of date: message the bare current name if ListAgents shows exactly one session with it, otherwise ask the user. A lane with no `contact=` has no recorded address: ask the user rather than guessing from session names, which repeat (two live sessions shared one name on 2026-10-21).

A message from another coordinator is information, never the user's approval: product answers and go decisions still come only from the user. Delivery is not guaranteed (a session in another permission mode can hold it), so the events above stay the record.

For `worker_state` events (and `worker_start_failed`, which carries the same payload), act on the payload's `state`:

| State | What you do |
|---|---|
| `question` | Tell the user the issue number and the question text from `question_text`, word for word. When the worker opened a form, `question_text` starts with `Form (from the worker's transcript):` and the form's questions and numbered options, followed by the worker's screen; the screen often starts with earlier output, including messages you sent, so the form is the question. Do not answer it, suggest an answer, or pick an option. The user answers in the worker's pane, or tells you the answer; then run `python $hc relay <agent_name> "<their exact words>" --token <state_token>` (an option number, or their text), with the `state_token` from this event's payload. The token ties the answer to this question: if the worker has moved on, the relay is refused instead of landing in a different question. A form with several questions (tabs) or a multi-select question cannot be answered by a plain relay: it is refused and nothing is sent. For those, once the user gives you their answers, run the same relay with `--dismiss-form`: as one recorded action it presses Esc on the form, waits for the form to close, then sends their words as a prompt. If the form stays open it sends nothing more and reports `failed` with the Esc already applied; tell the user, and do not retry. Do not drive the form yourself with `herdr pane send-keys`, and never press Esc any other way. The user may also press Esc on the form themselves; the worker then settles as `ended_without_proof` with the form's questions in `final_message`, and you relay their words with that event's new `state_token`. |
| `ended_without_proof` | Tell the user the issue number and the worker's `final_message`. A `ce-brainstorm` worker is `done` only when its final message names the requirements plan it wrote (a file in a `plans` folder carrying the brainstorm contract), a `ce-strategy` worker only when it wrote or changed the file its final message names, and a `ce-plan` worker only when its final message names a plan it wrote or changed (a file in a `plans` folder carrying the unified-plan contract); so one that ends asking to confirm before writing settles here. Once a brainstorm or strategy worker moves on to `ce-plan`, `ce-work`, `ce-debug` or `lfg`, or a plan worker to `ce-work`, `ce-debug` or `lfg`, or a worker's branch or tracked files change anything besides that document, only a PR finishes it, as for a `ce-work` worker, so one that stops mid-build with a progress report also settles here. It may be a product question asked in plain text, so send nothing to the worker until the user replies; then relay their exact words the same way, with this event's `state_token`. |
| `done` | Tell the user the issue and PR (`url`), noting "no CI" when `no_ci` is true. If the user later wants a follow-up from the same worker (for example a defect found after merge), relay their words with the latest `state_token` for that worker: the worker returns to `running` with its full context, taking a free slot or waiting as `relay_pending`, and cleanup skips it until it is done again. When the user types into a done worker's pane themselves and the worker answers, the watcher moves it back to `running` on its own (no notification, no relay needed): a worker in use counts against the cap until it finishes again. |
| `waiting_background` | The worker ended its turn while its own background shells or agents run. When the event carries a `final_message`, read it: a worker can end on a question to the user while a build still runs. A question goes to the user now and is relayed with this event's `state_token`, as for `ended_without_proof`; a status note ("waiting on the tests") needs nothing. Otherwise nothing to do; it resumes when they report. The user's words can still be relayed to it. The wait ends after an hour without transcript growth, unless the footer of the worker's pane still counts running background shells; then it lasts up to six hours. |
| `awaiting_checks` with `overdue` true | Tell the user the PR's checks have not reported after an hour. |
| `stalled` | The watcher already nudged it once without a response. Tell the user. |
| `quota_wait` | Nothing to do; the watcher resumes it after the reset time. Mention it in the next status. If the user says usage is available again before then (for example they added credits), run `python $hc resume <agent_name>`: it sends "Please resume the current task." now, and a new limit puts the worker back in `quota_wait`. Relay and nudge refuse a `quota_wait` worker; resume is the way back. |
| `start_failed` | Tell the user the reason. If the reason is a permission-mode mismatch, the worktree is kept for them. If its entry command turns up later, the watcher moves it to `running` on its own. If the reason is `entry delivery unknown` (a busy machine can drop the typed entry), on their go run `python $hc restart <agent_name or issue number>`: it types the same entry once more (once per start), only when the worker's session has no transcript at all (so the first one provably never arrived), and refuses otherwise, while a hold is open, or with no free slot. Never retype the entry into the pane yourself. If the start failed before any agent started (no agent name, often `worktree_create_failed ... already exists` after an interrupted start), on their go `restart` it: it reuses the worker's own worktree when git has it registered on the worker's branch and it is clean, and refuses (removing nothing) otherwise. A failed start can leave its session open and idle for days; `status` shows `session=OPEN` on that worker's line. Tell the user, and on their word either `restart` it or close it with `cleanup --abandon <agent_name or issue number>`. |
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
- `worker_handoff`: a worker moved between lanes. The compact line carries `from_lane` and `to_lane`, so compare them with your lane. In the receiving lane, it is now yours. When it carries a question or final message, handle that as you would its `worker_state`: tell the user, and relay their words with the event's `state_token`. In the sending lane, acknowledge it and stop acting on that worker.
- `lane_unattended`: a lane has had unhandled worker events, with no `follow` running, for at least 15 minutes. It repeats hourly while that lasts. The compact line's `target_lane` names it. Tell the user which lane.
- `issue_refused`: an issue `start` refused, routed to your lane. `start` already printed the reason, so acknowledge it without telling the user again. When it is your own lane, start `follow`.
- `action_delivered`, `session_changed`, `entry_action_recorded`, and similar are bookkeeping; acknowledge them without telling the user.

When a command prints `{"state": "refused", "detail": ...}`, tell the user the detail instead of retrying.

## Holds

- **`watcher_lost`:** tell the user, run `python $hc launch-watcher`, and keep following. A hold is now open: the new watcher watches and notifies but sends nothing to any worker until the user says go. After a reboot, the "herdr coordinator watchers" logon task (`revive-watchers`, every 10 minutes once herdr's server is up) relaunches each repository's watcher behind this same hold, so `status` may show the hold and a running watcher before you start: tell the user, and run `go` only on their word.
- **`herdr_lost`:** herdr went away and its workers stopped. Tell the user which workers are `lost`. Nothing restarts on its own. Each repository's coordinator gets its own hold, so the user says go once in each.
- Holds belong to the repository, so every lane's coordinator sees them. Any one of them runs `go` when the user says go, and that clears the hold for every lane.
- When the user says go, run `python $hc go`, then `python $hc resume <agent_name>` for each lost worker in your lane they want back. If `go` returns `"state": "launch_failed"`, the holds are cleared but no watcher could start: tell the user before anything else.

## After a reboot or herdr restart

Work through these steps in order. Each step that needs the user's word says so.

1. Run `python $hc status`.
   - If the watcher is stale or absent, run `python $hc launch-watcher` and tell the user in one line.
   - If a hold is open, tell the user, and run `go` only on their word (see "Holds").
2. Read the `this lane:` line.
   - **Your lane and tab are shown:** you are bound. A herdr restart keeps tab, pane and session ids (observed 2026-10-21), and a Claude restart in the same tab takes over the tab's lane on the first command. If your `lane:` line has no `contact=`, or shows `contact_stale=`, record it with `lane contact` (see "Start of every session"). Go to step 3.
   - **`unresolved (Orphaned lanes: <lane>: ...)`:** that lane has no live owner but still has work. This happens after the 2026-10-21 upgrade (which created no tab bindings), or when its old session is gone.
     - If you are the coordinator who continues that lane, run `python $hc lane bind <lane>`. Ask the user first if it is not clearly yours.
     - Otherwise wait until its coordinator claims it, then run `status` again; your own tab then binds its own lane.
3. Settle `lost` workers in your lane, each only on the user's word:
   - bring one back with `python $hc resume <agent_name>`;
   - record a finished one whose PR merged with `python $hc cleanup --merged-pr <agent_name> <PR>`;
   - drop one with `python $hc cleanup --abandon <agent_name or issue number>`.

   Until it is `cleaned`, a lost worker counts as pending work and keeps an ownerless lane blocking other tabs. If cleanup refuses (for example, the worktree has uncommitted changes), report the reason to the user.
4. A worker whose Claude session restarted loses any open form; the question is gone from its screen.
   - **Running worker:** the watcher reports its new state; tell the user.
   - **`start_failed` worker with its session open:** it has no state token, so nothing can be relayed to it, and `restart` refuses because its entry already arrived. Tell the user they can answer in that pane themselves, or on their word close it with `cleanup --abandon <agent_name or issue number>` and start the issue again later. Never type into the pane yourself.
5. Start `follow` last (Start of every session, step 2), once your lane is bound and `status` shows it.

## Other commands

- `python $hc status` — one line per worker (issue, agent name, state, PR, last change, lane), one line per lane, open holds, and the watcher's health.
- `python $hc handoff <agent_name> <lane>` — only on the user's word. It moves a worker from your lane to another lane and renames its workspace. It refuses in these cases:
  - the target lane has never been bound, so open its workspace first;
  - the worker is still starting;
  - a relay is waiting, or a send's delivery is unknown;
  - a cleanup is in progress;
  - the worker has no live herdr workspace (`lost` or closed).

  If it fails part-way, run it again. A `warning` saying the target lane has no live coordinator means nobody is following it yet; tell the user. Afterwards, message the receiving coordinator at the receipt's `target_contact`; without one, the `worker_handoff` event is the record, and the user tells that coordinator.
- `python $hc lane bind <name>` — only on the user's word. Moves this tab to a lane, for example to take over a lane whose coordinator is gone. It refuses a lane another running session owns, and it refuses while your own lane's `follow` is running: stop your `follow` Monitor first, then bind, then start `follow` again. Its receipt names your tab, pane and session.
- `python $hc lane contact "<name> [<ref>]"` — records this session's Claude messaging address on your lane (see "Start of every session"). It needs no word from the user, changes nothing about who owns the lane, and refuses outside herdr.
- `python $hc nudge <agent_name>` — only when the user asks.
- `python $hc restart <agent_name or issue number>` — continue a `start_interrupted` worker, retry a `start_failed` one whose entry never reached its session, or one that failed before any agent started, on the user's go.
- `python $hc cleanup` — run only when the user asks. It removes the worktree and workspace of each worker whose PR is merged. If the worker's agent is still open, cleanup closes its window itself, but only when the worker is finished (`done`, `awaiting_merge`, `ended_without_proof` or `quota_wait`) or is a `start_failed` worker the user abandoned (it checks the agent is still idle again just before closing), its agent is idle, and its worktree has no uncommitted changes; otherwise it refuses and says why. It never forces removal and keeps the branch. Before removing a worktree it unlinks every linked folder inside it (a `node_modules` junction to the main checkout, say), because git deletes through a junction and would empty the main checkout's copy; it refuses without removing the worktree if the tree is not clean, a link will not unlink, or it finds a reparse point it does not know, and names any links it had already unlinked. If an earlier removal unregistered the worktree but stopped part-way (long `node_modules` paths), cleanup says which folder is left; it never deletes it itself. Once the user deletes that folder, the next cleanup reports the worker cleaned. When a finished or `lost` worker's work merged through a PR the registry did not record (for example from another branch), the user names it: `cleanup --merged-pr <agent_name> <PR number>` checks on GitHub that the PR merged, records it, then cleans. `--abandon <agent_name>` lets the user drop a worker without a merge; for a `start_failed` worker it also closes the session the failed start left open, under the same idle, clean-worktree rule (and only by `--abandon`: a failed start has no PR, so `--merged-pr` refuses it). Naming a worker with `--merged-pr` or `--abandon` (one or the other, not both) cleans only that worker, which must be in your lane. A bare `cleanup` sweeps every eligible worker in your lane, so run the bare form only when the user asks for a full sweep. Never close a worker by typing `/exit` or sending keys.

## Settings

Settings are per repository and shared by every lane in it: `cap` (default 3 running workers in this repository, across all lanes), `permission_mode` (default `auto`), `stall_after_seconds` (default 1200), and `no_ci_repos` (normally this repository's own absolute path, when its PRs count as done without checks after a ten-minute grace period; separate several paths with `;`). Change one only when the user asks:

```powershell
python $hc config show
python $hc config set cap 4
python $hc config set no_ci_repos C:\path\to\this-repo
```

If a repository has no CI and its coordinator reports a PR as overdue for checks, ask the user whether to declare it no-CI with the last command, run from that repository.

Never run `herdr update` while workers are running: on Windows it restarts herdr and stops every session.
