# Workflow

Evidence for specific claims in my portfolio, not a mirror of my working tools.

These notes cover my personal AI coding workflow. I use agents to investigate and implement changes. That creates coordination work of its own: findings need to become actionable issues, the backlog needs an order, workers need supervision, and unfinished work needs preserving.

Four tools handle those recurring tasks. They form a working loop, with human decisions between the stages:

**Findings → AI intake → issue backlog → sorter → coordinator → worktrees → cleanup**

| Tool | The problem I use it to solve | Start here |
| --- | --- | --- |
| [AI intake](ai-intake/) | Turn findings into issues without losing their evidence or blindly creating duplicates. | [A finding with conflicting matches](ai-intake/README.md#worked-example) |
| [Sorter](sorter/) | Decide what belongs in the next working set against a concrete product milestone. | [The formula and the rules around it](sorter/METHOD.md) |
| [Herdr coordinator](herdr-coordinator/) | Run parallel workers and bring the decisions that need me back to one place. | [An answer whose delivery is uncertain](herdr-coordinator/README.md#worked-example) |
| [Worktree cleanup](worktree-cleanup/) | Clear abandoned checkouts while preserving work I may still need. | [An idle-looking tree that must stay](worktree-cleanup/README.md#worked-example) |

For the method behind these tools, read **[How I use Compound Engineering](compound-engineering/README.md)**: how I divide model responsibilities, review changes, keep product scope explicit, and improve the workflow from experience.

For the research that comes before a change, read [How I investigate product workflows](product-investigation/README.md): choose a bounded question, follow an action through its saved result, and leave evidence another session can use.

## Product code excerpt

[Grantsville funder check](grantsville-funder-check/) is not a workflow tool. It is a read-only excerpt of product code from Grantsville, my grant-application tool for small nonprofits: the rule that decides when its funder check recommends not applying, with its tests.

## How I divide the work

Models assess evidence and propose actions. Code checks what those actions are allowed to change, records attempts, and checks the result. I keep product choices, milestone definitions, exceptional approvals, and merges with the operator. The individual READMEs explain those boundaries. The coordinator's README also links to its source and tests.

The sorter makes one of my tradeoffs explicit: **value gets more weight than ease, milestone blockers get special treatment, and a new score alone does not churn the current working set.** Its [method](sorter/METHOD.md) includes the arithmetic, model agreement rules, capacity limits, and a worked backlog.

## In use

I use and refine this workflow across Windows and macOS. The sorter makes my prioritization rules explicit. Intake carries evidence and acceptance criteria into the backlog. The coordinator manages worker handoffs, and cleanup checks activity and recovery conditions before removing a checkout.

The coordinator is published with its source and tests as a sanitized reference snapshot. Intake, the sorter and cleanup are published as design notes; their full implementations are private. Intake also includes a [read-only excerpt of its automatic-action qualification rules](ai-intake/excerpt/README.md). A short [usage note](results/2026-10-27.md) records activity from the deployed tools.

The [November 24 workflow update](compound-engineering/README.md) explains how I keep rules in one authoritative place and revise model assignments using evidence. A [five-task worker replay](results/2026-11-24-worker-selection.md) informed the latest routine model setting. The [coordinator's development notes](herdr-coordinator/README.md#newer-development-workflow) describe a fixer lane that selects eligible issues and ends at draft PRs for my review. The cleanup folder describes the earlier implementation and [its replacement](worktree-cleanup/CURRENT.md).

## Borrowing the ideas

I originally built these for my own workflow on **Windows 11** and now also work on macOS. The published coordinator snapshot retains its Windows assumptions. I'm sharing the methods so you can borrow the ideas, learn from the decisions, and adapt useful parts. They aren't designed to be copied directly into another setup: they assume particular tools, repository conventions, and ways of working.

Each tool folder has an overview and a worked example. The coordinator folder also has its source, tests, and an adaptation guide. Its tests use constructed data and documented, sanitized producer captures. The usage note contains aggregate counts; raw journals and private issue text remain private.

Start with a tool's overview. For the coordinator, follow its adaptation guide; installing its dependencies does not schedule jobs or enable GitHub writes.
