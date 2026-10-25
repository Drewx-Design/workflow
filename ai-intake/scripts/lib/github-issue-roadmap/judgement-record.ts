import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { INTAKE_MATCH_RESULTS, type IntakeMatchResult } from "./intake-assessment";
import {
  AUTHORITY_DISPOSITIONS,
  INTAKE_CALIBRATION_SCORING_VERSIONS,
  scoreCalibrationCohorts,
  type AuthorityDisposition,
  type IntakeCalibrationCase,
  type IntakeActionKind,
  type IntakeCalibrationScoringVersion,
} from "./intake-decision";
import { writeImmutableJson, type ImmutableJsonWriteResult } from "./immutable-json";
import { PRODUCER_KINDS, parseOutcomeEnvelope, type ProducerKind } from "./outcome-candidate";
import { INTAKE_OBSERVATION_DIRECTORY, INTAKE_OBSERVATION_SCHEMA_V2, parseIntakeJournalRecordValue, type IntakeObservationRecordV2 } from "./intake-observation";
import { parseIntakeSnapshotV1 } from "./intake-snapshot";
import { assertPathInsideRepository } from "./artifact-io";

export const JUDGEMENT_RECORD_SCHEMA = "github-issue-roadmap-judgement/v1" as const;
export const JUDGEMENT_READOUT_SCHEMA = "github-issue-roadmap-judgement-readout/v1" as const;
export const JUDGEMENT_RECORD_DIRECTORY = "artifacts/github-issue-roadmap/judgements" as const;

const JUDGEMENT_SPLITS = ["tuning", "holdout", "shadow", "regression"] as const;
export const JUDGEMENT_ACTORS = ["human_operator", "agent", "model_panel"] as const;
export const MODEL_ACTION_KINDS = ["append_evidence_overlap", "close_issue_existence"] as const;
export type ModelActionKind = typeof MODEL_ACTION_KINDS[number];
export interface ActionLabel {
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly actionKind: ModelActionKind;
  readonly targetIssueNumber: number;
  readonly verdict: "correct" | "incorrect";
}

/** Shared across worktrees; the journal-root override also relocates its sibling store. */
export function resolveActionJudgementRoot(input: { readonly judgementRoot?: string; readonly journalRoot?: string; readonly homeDirectory: string }): string {
  const root = input.judgementRoot ?? join(input.journalRoot ?? join(input.homeDirectory, ".example-repo", "roadmap-intake"), "judgements");
  if (!isAbsolute(root) || sep === "\\" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(root)) {
    throw new Error("ROADMAP_INTAKE_JUDGEMENT_ROOT must be an absolute, drive-qualified or UNC path.");
  }
  return resolve(root);
}

export function actionMaterialRoot(judgementRoot: string, observationId: string): string {
  return join(judgementRoot, "material", sha256(observationId, "observationId"));
}

export function parseActionLabel(value: unknown): ActionLabel {
  const raw = object(value, "actionLabel");
  exactKeys(raw, ["repository", "sourceFingerprint", "actionKind", "targetIssueNumber", "verdict"], "actionLabel");
  if (typeof raw.repository !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(raw.repository)) throw new Error("actionLabel.repository is invalid.");
  if (!Number.isSafeInteger(raw.targetIssueNumber) || (raw.targetIssueNumber as number) < 1) throw new Error("actionLabel.targetIssueNumber must be a positive integer.");
  return { repository: raw.repository, sourceFingerprint: sha256(raw.sourceFingerprint, "actionLabel.sourceFingerprint"),
    actionKind: enumValue(raw.actionKind, MODEL_ACTION_KINDS, "actionLabel.actionKind"), targetIssueNumber: raw.targetIssueNumber as number,
    verdict: enumValue(raw.verdict, ["correct", "incorrect"], "actionLabel.verdict") };
}

