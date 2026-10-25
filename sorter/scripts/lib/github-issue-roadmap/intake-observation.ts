import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export const INTAKE_OBSERVATION_SCHEMA_V1 = "github-issue-roadmap-provisional-observation-input/v1" as const;
export const INTAKE_OBSERVATION_SCHEMA_V2 = "github-issue-roadmap-provisional-observation-input/v2" as const;
export const INTAKE_OBSERVATION_SCHEMA = INTAKE_OBSERVATION_SCHEMA_V2;
export const INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1 =
  "github-issue-roadmap-observation-operands/v1" as const;
export const INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V2 =
  "github-issue-roadmap-observation-operands/v2" as const;
export const INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION =
  "github-issue-roadmap-observation-operands/v3" as const;
export type IntakeObservationOperandDerivationVersion =
  | typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1
  | typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V2
  | typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION;
export const INTAKE_ATTEMPT_SCHEMA = "github-issue-roadmap-provisional-observation-attempt/v1" as const;
export const INTAKE_OBSERVATION_DIRECTORY = "artifacts/github-issue-roadmap/observations" as const;
export const INTAKE_ATTEMPT_DIRECTORY = "artifacts/github-issue-roadmap/attempts" as const;

const PRODUCER_KINDS = [
  "plan",
  "brainstorm",
  "ideation",
  "audit",
  "implementation_discovery",
  "future_user_bug",
] as const;
const OBSERVED_MATCHES = ["replay", "exact_match", "plausible_overlap", "clearly_novel", "invalid"] as const;
const AUTHORITY_DISPOSITIONS = ["automatic_safe", "approval_required", "hold_no_write", "recommendation_only"] as const;
const ACTION_KINDS = [
  "replay_no_op", "create_issue", "append_evidence", "set_type", "set_priority", "set_effort",
  "append_evidence_overlap", "close_issue_existence",
  "set_horizon", "add_relationship", "change_relationship", "reopen_issue", "hold_overlap", "hold_invalid",
] as const;
const CAPABILITIES = ["create_issue", "append_evidence", "append_evidence_overlap", "close_issue_existence", "set_type", "set_priority", "set_effort"] as const;
const PRIORITY_PROPOSED_VALUES = ["P0", "P1", "P2", "P3"] as const;
const HORIZON_PROPOSED_VALUES = ["Now", "Next", "Later", "Parked"] as const;
const PROPOSED_VALUES = [...PRIORITY_PROPOSED_VALUES, ...HORIZON_PROPOSED_VALUES] as const;
const ATTEMPT_STAGES = [
  "input_paths",
  "candidate_read",
  "candidate_validate",
  "snapshot_read",
  "snapshot_validate",
  "snapshot_freshness",
  "assessment_read",
  "assessment_validate",
  "capability_read",
  "capability_validate",
  "decision_compile",
] as const;
const FAILURE_CATEGORIES = ["read", "validation", "binding", "compile"] as const;
const FAILURE_CODES = [
  "input_paths_invalid",
  "candidate_unreadable",
  "candidate_invalid",
  "snapshot_unreadable",
  "snapshot_invalid",
  "snapshot_stale",
  "assessment_unreadable",
  "assessment_invalid",
  "capability_unreadable",
  "capability_invalid",
  "decision_invalid",
] as const;

const ATTEMPT_FAILURE_BY_STAGE = {
  input_paths: { category: "validation", code: "input_paths_invalid" },
  candidate_read: { category: "read", code: "candidate_unreadable" },
  candidate_validate: { category: "validation", code: "candidate_invalid" },
  snapshot_read: { category: "read", code: "snapshot_unreadable" },
  snapshot_validate: { category: "validation", code: "snapshot_invalid" },
  snapshot_freshness: { category: "binding", code: "snapshot_stale" },
  assessment_read: { category: "read", code: "assessment_unreadable" },
  assessment_validate: { category: "binding", code: "assessment_invalid" },
  capability_read: { category: "read", code: "capability_unreadable" },
  capability_validate: { category: "validation", code: "capability_invalid" },
  decision_compile: { category: "compile", code: "decision_invalid" },
} as const satisfies Record<typeof ATTEMPT_STAGES[number], {
  readonly category: typeof FAILURE_CATEGORIES[number];
  readonly code: typeof FAILURE_CODES[number];
}>;

