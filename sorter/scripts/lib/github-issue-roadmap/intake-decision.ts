import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { isActionKindExecutable, type ActionQualificationContext } from "./action-qualification";
import {
  assessmentStackSha256,
  HORIZON_SUGGESTIONS,
  INTAKE_MATCH_RESULTS,
  intakeAssessmentSha256,
  intakeDispositionSkips,
  type IntakeDispositionSkip,
  type CandidateIntakeAssessment,
  type IntakeAssessment,
  type IntakeMatchResult,
} from "./intake-assessment";
import {
  sourceMarkersMatchLoosely,
  sourceMarkersMatchStrictly,
  type IntakeIssueSnapshot,
  type IntakeSnapshotV1,
} from "./intake-snapshot";
import {
  parseExistenceRecord,
  resolveExistenceEntry,
  type ExistenceRecordV1,
} from "./existence-record";
import { routeExistence, type ExistenceRoutingResult } from "./existence-routing";
import {
  PRODUCER_KINDS,
  PRIORITY_SUGGESTIONS,
  type Confidence,
  type OutcomeCandidate,
  type OutcomeEnvelope,
  type ProducerKind,
} from "./outcome-candidate";
import type { RepositoryIdentityV2 } from "./snapshot-v2";
import type { SourceMarkerV1 } from "./source-marker";
import { outcomeLineage, sourceLineage, type IntakeLineage } from "./intake-lineage";
import { effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-selection";

export const INTAKE_DECISION_SCHEMA = "github-issue-roadmap-intake-decision/v2";
export const INTAKE_CAPABILITY_MANIFEST_SCHEMA = "github-issue-roadmap-intake-capability-manifest/v1";
export const INTAKE_CALIBRATION_CASE_SCHEMA = "github-issue-roadmap-intake-calibration-case/v1";
export const INTAKE_CALIBRATION_CORPUS_SCHEMA = "github-issue-roadmap-intake-calibration-corpus/v1";
// A deliberate compiler policy, independent of capability manifests and measured scores.
// Both observation compilation bases must read the same value; retirement is a decision.
export const CLAUSE_DECOMPOSITION_QUALIFICATION: Readonly<{
  status: "unqualified" | "qualified";
}> = { status: "unqualified" };
export const CLAUSE_MEASUREMENT_BAR = 0.80;
type SatisfiedJudgementPopulation = {
  readonly commit: string;
  readonly candidates: number;
  readonly clauses: number;
  readonly satisfiedClauses: number;
  readonly demonstratedVerdicts: number;
  readonly precision: null | {
    readonly truePositives: number;
    readonly emitted: number;
    readonly interval95: { readonly lower: number; readonly upper: number };
    readonly labeler: string;
    readonly spotCheckSampleSize: number;
  };
};

export const CLAUSE_MEASUREMENT_BASELINE = {
  recall: 0.5625,
  precision: 0.3333,
  partialCandidates: 8,
  expectedClauses: 16,
  emittedClauses: 27,
} as const;

// Regression signal only: never compared with CLAUSE_MEASUREMENT_BAR or read by routing or qualification.
export const SATISFIED_JUDGEMENT_MEASUREMENT: {
  readonly cohort: SatisfiedJudgementPopulation & {
    readonly groups: Readonly<Record<"demonstrated" | "partiallyDemonstrated" | "notDemonstrated", {
      readonly candidates: number;
      readonly clauses: number;
      readonly satisfiedClauses: number;
    }>>;
  };
  readonly census: SatisfiedJudgementPopulation;
} = {
  cohort: {
    commit: "0a3a269eb13fcdd88b3608cfed9af19c6c06589e",
    candidates: 31,
    clauses: 88,
    satisfiedClauses: 0,
    demonstratedVerdicts: 0,
    precision: null,
    groups: {
      demonstrated: { candidates: 3, clauses: 8, satisfiedClauses: 0 },
      partiallyDemonstrated: { candidates: 8, clauses: 27, satisfiedClauses: 0 },
      notDemonstrated: { candidates: 20, clauses: 53, satisfiedClauses: 0 },
    },
  },
  census: {
    commit: "9650609cfad514df9b5d9d0702f57f2ad6557c78",
    candidates: 115,
    clauses: 311,
    satisfiedClauses: 0,
    demonstratedVerdicts: 0,
    precision: null,
  },
};

type PartialExistenceOutcome = {
  readonly reason: string;
  readonly qualification: typeof CLAUSE_DECOMPOSITION_QUALIFICATION.status;
} & ({
  readonly kind: "partial_released_unqualified";
  readonly satisfiedClauses: readonly string[];
} | {
  readonly kind: "partial_held_qualified";
});
// Kept on v2 for compatibility with banked records and consumers that use this historical name.
export const INTAKE_CALIBRATION_SCORING_VERSION_PREVIOUS =
  "github-issue-roadmap-intake-calibration-scoring/v2" as const;
export const INTAKE_CALIBRATION_SCORING_VERSION_EVIDENCE_PROJECTION =
  "github-issue-roadmap-intake-calibration-scoring/v3" as const;
/**
 * v4 marks the projection change that adds SHA-bound existence ground truth, fixture receipts,
 * staleness exclusions and directional false-novel/false-hold scoring. As with v3's assessor body
 * projection, the stack hash does not identify this evidence projection. Bumping here keeps cases
 * scored before and after the gate from pooling:
 * `scoreCalibrationCases` refuses to aggregate across versions.
 */
export const INTAKE_CALIBRATION_SCORING_VERSION =
  "github-issue-roadmap-intake-calibration-scoring/v4" as const;
export type IntakeCalibrationScoringVersion =
  | typeof INTAKE_CALIBRATION_SCORING_VERSION_PREVIOUS
  | typeof INTAKE_CALIBRATION_SCORING_VERSION_EVIDENCE_PROJECTION
  | typeof INTAKE_CALIBRATION_SCORING_VERSION;
/** One list so a future version cannot be added here and silently missed by a validator elsewhere. */
export const INTAKE_CALIBRATION_SCORING_VERSIONS = [
  INTAKE_CALIBRATION_SCORING_VERSION_PREVIOUS,
  INTAKE_CALIBRATION_SCORING_VERSION_EVIDENCE_PROJECTION,
  INTAKE_CALIBRATION_SCORING_VERSION,
] as const;

export const INTAKE_CAPABILITIES = ["create_issue", "append_evidence", "append_evidence_overlap", "close_issue", "close_issue_existence", "set_type", "set_priority", "set_effort"] as const;
export type IntakeCapability = typeof INTAKE_CAPABILITIES[number];
export const AUTHORITY_DISPOSITIONS = [
  "automatic_safe",
  "approval_required",
  "hold_no_write",
  "recommendation_only",
] as const;
export type AuthorityDisposition = typeof AUTHORITY_DISPOSITIONS[number];
export type IntakeActionKind =
  | "replay_no_op" | "create_issue" | "append_evidence" | "close_issue" | "set_type" | "set_priority" | "set_effort"
  | "append_evidence_overlap" | "close_issue_existence"
  | "set_horizon" | "add_relationship" | "change_relationship" | "reopen_issue" | "hold_overlap" | "hold_invalid";

export const INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1 =
  "github-issue-roadmap-observation-operands/v1" as const;
export const INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION =
  "github-issue-roadmap-observation-operands/v3" as const;
export const INTAKE_OBSERVATION_PROPOSED_VALUES = [
  ...PRIORITY_SUGGESTIONS,
  ...HORIZON_SUGGESTIONS,
] as const;
export type IntakeObservationProposedValue = typeof INTAKE_OBSERVATION_PROPOSED_VALUES[number] | null;

type PersistedIntakeActionKind = Exclude<IntakeActionKind, "close_issue">;
type PersistedIntakeCapability = Exclude<IntakeCapability, "close_issue">;

export interface IntakeObservationActionOperand<
  ActionKind extends IntakeActionKind = PersistedIntakeActionKind,
  Capability extends IntakeCapability = PersistedIntakeCapability,
> {
  readonly action: ActionKind;
  readonly observedDisposition: AuthorityDisposition;
  readonly hypotheticalFullyQualifiedDisposition: AuthorityDisposition;
  readonly requiredCapabilities: readonly Capability[];
  readonly proposedValue: IntakeObservationProposedValue;
  /** Null means this action does not use competitors; an empty array means recorded and empty. */
  readonly competingIssueNumbers: readonly number[] | null;
}

export interface IntakeObservationOperands<
  ActionKind extends IntakeActionKind = PersistedIntakeActionKind,
  Capability extends IntakeCapability = PersistedIntakeCapability,
> {
  readonly operandDerivationVersion: typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION;
  readonly observedDisposition: AuthorityDisposition;
  readonly actionOperands: readonly IntakeObservationActionOperand<ActionKind, Capability>[];
}

export interface IntakeCapabilityManifest {
  readonly schemaVersion: typeof INTAKE_CAPABILITY_MANIFEST_SCHEMA;
  readonly manifestId: string;
  readonly generatedAt: string;
  readonly entries: readonly {
    readonly capability: IntakeCapability;
    readonly qualification: "production" | "disposable_canary" | "unqualified";
    readonly assessmentStackSha256: string;
    readonly calibrationRelease: string;
    readonly producerKinds: readonly ProducerKind[];
    readonly proofEvidenceId: string;
  }[];
}

export interface IntakeActionDecision {
  readonly action: IntakeActionKind;
  readonly disposition: AuthorityDisposition;
  readonly targetIssueNumber: number | null;
  readonly before: unknown;
  readonly proposed: unknown;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
  readonly confidence: Confidence;
  readonly preservationEffects: readonly string[];
  readonly predictedCanonicalResult: string;
  readonly requiredCapabilities: readonly IntakeCapability[];
  /**
   * Deterministic, marker-derived lineage for a `create_issue` action: issues that already carry
   * this outcome's identity under a different fingerprint, and issues filed from the same source
   * document. Structured so the draft renders it from data, never by parsing free text -- the
   * rationale carries untrusted model prose, and a `Lineage:` line in it must not become a claim.
   * Annotation only; nothing reads it to decide.
   */
  readonly lineage?: IntakeLineage;
}

export interface DerivedReadiness {
  readonly status: "ready" | "needs_framing" | "decision_needed" | "blocked" | "verification_needed";
  readonly independentlyCloseable: boolean;
  readonly completionRuleDefined: boolean;
  readonly evidenceSufficient: boolean;
  readonly estimationSubstrate: boolean;
  readonly currentMainVerified: boolean;
  readonly reasons: readonly string[];
}

export interface IntakeDecision {
  readonly schemaVersion: typeof INTAKE_DECISION_SCHEMA;
  readonly repository: RepositoryIdentityV2;
  readonly candidateSha256: string;
  readonly snapshotContentSha256: string;
  readonly assessmentSha256: string;
  readonly assessmentStackSha256: string;
  readonly existenceRecordContentSha256: string;
  readonly verifiedOriginMainSha: string;
  readonly capabilityManifestId: string | null;
  readonly generatedAt: string;
  readonly skipped?: readonly IntakeDispositionSkip[];
  readonly candidates: readonly {
    readonly sourceFingerprint: string;
    readonly matchResult: IntakeMatchResult;
    readonly existenceOutcome?: PartialExistenceOutcome;
    readonly canonicalIssueNumber: number | null;
    readonly competingIssueNumbers: readonly number[];
    readonly readiness: DerivedReadiness;
    readonly actions: readonly IntakeActionDecision[];
    readonly writerPlanAllowed: boolean;
  }[];
  readonly attention: {
    readonly issueNumber: number | null;
    readonly nextAction: { readonly kind: "evidence_refresh" | "decision" | "tradeoff"; readonly detail: string } | null;
    readonly evidenceIds: readonly string[];
    readonly rationale: string;
  };
}

export interface IntakeCloseIssueRequest {
  readonly sourceFingerprint: string;
  readonly targetIssueNumber: number;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
  readonly confidence: Confidence;
}

export type IntakeExistenceRecordInput = unknown | Readonly<{
  kind: "existence_read_failure" | "existence_unreadable_record" | "existence_write_failure";
  detail: string;
}>;

interface IntakeDecisionCompilerInput {
  readonly dispositionHistory: DispositionHistory;
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly assessment: IntakeAssessment;
  readonly existenceRecord: IntakeExistenceRecordInput;
  readonly verifiedOriginMainSha: string;
  readonly capabilityManifest?: IntakeCapabilityManifest | null;
  readonly actionQualification?: ActionQualificationContext;
  readonly closeIssueRequests?: readonly IntakeCloseIssueRequest[];
  readonly generatedAt?: string;
}

export interface IntakeExistenceRoutingInput {
  readonly dispositionHistory: DispositionHistory;
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly assessment: IntakeAssessment;
  readonly existenceRecord: IntakeExistenceRecordInput;
  readonly verifiedOriginMainSha: string;
}

export interface IntakeCandidateExistenceRoute {
  readonly sourceFingerprint: string;
  readonly route: ExistenceRoutingResult;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${context} must contain exact keys [${wanted.join(", ")}].`);
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string.`);
  return value.trim();
}