/** Keep pinned bytes and original citation locators in a per-observation workspace. */
export function bankActionJudgementMaterial(input: {
  readonly runRoot: string;
  readonly repoRoot: string;
  readonly judgementRoot: string;
  readonly observation: IntakeObservationRecordV2;
  readonly suggestions: readonly Pick<ActionLabel, "actionKind" | "targetIssueNumber">[];
}): string {
  const observation = input.observation;
  const root = actionMaterialRoot(input.judgementRoot, observation.observationId);
  const candidateBytes = readFileSync(assertPathInsideRepository(observation.candidate.locator, input.runRoot, "Candidate"));
  const snapshotBytes = readFileSync(assertPathInsideRepository(observation.snapshot.locator, input.runRoot, "Snapshot"));
  const envelope = parseOutcomeEnvelope(JSON.parse(candidateBytes.toString("utf8")));
  const snapshot = parseIntakeSnapshotV1(JSON.parse(snapshotBytes.toString("utf8")));
  if (canonicalJsonSha256(envelope) !== observation.candidate.contentSha256 || snapshot.contentSha256 !== observation.snapshot.contentSha256 || snapshot.candidateSha256 !== observation.candidate.contentSha256) throw new Error("Action material does not match the observation bindings.");
  const candidate = envelope.candidates.find(item => item.sourceFingerprint === observation.candidate.sourceFingerprint);
  if (candidate === undefined) throw new Error("Action material candidate is missing.");
  const copy = (locator: string, bytes: Buffer) => {
    const target = assertPathInsideRepository(locator, root, "Action material");
    mkdirSync(dirname(target), { recursive: true });
    try { writeFileSync(target, bytes, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(target).equals(bytes)) throw error;
    }
  };
  mkdirSync(root, { recursive: true });
  copy("bindings/candidate.json", candidateBytes); copy("bindings/snapshot.json", snapshotBytes);
  for (const locator of new Set([...candidate.evidence, ...candidate.provenance].map(item => item.sourceLocator))) {
    copy(locator, readFileSync(assertPathInsideRepository(locator, input.repoRoot, "Action source")));
  }
  const relocated = parseIntakeJournalRecordValue({ ...observation,
    candidate: { ...observation.candidate, locator: "bindings/candidate.json" }, snapshot: { ...observation.snapshot, locator: "bindings/snapshot.json" } });
  if (relocated.schemaVersion !== INTAKE_OBSERVATION_SCHEMA_V2) throw new Error("Action material requires a v2 observation.");
  writeImmutableJson(join(root, INTAKE_OBSERVATION_DIRECTORY, `${observation.observationId}.json`), relocated);
  const repository = `${envelope.repository.organization}/${envelope.repository.name}`;
  const suggestions = input.suggestions.map(suggestion => parseActionLabel({ ...suggestion, repository, sourceFingerprint: candidate.sourceFingerprint, verdict: "correct" }));
  writeImmutableJson(join(root, "suggestions.json"), suggestions);
  return root;
}

type JsonObject = Record<string, unknown>;

/**
 * Two independent properties of a trusted verification marker, named for what each one actually
 * encodes. `persistedVerification` deliberately does not appear here: it reads as origin/main
 * binding while encoding 14-day recency, and that conflation already caused two issues to be judged
 * against a misleading display. See docs/discovery/2026-08-27-roadmap-verification-freshness-conflation.md.
 */
export interface JudgementVerificationFreshness {
  /** Was the marker inside its recency window when the material was rendered? */
  readonly trustedMarkerWithinRecencyWindow: boolean | null;
  /** Did the marker's originMainSha equal the snapshot's originMainSha? */
  readonly trustedMarkerBoundToSnapshotOriginMainSha: boolean | null;
}

interface JudgementRenderedMaterialCommon {
  /**
   * Together these fields make a display dispute checkable: re-render with the recorded renderer
   * version and compare the output hash to distinguish a wrong display from a wrong label.
   */
  readonly materialSha256: string;
  readonly rendererVersion: string;
  readonly verificationFreshness: JudgementVerificationFreshness;
}

