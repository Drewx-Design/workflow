import { existsSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTAKE_APPROVAL_PLAN_SCHEMA,
  buildIntakeApprovalPlan,
  sha256Content,
  type ApprovalClassification,
  type IntakeApprovalEntry,
  type IntakeApprovalHold,
  type IntakeApprovalPlan,
} from "./github-issue-roadmap-intake-approve";
import { createGitHubIntakeApprovalTransport, hasGitHubRequestStatus, type FencedIntakeApprovalTransport, type FieldEventSnapshot, type FieldWriteReadPort, type FieldWriteReceipt } from "./lib/github-issue-roadmap/github-intake-approval-transport";
import { parseSourceMarker, SOURCE_MARKER, type SourceMarkerV1 } from "./lib/github-issue-roadmap/source-marker";
import { probeExistenceAtSha } from "./github-issue-roadmap-existence-probe";
import { runCredentialCleanGit, type GitRunner } from "./lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";
import { canonicalJson, canonicalJsonSha256 } from "./lib/github-issue-roadmap/canonical-json";
import { isActionKindExecutable, type ActionQualificationContext } from "./lib/github-issue-roadmap/action-qualification";
import { existenceVerdictProjection, parseExistenceRecord } from "./lib/github-issue-roadmap/existence-record";
import { parseOutcomeEnvelope } from "./lib/github-issue-roadmap/outcome-candidate";
import {
  acquireExecutionClaim, appendJournal, ExecutionOwnershipError, foldRepository, importLegacyLedgers, JournalWriteError, readJournal, resolveJournalPath,
  type ExecutionClaim, type JournalTail, type LegacyImportCounts,
} from "./lib/github-issue-roadmap/intake-execution-journal";
import { summarizeExecutionHistory, type ExecutionSummary } from "./lib/github-issue-roadmap/intake-execution-summary";
import { RunEvidencePathEscapeError, verifyRunEvidence, type RunEvidenceV1 } from "./lib/github-issue-roadmap/intake-run-evidence";
import {
  confirmOwnershipLive, matchesIssueId, proveCreateOwnership,
  type CensusBinding, type LiveConfirmation, type OwnershipIssueReadPort, type OwnershipProof, type OwnershipRefusal,
} from "./lib/github-issue-roadmap/intake-create-reconciliation";
import type { IntakeSnapshotV1 } from "./lib/github-issue-roadmap/intake-snapshot";
import { compareLegacyClassification, parseLegacyRequested, type LegacyVerification } from "./lib/github-issue-roadmap/intake-legacy-verification";

export const INTAKE_APPROVAL_LEDGER_SCHEMA = "github-issue-roadmap-intake-approval-ledger/v1" as const;

// Damage budget: at most one accidental filing per immediate call, and a reviewable
// cleanup of ten issues before intervention. Deliberate batches must opt in explicitly.
export const INTAKE_CREATE_LIMITS = { immediateCreates: 1, windowHours: 24, repositoryCreates: 15 } as const;

interface CreateBudgetOverride {
  readonly flag: "--allow-create-budget-overrun";
  readonly operator: string;
  readonly runId: string;
  readonly countBefore: number;
  readonly ceiling: number;
  readonly windowHours: number;
  readonly windowStart: string;
  readonly at: string;
}

type JsonObject = Record<string, unknown>;

interface ExistenceRevalidation {
  readonly boundOriginMainSha: string;
  readonly trustedOriginMainSha: string;
  readonly verdictEqualityVerified: true;
}

export interface OperatorIntakeApprovalTransport {
  /** Explicit support is required before automatic append-then-close can begin. */
  readonly supportsCloseIssue?: boolean;
  /** Required only when a bound census proves ownership of an unresolved create. */
  readonly fetchIssue?: OwnershipIssueReadPort["fetchIssue"];
  readonly preflightClassifications: (
    entries: readonly {
      readonly sourceFingerprint: string;
      readonly repository: string;
      readonly classifications: readonly {
        readonly fieldName: "Type" | "Priority" | "Effort";
        readonly value: string;
      }[];
    }[],
  ) => Promise<void>;
  readonly createIssue: (
    repository: string,
    payload: { readonly title: string; readonly body: string },
  ) => Promise<{ readonly issueNumber: number; readonly issueId?: string | number }>;
  readonly appendEvidenceComment: (
    repository: string,
    issueNumber: number,
    body: string,
  ) => Promise<{ readonly commentId: string | number }>;
  readonly closeIssue: (
    repository: string,
    issueNumber: number,
  ) => Promise<void>;
  readonly applyClassification: (
    repository: string,
    issueNumber: number,
    classification: { readonly fieldName: "Type" | "Priority" | "Effort"; readonly value: string },
  ) => Promise<{ readonly identifier?: string | number }>;
  readonly verifyClassifications: (
    repository: string,
    issueNumber: number,
    classifications: readonly { readonly fieldName: "Type" | "Priority" | "Effort"; readonly value: string }[],
  ) => Promise<boolean>;
  /** Older operator transports can complete writes without provenance receipts. */
  readonly snapshotFieldEvents?: FieldWriteReadPort["snapshotFieldEvents"];
  readonly readBackFieldWrite?: FieldWriteReadPort["readBackFieldWrite"];
}

type ExecutionEventName = "intent" | "created" | "reconciled" | "complete" | "classification_failed" | "create_unresolved" | "withdrawn_dispositioned";

class UnboundOutcomeIdentity extends Error {
  constructor() { super("unbound_outcome_identity: write has no bound outcome identity."); }
}

class DispositionedWrite extends Error {
  constructor() { super("dispositioned: outcome is terminal; no further write was sent."); }
}

export interface ApprovalExecutionEvent {
  readonly schemaVersion: typeof INTAKE_APPROVAL_LEDGER_SCHEMA;
  readonly event: ExecutionEventName;
  readonly appliedAt: string;
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly action: "create_issue" | "append_evidence";
  readonly emissionContentSha256: string;
  readonly decisionContentSha256: string;
  readonly payload: {
    readonly issue: { readonly title: string; readonly body: string } | null;
    readonly evidenceComment: string | null;
    readonly closeIssue: IntakeApprovalEntry["closeIssue"];
  };
  readonly classifications: readonly {
    readonly fieldName: "Type" | "Priority" | "Effort";
    readonly value: string;
  }[];
  readonly fieldReceipts?: readonly (FieldWriteReceipt & { readonly field: "Priority" | "Effort"; readonly value: string })[];
  readonly issueNumber: number | null;
  readonly issueId: string | number | null;
  readonly commentId: string | number | null;
  readonly error?: string;
  /** Effects completed before a late disposition stopped the remaining writes. */
  readonly completedActions?: IntakeApprovalEntry["intendedActions"];
  readonly reconciliation?: CreateReconciliation;
  /** Audit of explicit operator authorization; never evidence of issue ownership. */
  readonly createBudgetOverride?: CreateBudgetOverride;
}

export interface CreateReconciliation {
  readonly priorEventRowNumber: number;
  readonly priorState: "intent_unknown" | "unresolved_unknown" | "unresolved_partial";
  readonly runId: string;
  readonly census: {
    readonly artifactPath: string;
    readonly artifactSha256: string;
    readonly contentSha256: string;
    readonly coverageSha256: string;
    readonly capturedAt: string;
  };
  readonly live: {
    readonly bodySha256: string;
    readonly createdAt: string;
    readonly fetchedAt: string;
    readonly requestId: string | null;
    readonly predatesAttempt: boolean;
  };
  readonly censusMarker: SourceMarkerV1;
  readonly liveMarker: SourceMarkerV1;
  readonly operator: string;
  readonly at: string;
}

export interface Abandonment {
  readonly reason: string;
  readonly operator: string;
  readonly priorState: "intent_unknown" | "primary_unverified" | "classification_failed"
    | "unresolved_unknown" | "unresolved_partial" | "legacy_unverified";
  readonly priorEventRowNumber: number;
  readonly at: string;
}

export type AbandonedExecutionEvent = Omit<ApprovalExecutionEvent, "event" | "emissionContentSha256" | "decisionContentSha256"> & {
  readonly event: "abandoned";
  // Legacy rows may never have recorded these bindings. Preserve absence rather than invent evidence.
  readonly emissionContentSha256: string | null;
  readonly decisionContentSha256: string | null;
  readonly abandonment: Abandonment;
};

export interface LegacyVerifiedExecutionEvent {
  readonly schemaVersion: typeof INTAKE_APPROVAL_LEDGER_SCHEMA;
  readonly event: "legacy_verified";
  readonly appliedAt: string;
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly action: "create_issue";
  readonly result: ApprovalLedgerRecord["result"];
  readonly legacyVerification: LegacyVerification;
}

export interface ApprovalLedgerRecord {
  readonly durableState?: DurableState["kind"];
  readonly skippedDueToAbort?: true;
  readonly historicalOperations?: readonly HistoricalOperation[];
  readonly historyProblems?: readonly MalformedHistory[];
  readonly historyConflicts?: readonly HistoryConflict[];
  readonly schemaVersion: typeof INTAKE_APPROVAL_LEDGER_SCHEMA;
  readonly appliedAt: string;
  readonly mode: "dry-run" | "execute";
  readonly decisionContentSha256: string;
  readonly existenceRevalidation?: ExistenceRevalidation;
  readonly sourceFingerprint: string;
  readonly candidateFingerprint: string;
  readonly assessorSuggestedClassification: readonly {
    readonly fieldName: string;
    readonly value: string | null;
    readonly confidence: string;
    readonly rationale: string;
  }[];
  readonly operatorFinalClassification: readonly { readonly fieldName: string; readonly value: string | null }[];
  readonly approved: boolean;
  readonly executed: boolean;
  readonly disposition: "executed" | "declined" | "hold" | "replay" | "refused" | "abandoned" | "dispositioned";
  readonly abandonment?: Abandonment;
  readonly legacyVerification?: LegacyVerification;
  readonly refusalReason?: string;
  readonly hold: IntakeApprovalHold | null;
  readonly intendedAction: IntakeApprovalEntry["intendedAction"];
  readonly intendedActions: IntakeApprovalEntry["intendedActions"];
  readonly actionTaken: "create_issue" | "append_evidence" | null;
  readonly actionsTaken: IntakeApprovalEntry["intendedActions"];
  readonly result: {
    readonly issueNumber: number | null;
    readonly issueId: string | number | null;
    readonly commentId: string | number | null;
  };
}

export interface IntakeApplyResult {
  readonly mode: "dry-run" | "execute";
  readonly runEvidence?: {
    readonly path: string; readonly artifactSha256: string; readonly runId: string;
    readonly census: Readonly<Pick<RunEvidenceV1["census"],
      "artifactSha256" | "contentSha256" | "coverageSha256" | "startedAt" | "bookendCompletedAt">> & { readonly basename: string };
  };
  readonly ownership?: { readonly acquired: true; readonly pid: number; readonly acquiredAt: string; readonly releaseError?: string };
  readonly journalPath: string;
  readonly journalTail: { readonly present: boolean };
  readonly executionSummary: ExecutionSummary & {
    readonly reconciliationsRefused: number;
    readonly reconciliationsRefusedReasons: Partial<Record<OwnershipRefusal["reason"], number>>;
    // Counted apart from refusals: no census was bound, so nothing was decided either way.
    readonly reconciliationsNoRunEvidence: number;
  };
  readonly importedLedgers?: LegacyImportCounts;
  readonly writes: readonly {
    readonly sourceFingerprint: string;
    readonly repository: string;
    readonly action: "create_issue" | "append_evidence";
    readonly actions: IntakeApprovalEntry["intendedActions"];
    readonly canonicalIssueNumber: number | null;
    readonly issue: { readonly title: string; readonly body: string } | null;
    readonly evidenceComment: string | null;
    readonly closeIssue: IntakeApprovalEntry["closeIssue"];
    readonly classifications: readonly { readonly fieldName: "Type" | "Priority" | "Effort"; readonly value: string }[];
    readonly suggestedHorizon: string | null;
    readonly emissionContentSha256?: string;
  }[];
  readonly ledgerRecords: readonly ApprovalLedgerRecord[];
  readonly reconciliations: ReadonlyArray<{
    readonly sourceFingerprint: string;
    readonly action: "create_issue";
    readonly outcome: "complete" | "classification_failed" | "withdrawn_dispositioned" | "refused" | "would_confirm" | "no_run_evidence";
    readonly reason?: OwnershipRefusal["reason"];
    readonly detail?: string;
    readonly issueNumber?: number;
  }>;
  readonly failures: ReadonlyArray<{
    readonly sourceFingerprint: string;
    readonly action: IntakeApprovalEntry["intendedAction"];
    readonly stage: "recovery" | "dispatch" | "classification" | "projection";
    readonly issueNumber: number | null;
    readonly error: string;
  }>;
  readonly aborted?: {
    readonly stage: IntakeApplyResult["failures"][number]["stage"];
    readonly sourceFingerprint: string;
    readonly reason: "session_scope_fault" | "repeated_fault";
    readonly error: string;
  };
}

function summarizeApplyExecution(
  history: HistoryIndex, now: Date, repository: string, reconciliations: IntakeApplyResult["reconciliations"],
): IntakeApplyResult["executionSummary"] {
  const refused = reconciliations.filter((entry) => entry.outcome === "refused");
  const reasons: IntakeApplyResult["executionSummary"]["reconciliationsRefusedReasons"] = {};
  for (const entry of refused) {
    if (entry.reason !== undefined) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
  }
  return { ...summarizeExecutionHistory(history, now, repository),
    reconciliationsRefused: refused.length, reconciliationsRefusedReasons: reasons,
    reconciliationsNoRunEvidence: reconciliations.filter((entry) => entry.outcome === "no_run_evidence").length };
}

function isSessionScopeFault(error: unknown): boolean {
  if (!hasGitHubRequestStatus(error)) return false;
  return error.status === null || error.status === 401 || error.status === 403
    || error.status === 429 || error.status >= 500;
}

export class IntakeExecutionBreaker {
  private consecutiveDispatchFailures = 0;
  aborted: IntakeApplyResult["aborted"];

  recordFailure(failure: IntakeApplyResult["failures"][number], error: unknown): void {
    // Fresh-dispatch failures count: the dispatch itself (create_unresolved is terminal) and the
    // classification that immediately follows a landed create. Recovery-stage failures are
    // re-attempted every run by design and must never trip the breaker.
    const counted = failure.stage === "dispatch" || failure.stage === "classification";
    if (counted) this.consecutiveDispatchFailures += 1;
    const reason = isSessionScopeFault(error) ? "session_scope_fault"
      : counted && this.consecutiveDispatchFailures >= 2 ? "repeated_fault" : undefined;
    if (this.aborted !== undefined) return; // First abort wins, even if a later caller reports another failure.
    if (reason !== undefined) {
      this.aborted = { stage: failure.stage, sourceFingerprint: failure.sourceFingerprint, reason, error: failure.error };
    }
  }

  recordComplete(stage: "recovery" | "classification"): void {
    // Only a durable complete from fresh dispatch resets the counter; replay never writes complete.
    if (stage === "classification") this.consecutiveDispatchFailures = 0;
  }
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as JsonObject;
}

function parsePlan(content: string): IntakeApprovalPlan {
  const plan = object(JSON.parse(content) as unknown, "approval plan");
  if (plan.schemaVersion !== INTAKE_APPROVAL_PLAN_SCHEMA) throw new Error("Approval plan schemaVersion is unsupported.");
  const decisions = Array.isArray(plan.decisions) ? plan.decisions : [plan.decision];
  if (decisions.length === 0) throw new Error("Approval plan has no decision bindings.");
  for (const [index, binding] of decisions.entries()) {
    const decision = object(binding, `approval plan decision binding[${index}]`);
    if (typeof decision.path !== "string" || typeof decision.contentSha256 !== "string") {
      throw new Error("Approval plan decision binding is incomplete.");
    }
  }
  if (!Array.isArray(plan.entries)) throw new Error("Approval plan entries must be an array.");
  const primary = object(decisions[0], "approval plan primary decision binding") as unknown as IntakeApprovalPlan["decision"];
  return {
    ...(plan as unknown as IntakeApprovalPlan),
    decision: primary,
    decisions: decisions as IntakeApprovalPlan["decisions"],
    entries: plan.entries.map((entry, index) => {
      const value = object(entry, `approval plan entry[${index}]`);
      return { ...value, decisionReport: value.decisionReport ?? primary } as unknown as IntakeApprovalEntry;
    }),
  };
}

function same(value: unknown): string {
  return canonicalJson(value);
}

