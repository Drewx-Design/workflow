import { createHash } from "node:crypto";
import { canonicalizeJson as canonicalize, canonicalJson, prettyCanonicalJson } from "./canonical-json";
import { issueFieldValueIdentity } from "./issue-field-value";

import type { NormalizedIssueV1 } from "../../github-issue-roadmap-preflight";

// Deliberately version-agnostic names: the value carries the version, so bumping it never leaves
// these identifiers asserting something their strings contradict. The surrounding type and function
// names (CanonicalSnapshotV2, parseCanonicalSnapshotV2, this file) still read V2 and now parse v3;
// that sweep is deliberately not bundled into a semantic change, and "V2" there is the format
// family, not the wire version.
export const CANONICAL_SNAPSHOT_SCHEMA = "github-issue-roadmap-canonical-snapshot/v3";
export const ISSUE_SNAPSHOT_SCHEMA = "github-issue-roadmap-issue-snapshot/v3";
export const CANONICAL_REST_API_VERSION = "2026-03-10";
export const VERIFICATION_MARKER = "<!-- github-issue-roadmap-verification:v1 -->";
export const VERIFICATION_FRESHNESS_DAYS = 14;

declare const databaseIdBrand: unique symbol;
declare const nodeIdBrand: unique symbol;
declare const shaBrand: unique symbol;

export type GitHubDatabaseId = number & { readonly [databaseIdBrand]: true };
export type GitHubNodeId = string & { readonly [nodeIdBrand]: true };
export type GitSha = string & { readonly [shaBrand]: true };

export interface RepositoryIdentityV2 {
  readonly organization: string;
  readonly name: string;
  readonly databaseId: GitHubDatabaseId;
  readonly nodeId: GitHubNodeId;
}

export interface IssueIdentityV2 {
  /** Live native blocker state; absent in archived snapshots. */
  readonly state?: "OPEN" | "CLOSED";
  readonly repository: RepositoryIdentityV2;
  readonly number: number;
  readonly databaseId: GitHubDatabaseId;
  readonly nodeId: GitHubNodeId;
}

export interface ProjectIdentityV2 {
  readonly organization: string;
  readonly number: number;
  readonly nodeId: GitHubNodeId;
}

export interface ProjectMembershipV2 {
  readonly project: ProjectIdentityV2;
  readonly itemNodeId: GitHubNodeId;
}

export interface TransportMetadataV2 {
  readonly endpoint: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly fetchedAt: string;
  readonly page: number | null;
  readonly apiVersionSelected: typeof CANONICAL_REST_API_VERSION | null;
  readonly deprecationAt: string | null;
  readonly sunsetAt: string | null;
}

export interface PersistedVerificationRecordV2 {
  readonly source: "body" | "comment";
  readonly comment: {
    readonly databaseId: GitHubDatabaseId;
    readonly nodeId: GitHubNodeId;
  } | null;
  readonly marker: typeof VERIFICATION_MARKER;
  readonly author: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly edited: boolean;
  readonly verifiedAt: string | null;
  readonly originMainSha: GitSha | null;
  readonly check: string | null;
  readonly trust: {
    readonly status: "trusted" | "untrusted";
    readonly reasons: readonly (
      | "copied_marker"
      | "body_edit_provenance_unavailable"
      | "edited_after_creation"
      | "untrusted_author"
      | "invalid_marker_fields"
    )[];
  };
}

export interface PullRequestEvidenceV2 {
  readonly identity: IssueIdentityV2;
  readonly relationship: "linked" | "closing";
  readonly state: "OPEN" | "CLOSED";
  readonly mergedAt: string | null;
  readonly headSha: GitSha | null;
  readonly url: string;
}

export interface IssueRelationshipsV2 {
  readonly parent: IssueIdentityV2 | null;
  readonly subIssues: readonly IssueIdentityV2[];
  readonly blockedBy: readonly IssueIdentityV2[];
  readonly blocking: readonly IssueIdentityV2[];
}

export interface IssueSnapshotV2 {
  readonly schemaVersion: typeof ISSUE_SNAPSHOT_SCHEMA;
  readonly identity: IssueIdentityV2;
  readonly v1: NormalizedIssueV1;
  readonly nativeType: {
    readonly organization: string;
    readonly databaseId: GitHubDatabaseId;
    readonly nodeId: GitHubNodeId | null;
    readonly name: string;
  } | null;
  readonly relationships: IssueRelationshipsV2;
  readonly projectMemberships: readonly ProjectMembershipV2[];
  readonly persistedVerifications: readonly PersistedVerificationRecordV2[];
  readonly pullRequests: readonly PullRequestEvidenceV2[];
  readonly freshness: {
    readonly latestTrustedVerificationAt: string | null;
    readonly trustedMarkerRecency: "current" | "stale" | "missing";
    /**
     * Describes only the record named by latestTrustedVerificationAt, not whether any trusted
     * record is bound. Making this existential would contradict the record-level eligibility
     * predicate when a newer unbound record sits above an older eligible bound record.
     */
    readonly latestTrustedVerificationBoundToOriginMainSha: boolean | null;
  };
  readonly transport: readonly TransportMetadataV2[];
}

export interface HydrationCoverageV2 {
  readonly consideredIssueNumbers: readonly number[];
  readonly affectedIssueNumbers: readonly number[];
  readonly requiredIssueNumbers: readonly number[];
  readonly hydratedIssueNumbers: readonly number[];
  readonly missingIssueNumbers: readonly number[];
  readonly complete: true;
}

export interface CanonicalSnapshotV2 {
  readonly schemaVersion: typeof CANONICAL_SNAPSHOT_SCHEMA;
  readonly generatedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly api: {
    readonly restVersion: string;
    readonly graphql: GraphqlCapabilityProofV2;
  };
  readonly sourceIdentities: {
    readonly strategy: SourceBlobIdentityV2;
    readonly rubric: SourceBlobIdentityV2;
  };
  readonly organizationIssueFields: {
    readonly totalCount: number;
    readonly definitions: readonly unknown[];
  };
  readonly reconciliation: {
    readonly counts: {
      readonly repositories: number;
      readonly issueFields: number;
      readonly projects: number;
      readonly openIssues: number;
    };
    readonly allMatch: true;
    readonly allVerified: true;
  };
  readonly capabilityManifest: {
    readonly status: "absent";
    readonly identity: null;
    readonly disposition: "recommendation_only";
    readonly canEnableWrites: false;
  };
  readonly git: {
    readonly originMainSha: GitSha;
    readonly fetchedAt: string;
    readonly freshness: "current" | "stale";
  };
  readonly census: {
    readonly totalCount: number;
    readonly issueNumbers: readonly number[];
    readonly nowIssueNumbers: readonly number[];
    readonly excludedPullRequestCount: number;
    readonly verifiedStableByDoubleRead: true;
    readonly countReconciled: true;
  };
  readonly coverage: HydrationCoverageV2;
  readonly issues: readonly IssueSnapshotV2[];
  readonly capability: {
    readonly comments: "available";
    readonly relationships: "available";
    readonly linkedPullRequests: "available";
    readonly projectMembership: "available";
    readonly requestMetadata: "available" | "partial";
  };
  readonly recovery: {
    readonly mode: "read_only";
    readonly state: "complete";
    readonly mutationClientPresent: false;
    readonly blockers: readonly [];
  };
  readonly transport: readonly TransportMetadataV2[];
}

export interface SourceBlobIdentityV2 {
  readonly path: string;
  readonly blobSha: GitSha;
  readonly commitSha: GitSha;
}