export interface JudgementCapturedRenderedMaterial extends JudgementRenderedMaterialCommon {
  readonly textCapture: "disagreement_captured";
  readonly text: string;
}

export interface JudgementOmittedRenderedMaterial extends JudgementRenderedMaterialCommon {
  /** The body is known but deliberately omitted because the judge agreed with the observed call. */
  readonly textCapture: "agreement_not_captured";
  readonly text?: never;
}

export type JudgementRenderedMaterial =
  | JudgementCapturedRenderedMaterial
  | JudgementOmittedRenderedMaterial;

/** The classifier's own call, carried so the readout never has to re-read the observation store. */
export interface JudgementObservedCall {
  readonly producerKind: ProducerKind;
  readonly observedMatch: IntakeMatchResult;
  readonly observedActions?: readonly IntakeActionKind[];
  readonly observedDisposition: AuthorityDisposition;
  /** Whether the outcome is simple enough for autonomous implementation; null means unjudged. */
  readonly routineEligible: boolean | null;
  readonly sensitiveActionAutomatic: boolean;
  readonly assessmentStackSha256: string;
  readonly observedAt: string;
}

/**
 * A closed envelope with one intentionally open `extensions` object (R5/KTD3). Later optional
 * fields go inside `extensions`; existing records carry `{}` and stay valid without re-judging.
 */
export interface JudgementRecord {
  readonly schemaVersion: typeof JUDGEMENT_RECORD_SCHEMA;
  readonly observationId: string;
  readonly judgedMatch: IntakeMatchResult;
  readonly judgedBy: typeof JUDGEMENT_ACTORS[number];
  readonly judgedAt: string;
  readonly scoringVersion: IntakeCalibrationScoringVersion;
  readonly split: typeof JUDGEMENT_SPLITS[number];
  readonly observed: JudgementObservedCall;
  readonly renderedMaterial: JudgementRenderedMaterial;
  readonly extensions: JsonObject;
}

