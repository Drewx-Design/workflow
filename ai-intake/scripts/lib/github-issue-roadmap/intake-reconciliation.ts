import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { ORDINARY_NOW_CAP, evidenceIdsForSnapshot } from "./assessment";
import { intakeSnapshotEvidenceIds } from "./intake-assessment";
import { sameRepository, type IntakeSnapshotV1, type MarkerIncident } from "./intake-snapshot";
import type { OutcomeEnvelope } from "./outcome-candidate";
import { dispositionHistory, effectiveOutcomeCandidates } from "./disposition-history";
import type { RoadmapRecommendation } from "./recommendation";
import {
  isVerificationFresh,
  snapshotContentSha256,
  type CanonicalSnapshotV2,
  type IssueSnapshotV2,
} from "./snapshot-v2";

export const INTAKE_RECONCILIATION_SCHEMA =
  "github-issue-roadmap-intake-reconciliation/v1" as const;
export const WEEKLY_CAPTURE_MAXIMUM_AGE_MS = 5 * 60 * 1_000;
export const WEEKLY_FINDINGS_SCHEMA =
  "github-issue-roadmap-weekly-findings/v1" as const;

export interface ProducerArtifactObservation {
  readonly sourceLocator: string;
  readonly status:
    | "explicit_empty"
    | "valid_candidates"
    | "invalid_sidecar"
    | "missing_post_cutover"
    | "historical_without_sidecar"
    | "pending_cutover_without_sidecar";
  readonly envelope: OutcomeEnvelope | null;
}

export interface OverlapClusterEvidence {
  readonly sourceFingerprint: string;
  readonly issueNumbers: readonly number[];
  readonly evidenceIds: readonly string[];
  readonly detail: string;
}

export interface PremiseFinding {
  readonly issueNumber: number;
  readonly status: "stale" | "disproved";
  readonly evidenceIds: readonly string[];
  readonly detail: string;
}

export interface WeeklyReconciliationFindings {
  readonly schemaVersion: typeof WEEKLY_FINDINGS_SCHEMA;
  readonly generatedAt: string;
  readonly canonicalSnapshotContentSha256: string;
  readonly overlapClusters: readonly OverlapClusterEvidence[];
  readonly premiseFindings: readonly PremiseFinding[];
  readonly contentSha256: string;
}

export interface MovedIssueObservation {
  readonly issueNumber: number;
  readonly canonicalUpdatedAt: string;
  readonly intakeUpdatedAt: string;
}

export interface CaptureSkewObservation {
  /** Issues present in both censuses; only these are comparable. */
  readonly comparedIssueCount: number;
  /** Newest canonical `updatedAt` over the compared set, or null when nothing overlapped. */
  readonly canonicalCursor: string | null;
  /** Newest intake `updatedAt` over the compared set, or null when nothing overlapped. */
  readonly intakeCursor: string | null;
  /** Issues that changed while the two captures were in flight. */
  readonly movedIssues: readonly MovedIssueObservation[];
}

