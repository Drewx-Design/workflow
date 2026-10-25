import { createHash } from "node:crypto";

import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import type { IntakeSnapshotV1 } from "./intake-snapshot";
import { effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-selection";
import { AUTOMATIC_INTAKE_LIMITS } from "./capability-manifest";
import {
  CONFIDENCE_LEVELS,
  EFFORT_SUGGESTIONS,
  ISSUE_TYPE_SUGGESTIONS,
  PRIORITY_SUGGESTIONS,
  RELATIONSHIP_KINDS,
  validateSha256,
  validateSafeSourceLocator,
  validateStableIdentifier,
  type Confidence,
  type EffortSuggestion,
  type IssueTypeSuggestion,
  type OutcomeEnvelope,
  type PrioritySuggestion,
  type RelationshipKind,
} from "./outcome-candidate";

export const INTAKE_ASSESSMENT_SCHEMA = "github-issue-roadmap-intake-assessment/v1";
export const ASSESSMENT_STACK_DESCRIPTOR_SCHEMA = "github-issue-roadmap-assessment-stack/v1" as const;
export const INTAKE_MATCH_RESULTS = ["replay", "exact_match", "plausible_overlap", "clearly_novel", "invalid"] as const;
export const HORIZON_SUGGESTIONS = ["Now", "Next", "Later", "Parked"] as const;

export type IntakeMatchResult = typeof INTAKE_MATCH_RESULTS[number];
export type HorizonSuggestion = typeof HORIZON_SUGGESTIONS[number];

export interface AssessmentStackIdentity {
  readonly provider: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly rubricSha256: string;
  readonly toolchainSha256: string;
  readonly calibrationRelease: string;
}

export interface AssessmentStackDescriptor extends AssessmentStackIdentity {
  readonly schemaVersion: typeof ASSESSMENT_STACK_DESCRIPTOR_SCHEMA;
  readonly promptLocator: string;
}

export interface AssessedValue<T extends string> {
  readonly value: T | null;
  readonly confidence: Confidence;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

export interface CandidateIntakeAssessment {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
  readonly match: {
    readonly result: IntakeMatchResult;
    readonly confidence: Confidence;
    readonly canonicalIssueNumber: number | null;
    readonly competingIssueNumbers: readonly number[];
    readonly evidenceIds: readonly string[];
    readonly rationale: string;
  };
  readonly classification: {
    readonly type: AssessedValue<IssueTypeSuggestion>;
    readonly priority: AssessedValue<PrioritySuggestion>;
    readonly effort: AssessedValue<EffortSuggestion>;
    readonly horizon: AssessedValue<HorizonSuggestion>;
  };
  readonly relationships: readonly {
    readonly kind: RelationshipKind;
    readonly targetIssueNumber: number;
    readonly conflict: boolean;
    readonly confidence: Confidence;
    readonly evidenceIds: readonly string[];
    readonly rationale: string;
  }[];
  readonly completionContradicted: boolean;
}

export interface IntakeAssessment {
  readonly schemaVersion: typeof INTAKE_ASSESSMENT_SCHEMA;
  readonly candidateSha256: string;
  readonly snapshotContentSha256: string;
  readonly snapshotCoverageSha256: string;
  readonly generatedAt: string;
  readonly stack: AssessmentStackIdentity;
  readonly candidates: readonly CandidateIntakeAssessment[];
  readonly skipped?: readonly IntakeDispositionSkip[];
  readonly attention: {
    readonly issueNumber: number | null;
    readonly evidenceRefresh: string | null;
    readonly decision: string | null;
    readonly tradeoff: string | null;
    readonly evidenceIds: readonly string[];
    readonly rationale: string;
  };
}

/** Terminal outcomes are accounted for separately and have no assessment or writer action. */
export interface IntakeDispositionSkip {
  readonly sourceFingerprint: string;
  readonly stableOutcomeId: string;
  readonly status: "dispositioned";
}

export function intakeDispositionSkips(envelope: OutcomeEnvelope, history: DispositionHistory = new Map()): IntakeDispositionSkip[] {
  return effectiveOutcomeCandidates(envelope, history).dispositioned.map(candidate => ({
    sourceFingerprint: candidate.sourceFingerprint, stableOutcomeId: candidate.stableOutcomeId,
    status: "dispositioned",
  }));
}

/** Enforce byte limits before parsing, including material that will subsequently be skipped. */
export function assertIntakeEnvelopeByteBudgets(raw: unknown): void {
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeBytes) throw new Error("Automatic intake envelope exceeds the approved 64 KiB limit.");
  const candidates = raw !== null && typeof raw === "object" ? (raw as { candidates?: unknown }).candidates : undefined;
  if (!Array.isArray(candidates)) return; // The envelope parser owns shape errors.
  for (const [index, candidate] of candidates.entries()) {
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > AUTOMATIC_INTAKE_LIMITS.maxCandidateBytes) throw new Error(`Automatic intake candidate ${index} exceeds the approved 16 KiB limit.`);
  }
}

