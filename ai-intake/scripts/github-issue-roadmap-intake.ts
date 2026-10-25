import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTOMATIC_INTAKE_LIMITS,
  assertCapabilityExecutable,
  dispatcherCapabilityManifestHash,
  parseDispatcherCapabilityManifest,
  type DispatcherCapabilityManifest,
} from "./lib/github-issue-roadmap/capability-manifest";
import { canonicalJsonSha256 } from "./lib/github-issue-roadmap/canonical-json";
import {
  adoptCanonicalConsumption,
  beginConsumptionAttempt,
  ConsumptionLedgerVersionSkewError,
  markConsumptionAmbiguous,
  markConsumptionVerified,
  recentConsumptionTotals,
  type ConsumptionKey,
} from "./lib/github-issue-roadmap/consumption-safety-ledger";
import type { VerifiedDispatcherDeployment } from "./lib/github-issue-roadmap/dispatcher-deployment";
import type { HostRepositoryLock } from "./lib/github-issue-roadmap/host-lock";
import { assertEffectiveIntakeEnvelopeBudgets, assertIntakeEnvelopeByteBudgets, intakeAssessmentSha256, intakeDispositionSkips, parseIntakeAssessment, type IntakeAssessment, type IntakeDispositionSkip } from "./lib/github-issue-roadmap/intake-assessment";
import { dispositionHistory, effectiveOutcomeCandidates, type DispositionHistory } from "./lib/github-issue-roadmap/disposition-history";
import {
  INTAKE_CAPABILITIES,
  compileIntakeDecision,
  type IntakeActionDecision,
  type IntakeCapabilityManifest,
  type IntakeDecision,
} from "./lib/github-issue-roadmap/intake-decision";
import {
  assertFinalIntakeRevalidation,
  type IntakeCensusPass,
  type IntakeSnapshotV1,
  type MarkerLocation,
  sourceMarkersMatchLoosely,
  sourceMarkersMatchStrictly,
} from "./lib/github-issue-roadmap/intake-snapshot";
import { createProposalV2, validateProposalV2, type ProposalV2 } from "./lib/github-issue-roadmap/proposal-v2";
import { runIntakeShadow } from "./lib/github-issue-roadmap/intake-shadow";
import {
  assertAutomaticIntakeEnvelopeBudgets,
  parseOutcomeEnvelope,
  type OutcomeCandidate,
  type OutcomeEnvelope,
} from "./lib/github-issue-roadmap/outcome-candidate";
import {
  buildCreateIssuePayload,
  buildEvidenceCommentBody,
  buildIntakeIssueDraft,
  buildIssueFieldValuePayload,
  type CreateIssuePayload,
  type IntakeIssueDraft,
  type IssueFieldValueInput,
  type IssueFieldValuePayload,
} from "./lib/github-issue-roadmap/intake-issue-draft";
import { renderSourceMarker, type SourceMarkerV1 } from "./lib/github-issue-roadmap/source-marker";
import {
  checkpointStewardAuditV2,
  createInitialStewardAuditV2,
  terminalAuditStatus,
  type StewardAuditV2,
  type StewardAuditV2Writer,
  type V2TerminalOutcome,
} from "./lib/github-issue-roadmap/steward-audit-v2";

export { AUTOMATIC_INTAKE_LIMITS };

const PRIMARY_ACTIONS = new Set(["create_issue", "append_evidence"]);
const CLASSIFICATION_ACTIONS = new Set<IntakeActionDecision["action"]>(["set_type", "set_priority", "set_effort"]);
const AUTOMATIC_ACTIONS = new Set<string>(INTAKE_CAPABILITIES);

/**
 * The envelope budgets are defined in `lib/github-issue-roadmap/outcome-candidate` so shadow mode
 * applies the identical limits; its import closure cannot reach this file. Re-exported here so the
 * default path and every existing importer keep the same name.
 */
export { assertAutomaticIntakeEnvelopeBudgets };

/**
 * The issue-payload builders live in `lib/github-issue-roadmap/intake-issue-draft` so shadow mode
 * can render the identical draft without pulling the consumption ledger, host lock, credential,
 * deployment, or transport modules into its graph. Imports flow CLI -> lib only; these re-exports
 * keep existing importers working without giving the lib module a path back into this file.
 */
export {
  buildCreateIssuePayload,
  buildIssueFieldValuePayload,
  buildIntakeIssueDraft,
  type CreateIssuePayload,
  type IntakeIssueDraft,
  type IssueFieldValueInput,
  type IssueFieldValuePayload,
};

/** Runtime census bindings use the same parsed-marker and source-position shape as snapshots. */
export type IntakeMarkerBinding = MarkerLocation;

export interface CanonicalIntakeIssue {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly nativeType: string | null;
  readonly fields: Readonly<Record<string, string | null>>;
  readonly preservationTuple: unknown;
  readonly projectMembershipCount: number;
}

export interface FinalIntakeCensus {
  readonly complete: boolean;
  readonly markerBindings: readonly IntakeMarkerBinding[];
  readonly issues: readonly CanonicalIntakeIssue[];
}

export interface AutomaticIntakeTransport {
  readonly createIssue: (payload: CreateIssuePayload) => Promise<{ readonly issueNumber: number; readonly databaseId: number; readonly requestId?: string }>;
  readonly appendEvidenceComment: (issueNumber: number, body: string) => Promise<{ readonly commentId: number; readonly requestId?: string }>;
  readonly setIssueType: (issueNumber: number, value: string) => Promise<{ readonly requestId?: string }>;
  readonly setIssueFieldValues: (issueNumber: number, payload: IssueFieldValuePayload) => Promise<{ readonly requestId?: string }>;
}

export interface CredentialedAutomaticIntakeTransport {
  readonly credentialFingerprint: string;
  readonly transport: AutomaticIntakeTransport;
}