function sha(value: unknown, context: string): string {
  const result = string(value, context);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return result;
}

function timestamp(value: unknown, context: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${context} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

export function parseIntakeCapabilityManifest(rawValue: unknown): IntakeCapabilityManifest {
  const raw = object(rawValue, "capability manifest");
  exactKeys(raw, ["schemaVersion", "manifestId", "generatedAt", "entries"], "capability manifest");
  if (raw.schemaVersion !== INTAKE_CAPABILITY_MANIFEST_SCHEMA) throw new Error(`capability manifest schemaVersion must be ${INTAKE_CAPABILITY_MANIFEST_SCHEMA}.`);
  if (!Array.isArray(raw.entries)) throw new Error("capability manifest.entries must be an array.");
  const entries = raw.entries.map((item, index) => {
    const context = `capability manifest.entries[${index}]`;
    const entry = object(item, context);
    exactKeys(entry, ["capability", "qualification", "assessmentStackSha256", "calibrationRelease", "producerKinds", "proofEvidenceId"], context);
    if (!INTAKE_CAPABILITIES.includes(entry.capability as IntakeCapability)) throw new Error(`${context}.capability is unsupported.`);
    if (!["production", "disposable_canary", "unqualified"].includes(entry.qualification as string)) throw new Error(`${context}.qualification is unsupported.`);
    if (!Array.isArray(entry.producerKinds) || entry.producerKinds.length === 0) throw new Error(`${context}.producerKinds must be non-empty.`);
    const producerKinds = entry.producerKinds.map((kind) => {
      if (!PRODUCER_KINDS.includes(kind as ProducerKind)) throw new Error(`${context}.producerKinds contains an unsupported kind.`);
      return kind as ProducerKind;
    });
    if (new Set(producerKinds).size !== producerKinds.length) throw new Error(`${context}.producerKinds contains duplicates.`);
    return {
      capability: entry.capability as IntakeCapability,
      qualification: entry.qualification as "production" | "disposable_canary" | "unqualified",
      assessmentStackSha256: sha(entry.assessmentStackSha256, `${context}.assessmentStackSha256`),
      calibrationRelease: string(entry.calibrationRelease, `${context}.calibrationRelease`),
      producerKinds: producerKinds.sort(),
      proofEvidenceId: string(entry.proofEvidenceId, `${context}.proofEvidenceId`),
    };
  });
  if (new Set(entries.map((entry) => entry.capability)).size !== entries.length) throw new Error("capability manifest contains duplicate capabilities.");
  return {
    schemaVersion: INTAKE_CAPABILITY_MANIFEST_SCHEMA,
    manifestId: string(raw.manifestId, "capability manifest.manifestId"),
    generatedAt: timestamp(raw.generatedAt, "capability manifest.generatedAt"),
    entries: entries.sort((left, right) => left.capability.localeCompare(right.capability)),
  };
}

function qualified(
  manifest: IntakeCapabilityManifest | null,
  capability: IntakeCapability,
  stackSha256: string,
  calibrationRelease: string,
  producerKind: ProducerKind,
): boolean {
  const entry = manifest?.entries.find((candidate) => candidate.capability === capability);
  return entry?.qualification === "production" && entry.assessmentStackSha256 === stackSha256 &&
    entry.calibrationRelease === calibrationRelease && entry.producerKinds.includes(producerKind);
}

export function deriveIntakeReadiness(
  candidate: OutcomeCandidate,
  currentMainVerified: boolean,
): DerivedReadiness {
  const signals = candidate.readiness;
  const reasons: string[] = [];
  if (!signals.independentlyCloseable) reasons.push("outcome_not_independently_closeable");
  if (!signals.framingComplete) reasons.push("framing_incomplete");
  if (!signals.completionRuleDefined) reasons.push("completion_rule_missing");
  if (!signals.evidenceSufficient) reasons.push("evidence_insufficient");
  if (signals.unresolvedDecisionIds.length > 0) reasons.push("unresolved_decisions");
  if (signals.dependencyIds.length > 0) reasons.push("dependencies_unresolved");
  if (!currentMainVerified) reasons.push("current_main_verification_missing");
  let status: DerivedReadiness["status"] = "ready";
  if (!signals.independentlyCloseable || !signals.framingComplete || !signals.completionRuleDefined) status = "needs_framing";
  else if (signals.unresolvedDecisionIds.length > 0) status = "decision_needed";
  else if (signals.dependencyIds.length > 0 || !signals.evidenceSufficient) status = "blocked";
  else if (!currentMainVerified) status = "verification_needed";
  return {
    status,
    independentlyCloseable: signals.independentlyCloseable,
    completionRuleDefined: signals.completionRuleDefined,
    evidenceSufficient: signals.evidenceSufficient,
    estimationSubstrate: signals.estimationSubstrate,
    currentMainVerified,
    reasons,
  };
}

/**
 * Whether the snapshot can still support a novelty verdict for one candidate.
 *
 * Compiling the decision and labelling an operator-facing hold reason are two readings of the same
 * rule, so they share this predicate rather than restating its three clauses. Restated, a change to
 * one clause silently mislabels the other surface: the decision would go `invalid` while the hold
 * still read `ambiguous_match`, or the reverse.
 */
export function noveltyRevalidationFailed(snapshot: IntakeSnapshotV1, sourceFingerprint: string): boolean {
  return snapshot.coverage.novelty !== "complete" ||
    snapshot.markerIncidents.some((incident) => incident.sourceFingerprint === sourceFingerprint);
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

type CanonicalMatch = CandidateIntakeAssessment["match"] & {
  readonly deterministicInvalid?: boolean;
  readonly modelOnly?: boolean;
  readonly existenceOutcome?: PartialExistenceOutcome;
};

function baseCanonicalMatch(
  assessment: CandidateIntakeAssessment,
  snapshot: IntakeSnapshotV1,
  expectedMarker: SourceMarkerV1,
): CanonicalMatch {
  const markers = (snapshot.markerIndex[assessment.sourceFingerprint] ?? [])
    .filter((location) => sourceMarkersMatchLoosely(location.marker, expectedMarker));
  const bodyMarkers = markers.filter((location) => location.source === "body");
  const canonicalIssueNumbers = [...new Set(bodyMarkers.map((location) => location.issueNumber))];
  if (noveltyRevalidationFailed(snapshot, assessment.sourceFingerprint)) {
    const incident = snapshot.markerIncidents.find((item) => item.sourceFingerprint === assessment.sourceFingerprint);
    return {
      ...assessment.match,
      rationale: incident?.kind === "copied"
        ? "Marker conflict: multiple canonical body markers."
        : incident === undefined
          ? `Novelty revalidation failed: ${snapshot.coverage.novelty}.`
          : `Novelty revalidation failed: ${incident.kind} source marker.`,
      deterministicInvalid: true,
      result: "invalid",
      canonicalIssueNumber: null,
      competingIssueNumbers: canonicalIssueNumbers,
    };
  }
  if (canonicalIssueNumbers.length > 1) {
    canonicalIssueNumbers.sort((a, b) => a - b);
    return {
      ...assessment.match,
      rationale: `${canonicalIssueNumbers.length} competing canonical issues track this outcome: ${canonicalIssueNumbers.map((number) => `#${number}`).join(", ")}.`,
      deterministicInvalid: true,
      result: "invalid",
      canonicalIssueNumber: null,
      competingIssueNumbers: canonicalIssueNumbers,
    };
  }
  if (canonicalIssueNumbers.length === 1) {
    const canonicalIssueNumber = canonicalIssueNumbers[0];
    const exactEmissionConsumed = markers.some((location) =>
      location.issueNumber === canonicalIssueNumber &&
      sourceMarkersMatchStrictly(location.marker, expectedMarker));
    return {
      ...assessment.match,
      result: exactEmissionConsumed ? "replay" : "exact_match",
      canonicalIssueNumber,
      competingIssueNumbers: [],
    };
  }
  if (assessment.match.result === "replay") return { ...assessment.match, modelOnly: true, canonicalIssueNumber: null };
  if (assessment.match.result === "invalid") return { ...assessment.match, modelOnly: true, canonicalIssueNumber: null };
  if (assessment.match.result === "exact_match") {
    // A model assertion alone cannot suppress filing. Keep the claim as an annotation,
    // not canonical/competing identities, which would contradict the novel match shape.
    const claim = assessment.match;
    return {
      ...claim,
      modelOnly: true,
      result: "clearly_novel",
      canonicalIssueNumber: null,
      competingIssueNumbers: [],
      rationale: `Unverified model assertion: exact_match to ${claim.canonicalIssueNumber === null ? "an unspecified issue" : `#${claim.canonicalIssueNumber}`} ` +
        `(confidence: ${claim.confidence}); competing issues: ${claim.competingIssueNumbers.map((number) => `#${number}`).join(", ") || "none"}; ` +
        `evidence ids: ${claim.evidenceIds.join(", ") || "none"}. Model rationale: ${claim.rationale}`,
    };
  }
  return { ...assessment.match, modelOnly: assessment.match.result === "plausible_overlap" };
}

interface CandidateExistenceEvaluation {
  readonly route: ExistenceRoutingResult;
  readonly rationale: string;
  readonly currentMainVerified: boolean;
}

interface ExistenceCompilerContext {
  readonly record: ExistenceRecordV1 | null;
  readonly contentSha256: string;
  readonly verifiedOriginMainSha: string;
  readonly degradation: "unreadable_record" | "sha_mismatch" | "read_failure" | null;
  readonly rationale: string | null;
}

function declaredExistenceContentSha256(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const declared = (value as Readonly<Record<string, unknown>>).contentSha256;
    if (typeof declared === "string" && /^[0-9a-f]{64}$/.test(declared)) return declared;
  }
  return canonicalJsonSha256(value);
}

function existenceCompilerContext(
  value: unknown,
  envelope: OutcomeEnvelope,
  verifiedOriginMainShaValue: string,
): ExistenceCompilerContext {
  const verifiedOriginMainSha = gitSha(verifiedOriginMainShaValue, "verifiedOriginMainSha");
  const contentSha256 = declaredExistenceContentSha256(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const failure = value as Readonly<Record<string, unknown>>;
    if ((failure.kind === "existence_read_failure" || failure.kind === "existence_unreadable_record" ||
        failure.kind === "existence_write_failure") &&
        typeof failure.detail === "string") {
      const degradation = failure.kind === "existence_read_failure"
        ? "read_failure"
        : failure.kind === "existence_write_failure"
          ? "read_failure"
          : "unreadable_record";
      return {
        record: null, contentSha256, verifiedOriginMainSha,
        degradation,
        rationale: failure.kind === "existence_read_failure"
          ? `Existence record read failure; filing is held. (${failure.detail})`
          : failure.kind === "existence_write_failure"
            ? `Existence suppression write failure; filing is held. (${failure.detail})`
            : `Existence record is unreadable; filing is held. (${failure.detail})`,
      };
    }
  }
  let record: ExistenceRecordV1;
  try {
    record = parseExistenceRecord(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      record: null, contentSha256, verifiedOriginMainSha, degradation: "unreadable_record",
      rationale: /contentSha256 mismatch/i.test(detail)
        ? "Existence record content hash mismatch; filing is held."
        : `Existence record is unreadable; filing is held. (${detail})`,
    };
  }
  if (record.repository.databaseId !== envelope.repository.databaseId ||
      record.repository.nodeId !== envelope.repository.nodeId ||
      record.repository.organization.toLowerCase() !== envelope.repository.organization.toLowerCase() ||
      record.repository.name.toLowerCase() !== envelope.repository.name.toLowerCase()) {
    return {
      record: null, contentSha256, verifiedOriginMainSha, degradation: "unreadable_record",
      rationale: "Existence record repository identity mismatch; filing is held.",
    };
  }
  if (record.originMainSha !== verifiedOriginMainSha) {
    return {
      record: null, contentSha256, verifiedOriginMainSha, degradation: "sha_mismatch",
      rationale: `Existence record origin/main SHA mismatch: record ${record.originMainSha}, verified ${verifiedOriginMainSha}; filing is held.`,
    };
  }
  return { record, contentSha256, verifiedOriginMainSha, degradation: null, rationale: null };
}

function existenceRationale(route: ExistenceRoutingResult): string {
  switch (route.kind) {
    case "append_evidence_then_close":
    case "provisional_suppression":
      return "Existence verification found this outcome already demonstrated on verified origin/main; filing is held.";
    case "file_residual_issue":
      return `Existence verification found ${route.satisfiedClauseCitations.length} satisfied clause(s) with citations and ${route.unsatisfiedClauses.length} unsatisfied clause(s) for this candidate.`;
    case "file_as_today":
      return "Existence verification found this outcome not demonstrated on verified origin/main.";
    case "hold":
      if (route.reason === "no_entry") return "Existence record has no matching candidate entry; filing is held.";
      if (route.reason === "read_failure") return "Existence verification recorded a read failure; filing is held.";
      if (route.reason === "budget_exhausted") return "Existence verification budget exhausted before a conclusion; filing is held.";
      if (route.reason === "sha_mismatch") return "Existence record origin/main SHA mismatch; filing is held.";
      if (route.reason === "unreadable_record") return "Existence record is unreadable; filing is held.";
      if (route.reason === "missing_required_field") {
        return `Existence verification is missing required field ${route.missingField}; filing is held.`;
      }
      return "clauseSet" in route
        ? `Existence verification carries an invalid partial clause set (${route.clauseSet}); filing is held.`
        : `Existence verification degraded as ${route.reason}; filing is held.`;
  }
}

function evaluateCandidateExistence(
  context: ExistenceCompilerContext,
  candidate: OutcomeCandidate,
  canonicalIssueNumber: number | null,
): CandidateExistenceEvaluation {
  let outcome: Parameters<typeof routeExistence>[0]["outcome"];
  let evidence: unknown = null;
  if (context.degradation !== null) {
    outcome = context.degradation;
  } else {
    try {
      const resolved = resolveExistenceEntry(context.record!, candidate);
      if ("kind" in resolved) outcome = resolved.kind;
      else if ("runOutcome" in resolved) outcome = resolved.runOutcome.kind;
      else {
        outcome = resolved.state;
        evidence = resolved.evidence;
      }
    } catch (error) {
      outcome = "unreadable_record";
      evidence = error instanceof Error ? error.message : String(error);
    }
  }
  const route = routeExistence({
    entry: candidate,
    verifiedOriginMainSha: context.verifiedOriginMainSha,
    outcome,
    evidence,
  }, canonicalIssueNumber);
  return {
    route,
    rationale: context.rationale ?? existenceRationale(route),
    currentMainVerified: context.degradation === null &&
      (outcome === "demonstrated" || outcome === "partially_demonstrated" || outcome === "not_demonstrated"),
  };
}

function candidateExistenceEvaluations(
  input: Pick<IntakeExistenceRoutingInput, "envelope" | "snapshot" | "assessment" | "dispositionHistory">,
  context: ExistenceCompilerContext,
): ReadonlyArray<{
  readonly sourceFingerprint: string;
  readonly evaluation: CandidateExistenceEvaluation;
}> {
  const assessmentsByFingerprint = new Map(
    input.assessment.candidates.map((assessment) => [assessment.sourceFingerprint, assessment]),
  );
  return effectiveOutcomeCandidates(input.envelope, input.dispositionHistory).active.map((candidate) => {
    const assessed = assessmentsByFingerprint.get(candidate.sourceFingerprint);
    if (assessed === undefined) {
      throw new Error(`Assessment is missing candidate ${candidate.sourceFingerprint}.`);
    }
    const markerMatch = baseCanonicalMatch(
      assessed,
      input.snapshot,
      expectedSourceMarker(input.envelope, candidate),
    );
    return {
      sourceFingerprint: candidate.sourceFingerprint,
      evaluation: evaluateCandidateExistence(
        context,
        candidate,
        markerMatch.canonicalIssueNumber,
      ),
    };
  });
}

/** Resolve the existence routes consumed by both the compiler and trusted collection writes. */
export function compileIntakeExistenceRoutes(
  input: IntakeExistenceRoutingInput,
): IntakeCandidateExistenceRoute[] {
  return candidateExistenceEvaluations(input, existenceCompilerContext(
    input.existenceRecord,
    input.envelope,
    input.verifiedOriginMainSha,
  )).map(({ sourceFingerprint, evaluation }) => ({ sourceFingerprint, route: evaluation.route }));
}

function canonicalMatch(
  assessment: CandidateIntakeAssessment,
  snapshot: IntakeSnapshotV1,
  existence: CandidateExistenceEvaluation,
  expectedMarker: SourceMarkerV1,
): CanonicalMatch {
  const match = baseCanonicalMatch(assessment, snapshot, expectedMarker);
  if (existence.route.kind === "file_as_today") return match;
  if (existence.route.kind === "file_residual_issue") {
    const qualification = CLAUSE_DECOMPOSITION_QUALIFICATION.status;
    if (qualification !== "unqualified" && qualification !== "qualified") {
      throw new Error("Clause decomposition qualification is unresolvable.");
    }
    if (match.deterministicInvalid) return match;
    if (qualification === "unqualified") {
      return { ...match, existenceOutcome: {
        kind: "partial_released_unqualified",
        qualification,
        satisfiedClauses: existence.route.satisfiedClauseCitations.map(({ clause }) => clause),
        reason: `${existence.rationale} Clause decomposition is unqualified, so this partial verdict does not hold filing; the ordinary novelty match and whole completion rule are retained.`,
      } };
    }
    const reason = `${existence.rationale} Clause decomposition is qualified, so this mixed verdict holds filing; residual filing is not implemented.`;
    return { ...match, result: "invalid", deterministicInvalid: true, canonicalIssueNumber: null,
      competingIssueNumbers: [...new Set([...match.competingIssueNumbers,
        ...(match.canonicalIssueNumber === null ? [] : [match.canonicalIssueNumber])])],
      rationale: reason, existenceOutcome: { kind: "partial_held_qualified", qualification, reason } };
  }
  return { ...match, result: "invalid", deterministicInvalid: true, canonicalIssueNumber: null,
    competingIssueNumbers: [...new Set([...match.competingIssueNumbers,
      ...(match.canonicalIssueNumber === null ? [] : [match.canonicalIssueNumber])])],
    rationale: existence.rationale };
}

type RoadmapFieldName = "Type" | "Priority" | "Effort" | "Horizon";

function fieldValue(issue: IntakeIssueSnapshot | undefined, fieldName: RoadmapFieldName): unknown {
  if (issue === undefined) return null;
  if (fieldName === "Type" && issue.nativeType !== null) {
    const raw = issue.nativeType as Record<string, unknown>;
    return typeof raw.name === "string" ? raw.name : issue.nativeType;
  }
  for (const item of issue.fieldValues) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const nested = raw.field !== null && typeof raw.field === "object" ? raw.field as Record<string, unknown> : null;
    const name = typeof raw.name === "string" ? raw.name : typeof nested?.name === "string" ? nested.name : null;
    if (name?.toLowerCase() !== fieldName.toLowerCase()) continue;
    return raw.value ?? raw.nameValue ?? raw.option ?? null;
  }
  return null;
}

