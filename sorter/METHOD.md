# How I sort issues

[Back to Sorter](README.md).

I want a backlog to answer two questions: what matters for the next milestone, and what should occupy the limited working set now? A score helps with the first comparison, but cannot answer the second on its own.

This describes the ranking path in the published source. Older assessment contracts remain for replay compatibility; they are not the method described here.

## 1. Start with a milestone, not existing labels

The repository supplies a versioned milestone specification with numbered user steps and representative tier anchors. The [example](examples/milestone-1.md) ends with a user exporting a result.

Assessments separate:

| Dimension | Question |
| --- | --- |
| Lane | Is this customer-facing product work or internal tooling? |
| Tier | Does it block the milestone, improve it without blocking, or sit outside it? |
| Milestone step | Which numbered step does the evidence support? |
| Value | How valuable is the outcome against this milestone, from 1 to 10? |
| Effort | Is this low, medium, or high effort, including review and integration risk? |
| Severity | For a defect or technical debt, how serious is the technical failure? Features get `none`. |
| Done/stale | Is the work already implemented, or has its premise stopped applying? |

The prompt tells assessors to ignore existing Priority, Horizon, and Effort values as evidence. Otherwise an old label could keep confirming itself. The models supply rationales or abstain. They do not propose Horizon.

Effort anchors in this workflow are roughly half a day and one small change for low; a day or two and one PR for medium; and multiple PRs, cross-cutting work, migrations, or unclear design for high. Those are assessment anchors, not delivery promises.

Source: [rubric and validation](scripts/lib/github-issue-roadmap/stewardship-assessment.ts).

## 2. Merge judgments without concealing uncertainty

The current production seat pair named in the source is Codex and GLM. Separate model families can expose different interpretations; agreement alone does not establish correctness.

| Input from the two assessors | Merge rule | Example |
| --- | --- | --- |
| Value | Arithmetic mean | 8 and 7 become 7.5 |
| Effort | Same estimate, or the larger of adjacent estimates | Low + medium becomes medium |
| Effort two bands apart | Needs evidence | Low + high stays unresolved |
| Lane, tier, milestone step, severity | Exact agreement required | Blocker + outside milestone stays unresolved |
| Either assessor abstains | Needs evidence for that field | Abstention does not become zero or “none” |
| Done/stale | Preserve both reports | A lifecycle signal does not rewrite scope |

Additional source evidence is requested for specific reasons: a milestone blocker, a reported defect severity, an explicit need for code, an unresolved tier, or certain candidates entering the working set. Disagreement alone does not automatically buy another round of code collection. Unresolved product choices and completed or disproved work have escalation paths.

Source: [merge and expansion rules](scripts/lib/github-issue-roadmap/stewardship-assessment.ts), [decision compiler](scripts/lib/github-issue-roadmap/stewardship-decision.ts), [constructed merge tests](scripts/__tests__/roadmap-stewardship-assessment.test.ts).

## 3. Give value more influence than ease

```text
Score = Value² × Ease / 10

Ease: low effort = 4, medium = 3, high = 2
```

Doubling value quadruples the score at the same effort. Moving from high to low effort doubles it at the same value. The scale therefore favors meaningful improvements without letting effort disappear from the comparison. The division by 10 only makes the number easier to read; it does not change the order.

| Merged value | Effort | Calculation | Score |
| ---: | --- | --- | ---: |
| 8 | High | 8² × 2 / 10 | 12.8 |
| 5 | Low | 5² × 4 / 10 | 10 |
| 7.5 | Medium | 7.5² × 3 / 10 | 16.875 |

The implementation uses integer units internally to preserve half-step merged values. A missing value or effort yields no score. It does not silently become zero.

This is a policy choice. Value is a judgment on a 1–10 scale, not a measured monetary quantity, so 12.8 does not mean a predicted return. Squaring also magnifies errors: assessors scoring the same issue 2 and 10 still merge to 6. The current code does not apply a value-disagreement penalty. That is a useful limitation to keep visible when reviewing the output.

Source: [score and stored rank key](scripts/lib/github-issue-roadmap/stewardship-rank-key.ts).

## 4. Build the working set around constraints

The compiler applies these rules before filling ordinary formula slots:

1. Honor Horizon pins, including an explicit choice to keep an issue out of Now.
2. Admit agreed, code-verified P0 emergencies when not overridden by a Horizon pin.
3. Retain current work unless a defined exit or displacement applies. A higher ordinary score alone is not an exit.
4. If Now has no tooling issue, consider the best eligible tooling candidate, by tier and then score.
5. Admit eligible product milestone blockers, ordered by lower effort and then higher value.
6. Fill remaining ordinary product slots from in-scope, nonblocking issues by descending score.

Ordinary formula filling stops at **five total Now issues**. Blockers and tooling can use room up to **eight**. Pins and emergencies can leave protected overflow; the report raises an alarm rather than pretending the cap was respected. Displacement targets eligible nonblocking formula incumbents, not arbitrary current work.

For formula ties, the comparator prefers an incumbent, lower effort, earlier milestone step, then lower issue number. Native gating dependencies prevent ordinary new admission. The rules distinguish slot admission from the stored Sort key: inside Now, that key orders pinned, emergency, tooling, blocker, and formula/incumbent bands. Non-Now keys encode the raw score where rankable; a large Parked score is not permission to start the work.

Absent an override, flag, or other exception, remaining milestone blockers go to **Next**, in-scope nonblockers to **Later**, and outside-milestone work to **Parked**. The [worked backlog](README.md#worked-example) shows why an outside-milestone score of 32.4 can sit behind a blocker scoring 9.8.

Source: [backlog compiler](scripts/lib/github-issue-roadmap/stewardship-backlog.ts), [rank key](scripts/lib/github-issue-roadmap/stewardship-rank-key.ts).

## 5. Treat a proposal and a write as separate steps

The snapshot records the proposed field changes and their evidence. Execution validates its authority and current state, records the attempt, and reads back the result. An uncertain request remains unresolved until observation supports an outcome; uncertainty does not authorize a blind retry.

Horizon and Effort pins preserve operator choices. The Sort key is computed and sorter-owned. Lifecycle flags request attention to done or stale work rather than closing issues. These distinctions matter more than a superficially precise score.

Source: [executor](scripts/lib/github-issue-roadmap/stewardship-executor.ts), [projection](scripts/lib/github-issue-roadmap/stewardship-projection.ts).

## What I would measure next

The [operating record](../results/2026-10-18-to-24.md) establishes activity and recorded write outcomes. To judge the ranking itself, I would compare it with a simple milestone-tier/effort ordering on the same frozen backlog, record my decisions before seeing which method produced each list, and track corrections and completed milestone steps. Until that comparison exists, I treat the formula as an explicit preference I can inspect and revise.
