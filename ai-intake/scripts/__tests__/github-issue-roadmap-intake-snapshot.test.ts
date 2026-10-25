import { describe, expect, it } from "vitest";

import {
  collectIntakeCensusPass,
  detectIntakeCensusDrift,
} from "../github-issue-roadmap-intake-preflight";
import {
  assertFinalIntakeRevalidation,
  buildIntakeSnapshot,
  parseIntakeSnapshotV1,
  type IntakeCensusPass,
} from "../lib/github-issue-roadmap/intake-snapshot";
import { canonicalJsonSha256 } from "../lib/github-issue-roadmap/canonical-json";
import {
  assertReadOnlyGhArgs,
  createReadOnlyGhRunner,
} from "../lib/github-issue-roadmap/read-only-github-reader";
import { SOURCE_MARKER } from "../lib/github-issue-roadmap/source-marker";
import { assertIntakeSnapshotFreshForShadow } from "../lib/github-issue-roadmap/intake-shadow";
import { qualifyRepositoryIdentity, type CanonicalSnapshotV2 } from "../lib/github-issue-roadmap/snapshot-v2";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const REPOSITORY = qualifyRepositoryIdentity({
  organization: "example-org",
  name: "example-repo",
  databaseId: 11,
  nodeId: "R_repo",
});

function marker(fingerprint = SHA_A): string {
  return [
    SOURCE_MARKER,
    `source-fingerprint: ${fingerprint}`,
    `emission-content-sha256: ${SHA_B}`,
    "producer-kind: plan",
    "producer-version: v1",
    "stable-artifact-id: plan-1",
    "stable-outcome-id: outcome-1",
    "source-locator: docs/plans/plan-1.md",
  ].join("\n");
}

function pass(overrides: Partial<IntakeCensusPass> = {}): IntakeCensusPass {
  return {
    completedAt: "2026-08-20T12:00:00.000Z",
    repository: REPOSITORY,
    expectedIssueCount: 2,
    excludedPullRequestCount: 1,
    incompleteResults: false,
    coverage: { issues: "complete", bodies: "complete", comments: "complete", fields: "complete", relationships: "complete" },
    receipts: [
      { domain: "issues", endpoint: "/repos/example-org/example-repo/issues?state=all&per_page=100", page: 1, responseSha256: SHA_A, requestId: "REQ-1", fetchedAt: "2026-08-20T12:00:00.000Z", apiVersion: "2026-03-10" },
      { domain: "comments", endpoint: "/repos/example-org/example-repo/issues/2/comments?per_page=100", page: 1, responseSha256: SHA_B, requestId: "REQ-2", fetchedAt: "2026-08-20T12:00:00.000Z", apiVersion: "2026-03-10" },
    ],
    issues: [
      {
        number: 2, databaseId: 1002, nodeId: "I_2", repositoryFullName: "example-org/example-repo",
        title: "Open issue", state: "OPEN", stateReason: null, body: "No marker", updatedAt: "2026-08-20T11:00:00.000Z",
        nativeType: null, fieldValues: [], relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
        projectMemberships: [], evidence: [], comments: [],
      },
      {
        number: 7, databaseId: 1007, nodeId: "I_7", repositoryFullName: "example-org/example-repo",
        title: "Closed exact", state: "CLOSED", stateReason: "COMPLETED", body: marker(), updatedAt: "2026-08-19T11:00:00.000Z",
        nativeType: { id: "IT_1", name: "Feature" }, fieldValues: [], relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
        projectMemberships: [], evidence: [{ kind: "body", sha256: SHA_A }],
        comments: [{ databaseId: 70, nodeId: "IC_70", body: "evidence", author: "example-user", createdAt: "2026-08-19T12:00:00.000Z", updatedAt: "2026-08-19T12:00:00.000Z", deleted: false }],
      },
    ],
    ...overrides,
  };
}

function snapshot(single = pass(), bookendExcluded = single.excludedPullRequestCount) {
  return buildIntakeSnapshot({
    candidateSha256: SHA_A,
    canonicalSnapshotV2Sha256: SHA_B,
    generatedAt: "2026-08-20T12:00:01.000Z",
    pass: single,
    bookend: { completedAt: "2026-08-20T12:00:00.000Z", excludedPullRequestCount: bookendExcluded },
    projectObservation: { status: "unavailable", memberships: [], evidence: "permission_redacted" },
  });
}

