import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ISSUE_SNAPSHOT_SCHEMA,
  CANONICAL_REST_API_VERSION,
  buildCanonicalSnapshotV2,
  canonicalSnapshotV2Json,
  compareJsonIdentity,
  gitSha,
  normalizeIssueSnapshotV2,
  parsePersistedVerificationRecords,
  qualifyIssueIdentity,
  qualifyRepositoryIdentity,
  verificationFreshness,
  type CanonicalSnapshotV2,
  type IssueIdentityV2,
  type IssueRelationshipsV2,
  type IssueSnapshotV2,
  type GraphqlCapabilityProofV2,
  type ProjectMembershipV2,
  type PullRequestEvidenceV2,
  type RepositoryIdentityV2,
  type SourceBlobIdentityV2,
  type TransportMetadataV2,
} from "./lib/github-issue-roadmap/snapshot-v2";
import { canonicalizeJson } from "./lib/github-issue-roadmap/canonical-json";
import { issueFieldValueIdentity } from "./lib/github-issue-roadmap/issue-field-value";
import { readBoardFingerprint, type BoardFingerprint } from "./lib/github-issue-roadmap/board-fingerprint";
import {
  assertReadOnlyGhArgs,
  createReadOnlyGhRunner,
  parseIncludedGhResponse as parseIncludedGhResponseShared,
  readRestPagesWithMetadata as readRestPagesWithMetadataShared,
  readRestResourceWithMetadata as readRestResourceWithMetadataShared,
  transportMetadata as transportMetadataShared,
  type GhRunnerOptions,
} from "./lib/github-issue-roadmap/read-only-github-reader";
import {
  assertDistinctRoadmapArtifactPaths,
  assertRoadmapArtifactOutputPath,
  writeRoadmapArtifactAtomically,
  type ArtifactFs,
} from "./lib/github-issue-roadmap/artifact-io";
import {
  createScheduledCaptureSession,
  type ScheduledCaptureOptions,
} from "./lib/github-issue-roadmap/shadow-batch";

export const API_VERSION = CANONICAL_REST_API_VERSION;
export const ACCEPT_HEADER = "Accept: application/vnd.github+json";

type JsonObject = Record<string, unknown>;
export type GhRunner = (args: readonly string[]) => string;
export { assertReadOnlyGhArgs };

interface RelationshipSnapshot {
  readonly parent: number | null;
  readonly subIssues: readonly number[];
  readonly blockedBy: readonly number[];
  readonly blocking: readonly number[];
}

const relationshipSupportByRunner = new WeakMap<
  GhRunner,
  Record<keyof RelationshipSnapshot, boolean>
>();

interface RawIssue extends JsonObject {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly state_reason?: string | null;
  readonly body: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly labels?: readonly unknown[];
  readonly assignees?: readonly unknown[];
  readonly milestone?: unknown;
  readonly type?: unknown;
  readonly fieldValues?: readonly unknown[];
  readonly relationships?: Partial<RelationshipSnapshot>;
}

export interface NormalizedIssueV1 {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly stateReason: string | null;
  readonly type: unknown;
  readonly fieldValues: readonly unknown[];
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone: unknown;
  readonly bodySha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly relationships: RelationshipSnapshot;
}

// Frozen compatibility name used by the v1 steward and its exact validator.
// V2 consumers must use the explicit projection in snapshot-v2.ts.
export type NormalizedIssue = NormalizedIssueV1;

interface CountPair {
  readonly expected: number | null;
  readonly actual: number | null;
}

interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

interface CountResult extends CountPair {
  readonly matches: boolean;
}

export interface CountReconciliation {
  readonly repositories: CountResult;
  readonly issueFields: CountResult;
  readonly projects: CountResult;
  readonly openIssues: CountResult;
  readonly allMatch: boolean;
  readonly allVerified: boolean;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nextPageCursor(pageInfo: JsonObject, context: string): string | null {
  if (pageInfo.hasNextPage !== true) return null;
  const cursor = asString(pageInfo.endCursor);
  if (!cursor) {
    throw new Error(`${context}: GitHub reported more pages without a cursor.`);
  }
  return cursor;
}

export function canonicalize(value: unknown): unknown {
  return canonicalizeJson(value);
}

export function sha256Body(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "", "utf8").digest("hex");
}

function labelName(value: unknown): string | null {
  if (typeof value === "string") return value;
  return asString(asObject(value).name);
}

function assigneeLogin(value: unknown): string | null {
  return asString(asObject(value).login);
}

function normalizeMilestone(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const milestone = asObject(value);
  return {
    number: asNumber(milestone.number),
    title: asString(milestone.title),
    state: asString(milestone.state),
  };
}

function normalizeIssueType(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = asObject(value);
  return canonicalize({
    id: type.id ?? null,
    name: type.name ?? null,
    description: type.description ?? null,
  });
}

export function normalizeIssues(issues: readonly RawIssue[]): NormalizedIssue[] {
  return issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state.toUpperCase(),
      stateReason: issue.state_reason ?? null,
      type: normalizeIssueType(issue.type),
      fieldValues: [...(issue.fieldValues ?? [])]
        .map(canonicalize)
        .sort(compareJsonIdentity),
      labels: (issue.labels ?? [])
        .map(labelName)
        .filter((value): value is string => value !== null)
        .sort((left, right) => left.localeCompare(right)),
      assignees: (issue.assignees ?? [])
        .map(assigneeLogin)
        .filter((value): value is string => value !== null)
        .sort((left, right) => left.localeCompare(right)),
      milestone: normalizeMilestone(issue.milestone),
      bodySha256: sha256Body(issue.body),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      relationships: {
        parent: issue.relationships?.parent ?? null,
        subIssues: [...(issue.relationships?.subIssues ?? [])].sort((a, b) => a - b),
        blockedBy: [...(issue.relationships?.blockedBy ?? [])].sort((a, b) => a - b),
        blocking: [...(issue.relationships?.blocking ?? [])].sort((a, b) => a - b),
      },
    }))
    .sort((left, right) => left.number - right.number);
}

export function assertStableIssueCapture(
  before: readonly NormalizedIssue[],
  after: readonly NormalizedIssue[],
): void {
  if (JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after))) return;
  throw new Error(
    "GitHub issues changed during preflight capture; refusing to write a mixed-version snapshot.",
  );
}

export function assertOutputPathInsideRepo(
  outputPath: string,
  repoRoot: string,
  fs?: ArtifactFs,
): string {
  return assertRoadmapArtifactOutputPath(outputPath, repoRoot, fs);
}

export function reconcileCounts(counts: {
  readonly repositories: CountPair;
  readonly issueFields: CountPair;
  readonly projects: CountPair;
  readonly openIssues: CountPair;
}): CountReconciliation {
  const entry = ({ expected, actual }: CountPair): CountResult => ({
    expected,
    actual,
    matches: expected !== null && actual !== null && expected === actual,
  });
  const repositories = entry(counts.repositories);
  const issueFields = entry(counts.issueFields);
  const projects = entry(counts.projects);
  const openIssues = entry(counts.openIssues);
  return {
    repositories,
    issueFields,
    projects,
    openIssues,
    allMatch: repositories.matches && issueFields.matches && projects.matches && openIssues.matches,
    allVerified: [repositories, issueFields, projects, openIssues]
      .every(({ expected, actual }) => expected !== null && actual !== null),
  };
}

export function assertCountReconciliation(reconciliation: CountReconciliation): void {
  if (reconciliation.allMatch) return;
  const mismatches = Object.entries(reconciliation)
    .filter((entry): entry is [string, CountResult] =>
      entry[0] !== "allMatch" && entry[0] !== "allVerified" &&
      typeof entry[1] === "object" && entry[1].expected !== null &&
      entry[1].actual !== null && !entry[1].matches)
    .map(([name, value]) => `${name} expected ${value.expected}, captured ${value.actual}`);
  if (mismatches.length === 0) return;
  throw new Error(`Preflight count reconciliation failed: ${mismatches.join("; ")}`);
}

export function assertIssueNumberReconciliation(
  issueNumbers: readonly number[],
  relationshipNumbers: readonly number[],
): void {
  const issueSet = new Set(issueNumbers);
  const relationshipSet = new Set(relationshipNumbers);
  const missing = [...issueSet]
    .filter((number) => !relationshipSet.has(number))
    .sort((left, right) => left - right);
  const unexpected = [...relationshipSet]
    .filter((number) => !issueSet.has(number))
    .sort((left, right) => left - right);
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `Preflight issue relationship reconciliation failed: missing [${missing.join(", ")}]; unexpected [${unexpected.join(", ")}].`,
  );
}

export function createGhRunner(options: GhRunnerOptions = {}): GhRunner {
  return createReadOnlyGhRunner({ ...options, allowAmbientCredentials: true });
}

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON for ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseGraphql(raw: string, context: string): JsonObject {
  const response = parseJson<JsonObject>(raw, context);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error(`GitHub GraphQL failed for ${context}: ${JSON.stringify(response.errors)}`);
  }
  return response;
}

function readRestPages(
  runGh: GhRunner,
  endpoint: string,
): { readonly items: JsonObject[]; readonly totalCount: number } {
  const raw = runGh([
    "api",
    "--paginate",
    "--slurp",
    "-H",
    ACCEPT_HEADER,
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    endpoint,
  ]);
  const parsed = parseJson<unknown>(raw, endpoint);
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const items: JsonObject[] = [];
  let reportedTotal: number | null = null;
  for (const page of pages) {
    if (Array.isArray(page)) {
      items.push(...page.map(asObject));
      continue;
    }
    const object = asObject(page);
    const pageItems = object.items ?? object.values ?? object.repositories ?? object.issue_fields;
    if (Array.isArray(pageItems)) items.push(...pageItems.map(asObject));
    reportedTotal = asNumber(object.total_count) ?? reportedTotal;
  }
  return { items, totalCount: reportedTotal ?? items.length };
}