export interface AutomaticIntakeDependencies {
  readonly writeAudit: StewardAuditV2Writer;
  readonly acquireLock: () => HostRepositoryLock | Promise<HostRepositoryLock>;
  readonly readFinalCensus: () => Promise<FinalIntakeCensus>;
  /**
   * Re-reads the full canonical census pass so `create_issue` can re-prove the entire bound
   * novelty evidence — not just this candidate's fingerprint — under the host lock.
   */
  readonly readFinalCensusPass?: () => Promise<IntakeCensusPass>;
  readonly verifyDeployment: () => VerifiedDispatcherDeployment;
  readonly openCredentialedTransport: (deployment: VerifiedDispatcherDeployment, capability: string) => CredentialedAutomaticIntakeTransport;
  readonly checkpointIssueIdentity: (binding: { readonly issueNumber: number; readonly databaseId: number }) => void;
  readonly checkpointResult: (result: AutomaticCandidateResult) => void;
}

export interface AutomaticCandidateResult {
  readonly sourceFingerprint: string;
  readonly status: "replay" | "held" | "created" | "created_partial" | "commented" | "partial_safe" | "recovered" | "unknown_remote_outcome" | "conflict";
  readonly issueNumber: number | null;
  readonly commentId: number | null;
  readonly projectDrift: boolean;
  readonly detail: string;
}

export interface AutomaticIntakeRunResult {
  readonly candidates: readonly AutomaticCandidateResult[];
  readonly skipped: readonly IntakeDispositionSkip[];
}

interface AutomaticIntakeRunInput {
  readonly repoRoot?: string;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly envelope: unknown;
  readonly decision: IntakeDecision;
  /** The snapshot the decision was compiled against; execution re-derives rather than trusting. */
  readonly snapshot: IntakeSnapshotV1;
  /** The assessment the decision was compiled against; execution re-derives rather than trusting. */
  readonly assessment: IntakeAssessment;
  readonly existenceRecord: unknown;
  readonly intakeCapabilityManifest?: IntakeCapabilityManifest | null;
  readonly dispatcherManifest: DispatcherCapabilityManifest;
  readonly runtimeEnabled: boolean;
  readonly now: string;
  readonly originMainSha: string;
  readonly ledgerRoot?: string;
  readonly fieldIds?: Readonly<Partial<Record<"Priority" | "Effort", string>>>;
  readonly deps: AutomaticIntakeDependencies;
}

function repositoryName(envelope: OutcomeEnvelope): string {
  return `${envelope.repository.organization}/${envelope.repository.name}`;
}

function candidateActions(decision: IntakeDecision, candidate: OutcomeCandidate): readonly IntakeActionDecision[] {
  const entry = decision.candidates.find((item) => item.sourceFingerprint === candidate.sourceFingerprint);
  if (entry === undefined) throw new Error("Intake decision is missing a bound candidate.");
  return entry.actions;
}

function automaticActions(actions: readonly IntakeActionDecision[]): IntakeActionDecision[] {
  return actions.filter((action) => action.disposition === "automatic_safe" && AUTOMATIC_ACTIONS.has(action.action));
}

function assertNoSensitiveAutomaticActions(actions: readonly IntakeActionDecision[]): void {
  for (const action of actions) {
    if (action.disposition !== "automatic_safe") continue;
    if (action.action === "set_horizon" || action.action === "reopen_issue" || action.action === "change_relationship") {
      throw new Error(`${action.action} requires exact approval and cannot be automatic.`);
    }
    if (action.action === "set_priority" && ["P0", "P1"].includes(String(action.proposed))) {
      throw new Error("P0/P1 requires exact approval and cannot be automatic.");
    }
  }
}

function assertRunBudgets(allActions: readonly IntakeActionDecision[]): void {
  const creates = allActions.filter((action) => action.action === "create_issue").length;
  const comments = allActions.filter((action) => action.action === "append_evidence").length;
  if (creates > AUTOMATIC_INTAKE_LIMITS.maxCreatesPerRun) throw new Error("Automatic intake create per-run budget exceeded.");
  if (comments > AUTOMATIC_INTAKE_LIMITS.maxCommentsPerRun) throw new Error("Automatic intake comment per-run budget exceeded.");
}

function consumptionKey(repository: string, capability: string, candidate: OutcomeCandidate): ConsumptionKey {
  return { repository, capability, sourceFingerprint: candidate.sourceFingerprint, emissionHash: candidate.emissionContentSha256 };
}

function expectedSourceMarker(envelope: OutcomeEnvelope, candidate: OutcomeCandidate): SourceMarkerV1 {
  return {
    sourceFingerprint: candidate.sourceFingerprint,
    emissionContentSha256: candidate.emissionContentSha256,
    producerKind: envelope.producer.kind,
    producerVersion: envelope.producer.version,
    stableArtifactId: envelope.artifact.stableId,
    stableOutcomeId: candidate.stableOutcomeId,
    sourceLocator: envelope.artifact.sourceLocator,
  };
}

function findCandidateBindings(
  census: FinalIntakeCensus,
  envelope: OutcomeEnvelope,
  candidate: OutcomeCandidate,
): {
  canonicalClaims: IntakeMarkerBinding[];
  exactEmissions: IntakeMarkerBinding[];
} {
  const expected = expectedSourceMarker(envelope, candidate);
  const outcomeBindings = census.markerBindings.filter((binding) =>
    sourceMarkersMatchLoosely(binding.marker, expected));
  const claimsByIssue = new Map<number, IntakeMarkerBinding>();
  for (const binding of outcomeBindings) {
    if (binding.source === "body" && !claimsByIssue.has(binding.issueNumber)) {
      claimsByIssue.set(binding.issueNumber, binding);
    }
  }
  const canonicalClaims = [...claimsByIssue.values()]
    .sort((left, right) => left.issueNumber - right.issueNumber);
  const canonicalIssueNumber = canonicalClaims.length === 1 ? canonicalClaims[0].issueNumber : null;
  const exactEmissions = canonicalIssueNumber === null
    ? []
    : outcomeBindings.filter((binding) =>
        binding.issueNumber === canonicalIssueNumber &&
        sourceMarkersMatchStrictly(binding.marker, expected));
  return { canonicalClaims, exactEmissions };
}

function assertCompleteCensus(census: FinalIntakeCensus): void {
  if (!census.complete) throw new Error("Final canonical census is incomplete; automatic intake is denied.");
}

