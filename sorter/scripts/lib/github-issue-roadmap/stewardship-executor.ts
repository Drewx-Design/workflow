import { canonicalJsonSha256 } from "./canonical-json";
import { issueFieldValueIdentity } from "./issue-field-value";
import { createProposalV2, validateProposalV2, type ProposalV2 } from "./proposal-v2";
import { isVerificationFresh, parsePersistedVerificationRecords, type VerificationCommentInput } from "./snapshot-v2";
import { freezeStewardshipAssessment, stewardshipAssessmentEnvelopeSchema, validateStewardshipEvidence,
  type ArchivedStewardshipAssessment, type BoundStewardshipEvidence } from "./stewardship-assessment";
import { compileStewardshipDecision, sameStewardshipSeatFamilies, STEWARDSHIP_COMPILER_VERSION, stewardshipDecisionProvenance, type CompileStewardshipDecisionOptions, type StewardshipDecision } from "./stewardship-decision";
import { STEWARDSHIP_FOREIGN_SORT_KEY, stewardshipPacketMaterialSha256, type StewardshipIssueEvidencePacket } from "./stewardship-evidence";
import type { StewardshipBatchObservation, StewardshipGitHub, StewardshipObservation, StewardshipTargetObservation, StewardshipRehearsalTransport, StewardshipSendReceipt } from "./stewardship-github";
import { stewardshipSortKeyMatches } from "./stewardship-github";
import { classifyStewardshipSnapshotTransition, planStewardshipSnapshotClassification,
  type StewardshipSnapshotClassification, type StewardshipSnapshotClassificationPlan, type StewardshipSnapshotCondition,
  type StewardshipSnapshotOpState, type StewardshipSnapshotTransition } from "./stewardship-snapshot-transitions";
import { parseStewardshipPolicy, resolveStewardshipPolicy, stewardshipOperationSchema, stewardshipPolicySha256, type StewardshipOperation, type StewardshipPolicy } from "./stewardship-policy";
import { createStewardshipLifecycleReceipt, isStewardshipPreviewStore, stewardshipActionBlocksIssue, type StewardshipLifecycleReceipt, type StewardshipState, type StewardshipStore } from "./stewardship-state";
import type { StewardshipSeatFamilies } from "./stewardship-seat-families";
import { compileStewardshipBacklog, stewardshipSnapshotOperations } from "./stewardship-backlog";
import { isSnapshotStewardshipPolicy, STEWARDSHIP_NATIVE_FIELDS, stewardshipOperationField, stewardshipOperationValue } from "./stewardship-policy";
import { timeStewardshipAsync, timeStewardshipSync, type StewardshipTimingCollector } from "./stewardship-phase-timing";

export type { StewardshipPreviewStore } from "./stewardship-state";

export interface StewardshipExecutionRequest {
  readonly evidence: BoundStewardshipEvidence;
  readonly assessments: readonly ArchivedStewardshipAssessment[];
  /** Preview only. The executor always recompiles; this object grants no authority. */
  readonly decision: StewardshipDecision;
  readonly census?: { readonly complete: boolean; readonly nowCount: number };
  /** Untrusted preview inputs, used only for offline integrity checking. Locked state replaces these for execution. */
  readonly previewContext?: Pick<CompileStewardshipDecisionOptions, "holds" | "heldEvidence" | "releasedAt">;
}
export interface StewardshipExecutionOptions {
  readonly policy: StewardshipPolicy;
  readonly runId: string;
  readonly store: StewardshipStore;
  readonly requests: readonly StewardshipExecutionRequest[];
  /** Called only after offline authority validation, archival checks and locked-state gates. */
  readonly createGitHub: () => StewardshipGitHub;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly phaseTiming?: StewardshipTimingCollector;
}
export interface StewardshipExecutionResult {
  readonly issueNumber: number;
  readonly status: "updated" | "partial" | "no-change" | "deferred" | "escalated";
  readonly reasons: readonly string[];
  readonly confirmedActionIds: readonly string[];
  readonly finalObservationSha256: string | null;
  readonly finalMaterialEvidenceSha256: string | null;
  readonly nextEligibleAt: string | null;
  /** Diagnostic only: successful sends whose readback remained unresolved. */
  readonly unresolvedSendReceipts?: readonly { actionId: string; operationIndex: number; receipt: StewardshipSendReceipt }[];
  /** Families of the cached settlement, present only for unchanged_settlement. */
  readonly seatFamilies?: StewardshipSeatFamilies | null;
  readonly snapshot?: {
    readonly directSkippedIndices: number[]; readonly propagatedSkippedIndices: number[]; readonly sendSkippedIndices: number[];
    readonly outageIndices: number[]; readonly notAppliedIndices: number[];
    readonly skips: { index: number; reason: string }[];
  };
}
export interface StewardshipSnapshotExecutionSummary {
  thresholdNumerator: number; thresholdDenominator: number; partialStop: boolean; issueCount: number;
  directSkips: number; propagatedSkips: number; sendSkips: number; outages: number; notApplied: number;
  runResult: StewardshipSnapshotTransition["runResult"];
}
type NativeObservation = StewardshipObservation | Extract<StewardshipTargetObservation, { status: "ok" }>;
type SnapshotResults = StewardshipExecutionResult[] & { summary?: StewardshipSnapshotExecutionSummary };
type SnapshotOptions = Omit<StewardshipExecutionOptions, "requests"> & { snapshotSha256: string; rehearsal?: never };
export type StewardshipRehearsalOptions = Omit<SnapshotOptions, "createGitHub" | "rehearsal"> & {
  rehearsal: { transport: StewardshipRehearsalTransport; preflightConcurrency?: 1 | 2 };
};
export interface StewardshipRehearsalResult {
  schemaVersion: "github-issue-roadmap-rehearsal/v1";
  rehearsal: true;
  sendCount: number;
  summary: StewardshipSnapshotExecutionSummary;
  plan: StewardshipSnapshotClassificationPlan | null;
  classifications: StewardshipSnapshotClassification[];
  dispositions: { index: number; issueNumber: number; disposition: "R" | "skip" | "outage" | "pending" | "prior-confirmed" | "prior-not-applied" }[];
  phaseTiming: ReturnType<StewardshipTimingCollector["snapshot"]>["phaseTiming"];
  rateLimits: ReturnType<StewardshipTimingCollector["snapshot"]>["rateLimits"];
  rateLimitsStart: ReturnType<StewardshipTimingCollector["snapshot"]>["rateLimits"];
}
interface Authority {
  readonly schemaVersion: "github-issue-roadmap-stewardship-authority/v1";
  readonly adoptionId: string;
  readonly compile: CompileStewardshipDecisionOptions;
  readonly decision: StewardshipDecision;
}
interface ActionBinding {
  readonly schemaVersion: "github-issue-roadmap-stewardship-execution/v1";
  readonly authoritySha256: string;
  readonly beforeObservationSha256: string;
  readonly operationIndex: number;
  readonly proposal: ProposalV2;
}
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const EXECUTION_REFUSALS = new Set(["invalid_decision_preview", "missing_immutable_evidence", "archived_evidence_mismatch",
  "archived_assessment_hash_mismatch", "archived_assessment_mismatch", "adoption_binding_mismatch", "paused", "issue_quarantined",
  "material_evidence_changed", "incomplete_live_observation", "invalid_native_history", "unbound_comment", "duplicate_comment_marker",
  "unresolved_v1_action", "unresolved_action"]);
