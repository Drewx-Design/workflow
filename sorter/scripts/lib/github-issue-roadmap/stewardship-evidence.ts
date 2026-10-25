import { stewardshipUnsafePatternId } from "./stewardship-unsafe-content";
import { isAbsolute } from "node:path";

import {
  hydrateIssueSnapshotV2,
  readGraphqlWithMetadata,
  readRestResourceWithMetadata,
  type GhRunner,
} from "../../github-issue-roadmap-preflight";
import { decomposeCompletionRule } from "../../github-issue-roadmap-existence-probe";
import { canonicalJsonSha256, sha256Bytes } from "./canonical-json";
import { runCredentialCleanGit } from "./credential-clean-git";
import { parseIncludedGhResponse } from "./read-only-github-reader";
import { issueFieldValueIdentity } from "./issue-field-value";
import { createStewardshipGitHub } from "./stewardship-github";
import type { StewardshipTimingCollector } from "./stewardship-phase-timing";
import { parseStewardshipPolicy, STEWARDSHIP_LIMITS, STEWARDSHIP_NATIVE_FIELDS, stewardshipSortKeySchema, type StewardshipNativeField } from "./stewardship-policy";
import {
  qualifyRepositoryIdentity,
  type IssueSnapshotV2,
  type RepositoryIdentityV2,
  type TransportMetadataV2,
  type VerificationCommentInput,
  CANONICAL_REST_API_VERSION,
} from "./snapshot-v2";
import type {
  StewardshipBaseline,
  StewardshipField,
  StewardshipFrontier,
  StewardshipState,
} from "./stewardship-state";

type JsonObject = Record<string, unknown>;

export const STEWARDSHIP_OBSERVATION_MAX_AGE_MS = 13 * 86_400_000;
// Computed keys are at most 5,040,000; foreign observations must never match one.
export const STEWARDSHIP_FOREIGN_SORT_KEY = Number.MAX_SAFE_INTEGER;

export function parseStewardshipTreeBlobs(tree: string): Map<string, string> {
  return new Map(tree.split("\0").flatMap((entry) => {
    const match = /^\d{6} blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    return match ? [[match[2], match[1]] as const] : [];
  }));
}

export type StewardshipGitHubRequests = Record<"graphql" | "rest" | "other", { ok: number; error: number }>;
export interface StewardshipGitHubRequestFailure {
  readonly kind: "graphql" | "rest" | "other";
  readonly operation: string | null;
  readonly requestIndex: number;
  readonly cursorIndex: number | null;
  readonly exitCode: number | null;
  readonly httpStatus: number | null;
  readonly retryAfterSeen: boolean;
  readonly graphqlErrorTypes: string[];
  readonly failureClass: "timeout" | "rate_limited" | "graphql_untyped" | "http_status" | "process_no_status" | "spawn_error" | "structured_block" | "unknown";
  readonly networkHint: "rate_limit" | "connection_reset" | "eof" | "tls" | "dns" | "connection_refused" | "http2_stream" | "timeout" | "auth" | "none";
}
export function emptyStewardshipGitHubRequests(): StewardshipGitHubRequests {
  return { graphql: { ok: 0, error: 0 }, rest: { ok: 0, error: 0 }, other: { ok: 0, error: 0 } };
}
function requestFailureNetworkHint(stderr: string): StewardshipGitHubRequestFailure["networkHint"] {
  if (/secondary rate limit|rate limit exceeded|API rate limit|abuse detection/i.test(stderr)) return "rate_limit";
  if (/ECONNRESET|connection reset|broken pipe/i.test(stderr)) return "connection_reset";
  if (/unexpected EOF|\bEOF\b/.test(stderr)) return "eof";
  if (/tls|x509|certificate/i.test(stderr)) return "tls";
  if (/no such host|ENOTFOUND|getaddrinfo/i.test(stderr)) return "dns";
  if (/ECONNREFUSED|connection refused/i.test(stderr)) return "connection_refused";
  if (/stream error|INTERNAL_ERROR|GOAWAY|http2/i.test(stderr)) return "http2_stream";
  if (/timeout|timed out|deadline exceeded/i.test(stderr)) return "timeout";
  if (/bad credentials|401|requires authentication/i.test(stderr)) return "auth";
  return "none";
}
function sanitizedRequestFailure(error: unknown): Pick<StewardshipGitHubRequestFailure,
  "exitCode" | "httpStatus" | "retryAfterSeen" | "graphqlErrorTypes" | "failureClass" | "networkHint"> {
  const detail = object(error);
  const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  const exitCode = typeof detail.status === "number" && Number.isFinite(detail.status) ? detail.status : null;
  // Unlike injected HTTP errors, diagnostics trust only gh exit 1 with an included leading status line.
  const included = detail.status === 1 && Object.hasOwn(detail, "stdout") ? normalizeReadError(error) : null;
  const httpStatus = included?.status ?? null;
  const retryAfterSeen = /^retry-after:/im.test(included?.diagnostics ?? "");
  let graphqlErrorTypes: string[] = [];
  try {
    const body = object(JSON.parse(parseIncludedGhResponse(text(detail.stdout)).body));
    graphqlErrorTypes = [...new Set(nodes(body.errors).flatMap((entry) => [entry.type, object(entry.extensions).code])
      .filter((value): value is string => typeof value === "string" && /^[A-Z_]{1,64}$/.test(value)))].sort().slice(0, 8);
  } catch { /* Unparseable bodies contribute no diagnostic text. */ }
  const structured = structuredReadBlockFromError(error);
  const failureClass: StewardshipGitHubRequestFailure["failureClass"] = detail.code === "ETIMEDOUT" || detail.signal === "SIGTERM" || structured?.code === "dependency_timeout" ? "timeout"
    : structured?.code === "rate_limited" ? "rate_limited"
    : isUntypedGraphqlReadError(error) ? "graphql_untyped"
    : httpStatus !== null ? "http_status"
    : exitCode !== null ? "process_no_status"
    : structured !== null ? "structured_block"
    : typeof detail.code === "string" ? "spawn_error"
    : "unknown";
  return { exitCode, httpStatus, retryAfterSeen, graphqlErrorTypes, failureClass, networkHint: requestFailureNetworkHint(text(detail.stderr)) };
}
function countStewardshipGitHubRequests(runner: GhRunner, counter: StewardshipGitHubRequests,
  failures?: StewardshipGitHubRequestFailure[]): GhRunner {
  const cursorCalls = new Map<string | null, number>();
  return (args) => {
    const kind = args[0] === "api" ? (args.includes("graphql") ? "graphql" : "rest") : "other";
    const query = args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";
    const path = args.at(-1)?.split("?")[0].replace(/\d+/g, "{n}") ?? "";
    const operation = kind === "graphql" ? /^\s*query\s+([A-Za-z][A-Za-z0-9_]{0,63})\b/.exec(query)?.[1] ?? null
      : kind === "rest" && /^[A-Za-z0-9/_{}.-]{1,128}$/.test(path) ? path : null;
    const hasCursor = kind === "graphql" && args.some((arg) => arg.startsWith("cursor="));
    if (hasCursor) cursorCalls.set(operation, (cursorCalls.get(operation) ?? 0) + 1);
    const cursorIndex = kind === "graphql" ? hasCursor ? 1 + (cursorCalls.get(operation) ?? 0) : 1 : null;
    try { const value = runner(args); inspectStructuredReadBlock(value); counter[kind].ok++; return value; }
    catch (error) {
      counter[kind].error++;
      if (failures && failures.length < 32) failures.push({ kind, operation,
        requestIndex: counter[kind].ok + counter[kind].error, cursorIndex, ...sanitizedRequestFailure(error) });
      throw error;
    }
  };
}

const MILESTONE_SPEC_PATH = "docs/roadmap/milestone-1.md";
const DEFAULT_STRATEGY_PATHS = [MILESTONE_SPEC_PATH, "STRATEGY.md", "docs/runbooks/github-issue-roadmap.md"] as const;
// The wrapper fetches immediately before every run. More than 50 commits means
// the fetch or checkout is broken, not normal traffic (about 10–20 merges a day).
const STEWARDSHIP_MAX_PIN_AHEAD_BY = 50;

export type StewardshipEvidenceGit = (
  cwd: string,
  args: readonly string[],
  options?: { readonly output?: "base64"; readonly localObjectsOnly?: boolean },
) => string;

export interface StewardshipFieldEvent {
  readonly id: string;
  readonly kind: "added" | "changed" | "removed";
  readonly field: StewardshipNativeField;
  readonly actorLogin: string | null;
  readonly createdAt: string;
  readonly previousValues: readonly string[];
  readonly values: readonly string[];
}

export interface StewardshipFieldHistory {
  readonly frontier: StewardshipFrontier;
  readonly events: readonly StewardshipFieldEvent[];
  readonly sha256: string;
}

export interface StewardshipSourceEvidence {
  readonly excerpt?: { readonly startLine: number; readonly endLine: number };
  readonly evidenceId: string;
  readonly path: string;
  readonly blobOid: string;
  readonly contentSha256: string;
  readonly snippetSha256: string;
  readonly byteLength: number;
  readonly fullByteLength: number;
  readonly text: string;
}

export interface StewardshipClauseEvidence {
  readonly clauseId: string;
  readonly text: string;
  readonly coverage: "source_collected" | "incomplete";
  readonly evidenceIds: readonly string[];
}

export interface StewardshipMaterialFact {
  readonly factId: string;
  readonly kind: "source" | "strategy" | "dependencies" | "merged_work";
  readonly locator: string;
  readonly contentSha256: string;
  readonly evidenceIds: readonly string[];
}

export interface StewardshipRubricIdentity {
  readonly specVersion: number;
  readonly rubricSha256: string;
}

export interface StewardshipIssueEvidencePacket {
  /** Accepted ranges, without scout prose; absent when no excerpt was collected. */
  readonly sourceExcerpts?: readonly StewardshipSourceExcerpt[];
  readonly scout?: StewardshipScoutRecord;
  readonly evidencePhase: "initial" | "expanded";
  /** Absent on archived packets collected before the milestone rubric was bound. */
  readonly rubricIdentity?: StewardshipRubricIdentity;
  readonly authorLogin?: string | null;
  readonly reopenEvents?: readonly { id: string; actorLogin: string | null; createdAt: string }[];
  readonly reopenHistoryComplete?: boolean;
  readonly excerptCapturedAt?: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly fields: { readonly Priority: string | null; readonly Horizon: string | null; readonly Effort?: string | null; readonly Lifecycle?: string | null; readonly "Sort key"?: number | null };
  readonly issue: IssueSnapshotV2;
  readonly fieldHistory: Record<StewardshipField, StewardshipFieldHistory> & { readonly Effort?: StewardshipFieldHistory; readonly Lifecycle?: StewardshipFieldHistory; readonly "Sort key"?: StewardshipFieldHistory };
  readonly sources: readonly StewardshipSourceEvidence[];
  readonly planEvidence?: readonly {
    readonly path: string;
    readonly blobOid: string;
    readonly contentSha256: string;
    readonly hasImplementationUnits: boolean;
    readonly namesIssue: boolean;
  }[];
  readonly clauses: readonly StewardshipClauseEvidence[];
  readonly facts: readonly StewardshipMaterialFact[];
  readonly coverage: {
    readonly sourceComplete: boolean;
    readonly fieldHistoryComplete: boolean;
    readonly requestedPaths: readonly string[];
    readonly explicitSourcePaths: readonly string[];
    readonly rejectedPaths: readonly string[];
    readonly omittedPaths: readonly string[];
    readonly sourceBytes: number;
  };
  readonly materialEvidenceSha256: string;
}

const REQUIRED_TARGET_READS = Object.freeze(["anchorA", "hydration1", "history", "comments", "hydration2", "relationships", "anchorB"] as const);
const READBACK_TARGET_READS = Object.freeze(["anchorA", "hydration1", "history", "comments", "relationships", "anchorB"] as const);

export type StewardshipTargetResult =
  | { readonly issueNumber: number; readonly status: "ok"; readonly packet: StewardshipIssueEvidencePacket;
      readonly comments?: readonly VerificationCommentInput[]; readonly commentsComplete?: true;
      readonly targetCompleteness?: { readonly complete: true; readonly reads: typeof REQUIRED_TARGET_READS | typeof READBACK_TARGET_READS } }
  | { readonly issueNumber: number; readonly status: "absent" | "unavailable" | "unstable";
      readonly cause?: string; readonly nextEligibleAt?: string | null };

export interface StewardshipTargetGeneration {
  readonly originMainSha: string;
  readonly policySha256: string;
  readonly targetResults?: readonly StewardshipTargetResult[];
}

export interface StewardshipEvidenceGeneration {
  readonly schemaVersion: "github-issue-roadmap-stewardship-evidence/v1";
  readonly evidencePhase: "initial" | "expanded";
  readonly generation: number;
  readonly generatedAt: string;
  readonly repository: RepositoryIdentityV2;
  readonly originMainSha: string;
  /** Capture metadata only; excluded from material hashes and journal evidence. */
  readonly mainDrift?: { readonly pinnedSha: string; readonly remoteMainShaAtEnd: string; readonly aheadBy: number };
  readonly policySha256: string;
  readonly census: {
    readonly complete: boolean;
    readonly totalCount: number;
    readonly nowCount: number;
    readonly issueNumbers: readonly number[];
    readonly members?: readonly { issueNumber: number; state: string; fields?: Pick<StewardshipIssueEvidencePacket["fields"], "Sort key"> }[];
    /** Capture metadata, excluded from material hashes and journal schemas. */
    readonly updatedAtByIssue?: Readonly<Record<number, string>>;
    readonly digestByIssue?: Readonly<Record<number, string>>;
  };
  readonly skippedUnchangedIssueNumbers?: readonly number[];
  readonly selectedIssueNumbers: readonly number[];
  readonly baselines: readonly StewardshipBaseline[];
  readonly packets: readonly StewardshipIssueEvidencePacket[];
  /** Present only for explicit targeted batch collection; never infer success from a missing packet. */
  readonly targetResults?: readonly StewardshipTargetResult[];
  readonly deferredIssues: readonly {
    readonly issueNumber: number;
    readonly reason: "packet_too_large" | "unsafe_content";
  }[];
  readonly transport: readonly TransportMetadataV2[];
  readonly materialEvidenceSha256: string;
}

interface CensusFieldHistory {
  readonly Priority: StewardshipFieldHistory;
  readonly Horizon: StewardshipFieldHistory;
  readonly Effort?: StewardshipFieldHistory;
  readonly Lifecycle?: StewardshipFieldHistory;
  readonly "Sort key"?: StewardshipFieldHistory;
  readonly reopenEvents?: StewardshipIssueEvidencePacket["reopenEvents"];
  readonly reopenHistoryComplete?: boolean;
}