async function recoverAmbiguous(input: {
  readonly deps: AutomaticIntakeDependencies; readonly envelope: OutcomeEnvelope;
  readonly candidate: OutcomeCandidate; readonly key: ConsumptionKey;
  readonly attemptId: string; readonly now: string; readonly expectedComment: boolean; readonly ledgerRoot?: string;
}): Promise<AutomaticCandidateResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const census = await input.deps.readFinalCensus(); assertCompleteCensus(census);
    const bindings = findCandidateBindings(census, input.envelope, input.candidate);
    if (bindings.canonicalClaims.length > 1) {
      return { sourceFingerprint: input.candidate.sourceFingerprint, status: "conflict", issueNumber: null, commentId: null, projectDrift: false, detail: "Multiple canonical issue bodies matched an ambiguous response; exact recovery approval is required." };
    }
    const matches = bindings.exactEmissions.filter((binding) =>
      input.expectedComment ? binding.source === "comment" : binding.source === "body");
    if (bindings.canonicalClaims.length === 1 && matches.length > 0) {
      const match = matches[0];
      adoptCanonicalConsumption({ root: input.ledgerRoot, key: input.key, attemptId: input.attemptId, canonicalBinding: { issueNumber: match.issueNumber, commentId: match.commentDatabaseId }, now: input.now });
      return { sourceFingerprint: input.candidate.sourceFingerprint, status: "recovered", issueNumber: match.issueNumber, commentId: match.commentDatabaseId, projectDrift: false, detail: "One canonical issue recovered the ambiguous response from its exact emission receipt." };
    }
  }
  return { sourceFingerprint: input.candidate.sourceFingerprint, status: "unknown_remote_outcome", issueNumber: null, commentId: null, projectDrift: false, detail: "No canonical marker resolved the ambiguous response; no retry was sent." };
}

function primaryAction(actions: readonly IntakeActionDecision[]): IntakeActionDecision | null {
  const primary = automaticActions(actions).filter((action) => PRIMARY_ACTIONS.has(action.action));
  if (primary.length > 1) throw new Error("A candidate may have only one automatic consumption action.");
  return primary[0] ?? null;
}

function primaryOutcomeFor(result: AutomaticCandidateResult): V2TerminalOutcome {
  if (result.status === "recovered") return "recovered_adopted";
  if (result.status === "created_partial") return "created_partial";
  if (result.status === "unknown_remote_outcome") return "unknown_remote_outcome";
  if (result.status === "conflict" || result.status === "held") return "conflict_no_write";
  if (result.status === "replay") return "recovered_no_mutation";
  return "verified_applied";
}

function primaryAndSkipped(proposal: ProposalV2, primary: ExecutedActionOutcome): ExecutedActionOutcome[] {
  return [primary, ...proposal.actions.slice(1).map(() => ({ outcome: "skipped" as const }))];
}

/**
 * The execution boundary never trusts a caller-supplied decision object. It recompiles the
 * decision from the bound envelope, snapshot, and assessment and demands exact canonical
 * equality, so a forged or drifted decision cannot authorize a write on its own say-so.
 */
function recompileBoundDecision(envelope: OutcomeEnvelope, input: AutomaticIntakeRunInput, history: DispositionHistory): IntakeDecision {
  if (input.assessment.candidateSha256 !== canonicalJsonSha256(envelope)) throw new Error("Bound assessment does not describe this envelope.");
  if (input.snapshot.contentSha256 !== input.assessment.snapshotContentSha256) throw new Error("Bound snapshot and assessment are not the same intake stack.");
  if (input.decision.snapshotContentSha256 !== input.snapshot.contentSha256) throw new Error("Intake decision is not bound to the supplied snapshot.");
  if (input.decision.assessmentSha256 !== intakeAssessmentSha256(input.assessment)) throw new Error("Intake decision is not bound to the supplied assessment.");
  const assessment = parseIntakeAssessment(input.assessment, envelope, input.snapshot, undefined, history);
  const recompiled = compileIntakeDecision({
    envelope,
    snapshot: input.snapshot,
    assessment,
    dispositionHistory: history,
    existenceRecord: input.existenceRecord,
    verifiedOriginMainSha: input.originMainSha,
    capabilityManifest: input.intakeCapabilityManifest ?? null,
    generatedAt: input.decision.generatedAt,
  });
  const active = new Set(effectiveOutcomeCandidates(envelope, history).active.map(candidate => candidate.sourceFingerprint));
  const projected = { ...input.decision, assessmentSha256: intakeAssessmentSha256(assessment),
    candidates: input.decision.candidates.filter(candidate => active.has(candidate.sourceFingerprint)),
    attention: (recompiled.skipped?.length ?? 0) > 0 ? recompiled.attention : input.decision.attention,
    ...(recompiled.skipped === undefined ? {} : { skipped: recompiled.skipped }) };
  if (canonicalJsonSha256(recompiled) !== canonicalJsonSha256(projected)) {
    throw new Error("Supplied intake decision does not match the decision recompiled from its bound evidence.");
  }
  return recompiled;
}

/** Defense in depth: structural authority invariants, asserted directly by tests and by execution. */
export function assertDecisionBindings(envelope: OutcomeEnvelope, decision: IntakeDecision, history: DispositionHistory): void {
  if (decision.candidateSha256 !== canonicalJsonSha256(envelope)) throw new Error("Intake decision candidate binding drifted.");
  if (decision.repository.databaseId !== envelope.repository.databaseId || decision.repository.nodeId !== envelope.repository.nodeId) throw new Error("Intake decision repository identity drifted.");
  const expected = effectiveOutcomeCandidates(envelope, history).active.map((candidate) => candidate.sourceFingerprint).sort();
  const actual = decision.candidates.map((candidate) => candidate.sourceFingerprint).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Intake decision must contain exactly one bound entry per candidate.");
  if (canonicalJsonSha256(decision.skipped ?? []) !== canonicalJsonSha256(intakeDispositionSkips(envelope, history))) throw new Error("Intake decision skipped binding drifted.");
  decision.candidates.forEach((candidate) => {
    assertNoSensitiveAutomaticActions(candidate.actions);
    const executable = automaticActions(candidate.actions);
    const primary = primaryAction(candidate.actions);
    if (executable.length > 0 && primary === null) throw new Error("Automatic classification cannot execute without a qualified create or evidence-consumption action.");
    for (const action of executable) {
      if (action.requiredCapabilities.length !== 1 || action.requiredCapabilities[0] !== action.action) throw new Error(`Automatic action ${action.action} has an invalid capability binding.`);
    }
  });
}

