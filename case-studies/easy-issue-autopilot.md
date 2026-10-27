# Easy-Issue Autopilot: what I kept and why I paused it

[Back to Workflow](../README.md).

I built an operator-invoked pipeline to reproduce a reported defect as a failing test, evaluate a candidate fix, and prepare it for review. I paused development on October 8, 2026. The useful outcome was a clearer boundary for what I could ask an agent to prove, and better requirements for the issues entering my workflow.

This is a case study of a paused experiment. Its source is not part of the public source kits, and the unattended tier was never built.

## Test the input before automating the fix

A September 21 audit selected 25 recently updated issues from a 295-issue backlog. Each selected issue had an acceptance-criteria heading or an outcome checklist and lacked a product, design, or decision label. The audit attempted to establish a check for the whole issue, stopping at the first blocker.

| Result under that bounded protocol | Issues |
| --- | ---: |
| Reached whole-issue proof | 0 |
| Required an unresolved product or architecture decision | 19 |
| Criteria could not be mapped to an available check | 4 |
| Whole-issue check exceeded the bounded effort | 1 |
| Required live evidence the audit could not establish | 1 |

An acceptance-criteria heading was not enough to make an issue ready for automated implementation. This was one selected sample, not proof that the entire backlog lacked suitable issues. It led me to drop automatic issue selection from that increment and focus on reproduction.

## A verified behavior fix still needed review

Later calibration produced one VERIFIED behavior fix. The attempt log also records that the worker changed unrelated punctuation throughout the file and that its check used an invented severity value. The automated gates missed both; operator review caught them before merge. The behavior fix shipped separately as a minimal normal PR, without the collateral edits.

That distinction matters to the design: a test can demonstrate the reported behavior while missing an unacceptable change elsewhere. A verification verdict still needs a bounded patch and review.

Further attempts exposed gaps between stages: instructions disagreed with the allowed mock policy, a reproduced symptom could not satisfy the later assertion rules, and an analyzer applied test-helper restrictions to production imports that read environment state. The calibration record lists eight numbered gaps. That is not a denominator for a success-rate claim.

## Set a stopping rule, then use it

Before the final attempt, I set a concrete bar: produce a green draft PR with no hand repairs to the pipeline and no new gap. The attempt failed that bar. I paused the separate autopilot after reviewing the evidence with three model families. The decision rested on the observed failures and the predefined bar.

The idea worth retaining was **red-first reproduction**: establish a failing check on the original code, then test the change against it. The pause decision proposed folding that discipline into ordinary debugging. This case study does not claim that integration was completed or validated.

The restart conditions are written down:

1. At least five eligible issues with authored acceptance criteria are open at the same time.
2. Ordinary debugging runs using the folded red-first gate show workers passing it without assistance.

## What changed elsewhere in the workflow

The [intake](../ai-intake/) now carries authored acceptance criteria in its v2 sidecars. That makes the intended outcome explicit before implementation starts. It does not, by itself, prove that every criterion is settled or machine-checkable; the audit showed why those need separate checks.

The broader lesson I use is practical: settle the product decision, make the expected behavior checkable, and only then increase automation. I kept the experiment and its findings instead of presenting a single verified fix as evidence that an unattended service was ready.

## Evidence

This account was checked against the September 21 provability audit, the October reproduce-calibration record and attempt log, and the October 8 pause decision. Private issue numbers, titles, paths, and raw attempts are omitted. The audit and calibration were different samples at different times; the zero-of-25 audit and later verified fix are not conflicting results. These are summarized owner records, not independently reproducible public experiments.