interface IncludedGhResponse {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface MetadataResult<T> {
  readonly value: T;
  readonly transport: readonly TransportMetadataV2[];
}

export function parseIncludedGhResponse(raw: string): IncludedGhResponse {
  return parseIncludedGhResponseShared(raw);
}

function transportMetadata(
  endpoint: string,
  page: number | null,
  response: IncludedGhResponse,
  fallbackFetchedAt: string,
): TransportMetadataV2 {
  return transportMetadataShared(endpoint, page, response, fallbackFetchedAt);
}

export function readRestPagesWithMetadata(
  runGh: GhRunner,
  endpoint: string,
  fetchedAt: string,
): MetadataResult<readonly JsonObject[]> {
  return readRestPagesWithMetadataShared(runGh, endpoint, fetchedAt);
}

export function readRestResourceWithMetadata(
  runGh: GhRunner,
  endpoint: string,
  fetchedAt: string,
): MetadataResult<JsonObject> {
  return readRestResourceWithMetadataShared(runGh, endpoint, fetchedAt);
}

function parseOauthScopes(responseWithHeaders: string): string[] {
  const scopes = responseWithHeaders.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1] ?? "";
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function readAuth(runGh: GhRunner): { readonly oauthScopes: string[]; readonly oauthScopesHeaderPresent: boolean } {
  const response = runGh([
    "api",
    "--include",
    "-H",
    ACCEPT_HEADER,
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    "/user",
  ]);
  return {
    oauthScopes: parseOauthScopes(response),
    oauthScopesHeaderPresent: /^x-oauth-scopes:/im.test(response),
  };
}

interface ProjectInspectionOk {
  readonly status: "ok";
  readonly totalCount: number;
  readonly items: readonly unknown[];
}

interface ProjectInspectionBlocked {
  readonly status: "blocked";
  readonly blocker: {
    readonly code: "missing_scope";
    readonly requiredScopes: readonly ["read:project"];
    readonly message: string;
  };
}

export type ProjectInspection = ProjectInspectionOk | ProjectInspectionBlocked;

function isProjectScopeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /read:project|projects? scope|resource not accessible by.*integration/i.test(message);
}

const PROJECTS_QUERY = `query RoadmapProjects($login: String!, $cursor: String) {
  organization(login: $login) {
    projectsV2(first: 100, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url closed public shortDescription createdAt updatedAt
        items(first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id type
            content {
              ... on Issue { id number repository { nameWithOwner } }
              ... on PullRequest { id number repository { nameWithOwner } }
              ... on DraftIssue { id title }
            }
          }
        }
        fields(first: 100) {
          totalCount
          nodes {
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField {
              options { id name description color }
            }
          }
        }
        views(first: 100) {
          totalCount
          nodes { id number name layout filter createdAt updatedAt }
        }
        workflows(first: 100) {
          totalCount
          nodes { id name number enabled }
        }
      }
    }
  }
}`;

const PROJECT_MEMBERSHIPS_QUERY = `query RoadmapProjectMemberships($login: String!, $cursor: String) {
  organization(login: $login) {
    projectsV2(first: 100, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id number
        items(first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id type
            content {
              ... on Issue { id number repository { nameWithOwner } }
              ... on PullRequest { id number repository { nameWithOwner } }
              ... on DraftIssue { id title }
            }
          }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS_QUERY = `query RoadmapProjectItems($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id type
          content {
            ... on Issue { id number repository { nameWithOwner } }
            ... on PullRequest { id number repository { nameWithOwner } }
            ... on DraftIssue { id title }
          }
        }
      }
    }
  }
}`;

function completeProjectItems(project: JsonObject, runGh: GhRunner): JsonObject {
  const projectId = asString(project.id);
  if (!projectId) throw new Error("GitHub returned a Project without an ID.");
  const initial = asObject(project.items);
  const totalCount = asNumber(initial.totalCount) ?? 0;
  const nodes = Array.isArray(initial.nodes) ? [...initial.nodes] : [];
  const initialPageInfo = asObject(initial.pageInfo);
  let cursor = nextPageCursor(initialPageInfo, `items for Project #${String(project.number)}`);
  while (cursor) {
    const response = parseGraphql(runGh([
      "api", "graphql", "-f", `query=${PROJECT_ITEMS_QUERY}`,
      "-F", `id=${projectId}`, "-F", `cursor=${cursor}`,
    ]), `items for Project #${String(project.number)}`);
    const connection = asObject(asObject(asObject(response.data).node).items);
    if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes);
    const pageInfo = asObject(connection.pageInfo);
    cursor = nextPageCursor(pageInfo, `items for Project #${String(project.number)}`);
  }
  if (nodes.length !== totalCount) {
    throw new Error(
      `Project #${String(project.number)} has ${totalCount} items, but only ${nodes.length} identities were returned.`,
    );
  }
  return {
    ...project,
    items: {
      totalCount,
      nodes: nodes.map(canonicalize).sort(compareJsonIdentity),
    },
  };
}

export function inspectProjects(organization: string, runGh: GhRunner): ProjectInspection {
  try {
    const items: unknown[] = [];
    let cursor: string | null = null;
    let totalCount = 0;
    do {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${PROJECTS_QUERY}`,
        "-F",
        `login=${organization}`,
      ];
      if (cursor) args.push("-F", `cursor=${cursor}`);
      const response = parseGraphql(runGh(args), "organization Projects v2");
      const connection = asObject(asObject(asObject(response.data).organization).projectsV2);
      totalCount = asNumber(connection.totalCount) ?? 0;
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
      for (const rawNode of nodes) {
        const node = completeProjectItems(asObject(rawNode), runGh);
        for (const connectionName of ["fields", "views", "workflows"] as const) {
          const nested = asObject(node[connectionName]);
          const nestedNodes = Array.isArray(nested.nodes) ? nested.nodes : [];
          const nestedTotal = asNumber(nested.totalCount) ?? nestedNodes.length;
          if (nestedNodes.length !== nestedTotal) {
            throw new Error(
              `Project #${String(node.number)} has ${nestedTotal} ${connectionName}, but only ${nestedNodes.length} were returned.`,
            );
          }
        }
        items.push(canonicalize(node));
      }
      const pageInfo = asObject(connection.pageInfo);
      cursor = nextPageCursor(pageInfo, `projectsV2 for organization ${organization}`);
    } while (cursor);
    return {
      status: "ok",
      totalCount,
      items: items.sort(compareJsonIdentity),
    };
  } catch (error) {
    if (!isProjectScopeFailure(error)) throw error;
    return {
      status: "blocked",
      blocker: {
        code: "missing_scope",
        requiredScopes: ["read:project"],
        message: "Project inspection requires the read:project OAuth scope.",
      },
    };
  }
}

interface RelationshipCollection {
  readonly totalCount: number;
  readonly support: Record<keyof RelationshipSnapshot, boolean>;
  readonly byIssue: ReadonlyMap<number, RelationshipSnapshot>;
}

function connectionPage(value: unknown, context: string): {
  readonly numbers: number[];
  readonly nextCursor: string | null;
} {
  const connection = asObject(value);
  const nodes = connection.nodes;
  const numbers = !Array.isArray(nodes) ? [] : nodes
    .map((node) => asNumber(asObject(node).number))
    .filter((number): number is number => number !== null)
    .sort((left, right) => left - right);
  const pageInfo = asObject(connection.pageInfo);
  return {
    numbers,
    nextCursor: nextPageCursor(pageInfo, context),
  };
}

function remainingRelationshipNumbers(
  owner: string,
  repo: string,
  issueNumber: number,
  field: "subIssues" | "blockedBy" | "blocking",
  firstCursor: string,
  runGh: GhRunner,
): number[] {
  const numbers: number[] = [];
  let cursor: string | null = firstCursor;
  const query = `query RoadmapIssueRelationship($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        ${field}(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { number }
        }
      }
    }
  }`;
  while (cursor) {
    const response = parseGraphql(runGh([
      "api", "graphql", "-f", `query=${query}`,
      "-F", `owner=${owner}`, "-F", `repo=${repo}`,
      "-F", `number=${issueNumber}`, "-F", `cursor=${cursor}`,
    ]), `${field} relationships for issue #${issueNumber}`);
    const issue = asObject(asObject(asObject(response.data).repository).issue);
    const page = connectionPage(issue[field], `${field} relationships for issue #${issueNumber}`);
    numbers.push(...page.numbers);
    cursor = page.nextCursor;
  }
  return numbers;
}