interface PreparedCandidate {
  readonly candidate: OutcomeCandidate;
  readonly actions: readonly IntakeActionDecision[];
  readonly proposal: ProposalV2 | null;
  readonly audit: StewardAuditV2 | null;
}

interface ExecutedActionOutcome {
  readonly outcome: V2TerminalOutcome;
  readonly requestId?: string;
  readonly after?: unknown;
  readonly error?: string;
}

interface MutationSafetyState { possibleMutation: boolean }

function prepareCandidates(input: {
  readonly envelope: OutcomeEnvelope; readonly decision: IntakeDecision; readonly manifest: DispatcherCapabilityManifest;
  readonly now: string; readonly originMainSha: string; readonly writeAudit: StewardAuditV2Writer;
}): PreparedCandidate[] {
  const decisionSha256 = canonicalJsonSha256(input.decision);
  const capabilityManifestSha256 = dispatcherCapabilityManifestHash(input.manifest);
  return input.decision.candidates.map((entry) => {
    const candidate = input.envelope.candidates.find(candidate => candidate.sourceFingerprint === entry.sourceFingerprint)!;
    const actions = structuredClone(candidateActions(input.decision, candidate));
    const executable = automaticActions(actions);
    if (executable.length === 0) return { candidate, actions, proposal: null, audit: null };
    const targetIssueNumber = primaryAction(actions)?.targetIssueNumber ?? null;
    const proposal = createProposalV2({
      repository: repositoryName(input.envelope), candidateSha256: input.decision.candidateSha256,
      sourceFingerprint: candidate.sourceFingerprint, emissionHash: candidate.emissionContentSha256,
      snapshotSha256: input.decision.snapshotContentSha256, assessmentSha256: input.decision.assessmentSha256,
      decisionSha256, capabilityManifestSha256, originMainSha: input.originMainSha, actorClass: "automatic",
      createdAt: input.now, expiresAt: new Date(Date.parse(input.now) + 10 * 60 * 1000).toISOString(),
      target: { repository: repositoryName(input.envelope), issueNumber: targetIssueNumber },
      predictedCanonicalState: executable.map((action) => action.predictedCanonicalResult),
      actions: executable.map((action, index) => ({
        actionId: `${candidate.sourceFingerprint.slice(0, 12)}:${index}:${action.action}`,
        kind: action.action, capability: action.requiredCapabilities[0] ?? action.action,
        before: action.before, after: action.proposed, preservationEffects: action.preservationEffects,
      })),
    });
    validateProposalV2(proposal);
    const audit = createInitialStewardAuditV2(proposal, input.now);
    // This is the first dependency invocation for every mutating candidate. No lock, read, deployment, credential, or transport exists yet.
    checkpointStewardAuditV2(input.writeAudit, audit);
    return { candidate, actions, proposal, audit };
  });
}

function finishAudit(audit: StewardAuditV2, outcomes: readonly ExecutedActionOutcome[], now: string): void {
  audit.actions.forEach((action, index) => {
    const execution = outcomes[index] ?? { outcome: "skipped" as const };
    action.outcome = execution.outcome;
    action.after = execution.after ?? null;
    if (execution.requestId !== undefined) action.requestId = execution.requestId;
    if (execution.error !== undefined) action.error = execution.error;
  });
  audit.status = terminalAuditStatus(audit.actions.map((action) => action.outcome as V2TerminalOutcome));
  audit.completedAt = now;
}