/** Count the effective set, while byte budgets continue to bind all original material. */
export function assertEffectiveIntakeEnvelopeBudgets(raw: unknown, envelope: OutcomeEnvelope, history: DispositionHistory): void {
  assertIntakeEnvelopeByteBudgets(raw);
  if (effectiveOutcomeCandidates(envelope, history).active.length > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeCandidates) throw new Error("Automatic intake accepts at most five active candidates per envelope.");
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} must contain exact keys [${wanted.join(", ")}].`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string.`);
  return value.trim().replace(/\r\n/g, "\n");
}

function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : string(value, context);
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${context} must be a positive integer.`);
  return value as number;
}

function nullablePositiveInteger(value: unknown, context: string): number | null {
  return value === null ? null : positiveInteger(value, context);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${context} is unsupported.`);
  return value as T;
}

function confidence(value: unknown, context: string): Confidence {
  return enumValue(value, CONFIDENCE_LEVELS, context);
}

function sortedUniqueNumbers(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const result = value.map((item, index) => positiveInteger(item, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicates.`);
  return result.sort((left, right) => left - right);
}

export function intakeSnapshotEvidenceIds(snapshot: IntakeSnapshotV1): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const issue of snapshot.issues) {
    const prefix = `issue:${issue.number}`;
    ids.add(`${prefix}:snapshot`);
    ids.add(`${prefix}:body`);
    ids.add(`${prefix}:fields`);
    ids.add(`${prefix}:relationships`);
    issue.evidence.forEach((_item, index) => ids.add(`${prefix}:evidence:${index}`));
    issue.comments.forEach((comment) => ids.add(`${prefix}:comment:${comment.databaseId}`));
  }
  return ids;
}

function allowedEvidenceIds(envelope: OutcomeEnvelope, snapshot: IntakeSnapshotV1, history: DispositionHistory): ReadonlySet<string> {
  const ids = new Set(intakeSnapshotEvidenceIds(snapshot));
  for (const candidate of effectiveOutcomeCandidates(envelope, history).active) {
    candidate.evidence.forEach((item) => ids.add(item.id));
    candidate.provenance.forEach((item) => ids.add(item.id));
  }
  return ids;
}

function evidenceIds(value: unknown, context: string, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must be a non-empty array.`);
  const result = value.map((item, index) => validateStableIdentifier(item, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicates.`);
  for (const id of result) if (!allowed.has(id)) throw new Error(`${context} cites evidence outside the bound candidate and snapshot: ${id}.`);
  return result.sort();
}

export function intakeSnapshotCoverageSha256(snapshot: IntakeSnapshotV1): string {
  return canonicalJsonSha256({ coverage: snapshot.coverage, census: snapshot.census, receipts: snapshot.receipts });
}

function assertSnapshotIntegrity(snapshot: IntakeSnapshotV1): void {
  const contentSha256 = canonicalJsonSha256({
    candidateSha256: snapshot.candidateSha256,
    canonicalSnapshotV2Sha256: snapshot.canonicalSnapshotV2Sha256,
    repository: snapshot.repository,
    censusContentSha256: snapshot.censusContentSha256,
    issues: snapshot.issues,
    markerIndex: snapshot.markerIndex,
    markerIncidents: snapshot.markerIncidents,
    projectObservation: snapshot.projectObservation,
    receipts: snapshot.receipts,
  });
  if (contentSha256 !== snapshot.contentSha256) throw new Error("Intake snapshot content hash does not match its evidence payload.");
}

export function assessmentStackSha256(stack: AssessmentStackIdentity): string {
  return canonicalJsonSha256({
    provider: stack.provider,
    model: stack.model,
    promptSha256: stack.promptSha256,
    rubricSha256: stack.rubricSha256,
    toolchainSha256: stack.toolchainSha256,
    calibrationRelease: stack.calibrationRelease,
  });
}

export function parseAssessmentStackIdentity(value: unknown): AssessmentStackIdentity {
  const raw = object(value, "assessment.stack");
  exactKeys(raw, ["provider", "model", "promptSha256", "rubricSha256", "toolchainSha256", "calibrationRelease"], "assessment.stack");
  return {
    provider: string(raw.provider, "assessment.stack.provider"),
    model: string(raw.model, "assessment.stack.model"),
    promptSha256: validateSha256(raw.promptSha256, "assessment.stack.promptSha256"),
    rubricSha256: validateSha256(raw.rubricSha256, "assessment.stack.rubricSha256"),
    toolchainSha256: validateSha256(raw.toolchainSha256, "assessment.stack.toolchainSha256"),
    calibrationRelease: validateStableIdentifier(raw.calibrationRelease, "assessment.stack.calibrationRelease"),
  };
}

export function assertAssessmentStackIdentity(
  actual: AssessmentStackIdentity,
  expected: AssessmentStackIdentity,
): void {
  if (assessmentStackSha256(actual) !== assessmentStackSha256(expected)) {
    throw new Error("Assessment stack identity does not match the requested provider, model, prompt, rubric, toolchain, and calibration release.");
  }
}

/** Parse the checked-in stack descriptor and prove its hash against canonical cross-platform text. */
export function parseAssessmentStackDescriptor(
  value: unknown,
  promptContents: string,
  expectedPromptLocator?: string,
): AssessmentStackDescriptor {
  const raw = object(value, "assessment stack descriptor");
  exactKeys(raw, [
    "schemaVersion", "promptLocator", "provider", "model", "promptSha256",
    "rubricSha256", "toolchainSha256", "calibrationRelease",
  ], "assessment stack descriptor");
  if (raw.schemaVersion !== ASSESSMENT_STACK_DESCRIPTOR_SCHEMA) {
    throw new Error(`assessment stack descriptor.schemaVersion must be ${ASSESSMENT_STACK_DESCRIPTOR_SCHEMA}.`);
  }
  const promptLocator = validateSafeSourceLocator(raw.promptLocator, "assessment stack descriptor.promptLocator");
  if (expectedPromptLocator !== undefined && promptLocator !== expectedPromptLocator) {
    throw new Error("Assessment stack descriptor prompt locator does not match the requested prompt asset.");
  }
  const identity = parseAssessmentStackIdentity({
    provider: raw.provider,
    model: raw.model,
    promptSha256: raw.promptSha256,
    rubricSha256: raw.rubricSha256,
    toolchainSha256: raw.toolchainSha256,
    calibrationRelease: raw.calibrationRelease,
  });
  const actualPromptSha256 = createHash("sha256")
    .update(promptContents.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
  if (identity.promptSha256 !== actualPromptSha256) {
    throw new Error("Assessment stack descriptor promptSha256 does not match the exact prompt asset bytes.");
  }
  return { schemaVersion: ASSESSMENT_STACK_DESCRIPTOR_SCHEMA, promptLocator, ...identity };
}

function parseAssessedValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  context: string,
  allowedEvidence: ReadonlySet<string>,
): AssessedValue<T> {
  const raw = object(value, context);
  exactKeys(raw, ["value", "confidence", "evidenceIds", "rationale"], context);
  return {
    value: raw.value === null ? null : enumValue(raw.value, allowedValues, `${context}.value`),
    confidence: confidence(raw.confidence, `${context}.confidence`),
    evidenceIds: evidenceIds(raw.evidenceIds, `${context}.evidenceIds`, allowedEvidence),
    rationale: string(raw.rationale, `${context}.rationale`),
  };
}

function parseCandidateAssessment(
  value: unknown,
  index: number,
  candidatesByFingerprint: ReadonlyMap<string, OutcomeEnvelope["candidates"][number]>,
  snapshotIssueNumbers: ReadonlySet<number>,
  allowedEvidence: ReadonlySet<string>,
): CandidateIntakeAssessment {
  const context = `assessment.candidates[${index}]`;
  const raw = object(value, context);
  exactKeys(raw, ["sourceFingerprint", "emissionContentSha256", "match", "classification", "relationships", "completionContradicted"], context);
  const sourceFingerprint = validateSha256(raw.sourceFingerprint, `${context}.sourceFingerprint`);
  const candidate = candidatesByFingerprint.get(sourceFingerprint);
  if (candidate === undefined) throw new Error(`${context} is outside the bound candidate envelope.`);
  const emissionContentSha256 = validateSha256(raw.emissionContentSha256, `${context}.emissionContentSha256`);
  if (candidate.emissionContentSha256 !== emissionContentSha256) throw new Error(`${context} emission hash does not match the candidate.`);

  const matchRaw = object(raw.match, `${context}.match`);
  exactKeys(matchRaw, ["result", "confidence", "canonicalIssueNumber", "competingIssueNumbers", "evidenceIds", "rationale"], `${context}.match`);
  const canonicalIssueNumber = nullablePositiveInteger(matchRaw.canonicalIssueNumber, `${context}.match.canonicalIssueNumber`);
  const competingIssueNumbers = sortedUniqueNumbers(matchRaw.competingIssueNumbers, `${context}.match.competingIssueNumbers`);
  if (canonicalIssueNumber !== null && !snapshotIssueNumbers.has(canonicalIssueNumber)) throw new Error(`${context}.match canonical issue is outside snapshot coverage.`);
  for (const issueNumber of competingIssueNumbers) {
    if (!snapshotIssueNumbers.has(issueNumber)) throw new Error(`${context}.match competing issue #${issueNumber} is outside snapshot coverage.`);
  }
  const result = enumValue(matchRaw.result, INTAKE_MATCH_RESULTS, `${context}.match.result`);
  if (["replay", "exact_match"].includes(result) !== (canonicalIssueNumber !== null)) {
    throw new Error(`${context}.match exact/replay result requires exactly one canonical issue.`);
  }
  if (result === "plausible_overlap" && competingIssueNumbers.length === 0) throw new Error(`${context}.match plausible overlap requires competing issues.`);
  if (result === "clearly_novel" && (canonicalIssueNumber !== null || competingIssueNumbers.length > 0)) {
    throw new Error(`${context}.match clearly novel cannot name canonical or competing issues.`);
  }

  const classificationRaw = object(raw.classification, `${context}.classification`);
  exactKeys(classificationRaw, ["type", "priority", "effort", "horizon"], `${context}.classification`);
  if (!Array.isArray(raw.relationships)) throw new Error(`${context}.relationships must be an array.`);
  const relationships = raw.relationships.map((item, relationshipIndex) => {
    const relationshipContext = `${context}.relationships[${relationshipIndex}]`;
    const relationship = object(item, relationshipContext);
    exactKeys(relationship, ["kind", "targetIssueNumber", "conflict", "confidence", "evidenceIds", "rationale"], relationshipContext);
    if (typeof relationship.conflict !== "boolean") throw new Error(`${relationshipContext}.conflict must be boolean.`);
    return {
      kind: enumValue(relationship.kind, RELATIONSHIP_KINDS, `${relationshipContext}.kind`),
      targetIssueNumber: positiveInteger(relationship.targetIssueNumber, `${relationshipContext}.targetIssueNumber`),
      conflict: relationship.conflict,
      confidence: confidence(relationship.confidence, `${relationshipContext}.confidence`),
      evidenceIds: evidenceIds(relationship.evidenceIds, `${relationshipContext}.evidenceIds`, allowedEvidence),
      rationale: string(relationship.rationale, `${relationshipContext}.rationale`),
    };
  });
  if (typeof raw.completionContradicted !== "boolean") throw new Error(`${context}.completionContradicted must be boolean.`);
  return {
    sourceFingerprint,
    emissionContentSha256,
    match: {
      result,
      confidence: confidence(matchRaw.confidence, `${context}.match.confidence`),
      canonicalIssueNumber,
      competingIssueNumbers,
      evidenceIds: evidenceIds(matchRaw.evidenceIds, `${context}.match.evidenceIds`, allowedEvidence),
      rationale: string(matchRaw.rationale, `${context}.match.rationale`),
    },
    classification: {
      type: parseAssessedValue(classificationRaw.type, ISSUE_TYPE_SUGGESTIONS, `${context}.classification.type`, allowedEvidence),
      priority: parseAssessedValue(classificationRaw.priority, PRIORITY_SUGGESTIONS, `${context}.classification.priority`, allowedEvidence),
      effort: parseAssessedValue(classificationRaw.effort, EFFORT_SUGGESTIONS, `${context}.classification.effort`, allowedEvidence),
      horizon: parseAssessedValue(classificationRaw.horizon, HORIZON_SUGGESTIONS, `${context}.classification.horizon`, allowedEvidence),
    },
    relationships,
    completionContradicted: raw.completionContradicted,
  };
}

export function parseIntakeAssessment(
  rawValue: unknown,
  envelope: OutcomeEnvelope,
  snapshot: IntakeSnapshotV1,
  expectedStack: AssessmentStackIdentity | undefined,
  history: DispositionHistory,
): IntakeAssessment {
  assertSnapshotIntegrity(snapshot);
  if (envelope.repository.databaseId !== snapshot.repository.databaseId || envelope.repository.nodeId !== snapshot.repository.nodeId ||
      envelope.repository.organization.toLowerCase() !== snapshot.repository.organization.toLowerCase() ||
      envelope.repository.name.toLowerCase() !== snapshot.repository.name.toLowerCase()) {
    throw new Error("Assessment envelope and intake snapshot repository identities disagree.");
  }
  const raw = object(rawValue, "assessment");
  exactKeys(raw, ["schemaVersion", "candidateSha256", "snapshotContentSha256", "snapshotCoverageSha256", "generatedAt", "stack", "candidates", "attention", ...(Object.hasOwn(raw, "skipped") ? ["skipped"] : [])], "assessment");
  if (raw.schemaVersion !== INTAKE_ASSESSMENT_SCHEMA) throw new Error(`assessment.schemaVersion must be ${INTAKE_ASSESSMENT_SCHEMA}.`);
  const candidateSha256 = validateSha256(raw.candidateSha256, "assessment.candidateSha256");
  if (candidateSha256 !== canonicalJsonSha256(envelope) || candidateSha256 !== snapshot.candidateSha256) {
    throw new Error("Assessment candidate binding does not match the envelope and intake snapshot.");
  }
  const snapshotContentSha256 = validateSha256(raw.snapshotContentSha256, "assessment.snapshotContentSha256");
  if (snapshotContentSha256 !== snapshot.contentSha256) throw new Error("Assessment snapshot content binding does not match.");
  const snapshotCoverageSha256 = validateSha256(raw.snapshotCoverageSha256, "assessment.snapshotCoverageSha256");
  if (snapshotCoverageSha256 !== intakeSnapshotCoverageSha256(snapshot)) throw new Error("Assessment snapshot coverage binding does not match.");
  if (typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))) throw new Error("assessment.generatedAt must be an ISO timestamp.");
  if (!Array.isArray(raw.candidates)) throw new Error("assessment.candidates must be an array.");
  const selection = effectiveOutcomeCandidates(envelope, history);
  const skipped = intakeDispositionSkips(envelope, history);
  if (Object.hasOwn(raw, "skipped") && canonicalJsonSha256(raw.skipped) !== canonicalJsonSha256(skipped)) {
    throw new Error("Assessment skipped entries do not match dispositioned candidates.");
  }
  const skippedFingerprints = new Set(skipped.map(candidate => candidate.sourceFingerprint));
  const allowedEvidence = allowedEvidenceIds(envelope, snapshot, history);
  const candidatesByFingerprint = new Map(
    selection.active.map((candidate) => [candidate.sourceFingerprint, candidate]),
  );
  const snapshotIssueNumbers = new Set(snapshot.issues.map((issue) => issue.number));
  // Retained assessments may predate a disposition. Do not assess their terminal entries again.
  const candidates = raw.candidates.filter(item => !skippedFingerprints.has(
    item !== null && typeof item === "object" ? (item as JsonObject).sourceFingerprint as string : "",
  )).map((item, index) => parseCandidateAssessment(
    item,
    index,
    candidatesByFingerprint,
    snapshotIssueNumbers,
    allowedEvidence,
  ));
  const fingerprints = candidates.map((candidate) => candidate.sourceFingerprint);
  const expected = selection.active.map((candidate) => candidate.sourceFingerprint).sort();
  if (new Set(fingerprints).size !== fingerprints.length || JSON.stringify([...fingerprints].sort()) !== JSON.stringify(expected)) {
    throw new Error("Assessment must contain exactly one entry for every bound candidate.");
  }

  const attentionRaw = selection.active.length === 0
    ? { issueNumber: null, evidenceRefresh: null, decision: "No active candidates; dispositioned outcomes skipped.", tradeoff: null,
        evidenceIds: [], rationale: "Every bound outcome is dispositioned; zero writes." }
    : object(raw.attention, "assessment.attention");
  exactKeys(attentionRaw, ["issueNumber", "evidenceRefresh", "decision", "tradeoff", "evidenceIds", "rationale"], "assessment.attention");
  const issueNumber = nullablePositiveInteger(attentionRaw.issueNumber, "assessment.attention.issueNumber");
  if (issueNumber !== null && !snapshotIssueNumbers.has(issueNumber)) throw new Error("assessment.attention issue is outside snapshot coverage.");
  const evidenceRefresh = nullableString(attentionRaw.evidenceRefresh, "assessment.attention.evidenceRefresh");
  const decision = nullableString(attentionRaw.decision, "assessment.attention.decision");
  const tradeoff = nullableString(attentionRaw.tradeoff, "assessment.attention.tradeoff");
  if (issueNumber === null && [evidenceRefresh, decision, tradeoff].filter((item) => item !== null).length !== 1) {
    throw new Error("Attention fallback must name exactly one concrete evidence refresh, decision, or tradeoff.");
  }
  const stack = parseAssessmentStackIdentity(raw.stack);
  if (expectedStack !== undefined) assertAssessmentStackIdentity(stack, expectedStack);
  const attentionEvidence = Array.isArray(attentionRaw.evidenceIds) ? attentionRaw.evidenceIds.filter(id =>
    allowedEvidence.has(id) || !selection.dispositioned.some(candidate => [...candidate.evidence, ...candidate.provenance].some(evidence => evidence.id === id)),
  ) : attentionRaw.evidenceIds;
  return {
    schemaVersion: INTAKE_ASSESSMENT_SCHEMA,
    candidateSha256,
    snapshotContentSha256,
    snapshotCoverageSha256,
    generatedAt: new Date(raw.generatedAt).toISOString(),
    stack,
    candidates: candidates.sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint)),
    ...(skipped.length > 0 || Object.hasOwn(raw, "skipped") ? { skipped } : {}),
    attention: {
      issueNumber,
      evidenceRefresh,
      decision,
      tradeoff,
      evidenceIds: skipped.length > 0 && Array.isArray(attentionEvidence) && attentionEvidence.length === 0
        ? [] : evidenceIds(attentionEvidence, "assessment.attention.evidenceIds", allowedEvidence),
      rationale: string(attentionRaw.rationale, "assessment.attention.rationale"),
    },
  };
}

export function intakeAssessmentJson(assessment: IntakeAssessment): string {
  return prettyCanonicalJson(assessment);
}

export function intakeAssessmentSha256(assessment: IntakeAssessment): string {
  return canonicalJsonSha256(assessment);
}