interface CensusIssue {
  readonly authorLogin: string | null;
  readonly number: number;
  readonly databaseId: number;
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly state: string;
  readonly stateReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly fields: StewardshipIssueEvidencePacket["fields"];
  readonly history: CensusFieldHistory;
}

interface CensusCapture {
  readonly repository: RepositoryIdentityV2;
  readonly issues: readonly CensusIssue[];
  readonly transport: readonly TransportMetadataV2[];
}

export interface CollectStewardshipEvidenceOptions {
  readonly mode?: "run" | "shadow" | "preview";
  /** Retain the first collection's local pin throughout this process. */
  readonly pinnedMainSha?: string;
  /** Only daily run selection uses the last archived admission-based census. */
  readonly priorCensusUpdatedAt?: Readonly<Record<number, string>>;
  readonly priorCensusDigestByIssue?: Readonly<Record<number, string>>;
  readonly cachedSourcesByIssue?: Readonly<Record<number, readonly Pick<StewardshipSourceEvidence, "path" | "blobOid">[]>>;
  /** Previous run projection coverage; absent preserves the historical slice order. */
  readonly uncoveredIssueNumbers?: ReadonlySet<number>;
  readonly githubRequests?: StewardshipGitHubRequests;
  readonly githubRequestFailures?: StewardshipGitHubRequestFailure[];
  readonly sourceExcerptsByIssue?: Readonly<Record<number, readonly StewardshipScoutNomination[]>>;
  readonly scoutByIssue?: Readonly<Record<number, StewardshipScoutRecord>>;
  readonly repo: { readonly owner: string; readonly name: string; readonly fullName: string };
  readonly repoRoot: string;
  readonly trustedVerificationAuthors: readonly string[];
  readonly policyEvidence: unknown;
  readonly state?: StewardshipState | null;
  /** Initial adoption completes truncated census histories without hydrating all sources. */
  readonly adoption?: boolean;
  readonly selection?: { readonly mode: "initial" } | { readonly mode: "targeted"; readonly issueNumbers: readonly number[] };
  readonly targetResults?: boolean;
  readonly stabilityScope?: "census" | "selected";
  readonly withComments?: boolean;
  /** One ordered, anchored observation; never captures or asserts a census. */
  readonly targetObservation?: boolean;
  /** Readback keeps both anchors but collects one hydration. Fences keep the pair. */
  readonly targetReadback?: boolean;
  /**
   * Expanded evidence is a targeted recapture with a 192 KiB whole-packet ceiling.
   * Its caller must enforce the policy's expandedIssues limit and verify that each
   * archived expansion adds no more than 96 KiB relative to its initial packet.
   */
  readonly evidencePhase?: "initial" | "expanded";
  readonly sourcePathCandidatesByIssue?: Readonly<Record<number, readonly string[]>>;
  readonly completionRulesByIssue?: Readonly<Record<number, string>>;
  /** Overrides optional strategy sources; the Milestone 1 spec is always required. */
  readonly strategyPaths?: readonly string[];
  readonly configuredSensitiveValues?: readonly string[];
  readonly generatedAt?: string;
  readonly maxSourceBytesPerPacket?: number;
  readonly maxPacketBytes?: number;
  readonly maxHistoryPages?: number;
  readonly maxGenerationRetries?: number;
  readonly deadlineAt?: string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => void;
  readonly phaseTiming?: StewardshipTimingCollector;
  readonly runGh?: GhRunner;
  readonly runGit?: StewardshipEvidenceGit;
  readonly hydrateIssue?: typeof hydrateIssueSnapshotV2;
}

export interface StewardshipSourceExcerpt {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Bound during collection; raw scout nominations have no blob identity yet. */
  readonly blobOid?: string;
}
export type StewardshipScoutNomination = (StewardshipSourceExcerpt & { readonly index?: number })
  | { readonly index: number; readonly status: "rejected" | "omitted" };
export interface StewardshipScoutRecord {
  /** Every slot retains its original index; dropped slots contain no scout text. */
  readonly nominations?: readonly StewardshipScoutNomination[];
  readonly outcome: "nominated" | "produced_nothing" | "timeout" | "invalid_output" | "failed" | "usage_limit";
  readonly usage: "unknown" | { readonly inputTokens: number; readonly cachedInputTokens: number; readonly uncachedInputTokens: number; readonly outputTokens: number };
}

// forbidden: 401/403 with no rate-limit evidence, e.g. a credential lacking a permission.
type StewardshipReadExhaustedCause = "deadline" | "after_deadline" | "rate_limited" | "forbidden" | "transport";

class StewardshipEvidenceCollectionError extends Error {
  readonly code: "mixed_generation" | "read_exhausted" | "invalid_evidence" | "stale_pin";
  readonly attempts: number;
  readonly nextEligibleAt: string | null;
  declare readonly cause?: StewardshipReadExhaustedCause;
  declare readonly compareStatus?: "identical" | "ahead" | "behind" | "diverged" | number | null;
  declare readonly snapshotWide?: true;
  // Set only when trusted HTTP evidence (5xx, a truncated 200, untyped GraphQL
  // errors) stayed transient until the budget or deadline ran out.
  declare readonly transientHttp?: true;

  constructor(code: "read_exhausted", attempts: number, message: string, nextEligibleAt: string | null, cause: StewardshipReadExhaustedCause);
  constructor(code: "mixed_generation" | "invalid_evidence" | "stale_pin", attempts: number, message: string, nextEligibleAt?: string | null);
  constructor(code: StewardshipEvidenceCollectionError["code"], attempts: number, message: string, nextEligibleAt: string | null = null, cause?: StewardshipReadExhaustedCause) {
    super(message);
    this.name = "StewardshipEvidenceCollectionError";
    this.code = code;
    this.attempts = attempts;
    this.nextEligibleAt = nextEligibleAt;
    if (code === "read_exhausted") this.cause = cause;
  }
}

class StewardshipIssueDeferredError extends Error {
  constructor(readonly reason: StewardshipEvidenceGeneration["deferredIssues"][number]["reason"], message: string) {
    super(message); this.name = "StewardshipIssueDeferredError";
  }
}

/** Hash only versioned sections, including their headings, with LF line endings. */
export function deriveStewardshipRubricIdentity(specText: string): StewardshipRubricIdentity {
  const normalized = specText.replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const versions = [...(frontmatter?.[1] ?? "").matchAll(/^spec_version:[ \t]*(\d+)[ \t]*$/gm)];
  const specVersion = Number(versions[0]?.[1]);
  if (!frontmatter || versions.length !== 1 || !Number.isSafeInteger(specVersion) || specVersion < 1) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
      "Milestone 1 spec rubric identity requires a positive integer spec_version in frontmatter."), { snapshotWide: true as const });
  }
  const lines = normalized.slice(frontmatter[0].length).split("\n");
  // A heading inside a fenced code block is example text, not a section boundary.
  // CommonMark fences: up to three spaces of indent; a backtick opener's info string has no backtick;
  // a closer repeats the opener's character at least as many times, followed only by whitespace.
  let fence: string | null = null;
  const outsideFence = lines.map((line) => {
    if (fence === null) {
      const opener = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (opener) { fence = opener; return false; }
      return true;
    }
    const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
    if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = null;
    return false;
  });
  const section = (heading: "Rubric" | "Tier anchors"): string => {
    const pattern = new RegExp(`^##[ \\t]+${heading}(?:[ \\t]*$|[ \\t]+\\([^\\n]*\\)[ \\t]*$)`);
    const starts = lines.flatMap((line, index) => outsideFence[index] && pattern.test(line) ? [index] : []);
    if (starts.length !== 1) {
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
        `Milestone 1 spec rubric identity requires exactly one ## ${heading} section.`), { snapshotWide: true as const });
    }
    let end = starts[0] + 1;
    while (end < lines.length && !(outsideFence[end] && /^#{1,2}[ \t]+/.test(lines[end]))) end += 1;
    return `${lines.slice(starts[0], end).join("\n").trimEnd()}\n`;
  };
  return { specVersion, rubricSha256: canonicalJsonSha256({ specVersion, rubric: section("Rubric"), tierAnchors: section("Tier anchors") }) };
}

export function stewardshipPacketRubricCurrency(
  packet: Pick<StewardshipIssueEvidencePacket, "rubricIdentity">,
  currentSpecText: string,
): "current" | "stale" | "unknown_rubric" {
  if (packet.rubricIdentity === undefined) return "unknown_rubric";
  const current = deriveStewardshipRubricIdentity(currentSpecText);
  return packet.rubricIdentity.specVersion === current.specVersion && packet.rubricIdentity.rubricSha256 === current.rubricSha256
    ? "current" : "stale";
}

function strategySourcePaths(options: CollectStewardshipEvidenceOptions): Set<string> {
  return new Set([MILESTONE_SPEC_PATH, ...(options.strategyPaths ?? DEFAULT_STRATEGY_PATHS)]);
}

function refuseRequiredMilestoneSpec(reason: string): never {
  throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, `Required Milestone 1 spec (${MILESTONE_SPEC_PATH}) ${reason}.`), { snapshotWide: true as const });
}

const CENSUS_PAGE_SIZE = 50;
const ISSUE_ANCHOR_FIELDS = `
        id databaseId number title body createdAt updatedAt state stateReason author { login }
        repository { id databaseId nameWithOwner }
        issueFieldValues(first: 100) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes {
            ... on IssueFieldSingleSelectValue {
              id name
              field { ... on IssueFieldSingleSelect { id fullDatabaseId name } }
            }
            ... on IssueFieldNumberValue {
              value
              field { ... on IssueFieldNumber { id name } }
            }
          }
        }
        timelineItems(last: 100, itemTypes: [ISSUE_FIELD_ADDED_EVENT, ISSUE_FIELD_CHANGED_EVENT, ISSUE_FIELD_REMOVED_EVENT, REOPENED_EVENT]) {
          totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes {
            ... on ReopenedEvent { __typename id actor { login } createdAt }
            ... on IssueFieldAddedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } options { name } value }
            ... on IssueFieldChangedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } newOptions { name } previousOptions { name } newValue previousValue }
            ... on IssueFieldRemovedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } options { name } }
          }
        }
`;
const CENSUS_QUERY = `query RoadmapStewardshipCensus($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    id databaseId nameWithOwner
    issues(states: OPEN, first: ${CENSUS_PAGE_SIZE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ANCHOR_FIELDS} }
    }
  }
}`;

const TARGET_QUERY = `query RoadmapStewardshipTargetAnchor($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    id databaseId nameWithOwner
    issue(number: $number) { ${ISSUE_ANCHOR_FIELDS} }
  }
}`;

const HISTORY_QUERY = `query RoadmapStewardshipFieldHistory($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      timelineItems(first: 100, after: $cursor, itemTypes: [ISSUE_FIELD_ADDED_EVENT, ISSUE_FIELD_CHANGED_EVENT, ISSUE_FIELD_REMOVED_EVENT, REOPENED_EVENT]) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          ... on ReopenedEvent { __typename id actor { login } createdAt }
          ... on IssueFieldAddedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } options { name } value }
          ... on IssueFieldChangedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } newOptions { name } previousOptions { name } newValue previousValue }
          ... on IssueFieldRemovedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } ... on IssueFieldNumber { id name } } options { name } }
        }
      }
    }
  }
}`;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nodes(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function values(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  return nodes(value).map((entry) => string(entry.name)).filter((entry): entry is string => entry !== null);
}

function fieldName(value: unknown): StewardshipNativeField | null {
  const name = string(object(value).name);
  if (name === "Sort key") return name;
  return STEWARDSHIP_NATIVE_FIELDS.find((field) => field === name) ?? null;
}

function sortKeyObservationNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub returned an invalid Sort key Number.");
  return numeric;
}

function sortKeyValue(value: unknown): number {
  const parsed = stewardshipSortKeySchema.safeParse(sortKeyObservationNumber(value));
  return parsed.success ? parsed.data : STEWARDSHIP_FOREIGN_SORT_KEY;
}

function sortKeyEventValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  sortKeyObservationNumber(value);
  return [String(value)];
}

function normalizeEvent(raw: JsonObject): { readonly event: StewardshipFieldEvent | null; readonly opaque: boolean } {
  if (raw.__typename === "ReopenedEvent") return { event: null, opaque: !string(raw.id) || !string(raw.createdAt) };
  const field = fieldName(raw.issueField);
  const namedField = string(object(raw.issueField).name);
  const id = string(raw.id);
  const createdAt = string(raw.createdAt);
  if (!field) return { event: null, opaque: namedField === null };
  if (!id || !createdAt) return { event: null, opaque: true };
  const typename = string(raw.__typename);
  if (typename !== "IssueFieldAddedEvent" && typename !== "IssueFieldChangedEvent" && typename !== "IssueFieldRemovedEvent") {
    throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub returned an unknown issue-field event kind.");
  }
  const kind = typename === "IssueFieldAddedEvent" ? "added" : typename === "IssueFieldRemovedEvent" ? "removed" : "changed";
  if (field === "Sort key") return { opaque: false, event: {
    id, kind, field, actorLogin: string(object(raw.actor).login), createdAt,
    previousValues: kind === "changed" ? sortKeyEventValues(raw.previousValue) : [],
    values: kind === "removed" ? [] : sortKeyEventValues(kind === "added" ? raw.value : raw.newValue),
  } };
  const current = kind === "added" ? [...values(raw.options), ...values(raw.value)]
    : kind === "removed" ? [] : [...values(raw.newOptions), ...values(raw.newValue)];
  const previous = kind === "removed" ? [...values(raw.options)]
    : kind === "changed" ? [...values(raw.previousOptions), ...values(raw.previousValue)] : [];
  return { opaque: false, event: {
    id, kind, field, actorLogin: string(object(raw.actor).login), createdAt,
    previousValues: [...new Set(previous)].sort(), values: [...new Set(current)].sort(),
  } };
}

function reopenEvents(rows: readonly JsonObject[]) {
  return rows.filter((row) => row.__typename === "ReopenedEvent" && string(row.id) && string(row.createdAt))
    .map((row) => ({ id: string(row.id)!, actorLogin: string(object(row.actor).login), createdAt: string(row.createdAt)! }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function historyForField(
  events: readonly StewardshipFieldEvent[],
  field: StewardshipNativeField,
  complete: boolean,
  cursor: string | null,
): StewardshipFieldHistory {
  const filtered = events.filter((event) => event.field === field)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const frontier = { complete, eventIds: filtered.map((event) => event.id), cursor };
  return { frontier, events: filtered, sha256: canonicalJsonSha256(filtered) };
}

function historyMaterial(history: StewardshipFieldHistory): unknown {
  return {
    frontier: { complete: history.frontier.complete, eventIds: history.frontier.eventIds },
    events: history.events,
    sha256: history.sha256,
  };
}

function connection(value: unknown, context: string, snapshotWide?: true): {
  totalCount: number; rows: JsonObject[]; hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null;
} {
  const raw = object(value);
  const totalCount = number(raw.totalCount);
  if (totalCount === null) throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, `${context} omitted totalCount.`), snapshotWide ? { snapshotWide } : {});
  const pageInfo = object(raw.pageInfo);
  const hasNextPage = pageInfo.hasNextPage === true;
  const hasPreviousPage = pageInfo.hasPreviousPage === true;
  const endCursor = string(pageInfo.endCursor);
  if (hasNextPage && !endCursor) throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, `${context} omitted a continuation cursor.`), snapshotWide ? { snapshotWide } : {});
  return { totalCount, rows: nodes(raw.nodes), hasNextPage, hasPreviousPage, endCursor };
}