function automaticOrRecommendation(
  isEligible: boolean,
  capability: IntakeCapability,
  manifest: IntakeCapabilityManifest | null,
  stackSha256: string,
  assessment: IntakeAssessment,
  producerKind: ProducerKind,
  qualificationBasis: "manifest" | "hypothetical_fully_qualified",
): AuthorityDisposition {
  return isEligible && (qualificationBasis === "hypothetical_fully_qualified" ||
      qualified(manifest, capability, stackSha256, assessment.stack.calibrationRelease, producerKind))
    ? "automatic_safe"
    : "recommendation_only";
}

function classificationActions(input: {
  candidate: OutcomeCandidate;
  assessed: CandidateIntakeAssessment;
  issue: IntakeIssueSnapshot | undefined;
  targetIssueNumber: number | null;
  manifest: IntakeCapabilityManifest | null;
  stackSha256: string;
  assessment: IntakeAssessment;
  producerKind: ProducerKind;
  readiness: DerivedReadiness;
  authorityEligible: boolean;
  qualificationBasis: "manifest" | "hypothetical_fully_qualified";
}): IntakeActionDecision[] {
  const {
    candidate, assessed, issue, targetIssueNumber, manifest, stackSha256, assessment, producerKind,
    readiness, authorityEligible, qualificationBasis,
  } = input;
  const actions: IntakeActionDecision[] = [];
  const add = (kind: "set_type" | "set_priority" | "set_effort", value: string, capability: IntakeCapability, eligible: boolean, assessedValue: CandidateIntakeAssessment["classification"]["type"] | CandidateIntakeAssessment["classification"]["priority"] | CandidateIntakeAssessment["classification"]["effort"], before: unknown) => {
    actions.push({
      action: kind,
      disposition: automaticOrRecommendation(
        authorityEligible && eligible, capability, manifest, stackSha256, assessment, producerKind,
        qualificationBasis,
      ),
      targetIssueNumber, before, proposed: value, evidenceIds: assessedValue.evidenceIds,
      rationale: assessedValue.rationale, confidence: assessedValue.confidence,
      preservationEffects: ["preserve_non_null_conflicting_value", "preserve_horizon"],
      predictedCanonicalResult: before === null ? `${kind}:${value}` : `${kind}:unchanged`,
      requiredCapabilities: [capability],
    });
  };
  const type = assessed.classification.type;
  const priorType = fieldValue(issue, "Type");
  if (type.value !== null && priorType === null) {
    const eligible = type.confidence === "high" && candidate.suggestions.type.confidence === "high" && candidate.suggestions.type.value === type.value;
    add("set_type", type.value, "set_type", eligible, type, priorType);
  }
  const priority = assessed.classification.priority;
  const priorPriority = fieldValue(issue, "Priority");
  const canProposePriority = targetIssueNumber !== null || type.value === "Bug" || type.value === "Task" ||
    (type.value === null && priority.value === "P0");
  if (priority.value !== null && priorPriority === null && canProposePriority) {
    const sensitive = priority.value === "P0" || priority.value === "P1";
    if (sensitive) {
      actions.push({ action: "set_priority", disposition: "approval_required", targetIssueNumber, before: null, proposed: priority.value,
        evidenceIds: priority.evidenceIds, rationale: priority.rationale, confidence: priority.confidence,
        preservationEffects: ["preserve_horizon", "preserve_all_existing_fields"], predictedCanonicalResult: `Priority=${priority.value}; Horizon unchanged`, requiredCapabilities: [] });
    } else {
      const rubricEvidence = priority.evidenceIds.some((id) => candidate.evidence.some((evidence) => evidence.id === id && evidence.kind === "approved_strategy"));
      const eligible = priority.confidence === "high" && candidate.suggestions.priority.confidence === "high" &&
        candidate.suggestions.priority.value === priority.value && rubricEvidence && fieldValue(issue, "Horizon") === null;
      add("set_priority", priority.value, "set_priority", eligible, priority, priorPriority);
    }
  }
  const effort = assessed.classification.effort;
  const priorEffort = fieldValue(issue, "Effort");
  if (effort.value !== null && priorEffort === null) {
    const eligible = effort.confidence === "high" && candidate.suggestions.effort.confidence === "high" &&
      candidate.suggestions.effort.value === effort.value && readiness.independentlyCloseable &&
      readiness.completionRuleDefined && readiness.evidenceSufficient && readiness.estimationSubstrate;
    add("set_effort", effort.value, "set_effort", eligible, effort, priorEffort);
  }
  const horizon = assessed.classification.horizon;
  if (horizon.value !== null) {
    actions.push({
      action: "set_horizon",
      disposition: horizon.value === "Now" || horizon.value === "Parked" ? "approval_required" : "recommendation_only",
      targetIssueNumber, before: fieldValue(issue, "Horizon"), proposed: horizon.value,
      evidenceIds: horizon.evidenceIds, rationale: horizon.rationale, confidence: horizon.confidence,
      preservationEffects: ["routine_intake_never_writes_horizon"],
      predictedCanonicalResult: `Horizon remains unchanged pending exact approval`, requiredCapabilities: [],
    });
  }
  return actions;
}

