/**
 * Requirements-to-field trace (the persisted record is intentionally not imported here):
 *
 * - R4 reads `outcome` and the separately supplied `canonicalIssueNumber` to correct routing.
 * - R7/R17 read `evidence.mergedCommitReceipt` and `evidence.satisfiedClauses` in the
 *   demonstrated/canonical-issue branch; performing append/close writes is a non-goal.
 * - R8 reads `evidence.mergedCommitReceipt` in the demonstrated/no-canonical-issue branch;
 *   persistence of the provisional suppression is a non-goal.
 * - R9 reads `evidence.clauses` in the partially-demonstrated branch; rendering the residual
 *   issue is a non-goal.
 * - R11 reads a citation from every satisfied clause in demonstrated and partial branches.
 * - R5 reads every degradation discriminant and returns a typed hold; recovery is a non-goal.
 * - The not-demonstrated filing-release branch reads `evidence.searchAttestation`.
 */

export const EXISTENCE_RUN_OUTCOMES = [
  "demonstrated",
  "partially_demonstrated",
  "not_demonstrated",
  "no_entry",
  "unreadable_record",
  "sha_mismatch",
  "budget_exhausted",
  "read_failure",
] as const;

export type ExistenceRunOutcome = typeof EXISTENCE_RUN_OUTCOMES[number];
export type ExistenceDegradation = Exclude<
  ExistenceRunOutcome,
  "demonstrated" | "partially_demonstrated" | "not_demonstrated"
>;

export interface ExistenceEntryIdentity {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
}

export interface ExistenceRoutingInput {
  readonly entry: ExistenceEntryIdentity;
  readonly verifiedOriginMainSha: string;
  readonly outcome: ExistenceRunOutcome;
  readonly evidence: unknown;
}

interface RoutingContext {
  readonly entry: ExistenceEntryIdentity;
  readonly verifiedOriginMainSha: string;
}

export interface SatisfiedClauseCitation {
  readonly clause: string;
  readonly citation: unknown;
}

export interface AppendEvidenceThenCloseRoute extends RoutingContext {
  readonly kind: "append_evidence_then_close";
  readonly canonicalIssueNumber: number;
  readonly mergedCommitReceipt: unknown;
  readonly satisfiedClauseCitations: readonly SatisfiedClauseCitation[];
}

export interface ProvisionalSuppressionRoute extends RoutingContext {
  readonly kind: "provisional_suppression";
  readonly mergedCommitReceipt: unknown;
  readonly satisfiedClauseCitations: readonly SatisfiedClauseCitation[];
}

export interface FileResidualIssueRoute extends RoutingContext {
  readonly kind: "file_residual_issue";
  readonly unsatisfiedClauses: readonly string[];
  readonly satisfiedClauseCitations: readonly SatisfiedClauseCitation[];
}

export interface FileAsTodayRoute extends RoutingContext {
  readonly kind: "file_as_today";
  readonly searchAttestation: unknown;
}

export type ExistenceRoutingBranch =
  | "demonstrated_with_canonical_issue"
  | "demonstrated_without_canonical_issue"
  | "partially_demonstrated"
  | "not_demonstrated";

export interface MissingRequiredFieldHold extends RoutingContext {
  readonly kind: "hold";
  readonly reason: "missing_required_field";
  readonly missingField: "mergedCommitReceipt" | "satisfiedClauseCitations" | "searchAttestation";
  readonly branch: ExistenceRoutingBranch;
}

export interface InvalidPartialClauseSetHold extends RoutingContext {
  readonly kind: "hold";
  readonly reason: "invalid_partial_clause_set";
  readonly clauseSet: "all_unsatisfied" | "all_satisfied" | "missing_or_unreadable";
  readonly branch: "partially_demonstrated";
}

export interface DegradationHold extends RoutingContext {
  readonly kind: "hold";
  readonly reason: ExistenceDegradation;
}

export type ExistenceRoutingHold =
  | MissingRequiredFieldHold
  | InvalidPartialClauseSetHold
  | DegradationHold;
export type ExistenceRoutingResult =
  | AppendEvidenceThenCloseRoute
  | ProvisionalSuppressionRoute
  | FileResidualIssueRoute
  | FileAsTodayRoute
  | ExistenceRoutingHold;

function evidenceObject(evidence: unknown): Readonly<Record<string, unknown>> {
  return evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence as Readonly<Record<string, unknown>>
    : {};
}

function completeClauseCitations(value: unknown): SatisfiedClauseCitation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const citations: SatisfiedClauseCitation[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const clause = item as Readonly<Record<string, unknown>>;
    if (typeof clause.clause !== "string" || clause.clause.trim() === "" ||
        !Object.hasOwn(clause, "citation") || clause.citation === undefined || clause.citation === null) {
      return null;
    }
    citations.push({ clause: clause.clause, citation: clause.citation });
  }
  return citations;
}

function missingFieldHold(
  input: ExistenceRoutingInput,
  branch: ExistenceRoutingBranch,
  missingField: MissingRequiredFieldHold["missingField"],
): MissingRequiredFieldHold {
  return {
    kind: "hold",
    reason: "missing_required_field",
    missingField,
    branch,
    entry: input.entry,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  };
}