export type JudgementRecordInput = Omit<JudgementRecord, "schemaVersion">;

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

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean.`);
  return value;
}

function nullableBoolean(value: unknown, context: string): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new Error(`${context} must be a boolean or null.`);
  return value;
}

/** Accept any JSON-compatible data and preserve its keys and values verbatim. */
function jsonData(value: unknown, context: string): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${context} must be JSON-compatible data.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonData(item, `${context}[${index}]`));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .map(([key, child]) => [key, jsonData(child, `${context}.${key}`)]));
  }
  throw new Error(`${context} must be JSON-compatible data.`);
}

function extensions(value: unknown): JsonObject {
  const result = jsonData(object(value, "judgement.extensions"), "judgement.extensions") as JsonObject;
  if (Object.hasOwn(result, "actionLabel")) parseActionLabel(result.actionLabel);
  return result;
}

/** Validates panel provenance against its label's verdict and returns the two seat families. */
export function parseActionLabelPanelFamilies(value: unknown, verdict: ActionLabel["verdict"]): readonly ("anthropic" | "glm")[] {
  const context = "judgement.extensions.panel";
  const raw = object(value, context);
  exactKeys(raw, ["schemaVersion", "promptSha256", "seats"], context);
  if (raw.schemaVersion !== "github-issue-roadmap-action-label-panel/v1") {
    throw new Error(`${context}.schemaVersion is unsupported.`);
  }
  sha256(raw.promptSha256, `${context}.promptSha256`);
  if (!Array.isArray(raw.seats) || raw.seats.length !== 2) throw new Error(`${context}.seats must contain exactly two seats.`);
  const families = raw.seats.map((value, index) => {
    const seatContext = `${context}.seats[${index}]`;
    const seat = object(value, seatContext);
    exactKeys(seat, ["family", "requestedModel", "observedModel", "verdict", "rationale", "responseSha256"], seatContext);
    const family = enumValue(seat.family, ["anthropic", "glm"], `${seatContext}.family`);
    string(seat.requestedModel, `${seatContext}.requestedModel`);
    string(seat.observedModel, `${seatContext}.observedModel`);
    if (seat.verdict !== verdict) throw new Error(`${seatContext}.verdict must equal actionLabel.verdict.`);
    const rationale = string(seat.rationale, `${seatContext}.rationale`);
    if (rationale.length > 1000) throw new Error(`${seatContext}.rationale must be at most 1000 characters.`);
    sha256(seat.responseSha256, `${seatContext}.responseSha256`);
    return family;
  });
  if (families[0] === families[1]) throw new Error(`${context}.seats must have different families.`);
  return families;
}

function verificationFreshness(value: unknown): JudgementVerificationFreshness {
  const context = "judgement.renderedMaterial.verificationFreshness";
  const raw = object(value, context);
  exactKeys(raw, ["trustedMarkerWithinRecencyWindow", "trustedMarkerBoundToSnapshotOriginMainSha"], context);
  return {
    trustedMarkerWithinRecencyWindow: nullableBoolean(
      raw.trustedMarkerWithinRecencyWindow,
      `${context}.trustedMarkerWithinRecencyWindow`,
    ),
    trustedMarkerBoundToSnapshotOriginMainSha: nullableBoolean(
      raw.trustedMarkerBoundToSnapshotOriginMainSha,
      `${context}.trustedMarkerBoundToSnapshotOriginMainSha`,
    ),
  };
}

function renderedMaterial(value: unknown): JudgementRenderedMaterial {
  const context = "judgement.renderedMaterial";
  const raw = object(value, context);
  const textCapture = enumValue(
    raw.textCapture,
    ["agreement_not_captured", "disagreement_captured"] as const,
    `${context}.textCapture`,
  );
  const common = {
    materialSha256: sha256(raw.materialSha256, `${context}.materialSha256`),
    rendererVersion: string(raw.rendererVersion, `${context}.rendererVersion`),
    verificationFreshness: verificationFreshness(raw.verificationFreshness),
  };
  if (textCapture === "agreement_not_captured") {
    exactKeys(raw, ["materialSha256", "rendererVersion", "textCapture", "verificationFreshness"], context);
    return { ...common, textCapture };
  }
  exactKeys(raw, ["materialSha256", "rendererVersion", "textCapture", "text", "verificationFreshness"], context);
  const text = string(raw.text, `${context}.text`);
  const actualSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (actualSha256 !== common.materialSha256) {
    throw new Error(`${context}.materialSha256 must match the captured text bytes.`);
  }
  return { ...common, textCapture, text };
}

function observedCall(value: unknown): JudgementObservedCall {
  const context = "judgement.observed";
  const raw = object(value, context);
  const hasObservedActions = Object.hasOwn(raw, "observedActions");
  exactKeys(raw, [
    "producerKind", "observedMatch", "observedDisposition", "routineEligible",
    "sensitiveActionAutomatic", "assessmentStackSha256", "observedAt",
    ...(hasObservedActions ? ["observedActions"] : []),
  ], context);
  const actionKinds = [
    "replay_no_op", "create_issue", "append_evidence", "close_issue", "set_type", "set_priority", "set_effort",
    "append_evidence_overlap", "close_issue_existence",
    "set_horizon", "add_relationship", "change_relationship", "reopen_issue", "hold_overlap", "hold_invalid",
  ] as const satisfies readonly IntakeActionKind[];
  if (hasObservedActions && !Array.isArray(raw.observedActions)) {
    throw new Error(`${context}.observedActions must be an array.`);
  }
  return {
    producerKind: enumValue(raw.producerKind, PRODUCER_KINDS, `${context}.producerKind`),
    observedMatch: enumValue(raw.observedMatch, INTAKE_MATCH_RESULTS, `${context}.observedMatch`),
    ...(hasObservedActions ? { observedActions: (raw.observedActions as unknown[]).map((action) =>
      enumValue(action, actionKinds, `${context}.observedActions`)) } : {}),
    observedDisposition: enumValue(raw.observedDisposition, AUTHORITY_DISPOSITIONS, `${context}.observedDisposition`),
    routineEligible: raw.routineEligible === null ? null : boolean(raw.routineEligible, `${context}.routineEligible`),
    sensitiveActionAutomatic: boolean(raw.sensitiveActionAutomatic, `${context}.sensitiveActionAutomatic`),
    assessmentStackSha256: sha256(raw.assessmentStackSha256, `${context}.assessmentStackSha256`),
    observedAt: timestamp(raw.observedAt, `${context}.observedAt`),
  };
}

export function parseJudgementRecord(value: unknown): JudgementRecord {
  const raw = object(value, "judgement");
  exactKeys(raw, [
    "schemaVersion", "observationId", "judgedMatch", "judgedBy", "judgedAt", "scoringVersion",
    "split", "observed", "renderedMaterial", "extensions",
  ], "judgement");
  if (raw.schemaVersion !== JUDGEMENT_RECORD_SCHEMA) {
    throw new Error(`judgement.schemaVersion must be ${JUDGEMENT_RECORD_SCHEMA}.`);
  }
  const record: JudgementRecord = {
    schemaVersion: JUDGEMENT_RECORD_SCHEMA,
    observationId: sha256(raw.observationId, "judgement.observationId"),
    judgedMatch: enumValue(raw.judgedMatch, INTAKE_MATCH_RESULTS, "judgement.judgedMatch"),
    judgedBy: enumValue(raw.judgedBy, JUDGEMENT_ACTORS, "judgement.judgedBy"),
    judgedAt: timestamp(raw.judgedAt, "judgement.judgedAt"),
    scoringVersion: enumValue(raw.scoringVersion, INTAKE_CALIBRATION_SCORING_VERSIONS, "judgement.scoringVersion"),
    split: enumValue(raw.split, JUDGEMENT_SPLITS, "judgement.split"),
    observed: observedCall(raw.observed),
    renderedMaterial: renderedMaterial(raw.renderedMaterial),
    extensions: extensions(raw.extensions),
  };
  const actionLabel = record.extensions.actionLabel === undefined ? undefined : parseActionLabel(record.extensions.actionLabel);
  if (record.judgedBy === "model_panel") {
    if (actionLabel === undefined) throw new Error("model_panel requires extensions.actionLabel.");
    parseActionLabelPanelFamilies(record.extensions.panel, actionLabel.verdict);
  } else if (Object.hasOwn(record.extensions, "panel")) {
    throw new Error("extensions.panel is only allowed on model_panel records.");
  }
  if (actionLabel !== undefined && (record.split !== "holdout" || Date.parse(record.judgedAt) < Date.parse(record.observed.observedAt))) throw new Error("Action labels require holdout and a label time on or after the observation.");
  const agrees = actionLabel === undefined ? record.judgedMatch === record.observed.observedMatch : actionLabel.verdict === "correct";
  if (agrees && record.renderedMaterial.textCapture !== "agreement_not_captured") {
    throw new Error("judgement.renderedMaterial.text must be omitted when the judgement agrees with the observation.");
  }
  if (!agrees && record.renderedMaterial.textCapture !== "disagreement_captured") {
    throw new Error("judgement.renderedMaterial.text must be captured when the judgement disagrees with the observation.");
  }
  return record;
}

export function buildJudgementRecord(input: JudgementRecordInput): JudgementRecord {
  return parseJudgementRecord({ ...input, schemaVersion: JUDGEMENT_RECORD_SCHEMA });
}

export function judgementRecordPath(
  judgementRoot: string,
  observationId: string,
  revision = 1,
): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("judgement revision must be a positive safe integer.");
  }
  return join(
    resolve(judgementRoot),
    `${sha256(observationId, "judgement.observationId")}--${revision}.json`,
  );
}

export interface JudgementRecordRevision {
  readonly revision: number;
  readonly supersedesRevision: number | null;
  readonly current: boolean;
  readonly path: string;
  readonly record: JudgementRecord;
}

function sameAttestations(left: JudgementRecord, right: JudgementRecord): boolean {
  return canonicalJson({
    judgedMatch: left.judgedMatch,
    judgedBy: left.judgedBy,
    scoringVersion: left.scoringVersion,
    split: left.split,
    observed: left.observed,
    actionLabel: left.extensions.actionLabel ?? null,
  }) === canonicalJson({
    judgedMatch: right.judgedMatch,
    judgedBy: right.judgedBy,
    scoringVersion: right.scoringVersion,
    split: right.split,
    observed: right.observed,
    actionLabel: right.extensions.actionLabel ?? null,
  });
}

/**
 * Each revision gets a distinct immutable path. A changed attestation appends a revision instead of
 * weakening `writeImmutableJson`; replaying the current attestations resolves to the existing path.
 */
export function writeJudgementRecord(input: {
  readonly judgementRoot: string;
  readonly record: JudgementRecord;
}): ImmutableJsonWriteResult {
  const revisions = readJudgementRecordRevisions(input.judgementRoot)
    .filter(({ record }) => record.observationId === input.record.observationId);
  const current = revisions.at(-1);
  if (current !== undefined && sameAttestations(current.record, input.record)) {
    return { path: current.path, created: false };
  }
  const nextRevision = (current?.revision ?? 0) + 1;
  return writeImmutableJson(
    judgementRecordPath(input.judgementRoot, input.record.observationId, nextRevision),
    input.record,
  );
}

export function readJudgementRecordRevisions(judgementRoot: string): JudgementRecordRevision[] {
  const directory = resolve(judgementRoot);
  // An absent store is an empty store, not a failure: the first run of the CLI necessarily
  // precedes the directory. Any other read error still surfaces.
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const parsed = files.map((name) => {
    const match = /^([a-f0-9]{64})--([1-9][0-9]*)\.json$/.exec(name);
    if (match === null) {
      throw new Error(`Unreadable judgement record ${join(directory, name)}: filename is not a revision path.`);
    }
    const file = join(directory, name);
    let record: JudgementRecord;
    try {
      record = parseJudgementRecord(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      // Without the filename one unreadable record makes the whole readout unavailable and
      // unlocatable, which is worse than the corrupt record itself.
      throw new Error(`Unreadable judgement record ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The filename is derived from the observation id, so a record whose name does not match its
    // own content is a copy under a second name. Nothing downstream dedupes by case id, so
    // accepting it would count one observation twice and skew the accuracy figure.
    const revision = Number(match[2]);
    if (!Number.isSafeInteger(revision)) {
      throw new Error(`Unreadable judgement record ${file}: revision is not a safe integer.`);
    }
    const expected = judgementRecordPath(directory, record.observationId, revision);
    if (file !== expected) {
      throw new Error(`Judgement record ${file} does not match the identity it carries; expected ${expected}.`);
    }
    return { revision, path: file, record };
  });
  const grouped = new Map<string, typeof parsed>();
  for (const revision of parsed) {
    const group = grouped.get(revision.record.observationId) ?? [];
    group.push(revision);
    grouped.set(revision.record.observationId, group);
  }
  return [...grouped.values()].flatMap((group) => {
    group.sort((left, right) => left.revision - right.revision);
    group.forEach(({ revision, path }, index) => {
      if (revision !== index + 1) {
        throw new Error(`Unreadable judgement record ${path}: revisions must be contiguous from 1.`);
      }
    });
    return group.map(({ revision, path, record }, index) => ({
      revision,
      supersedesRevision: revision === 1 ? null : revision - 1,
      current: index === group.length - 1,
      path,
      record,
    }));
  });
}