async function applyAutomaticMetadata(input: {
  readonly candidate: OutcomeCandidate; readonly actions: readonly IntakeActionDecision[]; readonly targetIssueNumber: number;
  readonly repository: string; readonly manifest: DispatcherCapabilityManifest; readonly deployment: VerifiedDispatcherDeployment;
  readonly proposal: ProposalV2; readonly ledgerRoot?: string; readonly now: string;
  readonly fieldIds: Readonly<Partial<Record<"Priority" | "Effort", string>>>; readonly deps: AutomaticIntakeDependencies;
  readonly safety: MutationSafetyState;
  /** Re-asserted at the point of use so the gate does not rest solely on the caller's pre-flight pass. */
  readonly runtimeEnabled: boolean;
}): Promise<{ readonly partial: boolean; readonly retainLock: boolean; readonly outcomes: readonly ExecutedActionOutcome[] }> {
  const nonPrimaryActions = automaticActions(input.actions).filter((entry) => !PRIMARY_ACTIONS.has(entry.action));
  const metadataActions = nonPrimaryActions.filter((entry) => CLASSIFICATION_ACTIONS.has(entry.action));
  if (metadataActions.length !== nonPrimaryActions.length) {
    return { partial: true, retainLock: false, outcomes: nonPrimaryActions.map((entry) => CLASSIFICATION_ACTIONS.has(entry.action)
      ? { outcome: "skipped" }
      : { outcome: "partial_safe", error: `Unhandled non-primary automatic action ${entry.action}; only classification actions are supported by the metadata writer. Contract gap; action refused.` }) };
  }
  const outcomes: ExecutedActionOutcome[] = [];
  for (let index = 0; index < metadataActions.length; index += 1) {
    const action = metadataActions[index];
    const before = await input.deps.readFinalCensus(); assertCompleteCensus(before);
    const issue = before.issues.find((entry) => entry.issueNumber === input.targetIssueNumber);
    if (issue === undefined) return { partial: true, retainLock: false, outcomes: [...outcomes, { outcome: "partial_safe", error: "Canonical issue disappeared before optional metadata." }, ...metadataActions.slice(index + 1).map(() => ({ outcome: "skipped" as const }))] };
    const fieldName = action.action === "set_priority" ? "Priority" : action.action === "set_effort" ? "Effort" : null;
    const existing = action.action === "set_type" ? issue.nativeType : fieldName === null ? null : issue.fields[fieldName];
    if (existing !== null) { outcomes.push({ outcome: "skipped", after: issue }); continue; } // A later human value is authoritative; routine intake never normalizes it.
    let fieldPayload: IssueFieldValuePayload | null = null;
    try {
      if (action.action === "set_priority" || action.action === "set_effort") {
        if (action.action === "set_priority" && !["P2", "P3"].includes(String(action.proposed))) throw new Error("P0/P1 cannot execute through routine intake.");
        if (action.action === "set_effort" && (!input.candidate.readiness.independentlyCloseable || !input.candidate.readiness.completionRuleDefined || !input.candidate.readiness.estimationSubstrate)) throw new Error("Effort remains unset until independently closeable and estimable.");
        const qualifiedFieldId = input.fieldIds[action.action === "set_priority" ? "Priority" : "Effort"];
        if (qualifiedFieldId === undefined) throw new Error("Issue field ID is not qualified.");
        fieldPayload = buildIssueFieldValuePayload([{ fieldName: action.action === "set_priority" ? "Priority" : "Effort", fieldId: qualifiedFieldId, value: String(action.proposed) }]);
      }
      const capability = assertCapabilityExecutable(input.manifest, action.action, "automatic", input.runtimeEnabled);
      const credentialed = input.deps.openCredentialedTransport(input.deployment, capability.capability);
      // Classification writes are repeatable field assignments. The fresh read
      // above preserves human values; a consumption interlock would strand retries.
      try {
        input.safety.possibleMutation = true;
        const response = fieldPayload === null
          ? await credentialed.transport.setIssueType(input.targetIssueNumber, String(action.proposed))
          : await credentialed.transport.setIssueFieldValues(input.targetIssueNumber, fieldPayload);
        const after = await input.deps.readFinalCensus(); assertCompleteCensus(after);
        const updated = after.issues.find((entry) => entry.issueNumber === input.targetIssueNumber);
        const verified = updated !== undefined && (action.action === "set_type" ? updated.nativeType === action.proposed : updated.fields[fieldName!] === action.proposed);
        if (!verified) throw new Error("GitHub silently dropped the automatic classification update.");
        outcomes.push({ outcome: "verified_applied", requestId: response.requestId, after: updated });
      } catch (error) {
        return { partial: true, retainLock: true, outcomes: [...outcomes, { outcome: "unknown_remote_outcome", error: error instanceof Error ? error.message : "Unknown metadata mutation failure" }, ...metadataActions.slice(index + 1).map(() => ({ outcome: "skipped" as const }))] };
      }
    } catch (error) {
      return { partial: true, retainLock: false, outcomes: [...outcomes, { outcome: "partial_safe", error: error instanceof Error ? error.message : "Metadata validation failed" }, ...metadataActions.slice(index + 1).map(() => ({ outcome: "skipped" as const }))] };
    }
  }
  return { partial: false, retainLock: false, outcomes };
}