export interface IntakeReconciliationReport {
  readonly schemaVersion: typeof INTAKE_RECONCILIATION_SCHEMA;
  readonly generatedAt: string;
  readonly repository: CanonicalSnapshotV2["repository"];
  readonly canonicalSnapshotContentSha256: string;
  readonly intakeSnapshotContentSha256: string;
  /**
   * Evidence caveat, not a gate. Names issues whose canonical evidence is behind the
   * intake capture, so a reader can discount those rows without the report being withheld.
   */
  readonly captureSkew: CaptureSkewObservation;
  readonly authority: {
    readonly mode: "read_only";
    readonly mutationClientPresent: false;
    readonly mutationCredentialLoaded: false;
    readonly projectRepairAllowed: false;
  };
  readonly producerCoverage: {
    readonly missingEnvelopes: readonly string[];
    readonly invalidEnvelopes: readonly string[];
    readonly historicalWithoutEnvelope: readonly string[];
    readonly pendingCutoverWithoutEnvelope: readonly string[];
    readonly explicitEmpty: readonly string[];
  };
  readonly fingerprints: {
    readonly dispositioned: readonly {
      readonly sourceFingerprint: string;
      readonly sourceLocator: string;
      readonly stableOutcomeId: string;
      readonly status: "dispositioned";
    }[];
    readonly unconsumed: readonly {
      readonly sourceFingerprint: string;
      readonly sourceLocator: string;
      readonly stableOutcomeId: string;
    }[];
    readonly multiplePerIssue: readonly {
      readonly issueNumber: number;
      readonly sourceFingerprints: readonly string[];
    }[];
    readonly duplicateMarkers: readonly MarkerIncident[];
    readonly changedMarkers: readonly MarkerIncident[];
  };
  readonly overlapClusters: readonly OverlapClusterEvidence[];
  readonly stalePremises: readonly PremiseFinding[];
  readonly completionCandidates: readonly {
    readonly issueNumber: number;
    readonly mergedPullRequestNumbers: readonly number[];
    readonly action: "review_completion" | "propose_legacy_steward_retirement";
    readonly disposition: "proposal_only";
    readonly executable: false;
    readonly rationale: string;
  }[];
  readonly projectDrift: readonly {
    readonly issueNumber: number;
    readonly kind: "missing_project_1_membership";
    readonly disposition: "report_only";
    readonly repairAttempted: false;
  }[];
  readonly now: {
    readonly ordinaryCap: typeof ORDINARY_NOW_CAP;
    readonly issueNumbers: readonly number[];
    readonly freshIssueNumbers: readonly number[];
    readonly staleIssueNumbers: readonly number[];
    readonly exceedsOrdinaryCap: boolean;
  };
  readonly attention:
    | {
      readonly kind: "qualified_candidates";
      readonly issueNumbers: readonly number[];
      readonly text: string;
      readonly evidenceIds: readonly string[];
    }
    | {
      readonly kind: "deciding_action" | "tradeoff";
      readonly issueNumbers: readonly number[];
      readonly text: string;
      readonly evidenceIds: readonly string[];
    };
  readonly externalGates: readonly string[];
  readonly contentSha256: string;
}

