# Sorter

I use this to order a GitHub backlog against the next product milestone. A severity label alone cannot tell me whether to fix a blocker, build a valuable feature, or spend time on the tools that make the rest possible.

The sorter separates those questions. Two model families assess the evidence; deterministic code merges their assessments, compiles the working set, and prepares field changes. The code decides timing rather than asking a model to choose “Now”.

## The ranking method

For ordinary eligible product improvements:

**Score = Value² × Ease / 10**

Value is 1–10 against the milestone. Ease is **4 for low effort, 3 for medium, and 2 for high**. A value-8, high-effort improvement scores **12.8**; a value-5, low-effort improvement scores **10**. This gives meaningful improvements room to outrank easy polish.

The score is one input. Milestone blockers, verified emergencies, existing work, explicit pins, and a tooling allocation have their own rules. Severity stays separate from value, and scope stays separate from whether work is already done.

Read [How I sort issues](METHOD.md) for the full decision sequence, model merge rules, capacity limits, and tradeoffs.

## Worked example

Constructed illustration, not a customer result. Assume current evidence, no dependency blockers, no pins or existing working set, and agreement on the classifications.

| Issue | Milestone relationship | Value | Effort | Score | Result in this example |
| --- | --- | ---: | --- | ---: | --- |
| Fix the failing export action | Blocks the milestone | 7 | High | 9.8 | Now, through the blocker rule |
| Resume an interrupted draft | In scope, not blocking | 8 | High | 12.8 | Now, through the formula |
| Clarify the save confirmation | In scope, not blocking | 5 | Low | 10 | Now, after the higher-value improvement |
| Add a second export format | Outside this milestone | 9 | Low | 32.4 | Parked despite the larger score |

The intended outcome is a working set that supports the release, rather than a list sorted only by easy wins. [The implementation](scripts/lib/github-issue-roadmap/stewardship-backlog.ts) makes those exceptions inspectable.

## Why it is built this way

- **Separate value, severity, and scope.** An attractive feature is not automatically an emergency. An already-fixed issue is not automatically outside the milestone. These are different facts with different consequences. See the [assessment rubric](scripts/lib/github-issue-roadmap/stewardship-assessment.ts).
- **Keep disagreement visible.** Value estimates are averaged, adjacent effort estimates resolve to the larger effort, and conflicting categories remain unknown. Missing evidence is not a low score. The [merge tests](scripts/__tests__/roadmap-stewardship-assessment.test.ts) cover these distinctions.
- **Make reprioritization stable.** A new score alone does not evict current work. Explicit pins and verified emergencies have separate treatment. After a write timeout, the executor observes the result instead of blindly sending the write again. See [backlog compilation](scripts/lib/github-issue-roadmap/stewardship-backlog.ts) and [execution](scripts/lib/github-issue-roadmap/stewardship-executor.ts).

## What I keep manual

I define the milestone and its anchors, decide unresolved product choices, and review the snapshot where approval is required. The sorter can flag done or stale work; it does not close issues. Human Horizon and Effort pins are distinct from the computed Sort key, which the sorter owns.

## Evidence and limits

The [operating record](../results/2026-10-18-to-24.md) includes 165 distinct assessed issues and 298 confirmed action outcomes out of 299 attempted actions during one week. Most runs were partial; the record includes that denominator and the unresolved action. These counts establish use, not ranking quality.

The formula encodes a preference, not a validated estimate of business return. Squaring a noisy value estimate can amplify its error. There is not yet a published comparison against a simpler ranking method.

## Explore or adapt

Built for my Windows 11 workflow. Borrow the method and adapt the assumptions; this is not a drop-in backlog service. [Tests, setup, credentials, commands, and scheduling](ADAPTING.md) are in the adaptation guide. The [sample milestone](examples/milestone-1.md) shows the input you would replace.