async function executeCandidate(input: {
  readonly envelope: OutcomeEnvelope; readonly candidate: OutcomeCandidate; readonly actions: readonly IntakeActionDecision[];
  /** The recompiled bound decision, so the create payload is drafted by the one shared builder. */
  readonly decision: IntakeDecision;
  readonly manifest: DispatcherCapabilityManifest; readonly deployment: VerifiedDispatcherDeployment; readonly now: string;
  readonly ledgerRoot?: string; readonly fieldIds: Readonly<Partial<Record<"Priority" | "Effort", string>>>;
  readonly deps: AutomaticIntakeDependencies; readonly finalCensus: FinalIntakeCensus;
  readonly snapshot: IntakeSnapshotV1;
  readonly proposal: ProposalV2;
  readonly safety: MutationSafetyState;
  /** Re-asserted at the point of use so the gate does not rest solely on the caller's pre-flight pass. */
  readonly runtimeEnabled: boolean;
}): Promise<{ result: AutomaticCandidateResult; retainLock: boolean; actionOutcomes: readonly ExecutedActionOutcome[] }> {
  const repository = repositoryName(input.envelope);
  validateProposalV2(input.proposal);
  const primary = primaryAction(input.actions);
  if (primary === null) {
    const replay = input.actions.some((action) => action.action === "replay_no_op" && action.disposition === "automatic_safe");
    return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: replay ? "replay" : "held", issueNumber: replay ? input.actions.find((action) => action.action === "replay_no_op")?.targetIssueNumber ?? null : null, commentId: null, projectDrift: false, detail: replay ? "Canonical emission already exists; zero writes." : "No qualified automatic consumption action; zero writes." }, retainLock: false, actionOutcomes: [{ outcome: replay ? "recovered_no_mutation" : "conflict_no_write" }] };
  }
  const bindings = findCandidateBindings(input.finalCensus, input.envelope, input.candidate);
  if (bindings.canonicalClaims.length > 1) return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "conflict", issueNumber: null, commentId: null, projectDrift: false, detail: "Final census found competing canonical issue bodies; zero writes." }, retainLock: false, actionOutcomes: input.proposal.actions.map((_action, index) => ({ outcome: index === 0 ? "conflict_no_write" : "skipped" })) };
  if (bindings.exactEmissions.length > 0) {
    const exact = bindings.exactEmissions[0];
    return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "replay", issueNumber: exact.issueNumber, commentId: exact.commentDatabaseId, projectDrift: false, detail: "Final census found the exact canonical emission; zero writes." }, retainLock: false, actionOutcomes: input.proposal.actions.map((_action, index) => ({ outcome: index === 0 ? "recovered_no_mutation" : "skipped" })) };
  }
  if (primary.action === "create_issue" && bindings.canonicalClaims.length !== 0) return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "held", issueNumber: null, commentId: null, projectDrift: false, detail: "Final census no longer proves novelty; zero writes." }, retainLock: false, actionOutcomes: input.proposal.actions.map((_action, index) => ({ outcome: index === 0 ? "conflict_no_write" : "skipped" })) };
  if (primary.action === "append_evidence" && (bindings.canonicalClaims.length !== 1 || bindings.canonicalClaims[0].issueNumber !== primary.targetIssueNumber)) return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "held", issueNumber: null, commentId: null, projectDrift: false, detail: "Final census no longer proves one exact canonical issue; zero writes." }, retainLock: false, actionOutcomes: input.proposal.actions.map((_action, index) => ({ outcome: index === 0 ? "conflict_no_write" : "skipped" })) };

  if (primary.action === "create_issue") {
    // Novelty was compiled against the bound snapshot. Re-prove that whole snapshot — every census
    // and marker input, not just this candidate's fingerprint — before any credential is released.
    if (input.deps.readFinalCensusPass === undefined) throw new Error("Issue creation requires a bound-snapshot revalidation reader.");
    try {
      assertFinalIntakeRevalidation(input.snapshot, await input.deps.readFinalCensusPass());
    } catch (error) {
      // Any drift in — or failure to re-read — the bound evidence holds the candidate at zero writes.
      return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "held", issueNumber: null, commentId: null, projectDrift: false, detail: `Bound novelty evidence no longer revalidates; zero writes. (${error instanceof Error ? error.message : String(error)})` }, retainLock: false, actionOutcomes: input.proposal.actions.map((_action, index) => ({ outcome: index === 0 ? "conflict_no_write" : "skipped" })) };
    }
  }

  const capability = assertCapabilityExecutable(input.manifest, primary.action, "automatic", input.runtimeEnabled);
  const credentialed = input.deps.openCredentialedTransport(input.deployment, capability.capability);
  const key = consumptionKey(repository, capability.capability, input.candidate);
  if (primary.action === "create_issue") {
    // R3/KTD4: the executing create path files exactly what the shared builder drafts.
    const draft: IntakeIssueDraft = buildIntakeIssueDraft({ envelope: input.envelope, candidate: input.candidate, decision: input.decision });
    const payload = draft.issue;
    const attempt = beginConsumptionAttempt({ root: input.ledgerRoot, key, credentialFingerprint: credentialed.credentialFingerprint, proposalSha256: input.proposal.proposalSha256, now: input.now });
    let response: Awaited<ReturnType<AutomaticIntakeTransport["createIssue"]>>;
    try {
      input.safety.possibleMutation = true;
      response = await credentialed.transport.createIssue(payload);
      input.deps.checkpointIssueIdentity({ issueNumber: response.issueNumber, databaseId: response.databaseId });
    } catch {
      markConsumptionAmbiguous({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, now: input.now });
      const recovered = await recoverAmbiguous({ deps: input.deps, envelope: input.envelope, candidate: input.candidate, key, attemptId: attempt.attemptId, now: input.now, expectedComment: false, ledgerRoot: input.ledgerRoot });
      return { result: recovered, retainLock: recovered.status !== "recovered", actionOutcomes: primaryAndSkipped(input.proposal, { outcome: primaryOutcomeFor(recovered), after: recovered }) };
    }
    const afterCreate = await input.deps.readFinalCensus(); assertCompleteCensus(afterCreate);
    const created = afterCreate.issues.find((issue) => issue.issueNumber === response.issueNumber);
    const markerMatches = findCandidateBindings(afterCreate, input.envelope, input.candidate).exactEmissions
      .filter((binding) => binding.issueNumber === response.issueNumber && binding.source === "body");
    if (created === undefined || markerMatches.length === 0 || created.title !== payload.title || !created.body.includes(renderSourceMarker(input.envelope, input.candidate)) || created.fields.Horizon !== null) {
      markConsumptionAmbiguous({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, now: input.now });
      return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "created_partial", issueNumber: response.issueNumber, commentId: null, projectDrift: created?.projectMembershipCount === 0, detail: "Issue identity was checkpointed but canonical create readback failed; no recreate or delete is permitted." }, retainLock: true, actionOutcomes: primaryAndSkipped(input.proposal, { outcome: "created_partial", requestId: response.requestId, after: created, error: "Canonical create readback failed." }) };
    }
    markConsumptionVerified({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, canonicalBinding: { issueNumber: response.issueNumber, commentId: null }, now: input.now });

    const metadata = await applyAutomaticMetadata({ candidate: input.candidate, actions: input.actions, targetIssueNumber: response.issueNumber, repository, manifest: input.manifest, deployment: input.deployment, proposal: input.proposal, ledgerRoot: input.ledgerRoot, now: input.now, fieldIds: input.fieldIds, deps: input.deps, safety: input.safety, runtimeEnabled: input.runtimeEnabled });
    if (metadata.partial) return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "created_partial", issueNumber: response.issueNumber, commentId: null, projectDrift: created.projectMembershipCount === 0, detail: "Issue creation succeeded but an optional classification failed or drifted; the issue was not deleted or recreated." }, retainLock: metadata.retainLock, actionOutcomes: [{ outcome: "verified_applied", requestId: response.requestId, after: created }, ...metadata.outcomes] };
    const final = await input.deps.readFinalCensus(); assertCompleteCensus(final);
    const finalIssue = final.issues.find((entry) => entry.issueNumber === response.issueNumber);
    return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "created", issueNumber: response.issueNumber, commentId: null, projectDrift: (finalIssue?.projectMembershipCount ?? 0) === 0, detail: (finalIssue?.projectMembershipCount ?? 0) === 0 ? "Issue created and verified; Project Auto-add is lagging or unavailable, with no Project mutation." : "Issue created and canonical issue state verified." }, retainLock: false, actionOutcomes: [{ outcome: "verified_applied", requestId: response.requestId, after: created }, ...metadata.outcomes] };
  }

  const targetIssue = input.finalCensus.issues.find((issue) => issue.issueNumber === primary.targetIssueNumber);
  if (targetIssue === undefined) throw new Error("Exact-match target disappeared from final census.");
  const body = buildEvidenceCommentBody(input.envelope, input.candidate);
  const attempt = beginConsumptionAttempt({ root: input.ledgerRoot, key, credentialFingerprint: credentialed.credentialFingerprint, proposalSha256: input.proposal.proposalSha256, now: input.now });
  let response: Awaited<ReturnType<AutomaticIntakeTransport["appendEvidenceComment"]>>;
  try { input.safety.possibleMutation = true; response = await credentialed.transport.appendEvidenceComment(targetIssue.issueNumber, body); }
  catch {
    markConsumptionAmbiguous({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, now: input.now });
    const recovered = await recoverAmbiguous({ deps: input.deps, envelope: input.envelope, candidate: input.candidate, key, attemptId: attempt.attemptId, now: input.now, expectedComment: true, ledgerRoot: input.ledgerRoot });
    return { result: recovered, retainLock: recovered.status !== "recovered", actionOutcomes: primaryAndSkipped(input.proposal, { outcome: primaryOutcomeFor(recovered), after: recovered }) };
  }
  const after = await input.deps.readFinalCensus(); assertCompleteCensus(after);
  const afterIssue = after.issues.find((issue) => issue.issueNumber === targetIssue.issueNumber);
  const markers = findCandidateBindings(after, input.envelope, input.candidate).exactEmissions.filter((binding) =>
    binding.issueNumber === targetIssue.issueNumber && binding.source === "comment" &&
    binding.commentDatabaseId === response.commentId);
  if (afterIssue === undefined || canonicalJsonSha256(afterIssue.preservationTuple) !== canonicalJsonSha256(targetIssue.preservationTuple) || markers.length === 0) {
    markConsumptionAmbiguous({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, now: input.now });
    return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "unknown_remote_outcome", issueNumber: targetIssue.issueNumber, commentId: response.commentId, projectDrift: false, detail: "Evidence comment did not pass additive preservation readback; no retry was sent." }, retainLock: true, actionOutcomes: primaryAndSkipped(input.proposal, { outcome: "unknown_remote_outcome", requestId: response.requestId, after: afterIssue, error: "Additive comment preservation readback failed." }) };
  }
  markConsumptionVerified({ root: input.ledgerRoot, key, attemptId: attempt.attemptId, canonicalBinding: { issueNumber: targetIssue.issueNumber, commentId: response.commentId }, now: input.now });
  const metadata = await applyAutomaticMetadata({ candidate: input.candidate, actions: input.actions, targetIssueNumber: targetIssue.issueNumber, repository, manifest: input.manifest, deployment: input.deployment, proposal: input.proposal, ledgerRoot: input.ledgerRoot, now: input.now, fieldIds: input.fieldIds, deps: input.deps, safety: input.safety, runtimeEnabled: input.runtimeEnabled });
  if (metadata.partial) return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "partial_safe", issueNumber: targetIssue.issueNumber, commentId: response.commentId, projectDrift: false, detail: "Additive evidence succeeded, but optional classification failed or drifted; canonical evidence remains preserved." }, retainLock: metadata.retainLock, actionOutcomes: [{ outcome: "verified_applied", requestId: response.requestId, after: markers[0] }, ...metadata.outcomes] };
  return { result: { sourceFingerprint: input.candidate.sourceFingerprint, status: "commented", issueNumber: targetIssue.issueNumber, commentId: response.commentId, projectDrift: false, detail: "One additive marker-bearing evidence comment was verified; stronger canonical evidence was preserved." }, retainLock: false, actionOutcomes: [{ outcome: "verified_applied", requestId: response.requestId, after: markers[0] }, ...metadata.outcomes] };
}

