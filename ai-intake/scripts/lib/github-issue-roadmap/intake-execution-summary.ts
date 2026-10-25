import {
  resolveDurableState, type ApprovalLedgerRecord, type DurableState, type HistoryIdentity, type HistoryIndex,
} from "../../github-issue-roadmap-intake-apply";

type OperationSummary = ApprovalLedgerRecord["result"] & {
  readonly sourceFingerprint: string | null;
  readonly action: HistoryIdentity["action"];
  readonly state: Exclude<DurableState["kind"], "never_attempted">;
  readonly firstAttemptAt: string | null;
  readonly lastEventAt: string | null;
  readonly ageDays: number | null;
  readonly lastError: string | null;
  readonly reconciledAt?: string;
  readonly predatesAttempt?: boolean;
  readonly verifiedAt?: string;
  readonly classificationMatches?: boolean;
  readonly legacyVerification?: ApprovalLedgerRecord["legacyVerification"];
  readonly historyConflicts?: ApprovalLedgerRecord["historyConflicts"];
};

export interface ExecutionSummary {
  readonly countsByState: Record<DurableState["kind"], number>;
  readonly operationsTotal: number;
  readonly unresolved: number;
  readonly unverified: number;
  readonly attention: number;
  readonly abandoned: number;
  readonly classificationDrift: number;
  readonly oldestUnresolvedAgeDays: number | null;
  readonly operations: readonly OperationSummary[];
  // Evidence coverage describes the listed operations, including abandoned and attention states.
  readonly ageEvidence: { readonly withFirstAttempt: number; readonly withoutFirstAttempt: number };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function originalRow(value: unknown): Record<string, unknown> | null {
  const row = object(value);
  return row?.kind === "legacy_import" ? object(row.row) : row;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Project historical identities only; current plan entries and elapsed drain runs are not evidence. */
export function summarizeExecutionHistory(index: HistoryIndex, now: Date, journalRepository: string | null = null): ExecutionSummary {
  const countsByState: ExecutionSummary["countsByState"] = {
    never_attempted: 0, intent_unknown: 0, primary_unverified: 0, classification_failed: 0,
    complete: 0, unresolved_unknown: 0, unresolved_partial: 0, abandoned: 0,
    legacy_unverified: 0, conflict: 0, malformed: 0, multiple_actions: 0, withdrawn_dispositioned: 0,
  };
  const historical = [...index.staged.values(), ...new Set([...index.legacy.values()].flat())];
  const repositories = new Set([...historical, ...index.malformed].flatMap((operation) =>
    operation.repository === null ? [] : [operation.repository.toLowerCase()]));
  // Repository journals also contain legacy rows without a repository. Attribute them to the
  // journal's own repository when the caller names it, else to the sole repository present;
  // an empty-string sentinel would resolve against nothing and misstate the journal.
  const repositoryFor = (repository: string | null) => repository?.toLowerCase()
    ?? journalRepository?.toLowerCase()
    ?? (repositories.size === 1 ? [...repositories][0] : null);
  const identities = new Map<string, { repository: string | null; sourceFingerprint: string | null; action: HistoryIdentity["action"] }>();
  const add = (repository: string | null, sourceFingerprint: string | null, action: HistoryIdentity["action"]) => {
    const identity = { repository: repositoryFor(repository), sourceFingerprint, action };
    identities.set(JSON.stringify([identity.repository, sourceFingerprint, action]), identity);
  };
  for (const operation of historical) {
    for (const fingerprint of operation.sourceFingerprints) add(operation.repository, fingerprint, operation.action);
  }
  for (const problem of index.malformed) {
    const raw = originalRow(problem.history[0]?.value);
    const action = raw?.action === "create_issue" || raw?.action === "append_evidence" ? raw.action : null;
    for (const fingerprint of problem.sourceFingerprints.length > 0 ? problem.sourceFingerprints : [null]) {
      if (action !== null || ![...identities.values()].some((identity) =>
        identity.repository === repositoryFor(problem.repository) && identity.sourceFingerprint === fingerprint)) {
        add(problem.repository, fingerprint, action);
      }
    }
  }

  const operations: OperationSummary[] = [];
  for (const identity of identities.values()) {
    // Null fingerprints represent unattributable malformed bytes, never dispatch identities.
    const state = resolveDurableState(index, { ...identity, repository: identity.repository ?? "", sourceFingerprint: identity.sourceFingerprint ?? "" });
    const unattributed = identity.sourceFingerprint === null ? index.malformed.filter((problem) =>
      (problem.repository === null || problem.repository.toLowerCase() === identity.repository)
      && problem.sourceFingerprints.length === 0) : [];
    const kind = unattributed.length > 0 ? "malformed" : state.kind;
    countsByState[kind] += 1;
    const verification = state.kind === "complete" && state.operation.event.event === "legacy_verified"
      ? state.operation.event.legacyVerification : undefined;
    // A dispositioned withdrawal is terminal: nothing was sent and nothing needs attention.
    if (kind === "never_attempted" || kind === "withdrawn_dispositioned" || (kind === "complete" && verification === undefined)) continue;
    const selected = state.operations.filter((operation) => identity.action === null || operation.action === null || operation.action === identity.action);
    const history = [...selected.flatMap((operation) => operation.history),
      ...(state.kind === "malformed" ? state.problems.flatMap((problem) => problem.history) : []),
      ...unattributed.flatMap((problem) => problem.history)];
    const rows = [...new Map(history.map((row) => [row.rowNumber, row])).values()].sort((a, b) => a.rowNumber - b.rowNumber);
    // Row order is append order, not chronology: a legacy import can land after newer staged
    // events. First/last come from the timestamps themselves.
    const dates = rows.map((row) => timestamp(originalRow(row.value)?.appliedAt)).filter((date) => date !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const firstAttemptAt = dates[0] ?? null;
    const lastEventAt = dates.at(-1) ?? null;
    const reconciliation = rows.map((row) => originalRow(row.value))
      .filter((row) => row?.event === "reconciled").map((row) => object(row?.reconciliation)).at(-1);
    const reconciledAt = timestamp(reconciliation?.at);
    const predatesAttempt = object(reconciliation?.live)?.predatesAttempt;
    const lastError = unattributed.length > 0 ? unattributed.map((problem) => problem.reason).join(" ")
      : state.kind === "malformed" ? state.problems.map((problem) => problem.reason).join(" ")
      : state.kind === "conflict" ? state.conflicts.map((conflict) => conflict.reason).join(" ")
      : state.kind === "multiple_actions" ? "Multiple historical actions require explicit reconciliation."
      : state.kind === "abandoned" ? state.operation.event.abandonment.reason
      : rows.map((row) => originalRow(row.value)?.error).filter((error) => typeof error === "string").at(-1) ?? null;
    operations.push({ sourceFingerprint: identity.sourceFingerprint, action: identity.action, state: kind,
      ...("operation" in state ? state.operation.result : { issueNumber: null, issueId: null, commentId: null }),
      firstAttemptAt, lastEventAt,
      ...(reconciledAt === null ? {} : { reconciledAt }),
      ...(typeof predatesAttempt !== "boolean" ? {} : { predatesAttempt }),
      ...(verification === undefined ? {} : { verifiedAt: verification.at,
        classificationMatches: verification.classification.matches, legacyVerification: verification }),
      // Clamped: a recorded timestamp ahead of `now` (clock skew) reads as age 0, never negative.
      ageDays: firstAttemptAt === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(firstAttemptAt)) / 86_400_000)),
      lastError, ...(state.kind === "conflict" ? { historyConflicts: state.conflicts } : {}) });
  }
  // Stable ties preserve the existing status ordering; missing evidence always sorts last.
  operations.sort((a, b) => (a.firstAttemptAt === null ? Infinity : Date.parse(a.firstAttemptAt))
    - (b.firstAttemptAt === null ? Infinity : Date.parse(b.firstAttemptAt)));
  const unresolvedAges = operations.flatMap((operation) =>
    ["intent_unknown", "unresolved_unknown", "unresolved_partial"].includes(operation.state)
      && operation.ageDays !== null ? [operation.ageDays] : []);
  const withFirstAttempt = operations.filter((operation) => operation.firstAttemptAt !== null).length;
  return {
    countsByState, operationsTotal: identities.size,
    unresolved: countsByState.intent_unknown + countsByState.unresolved_unknown + countsByState.unresolved_partial,
    unverified: countsByState.primary_unverified + countsByState.classification_failed + countsByState.legacy_unverified,
    attention: countsByState.conflict + countsByState.malformed + countsByState.multiple_actions,
    abandoned: countsByState.abandoned,
    classificationDrift: operations.filter((operation) => operation.classificationMatches === false).length,
    oldestUnresolvedAgeDays: unresolvedAges.length === 0 ? null : Math.max(...unresolvedAges),
    operations, ageEvidence: { withFirstAttempt, withoutFirstAttempt: operations.length - withFirstAttempt },
  };
}
