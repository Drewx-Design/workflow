import {
  assessmentStackSha256,
  intakeSnapshotCoverageSha256,
  parseIntakeAssessment,
  type AssessmentStackIdentity,
  type IntakeAssessment,
} from "../../lib/github-issue-roadmap/intake-assessment";
import {
  compileIntakeDecision,
  type IntakeCapabilityManifest,
  type IntakeDecision,
} from "../../lib/github-issue-roadmap/intake-decision";
import {
  buildIntakeSnapshot,
  type IntakeCensusPass,
  type IntakeIssueInput,
  type IntakeSnapshotV1,
} from "../../lib/github-issue-roadmap/intake-snapshot";
import { canonicalJsonSha256 } from "../../lib/github-issue-roadmap/canonical-json";
import {
  createExistenceRecord,
  type ExistenceEntryInput,
  type ExistenceRecordV1,
} from "../../lib/github-issue-roadmap/existence-record";
import {
  createOutcomeEnvelope,
  type OutcomeCandidate,
  type OutcomeEnvelope,
  type OutcomeEnvelopeDraft,
} from "../../lib/github-issue-roadmap/outcome-candidate";
import { SOURCE_MARKER } from "../../lib/github-issue-roadmap/source-marker";
import { parseCanonicalSnapshotV2, qualifyRepositoryIdentity, type CanonicalSnapshotV2 } from "../../lib/github-issue-roadmap/snapshot-v2";
import type { SharedCensusBundle } from "../../lib/github-issue-roadmap/shared-census-store";
import type { GhRunner } from "../../lib/github-issue-roadmap/read-only-github-reader";
import { readBoardFingerprint } from "../../lib/github-issue-roadmap/board-fingerprint";
import { readGraphqlWithMetadata } from "../../github-issue-roadmap-preflight";

/**
 * Shared builders for a real intake evidence stack - census pass, snapshot, assessment, and a
 * compiled decision. Execution recompiles the decision from this evidence, so any test that reaches
 * the write path must present genuine, mutually bound artifacts rather than a hand-authored object.
 */

const SHA = (character: string) => character.repeat(64);
export const STACK_A = SHA("a");
export const STACK_B = SHA("b");
export const STACK_C = SHA("c");
export const STACK_ORIGIN_MAIN_SHA = "a".repeat(40);

export const STACK_GENERATED_AT = "2026-08-20T12:00:01.000Z";
export const STACK_CENSUS_AT = "2026-08-20T12:00:00.000Z";
export const STACK_ASSESSED_AT = "2026-08-20T12:00:02.000Z";

export const STACK_REPOSITORY = qualifyRepositoryIdentity({
  organization: "example-org", name: "example-repo", databaseId: 123, nodeId: "R_repo",
});

export const ASSESSMENT_STACK: AssessmentStackIdentity = {
  provider: "openai", model: "gpt-test", promptSha256: STACK_A, rubricSha256: STACK_B,
  toolchainSha256: STACK_C, calibrationRelease: "fixture-only-2026-08-20",
};

