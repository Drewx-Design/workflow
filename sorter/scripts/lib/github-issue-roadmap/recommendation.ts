import {
  ASSESSMENT_CLASSES,
  assessmentContentSha256,
  hasCurrentBoundVerification,
  nowWipExceptionDirective,
  NOW_WIP_EXCEPTION_RESULTING_WIP,
  ORDINARY_NOW_CAP,
  verificationEvidenceId,
  type AssessmentClass,
  type IssueAssessment,
  type RoadmapAssessment,
} from "./assessment";
import type { CanonicalSnapshotV2, IssueSnapshotV2, RepositoryIdentityV2 } from "./snapshot-v2";
import { isVerificationFresh, snapshotContentSha256 } from "./snapshot-v2";
import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { issueFieldValueIdentity } from "./issue-field-value";

export const RECOMMENDATION_SCHEMA_VERSION = "github-issue-roadmap-recommendation/v1";
/** Review refuses snapshots more than five minutes old, matching capture's default remote-fetch window. */
export const REVIEW_SNAPSHOT_MAXIMUM_AGE_MS = 5 * 60 * 1_000;
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const HORIZONS = ["Now", "Next", "Later", "Parked"] as const;

type Priority = typeof PRIORITIES[number];
type Horizon = typeof HORIZONS[number] | null;
type EffectiveClass = AssessmentClass;

export interface RecommendationItem {
  readonly issueNumber: number;
  readonly title: string;
  readonly priority: Priority;
  readonly horizon: Horizon;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
  readonly resultingWip: number;
}

export interface ExclusionItem {
  readonly issueNumber: number;
  readonly title: string;
  readonly priority: Priority | null;
  readonly horizon: Horizon;
  readonly classification: EffectiveClass;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly counterEvidenceIds: readonly string[];
}

export interface ManualActionIntent {
  readonly issueNumber: number;
  readonly action: "promote_to_now" | "refresh_evidence" | "request_decision" | "review_candidate";
  readonly disposition: "recommendation_only";
  readonly executable: false;
  readonly rationale: string;
}