function parseFields(value: unknown, issueNumber: number) {
  const page = connection(value, `Issue #${issueNumber} field values`);
  if (page.hasNextPage || page.rows.length !== page.totalCount) {
    throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, `Issue #${issueNumber} field values were incomplete.`);
  }
  const result: Record<typeof STEWARDSHIP_NATIVE_FIELDS[number], string | null> & { "Sort key": number | null }
    = { Priority: null, Horizon: null, Effort: null, Lifecycle: null, "Sort key": null };
  const seen = new Set<StewardshipNativeField>();
  for (const row of page.rows) {
    const field = fieldName(row.field);
    if (!field) continue;
    if (seen.has(field)) throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, `Issue #${issueNumber} has duplicate ${field} values.`);
    seen.add(field);
    if (field === "Sort key") result[field] = sortKeyValue(row.value);
    else result[field] = string(row.name) ?? string(row.value);
  }
  return result;
}

function parseCensusIssue(raw: JsonObject): { issue: CensusIssue; repository: RepositoryIdentityV2 } {
  const issueNumber = number(raw.number);
  const databaseId = number(raw.databaseId);
  const nodeId = string(raw.id);
  const title = string(raw.title);
  const body = string(raw.body) ?? "";
  const createdAt = string(raw.createdAt);
  const state = string(raw.state);
  const repositoryRow = object(raw.repository);
  const repoId = number(repositoryRow.databaseId);
  const repoNodeId = string(repositoryRow.id);
  const nameWithOwner = string(repositoryRow.nameWithOwner);
  if (issueNumber === null || databaseId === null || !nodeId || !title || !createdAt || !state || repoId === null || !repoNodeId || !nameWithOwner) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub census returned incomplete material issue identity."), { snapshotWide: true as const });
  }
  const [organization, name, extra] = nameWithOwner.split("/");
  if (!organization || !name || extra !== undefined) throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub census returned an invalid repository identity."), { snapshotWide: true as const });
  const repository = qualifyRepositoryIdentity({ organization, name, databaseId: repoId, nodeId: repoNodeId });
  const timeline = connection(raw.timelineItems, `Issue #${issueNumber} field history`);
  const normalized = timeline.rows.map(normalizeEvent);
  const events = normalized.map((entry) => entry.event).filter((event): event is StewardshipFieldEvent => event !== null);
  const complete = !timeline.hasNextPage && !timeline.hasPreviousPage && timeline.rows.length === timeline.totalCount
    && normalized.every((entry) => !entry.opaque);
  const history = {
    Priority: historyForField(events, "Priority", complete, timeline.endCursor),
    Horizon: historyForField(events, "Horizon", complete, timeline.endCursor),
    Effort: historyForField(events, "Effort", complete, timeline.endCursor),
    Lifecycle: historyForField(events, "Lifecycle", complete, timeline.endCursor),
    "Sort key": historyForField(events, "Sort key", complete, timeline.endCursor),
    reopenEvents: reopenEvents(timeline.rows), reopenHistoryComplete: complete,
  };
  return { repository, issue: {
    authorLogin: string(object(raw.author).login), number: issueNumber, databaseId, nodeId, title, body, bodySha256: sha256Bytes(body), state,
    stateReason: string(raw.stateReason), createdAt, updatedAt: string(raw.updatedAt), fields: parseFields(raw.issueFieldValues, issueNumber), history,
  } };
}

function captureCensus(options: CollectStewardshipEvidenceOptions, runGh: GhRunner, fetchedAt: string): CensusCapture {
  const issues: CensusIssue[] = [];
  const transport: TransportMetadataV2[] = [];
  let repository: RepositoryIdentityV2 | null = null;
  let cursor: string | null = null;
  let expected = 0;
  let pageNumber = 1;
  const seenCursors = new Set<string>();
  do {
    const variables = ["-F", `owner=${options.repo.owner}`, "-F", `repo=${options.repo.name}`];
    if (cursor) variables.push("-F", `cursor=${cursor}`);
    const response = readGraphqlWithMetadata(runGh, CENSUS_QUERY, variables, "roadmap stewardship census", fetchedAt, pageNumber);
    transport.push(...response.transport);
    const repositoryRow = object(object(response.value.data).repository);
    const [organization, name, extra] = (string(repositoryRow.nameWithOwner) ?? "").split("/");
    const databaseId = number(repositoryRow.databaseId); const nodeId = string(repositoryRow.id);
    if (databaseId === null || !nodeId || extra || organization?.toLowerCase() !== options.repo.owner.toLowerCase() || name?.toLowerCase() !== options.repo.name.toLowerCase()) {
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Census repository identity missing or mismatched."), { snapshotWide: true as const });
    }
    const pageRepository = qualifyRepositoryIdentity({ organization, name, databaseId, nodeId });
    if (repository && canonicalJsonSha256(repository) !== canonicalJsonSha256(pageRepository)) throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", 1, "Repository identity changed."), { snapshotWide: true as const });
    repository = pageRepository;
    const page = connection(object(repositoryRow.issues), "Open issue census", true);
    expected = page.totalCount;
    for (const row of page.rows) {
      const parsed = parseCensusIssue(row);
      if (parsed.repository.organization.toLowerCase() !== options.repo.owner.toLowerCase()
          || parsed.repository.name.toLowerCase() !== options.repo.name.toLowerCase()) {
        throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub census crossed the requested repository boundary."), { snapshotWide: true as const });
      }
      repository ??= parsed.repository;
      if (canonicalJsonSha256(repository) !== canonicalJsonSha256(parsed.repository)) {
        throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "GitHub census returned inconsistent repository identity."), { snapshotWide: true as const });
      }
      issues.push(parsed.issue);
    }
    cursor = page.hasNextPage ? page.endCursor : null;
    if (cursor && (seenCursors.has(cursor) || pageNumber > 10_000)) {
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Open issue census returned a repeated pagination cursor."), { snapshotWide: true as const });
    }
    if (cursor) seenCursors.add(cursor);
    pageNumber += 1;
  } while (cursor);
  if (issues.length !== expected || new Set(issues.map((issue) => issue.number)).size !== issues.length) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Open issue census count or identity reconciliation failed."), { snapshotWide: true as const });
  }
  if (!repository) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "An empty census cannot establish repository identity."), { snapshotWide: true as const });
  }
  return { repository, issues: issues.sort((left, right) => left.number - right.number), transport };
}

function withoutSortKey<T extends { readonly "Sort key"?: unknown }>(fields: T): Omit<T, "Sort key"> {
  const { "Sort key": _sortKey, ...material } = fields;
  return material;
}

function censusMaterial(census: CensusCapture) {
  return { repository: census.repository, issues: census.issues.map((issue) => ({
    number: issue.number, databaseId: issue.databaseId, nodeId: issue.nodeId, title: issue.title,
    bodySha256: issue.bodySha256, state: issue.state, stateReason: issue.stateReason, createdAt: issue.createdAt,
    authorLogin: issue.authorLogin, reopenEvents: issue.history.reopenEvents, reopenHistoryComplete: issue.history.reopenHistoryComplete,
    fields: withoutSortKey(issue.fields), history: {
      Priority: historyMaterial(issue.history.Priority), Horizon: historyMaterial(issue.history.Horizon),
      ...(issue.history.Effort ? { Effort: historyMaterial(issue.history.Effort) } : {}),
      ...(issue.history.Lifecycle ? { Lifecycle: historyMaterial(issue.history.Lifecycle) } : {}),
    },
  })) };
}

function assertStableStewardshipCensus(first: CensusCapture, second: CensusCapture, generation: number): void {
  if (canonicalJsonSha256(first.repository) !== canonicalJsonSha256(second.repository)) {
    throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", generation, "Repository identity changed."), { snapshotWide: true as const });
  }
  if (canonicalJsonSha256(censusMaterial(first)) !== canonicalJsonSha256(censusMaterial(second))) {
    throw new StewardshipEvidenceCollectionError("mixed_generation", generation, "Evidence changed during collection; discarded the whole generation.");
  }
}

function stewardshipGenerationMaterialSha256(generation: Pick<StewardshipEvidenceGeneration,
  "evidencePhase" | "repository" | "originMainSha" | "policySha256" | "census" | "selectedIssueNumbers" | "baselines" | "packets" | "deferredIssues">): string {
  return canonicalJsonSha256({
    evidencePhase: generation.evidencePhase, repository: generation.repository, originMainSha: generation.originMainSha, policySha256: generation.policySha256,
    census: { totalCount: generation.census.totalCount, nowCount: generation.census.nowCount, issueNumbers: generation.census.issueNumbers },
    selectedIssueNumbers: generation.selectedIssueNumbers, baselines: generation.baselines.map((entry) => ({
      ...entry,
      frontiers: {
        Priority: { complete: entry.frontiers.Priority.complete, eventIds: entry.frontiers.Priority.eventIds },
        Horizon: { complete: entry.frontiers.Horizon.complete, eventIds: entry.frontiers.Horizon.eventIds },
      },
    })), packetHashes: generation.packets.map((packet) => packet.materialEvidenceSha256), deferredIssues: generation.deferredIssues,
  });
}

function assessmentAt(state: StewardshipState | null | undefined, issueNumber: number): string | null {
  const issue = state?.issues[issueNumber];
  return issue?.attempt?.at ?? issue?.assessment?.at ?? null;
}

function oldestFirst(census: readonly CensusIssue[], state: StewardshipState | null | undefined, uncoveredIssueNumbers?: ReadonlySet<number>) {
  return [...census].sort((left, right) => {
    const uncovered = Number(uncoveredIssueNumbers?.has(right.number) ?? false) - Number(uncoveredIssueNumbers?.has(left.number) ?? false);
    if (uncovered) return uncovered;
    const leftAssessed = Boolean(state?.issues[left.number]?.assessment);
    const rightAssessed = Boolean(state?.issues[right.number]?.assessment);
    if (leftAssessed !== rightAssessed) return leftAssessed ? 1 : -1;
    const leftAt = assessmentAt(state, left.number);
    const rightAt = assessmentAt(state, right.number);
    if (leftAt === null && rightAt !== null) return -1;
    if (leftAt !== null && rightAt === null) return 1;
    return (leftAt ?? "").localeCompare(rightAt ?? "") || left.number - right.number;
  });
}

function selectIssues(census: readonly CensusIssue[], state: StewardshipState | null | undefined,
  selection: CollectStewardshipEvidenceOptions["selection"], at: string, hydratedIssues: number,
  needsRecheck: (issue: CensusIssue) => boolean, allowAbsent = false, uncoveredIssueNumbers?: ReadonlySet<number>): number[] {
  if (selection?.mode === "targeted") {
    const issueNumbers = [...new Set(selection.issueNumbers)].sort((left, right) => left - right);
    if (issueNumbers.length === 0 || issueNumbers.length > hydratedIssues || issueNumbers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, `Targeted evidence selection requires one to ${hydratedIssues} unique issue numbers.`), { snapshotWide: true as const });
    }
    const open = new Set(census.map((issue) => issue.number));
    if (!allowAbsent && issueNumbers.some((value) => !open.has(value))) {
      throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Targeted evidence selection includes an issue outside the complete open census.");
    }
    return issueNumbers;
  }
  const eligible = census.filter((issue) => (!state?.issues[issue.number]?.attempt
    || Date.parse(state.issues[issue.number].attempt!.nextEligibleAt) <= Date.parse(at))
    && needsRecheck(issue));
  const now = oldestFirst(eligible.filter((issue) => issue.fields.Horizon === "Now"), state, uncoveredIssueNumbers).slice(0, Math.min(8, hydratedIssues));
  const nonNow = oldestFirst(eligible.filter((issue) => issue.fields.Horizon !== "Now"), state, uncoveredIssueNumbers).slice(0, hydratedIssues - now.length);
  return [...now, ...nonNow].map((issue) => issue.number);
}

function needsDailyRecheck(issue: CensusIssue, options: CollectStewardshipEvidenceOptions, at: string,
  digest: string, blobsAtMain?: ReadonlyMap<string, string>): boolean {
  const prior = options.priorCensusUpdatedAt;
  const cached = options.state?.issues[issue.number];
  return prior === undefined || issue.updatedAt === null || prior[issue.number] !== issue.updatedAt || !cached?.assessment
    || options.priorCensusDigestByIssue?.[issue.number] !== digest
    || Boolean(options.cachedSourcesByIssue?.[issue.number]?.some((source) => blobsAtMain?.get(source.path) !== source.blobOid))
    || Date.parse(at) - Date.parse(cached.assessment.at) >= STEWARDSHIP_OBSERVATION_MAX_AGE_MS
    || Boolean(cached.attempt && !["assessed", "unchanged_settlement"].includes(cached.attempt.reason));
}

