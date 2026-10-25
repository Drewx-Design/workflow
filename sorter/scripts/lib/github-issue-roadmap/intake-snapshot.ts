import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import {
  parseSourceMarker,
  SOURCE_MARKER,
  SOURCE_MARKER_LINE_COUNT,
  type SourceMarkerV1,
} from "./source-marker";
import {
  CANONICAL_REST_API_VERSION,
  qualifyIssueIdentity,
  type IssueIdentityV2,
  type ProjectMembershipV2,
  type RepositoryIdentityV2,
} from "./snapshot-v2";
import {
  PRODUCER_KINDS,
  validateSafeSourceLocator,
  validateStableIdentifier,
} from "./outcome-candidate";

export const INTAKE_SNAPSHOT_SCHEMA = "github-issue-roadmap-intake-snapshot/v1";

const INTAKE_ISSUE_BODY_CHARACTER_LIMIT = 32_768;
const INTAKE_ISSUE_BODY_TRUNCATION_MARKER = "\n\n[body truncated at 32768 characters]";

type CoverageState = "complete" | "incomplete";

/**
 * The closed set of GitHub reads a census receipt can attest to. Declared as a value, not only as a
 * union, so `parseIntakeSnapshotV1` can validate a persisted receipt against it the same mechanical
 * way it validates `PRODUCER_KINDS`, and so consumers can select receipts by domain rather than by
 * guessing at endpoint substrings.
 */
export const INTAKE_RECEIPT_DOMAINS = [
  "issues", "bodies", "comments", "fields", "relationships", "project",
] as const;

export type IntakeReceiptDomain = typeof INTAKE_RECEIPT_DOMAINS[number];

/**
 * The domains a novelty verdict rests on. Both a *census* requirement at build time
 * (`assertCompletePass`) and a *consumption* requirement at read time
 * (`assertSnapshotFreshness` in `intake-shadow.ts`) are written against this one list, because two
 * lists that mean the same thing drift: a build that stopped requiring comment coverage and a
 * consumer that still required a fresh comment receipt would disagree silently about what a
 * complete snapshot is.
 */
export const NOVELTY_RECEIPT_DOMAINS = ["issues", "comments"] as const;

/**
 * The census coverage a novelty verdict rests on. `bodies` is attested by the same issue read that
 * attests `issues`, which is why it appears here but not in `NOVELTY_RECEIPT_DOMAINS`.
 */
export const NOVELTY_COVERAGE_DOMAINS = ["issues", "bodies", "comments"] as const;

/**
 * Domains whose data feeds *classification* rather than novelty.
 *
 * A snapshot may legitimately declare these incomplete — the preflight collector ships with
 * `relationships: "incomplete"` today. What it may not do is declare one complete while carrying no
 * receipt for it: coverage is a claim, a receipt is the evidence, and a consumer that checks only
 * the novelty domains would read unattested classification data as though a census had happened.
 */
export const CLASSIFICATION_COVERAGE_DOMAINS = ["fields", "relationships", "project"] as const;

export interface IntakeReadReceipt {
  readonly domain: IntakeReceiptDomain;
  readonly endpoint: string;
  readonly page: number | null;
  readonly responseSha256: string;
  readonly requestId: string;
  readonly fetchedAt: string;
  readonly apiVersion: typeof CANONICAL_REST_API_VERSION;
}

export interface IntakeCommentInput {
  readonly databaseId: number;
  readonly nodeId: string;
  readonly body: string;
  readonly author: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deleted: boolean;
}

interface RawRelatedIssue {
  readonly number: number;
  readonly databaseId: number;
  readonly nodeId: string;
  readonly repositoryFullName: string;
}