/** A ready, current-main-verified envelope: the only shape that can compile an automatic create. */
export function stackEnvelope(
  count = 1,
  readinessOverrides: Record<string, unknown> = {},
  suggestionOverrides: Record<string, unknown> = {},
): OutcomeEnvelope {
  return createOutcomeEnvelope({
    schemaVersion: "github-issue-roadmap-outcome-envelope/v1",
    repository: STACK_REPOSITORY,
    producer: { kind: "plan", version: "1" },
    artifact: {
      stableId: "plan:ai-managed-roadmap-intake", revisionSha256: STACK_A,
      sourceLocator: "docs/plans/ai-managed-roadmap-intake.md",
    },
    candidates: Array.from({ length: count }, (_unused, index) => ({
      stableOutcomeId: `shared-outcome-${index + 1}`,
      outcome: {
        title: `Adopt the shared outcome contract ${index + 1}`,
        completionRule: "Every registered producer emits a valid envelope.",
        affectedSystems: ["roadmap-intake", "producer-contract"],
      },
      evidence: [
        { id: "evidence-current", kind: "current_main_verification", sourceLocator: "scripts/github-issue-roadmap-intake.ts", contentSha256: STACK_A },
        { id: "evidence-strategy", kind: "approved_strategy", sourceLocator: "STRATEGY.md", contentSha256: STACK_B },
      ],
      provenance: [{ id: "plan-origin", sourceLocator: "docs/plans/ai-managed-roadmap-intake.md", contentSha256: STACK_C }],
      readiness: {
        independentlyCloseable: true, framingComplete: true, completionRuleDefined: true,
        evidenceSufficient: true, estimationSubstrate: true, unresolvedDecisionIds: [], dependencyIds: [],
        currentMainVerificationEvidenceId: "evidence-current",
        ...readinessOverrides,
      },
      relationshipCandidates: [],
      suggestions: {
        type: { value: "Feature", confidence: "high", rationale: "A new product capability." },
        priority: { value: "P2", confidence: "high", rationale: "The roadmap contract is approved." },
        effort: { value: "Medium", confidence: "high", rationale: "The implementation substrate is known." },
        ...suggestionOverrides,
      },
    })),
  } as unknown as OutcomeEnvelopeDraft);
}

/** Render a canonical marker block, optionally for a different emission of the same candidate. */
export function markerBlock(
  envelope: OutcomeEnvelope,
  candidate: OutcomeCandidate,
  emissionContentSha256 = candidate.emissionContentSha256,
): string {
  return [
    SOURCE_MARKER,
    `source-fingerprint: ${candidate.sourceFingerprint}`,
    `emission-content-sha256: ${emissionContentSha256}`,
    `producer-kind: ${envelope.producer.kind}`,
    `producer-version: ${envelope.producer.version}`,
    `stable-artifact-id: ${envelope.artifact.stableId}`,
    `stable-outcome-id: ${candidate.stableOutcomeId}`,
    `source-locator: ${envelope.artifact.sourceLocator}`,
  ].join("\n");
}

export function censusIssue(overrides: Partial<IntakeIssueInput> = {}): IntakeIssueInput {
  return {
    number: 7, databaseId: 7, nodeId: "I_7", repositoryFullName: "example-org/example-repo",
    title: "Existing outcome", state: "OPEN", stateReason: null, body: "", updatedAt: "2026-08-20T11:00:00.000Z",
    nativeType: null, fieldValues: [], relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
    projectMemberships: [],
    evidence: [{ id: "strong-current-main", authority: "current_main", observedAt: "2026-08-20T11:00:00.000Z" }],
    comments: [], ...overrides,
  };
}

export function censusPass(issues: readonly IntakeIssueInput[] = [censusIssue()]): IntakeCensusPass {
  return {
    completedAt: STACK_CENSUS_AT, repository: STACK_REPOSITORY,
    expectedIssueCount: issues.length, excludedPullRequestCount: 0, incompleteResults: false,
    coverage: { issues: "complete", bodies: "complete", comments: "complete", fields: "complete", relationships: "complete" },
    // Every domain this pass declares complete carries a receipt. `assertSnapshotFreshness` reads
    // coverage claims, not just the novelty domains: a fixture that claimed `fields: "complete"`
    // with nothing attesting it was exactly the shape the read-shaped coverage check refuses.
    receipts: [
      { domain: "issues", endpoint: "/issues", page: 1, responseSha256: STACK_A, requestId: "REQ-1", fetchedAt: STACK_CENSUS_AT, apiVersion: "2026-03-10" },
      { domain: "comments", endpoint: "/comments", page: 1, responseSha256: STACK_B, requestId: "REQ-2", fetchedAt: STACK_CENSUS_AT, apiVersion: "2026-03-10" },
      { domain: "fields", endpoint: "/fields", page: 1, responseSha256: STACK_C, requestId: "REQ-3", fetchedAt: STACK_CENSUS_AT, apiVersion: "2026-03-10" },
      { domain: "relationships", endpoint: "/relationships", page: 1, responseSha256: STACK_A, requestId: "REQ-4", fetchedAt: STACK_CENSUS_AT, apiVersion: "2026-03-10" },
    ],
    issues: [...issues],
  };
}