export type IntakeObservationProducerKind = typeof PRODUCER_KINDS[number];
export type IntakeObservationMatch = typeof OBSERVED_MATCHES[number];

export type IntakeAttemptStage = typeof ATTEMPT_STAGES[number];

export type IntakeAttemptFailure = Readonly<{
  category: typeof FAILURE_CATEGORIES[number];
  code: typeof FAILURE_CODES[number];
}>;

export interface IntakeObservationBinding {
  readonly locator: string;
  readonly contentSha256: string;
}

export interface IntakeCandidateObservationBinding extends IntakeObservationBinding {
  readonly sourceFingerprint: string;
}

export interface IntakeAttemptCandidateBinding extends IntakeObservationBinding {
  readonly producerKind: IntakeObservationProducerKind;
}

export interface IntakeAttemptAssessmentBinding {
  readonly contentSha256: string;
  readonly stackSha256: string;
}

interface IntakeObservationRecordBase {
  readonly observationId: string;
  readonly candidate: IntakeCandidateObservationBinding;
  readonly snapshot: IntakeObservationBinding;
  readonly decisionSha256: string;
  readonly assessmentSha256: string;
  readonly assessmentStackSha256: string;
  readonly producerKind: IntakeObservationProducerKind;
  readonly observedMatch: IntakeObservationMatch;
  readonly observedAt: string;
}

export interface IntakeObservationRecordV1 extends IntakeObservationRecordBase {
  readonly schemaVersion: typeof INTAKE_OBSERVATION_SCHEMA_V1;
}

export interface IntakeObservationActionOperand {
  readonly action: typeof ACTION_KINDS[number];
  readonly observedDisposition: typeof AUTHORITY_DISPOSITIONS[number];
  readonly hypotheticalFullyQualifiedDisposition: typeof AUTHORITY_DISPOSITIONS[number];
  readonly requiredCapabilities: readonly typeof CAPABILITIES[number][];
  readonly proposedValue: typeof PROPOSED_VALUES[number] | null;
  /**
   * Null means the concept does not apply (or the operand is v1); [] means recorded and empty.
   * Consumers distinguish v1's never-recorded null from v2's does-not-apply null via
   * operandDerivationVersion.
   */
  readonly competingIssueNumbers: readonly number[] | null;
}

export interface IntakeObservationRecordV2 extends IntakeObservationRecordBase {
  readonly schemaVersion: typeof INTAKE_OBSERVATION_SCHEMA_V2;
  readonly operandDerivationVersion: IntakeObservationOperandDerivationVersion;
  readonly observedDisposition: typeof AUTHORITY_DISPOSITIONS[number];
  readonly actionOperands: readonly IntakeObservationActionOperand[];
}

export type IntakeObservationRecord = IntakeObservationRecordV1 | IntakeObservationRecordV2;

export interface IntakeAttemptRecord {
  readonly schemaVersion: typeof INTAKE_ATTEMPT_SCHEMA;
  readonly attemptId: string;
  readonly invocationNonce: string;
  readonly stage: IntakeAttemptStage;
  readonly attemptedAt: string;
  readonly bindings: Readonly<{
    candidate: IntakeAttemptCandidateBinding | null;
    snapshot: IntakeObservationBinding | null;
    assessment: IntakeAttemptAssessmentBinding | null;
  }>;
  readonly failure: IntakeAttemptFailure;
}