export function isLegacyCompilerAction(action: { readonly compilerVersion?: number }): boolean {
  // v3 authorities retain their original decoder/compiler for journal recovery.
  return action.compilerVersion !== 3 && action.compilerVersion !== STEWARDSHIP_COMPILER_VERSION;
}
export function stewardshipUnresolvedActionReason(state: StewardshipState, issueNumber: number, approvedSnapshotSha256?: string): "unresolved_v1_action" | "unresolved_action" | null {
  const unresolved = Object.values(state.actions).filter((action) => action.issueNumber === issueNumber
    && stewardshipActionBlocksIssue(state, action, approvedSnapshotSha256));
  return unresolved.some(isLegacyCompilerAction) ? "unresolved_v1_action"
    : unresolved.length ? "unresolved_action" : null;
}
function retryTimestamp(error: unknown, now: string): string | null {
  if (error === null || typeof error !== "object" || !("nextEligibleAt" in error)) return null;
  const timestamp = error.nextEligibleAt;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) && milliseconds > Date.parse(now) ? new Date(milliseconds).toISOString() : null;
}
function commentAuthor(comment: VerificationCommentInput): unknown {
  return comment.user !== null && typeof comment.user === "object" ? (comment.user as { login?: unknown }).login : null;
}
function exactComment(comment: VerificationCommentInput, body: string, policy: StewardshipPolicy): boolean {
  return comment.body === body && commentAuthor(comment) === policy.operator && comment.created_at === comment.updated_at
    && typeof comment.created_at === "string" && Number.isFinite(Date.parse(comment.created_at))
    && Number.isSafeInteger(comment.id) && typeof comment.node_id === "string";
}
function operationBody(authority: Authority, operation: StewardshipOperation): string | undefined {
  if (operation.kind !== "append_comment") return undefined;
  const comment = authority.decision.comments.find((entry) => entry.purpose === operation.purpose && entry.bodySha256 === operation.bodySha256);
  requireCondition(comment && canonicalJsonSha256(comment.body) === operation.bodySha256, "unbound_comment"); return comment.body;
}
function assertNativeObservation(observation: Pick<StewardshipObservation, "evidence" | "census"> | Extract<StewardshipTargetObservation, { status: "ok" }>, policy: StewardshipPolicy) {
  validateStewardshipEvidence(observation.evidence, policy);
  requireCondition("targetCompleteness" in observation ? observation.targetCompleteness.complete === true
    : observation.census.complete && Number.isSafeInteger(observation.census.nowCount)
      && observation.census.nowCount >= 0, "incomplete_live_observation");
  for (const field of isSnapshotStewardshipPolicy(policy) ? STEWARDSHIP_NATIVE_FIELDS : ["Priority", "Horizon"] as const) {
    const history = observation.evidence.packet.fieldHistory[field];
    requireCondition(history && history.frontier.complete && same(history.events.map((event) => event.id).sort(), [...history.frontier.eventIds].sort())
      && history.sha256 === canonicalJsonSha256(history.events), "invalid_native_history");
  }
}
function assertObservation(observation: NativeObservation, policy: StewardshipPolicy) {
  assertNativeObservation(observation, policy);
  requireCondition(observation.commentsComplete === true, "incomplete_live_observation");
}
function sameObservedIssue(left: StewardshipObservation, right: StewardshipObservation): boolean {
  return left.evidence.originMainSha === right.evidence.originMainSha && left.evidence.policySha256 === right.evidence.policySha256
    && left.evidence.packet.materialEvidenceSha256 === right.evidence.packet.materialEvidenceSha256 && same(left.comments, right.comments);
}
/** KTD7 fences issue-native state; repository/scout evidence remains bound to approval, not live main. */
function sameSnapshotIssue(left: NativeObservation, right: NativeObservation): boolean {
  // Compile has no comment capture. Once both sides are live observe() results,
  // compare their complete comments exactly, including at the final SEND fence.
  const includeComments = left.comments !== undefined && right.comments !== undefined;
  // An open, linked (non-closing) PR's head is provenance, not approval-material;
  // any other relationship keeps its head compared (fail closed).
  // state, relationship, mergedAt and membership still refuse.
  const pullRequests = (packet: StewardshipIssueEvidencePacket) => packet.issue.pullRequests.map((pr) => {
    if (pr.state !== "OPEN" || pr.relationship !== "linked") return pr;
    const { headSha: _headSha, ...approvalMaterial } = pr;
    void _headSha;
    return approvalMaterial;
  });
  // Mirrors historyMaterial in stewardship-evidence.ts:
  // the timeline cursor is transport position, not approval material; field events, IDs, completeness and hashes still refuse.
  const fieldHistory = (packet: StewardshipIssueEvidencePacket) => Object.fromEntries(
    Object.entries(packet.fieldHistory).map(([field, history]) => {
      const { cursor: _cursor, ...frontier } = history.frontier;
      void _cursor;
      return [field, { ...history, frontier }];
    }),
  );
  const native = ({ evidence: { packet }, comments }: NativeObservation) => ({ identity: packet.issue.identity,
    title: packet.title, body: packet.body, bodySha256: packet.bodySha256, state: packet.issue.v1.state,
    stateReason: packet.issue.v1.stateReason, createdAt: packet.issue.v1.createdAt, authorLogin: packet.authorLogin ?? null,
    fields: packet.fields, fieldValues: packet.issue.v1.fieldValues, history: fieldHistory(packet),
    labels: packet.issue.v1.labels, assignees: packet.issue.v1.assignees, milestone: packet.issue.v1.milestone,
    ...(includeComments ? { comments } : {}),
    nativeType: packet.issue.nativeType, type: packet.issue.v1.type, relationships: packet.issue.relationships,
    projectMemberships: packet.issue.projectMemberships, persistedVerifications: packet.issue.persistedVerifications, pullRequests: pullRequests(packet),
    reopens: packet.reopenEvents ?? [] });
  return left.evidence.policySha256 === right.evidence.policySha256 && same(native(left), native(right));
}
/** Read-only attribution may outlive main. Native issue facts remain exact; only repository-source facts may drift. */
function recoverySourceProjection(before: StewardshipObservation, after: StewardshipObservation): StewardshipObservation {
  const old = before.evidence.packet; const current = after.evidence.packet;
  const sourceFact = (fact: StewardshipIssueEvidencePacket["facts"][number]) => fact.kind === "source" || fact.kind === "strategy";
  // The rubric identity is bound to the spec source, so it travels with the archived sources (absent before U2).
  const currentWithoutRubric = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "rubricIdentity")) as Omit<typeof current, "rubricIdentity">;
  const packet = { ...currentWithoutRubric, ...(old.rubricIdentity === undefined ? {} : { rubricIdentity: old.rubricIdentity }),
    evidencePhase: old.evidencePhase, sources: old.sources, clauses: old.clauses, coverage: old.coverage,
    facts: [...old.facts.filter(sourceFact), ...current.facts.filter((fact) => !sourceFact(fact))].sort((a, b) => a.factId.localeCompare(b.factId)) };
  // Preserve original fact order, because an order change is not source evidence.
  packet.facts.sort((a, b) => old.facts.findIndex((fact) => fact.factId === a.factId) - old.facts.findIndex((fact) => fact.factId === b.factId));
  return { ...after, evidence: { ...after.evidence, originMainSha: before.evidence.originMainSha,
    packet: { ...packet, materialEvidenceSha256: stewardshipPacketMaterialSha256(packet, before.evidence.originMainSha, after.evidence.policySha256) } } };
}
function persistedVerification(authority: Authority, observation: StewardshipObservation, at: string) {
  const expected = authority.decision.comments.find((comment) => comment.purpose === "verification");
  if (!expected) return;
  const comments = observation.comments.filter((comment) => exactComment(comment, expected.body, authority.compile.policy));
  requireCondition(comments.length === 1, "verification_comment_not_unique");
  const records = parsePersistedVerificationRecords({ trustedAuthors: [authority.compile.policy.operator], body: null, issueAuthor: null,
    issueCreatedAt: at, issueUpdatedAt: at, comments });
  requireCondition(records.length === 1 && records[0].trust.status === "trusted" && records[0].originMainSha === authority.compile.evidence.originMainSha
    && records[0].verifiedAt !== null && isVerificationFresh(records[0].verifiedAt, at)
    && expected.body.endsWith(`check: ${records[0].check}`), "verification_not_trusted");
}

/** Accept only the one native effect, preserving every other material member and raw comment.
 * The shared operator account makes a same-value hand edit inside the send window
 * indistinguishable from the sorter's write; native history cannot prove which client sent it.
 */
function verifyEffect(before: NativeObservation, after: NativeObservation, operation: StewardshipOperation,
  policy: StewardshipPolicy, attemptedAt: string, authority?: Authority, snapshotNativeOnly = false): string[] | null {
  assertObservation(after, policy);
  if ((!snapshotNativeOnly && before.evidence.originMainSha !== after.evidence.originMainSha) || before.evidence.policySha256 !== after.evidence.policySha256) return null;
  const old = before.evidence.packet; const current = after.evidence.packet;
  let normalized: StewardshipIssueEvidencePacket = current; let nativeEventIds: string[] = [];
  if (operation.kind === "append_comment") {
    requireCondition(authority, "unbound_comment");
    const body = operationBody(authority, operation)!;
    const additions = after.comments.filter((comment) => !before.comments.some((oldComment) => oldComment.id === comment.id));
    if (additions.length !== 1 || !exactComment(additions[0], body, authority.compile.policy)
      || Date.parse(String(additions[0].created_at)) < Math.floor(Date.parse(attemptedAt) / 1000) * 1000
      || !same(after.comments.filter((comment) => comment.id !== additions[0].id), before.comments)) return null;
    const records = parsePersistedVerificationRecords({ trustedAuthors: [authority.compile.policy.operator], body: null, issueAuthor: null,
      issueCreatedAt: attemptedAt, issueUpdatedAt: attemptedAt, comments: additions });
    if (!same(current.issue.persistedVerifications, [...old.issue.persistedVerifications, ...records].sort((a, b) =>
      (a.verifiedAt ?? a.createdAt).localeCompare(b.verifiedAt ?? b.createdAt) || (a.comment?.databaseId ?? 0) - (b.comment?.databaseId ?? 0)))) return null;
    normalized = { ...current, issue: { ...current.issue, persistedVerifications: old.issue.persistedVerifications } };
  } else {
    if (!same(before.comments, after.comments)) return null;
    const field = stewardshipOperationField(operation)!;
    const value = stewardshipOperationValue(operation);
    const previous = old.fieldHistory[field]; const next = current.fieldHistory[field];
    if (!previous || !next) return null;
    const additions = next.events.filter((event) => !previous.frontier.eventIds.includes(event.id));
    if (additions.length !== 1 || !(field === "Sort key" ? stewardshipSortKeyMatches(current.fields[field], value) : current.fields[field] === value)
      || !same(next.events.filter((event) => previous.frontier.eventIds.includes(event.id)), previous.events)) return null;
    const event = additions[0];
    if (event.field !== field || event.actorLogin !== policy.operator || !Number.isFinite(Date.parse(event.createdAt))
      || Date.parse(event.createdAt) < Math.floor(Date.parse(attemptedAt) / 1000) * 1000
      || !(field === "Sort key" ? stewardshipSortKeyMatches(event.values, value, "event") : same(event.values, value === null ? [] : [value]))
      // GitHub omits a Number change's previous value; added/removed Number events normalize to an empty previous list.
      || (!(field === "Sort key" && event.kind === "changed")
        && !same(event.previousValues, field === "Sort key" || old.fields[field] === null ? [] : [old.fields[field]]))
      || (value === null ? event.kind !== "removed" : event.kind !== (old.fields[field] === null ? "added" : "changed"))) return null;
    const otherValues = (packet: StewardshipIssueEvidencePacket) => packet.issue.v1.fieldValues.filter((entry) => issueFieldValueIdentity(entry).name !== field);
    if (!same(otherValues(old), otherValues(current))) return null;
    nativeEventIds = [event.id];
    normalized = { ...current, fields: { ...current.fields, [field]: old.fields[field] },
      fieldHistory: { ...current.fieldHistory, [field]: previous },
      issue: { ...current.issue, v1: { ...current.issue.v1, fieldValues: old.issue.v1.fieldValues } } };
  }
  return (snapshotNativeOnly ? sameSnapshotIssue(before, { ...after, evidence: { ...after.evidence, packet: normalized } })
    : stewardshipPacketMaterialSha256(normalized, after.evidence.originMainSha, after.evidence.policySha256) === old.materialEvidenceSha256) ? nativeEventIds : null;
}