export interface GraphqlCapabilityProofV2 {
  readonly checkedAt: string;
  readonly requestIds: readonly string[];
  readonly issueFields: readonly string[];
  readonly projectV2Fields: readonly string[];
  readonly projectV2ItemFields: readonly string[];
  readonly allRequiredCapabilitiesPresent: true;
}

export interface VerificationCommentInput {
  readonly id?: unknown;
  readonly node_id?: unknown;
  readonly body?: unknown;
  readonly user?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
}

interface VerificationParseInput {
  readonly trustedAuthors: readonly string[];
  readonly body: string | null;
  readonly issueAuthor: string | null;
  readonly issueCreatedAt: string;
  readonly issueUpdatedAt: string;
  readonly comments: readonly VerificationCommentInput[];
}

interface CanonicalSnapshotV2Input {
  readonly generatedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly restVersion: string;
  readonly graphqlCapabilityProof: GraphqlCapabilityProofV2;
  readonly sourceIdentities: {
    readonly strategy: SourceBlobIdentityV2;
    readonly rubric: SourceBlobIdentityV2;
  };
  readonly organizationIssueFields: CanonicalSnapshotV2["organizationIssueFields"];
  readonly reconciliation: CanonicalSnapshotV2["reconciliation"];
  readonly originMainSha: string;
  readonly originMainFetchedAt: string;
  readonly remoteFetchMaximumAgeMs: number;
  readonly census: CanonicalSnapshotV2["census"];
  readonly consideredIssueNumbers: readonly number[];
  readonly affectedIssueNumbers?: readonly number[];
  readonly issues: readonly IssueSnapshotV2[];
  readonly transport: readonly TransportMetadataV2[];
}

type JsonObject = Record<string, unknown>;

/** Locale-independent ordering for canonical snapshot string arrays. */
export function compareCanonicalStrings(left: string, right: string): number {
  const leftFolded = left.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const rightFolded = right.replace(/[A-Z]/g, (character) => character.toLowerCase());
  if (leftFolded !== rightFolded) return leftFolded < rightFolded ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

/** Frozen v1 ordering for issue fields and field values captured by the preflight collector. */
export function compareJsonIdentity(left: unknown, right: unknown): number {
  const leftObject = object(left);
  const rightObject = object(right);
  const leftField = object(leftObject.field ?? leftObject.issue_field);
  const rightField = object(rightObject.field ?? rightObject.issue_field);
  const leftKey = `${String(leftField.id ?? leftObject.issue_field_id ?? leftObject.field_id ?? leftObject.id ?? "")}\0${String(leftField.name ?? leftObject.issue_field_name ?? leftObject.field_name ?? leftObject.name ?? "")}`;
  const rightKey = `${String(rightField.id ?? rightObject.issue_field_id ?? rightObject.field_id ?? rightObject.id ?? "")}\0${String(rightField.name ?? rightObject.issue_field_name ?? rightObject.field_name ?? rightObject.name ?? "")}`;
  return leftKey.localeCompare(rightKey);
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function databaseId(value: unknown, context: string): GitHubDatabaseId {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive GitHub database ID.`);
  }
  return value as GitHubDatabaseId;
}

function nodeId(value: unknown, context: string): GitHubNodeId {
  return nonEmptyString(value, context) as GitHubNodeId;
}

export function gitSha(value: unknown, context = "Git SHA"): GitSha {
  const sha = nonEmptyString(value, context);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${context} must be a 40-character SHA.`);
  return sha.toLowerCase() as GitSha;
}

function positiveIssueNumber(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive issue number.`);
  }
  return value as number;
}

function uniqueSortedIssueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => positiveIssueNumber(value, "Issue number")))]
    .sort((left, right) => left - right);
}

export function qualifyRepositoryIdentity(input: {
  readonly organization: unknown;
  readonly name: unknown;
  readonly databaseId: unknown;
  readonly nodeId: unknown;
}): RepositoryIdentityV2 {
  return {
    organization: nonEmptyString(input.organization, "Repository organization"),
    name: nonEmptyString(input.name, "Repository name"),
    databaseId: databaseId(input.databaseId, "Repository database ID"),
    nodeId: nodeId(input.nodeId, "Repository node ID"),
  };
}

export function qualifyIssueIdentity(
  repository: RepositoryIdentityV2,
  input: {
    readonly number: unknown;
    readonly databaseId: unknown;
    readonly nodeId: unknown;
    readonly repositoryFullName: unknown;
  },
): IssueIdentityV2 {
  const expected = `${repository.organization}/${repository.name}`;
  const actual = nonEmptyString(input.repositoryFullName, "Issue repository");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`GitHub issue resource mismatch: expected ${expected}, received ${actual}.`);
  }
  return {
    repository,
    number: positiveIssueNumber(input.number, "Issue number"),
    databaseId: databaseId(input.databaseId, "Issue database ID"),
    nodeId: nodeId(input.nodeId, "Issue node ID"),
  };
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function authorLogin(value: unknown): string | null {
  const login = object(value).login;
  return typeof login === "string" && login.trim() !== "" ? login : null;
}

interface MarkerOccurrence {
  readonly copied: boolean;
  readonly text: string;
}

function markerOccurrences(body: string): MarkerOccurrence[] {
  const lines = body.split(/\r?\n/);
  const occurrences: MarkerOccurrence[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    const quoteMatch = /^\s*>\s?(.*)$/.exec(rawLine);
    const comparable = quoteMatch?.[1].trim() ?? trimmed;
    if (comparable !== VERIFICATION_MARKER) continue;
    const copied = inFence || quoteMatch !== null;
    const block = [VERIFICATION_MARKER];
    for (let following = index + 1; following < lines.length; following += 1) {
      const nextRaw = lines[following];
      if (/^```/.test(nextRaw.trim())) break;
      const nextQuote = /^\s*>\s?(.*)$/.exec(nextRaw);
      const next = copied && quoteMatch !== null ? nextQuote?.[1] ?? "" : nextRaw;
      if (next.trim() === "" || next.trim() === VERIFICATION_MARKER) break;
      block.push(next.trim());
    }
    occurrences.push({ copied, text: block.join("\n") });
  }
  return occurrences;
}