export function stackSnapshot(envelope: OutcomeEnvelope, pass: IntakeCensusPass): IntakeSnapshotV1 {
  return buildIntakeSnapshot({
    candidateSha256: canonicalJsonSha256(envelope), canonicalSnapshotV2Sha256: STACK_C,
    generatedAt: STACK_GENERATED_AT, pass,
    bookend: { completedAt: STACK_GENERATED_AT, excludedPullRequestCount: pass.excludedPullRequestCount },
    projectObservation: { status: "unavailable", memberships: [], evidence: "permission_redacted" },
  });
}

/**
 * `replay` is here so a test can present an assessment the snapshot cannot corroborate: with no
 * marker for the fingerprint, `canonicalMatch` downgrades it to `invalid`, which is the only route
 * to the shadow `ambiguous_match` hold reason.
 */
export type StackMatch = "clearly_novel" | "plausible_overlap" | "replay";

export function stackAssessment(input: {
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly match?: (index: number) => StackMatch;
  readonly competingIssueNumbers?: readonly number[];
  readonly canonicalIssueNumber?: number;
}): IntakeAssessment {
  const match = input.match ?? (() => "clearly_novel" as StackMatch);
  const raw = {
    schemaVersion: "github-issue-roadmap-intake-assessment/v1",
    candidateSha256: canonicalJsonSha256(input.envelope),
    snapshotContentSha256: input.snapshot.contentSha256,
    snapshotCoverageSha256: intakeSnapshotCoverageSha256(input.snapshot),
    generatedAt: STACK_ASSESSED_AT, stack: ASSESSMENT_STACK,
    candidates: input.envelope.candidates.map((candidate, index) => ({
      sourceFingerprint: candidate.sourceFingerprint, emissionContentSha256: candidate.emissionContentSha256,
      match: {
        result: match(index), confidence: "high",
        canonicalIssueNumber: match(index) === "replay" ? (input.canonicalIssueNumber ?? 7) : null,
        competingIssueNumbers: match(index) === "plausible_overlap" ? [...(input.competingIssueNumbers ?? [7])] : [],
        evidenceIds: ["evidence-current"],
        rationale: "No canonical outcome has an equivalent completion rule.",
      },
      classification: {
        type: { value: "Feature", confidence: "high", evidenceIds: ["evidence-current"], rationale: "Bounded feature." },
        priority: { value: "P2", confidence: "high", evidenceIds: ["evidence-strategy"], rationale: "Meets P2 rubric." },
        effort: { value: candidate.suggestions.effort.value, confidence: "high", evidenceIds: ["evidence-current"], rationale: "Estimable substrate." },
        horizon: { value: null, confidence: "high", evidenceIds: ["evidence-strategy"], rationale: "Inbox is mandatory." },
      },
      relationships: [], completionContradicted: false,
    })),
    attention: {
      issueNumber: null, evidenceRefresh: "Refresh current-main verification.", decision: null, tradeoff: null,
      evidenceIds: ["evidence-current"], rationale: "No Now issue is both fresh and unblocked.",
    },
  };
  return parseIntakeAssessment(raw, input.envelope, input.snapshot, undefined, new Map());
}

export function stackCapabilityManifest(
  capabilities: readonly string[] = ["create_issue", "append_evidence", "set_type", "set_priority", "set_effort"],
): IntakeCapabilityManifest {
  return {
    schemaVersion: "github-issue-roadmap-intake-capability-manifest/v1",
    manifestId: "test-external-attestation", generatedAt: STACK_CENSUS_AT,
    entries: capabilities.map((capability) => ({
      capability: capability as IntakeCapabilityManifest["entries"][number]["capability"],
      qualification: "production", assessmentStackSha256: assessmentStackSha256(ASSESSMENT_STACK),
      calibrationRelease: ASSESSMENT_STACK.calibrationRelease, producerKinds: ["plan"],
      proofEvidenceId: `external:${capability}`,
    })),
  };
}