function assertEntryMatchesSource(actual: IntakeApprovalEntry, expected: IntakeApprovalEntry): void {
  const immutableActual = {
    decisionReport: actual.decisionReport,
    sourceFingerprint: actual.sourceFingerprint,
    presentation: actual.presentation,
    approvable: actual.approvable,
    intendedAction: actual.intendedAction,
    intendedActions: actual.intendedActions,
    canonicalIssueNumber: actual.canonicalIssueNumber,
    closeIssue: actual.closeIssue,
    issue: actual.issue,
    evidenceComment: actual.evidenceComment,
  };
  const immutableExpected = {
    decisionReport: expected.decisionReport,
    sourceFingerprint: expected.sourceFingerprint,
    presentation: expected.presentation,
    approvable: expected.approvable,
    intendedAction: expected.intendedAction,
    intendedActions: expected.intendedActions,
    canonicalIssueNumber: expected.canonicalIssueNumber,
    closeIssue: expected.closeIssue,
    issue: expected.issue,
    evidenceComment: expected.evidenceComment,
  };
  if (same(immutableActual) !== same(immutableExpected)) {
    throw new Error(`Approval entry ${expected.sourceFingerprint} changed source-bound fields.`);
  }
  if (typeof actual.approved !== "boolean") throw new Error(`Approval entry ${expected.sourceFingerprint} approved must be boolean.`);
  if (!Array.isArray(actual.deniedClassification)) {
    throw new Error(`Approval entry ${expected.sourceFingerprint} changed its classification set.`);
  }
  const actualClassifications = actual.deniedClassification.filter((entry) => entry.fieldName !== "Horizon");
  const expectedClassifications = expected.deniedClassification.filter((entry) => entry.fieldName !== "Horizon");
  if (actualClassifications.length !== expectedClassifications.length) {
    throw new Error(`Approval entry ${expected.sourceFingerprint} changed its classification set.`);
  }
  for (let index = 0; index < expectedClassifications.length; index += 1) {
    const current = actualClassifications[index];
    const source = expectedClassifications[index];
    if (current === undefined || source === undefined || same({
      action: current.action,
      fieldName: current.fieldName,
      confidence: current.confidence,
      rationale: current.rationale,
    }) !== same({
      action: source.action,
      fieldName: source.fieldName,
      confidence: source.confidence,
      rationale: source.rationale,
    })) throw new Error(`Approval entry ${expected.sourceFingerprint} changed classification evidence.`);
    if (current.value !== null && (typeof current.value !== "string" || current.value.trim() === "")) {
      throw new Error(`Approval entry ${expected.sourceFingerprint} has an invalid operator classification value.`);
    }
  }
}

function sourceCandidate(report: JsonObject, fingerprint: string): JsonObject {
  if (!Array.isArray(report.candidates)) throw new Error("Decision report candidates must be an array.");
  const matches = report.candidates.map((entry, index) => object(entry, `decision candidate[${index}]`))
    .filter((entry) => entry.sourceFingerprint === fingerprint);
  if (matches.length !== 1) throw new Error(`Decision report must contain exactly one candidate ${fingerprint}.`);
  return matches[0];
}

function repositoryFromDraft(draft: JsonObject): string {
  if (typeof draft.repository !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(draft.repository)) {
    throw new Error("Decision draft repository is not canonical OWNER/REPO text.");
  }
  return draft.repository;
}

function assertExactMarker(payload: string, marker: string, fingerprint: string): void {
  if (marker === "" || !payload.endsWith(marker) || payload.indexOf(marker) !== payload.lastIndexOf(marker)) {
    throw new Error(`Draft marker for ${fingerprint} cannot be preserved exactly; refusing entry.`);
  }
}

function applicableClassifications(classifications: readonly ApprovalClassification[]): {
  readonly fieldName: "Type" | "Priority" | "Effort";
  readonly value: string;
}[] {
  return classifications.flatMap((entry) => {
    if (entry.fieldName !== "Type" && entry.fieldName !== "Priority" && entry.fieldName !== "Effort") return [];
    if (entry.value === null) return [];
    return [{ fieldName: entry.fieldName, value: entry.value }];
  });
}

function suggestedHorizon(report: JsonObject, fingerprint: string): string | null {
  const decision = object(report.decision, "decision report decision");
  if (!Array.isArray(decision.candidates)) return null;
  const candidate = decision.candidates.map((entry, index) => object(entry, `decision candidate[${index}]`))
    .find((entry) => entry.sourceFingerprint === fingerprint);
  if (candidate === undefined || !Array.isArray(candidate.actions)) return null;
  const action = candidate.actions.map((entry, index) => object(entry, `decision action[${index}]`))
    .find((entry) => entry.action === "set_horizon");
  return action !== undefined && typeof action.proposed === "string" && action.proposed.trim() !== ""
    ? action.proposed
    : null;
}

function operationKey(input: {
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly action: "create_issue" | "append_evidence";
  readonly emissionContentSha256?: string | null;
}): string {
  return `${foldRepository(input.repository)}\0${input.sourceFingerprint}\0${input.action}`
    + (input.action === "append_evidence" ? `\0${input.emissionContentSha256 ?? ""}` : "");
}

function emissionFromMarker(payload: string): string {
  const match = /^emission-content-sha256: ([0-9a-f]{64})$/m.exec(payload);
  if (match === null) throw new Error("Approved payload marker has no canonical emission-content-sha256.");
  return match[1];
}

export function executionEvent(input: {
  readonly event: ExecutionEventName;
  readonly now: Date;
  readonly write: IntakeApplyResult["writes"][number];
  readonly decisionContentSha256: string;
  readonly issueNumber?: number | null;
  readonly issueId?: string | number | null;
  readonly commentId?: string | number | null;
  readonly error?: unknown;
  readonly emissionContentSha256?: string;
  readonly fieldReceipts?: ApprovalExecutionEvent["fieldReceipts"];
}): ApprovalExecutionEvent {
  const markerPayload = input.write.issue?.body ?? input.write.evidenceComment ?? "";
  return {
    schemaVersion: INTAKE_APPROVAL_LEDGER_SCHEMA,
    event: input.event,
    appliedAt: input.now.toISOString(),
    repository: input.write.repository,
    sourceFingerprint: input.write.sourceFingerprint,
    action: input.write.action,
    emissionContentSha256: input.emissionContentSha256
      ?? input.write.emissionContentSha256
      ?? emissionFromMarker(markerPayload),
    decisionContentSha256: input.decisionContentSha256,
    payload: {
      issue: input.write.issue,
      evidenceComment: input.write.evidenceComment,
      closeIssue: input.write.closeIssue,
    },
    classifications: input.write.classifications,
    ...(input.fieldReceipts?.length ? { fieldReceipts: input.fieldReceipts } : {}),
    issueNumber: validIssueNumber(input.issueNumber) ? input.issueNumber : null,
    issueId: input.issueId ?? null,
    commentId: input.commentId ?? null,
    ...(input.error === undefined ? {} : {
      error: input.error instanceof Error ? input.error.message : String(input.error),
    }),
  };
}

type PrimaryAction = ApprovalExecutionEvent["action"];
type EffectIdentity = ApprovalLedgerRecord["result"];

export interface HistoryIdentity {
  readonly repository: string;
  readonly sourceFingerprint: string;
  // Null asks for all historical actions; it never disables recognition.
  readonly action: PrimaryAction | null;
  readonly emissionContentSha256?: string | null;
}

interface HistoryRow {
  readonly rowNumber: number;
  readonly value: unknown;
}

interface HistoricalEffect {
  readonly repository: string | null;
  readonly sourceFingerprints: readonly string[];
  readonly action: PrimaryAction | null;
  readonly result: EffectIdentity;
  readonly classifications: ApprovalExecutionEvent["classifications"];
  readonly history: readonly HistoryRow[];
}

export type HistoricalOperation = HistoricalEffect & (
  | { readonly provenance: "staged"; readonly event: ApprovalExecutionEvent | AbandonedExecutionEvent | LegacyVerifiedExecutionEvent }
  | { readonly provenance: "legacy"; readonly event: null }
);
type StagedOperation = HistoricalOperation & { readonly provenance: "staged" };
type ActiveStagedOperation = StagedOperation & { readonly event: ApprovalExecutionEvent };

interface MalformedHistory {
  readonly repository: string | null;
  readonly sourceFingerprints: readonly string[];
  readonly reason: string;
  readonly history: readonly HistoryRow[];
  readonly unterminatedTail?: true;
}

interface HistoryConflict {
  readonly reason: string;
  readonly left: HistoricalOperation;
  readonly right: HistoricalOperation;
}

export interface HistoryIndex {
  readonly staged: Map<string, StagedOperation>;
  readonly stagedByEntry: Map<string, Map<string, StagedOperation>>;
  readonly legacy: Map<string, HistoricalOperation[]>;
  readonly malformed: MalformedHistory[];
  readonly conflicts: HistoryConflict[];
  rowCount: number;
}

interface DurableScope {
  readonly scope: HistoryIdentity;
  // Includes other actions, partial identities and original rows, even on a refusal.
  readonly operations: readonly HistoricalOperation[];
}

export type DurableState = DurableScope & (
  | { readonly kind: "never_attempted" }
  | { readonly kind: "intent_unknown"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "primary_unverified"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "classification_failed"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "withdrawn_dispositioned"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "complete"; readonly operation: StagedOperation & { readonly event: ApprovalExecutionEvent | LegacyVerifiedExecutionEvent } }
  | { readonly kind: "unresolved_unknown"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "unresolved_partial"; readonly operation: ActiveStagedOperation }
  | { readonly kind: "abandoned"; readonly operation: StagedOperation & { readonly event: AbandonedExecutionEvent } }
  | { readonly kind: "legacy_unverified"; readonly operation: HistoricalOperation }
  | { readonly kind: "conflict"; readonly conflicts: readonly HistoryConflict[] }
  | { readonly kind: "malformed"; readonly problems: readonly MalformedHistory[] }
  | { readonly kind: "multiple_actions" }
);

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function primaryAction(value: unknown): value is PrimaryAction {
  return value === "create_issue" || value === "append_evidence";
}

function canonicalRepository(value: unknown): value is string {
  return typeof value === "string" && /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(value);
}

function validIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function effectId(value: unknown): string | number | null {
  return (typeof value === "string" && value.length > 0)
    || (typeof value === "number" && Number.isSafeInteger(value)) ? value : null;
}

function effectIdentity(row: { readonly issueNumber?: unknown; readonly issueId?: unknown; readonly commentId?: unknown }): EffectIdentity {
  return { issueNumber: validIssueNumber(row.issueNumber) ? row.issueNumber : null,
    issueId: effectId(row.issueId), commentId: effectId(row.commentId) };
}

function storedClassifications(value: unknown): ApprovalExecutionEvent["classifications"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = asObject(raw);
    return item !== null && (item.fieldName === "Type" || item.fieldName === "Priority" || item.fieldName === "Effort")
      && typeof item.value === "string" && item.value.trim() !== ""
      ? [{ fieldName: item.fieldName, value: item.value }] : [];
  });
}

function reconciliationProblem(row: JsonObject, index: HistoryIndex): string | null {
  if (row.event !== "reconciled") return "reconciliation" in row ? "Non-reconciled event carries reconciliation metadata." : null;
  const evidence = asObject(row.reconciliation);
  const census = asObject(evidence?.census);
  const live = asObject(evidence?.live);
  const line = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 200 && !/[\r\n]/.test(value);
  const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (row.action !== "create_issue" || !validIssueNumber(row.issueNumber) || effectId(row.issueId) === null || row.commentId !== null
    || evidence === null || census === null || live === null
    || !Number.isSafeInteger(evidence.priorEventRowNumber) || Number(evidence.priorEventRowNumber) <= 0
    || typeof evidence.priorState !== "string" || !["intent_unknown", "unresolved_unknown", "unresolved_partial"].includes(evidence.priorState)
    || !line(evidence.runId) || evidence.runId.length > 200 || !line(evidence.operator)
    || !date(evidence.at) || evidence.at !== row.appliedAt || !line(census.artifactPath)
    || ![census.artifactSha256, census.contentSha256, census.coverageSha256, live.bodySha256].every(hash)
    || !date(census.capturedAt) || !date(live.createdAt) || !date(live.fetchedAt)
    || (live.requestId !== null && !line(live.requestId)) || typeof live.predatesAttempt !== "boolean") {
    return "Stored reconciliation evidence is malformed.";
  }
  const markerFields = { sourceFingerprint: "source-fingerprint", emissionContentSha256: "emission-content-sha256",
    producerKind: "producer-kind", producerVersion: "producer-version", stableArtifactId: "stable-artifact-id",
    stableOutcomeId: "stable-outcome-id", sourceLocator: "source-locator" };
  try {
    const markers = [evidence.censusMarker, evidence.liveMarker].map((value) => {
      const marker = asObject(value);
      if (marker === null || Object.keys(marker).length !== Object.keys(markerFields).length
        || Object.keys(markerFields).some((key) => !line(marker[key]))) throw new Error("Invalid marker fields.");
      return parseSourceMarker([SOURCE_MARKER, ...Object.entries(markerFields).map(([key, label]) => `${label}: ${marker[key]}`)].join("\n"));
    });
    if (same(markers[0]) !== same(markers[1]) || markers[0].sourceFingerprint !== row.sourceFingerprint) {
      return "Stored reconciliation markers disagree.";
    }
  } catch { return "Stored reconciliation marker is malformed."; }
  const prior = index.staged.get(operationKey(row as unknown as HistoryIdentity & { action: PrimaryAction }));
  const priorRows = prior?.history ?? [];
  // Retain terminal conflict evidence even when the new row's anchor is malformed.
  // These conflicts take precedence in the reducer and must never reopen an operation.
  if (prior !== undefined) {
    const reason = prior.event.event === "abandoned" ? "Abandoned operation has a later execution event."
      : prior.history.some((entry) => asObject(importedRow(entry.value))?.event === "reconciled")
        ? "Operation has a second reconciled event." : null;
    if (reason !== null) {
      const event = row as unknown as ApprovalExecutionEvent;
      index.conflicts.push({ reason, left: prior, right: { provenance: "staged", repository: event.repository,
        sourceFingerprints: [event.sourceFingerprint], action: event.action, result: effectIdentity(event),
        classifications: event.classifications, event, history: [{ rowNumber: index.rowCount, value: row }] } });
      return reason;
    }
  }
  const anchor = priorRows.at(-1);
  if (anchor === undefined || anchor.rowNumber !== evidence.priorEventRowNumber || anchor.rowNumber >= index.rowCount) {
    return "Stored reconciliation priorEventRowNumber must refer to the immediately preceding row of the same identity.";
  }
  const previous = importedRow(anchor.value) as ApprovalExecutionEvent;
  const retained = priorRows.reduce((result, entry) => {
    const identities = effectIdentity(importedRow(entry.value) as ApprovalExecutionEvent);
    return { issueNumber: identities.issueNumber ?? result.issueNumber,
      issueId: identities.issueId ?? result.issueId, commentId: identities.commentId ?? result.commentId };
  }, { issueNumber: null, issueId: null, commentId: null } as EffectIdentity);
  const priorState = previous.event === "intent" ? "intent_unknown" : previous.event === "create_unresolved"
    ? Object.values(retained).some((value) => value !== null) ? "unresolved_partial" : "unresolved_unknown" : null;
  if (priorState === null || priorState !== evidence.priorState) return "Stored reconciliation prior state is not unresolved.";
  if ((["issueNumber", "issueId", "commentId"] as const).some((field) => retained[field] !== null && retained[field] !== row[field])) {
    return "Stored reconciliation changes a retained identity.";
  }
  if (["payload", "classifications", "decisionContentSha256", "emissionContentSha256"].some((field) =>
    same(row[field]) !== same((previous as unknown as JsonObject)[field]))) return "Stored reconciliation changes the prior execution contract.";
  const firstAttemptAt = priorRows.map((entry) => (importedRow(entry.value) as ApprovalExecutionEvent).appliedAt)
    .filter(date).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (firstAttemptAt === undefined || live.predatesAttempt !== (Date.parse(live.createdAt) < Date.parse(firstAttemptAt))) {
    return "Stored reconciliation predatesAttempt disagrees with the prior attempt.";
  }
  return null;
}

