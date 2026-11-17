# AI intake

I use this to turn findings from plans, audits, and agent work into GitHub issues. A useful finding needs a traceable source, a clear outcome, and a check against existing work before it becomes another item in the backlog.

A producer writes a structured candidate file with the outcome, evidence, and source identity. Intake checks that evidence, compares the candidate with existing work, and prepares a new issue, supporting evidence for an existing issue, or a hold. Models assess the material; validated execution plans and the transport determine what may be written.

This folder keeps the design notes for a tool whose source is private: how it works, a worked example, and why it is built this way. The [excerpt/](excerpt/) folder publishes the auto-close bar (`action-qualification.ts`) for reading.

## Worked example

Constructed illustration of a regression test, not a live issue record.

| Stage | What happens |
| --- | --- |
| Finding | A candidate requests a fix for an export failure and carries its source marker. |
| Existing work | The same marker appears on two existing issues. |
| Decision | Intake returns a hold because it cannot choose one authoritative match. |
| Result | No GitHub mutation occurs, and the execution claim is released. The operator must resolve the ambiguous match. |

The benefit is avoiding another issue while the identity of the existing work is unclear. The filing test `surfaces a deterministic duplicate-marker hold and releases its claim` checks this.

A separate crash-recovery test records intent, simulates a stopped process, and checks the next run. If it finds the created issue, it reconciles the attempt without creating another one. If it cannot resolve the outcome, it records `create_unresolved`. That test is `reconciles a crash after create intent`.

## Why it is built this way

- **Bind findings to evidence.** A candidate names its source and revision so a recommendation can be checked against the repository it describes. A plausible duplicate or insufficient evidence can produce a hold.
- **Record intent before the external write.** A lost response does not tell us whether GitHub created the issue. The durable journal gives a later run something to reconcile.
- **Separate recommendation from permission.** Approval and execution checks determine whether a write is allowed. Concurrent workers share claims so they cannot independently consume the same authority.

## What I keep manual

I resolve ambiguous matches and product choices and review operations that require explicit approval. The automatic filing capability is disabled. A successful assessment or dry run does not grant write authority.

## In use

I use the agent-invoked filing path during development sessions. It carries source evidence and authored acceptance criteria into tracked work, with ambiguous matches held for review. Fully unattended filing remains disabled pending validation. See the [usage note](../results/2026-10-27.md) for a dated snapshot.

## Explore or adapt

Borrow the evidence and recovery patterns. The source, tests, and setup instructions are private.