export interface IntakeIssueInput extends RawRelatedIssue {
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly stateReason: string | null;
  readonly body: string;
  readonly updatedAt: string;
  readonly nativeType: unknown;
  readonly fieldValues: readonly unknown[];
  readonly relationships: {
    readonly parent: RawRelatedIssue | null;
    readonly subIssues: readonly RawRelatedIssue[];
    readonly blockedBy: readonly RawRelatedIssue[];
    readonly blocking: readonly RawRelatedIssue[];
  };
  readonly projectMemberships: readonly ProjectMembershipV2[];
  readonly evidence: readonly unknown[];
  readonly comments: readonly IntakeCommentInput[];
}

export interface IntakeCensusPass {
  readonly completedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly expectedIssueCount: number;
  readonly excludedPullRequestCount: number;
  readonly incompleteResults: boolean;
  readonly coverage: {
    readonly issues: CoverageState;
    readonly bodies: CoverageState;
    readonly comments: CoverageState;
    readonly fields: CoverageState;
    readonly relationships: CoverageState;
  };
  readonly receipts: readonly IntakeReadReceipt[];
  readonly issues: readonly IntakeIssueInput[];
}

export interface ProjectObservation {
  readonly status: "complete" | "unavailable" | "redacted";
  readonly memberships: readonly ProjectMembershipV2[];
  readonly evidence: string;
}

export interface MarkerLocation {
  readonly issueNumber: number;
  readonly source: "body" | "comment";
  readonly commentDatabaseId: number | null;
  readonly marker: SourceMarkerV1;
}

export interface MarkerIncident {
  readonly kind: "copied" | "malformed" | "modified" | "deleted";
  readonly issueNumber: number;
  readonly source: "body" | "comment";
  readonly commentDatabaseId: number | null;
  readonly sourceFingerprint: string | null;
  readonly detail: string;
}

/** Outcome ownership ignores only the emission hash; every other durable marker field agrees. */
export function sourceMarkersMatchLoosely(left: SourceMarkerV1, right: SourceMarkerV1): boolean {
  return left.sourceFingerprint === right.sourceFingerprint &&
    left.producerKind === right.producerKind &&
    left.producerVersion === right.producerVersion &&
    left.stableArtifactId === right.stableArtifactId &&
    left.stableOutcomeId === right.stableOutcomeId &&
    left.sourceLocator === right.sourceLocator;
}

/** Exact-emission replay requires agreement on all seven durable marker fields. */
export function sourceMarkersMatchStrictly(left: SourceMarkerV1, right: SourceMarkerV1): boolean {
  return sourceMarkersMatchLoosely(left, right) &&
    left.emissionContentSha256 === right.emissionContentSha256;
}

export interface IntakeIssueSnapshot {
  readonly number: number;
  readonly identity: IssueIdentityV2;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly stateReason: string | null;
  readonly body: string;
  readonly bodySha256: string;
  readonly updatedAt: string;
  readonly nativeType: unknown;
  readonly fieldValues: readonly unknown[];
  readonly relationships: {
    readonly parent: IssueIdentityV2 | null;
    readonly subIssues: readonly IssueIdentityV2[];
    readonly blockedBy: readonly IssueIdentityV2[];
    readonly blocking: readonly IssueIdentityV2[];
  };
  readonly projectMemberships: readonly ProjectMembershipV2[];
  readonly evidence: readonly unknown[];
  readonly comments: readonly {
    readonly databaseId: number;
    readonly nodeId: string;
    readonly bodySha256: string;
    readonly author: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deleted: boolean;
  }[];
}