/** Resolve one current judgement per observation; superseded revisions remain in the audit read. */
export function readJudgementRecords(judgementRoot: string): JudgementRecord[] {
  return readJudgementRecordRevisions(judgementRoot)
    .filter(({ current }) => current)
    .map(({ record }) => record);
}

/**
 * Project a judgement into the calibration case shape the scorer reads. Label authority is derived
 * from the closed judge identity rather than asserted independently by the record.
 */
export function judgementCalibrationCases(
  records: readonly JudgementRecord[],
): IntakeCalibrationCase[] {
  return records.map((record) => ({
    id: record.observationId,
    scoringVersion: record.scoringVersion,
    split: record.split,
    producerKind: record.observed.producerKind,
    expectedMatch: record.judgedMatch,
    observedMatch: record.observed.observedMatch,
    ...(record.observed.observedActions === undefined ? {} : { observedActions: record.observed.observedActions }),
    routineEligible: record.observed.routineEligible,
    observedDisposition: record.observed.observedDisposition,
    sensitiveActionAutomatic: record.observed.sensitiveActionAutomatic,
    labelAuthority: record.judgedBy === "human_operator" ? "operator_approved" : "agent_judged",
    sequestered: false,
    exposure: "exposed" as const,
    assessmentStackSha256: record.observed.assessmentStackSha256,
    observedAt: record.observed.observedAt,
  }));
}

