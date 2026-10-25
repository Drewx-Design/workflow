import {
  isVerificationFresh,
  snapshotContentSha256,
  type CanonicalSnapshotV2,
  type IssueSnapshotV2,
} from "./snapshot-v2";
import { prettyCanonicalJson } from "./canonical-json";
import { createHash } from "node:crypto";

export const ASSESSMENT_SCHEMA_VERSION = "github-issue-roadmap-assessment/v1";
export const NOW_WIP_EXCEPTION_DIRECTIVE = "now-wip-exception:v1";
// docs/roadmap/milestone-1.md: Now holds 5-8; 8 is the ordinary ceiling.
export const ORDINARY_NOW_CAP = 8;
export const NOW_WIP_EXCEPTION_RESULTING_WIP = ORDINARY_NOW_CAP + 1;

export function nowWipExceptionDirective(issueNumber: number): string {
  return `${NOW_WIP_EXCEPTION_DIRECTIVE} issue=#${issueNumber} resulting-wip=${NOW_WIP_EXCEPTION_RESULTING_WIP}`;
}

export const ASSESSMENT_CLASSES = [
  "eligible_now",
  "decision_needed",
  "blocked",
  "stale_or_disproved",
  "duplicate_candidate",
  "completion_candidate",
  "uncertain",
] as const;

export type AssessmentClass = typeof ASSESSMENT_CLASSES[number];
export type RecommendationIntentKind = "consider_now" | "refresh_evidence" | "request_decision";

export interface IssueAssessment {
  readonly issueNumber: number;
  readonly classification: AssessmentClass;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
  readonly counterEvidenceIds: readonly string[];
  readonly unresolvedDecision: boolean;
  readonly blockerIssueNumbers: readonly number[];
  readonly premiseDisproved: boolean;
  readonly intentionalParallel: boolean;
  readonly evidenceRefresh: string | null;
}

export interface RecommendationIntent {
  readonly issueNumber: number;
  readonly kind: RecommendationIntentKind;
  readonly rationale: string;
}

export interface RoadmapAssessment {
  readonly schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  readonly snapshotContentSha256: string;
  readonly generatedAt: string;
  // The persisted name is historical; it names the single item over the ordinary cap.
  readonly fourthItemException: {
    readonly issueNumber: number;
    readonly evidenceId: string;
  } | null;
  readonly issueAssessments: readonly IssueAssessment[];
  readonly intents: readonly RecommendationIntent[];
}

type JsonObject = Record<string, unknown>;

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

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer.`);
  }
  return value as number;
}

function bool(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be boolean.`);
  return value;
}

function uniqueSortedNumbers(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const numbers = value.map((entry, index) => positiveInteger(entry, `${context}[${index}]`));
  if (new Set(numbers).size !== numbers.length) throw new Error(`${context} contains duplicates.`);
  return numbers.sort((left, right) => left - right);
}