export interface IntakeSnapshotV1 {
  readonly schemaVersion: typeof INTAKE_SNAPSHOT_SCHEMA;
  readonly candidateSha256: string;
  readonly canonicalSnapshotV2Sha256: string;
  readonly generatedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly contentSha256: string;
  readonly censusContentSha256: string;
  readonly coverage: {
    readonly issues: "complete";
    readonly bodies: "complete";
    readonly comments: "complete";
    readonly fields: CoverageState;
    readonly relationships: CoverageState;
    readonly project: CoverageState;
    readonly novelty: "complete" | "blocked_marker_corruption";
  };
  readonly census: {
    readonly expectedIssueCount: number;
    readonly issueCount: number;
    readonly excludedPullRequestCount: number;
    /**
     * How drift during collection was ruled out. Was `verifiedStableByDoubleRead: true`,
     * which described a full second census pass that no longer runs; keeping that name
     * would have asserted evidence the artifact does not have.
     */
    readonly driftDetection: "bookend_issue_index";
    readonly completedAt: string;
    /** When the bookend index read finished; with `completedAt`, brackets the collection. */
    readonly bookendCompletedAt: string;
  };
  readonly issues: readonly IntakeIssueSnapshot[];
  readonly markerIndex: Readonly<Record<string, readonly MarkerLocation[]>>;
  readonly markerIncidents: readonly MarkerIncident[];
  readonly projectObservation: ProjectObservation;
  readonly receipts: readonly IntakeReadReceipt[];
}