export async function executeAutomaticIntake(input: AutomaticIntakeRunInput): Promise<AutomaticIntakeRunResult> {
  assertIntakeEnvelopeByteBudgets(input.envelope);
  const envelope = parseOutcomeEnvelope(input.envelope);
  const history = (input.dispositionHistory ?? dispositionHistory)(input.originMainSha, { repoRoot: input.repoRoot });
  assertEffectiveIntakeEnvelopeBudgets(input.envelope, envelope, history);
  const selection = effectiveOutcomeCandidates(envelope, history);
  const skipped = intakeDispositionSkips(envelope, history);
  if (selection.active.length === 0) return { candidates: [], skipped };
  const decision = recompileBoundDecision(envelope, input, history);
  assertDecisionBindings(envelope, decision, history);
  const manifest = parseDispatcherCapabilityManifest(input.dispatcherManifest);
  if (manifest.repository.toLowerCase() !== repositoryName(envelope).toLowerCase()) throw new Error("Dispatcher manifest belongs to another repository.");
  const actions = selection.active.flatMap((candidate) => automaticActions(candidateActions(decision, candidate)));
  assertRunBudgets(actions);
  for (const action of actions) assertCapabilityExecutable(manifest, action.action, "automatic", input.runtimeEnabled);
  if (actions.length === 0) return { skipped, candidates: selection.active.map((candidate) => {
    const decisions = candidateActions(decision, candidate);
    const replay = decisions.find((action) => action.action === "replay_no_op" && action.disposition === "automatic_safe");
    return { sourceFingerprint: candidate.sourceFingerprint, status: replay === undefined ? "held" : "replay", issueNumber: replay?.targetIssueNumber ?? null, commentId: null, projectDrift: false, detail: replay === undefined ? "No qualified automatic action; zero writes." : "Canonical emission already exists; zero writes." };
  }) };

  const prepared = prepareCandidates({ envelope, decision, manifest, now: input.now, originMainSha: input.originMainSha, writeAudit: input.deps.writeAudit });

  const lock = await input.deps.acquireLock(); let retain = false;
  const safety: MutationSafetyState = { possibleMutation: false };
  try {
    const initial = await input.deps.readFinalCensus(); assertCompleteCensus(initial);
    const totals = recentConsumptionTotals(input.ledgerRoot, repositoryName(envelope), input.now);
    if (totals.budgetBlocked) {
      const versionSkew = totals.issues.find((issue) =>
        (issue.repository === null || issue.repository === repositoryName(envelope).toLowerCase()) &&
        issue.error instanceof ConsumptionLedgerVersionSkewError);
      if (versionSkew !== undefined) throw new Error("Host-global daily budget fails closed because the consumption ledger contains a record written by a newer version of this tool. Upgrade this checkout before retrying.", { cause: versionSkew.error });
      throw new Error(`Host-global daily budget fails closed due to unreadable consumption records: ${JSON.stringify(totals.issues)}`);
    }
    const creates = actions.filter((action) => action.action === "create_issue").length;
    const comments = actions.filter((action) => action.action === "append_evidence").length;
    if (totals.creates + creates > AUTOMATIC_INTAKE_LIMITS.maxCreatesPer24Hours || totals.comments + comments > AUTOMATIC_INTAKE_LIMITS.maxCommentsPer24Hours) throw new Error("Host-global rolling 24-hour automatic intake budget exceeded.");
    // The deployment trust check runs before the only dependency capable of releasing mutation credentials.
    const deployment = input.deps.verifyDeployment();
    if (deployment.commit !== decision.verifiedOriginMainSha) {
      throw new Error(
        `Intake decision verified origin/main SHA ${decision.verifiedOriginMainSha} ` +
        `does not match trusted deployment commit ${deployment.commit}.`,
      );
    }
    const results: AutomaticCandidateResult[] = [];
    for (const item of prepared) {
      if (item.proposal === null || item.audit === null) continue;
      const executed = await executeCandidate({ envelope, candidate: item.candidate, actions: item.actions, decision, proposal: item.proposal, snapshot: input.snapshot, manifest, deployment, now: input.now, ledgerRoot: input.ledgerRoot, fieldIds: input.fieldIds ?? {}, deps: input.deps, finalCensus: await input.deps.readFinalCensus(), safety, runtimeEnabled: input.runtimeEnabled });
      results.push(executed.result); retain ||= executed.retainLock;
      finishAudit(item.audit, executed.actionOutcomes, input.now);
      retain = true;
      checkpointStewardAuditV2(input.deps.writeAudit, item.audit);
      input.deps.checkpointResult(executed.result);
      retain = executed.retainLock;
      safety.possibleMutation = executed.retainLock;
      if (retain) break;
    }
    if (retain || safety.possibleMutation) lock.retain(); else lock.release();
    return { candidates: results, skipped };
  } catch (error) {
    if (retain || safety.possibleMutation) lock.retain(); else lock.release();
    throw error;
  }
}

