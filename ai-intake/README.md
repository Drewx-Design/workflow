# AI intake

I use this to turn findings from plans, audits, and agent work into GitHub issues. A useful finding needs a traceable source, a clear outcome, and a check against existing work before it becomes another item in the backlog.

A producer writes a structured candidate file with the outcome, evidence, and source identity. Intake checks that evidence, compares the candidate with existing work, and prepares a new issue, supporting evidence for an existing issue, or a hold. Models assess the material; validated execution plans and the transport determine what may be written.

## Worked example

Constructed illustration of an included regression test, not a live issue record.

| Stage | What happens |
| --- | --- |
| Finding | A candidate requests a fix for an export failure and carries its source marker. |
| Existing work | The same marker appears on two existing issues. |
| Decision | Intake returns a hold because it cannot choose one authoritative match. |
| Result | No GitHub mutation occurs, and the execution claim is released. The operator must resolve the ambiguous match. |

The benefit is avoiding another issue while the identity of the existing work is unclear. The test named `surfaces a deterministic duplicate-marker hold and releases its claim` checks this in [the filing tests](scripts/__tests__/github-issue-roadmap-file-finding.test.ts).

A separate crash-recovery test records intent, simulates a stopped process, and checks the next run. If it finds the created issue, it reconciles the attempt without creating another one. If it cannot resolve the outcome, it records `create_unresolved`. Search the same test file for `reconciles a crash after create intent`.

## Why it is built this way

- **Bind findings to evidence.** A candidate names its source and revision so a recommendation can be checked against the repository it describes. A plausible duplicate or insufficient evidence can produce a hold. See [filing orchestration](scripts/github-issue-roadmap-file-finding.ts).
- **Record intent before the external write.** A lost response does not tell us whether GitHub created the issue. The durable journal gives a later run something to reconcile. See the [execution journal](scripts/lib/github-issue-roadmap/intake-execution-journal.ts) and its [tests](scripts/__tests__/github-issue-roadmap-intake-execution-journal.test.ts).
- **Separate recommendation from permission.** Approval and execution checks determine whether a write is allowed. Concurrent workers share claims so they cannot independently consume the same authority. See the [GitHub transport](scripts/lib/github-issue-roadmap/github-intake-approval-transport.ts).

## What I keep manual

I resolve ambiguous matches and product choices and review operations that require explicit approval. The exported automatic capability manifest is disabled. A successful assessment or dry run does not grant write authority.

## Evidence and limits

The [operating record](../results/2026-10-18-to-24.md) contains 64 matching intent/completion pairs for issue creation during one week, covering 64 distinct issues. This shows recorded execution, not that every issue was useful or that every candidate reached this journal. The source kit's included tests use constructed evidence; private captures and calibration records are omitted.

The system is deliberately coupled to a candidate schema, repository evidence conventions, and a review process. That setup cost only makes sense if the volume of findings justifies it.

## Explore or adapt

Built for my Windows 11 workflow. Borrow the evidence and recovery patterns; adapt the repository assumptions before using the code. [Tests, setup, credentials, candidate commands, and execution instructions](ADAPTING.md) are in the adaptation guide.