function readArchivedRequest(request: StewardshipExecutionRequest, store: StewardshipStore, policy: StewardshipPolicy): StewardshipExecutionRequest {
  // Fresh execution validates under the current policy; recovery uses the action's recorded epoch.
  const issue = store.state.issues[request.evidence.packet.issueNumber];
  const reference = issue?.evidencePackets?.[request.evidence.packet.materialEvidenceSha256];
  requireCondition(reference, "missing_immutable_evidence");
  const evidence: BoundStewardshipEvidence = { packet: store.readArtifact(canonicalJsonSha256(request.evidence.packet)) as StewardshipIssueEvidencePacket,
    originMainSha: reference.originMainSha, policySha256: reference.policySha256 };
  validateStewardshipEvidence(evidence, policy);
  requireCondition(same(evidence, request.evidence), "archived_evidence_mismatch");
  const assessments = request.assessments.map((entry) => {
    const envelope = stewardshipAssessmentEnvelopeSchema.parse(store.readArtifact(entry.sha256));
    const assessment = freezeStewardshipAssessment({ evidence, policy, assessment: envelope.assessment, seat: envelope.seat, assessedAt: envelope.assessedAt });
    requireCondition(assessment.sha256 === entry.sha256, "archived_assessment_hash_mismatch"); return assessment;
  });
  requireCondition(same(assessments, request.assessments), "archived_assessment_mismatch");
  return { ...request, evidence, assessments };
}
function compileLocked(request: StewardshipExecutionRequest, options: Pick<StewardshipExecutionOptions, "store" | "policy" | "now">,
  census: StewardshipObservation["census"]): Authority {
  const state = options.store.state; const issue = state.issues[request.evidence.packet.issueNumber];
  const unresolvedReason = stewardshipUnresolvedActionReason(state, request.evidence.packet.issueNumber);
  requireCondition(!unresolvedReason, unresolvedReason ?? "unresolved_action");
  requireCondition(issue && state.policySha256 === stewardshipPolicySha256(options.policy) && state.repository === options.policy.repository, "adoption_binding_mismatch");
  const heldEvidence: Record<string, BoundStewardshipEvidence> = {};
  for (const field of ["Priority", "Horizon"] as const) {
    const hold = issue.fields[field].hold; const ref = hold && issue.evidencePackets?.[hold.materialEvidenceSha256];
    if (ref && hold) {
      const evidence = { packet: options.store.readArtifact(ref.packetSha256) as StewardshipIssueEvidencePacket,
        originMainSha: ref.originMainSha, policySha256: ref.policySha256 };
      validateStewardshipEvidence(evidence, resolveStewardshipPolicy(ref.policySha256, options.policy));
      heldEvidence[hold.materialEvidenceSha256] = evidence;
    }
  }
  const compile: CompileStewardshipDecisionOptions = { evidence: request.evidence, assessments: request.assessments, policy: options.policy,
    now: options.now(), census, holds: { Priority: issue.fields.Priority.hold, Horizon: issue.fields.Horizon.hold }, heldEvidence,
    releasedAt: { Priority: issue.fields.Priority.releasedAt, Horizon: issue.fields.Horizon.releasedAt } };
  return { schemaVersion: "github-issue-roadmap-stewardship-authority/v1", adoptionId: state.adoptionId, compile, decision: compileStewardshipDecision(compile) };
}
function archiveObservation(store: StewardshipStore, observation: StewardshipObservation, at: string): string {
  const evidence = observation.evidence;
  const hash = store.archive(observation);
  const packetSha256 = store.archive(evidence.packet);
  if (!store.state.issues[evidence.packet.issueNumber].evidencePackets?.[evidence.packet.materialEvidenceSha256]) {
    store.append({ type: "evidence-recorded", issueNumber: evidence.packet.issueNumber, materialEvidenceSha256: evidence.packet.materialEvidenceSha256,
      packetSha256, originMainSha: evidence.originMainSha, policySha256: evidence.policySha256 }, at);
  }
  return hash;
}
function detectIntervention(store: StewardshipStore, observation: NativeObservation, policy: StewardshipPolicy, at: string) {
  const packet = observation.evidence.packet; const state = store.state.issues[packet.issueNumber];
  for (const field of isSnapshotStewardshipPolicy(policy) ? STEWARDSHIP_NATIVE_FIELDS : ["Priority", "Horizon"] as const) {
    const history = packet.fieldHistory[field]; const current = state.fields[field];
    if (!history || !current) continue;
    if (packet.fields[field] === current.value && same(history.frontier.eventIds, current.frontier.eventIds)) continue;
    const newEvents = history.events.filter((event) => !current.frontier.eventIds.includes(event.id));
    const actor = newEvents.length > 0 && newEvents.every((event) => event.actorLogin === policy.operator) ? "operator"
      : newEvents.length > 0 && newEvents.every((event) => event.actorLogin?.endsWith("[bot]")) ? "bot" : "unknown";
    store.append({ type: "field-observed", issueNumber: packet.issueNumber, field, value: packet.fields[field] as typeof current.value,
      frontier: history.frontier, materialEvidenceSha256: packet.materialEvidenceSha256, actor }, at);
  }
}
function makeProposal(authority: Authority, authoritySha256: string, before: StewardshipObservation, operationIndex: number, at: string): ProposalV2 {
  const operation = authority.decision.operations[operationIndex];
  const beforeTuple = { materialEvidenceSha256: before.evidence.packet.materialEvidenceSha256, issue: before.evidence.packet.issue,
    fields: before.evidence.packet.fields, bodySha256: before.evidence.packet.bodySha256, commentsSha256: canonicalJsonSha256(before.comments) };
  return createProposalV2({ repository: authority.compile.policy.repository, candidateSha256: canonicalJsonSha256(authority.compile.evidence.packet),
    sourceFingerprint: canonicalJsonSha256({ adoptionId: authority.adoptionId, issueNumber: authority.decision.issueNumber }),
    emissionHash: authoritySha256, snapshotSha256: canonicalJsonSha256(before), assessmentSha256: canonicalJsonSha256(authority.decision.assessmentSha256s),
    decisionSha256: canonicalJsonSha256(authority.decision), capabilityManifestSha256: authority.compile.evidence.policySha256,
    originMainSha: authority.compile.evidence.originMainSha, actorClass: "automatic", createdAt: at,
    expiresAt: new Date(Date.parse(authority.compile.now) + authority.compile.policy.limits.executionBindingMs).toISOString(),
    target: { repository: authority.compile.policy.repository, issueNumber: authority.decision.issueNumber }, predictedCanonicalState: { before: beforeTuple, operation },
    actions: [{ actionId: `steward-${canonicalJsonSha256({ authoritySha256, operationIndex, beforeTuple })}`, kind: `stewardship_${operation.kind}`,
      capability: "stewardship_priority_horizon", before: beforeTuple, after: { operation, commentBody: operationBody(authority, operation) ?? null },
      preservationEffects: ["body", "state", "type", "unrelated_fields", "relationships", "markers", "projects"] }] });
}
function recordOutcome(store: StewardshipStore, actionId: string, before: StewardshipObservation, after: StewardshipObservation | null,
  operation: StewardshipOperation, authority: Authority, attemptedAt: string, at: string, recovery = false): { outcome: "confirmed" | "unresolved" | "conflict"; sourceDrift: boolean } {
  let events: string[] | null = null; let sourceDrift = false;
  if (after) { try { events = verifyEffect(before, after, operation, authority.compile.policy, attemptedAt, authority); } catch { /* Incomplete readback is uncertainty. */ } }
  if (events === null && after && recovery) {
    try {
      assertObservation(after, authority.compile.policy);
      events = verifyEffect(before, recoverySourceProjection(before, after), operation, authority.compile.policy, attemptedAt, authority);
      sourceDrift = events !== null;
    } catch { /* Native conflict or incomplete evidence still quarantines. */ }
  }
  const outcome = events !== null ? "confirmed" : after && !sameObservedIssue(before, after) ? "conflict" : "unresolved";
  const receiptSha256 = store.archive({ schemaVersion: "github-issue-roadmap-stewardship-receipt/v1", actionId, outcome, observedAt: at,
    observationSha256: after ? store.archive(after) : null, nativeEventIds: events ?? [], sourceDrift });
  store.append({ type: "action-outcome", actionId, outcome, receiptSha256, nativeEventIds: events ?? [] }, at);
  if (outcome === "confirmed" && after) {
    // Cross-epoch recovery retains the receipt but cannot admit old-policy evidence into the current epoch.
    if (!recovery || after.evidence.policySha256 === store.state.policySha256) archiveObservation(store, after, at);
    if (operation.kind !== "append_comment") {
      const field = stewardshipOperationField(operation)!;
      store.append({ type: "field-observed", issueNumber: authority.decision.issueNumber, field,
        value: stewardshipOperationValue(operation), frontier: after.evidence.packet.fieldHistory[field]!.frontier,
        materialEvidenceSha256: after.evidence.packet.materialEvidenceSha256, actor: "self", actionId }, at);
    }
  }
  return { outcome, sourceDrift };
}