export interface IntakeObservationInput {
  readonly repoRoot: string;
  readonly candidate: IntakeCandidateObservationBinding;
  readonly snapshot: IntakeObservationBinding;
  readonly decisionSha256: string;
  readonly assessmentSha256: string;
  readonly assessmentStackSha256: string;
  readonly producerKind: IntakeObservationProducerKind;
  readonly observedMatch: IntakeObservationMatch;
  readonly operands: Readonly<{
    operandDerivationVersion: typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION | typeof INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V2;
    observedDisposition: typeof AUTHORITY_DISPOSITIONS[number];
    actionOperands: readonly IntakeObservationActionOperand[];
  }>;
  readonly observedAt: string;
}

type JsonObject = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function pretty(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
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
  return value;
}

function sha256(value: unknown, context: string): string {
  const result = string(value, context);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return result;
}

function timestamp(value: unknown, context: string): string {
  const result = string(value, context);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${context} must be an ISO timestamp.`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${context} is unsupported.`);
  return value as T;
}

function locator(value: unknown, context: string): string {
  const raw = string(value, context).replace(/\\/g, "/");
  const normalized = normalize(raw).replace(/\\/g, "/");
  if (isAbsolute(raw) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${context} must be a repo-relative path.`);
  }
  return normalized;
}

function assertResolvable(repoRoot: string, value: string, context: string): void {
  const root = realpathSync(resolve(repoRoot));
  const target = realpathSync(resolve(root, value));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${context} must resolve inside the repository.`);
  }
  if (!statSync(target).isFile()) throw new Error(`${context} does not resolve to a file.`);
}

function observationIdentityV1(value: Omit<IntakeObservationRecordV1, "observationId" | "observedAt">): string {
  return hash({
    schemaVersion: value.schemaVersion,
    candidateContentSha256: value.candidate.contentSha256,
    sourceFingerprint: value.candidate.sourceFingerprint,
    snapshotContentSha256: value.snapshot.contentSha256,
    decisionSha256: value.decisionSha256,
    assessmentSha256: value.assessmentSha256,
    assessmentStackSha256: value.assessmentStackSha256,
    producerKind: value.producerKind,
    observedMatch: value.observedMatch,
  });
}

function observationIdentityV2(value: Omit<IntakeObservationRecordV2, "observationId" | "observedAt">): string {
  return hash({
    schemaVersion: value.schemaVersion,
    candidateContentSha256: value.candidate.contentSha256,
    sourceFingerprint: value.candidate.sourceFingerprint,
    snapshotContentSha256: value.snapshot.contentSha256,
    decisionSha256: value.decisionSha256,
    assessmentSha256: value.assessmentSha256,
    assessmentStackSha256: value.assessmentStackSha256,
    producerKind: value.producerKind,
    observedMatch: value.observedMatch,
    operandDerivationVersion: value.operandDerivationVersion,
    observedDisposition: value.observedDisposition,
    actionOperands: value.actionOperands.map((operand) => value.operandDerivationVersion ===
      INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1
      ? {
          action: operand.action,
          observedDisposition: operand.observedDisposition,
          hypotheticalFullyQualifiedDisposition: operand.hypotheticalFullyQualifiedDisposition,
          requiredCapabilities: operand.requiredCapabilities,
          proposedValue: operand.proposedValue,
        }
      : operand),
  });
}

