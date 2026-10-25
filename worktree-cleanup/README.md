# Worktree cleanup

Parallel agent work leaves branches, linked worktrees, and unfinished files behind. I use this tool to inspect that work before deciding what can be removed. A quiet directory alone does not establish that its work is finished or recoverable.

The tool checks repository identity, Git state, process and session activity, leases, links, and recovery evidence. Eligible dirty work can take a rescue or archive path. Unknown state is held for inspection. Removal rechecks its evidence immediately before acting.

## Worked example

Constructed illustration based on the policy tests, not a report of a live removal.

| Observation | Decision | Outcome |
| --- | --- | --- |
| A linked worktree has an untracked source file; the required idle evidence is unknown. | Hold it with the `leftovers` reason. | The worktree stays in place. |
| A different tree contains staged changes, satisfies the other checks, and has affirmative idle evidence. | Choose the archive path. | Preservation must complete and pass the removal checks before deletion can proceed. |
| That otherwise archivable tree has a dangling junction or a self-link. | Hold it. | Idle evidence does not override an unsafe link. |

See the cases around `snapshotFallback`, staged changes, and link holds in the [policy tests](scripts/__tests__/worktree-cleanup-policy.test.ts). The [removal implementation](scripts/lib/worktree-cleanup/remove.mjs) and [removal tests](scripts/__tests__/worktree-cleanup-remove.test.ts) cover the later boundary; a plan to archive is not proof that archiving or removal succeeded.

## Why it is built this way

- **Unknown is a reason to stop.** Missing process, session, identity, or Git evidence cannot establish that a tree is safe to remove. See [activity collection](scripts/lib/worktree-cleanup/activity.mjs) and [policy](scripts/lib/worktree-cleanup/policy.mjs).
- **Preserve recoverable work before removing its checkout.** Rescue, archives, and scratch snapshots serve different kinds of leftovers. Admission checks also look for material that should not be published. See [admission](scripts/lib/worktree-cleanup/admission.mjs), [archives](scripts/lib/worktree-cleanup/archive.mjs), and [snapshots](scripts/lib/worktree-cleanup/snapshot.mjs).
- **Check again at the destructive boundary.** A tree can change after inventory. Removal has its own checks rather than treating an earlier plan as sufficient. See [removal](scripts/lib/worktree-cleanup/remove.mjs) and [safe-path tests](scripts/__tests__/worktree-cleanup-safe-path.test.ts).

## What I keep manual

I decide whether to commission scratch publication, install the schedule, release work explicitly, or investigate a hold. A live run can publish rescue commits and PRs and remove eligible trees; it is different from a diagnostic dry run. Recovery uses the command and evidence recorded with the archive.

## Evidence and limits

In the [recorded week](../results/2026-10-18-to-24.md), nine live runs observed 248 distinct worktree paths. Two completed with holds, five ended at a deadline, and two had a failed outcome. Those results make throughput and diagnosable holds the next improvement target. They are not a claim of unattended reliability.

The sanitized export was checked with focused policy, admission, path, encoding, and credential-fixture tests; its complete Windows integration suite was not completed during export verification. Windows activity readers and junction behavior are specific to my setup.

## Explore or adapt

Built for my Windows 11 workflow. Borrow the preservation and refusal rules; adapt the activity sources and recovery policy before using the code. [Tests, setup, dry runs, scheduling, and recovery commands](ADAPTING.md) are in the adaptation guide. Read the scheduler section before installation: the installer's non-preview path registers an enabled task.