/** Run under the cycle's existing exclusive store lock. Failures quarantine only the affected issue. */
export async function executeStewardshipDecisions(options: StewardshipExecutionOptions): Promise<StewardshipExecutionResult[]> {
  const results: StewardshipExecutionResult[] = []; const policy = parseStewardshipPolicy(options.policy);
  requireCondition(!isSnapshotStewardshipPolicy(policy), "approved_snapshot_required");
  // Demotions run first, but capacity is always read live; an unconfirmed demotion never releases a slot.
  const legacyDemotion = (request: (typeof options.requests)[number]) => {
    const assessment = request.assessments[0]?.envelope.assessment;
    return request.evidence.packet.fields.Horizon === "Now" && assessment && "proposed" in assessment && assessment.proposed.Horizon !== "Now";
  };
  const ordered = [...options.requests].sort((a, b) => Number(legacyDemotion(b)) - Number(legacyDemotion(a)));
  for (const request of ordered) {
    const confirmed: string[] = []; let observed: StewardshipObservation | null = null;
    let finalHash: string | null = null; let nextEligibleAt: string | null = null;
    const unresolvedSendReceipts: NonNullable<StewardshipExecutionResult["unresolvedSendReceipts"]>[number][] = [];
    const recordRetry = (error: unknown) => {
      const timestamp = retryTimestamp(error, options.now());
      if (timestamp && (!nextEligibleAt || timestamp > nextEligibleAt)) nextEligibleAt = timestamp;
    };
    const finish = (status: StewardshipExecutionResult["status"], reasons: readonly string[]) => results.push({ issueNumber: request.evidence.packet.issueNumber,
      status: confirmed.length > 0 && status !== "updated" ? "partial" : status, reasons, confirmedActionIds: confirmed,
      finalObservationSha256: finalHash, finalMaterialEvidenceSha256: observed?.evidence.packet.materialEvidenceSha256 ?? null, nextEligibleAt,
      ...(unresolvedSendReceipts.length ? { unresolvedSendReceipts } : {}) });
    try {
      const preview = compileStewardshipDecision({ ...request.previewContext, evidence: request.evidence, assessments: request.assessments,
        policy, now: options.now(), census: request.census ?? { complete: true, nowCount: 0 } });
      requireCondition(same(preview, request.decision), "invalid_decision_preview");
      const unresolvedReason = stewardshipUnresolvedActionReason(options.store.state, request.evidence.packet.issueNumber);
      requireCondition(!unresolvedReason, unresolvedReason ?? "unresolved_action");
      const capacityDeferred = preview.status === "deferred" && same(preview.reasons, ["now_capacity_unavailable"]);
      if ((preview.status === "deferred" && !capacityDeferred) || preview.status === "escalated") { finish(preview.status, preview.reasons); continue; }
      const archived = readArchivedRequest(request, options.store, policy);
      requireCondition(!options.store.state.paused, "paused");
      requireCondition(!Object.values(options.store.state.actions).some((action) => action.issueNumber === preview.issueNumber
        && (action.outcome === null || action.outcome === "unresolved" || action.outcome === "conflict")), "issue_quarantined");
      let authority = compileLocked(archived, options, { complete: true, nowCount: 0 });
      if (authority.decision.status === "deferred" || authority.decision.status === "escalated") { finish(authority.decision.status, authority.decision.reasons); continue; }
      const github = options.createGitHub(); observed = await github.observe(preview.issueNumber); assertObservation(observed, policy);
      requireCondition(observed.evidence.packet.materialEvidenceSha256 === request.evidence.packet.materialEvidenceSha256, "material_evidence_changed");
      finalHash = archiveObservation(options.store, observed, options.now()); detectIntervention(options.store, observed, policy, options.now());
      authority = compileLocked(archived, options, observed.census);
      if (authority.decision.status !== "eligible") { finish(authority.decision.status, authority.decision.reasons); continue; }
      const authoritySha256 = options.store.archive(authority);
      for (const comment of authority.decision.comments) options.store.archive(comment.body);
      for (const supersession of authority.decision.holdSupersessions) options.store.append({ type: "hold-superseded", issueNumber: preview.issueNumber, ...supersession,
        changedFactIds: [...supersession.changedFactIds], assessmentSha256s: [...supersession.assessmentSha256s] }, options.now());
      let stopped = false;
      for (let index = 0; index < authority.decision.operations.length; index++) {
        const operation = stewardshipOperationSchema.parse(authority.decision.operations[index]); const body = operationBody(authority, operation);
        if (operation.kind === "append_comment" && observed.comments.some((comment) => exactComment(comment, body!, policy))) {
          requireCondition(observed.comments.filter((comment) => exactComment(comment, body!, policy)).length === 1, "duplicate_comment_marker"); continue;
        }
        const last = options.store.state.runs[options.runId]?.lastMutationAt;
        if (last) await options.sleep(Math.max(0, Date.parse(last) + policy.limits.mutationIntervalMs - Date.parse(options.now())));
        let actionId: string | null = null; let before = observed; let attemptedAt = options.now();
        let sendReceipt: StewardshipSendReceipt | void = undefined;
        try {
          sendReceipt = await github.send(preview.issueNumber, operation, body, async () => {
            const fresh = await github.observe(preview.issueNumber); assertObservation(fresh, policy);
            requireCondition(sameObservedIssue(observed!, fresh), "pre_send_state_changed");
            const state = options.store.state;
            requireCondition(!state.paused && state.adoptionId === authority.adoptionId && state.policySha256 === authority.compile.evidence.policySha256, "paused_or_policy_changed");
            const run = state.runs[options.runId]; const instant = Date.parse(options.now());
            requireCondition(run && instant >= Date.parse(run.startedAt) && instant < Date.parse(run.startedAt) + policy.limits.runDurationMs
              && instant < Date.parse(authority.compile.now) + policy.limits.executionBindingMs, "execution_expired");
            requireCondition(!state.issues[preview.issueNumber].fields.Priority.hold && !state.issues[preview.issueNumber].fields.Horizon.hold, "issue_held");
            if (operation.kind === "set_horizon" && (operation.value === "Now" || operation.value === "Next")) {
              persistedVerification(authority, fresh, options.now());
              requireCondition(fresh.evidence.packet.issue.relationships.blockedBy.length === 0, "native_blocker");
              if (operation.value === "Now") requireCondition(fresh.evidence.packet.fields.Priority !== null
                && (fresh.evidence.packet.fields.Horizon === "Now" || fresh.census.nowCount < policy.limits.nowCapacity), "now_capacity_unavailable");
            }
            before = fresh; attemptedAt = options.now();
            const proposal = makeProposal(authority, authoritySha256, before, index, attemptedAt);
            const binding: ActionBinding = { schemaVersion: "github-issue-roadmap-stewardship-execution/v1", authoritySha256,
              beforeObservationSha256: options.store.archive(before), operationIndex: index, proposal };
            const bindingSha256 = options.store.archive(binding); const candidateId = proposal.actions[0].actionId;
            options.store.append({ type: "action-attempted", runId: options.runId, actionId: candidateId, issueNumber: preview.issueNumber,
              policySha256: authority.compile.evidence.policySha256, bindingSha256, operation, ...stewardshipDecisionProvenance(authority.decision) }, attemptedAt);
            actionId = candidateId;
            // Pause is an atomic control file independent of this long-lived lock.
            if (options.store.state.paused) {
              options.store.append({ type: "action-outcome", actionId, outcome: "not-applied", receiptSha256: options.store.archive({ reason: "paused_before_send", actionId }) }, options.now());
              actionId = null; throw new Error("paused_before_send");
            }
          });
        } catch (error) {
          recordRetry(error);
          // A never-sent request or explicit server rejection proves this intent was not applied.
          const rejected = error !== null && typeof error === "object" && "definitelyRejected" in error && error.definitelyRejected === true;
          if (actionId && error !== null && typeof error === "object" && (("sent" in error && error.sent === false) || rejected)) {
            options.store.append({ type: "action-outcome", actionId, outcome: "not-applied",
              receiptSha256: options.store.archive({ actionId, reason: rejected ? "transport_proved_rejected" : "transport_proved_not_sent" }) }, options.now());
            actionId = null;
          }
          // Every other thrown write is ambiguous. Readback, never a retry, decides its disposition.
        }
        if (!actionId) { finish("deferred", ["send_admission_refused", ...(nextEligibleAt ? ["retry_after_reset"] : [])]); stopped = true; break; }
        let after: StewardshipObservation | null = null;
        try { after = await github.observe(preview.issueNumber); } catch (error) { recordRetry(error); /* Pending intent survives read failure. */ }
        const { outcome } = recordOutcome(options.store, actionId, before, after, operation, authority, attemptedAt, options.now());
        if (outcome === "unresolved" && sendReceipt) unresolvedSendReceipts.push({ actionId, operationIndex: index, receipt: sendReceipt });
        if (outcome !== "confirmed" || !after) {
          if (after) { try { assertObservation(after, policy); finalHash = archiveObservation(options.store, after, options.now()); observed = after; } catch { /* Preserve the last complete observation. */ } }
          finish("deferred", [outcome]); stopped = true; break;
        }
        confirmed.push(actionId); observed = after; finalHash = options.store.archive(after);
      }
      if (!stopped) finish(confirmed.length > 0 ? "updated" : "no-change", ["all_effects_verified"]);
    } catch (error) {
      recordRetry(error);
      finish("deferred", [error instanceof Error && EXECUTION_REFUSALS.has(error.message) ? error.message : "authority_or_live_state_refused",
        ...(nextEligibleAt ? ["retry_after_reset"] : [])]);
    }
  }
  return results;
}

interface SnapshotBinding {
  schemaVersion: "github-issue-roadmap-snapshot-execution/v1";
  snapshotSha256: string; compileInputsSha256: string; operationIndex: number; beforeObservationSha256: string;
}
interface SnapshotReceipt {
  schemaVersion: "github-issue-roadmap-sorter-receipt/v1";
  actionId: string; issueNumber: number; field: string; operation: StewardshipOperation; snapshotSha256: string;
  outcome: "confirmed" | "not-applied" | "unresolved" | "conflict"; observationSha256: string | null; nativeEventIds: string[]; observedAt: string;
  transportProof?: "sent-false" | "definite-rejection";
  reason?: "paused_before_send";
  lifecycle?: StewardshipLifecycleReceipt;
}