function collectRelationships(owner: string, repo: string, runGh: GhRunner): RelationshipCollection {
  const introspection = parseGraphql(runGh([
    "api",
    "graphql",
    "-f",
    "query=query RoadmapIssueSchema { __type(name: \"Issue\") { fields { name } } }",
  ]), "Issue relationship schema");
  const issueTypeFields = asObject(asObject(introspection.data).__type).fields;
  const fieldNodes = Array.isArray(issueTypeFields)
    ? issueTypeFields
    : [];
  const names = new Set(fieldNodes.map((field) => asString(asObject(field).name)).filter(Boolean));
  const support = {
    parent: names.has("parent"),
    subIssues: names.has("subIssues"),
    blockedBy: names.has("blockedBy"),
    blocking: names.has("blocking"),
  };
  const selections = [
    "number",
    support.parent ? "parent { number }" : "",
    support.subIssues ? "subIssues(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }" : "",
    support.blockedBy ? "blockedBy(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }" : "",
    support.blocking ? "blocking(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }" : "",
  ].filter(Boolean).join("\n");
  const query = `query RoadmapOpenIssues($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${selections} }
      }
    }
  }`;
  const byIssue = new Map<number, RelationshipSnapshot>();
  let cursor: string | null = null;
  let totalCount = 0;
  do {
    const args = [
      "api", "graphql", "-f", `query=${query}`,
      "-F", `owner=${owner}`, "-F", `repo=${repo}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const response = parseGraphql(runGh(args), "open issue relationships");
    const connection = asObject(asObject(asObject(asObject(response.data).repository).issues));
    totalCount = asNumber(connection.totalCount) ?? 0;
    for (const rawNode of Array.isArray(connection.nodes) ? connection.nodes : []) {
      const node = asObject(rawNode);
      const number = asNumber(node.number);
      if (number === null) continue;
      const readRelationship = (field: "subIssues" | "blockedBy" | "blocking"): number[] => {
        const page = connectionPage(node[field], `${field} relationships for issue #${number}`);
        const remainder = page.nextCursor
          ? remainingRelationshipNumbers(owner, repo, number, field, page.nextCursor, runGh)
          : [];
        return [...page.numbers, ...remainder].sort((left, right) => left - right);
      };
      byIssue.set(number, {
        parent: support.parent ? asNumber(asObject(node.parent).number) : null,
        subIssues: support.subIssues ? readRelationship("subIssues") : [],
        blockedBy: support.blockedBy ? readRelationship("blockedBy") : [],
        blocking: support.blocking ? readRelationship("blocking") : [],
      });
    }
    const pageInfo = asObject(connection.pageInfo);
    cursor = nextPageCursor(pageInfo, `issues for ${owner}/${repo}`);
  } while (cursor);
  return { totalCount, support, byIssue };
}

function readRelationshipSupport(runGh: GhRunner): Record<keyof RelationshipSnapshot, boolean> {
  const cached = relationshipSupportByRunner.get(runGh);
  if (cached) return cached;
  const introspection = parseGraphql(runGh([
    "api",
    "graphql",
    "-f",
    "query=query RoadmapIssueSchema { __type(name: \"Issue\") { fields { name } } }",
  ]), "Issue relationship schema");
  const fields = asObject(asObject(introspection.data).__type).fields;
  const names = new Set(
    (Array.isArray(fields) ? fields : [])
      .map((field) => asString(asObject(field).name))
      .filter((name): name is string => name !== null),
  );
  const support = {
    parent: names.has("parent"),
    subIssues: names.has("subIssues"),
    blockedBy: names.has("blockedBy"),
    blocking: names.has("blocking"),
  };
  relationshipSupportByRunner.set(runGh, support);
  return support;
}

function readIssueRelationships(
  owner: string,
  repo: string,
  issueNumber: number,
  runGh: GhRunner,
): RelationshipSnapshot {
  const support = readRelationshipSupport(runGh);
  const unsupported = Object.entries(support)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  if (unsupported.length > 0) {
    throw new Error(
      `GitHub does not expose required issue relationships: ${unsupported.join(", ")}; refusing an incomplete steward read.`,
    );
  }
  const query = `query RoadmapIssueTuple($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        parent { number }
        subIssues(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }
        blockedBy(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }
        blocking(first: 100) { pageInfo { hasNextPage endCursor } nodes { number } }
      }
    }
  }`;
  const response = parseGraphql(runGh([
    "api", "graphql", "-f", `query=${query}`,
    "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${issueNumber}`,
  ]), `relationships for issue #${issueNumber}`);
  const issue = asObject(asObject(asObject(response.data).repository).issue);
  if (asNumber(issue.number) !== issueNumber) {
    throw new Error(`GitHub did not return issue #${issueNumber} during relationship capture.`);
  }
  const readRelationship = (field: "subIssues" | "blockedBy" | "blocking"): number[] => {
    const page = connectionPage(issue[field], `${field} relationships for issue #${issueNumber}`);
    const remainder = page.nextCursor
      ? remainingRelationshipNumbers(owner, repo, issueNumber, field, page.nextCursor, runGh)
      : [];
    return [...page.numbers, ...remainder].sort((left, right) => left - right);
  };
  return {
    parent: asNumber(asObject(issue.parent).number),
    subIssues: readRelationship("subIssues"),
    blockedBy: readRelationship("blockedBy"),
    blocking: readRelationship("blocking"),
  };
}

export function readGraphqlWithMetadata(
  runGh: GhRunner,
  query: string,
  variables: readonly string[],
  context: string,
  fetchedAt: string,
  page: number | null = null,
): MetadataResult<JsonObject> {
  const response = parseIncludedGhResponse(runGh([
    "api", "graphql", "--include", "-f", `query=${query}`, ...variables,
  ]));
  const metadata = transportMetadata(`graphql:${context}`, page, response, fetchedAt);
  return {
    value: parseGraphql(response.body, context),
    transport: [metadata],
  };
}

const V2_CAPABILITY_QUERY = `query RoadmapSnapshotCapabilitiesV2 {
  issue: __type(name: "Issue") { fields { name } }
  projectV2: __type(name: "ProjectV2") { fields { name } }
}`;

const V2_REPOSITORY_COUNT_QUERY = `query RoadmapRepositoryCount($login: String!) {
  organization(login: $login) {
    repositories(first: 1) { totalCount }
  }
}`;

const V2_PROJECT_ITEM_CAPABILITY_QUERY = `query RoadmapSnapshotProjectItemCapabilityV2 {
  projectV2Item: __type(name: "ProjectV2Item") { fields { name } }
}`;

function schemaFieldNames(value: unknown): string[] {
  const fields = asObject(value).fields;
  return (Array.isArray(fields) ? fields : [])
    .map((field) => asString(asObject(field).name))
    .filter((field): field is string => field !== null)
    .sort((left, right) => left.localeCompare(right));
}

function readGraphqlCapabilityProofV2(
  runGh: GhRunner,
  fetchedAt: string,
): MetadataResult<GraphqlCapabilityProofV2> {
  const result = readGraphqlWithMetadata(
    runGh,
    V2_CAPABILITY_QUERY,
    [],
    "canonical snapshot schema capabilities",
    fetchedAt,
  );
  const itemResult = readGraphqlWithMetadata(
    runGh,
    V2_PROJECT_ITEM_CAPABILITY_QUERY,
    [],
    "canonical snapshot Project item schema capability",
    fetchedAt,
  );
  const data = asObject(result.value.data);
  const issueFields = schemaFieldNames(data.issue);
  const projectV2Fields = schemaFieldNames(data.projectV2);
  const projectV2ItemFields = schemaFieldNames(asObject(itemResult.value.data).projectV2Item);
  const missing = [
    ...["blockedBy", "blocking", "parent", "subIssues"]
      .filter((field) => !issueFields.includes(field)).map((field) => `Issue.${field}`),
    ...["items"].filter((field) => !projectV2Fields.includes(field)).map((field) => `ProjectV2.${field}`),
    ...["content", "id"].filter((field) => !projectV2ItemFields.includes(field))
      .map((field) => `ProjectV2Item.${field}`),
  ];
  if (missing.length > 0) {
    throw new Error(`GitHub GraphQL schema is missing required canonical snapshot capabilities: ${missing.join(", ")}.`);
  }
  const transport = [...result.transport, ...itemResult.transport];
  const requestIds = transport
    .map((metadata) => metadata.requestId)
    .filter((requestId): requestId is string => requestId !== null);
  if (requestIds.length !== transport.length) {
    throw new Error("GitHub GraphQL capability proof is missing request IDs.");
  }
  return {
    value: {
      checkedAt: transport.at(-1)?.fetchedAt ?? fetchedAt,
      requestIds,
      issueFields,
      projectV2Fields,
      projectV2ItemFields,
      allRequiredCapabilitiesPresent: true,
    },
    transport,
  };
}

function readRemoteSourceIdentityV2(
  runGh: GhRunner,
  repo: RepoRef,
  path: "STRATEGY.md" | "docs/runbooks/github-issue-roadmap.md",
  originMainSha: string,
  fetchedAt: string,
): MetadataResult<SourceBlobIdentityV2> {
  const endpoint = `/repos/${repo.fullName}/contents/${path}?ref=${originMainSha}`;
  const result = readRestResourceWithMetadata(runGh, endpoint, fetchedAt);
  const actualPath = asString(result.value.path);
  if (actualPath !== path || asString(result.value.type) !== "file") {
    throw new Error(`Remote source identity for ${path} is missing or resolved to another resource.`);
  }
  return {
    value: {
      path,
      blobSha: gitSha(result.value.sha, `${path} blob SHA`),
      commitSha: gitSha(originMainSha, "Remote origin/main SHA"),
    },
    transport: result.transport,
  };
}

const V2_RELATIONSHIPS_QUERY = `query RoadmapIssueRelationshipsV2($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      repository { nameWithOwner }
      parent { id databaseId number repository { nameWithOwner } }
      subIssues(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId number state repository { id databaseId nameWithOwner } }
      }
      blockedBy(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId number state repository { id databaseId nameWithOwner } }
      }
      blocking(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId number state repository { id databaseId nameWithOwner } }
      }
    }
  }
}`;

function v2RelationshipQuery(field: "subIssues" | "blockedBy" | "blocking"): string {
  return `query RoadmapIssueRelationshipV2($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        repository { nameWithOwner }
        ${field}(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id databaseId number state repository { id databaseId nameWithOwner } }
        }
      }
    }
  }`;
}