function fullHistory(
  options: CollectStewardshipEvidenceOptions,
  runGh: GhRunner,
  issueNumber: number,
  fetchedAt: string,
): { readonly history: CensusFieldHistory; readonly transport: readonly TransportMetadataV2[];
  readonly totalCount: number; readonly rows: readonly JsonObject[] } {
  const maxPages = options.maxHistoryPages ?? 20;
  const events: StewardshipFieldEvent[] = [];
  const reopenRows: JsonObject[] = [];
  const rows: JsonObject[] = [];
  const transport: TransportMetadataV2[] = [];
  let cursor: string | null = null;
  let totalCount = 0;
  let page = 1;
  let truncated = false;
  let rowsRead = 0;
  let opaque = false;
  let lastCursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const variables = ["-F", `owner=${options.repo.owner}`, "-F", `repo=${options.repo.name}`, "-F", `number=${issueNumber}`];
    if (cursor) variables.push("-F", `cursor=${cursor}`);
    const response = readGraphqlWithMetadata(runGh, HISTORY_QUERY, variables, `field history for issue #${issueNumber}`, fetchedAt, page);
    transport.push(...response.transport);
    const issue = object(object(object(response.value.data).repository).issue);
    if (number(issue.number) !== issueNumber) throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, `GitHub did not return issue #${issueNumber} history.`);
    const timeline = connection(issue.timelineItems, `Issue #${issueNumber} field history`);
    if (options.targetObservation && page > 1 && totalCount !== timeline.totalCount) {
      throw new StewardshipEvidenceCollectionError("mixed_generation", 1, "Target history count changed during pagination.");
    }
    totalCount = timeline.totalCount;
    rows.push(...timeline.rows);
    rowsRead += timeline.rows.length;
    reopenRows.push(...timeline.rows.filter((row) => row.__typename === "ReopenedEvent"));
    lastCursor = timeline.endCursor;
    const normalized = timeline.rows.map(normalizeEvent);
    opaque ||= normalized.some((entry) => entry.opaque);
    events.push(...normalized.map((entry) => entry.event).filter((event): event is StewardshipFieldEvent => event !== null));
    if (timeline.hasNextPage && page >= maxPages) { truncated = true; cursor = timeline.endCursor; break; }
    cursor = timeline.hasNextPage ? timeline.endCursor : null;
    if (cursor && seenCursors.has(cursor)) {
      throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, `Issue #${issueNumber} history returned a repeated pagination cursor.`);
    }
    if (cursor) seenCursors.add(cursor);
    page += 1;
  } while (cursor);
  const unique = new Map(events.map((event) => [event.id, event]));
  const complete = !truncated && !opaque && rowsRead === totalCount && unique.size === events.length;
  const normalized = [...unique.values()];
  return { history: {
    Priority: historyForField(normalized, "Priority", complete, lastCursor),
    Horizon: historyForField(normalized, "Horizon", complete, lastCursor),
    Effort: historyForField(normalized, "Effort", complete, lastCursor),
    Lifecycle: historyForField(normalized, "Lifecycle", complete, lastCursor),
    "Sort key": historyForField(normalized, "Sort key", complete, lastCursor),
    reopenEvents: reopenEvents(reopenRows), reopenHistoryComplete: complete && new Set(reopenRows.map((row) => row.id)).size === reopenRows.length,
  }, transport, totalCount, rows };
}

export function validateSourcePath(path: string): boolean {
  if (path.length > 300 || !/^[A-Za-z0-9_.@+/-]+$/.test(path)) return false;
  if (path.includes("\\") || isAbsolute(path) || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) return false;
  if (!/^(?:src|scripts|docs|drizzle)\//.test(path) && path !== "STRATEGY.md") return false;
  if (/(?:^|\/)(?:\.env(?:\.|$)|\.git|node_modules|secrets?|credentials?|config(?:uration)?)(?:\/|\.|$)/i.test(path)) return false;
  if (/[`$;&|<>\r\n]/.test(path)) return false;
  return true;
}

function discoveredSourcePaths(body: string, repository: string): string[] {
  return uncappedDiscoveredSourcePaths(body, repository).slice(0, 24);
}

function uncappedDiscoveredSourcePaths(body: string, repository: string): string[] {
  const literals = [...body.matchAll(/(?:^|[\s`'"(])((?:src|scripts|docs|drizzle)\/[A-Za-z0-9_.@+/-]+)/gm)]
    .map((match) => match[1].replace(/[.,;:!?)]*$/, ""));
  // A URL is only a path hint: all bytes still come from the pinned main tree.
  // Avoid URL normalization, which would conceal traversal or encoded paths.
  const urls = [...body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/blob\/([A-Za-z0-9_.@+/-]+)(?=[#\s`'"),.;!?>]|$)/g)]
    .filter((match) => match[1].toLowerCase() === repository.toLowerCase())
    .flatMap((match) => {
      const segments = match[2].replace(/[.,;:!?)]*$/, "").split("/");
      // Git refs can contain slashes. Accept one unambiguous approved-root
      // suffix, never guess between a ref segment and a source path segment.
      const roots = segments.flatMap((segment, index) => /^(?:src|scripts|docs|drizzle)$/.test(segment) ? [index] : []);
      return roots.length === 1 && roots[0] > 0 ? [segments.slice(roots[0]).join("/")] : [];
    });
  return [...new Set([...literals, ...urls])]
    .filter(validateSourcePath);
}

function hasImplementationUnits(text: string): boolean {
  let fence: string | null = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) { fence = marker[1]; continue; }
    if (/^## Implementation Units\s*$/.test(line)) return true;
  }
  return false;
}

function linkedPlanEvidence(
  options: CollectStewardshipEvidenceOptions,
  runGit: StewardshipEvidenceGit,
  mainSha: string,
  issue: CensusIssue,
  omitted: string[],
): NonNullable<StewardshipIssueEvidencePacket["planEvidence"]> {
  const body = issue.body.split(/\r\n|\n|\r/)
    // Leading blockquote and emphasis markers are decoration, not part of the keyword.
    .filter((line) => !/^(?:(?:[-+*]|\d+[.)])\s+)?[*_]*(?:source_artifact|provenance|source-locator)[*_]*:/i
      .test(line.trim().replace(/^[>*_\s]+/, "")))
    .join("\n");
  // Filter the uncapped discovery so unrelated paths cannot crowd out a plan link.
  const candidates = uncappedDiscoveredSourcePaths(body, options.repo.fullName)
    .filter((path) => path.startsWith("docs/plans/") && path.endsWith(".md")).slice(0, 5).sort();
  // Dedicated reads do not spend the source budget; unsafe plans make coverage incomplete.
  // Only small facts are carried; materialPacket and assessment currency exclude them.
  return candidates.flatMap((path) => {
    // Read failures, including the run deadline, propagate like every other evidence read; the generic
    // source read of the same path already ran first. Only an empty blob is skipped as no evidence.
    const entry = runGit(options.repoRoot, ["ls-tree", "-z", mainSha, "--", path], { localObjectsOnly: true });
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0?$/.exec(entry);
    if (!match || match[3] !== path) return [];
    const exact = Buffer.from(runGit(options.repoRoot, ["cat-file", "blob", match[2]], { output: "base64", localObjectsOnly: true }), "base64");
    if (exact.length === 0) return [];
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(exact); }
    catch { return []; }
    if (exact.includes(0)) return [];
    const plan = { path, blobOid: match[2], contentSha256: sha256Bytes(exact),
      hasImplementationUnits: hasImplementationUnits(text), namesIssue: new RegExp(`#${issue.number}(?!\\w)`).test(text) };
    const unsafe = stewardshipUnsafePatternId({ ...plan, text }, options.configuredSensitiveValues);
    if (unsafe) { omitted.push(unsafeOmissionLocator(path, unsafe, options.configuredSensitiveValues)); return []; }
    return [plan];
  });
}

function completionRuleFromBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const preferred = lines.findIndex((line) => /^#{1,6}\s+(?:completion|definition of done|acceptance criteria)\b/i.test(line));
  const fallback = preferred < 0;
  const heading = preferred >= 0 ? preferred : lines.findIndex((line) => /^##\s+Outcome\b/i.test(line));
  if (heading < 0) return "";
  const selected: string[] = [];
  for (let index = heading + 1; index < lines.length && selected.length < 24; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) break;
    const value = lines[index].replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    // Filing renders the Outcome as one paragraph; its unheaded intake commentary follows a blank line.
    if (fallback && !value && selected.length > 0) break;
    if (value) selected.push(value);
  }
  return selected.join("\n");
}

function symbolSourcePaths(
  options: CollectStewardshipEvidenceOptions,
  runGit: StewardshipEvidenceGit,
  mainSha: string,
  body: string,
): { requested: string[]; omitted: string[] } {
  const symbols = [...new Set([...body.matchAll(/`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)`/g)]
    .map((match) => match[1].split(".").at(-1)!)
    .filter((name) => name.length <= 80 && /[a-z][A-Z]/.test(name)))].slice(0, 8);
  const requested = new Set<string>();
  const omitted = new Set<string>();
  for (const symbol of symbols) {
    const pattern = `^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?(function|class|interface|type|const|let)[[:space:]]+${symbol}([[:space:]<(=:]|$)`;
    const output = runGit(options.repoRoot, ["grep", "-I", "-l", "-z", "-E", "-e", pattern, mainSha, "--", "src", "scripts", "drizzle"], { localObjectsOnly: true });
    const candidates = [...new Set(output.split("\0")
      .filter((entry) => entry.startsWith(`${mainSha}:`))
      .map((entry) => entry.slice(mainSha.length + 1))
      .filter((path) => validateSourcePath(path) && /\.[cm]?[jt]sx?$/.test(path)))].sort();
    // An ambiguous name is a lead, not proof. Do not arbitrarily choose one
    // implementation or manufacture clause coverage. Expose bounded omissions.
    for (const path of candidates.slice(0, 24)) {
      requested.add(path);
      if (candidates.length > 4) omitted.add(path);
    }
  }
  return { requested: [...requested], omitted: [...omitted] };
}

function utf8Prefix(text: string, maximumBytes: number): Buffer {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    result += character; bytes += width;
  }
  return Buffer.from(result, "utf8");
}

function sourceSnippet(path: string, text: string): Buffer {
  if (path !== "docs/runbooks/github-issue-roadmap.md") return Buffer.from(text, "utf8");
  const lines = text.split(/(?<=\n)/);
  const start = lines.findIndex((line) => /^#{1,4}\s+.*(?:priority|rubric)/i.test(line));
  if (start < 0) return utf8Prefix(lines.slice(0, 200).join(""), 12 * 1024);
  const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
  let end = start + 1;
  while (end < lines.length) {
    const next = /^(#+)\s+/.exec(lines[end]);
    if (next && next[1].length <= level) break;
    end += 1;
  }
  return utf8Prefix(lines.slice(start, end).join(""), 12 * 1024);
}

function sourceSnippetFromBytes(path: string, exactBytes: Buffer): Buffer | "is not valid UTF-8" | "contains binary bytes" {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes); }
  catch { return "is not valid UTF-8"; }
  const snippet = sourceSnippet(path, decoded);
  return exactBytes.includes(0) ? "contains binary bytes" : snippet;
}

export function stewardshipSourceSnippetIdentity(path: string, exactBytes: Buffer): { sha256: string; byteLength: number } | null {
  try {
    const snippet = sourceSnippetFromBytes(path, exactBytes);
    return typeof snippet === "string" ? null : { sha256: sha256Bytes(snippet), byteLength: snippet.byteLength };
  } catch { return null; }
}

function sourceEvidence(
  options: CollectStewardshipEvidenceOptions,
  runGit: StewardshipEvidenceGit,
  mainSha: string,
  issue: CensusIssue,
): { sources: StewardshipSourceEvidence[]; requested: string[]; rejected: string[]; omitted: string[]; bytes: number; nominations: StewardshipScoutNomination[] } {
  const strategyPaths = strategySourcePaths(options);
  const directPaths = [...(options.sourcePathCandidatesByIssue?.[issue.number] ?? []),
    ...discoveredSourcePaths(issue.body, options.repo.fullName)];
  const symbols = directPaths.length === 0 ? symbolSourcePaths(options, runGit, mainSha, issue.body) : { requested: [], omitted: [] };
  const requested = [...new Set([
    ...strategyPaths,
    ...directPaths, ...symbols.requested,
  ])].sort();
  const rejected: string[] = [];
  const omitted: string[] = [...symbols.omitted];
  const sources: StewardshipSourceEvidence[] = [];
  let bytes = 0;
  const phase = options.evidencePhase ?? "initial";
  const budget = Math.min(options.maxSourceBytesPerPacket ?? (phase === "expanded" ? 96 * 1024 : 72 * 1024), 96 * 1024);
  // Required milestone spec first, then other strategy, implementation and docs.
  // Retain the canonical sorted requested-path manifest.
  const priority = (path: string) => path === MILESTONE_SPEC_PATH ? -1 : strategyPaths.has(path) ? 0 : path.startsWith("docs/") ? 2 : 1;
  for (const path of [...requested].sort((left, right) => priority(left) - priority(right))) {
    if (omitted.includes(path)) continue;
    if (!validateSourcePath(path)) { rejected.push(path); continue; }
    const entry = runGit(options.repoRoot, ["ls-tree", "-z", mainSha, "--", path], { localObjectsOnly: true });
    if (path === MILESTONE_SPEC_PATH && entry === "") refuseRequiredMilestoneSpec("is missing from pinned main");
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t([^\0]+)\0?$/.exec(entry);
    if (!match || match[3] !== path || match[1] === "120000") {
      if (path === MILESTONE_SPEC_PATH) refuseRequiredMilestoneSpec("is not a regular tracked file at pinned main");
      rejected.push(path); continue;
    }
    const exact = Buffer.from(runGit(options.repoRoot, ["cat-file", "blob", match[2]], { output: "base64", localObjectsOnly: true }), "base64");
    const snippet = sourceSnippetFromBytes(path, exact);
    if (typeof snippet === "string") {
      if (path === MILESTONE_SPEC_PATH) refuseRequiredMilestoneSpec(snippet);
      omitted.push(path); continue;
    }
    if (bytes + snippet.byteLength > budget) {
      if (path === MILESTONE_SPEC_PATH) refuseRequiredMilestoneSpec("exceeds the source byte budget");
      omitted.push(path); continue;
    }
    const contentSha256 = sha256Bytes(exact);
    const source = { evidenceId: `source:${contentSha256}`, path, blobOid: match[2], contentSha256,
      snippetSha256: sha256Bytes(snippet), byteLength: snippet.byteLength, fullByteLength: exact.byteLength, text: snippet.toString("utf8") };
    const unsafe = stewardshipUnsafePatternId(source, options.configuredSensitiveValues);
    if (unsafe) {
      if (path === MILESTONE_SPEC_PATH) assertStewardshipPacketSafe(source, options.configuredSensitiveValues);
      omitted.push(unsafeOmissionLocator(path, unsafe, options.configuredSensitiveValues)); continue;
    }
    sources.push(source);
    bytes += snippet.byteLength;
  }
  // Preserve all initial sources first for additive expansion. Excerpts spend only the remaining
  // source budget, then are displayed immediately after strategy sources.
  const excerpts: StewardshipSourceEvidence[] = [];
  const recordedNominations: StewardshipScoutNomination[] = [];
  const nominations = phase === "expanded" ? options.sourceExcerptsByIssue?.[issue.number] ?? [] : [];
  for (const [position, nomination] of nominations.entries()) {
    // Legacy accepted nominations have no index; retain their array position.
    const index = nomination.index ?? position;
    const locator = `scout-nomination:${index}`;
    const drop = (status: "rejected" | "omitted", stale = false) => {
      (status === "rejected" ? rejected : omitted).push(`${locator}${stale ? ":stale_nomination" : ""}`);
      recordedNominations.push({ index, status });
    };
    if ("status" in nomination) { drop(nomination.status); continue; }
    const { path, startLine, endLine } = nomination;
    if (position >= 6 || !Number.isSafeInteger(index) || index < 0 || index >= 6 || !validateSourcePath(path) || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || endLine < startLine || endLine - startLine >= 40) { drop("rejected"); continue; }
    const entry = runGit(options.repoRoot, ["ls-tree", "-z", mainSha, "--", path], { localObjectsOnly: true });
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0?$/.exec(entry);
    if (nomination.blobOid !== undefined && (!match || match[3] !== path || match[2] !== nomination.blobOid)) {
      drop("omitted", true); continue;
    }
    if (!match || match[3] !== path) { drop("rejected"); continue; }
    const exact = Buffer.from(runGit(options.repoRoot, ["cat-file", "blob", match[2]], { output: "base64", localObjectsOnly: true }), "base64");
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(exact); }
    catch { drop("omitted"); continue; }
    const lines = decoded.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (exact.includes(0) || endLine > lines.length) { drop("rejected"); continue; }
    const snippet = Buffer.from(lines.slice(startLine - 1, endLine).join(""), "utf8");
    if (bytes + snippet.byteLength > budget) { drop("omitted"); continue; }
    const contentSha256 = sha256Bytes(exact);
    const evidenceId = `source:${contentSha256}:${startLine}-${endLine}`;
    const source = { evidenceId, path, excerpt: { startLine, endLine }, blobOid: match[2], contentSha256,
      snippetSha256: sha256Bytes(snippet), byteLength: snippet.byteLength, fullByteLength: exact.byteLength, text: snippet.toString("utf8") };
    const unsafe = stewardshipUnsafePatternId(source, options.configuredSensitiveValues);
    if (unsafe) {
      if (path === MILESTONE_SPEC_PATH) assertStewardshipPacketSafe(source, options.configuredSensitiveValues);
      omitted.push(unsafeOmissionLocator(path, unsafe, options.configuredSensitiveValues)); drop("omitted"); continue;
    }
    recordedNominations.push({ index, path, startLine, endLine, blobOid: match[2] });
    if (excerpts.some((source) => source.evidenceId === evidenceId && source.path === path)) continue;
    excerpts.push(source);
    bytes += snippet.byteLength;
  }
  const afterStrategy = sources.findIndex((source) => !strategyPaths.has(source.path));
  sources.splice(afterStrategy < 0 ? sources.length : afterStrategy, 0, ...excerpts);
  return { sources, requested, rejected: rejected.sort(), omitted: omitted.sort(), bytes, nominations: recordedNominations };
}