/** Whole-backlog authority. No caller-supplied decision or per-issue ranking grants a write. */
export function executeStewardshipSnapshot(options: SnapshotOptions): Promise<SnapshotResults>;
export function executeStewardshipSnapshot(options: StewardshipRehearsalOptions): Promise<StewardshipRehearsalResult>;
export async function executeStewardshipSnapshot(options: SnapshotOptions | StewardshipRehearsalOptions): Promise<SnapshotResults | StewardshipRehearsalResult> {
  const { store, snapshotSha256 } = options;
  if (options.rehearsal) requireCondition(isStewardshipPreviewStore(store), "rehearsal_requires_preview_store");
  const rateLimitsStart = options.rehearsal?.transport.rateLimits() ?? {};
  // Last compile: 2536/5000 core remaining. Rehearsal costs one live run's reads:
  // at most one rehearsal per reset window alongside a compile; floor is 1500.
  if (options.rehearsal) requireCondition((rateLimitsStart.core?.lastRemaining ?? -1) >= 1500, "rehearsal_core_budget_below_1500");
  const policy = resolveStewardshipPolicy(stewardshipPolicySha256(options.policy), options.policy);
  requireCondition(isSnapshotStewardshipPolicy(policy) && store.state.policySha256 === stewardshipPolicySha256(policy), "policy-upgrade required");
  const approval = store.state.snapshots?.[snapshotSha256];
  requireCondition(approval?.status === "approved", "approved_snapshot_required");
  const read = <T,>(hash: string): T => {
    const value = store.readArtifact(hash);
    requireCondition(canonicalJsonSha256(value) === hash, "snapshot_archive_mismatch"); return value as T;
  };
  const input = read<Parameters<typeof compileStewardshipBacklog>[0]>(approval.compileInputsSha256);
  const snapshot = compileStewardshipBacklog(input);
  requireCondition(snapshot.snapshotSha256 === snapshotSha256 && snapshot.status === "ready"
    && stewardshipPolicySha256(input.policy) === store.state.policySha256, "snapshot_hash_mismatch");
  const operations = stewardshipSnapshotOperations(snapshot);
  requireCondition(same(operations, approval.operations), "snapshot_operations_mismatch");
  const expected = new Map<number, NativeObservation>();
  const confirmed = new Set<number>();
  const notApplied = new Set<number>();
  const outages = new Map<number, string>();
  const rehearsed = new Set<number>();
  let sendCount = 0;
  const classifications: StewardshipSnapshotClassification[] = [];
  let classificationPlan: StewardshipSnapshotClassificationPlan | undefined = undefined;
  const results = new Map<number, StewardshipExecutionResult>();
  let github: StewardshipGitHub | undefined;
  let readPhase: "preflight" | "fence" | "readback" = "preflight";
  const transport = () => options.rehearsal?.transport ?? (github ??= (options as SnapshotOptions).createGitHub());
  const assertRehearsalRateLimit = (error?: unknown) => {
    if (!options.rehearsal) return;
    const failure = error as { status?: number; cause?: unknown; nextEligibleAt?: string } | undefined;
    const limited = failure?.status === 429 || (failure?.status === 403 && failure.nextEligibleAt)
      || failure?.cause === "rate_limited" || Object.entries(options.rehearsal.transport.rateLimits()).some(([resource, value]) =>
        value.responses429 > (rateLimitsStart[resource]?.responses429 ?? 0)
        || value.retryAfterResponses > (rateLimitsStart[resource]?.retryAfterResponses ?? 0));
    if (limited) throw Object.assign(new Error(`rehearsal_rate_limited: preflight-concurrency=${options.rehearsal.preflightConcurrency ?? 1} (lever b)`),
      { phase: readPhase, rehearsalResult: finishResults("partial") });
  };
  const readOnly = async <T,>(read: () => Promise<T>): Promise<T> => {
    assertRehearsalRateLimit();
    try { const value = await read(); assertRehearsalRateLimit(); return value; }
    catch (error) { assertRehearsalRateLimit(error); throw error; }
  };
  const deadline = () => Date.parse(options.now()) >= Date.parse(store.state.runs[options.runId].startedAt) + policy.limits.runDurationMs;
  const stateOf = (index: number): StewardshipSnapshotOpState => {
    if (rehearsed.has(index)) return "R";
    if (confirmed.has(index)) return "C";
    if (notApplied.has(index)) return "N";
    if (store.state.snapshots![snapshotSha256].skips?.[index]) return "S";
    const entry = operations[index];
    const action = Object.values(store.state.actions).find((action) => action.snapshotSha256 === snapshotSha256
      && action.issueNumber === entry.issueNumber && same(action.operation, entry.operation));
    return !action ? "P" : action.outcome === null ? "A" : action.outcome === "confirmed" ? "C"
      : action.outcome === "not-applied" ? "N" : action.outcome;
  };
  const assertJournal = (condition: StewardshipSnapshotCondition, state: StewardshipSnapshotOpState) => {
    try { void store.state; }
    catch (error) {
      classifyStewardshipSnapshotTransition({ ...condition, state, journalUsable: false, lockValid: false });
      throw error; // No result artifact or event may be written after ownership/journal loss.
    }
  };
  const transition = (condition: StewardshipSnapshotCondition, state: StewardshipSnapshotOpState) => {
    assertJournal(condition, state);
    return classifyStewardshipSnapshotTransition({ ...condition, state, journalUsable: true, lockValid: true });
  };
  const assertAfterAttemptOwnership = () => assertJournal({ point: "after-attempt", condition: "lock-lost" }, "A");
  const result = (number: number) => {
    let value = results.get(number);
    if (!value) { value = { issueNumber: number, status: "no-change", reasons: [], confirmedActionIds: [], finalObservationSha256: null,
      finalMaterialEvidenceSha256: null, nextEligibleAt: null }; results.set(number, value); }
    return value;
  };
  const finishResults = (runResult: StewardshipSnapshotTransition["runResult"]): SnapshotResults | StewardshipRehearsalResult => {
    const current = store.state.snapshots![snapshotSha256];
    for (const [index, entry] of operations.entries()) {
      if (current.skips?.[index] || notApplied.has(index) || outages.has(index)) result(entry.issueNumber);
    }
    const values: SnapshotResults = [...results.values()].map((entry) => {
      const indices = operations.flatMap((op, index) => op.issueNumber === entry.issueNumber ? [index] : []);
      const skips = indices.filter((index) => current.skips?.[index]);
      const unapplied = indices.filter((index) => stateOf(index) === "N");
      return { ...entry, ...(skips.length || unapplied.length ? {
        status: entry.confirmedActionIds.length ? "partial" as const : "deferred" as const,
        reasons: entry.reasons.length && entry.reasons[0] !== "all_effects_verified" ? entry.reasons
          : [...new Set([...skips.map((index) => current.skips![index].reason), ...(unapplied.length ? ["transport_proved_not_applied"] : [])])],
      } : {}), snapshot: {
        directSkippedIndices: skips.filter((index) => current.directSkipIndices?.includes(index)),
        propagatedSkippedIndices: skips.filter((index) => current.skips![index].phase === "classification" && !current.directSkipIndices?.includes(index)),
        sendSkippedIndices: skips.filter((index) => current.skips![index].phase === "send"),
        outageIndices: indices.filter((index) => outages.has(index)), notAppliedIndices: unapplied,
        skips: skips.map((index) => ({ index, reason: current.skips![index].reason })),
      } };
    });
    const count = (key: "directSkippedIndices" | "propagatedSkippedIndices" | "sendSkippedIndices" | "outageIndices" | "notAppliedIndices") =>
      values.reduce((total, entry) => total + entry.snapshot![key].length, 0);
    const summary: StewardshipSnapshotExecutionSummary = { thresholdNumerator: classificationPlan?.thresholdNumerator ?? current.directSkipIndices?.length ?? 0,
      thresholdDenominator: operations.length, partialStop: classificationPlan?.partialStop ?? outages.size > 0, issueCount: new Set(operations.map((entry) => entry.issueNumber)).size,
      directSkips: count("directSkippedIndices"), propagatedSkips: count("propagatedSkippedIndices"), sendSkips: count("sendSkippedIndices"),
      outages: count("outageIndices"), notApplied: count("notAppliedIndices"), runResult };
    if (options.rehearsal) return { schemaVersion: "github-issue-roadmap-rehearsal/v1", rehearsal: true, sendCount, summary: { ...summary, partialStop: summary.partialStop || outages.size > 0 || runResult === "partial" }, plan: classificationPlan ?? null, classifications,
      dispositions: operations.map((entry, index) => ({ index, issueNumber: entry.issueNumber,
        disposition: rehearsed.has(index) ? "R" : new Map(Object.entries(current.skips ?? {})).has(String(index)) ? "skip" : outages.has(index) ? "outage"
          : confirmed.has(index) ? "prior-confirmed" : notApplied.has(index) ? "prior-not-applied" : "pending" })),
      phaseTiming: options.phaseTiming?.snapshot().phaseTiming ?? {}, rateLimits: options.rehearsal.transport.rateLimits(), rateLimitsStart };
    Object.defineProperty(values, "summary", { value: summary, enumerable: false });
    // The live wrapper owns the run-finished event and its complete report artifact.
    return values;
  };
  const recordRunEffects = (change: StewardshipSnapshotTransition, failureReason?: string) => {
    if (options.rehearsal) return;
    for (const event of change.events) {
      if (event.type === "snapshot-refused") {
        requireCondition(change.approvalEffect === "replacement-required" || change.approvalEffect === "inhibit", "snapshot_refusal_effect_mismatch");
        store.append({ type: event.type, snapshotSha256, reason: event.reason === "failure" ? failureReason ?? event.reason : event.reason,
          remaining: operations.filter((_, index) => !confirmed.has(index)) }, options.now());
      }
      if (event.type === "snapshot-completed") {
        requireCondition(change.approvalEffect === "completed", "snapshot_completion_effect_mismatch");
        store.append({ type: event.type, snapshotSha256 }, options.now());
      }
      // run-finished includes the caller's complete report, so the live wrapper
      // materializes that descriptor after this invocation returns its runResult.
    }
  };
  const advance = (index: number, actionId: string, after: NativeObservation) => {
    const entry = operations[index]; const field = stewardshipOperationField(entry.operation)!;
    expected.set(entry.issueNumber, after); confirmed.add(index);
    const previous = result(entry.issueNumber);
    results.set(entry.issueNumber, { ...previous, status: "updated", reasons: ["all_effects_verified"],
      confirmedActionIds: [...previous.confirmedActionIds, actionId], finalObservationSha256: store.archive(after),
      finalMaterialEvidenceSha256: after.evidence.packet.materialEvidenceSha256 });
    const current = store.state.issues[entry.issueNumber].fields[field];
    if (!current || !same(current.frontier, after.evidence.packet.fieldHistory[field]!.frontier) || current.value !== stewardshipOperationValue(entry.operation)) {
      store.append({ type: "field-observed", issueNumber: entry.issueNumber, field, value: stewardshipOperationValue(entry.operation),
        frontier: after.evidence.packet.fieldHistory[field]!.frontier, materialEvidenceSha256: after.evidence.packet.materialEvidenceSha256,
        actor: "self", actionId }, options.now());
    }
  };
  const intervention = (index: number, actionId: string, before: NativeObservation, after: NativeObservation, attemptedAt: string) => {
    if (options.rehearsal) return;
    if (store.state.interventions?.some((event) => event.actionId === actionId)) return;
    try { assertObservation(after, policy); } catch { return; }
    const entry = operations[index]; const field = stewardshipOperationField(entry.operation)!; const value = stewardshipOperationValue(entry.operation);
    const previousIds = before.evidence.packet.fieldHistory[field]!.frontier.eventIds;
    const applied = after.evidence.packet.fieldHistory[field]!.events.filter((event) => !previousIds.includes(event.id)
      && event.actorLogin === policy.operator && Date.parse(event.createdAt) >= Math.floor(Date.parse(attemptedAt) / 1000) * 1000
      && (field === "Sort key" ? stewardshipSortKeyMatches(event.values, value, "event") : same(event.values, value === null ? [] : [value]))).at(-1);
    if (applied) {
      let overwrittenValue: string | number | null = applied.previousValues[0] ?? null;
      if (field === "Sort key" && overwrittenValue !== null) {
        const numeric = overwrittenValue.trim() === "" ? Number.NaN : Number(overwrittenValue);
        overwrittenValue = Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : STEWARDSHIP_FOREIGN_SORT_KEY;
      }
      store.append({ type: "snapshot-intervention", snapshotSha256, actionId, issueNumber: entry.issueNumber, field,
        overwrittenValue, nativeEventId: applied.id }, options.now());
    }
  };
  const outcome = (index: number, actionId: string, before: NativeObservation, after: NativeObservation | null, attemptedAt: string,
    proof?: "sent-false" | "definite-rejection", reason?: "paused_before_send") => {
    const entry = operations[index]; let events: string[] | null = null; let complete = false;
    try { if (after) { assertObservation(after, policy); complete = true; events = verifyEffect(before, after, entry.operation, policy, attemptedAt, undefined, true); } }
    catch { /* Uncertain readback never authorizes retry. */ }
    const unchanged = complete && after && sameSnapshotIssue(before, after);
    const change = transition(proof ? { point: "after-attempt", condition: proof } : events !== null
      ? { point: "after-attempt", condition: "verified" } : !complete ? { point: "after-attempt", condition: deadline() ? "deadline" : "incomplete-readback" }
      : unchanged ? { point: "after-attempt", condition: "unchanged", completeReadback: true,
        bindingWindowElapsed: Date.parse(options.now()) >= Date.parse(attemptedAt) + policy.limits.executionBindingMs }
      : { point: "after-attempt", condition: "incompatible-drift" }, stateOf(index));
    const descriptor = change.events.find((event) => event.type === "action-outcome");
    requireCondition(descriptor?.type === "action-outcome", "snapshot_outcome_transition_missing");
    const disposition = descriptor.outcome;
    const receipt: SnapshotReceipt = { schemaVersion: "github-issue-roadmap-sorter-receipt/v1", actionId, issueNumber: entry.issueNumber,
      field: stewardshipOperationField(entry.operation)!, operation: entry.operation, snapshotSha256, outcome: disposition,
      observationSha256: after ? store.archive(after) : null, nativeEventIds: events ?? [], observedAt: options.now(),
      ...(proof ? { transportProof: proof } : {}), ...(reason ? { reason } : {}) };
    if (receipt.field === "Lifecycle" && disposition === "confirmed" && after && events) {
      receipt.lifecycle = createStewardshipLifecycleReceipt({ issueNumber: entry.issueNumber, snapshotSha256,
        // This receipt helper consumes evidence only; no census is added to the archived target observation.
        compile: input, readArtifact: store.readArtifact, after: after as StewardshipObservation, nativeEventId: events[0], confirmedAt: receipt.observedAt });
    }
    store.append({ type: "action-outcome", actionId, outcome: disposition, receiptSha256: store.archive(receipt), nativeEventIds: events ?? [] }, options.now());
    if (disposition === "conflict" && after) intervention(index, actionId, before, after, attemptedAt);
    if (change.nextState === "C" && after) advance(index, actionId, after);
    if (change.nextState === "N") notApplied.add(index);
    return { disposition, change };
  };
  const driftReasons = new Set(["stale_snapshot", "issue_not_open", "native_blocker_added", "pinned_after_compile", "sensitive_demotion_requires_counterevidence"]);
  const refuse = (number: number, reason: string, error: unknown, change: StewardshipSnapshotTransition) => {
    const previous = result(number);
    results.set(number, { ...previous, status: previous.confirmedActionIds.length ? "partial" : "deferred", reasons: [reason], nextEligibleAt: retryTimestamp(error, options.now()) });
    recordRunEffects(change, reason);
    return finishResults(change.runResult);
  };
  for (const entry of operations) {
    const observation = input.observations?.[entry.issueNumber];
    requireCondition(observation, "snapshot_observation_missing"); assertNativeObservation(observation, policy);
    expected.set(entry.issueNumber, observation);
  }
  // Replay confirmed receipts first, in operation order, so every refusal excludes prior confirmations.
  // An interrupted ambiguous send is observed once and is never resent.
  for (const confirmedPass of [true, false]) for (let index = 0; index < operations.length; index++) {
    const entry = operations[index];
    const actions = Object.entries(store.state.actions).filter(([, action]) => action.snapshotSha256 === snapshotSha256
      && action.issueNumber === entry.issueNumber && same(action.operation, entry.operation) && (action.outcome !== "not-applied"
        || (store.readArtifact(action.receiptSha256!) as { schemaVersion?: string }).schemaVersion === "github-issue-roadmap-sorter-receipt/v1"));
    requireCondition(actions.length <= 1, "snapshot_duplicate_action");
    if (!actions.length) continue;
    const [actionId, action] = actions[0];
    if ((action.outcome === "confirmed") !== confirmedPass) continue;
    const binding = read<SnapshotBinding>(action.bindingSha256);
    requireCondition(binding.schemaVersion === "github-issue-roadmap-snapshot-execution/v1" && binding.snapshotSha256 === snapshotSha256
      && binding.compileInputsSha256 === approval.compileInputsSha256 && binding.operationIndex === index && action.policySha256 === store.state.policySha256, "snapshot_action_binding_mismatch");
    const before = read<StewardshipObservation>(binding.beforeObservationSha256);
    requireCondition(sameSnapshotIssue(before, expected.get(entry.issueNumber)!), "snapshot_receipt_chain_mismatch");
    if (action.outcome === "confirmed") {
      const receipt = read<SnapshotReceipt>(action.receiptSha256!);
      requireCondition(receipt.schemaVersion === "github-issue-roadmap-sorter-receipt/v1" && receipt.actionId === actionId
        && receipt.issueNumber === entry.issueNumber && receipt.snapshotSha256 === snapshotSha256 && receipt.field === stewardshipOperationField(entry.operation)
        && same(receipt.operation, entry.operation) && receipt.outcome === "confirmed" && receipt.observationSha256, "snapshot_receipt_mismatch");
      const after = read<StewardshipObservation>(receipt.observationSha256);
      const events = verifyEffect(before, after, entry.operation, policy, action.attemptedAt, undefined, true);
      requireCondition(events !== null && same(events, receipt.nativeEventIds) && same(events, action.nativeEventIds), "snapshot_receipt_unverified");
      advance(index, actionId, after);
    } else if (action.outcome !== null) {
      if (action.outcome === "not-applied") {
        const receipt = read<SnapshotReceipt>(action.receiptSha256!);
        requireCondition(receipt.schemaVersion === "github-issue-roadmap-sorter-receipt/v1" && receipt.actionId === actionId
          && receipt.issueNumber === entry.issueNumber && receipt.snapshotSha256 === snapshotSha256 && receipt.field === stewardshipOperationField(entry.operation)
          && same(receipt.operation, entry.operation) && receipt.outcome === "not-applied", "snapshot_receipt_mismatch");
        if (receipt.transportProof === "sent-false" && !receipt.reason) {
          requireCondition(receipt.observationSha256 === null && receipt.nativeEventIds.length === 0 && action.nativeEventIds.length === 0, "snapshot_receipt_mismatch");
          notApplied.add(index); continue;
        }
      }
      if (action.outcome === "conflict") {
        const receipt = read<SnapshotReceipt>(action.receiptSha256!);
        if (receipt.observationSha256) intervention(index, actionId, before, read<StewardshipObservation>(receipt.observationSha256), action.attemptedAt);
      }
      return refuse(entry.issueNumber, action.outcome, undefined, transition({ point: "before-classification", condition: "invalid-basis" }, stateOf(index)));
    } else {
      let after: StewardshipObservation | null = null;
      readPhase = "readback";
      try { after = await timeStewardshipAsync(options.phaseTiming, "readback", () => readOnly(() => transport().observe(entry.issueNumber))); }
      catch (error) { if (options.rehearsal && error instanceof Error && error.message.startsWith("rehearsal_rate_limited")) throw error; /* Keep uncertainty in the receipt. */ }
      const { disposition: status, change } = outcome(index, actionId, before, after, action.attemptedAt);
      if (status !== "confirmed") {
        return refuse(entry.issueNumber, status, undefined, change);
      }
    }
  }
  requireCondition(typeof transport().observeMany === "function" && typeof transport().observeTarget === "function", "snapshot_observation_capabilities_required");
  const fence = (index: number, fresh: NativeObservation) => {
    const entry = operations[index]; const number = entry.issueNumber; const before = expected.get(number)!;
    requireCondition(fresh.evidence.packet.issue.v1.state === "OPEN", "issue_not_open");
    const oldBlockers = before.evidence.packet.issue.relationships.blockedBy;
    requireCondition(!fresh.evidence.packet.issue.relationships.blockedBy.some((link) => link.state === "OPEN"
      && link.repository.nodeId === fresh.evidence.packet.issue.identity.repository.nodeId
      && !oldBlockers.some((old) => old.nodeId === link.nodeId && old.state === "OPEN")), "native_blocker_added");
    assertObservation(fresh, policy);
    if (!sameSnapshotIssue(before, fresh)) {
      if (!options.rehearsal) detectIntervention(store, fresh, policy, options.now());
      throw new Error("stale_snapshot");
    }
    timeStewardshipSync(options.phaseTiming, "fence.local", () => {
      const state = store.state; requireCondition(!state.paused, "paused");
      requireCondition(state.policySha256 === stewardshipPolicySha256(policy), "policy_changed");
      const field = stewardshipOperationField(entry.operation)!;
      if (entry.operation.kind === "set_lifecycle") for (const name of ["Horizon", "Effort"] as const) {
        requireCondition(state.issues[number].fields[name]?.hold?.kind !== "pin", "pinned_after_compile");
      }
      for (const name of field === "Priority" ? STEWARDSHIP_NATIVE_FIELDS : [field]) {
        const hold = state.issues[number].fields[name]?.hold;
        const pin = name === "Horizon" || name === "Effort" ? input.projection.issues[number].pins[name] : null;
        // Lifecycle clears are unconditional after reopen/pin/P0; hand-set flags are governed by R15.
        if (name === "Lifecycle" && entry.operation.kind === "clear_lifecycle") continue;
        requireCondition(!hold || (name !== field && pin && pin.value === hold.value && pin.at === hold.at), "pinned_after_compile");
      }
      requireCondition(!stewardshipUnresolvedActionReason(state, number, snapshotSha256), "unresolved_action");
      const assessment = input.projection.issues[number].assessment;
      const prior = before.evidence.packet.fields.Priority;
      if (field === "Priority" && (prior === "P0" || prior === "P1")
        && (stewardshipOperationValue(entry.operation) === null || stewardshipOperationValue(entry.operation)! > prior)) {
        requireCondition(assessment?.assessments.length === 2 && assessment.assessments.every(({ assessment: value }) => value.demotion
          && value.demotion.evidenceIds.length > 0 && value.demotion.evidenceIds.every((id) => value.counterevidenceIds.includes(id))), "sensitive_demotion_requires_counterevidence");
      }
      if (field === "Priority") requireCondition(assessment?.phase === "expanded" && assessment.phaseBVerified, "severity_requires_code");
    });
    expected.set(number, fresh);
    return fresh;
  };
  const pending = operations.map((_, index) => index).filter((index) => stateOf(index) === "P");
  const reasonOf = (error: unknown) => wide(error) && error && typeof error === "object" && "code" in error
    ? String(error.code) : error instanceof Error ? error.message : "observation_failed";
  const wide = (error: unknown) => error !== null && typeof error === "object"
    && (("snapshotWide" in error && error.snapshotWide === true) || (!("targetScoped" in error && error.targetScoped === true)
      && "code" in error && ["stale_pin", "invalid_evidence"].includes(String(error.code))));
  const stop = (index: number, reason: string, condition: StewardshipSnapshotCondition, error?: unknown) => {
    if (options.rehearsal && reason.startsWith("rehearsal_rate_limited")) throw error ?? new Error(reason);
    const change = transition(condition, operations[index] ? stateOf(index) : "C");
    const number = operations[index]?.issueNumber;
    if (number !== undefined) {
      const previous = result(number);
      results.set(number, { ...previous, status: previous.confirmedActionIds.length ? "partial" : "deferred",
        reasons: reason === "threshold-exceeded" && previous.reasons.length ? previous.reasons : [reason], nextEligibleAt: retryTimestamp(error, options.now()) });
    }
    recordRunEffects(change, reason);
    return finishResults(change.runResult);
  };
  const target = async (number: number, readback = false) => {
    readPhase = readback ? "readback" : "fence";
    let observation = await readOnly(() => transport().observeTarget!(number, readback ? { readback: true } : undefined));
    requireCondition(observation.issueNumber === number, "target_observation_identity_mismatch");
    if (observation.status === "unstable") observation = await readOnly(() => transport().observeTarget!(number, readback ? { readback: true } : undefined));
    requireCondition(observation.issueNumber === number, "target_observation_identity_mismatch");
    if (observation.status !== "ok") throw Object.assign(new Error(observation.status === "absent" ? "issue_not_open" : "target-unavailable"),
      { nextEligibleAt: "nextEligibleAt" in observation ? observation.nextEligibleAt : null });
    try { assertObservation(observation, policy); }
    catch (error) { throw Object.assign(new Error(reasonOf(error)), { targetScoped: true }); }
    return observation;
  };
  if (pending.length && deadline()) return stop(pending[0], "run_deadline", { point: "before-classification", condition: "deadline" });
  const observationSha256s: string[] = [];
  const evidencePhases = new Map<string, number[]>();
  for (const index of pending) {
    const number = operations[index].issueNumber;
    const phase = expected.get(number)!.evidence.packet.evidencePhase;
    const numbers = evidencePhases.get(phase) ?? [];
    if (!numbers.includes(number)) numbers.push(number);
    evidencePhases.set(phase, numbers);
  }
  const chunks = [...evidencePhases.values()].flatMap((numbers) => Array.from({ length: Math.ceil(numbers.length / 12) },
    (_, index) => numbers.slice(index * 12, index * 12 + 12)));
  readPhase = "preflight";
  const preflight = (chunk: number[]) => timeStewardshipAsync(options.phaseTiming, "fence.observe", () =>
    timeStewardshipAsync(options.phaseTiming, "fence.observe.preflight", () => readOnly(() => transport().observeMany!(chunk))));
  let batch: PromiseSettledResult<readonly StewardshipBatchObservation[]>[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const indices = pending.filter((index) => chunk.includes(operations[index].issueNumber));
    if (deadline()) return stop(indices[0], "run_deadline", { point: "classification", condition: "deadline" });
    let observations: readonly StewardshipBatchObservation[];
    try {
      if (options.rehearsal?.preflightConcurrency === 2) {
        if (chunkIndex % 2 === 0) batch = await Promise.allSettled(chunks.slice(chunkIndex, chunkIndex + 2).map(preflight));
        assertRehearsalRateLimit();
        const limited = batch.find((entry) => entry.status === "rejected" && entry.reason instanceof Error
          && entry.reason.message.startsWith("rehearsal_rate_limited"));
        if (limited?.status === "rejected") throw limited.reason;
        const entry = batch[chunkIndex % 2];
        if (entry.status === "rejected") throw entry.reason;
        observations = entry.value;
      } else observations = await preflight(chunk);
    } catch (error) {
      if (options.rehearsal) for (const index of indices) {
        outages.set(index, reasonOf(error)); classifications.push({ index, disposition: "outage", reason: "target-unavailable" });
      }
      assertJournal({ point: "classification", condition: "snapshot-failure" }, "P");
      return stop(indices[0], reasonOf(error), { point: "classification", condition: deadline() ? "deadline"
        : wide(error) ? "snapshot-failure" : error && typeof error === "object" && "code" in error && error.code === "mixed_generation"
          ? "mixed-generation-exhausted" : "target-unavailable" }, error);
    }
    assertJournal({ point: "classification", condition: "snapshot-failure" }, "P");
    if (deadline()) return stop(indices[0], "run_deadline", { point: "classification", condition: "deadline" });
    for (const number of chunk) {
      const matches = observations.filter((entry) => entry.issueNumber === number);
      let observation: StewardshipBatchObservation = matches.length === 1 ? matches[0] : { issueNumber: number, status: "unavailable" };
      if (observation.status === "unstable") {
        try {
          const retry = await readOnly(() => transport().observeMany!([number]));
          observation = retry.length === 1 && retry[0].issueNumber === number ? retry[0] : { issueNumber: number, status: "unavailable" };
        } catch (error) {
          if (options.rehearsal && error instanceof Error && error.message.startsWith("rehearsal_rate_limited")) throw error;
          if (wide(error)) return stop(indices[0], reasonOf(error), { point: "classification", condition: "snapshot-failure" }, error);
          observation = { issueNumber: number, status: "unavailable" };
        }
      }
      if (deadline()) return stop(indices[0], "run_deadline", { point: "classification", condition: "deadline" });
      if (observation.status === "ok") observationSha256s.push(store.archive(observation));
      for (const index of indices.filter((index) => operations[index].issueNumber === number)) {
        let reason: string | undefined;
        if (observation.status === "absent") reason = "issue_not_open";
        else if (observation.status !== "ok") reason = "target-unavailable";
        else {
          // Evidence invalidity is an outage of this target, not established drift.
          try { assertObservation(observation, policy); }
          catch (error) { reason = reasonOf(error); outages.set(index, reason); }
          if (!reason) try { fence(index, observation); }
          catch (error) {
            reason = reasonOf(error);
            if (!driftReasons.has(reason)) return stop(index, reason, { point: "classification", condition: "snapshot-failure" }, error);
          }
        }
        if (reason && driftReasons.has(reason)) {
          transition({ point: "classification", condition: "target-drift-or-absence" }, stateOf(index));
          classifications.push({ index, disposition: "skip", reason });
        } else if (reason) {
          transition({ point: "classification", condition: "target-unavailable" }, stateOf(index));
          outages.set(index, reason); classifications.push({ index, disposition: "outage", reason: "target-unavailable" });
          results.set(number, { ...result(number), status: "deferred", reasons: [reason], nextEligibleAt: retryTimestamp(observation, options.now()) });
        } else {
          transition({ point: "classification", condition: "read-recovered" }, stateOf(index));
          classifications.push({ index, disposition: "send" });
        }
      }
    }
  }
  const approvedOps = operations.map((entry, index) => ({ index, issueNumber: entry.issueNumber, state: stateOf(index),
    dependencyIndices: operations.flatMap((other, dependencyIndex) => other.operation.kind === "clear_lifecycle" && entry.operation.kind !== "clear_lifecycle"
      && (other.issueNumber === entry.issueNumber || expected.get(entry.issueNumber)!.evidence.packet.issue.relationships.blockedBy
        .some((blocker) => blocker.number === other.issueNumber
          && blocker.repository.nodeId === expected.get(other.issueNumber)!.evidence.packet.issue.identity.repository.nodeId)) ? [dependencyIndex] : []),
  }));
  classificationPlan = planStewardshipSnapshotClassification({ approvedOps, approvedOpCount: operations.length, classifications,
    classificationSkippedIndices: new Set(store.state.snapshots![snapshotSha256].directSkipIndices ?? []) });
  const plan = classificationPlan;
  requireCondition(!classifications.some((entry) => entry.disposition === "outage") || plan.partialStop, "snapshot_outage_requires_partial_stop");
  for (const index of [...outages.keys()]) if (!plan.outageIndices.includes(index)) outages.delete(index);
  if (plan.scheduleErrors.length) return stop(pending[0], "infeasible-schedule", { point: "classification-complete", condition: "infeasible-schedule" });
  const skippedIssues = [...new Set(plan.skipped.map(({ index }) => operations[index].issueNumber))];
  const complete = operations.length ? transition({ point: "classification-complete", condition: "feasible",
    issueNumber: operations[0].issueNumber, issueOrder: plan.issueOrder, skippedIssueNumbers: skippedIssues }, stateOf(0)) : undefined;
  if (complete?.events.some((event) => event.type === "snapshot-plan") && !store.state.snapshots![snapshotSha256].plans?.[options.runId]) {
    store.append({ type: "snapshot-plan", runId: options.runId, snapshotSha256, compileInputsSha256: approval.compileInputsSha256,
      operations: classifications.map((entry) => ({ index: entry.index, classification: entry.disposition,
        ...("reason" in entry ? { reason: entry.reason } : {}), dependencyIndices: approvedOps[entry.index].dependencyIndices })),
      observationSha256s, thresholdNumerator: plan.thresholdNumerator, thresholdDenominator: plan.thresholdDenominator }, options.now());
  }
  const skipIssue = (number: number, phase: "classification" | "send", indices: number[], reason: string, causalIndices: number[] = []) => {
    const actions = Object.entries(store.state.actions).filter(([, action]) => action.snapshotSha256 === snapshotSha256 && action.issueNumber === number);
    const currentPlan = store.state.snapshots![snapshotSha256].plans![options.runId];
    const directIndices = phase === "send" ? [] : currentPlan.operations.filter((entry) => entry.classification === "skip"
      && operations[entry.index].issueNumber === number).map((entry) => entry.index);
    store.append({ type: "snapshot-issue-skip", runId: options.runId, snapshotSha256, compileInputsSha256: approval.compileInputsSha256,
      issueNumber: number, phase, skippedIndices: indices, directIndices, causalIndices, reason: reason.slice(0, 256),
      confirmedActionIds: actions.filter(([, action]) => action.outcome === "confirmed").map(([id]) => id),
      unresolvedActionIds: actions.filter(([, action]) => action.outcome === null || action.outcome === "unresolved" || action.outcome === "conflict").map(([id]) => id) }, options.now());
    const previous = result(number);
    results.set(number, { ...previous, status: previous.confirmedActionIds.length ? "partial" : "deferred", reasons: [reason] });
  };
  for (const event of complete?.events ?? []) if (event.type === "snapshot-issue-skip" && event.issueNumber !== undefined) {
    const skipped = plan.skipped.filter(({ index }) => operations[index].issueNumber === event.issueNumber);
    const direct = classifications.find((entry) => entry.disposition === "skip" && operations[entry.index].issueNumber === event.issueNumber);
    if (skipped.some(({ index }) => stateOf(index) === "P")) skipIssue(event.issueNumber, "classification", skipped.map(({ index }) => index),
      direct && "reason" in direct ? direct.reason : skipped[0].reasons.join("; "));
  }
  if (plan.refuse) return stop(plan.classificationSkippedIndices[0], "threshold-exceeded", { point: "classification-complete", condition: "threshold-exceeded" });
  if (plan.partialStop) return finishResults(transition({ point: "classification", condition: "target-unavailable" }, "P").runResult);
  if (complete) requireCondition(complete.runResult === "enter-sends" && complete.approvalEffect === "retain", "snapshot_send_transition_missing");
  const sendSkip = (index: number, reason: string, causalIndex = index) => {
    const change = transition({ point: "before-attempt", condition: "target-fence-failed" }, stateOf(index));
    requireCondition(change.nextState === "S" && change.approvalEffect === "retain" && change.runResult === "continue-independent-work"
      && change.events.some((event) => event.type === "snapshot-issue-skip"), "snapshot_skip_transition_missing");
    const skip = new Set<number>(); const skippedNumbers = new Set([operations[index].issueNumber]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const op of approvedOps) if (stateOf(op.index) === "P" && !skip.has(op.index)
        && (skippedNumbers.has(op.issueNumber) || op.dependencyIndices.some((dependency) => skip.has(dependency)))) {
        skip.add(op.index); skippedNumbers.add(op.issueNumber); changed = true;
      }
    }
    for (const number of plan.issueOrder.filter((number) => skippedNumbers.has(number))) {
      const indices = operations.flatMap((entry, index) => entry.issueNumber === number && (skip.has(index) || stateOf(index) === "S") ? [index] : []);
      if (indices.length) skipIssue(number, "send", indices, number === operations[index].issueNumber && causalIndex === index
        ? reason : `Dependency op ${causalIndex}: ${reason}`, [causalIndex]);
    }
  };
  for (const number of plan.issueOrder) for (const index of pending.filter((index) => operations[index].issueNumber === number)) {
    if (stateOf(index) !== "P") continue;
    const prerequisite = approvedOps[index].dependencyIndices.find((dependency) => ["S", "N"].includes(stateOf(dependency)))
      ?? operations.findIndex((entry, sibling) => entry.issueNumber === number && stateOf(sibling) === "N");
    if (prerequisite >= 0) {
      sendSkip(index, stateOf(prerequisite) === "S" ? "prerequisite_skipped" : "prerequisite_not_applied", prerequisite); continue;
    }
    const assertPlannedSend = () => requireCondition(store.state.snapshots![snapshotSha256].plans?.[options.runId]?.operations
      .some((entry) => entry.index === index && entry.classification === "send"), "snapshot_send_requires_plan_classification");
    assertPlannedSend();
    const run = store.state.runs[options.runId];
    if (deadline() || run.remoteMutations >= policy.limits.remoteMutations
      || (!run.mutatedIssues.includes(number) && run.mutatedIssues.length >= policy.limits.changedIssues)) {
      return stop(index, "run_budget", { point: "before-attempt", condition: "deadline" });
    }
    if (options.rehearsal) {
      let fenced = false;
      let before = expected.get(number)!;
      try {
        await timeStewardshipAsync(options.phaseTiming, "send", () => timeStewardshipAsync(options.phaseTiming, "fence.observe", () =>
          timeStewardshipAsync(options.phaseTiming, "fence.observe.send", async () => {
            before = fence(index, await target(number));
            if (deadline()) throw new Error("run_deadline");
            assertPlannedSend();
            const beforeObservationSha256 = store.archive(before);
            store.archive({ schemaVersion: "github-issue-roadmap-rehearsal/v1", rehearsal: true,
              snapshotSha256, compileInputsSha256: approval.compileInputsSha256, operationIndex: index, beforeObservationSha256 });
          })));
        fenced = true;
        sendCount++;
        const after = await timeStewardshipAsync(options.phaseTiming, "readback", () => target(number, true));
        const observationSha256 = store.archive(after);
        store.archive({ schemaVersion: "github-issue-roadmap-rehearsal/v1", rehearsal: true, snapshotSha256,
          issueNumber: number, operation: operations.at(index)!.operation, observationSha256, observedAt: options.now() });
        store.archive(after);
        const change = transition({ point: "rehearsal", condition: "rehearsed" }, stateOf(index));
        requireCondition(change.nextState === "R" && change.events.length === 0 && change.approvalEffect === "none", "rehearsal_transition_missing");
        rehearsed.add(index);
      } catch (error) {
        const reason = reasonOf(error);
        if (!fenced && driftReasons.has(reason)) { sendSkip(index, reason); continue; }
        outages.set(index, reason);
        return stop(index, reason, { point: "before-attempt", condition: deadline() ? "deadline" : "target-unavailable" }, error);
      }
      continue;
    }
    const entry = operations[index]; let actionId: string | null = null; let before = expected.get(entry.issueNumber)!; let attemptedAt = options.now();
    const last = store.state.runs[options.runId]?.lastMutationAt;
    if (last) await options.sleep(Math.max(0, Date.parse(last) + policy.limits.mutationIntervalMs - Date.parse(options.now())));
    let failure: unknown;
    let sendReceipt: StewardshipSendReceipt | void = undefined;
    const admission: { phase: "transport" | "fence" | "journal" } = { phase: "transport" };
    try {
      sendReceipt = await timeStewardshipAsync(options.phaseTiming, "send", () => (github ??= options.createGitHub()).send(entry.issueNumber, entry.operation, undefined, async () => {
        admission.phase = "fence";
        before = fence(index, await timeStewardshipAsync(options.phaseTiming, "fence.observe", () =>
          timeStewardshipAsync(options.phaseTiming, "fence.observe.send", () => target(entry.issueNumber)))); attemptedAt = options.now();
        if (deadline()) throw new Error("run_deadline");
        admission.phase = "journal";
        assertPlannedSend();
        const admitted = transition({ point: "attempt", condition: "admitted" }, stateOf(index));
        requireCondition(admitted.nextState === "A" && admitted.approvalEffect === "retain" && admitted.runResult === "perform-transport-attempt"
          && admitted.events.some((event) => event.type === "action-attempted"), "snapshot_attempt_transition_missing");
        const binding: SnapshotBinding = { schemaVersion: "github-issue-roadmap-snapshot-execution/v1", snapshotSha256,
          compileInputsSha256: approval.compileInputsSha256, operationIndex: index, beforeObservationSha256: store.archive(before) };
        const candidateId = `snapshot-${canonicalJsonSha256({ snapshotSha256, index, runId: options.runId, sequence: store.state.sequence })}`;
        store.append({ type: "action-attempted", runId: options.runId, actionId: candidateId, issueNumber: entry.issueNumber,
          policySha256: stewardshipPolicySha256(policy), bindingSha256: store.archive(binding), operation: entry.operation, snapshotSha256 }, attemptedAt);
        actionId = candidateId;
        if (store.state.paused) throw Object.assign(new Error("paused"), { paused: true, sent: false });
      }));
    } catch (error) { failure = error; }
    if (!actionId) {
      assertJournal({ point: "before-attempt", condition: "global-failure" }, "P");
      const reason = reasonOf(failure);
      if (reason.startsWith("Illegal snapshot transition")) throw failure;
      if (driftReasons.has(reason)) { sendSkip(index, reason); continue; }
      const globalFailure = admission.phase === "journal" || failure === undefined || wide(failure)
        || (failure && typeof failure === "object" && "definitelyRejected" in failure && failure.definitelyRejected === true)
        || ["paused", "policy_changed", "unresolved_action", "severity_requires_code"].includes(reason);
      return stop(index, reason, { point: "before-attempt", condition: deadline() ? "deadline"
        : globalFailure ? "global-failure" : "target-unavailable" }, failure);
    }
    assertAfterAttemptOwnership();
    if (failure && typeof failure === "object" && (("sent" in failure && failure.sent === false) || ("definitelyRejected" in failure && failure.definitelyRejected === true))) {
      const rejected = "definitelyRejected" in failure && failure.definitelyRejected === true;
      const paused = "paused" in failure && failure.paused === true;
      const { change } = outcome(index, actionId, before, null, attemptedAt, rejected ? "definite-rejection" : "sent-false", paused ? "paused_before_send" : undefined);
      const previous = result(entry.issueNumber);
      results.set(entry.issueNumber, { ...previous, status: previous.confirmedActionIds.length ? "partial" : "deferred", reasons: ["transport_proved_not_applied"], nextEligibleAt: retryTimestamp(failure, options.now()) });
      if (paused) return stop(index, "paused_before_send", { point: "before-attempt", condition: "global-failure" }, failure);
      if (change.runResult === "stop") return refuse(entry.issueNumber, "transport_proved_not_applied", failure, change);
      continue;
    }
    let after: NativeObservation | null = null;
    try { after = await timeStewardshipAsync(options.phaseTiming, "readback", () => target(entry.issueNumber, true)); } catch (error) { failure = error; }
    assertAfterAttemptOwnership();
    const { disposition: status, change } = outcome(index, actionId, before, after, attemptedAt);
    if (status === "unresolved" && sendReceipt) {
      results.set(entry.issueNumber, { ...result(entry.issueNumber),
        unresolvedSendReceipts: [{ actionId, operationIndex: index, receipt: sendReceipt }] });
    }
    if (status !== "confirmed") {
      return refuse(entry.issueNumber, status, failure, change);
    }
    if (deadline() && pending.some((candidate) => stateOf(candidate) === "P")) {
      return stop(index, "run_deadline", { point: "after-confirmation", condition: "deadline-with-work" });
    }
  }
  if (options.rehearsal) return finishResults("continue");
  const allConfirmed = confirmed.size === operations.length;
  const completion = transition({ point: "completion", condition: allConfirmed ? "all-confirmed" : "with-skips" },
    allConfirmed ? "C" : notApplied.size ? "N" : "S");
  recordRunEffects(completion);
  return finishResults(completion.runResult);
}

