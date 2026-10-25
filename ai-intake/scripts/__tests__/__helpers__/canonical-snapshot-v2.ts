import { createHash } from "node:crypto";

import {
  ISSUE_SNAPSHOT_SCHEMA,
  buildCanonicalSnapshotV2,
  gitSha,
  qualifyIssueIdentity,
  qualifyRepositoryIdentity,
  verificationFreshness,
  type CanonicalSnapshotV2,
  type IssueSnapshotV2,
} from "../../lib/github-issue-roadmap/snapshot-v2";

/**
 * A fully valid CanonicalSnapshotV2 — one that survives `parseCanonicalSnapshotV2`, unlike the
 * partial `as unknown as` casts used where only a few fields are read. Composition roots that parse
 * their inputs (the reconciliation CLI) need this shape.
 */

export const HELPER_ORIGIN_MAIN_SHA = "a".repeat(40);

export const HELPER_REPOSITORY = qualifyRepositoryIdentity({
  organization: "example-org", name: "example-repo", databaseId: 11, nodeId: "R_repo",
});

function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function v1Issue(number: number) {
  return {
    number, title: `Issue ${number}`, state: "OPEN", stateReason: null, type: null,
    fieldValues: [], labels: [], assignees: [], milestone: null,
    bodySha256: bodySha256(`body ${number}`),
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
    relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
  } as const;
}

function v2Issue(number: number): IssueSnapshotV2 {
  return {
    schemaVersion: ISSUE_SNAPSHOT_SCHEMA,
    identity: qualifyIssueIdentity(HELPER_REPOSITORY, {
      number, databaseId: 1_000 + number, nodeId: `I_${number}`, repositoryFullName: "example-org/example-repo",
    }),
    v1: v1Issue(number),
    nativeType: null,
    relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
    projectMemberships: [], persistedVerifications: [], pullRequests: [],
    freshness: verificationFreshness([], "2026-08-20T00:00:00Z", HELPER_ORIGIN_MAIN_SHA),
    transport: [{
      endpoint: `/repos/example-org/example-repo/issues/${number}`, status: 200,
      requestId: `REQ-issue-${number}`, fetchedAt: "2026-08-20T00:00:00.000Z",
      page: null, apiVersionSelected: "2026-03-10", deprecationAt: null, sunsetAt: null,
    }],
  } as IssueSnapshotV2;
}

export function validCanonicalSnapshotV2(issueNumbers: readonly number[] = [9, 2]): CanonicalSnapshotV2 {
  return buildCanonicalSnapshotV2({
    generatedAt: "2026-08-20T00:00:00Z",
    repository: HELPER_REPOSITORY,
    restVersion: "2026-03-10",
    graphqlCapabilityProof: {
      checkedAt: "2026-08-19T23:59:30Z", requestIds: ["REQ-graphql-proof"],
      issueFields: ["subIssues", "parent", "blocking", "blockedBy"],
      projectV2Fields: ["items"], projectV2ItemFields: ["id", "content"],
      allRequiredCapabilitiesPresent: true,
    },
    sourceIdentities: {
      strategy: { path: "STRATEGY.md", blobSha: gitSha("b".repeat(40)), commitSha: gitSha(HELPER_ORIGIN_MAIN_SHA) },
      rubric: { path: "docs/runbooks/github-issue-roadmap.md", blobSha: gitSha("c".repeat(40)), commitSha: gitSha(HELPER_ORIGIN_MAIN_SHA) },
    },
    organizationIssueFields: { totalCount: 1, definitions: [{ id: 10, name: "Priority" }] },
    reconciliation: { counts: { repositories: 1, issueFields: 1, projects: 1, openIssues: 2 }, allMatch: true, allVerified: true },
    originMainSha: HELPER_ORIGIN_MAIN_SHA,
    originMainFetchedAt: "2026-08-19T23:59:00Z",
    remoteFetchMaximumAgeMs: 5 * 60 * 1_000,
    census: {
      totalCount: 2, issueNumbers: [...issueNumbers], nowIssueNumbers: [],
      excludedPullRequestCount: 1, verifiedStableByDoubleRead: true, countReconciled: true,
    },
    consideredIssueNumbers: [...issueNumbers],
    issues: issueNumbers.map(v2Issue),
    transport: [{
      endpoint: "graphql:canonical snapshot schema capabilities", status: 200,
      requestId: "REQ-graphql-proof", fetchedAt: "2026-08-19T23:59:30.000Z",
      page: null, apiVersionSelected: null, deprecationAt: null, sunsetAt: null,
    }, {
      endpoint: "/repos/example-org/example-repo/commits/main", status: 200,
      requestId: "REQ-main", fetchedAt: "2026-08-20T00:00:00.000Z",
      page: null, apiVersionSelected: "2026-03-10", deprecationAt: null, sunsetAt: null,
    }],
  } as never);
}