function canonicalTimestamp(value: string, context: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${context} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function findingsObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function findingsExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${context} must contain exact keys [${[...keys].sort().join(", ")}].`);
  }
}

function findingsStrings(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const entries = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${context}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length ||
      entries.some((entry, index) => index > 0 && entries[index - 1].localeCompare(entry) >= 0)) {
    throw new Error(`${context} must be sorted and unique.`);
  }
  return entries;
}

function findingsIssueNumbers(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const entries = value.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
      throw new Error(`${context}[${index}] must be a positive issue number.`);
    }
    return entry as number;
  });
  if (new Set(entries).size !== entries.length ||
      entries.some((entry, index) => index > 0 && entries[index - 1] >= entry)) {
    throw new Error(`${context} must be sorted and unique.`);
  }
  return entries;
}

export function parseWeeklyReconciliationFindings(
  value: unknown,
  canonicalSnapshot: CanonicalSnapshotV2,
): WeeklyReconciliationFindings {
  const raw = findingsObject(value, "weekly findings");
  findingsExactKeys(raw, [
    "schemaVersion", "generatedAt", "canonicalSnapshotContentSha256",
    "overlapClusters", "premiseFindings", "contentSha256",
  ], "weekly findings");
  if (raw.schemaVersion !== WEEKLY_FINDINGS_SCHEMA) {
    throw new Error(`weekly findings.schemaVersion must be ${WEEKLY_FINDINGS_SCHEMA}.`);
  }
  const generatedAt = canonicalTimestamp(raw.generatedAt as string, "Weekly findings generatedAt");
  const snapshotHash = snapshotContentSha256(canonicalSnapshot);
  if (raw.canonicalSnapshotContentSha256 !== snapshotHash) {
    throw new Error("Weekly findings are not bound to the supplied canonical snapshot.");
  }
  if (!Array.isArray(raw.overlapClusters) || !Array.isArray(raw.premiseFindings)) {
    throw new Error("Weekly findings overlapClusters and premiseFindings must be arrays.");
  }
  const overlapClusters = raw.overlapClusters.map((entry, index) => {
    const context = `weekly findings.overlapClusters[${index}]`;
    const item = findingsObject(entry, context);
    findingsExactKeys(item, ["sourceFingerprint", "issueNumbers", "evidenceIds", "detail"], context);
    if (typeof item.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceFingerprint)) {
      throw new Error(`${context}.sourceFingerprint must be a lowercase SHA-256.`);
    }
    const issueNumbers = findingsIssueNumbers(item.issueNumbers, `${context}.issueNumbers`);
    if (issueNumbers.length < 2) throw new Error(`${context} must name at least two competing issues.`);
    const evidenceIds = findingsStrings(item.evidenceIds, `${context}.evidenceIds`);
    if (evidenceIds.length === 0) throw new Error(`${context}.evidenceIds must not be empty.`);
    if (typeof item.detail !== "string" || item.detail.trim() === "") throw new Error(`${context}.detail is required.`);
    return { sourceFingerprint: item.sourceFingerprint, issueNumbers, evidenceIds, detail: item.detail };
  });
  const premiseFindings = raw.premiseFindings.map((entry, index) => {
    const context = `weekly findings.premiseFindings[${index}]`;
    const item = findingsObject(entry, context);
    findingsExactKeys(item, ["issueNumber", "status", "evidenceIds", "detail"], context);
    if (!Number.isSafeInteger(item.issueNumber) || (item.issueNumber as number) <= 0) {
      throw new Error(`${context}.issueNumber must be positive.`);
    }
    if (item.status !== "stale" && item.status !== "disproved") {
      throw new Error(`${context}.status is unsupported.`);
    }
    const evidenceIds = findingsStrings(item.evidenceIds, `${context}.evidenceIds`);
    if (evidenceIds.length === 0) throw new Error(`${context}.evidenceIds must not be empty.`);
    if (typeof item.detail !== "string" || item.detail.trim() === "") throw new Error(`${context}.detail is required.`);
    return {
      issueNumber: item.issueNumber as number,
      status: item.status as PremiseFinding["status"],
      evidenceIds,
      detail: item.detail,
    };
  });
  const core = {
    generatedAt,
    canonicalSnapshotContentSha256: snapshotHash,
    overlapClusters,
    premiseFindings,
  };
  if (typeof raw.contentSha256 !== "string" || raw.contentSha256 !== canonicalJsonSha256(core)) {
    throw new Error("Weekly findings content hash mismatch.");
  }
  return {
    schemaVersion: WEEKLY_FINDINGS_SCHEMA,
    ...core,
    contentSha256: raw.contentSha256,
  };
}

/**
 * Measures how far the world moved between the canonical capture and the intake capture.
 *
 * Compared per issue over the intersection of the two censuses, never globally: the intake
 * census covers open *and* closed issues while the canonical census covers the open Now
 * set, so a whole-census cursor comparison would report skew that is only the difference
 * in scope. Only issues present in both are comparable.
 *
 * An issue whose intake `updatedAt` is newer than its canonical `updatedAt` changed while
 * the captures were in flight; the pair still describes one repository, but that issue's
 * canonical evidence is behind. Naming the specific issues keeps the report actionable
 * instead of collapsing the condition into a single boolean.
 */
export function observeCaptureSkew(
  canonicalSnapshot: CanonicalSnapshotV2,
  intakeSnapshot: IntakeSnapshotV1,
): CaptureSkewObservation {
  const canonicalUpdatedAt = new Map<number, string>();
  for (const issue of canonicalSnapshot.issues) {
    canonicalUpdatedAt.set(issue.v1.number, issue.v1.updatedAt);
  }
  const movedIssues: MovedIssueObservation[] = [];
  let comparedIssueCount = 0;
  let canonicalCursor: string | null = null;
  let intakeCursor: string | null = null;
  for (const issue of intakeSnapshot.issues) {
    const canonicalTimestampValue = canonicalUpdatedAt.get(issue.number);
    if (canonicalTimestampValue === undefined) continue;
    comparedIssueCount += 1;
    if (canonicalCursor === null || canonicalTimestampValue > canonicalCursor) {
      canonicalCursor = canonicalTimestampValue;
    }
    if (intakeCursor === null || issue.updatedAt > intakeCursor) intakeCursor = issue.updatedAt;
    if (Date.parse(issue.updatedAt) > Date.parse(canonicalTimestampValue)) {
      movedIssues.push({
        issueNumber: issue.number,
        canonicalUpdatedAt: canonicalTimestampValue,
        intakeUpdatedAt: issue.updatedAt,
      });
    }
  }
  return {
    comparedIssueCount,
    canonicalCursor,
    intakeCursor,
    movedIssues: movedIssues.sort((left, right) => left.issueNumber - right.issueNumber),
  };
}

function assertSameRepository(
  canonical: CanonicalSnapshotV2,
  intake: IntakeSnapshotV1,
): void {
  if (!sameRepository(canonical.repository, intake.repository)) {
    throw new Error("Weekly reconciliation inputs belong to different repositories.");
  }
}

function issueHasFreshVerification(
  issue: IssueSnapshotV2,
  snapshot: CanonicalSnapshotV2,
  generatedAt: string,
): boolean {
  return issue.persistedVerifications.some((record) =>
    record.trust.status === "trusted" &&
    record.verifiedAt !== null &&
    isVerificationFresh(record.verifiedAt, generatedAt) &&
    record.originMainSha === snapshot.git.originMainSha);
}

function attentionFrom(
  recommendation: RoadmapRecommendation | null,
  staleNowIssueNumbers: readonly number[],
): IntakeReconciliationReport["attention"] {
  if (recommendation !== null && recommendation.recommendations.length > 0) {
    return {
      kind: "qualified_candidates",
      issueNumbers: recommendation.recommendations.map(({ issueNumber }) => issueNumber),
      text: "The independent attention gate found evidence-qualified candidates; Horizon still requires exact approval.",
      evidenceIds: sortedUnique(recommendation.recommendations.flatMap(({ evidenceIds }) => evidenceIds)),
    };
  }
  const tie = recommendation?.unresolvedTies[0];
  if (tie !== undefined) {
    return {
      kind: "tradeoff",
      issueNumbers: [...tie.issueNumbers],
      text: tie.tradeoff,
      evidenceIds: [],
    };
  }
  const refresh = recommendation?.evidenceRefresh[0];
  if (refresh !== undefined) {
    return {
      kind: "deciding_action",
      issueNumbers: [refresh.issueNumber],
      text: refresh.text,
      evidenceIds: [...refresh.evidenceIds],
    };
  }
  if (staleNowIssueNumbers.length > 0) {
    return {
      kind: "deciding_action",
      issueNumbers: [...staleNowIssueNumbers],
      text: "Refresh current-main verification for stale Now work before choosing what deserves attention.",
      evidenceIds: [],
    };
  }
  return {
    kind: "deciding_action",
    issueNumbers: [],
    text: "No issue is evidence-qualified by the supplied attention gate; refresh evidence or resolve the decision that would change eligibility.",
    evidenceIds: [],
  };
}

export function buildIntakeReconciliation(input: {
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly repoRoot?: string;
  readonly generatedAt: string;
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly intakeSnapshot: IntakeSnapshotV1;
  readonly producerArtifacts: readonly ProducerArtifactObservation[];
  readonly weeklyFindings: WeeklyReconciliationFindings;
  readonly attentionRecommendation?: RoadmapRecommendation | null;
  readonly legacyStewardV2IssueNumber?: number | null;
}): IntakeReconciliationReport {
  const generatedAt = canonicalTimestamp(input.generatedAt, "Reconciliation generatedAt");
  assertSameRepository(input.canonicalSnapshot, input.intakeSnapshot);
  const generatedAtTime = Date.parse(generatedAt);
  for (const [label, timestamp] of [
    ["canonical snapshot", input.canonicalSnapshot.generatedAt],
    ["intake snapshot", input.intakeSnapshot.generatedAt],
  ] as const) {
    const capturedAt = Date.parse(timestamp);
    if (!Number.isFinite(capturedAt) || capturedAt > generatedAtTime) {
      throw new Error(`Weekly reconciliation requires a ${label} captured before the report.`);
    }
  }
  // The captures are deliberately NOT wall-clock gated.
  //
  // A 5-minute age bound on each capture was unsatisfiable: the intake census is an
  // input-bound successor of the canonical capture (it consumes `--snapshot` and binds
  // `canonicalSnapshotV2Sha256` to it, asserted below), and the two captures together
  // measure ~10 minutes against a 5-minute budget. The order cannot be reshuffled, so no
  // schedule could ever satisfy it.
  //
  // The bound was also the wrong instrument. It constrained each artifact's age relative
  // to this report, never the skew *between* the two captures -- so it admitted a pair
  // straddling a live edit while refusing a pair that was hours old and perfectly
  // consistent. It was neither necessary nor sufficient for the corruption it named.
  //
  // Skew is now measured directly, per issue, and reported rather than refused: a moved
  // issue is a caveat on this report's evidence, not grounds to withhold the report.
  // Integrity still rests on the content bindings, which are exact.
  const captureSkew = observeCaptureSkew(input.canonicalSnapshot, input.intakeSnapshot);
  if (input.intakeSnapshot.canonicalSnapshotV2Sha256 !== canonicalJsonSha256(input.canonicalSnapshot)) {
    throw new Error("Intake snapshot is not bound to the supplied canonical snapshot.");
  }
  const weeklyFindings = parseWeeklyReconciliationFindings(
    input.weeklyFindings,
    input.canonicalSnapshot,
  );
  const findingsAge = generatedAtTime - Date.parse(weeklyFindings.generatedAt);
  if (findingsAge < 0 || findingsAge > WEEKLY_CAPTURE_MAXIMUM_AGE_MS) {
    throw new Error("Weekly reconciliation requires findings generated within 5 minutes.");
  }
  if (input.canonicalSnapshot.recovery.mode !== "read_only" ||
      input.canonicalSnapshot.recovery.mutationClientPresent) {
    throw new Error("Weekly reconciliation requires a structurally read-only canonical snapshot.");
  }
  const recommendation = input.attentionRecommendation ?? null;
  if (recommendation !== null && (
    recommendation.snapshotContentSha256 !== snapshotContentSha256(input.canonicalSnapshot) ||
    recommendation.repository.databaseId !== input.canonicalSnapshot.repository.databaseId ||
    recommendation.repository.nodeId !== input.canonicalSnapshot.repository.nodeId
  )) {
    throw new Error("Attention recommendation is not bound to the reconciliation snapshot.");
  }

  const history = (input.dispositionHistory ?? dispositionHistory)(input.canonicalSnapshot.git.originMainSha, { repoRoot: input.repoRoot ?? process.cwd() });
  const selections = input.producerArtifacts.flatMap(artifact => artifact.envelope === null ? [] : [{
    artifact, selection: effectiveOutcomeCandidates(artifact.envelope, history),
  }]);
  const dispositioned = selections.flatMap(({ artifact, selection }) => selection.dispositioned.map(candidate => ({
    sourceFingerprint: candidate.sourceFingerprint, sourceLocator: artifact.sourceLocator,
    stableOutcomeId: candidate.stableOutcomeId, status: "dispositioned" as const,
  }))).sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en"));
  const dispositionedFingerprints = new Set(dispositioned.map(({ sourceFingerprint }) => sourceFingerprint));
  const fingerprints = selections.flatMap(({ artifact, selection }) =>
    selection.active.map((candidate) => ({
      sourceFingerprint: candidate.sourceFingerprint,
      sourceLocator: artifact.sourceLocator,
      stableOutcomeId: candidate.stableOutcomeId,
    })));
  const knownFingerprints = new Set([
    ...fingerprints.map(({ sourceFingerprint }) => sourceFingerprint),
    ...Object.keys(input.intakeSnapshot.markerIndex),
  ]);
  const knownIssueNumbers = new Set([
    ...input.canonicalSnapshot.issues.map((issue) => issue.identity.number),
    ...input.intakeSnapshot.issues.map((issue) => issue.number),
  ]);
  const canonicalIssueNumbers = new Set(
    input.canonicalSnapshot.issues.map((issue) => issue.identity.number),
  );
  const knownEvidenceIds = new Set([
    ...evidenceIdsForSnapshot(input.canonicalSnapshot),
    ...intakeSnapshotEvidenceIds(input.intakeSnapshot),
    ...selections.flatMap(({ selection }) => [...selection.active, ...selection.dispositioned].flatMap((candidate) => [
      ...candidate.evidence.map((evidence) => evidence.id),
      ...candidate.provenance.map((provenance) => provenance.id),
    ])),
  ]);
  const assertEvidenceIds = (
    evidenceIds: readonly string[],
    permittedIssueNumbers: ReadonlySet<number>,
    context: string,
  ) => {
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) {
        throw new Error(`${context} cites evidence outside the bound snapshot and candidates: ${evidenceId}.`);
      }
      const issueMatch = /^issue:(\d+):/.exec(evidenceId);
      if (issueMatch !== null && !permittedIssueNumbers.has(Number(issueMatch[1]))) {
        throw new Error(`${context} cites evidence belonging to another issue: ${evidenceId}.`);
      }
    }
  };
  for (const [index, cluster] of weeklyFindings.overlapClusters.entries()) {
    if (dispositionedFingerprints.has(cluster.sourceFingerprint)) continue;
    if (!knownFingerprints.has(cluster.sourceFingerprint)) {
      throw new Error(`weekly findings.overlapClusters[${index}] names an unknown source fingerprint.`);
    }
    if (cluster.issueNumbers.some((issueNumber) => !knownIssueNumbers.has(issueNumber))) {
      throw new Error(`weekly findings.overlapClusters[${index}] names an issue outside canonical/intake coverage.`);
    }
    assertEvidenceIds(
      cluster.evidenceIds,
      new Set(cluster.issueNumbers),
      `weekly findings.overlapClusters[${index}]`,
    );
  }
  for (const [index, finding] of weeklyFindings.premiseFindings.entries()) {
    if (!canonicalIssueNumbers.has(finding.issueNumber)) {
      throw new Error(`weekly findings.premiseFindings[${index}] names an issue outside canonical coverage.`);
    }
    assertEvidenceIds(
      finding.evidenceIds,
      new Set([finding.issueNumber]),
      `weekly findings.premiseFindings[${index}]`,
    );
  }
  const unconsumed = fingerprints.filter(({ sourceFingerprint }) =>
    (input.intakeSnapshot.markerIndex[sourceFingerprint] ?? []).length === 0)
    .sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en"));
  const fingerprintsByIssue = new Map<number, Set<string>>();
  for (const [sourceFingerprint, locations] of Object.entries(input.intakeSnapshot.markerIndex)) {
    for (const location of locations) {
      const issueFingerprints = fingerprintsByIssue.get(location.issueNumber) ?? new Set<string>();
      issueFingerprints.add(sourceFingerprint);
      fingerprintsByIssue.set(location.issueNumber, issueFingerprints);
    }
  }
  const multiplePerIssue = [...fingerprintsByIssue.entries()]
    .filter(([, issueFingerprints]) => issueFingerprints.size > 1)
    .map(([issueNumber, issueFingerprints]) => ({
      issueNumber,
      sourceFingerprints: sortedUnique([...issueFingerprints]),
    }))
    .sort((left, right) => left.issueNumber - right.issueNumber);

  const issueByNumber = new Map(input.canonicalSnapshot.issues.map((issue) => [issue.identity.number, issue]));
  const nowIssueNumbers = sortedUniqueNumbers(input.canonicalSnapshot.census.nowIssueNumbers);
  const staleNowIssueNumbers = nowIssueNumbers.filter((number) => {
    const issue = issueByNumber.get(number);
    return issue === undefined || !issueHasFreshVerification(issue, input.canonicalSnapshot, generatedAt);
  });
  const freshNowIssueNumbers = nowIssueNumbers.filter((number) => !staleNowIssueNumbers.includes(number));

  const derivedPremises: PremiseFinding[] = input.canonicalSnapshot.issues
    .filter((issue) => issue.v1.state === "OPEN" && !issueHasFreshVerification(issue, input.canonicalSnapshot, generatedAt))
    .map((issue) => ({
      issueNumber: issue.identity.number,
      status: "stale" as const,
      evidenceIds: [`issue:${issue.identity.number}:snapshot`],
      detail: "Current trusted verification is missing, stale, or not bound to the recorded origin/main SHA.",
    }));
  const premiseFindings = [...derivedPremises, ...weeklyFindings.premiseFindings]
    .sort((left, right) => left.issueNumber - right.issueNumber || left.status.localeCompare(right.status));

  const completionCandidates = input.canonicalSnapshot.issues.flatMap((issue) => {
    if (issue.v1.state !== "OPEN") return [];
    const merged = sortedUniqueNumbers(issue.pullRequests
      .filter((pullRequest) => pullRequest.mergedAt !== null)
      .map((pullRequest) => pullRequest.identity.number));
    if (merged.length === 0) return [];
    const legacy = issue.identity.number === input.legacyStewardV2IssueNumber;
    return [{
      issueNumber: issue.identity.number,
      mergedPullRequestNumbers: merged,
      action: legacy ? "propose_legacy_steward_retirement" as const : "review_completion" as const,
      disposition: "proposal_only" as const,
      executable: false as const,
      rationale: legacy
        ? "Merged implementation evidence supports only an exact retirement proposal; the older Steward v2 issue remains open until the operator approves retirement."
        : "Merged work is completion evidence to review; it never closes an issue by inference.",
    }];
  }).sort((left, right) => left.issueNumber - right.issueNumber);

  const projectDrift = input.canonicalSnapshot.issues
    .filter((issue) => issue.v1.state === "OPEN" &&
      issue.projectMemberships.every((membership) => membership.project.number !== 1))
    .map((issue) => ({
      issueNumber: issue.identity.number,
      kind: "missing_project_1_membership" as const,
      disposition: "report_only" as const,
      repairAttempted: false as const,
    }))
    .sort((left, right) => left.issueNumber - right.issueNumber);

  const statuses = (status: ProducerArtifactObservation["status"]) => sortedUnique(
    input.producerArtifacts.filter((artifact) => artifact.status === status)
      .map((artifact) => artifact.sourceLocator),
  );
  const draft = {
    schemaVersion: INTAKE_RECONCILIATION_SCHEMA,
    generatedAt,
    repository: input.canonicalSnapshot.repository,
    canonicalSnapshotContentSha256: snapshotContentSha256(input.canonicalSnapshot),
    intakeSnapshotContentSha256: input.intakeSnapshot.contentSha256,
    captureSkew,
    authority: {
      mode: "read_only" as const,
      mutationClientPresent: false as const,
      mutationCredentialLoaded: false as const,
      projectRepairAllowed: false as const,
    },
    producerCoverage: {
      missingEnvelopes: statuses("missing_post_cutover"),
      invalidEnvelopes: statuses("invalid_sidecar"),
      historicalWithoutEnvelope: statuses("historical_without_sidecar"),
      pendingCutoverWithoutEnvelope: statuses("pending_cutover_without_sidecar"),
      explicitEmpty: statuses("explicit_empty"),
    },
    fingerprints: {
      dispositioned,
      unconsumed,
      multiplePerIssue,
      duplicateMarkers: input.intakeSnapshot.markerIncidents
        .filter((incident) => incident.kind === "copied"),
      changedMarkers: input.intakeSnapshot.markerIncidents
        .filter((incident) => incident.kind !== "copied"),
    },
    overlapClusters: weeklyFindings.overlapClusters.filter(cluster => !dispositionedFingerprints.has(cluster.sourceFingerprint))
      .sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en")),
    stalePremises: premiseFindings,
    completionCandidates,
    projectDrift,
    now: {
      ordinaryCap: ORDINARY_NOW_CAP as typeof ORDINARY_NOW_CAP,
      issueNumbers: nowIssueNumbers,
      freshIssueNumbers: freshNowIssueNumbers,
      staleIssueNumbers: staleNowIssueNumbers,
      exceedsOrdinaryCap: nowIssueNumbers.length > ORDINARY_NOW_CAP,
    },
    attention: attentionFrom(recommendation, staleNowIssueNumbers),
    externalGates: [
      "producer_cutover_and_20_artifact_recall_soak",
      "fresh_sequestered_holdout_and_60_decision_shadow",
      "disposable_writer_proofs",
      "operator_approved_deployment_record",
      "live_read_only_canary",
      "separately_authorized_monday_automation_update",
    ],
  };
  return { ...draft, contentSha256: canonicalJsonSha256(draft) };
}

export function intakeReconciliationJson(report: IntakeReconciliationReport): string {
  return prettyCanonicalJson(report);
}
