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

## Development status

As of October 25, 2026, these tools are still being tested and refined. The new sorter was completed this week and is awaiting its first operational run. The source, tests, and worked examples show the design and implemented behavior; validated operating results are not yet available for the current versions.

I plan to add results after running and debugging these versions, with a clear observation period, version, outcomes, and remaining failures. See [development status and future measurement](results/README.md).

## Borrowing the ideas

I built these for my own workflow on **Windows 11**. I'm sharing them so you can borrow the ideas, learn from the decisions, and adapt useful parts. They aren't designed to be copied directly into another setup: they assume particular tools, repository conventions, and ways of working.

Each folder has an overview, worked example, source, tests, and an adaptation guide. The three newer source kits use `example-org/example-repo` and `example-user`. They omit credentials, personal settings, private captures, and live operational journals. Their examples and included tests use constructed data; the coordinator also has documented, sanitized producer captures. Future published operating results will contain sanitized summaries only.

Installing dependencies does not schedule jobs or enable GitHub writes. Start with the overview, then follow the adaptation guide for a tool you want to explore.