function markerValue(text: string, names: readonly string[]): string | null {
  for (const line of text.split("\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (names.includes(key)) return line.slice(separator + 1).trim() || null;
  }
  return null;
}

function parseVerificationSource(options: {
  readonly source: "body" | "comment";
  readonly body: string;
  readonly author: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly trustedAuthors: ReadonlySet<string>;
  readonly comment: PersistedVerificationRecordV2["comment"];
}): PersistedVerificationRecordV2[] {
  return markerOccurrences(options.body).map((occurrence) => {
    const rawSha = markerValue(occurrence.text, ["origin-main-sha", "origin/main"]);
    const rawVerifiedAt = markerValue(occurrence.text, ["verified-at", "verified_at"]);
    const check = markerValue(occurrence.text, ["check", "confirming-check"]);
    let originMainSha: GitSha | null = null;
    try {
      originMainSha = rawSha === null ? null : gitSha(rawSha, "Verification origin-main-sha");
    } catch {
      originMainSha = null;
    }
    const verifiedAt = parseDate(rawVerifiedAt);
    // The issue resource updated_at changes for labels, fields, assignees,
    // state, and other activity. It is not body-edit provenance.
    const edited = options.source === "comment" && options.createdAt !== options.updatedAt;
    const reasons: PersistedVerificationRecordV2["trust"]["reasons"][number][] = [];
    if (occurrence.copied) reasons.push("copied_marker");
    if (options.source === "body") reasons.push("body_edit_provenance_unavailable");
    if (edited) reasons.push("edited_after_creation");
    if (options.author === null || !options.trustedAuthors.has(options.author.toLowerCase())) {
      reasons.push("untrusted_author");
    }
    if (originMainSha === null || verifiedAt === null || check === null) {
      reasons.push("invalid_marker_fields");
    }
    return {
      source: options.source,
      comment: options.comment,
      marker: VERIFICATION_MARKER,
      author: options.author,
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
      edited,
      verifiedAt,
      originMainSha,
      check,
      trust: {
        status: reasons.length === 0 ? "trusted" : "untrusted",
        reasons,
      },
    };
  });
}

export function parsePersistedVerificationRecords(
  input: VerificationParseInput,
): PersistedVerificationRecordV2[] {
  const trustedAuthors = new Set(input.trustedAuthors.map((author) => author.toLowerCase()));
  const records: PersistedVerificationRecordV2[] = [];
  if (input.body !== null) {
    records.push(...parseVerificationSource({
      source: "body",
      body: input.body,
      author: input.issueAuthor,
      createdAt: input.issueCreatedAt,
      updatedAt: input.issueUpdatedAt,
      trustedAuthors,
      comment: null,
    }));
  }
  for (const rawComment of input.comments) {
    if (typeof rawComment.body !== "string") continue;
    const createdAt = parseDate(rawComment.created_at);
    const updatedAt = parseDate(rawComment.updated_at);
    if (createdAt === null || updatedAt === null) continue;
    const id = databaseId(rawComment.id, "Verification comment database ID");
    const idNode = nodeId(rawComment.node_id, "Verification comment node ID");
    records.push(...parseVerificationSource({
      source: "comment",
      body: rawComment.body,
      author: authorLogin(rawComment.user),
      createdAt,
      updatedAt,
      trustedAuthors,
      comment: { databaseId: id, nodeId: idNode },
    }));
  }
  return records.sort((left, right) => {
    const byDate = (left.verifiedAt ?? left.createdAt).localeCompare(
      right.verifiedAt ?? right.createdAt,
    );
    if (byDate !== 0) return byDate;
    return (left.comment?.databaseId ?? 0) - (right.comment?.databaseId ?? 0);
  });
}

export function isVerificationFresh(
  verifiedAt: string,
  asOf: string,
  maximumAgeDays = VERIFICATION_FRESHNESS_DAYS,
): boolean {
  const verifiedTime = Date.parse(verifiedAt);
  const asOfTime = Date.parse(asOf);
  if (!Number.isFinite(verifiedTime) || !Number.isFinite(asOfTime)) return false;
  const age = asOfTime - verifiedTime;
  return age >= 0 && age <= maximumAgeDays * 24 * 60 * 60 * 1_000;
}

export function verificationFreshness(
  records: readonly PersistedVerificationRecordV2[],
  asOf: string,
  originMainSha: string,
): IssueSnapshotV2["freshness"] {
  // The tie-break is explicit rather than emergent. Sorting on verifiedAt alone would still be
  // deterministic today -- the parser requires records in canonical order and sort is stable -- but
  // "which record is latest" would then be a consequence of input order rather than a stated rule,
  // and this selection decides what latestTrustedVerificationBoundToOriginMainSha describes.
  // Descending databaseId picks the most recent comment among equal timestamps.
  const latestTrustedVerification = records
    .filter((record) => record.trust.status === "trusted" && record.verifiedAt !== null)
    .sort((left, right) =>
      (right.verifiedAt as string).localeCompare(left.verifiedAt as string) ||
      (right.comment?.databaseId ?? 0) - (left.comment?.databaseId ?? 0))[0] ?? null;
  const latest = latestTrustedVerification?.verifiedAt ?? null;
  return {
    latestTrustedVerificationAt: latest,
    latestTrustedVerificationBoundToOriginMainSha: latestTrustedVerification === null
      ? null
      : latestTrustedVerification.originMainSha === originMainSha,
    trustedMarkerRecency: latest === null
      ? "missing"
      : isVerificationFresh(latest, asOf) ? "current" : "stale",
  };
}

export function assertHydrationCoverage(
  requiredIssueNumbers: readonly number[],
  hydratedIssueNumbers: readonly number[],
): {
  readonly consideredIssueNumbers: readonly number[];
  readonly hydratedIssueNumbers: readonly number[];
  readonly missingIssueNumbers: readonly number[];
  readonly complete: true;
} {
  const required = uniqueSortedIssueNumbers(requiredIssueNumbers);
  const hydrated = uniqueSortedIssueNumbers(hydratedIssueNumbers);
  const hydratedSet = new Set(hydrated);
  const requiredSet = new Set(required);
  const missing = required.filter((number) => !hydratedSet.has(number));
  const unexpected = hydrated.filter((number) => !requiredSet.has(number));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Canonical snapshot hydration coverage refused: missing [${missing.join(", ")}]; unexpected [${unexpected.join(", ")}].`,
    );
  }
  return {
    consideredIssueNumbers: required,
    hydratedIssueNumbers: hydrated,
    missingIssueNumbers: [],
    complete: true,
  };
}

export function projectIssueSnapshotV2ToV1(issue: IssueSnapshotV2): NormalizedIssueV1 {
  return issue.v1;
}

function compareIssueIdentity(left: IssueIdentityV2, right: IssueIdentityV2): number {
  const leftRepo = `${left.repository.organization}/${left.repository.name}`;
  const rightRepo = `${right.repository.organization}/${right.repository.name}`;
  return leftRepo.localeCompare(rightRepo) || left.number - right.number;
}

function sourceBlobIdentity(
  value: SourceBlobIdentityV2,
  expectedPath: string,
  originMainSha: GitSha,
): SourceBlobIdentityV2 {
  if (value.path !== expectedPath) {
    throw new Error(`Canonical source identity expected ${expectedPath}, received ${value.path}.`);
  }
  const commitSha = gitSha(value.commitSha, `${expectedPath} source commit SHA`);
  if (commitSha !== originMainSha) {
    throw new Error(`${expectedPath} source identity is stale relative to recorded origin/main.`);
  }
  return {
    path: expectedPath,
    blobSha: gitSha(value.blobSha, `${expectedPath} blob SHA`),
    commitSha,
  };
}

function graphqlCapabilityProof(value: GraphqlCapabilityProofV2): GraphqlCapabilityProofV2 {
  if (!Number.isFinite(Date.parse(value.checkedAt))) {
    throw new Error("GraphQL capability proof checkedAt must be a valid timestamp.");
  }
  const requestIds = [...new Set(value.requestIds.map((requestId) =>
    nonEmptyString(requestId, "GraphQL capability proof request ID")))].sort(compareCanonicalStrings);
  if (requestIds.length === 0) throw new Error("GraphQL capability proof requires request IDs.");
  const normalizeFields = (fields: readonly string[]) =>
    [...new Set(fields)].sort(compareCanonicalStrings);
  const issueFields = normalizeFields(value.issueFields);
  const projectV2Fields = normalizeFields(value.projectV2Fields);
  const projectV2ItemFields = normalizeFields(value.projectV2ItemFields);
  const missing = [
    ...["blockedBy", "blocking", "parent", "subIssues"]
      .filter((field) => !issueFields.includes(field)).map((field) => `Issue.${field}`),
    ...["items"].filter((field) => !projectV2Fields.includes(field)).map((field) => `ProjectV2.${field}`),
    ...["content", "id"].filter((field) => !projectV2ItemFields.includes(field))
      .map((field) => `ProjectV2Item.${field}`),
  ];
  if (!value.allRequiredCapabilitiesPresent || missing.length > 0) {
    throw new Error(`GraphQL capability proof is incomplete: ${missing.join(", ") || "required flag false"}.`);
  }
  return {
    checkedAt: new Date(value.checkedAt).toISOString(),
    requestIds,
    issueFields,
    projectV2Fields,
    projectV2ItemFields,
    allRequiredCapabilitiesPresent: true,
  };
}

export function normalizeIssueSnapshotV2(issue: IssueSnapshotV2): IssueSnapshotV2 {
  const relationships = {
    parent: issue.relationships.parent,
    subIssues: [...issue.relationships.subIssues].sort(compareIssueIdentity),
    blockedBy: [...issue.relationships.blockedBy].sort(compareIssueIdentity),
    blocking: [...issue.relationships.blocking].sort(compareIssueIdentity),
  };
  return {
    ...issue,
    relationships,
    projectMemberships: [...issue.projectMemberships].sort((left, right) =>
      left.project.organization.localeCompare(right.project.organization) ||
      left.project.number - right.project.number ||
      left.itemNodeId.localeCompare(right.itemNodeId)),
    persistedVerifications: [...issue.persistedVerifications].sort((left, right) =>
      (left.verifiedAt ?? left.createdAt).localeCompare(right.verifiedAt ?? right.createdAt) ||
      (left.comment?.databaseId ?? 0) - (right.comment?.databaseId ?? 0)),
    pullRequests: [...issue.pullRequests].sort((left, right) =>
      compareIssueIdentity(left.identity, right.identity) ||
      left.relationship.localeCompare(right.relationship)),
    transport: [...issue.transport].sort((left, right) =>
      left.endpoint.localeCompare(right.endpoint) ||
      (left.page ?? 0) - (right.page ?? 0) ||
      (left.requestId ?? "").localeCompare(right.requestId ?? "")),
  };
}

export function buildCanonicalSnapshotV2(input: CanonicalSnapshotV2Input): CanonicalSnapshotV2 {
  const considered = uniqueSortedIssueNumbers(input.consideredIssueNumbers);
  const affected = uniqueSortedIssueNumbers(input.affectedIssueNumbers ?? []);
  const required = uniqueSortedIssueNumbers([...considered, ...affected]);
  const issues = input.issues.map(normalizeIssueSnapshotV2)
    .sort((left, right) => left.identity.number - right.identity.number);
  const baseCoverage = assertHydrationCoverage(required, issues.map((issue) => issue.identity.number));
  const censusSet = new Set(input.census.issueNumbers);
  const nowIssueNumbers = uniqueSortedIssueNumbers(input.census.nowIssueNumbers);
  const invalidNow = nowIssueNumbers.filter((number) => !censusSet.has(number));
  if (invalidNow.length > 0) {
    throw new Error(`Canonical snapshot Now census includes issues outside the stable census: [${invalidNow.join(", ")}].`);
  }
  const outsideCensus = required.filter((number) => !censusSet.has(number));
  if (outsideCensus.length > 0) {
    throw new Error(`Canonical snapshot coverage includes issues outside the stable census: [${outsideCensus.join(", ")}].`);
  }
  const generatedAtTime = Date.parse(input.generatedAt);
  const fetchedAtTime = Date.parse(input.originMainFetchedAt);
  if (!Number.isFinite(generatedAtTime) || !Number.isFinite(fetchedAtTime)) {
    throw new Error("Canonical snapshot timestamps must be valid ISO dates.");
  }
  const requestMetadata = input.transport.every((request) =>
    request.status !== null && request.requestId !== null)
    ? "available"
    : "partial";
  const originMainSha = gitSha(input.originMainSha, "Remote origin/main SHA");
  return {
    schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
    generatedAt: new Date(generatedAtTime).toISOString(),
    repository: input.repository,
    api: {
      restVersion: nonEmptyString(input.restVersion, "REST API version"),
      graphql: graphqlCapabilityProof(input.graphqlCapabilityProof),
    },
    sourceIdentities: {
      strategy: sourceBlobIdentity(input.sourceIdentities.strategy, "STRATEGY.md", originMainSha),
      rubric: sourceBlobIdentity(
        input.sourceIdentities.rubric,
        "docs/runbooks/github-issue-roadmap.md",
        originMainSha,
      ),
    },
    organizationIssueFields: {
      totalCount: input.organizationIssueFields.totalCount,
      definitions: [...input.organizationIssueFields.definitions]
        .map(canonicalize)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    },
    reconciliation: input.reconciliation,
    capabilityManifest: {
      status: "absent",
      identity: null,
      disposition: "recommendation_only",
      canEnableWrites: false,
    },
    git: {
      originMainSha,
      fetchedAt: new Date(fetchedAtTime).toISOString(),
      // A long census can finish after generatedAt; a later server response is
      // fresh, while an older cached/refreshed-at value must stay within age.
      freshness: generatedAtTime - fetchedAtTime <= input.remoteFetchMaximumAgeMs
        ? "current"
        : "stale",
    },
    census: {
      ...input.census,
      issueNumbers: uniqueSortedIssueNumbers(input.census.issueNumbers),
      nowIssueNumbers,
    },
    coverage: {
      consideredIssueNumbers: considered,
      affectedIssueNumbers: affected,
      requiredIssueNumbers: required,
      hydratedIssueNumbers: baseCoverage.hydratedIssueNumbers,
      missingIssueNumbers: [],
      complete: true,
    },
    issues,
    capability: {
      comments: "available",
      relationships: "available",
      linkedPullRequests: "available",
      projectMembership: "available",
      requestMetadata,
    },
    recovery: {
      mode: "read_only",
      state: "complete",
      mutationClientPresent: false,
      blockers: [],
    },
    transport: [...input.transport].sort((left, right) =>
      left.endpoint.localeCompare(right.endpoint) ||
      (left.page ?? 0) - (right.page ?? 0) ||
      (left.requestId ?? "").localeCompare(right.requestId ?? "")),
  };
}

export function canonicalSnapshotV2Json(snapshot: CanonicalSnapshotV2): string {
  return prettyCanonicalJson(snapshot);
}

export function snapshotContentSha256(snapshot: CanonicalSnapshotV2): string {
  return createHash("sha256").update(canonicalSnapshotV2Json(snapshot), "utf8").digest("hex");
}

export function parseCanonicalSnapshotV2(raw: unknown): CanonicalSnapshotV2 {
  const exact = (value: unknown, keys: readonly string[], context: string): JsonObject => {
    const record = object(value);
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
      throw new Error(`${context} must contain exact keys [${[...keys].sort().join(", ")}].`);
    }
    return record;
  };
  const array = (value: unknown, context: string): unknown[] => {
    if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
    return value;
  };
  const numbers = (value: unknown, context: string): number[] => {
    const input = array(value, context);
    const normalized = uniqueSortedIssueNumbers(input as number[]);
    if (JSON.stringify(input) !== JSON.stringify(normalized)) {
      throw new Error(`${context} must contain unique, sorted positive issue numbers.`);
    }
    return normalized;
  };
  const timestamp = (value: unknown, context: string): string => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new Error(`${context} must be a valid timestamp.`);
    }
    return new Date(value).toISOString();
  };
  const nullableTimestamp = (value: unknown, context: string): string | null =>
    value === null ? null : timestamp(value, context);
  const nonNegativeInteger = (value: unknown, context: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`${context} must be a non-negative integer.`);
    }
    return value as number;
  };
  const nullableNonEmptyString = (value: unknown, context: string): string | null =>
    value === null ? null : nonEmptyString(value, context);
  const sortedUniqueStrings = (value: unknown, context: string): string[] => {
    const strings = array(value, context).map((entry, index) =>
      nonEmptyString(entry, `${context}[${index}]`));
    const normalized = [...new Set(strings)].sort(compareCanonicalStrings);
    if (JSON.stringify(strings) !== JSON.stringify(normalized)) {
      throw new Error(`${context} must contain unique, sorted non-empty strings.`);
    }
    return strings;
  };
  const sortedCanonicalValues = (
    value: unknown,
    context: string,
    compare: (left: unknown, right: unknown) => number = (left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
  ): unknown[] => {
    const values = array(value, context);
    const normalized = values.map(canonicalize).sort(compare);
    const keys = normalized.map((entry) => JSON.stringify(entry));
    if (new Set(keys).size !== keys.length || JSON.stringify(values) !== JSON.stringify(normalized)) {
      throw new Error(`${context} must contain unique, canonically sorted values.`);
    }
    return values;
  };
  const transport = (value: unknown, context: string): TransportMetadataV2[] => {
    const parsed = array(value, context).map((entry, index) => {
      const itemContext = `${context}[${index}]`;
      const record = exact(entry, [
        "endpoint", "status", "requestId", "fetchedAt", "page", "apiVersionSelected",
        "deprecationAt", "sunsetAt",
      ], itemContext);
      const endpoint = nonEmptyString(record.endpoint, `${itemContext}.endpoint`);
      const status = record.status;
      if (!Number.isSafeInteger(status) || (status as number) < 200 || (status as number) >= 300) {
        throw new Error(`${itemContext}.status must be a complete 2xx status.`);
      }
      const requestId = nonEmptyString(record.requestId, `${itemContext}.requestId`);
      const page = record.page;
      if (page !== null && (!Number.isSafeInteger(page) || (page as number) <= 0)) {
        throw new Error(`${itemContext}.page must be null or a positive integer.`);
      }
      const graphql = endpoint.startsWith("graphql:");
      if (graphql ? record.apiVersionSelected !== null : record.apiVersionSelected !== CANONICAL_REST_API_VERSION) {
        throw new Error(`${itemContext}.apiVersionSelected does not match the supported REST contract.`);
      }
      if (record.deprecationAt !== null || record.sunsetAt !== null) {
        throw new Error(`${itemContext} contains API lifecycle drift and is not recommendation-eligible.`);
      }
      return {
        endpoint,
        status: status as number,
        requestId,
        fetchedAt: timestamp(record.fetchedAt, `${itemContext}.fetchedAt`),
        page: page as number | null,
        apiVersionSelected: record.apiVersionSelected as TransportMetadataV2["apiVersionSelected"],
        deprecationAt: null,
        sunsetAt: null,
      };
    });
    const normalized = [...parsed].sort((left, right) =>
      left.endpoint.localeCompare(right.endpoint) ||
      (left.page ?? 0) - (right.page ?? 0) ||
      (left.requestId ?? "").localeCompare(right.requestId ?? ""));
    if (new Set(parsed.map((entry) => JSON.stringify(entry))).size !== parsed.length ||
        JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      throw new Error(`${context} must be unique and canonically sorted.`);
    }
    return parsed;
  };
  const repositoryIdentity = (value: unknown, context: string): RepositoryIdentityV2 => {
    const record = exact(value, ["organization", "name", "databaseId", "nodeId"], context);
    return qualifyRepositoryIdentity({
      organization: record.organization,
      name: record.name,
      databaseId: record.databaseId,
      nodeId: record.nodeId,
    });
  };
  const identity = (
    value: unknown,
    context: string,
    expectedRepository?: RepositoryIdentityV2,
  ): IssueIdentityV2 => {
    const hasState = Object.prototype.hasOwnProperty.call(value, "state");
    const record = exact(value, ["repository", "number", "databaseId", "nodeId", ...(hasState ? ["state"] : [])], context);
    if (hasState && record.state !== "OPEN" && record.state !== "CLOSED") throw new Error(`${context} has invalid blocker state.`);
    const repository = repositoryIdentity(record.repository, `${context}.repository`);
    if (expectedRepository && JSON.stringify(repository) !== JSON.stringify(expectedRepository)) {
      throw new Error(`${context} belongs to another repository.`);
    }
    const qualified = qualifyIssueIdentity(repository, {
      number: record.number,
      databaseId: record.databaseId,
      nodeId: record.nodeId,
      repositoryFullName: `${repository.organization}/${repository.name}`,
    });
    return { ...qualified, ...(hasState ? { state: record.state as "OPEN" | "CLOSED" } : {}) };
  };
  const value = exact(raw, [
    "schemaVersion", "generatedAt", "repository", "api", "sourceIdentities",
    "organizationIssueFields", "reconciliation", "capabilityManifest", "git", "census",
    "coverage", "issues", "capability", "recovery", "transport",
  ], "canonical snapshot");
  if (value.schemaVersion !== CANONICAL_SNAPSHOT_SCHEMA) {
    throw new Error(`Canonical snapshot schema must be ${CANONICAL_SNAPSHOT_SCHEMA}.`);
  }
  const repository = repositoryIdentity(value.repository, "canonical snapshot.repository");
  const api = exact(value.api, ["restVersion", "graphql"], "canonical snapshot.api");
  const graphql = exact(api.graphql, [
    "checkedAt", "requestIds", "issueFields", "projectV2Fields", "projectV2ItemFields",
    "allRequiredCapabilitiesPresent",
  ], "canonical snapshot.api.graphql");
  if (api.restVersion !== "2026-03-10" || graphql.allRequiredCapabilitiesPresent !== true) {
    throw new Error("Canonical snapshot has an unsupported REST version or incomplete GraphQL proof.");
  }
  timestamp(value.generatedAt, "canonical snapshot.generatedAt");
  timestamp(graphql.checkedAt, "canonical snapshot.api.graphql.checkedAt");
  sortedUniqueStrings(graphql.requestIds, "canonical snapshot.api.graphql.requestIds");
  const issueFields = sortedUniqueStrings(graphql.issueFields, "canonical snapshot.api.graphql.issueFields");
  const projectV2Fields = sortedUniqueStrings(graphql.projectV2Fields, "canonical snapshot.api.graphql.projectV2Fields");
  const projectV2ItemFields = sortedUniqueStrings(
    graphql.projectV2ItemFields,
    "canonical snapshot.api.graphql.projectV2ItemFields",
  );
  const missingGraphql = [
    ...["blockedBy", "blocking", "parent", "subIssues"]
      .filter((field) => !issueFields.includes(field)).map((field) => `Issue.${field}`),
    ...["items"].filter((field) => !projectV2Fields.includes(field)).map((field) => `ProjectV2.${field}`),
    ...["content", "id"].filter((field) => !projectV2ItemFields.includes(field))
      .map((field) => `ProjectV2Item.${field}`),
  ];
  if (missingGraphql.length > 0) {
    throw new Error(`Canonical snapshot GraphQL proof is incomplete: ${missingGraphql.join(", ")}.`);
  }
  const sources = exact(value.sourceIdentities, ["strategy", "rubric"], "canonical snapshot.sourceIdentities");
  const strategy = exact(sources.strategy, ["path", "blobSha", "commitSha"], "canonical snapshot.sourceIdentities.strategy");
  const rubric = exact(sources.rubric, ["path", "blobSha", "commitSha"], "canonical snapshot.sourceIdentities.rubric");
  const organizationFields = exact(value.organizationIssueFields, ["totalCount", "definitions"], "canonical snapshot.organizationIssueFields");
  const organizationDefinitions = sortedCanonicalValues(
    organizationFields.definitions,
    "canonical snapshot.organizationIssueFields.definitions",
  );
  if (nonNegativeInteger(
    organizationFields.totalCount,
    "canonical snapshot.organizationIssueFields.totalCount",
  ) !== organizationDefinitions.length) {
    throw new Error("Canonical snapshot organization field definition count does not reconcile.");
  }
  const reconciliation = exact(value.reconciliation, ["counts", "allMatch", "allVerified"], "canonical snapshot.reconciliation");
  const reconciliationCounts = exact(reconciliation.counts, ["repositories", "issueFields", "projects", "openIssues"], "canonical snapshot.reconciliation.counts");
  for (const name of ["repositories", "issueFields", "projects", "openIssues"] as const) {
    nonNegativeInteger(reconciliationCounts[name], `canonical snapshot.reconciliation.counts.${name}`);
  }
  if (reconciliation.allMatch !== true || reconciliation.allVerified !== true) {
    throw new Error("Canonical snapshot reconciliation is incomplete.");
  }
  const manifest = exact(value.capabilityManifest, ["status", "identity", "disposition", "canEnableWrites"], "canonical snapshot.capabilityManifest");
  if (manifest.status !== "absent" || manifest.identity !== null ||
      manifest.disposition !== "recommendation_only" || manifest.canEnableWrites !== false) {
    throw new Error("Canonical snapshot capability manifest must remain absent and recommendation-only.");
  }
  const git = exact(value.git, ["originMainSha", "fetchedAt", "freshness"], "canonical snapshot.git");
  const originMainSha = gitSha(git.originMainSha, "canonical snapshot.git.originMainSha");
  timestamp(git.fetchedAt, "canonical snapshot.git.fetchedAt");
  if (git.freshness !== "current" && git.freshness !== "stale") {
    throw new Error("canonical snapshot.git.freshness must be current or stale.");
  }
  gitSha(strategy.blobSha, "canonical snapshot.sourceIdentities.strategy.blobSha");
  gitSha(rubric.blobSha, "canonical snapshot.sourceIdentities.rubric.blobSha");
  if (strategy.path !== "STRATEGY.md" || rubric.path !== "docs/runbooks/github-issue-roadmap.md" ||
      strategy.commitSha !== originMainSha || rubric.commitSha !== originMainSha) {
    throw new Error("Canonical snapshot source identities are not bound to origin/main.");
  }
  const census = exact(value.census, [
    "totalCount", "issueNumbers", "nowIssueNumbers", "excludedPullRequestCount",
    "verifiedStableByDoubleRead", "countReconciled",
  ], "canonical snapshot.census");
  const censusIssues = numbers(census.issueNumbers, "canonical snapshot.census.issueNumbers");
  const censusNow = numbers(census.nowIssueNumbers, "canonical snapshot.census.nowIssueNumbers");
  nonNegativeInteger(census.excludedPullRequestCount, "canonical snapshot.census.excludedPullRequestCount");
  if (censusNow.some((number) => !censusIssues.includes(number)) ||
      nonNegativeInteger(census.totalCount, "canonical snapshot.census.totalCount") !== censusIssues.length || census.verifiedStableByDoubleRead !== true ||
      census.countReconciled !== true) {
    throw new Error("Canonical snapshot Now census or stable-read proof is invalid.");
  }
  if (reconciliationCounts.openIssues !== census.totalCount ||
      reconciliationCounts.issueFields !== organizationFields.totalCount) {
    throw new Error("Canonical snapshot reconciliation open-issue total disagrees with its census.");
  }
  const coverage = exact(value.coverage, [
    "consideredIssueNumbers", "affectedIssueNumbers", "requiredIssueNumbers",
    "hydratedIssueNumbers", "missingIssueNumbers", "complete",
  ], "canonical snapshot.coverage");
  if (coverage.complete !== true || !Array.isArray(coverage.missingIssueNumbers) || coverage.missingIssueNumbers.length > 0) {
    throw new Error("Canonical snapshot coverage is incomplete.");
  }
  const considered = numbers(coverage.consideredIssueNumbers, "canonical snapshot.coverage.consideredIssueNumbers");
  const affected = numbers(coverage.affectedIssueNumbers, "canonical snapshot.coverage.affectedIssueNumbers");
  const required = numbers(coverage.requiredIssueNumbers, "canonical snapshot.coverage.requiredIssueNumbers");
  const hydrated = numbers(coverage.hydratedIssueNumbers, "canonical snapshot.coverage.hydratedIssueNumbers");
  const expectedRequired = uniqueSortedIssueNumbers([...considered, ...affected]);
  if (JSON.stringify(required) !== JSON.stringify(expectedRequired) ||
      JSON.stringify(hydrated) !== JSON.stringify(required) ||
      required.some((number) => !censusIssues.includes(number)) ||
      censusNow.some((number) => !considered.includes(number))) {
    throw new Error("Canonical snapshot coverage does not match required, hydrated, census, and Now identities.");
  }
  const issues = array(value.issues, "canonical snapshot.issues");
  const parsedIssueNumbers: number[] = [];
  const parsedNowIssueNumbers: number[] = [];
  for (const [index, rawIssue] of issues.entries()) {
    const issue = exact(rawIssue, [
      "schemaVersion", "identity", "v1", "nativeType", "relationships", "projectMemberships",
      "persistedVerifications", "pullRequests", "freshness", "transport",
    ], `canonical snapshot.issues[${index}]`);
    if (issue.schemaVersion !== ISSUE_SNAPSHOT_SCHEMA) throw new Error(`canonical snapshot.issues[${index}] has the wrong schema.`);
    const parsedIdentity = identity(
      issue.identity,
      `canonical snapshot.issues[${index}].identity`,
      repository,
    );
    const issueNumber = parsedIdentity.number;
    parsedIssueNumbers.push(issueNumber);
    const v1 = exact(issue.v1, [
      "number", "title", "state", "stateReason", "type", "fieldValues", "labels", "assignees",
      "milestone", "bodySha256", "createdAt", "updatedAt", "relationships",
    ], `canonical snapshot.issues[${index}].v1`);
    if (v1.number !== issueNumber || v1.state !== "OPEN") {
      throw new Error(`canonical snapshot.issues[${index}] identity and open v1 tuple disagree.`);
    }
    nonEmptyString(v1.title, `canonical snapshot.issues[${index}].v1.title`);
    nullableNonEmptyString(v1.stateReason, `canonical snapshot.issues[${index}].v1.stateReason`);
    sortedCanonicalValues(
      v1.fieldValues,
      `canonical snapshot.issues[${index}].v1.fieldValues`,
      compareJsonIdentity,
    );
    const horizonValues = (v1.fieldValues as unknown[]).map(issueFieldValueIdentity)
      .filter((entry) => entry.name === "Horizon");
    if (horizonValues.length > 1) {
      throw new Error(`canonical snapshot.issues[${index}].v1 has duplicate Horizon values.`);
    }
    if (horizonValues[0]?.value === "Now") parsedNowIssueNumbers.push(issueNumber);
    sortedUniqueStrings(v1.labels, `canonical snapshot.issues[${index}].v1.labels`);
    sortedUniqueStrings(v1.assignees, `canonical snapshot.issues[${index}].v1.assignees`);
    if (typeof v1.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(v1.bodySha256)) {
      throw new Error(`canonical snapshot.issues[${index}].v1.bodySha256 must be a lowercase SHA-256.`);
    }
    timestamp(v1.createdAt, `canonical snapshot.issues[${index}].v1.createdAt`);
    timestamp(v1.updatedAt, `canonical snapshot.issues[${index}].v1.updatedAt`);
    if (Date.parse(v1.updatedAt as string) < Date.parse(v1.createdAt as string)) {
      throw new Error(`canonical snapshot.issues[${index}].v1.updatedAt cannot precede createdAt.`);
    }
    if (v1.type !== null) {
      const type = exact(v1.type, ["id", "name", "description"], `canonical snapshot.issues[${index}].v1.type`);
      databaseId(type.id, `canonical snapshot.issues[${index}].v1.type.id`);
      nonEmptyString(type.name, `canonical snapshot.issues[${index}].v1.type.name`);
      nullableNonEmptyString(type.description, `canonical snapshot.issues[${index}].v1.type.description`);
    }
    if (v1.milestone !== null) {
      const milestone = exact(v1.milestone, ["number", "title", "state"], `canonical snapshot.issues[${index}].v1.milestone`);
      positiveIssueNumber(milestone.number, `canonical snapshot.issues[${index}].v1.milestone.number`);
      nonEmptyString(milestone.title, `canonical snapshot.issues[${index}].v1.milestone.title`);
      nonEmptyString(milestone.state, `canonical snapshot.issues[${index}].v1.milestone.state`);
    }
    const v1Relationships = exact(v1.relationships, ["parent", "subIssues", "blockedBy", "blocking"], `canonical snapshot.issues[${index}].v1.relationships`);
    if (v1Relationships.parent !== null) {
      positiveIssueNumber(v1Relationships.parent, `canonical snapshot.issues[${index}].v1.relationships.parent`);
    }
    for (const key of ["subIssues", "blockedBy", "blocking"] as const) {
      numbers(v1Relationships[key], `canonical snapshot.issues[${index}].v1.relationships.${key}`);
    }
    if (issue.nativeType !== null) {
      const nativeType = exact(issue.nativeType, ["organization", "databaseId", "nodeId", "name"], `canonical snapshot.issues[${index}].nativeType`);
      if (nativeType.organization !== repository.organization) {
        throw new Error(`canonical snapshot.issues[${index}].nativeType belongs to another organization.`);
      }
      databaseId(nativeType.databaseId, `canonical snapshot.issues[${index}].nativeType.databaseId`);
      if (nativeType.nodeId !== null) nodeId(nativeType.nodeId, `canonical snapshot.issues[${index}].nativeType.nodeId`);
      nonEmptyString(nativeType.name, `canonical snapshot.issues[${index}].nativeType.name`);
    }
    const relationships = exact(issue.relationships, ["parent", "subIssues", "blockedBy", "blocking"], `canonical snapshot.issues[${index}].relationships`);
    const parentIdentity = relationships.parent === null
      ? null
      : identity(
          relationships.parent,
          `canonical snapshot.issues[${index}].relationships.parent`,
          repository,
        );
    if ((parentIdentity?.number ?? null) !== v1Relationships.parent) {
      throw new Error(`canonical snapshot.issues[${index}] parent relationship disagrees with v1.`);
    }
    for (const key of ["subIssues", "blockedBy", "blocking"] as const) {
      const related = array(relationships[key], `canonical snapshot.issues[${index}].relationships.${key}`)
        .map((entry, childIndex) => identity(
          entry,
          `canonical snapshot.issues[${index}].relationships.${key}[${childIndex}]`,
          key === "blockedBy" ? undefined : repository,
        ));
      const normalized = [...related].sort(compareIssueIdentity);
      if (new Set(related.map((entry) => `${entry.repository.organization}/${entry.repository.name}#${entry.number}`)).size !== related.length ||
          JSON.stringify(related) !== JSON.stringify(normalized)) {
        throw new Error(`canonical snapshot.issues[${index}].relationships.${key} must be unique and sorted.`);
      }
      if (JSON.stringify(related.filter((entry) => key !== "blockedBy" || entry.repository.nodeId === repository.nodeId).map((entry) => entry.number).sort((a, b) => a - b)) !== JSON.stringify(v1Relationships[key])) {
        throw new Error(`canonical snapshot.issues[${index}] ${key} relationships disagree with v1.`);
      }
    }
    const memberships = array(issue.projectMemberships, `canonical snapshot.issues[${index}].projectMemberships`).map((entry, childIndex) => {
      const membership = exact(entry, ["project", "itemNodeId"], `canonical snapshot.issues[${index}].projectMemberships[${childIndex}]`);
      const project = exact(membership.project, ["organization", "number", "nodeId"], `canonical snapshot.issues[${index}].projectMemberships[${childIndex}].project`);
      if (project.organization !== repository.organization) {
        throw new Error(`canonical snapshot.issues[${index}].projectMemberships[${childIndex}] belongs to another organization.`);
      }
      positiveIssueNumber(project.number, `canonical snapshot.issues[${index}].projectMemberships[${childIndex}].project.number`);
      nodeId(project.nodeId, `canonical snapshot.issues[${index}].projectMemberships[${childIndex}].project.nodeId`);
      nodeId(membership.itemNodeId, `canonical snapshot.issues[${index}].projectMemberships[${childIndex}].itemNodeId`);
      return entry as ProjectMembershipV2;
    });
    const normalizedMemberships = [...memberships].sort((left, right) =>
      left.project.organization.localeCompare(right.project.organization) ||
      left.project.number - right.project.number || left.itemNodeId.localeCompare(right.itemNodeId));
    if (new Set(memberships.map((entry) => entry.itemNodeId)).size !== memberships.length ||
        JSON.stringify(memberships) !== JSON.stringify(normalizedMemberships)) {
      throw new Error(`canonical snapshot.issues[${index}].projectMemberships must be unique and sorted.`);
    }
    const verificationRecords = array(issue.persistedVerifications, `canonical snapshot.issues[${index}].persistedVerifications`).map((entry, childIndex) => {
      const record = exact(entry, [
        "source", "comment", "marker", "author", "createdAt", "updatedAt", "edited",
        "verifiedAt", "originMainSha", "check", "trust",
      ], `canonical snapshot.issues[${index}].persistedVerifications[${childIndex}]`);
      const recordContext = `canonical snapshot.issues[${index}].persistedVerifications[${childIndex}]`;
      if (record.source !== "body" && record.source !== "comment") {
        throw new Error(`${recordContext}.source must be body or comment.`);
      }
      if (record.marker !== VERIFICATION_MARKER) throw new Error(`${recordContext}.marker is invalid.`);
      if ((record.source === "body") !== (record.comment === null)) {
        throw new Error(`${recordContext}.comment identity disagrees with its source.`);
      }
      if (record.comment !== null) {
        const comment = exact(record.comment, ["databaseId", "nodeId"], `${recordContext}.comment`);
        databaseId(comment.databaseId, `${recordContext}.comment.databaseId`);
        nodeId(comment.nodeId, `${recordContext}.comment.nodeId`);
      }
      nullableNonEmptyString(record.author, `${recordContext}.author`);
      const createdAt = timestamp(record.createdAt, `${recordContext}.createdAt`);
      const updatedAt = timestamp(record.updatedAt, `${recordContext}.updatedAt`);
      if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error(`${recordContext}.updatedAt cannot precede createdAt.`);
      if (typeof record.edited !== "boolean") throw new Error(`${recordContext}.edited must be boolean.`);
      const expectedEdited = record.source === "comment" && createdAt !== updatedAt;
      if (record.edited !== expectedEdited) throw new Error(`${recordContext}.edited disagrees with source timestamps.`);
      if (record.verifiedAt !== null) timestamp(record.verifiedAt, `${recordContext}.verifiedAt`);
      if (record.originMainSha !== null) gitSha(record.originMainSha, `${recordContext}.originMainSha`);
      nullableNonEmptyString(record.check, `${recordContext}.check`);
      const trust = exact(record.trust, ["status", "reasons"], `${recordContext}.trust`);
      if (trust.status !== "trusted" && trust.status !== "untrusted") {
        throw new Error(`${recordContext}.trust.status must be trusted or untrusted.`);
      }
      const allowedReasons = new Set([
        "copied_marker", "body_edit_provenance_unavailable", "edited_after_creation",
        "untrusted_author", "invalid_marker_fields",
      ]);
      const reasons = array(trust.reasons, `${recordContext}.trust.reasons`).map((reason, reasonIndex) => {
        if (typeof reason !== "string" || !allowedReasons.has(reason)) {
          throw new Error(`${recordContext}.trust.reasons[${reasonIndex}] is invalid.`);
        }
        return reason;
      });
      if (new Set(reasons).size !== reasons.length) throw new Error(`${recordContext}.trust.reasons must be unique.`);
      if ((trust.status === "trusted") !== (reasons.length === 0)) {
        throw new Error(`${recordContext}.trust.status disagrees with its reasons.`);
      }
      if (record.source === "body" && !reasons.includes("body_edit_provenance_unavailable")) {
        throw new Error(`${recordContext} lacks conservative body-edit provenance refusal.`);
      }
      if (record.source === "comment" && reasons.includes("body_edit_provenance_unavailable")) {
        throw new Error(`${recordContext} has an inapplicable body provenance reason.`);
      }
      if (record.edited !== reasons.includes("edited_after_creation")) {
        throw new Error(`${recordContext}.edited disagrees with trust reasons.`);
      }
      const markerFieldsInvalid = record.verifiedAt === null || record.originMainSha === null || record.check === null;
      if (markerFieldsInvalid !== reasons.includes("invalid_marker_fields")) {
        throw new Error(`${recordContext} invalid marker fields disagree with trust reasons.`);
      }
      return entry as PersistedVerificationRecordV2;
    });
    const normalizedVerifications = [...verificationRecords].sort((left, right) =>
      (left.verifiedAt ?? left.createdAt).localeCompare(right.verifiedAt ?? right.createdAt) ||
      (left.comment?.databaseId ?? 0) - (right.comment?.databaseId ?? 0));
    if (JSON.stringify(verificationRecords) !== JSON.stringify(normalizedVerifications)) {
      throw new Error(`canonical snapshot.issues[${index}].persistedVerifications must be sorted.`);
    }
    const pullRequests = array(issue.pullRequests, `canonical snapshot.issues[${index}].pullRequests`).map((entry, childIndex) => {
      const pr = exact(entry, ["identity", "relationship", "state", "mergedAt", "headSha", "url"], `canonical snapshot.issues[${index}].pullRequests[${childIndex}]`);
      const prContext = `canonical snapshot.issues[${index}].pullRequests[${childIndex}]`;
      const prIdentity = identity(pr.identity, `${prContext}.identity`);
      if (pr.relationship !== "linked" && pr.relationship !== "closing") {
        throw new Error(`${prContext}.relationship is invalid.`);
      }
      if (pr.state !== "OPEN" && pr.state !== "CLOSED") throw new Error(`${prContext}.state is invalid.`);
      nullableTimestamp(pr.mergedAt, `${prContext}.mergedAt`);
      if (pr.headSha !== null) gitSha(pr.headSha, `${prContext}.headSha`);
      const url = nonEmptyString(pr.url, `${prContext}.url`);
      const expectedUrlPrefix = `https://github.com/${prIdentity.repository.organization}/${prIdentity.repository.name}/pull/${prIdentity.number}`;
      if (url !== expectedUrlPrefix) throw new Error(`${prContext}.url disagrees with its qualified identity.`);
      return entry as PullRequestEvidenceV2;
    });
    const normalizedPullRequests = [...pullRequests].sort((left, right) =>
      compareIssueIdentity(left.identity, right.identity) || left.relationship.localeCompare(right.relationship));
    if (new Set(pullRequests.map((entry) =>
      `${entry.identity.repository.organization}/${entry.identity.repository.name}#${entry.identity.number}:${entry.relationship}`)).size !== pullRequests.length ||
        JSON.stringify(pullRequests) !== JSON.stringify(normalizedPullRequests)) {
      throw new Error(`canonical snapshot.issues[${index}].pullRequests must be unique and sorted.`);
    }
    const freshness = exact(issue.freshness, [
      "latestTrustedVerificationAt", "trustedMarkerRecency",
      "latestTrustedVerificationBoundToOriginMainSha",
    ], `canonical snapshot.issues[${index}].freshness`);
    nullableTimestamp(freshness.latestTrustedVerificationAt, `canonical snapshot.issues[${index}].freshness.latestTrustedVerificationAt`);
    if (freshness.trustedMarkerRecency !== "current" && freshness.trustedMarkerRecency !== "stale" &&
        freshness.trustedMarkerRecency !== "missing") {
      throw new Error(`canonical snapshot.issues[${index}].freshness.trustedMarkerRecency is invalid.`);
    }
    if (freshness.latestTrustedVerificationBoundToOriginMainSha !== null &&
        typeof freshness.latestTrustedVerificationBoundToOriginMainSha !== "boolean") {
      throw new Error(`canonical snapshot.issues[${index}].freshness.latestTrustedVerificationBoundToOriginMainSha must be boolean or null.`);
    }
    const recomputedFreshness = verificationFreshness(
      verificationRecords,
      value.generatedAt as string,
      originMainSha,
    );
    // Compare canonically rather than with JSON.stringify. A stored snapshot is serialized through
    // prettyCanonicalJson, which sorts keys; the recomputed value carries the object-literal order
    // from verificationFreshness. Those agree today only because that literal happens to be in
    // alphabetical order, so under a stringify compare merely reordering it -- a cosmetic edit
    // with no semantic content -- would make every real snapshot fail validation. The round-trip
    // assertion in the preflight tests does catch that, so the failure would be loud rather than
    // silent; comparing canonically simply removes the tripwire instead of relying on it.
    if (canonicalJson(freshness) !== canonicalJson(recomputedFreshness)) {
      throw new Error(`canonical snapshot.issues[${index}].freshness disagrees with recomputed verification freshness.`);
    }
    transport(issue.transport, `canonical snapshot.issues[${index}].transport`);
  }
  if (JSON.stringify(parsedIssueNumbers) !== JSON.stringify(hydrated)) {
    throw new Error("Canonical snapshot issue records do not exactly match hydrated coverage.");
  }
  if (JSON.stringify(parsedNowIssueNumbers) !== JSON.stringify(censusNow)) {
    throw new Error("Canonical snapshot Now census disagrees with hydrated Horizon values.");
  }
  const capability = exact(value.capability, ["comments", "relationships", "linkedPullRequests", "projectMembership", "requestMetadata"], "canonical snapshot.capability");
  if (capability.comments !== "available" || capability.relationships !== "available" ||
      capability.linkedPullRequests !== "available" || capability.projectMembership !== "available" ||
      capability.requestMetadata !== "available") {
    throw new Error("Canonical snapshot capabilities, including requestMetadata, must be available before recommendation eligibility.");
  }
  const recovery = exact(value.recovery, ["mode", "state", "mutationClientPresent", "blockers"], "canonical snapshot.recovery");
  if (recovery.mode !== "read_only" || recovery.state !== "complete" || recovery.mutationClientPresent !== false) {
    throw new Error("Canonical snapshot is not structurally read-only and complete.");
  }
  if (!Array.isArray(recovery.blockers) || recovery.blockers.length !== 0) {
    throw new Error("Canonical snapshot recovery blockers must be empty.");
  }
  const rootTransport = transport(value.transport, "canonical snapshot.transport");
  if (rootTransport.length === 0) throw new Error("Canonical snapshot transport must contain request evidence.");
  const rootRequestIds = new Set(rootTransport.map((entry) => entry.requestId));
  for (const requestId of graphql.requestIds as string[]) {
    if (!rootRequestIds.has(requestId)) {
      throw new Error(`Canonical snapshot GraphQL request ID ${requestId} is missing from transport evidence.`);
    }
  }
  return raw as CanonicalSnapshotV2;
}