function actionOperands(
  value: unknown,
  version: IntakeObservationOperandDerivationVersion,
): readonly IntakeObservationActionOperand[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("observation.actionOperands must be a non-empty array.");
  }
  return value.map((item, index) => {
    const context = `observation.actionOperands[${index}]`;
    const raw = object(item, context);
    const keys = [
      "action", "observedDisposition", "hypotheticalFullyQualifiedDisposition",
      "requiredCapabilities", "proposedValue",
    ];
    exactKeys(raw, version === INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1
      ? keys
      : [...keys, "competingIssueNumbers"], context);
    if (!Array.isArray(raw.requiredCapabilities)) {
      throw new Error(`${context}.requiredCapabilities must be an array.`);
    }
    const requiredCapabilities = raw.requiredCapabilities.map((capability) =>
      enumValue(capability, CAPABILITIES, `${context}.requiredCapabilities`));
    if (new Set(requiredCapabilities).size !== requiredCapabilities.length) {
      throw new Error(`${context}.requiredCapabilities contains duplicates.`);
    }
    const action = enumValue(raw.action, ACTION_KINDS, `${context}.action`);
    const proposedValue = raw.proposedValue === null
      ? null
      : enumValue(raw.proposedValue, PROPOSED_VALUES, `${context}.proposedValue`);
    if (action === "set_priority" && !enumValueMatches(proposedValue, PRIORITY_PROPOSED_VALUES) ||
        action === "set_horizon" && !enumValueMatches(proposedValue, HORIZON_PROPOSED_VALUES) ||
        action !== "set_priority" && action !== "set_horizon" && proposedValue !== null) {
      throw new Error(`${context}.proposedValue does not match its closed action projection.`);
    }
    let competingIssueNumbers: readonly number[] | null = null;
    if (version !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1) {
      if (raw.competingIssueNumbers !== null && !Array.isArray(raw.competingIssueNumbers)) {
        throw new Error(`${context}.competingIssueNumbers must be null or an array.`);
      }
      if (Array.isArray(raw.competingIssueNumbers)) {
        competingIssueNumbers = raw.competingIssueNumbers.map((issueNumber) => {
          if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
            throw new Error(`${context}.competingIssueNumbers must contain positive integers.`);
          }
          return issueNumber as number;
        });
        if (new Set(competingIssueNumbers).size !== competingIssueNumbers.length) {
          throw new Error(`${context}.competingIssueNumbers contains duplicates.`);
        }
        if (competingIssueNumbers.some((issueNumber, index) => index > 0 &&
            issueNumber < competingIssueNumbers![index - 1])) {
          throw new Error(`${context}.competingIssueNumbers must be sorted ascending.`);
        }
      }
    }
    return {
      action,
      observedDisposition: enumValue(raw.observedDisposition, AUTHORITY_DISPOSITIONS, `${context}.observedDisposition`),
      hypotheticalFullyQualifiedDisposition: enumValue(
        raw.hypotheticalFullyQualifiedDisposition,
        AUTHORITY_DISPOSITIONS,
        `${context}.hypotheticalFullyQualifiedDisposition`,
      ),
      requiredCapabilities,
      proposedValue,
      competingIssueNumbers,
    };
  });
}

function enumValueMatches<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function reduceIntakeObservationDisposition(input: {
  readonly observedMatch: IntakeObservationMatch;
  readonly actionOperands: readonly IntakeObservationActionOperand[];
  readonly operandDerivationVersion?: IntakeObservationOperandDerivationVersion;
}): typeof AUTHORITY_DISPOSITIONS[number] {
  if (input.operandDerivationVersion !== undefined &&
      input.operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION &&
      (input.observedMatch === "plausible_overlap" || input.observedMatch === "invalid")) return "hold_no_write";
  if (input.actionOperands.some(({ action }) => action === "hold_invalid" || action === "hold_overlap")) return "hold_no_write";
  if (input.actionOperands.some(({ action, observedDisposition }) =>
    action !== "replay_no_op" && observedDisposition === "automatic_safe")) return "automatic_safe";
  if (input.actionOperands.some(({ observedDisposition }) => observedDisposition === "approval_required")) {
    return "approval_required";
  }
  if (input.actionOperands.some(({ action, observedDisposition }) =>
    action === "replay_no_op" && observedDisposition === "automatic_safe")) return "automatic_safe";
  return "recommendation_only";
}