export function stackExistenceRecord(
  envelope: OutcomeEnvelope,
  entries: readonly ExistenceEntryInput[] = envelope.candidates.map((candidate) => ({
    sourceFingerprint: candidate.sourceFingerprint,
    emissionContentSha256: candidate.emissionContentSha256,
    evidence: {
      clauses: [{ clause: candidate.outcome.completionRule, satisfied: false as const }],
      searchAttestation: {
        scope: ["origin/main"], budgetConsumed: 1, clausesEvaluated: 1, clausesTotal: 1,
      },
    },
  })),
  originMainSha = STACK_ORIGIN_MAIN_SHA,
): ExistenceRecordV1 {
  return createExistenceRecord({
    repository: STACK_REPOSITORY,
    originMainSha,
    generatedAt: STACK_CENSUS_AT,
    entries,
  });
}

export interface IntakeStack {
  readonly envelope: OutcomeEnvelope;
  readonly pass: IntakeCensusPass;
  readonly snapshot: IntakeSnapshotV1;
  readonly assessment: IntakeAssessment;
  readonly capabilityManifest: IntakeCapabilityManifest | null;
  readonly existenceRecord: ExistenceRecordV1;
  readonly decision: IntakeDecision;
}

export function buildIntakeStack(input: {
  readonly envelope?: OutcomeEnvelope;
  readonly issues?: readonly IntakeIssueInput[];
  readonly match?: (index: number) => StackMatch;
  readonly capabilities?: readonly string[] | null;
  readonly existenceEntries?: readonly ExistenceEntryInput[];
} = {}): IntakeStack {
  const envelope = input.envelope ?? stackEnvelope();
  const pass = censusPass(input.issues ?? [censusIssue()]);
  const snapshot = stackSnapshot(envelope, pass);
  const assessment = stackAssessment({ envelope, snapshot, match: input.match });
  const capabilityManifest = input.capabilities === null ? null : stackCapabilityManifest(input.capabilities);
  const existenceRecord = stackExistenceRecord(envelope, input.existenceEntries);
  const decision = compileIntakeDecision({
    dispositionHistory: new Map(),
    envelope, snapshot, assessment, capabilityManifest, existenceRecord,
    verifiedOriginMainSha: STACK_ORIGIN_MAIN_SHA,
  } as Parameters<typeof compileIntakeDecision>[0]);
  return { envelope, pass, snapshot, assessment, capabilityManifest, existenceRecord, decision };
}

export function canonicalFixture(repository: IntakeSnapshotV1["repository"], NOW: Date): CanonicalSnapshotV2 {
  return parseCanonicalSnapshotV2({
    schemaVersion: "github-issue-roadmap-canonical-snapshot/v3", generatedAt: NOW.toISOString(), repository,
    api: { restVersion: "2026-03-10", graphql: { checkedAt: NOW.toISOString(), requestIds: ["request"],
      issueFields: ["blockedBy", "blocking", "parent", "subIssues"], projectV2Fields: ["items"],
      projectV2ItemFields: ["content", "id"], allRequiredCapabilitiesPresent: true } },
    sourceIdentities: { strategy: { path: "STRATEGY.md", blobSha: "a".repeat(40), commitSha: "b".repeat(40) },
      rubric: { path: "docs/runbooks/github-issue-roadmap.md", blobSha: "c".repeat(40), commitSha: "b".repeat(40) } },
    organizationIssueFields: { totalCount: 0, definitions: [] },
    reconciliation: { counts: { repositories: 1, issueFields: 0, projects: 0, openIssues: 0 }, allMatch: true, allVerified: true },
    capabilityManifest: { status: "absent", identity: null, disposition: "recommendation_only", canEnableWrites: false },
    git: { originMainSha: "b".repeat(40), fetchedAt: NOW.toISOString(), freshness: "current" },
    census: { totalCount: 0, issueNumbers: [], nowIssueNumbers: [], excludedPullRequestCount: 0,
      verifiedStableByDoubleRead: true, countReconciled: true },
    coverage: { consideredIssueNumbers: [], affectedIssueNumbers: [], requiredIssueNumbers: [], hydratedIssueNumbers: [], missingIssueNumbers: [], complete: true },
    issues: [], capability: { comments: "available", relationships: "available", linkedPullRequests: "available", projectMembership: "available", requestMetadata: "available" },
    recovery: { mode: "read_only", state: "complete", mutationClientPresent: false, blockers: [] },
    transport: [{ endpoint: "graphql:fixture", status: 200, requestId: "request", fetchedAt: NOW.toISOString(), page: null,
      apiVersionSelected: null, deprecationAt: null, sunsetAt: null }],
  });
}