function uniqueSortedStrings(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const strings = value.map((entry, index) => nonEmptyString(entry, `${context}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new Error(`${context} contains duplicates.`);
  return strings.sort();
}

export function assessmentJson(assessment: RoadmapAssessment): string {
  return prettyCanonicalJson(assessment);
}

export function assessmentContentSha256(assessment: RoadmapAssessment): string {
  return createHash("sha256").update(assessmentJson(assessment), "utf8").digest("hex");
}

export function verificationEvidenceId(issue: IssueSnapshotV2, index: number): string {
  const record = issue.persistedVerifications[index];
  return record.comment === null
    ? `issue:${issue.identity.number}:verification:body:${index}`
    : `issue:${issue.identity.number}:verification:comment:${record.comment.databaseId}`;
}

/**
 * Trusted AND fresh-at-`asOf` AND bound to the snapshot's origin/main SHA, evaluated against the
 * records rather than against the stored freshness summary.
 *
 * `asOf` must not precede `snapshot.generatedAt`. The recommendation path guarantees this by
 * calling reviewTimestamp() first, which refuses an earlier review time outright. A caller that
 * passed an earlier `asOf` would widen eligibility, because a record stale at capture time can be
 * fresh against an earlier clock.
 */
export function hasCurrentBoundVerification(
  issue: IssueSnapshotV2,
  snapshot: CanonicalSnapshotV2,
  asOf: string,
  citedEvidenceIds?: readonly string[],
): boolean {
  return issue.persistedVerifications.some((record, index) =>
    (citedEvidenceIds === undefined || citedEvidenceIds.includes(verificationEvidenceId(issue, index))) &&
    record.trust.status === "trusted" &&
    record.verifiedAt !== null &&
    isVerificationFresh(record.verifiedAt, asOf) &&
    record.originMainSha === snapshot.git.originMainSha);
}

export function evidenceIdsForSnapshot(snapshot: CanonicalSnapshotV2): ReadonlySet<string> {
  const ids = new Set<string>([
    `source:strategy:${snapshot.sourceIdentities.strategy.blobSha}`,
    `source:rubric:${snapshot.sourceIdentities.rubric.blobSha}`,
  ]);
  for (const issue of snapshot.issues) {
    ids.add(`issue:${issue.identity.number}:snapshot`);
    issue.persistedVerifications.forEach((_record, index) => ids.add(verificationEvidenceId(issue, index)));
    for (const pr of issue.pullRequests) {
      ids.add(
        `issue:${issue.identity.number}:pr:${pr.relationship}` +
        `:repository:${pr.identity.repository.databaseId}:${pr.identity.repository.nodeId}` +
        `:pull-request:${pr.identity.databaseId}:${pr.identity.nodeId}:${pr.identity.number}`,
      );
    }
  }
  return ids;
}

function parseAssessmentItem(
  raw: unknown,
  index: number,
  consideredIssues: ReadonlyMap<number, IssueSnapshotV2>,
  requiredIssueNumbers: ReadonlySet<number>,
  evidenceIds: ReadonlySet<string>,
  snapshot: CanonicalSnapshotV2,
): IssueAssessment {
  const context = `issueAssessments[${index}]`;
  const value = object(raw, context);
  exactKeys(value, [
    "issueNumber", "classification", "summary", "evidenceIds", "counterEvidenceIds",
    "unresolvedDecision", "blockerIssueNumbers", "premiseDisproved", "intentionalParallel",
    "evidenceRefresh",
  ], context);
  const issueNumber = positiveInteger(value.issueNumber, `${context}.issueNumber`);
  const issue = consideredIssues.get(issueNumber);
  if (issue === undefined) throw new Error(`${context} is outside considered snapshot coverage.`);
  if (!ASSESSMENT_CLASSES.includes(value.classification as AssessmentClass)) {
    throw new Error(`${context}.classification is unsupported.`);
  }
  const cited = uniqueSortedStrings(value.evidenceIds, `${context}.evidenceIds`);
  const counter = uniqueSortedStrings(value.counterEvidenceIds, `${context}.counterEvidenceIds`);
  for (const id of [...cited, ...counter]) {
    if (!evidenceIds.has(id)) throw new Error(`${context} cites evidence ID outside the bound snapshot: ${id}.`);
    if (id.startsWith("issue:") && !id.startsWith(`issue:${issueNumber}:`)) {
      throw new Error(`${context} cites evidence that belongs to another issue: ${id}.`);
    }
  }
  if (!cited.some((id) => id.startsWith(`issue:${issueNumber}:`))) {
    throw new Error(`${context}.evidenceIds must cite at least one evidence record belonging to issue #${issueNumber}.`);
  }
  const blockers = uniqueSortedNumbers(value.blockerIssueNumbers, `${context}.blockerIssueNumbers`);
  for (const blocker of blockers) {
    if (!requiredIssueNumbers.has(blocker)) throw new Error(`${context} blocker #${blocker} is not hydrated.`);
  }
  const unresolvedDecision = bool(value.unresolvedDecision, `${context}.unresolvedDecision`);
  const premiseDisproved = bool(value.premiseDisproved, `${context}.premiseDisproved`);
  const intentionalParallel = bool(value.intentionalParallel, `${context}.intentionalParallel`);
  if (value.classification === "eligible_now" &&
      (unresolvedDecision || blockers.length > 0 || premiseDisproved)) {
    throw new Error(`${context} contradicts eligible_now hard-gate inputs.`);
  }
  if (value.classification === "eligible_now") {
    const citesCurrentVerification = issue.persistedVerifications.some((record, recordIndex) =>
      cited.includes(verificationEvidenceId(issue, recordIndex)) &&
      record.trust.status === "trusted" &&
      record.verifiedAt !== null &&
      isVerificationFresh(record.verifiedAt, snapshot.generatedAt) &&
      record.originMainSha === snapshot.git.originMainSha);
    if (!citesCurrentVerification) {
      throw new Error(`${context} eligible_now must cite the issue's own current, trusted, origin-main-bound verification evidence.`);
    }
  }
  if (value.classification === "decision_needed" && !unresolvedDecision) {
    throw new Error(`${context} decision_needed requires unresolvedDecision=true.`);
  }
  if (value.classification === "stale_or_disproved" && !premiseDisproved && value.evidenceRefresh === null) {
    throw new Error(`${context} stale_or_disproved requires disproval or an evidence refresh.`);
  }
  if (value.evidenceRefresh !== null && typeof value.evidenceRefresh !== "string") {
    throw new Error(`${context}.evidenceRefresh must be a string or null.`);
  }
  return {
    issueNumber,
    classification: value.classification as AssessmentClass,
    summary: nonEmptyString(value.summary, `${context}.summary`),
    evidenceIds: cited,
    counterEvidenceIds: counter,
    unresolvedDecision,
    blockerIssueNumbers: blockers,
    premiseDisproved,
    intentionalParallel,
    evidenceRefresh: value.evidenceRefresh === null ? null : nonEmptyString(value.evidenceRefresh, `${context}.evidenceRefresh`),
  };
}

function parseIntent(
  raw: unknown,
  index: number,
  issueNumbers: ReadonlySet<number>,
): RecommendationIntent {
  const context = `intents[${index}]`;
  const value = object(raw, context);
  exactKeys(value, ["issueNumber", "kind", "rationale"], context);
  const issueNumber = positiveInteger(value.issueNumber, `${context}.issueNumber`);
  if (!issueNumbers.has(issueNumber)) throw new Error(`${context} is outside snapshot coverage.`);
  if (!new Set(["consider_now", "refresh_evidence", "request_decision"]).has(value.kind as string)) {
    throw new Error(`${context}.kind is unsupported.`);
  }
  return {
    issueNumber,
    kind: value.kind as RecommendationIntentKind,
    rationale: nonEmptyString(value.rationale, `${context}.rationale`),
  };
}

export function parseAssessment(raw: unknown, snapshot: CanonicalSnapshotV2): RoadmapAssessment {
  const value = object(raw, "assessment");
  exactKeys(value, [
    "schemaVersion", "snapshotContentSha256", "generatedAt", "fourthItemException",
    "issueAssessments", "intents",
  ], "assessment");
  if (value.schemaVersion !== ASSESSMENT_SCHEMA_VERSION) {
    throw new Error(`assessment.schemaVersion must be ${ASSESSMENT_SCHEMA_VERSION}.`);
  }
  const boundSha = nonEmptyString(value.snapshotContentSha256, "assessment.snapshotContentSha256");
  if (boundSha !== snapshotContentSha256(snapshot)) {
    throw new Error("Assessment is not bound to this canonical snapshot content hash.");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("assessment.generatedAt must be an ISO timestamp.");
  }
  if (!Array.isArray(value.issueAssessments) || !Array.isArray(value.intents)) {
    throw new Error("assessment issueAssessments and intents must be arrays.");
  }
  const issueNumbers = new Set(snapshot.coverage.consideredIssueNumbers);
  const consideredIssues = new Map(snapshot.issues
    .filter((issue) => issueNumbers.has(issue.identity.number))
    .map((issue) => [issue.identity.number, issue]));
  const requiredIssueNumbers = new Set(snapshot.coverage.requiredIssueNumbers);
  const allowedEvidenceIds = evidenceIdsForSnapshot(snapshot);
  const issueAssessments = value.issueAssessments.map((entry, index) =>
    parseAssessmentItem(entry, index, consideredIssues, requiredIssueNumbers, allowedEvidenceIds, snapshot));
  const assessedNumbers = issueAssessments.map((entry) => entry.issueNumber);
  if (new Set(assessedNumbers).size !== assessedNumbers.length) {
    throw new Error("assessment.issueAssessments contains duplicate issue numbers.");
  }
  const missingAssessments = snapshot.coverage.consideredIssueNumbers
    .filter((issueNumber) => !assessedNumbers.includes(issueNumber));
  if (missingAssessments.length > 0 || assessedNumbers.length !== snapshot.coverage.consideredIssueNumbers.length) {
    throw new Error(`Assessment must contain exactly one entry for every considered issue; missing [${missingAssessments.join(", ")}].`);
  }
  const intents = value.intents.map((entry, index) => parseIntent(entry, index, issueNumbers));
  const intentKeys = intents.map((entry) => `${entry.issueNumber}:${entry.kind}`);
  if (new Set(intentKeys).size !== intentKeys.length) throw new Error("assessment.intents contains duplicates.");
  let fourthItemException: RoadmapAssessment["fourthItemException"] = null;
  if (value.fourthItemException !== null) {
    const exception = object(value.fourthItemException, "assessment.fourthItemException");
    exactKeys(exception, ["issueNumber", "evidenceId"], "assessment.fourthItemException");
    const issueNumber = positiveInteger(exception.issueNumber, "assessment.fourthItemException.issueNumber");
    const evidenceId = nonEmptyString(exception.evidenceId, "assessment.fourthItemException.evidenceId");
    const issue = snapshot.issues.find((entry) => entry.identity.number === issueNumber);
    const recordIndex = issue?.persistedVerifications.findIndex((_record, index) =>
      verificationEvidenceId(issue, index) === evidenceId) ?? -1;
    const record = recordIndex >= 0 ? issue?.persistedVerifications[recordIndex] : undefined;
    const expectedDirective = nowWipExceptionDirective(issueNumber);
    if (!issueNumbers.has(issueNumber) || !allowedEvidenceIds.has(evidenceId) || record === undefined ||
        record.trust.status !== "trusted" || record.verifiedAt === null ||
        !isVerificationFresh(record.verifiedAt, snapshot.generatedAt) ||
        record.originMainSha !== snapshot.git.originMainSha || record.check !== expectedDirective) {
      throw new Error(`The over-cap exception must cite current, trusted, origin-main-bound evidence with check: ${expectedDirective}.`);
    }
    fourthItemException = { issueNumber, evidenceId };
  }
  return {
    schemaVersion: ASSESSMENT_SCHEMA_VERSION,
    snapshotContentSha256: boundSha,
    generatedAt: new Date(value.generatedAt).toISOString(),
    fourthItemException,
    issueAssessments: issueAssessments.sort((left, right) => left.issueNumber - right.issueNumber),
    intents: intents.sort((left, right) => left.issueNumber - right.issueNumber || left.kind.localeCompare(right.kind)),
  };
}

export function selectTuningIssueNumbers(raw: unknown): number[] {
  const corpus = object(raw, "calibration corpus");
  const entries = corpus.items;
  if (!Array.isArray(entries)) throw new Error("calibration corpus.items must be an array.");
  const selected = entries.flatMap((rawEntry, index) => {
    const entry = object(rawEntry, `calibration corpus.entries[${index}]`);
    if (entry.split !== "tuning") return [];
    return [positiveInteger(entry.issueId, `calibration corpus.entries[${index}].issueId`)];
  });
  if (selected.length !== 40 || new Set(selected).size !== 40) {
    throw new Error("The development calibration split must contain exactly 40 unique tuning issues.");
  }
  return selected.sort((left, right) => left - right);
}
