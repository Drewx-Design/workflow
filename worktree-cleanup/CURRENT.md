# How I handle worktree cleanup now

[Earlier source snapshot](README.md) · [Workflow method](../compound-engineering/README.md)

As of November 13, I use a machine-wide sweep in place of the earlier storage-manager workflow. It discovers repositories under configured roots and examines their registered worktrees. Agents mark finished work; the sweep owns removal. This keeps each worker from having to manage its own cleanup process.

## Completion and recovery

A session can record who created a worktree and what it was for. When the work is finished, it can add a done mark tied to the tree's state. The sweep also considers work whose newest file and HEAD commit are both at least 14 days old, subject to its activity and preservation checks.

Merged, clean, inactive worktrees can be removed while their branches remain. Eligible unfinished work takes a recovery path first: tracked and untracked work is committed to a local `salvage/` branch, including otherwise unreachable commits recorded in Git's reflog. Ignored files that are not rebuildable caches are moved into a recovery folder. The report records where the work went. Recovery branches and saved files are not automatically deleted.

To restore that work, create a checkout from the recorded recovery branch and copy back any saved files. This gives preservation a concrete endpoint: a branch and files the operator can inspect and restore.

## Where the sweep stops

Activity, open PRs, locks, incoming links, protected paths, or uncertain state can keep a worktree in place. An eligible retained tree may still have rebuildable caches cleared. Before acting, the sweep checks current Git, process, link, and job evidence again. Transcript activity is refreshed periodically, so that signal has a freshness limit.

Morning reports distinguish removals, cache clearing, preserved work, and holds. I use those reports to inspect exceptions. The sweep is still under development; this page describes its design and current local implementation, without claiming sustained unattended reliability or measured time savings.

## Borrowing the approach

The useful pieces to adapt are explicit ownership, a completion signal, one place responsible for removal, and a documented recovery path. The source in this public folder is the earlier implementation. Its October usage counts and installation guide belong to that version; the replacement sweep has not yet been exported here.