/**
 * Shadow mode consumes the same bound stack the (deleted-in-U3) review root did. The paths are
 * validated by the one parser so a mistyped mode flag can never fall through to the
 * disabled-transport refusal and read as a legitimate hold.
 */
const SHADOW_REQUIRED_PATHS = ["snapshot", "assessment", "existence", "origin-main-sha", "out"] as const;

export interface IntakeCliArgs {
  readonly candidate: string;
  readonly shadow: boolean;
  readonly snapshot: string | null;
  readonly assessment: string | null;
  readonly existence: string | null;
  readonly originMainSha: string | null;
  readonly capabilities: string | null;
  readonly out: string | null;
}

export function parseIntakeCliArgs(argv: readonly string[]): IntakeCliArgs {
  const values = new Map<string, string>();
  let shadow = false;
  for (const argument of argv) {
    if (argument === "--shadow") {
      if (shadow) throw new Error("Duplicate --shadow argument.");
      shadow = true;
      continue;
    }
    const match = /^--(candidate|snapshot|assessment|existence|origin-main-sha|capabilities|out)=(.+)$/.exec(argument);
    if (match === null) throw new Error(`Unsupported argument: ${argument}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  if (!values.has("candidate")) throw new Error("Missing required --candidate=PATH argument.");
  if (shadow) {
    for (const name of SHADOW_REQUIRED_PATHS) {
      if (!values.has(name)) throw new Error(`Missing required --${name}=PATH argument.`);
    }
  } else {
    // Accepting a shadow-only path without --shadow would silently discard it and then refuse,
    // which is the same indistinguishable-refusal confusion the strict parser exists to prevent.
    for (const name of [...SHADOW_REQUIRED_PATHS, "capabilities"] as const) {
      if (values.has(name)) throw new Error(`--${name} is only supported with --shadow.`);
    }
  }
  return {
    candidate: values.get("candidate")!,
    shadow,
    snapshot: values.get("snapshot") ?? null,
    assessment: values.get("assessment") ?? null,
    existence: values.get("existence") ?? null,
    originMainSha: values.get("origin-main-sha") ?? null,
    capabilities: values.get("capabilities") ?? null,
    out: values.get("out") ?? null,
  };
}

/**
 * The parser already refuses a shadow run missing any of these, so this narrows the nullable field
 * without an unchecked cast: a future parser change cannot silently hand the pipeline `undefined`.
 */
function requiredShadowPath(value: string | null, flag: string): string {
  if (value === null) throw new Error(`Missing required --${flag}=PATH argument.`);
  return value;
}

export function runIntakeCli(argv: readonly string[], repoRoot = process.cwd(), readHistory = dispositionHistory): void {
  const args = parseIntakeCliArgs(argv);
  if (args.shadow) {
    // Parse-and-delegate only. The recommendation-only pipeline lives in
    // `lib/github-issue-roadmap/intake-shadow`, a module whose import closure cannot reach a
    // credential, ledger, host lock, deployment, or transport; inlining any of it here would put
    // the shadow path back inside a file that imports all five.
    runIntakeShadow({
      candidate: args.candidate,
      snapshot: requiredShadowPath(args.snapshot, "snapshot"),
      assessment: requiredShadowPath(args.assessment, "assessment"),
      existence: requiredShadowPath(args.existence, "existence"),
      verifiedOriginMainSha: requiredShadowPath(args.originMainSha, "origin-main-sha"),
      capabilities: args.capabilities,
      out: requiredShadowPath(args.out, "out"),
      repoRoot,
      dispositionHistory: readHistory,
    });
    return;
  }
  const raw = JSON.parse(readFileSync(resolve(repoRoot, args.candidate), "utf8"));
  assertIntakeEnvelopeByteBudgets(raw);
  const envelope = parseOutcomeEnvelope(raw);
  const history = readHistory("origin/main", { repoRoot });
  assertEffectiveIntakeEnvelopeBudgets(raw, envelope, history);
  const selection = effectiveOutcomeCandidates(envelope, history);
  for (const candidate of selection.dispositioned) console.log(`${candidate.sourceFingerprint}: dispositioned; zero writes.`);
  if (selection.active.length === 0) return;
  throw new Error("Automatic intake production transport is disabled until deployment, calibration, disposable proof, and cutover gates are externally satisfied.");
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try { runIntakeCli(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