function compileAttentionNextAction(
  attention: IntakeAssessment["attention"],
): IntakeDecision["attention"]["nextAction"] {
  if (attention.issueNumber !== null) return null;
  if (attention.evidenceRefresh !== null) {
    return { kind: "evidence_refresh", detail: attention.evidenceRefresh };
  }
  if (attention.decision !== null) {
    return { kind: "decision", detail: attention.decision };
  }
  return { kind: "tradeoff", detail: attention.tradeoff as string };
}

function compileIntakeDecisionWithQualification(
  input: IntakeDecisionCompilerInput,
  qualificationBasis: "manifest" | "hypothetical_fully_qualified",
): IntakeDecision {
  if (canonicalJsonSha256(input.envelope) !== input.assessment.candidateSha256 ||
      input.snapshot.contentSha256 !== input.assessment.snapshotContentSha256) {
    throw new Error("Intake compiler inputs do not share the same candidate and snapshot bindings.");
  }
  const existenceContext = existenceCompilerContext(
    input.existenceRecord,
    input.envelope,
    input.verifiedOriginMainSha,
  );
  const manifest = input.capabilityManifest === undefined || input.capabilityManifest === null
    ? null
    : parseIntakeCapabilityManifest(input.capabilityManifest);
  const stackSha256 = assessmentStackSha256(input.assessment.stack);
  const assessmentsByFingerprint = new Map(
    input.assessment.candidates.map((assessment) => [assessment.sourceFingerprint, assessment]),
  );
  const existenceByFingerprint = new Map(
    candidateExistenceEvaluations(input, existenceContext)
      .map((entry) => [entry.sourceFingerprint, entry.evaluation]),
  );
  const issuesByNumber = new Map(
    input.snapshot.issues.map((issue) => [issue.number, issue]),
  );
  const closeRequestsByFingerprint = new Map<string, IntakeCloseIssueRequest[]>();
  for (const request of input.closeIssueRequests ?? []) {
    const requests = closeRequestsByFingerprint.get(request.sourceFingerprint) ?? [];
    requests.push(request);
    closeRequestsByFingerprint.set(request.sourceFingerprint, requests);
  }
  const skipped = intakeDispositionSkips(input.envelope, input.dispositionHistory);
  const candidates = effectiveOutcomeCandidates(input.envelope, input.dispositionHistory).active.map((candidate) => {
    const assessed = assessmentsByFingerprint.get(candidate.sourceFingerprint);
    if (assessed === undefined) throw new Error(`Assessment is missing candidate ${candidate.sourceFingerprint}.`);
    const marker = expectedSourceMarker(input.envelope, candidate);
    const markerMatch = baseCanonicalMatch(assessed, input.snapshot, marker);
    const existence = existenceByFingerprint.get(candidate.sourceFingerprint);
    if (existence === undefined) {
      throw new Error(`Existence route is missing candidate ${candidate.sourceFingerprint}.`);
    }
    const correctedMatch = canonicalMatch(assessed, input.snapshot, existence, marker);
    let match: CanonicalMatch = existence.route.kind === "append_evidence_then_close" && !markerMatch.deterministicInvalid
      ? {
          ...markerMatch,
          modelOnly: false,
          result: "exact_match" as const,
          canonicalIssueNumber: existence.route.canonicalIssueNumber,
          competingIssueNumbers: [],
        }
      : correctedMatch;
    const qualifiedOverlap = match.modelOnly === true && match.result === "plausible_overlap"
      && match.competingIssueNumbers.length === 1
      && isActionKindExecutable("append_evidence_overlap", input.actionQualification);
    if (qualifiedOverlap) match = { ...match, canonicalIssueNumber: match.competingIssueNumbers[0] };
    const issue = match.canonicalIssueNumber === null
      ? undefined
      : issuesByNumber.get(match.canonicalIssueNumber);
    const readiness = deriveIntakeReadiness(candidate, existence.currentMainVerified);
    const actions: IntakeActionDecision[] = [];
    const requestedCloses = closeRequestsByFingerprint.get(candidate.sourceFingerprint) ?? [];
    const closeRequests = requestedCloses;
    const closeRequest = closeRequests.length === 1 ? closeRequests[0] : undefined;
    let closeRefusal: string | null = null;
    if (closeRequests.length > 1) {
      closeRefusal = `Close request refused for existence route ${existence.route.kind}: duplicate requests target this candidate.`;
    } else if (closeRequest === undefined && existence.route.kind === "append_evidence_then_close" &&
        (issue === undefined || issue.state !== "OPEN" || existence.route.canonicalIssueNumber !== issue.number)) {
      closeRefusal = `Close request refused for existence route ${existence.route.kind}: it does not target the route's open canonical issue.`;
    } else if (closeRequest !== undefined && existence.route.kind !== "append_evidence_then_close") {
      closeRefusal = `Close request refused for existence route ${existence.route.kind}; only append_evidence_then_close permits close_issue.`;
    } else if (closeRequest !== undefined &&
        (issue === undefined || issue.state !== "OPEN" || closeRequest.targetIssueNumber !== issue.number)) {
      closeRefusal = `Close request refused for existence route ${existence.route.kind}: it does not target the route's open canonical issue.`;
    } else if (closeRequest !== undefined &&
        (closeRequest.evidenceIds.length === 0 ||
          closeRequest.evidenceIds.some((evidenceId) => evidenceId.trim() === ""))) {
      closeRefusal = `Close request refused for existence route ${existence.route.kind}: it must carry its completion evidence.`;
    }
    if (closeRefusal !== null) {
      match = { ...match, result: "invalid", canonicalIssueNumber: null,
        competingIssueNumbers: [...new Set([...match.competingIssueNumbers,
          ...(match.canonicalIssueNumber === null ? [] : [match.canonicalIssueNumber])])] };
      actions.push({ action: "hold_invalid", disposition: "hold_no_write", targetIssueNumber: null,
        before: null, proposed: null, evidenceIds: closeRequest?.evidenceIds ?? [], rationale: closeRefusal,
        confidence: closeRequest?.confidence ?? match.confidence, preservationEffects: ["zero_writes"],
        predictedCanonicalResult: "No canonical mutation", requiredCapabilities: [] });
    } else if (match.result === "replay" && match.canonicalIssueNumber !== null) {
      actions.push({ action: "replay_no_op", disposition: "automatic_safe", targetIssueNumber: match.canonicalIssueNumber,
        before: null, proposed: null, evidenceIds: match.evidenceIds, rationale: "Canonical source and emission marker already consumed.", confidence: "high",
        preservationEffects: ["zero_writes"], predictedCanonicalResult: "Canonical issue unchanged", requiredCapabilities: [] });
    } else if (match.result === "invalid" && match.deterministicInvalid) {
      actions.push({ action: "hold_invalid", disposition: "hold_no_write", targetIssueNumber: null,
        before: null, proposed: null, evidenceIds: match.evidenceIds, rationale: match.rationale, confidence: match.confidence,
        preservationEffects: ["zero_writes"], predictedCanonicalResult: "No canonical mutation", requiredCapabilities: [] });
    } else {
      const modelOnly = match.modelOnly === true;
      const releasedPartial = match.existenceOutcome?.kind === "partial_released_unqualified";
      if (qualifiedOverlap) {
        const targetIssueNumber = match.competingIssueNumbers[0];
        actions.push({ action: "append_evidence_overlap", disposition: "automatic_safe", targetIssueNumber,
          before: "existing_evidence", proposed: candidate.emissionContentSha256,
          evidenceIds: match.evidenceIds, rationale: match.rationale, confidence: match.confidence,
          preservationEffects: ["append_only", "preserve_all_existing_evidence"],
          predictedCanonicalResult: "One additive marker-bearing evidence comment on the single competing issue",
          requiredCapabilities: ["append_evidence_overlap"] });
      } else if (match.result === "clearly_novel" || modelOnly) {
        const lineage: IntakeLineage = {
          stableArtifactId: input.envelope.artifact.stableId,
          stableOutcomeId: candidate.stableOutcomeId,
          producerKind: input.envelope.producer.kind,
          sourceLocator: input.envelope.artifact.sourceLocator,
          outcome: outcomeLineage(input.snapshot, candidate, { artifact: { stableArtifactId: input.envelope.artifact.stableId } })
            .map((hit) => ({ issueNumber: hit.issueNumber, producerKind: hit.marker.producerKind })),
          source: sourceLineage(input.snapshot, input.envelope, candidate).map((hit) => hit.issueNumber),
        };
        const closeable = readiness.status === "ready";
        const qualifiedDisposition = automaticOrRecommendation(
          !releasedPartial && match.confidence === "high" && closeable, "create_issue", manifest, stackSha256,
          input.assessment, input.envelope.producer.kind, qualificationBasis,
        );
        actions.push({ action: "create_issue",
          disposition: modelOnly && qualifiedDisposition === "automatic_safe" ? "approval_required" : qualifiedDisposition,
          targetIssueNumber: null, before: null, proposed: { title: candidate.outcome.title, horizon: null }, evidenceIds: match.evidenceIds,
          rationale: modelOnly
            ? `Model verdict ${assessed.match.result} (confidence ${assessed.match.confidence}); competitors: ${match.competingIssueNumbers.map((number) => `#${number}`).join(", ") || "none"}. ${match.rationale}`
            : match.rationale,
          confidence: match.confidence, preservationEffects: ["horizon_absent", "retain_returned_issue_identity_before_dependent_updates"],
          predictedCanonicalResult: "One open Inbox issue with source marker", requiredCapabilities: ["create_issue"],
          ...(lineage.outcome.length > 0 || lineage.source.length > 0 ? { lineage } : {}) });
      } else {
        const appendAction: IntakeActionDecision = { action: "append_evidence",
          disposition: automaticOrRecommendation(
            !releasedPartial && match.confidence === "high", "append_evidence", manifest, stackSha256,
            input.assessment, input.envelope.producer.kind, qualificationBasis,
          ),
          targetIssueNumber: match.canonicalIssueNumber, before: "existing_evidence", proposed: candidate.emissionContentSha256,
          evidenceIds: match.evidenceIds, rationale: match.rationale, confidence: match.confidence,
          preservationEffects: ["append_only", "preserve_all_existing_evidence", "preserve_newer_or_more_authoritative_evidence"],
          predictedCanonicalResult: "One additive marker-bearing evidence comment; existing evidence unchanged", requiredCapabilities: ["append_evidence"] };
        actions.push(appendAction);
        if (existence.route.kind === "append_evidence_then_close") {
          actions.push({ action: "close_issue_existence",
            disposition: (qualificationBasis === "hypothetical_fully_qualified" || isActionKindExecutable("close_issue_existence", input.actionQualification))
              ? "automatic_safe" : "recommendation_only",
            targetIssueNumber: closeRequest?.targetIssueNumber ?? existence.route.canonicalIssueNumber,
            before: "OPEN", proposed: "CLOSED",
            evidenceIds: appendAction.evidenceIds,
            rationale: closeRequest?.rationale ??
              "Verified origin/main demonstrates every completion clause with a merged-commit receipt.",
            confidence: appendAction.confidence,
            preservationEffects: ["append_evidence_before_close", "preserve_all_fields_and_relationships"],
            predictedCanonicalResult: "Issue closes only after its additive evidence comment succeeds",
            requiredCapabilities: ["close_issue_existence"] });
        }
      }
      if (issue?.state === "CLOSED") {
        if (assessed.completionContradicted) {
          actions.push({ action: "reopen_issue", disposition: "approval_required", targetIssueNumber: issue.number,
            before: "CLOSED", proposed: "OPEN", evidenceIds: match.evidenceIds, rationale: "New evidence contradicts the recorded completion state.", confidence: match.confidence,
            preservationEffects: ["preserve_closed_state_until_exact_approval", "preserve_all_fields_and_relationships"],
            predictedCanonicalResult: "Issue reopens only after an unchanged exact proposal is approved", requiredCapabilities: [] });
        }
      } else {
        const consumptionIsAutomatic = !modelOnly && actions.some((entry) =>
          (entry.action === "create_issue" || entry.action === "append_evidence") && entry.disposition === "automatic_safe");
        actions.push(...classificationActions({ candidate, assessed, issue, targetIssueNumber: match.canonicalIssueNumber,
          manifest, stackSha256, assessment: input.assessment, producerKind: input.envelope.producer.kind, readiness,
          authorityEligible: match.confidence === "high" && consumptionIsAutomatic,
          qualificationBasis,
        }));
        const relationships = [...assessed.relationships];
        if (modelOnly) {
          for (const targetIssueNumber of new Set(match.competingIssueNumbers)) {
            if (relationships.some((relationship) => relationship.kind === "related" && relationship.targetIssueNumber === targetIssueNumber)) continue;
            relationships.push({ kind: "related", targetIssueNumber, conflict: false,
              evidenceIds: match.evidenceIds, rationale: assessed.match.rationale, confidence: match.confidence });
          }
        }
        const relatedTargets = new Set<number>();
        for (const relationship of relationships) {
          if (modelOnly && relationship.kind === "related") {
            if (relatedTargets.has(relationship.targetIssueNumber)) continue;
            relatedTargets.add(relationship.targetIssueNumber);
          }
          actions.push({ action: relationship.conflict ? "change_relationship" : "add_relationship",
            disposition: relationship.conflict ? "approval_required" : "recommendation_only", targetIssueNumber: match.canonicalIssueNumber,
            before: relationship.conflict ? "conflicting_relationship" : null,
            proposed: { kind: relationship.kind, targetIssueNumber: relationship.targetIssueNumber }, evidenceIds: relationship.evidenceIds,
            rationale: relationship.rationale, confidence: relationship.confidence,
            preservationEffects: relationship.conflict ? ["preserve_full_relationship_graph_until_exact_approval"] : ["do_not_remove_or_replace_relationships"],
            predictedCanonicalResult: relationship.conflict ? "Relationship graph unchanged pending exact approval" : "Relationship recommendation only",
            requiredCapabilities: [] });
        }
      }
    }
    return {
      sourceFingerprint: candidate.sourceFingerprint,
      matchResult: match.result,
      ...(match.existenceOutcome === undefined ? {} : { existenceOutcome: match.existenceOutcome }),
      canonicalIssueNumber: match.canonicalIssueNumber,
      competingIssueNumbers: match.competingIssueNumbers,
      readiness,
      actions,
      writerPlanAllowed: actions.some((entry) => entry.disposition === "automatic_safe" && entry.action !== "replay_no_op"),
    };
  });
  const attention = input.assessment.attention;
  const nextAction = compileAttentionNextAction(attention);
  return {
    schemaVersion: INTAKE_DECISION_SCHEMA,
    repository: input.envelope.repository,
    candidateSha256: input.assessment.candidateSha256,
    snapshotContentSha256: input.assessment.snapshotContentSha256,
    assessmentSha256: intakeAssessmentSha256(input.assessment),
    assessmentStackSha256: stackSha256,
    existenceRecordContentSha256: existenceContext.contentSha256,
    verifiedOriginMainSha: existenceContext.verifiedOriginMainSha,
    capabilityManifestId: manifest?.manifestId ?? null,
    generatedAt: timestamp(input.generatedAt ?? input.assessment.generatedAt, "decision.generatedAt"),
    candidates,
    ...(skipped.length > 0 ? { skipped } : {}),
    attention: { issueNumber: attention.issueNumber, nextAction, evidenceIds: attention.evidenceIds, rationale: attention.rationale },
  };
}