function qualifyGraphqlIssue(
  repository: RepositoryIdentityV2,
  value: unknown,
  allowExternal = false,
): IssueIdentityV2 {
  const issue = asObject(value);
  const row = asObject(issue.repository);
  const fullName = asString(row.nameWithOwner);
  let target = repository;
  if (allowExternal && fullName?.toLowerCase() !== `${repository.organization}/${repository.name}`.toLowerCase()) {
    const [organization, name, extra] = (fullName ?? "").split("/");
    if (extra || !organization || !name) throw new Error("Invalid blocker repository");
    target = qualifyRepositoryIdentity({ organization, name, databaseId: row.databaseId, nodeId: row.id });
  }
  if (allowExternal && (row.id !== target.nodeId || row.databaseId !== target.databaseId)) throw new Error("Blocker repository identity missing or mismatched");
  if (allowExternal && issue.state !== "OPEN" && issue.state !== "CLOSED") throw new Error("Blocker live state unavailable");
  const identity = qualifyIssueIdentity(target, {
    number: issue.number,
    databaseId: issue.databaseId,
    nodeId: issue.id,
    repositoryFullName: row.nameWithOwner,
  });
  return { ...identity, ...(allowExternal && (issue.state === "OPEN" || issue.state === "CLOSED") ? { state: issue.state } : {}) };
}

export function readQualifiedRelationshipsV2(
  repository: RepositoryIdentityV2,
  issueNumber: number,
  runGh: GhRunner,
  fetchedAt: string,
): MetadataResult<IssueRelationshipsV2> {
  const variables = [
    "-F", `owner=${repository.organization}`,
    "-F", `repo=${repository.name}`,
    "-F", `number=${issueNumber}`,
  ];
  const firstResult = readGraphqlWithMetadata(
    runGh,
    V2_RELATIONSHIPS_QUERY,
    variables,
    `relationships for ${repository.organization}/${repository.name}#${issueNumber}`,
    fetchedAt,
    1,
  );
  const parentIssue = asObject(asObject(asObject(firstResult.value.data).repository).issue);
  if (asNumber(parentIssue.number) !== issueNumber) {
    throw new Error(`GitHub did not return issue #${issueNumber} during v2 parent capture.`);
  }
  const repositoryFullName = asString(asObject(parentIssue.repository).nameWithOwner);
  const expectedFullName = `${repository.organization}/${repository.name}`;
  if (repositoryFullName?.toLowerCase() !== expectedFullName.toLowerCase()) {
    throw new Error(`GitHub issue resource mismatch during v2 relationship capture.`);
  }
  const transport = [...firstResult.transport];
  const readConnection = (field: "subIssues" | "blockedBy" | "blocking"): IssueIdentityV2[] => {
    const initialConnection = asObject(parentIssue[field]);
    const identities = (Array.isArray(initialConnection.nodes) ? initialConnection.nodes : [])
      .map((node) => qualifyGraphqlIssue(repository, node, field === "blockedBy"));
    const initialPageInfo = asObject(initialConnection.pageInfo);
    let cursor = nextPageCursor(initialPageInfo, `${field} for ${expectedFullName}#${issueNumber}`);
    let page = 2;
    while (cursor) {
      const result = readGraphqlWithMetadata(
        runGh,
        v2RelationshipQuery(field),
        [...variables, "-F", `cursor=${cursor}`],
        `${field} for ${repository.organization}/${repository.name}#${issueNumber}`,
        fetchedAt,
        page,
      );
      transport.push(...result.transport);
      const issue = asObject(asObject(asObject(result.value.data).repository).issue);
      if (asNumber(issue.number) !== issueNumber) {
        throw new Error(`GitHub did not return issue #${issueNumber} during v2 ${field} capture.`);
      }
      const connection = asObject(issue[field]);
      for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
        identities.push(qualifyGraphqlIssue(repository, node, field === "blockedBy"));
      }
      const pageInfo = asObject(connection.pageInfo);
      cursor = nextPageCursor(pageInfo, `${field} for ${expectedFullName}#${issueNumber}`);
      page += 1;
    }
    return identities.sort((left, right) => left.number - right.number);
  };
  return {
    value: {
      parent: parentIssue.parent === null || parentIssue.parent === undefined
        ? null
        : qualifyGraphqlIssue(repository, parentIssue.parent),
      subIssues: readConnection("subIssues"),
      blockedBy: readConnection("blockedBy"),
      blocking: readConnection("blocking"),
    },
    transport,
  };
}

export function readNormalizedIssue(
  repo: { readonly owner: string; readonly name: string },
  issueNumber: number,
  runGh: GhRunner,
): NormalizedIssue {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("Issue number must be a positive integer.");
  }
  const endpoint = `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`;
  const issue = parseJson<JsonObject>(runGh([
    "api", "-H", ACCEPT_HEADER, "-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint,
  ]), endpoint);
  if (issue.pull_request !== undefined) {
    throw new Error(`#${issueNumber} is a pull request, not an issue.`);
  }
  const fieldValues = readRestPages(
    runGh,
    `${endpoint}/issue-field-values?per_page=100`,
  ).items;
  const relationships = readIssueRelationships(repo.owner, repo.name, issueNumber, runGh);
  return normalizeIssues([rawIssueFromApi(issue, fieldValues, relationships)])[0];
}

function parseRepo(value: string): RepoRef {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error("--repo must be OWNER/REPO.");
  return { owner: match[1], name: match[2], fullName: value };
}

type CliArgs = {
  readonly repo: RepoRef;
  readonly out: string;
  readonly fingerprintOut?: string;
} & ({
  readonly snapshotVersion: "v1";
} | {
  readonly snapshotVersion: "v2";
  readonly consideredIssueNumbers: readonly number[];
  readonly affectedIssueNumbers: readonly number[];
  readonly trustedVerificationAuthors: readonly string[];
});

