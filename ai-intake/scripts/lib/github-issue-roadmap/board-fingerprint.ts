import { canonicalJsonSha256, canonicalizeJson } from "./canonical-json";
import type { GhRunner, JsonObject } from "./read-only-github-reader";
import type { TransportMetadataV2 } from "./snapshot-v2";
import { issueFieldValueIdentity } from "./issue-field-value";

export interface TypedIssueFieldValue {
  readonly name: string;
  readonly kind: "single_select" | "text" | "number" | "date" | "multi_select";
  readonly value: string | number | readonly string[];
}

export interface BoardIssueFingerprint {
  readonly number: number;
  readonly databaseId: number;
  readonly nodeId: string;
  readonly repositoryFullName: string;
  readonly state: "OPEN";
  readonly updatedAt: string;
  readonly fieldValues: readonly TypedIssueFieldValue[];
}

/** Auxiliary capture evidence; deliberately outside the canonical snapshot schema. */
export interface BoardFingerprint {
  readonly repositoryFullName: string;
  readonly issues: Readonly<Record<string, BoardIssueFingerprint>>;
  readonly digest: string;
}

type ReadGraphql = (runGh: GhRunner, query: string, variables: readonly string[], context: string,
  fetchedAt: string, page?: number | null) => { value: JsonObject; transport: readonly TransportMetadataV2[] };

function refuse(detail: string): never {
  throw new Error(`GitHub board census changed during collection; ${detail}.`);
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("invalid fingerprint object");
  return value as JsonObject;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) return refuse("missing fingerprint identity");
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return refuse("invalid issue identity");
  return value as number;
}