function materialPacket(packet: Omit<StewardshipIssueEvidencePacket, "materialEvidenceSha256">, mainSha: string, policySha256: string) {
  return {
    originMainSha: mainSha, policySha256, evidencePhase: packet.evidencePhase,
    ...(packet.authorLogin === undefined ? {} : { authorLogin: packet.authorLogin }),
    ...(packet.reopenEvents === undefined ? {} : { reopenEvents: packet.reopenEvents }),
    ...(packet.reopenHistoryComplete === undefined ? {} : { reopenHistoryComplete: packet.reopenHistoryComplete }),
    ...(packet.rubricIdentity === undefined ? {} : { rubricIdentity: packet.rubricIdentity }),
    ...(packet.sourceExcerpts === undefined ? {} : { sourceExcerpts: packet.sourceExcerpts }),
    ...(packet.scout === undefined ? {} : { scout: { outcome: packet.scout.outcome,
      ...(packet.scout.nominations?.length ? { nominations: packet.scout.nominations } : {}) } }),
    issueNumber: packet.issueNumber, title: packet.title,
    bodySha256: packet.bodySha256, fields: withoutSortKey(packet.fields),
    identity: packet.issue.identity,
    state: packet.issue.v1.state, stateReason: packet.issue.v1.stateReason, type: packet.issue.v1.type,
    nativeType: packet.issue.nativeType, labels: packet.issue.v1.labels, assignees: packet.issue.v1.assignees,
    milestone: packet.issue.v1.milestone, createdAt: packet.issue.v1.createdAt,
    // Base collectors never recorded Sort key in fields, but their raw Number rows remain material on replay.
    fieldValues: "Sort key" in packet.fields
      ? packet.issue.v1.fieldValues.filter((value) => issueFieldValueIdentity(value).name !== "Sort key") : packet.issue.v1.fieldValues,
    projectMemberships: packet.issue.projectMemberships,
    relationships: packet.issue.relationships, pullRequests: packet.issue.pullRequests,
    persistedVerifications: packet.issue.persistedVerifications,
    fieldHistory: {
      Priority: historyMaterial(packet.fieldHistory.Priority), Horizon: historyMaterial(packet.fieldHistory.Horizon),
      ...(packet.fieldHistory.Effort === undefined ? {} : { Effort: historyMaterial(packet.fieldHistory.Effort) }),
      // Optional on archived packets: absence must preserve the pre-U6b material hash.
      ...(packet.fieldHistory.Lifecycle === undefined ? {} : { Lifecycle: historyMaterial(packet.fieldHistory.Lifecycle) }),
    },
    sources: packet.sources.map(({ evidenceId, path, blobOid, contentSha256, snippetSha256, byteLength, fullByteLength, excerpt }) =>
      ({ evidenceId, path, blobOid, contentSha256, snippetSha256, byteLength, fullByteLength, ...(excerpt ? { excerpt } : {}) })),
    clauses: packet.clauses, facts: packet.facts, coverage: packet.coverage,
  };
}

export function stewardshipPacketMaterialSha256(
  packet: Omit<StewardshipIssueEvidencePacket, "materialEvidenceSha256"> | StewardshipIssueEvidencePacket,
  originMainSha: string,
  policySha256: string,
): string {
  if (packet.bodySha256 !== sha256Bytes(packet.body)) {
    throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Stewardship packet body hash does not match its model-visible body.");
  }
  for (const source of packet.sources) {
    const bytes = Buffer.from(source.text, "utf8");
    if (source.byteLength !== bytes.byteLength || source.snippetSha256 !== sha256Bytes(bytes)
        || source.evidenceId !== `source:${source.contentSha256}${source.excerpt ? `:${source.excerpt.startLine}-${source.excerpt.endLine}` : ""}`) {
      throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Stewardship source snippet identity does not match its model-visible text.");
    }
  }
  if (packet.rubricIdentity !== undefined) {
    const spec = packet.sources.find((source) => source.path === MILESTONE_SPEC_PATH);
    if (!spec || stewardshipPacketRubricCurrency(packet, spec.text) !== "current") {
      throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Stewardship packet rubric identity does not match its Milestone 1 spec source.");
    }
  }
  return canonicalJsonSha256(materialPacket(packet, originMainSha, policySha256));
}

function semanticFact(kind: StewardshipMaterialFact["kind"], locator: string, value: unknown, evidenceIds: readonly string[] = []): StewardshipMaterialFact {
  return { factId: `fact:${canonicalJsonSha256({ kind, locator })}`, kind, locator,
    contentSha256: canonicalJsonSha256(value), evidenceIds };
}

function packetFor(
  options: CollectStewardshipEvidenceOptions,
  runGit: StewardshipEvidenceGit,
  issue: CensusIssue,
  hydrated: IssueSnapshotV2,
  history: CensusFieldHistory,
  mainSha: string,
  policySha256: string,
): StewardshipIssueEvidencePacket {
  const evidencePhase = options.evidencePhase ?? "initial";
  const source = sourceEvidence(options, runGit, mainSha, issue);
  const spec = source.sources.find((entry) => entry.path === MILESTONE_SPEC_PATH);
  if (!spec) refuseRequiredMilestoneSpec("was not collected from pinned main");
  const planEvidence = linkedPlanEvidence(options, runGit, mainSha, issue, source.omitted);
  // Trimming for size must not turn a nominated scout into produced_nothing.
  const excerptedBeforeTrim = source.sources.some((entry) => entry.excerpt);
  const assemble = () => {
    const complete = source.rejected.length === 0 && source.omitted.length === 0;
    const strategyPaths = strategySourcePaths(options);
    const actualSources = source.sources.filter((entry) => !strategyPaths.has(entry.path));
    const explicitCandidates = new Set(options.sourcePathCandidatesByIssue?.[issue.number] ?? []);
    const nominations = evidencePhase === "expanded" ? options.sourceExcerptsByIssue?.[issue.number] ?? [] : [];
    const acceptedExcerpts = source.sources.flatMap((entry) => entry.excerpt ? [{ path: entry.path, ...entry.excerpt, blobOid: entry.blobOid }] : []);
    const scoutRecord = evidencePhase === "expanded" ? options.scoutByIssue?.[issue.number] : undefined;
    const excerptPaths = new Set(source.sources.filter((entry) => entry.excerpt).map((entry) => entry.path));
    const clauses = decomposeCompletionRule(options.completionRulesByIssue?.[issue.number] ?? completionRuleFromBody(issue.body))
      .map((text, index) => {
        const named = discoveredSourcePaths(text, options.repo.fullName);
        const relevant = named.length > 0
          ? actualSources.filter((entry) => named.includes(entry.path))
          : actualSources.filter((entry) => explicitCandidates.has(entry.path) || excerptPaths.has(entry.path));
        const covered = relevant.length > 0 && (named.length === 0 || named.every((path) => relevant.some((entry) => entry.path === path)));
        return { clauseId: `clause:${issue.number}:${index + 1}`, text,
          coverage: complete && covered ? "source_collected" as const : "incomplete" as const,
          evidenceIds: relevant.map((entry) => entry.evidenceId) };
      });
    const facts: StewardshipMaterialFact[] = [
      ...source.sources.map((entry) => semanticFact(strategyPaths.has(entry.path) ? "strategy" : "source", entry.excerpt ? `${entry.path}:${entry.excerpt.startLine}-${entry.excerpt.endLine}` : entry.path,
        { path: entry.path, contentSha256: entry.contentSha256 }, [entry.evidenceId])),
      semanticFact("dependencies", `issue:${issue.number}:relationships`, hydrated.relationships),
      semanticFact("merged_work", `issue:${issue.number}:pull-requests`, hydrated.pullRequests),
    ];
    const withoutHash = {
      planEvidence,
      ...(acceptedExcerpts.length ? { sourceExcerpts: acceptedExcerpts } : {}),
      ...(scoutRecord || nominations.length ? { scout: {
        outcome: nominations.length || !scoutRecord ? excerptedBeforeTrim ? "nominated" as const : "produced_nothing" as const : scoutRecord.outcome,
        usage: scoutRecord?.usage ?? "unknown" as const,
        ...(source.nominations.length ? { nominations: source.nominations } : {}),
      } } : {}),
      authorLogin: issue.authorLogin, reopenEvents: history.reopenEvents ?? [], reopenHistoryComplete: history.reopenHistoryComplete ?? false,
      ...(acceptedExcerpts.length ? { excerptCapturedAt: options.generatedAt ?? new Date().toISOString() } : {}),
      rubricIdentity: deriveStewardshipRubricIdentity(spec.text),
      evidencePhase, issueNumber: issue.number, title: issue.title, body: issue.body, bodySha256: issue.bodySha256,
      fields: issue.fields, issue: hydrated, fieldHistory: { Priority: history.Priority, Horizon: history.Horizon,
        ...(history.Effort ? { Effort: history.Effort } : {}), ...(history.Lifecycle ? { Lifecycle: history.Lifecycle } : {}),
        ...(history["Sort key"] ? { "Sort key": history["Sort key"] } : {}) }, sources: source.sources, clauses, facts,
      coverage: { sourceComplete: complete, fieldHistoryComplete: history.Priority.frontier.complete && history.Horizon.frontier.complete,
        requestedPaths: source.requested, explicitSourcePaths: [...explicitCandidates].sort(), rejectedPaths: source.rejected, omittedPaths: [...new Set(source.omitted)].sort(), sourceBytes: source.bytes },
    };
    return { ...withoutHash, materialEvidenceSha256: stewardshipPacketMaterialSha256(withoutHash, mainSha, policySha256) };
  };
  const policyPacketLimit = evidencePhase === "expanded" ? 192 * 1024 : 96 * 1024;
  const packetLimit = Math.min(options.maxPacketBytes ?? policyPacketLimit, policyPacketLimit);
  let packet = assemble();
  // The rubric spec is mandatory; optional excerpts yield before non-source evidence.
  for (const entry of source.sources.filter((entry) => entry !== spec).sort((left, right) => right.byteLength - left.byteLength || left.path.localeCompare(right.path))) {
    if (Buffer.byteLength(JSON.stringify(packet), "utf8") <= packetLimit) break;
    source.sources.splice(source.sources.indexOf(entry), 1);
    source.bytes -= entry.byteLength;
    source.omitted.push(entry.path);
    packet = assemble();
  }
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > packetLimit) {
    throw new StewardshipIssueDeferredError("packet_too_large", "Stewardship evidence packet exceeds its byte limit.");
  }
  return packet;
}

function baseline(issue: CensusIssue, policySha256: string, selectedHistory?: CensusFieldHistory): StewardshipBaseline {
  const history = selectedHistory ?? issue.history;
  return {
    issueNumber: issue.number,
    materialEvidenceSha256: canonicalJsonSha256({ issueNumber: issue.number, title: issue.title, bodySha256: issue.bodySha256, fields: withoutSortKey(issue.fields), policySha256 }),
    fields: withoutSortKey(issue.fields) as StewardshipBaseline["fields"],
    frontiers: { Priority: history.Priority.frontier, Horizon: history.Horizon.frontier,
      ...(history.Effort ? { Effort: history.Effort.frontier } : {}), ...(history.Lifecycle ? { Lifecycle: history.Lifecycle.frontier } : {}) },
  };
}

function assertMainSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Pinned origin/main is not a Git SHA."), { snapshotWide: true as const });
  return sha;
}

function unsafeOmissionLocator(path: string, patternId: NonNullable<ReturnType<typeof stewardshipUnsafePatternId>>, sensitiveValues: readonly string[] = []): string {
  const locator = stewardshipUnsafePatternId(path, sensitiveValues) ? `path-sha256:${sha256Bytes(path).slice(0, 16)}` : path;
  return `${locator}:unsafe_excerpt:${patternId}`;
}

export function assertStewardshipPacketSafe(value: unknown, configuredSensitiveValues: readonly string[] = []): void {
  const unsafe = stewardshipUnsafePatternId(value, configuredSensitiveValues);
  if (unsafe) throw new StewardshipIssueDeferredError("unsafe_content", unsafe === "configured_value"
    ? "Stewardship evidence contains a configured sensitive value." : "Stewardship evidence contains secret-like content.");
}

function sameHydration(left: readonly IssueSnapshotV2[], right: readonly IssueSnapshotV2[]): boolean {
  const material = (issues: readonly IssueSnapshotV2[]) => issues.map(({ transport: _transport, v1, ...issue }) => ({
    ...issue, v1: { ...v1, updatedAt: undefined },
  }));
  return canonicalJsonSha256(material(left)) === canonicalJsonSha256(material(right));
}