function parseIssueNumberList(value: string, flag: string): number[] {
  if (value.trim() === "") return [];
  return [...new Set(value.split(",").map((entry) => {
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${flag} must be a comma-separated list of positive issue numbers.`);
    }
    return parsed;
  }))].sort((left, right) => left - right);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let repo: string | null = null;
  let out: string | null = null;
  let fingerprintOut: string | undefined;
  let snapshotVersion: "v1" | "v2" = "v1";
  let consideredIssueNumbers: number[] = [];
  let affectedIssueNumbers: number[] = [];
  const trustedVerificationAuthors: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg.startsWith("--fingerprint-out=")) {
      if (fingerprintOut !== undefined) throw new Error("Duplicate --fingerprint-out argument.");
      fingerprintOut = arg.slice("--fingerprint-out=".length);
      if (!fingerprintOut) throw new Error("--fingerprint-out must name an output path.");
    }
    else if (arg === "--snapshot-version=v2") snapshotVersion = "v2";
    else if (arg.startsWith("--considered=")) {
      consideredIssueNumbers = parseIssueNumberList(arg.slice("--considered=".length), "--considered");
    } else if (arg.startsWith("--affected=")) {
      affectedIssueNumbers = parseIssueNumberList(arg.slice("--affected=".length), "--affected");
    } else if (arg.startsWith("--trusted-verification-author=")) {
      const author = arg.slice("--trusted-verification-author=".length).trim();
      if (!author) throw new Error("--trusted-verification-author must name a GitHub login.");
      trustedVerificationAuthors.push(author);
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!repo || !out) throw new Error("Usage: npm run roadmap:preflight -- --repo=OWNER/REPO --out=PATH");
  if (snapshotVersion === "v1" && (
    consideredIssueNumbers.length > 0 || affectedIssueNumbers.length > 0 ||
    trustedVerificationAuthors.length > 0 || fingerprintOut !== undefined
  )) {
    throw new Error("V2 hydration arguments require --snapshot-version=v2.");
  }
  const parsedRepo = parseRepo(repo);
  return snapshotVersion === "v1"
    ? { repo: parsedRepo, out, snapshotVersion }
    : {
      repo: parsedRepo,
      out,
      snapshotVersion,
      fingerprintOut,
      consideredIssueNumbers,
      affectedIssueNumbers,
      trustedVerificationAuthors: [...new Set(trustedVerificationAuthors)].sort(),
    };
}

export function runGit(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function normalizeRemoteRepo(value: string): string | null {
  const match = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export function assertRepoMatchesCheckout(repo: RepoRef, originUrl: string): void {
  const originRepo = normalizeRemoteRepo(originUrl);
  if (!originRepo || originRepo.toLowerCase() !== repo.fullName.toLowerCase()) {
    throw new Error(
      `--repo ${repo.fullName} does not match this checkout's origin (${originRepo ?? "unrecognized"}).`,
    );
  }
}

function normalizeRepositories(items: readonly JsonObject[]): unknown[] {
  return items
    .map((repo) => canonicalize({
      id: repo.id ?? null,
      nodeId: repo.node_id ?? null,
      name: repo.name ?? null,
      fullName: repo.full_name ?? null,
      private: repo.private ?? null,
      archived: repo.archived ?? null,
      disabled: repo.disabled ?? null,
      fork: repo.fork ?? null,
      visibility: repo.visibility ?? null,
      defaultBranch: repo.default_branch ?? null,
    }))
    .sort((left, right) => String(asObject(left).fullName).localeCompare(String(asObject(right).fullName)));
}

function normalizeIssueFields(items: readonly JsonObject[]): unknown[] {
  return items
    .map((field) => {
      const normalized = { ...field };
      if (Array.isArray(field.options)) {
        normalized.options = [...field.options]
          .map((option, index) => ({
            ...asObject(option),
            order: asNumber(asObject(option).order) ?? index,
          }))
          .sort((left, right) => {
            const leftOrder = asNumber(asObject(left).order) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = asNumber(asObject(right).order) ?? Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder || compareJsonIdentity(left, right);
          });
      }
      return canonicalize(normalized);
    })
    .sort(compareJsonIdentity);
}

interface PriorityUsageCensus {
  readonly fieldId: string;
  readonly fieldName: "Priority";
  readonly issuesChecked: number;
  readonly repositories: readonly {
    readonly nameWithOwner: string;
    readonly openIssues: number;
    readonly closedIssues: number;
  }[];
  readonly options: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly uses: number;
  }[];
}

function identifier(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function fieldValueFieldId(value: JsonObject): string | null {
  return identifier(value.issue_field_id) ??
    identifier(value.field_id) ??
    identifier(asObject(value.field).id) ??
    identifier(asObject(value.issue_field).id);
}

function fieldValueOptionId(value: JsonObject): string | null {
  return identifier(value.single_select_option_id) ??
    identifier(value.option_id) ??
    identifier(asObject(value.single_select_option).id) ??
    identifier(asObject(value.option).id) ??
    identifier(asObject(value.value).id) ??
    identifier(value.value);
}

export function summarizePriorityUsage(
  priorityField: JsonObject,
  fieldValues: readonly unknown[],
): readonly { readonly id: string; readonly name: string | null; readonly uses: number }[] {
  const fieldId = identifier(priorityField.id);
  if (!fieldId) throw new Error("The Priority issue field is missing its stable ID.");
  const uses = new Map<string, number>();
  for (const rawValue of fieldValues) {
    const value = asObject(rawValue);
    if (fieldValueFieldId(value) !== fieldId) continue;
    const optionId = fieldValueOptionId(value);
    if (optionId) uses.set(optionId, (uses.get(optionId) ?? 0) + 1);
  }
  const options = Array.isArray(priorityField.options) ? priorityField.options : [];
  return options.map((rawOption) => {
    const option = asObject(rawOption);
    const id = identifier(option.id);
    if (!id) throw new Error("A Priority option is missing its stable ID.");
    return { id, name: asString(option.name), uses: uses.get(id) ?? 0 };
  });
}

function collectPriorityUsageCensus(
  repositoryRows: readonly JsonObject[],
  issueFieldRows: readonly JsonObject[],
  runGh: GhRunner,
): { readonly census: PriorityUsageCensus; readonly fieldValuesByIssue: ReadonlyMap<string, readonly unknown[]> } {
  const priorityField = issueFieldRows.find((field) => asString(field.name) === "Priority");
  if (!priorityField) throw new Error("Organization issue field Priority was not found.");
  const fieldId = identifier(priorityField.id);
  if (!fieldId) throw new Error("The Priority issue field is missing its stable ID.");
  const fieldValuesByIssue = new Map<string, readonly unknown[]>();
  const allFieldValues: unknown[] = [];
  const repositories: Array<{ nameWithOwner: string; openIssues: number; closedIssues: number }> = [];
  for (const repository of repositoryRows) {
    const fullName = asString(repository.full_name);
    if (!fullName) throw new Error("GitHub returned an organization repository without full_name.");
    const issuePages = readRestPages(runGh, `/repos/${fullName}/issues?state=all&per_page=100`);
    let openIssues = 0;
    let closedIssues = 0;
    for (const issue of issuePages.items.filter((item) => item.pull_request === undefined)) {
      const number = asNumber(issue.number);
      const state = asString(issue.state)?.toLowerCase();
      if (number === null || (state !== "open" && state !== "closed")) {
        throw new Error(`GitHub returned an issue in ${fullName} without a valid number or state.`);
      }
      if (state === "open") openIssues += 1;
      else closedIssues += 1;
      const values = readRestPages(
        runGh,
        `/repos/${fullName}/issues/${number}/issue-field-values?per_page=100`,
      ).items;
      fieldValuesByIssue.set(`${fullName}#${number}`, values);
      allFieldValues.push(...values);
    }
    repositories.push({ nameWithOwner: fullName, openIssues, closedIssues });
  }
  return {
    census: {
      fieldId,
      fieldName: "Priority",
      issuesChecked: repositories.reduce(
        (sum, repository) => sum + repository.openIssues + repository.closedIssues,
        0,
      ),
      repositories,
      options: summarizePriorityUsage(priorityField, allFieldValues),
    },
    fieldValuesByIssue,
  };
}

function rawIssueFromApi(
  issue: JsonObject,
  fieldValues: readonly unknown[],
  relationships: RelationshipSnapshot,
): RawIssue {
  const number = asNumber(issue.number);
  const title = asString(issue.title);
  const state = asString(issue.state);
  const createdAt = asString(issue.created_at);
  const updatedAt = asString(issue.updated_at);
  if (number === null || title === null || state === null || createdAt === null || updatedAt === null) {
    throw new Error("GitHub returned an open issue missing required preservation fields.");
  }
  return {
    number,
    title,
    state,
    state_reason: asString(issue.state_reason),
    body: asString(issue.body),
    created_at: createdAt,
    updated_at: updatedAt,
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
    milestone: issue.milestone ?? null,
    type: issue.type ?? null,
    fieldValues,
    relationships,
  };
}

function repositoryFullNameFromApiUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(value);
  return match?.[1] ?? null;
}

export function projectMembershipsForIssue(
  projects: ProjectInspection,
  repository: RepositoryIdentityV2,
  issueNumber: number,
): ProjectMembershipV2[] {
  return [...(indexProjectMembershipsForIssues(
    projects,
    repository,
    new Set([issueNumber]),
  ).get(issueNumber) ?? [])];
}

function indexProjectMembershipsForIssues(
  projects: ProjectInspection,
  repository: RepositoryIdentityV2,
  issueNumbers: ReadonlySet<number>,
): ReadonlyMap<number, readonly ProjectMembershipV2[]> {
  if (projects.status !== "ok") {
    throw new Error("Canonical snapshot v2 requires readable Project membership; read:project is missing.");
  }
  const expectedFullName = `${repository.organization}/${repository.name}`;
  const memberships = new Map<number, ProjectMembershipV2[]>();
  for (const rawProject of projects.items) {
    const project = asObject(rawProject);
    const projectNodeId = asString(project.id);
    const projectNumber = asNumber(project.number);
    if (!projectNodeId || projectNumber === null) {
      throw new Error("GitHub returned a Project without resource-qualified identity.");
    }
    const itemNodes = asObject(project.items).nodes;
    for (const rawItem of Array.isArray(itemNodes) ? itemNodes : []) {
      const item = asObject(rawItem);
      const content = asObject(item.content);
      const issueNumber = asNumber(content.number);
      if (issueNumber === null || !issueNumbers.has(issueNumber)) continue;
      const actualFullName = asString(asObject(content.repository).nameWithOwner);
      if (actualFullName?.toLowerCase() !== expectedFullName.toLowerCase()) {
        throw new Error(
          `Project item resource mismatch for issue #${issueNumber}: expected ${expectedFullName}, received ${actualFullName ?? "unknown"}.`,
        );
      }
      const itemNodeId = asString(item.id);
      if (!itemNodeId) throw new Error(`Project item for issue #${issueNumber} has no node ID.`);
      const issueMemberships = memberships.get(issueNumber) ?? [];
      issueMemberships.push({
        project: {
          organization: repository.organization,
          number: projectNumber,
          nodeId: projectNodeId as ProjectMembershipV2["project"]["nodeId"],
        },
        itemNodeId: itemNodeId as ProjectMembershipV2["itemNodeId"],
      });
      memberships.set(issueNumber, issueMemberships);
    }
  }
  return memberships;
}

export function closingReferenceMatches(
  body: string | null,
  repository: RepositoryIdentityV2,
  issueNumber: number,
): boolean {
  if (!body) return false;
  const escapedOwner = repository.organization.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRepo = repository.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = `(?:${escapedOwner}/${escapedRepo})?#${issueNumber}\\b`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+${reference}`, "i").test(body);
}

export function linkedPullRequestSources(timeline: readonly JsonObject[]): readonly {
  readonly repositoryFullName: string;
  readonly number: number;
}[] {
  const unique = new Map<string, { repositoryFullName: string; number: number }>();
  for (const event of timeline) {
    const sourceIssue = asObject(asObject(event.source).issue);
    if (sourceIssue.pull_request === undefined) continue;
    const repositoryFullName = repositoryFullNameFromApiUrl(sourceIssue.repository_url);
    const number = asNumber(sourceIssue.number);
    if (!repositoryFullName || number === null) continue;
    unique.set(`${repositoryFullName.toLowerCase()}#${number}`, { repositoryFullName, number });
  }
  return [...unique.values()].sort((left, right) =>
    left.repositoryFullName.localeCompare(right.repositoryFullName) || left.number - right.number);
}

function readPullRequestEvidenceV2(
  repository: RepositoryIdentityV2,
  issueNumber: number,
  timeline: readonly JsonObject[],
  runGh: GhRunner,
  fetchedAt: string,
): MetadataResult<readonly PullRequestEvidenceV2[]> {
  const evidence: PullRequestEvidenceV2[] = [];
  const transport: TransportMetadataV2[] = [];
  for (const source of linkedPullRequestSources(timeline)) {
    const endpoint = `/repos/${source.repositoryFullName}/pulls/${source.number}`;
    const result = readRestResourceWithMetadata(runGh, endpoint, fetchedAt);
    transport.push(...result.transport);
    const pull = result.value;
    const sourceRepo = asObject(asObject(pull.base).repo);
    const sourceRepoRef = parseRepo(source.repositoryFullName);
    const sourceIdentity = qualifyRepositoryIdentity({
      organization: sourceRepoRef.owner,
      name: sourceRepoRef.name,
      databaseId: sourceRepo.id,
      nodeId: sourceRepo.node_id,
    });
    const identity = qualifyIssueIdentity(sourceIdentity, {
      number: pull.number,
      databaseId: pull.id,
      nodeId: pull.node_id,
      repositoryFullName: asString(sourceRepo.full_name) ?? source.repositoryFullName,
    });
    const state = asString(pull.state)?.toUpperCase();
    if (state !== "OPEN" && state !== "CLOSED") {
      throw new Error(`Linked pull request ${source.repositoryFullName}#${source.number} has invalid state.`);
    }
    const headSha = asString(asObject(pull.head).sha);
    evidence.push({
      identity,
      relationship: closingReferenceMatches(asString(pull.body), repository, issueNumber)
        ? "closing"
        : "linked",
      state,
      mergedAt: asString(pull.merged_at),
      headSha: headSha && /^[0-9a-f]{40}$/i.test(headSha)
        ? headSha.toLowerCase() as PullRequestEvidenceV2["headSha"]
        : null,
      url: asString(pull.html_url) ?? `https://github.com/${source.repositoryFullName}/pull/${source.number}`,
    });
  }
  return { value: evidence, transport };
}