function sha256(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${context} must be a lowercase 64-character SHA-256.`);
  }
  return value;
}

function timestamp(value: string, context: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${context} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

export function sameRepository(left: RepositoryIdentityV2, right: RepositoryIdentityV2): boolean {
  return left.databaseId === right.databaseId && left.nodeId === right.nodeId &&
    left.organization.toLowerCase() === right.organization.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase();
}

function qualifyRelationship(repository: RepositoryIdentityV2, value: RawRelatedIssue): IssueIdentityV2 {
  try {
    return qualifyIssueIdentity(repository, value);
  } catch (error) {
    throw new Error(`Intake relationship repository qualification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizePass(pass: IntakeCensusPass): IntakeIssueSnapshot[] {
  const seen = new Set<number>();
  return [...pass.issues].sort((left, right) => left.number - right.number).map((issue) => {
    if (seen.has(issue.number)) throw new Error(`Intake issue census contains duplicate issue #${issue.number}.`);
    seen.add(issue.number);
    const relation = (value: RawRelatedIssue | null) => value === null ? null : qualifyRelationship(pass.repository, value);
    const relations = (values: readonly RawRelatedIssue[]) => values
      .map((value) => qualifyRelationship(pass.repository, value))
      .sort((left, right) => left.number - right.number);
    const memberships = [...issue.projectMemberships].sort((left, right) =>
      left.project.number - right.project.number || left.itemNodeId.localeCompare(right.itemNodeId));
    for (const membership of memberships) {
      if (membership.project.organization.toLowerCase() !== pass.repository.organization.toLowerCase()) {
        throw new Error(`Project membership for issue #${issue.number} belongs to another organization.`);
      }
    }
    return {
      number: issue.number,
      identity: qualifyIssueIdentity(pass.repository, issue),
      title: issue.title,
      state: issue.state,
      stateReason: issue.stateReason,
      body: issue.body.length > INTAKE_ISSUE_BODY_CHARACTER_LIMIT
        ? `${issue.body.slice(0, INTAKE_ISSUE_BODY_CHARACTER_LIMIT)}${INTAKE_ISSUE_BODY_TRUNCATION_MARKER}`
        : issue.body,
      bodySha256: canonicalJsonSha256(issue.body),
      updatedAt: timestamp(issue.updatedAt, `Issue #${issue.number} updatedAt`),
      nativeType: issue.nativeType,
      fieldValues: issue.fieldValues,
      relationships: {
        parent: relation(issue.relationships.parent),
        subIssues: relations(issue.relationships.subIssues),
        blockedBy: relations(issue.relationships.blockedBy),
        blocking: relations(issue.relationships.blocking),
      },
      projectMemberships: memberships,
      evidence: issue.evidence,
      comments: [...issue.comments].sort((left, right) => left.databaseId - right.databaseId).map((comment) => ({
        databaseId: comment.databaseId,
        nodeId: comment.nodeId,
        bodySha256: canonicalJsonSha256(comment.body),
        author: comment.author,
        createdAt: timestamp(comment.createdAt, `Comment ${comment.databaseId} createdAt`),
        updatedAt: timestamp(comment.updatedAt, `Comment ${comment.databaseId} updatedAt`),
        deleted: comment.deleted,
      })),
    };
  });
}

function stablePassContent(pass: IntakeCensusPass): unknown {
  return {
    repository: pass.repository,
    expectedIssueCount: pass.expectedIssueCount,
    excludedPullRequestCount: pass.excludedPullRequestCount,
    incompleteResults: pass.incompleteResults,
    coverage: pass.coverage,
    receipts: pass.receipts.map(({ domain, endpoint, page, responseSha256, apiVersion }) =>
      ({ domain, endpoint, page, responseSha256, apiVersion })),
    issues: normalizePass(pass),
  };
}

/**
 * Completeness only. There is deliberately no wall-clock freshness assertion here.
 *
 * There used to be one, against a 60s budget, but it was inert: the caller stamped a single
 * timestamp before collection began and passed it as every pass's `completedAt`, so the check
 * compared a value to itself and could never fire. Wiring it to a real completion time would
 * not have rescued it -- a full pass measures ~245s against that 60s budget, so an honest
 * version of this check would have refused every run.
 *
 * Drift during collection is now detected directly by the bookend index comparison in
 * `detectIntakeCensusDrift`, which observes whether the census actually moved rather than
 * inferring it from elapsed time.
 */
function assertCompletePass(pass: IntakeCensusPass): void {
  if (pass.incompleteResults) throw new Error("GitHub returned incomplete_results; novelty cannot be proven.");
  for (const domain of NOVELTY_COVERAGE_DOMAINS) {
    if (pass.coverage[domain] !== "complete") {
      throw new Error(`Intake ${domain} coverage must be complete before novelty can be proven.`);
    }
  }
  if (pass.expectedIssueCount !== pass.issues.length) {
    throw new Error(`Intake issue count mismatch: expected ${pass.expectedIssueCount}, captured ${pass.issues.length}.`);
  }
  if (pass.receipts.length === 0 ||
      NOVELTY_RECEIPT_DOMAINS.some((domain) => !pass.receipts.some((entry) => entry.domain === domain))) {
    throw new Error(`Intake receipt coverage must include every novelty domain [${NOVELTY_RECEIPT_DOMAINS.join(", ")}].`);
  }
  timestamp(pass.completedAt, "Intake pass completedAt");
  for (const receipt of pass.receipts) {
    sha256(receipt.responseSha256, "Intake response hash");
    if (receipt.apiVersion !== CANONICAL_REST_API_VERSION) throw new Error("Intake census mixed REST API versions.");
    if (!receipt.requestId) throw new Error("Intake receipt requires a GitHub request ID.");
  }
  normalizePass(pass);
}

export function markerBlocks(text: string): { readonly raw: string; readonly modified: boolean }[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: { raw: string; modified: boolean }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === SOURCE_MARKER) {
      blocks.push({
        raw: lines.slice(index, index + SOURCE_MARKER_LINE_COUNT).join("\n"),
        modified: false,
      });
      index += SOURCE_MARKER_LINE_COUNT - 1;
    } else if (/^\s*<!--\s*github-issue-roadmap-source(?::v\d+)?\s*-->\s*$/i.test(lines[index])) {
      blocks.push({
        raw: lines.slice(index, index + SOURCE_MARKER_LINE_COUNT).join("\n"),
        modified: true,
      });
    }
  }
  return blocks;
}