function hydrationFields(issue: IssueSnapshotV2) {
  const result: Record<typeof STEWARDSHIP_NATIVE_FIELDS[number], string | null> & { "Sort key": number | null }
    = { Priority: null, Horizon: null, Effort: null, Lifecycle: null, "Sort key": null };
  for (const value of issue.v1.fieldValues) {
    const field = issueFieldValueIdentity(value);
    if (field.name === "Sort key") { result["Sort key"] = sortKeyValue(object(value).value); continue; }
    const name = STEWARDSHIP_NATIVE_FIELDS.find((name) => name === field.name);
    if (name) result[name] = field.value;
  }
  return result;
}

function assertHydrationMatchesCensus(census: readonly CensusIssue[], hydrated: readonly IssueSnapshotV2[]): void {
  for (const issue of hydrated) {
    const expected = census.find((entry) => entry.number === issue.identity.number);
    const matches = expected !== undefined
      && expected.databaseId === issue.identity.databaseId
      && expected.nodeId === issue.identity.nodeId
      && expected.title === issue.v1.title
      && expected.bodySha256 === issue.v1.bodySha256
      && expected.state === issue.v1.state
      // GraphQL reports the enum (REOPENED); REST hydration reports it lowercase (reopened).
      && (expected.stateReason?.toLowerCase() ?? null) === (issue.v1.stateReason?.toLowerCase() ?? null)
      && expected.createdAt === issue.v1.createdAt
      && canonicalJsonSha256(expected.fields) === canonicalJsonSha256(hydrationFields(issue));
    if (!matches) throw new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Canonical hydration disagrees with the stable census material tuple.");
  }
}

function normalizeReadError(error: unknown): { status: number | null; diagnostics: string; untrustedProcessFailure: boolean } {
  const detail = object(error);
  const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  // A process error (execFileSync attaches stdout) carries an exit code, never an
  // HTTP status: only gh's exit 1 with a leading included HTTP status line is
  // trusted, and retry evidence comes only from that parsed header block. stderr
  // can echo server-controlled text, so it is never retry evidence for a process.
  // Injected runners without stdout may still supply an HTTP status and headers.
  const processError = Object.hasOwn(detail, "stdout");
  let status: number | null = null;
  let diagnostics = "";
  if (!processError) {
    if (typeof detail.status === "number" && Number.isInteger(detail.status) && detail.status >= 100) {
      status = detail.status; diagnostics = text(detail.stderr);
    }
  } else if (detail.status === 1) {
    const lines = text(detail.stdout).split(/\r?\n/);
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(lines[0] ?? "");
    if (match && Number(match[1]) >= 100) {
      status = Number(match[1]);
      // Headers end at the first line that is not header-shaped, so body text can
      // never become retry evidence even if gh omits the blank separator line.
      const headers: string[] = [];
      for (const line of lines.slice(1)) {
        if (!/^[A-Za-z0-9-]+:/.test(line)) break;
        headers.push(line);
      }
      diagnostics = headers.join("\n");
    }
  }
  const untrustedProcessFailure = typeof detail.status === "number" && status === null;
  return { status, diagnostics, untrustedProcessFailure };
}

function isUntypedGraphqlReadError(error: unknown): boolean {
  const detail = object(error);
  if (detail.status !== 1 || !Object.hasOwn(detail, "stdout") || normalizeReadError(error).status !== 200) return false;
  const stdout = Buffer.isBuffer(detail.stdout) ? detail.stdout.toString("utf8") : typeof detail.stdout === "string" ? detail.stdout : "";
  try {
    const response = parseIncludedGhResponse(stdout);
    if (response.status !== 200) return false;
    const errors = object(JSON.parse(response.body)).errors;
    return Array.isArray(errors) && errors.length > 0 && errors.every((entry) => {
      const row = object(entry);
      return typeof row.type !== "string" && typeof object(row.extensions).code !== "string";
    });
  } catch { return false; }
}

// A trusted HTTP 200 with gh exit 1 whose body is empty, missing (no header
// boundary) or not JSON carries no refusal at all: it is a truncated transfer.
// A parseable body, typed errors included, is never upgraded here.
function isEmptyOrUnparseable200(error: unknown): boolean {
  const detail = object(error);
  if (detail.status !== 1 || !Object.hasOwn(detail, "stdout") || normalizeReadError(error).status !== 200) return false;
  const stdout = Buffer.isBuffer(detail.stdout) ? detail.stdout.toString("utf8") : typeof detail.stdout === "string" ? detail.stdout : "";
  let body: string;
  try { body = parseIncludedGhResponse(stdout).body; } catch { return true; }
  if (body === "") return true;
  try { JSON.parse(body); return false; } catch { return true; }
}

// Bounded backoff for status-bearing transport blips without a retry time.
const TRANSIENT_BACKOFF_MS = [2_000, 8_000] as const;

function retryEligibility(diagnostics: string, generatedAt: string): string | null {
  const candidates: number[] = [];
  // GitHub sends x-ratelimit-reset on every response; it is retry evidence only
  // when the quota is exhausted (remaining 0), never merely because it is present.
  const reset = /^x-ratelimit-reset:\s*(\d+)\s*$/im.exec(diagnostics)?.[1];
  const remaining = /^x-ratelimit-remaining:\s*(\d+)\s*$/im.exec(diagnostics)?.[1];
  if (reset && remaining !== undefined && Number(remaining) === 0) candidates.push(Number(reset) * 1_000);
  const retryAfter = /^retry-after:\s*(.+?)\s*$/im.exec(diagnostics)?.[1];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? Date.parse(generatedAt) + seconds * 1_000 : Date.parse(retryAfter);
    if (Number.isFinite(parsed)) candidates.push(parsed);
  }
  return candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;
}

class StructuredReadBlock extends Error {
  constructor(readonly code: string, readonly resetEpoch: number | null) { super("Structured read block"); }
}

function inspectStructuredReadBlock(raw: string): void {
  if (!raw.trimStart().startsWith("{")) return;
  try {
    const parsed = object(JSON.parse(raw));
    const blocker = object(parsed.blocker);
    if (parsed.status === "blocked" && typeof blocker.code === "string") {
      const reset = number(blocker.resetEpoch) ?? (typeof blocker.resetEpoch === "string" && /^\d+$/.test(blocker.resetEpoch)
        ? Number(blocker.resetEpoch) : null);
      throw new StructuredReadBlock(blocker.code, reset);
    }
  } catch (error) {
    if (error instanceof StructuredReadBlock) throw error;
  }
}

function structuredReadBlockFromError(error: unknown): StructuredReadBlock | null {
  if (error instanceof StructuredReadBlock) return error;
  if (!(error instanceof Error)) return null;
  try {
    inspectStructuredReadBlock(error.message);
    return null;
  } catch (parsed) {
    return parsed instanceof StructuredReadBlock ? parsed : null;
  }
}

function sleepSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryRunner<T extends (...args: never[]) => string>(
  runner: T,
  options: CollectStewardshipEvidenceOptions,
  retryStatuslessProcessFailures = false,
): T {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = Date.parse(now());
  const deadline = Date.parse(options.deadlineAt ?? new Date(startedAt + 30 * 60 * 1_000).toISOString());
  return ((...args: Parameters<T>) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (Date.parse(now()) >= deadline) {
        throw new StewardshipEvidenceCollectionError("read_exhausted", attempt - 1, "Evidence read deadline was reached.", null, "deadline");
      }
      try {
        const value = runner(...args);
        inspectStructuredReadBlock(value);
        if (Date.parse(now()) > deadline) {
          throw new StewardshipEvidenceCollectionError("read_exhausted", attempt, "Evidence read completed after the run deadline.", null, "after_deadline");
        }
        return value;
      }
      catch (error) {
        if (error instanceof StewardshipEvidenceCollectionError) throw error;
        const structured = structuredReadBlockFromError(error);
        if (structured?.code === "rate_limited" && structured.resetEpoch === null) {
          throw new StewardshipEvidenceCollectionError("read_exhausted", attempt, "Evidence read is rate-limited with no safe retry time.", null, "rate_limited");
        }
        const { status, diagnostics, untrustedProcessFailure } = normalizeReadError(error);
        const structuredEligible = structured?.resetEpoch !== null && structured?.resetEpoch !== undefined
          ? new Date(structured.resetEpoch * 1_000).toISOString() : null;
        const eligible = structuredEligible ?? retryEligibility(diagnostics, now());
        const cause = structured?.code === "rate_limited" || status === 429 || (status === 403 && eligible !== null) ? "rate_limited"
          : status === 401 || status === 403 ? "forbidden" : "transport";
        const retryAt = eligible === null ? Date.parse(now()) : Date.parse(eligible);
        const backoff = structured === null && ((status !== null && status >= 500) || isEmptyOrUnparseable200(error));
        const transient = structured !== null
          ? structured.code === "rate_limited" || structured.code === "dependency_timeout"
          : backoff || isUntypedGraphqlReadError(error) || (status === null && (!untrustedProcessFailure || retryStatuslessProcessFailures))
            || status === 403 || status === 408 || status === 429;
        const exhausted = (message: string) => Object.assign(new StewardshipEvidenceCollectionError("read_exhausted", attempt, message, eligible, cause),
          transient && cause === "transport" && structured === null && (backoff || isUntypedGraphqlReadError(error)) ? { transientHttp: true as const } : {});
        if (eligible !== null && retryAt > deadline) throw exhausted("Evidence retry time is beyond the run deadline.");
        if (!transient || attempt === 3) throw exhausted("Evidence read attempts were exhausted.");
        if (eligible !== null || backoff || (structured === null && untrustedProcessFailure && retryStatuslessProcessFailures)) {
          // Only gh retries status-less process errors; their text is never retry-time evidence.
          const delay = eligible !== null ? Math.max(0, retryAt - Date.parse(now()))
            : backoff ? TRANSIENT_BACKOFF_MS[attempt - 1] : attempt * 1_000;
          if (Date.parse(now()) + delay >= deadline) throw exhausted("Evidence retry would exceed the run deadline.");
          timeEvidenceSync(options.phaseTiming, "collect.retryWait", () => (options.sleep ?? sleepSynchronously)(delay));
        }
        try { options.phaseTiming?.retry(); } catch { /* Telemetry cannot alter retry behavior. */ }
      }
    }
    throw new StewardshipEvidenceCollectionError("read_exhausted", 3, "Evidence read attempts were exhausted.", null, "transport");
  }) as T;
}

function validateLimits(options: CollectStewardshipEvidenceOptions): void {
  if (options.targetObservation && (options.selection?.mode !== "targeted" || options.selection.issueNumbers.length !== 1
    || !Number.isSafeInteger(options.selection.issueNumbers[0]) || options.selection.issueNumbers[0] <= 0
    || !options.targetResults || !options.withComments || options.adoption)) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
      "Target observation requires exactly one target, target results and complete comments without adoption."), { snapshotWide: true as const });
  }
  if ((options.targetResults && (options.selection?.mode !== "targeted" || options.adoption))
    || ((options.withComments || options.stabilityScope === "selected") && !options.targetResults)
    || (options.stabilityScope !== undefined && options.stabilityScope !== "selected" && options.stabilityScope !== "census")) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Batch observations require targeted selection without adoption; selected stability and comments require target results."), { snapshotWide: true as const });
  }
  const evidencePhase = options.evidencePhase ?? "initial";
  if (evidencePhase !== "initial" && evidencePhase !== "expanded") {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "evidencePhase is outside the closed stewardship policy enum."), { snapshotWide: true as const });
  }
  if (evidencePhase === "expanded" && options.selection?.mode !== "targeted") {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "Expanded stewardship evidence requires targeted issue selection."), { snapshotWide: true as const });
  }
  const packetLimit = evidencePhase === "expanded" ? 192 * 1024 : 96 * 1024;
  const integers: readonly [string, number, number, number][] = [
    ["maxGenerationRetries", options.maxGenerationRetries ?? 2, 0, 2],
    ["maxHistoryPages", options.maxHistoryPages ?? 20, 1, 20],
    ["maxSourceBytesPerPacket", options.maxSourceBytesPerPacket ?? (evidencePhase === "expanded" ? 96 * 1024 : 72 * 1024), 0, 96 * 1024],
    ["maxPacketBytes", options.maxPacketBytes ?? packetLimit, 1, packetLimit],
  ];
  for (const [name, value, minimum, maximum] of integers) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, `${name} is outside the closed stewardship policy bound.`), { snapshotWide: true as const });
    }
  }
  if (options.deadlineAt !== undefined && !Number.isFinite(Date.parse(options.deadlineAt))) {
    throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "deadlineAt must be a valid timestamp."), { snapshotWide: true as const });
  }
}

function mainComparison(value: JsonObject, pinnedSha: string, readRemoteMainSha: () => string | null): NonNullable<StewardshipEvidenceGeneration["mainDrift"]> {
  const status = value.status;
  const compareStatus = status === "identical" || status === "ahead" || status === "behind" || status === "diverged" ? status : null;
  const invalid = () => Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
    "GitHub main comparison does not prove the evidence pin is an ancestor."), { snapshotWide: true as const, compareStatus });
  const aheadBy = value.ahead_by;
  const behindBy = value.behind_by;
  const mergeBase = string(object(value.merge_base_commit).sha);
  if (typeof aheadBy !== "number" || !Number.isSafeInteger(aheadBy) || aheadBy < 0
    || typeof behindBy !== "number" || !Number.isSafeInteger(behindBy) || behindBy !== 0
    || mergeBase !== pinnedSha || (status !== "identical" && status !== "ahead")
    || (status === "identical" ? aheadBy !== 0 : aheadBy === 0)) throw invalid();
  // ahead_by remains the count; a truncated list cannot identify the remote head. Only a non-empty
  // list shorter than ahead_by is truncation; an absent, non-array, empty or overlong list is malformed.
  if (status === "ahead" && (!Array.isArray(value.commits) || value.commits.length === 0 || value.commits.length > aheadBy)) throw invalid();
  const commits = Array.isArray(value.commits) ? value.commits : [];
  const remoteMainShaAtEnd = status === "identical" ? pinnedSha
    : commits.length === aheadBy ? string(object(commits.at(-1)).sha) : readRemoteMainSha();
  if (!remoteMainShaAtEnd || !/^[0-9a-f]{40}$/.test(remoteMainShaAtEnd)
    || (status === "ahead" && remoteMainShaAtEnd === pinnedSha)) throw invalid();
  return { pinnedSha, remoteMainShaAtEnd, aheadBy };
}

