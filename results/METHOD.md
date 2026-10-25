# How the operating counts were made

[Read the operating record](2026-10-18-to-24.md).

The capture was made on October 25, 2026. The reporting window is `2026-10-18T00:00:00Z <= event time < 2026-10-25T00:00:00Z`. It uses one repository across all four tools, not a selection of successful runs. Each journal was read into memory once and hashed for a private receipt. The raw journals and receipt stay outside this public repository. No tool was run live to generate these counts.

| Tool | Source and inclusion rule | Count definition |
| --- | --- | --- |
| Sorter | Active stewardship journal, excluding backup journals; event `at` in the window | Deduplicate starts by `runId`, attempts by `actionId`, and assessed issues by issue number. Resolve each started run's result artifact and each attempted action's last outcome recorded before the cutoff. A missing finish is reported separately. Assessment and rejection counts are event counts. |
| Intake | Execution journal; `appliedAt` in the window; explicit `intent` and `complete` events | Exclude legacy-import wrappers. Match intent and complete records as multisets of `(sourceFingerprint, action, emissionContentSha256, decisionContentSha256)`. Count distinct issue numbers on complete records separately. Non-event decision records are counted separately and are zero in this window. |
| Coordinator | Event journal; `ts` in the window | Deduplicate worker starts/failures by worker ID and delivery states by action ID. For actions first observed as uncertain within the selected window, require a subsequent `action_delivered` timestamp before the cutoff to count later confirmation. Watcher losses are event counts. |
| Cleanup | Run journal; numeric millisecond `startedAt` in the window | Separate dry runs from live runs. Count recorded statuses and outcomes. Sum worktree rows for observations; case-fold paths to count distinct Windows paths. Mutation kinds are event counts, not completed-removal counts. |

The JSON contains aggregates only. Private identifiers are used to deduplicate locally and are discarded from the public output. The result does not include issue titles or bodies, paths, source hashes, conversation text, credentials, or personal settings.

## Limits

- These are retained logs, not an independently verified census of everything the tools did. Failures before journaling, missing records, and activity in other repositories are outside the measurement.
- A run that began before the window is outside the run-start cohort even if it produced an action during the window. The action cohort is counted by its own attempt time.
- Cleanup reports are selected by start time and use their recorded final status; they are not worktree snapshots taken exactly at midnight. The selected runs finished before this window's cutoff.
- A completion or confirmed-write record is evidence of recorded execution, not an assessment that the action was worthwhile.
- The period includes evolving deployed versions. It is not a fixed-version reliability or performance experiment.
- Raw records are private, so readers can inspect the definitions and arithmetic but cannot independently reproduce the operating totals from this repository.