// This boundary handles untrusted persisted data. Unknown values return a problem,
// never a runtime exhaustiveness exception or a false claim of absence.
function legacyVerificationProblem(row: JsonObject, index: HistoryIndex): string | null {
  const identity = row as unknown as HistoryIdentity & { action: PrimaryAction };
  const prior = index.staged.get(operationKey(identity));
  if (prior !== undefined && ["abandoned", "complete", "legacy_verified"].includes(prior.event.event)) {
    const reason = prior.event.event === "abandoned" ? "Abandoned operation has a later execution event."
      : "Terminal operation has a later legacy verification.";
    index.conflicts.push({ reason, left: prior, right: { provenance: "staged", repository: identity.repository,
      sourceFingerprints: [identity.sourceFingerprint], action: identity.action, result: effectIdentity(asObject(row.result) ?? {}),
      classifications: [], event: row as unknown as LegacyVerifiedExecutionEvent, history: [{ rowNumber: index.rowCount, value: row }] } });
    return reason;
  }
  const evidence = asObject(row.legacyVerification);
  const census = asObject(evidence?.census);
  const live = asObject(evidence?.live);
  const classification = asObject(evidence?.classification);
  const result = asObject(row.result);
  const line = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 200 && !/[\r\n]/.test(value);
  const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const filename = (value: unknown) => line(value) && !/[\\/]/.test(value) && value !== "." && value !== "..";
  if (row.action !== "create_issue" || evidence === null || census === null || live === null || classification === null || result === null
    || !validIssueNumber(result.issueNumber) || effectId(result.issueId) === null || result.commentId !== null
    || ["payload", "emissionContentSha256", "decisionContentSha256", "classifications", "abandonment", "reconciliation",
      "issueNumber", "issueId", "commentId"].some((key) => key in row)
    || !date(row.appliedAt) || evidence.at !== row.appliedAt || !line(evidence.operator) || !line(evidence.runId)
    || !filename(evidence.importedFrom) || !filename(census.basename)
    || ![evidence.legacyRowDigest, census.artifactSha256, census.contentSha256, census.coverageSha256, live.bodySha256].every(hash)
    || !Number.isSafeInteger(evidence.priorEventRowNumber) || Number(evidence.priorEventRowNumber) <= 0
    || !date(census.completedAt) || !date(live.createdAt) || !date(live.fetchedAt)
    || (live.requestId !== null && !line(live.requestId))) return "Stored legacy verification is malformed.";
  const markerFields = { sourceFingerprint: "source-fingerprint", emissionContentSha256: "emission-content-sha256",
    producerKind: "producer-kind", producerVersion: "producer-version", stableArtifactId: "stable-artifact-id",
    stableOutcomeId: "stable-outcome-id", sourceLocator: "source-locator" };
  try {
    const markers = [evidence.censusMarker, evidence.liveMarker].map((value) => {
      const marker = asObject(value);
      if (marker === null || Object.keys(marker).length !== Object.keys(markerFields).length
        || Object.keys(markerFields).some((key) => !line(marker[key]))) throw new Error("Invalid marker.");
      return parseSourceMarker([SOURCE_MARKER, ...Object.entries(markerFields).map(([key, label]) => `${label}: ${marker[key]}`)].join("\n"));
    });
    if (same(markers[0]) !== same(markers[1]) || markers[0].sourceFingerprint !== row.sourceFingerprint) return "Stored legacy verification markers disagree.";
  } catch { return "Stored legacy verification marker is malformed."; }
  const state = resolveDurableState(index, identity);
  if (state.kind !== "legacy_unverified" || state.operation.provenance !== "legacy" || state.operation.action !== "create_issue") {
    return "Stored legacy verification must follow a legacy_unverified create row.";
  }
  const anchor = state.operation.history.at(-1)!;
  const envelope = asObject(anchor.value);
  const legacy = asObject(importedRow(anchor.value));
  if (anchor.rowNumber !== evidence.priorEventRowNumber || anchor.rowNumber >= index.rowCount
    || envelope?.kind !== "legacy_import" || typeof envelope.importedFrom !== "string" || legacy === null
    || basename(envelope.importedFrom) !== evidence.importedFrom || canonicalJsonSha256(legacy) !== evidence.legacyRowDigest) {
    return "Stored legacy verification must bind the latest preceding imported legacy row.";
  }
  if (same(result) !== same(state.operation.result)) return "Stored legacy verification changes a retained identity.";
  const requested = parseLegacyRequested(legacy.operatorFinalClassification);
  if (requested === null || same(classification.requested) !== same(requested)) return "Stored legacy requested metadata is invalid.";
  try {
    const compared = compareLegacyClassification(requested, classification.observed as LegacyVerification["classification"]["observed"]);
    if (same(compared) !== same(classification)) return "Stored legacy classification comparison disagrees.";
  } catch { return "Stored legacy classification observation is malformed."; }
  if (!date(legacy.appliedAt) || Date.parse(census.completedAt) < Date.parse(legacy.appliedAt)) return "Stored legacy census predates the attempt.";
  return null;
}

function stagedProblem(row: JsonObject, index: HistoryIndex): string | null {
  if (row.schemaVersion !== INTAKE_APPROVAL_LEDGER_SCHEMA) return "Unsupported execution schema.";
  if (typeof row.event !== "string"
    || !["intent", "created", "reconciled", "complete", "classification_failed", "create_unresolved", "withdrawn_dispositioned", "abandoned", "legacy_verified"].includes(row.event)) {
    return "Unknown execution event.";
  }
  if (!canonicalRepository(row.repository)
    || typeof row.sourceFingerprint !== "string" || row.sourceFingerprint === "" || !primaryAction(row.action)) {
    return "Execution ownership is incomplete.";
  }
  if (row.event === "legacy_verified") return legacyVerificationProblem(row, index);
  if ("legacyVerification" in row) return "Non-legacy_verified event carries legacyVerification metadata.";
  const reconciliation = reconciliationProblem(row, index);
  if (reconciliation !== null) return reconciliation;
  if (row.event !== "abandoned" && row.abandonment != null) return "Non-abandoned event carries abandonment metadata.";
  const abandonment = asObject(row.abandonment);
  if (row.event === "abandoned" && (abandonment === null
    || typeof abandonment.reason !== "string" || abandonment.reason.trim() === ""
    || typeof abandonment.operator !== "string" || abandonment.operator.trim() === ""
    || typeof abandonment.priorState !== "string"
    || !["intent_unknown", "primary_unverified", "classification_failed", "unresolved_unknown", "unresolved_partial", "legacy_unverified"].includes(abandonment.priorState)
    || !Number.isSafeInteger(abandonment.priorEventRowNumber) || Number(abandonment.priorEventRowNumber) <= 0
    || typeof abandonment.at !== "string" || !Number.isFinite(Date.parse(abandonment.at))
    || abandonment.at !== row.appliedAt)) return "Stored abandonment is malformed.";
  if (row.event === "abandoned") {
    const priorRowNumber = Number(abandonment!.priorEventRowNumber);
    const repository = foldRepository(row.repository);
    const staged = index.staged.get(operationKey({ repository: row.repository,
      sourceFingerprint: row.sourceFingerprint, action: row.action,
      emissionContentSha256: typeof row.emissionContentSha256 === "string" ? row.emissionContentSha256 : null }));
    const legacy = (index.legacy.get(row.sourceFingerprint) ?? []).filter((operation) =>
      (operation.repository === null || foldRepository(operation.repository) === repository)
      && (operation.action === null || operation.action === row.action));
    if (priorRowNumber >= index.rowCount
      || ![...(staged?.history ?? []), ...legacy.flatMap((operation) => operation.history)]
        .some((prior) => prior.rowNumber === priorRowNumber)) {
      return "Stored abandonment priorEventRowNumber must refer to an earlier row of the same identity.";
    }
  }
  const legacyAbandonment = row.event === "abandoned" && abandonment?.priorState === "legacy_unverified";
  if (typeof row.appliedAt !== "string" || [row.emissionContentSha256, row.decisionContentSha256].some((hash) =>
    !(legacyAbandonment && hash === null) && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))) {
    return "Execution provenance is incomplete.";
  }
  const payload = asObject(row.payload);
  if (payload === null) return "Execution payload is malformed.";
  if (payload.issue !== null && (asObject(payload.issue) === null
    || typeof asObject(payload.issue)!.title !== "string" || typeof asObject(payload.issue)!.body !== "string")) {
    return "Stored issue payload is malformed.";
  }
  if (payload.evidenceComment !== null && typeof payload.evidenceComment !== "string") return "Stored comment is malformed.";
  if (payload.closeIssue !== null) {
    const close = asObject(payload.closeIssue);
    if (close === null || !validIssueNumber(close.targetIssueNumber) || close.before !== "OPEN" || close.after !== "CLOSED"
      || !Array.isArray(close.evidenceIds) || !close.evidenceIds.every((id) => typeof id === "string")) {
      return "Stored close payload is malformed.";
    }
  }
  if (!Array.isArray(row.classifications) || storedClassifications(row.classifications).length !== row.classifications.length) {
    return "Stored classifications are malformed.";
  }
  if (row.issueNumber != null && !validIssueNumber(row.issueNumber)) return "Stored issue number is malformed.";
  if ((row.issueId != null && effectId(row.issueId) === null) || (row.commentId != null && effectId(row.commentId) === null)) {
    return "Stored effect identity is malformed.";
  }
  if (row.event === "withdrawn_dispositioned") {
    const actions = row.completedActions;
    if (!Array.isArray(actions) || actions.some(action => ![row.action, "close_issue"].includes(action))
      || new Set(actions).size !== actions.length
      || (actions.includes(row.action) !== (row.action === "create_issue" ? validIssueNumber(row.issueNumber) : effectId(row.commentId) !== null))
      || (actions.includes("close_issue") && (payload.closeIssue === null || !actions.includes("append_evidence")))
      || (row.action === "create_issue" && !actions.includes("create_issue") && (row.issueId != null || row.commentId != null))) {
      return "Stored disposition withdrawal has inconsistent completed effects.";
    }
    const prior = index.staged.get(operationKey(row as unknown as ApprovalExecutionEvent));
    if (prior === undefined || !["intent", "created", "reconciled", "classification_failed"].includes(prior.event.event)) {
      return "Disposition withdrawal must follow an intent or a confirmed primary effect, never an ambiguous dispatch.";
    }
    if ((["issueNumber", "issueId", "commentId"] as const).some(field => prior.result[field] !== null && row[field] !== prior.result[field])) {
      return "Disposition withdrawal cannot discard a completed effect identity.";
    }
    if (prior.result.issueNumber !== null && row.action === "create_issue" && !actions.includes("create_issue")) {
      return "Disposition withdrawal cannot release a recorded create.";
    }
  }
  if ((row.event === "created" || row.event === "complete" || row.event === "classification_failed")
    && !validIssueNumber(row.issueNumber)) return "Recorded primary effect has no valid issue number.";
  if ((row.event === "created" || row.event === "complete" || row.event === "classification_failed")
    && row.action === "append_evidence" && effectId(row.commentId) === null) return "Recorded append has no comment identity.";
  return null;
}

function importedRow(value: unknown): unknown {
  const row = asObject(value);
  return row?.kind === "legacy_import" ? row.row : value;
}

function addHistoryRow(index: HistoryIndex, value: unknown): void {
  const history = [{ rowNumber: ++index.rowCount, value }];
  const row = asObject(importedRow(value));
  const repository = canonicalRepository(row?.repository) ? row.repository : null;
  const sourceFingerprints = [...new Set([row?.sourceFingerprint, row?.candidateFingerprint]
    .filter((item): item is string => typeof item === "string" && item !== ""))];
  const malformed = (reason: string) => index.malformed.push({ repository, sourceFingerprints, reason, history });
  if (row === null) { malformed("Ledger row is not an object."); return; }
  if ("event" in row) {
    const problem = stagedProblem(row, index);
    if (problem !== null) { malformed(problem); return; }
    const event = row.event === "legacy_verified" ? row as unknown as LegacyVerifiedExecutionEvent
      : { ...row, ...effectIdentity(row) } as ApprovalExecutionEvent | AbandonedExecutionEvent;
    const key = operationKey(event);
    const prior = index.staged.get(key);
    const result = event.event === "legacy_verified" ? event.result : effectIdentity(event);
    const classifications = event.event === "legacy_verified" ? event.legacyVerification.classification.requested : event.classifications;
    const current: StagedOperation = { provenance: "staged", repository: event.repository,
      sourceFingerprints: [event.sourceFingerprint], action: event.action, result,
      classifications, event, history };
    if (prior?.event.event === "legacy_verified") {
      index.conflicts.push({ reason: "Verified legacy operation has a later execution event.", left: prior, right: current });
      return;
    }
    if (prior !== undefined && event.event !== "legacy_verified") {
      // A late GitHub acceptance can still occur after abandonment. Abandonment
      // means "stop pursuing", not "the issue never existed". No later staged
      // event may reopen it; the summary counts abandoned operations separately.
      if (prior.event.event === "abandoned" || prior.event.event === "withdrawn_dispositioned") {
        index.conflicts.push({ reason: "Abandoned operation has a later execution event.", left: prior, right: current });
      }
      if (event.event === "reconciled" && prior.history.some((entry) => asObject(importedRow(entry.value))?.event === "reconciled")) {
        index.conflicts.push({ reason: "Operation has a second reconciled event.", left: prior, right: current });
      }
      for (const field of ["issueNumber", "issueId", "commentId"] as const) {
        if (prior.result[field] !== null && result[field] !== null && prior.result[field] !== result[field]) {
          malformed(`Conflicting recorded ${field}.`);
        }
      }
      if (prior.event.event === "complete" && event.event !== "complete") malformed("Completed operation regressed in history.");
      if (prior.event.emissionContentSha256 !== event.emissionContentSha256
        || prior.event.decisionContentSha256 !== event.decisionContentSha256
        || same(prior.classifications) !== same(event.classifications)
        || ((prior.event.payload.closeIssue === null) !== (event.payload.closeIssue === null))) {
        malformed("Conflicting stored execution contract.");
      }
      for (const [name, field] of [
        ["issue", "issue"],
        ["evidence comment", "evidenceComment"],
        ["close issue", "closeIssue"],
      ] as const) {
        const right = event.payload[field];
        if (right === null) continue;
        // History contains validated staged rows for this operation. Null gaps
        // must not hide an earlier populated observation or its provenance.
        for (const observation of prior.history) {
          const observed = importedRow(observation.value) as ApprovalExecutionEvent;
          const left = observed.payload[field];
          if (left !== null && same(left) !== same(right)) {
            index.conflicts.push({ reason: `Conflicting populated ${name} payload.`,
              left: { ...prior, event: observed, result: effectIdentity(observed), history: [observation] }, right: current });
            break;
          }
        }
      }
    }
    const retained = {
      issueNumber: result.issueNumber ?? prior?.result.issueNumber ?? null,
      issueId: result.issueId ?? prior?.result.issueId ?? null,
      commentId: result.commentId ?? prior?.result.commentId ?? null,
    };
    const operation: StagedOperation = { provenance: "staged", repository: event.repository,
      sourceFingerprints: [event.sourceFingerprint], action: event.action, result: retained,
      classifications, event: event.event === "legacy_verified" ? event : { ...event, ...retained }, history: [...(prior?.history ?? []), ...history] };
    index.staged.set(key, operation);
    const entryKey = `${foldRepository(event.repository)}\0${event.sourceFingerprint}`;
    const actions = index.stagedByEntry.get(entryKey) ?? new Map<string, StagedOperation>();
    actions.set(key, operation);
    index.stagedByEntry.set(entryKey, actions);
    return;
  }
  // Observations never establish execution. Legacy recognition has deliberately
  // broader attribution than staged ownership: either fingerprint, optional repo,
  // and no dependency on an action (which old summaries can misattribute).
  if (row.schemaVersion !== undefined && row.schemaVersion !== INTAKE_APPROVAL_LEDGER_SCHEMA) {
    malformed("Unsupported ledger schema."); return;
  }
  if (row.repository != null && repository === null) { malformed("Ledger repository is unattributable."); return; }
  if (row.mode === "dry-run" || (row.mode === "execute" && row.executed === false)) return;
  if (row.executed !== true || sourceFingerprints.length === 0) { malformed("Unattributable ledger row."); return; }
  const rawResult = asObject(row.result);
  if (rawResult === null) { malformed("Legacy effect identity is malformed."); return; }
  if ((rawResult.issueNumber != null && !validIssueNumber(rawResult.issueNumber))
    || (rawResult.issueId != null && effectId(rawResult.issueId) === null)
    || (rawResult.commentId != null && effectId(rawResult.commentId) === null)) {
    malformed("Legacy effect identity is malformed."); return;
  }
  const action = primaryAction(row.actionTaken) ? row.actionTaken : primaryAction(row.intendedAction) ? row.intendedAction : null;
  const operation: HistoricalOperation = { provenance: "legacy", event: null, repository, sourceFingerprints, action,
    result: effectIdentity(rawResult), classifications: storedClassifications(row.operatorFinalClassification), history };
  for (const prior of index.staged.values()) {
    if (prior.event.event === "abandoned"
      && (repository === null || foldRepository(prior.event.repository) === foldRepository(repository))
      && sourceFingerprints.includes(prior.event.sourceFingerprint)
      && (action === null || action === prior.action)) {
      // Reimporting the exact legacy evidence behind an abandonment does not reopen it.
      if (prior.event.abandonment.priorState === "legacy_unverified"
        && (["issueNumber", "issueId", "commentId"] as const).every((field) => prior.result[field] === operation.result[field])) continue;
      index.conflicts.push({ reason: "Abandoned operation has a later legacy execution row.", left: prior, right: operation });
    }
  }
  for (const fingerprint of sourceFingerprints) {
    const entries = index.legacy.get(fingerprint) ?? [];
    for (const prior of entries) {
      if (prior.repository !== null && repository !== null && foldRepository(prior.repository) !== foldRepository(repository)) continue;
      if (action === null || prior.action !== action) continue;
      if ((["issueNumber", "issueId", "commentId"] as const).some((field) => prior.result[field] !== null
        && operation.result[field] !== null && prior.result[field] !== operation.result[field])) {
        index.conflicts.push({ reason: "Conflicting legacy effect identities.", left: prior, right: operation });
      }
    }
    entries.push(operation);
    index.legacy.set(fingerprint, entries);
  }
}

