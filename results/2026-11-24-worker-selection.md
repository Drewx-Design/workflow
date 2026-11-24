# Choosing a routine implementation model

[Workflow method](../compound-engineering/README.md) · [Notes index](README.md)

On November 20, I chose `gpt-6.2-sol` at `high` for routine detached implementation workers. A replay of five past tasks informed that decision. I keep senior architectural review as a separate assignment.

## The comparison

Each model received the original brief and starting revision for each task in a fresh worktree. The acceptance rule was written before outputs were read: the brief's tests, lint and type checks on touched files, scope compliance, and a host review against the requested behavior. Tests added during the original PR's later reviews were scored separately.

| Recorded result across five tasks | Requested 6.2 Sol, high | Requested 6.1 Sol, xhigh |
| --- | ---: | ---: |
| Accepted under the stated rule | 5 of 5 | 4 of 5 |
| Total wall time | 12.4 minutes | 16.6 minutes |
| Output tokens | 26.8 thousand | 40.8 thousand |

The acceptance difference came from one comparison of stored objects: key order should not make unchanged data appear changed. The older model followed an example in the brief that could produce that mistake. Treating that hint as an excuse would make acceptance five of five for both models. The timing and token observations remain the same.

## What I took from it

The replay supported trying the new routine setting with comparable acceptance and lower observed time and output tokens. It did not establish a general quality advantage. There was one run per model per task, all five tasks came from one subsystem, and other jobs shared the machine. Both models missed some requirements introduced by later reviews, which is one reason implementation and review remain separate.

The runs used the detached Codex job harness. Requested and client-resolved settings matched; the serving model identity was not attested. Wall time and token counts describe these runs, not subscription cost savings or end-to-end delivery speed.

Source: my private November 20 worker-replay report, its predeclared acceptance rule, host checks, and per-job records; summarized November 24. The task identifiers, briefs, and project code remain private.