export function compileIntakeDecision(input: IntakeDecisionCompilerInput): IntakeDecision {
  return compileIntakeDecisionWithQualification(input, "manifest");
}

function observedDisposition(
  candidate: IntakeDecision["candidates"][number],
): AuthorityDisposition {
  if (candidate.actions.some(({ action }) => action === "hold_invalid")) {
    return "hold_no_write";
  }
  if (candidate.actions.some(({ action, disposition }) =>
    action !== "replay_no_op" && disposition === "automatic_safe")) {
    return "automatic_safe";
  }
  if (candidate.actions.some(({ disposition }) => disposition === "approval_required")) {
    return "approval_required";
  }
  if (candidate.actions.some(({ action, disposition }) =>
    action === "replay_no_op" && disposition === "automatic_safe")) {
    return "automatic_safe";
  }
  return "recommendation_only";
}

function projectedValue(action: IntakeActionDecision): IntakeObservationProposedValue {
  if (action.action === "set_priority") {
    if (enumIncludes(PRIORITY_SUGGESTIONS, action.proposed)) {
      return action.proposed;
    }
    throw new Error("Observation operand set_priority value is outside the closed projection.");
  }
  if (action.action === "set_horizon") {
    if (enumIncludes(HORIZON_SUGGESTIONS, action.proposed)) {
      return action.proposed;
    }
    throw new Error("Observation operand set_horizon value is outside the closed projection.");
  }
  return null;
}