export function incidentSourceFingerprint(raw: string): string | null {
  const line = raw.replace(/\r\n/g, "\n").split("\n")
    .find((entry) => entry.startsWith("source-fingerprint: "));
  const value = line?.slice("source-fingerprint: ".length);
  return value !== undefined && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function indexMarkers(pass: IntakeCensusPass): {
  readonly index: Record<string, MarkerLocation[]>;
  readonly incidents: MarkerIncident[];
} {
  const index: Record<string, MarkerLocation[]> = {};
  const incidents: MarkerIncident[] = [];
  const inspect = (
    issueNumber: number,
    source: "body" | "comment",
    commentDatabaseId: number | null,
    body: string,
    deleted: boolean,
  ) => {
    for (const block of markerBlocks(body)) {
      const sourceFingerprint = incidentSourceFingerprint(block.raw);
      if (deleted) {
        incidents.push({
          kind: "deleted", issueNumber, source, commentDatabaseId, sourceFingerprint,
          detail: "A marker-bearing comment is deleted.",
        });
        continue;
      }
      if (block.modified) {
        incidents.push({
          kind: "modified", issueNumber, source, commentDatabaseId, sourceFingerprint,
          detail: "The source marker sentinel was modified.",
        });
        continue;
      }
      try {
        const marker = parseSourceMarker(block.raw);
        (index[marker.sourceFingerprint] ??= []).push({ issueNumber, source, commentDatabaseId, marker });
      } catch (error) {
        incidents.push({
          kind: "malformed", issueNumber, source, commentDatabaseId, sourceFingerprint,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  for (const issue of pass.issues) {
    inspect(issue.number, "body", null, issue.body, false);
    for (const comment of issue.comments) inspect(issue.number, "comment", comment.databaseId, comment.body, comment.deleted);
  }
  for (const [fingerprint, locations] of Object.entries(index)) {
    locations.sort((left, right) => left.issueNumber - right.issueNumber ||
      (left.commentDatabaseId ?? -1) - (right.commentDatabaseId ?? -1));
    const bodyClaims = locations.filter((location) => location.source === "body");
    const outcomeGroups: MarkerLocation[][] = [];
    for (const claim of bodyClaims) {
      const group = outcomeGroups.find((entries) => sourceMarkersMatchLoosely(entries[0].marker, claim.marker));
      if (group === undefined) outcomeGroups.push([claim]);
      else group.push(claim);
    }
    for (const group of outcomeGroups) {
      const issueNumbers = [...new Set(group.map((location) => location.issueNumber))];
      if (issueNumbers.length <= 1) continue;
      for (const issueNumber of issueNumbers) {
        incidents.push({
          kind: "copied", issueNumber, source: "body", commentDatabaseId: null,
          sourceFingerprint: fingerprint,
          detail: `Outcome identity ${fingerprint} is claimed by issue bodies ${issueNumbers.map((number) => `#${number}`).join(", ")}.`,
        });
      }
    }
  }
  incidents.sort((left, right) => left.issueNumber - right.issueNumber || left.kind.localeCompare(right.kind));
  return { index, incidents };
}

export function buildIntakeSnapshot(input: {
  readonly candidateSha256: string;
  readonly canonicalSnapshotV2Sha256: string;
  readonly generatedAt: string;
  /** The single full census pass. */
  readonly pass: IntakeCensusPass;
  /** Index-only read taken after the pass; the caller compares them before building. */
  readonly bookend: { readonly completedAt: string; readonly excludedPullRequestCount: number };
  readonly projectObservation: ProjectObservation;
}): IntakeSnapshotV1 {
  const generatedAt = timestamp(input.generatedAt, "Intake snapshot generatedAt");
  const second = input.pass;
  assertCompletePass(second);
  if (input.bookend.excludedPullRequestCount !== second.excludedPullRequestCount) {
    throw new Error("Pull-request exclusion count changed during collection; refusing mixed-version intake evidence.");
  }
  // Still the digest of the full pass's normalized content: `assertFinalIntakeRevalidation`
  // compares a later full pass against it, so it must keep covering the whole census.
  const censusDigest = canonicalJsonSha256(stablePassContent(second));
  const markers = indexMarkers(second);
  const issues = normalizePass(second);
  const receipts = [...second.receipts].sort((left, right) =>
    left.endpoint.localeCompare(right.endpoint) || (left.page ?? 0) - (right.page ?? 0));
  const core = {
    candidateSha256: sha256(input.candidateSha256, "Candidate hash"),
    canonicalSnapshotV2Sha256: sha256(input.canonicalSnapshotV2Sha256, "Canonical snapshot v2 hash"),
    repository: second.repository,
    censusContentSha256: censusDigest,
    issues,
    markerIndex: markers.index,
    markerIncidents: markers.incidents,
    projectObservation: input.projectObservation,
    receipts,
  };
  return {
    schemaVersion: INTAKE_SNAPSHOT_SCHEMA,
    candidateSha256: core.candidateSha256,
    canonicalSnapshotV2Sha256: core.canonicalSnapshotV2Sha256,
    generatedAt,
    repository: second.repository,
    contentSha256: canonicalJsonSha256(core),
    censusContentSha256: censusDigest,
    coverage: {
      issues: "complete", bodies: "complete", comments: "complete",
      fields: second.coverage.fields,
      relationships: second.coverage.relationships,
      project: input.projectObservation.status === "complete" ? "complete" : "incomplete",
      // Marker integrity is candidate-specific. Collection completeness is already asserted above.
      novelty: "complete",
    },
    census: {
      expectedIssueCount: second.expectedIssueCount,
      issueCount: issues.length,
      excludedPullRequestCount: second.excludedPullRequestCount,
      driftDetection: "bookend_issue_index" as const,
      completedAt: timestamp(second.completedAt, "Intake pass completedAt"),
      bookendCompletedAt: timestamp(input.bookend.completedAt, "Intake bookend completedAt"),
    },
    issues,
    markerIndex: markers.index,
    markerIncidents: markers.incidents,
    projectObservation: input.projectObservation,
    receipts,
  };
}

export function assertFinalIntakeRevalidation(
  snapshot: IntakeSnapshotV1,
  finalPass: IntakeCensusPass,
): void {
  assertCompletePass(finalPass);
  if (!sameRepository(snapshot.repository, finalPass.repository) ||
      canonicalJsonSha256(stablePassContent(finalPass)) !== snapshot.censusContentSha256) {
    throw new Error("Final revalidation detected canonical mutation; issue creation is forbidden.");
  }
  const markerDigest = canonicalJsonSha256(indexMarkers(finalPass));
  const snapshotMarkerDigest = canonicalJsonSha256({ index: snapshot.markerIndex, incidents: snapshot.markerIncidents });
  if (markerDigest !== snapshotMarkerDigest) {
    throw new Error("Final revalidation detected marker-index mutation; issue creation is forbidden.");
  }
}

export function intakeSnapshotJson(snapshot: IntakeSnapshotV1): string {
  return prettyCanonicalJson(snapshot);
}

function snapshotObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function snapshotExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} must contain exact keys [${wanted.join(", ")}].`);
  }
}

/**
 * Validate one persisted read receipt's element shape.
 *
 * This lives in the parser, not in a consumer, because every consumer of a persisted snapshot
 * inherits exactly what the parser was willing to accept. A receipt is the only evidence that a
 * given GitHub read actually happened, so an unvalidated one lets a snapshot claim coverage it has
 * no attestation for.
 *
 * Clock-relative questions - how old the read is, whether it is dated into the future - are
 * deliberately absent: they need a clock the parser does not have and a bound the parser does not
 * own. `assertSnapshotFreshness` in `intake-shadow.ts` is where those belong. Here `fetchedAt` is
 * checked only for being a syntactically parseable timestamp.
 */
function validateReadReceipt(value: unknown, context: string): void {
  const receipt = snapshotObject(value, context);
  snapshotExactKeys(receipt, [
    "domain", "endpoint", "page", "responseSha256", "requestId", "fetchedAt", "apiVersion",
  ], context);
  if (!INTAKE_RECEIPT_DOMAINS.includes(receipt.domain as IntakeReceiptDomain)) {
    throw new Error(`${context}.domain must be one of [${INTAKE_RECEIPT_DOMAINS.join(", ")}].`);
  }
  if (typeof receipt.endpoint !== "string" || receipt.endpoint.trim() === "") {
    throw new Error(`${context}.endpoint must be a non-empty string.`);
  }
  if (receipt.page !== null && (!Number.isSafeInteger(receipt.page) || (receipt.page as number) < 0)) {
    throw new Error(`${context}.page must be null or a non-negative integer.`);
  }
  sha256(receipt.responseSha256, `${context}.responseSha256`);
  if (typeof receipt.requestId !== "string" || receipt.requestId.trim() === "") {
    throw new Error(`${context}.requestId must be a non-empty GitHub request ID.`);
  }
  if (receipt.apiVersion !== CANONICAL_REST_API_VERSION) {
    throw new Error(`${context}.apiVersion must be ${CANONICAL_REST_API_VERSION}.`);
  }
  if (typeof receipt.fetchedAt !== "string" || !Number.isFinite(Date.parse(receipt.fetchedAt))) {
    throw new Error(`${context}.fetchedAt must be an ISO timestamp.`);
  }
}

/** Parse and hash-bind a persisted U2 intake snapshot before weekly reuse. */
export function parseIntakeSnapshotV1(value: unknown): IntakeSnapshotV1 {
  const raw = snapshotObject(value, "intake snapshot");
  snapshotExactKeys(raw, [
    "schemaVersion", "candidateSha256", "canonicalSnapshotV2Sha256", "generatedAt",
    "repository", "contentSha256", "censusContentSha256", "coverage", "census",
    "issues", "markerIndex", "markerIncidents", "projectObservation", "receipts",
  ], "intake snapshot");
  if (raw.schemaVersion !== INTAKE_SNAPSHOT_SCHEMA) {
    throw new Error(`intake snapshot.schemaVersion must be ${INTAKE_SNAPSHOT_SCHEMA}.`);
  }
  const hashValue = (entry: unknown, context: string) => sha256(entry, context);
  const candidateSha256 = hashValue(raw.candidateSha256, "intake snapshot.candidateSha256");
  const canonicalSnapshotV2Sha256 = hashValue(
    raw.canonicalSnapshotV2Sha256,
    "intake snapshot.canonicalSnapshotV2Sha256",
  );
  const censusContentSha256 = hashValue(raw.censusContentSha256, "intake snapshot.censusContentSha256");
  const contentSha256 = hashValue(raw.contentSha256, "intake snapshot.contentSha256");
  timestamp(raw.generatedAt as string, "intake snapshot.generatedAt");
  const repository = snapshotObject(raw.repository, "intake snapshot.repository");
  snapshotExactKeys(repository, ["organization", "name", "databaseId", "nodeId"], "intake snapshot.repository");
  if (typeof repository.organization !== "string" || repository.organization.trim() === "" ||
      typeof repository.name !== "string" || repository.name.trim() === "" ||
      !Number.isSafeInteger(repository.databaseId) || (repository.databaseId as number) <= 0 ||
      typeof repository.nodeId !== "string" || repository.nodeId.trim() === "") {
    throw new Error("intake snapshot.repository requires qualified GitHub identity.");
  }
  if (!Array.isArray(raw.issues) || !Array.isArray(raw.markerIncidents) || !Array.isArray(raw.receipts)) {
    throw new Error("intake snapshot issues, marker incidents, and receipts must be arrays.");
  }
  // Ahead of the content-hash check, so a malformed receipt is refused by name rather than
  // surfacing as an undifferentiated hash mismatch a caller cannot act on.
  for (const [index, rawReceipt] of raw.receipts.entries()) {
    validateReadReceipt(rawReceipt, `intake snapshot.receipts[${index}]`);
  }
  const markerIndex = snapshotObject(raw.markerIndex, "intake snapshot.markerIndex");
  for (const [fingerprint, rawLocations] of Object.entries(markerIndex)) {
    hashValue(fingerprint, "intake snapshot marker fingerprint");
    if (!Array.isArray(rawLocations) || rawLocations.length === 0) {
      throw new Error(`intake snapshot.markerIndex.${fingerprint} must contain marker locations.`);
    }
    for (const [index, rawLocation] of rawLocations.entries()) {
      const location = snapshotObject(rawLocation, `intake snapshot.markerIndex.${fingerprint}[${index}]`);
      snapshotExactKeys(location, ["issueNumber", "source", "commentDatabaseId", "marker"], `intake snapshot.markerIndex.${fingerprint}[${index}]`);
      if (!Number.isSafeInteger(location.issueNumber) || (location.issueNumber as number) <= 0 ||
          (location.source !== "body" && location.source !== "comment")) {
        throw new Error("intake snapshot marker location is invalid.");
      }
      const marker = snapshotObject(location.marker, `intake snapshot.markerIndex.${fingerprint}[${index}].marker`);
      snapshotExactKeys(marker, [
        "sourceFingerprint", "emissionContentSha256", "producerKind", "producerVersion",
        "stableArtifactId", "stableOutcomeId", "sourceLocator",
      ], `intake snapshot.markerIndex.${fingerprint}[${index}].marker`);
      hashValue(marker.sourceFingerprint, "intake snapshot marker source fingerprint");
      hashValue(marker.emissionContentSha256, "intake snapshot marker emission hash");
      if (!PRODUCER_KINDS.includes(marker.producerKind as typeof PRODUCER_KINDS[number])) {
        throw new Error("intake snapshot marker producer kind is unsupported.");
      }
      validateStableIdentifier(marker.producerVersion, "intake snapshot marker producer version");
      validateStableIdentifier(marker.stableArtifactId, "intake snapshot marker stable artifact ID");
      validateStableIdentifier(marker.stableOutcomeId, "intake snapshot marker stable outcome ID");
      validateSafeSourceLocator(marker.sourceLocator, "intake snapshot marker source locator");
      if (marker.sourceFingerprint !== fingerprint) {
        throw new Error("intake snapshot marker index key disagrees with its marker fingerprint.");
      }
    }
  }
  for (const [index, rawIncident] of raw.markerIncidents.entries()) {
    const incident = snapshotObject(rawIncident, `intake snapshot.markerIncidents[${index}]`);
    snapshotExactKeys(incident, [
      "kind", "issueNumber", "source", "commentDatabaseId", "sourceFingerprint", "detail",
    ], `intake snapshot.markerIncidents[${index}]`);
    if (!["copied", "malformed", "modified", "deleted"].includes(incident.kind as string)) {
      throw new Error(`intake snapshot.markerIncidents[${index}].kind is unsupported.`);
    }
    if (incident.sourceFingerprint !== null) {
      hashValue(incident.sourceFingerprint, `intake snapshot.markerIncidents[${index}].sourceFingerprint`);
    }
  }
  const projectObservation = snapshotObject(raw.projectObservation, "intake snapshot.projectObservation");
  snapshotExactKeys(projectObservation, ["status", "memberships", "evidence"], "intake snapshot.projectObservation");
  if (!["complete", "unavailable", "redacted"].includes(projectObservation.status as string) ||
      !Array.isArray(projectObservation.memberships) ||
      typeof projectObservation.evidence !== "string" || projectObservation.evidence.trim() === "") {
    throw new Error("intake snapshot.projectObservation is invalid.");
  }
  const core = {
    candidateSha256,
    canonicalSnapshotV2Sha256,
    repository: raw.repository,
    censusContentSha256,
    issues: raw.issues,
    markerIndex: raw.markerIndex,
    markerIncidents: raw.markerIncidents,
    projectObservation: raw.projectObservation,
    receipts: raw.receipts,
  };
  if (canonicalJsonSha256(core) !== contentSha256) {
    throw new Error("intake snapshot content hash mismatch.");
  }
  return value as IntakeSnapshotV1;
}