export interface PreflightSnapshotV1 extends JsonObject {
  readonly schemaVersion: "github-issue-roadmap-preflight/v1";
  readonly generatedAt: string;
  readonly capture: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly verifiedStableByDoubleRead: true;
  };
  readonly repo: string;
  readonly git: { readonly headSha: string; readonly originMainSha: string };
  readonly auth: { readonly oauthScopes: readonly string[]; readonly oauthScopesHeaderPresent: boolean };
  readonly organization: {
    readonly login: string;
    readonly repositories: { readonly totalCount: number; readonly items: readonly unknown[] };
    readonly issueFields: { readonly totalCount: number; readonly definitions: readonly unknown[] };
    readonly priorityUsageCensus: PriorityUsageCensus;
  };
  readonly projects: ProjectInspection;
  readonly issues: {
    readonly totalCount: number;
    readonly relationshipSchemaSupport: Record<keyof RelationshipSnapshot, boolean>;
    readonly items: readonly NormalizedIssueV1[];
  };
  readonly manifest: {
    readonly counts: {
      readonly repositories: number;
      readonly issueFields: number;
      readonly projects: number | null;
      readonly openIssues: number;
    };
    readonly reconciliation: CountReconciliation;
  };
}

function repositoryIdentityFromRows(
  rows: readonly unknown[],
  repo: RepoRef,
): RepositoryIdentityV2 {
  const row = rows.map(asObject)
    .find((repository) => asString(repository.fullName)?.toLowerCase() === repo.fullName.toLowerCase());
  if (!row) throw new Error(`Stable census is missing repository identity for ${repo.fullName}.`);
  return qualifyRepositoryIdentity({
    organization: repo.owner,
    name: repo.name,
    databaseId: row.id,
    nodeId: row.nodeId,
  });
}

function nativeTypeV2(issue: JsonObject, repository: RepositoryIdentityV2): IssueSnapshotV2["nativeType"] {
  if (issue.type === null || issue.type === undefined) return null;
  const type = asObject(issue.type);
  const id = asNumber(type.id);
  const name = asString(type.name);
  if (id === null || !name) throw new Error(`Issue #${String(issue.number)} has incomplete native Type identity.`);
  return {
    organization: repository.organization,
    databaseId: id as NonNullable<IssueSnapshotV2["nativeType"]>["databaseId"],
    nodeId: asString(type.node_id) as NonNullable<IssueSnapshotV2["nativeType"]>["nodeId"],
    name,
  };
}

export function hydrateIssueSnapshotV2(options: {
  readonly repository: RepositoryIdentityV2;
  readonly issueNumber: number;
  readonly projectMemberships: readonly ProjectMembershipV2[];
  readonly trustedVerificationAuthors: readonly string[];
  readonly generatedAt: string;
  readonly originMainSha: string;
  readonly runGh: GhRunner;
}): IssueSnapshotV2 {
  const endpoint = `/repos/${options.repository.organization}/${options.repository.name}/issues/${options.issueNumber}`;
  const issueResult = readRestResourceWithMetadata(options.runGh, endpoint, options.generatedAt);
  const issue = issueResult.value;
  if (issue.pull_request !== undefined) throw new Error(`#${options.issueNumber} is a pull request, not an issue.`);
  const fieldResult = readRestPagesWithMetadata(
    options.runGh,
    `${endpoint}/issue-field-values?per_page=100`,
    options.generatedAt,
  );
  const identity = qualifyIssueIdentity(options.repository, {
    number: issue.number,
    databaseId: issue.id,
    nodeId: issue.node_id,
    repositoryFullName: repositoryFullNameFromApiUrl(issue.repository_url),
  });
  const commentsResult = readRestPagesWithMetadata(
    options.runGh,
    `${endpoint}/comments?per_page=100`,
    options.generatedAt,
  );
  const timelineResult = readRestPagesWithMetadata(
    options.runGh,
    `${endpoint}/timeline?per_page=100`,
    options.generatedAt,
  );
  const relationshipResult = readQualifiedRelationshipsV2(
    options.repository,
    options.issueNumber,
    options.runGh,
    options.generatedAt,
  );
  const v1 = normalizeIssues([rawIssueFromApi(issue, fieldResult.value, {
    parent: relationshipResult.value.parent?.number ?? null,
    subIssues: relationshipResult.value.subIssues.map((entry) => entry.number),
    blockedBy: relationshipResult.value.blockedBy.filter((entry) => entry.repository.nodeId === options.repository.nodeId).map((entry) => entry.number),
    blocking: relationshipResult.value.blocking.map((entry) => entry.number),
  })])[0];
  const pullResult = readPullRequestEvidenceV2(
    options.repository,
    options.issueNumber,
    timelineResult.value,
    options.runGh,
    options.generatedAt,
  );
  const verifications = parsePersistedVerificationRecords({
    trustedAuthors: options.trustedVerificationAuthors,
    body: asString(issue.body),
    issueAuthor: asString(asObject(issue.user).login),
    issueCreatedAt: asString(issue.created_at) ?? v1.createdAt,
    issueUpdatedAt: asString(issue.updated_at) ?? v1.updatedAt,
    comments: commentsResult.value,
  });
  return normalizeIssueSnapshotV2({
    schemaVersion: ISSUE_SNAPSHOT_SCHEMA,
    identity,
    v1,
    nativeType: nativeTypeV2(issue, options.repository),
    relationships: relationshipResult.value,
    projectMemberships: options.projectMemberships,
    persistedVerifications: verifications,
    pullRequests: pullResult.value,
    freshness: verificationFreshness(verifications, options.generatedAt, options.originMainSha),
    transport: [
      ...issueResult.transport,
      ...fieldResult.transport,
      ...commentsResult.transport,
      ...timelineResult.transport,
      ...relationshipResult.transport,
      ...pullResult.transport,
    ],
  });
}

function stableHydrationValue(issue: IssueSnapshotV2): unknown {
  return canonicalize({ ...issue, transport: [] });
}

export function assertStableV2Hydration(
  before: readonly IssueSnapshotV2[],
  after: readonly IssueSnapshotV2[],
): void {
  if (JSON.stringify(before.map(stableHydrationValue)) === JSON.stringify(after.map(stableHydrationValue))) return;
  throw new Error("GitHub issue hydration changed during canonical v2 capture; refusing a mixed-version snapshot.");
}

export function openIssueNumbersFromRows(rows: readonly JsonObject[]): number[] {
  return rows
    .filter((row) => row.pull_request === undefined)
    .map((row) => {
      const number = asNumber(row.number);
      if (number === null) throw new Error("GitHub returned an open issue without a number in v2 census.");
      return number;
    })
    .sort((left, right) => left - right);
}

export interface V2OpenCensusPass {
  readonly fingerprint?: BoardFingerprint;
  readonly issueRows: readonly JsonObject[];
  readonly issueNumbers: readonly number[];
  readonly nowIssueNumbers: readonly number[];
  readonly excludedPullRequestCount: number;
  readonly transport: readonly TransportMetadataV2[];
}

function stableOpenCensusValue(pass: V2OpenCensusPass): unknown {
  const rowsByNumber = new Map(pass.issueRows.map((row) => [asNumber(row.number), row]));
  const nowIssueNumbers = new Set(pass.nowIssueNumbers);
  return { fingerprint: pass.fingerprint?.issues, issues: pass.issueNumbers.map((number) => {
    const row = rowsByNumber.get(number) ?? {};
    return canonicalize({
      number,
      databaseId: row.id ?? null,
      nodeId: row.node_id ?? null,
      repositoryFullName: repositoryFullNameFromApiUrl(row.repository_url),
      state: asString(row.state)?.toUpperCase() ?? null,
      now: nowIssueNumbers.has(number),
    });
  }) };
}

function captureV2OpenCensus(
  repo: RepoRef,
  runGh: GhRunner,
  fetchedAt: string,
): V2OpenCensusPass & { readonly fingerprint: BoardFingerprint } {
  const result = readBoardFingerprint({ repo, runGh, fetchedAt, readGraphql: readGraphqlWithMetadata });
  const issueRows = Object.values(result.fingerprint.issues).map(issue => ({
    number: issue.number, id: issue.databaseId, node_id: issue.nodeId, state: issue.state,
    repository_url: `https://api.github.com/repos/${issue.repositoryFullName}`,
  }));
  const issueNumbers = openIssueNumbersFromRows(issueRows);
  return {
    fingerprint: result.fingerprint,
    issueRows,
    issueNumbers,
    nowIssueNumbers: result.nowIssueNumbers,
    // GraphQL's issues connection excludes pull requests by construction.
    excludedPullRequestCount: 0,
    transport: result.transport,
  };
}

export function assertStableV2OpenCensus(before: V2OpenCensusPass, after: V2OpenCensusPass): void {
  if (JSON.stringify(stableOpenCensusValue(before)) === JSON.stringify(stableOpenCensusValue(after))) return;
  throw new Error("GitHub open issue identities or Horizon values drifted during canonical v2 census; census changed during collection.");
}