function attemptBindings(value: unknown): IntakeAttemptRecord["bindings"] {
  const raw = object(value, "attempt.bindings");
  exactKeys(raw, ["candidate", "snapshot", "assessment"], "attempt.bindings");
  const candidate = raw.candidate === null ? null : object(raw.candidate, "attempt.bindings.candidate");
  const snapshot = raw.snapshot === null ? null : object(raw.snapshot, "attempt.bindings.snapshot");
  const assessment = raw.assessment === null ? null : object(raw.assessment, "attempt.bindings.assessment");
  if (candidate !== null) exactKeys(candidate, ["locator", "contentSha256", "producerKind"], "attempt.bindings.candidate");
  if (snapshot !== null) exactKeys(snapshot, ["locator", "contentSha256"], "attempt.bindings.snapshot");
  if (assessment !== null) exactKeys(assessment, ["contentSha256", "stackSha256"], "attempt.bindings.assessment");
  return {
    candidate: candidate === null ? null : {
      locator: locator(candidate.locator, "attempt.bindings.candidate.locator"),
      contentSha256: sha256(candidate.contentSha256, "attempt.bindings.candidate.contentSha256"),
      producerKind: enumValue(candidate.producerKind, PRODUCER_KINDS, "attempt.bindings.candidate.producerKind"),
    },
    snapshot: snapshot === null ? null : {
      locator: locator(snapshot.locator, "attempt.bindings.snapshot.locator"),
      contentSha256: sha256(snapshot.contentSha256, "attempt.bindings.snapshot.contentSha256"),
    },
    assessment: assessment === null ? null : {
      contentSha256: sha256(assessment.contentSha256, "attempt.bindings.assessment.contentSha256"),
      stackSha256: sha256(assessment.stackSha256, "attempt.bindings.assessment.stackSha256"),
    },
  };
}

function attemptFailureValue(value: unknown): IntakeAttemptFailure {
  const raw = object(value, "attempt.failure");
  exactKeys(raw, ["category", "code"], "attempt.failure");
  return {
    category: enumValue(raw.category, FAILURE_CATEGORIES, "attempt.failure.category"),
    code: enumValue(raw.code, FAILURE_CODES, "attempt.failure.code"),
  };
}

export function intakeAttemptFailure(stage: IntakeAttemptStage): IntakeAttemptFailure {
  return ATTEMPT_FAILURE_BY_STAGE[stage];
}

function assertAttemptFailureMatchesStage(stage: IntakeAttemptStage, failure: IntakeAttemptFailure): void {
  const expected = intakeAttemptFailure(stage);
  if (failure.category !== expected.category || failure.code !== expected.code) {
    throw new Error(
      `attempt.failure must be ${expected.category}/${expected.code} for stage ${stage}.`,
    );
  }
}

function canonicalizePlannedPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`No existing ancestor for intake journal path ${path}.`);
    missing.unshift(existing.slice(parent.length).replace(/^[/\\]+/, ""));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function journalPath(repoRoot: string, directory: string, filename: string): string {
  const root = realpathSync(resolve(repoRoot));
  const expectedDirectory = resolve(root, directory);
  const canonicalExpectedDirectory = canonicalizePlannedPath(expectedDirectory);
  const path = canonicalizePlannedPath(join(root, directory, filename));
  if (!isInside(root, canonicalExpectedDirectory) || !isInside(expectedDirectory, path)) {
    throw new Error(`Intake journal path must resolve inside ${directory}.`);
  }
  return path;
}

class ImmutableJournalCollision extends Error {
  constructor(
    readonly path: string,
    readonly attemptedValue: unknown,
  ) {
    super(`Immutable intake journal collision: ${path} already exists.`);
  }
}