export function indexHistory(priorLedger: readonly unknown[], tail: JournalTail | null = null): HistoryIndex {
  const index: HistoryIndex = {
    staged: new Map(), stagedByEntry: new Map(), legacy: new Map(), malformed: [], conflicts: [], rowCount: 0,
  };
  for (const row of priorLedger) addHistoryRow(index, row);
  if (tail !== null) {
    const segment = tail.bytes.toString("utf8");
    // Read identity evidence only. Even complete JSON in a torn line is never an
    // execution event. Partial JSON can still carry complete ownership strings.
    const strings = (field: string) => [...segment.matchAll(new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, "g"))]
      .flatMap((match) => { try { return [JSON.parse(match[1]) as string]; } catch { return []; } });
    const repository = strings("repository").find(canonicalRepository) ?? null;
    const sourceFingerprints = [...new Set([...strings("sourceFingerprint"), ...strings("candidateFingerprint")])];
    index.malformed.push({ repository, sourceFingerprints, unterminatedTail: true,
      reason: "Unterminated journal tail.", history: [{ rowNumber: ++index.rowCount, value: { malformedJson: segment } }] });
  }
  return index;
}

export interface RepositoryCreateBudget {
  readonly count: number;
  readonly ceiling: number;
  readonly windowHours: number;
  readonly windowStart: string;
  readonly asOf: string;
  readonly problem?: string;
}

/** Pure derivation, never ownership evidence. Keep the entire journal: only charges age.
 * The first intent reserves the identity even if dispatch never happened. Historical
 * staged records lacking intent and executed legacy rows conservatively charge their
 * earliest recorded attempt, using appliedAt, never the import/recovery timestamp. */
export function deriveRepositoryCreateBudget(history: HistoryIndex, repository: string, now: Date): RepositoryCreateBudget {
  const folded = foldRepository(repository);
  const nowMs = now.getTime();
  const windowMs = INTAKE_CREATE_LIMITS.windowHours * 60 * 60 * 1000;
  const charges = new Map<string, number>();
  let problem: string | undefined;
  const scoped = (repo: string | null) => repo === null || foldRepository(repo) === folded;
  if (!Number.isFinite(nowMs)) problem = "Invalid budget clock.";
  // Integrity belongs to the physical journal, even when an unreadable row claims
  // to belong elsewhere. Scope filters charges only, never evidence of corruption.
  if (history.malformed.length > 0) problem = "Malformed or torn repository journal.";
  if (history.conflicts.length > 0) {
    problem = "Conflicting repository journal.";
  }
  const timestampFor = (at: unknown) => {
    // Date.parse otherwise interprets offset-free date-times in the host's TZ.
    // Unknown time refuses; guessing UTC could age out a still-chargeable effect.
    const timestamp = typeof at === "string" && /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(at.trim()) ? Date.parse(at) : NaN;
    if (!Number.isFinite(timestamp)) problem = "Create history has no valid timezone-qualified appliedAt timestamp.";
    return timestamp;
  };
  const charge = (key: string, at: unknown) => {
    const timestamp = timestampFor(at);
    if (!Number.isFinite(timestamp)) return;
    charges.set(key, Math.min(charges.get(key) ?? Infinity, timestamp));
  };
  const legacy = new Set([...history.legacy.values()].flat());
  for (const operation of legacy) {
    for (const entry of operation.history) {
      const row = asObject(importedRow(entry.value))!;
      timestampFor(row.appliedAt);
      if (primaryAction(row.actionTaken) && primaryAction(row.intendedAction) && row.actionTaken !== row.intendedAction) {
        problem = "Contradictory legacy execution actions.";
      }
    }
    if (operation.action !== "append_evidence" && operation.result.issueNumber === null) {
      problem = "Legacy create history has no recorded issue number.";
    }
  }
  for (const operation of history.staged.values()) {
    const state = resolveDurableState(history, operation.event);
    // A completed append still sees the one unfinished/abandoned append from a
    // later emission. That ambiguity governs appends, but is not create damage.
    // Keep every other ambiguity and all integrity checks, including foreign rows.
    const pendingAppends = state.operations.filter((candidate) => candidate.action === "append_evidence"
      && candidate.event?.event !== "complete");
    const appendEmissionOverlap = state.kind === "multiple_actions" && operation.action === "append_evidence"
      && operation.event.event === "complete" && state.operations.every((candidate) => candidate.provenance === "staged")
      && pendingAppends.length === 1 && pendingAppends[0].event !== null
      && pendingAppends[0].event.event !== "legacy_verified" && pendingAppends[0].event.emissionContentSha256 != null
      && pendingAppends[0].event.emissionContentSha256 !== operation.event.emissionContentSha256;
    if (state.kind === "conflict" || state.kind === "malformed" || (state.kind === "multiple_actions" && !appendEmissionOverlap)) {
      problem = "Conflicting repository create identity.";
    }
    const rows = operation.history.map((entry) => asObject(importedRow(entry.value))!);
    for (const row of rows) timestampFor(row.appliedAt);
    if (!scoped(operation.repository) || operation.action !== "create_issue") continue;
    if (operation.event.event === "withdrawn_dispositioned" && operation.result.issueNumber === null) continue;
    // A recorded effect is the repository's issue number, independent of which
    // legacy alias names it. Unconfirmed intents keep their operation identity;
    // compatible legacy evidence can supply the issue number through any alias.
    const issueNumbers = new Set([operation.result.issueNumber, ...state.operations
      .filter((candidate) => candidate.provenance === "legacy" && candidate.action !== "append_evidence")
      .map((candidate) => candidate.result.issueNumber)].filter((number) => number !== null));
    if (issueNumbers.size > 1) problem = "Conflicting repository create identity.";
    const issueNumber = issueNumbers.values().next().value;
    const key = issueNumber === undefined ? `attempt:${operationKey(operation.event)}` : `issue:${folded}:${issueNumber}`;
    const intents = rows.filter((row) => row.event === "intent");
    // Legacy verification/abandonment is not a new attempt: its imported row supplies the charge.
    const attempts = intents.length > 0 ? intents : rows.filter((row) => row.event !== "legacy_verified" && row.event !== "abandoned");
    for (const row of attempts) charge(key, row.appliedAt);
  }
  for (const operation of legacy) {
    if (!scoped(operation.repository) || operation.action === "append_evidence") continue;
    for (const entry of operation.history) {
      const row = asObject(importedRow(entry.value))!;
      // Older rows omit repository and sometimes action. Attribute possible creates
      // to this journal's repository; never silently discard ambiguous damage.
      charge(`issue:${folded}:${operation.result.issueNumber}`, row.appliedAt);
    }
  }
  return {
    // Future timestamps stay charged (clock rollback must not grant free creates).
    count: [...charges.values()].filter((at) => at > nowMs - windowMs).length,
    ceiling: INTAKE_CREATE_LIMITS.repositoryCreates, windowHours: INTAKE_CREATE_LIMITS.windowHours,
    windowStart: Number.isFinite(nowMs) ? new Date(nowMs - windowMs).toISOString() : "invalid",
    asOf: Number.isFinite(nowMs) ? now.toISOString() : "invalid",
    ...(problem === undefined ? {} : { problem }),
  };
}

function createQuotaRefusal(budget: RepositoryCreateBudget, immediate: boolean, invocationCreates: number, override: boolean): string | undefined {
  const window = `window=rolling ${budget.windowHours}h (${budget.windowStart} to ${budget.asOf})`;
  if (budget.problem !== undefined) return `repository_create_budget_unavailable: ${window}; count=unknown; ${budget.problem}`;
  if (immediate && invocationCreates >= INTAKE_CREATE_LIMITS.immediateCreates) {
    return `immediate_create_limit_exhausted: window=invocation; count=${invocationCreates}; ceiling=${INTAKE_CREATE_LIMITS.immediateCreates}; repository_count=${budget.count}; ${window}`;
  }
  if (!override && budget.count >= budget.ceiling) {
    return `repository_create_budget_exhausted: ${window}; count=${budget.count}; ceiling=${budget.ceiling}; supervised operators may use --allow-create-budget-overrun.`;
  }
  return undefined;
}

export function resolveDurableState(index: HistoryIndex, identity: HistoryIdentity, completedReplay = false): DurableState {
  const repository = foldRepository(identity.repository);
  const staged = [...(index.stagedByEntry.get(`${repository}\0${identity.sourceFingerprint}`)?.values() ?? [])];
  const legacy = (index.legacy.get(identity.sourceFingerprint) ?? [])
    .filter((operation) => operation.repository === null || foldRepository(operation.repository) === repository);
  const base = { scope: identity, operations: [...staged, ...legacy] };
  // Emissions distinguish successful append effects, never reset safety history.
  // Old journals had no emission-scoped identity: non-complete operations govern
  // new work. Exact completed replay performs no work, but still checks every
  // legacy row and conflict before selecting its recorded result.
  const exactComplete = completedReplay && identity.action === "append_evidence" && identity.emissionContentSha256 != null
    && staged.some(operation => operation.action === identity.action && operation.event.event === "complete"
      && operation.event.emissionContentSha256 === identity.emissionContentSha256);
  const governsEmission = (operation: HistoricalOperation) => identity.action !== "append_evidence"
    || identity.emissionContentSha256 == null || operation.event === null
    || operation.event.action !== "append_evidence" || !exactComplete && operation.event.event !== "complete"
    || operation.event.emissionContentSha256 === identity.emissionContentSha256;
  const terminalConflicts = index.conflicts.filter((conflict) => (conflict.left.event?.event === "abandoned" || conflict.left.event?.event === "withdrawn_dispositioned"
    || conflict.left.event?.event === "legacy_verified" || conflict.reason === "Terminal operation has a later legacy verification."
    || conflict.reason === "Operation has a second reconciled event.")
    && conflict.left.repository !== null && foldRepository(conflict.left.repository) === repository
    && conflict.left.sourceFingerprints.includes(identity.sourceFingerprint)
    && (identity.action === null || conflict.left.action === identity.action));
  if (terminalConflicts.length > 0) return { ...base, kind: "conflict", conflicts: terminalConflicts };
  const legacyConflicts = index.conflicts.filter((conflict) => conflict.left.provenance === "legacy"
    && conflict.right.provenance === "legacy"
    && [conflict.left, conflict.right].every((operation) =>
      (operation.repository === null || foldRepository(operation.repository) === repository)
      && operation.sourceFingerprints.includes(identity.sourceFingerprint)
      && (identity.action === null || operation.action === identity.action)));
  if (legacyConflicts.length > 0) return { ...base, kind: "conflict", conflicts: legacyConflicts };
  const problems = index.malformed.filter((problem) => (problem.repository === null || foldRepository(problem.repository) === repository)
    && ((problem.sourceFingerprints.length === 0 && !problem.unterminatedTail)
      || problem.sourceFingerprints.includes(identity.sourceFingerprint)));
  if (problems.length > 0) return { ...base, kind: "malformed", problems };
  const actionStaged = identity.action === null ? staged : staged.filter((operation) => operation.action === identity.action);
  const selected = actionStaged.filter(governsEmission);
  const stagedConflicts = index.conflicts.filter((conflict) => conflict.left.repository !== null && foldRepository(conflict.left.repository) === repository
    && conflict.left.sourceFingerprints.includes(identity.sourceFingerprint)
    && actionStaged.some((operation) => operation.action === conflict.left.action));
  const crossFormatConflicts = (identity.action === "append_evidence" ? actionStaged : selected).flatMap((stagedOperation) => legacy.flatMap((legacyOperation) => {
    if (legacyOperation.action !== null && legacyOperation.action !== stagedOperation.action) {
      return [{ reason: `Cross-format action disagreement: staged ${stagedOperation.action}; legacy ${legacyOperation.action}.`,
        left: stagedOperation, right: legacyOperation }];
    }
    const fields = (["issueNumber", "issueId", "commentId"] as const).filter((field) =>
      stagedOperation.result[field] !== null && legacyOperation.result[field] !== null
      && stagedOperation.result[field] !== legacyOperation.result[field]);
    return fields.map((field) => ({
      reason: `Cross-format ${field} disagreement: staged ${String(stagedOperation.result[field])}; legacy ${String(legacyOperation.result[field])}.`,
      left: stagedOperation, right: legacyOperation,
    }));
  }));
  const conflicts = [...stagedConflicts, ...crossFormatConflicts];
  if (conflicts.length > 0) return { ...base, kind: "conflict", conflicts };
  if (selected.length > 1 || new Set([...selected, ...legacy].map((operation) => operation.action).filter((action) => action !== null)).size > 1) {
    return { ...base, kind: "multiple_actions" };
  }
  const selectedOperation = selected[0];
  if (selectedOperation === undefined) {
    return legacy.length > 0
      ? { ...base, kind: "legacy_unverified", operation: legacy[legacy.length - 1] }
      : { ...base, kind: "never_attempted" };
  }
  if (selectedOperation.event.event === "abandoned") {
    return { ...base, kind: "abandoned", operation: { ...selectedOperation, event: selectedOperation.event } };
  }
  if (selectedOperation.event.event === "legacy_verified") {
    return { ...base, kind: "complete", operation: { ...selectedOperation, event: selectedOperation.event } };
  }
  const operation = { ...selectedOperation, event: selectedOperation.event };
  const event = operation.event.event;
  switch (event) {
    case "intent": return { ...base, kind: "intent_unknown", operation };
    case "created": case "reconciled": return { ...base, kind: "primary_unverified", operation };
    case "classification_failed": return { ...base, kind: "classification_failed", operation };
    case "withdrawn_dispositioned": return { ...base, kind: "withdrawn_dispositioned", operation };
    case "complete": return { ...base, kind: "complete", operation };
    case "create_unresolved": return { ...base,
      kind: Object.values(operation.result).some((value) => value !== null) ? "unresolved_partial" : "unresolved_unknown", operation };
    default: { const exhaustive: never = event; return exhaustive; }
  }
}

/** Bind read-only replay and recovery to the submitted emission, retaining the
 * ordinary fingerprint-wide barriers before any operation can be recovered. */
export function resolveSubmittedReplayState(index: HistoryIndex, identity: HistoryIdentity): DurableState {
  const broad = resolveDurableState(index, identity);
  if (identity.emissionContentSha256 == null) return broad;
  const matching = broad.operations.filter((operation): operation is StagedOperation => operation.provenance === "staged"
    && (identity.action === null || operation.action === identity.action)
    && "emissionContentSha256" in operation.event && operation.event.emissionContentSha256 === identity.emissionContentSha256);
  if (matching.length !== 1) return broad;
  const bound = { ...identity, action: matching[0].action };
  if (bound.action === "append_evidence") {
    const create = resolveDurableState(index, { ...identity, action: "create_issue" });
    if (create.kind !== "never_attempted" && create.kind !== "complete") return { ...create, scope: bound };
  } else {
    const append = resolveDurableState(index, { ...identity, action: "append_evidence" });
    if (append.kind !== "never_attempted" && append.kind !== "complete") return { ...append, scope: bound };
  }
  // Only a completed, exact append can ignore another emission's unfinished or
  // abandoned operation: it performs no transport. Conflict/legacy checks remain.
  return resolveDurableState(index, bound, true);
}

export function eventWrite(event: ApprovalExecutionEvent): IntakeApplyResult["writes"][number] {
  const payload = object(event.payload, "approval execution event payload");
  if (!Array.isArray(event.classifications)) throw new Error("Approval execution event classifications are invalid.");
  return {
    sourceFingerprint: event.sourceFingerprint,
    repository: event.repository,
    action: event.action,
    actions: [event.action],
    canonicalIssueNumber: event.action === "append_evidence" ? event.issueNumber : null,
    issue: (payload.issue ?? null) as IntakeApplyResult["writes"][number]["issue"],
    evidenceComment: typeof payload.evidenceComment === "string" ? payload.evidenceComment : null,
    closeIssue: (payload.closeIssue ?? null) as IntakeApprovalEntry["closeIssue"],
    classifications: event.classifications,
    suggestedHorizon: null,
    emissionContentSha256: event.emissionContentSha256,
  };
}

/** Check the trusted run pin and resolve origin/main afresh at every write boundary. */
export function assertNoDispositionBeforeWrite(write: Pick<IntakeApplyResult["writes"][number], "sourceFingerprint" | "issue" | "evidenceComment">, input: {
  readonly repoRoot?: string;
  readonly runGit?: GitRunner;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly trustedCurrentOriginMainSha?: string;
  readonly stableOutcomeId?: string;
}): void {
  const options = { repoRoot: input.repoRoot, runGit: input.runGit ?? runCredentialCleanGit };
  const lookup = input.dispositionHistory ?? dispositionHistory;
  // Read both before deciding: an unreadable history must never look like an empty one.
  const trustedDispositions = input.trustedCurrentOriginMainSha === undefined ? undefined
    : lookup(input.trustedCurrentOriginMainSha, options);
  const currentDispositions = lookup("origin/main", options);
  const payload = write.issue?.body ?? write.evidenceComment ?? "";
  // The verified envelope or ownership proof is authoritative for classification-
  // only recovery, whose journal payload can be absent or from an older producer.
  const marker = input.stableOutcomeId === undefined && payload.includes(SOURCE_MARKER)
    ? parseSourceMarker(payload.slice(payload.lastIndexOf(SOURCE_MARKER))) : undefined;
  const stableOutcomeId = input.stableOutcomeId ?? marker?.stableOutcomeId;
  if (stableOutcomeId === undefined) throw new UnboundOutcomeIdentity();
  if (trustedDispositions?.has(stableOutcomeId) || currentDispositions.has(stableOutcomeId)) throw new DispositionedWrite();
}