function partialClauseProjection(value: unknown): {
  readonly unsatisfiedClauses: string[];
  readonly satisfiedClauseCitations: SatisfiedClauseCitation[];
  readonly satisfiedCount: number;
  readonly unreadable: boolean;
  readonly missingSatisfiedCitation: boolean;
} {
  const unsatisfiedClauses: string[] = [];
  const satisfiedClauseCitations: SatisfiedClauseCitation[] = [];
  let satisfiedCount = 0;
  let unreadable = !Array.isArray(value) || value.length === 0;
  let missingSatisfiedCitation = false;
  if (!Array.isArray(value)) {
    return {
      unsatisfiedClauses,
      satisfiedClauseCitations,
      satisfiedCount,
      unreadable,
      missingSatisfiedCitation,
    };
  }
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      unreadable = true;
      continue;
    }
    const clause = item as Readonly<Record<string, unknown>>;
    if (typeof clause.clause !== "string" || clause.clause.trim() === "") {
      unreadable = true;
      continue;
    }
    if (clause.satisfied === true) {
      satisfiedCount += 1;
      if (!Object.hasOwn(clause, "citation") || clause.citation === undefined || clause.citation === null) {
        missingSatisfiedCitation = true;
      } else {
        satisfiedClauseCitations.push({ clause: clause.clause, citation: clause.citation });
      }
    } else if (clause.satisfied === false) {
      unsatisfiedClauses.push(clause.clause);
    } else {
      unreadable = true;
    }
  }
  return {
    unsatisfiedClauses,
    satisfiedClauseCitations,
    satisfiedCount,
    unreadable,
    missingSatisfiedCitation,
  };
}

function invalidPartialHold(
  input: ExistenceRoutingInput,
  clauseSet: InvalidPartialClauseSetHold["clauseSet"],
): InvalidPartialClauseSetHold {
  return {
    kind: "hold",
    reason: "invalid_partial_clause_set",
    clauseSet,
    branch: "partially_demonstrated",
    entry: input.entry,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  };
}

function degradationHold(
  input: ExistenceRoutingInput,
  reason: ExistenceDegradation,
): DegradationHold {
  return {
    kind: "hold",
    reason,
    entry: input.entry,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled existence run outcome: ${String(value)}`);
}

export function routeExistence(
  input: ExistenceRoutingInput,
  canonicalIssueNumber: number | null,
): ExistenceRoutingResult {
  switch (input.outcome) {
    case "demonstrated": {
      const evidence = evidenceObject(input.evidence);
      const branch = canonicalIssueNumber === null
        ? "demonstrated_without_canonical_issue"
        : "demonstrated_with_canonical_issue";
      if (evidence.mergedCommitReceipt === undefined || evidence.mergedCommitReceipt === null) {
        return missingFieldHold(input, branch, "mergedCommitReceipt");
      }
      const satisfiedClauseCitations = completeClauseCitations(evidence.satisfiedClauses);
      if (satisfiedClauseCitations === null) {
        return missingFieldHold(input, branch, "satisfiedClauseCitations");
      }
      if (canonicalIssueNumber !== null) {
        return {
          kind: "append_evidence_then_close",
          entry: input.entry,
          verifiedOriginMainSha: input.verifiedOriginMainSha,
          canonicalIssueNumber,
          mergedCommitReceipt: evidence.mergedCommitReceipt,
          satisfiedClauseCitations,
        };
      }
      return {
        kind: "provisional_suppression",
        entry: input.entry,
        verifiedOriginMainSha: input.verifiedOriginMainSha,
        mergedCommitReceipt: evidence.mergedCommitReceipt,
        satisfiedClauseCitations,
      };
    }
    case "partially_demonstrated": {
      const evidence = evidenceObject(input.evidence);
      const clauses = partialClauseProjection(evidence.clauses);
      if (clauses.unreadable) return invalidPartialHold(input, "missing_or_unreadable");
      if (clauses.satisfiedCount === 0 && clauses.unsatisfiedClauses.length > 0) {
        return invalidPartialHold(input, "all_unsatisfied");
      }
      if (clauses.satisfiedCount > 0 && clauses.unsatisfiedClauses.length === 0) {
        return invalidPartialHold(input, "all_satisfied");
      }
      if (clauses.missingSatisfiedCitation) {
        return missingFieldHold(input, "partially_demonstrated", "satisfiedClauseCitations");
      }
      return {
        kind: "file_residual_issue",
        entry: input.entry,
        verifiedOriginMainSha: input.verifiedOriginMainSha,
        unsatisfiedClauses: clauses.unsatisfiedClauses,
        satisfiedClauseCitations: clauses.satisfiedClauseCitations,
      };
    }
    case "not_demonstrated": {
      const evidence = evidenceObject(input.evidence);
      if (evidence.searchAttestation === undefined || evidence.searchAttestation === null) {
        return missingFieldHold(input, "not_demonstrated", "searchAttestation");
      }
      return {
        kind: "file_as_today",
        entry: input.entry,
        verifiedOriginMainSha: input.verifiedOriginMainSha,
        searchAttestation: evidence.searchAttestation,
      };
    }
    case "no_entry":
    case "unreadable_record":
    case "sha_mismatch":
    case "budget_exhausted":
    case "read_failure":
      return degradationHold(input, input.outcome);
  }
  return assertNever(input.outcome);
}