function completeProjectItemsWithMetadata(
  rawProject: JsonObject,
  runGh: GhRunner,
  fetchedAt: string,
): MetadataResult<JsonObject> {
  const projectId = asString(rawProject.id);
  if (!projectId) throw new Error("GitHub returned a Project without an ID.");
  const initial = asObject(rawProject.items);
  const totalCount = asNumber(initial.totalCount) ?? 0;
  const nodes = Array.isArray(initial.nodes) ? [...initial.nodes] : [];
  const initialPageInfo = asObject(initial.pageInfo);
  let cursor = nextPageCursor(initialPageInfo, `items for Project #${String(rawProject.number)}`);
  let page = 2;
  const transport: TransportMetadataV2[] = [];
  while (cursor) {
    const result = readGraphqlWithMetadata(
      runGh,
      PROJECT_ITEMS_QUERY,
      ["-F", `id=${projectId}`, "-F", `cursor=${cursor}`],
      `items for Project #${String(rawProject.number)}`,
      fetchedAt,
      page,
    );
    transport.push(...result.transport);
    const connection = asObject(asObject(asObject(result.value.data).node).items);
    if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes);
    const pageInfo = asObject(connection.pageInfo);
    cursor = nextPageCursor(pageInfo, `items for Project #${String(rawProject.number)}`);
    page += 1;
  }
  if (nodes.length !== totalCount) {
    throw new Error(`Project #${String(rawProject.number)} has ${totalCount} items, but only ${nodes.length} identities were returned.`);
  }
  return {
    value: {
      ...rawProject,
      items: { totalCount, nodes: nodes.map(canonicalize).sort(compareJsonIdentity) },
    },
    transport,
  };
}

function inspectProjectsWithMetadata(
  organization: string,
  runGh: GhRunner,
  fetchedAt: string,
): MetadataResult<ProjectInspectionOk> {
  const items: unknown[] = [];
  const transport: TransportMetadataV2[] = [];
  let cursor: string | null = null;
  let totalCount = 0;
  let page = 1;
  do {
    const variables = ["-F", `login=${organization}`];
    if (cursor) variables.push("-F", `cursor=${cursor}`);
    const result = readGraphqlWithMetadata(
      runGh, PROJECT_MEMBERSHIPS_QUERY, variables, "organization Project memberships v2", fetchedAt, page,
    );
    transport.push(...result.transport);
    const connection = asObject(asObject(asObject(result.value.data).organization).projectsV2);
    totalCount = asNumber(connection.totalCount) ?? 0;
    for (const rawNode of Array.isArray(connection.nodes) ? connection.nodes : []) {
      const completed = completeProjectItemsWithMetadata(asObject(rawNode), runGh, fetchedAt);
      transport.push(...completed.transport);
      items.push(canonicalize(completed.value));
    }
    const pageInfo = asObject(connection.pageInfo);
    cursor = nextPageCursor(pageInfo, `projectsV2 for organization ${organization}`);
    page += 1;
  } while (cursor);
  return { value: { status: "ok", totalCount, items: items.sort(compareJsonIdentity) }, transport };
}

export function collectPreflightSnapshot(options: {
  readonly repo: RepoRef;
  readonly generatedAt?: string;
  readonly runGh?: GhRunner;
}): PreflightSnapshotV1 {
  const { owner, name } = options.repo;
  const runGh = options.runGh ?? createGhRunner();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const captureStartedAt = new Date().toISOString();
  const auth = readAuth(runGh);
  const orgMetadata = parseJson<JsonObject>(runGh([
    "api", "-H", ACCEPT_HEADER, "-H", `X-GitHub-Api-Version: ${API_VERSION}`, `/orgs/${owner}`,
  ]), "organization metadata");
  const repositoryPages = readRestPages(runGh, `/orgs/${owner}/repos?type=all&per_page=100`);
  const issueFieldPages = readRestPages(runGh, `/orgs/${owner}/issue-fields?per_page=100`);
  const priorityUsage = collectPriorityUsageCensus(
    repositoryPages.items,
    issueFieldPages.items,
    runGh,
  );
  const projects = inspectProjects(owner, runGh);
  const relationships = collectRelationships(owner, name, runGh);
  const issuePages = readRestPages(runGh, `/repos/${owner}/${name}/issues?state=open&per_page=100`);
  const issueRows = issuePages.items.filter((item) => item.pull_request === undefined);
  const issueNumbers = issueRows.map((issue) => {
    const number = asNumber(issue.number);
    if (number === null) throw new Error("GitHub returned an open issue without a number.");
    return number;
  });
  assertIssueNumberReconciliation(issueNumbers, [...relationships.byIssue.keys()]);
  const rawIssues: RawIssue[] = [];
  for (const issue of issueRows) {
    const number = asNumber(issue.number);
    if (number === null) throw new Error("GitHub issue number changed during normalization.");
    const fieldValues = priorityUsage.fieldValuesByIssue.get(`${options.repo.fullName}#${number}`);
    if (!fieldValues) {
      throw new Error(`Priority census is missing field values for open issue #${number}.`);
    }
    const issueRelationships = relationships.byIssue.get(number);
    if (!issueRelationships) {
      throw new Error(`GitHub relationship snapshot is missing open issue #${number}.`);
    }
    rawIssues.push(rawIssueFromApi(issue, fieldValues, issueRelationships));
  }
  const issues = normalizeIssues(rawIssues);
  const verificationRelationships = collectRelationships(owner, name, runGh);
  const verificationIssuePages = readRestPages(
    runGh,
    `/repos/${owner}/${name}/issues?state=open&per_page=100`,
  );
  const verificationRows = verificationIssuePages.items
    .filter((item) => item.pull_request === undefined);
  const verificationNumbers = verificationRows.map((issue) => {
    const number = asNumber(issue.number);
    if (number === null) throw new Error("GitHub returned an open issue without a number during verification.");
    return number;
  });
  assertIssueNumberReconciliation(
    verificationNumbers,
    [...verificationRelationships.byIssue.keys()],
  );
  const verificationRawIssues: RawIssue[] = [];
  for (const issue of verificationRows) {
    const number = asNumber(issue.number);
    if (number === null) throw new Error("GitHub issue number changed during verification.");
    const fieldValues = readRestPages(
      runGh,
      `/repos/${owner}/${name}/issues/${number}/issue-field-values?per_page=100`,
    ).items;
    const issueRelationships = verificationRelationships.byIssue.get(number);
    if (!issueRelationships) {
      throw new Error(`Verification relationship snapshot is missing open issue #${number}.`);
    }
    verificationRawIssues.push(rawIssueFromApi(issue, fieldValues, issueRelationships));
  }
  assertStableIssueCapture(issues, normalizeIssues(verificationRawIssues));
  const repositories = normalizeRepositories(repositoryPages.items);
  const issueFields = normalizeIssueFields(issueFieldPages.items);
  const orgReportedRepoCount =
    (asNumber(orgMetadata.public_repos) ?? 0) + (asNumber(orgMetadata.total_private_repos) ?? 0);
  const projectCounts = projects.status === "ok"
    ? { expected: projects.totalCount, actual: projects.items.length }
    : { expected: null, actual: null };
  const reconciliation = reconcileCounts({
    repositories: { expected: orgReportedRepoCount, actual: repositories.length },
    issueFields: { expected: issueFieldPages.totalCount, actual: issueFields.length },
    projects: projectCounts,
    openIssues: { expected: relationships.totalCount, actual: issues.length },
  });
  assertCountReconciliation(reconciliation);
  return {
    schemaVersion: "github-issue-roadmap-preflight/v1",
    generatedAt,
    capture: {
      startedAt: captureStartedAt,
      completedAt: new Date().toISOString(),
      verifiedStableByDoubleRead: true,
    },
    repo: options.repo.fullName,
    git: {
      headSha: runGit(["rev-parse", "HEAD"]),
      originMainSha: runGit(["rev-parse", "origin/main"]),
    },
    auth,
    organization: {
      login: owner,
      repositories: { totalCount: repositoryPages.totalCount, items: repositories },
      issueFields: { totalCount: issueFieldPages.totalCount, definitions: issueFields },
      priorityUsageCensus: priorityUsage.census,
    },
    projects,
    issues: {
      totalCount: relationships.totalCount,
      relationshipSchemaSupport: relationships.support,
      items: issues,
    },
    manifest: {
      counts: {
        repositories: repositories.length,
        issueFields: issueFields.length,
        projects: projects.status === "ok" ? projects.items.length : null,
        openIssues: issues.length,
      },
      reconciliation,
    },
  };
}