/** Shared by apply recovery and positive create reconciliation. Preflight stays batched in apply. */
export async function confirmClassification(input: {
  readonly transport: () => FencedIntakeApprovalTransport;
  readonly claim: Pick<ReturnType<typeof acquireExecutionClaim>, "withOwnership">;
  readonly fence: () => void;
  readonly recordTransition: (event: ApprovalExecutionEvent) => void;
  readonly write: IntakeApplyResult["writes"][number];
  readonly identities: { readonly issueNumber: number; readonly issueId: string | number | null; readonly commentId: string | number | null };
  readonly apply: boolean;
  readonly now: Date;
  readonly decisionContentSha256: string;
  readonly emissionContentSha256?: string;
  readonly preflight?: boolean;
  readonly beforeWrite: () => void;
  readonly onComplete?: () => void;
  readonly onFailure?: (event: ApprovalExecutionEvent, error: unknown) => void;
}): Promise<ApprovalExecutionEvent> {
  const { transport, claim, fence, recordTransition, write, identities, apply } = input;
  const provenance = { now: input.now, write, decisionContentSha256: input.decisionContentSha256,
    emissionContentSha256: input.emissionContentSha256, ...identities };
  const fieldWrites: Parameters<FieldWriteReadPort["readBackFieldWrite"]>[2][] = [];
  try {
    input.beforeWrite();
    if (input.preflight) await transport().preflightClassifications([{
      sourceFingerprint: write.sourceFingerprint, repository: write.repository, classifications: write.classifications,
    }]);
    if (apply) {
      for (const classification of write.classifications) {
        await claim.withOwnership(async () => {
          const currentTransport = transport();
          if (classification.fieldName === "Priority" || classification.fieldName === "Effort") {
            let snapshot: FieldEventSnapshot | null = null;
            try {
              snapshot = await currentTransport.snapshotFieldEvents?.(write.repository, identities.issueNumber, classification.fieldName) ?? null;
            } catch {
              // Missing provenance must not prevent the classification write.
            }
            // Recovery takes a fresh snapshot. An earlier run's write may already hold
            // this value; that no-op rerun deliberately produces no receipt.
            fieldWrites.push({ fieldName: classification.fieldName, value: classification.value,
              writeStartedAt: new Date().toISOString(), snapshot });
          }
          input.beforeWrite();
          return currentTransport.applyClassification(write.repository, identities.issueNumber, classification, fence);
        });
      }
    }
    let verified: boolean;
    try {
      verified = await transport().verifyClassifications(write.repository, identities.issueNumber, write.classifications);
    } catch (error) {
      if (error instanceof JournalWriteError || error instanceof ExecutionOwnershipError) throw error;
      throw new Error(`Classification read-back unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!verified) throw new Error("Classification read-back mismatched the requested values.");
    const fieldReceipts: NonNullable<ApprovalExecutionEvent["fieldReceipts"]>[number][] = [];
    for (const fieldWrite of fieldWrites) {
      if (fieldWrite.snapshot === null) continue;
      try {
        const receipt = await transport().readBackFieldWrite?.(write.repository, identities.issueNumber, fieldWrite);
        if (receipt != null) fieldReceipts.push({ field: fieldWrite.fieldName, value: fieldWrite.value, ...receipt });
      } catch {
        // Receipt availability never changes the outcome of a verified write.
      }
    }
    const complete = executionEvent({ event: "complete", ...provenance, fieldReceipts });
    recordTransition(complete);
    input.onComplete?.();
    return complete;
  } catch (error) {
    if (error instanceof JournalWriteError || error instanceof ExecutionOwnershipError) throw error;
    if (error instanceof DispositionedWrite) {
      const withdrawn: ApprovalExecutionEvent = { ...executionEvent({ event: "withdrawn_dispositioned", ...provenance }),
        completedActions: [write.action, ...(write.closeIssue === null ? [] : ["close_issue" as const])] };
      recordTransition(withdrawn);
      return withdrawn;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = executionEvent({ event: "classification_failed", ...provenance, error: message });
    recordTransition(failed);
    input.onFailure?.(failed, error);
    return failed;
  }
}

export type UnresolvedCreateState = Extract<DurableState, { kind: "intent_unknown" | "unresolved_unknown" | "unresolved_partial" }>;

export function firstCreateAttemptAt(state: UnresolvedCreateState): string {
  const firstAttemptAt = state.operation.history.map(({ value }) => {
    const row = asObject(value);
    return (row?.kind === "legacy_import" ? asObject(row.row) : row)?.appliedAt;
  }).filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (firstAttemptAt === undefined) throw new Error("Reconcile refused: prior attempt has no valid timestamp.");
  return firstAttemptAt;
}

interface CreateReconciliationInput {
  readonly identity: HistoryIdentity;
  readonly priorState: UnresolvedCreateState;
  readonly census: IntakeSnapshotV1;
  readonly censusBinding: CensusBinding;
}

/** Pure preview shared by apply and resolve; absence never authorizes a create. */
export function proveUnresolvedCreate(input: CreateReconciliationInput): OwnershipProof | OwnershipRefusal {
  const firstAttemptAt = firstCreateAttemptAt(input.priorState);
  try {
    return proveCreateOwnership({ ...input.identity, retained: input.priorState.operation.result, firstAttemptAt,
      emissionContentSha256: input.priorState.operation.event.emissionContentSha256,
      census: input.census, censusBinding: input.censusBinding });
  } catch (cause) {
    return { kind: "refusal", reason: "binding_mismatch", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

type ReconciliationClaim = Pick<ReturnType<typeof acquireExecutionClaim>, "withOwnership">;

/** GET only. Apply stages these confirmations before its single classification preflight. */
export async function confirmCreateReconciliation(input: {
  readonly priorState: UnresolvedCreateState;
  readonly proof: OwnershipProof;
  readonly transport: FencedIntakeApprovalTransport;
  readonly claim: ReconciliationClaim;
}): Promise<LiveConfirmation | OwnershipRefusal> {
  const { priorState, proof, transport, claim } = input;
  const confirmation = await confirmOwnershipLive(proof, {
    fetchIssue: (repository, issueNumber) => claim.withOwnership(() => {
      if (transport.fetchIssue === undefined) throw new Error("Execution transport cannot confirm create ownership: fetchIssue is required.");
      return transport.fetchIssue(repository, issueNumber);
    }),
  }, { firstAttemptAt: firstCreateAttemptAt(priorState) });
  if (confirmation.kind === "refusal") return confirmation;
  const retained = priorState.operation.result;
  if (!matchesIssueId(retained.issueId, confirmation.live.issueId, confirmation.live.nodeId)
    || (retained.issueNumber !== null && retained.issueNumber !== confirmation.live.issueNumber) || retained.commentId !== null) {
    return { kind: "refusal", reason: "retained_identity_mismatch", detail: "Reconciliation cannot replace a populated journal identity." };
  }
  return confirmation;
}

/** Shared positive reconciliation. Apply can supply its GET-confirmed evidence after batched preflight. */
export async function reconcileCreate(input: CreateReconciliationInput & {
  readonly transport: FencedIntakeApprovalTransport;
  readonly claim: ReconciliationClaim;
  readonly fence: () => void;
  readonly recordTransition: (event: ApprovalExecutionEvent) => void;
  readonly readCurrentJournal: () => ReturnType<typeof readJournal>;
  readonly now?: Date;
  readonly runId: string;
  readonly operator: string;
  readonly confirmed?: LiveConfirmation;
  readonly preflight?: boolean;
  readonly beforeWrite: () => void;
  readonly onReconciled?: (predatesAttempt: boolean) => void;
  readonly onComplete?: () => void;
  readonly onFailure?: (event: ApprovalExecutionEvent, error: unknown) => void;
}): Promise<{ readonly kind: "refused"; readonly reason: OwnershipRefusal["reason"]; readonly detail: string; readonly candidates?: readonly number[] }
  | { readonly kind: "withdrawn_dispositioned"; readonly terminal: ApprovalExecutionEvent }
  | { readonly kind: "complete" | "classification_failed" | "withdrawn_dispositioned"; readonly terminal: ApprovalExecutionEvent;
    readonly reconciled: ApprovalExecutionEvent; readonly proof: OwnershipProof; readonly predatesAttempt: boolean }> {
  // An unconfirmed intent can be withdrawn before even the ownership GET. Later
  // ambiguous dispatches retain their identities through positive reconciliation.
  if (input.priorState.kind === "intent_unknown" && input.confirmed === undefined) {
    try { input.beforeWrite(); }
    catch (error) {
      if (error instanceof UnboundOutcomeIdentity) return { kind: "refused", reason: "unbound_outcome_identity", detail: error.message };
      if (!(error instanceof DispositionedWrite)) throw error;
      const journal = input.readCurrentJournal();
      const state = resolveDurableState(indexHistory(journal.records, journal.tail), input.identity);
      if (state.kind !== "intent_unknown"
        || state.operation.history.at(-1)!.rowNumber !== input.priorState.operation.history.at(-1)!.rowNumber) {
        return { kind: "refused", reason: "state_drift", detail: "Reconcile refused: intent changed before withdrawal." };
      }
      const prior = state.operation.event;
      const terminal: ApprovalExecutionEvent = { ...executionEvent({ event: "withdrawn_dispositioned",
        now: input.now ?? new Date(), write: eventWrite(prior), decisionContentSha256: prior.decisionContentSha256,
        ...state.operation.result }), completedActions: [] };
      input.recordTransition(terminal);
      return { kind: "withdrawn_dispositioned", terminal };
    }
  }
  let confirmation = input.confirmed;
  if (confirmation === undefined) {
    const proof = proveUnresolvedCreate(input);
    if (proof.kind === "refusal") return { ...proof, kind: "refused" };
    const live = await confirmCreateReconciliation({ ...input, proof });
    if (live.kind === "refusal") return { ...live, kind: "refused" };
    confirmation = live;
  }
  const { priorState, identity } = input;
  const prior = priorState.operation.event;
  const latest = priorState.operation.history.at(-1)!;
  const currentJournal = input.readCurrentJournal();
  const currentState = resolveDurableState(indexHistory(currentJournal.records, currentJournal.tail), identity);
  if (currentState.kind !== priorState.kind) {
    return { kind: "refused", reason: "state_drift",
      detail: `Reconcile refused: current state ${currentState.kind}; expected state ${priorState.kind}.` };
  }
  if (currentState.operation.history.at(-1)!.rowNumber !== latest.rowNumber) {
    return { kind: "refused", reason: "state_drift",
      detail: `Reconcile refused: priorEventRowNumber ${latest.rowNumber}; latest event row ${currentState.operation.history.at(-1)!.rowNumber}.` };
  }
  const now = input.now ?? new Date();
  const { proof } = confirmation;
  const predatesAttempt = confirmation.predatesAttempt === true;
  const identities = { issueNumber: confirmation.live.issueNumber,
    issueId: priorState.operation.result.issueId ?? confirmation.live.nodeId, commentId: null };
  const live = { issueId: confirmation.live.issueId, nodeId: confirmation.live.nodeId,
    bodySha256: confirmation.live.bodySha256, createdAt: confirmation.live.createdAt,
    fetchedAt: confirmation.live.fetchedAt, requestId: confirmation.live.requestId ?? null, predatesAttempt };
  const event: ApprovalExecutionEvent = {
    ...executionEvent({ event: "reconciled", now, write: eventWrite(prior), ...identities,
      decisionContentSha256: prior.decisionContentSha256, emissionContentSha256: prior.emissionContentSha256 }),
    reconciliation: { priorEventRowNumber: latest.rowNumber, priorState: priorState.kind, runId: input.runId,
      census: { ...proof.censusBinding, artifactPath: basename(proof.censusBinding.artifactPath), capturedAt: proof.capturedAt },
      live, censusMarker: proof.censusMarker, liveMarker: confirmation.live.liveMarker, operator: input.operator, at: now.toISOString() },
  };
  const reconciledState = resolveDurableState(indexHistory([...currentJournal.records, event], currentJournal.tail), identity);
  if (reconciledState.kind !== "primary_unverified") {
    return { kind: "refused", reason: "reconciled_state_invariant",
      detail: `Reconcile refused: proposed event resolves to ${reconciledState.kind}.` };
  }
  // appendJournal fsyncs this row before confirmClassification can dispatch any POST.
  input.recordTransition(event);
  input.onReconciled?.(predatesAttempt);
  const terminal = await confirmClassification({ transport: () => input.transport, claim: input.claim, fence: input.fence,
    recordTransition: input.recordTransition, write: eventWrite(prior), identities, apply: true, preflight: input.preflight, now,
    decisionContentSha256: prior.decisionContentSha256, emissionContentSha256: prior.emissionContentSha256,
    beforeWrite: input.beforeWrite, onComplete: input.onComplete, onFailure: input.onFailure });
  return { kind: terminal.event === "complete" ? "complete" : terminal.event === "withdrawn_dispositioned" ? "withdrawn_dispositioned" : "classification_failed", terminal, reconciled: event, proof, predatesAttempt };
}

function readLedger(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => {
    try { return JSON.parse(line) as unknown; }
    catch { return { malformedJson: line }; }
  });
}

export interface InvocationContext {
  readonly entry: IntakeApprovalEntry;
  readonly source: IntakeApprovalEntry;
  readonly now: Date;
  readonly mode: "dry-run" | "execute";
  readonly existenceRevalidation?: ExistenceRevalidation;
}

export function projectResult(durableState: DurableState, invocationContext: InvocationContext): ApprovalLedgerRecord {
  const input = invocationContext;
  let executed = false;
  let disposition: ApprovalLedgerRecord["disposition"];
  let refusalReason: string | undefined;
  let operation: HistoricalOperation | undefined;
  switch (durableState.kind) {
    case "never_attempted":
      disposition = input.entry.presentation === "hold" ? "hold"
        : input.entry.presentation === "replay_no_op" ? "replay"
        : !input.entry.approved ? "declined" : "refused";
      break;
    case "complete":
      executed = true;
      disposition = "executed";
      operation = durableState.operation;
      break;
    case "abandoned":
      disposition = "abandoned";
      operation = durableState.operation;
      break;
    case "withdrawn_dispositioned":
      disposition = "dispositioned";
      operation = durableState.operation;
      executed = (durableState.operation.event.completedActions?.length ?? 0) > 0;
      break;
    case "intent_unknown":
    case "unresolved_unknown":
    case "unresolved_partial":
      disposition = "refused";
      operation = durableState.operation;
      refusalReason = "Durable operation is unresolved; automatic redispatch is forbidden.";
      break;
    case "primary_unverified":
    case "classification_failed":
      disposition = "refused";
      operation = durableState.operation;
      refusalReason = "Primary effect is recorded; classification is unverified.";
      break;
    case "legacy_unverified":
      disposition = "refused";
      operation = durableState.operation;
      refusalReason = "Legacy execution is recorded; classification is unverified; explicit reconciliation is required.";
      break;
    case "conflict":
      disposition = "refused";
      refusalReason = `Conflicting durable history: ${durableState.conflicts.map((conflict) => conflict.reason).join(" ")}`;
      break;
    case "malformed":
      disposition = "refused";
      refusalReason = `Malformed or conflicting durable history: ${durableState.problems.map((problem) => problem.reason).join(" ")}`;
      break;
    case "multiple_actions":
      disposition = "refused";
      refusalReason = "Multiple historical actions require explicit reconciliation; identities are retained in historicalOperations.";
      break;
    default: { const exhaustive: never = durableState; return exhaustive; }
  }
  const actionTaken = executed ? operation!.action : null;
  return {
    schemaVersion: INTAKE_APPROVAL_LEDGER_SCHEMA,
    appliedAt: input.now.toISOString(),
    mode: input.mode,
    decisionContentSha256: input.entry.decisionReport.contentSha256,
    ...(input.existenceRevalidation === undefined ? {} : { existenceRevalidation: input.existenceRevalidation }),
    sourceFingerprint: input.entry.sourceFingerprint,
    candidateFingerprint: input.entry.sourceFingerprint,
    assessorSuggestedClassification: input.source.deniedClassification.map((classification) => ({
      fieldName: classification.fieldName, value: classification.value,
      confidence: classification.confidence, rationale: classification.rationale,
    })),
    operatorFinalClassification: operation?.classifications
      ?? (durableState.kind === "never_attempted" ? input.entry.deniedClassification.filter((classification) =>
        classification.fieldName !== "Horizon").map((classification) => ({
        fieldName: classification.fieldName, value: classification.value,
      })) : []),
    approved: input.entry.approved,
    executed,
    disposition,
    ...(durableState.kind === "abandoned" ? { abandonment: durableState.operation.event.abandonment } : {}),
    ...(durableState.kind === "complete" && durableState.operation.event.event === "legacy_verified"
      ? { legacyVerification: durableState.operation.event.legacyVerification } : {}),
    ...(refusalReason === undefined ? {} : { refusalReason }),
    hold: input.entry.hold,
    intendedAction: input.entry.intendedAction,
    intendedActions: input.entry.intendedActions,
    actionTaken,
    actionsTaken: durableState.kind === "withdrawn_dispositioned" ? durableState.operation.event.completedActions! : actionTaken === null ? [] : [actionTaken,
      ...(operation?.provenance === "staged" && operation.event.event !== "legacy_verified"
        && operation.event.payload.closeIssue !== null ? ["close_issue" as const] : [])],
    result: operation?.result ?? { issueNumber: null, issueId: null, commentId: null },
    durableState: durableState.kind,
    historicalOperations: durableState.operations,
    ...(durableState.kind === "malformed" ? { historyProblems: durableState.problems } : {}),
    ...(durableState.kind === "conflict" ? { historyConflicts: durableState.conflicts } : {}),
  };
}

type IntakeInvocationMode = "import" | "dry-run" | "execute";

interface IntakeApplyInput {
  readonly actionQualificationContext?: ActionQualificationContext;
  readonly heldClaim?: ExecutionClaim;
  readonly planPath: string;
  readonly planContent?: string;
  readonly execute?: boolean;
  readonly immediate?: boolean;
  readonly allowCreateBudgetOverrun?: boolean;
  readonly ledgerPath?: string;
  readonly importLedgerPaths?: readonly string[];
  readonly transport?: OperatorIntakeApprovalTransport;
  readonly openTransport?: () => OperatorIntakeApprovalTransport;
  readonly trustedCurrentOriginMainSha?: string;
  readonly candidatePaths?: readonly string[];
  readonly existencePaths?: readonly string[];
  readonly runEvidencePath?: string;
  readonly repoRoot?: string;
  readonly runGit?: GitRunner;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly now?: Date;
}

function resolveInvocationMode(input: IntakeApplyInput): IntakeInvocationMode {
  const importing = (input.importLedgerPaths?.length ?? 0) > 0;
  if (input.execute === true && importing) throw new Error("--execute cannot be combined with --import-ledger.");
  const mode = importing ? "import" : input.execute === true ? "execute" : "dry-run";
  if (input.allowCreateBudgetOverrun && (mode !== "execute" || input.immediate)) {
    throw new Error("--allow-create-budget-overrun requires a supervised operator --execute invocation; immediate filing cannot override the budget.");
  }
  if (mode === "execute" && input.ledgerPath !== undefined) {
    // Read only enough source metadata to give the existing actionable refusal,
    // before SHA, credentials, Git, transport or journal access.
    const planPath = resolve(input.planPath);
    const plan = parsePlan(input.planContent ?? readFileSync(planPath, "utf8"));
    const report = object(JSON.parse(readFileSync(resolve(plan.decision.path), "utf8")), "decision report");
    const repository = object(report.repository, "decision report repository");
    const journalPath = resolveJournalPath(repositoryFromDraft({ repository: `${repository.organization}/${repository.name}` }));
    throw new Error(`--ledger is not supported in execute mode. Journal: ${journalPath}. Import with: npx tsx scripts/github-issue-roadmap-intake-apply.ts --plan="${planPath}" --import-ledger="${resolve(input.ledgerPath)}"`);
  }
  return mode;
}

export async function applyIntakeApprovalPlan(input: IntakeApplyInput): Promise<IntakeApplyResult> {
  return applyIntakeApprovalPlanInMode(input, resolveInvocationMode(input));
}

async function applyIntakeApprovalPlanInMode(
  input: IntakeApplyInput, mode: IntakeInvocationMode, checkToken?: () => void,
): Promise<IntakeApplyResult> {
  const planPath = resolve(input.planPath);
  const plan = parsePlan(input.planContent ?? readFileSync(planPath, "utf8"));
  const bindings = plan.decisions ?? [plan.decision];
  const execute = mode === "execute";
  const trustedCurrentOriginMainSha = input.trustedCurrentOriginMainSha;
  if (execute && (typeof trustedCurrentOriginMainSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(trustedCurrentOriginMainSha))) {
    throw new Error("Execution requires the trusted current origin/main Git SHA.");
  }
  if (execute && !input.runEvidencePath) {
    throw new Error("Execution requires --run-evidence=<path> produced by the drain run that generated this plan.");
  }
  const sources = bindings.map((binding) => {
    if (typeof binding.existenceRecordContentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(binding.existenceRecordContentSha256) ||
        typeof binding.verifiedOriginMainSha !== "string" ||
        !/^[0-9a-f]{40}$/.test(binding.verifiedOriginMainSha)) {
      throw new Error("Approval plan decision binding lacks the required existence binding.");
    }
    const content = readFileSync(resolve(binding.path), "utf8");
    if (sha256Content(content) !== binding.contentSha256) {
      throw new Error(`Approval plan is stale: bound decision report content hash changed: ${binding.path}`);
    }
    const report = object(JSON.parse(content) as unknown, "decision report");
    const decision = object(report.decision, "decision report decision");
    if (decision.existenceRecordContentSha256 !== binding.existenceRecordContentSha256 ||
        decision.verifiedOriginMainSha !== binding.verifiedOriginMainSha) {
      throw new Error("Approval plan existence binding differs from its decision report.");
    }
    return { binding, content, report, decision };
  });
  const expectedEntries = sources.flatMap(({ binding, content }) => buildIntakeApprovalPlan({
    decisionPath: binding.path, decisionContent: content, now: new Date(plan.generatedAt),
  }).entries);
  const expected = { entries: expectedEntries };
  if (plan.entries.length !== expected.entries.length) throw new Error("Approval plan changed the source candidate set.");
  const entryKey = (entry: IntakeApprovalEntry) => `${entry.decisionReport.path}\0${entry.sourceFingerprint}`;
  const expectedByFingerprint = new Map(expected.entries.map((entry) => [entryKey(entry), entry]));
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) throw new Error(`Approval plan duplicates ${entry.sourceFingerprint}.`);
    seen.add(key);
    const source = expectedByFingerprint.get(key);
    if (source === undefined) throw new Error(`Approval plan contains unknown candidate ${entry.sourceFingerprint}.`);
    assertEntryMatchesSource(entry, source);
    if (entry.approved && (!entry.approvable || entry.presentation === "hold" || entry.presentation === "replay_no_op")) {
      throw new Error(`Approved ${entry.presentation} ${entry.sourceFingerprint} is non-approvable.`);
    }
  }

  const approvedWriteReports = new Map<string, string>();
  for (const entry of plan.entries) {
    if (!entry.approved || (entry.intendedAction !== "create_issue" && entry.intendedAction !== "append_evidence" && entry.intendedAction !== "append_evidence_overlap")) continue;
    const priorReport = approvedWriteReports.get(entry.sourceFingerprint);
    if (priorReport !== undefined && priorReport !== entry.decisionReport.path) {
      throw new Error(
        `Approved write ${entry.sourceFingerprint} appears in multiple decision reports: ${priorReport} and ${entry.decisionReport.path}.`,
      );
    }
    approvedWriteReports.set(entry.sourceFingerprint, entry.decisionReport.path);
  }

  const repositories = sources.map(({ report }) => {
    const repository = object(report.repository, "decision report repository");
    return repositoryFromDraft({ repository: `${repository.organization}/${repository.name}` });
  });
  if (new Set(repositories.map(foldRepository)).size !== 1) throw new Error("Approval plan spans repositories; one repository journal is required.");
  const repository = repositories[0];
  // Retain the verified census for plan-scoped reconciliation. No claim, Git invocation
  // or transport precedes this evidence gate.
  const replayEmissions = new Map<string, string>();
  let boundEvidence: Extract<ReturnType<typeof verifyRunEvidence>, { ok: true }> | undefined;
  let runEvidence: IntakeApplyResult["runEvidence"];
  if (mode !== "import" && input.runEvidencePath !== undefined) {
    const evidencePath = resolve(input.runEvidencePath);
    let evidenceBytes: Buffer;
    try { evidenceBytes = readFileSync(evidencePath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(`run_evidence_unreadable: ${basename(evidencePath)} (${code})`);
    }
    const realpath = realpathSync.native ?? realpathSync;
    const runRoot = realpath(dirname(evidencePath));
    // IntakeApprovalPlan has no runId; its content hash pins the plan, but there
    // is no independently declared plan run identity to pass as a runId pin.
    const evidenceFiles = new Map<string, Buffer>();
    const verified = verifyRunEvidence({ evidenceBytes, plan, repository,
      files: (name) => {
        const path = realpath(join(runRoot, name));
        const local = relative(runRoot, path);
        if (local === "" || isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) {
          throw new RunEvidencePathEscapeError(name);
        }
        const bytes = readFileSync(path);
        evidenceFiles.set(name.toLowerCase(), bytes);
        return bytes;
      } });
    if (!verified.ok) throw new Error(`${verified.reason}: ${verified.detail}`);
    boundEvidence = verified;
    for (const decision of verified.evidence.decisions) {
      const envelope = parseOutcomeEnvelope(JSON.parse(evidenceFiles.get(decision.candidatePath.toLowerCase())!.toString("utf8")));
      for (const entry of plan.entries.filter(entry => entry.decisionReport.contentSha256 === decision.decisionContentSha256)) {
        const candidate = envelope.candidates.find(candidate => candidate.sourceFingerprint === entry.sourceFingerprint);
        if (candidate !== undefined) replayEmissions.set(entryKey(entry), candidate.emissionContentSha256);
      }
    }
    const census = boundEvidence.evidence.census;
    runEvidence = { path: basename(evidencePath), artifactSha256: boundEvidence.artifactSha256,
      runId: boundEvidence.evidence.runId, census: {
        basename: census.path, artifactSha256: census.artifactSha256, contentSha256: census.contentSha256,
        coverageSha256: census.coverageSha256, startedAt: census.startedAt, bookendCompletedAt: census.bookendCompletedAt,
      } };
  }
  // The CLI credential gate follows evidence content verification and precedes
  // every claim, Git invocation and transport. API callers have no CLI token gate.
  checkToken?.();
  const journalPath = resolveJournalPath(repository);
  const identities = new Map<string, HistoryIdentity>();
  for (const entry of plan.entries) {
    const bound = sources.find(({ binding }) => binding.path === entry.decisionReport.path)!;
    const candidate = sourceCandidate(bound.report, entry.sourceFingerprint);
    if (candidate.draft != null && foldRepository(repositoryFromDraft(object(candidate.draft, "decision draft"))) !== foldRepository(repository)) {
      throw new Error(`Decision draft repository differs from its report for ${entry.sourceFingerprint}.`);
    }
    // Both append policies share emission-bound recovery and replay identity.
    identities.set(entryKey(entry), { repository, sourceFingerprint: entry.sourceFingerprint,
      action: entry.intendedAction === "append_evidence_overlap" ? "append_evidence" : entry.intendedAction,
      ...(entry.intendedAction === "append_evidence" || entry.intendedAction === "append_evidence_overlap"
        ? { emissionContentSha256: emissionFromMarker(entry.evidenceComment!) }
        : entry.presentation === "replay_no_op" && entry.replay !== null ? { emissionContentSha256: replayEmissions.get(entryKey(entry)) } : {}) });
  }
  const claim = input.heldClaim ?? (mode === "dry-run" ? undefined : acquireExecutionClaim(journalPath, { mode, planPath }));
  const ownership = claim?.ownership;
  let runFailure: { error: unknown } | undefined;
  try {
    input.heldClaim?.withOwnership(() => {});
    const appendRecord = (record: unknown) => claim!.withOwnership(() => appendJournal(journalPath, record));
    if (mode === "import") {
      const importedLedgers = importLegacyLedgers(journalPath, input.importLedgerPaths!, appendRecord);
      const journal = readJournal(journalPath);
      return { mode: "dry-run", ownership, journalPath, journalTail: { present: journal.tail !== null },
        executionSummary: summarizeApplyExecution(indexHistory(journal.records, journal.tail), input.now ?? new Date(), repository, []),
        importedLedgers, writes: [], ledgerRecords: [], reconciliations: [], failures: [] };
    }
    const journal = readJournal(journalPath);
    const journalTail = { present: journal.tail !== null };
    // The legacy flag remains a read-only preview override; execute has no path selector.
    const history = !execute && input.ledgerPath !== undefined
      ? indexHistory(readLedger(resolve(input.ledgerPath))) : indexHistory(journal.records, journal.tail);
    // One derivation per exclusive claim. Keep this window's charges throughout
    // the invocation (conservative if they age out during I/O); our fsynced intents
    // add reservations in memory. A new claim reads and derives afresh.
    const claimBudget = execute
      ? claim!.withOwnership(() => deriveRepositoryCreateBudget(history, repository, input.now ?? new Date())) : undefined;
    const stateFor = (entry: IntakeApprovalEntry) => (entry.presentation === "replay_no_op" && entry.replay !== null ? resolveSubmittedReplayState : resolveDurableState)(
      history, identities.get(entryKey(entry))!);
    // Resolve all entry history before invocation preflight selection. The index is
    // advanced only after durable transition writes, never from current plan data.
    const initialStates = new Map(plan.entries.map((entry) => [entryKey(entry), stateFor(entry)]));

    const revalidations = new Map<string, ExistenceRevalidation>();
    const dispositionRefusals = new Map<string, string>();
    const boundOutcomeIds = new Map<string, string>();
    if (execute) {
      const sha = trustedCurrentOriginMainSha!;
      const repoRoot = input.repoRoot ?? process.cwd();
      const runGit = input.runGit ?? runCredentialCleanGit;
      let resolvedSha: string;
      try {
        resolvedSha = runGit(repoRoot, ["rev-parse", "--verify", `${sha}^{commit}`]).trim();
      } catch {
        throw new Error(`Trusted current origin/main SHA is not a local commit: ${sha}.`);
      }
      if (resolvedSha !== sha) throw new Error(`Trusted current origin/main SHA is not a local commit: ${sha}.`);
      const candidates = (input.candidatePaths ?? []).map((path) => {
        const envelope = parseOutcomeEnvelope(JSON.parse(readFileSync(resolve(path), "utf8")));
        if (envelope.candidates.some(candidate => candidate.disposition !== undefined
          && plan.entries.some(entry => entry.sourceFingerprint === candidate.sourceFingerprint))) {
          throw new Error("dispositioned: approval plan binds a dispositioned candidate.");
        }
        return { path, hash: canonicalJsonSha256(envelope), envelope };
      });
      const records = (input.existencePaths ?? []).map((path) => ({
        path, record: parseExistenceRecord(JSON.parse(readFileSync(resolve(path), "utf8"))),
      }));
      const matched = sources.map((source) => {
        const candidate = candidates.find((item) => item.hash === source.decision.candidateSha256);
        if (candidate === undefined) {
          throw new Error(candidates.length === 0
            ? `No --candidate supplied for decision report ${source.binding.path}.`
            : `Supplied --candidate does not match candidateSha256 for decision report ${source.binding.path}.`);
        }
        const existence = records.find((item) => item.record.contentSha256 === source.binding.existenceRecordContentSha256);
        if (existence === undefined) {
          throw new Error(records.length === 0
            ? `No --existence supplied for decision report ${source.binding.path}.`
            : `Supplied --existence does not match existenceRecordContentSha256 for decision report ${source.binding.path}.`);
        }
        if (existence.record.originMainSha !== source.binding.verifiedOriginMainSha) {
          throw new Error(`Bound existence record SHA differs from decision report ${source.binding.path}.`);
        }
        return { ...source, candidate, existence };
      });
      for (const { candidate } of matched) {
        for (const outcome of candidate.envelope.candidates) boundOutcomeIds.set(outcome.sourceFingerprint, outcome.stableOutcomeId);
      }
      for (const candidate of candidates) {
        if (!sources.some((source) => source.decision.candidateSha256 === candidate.hash)) {
          throw new Error(`Supplied --candidate matches no decision report: ${candidate.path}.`);
        }
      }
      for (const existence of records) {
        if (!sources.some((source) => source.binding.existenceRecordContentSha256 === existence.record.contentSha256)) {
          throw new Error(`Supplied --existence matches no decision report: ${existence.path}.`);
        }
      }
      const freshByInput = new Map<string, {
        record: ReturnType<typeof probeExistenceAtSha>;
        activeFingerprints: ReadonlySet<string>;
      }>();
      for (const { binding, candidate, existence } of matched) {
        const probeKey = `${candidate.hash}\0${sha}`;
        let fresh = freshByInput.get(probeKey);
        if (fresh === undefined) {
          const history = (input.dispositionHistory ?? dispositionHistory)(sha, { repoRoot, runGit });
          fresh = {
            record: probeExistenceAtSha({
              envelope: candidate.envelope, originMainSha: sha, repoRoot, runGit, dispositionHistory: () => history,
              budget: Number.MAX_SAFE_INTEGER, generatedAt: (input.now ?? new Date()).toISOString(),
            }),
            activeFingerprints: new Set(effectiveOutcomeCandidates(candidate.envelope, history).active
              .map(({ sourceFingerprint }) => sourceFingerprint)),
          };
          freshByInput.set(probeKey, fresh);
        }
        for (const entry of fresh.record.entries) {
          if ("runOutcome" in entry) {
            throw new Error(`Existence revalidation refused ${entry.sourceFingerprint}: fresh ${entry.runOutcome.kind}.`);
          }
        }
        // Refuse fresh entries before preparing any write or intent, including local-main drift.
        for (const entry of plan.entries) {
          if (entry.decisionReport.path === binding.path && entry.decisionReport.contentSha256 === binding.contentSha256) {
            // Historical projections may outlive their current envelope member.
            // Recovery guards those operations from the journal before any transport.
            if (!boundOutcomeIds.has(entry.sourceFingerprint) && initialStates.get(entryKey(entry))!.kind !== "never_attempted") continue;
            try {
              assertNoDispositionBeforeWrite({ sourceFingerprint: entry.sourceFingerprint, issue: null, evidenceComment: null },
              { ...input, stableOutcomeId: boundOutcomeIds.get(entry.sourceFingerprint) });
            } catch (error) {
              if (error instanceof UnboundOutcomeIdentity) {
                dispositionRefusals.set(entryKey(entry), error.message);
                continue;
              }
              if (!(error instanceof DispositionedWrite)) throw error;
              dispositionRefusals.set(entryKey(entry), !fresh.activeFingerprints.has(entry.sourceFingerprint)
                ? `dispositioned: approval entry is terminal at trusted main SHA ${sha}.`
                : "dispositioned: approval entry is terminal at local origin/main.");
            }
          }
        }
        // Compare existence verdicts only for entries that remain active at the trusted SHA.
        const boundProjection = existenceVerdictProjection({ ...existence.record,
          entries: existence.record.entries.filter(({ sourceFingerprint }) => fresh.activeFingerprints.has(sourceFingerprint)),
        });
        const freshProjection = existenceVerdictProjection(fresh.record);
        if (boundProjection !== freshProjection) {
          const boundEntries = JSON.parse(boundProjection) as JsonObject[];
          const freshEntries = JSON.parse(freshProjection) as JsonObject[];
          const fingerprints = [...new Set([...boundEntries, ...freshEntries].map((entry) => String(entry.sourceFingerprint)))].sort();
          const fingerprint = fingerprints.find((key) => same(boundEntries.find((entry) => entry.sourceFingerprint === key)) !==
            same(freshEntries.find((entry) => entry.sourceFingerprint === key)))!;
          const state = (entries: JsonObject[]) => {
            const entry = entries.find((item) => item.sourceFingerprint === fingerprint);
            return entry?.state ?? entry?.runOutcome ?? "missing";
          };
          throw new Error(`Existence verdict changed for ${fingerprint}: bound ${state(boundEntries)}, fresh ${state(freshEntries)}.`);
        }
        revalidations.set(binding.path, {
          boundOriginMainSha: existence.record.originMainSha, trustedOriginMainSha: sha, verdictEqualityVerified: true,
        });
      }
    }

    const writes: IntakeApplyResult["writes"][number][] = [];
    const approvedWrites = new Map<string, IntakeApplyResult["writes"][number]>();
    for (const entry of plan.entries) {
      if (!entry.approved || dispositionRefusals.has(entryKey(entry))) continue;
      for (const kind of entry.intendedActions) {
        if ((kind === "append_evidence_overlap" || kind === "close_issue_existence" || kind === "close_issue") && !isActionKindExecutable(kind, input.actionQualificationContext ?? {})) {
          throw new Error(`Capability ${kind} is disabled or unqualified.`);
        }
      }
      const bound = sources.find(({ binding }) => binding.path === entry.decisionReport.path && binding.contentSha256 === entry.decisionReport.contentSha256);
      if (bound === undefined) throw new Error(`Approval entry ${entry.sourceFingerprint} has an unknown decision report binding.`);
      const candidate = sourceCandidate(bound.report, entry.sourceFingerprint);
      const draft = object(candidate.draft, `draft for ${entry.sourceFingerprint}`);
      const marker = typeof draft.marker === "string" ? draft.marker : "";
      if (entry.intendedAction === "create_issue") {
        const issue = object(draft.issue, `issue draft for ${entry.sourceFingerprint}`);
        if (typeof issue.title !== "string" || typeof issue.body !== "string") throw new Error("Create draft is incomplete.");
        assertExactMarker(issue.body, marker, entry.sourceFingerprint);
        writes.push({
          sourceFingerprint: entry.sourceFingerprint, repository, action: entry.intendedAction,
          actions: entry.intendedActions,
          canonicalIssueNumber: null, issue: { title: issue.title, body: issue.body }, evidenceComment: null,
          closeIssue: null,
          classifications: applicableClassifications(entry.deniedClassification),
          suggestedHorizon: suggestedHorizon(bound.report, entry.sourceFingerprint),
        });
        approvedWrites.set(entryKey(entry), writes[writes.length - 1]);
        continue;
      }
      if ((entry.intendedAction === "append_evidence" || entry.intendedAction === "append_evidence_overlap") && entry.canonicalIssueNumber !== null) {
        if (typeof draft.evidenceComment !== "string") throw new Error("Evidence-comment draft is incomplete.");
        assertExactMarker(draft.evidenceComment, marker, entry.sourceFingerprint);
        writes.push({
          sourceFingerprint: entry.sourceFingerprint, repository, action: "append_evidence",
          actions: entry.intendedActions,
          canonicalIssueNumber: entry.canonicalIssueNumber, issue: null, evidenceComment: draft.evidenceComment,
          emissionContentSha256: emissionFromMarker(draft.evidenceComment),
          closeIssue: entry.closeIssue,
          classifications: applicableClassifications(entry.deniedClassification),
          suggestedHorizon: suggestedHorizon(bound.report, entry.sourceFingerprint),
        });
        approvedWrites.set(entryKey(entry), writes[writes.length - 1]);
        continue;
      }
      throw new Error(`Approved candidate ${entry.sourceFingerprint} has no valid intended action.`);
    }

    if (execute && input.transport === undefined && input.openTransport === undefined) {
      throw new Error(
        "Execution has no compatible operator issue transport: createOperatorPublisherTransport permits only shadow Git/PR commands.",
      );
    }
    const ledgerRecords: ApprovalLedgerRecord[] = [];
    const reconciliations: IntakeApplyResult["reconciliations"][number][] = [];
    const failures: IntakeApplyResult["failures"][number][] = [];
    const breaker = new IntakeExecutionBreaker();
    const appliedAt = input.now ?? new Date();
    let credentialedTransport = input.transport;
    const fence = () => claim!.withOwnership(() => {});
    const transport = (): FencedIntakeApprovalTransport => {
      credentialedTransport ??= input.openTransport?.();
      if (credentialedTransport === undefined) throw new Error("Execution has no compatible operator issue transport.");
      return credentialedTransport;
    };
    // This guard is shared by primary writes, append-then-close, classification,
    // and recovery. Check both the run pin and the freshly resolved local ref.
    const beforeWrite = (write: IntakeApplyResult["writes"][number]) => assertNoDispositionBeforeWrite(write,
      { ...input, stableOutcomeId: boundOutcomeIds.get(write.sourceFingerprint) });
    const transitionedEntries = new Set<string>();
    const recordTransition = (event: ApprovalExecutionEvent, entry?: IntakeApprovalEntry) => {
      appendRecord(event);
      addHistoryRow(history, event);
      // Fresh dispatch belongs to one entry; recovery transitions every entry selecting that historical action.
      const entries = entry === undefined ? plan.entries.filter((candidate) =>
        candidate.sourceFingerprint === event.sourceFingerprint
        && (candidate.intendedAction === null || candidate.intendedAction === event.action)) : [entry];
      for (const transitioned of entries) transitionedEntries.add(entryKey(transitioned));
    };
    const recordFailure = (failure: IntakeApplyResult["failures"][number], error: unknown) => {
      failures.push(failure);
      breaker.recordFailure(failure, error);
    };
    // Select history only for identities named by this plan, regardless of approval.
    // Null-action replay entries select every historical action for their fingerprint.
    const selectedOperations = new Map<string, StagedOperation>();
    for (const entry of plan.entries) {
      const identity = identities.get(entryKey(entry))!;
      if (entry.presentation === "replay_no_op" && entry.replay !== null) {
        const state = stateFor(entry);
        if ("operation" in state && state.operation.provenance === "staged"
          && state.operation.action === state.scope.action
          && "emissionContentSha256" in state.operation.event
          && state.operation.event.emissionContentSha256 === identity.emissionContentSha256) {
          selectedOperations.set(operationKey(state.operation.event), state.operation);
        }
        continue;
      }
      const operations = history.stagedByEntry.get(`${foldRepository(identity.repository)}\0${identity.sourceFingerprint}`);
      for (const operation of operations?.values() ?? []) {
        if (identity.action === null || operation.event.action === identity.action
          && (identity.action !== "append_evidence" || operation.event.action === "append_evidence"
            && operation.event.emissionContentSha256 === identity.emissionContentSha256)) {
          selectedOperations.set(operationKey(operation.event), operation);
        }
      }
    }
    // Recovery consumes only validated historical contracts, including classifications.
    const historicalStates = [...selectedOperations.values()].map((operation) => resolveDurableState(history, operation.event))
      .filter((state) => {
        if (!execute || claimBudget!.problem !== undefined || !["intent_unknown", "primary_unverified", "classification_failed",
          "unresolved_unknown", "unresolved_partial"].includes(state.kind) || !("operation" in state)
          || state.operation.provenance !== "staged" || state.operation.event.event === "legacy_verified"
          || state.operation.event.event === "abandoned") return true;
        const event = state.operation.event;
        try { beforeWrite(eventWrite(event)); return true; }
        catch (error) {
          if (error instanceof UnboundOutcomeIdentity) {
            for (const entry of plan.entries.filter(entry => entry.sourceFingerprint === event.sourceFingerprint)) {
              dispositionRefusals.set(entryKey(entry), error.message);
            }
            return false;
          }
          if (!(error instanceof DispositionedWrite)) throw error;
          if (state.kind === "intent_unknown" || state.kind === "primary_unverified" || state.kind === "classification_failed") {
            recordTransition({ ...executionEvent({ event: "withdrawn_dispositioned", now: appliedAt, write: eventWrite(event),
              decisionContentSha256: event.decisionContentSha256, ...state.operation.result }),
              completedActions: state.kind === "intent_unknown" ? [] : [event.action,
                ...(event.payload.closeIssue === null ? [] : ["close_issue" as const])] });
          }
          for (const entry of plan.entries.filter(entry => entry.sourceFingerprint === event.sourceFingerprint)) {
            if (!dispositionRefusals.has(entryKey(entry))) {
              dispositionRefusals.set(entryKey(entry), "dispositioned: historical operation is terminal at trusted or local main.");
            }
          }
          return false;
        }
      });
    const eligibleCreates = historicalStates.filter((state): state is UnresolvedCreateState =>
      (state.kind === "intent_unknown" || state.kind === "unresolved_unknown" || state.kind === "unresolved_partial")
      && state.operation.event.action === "create_issue");
    const refusedCreates = new Set<string>();
    const reportRefusal = (state: UnresolvedCreateState, refusal: OwnershipRefusal) => {
      refusedCreates.add(operationKey(state.operation.event));
      reconciliations.push({ sourceFingerprint: state.scope.sourceFingerprint, action: "create_issue", outcome: "refused",
        reason: refusal.reason, detail: refusal.detail });
    };
    // Prove every eligible operation without HTTP, including during dry-run. Neither a
    // missing census nor negative evidence can authorize a second create dispatch.
    const provenCreates = eligibleCreates.flatMap((state) => {
      if (boundEvidence === undefined) {
        reconciliations.push({ sourceFingerprint: state.scope.sourceFingerprint, action: "create_issue",
          outcome: "no_run_evidence", detail: "No run evidence census was supplied for reconciliation." });
        return [];
      }
      const census = boundEvidence.evidence.census;
      const reconciliationInput = { identity: state.scope, priorState: state, census: boundEvidence.census,
        censusBinding: { artifactPath: census.path, artifactSha256: census.artifactSha256,
          contentSha256: census.contentSha256, coverageSha256: census.coverageSha256 } };
      const proof = proveUnresolvedCreate(reconciliationInput);
      if (proof.kind === "refusal") { reportRefusal(state, proof); return []; }
      if (!execute) reconciliations.push({ sourceFingerprint: state.scope.sourceFingerprint,
        action: "create_issue", outcome: "would_confirm", issueNumber: proof.issueNumber });
      return [{ ...reconciliationInput, proof }];
    });
    if (!execute) {
      for (const entry of plan.entries) {
        const source = expectedByFingerprint.get(entryKey(entry))!;
        const record = projectResult(initialStates.get(entryKey(entry))!, { entry, source, now: appliedAt, mode: "dry-run" });
        ledgerRecords.push(record);
      }
      return { mode: "dry-run", journalPath, journalTail, writes, ledgerRecords, reconciliations, failures, runEvidence,
        executionSummary: summarizeApplyExecution(indexHistory(journal.records, journal.tail), appliedAt, repository, reconciliations) };
    }
    // An unreadable journal refuses the whole execution before any transport,
    // including recovery GETs, classification preflight and observation appends.
    if (claimBudget!.problem !== undefined) {
      const refusal = createQuotaRefusal(claimBudget!, false, 0, false)!;
      for (const entry of plan.entries) {
        const source = expectedByFingerprint.get(entryKey(entry))!;
        const state = initialStates.get(entryKey(entry))!;
        const record = projectResult(state, {
          entry, source, now: appliedAt, mode: "execute",
          existenceRevalidation: revalidations.get(entry.decisionReport.path),
        });
        // A terminal projection is still historical truth, and needs no action.
        if (state.kind === "complete" || state.kind === "abandoned") {
          ledgerRecords.push(record);
          continue;
        }
        ledgerRecords.push({ ...record, executed: false, disposition: "refused", refusalReason: refusal });
        failures.push({ sourceFingerprint: entry.sourceFingerprint, action: entry.intendedAction,
          stage: "projection", issueNumber: null, error: refusal });
      }
      return { mode: "execute", ownership, journalPath, journalTail, writes, ledgerRecords, reconciliations, failures, runEvidence,
        executionSummary: summarizeApplyExecution(history, appliedAt, repository, reconciliations) };
    }
    // Admission preview excludes refused fresh creates from preflight too. It
    // reserves nothing: admission is rechecked under ownership and the durable
    // intent is fsynced at the actual dispatch boundary.
    const quotaRefusals = new Map<string, string>();
    const budgetNow = () => input.now ?? new Date();
    const previewBudget = claimBudget!;
    let plannedCreates = 0;
    for (const write of writes) {
      if (write.action !== "create_issue" || resolveDurableState(history, write).kind !== "never_attempted") continue;
      const refusal = createQuotaRefusal({ ...previewBudget, count: previewBudget.count + plannedCreates },
        input.immediate === true, plannedCreates, input.allowCreateBudgetOverrun === true);
      if (refusal !== undefined) quotaRefusals.set(operationKey(write), refusal);
      else plannedCreates += 1;
    }
    let invocationCreates = 0;
    const confirmedCreates: { readonly input: typeof provenCreates[number]; readonly confirmed: LiveConfirmation }[] = [];
    // GETs under the claim precede the one combined preflight, and all journal writes.
    for (const candidate of provenCreates) {
      try {
        const confirmed = await confirmCreateReconciliation({ ...candidate, transport: transport(), claim: claim! });
        if (confirmed.kind === "refusal") reportRefusal(candidate.priorState, confirmed);
        else confirmedCreates.push({ input: candidate, confirmed });
      } catch (error) {
        if (error instanceof JournalWriteError || error instanceof ExecutionOwnershipError) throw error;
        recordFailure({ sourceFingerprint: candidate.identity.sourceFingerprint, action: "create_issue", stage: "recovery",
          issueNumber: candidate.proof.issueNumber, error: error instanceof Error ? error.message : String(error) }, error);
        if (breaker.aborted !== undefined) break;
      }
    }
    const recoverableEvents = historicalStates.flatMap((state) => {
      switch (state.kind) {
        case "primary_unverified":
        case "classification_failed": return [state.operation.event];
        case "never_attempted": case "intent_unknown": case "complete": case "abandoned": case "withdrawn_dispositioned": case "unresolved_unknown":
        case "unresolved_partial": case "legacy_unverified": case "conflict": case "malformed": case "multiple_actions": return [];
        default: { const exhaustive: never = state; return exhaustive; }
      }
    });
    const preflightWrites = [
      ...writes.filter((write) => resolveDurableState(history, write).kind === "never_attempted" && !quotaRefusals.has(operationKey(write))),
      ...recoverableEvents.map(eventWrite),
      ...confirmedCreates.map(({ input }) => eventWrite(input.priorState.operation.event)),
    ];
    if (breaker.aborted === undefined && preflightWrites.length > 0) {
      if (preflightWrites.some(write => write.actions.includes("close_issue_existence")) && transport().supportsCloseIssue !== true) {
        throw new Error("close_unsupported: transport cannot complete append-then-close before any write.");
      }
      await transport().preflightClassifications(preflightWrites.map((write) => ({
        sourceFingerprint: write.sourceFingerprint,
        repository: write.repository,
        classifications: write.classifications,
      })));
    }

    for (const state of historicalStates) {
      if (breaker.aborted !== undefined) break;
      if (state.kind !== "intent_unknown") continue;
      // A proven create goes straight to reconciled. Only refusals retain the old
      // intent reduction; GET faults leave that unresolved intent untouched.
      if (state.operation.event.action === "create_issue" && !refusedCreates.has(operationKey(state.operation.event))) continue;
      const event = state.operation.event;
      recordTransition(executionEvent({
        event: "create_unresolved", now: appliedAt, write: eventWrite(event),
        decisionContentSha256: event.decisionContentSha256, ...state.operation.result,
        error: "A durable intent has no confirmed outcome; automatic redispatch is forbidden.",
      }));
    }

    const confirmForApply = async (
      write: IntakeApplyResult["writes"][number],
      decisionContentSha256: string,
      issueNumber: number,
      issueId: string | number | null,
      commentId: string | number | null,
      apply: boolean,
      stage: "recovery" | "classification",
      emissionContentSha256?: string,
      entry?: IntakeApprovalEntry,
    ): Promise<ApprovalExecutionEvent> => {
      return confirmClassification({ transport, claim: claim!, fence, write, apply,
        beforeWrite: () => beforeWrite(write),
        identities: { issueNumber, issueId, commentId }, now: appliedAt, decisionContentSha256, emissionContentSha256,
        recordTransition: (event) => recordTransition(event, entry),
        onComplete: () => breaker.recordComplete(stage),
        onFailure: (failed, error) => recordFailure({ sourceFingerprint: write.sourceFingerprint, action: write.action, stage,
          issueNumber: failed.issueNumber, error: failed.error! }, error),
      });
    };

    // Preflight has succeeded for every contract. Each shared-core call fsyncs
    // reconciled before its classification writes and read-back; no create is retried.
    for (const candidate of confirmedCreates) {
      if (breaker.aborted !== undefined) break;
      const outcome = await reconcileCreate({ ...candidate.input, confirmed: candidate.confirmed,
        transport: transport(), claim: claim!, fence, recordTransition, readCurrentJournal: () => readJournal(journalPath),
        beforeWrite: () => beforeWrite(eventWrite(candidate.input.priorState.operation.event)),
        now: appliedAt, runId: boundEvidence!.evidence.runId, operator: userInfo().username,
        onComplete: () => breaker.recordComplete("recovery"),
        onFailure: (failed, error) => recordFailure({ sourceFingerprint: failed.sourceFingerprint, action: failed.action,
          stage: "recovery", issueNumber: failed.issueNumber, error: failed.error! }, error),
      });
      reconciliations.push({ sourceFingerprint: candidate.input.identity.sourceFingerprint, action: "create_issue", outcome: outcome.kind,
        ...(outcome.kind === "refused" ? { reason: outcome.reason, detail: outcome.detail }
          : outcome.terminal.issueNumber === null ? {} : { issueNumber: outcome.terminal.issueNumber }) });
    }

    // Recover staged operations before considering the current plan's replay projection.
    for (const event of recoverableEvents) {
      if (breaker.aborted !== undefined) break;
      // Resolution validated this identity before selecting it for recovery.
      await confirmForApply(
        eventWrite(event), event.decisionContentSha256, event.issueNumber!, event.issueId, event.commentId, true,
        "recovery", event.emissionContentSha256,
      );
      if (breaker.aborted !== undefined) break;
    }

    for (const planEntry of plan.entries) {
      const source = expectedByFingerprint.get(entryKey(planEntry))!;
      const identity = identities.get(entryKey(planEntry));
      const durableState = identity === undefined ? resolveDurableState(history, {
        repository, sourceFingerprint: planEntry.sourceFingerprint,
        action: planEntry.intendedAction === "append_evidence_overlap" ? "append_evidence" : planEntry.intendedAction,
      }) : stateFor(planEntry);
      if (dispositionRefusals.has(entryKey(planEntry))
        && durableState.kind !== "complete" && durableState.kind !== "abandoned" && durableState.kind !== "withdrawn_dispositioned") {
        const refusal = dispositionRefusals.get(entryKey(planEntry))!;
        ledgerRecords.push({ ...projectResult(durableState, {
          entry: planEntry, source, now: appliedAt, mode: "execute",
        }), executed: false, disposition: "refused", refusalReason: refusal });
        failures.push({ sourceFingerprint: planEntry.sourceFingerprint, action: planEntry.intendedAction,
          stage: "projection", issueNumber: null, error: refusal });
        continue;
      }
      if (identity === undefined || breaker.aborted !== undefined || durableState.kind !== "never_attempted" || !planEntry.approved) {
        const record = projectResult(durableState, {
          entry: planEntry, source, now: appliedAt, mode: "execute",
          existenceRevalidation: revalidations.get(planEntry.decisionReport.path),
        });
        if (identity === undefined) {
          failures.push({ sourceFingerprint: planEntry.sourceFingerprint, action: planEntry.intendedAction,
            stage: "projection", issueNumber: record.result.issueNumber,
            error: `Missing history identity for approval entry ${entryKey(planEntry)}.` });
          ledgerRecords.push(record);
          continue;
        }
        // Staged history already persists the authoritative truth. Observation rows
        // remain for non-staged entries without asserting historical execution.
        if (breaker.aborted === undefined && journal.tail === null && (durableState.kind === "never_attempted" || durableState.kind === "legacy_unverified")) {
          appendRecord(record);
        }
        ledgerRecords.push(breaker.aborted !== undefined
          && !transitionedEntries.has(entryKey(planEntry))
          ? { ...record, skippedDueToAbort: true } : record);
        continue;
      }
      const write = approvedWrites.get(entryKey(planEntry));
      if (write === undefined) throw new Error(`Approved candidate ${planEntry.sourceFingerprint} has no prepared write.`);

      // Check and reserve synchronously under the existing exclusive claim/fence.
      // Death before append leaves no charge and no dispatch; death after its fsync
      // consumes one unit even when GitHub never saw the request. Recovery never
      // enters this branch and cannot add or refresh a charge.
      const quotaRefusal = claim!.withOwnership(() => {
        let override: CreateBudgetOverride | undefined;
        const now = budgetNow();
        if (write.action === "create_issue") {
          const budget = { ...claimBudget!, count: claimBudget!.count + invocationCreates,
            // A rollback could bring charges that predate the cached window back
            // into scope. Refuse rather than undercount or reread under this claim.
            ...(now.getTime() < Date.parse(claimBudget!.asOf)
              ? { problem: "Budget clock moved backwards while the claim was held." } : {}),
          };
          const refusal = quotaRefusals.get(operationKey(write))
            ?? createQuotaRefusal(budget, input.immediate === true, invocationCreates, input.allowCreateBudgetOverrun === true);
          if (refusal !== undefined) return refusal;
          if (input.allowCreateBudgetOverrun) override = {
            flag: "--allow-create-budget-overrun", operator: userInfo().username,
            runId: boundEvidence!.evidence.runId, countBefore: budget.count,
            ceiling: budget.ceiling, windowHours: budget.windowHours, windowStart: budget.windowStart, at: now.toISOString(),
          };
        }
        // Unreadable history must refuse before an intent can reserve create budget.
        // The dispatch guard still reads again to discover a late disposition.
        (input.dispositionHistory ?? dispositionHistory)("origin/main", {
          repoRoot: input.repoRoot, runGit: input.runGit ?? runCredentialCleanGit,
        });
        const intent = executionEvent({ event: "intent", now, write, decisionContentSha256: planEntry.decisionReport.contentSha256 });
        recordTransition({ ...intent, ...(override === undefined ? {} : { createBudgetOverride: override }) }, planEntry);
        if (write.action === "create_issue") invocationCreates += 1;
        return undefined;
      });
      if (quotaRefusal !== undefined) {
        ledgerRecords.push({ ...projectResult(durableState, {
          entry: planEntry, source, now: appliedAt, mode: "execute",
          existenceRevalidation: revalidations.get(planEntry.decisionReport.path),
        }), disposition: "refused", refusalReason: quotaRefusal });
        failures.push({ sourceFingerprint: write.sourceFingerprint, action: write.action,
          stage: "projection", issueNumber: null, error: quotaRefusal });
        continue;
      }
      let issueNumber: number | null = null;
      let issueId: string | number | null = null;
      let commentId: string | number | null = null;
      let dispatched = false;
      try {
        if (write.action === "create_issue") {
          const result = await claim!.withOwnership(() => {
            beforeWrite(write);
            dispatched = true;
            return transport().createIssue(write.repository, write.issue!, fence);
          });
          issueNumber = result.issueNumber;
          issueId = result.issueId ?? null;
        } else {
          issueNumber = write.canonicalIssueNumber!;
          const result = await claim!.withOwnership(() => {
            beforeWrite(write);
            dispatched = true;
            return transport().appendEvidenceComment(write.repository, issueNumber!, write.evidenceComment!, fence);
          });
          commentId = result.commentId;
          if (write.closeIssue !== null) {
            await claim!.withOwnership(() => {
              beforeWrite(write);
              return transport().closeIssue(write.repository, write.closeIssue!.targetIssueNumber, fence);
            });
          }
        }
        if (!Number.isSafeInteger(issueNumber) || issueNumber === null || issueNumber <= 0) {
          throw new Error("Dispatched operation returned no valid issue number.");
        }
      } catch (error) {
        if (error instanceof JournalWriteError || error instanceof ExecutionOwnershipError) throw error;
        if (error instanceof DispositionedWrite) {
          recordTransition({ ...executionEvent({ event: "withdrawn_dispositioned", now: appliedAt, write,
            decisionContentSha256: planEntry.decisionReport.contentSha256, issueNumber, issueId, commentId }),
            completedActions: commentId === null ? [] : ["append_evidence"] }, planEntry);
          if (write.action === "create_issue") invocationCreates -= 1;
          ledgerRecords.push(projectResult(stateFor(planEntry), {
            entry: planEntry, source, now: appliedAt, mode: "execute",
            existenceRevalidation: revalidations.get(planEntry.decisionReport.path),
          }));
          continue;
        }
        // Preserve any earlier dispatch and its retained identities when a later
        // history read fails, such as after append but before close.
        if (!dispatched && (error instanceof UnboundOutcomeIdentity
          || error instanceof Error && error.message.startsWith("disposition_history_unavailable:"))) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const unresolved = executionEvent({
          event: "create_unresolved", now: appliedAt, write,
          decisionContentSha256: planEntry.decisionReport.contentSha256,
          issueNumber, issueId, commentId, error: message,
        });
        recordTransition(unresolved, planEntry);
        recordFailure({ sourceFingerprint: write.sourceFingerprint, action: write.action, stage: "dispatch",
          issueNumber: unresolved.issueNumber, error: message }, error);
        ledgerRecords.push(projectResult(stateFor(planEntry), {
          entry: planEntry, source, now: appliedAt, mode: "execute",
          existenceRevalidation: revalidations.get(planEntry.decisionReport.path),
        }));
        continue;
      }
      const created = executionEvent({
        event: "created", now: appliedAt, write, decisionContentSha256: planEntry.decisionReport.contentSha256,
        issueNumber, issueId, commentId,
      });
      recordTransition(created, planEntry);
      await confirmForApply(
        write, planEntry.decisionReport.contentSha256, issueNumber, issueId, commentId, true, "classification", undefined, planEntry,
      );
      ledgerRecords.push(projectResult(stateFor(planEntry), {
        entry: planEntry, source, now: appliedAt, mode: "execute",
        existenceRevalidation: revalidations.get(planEntry.decisionReport.path),
      }));
    }
    // Re-read the journal so observation rows and their row numbers are included too.
    const completedJournal = readJournal(journalPath);
    return { mode: "execute", ownership, journalPath, journalTail, writes, ledgerRecords, reconciliations, failures, runEvidence,
      executionSummary: summarizeApplyExecution(indexHistory(completedJournal.records, completedJournal.tail), appliedAt, repository, reconciliations),
      ...(breaker.aborted === undefined ? {} : { aborted: breaker.aborted }) };
  } catch (error) {
    runFailure = { error };
    throw error;
  } finally {
    try { if (input.heldClaim === undefined) claim?.release(); }
    catch (releaseError) {
      if (runFailure === undefined) {
        Object.assign(ownership!, { releaseError: releaseError instanceof Error ? releaseError.message : String(releaseError) });
      } else {
        // Preserve the original failure, wrapping non-Errors without losing their value.
        const original = runFailure.error instanceof Error
          ? runFailure.error : new Error(String(runFailure.error), { cause: runFailure.error });
        try {
          if (runFailure.error instanceof Error && original.cause === undefined) original.cause = releaseError;
          else Object.defineProperty(original, "suppressed", { value: [releaseError], configurable: true });
        } catch { console.error("Execution claim release failed:", releaseError); }
        throw original;
      }
    }
  }
}

function parseArguments(argv: readonly string[]): { plan: string; ledger?: string; execute: boolean; allowCreateBudgetOverrun: boolean; originMainSha?: string; candidates: string[]; existence: string[]; importLedgers: string[]; runEvidence?: string } {
  let plan: string | undefined;
  let ledger: string | undefined;
  let originMainSha: string | undefined;
  let runEvidence: string | undefined;
  let execute = false;
  let allowCreateBudgetOverrun = false;
  const candidates: string[] = [];
  const existence: string[] = [];
  const importLedgers: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("--plan=") && plan === undefined) plan = argument.slice("--plan=".length);
    else if (argument.startsWith("--ledger=") && ledger === undefined) ledger = argument.slice("--ledger=".length);
    else if (argument.startsWith("--origin-main-sha=") && originMainSha === undefined) {
      originMainSha = argument.slice("--origin-main-sha=".length);
    }
    else if (argument === "--execute" && !execute) execute = true;
    else if (argument === "--allow-create-budget-overrun" && !allowCreateBudgetOverrun) allowCreateBudgetOverrun = true;
    else if (argument.startsWith("--run-evidence=") && argument !== "--run-evidence=" && runEvidence === undefined) {
      runEvidence = argument.slice("--run-evidence=".length);
    }
    else if (argument.startsWith("--candidate=")) candidates.push(argument.slice("--candidate=".length));
    else if (argument.startsWith("--existence=")) existence.push(argument.slice("--existence=".length));
    else if (argument.startsWith("--import-ledger=") && argument !== "--import-ledger=") importLedgers.push(argument.slice("--import-ledger=".length));
    else throw new Error(`Unsupported or duplicate argument: ${argument}`);
  }
  if (plan === undefined || plan === "") throw new Error("Approval apply requires --plan=PATH.");
  return { plan: resolve(plan), ledger: ledger === undefined ? undefined : resolve(ledger), execute, allowCreateBudgetOverrun, originMainSha, candidates, existence, importLedgers, runEvidence };
}

export async function runIntakeApplyCli(input: {
  readonly actionQualificationContext?: ActionQualificationContext;
  readonly heldClaim?: ExecutionClaim;
  readonly argv: readonly string[];
  readonly immediate?: boolean;
  readonly repoRoot?: string;
  readonly runGit?: GitRunner;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly operatorToken?: string;
  readonly transport?: OperatorIntakeApprovalTransport;
  readonly openTransport?: () => OperatorIntakeApprovalTransport;
  readonly log?: (line: string) => void;
}): Promise<IntakeApplyResult> {
  const args = parseArguments(input.argv);
  const invocation: IntakeApplyInput = {
    actionQualificationContext: input.actionQualificationContext,
    heldClaim: input.heldClaim,
    planPath: args.plan,
    execute: args.execute,
    immediate: input.immediate,
    allowCreateBudgetOverrun: args.allowCreateBudgetOverrun,
    trustedCurrentOriginMainSha: args.originMainSha,
    candidatePaths: args.candidates,
    existencePaths: args.existence,
    runEvidencePath: args.runEvidence,
    repoRoot: input.repoRoot,
    runGit: input.runGit,
    dispositionHistory: input.dispositionHistory,
    ledgerPath: args.ledger,
    importLedgerPaths: args.importLedgers,
    transport: input.transport,
    openTransport: input.openTransport,
  };
  const mode = resolveInvocationMode(invocation);
  if (mode === "execute" && (args.originMainSha === undefined || !/^[0-9a-f]{40}$/.test(args.originMainSha))) {
    throw new Error("Execute mode requires --origin-main-sha=<trusted-current-sha>.");
  }
  if (mode === "execute" && args.runEvidence === undefined) {
    throw new Error("Execution requires --run-evidence=<path> produced by the drain run that generated this plan.");
  }
  if (mode !== "execute" && args.originMainSha !== undefined) throw new Error("--origin-main-sha is supported only with --execute.");
  if (mode !== "execute" && args.candidates.length > 0) throw new Error("--candidate is supported only with --execute.");
  if (mode !== "execute" && args.existence.length > 0) throw new Error("--existence is supported only with --execute.");
  const result = await applyIntakeApprovalPlanInMode(invocation, mode, () => {
    const operatorToken = input.operatorToken;
    const tokenPresent = operatorToken !== undefined && operatorToken.trim() !== "";
    if (mode === "dry-run" && tokenPresent) {
      throw new Error("ROADMAP_SHADOW_PUBLISH_TOKEN is allowed only for an explicit --execute invocation.");
    }
    if (mode === "execute" && !tokenPresent) {
      throw new Error("Set ROADMAP_SHADOW_PUBLISH_TOKEN only for this explicit --execute invocation.");
    }
  });
  (input.log ?? console.log)(JSON.stringify(result, null, 2));
  if (result.failures.length > 0 || result.ownership?.releaseError !== undefined
    || result.ledgerRecords.some((record) => record.refusalReason?.startsWith("repository_create_budget_unavailable:"))) process.exitCode = 1;
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  let operatorToken: string | undefined;
  void runIntakeApplyCli({
    argv,
    // The mode/evidence guards run before the CLI asks for this credential.
    get operatorToken() { return operatorToken ??= process.env.ROADMAP_SHADOW_PUBLISH_TOKEN; },
    transport: undefined,
    openTransport: () => createGitHubIntakeApprovalTransport({ token: operatorToken! }),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