function writeImmutable<T>(path: string, value: T): void {
  mkdirSync(dirname(path), { recursive: true });
  const claimPath = `${path}.claim`;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let claim: number | null = null;
  let ownsClaim = false;
  try {
    claim = openSync(claimPath, "wx", 0o600);
    ownsClaim = true;
    closeSync(claim);
    claim = null;
    if (existsSync(path)) throw new ImmutableJournalCollision(path, value);
    writeFileSync(temporaryPath, pretty(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    if (claim !== null) closeSync(claim);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {}
    throw error;
  } finally {
    try {
      if (ownsClaim && existsSync(claimPath)) unlinkSync(claimPath);
    } catch {}
  }
}

export function bankIntakeObservation(input: IntakeObservationInput): {
  readonly path: string;
  readonly record: IntakeObservationRecordV2;
} {
  const operands = actionOperands(input.operands.actionOperands, input.operands.operandDerivationVersion);
  const observedMatch = enumValue(input.observedMatch, OBSERVED_MATCHES, "observation.observedMatch");
  const observedDisposition = enumValue(
    input.operands.observedDisposition,
    AUTHORITY_DISPOSITIONS,
    "observation.observedDisposition",
  );
  const operandDerivationVersion = input.operands.operandDerivationVersion;
  if (operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION &&
      operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V2) {
    throw new Error("observation.operandDerivationVersion is unsupported.");
  }
  if (observedDisposition !== reduceIntakeObservationDisposition({ observedMatch, actionOperands: operands, operandDerivationVersion })) {
    throw new Error("observation.observedDisposition does not match its named operand reduction.");
  }
  const withoutId = {
    schemaVersion: INTAKE_OBSERVATION_SCHEMA,
    candidate: {
      locator: locator(input.candidate.locator, "observation.candidate.locator"),
      contentSha256: sha256(input.candidate.contentSha256, "observation.candidate.contentSha256"),
      sourceFingerprint: sha256(input.candidate.sourceFingerprint, "observation.candidate.sourceFingerprint"),
    },
    snapshot: {
      locator: locator(input.snapshot.locator, "observation.snapshot.locator"),
      contentSha256: sha256(input.snapshot.contentSha256, "observation.snapshot.contentSha256"),
    },
    decisionSha256: sha256(input.decisionSha256, "observation.decisionSha256"),
    assessmentSha256: sha256(input.assessmentSha256, "observation.assessmentSha256"),
    assessmentStackSha256: sha256(input.assessmentStackSha256, "observation.assessmentStackSha256"),
    producerKind: enumValue(input.producerKind, PRODUCER_KINDS, "observation.producerKind"),
    observedMatch,
    operandDerivationVersion,
    observedDisposition,
    actionOperands: operands,
    observedAt: timestamp(input.observedAt, "observation.observedAt"),
  };
  assertResolvable(input.repoRoot, withoutId.candidate.locator, "observation.candidate.locator");
  assertResolvable(input.repoRoot, withoutId.snapshot.locator, "observation.snapshot.locator");
  const record: IntakeObservationRecordV2 = {
    ...withoutId,
    observationId: observationIdentityV2(withoutId),
  };
  const path = journalPath(
    input.repoRoot,
    INTAKE_OBSERVATION_DIRECTORY,
    `${record.observationId}.json`,
  );
  writeImmutable(path, record);
  return { path, record };
}

export function bankIntakeObservations(inputs: readonly IntakeObservationInput[]): void {
  const errors: unknown[] = [];
  for (const input of inputs) {
    try {
      bankIntakeObservation(input);
    } catch (error) {
      if (error instanceof ImmutableJournalCollision) {
        try {
          const existing = readIntakeJournalRecord(error.path);
          if (pretty(existing) !== pretty(error.attemptedValue)) {
            errors.push(new Error(`Immutable intake journal collision has mismatched content: ${error.path}.`));
            continue;
          }
        } catch (readError) {
          errors.push(readError);
          continue;
        }
      }
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to bank ${errors.length} intake observation(s).`);
  }
}

export function bankIntakeAttempt(input: {
  readonly repoRoot: string;
  readonly stage: IntakeAttemptStage;
  readonly attemptedAt: string;
  readonly bindings: IntakeAttemptRecord["bindings"];
  readonly failure: IntakeAttemptFailure;
}): { readonly path: string; readonly record: IntakeAttemptRecord } {
  const invocationNonce = randomUUID();
  const withoutId = {
    schemaVersion: INTAKE_ATTEMPT_SCHEMA,
    invocationNonce,
    stage: enumValue(input.stage, ATTEMPT_STAGES, "attempt.stage"),
    attemptedAt: timestamp(input.attemptedAt, "attempt.attemptedAt"),
    bindings: attemptBindings(input.bindings),
    failure: attemptFailureValue(input.failure),
  };
  assertAttemptFailureMatchesStage(withoutId.stage, withoutId.failure);
  const record: IntakeAttemptRecord = { ...withoutId, attemptId: hash(withoutId) };
  const path = journalPath(input.repoRoot, INTAKE_ATTEMPT_DIRECTORY, `${record.attemptId}.json`);
  writeImmutable(path, record);
  return { path, record };
}

function parseObservationV1(value: JsonObject): IntakeObservationRecordV1 {
  exactKeys(value, [
    "schemaVersion", "observationId", "candidate", "snapshot", "decisionSha256",
    "assessmentSha256", "assessmentStackSha256", "producerKind", "observedMatch", "observedAt",
  ], "observation");
  const candidate = object(value.candidate, "observation.candidate");
  exactKeys(candidate, ["locator", "contentSha256", "sourceFingerprint"], "observation.candidate");
  const snapshot = object(value.snapshot, "observation.snapshot");
  exactKeys(snapshot, ["locator", "contentSha256"], "observation.snapshot");
  const withoutId = {
    schemaVersion: INTAKE_OBSERVATION_SCHEMA_V1,
    candidate: {
      locator: locator(candidate.locator, "observation.candidate.locator"),
      contentSha256: sha256(candidate.contentSha256, "observation.candidate.contentSha256"),
      sourceFingerprint: sha256(candidate.sourceFingerprint, "observation.candidate.sourceFingerprint"),
    },
    snapshot: {
      locator: locator(snapshot.locator, "observation.snapshot.locator"),
      contentSha256: sha256(snapshot.contentSha256, "observation.snapshot.contentSha256"),
    },
    decisionSha256: sha256(value.decisionSha256, "observation.decisionSha256"),
    assessmentSha256: sha256(value.assessmentSha256, "observation.assessmentSha256"),
    assessmentStackSha256: sha256(value.assessmentStackSha256, "observation.assessmentStackSha256"),
    producerKind: enumValue(value.producerKind, PRODUCER_KINDS, "observation.producerKind"),
    observedMatch: enumValue(value.observedMatch, OBSERVED_MATCHES, "observation.observedMatch"),
    observedAt: timestamp(value.observedAt, "observation.observedAt"),
  };
  const observationId = sha256(value.observationId, "observation.observationId");
  if (observationId !== observationIdentityV1(withoutId)) throw new Error("Observation identity does not match its bound content.");
  return { ...withoutId, observationId };
}

function parseObservationV2(value: JsonObject): IntakeObservationRecordV2 {
  exactKeys(value, [
    "schemaVersion", "observationId", "candidate", "snapshot", "decisionSha256",
    "assessmentSha256", "assessmentStackSha256", "producerKind", "observedMatch",
    "operandDerivationVersion", "observedDisposition", "actionOperands", "observedAt",
  ], "observation");
  const candidate = object(value.candidate, "observation.candidate");
  exactKeys(candidate, ["locator", "contentSha256", "sourceFingerprint"], "observation.candidate");
  const snapshot = object(value.snapshot, "observation.snapshot");
  exactKeys(snapshot, ["locator", "contentSha256"], "observation.snapshot");
  if (value.operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION &&
      value.operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V2 &&
      value.operandDerivationVersion !== INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1) {
    throw new Error("observation.operandDerivationVersion is unsupported.");
  }
  const operandDerivationVersion = value.operandDerivationVersion;
  const operands = actionOperands(value.actionOperands, operandDerivationVersion);
  const observedMatch = enumValue(value.observedMatch, OBSERVED_MATCHES, "observation.observedMatch");
  const observedDisposition = enumValue(
    value.observedDisposition,
    AUTHORITY_DISPOSITIONS,
    "observation.observedDisposition",
  );
  if (observedDisposition !== reduceIntakeObservationDisposition({ observedMatch, actionOperands: operands, operandDerivationVersion })) {
    throw new Error("observation.observedDisposition does not match its named operand reduction.");
  }
  const withoutId = {
    schemaVersion: INTAKE_OBSERVATION_SCHEMA_V2,
    candidate: {
      locator: locator(candidate.locator, "observation.candidate.locator"),
      contentSha256: sha256(candidate.contentSha256, "observation.candidate.contentSha256"),
      sourceFingerprint: sha256(candidate.sourceFingerprint, "observation.candidate.sourceFingerprint"),
    },
    snapshot: {
      locator: locator(snapshot.locator, "observation.snapshot.locator"),
      contentSha256: sha256(snapshot.contentSha256, "observation.snapshot.contentSha256"),
    },
    decisionSha256: sha256(value.decisionSha256, "observation.decisionSha256"),
    assessmentSha256: sha256(value.assessmentSha256, "observation.assessmentSha256"),
    assessmentStackSha256: sha256(value.assessmentStackSha256, "observation.assessmentStackSha256"),
    producerKind: enumValue(value.producerKind, PRODUCER_KINDS, "observation.producerKind"),
    observedMatch,
    operandDerivationVersion,
    observedDisposition,
    actionOperands: operands,
    observedAt: timestamp(value.observedAt, "observation.observedAt"),
  };
  const observationId = sha256(value.observationId, "observation.observationId");
  if (observationId !== observationIdentityV2(withoutId)) throw new Error("Observation identity does not match its bound content.");
  return { ...withoutId, observationId };
}

function parseAttempt(value: JsonObject): IntakeAttemptRecord {
  exactKeys(value, [
    "schemaVersion", "attemptId", "invocationNonce", "stage", "attemptedAt", "bindings", "failure",
  ], "attempt");
  const record = value as unknown as IntakeAttemptRecord;
  if (typeof record.invocationNonce !== "string" || !/^[a-f0-9-]{36}$/.test(record.invocationNonce)) {
    throw new Error("attempt.invocationNonce is invalid.");
  }
  const stage = enumValue(record.stage, ATTEMPT_STAGES, "attempt.stage");
  const attemptedAt = timestamp(record.attemptedAt, "attempt.attemptedAt");
  const bindings = attemptBindings(record.bindings);
  const failure = attemptFailureValue(record.failure);
  assertAttemptFailureMatchesStage(stage, failure);
  const attemptId = sha256(record.attemptId, "attempt.attemptId");
  const withoutId = {
    schemaVersion: INTAKE_ATTEMPT_SCHEMA,
    invocationNonce: record.invocationNonce,
    stage,
    attemptedAt,
    bindings,
    failure,
  };
  if (attemptId !== hash(withoutId)) throw new Error("Attempt identity does not match its content.");
  return { ...withoutId, attemptId };
}

export function parseIntakeJournalRecordValue(value: unknown): IntakeObservationRecord | IntakeAttemptRecord {
  const raw = object(value, "Intake journal record");
  if (raw.schemaVersion === INTAKE_OBSERVATION_SCHEMA_V1) return parseObservationV1(raw);
  if (raw.schemaVersion === INTAKE_OBSERVATION_SCHEMA_V2) return parseObservationV2(raw);
  if (raw.schemaVersion === INTAKE_ATTEMPT_SCHEMA) return parseAttempt(raw);
  throw new Error("Intake journal record schema version is missing or unsupported.");
}

export function readIntakeJournalRecord(path: string): IntakeObservationRecord | IntakeAttemptRecord {
  return parseIntakeJournalRecordValue(JSON.parse(readFileSync(path, "utf8")));
}
