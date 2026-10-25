# Herdr coordinator

A Claude Code skill that runs parallel Claude Code workers in [herdr](https://herdr.dev), one per GitHub issue. I use it to keep track of workers without repeatedly inspecting each terminal and to bring their questions back to me.

One Claude session acts as coordinator. Given `start #12 #15 #18`, it opens a workspace, branch, and sibling worktree for each issue, starts workers in auto mode, and hands them their entry commands. A detached watcher follows progress and reports questions, finished PRs, stalls, and quota waits. Multiple coordinators can share a repository through separate, session-owned lanes.

## Worked example

Constructed illustration of the delivery tests, not a live worker conversation.

1. A worker asks whether an export should include archived items. The coordinator surfaces the question and its current state token.
2. I answer “Only active items.” The relay checks that the answer still belongs to that worker, lane, and question.
3. The send is recorded, but delivery cannot be confirmed. The action becomes `delivery_unknown`; it is not automatically sent again.
4. If a later transcript confirms delivery, the existing action is reconciled. Otherwise it remains uncertain and blocks further sends until resolved.

This avoids treating “I did not receive a confirmation” as “the worker did not receive the answer.” See [worker actions](scripts/actions.py) and the tests `test_uncertain_text_step_stays_unknown_and_blocks_later_sends` and `test_relay_confirms_a_delivered_unknown_action_instead_of_refusing` in [test_actions.py](tests/test_actions.py).

## Why it is built this way

- **Read producer evidence, not just screen status.** A pane can look idle while a worker is quota-limited, and completion status can change when viewed. Transcripts carry the authoritative session evidence, with captured form/screen handling where a pending question is absent from the transcript. See [transcript handling](scripts/transcript.py) and [producer observations](tests/fixtures/README.md).
- **Bind answers to the question they answer.** A relay carries a state token. Unsupported forms are refused and open holds stop sends. This makes the boundary mechanical rather than relying only on an instruction to the coordinating model. See [actions](scripts/actions.py) and [lane ownership](scripts/lanes.py).
- **Record uncertainty and restore supervision.** Sends are recorded before delivery; uncertain sends are not blindly retried. `start`, `restart`, and `go` bring up a missing watcher first. A `watcher_lost` hold remains until the operator acknowledges it. See [start](scripts/start.py) and [watcher](scripts/watch.py).

## What I keep manual

The coordinator does not perform the worker's task, answer product questions for me, or merge PRs. I supply decisions and authorize continuation after holds. Cleanup of merged work is available on request.

## Evidence and limits

The [operating record](../results/2026-10-18-to-24.md) shows 22 distinct workers entering the start flow in one repository during a week. It also records four distinct workers with start failures, 25 actions reaching uncertain delivery, and 23 of those actions later confirmed delivered by the cutoff. These are operating observations, not a count of shipped features.

The [fixture notes](tests/fixtures/README.md) document actual producer behavior that changed the implementation, including question forms appearing differently across Claude Code versions. The tests combine sanitized captures with constructed scenarios. This integration needs maintenance as the producer formats change.

## Explore or adapt

Built and run on Windows 11. Borrow the coordination patterns and adapt the tool and workflow assumptions. [Requirements, installation, tests, state locations, and recovery](ADAPTING.md) are in the adaptation guide.