describe("GitHub issue roadmap intake snapshot", () => {
  it("indexes one exact marker across bodies and comments, including a closed issue", () => {
    const value = snapshot();
    expect(value.schemaVersion).toBe("github-issue-roadmap-intake-snapshot/v1");
    expect(value.issues.map((issue) => [issue.number, issue.state])).toEqual([[2, "OPEN"], [7, "CLOSED"]]);
    expect(value.markerIndex[SHA_A]).toHaveLength(1);
    expect(value.markerIncidents).toEqual([]);
    expect(value.coverage.novelty).toBe("complete");
  });

  it("projects issue bodies verbatim and round-trips them through the snapshot parser", () => {
    const value = snapshot();
    const projected = value.issues.find((issue) => issue.number === 2);
    expect(projected?.body).toBe("No marker");
    expect(projected?.bodySha256).toBe(canonicalJsonSha256("No marker"));

    const parsed = parseIntakeSnapshotV1(JSON.parse(JSON.stringify(value)));
    expect(parsed.issues.find((issue) => issue.number === 2)?.body).toBe("No marker");
  });

  it("bounds projected issue bodies while hashing the full untruncated body", () => {
    const fullBody = "x".repeat(32_769);
    const base = pass();
    const value = snapshot(pass({
      issues: [{ ...base.issues[0], body: fullBody }, base.issues[1]],
    }));
    const projected = value.issues.find((issue) => issue.number === 2);

    expect(projected?.body).toBe(`${"x".repeat(32_768)}\n\n[body truncated at 32768 characters]`);
    expect(projected?.bodySha256).toBe(canonicalJsonSha256(fullBody));
    expect(projected?.bodySha256).not.toBe(canonicalJsonSha256(projected?.body));
  });

  it("indexes a valid marker in a comment", () => {
    const candidate = pass();
    const issue = candidate.issues[0];
    const moved = pass({ issues: [{ ...issue, comments: [{ databaseId: 21, nodeId: "IC_21", body: marker(), author: "example-user", createdAt: candidate.completedAt, updatedAt: candidate.completedAt, deleted: false }] }, candidate.issues[1]] });
    expect(snapshot(moved).markerIndex[SHA_A][0]).toMatchObject({ issueNumber: 2, source: "comment", commentDatabaseId: 21 });
  });

  it("reports body-claim conflicts and marker incidents without a global novelty veto", () => {
    const base = pass();
    const copied = pass({ issues: base.issues.map((issue) => ({ ...issue, body: marker() })) });
    expect(snapshot(copied).markerIncidents.map((entry) => entry.kind)).toContain("copied");
    expect(snapshot(copied).markerIncidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "copied", sourceFingerprint: SHA_A, source: "body" }),
    ]));

    const malformed = pass({ issues: [{ ...base.issues[0], body: `${SOURCE_MARKER}\nsource-fingerprint: changed` }, base.issues[1]] });
    expect(snapshot(malformed).coverage.novelty).toBe("complete");
    expect(snapshot(malformed).markerIncidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "malformed", sourceFingerprint: null }),
    ]));

    const modified = pass({ issues: [{ ...base.issues[0], body: "<!-- github-issue-roadmap-source:v2 -->" }, base.issues[1]] });
    expect(snapshot(modified).markerIncidents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "modified" })]));
  });

  it("reports deleted marker receipts", () => {
    const base = pass();
    const deleted = pass({ issues: [{ ...base.issues[0], comments: [{ databaseId: 22, nodeId: "IC_22", body: marker(), author: "example-user", createdAt: base.completedAt, updatedAt: base.completedAt, deleted: true }] }, base.issues[1]] });
    expect(snapshot(deleted).markerIncidents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "deleted" })]));
  });

  it("fails closed for incomplete mandatory coverage, count mismatch, or bookend disagreement", () => {
    expect(() => snapshot(pass({ coverage: { ...pass().coverage, comments: "incomplete" } }))).toThrow(/comments.*complete/i);
    expect(() => snapshot(pass({ expectedIssueCount: 3 }))).toThrow(/count/i);
    // The bookend saw a different number of pull requests filtered out of the same census,
    // so the two reads did not see the same world.
    expect(() => snapshot(pass(), pass().excludedPullRequestCount + 1))
      .toThrow(/pull-request exclusion count changed/i);
  });

  it("treats Project unavailability as optional observation", () => {
    const value = snapshot();
    expect(value.coverage.project).toBe("incomplete");
    expect(value.coverage.novelty).toBe("complete");
  });

  it("rejects wrong-repository relationships", () => {
    const base = pass();
    const bad = pass({ issues: [{ ...base.issues[0], relationships: { ...base.issues[0].relationships, parent: { number: 1, databaseId: 1, nodeId: "I_other", repositoryFullName: "other/repo" } } }, base.issues[1]] });
    expect(() => snapshot(bad)).toThrow(/relationship.*repository/i);
  });

  it("produces an unchanged content hash and blocks final-revalidation mutation", () => {
    expect(snapshot().contentSha256).toBe(snapshot().contentSha256);
    expect(() => assertFinalIntakeRevalidation(snapshot(), pass({ issues: pass().issues.map((issue) => issue.number === 2 ? { ...issue, body: "edited" } : issue) }))).toThrow(/final revalidation/i);
  });

  it("fully paginates state=all, excludes pull requests, and never relies on search absence", () => {
    let request = 0;
    const calls: string[] = [];
    const response = (body: unknown, next = false) => [
      "HTTP/2.0 200 OK",
      `x-github-request-id: REQ-${++request}`,
      "x-github-api-version-selected: 2026-03-10",
      ...(next ? ["link: <https://api.github.com/next>; rel=\"next\""] : []),
      "date: Thu, 20 Aug 2026 12:00:00 GMT",
      "",
      JSON.stringify(body),
    ].join("\r\n");
    const row = (issueNumber: number) => ({
      id: 1_000 + issueNumber, node_id: `I_${issueNumber}`, number: issueNumber,
      repository_url: "https://api.github.com/repos/example-org/example-repo",
      title: `Issue ${issueNumber}`, state: issueNumber === 7 ? "closed" : "open", state_reason: null,
      body: issueNumber === 7 ? marker() : "", updated_at: "2026-08-20T11:00:00Z", type: null,
    });
    const runGh = (args: readonly string[]) => {
      const endpoint = args.at(-1) ?? "";
      calls.push(endpoint);
      if (endpoint.includes("issues?state=all") && endpoint.endsWith("page=1")) {
        return response([row(2), { ...row(99), pull_request: {} }], true);
      }
      if (endpoint.includes("issues?state=all") && endpoint.endsWith("page=2")) return response([row(7)]);
      if (endpoint.includes("/issues/comments?") && endpoint.endsWith("page=1")) return response([
        { id: 21, node_id: "IC_21", issue_url: "https://api.github.com/repos/example-org/example-repo/issues/2",
          body: marker(), user: { login: "example-user" }, created_at: "2026-08-20T11:00:00Z", updated_at: "2026-08-20T11:00:00Z" },
        { id: 99, node_id: "IC_99", issue_url: "https://api.github.com/repos/example-org/example-repo/issues/99", body: marker() },
      ], true);
      if (endpoint.includes("/issues/comments?") && endpoint.endsWith("page=2")) return response([]);
      if (endpoint.includes("/issue-field-values?")) return response([]);
      throw new Error(`Unexpected read: ${endpoint}`);
    };
    const result = collectIntakeCensusPass({
      canonicalSnapshot: { repository: REPOSITORY, issues: [] } as unknown as CanonicalSnapshotV2,
      completedAt: "2026-08-20T12:00:00.000Z",
      runGh,
    });
    expect(result.issues.map((issue) => issue.number)).toEqual([2, 7]);
    expect(result.excludedPullRequestCount).toBe(1);
    expect(calls[0]).toContain("state=all");
    expect(calls.some((call) => call.includes("search"))).toBe(false);
    const collected = snapshot(result);
    const perIssueFixture = { ...result, issues: result.issues.map(issue => ({ ...issue, comments: issue.number !== 2 ? [] : [{
      databaseId: 21, nodeId: "IC_21", body: marker(), author: "example-user", createdAt: "2026-08-20T11:00:00Z",
      updatedAt: "2026-08-20T11:00:00Z", deleted: false,
    }] })) };
    expect(collected.markerIndex).toEqual(snapshot(perIssueFixture).markerIndex);
    expect(collected.markerIndex[SHA_A].map(location => location.issueNumber)).toEqual([2, 7]);
    const parsed = parseIntakeSnapshotV1(JSON.parse(JSON.stringify(collected)));
    expect(parsed.receipts.filter(receipt => receipt.domain === "comments").map(receipt => ({ endpoint: receipt.endpoint, page: receipt.page })))
      .toEqual([1, 2].map(page => ({ endpoint: "/repos/example-org/example-repo/issues/comments?per_page=100", page })));
    expect(() => assertIntakeSnapshotFreshForShadow(parsed, new Date("2026-08-20T12:00:01.000Z"))).not.toThrow();
  });
});

