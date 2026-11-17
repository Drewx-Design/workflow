# Worktree cleanup

**Earlier implementation.** This folder keeps the design notes for my previous cleanup tool; its source is private. I have since replaced the storage-manager workflow with a machine-wide sweep. Read [the current approach](CURRENT.md) for owner records, explicit completion marks, and recovery before removal. The replacement's source is private too; the walkthrough below describes the earlier tool.

Parallel agent work leaves branches, linked worktrees, and unfinished files behind. I use this tool to inspect that work before deciding what can be removed. A quiet directory alone does not establish that its work is finished or recoverable.

The tool checks repository identity, Git state, process and session activity, leases, links, and recovery evidence. Eligible dirty work can take a rescue or archive path. Unknown state is held for inspection. Removal rechecks its evidence immediately before acting.

## Worked example

Constructed illustration based on the policy tests, not a report of a live removal.

| Observation | Decision | Outcome |
| --- | --- | --- |
| A linked worktree has an untracked source file; the required idle evidence is unknown. | Hold it with the `leftovers` reason. | The worktree stays in place. |
| A different tree contains staged changes, satisfies the other checks, and has affirmative idle evidence. | Choose the archive path. | Preservation must complete and pass the removal checks before deletion can proceed. |
| That otherwise archivable tree has a dangling junction or a self-link. | Hold it. | Idle evidence does not override an unsafe link. |

The policy tests cover `snapshotFallback`, staged changes, and link holds. The removal implementation and its tests cover the later boundary; a plan to archive is not proof that archiving or removal succeeded.

## Why it is built this way

- **Unknown is a reason to stop.** Missing process, session, identity, or Git evidence cannot establish that a tree is safe to remove.
- **Preserve recoverable work before removing its checkout.** Rescue, archives, and scratch snapshots serve different kinds of leftovers. Admission checks also look for material that should not be published.
- **Check again at the destructive boundary.** A tree can change after inventory. Removal has its own checks rather than treating an earlier plan as sufficient.

## What I keep manual

I decide whether to commission scratch publication, install the schedule, release work explicitly, or investigate a hold. A live run can publish rescue commits and PRs and remove eligible trees; it is different from a diagnostic dry run. Recovery uses the command and evidence recorded with the archive.

## In use

I used this implementation on my Windows development environment. Its reports distinguish completed removals from proposed actions and holds, and preserve recovery information where applicable. See the [usage note](../results/2026-10-27.md) for recorded outcomes from this version.

## Explore or adapt

Borrow the preservation and refusal rules. The source, tests, and setup instructions are private.