export interface StewardshipRecoveryResult {
  readonly actionId: string; readonly issueNumber: number; readonly outcome: "confirmed" | "unresolved" | "conflict" | "refused";
  readonly reason?: "unresolved_v1_action" | "legacy_confirmed_action";
  /** A confirmed old native effect is not a fresh decision when repository source moved. */
  readonly sourceDrift: boolean;
  readonly nextEligibleAt: string | null;
}
/** Confirmed comments have no local field projection to repair. Retain their journal, not recurring I/O. */
export function stewardshipRecoveryCandidates(state: StewardshipState) {
  return Object.entries(state.actions).filter(([, action]) => {
    if (action.snapshotSha256) return false; // Snapshot receipts use their own decoder and terminal recovery path.
    if (action.outcome === "not-applied") return false;
    if (action.outcome !== "confirmed") return true;
    if (action.operation.kind === "append_comment") return false;
    const field = stewardshipOperationField(action.operation)!;
    const current = state.issues[action.issueNumber].fields[field];
    return !current || action.nativeEventIds.length === 0 || !action.nativeEventIds.every((id) => current.frontier.eventIds.includes(id)
      || current.lastCompleteFrontier?.eventIds.includes(id));
  });
}
/** Recovery never sends writes and intentionally ignores pause and the expired original run deadline. */
export async function recoverStewardshipActions(options: Pick<StewardshipExecutionOptions, "store" | "policy" | "createGitHub" | "now">): Promise<StewardshipRecoveryResult[]> {
  const results: StewardshipRecoveryResult[] = [];
  for (const [actionId, action] of stewardshipRecoveryCandidates(options.store.state)) {
    if (isLegacyCompilerAction(action)) {
      results.push({ actionId, issueNumber: action.issueNumber, outcome: "refused",
        reason: action.outcome === "confirmed" ? "legacy_confirmed_action" : "unresolved_v1_action", sourceDrift: false, nextEligibleAt: null });
      continue;
    }
    try {
      const binding = options.store.readArtifact(action.bindingSha256) as ActionBinding;
      requireCondition(binding.schemaVersion === "github-issue-roadmap-stewardship-execution/v1", "invalid_execution_binding");
      const authority = options.store.readArtifact(binding.authoritySha256) as Authority;
      const recordedPolicy = resolveStewardshipPolicy(stewardshipPolicySha256(authority.compile.policy), options.policy);
      const recordedPolicySha256 = stewardshipPolicySha256(recordedPolicy);
      // Older in-memory projections can prove only their current epoch; never guess a historical binding.
      requireCondition(recordedPolicySha256 === (action.policySha256 ?? options.store.state.policySha256), "action_policy_binding_mismatch");
      requireCondition(authority.schemaVersion === "github-issue-roadmap-stewardship-authority/v1" && authority.adoptionId === options.store.state.adoptionId
        && !isLegacyCompilerAction(authority.decision) && action.compilerVersion === authority.decision.compilerVersion
        && sameStewardshipSeatFamilies(action.seatFamilies, authority.decision.seatFamilies)
        && same(authority.compile.policy, recordedPolicy) && same(compileStewardshipDecision(authority.compile), authority.decision)
        && authority.decision.status === "eligible", "invalid_original_authority");
      readArchivedRequest({ evidence: authority.compile.evidence, assessments: authority.compile.assessments, decision: authority.decision }, options.store, recordedPolicy);
      const before = options.store.readArtifact(binding.beforeObservationSha256) as StewardshipObservation; assertObservation(before, recordedPolicy);
      validateProposalV2(binding.proposal);
      requireCondition(Number.isSafeInteger(binding.operationIndex) && binding.operationIndex >= 0
        && same(authority.decision.operations[binding.operationIndex], action.operation)
        && same(makeProposal(authority, binding.authoritySha256, before, binding.operationIndex, action.attemptedAt), binding.proposal)
        && binding.proposal.actions[0].actionId === actionId && authority.decision.issueNumber === action.issueNumber, "action_binding_mismatch");
      if (action.outcome === "confirmed") {
        // A crash may occur after outcome fsync but before evidence/field-observed fsync. Repair local state only.
        const receipt = options.store.readArtifact(action.receiptSha256!) as { observationSha256: string; sourceDrift?: boolean };
        const after = options.store.readArtifact(receipt.observationSha256) as StewardshipObservation;
        assertObservation(after, recordedPolicy);
        const nativeEventIds = verifyEffect(before, receipt.sourceDrift ? recoverySourceProjection(before, after) : after, action.operation, recordedPolicy, action.attemptedAt, authority);
        requireCondition(nativeEventIds !== null && same(nativeEventIds, action.nativeEventIds), "invalid_confirmed_receipt");
        // Cross-epoch recovery retains the receipt but cannot admit old-policy evidence into the current epoch.
        if (recordedPolicySha256 === options.store.state.policySha256) archiveObservation(options.store, after, options.now());
        if (action.operation.kind !== "append_comment") {
          const field = stewardshipOperationField(action.operation)!;
          const current = options.store.state.issues[action.issueNumber].fields[field];
          if (current && same(current.frontier.eventIds, before.evidence.packet.fieldHistory[field]!.frontier.eventIds)
            && current.value === before.evidence.packet.fields[field]) options.store.append({ type: "field-observed", issueNumber: action.issueNumber, field,
              value: stewardshipOperationValue(action.operation),
              frontier: after.evidence.packet.fieldHistory[field]!.frontier, materialEvidenceSha256: after.evidence.packet.materialEvidenceSha256,
              actor: "self", actionId }, options.now());
        }
        continue;
      }
      let after: StewardshipObservation | null = null;
      let nextEligibleAt: string | null = null;
      try { after = await options.createGitHub().observe(action.issueNumber); }
      catch (error) { nextEligibleAt = retryTimestamp(error, options.now()); }
      const outcome = recordOutcome(options.store, actionId, before, after, action.operation, authority, action.attemptedAt, options.now(), true);
      results.push({ actionId, issueNumber: action.issueNumber, ...outcome, nextEligibleAt });
      if (nextEligibleAt) break;
    } catch { results.push({ actionId, issueNumber: action.issueNumber, outcome: "unresolved", sourceDrift: false, nextEligibleAt: null }); }
  }
  return results;
}