export interface RoadmapRecommendation {
  readonly schemaVersion: typeof RECOMMENDATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly snapshotContentSha256: string;
  readonly assessmentContentSha256: string;
  readonly originMainSha: string;
  readonly coverage: {
    readonly consideredIssueNumbers: readonly number[];
    readonly assessedIssueNumbers: readonly number[];
    readonly unassessedIssueNumbers: readonly number[];
    readonly complete: boolean;
  };
  readonly wip: {
    readonly ordinaryCap: typeof ORDINARY_NOW_CAP;
    readonly existingNowCount: number;
    readonly exceptionIssueNumber: number | null;
    readonly resultingWip: number;
  };
  readonly revalidatedNow: readonly ExclusionItem[];
  readonly recommendations: readonly RecommendationItem[];
  readonly exclusions: {
    readonly decisionNeeded: readonly ExclusionItem[];
    readonly blocked: readonly ExclusionItem[];
    readonly staleOrDisproved: readonly ExclusionItem[];
    readonly duplicateCandidates: readonly ExclusionItem[];
    readonly completionCandidates: readonly ExclusionItem[];
    readonly eligibleNotSelected: readonly ExclusionItem[];
    readonly uncertain: readonly ExclusionItem[];
  };
  readonly intentionalParallels: readonly ExclusionItem[];
  readonly evidenceRefresh: readonly {
    readonly issueNumber: number;
    readonly text: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly unresolvedTies: readonly {
    readonly issueNumbers: readonly number[];
    readonly remainingCapacity: number;
    readonly tradeoff: string;
  }[];
  readonly unresolvedChecks: readonly string[];
  readonly manualActionIntents: readonly ManualActionIntent[];
  readonly contentSha256: string;
}

type JsonObject = Record<string, unknown>;

function hash(value: unknown): string {
  return canonicalJsonSha256(value);
}

export function recommendationArtifactJson(artifact: RoadmapRecommendation): string {
  return prettyCanonicalJson(artifact);
}

function fieldValues(issue: IssueSnapshotV2, name: "Priority" | "Horizon"): string[] {
  return issue.v1.fieldValues.map(issueFieldValueIdentity)
    .filter((entry) => entry.name === name && entry.value !== null)
    .map((entry) => entry.value as string);
}

function issueTuple(issue: IssueSnapshotV2): {
  priority: Priority | null;
  horizon: Horizon;
  invalidReasons: string[];
} {
  const priorityValues = fieldValues(issue, "Priority");
  const horizonValues = fieldValues(issue, "Horizon");
  const invalidReasons: string[] = [];
  if (priorityValues.length !== 1 || !PRIORITIES.includes(priorityValues[0] as Priority)) {
    invalidReasons.push("Priority must contain exactly one supported value.");
  }
  if (horizonValues.length > 1 || (horizonValues.length === 1 && !HORIZONS.includes(horizonValues[0] as Exclude<Horizon, null>))) {
    invalidReasons.push("Horizon contains an unsupported or duplicate value.");
  }
  return {
    priority: priorityValues.length === 1 && PRIORITIES.includes(priorityValues[0] as Priority)
      ? priorityValues[0] as Priority : null,
    horizon: horizonValues.length === 0 ? null : horizonValues[0] as Horizon,
    invalidReasons,
  };
}

function reviewTimestamp(snapshot: CanonicalSnapshotV2, assessment: RoadmapAssessment, reviewedAt: string): number {
  const reviewedAtTime = Date.parse(reviewedAt);
  const generatedAtTime = Date.parse(snapshot.generatedAt);
  const fetchedAtTime = Date.parse(snapshot.git.fetchedAt);
  const assessmentAtTime = Date.parse(assessment.generatedAt);
  if (!Number.isFinite(reviewedAtTime)) throw new Error("Recommendation review time must be an ISO timestamp.");
  if (reviewedAtTime < generatedAtTime || reviewedAtTime - generatedAtTime > REVIEW_SNAPSHOT_MAXIMUM_AGE_MS) {
    throw new Error("Recommendation refuses a canonical snapshot older than 5 minutes at review time.");
  }
  if (reviewedAtTime < fetchedAtTime || reviewedAtTime - fetchedAtTime > REVIEW_SNAPSHOT_MAXIMUM_AGE_MS) {
    throw new Error("Recommendation refuses an origin/main fetch older than 5 minutes at review time.");
  }
  if (!Number.isFinite(assessmentAtTime) || assessmentAtTime < generatedAtTime || assessmentAtTime > reviewedAtTime) {
    throw new Error("Recommendation assessment time must fall between snapshot capture and review.");
  }
  return reviewedAtTime;
}

interface EvaluatedIssue {
  readonly issue: IssueSnapshotV2;
  readonly assessment: IssueAssessment | null;
  readonly priority: Priority | null;
  readonly horizon: Horizon;
  readonly effectiveClass: EffectiveClass;
  readonly reasons: readonly string[];
  readonly eligible: boolean;
}

function evaluateIssue(
  snapshot: CanonicalSnapshotV2,
  issue: IssueSnapshotV2,
  assessment: IssueAssessment | null,
  reviewedAt: string,
): EvaluatedIssue {
  const tuple = issueTuple(issue);
  const reasons = [...tuple.invalidReasons];
  let effectiveClass: EffectiveClass = assessment?.classification ?? "uncertain";
  if (assessment === null) reasons.push("No assessment was supplied for this considered issue.");
  if (issue.v1.state !== "OPEN") {
    effectiveClass = "uncertain";
    reasons.push("The issue is not open in the canonical snapshot.");
  }
  if (snapshot.git.freshness !== "current") {
    effectiveClass = "uncertain";
    reasons.push("The recorded origin/main fetch is stale or unavailable.");
  }
  if (snapshot.coverage.missingIssueNumbers.length > 0 || !snapshot.coverage.complete) {
    effectiveClass = "uncertain";
    reasons.push("Canonical snapshot hydration is incomplete.");
  }
  if (issue.projectMemberships.every((membership) => membership.project.number !== 1)) {
    effectiveClass = "uncertain";
    reasons.push("Project 1 membership is missing from the canonical snapshot.");
  }
  if (!hasCurrentBoundVerification(issue, snapshot, reviewedAt)) {
    effectiveClass = "uncertain";
    reasons.push("Persisted verification is missing, stale, untrusted, or bound to another origin/main SHA.");
  } else if (assessment?.classification === "eligible_now" &&
      !hasCurrentBoundVerification(issue, snapshot, reviewedAt, assessment.evidenceIds)) {
    effectiveClass = "uncertain";
    reasons.push("Cited persisted verification is stale, untrusted, or bound to another origin/main SHA at review time.");
  }
  if (tuple.invalidReasons.length > 0) effectiveClass = "uncertain";
  const blockers = new Set([
    ...issue.relationships.blockedBy.map((entry) => entry.number),
    ...(assessment?.blockerIssueNumbers ?? []),
  ]);
  if (blockers.size > 0) {
    effectiveClass = "blocked";
    reasons.push(`Unresolved blockers: ${[...blockers].sort((a, b) => a - b).map((number) => `#${number}`).join(", ")}.`);
  }
  if (assessment?.unresolvedDecision) {
    effectiveClass = "decision_needed";
    reasons.push("An unresolved decision prevents execution.");
  }
  if (assessment?.premiseDisproved) {
    effectiveClass = "stale_or_disproved";
    reasons.push("Current evidence disproves or supersedes the issue premise.");
  }
  if (reasons.length === 0 && effectiveClass !== "eligible_now") {
    reasons.push(assessment?.summary ?? "This issue is not eligible for Now.");
  }
  return {
    issue,
    assessment,
    priority: tuple.priority,
    horizon: tuple.horizon,
    effectiveClass,
    reasons,
    eligible: reasons.length === 0 && effectiveClass === "eligible_now",
  };
}

function exclusion(entry: EvaluatedIssue, additionalReasons: readonly string[] = []): ExclusionItem {
  return {
    issueNumber: entry.issue.identity.number,
    title: entry.issue.v1.title,
    priority: entry.priority,
    horizon: entry.horizon,
    classification: entry.effectiveClass,
    reasons: [...entry.reasons, ...additionalReasons],
    evidenceIds: entry.assessment?.evidenceIds ?? [],
    counterEvidenceIds: entry.assessment?.counterEvidenceIds ?? [],
  };
}

function discoveryRank(entry: EvaluatedIssue): readonly [number, number, number] {
  const priority = PRIORITIES.indexOf(entry.priority as Priority);
  if (entry.priority === "P0" || entry.priority === "P1") return [0, priority, 0];
  if (entry.horizon === "Next") return [1, priority, 0];
  const horizon = entry.horizon === null ? 0 : entry.horizon === "Later" ? 1 : 2;
  return [2, horizon, priority];
}

function compareRank(left: EvaluatedIssue, right: EvaluatedIssue): number {
  const a = discoveryRank(left);
  const b = discoveryRank(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function sameRank(left: EvaluatedIssue, right: EvaluatedIssue): boolean {
  return JSON.stringify(discoveryRank(left)) === JSON.stringify(discoveryRank(right));
}

function actionFor(entry: EvaluatedIssue): ManualActionIntent["action"] {
  if (entry.effectiveClass === "decision_needed") return "request_decision";
  if (entry.effectiveClass === "uncertain" && entry.reasons.some((reason) => /verification|origin\/main/i.test(reason))) {
    return "refresh_evidence";
  }
  return "review_candidate";
}

export function buildRecommendation(
  snapshot: CanonicalSnapshotV2,
  assessment: RoadmapAssessment,
  reviewedAt: string,
): RoadmapRecommendation {
  if (snapshot.recovery.mutationClientPresent || snapshot.recovery.mode !== "read_only") {
    throw new Error("Recommendation requires a structurally read-only canonical snapshot.");
  }
  if (assessment.snapshotContentSha256 !== snapshotContentSha256(snapshot)) {
    throw new Error("Recommendation assessment is not bound to this canonical snapshot.");
  }
  reviewTimestamp(snapshot, assessment, reviewedAt);
  const assessedIssueNumbers = assessment.issueAssessments.map((entry) => entry.issueNumber)
    .sort((left, right) => left - right);
  const consideredIssueNumbers = [...snapshot.coverage.consideredIssueNumbers]
    .sort((left, right) => left - right);
  if (JSON.stringify(assessedIssueNumbers) !== JSON.stringify(consideredIssueNumbers) ||
      new Set(assessedIssueNumbers).size !== assessedIssueNumbers.length) {
    throw new Error("Recommendation requires exactly one assessment for every considered issue.");
  }
  const assessmentByIssue = new Map(assessment.issueAssessments.map((entry) => [entry.issueNumber, entry]));
  const intentsByKey = new Map(assessment.intents.map((intent) => [
    `${intent.issueNumber}:${intent.kind}`,
    intent,
  ]));
  const intentsByIssue = new Map<number, typeof assessment.intents[number][]>();
  for (const intent of assessment.intents) {
    const issueIntents = intentsByIssue.get(intent.issueNumber) ?? [];
    issueIntents.push(intent);
    intentsByIssue.set(intent.issueNumber, issueIntents);
  }
  const intentKeys = new Set(intentsByKey.keys());
  const consideredSet = new Set(snapshot.coverage.consideredIssueNumbers);
  const evaluated = [...snapshot.issues]
    .filter((issue) => consideredSet.has(issue.identity.number))
    .map((issue) => evaluateIssue(snapshot, issue, assessmentByIssue.get(issue.identity.number) ?? null, reviewedAt));
  const evaluatedByNumber = new Map(evaluated.map((entry) => [entry.issue.identity.number, entry]));
  const hydratedIssueNumbers = new Set(snapshot.coverage.hydratedIssueNumbers);
  const missingNow = snapshot.census.nowIssueNumbers.filter((number) =>
    !snapshot.coverage.consideredIssueNumbers.includes(number) || !hydratedIssueNumbers.has(number));
  if (missingNow.length > 0) {
    throw new Error(`Recommendation refuses an incomplete Now census; consider and hydrate [${missingNow.join(", ")}].`);
  }
  const existingNow = snapshot.census.nowIssueNumbers.map((number) => {
    const entry = evaluatedByNumber.get(number);
    if (entry === undefined || entry.horizon !== "Now") {
      throw new Error(`Canonical Now census disagrees with hydrated issue #${number}.`);
    }
    return entry;
  });
  if (existingNow.length > ORDINARY_NOW_CAP) {
    throw new Error(`Recommendation refuses a Now census that already contains ${existingNow.length} issues above the ordinary cap of ${ORDINARY_NOW_CAP}.`);
  }
  const exception = assessment.fourthItemException;
  if (exception !== null) {
    const exceptionIssue = snapshot.issues.find((issue) => issue.identity.number === exception.issueNumber);
    const exceptionRecord = exceptionIssue?.persistedVerifications.find((record, index) =>
      verificationEvidenceId(exceptionIssue, index) === exception.evidenceId);
    const expectedDirective = nowWipExceptionDirective(exception.issueNumber);
    if (exceptionRecord === undefined || exceptionRecord.trust.status !== "trusted" ||
        exceptionRecord.verifiedAt === null || !isVerificationFresh(exceptionRecord.verifiedAt, reviewedAt) ||
        exceptionRecord.originMainSha !== snapshot.git.originMainSha || exceptionRecord.check !== expectedDirective) {
      throw new Error("Recommendation over-cap exception is not current, trusted, and origin-main-bound at review time.");
    }
  }
  const ordinaryCapacity = Math.max(0, ORDINARY_NOW_CAP - existingNow.length);
  const candidates = evaluated.filter((entry) =>
    entry.horizon !== "Now" && entry.eligible &&
    intentKeys.has(`${entry.issue.identity.number}:consider_now`))
    .sort((left, right) => compareRank(left, right) || left.issue.identity.number - right.issue.identity.number);
  const recommendations: EvaluatedIssue[] = [];
  const unresolvedTies: RoadmapRecommendation["unresolvedTies"][number][] = [];
  const exceptionalCandidate = exception === null
    ? undefined
    : candidates.find((entry) => entry.issue.identity.number === exception.issueNumber);
  const ordinaryCandidates = exception === null
    ? candidates
    : candidates.filter((entry) => entry.issue.identity.number !== exception.issueNumber);
  for (let index = 0; index < ordinaryCandidates.length && recommendations.length < ordinaryCapacity;) {
    const first = ordinaryCandidates[index];
    let end = index + 1;
    while (end < ordinaryCandidates.length && sameRank(first, ordinaryCandidates[end])) end += 1;
    const group = ordinaryCandidates.slice(index, end);
    const remaining = ordinaryCapacity - recommendations.length;
    if (group.length > remaining) {
      unresolvedTies.push({
        issueNumbers: group.map((entry) => entry.issue.identity.number).sort((a, b) => a - b),
        remainingCapacity: remaining,
        tradeoff: "These candidates have the same deterministic rank; the operator must choose rather than letting issue number invent priority.",
      });
      break;
    }
    recommendations.push(...group);
    index = end;
  }
  if (exceptionalCandidate !== undefined && unresolvedTies.length === 0) {
    recommendations.push(exceptionalCandidate);
  }
  const selected = new Set(recommendations.map((entry) => entry.issue.identity.number));
  const excluded = evaluated.filter((entry) => entry.horizon !== "Now" && !selected.has(entry.issue.identity.number));
  const classifiedExclusions = new Map<EffectiveClass, ExclusionItem[]>();
  const intentionalParallels: ExclusionItem[] = [];
  const evidenceRefresh: RoadmapRecommendation["evidenceRefresh"][number][] = [];
  for (const entry of excluded) {
    if (entry.assessment?.intentionalParallel) {
      intentionalParallels.push(exclusion(entry));
    } else {
      const bucket = classifiedExclusions.get(entry.effectiveClass) ?? [];
      bucket.push(exclusion(entry));
      classifiedExclusions.set(entry.effectiveClass, bucket);
    }
    if (entry.effectiveClass === "uncertain" &&
        entry.reasons.some((reason) => /verification|origin\/main/i.test(reason))) {
      evidenceRefresh.push({
        issueNumber: entry.issue.identity.number,
        text: entry.assessment?.evidenceRefresh ??
          `Refresh #${entry.issue.identity.number} against origin/main ${snapshot.git.originMainSha}: record current code/test evidence and a confirming check in a trusted verification marker.`,
        evidenceIds: entry.assessment?.evidenceIds ?? [],
      });
    }
  }
  const classified = (classification: EffectiveClass): ExclusionItem[] =>
    [...(classifiedExclusions.get(classification) ?? [])]
      .sort((left, right) => left.issueNumber - right.issueNumber);
  intentionalParallels.sort((left, right) => left.issueNumber - right.issueNumber);
  evidenceRefresh.sort((left, right) => left.issueNumber - right.issueNumber);
  const unresolvedChecks = [
    ...(snapshot.git.freshness === "current" ? [] : ["Refresh origin/main before relying on code-grounded recommendations."]),
    ...assessment.issueAssessments.length === snapshot.coverage.consideredIssueNumbers.length
      ? [] : ["Some considered issues have no semantic assessment."],
    ...unresolvedTies.map((tie) => `Resolve the equal-rank tradeoff among ${tie.issueNumbers.map((number) => `#${number}`).join(", ")}.`),
  ];
  const recommendationItems: RecommendationItem[] = recommendations.map((entry, index) => ({
    issueNumber: entry.issue.identity.number,
    title: entry.issue.v1.title,
    priority: entry.priority as Priority,
    horizon: entry.horizon,
    summary: entry.assessment?.summary ?? "Eligible after deterministic gates.",
    evidenceIds: entry.assessment?.evidenceIds ?? [],
    resultingWip: existingNow.length + index + 1,
  }));
  const manualActionIntents: ManualActionIntent[] = [
    ...recommendationItems.map((entry): ManualActionIntent => ({
      issueNumber: entry.issueNumber,
      action: "promote_to_now",
      disposition: "recommendation_only",
      executable: false,
      rationale: intentsByKey.get(`${entry.issueNumber}:consider_now`)?.rationale ??
        `Manual-only recommendation to move #${entry.issueNumber} into Now after the operator reviews the evidence.`,
    })),
    ...excluded.flatMap((entry): ManualActionIntent[] => (intentsByIssue.get(entry.issue.identity.number) ?? [])
      .flatMap((intent) => {
        if (intent.kind === "refresh_evidence" && entry.effectiveClass !== "uncertain") return [];
        if (intent.kind === "request_decision" && entry.effectiveClass !== "decision_needed") return [];
        if (intent.kind === "consider_now" && entry.effectiveClass !== "eligible_now") return [];
        return [{
          issueNumber: entry.issue.identity.number,
          action: intent.kind === "refresh_evidence" ? "refresh_evidence"
            : intent.kind === "request_decision" ? "request_decision" : actionFor(entry),
          disposition: "recommendation_only",
          executable: false,
          rationale: intent.rationale,
        }];
      })),
  ].sort((left, right) => left.issueNumber - right.issueNumber || left.action.localeCompare(right.action));
  const draft: Omit<RoadmapRecommendation, "contentSha256"> = {
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    generatedAt: assessment.generatedAt,
    repository: snapshot.repository,
    snapshotContentSha256: assessment.snapshotContentSha256,
    assessmentContentSha256: assessmentContentSha256(assessment),
    originMainSha: snapshot.git.originMainSha,
    coverage: {
      consideredIssueNumbers: [...snapshot.coverage.consideredIssueNumbers].sort((a, b) => a - b),
      assessedIssueNumbers: [...assessmentByIssue.keys()].sort((a, b) => a - b),
      unassessedIssueNumbers: snapshot.coverage.consideredIssueNumbers
        .filter((number) => !assessmentByIssue.has(number)).sort((a, b) => a - b),
      complete: snapshot.coverage.complete && assessment.issueAssessments.length === snapshot.coverage.consideredIssueNumbers.length,
    },
    wip: {
      ordinaryCap: ORDINARY_NOW_CAP,
      existingNowCount: existingNow.length,
      exceptionIssueNumber: exception !== null &&
        recommendations.some((entry) => entry.issue.identity.number === exception.issueNumber) &&
        existingNow.length + recommendations.length === NOW_WIP_EXCEPTION_RESULTING_WIP
        ? exception.issueNumber : null,
      resultingWip: existingNow.length + recommendations.length,
    },
    revalidatedNow: existingNow.map((entry) => exclusion(entry)).sort((left, right) => left.issueNumber - right.issueNumber),
    recommendations: recommendationItems,
    exclusions: {
      decisionNeeded: classified("decision_needed"),
      blocked: classified("blocked"),
      staleOrDisproved: classified("stale_or_disproved"),
      duplicateCandidates: classified("duplicate_candidate"),
      completionCandidates: classified("completion_candidate"),
      eligibleNotSelected: excluded.filter((entry) => entry.effectiveClass === "eligible_now")
        .map((entry) => exclusion(entry, [
          unresolvedTies.some((tie) => tie.issueNumbers.includes(entry.issue.identity.number))
            ? "Eligible but not selected because an equal-rank group exceeds remaining capacity."
            : "Eligible but not selected because the Now capacity or issue-specific exception does not permit it.",
        ])).sort((left, right) => left.issueNumber - right.issueNumber),
      uncertain: classified("uncertain"),
    },
    intentionalParallels,
    evidenceRefresh,
    unresolvedTies,
    unresolvedChecks: [...new Set(unresolvedChecks)].sort(),
    manualActionIntents,
  };
  return { ...draft, contentSha256: hash(draft) };
}

export function assertRecommendationArtifact(raw: unknown): RoadmapRecommendation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("recommendation artifact must be an object.");
  }
  const value = raw as JsonObject;
  const exact = [
    "schemaVersion", "generatedAt", "snapshotContentSha256", "assessmentContentSha256",
    "repository", "originMainSha", "coverage", "wip", "revalidatedNow", "recommendations", "exclusions",
    "intentionalParallels", "evidenceRefresh", "unresolvedTies", "unresolvedChecks",
    "manualActionIntents", "contentSha256",
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exact)) {
    throw new Error(`recommendation artifact must contain exact keys [${exact.join(", ")}].`);
  }
  if (value.schemaVersion !== RECOMMENDATION_SCHEMA_VERSION) {
    throw new Error(`recommendation artifact schema must be ${RECOMMENDATION_SCHEMA_VERSION}.`);
  }
  const nonEmptyString = (rawValue: unknown, context: string): string => {
    if (typeof rawValue !== "string" || rawValue.trim() === "") {
      throw new Error(`${context} must be a non-empty string.`);
    }
    return rawValue;
  };
  const canonicalTimestamp = (rawValue: unknown, context: string): string => {
    const timestamp = nonEmptyString(rawValue, context);
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
      throw new Error(`${context} must be a canonical ISO timestamp.`);
    }
    return timestamp;
  };
  const integer = (rawValue: unknown, context: string, minimum = 0): number => {
    if (!Number.isSafeInteger(rawValue) || (rawValue as number) < minimum) {
      throw new Error(`${context} must be an integer greater than or equal to ${minimum}.`);
    }
    return rawValue as number;
  };
  const exactHash = (rawValue: unknown, length: number, context: string): string => {
    const candidate = nonEmptyString(rawValue, context);
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(candidate)) {
      throw new Error(`${context} must be a ${length}-character lowercase hexadecimal hash.`);
    }
    return candidate;
  };
  const sortedUniqueNumbers = (rawValue: unknown, context: string): number[] => {
    if (!Array.isArray(rawValue)) throw new Error(`${context} must be an array.`);
    const parsed = rawValue.map((entry, index) => integer(entry, `${context}[${index}]`, 1));
    if (new Set(parsed).size !== parsed.length || parsed.some((entry, index) => index > 0 && parsed[index - 1] >= entry)) {
      throw new Error(`${context} must contain sorted unique positive issue numbers.`);
    }
    return parsed;
  };
  const sortedUniqueStrings = (rawValue: unknown, context: string, allowEmpty = true): string[] => {
    if (!Array.isArray(rawValue)) throw new Error(`${context} must be an array.`);
    const parsed = rawValue.map((entry, index) => nonEmptyString(entry, `${context}[${index}]`));
    if (!allowEmpty && parsed.length === 0) throw new Error(`${context} must not be empty.`);
    if (new Set(parsed).size !== parsed.length || parsed.some((entry, index) => index > 0 && parsed[index - 1].localeCompare(entry) >= 0)) {
      throw new Error(`${context} must contain sorted unique strings.`);
    }
    return parsed;
  };
  const uniqueStrings = (rawValue: unknown, context: string): string[] => {
    if (!Array.isArray(rawValue)) throw new Error(`${context} must be an array.`);
    const parsed = rawValue.map((entry, index) => nonEmptyString(entry, `${context}[${index}]`));
    if (new Set(parsed).size !== parsed.length) throw new Error(`${context} must contain unique strings.`);
    return parsed;
  };
  const exactNested = (rawValue: unknown, keys: readonly string[], context: string): JsonObject => {
    if (rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error(`${context} must be an object.`);
    }
    const record = rawValue as JsonObject;
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
      throw new Error(`${context} must contain exact keys [${[...keys].sort().join(", ")}].`);
    }
    return record;
  };
  const exactArray = (rawValue: unknown, keys: readonly string[], context: string): JsonObject[] => {
    if (!Array.isArray(rawValue)) throw new Error(`${context} must be an array.`);
    return rawValue.map((entry, index) => exactNested(entry, keys, `${context}[${index}]`));
  };
  canonicalTimestamp(value.generatedAt, "recommendation.generatedAt");
  const repository = exactNested(
    value.repository,
    ["organization", "name", "databaseId", "nodeId"],
    "recommendation.repository",
  );
  nonEmptyString(repository.organization, "recommendation.repository.organization");
  nonEmptyString(repository.name, "recommendation.repository.name");
  integer(repository.databaseId, "recommendation.repository.databaseId", 1);
  nonEmptyString(repository.nodeId, "recommendation.repository.nodeId");
  exactHash(value.snapshotContentSha256, 64, "recommendation.snapshotContentSha256");
  exactHash(value.assessmentContentSha256, 64, "recommendation.assessmentContentSha256");
  exactHash(value.originMainSha, 40, "recommendation.originMainSha");
  const coverage = exactNested(value.coverage, ["consideredIssueNumbers", "assessedIssueNumbers", "unassessedIssueNumbers", "complete"], "recommendation.coverage");
  const considered = sortedUniqueNumbers(coverage.consideredIssueNumbers, "recommendation.coverage.consideredIssueNumbers");
  const assessed = sortedUniqueNumbers(coverage.assessedIssueNumbers, "recommendation.coverage.assessedIssueNumbers");
  const unassessed = sortedUniqueNumbers(coverage.unassessedIssueNumbers, "recommendation.coverage.unassessedIssueNumbers");
  const combinedAssessment = [...assessed, ...unassessed].sort((left, right) => left - right);
  if (JSON.stringify(combinedAssessment) !== JSON.stringify(considered) || coverage.complete !== (unassessed.length === 0)) {
    throw new Error("recommendation.coverage assessed and unassessed issue numbers must exactly partition considered coverage.");
  }
  const consideredSet = new Set(considered);
  const coveredIssueNumber = (rawValue: unknown, context: string): number => {
    const issueNumber = integer(rawValue, context, 1);
    if (!consideredSet.has(issueNumber)) throw new Error(`${context} must name a covered issue.`);
    return issueNumber;
  };
  const issueEvidence = (
    rawValue: unknown,
    issueNumber: number,
    context: string,
    allowEmpty = false,
  ): string[] => {
    const ids = sortedUniqueStrings(rawValue, context, allowEmpty);
    if (!allowEmpty && !ids.some((id) => id.startsWith(`issue:${issueNumber}:`))) {
      throw new Error(`${context} must cite evidence belonging to issue #${issueNumber}.`);
    }
    if (ids.some((id) => id.startsWith("issue:") && !id.startsWith(`issue:${issueNumber}:`))) {
      throw new Error(`${context} cannot cite evidence belonging to another issue.`);
    }
    return ids;
  };
  const priority = (rawValue: unknown, context: string, nullable: boolean): Priority | null => {
    if (nullable && rawValue === null) return null;
    if (!PRIORITIES.includes(rawValue as Priority)) throw new Error(`${context} has an unsupported Priority.`);
    return rawValue as Priority;
  };
  const horizon = (rawValue: unknown, context: string): Horizon => {
    if (rawValue === null) return null;
    if (!HORIZONS.includes(rawValue as Exclude<Horizon, null>)) throw new Error(`${context} has an unsupported Horizon.`);
    return rawValue as Exclude<Horizon, null>;
  };
  const wip = exactNested(value.wip, ["ordinaryCap", "existingNowCount", "exceptionIssueNumber", "resultingWip"], "recommendation.wip");
  if (wip.ordinaryCap !== ORDINARY_NOW_CAP) throw new Error(`recommendation.wip.ordinaryCap must be ${ORDINARY_NOW_CAP}.`);
  const existingNowCount = integer(wip.existingNowCount, "recommendation.wip.existingNowCount");
  const resultingWip = integer(wip.resultingWip, "recommendation.wip.resultingWip");
  if (existingNowCount > ORDINARY_NOW_CAP) throw new Error("recommendation.wip.existingNowCount exceeds the ordinary cap.");
  const exclusionKeys = ["issueNumber", "title", "priority", "horizon", "classification", "reasons", "evidenceIds", "counterEvidenceIds"];
  const parseExclusion = (entry: JsonObject, context: string, expectedClass?: EffectiveClass): number => {
    const issueNumber = coveredIssueNumber(entry.issueNumber, `${context}.issueNumber`);
    nonEmptyString(entry.title, `${context}.title`);
    priority(entry.priority, `${context}.priority`, true);
    horizon(entry.horizon, `${context}.horizon`);
    if (!ASSESSMENT_CLASSES.includes(entry.classification as AssessmentClass)) {
      throw new Error(`${context}.classification is unsupported.`);
    }
    if (expectedClass !== undefined && entry.classification !== expectedClass) {
      throw new Error(`${context}.classification must be ${expectedClass}.`);
    }
    uniqueStrings(entry.reasons, `${context}.reasons`);
    issueEvidence(entry.evidenceIds, issueNumber, `${context}.evidenceIds`);
    issueEvidence(entry.counterEvidenceIds, issueNumber, `${context}.counterEvidenceIds`, true);
    return issueNumber;
  };
  const revalidatedNow = exactArray(value.revalidatedNow, exclusionKeys, "recommendation.revalidatedNow");
  const revalidatedNumbers = revalidatedNow.map((entry, index) => {
    const issueNumber = parseExclusion(entry, `recommendation.revalidatedNow[${index}]`);
    if (entry.horizon !== "Now") throw new Error(`recommendation.revalidatedNow[${index}].horizon must be Now.`);
    return issueNumber;
  });
  if (new Set(revalidatedNumbers).size !== revalidatedNumbers.length || revalidatedNumbers.length !== existingNowCount) {
    throw new Error("recommendation.revalidatedNow must contain exactly the existing Now census.");
  }
  const recommendations = exactArray(value.recommendations, ["issueNumber", "title", "priority", "horizon", "summary", "evidenceIds", "resultingWip"], "recommendation.recommendations");
  const recommendationNumbers = recommendations.map((entry, index) => {
    const context = `recommendation.recommendations[${index}]`;
    const issueNumber = coveredIssueNumber(entry.issueNumber, `${context}.issueNumber`);
    nonEmptyString(entry.title, `${context}.title`);
    priority(entry.priority, `${context}.priority`, false);
    if (horizon(entry.horizon, `${context}.horizon`) === "Now") throw new Error(`${context}.horizon cannot already be Now.`);
    nonEmptyString(entry.summary, `${context}.summary`);
    const evidenceIds = issueEvidence(entry.evidenceIds, issueNumber, `${context}.evidenceIds`);
    if (!evidenceIds.some((id) => id.startsWith(`issue:${issueNumber}:verification:`))) {
      throw new Error(`${context}.evidenceIds must include current verification evidence.`);
    }
    const itemWip = integer(entry.resultingWip, `${context}.resultingWip`);
    if (itemWip !== existingNowCount + index + 1) throw new Error(`${context}.resultingWip is inconsistent with recommendation order.`);
    return issueNumber;
  });
  if (new Set(recommendationNumbers).size !== recommendationNumbers.length || resultingWip !== existingNowCount + recommendationNumbers.length) {
    throw new Error("recommendation WIP must equal existing Now work plus unique recommendations.");
  }
  const exclusions = exactNested(value.exclusions, [
    "decisionNeeded", "blocked", "staleOrDisproved", "duplicateCandidates",
    "completionCandidates", "eligibleNotSelected", "uncertain",
  ], "recommendation.exclusions");
  const exclusionClasses: Record<string, EffectiveClass> = {
    decisionNeeded: "decision_needed",
    blocked: "blocked",
    staleOrDisproved: "stale_or_disproved",
    duplicateCandidates: "duplicate_candidate",
    completionCandidates: "completion_candidate",
    eligibleNotSelected: "eligible_now",
    uncertain: "uncertain",
  };
  const partitionEntries: Array<{ readonly issueNumber: number; readonly context: string }> = [
    ...revalidatedNumbers.map((issueNumber, index) => ({
      issueNumber,
      context: `recommendation.revalidatedNow[${index}]`,
    })),
    ...recommendationNumbers.map((issueNumber, index) => ({
      issueNumber,
      context: `recommendation.recommendations[${index}]`,
    })),
  ];
  for (const [name, entries] of Object.entries(exclusions)) {
    exactArray(entries, exclusionKeys, `recommendation.exclusions.${name}`)
      .forEach((entry, index) => {
        const context = `recommendation.exclusions.${name}[${index}]`;
        partitionEntries.push({
          issueNumber: parseExclusion(entry, context, exclusionClasses[name]),
          context,
        });
      });
  }
  exactArray(value.intentionalParallels, exclusionKeys, "recommendation.intentionalParallels")
    .forEach((entry, index) => {
      const context = `recommendation.intentionalParallels[${index}]`;
      partitionEntries.push({ issueNumber: parseExclusion(entry, context), context });
    });
  const partitionLocations = new Map<number, string[]>();
  for (const entry of partitionEntries) {
    const locations = partitionLocations.get(entry.issueNumber) ?? [];
    locations.push(entry.context);
    partitionLocations.set(entry.issueNumber, locations);
  }
  const duplicates = [...partitionLocations.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([issueNumber, locations]) => `#${issueNumber} (${locations.join(", ")})`);
  const omissions = considered.filter((issueNumber) => !partitionLocations.has(issueNumber));
  if (duplicates.length > 0 || omissions.length > 0) {
    throw new Error(
      "recommendation issue outputs must form a disjoint complete partition of considered coverage; " +
      `duplicates: [${duplicates.join("; ")}], omissions: [${omissions.map((number) => `#${number}`).join(", ")}].`,
    );
  }
  exactArray(value.evidenceRefresh, ["issueNumber", "text", "evidenceIds"], "recommendation.evidenceRefresh")
    .forEach((entry, index) => {
      const issueNumber = coveredIssueNumber(entry.issueNumber, `recommendation.evidenceRefresh[${index}].issueNumber`);
      nonEmptyString(entry.text, `recommendation.evidenceRefresh[${index}].text`);
      issueEvidence(entry.evidenceIds, issueNumber, `recommendation.evidenceRefresh[${index}].evidenceIds`);
    });
  exactArray(value.unresolvedTies, ["issueNumbers", "remainingCapacity", "tradeoff"], "recommendation.unresolvedTies")
    .forEach((entry, index) => {
      const issueNumbers = sortedUniqueNumbers(entry.issueNumbers, `recommendation.unresolvedTies[${index}].issueNumbers`);
      if (issueNumbers.some((issueNumber) => !consideredSet.has(issueNumber))) {
        throw new Error(`recommendation.unresolvedTies[${index}] names an uncovered issue.`);
      }
      integer(entry.remainingCapacity, `recommendation.unresolvedTies[${index}].remainingCapacity`, 1);
      nonEmptyString(entry.tradeoff, `recommendation.unresolvedTies[${index}].tradeoff`);
    });
  sortedUniqueStrings(value.unresolvedChecks, "recommendation.unresolvedChecks");
  const manualActions = new Set(["promote_to_now", "refresh_evidence", "request_decision", "review_candidate"]);
  const manualKeys: string[] = [];
  const promotedIssues = new Set<number>();
  exactArray(value.manualActionIntents, ["issueNumber", "action", "disposition", "executable", "rationale"], "recommendation.manualActionIntents")
    .forEach((entry, index) => {
      const context = `recommendation.manualActionIntents[${index}]`;
      const issueNumber = coveredIssueNumber(entry.issueNumber, `${context}.issueNumber`);
      if (!manualActions.has(entry.action as string)) throw new Error(`${context}.action is unsupported.`);
      if (entry.disposition !== "recommendation_only") throw new Error(`${context}.disposition must be recommendation_only.`);
      if (entry.executable !== false) throw new Error(`${context}.executable must be false.`);
      nonEmptyString(entry.rationale, `${context}.rationale`);
      manualKeys.push(`${issueNumber}:${String(entry.action)}`);
      if (entry.action === "promote_to_now") promotedIssues.add(issueNumber);
    });
  if (new Set(manualKeys).size !== manualKeys.length ||
      JSON.stringify([...promotedIssues].sort((a, b) => a - b)) !== JSON.stringify([...recommendationNumbers].sort((a, b) => a - b))) {
    throw new Error("recommendation.manualActionIntents must uniquely cover every promotion and no others.");
  }
  let exceptionIssueNumber: number | null = null;
  if (wip.exceptionIssueNumber !== null) {
    exceptionIssueNumber = coveredIssueNumber(wip.exceptionIssueNumber, "recommendation.wip.exceptionIssueNumber");
  }
  if (exceptionIssueNumber === null) {
    if (resultingWip > ORDINARY_NOW_CAP) throw new Error("recommendation.wip exceeds the ordinary cap without an exception.");
  } else if (resultingWip !== NOW_WIP_EXCEPTION_RESULTING_WIP ||
      recommendations.at(-1)?.issueNumber !== exceptionIssueNumber) {
    throw new Error("recommendation.wip exception must name the sole over-cap recommendation.");
  }
  const { contentSha256, ...draft } = value;
  exactHash(contentSha256, 64, "recommendation.contentSha256");
  if (contentSha256 !== hash(draft)) throw new Error("recommendation artifact content hash mismatch.");
  return raw as RoadmapRecommendation;
}