describe("fixed read-only GitHub reader", () => {
  it.each([
    [["issue", "create", "--title=x"]],
    [["api", "--method", "POST", "/repos/o/r/issues"]],
    [["api", "-XDELETE", "/repos/o/r/issues/1"]],
    [["api", "/repos/o/r/issues", "-f", "title=x"]],
    [["api", "graphql", "-f", "query=mutation { addProjectV2ItemById(input:{}) { clientMutationId } }"]],
    [["api", "graphql", "--input=payload.json", "-f", "query=query { viewer { login } }"]],
  ])("rejects a mutation vector: %j", (args) => {
    expect(() => assertReadOnlyGhArgs(args)).toThrow(/read-only|mutat|only.*api/i);
  });

  it("rejects ambient mutation credentials and permits pinned reads", () => {
    expect(() => createReadOnlyGhRunner({ execute: () => "{}", environment: { GH_TOKEN: "ambient-write-token" } })).toThrow(/ambient.*credential/i);
    const calls: string[][] = [];
    const runner = createReadOnlyGhRunner({ execute: (_file, args) => { calls.push([...args]); return "{}"; }, environment: { GH_READ_ONLY_TOKEN: "read-token" } });
    expect(runner(["api", "/user"])).toBe("{}");
    expect(calls[0]).toEqual(["api", "--hostname", "github.com", "/user"]);
  });
});