function captureTargetAnchor(options: CollectStewardshipEvidenceOptions, runGh: GhRunner, issueNumber: number, fetchedAt: string) {
  return timeEvidenceSync(options.phaseTiming, "collect.target.anchor", () => {
    const response = readGraphqlWithMetadata(runGh, TARGET_QUERY,
      ["-F", `owner=${options.repo.owner}`, "-F", `repo=${options.repo.name}`, "-F", `number=${issueNumber}`], "target anchor", fetchedAt);
    const row = object(object(response.value.data).repository);
    const fullName = string(row.nameWithOwner);
    if (!fullName || fullName.toLowerCase() !== options.repo.fullName.toLowerCase()
      || fullName.toLowerCase() !== `${options.repo.owner}/${options.repo.name}`.toLowerCase()
      || !number(row.databaseId) || !string(row.id)) throw new Error("Target repository identity mismatch");
    const repository = qualifyRepositoryIdentity({ organization: fullName.split("/")[0], name: fullName.split("/")[1],
      databaseId: number(row.databaseId)!, nodeId: string(row.id)! });
    // Deleted/transferred issues stay unavailable (an outage): null can also mean
    // a visibility or permission fault. Persistent null keeps the snapshot at a
    // partial stop until an operator replaces the snapshot.
    if (row.issue === null) throw new Error("Target anchor issue unavailable");
    let parsed: ReturnType<typeof parseCensusIssue>;
    // Census parser errors are repository-wide there, but belong to this target here.
    try { parsed = parseCensusIssue(object(row.issue)); } catch { throw new Error("Incomplete target anchor"); }
    if (parsed.issue.number !== issueNumber || parsed.issue.databaseId <= 0
      || canonicalJsonSha256(parsed.repository) !== canonicalJsonSha256(repository)) throw new Error("Target identity mismatch");
    if (parsed.issue.state !== "OPEN" && parsed.issue.state !== "CLOSED") throw new Error("Invalid target state");
    const timeline = connection(object(row.issue).timelineItems, "Target anchor history");
    if (timeline.hasNextPage || timeline.totalCount < 0 || timeline.rows.length !== Math.min(100, timeline.totalCount)
      || timeline.hasPreviousPage !== (timeline.totalCount > 100)) throw new Error("Incomplete target history anchor");
    return { repository, issues: [parsed.issue], transport: response.transport, timeline };
  });
}

function readObservationComments(options: CollectStewardshipEvidenceOptions, runGh: GhRunner, issueNumber: number) {
  return timeEvidenceSync(options.phaseTiming, "observe.comments", () => {
    const pager = createStewardshipGitHub.pages(`/repos/${options.repo.fullName}/issues/${issueNumber}/comments`);
    let page = pager.next();
    while (!page.done) {
      const response = parseIncludedGhResponse(runGh(["api", "--include", "-H", "Accept: application/vnd.github+json",
        "-H", `X-GitHub-Api-Version: ${CANONICAL_REST_API_VERSION}`, page.value]));
      if (response.status !== 200 || Buffer.byteLength(response.body) > 2 * 1024 * 1024) throw new Error("Incomplete comments response");
      page = pager.next({ value: JSON.parse(response.body) as unknown, link: response.headers.link ?? null });
    }
    return page.value.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid comment");
      return value as VerificationCommentInput;
    });
  });
}

function collectTargetGeneration(options: CollectStewardshipEvidenceOptions, runGh: GhRunner, runGit: StewardshipEvidenceGit,
  generatedAt: string, mainBefore: string, checkBasis: () => void): StewardshipTargetGeneration {
  const issueNumber = options.selection!.mode === "targeted" ? options.selection!.issueNumbers[0] : 0;
  const policySha256 = canonicalJsonSha256(options.policyEvidence);
  type TargetReads = NonNullable<Extract<StewardshipTargetResult, { status: "ok" }>["targetCompleteness"]>["reads"];
  const reads: TargetReads[number][] = [];
  const requiredReads = options.targetReadback ? READBACK_TARGET_READS : REQUIRED_TARGET_READS;
  const readsComplete = (completed: typeof reads): completed is [...TargetReads] =>
    completed.length === requiredReads.length && completed.every((read, index) => read === requiredReads[index]);
  let stage = "anchorA";
  const observe = (): StewardshipTargetResult => {
    try {
      const first = captureTargetAnchor(options, runGh, issueNumber, generatedAt);
      reads.push("anchorA");
      checkBasis();
      const issue = first.issues[0];
      if (issue.state === "CLOSED") return { issueNumber, status: "absent" };
      const hydrate = () => timeEvidenceSync(options.phaseTiming, "collect.hydration", () => {
        // The shared relationship pager rejects missing cursors. Bound repeated
        // continuation requests here, once per hydration, without changing it.
        const relationshipPages = new Set<string>();
        const hydrationGh: GhRunner = (args) => {
          if (args.some((arg) => arg.startsWith("query=") && arg.includes("RoadmapIssueRelationshipV2"))) {
            const key = canonicalJsonSha256(args);
            if (relationshipPages.has(key)) throw new Error("Repeated target relationship cursor");
            relationshipPages.add(key);
          }
          return runGh(args);
        };
        const value = (options.hydrateIssue ?? hydrateIssueSnapshotV2)({ repository: first.repository, issueNumber,
          projectMemberships: [], trustedVerificationAuthors: options.trustedVerificationAuthors, generatedAt, originMainSha: mainBefore, runGh: hydrationGh });
        if (value.identity.number !== issueNumber || value.identity.databaseId !== issue.databaseId || value.identity.nodeId !== issue.nodeId
          || canonicalJsonSha256(value.identity.repository) !== canonicalJsonSha256(first.repository)) throw new Error("Target hydration identity mismatch");
        return value;
      });
      stage = "hydration1";
      const before = hydrate();
      reads.push("hydration1");
      stage = "history";
      const history = timeEvidenceSync(options.phaseTiming, "collect.history", () => fullHistory(options, runGh, issueNumber, generatedAt));
      if (STEWARDSHIP_NATIVE_FIELDS.some((field) => !history.history[field]?.frontier.complete) || !history.history.reopenHistoryComplete
        || new Set(history.rows.map((row) => row.id)).size !== history.rows.length
        || history.rows.some((row) => !string(row.id))) throw new Error("Incomplete target history");
      reads.push("history");
      stage = "comments";
      const comments = readObservationComments(options, runGh, issueNumber);
      reads.push("comments");
      stage = "hydration2";
      const after = options.targetReadback ? before : hydrate();
      if (!options.targetReadback) reads.push("hydration2");
      // Hydration includes relationships; both successful reads must supply them.
      if ([before, after].every((value) => value.relationships && Object.hasOwn(value.relationships, "parent")
        && ["subIssues", "blockedBy", "blocking"].every((field) => Array.isArray(object(value.relationships)[field])))) reads.push("relationships");
      stage = "anchorB";
      const second = captureTargetAnchor(options, runGh, issueNumber, generatedAt);
      reads.push("anchorB");
      const last = second.issues[0];
      if (canonicalJsonSha256(first.repository) !== canonicalJsonSha256(second.repository)
        || (last && (last.nodeId !== issue.nodeId || last.databaseId !== issue.databaseId))) throw new Error("Target anchor identity mismatch");
      if (last.state === "CLOSED") return { issueNumber, status: "absent" };
      stage = "reconciliation";
      // Compare censusMaterial's repository/issue identity, title, body hash,
      // state/reason, createdAt, author, fields and reopen history, plus each
      // timeline head through historyMaterial (events, IDs, completeness, hash).
      // updatedAt is deliberately not material.
      if (canonicalJsonSha256(censusMaterial(first)) !== canonicalJsonSha256(censusMaterial(second))
        || (!options.targetReadback && !sameHydration([before], [after]))
        || [first, second].some((anchor) => history.totalCount !== anchor.timeline.totalCount
          || canonicalJsonSha256(history.rows.slice(history.rows.length - anchor.timeline.rows.length)) !== canonicalJsonSha256(anchor.timeline.rows))) {
        return { issueNumber, status: "unstable", cause: "target_reconciliation" };
      }
      assertHydrationMatchesCensus(first.issues, [before]);
      assertHydrationMatchesCensus(second.issues, [after]);
      stage = "completeness";
      if (!readsComplete(reads)) throw new Error("Incomplete target reads");
      stage = "packet";
      const packet = packetFor(options, runGit, issue, after, history.history, mainBefore, policySha256);
      assertStewardshipPacketSafe(packet, options.configuredSensitiveValues);
      if (packet.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) throw new Error("Stale nomination");
      return { issueNumber, status: "ok", packet, comments, commentsComplete: true,
        targetCompleteness: { complete: true, reads } };
    } catch (error) {
      if (error instanceof StewardshipEvidenceCollectionError && error.snapshotWide) throw error;
      return { issueNumber, status: stage === "reconciliation" || (error instanceof StewardshipEvidenceCollectionError && error.code === "mixed_generation")
        ? "unstable" : "unavailable", cause: `target_${stage}`,
        ...(error instanceof StewardshipEvidenceCollectionError ? { nextEligibleAt: error.nextEligibleAt } : {}) };
    }
  };
  const result = observe();
  // Includes packet sources, even when the target read failed or the issue closed.
  checkBasis();
  return { originMainSha: mainBefore, policySha256, targetResults: [result] };
}

function hasRedirectStatus(response: string): boolean {
  const lines = response.split(/\r?\n/);
  const statusLine = /^HTTP\/\S+\s+(\d{3})/i;
  let index = 0;
  while (index < lines.length) {
    const status = statusLine.exec(lines[index]);
    if (!status) return false;
    if (Number(status[1]) >= 300 && Number(status[1]) < 400) return true;
    index++;
    // Interim responses may lead directly into the next status line without a
    // blank separator. Only scan headers; stop at body data after the separator.
    while (index < lines.length && lines[index] !== "" && !statusLine.test(lines[index])) index++;
    if (lines[index] === "") index++;
  }
  return false;
}