export function collectCanonicalSnapshotV2(options: {
  readonly repo: RepoRef;
  readonly consideredIssueNumbers: readonly number[];
  readonly affectedIssueNumbers?: readonly number[];
  readonly trustedVerificationAuthors: readonly string[];
  readonly generatedAt?: string;
  readonly remoteFetchMaximumAgeMs?: number;
  readonly runGh?: GhRunner;
  readonly onFingerprint?: (fingerprint: BoardFingerprint) => void;
}): CanonicalSnapshotV2 {
  const runGh = options.runGh ?? createGhRunner();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const repositoryCountResult = readGraphqlWithMetadata(
    runGh,
    V2_REPOSITORY_COUNT_QUERY,
    ["-F", `login=${options.repo.owner}`],
    "organization repository count v2",
    generatedAt,
  );
  const repositoryResult = readRestPagesWithMetadata(
    runGh, `/orgs/${options.repo.owner}/repos?type=all&per_page=100`, generatedAt,
  );
  const issueFieldResult = readRestPagesWithMetadata(
    runGh, `/orgs/${options.repo.owner}/issue-fields?per_page=100`, generatedAt,
  );
  const firstProjectResult = inspectProjectsWithMetadata(options.repo.owner, runGh, generatedAt);
  const firstCensus = captureV2OpenCensus(options.repo, runGh, generatedAt);
  const secondCensus = captureV2OpenCensus(options.repo, runGh, generatedAt);
  assertStableV2OpenCensus(firstCensus, secondCensus);
  const repositories = normalizeRepositories(repositoryResult.value);
  const issueFields = normalizeIssueFields(issueFieldResult.value);
  const repository = repositoryIdentityFromRows(repositories, options.repo);
  const orgReportedRepoCount = asNumber(asObject(asObject(
    asObject(repositoryCountResult.value.data).organization,
  ).repositories).totalCount);
  if (orgReportedRepoCount === null) {
    throw new Error("GitHub did not return the organization repository total count.");
  }
  const reconciliation = reconcileCounts({
    repositories: { expected: orgReportedRepoCount, actual: repositories.length },
    issueFields: { expected: issueFieldResult.value.length, actual: issueFields.length },
    projects: {
      expected: firstProjectResult.value.totalCount,
      actual: firstProjectResult.value.items.length,
    },
    openIssues: { expected: firstCensus.issueNumbers.length, actual: secondCensus.issueNumbers.length },
  });
  assertCountReconciliation(reconciliation);
  const firstNumbers = firstCensus.issueNumbers;
  const nowIssueNumbers = firstCensus.nowIssueNumbers;
  const remoteMain = readRestResourceWithMetadata(
    runGh,
    `/repos/${options.repo.fullName}/commits/main`,
    generatedAt,
  );
  const remoteMainSha = asString(remoteMain.value.sha);
  if (!remoteMainSha) throw new Error("GitHub did not return the current main SHA.");
  const remoteFetchedAt = remoteMain.transport[0]?.fetchedAt ?? generatedAt;
  const graphqlCapabilities = readGraphqlCapabilityProofV2(runGh, generatedAt);
  const strategyIdentity = readRemoteSourceIdentityV2(
    runGh, options.repo, "STRATEGY.md", remoteMainSha, generatedAt,
  );
  const rubricIdentity = readRemoteSourceIdentityV2(
    runGh, options.repo, "docs/runbooks/github-issue-roadmap.md", remoteMainSha, generatedAt,
  );
  const consideredIssueNumbers = [...new Set([
    ...nowIssueNumbers,
    ...options.consideredIssueNumbers,
  ])].sort((left, right) => left - right);
  const required = [...new Set([
    ...consideredIssueNumbers,
    ...(options.affectedIssueNumbers ?? []),
  ])].sort((left, right) => left - right);
  const censusSet = new Set(firstNumbers);
  const outsideCensus = required.filter((number) => !censusSet.has(number));
  if (outsideCensus.length > 0) {
    throw new Error(`Canonical snapshot requested issues outside the stable census: [${outsideCensus.join(", ")}].`);
  }
  const firstProjectMemberships = indexProjectMembershipsForIssues(
    firstProjectResult.value,
    repository,
    new Set(required),
  );
  const hydrate = (
    projectMemberships: ReadonlyMap<number, readonly ProjectMembershipV2[]>,
  ): IssueSnapshotV2[] => required.map((issueNumber) => hydrateIssueSnapshotV2({
    repository,
    issueNumber,
    projectMemberships: projectMemberships.get(issueNumber) ?? [],
    trustedVerificationAuthors: options.trustedVerificationAuthors,
    generatedAt,
    originMainSha: remoteMainSha,
    runGh,
  }));
  const firstHydration = hydrate(firstProjectMemberships);
  const secondProjectResult = inspectProjectsWithMetadata(options.repo.owner, runGh, generatedAt);
  if (secondProjectResult.value.totalCount !== firstProjectResult.value.totalCount ||
      secondProjectResult.value.items.length !== firstProjectResult.value.items.length) {
    throw new Error("GitHub Project census changed during canonical v2 capture; refusing a mixed-version snapshot.");
  }
  const secondProjectMemberships = indexProjectMembershipsForIssues(
    secondProjectResult.value,
    repository,
    new Set(required),
  );
  const secondHydration = hydrate(secondProjectMemberships);
  assertStableV2Hydration(firstHydration, secondHydration);
  for (const issue of secondHydration) {
    const expectedNow = nowIssueNumbers.includes(issue.identity.number);
    const actualNow = issue.v1.fieldValues.map(issueFieldValueIdentity)
      .some((entry) => entry.name === "Horizon" && entry.value === "Now");
    if (expectedNow !== actualNow) {
      throw new Error(`Issue #${issue.identity.number} Horizon drifted after the stable v2 census.`);
    }
  }
  const snapshotGeneratedAt = options.generatedAt ?? new Date().toISOString();
  const snapshot = buildCanonicalSnapshotV2({
    generatedAt: snapshotGeneratedAt,
    repository,
    restVersion: API_VERSION,
    graphqlCapabilityProof: graphqlCapabilities.value,
    sourceIdentities: {
      strategy: strategyIdentity.value,
      rubric: rubricIdentity.value,
    },
    organizationIssueFields: { totalCount: issueFieldResult.value.length, definitions: issueFields },
    reconciliation: {
      counts: {
        repositories: repositories.length,
        issueFields: issueFields.length,
        projects: secondProjectResult.value.items.length,
        openIssues: firstNumbers.length,
      },
      allMatch: true,
      allVerified: true,
    },
    originMainSha: remoteMainSha,
    originMainFetchedAt: remoteFetchedAt,
    remoteFetchMaximumAgeMs: options.remoteFetchMaximumAgeMs ?? 5 * 60 * 1_000,
    census: {
      totalCount: firstNumbers.length,
      issueNumbers: firstNumbers,
      nowIssueNumbers,
      excludedPullRequestCount: firstCensus.excludedPullRequestCount,
      verifiedStableByDoubleRead: true,
      countReconciled: true,
    },
    consideredIssueNumbers,
    affectedIssueNumbers: options.affectedIssueNumbers,
    issues: secondHydration,
    transport: [
      ...repositoryCountResult.transport,
      ...repositoryResult.transport,
      ...issueFieldResult.transport,
      ...firstProjectResult.transport,
      ...firstCensus.transport,
      ...secondCensus.transport,
      ...remoteMain.transport,
      ...graphqlCapabilities.transport,
      ...strategyIdentity.transport,
      ...rubricIdentity.transport,
      ...firstHydration.flatMap((issue) => issue.transport),
      ...secondProjectResult.transport,
      ...secondHydration.flatMap((issue) => issue.transport),
    ],
  });
  options.onFingerprint?.(secondCensus.fingerprint);
  return snapshot;
}

export function collectScheduledCanonicalSnapshotV2(
  options: Omit<Parameters<typeof collectCanonicalSnapshotV2>[0], "runGh">,
  captureOptions: ScheduledCaptureOptions = {},
): CanonicalSnapshotV2 {
  const session = createScheduledCaptureSession(captureOptions);
  try {
    return collectCanonicalSnapshotV2({ ...options, runGh: session.runGh });
  } finally {
    session.dispose();
  }
}

export function runPreflightCli(argv: readonly string[], runGh?: GhRunner): void {
  const scheduledFlags = argv.filter((argument) => argument === "--scheduled");
  if (scheduledFlags.length > 1) throw new Error("Duplicate --scheduled argument.");
  const scheduled = scheduledFlags.length === 1;
  const args = parseCliArgs(argv.filter((argument) => argument !== "--scheduled"));
  if (scheduled && args.snapshotVersion !== "v2") {
    throw new Error("Scheduled canonical capture requires --snapshot-version=v2.");
  }
  const repoRoot = runGit(["rev-parse", "--show-toplevel"]);
  assertRepoMatchesCheckout(args.repo, runGit(["remote", "get-url", "origin"]));
  const outputPath = assertOutputPathInsideRepo(args.out, repoRoot);
  const fingerprintPath = args.fingerprintOut === undefined ? undefined : assertOutputPathInsideRepo(args.fingerprintOut, repoRoot);
  assertDistinctRoadmapArtifactPaths([
    { label: "--out", path: outputPath },
    ...(fingerprintPath === undefined ? [] : [{ label: "--fingerprint-out", path: fingerprintPath }]),
  ], repoRoot);
  let fingerprint: BoardFingerprint | undefined;
  const contents = args.snapshotVersion === "v2"
    ? canonicalSnapshotV2Json((scheduled
      ? collectScheduledCanonicalSnapshotV2
      : collectCanonicalSnapshotV2)({
        repo: args.repo,
        consideredIssueNumbers: args.consideredIssueNumbers,
        affectedIssueNumbers: args.affectedIssueNumbers,
        trustedVerificationAuthors: args.trustedVerificationAuthors,
        onFingerprint: value => { fingerprint = value; },
        ...(scheduled ? {} : { runGh }),
      }))
    : `${JSON.stringify(collectPreflightSnapshot({ repo: args.repo }), null, 2)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeSnapshotAtomically(outputPath, contents);
  if (fingerprintPath !== undefined) {
    mkdirSync(dirname(fingerprintPath), { recursive: true });
    writeSnapshotAtomically(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
  }
  console.log(`Wrote read-only GitHub roadmap preflight snapshot to ${relative(repoRoot, outputPath)}.`);
}

export function writeSnapshotAtomically(outputPath: string, contents: string): void {
  writeRoadmapArtifactAtomically(outputPath, contents);
}

function isMainEntry(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && resolve(entry) === resolve(fileURLToPath(import.meta.url)));
}

if (isMainEntry()) {
  try {
    runPreflightCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