function sortedFields(values: readonly TypedIssueFieldValue[]): TypedIssueFieldValue[] {
  return [...values].sort((left, right) => {
    const a = JSON.stringify(canonicalizeJson(left));
    const b = JSON.stringify(canonicalizeJson(right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function typedField(name: unknown, kind: unknown, value: unknown): TypedIssueFieldValue {
  const fieldName = text(name);
  if (kind === "number" && typeof value === "number" && Number.isFinite(value)) return { name: fieldName, kind, value };
  // GraphQL exposes a multi-select value as one scalar string; only GraphQL reads are compared for it.
  if ((kind === "text" || kind === "date" || kind === "single_select" || kind === "multi_select") && typeof value === "string") {
    return { name: fieldName, kind, value };
  }
  if (kind === "multi_select" && Array.isArray(value) && value.every(entry => typeof entry === "string")) {
    return { name: fieldName, kind, value: [...value].sort() };
  }
  return refuse(`unsupported field kind or value for ${fieldName}`);
}

/** Unlike the frozen v1 identity helper, this projection retains numeric values and field kinds. */
function typedIssueFieldValues(values: readonly unknown[], source: "graphql" | "rest"): TypedIssueFieldValue[] {
  return sortedFields(values.map(raw => {
    const item = object(raw);
    if (source === "graphql") {
      const name = object(item.field).name;
      switch (item.__typename) {
        case "IssueFieldSingleSelectValue": return typedField(name, "single_select", item.name);
        case "IssueFieldTextValue": return typedField(name, "text", item.value);
        case "IssueFieldNumberValue": return typedField(name, "number", item.value);
        case "IssueFieldDateValue": return typedField(name, "date", item.value);
        case "IssueFieldMultiSelectValue": return typedField(name, "multi_select", item.value);
        default: return refuse(`unsupported field kind ${String(item.__typename)}`);
      }
    }
    const identity = issueFieldValueIdentity(item);
    const kind = item.data_type;
    return typedField(identity.name, kind, kind === "single_select" ? identity.value : item.value);
  }));
}

function boardIssue(raw: unknown, repositoryFullName: string): BoardIssueFingerprint {
  const issue = object(raw);
  if (issue.repositoryFullName !== repositoryFullName || issue.state !== "OPEN" ||
      typeof issue.updatedAt !== "string" || !Number.isFinite(Date.parse(issue.updatedAt)) ||
      !Array.isArray(issue.fieldValues)) return refuse("invalid open issue fingerprint");
  const fieldValues = sortedFields(issue.fieldValues.map(rawField => {
    const field = object(rawField);
    return typedField(field.name, field.kind, field.value);
  }));
  const horizon = fieldValues.filter(field => field.name === "Horizon");
  if (horizon.length > 1) return refuse(`Issue #${String(issue.number)} has duplicate Horizon values during v2 census`);
  return { number: positiveInteger(issue.number), databaseId: positiveInteger(issue.databaseId), nodeId: text(issue.nodeId),
    repositoryFullName, state: "OPEN", updatedAt: issue.updatedAt, fieldValues };
}

export function parseBoardFingerprint(raw: unknown): BoardFingerprint {
  const input = object(raw);
  const repositoryFullName = text(input.repositoryFullName);
  const issues: Record<string, BoardIssueFingerprint> = {};
  for (const [key, value] of Object.entries(object(input.issues))) {
    const issue = boardIssue(value, repositoryFullName);
    if (key !== String(issue.number)) return refuse("issue map identity mismatch");
    issues[key] = issue;
  }
  const digest = canonicalJsonSha256(issues);
  if (input.digest !== digest) return refuse("fingerprint digest mismatch");
  return { repositoryFullName, issues, digest };
}

// Union members verified by introspection on 2026-10-21. A value kind outside them refuses.
const BOARD_FINGERPRINT_QUERY = `query RoadmapBoardFingerprint($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    issues(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes {
        number id databaseId state updatedAt
        issueFieldValues(first: 100) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } }
            ... on IssueFieldTextValue { value field { ... on IssueFieldText { name } } }
            ... on IssueFieldNumberValue { value field { ... on IssueFieldNumber { name } } }
            ... on IssueFieldDateValue { value field { ... on IssueFieldDate { name } } }
            ... on IssueFieldMultiSelectValue { value field { ... on IssueFieldMultiSelect { name } } }
          }
        }
      }
    }
  }
}`;

export function readBoardFingerprint(options: {
  readonly repo: { readonly owner: string; readonly name: string; readonly fullName: string };
  readonly runGh: GhRunner;
  readonly readGraphql: ReadGraphql;
  readonly fetchedAt: string;
}): { fingerprint: BoardFingerprint; nowIssueNumbers: number[]; transport: TransportMetadataV2[] } {
  const issues: Record<string, BoardIssueFingerprint> = {};
  const transport: TransportMetadataV2[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let expectedCount: number | undefined;
  for (let page = 1; ; page++) {
    const result = options.readGraphql(options.runGh, BOARD_FINGERPRINT_QUERY,
      ["-F", `owner=${options.repo.owner}`, "-F", `repo=${options.repo.name}`, ...(cursor === null ? [] : ["-F", `cursor=${cursor}`])],
      "board fingerprint", options.fetchedAt, page);
    transport.push(...result.transport);
    const repository = object(object(result.value.data).repository);
    if (repository.nameWithOwner !== options.repo.fullName) return refuse("fingerprint repository mismatch");
    const connection = object(repository.issues);
    if (!Number.isSafeInteger(connection.totalCount) || (connection.totalCount as number) < 0 ||
        !Array.isArray(connection.nodes)) return refuse("invalid open issue count or page");
    expectedCount ??= connection.totalCount as number;
    if (expectedCount !== connection.totalCount) return refuse("open issue count changed between pages");
    for (const raw of connection.nodes) {
      const node = object(raw);
      const fields = object(node.issueFieldValues);
      if (!Array.isArray(fields.nodes) || fields.totalCount !== fields.nodes.length ||
          object(fields.pageInfo).hasNextPage !== false) return refuse("truncated issue field list");
      const issue = boardIssue({ number: node.number, databaseId: node.databaseId, nodeId: node.id,
        state: node.state, updatedAt: node.updatedAt, repositoryFullName: options.repo.fullName,
        fieldValues: typedIssueFieldValues(fields.nodes, "graphql") }, options.repo.fullName);
      if (issues[String(issue.number)] !== undefined) return refuse("duplicate open issue identity");
      issues[String(issue.number)] = issue;
    }
    const pageInfo = object(connection.pageInfo);
    if (pageInfo.hasNextPage === false) break;
    if (pageInfo.hasNextPage !== true) return refuse("missing open issue pagination evidence");
    cursor = text(pageInfo.endCursor);
    if (cursors.has(cursor)) return refuse("repeated open issue cursor");
    cursors.add(cursor);
  }
  if (Object.keys(issues).length !== expectedCount) return refuse("open issue count changed during pagination");
  const fingerprint = { repositoryFullName: options.repo.fullName, issues, digest: canonicalJsonSha256(issues) };
  const nowIssueNumbers = Object.values(issues).filter(issue => issue.fieldValues.some(field =>
    field.name === "Horizon" && field.kind === "single_select" && field.value === "Now"))
    .map(issue => issue.number).sort((a, b) => a - b);
  return { fingerprint, nowIssueNumbers, transport };
}

export function assertClosingBoardFingerprint(
  canonical: BoardFingerprint,
  closing: BoardFingerprint,
  intakeIssues: readonly { readonly number: number; readonly state: string; readonly fieldValues: readonly unknown[] }[],
): void {
  // The issue maps are re-hashed as well as the stored digests: a tamper guard for a hand-built fingerprint.
  if (canonical.repositoryFullName !== closing.repositoryFullName || canonical.digest !== closing.digest ||
      canonicalJsonSha256(canonical.issues) !== canonicalJsonSha256(closing.issues)) return refuse("closing fingerprint drift");
  const openIssues = intakeIssues.filter(issue => issue.state === "OPEN");
  if (openIssues.length !== Object.keys(closing.issues).length) return refuse("intake open issue count mismatch");
  // REST and GraphQL parity is verified for single-select values only, the only kind the
  // org uses today; other kinds are covered by the GraphQL-to-GraphQL comparisons above.
  for (const issue of openIssues) {
    const expected = closing.issues[String(issue.number)];
    const singleSelect = (values: readonly TypedIssueFieldValue[]) => values.filter(field => field.kind === "single_select");
    const rest = issue.fieldValues.filter(raw => object(raw).data_type === "single_select");
    if (expected === undefined || canonicalJsonSha256(singleSelect(expected.fieldValues)) !==
        canonicalJsonSha256(typedIssueFieldValues(rest, "rest"))) return refuse(`intake field values drifted for issue #${issue.number}`);
  }
}