function collectGeneration(options: CollectStewardshipEvidenceOptions, generation: number, pin: { sha?: string }): StewardshipEvidenceGeneration | StewardshipTargetGeneration {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidencePhase = options.evidencePhase ?? "initial";
  const countedGh = options.runGh;
  if (!countedGh) throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1, "A read-only GitHub runner is required."), { snapshotWide: true as const });
  let compareHttpStatus: number | null = null;
  let repositoryReadSucceeded = false;
  const runGh = retryRunner(((args) => {
    try {
      let value: string;
      try { value = countedGh(args); }
      catch (error) {
        const detail = object(error);
        try {
          if (options.phaseTiming && detail.status === 1 && Object.hasOwn(detail, "stdout")) {
            const stdout = Buffer.isBuffer(detail.stdout) ? detail.stdout.toString("utf8") : typeof detail.stdout === "string" ? detail.stdout : "";
            options.phaseTiming.includedResponse(stdout);
          }
        } catch { /* Preserve the original transport error. */ }
        throw error;
      }
      // The canonical preflight hydrator shares this runner, so its included
      // headers are counted here once without changing its evidence metadata.
      try { options.phaseTiming?.includedResponse(value); } catch { /* Preserve the successful read. */ }
      if (options.targetObservation && hasRedirectStatus(value)) {
        throw new StewardshipEvidenceCollectionError("read_exhausted", 1, "Target read redirected.", null, "transport");
      }
      inspectStructuredReadBlock(value);
      repositoryReadSucceeded = true;
      return value;
    }
    catch (error) {
      if (args.includes(`/repos/${options.repo.fullName}/compare/${pin.sha}...main`)) {
        compareHttpStatus = normalizeReadError(error).status;
        // Only a prior successful repository read distinguishes an invalid pin
        // or range from an access failure hidden behind the same HTTP status.
        if (repositoryReadSucceeded && (compareHttpStatus === 404 || compareHttpStatus === 422)) {
          throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
            "GitHub main comparison cannot resolve the evidence pin or range."), { snapshotWide: true as const, compareStatus: compareHttpStatus });
        }
      }
      throw error;
    }
  }) satisfies GhRunner, options, true);
  const rawGit = options.runGit ?? runCredentialCleanGit;
  const runGit = retryRunner(((cwd, args, settings) => {
    try { return ["ls-tree", "cat-file", "grep"].includes(args[0])
      ? timeEvidenceSync(options.phaseTiming, "collect.gitSources", () => rawGit(cwd, args, settings)) : rawGit(cwd, args, settings); }
    catch (error) {
      // grep's no-match status is a successful empty discovery, not a transient
      // transport error. All diagnostics and other exit statuses still fail.
      const detail = object(error);
      if (args[0] === "grep" && detail.status === 1
          && String(detail.stdout ?? "") === "" && String(detail.stderr ?? "") === "") return "";
      throw error;
    }
  }) satisfies StewardshipEvidenceGit, options);
  const hydrate = options.hydrateIssue ?? hydrateIssueSnapshotV2;
  const mainBefore = assertMainSha(runGit(options.repoRoot, ["rev-parse", "--verify", "origin/main^{commit}"], { localObjectsOnly: true }));
  pin.sha ??= mainBefore;
  if (mainBefore !== pin.sha) throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", generation, "Local origin/main changed from the evidence pin."), { snapshotWide: true as const });
  // Each comparison proves ancestry and identifies main, replacing the former
  // commits/main reads without adding requests to unchanged daily runs.
  const compareMain = () => {
    let comparison: ReturnType<typeof readRestResourceWithMetadata>;
    compareHttpStatus = null;
    try { comparison = timeEvidenceSync(options.phaseTiming, "collect.mainCompare", () =>
      readRestResourceWithMetadata(runGh, `/repos/${options.repo.fullName}/compare/${mainBefore}...main`, generatedAt)); }
    catch (error) {
      if (error instanceof StewardshipEvidenceCollectionError) throw Object.assign(error, { compareStatus: compareHttpStatus });
      throw Object.assign(new StewardshipEvidenceCollectionError("invalid_evidence", 1,
        "GitHub main comparison returned malformed evidence."), { snapshotWide: true as const, compareStatus: null });
    }
    const transport = [...comparison.transport];
    const drift = mainComparison(object(comparison.value), mainBefore, () => {
      const remote = timeEvidenceSync(options.phaseTiming, "collect.mainCompare", () =>
        readRestResourceWithMetadata(runGh, `/repos/${options.repo.fullName}/commits/main`, generatedAt));
      transport.push(...remote.transport);
      return string(remote.value.sha);
    });
    return { ...comparison, transport, drift };
  };
  if (options.targetObservation) {
    // Keep the same ancestry, live-drift and local-pin guards before and after all reads.
    const checkBasis = () => {
      const comparison = compareMain();
      if (options.mode === "run" && comparison.drift.aheadBy > STEWARDSHIP_MAX_PIN_AHEAD_BY) {
        throw Object.assign(new StewardshipEvidenceCollectionError("stale_pin", 1, "The evidence pin exceeds the live run main drift bound."),
          { snapshotWide: true as const, compareStatus: comparison.value.status });
      }
      const local = assertMainSha(runGit(options.repoRoot, ["rev-parse", "--verify", "origin/main^{commit}"], { localObjectsOnly: true }));
      if (local !== mainBefore) throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", generation,
        "Local origin/main changed during collection."), { snapshotWide: true as const });
    };
    if (object(options.policyEvidence).limits !== undefined) parseStewardshipPolicy(options.policyEvidence);
    return collectTargetGeneration(options, runGh, runGit, generatedAt, mainBefore, checkBasis);
  }
  const first = timeEvidenceSync(options.phaseTiming, "collect.census.sweep", () => captureCensus(options, runGh, generatedAt));
  const comparisonBefore = compareMain();
  if (options.mode === "run" && comparisonBefore.drift.aheadBy > STEWARDSHIP_MAX_PIN_AHEAD_BY) {
    throw Object.assign(new StewardshipEvidenceCollectionError("stale_pin", 1, "The evidence pin exceeds the live run main drift bound."), { snapshotWide: true as const, compareStatus: comparisonBefore.value.status });
  }
  // Historical evidence-only callers supplied opaque policy evidence without limits.
  const limits = Object.assign({ hydratedIssues: 12 }, object(options.policyEvidence).limits === undefined ? STEWARDSHIP_LIMITS : parseStewardshipPolicy(options.policyEvidence).limits);
  const digestByIssue = Object.fromEntries(censusMaterial(first).issues.map((issue) => [issue.number, canonicalJsonSha256(issue)]));
  let blobsAtMain: Map<string, string> | undefined;
  if (options.priorCensusUpdatedAt !== undefined && options.selection?.mode !== "targeted"
    && Object.values(options.cachedSourcesByIssue ?? {}).some((sources) => sources.length > 0)) {
    // One credential-clean local tree read covers implementation, strategy and spec sources.
    const tree = runGit(options.repoRoot, ["ls-tree", "-r", "-z", mainBefore], { localObjectsOnly: true });
    blobsAtMain = parseStewardshipTreeBlobs(tree);
  }
  const needsRecheck = (issue: CensusIssue) => needsDailyRecheck(issue, options, generatedAt, digestByIssue[issue.number], blobsAtMain);
  const selectedIssueNumbers = selectIssues(first.issues, options.state, options.selection, generatedAt, limits.hydratedIssues, needsRecheck, options.targetResults, options.uncoveredIssueNumbers);
  const selected = first.issues.filter((issue) => selectedIssueNumbers.includes(issue.number));
  // Preserve the daily selection order in the legacy collection path.
  selected.sort((a, b) => selectedIssueNumbers.indexOf(a.number) - selectedIssueNumbers.indexOf(b.number));
  const targetResults = new Map<number, StewardshipTargetResult>();
  if (options.targetResults) for (const issueNumber of selectedIssueNumbers) {
    if (!selected.some((issue) => issue.number === issueNumber)) targetResults.set(issueNumber, { issueNumber, status: "absent" });
  }
  const targetRead = <T>(issueNumber: number, read: () => T): T | undefined => {
    if (targetResults.has(issueNumber)) return undefined;
    try { return read(); }
    catch (error) {
      if (!options.targetResults || (error instanceof StewardshipEvidenceCollectionError && error.snapshotWide)) throw error;
      targetResults.set(issueNumber, { issueNumber, status: "unavailable",
        ...(error instanceof StewardshipEvidenceCollectionError ? { nextEligibleAt: error.nextEligibleAt } : {}) });
      return undefined;
    }
  };
  const hydrateAll = () => selected.flatMap((issue) => {
    const hydrated = targetRead(issue.number, () => timeEvidenceSync(options.phaseTiming, "collect.hydration", () => {
      const value = hydrate({ repository: first.repository, issueNumber: issue.number, projectMemberships: [],
        trustedVerificationAuthors: options.trustedVerificationAuthors, generatedAt, originMainSha: mainBefore, runGh });
      if (options.targetResults && value.identity.number !== issue.number) throw new Error("Hydration returned a different target");
      return value;
    }));
    return hydrated ? [hydrated] : [];
  });
  const firstHydration = hydrateAll();
  const histories = new Map<number, CensusFieldHistory>();
  const historyTransport: TransportMetadataV2[] = [];
  for (const issue of selected) {
    const result = targetRead(issue.number, () => timeEvidenceSync(options.phaseTiming, "collect.history", () => fullHistory(options, runGh, issue.number, generatedAt)));
    if (!result) continue;
    histories.set(issue.number, result.history); historyTransport.push(...result.transport);
    if (options.targetResults && (!result.history.Priority.frontier.complete || !result.history.Horizon.frontier.complete
      || !result.history.Effort?.frontier.complete || !result.history.Lifecycle?.frontier.complete || !result.history.reopenHistoryComplete)) {
      targetResults.set(issue.number, { issueNumber: issue.number, status: "unavailable" });
    }
  }
  const newlyObservedTruncated = first.issues.filter((issue) => !options.targetResults && (options.adoption || (options.state && !options.state.issues[issue.number]))
    && (!issue.history.Priority.frontier.complete || !issue.history.Horizon.frontier.complete));
  if (options.adoption || newlyObservedTruncated.length > 0) {
    for (const issue of first.issues) {
      if (histories.has(issue.number) || !newlyObservedTruncated.some((entry) => entry.number === issue.number)) continue;
      const result = timeEvidenceSync(options.phaseTiming, "collect.history", () => fullHistory(options, runGh, issue.number, generatedAt));
      histories.set(issue.number, result.history); historyTransport.push(...result.transport);
    }
    for (const [issueNumber, history] of histories) {
      const check = timeEvidenceSync(options.phaseTiming, "collect.history", () => fullHistory(options, runGh, issueNumber, generatedAt));
      historyTransport.push(...check.transport);
      if (!history.Priority.frontier.complete || !history.Horizon.frontier.complete
        || canonicalJsonSha256(history) !== canonicalJsonSha256(check.history)) {
        throw new StewardshipEvidenceCollectionError("mixed_generation", generation, "Adoption requires stable complete field histories.");
      }
    }
  }
  const comments = new Map<number, readonly VerificationCommentInput[]>();
  if (options.withComments) for (const issue of selected) {
    const rows = targetRead(issue.number, () => readObservationComments(options, runGh, issue.number));
    if (rows) comments.set(issue.number, rows);
  }
  const secondHydration = hydrateAll();
  const second = timeEvidenceSync(options.phaseTiming, "collect.census.sweep", () => captureCensus(options, runGh, generatedAt));
  if (options.stabilityScope === "selected") {
    if (canonicalJsonSha256(first.repository) !== canonicalJsonSha256(second.repository)) {
      throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", generation, "Repository identity changed."), { snapshotWide: true as const });
    }
    const secondDigests = new Map(censusMaterial(second).issues.map((issue) => [issue.number, canonicalJsonSha256(issue)]));
    for (const issueNumber of selectedIssueNumbers) {
      if (digestByIssue[issueNumber] !== secondDigests.get(issueNumber)) {
        const prior = targetResults.get(issueNumber);
        targetResults.set(issueNumber, { issueNumber, status: "unstable",
          ...(prior && prior.status !== "ok" && prior.nextEligibleAt ? { nextEligibleAt: prior.nextEligibleAt } : {}) }); continue;
      }
      if (targetResults.has(issueNumber)) continue;
      const before = firstHydration.filter((issue) => issue.identity.number === issueNumber);
      const after = secondHydration.filter((issue) => issue.identity.number === issueNumber);
      try {
        if (before.length !== 1 || after.length !== 1 || !sameHydration(before, after)) throw new Error("Target changed");
        assertHydrationMatchesCensus(first.issues, before);
        assertHydrationMatchesCensus(second.issues, after);
      } catch { targetResults.set(issueNumber, { issueNumber, status: "unstable" }); }
    }
  } else {
    const comparable = (issues: readonly IssueSnapshotV2[]) => issues.filter((issue) => !targetResults.has(issue.identity.number));
    if (!sameHydration(comparable(firstHydration), comparable(secondHydration))) {
      throw new StewardshipEvidenceCollectionError("mixed_generation", generation, "Evidence changed during collection; discarded the whole generation.");
    }
    assertStableStewardshipCensus(first, second, generation);
    assertHydrationMatchesCensus(first.issues, comparable(firstHydration));
    assertHydrationMatchesCensus(second.issues, comparable(secondHydration));
  }
  const policySha256 = canonicalJsonSha256(options.policyEvidence);
  const packets: StewardshipIssueEvidencePacket[] = [];
  const deferredIssues: StewardshipEvidenceGeneration["deferredIssues"][number][] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const issueNumber = selected[index].number;
    if (targetResults.has(issueNumber)) continue;
    try {
      const hydrated = secondHydration.find((issue) => issue.identity.number === issueNumber)!;
      const packet = packetFor(options, runGit, selected[index], hydrated, histories.get(issueNumber)!, mainBefore, policySha256);
      assertStewardshipPacketSafe(packet, options.configuredSensitiveValues);
      if (options.targetResults && packet.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) {
        targetResults.set(issueNumber, { issueNumber, status: "unavailable" }); continue;
      }
      packets.push(packet);
      if (options.targetResults) targetResults.set(issueNumber, { issueNumber, status: "ok", packet,
        ...(options.withComments ? { comments: comments.get(issueNumber)!, commentsComplete: true as const } : {}) });
    } catch (error) {
      if (error instanceof StewardshipEvidenceCollectionError && error.snapshotWide) throw error;
      if (error instanceof StewardshipIssueDeferredError) deferredIssues.push({ issueNumber, reason: error.reason });
      else if (!options.targetResults) throw error;
      if (options.targetResults) targetResults.set(issueNumber, { issueNumber, status: "unavailable" });
    }
  }
  const baselines = first.issues.map((issue) => baseline(issue, policySha256, histories.get(issue.number)));
  // The binding proof must follow the last evidence read, including packet source
  // and excerpt reads. An earlier proof cannot catch a force-push during capture.
  const comparison = compareMain();
  const drift = comparison.drift;
  const mainAfter = assertMainSha(runGit(options.repoRoot, ["rev-parse", "--verify", "origin/main^{commit}"], { localObjectsOnly: true }));
  if (mainBefore !== mainAfter) throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", generation, "Local origin/main changed during collection."), { snapshotWide: true as const });
  if (options.mode === "run" && drift.aheadBy > STEWARDSHIP_MAX_PIN_AHEAD_BY) {
    throw Object.assign(new StewardshipEvidenceCollectionError("stale_pin", 1, "The evidence pin exceeds the live run main drift bound."), { snapshotWide: true as const, compareStatus: comparison.value.status });
  }
  const nowMembers = (census: typeof first) => census.issues.filter((issue) => issue.fields.Horizon === "Now")
    .map((issue) => issue.number).sort((a, b) => a - b);
  const nowMembershipStable = options.stabilityScope !== "selected"
    || canonicalJsonSha256(nowMembers(first)) === canonicalJsonSha256(nowMembers(second));
  const withoutHash: Omit<StewardshipEvidenceGeneration, "materialEvidenceSha256"> = {
    schemaVersion: "github-issue-roadmap-stewardship-evidence/v1", evidencePhase, generation, generatedAt,
    repository: first.repository, originMainSha: mainBefore, policySha256,
    ...(drift.remoteMainShaAtEnd === mainBefore ? {} : { mainDrift: drift }),
    census: { complete: nowMembershipStable, totalCount: first.issues.length, nowCount: nowMembers(first).length,
      issueNumbers: first.issues.map((issue) => issue.number), members: first.issues.map((issue) => ({ issueNumber: issue.number, state: issue.state,
        fields: { "Sort key": issue.fields["Sort key"] ?? null } })),
      updatedAtByIssue: Object.fromEntries(first.issues.filter((issue) => issue.updatedAt !== null).map((issue) => [issue.number, issue.updatedAt!])), digestByIssue },
    ...(options.priorCensusUpdatedAt === undefined || options.selection?.mode === "targeted" ? {} : {
      skippedUnchangedIssueNumbers: first.issues.filter((issue) => !needsRecheck(issue)).map((issue) => issue.number),
    }), selectedIssueNumbers, baselines, packets, deferredIssues,
    transport: [...first.transport, ...comparisonBefore.transport, ...historyTransport, ...second.transport, ...comparison.transport,
      ...firstHydration.flatMap((issue) => issue.transport), ...secondHydration.flatMap((issue) => issue.transport)],
  };
  const result: StewardshipEvidenceGeneration = { ...withoutHash, materialEvidenceSha256: stewardshipGenerationMaterialSha256(withoutHash) };
  assertStewardshipPacketSafe(result, options.configuredSensitiveValues);
  // Raw comments are observation data, not prompt evidence or archived packet material.
  return options.targetResults ? { ...result, targetResults: selectedIssueNumbers.map((issueNumber) =>
    targetResults.get(issueNumber) ?? { issueNumber, status: "unavailable" }) } : result;
}

function timeEvidenceSync<T>(timing: StewardshipTimingCollector | undefined,
  phase: Parameters<StewardshipTimingCollector["start"]>[0] | "collect.target.anchor", operation: () => T): T {
  let stop: (() => void) | undefined;
  // The collector stores phase keys dynamically. Keep this unit's additive key
  // local; the shared phase registry is outside the target-observation scope.
  try { stop = timing?.start(phase as Parameters<StewardshipTimingCollector["start"]>[0], true); } catch { /* Telemetry cannot skip reads or waits. */ }
  try { return operation(); }
  finally { try { stop?.(); } catch { /* Preserve the operation's result or error. */ } }
}

export function collectStewardshipEvidence(options: CollectStewardshipEvidenceOptions & { readonly targetObservation?: false }): StewardshipEvidenceGeneration;
export function collectStewardshipEvidence(options: CollectStewardshipEvidenceOptions & { readonly targetObservation: true }): StewardshipTargetGeneration;
export function collectStewardshipEvidence(options: CollectStewardshipEvidenceOptions): StewardshipEvidenceGeneration;
export function collectStewardshipEvidence(options: CollectStewardshipEvidenceOptions): StewardshipEvidenceGeneration | StewardshipTargetGeneration {
  validateLimits(options);
  const counter = options.githubRequests ?? emptyStewardshipGitHubRequests();
  const maxAttempts = (options.maxGenerationRetries ?? 2) + 1;
  const pin = { sha: options.pinnedMainSha };
  let last: StewardshipEvidenceCollectionError | null = null;
  for (let generation = 1; generation <= maxAttempts; generation += 1) {
    const countedOptions = options.runGh && (options.githubRequests || options.githubRequestFailures) ? { ...options,
      runGh: countStewardshipGitHubRequests(options.runGh, counter, options.githubRequestFailures) } : options;
    try { return collectGeneration(countedOptions, generation, pin); }
    catch (error) {
      if (!(error instanceof StewardshipEvidenceCollectionError)) {
        throw new StewardshipEvidenceCollectionError("read_exhausted", 1, "Evidence collection failed without exposing transport diagnostics.", null, "transport");
      }
      if (error.code !== "mixed_generation") throw error;
      last = error;
    }
  }
  throw Object.assign(new StewardshipEvidenceCollectionError("mixed_generation", maxAttempts, last?.message ?? "Evidence capture did not stabilize."),
    last?.snapshotWide ? { snapshotWide: true as const } : {});
}