function enumIncludes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Relationship targets remain observable even though model overlap no longer compiles a hold. */
function projectedCompetingIssueNumbers(action: IntakeActionDecision, competitors: readonly number[]): readonly number[] | null {
  if (action.action !== "add_relationship" && action.action !== "change_relationship") return null;
  const proposed = object(action.proposed, "relationship proposal");
  return typeof proposed.targetIssueNumber === "number" && competitors.includes(proposed.targetIssueNumber)
    ? [proposed.targetIssueNumber] : null;
}

interface IntakeObservationDerivationInput {
  readonly dispositionHistory: DispositionHistory;
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly assessment: IntakeAssessment;
  readonly decision: IntakeDecision;
  readonly existenceRecord: unknown;
  readonly verifiedOriginMainSha: string;
}

function gitSha(value: unknown, context: string): string {
  const result = string(value, context);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${context} must be a lowercase 40-character Git SHA.`);
  return result;
}

export function deriveIntakeObservationOperands(
  input: IntakeObservationDerivationInput & { readonly closeIssueRequests: readonly IntakeCloseIssueRequest[] },
): ReadonlyMap<string, IntakeObservationOperands<IntakeActionKind, IntakeCapability>>;
export function deriveIntakeObservationOperands(
  input: IntakeObservationDerivationInput & { readonly closeIssueRequests?: undefined },
): ReadonlyMap<string, IntakeObservationOperands>;
export function deriveIntakeObservationOperands(
  input: IntakeObservationDerivationInput & { readonly closeIssueRequests?: readonly IntakeCloseIssueRequest[] },
): ReadonlyMap<string, IntakeObservationOperands<IntakeActionKind, IntakeCapability>> {
  const hypothetical = compileIntakeDecisionWithQualification({
    dispositionHistory: input.dispositionHistory,
    envelope: input.envelope,
    snapshot: input.snapshot,
    assessment: input.assessment,
    existenceRecord: input.existenceRecord,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
    capabilityManifest: null,
    closeIssueRequests: input.closeIssueRequests,
    generatedAt: input.decision.generatedAt,
  }, "hypothetical_fully_qualified");
  const hypotheticalByFingerprint = new Map(
    hypothetical.candidates.map((candidate) => [candidate.sourceFingerprint, candidate]),
  );
  return new Map(input.decision.candidates.map((candidate) => {
    const counterfactual = hypotheticalByFingerprint.get(candidate.sourceFingerprint);
    if (counterfactual === undefined || counterfactual.actions.length !== candidate.actions.length) {
      throw new Error(`Hypothetical observation operands drifted for ${candidate.sourceFingerprint}.`);
    }
    const actionOperands = candidate.actions.map((action, index): IntakeObservationActionOperand<IntakeActionKind, IntakeCapability> => {
      const hypotheticalAction = counterfactual.actions[index];
      if (hypotheticalAction.action !== action.action ||
          canonicalJsonSha256(hypotheticalAction.requiredCapabilities) !== canonicalJsonSha256(action.requiredCapabilities)) {
        throw new Error(`Hypothetical observation action order drifted for ${candidate.sourceFingerprint}.`);
      }
      const competingIssueNumbers = projectedCompetingIssueNumbers(action, candidate.competingIssueNumbers);
      if (canonicalJsonSha256(projectedCompetingIssueNumbers(hypotheticalAction, counterfactual.competingIssueNumbers)) !==
          canonicalJsonSha256(competingIssueNumbers)) {
        throw new Error(`Hypothetical observation competing issues drifted for ${candidate.sourceFingerprint}.`);
      }
      return {
        action: action.action,
        observedDisposition: action.disposition,
        hypotheticalFullyQualifiedDisposition: hypotheticalAction.disposition,
        requiredCapabilities: action.requiredCapabilities,
        proposedValue: projectedValue(action),
        competingIssueNumbers,
      };
    });
    return [candidate.sourceFingerprint, {
      operandDerivationVersion: INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION,
      observedDisposition: observedDisposition(candidate),
      actionOperands,
    }];
  }));
}

export function intakeDecisionJson(decision: IntakeDecision): string {
  return prettyCanonicalJson(decision);
}

export interface IntakeCalibrationCase {
  readonly id: string;
  readonly scoringVersion: IntakeCalibrationScoringVersion;
  readonly split: "tuning" | "holdout" | "shadow" | "regression";
  readonly producerKind: ProducerKind;
  readonly expectedMatch: IntakeMatchResult;
  readonly observedMatch: IntakeMatchResult;
  /** Absent on historical cohorts; never infer filing from a model verdict or disposition. */
  readonly observedActions?: readonly IntakeActionKind[];
  /**
   * Whether the outcome is simple enough for an implementation agent to complete on its own,
   * given issue context another agent already wrote. Null means the judge could not place it,
   * which is not the same as judged-and-ineligible.
   */
  readonly routineEligible: boolean | null;
  readonly observedDisposition: AuthorityDisposition;
  readonly sensitiveActionAutomatic: boolean;
  readonly labelAuthority: "operator_approved" | "agent_judged" | "fixture_only";
  readonly sequestered: boolean;
  readonly exposure: "fresh" | "exposed";
  readonly assessmentStackSha256: string;
  readonly observedAt: string;
}

export const EXISTENCE_CALIBRATION_STATES = [
  "demonstrated",
  "partially_demonstrated",
  "not_demonstrated",
] as const;
export type ExistenceCalibrationState = typeof EXISTENCE_CALIBRATION_STATES[number];

export interface ExistenceRegressionCase {
  readonly id: string;
  readonly scoringVersion: IntakeCalibrationScoringVersion;
  readonly split: "regression";
  readonly expectedState: ExistenceCalibrationState;
  readonly observedState: ExistenceCalibrationState | null;
  readonly labelAuthority: "fixture_only";
  readonly exclusion: {
    readonly kind: "superseded_pending_reaudit";
    readonly supersededByOriginMainSha: string;
    readonly reason: string;
  } | null;
}

export interface ExistenceRegressionCohort {
  readonly auditedAgainstOriginMainSha: string;
  readonly cases: readonly ExistenceRegressionCase[];
}

export interface ExistenceRegressionScore {
  readonly sampleCount: number;
  readonly scoredCount: number;
  readonly existingCount: number;
  readonly genuinelyUnbuiltCount: number;
  readonly falseNovel: number;
  readonly falseNovelRate: number;
  readonly falseHold: number;
  readonly falseHoldRate: number;
  readonly exclusions: readonly {
    readonly id: string;
    readonly kind: "superseded_pending_reaudit";
    readonly supersededByOriginMainSha: string;
    readonly reason: string;
  }[];
}

function validateExistenceFixtureReceipt(
  receiptValue: unknown,
  satisfiedValue: unknown,
  context: string,
): void {
  if (typeof receiptValue === "number" && Number.isSafeInteger(receiptValue) && receiptValue > 0) {
    return;
  }
  if (typeof receiptValue === "string" && /^(?:#[1-9][0-9]*|[0-9a-f]{7,40})$/.test(receiptValue)) {
    return;
  }
  const receipt = object(receiptValue, `${context}.receipt`);
  exactKeys(receipt, ["path", "clause"], `${context}.receipt`);
  const path = string(receipt.path, `${context}.receipt.path`);
  if (!path.includes("/") || path.startsWith("/") || path.includes("\\")) {
    throw new Error(`${context}.receipt.path must be a repository-relative POSIX path.`);
  }
  const clause = string(receipt.clause, `${context}.receipt.clause`);
  const clauseRecorded = Array.isArray(satisfiedValue)
    ? satisfiedValue.includes(clause)
    : typeof satisfiedValue === "string" && satisfiedValue.includes(clause);
  if (!clauseRecorded) {
    throw new Error(`${context}.receipt.clause must name a clause recorded as satisfied.`);
  }
}

/** Parse the checked-in, point-in-time existence audit into regression-only scoring cases. */
export function parseExistenceRegressionCohort(rawValue: unknown): ExistenceRegressionCohort {
  const raw = object(rawValue, "existence regression cohort");
  const expected = new Map<string, ExistenceCalibrationState>();
  const addExpected = (idValue: unknown, state: ExistenceCalibrationState, context: string): void => {
    const id = string(idValue, context);
    if (expected.has(id)) throw new Error(`existence regression cohort contains duplicate case ID ${id}.`);
    expected.set(id, state);
  };
  if (!Array.isArray(raw.demonstrated) || !Array.isArray(raw.partiallyDemonstrated) ||
      !Array.isArray(raw.notDemonstratedIds)) {
    throw new Error("existence regression cohort labels must be arrays.");
  }
  raw.demonstrated.forEach((item, index) => {
    const context = `existence regression cohort.demonstrated[${index}]`;
    const value = object(item, context);
    validateExistenceFixtureReceipt(value.receipt, value.completionRule, context);
    addExpected(value.stableOutcomeId, "demonstrated", `${context}.stableOutcomeId`);
  });
  raw.partiallyDemonstrated.forEach((item, index) => {
    const context = `existence regression cohort.partiallyDemonstrated[${index}]`;
    const value = object(item, context);
    validateExistenceFixtureReceipt(value.receipt, value.satisfied, context);
    addExpected(value.stableOutcomeId, "partially_demonstrated", `${context}.stableOutcomeId`);
  });
  raw.notDemonstratedIds.forEach((id, index) => addExpected(
    id,
    "not_demonstrated",
    `existence regression cohort.notDemonstratedIds[${index}]`,
  ));
  if (raw.labelAuthority !== "fixture_only") {
    throw new Error("existence regression cohort.labelAuthority must be fixture_only.");
  }
  const counts = object(raw.counts, "existence regression cohort.counts");
  exactKeys(counts, ["demonstrated", "partiallyDemonstrated", "notDemonstrated"], "existence regression cohort.counts");
  if (counts.demonstrated !== raw.demonstrated.length ||
      counts.partiallyDemonstrated !== raw.partiallyDemonstrated.length ||
      counts.notDemonstrated !== raw.notDemonstratedIds.length) {
    throw new Error("existence regression cohort counts do not match its labels.");
  }
  const scoring = object(raw.scoring, "existence regression cohort.scoring");
  if (scoring.scoringVersion !== INTAKE_CALIBRATION_SCORING_VERSION) {
    throw new Error(`existence regression cohort.scoringVersion must be ${INTAKE_CALIBRATION_SCORING_VERSION}.`);
  }
  if (!Array.isArray(scoring.cases)) throw new Error("existence regression cohort.scoring.cases must be an array.");
  const cases = scoring.cases.map((item, index): ExistenceRegressionCase => {
    const context = `existence regression cohort.scoring.cases[${index}]`;
    const value = object(item, context);
    const id = string(value.stableOutcomeId, `${context}.stableOutcomeId`);
    const expectedState = expected.get(id);
    if (expectedState === undefined) throw new Error(`${context} does not match a labeled audit case.`);
    if (value.status === "scored") {
      exactKeys(value, ["stableOutcomeId", "status", "observedState"], context);
      if (!EXISTENCE_CALIBRATION_STATES.includes(value.observedState as ExistenceCalibrationState)) {
        throw new Error(`${context}.observedState is unsupported.`);
      }
      return {
        id,
        scoringVersion: INTAKE_CALIBRATION_SCORING_VERSION,
        split: "regression",
        expectedState,
        observedState: value.observedState as ExistenceCalibrationState,
        labelAuthority: "fixture_only",
        exclusion: null,
      };
    }
    if (value.status !== "superseded_pending_reaudit") throw new Error(`${context}.status is unsupported.`);
    exactKeys(
      value,
      ["stableOutcomeId", "status", "supersededByOriginMainSha", "reason"],
      context,
    );
    return {
      id,
      scoringVersion: INTAKE_CALIBRATION_SCORING_VERSION,
      split: "regression",
      expectedState,
      observedState: null,
      labelAuthority: "fixture_only",
      exclusion: {
        kind: "superseded_pending_reaudit",
        supersededByOriginMainSha: gitSha(value.supersededByOriginMainSha, `${context}.supersededByOriginMainSha`),
        reason: string(value.reason, `${context}.reason`),
      },
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length || cases.length !== expected.size) {
    throw new Error("existence regression scoring cases must cover every labeled audit case exactly once.");
  }
  return {
    auditedAgainstOriginMainSha: gitSha(
      raw.auditedAgainstOriginMainSha,
      "existence regression cohort.auditedAgainstOriginMainSha",
    ),
    cases,
  };
}

/** Directional scoring for the existence detector's regression-only fixture cohort. */
export function scoreExistenceRegressionCohort(
  cohort: ExistenceRegressionCohort,
): ExistenceRegressionScore {
  const scored = cohort.cases.filter((item) => item.exclusion === null);
  const existing = scored.filter((item) => item.expectedState !== "not_demonstrated");
  const genuinelyUnbuilt = scored.filter((item) => item.expectedState === "not_demonstrated");
  if (existing.length === 0) {
    throw new Error("Existence regression scoring requires a non-zero existing-class denominator after exclusions.");
  }
  if (genuinelyUnbuilt.length === 0) {
    throw new Error("Existence regression scoring requires a non-zero genuinely-unbuilt-class denominator after exclusions.");
  }
  const exclusions = cohort.cases.flatMap((item) => item.exclusion === null ? [] : [{
    id: item.id,
    ...item.exclusion,
  }]);
  const falseNovel = existing.filter((item) => item.observedState === "not_demonstrated").length;
  const falseHold = genuinelyUnbuilt.filter((item) => item.observedState !== "not_demonstrated").length;
  return {
    sampleCount: cohort.cases.length,
    scoredCount: scored.length,
    existingCount: existing.length,
    genuinelyUnbuiltCount: genuinelyUnbuilt.length,
    falseNovel,
    falseNovelRate: falseNovel / existing.length,
    falseHold,
    falseHoldRate: falseHold / genuinelyUnbuilt.length,
    exclusions,
  };
}

export function parseIntakeCalibrationCases(rawValue: unknown): IntakeCalibrationCase[] {
  const raw = object(rawValue, "calibration corpus");
  exactKeys(raw, ["schemaVersion", "qualification", "cases"], "calibration corpus");
  if (raw.schemaVersion !== INTAKE_CALIBRATION_CORPUS_SCHEMA) {
    throw new Error(`calibration corpus.schemaVersion must be ${INTAKE_CALIBRATION_CORPUS_SCHEMA}.`);
  }
  if (raw.qualification !== "fixture_only") {
    throw new Error("Checked-in calibration corpus qualification must be fixture_only.");
  }
  if (!Array.isArray(raw.cases)) throw new Error("calibration corpus.cases must be an array.");
  const cases = raw.cases.map((item, index) => {
    const context = `calibration corpus.cases[${index}]`;
    const value = object(item, context);
    const keys = [
      "id", "split", "producerKind", "expectedMatch", "observedMatch", "routineEligible",
      "observedDisposition", "sensitiveActionAutomatic", "labelAuthority", "sequestered",
      "exposure", "assessmentStackSha256", "observedAt",
    ];
    const hasScoringVersion = Object.hasOwn(value, "scoringVersion");
    const hasObservedActions = Object.hasOwn(value, "observedActions");
    exactKeys(value, [...keys, ...(hasScoringVersion ? ["scoringVersion"] : []),
      ...(hasObservedActions ? ["observedActions"] : [])], context);
    if (hasObservedActions && (!Array.isArray(value.observedActions) ||
        value.observedActions.some((action) => ![
          "replay_no_op", "create_issue", "append_evidence", "append_evidence_overlap", "close_issue", "close_issue_existence", "set_type", "set_priority", "set_effort",
          "set_horizon", "add_relationship", "change_relationship", "reopen_issue", "hold_overlap", "hold_invalid",
        ].includes(action)))) throw new Error(`${context}.observedActions contains an unsupported action.`);
    const scoringVersion = hasScoringVersion
      ? string(value.scoringVersion, `${context}.scoringVersion`)
      : INTAKE_CALIBRATION_SCORING_VERSION_PREVIOUS;
    if (!INTAKE_CALIBRATION_SCORING_VERSIONS.includes(
      scoringVersion as IntakeCalibrationScoringVersion,
    )) {
      throw new Error(`${context}.scoringVersion is unsupported.`);
    }
    if (!["tuning", "holdout", "shadow", "regression"].includes(value.split as string)) throw new Error(`${context}.split is unsupported.`);
    if (!PRODUCER_KINDS.includes(value.producerKind as ProducerKind)) throw new Error(`${context}.producerKind is unsupported.`);
    if (!INTAKE_MATCH_RESULTS.includes(value.expectedMatch as IntakeMatchResult) ||
        !INTAKE_MATCH_RESULTS.includes(value.observedMatch as IntakeMatchResult)) {
      throw new Error(`${context} contains an unsupported match result.`);
    }
    if (!AUTHORITY_DISPOSITIONS.includes(value.observedDisposition as AuthorityDisposition)) {
      throw new Error(`${context}.observedDisposition is unsupported.`);
    }
    if ((typeof value.routineEligible !== "boolean" && value.routineEligible !== null) ||
        typeof value.sensitiveActionAutomatic !== "boolean" || typeof value.sequestered !== "boolean") {
      throw new Error(`${context} boolean fields must be boolean.`);
    }
    if (value.labelAuthority !== "fixture_only") throw new Error(`${context}.labelAuthority must be fixture_only for checked-in fixtures.`);
    if (!["fresh", "exposed"].includes(value.exposure as string)) throw new Error(`${context}.exposure is unsupported.`);
    return {
      id: string(value.id, `${context}.id`),
      scoringVersion: scoringVersion as IntakeCalibrationScoringVersion,
      split: value.split as IntakeCalibrationCase["split"],
      producerKind: value.producerKind as ProducerKind,
      expectedMatch: value.expectedMatch as IntakeMatchResult,
      observedMatch: value.observedMatch as IntakeMatchResult,
      ...(hasObservedActions ? { observedActions: value.observedActions as IntakeActionKind[] } : {}),
      routineEligible: value.routineEligible,
      observedDisposition: value.observedDisposition as AuthorityDisposition,
      sensitiveActionAutomatic: value.sensitiveActionAutomatic,
      labelAuthority: "fixture_only" as const,
      sequestered: value.sequestered,
      exposure: value.exposure as IntakeCalibrationCase["exposure"],
      assessmentStackSha256: sha(value.assessmentStackSha256, `${context}.assessmentStackSha256`),
      observedAt: timestamp(value.observedAt, `${context}.observedAt`),
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("calibration corpus contains duplicate case IDs.");
  return cases;
}

function filedModelOnlyCase(item: IntakeCalibrationCase): boolean {
  return ["plausible_overlap", "invalid", "replay"].includes(item.observedMatch) &&
    item.observedActions?.includes("create_issue") === true;
}

export interface CalibrationScore {
  readonly sampleCount: number;
  readonly falseExact: number;
  readonly falseNovel: number;
  /**
   * Filed model-only overlap, invalid, or replay calls later judged to be an existing issue (`expectedMatch` of `exact_match`
   * or `replay`): the duplicate the routing change made possible, counted as an error the same way
   * `falseNovel` is. A model-only call filed and judged novel is a correct filing and is NOT counted.
   * Null for cohorts without recorded actions, rather than claiming historical model-only calls filed.
   */
  readonly falseModelOnlyFiled: number | null;
  /**
   * Null under a scoring version that does not measure it, rather than 0. A wrong hold only became
   * a failure in scoring v2; reporting 0 for a v1 cohort would read as "no disagreements" when it
   * means "not measured", which is the same confusion `persistedVerification` caused by encoding
   * recency under a name that read like binding.
   */
  readonly plausibleOverlapDisagreement: number | null;
  /** Called replay, judged otherwise. */
  readonly replayDisagreement: number;
  /** Called invalid, judged otherwise. */
  readonly invalidDisagreement: number;
  readonly sensitiveAutomatic: number;
  /**
   * A zero safety counter means one of two different things, and the gate must not read them alike.
   *
   * `falseExact` counts cases the classifier CALLED `exact_match` that were judged otherwise. When
   * no case in the cohort was observed `exact_match`, the counter is zero because the classifier was
   * never in a position to commit the error -- not because it avoided it. Same for `falseNovel` and
   * `clearly_novel`. A cohort carrying neither class satisfies both zero-error clauses without
   * exercising either direction, which certifies nothing while reading as a clean pass.
   *
   * The asymmetry is why this is surfaced rather than tolerated. A false-novel files a duplicate:
   * visible, cheap to undo. A false-exact suppresses genuinely new work: silent. A vacuous
   * `falseExact` is exactly the case where the gate says least about the error that costs most.
   *
   * Reported over the same cases the counters are scored over, so a reader can always tell which
   * reading a zero carries.
   */
  readonly falseExactVacuous: boolean;
  readonly falseNovelVacuous: boolean;
  /** Null when no case in the cohort carried a judged value; 0 means judged and none eligible. */
  readonly routineEligibleCount: number | null;
  readonly automaticRoutineEligibleCount: number | null;
  /** Routine-eligible cases the coverage bar is actually scored over (canary splits, replay excluded). */
  readonly coverageEligibleCount: number | null;
  readonly coverageAutomaticCount: number | null;
  readonly automationCoverage: number | null;
  readonly abstentionRate: number;
  readonly accuracy: number | null;
}

export interface CalibrationScoreCohort extends CalibrationScore {
  readonly scoringVersion: IntakeCalibrationScoringVersion;
}

/** Splits where the manifest is enabled during the disposable live proof, so automatic_safe is reachable. */
const COVERAGE_SPLITS = new Set<IntakeCalibrationCase["split"]>(["tuning", "holdout"]);

/**
 * Automation coverage answers exactly one question: where automation WAS possible, did the
 * classifier take it? Two exclusions keep it answering that rather than something else.
 *
 * Canary splits only. Shadow cases are recommendation-only by construction, so scoring them puts
 * every routine-eligible one in the denominator and none in the numerator. That made each additional
 * shadow decision move a corpus *further* from qualifying, and left the bar satisfiable only at
 * exactly 60 shadow cases -- measuring manifest state rather than classifier behaviour.
 *
 * Replay excluded. A replay compiles to `replay_no_op`, which `writerPlanAllowed` already treats as
 * not-a-writer-action; counting it as automation credits the classifier for declining to write.
 */
function scoredForCoverage(item: IntakeCalibrationCase): boolean {
  return COVERAGE_SPLITS.has(item.split) && item.observedMatch !== "replay";
}

function scoreCalibrationCasesForVersion(
  cases: readonly IntakeCalibrationCase[],
  scoringVersion: IntakeCalibrationScoringVersion,
): CalibrationScore {
  // Count only judged-true. An unjudged case is not evidence of ineligibility, so it must not
  // land in a denominator as though it were a judged false; where nothing was judged at all the
  // figure is null rather than 0, so "none eligible" stays distinguishable from "never asked".
  const judged = (items: readonly IntakeCalibrationCase[]) => items.filter((item) => item.routineEligible !== null);
  const countEligible = (items: readonly IntakeCalibrationCase[]): number | null =>
    judged(items).length === 0 ? null : items.filter((item) => item.routineEligible === true).length;
  const countAutomaticEligible = (items: readonly IntakeCalibrationCase[]): number | null =>
    judged(items).length === 0
      ? null
      : items.filter((item) => item.routineEligible === true && item.observedDisposition === "automatic_safe").length;

  const routineEligibleCount = countEligible(cases);
  const automaticRoutineEligibleCount = countAutomaticEligible(cases);
  const coverageCases = cases.filter(scoredForCoverage);
  const coverageEligibleCount = countEligible(coverageCases);
  const coverageAutomaticCount = countAutomaticEligible(coverageCases);
  const abstentions = cases.filter((item) => item.observedDisposition === "recommendation_only" || item.observedDisposition === "hold_no_write").length;
  const correct = cases.filter((item) => item.expectedMatch === item.observedMatch).length;
  return {
    sampleCount: cases.length,
    falseExact: cases.filter((item) => item.observedMatch === "exact_match" && item.expectedMatch !== "exact_match").length,
    falseNovel: cases.filter((item) => item.observedMatch === "clearly_novel" && item.expectedMatch !== "clearly_novel").length,
    falseModelOnlyFiled: cases.some((item) => item.observedActions !== undefined)
      ? cases.filter((item) => filedModelOnlyCase(item) &&
          (item.expectedMatch === "exact_match" || item.expectedMatch === "replay")).length
      : null,
    plausibleOverlapDisagreement: scoringVersion === INTAKE_CALIBRATION_SCORING_VERSION
      ? cases.filter((item) => item.observedMatch === "plausible_overlap" && item.expectedMatch !== "plausible_overlap").length
      : null,
    // Every observed class now carries a disagreement counter. Each keys on a distinct
    // observedMatch and a case has exactly one, so the five partition the disagreeing cases:
    // a reader can reconcile them against `accuracy`, which is scored over every case including
    // replay and invalid. Without these two, disagreements on those classes were counted nowhere
    // and the two views of the same cohort could not be squared.
    replayDisagreement: cases.filter((item) => item.observedMatch === "replay" && item.expectedMatch !== "replay").length,
    invalidDisagreement: cases.filter((item) => item.observedMatch === "invalid" && item.expectedMatch !== "invalid").length,
    sensitiveAutomatic: cases.filter((item) => item.sensitiveActionAutomatic).length,
    falseExactVacuous: !cases.some((item) => item.observedMatch === "exact_match"),
    falseNovelVacuous: !cases.some((item) => item.observedMatch === "clearly_novel"),
    routineEligibleCount,
    automaticRoutineEligibleCount,
    coverageEligibleCount,
    coverageAutomaticCount,
    automationCoverage: coverageEligibleCount === null || coverageAutomaticCount === null
      ? null
      : coverageEligibleCount === 0 ? 0 : coverageAutomaticCount / coverageEligibleCount,
    abstentionRate: cases.length === 0 ? 0 : abstentions / cases.length,
    accuracy: cases.length === 0 ? null : correct / cases.length,
  };
}

/** Score one version cohort. Mixed-version readouts must use scoreCalibrationCohorts instead. */
export function scoreCalibrationCases(cases: readonly IntakeCalibrationCase[]): CalibrationScore {
  const versions = new Set(cases.map((item) => item.scoringVersion));
  if (versions.size > 1) throw new Error("Calibration cases from different scoring versions cannot be aggregated.");
  return scoreCalibrationCasesForVersion(
    cases,
    cases[0]?.scoringVersion ?? INTAKE_CALIBRATION_SCORING_VERSION,
  );
}

/** Partition qualification-shaped figures by the scoring version that produced them. */
export function scoreCalibrationCohorts(
  cases: readonly IntakeCalibrationCase[],
): CalibrationScoreCohort[] {
  const cohorts = new Map<IntakeCalibrationScoringVersion, IntakeCalibrationCase[]>();
  for (const item of cases) {
    const cohort = cohorts.get(item.scoringVersion) ?? [];
    cohort.push(item);
    cohorts.set(item.scoringVersion, cohort);
  }
  return [...cohorts.entries()]
    // Code-point order, not locale order: cohort ordering must not vary with the host's ICU data.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([scoringVersion, cohort]) => ({
      scoringVersion,
      ...scoreCalibrationCasesForVersion(cohort, scoringVersion),
    }));
}

export interface CalibrationQualification extends CalibrationScore {
  readonly tuningCount: number;
  readonly holdoutCount: number;
  readonly shadowCount: number;
  readonly disposableCanaryQualified: boolean;
  readonly productionQualified: boolean;
  readonly reasons: readonly string[];
}

export function evaluateCalibrationQualification(
  cases: readonly IntakeCalibrationCase[],
  expectedAssessmentStackSha256: string,
): CalibrationQualification {
  const score = scoreCalibrationCases(cases);
  const tuning = cases.filter((item) => item.split === "tuning");
  const holdout = cases.filter((item) => item.split === "holdout");
  const shadow = cases.filter((item) => item.split === "shadow");
  const reasons: string[] = [];
  const allBound = cases.every((item) => item.assessmentStackSha256 === expectedAssessmentStackSha256);
  const labeled = (items: readonly IntakeCalibrationCase[]) => items.every((item) => item.labelAuthority === "operator_approved");
  const addLabelRefusal = (items: readonly IntakeCalibrationCase[], cohort: string): void => {
    if (items.some((item) => item.labelAuthority === "agent_judged")) {
      reasons.push(`agent-judged labels in ${cohort} cannot qualify`);
    }
    if (items.some((item) => item.labelAuthority === "fixture_only")) {
      reasons.push(`${cohort} labels are fixture-only or lack the operator approval`);
    }
  };
  const freshHoldout = holdout.every((item) => item.sequestered && item.exposure === "fresh");
  const zeroSafetyCounters = score.falseExact === 0 && score.falseNovel === 0 &&
    (score.falseModelOnlyFiled === null || score.falseModelOnlyFiled === 0) && score.sensitiveAutomatic === 0;
  // A zero counter is only evidence where the error was reachable.
  //
  // Required PER SPLIT, not pooled across the canary. Pooling is satisfiable with every exercise
  // landing in tuning while holdout stays silent, and holdout's zero-error counters are then
  // vacuous in exactly the sense this guard exists to remove -- the defect relocated inside the
  // guard rather than removed by it. Holdout is the split that carries certification force, so it
  // is the one that least tolerates an unexercised direction.
  //
  // Shadow cases are excluded for the same reason coverage excludes them: the canary verdict must
  // not rest on cases outside the splits it certifies.
  const exercised = (items: readonly IntakeCalibrationCase[], match: IntakeCalibrationCase["observedMatch"]) =>
    items.some((item) => item.observedMatch === match);
  const splitExercises = [
    { split: "tuning", cases: tuning },
    { split: "holdout", cases: holdout },
  ] as const;
  const safetyExercised = splitExercises.every(({ cases: items }) =>
    exercised(items, "exact_match") && exercised(items, "clearly_novel") && items.some(filedModelOnlyCase));
  const safetyPass = zeroSafetyCounters && safetyExercised;
  // Explicit null check rather than leaning on `null >= 0.5` coercing to false: an unmeasured
  // coverage figure must not qualify, and the reason should be legible at the comparison site.
  const coveragePass = score.automationCoverage !== null && score.automationCoverage >= 0.5;
  if (!allBound) reasons.push("assessment stack drift requires a new calibration release");
  if (tuning.length !== 40) reasons.push("exactly 40 tuning cases are required");
  if (holdout.length !== 20) reasons.push("exactly 20 fresh sequestered holdout cases are required");
  if (!freshHoldout) reasons.push("holdout must be freshly sequestered and previously unexposed");
  if (!labeled([...tuning, ...holdout])) addLabelRefusal([...tuning, ...holdout], "tuning and holdout");
  // Two distinct refusals. Collapsing them would reproduce the defect this guard exists to remove:
  // a reader could not tell "the classifier committed the error" from "the error was unreachable".
  if (!zeroSafetyCounters) reasons.push("zero false exact, false novel, and sensitive-automatic outcomes are required");
  if (score.falseModelOnlyFiled !== null && score.falseModelOnlyFiled > 0) reasons.push("zero model-only filings later judged duplicates are required");
  for (const { split, cases: items } of splitExercises) {
    if (!items.some(filedModelOnlyCase)) {
      reasons.push(`zero false model-only filings is vacuous in ${split}: no ${split} case recorded create_issue with observed plausible_overlap, invalid, or replay, so model-only duplicate filing was never exercised there`);
    }
    if (!exercised(items, "exact_match")) {
      reasons.push(`zero false-exact is vacuous in ${split}: no ${split} case was observed exact_match, so suppression of genuinely new work was never exercised there`);
    }
    if (!exercised(items, "clearly_novel")) {
      reasons.push(`zero false-novel is vacuous in ${split}: no ${split} case was observed clearly_novel, so duplicate filing was never exercised there`);
    }
  }
  if (!coveragePass) reasons.push("at least 50% automation coverage among routine-eligible canary cases (tuning and holdout, excluding replay) is required");
  const disposableCanaryQualified = allBound && tuning.length === 40 && holdout.length === 20 && freshHoldout &&
    labeled([...tuning, ...holdout]) && safetyPass && coveragePass;
  if (shadow.length < 60) reasons.push("at least 60 newly observed recommendation-only shadow decisions are required");
  if (!labeled(shadow)) addLabelRefusal(shadow, "shadow");
  const productionQualified = disposableCanaryQualified && shadow.length >= 60 && labeled(shadow);
  return {
    ...score,
    tuningCount: tuning.length,
    holdoutCount: holdout.length,
    shadowCount: shadow.length,
    disposableCanaryQualified,
    productionQualified,
    reasons: [...new Set(reasons)],
  };
}