/**
 * Disagreement counters, reported separately and never summed (R6). There is deliberately no
 * aggregate error field.
 *
 * The reason is NOT double-counting: each counter keys on a distinct `observedMatch` and a case
 * carries exactly one, so they are mutually exclusive and in fact partition the disagreeing cases.
 * (An earlier version of this comment claimed a case could appear in more than one; it cannot.)
 * The reason is that a single "errors" scalar is the thing people optimise, and it erases the only
 * distinction that matters here — calling a duplicate novel is not the same failure as holding
 * something that was fine. A reader who wants the total can add these; the readout will not assert
 * it for them.
 */
export interface JudgementErrorDirections {
  /** Called exact_match, judged otherwise — over-confident in a duplicate. */
  readonly overconfidentExactMatch: number;
  /** Called clearly_novel, judged otherwise — over-confident in novelty. */
  readonly overconfidentClearlyNovel: number;
  /**
   * Called plausible_overlap, judged otherwise — the hold disagreed with. Null when the cohort's
   * scoring version does not measure it, which is not the same as zero.
   */
  readonly judgedDisagreementWithPlausibleOverlap: number | null;
  /** Called replay, judged otherwise. */
  readonly judgedDisagreementWithReplay: number;
  /** Called invalid, judged otherwise. */
  readonly judgedDisagreementWithInvalid: number;
}

