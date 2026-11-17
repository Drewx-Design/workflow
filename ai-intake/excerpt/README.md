# Intake auto-close bar

This folder is a read-only excerpt from the private intake codebase: the file that decides when a model may act on an issue without a person, such as closing a duplicate. It was copied unchanged on 2026-11-17 from source commit `d9d56c18c1002bd14074f1f8600196c475499fbe`, and `export-manifest.json` records that commit and the file's hash. It imports modules that stay private, so it is published to read, not to run.

## The bar

`ACTION_QUALIFICATION_BAR` ([`action-qualification.ts`](action-qualification.ts) line 13) holds these thresholds (its comment calls it their only source), and `summarizeActionLabels` (line 173) applies them:

| Action | Distinct labeled cases | Precision | Wrong closes allowed |
| --- | --- | --- | --- |
| Close an issue as already existing (`close_issue_existence`) | at least 50 | at least 95% | 0 |
| Append evidence to an existing issue (`append_evidence_overlap`) | at least 20 | at least 95% | not applicable |

Any other action kind takes the strictest minimum, 50 (`minimumLabeledCasesFor`, line 20), so a new kind never inherits the looser bar. The comment above the bar gives the reason close needs more: zero wrong in 50 bounds the wrong-close rate near 6% (95% upper bound), against 14% at 20.

## Which labels count

`eligibleActionLabel` (line 64) and `qualifyingActionLabel` (line 75) decide this:

- A label counts only if a human operator or the model panel made it, on the holdout split, against the current assessment stack. Plain agent labels never count.
- A model-panel label also needs verified evidence, and counts only while the assessor's provider is on the allowlist (`PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS`, line 49). The allowlist holds `openai`, and the two panel seats are `anthropic` and `glm`, so a counted panel label comes from a different model family than its assessor.
- Each case counts once, by its first eligible labeled attempt. A negative label on any attempt fails the case, and a later positive never restores it. Every wrong close stays a veto.

## When authority is granted

For a model action kind (closing or appending), `readActionQualification` (line 207) requires all of these, among its other checks, and fails closed on any error:

- the capability is enabled for automatic use (line 255);
- the labels committed on `origin/main` meet the bar (line 257), and their hash matches the proof recorded in the capability manifest (line 256). Only committed labels count toward the bar;
- no uncommitted label, replayed in order, takes the score below the bar (line 265), so uncommitted labels can revoke authority;
- no unanswered label question remains for the current stack (line 282). An eligible label answers a question whether or not it is committed.

Action kinds that are not model actions skip the bar and need only the capability check (lines 221-224).

`isActionKindExecutable` (line 291) returns that decision; its comment calls it the shared automatic-action boundary.