/**
 * Receipt element validation belongs to the parser, not to one consumer. Every consumer of a
 * persisted snapshot inherits whatever `parseIntakeSnapshotV1` is willing to accept, so a receipt
 * that is not an object, carries no endpoint, names a domain outside the closed set, or bears an
 * unparseable observation time must be refused here rather than downstream. Clock-relative
 * questions (age, future-dating) stay with the consumer that owns a clock.
 */
describe("intake snapshot receipt parsing", () => {
  const withReceipts = (receipts: readonly unknown[]) => ({ ...snapshot(), receipts });

  it("accepts the receipts a real census produced", () => {
    const value = snapshot();
    expect(parseIntakeSnapshotV1(value).receipts).toHaveLength(value.receipts.length);
  });

  it("refuses a receipt that is not an object", () => {
    expect(() => parseIntakeSnapshotV1(withReceipts(["/issues"]))).toThrow(/receipts\[0\] must be an object/i);
    expect(() => parseIntakeSnapshotV1(withReceipts([null]))).toThrow(/receipts\[0\] must be an object/i);
  });

  it("refuses a receipt with an empty endpoint", () => {
    const [receipt] = snapshot().receipts;
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, endpoint: "   " }]))).toThrow(/endpoint/i);
  });

  it("refuses a receipt whose domain is outside the closed set", () => {
    const [receipt] = snapshot().receipts;
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, domain: "discussions" }]))).toThrow(/domain/i);
  });

  it("refuses a receipt whose fetchedAt cannot be parsed", () => {
    const [receipt] = snapshot().receipts;
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, fetchedAt: "not-a-timestamp" }]))).toThrow(/fetchedAt/i);
  });

  /**
   * `validateReadReceipt` carries seven field checks; three of them were tested. Deleting the
   * `page` and `apiVersion` checks left all eighty tests in the affected suites passing, which is
   * the definition of an unheld invariant: the parser is the only thing standing between a
   * persisted snapshot and every consumer of it, so an untested check is a check that can be
   * removed by accident.
   */
  it("refuses a page that is not a non-negative safe integer", () => {
    const [receipt] = snapshot().receipts;
    for (const page of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, page }])), String(page)).toThrow(/page/i);
    }
    // null is the legitimate "not a paged read" value. Any edit to a receipt breaks the snapshot's
    // content hash, so the assertion is that null is not rejected *by the page check* rather than
    // that the whole snapshot still parses.
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, page: null }]))).not.toThrow(/page/i);
  });

  it("refuses a responseSha256 that is not a sha-256 digest", () => {
    const [receipt] = snapshot().receipts;
    for (const responseSha256 of ["", "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, responseSha256 }])), responseSha256)
        .toThrow(/responseSha256/i);
    }
  });

  it("refuses an empty request ID, which is the only proof the read reached GitHub", () => {
    const [receipt] = snapshot().receipts;
    for (const requestId of ["", "   "]) {
      expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, requestId }])), JSON.stringify(requestId))
        .toThrow(/request ID/i);
    }
  });

  it("refuses a receipt from a different REST API version", () => {
    // A census that mixed API versions did not observe one consistent GitHub, and the field shapes
    // a later consumer reads are version-dependent.
    const [receipt] = snapshot().receipts;
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, apiVersion: "2022-11-28" }]))).toThrow(/apiVersion/i);
  });

  it("detects drift the bookend index can see: moved, appeared, and disappeared issues", () => {
    const base = pass();
    const index = (entries: [number, string][]) => ({
      updatedAt: new Map(entries),
      excludedPullRequestCount: base.excludedPullRequestCount,
      completedAt: base.completedAt,
      receipts: [],
    });
    const unchanged = base.issues.map((issue) => [issue.number, issue.updatedAt] as [number, string]);

    expect(detectIntakeCensusDrift(base, index(unchanged)))
      .toEqual({ appearedIssueNumbers: [], disappearedIssueNumbers: [], movedIssueNumbers: [] });

    const bumped = unchanged.map(([number]) => [number, "2099-01-01T00:00:00.000Z"] as [number, string]);
    expect(detectIntakeCensusDrift(base, index(bumped)).movedIssueNumbers)
      .toEqual(base.issues.map((issue) => issue.number).sort((a, b) => a - b));

    expect(detectIntakeCensusDrift(base, index([...unchanged, [4242, "2026-08-20T12:00:00.000Z"]])))
      .toMatchObject({ appearedIssueNumbers: [4242], disappearedIssueNumbers: [], movedIssueNumbers: [] });

    expect(detectIntakeCensusDrift(base, index(unchanged.slice(1))))
      .toMatchObject({ appearedIssueNumbers: [], disappearedIssueNumbers: [unchanged[0][0]], movedIssueNumbers: [] });
  });

  it("compares updatedAt as instants, so a normalized snapshot matches the REST index", () => {
    const base = pass();
    const index = (entries: [number, string][]) => ({ updatedAt: new Map(entries),
      excludedPullRequestCount: base.excludedPullRequestCount, completedAt: base.completedAt, receipts: [] });
    const normalized = { issues: base.issues.map((issue) => ({ number: issue.number, updatedAt: new Date(issue.updatedAt).toISOString() })) };
    const rest = base.issues.map((issue) => [issue.number, new Date(issue.updatedAt).toISOString().replace(".000Z", "Z")] as [number, string]);
    expect(rest.some(([, stamp]) => !stamp.includes("."))).toBe(true);
    expect(detectIntakeCensusDrift(normalized, index(rest)).movedIssueNumbers).toEqual([]);
    expect(detectIntakeCensusDrift(normalized, index(rest.map(([number]) => [number, "not a time"] as [number, string]))).movedIssueNumbers)
      .toHaveLength(base.issues.length);
  });

  it("leaves clock-relative freshness to the consumer", () => {
    const [receipt] = snapshot().receipts;
    // Syntactically valid, so the parser passes it through: age is not a parse-time question.
    expect(() => parseIntakeSnapshotV1(withReceipts([{ ...receipt, fetchedAt: "2099-01-01T00:00:00.000Z" }])))
      .not.toThrow(/fetchedAt/i);
  });
});