export interface JudgementReadoutCohort {
  readonly scoringVersion: IntakeCalibrationScoringVersion;
  readonly sampleCount: number;
  readonly accuracy: number | null;
  readonly errorDirections: JudgementErrorDirections;
}

export interface JudgementReadout {
  readonly schemaVersion: typeof JUDGEMENT_READOUT_SCHEMA;
  readonly sampleCount: number;
  readonly cohorts: readonly JudgementReadoutCohort[];
}

export function summarizeJudgements(records: readonly JudgementRecord[]): JudgementReadout {
  const cohorts = scoreCalibrationCohorts(judgementCalibrationCases(records));
  return {
    schemaVersion: JUDGEMENT_READOUT_SCHEMA,
    sampleCount: records.length,
    cohorts: cohorts.map((cohort) => ({
      scoringVersion: cohort.scoringVersion,
      sampleCount: cohort.sampleCount,
      accuracy: cohort.accuracy,
      errorDirections: {
        overconfidentExactMatch: cohort.falseExact,
        overconfidentClearlyNovel: cohort.falseNovel,
        judgedDisagreementWithPlausibleOverlap: cohort.plausibleOverlapDisagreement,
        judgedDisagreementWithReplay: cohort.replayDisagreement,
        judgedDisagreementWithInvalid: cohort.invalidDisagreement,
      },
    })),
  };
}