export function censusBundle(snapshot: IntakeSnapshotV1, NOW: Date, canonicalSnapshot = canonicalFixture(snapshot.repository, NOW), journalRecords: readonly unknown[] = []): SharedCensusBundle {
  const canonicalSnapshotV2Sha256 = canonicalJsonSha256(canonicalSnapshot);
  const { candidateSha256, repository, censusContentSha256, issues, markerIndex, markerIncidents, projectObservation, receipts } = snapshot;
  const intakeSnapshot = { ...snapshot, canonicalSnapshotV2Sha256,
    contentSha256: canonicalJsonSha256({ candidateSha256, canonicalSnapshotV2Sha256, repository, censusContentSha256,
      issues, markerIndex, markerIncidents, projectObservation, receipts }) };
  // Built through the production reader from a GraphQL-shaped page of the snapshot's open issues.
  const fullName = `${repository.organization}/${repository.name}`;
  const open = issues.filter(issue => issue.state === "OPEN");
  const page = JSON.stringify({ data: { repository: { nameWithOwner: fullName, issues: { totalCount: open.length,
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(issue => ({ number: issue.number,
      databaseId: issue.identity.databaseId, id: issue.identity.nodeId, state: "OPEN", updatedAt: issue.updatedAt,
      issueFieldValues: { totalCount: issue.fieldValues.length, pageInfo: { hasNextPage: false }, nodes: issue.fieldValues.map(raw => {
        const field = raw as { issue_field_name: string; data_type: string; single_select_option?: { name: string } };
        if (field.data_type !== "single_select" || field.single_select_option === undefined) throw new Error(`fixture field kind ${field.data_type}`);
        return { __typename: "IssueFieldSingleSelectValue", field: { name: field.issue_field_name }, name: field.single_select_option.name };
      }) } })) } } } });
  const boardIssues = readBoardFingerprint({ repo: { owner: repository.organization, name: repository.name, fullName },
    runGh: () => `HTTP/2.0 200 OK
x-github-request-id: fixture
x-github-api-version-selected: 2026-03-10

${page}`,
    readGraphql: readGraphqlWithMetadata, fetchedAt: NOW.toISOString() }).fingerprint.issues;
  return { schemaVersion: "github-issue-roadmap-shared-census/v2", repository, publishedAt: NOW.toISOString(), canonicalSnapshot, intakeSnapshot,
    boardFingerprint: { repositoryFullName: `${repository.organization}/${repository.name}`, issues: boardIssues, digest: canonicalJsonSha256(boardIssues) },
    journalPosition: { recordCount: journalRecords.length, lastRecordSha256: journalRecords.length === 0 ? "empty" : canonicalJsonSha256(journalRecords.at(-1)) } };
}

/** A board-check reader serving the fingerprint and index reads for the given census issues. */
export function boardCheckResponse(issues: readonly IntakeSnapshotV1["issues"][number][], args: readonly string[]): string {
  const open = issues.filter(issue => issue.state === "OPEN");
  const body = args.includes("graphql") ? { data: { repository: { nameWithOwner: "example-org/example-repo",
    issues: { totalCount: open.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(issue => ({
      number: issue.number, databaseId: issue.identity.databaseId, id: issue.identity.nodeId, state: issue.state, updatedAt: issue.updatedAt,
      issueFieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
    })) } } } } : issues.map(issue => ({ number: issue.number, updated_at: issue.updatedAt }));
  return `HTTP/2.0 200 OK
x-github-request-id: fixture
x-github-api-version-selected: 2026-03-10

${JSON.stringify(body)}`;
}

export function boardCheckRunner(issues: readonly IntakeSnapshotV1["issues"][number][]): GhRunner {
  return args => boardCheckResponse(issues, args);
}
