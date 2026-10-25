# Workflow

Tools from my personal AI coding workflow. I use these to coordinate agents, turn findings into issues, sort the backlog, and clean up worktrees.

| Tool | What it does |
| --- | --- |
| [herdr coordinator](herdr-coordinator/) | Starts parallel Claude Code workers in herdr, follows their progress, and brings questions back to me. |
| [AI intake](ai-intake/) | Turns structured findings into GitHub issues or updates to existing issues, with evidence checks and a record of each write. |
| [Sorter](sorter/) | Assesses open issues against a milestone, proposes an order, and applies approved changes to GitHub issue fields. |
| [Worktree cleanup](worktree-cleanup/) | Checks linked worktrees for activity and recoverable work before archiving, rescuing, or removing them. |

I built these tools for my own workflow on Windows 11. I'm sharing them so you can borrow the ideas, learn from the decisions, and adapt the parts that are useful to you. They aren't designed to be copied directly into another setup: the code assumes particular tools, repository conventions, and ways of working.

Each folder has its own README, source, and tests. Start with how the tool works and why it makes those choices. The setup notes describe what would need adapting if you want to use the code yourself.

The examples use `example-org/example-repo` and `example-user`. Personal settings, credentials, live journals, private issue captures, and operational reports are not included in the intake, sorter, or cleanup examples. Tests that require those private captures are excluded; the included tests use constructed fixtures. The tools keep their original refusal and recovery rules.

Start with a tool's README. Installing dependencies does not schedule jobs or enable GitHub writes.
