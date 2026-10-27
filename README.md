# Workflow

Tools for my personal AI coding workflow. I use agents to investigate and implement changes. That creates coordination work of its own: findings need to become actionable issues, the backlog needs an order, workers need supervision, and unfinished work needs preserving.

These tools handle those recurring tasks. They form a working loop, with human decisions between the stages:

**Findings → AI intake → issue backlog → sorter → coordinator → worktrees → cleanup**

| Tool | The problem I use it to solve | Start here |
| --- | --- | --- |
| [AI intake](ai-intake/) | Turn findings into issues without losing their evidence or blindly creating duplicates. | [A finding with conflicting matches](ai-intake/README.md#worked-example) |
| [Sorter](sorter/) | Decide what belongs in the next working set against a concrete product milestone. | [The formula and the rules around it](sorter/METHOD.md) |
| [Herdr coordinator](herdr-coordinator/) | Run parallel workers and bring the decisions that need me back to one place. | [An answer whose delivery is uncertain](herdr-coordinator/README.md#worked-example) |
| [Worktree cleanup](worktree-cleanup/) | Clear abandoned checkouts while preserving work I may still need. | [An idle-looking tree that must stay](worktree-cleanup/README.md#worked-example) |

## How I divide the work

Models assess evidence and propose actions. Code checks what those actions are allowed to change, records attempts, and checks the result. I keep product choices, milestone definitions, exceptional approvals, and merges with the operator. The individual READMEs explain those boundaries and link to source and tests.

The sorter makes one of my tradeoffs explicit: **value gets more weight than ease, milestone blockers get special treatment, and a new score alone does not churn the current working set.** Its [method](sorter/METHOD.md) includes the arithmetic, model agreement rules, capacity limits, and a worked backlog.

## In use and still improving

The deployed tools have produced **143 confirmed board writes** under the sorter's adopted policy and **327 issues carrying the intake marker**. Cleanup recorded **19 completed removals and one removal with pruning deferred** across seven runs reviewed in October. These are different kinds of activity, with different observation windows; they do not measure time saved or ranking quality. The [October operating record](results/2026-10-27.md) gives the definitions, failures, and remaining work.

I also built an **Easy-Issue Autopilot**, then paused its development after calibration exposed both unclear acceptance criteria and gaps in its verification pipeline. The [case study](case-studies/easy-issue-autopilot.md) explains the one verified behavior fix, what human review caught, and the conditions for restarting it.

These records describe the evolving tools in my own environment. The source kits here are sanitized reference snapshots; their manifests identify the exported source revision.

## Borrowing the ideas

I built these for my own workflow on **Windows 11**. I'm sharing them so you can borrow the ideas, learn from the decisions, and adapt useful parts. They aren't designed to be copied directly into another setup: they assume particular tools, repository conventions, and ways of working.

Each folder has an overview, worked example, source, tests, and an adaptation guide. The three newer source kits use `example-org/example-repo` and `example-user`. They omit credentials, personal settings, private captures, and live operational journals. Their examples and included tests use constructed data; the coordinator also has documented, sanitized producer captures. The operating record and case study contain sanitized summaries; raw journals and private issue text remain private.

Installing dependencies does not schedule jobs or enable GitHub writes. Start with the overview, then follow the adaptation guide for a tool you want to explore.
